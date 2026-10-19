import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { cardGeometry, frameRows, frameMeasuredRow } from '../../../src/card-frame.ts';

test('prepared frame: shares fixed shell geometry and preserves complete child attributes and clears', async () => {
  const g = cardGeometry(16), panel = (s: string) => '\x1b[48;5;17m' + s + '\x1b[49m', border = (s: string) => '\x1b[38;5;8m' + s + '\x1b[39m';
  const child = '\x1b[38;5;1;48;5;22;1;3;4mA\x1b[22;23;24;39;49m' + '\x1b[38;5;4;48;5;52;22;23;24mB\x1b[39;49m';
  const row = frameMeasuredRow(g, child, 2, { panel, border });
  const t = new xterm.Terminal({ cols: 16, rows: 2, allowProposedApi: true });
  await new Promise<void>(resolve => t.write(row, resolve));
  try {
    const line = t.buffer.active.getLine(0)!, a = line.getCell(g.contentX)!, b = line.getCell(g.contentX + 1)!;
    assert.equal(a.getChars(), 'A'); assert.equal(a.getFgColor(), 1); assert.equal(a.getBgColor(), 22); assert.ok(a.isBold() && a.isItalic() && a.isUnderline());
    assert.equal(b.getChars(), 'B'); assert.equal(b.getFgColor(), 4); assert.equal(b.getBgColor(), 52); assert.ok(!b.isBold() && !b.isItalic() && !b.isUnderline());
    assert.equal(line.getCell(g.contentX + 2)!.getBgColor(), 17);
    assert.ok(line.getCell(0)!.isBgDefault()); assert.ok(line.getCell(15)!.isBgDefault());
  } finally { t.dispose(); }
  assert.throws(() => frameMeasuredRow(g, '', g.contentWidth + 1, { panel, border }), RangeError);
  for (const outputPad of [0, 1]) for (let width = 1; width <= 16; width++) {
    const geometry = cardGeometry(width, outputPad), text = 'x'.repeat(geometry.contentWidth), paint = { panel: (s: string) => s, border: (s: string) => s };
    assert.equal(frameMeasuredRow(geometry, text, geometry.contentWidth, paint), frameRows(geometry, [text], paint)[1]);
  }
  assert.equal(frameMeasuredRow(cardGeometry(0), '', 0, { panel, border }), '');
});
