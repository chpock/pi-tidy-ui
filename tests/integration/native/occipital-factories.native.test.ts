import '../../fixtures/test-guard.mjs';
import { deferred, release, setup } from '../../fixtures/factory-contract-support.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnv, readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnedFactory } from '../../../src/occipital/factories.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';






const binary = validateNative(readInputs()).path;
test('real exact helper: zero acquisition requests; repeated owners wait actual public close settlement', {}, async t => {
  const f = await setup(t), installedPath = binary!;
  const hash = createHash('sha256'); for await (const chunk of createReadStream(installedPath)) hash.update(chunk);
  const nativeRelease = Object.freeze({ ...release, sha256: hash.digest('hex'), maxBytes: (await stat(installedPath)).size });
  let fetches = 0;
  const env = childEnv(f.cacheDir);
  Object.assign(env, { HOME: f.cacheDir, XDG_CONFIG_HOME: join(f.cacheDir, 'config'), XDG_DATA_HOME: join(f.cacheDir, 'data'), XDG_CACHE_HOME: join(f.cacheDir, 'cache'), XDG_RUNTIME_DIR: join(f.cacheDir, 'run') });
  const options = { cacheDir: f.cacheDir, release: nativeRelease, installedPath, env, cwd: f.cacheDir, requestDeadlineMs: 3000, terminateGraceMs: 30,
    fetcher: async () => { fetches++; throw new Error('must not fetch installed helper'); } };
  const callers = [new AbortController(), new AbortController()];
  const contenders = callers.map((caller, index) => createOwnedFactory(options)(caller.signal).then(transport => ({ transport, index })));
  const winner = await Promise.race(contenders), first = winner.transport;
  const losing = assert.rejects(contenders[1 - winner.index], /owned factory unavailable/);
  callers[1 - winner.index].abort(); await losing;
  callers[winner.index].abort(); // Transfer removed the abort listener; this cannot close the winner.
  t.after(() => first.close());
  assert.ok(first instanceof StdioTransport); assert.equal(f.spawns(), 1); assert.equal(fetches, 0);
  assert.deepEqual(f.calls[0], [installedPath, ['--stdio'], { cwd: f.cacheDir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }]);
  assert.equal(first.stats().unsettledControl, 0); assert.equal(first.stats().unsettledData, 0);
  const described = await first.request({ v: 2, op: 'describe', ticket: 'fixture:first' }) as { status: string };
  assert.equal(described.status, 'ok');
  const realClose = first.close.bind(first), held = deferred<void>();
  t.after(() => held.resolve());
  t.mock.method(first, 'close', () => { void realClose(); return held.promise; });
  const closing = first.close(); await first.ended;
  const cancelled = new AbortController();
  const refused = assert.rejects(createOwnedFactory(options)(cancelled.signal), /owned factory unavailable/);
  cancelled.abort(); await refused; assert.equal(f.spawns(), 1);
  const expired = assert.rejects(createOwnedFactory({ ...options, attemptDeadlineMs: 30 })(new AbortController().signal), /owned factory unavailable/);
  await awaitFixture(expired); assert.equal(f.spawns(), 1); assert.equal(fetches, 0);
  let returned = false;
  const secondPending = createOwnedFactory(options)(new AbortController().signal).then(value => { returned = true; return value; });
  await delay(20); assert.equal(returned, false); assert.equal(f.spawns(), 1);
  await realClose(); held.resolve(); await closing;
  const second = await secondPending; t.after(() => second.close());
  assert.ok(second instanceof StdioTransport); assert.equal(f.spawns(), 2); assert.equal(fetches, 0);
  const secondReply = await second.request({ v: 2, op: 'describe', ticket: 'fixture:second' }) as { status: string };
  assert.equal(secondReply.status, 'ok'); await second.close();
  assert.equal(second.stats().childState, 'exited'); assert.equal(second.stats().ownedListeners, 0);
});
