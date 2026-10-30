import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeContextBatch, decodeStyleResult, SemanticError, type StyleIdentity } from '../../../src/occipital/semantic-codec.ts';

const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64);
const bounds = { vocabularySize: 20, maxBytes: 1 << 20 };
const client: StyleIdentity = { vocabulary, rules, bindingSlots: 4 };
const rgb = { kind: 'rgb', r: 10, g: 20, b: 30 };
const literal = { foreground: rgb, background: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 31 };
const binding = { foreground: { kind: 'binding', slot: 2 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 8 };
const body = (styles: unknown[] = [literal, binding]) => ({ kind: 'styles', vocabulary, rules, styles, indices: [1, 2, 1] });
const error = (code: string) => (value: unknown) => value instanceof SemanticError && value.code === code;

function allocationsDuring(fn: () => void): number {
  const original = globalThis.Uint32Array;
  let allocated = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocated++; return Reflect.construct(target, args); } });
  try { fn(); } finally { globalThis.Uint32Array = original; }
  return allocated;
}

test('semantic contexts: full ordered nesting, repeats, pops and parsed-empty remain distinct from unclassified zero', () => {
  const value = decodeContextBatch([[[0], [0, 2], [1, 3], [2, 3], [1], [0]]], bounds);
  assert.deepEqual(value.batches[0]!.map(path => [...path]), [[], [2], [2, 3], [2, 3, 3], [2], []]);
  assert.equal(value.words, 7);
  assert.equal(value.policyBytes, 6 * 128 + 7 * 16);
  assert.equal(value.batches[0]![0]!.length, 0, 'parsed-empty is a real positive table entry');
});

for (const [rows, code] of [
  [[[1]], 'invalid_context'], [[[]], 'invalid_context'], [[[0, 0]], 'unknown_scope'],
  [[[0, 21]], 'unknown_scope'], [[[0, 1.5]], 'unknown_scope'], [[[0, 1], [2]], 'invalid_context'],
  [[[0, 1], [1, -1]], 'unknown_scope'], [[[0, 1], [NaN]], 'invalid_context'],
  [[[0, 1], null], 'invalid_context'],
] as const) test(`semantic contexts: malformed descriptor rejects ${JSON.stringify(rows)}`, () => {
  assert.throws(() => decodeContextBatch([rows], bounds), error(code));
});

test('semantic contexts: the whole batch and expanded policy cost are checked before typed materialization', () => {
  assert.equal(allocationsDuring(() => assert.throws(() => decodeContextBatch([[[0, 1]], [[0, 21]]], bounds), error('unknown_scope'))), 0);
  const rows = [[0, 1, 2, 3], [3], [3]];
  assert.throws(() => decodeContextBatch([rows], { ...bounds, maxBytes: 3 * 128 + 8 * 16 }), error('context_limit'));
  assert.equal(decodeContextBatch([rows], { ...bounds, maxBytes: 3 * 128 + 9 * 16 }).words, 9);
  assert.equal(allocationsDuring(() => assert.throws(() => decodeContextBatch([[[0], [0]], [[0]]], { ...bounds, maxBytes: 2 * 128 }), error('context_limit'))), 0);
  assert.equal(decodeContextBatch([[[0], [0]]], { ...bounds, maxBytes: 2 * 128 }).policyBytes, 256);
});

test('semantic styles: literal, binding, caller-inherit and explicit faint-clear authority survive independently', () => {
  const inherited = { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 };
  const value = decodeStyleResult({ ...body([literal, binding, inherited]), indices: [1, 2, 3, 1] }, client, 4, 1 << 20);
  assert.deepEqual(value.styles, [literal, binding, inherited]);
  assert.deepEqual([...value.indices], [1, 2, 3, 1]);
  assert.equal(value.styles[1]!.attribute_mask, 8);
  assert.equal(value.styles[2]!.attribute_mask, 0);
  assert.equal(Object.hasOwn(value, 'palette'), false);
});

for (const style of [
  { ...literal, attributes: 32 }, { ...literal, attribute_mask: 32 }, { ...literal, attributes: 1, attribute_mask: 0 },
  { ...literal, foreground: { ...rgb, r: 256 } }, { ...literal, foreground: { kind: 'index', index: -1 } },
  { ...literal, foreground: { kind: 'binding', slot: 4 } }, { ...literal, foreground: { kind: 'rgb', r: 1, g: 2, b: 3, a: 0 } },
  { ...literal, foreground: { kind: 'terminal-default', rgb: [1, 2, 3] } }, { ...literal, role: 'syntaxKeyword' },
] as const) test(`semantic styles: malformed expression rejects ${JSON.stringify(style)}`, () => {
  assert.throws(() => decodeStyleResult({ ...body([style]), indices: [1] }, client, 1, 1 << 20), error('invalid_style'));
});

test('semantic styles: identities, cardinality, unique/referenced entries and all final indices validate before adoption', () => {
  for (const value of [
    { ...body(), vocabulary: 'd'.repeat(64) }, { ...body(), rules: 'd'.repeat(64) },
  ]) assert.throws(() => decodeStyleResult(value, client, 3, 1 << 20), error('identity_mismatch'));
  for (const value of [
    { ...body(), indices: [1, 2] }, { ...body(), indices: [1, 2, 0] }, { ...body(), indices: [1, 2, 3] },
    { ...body(), indices: [1, 1, 1] }, { ...body([literal, { ...literal }]), indices: [1, 2, 1] },
    { ...body(), indices: [1, 2, NaN] },
  ]) assert.equal(allocationsDuring(() => assert.throws(() => decodeStyleResult(value, client, 3, 1 << 20), error('invalid_style'))), 0);
  assert.throws(() => decodeStyleResult(body(), client, 3, 1), error('style_limit'));
});

test('semantic styles: empty results remain palette-free', () => {
  const result = decodeStyleResult({ ...body([]), indices: [] }, { ...client, bindingSlots: 0 }, 0, 1 << 20);
  assert.equal(result.styles.length, 0);
  assert.equal(result.indices.length, 0);
  assert.equal(Object.hasOwn(result, 'palette'), false);
});

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/vectors.json', import.meta.url), 'utf8'));
for (const vector of vectors.contexts) test(`v4 shared vector: ${vector.name}`, () => {
  const limit = { vocabularySize: vectors.vocabulary_size, maxBytes: vector.max_bytes ?? bounds.maxBytes };
  if (vector.error) assert.throws(() => decodeContextBatch([vector.encoded], limit), error(vector.error));
  else {
    const decoded = decodeContextBatch([vector.encoded], limit);
    assert.deepEqual(decoded.batches[0]!.map(path => [...path]), vector.decoded);
    assert.equal(decoded.words, vector.words);
    assert.equal(decoded.policyBytes, vector.policy_bytes);
  }
});
for (const vector of vectors.styles) test(`v4 shared vector: ${vector.name}`, () => {
  const identity = { vocabulary, rules, bindingSlots: vector.binding_slots };
  if (vector.error) assert.throws(() => decodeStyleResult(vector.body, identity, vector.context_count, 1 << 20), error(vector.error));
  else {
    const decoded = decodeStyleResult(vector.body, identity, vector.context_count, 1 << 20);
    assert.deepEqual(decoded.styles, vector.body.styles);
    assert.deepEqual([...decoded.indices], vector.body.indices);
    assert.equal(Object.hasOwn(decoded, 'palette'), false);
  }
});

test('semantic styles: binding IDs stay uint16 and five-bit attributes are validated', () => {
  const oversized = { ...literal, foreground: { kind: 'binding', slot: 65536 } };
  assert.throws(() => decodeStyleResult({ ...body([oversized]), indices: [1] }, { ...client, bindingSlots: 65537 }, 1, 1 << 20), error('invalid_style'));
  const partial = { ...literal, attribute_mask: 8 };
  assert.deepEqual(decodeStyleResult({ ...body([partial]), indices: [1] }, client, 1, 1 << 20).styles, [partial]);
});

test('semantic contexts: literal numeric spellings match correctly rounded native admission', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/context-number-vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors.cases) {
    const raw = JSON.parse(vector.raw), bounds = { vocabularySize: 20, maxBytes: 1 << 20 };
    if (vector.error) assert.throws(() => decodeContextBatch([raw], bounds), error(vector.error), vector.name);
    else assert.deepEqual(decodeContextBatch([raw], bounds).batches.map(batch => batch.map(path => [...path])), [vector.value], vector.name);
  }
});
