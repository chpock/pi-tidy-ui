import '../../fixtures/test-guard.mjs';
import { installProjection, visitProjection, projectionRanges } from '../../fixtures/pi-projection.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { SemanticRetentionPool, type ReadyPresentation } from '../../../src/occipital/semantic-retention.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { CARD_ROLES, decodeStyleResult, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64);
const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/vectors.json', import.meta.url), 'utf8'));
const fixture = vectors.styles.find((v: { name: string }) => v.name === 'literal-binding-inherit-and-explicit-clear');
const decoded = decodeStyleResult(fixture.body, { vocabulary, rules, bindingSlots: fixture.binding_slots }, fixture.context_count, 1 << 20);
const base: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const literal = materializeStyle(decoded.styles[0]!, [], base);
function source(key: string, generation: number, revision = 1, complete = false, tail = 2): SemanticChunk {
  return { vocabulary, key, generation, revision, source_version: revision, ...(!complete ? { lease: 'lease' } : {}),
    source_bytes: revision * 2 + 1, replace_from: (revision - 1) * 2, committed_bytes: complete ? revision * 2 + 1 : revision * 2, complete,
    contexts: [new Uint32Array([1]), new Uint32Array([tail])], runs: new Uint32Array([revision * 2, 1, revision * 2 + 1, 2]),
    counters: { committed_line_calls: 1, committed_line_bytes: 2, tail_calls: 1, tail_bytes: 1 } };
}
function add(pool: SemanticRetentionPool, key = 'a', complete = false) {
  const generation = pool.admit(key, 1, 'x\nx').generation!; assert.equal(pool.installChunk(generation, source(key, generation, 1, complete)).accepted, true); return generation;
}
function advance(pool: SemanticRetentionPool, generation: number, revision: number, tail = 3) {
  const key = pool.status(generation)!.key; pool.replaceSnapshot(generation, revision, 'x\n'.repeat(revision) + 'x');
  assert.equal(pool.installChunk(generation, source(key, generation, revision, false, tail)).accepted, true);
}
function presentation(refs: Parameters<SemanticRetentionPool['arena']['retain']>[0], bindingRevision = 1): ReadyPresentation {
  return { vocabulary, rules, palette: 'palette:test', bindingRevision,
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, structuredClone(literal)])) as Record<CardRole, ConcreteStyle>,
    contexts: refs.map(context => ({ context, style: structuredClone(literal) })) };
}
function updates(group: NonNullable<ReturnType<SemanticRetentionPool['captureDisplays']>['group']>, binding = 1) {
  return group.captures.map(capture => {
    const refs: Parameters<typeof presentation>[0][number][] = [];
    assert.equal(capture.visitContexts(ref => refs.push(ref)), true);
    return { generation: capture.generation, candidate: { capture, semanticStamp: capture.semanticStamp, sourceVersion: capture.sourceVersion, presentation: presentation(refs, binding) } };
  });
}
function acquire(pool: SemanticRetentionPool, generations: readonly number[]) {
  let grants = 0, bytes = 0;
  const admitted = pool.captureDisplays(generations, needed => { grants++; bytes = needed; return true; });
  assert.equal(admitted.accepted, true); assert.equal(grants, 1); assert.equal(admitted.reservationBytes, bytes);
  assert.ok(bytes > 0); assert.ok(admitted.group); return admitted.group;
}

test('job capture: first V1 colors publish after repeated V2/V3 parsing without rewinding authority; transfer releases exactly once', () => {
  const pool = new SemanticRetentionPool(), generation = add(pool), before = pool.stats(), group = acquire(pool, [generation]);
  const captured = updates(group); advance(pool, generation, 2); advance(pool, generation, 3, 4); const progress = pool.status(generation)!;
  assert.equal(pool.publishDisplays(captured).accepted, true);
  assert.equal(pool.displayStatus(generation)!.sourceVersion, 1); assert.equal(pool.borrowDisplay(generation, pool.displayStatus(generation)!.effectStamp)!.text, 'x\nx');
  for (const key of ['basisVersion', 'latestVersion', 'vocabulary', 'semanticStamp', 'revision', 'displayRevision', 'sourceVersion', 'sourceBytes', 'complete', 'committedChunks'] as const)
    assert.equal(pool.status(generation)![key], progress[key], `ready adoption must not change parser ${key}`);
  assert.equal(pool.borrowSnapshot(generation)!.text, 'x\n'.repeat(3) + 'x');
  const overlap = pool.stats(); assert.equal(overlap.rangeViews, 2);
  group.release(); const released = pool.stats(); assert.equal(released.rangeViews, 1); assert.equal(overlap.rangeBytes - released.rangeBytes, 256);
  group.release(); assert.deepEqual(pool.stats(), released); assert.equal(group.captures[0]!.visitContexts(() => assert.fail('released')), false);
  assert.equal(pool.publishDisplays(captured).accepted, false); pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
  console.log(JSON.stringify({ jobTransfer: { beforeBytes: before.retainedBytes, overlapBytes: overlap.retainedBytes, afterCaptureRelease: released.retainedBytes, reservation: group.reservationBytes, parserVersion: progress.sourceVersion, displayVersion: 1, finalBytes: pool.stats().retainedBytes } }));
});

test('job capture: newer ready refuses old capture and retired parser does not erase eligible first historical colors', () => {
  const pool = new SemanticRetentionPool(), generation = add(pool), old = acquire(pool, [generation]), oldUpdates = updates(old);
  advance(pool, generation, 2); const next = acquire(pool, [generation]); assert.equal(pool.publishDisplays(updates(next)).accepted, true);
  const display = pool.displayStatus(generation); assert.equal(pool.publishDisplays(oldUpdates).accepted, false); assert.deepEqual(pool.displayStatus(generation), display);
  old.release(); next.release(); pool.clear();
  const g = add(pool), first = acquire(pool, [g]);
  for (let i = 2; i <= 8; i++) advance(pool, g, i);
  pool.replaceSnapshot(g, 9, 'x\n'.repeat(9) + 'x');
  assert.equal(pool.installChunk(g, { ...source('a', g), vocabulary: 'd'.repeat(64), source_version: 9, source_bytes: 19, committed_bytes: 18, contexts: [Uint32Array.of(8), Uint32Array.of(9)], runs: Uint32Array.of(18, 1, 19, 2) }, undefined, true).accepted, true);
  assert.equal(pool.publishDisplays(updates(first)).accepted, true); assert.equal(pool.status(g)!.sourceVersion, 9);
  assert.equal(pool.status(g)!.vocabulary, 'd'.repeat(64)); assert.equal(pool.displayStatus(g)!.vocabulary, vocabulary);
  assert.equal(pool.stats().rangeBlocks, 2, 'retired capture keeps only its one prefix block, not seven unseen successors');
  first.release(); pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('job capture: complete finite group publishes union atomically; later stale/foreign/coverage/selection errors publish nothing', () => {
  const pool = new SemanticRetentionPool(), a = add(pool, 'a', true), b = add(pool, 'b', true), group = acquire(pool, [a, b]);
  const ready = updates(group); assert.equal(pool.publishDisplays(ready).accepted, true);
  const before = [pool.displayStatus(a), pool.displayStatus(b)];
  const stale = updates(group, 2); stale[1]!.candidate.sourceVersion++; assert.equal(pool.publishDisplays(stale).accepted, false);
  const coverage = updates(group, 2); coverage[1]!.candidate.presentation = { ...coverage[1]!.candidate.presentation, contexts: [] }; assert.equal(pool.publishDisplays(coverage).accepted, false);
  const namespace = updates(group, 2); namespace[1]!.candidate.presentation = { ...namespace[1]!.candidate.presentation, vocabulary: 'd'.repeat(64) }; assert.equal(pool.publishDisplays(namespace).accepted, false);
  const incoherent = updates(group, 2); incoherent[1]!.candidate.presentation = { ...incoherent[1]!.candidate.presentation, bindingRevision: 3 }; assert.equal(pool.publishDisplays(incoherent).accepted, false);
  const missingRole = updates(group, 2); missingRole[1]!.candidate.presentation = { ...missingRole[1]!.candidate.presentation, roles: { ...missingRole[1]!.candidate.presentation.roles, code: undefined! } }; assert.equal(pool.publishDisplays(missingRole).accepted, false);
  assert.equal(pool.publishDisplays(ready.slice(0, 1)).accepted, false, 'a group cannot publish a subset');
  assert.deepEqual([pool.displayStatus(a), pool.displayStatus(b)], before);
  const foreign = new SemanticRetentionPool(), fa = add(foreign, 'a', true), fb = add(foreign, 'b', true); assert.equal(foreign.publishDisplays(ready).accepted, false);
  assert.equal(foreign.displayStatus(fa), undefined); assert.equal(foreign.displayStatus(fb), undefined);
  const forged = updates(group); forged[1]!.candidate.capture = Object.create(Object.getPrototypeOf(group.captures[1]!)); assert.equal(pool.publishDisplays(forged).accepted, false);
  group.release(); foreign.dispose(); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('job capture: aggregate retained publication peak denial returns all unrelated receipts and preserves both panes', () => {
  const pool = new SemanticRetentionPool({ maxBytes: 45000 }), a = add(pool, 'a', true), b = add(pool, 'b', true), group = acquire(pool, [a, b]);
  const old = updates(group); assert.equal(pool.publishDisplays(old).accepted, true);
  pool.admit('peer1', 1, 'x'); pool.admit('peer2', 1, 'x');
  const pending = updates(group, 2), before = [pool.displayStatus(a), pool.displayStatus(b)];
  for (const update of pending) update.candidate.presentation = { ...update.candidate.presentation,
    contexts: update.candidate.presentation.contexts.map(pair => ({ context: pair.context, style: { ...pair.style, attributes: pair.style.attributes ^ 1 } })),
    roles: Object.fromEntries(CARD_ROLES.map((role, i) => [role, { ...update.candidate.presentation.roles[role], attributes: i % 16 }])) as Record<CardRole, ConcreteStyle> };
  const beforePublication = pool.stats().retainedBytes;
  const result = pool.publishDisplays(pending); assert.equal(result.accepted, false); assert.deepEqual(result.released.map(r => r.key), ['peer1', 'peer2']);
  assert.deepEqual([pool.displayStatus(a), pool.displayStatus(b)], before);
  console.log(JSON.stringify({ jobGroupPressure: { beforePublication, afterRefusal: pool.stats().retainedBytes, released: result.released.map(r => r.key), protectedEntries: pool.stats().entries } }));
  group.release(); pool.dispose();
});

test('job capture: denied acquisition, duplicate/uninitialized/partial group and reentrant removal do not leave holds', () => {
  const pool = new SemanticRetentionPool(), a = add(pool), b = add(pool, 'b', true), empty = pool.admit('empty', 1, '').generation!, before = pool.stats(); let grants = 0;
  for (const generations of [[b, b], [a, b], [empty], [999]]) assert.equal(pool.captureDisplays(generations, () => { grants++; return true; }).accepted, false);
  assert.equal(grants, 0);
  const denied = pool.captureDisplays([a], () => { grants++; return false; }); assert.equal(denied.accepted, false); assert.equal(grants, 1); assert.deepEqual(pool.stats(), before);
  const accepted = pool.captureDisplays([a], () => { pool.remove(a); return true; }); assert.equal(accepted.accepted, false); assert.equal(pool.stats().rangeViews, 0);
  pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

function heldRoot() {
  const pool = new SemanticRetentionPool({ maxBytes: 100000 }), generation = add(pool), initial = acquire(pool, [generation]);
  for (let i = 2; i <= 30; i++) advance(pool, generation, i, 3);
  const later = acquire(pool, [generation]);
  pool.replaceSnapshot(generation, 31, 'x\n'.repeat(31) + 'x');
  pool.installChunk(generation, { ...source('a', generation), source_version: 31, source_bytes: 63, committed_bytes: 62, contexts: [Uint32Array.of(6), Uint32Array.of(7)], runs: Uint32Array.of(62, 1, 63, 2) }, undefined, true);
  pool.remove(generation); // External views remain; root now counts only their arena liability.
  const peer = pool.admit('peer', 1, 'z'.repeat(30000)).generation!; assert.ok(peer);
  const arenaBeforeGrowth = pool.arena.stats().retainedBytes;
  assert.equal(pool.installChunk(peer, { ...source('peer', peer, 1, true), source_bytes: 30000, committed_bytes: 30000,
    contexts: [Uint32Array.from({ length: 256 }, () => 8)], runs: Uint32Array.of(30000, 1) }).accepted, true);
  const peerRefs: Parameters<typeof presentation>[0][number][] = []; pool.visitContexts(peer, ref => peerRefs.push(ref));
  assert.equal(pool.arena.installStyles(vocabulary, rules, peerRefs, decoded.styles, Uint32Array.of(1), bytes => pool.reserve(peer, bytes).accepted), true);
  const arenaAfterGrowth = pool.arena.stats().retainedBytes; assert.ok(arenaAfterGrowth > arenaBeforeGrowth);
  const retained = pool.stats().retainedBytes; assert.ok(retained <= pool.stats().maxBytes);
  const budget = pool.budget; pool.dispose();
  assert.ok(budget.stats().retainedBytes > 0, 'disposed root cannot return live capture charges');
  return { initial, later, root: new WeakRef(pool), arena: new WeakRef(pool.arena), retained, arenaBeforeGrowth, arenaAfterGrowth, budget };
}
test('job capture: adversarial future capture/restart/removal/peer growth and root GC stay funded until final holders', async () => {
  const held = heldRoot(); await turn();
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!held.root.deref()) break; }
  assert.equal(held.root.deref(), undefined); assert.ok(held.arena.deref(), 'actual shared arena survives through held block leases');
  assert.ok(held.initial.reservationBytes < held.retained); assert.ok(held.later.reservationBytes < held.retained);
  assert.ok(held.budget.stats().retainedBytes > 0);
  let initialContexts = 0; assert.equal(held.initial.captures[0]!.visitContexts(() => { initialContexts++; }), true); assert.equal(initialContexts, 2);
  held.later.release(); assert.ok(held.budget.stats().retainedBytes > 0);
  held.initial.release(); held.initial.release(); assert.equal(held.budget.stats().retainedBytes, 0);
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!held.arena.deref()) break; }
  assert.equal(held.arena.deref(), undefined);
  console.log(JSON.stringify({ jobGC: { rootCollected: true, arenaCollectedAfterFinalRelease: true, retainedBeforeRootGC: held.retained, arenaBeforeGrowth: held.arenaBeforeGrowth, arenaAfterGrowth: held.arenaAfterGrowth, initialReservation: held.initial.reservationBytes, laterReservation: held.later.reservationBytes } }));
});

test('job capture: removal/off/pressure/disposal forbids late publication and final release is idempotent', () => {
  for (const mode of ['remove', 'pressure', 'dispose']) {
    const pool = new SemanticRetentionPool({ maxBytes: 30000 }), generation = add(pool), group = acquire(pool, [generation]), pending = updates(group);
    if (mode === 'remove') pool.remove(generation);
    if (mode === 'pressure') assert.equal(pool.admit('large', 1, 'x'.repeat(12500)).accepted, true);
    if (mode === 'dispose') pool.dispose();
    assert.equal(pool.publishDisplays(pending).accepted, false);
    group.release(); const released = pool.stats(); group.release(); assert.deepEqual(pool.stats(), released);
    pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
  }
});

test('job capture: acquisition and theme publication read zero accumulated run endpoints', () => {
  const pool = new SemanticRetentionPool(), generation = pool.admit('a', 1, 'x\nx').generation!, Original = globalThis.Uint32Array;
  let reads = 0, first = false;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) {
    const value = Reflect.construct(target, args); if (!first) return value; first = false;
    return new Proxy(value, { get(array, key) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(array, key, array); } });
  } });
  try {
    for (let i = 1; i <= 40; i++) { const input = source('a', generation, i); if (i > 1) pool.replaceSnapshot(generation, i, 'x\n'.repeat(i) + 'x'); first = true; pool.installChunk(generation, input); }
    reads = 0; let utf8Calls = 0;
    const byteLength = Buffer.byteLength;
    Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => { utf8Calls++; return byteLength(...args); }) as typeof Buffer.byteLength;
    let group: ReturnType<typeof acquire>;
    try {
      group = acquire(pool, [generation]); const ready = updates(group);
      assert.equal(pool.publishDisplays(ready).accepted, true); const geometry = pool.displayStatus(generation)!.geometryStamp;
      assert.equal(pool.publishDisplays(updates(group, 2)).accepted, true); assert.equal(pool.displayStatus(generation)!.geometryStamp, geometry);
      assert.equal(reads, 0); assert.equal(utf8Calls, 0);
    } finally { Buffer.byteLength = byteLength; }
    const capturePublishReads = reads;
    pool.visitRanges(generation, () => {}); assert.ok(reads > 0);
    console.log(JSON.stringify({ jobPrefix: { committedBlocks: 40, capturePublishReads, utf8Calls, positiveRangeReads: reads, reservation: group!.reservationBytes } })); group!.release();
  } finally { globalThis.Uint32Array = Original; pool.dispose(); }
});

test('job capture: palette adoption exception releases temporary retained views, not the held job capture', () => {
  const pool = new SemanticRetentionPool(), generation = add(pool), group = acquire(pool, [generation]), ready = updates(group), freeze = Object.freeze;
  const before = pool.status(generation);
  Object.freeze = new Proxy(freeze, { apply(target, receiver, args) {
    if (args[0] && typeof args[0] === 'object' && 'kind' in args[0]) throw new Error('controlled palette adoption exception');
    return Reflect.apply(target, receiver, args);
  } });
  try { assert.throws(() => pool.publishDisplays(ready), /controlled palette adoption exception/); }
  finally { Object.freeze = freeze; }
  assert.deepEqual(pool.status(generation), before); assert.equal(pool.displayStatus(generation), undefined);
  const second = acquire(pool, [generation]); assert.equal(pool.stats().rangeViews, 2, 'no leaked temporary retain from the failed palette copy');
  second.release(); assert.equal(pool.publishDisplays(ready).accepted, true); group.release(); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('job capture: finite group charges only its own new metadata, not existing storage or an RPC-eight cap', () => {
  const pool = new SemanticRetentionPool({ maxBytes: 100000 }), generations = Array.from({ length: 12 }, (_v, i) => add(pool, `slot${i}`, true));
  const before = pool.stats().retainedBytes, group = acquire(pool, generations); assert.equal(group.captures.length, 12);
  assert.equal(pool.stats().retainedBytes - before, group.reservationBytes, 'only newly allocated metadata is charged; old storage is shared');
  assert.equal(pool.stats().rangeViews, 12); group.release(); assert.equal(pool.stats().retainedBytes, before); assert.equal(pool.stats().rangeViews, 0); pool.dispose();
  console.log(JSON.stringify({ jobGroupBound: { sources: 12, rootMax: 100000, reservation: group.reservationBytes, finalBytes: pool.stats().retainedBytes } }));
});

test('job capture: external grant cannot replace retained root funding; protected metadata denial has no hold/stamp change', () => {
  const pool = new SemanticRetentionPool({ maxBytes: 8000 }), generation = add(pool);
  assert.equal(installProjection(pool, generation, 1, 'x\nx', ['\x1b[31mx\x1b[32m', '\x1b[33mx']).accepted, true);
  const needed = pool.captureDisplays([generation], () => false).reservationBytes;
  assert.ok(pool.status(generation)); assert.ok(pool.stats().retainedBytes + needed > pool.budget.limit, 'live protected data denies the new capture metadata peak');
  const before = pool.stats(), status = pool.status(generation); let externalHeld = 0, calls = 0;
  const result = pool.captureDisplays([generation], needed => { externalHeld += needed; calls++; return true; });
  assert.equal(result.accepted, false); assert.equal(calls, 1); assert.equal(result.group, undefined); assert.equal(pool.stats().rangeViews, 0);
  assert.deepEqual(pool.stats(), before); assert.deepEqual(pool.status(generation), status);
  externalHeld -= result.reservationBytes; assert.equal(externalHeld, 0, 'caller refunds its grant after refused acquisition'); pool.dispose();
});

test('job capture: stale later logical slot prevents even first native publication and cannot revive its successor', () => {
  const pool = new SemanticRetentionPool(), a = add(pool, 'a', true), b = add(pool, 'b', true), group = acquire(pool, [a, b]), pending = updates(group);
  pool.remove(b); const successor = add(pool, 'b', true);
  assert.equal(pool.publishDisplays(pending).accepted, false); assert.equal(pool.displayStatus(a), undefined); assert.equal(pool.displayStatus(successor), undefined);
  group.release(); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

function releasedDuringVisit() {
  const pool = new SemanticRetentionPool({ maxBytes: 10000 }), set = Map.prototype.set;
  const snapshots: WeakRef<object>[] = [], words: WeakRef<object>[] = [], refs: WeakRef<object>[] = [];
  Map.prototype.set = function<K, V>(key: K, value: V): Map<K, V> {
    if (key === 1 && value && typeof value === 'object' && 'basis' in value) snapshots.push(new WeakRef(value.basis as object));
    if (typeof key === 'string' && value && typeof value === 'object' && 'words' in value && 'ref' in value) {
      words.push(new WeakRef(value.words as object)); refs.push(new WeakRef(value.ref as object));
    }
    return set.call(this, key, value) as Map<K, V>;
  };
  let group: ReturnType<typeof acquire>;
  try { const generation = add(pool); group = acquire(pool, [generation]); pool.remove(generation); }
  finally { Map.prototype.set = set; }
  assert.ok(snapshots.length); assert.equal(words.length, 2); assert.equal(refs.length, 2);
  return { pool, group: group!, snapshots, words, refs };
}
test('job capture: releasing during context callback drops snapshot/owned descriptors and unvisited key before budget reuse', async () => {
  const held = releasedDuringVisit(); assert.equal(held.pool.arena.stats().contexts, 2); await turn();
  let calls = 0;
  assert.equal(held.group.captures[0]!.visitContexts(() => {
    calls++; held.group.release(); assert.equal(held.pool.stats().retainedBytes, 0);
    assert.equal(held.pool.reserve(undefined, held.pool.stats().maxBytes).accepted, true); global.gc!(); global.gc!();
    const snapshotCollected = held.snapshots.every(ref => !ref.deref()), wordsCollected = held.words.every(ref => !ref.deref()), unvisitedKeyCollected = !held.refs[1]!.deref();
    assert.equal(snapshotCollected, true); assert.equal(wordsCollected, true); assert.equal(unvisitedKeyCollected, true);
    console.log(JSON.stringify({ jobVisitGC: { snapshotCollected, wordsCollected, unvisitedKeyCollected, calls, retainedBytes: held.pool.stats().retainedBytes } }));
  }), false);
  assert.equal(calls, 1); held.group.release(); held.pool.dispose();
});

test('job capture: fragmented group membership validation scans linearly, not once per member', () => {
  const pool = new SemanticRetentionPool(), members = 2048;
  const generations = Array.from({ length: members }, (_, i) => add(pool, `slot${i}`, true));
  const indexOf = Array.prototype.indexOf, includes = Array.prototype.includes;
  let scanned = 0;
  const count = (array: unknown[], found: number) => { if (array.length === members) scanned += found < 0 ? array.length : found + 1; };
  Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof indexOf>) { const found = indexOf.apply(this, args); count(this, found); return found; };
  Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) { const found = indexOf.apply(this, args as Parameters<typeof indexOf>); count(this, found); return found >= 0; };
  let group: ReturnType<typeof acquire> | undefined;
  try {
    group = acquire(pool, generations);
    assert.equal(pool.publishDisplays(updates(group)).accepted, true);
  } finally { Array.prototype.indexOf = indexOf; Array.prototype.includes = includes; group?.release(); pool.clear(); }
  assert.ok(scanned <= 8 * members, `${scanned} membership comparisons for ${members} members`);
});


test('job capture: selected frozen display retains V1 contexts and geometry after parser V2', () => {
  const pool = new SemanticRetentionPool(), generation = add(pool), first = acquire(pool, [generation]);
  assert.equal(pool.publishDisplays(updates(first)).accepted, true); first.release();
  const display = pool.displayStatus(generation)!;
  advance(pool, generation, 2, 3);
  const parser = pool.status(generation)!;
  const selected = pool.captureDisplays([{ generation, effectStamp: display.effectStamp }], () => true);
  assert.equal(selected.accepted, true); assert.ok(selected.group);
  try {
    const capture = selected.group.captures[0]!;
    assert.equal(capture.sourceVersion, 1); assert.equal(capture.semanticStamp, display.semanticStamp);
    const refs: number[] = []; capture.visitContexts(ref => refs.push(ref.id));
    const historical: number[] = []; pool.visitDisplayContexts(generation, display.effectStamp, ref => historical.push(ref.id));
    assert.deepEqual(refs, historical);
    assert.equal(pool.publishDisplays(updates(selected.group, 2)).accepted, true);
    assert.equal(pool.displayStatus(generation)!.geometryStamp, display.geometryStamp);
    assert.equal(pool.displayStatus(generation)!.sourceVersion, 1);
    assert.equal(pool.borrowDisplay(generation, pool.displayStatus(generation)!.effectStamp)!.text, 'x\nx');
    for (const key of ['semanticStamp', 'sourceVersion', 'revision', 'basisVersion'] as const) assert.equal(pool.status(generation)![key], parser[key]);
  } finally { selected.group.release(); pool.dispose(); }
  assert.equal(pool.stats().retainedBytes, 0);
});

test('job capture: membership work grows linearly across capture and reordered publication', () => {
  for (const members of [128, 256]) {
    const pool = new SemanticRetentionPool(), values = Array.from({ length: members }, (_, i) => add(pool, `linear${i}`, true));
    let reads = 0, lookups = 0;
    const generations = new Proxy(values, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    const get = Map.prototype.get;
    Map.prototype.get = function<K, V>(key: K): V | undefined { if (typeof key === 'number') lookups++; return get.call(this, key) as V | undefined; };
    let group: ReturnType<typeof acquire> | undefined;
    try {
      group = acquire(pool, generations);
      assert.equal(pool.publishDisplays(updates(group).reverse()).accepted, true);
    } finally { Map.prototype.get = get; group?.release(); pool.dispose(); }
    console.log(JSON.stringify({ captureMembershipWork: { members, reads, lookups } }));
    assert.ok(reads <= 32 * members, `${reads} input reads for ${members} members`);
    assert.ok(lookups <= 40 * members, `${lookups} entry lookups for ${members} members`);
  }
});


test('job capture: exact display selectors fail closed after reservation changes and survive nested capture', () => {
  for (const change of ['recolor', 'remove', 'replace', 'nested', 'duplicate'] as const) {
    const pool = new SemanticRetentionPool(), a = add(pool, 'a', true), b = add(pool, 'b', true), first = acquire(pool, [a, b]);
    assert.equal(pool.publishDisplays(updates(first)).accepted, true);
    const selectors = [a, b].map(generation => ({ generation, effectStamp: pool.displayStatus(generation)!.effectStamp }));
    const before = pool.stats().retainedBytes;
    const captured = pool.captureDisplays(selectors, () => {
      if (change === 'recolor') {
        const changed = updates(first, 2);
        for (const update of changed) update.candidate.presentation = { ...update.candidate.presentation,
          contexts: update.candidate.presentation.contexts.map(pair => ({ context: pair.context, style: { ...pair.style, attributes: pair.style.attributes ^ 1 } })) };
        assert.equal(pool.publishDisplays(changed).accepted, true);
        assert.notEqual(pool.displayStatus(b)!.effectStamp, selectors[1]!.effectStamp);
      }
      if (change === 'remove') pool.remove(b);
      if (change === 'replace') { pool.remove(b); add(pool, 'b', true); }
      if (change === 'duplicate') selectors[1] = selectors[0]!;
      if (change === 'nested') { const nested = acquire(pool, [b, a]); nested.release(); }
      return true;
    });
    assert.equal(captured.accepted, change === 'nested', change);
    if (change === 'nested') {
      assert.ok(captured.group); assert.deepEqual(captured.group.captures.map(capture => capture.generation), [a, b]);
      captured.group.release(); assert.equal(pool.stats().retainedBytes, before);
    } else assert.equal(captured.group, undefined);
    first.release(); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
  }
});

test('job capture: branded group rejects substituted and duplicate members atomically but accepts reordering', () => {
  const pool = new SemanticRetentionPool(), a = add(pool, 'a', true), b = add(pool, 'b', true), c = add(pool, 'c', true);
  const first = acquire(pool, [a, b]), other = acquire(pool, [a, c]);
  const substituted = [updates(first)[0]!, updates(other)[1]!];
  assert.equal(pool.publishDisplays(substituted).accepted, false);
  const mismatch = updates(first); mismatch[1]!.generation = a;
  assert.equal(pool.publishDisplays(mismatch).accepted, false);
  const duplicate = [updates(first)[0]!, updates(first)[0]!];
  assert.equal(pool.publishDisplays(duplicate).accepted, false);
  for (const generation of [a, b, c]) assert.equal(pool.displayStatus(generation), undefined);
  assert.equal(pool.publishDisplays(updates(first).reverse()).accepted, true);
  assert.ok(pool.displayStatus(a)); assert.ok(pool.displayStatus(b)); assert.equal(pool.displayStatus(c), undefined);
  first.release(); other.release(); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

for (const members of [16, 64, 256]) test(`job capture: pressure funding protects ${members} members in linear membership work`, () => {
  const probe = new SemanticRetentionPool();
  for (let i = 0; i < members; i++) add(probe, `slot${i}`, true);
  const retained = probe.stats().retainedBytes; probe.dispose();
  const pool = new SemanticRetentionPool({ maxBytes: retained + 8192 });
  const generations = Array.from({ length: members }, (_, i) => add(pool, `slot${i}`, true));
  assert.equal(pool.stats().entries, members, 'all protected members must be resident before pressure');
  let reads = 0;
  const selected = new Proxy(generations, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/u.test(property)) reads++;
    return Reflect.get(target, property, receiver);
  } });
  const result = pool.captureDisplays(selected, () => true);
  try { assert.equal(result.accepted, false, 'pressure cannot evict protected inputs to fund their own capture'); }
  finally { result.group?.release(); }
  assert.equal(pool.stats().entries, members); assert.ok(reads <= members * 8, `member reads ${reads} for ${members} members`);
  assert.equal(pool.stats().outstandingPeakBytes, 0);
  const later = pool.reserve(undefined, 16384);
  assert.equal(later.accepted, true); assert.ok(later.released.length > 0, 'temporary group protection must not survive refusal');
  pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});
