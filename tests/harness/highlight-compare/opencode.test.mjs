import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mapOpenCodeSource, styledSourceWitness } from '../../../scripts/highlight-compare/adapters/opencode-source.mjs';
import { neutralWorkspace, validateTheme, verifyThemeState, writeSessionFixture } from '../../../scripts/highlight-compare/adapters/opencode.mjs';
import { normalizeSource } from '../../../scripts/highlight-compare/model.mjs';

const source = 'def f():\n    return 1\n';
function page(rows = ['  ┃ # Wrote demo.py', '  ┃   1 def f():', '  ┃   2     return 1', 'def UI_keyword():']) {
  return { frame: 7, rendering: false, screen: rows, cells: rows.map(row => Array.from(row.padEnd(60), (text, x) => ({
    text, width: 1, fgMode: 0x3000000, fg: x < 8 ? 0xff0000 : 0xe6edf3, bgMode: 0x3000000, bg: 0x0d1117,
    bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false,
  }))) };
}

test('OpenCode readiness rejects uniform explicit RGB source despite colored header, gutter and unrelated code-like UI', () => {
  const candidate = page(), alignment = mapOpenCodeSource(source, [candidate]);
  candidate.cells[3][0].fg = 0xabcdef;
  assert.equal(alignment.bodyColumn, 8);
  assert.deepEqual(alignment.maps[0].map(range => range.row), [1, 2]);
  assert.equal(styledSourceWitness(source, candidate, alignment), null);
  assert.equal(normalizeSource(source, [candidate], alignment.maps).coveredLines, 2);
});

test('OpenCode readiness distinguishes a mapped styled source publication from background-only changes', () => {
  const candidate = page(), alignment = mapOpenCodeSource(source, [candidate]);
  candidate.cells[1][8].bg = 0xabcdef;
  assert.equal(styledSourceWitness(source, candidate, alignment), null);
  candidate.cells[1][8].fg = 0xff7b72;
  const witness = styledSourceWitness(source, candidate, alignment);
  assert.equal(witness.frame, 7);
  assert.equal(witness.styles.length, 2);
  candidate.cells[1][8].fg = 0xe6edf3;
  candidate.cells[1][8].italic = true;
  assert.equal(styledSourceWitness(source, candidate, alignment).styles.length, 2);
});

test('OpenCode readiness requires native frame completion, not arbitrary saved screen colors', () => {
  const candidate = page(), alignment = mapOpenCodeSource(source, [candidate]);
  candidate.frame = 0;
  assert.throws(() => styledSourceWitness(source, candidate, alignment), /completed native synchronized frame/);
});

test('OpenCode source readiness rejects a partial new native frame after an older completed one', () => {
  const candidate = page(), alignment = mapOpenCodeSource(source, [candidate]);
  candidate.cells[1][8].fg = 0xff7b72;
  assert.equal(styledSourceWitness(source, candidate, alignment).frame, 7, 'completed positive control');
  candidate.rendering = true;
  assert.throws(() => styledSourceWitness(source, candidate, alignment), /completed native synchronized frame/);
});

test('OpenCode alignment does not certify missing, changed or whitespace-trimmed source', () => {
  const candidate = page(), alignment = mapOpenCodeSource(source, [candidate]);
  for (const changed of ['def f():\nreturn 1\n', 'def f():\n    return 2\n', source + '# missing\n']) {
    assert.throws(() => normalizeSource(changed, [candidate], alignment.maps), /mismatch|coverage|range/i);
  }
});

test('OpenCode neutral workspace refuses a foreign ancestor theme directory without reading it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'hc-native-ancestor-'));
  try {
    mkdirSync(join(parent, '.opencode'));
    const nested = join(parent, 'nested'); mkdirSync(nested);
    assert.throws(() => neutralWorkspace(nested), /foreign .opencode ancestor/);
    assert.deepEqual(readdirSync(nested), [], 'the rejected owned workspace is cleaned up');
    assert.deepEqual(readdirSync(parent).sort(), ['.opencode', 'nested']);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('OpenCode neutral workspace belongs to the explicit clean parent, not the result or user project', () => {
  assert.throws(() => neutralWorkspace(), /explicit prepared neutral run root/);
  const parent = mkdtempSync(join(tmpdir(), 'hc-native-workspace-'));
  try { assert.equal(dirname(neutralWorkspace(parent)), parent); }
  finally { rmSync(parent, { recursive: true, force: true }); }
});

test('OpenCode capture rejects unknown or GUI-variant theme IDs instead of certifying native fallback', () => {
  for (const name of ['github', 'one-dark', 'lucent-orng', 'catppuccin-frappe']) for (const variant of ['dark', 'light']) assert.doesNotThrow(() => validateTheme(name, variant));
  for (const name of ['missing-theme', 'github-dark', 'system']) assert.throws(() => validateTheme(name, 'dark'), /built-in family/);
  assert.throws(() => validateTheme('github', 'auto'), /variant must be/);
});

test('OpenCode effective theme requires applied native TUI configuration, not core debug config', () => {
  const parent = mkdtempSync(join(tmpdir(), 'hc-native-tui-config-'));
  try {
    const configPath = join(parent, 'tui with space.json'), kvPath = join(parent, 'kv.json');
    writeFileSync(configPath, JSON.stringify({ theme: 'github', mouse: false, diff_style: 'stacked' }));
    writeFileSync(kvPath, JSON.stringify({ theme: 'github', theme_mode_lock: 'dark', tool_details_visibility: true, sidebar: 'hide' }));
    const nativeLog = 'message="applying tui config" path=' + JSON.stringify(configPath) + ' order=1\n';
    const result = verifyThemeState('github', 'dark', configPath, kvPath, nativeLog);
    assert.equal(result.family, 'github');
    assert.equal(result.evidence.nativeApplied.records, 1);
    for (const invalid of ['{}', '{"theme":"github"}', nativeLog.replace('with space', 'foreign')]) assert.throws(() => verifyThemeState('github', 'dark', configPath, kvPath, invalid), /did not confirm|undeclared configuration/);
    assert.throws(() => verifyThemeState('github', 'light', configPath, kvPath, nativeLog), /variant lock/);
    writeFileSync(configPath, JSON.stringify({ theme: 'opencode', mouse: false, diff_style: 'stacked' }));
    assert.throws(() => verifyThemeState('github', 'dark', configPath, kvPath, nativeLog), /requested native theme/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('OpenCode source map uses its observed two-column tab expansion rather than the Pi four-column default', () => {
  const tabbed = 'def f():\n\treturn 1\n';
  const candidate = page(['  ┃ # Wrote demo.py', '  ┃   1 def f():', '  ┃   2   return 1']);
  const alignment = mapOpenCodeSource(tabbed, [candidate]);
  const normalized = normalizeSource(tabbed, [candidate], alignment.maps, { tabSize: alignment.tabSize });
  assert.equal(alignment.tabSize, 2);
  const tab = normalized.spans.find(span => span.text === '\t');
  assert.equal(tab.columns, 2);
  assert.equal(tab.projection.map(cell => cell.text).join(''), '  ');
  const wrong = mapOpenCodeSource(tabbed, [candidate], { tabSize: 4 });
  assert.throws(() => normalizeSource(tabbed, [candidate], wrong.maps, { tabSize: 4 }), /Incomplete source coverage/);
});

test('OpenCode inline tabs keep fixed native width at odd logical columns', () => {
  const tabbed = 'def f():\n\tx = "ab\tZ"\n';
  const candidate = page(['  ┃ # Wrote demo.py', '  ┃   1 def f():', '  ┃   2   x = "ab  Z"']);
  const alignment = mapOpenCodeSource(tabbed, [candidate]);
  const normalized = normalizeSource(tabbed, [candidate], alignment.maps, { tabSize: alignment.tabSize, tabMode: alignment.tabMode });
  assert.equal(normalized.tabMode, 'fixed');
  assert.deepEqual(normalized.spans.filter(span => span.text === '\t').map(span => span.columns), [2, 2]);
  const wrong = mapOpenCodeSource(tabbed, [candidate], { tabSize: 2, tabMode: 'stops' });
  assert.throws(() => normalizeSource(tabbed, [candidate], wrong.maps, { tabSize: 2, tabMode: 'stops' }), /Incomplete source coverage/);
});

test('OpenCode imported metadata selects a real pinned offline-catalogue model without a model invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'hc-native-session-model-'));
  try {
    const path = join(root, 'session.json');
    writeSessionFixture({ kind: 'source', id: 'unit-native-model', filename: 'demo.py', content: source }, root, 'ses_unitmodel', path);
    const session = JSON.parse(readFileSync(path, 'utf8'));
    // Verified with the pinned executable's network-isolated `models opencode` catalogue command.
    const selected = { providerID: 'opencode', modelID: 'big-pickle' };
    const user = session.messages.find(message => message.info.role === 'user');
    const assistant = session.messages.find(message => message.info.role === 'assistant');
    assert.deepEqual(user.info.model, selected);
    assert.equal(assistant.info.providerID, selected.providerID);
    assert.equal(assistant.info.modelID, selected.modelID);
    assert.equal(assistant.parts[0].state.status, 'completed');
    assert.equal(assistant.parts[0].state.input.content, source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode native diff style is explicit while source capture remains stacked by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'hc-native-diff-style-'));
  try {
    const config = join(root, 'tui.json'), kv = join(root, 'kv.json');
    writeFileSync(config, JSON.stringify({ theme: 'github', mouse: false, diff_style: 'auto' }));
    writeFileSync(kv, JSON.stringify({ theme: 'github', theme_mode_lock: 'dark', tool_details_visibility: true, sidebar: 'hide' }));
    const log = 'message="applying tui config" path=' + JSON.stringify(config) + '\n';
    assert.equal(verifyThemeState('github', 'dark', config, kv, log, 'auto').evidence.diffStyle, 'auto');
    assert.throws(() => verifyThemeState('github', 'dark', config, kv, log), /diff style/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
