import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { SemanticRetentionPool, type ReadyDisplayCandidate, type ReadyPresentation } from '../../../src/occipital/semantic-retention.ts';
import { CARD_ROLES, decodeContextBatch, decodeStyleResult, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { SemanticRanges, type SemanticRangeView } from '../../../src/occipital/semantic-ranges.ts';
import type { ContextRef } from '../../../src/occipital/context-arena.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/vectors.json', import.meta.url), 'utf8'));
const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64);
const paths = decodeContextBatch([vectors.contexts[0].encoded], { vocabularySize: vectors.vocabulary_size, maxBytes: 1 << 20 }).batches[0]!;
const fixture = vectors.styles.find((value: { name: string }) => value.name === 'literal-binding-inherit-and-explicit-clear');
const decoded = decodeStyleResult(fixture.body, { vocabulary, rules, bindingSlots: fixture.binding_slots }, fixture.context_count, 1 << 20);
const indexedFixture = vectors.styles.find((value: { name: string }) => value.name === 'indexed-is-not-guessed-rgb');
const indexed = decodeStyleResult(indexedFixture.body, { vocabulary, rules, bindingSlots: indexedFixture.binding_slots }, indexedFixture.context_count, 1 << 20);
const caller: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const oldStyle = materializeStyle(decoded.styles[0]!, [], caller), nextStyle = materializeStyle(indexed.styles[0]!, [], caller);
function source(key: string, generation: number, revision = 1): SemanticChunk {
  return { vocabulary, key, generation, revision, source_version: revision, lease: 'lease', source_bytes: revision === 1 ? 3 : 4,
    replace_from: revision === 1 ? 0 : 2, committed_bytes: 2, complete: false,
    contexts: revision === 1 ? [paths[1]!, paths[2]!] : [paths[3]!], runs: revision === 1 ? new Uint32Array([2, 1, 3, 2]) : new Uint32Array([4, 1]),
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
}
function refs(pool: SemanticRetentionPool, generation: number) {
  const values = new Set<ContextRef>(); pool.visitRanges(generation, (_a, _b, context) => { if (context) values.add(context); }); return [...values];
}
function presentation(contexts: readonly ContextRef[], next: boolean): ReadyPresentation {
  const style = next ? nextStyle : oldStyle;
  return { vocabulary, rules: next ? 'd'.repeat(64) : rules, palette: next ? 'palette:next' : 'palette:old', bindingRevision: next ? 2 : 1,
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, structuredClone(style)])) as Record<CardRole, ConcreteStyle>,
    contexts: contexts.map(context => ({ context, style: structuredClone(style) })) };
}
function candidate(pool: SemanticRetentionPool, generation: number, next = true): ReadyDisplayCandidate {
  const status = pool.status(generation)!;
  return { sourceVersion: status.sourceVersion!, semanticStamp: status.semanticStamp, presentation: presentation(refs(pool, generation), next) };
}
function pane(pool: SemanticRetentionPool, key: string) {
  const generation = pool.admit(key, 1, 'a\nb').generation!;
  assert.equal(pool.installChunk(generation, source(key, generation)).accepted, true);
  const initial = candidate(pool, generation, false);
  assert.equal(pool.publishDisplay(generation, initial).accepted, true);
  return { generation, key, initial };
}
function painted(pool: SemanticRetentionPool, generation: number) {
  const status = pool.displayStatus(generation)!; assert.ok(status);
  const rows: ConcreteStyle[] = [];
  assert.equal(pool.visitDisplay(generation, status.effectStamp, (_a, _b, _id, style) => rows.push(style)), true);
  return { status, text: pool.borrowDisplay(generation, status.effectStamp)!.text,
    service: pool.displayRole(generation, status.effectStamp, 'output'), rows };
}
function pair(maxBytes?: number) {
  const pool = new SemanticRetentionPool(maxBytes ? { maxBytes } : {});
  return { pool, panes: [pane(pool, 'old'), pane(pool, 'next')] };
}

test('batch display: sequential public calls expose mixed service/syntax colors if a later pane is stale', () => {
  const { pool, panes } = pair(), [a, b] = panes;
  assert.equal(pool.publishDisplay(a!.generation, candidate(pool, a!.generation)).accepted, true);
  const later = candidate(pool, b!.generation);
  assert.equal(pool.publishDisplay(b!.generation, { ...later, semanticStamp: later.semanticStamp + 1 }).accepted, false);
  assert.deepEqual(painted(pool, a!.generation).service, nextStyle); assert.deepEqual(painted(pool, b!.generation).service, oldStyle);
  assert.deepEqual(painted(pool, a!.generation).rows[0], nextStyle); assert.deepEqual(painted(pool, b!.generation).rows[0], oldStyle);
  console.log(JSON.stringify({ sequentialPartial: { earlierAccepted: true, laterAccepted: false, mixed: true } })); pool.dispose();
});

test('batch display: mixed historical/current panes switch all service roles and syntax together', () => {
  const { pool, panes } = pair(); const historical = { ...panes[0]!.initial, presentation: presentation(panes[0]!.initial.presentation.contexts.map(pair => pair.context), true) };
  for (const p of panes) { pool.replaceSnapshot(p.generation, 2, 'a\nbc'); pool.installChunk(p.generation, source(p.key, p.generation, 2)); }
  const before = panes.map(p => painted(pool, p.generation));
  const result = pool.publishDisplays([{ generation: panes[0]!.generation, candidate: historical },
    { generation: panes[1]!.generation, candidate: candidate(pool, panes[1]!.generation) }]);
  assert.equal(result.accepted, true);
  const after = panes.map(p => painted(pool, p.generation));
  assert.deepEqual(after.map(p => p.text), ['a\nb', 'a\nbc']);
  assert.equal(after[0]!.status.geometryStamp, before[0]!.status.geometryStamp);
  assert.notEqual(after[1]!.status.geometryStamp, before[1]!.status.geometryStamp);
  for (const p of after) { assert.deepEqual(p.service, nextStyle); assert.ok(p.rows.every(style => JSON.stringify(style) === JSON.stringify(nextStyle))); }
  pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('batch display: stale, duplicate, incomplete, foreign and incoherent later slots never publish earlier slots', () => {
  const { pool, panes } = pair(), foreign = new SemanticRetentionPool(), other = pane(foreign, 'foreign');
  const good = panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }));
  const a = good[0]!, b = good[1]!, before = panes.map(p => painted(pool, p.generation));
  const badRoles = { ...b.candidate.presentation.roles }; delete (badRoles as Partial<typeof badRoles>).frame;
  const variants = [
    [a, { ...b, candidate: { ...b.candidate, semanticStamp: b.candidate.semanticStamp + 1 } }],
    [a, { ...b, candidate: { ...b.candidate, sourceVersion: 99 } }], [a, a],
    [a, { ...b, candidate: { ...b.candidate, presentation: { ...b.candidate.presentation, roles: badRoles } } }],
    [a, { ...b, candidate: { ...b.candidate, presentation: { ...b.candidate.presentation, contexts: [{ context: refs(foreign, other.generation)[0]!, style: nextStyle }] } } }],
    [a, { ...b, candidate: { ...b.candidate, presentation: { ...b.candidate.presentation, contexts: [b.candidate.presentation.contexts[0]!, b.candidate.presentation.contexts[0]!] } } }],
    ...(['rules', 'palette', 'bindingRevision'] as const).map(field => [a, { ...b, candidate: { ...b.candidate,
      presentation: { ...b.candidate.presentation, [field]: field === 'bindingRevision' ? 99 : 'f'.repeat(64) } } }]),
  ];
  for (const entries of variants) {
    assert.equal(pool.publishDisplays(entries).accepted, false);
    assert.deepEqual(panes.map(p => painted(pool, p.generation)), before);
    assert.equal(pool.stats().rangeViews, 2);
  }
  pool.remove(b.generation);
  assert.equal(pool.publishDisplays(good).accepted, false);
  assert.deepEqual(painted(pool, a.generation), before[0]); assert.equal(pool.displayStatus(b.generation), undefined);
  assert.equal(pool.borrowSnapshot(a.generation)!.text, 'a\nb');
  foreign.dispose(); pool.dispose();
});

test('batch display: aggregate peak refusal preserves all protected panes and returns every unrelated pressure receipt', () => {
  const { pool, panes } = pair(40000), control = pair(40000);
  pool.admit('peer1', 1, 'peer'); pool.admit('peer2', 1, 'peer');
  const before = panes.map(p => painted(pool, p.generation)), updates = panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }));
  const OriginalMap = globalThis.Map, OriginalSet = globalThis.Set; let maps = 0, sets = 0;
  globalThis.Map = new Proxy(OriginalMap, { construct(target, args) { maps++; return Reflect.construct(target, args); } });
  globalThis.Set = new Proxy(OriginalSet, { construct(target, args) { sets++; return Reflect.construct(target, args); } });
  let result;
  try { result = pool.publishDisplays(updates); } finally { globalThis.Map = OriginalMap; globalThis.Set = OriginalSet; }
  assert.equal(result.accepted, false); assert.deepEqual(result.released.map(receipt => receipt.key), ['peer1', 'peer2']);
  assert.equal(maps, 0); assert.equal(sets, 0);
  assert.deepEqual(panes.map(p => painted(pool, p.generation)), before); assert.equal(pool.stats().entries, 2);
  const singles = control.panes.map(p => control.pool.publishDisplay(p.generation, candidate(control.pool, p.generation)).accepted);
  assert.deepEqual(singles, [true, true], 'each candidate fits separately at the exact same fixed budget');
  console.log(JSON.stringify({ batchDenial: { batchAccepted: result.accepted, singles, receipts: result.released.map(r => r.key), maps, sets, retainedBytes: pool.stats().retainedBytes } }));
  pool.dispose(); control.pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('batch display: successful aggregate funding returns unrelated evictions without releasing protected sources', () => {
  const { pool, panes } = pair(50000);
  pool.admit('peer1', 1, 'x'.repeat(5000)); pool.admit('peer2', 1, 'x'.repeat(5000));
  const result = pool.publishDisplays(panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) })));
  assert.equal(result.accepted, true); assert.deepEqual(result.released.map(receipt => receipt.key), ['peer1', 'peer2']);
  for (const p of panes) assert.deepEqual(painted(pool, p.generation).service, nextStyle);
  assert.equal(pool.stats().entries, 2); assert.ok(pool.stats().retainedBytes <= 50000); pool.dispose();
});

test('batch display: theme groups read no committed prefix and equal metadata invalidates tokens without paint/geometry changes', () => {
  const pool = new SemanticRetentionPool(), Original = globalThis.Uint32Array;
  let prefixReads = 0;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) {
    const array = Reflect.construct(target, args);
    return new Proxy(array, { get(value, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) prefixReads++;
      const result = Reflect.get(value, property, value); return typeof result === 'function' ? result.bind(value) : result;
    } });
  } });
  let panes;
  try { panes = [pane(pool, 'old'), pane(pool, 'next')]; } finally { globalThis.Uint32Array = Original; }
  const updates = panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }));
  const before = panes.map(p => pool.displayStatus(p.generation)!); prefixReads = 0;
  assert.equal(pool.publishDisplays(updates).accepted, true); assert.equal(prefixReads, 0);
  const after = panes.map(p => pool.displayStatus(p.generation)!);
  assert.deepEqual(after.map(p => p.geometryStamp), before.map(p => p.geometryStamp));
  assert.ok(after.every((p, index) => p.effectStamp !== before[index]!.effectStamp));
  const metadata = updates.map(update => ({ ...update, candidate: { ...update.candidate,
    presentation: { ...update.candidate.presentation, rules: 'f'.repeat(64), bindingRevision: 3 } } }));
  let calls = 0;
  assert.equal(pool.visitDisplay(panes[0]!.generation, after[0]!.effectStamp, () => { calls++; assert.equal(pool.publishDisplays(metadata).accepted, true); }), false);
  assert.equal(calls, 1);
  const equal = panes.map(p => pool.displayStatus(p.generation)!);
  assert.deepEqual(equal.map(p => [p.geometryStamp, p.effectStamp]), after.map(p => [p.geometryStamp, p.effectStamp]));
  // The publication measurement excludes the explicit traversal immediately above.
  prefixReads = 0; assert.equal(pool.publishDisplays(metadata).accepted, true);
  const groupPrefixReads = prefixReads; assert.equal(groupPrefixReads, 0);
  panes.forEach(p => painted(pool, p.generation)); assert.ok(prefixReads > 0);
  console.log(JSON.stringify({ batchPrefix: { groupPrefixReads, positiveVisitReads: prefixReads, calls, views: pool.stats().rangeViews } })); pool.dispose();
});

test('batch display: a card may exceed the native RPC eight-source cap and owns no persistent group registry', () => {
  const pool = new SemanticRetentionPool(), panes = Array.from({ length: 12 }, (_, index) => pane(pool, `segment${index}`));
  assert.equal(pool.publishDisplays(panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }))).accepted, true);
  assert.equal(pool.stats().rangeViews, 12); for (const p of panes) assert.deepEqual(painted(pool, p.generation).service, nextStyle);
  assert.equal(pool.publishDisplays([]).accepted, true); pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('batch display: suspended group visit does not retain retired owned lookups or snapshots after budget reuse', async () => {
  const pool = new SemanticRetentionPool(), set = Map.prototype.set, maps: WeakRef<object>[] = [], snapshots: WeakRef<object>[] = [];
  Map.prototype.set = function<K, V>(key: K, value: V): Map<K, V> {
    if (typeof key === 'number' && value && typeof value === 'object' && 'basis' in value) snapshots.push(new WeakRef((value as { basis: object }).basis));
    if (key && typeof key === 'object' && 'id' in key && value && typeof value === 'object' && 'foreground' in value) maps.push(new WeakRef(this));
    return set.call(this, key, value) as Map<K, V>;
  };
  let panes;
  try { panes = [pane(pool, 'old'), pane(pool, 'next')]; } finally { Map.prototype.set = set; }
  const updates = panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }));
  const status = pool.displayStatus(panes[0]!.generation)!;
  await turn(); // No weak deref between construction and this real host turn.
  let calls = 0;
  assert.equal(pool.visitDisplay(panes[0]!.generation, status.effectStamp, () => {
    calls++; assert.equal(pool.publishDisplays(updates).accepted, true);
    panes.forEach(p => pool.remove(p.generation));
    assert.ok(pool.stats().retainedBytes > 0, 'suspended range/literal storage remains charged');
    assert.equal(pool.reserve(undefined, pool.stats().maxBytes).accepted, false);
    global.gc!(); global.gc!();
    const mapsCollected = maps.every(ref => ref.deref() === undefined), snapshotsCollected = snapshots.every(ref => ref.deref() === undefined);
    assert.ok(maps.length >= 2); assert.ok(snapshots.length >= 2); assert.equal(mapsCollected, true); assert.equal(snapshotsCollected, true);
    console.log(JSON.stringify({ batchGC: { mapsCollected, snapshotsCollected, retainedBytes: pool.stats().retainedBytes, calls } }));
  }), false);
  assert.equal(calls, 1); assert.equal(pool.stats().retainedBytes, 0);
  assert.equal(pool.reserve(undefined, pool.stats().maxBytes).accepted, true); pool.dispose();
});

test('batch display: a denied later capture releases earlier staged captures without committing any pane', () => {
  const { pool, panes } = pair();
  for (const p of panes) { pool.replaceSnapshot(p.generation, 2, 'a\nbc'); pool.installChunk(p.generation, source(p.key, p.generation, 2)); }
  const updates = panes.map(p => ({ generation: p.generation, candidate: candidate(pool, p.generation) }));
  const before = panes.map(p => painted(pool, p.generation)), charged = pool.stats(), capture = SemanticRanges.prototype.captureView;
  let grants = 0, temporary: SemanticRangeView | undefined;
  SemanticRanges.prototype.captureView = function(reserve) {
    const view = capture.call(this, peak => {
      if (!reserve(peak)) return false; // Metadata-only preflight is not a hold.
      return ++grants !== 2;
    });
    if (view) temporary = view;
    return view;
  };
  let result;
  try { result = pool.publishDisplays(updates); } finally { SemanticRanges.prototype.captureView = capture; }
  assert.equal(result.accepted, false); assert.equal(grants, 2); assert.ok(temporary);
  assert.deepEqual(panes.map(p => painted(pool, p.generation)), before); assert.deepEqual(pool.stats(), charged);
  let visits = 0; temporary.visit(() => { visits++; }); assert.equal(visits, 0, 'temporary view was actually released, not just omitted from counters');
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
  console.log(JSON.stringify({ batchRollback: { attemptedGrants: grants, releasedTemporaryVisits: visits, retainedAfterClear: pool.stats().retainedBytes } }));
});
