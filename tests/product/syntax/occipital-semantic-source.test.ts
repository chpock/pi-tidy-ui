import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';
import { decodeSemanticSources, type SemanticExpectation } from '../../../src/occipital/semantic-source.ts';

const identity = { vocabulary: 'a'.repeat(64), vocabularySize: 20, sourceBytes: 64 * 1024 * 1024, runs: (64 << 20) / 4, batchSources: 8 };
const expected = (key = 'a', replacementText = 'αX\np', patch: Partial<SemanticExpectation> = {}): SemanticExpectation => ({
  key, generation: 1, source_version: 1, revision: 1, source_bytes: Buffer.byteLength(replacementText), replace_from: 0,
  complete: true, replacementText, ...patch,
});
type WireSource = Record<string, unknown> & { contexts: number[][]; runs: number[]; complete: boolean; committed_bytes: number; lease?: string };
const source = (key = 'a', patch: Record<string, unknown> = {}): WireSource => ({ key, generation: 1, source_version: 1, revision: 1,
  source_bytes: 5, replace_from: 0, committed_bytes: 5, complete: true,
  contexts: [[0, 1], [1, 2]], runs: [2, 1, 2, 2, 1, 0],
  counters: { committed_line_calls: 1, committed_line_bytes: 4, tail_calls: 1, tail_bytes: 1 }, ...patch });
const body = (...sources: ReturnType<typeof source>[]) => ({ kind: 'source', vocabulary: identity.vocabulary, sources });
const clone = <T>(value: T): T => structuredClone(value);
function noMaterialization(run: () => void) {
  const original = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try { run(); assert.equal(allocations, 0, 'no owned word or range vector before whole-batch validation'); }
  finally { globalThis.Uint32Array = original; }
}

test('semantic sources: current text and ordered full contexts are independent of theme, with context0 unclassified', () => {
  const raw = body(source()), result = decodeSemanticSources(raw, identity, [expected()], 1 << 20);
  assert.deepEqual([...result.sources[0]!.runs], [2, 1, 4, 2, 5, 0]);
  assert.deepEqual(result.sources[0]!.contexts.map(words => [...words]), [[1], [1, 2]]);
  assert.equal(result.sources[0]!.source_version, 1);
  assert.equal(result.sources[0]!.vocabulary, identity.vocabulary);
  assert.ok(!Object.hasOwn(result.sources[0]!, 'profile'));
  assert.ok(!Object.hasOwn(result.sources[0]!, 'fingerprint'));
  raw.sources[0]!.runs[0] = 99; raw.sources[0]!.contexts[0]![1] = 9;
  assert.equal(result.sources[0]!.runs[0], 2); assert.equal(result.sources[0]!.contexts[0]![0], 1);
});

test('semantic sources: malformed later UTF8/range/context data reject before any source vector materializes', () => {
  const errors = [ { runs: [1, 1, 4, 2] }, { runs: [5, 3] }, { runs: [2, 1, 2, 1, 1, 0] },
    { contexts: [[0, 21]] }, { contexts: [[1, 1]] }, { runs: [4, 1] }, { committed_bytes: 4 } ];
  for (const patch of errors) noMaterialization(() => {
    assert.throws(() => decodeSemanticSources(body(source('a'), source('b', patch)), identity, [expected('a'), expected('b')], 1 << 20));
  });
});

test('semantic sources: retained budget includes context expansion and range vectors across the entire batch', () => {
  const raw = body(source('a'), source('b'));
  const result = decodeSemanticSources(raw, identity, [expected('a'), expected('b')], 1 << 20);
  assert.ok(result.policyBytes >= 2 * (2 * 128 + 3 * 16 + 6 * 4));
  assert.equal(decodeSemanticSources(raw, identity, [expected('a'), expected('b')], result.policyBytes).policyBytes, result.policyBytes);
  noMaterialization(() => assert.throws(() => decodeSemanticSources(raw, identity, [expected('a'), expected('b')], result.policyBytes - 1)));
});

test('semantic sources: a partial suffix commits only through its last newline and finalization preserves lease authority', () => {
  const input = expected('a', 'αX\np', { revision: 2, source_version: 3, replace_from: 8, source_bytes: 13, complete: false, lease: 'lease-a' });
  const raw = body(source('a', { revision: 2, source_version: 3, replace_from: 8, source_bytes: 13, committed_bytes: 12, complete: false, lease: 'lease-a' }));
  const result = decodeSemanticSources(raw, identity, [input], 1 << 20);
  assert.deepEqual([...result.sources[0]!.runs], [10, 1, 12, 2, 13, 0]);
  const final = clone(raw); final.sources[0]!.complete = true; final.sources[0]!.committed_bytes = 13;
  assert.equal(decodeSemanticSources(final, identity, [{ ...input, complete: true }], 1 << 20).sources[0]!.lease, 'lease-a');
  const wrong = clone(raw); wrong.sources[0]!.lease = 'other';
  assert.throws(() => decodeSemanticSources(wrong, identity, [input], 1 << 20));
  assert.throws(() => decodeSemanticSources(raw, identity, [expected('a', 'αX\np', { revision: 2, source_version: 3, replace_from: 8, source_bytes: 13 })], 1 << 20));
});

test('semantic sources: startup leases, parsed-empty and unsupported/empty finite sources stay distinct', () => {
  const open = body(source('a', { complete: false, committed_bytes: 4, lease: 'new-lease' }));
  assert.equal(decodeSemanticSources(open, identity, [expected('a', 'αX\np', { complete: false })], 1 << 20).sources[0]!.lease, 'new-lease');
  const empty = body(source('a', { source_bytes: 0, committed_bytes: 0, contexts: [], runs: [] }));
  assert.equal(decodeSemanticSources(empty, identity, [expected('a', '')], 1 << 20).sources[0]!.contexts.length, 0);
  const parsed = body(source('a', { contexts: [[0]], runs: [5, 1] }));
  assert.equal(decodeSemanticSources(parsed, identity, [expected()], 1 << 20).sources[0]!.contexts[0]!.length, 0);
  const unknown = body(source('a', { contexts: [], runs: [5, 0] }));
  assert.equal(decodeSemanticSources(unknown, identity, [expected()], 1 << 20).sources[0]!.runs[1], 0);
});

test('semantic sources: identity, exact schema, finite coverage and duplicate keys do not accept old theme-coupled replies', () => {
  for (const patch of [{ vocabulary: identity.vocabulary }, { profile: 'pi' }, { fingerprint: 'b'.repeat(64) }, { revision: 2 }, { generation: 2 }, { key: 'wrong' },
    { source_version: 0 }, { complete: false }, { counters: { committed_line_calls: -1 } }]) {
    assert.throws(() => decodeSemanticSources(body(source('a', patch)), identity, [expected()], 1 << 20));
  }
  assert.throws(() => decodeSemanticSources({ ...body(source()), vocabulary: 'b'.repeat(64) }, identity, [expected()], 1 << 20));
  assert.throws(() => decodeSemanticSources(body(source('a'), source('a')), identity, [expected('a'), expected('b')], 1 << 20));
  assert.throws(() => decodeSemanticSources(body(source('a'), source('b')), identity, [expected('a'), expected('a')], 1 << 20));
  assert.throws(() => decodeSemanticSources(body(source()), identity, [expected('a', '\ud800X\np')], 1 << 20));
});

test('semantic sources: two aggregate32KiB positions admit exact three-byte patches without encoding a prefix', () => {
  const size = HIGHLIGHT_LIMITS.sourceBytes / 2;
  const demands = ['left', 'right'].map(key => expected(key, 'xyz', { source_bytes: size, replace_from: size - 3 }));
  const values = demands.map(item => source(item.key, { source_bytes: size, replace_from: size - 3, committed_bytes: size, contexts: [[0, 1]], runs: [3, 1] }));
  const result = decodeSemanticSources(body(...values), identity, demands, 1 << 20);
  assert.equal(result.sources.length, 2);
  for (const value of result.sources) { assert.equal(value.runs.byteLength, 8); assert.equal(value.runs[0], size); }
});
