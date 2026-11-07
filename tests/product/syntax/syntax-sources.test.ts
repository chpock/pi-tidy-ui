import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { filePreviewText } from '../../../src/file-card.ts';
import { bashToolReaderFixture, prepareFileToolCall } from '../../fixtures/tool-adapters/reader-fixture.ts';
import { fileCardFixture as renderFileCard, bashCardFixture as renderBashCard } from '../../fixtures/prepared-card.ts';
import { stripVTControlCharacters } from 'node:util';

import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
const theme = getThemeByName('dark')!;
function edit(diff: string) {
  return { toolName: 'edit', args: { path: 'sample.ts' }, isPartial: false, result: { details: { diff } } };
}
function write(content: string, details?: Record<string, unknown>) {
  return { toolName: 'write', args: { path: 'sample.ts', content }, isPartial: false, result: { details } };
}

// Preparation is called explicitly outside rendering. It does not acquire a
// provider, open files, emit ANSI, expand parser tabs or project visible context.
test('bounded preview normalizes CRLF and CR-only rows before terminal-control cleaning', () => {
  assert.deepEqual(filePreviewText('one\r\ntwo\rthree\r'), { text: 'one\ntwo\nthree', omitted: false });
});

test('file preparation keeps parser tabs and exact normalized endings separate from display cells', () => {
  const node = write('\tconst 名 = 1;\r\n\t\tvalue();\r');
  const saved = JSON.stringify(node), plan = prepareFileToolCall(node)!;
  assert.equal(plan.path, 'sample.ts');
  assert.equal(plan.view.label, 'Wrote');
  assert.equal(plan.view.mode, 'code');
  assert.deepEqual(plan.sources, [{ side: 'next', text: '\tconst 名 = 1;\n\t\tvalue();\n', rows: [0, 1, 2] }]);
  assert.deepEqual(plan.view.lines.map(row => row.kind === 'gap' ? '' : row.text), ['    const 名 = 1;', '        value();', '']);
  assert.equal(JSON.stringify(node), saved, 'args, results and session-owned bytes stay untouched');
  assert.equal(prepareFileToolCall(write('const a = 1;'))!.sources[0]!.text, 'const a = 1;', 'no fabricated final newline');
  assert.deepEqual(prepareFileToolCall(write(''))!.sources, [], 'empty visible source requires no parser work');
});

test('numbered saved diff separates old/new sources before any display context reduction', () => {
  const node = edit(' 1 /* open\n 2 hidden_a\n 3 hidden_b\n 4 hidden_c\n-5 old\tname\n+5 new\tname\n 6 */');
  const plan = prepareFileToolCall(node)!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: '/* open\nhidden_a\nhidden_b\nhidden_c\nold\tname\n*/', rows: [0, 1, 2, 3, 4, 6] },
    { side: 'next', text: '/* open\nhidden_a\nhidden_b\nhidden_c\nnew\tname\n*/', rows: [0, 1, 2, 3, 5, 6] },
  ]);
  assert.ok(plan.view.lines.some(row => row.kind !== 'gap' && row.text === '/* open'), 'all supplied context stays available to parser');
});

test('explicit omissions and line-number gaps are hard parser boundaries on each diff side', () => {
  const plan = prepareFileToolCall(edit(' 1 /* open\n-2 old\n+2 new\n  ...\n 9 neutral\n-10 before\n+10 after\n 12 another'))!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: '/* open\nold', rows: [0, 1] },
    { side: 'old', text: 'neutral\nbefore', rows: [4, 5] },
    { side: 'old', text: 'another', rows: [7] },
    { side: 'next', text: '/* open\nnew', rows: [0, 2] },
    { side: 'next', text: 'neutral\nafter', rows: [4, 6] },
    { side: 'next', text: 'another', rows: [7] },
  ]);
});

test('single-file patch continuity follows proven source positions, never hunk concatenation alone', () => {
  const plan = prepareFileToolCall({ ...edit('ignored'), result: { details: { patch:
    '--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,2 @@\n /* open\n-old\n+new\n@@ -8,1 +8,1 @@\n neutral\n' } } })!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: '/* open\nold', rows: [0, 1] },
    { side: 'old', text: 'neutral', rows: [3] },
    { side: 'next', text: '/* open\nnew', rows: [0, 2] },
    { side: 'next', text: 'neutral', rows: [3] },
  ]);
  const adjacent = prepareFileToolCall({ ...edit(''), result: { details: { patch:
    '@@ -1,1 +1,1 @@\n /* open\n@@ -2,1 +2,1 @@\n */\n' } } })!;
  assert.deepEqual(adjacent.sources, [
    { side: 'old', text: '/* open\n*/', rows: [0, 1] },
    { side: 'next', text: '/* open\n*/', rows: [0, 1] },
  ], 'consecutive exact source positions prove actual continuity');
});

test('opposite-side changes neither enter a source nor break proven same-side continuity', () => {
  const plan = prepareFileToolCall(edit('-1 removed\n+1 added\n+2 extra\n 2 shared\n-3 removed_again\n+4 added_again'))!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: 'removed\nshared\nremoved_again', rows: [0, 3, 4] },
    { side: 'next', text: 'added\nextra\nshared\nadded_again', rows: [1, 2, 3, 5] },
  ]);
});

test('Created and Replaced use saved diff; Wrote and explicitly truncated diff use submitted source', () => {
  const created = prepareFileToolCall(write('not authoritative', { diff: '+1 first\tline\n+2 second' }))!;
  assert.equal(created.view.label, 'Created');
  assert.deepEqual(created.sources, [{ side: 'next', text: 'first\tline\nsecond', rows: [0, 1] }]);
  const replaced = prepareFileToolCall(write('ignored', { diff: '-1 old\n+1 new' }))!;
  assert.equal(replaced.view.label, 'Replaced');
  assert.deepEqual(replaced.sources.map(source => [source.side, source.text]), [['old', 'old'], ['next', 'new']]);
  const truncated = prepareFileToolCall(write('\twhole\ntext\n', { truncated: true, diff: '-1 incomplete' }))!;
  assert.equal(truncated.view.label, 'Wrote');
  assert.equal(truncated.sources[0]!.text, '\twhole\ntext\n');
  assert.equal(truncated.view.note, 'Diff truncated by tool; showing supplied content.');
  assert.equal(prepareFileToolCall(write('same', { noOp: true }))!.view.note, 'No changes.');
});

test('bounded saved previews count data overflow, validate genuine EOF and preserve selected diff surfaces', () => {
  const preview = (node: Parameters<typeof prepareFileToolCall>[0]) => prepareFileToolCall(node, false, 'preview');
  for (const count of [10, 11, 12]) {
    const context = Array.from({ length: count }, (_, index) => ` context_${index + 1}`).join('\n');
    const patch = `--- a/sample.ts\n+++ b/sample.ts\n@@ -1,${count} +1,${count} @@\n${context}`;
    const card = preview({ ...edit('ignored'), result: { details: { patch } } })!;
    assert.equal(card.view.preview, true);
    assert.equal(card.view.omitted, true, `${count} hidden data rows remain explicitly omitted despite file/hunk headers`);
    assert.equal(card.view.mode, 'diff');
    assert.ok(card.view.lines.length <= 10);
  }

  const multipleHunks = ['--- a/sample.ts', '+++ b/sample.ts', '@@ -1,2 +1,2 @@', ' keep_a', ' keep_b',
    '@@ -10,12 +10,12 @@', ...Array.from({ length: 12 }, (_, i) => ` keep_${i + 1}`)].join('\n');
  const multi = preview({ ...edit('ignored'), result: { details: { patch: multipleHunks } } })!;
  assert.equal(multi.view.omitted, true, 'multiple valid hunks preserve an explicit data-row overflow witness');
  assert.equal(multi.view.mode, 'diff');

  const carriageRows = preview(write('first carriage row\rsecond carriage row'))!;
  assert.deepEqual(carriageRows.view.lines.map(line => line.kind === 'gap' ? '' : line.logical), ['first carriage row', 'second carriage row'],
    'CR and CRLF normalization happens inside the bounded prefix before display cleaning can remove control characters');

  const malformedEof = preview({ ...edit('ignored'), result: { details: { patch: '@@ -1,2 +1,2 @@\n only_one_row' } } });
  assert.equal(malformedEof, undefined, 'a short fully inspected malformed hunk is not accepted as an artificial prefix');
  const cutHunk = preview({ ...edit('ignored'), result: { details: { patch:
    `@@ -1,12 +1,12 @@\n${Array.from({ length: 12 }, (_, i) => ` context_${i + 1}`).join('\n')}` } } })!;
  assert.equal(cutHunk.view.omitted, true);
  assert.equal(cutHunk.view.lines.length, 9, 'only complete selected data rows are retained');

  const savedContext = Array.from({ length: 10 }, (_, i) => ` context_${i + 1}`).join('\n');
  const sourceWinsOnlyWhenMetadataIsAbsent = preview({ ...write('UNRELATED_ARGUMENT_SOURCE'), result: { details: {
    diff: `@@ -1,12 +1,12 @@\n${savedContext}\n-old_later\n+new_later` } } })!;
  assert.equal(sourceWinsOnlyWhenMetadataIsAbsent.view.mode, 'diff');
  assert.equal(sourceWinsOnlyWhenMetadataIsAbsent.view.label, 'Write');
  assert.doesNotMatch(sourceWinsOnlyWhenMetadataIsAbsent.view.lines.map(line => line.kind === 'gap' ? '' : line.logical).join('\n'), /UNRELATED_ARGUMENT_SOURCE/u);
  const added = preview({ ...write('UNRELATED_ARGUMENT_SOURCE'), result: { details: { patch:
    '@@ -1,1 +1,2 @@\n context\n+added_source' } } })!;
  assert.equal(added.view.mode, 'diff', 'a prefix containing only context/additions is not whole-patch Created classification');
  assert.deepEqual(added.view.lines.map(line => line.kind), [' ', '+']);
  assert.equal(preview({ ...write('source'), result: { details: { patch: 7 } } }), undefined, 'unsupported selected metadata stays native');

  const unicode = '名\t👩‍👩‍👧‍👦';
  const crlf = prepareFileToolCall(write(`${Array.from({ length: 9 }, (_, i) => `line_${i}`).join('\r\n')}\r\n\x1b[31m${unicode}\x1b[0m\r\nHIDDEN`), true, 'preview')!;
  assert.equal(crlf.view.lines.length, 10);
  assert.equal(crlf.view.lines[9]!.kind === 'gap' ? '' : crlf.view.lines[9]!.text, unicode, 'CRLF, tabs, graphemes and terminal-control cleaning survive the exact row cut');
  assert.equal(crlf.view.omitted, true);
  const longFirstLine = preview({ ...write('x'.repeat(8193) + '\nVISIBLE_SUFFIX') })!;
  assert.deepEqual(longFirstLine.view.lines, [], 'a single over-window row is omitted whole rather than sliced into a false code row');
  assert.equal(longFirstLine.view.omitted, true);
});

test('unsupported metadata, incomplete/failed write and failed edit never create parser sources', () => {
  assert.equal(prepareFileToolCall(write('proposal', { diff: 'not supported' })), undefined);
  assert.equal(prepareFileToolCall({ ...write('proposal'), isPartial: true }), undefined);
  assert.equal(prepareFileToolCall({ toolName: 'write', args: { path: 'sample.ts', content: 'proposal' }, isPartial: false }), undefined);
  assert.equal(prepareFileToolCall({ ...write('proposal'), result: { isError: true } }), undefined);
  let reads = 0;
  const details = { get diff(): string { reads++; throw new Error('stale metadata'); } };
  const failed = prepareFileToolCall({ ...edit(''), result: { isError: true, details } })!;
  assert.equal(failed.view.mode, 'inline');
  assert.deepEqual(failed.sources, []);
  assert.equal(reads, 0, 'never inspect stale source on final failure');
  assert.equal(prepareFileToolCall({ ...edit(''), args: { path: '' } }), undefined);
  assert.equal(prepareFileToolCall({ ...edit(''), result: { details: { patch: '@@ -1,2 +1,1 @@\n-old\n+new' } } }), undefined);
});

test('source sanitization matches display policy without changing joining marks, tabs or malformed Unicode', () => {
  const text = '\x1b[31mconst\x1b[0m\t名 = "👩‍👩‍👧‍👦";\u202e\u0007\n\ud800';
  const plan = prepareFileToolCall(write(text))!;
  assert.equal(plan.sources[0]!.text, 'const\t名 = "👩‍👩‍👧‍👦";\n\ud800');
  assert.equal(plan.sources[0]!.text, stripVTControlCharacters(plan.sources[0]!.text));
  assert.equal(plan.view.lines[0]!.kind === 'gap' ? '' : plan.view.lines[0]!.text, 'const   名 = "👩‍👩‍👧‍👦";');
});

test('Bash parser source excludes prompt/description/cwd/output, keeps tabs, normalized endings and exact args', () => {
  const args = { command: '\x1b[32mecho\x1b[0m\t"👩‍👩‍👧‍👦"\r\nprintf done\r', description: 'synthetic description', workdir: '/synthetic/path' };
  const before = JSON.stringify(args);
  assert.equal(bashToolReaderFixture({ args }).command(), 'echo\t"👩‍👩‍👧‍👦"\nprintf done\n');
  assert.equal(bashToolReaderFixture({ args: { command: '' } }).command(), '');
  assert.equal(bashToolReaderFixture({ args: { command: 3 } }).command(), undefined);
  assert.equal(bashToolReaderFixture({ args: { description: 'not source' } }).command(), undefined);
  assert.equal(JSON.stringify(args), before);
  const node = { args, expanded: false, isPartial: false, result: { content: [{ type: 'text', text: 'unrelated output' }] } };
  const rows = renderBashCard(node, args.workdir, 80, theme).rows.map(stripVTControlCharacters).join('\n');
  assert.ok(rows.includes('$ echo  "👩‍👩‍👧‍👦"'), 'existing prompt-aware tab stops remain unchanged');
  assert.ok(rows.includes('unrelated output'));
});

test('preparing both file sides leaves baseline plain geometry unchanged and never mutates the caller', () => {
  const node = edit(' 1 \tcontext\n-2 \tbefore\n+2 \tafter\n 3 end');
  const original = JSON.stringify(node);
  const before = [80, 140].map(width => renderFileCard(node, undefined, width, theme)!.rows);
  const prepared = prepareFileToolCall(node)!;
  assert.equal(prepared.sources[0]!.text, '\tcontext\n\tbefore\nend');
  assert.equal(prepared.sources[1]!.text, '\tcontext\n\tafter\nend');
  assert.deepEqual([80, 140].map(width => renderFileCard(node, undefined, width, theme)!.rows), before);
  assert.equal(JSON.stringify(node), original);
});

test('file preparation derives source hints only from authoritative first-line coordinates', () => {
  const wrote = prepareFileToolCall(write('#!/usr/bin/env python3\nprint(1)'))!;
  assert.deepEqual(wrote.sources, [{ side: 'next', text: '#!/usr/bin/env python3\nprint(1)', rows: [0, 1], languageHint: 'python' }]);

  const changed = prepareFileToolCall(edit('-1 #!/usr/bin/python3\n+1 #!/usr/bin/env bash\n 2 print(1)'))!;
  assert.deepEqual(changed.sources.map(({ side, languageHint }) => [side, languageHint]), [['old', 'python'], ['next', 'bash']]);

  const oldOnly = prepareFileToolCall(edit('-1 #!/usr/bin/python3\n+1 ordinary text\n 2 print(1)'))!;
  assert.deepEqual(oldOnly.sources.map(({ side, languageHint }) => [side, languageHint]), [['old', 'python'], ['next', 'python']]);

  const nextOnly = prepareFileToolCall(edit('-1 ordinary text\n+1 #!/usr/bin/env bash\n 2 print(1)'))!;
  assert.deepEqual(nextOnly.sources.map(({ side, languageHint }) => [side, languageHint]), [['old', 'bash'], ['next', 'bash']]);

  const unrecognizedOld = prepareFileToolCall(
    edit('-1 #!/usr/bin/custom-runtime\n+1 #!/usr/bin/python3\n 2 print(1)'),
  )!;
  assert.deepEqual(
    unrecognizedOld.sources.map(({ side, languageHint }) => [side, languageHint]),
    [['old', 'python'], ['next', 'python']],
    'an unrecognized shebang is treated as an absent candidate for one-sided inheritance',
  );

  const missingOldFirst = prepareFileToolCall(edit('@@ -8,2 +1,2 @@\n-old line\n+#!/usr/bin/bash\n context'))!;
  assert.deepEqual(missingOldFirst.sources.map(({ side, languageHint }) => [side, languageHint]), [['old', 'bash'], ['next', 'bash']],
    'a detected next shebang is inherited even when old coordinate one is absent');

  const later = prepareFileToolCall(edit('-1 #!/usr/bin/python3\n+1 #!/usr/bin/env python3\n 2 context\n ...\n-80 old tail\n+80 new tail'))!;
  assert.ok(later.sources.length > 2, 'the first and later hunks form separate source fragments');
  assert.ok(later.sources.every(source => source.languageHint === 'python'), 'first-line hint propagates across omitted ranges');
  const notFirst = prepareFileToolCall(edit(' 8 #!/usr/bin/bash\n-9 old\n+9 new'))!;
  assert.ok(notFirst.sources.every(source => source.languageHint === undefined), 'a later hunk row is not the file first line');

  const contextual = prepareFileToolCall(edit(' 1 #!/usr/bin/python3\n-2 print(1)\n+2 print(2)'))!;
  assert.deepEqual(contextual.sources.map(({ side, languageHint }) => [side, languageHint]), [['old', 'python'], ['next', 'python']],
    'an unchanged first-line shebang is authoritative for both versions');
  const prototypeAlias = prepareFileToolCall(write('#!/usr/bin/env constructor\nbody'))!;
  assert.equal(prototypeAlias.sources[0]!.languageHint, undefined, 'inherited object properties are not interpreter aliases');

  const cleaned = prepareFileToolCall(edit(' 1 \u001b[31m#!/usr/bin/bash\n 2 print(1)'))!;
  assert.equal(cleaned.sources[0]!.text, '#!/usr/bin/bash\nprint(1)', 'presentation removes terminal controls');
  assert.equal(cleaned.sources[0]!.languageHint, undefined, 'recognition precedes display cleaning');
});
