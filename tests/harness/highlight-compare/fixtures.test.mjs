import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures, prepareDiff, diffRows } from '../../../scripts/highlight-compare/fixtures.mjs';
import { toolPath } from '../../../scripts/test/context.mjs';

const root = fileURLToPath(new URL('../../fixtures/highlight-compare/', import.meta.url));

test('comparison corpus accepts versioned IDs and retains explicit modern syntax and terminal controls', () => {
  const corpus = loadFixtures(root);
  assert.ok(corpus.fixtures.some(fixture => fixture.id === 'python-3.14' && fixture.version === '3.14'));
  const projection = corpus.fixtures.find(fixture => fixture.id === 'python-projection');
  assert.ok(projection.content.includes('\t'));
  assert.ok(projection.content.includes('界') && projection.content.includes('é'));
  const features = corpus.fixtures.filter(fixture => fixture.kind === 'source').flatMap(fixture => fixture.cases.flatMap(entry => entry.features));
  for (const feature of ['except-star', 't-string', 'soft-keywords-as-identifiers', 'type-parameter-default', 'async-with']) assert.ok(features.includes(feature), `declared coverage for ${feature}`);
});

test('comparison diffs reconstruct original old/new text and preserve independent blank/multidigit role witnesses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-diff-'));
  try {
    for (const fixture of loadFixtures(root).fixtures.filter(value => value.kind === 'diff')) {
      const prepared = prepareDiff(fixture, join(directory, fixture.id), toolPath('git'), process.env);
      assert.ok(prepared.logicalRows.some(row => row.text === '' && ['added', 'removed'].includes(row.role)));
      assert.ok(prepared.patch.includes('@@'));
      assert.throws(() => diffRows(prepared.patch.replace('inserted', 'corrupted').replace('old heading', 'corrupted'), fixture.before, fixture.after), /reconstruction/i);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('comparison fixture boundaries reject traversal and invalid feature ranges', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-manifest-'));
  const fixture = { id: 'example', language: 'python', version: '3.14', path: 'specimen.py', cases: [{ id: 'one', features: ['comment'], startLine: 1, endLine: 1 }] };
  const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema: 1, languages: [fixture], diffs: [] }));
  try {
    writeFileSync(join(directory, 'specimen.py'), '# test\n'); save();
    assert.equal(loadFixtures(directory).fixtures.length, 1);
    fixture.path = '../specimen.py'; save();
    assert.throws(() => loadFixtures(directory), /relative path/i);
    fixture.path = 'specimen.py'; fixture.cases[0].endLine = 2; save();
    assert.throws(() => loadFixtures(directory), /feature range/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native diff projection preserves CRLF source coordinates without treating line endings as visible text', () => {
  const rows = diffRows('@@ -1,2 +1,2 @@\n alpha\r\n-old\r\n+new\r\n', 'alpha\r\nold\r\n', 'alpha\r\nnew\r\n');
  assert.deepEqual(rows, [
    { role: 'context', text: 'alpha', oldLine: 1, newLine: 1 },
    { role: 'removed', text: 'old', oldLine: 2 },
    { role: 'added', text: 'new', newLine: 2 },
  ]);
});

test('diff hunk reconstruction preserves exact whole-file identity without requiring unchanged file margins on screen', () => {
  const before = 'prefix\ncontext\nold\nshared\ntail\n', after = 'prefix\ncontext\nnew\nshared\ntail\n';
  const patch = '@@ -2,3 +2,3 @@\n context\n-old\n+new\n shared\n';
  assert.deepEqual(diffRows(patch, before, after), [
    { role: 'context', oldLine: 2, newLine: 2, text: 'context' },
    { role: 'removed', oldLine: 3, text: 'old' }, { role: 'added', newLine: 3, text: 'new' },
    { role: 'context', oldLine: 4, newLine: 4, text: 'shared' },
  ]);
  assert.throws(() => diffRows(patch, before, after.replace('prefix', 'changed')), /reconstruction/);
  assert.throws(() => diffRows(patch.replace('-2,3', '-2,2'), before, after), /count|invalid|Unknown/i);
});

test('the neutral mixed hunk retains three context rows and every declared surface witness', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-context-'));
  try {
    const fixture = loadFixtures(root).fixtures.find(value => value.id === 'mixed-replacement-and-blank-removal');
    const prepared = prepareDiff(fixture, join(directory, 'patch'), toolPath('git'), process.env);
    assert.deepEqual(prepared.logicalRows[0], { role: 'context', oldLine: 7, newLine: 7, text: 'context 07' });
    assert.equal(prepared.logicalRows.at(-1).text, 'context 17');
    assert.equal(prepared.before, fixture.before);
    assert.equal(prepared.after, fixture.after);
    for (const sample of fixture.roleSamples) assert.ok(prepared.logicalRows.some(row =>
      row.role === sample.role && row.oldLine === sample.oldLine && row.newLine === sample.newLine && row.text === sample.text));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the comparison corpus declares the requested language inputs as bounded source data with concrete feature ranges', () => {
  const sources = loadFixtures(root).fixtures.filter(fixture => fixture.kind === 'source');
  const requiredFeatures = {
    markdown: ['inline-link', 'image', 'code-span-multiple-backticks', 'indented-code-block', 'gfm-extended-bare-url-autolink'],
    go: ['receiver-method', 'channel-directions', 'channel-receive', 'channel-send', 'defer', 'select-statement', 'main-function'],
    rust: ['await-expression', 'question-mark-operator', 'let-else'],
    typescript: ['block-comment', 'line-comment', 'keyword-looking-string'],
    javascript: ['block-comment', 'line-comment', 'keyword-looking-string', 'bigint-literal', 'await-expression', 'arrow-function'],
    bash: ['arithmetic-expansion', 'arithmetic-command', 'brace-expansion', 'pathname-expansion', 'output-redirection'],
  };
  for (const language of ['markdown', 'json', 'yaml', 'go', 'cpp', 'rust', 'typescript', 'javascript', 'bash', 'html', 'css']) {
    const fixtures = sources.filter(fixture => fixture.language === language);
    assert.ok(fixtures.length > 0, `missing requested language: ${language}`);
    const features = new Set(fixtures.flatMap(fixture => fixture.cases.flatMap(entry => entry.features)));
    for (const feature of requiredFeatures[language] ?? []) {
      assert.ok(features.has(feature), `${language}: missing requested syntax witness ${feature}`);
    }
    for (const fixture of fixtures) {
      assert.ok(fixture.version.trim(), `${fixture.id}: declared language version or dialect`);
      const lines = fixture.content.split(/\r\n|\n|\r/u);
      for (const entry of fixture.cases) {
        assert.ok(entry.title?.trim(), `${fixture.id}/${entry.id}: readable construct label`);
        assert.ok(lines.slice(entry.startLine - 1, entry.endLine).some(line => line.trim()), `${fixture.id}/${entry.id}: nonempty source context`);
      }
    }
  }
});
