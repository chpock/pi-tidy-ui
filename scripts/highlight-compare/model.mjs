import { createHash } from 'node:crypto';
import { visibleWidth } from '@earendil-works/pi-tui';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const attributes = ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse'];
const fail = message => { throw new Error(message); };

export function projectLine(source, tabSize = 4, tabMode = 'stops') {
  if (!['fixed', 'stops'].includes(tabMode)) fail('Invalid native tab expansion mode');
  if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 16) fail('Invalid declared tab size');
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u.test(source)) fail('Source contains unsupported terminal control characters');
  let column = 0;
  const glyphs = Array.from(segmenter.segment(source), ({ segment, index }) => {
    const display = segment === '\t' ? ' '.repeat(tabMode === 'fixed' ? tabSize : tabSize - column % tabSize) : segment;
    const columns = segment === '\t' ? display.length : visibleWidth(display);
    const glyph = { source: segment, display, start: index, end: index + segment.length, column, columns };
    column += columns;
    return glyph;
  });
  return { text: glyphs.map(g => g.display).join(''), columns: column, glyphs };
}

export function logicalLines(source) {
  const lines = [];
  let byte = 0;
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    if (match[0] === '' && match.index === source.length && lines.length) break;
    lines.push({ text: match[1], byte, ending: match[2] });
    byte += Buffer.byteLength(match[0]);
  }
  return lines;
}

function color(mode, value) {
  if (mode === 0) return { mode: 'default' };
  if (mode === 0x3000000 && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return { mode: 'rgb', value };
  if ((mode === 0x1000000 || mode === 0x2000000) && Number.isInteger(value) && value >= 0 && value <= 255) return { mode: 'indexed', value };
  return fail('Unsupported terminal color representation');
}

export function cellStyle(cell) {
  return { foreground: color(cell.fgMode, cell.fg), background: color(cell.bgMode, cell.bg),
    attributes: attributes.filter(name => Boolean(cell[name])) };
}

function readGlyph(row, column, glyph) {
  const projection = [];
  let text = '', x = column;
  while (text.length < glyph.display.length) {
    const cell = row[x];
    if (!cell || !Number.isInteger(cell.width) || cell.width < 1 || cell.width > 2) fail('Source text mismatch or wide-cell boundary');
    const part = cell.text || ' ';
    text += part;
    if (!glyph.display.startsWith(text)) fail('Source text mismatch');
    if (cell.width === 2 && row[x + 1]?.width !== 0) fail('Missing wide-glyph continuation cell');
    projection.push({ text: part, columns: cell.width, style: cellStyle(cell) });
    x += cell.width;
  }
  if (x - column !== glyph.columns) fail('Source text width mismatch');
  return { projection, next: x };
}

// Ranges are UTF-16 offsets into a logical line; persisted positions are UTF-8 bytes in the original file.
export function normalizeSource(source, pages, maps, { tabSize = 4, tabMode = 'stops' } = {}) {
  if (pages.length !== maps.length) fail('Each physical page requires a source map');
  const lines = logicalLines(source), projections = lines.map(line => projectLine(line.text, tabSize, tabMode)), positions = new Map();
  for (const [pageIndex, page] of pages.entries()) for (const range of maps[pageIndex]) {
    const { row, line, start, end, column } = range;
    if (![row, line, start, end, column].every(Number.isSafeInteger) || row < 0 || column < 0 || line < 1 || line > lines.length || start < 0 || end < start || end > lines[line - 1].text.length || !page.cells[row]) fail('Invalid source range');
    const logical = lines[line - 1], whole = projections[line - 1];
    const boundaries = new Set([0, logical.text.length, ...whole.glyphs.map(g => g.start)]);
    if (!boundaries.has(start) || !boundaries.has(end)) fail('Source range splits a grapheme');
    let x = column;
    const glyphs = whole.glyphs.filter(g => g.start >= start && g.end <= end);
    if (!logical.text.length) glyphs.push({ source: '', display: '', start: 0, end: 0, columns: 0 });
    for (const glyph of glyphs) {
      const observed = glyph.source ? readGlyph(page.cells[row], x, glyph) : { projection: [], next: x };
      const startByte = logical.byte + Buffer.byteLength(logical.text.slice(0, glyph.start));
      const span = { line, startByte, endByte: startByte + Buffer.byteLength(glyph.source), text: glyph.source,
        columns: glyph.columns, projection: observed.projection };
      const key = `${line}:${startByte}:${span.endByte}`, prior = positions.get(key);
      if (prior && JSON.stringify({ ...prior, observations: undefined }) !== JSON.stringify(span)) fail('Overlapping viewport styles disagree');
      if (prior) prior.observations.push({ page: pageIndex, row, column: x });
      else positions.set(key, { ...span, observations: [{ page: pageIndex, row, column: x }] });
      x = observed.next;
    }
  }
  const spans = [...positions.values()].sort((a, b) => a.line - b.line || a.startByte - b.startByte);
  const expected = projections.reduce((count, line) => count + Math.max(1, line.glyphs.length), 0);
  if (spans.length !== expected) fail(`Incomplete source coverage: ${spans.length}/${expected} graphemes`);
  return { spans, coveredLines: lines.length, tabSize, tabMode };
}

function checkedPositions(capture) {
  if (capture?.schema !== 1 || capture.status !== 'ready' || capture.readiness?.status !== 'ready') fail('Comparison requires ready captures');
  if (typeof capture.source !== 'string' || digest(capture.source) !== capture.fixture?.sha256) fail('Capture source digest mismatch');
  const positions = new Map();
  const expected = logicalLines(capture.source).flatMap((line, index) => {
    const glyphs = projectLine(line.text, capture.tabSize ?? 4, capture.tabMode ?? 'stops').glyphs;
    return (glyphs.length ? glyphs : [{ source: '', display: '', start: 0, columns: 0 }]).map(g => {
      const start = line.byte + Buffer.byteLength(line.text.slice(0, g.start));
      return [`${index + 1}:${start}:${start + Buffer.byteLength(g.source)}`, g];
    });
  });
  for (const span of capture.spans ?? []) {
    const key = `${span.line}:${span.startByte}:${span.endByte}`;
    if (positions.has(key) || !Array.isArray(span.projection)) fail('Duplicate or invalid source position');
    for (const cell of span.projection) {
      if (typeof cell.text !== 'string' || ![1, 2].includes(cell.columns)) fail('Invalid projected terminal cell');
      styleSignature(cell.style);
    }
    positions.set(key, span);
  }
  if (positions.size !== expected.length || expected.some(([key, glyph]) => {
    const span = positions.get(key);
    return span?.text !== glyph.source || span.columns !== glyph.columns ||
      span.projection.map(cell => cell.text).join('') !== glyph.display ||
      span.projection.reduce((sum, cell) => sum + cell.columns, 0) !== glyph.columns;
  })) fail('Capture source position/projection coverage mismatch');
  return positions;
}

const colorIdentity = color => color.mode === 'default' ? [color.mode] : [color.mode, color.value];
export function styleSignature(style) {
  for (const color of [style?.foreground, style?.background]) {
    if (!color || !['rgb', 'indexed', 'default'].includes(color.mode) || color.mode !== 'default' && (!Number.isInteger(color.value) || color.value < 0 || color.value > (color.mode === 'rgb' ? 0xffffff : 255))) fail('Invalid captured color');
  }
  if (!Array.isArray(style.attributes) || style.attributes.some(name => !attributes.includes(name))) fail('Invalid captured font attributes');
  return JSON.stringify([colorIdentity(style.foreground), colorIdentity(style.background), attributes.filter(name => style.attributes.includes(name))]);
}
function projectedStyles(span, channel) {
  const styles = span.projection.map(({ style }) => channel === 'attributes' ? JSON.stringify(attributes.filter(name => style.attributes.includes(name))) :
    channel ? JSON.stringify(colorIdentity(style[channel])) : styleSignature(style));
  return JSON.stringify(span.text === '\t' && styles.every(style => style === styles[0]) ? styles.slice(0, 1) : styles);
}
const channels = ['foreground', 'background', 'attributes'];
function featureObservations(fixture, positions, changed, lineCount) {
  if (fixture.cases === undefined) return [];
  if (!Array.isArray(fixture.cases)) fail('Invalid feature cases');
  return fixture.cases.map(entry => {
    if (typeof entry?.id !== 'string' || entry.title !== undefined && typeof entry.title !== 'string' || !Array.isArray(entry.features) ||
      entry.features.some(feature => typeof feature !== 'string') || !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > lineCount) fail('Invalid feature case range');
    const inside = span => span.line >= entry.startLine && span.line <= entry.endLine;
    return { ...entry, title: entry.title ?? entry.id, positionsCompared: [...positions.values()].filter(inside).length,
      differences: Object.fromEntries(channels.map(channel => [channel, changed.filter(item => inside(item) && item.channels.includes(channel)).length])) };
  });
}

export function compareCaptures(left, right) {
  const a = checkedPositions(left), b = checkedPositions(right);
  if (typeof left.theme?.family !== 'string' || !['dark', 'light'].includes(left.theme?.variant) ||
    left.theme.family !== right.theme?.family || left.theme.variant !== right.theme?.variant) fail('Theme/variant mismatch');
  if (left.fixture.id !== right.fixture.id || left.fixture.kind !== right.fixture.kind || left.fixture.sha256 !== right.fixture.sha256 || left.source !== right.source) fail('Fixture source mismatch');
  const changed = [], geometryDifferences = [];
  for (const [key, span] of a) {
    const peer = b.get(key);
    if (!peer) fail('Missing source position');
    if (span.columns !== peer.columns) geometryDifferences.push({ line: span.line, startByte: span.startByte, endByte: span.endByte, leftColumns: span.columns, rightColumns: peer.columns });
    if (projectedStyles(span) !== projectedStyles(peer)) changed.push({ line: span.line, startByte: span.startByte, endByte: span.endByte, text: span.text,
      channels: channels.filter(channel => projectedStyles(span, channel) !== projectedStyles(peer, channel)), left: span, right: peer });
  }
  return { schema: 1, fixture: left.fixture, source: left.source, theme: left.theme, positionsCompared: a.size, geometryDifferences,
    differences: Object.fromEntries(channels.map(channel => [channel, changed.filter(item => item.channels.includes(channel)).length])),
    features: featureObservations(left.fixture, a, changed, logicalLines(left.source).length),
    left: { application: left.application, identity: left.identity, spans: left.spans },
    right: { application: right.application, identity: right.identity, spans: right.spans }, changed };
}

const formatColor = color => color.mode === 'rgb' ? '#' + color.value.toString(16).padStart(6, '0') : color.mode === 'indexed' ? `index:${color.value}` : 'terminal-default';
const format = span => span.projection.map(cell => `${formatColor(cell.style.foreground)}/${formatColor(cell.style.background)} ${cell.style.attributes.join('+') || 'normal'}`).join('; ');
const safeText = text => JSON.stringify(text).replaceAll('|', '\\|');

export function renderReport(report) {
  const lines = ['# TUI highlighting comparison', '', `${report.fixture.id}: ${report.theme.family} / ${report.theme.variant}.`, '',
    `${report.positionsCompared} source positions compared; ${report.changed.length} different style positions.`, '',
    `${report.geometryDifferences?.length ?? 0} projection-width differences retained separately; uniform tab expansion alone is not a syntax-style difference.`, '',
    'These emitted cell styles do not establish parser categories or prove a defect. Terminal-default and indexed colors are not guessed RGB values.', ''];
  if (report.differences) lines.push(`Changed positions by channel: foreground ${report.differences.foreground}, background ${report.differences.background}, font ${report.differences.attributes}. Counts overlap; they are not quality scores.`, '');
  if (report.features?.length) {
    lines.push('## Feature observations', '', '| Case / lines | Constructs | Positions | Foreground | Background | Font |', '|---|---|---:|---:|---:|---:|');
    for (const entry of report.features) lines.push(`| ${safeText(entry.title)} (${entry.startLine}–${entry.endLine}) | ${safeText(entry.features.join(', '))} | ${entry.positionsCompared} | ${entry.differences.foreground} | ${entry.differences.background} | ${entry.differences.attributes} |`);
    lines.push('');
  }
  lines.push('## Exact observed differences', '', '| Line / UTF-8 bytes | Source | Channels | Left foreground/background, font | Right foreground/background, font |', '|---|---|---|---|---|');
  for (const item of report.changed.slice(0, 200)) lines.push(`| ${item.line}: ${item.startByte}–${item.endByte} | ${safeText(item.text)} | ${item.channels?.join(', ') ?? 'style'} | ${format(item.left)} | ${format(item.right)} |`);
  if (report.changed.length > 200) lines.push('', 'The table is limited to 200 positions; the JSON report retains every difference.');
  return lines.join('\n') + '\n';
}
