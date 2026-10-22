import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController, type SourcePreparation, type GroupDisplayBasis } from '../../../src/occipital/controller.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { CARD_ROLES, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { fingerprintNative, fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';

type Frame = Record<string, any>;
const definition = { revision: 1 as const, binding_slots: 0, default: { foreground: { kind: 'inherit' as const }, background: { kind: 'inherit' as const }, attributes: 0, attribute_mask: 0 }, rules: [] };
const literal = (n: number): ConcreteStyle => ({ foreground: { kind: 'rgb', r: n, g: 2, b: 3 }, background: { kind: 'rgb', r: 4, g: 5, b: 6 }, attributes: 0 });
const roles = (n: number) => Object.fromEntries(CARD_ROLES.map(role => [role, literal(n)])) as Record<CardRole, ConcreteStyle>;
const native = (n = 1) => ({ kind: 'native' as const, id: `native${n}`, fingerprint: n.toString(16).padStart(64, '0') });
const local = (n = 1, bindingRevision = n) => ({ kind: 'client' as const, definition, bindingRevision, palette: `local:${bindingRevision}`, bindings: [], roles: roles(n) });
const demand = (key: string, text = 'x\n', version = 1, complete = true) => ({ key, text, version, complete, language: 'text', profile: 'pi', fingerprint: fingerprintRules(definition) });
class Peer {
  generation = 1;
  description = decodeSemanticDescription(semanticDescriptor('describe', 'instance', []), 'describe');
  calls: Frame[] = []; signals: (AbortSignal | undefined)[] = []; useful = 0;
  pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  snapshot() { return { generation: this.generation, availability: 'ready' as const, reason: 'ready' as const, kind: 'shared' as const, initialShared: true, description: this.description }; }
  isReady(n: number) { return n === this.generation; }
  classificationAccepted() { this.useful++; return true; }
  request(_generation: number, request: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    this.calls.push(request); this.signals.push(options?.signal);
    return new Promise<unknown>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  envelope(i: number, body: unknown) { return { v: 3, ticket: this.calls[i]!.ticket, instance: this.description.instance, assets: this.description.assets, status: 'ok', body }; }
  source(i: number, text = 'x\n', context = 1, revision = 1, from = 0, split = false) {
    const q = this.calls[i]!, s = q.sources?.[0] ?? q, bytes = Buffer.byteLength(text), complete = q.op === 'highlight' || !!q.final;
    this.pending[i]!.resolve(this.envelope(i, { kind: 'source', vocabulary: this.description.vocabulary.fingerprint, sources: [{ key: s.key, generation: s.generation, source_version: s.source_version,
      revision, source_bytes: bytes, replace_from: from, committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
      ...(!complete || q.op === 'stream.append' ? { lease: q.lease ?? 'lease:1' } : {}), contexts: bytes === from ? [] : split ? [[0, context], [0, context + 1]] : [[0, context]], runs: bytes === from ? [] : split ? [1, 1, bytes - from - 1, 2] : [bytes - from, 1],
      counters: { committed_line_calls: 1, committed_line_bytes: bytes, tail_calls: 0, tail_bytes: 0 } }] }));
  }
  style(i: number, n = 1, bad = false) {
    const q = this.calls[i]!, isNative = q.rules.kind === 'native';
    this.pending[i]!.resolve(this.envelope(i, { kind: 'styles', vocabulary: q.vocabulary, rules: bad ? 'f'.repeat(64) : isNative ? fingerprintNative(q.rules.fingerprint, 'rules') : fingerprintRules(q.rules.definition),
      styles: q.contexts.length || isNative ? [{ ...(isNative ? literal(n) : definition.default), attribute_mask: isNative ? 31 : 0 }] : [], indices: q.contexts.map(() => 1),
      palette: isNative ? { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } : null }));
  }
}
async function settle() { for (let i = 0; i < 8; i++) await turn(); }
function card(owner: SourceController, names: string[]) {
  const keys = new Set(names);
  const preparation: SourcePreparation = { keys, prepare() { for (const key of keys) owner.observe(demand(key)); }, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  return { keys, preparation, group, start() { owner.queuePreparation(group, true); owner.flush(); } };
}
async function cleanup(owner: SourceController, peer: Peer) {
  owner.dispose();
  for (let i = 0; i < 4; i++) {
    for (const p of peer.pending) p.reject(new RequestFailure('cleanup', 'not_started'));
    await settle(); if (!owner.stats().globalUnsettledJobs) break;
  }
  const stats = owner.stats();
  assert.equal(stats.globalUnsettledJobs, 0); assert.equal(stats.globalTransientBytes, 0); assert.equal(stats.transientBytes, 0);
  assert.equal(stats.captures, 0); assert.equal(stats.styleCaptures, 0);
  assert.equal(stats.retention.retainedBytes, 0); assert.equal(stats.retention.outstandingPeakBytes, 0);
}
function ink(style: ConcreteStyle | undefined) { return style?.foreground.kind === 'rgb' ? style.foreground.r : undefined; }
function colors(view: GroupDisplayBasis | undefined, keys: string[]) {
  const result: number[] = []; assert.ok(view);
  assert.equal(view.visit(member => { result.push(ink(view.role('panel'))!); for (const key of keys) assert.equal(member(key)!.read((_a, _b, style) => result.push(ink(style)!)), true); }), true);
  return result;
}

test('group presentation: useful zero-source demand is explicit; generic uses no RPC or source authority', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); await settle(); assert.equal(owner.groupPresentation(c.group), undefined);
    c.start(); await settle(); const view = owner.groupPresentation(c.group)!;
    assert.equal(ink(view.role('panel')), 7); assert.equal(view.visit(member => assert.equal(member('missing'), undefined)), true);
    assert.equal(peer.calls.length, 0); assert.equal(owner.stats().sourceRecords, 0); assert.equal(owner.stats().retention.entries, 0);
    assert.equal(owner.stats().preparedBytes, 0); assert.equal(owner.stats().remoteLeases, 0); assert.equal(peer.useful, 0);
    const before = owner.stats(); for (let i = 0; i < 100; i++) { owner.flush(); assert.ok(owner.groupPresentation(c.group)); }
    await settle(); assert.equal(peer.calls.length, 0); assert.equal(owner.stats().stylePreparations, before.stylePreparations);
    assert.equal(owner.updatePreparation(c.group), true); assert.equal(owner.groupPresentation(c.group)!.stamp, view.stamp);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: native palette-only uses empty contexts, rollback cache and no fake source', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(native()); c.start(); await settle();
    assert.equal(peer.calls.length, 1); assert.equal(peer.calls[0]!.op, 'styles.resolve'); assert.deepEqual(peer.calls[0]!.contexts, []);
    assert.equal(owner.stats().sourceRecords, 0); assert.equal(owner.stats().captures, 0); assert.equal(owner.stats().retention.entries, 0);
    peer.style(0, 11); await settle(); const a = owner.groupPresentation(c.group)!; assert.equal(ink(a.role('frame')), 11);
    owner.setStyleSelection(native(2)); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('frame')), 11);
    peer.style(1, 22); await settle(); assert.equal(a.role('frame'), undefined);
    owner.setStyleSelection(native()); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('frame')), 11);
    assert.equal(peer.calls.length, 2); assert.equal(peer.useful, 0); assert.equal(owner.stats().preparedBytes, 0);
    owner.unregisterPreparation(c.group); assert.equal(owner.groupPresentation(c.group), undefined);
    assert.equal(owner.stats().retention.retainedBytes > 0, true, 'desired config alone remains after last useful owner/cache removal');
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: two stable slots switch all-old to all-new; unrelated group completes independently', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['left', 'right']);
  try {
    owner.setStyleSelection(native()); c.start(); await settle();
    peer.source(0, 'x\n', 1); peer.source(1, 'x\n', 2); await settle(); peer.style(2, 11); await settle();
    assert.deepEqual(colors(owner.groupPresentation(c.group), ['left', 'right']), [11, 11, 11]);
    owner.setStyleSelection(native(2)); await settle();
    const other = card(owner, []); other.start(); await settle();
    assert.deepEqual(colors(owner.groupPresentation(c.group), ['left', 'right']), [11, 11, 11]);
    // One existing palette request also satisfies the independent empty owner after settlement.
    peer.style(3, 22); await settle();
    assert.deepEqual(colors(owner.groupPresentation(c.group), ['left', 'right']), [22, 22, 22]);
    assert.equal(ink(owner.groupPresentation(other.group)!.role('panel')), 22);
    assert.equal(peer.useful, 2); void other.preparation;
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: equal-color metadata closes strict reader without paint churn', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); c.start(); await settle(); const a = owner.groupPresentation(c.group)!;
    owner.setStyleSelection(local(7, 9)); await settle(); const b = owner.groupPresentation(c.group)!;
    assert.notEqual(a.stamp, b.stamp); assert.equal(a.paintStamp, b.paintStamp); assert.equal(a.role('panel'), undefined);
    assert.equal(a.visit(() => assert.fail('stale callback')), false); assert.equal(peer.calls.length, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: missing, equal-size changed and recreated members cannot attach stale colors', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['left']);
  try {
    owner.setStyleSelection(native()); c.start(); peer.source(0); await settle(); peer.style(1, 11); await settle(); const a = owner.groupPresentation(c.group)!;
    c.keys.delete('left'); c.keys.add('right'); assert.equal(owner.groupPresentation(c.group), undefined);
    assert.equal(owner.updatePreparation(c.group), false); assert.equal(a.role('panel'), undefined);
    c.keys.delete('right'); c.keys.add('left'); assert.equal(owner.updatePreparation(c.group), true); await settle();
    owner.remove('left'); assert.equal(owner.groupPresentation(c.group), undefined);
    c.start(); await settle(); const q = peer.calls.length - 1; assert.equal(peer.calls[q]!.op, 'highlight'); peer.source(q); await settle();
    assert.equal(owner.groupPresentation(c.group), undefined, 'recreated member needs a fresh validated style basis');
    peer.style(peer.calls.length - 1, 44); await settle();
    assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 44); assert.equal(a.visit(() => assert.fail('recreated member')), false);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: reentrant unregister invalidates all member reads and holds charged palette through unwind', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); c.start(); await settle(); const view = owner.groupPresentation(c.group)!;
    assert.equal(view.visit(() => {
      owner.unregisterPreparation(c.group); owner.setStyleSelection(undefined);
      assert.equal(view.role('panel'), undefined); assert.ok(owner.stats().retention.retainedBytes > 0);
    }), false);
    assert.equal(owner.stats().retention.retainedBytes, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: held palette selections latest-only, errors retain ready palette without warm retry', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(native()); c.start(); await settle(); peer.style(0, 11); await settle();
    owner.setStyleSelection(native(2)); await settle(); owner.setStyleSelection(native(3)); await settle();
    assert.equal(owner.stats().unsettledJobs, 2);
    for (let n = 4; n < 100; n++) owner.setStyleSelection(native(n)); await settle(); assert.equal(peer.calls.length, 3);
    peer.style(1, 22); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 11);
    assert.equal(peer.calls[3]!.rules.id, 'native99'); peer.style(2, 33); await settle(); peer.style(3, 99, true); await settle();
    for (let n = 0; n < 100; n++) owner.flush(); await settle(); assert.equal(peer.calls.length, 4);
    assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 11); assert.equal(owner.stats().sourceRecords, 0); assert.equal(peer.useful, 0);
    assert.equal(owner.stats().peakJobs, 2); owner.setEnabled(false); assert.equal(owner.groupPresentation(c.group), undefined);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: cached native and local roles progress while two source slots remain physically held', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(native()); c.start(); await settle(); peer.style(0, 11); await settle();
    owner.observe(demand('held-a')); owner.observe(demand('held-b')); owner.flush(); await settle(); assert.equal(owner.stats().unsettledJobs, 2);
    owner.setStyleSelection(local(8)); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 8);
    owner.setStyleSelection(native()); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 11);
    owner.setStyleSelection(native(2)); await settle(); assert.equal(peer.calls.length, 3);
    owner.unregisterPreparation(c.group); assert.equal(owner.stats().unsettledJobs, 2);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

function abandoned(peer: Peer) {
  const owner = new SourceController(peer), c = card(owner, []); owner.setStyleSelection(local(7)); c.start();
  return { owner: new WeakRef(owner), preparation: new WeakRef(c.preparation), group: c.group };
}
test('group presentation: first useful owner and preparation collect with escaped weak reader while peer remains active', async () => {
  const peer = new Peer(), live = new SourceController(peer), keep = card(live, []); live.setStyleSelection(local(8)); keep.start();
  const gone = abandoned(peer); await settle(); let escaped: GroupDisplayBasis | undefined = gone.owner.deref()?.groupPresentation(gone.group);
  assert.ok(escaped); assert.equal(escaped.visitStyles(() => {}), true);
    const before = live.stats().globalBookkeepingBytes;
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await settle(); if (!gone.owner.deref()) break; }
  assert.equal(gone.owner.deref(), undefined); assert.equal(gone.preparation.deref(), undefined);
  assert.equal(escaped.role('panel'), undefined); assert.equal(escaped.visitStyles(() => assert.fail('collected group emitted styles')), false);
  assert.ok(live.stats().globalBookkeepingBytes < before);
  assert.equal(ink(live.groupPresentation(keep.group)!.role('panel')), 8); escaped = undefined; void keep.preparation; await cleanup(live, peer);
});

test('display text lifetime: removal, replacement and throw hold actual text until unwind without whole-budget reuse', () => {
  for (const mode of ['remove', 'replace', 'throw']) {
    const root = new SemanticRetentionPool(), text = 'owned:' + 'x'.repeat(8192), g = root.admit('a', 1, text).generation!, vocabulary = 'a'.repeat(64);
    root.installChunk(g, { key: 'a', generation: g, source_version: 1, revision: 1, source_bytes: text.length, replace_from: 0, committed_bytes: text.length, complete: true,
      vocabulary, contexts: [Uint32Array.of(1)], runs: Uint32Array.of(text.length, 1), counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } });
    const contexts: { context: import('../../../src/occipital/context-arena.ts').ContextRef; style: ConcreteStyle }[] = [];
    root.visitContexts(g, context => contexts.push({ context, style: literal(7) }));
    assert.equal(root.publishDisplay(g, { sourceVersion: 1, semanticStamp: root.status(g)!.semanticStamp,
      presentation: { vocabulary, rules: 'b'.repeat(64), palette: 'p', bindingRevision: 1, roles: roles(7), contexts } }).accepted, true);
    const stamp = root.displayStatus(g)!.effectStamp;
    const read = () => root.visitDisplayText(g, stamp, source => {
      assert.equal(source.text, text);
      if (mode === 'replace') root.admit('a', 2, 'successor'); else root.remove(g);
      assert.ok(root.budget.stats().retainedBytes >= 2 * text.length); assert.equal(root.budget.reserve(root.budget.limit), undefined);
      if (mode === 'throw') throw new Error('consumer stopped');
    });
    if (mode === 'throw') assert.throws(read, /consumer stopped/); else assert.equal(read(), false);
    root.dispose(); assert.equal(root.budget.stats().retainedBytes, 0);
  }
});

test('group presentation: an independently completed card is not blocked by another held multi-slot selection', async () => {
  const peer = new Peer(), owner = new SourceController(peer), pair = card(owner, ['left', 'right']);
  try {
    owner.setStyleSelection(native()); pair.start(); await settle(); peer.source(0, 'x\n', 1); peer.source(1, 'x\n', 2); await settle(); peer.style(2, 11); await settle();
    owner.setStyleSelection(native(2)); await settle(); assert.equal(peer.calls[3]!.op, 'styles.resolve');
    const independent = card(owner, ['third']); independent.start(); await settle(); peer.source(4, 'x\n', 3); await settle();
    assert.equal(peer.calls[5]!.op, 'styles.resolve'); peer.style(5, 22); await settle();
    assert.deepEqual(colors(owner.groupPresentation(independent.group), ['third']), [22, 22]);
    assert.deepEqual(colors(owner.groupPresentation(pair.group), ['left', 'right']), [11, 11, 11]);
    peer.style(3, 22); await settle(); assert.deepEqual(colors(owner.groupPresentation(pair.group), ['left', 'right']), [22, 22, 22]);
    assert.equal(peer.useful, 3); void independent.preparation;
  } finally { void pair.preparation; await cleanup(owner, peer); }
});

test('group presentation: equal-color member metadata invalidates strict reads but retains paint and geometry', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['one']);
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
    const before = owner.groupPresentation(c.group)!, source = owner.displayBasis('one')!;
    owner.setStyleSelection(local(7, 9)); await settle(); const after = owner.groupPresentation(c.group)!;
    assert.notEqual(before.stamp, after.stamp); assert.equal(before.paintStamp, after.paintStamp); assert.equal(before.role('panel'), undefined);
    assert.equal(owner.displayBasis('one')!.geometryStamp, source.geometryStamp); assert.equal(owner.displayBasis('one')!.paintStamp, source.paintStamp);
    assert.deepEqual(colors(after, ['one']), [7, 7]); assert.equal(peer.calls.length, 2);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: targeted notices coalesce exact group IDs and unregister suppresses pending delivery', async () => {
  const peer = new Peer(), notices: { keys: readonly string[]; groups: readonly number[] }[] = [];
  const owner = new SourceController(peer, { onChange(keys, groups = []) { notices.push({ keys, groups }); } });
  const a = card(owner, []), b = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); a.start(); await settle(); assert.deepEqual(notices.splice(0), [{ keys: [], groups: [a.group.id] }]);
    b.start(); await settle(); assert.deepEqual(notices.splice(0), [{ keys: [], groups: [b.group.id] }]);
    owner.setStyleSelection(local(9)); owner.flush(); owner.unregisterPreparation(a.group); await settle();
    assert.deepEqual(notices.splice(0), [{ keys: [], groups: [b.group.id] }]);
    owner.setStyleSelection(local(10)); owner.flush(); owner.setEnabled(false); await settle(); assert.deepEqual(notices, []);
  } finally { void a.preparation; void b.preparation; await cleanup(owner, peer); }
});

test('group presentation: SyntaxClient weak observer forwards group-only delivery without data RPC', async () => {
  const { SyntaxClient } = await import('../../../src/occipital/client.ts');
  const notices: { keys: readonly string[]; groups: readonly number[] }[] = [];
  const client = new SyntaxClient({ standaloneVersion: '0.1.5', initialTheme: { kind: 'pi' },
    settings: { async load() { return { ok: true, syntaxTheme: { kind: 'pi' } }; }, async update() { return { ok: true }; } },
    provider: { async tryShared() { return undefined; }, async acquireOwned() { throw new Error('owned unavailable'); } },
    onSourceChange(keys, groups = []) { notices.push({ keys, groups }); } });
  try {
    await client.start(); const c = card(client.sources, []); client.sources.setStyleSelection(local(7)); c.start(); await settle();
    assert.deepEqual(notices, [{ keys: [], groups: [c.group.id] }]); assert.equal(client.broker.stats().sourceDispatches, 0); assert.equal(client.broker.stats().styleDispatches, 0);
    void c.preparation;
  } finally { await client.dispose(); }
});

test('group presentation: unregister aborts palette-only work but physical credit and config charge survive until settlement', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(native()); c.start(); await settle(); assert.equal(owner.stats().unsettledJobs, 1);
    owner.unregisterPreparation(c.group); owner.setStyleSelection(undefined);
    assert.equal(peer.signals[0]!.aborted, true); assert.equal(owner.stats().globalUnsettledJobs, 1);
    assert.ok(owner.stats().retention.retainedBytes > 0, 'physical request still owns selected declaration');
    peer.style(0, 11); await settle(); assert.equal(owner.stats().globalUnsettledJobs, 0); assert.equal(owner.stats().retention.retainedBytes, 0);
    assert.equal(owner.groupPresentation(c.group), undefined); assert.equal(peer.useful, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: escaped member ranges reject reentrant removal and keep suspended palette/member data charged', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['one']);
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
    const view = owner.groupPresentation(c.group)!;
    let read: import('../../../src/occipital/controller.ts').DisplayRangeReader | undefined;
    assert.equal(view.visit(member => { read = member('one')!.read; }), true);
    let calls = 0;
    assert.equal(read!(() => {
      calls++; owner.unregisterPreparation(c.group); owner.setStyleSelection(undefined);
      assert.ok(owner.stats().retention.retainedBytes > 0); assert.equal(view.role('panel'), undefined);
    }), false);
    assert.equal(calls, 1); assert.equal(owner.stats().retention.retainedBytes, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('controller display text lifetime: nested source callback removal retains actual text storage until unwind', async () => {
  const peer = new Peer(), owner = new SourceController(peer), text = 'text:' + 'x'.repeat(8192);
  try {
    owner.setStyleSelection(local(7)); owner.observe(demand('one', text)); owner.flush(); peer.source(0, text); await settle(); peer.style(1); await settle();
    const basis = owner.displayBasis('one')!;
    assert.equal(basis.visit(borrowed => {
      owner.remove('one'); owner.setStyleSelection(undefined);
      assert.equal(borrowed, text); assert.ok(owner.stats().retention.retainedBytes >= 2 * text.length, 'borrowed text bytes stay physically charged');
    }), false);
    assert.equal(owner.stats().retention.retainedBytes, 0);
  } finally { await cleanup(owner, peer); }
});

function ephemeralPreparation(owner: SourceController) {
  const c = card(owner, []); c.start(); return { group: c.group, preparation: new WeakRef(c.preparation) };
}
test('group presentation: collecting preparation releases its first ready role hold while controller and another group remain active', async () => {
  const peer = new Peer(), owner = new SourceController(peer), live = card(owner, []); owner.setStyleSelection(local(7)); live.start();
  const gone = ephemeralPreparation(owner); await settle(); const view = owner.groupPresentation(gone.group)!;
  try {
    const before = owner.stats().retention.retainedBytes;
    for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!gone.preparation.deref()) break; }
    assert.equal(gone.preparation.deref(), undefined); owner.refreshPreparations(); await settle();
    assert.equal(view.role('panel'), undefined); assert.ok(owner.stats().retention.retainedBytes < before);
    assert.equal(ink(owner.groupPresentation(live.group)!.role('panel')), 7);
  } finally { void live.preparation; await cleanup(owner, peer); }
});

test('group presentation: ordinary append keeps historical ready colors and same-text finalization is an identity no-op', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['bash']);
  let current = { ...demand('bash', 'x\n', 1, false), language: 'bash' };
  const preparation: SourcePreparation = { keys, prepare() { owner.observe(current); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const a = owner.groupPresentation(group)!;
    current = { ...current, version: 2, text: 'x\ny\n' }; owner.queuePreparation(group, true); owner.flush(); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]); assert.equal(a.role('panel')?.foreground.kind, 'rgb');
    peer.source(2, current.text, 2, 2, 2); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]); peer.style(3, 11); await settle();
    const before = owner.groupPresentation(group)!, basis = owner.displayBasis('bash')!;
    current = { ...current, version: 3, complete: true }; owner.queuePreparation(group, true); owner.flush(); await settle();
    assert.equal(peer.calls[4]!.op, 'stream.append'); assert.equal(peer.calls[4]!.append, ''); peer.source(4, current.text, 2, 3, 4); await settle();
    const after = owner.groupPresentation(group)!;
    assert.equal(after.stamp, before.stamp); assert.equal(after.paintStamp, before.paintStamp);
    assert.equal(owner.displayBasis('bash')!.geometryStamp, basis.geometryStamp); assert.equal(peer.calls.length, 5);
    assert.equal(owner.stats().remoteLeases, 0); assert.equal(before.visit(() => {}), true);
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: compatible provider recovery retains old coherent display until current palette replacement', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['one']);
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('one', 'x\n', 1, false), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const old = owner.groupPresentation(group)!; peer.generation = 2; owner.queuePreparation(group, true); owner.flush(); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['one']), [11, 11]);
    const q = peer.calls.length - 1; assert.equal(peer.calls[q]!.op, 'stream.open');
    owner.setStyleSelection(native(2)); peer.source(q); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['one']), [11, 11]);
    peer.style(peer.calls.length - 1, 22); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['one']), [22, 22]); assert.equal(old.role('panel'), undefined);
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: denied client config keeps previous ready palette without warm retry', async () => {
  const peer = new Peer(), owner = new SourceController(peer, { retention: { maxBytes: 20000 } }), c = card(owner, []);
  try {
    assert.equal(owner.setStyleSelection(local(7)), true); c.start(); await settle(); const view = owner.groupPresentation(c.group)!;
    assert.equal(owner.setStyleSelection(local(9)), false);
    for (let i = 0; i < 100; i++) owner.flush(); await settle();
    assert.equal(owner.groupPresentation(c.group)!.stamp, view.stamp); assert.equal(ink(view.role('panel')), 7); assert.equal(peer.calls.length, 0);
    assert.equal(owner.stats().retention.outstandingPeakBytes, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: failed cold seal never adopts partial or foreign-source membership', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); c.start(); await settle(); const old = owner.groupPresentation(c.group)!;
    owner.observe(demand('foreign')); c.keys.add('foreign');
    assert.equal(owner.updatePreparation(c.group), false); assert.equal(old.role('panel'), undefined); assert.equal(owner.groupPresentation(c.group), undefined);
    c.keys.add('missing'); assert.equal(owner.updatePreparation(c.group), false); assert.equal(owner.groupPresentation(c.group), undefined);
    c.keys.clear(); assert.equal(owner.updatePreparation(c.group), true); await settle(); assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 7);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

function abandonedNative(peer: Peer, budget: import('../../../src/occipital/data-budget.ts').DataBudget) {
  const owner = new SourceController(peer, { retention: { budget } }), c = card(owner, []);
  owner.setStyleSelection(native()); c.start(); return new WeakRef(owner);
}
test('group presentation: abandoned palette-only owner releases logical roles but held request credit/config end only on physical settlement', async () => {
  const { DataBudget } = await import('../../../src/occipital/data-budget.ts');
  const { OCCIPITAL_LIMITS } = await import('../../../src/occipital/limits.ts');
  const peer = new Peer(), observer = new SourceController(peer), budget = new DataBudget(OCCIPITAL_LIMITS.retainedBytes);
  const weak = abandonedNative(peer, budget); await settle(); assert.equal(peer.calls.length, 1);
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await settle(); if (!weak.deref()) break; }
  try {
    assert.equal(weak.deref(), undefined); assert.equal(budget.stats().closed, true); assert.ok(budget.stats().retainedBytes > 0);
    assert.equal(peer.signals[0]!.aborted, true); assert.equal(observer.stats().globalUnsettledJobs, 1);
    peer.style(0, 11); await settle(); assert.equal(observer.stats().globalUnsettledJobs, 0); assert.equal(budget.stats().retainedBytes, 0);
    console.log(JSON.stringify({ groupPaletteLifetime: { node: process.version, ownerCollected: true, physicalJobsAfterSettlement: observer.stats().globalUnsettledJobs,
      finalLogicalBytes: budget.stats().retainedBytes, sourceClassifications: peer.useful } }));
  } finally { await cleanup(observer, peer); }
});

test('group presentation: thrown preparation is not useful empty palette demand', async () => {
  const peer = new Peer(), owner = new SourceController(peer);
  let throwing = true;
  const preparation: SourcePreparation = { keys: new Set(), prepare() { if (throwing) throw new Error('not prepared'); }, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); assert.throws(() => owner.flush(), /not prepared/); await settle();
    assert.equal(owner.groupPresentation(group), undefined); assert.equal(peer.calls.length, 0);
    throwing = false; owner.queuePreparation(group, true); await settle(); assert.equal(peer.calls.length, 1); peer.style(0, 11); await settle();
    assert.equal(ink(owner.groupPresentation(group)!.role('panel')), 11);
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: palette-only owners publish newest-first through the existing shared registry', async () => {
  const peer = new Peer(), notices: number[] = [], owner = new SourceController(peer, { onChange(_keys, groups = []) { notices.push(...groups); } });
  const older = card(owner, []), newer = card(owner, []);
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(older.group, true); owner.queuePreparation(newer.group, true); owner.flush(); await settle();
    assert.equal(peer.calls.length, 1); peer.style(0, 11); await settle();
    assert.deepEqual(notices, [newer.group.id, older.group.id]); assert.equal(peer.calls.length, 1);
    assert.equal(owner.stats().sourceRecords, 0);
  } finally { void older.preparation; void newer.preparation; await cleanup(owner, peer); }
});

test('group presentation: replacement display generation cannot alias equal local effect numbers or strand the ready card', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['bash']);
  let text = 'x\n', version = 1;
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('bash', text, version, false), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const before = owner.groupPresentation(group)!;
    text = 'replacement\n'; version = 2; owner.queuePreparation(group, true); owner.flush(); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]);
    const close = peer.calls.findIndex(q => q.op === 'stream.close');
    if (close !== -1) { peer.pending[close]!.resolve(peer.envelope(close, { kind: 'closed' })); await settle(); }
    const q = peer.calls.findIndex((q, i) => i > 1 && q.op === 'stream.open'); assert.ok(q > 1); peer.source(q, text); await settle();
    const after = owner.groupPresentation(group); assert.ok(after, 'complete replacement must not keep a dead historical member receipt');
    assert.notEqual(after.stamp, before.stamp); assert.notEqual(after.paintStamp, before.paintStamp);
    assert.deepEqual(colors(after, ['bash']), [11, 11]); assert.equal(before.role('panel'), undefined);
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: first captured Bash colors remain useful when parser append overtakes held style reply', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['bash']);
  let text = 'x\n', version = 1;
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('bash', text, version, false), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle();
    text = 'x\ny\n'; version = 2; owner.queuePreparation(group, true); owner.flush(); await settle(); peer.source(2, text, 2, 2, 2); await settle();
    assert.equal(owner.groupPresentation(group), undefined); peer.style(1, 11); await settle();
    const first = owner.groupPresentation(group); assert.ok(first, 'held first validated basis remains display-only useful');
    assert.equal(first.visit(member => assert.equal(member('bash')!.version, 1)), true);
    peer.style(3, 11); await settle(); assert.equal(owner.groupPresentation(group)!.visit(member => assert.equal(member('bash')!.version, 2)), true);
    assert.equal(peer.useful, 2); assert.equal(owner.stats().styleCaptures, 0);
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: reentrant local update invalidates candidate ranges and releases overlap only after unwind', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['one']);
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
    const old = owner.groupPresentation(c.group)!, before = owner.stats().retention.retainedBytes;
    let during = 0;
    assert.equal(old.visit(member => {
      assert.equal(member('one')!.read(() => {
        owner.setStyleSelection(local(9)); owner.flush(); during = owner.stats().retention.retainedBytes;
        assert.equal(old.role('panel'), undefined); assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 9);
        assert.ok(during > before, 'old physical paint/config/member holds cannot be reused by the nested update');
      }), false);
    }), false);
    await settle(); assert.ok(owner.stats().retention.retainedBytes < during); assert.deepEqual(colors(owner.groupPresentation(c.group), ['one']), [9, 9]);
    assert.equal(peer.calls.length, 2);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: pressure cannot hide actually pinned native palette data from another useful group', async () => {
  const { DataBudget } = await import('../../../src/occipital/data-budget.ts');
  const budget = new DataBudget(100000), peer = new Peer(), owner = new SourceController(peer, { retention: { budget } }), first = card(owner, []);
  let pressure: import('../../../src/occipital/data-budget.ts').DataCharge | undefined;
  try {
    owner.setStyleSelection(native()); first.start(); await settle(); peer.style(0, 11); await settle();
    const bytes = budget.limit - budget.stats().retainedBytes - 1024, grant = budget.reserve(bytes)!; pressure = grant.consume(bytes); grant.close();
    assert.equal(owner.setStyleSelection(native(2)), true); await settle(); assert.equal(peer.calls.length, 1, 'uncached native preparation is denied before dispatch');
    assert.equal(ink(owner.groupPresentation(first.group)!.role('panel')), 11);
    pressure.release(); pressure = undefined; owner.setStyleSelection(native()); await settle();
    const second = card(owner, []); second.start(); await settle();
    assert.equal(peer.calls.length, 1, 'owned role cache remains discoverable while a useful group pins its actual charge');
    assert.equal(ink(owner.groupPresentation(second.group)!.role('panel')), 11); void second.preparation;
  } finally { pressure?.release(); void first.preparation; await cleanup(owner, peer); }
});

test('group presentation: eviction of historical member closes escaped roles even while current parser data survives', async () => {
  const { DataBudget } = await import('../../../src/occipital/data-budget.ts');
  const budget = new DataBudget(200000), peer = new Peer(), owner = new SourceController(peer, { retention: { budget } }), keys = new Set(['bash']);
  let filler: import('../../../src/occipital/data-budget.ts').DataCharge | undefined;
  let text = 'x\n', version = 1;
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('bash', text, version, false), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const old = owner.groupPresentation(group)!;
    text = 'replacement\n'; version = 2; owner.queuePreparation(group, true); owner.flush(); await settle();
    const close = peer.calls.findIndex(q => q.op === 'stream.close');
    if (close !== -1) { peer.pending[close]!.resolve(peer.envelope(close, { kind: 'closed' })); await settle(); }
    const open = peer.calls.findIndex((q, i) => i > 1 && q.op === 'stream.open'); owner.setStyleSelection(native(2)); peer.source(open, text, 2); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]); owner.borrowSource('bash');
    const free = budget.limit - budget.stats().retainedBytes, available = HIGHLIGHT_LIMITS.piSourceBytes;
    assert.ok(free > available);
    const grant = budget.reserve(free - available)!; assert.ok(grant);
    filler = grant.consume(free - available); grant.close();
    // Keep the actual pressure-triggering Pi source within its classification quota.
    const pressure = 'z'.repeat(Math.floor((available + 512 - 1100) / 2));
    assert.ok(Buffer.byteLength(pressure) <= HIGHLIGHT_LIMITS.piSourceBytes);
    assert.equal(owner.capturePiSource('pressure', 1, pressure), true);
    assert.equal(owner.status('bash')!.acknowledgedVersion, 2, 'current parser basis was not the pressure victim');
    assert.equal(owner.groupPresentation(group), undefined); assert.equal(old.role('panel'), undefined, 'evicted historical member must retire its complete palette receipt');
  } finally { filler?.release(); void preparation; await cleanup(owner, peer); }
});


test('group presentation: repeated rewrites retain the last coherent display while superseded parsed styles settle late', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['bash']);
  let text = 'x\n', version = 1;
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('bash', text, version, false), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const original = owner.groupPresentation(group)!;
    let oldMember: import('../../../src/occipital/controller.ts').GroupDisplayMember | undefined;
    assert.equal(original.visit(member => { oldMember = member('bash'); }), true);
    assert.ok(oldMember);
    text = 'replacement\n'; version = 2; owner.queuePreparation(group, true); owner.flush(); await settle();
    const closeA = peer.calls.findIndex(q => q.op === 'stream.close');
    if (closeA !== -1) { peer.pending[closeA]!.resolve(peer.envelope(closeA, { kind: 'closed' })); await settle(); }
    const openB = peer.calls.findIndex(q => q.op === 'stream.open' && q.sources?.[0]?.source_version === 2); assert.ok(openB >= 0);
    peer.source(openB, text, 2); await settle();
    const styleB = peer.calls.length - 1; assert.equal(peer.calls[styleB]!.op, 'styles.resolve');
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]);
    text = 'final replacement\n'; version = 3; owner.queuePreparation(group, true); owner.flush(); await settle();
    const retained = owner.groupPresentation(group);
    assert.ok(retained, 'parsed B without styles must not displace the last coherent A presentation during C restart');
    assert.equal(retained.stamp, original.stamp); assert.deepEqual(colors(retained, ['bash']), [11, 11]);
    assert.equal(oldMember.read(() => {}), true); assert.equal(peer.signals[styleB]!.aborted, true);
    const closeB = peer.calls.findIndex((q, index) => index > openB && q.op === 'stream.close');
    if (closeB !== -1) { peer.pending[closeB]!.resolve(peer.envelope(closeB, { kind: 'closed' })); await settle(); }
    const openC = peer.calls.findIndex(q => q.op === 'stream.open' && q.sources?.[0]?.source_version === 3); assert.ok(openC >= 0);
    peer.source(openC, text, 3); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]);
    peer.style(styleB, 22); await settle();
    assert.equal(original.role('panel') && ink(original.role('panel')), 11, 'late canceled B cannot replace the coherent group');
    const styleC = peer.calls.findIndex((q, index) => index > openC && q.op === 'styles.resolve'); assert.ok(styleC >= 0);
    peer.style(styleC, 33); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 33], 'same native definition retains its palette while the new context gets its own style');
    assert.equal(original.role('panel'), undefined); assert.equal(oldMember.read(() => assert.fail('old ranges revived')), false);
    assert.equal(original.visit(() => assert.fail('old group revived')), false);
    assert.equal(peer.useful, 3); assert.equal(owner.stats().peakJobs, 2);
    assert.equal(owner.stats().styleCaptures, 0); assert.equal(owner.stats().retention.entries, 1);
    console.log(JSON.stringify({ repeatedGroupRewrite: { sources: peer.calls.filter(q => q.op === 'stream.open').length, oldDisplayRetained: true, lateCanceledStylesRejected: true, finalRetainedEntries: owner.stats().retention.entries } }));
  } finally { void preparation; await cleanup(owner, peer); }
});

test('group presentation: compatible recovery reuses complete newer parse independently of historical display', async () => {
  const peer = new Peer(), owner = new SourceController(peer), keys = new Set(['bash']);
  let text = 'x\n', version = 1;
  const preparation: SourcePreparation = { keys, prepare() { owner.observe({ ...demand('bash', text, version), language: 'bash' }); }, requiresCredit() { return false; }, needsRefresh() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  try {
    owner.setStyleSelection(native()); owner.queuePreparation(group, true); owner.flush(); peer.source(0); await settle(); peer.style(1, 11); await settle();
    const original = owner.groupPresentation(group)!;
    text = 'replacement\n'; version = 2; owner.queuePreparation(group, true); owner.flush(); await settle();
    const parseB = peer.calls.findIndex((q, index) => index > 1 && q.op === 'highlight'); assert.ok(parseB >= 0);
    peer.source(parseB, text, 2); await settle();
    const styleB = peer.calls.length - 1; assert.equal(peer.calls[styleB]!.op, 'styles.resolve');
    const parsedGeneration = owner.status('bash')!.generation, sourceCalls = peer.calls.filter(q => q.op === 'highlight' || q.op === 'stream.open').length;
    peer.generation++; version++;
    owner.queuePreparation(group, true); owner.flush(); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 11]);
    assert.equal(owner.status('bash')!.generation, parsedGeneration, 'complete compatible B annotations are useful even before B colors');
    assert.equal(owner.status('bash')!.acknowledgedVersion, undefined, 'new provider did not acknowledge the retained parse');
    assert.equal(owner.displayBasis('bash')!.exactVersion, undefined, 'historical A colors are not current B authority');
    peer.style(styleB, 22); await settle();
    assert.equal(peer.calls.filter(q => q.op === 'highlight' || q.op === 'stream.open').length, sourceCalls, 'recovery must not parse complete B again merely to retain A colors');
    const retryStyle = peer.calls.findIndex((q, index) => index > styleB && q.op === 'styles.resolve'); assert.ok(retryStyle >= 0);
    peer.style(retryStyle, 22); await settle();
    assert.deepEqual(colors(owner.groupPresentation(group), ['bash']), [11, 22], 'compatible recovery reuses the immutable native palette');
    assert.equal(original.role('panel'), undefined); assert.equal(peer.useful, 2);
    assert.equal(owner.stats().retention.entries, 1);
  } finally { void preparation; await cleanup(owner, peer); }
});

for (const code of ['profile_changed', 'profile_unavailable'] as const) test(`native definition refusal delivers palette-only metadata notice: ${code}`, async () => {
  const peer = new Peer(), packets: { keys: readonly string[]; groups: readonly number[] }[] = [];
  const owner = new SourceController(peer, { onChange(keys, groups = []) { packets.push({ keys, groups }); } }), c = card(owner, []);
  try {
    owner.setStyleSelection(native()); c.start(); await settle(); peer.style(0, 11); await settle();
    const ready = owner.groupPresentation(c.group)!; assert.equal(ink(ready.role('panel')), 11);
    owner.setStyleSelection(native(2)); await settle(); assert.equal(peer.calls[1]!.op, 'styles.resolve'); packets.length = 0;
    peer.pending[1]!.resolve({ v: 3, ticket: peer.calls[1]!.ticket, instance: peer.description.instance, assets: peer.description.assets,
      status: 'error', error: { code, execution: 'not_started' } }); await settle();
    const need = owner.profileReconciliationNeeded(); assert.ok(need, 'palette-only definition refusal must request fresh catalogue metadata');
    assert.deepEqual(packets, [{ keys: [], groups: [c.group.id] }], 'no fake source or global empty notice may replace the exact group notification');
    assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 11); assert.equal(ready.role('panel')?.foreground.kind, 'rgb');
    owner.acknowledgeProfiles(need.generation, need.sequence); packets.length = 0;
    for (let i = 0; i < 100; i++) { owner.groupPresentation(c.group); owner.flush(); }
    await settle(); assert.equal(peer.calls.length, 2); assert.deepEqual(packets, []);
    owner.setStyleSelection(native(3)); await settle(); peer.style(2, 33); await settle();
    assert.equal(ink(owner.groupPresentation(c.group)!.role('panel')), 33); assert.equal(ready.role('panel'), undefined);
    assert.equal(peer.calls.every(call => call.op === 'styles.resolve'), true); assert.equal(peer.useful, 0);
    assert.equal(owner.stats().sourceRecords, 0); assert.equal(owner.stats().preparedBytes, 0); assert.equal(owner.stats().remoteLeases, 0);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: ready-style enumeration covers complete roles and all member literal identities without range reads', async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['left', 'right']);
  try {
    owner.setStyleSelection(native()); c.start(); await settle(); peer.source(0, 'x\n', 1); peer.source(1, 'x\n', 2); await settle(); peer.style(2, 11); await settle();
    const basis = owner.groupPresentation(c.group)!, table = new Set<ConcreteStyle>();
    assert.equal(basis.visitStyles(style => table.add(style)), true);
    for (const role of CARD_ROLES) assert.ok(table.has(basis.role(role)!));
    assert.equal(basis.visit(member => {
      for (const key of c.keys) assert.equal(member(key)!.read((_from, _to, style) => assert.ok(table.has(style))), true);
    }), true);
    const root = Reflect.get(owner, 'pool') as SemanticRetentionPool, visit = root.visitDisplay;
    root.visitDisplay = () => assert.fail('group enumeration must not traverse member ranges');
    try {
      const before = owner.stats(), calls = peer.calls.length;
      assert.equal(basis.visitStyles(style => assert.ok(table.has(style))), true);
      assert.equal(peer.calls.length, calls); assert.deepEqual(owner.stats(), before);
      owner.setStyleSelection(native(2)); await settle();
      assert.equal(basis.visitStyles(style => assert.ok(table.has(style))), true, 'pending desired theme cannot color the adopted table');
      peer.style(peer.calls.length - 1, 22); await settle();
      assert.equal(basis.visitStyles(() => assert.fail('obsolete table')), false);
      const next = owner.groupPresentation(c.group)!; assert.notEqual(next.stamp, basis.stamp);
      assert.equal(next.visitStyles(style => assert.equal(ink(style), 22)), true);
    } finally { root.visitDisplay = visit; }
  } finally { void c.preparation; await cleanup(owner, peer); }
});

for (const throws of [false, true]) test(`group presentation: palette-only style visitor stops on unregister and pins roles (throws=${throws})`, async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); c.start(); await settle(); const basis = owner.groupPresentation(c.group)!;
    let callbacks = 0, during = 0;
    const visit = () => basis.visitStyles(style => {
      callbacks++; assert.equal(style, basis.role(CARD_ROLES[0]!));
      owner.unregisterPreparation(c.group); owner.setStyleSelection(undefined);
      assert.equal(basis.visitStyles(() => assert.fail('stale nested group')), false);
      during = owner.stats().retention.retainedBytes; assert.ok(during > 0);
      if (throws) throw new Error('group table consumer failed');
    });
    if (throws) assert.throws(visit, /group table consumer failed/); else assert.equal(visit(), false);
    assert.equal(callbacks, 1); assert.equal(owner.stats().retention.retainedBytes, 0);
    assert.equal(peer.calls.length, 0); assert.equal(peer.useful, 0); assert.equal(owner.stats().sourceRecords, 0);
    assert.ok(during > 0); assert.equal(basis.visitStyles(() => assert.fail('unregistered group')), false);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

for (const throws of [false, true]) test(`group presentation: nested different-ready borrows and escaped lookups reset at unwind (throws=${throws})`, async () => {
  const peer = new Peer(), owner = new SourceController(peer), first = card(owner, ['one']), other = card(owner, []);
  try {
    owner.setStyleSelection(local(7)); first.start(); peer.source(0); await settle(); peer.style(1); await settle(); other.start(); await settle();
    const old = owner.groupPresentation(first.group)!, separate = owner.groupPresentation(other.group)!;
    let escaped: ((key: string) => import('../../../src/occipital/controller.ts').GroupDisplayMember | undefined) | undefined;
    let read: import('../../../src/occipital/controller.ts').DisplayRangeReader | undefined;
    const transaction = () => old.visit(member => {
      escaped = member; read = member('one')!.read;
      assert.equal(old.visit(nested => assert.equal(nested('one')!.read(() => {}), true)), true);
      assert.equal(separate.visit(() => {
        owner.setStyleSelection(local(9)); owner.flush();
        const next = owner.groupPresentation(first.group)!;
        assert.equal(next.visit(newMember => assert.equal(newMember('one')!.read(() => {}), true)), true);
        assert.equal(old.visit(() => assert.fail('obsolete borrow inherited validation')), false);
      }), false);
      assert.equal(read!(() => assert.fail('old ready emitted ranges')), false);
      if (throws) throw new Error('outer failed');
    });
    if (throws) assert.throws(transaction, /outer failed/); else assert.equal(transaction(), false);
    assert.equal(escaped!('one'), undefined); assert.equal(read!(() => assert.fail('escaped obsolete ranges')), false);
    const next = owner.groupPresentation(first.group)!;
    assert.equal(next.visit(member => { escaped = member; read = member('one')!.read; }), true);
    assert.equal(read!(() => {}), true, 'standalone current reader remains supported');
    first.keys.delete('one'); first.keys.add('changed');
    assert.equal(escaped!('one'), undefined, 'standalone lookup validates the whole actual membership after unwind');
    assert.equal(read!(() => assert.fail('mutated standalone membership')), false);
    first.keys.clear(); first.keys.add('one'); assert.equal(owner.updatePreparation(first.group), true);
    assert.equal(read!(() => {}), true, 'a boundary probe must not destroy an otherwise unchanged ready publication');
    assert.equal(peer.calls.length, 2);
  } finally { void first.preparation; void other.preparation; await cleanup(owner, peer); }
});

for (const mode of ['remove', 'replace', 'off', 'dispose', 'pressure', 'throw'] as const) test(`group presentation: active nested source borrow guards invalidation and charged unwind (${mode})`, async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['one']);
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0, 'x\n', 1, 1, 0, true); await settle(); peer.style(1); await settle();
    const view = owner.groupPresentation(c.group)!;
    let callbacks = 0;
    const visit = () => view.visit(member => {
      assert.equal(view.visit(() => {
        const valid = member('one')!.read(() => {
          callbacks++;
          if (mode === 'dispose') owner.dispose();
          else if (mode === 'off') owner.setEnabled(false);
          else if (mode === 'replace') { owner.remove('one'); c.start(); }
          else if (mode === 'pressure') {
            const root = Reflect.get(owner, 'pool') as SemanticRetentionPool;
            assert.equal(owner.geometryFunding()!.grant(root.budget.limit), undefined, 'real pressure cannot reuse the suspended source and group charges');
            assert.equal(owner.status('one')!.generation, undefined, 'real eviction revoked the source incarnation');
          } else owner.remove('one');
          owner.setStyleSelection(undefined);
          assert.ok(owner.stats().retention.retainedBytes > 0, 'suspended group and source storage are still charged');
          assert.equal(view.role('panel'), undefined); assert.equal(member('one'), undefined);
          if (mode === 'throw') throw new Error('range failed');
        });
        assert.equal(valid, false);
      }), false);
    });
    if (mode === 'throw') assert.throws(visit, /range failed/); else assert.equal(visit(), false);
    assert.equal(callbacks, 1); assert.equal(view.visit(() => assert.fail('retired borrow')), false);
  } finally { void c.preparation; await cleanup(owner, peer); }
});

test('group presentation: ready member collection funding denial is atomic and does not retry warm reads', async () => {
  const { DataBudget } = await import('../../../src/occipital/data-budget.ts');
  const budget = new DataBudget(200000), peer = new Peer(), owner = new SourceController(peer, { retention: { budget } }), c = card(owner, ['one']);
  const reserve = DataBudget.prototype.reserve;
  let denials = 0;
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
    const old = owner.groupPresentation(c.group)!, source = owner.displayBasis('one')!, bytes = 1024 + 512 + 2 * 'one'.length;
    DataBudget.prototype.reserve = function(n) { if (this === budget && n === bytes) { denials++; return undefined; } return reserve.call(this, n); };
    owner.setStyleSelection(local(9)); await settle();
    assert.equal(denials, 1); assert.equal(owner.groupPresentation(c.group)!.stamp, old.stamp);
    assert.equal(owner.displayBasis('one')!.stamp, source.stamp); assert.deepEqual(colors(old, ['one']), [7, 7]);
    const before = owner.stats();
    for (let i = 0; i < 100; i++) { owner.flush(); assert.deepEqual(colors(owner.groupPresentation(c.group), ['one']), [7, 7]); }
    await settle(); assert.equal(denials, 1); assert.equal(owner.stats().stylePreparations, before.stylePreparations);
    assert.equal(budget.stats().outstandingPeakBytes, 0); assert.equal(peer.calls.length, 2);
    console.log(JSON.stringify({ groupReadyCollectionDenial: { denials, readyUnchanged: true, sourceUnchanged: true, warmRetries: 0, outstandingBytes: budget.stats().outstandingPeakBytes } }));
  } finally { DataBudget.prototype.reserve = reserve; void c.preparation; await cleanup(owner, peer); }
});

async function abandonedMember(peer: Peer) {
  const owner = new SourceController(peer), c = card(owner, ['first']);
  owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
  let read: import('../../../src/occipital/controller.ts').DisplayRangeReader | undefined;
  owner.groupPresentation(c.group)!.visit(member => { read = member('first')!.read; });
  return { owner: new WeakRef(owner), preparation: new WeakRef(c.preparation), read: read!, budget: (Reflect.get(owner, 'pool') as SemanticRetentionPool).budget };
}
test('group presentation: escaped first member reader keeps no owner or preparation alive beside active peer', async () => {
  const peer = new Peer(), gone = await abandonedMember(peer), live = new SourceController(peer), c = card(live, []);
  try {
    live.setStyleSelection(local(8)); c.start(); await settle(); assert.equal(gone.read(() => {}), true);
    for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await settle(); if (!gone.owner.deref()) break; }
    assert.equal(gone.owner.deref(), undefined); assert.equal(gone.preparation.deref(), undefined);
    assert.equal(gone.budget.stats().retainedBytes, 0); assert.equal(gone.budget.stats().outstandingPeakBytes, 0);
    assert.equal(gone.read(() => assert.fail('collected source emitted ranges')), false);
    assert.equal(ink(live.groupPresentation(c.group)!.role('panel')), 8);
    console.log(JSON.stringify({ escapedGroupMemberGC: { ownerCollected: true, preparationCollected: true, livePeer: true, finalRetainedBytes: gone.budget.stats().retainedBytes, finalOutstandingBytes: gone.budget.stats().outstandingPeakBytes } }));
  } finally { void c.preparation; await cleanup(live, peer); }
});

for (const site of ['visit', 'ranges', 'styles'] as const) test(`group presentation: unchanged ready borrow resets after ${site} throws and validates standalone and outer boundaries`, async () => {
  const peer = new Peer(), owner = new SourceController(peer), c = card(owner, ['one']);
  try {
    owner.setStyleSelection(local(7)); c.start(); peer.source(0); await settle(); peer.style(1); await settle();
    const view = owner.groupPresentation(c.group)!;
    let read: import('../../../src/occipital/controller.ts').DisplayRangeReader | undefined;
    view.visit(member => { read = member('one')!.read; });
    const fail = () => { throw new Error('same ready failed'); };
    assert.throws(() => site === 'visit' ? view.visit(fail) : site === 'styles' ? view.visitStyles(fail) : read!(fail), /same ready failed/);
    assert.equal(read!(() => {}), true);
    assert.equal(view.visit(() => { c.keys.delete('one'); c.keys.add('changed'); }), false, 'outer unwind rechecks ordered membership even at equal size');
    assert.equal(read!(() => assert.fail('trusted state escaped unwind')), false);
    c.keys.clear(); c.keys.add('one'); assert.equal(read!(() => {}), true);
  } finally { void c.preparation; await cleanup(owner, peer); }
});
