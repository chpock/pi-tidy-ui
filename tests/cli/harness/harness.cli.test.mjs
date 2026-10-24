import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PiTerminal, assertFits } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { childEnv, readInputs, toolPath } from '../../../scripts/test/context.mjs';

test('CLI compilation caches reuse code, not sessions, and reject changed source with a warm loader', { timeout: 60000 }, async t => {
  const probe = mkdtempSync(join(tmpdir(), 'pi-compile-probe-'));
  // A child-owned TMPDIR isolates the cold control from other files using the runner cache.
  const child = spawn(readInputs().node.path, [
    fileURLToPath(new URL('../../fixtures/compilation-cache-control.mjs', import.meta.url)), probe], {
    env: childEnv(join(probe, 'suite')), stdio: ['ignore', 'ignore', 'pipe'], timeout: 45000,
  });
  let stderr = '', startupError;
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { startupError = error.message; });
  const completed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill();
    await completed;
    rmSync(probe, { recursive: true, force: true });
  });
  const result = await completed;
  assert.equal(startupError, undefined);
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
});

test('real CLI: delayed PTY resize confirms Pi geometry before width height and identical-size captures',
  { timeout: 60000 }, async () => {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`delayed-resize-${mode}`, { mode, tidyUi: true,
        extraEnv: { TIDY_UI_TEST_RESIZE_DELAY_MS: '750', TIDY_UI_TEST_RESIZE_HOLD_MS: '500' } });
      try {
        await terminal.ready();
        assert.deepEqual(terminal.events().findLast(e => e.type === 'terminal_size'),
          { type: 'terminal_size', width: 100, height: 80 });
        const sizes = [[24, 80], [24, 24], [24, 24], [100, 80], [24, 80]];
        for (const [index, [width, height]] of sizes.entries()) {
          await terminal.resize(width, height);
          assert.deepEqual(terminal.ptySize, { id: index + 1, width, height }, 'each resize has a fresh matching PTY receipt');
          assert.deepEqual(terminal.events().findLast(e => e.type === 'terminal_size'),
            { type: 'terminal_size', width, height }, 'resize cannot finish before Pi observes the requested geometry');
          const dump = await terminal.capture(`geometry-${index}`);
          assert.equal(dump.width, width); assert.equal(terminal.term.cols, width); assert.equal(terminal.term.rows, height);
          await assertFits(dump.editor.lines, width);
        }
        assert.equal(terminal.events().filter(e => ['call', 'model_context'].includes(e.type)).length, 0,
          'geometry synchronization does not submit model/tool input');
      } finally { await closeTerminals([terminal]); }
    }
  });

test('terminal harness uses the prepared CLI despite an ambient CLI override and ignores Python site customizers', { timeout: 45000 }, t => {
  const inputs = readInputs(), root = mkdtempSync(join(tmpdir(), 'tidy-selected-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'site-ran');
  writeFileSync(join(root, 'sitecustomize.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('active')\n`);
  const control = spawnSync(toolPath('python3'), ['-c', 'print("python-control")'],
    { env: childEnv(join(root, 'control'), { PYTHONPATH: root }), encoding: 'utf8', timeout: 15000 });
  assert.equal(control.status, 0); assert.equal(existsSync(marker), true, 'positive control must load the customizer');
  rmSync(marker);
  const result = spawnSync(inputs.node.path, ['--input-type=module', '-e', `
    const { PiTerminal } = await import(${JSON.stringify(new URL('../../fixtures/terminal-harness.mjs', import.meta.url).href)});
    const { closeTerminals } = await import(${JSON.stringify(new URL('../../fixtures/terminal-cleanup.mjs', import.meta.url).href)});
    const terminal = new PiTerminal('harness-selected-cli', { extraEnv: { PYTHONPATH: ${JSON.stringify(root)} } });
    try {
      await terminal.ready();
      const dump = await terminal.capture('selected-cli');
      console.log(JSON.stringify({ starts: terminal.events().filter(event => event.type === 'start').length, tools: dump.tools.length }));
    } finally { await closeTerminals([terminal]); }
  `], { cwd: inputs.pi.root, env: childEnv(root, { PI_TEST_CLI: '/must-not-be-executed/ambient-pi' }),
    encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { starts: 1, tools: 0 });
  assert.equal(existsSync(marker), false, 'PTY must not load Python startup customization');
});
