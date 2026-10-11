import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitFixture } from './fixtures/await-fixture.ts';

test('fixture waiter preserves values and original rejection without delaying settlement', async () => {
  assert.equal(await awaitFixture(Promise.resolve(42)), 42);
  const original = new Error('original');
  await assert.rejects(awaitFixture(Promise.reject(original)), error => error === original);
});

test('fixture waiter owns a referenced finite deadline when a promise is the only activity', async () => {
  await assert.rejects(awaitFixture(new Promise<never>(() => {}), 10), /fixture activity deadline/);
});

test('fixture waiter permits unreferenced production work without changing that work timer', async () => {
  let timer: NodeJS.Timeout;
  const work = new Promise<number>(resolve => { timer = setTimeout(() => resolve(7), 10).unref(); });
  assert.equal(timer!.hasRef(), false);
  try { assert.equal(await awaitFixture(work), 7); assert.equal(timer!.hasRef(), false); }
  finally { clearTimeout(timer!); }
});

test('native interval cleared inside its callback runs once across supported Node runtimes', async () => {
  let calls = 0;
  const interval = setInterval(() => { calls++; clearInterval(interval); }, 5);
  try { await delay(30); assert.equal(calls, 1); }
  finally { clearInterval(interval); }
});
