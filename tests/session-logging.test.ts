import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SessionLogging } from '../src/session-logging.ts';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, identity: { session: 'same-session', cwd: '/work/example', extension: '0.0.0', pi: '1.0.0', reason: 'startup' } };
}

test('session logging keeps old asynchronous sinks attached only to their original run', async t => {
  const { root, identity } = await fixture(t);
  const old = new SessionLogging(identity, { root }); await old.ready();
  const late = old.sink;
  await old.close('reload');
  const next = new SessionLogging({ ...identity, reason: 'reload' }, { root }); await next.ready();
  t.after(() => next.close('quit'));
  assert.notEqual(old.status().run, next.status().run);
  const before = next.status().records;
  late('INFO', 'occipital', 'Old provider settled');
  next.sink('INFO', 'runtime', 'Current provider selected'); await next.flush();
  assert.equal(next.status().records, before + 1);
  const text = await fs.readFile(next.status().path, 'utf8');
  assert.doesNotMatch(text, /Old provider settled/);
  assert.match(text, /Current provider selected/);
});

test('session logging pause and explicit resume keep one run without source or history reads', async t => {
  const { root, identity } = await fixture(t);
  const scope = new SessionLogging(identity, { root }); await scope.ready();
  t.after(() => scope.close('quit'));
  scope.nameChanged('New\nname'); await scope.flush();
  const before = scope.status(); await scope.setEnabled(false);
  const paused = scope.status();
  scope.sink('INFO', 'runtime', 'Paused operation'); await scope.flush();
  assert.equal(scope.status().writes, paused.writes);
  assert.equal(scope.status().timer, false);
  await scope.setEnabled(true);
  assert.equal(scope.status().path, before.path); assert.equal(scope.status().run, before.run);
  const text = await fs.readFile(scope.status().path, 'utf8');
  assert.match(text, /Pi session name changed; name=New\\nname/);
  assert.doesNotMatch(text, /Paused operation/);
});

test('session logging explicit retry preserves run-bound observers and never retries on its own', async t => {
  const { root, identity } = await fixture(t);
  let fail = false, faults = 0, warnings = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (fail) { fail = false; faults++; throw Object.assign(new Error('PRIVATE_ERROR_PAYLOAD'), { code: 'ENOSPC' }); }
      return writev(buffers, position);
    };
    return handle;
  } } as typeof fs;
  const scope = new SessionLogging(identity, { root, io, warn: () => { warnings++; } }); await scope.ready();
  t.after(() => scope.close('quit'));
  const observer = scope.sink, original = scope.status();
  fail = true; observer('INFO', 'runtime', 'Operation completed'); await scope.flush();
  assert.equal(scope.status().state, 'failed'); assert.equal(warnings, 1); assert.equal(faults, 1);
  observer('INFO', 'runtime', 'No automatic retry'); await scope.flush();
  assert.equal(faults, 1); assert.equal(scope.status().state, 'failed');
  await scope.setEnabled(true);
  assert.equal(scope.status().state, 'active'); assert.equal(scope.status().run, original.run);
  assert.notEqual(scope.status().path, original.path);
  observer('INFO', 'runtime', 'Existing owner uses resumed capture'); await scope.flush();
  const text = await fs.readFile(scope.status().path, 'utf8');
  assert.match(text, /Existing owner uses resumed capture/); assert.doesNotMatch(text, /PRIVATE_ERROR_PAYLOAD/);
});
