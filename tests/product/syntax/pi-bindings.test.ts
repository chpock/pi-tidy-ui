import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Theme } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { samplePiBindings } from '../../../src/syntax/pi-bindings.ts';
import { PI_DIRECT_BINDINGS, createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { materializeStyle } from '../../../src/syntax/style-materialization.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';

function theme(mode: 'truecolor' | '256color', faint = true) {
  const backgroundRoles = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  // Supply a complete actual-host theme; the sampled roles have independently
  // chosen known values, not an incomplete constructor cast.
  for (const role of Object.keys(getThemeByName('dark')!.colors))
    (backgroundRoles.has(role) ? bg : fg)[role] = backgroundRoles.has(role) ? '#101010' : '#123456';
  fg.mdCode = ''; fg.syntaxNumber = 6;
  return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], mode,
    { dim: faint ? ['syntaxComment'] : [] });
}

test('Pi bindings: sample all stable slots once through the public prefix API, not approximate theme.colors', () => {
  const native = theme('truecolor'), seen: string[] = [];
  const values = samplePiBindings({ getFgAnsi(role) { seen.push(role); return native.getFgAnsi(role); } });
  assert.deepEqual(seen, PI_DIRECT_BINDINGS);
  assert.deepEqual(values[0], { ink: { kind: 'rgb', r: 18, g: 52, b: 86 }, attributes: 8, attribute_mask: 31 });
  assert.deepEqual(values[1], { ink: { kind: 'rgb', r: 18, g: 52, b: 86 }, attributes: 0, attribute_mask: 31 });
  assert.deepEqual(values[3]!.ink, { kind: 'indexed', index: 6 });
  assert.deepEqual(values[12]!.ink, { kind: 'terminal-default' });
});

test('Pi bindings: preserve the actual terminal mode instead of inventing RGB for indexed colors', () => {
  const native = theme('256color');
  for (const value of samplePiBindings(native)) assert.ok(value.ink.kind === 'indexed' || value.ink.kind === 'terminal-default');
  assert.deepEqual(samplePiBindings(native)[3]!.ink, { kind: 'indexed', index: 6 });
});

test('Pi bindings: local faint and color rebinding leave the resolver definition unchanged', () => {
  const definition = createPiRuleDefinition(), rules = fingerprintRules(definition);
  const expression = { foreground: { kind: 'binding' as const, slot: 0 }, background: { kind: 'inherit' as const }, attributes: 1, attribute_mask: 9 };
  const caller = { foreground: { kind: 'indexed' as const, index: 1 }, background: { kind: 'terminal-default' as const }, attributes: 8 };
  const faint = samplePiBindings(theme('truecolor')), normal = samplePiBindings(theme('truecolor', false));
  assert.equal(faint[0]!.attributes, 8); assert.equal(normal[0]!.attributes, 0);
  assert.equal(materializeStyle(expression, faint, caller).attributes, 1);
  assert.equal(materializeStyle({ ...expression, attributes: 0, attribute_mask: 0 }, normal, caller).attributes, 0);
  assert.equal(fingerprintRules(definition), rules);
});

test('Pi bindings: return fresh immutable values and never retain a theme owner', async () => {
  function sampled() { const owner = theme('truecolor'); return { owner: new WeakRef(owner), values: samplePiBindings(owner) }; }
  const { owner, values } = sampled();
  assert.ok(Object.isFrozen(values)); assert.ok(Object.isFrozen(values[0])); assert.ok(Object.isFrozen(values[0]!.ink));
  const again = samplePiBindings(theme('truecolor'));
  assert.deepEqual(values, again); assert.notEqual(values, again); assert.notEqual(values[0], again[0]);
  for (let i = 0; i < 20; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc!(); }
  assert.equal(owner.deref(), undefined);
  assert.deepEqual(values[1]!.ink, { kind: 'rgb', r: 18, g: 52, b: 86 });
});

test('Pi bindings: preserve basic colors, explicit typography resets and terminal defaults', () => {
  const prefix = '\x1b[91m\x1b[1;2;3;4m\x1b[22;23m';
  const value = samplePiBindings({ getFgAnsi: () => prefix })[0]!;
  assert.deepEqual(value, { ink: { kind: 'indexed', index: 9 }, attributes: 4, attribute_mask: 31 });
  assert.deepEqual(samplePiBindings({ getFgAnsi: () => '\x1b[38;2;1;2;3m\x1b[0m' })[0],
    { ink: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 31 });
});

test('Pi bindings: strike is independent of other selective resets and full reset', () => {
  for (const [prefix, attributes] of [['\x1b[1;2;3;4;9;22;23;24m', 16], ['\x1b[1;9;29m', 1], ['\x1b[9;0m', 0]] as const) {
    const value = samplePiBindings({ getFgAnsi: () => prefix })[0]!;
    assert.equal(value.attributes, attributes); assert.equal(value.attribute_mask, 31);
  }
});

test('Pi bindings: malformed or unrepresentable prefixes fail explicitly rather than dropping styles', () => {
  for (const value of ['bad', '\x1b[38;2;1;2m', '\x1b[38;5;256m', '\x1b[7m', '\x1b[48;5;2m', '\x1b[38:2:1:2:3m']) {
    assert.throws(() => samplePiBindings({ getFgAnsi: () => value }), /invalid Pi binding/, value);
  }
});
