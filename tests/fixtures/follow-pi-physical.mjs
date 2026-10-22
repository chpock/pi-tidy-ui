import assert from 'node:assert/strict';
import { colorToOklch, indexedColor, rgbColor } from '@earendil-works/pi-tui';

export const followPiMarkers = ['FOLLOW_PI_BASH', 'FOLLOW_PI_HEADING', 'gone', 'fixed'];
export function spans(dump, text, filter = () => true) {
  const result = [];
  for (let y = 0; y < dump.screen.length; y++) {
    if (!filter(dump.screen[y])) continue;
    let x = -1;
    while ((x = dump.screen[y].indexOf(text, x + 1)) >= 0) result.push({ y, x, cells: dump.cells[y].slice(x, x + text.length) });
  }
  assert.ok(result.length > 0, `physical source ${text}`);
  return result;
}
// Expectations come from actual public Pi output, not the palette implementation.
export function publicInk(dump, role) {
  const prefix = dump.summaryStyles[role], rgb = prefix.match(/38;2;(\d+);(\d+);(\d+)m/), index = prefix.match(/38;5;(\d+)m/);
  if (rgb) return { fg: +rgb[1] * 65536 + +rgb[2] * 256 + +rgb[3], fgMode: 3 << 24 };
  return index ? { fg: +index[1], fgMode: 2 << 24 } : { fg: -1, fgMode: 0 };
}
const same = (first, second) => first.fg === second.fg && first.fgMode === second.fgMode;
function color(ink) {
  if (ink.fgMode === 3 << 24) return rgbColor(ink.fg >>> 16 & 255, ink.fg >>> 8 & 255, ink.fg & 255);
  if (ink.fgMode === 1 << 24 || ink.fgMode === 2 << 24) return indexedColor(ink.fg);
  return undefined;
}
function distance(first, second) {
  const a = colorToOklch(first), b = colorToOklch(second), radians = degrees => degrees * Math.PI / 180;
  return Math.hypot(a.l - b.l, a.c * Math.cos(radians(a.h)) - b.c * Math.cos(radians(b.h)),
    a.c * Math.sin(radians(a.h)) - b.c * Math.sin(radians(b.h)));
}
function derived(marker, parent, minimum, label) {
  const actual = color(marker), source = color(parent);
  assert.ok(actual && source, `${label}: both physical and authored colors are numeric`);
  assert.equal(same(marker, parent), false, `${label}: derived marker differs from its own semantic source`);
  assert.ok(distance(actual, source) >= minimum, `${label}: final emitted separation must be at least ${minimum}`);
}
export function paintProof(dump, { distinct = true } = {}) {
  for (const text of ['FOLLOW_PI_HEADING', 'LIST_HEADING']) for (const found of spans(dump, text)) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'mdHeading')) && cell.bold));
    const x = dump.screen[found.y].lastIndexOf('#', found.x); assert.ok(x >= 1);
    for (const mark of [x - 1, x]) {
      if (distinct) derived(dump.cells[found.y][mark], publicInk(dump, 'mdHeading'), 0.12, 'heading marker');
    }
  }
  // The pinned grammar leaves this indented heading unclassified; never infer a missing scope in the painter.
  for (const found of spans(dump, 'NESTED_HEADING_UNSCOPED'))
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'toolOutput')) && !cell.bold));
  for (const [text, offset, length] of [['LIST_UNORDERED', 2, 1], ['LIST_ORDERED', 3, 2], ['LIST_PARENT', 2, 1]]) for (const found of spans(dump, text)) {
    assert.ok(dump.cells[found.y].slice(found.x - offset, found.x - offset + length).every(cell => same(cell, publicInk(dump, 'mdListBullet'))), 'list markers keep their independent authored role');
  }
  for (const found of spans(dump, 'inline')) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'mdCode'))));
    const open = dump.cells[found.y][found.x - 1], close = dump.cells[found.y][found.x + 6];
    assert.equal(same(open, close), true, 'both inline delimiters agree');
    if (distinct) derived(open, publicInk(dump, 'mdCode'), 0.07, 'inline-code delimiter');
  }
  for (const text of ['site', 'second', 'ref', 'alt']) for (const found of spans(dump, text, row => text !== 'ref' || row.includes('[ref]'))) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'mdLink')) && (text === 'alt' || cell.underline)));
    for (const x of [found.x - 1, found.x + text.length]) {
      const marker = dump.cells[found.y][x];
      assert.equal(!!marker.underline, false);
      if (distinct) derived(marker, publicInk(dump, 'mdLink'), 0.07, 'link/image/reference delimiter');
    }
  }
  for (const found of spans(dump, 'double`tick')) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'mdCode'))));
    for (const x of [found.x - 2, found.x - 1, found.x + 11, found.x + 12]) {
      if (distinct) derived(dump.cells[found.y][x], publicInk(dump, 'mdCode'), 0.07, 'repeated inline-code delimiter');
      assert.equal(same(dump.cells[found.y][x], dump.cells[found.y][found.x - 1]), true, 'repeated backticks use one marker shade');
    }
  }
  for (const found of spans(dump, 'FOLLOW_PI_QUOTE')) {
    const marker = dump.cells[found.y][found.x - 2];
    assert.equal(same(marker, publicInk(dump, 'mdQuoteBorder')), true, 'blockquote marker uses its dedicated Pi role');
  }
  for (const text of ['gone', 'fixed']) for (const found of spans(dump, text)) {
    assert.ok(found.cells.every(cell => cell.strike && cell.bold && cell.italic), 'nested bold/italic/strike survive the actual flat painter');
    const begin = found.x - 5, end = found.x + text.length + 3;
    for (const x of [begin, begin + 1, end, end + 1]) assert.equal(dump.cells[found.y][x].strike, false, 'strike markers are not struck');
  }
  for (const text of ['BOLD_STAR', 'BOLD_UNDER', 'gone', 'fixed']) for (const found of spans(dump, text)) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'accent')) && cell.bold), `${text}: Markdown bold uses exact public accent and bold`);
  }
  for (const found of spans(dump, 'after')) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'toolOutput'))), 'accent does not leak after bold');
  }
  for (const found of spans(dump, 'after')) assert.ok(found.cells.every(cell => !cell.strike && !cell.bold && !cell.italic && !cell.underline), 'fonts do not leak after the nested span');
  for (const found of spans(dump, 'FOLLOW_PI_BASH', row => row.includes('printf'))) {
    assert.ok(found.cells.every(cell => same(cell, publicInk(dump, 'syntaxString'))));
    for (const x of [found.x - 1, found.x + 'FOLLOW_PI_BASH'.length])
      assert.equal(same(dump.cells[found.y][x], found.cells[0]), true, 'string quotes remain part of the literal');
    const x = dump.screen[found.y].indexOf('printf');
    assert.equal(same(dump.cells[found.y][x], publicInk(dump, 'syntaxFunction')), true);
  }
}
export const publications = terminal => new Map(terminal.events().filter(e => e.type === 'syntax_card_publication' && e.origin === 'pi').map(e => [e.id, e]));

export function delimiterCells(dump) {
  const result = [];
  for (const found of spans(dump, 'FOLLOW_PI_HEADING')) result.push({ family: 'heading', parent: publicInk(dump, 'mdHeading'), cell: dump.cells[found.y][dump.screen[found.y].lastIndexOf('#', found.x)] });
  for (const found of spans(dump, 'inline')) for (const x of [found.x - 1, found.x + 6]) result.push({ family: 'inline', parent: publicInk(dump, 'mdCode'), cell: dump.cells[found.y][x] });
  for (const found of spans(dump, 'site')) for (const x of [found.x - 1, found.x + 4]) result.push({ family: 'link', parent: publicInk(dump, 'mdLink'), cell: dump.cells[found.y][x] });
  for (const found of spans(dump, 'FOLLOW_PI_BASH', row => row.includes('printf'))) for (const x of [found.x - 1, found.x + 'FOLLOW_PI_BASH'.length]) result.push({ family: 'string', parent: publicInk(dump, 'syntaxString'), cell: dump.cells[found.y][x] });
  return result;
}
