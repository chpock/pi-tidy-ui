import '../../../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileToolReaderFixture, prepareFileToolCall } from '../../../../fixtures/tool-adapters/reader-fixture.ts';

function read(text: string, args: Record<string, unknown> = {}, details?: Record<string, unknown>) {
  const parameters: Record<string, unknown> = { path: 'sample.md', ...args };
  return { toolName: 'read', args: parameters, isPartial: false,
    result: { content: [{ type: 'text', text }], details } };
}
function aftRead(lines: string[], start = 1, tail = '') {
  const end = start + lines.length - 1, width = String(end).length;
  const content = lines.map((line, index) => `${String(start + index).padStart(width)}: ${line}`).join('\n');
  return read(content + tail, { startLine: String(start), endLine: String(end) }, {
    success: true, content, text: content + tail, start_line: start, end_line: end, lines_read: lines.length,
    complete: true, truncated: false,
  });
}

test('read source keeps stock numeric text literal and decodes verified AFT display numbering', () => {
  assert.doesNotThrow(() => fileToolReaderFixture({ toolName: 'read' }).source('full'), 'the saved-result identity remains safe before a result exists');
  const source = ['## Conclusion', '', '\t1: literal source 名 👩‍👩‍👧‍👦', '**Supported**.'];
  const stock = read(source.join('\n'), { offset: 41 });
  const aft = aftRead(source, 41), saved = JSON.stringify(aft);
  aft.args.offset = 900;
  const stockCard = prepareFileToolCall(stock)!, aftCard = prepareFileToolCall(aft)!;
  assert.equal(aftCard.sources[0]!.text, source.join('\n'), 'the parser receives original Markdown, tabs and literal source prefixes');
  assert.deepEqual(aftCard.sources, stockCard.sources, 'stock and AFT returned source has the same parser coordinates');
  assert.deepEqual(aftCard.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [41, 42, 43, 44],
    'returned AFT coordinates, not a conflicting argument, determine source line numbers');
  assert.equal(aftCard.view.lines[2]!.kind === 'gap' ? '' : aftCard.view.lines[2]!.logical, source[2]);
  delete aft.args.offset;
  assert.equal(JSON.stringify(aft), saved, 'normalization does not rewrite saved arguments or results');
  const numeric = prepareFileToolCall(read('1: literal source\n2: another literal', { offset: 8 }))!;
  assert.equal(numeric.sources[0]!.text, '1: literal source\n2: another literal', 'no metadata means no prefix stripping');
  assert.deepEqual(numeric.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [8, 9]);
});

test('captured actual AFT read keeps ranged Markdown and its trailing display newline separate', () => {
  const captured = JSON.parse(readFileSync(new URL('../../../../fixtures/tool-adapters/aft/read-result.json', import.meta.url), 'utf8'));
  const result = captured.result, saved = JSON.stringify(result);
  const card = prepareFileToolCall({ toolName: 'read', args: { path: 'saved.md', ...captured.arguments }, isPartial: false, result })!;
  assert.equal(card.sources.length, 1);
  assert.equal(card.sources[0]!.text, captured.source);
  assert.deepEqual(card.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [2, 3, 4, 5, 6, 7, 8, undefined]);
  assert.equal(card.view.lines[2]!.kind === 'gap' ? '' : card.view.lines[2]!.logical, '1: SOURCE_LITERAL_AFT');
  assert.equal(JSON.stringify(result), saved, 'the actual persisted AFT response remains byte-equivalent');
});

test('AFT read preserves a producer footer without classifying or numbering it as file source', () => {
  const source = ['## Returned heading', 'source text'], notice = '(Showing lines 41-42 of 100. Use startLine/endLine to read other sections.)';
  const node = aftRead(source, 41, `\n\n${notice}`), before = JSON.stringify(node);
  const card = prepareFileToolCall(node)!;
  assert.deepEqual(card.sources, [{ side: 'next', text: source.join('\n'), rows: [0, 1] }]);
  assert.deepEqual(card.view.lines.map(row => row.kind === 'gap' ? undefined : [row.logical, row.next]),
    [[source[0], 41], [source[1], 42], ['', undefined], [notice, undefined]], 'the complete saved footer remains neutral, unnumbered display text');
  assert.equal(JSON.stringify(node), before);
  node.result.details!.content = node.result.content[0]!.text;
  assert.deepEqual(prepareFileToolCall(node)!.sources, card.sources, 'a footer inside metadata content is still not file source');
  const crlf = aftRead(source, 41, `\r\n\r\n${notice}`);
  assert.deepEqual(prepareFileToolCall(crlf)!.sources, card.sources, 'normal saved line-ending cleanup also applies at the payload/footer boundary');
  const lineEnded = aftRead(source, 41), block = `${lineEnded.result.content[0]!.text}\n`;
  lineEnded.result.details!.content = block;
  lineEnded.result.content[0]!.text = block + notice;
  lineEnded.result.details!.text = lineEnded.result.content[0]!.text;
  const appended = prepareFileToolCall(lineEnded)!;
  assert.deepEqual(appended.sources, card.sources, 'an existing final newline separates the source block from an immediately appended footer');
  assert.deepEqual(appended.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [41, 42, undefined]);
});

test('AFT read validates the complete numbered block and range before stripping any source', () => {
  const good = aftRead(['first', 'second'], 41);
  const variants = [
    { ...good.result.details, success: false },
    { ...good.result.details, start_line: '41' },
    { ...good.result.details, start_line: 0 },
    { ...good.result.details, end_line: 43 },
    { ...good.result.details, lines_read: 1 },
    { ...good.result.details, lines_read: 1, end_line: 41 },
    { ...good.result.details, content: '41: first', lines_read: 1, end_line: 41 },
    { ...good.result.details, lines_read: Number.MAX_SAFE_INTEGER + 1 },
    { ...good.result.details, content: '41: first\n42: DIFFERENT_SAVED_CONTENT' },
    { ...good.result.details, content: '41: first\n42: SECOND' },
    { ...good.result.details, content: '41: first\n43: second' },
  ];
  for (const details of variants) {
    const node = read(good.result.content[0]!.text, { offset: 7 }, details);
    const card = prepareFileToolCall(node)!;
    assert.equal(card.sources[0]!.text, node.result.content[0]!.text, 'unproven metadata stays literal, with no partial stripping');
    assert.deepEqual(card.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [7, 8]);
  }
  const nullDetails = { ...good, result: { ...good.result, details: null } };
  assert.equal(prepareFileToolCall(nullDetails)!.sources[0]!.text, good.result.content[0]!.text, 'null metadata stays literal without throwing');
  const zeroBased = aftRead(['zero', 'one'], 0);
  assert.equal(prepareFileToolCall(zeroBased)!.sources[0]!.text, zeroBased.result.content[0]!.text,
    'coherent zero-based coordinates do not prove an AFT source range');
  const malformed = aftRead(['first', 'second'], 41);
  malformed.result.content[0]!.text = '41: first\n43: second';
  malformed.result.details!.content = malformed.result.content[0]!.text;
  assert.equal(prepareFileToolCall(malformed)!.sources[0]!.text, malformed.result.content[0]!.text,
    'matching metadata text alone cannot authorize a wrong numbered row');
});

test('AFT read decodes valid Unicode line and paragraph separators without losing source text', () => {
  for (const separator of ['\u2028', '\u2029']) {
    for (const source of [`## A${separator}B`, `## A${separator}`, `## A${separator}${separator}`]) {
      const card = prepareFileToolCall(aftRead([source]))!;
      assert.equal(card.sources[0]!.text, source, 'a non-LF Unicode separator is file content, not a malformed producer prefix');
      assert.deepEqual(card.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [1]);
      assert.equal(card.view.lines[0]!.kind === 'gap' ? '' : card.view.lines[0]!.logical, source);
    }
  }
});

test('AFT read validates numbers without guessing their padding width at a digit boundary', () => {
  const text = '   8: ## Returned heading\n   9: \n  10: 1: literal';
  const card = prepareFileToolCall(read(text, {}, { success: true, content: text, lines_read: 3, start_line: 8, end_line: 10, total_lines: 1000 }))!;
  assert.equal(card.sources[0]!.text, '## Returned heading\n\n1: literal');
  assert.deepEqual(card.view.lines.map(row => row.kind === 'gap' ? undefined : row.next), [8, 9, 10]);
});

test('AFT read supplies shebang provenance from saved coordinates and leaves unproven empty data literal', () => {
  const source = ['#!/usr/bin/env python3', 'print(1)'];
  assert.equal(prepareFileToolCall(aftRead(source))!.sources[0]!.languageHint, 'python');
  const later = aftRead(source, 41); later.args.offset = 1;
  assert.equal(prepareFileToolCall(later)!.sources[0]!.languageHint, undefined, 'a later returned excerpt is not the original first line');
  assert.deepEqual(prepareFileToolCall(aftRead([])), prepareFileToolCall(read('')),
    'without numbered rows there is no evidence of producer decoration to strip');
});
