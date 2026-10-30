import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fingerprintRules, type RuleDefinition } from '../../../src/occipital/style-rules.ts';

const empty: RuleDefinition = { revision: 2, binding_slots: 0,
  default: { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }, rules: [] };
const clone = <T>(value: T): T => structuredClone(value);

test('style rule identity: empty and nearest-owner definitions have independently framed preimages', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/rule-vectors.json', import.meta.url), 'utf8'));
  const emptyPreimage = Buffer.from('6f636369706974616c2d636c69656e742d72756c65732f3300' + '00000000' + '00000007' + '682f682f302f30' + '00000000', 'hex');
  const qualifiedPreimage = Buffer.from([
    'occipital-client-rules/3\0', '\0\0\0\x2c', '\0\0\0\x07h/h/0/0', '\0\0\0\x01',
    '\0\0\0\x01\0\0\0\x17meta.object-literal.key', '\0\0\0\0', '\x01',
    '\0\0\0\x17meta.object-literal.key', '\0\0\0\x02', '\0\0\0\x12meta.array.literal',
    '\0\0\0\x18meta.template.expression', '\x01', '\0\0\0\x08b7/h/0/0',
  ].join(''), 'latin1');
  assert.equal(createHash('sha256').update(emptyPreimage).digest('hex'), vectors.client[0].fingerprint);
  assert.equal(createHash('sha256').update(qualifiedPreimage).digest('hex'), vectors.client[2].fingerprint);
});

test('style rule identity: object key order does not alter the result, while rule order and explicit clears do', () => {
  const value: RuleDefinition = { ...empty, binding_slots: 4, rules: [
    { path: ['markup.heading'], excludes: [], foreground: { kind: 'binding', slot: 2 }, background: null, font: null, context: null },
    { path: ['markup.bold'], excludes: [['comment']], foreground: null, background: null, font: { attributes: 1, attribute_mask: 1 }, context: null },
  ] };
  const reordered: RuleDefinition = { rules: value.rules.map(rule => ({ font: rule.font, background: rule.background, foreground: rule.foreground, excludes: rule.excludes, path: rule.path, context: rule.context })),
    default: { attribute_mask: 0, attributes: 0, background: { kind: 'inherit' }, foreground: { kind: 'inherit' } }, binding_slots: 4, revision: 2 };
  assert.equal(fingerprintRules(reordered), fingerprintRules(value));
  const swapped = clone(value); swapped.rules.reverse();
  assert.notEqual(fingerprintRules(swapped), fingerprintRules(value));
  const clear = clone(value); clear.rules[0]!.font = { attributes: 0, attribute_mask: 8 };
  assert.notEqual(fingerprintRules(clear), fingerprintRules(value));
  const inherited = clone(value); inherited.rules[0]!.foreground = { kind: 'inherit' };
  assert.notEqual(fingerprintRules(inherited), fingerprintRules(value), 'explicit caller color differs from no override');
  const absent = clone(value); absent.rules[0]!.foreground = null;
  assert.notEqual(fingerprintRules(inherited), fingerprintRules(absent));
});

test('style rule identity: path boundaries, excludes and repeated ordered scopes remain significant', () => {
  const rule = { path: ['source', 'string'], excludes: [[]], foreground: null, background: null, font: null, context: null };
  const value = { ...empty, rules: [rule] };
  for (const patch of [ { path: ['source.string'] }, { path: ['string', 'source'] }, { path: ['source', 'source', 'string'] }, { excludes: [] } ]) {
    assert.notEqual(fingerprintRules({ ...empty, rules: [{ ...rule, ...patch }] }), fingerprintRules(value));
  }
});

test('style rule identity: unrelated source, palette, role, geometry and transport fields are not part of a definition', () => {
  for (const extra of ['source', 'palette', 'colors', 'roles', 'width', 'instance', 'profile', 'fingerprint']) {
    assert.throws(() => fingerprintRules({ ...empty, [extra]: 1 }));
  }
  for (const patch of [ { revision: 3 }, { binding_slots: 65537 }, { binding_slots: -1 }, { default: null }, { rules: null } ]) {
    assert.throws(() => fingerprintRules({ ...empty, ...patch }));
  }
});

test('style rules: whole-definition admission is bounded by the existing selector/atom envelope, not source limits', () => {
  const rule = { path: ['source'], excludes: [], foreground: null, background: null, font: null, context: null };
  assert.match(fingerprintRules({ ...empty, rules: Array.from({ length: 512 }, () => clone(rule)) }), /^[a-f0-9]{64}$/);
  assert.throws(() => fingerprintRules({ ...empty, rules: Array.from({ length: 513 }, () => clone(rule)) }));
  assert.match(fingerprintRules({ ...empty, rules: [{ ...rule, path: Array(4096).fill('a') }] }), /^[a-f0-9]{64}$/);
  assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...rule, path: Array(4097).fill('a') }] }));
  assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...rule, path: ['a.b.c.d.e.f.g.h.i'] }] }));
  assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...rule, path: ['source string'] }] }));
});

test('style rules: nullable keys, font presence, bindings and exact ink shapes are checked before hashing', () => {
  const base = { path: [], excludes: [], foreground: null, background: null, font: null, context: null };
  for (const patch of [
    { font: { attributes: 1, attribute_mask: 0 } }, { font: { attributes: null, attribute_mask: null } }, { foreground: { kind: 'binding', slot: 0 } },
    { foreground: { kind: 'inherit', slot: 0 } }, { excludes: [null] }, { font: undefined }, { path: [1] },
  ]) assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...base, ...patch }] }));
  assert.match(fingerprintRules({ ...empty, rules: [{ ...base, font: { attributes: 0, attribute_mask: 0 } }] }), /^[a-f0-9]{64}$/);
  assert.match(fingerprintRules({ ...empty, rules: [{ ...base, path: [] }] }), /^[a-f0-9]{64}$/,
    'an unqualified empty path preserves its generic selector meaning');
  assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...base, context: { owner: 'string', boundaries: [] } }] }),
    'a qualified path must include and begin at its owner');
});


test('style identities: the producer and consumer share the frozen field-order-independent vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/rule-vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors.client) assert.equal(fingerprintRules(vector.definition), vector.fingerprint, vector.name);
});

test('style rules: a long nonterminal dot run is rejected without monopolizing the host event loop', () => {
  const module = new URL('../../../src/occipital/style-rules.ts', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    const {fingerprintRules} = await import(${JSON.stringify(module)});
    const value = ${JSON.stringify(empty)};
    value.rules = [{path:['a' + '.'.repeat(200000) + 'b'], excludes:[], foreground:null, background:null, font:null, context:null}];
    assert.throws(() => fingerprintRules(value));`;
  // A generous isolated-process fail-safe catches quadratic validation; it is
  // neither a production timing limit nor a throughput benchmark.
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  const rule = { excludes: [], foreground: null, background: null, font: null, context: null };
  for (const path of [['source....'], ['a.b.c.d.e.f.g.h']])
    assert.match(fingerprintRules({ ...empty, rules: [{ ...rule, path }] }), /^[a-f0-9]{64}$/);
  assert.throws(() => fingerprintRules({ ...empty, rules: [{ ...rule, path: ['a.b.c.d.e.f.g.h.i'] }] }));
});

test('style admission: raw decimal boundary tokens have the same correctly rounded integer meaning on both peers', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/rule-number-vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors.cases) {
    const value = JSON.parse(vector.raw);
    if (vector.valid) assert.match(fingerprintRules(value), /^[a-f0-9]{64}$/, vector.name);
    else assert.throws(() => fingerprintRules(value), vector.name);
  }
});
