import assert from 'node:assert/strict';
import test from 'node:test';
import { RangeAccumulator } from '../src/occipital/ranges.ts';
import { RetentionPool, RETENTION_LIMITS } from '../src/occipital/retention.ts';
import type { SourceChunk } from '../src/occipital/protocol.ts';

const fingerprint = 'a'.repeat(64);
function chunk(key: string, generation: number, version: number, revision: number, from: number, committed: number, end: number, complete = false): SourceChunk {
  return { key, generation, source_version: version, revision, replace_from: from, committed_bytes: committed,
    source_bytes: end, complete, profile: 'pi', fingerprint, lease: 'lease',
    runs: new Uint32Array(end === from ? [] : [end, 1]),
    counters: { committed_line_calls: revision, committed_line_bytes: committed, tail_calls: revision, tail_bytes: end - committed } };
}
function admit(pool: RetentionPool, key: string, text: string, version = 0): number {
  const result = pool.admit(key, version, text);
  assert.equal(result.accepted, true);
  assert.ok(result.generation !== undefined);
  return result.generation;
}
function spans(pool: RetentionPool, generation: number): number[][] {
  const output: number[][] = [];
  pool.visitRanges(generation, (start, end, style) => output.push([start, end, style]));
  return output;
}
function snapshots(pool: RetentionPool, generation: number): [string, number, string][] {
  const output: [string, number, string][] = [];
  pool.visitSnapshots(generation, (kind, version, text) => output.push([kind, version, text]));
  return output;
}

test('retention: one bounded global budget includes source, daemon and native results', () => {
  const pool = new RetentionPool({ maxBytes: 12000 });
  const a = admit(pool, 'a', 'hello');
  assert.equal(pool.installChunk(a, chunk('a', a, 0, 1, 0, 0, 5)).accepted, true);
  assert.equal(pool.installBridge(a, 0, 'hello', ['colored hello']).accepted, true);
  const status = pool.status(a)!;
  assert.ok(status.snapshotBytes > 0 && status.rangeBytes > 0 && status.bridgeBytes > 0);
  assert.equal(pool.stats().retainedBytes, status.retainedBytes);
  const b = admit(pool, 'b', 'x'.repeat(2500));
  const result = pool.admit('c', 0, 'y'.repeat(2500));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.released.map(item => item.generation), [a, b]);
  assert.equal(result.released[0]!.retainedBytes, status.retainedBytes);
  assert.equal(result.released[0]!.rangeBytes, status.rangeBytes);
  assert.equal(result.released[0]!.bridgeBytes, status.bridgeBytes);
  assert.ok(pool.stats().retainedBytes <= 12000);
  assert.deepEqual(spans(pool, a), []);
});

test('retention: basis/latest text deduplicates and superseded waiting text is released', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'same');
  const initial = pool.status(g)!.snapshotBytes;
  assert.equal(pool.replaceSnapshot(g, 1, 'same').accepted, true);
  assert.equal(pool.status(g)!.snapshotBytes, initial);
  assert.equal(pool.replaceSnapshot(g, 2, 'different').accepted, true);
  const two = pool.status(g)!.snapshotBytes;
  assert.ok(two > initial);
  assert.equal(pool.replaceSnapshot(g, 3, 'short').accepted, true);
  assert.ok(pool.status(g)!.snapshotBytes < two);
  assert.deepEqual(snapshots(pool, g), [['basis', 0, 'same'], ['latest', 3, 'short']]);
  assert.equal(pool.installChunk(g, chunk('a', g, 3, 1, 0, 0, 5)).accepted, true);
  assert.deepEqual(snapshots(pool, g), [['basis', 3, 'short']]);
});

test('retention: UTF16 accounting, lower-only injectable limits and finite metadata', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', '');
  const empty = pool.status(g)!.snapshotBytes;
  pool.replaceSnapshot(g, 1, '😀');
  assert.equal(pool.status(g)!.snapshotBytes - empty, 4 + RETENTION_LIMITS.stringAllowance);
  assert.equal(RETENTION_LIMITS.maxBytes, 1 << 30);
  assert.throws(() => new RetentionPool({ maxBytes: RETENTION_LIMITS.maxBytes + 1 }));
  assert.throws(() => new RetentionPool({ maxBytes: 0 }));
  assert.throws(() => new RetentionPool({ maxBytes: 1.5 }));
  assert.throws(() => pool.admit('x'.repeat(65), 0, ''));
  const bounded = new RetentionPool({ maxBytes: 3 * (RETENTION_LIMITS.entryAllowance + 2 * RETENTION_LIMITS.stringAllowance + 2 * 4) });
  for (let i = 0; i < 1000; i++) {
    const result = bounded.admit(`k${i}`, 0, '');
    assert.ok(result.released.length <= 1);
    assert.ok(bounded.stats().entries <= 3);
  }
  assert.equal(bounded.stats().entries, 3);
});

test('retention: LRU touches and primitive receipts identify exact retired generations', () => {
  const pool = new RetentionPool({ maxBytes: 2 * (RETENTION_LIMITS.entryAllowance + 2 * RETENTION_LIMITS.stringAllowance + 2 * 2) });
  const a = admit(pool, 'a', 'a'), b = admit(pool, 'b', 'b');
  pool.visitSnapshots(a, () => {});
  const result = pool.admit('c', 0, 'c');
  assert.deepEqual(result.released.map(item => [item.key, item.generation, item.reason]), [['b', b, 'pressure']]);
  assert.ok(Object.values(result.released[0]!).every(value => typeof value === 'string' || typeof value === 'number'));
  assert.equal(pool.status(b), undefined);
});

test('retention: evicted and cleared generations cannot resurrect via suffix or snapshot replacement', () => {
  const complete = chunk('a', 1, 1, 1, 0, 3, 3, true);
  const maximumEntryBytes = RETENTION_LIMITS.entryAllowance + 2 * RETENTION_LIMITS.stringAllowance + 2 + 6
    + new RangeAccumulator().requiredBytes(complete);
  const pool = new RetentionPool({ maxBytes: maximumEntryBytes });
  const a = admit(pool, 'a', 'a\n');
  pool.installChunk(a, chunk('a', a, 0, 1, 0, 2, 2));
  admit(pool, 'b', '');
  assert.equal(pool.installChunk(a, chunk('a', a, 1, 2, 2, 2, 3)).accepted, false);
  assert.equal(pool.replaceSnapshot(a, 1, 'a\nx').accepted, false);
  const fresh = admit(pool, 'a', 'a\nx', 1);
  assert.ok(fresh > a);
  assert.equal(pool.installChunk(fresh, chunk('a', fresh, 1, 2, 2, 2, 3)).accepted, false);
  assert.equal(pool.installChunk(fresh, chunk('a', fresh, 1, 1, 0, 3, 3, true)).accepted, true);
  const released = pool.clear();
  assert.equal(released.length, 1);
  assert.equal(pool.stats().retainedBytes, 0);
  assert.equal(pool.installChunk(fresh, chunk('a', fresh, 1, 2, 3, 3, 3, true)).accepted, false);
  const next = admit(pool, 'a', 'a\nx', 1);
  assert.ok(next > fresh);
});

test('retention: oversized range admission drops its accumulator before allocation', () => {
  const pool = new RetentionPool({ maxBytes: 2400 });
  const g = admit(pool, 'a', 'x'.repeat(50));
  pool.installChunk(g, chunk('a', g, 0, 1, 0, 0, 50));
  pool.replaceSnapshot(g, 1, 'x'.repeat(100));
  const incoming = chunk('a', g, 1, 2, 0, 0, 100);
  incoming.runs = new Uint32Array(Array.from({ length: 100 }, (_, i) => [i + 1, i % 2]).flat());
  const before = pool.stats().rangeAllocatedBytes;
  const NativeArray = globalThis.Uint32Array;
  let allocations = 0;
  let result;
  try {
    globalThis.Uint32Array = new Proxy(NativeArray, { construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    } });
    result = pool.installChunk(g, incoming);
  } finally { globalThis.Uint32Array = NativeArray; }
  assert.equal(allocations, 0);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.released.map(item => item.generation), [g]);
  assert.equal(pool.stats().rangeAllocatedBytes, before);
  assert.deepEqual(spans(pool, g), []);
  assert.equal(pool.installChunk(g, incoming).accepted, false);
});

test('retention: exact accumulator allowance admits a split suffix without needless LRU eviction', () => {
  const roomy = new RetentionPool();
  const a = admit(roomy, 'a', 'a\nx');
  roomy.installChunk(a, chunk('a', a, 0, 1, 0, 2, 3));
  const b = admit(roomy, 'b', '');
  const exact = roomy.stats().retainedBytes;
  const pool = new RetentionPool({ maxBytes: exact });
  const g = admit(pool, 'a', 'a\nx');
  admit(pool, 'b', '');
  const result = pool.installChunk(g, chunk('a', g, 0, 1, 0, 2, 3));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.released, []);
  assert.equal(pool.stats().entries, 2);
  assert.equal(pool.stats().retainedBytes, exact);
  assert.ok(b > a);
});

test('retention: range pressure evicts the true LRU before allocation, with exact receipts', () => {
  const measure = new RetentionPool();
  const text = 'x'.repeat(100);
  const runs = new Uint32Array(Array.from({ length: 100 }, (_, i) => [i + 1, i % 2]).flat());
  const measured = admit(measure, 'a', text);
  measure.installChunk(measured, { ...chunk('a', measured, 0, 1, 0, 0, 100), runs });
  admit(measure, 'b', '');
  const budget = measure.stats().retainedBytes;
  const pool = new RetentionPool({ maxBytes: budget });
  const a = admit(pool, 'a', text), b = admit(pool, 'b', ''), c = admit(pool, 'c', '');
  const bStatus = pool.status(b)!;
  pool.status(c);
  const result = pool.installChunk(a, { ...chunk('a', a, 0, 1, 0, 0, 100), runs });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.released.map(item => item.generation), [b]);
  assert.equal(result.released[0]!.retainedBytes, bStatus.retainedBytes);
  assert.equal(pool.stats().retainedBytes, budget);
  assert.equal(spans(pool, a).length, 100);
});

test('retention: chunk and bridge arrays are isolated; no buffers or accumulator escape', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'x');
  const incoming = chunk('a', g, 0, 1, 0, 0, 1);
  pool.installChunk(g, incoming);
  incoming.runs.fill(99);
  assert.deepEqual(spans(pool, g), [[0, 1, 1]]);
  const lines = ['colored'];
  pool.installBridge(g, 0, 'x', lines);
  lines[0] = 'mutated'; lines.push('extra');
  const visited: string[] = [];
  pool.visitBridge(g, (index, line) => { assert.equal(index, 0); visited.push(line); });
  assert.deepEqual(visited, ['colored']);
  assert.ok(Object.values(pool.status(g)!).every(value => typeof value !== 'object'));
});

test('retention: stale revisions/generations/versions and inexact native snapshots refuse without mutation', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'x', 2);
  pool.installChunk(g, chunk('a', g, 2, 1, 0, 0, 1));
  const before = pool.status(g);
  assert.equal(pool.installChunk(g, chunk('a', g, 2, 1, 0, 0, 1)).accepted, false);
  assert.equal(pool.installChunk(g, chunk('a', g + 1, 2, 2, 0, 0, 1)).accepted, false);
  assert.equal(pool.installChunk(g, chunk('a', g, 1, 2, 0, 0, 1)).accepted, false);
  assert.equal(pool.replaceSnapshot(g, 1, 'x').accepted, false);
  assert.equal(pool.replaceSnapshot(g, 2, 'wrong').accepted, false);
  assert.equal(pool.installBridge(g, 2, 'wrong', ['wrong']).accepted, false);
  assert.deepEqual(pool.status(g), before);
});

test('retention: bridge is released when its exact snapshot disappears', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'x');
  pool.replaceSnapshot(g, 1, 'xy');
  pool.installBridge(g, 1, 'xy', ['colored']);
  pool.replaceSnapshot(g, 2, 'xyz');
  assert.equal(pool.status(g)!.bridgeBytes, 0);
  pool.installBridge(g, 0, 'x', ['basis']);
  pool.installChunk(g, chunk('a', g, 2, 1, 0, 0, 3));
  assert.equal(pool.status(g)!.bridgeBytes, 0);
});

test('retention: admission precedes bridge-array copy and oversized text does not evict unrelated sources', () => {
  const pool = new RetentionPool({ maxBytes: 1800 });
  const g = admit(pool, 'a', 'x');
  const result = pool.installBridge(g, 0, 'x', ['c'.repeat(1000)]);
  assert.equal(result.accepted, false);
  assert.equal(pool.stats().bridgeLinesCopied, 0);
  const before = pool.stats().retainedBytes;
  assert.equal(pool.admit('b', 0, 'z'.repeat(2000)).accepted, false);
  assert.equal(pool.stats().retainedBytes, before);
});

test('retention: many appends allocate only suffix ranges, never committed prefixes', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'x\n');
  let observedAllocationBytes = 0;
  for (let i = 1; i <= 100; i++) {
    if (i > 1) pool.replaceSnapshot(g, i - 1, 'x\n'.repeat(i));
    const incoming = chunk('a', g, i - 1, i, (i - 1) * 2, i * 2, i * 2);
    const NativeArray = globalThis.Uint32Array;
    try {
      globalThis.Uint32Array = new Proxy(NativeArray, { construct(target, args) {
        const allocated = Reflect.construct(target, args) as Uint32Array;
        observedAllocationBytes += allocated.byteLength;
        return allocated;
      } });
      assert.equal(pool.installChunk(g, incoming).accepted, true);
    } finally { globalThis.Uint32Array = NativeArray; }
  }
  assert.equal(observedAllocationBytes, 800);
  assert.equal(pool.stats().prefixCopiedBytes, 0);
  assert.equal(pool.stats().rangeAllocatedBytes, 800);
  assert.equal(pool.status(g)!.committedChunks, 100);
  assert.equal(spans(pool, g).length, 100);
});

test('retention: remove is exact-generation safe; same-key re-admission releases prior state', () => {
  const pool = new RetentionPool();
  const first = admit(pool, 'a', 'x');
  const result = pool.admit('a', 0, 'y');
  assert.equal(result.released[0]!.generation, first);
  assert.equal(result.released[0]!.reason, 'replaced');
  assert.equal(pool.remove(first).length, 0);
  assert.ok(pool.status(result.generation!));
  assert.equal(pool.remove(result.generation!).length, 1);
  assert.equal(pool.stats().entries, 0);
});

test('retention: generation saturation refuses instead of wrapping, including after clear', () => {
  const pool = new RetentionPool({ maxGeneration: 2 });
  assert.equal(admit(pool, 'a', ''), 1);
  pool.clear();
  assert.equal(admit(pool, 'a', ''), 2);
  assert.equal(pool.admit('b', 0, '').accepted, false);
  assert.equal(pool.stats().entries, 1);
  pool.clear();
  assert.equal(pool.admit('a', 0, '').accepted, false);
  assert.equal(pool.stats().lastGeneration, 2);
});

test('retention: callbacks and caller owners are not stored, and visits stop after retirement', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'xy');
  const incoming = chunk('a', g, 0, 1, 0, 0, 2);
  incoming.runs = new Uint32Array([1, 1, 2, 2]);
  Object.assign(incoming, { owner: { node: 'must not retain' }, callback: () => {} });
  pool.installChunk(g, incoming);
  let calls = 0;
  pool.visitRanges(g, () => { calls++; pool.remove(g); });
  assert.equal(calls, 1);
  assert.equal(pool.stats().entries, 0);
  assert.deepEqual(Object.getOwnPropertyNames(pool), []);
});

function observedUtf8<T>(run: () => T): { value: T; measuredUnits: number; measuredTexts: string[] } {
  const original = Buffer.byteLength;
  const measuredTexts: string[] = [];
  try {
    Buffer.byteLength = new Proxy(original, { apply(target, receiver, args) {
      if (typeof args[0] === 'string') measuredTexts.push(args[0]);
      return Reflect.apply(target, receiver, args);
    } });
    const value = run();
    return { value, measuredUnits: measuredTexts.reduce((sum, text) => sum + text.length, 0), measuredTexts };
  } finally { Buffer.byteLength = original; }
}

function waitingCapture(pool: RetentionPool) {
  const generation = admit(pool, 'a', 'a\n');
  assert.equal(pool.installChunk(generation, chunk('a', generation, 0, 1, 0, 2, 2)).accepted, true);
  pool.replaceSnapshot(generation, 1, 'a\nb');
  pool.replaceSnapshot(generation, 2, 'a\nbc');
  return { generation, reply: chunk('a', generation, 1, 2, 2, 2, 3), capture: { version: 1, text: 'a\nb' } };
}

test('retention I1: dispatched acknowledgement promotes capture while preserving newer waiting text and bridge', () => {
  const pool = new RetentionPool();
  const { generation, reply, capture } = waitingCapture(pool);
  pool.installBridge(generation, 2, 'a\nbc', ['newer waiting bridge']);
  Object.assign(capture, { owner: { node: 'outside retention' } });
  const result = pool.installChunk(generation, reply, capture);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.released, []);
  assert.deepEqual(snapshots(pool, generation), [['basis', 1, 'a\nb'], ['latest', 2, 'a\nbc']]);
  assert.equal(pool.status(generation)!.revision, 2);
  assert.equal(pool.status(generation)!.sourceVersion, 1);
  assert.equal(pool.status(generation)!.latestVersion, 2);
  assert.equal(pool.status(generation)!.bridgeVersion, 2);
  assert.deepEqual(spans(pool, generation), [[0, 2, 1], [2, 3, 1]]);
  capture.text = 'mutated'; capture.version = 99;
  assert.deepEqual(snapshots(pool, generation), [['basis', 1, 'a\nb'], ['latest', 2, 'a\nbc']]);
  assert.equal(pool.installChunk(generation, chunk('a', generation, 2, 3, 2, 2, 4)).accepted, true);
  assert.deepEqual(snapshots(pool, generation), [['basis', 2, 'a\nbc']]);
});

test('retention I1: stale, wrong, nonprefix and future captures refuse without changes', () => {
  const pool = new RetentionPool();
  const { generation, reply, capture } = waitingCapture(pool);
  const before = pool.status(generation);
  for (const wrong of [
    { version: 0, text: 'a\nb' }, { version: 2, text: 'a\nb' },
    { version: 1, text: 'a\nz' }, { version: 1, text: 'z\nb' },
    { version: 1, text: 'a\nbb' }, { version: 1, text: 'a\n' }, { version: 1, text: '' },
    { version: -1, text: 'a\nb' }, { version: 1.5, text: 'a\nb' }
  ]) {
    assert.equal(pool.installChunk(generation, reply, wrong).accepted, false);
    assert.deepEqual(pool.status(generation), before);
  }
  for (const wrong of [
    { ...reply, key: 'wrong' }, { ...reply, generation: generation + 1 },
    { ...reply, revision: 3 }, { ...reply, profile: 'wrong' },
    { ...reply, fingerprint: 'b'.repeat(64) }, { ...reply, lease: 'wrong' },
    { ...reply, replace_from: 0 }, { ...reply, source_version: 3 }, { ...reply, source_bytes: 4 }
  ]) {
    assert.equal(pool.installChunk(generation, wrong, capture).accepted, false);
    assert.deepEqual(pool.status(generation), before);
  }
  assert.equal(pool.installChunk(generation, { ...reply, source_version: 3, source_bytes: 4 }, { version: 3, text: 'a\nbc' }).accepted, false);
  assert.deepEqual(pool.status(generation), before);
  assert.equal(pool.installChunk(generation, reply, capture).accepted, true);
  const after = pool.status(generation);
  assert.equal(pool.installChunk(generation, reply, capture).accepted, false);
  assert.deepEqual(pool.status(generation), after);
  pool.clear();
  assert.equal(pool.installChunk(generation, reply, capture).accepted, false);
});

test('retention I1: optional capture must agree exactly with retained same-version text', () => {
  const pool = new RetentionPool();
  const g = admit(pool, 'a', 'a\n');
  const reply = chunk('a', g, 0, 1, 0, 2, 2);
  assert.equal(pool.installChunk(g, reply, { version: 0, text: 'z\n' }).accepted, false);
  assert.equal(pool.status(g)!.revision, 0);
  assert.equal(pool.installChunk(g, reply, { version: 0, text: 'a\n' }).accepted, true);
  pool.replaceSnapshot(g, 1, 'a\nb');
  assert.equal(pool.installChunk(g, chunk('a', g, 1, 2, 2, 2, 3), { version: 1, text: 'a\nz' }).accepted, false);
});

test('retention I1: Unicode capture prefixes preserve committed coverage and old basis bridge expires', () => {
  const pool = new RetentionPool();
  const basis = 'é\n', captureText = 'é\n😀', latest = 'é\n😀漢';
  const g = admit(pool, 'a', basis);
  pool.installChunk(g, chunk('a', g, 0, 1, 0, 3, 3));
  pool.installBridge(g, 0, basis, ['old basis bridge']);
  pool.replaceSnapshot(g, 1, captureText);
  pool.replaceSnapshot(g, 2, latest);
  const observed = observedUtf8(() => pool.installChunk(g, chunk('a', g, 1, 2, 3, 3, 7), { version: 1, text: captureText }));
  assert.equal(observed.value.accepted, true);
  assert.deepEqual(observed.measuredTexts, ['😀']);
  assert.deepEqual(snapshots(pool, g), [['basis', 1, captureText], ['latest', 2, latest]]);
  assert.equal(pool.status(g)!.bridgeBytes, 0);
  assert.deepEqual(spans(pool, g), [[0, 3, 1], [3, 7, 1]]);
});

test('retention I1: capture admission pressure precedes transfer and range allocation', () => {
  const pool = new RetentionPool({ maxBytes: 1958 });
  const { generation, reply, capture } = waitingCapture(pool);
  const before = pool.stats().rangeAllocatedBytes;
  const NativeArray = globalThis.Uint32Array;
  let allocations = 0;
  let result;
  try {
    globalThis.Uint32Array = new Proxy(NativeArray, { construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    } });
    result = pool.installChunk(generation, reply, capture);
  } finally { globalThis.Uint32Array = NativeArray; }
  assert.equal(result.accepted, false);
  assert.equal(allocations, 0);
  assert.equal(result.released.length, 1);
  assert.equal(result.released[0]!.generation, generation);
  assert.equal(pool.stats().entries, 0);
  assert.equal(pool.stats().rangeAllocatedBytes, before);
  assert.equal(capture.text, 'a\nb');
  assert.equal(pool.installChunk(generation, reply, capture).accepted, false);
});

test('retention I2: append UTF8 measurements count only suffixes and unchanged text does no repeat work', () => {
  const pool = new RetentionPool();
  const observed = observedUtf8(() => {
    const g = admit(pool, 'a', 'a');
    pool.replaceSnapshot(g, 1, 'ab');
    pool.replaceSnapshot(g, 2, 'abc');
    pool.replaceSnapshot(g, 2, 'abc');
    pool.replaceSnapshot(g, 3, 'abc');
    assert.equal(pool.installChunk(g, chunk('a', g, 3, 1, 0, 3, 3, true)).accepted, true);
  });
  assert.equal(observed.measuredUnits, 3);
  assert.deepEqual(observed.measuredTexts, ['a', 'b', 'c']);
});

test('retention I2: many waiting updates measure linear appended units, not the accumulated prefix', () => {
  const pool = new RetentionPool();
  const observed = observedUtf8(() => {
    const g = admit(pool, 'a', 'x');
    for (let i = 2; i <= 100; i++) pool.replaceSnapshot(g, i - 1, 'x'.repeat(i));
  });
  assert.equal(observed.measuredUnits, 100);
  assert.equal(observed.measuredTexts.length, 100);
});

test('retention I2: UTF8 split surrogate join, multibyte suffix, isolated surrogates and rewrites stay exact', () => {
  const cases = [
    { texts: ['é', 'é漢', 'é漢😀'], measured: ['é', '漢', '😀'] },
    { texts: ['x\ud83d', 'x\ud83d\ude00', 'x\ud83d\ude00z'], measured: ['x\ud83d', '\ud83d\ude00', 'z'] },
    { texts: ['\ud83d', '\ud83d\ud83d', '\ud83d\ud83d\ude00'], measured: ['\ud83d', '\ud83d', '\ud83d\ude00'] },
    { texts: ['\ud83d', '\ud83dx', '\ud83dx\udc00'], measured: ['\ud83d', 'x', '\udc00'] },
    { texts: ['ab', 'z', 'zz', 'zz'], measured: ['ab', 'z', 'z', undefined] },
    { texts: ['😀x', '😀'], measured: ['😀x', '😀'] },
    { texts: ['', 'a', 'a', 'ab'], measured: ['', 'a', undefined, 'b'] }
  ];
  for (const { texts, measured } of cases) {
    // Per-prefix oracle uses full Buffer.byteLength outside interception. These are
    // retention length controls, not claims that unpaired text is protocol-decodable.
    for (let last = 0; last < texts.length; last++) {
      const pool = new RetentionPool();
      const expectedBytes = Buffer.byteLength(texts[last]!);
      const observed = observedUtf8(() => {
        const g = admit(pool, 'a', texts[0]!);
        for (let i = 1; i <= last; i++) pool.replaceSnapshot(g, i, texts[i]!);
        assert.equal(pool.installChunk(g, chunk('a', g, last, 1, 0, expectedBytes, expectedBytes, true)).accepted, true);
      });
      const expectedMeasures = measured.slice(0, last + 1).filter(text => text !== undefined);
      // Unchanged text causes no additional call, including with a new version.
      assert.deepEqual(observed.measuredTexts, expectedMeasures);
    }
  }
});


test('retention: ordinary small sources remain retained beyond the old 256-entry ceiling', () => {
  const pool = new RetentionPool();
  const generations: number[] = [];
  for (let i = 0; i < 257; i++) {
    const result = pool.admit(`s${i}`, 0, 'x');
    assert.equal(result.accepted, true);
    assert.deepEqual(result.released, []);
    generations.push(result.generation!);
  }
  assert.equal(pool.stats().entries, 257);
  assert.ok(pool.stats().retainedBytes < RETENTION_LIMITS.maxBytes / 10);
  for (let pass = 0; pass < 3; pass++) {
    for (const generation of generations) assert.deepEqual(snapshots(pool, generation), [['basis', 0, 'x']]);
    assert.equal(pool.stats().lastGeneration, 257);
    assert.equal(pool.stats().rangeAllocatedBytes, 0);
  }
});

test('retention: unrelated admission does not rescan all existing range accounts', () => {
  const pool = new RetentionPool();
  for (let i = 0; i < 6; i++) {
    const key = `r${i}`, generation = admit(pool, key, 'x');
    assert.equal(pool.installChunk(generation, chunk(key, generation, 0, 1, 0, 0, 1)).accepted, true);
  }
  const original = RangeAccumulator.prototype.stats;
  let visits = 0;
  try {
    RangeAccumulator.prototype.stats = function () { visits++; return original.call(this); };
    assert.equal(pool.admit('unrelated', 0, 'x').accepted, true);
    assert.equal(visits, 0, 'byte admission must use the maintained total, not every retained result');
  } finally { RangeAccumulator.prototype.stats = original; }
});


test('retention: maintained byte total stays exact across mutation, replacement and release', () => {
  const pool = new RetentionPool({ maxBytes: 5000 });
  const generations: number[] = [];
  const verify = () => {
    let bytes = 0, entries = 0;
    for (const generation of generations) {
      const status = pool.status(generation);
      if (status) { bytes += status.retainedBytes; entries++; }
    }
    assert.equal(pool.stats().retainedBytes, bytes);
    assert.equal(pool.stats().entries, entries);
    assert.ok(bytes <= 5000);
  };
  const a = admit(pool, 'a', 'a\n'); generations.push(a); verify();
  pool.installChunk(a, chunk('a', a, 0, 1, 0, 2, 2)); verify();
  pool.installBridge(a, 0, 'a\n', ['a', '']); verify();
  pool.replaceSnapshot(a, 1, 'a\nx'); verify();
  pool.installChunk(a, chunk('a', a, 1, 2, 2, 2, 3)); verify();
  const b = admit(pool, 'b', 'x'.repeat(1000)); generations.push(b); verify();
  const replaced = pool.admit('b', 1, 'short');
  generations.push(replaced.generation!);
  assert.deepEqual(replaced.released.map(value => [value.generation, value.reason]), [[b, 'replaced']]); verify();
  pool.remove(a); verify();
  pool.clear(); verify();
  const next = admit(pool, 'b', 'next'); generations.push(next); verify();
});


test('retention: ordinary short-line bridge is admitted by bytes beyond the old row ceiling', () => {
  const pool = new RetentionPool();
  const text = '\n'.repeat(65536), lines = Array<string>(65537).fill('');
  const generation = admit(pool, 'rows', text);
  assert.equal(pool.installBridge(generation, 0, text, lines).accepted, true);
  assert.equal(pool.stats().bridgeLinesCopied, lines.length);
  assert.ok(pool.stats().retainedBytes < RETENTION_LIMITS.maxBytes);
  let visits = 0;
  assert.equal(pool.visitBridge(generation, (index, line) => { assert.equal(index, visits++); assert.equal(line, ''); }), true);
  assert.equal(visits, lines.length);
});

test('default retained policy admits a source just beyond the old snapshot ceiling', () => {
  const pool=new RetentionPool(), text='a'.repeat((1<<20)+1);
  assert.equal(RETENTION_LIMITS.maxBytes,1<<30);
  assert.equal(RETENTION_LIMITS.maxSourceUnits,64<<20);
  const admitted=pool.admit('ordinary',1,text);
  assert.equal(admitted.accepted,true); assert.deepEqual(admitted.released,[]);
  for(let i=0;i<3;i++) assert.equal(pool.visitSnapshots(admitted.generation!,(_kind,_version,value)=>assert.equal(value,text)),true);
  assert.equal(pool.stats().entries,1);
  assert.ok(pool.stats().retainedBytes<4<<20);
  pool.clear(); assert.equal(pool.stats().retainedBytes,0);
});

test('borrowed snapshot exposes cached basis/latest bytes without text measurement', () => {
  const pool=new RetentionPool(), g=admit(pool,'borrowed','a\ud83d',1);
  assert.equal(pool.replaceSnapshot(g,2,'a😀').accepted,true);
  const original=Buffer.byteLength;let measured=0;
  Buffer.byteLength=(...args)=>{measured++;return original(...args);};
  try {
    for(let i=0;i<4;i++) {
      assert.deepEqual(pool.borrowSnapshot(g,'basis'),{version:1,text:'a\ud83d',utf8Bytes:4});
      assert.deepEqual(pool.borrowSnapshot(g),{version:2,text:'a😀',utf8Bytes:5});
    }
    assert.equal(measured,0);
  } finally { Buffer.byteLength=original; }
});

test('borrowed snapshot is a fresh primitive view and never revives a removed generation', () => {
  const pool=new RetentionPool(), g=admit(pool,'borrowed','α',3);
  const a=pool.borrowSnapshot(g)!, b=pool.borrowSnapshot(g)!;
  assert.notEqual(a,b);assert.deepEqual(a,{version:3,text:'α',utf8Bytes:2});
  Object.assign(a,{text:'tampered',version:99,utf8Bytes:999});
  assert.deepEqual(pool.borrowSnapshot(g),b);
  const text='αβ', bytes=Buffer.byteLength(text);
  pool.replaceSnapshot(g,4,text);pool.installChunk(g,chunk('borrowed',g,4,1,0,bytes,bytes));
  assert.deepEqual(pool.borrowSnapshot(g,'basis'),{version:4,text,utf8Bytes:bytes});
  assert.deepEqual(pool.borrowSnapshot(g),pool.borrowSnapshot(g,'basis'));
  pool.remove(g);assert.equal(pool.borrowSnapshot(g),undefined);
  const next=admit(pool,'borrowed','new',5);assert.notEqual(next,g);
  assert.equal(pool.borrowSnapshot(g,'basis'),undefined);
  pool.clear();assert.equal(pool.borrowSnapshot(next),undefined);
});
