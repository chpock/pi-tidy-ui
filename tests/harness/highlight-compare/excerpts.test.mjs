import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import xterm from '@xterm/headless';
import { renderTerminalExcerpts } from '../../../scripts/highlight-compare/excerpts.mjs';
import { compareCaptures, digest } from '../../../scripts/highlight-compare/model.mjs';

const { Terminal } = xterm;
const style = (foreground = { mode: 'default' }, background = { mode: 'default' }, attributes = []) =>
  ({ foreground, background, attributes });
const sourceCells = (texts, styles) => texts.map((text, index) => ({ text, columns: text === '界' ? 2 : 1, style: styles[index] }));
const sourceSpan = (line, projection) => ({ line, projection });
const sourceReport = (left, right, features = []) => ({ fixture: { kind: 'source' }, features,
  left: { spans: left }, right: { spans: right } });

async function parsed(text, t) {
  const term = new Terminal({ cols: 120, rows: 64, scrollback: 0, allowProposedApi: true });
  t.after(() => term.dispose());
  await new Promise(resolve => term.write(text.replaceAll('\n', '\r\n'), resolve));
  return term;
}

function findRow(term, includes) {
  for (let index = 0; index < term.rows; index++) {
    const line = term.buffer.active.getLine(index);
    if (line?.translateToString(true).includes(includes)) return line;
  }
  assert.fail(`terminal row not found: ${includes}`);
}

function sample(kind, cells, { side, logicalRow } = {}) {
  return { kind, page: 0, row: 0, start: 0, end: cells.length, ...(side ? { side, logicalRow } : {}),
    cells: cells.map((cell, column) => ({ column, text: cell.text, width: cell.width, style: cell.style })) };
}

function observedCell(text, foreground = 0x778899, background = 0x112233, attributes = []) {
  return { text, width: 1, style: style({ mode: 'rgb', value: foreground }, { mode: 'rgb', value: background }, attributes) };
}

function diffReport() {
  const roles = [
    { side: 'old', logicalRow: 1, role: 'context', text: 'context' },
    { side: 'new', logicalRow: 1, role: 'context', text: 'context' },
    { side: 'old', logicalRow: 2, role: 'removed', text: '' },
    { side: 'new', logicalRow: 3, role: 'added', text: 'X' },
  ];
  const observations = side => {
    const result = [];
    for (const record of roles.filter(item => item.side === side)) {
      const sign = record.role === 'added' ? '+' : record.role === 'removed' ? '-' : ' ';
      const number = String(record.logicalRow);
      const gutter = [observedCell(number), observedCell(sign)];
      const body = record.text ? [...record.text].map(char => observedCell(char, 0xaabbcc, 0x334455,
        record.role === 'added' ? ['bold', 'italic', 'strike'] : [])) : [observedCell(' ', 0x556677, 0x440000)];
      result.push(sample('gutter-background', gutter, record), sample('body-background', body, record),
        sample('padding-background', [observedCell(' ', 0x778899, 0x667788)], record));
    }
    result.push(sample('card-background', [observedCell(' ', 0x778899, 0x0a0b0c)]));
    return result;
  };
  const alignment = background => [{ side: 'old', alignedRow: 3,
    gutter: { cells: [observedCell(' ', 0x778899, background)] },
    content: { cells: [observedCell(' ', 0x778899, background), observedCell(' ', 0x778899, background)] } }];
  return { fixture: { kind: 'diff' }, viewIdentity: 'split', roles,
    left: { observations: observations('old').concat(observations('new').filter(item => item.kind !== 'card-background')),
      alignmentPadding: alignment(0x101010) },
    right: { observations: observations('old').concat(observations('new').filter(item => item.kind !== 'card-background')),
      alignmentPadding: alignment(0x202020) } };
}

test('source excerpts replay actual RGB, indexed and default styles with all font attributes and stored Unicode/tab widths', async t => {
  const all = style({ mode: 'rgb', value: 0x123456 }, { mode: 'indexed', value: 5 },
    ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse']);
  const wide = style({ mode: 'indexed', value: 42 }, { mode: 'rgb', value: 0xabcdef }, ['italic']);
  const normal = style();
  const projection = sourceCells(['A', '界', 'e\u0301', ' ', ' ', 'Z'], [all, wide, normal, normal, normal, normal]);
  const report = sourceReport([sourceSpan(1, projection)], [sourceSpan(1, projection)]);
  const term = await parsed(renderTerminalExcerpts(report), t), row = findRow(term, 'A界e\u0301');

  const first = row.getCell(9);
  assert.equal(first.getChars(), 'A');
  assert.equal(first.getFgColorMode(), 0x3000000);
  assert.equal(first.getFgColor(), 0x123456);
  assert.equal(Boolean(first.isBgPalette()), true);
  assert.equal(first.getBgColor(), 5);
  for (const name of ['isBold', 'isDim', 'isItalic', 'isUnderline', 'isStrikethrough', 'isInverse']) {
    assert.equal(Boolean(first[name]()), true, name);
  }

  const wideGlyph = row.getCell(10);
  assert.equal(wideGlyph.getChars(), '界');
  assert.equal(wideGlyph.getWidth(), 2);
  assert.equal(row.getCell(11).getWidth(), 0, 'the wide-cell continuation remains one indivisible glyph');
  assert.equal(Boolean(wideGlyph.isFgPalette()), true);
  assert.equal(wideGlyph.getFgColor(), 42);
  assert.equal(wideGlyph.getBgColorMode(), 0x3000000);
  assert.equal(wideGlyph.getBgColor(), 0xabcdef);
  assert.equal(Boolean(wideGlyph.isItalic()), true);
  assert.equal(Boolean(wideGlyph.isBold()), false);
  assert.equal(row.getCell(12).getChars(), 'e\u0301', 'combining text remains a single grapheme');
  assert.equal(row.getCell(12).getFgColorMode(), 0, 'default foreground is not guessed as RGB');
  assert.equal(row.getCell(12).getBgColorMode(), 0, 'default background is not guessed as RGB');
  assert.equal(Boolean(row.getCell(12).isItalic()), false, 'attributes reset before later cells');
  assert.equal(row.getCell(15).getChars(), 'Z', 'expanded tab spaces occupy their stored columns, not UTF-16 units');
  assert.equal(Boolean(row.getCell(15).isInverse()), false, 'inverse does not leak past the captured glyph');
});

test('source feature excerpts cover declared ranges and cap logical lines and long wrapped rows', () => {
  const spans = Array.from({ length: 30 }, (_, index) => sourceSpan(index + 1,
    sourceCells(index === 4 ? Array.from({ length: 240 }, () => '界') : ['x'],
      Array.from({ length: index === 4 ? 240 : 1 }, () => style()))));
  const output = renderTerminalExcerpts(sourceReport(spans, spans,
    [{ id: 'declared', startLine: 1, endLine: 30, features: ['feature'] } ]));
  const selected = new Set([...output.matchAll(/line (\d+) \|/gu)].map(match => Number(match[1])));
  assert.equal(selected.size, 24, 'at most 24 logical source lines are selected');
  assert.ok(selected.has(5), 'the longest captured logical line represents its declared feature range');
  assert.equal(selected.has(30), false, 'lines beyond the fixed logical-line budget are omitted');
  assert.match(output, /6 logical source lines omitted/);
  assert.match(output, /selected source lines continue beyond the excerpt row limit/);
  assert.equal((output.match(/界/gu) ?? []).length, 92, 'each pane stops after two rows without cutting a width-two glyph');
});

test('diff excerpts replay captured gutter/body/padding, blank rows, panel and empty-side alignment cells', async t => {
  const report = diffReport(), output = renderTerminalExcerpts(report), term = await parsed(output, t);
  const added = findRow(term, 'row 3 new added');
  assert.equal(added.getCell(20).getChars(), 'X');
  assert.equal(added.getCell(20).getFgColor(), 0xaabbcc, 'body syntax foreground is replayed literally');
  assert.equal(Boolean(added.getCell(20).isBold()), true);
  assert.equal(Boolean(added.getCell(20).isItalic()), true);
  assert.equal(Boolean(added.getCell(20).isStrikethrough()), true);

  const removed = findRow(term, 'row 2 old removed');
  const removedGutter = removed.translateToString(true).indexOf('2- ');
  assert.ok(removedGutter >= 0, 'the captured removed number/sign identify the blank body');
  assert.equal(removed.getCell(removedGutter + 2).getChars(), ' ');
  assert.equal(removed.getCell(removedGutter + 2).getBgColor(), 0x440000, 'blank changed content retains its actual body cell');
  for (const pane of added.translateToString(true).split(' || ')) {
    assert.equal((pane.match(/\+/gu) ?? []).length, 1, 'each pane shows the sign once through its gutter cell');
  }
  for (const pane of removed.translateToString(true).split(' || ')) {
    assert.equal((pane.match(/-/gu) ?? []).length, 1, 'each pane shows the sign once through its gutter cell');
  }

  const alignment = findRow(term, 'alignment old 3');
  assert.equal(alignment.getCell(18).getBgColor(), 0x101010, 'empty-side gutter/content retain sampled style');
  const card = findRow(term, 'card |');
  assert.equal(card.getCell(7).getBgColor(), 0x0a0b0c, 'card background is rendered from captured cells');
  assert.match(output, /Diff rows replay captured gutter, body, and trailing-padding cells/);
});

test('ANSI excerpt boundary rejects ESC and C1 OSC control text from captured surfaces', () => {
  const baseline = diffReport();
  for (const [kind, text] of [['body-background', '\x1b]0;injected\x07'], ['card-background', '\u009d0;injected\u009c']]) {
    const report = structuredClone(baseline);
    const target = report.left.observations.find(sample => sample.kind === kind);
    target.cells[0].text = text;
    assert.throws(() => renderTerminalExcerpts(report), /control characters/i, `${kind} rejects terminal control text`);
  }
});

test('accepted source-position serialization order cannot scramble the terminal excerpt', () => {
  const source = 'ABC';
  const capture = { schema: 1, status: 'ready', readiness: { status: 'ready' }, source,
    fixture: { id: 'span-order', kind: 'source', sha256: digest(source) }, theme: { family: 'unit', variant: 'dark' },
    spans: [...source].map((text, startByte) => ({ line: 1, startByte, endByte: startByte + 1, text, columns: 1,
      projection: [{ text, columns: 1, style: style() }] })) };
  const reordered = { ...capture, spans: [...capture.spans].reverse() };
  const canonical = compareCaptures(capture, capture), shuffled = compareCaptures(reordered, capture);
  assert.equal(shuffled.changed.length, 0, 'both serialized inputs have identical complete source positions');
  assert.equal(renderTerminalExcerpts(shuffled), renderTerminalExcerpts(canonical), 'source-byte order, not input array order, determines displayed source');
});
