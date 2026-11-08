import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adapters } from '../../../scripts/highlight-compare/adapters/index.mjs';
import { execute } from '../../../scripts/highlight-compare/capture.mjs';
import { digest, logicalLines } from '../../../scripts/highlight-compare/model.mjs';
import { mapOpenCodeDiff } from '../../../scripts/highlight-compare/adapters/opencode-diff.mjs';

function reference(fixture, readiness) {
  const lines = logicalLines(fixture.content);
  const cells = lines.map(line => Array.from(line.text, text => ({ text, width: 1,
    fg: 0x123456, fgMode: 0x3000000, bg: 0, bgMode: 0 })));
  return { pages: [{ width: 180, rows: cells.length, cells }], readiness,
    effectiveTheme: { family: 'github', variant: 'dark' }, identity: { version: 'test-only-reference' }, runtimeAssets: [],
    sourceMap: { tabSize: 4, tabMode: 'stops', maps: [lines.map((line, row) => ({ row, line: row + 1, column: 0, start: 0, end: line.text.length }))] } };
}

async function collect(readiness, check, { fixture: fixtureId = 'python-3.14', build = reference } = {}) {
  const output = mkdtempSync(join(tmpdir(), 'highlight-reference-'));
  let loads = 0;
  adapters['test-reference'] = { collect: 'collect', load: async () => {
    loads++;
    return { collect: async ({ fixture }) => build(fixture, readiness) };
  } };
  try {
    await check(() => execute({ command: 'collect', adapter: 'test-reference', fixture: fixtureId,
      theme: 'github', variant: 'dark', columns: 180, rows: 150, output }), output);
    assert.equal(loads, 1);
  } finally { delete adapters['test-reference']; rmSync(output, { recursive: true, force: true }); }
}

test('a registered reference without native numbered gutters traverses the common capture pipeline', async () => {
  await collect({ status: 'ready', method: 'test-only-reference' }, async (run, output) => {
    await run();
    const result = JSON.parse(readFileSync(join(output, 'capture.json'), 'utf8'));
    assert.equal(result.application, 'test-reference');
    assert.equal(result.status, 'ready');
    assert.equal(result.fixture.sha256, digest(result.source));
    assert.equal(result.coveredLines, logicalLines(result.source).length);
    assert.equal(result.spans.map(span => span.text).join(''), result.source.replaceAll('\n', ''));
    assert.equal(result.identity.application.version, 'test-only-reference');
    assert.equal(result.spans[0].projection[0].style.foreground.value, 0x123456);
  });
});

test('exact source coverage cannot turn unresolved adapter readiness into an accepted capture', async () => {
  await collect({ status: 'unresolved', method: 'test-only-reference' }, async (run, output) => {
    await assert.rejects(run, /Adapter did not establish ready/);
    assert.equal(existsSync(join(output, 'capture.json')), false);
    assert.equal(JSON.parse(readFileSync(join(output, 'readiness.json'), 'utf8')).status, 'unresolved');
  });
});

test('the common preparation pipeline forwards the requested native family and variant', async () => {
  const output = mkdtempSync(join(tmpdir(), 'highlight-prepare-'));
  let selected;
  adapters['test-reference'] = { prepare: 'prepare', load: async () => ({ prepare: async ({ theme, variant }) => {
    selected = { theme, variant };
    return { schema: 1, selected };
  } }) };
  try {
    await execute({ command: 'prepare', adapter: 'test-reference', theme: 'one-dark', variant: 'light', output });
    assert.deepEqual(selected, { theme: 'one-dark', variant: 'light' });
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'prepared.json'), 'utf8')).selected, selected);
  } finally { delete adapters['test-reference']; rmSync(output, { recursive: true, force: true }); }
});

function diffReference(fixture, readiness) {
  const digits = String(Math.max(...fixture.logicalRows.flatMap(row => [row.oldLine ?? 0, row.newLine ?? 0]))).length;
  const screen = ['  ┃', '  ┃  ← Edit ' + fixture.filename, '  ┃', ...fixture.logicalRows.map(row => {
    const number = row.newLine ?? row.oldLine, sign = row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' ';
    return '  ┃    ' + String(number).padStart(digits) + ' ' + sign + ' ' + row.text;
  }), '  ┃'].map(row => row.padEnd(80));
  const pages = [{ width: 80, rows: screen.length, screen, cells: screen.map(row => Array.from(row, text => ({
    text, width: 1, fg: 0x123456, fgMode: 0x3000000, bg: 0x010409, bgMode: 0x3000000,
  }))) }];
  return { pages, readiness, diffMap: mapOpenCodeDiff(fixture, pages),
    effectiveTheme: { family: 'github', variant: 'dark' }, identity: { version: 'test-only-diff-reference' }, runtimeAssets: [] };
}

test('a registered diff reference traverses native mapping, stored comparison and readable reporting', async () => {
  await collect({ status: 'ready', method: 'test-only-diff-reference' }, async (run, output) => {
    await run();
    const capturePath = join(output, 'capture.json'), capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.equal(capture.application, 'test-reference');
    assert.equal(capture.fixture.kind, 'diff');
    assert.equal(capture.viewIdentity, 'unified');
    assert.deepEqual(capture.logicalRows.map(row => row.role), ['added', 'added', 'added']);
    assert.equal(capture.logicalRows[0].text, '');
    assert.equal(capture.sources.unified.coveredLines, 3);
    assert.equal(capture.identity.application.version, 'test-only-diff-reference');
    assert.ok(capture.evidence.diffMap.sha256);
    const comparison = join(output, 'comparison'); mkdirSync(comparison);
    await execute({ command: 'compare', left: capturePath, right: capturePath, output: comparison });
    const report = JSON.parse(readFileSync(join(comparison, 'comparison.json'), 'utf8'));
    assert.equal(report.fixture.kind, 'diff');
    assert.equal(report.differences.length, 0);
    const markdown = readFileSync(join(comparison, 'comparison.md'), 'utf8');
    assert.match(markdown, /structural diff comparison/i);
    for (const channel of ['bodyBackground', 'gutterBackground', 'paddingBackground', 'lineNumberForeground', 'signForeground']) {
      assert.ok(markdown.includes(channel), channel + ' remains independently readable');
    }
    assert.match(markdown, /#010409/);
    assert.match(markdown, /#123456/);
    assert.equal(existsSync(join(comparison, 'comparison.ansi')), true, 'diff comparison includes literal captured-style excerpts');
  }, { fixture: 'empty-old-side-with-blank-addition', build: diffReference });
});

test('complete diff mapping cannot turn unresolved structural readiness into an accepted capture', async () => {
  await collect({ status: 'unresolved', reason: 'test-only-native-theme-pending' }, async (run, output) => {
    await assert.rejects(run, /Adapter did not establish ready/);
    assert.equal(existsSync(join(output, 'capture.json')), false);
    assert.equal(JSON.parse(readFileSync(join(output, 'readiness.json'), 'utf8')).status, 'unresolved');
  }, { fixture: 'empty-old-side-with-blank-addition', build: diffReference });
});

test('a source comparison emits side-by-side terminal-style excerpts as well as exact data', async () => {
  await collect({ status: 'ready', method: 'test-only-reference' }, async (run, output) => {
    await run();
    const capturePath = join(output, 'capture.json'), comparison = join(output, 'comparison');
    mkdirSync(comparison);
    await execute({ command: 'compare', left: capturePath, right: capturePath, output: comparison });
    assert.equal(existsSync(join(comparison, 'comparison.json')), true);
    assert.equal(existsSync(join(comparison, 'comparison.md')), true);
    assert.equal(existsSync(join(comparison, 'comparison.ansi')), true, 'source comparison includes literal captured-style excerpts');
    assert.equal(readFileSync(join(comparison, 'comparison.ansi'), 'utf8').includes('\x1b['), true, 'the preview retains terminal styles, not just uncolored text');
  });
});
