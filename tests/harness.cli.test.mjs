import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { PiTerminal, root, fixtures, artifacts, plain, assertFits } from './fixtures/terminal-harness.mjs';
import { closeTerminals } from './fixtures/terminal-cleanup.mjs';
import { childEnv, readInputs, toolPath } from '../scripts/test/context.mjs';

test('CLI compilation caches reuse code, not sessions, and reject changed source with a warm loader', { timeout: 60000 }, async t => {
  const probe = mkdtempSync(join(tmpdir(), 'pi-compile-probe-'));
  t.after(() => rmSync(probe, { recursive: true, force: true }));
  const extension = join(probe, 'cached-extension.ts'), records = join(probe, 'executions.jsonl');
  const source = label => `import { appendFileSync } from 'node:fs';
let evaluations: number = 0;
export default function probe() {
  evaluations++;
  appendFileSync(${JSON.stringify(records)}, JSON.stringify({ label: ${JSON.stringify(label)}, evaluations, pid: process.pid, home: process.env.HOME }) + '\\n');
}\n`;
  const histories = [];
  assert.equal(Buffer.byteLength(source('FIRST')), Buffer.byteLength(source('OTHER')));
  for (const [index, label] of ['FIRST', 'FIRST', 'OTHER'].entries()) {
    if (index !== 1) writeFileSync(extension, source(label));
    const terminal = new PiTerminal(`compile-cache-${index}`, { tidyUi: true, extensions: [extension],
      extraEnv: { NODE_DEBUG_NATIVE: 'COMPILE_CACHE', JITI_DEBUG: '1' } });
    try {
      await terminal.ready();
      await terminal.run('user-card');
      const dump = await terminal.capture('cache-physical-proof');
      assert.equal(dump.tools.length, 2);
      assert.equal(terminal.events().filter(event => event.type === 'call').length, 2);
      assert.equal(terminal.events().filter(event => event.type === 'result').length, 2);
      const log = plain(Buffer.concat(terminal.raw).toString());
      const cacheMessages = log.split(/\r?\n/u).filter(line => line.includes('[jiti] [cache]') && line.includes(extension));
      assert.ok(cacheMessages.some(line => line.includes(index === 1 ? '[hit]' : '[miss]')), JSON.stringify(cacheMessages));
      const history = readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(history.map(entry => entry.label), ['FIRST', 'FIRST', 'OTHER'].slice(0, index + 1));
      assert.ok(history.every(entry => entry.evaluations === 1), 'every process must evaluate the extension afresh');
      assert.equal(new Set(history.map(entry => entry.pid)).size, index + 1);
      assert.equal(new Set(history.map(entry => entry.home)).size, index + 1);
      histories.push({ label, cacheMessages, history });
      if (index === 1) {
        const plan = JSON.parse(readFileSync(join(terminal.output, 'native-observer.json'), 'utf8'));
        const accepted = [`cache for ${plan.module}`, `V8 code cache for ESM ${plan.module}`]
          .some(message => log.includes(`[compile cache] ${message} was accepted, keeping the in-memory entry`));
        assert.ok(accepted, 'native CLI bytecode must actually be reused');
        const badPlan = join(probe, 'invalid-observer.json');
        writeFileSync(badPlan, JSON.stringify({ ...plan, sha256: '0'.repeat(64) }));
        const inputs = readInputs();
        const rejected = spawnSync(inputs.node.path, ['--import', pathToFileURL(join(fixtures, 'terminal-preload.mjs')).href, inputs.pi.cli, '--version'], {
          cwd: root, env: childEnv(join(probe, 'hash-rejection'), { NODE_COMPILE_CACHE: terminal.codeCache.node,
            TIDY_UI_TEST_OBSERVER_PLAN: badPlan }, inputs), encoding: 'utf8', timeout: 12000,
        });
        assert.equal(rejected.error, undefined);
        assert.notEqual(rejected.status, 0, 'a warm compilation cache must not bypass selected-source validation');
        assert.match(rejected.stderr, /Selected Pi changed after terminal observer planning/u);
      }
    } finally { await closeTerminals([terminal]); }
  }
  writeFileSync(join(artifacts, 'compilation-cache-proof.json'), JSON.stringify(histories, null, 2));
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
    const { PiTerminal } = await import(${JSON.stringify(new URL('./fixtures/terminal-harness.mjs', import.meta.url).href)});
    const { closeTerminals } = await import(${JSON.stringify(new URL('./fixtures/terminal-cleanup.mjs', import.meta.url).href)});
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
