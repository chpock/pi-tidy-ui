import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPiDiff, mapPiDiffView } from '../../../scripts/highlight-compare/adapters/pi-diff.mjs';
import { mapOpenCodeDiff } from '../../../scripts/highlight-compare/adapters/opencode-diff.mjs';
import { nativeLayoutInputs } from '../../fixtures/highlight-compare/native-layout-inputs.mjs';
import { diffRows } from '../../../scripts/highlight-compare/fixtures.mjs';

const fixture = { filename: 'sample.txt', logicalRows: [
  { role: 'context', oldLine: 9, newLine: 9, text: 'context' },
  { role: 'removed', oldLine: 10, text: 'old' }, { role: 'added', newLine: 10, text: 'new' },
  { role: 'context', oldLine: 11, newLine: 11, text: 'tail' },
] };
const grid = (screen, width = 60) => ({ width, rows: screen.length, screen: screen.map(row => row.padEnd(width, ' ')),
  cells: screen.map(row => Array.from(row.padEnd(width, ' '), text => ({ text, width: 1, fg: -1, fgMode: 0, bg: -1, bgMode: 0 }))) });
const pi = () => grid([' ┃', ' ┃ ← Edited sample.txt', ' ┃', ' ┃   9   context', ' ┃  10 - old', ' ┃  10 + new', ' ┃  11   tail', ' ┃']);
const opencode = () => grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', '  ┃     9   context', '  ┃    10 - old', '  ┃    10 + new', '  ┃    11   tail', '  ┃']);

test('native diff maps bind exact number/sign/body and card padding independently of terminal colors', () => {
  for (const [map, page, column, cardStart, cardEnd] of [[mapPiDiff, pi(), 9, 2, 59], [mapOpenCodeDiff, opencode(), 12, 3, 58]]) {
    const result = map(fixture, [page]);
    assert.deepEqual(result.sourceMaps[0].map(range => [range.row, range.line, range.column, range.end]),
      [[3, 1, column, 7], [4, 2, column, 3], [5, 3, column, 3], [6, 4, column, 4]]);
    assert.deepEqual(result.surfaces[0], { kind: 'card-background', page: 0, row: 0, start: cardStart, end: cardEnd });
    assert.deepEqual(result.surfaces.filter(surface => surface.kind === 'sign').map(surface => [surface.logicalRow, surface.start, surface.end]),
      [[2, column - 2, column - 1], [3, column - 2, column - 1]]);
    assert.deepEqual(result.surfaces.filter(surface => surface.kind === 'line-number').map(surface => [surface.start, surface.end]),
      [[column - 4, column - 3], [column - 5, column - 3], [column - 5, column - 3], [column - 5, column - 3]]);
  }
});

test('native diff maps refuse wrong signs/numbers, changed source and missing card anchors', () => {
  const badNumber = pi(); badNumber.cells[4][4].text = '2';
  assert.throws(() => mapPiDiff(fixture, [badNumber]), /row\/side\/number/);
  const badSign = opencode(); badSign.cells[4][10].text = '+';
  assert.throws(() => mapOpenCodeDiff(fixture, [badSign]), /body text mismatch/);
  const badText = pi(); badText.cells[4][9].text = 'x';
  assert.throws(() => mapPiDiff(fixture, [badText]), /body text mismatch/);
  const badAnchor = pi(); badAnchor.cells[0][20].text = 'x';
  assert.throws(() => mapPiDiff(fixture, [badAnchor]), /background.*anchor/);
});

test('native split maps retain old/new context and distinguish blank removed content from opposite alignment padding', () => {
  const input = { filename: 'sample.txt', logicalRows: [
    { role: 'context', oldLine: 9, newLine: 9, text: 'context' },
    { role: 'removed', oldLine: 10, text: 'old' }, { role: 'removed', oldLine: 11, text: '' },
    { role: 'added', newLine: 10, text: 'new' }, { role: 'context', oldLine: 12, newLine: 11, text: 'tail' },
  ] };
  const page = grid([' ┃', ' ┃ ← Edited sample.txt', ' ┃', ' ┃', ' ┃', ' ┃', ' ┃', ' ┃'], 180);
  const put = (row, column, value) => { Array.from(value).forEach((character, i) => { page.cells[row][column + i].text = character; }); };
  put(3, 3, '  9   context'); put(3, 90, '  9   context');
  put(4, 3, ' 10 - old'); put(4, 90, ' 10 + new');
  put(5, 3, ' 11 - ');
  put(6, 3, ' 12   tail'); put(6, 90, ' 11   tail');
  const result = mapPiDiff(input, [page], 'split');
  assert.deepEqual(result.sourceMaps[0].map(range => [range.side, range.line, range.row, range.column]), [
    ['old', 1, 3, 9], ['new', 1, 3, 96], ['old', 2, 4, 9], ['new', 4, 4, 96], ['old', 3, 5, 9],
    ['old', 5, 6, 9], ['new', 5, 6, 96],
  ]);
  assert.deepEqual(result.alignmentPadding, [{ page: 0, row: 5, side: 'new', alignedRow: 3, gutterStart: 90, bodyStart: 96, end: 178 }]);
  assert.equal(mapPiDiffView(input, [page]).viewIdentity, 'split', 'observed pane populations determine the view, not nominal terminal width');
  assert.equal(result.surfaces.filter(surface => surface.logicalRow === 3 && surface.kind === 'sign').length, 1);
  const blankBody = result.surfaces.find(surface => surface.logicalRow === 3 && surface.kind === 'body-background');
  const trailing = result.surfaces.find(surface => surface.logicalRow === 3 && surface.kind === 'padding-background');
  assert.equal(blankBody.end - blankBody.start, 1, 'blank changed content has its own physical background witness');
  assert.equal(trailing.start, blankBody.end, 'horizontal padding does not reuse the blank content witness');
});

test('OpenCode empty split side has a three-column native gutter without a reserved sign', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'empty-pane');
  const input = { filename: source.filename, logicalRows: source.after.slice(0, -1).split('\n')
    .map((text, index) => ({ role: 'added', newLine: index + 1, text })) };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', '  ┃', '  ┃', '  ┃', '  ┃'], 180);
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
  put(3, 92, ' 1 + '); put(4, 92, ' 2 + first'); put(5, 92, ' 3 + second');
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page], 'split');
  assert.deepEqual(result.alignmentPadding.map(item => [item.gutterStart, item.bodyStart, item.end]),
    [[6, 9, 92], [6, 9, 92], [6, 9, 92]], 'native minWidth=3 plus no after-sign, not the populated five-column gutter');
  assert.deepEqual(result.sourceMaps[0].map(range => range.column), [97, 97, 97]);
});

test('OpenCode context-only side sizes digits from aligned virtual rows and reserves no after-sign', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'context-only-pane');
  const input = { filename: source.filename, logicalRows: source.after.slice(0, -1).split('\n').map((text, index) => index === 0
    ? { role: 'context', oldLine: 1, newLine: 1, text } : { role: 'added', newLine: index + 1, text }) };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(14).fill('  ┃')], 180);
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
  put(3, 6, '  1 context'); put(3, 92, '  1   context');
  for (let number = 2; number <= 13; number++) put(number + 2, 92, ' ' + String(number).padStart(2) + ' + insert ' + number);
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page], 'split');
  assert.equal(result.sourceMaps[0].find(range => range.side === 'old').column, 10,
    '13 native virtual rows need two digits even though the maximum old-file coordinate is one');
  assert.equal(result.sourceMaps[0].find(range => range.side === 'new').column, 98);
  assert.equal(result.alignmentPadding.length, 12);
  assert.equal(result.alignmentPadding.every(item => item.side === 'old' && item.bodyStart === 10), true);
});

test('OpenCode unified gutter counts physical diff rows as well as original file coordinates', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'unified-digit-boundary');
  const removed = source.before.slice(0, -1).split('\n').map((text, index) => ({ role: 'removed', oldLine: index + 1, text }));
  const added = source.after.slice(0, -1).split('\n').map((text, index) => ({ role: 'added', newLine: index + 1, text }));
  const input = { filename: source.filename, logicalRows: [...removed, ...added] };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(19).fill('  ┃')], 100);
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
  for (const [index, row] of input.logicalRows.entries()) {
    put(index + 3, 6, ' ' + String(row.oldLine ?? row.newLine).padStart(2) + ' ' + (row.role === 'removed' ? '-' : '+') + ' ' + row.text);
  }
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page]);
  assert.equal(result.sourceMaps[0].length, 18);
  assert.equal(result.sourceMaps[0].every(range => range.column === 12), true, '18 unified rows need two digits despite file coordinates ending at nine');
});

test('OpenCode split gutter counts paired rows rather than the sum of removed and added rows', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'split-digit-boundary');
  const removed = source.before.slice(0, -1).split('\n').map((text, index) => ({ role: 'removed', oldLine: index + 1, text }));
  const added = source.after.slice(0, -1).split('\n').map((text, index) => ({ role: 'added', newLine: index + 1, text }));
  const input = { filename: source.filename, logicalRows: [...removed, ...added] };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(10).fill('  ┃')], 180);
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
  for (const [index, row] of removed.entries()) put(index + 3, 6, ' ' + row.oldLine + ' - ' + row.text);
  put(3, 92, ' 1 + new 1');
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page], 'split');
  assert.equal(result.sourceMaps[0].length, 10);
  assert.equal(result.sourceMaps[0].filter(range => range.side === 'old').every(range => range.column === 11), true,
    'the patch-less LF-terminated vector uses nine neutral paired rows, not ten');
  assert.equal(result.sourceMaps[0].find(range => range.side === 'new').column, 97);
  assert.equal(result.alignmentPadding.length, 8);
});

for (const [oldFinalLF, newFinalLF] of [[false, true], [false, false], [true, false]]) {
  test('OpenCode split grouping respects EOF markers: oldLF=' + oldFinalLF + ', newLF=' + newFinalLF, () => {
    const source = nativeLayoutInputs.find(item => item.id === 'split-digit-boundary');
    const before = oldFinalLF ? source.before : source.before.slice(0, -1), after = newFinalLF ? source.after : source.after.slice(0, -1);
    const removed = source.before.slice(0, -1).split('\n'), marker = '\\ No newline at end of file';
    const patch = ['--- a/sample.txt', '+++ b/sample.txt', '@@ -1,9 +1 @@', ...removed.map(line => '-' + line),
      ...(oldFinalLF ? [] : [marker]), '+new 1', ...(newFinalLF ? [] : [marker]), ''].join('\n');
    const input = { ...source, before, after, patch, logicalRows: diffRows(patch, before, after) };
    const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(11).fill('  ┃')], 180);
    const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
    const digits = oldFinalLF ? 1 : 2;
    for (const [index, line] of removed.entries()) put(index + 3, 6, ' ' + String(index + 1).padStart(digits) + ' - ' + line);
    put(oldFinalLF ? 3 : 12, 92, ' ' + '1'.padStart(digits) + ' + new 1');
    page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
    const result = mapOpenCodeDiff(input, [page], 'split');
    assert.equal(result.sourceMaps[0].length, 10);
    assert.equal(result.sourceMaps[0].filter(range => range.side === 'old').every(range => range.column === (oldFinalLF ? 11 : 12)), true);
    assert.equal(result.sourceMaps[0].find(range => range.side === 'new').column, oldFinalLF ? 97 : 98);
    assert.equal(result.alignmentPadding.length, oldFinalLF ? 8 : 10,
      'an old-side EOF marker splits the replacement; a new-side-only marker does not');
  });
}

test('OpenCode context EOF markers add no physical row or replacement boundary', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'unified-digit-boundary');
  const oldLines = source.before.slice(0, -1).split('\n'), newLines = source.after.slice(0, -1).split('\n').slice(0, 6);
  const before = oldLines.join('\n'), after = [...newLines, ...oldLines.slice(6)].join('\n');
  const patch = ['--- a/sample.txt', '+++ b/sample.txt', '@@ -1,9 +1,9 @@', ...oldLines.slice(0, 6).map(line => '-' + line),
    ...newLines.map(line => '+' + line), ...oldLines.slice(6).map(line => ' ' + line), '\\ No newline at end of file', ''].join('\n');
  const input = { ...source, before, after, patch, logicalRows: diffRows(patch, before, after) };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(10).fill('  ┃')], 180);
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { page.cells[row][column + index].text = character; });
  for (const [index, line] of oldLines.entries()) {
    put(index + 3, 6, ' ' + (index + 1) + (index < 6 ? ' - ' : '   ') + line);
    put(index + 3, 92, ' ' + (index + 1) + (index < 6 ? ' + ' + newLines[index] : '   ' + line));
  }
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page], 'split');
  assert.equal(result.sourceMaps[0].length, 18);
  assert.equal(result.sourceMaps[0].filter(range => range.side === 'old').every(range => range.column === 11), true);
  assert.equal(result.sourceMaps[0].filter(range => range.side === 'new').every(range => range.column === 97), true);
  assert.equal(result.alignmentPadding.length, 0);
});

test('OpenCode empty new-side gutter reserves no sign columns', () => {
  const source = nativeLayoutInputs.find(item => item.id === 'empty-pane');
  const input = { filename: source.filename, logicalRows: source.after.slice(0, -1).split('\n')
    .map((text, index) => ({ role: 'removed', oldLine: index + 1, text })) };
  const page = grid(['  ┃', '  ┃  ← Edit sample.txt', '  ┃', ...Array(4).fill('  ┃')], 180);
  const put = (row, text) => Array.from(text).forEach((character, index) => { page.cells[row][6 + index].text = character; });
  for (const [index, row] of input.logicalRows.entries()) put(index + 3, ' ' + row.oldLine + ' - ' + row.text);
  page.screen = page.cells.map(row => row.map(cell => cell.text).join(''));
  const result = mapOpenCodeDiff(input, [page], 'split');
  assert.equal(result.sourceMaps[0].every(range => range.column === 11), true);
  assert.deepEqual(result.alignmentPadding.map(item => [item.gutterStart, item.bodyStart, item.end]),
    [[92, 95, 178], [92, 95, 178], [92, 95, 178]]);
});
