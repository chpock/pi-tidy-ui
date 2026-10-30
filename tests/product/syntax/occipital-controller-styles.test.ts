import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController, CONTROLLER_LIMITS, type SourceDemand, type SourcePreparation } from '../../../src/occipital/controller.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { CARD_ROLES, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { compactSelection, syntheticSelection } from '../../fixtures/test-style-selection.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import type { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import type { DiagnosticSink } from '../../../src/diagnostics.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';

type Frame = Record<string, any>;
const definition = syntheticSelection().definition;
const literal = (n: number): ConcreteStyle => ({ foreground: { kind: 'rgb', r: n, g: 2, b: 3 }, background: { kind: 'rgb', r: 4, g: 5, b: 6 }, attributes: 0 });
const roles = (n: number) => Object.fromEntries(CARD_ROLES.map(role => [role, literal(n)])) as Record<CardRole, ConcreteStyle>;
const owned = (n = 1, ruleSeed = n) => syntheticSelection(n, 'owned', ruleSeed);
const local = (n = 1, ruleSeed = n + 1) => syntheticSelection(n + 1, 'local', ruleSeed);
const demand = (key = 'source', text = 'echo one\n', version = 1, complete = true): SourceDemand => ({ key, text, version, complete,
  language: 'bash' });
class Peer {
  generation = 1; useful = 0; ready = true;
  description = decodeSemanticDescription(semanticDescriptor('describe', 'instance'), 'describe');
  calls: Frame[] = []; signals: (AbortSignal | undefined)[] = [];
  pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  snapshot() { return { generation: this.generation, availability: this.ready ? 'ready' as const : 'unavailable' as const, reason: this.ready ? 'ready' as const : 'optional_unavailable' as const, kind: 'shared' as const,
    initialShared: true, description: this.ready ? this.description : undefined }; }
  isReady(generation: number) { return this.ready && generation === this.generation; }
  classificationAccepted() { this.useful++; return true; }
  request(_generation: number, request: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    this.calls.push(request); this.signals.push(options?.signal);
    return new Promise<unknown>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  envelope(i: number, body: unknown) { return { v: 4, ticket: this.calls[i]!.ticket, instance: this.description.instance,
    assets: this.description.assets, status: 'ok', body }; }
  source(i: number, text: string, revision = 1, from = 0, context = 1) {
    const request = this.calls[i]!, input = request.sources?.[0] ?? request, complete = request.op === 'highlight' || !!request.final;
    const bytes = Buffer.byteLength(text);
    this.pending[i]!.resolve(this.envelope(i, { kind: 'source', vocabulary: this.description.vocabulary.fingerprint,
      sources: [{ key: input.key, generation: input.generation, source_version: input.source_version, revision, source_bytes: bytes,
        replace_from: from, committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
        ...(!complete || request.op === 'stream.append' ? { lease: request.lease ?? 'lease:1' } : {}),
        contexts: bytes === from ? [] : [[0, context]], runs: bytes === from ? [] : [bytes - from, 1],
        counters: { committed_line_calls: 1, committed_line_bytes: from, tail_calls: 0, tail_bytes: 0 } }] }));
  }
  style(i: number, _n = 1, bad = false) {
    const request = this.calls[i]!, selected = request.rules;
    this.pending[i]!.resolve(this.envelope(i, { kind: 'styles', vocabulary: request.vocabulary,
      rules: bad ? 'f'.repeat(64) : fingerprintRules(selected),
      styles: request.contexts.length ? [{ ...selected.default }] : [], indices: request.contexts.map(() => 1) }));
  }
  styleBinding(i: number) {
    const request = this.calls[i]!, selected = request.rules;
    this.pending[i]!.resolve(this.envelope(i, { kind: 'styles', vocabulary: request.vocabulary,
      rules: fingerprintRules(selected), styles: request.contexts.length ? [{ foreground: { kind: 'binding', slot: 0 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 31 }] : [],
      indices: request.contexts.map(() => 1) }));
  }
  styleDefinition(i: number) {
    const request = this.calls[i]!, selected = request.rules;
    this.pending[i]!.resolve(this.envelope(i, { kind: 'styles', vocabulary: request.vocabulary,
      rules: fingerprintRules(selected), styles: request.contexts.length ? [{ ...selected.default }] : [], indices: request.contexts.map(() => 1) }));
  }
}
async function settled() { for (let i = 0; i < 5; i++) await turn(); }
async function cleanup(owner: SourceController, peer: Peer) {
  owner.dispose();
  for (let i = 0; i < peer.calls.length; i++) {
    const request = peer.calls[i]!;
    if (request.op === 'stream.close') peer.pending[i]!.resolve(peer.envelope(i, { kind: 'closed' }));
    else peer.pending[i]!.reject(new RequestFailure('cleanup', 'not_started'));
  }
  await settled();
  assert.equal(owner.stats().globalUnsettledJobs, 0);
}
function color(owner: SourceController, key = 'source') {
  const result: number[] = [];
  owner.displayBasis(key)?.visit((_text, ranges) => ranges((_from, _to, style) => {
    assert.equal(style.foreground.kind, 'rgb'); if (style.foreground.kind === 'rgb') result.push(style.foreground.r);
  }));
  return result;
}
function roleRed(selection: { roles: Record<CardRole, ConcreteStyle> }) {
  const foreground = selection.roles.code.foreground;
  if (foreground.kind !== 'rgb') throw new Error('fixture role foreground must be RGB');
  return foreground.r;
}

test('controller styles: held Bash V1 capture publishes first colors after parser V2, then current V2 progresses', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush();
    peer.source(0, 'echo one\n'); await settled();
    assert.equal(peer.calls[1]!.op, 'styles.resolve');
    owner.observe(demand('source', 'echo one\necho two\n', 2, false)); owner.flush();
    assert.equal(peer.calls[2]!.op, 'stream.append', 'source and style occupy independent physical slots');
    peer.source(2, 'echo one\necho two\n', 2, 9, 2); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 2);
    peer.style(1); await settled();
    assert.equal(owner.displayBasis('source')!.version, 1, 'settled job capture survives parser advancement');
    assert.deepEqual(color(owner), [1]);
    assert.equal(peer.calls[3]!.op, 'styles.resolve');
    peer.style(3); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2); assert.deepEqual(color(owner), [1, 1]);
    assert.equal(peer.useful, 2, 'style success is not source success');
    assert.equal(owner.stats().styleCaptures, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: palette A B A and local Pi rebinding reuse one palette-independent rule capture', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    peer.styleBinding(1); await settled(); assert.deepEqual(color(owner), [1]);
    owner.setStyleSelection(owned(2, 1)); await settled(); assert.deepEqual(color(owner), [2]);
    owner.setStyleSelection(owned()); await settled(); assert.deepEqual(color(owner), [1]);
    owner.setStyleSelection(local(1, 1)); await settled(); assert.deepEqual(color(owner), [2]);
    owner.setStyleSelection(local(9, 1)); await settled(); assert.deepEqual(color(owner), [10]); assert.equal(peer.calls.length, 2);
    assert.equal(peer.useful, 1); assert.equal(owner.stats().preparedBytes, 9);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: empty source and palette selections admit no SOURCE or STYLE request', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', '')); owner.flush();
    assert.equal(peer.calls.length, 0);
    owner.setStyleSelection(local()); await settled();
    assert.equal(peer.calls.length, 0);
    assert.equal(peer.useful, 0); assert.equal(owner.stats().styleCaptures, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: two physical jobs plus 100 selections prepare only latest uncached demand', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('old')); owner.observe(demand('new')); owner.flush();
    assert.equal(peer.calls.length, 2);
    const before = owner.stats().stylePreparations;
    for (let i = 2; i <= 101; i++) { owner.setStyleSelection(owned(i)); owner.flush(); }
    assert.equal(owner.stats().stylePreparations, before); assert.equal(peer.calls.length, 2);
    peer.source(0, 'echo one\n'); await settled();
    assert.equal(fingerprintRules(peer.calls[2]!.rules), fingerprintRules(owned(101).definition)); peer.style(2, 101); await settled();
    assert.deepEqual(color(owner, 'new'), [101]); assert.equal(owner.displayBasis('old'), undefined, 'cards complete independently');
    peer.source(1, 'echo one\n'); await settled();
    assert.deepEqual(color(owner, 'old'), [101]); assert.equal(peer.calls.length, 3, 'shared live context uses accepted style once');
    assert.equal(owner.stats().peakJobs, 2);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: shared in-flight context is resolved once, rejected style preserves ready display without retry loop', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('old')); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('new')); owner.flush(); peer.source(2, 'echo one\n'); await settled();
    assert.equal(peer.calls.length, 3); peer.style(1, 7); await settled();
    assert.deepEqual(color(owner, 'old'), [1]); assert.deepEqual(color(owner, 'new'), [1]);
    owner.setStyleSelection(owned(2)); await settled(); peer.style(3, 3, true); await settled();
    for (let i = 0; i < 100; i++) owner.flush(); await settled();
    assert.deepEqual(color(owner, 'new'), [1]); assert.equal(peer.calls.length, 4); assert.equal(peer.useful, 2);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: removal cancels without early credit release and style no-start cannot clear source uncertainty', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush();
    peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('source', 'echo one\ntwo', 2, false)); owner.flush();
    peer.pending[2]!.reject(new RequestFailure('source lost')); await settled();
    peer.pending[1]!.reject(new RequestFailure('style denied', 'not_started')); await settled();
    assert.equal(owner.workStatus('source').execution, 'unknown'); assert.equal(owner.workStatus('source').fallbackEligible, false);
    owner.setStyleSelection(owned(2)); await settled();
    const style = peer.calls.length - 1; assert.equal(peer.calls[style]!.op, 'styles.resolve');
    owner.remove('source'); assert.equal(peer.signals[style]!.aborted, true); assert.ok(owner.stats().unsettledJobs);
    peer.style(style); await settled(); assert.equal(owner.displayBasis('source'), undefined);
  } finally { await cleanup(owner, peer); }
});

function group(owner: SourceController, keys: string[]) {
  const preparation: SourcePreparation = { keys: new Set(keys), prepare() { for (const key of keys) owner.observe(demand(key)); }, needsRefresh() { return false; } };
  const work = owner.registerPreparation(preparation)!; owner.queuePreparation(work);
  return { preparation, work };
}

test('controller styles: complete multi-source group publishes atomically and late selection cannot publish half a card', async () => {
  const peer = new Peer(), owner = new SourceController(peer), card = group(owner, ['left', 'right']);
  try {
    owner.setStyleSelection(owned()); owner.flush();
    peer.source(0, 'echo one\n', 1, 0, 1); peer.source(1, 'echo one\n', 1, 0, 2); await settled();
    assert.equal(peer.calls[2]!.op, 'styles.resolve'); assert.equal(peer.calls[2]!.contexts.length, 2);
    assert.equal(owner.displayBasis('left'), undefined); assert.equal(owner.displayBasis('right'), undefined);
    owner.setStyleSelection(owned(2)); peer.style(2, 1); await settled();
    assert.equal(owner.displayBasis('left'), undefined); assert.equal(owner.displayBasis('right'), undefined);
    peer.style(3, 2); await settled(); assert.deepEqual(color(owner, 'left'), [2]); assert.deepEqual(color(owner, 'right'), [2]);
    assert.equal(owner.stats().styleCaptures, 0); assert.equal(owner.stats().retention.rangeViews, 2);
    owner.unregisterPreparation(card.work); assert.equal(owner.stats().retention.entries, 0);
    assert.equal(owner.stats().retention.styles, 0);
  } finally { void card.preparation; await cleanup(owner, peer); }
});

test('controller styles: cached binding rebind stays local with both SOURCE slots occupied', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned(1, 1)); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.styleBinding(1); await settled();
    owner.setStyleSelection(local(1, 1)); await settled(); assert.deepEqual(color(owner), [2]);
    owner.observe(demand('held-a')); owner.observe(demand('held-b')); owner.flush(); assert.equal(owner.stats().unsettledJobs, 2);
    owner.setStyleSelection(owned(1, 1)); await settled(); assert.deepEqual(color(owner), [1]); assert.equal(peer.calls.length, 4);
    owner.setStyleSelection(local(8, 1)); await settled(); assert.deepEqual(color(owner), [9]); assert.equal(peer.calls.length, 4);
    peer.source(2, 'echo one\n'); peer.source(3, 'echo one\n'); await settled();
    assert.equal(peer.calls.length, 4); assert.equal(peer.useful, 3);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: frozen scopes recolor without parser revival; paused group waits for explicit resume', async () => {
  const peer = new Peer(), owner = new SourceController(peer), card = group(owner, ['source']);
  try {
    owner.setStyleSelection(owned()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 1); await settled();
    owner.freeze('source'); owner.setStyleSelection(owned(2)); await settled(); peer.style(2, 2); await settled();
    assert.deepEqual(color(owner), [2]); assert.equal(owner.workStatus('source').fallbackEligible, false);
    const parses = peer.useful;
    owner.pausePreparation(card.work); owner.setStyleSelection(owned(3)); await settled(); assert.equal(peer.calls.length, 3); assert.deepEqual(color(owner), [2]);
    owner.queuePreparation(card.work); await settled(); peer.style(3, 3); await settled(); assert.deepEqual(color(owner), [3]);
    assert.equal(peer.useful, parses); assert.equal(owner.observe(demand('source', 'rewritten', 2)), false);
  } finally { void card.preparation; await cleanup(owner, peer); }
});

test('controller styles: stale vocabulary result stays under original identity and cannot revive or recolor replacement source', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    const oldDescription = peer.description;
    const replacement = semanticDescriptor('describe', 'replacement'); replacement.body.vocabulary.fingerprint = 'd'.repeat(64);
    replacement.assets = replacement.body.assets = 'new-assets'; peer.description = decodeSemanticDescription(replacement, 'describe'); peer.generation++;
    owner.observe(demand()); owner.flush();
    const next = peer.calls[2]!; assert.equal(next.op, 'highlight'); assert.equal(Object.hasOwn(next.sources[0], 'contexts'), false);
    peer.description = oldDescription; peer.style(1, 1); peer.description = decodeSemanticDescription(replacement, 'describe'); await settled();
    assert.equal(owner.displayBasis('source'), undefined);
    peer.source(2, 'echo one\n'); await settled();
    assert.equal(peer.calls[3]!.vocabulary, 'd'.repeat(64)); peer.style(3, 3); await settled(); assert.deepEqual(color(owner), [1]);
    assert.equal(peer.useful, 2);
  } finally { await cleanup(owner, peer); }
});

function trackedStyleOwner(peer: Peer) {
  const owner = new SourceController(peer);
  owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush();
  return owner;
}
function abandonedStyleOwner(owner: SourceController) {
  return { owner: new WeakRef(owner), root: new WeakRef((owner as unknown as { pool: SemanticRetentionPool }).pool) };
}

test('controller styles: abandoned owner releases style captures and data but not held physical credit', async () => {
  assert.equal(typeof global.gc, 'function');
  const peer = new Peer(); let owner: SourceController | undefined = trackedStyleOwner(peer);
  peer.source(0, 'echo one\n'); await settled(); assert.equal(owner.stats().styleCaptures, 1);
  const lifetime = abandonedStyleOwner(owner), budget = (owner as unknown as { pool: SemanticRetentionPool }).pool.budget; const witness = new SourceController(peer);
  owner = undefined;
  try {
    // Do not retain the data root itself across the collection experiment.
    for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
    assert.equal(lifetime.owner.deref(), undefined); assert.equal(lifetime.root.deref(), undefined); assert.equal(budget.stats().closed, true);
    assert.ok(budget.stats().retainedBytes > 0, 'held transport declaration keeps its owner-free data charge'); assert.equal(peer.signals[1]!.aborted, true);
    assert.equal(witness.stats().globalUnsettledJobs, 1);
    peer.style(1); await settled(); assert.equal(witness.stats().globalUnsettledJobs, 0); assert.equal(witness.stats().globalTransientBytes, 0); assert.equal(budget.stats().retainedBytes, 0);
  } finally { peer.style(1); await settled(); witness.dispose(); }
});

test('controller styles: unchanged physical/data limits fund two real captures; pressure denial has no warm retry loop', async () => {
  const peer = new Peer(), owner = new SourceController(peer, { retention: { maxBytes: 180000 } });
  try {
    owner.setStyleSelection(compactSelection(1, 'selected', 'old')); owner.observe(demand('old')); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('new')); owner.flush(); peer.source(2, 'echo one\n', 1, 0, 2); await settled();
    assert.equal(owner.stats().styleCaptures, 2); const held = owner.stats();
    assert.equal(held.peakJobs, CONTROLLER_LIMITS.jobs); assert.ok(held.transientBytes <= CONTROLLER_LIMITS.transientBytes);
    assert.ok(held.retention.retainedBytes <= 180000); assert.equal(held.retention.outstandingPeakBytes, 0);
    peer.style(1, 1); peer.style(3, 1); await settled(); assert.deepEqual(color(owner, 'old'), [1]); assert.deepEqual(color(owner, 'new'), [1]);
    const data = (owner as unknown as { pool: SemanticRetentionPool }).pool;
    const fill = data.budget.reserve(data.budget.limit - data.budget.stats().retainedBytes - 18000)!;
    const pressure = fill.consume(data.budget.limit - data.budget.stats().retainedBytes - 18000); fill.close();
    try {
      owner.setStyleSelection(compactSelection(2, 'selected', 'new')); await settled();
      const pending = peer.calls.length - 1;
      if (peer.calls[pending]!.op === 'styles.resolve') peer.style(pending, 2);
      await settled();
      assert.ok(owner.stats().retention.retainedBytes <= 180000);
      const calls = peer.calls.length; for (let i = 0; i < 100; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, calls);
    } finally { pressure.release(); }
    console.log(JSON.stringify({ styleFunding: { physicalJobs: held.unsettledJobs, privateBytes: held.transientBytes, physicalLimit: CONTROLLER_LIMITS.transientBytes,
      logicalBytes: held.retention.retainedBytes, logicalLimit: 180000, sourceCalls: peer.useful, finalCaptures: owner.stats().styleCaptures } }));
  } finally { await cleanup(owner, peer); }
});

test('controller styles: two held STYLE jobs and 100 previews do not encode intermediate selections', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('old')); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('new')); owner.flush(); peer.source(2, 'echo one\n', 1, 0, 2); await settled();
    assert.equal(owner.stats().styleCaptures, 2); const preparations = owner.stats().stylePreparations;
    for (let i = 2; i <= 101; i++) { owner.setStyleSelection(owned(i)); owner.flush(); }
    const afterBurst = owner.stats().stylePreparations;
    assert.equal(peer.calls.length, 4); assert.equal(afterBurst, preparations);
    assert.equal(peer.signals[1]!.aborted, false); assert.equal(peer.signals[3]!.aborted, false);
    peer.style(1, 1); await settled(); assert.equal(owner.displayBasis('old'), undefined);
    assert.equal(fingerprintRules(peer.calls[4]!.rules), fingerprintRules(owned(101).definition)); peer.style(4, 101); await settled(); assert.deepEqual(color(owner, 'new'), [101]);
    peer.style(3, 1); await settled(); assert.equal(fingerprintRules(peer.calls[5]!.rules), fingerprintRules(owned(101).definition)); peer.style(5, 101); await settled();
    assert.deepEqual(color(owner, 'old'), [101]); assert.equal(peer.useful, 2); assert.equal(owner.stats().styleCaptures, 0);
    console.log(JSON.stringify({ styleBurst: { held: 2, selections: 100, preparationsWhileHeld: afterBurst - preparations,
      sourceCalls: peer.useful, finalRules: fingerprintRules(peer.calls[5]!.rules), peakJobs: owner.stats().peakJobs } }));
  } finally { await cleanup(owner, peer); }
});

test('controller styles: explicit disposal releases pending style payload immediately and retains physical credit through terminal reply', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
  assert.equal(owner.stats().styleCaptures, 1); owner.dispose(); owner.dispose();
  assert.equal(owner.stats().styleCaptures, 0); assert.equal(owner.stats().retention.entries, 0); assert.ok(owner.stats().retention.retainedBytes > 0);
  assert.equal(owner.stats().globalUnsettledJobs, 1); assert.equal(peer.signals[1]!.aborted, true);
  peer.style(1); await settled(); assert.equal(owner.stats().globalUnsettledJobs, 0); assert.equal(owner.stats().globalTransientBytes, 0); assert.equal(owner.stats().retention.retainedBytes, 0);
});

test('controller styles: cached frozen semantic rules rebind local palettes offline across incompatible providers', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned(1, 1)); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.styleBinding(1); await settled();
    owner.setStyleSelection(local(1, 1)); await settled(); assert.deepEqual(color(owner), [2]); owner.freeze('source');
    peer.ready = false; owner.setStyleSelection(owned(1, 1)); await settled(); assert.deepEqual(color(owner), [1]);
    assert.equal(await awaitFixture(owner.whenSettled()), true);
    owner.setStyleSelection(local(9, 1)); await settled(); assert.deepEqual(color(owner), [10]); assert.equal(peer.calls.length, 2);
    assert.equal(await awaitFixture(owner.whenSettled()), true);
    const replacement = semanticDescriptor('describe', 'replacement'); replacement.body.vocabulary.fingerprint = 'd'.repeat(64);
    peer.description = decodeSemanticDescription(replacement, 'describe'); peer.ready = true; peer.generation++;
    owner.setStyleSelection(owned(2, 1)); await settled(); assert.equal(peer.calls.length, 2, 'foreign old context IDs never reach the new vocabulary'); assert.deepEqual(color(owner), [2]);
    assert.equal(await awaitFixture(owner.whenSettled()), true);
    owner.setStyleSelection(owned(1, 1)); await settled(); assert.deepEqual(color(owner), [1]); assert.equal(peer.calls.length, 2);
    assert.equal(await awaitFixture(owner.whenSettled()), true);
    assert.equal(owner.workStatus('source').fallbackEligible, false); assert.equal(peer.useful, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: local funding refusal retries cached expressions after palette-only and binding-only changes', async () => {
  const peer = new Peer(), budget = new DataBudget(1024 * 1024 * 1024), owner = new SourceController(peer, {
    retention: { maxBytes: budget.limit, budget },
  });
  const initial = owned(1, 1), paletteA = { ...initial, palette: 'owned:palette-a' }, paletteB = { ...paletteA, palette: 'owned:palette-b' };
  const bindingA = { ...owned(2, 1), palette: paletteB.palette }, bindingB = { ...owned(3, 1), palette: paletteB.palette };
  const calls = () => peer.calls.length;
  async function denyNextLocalMaterialization(selection: typeof initial) {
    const preparations = owner.stats().stylePreparations, publications = owner.stats().stylePublications;
    assert.equal(owner.setStyleSelection(selection), true);
    const stats = budget.stats(), available = stats.limit - stats.retainedBytes - stats.outstandingPeakBytes;
    assert.ok(available > 1);
    const pressure = budget.reserve(available - 1);
    assert.ok(pressure, 'real outstanding data credit should leave less than the local scratch grant');
    try { await settled(); } finally { pressure!.close(); }
    assert.equal(owner.stats().stylePreparations, preparations + 1);
    assert.equal(owner.stats().stylePublications, publications, 'failed local funding retains the prior complete publication');
    return preparations + 1;
  }
  try {
    owner.setStyleSelection(initial); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    peer.styleBinding(1); await settled();
    const remoteCalls = calls(), initialPreparations = owner.stats().stylePreparations;
    assert.equal(await denyNextLocalMaterialization(paletteA), initialPreparations + 1);
    assert.equal(owner.displayBasis('source')!.palette, initial.palette);
    const failedPalettePreparations = owner.stats().stylePreparations;
    for (let i = 0; i < 100; i++) owner.flush(); await settled();
    assert.equal(owner.stats().stylePreparations, failedPalettePreparations, 'same failed local identity is warm-suppressed');
    assert.equal(calls(), remoteCalls, 'palette-only rebinding does not dispatch SOURCE or STYLE');

    assert.equal(owner.setStyleSelection(paletteB), true); await settled();
    assert.equal(owner.displayBasis('source')!.palette, paletteB.palette, 'a new palette retries the cached local expression');
    assert.equal(calls(), remoteCalls);
    await denyNextLocalMaterialization(bindingA);
    assert.equal(owner.displayBasis('source')!.bindingRevision, paletteB.bindingRevision);
    const failedBindingPreparations = owner.stats().stylePreparations;
    for (let i = 0; i < 100; i++) owner.flush(); await settled();
    assert.equal(owner.stats().stylePreparations, failedBindingPreparations, 'same failed binding identity is warm-suppressed');
    assert.equal(calls(), remoteCalls, 'binding-only rebinding does not dispatch SOURCE or STYLE');

    assert.equal(owner.setStyleSelection(bindingB), true); await settled();
    assert.equal(owner.displayBasis('source')!.palette, paletteB.palette);
    assert.equal(owner.displayBasis('source')!.bindingRevision, bindingB.bindingRevision, 'a new binding revision retries without changing palette');
    assert.equal(calls(), remoteCalls); assert.equal(owner.stats().styleDispatches, 1);
    assert.deepEqual(color(owner), [3]);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: typed style denial preserves ready literals and never grants source restart authority', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    owner.setStyleSelection(owned(2)); await settled(); peer.pending[2]!.reject(new RequestFailure('style refused', 'not_started')); await settled();
    assert.deepEqual(color(owner), [1]); assert.equal(owner.workStatus('source').execution, 'acknowledged'); assert.equal(peer.useful, 1);
    const calls = peer.calls.length; for (let i = 0; i < 100; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, calls);
    owner.setStyleSelection(owned()); await settled(); assert.deepEqual(color(owner), [1]); assert.equal(peer.calls.length, calls);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: Off releases style payload without early credit, late publication or additional source acknowledgement', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.setEnabled(false); assert.equal(owner.stats().styleCaptures, 0); assert.equal(owner.stats().retention.entries, 0);
    assert.equal(owner.stats().unsettledJobs, 1); assert.equal(peer.signals[1]!.aborted, true);
    peer.style(1, 1); await settled(); assert.equal(owner.stats().unsettledJobs, 0); assert.equal(owner.displayBasis('source'), undefined);
    assert.equal(peer.useful, 1);
  } finally { await cleanup(owner, peer); }
});

function supplyDecoratedBindings(owner: SourceController) {
  const ui = { marker: 'presentation owner must not cross the trusted-data seam' }, base = local();
  const decorated = { ...base.roles };
  for (const role of CARD_ROLES) { const style = { ...base.roles[role], ui }; decorated[role] = style; }
  const input = { ...base, ui, roles: decorated,
    bindings: base.bindings.map(binding => ({ ...binding, ui, ink: { ...binding.ink, ui } })) };
  owner.setStyleSelection(input); return new WeakRef(ui);
}
test('controller styles: trusted local data copies discard incidental UI owner properties while a style request is held', async () => {
  const peer = new Peer(), owner = new SourceController(peer), ui = supplyDecoratedBindings(owner);
  try {
    owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); assert.equal(owner.stats().styleCaptures, 1);
    for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
    assert.equal(ui.deref(), undefined); peer.style(1); await settled(); assert.deepEqual(color(owner), [2]);
  } finally { await cleanup(owner, peer); }
});

function cardWithOwner(owner: SourceController, key: string) {
  const ui = { key }, preparation = { keys: new Set([key]), ui, prepare() { owner.observe(demand(key)); }, needsRefresh() { return false; } };
  const work = owner.registerPreparation(preparation)!; owner.queuePreparation(work); owner.flush();
  return { preparation, ui: new WeakRef(ui) };
}
test('controller styles: held group job does not retain its first card owner while another card remains active', async () => {
  const peer = new Peer(), owner = new SourceController(peer); owner.setStyleSelection(owned());
  let first: ReturnType<typeof cardWithOwner> | undefined = cardWithOwner(owner, 'old');
  peer.source(0, 'echo one\n'); await settled(); assert.equal(peer.calls[1]!.op, 'styles.resolve');
  const ui = first.ui, second = cardWithOwner(owner, 'new'); first = undefined;
  try {
    for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
    assert.equal(ui.deref(), undefined); assert.equal(second.preparation.ui.key, 'new'); owner.refreshPreparations(); owner.flush(); await settled();
    assert.equal(peer.signals[1]!.aborted, true); assert.equal(owner.stats().globalUnsettledJobs, 2);
    assert.equal(owner.status('old'), undefined); assert.equal(owner.stats().styleCaptures, 0);
    peer.style(1); peer.source(2, 'echo one\n'); await settled(); peer.style(3, 3); await settled();
    assert.deepEqual(color(owner, 'new'), [1]); assert.equal(owner.displayBasis('old'), undefined);
  } finally { void second.preparation; await cleanup(owner, peer); }
});

test('controller styles: held cancelled STYLE does not block parser lease cleanup from using the other physical slot', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    assert.equal(peer.calls[1]!.op, 'styles.resolve'); owner.remove('source'); owner.flush();
    assert.equal(peer.calls[2]!.op, 'stream.close'); assert.equal(owner.stats().unsettledJobs, 2);
    peer.pending[2]!.resolve(peer.envelope(2, { kind: 'closed' })); await settled(); assert.equal(owner.stats().remoteLeases, 0);
    assert.equal(owner.stats().unsettledJobs, 1); peer.style(1); await settled(); assert.equal(owner.stats().unsettledJobs, 0);
    assert.equal(owner.displayBasis('source'), undefined); assert.equal(peer.useful, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: a valid coalesced STYLE result cannot propagate its first owner’s local publication refusal', async () => {
  const peer = new Peer(), budget = new DataBudget(1024 * 1024 * 1024);
  const nativeDispatches: { source?: string; operation?: string }[] = [];
  const diagnostic: DiagnosticSink = (_level, _area, explanation, fields) => {
    if (explanation === 'Native job dispatched') nativeDispatches.push({
      ...(typeof fields?.source === 'string' ? { source: fields.source } : {}),
      ...(typeof fields?.operation === 'string' ? { operation: fields.operation } : {}),
    });
  };
  const owner = new SourceController(peer, { diagnostic, retention: { maxBytes: budget.limit, budget } });
  const sourceReplies = new Set<number>();
  let card: ReturnType<typeof group> | undefined;
  try {
    owner.observe(demand('peer'));
    card = group(owner, Array.from({ length: 8 }, (_, i) => `card-${i}`));
    owner.flush();
    for (let turnIndex = 0; turnIndex < 16; turnIndex++) {
      await settled();
      const index = peer.calls.findIndex((request, i) => request.op !== 'styles.resolve' && !sourceReplies.has(i));
      if (index < 0) break;
      peer.source(index, 'echo one\n', 1, 0, 1); sourceReplies.add(index);
    }
    assert.equal(sourceReplies.size, 9, 'all source contexts are installed before generic STYLE is enabled');
    assert.equal(peer.calls.filter(request => request.op === 'styles.resolve').length, 0);

    const selection = owned(1, 1), preparationsBefore = owner.stats().stylePreparations;
    owner.setStyleSelection(selection); owner.flush(); await settled();
    const styleIndices = peer.calls.flatMap((request, i) => request.op === 'styles.resolve' ? [i] : []);
    assert.equal(styleIndices.length, 1, 'the first owner dispatches one shared missing-context request');
    assert.ok(owner.stats().stylePreparations >= preparationsBefore + 2, 'the card and standalone peer both prepare and coalesce with one held STYLE request');
    const styleDispatches = nativeDispatches.filter(event => event.operation === 'styles.resolve');
    assert.equal(styleDispatches.length, 1);
    assert.equal(styleDispatches[0]!.source, 'card-0', 'native diagnostic proves the multi-member card was the original STYLE-job owner');
    assert.equal(peer.calls.filter(request => request.op === 'styles.resolve').length, 1);

    const stats = budget.stats(), available = stats.limit - stats.retainedBytes - stats.outstandingPeakBytes;
    const pressureBytes = 5000;
    assert.ok(available > pressureBytes);
    const pressure = budget.reserve(available - pressureBytes);
    assert.ok(pressure, 'real outstanding data credit leaves enough for one card but less than the eight-member local group grant');
    try { peer.style(styleIndices[0]!); await settled(); } finally { pressure!.close(); }
    await settled();

    assert.equal(peer.calls.filter(request => request.op === 'styles.resolve').length, 1, 'valid installed expressions are not fetched again');
    assert.equal(owner.stats().stylePublications, 1, 'the independently funded peer publishes from the shared result');
    assert.equal(owner.displayBasis('peer')!.palette, selection.palette);
    assert.deepEqual(color(owner, 'peer'), [1]);
    for (let i = 0; i < 8; i++) assert.equal(owner.displayBasis(`card-${i}`), undefined, 'the refused multi-member card remains unpublished');
    assert.equal(owner.workStatus('peer').execution, 'acknowledged');
  } finally { if (card) void card.preparation; await cleanup(owner, peer); }
});

test('controller styles: missing-context STYLE denial stays suppressed across palette and binding changes', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    const initial = owned(1, 1), palette = { ...initial, palette: 'owned:next-palette' };
    const binding = { ...owned(2, 1), palette: palette.palette };
    owner.setStyleSelection(initial); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush();
    peer.source(0, 'echo one\n'); await settled();
    peer.pending[1]!.reject(new RequestFailure('style refused', 'not_started')); await settled();
    const callsAtRefusal: number = peer.calls.length;
    assert.equal(callsAtRefusal, 2);
    for (const selection of [palette, binding]) {
      assert.equal(owner.setStyleSelection(selection), true); await settled();
      assert.equal(peer.calls.length, callsAtRefusal, 'the palette/binding replacement itself cannot retry a refused generic STYLE request');
      const preparations = owner.stats().stylePreparations;
      for (let i = 0; i < 100; i++) owner.flush(); await settled();
      assert.equal(peer.calls.length, callsAtRefusal, 'a local-only choice cannot retry a refused generic STYLE request');
      assert.equal(owner.stats().stylePreparations, preparations, 'the exact refused local identity stays warm-suppressed');
    }
    const selectedCalls = peer.calls.length;
    owner.observe(demand('source', 'echo one\n# two\n', 2, false)); owner.flush();
    peer.source(2, 'echo one\n# two\n', 2, 9, 2); await settled();
    assert.equal(peer.calls.length, selectedCalls + 2, 'useful source progress may request its genuinely new context');
    peer.pending[3]!.reject(new RequestFailure('next STYLE refusal', 'not_started')); await settled();
    assert.equal(owner.workStatus('source').execution, 'acknowledged');
  } finally { await cleanup(owner, peer); }
});

test('controller styles: denied selection does not warm retry but useful parser progress permits its new context demand', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    peer.pending[1]!.reject(new RequestFailure('style refused', 'not_started')); await settled();
    for (let i = 0; i < 100; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, 2);
    owner.observe(demand('source', 'echo one\n# two\n', 2, false)); owner.flush(); peer.source(2, 'echo one\n# two\n', 2, 9, 2); await settled();
    assert.equal(peer.calls[3]!.op, 'styles.resolve'); peer.style(3, 3); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2); assert.deepEqual(color(owner), [1, 1]); assert.equal(peer.useful, 2);
  } finally { await cleanup(owner, peer); }
});


test('controller styles review R1: one refusal must not suppress an unrelated parsed card', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    for (const key of ['C', 'B', 'A']) owner.observe(demand(key));
    owner.flush();
    peer.source(0, 'echo one\n', 1, 0, 3);
    peer.source(1, 'echo one\n', 1, 0, 2);
    await settled();
    peer.source(2, 'echo one\n', 1, 0, 1);
    await settled();
    assert.equal(peer.useful, 3);
    owner.setStyleSelection(owned()); await settled();
    assert.equal(peer.calls.length, 5);
    assert.deepEqual(peer.calls[3]!.contexts, [[0, 3]]);
    assert.deepEqual(peer.calls[4]!.contexts, [[0, 2]]);
    peer.pending[3]!.reject(new RequestFailure('busy', 'not_started')); await settled();
    peer.style(4, 11); await settled();
    assert.equal(peer.calls.length, 6, 'C must get its own attempt after A refuses and B finishes');
    assert.equal(peer.calls[5]!.op, 'styles.resolve');
    assert.deepEqual(peer.calls[5]!.contexts, [[0, 1]]);
    peer.style(5, 11); await settled();
    assert.deepEqual(color(owner, 'C'), [1]);
    assert.deepEqual(color(owner, 'B'), [1]);
    assert.equal(owner.displayBasis('A'), undefined);
    for (let i = 0; i < 20; i++) owner.flush();
    await settled();
    assert.equal(peer.calls.length, 6, 'A must not warm-retry its refused demand');
    assert.equal(peer.useful, 3, 'unrelated progress must not require another source parse');
  } finally { await cleanup(owner, peer); }
});

test('controller styles review R2: cached palettes with missing contexts must not prepare at full credits', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('W')); owner.flush();
    peer.source(0, 'echo one\n', 1, 0, 1); await settled(); peer.style(1, 11); await settled();
    owner.setStyleSelection(owned(2)); await settled(); peer.style(2, 22); await settled();
    owner.setStyleSelection(undefined);
    owner.observe(demand('T')); owner.observe(demand('U')); owner.flush();
    peer.source(3, 'echo one\n', 1, 0, 2); peer.source(4, 'echo one\n', 1, 0, 3); await settled();
    owner.remove('W');
    owner.setStyleSelection(owned(3)); await settled();
    assert.equal(peer.calls.length, 7);
    assert.equal(owner.stats().unsettledJobs, 2);
    const before = owner.stats();
    for (let i = 0; i < 100; i++) { owner.setStyleSelection(owned(i % 2 === 0 ? 1 : 2)); await settled(); }
    const held = owner.stats();
    assert.equal(held.stylePreparations, before.stylePreparations, 'a palette hit is not complete context coverage');
    assert.equal(held.styleContextVisits, before.styleContextVisits, 'missing contexts must wait for actual request credit');
    assert.equal(held.styleEncodes, before.styleEncodes);
    assert.equal(peer.calls.length, 7);
    peer.style(5, 33); peer.style(6, 33); await settled();
    assert.equal(peer.calls.length, 9);
    for (let i = 7; i < 9; i++) {
      assert.equal(peer.calls[i]!.op, 'styles.resolve');
      assert.equal(fingerprintRules(peer.calls[i]!.rules), fingerprintRules(owned(2).definition), 'only the latest choice may dispatch after credit returns');
      peer.style(i, 22);
    }
    await settled();
    assert.deepEqual(color(owner, 'T'), [2]); assert.deepEqual(color(owner, 'U'), [2]);
    assert.equal(peer.useful, 3);
  } finally { await cleanup(owner, peer); }
});


test('controller styles review R1: real capture-admission refusal stays local despite another card parsing again', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  const data = (owner as unknown as { pool: SemanticRetentionPool }).pool, capture = data.captureDisplays.bind(data);
  let captures = 0;
  // Exercise the real capture allocator's refusal path, not a fabricated reply.
  // The first call is its non-allocating peak probe; the second is A's admission.
  data.captureDisplays = (generations, reserve) => capture(generations, ++captures === 2 ? () => false : reserve);
  try {
    for (const [key, context] of [['C', 1], ['B', 2], ['A', 3]] as const) {
      owner.observe(demand(key)); owner.flush(); peer.source(peer.calls.length - 1, 'echo one\n', 1, 0, context); await settled();
    }
    owner.setStyleSelection(owned()); await settled();
    assert.equal(peer.calls.length, 5); assert.deepEqual(peer.calls.slice(3).map(call => call.contexts), [[[0, 2]], [[0, 1]]]);
    peer.style(3, 11); peer.style(4, 11); await settled();
    assert.equal(owner.displayBasis('A'), undefined); assert.deepEqual(color(owner, 'C'), [1]);
    const prepared = owner.stats().stylePreparations;
    for (let i = 0; i < 100; i++) { owner.flush(); await turn(); }
    assert.equal(peer.calls.length, 5); assert.equal(owner.stats().stylePreparations, prepared);
    owner.observe(demand('B', 'echo two\n', 2)); owner.flush(); peer.source(5, 'echo two\n', 1, 0, 2); await settled();
    assert.deepEqual(color(owner, 'B'), [1], 'B reuses its retained matching context expression');
    assert.equal(peer.calls.length, 6, 'B parser success must not reset the unchanged refused A demand');
    assert.equal(peer.useful, 4); assert.equal(owner.displayBasis('A'), undefined);
  } finally { data.captureDisplays = capture; await cleanup(owner, peer); }
});

test('controller styles review R1: failed old V1 cannot poison a newer V2 style demand', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('source', 'echo one\n# two\n', 2, false)); owner.flush(); peer.source(2, 'echo one\n# two\n', 2, 9, 2); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 2); assert.equal(peer.calls.length, 3);
    peer.pending[1]!.reject(new RequestFailure('old V1 denied', 'not_started')); await settled();
    assert.equal(peer.calls.length, 4); assert.equal(peer.calls[3]!.op, 'styles.resolve'); peer.style(3, 11); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2); assert.deepEqual(color(owner), [1, 1]); assert.equal(peer.useful, 2);
  } finally { await cleanup(owner, peer); }
});

test('controller styles review R2: actual expression loss invalidates positive readiness even with palettes retained', async () => {
  const peer = new Peer(), owner = new SourceController(peer), data = (owner as unknown as { pool: SemanticRetentionPool }).pool;
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    owner.setStyleSelection(owned(2)); await settled(); peer.style(2, 22); await settled();
    const beforeRevision = data.arena.styleInvalidationRevision;
    data.arena.clearStyles('f'.repeat(64)); assert.equal(data.arena.styleInvalidationRevision, beforeRevision, 'empty cleanup does not invalidate evidence');
    owner.observe(demand('held-a')); owner.observe(demand('held-b')); owner.flush();
    data.arena.clearStyles(fingerprintRules(owned().definition));
    assert.equal(data.arena.styleInvalidationRevision, beforeRevision + 1);
    const before = owner.stats(); owner.setStyleSelection(owned()); await settled();
    assert.equal(owner.stats().styleContextVisits, before.styleContextVisits); assert.equal(owner.stats().stylePreparations, before.stylePreparations);
    assert.deepEqual(color(owner), [2], 'retained ready expressions keep the selected local binding after reusable copies are lost');
    peer.source(3, 'echo one\n'); peer.source(4, 'echo one\n'); await settled();
    assert.equal(peer.calls.length, 6); assert.equal(fingerprintRules(peer.calls[5]!.rules), fingerprintRules(owned(1).definition)); peer.style(5, 11); await settled();
    assert.deepEqual(color(owner), [1]); assert.deepEqual(color(owner, 'held-a'), [1]); assert.deepEqual(color(owner, 'held-b'), [1]);
    assert.equal(peer.useful, 3);
  } finally { await cleanup(owner, peer); }
});

test('controller styles review R2: semantic advance invalidates old coverage before previews at full slots', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    owner.setStyleSelection(owned(2)); await settled(); peer.style(2, 22); await settled(); owner.setStyleSelection(undefined);
    owner.observe(demand('source', 'echo one\n# new\n', 2, false)); owner.flush(); peer.source(3, 'echo one\n# new\n', 2, 9, 2); await settled();
    owner.observe(demand('held-a')); owner.observe(demand('held-b')); owner.flush(); const before = owner.stats();
    for (let i = 0; i < 100; i++) { owner.setStyleSelection(owned(i % 2 + 1)); await settled(); }
    assert.equal(owner.stats().stylePreparations, before.stylePreparations); assert.equal(owner.stats().styleContextVisits, before.styleContextVisits);
    assert.equal(peer.calls.length, 6); peer.source(4, 'echo one\n'); peer.source(5, 'echo one\n'); await settled();
    assert.equal(peer.calls.length, 7); assert.deepEqual(peer.calls[6]!.contexts, [[0, 2]]); assert.equal(fingerprintRules(peer.calls[6]!.rules), fingerprintRules(owned(2).definition));
    peer.style(6, 22); await settled(); assert.deepEqual(color(owner), [2, 2]); assert.equal(owner.displayBasis('source')!.version, 2);
    assert.equal(peer.useful, 4);
  } finally { await cleanup(owner, peer); }
});

test('controller styles review R2: completed coverage metadata releases with its collected source owner', async () => {
  const peer = new Peer(); let owner: SourceController | undefined = trackedStyleOwner(peer);
  peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled(); assert.deepEqual(color(owner), [1]);
  const weak = abandonedStyleOwner(owner), budget = (owner as unknown as { pool: SemanticRetentionPool }).pool.budget;
  owner = undefined;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
  assert.equal(weak.owner.deref(), undefined); assert.equal(weak.root.deref(), undefined);
  assert.equal(budget.stats().closed, true); assert.equal(budget.stats().retainedBytes, 0);
});

test('controller styles review R1: an older coalesced request cannot deny a newer logical owner', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('old')); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    owner.observe(demand('new')); owner.flush(); peer.source(2, 'echo one\n'); await settled(); assert.equal(peer.calls.length, 3);
    peer.pending[1]!.reject(new RequestFailure('earlier owner denied', 'not_started')); await settled();
    assert.equal(peer.calls.length, 4, 'new logical demand deserves its own attempt after the older request fails');
    peer.style(3, 11); await settled(); assert.deepEqual(color(owner, 'new'), [1]);
    assert.deepEqual(color(owner, 'old'), [1], 'the earlier refusal still permits later cached local publication');
    assert.equal(peer.useful, 2);
  } finally { await cleanup(owner, peer); }
});


test('controller styles review R1: unsuccessful cache probes are remembered while later useful cache progress still publishes', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    for (const key of ['C', 'B', 'A']) owner.observe(demand(key));
    owner.flush();
    peer.source(0, 'echo one\n', 1, 0, 3); peer.source(1, 'echo one\n', 1, 0, 2); await settled();
    peer.source(2, 'echo one\n', 1, 0, 1); await settled();
    owner.setStyleSelection(owned()); await settled();
    peer.pending[3]!.reject(new RequestFailure('busy', 'not_started')); await settled();
    peer.style(4, 11); await settled(); peer.style(5, 11); await settled();
    assert.equal(peer.calls.length, 6); assert.equal(owner.displayBasis('A'), undefined);
    owner.refreshPreparations(); await settled();
    const before = owner.stats();
    for (let i = 0; i < 20; i++) { owner.refreshPreparations(); await settled(); }
    assert.equal(owner.stats().stylePreparations, before.stylePreparations, 'an unchanged unsuccessful cache probe must not repeat');
    assert.equal(owner.stats().styleContextVisits, before.styleContextVisits, 'registry revisits must not enumerate the refused context again');
    assert.equal(peer.calls.length, 6); assert.equal(peer.useful, 3); assert.equal(owner.displayBasis('A'), undefined);
    owner.observe(demand('D')); owner.flush(); peer.source(6, 'echo one\n', 1, 0, 3); await settled();
    assert.equal(peer.calls[7]!.op, 'styles.resolve'); assert.deepEqual(peer.calls[7]!.contexts, [[0, 3]]);
    peer.style(7, 11); await settled();
    assert.deepEqual(color(owner, 'A'), [1], 'a later cache revision with the missing context must permit local completion');
    assert.deepEqual(color(owner, 'D'), [1]); assert.equal(peer.calls.length, 8); assert.equal(peer.useful, 4);
  } finally { await cleanup(owner, peer); }
});


function neutralSelection(seed = 1, ruleSeed = seed + 1) {
  const base = local(seed, ruleSeed);
  const definition = { ...base.definition, default: { ...base.definition.default, foreground: { kind: 'inherit' as const },
    background: { kind: 'inherit' as const }, attributes: 0, attribute_mask: 0 } };
  const bindings = Array.from({ length: definition.binding_slots }, () => ({ ink: { kind: 'inherit' as const }, attributes: 0, attribute_mask: 0 }));
  return { ...base, definition, bindings,
    roles: { ...roles(1), title: { ...literal(71), background: literal(91).foreground, attributes: 1 }, code: { ...literal(29), attributes: 2 } } };
}
function styles(owner: SourceController, key = 'source') {
  const result: ConcreteStyle[] = [];
  owner.displayBasis(key)?.visit((_text, ranges) => ranges((_from, _to, style) => result.push(style)));
  return result;
}
function expectedNeutral(neutral: 'title' | 'code', selection = neutralSelection()) {
  const palette = selection.roles;
  return { ...palette[neutral], background: palette.code.background };
}

test('controller source neutral: identical Bash grammar shares expressions across explicit title and standalone code', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection());
    // Deliberately misleading keys and identical grammar: origin is explicit data.
    const title = { ...demand('file'), neutral: 'title' as const }, code = demand('bash');
    owner.observe(title); owner.flush(); peer.source(0, title.text); await settled();
    owner.observe(code); owner.flush(); peer.source(2, code.text); await settled();
    assert.equal(peer.calls.length, 3); assert.deepEqual(peer.calls[1]!.contexts, [[0, 1]]);
    peer.styleDefinition(1); await settled();
    assert.deepEqual(styles(owner, 'file'), [expectedNeutral('title')]);
    assert.deepEqual(styles(owner, 'bash'), [expectedNeutral('code')]);
    const old = owner.displayBasis('file')!, before = owner.stats(), work = owner.workStatus('file');
    owner.observe({ ...title, neutral: 'code' }); owner.observe({ ...code, neutral: 'title' }); await settled();
    assert.deepEqual(styles(owner, 'file'), [expectedNeutral('code')]);
    assert.deepEqual(styles(owner, 'bash'), [expectedNeutral('title')]);
    assert.notEqual(owner.displayBasis('file')!.stamp, old.stamp); assert.equal(old.visit(() => assert.fail('stale display')), false);
    assert.deepEqual(owner.workStatus('file'), work); assert.equal(peer.calls.length, 3); assert.equal(peer.useful, 2);
    assert.equal(owner.stats().preparedBytes, before.preparedBytes); assert.equal(owner.stats().styleEncodes, before.styleEncodes);
    assert.equal(owner.stats().restarts, 0); assert.ok(peer.signals.every(signal => !signal?.aborted));
    const warm = owner.stats(); for (let i = 0; i < 20; i++) owner.observe({ ...title, neutral: 'code' }); await settled();
    assert.deepEqual(owner.stats(), warm, 'same-role observation remains a no-op');
    console.log(JSON.stringify({ sourceNeutral: { sourceCalls: peer.useful, styleRPC: before.styleDispatches, contexts: peer.calls[1]!.contexts.length,
      localRebindRPC: peer.calls.length - 3, peakJobs: owner.stats().peakJobs, retainedBytes: owner.stats().retention.retainedBytes } }));
  } finally { await cleanup(owner, peer); }
});

test('controller source neutral: queued source and held style replies materialize the current local role', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection()); const source = demand(); owner.observe(source); owner.flush();
    owner.observe({ ...source, neutral: 'title' }); owner.flush();
    assert.equal(peer.calls.length, 1); assert.equal(peer.signals[0]!.aborted, false);
    peer.source(0, source.text); await settled(); assert.equal(peer.calls[1]!.op, 'styles.resolve');
    owner.observe({ ...source, neutral: 'code' }); owner.flush();
    assert.equal(peer.calls.length, 2); assert.equal(peer.signals[1]!.aborted, false);
    peer.styleDefinition(1); await settled(); assert.deepEqual(styles(owner), [expectedNeutral('code')]);
    assert.equal(peer.calls.length, 2); assert.equal(peer.useful, 1); assert.equal(owner.stats().restarts, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller source neutral: late STYLE refusal for a superseded local presentation cannot poison its successor', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection()); const source = demand(); owner.observe(source); owner.flush(); peer.source(0, source.text); await settled();
    owner.observe({ ...source, neutral: 'title' }); owner.flush(); assert.equal(peer.calls.length, 2);
    peer.pending[1]!.reject(new RequestFailure('STYLE refused', 'not_started')); await settled();
    assert.equal(peer.calls.length, 3, 'the current local presentation can reconsider a superseded refusal');
    assert.equal(peer.calls[2]!.op, 'styles.resolve');
    peer.styleDefinition(2); await settled(); assert.deepEqual(styles(owner), [expectedNeutral('title')]);
    assert.equal(peer.useful, 1); assert.equal(owner.workStatus('source').execution, 'acknowledged');
  } finally { await cleanup(owner, peer); }
});

test('controller source neutral: a new generic rule revision retries while local role changes stay palette-independent', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection()); const source = demand(); owner.observe(source); owner.flush(); peer.source(0, source.text); await settled();
    peer.pending[1]!.reject(new RequestFailure('code role refused', 'not_started')); await settled();
    for (let i = 0; i < 20; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, 2);
    for (let i = 0; i < 20; i++) owner.flush(); await settled(); assert.equal(peer.calls.length, 2);
    const paletteBindingChange = neutralSelection(2, 3);
    const nextSelection = { ...paletteBindingChange, definition: { ...paletteBindingChange.definition,
      rules: [...paletteBindingChange.definition.rules, { path: ['test.changed-rule'], excludes: [], foreground: { kind: 'binding' as const, slot: 0 },
        background: null, font: null, context: null }] } };
    assert.equal(owner.setStyleSelection(nextSelection), true); await settled(); assert.equal(peer.calls.length, 3);
    peer.styleDefinition(2); await settled(); assert.deepEqual(styles(owner), [expectedNeutral('code', nextSelection)]);
    assert.equal(peer.calls.length, 3); assert.equal(peer.useful, 1);
  } finally { await cleanup(owner, peer); }
});

test('controller source neutral: fully cached rebind publishes at two occupied physical slots', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection()); const source = demand(); owner.observe(source); owner.flush(); peer.source(0, source.text); await settled(); peer.styleDefinition(1); await settled();
    owner.observe(demand('held-a')); owner.observe(demand('held-b')); owner.flush(); assert.equal(owner.stats().unsettledJobs, 2);
    const before = owner.stats(); owner.observe({ ...source, neutral: 'title' }); await settled();
    assert.deepEqual(styles(owner), [expectedNeutral('title')]); assert.equal(peer.calls.length, 4);
    assert.equal(owner.stats().styleEncodes, before.styleEncodes); assert.equal(owner.stats().unsettledJobs, 2);
    assert.ok(peer.signals.every(signal => !signal?.aborted));
    peer.source(2, source.text); peer.source(3, source.text); await settled(); assert.equal(peer.calls.length, 4);
    assert.deepEqual(styles(owner, 'held-a'), [expectedNeutral('code')]); assert.equal(peer.useful, 3);
  } finally { await cleanup(owner, peer); }
});



test('controller source neutral: STYLE refusal does not remove locally selected card roles', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(neutralSelection()); const source = demand(); owner.observe(source); owner.flush(); peer.source(0, source.text); await settled();
    peer.pending[1]!.reject(new RequestFailure('STYLE refused', 'not_started')); await settled();
    const before = owner.stats(); owner.observe({ ...source, neutral: 'title' }); await settled();
    assert.equal(peer.calls.length, 2); assert.equal(owner.stats().stylePreparations, before.stylePreparations);
    assert.deepEqual(styles(owner), []);
    owner.observe(source); await settled(); assert.equal(peer.calls.length, 2); assert.equal(peer.useful, 1);
    assert.equal(owner.workStatus('source').execution, 'acknowledged');
  } finally { await cleanup(owner, peer); }
});


test('controller ready palette: pending selection retains actual roles and separates read paint and geometry identities', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush();
    assert.equal(owner.displayBasis('source'), undefined);
    peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    const first = owner.displayBasis('source')!;
    assert.ok(Number.isSafeInteger(first.geometryStamp)); assert.ok(Number.isSafeInteger(first.paintStamp));
    for (const role of CARD_ROLES) assert.deepEqual(first.role(role), owned().roles[role]);
    owner.setStyleSelection(owned(2)); await settled();
    const pending = owner.displayBasis('source')!;
    assert.equal(pending.geometryStamp, first.geometryStamp); assert.equal(pending.paintStamp, first.paintStamp);
    assert.deepEqual(pending.role('panel'), owned().roles.panel, 'desired palette must not replace actual ready roles');
    peer.style(2, 22); await settled(); const second = owner.displayBasis('source')!;
    assert.notEqual(second.paintStamp, first.paintStamp); assert.equal(second.geometryStamp, first.geometryStamp);
    assert.equal(first.role('panel'), undefined); assert.equal(pending.role('code'), undefined);
    for (const role of CARD_ROLES) assert.deepEqual(second.role(role), owned(2).roles[role]);
    const sameInkSelection = { ...owned(2), palette: 'owned:same-ink', bindingRevision: owned(2).bindingRevision + 1 };
    owner.setStyleSelection(sameInkSelection); await settled();
    const sameInk = owner.displayBasis('source')!;
    assert.notEqual(sameInk.stamp, second.stamp, 'new publication invalidates the old weak read identity');
    assert.equal(sameInk.paintStamp, second.paintStamp, 'binding metadata alone is not repaint work');
    assert.equal(sameInk.geometryStamp, first.geometryStamp);
    assert.equal(second.role('code'), undefined); assert.deepEqual(sameInk.role('code'), sameInkSelection.roles.code);
    const before = owner.stats();
    for (let i = 0; i < 100; i++) for (const role of CARD_ROLES) assert.deepEqual(sameInk.role(role), sameInkSelection.roles[role]);
    assert.deepEqual(owner.stats(), before); assert.equal(peer.useful, 1); assert.equal(peer.calls.length, 3);
  } finally { await cleanup(owner, peer); }
});

test('controller ready palette: removal successor and off invalidate saved roles without following a new source', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); const selectedBytes = owner.stats().retention.retainedBytes;
    owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    const removed = owner.displayBasis('source')!;
    assert.equal(removed.visit((_text, ranges) => {
      assert.deepEqual(removed.role('output'), owned().roles.output); owner.remove('source');
      assert.equal(removed.role('output'), undefined);
      assert.equal(ranges(() => assert.fail('removed ranges emitted')), false);
    }), false);
    owner.observe(demand()); owner.flush(); peer.source(2, 'echo one\n'); await settled(); peer.style(3, 33); await settled();
    const successor = owner.displayBasis('source')!;
    assert.notEqual(successor.generation, removed.generation); assert.equal(removed.role('panel'), undefined);
    assert.deepEqual(successor.role('panel'), owned().roles.panel);
    owner.setEnabled(false); assert.equal(successor.role('panel'), undefined);
    assert.equal(owner.stats().retention.entries, 0); assert.equal(owner.stats().retention.contexts, 0);
    assert.equal(owner.stats().retention.retainedBytes, selectedBytes, 'only the still-selected primitive configuration remains funded');
  } finally { await cleanup(owner, peer); }
});

async function collectedPaletteOwner(peer: Peer) {
  const owner = new SourceController(peer); owner.setStyleSelection(owned()); owner.observe(demand('old'));
  owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
  return { owner: new WeakRef(owner), basis: owner.displayBasis('old')! };
}
test('controller ready palette: saved role reader does not retain its first controller while a peer remains active', async () => {
  const peer = new Peer(), old = await collectedPaletteOwner(peer), livePeer = new Peer(), live = new SourceController(livePeer);
  try {
    live.setStyleSelection(owned()); live.observe(demand('live')); live.flush(); livePeer.source(0, 'echo one\n'); await settled(); livePeer.style(1, 77); await settled();
    for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
    assert.equal(old.owner.deref(), undefined); assert.equal(old.basis.role('panel'), undefined);
    assert.equal(old.basis.visit(() => assert.fail('collected controller emitted')), false);
    assert.equal(old.basis.visitStyles(() => assert.fail('collected controller enumerated styles')), false);
    assert.equal(live.displayBasis('live')!.visitStyles(style => assert.deepEqual(style, owned().roles.code)), true);
    assert.deepEqual(live.displayBasis('live')!.role('panel'), owned().roles.panel);
  } finally { await cleanup(live, livePeer); }
});


test('controller ready palette: equal-ink selected-palette and binding replacements invalidate weak readers but not geometry', async () => {
  const peer = new Peer(), owner = new SourceController(peer), input = local();
  try {
    owner.setStyleSelection(input); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1); await settled();
    for (const selection of [{ ...input, palette: 'same-inks' }, { ...input, palette: 'same-inks', bindingRevision: 2 }]) {
      const previous = owner.displayBasis('source')!, calls = peer.calls.length, useful = peer.useful;
      owner.setStyleSelection(selection); await settled(); const next = owner.displayBasis('source')!;
      assert.equal(previous.role('panel'), undefined, 'a replacement palette must invalidate its predecessor even when its colors are equal');
      assert.equal(previous.visit(() => assert.fail('superseded client reader emitted')), false);
      assert.equal(previous.visitStyles(() => assert.fail('superseded style table emitted')), false);
      assert.equal(next.visitStyles(style => assert.ok(Object.isFrozen(style))), true);
      assert.notEqual(next.stamp, previous.stamp);
      assert.equal(next.paintStamp, previous.paintStamp); assert.equal(next.geometryStamp, previous.geometryStamp);
      for (const role of CARD_ROLES) assert.deepEqual(next.role(role), input.roles[role]);
      assert.equal(peer.calls.length, calls); assert.equal(peer.useful, useful);
      owner.setStyleSelection(selection); await settled();
      assert.equal(owner.displayBasis('source')!.stamp, next.stamp, 'unchanged publication metadata is a genuine no-op');
      assert.deepEqual(next.role('panel'), input.roles.panel);
    }
  } finally { await cleanup(owner, peer); }
});


test('controller ready palette: unchanged-text stream finalization preserves ready geometry paint and typography', async () => {
  const peer = new Peer(), owner = new SourceController(peer), text = 'echo one\n';
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', text, 1, false)); owner.flush();
    peer.source(0, text); await settled(); peer.style(1, 11); await settled();
    const before = owner.displayBasis('source')!, work = owner.stats();
    owner.observe(demand('source', text, 2, true)); owner.flush();
    assert.equal(peer.calls[2]!.op, 'stream.append'); assert.equal(peer.calls[2]!.append, ''); assert.equal(peer.calls[2]!.final, true);
    peer.source(2, text, 2, Buffer.byteLength(text)); await settled();
    const after = owner.displayBasis('source')!;
    assert.equal(after.geometryStamp, before.geometryStamp, 'work completion alone cannot require reflow');
    assert.equal(after.paintStamp, before.paintStamp); assert.equal(after.stamp, before.stamp);
    assert.deepEqual(after.role('code'), owned().roles.code); assert.deepEqual(color(owner), [roleRed(owned())]);
    assert.equal(owner.status('source')!.acknowledgedVersion, 2); assert.equal(owner.stats().remoteLeases, 0);
    assert.equal(owner.stats().stylePreparations, work.stylePreparations); assert.equal(peer.calls.length, 3);
    assert.equal(peer.useful, 2, 'actual finalization remains source acknowledgement, never historical color proof');
    assert.equal(after.complete, false, 'retained presentation remains historical, not new finite authority');
  } finally { await cleanup(owner, peer); }
});


test('controller ready palette: finalized same-text view supports cached rebinding at full credits without reflow', async () => {
  const peer = new Peer(), owner = new SourceController(peer), text = 'echo one\n';
  try {
    owner.setStyleSelection(local(11, 42)); owner.observe(demand('source', text, 1, false)); owner.flush();
    peer.source(0, text); await settled(); peer.styleBinding(1); await settled();
    const before = owner.displayBasis('source')!;
    owner.observe(demand('source', text, 2, true)); owner.flush();
    peer.source(2, text, 2, Buffer.byteLength(text)); await settled();
    owner.observe(demand('busy1', 'x\n')); owner.flush(); owner.observe(demand('busy2', 'y\n')); owner.flush(); await settled();
    assert.equal(owner.stats().globalUnsettledJobs, 2); assert.equal(peer.calls.length, 5);
    owner.setStyleSelection(local(12, 42)); owner.flush(); await settled();
    const next = owner.displayBasis('source')!;
    assert.equal(next.geometryStamp, before.geometryStamp); assert.notEqual(next.paintStamp, before.paintStamp);
    assert.deepEqual(next.role('code'), local(12, 42).roles.code); assert.deepEqual(color(owner), [roleRed(local(12, 42))]);
    assert.equal(next.complete, false); assert.equal(owner.stats().globalUnsettledJobs, 2); assert.equal(peer.calls.length, 5);
    owner.setStyleSelection(local(13, 42)); owner.flush(); await settled();
    assert.equal(owner.displayBasis('source')!.geometryStamp, before.geometryStamp); assert.deepEqual(color(owner), [roleRed(local(13, 42))]);
    assert.equal(peer.calls.length, 5);
  } finally { await cleanup(owner, peer); }
});

test('controller ready palette: equal-length text correction cannot reuse a former text identity', async () => {
  const peer = new Peer(), owner = new SourceController(peer), first = 'echo one\n', second = 'echo two\n';
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', first)); owner.flush();
    peer.source(0, first); await settled(); peer.style(1, 11); await settled();
    const before = owner.displayBasis('source')!;
    owner.observe(demand('source', second, 2)); owner.flush(); peer.source(2, second); await settled();
    const next = owner.displayBasis('source')!, observed: string[] = [];
    assert.notEqual(next.generation, before.generation); assert.equal(next.visit(text => observed.push(text)), true);
    assert.deepEqual(observed, [second]); assert.equal(before.visit(() => assert.fail('old text returned')), false);
    assert.deepEqual(color(owner), [roleRed(owned())]); assert.equal(peer.calls.length, 3);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: ready-table enumeration scales with adopted contexts, not ranges or advanced parser demand', async () => {
  const peer = new Peer(), owner = new SourceController(peer), text = 'x\n'.repeat(6000);
  const capture = SemanticRanges.prototype.captureView;
  let viewPrototype: { visit: (...args: any[]) => unknown } | undefined;
  SemanticRanges.prototype.captureView = function (...args) {
    const view = Reflect.apply(capture, this, args);
    if (view) viewPrototype = Object.getPrototypeOf(view);
    return view;
  };
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', text, 1, false)); owner.flush();
    const q = peer.calls[0]!, s = q.sources[0];
    peer.pending[0]!.resolve(peer.envelope(0, { kind: 'source', vocabulary: peer.description.vocabulary.fingerprint,
      sources: [{ key: s.key, generation: s.generation, source_version: 1, revision: 1, source_bytes: text.length,
        replace_from: 0, committed_bytes: text.length, complete: false, lease: 'lease:1', contexts: [[0, 1], [0, 2]],
        runs: Array.from({ length: text.length }, (_, i) => [1, 1 + i % 2]).flat(),
        counters: { committed_line_calls: 6000, committed_line_bytes: text.length, tail_calls: 0, tail_bytes: 0 } }] }));
    await settled();
    const styleRequest = peer.calls[1]!;
    assert.equal(styleRequest.contexts.length, 2);
    peer.pending[1]!.resolve(peer.envelope(1, { kind: 'styles', vocabulary: styleRequest.vocabulary,
      rules: fingerprintRules(styleRequest.rules),
      styles: [literal(7), literal(11)].map(style => ({ ...style, attribute_mask: 31 })), indices: [1, 2],
    }));
    await settled(); SemanticRanges.prototype.captureView = capture;
    const basis = owner.displayBasis('source')!, styles = new Set<ConcreteStyle>();
    assert.equal(basis.visitStyles(style => styles.add(style)), true); assert.equal(styles.size, 3);
    let rangeCallbacks = 0;
    assert.equal(basis.visit((_text, read) => assert.equal(read((_from, _to, style) => { rangeCallbacks++; assert.ok(styles.has(style)); }), true)), true);
    assert.equal(rangeCallbacks, text.length); assert.ok(styles.has(basis.role('code')!));
    owner.observe(demand('source', text + 'z\n', 2, false)); owner.flush();
    assert.equal(peer.calls[2]!.op, 'stream.append'); peer.source(2, text + 'z\n', 2, text.length, 3); await settled();
    assert.equal(owner.status('source')!.acknowledgedVersion, 2); assert.equal(owner.displayBasis('source')!.version, 1);
    assert.ok(viewPrototype); const viewVisit = viewPrototype.visit, currentVisit = SemanticRanges.prototype.visit;
    let rangeWalks = 0, styleCallbacks = 0;
    const forbid = () => { rangeWalks++; throw new Error('ranges traversed to enumerate ready styles'); };
    viewPrototype.visit = forbid; SemanticRanges.prototype.visit = forbid;
    try {
      const before = owner.stats(), calls = peer.calls.length;
      for (let n = 0; n < 20; n++) assert.equal(basis.visitStyles(style => { styleCallbacks++; assert.ok(styles.has(style)); }), true);
      assert.equal(styleCallbacks, 60, 'neutral plus two adopted contexts, not 12000 ranges or the pending third context');
      assert.equal(rangeWalks, 0); assert.deepEqual(owner.stats(), before); assert.equal(peer.calls.length, calls);
      console.log(JSON.stringify({ adoptedStyleTable: { ranges: rangeCallbacks, contexts: 2, reads: 20, styleCallbacks, rangeWalks, requestDelta: peer.calls.length - calls } }));
    } finally { viewPrototype.visit = viewVisit; SemanticRanges.prototype.visit = currentVisit; }
  } finally { SemanticRanges.prototype.captureView = capture; await cleanup(owner, peer); }
});

for (const throws of [false, true]) test(`controller styles: ready-table callback removal stops enumeration and pins palette through unwind (throws=${throws})`, async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled(); peer.style(1, 7); await settled();
    const basis = owner.displayBasis('source')!, root = Reflect.get(owner, 'pool') as SemanticRetentionPool;
    let callbacks = 0, during = 0;
    const visit = () => basis.visitStyles(style => {
      callbacks++; assert.equal(style, basis.role('code'));
      owner.remove('source'); assert.equal(basis.visitStyles(() => assert.fail('stale nested read')), false);
      during = root.budget.stats().retainedBytes;
      assert.equal(root.budget.reserve(root.budget.limit - during + 1), undefined, 'the suspended table cannot be spent again');
      if (throws) throw new Error('table consumer failed');
    });
    if (throws) assert.throws(visit, /table consumer failed/); else assert.equal(visit(), false);
    assert.equal(callbacks, 1); assert.ok(during > root.budget.stats().retainedBytes, 'the old table charge releases exactly at unwind');
    assert.equal(basis.visitStyles(() => assert.fail('removed owner')), false);
    assert.equal(root.budget.stats().outstandingPeakBytes, 0);
  } finally { await cleanup(owner, peer); }
});

test('controller volume limits: aggregate STYLE words refuse before encoding, without blocking a fitting card or reparsing', async () => {
  const peer = new Peer(), owner = new SourceController(peer), card = group(owner, ['left', 'right']);
  try {
    owner.flush(); assert.equal(peer.calls.length, 2);
    for (let i = 0; i < 2; i++) {
      const input = peer.calls[i]!.sources[0];
      peer.pending[i]!.resolve(peer.envelope(i, { kind: 'source', vocabulary: peer.description.vocabulary.fingerprint,
        sources: [{ key: input.key, generation: input.generation, source_version: input.source_version,
          revision: 1, source_bytes: 9, replace_from: 0, committed_bytes: 9, complete: true,
          contexts: [[0, ...Array(32769).fill(i + 1)]], runs: [9, 1],
          counters: { committed_line_calls: 1, committed_line_bytes: 9, tail_calls: 0, tail_bytes: 0 } }] }));
    }
    await settled(); assert.equal(peer.useful, 2);
    owner.setStyleSelection(owned()); await settled();
    assert.equal(peer.calls.length, 2, 'expanded aggregate exceeds65536 despite compact/front-coded transport');
    assert.equal(owner.stats().styleEncodes, 0); assert.equal(owner.stats().styleCaptures, 0);
    assert.equal(owner.workStatus('left').fallbackEligible, false);
    const rejections = owner.stats().styleRejections;
    for (let i = 0; i < 20; i++) owner.flush(); await settled();
    assert.equal(owner.stats().styleRejections, rejections, 'no warm refusal carousel');
    owner.observe(demand('fitting')); owner.flush(); peer.source(2, 'echo one\n'); await settled();
    assert.equal(peer.calls[3]!.op, 'styles.resolve'); peer.style(3, 7); await settled();
    assert.deepEqual(color(owner, 'fitting'), [roleRed(owned())]);
    assert.equal(peer.calls.filter(call => call.op === 'highlight').length, 3);
    assert.equal(owner.groupPresentation(card.work), undefined);
    assert.equal(owner.stats().unsettledJobs, 0);
  } finally { void card.preparation; await cleanup(owner, peer); }
});


test('controller styles: retained V1 recolors every role after V2 STYLE refused without SOURCE replay', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', 'echo one\n', 1, false)); owner.flush();
    peer.source(0, 'echo one\n'); await settled(); peer.style(1, 11); await settled();
    const first = owner.displayBasis('source')!;
    owner.observe(demand('source', 'echo one\necho two\n', 2, false)); owner.flush();
    peer.source(2, 'echo one\necho two\n', 2, 9, 2); await settled();
    assert.equal(peer.calls[3]!.op, 'styles.resolve');
    assert.equal(owner.status('source')!.acknowledgedVersion, 2);
    owner.freeze('source');
    peer.pending[3]!.reject(new RequestFailure('abandoned V2 style', 'not_started'));
    await settled();
    for (let i = 4; i < peer.calls.length; i++) if (peer.calls[i]!.op === 'stream.close') peer.pending[i]!.resolve(peer.envelope(i, { kind: 'closed' }));
    await settled();
    const sources = peer.calls.filter(call => call.op !== 'styles.resolve').length;
    owner.setStyleSelection(owned(2)); await settled();
    const style = peer.calls.length - 1; assert.equal(peer.calls[style]!.op, 'styles.resolve');
    assert.equal(peer.calls[style]!.contexts.length, 1, 'new recoloring captures last ready V1 after the pending V2 STYLE failed');
    peer.style(style, 22); await settled();
    const recolored = owner.displayBasis('source')!;
    assert.equal(recolored.palette, owned(2).palette); assert.equal(recolored.version, 1);
    assert.equal(recolored.geometryStamp, first.geometryStamp);
    let text = ''; assert.equal(recolored.visit(value => { text = value; }), true); assert.equal(text, 'echo one\n');
    assert.deepEqual(color(owner), [roleRed(owned(2))]);
    for (const role of CARD_ROLES) assert.deepEqual(recolored.role(role), owned(2).roles[role]);
    assert.equal(peer.calls.filter(call => call.op !== 'styles.resolve').length, sources, 'no SOURCE or lease revival');
    assert.equal(peer.useful, 2); assert.equal(owner.stats().styleCaptures, 0);
  } finally { await cleanup(owner, peer); }
});

for (const complete of [false, true]) test(`controller styles: empty local presentation then ${complete ? 'finite' : 'growing'} Bash starts a fresh parser`, async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(local()); owner.observe(demand('source', '', 1, false)); owner.flush(); await settled();
    assert.equal(peer.calls.length, 0, 'empty local paint needs no SOURCE');
    assert.equal(owner.displayBasis('source')?.version, 1, 'exercise actual prepared empty paint, not merely registration');
    const text = "printf 'ready'\n";
    owner.observe(demand('source', text, 2, complete)); owner.flush();
    assert.equal(peer.calls[0]!.op, complete ? 'highlight' : 'stream.open');
    peer.source(0, text); await settled();
    assert.equal(owner.workStatus('source').execution, 'acknowledged', 'fresh parser revision one is valid after local empty paint');
    assert.equal(owner.status('source')!.exact, true);
    const style = peer.calls.findIndex(frame => frame.op === 'styles.resolve');
    assert.ok(style >= 0); peer.style(style); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2); assert.deepEqual(color(owner), [roleRed(local())]);
    if (!complete) {
      const next = text + 'echo tail';
      owner.observe(demand('source', next, 3, false)); owner.flush();
      const append = peer.calls.length - 1;
      assert.equal(peer.calls[append]!.op, 'stream.append'); assert.equal(peer.calls[append]!.base_revision, 1);
      assert.equal(peer.calls[append]!.append, 'echo tail');
      peer.source(append, next, 2, Buffer.byteLength(text)); await settled();
      owner.observe(demand('source', next, 3, true)); owner.flush();
      const final = peer.calls.length - 1;
      assert.equal(peer.calls[final]!.op, 'stream.append'); assert.equal(peer.calls[final]!.base_revision, 2);
      assert.equal(peer.calls[final]!.append, ''); assert.equal(peer.calls[final]!.final, true);
      peer.source(final, next, 3, Buffer.byteLength(text)); await settled();
      assert.equal(owner.status('source')!.exact, true); assert.equal(owner.stats().remoteLeases, 0);
    }
    const count = peer.calls.length;
    for (let i = 0; i < 10; i++) owner.flush(); await settled();
    assert.equal(peer.calls.length, count, 'warm frames do not replay SOURCE or STYLE');
    assert.equal(owner.status('source')!.protective, false);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: empty owned palette input cannot become the growing source parser acknowledgement', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand('source', '', 1, false)); owner.flush(); await settled();
    assert.equal(peer.calls.length, 0, 'owned palette and empty source are prepared locally');
    assert.equal(owner.displayBasis('source')?.version, 1);
    owner.observe(demand('source', 'echo ready\n', 2, false)); owner.flush();
    assert.equal(peer.calls[0]!.op, 'stream.open');
    peer.source(0, 'echo ready\n'); await settled();
    assert.equal(owner.workStatus('source').execution, 'acknowledged'); assert.equal(owner.status('source')!.exact, true);
    const style = peer.calls.findIndex(call => call.op === 'styles.resolve');
    assert.ok(style >= 0, 'a nonempty generic context still requires STYLE'); peer.style(style); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2); assert.deepEqual(color(owner), [roleRed(owned())]);
    assert.equal(owner.status('source')!.protective, false);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: clearing a parsed source then preparing empty paint does not advance the next parser', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(local()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    peer.style(1); await settled(); assert.equal(owner.displayBasis('source')!.version, 1);
    owner.observe(demand('source', '', 2, false)); owner.flush(); await settled();
    assert.equal(owner.displayBasis('source')!.version, 2);
    owner.observe(demand('source', 'echo two\n', 3, false)); owner.flush();
    const open = peer.calls.length - 1; assert.equal(peer.calls[open]!.op, 'stream.open');
    peer.source(open, 'echo two\n'); await settled();
    assert.equal(owner.workStatus('source').execution, 'acknowledged'); assert.equal(owner.status('source')!.exact, true);
    assert.equal(owner.status('source')!.protective, false);
  } finally { await cleanup(owner, peer); }
});

test('controller styles: empty paint does not authorize revision two from a fresh parser', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(local()); owner.observe(demand('source', '', 1, false)); owner.flush(); await settled();
    assert.equal(owner.displayBasis('source')?.version, 1);
    owner.observe(demand('source', 'echo ready\n', 2, false)); owner.flush(); peer.source(0, 'echo ready\n', 2); await settled();
    assert.equal(owner.workStatus('source').execution, 'unknown'); assert.equal(owner.status('source')!.exact, false);
    assert.equal(owner.workStatus('source').fallbackEligible, false, 'wrong native revision remains an unknown physical outcome');
    const count = peer.calls.length; owner.flush(); await settled(); assert.equal(peer.calls.length, count);
  } finally { await cleanup(owner, peer); }
});


for (const [name, selection] of [['local-rules', local()], ['owned-rules', owned()]] as const) test(`completion boundary: empty ${name} presentation settles while unrelated STYLE jobs occupy capacity`, async () => {
  const peer = new Peer(), owner = new SourceController(peer), busyPeer = new Peer(), busyOwner = new SourceController(busyPeer);
  try {
    owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    assert.equal(owner.status('source')?.acknowledgedVersion, 1);
    const generation = owner.status('source')!.generation; assert.ok(generation);
    busyOwner.observe(demand('a', 'echo a\n')); busyOwner.observe(demand('b', 'echo b\n')); busyOwner.flush();
    owner.setStyleSelection(selection); await settled();
    assert.equal(peer.calls.length, 1, 'no palette-only or empty-input STYLE work is sent');
    const completion = owner.whenSettled();
    owner.observe(demand('source', '', 2));
    const replacement = owner.status('source')!.generation;
    assert.ok(replacement); assert.notEqual(replacement, generation, 'the empty replacement owns a new live generation');
    assert.equal(await awaitFixture(completion), true, 'empty selected palettes publish locally despite unrelated held requests');
    assert.equal(peer.calls.length, 1); assert.ok(owner.displayBasis('source'));
    assert.equal(owner.stats().globalUnsettledJobs, 2);
  } finally {
    busyOwner.dispose(); for (const pending of busyPeer.pending) pending.reject(new RequestFailure('cleanup', 'not_started'));
    await settled(); await cleanup(owner, peer);
  }
});


test('completion boundary: a held generic STYLE reply uses the latest same-rule palette binding without another request', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    const initial = owned(1, 1), replacement = owned(2, 1);
    owner.setStyleSelection(initial); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    assert.equal(peer.calls[1]!.op, 'styles.resolve');
    const completion = owner.whenSettled(); let completed = false; void completion.then(() => { completed = true; });
    owner.setStyleSelection(replacement); await settled();
    for (let i = 0; i < 20; i++) owner.setStyleSelection(replacement);
    await settled();
    assert.equal(completed, false, 'same-rule palette changes retain the held producer-owned STYLE interest');
    assert.equal(peer.calls.length, 2, 'palette/binding changes do not send another generic STYLE request');
    peer.style(1); assert.equal(await awaitFixture(completion), true);
    assert.deepEqual(color(owner), [roleRed(replacement)]);
    for (const role of CARD_ROLES) assert.deepEqual(owner.displayBasis('source')!.role(role), replacement.roles[role]);
    assert.equal(peer.calls.filter(call => call.op !== 'styles.resolve').length, 1, 'the source is not replayed');
  } finally { await cleanup(owner, peer); }
});


test('completion boundary: an old STYLE result cannot publish after the selected rule identity changes', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  try {
    owner.setStyleSelection(owned()); owner.observe(demand()); owner.flush(); peer.source(0, 'echo one\n'); await settled();
    assert.equal(peer.calls[1]!.op, 'styles.resolve');
    owner.setStyleSelection(owned(2)); await settled();
    assert.equal(peer.calls[2]!.op, 'styles.resolve');
    peer.style(1, 11); await settled(); assert.equal(owner.displayBasis('source'), undefined);
    peer.style(2, 22); assert.equal(await awaitFixture(owner.whenSettled()), true);
    assert.deepEqual(color(owner), [roleRed(owned(2))]); assert.equal(peer.useful, 1, 'selection replacement must not reparse the source');
  } finally { await cleanup(owner, peer); }
});
