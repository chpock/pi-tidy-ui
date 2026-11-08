import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { marked } from 'marked';
import { parseDocument } from 'yaml';
import { transform } from 'esbuild';
import { loadFixtures } from '../../../scripts/highlight-compare/fixtures.mjs';
import { discoverEntries } from '../../../scripts/test/catalog.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../../fixtures/highlight-compare/', import.meta.url));
const corpus = loadFixtures(fixtureRoot).fixtures.filter(fixture => fixture.kind === 'source');
const source = id => {
  const fixture = corpus.find(entry => entry.id === id);
  assert.ok(fixture, `fixture ${id} is in the maintained corpus`);
  return fixture;
};
const tokensDeep = tokens => tokens.flatMap(token => [token,
  ...(token.tokens ? tokensDeep(token.tokens) : []), ...(token.items ? tokensDeep(token.items) : [])]);

test('strict JSON source parses as RFC 8259 data with escaped Unicode, numeric and scalar witnesses', () => {
  const fixture = source('json-core');
  const value = JSON.parse(fixture.content);
  assert.equal(value.unicode, 'café, snowman ☃, rocket 🚀');
  assert.equal(value.escaped, 'quote: " slash: \\ newline: \n tab: \t');
  assert.deepEqual(value.numbers, [0, -0, 42, 1.25, 100]);
  assert.deepEqual(value.flags, [true, false, null]);
  assert.deepEqual(value.nested.items.map(item => item.enabled), [true, false]);
  for (const invalid of ['{"value":1,}', '{/* comment */"value":1}', "{'value':1}"]) {
    assert.throws(() => JSON.parse(invalid), SyntaxError);
  }
});

test('YAML source uses version 1.2 Core semantics, aliases, explicit tags and unique mapping keys', () => {
  const options = { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, customTags: [] };
  const document = parseDocument(source('yaml-core').content, options);
  assert.deepEqual(document.errors, []);
  const value = document.toJS();
  assert.equal(value.defaults.active, true);
  assert.equal(value.defaults.nested.hexadecimal, 42);
  assert.equal(value.defaults.nested.octal, 42);
  assert.equal(value.defaults.nested['plain-yes'], 'yes');
  assert.equal(value.defaults.labels[2], "single'quote");
  assert.strictEqual(value.copy, value.defaults);
  assert.equal(value['standard-tag'], 'false');
  assert.equal(value['handle-tag'], '0042');
  assert.equal(value['block-scalars']['literal-clip'], 'first line\nsecond line\n');
  assert.equal(value['block-scalars']['literal-strip'], 'no final line');
  assert.equal(value['block-scalars']['folded-keep'], 'wrapped prose\n');
  assert.ok(parseDocument('key: first\nkey: second\n', options).errors.length > 0, 'duplicate keys are rejected');
  assert.equal(parseDocument('value: yes\n', options).toJS().value, 'yes', 'YAML 1.2 Core does not apply YAML 1.1 boolean spelling');
});

test('CommonMark 0.31.2 and GFM 0.29-gfm specimens provide distinct parser-token witnesses', () => {
  const commonmark = tokensDeep(marked.lexer(source('markdown-commonmark-0.31.2').content, { gfm: false }));
  assert.ok(commonmark.some(token => token.type === 'heading'));
  assert.ok(commonmark.some(token => token.type === 'blockquote'));
  assert.ok(commonmark.some(token => token.type === 'code'));
  assert.ok(commonmark.some(token => token.type === 'html'));
  assert.ok(commonmark.some(token => token.type === 'link' && token.href === '#sections'));
  assert.ok(commonmark.some(token => token.type === 'image' && token.href === '../diagram.svg'));
  assert.ok(commonmark.some(token => token.type === 'codespan' && token.text.includes('ticks')));
  assert.ok(commonmark.some(token => token.type === 'code' && token.text.includes('Indented code block')));
  const commonmarkFixture = source('markdown-commonmark-0.31.2');
  const breakCase = commonmarkFixture.cases.find(entry => entry.features.includes('hard-line-break'));
  assert.ok(breakCase);
  const breakSource = commonmarkFixture.content.split(/\r\n|\n|\r/u).slice(breakCase.startLine - 1, breakCase.endLine).join('\n');
  const breakTokens = tokensDeep(marked.lexer(breakSource, { gfm: false }));
  assert.equal(breakCase.features.includes('hard-line-break'), breakTokens.some(token => token.type === 'br'));
  assert.equal(breakCase.features.includes('soft-line-break'),
    breakTokens.some(token => token.type === 'text' && token.raw.includes('\n')));
  const gfm = tokensDeep(marked.lexer(source('markdown-gfm-0.29-gfm').content, { gfm: true }));
  assert.ok(gfm.some(token => token.type === 'table'));
  assert.ok(gfm.some(token => token.type === 'del'));
  assert.ok(gfm.some(token => token.type === 'list_item' && token.task === true));
  assert.ok(gfm.some(token => token.type === 'link' && token.href === 'https://example.invalid/bare-guide'), 'GFM bare URL uses its extended autolink syntax');
  for (const fixture of corpus.filter(entry => entry.language === 'markdown')) {
    const tokens = marked.lexer(fixture.content, { gfm: fixture.id === 'markdown-gfm-0.29-gfm' });
    const ranges = fixture.cases.filter(entry => entry.features.includes('fenced-code-block'))
      .map(entry => fixture.content.split(/\r\n|\n|\r/u).slice(entry.startLine - 1, entry.endLine).join('\n'));
    for (const token of tokens.filter(entry => entry.type === 'code' && entry.lang)) {
      assert.ok(ranges.some(range => range.includes(token.raw.trimEnd())),
        `${fixture.id}: declared fenced-code range contains its complete source token`);
    }
  }
});

test('JavaScript module fixture passes Node syntax checking without module evaluation', () => {
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source('javascript-es2024').content, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('TypeScript syntax stays positive while fixture data is excluded from the project program and test catalogue', () => {
  const fixtures = corpus.filter(fixture => fixture.language === 'typescript');
  assert.ok(fixtures.length > 0);
  for (const fixture of fixtures) {
    const parsed = ts.createSourceFile(fixture.filename, fixture.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.deepEqual(parsed.parseDiagnostics, [], `${fixture.id} has no TypeScript syntax diagnostics`);
  }

  const configPath = `${repository}/tsconfig.json`;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, repository);
  assert.deepEqual(parsedConfig.errors, []);
  assert.equal(parsedConfig.options.erasableSyntaxOnly, true);
  const programFiles = new Set(parsedConfig.fileNames.map(file => relative(repository, file).split(sep).join('/')));
  assert.ok(programFiles.has('src/index.ts'), 'product source remains in the strict program');
  assert.ok(programFiles.has('tests/product/lifecycle/naming.test.ts'), 'real TypeScript tests remain in the strict program');
  assert.ok(![...programFiles].some(file => file.startsWith('tests/fixtures/highlight-compare/')),
    'polyglot source data is excluded without weakening project compiler options');

  const entries = discoverEntries(repository);
  assert.ok(entries.some(entry => entry.file === 'harness/highlight-compare/language-semantics.test.mjs'));
  assert.ok(!entries.some(entry => entry.file.startsWith('fixtures/highlight-compare/')),
    'the real test catalogue never discovers fixture source data as executable tests');
  assert.ok(entries.some(entry => entry.file === 'product/lifecycle/naming.test.ts'));
});

test('CSS source transforms without minification or parser warnings', async () => {
  const result = await transform(source('css-modules-2021').content, { loader: 'css', minify: false });
  assert.ok(result.code.length > 0);
  assert.deepEqual(result.warnings, []);
});
