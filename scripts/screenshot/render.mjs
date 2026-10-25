const ansi = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];
const xml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const hex = value => value.toString(16).padStart(2, '0');

export function terminalColor(value, mode, fallback) {
  if (mode === 0) return fallback;
  if (![0x1000000, 0x2000000, 0x3000000].includes(mode)) throw new Error('Unknown terminal color mode');
  if (!Number.isInteger(value) || value < 0 || value > (mode === 0x3000000 ? 0xffffff : 255)) throw new Error('Invalid terminal color');
  if (mode === 0x3000000) return '#' + value.toString(16).padStart(6, '0');
  if (value < 16) return ansi[value];
  if (value >= 232) return '#' + hex(8 + (value - 232) * 10).repeat(3);
  const n = value - 16, levels = [0, 95, 135, 175, 215, 255];
  return '#' + [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]].map(hex).join('');
}

function faint(fg, bg) {
  return '#' + [1, 3, 5].map(i => hex(Math.floor((parseInt(fg.slice(i, i + 2), 16) + parseInt(bg.slice(i, i + 2), 16)) / 2))).join('');
}

export function renderCapture(capture, style) {
  const { cells } = capture, columns = cells?.[0]?.length;
  if (!columns || !cells.every(row => Array.isArray(row) && row.length === columns)) throw new Error('Capture must contain a nonempty rectangular cell grid');
  for (const key of ['fontSize', 'cellWidth', 'cellHeight', 'padding']) {
    if (!Number.isFinite(style[key]) || style[key] < (key === 'padding' ? 0 : 1)) throw new Error(`Invalid screenshot ${key}`);
  }
  for (const key of ['foreground', 'background']) if (!/^#[0-9a-f]{6}$/i.test(style[key])) throw new Error(`Invalid screenshot ${key}`);
  const scale = style.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid screenshot scale');
  const viewWidth = style.padding * 2 + columns * style.cellWidth, viewHeight = style.padding * 2 + cells.length * style.cellHeight;
  const width = Math.round(viewWidth * scale), height = Math.round(viewHeight * scale);
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid screenshot pixel dimensions');
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth} ${viewHeight}">`,
    `<rect width="${viewWidth}" height="${viewHeight}" fill="${style.background}"/>`];
  for (const [y, row] of cells.entries()) for (const [x, cell] of row.entries()) {
    if (!cell || cell.width === 0) continue;
    if (![1, 2].includes(cell.width) || typeof cell.text !== 'string') throw new Error('Invalid terminal cell');
    let fg = terminalColor(cell.fg, cell.fgMode, style.foreground), bg = terminalColor(cell.bg, cell.bgMode, style.background);
    if (cell.inverse) [fg, bg] = [bg, fg];
    if (cell.dim) fg = faint(fg, bg);
    const left = style.padding + x * style.cellWidth, top = style.padding + y * style.cellHeight, w = cell.width * style.cellWidth;
    svg.push(`<rect x="${left}" y="${top}" width="${w}" height="${style.cellHeight}" fill="${bg}"/>`);
    // Terminal box glyphs fill cell boundaries, independent of the text font's baseline.
    if (cell.text === '▀') svg.push(`<rect x="${left}" y="${top}" width="${w}" height="${style.cellHeight / 2}" fill="${fg}"/>`);
    else if (['┃', '│', '╹'].includes(cell.text)) svg.push(`<rect x="${left + style.cellWidth * 0.4}" y="${top}" width="${cell.text === '│' ? 1 : 2}" height="${cell.text === '╹' ? style.cellHeight / 2 : style.cellHeight}" fill="${fg}"/>`);
    else if (cell.text.trim()) {
      const decoration = [cell.underline && 'underline', cell.strike && 'line-through'].filter(Boolean).join(' ');
      svg.push(`<text x="${left}" y="${top + style.fontSize}" fill="${fg}" font-family="${xml(style.font)}" font-size="${style.fontSize}" font-weight="${cell.bold ? 'bold' : 'normal'}" font-style="${cell.italic ? 'italic' : 'normal'}" text-decoration="${decoration}" textLength="${w}" lengthAdjust="spacingAndGlyphs">${xml(cell.text)}</text>`);
    }
  }
  return { svg: svg.join('') + '</svg>\n', width, height };
}
