import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { StyleExpression } from '../../../src/occipital/semantic-codec.ts';
import { materializeStyle, type ConcreteStyle, type StyleBinding } from '../../../src/syntax/style-materialization.ts';

const rgb = (r: number, g: number, b: number) => ({ kind: 'rgb' as const, r, g, b });
const caller: ConcreteStyle = { foreground: rgb(1, 2, 3), background: { kind: 'indexed', index: 7 }, attributes: 8 };
const inherited: StyleExpression = { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 };
const roles: StyleBinding[] = [
  { ink: rgb(19, 30, 40), attributes: 2, attribute_mask: 2 },
  { ink: { kind: 'indexed', index: 6 }, attributes: 1, attribute_mask: 1 },
];

test('style materialization: a caller-neutral expression preserves both surfaces and typography', () => {
  assert.deepEqual(materializeStyle(inherited, [], caller), caller);
  assert.notEqual(materializeStyle(inherited, [], caller), caller);
});

test('style materialization: foreground binding typography composes before explicit selector masks', () => {
  const heading: StyleExpression = { ...inherited, foreground: { kind: 'binding', slot: 0 }, attributes: 1, attribute_mask: 1 };
  assert.deepEqual(materializeStyle(heading, roles, caller), { foreground: rgb(19, 30, 40), background: caller.background, attributes: 11 });
  const clearFaint = { ...heading, attribute_mask: 9 };
  assert.equal(materializeStyle(clearFaint, roles, caller).attributes, 3);
  const clearItalic = { ...heading, attribute_mask: 3 };
  assert.equal(materializeStyle(clearItalic, roles, caller).attributes, 9);
  const reset = { ...heading, attributes: 0, attribute_mask: 31 };
  assert.equal(materializeStyle(reset, roles, caller).attributes, 0);
});

test('style materialization: a binding may inherit color yet explicitly set or clear faint', () => {
  const binding: StyleBinding = { ink: { kind: 'inherit' }, attributes: 8, attribute_mask: 8 };
  const expression = { ...inherited, foreground: { kind: 'binding' as const, slot: 0 } };
  assert.deepEqual(materializeStyle(expression, [binding], { ...caller, attributes: 0 }), { ...caller, attributes: 8 });
  assert.equal(materializeStyle(expression, [{ ...binding, attributes: 0 }], caller).attributes, 0);
});

test('style materialization: background bindings supply color without changing foreground typography', () => {
  const expression: StyleExpression = { ...inherited, background: { kind: 'binding', slot: 1 } };
  assert.deepEqual(materializeStyle(expression, roles, caller), { ...caller, background: { kind: 'indexed', index: 6 } });
  assert.deepEqual(materializeStyle(expression, [{ ...roles[0]! }, { ink: { kind: 'inherit' }, attributes: 0, attribute_mask: 31 }], caller), caller);
});

test('style materialization: native literals and complete font masks never read Pi bindings', () => {
  const forbidden = new Proxy([] as StyleBinding[], { get() { assert.fail('native style accessed Pi bindings'); } });
  const expression: StyleExpression = { foreground: rgb(30, 40, 50), background: rgb(5, 6, 7), attributes: 4, attribute_mask: 31 };
  assert.deepEqual(materializeStyle(expression, forbidden, { ...caller, attributes: 31 }), { foreground: rgb(30, 40, 50), background: rgb(5, 6, 7), attributes: 4 });
});

test('style materialization: explicit terminal defaults are not caller inheritance or fabricated RGB', () => {
  const expression: StyleExpression = { ...inherited, foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' } };
  assert.deepEqual(materializeStyle(expression, [], caller), { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 8 });
});

test('style materialization: syntax can use its structural row surface without altering scope colors or fonts', () => {
  const expression: StyleExpression = { foreground: rgb(30, 40, 50), background: rgb(5, 6, 7), attributes: 3, attribute_mask: 31 };
  const surface = rgb(17, 18, 19);
  const style = materializeStyle(expression, [], caller, surface);
  assert.deepEqual(style, { foreground: expression.foreground, background: surface, attributes: 3 });
  assert.equal(expression.background.kind, 'rgb');
  assert.deepEqual(expression.background, rgb(5, 6, 7));
});

test('style materialization: local palette rebinding does not change the source expression', () => {
  const expression: StyleExpression = { ...inherited, foreground: { kind: 'binding', slot: 0 }, attributes: 1, attribute_mask: 1 };
  const before = structuredClone(expression), paletteB: StyleBinding[] = [{ ...roles[0]!, ink: rgb(191, 210, 220) }];
  assert.deepEqual(materializeStyle(expression, roles, caller).foreground, rgb(19, 30, 40));
  assert.deepEqual(materializeStyle(expression, paletteB, caller).foreground, rgb(191, 210, 220));
  assert.deepEqual(expression, before);
});

test('style materialization: adopted output is immutable and detached from mutable input inks', () => {
  const expression = { ...inherited, foreground: rgb(2, 3, 4) }, base = { ...caller, background: { kind: 'indexed' as const, index: 8 } };
  const style = materializeStyle(expression, [], base);
  expression.foreground.r = 200; base.background.index = 100;
  assert.deepEqual(style, { foreground: rgb(2, 3, 4), background: { kind: 'indexed', index: 8 }, attributes: 8 });
  assert.ok(Object.isFrozen(style));
  assert.ok(Object.isFrozen(style.foreground)); assert.ok(Object.isFrozen(style.background));
  const palette = [{ ink: rgb(5, 6, 7), attributes: 0, attribute_mask: 0 }];
  const bound = materializeStyle({ ...inherited, foreground: { kind: 'binding', slot: 0 } }, palette, caller);
  palette[0]!.ink.r = 100;
  assert.deepEqual(bound.foreground, rgb(5, 6, 7));
});

test('style materialization: missing required binding surfaces an internal contract failure, never a color fallback', () => {
  for (const property of ['foreground', 'background'] as const) {
    assert.throws(() => materializeStyle({ ...inherited, [property]: { kind: 'binding', slot: 0 } }, [], caller), /missing style binding/);
  }
});
