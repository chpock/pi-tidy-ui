import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena, type ContextRef } from '../../../src/occipital/context-arena.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64), grant = () => true;
function chunk(revision: number, from: number, committed: number, end: number, scopes: number[], runs: number[], complete = false): SemanticChunk {
  return { vocabulary, key: 'source', generation: 1, source_version: revision, revision, source_bytes: end, replace_from: from,
    committed_bytes: committed, complete, lease: 'lease', contexts: scopes.map(scope => Uint32Array.of(scope)), runs: Uint32Array.from(runs),
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
}
function basis() { const arena = new ContextArena(); return { arena, ranges: new SemanticRanges(arena) }; }
function rows(source: { visit(consume: (from: number, to: number, ref: ContextRef | undefined) => void): void }) {
  const result: [number, number, ContextRef | undefined][] = [];
  source.visit((from, to, ref) => result.push([from, to, ref])); return result;
}
const physical = (current?: SemanticRanges, views: NonNullable<ReturnType<SemanticRanges['captureView']>>[] = []) => SemanticRanges.ownershipStats(current, views);

test('semantic range view: ready provisional styles survive parser progress with unavailable replacement styles', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 2, 3, [1, 2], [2, 1, 3, 2]), grant);
  const readyRows = rows(ranges), oldTail = readyRows[1]![2]!;
  arena.installStyles(vocabulary, rules, [oldTail], [{ foreground: { kind: 'rgb', r: 30, g: 40, b: 50 }, background: { kind: 'inherit' }, attributes: 3, attribute_mask: 3 }], Uint32Array.of(1), grant);
  const progress = ranges.stats(), before = physical(ranges), leases = arena.stats().leases;
  let capturePeak = 0;
  const view = ranges.captureView(peak => { capturePeak = peak; return true; })!;
  assert.ok(view); assert.ok(capturePeak > 0); assert.ok(Object.isFrozen(view));
  assert.deepEqual(ranges.stats(), progress, 'capture has no parser-progress meaning');
  assert.equal(physical(ranges, [view]).retainedBytes - before.retainedBytes, capturePeak);
  assert.equal(arena.stats().leases, leases, 'capture shares physical leases, not per-block retains');
  ranges.apply(chunk(2, 2, 2, 4, [3], [4, 1]), grant);
  assert.equal(ranges.stats().revision, 2); assert.equal(view.revision, 1); assert.equal(view.sourceBytes, 3);
  assert.deepEqual(rows(view), readyRows);
  assert.equal(arena.style(vocabulary, rows(ranges)[1]![2]!, rules), undefined);
  assert.deepEqual(arena.style(vocabulary, oldTail, rules)!.foreground, { kind: 'rgb', r: 30, g: 40, b: 50 });
  assert.equal(ranges.stats().rangeBytes, 16, 'no-arg stats remain current-parser storage');
  const overlap = physical(ranges, [view]);
  assert.deepEqual(overlap, { retainedBytes: ranges.stats().retainedBytes + capturePeak + 264,
    rangeBytes: 24, displayOnlyRangeBytes: 8, prefixBytes: 8, committedChunks: 1, stores: 1, views: 1, retainedTails: 2, prefixCopiedBytes: 0 });
  view.release(); view.release();
  assert.deepEqual(rows(view), []); assert.throws(() => arena.style(vocabulary, oldTail, rules));
  assert.equal(physical(ranges).retainedTails, 1); assert.equal(arena.stats().contexts, 2);
  ranges.dispose(); assert.equal(physical(ranges, [view]).retainedBytes, 0); assert.equal(arena.stats().retainedBytes, 0);
  console.log(JSON.stringify({ rangeViewAccounting: { capturePeak, overlap, released: physical(ranges, [view]), arenaBytes: arena.stats().retainedBytes } }));
});

test('semantic range view: denied capture and denied block growth preserve the old funded union atomically', () => {
  const { arena, ranges } = basis();
  assert.equal(ranges.captureView(() => assert.fail('no source to capture')), undefined);
  ranges.apply(chunk(1, 0, 2, 3, [1, 2], [2, 1, 3, 2]), grant);
  const old = ranges.captureView(grant)!, before = physical(ranges, [old]), arenaBefore = arena.stats(), oldRows = rows(old);
  const original = globalThis.Uint32Array; let allocations = 0, deniedPeak = 0;
  const next = chunk(2, 2, 4, 5, [3, 4], [4, 1, 5, 2]);
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try {
    assert.equal(ranges.captureView(peak => { assert.ok(peak > 0); assert.deepEqual(physical(ranges, [old]), before); return false; }), undefined);
    assert.equal(ranges.apply(next, peak => { deniedPeak = peak; assert.deepEqual(physical(ranges, [old]), before); return false; }), false);
  } finally { globalThis.Uint32Array = original; }
  assert.ok(deniedPeak > 0); assert.equal(allocations, 0);
  assert.deepEqual(physical(ranges, [old]), before); assert.deepEqual(arena.stats(), arenaBefore); assert.deepEqual(rows(old), oldRows);
  assert.equal(ranges.apply(next, grant), true);
  assert.deepEqual(rows(old), oldRows);
  old.release(); ranges.dispose(); assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic range view: capture, append and stats never read old prefix buffers; retirement trims all unseen blocks immediately', () => {
  const { arena, ranges } = basis(), original = globalThis.Uint32Array;
  let prefixReads = 0, watchFirst = false;
  const append = (revision: number) => {
    const from = (revision - 1) * 2;
    const source = chunk(revision, from, from + 2, from + 3, [revision, 1000 + revision], [from + 2, 1, from + 3, 2]);
    watchFirst = true;
    globalThis.Uint32Array = new Proxy(original, { construct(target, args) {
      const value = Reflect.construct(target, args);
      if (!watchFirst) return value;
      watchFirst = false;
      return new Proxy(value, { get(array, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) prefixReads++;
        return Reflect.get(array, property, array);
      } });
    } });
    try { ranges.apply(source, grant); } finally { globalThis.Uint32Array = original; }
  };
  for (let i = 1; i <= 64; i++) append(i);
  prefixReads = 0;
  const view = ranges.captureView(grant)!;
  for (let i = 65; i <= 80; i++) append(i);
  for (let i = 0; i < 100; i++) physical(ranges, [view]);
  assert.equal(prefixReads, 0, 'proxy observes real numeric run reads, not a declared copy counter');
  assert.equal(physical(ranges, [view]).committedChunks, 80);
  ranges.dispose();
  assert.equal(prefixReads, 0, 'retirement only releases discarded blocks; retained prefix buffers stay untouched');
  const retained = physical(undefined, [view]), captureAppendStatsPrefixReads = prefixReads;
  assert.equal(retained.committedChunks, 64); assert.equal(retained.prefixBytes, 64 * 8);
  assert.equal(retained.retainedTails, 1); assert.equal(retained.rangeBytes, 65 * 8);
  assert.equal(retained.displayOnlyRangeBytes, retained.rangeBytes); assert.equal(arena.stats().contexts, 65);
  assert.equal(rows(view).length, 65); assert.ok(prefixReads > 0, 'positive traversal control proves the proxy was live');
  assert.equal(view.sourceBytes, 129); assert.equal(view.committedBytes, 128); assert.equal(view.revision, 64);
  view.release(); assert.equal(arena.stats().retainedBytes, 0); assert.equal(physical(undefined, [view]).retainedBytes, 0);
  console.log(JSON.stringify({ rangeViewProxy: { capturedPrefixBlocks: 64, appendedUnseenBlocks: 16, captureAppendStatsPrefixReads, positiveVisitPrefixReads: prefixReads, retainedAfterRetirement: retained } }));
});

test('semantic range view: complete captured source outlives parser disposal and never observes a successor', () => {
  const arena = new ContextArena(), first = new SemanticRanges(arena), successor = new SemanticRanges(arena);
  first.apply(chunk(1, 0, 3, 3, [1], [3, 1], true), grant);
  const view = first.captureView(grant)!, expected = rows(view);
  first.dispose(); first.dispose();
  successor.apply(chunk(1, 0, 4, 4, [2], [4, 1], true), grant);
  assert.deepEqual(rows(view), expected); assert.equal(view.complete, true);
  assert.equal(physical(successor, [view]).stores, 2);
  assert.equal(physical(successor, [view]).displayOnlyRangeBytes, 8);
  const visit = view.visit;
  assert.throws(() => visit.call({}, () => assert.fail('forged view visited successor')));
  view.release(); assert.deepEqual(rows(view), []);
  assert.deepEqual(rows(successor).map(([a, b]) => [a, b]), [[0, 4]]);
  assert.equal(physical(successor, [view]).stores, 1);
  successor.dispose(); assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic range view: synchronous two-view publication shares prefix and tail leases without a tiny count ceiling', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 2, 3, [1, 2], [2, 1, 3, 2]), grant);
  const before = physical(ranges), leased = arena.stats().leases;
  const views = Array.from({ length: 24 }, () => ranges.captureView(grant)!);
  const shared = physical(ranges, views);
  assert.equal(shared.rangeBytes, before.rangeBytes); assert.equal(shared.retainedTails, 1);
  assert.equal(shared.views, 24); assert.equal(arena.stats().leases, leased);
  for (const view of views.slice(1)) view.release();
  const old = views[0]!, oldRows = rows(old);
  ranges.apply(chunk(2, 2, 2, 4, [3], [4, 1]), grant);
  const next = ranges.captureView(grant)!;
  assert.equal(physical(ranges, [old, next]).rangeBytes, 24); assert.equal(physical(ranges, [old, next]).views, 2);
  ranges.dispose();
  assert.deepEqual(rows(old), oldRows); assert.equal(physical(undefined, [old, next]).retainedTails, 2);
  old.release(); assert.equal(arena.stats().contexts, 2);
  assert.equal(physical(undefined, [next]).retainedTails, 1);
  next.release(); next.release(); assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic range view: dropping the largest retired view truncates to the remaining captured extent', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 2, 3, [1, 2], [2, 1, 3, 2]), grant);
  const small = ranges.captureView(grant)!;
  ranges.apply(chunk(2, 2, 4, 5, [3, 4], [4, 1, 5, 2]), grant);
  const large = ranges.captureView(grant)!;
  ranges.apply(chunk(3, 4, 6, 7, [5, 6], [6, 1, 7, 2]), grant);
  ranges.dispose();
  assert.equal(physical(undefined, [small, large]).committedChunks, 2);
  assert.equal(arena.stats().contexts, 4);
  large.release();
  assert.equal(physical(undefined, [small]).committedChunks, 1); assert.equal(arena.stats().contexts, 2);
  assert.deepEqual(rows(small).map(([a, b]) => [a, b]), [[0, 2], [2, 3]]);
  small.release(); assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic range view: release during traversal stops callbacks before visiting retired context handles', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 3, 3, [1, 2, 3], [1, 1, 2, 2, 3, 3], true), grant);
  const view = ranges.captureView(grant)!;
  ranges.dispose();
  let calls = 0; view.visit(() => { calls++; view.release(); });
  assert.equal(calls, 1); assert.equal(arena.stats().retainedBytes, 0);
  assert.deepEqual(rows(view), []);
});

function retiredView() {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 2, 3, [1, 2], [2, 1, 3, 2]), grant);
  const view = ranges.captureView(grant)!;
  ranges.dispose();
  return { view, owner: new WeakRef(ranges), arena: new WeakRef(arena) };
}
test('semantic range view: retained released first view cannot pin its retired parser owner or arena while peer is active', async () => {
  assert.equal(typeof global.gc, 'function');
  const first = retiredView(), peer = basis();
  peer.ranges.apply(chunk(1, 0, 3, 3, [9], [3, 1], true), grant);
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!first.owner.deref()) break; }
  assert.equal(first.owner.deref(), undefined, 'a live view holds no retired SemanticRanges backref');
  assert.equal(rows(first.view).length, 2);
  first.view.release();
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!first.arena.deref()) break; }
  assert.equal(first.arena.deref(), undefined, 'retained released view clears store, tail and arena leases');
  assert.deepEqual(rows(first.view), []); assert.equal(peer.arena.stats().contexts, 1);
  console.log(JSON.stringify({ rangeViewGC: { retiredOwnerCollected: first.owner.deref() === undefined,
    releasedArenaCollected: first.arena.deref() === undefined, retainedReleasedViewVisits: rows(first.view).length, peerContexts: peer.arena.stats().contexts } }));
  peer.ranges.dispose();
});

test('semantic range view: a captured tail lease releases only after the last actual view holder', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk(1, 0, 0, 3, [1], [3, 1]), grant);
  const first = ranges.captureView(grant)!, last = ranges.captureView(grant)!, ref = rows(first)[0]![2]!;
  const before = arena.stats();
  ranges.dispose(); first.release(); first.release();
  assert.equal(arena.stats().leases, before.leases); assert.equal(physical(undefined, [last]).retainedTails, 1);
  assert.deepEqual(arena.encode(vocabulary, [ref], grant), [[0, 1]]);
  assert.deepEqual(rows(last).map(([a, b]) => [a, b]), [[0, 3]]);
  last.release(); assert.throws(() => arena.encode(vocabulary, [ref], grant));
  assert.equal(arena.stats().retainedBytes, 0); assert.equal(physical(undefined, [first, last]).retainedBytes, 0);
});

test('semantic range view: neutral zero and positive parsed-empty survive immutable input copying and parser disposal', () => {
  const { arena, ranges } = basis();
  const source = chunk(1, 0, 3, 3, [1], [1, 0, 2, 1, 3, 2], true);
  source.contexts = [new Uint32Array(), Uint32Array.of(7, 7)];
  ranges.apply(source, grant);
  const view = ranges.captureView(grant)!, expected = rows(view);
  source.runs.fill(0); source.contexts[1]!.fill(99);
  ranges.dispose();
  assert.deepEqual(rows(view), expected); assert.equal(expected[0]![2], undefined);
  assert.ok(expected[1]![2]!.id > 0); assert.notEqual(expected[1]![2], expected[2]![2]);
  assert.deepEqual(arena.encode(vocabulary, [expected[1]![2]!, expected[2]![2]!], grant), [[0], [0, 7, 7]]);
  view.release(); assert.equal(arena.stats().retainedBytes, 0);
});
