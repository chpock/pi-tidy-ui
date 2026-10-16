import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
// Fixture only: this is the actual object exposed as ctx.ui.theme. Product
// painting imports no private Pi modules, as in the existing SDK unit controls.
import { theme } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { indexedColor, rgbColor } from '@earendil-works/pi-tui';
import xterm from '@xterm/headless';
import { paintFileSource, paintBashCommand, paintHistoricalBashCommand, type RangeReader } from '../../../src/syntax/paint.ts';
import { renderBashCard } from '../../../src/bash-card.ts';
import { cardGeometry, frameRows } from '../../../src/card-frame.ts';
import { toolCardPaint } from '../../../src/card-theme.ts';

initTheme('dark', false);
const roles = ['toolOutput', 'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation'] as const;
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters);
function ranges(entries: readonly (readonly [number, number, number])[]): RangeReader {
  return consume => { for (const [start, end, style] of entries) consume(start, end, style); return true; };
}
const all = (text: string, style = 0) => ranges(text ? [[0, Buffer.byteLength(text), style]] : []);
const rgb = (r: number, g: number, b: number, attributes = 0) => ((1 << 30) | (attributes << 24) | (r << 16) | (g << 8) | b) >>> 0;
const indexed = (index: number, attributes = 0) => ((2 << 30) | (attributes << 24) | index) >>> 0;
const defaultFg = (attributes = 0) => ((3 << 30) | (attributes << 24)) >>> 0;
async function cells(text: string) {
  const terminal = new xterm.Terminal({ cols: 200, rows: 10, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write(text, resolve));
  return terminal;
}

test('every canonical Pi category uses its public role; Plain uses the surface neutral color', () => {
  const source = 'abcdefghij', entries = [...source].map((_, index) => [index, index + 1, index] as const);
  const painted = paintFileSource(source, theme, ranges(entries))!;
  assert.deepEqual(plain(painted), [source]);
  assert.equal(painted[0], roles.map((role, index) => theme.fg(role, source[index]!)).join(''));
  assert.equal(paintBashCommand('x', 20, theme, all('x'))![0], theme.fg('dim', '$ ') + theme.fg('toolTitle', 'x'));
});

test('UTF8 classifications never put ANSI inside a combining or joined-family grapheme', () => {
  const family = '👩‍👩‍👧‍👦', source = 'e\u0301' + family + '字';
  const endFamily = 3 + Buffer.byteLength(family);
  const painted = paintFileSource(source, theme, ranges([
    [0, 1, 2], [1, 3, 1], [3, 7, 3], [7, endFamily, 4], [endFamily, endFamily + 3, 5],
  ]))!;
  assert.deepEqual(plain(painted), [source]);
  assert.equal(painted[0], theme.fg('syntaxKeyword', 'e\u0301') + theme.fg('syntaxString', family) + theme.fg('syntaxType', '字'));
  assert.ok(painted[0]!.includes(family));
});

test('file tab spaces inherit the tab first-scalar style and retain four-column wide-character stops', () => {
  const source = '界\tx\na\tb\n', result = paintFileSource(source, theme, ranges([
    [0, 3, 0], [3, 4, 2], [4, 7, 0], [7, 8, 3], [8, 10, 0],
  ]))!;
  assert.deepEqual(plain(result), ['界  x', 'a   b', '']);
  assert.ok(result[0]!.includes(theme.fg('syntaxKeyword', '  ')));
  assert.ok(result[1]!.includes(theme.fg('syntaxString', '   ')));
});

test('committed prefix is colored but the changed provisional tail stays neutral and exact', () => {
  const source = 'let a;\nchanged_tail', result = paintFileSource(source, theme, ranges([[0, 7, 2]]))!;
  assert.deepEqual(plain(result), ['let a;', 'changed_tail']);
  assert.equal(result[0], theme.fg('syntaxKeyword', 'let a;'));
  assert.equal(result[1], theme.fg('toolOutput', 'changed_tail'));
});

test('native RGB/font attributes follow Syntect bits without adding backgrounds or all-SGR reset', async () => {
  const source = 'BUI-', result = paintFileSource(source, theme, ranges([
    [0, 1, rgb(17, 190, 93, 1)], [1, 2, rgb(17, 190, 93, 2)],
    [2, 3, rgb(17, 190, 93, 4)], [3, 4, rgb(17, 190, 93)],
  ]))![0]!;
  assert.equal(result, theme.style('B', { fg: rgbColor(17, 190, 93), bold: true, underline: false, italic: false })
    + theme.style('U', { fg: rgbColor(17, 190, 93), bold: false, underline: true, italic: false })
    + theme.style('I', { fg: rgbColor(17, 190, 93), bold: false, underline: false, italic: true })
    + theme.style('-', { fg: rgbColor(17, 190, 93), bold: false, underline: false, italic: false }));
  assert.ok(!result.includes('\x1b[0m') && !result.includes('\x1b[49m'));
  const terminal = await cells('\x1b[48;2;40;50;60m' + result + 'Z');
  try {
    const row = terminal.buffer.active.getLine(0)!;
    assert.ok(row.getCell(0)!.isBold()); assert.ok(!row.getCell(1)!.isBold());
    assert.ok(row.getCell(1)!.isUnderline()); assert.ok(!row.getCell(2)!.isUnderline());
    assert.ok(row.getCell(2)!.isItalic()); assert.ok(!row.getCell(3)!.isItalic());
    for (let col = 0; col < 5; col++) assert.equal(row.getCell(col)!.getBgColor(), 0x28323c, 'source styles cannot erase the surrounding card background');
    assert.ok(!row.getCell(4)!.isBold() && !row.getCell(4)!.isItalic() && !row.getCell(4)!.isUnderline(), 'source attributes cannot leak');
  } finally { terminal.dispose(); }
});

test('indexed and terminal-default native colors remain distinct from Plain and preserve attributes', async () => {
  const painted = paintFileSource('IPD', theme, ranges([[0, 1, indexed(123, 4)], [1, 2, 0], [2, 3, defaultFg(2)]]))![0]!;
  assert.ok(painted.startsWith(theme.style('I', { fg: indexedColor(123), bold: false, underline: false, italic: true })));
  const terminal = await cells(painted + 'Z');
  try {
    const row = terminal.buffer.active.getLine(0)!;
    assert.equal(row.getCell(0)!.getFgColor(), 123);
    assert.ok(row.getCell(0)!.isItalic());
    assert.ok(row.getCell(2)!.isFgDefault()); assert.ok(row.getCell(2)!.isUnderline());
    assert.ok(!row.getCell(3)!.isUnderline());
  } finally { terminal.dispose(); }
});

test('Bash projection exactly matches the real existing frame for prompt-aware tabs, wraps and wide glyph substitution', () => {
  const samples = ['\tprintf\t界\n\techo 👩‍👩‍👧‍👦\n', '界\tZ', 'a\tb\tc', '', '\n\n'];
  for (const command of samples) for (const width of [6, 7, 9, 12, 20, 60]) {
    const node = { args: { command }, expanded: false, isPartial: false };
    const legacy = renderBashCard(node, undefined, width, theme, 0);
    const geometry = cardGeometry(width, 0);
    const projected = paintBashCommand(command, geometry.contentWidth, theme, all(command))!;
    const actual = geometry.contentWidth ? frameRows(geometry, projected, toolCardPaint(theme, false)) : [];
    assert.deepEqual(plain(actual), plain(legacy.rows), `actual frame glyphs at width${width}, command${JSON.stringify(command)}`);
  }
});

test('empty/final-newline snapshots keep their baseline row shapes without inventing text', () => {
  assert.deepEqual(plain(paintFileSource('', theme, all(''))!), ['']);
  assert.deepEqual(plain(paintFileSource('x\n', theme, all('x\n'))!), ['x', '']);
  assert.deepEqual(plain(paintBashCommand('\n', 20, theme, all('\n'))!), ['$ ', '']);
});

test('unavailable coverage rejects the projection; zero command width never visits source data', () => {
  assert.equal(paintFileSource('x', theme, () => false), undefined);
  assert.equal(paintBashCommand('x', 20, theme, () => false), undefined);
  assert.deepEqual(paintBashCommand('x', 0, theme, () => { assert.fail('zero width must not visit'); }), []);
});

test('malformed/gapped canonical coverage cannot produce a partly trusted painted result', () => {
  for (const entries of [[[1, 2, 2]], [[0, 4, 2]], [[0, 1, 2], [2, 3, 3]], [[0, 1, 10]]]) {
    assert.equal(paintFileSource('abc', theme, ranges(entries as [number, number, number][])), undefined);
  }
});

test('historical Bash keeps only matching scalar-prefix colors, not equal suffix islands', () => {
  const basis = 'echo abc xyz', current = 'echo abd xyz';
  const rows = paintHistoricalBashCommand(current, basis, 60, theme, all(basis, 2))!;
  assert.deepEqual(plain(rows), ['$ ' + current]);
  assert.equal(rows[0], theme.fg('dim', '$ ') + theme.fg('syntaxKeyword', 'echo ab') + theme.fg('toolTitle', 'd xyz'));
  assert.equal(paintHistoricalBashCommand('echo ab', basis, 60, theme, all(basis, 2))![0],
    theme.fg('dim', '$ ') + theme.fg('syntaxKeyword', 'echo ab'), 'Current text can truncate a longer basis');
  const replaced = paintHistoricalBashCommand('😃!', '😀!', 60, theme, all('😀!', 2))!;
  assert.equal(replaced[0], theme.fg('dim', '$ ') + theme.fg('toolTitle', '😃!'), 'Equal high-surrogate halves are not scalar proof');
});

test('historical Bash appended combining and joined scalars inherit the whole current grapheme first-scalar style', () => {
  for (const [basis, joined] of [['e', 'e\u0301'], ['👩', '👩‍💻'], ['👩', '👩‍👩‍👧‍👦']]) {
    const current = joined + ' new';
    const rows = paintHistoricalBashCommand(current, basis!, 60, theme, all(basis!, 3))!;
    assert.deepEqual(plain(rows), ['$ ' + current]);
    assert.equal(rows[0], theme.fg('dim', '$ ') + theme.fg('syntaxString', joined!) + theme.fg('toolTitle', ' new'));
    assert.ok(rows[0]!.includes(joined!), 'No ANSI may split an indivisible displayed grapheme');
  }
});

test('historical Bash tabs, newline changes and narrow widths keep complete current glyphs with no suffix transfer', () => {
  const basis = 'echo\t界\nold', current = 'echo\t界\nnew 👩‍💻';
  for (const width of [1, 3, 8, 24, 60]) {
    const actual = paintHistoricalBashCommand(current, basis, width, theme, all(basis, 2))!;
    const expected = paintBashCommand(current, width, theme, all(current))!;
    assert.deepEqual(plain(actual), plain(expected));
    assert.ok(!actual.join('').includes(theme.fg('syntaxKeyword', 'new')));
  }
});

test('historical prefix: coverage distinguishes a matching basis from inherited styled glyphs', () => {
  const coverage = { matchedBytes: -1, styledBytes: -1 };
  paintHistoricalBashCommand('aa new', 'aa', 100, theme, all('aa', 0), coverage);
  assert.deepEqual(coverage, { matchedBytes: 2, styledBytes: 0 });
  paintHistoricalBashCommand('bb', 'aa', 100, theme, all('aa', 2), coverage);
  assert.deepEqual(coverage, { matchedBytes: 0, styledBytes: 0 });
  paintHistoricalBashCommand('e\u0301 tail', 'e', 100, theme, all('e', 2), coverage);
  assert.deepEqual(coverage, { matchedBytes: 1, styledBytes: 3 }, 'whole current grapheme inherits first matching scalar style, but appended scalars are not claimed as matched');
});
