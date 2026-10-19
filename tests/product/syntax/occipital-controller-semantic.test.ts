import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController, type SourceDemand } from '../../../src/occipital/controller.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import type { ProviderBroker } from '../../../src/occipital/provider.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';

type Frame = Record<string, any>;
const counters = { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 0 };
class Peer implements Pick<ProviderBroker, 'snapshot' | 'isReady' | 'request' | 'classificationAccepted'> {
  generation = 1;
  description = decodeSemanticDescription(semanticDescriptor('describe', 'instance', []), 'describe');
  readonly calls: Frame[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly pending: { resolve: (reply: unknown) => void; reject: (error: unknown) => void }[] = [];
  useful = 0;
  snapshot() { return { generation: this.generation, availability: 'ready' as const, reason: 'ready' as const,
    kind: 'shared' as const, initialShared: true, description: this.description }; }
  isReady(generation: number) { return generation === this.generation; }
  classificationAccepted(generation: number) { assert.equal(generation, this.generation); this.useful++; return true; }
  request(generation: number, request: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    assert.equal(generation, this.generation);
    this.calls.push(request); this.signals.push(options?.signal);
    return new Promise<unknown>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  reply(index: number, text: string, options: { revision?: number; from?: number; complete?: boolean; lease?: string } = {}) {
    const request = this.calls[index]!, input = request.sources?.[0] ?? request;
    const complete = options.complete ?? (request.op === 'highlight' || !!request.final);
    const bytes = Buffer.byteLength(text), from = options.from ?? 0;
    const metadata = { key: input.key, generation: input.generation, source_version: input.source_version,
      revision: options.revision ?? 1, source_bytes: bytes, replace_from: from,
      committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
      ...(!complete || request.op === 'stream.append' ? { lease: options.lease ?? request.lease ?? 'lease:1' } : {}) };
    this.pending[index]!.resolve({ v: 3, ticket: request.ticket, instance: this.description.instance,
      assets: this.description.assets, status: 'ok', body: { kind: 'source', vocabulary: this.description.vocabulary.fingerprint,
        sources: [{ ...metadata, contexts: bytes === from ? [] : [[0, 1]], runs: bytes === from ? [] : [bytes - from, 1], counters }] } });
  }
  close(index: number) {
    this.pending[index]!.resolve({ v: 3, ticket: this.calls[index]!.ticket, instance: this.description.instance,
      assets: this.description.assets, status: 'ok', body: { kind: 'closed' } });
  }
}
const demand = (values: Partial<SourceDemand> = {}): SourceDemand => ({ key: 'source', version: 1, text: 'echo ready',
  language: 'bash', profile: 'pi', fingerprint: 'b'.repeat(64), complete: true, ...values });
async function settled() { await turn(); await turn(); }
async function cleanup(owner: SourceController, peer: Peer) {
  owner.dispose();
  for (let i = 0; i < peer.calls.length; i++) if (peer.calls[i]!.op === 'stream.close') peer.close(i);
  await settled();
}

test('controller v3 source: native-only empty catalogue still parses Follow Pi input without profile wire fields', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    assert.equal(owner.observe(demand()), true); owner.flush();
    assert.equal(peer.calls.length, 1);
    const frame = peer.calls[0]!;
    assert.equal(frame.v, 3); assert.equal(frame.op, 'highlight');
    assert.equal(Object.hasOwn(frame.sources[0], 'profile'), false);
    assert.equal(Object.hasOwn(frame.sources[0], 'fingerprint'), false);
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 1);
    assert.equal(owner.status('source')!.exact, true);
    assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(peer.useful, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: theme supersession neither cancels parsing nor rejects its useful semantic result', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush();
    owner.observe(demand({ profile: 'native', fingerprint: 'c'.repeat(64) })); owner.flush();
    assert.equal(peer.calls.length, 1);
    assert.equal(peer.signals[0]!.aborted, false);
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 1);
    assert.equal(peer.useful, 1);
    owner.observe(demand()); owner.flush(); await settled();
    assert.equal(peer.calls.length, 1, 'returning to the original theme must not reparse text');
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: theme change preserves a growing parser lease and sends only appended text', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand({ text: 'echo one\n', complete: false })); owner.flush();
    peer.reply(0, 'echo one\n'); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 1);
    owner.observe(demand({ text: 'echo one\necho two', version: 2, profile: 'native', fingerprint: 'c'.repeat(64) })); owner.flush();
    const frame = peer.calls[1]!;
    assert.equal(frame.op, 'stream.append'); assert.equal(frame.append, 'echo two');
    assert.equal(frame.lease, 'lease:1'); assert.equal(frame.base_revision, 1); assert.equal(frame.base_bytes, 9);
    assert.equal(Object.hasOwn(frame, 'profile'), false); assert.equal(Object.hasOwn(frame, 'fingerprint'), false);
    peer.reply(1, 'echo one\necho two', { revision: 2, from: 9 }); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 2);
    assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(peer.calls.filter(frame => frame.op === 'stream.open').length, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: changing desired styles cannot clear an unknown physical source outcome', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush();
    peer.pending[0]!.reject(new RequestFailure('lost reply')); await settled();
    assert.equal(owner.workStatus('source').fallbackEligible, false);
    owner.observe(demand({ profile: 'native', fingerprint: 'c'.repeat(64) })); owner.flush(); await settled();
    assert.equal(peer.calls.length, 1);
    assert.equal(owner.workStatus('source').execution, 'unknown');
    assert.equal(owner.workStatus('source').fallbackEligible, false);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: removing an unsettled open closes its validated late lease without restoring data', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand({ complete: false })); owner.flush();
    owner.remove('source');
    assert.equal(peer.signals[0]!.aborted, true);
    assert.equal(owner.stats().unsettledJobs, 1);
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.status('source'), undefined);
    assert.equal(peer.calls[1]!.op, 'stream.close');
    assert.equal(peer.calls[1]!.lease, 'lease:1');
    peer.close(1); await settled();
    assert.equal(owner.stats().unsettledJobs, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: validated parse refused by retention is acknowledged, not left physically unsettled', async () => {
  const peer = new Peer(), owner = new SourceController(peer, { retention: { maxBytes: 2000 } });
  try {
    assert.equal(owner.observe(demand()), true); owner.flush();
    assert.equal(peer.calls.length, 1);
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(owner.status('source')!.classificationVersion, undefined, 'the semantic body did not fit');
    assert.equal(owner.workStatus('source').execution, 'acknowledged');
    owner.observe(demand()); owner.flush(); await settled();
    assert.equal(peer.calls.length, 1, 'storage refusal does not cause a warm parse carousel');
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: refused open storage retires the returned lease before any continuation', async () => {
  const peer = new Peer(), owner = new SourceController(peer, { retention: { maxBytes: 2000 } });
  try {
    owner.observe(demand({ complete: false })); owner.flush();
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(peer.calls[1]?.op, 'stream.close');
    assert.equal(peer.calls[1]?.lease, 'lease:1');
    peer.close(1); await settled();
    assert.equal(owner.workStatus('source').execution, 'acknowledged');
    assert.equal(owner.stats().remoteLeases, 0);
    assert.equal(owner.stats().unsettledJobs, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: compatible provider replacement reuses finite scopes without parsing again', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush(); peer.reply(0, 'echo ready'); await settled();
    const before = owner.status('source')!.generation;
    peer.generation++;
    owner.observe(demand()); owner.flush(); await settled();
    assert.equal(peer.calls.length, 1);
    assert.equal(owner.status('source')!.generation, before);
    assert.equal(owner.status('source')!.classificationVersion, 1);
    assert.equal(owner.status('source')!.acknowledgedVersion, undefined, 'the replacement did not acknowledge a source RPC');
    assert.equal(owner.status('source')!.exact, true);
    assert.equal(peer.useful, 1, 'reuse is not a new successful native classification');
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: incompatible vocabulary replacement reparses from full source, not foreign scope IDs', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush(); peer.reply(0, 'echo ready'); await settled();
    const before = owner.status('source')!.generation, next = semanticDescriptor('describe', 'replacement', []);
    next.assets = next.body.assets = 'replacement-assets'; next.body.vocabulary.fingerprint = 'd'.repeat(64);
    peer.description = decodeSemanticDescription(next, 'describe'); peer.generation++;
    owner.observe(demand()); owner.flush();
    const frame = peer.calls[1]!;
    assert.equal(frame.op, 'highlight'); assert.equal(frame.sources[0].text, 'echo ready');
    assert.notEqual(frame.sources[0].generation, before);
    assert.equal(Object.hasOwn(frame.sources[0], 'contexts'), false);
    peer.reply(1, 'echo ready'); await settled();
    assert.equal(owner.status('source')!.exact, true);
    assert.equal(owner.stats().unsettledJobs, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller v3 source: confirmed scopes awaiting styles veto a duplicate Pi classifier without inventing source work', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush(); peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.status('source')!.classificationVersion, 1);
    assert.equal(owner.displayBasis('source'), undefined, 'scopes are not ready colors');
    assert.equal(owner.workStatus('source').execution, 'acknowledged', 'there is no unsettled source attempt');
    assert.equal(owner.workStatus('source').fallbackEligible, false, 'pending style demand is not permission to parse the same source with Pi');
    assert.equal(peer.calls.length, 1);
  } finally { await cleanup(owner, peer); }
});

function disposalWitness(original: SemanticRetentionPool['dispose'], notify: (closed: boolean) => void) {
  return function (this: SemanticRetentionPool) {
    original.call(this);
    notify(!this.admit('after-dispose', 1, 'late input').accepted);
  };
}
function trackRoot(owner: SourceController, notify: (closed: boolean) => void) {
  const root = (owner as unknown as { pool: SemanticRetentionPool }).pool;
  root.dispose = disposalWitness(root.dispose, notify);
  return new WeakRef(root);
}
function abandonedSource(peer: Peer, notify: (closed: boolean) => void) {
  const owner = new SourceController(peer);
  const root = trackRoot(owner, notify);
  owner.observe(demand()); owner.flush();
  return { owner: new WeakRef(owner), root };
}

test('controller v3 lifetime: explicit disposal closes the data authority while physical work stays charged', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  let disposed = 0, closedRoots = 0;
  trackRoot(owner, closed => { disposed++; if (closed) closedRoots++; });
  owner.observe(demand()); owner.flush();
  try {
    owner.dispose(); owner.dispose();
    assert.equal(disposed, 1, 'normal owner cleanup closes its logical data authority exactly once');
    assert.equal(closedRoots, 1, 'closed storage rejects new source admission');
    assert.equal(owner.stats().globalUnsettledJobs, 1, 'logical disposal does not settle the physical request');
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.stats().globalUnsettledJobs, 0);
    assert.equal(owner.stats().globalTransientBytes, 0);
  } finally {
    peer.reply(0, 'echo ready'); await settled(); owner.dispose();
  }
});

test('controller v3 lifetime: abandoned owner closes its data root through existing GC cleanup without releasing held work', async () => {
  assert.equal(typeof global.gc, 'function');
  const peer = new Peer();
  let disposed = 0, closedRoots = 0;
  const first = abandonedSource(peer, closed => { disposed++; if (closed) closedRoots++; });
  const active = new SourceController(peer);
  active.observe(demand({ key: 'peer' })); active.flush();
  try {
    assert.equal(peer.calls.length, 2);
    for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
    assert.equal(first.owner.deref(), undefined, 'the pending completion must not own the first controller');
    assert.equal(disposed, 1, 'existing owner-GC cleanup closes abandoned storage');
    assert.equal(closedRoots, 1, 'GC-driven closure rejects new source admission');
    assert.equal(first.root.deref(), undefined, 'cleanup holdings must release the disposed data root');
    assert.equal(active.stats().globalUnsettledJobs, 2, 'GC is not terminal execution evidence');
    assert.equal(peer.signals[0]!.aborted, true);
    peer.reply(0, 'echo ready'); peer.reply(1, 'echo ready'); await settled();
    assert.equal(active.stats().globalUnsettledJobs, 0);
    assert.equal(active.stats().globalTransientBytes, 0);
  } finally {
    peer.reply(0, 'echo ready'); peer.reply(1, 'echo ready'); await settled(); active.dispose();
  }
});

for (const text of ['x'.repeat(65537), 'é'.repeat(32769), '\n'.repeat(8193), '\n'.repeat(8192) + 'x']) {
  test(`controller volume limits: raw over-policy ${text.length} units refuse before source ownership`, async () => {
    const peer = new Peer(), owner = new SourceController(peer);
    try {
      assert.equal(owner.observe(demand({ text })), false);
      owner.flush(); await settled();
      assert.equal(peer.calls.length, 0);
      assert.equal(owner.borrowSource('source'), undefined);
      assert.equal(owner.workStatus('source').execution, 'not_started');
    } finally { await cleanup(owner, peer); }
  });
}

test('controller volume limits: exact UTF8 and logical-line boundaries admit and settle', async () => {
  for (const text of ['é'.repeat(32768), '\n'.repeat(8192), '\n'.repeat(8191) + 'x']) {
    const peer = new Peer(), owner = new SourceController(peer);
    try {
      assert.equal(owner.observe(demand({ text })), true); owner.flush();
      assert.equal(peer.calls.length, 1); peer.reply(0, text); await settled();
      assert.equal(owner.status('source')!.exact, true);
      assert.equal(owner.stats().unsettledJobs, 0);
      assert.ok(owner.stats().peakTransientBytes < 8 * 1024 * 1024, 'message cap must not reserve 1GiB retention per job');
    } finally { await cleanup(owner, peer); }
  }
});

test('controller volume limits: refusal cannot erase an unsettled or unknown source outcome', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush();
    const credit = owner.stats().transientBytes;
    assert.equal(owner.observe(demand({ text: 'x'.repeat(HIGHLIGHT_LIMITS.sourceBytes + 1), version: 2 })), false);
    assert.equal(owner.stats().unsettledJobs, 1);
    assert.equal(owner.stats().transientBytes, credit);
    assert.equal(owner.workStatus('source').fallbackEligible, false);
    peer.pending[0]!.reject(new RequestFailure('lost reply')); await settled();
    assert.equal(owner.workStatus('source').execution, 'unknown');
    assert.equal(owner.observe(demand({ text: '\n'.repeat(8193), version: 3 })), false);
    owner.flush(); await settled();
    assert.equal(owner.workStatus('source').execution, 'unknown');
    assert.equal(owner.workStatus('source').fallbackEligible, false);
    assert.equal(peer.calls.length, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: smaller negotiated SOURCE cap refuses before retaining the request', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  peer.description = { ...peer.description, limits: { ...peer.description.limits, source_bytes: 4 } };
  try {
    assert.equal(owner.observe(demand({ text: '12345' })), false); owner.flush(); await settled();
    assert.equal(owner.borrowSource('source'), undefined);
    assert.equal(peer.calls.length, 0);
    assert.equal(owner.workStatus('source').execution, 'not_started');
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: negotiated DATA request refusal is no-start and cannot warm-retry', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  peer.description = { ...peer.description, limits: { ...peer.description.limits, request_bytes: 128 } };
  try {
    owner.observe(demand()); owner.flush(); await settled();
    assert.equal(peer.calls.length, 0);
    assert.equal(owner.stats().unsettledJobs, 0); assert.equal(owner.stats().transientBytes, 0);
    assert.equal(owner.workStatus('source').execution, 'not_started');
    for (let i = 0; i < 20; i++) { owner.observe(demand()); owner.flush(); }
    await settled(); assert.equal(peer.calls.length, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: negotiated DATA reply refusal retains unknown source authority', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  peer.description = { ...peer.description, limits: { ...peer.description.limits, reply_bytes: 128 } };
  try {
    owner.observe(demand()); owner.flush(); peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(owner.workStatus('source').execution, 'unknown');
    assert.equal(owner.workStatus('source').fallbackEligible, false);
    for (let i = 0; i < 20; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: Pi storage accepts only actual8KiB prefixes and warm versions do not rescan', async () => {
  const peer = new Peer(), owner = new SourceController(peer), text = 'é'.repeat(4096);
  try {
    assert.equal(owner.capturePiSource('pi', 1, text), true);
    assert.equal(owner.borrowPiSource('pi')!.text, text);
    assert.equal(owner.capturePiSource('over', 1, text + 'x'), false);
    assert.equal(owner.borrowPiSource('over'), undefined);
    owner.observe(demand({ text }));
    const charCodeAt = String.prototype.charCodeAt;
    let visits = 0;
    String.prototype.charCodeAt = function (index) { if (String(this) === text) visits++; return charCodeAt.call(this, index); };
    try {
      for (let i = 0; i < 20; i++) { owner.observe(demand({ text })); owner.capturePiSource('pi', 1, text); }
    } finally { String.prototype.charCodeAt = charCodeAt; }
    assert.equal(visits, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: refused growing correction keeps its physical slot and closes a validated late lease', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand({ complete: false })); owner.flush();
    assert.equal(owner.observe(demand({ version: 2, text: 'x'.repeat(65537) })), false);
    assert.equal(owner.stats().unsettledJobs, 1); assert.equal(peer.signals[0]!.aborted, true);
    peer.reply(0, 'echo ready'); await settled();
    assert.equal(owner.borrowSource('source'), undefined);
    assert.equal(peer.calls[1]!.op, 'stream.close');
    assert.equal(owner.stats().unsettledJobs, 1);
    peer.close(1); await settled();
    assert.equal(owner.stats().remoteLeases, 0); assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(owner.status('source')!.exact, false);
  } finally { await cleanup(owner, peer); }
});

for (const [kind, text] of [['bytes', 'x'.repeat(65537)], ['lines', '\n'.repeat(8193)]] as const) {
  test(`controller refusal review P1: empty to over-${kind} nonempty source never inherits exact coverage`, async () => {
    const peer = new Peer(), owner = new SourceController(peer);
    try {
      assert.equal(owner.observe(demand({ text: '' })), true);
      assert.equal(owner.status('source')!.exact, true);
      assert.equal(owner.observe(demand({ text, version: 2 })), false);
      owner.flush(); await settled();
      const status = owner.status('source')!;
      assert.equal(status.version, 2); assert.equal(status.exact, false);
      assert.equal(status.classificationVersion, undefined); assert.equal(status.acknowledgedVersion, undefined);
      assert.equal(status.fallbackEligible, true); assert.equal(status.execution, 'not_started');
      assert.equal(owner.visitRanges('source', () => assert.fail('refused source has no ranges')), false);
      assert.equal(owner.borrowSource('source'), undefined); assert.equal(peer.calls.length, 0);
    } finally { await cleanup(owner, peer); }
  });
}

for (const field of ['language', 'path', 'profile', 'fingerprint', 'provider', 'all'] as const) {
  test(`controller refusal review P2: changed ${field} identity is charged and repeated refusal is inert`, async () => {
    const peer = new Peer(), notifications: string[][] = [];
    const owner = new SourceController(peer, { onChange: keys => notifications.push([...keys]) });
    try {
      const initial = demand({ text: '' });
      owner.observe(initial); await settled();
      const next = { ...initial, version: 2, text: '\n'.repeat(8193),
        ...(['language', 'all'].includes(field) ? { language: 'javascript' } : {}),
        ...(['path', 'all'].includes(field) ? { path: '/changed/' + 'p'.repeat(500) } : {}),
        ...(['profile', 'all'].includes(field) ? { profile: 'changed-profile' } : {}),
        ...(['fingerprint', 'all'].includes(field) ? { fingerprint: 'c'.repeat(64) } : {}) };
      if (field === 'provider' || field === 'all') peer.generation++;
      const before = owner.stats().bookkeepingBytes;
      assert.equal(owner.observe(next), false); await settled();
      const expectedDelta = 2 * ((next.language?.length ?? 0) - (initial.language?.length ?? 0)
        + (next.path?.length ?? 0) - (initial.path?.length ?? 0) + next.profile.length - initial.profile.length
        + next.fingerprint.length - initial.fingerprint.length);
      assert.equal(owner.stats().bookkeepingBytes - before, expectedDelta, 'all retained identity strings are paid');
      const notified = notifications.length, charCodeAt = String.prototype.charCodeAt;
      let sourceScans = 0;
      String.prototype.charCodeAt = function (index) { if (String(this) === next.text) sourceScans++; return charCodeAt.call(this, index); };
      try {
        for (let i = 0; i < 10; i++) { assert.equal(owner.observe(next), false); await settled(); }
      } finally { String.prototype.charCodeAt = charCodeAt; }
      assert.equal(sourceScans, 0); assert.equal(notifications.length, notified);
      assert.equal(owner.stats().bookkeepingBytes - before, expectedDelta);
      assert.equal(owner.status('source')!.version, 2); assert.equal(owner.status('source')!.exact, false);
      assert.equal(owner.status('source')!.fallbackEligible, true);
      assert.equal(owner.borrowSource('source'), undefined); assert.equal(peer.calls.length, 0);
      const recovery = { ...next, version: 3, text: 'small current source' };
      assert.equal(owner.observe(recovery), true); owner.flush();
      assert.equal(owner.borrowSource('source')!.profile, next.profile);
      assert.equal(owner.borrowSource('source')!.fingerprint, next.fingerprint);
      assert.equal(owner.borrowSource('source')!.language, next.language);
      assert.equal(owner.borrowSource('source')!.path, next.path);
      peer.reply(0, recovery.text); await settled();
      assert.equal(owner.status('source')!.exact, true); assert.equal(peer.calls.length, 1);
    } finally { await cleanup(owner, peer); }
  });
}

for (const providerChanged of [false, true]) for (const outcome of ['acknowledged', 'unknown'] as const) test(`controller refusal review: changed identity preserves held and ${outcome} previous source proof across provider change ${providerChanged}`, async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.observe(demand()); owner.flush();
    const credit = owner.stats().transientBytes;
    const next = demand({ version: 2, text: '\n'.repeat(8193), language: 'javascript', path: '/changed/file.js', profile: 'changed', fingerprint: 'c'.repeat(64) });
    if (providerChanged) peer.generation++;
    assert.equal(owner.observe(next), false);
    assert.equal(owner.stats().unsettledJobs, 1); assert.equal(owner.stats().transientBytes, credit);
    assert.equal(owner.status('source')!.fallbackEligible, false);
    if (outcome === 'unknown') peer.pending[0]!.reject(new RequestFailure('unresolved old source'));
    else peer.reply(0, 'echo ready');
    await settled();
    assert.equal(owner.stats().unsettledJobs, 0); assert.equal(owner.stats().transientBytes, 0);
    assert.equal(owner.workStatus('source').execution, outcome);
    assert.equal(owner.status('source')!.exact, false);
    assert.equal(owner.status('source')!.fallbackEligible, outcome === 'acknowledged');
    peer.generation++;
    const replacement = { ...next, version: 3 };
    assert.equal(owner.observe(replacement), false); await settled();
    assert.equal(owner.workStatus('source').execution, outcome);
    assert.equal(owner.status('source')!.fallbackEligible, outcome === 'acknowledged');
    assert.equal(owner.borrowSource('source'), undefined); assert.equal(peer.calls.length, 1);
  } finally { await cleanup(owner, peer); }
});

for (const outcome of ['acknowledged', 'unknown'] as const) test(`controller refusal review capacity: unfunded identity remains cheap with held and ${outcome} source evidence`, async () => {
  const peer = new Peer(), notifications: string[][] = [];
  const owner = new SourceController(peer, { maxBookkeepingBytes: 1400, onChange: keys => notifications.push([...keys]) });
  try {
    owner.observe(demand()); owner.flush();
    const before = owner.stats().bookkeepingBytes, credit = owner.stats().transientBytes;
    const next = demand({ version: 2, text: '\n'.repeat(8193), path: '/' + 'p'.repeat(4000), profile: 'changed', language: 'javascript', fingerprint: 'c'.repeat(64) });
    assert.equal(owner.observe(next), false); await settled();
    assert.equal(owner.stats().bookkeepingBytes, before, 'unfunded identity strings are not retained');
    assert.equal(owner.status('source')!.version, 2); assert.equal(owner.status('source')!.exact, false);
    assert.equal(owner.stats().transientBytes, credit); assert.equal(owner.stats().unsettledJobs, 1);
    assert.equal(owner.status('source')!.fallbackEligible, false);
    const notified = notifications.length, charCodeAt = String.prototype.charCodeAt, abort = AbortController.prototype.abort;
    let scans = 0, repeatedCancels = 0;
    String.prototype.charCodeAt = function (index) { if (String(this) === next.text) scans++; return charCodeAt.call(this, index); };
    AbortController.prototype.abort = function (reason) { if (this.signal === peer.signals[0]) repeatedCancels++; return abort.call(this, reason); };
    try {
      for (let i = 0; i < 10; i++) { assert.equal(owner.observe(next), false); await settled(); }
    } finally { String.prototype.charCodeAt = charCodeAt; AbortController.prototype.abort = abort; }
    assert.equal(scans, 0); assert.equal(notifications.length, notified); assert.equal(repeatedCancels, 0);
    assert.equal(owner.stats().bookkeepingBytes, before); assert.equal(peer.calls.length, 1);
    if (outcome === 'unknown') peer.pending[0]!.reject(new RequestFailure('unresolved old source'));
    else peer.reply(0, 'echo ready');
    await settled();
    assert.equal(owner.workStatus('source').execution, outcome);
    assert.equal(owner.status('source')!.fallbackEligible, outcome === 'acknowledged');
    assert.equal(owner.stats().unsettledJobs, 0); assert.equal(owner.stats().transientBytes, 0);
  } finally {
    await cleanup(owner, peer);
    assert.equal(owner.stats().bookkeepingBytes, 0);
    assert.equal(owner.stats().retention.retainedBytes, 0);
  }
});
