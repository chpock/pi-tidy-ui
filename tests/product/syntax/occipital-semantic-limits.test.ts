import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import { decodeContextBatch, decodeStyleResult, SemanticError } from '../../../src/occipital/semantic-codec.ts';
import { ContextArena } from '../../../src/occipital/context-arena.ts';
import { decodeSemanticSources } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64);
const bounds = { vocabularySize: 1, maxBytes: OCCIPITAL_LIMITS.retainedBytes };
const limit = (code: string) => (error: unknown) => error instanceof SemanticError && error.code === code;
function withoutTypedAllocation(action: () => void) {
  const original = globalThis.Uint32Array;
  globalThis.Uint32Array = new Proxy(original, { construct() { assert.fail('rejected input allocated a typed vector'); } });
  try { action(); } finally { globalThis.Uint32Array = original; }
}

test('highlight limits: exported numeric policy matches the shared fixture', () => {
  assert.deepEqual(HIGHLIGHT_LIMITS, JSON.parse(readFileSync(new URL('../../../protocol/syntax-v3/highlighting-limits.json', import.meta.url), 'utf8')));
});

test('highlight limits: expanded words are aggregate across sources, checked before vectors', () => {
  const half = [0, ...Array(32768).fill(1)];
  assert.equal(decodeContextBatch([[half], [half]], bounds).words, 65536);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[half], [half, [1]]], bounds), limit('context_limit')));
  const repeated = [[0, ...Array(256).fill(1)], ...Array.from({ length: 255 }, () => [256])];
  assert.equal(decodeContextBatch([repeated], bounds).words, 65536);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[...repeated, [1]]], bounds), limit('context_limit')));
});

test('highlight limits: empty contexts still consume aggregate decoded policy units', () => {
  const empty = Array.from({ length: HIGHLIGHT_LIMITS.decodedBytes / 128 }, () => [0]);
  assert.equal(decodeContextBatch([empty], bounds).policyBytes, HIGHLIGHT_LIMITS.decodedBytes);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([empty, [[0]]], bounds), limit('context_limit')));
  assert.throws(() => decodeContextBatch([[[0]]], { ...bounds, maxBytes: 127 }), limit('context_limit'));
});

test('highlight limits: STYLE decoded cap is separate from generous retention and includes indices', () => {
  const style = { foreground: { kind: 'terminal-default' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 };
  const indices = Array((HIGHLIGHT_LIMITS.decodedBytes - 256) / 4).fill(1);
  const body = { kind: 'styles', vocabulary, rules, styles: [style], indices, palette: null };
  const identity = { vocabulary, rules, mode: 'client' as const, bindingSlots: 0 };
  assert.equal(decodeStyleResult(body, identity, indices.length, bounds.maxBytes).policyBytes, HIGHLIGHT_LIMITS.decodedBytes);
  withoutTypedAllocation(() => assert.throws(() => decodeStyleResult({ ...body, indices: [...indices, 1] }, identity, indices.length + 1, bounds.maxBytes), limit('style_limit')));
  assert.throws(() => decodeStyleResult({ ...body, indices: [1] }, identity, 1, 259), limit('style_limit'));
});

test('highlight limits: SOURCE decoded cap includes source metadata and runs before vectors', () => {
  const contexts = Array.from({ length: HIGHLIGHT_LIMITS.decodedBytes / 128 }, () => [0]);
  const expected = { key: 'a', generation: 1, source_version: 1, revision: 1, source_bytes: 1, replace_from: 0, complete: true, replacementText: 'x' };
  const source = { ...expected, contexts, committed_bytes: 1, runs: [1, 1], counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
  Reflect.deleteProperty(source, 'replacementText');
  const identity = { vocabulary, vocabularySize: 1, sourceBytes: HIGHLIGHT_LIMITS.sourceBytes, runs: OCCIPITAL_LIMITS.runs, batchSources: 8 };
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources({ kind: 'source', vocabulary, sources: [source] }, identity, [expected], bounds.maxBytes), limit('source_limit')));
});

test('highlight limits: arena STYLE encoding bounds expanded front-coded words before allocation/reservation', () => {
  const arena = new ContextArena();
  const lease = arena.adopt(vocabulary, [[new Uint32Array(32768).fill(1), new Uint32Array(32768).fill(1)]], () => true)!;
  try {
    const refs = lease.batches[0]!;
    let callbacks = 0;
    assert.deepEqual(arena.encode(vocabulary, [], () => { callbacks++; return true; }, 0), []);
    assert.equal(arena.encode(vocabulary, refs, () => { callbacks++; return true; }, 65535), undefined);
    assert.equal(callbacks, 1, 'over-limit contexts never request an allocation grant');
    assert.equal(arena.encode(vocabulary, refs, () => true, 65536)?.[1]?.[0], 32768);
    assert.equal(arena.encode(vocabulary, refs, () => false, 65536), undefined);
    assert.equal(arena.encode(vocabulary, refs, () => true, 65536)?.length, 2, 'refusal leaves handles usable');
  } finally { lease.release(); arena.dispose(); }
});

test('highlight limits: bounded arena encoding revalidates handles after a reentrant grant callback', () => {
  const arena = new ContextArena();
  const lease = arena.adopt(vocabulary, [[new Uint32Array([1])]], () => true)!;
  const refs = lease.batches[0]!;
  assert.throws(() => arena.encode(vocabulary, refs, () => { lease.release(); return true; }, 1), SemanticError);
  assert.equal(arena.stats().contexts, 0); assert.equal(arena.stats().retainedBytes, 0);
  assert.equal(arena.budget.stats().outstandingPeakBytes, 0); arena.dispose();
});
