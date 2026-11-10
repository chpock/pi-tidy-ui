import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/highlighting/limits.ts';
import { decodeContextBatch, decodeStyleResult, SemanticError, type SemanticDecodeLimits } from '../../../src/occipital/semantic-codec.ts';
import { decodeSemanticDescription, decodeSemanticSourceReply } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { ContextArena } from '../../../src/highlighting/storage/context-arena.ts';
import { decodeSemanticSources } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64);
const bounds = { vocabularySize: 1, maxBytes: OCCIPITAL_LIMITS.retainedBytes };
const sourceIdentity = { vocabulary, vocabularySize: 2, sourceBytes: HIGHLIGHT_LIMITS.sourceBytes, runs: OCCIPITAL_LIMITS.runs, batchSources: 8 };
const sourceExpected = (key = 'a', replacementText = 'abcde') => ({ key, generation: 1, source_version: 1, revision: 1,
  source_bytes: Buffer.byteLength(replacementText), replace_from: 0, complete: true, replacementText });
const wireSource = (key = 'a', patch: Record<string, unknown> = {}) => ({ key, generation: 1, source_version: 1, revision: 1,
  source_bytes: 5, replace_from: 0, committed_bytes: 5, complete: true, contexts: [[0, 1], [1, 2]], runs: [2, 1, 2, 2, 1, 0],
  counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 5 }, ...patch });
const sourceBody = (...sources: ReturnType<typeof wireSource>[]) => ({ kind: 'source', vocabulary, sources });
const limit = (code: string) => (error: unknown) => error instanceof SemanticError && error.code === code;
function withoutTypedAllocation(action: () => void) {
  const original = globalThis.Uint32Array;
  globalThis.Uint32Array = new Proxy(original, { construct() { assert.fail('rejected input allocated a typed vector'); } });
  try { action(); } finally { globalThis.Uint32Array = original; }
}

test('highlight and carrier limits match the shared cross-language fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/highlighting-limits.json', import.meta.url), 'utf8'));
  assert.deepEqual(HIGHLIGHT_LIMITS, fixture);
  assert.equal(OCCIPITAL_LIMITS.dataWireBytes, fixture.dataWireBytes);
});

test('highlight limits: expanded words are aggregate across sources, checked before vectors', () => {
  const half = [0, ...Array(32768).fill(1)];
  assert.equal(decodeContextBatch([[half], [half]], bounds, HIGHLIGHT_LIMITS).words, 65536);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[half], [half, [1]]], bounds, HIGHLIGHT_LIMITS), limit('context_limit')));
  const repeated = [[0, ...Array(256).fill(1)], ...Array.from({ length: 255 }, () => [256])];
  assert.equal(decodeContextBatch([repeated], bounds, HIGHLIGHT_LIMITS).words, 65536);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[...repeated, [1]]], bounds, HIGHLIGHT_LIMITS), limit('context_limit')));
});

test('highlight limits: empty contexts still consume aggregate decoded policy units', () => {
  const empty = Array.from({ length: HIGHLIGHT_LIMITS.decodedBytes / 128 }, () => [0]);
  assert.equal(decodeContextBatch([empty], bounds, HIGHLIGHT_LIMITS).policyBytes, HIGHLIGHT_LIMITS.decodedBytes);
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([empty, [[0]]], bounds, HIGHLIGHT_LIMITS), limit('context_limit')));
  assert.throws(() => decodeContextBatch([[[0]]], { ...bounds, maxBytes: 127 }, HIGHLIGHT_LIMITS), limit('context_limit'));
});

test('highlight limits: STYLE decoded cap is separate from generous retention and includes indices', () => {
  const style = { foreground: { kind: 'terminal-default' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 };
  const indices = Array((HIGHLIGHT_LIMITS.decodedBytes - 256) / 4).fill(1);
  const body = { kind: 'styles', vocabulary, rules, styles: [style], indices };
  const identity = { vocabulary, rules, bindingSlots: 0 };
  assert.equal(decodeStyleResult(body, identity, indices.length, bounds.maxBytes, HIGHLIGHT_LIMITS).policyBytes, HIGHLIGHT_LIMITS.decodedBytes);
  withoutTypedAllocation(() => assert.throws(() => decodeStyleResult({ ...body, indices: [...indices, 1] }, identity, indices.length + 1, bounds.maxBytes, HIGHLIGHT_LIMITS), limit('style_limit')));
  assert.throws(() => decodeStyleResult({ ...body, indices: [1] }, identity, 1, 259, HIGHLIGHT_LIMITS), limit('style_limit'));
});

test('highlight limits: SOURCE decoded cap includes source metadata and runs before vectors', () => {
  const contexts = Array.from({ length: HIGHLIGHT_LIMITS.decodedBytes / 128 }, () => [0]);
  const expected = { key: 'a', generation: 1, source_version: 1, revision: 1, source_bytes: 1, replace_from: 0, complete: true, replacementText: 'x' };
  const source = { ...expected, contexts, committed_bytes: 1, runs: [1, 1], counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
  Reflect.deleteProperty(source, 'replacementText');
  const identity = { vocabulary, vocabularySize: 1, sourceBytes: HIGHLIGHT_LIMITS.sourceBytes, runs: OCCIPITAL_LIMITS.runs, batchSources: 8 };
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources({ kind: 'source', vocabulary, sources: [source] }, identity, [expected], bounds.maxBytes, HIGHLIGHT_LIMITS), limit('source_limit')));
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


const decodePolicy = (patch: Partial<SemanticDecodeLimits> = {}): SemanticDecodeLimits => ({ ...HIGHLIGHT_LIMITS, ...patch });

test('highlight limits: explicit decoder policies reject smaller context, STYLE and SOURCE budgets before vectors', () => {
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[[0], [0]]], bounds,
    decodePolicy({ decodedBytes: 128 })), limit('context_limit')));
  withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[[0, 1, 1]]], bounds,
    decodePolicy({ contextWords: 1 })), limit('context_limit')));
  const style = { foreground: { kind: 'terminal-default' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 };
  const styleBody = { kind: 'styles', vocabulary, rules, styles: [style], indices: [1] };
  withoutTypedAllocation(() => assert.throws(() => decodeStyleResult(styleBody, { vocabulary, rules, bindingSlots: 0 }, 1, 1024,
    decodePolicy({ decodedBytes: 259 })), limit('style_limit')));
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources(sourceBody(wireSource()), sourceIdentity, [sourceExpected()], bounds.maxBytes,
    decodePolicy({ sourceBytes: 4 })), limit('invalid_source')));
});

test('highlight limits: zero SOURCE coverage admits only funded empty sources through leaf and reply decoders', () => {
  const policy = decodePolicy({ sourceBytes: 0, contextWords: 0 });
  const expected = sourceExpected('empty', '');
  const empty = sourceBody(wireSource('empty', { source_bytes: 0, committed_bytes: 0, contexts: [], runs: [],
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }));
  const provider = decodeSemanticDescription(semanticDescriptor('describe-zero', 'peer'), 'describe-zero');
  const reply = { v: 4, ticket: 'source-zero', instance: provider.instance, assets: provider.assets, status: 'ok', body: empty };
  const direct = decodeSemanticSources(empty, sourceIdentity, [expected], 1024, policy);
  assert.equal(direct.sources[0]!.source_bytes, 0);
  assert.deepEqual(decodeSemanticSourceReply(reply, 'source-zero', provider, [expected], 1024, policy), direct);
  const effectiveIdentity = { ...sourceIdentity, sourceBytes: 0 };
  assert.deepEqual(decodeSemanticSources(empty, effectiveIdentity, [expected], 1024, policy), direct);
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources(sourceBody(wireSource()), effectiveIdentity,
    [sourceExpected()], 1024, policy), limit('invalid_source')));
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSourceReply({ ...reply, body: sourceBody(wireSource()) },
    'source-zero', provider, [sourceExpected()], 1024, policy), limit('invalid_source')));
  withoutTypedAllocation(() => assert.throws(() => decodeSemanticSourceReply(reply, 'source-zero', provider,
    [expected], 0, policy), limit('source_limit')));
  const zeroDescriptor = semanticDescriptor('describe-invalid-zero', 'peer');
  zeroDescriptor.body.limits.source_bytes = 0;
  assert.throws(() => decodeSemanticDescription(zeroDescriptor, 'describe-invalid-zero'), /invalid_descriptor/);
});

test('highlight limits: safe-integer policy ceilings accept small payloads without enlarging caller funding', () => {
  const maximum = Number.MAX_SAFE_INTEGER, policy = decodePolicy({ sourceBytes: maximum, contextWords: maximum, decodedBytes: maximum });
  assert.equal(decodeContextBatch([[[0]]], bounds, policy).policyBytes, 128);
  assert.equal(decodeStyleResult({ kind: 'styles', vocabulary, rules, styles: [
    { foreground: { kind: 'terminal-default' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 },
  ], indices: [1] }, { vocabulary, rules, bindingSlots: 0 }, 1, 1024, policy).policyBytes, 260);
  assert.equal(decodeSemanticSources(sourceBody(wireSource()), sourceIdentity, [sourceExpected()], bounds.maxBytes, policy).sources.length, 1);
});

test('highlight limits: each consumed decoder bound rejects invalid and unsafe policy values', () => {
  for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[[0]]], bounds,
      decodePolicy({ contextWords: invalid })), limit('invalid_context')));
    withoutTypedAllocation(() => assert.throws(() => decodeContextBatch([[[0]]], bounds,
      decodePolicy({ decodedBytes: invalid })), limit('invalid_context')));
    withoutTypedAllocation(() => assert.throws(() => decodeStyleResult(
      { kind: 'styles', vocabulary, rules, styles: [], indices: [] }, { vocabulary, rules, bindingSlots: 0 }, 0, bounds.maxBytes,
      decodePolicy({ decodedBytes: invalid })), limit('invalid_style')));
    withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources(sourceBody(wireSource()), sourceIdentity, [sourceExpected()], bounds.maxBytes,
      decodePolicy({ sourceBytes: invalid })), limit('invalid_source')));
    withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources(sourceBody(wireSource()), sourceIdentity, [sourceExpected()], bounds.maxBytes,
      decodePolicy({ decodedBytes: invalid })), limit('invalid_source')));
    withoutTypedAllocation(() => assert.throws(() => decodeSemanticSources(sourceBody(wireSource()), sourceIdentity, [sourceExpected()], bounds.maxBytes,
      decodePolicy({ contextWords: invalid })), limit('invalid_context')));
  }
});

test('highlight limits: generic SOURCE and context bounds can exceed the former highlighting defaults', () => {
  const sourceBytes = HIGHLIGHT_LIMITS.sourceBytes + 1, text = 'x'.repeat(sourceBytes);
  const largeExpected = sourceExpected('large', text);
  const largeSource = wireSource('large', { source_bytes: sourceBytes, committed_bytes: sourceBytes, contexts: [[0, 1]], runs: [sourceBytes, 1],
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: sourceBytes } });
  const policy = decodePolicy({ sourceBytes }), identity = { ...sourceIdentity, sourceBytes };
  const decoded = decodeSemanticSources(sourceBody(largeSource), identity, [largeExpected], bounds.maxBytes, policy);
  assert.equal(decoded.sources[0]!.source_bytes, sourceBytes);

  const largerDescriptor = semanticDescriptor('describe-large', 'peer');
  Object.assign(largerDescriptor.body.limits, { source_bytes: sourceBytes });
  const largerProvider = decodeSemanticDescription(largerDescriptor, 'describe-large');
  const reply = { v: 4, ticket: 'source-ticket', instance: largerProvider.instance, assets: largerProvider.assets, status: 'ok', body: sourceBody(largeSource) };
  assert.equal(decodeSemanticSourceReply(reply, 'source-ticket', largerProvider, [largeExpected], bounds.maxBytes, policy).sources[0]!.source_bytes, sourceBytes);

  const defaultProvider = decodeSemanticDescription(semanticDescriptor('describe-default', 'peer'), 'describe-default');
  const defaultCapReply = { ...reply, ticket: 'source-default-cap', instance: defaultProvider.instance, assets: defaultProvider.assets };
  assert.throws(() => decodeSemanticSourceReply(defaultCapReply, 'source-default-cap', defaultProvider, [largeExpected], bounds.maxBytes, policy),
    limit('invalid_source'));

  const words = HIGHLIGHT_LIMITS.contextWords + 1, row = [0, ...Array(words).fill(1)];
  const contexts = decodeContextBatch([[row]], bounds, decodePolicy({ contextWords: words }));
  assert.equal(contexts.words, words);
});

test('highlight limits: generic STYLE decoded budget can exceed the former two-megabyte clamp', () => {
  const count = Math.ceil(HIGHLIGHT_LIMITS.decodedBytes / 260),
    styles = Array.from({ length: count }, (_, index) => ({ foreground: { kind: 'rgb', r: 0, g: Math.floor(index / 256), b: index % 256 },
      background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 })),
    indices = Array.from({ length: count }, (_, index) => index + 1);
  const result = decodeStyleResult({ kind: 'styles', vocabulary, rules, styles, indices }, { vocabulary, rules, bindingSlots: 0 }, count,
    bounds.maxBytes, decodePolicy({ decodedBytes: HIGHLIGHT_LIMITS.decodedBytes + 65536 }));
  assert.equal(result.policyBytes, count * 260);
  assert.ok(result.policyBytes > HIGHLIGHT_LIMITS.decodedBytes);
});

test('highlight limits: reply identity validation precedes invalid decoder policy values', () => {
  const policy = decodePolicy({ decodedBytes: NaN });
  assert.throws(() => decodeStyleResult({ kind: 'styles', vocabulary, rules: 'c'.repeat(64), styles: [], indices: [] },
    { vocabulary, rules, bindingSlots: 0 }, 0, bounds.maxBytes, policy), limit('identity_mismatch'));
});
