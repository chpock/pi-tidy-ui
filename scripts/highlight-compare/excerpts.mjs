const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const PANE_COLUMNS = 56;
const SOURCE_LINE_LIMIT = 24;
const SOURCE_ROWS_PER_LINE = 2;
const DIFF_ROW_LIMIT = 12;
const DIFF_ROWS_PER_SAMPLE = 2;
const attributes = ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse'];
const terminalControls = /[\u0000-\u001f\u007f-\u009f]/u;
const attributeCodes = { bold: '1', dim: '2', italic: '3', underline: '4', strike: '9', inverse: '7' };

function colorCodes(color, foreground) {
  if (color?.mode === 'default') return [foreground ? '39' : '49'];
  if (color?.mode === 'rgb' && Number.isInteger(color.value) && color.value >= 0 && color.value <= 0xffffff) {
    return [foreground ? '38' : '48', '2', (color.value >> 16) & 255, (color.value >> 8) & 255, color.value & 255].map(String);
  }
  if (color?.mode === 'indexed' && Number.isInteger(color.value) && color.value >= 0 && color.value <= 255) {
    return [foreground ? '38' : '48', '5', String(color.value)];
  }
  throw new Error('Invalid color in normalized highlighting report');
}

function styleSequence(style) {
  if (!style || !Array.isArray(style.attributes) || style.attributes.some(name => !attributes.includes(name))) {
    throw new Error('Invalid style in normalized highlighting report');
  }
  const codes = ['0', ...colorCodes(style.foreground, true), ...colorCodes(style.background, false)];
  for (const name of attributes) if (style.attributes.includes(name)) codes.push(attributeCodes[name]);
  return `${ESC}${codes.join(';')}m`;
}

function paintRows(cells, maxColumns, maxRows) {
  const rows = [{ content: '', columns: 0 }];
  let row = rows[0], truncated = false;
  for (const cell of cells) {
    const columns = cell.columns ?? cell.width;
    if (typeof cell.text !== 'string' || terminalControls.test(cell.text)) {
      throw new Error('Terminal excerpt refuses control characters in captured cells');
    }
    if (columns === 0) continue;
    if (!Number.isInteger(columns) || columns < 1 || columns > 2) {
      throw new Error('Invalid cell in normalized highlighting report');
    }
    if (columns > maxColumns) { truncated = true; continue; }
    if (row.columns + columns > maxColumns) {
      if (rows.length >= maxRows) { truncated = true; break; }
      row = { content: '', columns: 0 };
      rows.push(row);
    }
    row.content += `${styleSequence(cell.style)}${cell.text}${RESET}`;
    row.columns += columns;
  }
  return { rows, truncated };
}

function panePrefix(prefix, columns) {
  if (prefix.length > PANE_COLUMNS || columns > PANE_COLUMNS - prefix.length) {
    throw new Error('Excerpt pane exceeds its fixed width');
  }
  return `${RESET}${prefix}`;
}

function pairedRows(left, right, leftPrefix, rightPrefix, output) {
  const count = Math.max(left.rows.length, right.rows.length);
  for (let index = 0; index < count; index++) {
    const a = left.rows[index], b = right.rows[index];
    const aPrefix = index === 0 ? leftPrefix : ' '.repeat(leftPrefix.length);
    const bPrefix = index === 0 ? rightPrefix : ' '.repeat(rightPrefix.length);
    const aColumns = a?.columns ?? 0, bColumns = b?.columns ?? 0;
    const leftText = `${panePrefix(aPrefix, aColumns)}${a?.content ?? ''}${RESET}${' '.repeat(PANE_COLUMNS - aPrefix.length - aColumns)}`;
    const rightText = `${panePrefix(bPrefix, bColumns)}${b?.content ?? ''}${RESET}${' '.repeat(PANE_COLUMNS - bPrefix.length - bColumns)}`;
    output.push(`${leftText}${RESET} || ${RESET}${rightText}${RESET}`);
  }
}

function sourceLines(spans) {
  const lines = new Map();
  for (const span of [...spans].sort((a, b) => a.startByte - b.startByte)) {
    const cells = lines.get(span.line) ?? [];
    for (const cell of span.projection) cells.push({ text: cell.text, columns: cell.columns, style: cell.style });
    lines.set(span.line, cells);
  }
  return lines;
}

function sourceWidth(cells) {
  return cells.reduce((width, cell) => width + cell.columns, 0);
}

function selectSourceLines(report, lines) {
  const available = [...lines.keys()].sort((a, b) => a - b), selected = new Set();
  const features = Array.isArray(report.features) ? report.features : [];
  if (!features.length) return { selected: available.slice(0, 8), features, available };

  for (const feature of features) {
    const candidates = available.filter(line => line >= feature.startLine && line <= feature.endLine)
      .sort((a, b) => sourceWidth(lines.get(b)) - sourceWidth(lines.get(a)) || a - b);
    if (candidates.length && selected.size < SOURCE_LINE_LIMIT) selected.add(candidates[0]);
  }
  for (const feature of features) {
    for (const line of available) {
      if (line < feature.startLine || line > feature.endLine || selected.has(line)) continue;
      if (selected.size >= SOURCE_LINE_LIMIT) break;
      selected.add(line);
    }
  }
  return { selected: [...selected].sort((a, b) => a - b), features, available };
}

function renderSource(report) {
  const leftLines = sourceLines(report.left.spans), rightLines = sourceLines(report.right.spans);
  const { selected, features, available } = selectSourceLines(report, leftLines), output = [];
  let truncatedLines = 0;
  for (const line of selected) {
    if (!Number.isSafeInteger(line) || line < 1) throw new Error('Invalid logical line in normalized highlighting report');
    const prefix = `line ${line} | `, width = PANE_COLUMNS - prefix.length;
    const left = paintRows(leftLines.get(line) ?? [], width, SOURCE_ROWS_PER_LINE);
    const right = paintRows(rightLines.get(line) ?? [], width, SOURCE_ROWS_PER_LINE);
    if (left.truncated || right.truncated) truncatedLines++;
    pairedRows(left, right, prefix, prefix, output);
  }
  const omittedFeatures = features.filter(feature => !selected.some(line => line >= feature.startLine && line <= feature.endLine)).length;
  const notes = [];
  if (available.length > selected.length) notes.push(`${available.length - selected.length} logical source lines omitted by the excerpt bounds.`);
  if (omittedFeatures) notes.push(`${omittedFeatures} declared feature cases have no representative line in the excerpt.`);
  if (truncatedLines) notes.push(`${truncatedLines} selected source lines continue beyond the excerpt row limit.`);
  return { output, notes };
}

const compareByPage = (a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.row ?? 0) - (b.row ?? 0) || (a.start ?? 0) - (b.start ?? 0);
const roleNames = ['context', 'added', 'removed'];
const sideNames = ['unified', 'old', 'new'];

function selectDiffRows(report) {
  const records = report.roles, selected = new Map();
  const add = record => {
    if (record && selected.size < DIFF_ROW_LIMIT) selected.set(`${record.side}:${record.logicalRow}`, record);
  };
  for (const role of roleNames) add(records.find(record => record.role === role));
  add(records.find(record => record.text === ''));
  for (const side of sideNames) for (const role of roleNames) {
    add(records.find(record => record.side === side && record.role === role));
  }
  for (const record of records) add(record);
  return [...selected.values()].sort((a, b) => a.logicalRow - b.logicalRow || sideNames.indexOf(a.side) - sideNames.indexOf(b.side));
}

function observedSample(observations, kind, record) {
  return observations.filter(sample => sample.kind === kind && sample.side === record.side && sample.logicalRow === record.logicalRow)
    .sort(compareByPage)[0];
}

function* surfaceCells(observations, record) {
  for (const kind of ['gutter-background', 'body-background', 'padding-background']) {
    const sample = observedSample(observations, kind, record);
    if (!sample) throw new Error(`Diff excerpt is missing captured ${kind} cells`);
    for (const cell of sample.cells) yield { text: cell.text, width: cell.width, style: cell.style };
  }
}

function* alignmentCells(item) {
  if (!item?.gutter?.cells || !item?.content?.cells) throw new Error('Diff excerpt is missing captured alignment cells');
  for (const cell of item.gutter.cells) yield { text: cell.text, width: cell.width, style: cell.style };
  for (const cell of item.content.cells) yield { text: cell.text, width: cell.width, style: cell.style };
}

function* cardCells(observations) {
  const sample = observations.filter(value => value.kind === 'card-background').sort(compareByPage)[0];
  if (!sample) throw new Error('Diff excerpt is missing captured card-background cells');
  for (const cell of sample.cells) yield { text: cell.text, width: cell.width, style: cell.style };
}

function renderDiff(report) {
  const output = [], notes = [], selected = selectDiffRows(report), selectedKeys = new Set(selected.map(row => `${row.side}:${row.logicalRow}`));
  let truncatedRows = 0;
  for (const record of selected) {
    if (!Number.isSafeInteger(record.logicalRow) || record.logicalRow < 1 || !sideNames.includes(record.side) || !roleNames.includes(record.role)) {
      throw new Error('Invalid row label in normalized diff report');
    }
    const prefix = `row ${record.logicalRow} ${record.side} ${record.role} | `;
    const width = PANE_COLUMNS - prefix.length;
    const left = paintRows(surfaceCells(report.left.observations, record), width, DIFF_ROWS_PER_SAMPLE);
    const right = paintRows(surfaceCells(report.right.observations, record), width, DIFF_ROWS_PER_SAMPLE);
    if (left.truncated || right.truncated) truncatedRows++;
    pairedRows(left, right, prefix, prefix, output);
  }

  const leftAlignment = report.left.alignmentPadding[0];
  if (leftAlignment) {
    if (!['old', 'new'].includes(leftAlignment.side) || !Number.isSafeInteger(leftAlignment.alignedRow) || leftAlignment.alignedRow < 1) {
      throw new Error('Invalid alignment label in normalized diff report');
    }
    const rightAlignment = report.right.alignmentPadding.find(item => item.side === leftAlignment.side && item.alignedRow === leftAlignment.alignedRow);
    if (!rightAlignment) throw new Error('Diff excerpt is missing matching captured alignment cells');
    const prefix = `alignment ${leftAlignment.side} ${leftAlignment.alignedRow} | `, width = PANE_COLUMNS - prefix.length;
    const left = paintRows(alignmentCells(leftAlignment), width, DIFF_ROWS_PER_SAMPLE);
    const right = paintRows(alignmentCells(rightAlignment), width, DIFF_ROWS_PER_SAMPLE);
    if (left.truncated || right.truncated) notes.push('The selected empty-side alignment continues beyond the excerpt row limit.');
    pairedRows(left, right, prefix, prefix, output);
  }

  const prefix = 'card | ', width = PANE_COLUMNS - prefix.length;
  const leftCard = paintRows(cardCells(report.left.observations), width, 1);
  const rightCard = paintRows(cardCells(report.right.observations), width, 1);
  if (leftCard.truncated || rightCard.truncated) notes.push('Card-background samples are clipped to the excerpt pane width.');
  pairedRows(leftCard, rightCard, prefix, prefix, output);

  const omittedRows = report.roles.length - selectedKeys.size;
  if (omittedRows) notes.unshift(`${omittedRows} logical diff row/side observations omitted by the excerpt bounds.`);
  if (report.left.alignmentPadding.length > 1 || report.right.alignmentPadding.length > 1) {
    notes.push('Only one empty-side alignment sample is shown.');
  }
  if (truncatedRows) notes.push(`${truncatedRows} selected diff rows continue beyond the excerpt row limit.`);
  return { output, notes };
}

export function renderTerminalExcerpts(report) {
  if (!report || !report.fixture) throw new Error('Terminal excerpt requires a normalized comparison report');
  const diff = report.fixture.kind === 'diff';
  const rendered = diff ? renderDiff(report) : renderSource(report);
  const heading = [
    'Captured terminal styles; bounded comparison excerpt.',
    diff ? 'Diff rows replay captured gutter, body, and trailing-padding cells.' : 'Source rows replay captured native text projections.',
    '',
    'Left'.padEnd(PANE_COLUMNS) + ' || Right',
    '-'.repeat(PANE_COLUMNS) + '-++-' + '-'.repeat(PANE_COLUMNS),
  ];
  return [...heading, ...rendered.output, ...(rendered.notes.length ? ['', ...rendered.notes] : [])].join('\n') + `\n${RESET}`;
}
