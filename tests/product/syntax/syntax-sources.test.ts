import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFileCard } from '../../../src/file-card.ts';
import { fileCardFixture as renderFileCard, bashCardFixture as renderBashCard } from '../../fixtures/prepared-card.ts';
import { bashCommandSource } from '../../../src/bash-card.ts';
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
test('file preparation keeps parser tabs and exact normalized endings separate from display cells', () => {
  const node = write('\tconst 名 = 1;\r\n\t\tvalue();\r');
  const saved = JSON.stringify(node), plan = prepareFileCard(node)!;
  assert.equal(plan.path, 'sample.ts');
  assert.equal(plan.view.label, 'Wrote');
  assert.equal(plan.view.mode, 'code');
  assert.deepEqual(plan.sources, [{ side: 'next', text: '\tconst 名 = 1;\n\t\tvalue();\n', rows: [0, 1, 2] }]);
  assert.deepEqual(plan.view.lines.map(row => row.kind === 'gap' ? '' : row.text), ['    const 名 = 1;', '        value();', '']);
  assert.equal(JSON.stringify(node), saved, 'args, results and session-owned bytes stay untouched');
  assert.equal(prepareFileCard(write('const a = 1;'))!.sources[0]!.text, 'const a = 1;', 'no fabricated final newline');
  assert.deepEqual(prepareFileCard(write(''))!.sources, [], 'empty visible source requires no parser work');
});

test('numbered saved diff separates old/new sources before any display context reduction', () => {
  const node = edit(' 1 /* open\n 2 hidden_a\n 3 hidden_b\n 4 hidden_c\n-5 old\tname\n+5 new\tname\n 6 */');
  const plan = prepareFileCard(node)!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: '/* open\nhidden_a\nhidden_b\nhidden_c\nold\tname\n*/', rows: [0, 1, 2, 3, 4, 6] },
    { side: 'next', text: '/* open\nhidden_a\nhidden_b\nhidden_c\nnew\tname\n*/', rows: [0, 1, 2, 3, 5, 6] },
  ]);
  assert.ok(plan.view.lines.some(row => row.kind !== 'gap' && row.text === '/* open'), 'all supplied context stays available to parser');
});

test('explicit omissions and line-number gaps are hard parser boundaries on each diff side', () => {
  const plan = prepareFileCard(edit(' 1 /* open\n-2 old\n+2 new\n  ...\n 9 neutral\n-10 before\n+10 after\n 12 another'))!;
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
  const plan = prepareFileCard({ ...edit('ignored'), result: { details: { patch:
    '--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,2 @@\n /* open\n-old\n+new\n@@ -8,1 +8,1 @@\n neutral\n' } } })!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: '/* open\nold', rows: [0, 1] },
    { side: 'old', text: 'neutral', rows: [3] },
    { side: 'next', text: '/* open\nnew', rows: [0, 2] },
    { side: 'next', text: 'neutral', rows: [3] },
  ]);
  const adjacent = prepareFileCard({ ...edit(''), result: { details: { patch:
    '@@ -1,1 +1,1 @@\n /* open\n@@ -2,1 +2,1 @@\n */\n' } } })!;
  assert.deepEqual(adjacent.sources, [
    { side: 'old', text: '/* open\n*/', rows: [0, 1] },
    { side: 'next', text: '/* open\n*/', rows: [0, 1] },
  ], 'consecutive exact source positions prove actual continuity');
});

test('opposite-side changes neither enter a source nor break proven same-side continuity', () => {
  const plan = prepareFileCard(edit('-1 removed\n+1 added\n+2 extra\n 2 shared\n-3 removed_again\n+4 added_again'))!;
  assert.deepEqual(plan.sources, [
    { side: 'old', text: 'removed\nshared\nremoved_again', rows: [0, 3, 4] },
    { side: 'next', text: 'added\nextra\nshared\nadded_again', rows: [1, 2, 3, 5] },
  ]);
});

test('Created and Replaced use saved diff; Wrote and explicitly truncated diff use submitted source', () => {
  const created = prepareFileCard(write('not authoritative', { diff: '+1 first\tline\n+2 second' }))!;
  assert.equal(created.view.label, 'Created');
  assert.deepEqual(created.sources, [{ side: 'next', text: 'first\tline\nsecond', rows: [0, 1] }]);
  const replaced = prepareFileCard(write('ignored', { diff: '-1 old\n+1 new' }))!;
  assert.equal(replaced.view.label, 'Replaced');
  assert.deepEqual(replaced.sources.map(source => [source.side, source.text]), [['old', 'old'], ['next', 'new']]);
  const truncated = prepareFileCard(write('\twhole\ntext\n', { truncated: true, diff: '-1 incomplete' }))!;
  assert.equal(truncated.view.label, 'Wrote');
  assert.equal(truncated.sources[0]!.text, '\twhole\ntext\n');
  assert.equal(truncated.view.note, 'Diff truncated by tool; showing supplied content.');
  assert.equal(prepareFileCard(write('same', { noOp: true }))!.view.note, 'No changes.');
});

test('unsupported metadata, incomplete/failed write and failed edit never create parser sources', () => {
  assert.equal(prepareFileCard(write('proposal', { diff: 'not supported' })), undefined);
  assert.equal(prepareFileCard({ ...write('proposal'), isPartial: true }), undefined);
  assert.equal(prepareFileCard({ toolName: 'write', args: { path: 'sample.ts', content: 'proposal' }, isPartial: false }), undefined);
  assert.equal(prepareFileCard({ ...write('proposal'), result: { isError: true } }), undefined);
  let reads = 0;
  const details = { get diff(): string { reads++; throw new Error('stale metadata'); } };
  const failed = prepareFileCard({ ...edit(''), result: { isError: true, details } })!;
  assert.equal(failed.view.mode, 'inline');
  assert.deepEqual(failed.sources, []);
  assert.equal(reads, 0, 'never inspect stale source on final failure');
  assert.equal(prepareFileCard({ ...edit(''), args: { path: '' } }), undefined);
  assert.equal(prepareFileCard({ ...edit(''), result: { details: { patch: '@@ -1,2 +1,1 @@\n-old\n+new' } } }), undefined);
});

test('source sanitization matches display policy without changing joining marks, tabs or malformed Unicode', () => {
  const text = '\x1b[31mconst\x1b[0m\t名 = "👩‍👩‍👧‍👦";\u202e\u0007\n\ud800';
  const plan = prepareFileCard(write(text))!;
  assert.equal(plan.sources[0]!.text, 'const\t名 = "👩‍👩‍👧‍👦";\n\ud800');
  assert.equal(plan.sources[0]!.text, stripVTControlCharacters(plan.sources[0]!.text));
  assert.equal(plan.view.lines[0]!.kind === 'gap' ? '' : plan.view.lines[0]!.text, 'const   名 = "👩‍👩‍👧‍👦";');
});

test('Bash parser source excludes prompt/description/cwd/output, keeps tabs, normalized endings and exact args', () => {
  const args = { command: '\x1b[32mecho\x1b[0m\t"👩‍👩‍👧‍👦"\r\nprintf done\r', description: 'synthetic description', workdir: '/synthetic/path' };
  const before = JSON.stringify(args);
  assert.equal(bashCommandSource(args), 'echo\t"👩‍👩‍👧‍👦"\nprintf done\n');
  assert.equal(bashCommandSource({ command: '' }), '');
  assert.equal(bashCommandSource({ command: 3 }), undefined);
  assert.equal(bashCommandSource({ description: 'not source' }), undefined);
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
  const prepared = prepareFileCard(node)!;
  assert.equal(prepared.sources[0]!.text, '\tcontext\n\tbefore\nend');
  assert.equal(prepared.sources[1]!.text, '\tcontext\n\tafter\nend');
  assert.deepEqual([80, 140].map(width => renderFileCard(node, undefined, width, theme)!.rows), before);
  assert.equal(JSON.stringify(node), original);
});
