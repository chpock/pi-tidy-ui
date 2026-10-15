import './fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { highlightCode, initTheme } from '@earendil-works/pi-coding-agent';
// Actual public ctx.ui.theme fixture, as in syntax-paint.test.ts; product code
// does not import Pi's private modules.
import { theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { indexedColor } from '@earendil-works/pi-tui';
import xterm from '@xterm/headless';
import { paintBashCommand, paintFileSource, type RangeReader } from '../src/syntax/paint.ts';
import type { PiRowReader } from '../src/syntax/pi.ts';

// Dynamic import keeps the first-red failure attached to functional tests rather
// than failing test discovery before any assertion can execute.
const adapter = () => import('../src/syntax/pi.ts');
initTheme('dark', false);
const rgb = (r: number, g: number, b: number, attributes = 0) => ((1 << 30) | (attributes << 24) | (r << 16) | (g << 8) | b) >>> 0;
const indexed = (index: number, attributes = 0) => ((2 << 30) | (attributes << 24) | index) >>> 0;
const rows = (lines: readonly string[]): PiRowReader => consume => { lines.forEach((line, index) => consume(index, line)); return true; };
const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);
function spans(read: RangeReader) {
  const entries: [number, number, number][] = [];
  assert.equal(read((start, end, style) => entries.push([start, end, style])), true);
  return entries;
}

test('Pi adapter emits contiguous UTF8 scalar spans, not terminal columns or retained glyphs', async () => {
  const { piRangeReader } = await adapter();
  const text = 'a界\t😀\ne\u0301\n';
  const read = piRangeReader(text, rows(['a\x1b[38;2;1;2;3m界\t😀', 'e\x1b[38;5;123m\u0301', '']));
  assert.deepEqual(spans(read), [[0, 1, 0], [1, 11, rgb(1, 2, 3)], [11, 14, indexed(123)]]);
  assert.deepEqual(plain(paintFileSource(text, theme, read)!), ['a界 😀', 'e\u0301', '']);
});

test('Pi adapter leaves tabs/wrapping and whole-grapheme first-scalar coloring to the painter', async () => {
  const { piRangeReader } = await adapter();
  const family = '👩‍👩‍👧‍👦', text = 'e\u0301' + family + '\t界\n';
  const read = piRangeReader(text, rows(['\x1b[31me\x1b[32m\u0301👩\x1b[34m‍👩‍👧‍👦\t界', '']));
  const entries = spans(read);
  assert.deepEqual(entries, [[0, 1, indexed(1)], [1, 7, indexed(2)], [7, Buffer.byteLength(text), indexed(4)]]);
  const file = paintFileSource(text, theme, read)!;
  assert.ok(file[0]!.startsWith(theme.style('e\u0301', { fg: indexedColor(1), bold: false, underline: false, italic: false })
    + theme.style(family, { fg: indexedColor(2), bold: false, underline: false, italic: false })));
  assert.deepEqual(plain(file), ['e\u0301' + family + ' 界', '']);
  const neutral = piRangeReader(text, rows([text.slice(0, -1), '']));
  for (const width of [6, 9, 20]) {
    assert.deepEqual(plain(paintBashCommand(text, width, theme, read)!), plain(paintBashCommand(text, width, theme, neutral)!));
  }
});

test('Pi RGB/index/basic/bright foregrounds and FG39/SGR0 restore caller neutral, never terminal default', async () => {
  const { piRangeReader } = await adapter();
  const line = '\x1b[38;2;17;190;93mA\x1b[39mB\x1b[38;5;255mC\x1b[0mD\x1b[90mE\x1b[37mF';
  assert.deepEqual(spans(piRangeReader('ABCDEF', rows([line]))), [
    [0, 1, rgb(17, 190, 93)], [1, 2, 0], [2, 3, indexed(255)], [3, 4, 0], [4, 5, indexed(8)], [5, 6, indexed(7)],
  ]);
  const neutral = rgb(4, 5, 6);
  assert.deepEqual(spans(piRangeReader('ABCDEF', rows([line]), neutral)), [
    [0, 1, rgb(17, 190, 93)], [1, 2, neutral], [2, 3, indexed(255)], [3, 4, neutral], [4, 5, indexed(8)], [5, 6, indexed(7)],
  ]);
  assert.deepEqual(spans(piRangeReader('ab', rows(['\x1b[97ma\x1b[mb']), indexed(42))), [[0, 1, indexed(15)], [1, 2, indexed(42)]]);
});

test('Pi foreground/font state crosses logical rows and newline bytes including final empty rows', async () => {
  const { piRangeReader } = await adapter();
  assert.deepEqual(spans(piRangeReader('a\n\nb\n', rows(['\x1b[38;5;42;1ma', '', 'b\x1b[22;39m', '']))), [
    [0, 4, indexed(42, 1)], [4, 5, 0],
  ]);
  assert.deepEqual(spans(piRangeReader('\n\n', rows(['', '', '']))), [[0, 2, 0]]);
});

test('Pi supported fonts combine/reset independently; neutral fonts require a concrete caller color', async () => {
  const { piRangeReader } = await adapter();
  const line = '\x1b[1;3;4mA\x1b[22mB\x1b[23mC\x1b[24mD';
  assert.deepEqual(spans(piRangeReader('ABCD', rows([line]), rgb(10, 20, 30))), [
    [0, 1, rgb(10, 20, 30, 7)], [1, 2, rgb(10, 20, 30, 6)], [2, 3, rgb(10, 20, 30, 2)], [3, 4, rgb(10, 20, 30)],
  ]);
  assert.equal(piRangeReader('ABCD', rows([line]))(() => {}), false);
  assert.deepEqual(spans(piRangeReader('ab', rows(['\x1b[38;5;3;1ma\x1b[39mb']), indexed(9))), [[0, 1, indexed(3, 1)], [1, 2, indexed(9, 1)]]);
  assert.equal(piRangeReader('ab', rows(['\x1b[38;5;3;1ma\x1b[39mb']))(() => {}), false);
  assert.deepEqual(spans(piRangeReader('abc', rows(['a\x1b[22mb\x1b[0mc']), indexed(9, 1))), [[0, 1, indexed(9, 1)], [1, 2, indexed(9)], [2, 3, indexed(9, 1)]]);
});

test('Pi background effects are removed without changing enclosing card background or leaking fonts', async () => {
  const { piRangeReader } = await adapter();
  const text = 'BUI-', line = '\x1b[48;2;255;0;0;38;2;17;190;93;1mB\x1b[22;4;48;5;5mU\x1b[24;3;44mI\x1b[23;49;104m-';
  const read = piRangeReader(text, rows([line]));
  assert.deepEqual(spans(read), [[0, 1, rgb(17, 190, 93, 1)], [1, 2, rgb(17, 190, 93, 2)], [2, 3, rgb(17, 190, 93, 4)], [3, 4, rgb(17, 190, 93)]]);
  const painted = paintFileSource(text, theme, read)![0]!;
  assert.ok(!painted.includes('\x1b[0m') && !painted.includes('\x1b[49m') && !painted.includes('\x1b[48;'));
  const terminal = new xterm.Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write('\x1b[48;2;40;50;60m' + painted + 'Z', resolve));
    const row = terminal.buffer.active.getLine(0)!;
    for (let col = 0; col < 5; col++) assert.equal(row.getCell(col)!.getBgColor(), 0x28323c);
    assert.ok(row.getCell(0)!.isBold() && !row.getCell(1)!.isBold());
    assert.ok(row.getCell(1)!.isUnderline() && !row.getCell(2)!.isUnderline());
    assert.ok(row.getCell(2)!.isItalic() && !row.getCell(3)!.isItalic());
    assert.ok(!row.getCell(4)!.isBold() && !row.getCell(4)!.isUnderline() && !row.getCell(4)!.isItalic());
  } finally { terminal.dispose(); }
});

test('Pi rows must be synchronous, monotonic, complete and glyph-exact, not normalized or tab-expanded', async () => {
  const { piRangeReader } = await adapter();
  const bad: PiRowReader[] = [
    rows(['a']), rows(['a', 'b', '']), rows(['a', 'B']), rows(['a\nb', 'b']),
    consume => { consume(1, 'a'); consume(0, 'b'); return true; },
    consume => { consume(0, 'a'); consume(0, 'b'); return true; },
    consume => { consume(0, 'a'); consume(2, 'b'); return true; },
    consume => { consume(0, 'a'); consume(1.5, 'b'); return true; },
    consume => { consume(0, 'a'); consume(1, 'b'); return false; },
    () => { throw new Error('unavailable'); },
  ];
  for (const reader of bad) {
    assert.equal(paintFileSource('a\nb', theme, piRangeReader('a\nb', reader)), undefined);
    assert.equal(paintBashCommand('a\nb', 20, theme, piRangeReader('a\nb', reader)), undefined);
  }
  for (const [text, line] of [['\tx', '    x'], ['e\u0301', 'é'], ['😀', '�'], ['x\n', 'x']]) {
    assert.equal(piRangeReader(text!, rows([line!]))(() => {}), false);
  }
  const read = piRangeReader('a\nb', rows(['\x1b[31ma\x1b[39m', 'wrong']));
  let provisional = 0;
  assert.equal(read(() => provisional++), false);
  assert.ok(provisional > 0, 'prefix callbacks may be provisional, never accepted when read returns false');
  assert.equal(paintFileSource('a\nb', theme, read), undefined);
  assert.equal(paintBashCommand('a\nb', 20, theme, read), undefined);
});

test('Pi row callbacks cannot emit after the synchronous visit, and visits retain no ANSI state', async () => {
  const { piRangeReader } = await adapter();
  let late: ((index: number, line: string) => void) | undefined;
  let visits = 0;
  const read = piRangeReader('ab', consume => {
    late = consume;
    visits++;
    consume(0, visits === 1 ? '\x1b[31ma\x1b[39mb' : 'ab');
    return true;
  });
  const first = spans(read);
  assert.deepEqual(first, [[0, 1, indexed(1)], [1, 2, 0]]);
  late!(0, '\x1b[32mab');
  assert.deepEqual(first, [[0, 1, indexed(1)], [1, 2, 0]], 'completed consumer receives no late callbacks');
  assert.deepEqual(spans(read), [[0, 2, 0]], 'each visit starts from caller neutral, not previous ANSI state');
  assert.equal(visits, 2, 'one PiRowReader invocation per RangeReader call');
});

test('Pi adapter rejects malformed SGR, unsupported effects and non-SGR terminal controls', async () => {
  const { piRangeReader } = await adapter();
  const controls = ['\x1b[', '\x1b[31', '\x1b[38;2;1;2m', '\x1b[38;2;256;2;3m', '\x1b[38;5;256m', '\x1b[38;5;-1m',
    '\x1b[38;3;1m', '\x1b[48;2;1;2m', '\x1b[48;5;256m', '\x1b[31;;1m', '\x1b[38:2::1:2:3m',
    '\x1b[7m', '\x1b[9m', '\x1b[8m', '\x1b[5m', '\x1b[21m', '\x1b[999m',
    '\x1b[2K', '\x1b]8;;https://example.org\x07', '\x1bPdata\x1b\\', '\x9b31m', '\r', '\x00', '\x7f'];
  for (const control of controls) assert.equal(piRangeReader('x', rows([control + 'x']))(() => {}), false, JSON.stringify(control));
  assert.equal(piRangeReader('😀', rows(['\ud83d\x1b[31m\ude00']))(() => {}), false, 'SGR cannot split a UTF16 scalar');
});

test('empty and invalid logical sources/neutral styles do not visit Pi rows; factory is lazy', async () => {
  const { piRangeReader } = await adapter();
  const never: PiRowReader = () => assert.fail('rows must not be visited');
  assert.deepEqual(spans(piRangeReader('', never)), []);
  assert.deepEqual(plain(paintFileSource('', theme, piRangeReader('', never))!), ['']);
  for (const text of ['\ud800', '\udc00', '\r', '\x00', '\x1b[31mx', '\x7f', '\x85']) {
    assert.equal(piRangeReader(text, never)(() => assert.fail('no spans')), false);
  }
  for (const style of [NaN, -1, 1, 9, 0x100000000, 0xc0000000, 0x48000000, 0x80000100, 1.5]) {
    assert.equal(piRangeReader('x', never, style)(() => assert.fail('no spans')), false);
  }
  const lazy = piRangeReader('x', never);
  assert.equal(typeof lazy, 'function');
  assert.deepEqual(paintBashCommand('x', 0, theme, lazy), []);
});

test('one tiny actual public Pi highlightCode control preserves logical source and concrete syntax colors', async () => {
  const { piRangeReader } = await adapter();
  const source = 'const 界 = "😀";\n\t// e\u0301\n';
  let calls = 0;
  const highlighted = highlightCode(source, 'typescript'); calls++;
  const reader = piRangeReader(source, rows(highlighted));
  const entries = spans(reader);
  assert.equal(calls, 1);
  assert.ok(entries.some(([, , style]) => style >>> 30 !== 0), 'actual SDK produced syntax foregrounds');
  const painted = paintFileSource(source, theme, reader)!;
  assert.deepEqual(plain(painted), ['const 界 = "😀";', '    // e\u0301', '']);
  assert.ok(painted[0]!.includes(theme.fg('syntaxKeyword', 'const')));
  for (const width of [9, 20]) assert.ok(paintBashCommand(source, width, theme, reader));
  assert.equal(calls, 1, 'projection/resize never calls a highlighter');
});


test('Pi public system theme retains faint comments, keyword colors and isolated resets', async () => {
  const { piRangeReader } = await adapter();
  initTheme('system', false);
  const terminal = new xterm.Terminal({ cols: 40, rows: 2, allowProposedApi: true });
  const reference = new xterm.Terminal({ cols: 40, rows: 2, allowProposedApi: true });
  try {
    const source = 'const x=1; // x';
    let classifications = 0;
    const highlighted = highlightCode(source, 'typescript'); classifications++;
    assert.ok(highlighted[0]!.includes('\x1b[2m'), 'actual system Theme emits faint without terminal color reports');
    const read = piRangeReader(source, rows(highlighted), rgb(220, 220, 220));
    const painted = paintFileSource(source, theme, read);
    assert.ok(painted, 'valid public faint output must not reject all fallback colors');
    assert.deepEqual(plain(painted), [source]);
    await new Promise<void>(resolve => terminal.write('\x1b[48;2;40;50;60m' + painted[0]! + 'Z', resolve));
    const row = terminal.buffer.active.getLine(0)!;
    assert.ok(row.getCell(source.indexOf('//'))!.isDim(), 'faint survives physical projection');
    assert.ok(!row.getCell(0)!.isDim(), 'keyword is not faint');
    await new Promise<void>(resolve => reference.write(highlighted[0]!, resolve));
    const expectedKeyword = reference.buffer.active.getLine(0)!.getCell(0)!;
    assert.equal(row.getCell(0)!.getFgColorMode(), expectedKeyword.getFgColorMode());
    assert.equal(row.getCell(0)!.getFgColor(), expectedKeyword.getFgColor(), 'actual SDK keyword color is retained');
    assert.ok(!row.getCell(source.length)!.isDim(), 'faint does not leak beyond the source');
    for (let column = 0; column <= source.length; column++) assert.equal(row.getCell(column)!.getBgColor(), 0x28323c);
    for (const width of [9, 20, 40]) assert.ok(paintBashCommand(source, width, theme, read));
    assert.equal(classifications, 1, 'warm projection and widths use the already classified Pi rows');
  } finally { terminal.dispose(); reference.dispose(); initTheme('dark', false); }
});

test('Pi faint and bold share SGR22 reset without losing independent fonts', async () => {
  const { piRangeReader } = await adapter();
  const read = piRangeReader('ABCD', rows(['\x1b[38;5;3;1;2;3;4mA\x1b[22mB\x1b[23mC\x1b[24mD']));
  const painted = paintFileSource('ABCD', theme, read);
  assert.ok(painted);
  const terminal = new xterm.Terminal({ cols: 8, rows: 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(painted[0]! + 'Z', resolve));
    const row = terminal.buffer.active.getLine(0)!;
    assert.ok(row.getCell(0)!.isDim() && row.getCell(0)!.isBold() && row.getCell(0)!.isItalic() && row.getCell(0)!.isUnderline());
    assert.ok(!row.getCell(1)!.isDim() && !row.getCell(1)!.isBold());
    assert.ok(row.getCell(1)!.isItalic() && row.getCell(1)!.isUnderline());
    assert.ok(!row.getCell(2)!.isItalic() && row.getCell(2)!.isUnderline());
    assert.ok(!row.getCell(3)!.isUnderline() && !row.getCell(4)!.isDim() && !row.getCell(4)!.isBold());
  } finally { terminal.dispose(); }
});
