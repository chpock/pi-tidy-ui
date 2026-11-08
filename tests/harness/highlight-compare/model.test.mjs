import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, projectLine, normalizeSource, compareCaptures, renderReport } from '../../../scripts/highlight-compare/model.mjs';

const ink = (fg = 0x123456) => ({ foreground: { mode: 'rgb', value: fg }, background: { mode: 'default' }, attributes: [] });
const cell = (text, width = 1, fg = 0x123456) => ({ text, width, fg, fgMode: 0x3000000, bg: -1, bgMode: 0,
  bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false });
const page = rows => ({ width: 20, rows: rows.length, cells: rows.map(row => Array.from(row, c => cell(c))) });
const segment = (row, line, start, end, column = 0) => ({ row, line, start, end, column });
const capture = (source, spans) => ({ schema: 1, status: 'ready', application: 'test', fixture: { id: 'case', kind: 'source', sha256: digest(source) },
  theme: { family: 'github', variant: 'dark' }, source, spans, readiness: { status: 'ready', method: 'test-only' } });

test('comparison projection preserves original graphemes and accounts for tabs and terminal columns', () => {
  const result = projectLine('a\t界é', 4);
  assert.equal(result.text, 'a   界é');
  assert.deepEqual(result.glyphs.map(g => [g.source, g.display, g.column, g.columns]), [['a', 'a', 0, 1], ['\t', '   ', 1, 3], ['界', '界', 4, 2], ['é', 'é', 6, 1]]);
  assert.throws(() => projectLine('x\x1b[31m'), /control/i);
});

test('comparison source mapping checks every range, including wraps and overlapping pages', () => {
  const source = 'abcdef\nsecond\n';
  const pages = [page(['abc', 'def', 'second']), page(['second'])];
  const maps = [[segment(0, 1, 0, 3), segment(1, 1, 3, 6), segment(2, 2, 0, 6)], [segment(0, 2, 0, 6)]];
  const result = normalizeSource(source, pages, maps);
  assert.equal(result.spans.map(s => s.text).join(''), 'abcdefsecond');
  assert.equal(result.coveredLines, 2);
  assert.equal(result.spans.at(-1).endByte, Buffer.byteLength(source) - 1);
  assert.throws(() => normalizeSource(source, [page(['abc', 'wrong', 'second'])], [maps[0]]), /text.*mismatch/i);
  assert.throws(() => normalizeSource(source, [pages[0]], [[segment(0, 1, 0, 3)]]), /coverage/i);
  const altered = page(['second']); altered.cells[0][2].fg = 0xabcdef;
  assert.throws(() => normalizeSource(source, [pages[0], altered], maps), /overlap/i);
});

test('comparison source mapping handles wide cells, combining text, tabs, and CRLF source offsets', () => {
  const source = '界é\tX\r\n';
  const cells = [cell('界', 2), cell('', 0), cell('é'), cell(' '), cell('X')];
  const result = normalizeSource(source, [{ width: 5, rows: 1, cells: [cells] }], [[segment(0, 1, 0, 5)]], { tabSize: 4 });
  assert.equal(result.spans.length, 4);
  assert.deepEqual(result.spans.map(s => [s.startByte, s.endByte]), [[0, 3], [3, 6], [6, 7], [7, 8]]);
  assert.equal(result.spans[0].columns, 2);
  assert.equal(result.spans[1].text, 'é');
  assert.throws(() => normalizeSource(source, [{ width: 5, rows: 1, cells: [cells] }], [[segment(0, 1, 2, 5)]]), /grapheme/i);
});

test('comparison keeps RGB, indexed, default and font-only style differences observable', () => {
  const source = 'ab';
  const a = normalizeSource(source, [page(['ab'])], [[segment(0, 1, 0, 2)]]);
  const other = page(['ab']); other.cells[0][0].fgMode = 0x1000000; other.cells[0][0].fg = 2; other.cells[0][1].italic = true;
  const b = normalizeSource(source, [other], [[segment(0, 1, 0, 2)]]);
  assert.deepEqual(a.spans[0].projection[0].style, ink());
  const report = compareCaptures(capture(source, a.spans), capture(source, b.spans));
  assert.equal(report.changed.length, 2);
  assert.equal(report.changed[0].right.projection[0].style.foreground.mode, 'indexed');
  assert.deepEqual(report.changed[1].right.projection[0].style.attributes, ['italic']);
  assert.match(renderReport(report), /not.*parser/i);
});

test('comparison rejects incompatible fixtures, themes, missing positions, and unready evidence', () => {
  const source = 'ab';
  const { spans } = normalizeSource(source, [page(['ab'])], [[segment(0, 1, 0, 2)]]);
  const a = capture(source, spans);
  assert.equal(compareCaptures(a, structuredClone(a)).changed.length, 0);
  assert.throws(() => compareCaptures(a, { ...a, status: 'failed' }), /ready/i);
  assert.throws(() => compareCaptures(a, { ...a, spans: spans.slice(1) }), /position|coverage/i);
  assert.throws(() => compareCaptures(a, { ...a, theme: { family: 'github', variant: 'light' } }), /theme/i);
  assert.throws(() => compareCaptures(a, { ...a, source: 'ac' }), /source|digest/i);
});

test('comparison does not count different uniform tab expansion widths as a syntax style change', () => {
  const source = '\tX';
  const a = normalizeSource(source, [page(['    X'])], [[segment(0, 1, 0, 2)]], { tabSize: 4 });
  const b = normalizeSource(source, [page(['  X'])], [[segment(0, 1, 0, 2)]], { tabSize: 2 });
  const left = { ...capture(source, a.spans), tabSize: 4 }, right = { ...capture(source, b.spans), tabSize: 2 };
  const report = compareCaptures(left, right);
  assert.equal(report.changed.length, 0);
  assert.deepEqual(report.geometryDifferences, [{ line: 1, startByte: 0, endByte: 1, leftColumns: 4, rightColumns: 2 }]);
  const changed = structuredClone(right); changed.spans[0].projection.forEach(cell => { cell.style.foreground.value = 0xabcdef; });
  assert.equal(compareCaptures(left, changed).changed.length, 1, 'changed tab foreground remains observable');
});

test('comparison ignores JSON key/font-set ordering but preserves a background-only difference', () => {
  const source = 'x', { spans } = normalizeSource(source, [page(['x'])], [[segment(0, 1, 0, 1)]]);
  const left = capture(source, spans), right = structuredClone(left);
  left.spans[0].projection[0].style.attributes = ['bold', 'italic'];
  const style = right.spans[0].projection[0].style;
  right.spans[0].projection[0].style = { attributes: ['italic', 'bold'], background: style.background,
    foreground: { value: style.foreground.value, mode: style.foreground.mode } };
  assert.equal(compareCaptures(left, right).changed.length, 0);
  right.spans[0].projection[0].style.background = { mode: 'rgb', value: 0x112233 };
  const changed = compareCaptures(left, right).changed;
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].right.projection[0].style.background, { mode: 'rgb', value: 0x112233 });
});

test('comparison projection distinguishes native fixed tabs from line-relative tab stops', () => {
  assert.equal(projectLine('a\tb\t', 2, 'fixed').text, 'a  b  ');
  assert.equal(projectLine('a\tb\t', 2, 'stops').text, 'a b ');
  assert.throws(() => projectLine('x', 2, 'guessed'), /tab expansion mode/);
  const source = 'a\tb';
  const a = normalizeSource(source, [page(['a   b'])], [[segment(0, 1, 0, 3)]], { tabSize: 4, tabMode: 'stops' });
  const b = normalizeSource(source, [page(['a  b'])], [[segment(0, 1, 0, 3)]], { tabSize: 2, tabMode: 'fixed' });
  const report = compareCaptures({ ...capture(source, a.spans), tabSize: 4, tabMode: 'stops' }, { ...capture(source, b.spans), tabSize: 2, tabMode: 'fixed' });
  assert.equal(report.changed.length, 0);
  assert.deepEqual(report.geometryDifferences, [{ line: 1, startByte: 1, endByte: 2, leftColumns: 3, rightColumns: 2 }]);
});


test('comparison reports independent style channels per declared source feature without quality scoring', () => {
  const source = 'ab\ncd';
  const maps = [[segment(0, 1, 0, 2), segment(1, 2, 0, 2)]];
  const left = capture(source, normalizeSource(source, [page(['ab', 'cd'])], maps).spans);
  left.fixture.cases = [
    { id: 'first', title: 'First feature', startLine: 1, endLine: 1, features: ['keywords'] },
    { id: 'second', startLine: 2, endLine: 2, features: ['strings', 'numbers'] },
  ];
  const right = structuredClone(left);
  right.spans[0].projection[0].style.foreground.value = 0xabcdef;
  right.spans[1].projection[0].style.attributes.push('italic');
  right.spans[2].projection[0].style.background = { mode: 'rgb', value: 0x112233 };
  right.spans[3].projection[0].style.foreground.value = 0xabcdef;
  right.spans[3].projection[0].style.background = { mode: 'rgb', value: 0x112233 };
  right.spans[3].projection[0].style.attributes.push('dim');
  const report = compareCaptures(left, right);
  assert.deepEqual(report.differences, { foreground: 2, background: 2, attributes: 2 });
  assert.deepEqual(report.features.map(entry => [entry.id, entry.positionsCompared, entry.differences]), [
    ['first', 2, { foreground: 1, background: 0, attributes: 1 }],
    ['second', 2, { foreground: 1, background: 2, attributes: 1 }],
  ]);
  assert.deepEqual(report.changed.map(entry => entry.channels), [['foreground'], ['attributes'], ['background'], ['foreground', 'background', 'attributes']]);
  assert.equal(report.features[1].title, 'second', 'a stable case ID is sufficient without an optional display title');
  const readable = renderReport(report);
  assert.match(readable, /Feature observations/);
  assert.match(readable, /First feature.*keywords/);
  assert.match(readable, /not quality scores/);
  const invalid = structuredClone(left); invalid.fixture.cases[0].endLine = 3;
  assert.throws(() => compareCaptures(invalid, invalid), /feature case range/i);
});
