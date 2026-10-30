import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Theme } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { samplePiCardPalette } from '../../../src/syntax/pi-palette.ts';
import { samplePiPrefix } from '../../../src/syntax/pi-bindings.ts';
import { PI_DIRECT_BINDINGS } from '../../../src/syntax/pi-adapter.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';

function theme(mode: 'truecolor' | '256color' = 'truecolor', terminal = false) {
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  for (const key of Object.keys(getThemeByName('dark')!.colors)) (backgrounds.has(key) ? bg : fg)[key] = backgrounds.has(key) ? '#12141a' : '#d8d8d8';
  Object.assign(fg, { toolTitle: '#89abef', muted: '#aabbcc', dim: '#997744', borderMuted: '#567890', error: '#ee6677', warning: '#ffdd66', toolDiffAdded: '#77cc88', toolDiffRemoved: '#ee7788' });
  Object.assign(bg, { toolSuccessBg: '#18301a', toolErrorBg: '#381c19' });
  if (terminal) { bg.toolPendingBg = ''; fg.toolOutput = ''; }
  return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], mode, { dim: ['dim', 'muted'] });
}
const rgb = (r: number, g: number, b: number) => ({ kind: 'rgb', r, g, b });

test('Pi card palette: complete roles retain distinct command/output, muted reminders and error-frame semantics', () => {
  const values = samplePiCardPalette(theme());
  assert.deepEqual(Object.keys(values), CARD_ROLES);
  assert.deepEqual(values.title.foreground, rgb(0x89, 0xab, 0xef));
  assert.deepEqual(values.code.foreground, rgb(0xd8, 0xd8, 0xd8));
  assert.deepEqual(values.output.foreground, values.code.foreground);
  assert.deepEqual(values.reminder.foreground, rgb(0xaa, 0xbb, 0xcc));
  assert.deepEqual(values.reminder, values.muted);
  assert.notDeepEqual(values.reminder.foreground, values.warning.foreground);
  assert.equal(values.prompt.attributes, 8);
  assert.equal(values.reminder.attributes, 8);
  assert.deepEqual(values.frame.foreground, rgb(0x56, 0x78, 0x90));
  assert.deepEqual(values.errorFrame.foreground, rgb(0xee, 0x66, 0x77));
  for (const role of ['panel', 'plain', 'code', 'output', 'padding', 'errorFrame'] as const)
    assert.deepEqual(values[role].background, rgb(0x12, 0x14, 0x1a));
});

test('Pi card palette: diff signs and quantized surfaces follow the existing Pi palette producer', () => {
  const native = theme(), values = samplePiCardPalette(native);
  for (const [code, gutter, sign, source] of [
    ['addedCode', 'addedGutter', 'addedSign', 'toolDiffAdded'],
    ['removedCode', 'removedGutter', 'removedSign', 'toolDiffRemoved'],
  ] as const) {
    assert.notDeepEqual(values[code].background, values.panel.background, 'eligible, readable code tint stays useful');
    assert.equal(values[code].background.kind, 'rgb');
    assert.equal(values[gutter].background.kind, 'rgb');
    assert.deepEqual(values[sign].background, values[gutter].background);
    assert.deepEqual(values[sign].foreground, samplePiPrefix(native.getFgAnsi(source)).ink);
    assert.deepEqual(values[code].foreground, values.code.foreground);
    assert.deepEqual(values[gutter].foreground, values.numbers.foreground);
  }
});

test('Pi card palette: terminal-default panel and text remain symbolic, without invented RGB tints', () => {
  const values = samplePiCardPalette(theme('truecolor', true));
  assert.deepEqual(values.code.foreground, { kind: 'terminal-default' });
  for (const role of CARD_ROLES) assert.deepEqual(values[role].background, { kind: 'terminal-default' }, role);
  assert.deepEqual(values.addedSign.foreground, rgb(0x77, 0xcc, 0x88));
});

test('Pi card palette: public foreground and background prefixes preserve indexed colors and explicit resets', () => {
  assert.deepEqual(samplePiPrefix('\x1b[104m', 'background').ink, { kind: 'indexed', index: 12 });
  assert.deepEqual(samplePiPrefix('\x1b[48;5;7m\x1b[49m', 'background').ink, { kind: 'terminal-default' });
  assert.deepEqual(samplePiPrefix('\x1b[48;2;1;2;3m', 'background').ink, rgb(1, 2, 3));
  assert.throws(() => samplePiPrefix('\x1b[38;5;1m', 'background'), /invalid Pi binding/);
  assert.throws(() => samplePiPrefix('\x1b[48;2;1;2m', 'background'), /invalid Pi binding/);
  const values = samplePiCardPalette(theme('256color'), '256color');
  assert.equal(values.code.foreground.kind, 'indexed'); assert.equal(values.panel.background.kind, 'indexed');
  for (const role of CARD_ROLES) assert.ok(!/\x1b\[(?:38|48);2;/.test(compileStyleAnsi(values[role], '256color').open));
});

test('Pi card palette: fixed role sampling is bounded and no theme owner or callbacks survive', async () => {
  function create() {
    const native = theme(), seenFg: string[] = [], seenBg: string[] = [];
    const values = samplePiCardPalette({
      getFgAnsi(role) { seenFg.push(role); return native.getFgAnsi(role); },
      getBgAnsi(role) { seenBg.push(role); return native.getBgAnsi(role); },
      colors: native.colors,
    });
    return { owner: new WeakRef(native), values, seenFg, seenBg };
  }
  const { owner, values, seenFg, seenBg } = create();
  assert.equal(new Set(seenFg).size, seenFg.length, 'sample each foreground once, not once per card or line');
  assert.ok(seenFg.length <= CARD_ROLES.length + PI_DIRECT_BINDINGS.length); assert.deepEqual(seenBg, ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  for (let i = 0; i < 20; i++) { await turn(); global.gc!(); }
  assert.equal(owner.deref(), undefined);
  assert.deepEqual(values.code.foreground, rgb(0xd8, 0xd8, 0xd8));
  assert.ok(Object.isFrozen(values));
  for (const role of CARD_ROLES) {
    assert.ok(Object.isFrozen(values[role])); assert.ok(Object.isFrozen(values[role].foreground)); assert.ok(Object.isFrozen(values[role].background));
  }
  assert.notEqual(samplePiCardPalette(theme()), values);
});


test('Pi card palette: builtin dark and light keep exact public base colors with structural diff surfaces', () => {
  for (const name of ['dark', 'light']) {
    const native = getThemeByName(name)!;
    const values = samplePiCardPalette(native);
    assert.deepEqual(values.code.foreground, samplePiPrefix(native.getFgAnsi('toolOutput')).ink, name);
    assert.deepEqual(values.code.background, samplePiPrefix(native.getBgAnsi('toolPendingBg'), 'background').ink, name);
    for (const role of ['addedCode', 'removedCode', 'addedGutter', 'removedGutter'] as const)
      assert.equal(values[role].background.kind, 'rgb', `${name}/${role}`);
  }
});
