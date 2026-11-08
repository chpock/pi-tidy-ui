import { logicalLines, projectLine } from './model.mjs';

function numbered(row) {
  const prefix = row.slice(0, 22).map(cell => cell?.width ? cell.text || ' ' : '').join('');
  const match = /^[ ┃│]*(\d+)(?=[ ┃│])/.exec(prefix);
  return match && { line: Number(match[1]), end: match[0].length };
}

function take(row, column, glyphs, first = 0) {
  let x = column, next = first;
  for (; next < glyphs.length; next++) {
    const glyph = glyphs[next];
    let text = '', end = x;
    while (text.length < glyph.display.length) {
      const cell = row[end];
      if (!cell || cell.width < 1) break;
      text += cell.text || ' '; end += cell.width;
      if (!glyph.display.startsWith(text)) break;
    }
    if (text !== glyph.display || end - x !== glyph.columns) break;
    x = end;
  }
  return { next, column: x };
}

export function mapNumberedSource(source, pages, { tabSize = 4, tabMode = 'stops' } = {}) {
  const lines = logicalLines(source), projected = lines.map(line => projectLine(line.text, tabSize, tabMode));
  const votes = new Map();
  for (const page of pages) for (const row of page.cells) {
    const number = numbered(row), glyphs = number && projected[number.line - 1]?.glyphs;
    if (!glyphs?.length) continue;
    for (let x = number.end; x < Math.min(number.end + 12, row.length); x++) {
      if (row.slice(number.end, x).some(cell => !/^[ ┃│]*$/u.test(cell.text))) break;
      if (take(row, x, glyphs).next === glyphs.length) votes.set(x, (votes.get(x) ?? 0) + 1);
    }
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] === ranked[1]?.[1]) throw new Error('Ambiguous or missing native source gutter');
  const column = ranked[0][0], maps = [];
  for (const page of pages) {
    const ranges = [];
    let current;
    for (const [rowIndex, row] of page.cells.entries()) {
      const number = numbered(row);
      if (number && number.line >= 1 && number.line <= lines.length && row.slice(0, column).every(cell => /^[ 0-9┃│]*$/u.test(cell.text))) {
        current = { line: number.line, next: 0 };
      } else if (!current || row.slice(0, column).some(cell => !/^[ ┃│]*$/u.test(cell.text))) { current = undefined; continue; }
      const glyphs = projected[current.line - 1].glyphs, start = current.next;
      const consumed = take(row, column, glyphs, start);
      if (consumed.next === start && glyphs.length) { current = undefined; continue; }
      ranges.push({ row: rowIndex, line: current.line, start: glyphs[start]?.start ?? 0,
        end: glyphs[consumed.next - 1]?.end ?? 0, column });
      current.next = consumed.next;
      if (current.next === glyphs.length) current = undefined;
    }
    maps.push(ranges);
  }
  return { maps, bodyColumn: column, tabSize, tabMode };
}
