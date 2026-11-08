import { projectLine } from '../model.mjs';
import { changedGroups } from '../diff.mjs';

const text = (cells, start, end) => cells.slice(start, end).map(cell => cell.width === 0 ? '' : cell.text || ' ').join('');
const spaces = value => /^ *$/u.test(value);
const numberFor = (row, side) => side === 'old' ? row.oldLine : side === 'new' ? row.newLine : row.newLine ?? row.oldLine;
const rowSide = (row, side) => side === 'old' ? row.role !== 'added' : side === 'new' ? row.role !== 'removed' : true;

/** Shared opt-in mapper for native number/space/sign gutters; other references supply their own maps. */
export function mapNumberedDiff(fixture, pages, profile) {
  const { header, viewIdentity, contentInset, cardRightInset, bodyRightInset, sharedDigits = false, tabSize = 4, tabMode = 'stops', gutter } = profile;
  if (!['unified', 'split'].includes(viewIdentity)) throw new Error('Unsupported native diff view');
  const sourceMaps = [], surfaces = [], alignmentPadding = [], geometry = [];
  const maximum = rows => Math.max(1, ...rows.flatMap(row => [row.oldLine ?? 0, row.newLine ?? 0]));
  const alignedRows = viewIdentity === 'unified' ? fixture.logicalRows.length :
    fixture.logicalRows.filter(row => row.role === 'context').length +
      changedGroups(fixture.logicalRows).reduce((count, group) => count + Math.max(group.oldRows.length, group.newRows.length), 0);
  const layout = side => {
    const rows = fixture.logicalRows.filter(row => rowSide(row, side));
    const maxNumber = Math.max(1, ...rows.map(row => numberFor(row, side)));
    return gutter ? gutter({ side, alignedRows, maxNumber, hasSign: rows.some(row => row.role !== 'context') }) :
      { digits: String(sharedDigits ? maximum(fixture.logicalRows) : maxNumber).length, after: 2 };
  };
  for (const [pageIndex, page] of pages.entries()) {
    const headings = page.screen.flatMap((line, row) => line.includes(header + fixture.filename) ? [row] : []);
    if (headings.length !== 1) throw new Error('Ambiguous or missing native Edit card heading');
    const heading = headings[0], bar = page.cells[heading].findIndex(cell => cell.text === '┃');
    const cardRight = page.cells[heading].length - cardRightInset, right = page.cells[heading].length - bodyRightInset;
    const left = bar + contentInset, anchor = heading - 1;
    if (bar < 0 || anchor < 0 || page.cells[anchor]?.[bar]?.text !== '┃' ||
      !spaces(text(page.cells[anchor], bar + 1, cardRight))) throw new Error('Missing native card-background padding anchor');
    surfaces.push({ kind: 'card-background', page: pageIndex, row: anchor, start: bar + 1, end: cardRight });
    const middle = left + Math.floor((right - left) / 2);
    const panes = viewIdentity === 'unified' ? [{ side: 'unified', left, right }] :
      [{ side: 'old', left, right: middle }, { side: 'new', left: middle, right }];
    for (const pane of panes) Object.assign(pane, layout(pane.side));
    geometry.push({ page: pageIndex, heading, bar, cardRight, panes });
    const maps = [];
    for (let row = heading + 1; row < page.cells.length && page.cells[row][bar]?.text === '┃'; row++) {
      const cells = page.cells[row], mapped = [];
      for (const pane of panes) {
        const bodyStart = pane.left + pane.digits + pane.after + 2, numberEnd = bodyStart - 1 - pane.after;
        if (bodyStart >= pane.right) throw new Error('Native diff pane is too narrow');
        const prefix = text(cells, pane.left, bodyStart), digitsText = text(cells, pane.left + 1, numberEnd).trim();
        if (spaces(text(cells, pane.left, pane.right))) { mapped.push({ pane, bodyStart }); continue; }
        const sign = pane.after ? cells[bodyStart - 2]?.text || ' ' : ' ';
        const expectedPrefix = ' ' + digitsText.padStart(pane.digits) + (pane.after ? ' '.repeat(pane.after - 1) + sign : '') + ' ';
        if (!/^\d+$/u.test(digitsText) || !['+', '-', ' '].includes(sign) || prefix !== expectedPrefix) {
          throw new Error('Unexpected native diff gutter or wrapped body row');
        }
        const role = sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context', number = Number(digitsText);
        const matches = fixture.logicalRows.flatMap((entry, index) => rowSide(entry, pane.side) && entry.role === role && numberFor(entry, pane.side) === number ? [index] : []);
        if (matches.length !== 1) throw new Error('Unexpected or ambiguous native diff row/side/number');
        const index = matches[0], entry = fixture.logicalRows[index], projection = projectLine(entry.text, tabSize, tabMode);
        if (Math.max(1, projection.columns) >= pane.right - bodyStart) throw new Error('Native diff body must fit with observable trailing padding');
        const actual = text(cells, bodyStart, pane.right);
        if (!actual.startsWith(projection.text) || !spaces(actual.slice(projection.text.length))) throw new Error('Native diff body text mismatch');
        const logicalRow = index + 1, common = { page: pageIndex, row, logicalRow, side: pane.side };
        maps.push({ row, line: logicalRow, side: pane.side, column: bodyStart, start: 0, end: entry.text.length });
        const contentEnd = bodyStart + Math.max(1, projection.columns);
        surfaces.push({ ...common, kind: 'body-background', start: bodyStart, end: contentEnd },
          { ...common, kind: 'gutter-background', start: pane.left, end: bodyStart },
          { ...common, kind: 'padding-background', start: contentEnd, end: pane.right },
          { ...common, kind: 'line-number', start: numberEnd - digitsText.length, end: numberEnd });
        if (role !== 'context') surfaces.push({ ...common, kind: 'sign', start: bodyStart - 2, end: bodyStart - 1 });
        mapped.push({ pane, bodyStart, logicalRow, role });
      }
      if (viewIdentity === 'split') for (let index = 0; index < mapped.length; index++) {
        const current = mapped[index], peer = mapped[1 - index];
        if (!current.logicalRow && peer.logicalRow) {
          if (peer.role === 'context') throw new Error('Split context row is missing its opposite side');
          alignmentPadding.push({ page: pageIndex, row, side: current.pane.side, alignedRow: peer.logicalRow,
            gutterStart: current.pane.left, bodyStart: current.bodyStart, end: current.pane.right });
        }
      }
    }
    sourceMaps.push(maps);
  }
  return { viewIdentity, sourceMaps, surfaces, alignmentPadding, geometry, tabSize, tabMode };
}
