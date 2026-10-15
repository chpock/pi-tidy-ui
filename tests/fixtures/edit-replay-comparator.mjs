import assert from 'node:assert/strict';
import { plain, toolLines } from './terminal-harness.mjs';

export function replayBlockStart(dump, block) {
  return dump.screen.map(plain).findIndex((row, y, screen) =>
    row === block[0] && block.every((value, offset) => screen[y + offset] === value));
}
export function compareEditReplayColors(actual, expected, uncolored) {
  assert.deepEqual(toolLines(actual).filter((_, index) => index !== 4), toolLines(expected).filter((_, index) => index !== 4),
    'all eager-language, summary and one-sided replay colors remain byte-identical');
  const actualHtml = actual.tools[4].lines, expectedHtml = expected.tools[4].lines;
  assert.deepEqual(actualHtml.map(plain), expectedHtml.map(plain), 'accepted cold HTML fallback changes no glyphs or geometry');
  const plainFallback = JSON.stringify(actualHtml) !== JSON.stringify(expectedHtml);
  // Pi loads HTML after initial replay paint. Only its exact retained mdCodeBlock
  // foreground alternative is accepted; all other physical cell fields stay exact.
  const block = actualHtml.map(plain), actualStart = replayBlockStart(actual, block), expectedStart = replayBlockStart(expected, block);
  assert.ok(actualStart >= 0 && expectedStart >= 0);
  let sourceCells = 0, sourceOrigin;
  for (let row = 0; row < block.length; row++) {
    const prefix = /^\s*┃\s+\d+ [ +\-] /.exec(block[row]);
    if (prefix) sourceOrigin = prefix[0].length;
    const to = block[row].trimEnd().length;
    const continuation = sourceOrigin !== undefined && to > sourceOrigin && /^\s*┃\s+$/.test(block[row].slice(0, sourceOrigin));
    const from = prefix?.[0].length ?? (continuation ? sourceOrigin : undefined);
    for (let column = 0; column < actual.width; column++) {
      const cell = actual.cells[actualStart + row][column], old = expected.cells[expectedStart + row][column];
      if (plainFallback && from !== undefined && column >= from && column < to) {
        if (cell.text.trim()) {
          assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, uncolored, 'only the exact plain Pi HTML foreground is allowed');
          sourceCells++;
        } else assert.ok(cell.fg === old.fg && cell.fgMode === old.fgMode
          || cell.fg === uncolored.fg && cell.fgMode === uncolored.fgMode, 'source blanks use only the original or exact fallback foreground');
        const { fg: _fg, fgMode: _mode, ...rest } = cell;
        const { fg: _oldFg, fgMode: _oldMode, ...oldRest } = old;
        assert.deepEqual(rest, oldRest, 'HTML syntax color deviation preserves every background/font/glyph field');
      } else if (plainFallback && from !== undefined && column >= to && !cell.text.trim()
        && cell.fg === uncolored.fg && cell.fgMode === uncolored.fgMode) {
        // A wrapped fragment can carry its foreground across blank trailing padding.
        const { fg: _fg, fgMode: _mode, ...rest } = cell;
        const { fg: _oldFg, fgMode: _oldMode, ...oldRest } = old;
        assert.deepEqual(rest, oldRest, 'blank wrap padding retains exact glyph/background/font fields');
      } else assert.deepEqual(cell, old, 'HTML gutters, signs, heading, spine and all unaffected cells stay exact');
    }
  }
  if (plainFallback) assert.ok(sourceCells > 0, 'the allowed foreground alternative is positively exercised');
}
