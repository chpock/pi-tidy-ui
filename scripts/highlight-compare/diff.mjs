import { cellStyle, digest, logicalLines, normalizeSource, projectLine, styleSignature } from './model.mjs';
import { diffRows } from './fixtures.mjs';

const fail = message => { throw new Error(message); };
const safeInteger = value => Number.isSafeInteger(value);
const roleKinds = new Set(['body-background', 'gutter-background', 'padding-background', 'line-number', 'sign']);
const backgroundKinds = ['body-background', 'gutter-background', 'padding-background'];
const sideNames = view => view === 'unified' ? ['unified'] : view === 'split' ? ['old', 'new'] : fail('Invalid diff view identity');

function sideRows(rows, view) {
  if (view === 'unified') return { unified: rows.map((row, index) => ({ logicalRow: index + 1, row })) };
  return {
    old: rows.flatMap((row, index) => row.role === 'added' ? [] : [{ logicalRow: index + 1, row }]),
    new: rows.flatMap((row, index) => row.role === 'removed' ? [] : [{ logicalRow: index + 1, row }]),
  };
}

function rowRecord(row) {
  return { role: row.role, text: row.text,
    ...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }),
    ...(row.newLine === undefined ? {} : { newLine: row.newLine }) };
}

function bodyText(entries) {
  if (!entries.length) return '';
  let text = entries.map(({ row }) => row.text).join('\n');
  if (entries.at(-1).row.text === '') text += '\n';
  const lines = logicalLines(text);
  if (lines.length !== entries.length || lines.some((line, index) => line.text !== entries[index].row.text)) {
    fail('Logical diff rows cannot be represented as source lines');
  }
  return text;
}

function fixtureContext(fixture) {
  if (!fixture || fixture.kind !== 'diff' || typeof fixture.id !== 'string' || !fixture.id ||
      typeof fixture.before !== 'string' || typeof fixture.after !== 'string' || typeof fixture.patch !== 'string' ||
      !Array.isArray(fixture.logicalRows) || !fixture.logicalRows.length || !Array.isArray(fixture.roleSamples) ||
      !fixture.roleSamples.length) fail('Invalid prepared diff fixture');
  const expectedDigest = digest(JSON.stringify([digest(Buffer.from(fixture.before)), digest(Buffer.from(fixture.after))]));
  if (fixture.sha256 !== expectedDigest) fail('Diff fixture digest mismatch');
  let canonicalRows;
  try { canonicalRows = diffRows(fixture.patch, fixture.before, fixture.after).map(rowRecord); }
  catch { fail('Diff patch does not reconstruct canonical source rows'); }
  const oldLines = fixture.before === '' ? [] : logicalLines(fixture.before);
  const newLines = fixture.after === '' ? [] : logicalLines(fixture.after);
  let previousOld = 0, previousNew = 0;
  const logicalRows = fixture.logicalRows.map(row => {
    if (!row || !['context', 'added', 'removed'].includes(row.role) || typeof row.text !== 'string' || /[\r\n]/u.test(row.text)) {
      fail('Invalid logical diff row');
    }
    const hasOld = row.oldLine !== undefined, hasNew = row.newLine !== undefined;
    if ((row.role !== 'added') !== hasOld || (row.role !== 'removed') !== hasNew) fail('Diff role/coordinate mismatch');
    if (hasOld) {
      if (!safeInteger(row.oldLine) || row.oldLine <= previousOld || row.oldLine > oldLines.length || oldLines[row.oldLine - 1]?.text !== row.text) {
        fail('Old diff line does not match its source coordinate');
      }
      previousOld = row.oldLine;
    }
    if (hasNew) {
      if (!safeInteger(row.newLine) || row.newLine <= previousNew || row.newLine > newLines.length || newLines[row.newLine - 1]?.text !== row.text) {
        fail('New diff line does not match its source coordinate');
      }
      previousNew = row.newLine;
    }
    return rowRecord(row);
  });
  if (JSON.stringify(logicalRows) !== JSON.stringify(canonicalRows)) fail('Diff logical rows disagree with canonical patch hunk');
  for (const sample of fixture.roleSamples) if (!sample || !logicalRows.some(row => row.role === sample.role &&
    row.text === sample.text && row.oldLine === sample.oldLine && row.newLine === sample.newLine)) fail('Diff role witness is missing');
  return { fixture: { id: fixture.id, kind: 'diff', sha256: fixture.sha256 }, before: fixture.before,
    after: fixture.after, patch: fixture.patch, logicalRows, roleSamples: fixture.roleSamples.map(sample => ({ ...sample })) };
}

function screenGeometry(pages) {
  if (!Array.isArray(pages) || !pages.length) fail('Diff capture requires terminal pages');
  return pages.map((page, index) => {
    if (!page || !Array.isArray(page.cells) || !page.cells.length || page.cells.some(row => !Array.isArray(row))) fail('Invalid terminal page');
    const rowWidths = page.cells.map(row => row.length);
    return { page: index, height: rowWidths.length, width: Math.max(...rowWidths), rowWidths };
  });
}

function validateNativeGeometry(geometry, screens, view) {
  const sides = sideNames(view);
  if (!Array.isArray(geometry) || geometry.length !== screens.length) fail('Each terminal page requires native diff geometry');
  return geometry.map((page, index) => {
    if (!page || page.page !== index || ![page.heading, page.bar, page.cardRight].every(safeInteger) ||
        page.heading < 0 || page.heading >= screens[index].height || page.bar < 0 || page.cardRight <= page.bar ||
        page.cardRight > screens[index].rowWidths[page.heading] || !Array.isArray(page.panes)) fail('Invalid native diff geometry');
    const seen = new Set();
    const panes = page.panes.map(pane => {
      if (!pane || !sides.includes(pane.side) || seen.has(pane.side) ||
          ![pane.left, pane.right, pane.digits].every(safeInteger) || pane.left < 0 || pane.right <= pane.left ||
          pane.right > screens[index].width || pane.digits < 1) fail('Invalid native diff pane geometry');
      seen.add(pane.side);
      return { side: pane.side, left: pane.left, right: pane.right, digits: pane.digits };
    });
    if (seen.size !== sides.length) fail('Native diff geometry omits a visible side');
    if (view === 'split' && panes[0].left < panes[1].right && panes[1].left < panes[0].right) {
      fail('Split native panes overlap');
    }
    return { ...page, panes };
  });
}

function normalizeSourceMaps(rawMaps, pages, populations, view) {
  if (!Array.isArray(rawMaps) || rawMaps.length !== pages.length) fail('Each page requires a source map');
  const sides = sideNames(view), bySide = Object.fromEntries(sides.map(side => [side, pages.map(() => [])]));
  const assignments = Object.fromEntries(sides.map(side => [side, pages.map(() => new Map())]));
  const seen = Object.fromEntries(sides.map(side => [side, new Set()]));
  const publicMaps = rawMaps.map((ranges, pageIndex) => {
    if (!Array.isArray(ranges)) fail('Invalid diff source map');
    const result = ranges.map(range => {
      if (!range || !sides.includes(range.side) || ![range.row, range.line, range.start, range.end, range.column].every(safeInteger) ||
          range.row < 0 || range.row >= pages[pageIndex].cells.length || range.line < 1 ||
          range.start < 0 || range.end < range.start || range.column < 0 || range.column >= pages[pageIndex].cells[range.row].length) {
        fail('Invalid diff source range');
      }
      const lineIndex = populations[range.side].findIndex(entry => entry.logicalRow === range.line);
      if (lineIndex < 0) fail('Diff source range references a row absent from its side');
      const entry = populations[range.side][lineIndex], logicalRow = entry.logicalRow;
      if (range.end > entry.row.text.length) fail('Diff source range exceeds its logical row');
      const priorRow = assignments[range.side][pageIndex].get(range.row);
      if (priorRow !== undefined && priorRow !== logicalRow) fail('Ambiguous source rows share a terminal row');
      assignments[range.side][pageIndex].set(range.row, logicalRow);
      seen[range.side].add(logicalRow);
      bySide[range.side][pageIndex].push({ row: range.row, line: lineIndex + 1, start: range.start, end: range.end, column: range.column });
      return { row: range.row, line: logicalRow, side: range.side, column: range.column, start: range.start, end: range.end };
    }).sort((a, b) => a.side.localeCompare(b.side) || a.line - b.line || a.start - b.start || a.end - b.end || a.row - b.row || a.column - b.column);
    return result;
  });

  for (const side of sides) {
    const visible = populations[side];
    if (visible.some(entry => !seen[side].has(entry.logicalRow))) fail(`Missing ${side} source row mapping`);
    for (const ranges of bySide[side]) {
      ranges.sort((a, b) => a.line - b.line || a.start - b.start || a.end - b.end || a.row - b.row || a.column - b.column);
      const byLine = new Map();
      for (const range of ranges) {
        const row = visible[range.line - 1].row, list = byLine.get(range.line) ?? [];
        if (range.start === range.end) {
          if (list.length || row.text !== '') fail('Ambiguous duplicate empty source mapping');
        } else if (row.text === '' || list.some(other => other.start === other.end || range.start < other.end && other.start < range.end)) {
          fail('Ambiguous duplicate source mapping');
        }
        list.push(range); byLine.set(range.line, list);
      }
    }
  }
  return { publicMaps, bySide, assignments };
}

function sampledCell(cell, column, row) {
  if (!cell || ![0, 1, 2].includes(cell.width) || (cell.text !== undefined && typeof cell.text !== 'string')) fail('Invalid sampled terminal cell');
  if (cell.width === 0 && (column === 0 || row[column - 1]?.width !== 2)) fail('Invalid wide-cell continuation');
  if (cell.width === 2 && (column + 1 >= row.length || row[column + 1]?.width !== 0)) fail('Missing wide-cell continuation');
  const text = cell.width === 0 ? '' : cell.text || ' ';
  const style = cellStyle(cell), signature = styleSignature(style);
  return { column, text, width: cell.width, style, signature };
}

function sampleRange(page, rowIndex, start, end) {
  const row = page.cells[rowIndex], cells = [];
  for (let column = start; column < end; column++) cells.push(sampledCell(row[column], column, row));
  return { start, end, text: cells.map(cell => cell.text).join(''), cells };
}

const signFor = row => row.role === 'added' ? '+' : row.role === 'removed' ? '-' : undefined;
const expectedNumber = (view, side, row) => view === 'unified' ? row.newLine ?? row.oldLine : side === 'old' ? row.oldLine : row.newLine;

function normalizeSurfaces(ranges, pages, context, populations, assignments, sourceMaps, geometry, tabSize, tabMode) {
  if (!Array.isArray(ranges) || !ranges.length) fail('Diff surfaces are missing');
  const sides = sideNames(context.viewIdentity), samples = ranges.map(range => {
    if (!range || !['card-background', ...roleKinds].includes(range.kind) ||
        ![range.page, range.row, range.start, range.end].every(safeInteger) || range.page < 0 || range.page >= pages.length ||
        range.row < 0 || range.row >= pages[range.page].cells.length || range.start < 0 || range.end <= range.start ||
        range.end > pages[range.page].cells[range.row].length) fail('Invalid semantic surface range');
    let row;
    if (range.kind === 'card-background') {
      if (range.side !== undefined || range.logicalRow !== undefined) fail('Card background is global');
    } else {
      if (!sides.includes(range.side) || !safeInteger(range.logicalRow) || range.logicalRow < 1 ||
          range.logicalRow > context.logicalRows.length) fail('Diff surface requires a side and logical row');
      row = context.logicalRows[range.logicalRow - 1];
      if (!populations[range.side].some(entry => entry.logicalRow === range.logicalRow) ||
          assignments[range.side][range.page].get(range.row) !== range.logicalRow) fail('Surface disagrees with its side source map');
      if (range.kind === 'sign' && !signFor(row)) fail('Context diff row cannot carry a sign');
    }
    const observed = sampleRange(pages[range.page], range.row, range.start, range.end);
    const sample = { kind: range.kind, page: range.page, row: range.row,
      ...(range.side === undefined ? {} : { side: range.side }),
      ...(range.logicalRow === undefined ? {} : { logicalRow: range.logicalRow, role: row.role,
        ...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }), ...(row.newLine === undefined ? {} : { newLine: row.newLine }) }),
      ...observed };
    if (range.kind === 'line-number' || range.kind === 'sign') {
      if (sample.cells.some(cell => cell.width !== 1)) fail('Diff labels must use single-column cells');
      const number = expectedNumber(context.viewIdentity, range.side, row);
      const expected = range.kind === 'line-number' ? String(number) : signFor(row);
      if ((range.kind === 'line-number' && !safeInteger(number)) || sample.text !== expected) {
        fail(range.kind === 'line-number' ? 'Diff line number mismatch' : 'Diff sign mismatch');
      }
    }
    return sample;
  }).sort((a, b) => a.kind.localeCompare(b.kind) || (a.side ?? '').localeCompare(b.side ?? '') ||
    (a.logicalRow ?? 0) - (b.logicalRow ?? 0) || a.page - b.page || a.row - b.row || a.start - b.start);

  assertNoDuplicateRanges(samples);
  assertCardBackgroundPageCoverage(samples, pages.length);
  const cards = samples.filter(sample => sample.kind === 'card-background');
  for (const card of cards) for (const role of samples.filter(sample => sample.kind !== 'card-background')) {
    if (card.page === role.page && card.row === role.row && card.start < role.end && role.start < card.end) fail('Card background anchor overlaps a diff role');
  }
  for (const [side, entries] of Object.entries(populations)) for (const { logicalRow, row } of entries) {
    const required = [...backgroundKinds, 'line-number', ...(signFor(row) ? ['sign'] : [])];
    for (const kind of required) {
      const found = samples.filter(sample => sample.side === side && sample.logicalRow === logicalRow && sample.kind === kind);
      if (!found.length) fail(`Missing ${kind} evidence for ${side} logical row ${logicalRow}`);
      if (kind === 'line-number' || kind === 'sign') {
        const seenPages = new Set();
        for (const sample of found) { if (seenPages.has(sample.page)) fail(`Ambiguous duplicate ${kind} mapping`); seenPages.add(sample.page); }
      }
    }
  }
  assertMappedRowSurfaces(samples, sourceMaps, populations);
  validateStructuralSurfaceGeometry(samples, sourceMaps, geometry, context, tabSize, tabMode);
  assertOverlappingSurfaces(samples);
  return samples;
}

function normalizeAlignmentPadding(ranges, pages, populations, assignments, context, geometry) {
  if (!Array.isArray(ranges)) fail('Split alignment-padding map must be an array');
  const result = ranges.map(range => {
    if (!range || !['old', 'new'].includes(range.side) ||
        ![range.page, range.row, range.alignedRow, range.gutterStart, range.bodyStart, range.end].every(safeInteger) ||
        range.page < 0 || range.page >= pages.length || range.row < 0 || range.row >= pages[range.page].cells.length ||
        range.gutterStart < 0 || range.bodyStart <= range.gutterStart || range.end <= range.bodyStart ||
        range.end > pages[range.page].cells[range.row].length || range.alignedRow < 1 || range.alignedRow > context.logicalRows.length) {
      fail('Invalid split alignment-padding range');
    }
    const pane = geometry[range.page].panes.find(item => item.side === range.side);
    if (!pane || range.gutterStart !== pane.left || range.end !== pane.right) {
      fail('Alignment padding does not cover its owning pane');
    }
    const opposite = range.side === 'old' ? 'new' : 'old';
    if (assignments[range.side][range.page].has(range.row) ||
        assignments[opposite][range.page].get(range.row) !== range.alignedRow ||
        !populations[opposite].some(entry => entry.logicalRow === range.alignedRow)) fail('Alignment padding does not match its opposite row');
    const gutter = sampleRange(pages[range.page], range.row, range.gutterStart, range.bodyStart);
    const content = sampleRange(pages[range.page], range.row, range.bodyStart, range.end);
    if (gutter.text.trim() || content.text.trim()) fail('Alignment padding must be visibly blank');
    const row = context.logicalRows[range.alignedRow - 1];
    return { page: range.page, row: range.row, side: range.side, alignedRow: range.alignedRow, role: row.role,
      ...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }), ...(row.newLine === undefined ? {} : { newLine: row.newLine }),
      gutter, content };
  }).sort((a, b) => a.side.localeCompare(b.side) || a.alignedRow - b.alignedRow || a.page - b.page || a.row - b.row);
  if (context.viewIdentity === 'unified' && result.length) fail('Unified view cannot contain split alignment padding');
  if (context.viewIdentity === 'split') assertExpectedAlignmentPadding(context.logicalRows, result, assignments);
  assertAlignmentOverlap(result);
  return result;
}

export function changedGroups(rows) {
  const groups = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].role === 'context') { index++; continue; }
    const oldRows = [], newRows = [];
    while (index < rows.length && rows[index].role !== 'context') {
      if (rows[index].role === 'removed') oldRows.push(index + 1);
      if (rows[index].role === 'added') newRows.push(index + 1);
      index++;
    }
    groups.push({ oldRows, newRows });
  }
  return groups;
}

function assertExpectedAlignmentPadding(rows, padding, assignments) {
  const changedRows = new Set(changedGroups(rows).flatMap(group => [...group.oldRows, ...group.newRows]));
  const required = new Set();
  for (const [page, oldRows] of assignments.old.entries()) {
    const newRows = assignments.new[page], physicalRows = new Set([...oldRows.keys(), ...newRows.keys()]);
    for (const row of physicalRows) {
      const oldLogicalRow = oldRows.get(row), newLogicalRow = newRows.get(row);
      if (oldLogicalRow !== undefined && newLogicalRow === undefined && changedRows.has(oldLogicalRow)) {
        required.add(`${page}:${row}:new:${oldLogicalRow}`);
      } else if (newLogicalRow !== undefined && oldLogicalRow === undefined && changedRows.has(newLogicalRow)) {
        required.add(`${page}:${row}:old:${newLogicalRow}`);
      }
    }
  }
  const actual = new Set();
  for (const item of padding) {
    const key = `${item.page}:${item.row}:${item.side}:${item.alignedRow}`;
    if (!required.has(key) || actual.has(key)) fail('Unexpected or ambiguous split alignment padding');
    actual.add(key);
  }
  for (const key of required) if (!actual.has(key)) fail('Missing alignment padding for unmatched split rows on a visible page');
}

function assertNoDuplicateRanges(samples) {
  const ranges = new Map();
  for (const sample of samples) {
    const key = `${sample.page}:${sample.row}:${sample.kind}:${sample.side ?? '*'}:${sample.logicalRow ?? '*'}`;
    const prior = ranges.get(key) ?? [];
    if (prior.some(range => sample.start < range.end && range.start < sample.end)) fail('Ambiguous overlapping semantic ranges');
    prior.push({ start: sample.start, end: sample.end }); ranges.set(key, prior);
  }
}

function assertCardBackgroundPageCoverage(samples, pageCount) {
  for (let page = 0; page < pageCount; page++) {
    if (!samples.some(sample => sample.kind === 'card-background' && sample.page === page)) {
      fail(`Missing card-background evidence for page ${page}`);
    }
  }
}

function assertPageOverlap(items, keyOf, cellsOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item), pages = groups.get(key) ?? new Map(), page = pages.get(item.page) ?? [];
    page.push(item); pages.set(item.page, page); groups.set(key, pages);
  }
  for (const pages of groups.values()) {
    if (pages.size < 2) continue;
    const records = [...pages.values()].map(page => page.sort((a, b) => a.row - b.row || a.start - b.start)
      .flatMap(item => cellsOf(item).map(cell => [cell.text, cell.width, cell.signature])));
    if (records.some(record => JSON.stringify(record) !== JSON.stringify(records[0]))) fail('Overlapping diff observations disagree');
  }
}

function assertOverlappingSurfaces(samples) {
  assertPageOverlap(samples.filter(sample => sample.logicalRow !== undefined),
    sample => `${sample.kind}:${sample.side}:${sample.logicalRow}`, sample => sample.cells);
  const cardSamples = samples.filter(sample => sample.kind === 'card-background');
  const pages = [...new Set(cardSamples.map(sample => sample.page))];
  const profiles = pages.map(page => colorProfile(cardSamples.filter(sample => sample.page === page), 'background'));
  if (profiles.length > 1 && profiles.some(profile => !compareProfile(profiles[0], profile).equal)) {
    fail('Overlapping card-background observations disagree');
  }
}

function assertAlignmentOverlap(padding) {
  assertPageOverlap(padding, item => `${item.side}:${item.alignedRow}`,
    item => [...item.gutter.cells, ...item.content.cells]);
}

function canonicalPageSamples(samples) {
  if (!samples.length) return [];
  const first = Math.min(...samples.map(sample => sample.page));
  return samples.filter(sample => sample.page === first).sort((a, b) => a.row - b.row || a.start - b.start);
}

function colorProfile(samples, channel) {
  const index = channel === 'foreground' ? 0 : 1;
  return canonicalPageSamples(samples).flatMap(sample => sample.cells.map(cell => {
    const color = JSON.parse(cell.signature)[index];
    return color[0] === 'default' ? { mode: 'default' } : { mode: color[0], value: color[1] };
  }));
}

function roleSummaries(populations, samples) {
  const result = [];
  for (const [side, entries] of Object.entries(populations)) for (const { logicalRow, row } of entries) {
    const owned = kind => samples.filter(sample => sample.side === side && sample.logicalRow === logicalRow && sample.kind === kind);
    const channels = { bodyBackground: colorProfile(owned('body-background'), 'background'),
      gutterBackground: colorProfile(owned('gutter-background'), 'background'),
      paddingBackground: colorProfile(owned('padding-background'), 'background'),
      lineNumberForeground: colorProfile(owned('line-number'), 'foreground'),
      ...(signFor(row) ? { signForeground: colorProfile(owned('sign'), 'foreground') } : {}) };
    const kinds = [...new Set(samples.filter(sample => sample.side === side && sample.logicalRow === logicalRow).map(sample => sample.kind))].sort();
    const sampleIndexes = Object.fromEntries(kinds.map(kind => [kind, samples.map((sample, index) =>
      sample.side === side && sample.logicalRow === logicalRow && sample.kind === kind ? index : -1).filter(index => index >= 0)]));
    result.push({ side, logicalRow, role: row.role, text: row.text,
      ...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }), ...(row.newLine === undefined ? {} : { newLine: row.newLine }),
      sampleIndexes, channels });
  }
  return result;
}

function alignmentSummaries(padding) {
  const keys = [...new Set(padding.map(item => `${item.side}:${item.alignedRow}`))].sort();
  return keys.map(key => {
    const [side, rowText] = key.split(':'), alignedRow = Number(rowText);
    const owned = padding.filter(item => item.side === side && item.alignedRow === alignedRow);
    const asRange = property => owned.map(item => ({ ...item[property], page: item.page, row: item.row }));
    const first = owned[0];
    return { side, alignedRow, role: first.role, ...(first.oldLine === undefined ? {} : { oldLine: first.oldLine }),
      ...(first.newLine === undefined ? {} : { newLine: first.newLine }),
      gutterBackground: colorProfile(asRange('gutter'), 'background'),
      contentBackground: colorProfile(asRange('content'), 'background'),
      sampleIndexes: padding.map((item, index) => item.side === side && item.alignedRow === alignedRow ? index : -1).filter(index => index >= 0) };
  });
}

function normalizeSources(pages, populations, maps, tabSize, tabMode) {
  return Object.fromEntries(Object.entries(populations).map(([side, entries]) => {
    const text = bodyText(entries), normalized = entries.length
      ? normalizeSource(text, pages, maps.bySide[side], { tabSize, tabMode })
      : { spans: [], coveredLines: 0, tabSize, tabMode };
    const spans = normalized.spans.map(span => {
      const entry = entries[span.line - 1];
      if (!entry) fail('Source span is outside its side population');
      for (const cell of span.projection) styleSignature(cell.style);
      return { ...span, side, virtualLine: span.line, logicalRow: entry.logicalRow, role: entry.row.role,
        ...(entry.row.oldLine === undefined ? {} : { oldLine: entry.row.oldLine }), ...(entry.row.newLine === undefined ? {} : { newLine: entry.row.newLine }) };
    });
    return [side, { side, text, tabSize: normalized.tabSize, tabMode: normalized.tabMode, coveredLines: normalized.coveredLines, spans }];
  }));
}

export function normalizeDiff(fixture, pages, mapping) {
  const context = fixtureContext(fixture);
  if (!mapping || typeof mapping !== 'object' || !['unified', 'split'].includes(mapping.viewIdentity)) fail('Invalid diff mapping');
  const viewIdentity = mapping.viewIdentity, populations = sideRows(context.logicalRows, viewIdentity);
  context.viewIdentity = viewIdentity;
  const screen = screenGeometry(pages), geometry = validateNativeGeometry(mapping.geometry, screen, viewIdentity);
  const maps = normalizeSourceMaps(mapping.sourceMaps, pages, populations, viewIdentity);
  const tabSize = mapping.tabSize === undefined ? 4 : mapping.tabSize;
  const tabMode = mapping.tabMode === undefined ? 'stops' : mapping.tabMode;
  const sources = normalizeSources(pages, populations, maps, tabSize, tabMode);
  const surfaces = normalizeSurfaces(mapping.surfaces, pages, context, populations, maps.assignments,
    maps.publicMaps, geometry, tabSize, tabMode);
  const alignmentPadding = normalizeAlignmentPadding(mapping.alignmentPadding, pages, populations, maps.assignments, context, geometry);
  for (const padding of alignmentPadding) for (const card of surfaces.filter(sample => sample.kind === 'card-background')) {
    for (const range of [padding.gutter, padding.content]) if (card.page === padding.page && card.row === padding.row &&
      card.start < range.end && range.start < card.end) fail('Card background anchor overlaps alignment padding');
  }
  const roles = roleSummaries(populations, surfaces), alignmentRoles = alignmentSummaries(alignmentPadding);
  const cardBackground = colorProfile(surfaces.filter(sample => sample.kind === 'card-background'), 'background');
  return { schema: 1, viewIdentity, fixture: context.fixture, before: context.before, after: context.after,
    patch: context.patch, logicalRows: context.logicalRows, roleSamples: context.roleSamples, sources,
    sourceMaps: maps.publicMaps, surfaces, alignmentPadding, roles, alignmentRoles, cardBackground,
    geometry, screenGeometry: screen };
}

function expectedSource(text, entries, tabSize, tabMode) {
  return logicalLines(text).flatMap((line, index) => {
    const projection = projectLine(line.text, tabSize, tabMode), glyphs = projection.glyphs, entry = entries[index];
    return (glyphs.length ? glyphs : [{ source: '', display: '', start: 0, columns: 0 }]).map(glyph => {
      const startByte = line.byte + Buffer.byteLength(line.text.slice(0, glyph.start));
      return { line: index + 1, startByte, endByte: startByte + Buffer.byteLength(glyph.source), glyph, entry };
    });
  });
}

function validateSource(source, side, entries, screens, tabSize, tabMode) {
  const text = bodyText(entries);
  if (!source || source.side !== side || source.text !== text || source.tabSize !== tabSize || source.tabMode !== tabMode ||
      !Array.isArray(source.spans) || source.coveredLines !== (entries.length ? logicalLines(text).length : 0)) fail('Invalid normalized diff source');
  const expected = entries.length ? expectedSource(text, entries, tabSize, tabMode) : [];
  const positions = new Map();
  for (const span of source.spans) {
    const entry = span && entries[span.virtualLine - 1];
    if (!span || !entry || span.side !== side || span.line !== span.virtualLine || span.logicalRow !== entry.logicalRow ||
        span.role !== entry.row.role || span.oldLine !== entry.row.oldLine || span.newLine !== entry.row.newLine ||
        !Array.isArray(span.projection) || !Array.isArray(span.observations)) fail('Invalid normalized diff source span');
    const key = `${span.line}:${span.startByte}:${span.endByte}`;
    if (positions.has(key)) fail('Duplicate normalized source position');
    for (const cell of span.projection) {
      if (!cell || typeof cell.text !== 'string' || ![1, 2].includes(cell.columns)) fail('Invalid projected source cell');
      styleSignature(cell.style);
    }
    if (!span.observations.length) fail('Source span has no page observation');
    for (const observation of span.observations) {
      if (!observation || ![observation.page, observation.row, observation.column].every(safeInteger) ||
          observation.page < 0 || observation.page >= screens.length || observation.row < 0 ||
          observation.row >= screens[observation.page].height || observation.column < 0 ||
          observation.column >= screens[observation.page].rowWidths[observation.row]) fail('Invalid source observation');
    }
    positions.set(key, span);
  }
  if (positions.size !== expected.length || expected.some(item => {
    const span = positions.get(`${item.line}:${item.startByte}:${item.endByte}`);
    return !span || span.text !== item.glyph.source || span.columns !== item.glyph.columns ||
      span.projection.map(cell => cell.text).join('') !== item.glyph.display ||
      span.projection.reduce((sum, cell) => sum + cell.columns, 0) !== item.glyph.columns;
  })) fail('Normalized diff source does not match logical rows');
}

function validatePublicMaps(sourceMaps, populations, sides, screens) {
  if (!Array.isArray(sourceMaps) || sourceMaps.length !== screens.length) fail('Invalid captured diff source maps');
  const assignments = Object.fromEntries(sides.map(side => [side, screens.map(() => new Map())]));
  const seen = Object.fromEntries(sides.map(side => [side, new Set()]));
  for (const [page, ranges] of sourceMaps.entries()) {
    if (!Array.isArray(ranges)) fail('Invalid captured page source map');
    const intervals = new Map();
    for (const range of ranges) {
      if (!range || !sides.includes(range.side) || ![range.row, range.line, range.column, range.start, range.end].every(safeInteger) ||
          range.row < 0 || range.row >= screens[page].height || range.column < 0 ||
          range.column >= screens[page].rowWidths[range.row] || range.line < 1 || range.start < 0 || range.end < range.start) {
        fail('Invalid captured source range');
      }
      const entry = populations[range.side].find(item => item.logicalRow === range.line);
      if (!entry || range.end > entry.row.text.length) fail('Captured source range references an unknown logical row');
      const prior = assignments[range.side][page].get(range.row);
      if (prior !== undefined && prior !== range.line) fail('Ambiguous captured source rows share a terminal row');
      assignments[range.side][page].set(range.row, range.line); seen[range.side].add(range.line);
      const key = `${range.side}:${range.line}`, list = intervals.get(key) ?? [];
      if (range.start === range.end) {
        if (list.length || entry.row.text !== '') fail('Ambiguous captured empty source map');
      } else if (entry.row.text === '' || list.some(other => other.start === other.end || range.start < other.end && other.start < range.end)) {
        fail('Ambiguous captured source ranges overlap');
      }
      list.push(range); intervals.set(key, list);
    }
  }
  for (const side of sides) if (populations[side].some(entry => !seen[side].has(entry.logicalRow))) {
    fail(`Captured source maps omit a ${side} logical row`);
  }
  return assignments;
}

function validateSerializedRange(range) {
  if (!range || ![range.start, range.end].every(safeInteger) || range.start < 0 || range.end <= range.start ||
      !Array.isArray(range.cells) || range.cells.length !== range.end - range.start ||
      range.text !== range.cells.map(cell => cell.text).join('')) fail('Invalid serialized surface range');
  for (const [index, cell] of range.cells.entries()) {
    if (!cell || cell.column !== range.start + index || ![0, 1, 2].includes(cell.width) || typeof cell.text !== 'string') {
      fail('Invalid serialized sampled cell');
    }
    if (cell.signature !== styleSignature(cell.style)) fail('Serialized style signature mismatch');
  }
}

function validateSerializedSurfaces(samples, context, populations, assignments, screens, sourceMaps) {
  const sides = sideNames(context.viewIdentity);
  if (!Array.isArray(samples) || !samples.length) fail('Diff surface observations are missing');
  for (const sample of samples) {
    if (!sample || !['card-background', ...roleKinds].includes(sample.kind) ||
        ![sample.page, sample.row].every(safeInteger) || sample.page < 0 || sample.page >= screens.length ||
        sample.row < 0 || sample.row >= screens[sample.page].height || sample.end > screens[sample.page].rowWidths[sample.row]) {
      fail('Invalid serialized surface observation');
    }
    validateSerializedRange(sample);
    if (sample.kind === 'card-background') {
      if (sample.side !== undefined || sample.logicalRow !== undefined) fail('Card background is not global');
      continue;
    }
    const row = context.logicalRows[sample.logicalRow - 1];
    if (!sides.includes(sample.side) || !safeInteger(sample.logicalRow) || !row ||
        !populations[sample.side].some(entry => entry.logicalRow === sample.logicalRow) ||
        assignments[sample.side][sample.page].get(sample.row) !== sample.logicalRow || sample.role !== row.role ||
        sample.oldLine !== row.oldLine || sample.newLine !== row.newLine) fail('Serialized surface changed its role mapping');
    if (sample.kind === 'sign' && !signFor(row)) fail('Unexpected sign surface');
    if (sample.kind === 'line-number' || sample.kind === 'sign') {
      if (sample.cells.some(cell => cell.width !== 1)) fail('Diff labels must use single-column cells');
      const number = expectedNumber(context.viewIdentity, sample.side, row);
      const text = sample.kind === 'line-number' ? String(number) : signFor(row);
      if ((sample.kind === 'line-number' && !safeInteger(number)) || sample.text !== text) fail('Diff number/sign mismatch');
    }
  }
  assertNoDuplicateRanges(samples);
  assertCardBackgroundPageCoverage(samples, screens.length);
  for (const card of samples.filter(sample => sample.kind === 'card-background')) for (const role of samples) {
    if (role.kind !== 'card-background' && card.page === role.page && card.row === role.row &&
        card.start < role.end && role.start < card.end) fail('Card background anchor overlaps a diff role');
  }
  for (const [side, entries] of Object.entries(populations)) for (const { logicalRow, row } of entries) {
    for (const kind of [...backgroundKinds, 'line-number', ...(signFor(row) ? ['sign'] : [])]) {
      const found = samples.filter(sample => sample.side === side && sample.logicalRow === logicalRow && sample.kind === kind);
      if (!found.length) fail(`Missing ${kind} evidence for ${side} logical row ${logicalRow}`);
      if (kind === 'line-number' || kind === 'sign') {
        const pages = new Set();
        for (const sample of found) { if (pages.has(sample.page)) fail(`Duplicate ${kind} observation`); pages.add(sample.page); }
      }
    }
  }
  assertMappedRowSurfaces(samples, sourceMaps, populations);
  for (const body of samples.filter(sample => sample.kind === 'body-background' && sample.text.trim() === '')) {
    if (context.logicalRows[body.logicalRow - 1].text !== '') continue;
    const padding = samples.find(sample => sample.kind === 'padding-background' && sample.side === body.side &&
      sample.logicalRow === body.logicalRow && sample.page === body.page && sample.row === body.row);
    if (body.end - body.start !== 1 || !padding || padding.start < body.end) fail('Blank changed content merged with trailing padding');
  }
  assertOverlappingSurfaces(samples);
}

function validateAlignment(alignment, context, populations, assignments, screens, geometry) {
  if (!Array.isArray(alignment)) fail('Invalid normalized alignment-padding observations');
  for (const item of alignment) {
    if (!item || !['old', 'new'].includes(item.side) || ![item.page, item.row, item.alignedRow].every(safeInteger) ||
        item.page < 0 || item.page >= screens.length || item.row < 0 || item.row >= screens[item.page].height ||
        item.alignedRow < 1 || item.alignedRow > context.logicalRows.length || assignments[item.side][item.page].has(item.row)) {
      fail('Invalid alignment-padding row');
    }
    const pane = geometry[item.page].panes.find(value => value.side === item.side);
    if (!pane || item.gutter.start !== pane.left || item.gutter.end !== item.content.start || item.content.end !== pane.right ||
        pane.right > screens[item.page].rowWidths[item.row]) fail('Alignment padding does not cover its owning pane contiguously');
    const otherSide = item.side === 'old' ? 'new' : 'old';
    if (assignments[otherSide][item.page].get(item.row) !== item.alignedRow) fail('Alignment padding is not aligned to its opposite row');
    const opposite = context.logicalRows[item.alignedRow - 1];
    if (item.role !== opposite.role || item.oldLine !== opposite.oldLine || item.newLine !== opposite.newLine) fail('Alignment row lost opposite coordinates');
    for (const range of [item.gutter, item.content]) {
      validateSerializedRange(range);
      if (range.text.trim() !== '' || range.end > screens[item.page].rowWidths[item.row]) fail('Alignment padding is not blank');
    }
  }
  if (context.viewIdentity === 'unified' && alignment.length) fail('Unified view cannot have alignment padding');
  if (context.viewIdentity === 'split') assertExpectedAlignmentPadding(context.logicalRows, alignment, assignments);
  assertAlignmentOverlap(alignment);
}

function validateCapture(capture) {
  if (!capture || capture.schema !== 1 || capture.status !== 'ready' || capture.readiness?.status !== 'ready') fail('Diff comparison requires ready captures');
  if (typeof capture.theme?.family !== 'string' || !capture.theme.family || !['dark', 'light'].includes(capture.theme.variant)) fail('Invalid diff theme');
  if (!['unified', 'split'].includes(capture.viewIdentity)) fail('Invalid diff view identity');
  const context = fixtureContext({ ...capture.fixture, before: capture.before, after: capture.after,
    patch: capture.patch, logicalRows: capture.logicalRows, roleSamples: capture.roleSamples });
  context.viewIdentity = capture.viewIdentity;
  const screens = capture.screenGeometry;
  if (!Array.isArray(screens) || !screens.length || screens.some((screen, index) => !screen || screen.page !== index ||
      !safeInteger(screen.width) || !safeInteger(screen.height) || !Array.isArray(screen.rowWidths) ||
      screen.rowWidths.length !== screen.height || screen.rowWidths.some(width => !safeInteger(width) || width < 0))) fail('Invalid captured screen geometry');
  const geometry = validateNativeGeometry(capture.geometry, screens, capture.viewIdentity);
  const populations = sideRows(context.logicalRows, capture.viewIdentity), sides = sideNames(capture.viewIdentity);
  if (!capture.sources || JSON.stringify(Object.keys(capture.sources).sort()) !== JSON.stringify([...sides].sort())) fail('Capture source sides disagree with view');
  const first = capture.sources[sides[0]];
  if (!safeInteger(first?.tabSize) || !['fixed', 'stops'].includes(first.tabMode)) fail('Invalid capture tab settings');
  const mapAssignments = validatePublicMaps(capture.sourceMaps, populations, sides, screens);
  for (const side of sides) {
    const source = capture.sources[side];
    if (source.tabSize !== first.tabSize || source.tabMode !== first.tabMode) fail('Diff side tab settings disagree');
    validateSource(source, side, populations[side], screens, first.tabSize, first.tabMode);
    for (const span of source.spans) for (const observation of span.observations) {
      if (mapAssignments[side][observation.page].get(observation.row) !== span.logicalRow) fail('Source spans disagree with source maps');
    }
  }
  validateSerializedSurfaces(capture.surfaces, context, populations, mapAssignments, screens, capture.sourceMaps);
  validateStructuralSurfaceGeometry(capture.surfaces, capture.sourceMaps, geometry, context, first.tabSize, first.tabMode);
  validateAlignment(capture.alignmentPadding, context, populations, mapAssignments, screens, geometry);
  for (const padding of capture.alignmentPadding) for (const card of capture.surfaces.filter(sample => sample.kind === 'card-background')) {
    for (const range of [padding.gutter, padding.content]) if (card.page === padding.page && card.row === padding.row &&
      card.start < range.end && range.start < card.end) fail('Card background anchor overlaps alignment padding');
  }
  return { context, populations, screens, geometry, sources: capture.sources, sourceMaps: capture.sourceMaps,
    surfaces: capture.surfaces, alignmentPadding: capture.alignmentPadding,
    roles: roleSummaries(populations, capture.surfaces), alignmentRoles: alignmentSummaries(capture.alignmentPadding),
    cardBackground: colorProfile(capture.surfaces.filter(sample => sample.kind === 'card-background'), 'background') };
}

function profileIds(values) {
  return values.map(value => value.mode === 'default' ? ['default'] : [value.mode, value.value]);
}

function compareProfile(left, right) {
  const a = profileIds(left), b = profileIds(right), exact = JSON.stringify(a) === JSON.stringify(b);
  const sameUniform = a.length > 0 && b.length > 0 && JSON.stringify(a[0]) === JSON.stringify(b[0]) &&
    a.every(item => JSON.stringify(item) === JSON.stringify(a[0])) && b.every(item => JSON.stringify(item) === JSON.stringify(b[0]));
  return { left, right, equal: exact || sameUniform, exact };
}

function sourceGeometry(sources) {
  return Object.values(sources).flatMap(source => source.spans.map(span => ({ side: span.side, logicalRow: span.logicalRow,
    oldLine: span.oldLine, newLine: span.newLine, startByte: span.startByte, endByte: span.endByte, columns: span.columns })));
}

function surfaceGeometry(surfaces, alignment) {
  const normal = surfaces.map(sample => ({ kind: sample.kind, side: sample.side, logicalRow: sample.logicalRow,
    page: sample.page, row: sample.row, start: sample.start, end: sample.end, cells: sample.cells.length }));
  const pads = alignment.map(item => ({ kind: 'alignment-padding', side: item.side, alignedRow: item.alignedRow,
    page: item.page, row: item.row, gutter: item.gutter.end - item.gutter.start, content: item.content.end - item.content.start }));
  return [...normal, ...pads];
}

export function compareDiffCaptures(left, right) {
  const a = validateCapture(left), b = validateCapture(right);
  if (left.viewIdentity !== right.viewIdentity) fail('Diff view identity mismatch');
  if (left.theme.family !== right.theme.family || left.theme.variant !== right.theme.variant) fail('Theme/variant mismatch');
  if (a.context.fixture.id !== b.context.fixture.id || a.context.fixture.sha256 !== b.context.fixture.sha256 ||
      a.context.before !== b.context.before || a.context.after !== b.context.after) fail('Diff fixture identity mismatch');
  if (JSON.stringify(a.context.logicalRows) !== JSON.stringify(b.context.logicalRows)) fail('Diff structural role maps disagree');

  const differences = [], roles = a.roles.map((role, index) => {
    const other = b.roles[index];
    if (role.side !== other.side || role.logicalRow !== other.logicalRow || role.role !== other.role ||
        role.oldLine !== other.oldLine || role.newLine !== other.newLine || role.text !== other.text) fail('Diff side populations disagree');
    const channels = Object.fromEntries(Object.keys(role.channels).map(name => {
      const compared = compareProfile(role.channels[name], other.channels[name]);
      if (!compared.equal) differences.push({ side: role.side, logicalRow: role.logicalRow, role: role.role,
        ...(role.oldLine === undefined ? {} : { oldLine: role.oldLine }),
        ...(role.newLine === undefined ? {} : { newLine: role.newLine }), channel: name, left: compared.left, right: compared.right });
      return [name, compared];
    }));
    return { side: role.side, logicalRow: role.logicalRow, role: role.role, text: role.text,
      ...(role.oldLine === undefined ? {} : { oldLine: role.oldLine }),
      ...(role.newLine === undefined ? {} : { newLine: role.newLine }), channels };
  });
  if (a.alignmentRoles.length !== b.alignmentRoles.length) fail('Split alignment-padding maps disagree');
  const alignmentPadding = a.alignmentRoles.map((item, index) => {
    const other = b.alignmentRoles[index];
    if (item.side !== other.side || item.alignedRow !== other.alignedRow) fail('Split alignment-padding maps disagree');
    const gutter = compareProfile(item.gutterBackground, other.gutterBackground);
    const content = compareProfile(item.contentBackground, other.contentBackground);
    for (const [channel, compared] of [['alignmentGutterBackground', gutter], ['alignmentContentBackground', content]]) {
      if (!compared.equal) differences.push({ side: item.side, alignedRow: item.alignedRow, channel,
        left: compared.left, right: compared.right });
    }
    return { side: item.side, alignedRow: item.alignedRow, gutterBackground: gutter, contentBackground: content };
  });
  const cardBackground = compareProfile(a.cardBackground, b.cardBackground);
  if (!cardBackground.equal) differences.unshift({ channel: 'cardBackground', left: cardBackground.left, right: cardBackground.right });

  const leftWidths = new Map(sourceGeometry(a.sources).map(span => [`${span.side}:${span.logicalRow}:${span.startByte}:${span.endByte}`, span.columns]));
  const rightWidths = new Map(sourceGeometry(b.sources).map(span => [`${span.side}:${span.logicalRow}:${span.startByte}:${span.endByte}`, span.columns]));
  const sourceProjectionDifferences = [...leftWidths].flatMap(([key, columns]) => rightWidths.get(key) === columns ? [] :
    [{ key, leftColumns: columns, rightColumns: rightWidths.get(key) }]);
  return { schema: 1, viewIdentity: left.viewIdentity, fixture: a.context.fixture, theme: left.theme,
    rowsCompared: roles.length, cardBackground, roles, alignmentPadding, differences,
    geometryDifferences: { left: a.geometry, right: b.geometry, leftScreen: a.screens, rightScreen: b.screens,
      sourceProjectionDifferences, leftSurfaces: surfaceGeometry(a.surfaces, a.alignmentPadding),
      rightSurfaces: surfaceGeometry(b.surfaces, b.alignmentPadding),
      leftTab: { size: a.sources[sideNames(left.viewIdentity)[0]].tabSize, mode: a.sources[sideNames(left.viewIdentity)[0]].tabMode },
      rightTab: { size: b.sources[sideNames(right.viewIdentity)[0]].tabSize, mode: b.sources[sideNames(right.viewIdentity)[0]].tabMode } },
    left: { application: left.application, identity: left.identity, sources: a.sources, observations: a.surfaces, alignmentPadding: a.alignmentPadding },
    right: { application: right.application, identity: right.identity, sources: b.sources, observations: b.surfaces, alignmentPadding: b.alignmentPadding } };
}

function assertMappedRowSurfaces(samples, sourceMaps, populations) {
  for (const [page, ranges] of sourceMaps.entries()) for (const range of ranges) {
    const entry = populations[range.side]?.find(item => item.logicalRow === range.line);
    if (!entry) fail('Source map references an unknown visible diff row');
    const kinds = [...backgroundKinds, 'line-number', ...(signFor(entry.row) ? ['sign'] : [])];
    for (const kind of kinds) {
      const found = samples.filter(sample => sample.kind === kind && sample.page === page && sample.row === range.row &&
        sample.side === range.side && sample.logicalRow === range.line);
      if (found.length !== 1) fail(`${found.length ? 'Ambiguous' : 'Missing'} ${kind} evidence for mapped row/page ${page}:${range.row}`);
    }
  }
}

function validateStructuralSurfaceGeometry(samples, sourceMaps, geometry, context, tabSize, tabMode) {
  const allSides = sideNames(context.viewIdentity);
  for (const anchor of samples.filter(sample => sample.kind === 'card-background')) {
    const page = geometry[anchor.page];
    if (anchor.start < page.bar || anchor.end > page.cardRight) fail('Card background anchor exceeds native card geometry');
  }
  const sourceFor = (page, side, logicalRow) => sourceMaps[page].filter(range => range.side === side && range.line === logicalRow);
  for (const sample of samples.filter(item => item.kind === 'body-background')) {
    const row = context.logicalRows[sample.logicalRow - 1], sourceRanges = sourceFor(sample.page, sample.side, sample.logicalRow);
    if (sourceRanges.length !== 1 || sourceRanges[0].row !== sample.row || sourceRanges[0].column !== sample.start ||
        sourceRanges[0].start !== 0 || sourceRanges[0].end !== row.text.length) {
      fail('Diff body surface disagrees with its complete source projection');
    }
    const pane = geometry[sample.page].panes.find(item => item.side === sample.side);
    if (!pane || sample.end > pane.right) fail('Diff body surface exceeds its native pane');
    const projection = projectLine(row.text, tabSize, tabMode);
    const bodyColumns = Math.max(projection.columns, 1), blank = row.text === '';
    if (sample.end - sample.start !== bodyColumns || (blank ? sample.text.trim() !== '' : sample.text !== projection.text)) {
      fail('Diff body surface does not cover its logical text');
    }
    const gutter = samples.find(item => item.kind === 'gutter-background' && item.side === sample.side &&
      item.logicalRow === sample.logicalRow && item.page === sample.page && item.row === sample.row);
    const padding = samples.find(item => item.kind === 'padding-background' && item.side === sample.side &&
      item.logicalRow === sample.logicalRow && item.page === sample.page && item.row === sample.row);
    if (!gutter || gutter.start !== pane.left || gutter.end !== sample.start ||
        !padding || padding.start !== sample.end || padding.end !== pane.right ||
        padding.text.trim() !== '') fail('Diff gutter/body/trailing-padding boundaries disagree');
    const number = samples.find(item => item.kind === 'line-number' && item.side === sample.side &&
      item.logicalRow === sample.logicalRow && item.page === sample.page && item.row === sample.row);
    const sign = samples.find(item => item.kind === 'sign' && item.side === sample.side &&
      item.logicalRow === sample.logicalRow && item.page === sample.page && item.row === sample.row);
    if (!number || number.start < gutter.start || number.end > gutter.end || sign && (sign.start < gutter.start || sign.end > gutter.end)) {
      fail('Diff number/sign lies outside its gutter');
    }
    for (const label of [number, sign].filter(Boolean)) for (const cell of label.cells) {
      const gutterCell = gutter.cells.find(value => value.column === cell.column);
      if (!gutterCell || cell.text !== gutterCell.text || cell.width !== gutterCell.width || cell.signature !== gutterCell.signature) {
        fail('Diff label contradicts its overlapping gutter cell');
      }
    }
    const numberBefore = gutter.cells.find(cell => cell.column === number.start - 1);
    const numberAfter = gutter.cells.find(cell => cell.column === number.end);
    if (numberBefore && /^[0-9]$/u.test(numberBefore.text) || numberAfter && /^[0-9]$/u.test(numberAfter.text)) {
      fail('Diff line number does not cover its complete decimal run');
    }
  }
  for (const [side, entries] of Object.entries(sideRows(context.logicalRows, context.viewIdentity))) for (const { logicalRow } of entries) {
    const pages = new Set(samples.filter(sample => sample.kind === 'body-background' && sample.side === side && sample.logicalRow === logicalRow)
      .map(sample => sample.page));
    for (const page of pages) for (const kind of backgroundKinds) {
      if (samples.filter(sample => sample.kind === kind && sample.side === side && sample.logicalRow === logicalRow && sample.page === page).length !== 1) {
        fail(`Ambiguous ${kind} mapping for ${side} logical row ${logicalRow}`);
      }
    }
  }
  if (allSides.length !== Object.keys(sideRows(context.logicalRows, context.viewIdentity)).length) fail('Invalid visible diff side population');
}
