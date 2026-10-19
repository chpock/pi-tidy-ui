import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import xterm from '@xterm/headless';
import { Theme } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { rgbColor } from '@earendil-works/pi-tui';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';

const style: ConcreteStyle = { foreground: { kind: 'rgb', r: 18, g: 52, b: 86 },
  background: { kind: 'indexed', index: 17 }, attributes: 0 };
async function terminal(text: string) {
  const value = new xterm.Terminal({ cols: 80, rows: 2, allowProposedApi: true });
  await new Promise<void>(resolve => value.write(text, resolve));
  return value;
}

test('style ANSI: all four attributes are exact, including explicit clears over inherited typography', async () => {
  let output = '';
  for (let attributes = 0; attributes < 16; attributes++) {
    const compiled = compileStyleAnsi({ ...style, attributes }, 'truecolor');
    output += '\x1b[1;2;3;4m' + compiled.open + 'x' + compiled.close + '.';
  }
  const value = await terminal(output);
  try {
    const row = value.buffer.active.getLine(0)!;
    for (let bits = 0; bits < 16; bits++) {
      const cell = row.getCell(bits * 2)!;
      assert.equal(!!cell.isBold(), !!(bits & 1), `bold ${bits}`);
      assert.equal(!!cell.isItalic(), !!(bits & 2), `italic ${bits}`);
      assert.equal(!!cell.isUnderline(), !!(bits & 4), `underline ${bits}`);
      assert.equal(!!cell.isDim(), !!(bits & 8), `faint ${bits}`);
      const after = row.getCell(bits * 2 + 1)!;
      assert.ok(!after.isBold() && !after.isDim() && !after.isItalic() && !after.isUnderline());
      assert.ok(after.isFgDefault() && after.isBgDefault(), 'styles cannot escape their span');
    }
  } finally { value.dispose(); }
});

test('style ANSI: truecolor, indexed colors and explicit terminal defaults remain distinct', async () => {
  const rgb = compileStyleAnsi({ ...style, background: { kind: 'rgb', r: 4, g: 5, b: 6 } }, 'truecolor');
  const indexed = compileStyleAnsi({ ...style, foreground: { kind: 'indexed', index: 6 } }, 'truecolor');
  const defaults = compileStyleAnsi({ ...style, foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' } }, 'truecolor');
  const value = await terminal(rgb.open + 'a' + rgb.close + indexed.open + 'b' + indexed.close
    + '\x1b[38;5;1m\x1b[48;5;2m' + defaults.open + 'c' + defaults.close);
  try {
    const row = value.buffer.active.getLine(0)!;
    assert.ok(row.getCell(0)!.isFgRGB() && row.getCell(0)!.isBgRGB());
    assert.equal(row.getCell(0)!.getFgColor(), 0x123456); assert.equal(row.getCell(0)!.getBgColor(), 0x040506);
    assert.ok(row.getCell(1)!.isFgPalette() && row.getCell(1)!.isBgPalette());
    assert.equal(row.getCell(1)!.getFgColor(), 6); assert.equal(row.getCell(1)!.getBgColor(), 17);
    assert.ok(row.getCell(2)!.isFgDefault() && row.getCell(2)!.isBgDefault());
  } finally { value.dispose(); }
});

test('style ANSI: 256-color projection uses the same native terminal conversion as public Pi styling', async () => {
  const compiled = compileStyleAnsi(style, '256color');
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string> = {}, bg: Record<string, string> = {};
  for (const role of Object.keys(getThemeByName('dark')!.colors))
    (backgrounds.has(role) ? bg : fg)[role] = backgrounds.has(role) ? '#000000' : '#ffffff';
  const native = new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], '256color');
  const expected = native.style('b', { fg: rgbColor(18, 52, 86) });
  const value = await terminal(compiled.open + 'a' + compiled.close + expected);
  try {
    const row = value.buffer.active.getLine(0)!;
    assert.ok(row.getCell(0)!.isFgPalette());
    assert.equal(row.getCell(0)!.getFgColorMode(), row.getCell(1)!.getFgColorMode());
    assert.equal(row.getCell(0)!.getFgColor(), row.getCell(1)!.getFgColor());
  } finally { value.dispose(); }
});

test('style ANSI: local selector clears reach cells and structural diff backgrounds supersede token backgrounds', async () => {
  const expression = { foreground: { kind: 'binding' as const, slot: 0 }, background: { kind: 'rgb' as const, r: 200, g: 0, b: 0 },
    attributes: 1, attribute_mask: 9 };
  const materialized = materializeStyle(expression, [{ ink: { kind: 'rgb', r: 10, g: 20, b: 30 }, attributes: 8, attribute_mask: 15 }], style,
    { kind: 'rgb', r: 20, g: 40, b: 25 });
  const compiled = compileStyleAnsi(materialized, 'truecolor');
  const value = await terminal('\x1b[2m' + compiled.open + 'x' + compiled.close);
  try {
    const cell = value.buffer.active.getLine(0)!.getCell(0)!;
    assert.ok(cell.isBold() && !cell.isDim());
    assert.equal(cell.getFgColor(), 0x0a141e); assert.equal(cell.getBgColor(), 0x142819);
  } finally { value.dispose(); }
});

test('style ANSI: compiled strings are immutable detached data, reusable without reading style or theme again', () => {
  const mutable: { -readonly [K in keyof ConcreteStyle]: ConcreteStyle[K] } = structuredClone(style);
  let reads = 0;
  const input = new Proxy(mutable, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  const compiled = compileStyleAnsi(input, 'truecolor');
  const after = reads, text = compiled.open + 'x' + compiled.close;
  mutable.foreground = { kind: 'indexed', index: 123 }; mutable.attributes = 15;
  for (let i = 0; i < 100; i++) assert.equal(compiled.open + 'x' + compiled.close, text);
  assert.equal(reads, after); assert.ok(Object.isFrozen(compiled));
});
