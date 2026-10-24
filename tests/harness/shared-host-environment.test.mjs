import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';
import { sharedHostEnv } from '../fixtures/shared-host-environment.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shared-host-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('private shared-host budget is explicit despite polluted caller settings', t => {
  const root = fixture(t);
  const previous = { TOKIO_WORKER_THREADS: process.env.TOKIO_WORKER_THREADS, SUBC_CGROUP_PLACEMENT: process.env.SUBC_CGROUP_PLACEMENT };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, { TOKIO_WORKER_THREADS: '999', SUBC_CGROUP_PLACEMENT: 'enabled' });
  const env = sharedHostEnv(join(root, 'host'));
  assert.equal(env.TOKIO_WORKER_THREADS, '2');
  assert.equal(env.SUBC_CGROUP_PLACEMENT, 'disabled');
  assert.equal(env.HOME, join(root, 'host', 'home'));
  const ordinary = childEnv(join(root, 'ordinary'));
  assert.equal(ordinary.TOKIO_WORKER_THREADS, undefined, 'the private-host budget must not become a generic child/runtime policy');
  assert.equal(ordinary.SUBC_CGROUP_PLACEMENT, undefined);
});

test('actual child receives the bounded private-host environment without changing Node policy', t => {
  const root = fixture(t), inputs = readInputs();
  const observed = JSON.parse(execFileSync(inputs.node.path, ['-e', `
    console.log(JSON.stringify({ threads: process.env.TOKIO_WORKER_THREADS,
      placement: process.env.SUBC_CGROUP_PLACEMENT, home: process.env.HOME,
      uv: process.env.UV_THREADPOOL_SIZE, node: process.version }));
  `], { env: sharedHostEnv(root), encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(observed, { threads: '2', placement: 'disabled', home: join(root, 'home'), uv: '4', node: inputs.node.version });
});
