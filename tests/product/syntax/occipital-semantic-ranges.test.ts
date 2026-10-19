import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena, type ContextRef } from '../../../src/occipital/context-arena.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import { decodeSemanticSources, type SemanticChunk } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64), grant = () => true;
const counters = { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 };
function chunk(text: string, contexts: number[][], runs: number[], options: Partial<SemanticChunk> = {}): SemanticChunk {
  const complete = options.complete ?? false, source_bytes = Buffer.byteLength(text), replace_from = options.replace_from ?? 0;
  const replacementText = Buffer.from(text).subarray(replace_from).toString('utf8');
  const expected = { key: 'source', generation: 1, source_version: 1, revision: 1, source_bytes, replace_from,
    complete, ...(!complete || options.lease ? { lease: options.lease ?? 'lease' } : {}), ...options, replacementText };
  const { replacementText: _text, ...metadata } = expected;
  return decodeSemanticSources({ kind: 'source', vocabulary, sources: [{ ...metadata,
    committed_bytes: complete ? source_bytes : replace_from + Buffer.from(replacementText).lastIndexOf(10) + 1,
    contexts, runs, counters }] }, { vocabulary, vocabularySize: 100, sourceBytes: 1 << 20, runs: 1000, batchSources: 8 },
  [expected], 64 << 20).sources[0]!;
}
function basis() {
  const arena = new ContextArena();
  return { arena, ranges: new SemanticRanges(arena) };
}
function visits(ranges: SemanticRanges) {
  const result: [number, number, ContextRef | undefined][] = [];
  ranges.visit((start, end, ref) => result.push([start, end, ref]));
  return result;
}

test('semantic ranges: appends retain immutable committed blocks and release replaced tail-only contexts', () => {
  const { arena, ranges } = basis();
  assert.equal(ranges.apply(chunk('abc', [[0, 1]], [3, 1]), grant), true);
  const original = visits(ranges)[0]![2];
  assert.equal(ranges.apply(chunk('abc\ndef', [[0, 1], [0, 2]], [4, 1, 3, 2], { revision: 2, source_version: 2 }), grant), true);
  assert.equal(visits(ranges)[0]![2], original);
  const peer = arena.retain([visits(ranges)[1]![2]!], grant)!;
  assert.equal(ranges.apply(chunk('abc\ndefghi', [[0, 3]], [6, 1], { revision: 3, source_version: 3, replace_from: 4 }), grant), true);
  assert.equal(visits(ranges)[0]![2], original);
  assert.equal(arena.stats().contexts, 3, 'a style job independently pins the removed tail');
  peer.release();
  assert.equal(arena.stats().contexts, 2);
  assert.deepEqual(visits(ranges).map(([a, b]) => [a, b]), [[0, 4], [4, 10]]);
  assert.equal(ranges.stats().prefixCopiedBytes, 0);
  assert.equal(ranges.stats().committedChunks, 1);
  ranges.dispose();
  assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic ranges: neutral zero, parsed-empty and repeated stacks remain distinct without colors', () => {
  const { arena, ranges } = basis();
  const source = chunk('a雪é', [[0], [0, 1, 1]], [1, 0, 3, 1, 3, 2], { complete: true });
  assert.equal(ranges.apply(source, grant), true);
  const rows = visits(ranges);
  assert.equal(rows[0]![2], undefined);
  assert.ok(rows[1]![2]!.id > 0);
  assert.notEqual(rows[1]![2], rows[2]![2]);
  assert.deepEqual(arena.encode(vocabulary, [rows[1]![2]!, rows[2]![2]!], grant), [[0], [0, 1, 1]]);
  assert.equal(ranges.stats().complete, true);
  ranges.dispose();
  assert.equal(arena.stats().contexts, 0);
});

test('semantic ranges: moving unchanged semantic coverage from tail to committed preserves its display stamp', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk('abc', [[0, 1]], [3, 1]), grant);
  const before = ranges.stats(), ref = visits(ranges)[0]![2];
  ranges.apply(chunk('abc', [[0, 1]], [3, 1], { complete: true, lease: 'lease', revision: 2 }), grant);
  assert.equal(ranges.stats().displayRevision, before.displayRevision);
  assert.equal(visits(ranges)[0]![2], ref);
  assert.equal(ranges.stats().committedBytes, 3);
  assert.equal(arena.stats().contexts, 1);
  assert.throws(() => ranges.apply(chunk('abc', [[0, 1]], [3, 1], { complete: true, revision: 3 }), grant));
  ranges.dispose();
});

test('semantic ranges: denied admission leaves the prior basis intact and allocates no owned vectors', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk('abc', [[0, 1]], [3, 1]), grant);
  const next = chunk('abc\ndef', [[0, 1], [0, 2]], [4, 1, 3, 2], { revision: 2, source_version: 2 });
  const before = ranges.stats(), owned = arena.stats(), beforeRows = visits(ranges), original = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try { assert.equal(ranges.apply(next, () => false), false); }
  finally { globalThis.Uint32Array = original; }
  assert.equal(allocations, 0);
  assert.deepEqual(ranges.stats(), before);
  assert.deepEqual(arena.stats(), owned);
  assert.deepEqual(visits(ranges), beforeRows);
  assert.equal(ranges.apply(next, grant), true, 'caller retaining the same validated result may retry it');
  ranges.dispose();
});

test('semantic ranges: stale incarnation, revision or lease cannot replace an owned semantic basis', () => {
  for (const wrong of [{ key: 'other' }, { generation: 2 }, { source_version: 0 }, { revision: 3 }, { lease: 'other' }]) {
    const { arena, ranges } = basis();
    ranges.apply(chunk('abc', [[0, 1]], [3, 1]), grant);
    const before = ranges.stats();
    assert.throws(() => ranges.apply(chunk('abc', [[0, 2]], [3, 1], { revision: 2, ...wrong }), grant));
    assert.deepEqual(ranges.stats(), before);
    ranges.dispose();
    assert.equal(arena.stats().retainedBytes, 0);
  }
});

test('semantic ranges: committed and provisional windows pin only the contexts they actually reference', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk('a\nb', [[0, 1], [0, 2], [0, 3]], [2, 1, 1, 2]), grant);
  assert.equal(arena.stats().contexts, 2, 'unused reply context is not kept');
  ranges.apply(chunk('a\nbc', [[0, 4]], [2, 1], { revision: 2, source_version: 2, replace_from: 2 }), grant);
  assert.equal(arena.stats().contexts, 2, 'committed block did not retain the obsolete provisional dictionary');
  ranges.dispose();
  assert.equal(arena.stats().retainedBytes, 0);
});

test('semantic ranges: result arrays are copied and source removal does not dispose a compatible peer arena', () => {
  const arena = new ContextArena(), first = new SemanticRanges(arena), peer = new SemanticRanges(arena);
  const source = chunk('abc', [[0, 1]], [3, 1]);
  first.apply(source, grant);
  source.runs.fill(0); source.contexts[0]!.fill(99);
  assert.deepEqual(visits(first).map(([a, b]) => [a, b]), [[0, 3]]);
  peer.apply(chunk('xyz', [[0, 1]], [3, 1], { key: 'peer', complete: true }), grant);
  first.dispose(); first.dispose();
  assert.equal(arena.stats().contexts, 1);
  assert.deepEqual(arena.encode(vocabulary, [visits(peer)[0]![2]!], grant), [[0, 1]]);
  assert.throws(() => first.apply(chunk('abc', [[0, 1]], [3, 1]), grant));
  peer.dispose();
  assert.equal(arena.stats().retainedBytes, 0);
});

function disposedRanges() {
  const { arena, ranges } = basis();
  ranges.apply(chunk('abc', [[0, 1]], [3, 1]), grant);
  ranges.dispose();
  return { owner: new WeakRef(arena), ranges };
}
test('semantic ranges: a retained disposed basis does not keep its former shared arena alive', async () => {
  assert.equal(typeof global.gc, 'function');
  const first = disposedRanges(), peer = basis();
  peer.ranges.apply(chunk('xyz', [[0, 2]], [3, 1]), grant);
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!first.owner.deref()) break; }
  assert.equal(first.owner.deref(), undefined);
  assert.deepEqual(visits(first.ranges), []);
  assert.equal(peer.arena.stats().contexts, 1);
  peer.ranges.dispose();
});

test('semantic ranges: appending a suffix neither reads nor copies the owned committed prefix', () => {
  const { arena, ranges } = basis(), source = chunk('a\nb', [[0, 1], [0, 2]], [2, 1, 1, 2]);
  const original = globalThis.Uint32Array;
  let constructions = 0, prefixReads = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) {
    const value = Reflect.construct(target, args);
    if (++constructions !== 1) return value;
    return new Proxy(value, { get(array, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) prefixReads++;
      return Reflect.get(array, property, array);
    } });
  } });
  try { ranges.apply(source, grant); }
  finally { globalThis.Uint32Array = original; }
  const allocatedWords = arena.stats().allocatedWordBytes;
  prefixReads = 0;
  ranges.apply(chunk('a\nbc', [[0, 2]], [2, 1], { revision: 2, source_version: 2, replace_from: 2 }), grant);
  assert.equal(prefixReads, 0, 'actual numeric accesses to the owned prefix run buffer');
  assert.equal(arena.stats().allocatedWordBytes, allocatedWords, 'the repeated tail context also reused its owned words');
  assert.equal(ranges.stats().prefixCopiedBytes, 0);
  ranges.dispose();
});

test('semantic ranges: empty finite and empty final suffix add no artificial coverage; many chunks never copy their prefix', () => {
  const { arena, ranges } = basis();
  ranges.apply(chunk('', [], [], { complete: true }), grant);
  assert.deepEqual(visits(ranges), []); assert.equal(ranges.stats().committedChunks, 0); ranges.dispose();
  const many = new SemanticRanges(arena);
  for (let i = 0; i < 1000; i++) {
    const text = 'x\n'.repeat(i + 1);
    assert.equal(many.apply(chunk(text, [[0, i % 2 + 1]], [2, 1], { revision: i + 1, source_version: i + 1, replace_from: i * 2 }), grant), true);
  }
  assert.equal(many.stats().committedChunks, 1000); assert.equal(many.stats().prefixCopiedBytes, 0); assert.equal(visits(many).length, 1000);
  assert.equal(many.apply(chunk('x\n'.repeat(1000), [], [], { revision: 1001, source_version: 1001, replace_from: 2000, complete: true, lease: 'lease' }), grant), true);
  assert.equal(visits(many).at(-1)![1], 2000); many.dispose(); assert.equal(arena.stats().retainedBytes, 0);
});
