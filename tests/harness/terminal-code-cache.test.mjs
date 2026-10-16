import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';

const helper = new URL('../fixtures/terminal-code-cache.mjs', import.meta.url).href;

test('separate test processes share only compiled-code directories until the owning run is cleaned', t => {
  const root = mkdtempSync(join(tmpdir(), 'compile-workers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = readInputs(), run = join(root, 'run');
  const invoke = (name, owner = run) => {
    const home = join(root, name); mkdirSync(join(home, 'tmp'), { recursive: true });
    const source = `import { terminalCodeCache } from ${JSON.stringify(helper)}; console.log(JSON.stringify({ pid:process.pid,home:process.argv[1],cache:terminalCodeCache(process.argv[1]) }));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, home], { env: childEnv(owner, {}, inputs), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const first = invoke('first');
  assert.equal(existsSync(first.cache.node), true, 'a test-process exit must not discard the run cache');
  const second = invoke('second');
  assert.notEqual(first.pid, second.pid); assert.notEqual(first.home, second.home);
  assert.deepEqual(first.cache, second.cache, 'later test files must reuse the same compiled code');
  assert.equal(realpathSync(join(first.home, 'tmp/jiti')), realpathSync(join(second.home, 'tmp/jiti')));
  const independent = invoke('third', join(root, 'other-run'));
  assert.notEqual(independent.cache.node, first.cache.node, 'different runs must remain independent');
  rmSync(run, { recursive: true, force: true });
  assert.equal(existsSync(first.cache.node), false); assert.equal(existsSync(first.cache.jiti), false);
  assert.equal(existsSync(independent.cache.node), true, 'one run cannot clean another run cache');
});
