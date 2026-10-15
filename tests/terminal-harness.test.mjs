import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readInputs, childEnv } from '../scripts/test/context.mjs';
import { PiTerminal, assertFits } from './fixtures/terminal-harness.mjs';
import { editorPaint } from './fixtures/editor-paint.ts';
import * as native from '@earendil-works/pi-tui';
import xterm from '@xterm/headless';

const inputs = readInputs();

test('terminal harness import registers no CLI tests', t => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-harness-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(inputs.node.path, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./fixtures/terminal-harness.mjs', import.meta.url).href)}); console.log('HARNESS_IMPORTED');`],
  { cwd: inputs.pi.root, env: childEnv(root), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'HARNESS_IMPORTED\n', 'import must not register or execute the broad terminal suite');
});

test('terminal harness preserves real cell-width checks', async () => {
  await assertFits(['plain', '\x1b[31m界é\x1b[0m'], 8);
  await assert.rejects(assertFits(['123456789'], 8), /must not wrap/);
  await assert.rejects(assertFits(['one\ntwo'], 8), /line break/);
});

test('terminal harness cleans its owned home when required profile setup fails', () => {
  let home;
  const failure = new Error('required profile missing');
  assert.throws(() => new PiTerminal('harness-missing-profile', { profileFactory({ homeDir }) {
    home = homeDir;
    throw failure;
  } }), error => error === failure);
  assert.ok(home);
  assert.equal(existsSync(home), false);
});

test('syntax terminal missing native input fails instead of silently skipping', t => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-syntax-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'inputs.json');
  writeFileSync(path, JSON.stringify({ ...inputs, native: undefined }));
  const result = spawnSync(inputs.node.path, ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href, '--test', fileURLToPath(new URL('./syntax-owned.cli.test.mjs', import.meta.url))],
    { cwd: inputs.pi.root, env: childEnv(root, { TIDY_TEST_INPUTS: path, TIDY_TEST_CONTEXT_READY: '1' }), encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Missing required same-source Occipital build/);
});


test('editor comparison uses selected Pi composition and preserves native cursor paint', async () => {
  const cursor = typeof native.renderFakeCursor === 'function' ? native.renderFakeCursor('界') : '\x1b[7m界\x1b[27m';
  const rows = ['\x1b[31mLEFT\x1b[0m' + native.CURSOR_MARKER + cursor + '\x1b[34mRIGHT\x1b[0m'];
  const before = [...rows], painted = editorPaint(rows);
  assert.deepEqual(rows, before, 'observation never rewrites component rows');
  assert.ok(!painted[0].includes('\x1b_pi:'), 'all native cursor metadata is resolved before physical comparison');
  const terminal = new xterm.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(painted.join('\r\n'), resolve));
    const line = terminal.buffer.active.getLine(0);
    assert.equal(line.translateToString(true), 'LEFT界RIGHT');
    assert.ok(line.getCell(4).isInverse(), 'real native cursor paint is preserved, not stripped to hide the mismatch');
    assert.equal(line.getCell(6).isInverse(), 0, 'cursor reset does not color later content');
    assert.equal(line.getCell(0).getFgColor(), 1);
    assert.equal(line.getCell(6).getFgColor(), 4);
  } finally { terminal.dispose(); }
});
