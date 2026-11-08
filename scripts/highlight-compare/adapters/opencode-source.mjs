import { mapNumberedSource } from '../alignment.mjs';
import { cellStyle, logicalLines, projectLine } from '../model.mjs';

export function mapOpenCodeSource(source, pages, { tabSize = 2, tabMode = 'fixed' } = {}) {
  const bodyPages = pages.map(page => ({ ...page, cells: page.cells.map(row =>
    row[2]?.text === '┃' && row.slice(0, 2).every(cell => !cell.text || cell.text === ' ')
      ? row.slice(0, row.length - 2) : []) }));
  return mapNumberedSource(source, bodyPages, { tabSize, tabMode });
}

export function styledSourceWitness(source, page, alignment) {
  if (!Number.isSafeInteger(page.frame) || page.frame < 1 || page.rendering !== false) throw new Error('OpenCode source witness requires a completed native synchronized frame');
  const lines = logicalLines(source), styles = new Map();
  const observations = [];
  for (const range of alignment.maps[0]) {
    const projected = projectLine(lines[range.line - 1].text, alignment.tabSize, alignment.tabMode);
    const width = projected.glyphs.filter(glyph => glyph.start >= range.start && glyph.end <= range.end).reduce((sum, glyph) => sum + glyph.columns, 0);
    for (let column = range.column; column < range.column + width; column++) {
      const cell = page.cells[range.row][column];
      if (!cell.width) continue;
      const { foreground, attributes } = cellStyle(cell);
      styles.set(JSON.stringify([foreground, attributes]), { foreground, attributes });
    }
    observations.push(range);
  }
  return styles.size > 1 ? { frame: page.frame, styles: [...styles.values()], observations,
    method: 'mapped fg/font diversity after whole-buffer nonstreaming CodeRenderable publication',
    renderer: 'OpenTUI 0.4.5', source: 'packages/core/src/renderables/Code.ts#startHighlight' } : null;
}
