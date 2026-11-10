import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { filePreviewText } from '../../../src/cards/file-input.ts';
import { fileToolReaderFixture } from '../../fixtures/tool-adapters/reader-fixture.ts';

type Shape = 'content' | 'truncated' | 'numbered' | 'unified';
const shapes: readonly Shape[] = ['content', 'truncated', 'numbered', 'unified'];
const python = '#!/usr/bin/python3', bash = '#!/bin/bash', body = 'print(1)';
function reader(shape: Shape, first: string, next = first) {
  const content = `${first}\n${body}`;
  const details = shape === 'truncated' ? { truncated: true }
    : shape === 'numbered' ? { diff: `-1 ${first}\n+1 ${next}\n 2 ${body}` }
      : shape === 'unified' ? { patch: `@@ -1,2 +1,2 @@\n-${first}\n+${next}\n ${body}` } : undefined;
  return fileToolReaderFixture({ name: shape === 'numbered' || shape === 'unified' ? 'edit' : 'write',
    args: { path: 'script.txt', content }, result: { content: [], details } });
}

const candidates = [
  { label: 'valid', original: python, hint: 'python' },
  { label: 'ANSI prefix', original: `\u001b[31m${python}`, hint: undefined },
  { label: 'ANSI suffix', original: `${python}\u001b[0m`, hint: undefined },
  { label: 'embedded NUL', original: '#!/usr/bin/py\u0000thon3', hint: undefined },
  { label: 'C1 control', original: `${python}\u0085`, hint: undefined },
] as const;
for (const shape of shapes) for (const candidate of candidates) test(`preview original-row hint: ${shape}, ${candidate.label}`, () => {
  const input = reader(shape, candidate.original), full = input.prepareFile('full')!, preview = input.prepareFile('preview')!;
  const count = shape === 'content' || shape === 'truncated' ? 1 : 2;
  assert.equal(full.sources.length, count);
  assert.equal(preview.sources.length, count);
  assert.deepEqual(full.sources.map(source => source.languageHint), Array(count).fill(candidate.hint));
  assert.deepEqual(preview.sources.map(source => source.languageHint), Array(count).fill(candidate.hint),
    'preview recognizes the original source row, not a shebang manufactured by deleting controls');
  assert.deepEqual(preview.sources.map(source => source.text), Array(count).fill(`${python}\n${body}`),
    'the displayed/parser source still removes unsafe controls');
});

for (const shape of ['numbered', 'unified'] as const) for (const sides of [
  { label: 'old only', old: python, next: `\u001b[31m${bash}`, expected: ['python', 'python'] },
  { label: 'next only', old: `\u001b[31m${python}`, next: bash, expected: ['bash', 'bash'] },
  { label: 'independent', old: python, next: bash, expected: ['python', 'bash'] },
  { label: 'neither', old: `\u001b[31m${python}`, next: `\u001b[31m${bash}`, expected: [undefined, undefined] },
]) test(`preview first-side provenance: ${shape}, ${sides.label}`, () => {
  const input = reader(shape, sides.old, sides.next);
  for (const mode of ['full', 'preview'] as const) {
    const sources = input.prepareFile(mode)!.sources;
    assert.deepEqual(sources.map(source => source.side), ['old', 'next']);
    assert.deepEqual(sources.map(source => source.languageHint), sides.expected, `${mode}: only original coordinate-one rows select hints`);
  }
});

for (const shape of shapes) test(`preview source identity observes raw hint validity with equal cleaned text: ${shape}`, () => {
  const valid = reader(shape, python), invalid = reader(shape, `\u001b[31m${python}`);
  assert.deepEqual(valid.prepareFile('preview')!.sources.map(source => source.text), invalid.prepareFile('preview')!.sources.map(source => source.text));
  assert.notDeepEqual(valid.source('preview'), invalid.source('preview'),
    'the host must refresh the selector even when deletion of controls leaves the same visible source');
});

for (const shape of shapes) test(`preview construction accounts for the retained raw prefix: ${shape}`, () => {
  const decorated = `\u001b[31m`.repeat(1200) + python;
  const plain = 'x'.repeat(decorated.length);
  assert.equal(reader(shape, decorated).estimateBytes({ mode: 'preview' }), reader(shape, plain).estimateBytes({ mode: 'preview' }),
    'equal raw prefix units and source rows use the same existing construction allowance');
});

for (const ending of ['\n', '\r\n', '\r']) test(`preview first-row byte boundary and normalized EOL ${JSON.stringify(ending)}`, () => {
  const prefix = `${python} `;
  for (const [bytes, expected] of [[1024, 'python'], [1025, undefined]] as const) {
    const first = prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix));
    const input = fileToolReaderFixture({ name: 'write', args: { path: 'script.txt', content: `${first}${ending}${body}` }, result: { content: [] } });
    for (const mode of ['full', 'preview'] as const) assert.equal(input.prepareFile(mode)!.sources[0]!.languageHint, expected);
  }
});

for (const saved of [
  { label: 'unified', patch: '\u001b[31m@@ -1,1 +1,1 @@\n-old\n+new' },
  { label: 'numbered', diff: '\u001b[31m-1 old\n+1 new' },
]) test(`preview does not manufacture a valid ${saved.label} envelope by deleting controls`, () => {
  const input = fileToolReaderFixture({ name: 'edit', args: { path: 'script.txt' }, result: { content: [], details: saved } });
  assert.equal(input.prepareFile('full'), undefined, 'the original saved envelope is unsupported');
  assert.equal(input.prepareFile('preview'), undefined, 'preview uses that same raw envelope grammar');
});

for (const patch of [false, true]) test(`preview preserves physical source rows across multiline terminal sequences, patch=${patch}`, () => {
  const first = `${python}\u001b]8;;hidden`, second = 'ESCAPE_BODY\u0007';
  const input = fileToolReaderFixture(patch
    ? { name: 'edit', args: { path: 'script.txt' }, result: { content: [], details: { patch: `@@ -1,3 +1,3 @@\n ${first}\n ${second}\n ${body}` } } }
    : { name: 'write', args: { path: 'script.txt', content: `${first}\n${second}\n${body}` }, result: { content: [] } });
  const full = input.prepareFile('full')!, preview = input.prepareFile('preview');
  assert.equal(full.view.lines.length, 3);
  assert.ok(preview, 'cleaning cannot erase physical patch rows before count validation');
  assert.deepEqual(preview.view.lines, full.view.lines, 'preview decodes the same three original source rows as full');
  assert.deepEqual(preview.sources, full.sources);
  assert.ok(preview.sources.every(source => source.languageHint === undefined), 'the original first row contains a control');
});

test('pending display excerpts retain their existing whole-prefix terminal cleaning', () => {
  const source = `${python}\u001b]8;;hidden\nESCAPE_BODY\u0007\n${body}`;
  assert.deepEqual(filePreviewText(source), { text: `${python}\n${body}`, omitted: false });
});
