import './fixtures/test-guard.mjs';
import { release, setup } from './fixtures/factory-contract-support.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOwnedFactory } from '../src/occipital/factories.ts';
import * as factories from '../src/occipital/factories.ts';
import { StdioTransport } from '../src/occipital/stdio.ts';






test('local owned factory starts only its explicit file and shares the actual-close guard with release factories',
  {}, async t => {
    assert.equal(typeof factories.createLocalOwnedFactory, 'function');
    const f = await setup(t), command = join(f.cacheDir, 'local occipital');
    await writeFile(command, `#!${process.execPath}\nprocess.stdin.resume();setInterval(() => {}, 1000000);\n`);
    await chmod(command, 0o755);
    const acquire = factories.createLocalOwnedFactory({ command, cwd: f.cacheDir, requestDeadlineMs: 1000, terminateGraceMs: 30 });
    const first = await acquire(new AbortController().signal); t.after(() => first.close());
    assert.ok(first instanceof StdioTransport);
    assert.equal(f.spawns(), 1); assert.equal(f.calls[0][0], command); assert.deepEqual(f.calls[0][1], ['--stdio']);
    const pid = first.stats().pid; assert.ok(pid);
    const cancelled = new AbortController();
    const releaseAcquire = createOwnedFactory({ cacheDir: f.cacheDir, release, requestDeadlineMs: 1000, terminateGraceMs: 30,
      fetcher: async () => { throw new Error('A held local owner must prevent acquisition'); } });
    const refused = assert.rejects(releaseAcquire(cancelled.signal), /owned factory unavailable/);
    cancelled.abort(); await refused; assert.equal(f.spawns(), 1);
    await first.close(); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    const second = await acquire(new AbortController().signal); t.after(() => second.close());
    assert.equal(f.spawns(), 2); assert.ok(second instanceof StdioTransport); await second.close();
    assert.equal(second.stats().childState, 'exited'); assert.equal(second.stats().ownedListeners, 0);
  });
