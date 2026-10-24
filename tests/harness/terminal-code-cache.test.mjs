import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';

const helper = new URL('../fixtures/terminal-code-cache.mjs', import.meta.url).href;

test('separate test processes share only compiled-code directories until the owning run is cleaned', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'compile-workers-')), workers = [];
  t.after(async () => {
    for (const { child } of workers) if (child.exitCode === null) child.kill();
    await Promise.all(workers.map(worker => worker.completed));
    rmSync(root, { recursive: true, force: true });
  });
  const inputs = readInputs(), run = join(root, 'run');
  const invoke = (name, owner = run) => {
    const home = join(root, name); mkdirSync(join(home, 'tmp'), { recursive: true });
    const source = `import { terminalCodeCache } from ${JSON.stringify(helper)}; console.log(JSON.stringify({ pid:process.pid,home:process.argv[1],cache:terminalCodeCache(process.argv[1]) }));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, home], {
      env: childEnv(owner, { HOME: home, USERPROFILE: home }, inputs), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const first = invoke('first');
  assert.equal(existsSync(first.cache.node), true, 'a test-process exit must not discard the run cache');
  const second = invoke('second');
  assert.notEqual(first.pid, second.pid); assert.notEqual(first.home, second.home);
  assert.deepEqual(first.cache, second.cache, 'later test files must reuse the same compiled code');
  assert.equal(realpathSync(join(first.home, 'tmp/jiti')), realpathSync(join(second.home, 'tmp/jiti')));
  const coldRun = join(root, 'cold-run');
  for (const name of ['cold-first', 'cold-second']) {
    const home = join(root, name); mkdirSync(join(home, 'tmp'), { recursive: true });
    const source = `process.send('ready');
      await new Promise(resolve => process.once('message', resolve));
      const { terminalCodeCache } = await import(${JSON.stringify(helper)});
      process.send({ pid: process.pid, home: process.env.HOME, cache: terminalCodeCache(${JSON.stringify(home)}) });
      process.disconnect();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: childEnv(coldRun, { HOME: home, USERPROFILE: home }, inputs), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 5000,
    });
    let stderr = '', result;
    child.stderr.on('data', data => { stderr += data; });
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('close', () => reject(new Error(`Cache worker exited before release: ${stderr}`)));
    });
    const completed = new Promise(resolve => {
      child.on('message', message => { if (message !== 'ready') result = message; });
      child.once('close', (code, signal) => resolve({ code, signal, result, stderr }));
    });
    workers.push({ child, ready, completed });
  }
  assert.deepEqual(await Promise.all(workers.map(worker => worker.ready)), ['ready', 'ready']);
  assert.equal(existsSync(join(coldRun, 'tmp/pi-terminal-code')), false, 'both workers must reach the gate before cold cache creation');
  for (const { child } of workers) child.send('release');
  const cold = await Promise.all(workers.map(worker => worker.completed));
  for (const worker of cold) {
    assert.equal(worker.code, 0, worker.stderr); assert.equal(worker.signal, null);
  }
  assert.notEqual(cold[0].result.pid, cold[1].result.pid);
  assert.notEqual(cold[0].result.home, cold[1].result.home);
  assert.deepEqual(cold[0].result.cache, cold[1].result.cache);
  const afterCold = invoke('after-cold', coldRun);
  assert.deepEqual(afterCold.cache, cold[0].result.cache, 'subsequent workers reuse the concurrently created cache');
  assert.equal(realpathSync(join(cold[0].result.home, 'tmp/jiti')), realpathSync(join(cold[1].result.home, 'tmp/jiti')));
  const independent = invoke('third', join(root, 'other-run'));
  assert.notEqual(independent.cache.node, first.cache.node, 'different runs must remain independent');
  rmSync(run, { recursive: true, force: true });
  assert.equal(existsSync(first.cache.node), false); assert.equal(existsSync(first.cache.jiti), false);
  assert.equal(existsSync(independent.cache.node), true, 'one run cannot clean another run cache');
});
