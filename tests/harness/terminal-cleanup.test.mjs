import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { closeTerminals, closeTerminalsInParallel, runCleanupSteps } from '../fixtures/terminal-cleanup.mjs';

for (const failure of ['close', 'dispose']) test(`terminal cleanup preserves ${failure} failure but still closes/disposes later terminals and the host`, async () => {
  const calls = [], error = new Error(`first ${failure} failed`);
  const terminal = name => ({
    async close() { calls.push(`${name}:close`); if (name === 'first' && failure === 'close') throw error; },
    dispose() { calls.push(`${name}:dispose`); if (name === 'first' && failure === 'dispose') throw error; },
  });
  await assert.rejects(runCleanupSteps(() => closeTerminals([terminal('first'), terminal('second')]),
    async () => { calls.push('host:close'); }), actual => actual === error);
  assert.deepEqual(calls, ['first:close', 'first:dispose', 'second:close', 'second:dispose', 'host:close']);
});

test('cleanup is sequential, awaits completion, and reports all failures without skipping releases', async () => {
  const calls = [], first = new Error('peer failed'), second = new Error('host failed');
  let release;
  const pending = runCleanupSteps(async () => {
    calls.push('peer:begin'); await new Promise(done => { release = done; }); calls.push('peer:end'); throw first;
  }, () => { calls.push('host:close'); throw second; }, () => { calls.push('root:remove'); });
  assert.deepEqual(calls, ['peer:begin']);
  release();
  await assert.rejects(pending, error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [first, second]); return true;
  });
  assert.deepEqual(calls, ['peer:begin', 'peer:end', 'host:close', 'root:remove']);
});

test('successful cleanup preserves the supplied terminal and resource release order', async () => {
  const calls = [];
  await closeTerminals(['second', 'first'].map(name => ({
    async close() { calls.push(`${name}:close`); }, dispose() { calls.push(`${name}:dispose`); },
  })));
  await runCleanupSteps();
  assert.deepEqual(calls, ['second:close', 'second:dispose', 'first:close', 'first:dispose']);
});

test('parallel closure awaits every pending close before disposal, even after another child fails', async () => {
  const calls = [], first = new Error('first close failed');
  let release;
  const terminals = [{ async close() { calls.push('first:close'); throw first; }, dispose() { calls.push('first:dispose'); } },
    { async close() { calls.push('second:close'); await new Promise(done => { release = done; }); calls.push('second:closed'); },
      dispose() { calls.push('second:dispose'); } }];
  const pending = closeTerminalsInParallel(terminals);
  const result = assert.rejects(pending, error => error === first);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls, ['first:close', 'second:close']);
  release(); await result;
  assert.deepEqual(calls, ['first:close', 'second:close', 'second:closed', 'first:dispose', 'second:dispose']);
});

test('parallel closure preserves both child failures and still reports disposal failure', async () => {
  const first = new Error('first close'), second = new Error('second close'), disposal = new Error('dispose');
  let lastDisposed = false;
  await assert.rejects(closeTerminalsInParallel([
    { async close() { throw first; }, dispose() { throw disposal; } },
    { async close() { throw second; }, dispose() { lastDisposed = true; } },
  ]), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [first, second, disposal]); return true;
  });
  assert.equal(lastDisposed, true);
});
