import '../../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createLocalOwnedFactory, createOwnedFactory } from '../../../../../src/occipital/factories.ts';
import { SyntaxClient } from '../../../../../src/occipital/client.ts';
import { SyntaxRuntime } from '../../../../../src/syntax/runtime.ts';
import { RuntimeHealth } from '../../../../../src/runtime-health.ts';
import type { ProviderOptions } from '../../../../../src/occipital/provider.ts';
import type { StdioTransport } from '../../../../../src/occipital/stdio.ts';
import { semanticDescriptor } from '../../../../fixtures/semantic-provider.ts';
import { awaitFixture } from '../../../../fixtures/await-fixture.ts';
import { deferred, release } from '../../../../fixtures/factory-contract-support.ts';

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'occipital-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function healthFixture() {
  const notifications: string[] = [], health = new RuntimeHealth(message => notifications.push(message));
  // Disabled file logging: health must not depend on ERROR journal capture.
  const diagnostic = health.sink(() => {});
  return { notifications, health, diagnostic };
}
async function script(root: string, fault: 'malformed' | 'incompatible' | 'exit' | 'valid' | 'silent') {
  const command = join(root, 'owned-helper');
  const description = semanticDescriptor('', 'startup');
  if (fault === 'incompatible') description.body.protocol_version = 2;
  const reply = fault === 'malformed' ? { v: 4, status: 'ok', body: { secret: 'PRIVATE_BODY' } } : description;
  await writeFile(command, `#!${process.execPath}
${fault === 'exit' ? 'process.exit(7);' : fault === 'silent' ? 'process.stdin.resume();' : `let bytes=Buffer.alloc(0);process.stdin.on('data',chunk=>{
bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE(0)){
const n=bytes.readUInt32BE(0),r=JSON.parse(bytes.subarray(4,4+n));bytes=bytes.subarray(4+n);
const b=Buffer.from(JSON.stringify({...${JSON.stringify(reply)},ticket:r.ticket})),h=Buffer.alloc(4);
h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));}});`}
`);
  await chmod(command, 0o755);
  return command;
}
function tracked(t: TestContext, acquire: ProviderOptions['acquireOwned']) {
  const transports: StdioTransport[] = [];
  return { transports, acquire: async (signal: AbortSignal) => {
    const transport = await acquire(signal) as StdioTransport;
    transports.push(transport); t.after(() => transport.close());
    return transport;
  } };
}
function cleanup(transports: StdioTransport[]) {
  for (const transport of transports) {
    const stats = transport.stats();
    assert.equal(stats.childState, 'exited');
    for (const key of ['unsettledData', 'unsettledControl', 'retainedBytes', 'queuedFrames', 'liveTimers', 'abortListeners', 'ownedListeners'] as const)
      assert.equal(stats[key], 0, key);
    if (stats.pid) assert.throws(() => process.kill(stats.pid!, 0), { code: 'ESRCH' });
  }
}
function client(t: TestContext, acquireOwned: ProviderOptions['acquireOwned'], health = healthFixture()) {
  const value = new SyntaxClient({ standaloneVersion: '0.0.0', initialTheme: { kind: 'pi' }, diagnostic: health.diagnostic,
    provider: { tryShared: async () => undefined, acquireOwned } });
  t.after(() => value.dispose());
  return { value, ...health };
}
function brokerCleanup(value: SyntaxClient) {
  const stats = value.broker.stats();
  for (const key of ['activeCandidates', 'liveTimers', 'abortListeners', 'activeProbes'] as const) assert.equal(stats[key], 0, key);
  assert.equal(value.sources.stats().globalUnsettledJobs, 0);
}

for (const fault of ['nonexecutable', 'malformed', 'incompatible', 'exit'] as const) {
  test(`owned startup health: ${fault} through actual local factory/client/runtime reports with logging disabled and reaps`, async t => {
    const root = await directory(t), command = fault === 'nonexecutable' ? join(root, 'not-executable') : await script(root, fault);
    if (fault === 'nonexecutable') { await writeFile(command, 'PRIVATE_BINARY'); await chmod(command, 0o600); }
    let missing = 0;
    const owned = tracked(t, createLocalOwnedFactory({ command, requestDeadlineMs: 500, terminateGraceMs: 30, onMissing() { missing++; } }));
    const f = healthFixture(), completed = deferred<void>(), embedding: string[] = [];
    const runtime = new SyntaxRuntime({ standaloneVersion: '0.0.0', initialTheme: { kind: 'pi' }, diagnostic: f.diagnostic,
      provider: { tryShared: async () => undefined, acquireOwned: owned.acquire }, notify: message => embedding.push(message) });
    t.after(() => runtime.dispose());
    const view = { active: true, syntaxMetadataChanged() {
      if (runtime.snapshot().provider.availability === 'unavailable') completed.resolve();
    }, syntaxSourceChanged() {} };
    runtime.attach(view); await awaitFixture(completed.promise); await turn();
    assert.equal(runtime.snapshot().provider.availability, 'unavailable', 'optional public fallback still resolves');
    assert.equal(f.health.snapshot().errors, 1, 'abnormal owned startup is a runtime incident');
    assert.equal(f.health.snapshot().active, 1, 'generic runtime startup success cannot erase broker failure');
    assert.equal(f.health.snapshot().last?.code, 'startup_failed');
    assert.equal(f.notifications.length, 1); assert.equal(embedding.length, 0, 'real health notifier owns delivery');
    assert.equal(missing, 0);
    const fields = JSON.stringify(f.health.snapshot());
    for (const secret of [root, 'PRIVATE_BINARY', 'PRIVATE_BODY']) assert.equal(fields.includes(secret), false);
    assert.equal(owned.transports.length, fault === 'nonexecutable' ? 0 : 1);
    cleanup(owned.transports);
    await runtime.dispose(); assert.equal(f.health.snapshot().active, 0); assert.equal(f.health.snapshot().last?.state, 'released');
    assert.equal(runtime.sources.stats().globalUnsettledJobs, 0);
    void view;
  });
}

test('owned startup health: missing development build is expected and retains its missing-build notice', async t => {
  const root = await directory(t); let missing = 0;
  const f = client(t, createLocalOwnedFactory({ command: join(root, 'absent'), requestDeadlineMs: 500, terminateGraceMs: 30,
    onMissing() { missing++; } }));
  await awaitFixture(f.value.start()); await turn();
  assert.equal(f.value.snapshot().provider.reason, 'optional_unavailable');
  assert.equal(missing, 1); assert.equal(f.health.snapshot().errors, 0); assert.equal(f.notifications.length, 0);
  await f.value.dispose(); brokerCleanup(f.value);
});

test('owned startup health: verified release download failure is abnormal, not optional absence', async t => {
  const root = await directory(t);
  const f = client(t, createOwnedFactory({ cacheDir: root, release, requestDeadlineMs: 500, terminateGraceMs: 30,
    fetcher: async () => { throw new Error('PRIVATE_URL_TOKEN'); } }));
  await awaitFixture(f.value.start()); await turn();
  assert.equal(f.value.snapshot().provider.availability, 'unavailable');
  assert.equal(f.health.snapshot().errors, 1); assert.equal(f.notifications.length, 1);
  assert.equal(JSON.stringify(f.health.snapshot()).includes('PRIVATE_URL_TOKEN'), false);
  await f.value.dispose(); brokerCleanup(f.value);
});

test('owned startup health: actual acquisition deadline reports failure and cancels late response body', async t => {
  const root = await directory(t), started = deferred<void>(), response = deferred<Response>(), cancelled = deferred<void>();
  const f = client(t, createOwnedFactory({ cacheDir: root, release, attemptDeadlineMs: 30, requestDeadlineMs: 500, terminateGraceMs: 30,
    fetcher: async () => { started.resolve(); return response.promise; } }));
  const starting = f.value.start(); await awaitFixture(started.promise); await awaitFixture(starting); await turn();
  assert.equal(f.health.snapshot().errors, 1); assert.equal(f.notifications.length, 1);
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
  await awaitFixture(cancelled.promise);
  await f.value.dispose(); brokerCleanup(f.value);
});

for (const action of ['off', 'dispose'] as const) {
  test(`owned startup health: intentional ${action} during real release acquisition stays expected and cancels late body`, async t => {
    const root = await directory(t), started = deferred<void>(), response = deferred<Response>(), cancelled = deferred<void>();
    const f = client(t, createOwnedFactory({ cacheDir: root, release, requestDeadlineMs: 500, terminateGraceMs: 30,
      fetcher: async () => { started.resolve(); return response.promise; } }));
    const starting = f.value.start(); await awaitFixture(started.promise);
    await (action === 'off' ? f.value.setEnabled(false) : f.value.dispose()); await awaitFixture(starting);
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
    await awaitFixture(cancelled.promise); await turn();
    assert.equal(f.health.snapshot().errors, 0); assert.equal(f.notifications.length, 0);
    await f.value.dispose(); brokerCleanup(f.value);
  });
}

test('owned startup health: failed startup releases on Off, recovers on valid re-enable, and may fail again', async t => {
  const root = await directory(t), command = join(root, 'owned-helper');
  await writeFile(command, 'not executable'); await chmod(command, 0o600);
  const owned = tracked(t, createLocalOwnedFactory({ command, requestDeadlineMs: 500, terminateGraceMs: 30 }));
  const f = client(t, owned.acquire);
  await f.value.start(); await turn(); assert.equal(f.health.snapshot().active, 1); assert.equal(f.notifications.length, 1);
  await f.value.setEnabled(false); assert.equal(f.health.snapshot().active, 0);
  await script(root, 'valid'); await f.value.setEnabled(true); await turn();
  assert.equal(f.value.snapshot().provider.availability, 'ready'); assert.equal(f.health.snapshot().errors, 1); assert.equal(f.health.snapshot().active, 0);
  await f.value.setEnabled(false); cleanup(owned.transports);
  await chmod(command, 0o600); await f.value.setEnabled(true); await turn();
  assert.equal(f.health.snapshot().errors, 2); assert.equal(f.notifications.length, 2);
  await f.value.dispose(); brokerCleanup(f.value);
});

test('owned startup health: embedding without a runtime observer gets one fixed notification per failed episode', async t => {
  const root = await directory(t), notifications: string[] = [];
  const value = new SyntaxClient({ standaloneVersion: '0.0.0', initialTheme: { kind: 'pi' },
    provider: { tryShared: async () => undefined, acquireOwned: createOwnedFactory({ cacheDir: root, release,
      requestDeadlineMs: 500, terminateGraceMs: 30, fetcher: async () => { throw Error('PRIVATE'); } }) },
    notify: message => notifications.push(message) });
  t.after(() => value.dispose());
  await value.start(); await value.start(); await turn();
  assert.deepEqual(notifications, ['Syntax highlighting could not be started.']);
  await value.setEnabled(false); await value.setEnabled(true); await turn();
  assert.equal(notifications.length, 2);
  await value.dispose(); brokerCleanup(value);
});

for (const action of ['off', 'dispose'] as const) {
  test(`owned startup health: intentional ${action} during actual describe reaps without an incident`, async t => {
    const root = await directory(t), command = await script(root, 'silent'), describing = deferred<void>();
    const acquire = createLocalOwnedFactory({ command, requestDeadlineMs: 1000, terminateGraceMs: 30 });
    const owned = tracked(t, async signal => {
      const transport = await acquire(signal), request = transport.request.bind(transport);
      transport.request = (body, options) => {
        const pending = request(body, options);
        if (body.op === 'describe') describing.resolve();
        return pending;
      };
      return transport;
    });
    const f = client(t, owned.acquire), starting = f.value.start();
    await awaitFixture(describing.promise);
    await (action === 'off' ? f.value.setEnabled(false) : f.value.dispose()); await awaitFixture(starting); await turn();
    assert.equal(f.health.snapshot().errors, 0); assert.equal(f.notifications.length, 0);
    assert.equal(owned.transports.length, 1); cleanup(owned.transports);
    await f.value.dispose(); brokerCleanup(f.value);
  });

  test(`owned startup health: late owned factory transfer after ${action} closes the real child without publication or incident`, async t => {
    const root = await directory(t), command = await script(root, 'valid'), acquired = deferred<void>(), transfer = deferred<void>();
    const acquire = createLocalOwnedFactory({ command, requestDeadlineMs: 1000, terminateGraceMs: 30 });
    const owned = tracked(t, acquire);
    const f = client(t, async signal => { const transport = await owned.acquire(signal); acquired.resolve(); await transfer.promise; return transport; });
    const starting = f.value.start(); await awaitFixture(acquired.promise);
    await (action === 'off' ? f.value.setEnabled(false) : f.value.dispose()); await awaitFixture(starting);
    const transport = owned.transports[0]!;
    assert.equal(transport.stats().childState, 'running', 'broker has not received the held factory transfer');
    transfer.resolve(); await awaitFixture(transport.ended); await transport.close(); await turn();
    assert.equal(f.value.snapshot().provider.availability, action === 'off' ? 'disabled' : 'disposed');
    assert.equal(f.health.snapshot().errors, 0); assert.equal(f.notifications.length, 0);
    cleanup(owned.transports); await f.value.dispose(); brokerCleanup(f.value);
  });
}

test('owned startup health: runtime embedding without logging or health observer still notifies once', async t => {
  const root = await directory(t), command = join(root, 'broken'), notifications: string[] = [], completed = deferred<void>();
  await writeFile(command, 'not executable'); await chmod(command, 0o600);
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.0.0', initialTheme: { kind: 'pi' },
    provider: { tryShared: async () => undefined, acquireOwned: createLocalOwnedFactory({ command, requestDeadlineMs: 500, terminateGraceMs: 30 }) },
    notify: message => notifications.push(message) });
  t.after(() => runtime.dispose());
  const view = { active: true, syntaxMetadataChanged() {
    if (runtime.snapshot().provider.availability === 'unavailable') completed.resolve();
  }, syntaxSourceChanged() {} };
  runtime.attach(view); await awaitFixture(completed.promise); await turn();
  assert.deepEqual(notifications, ['Syntax highlighting could not be started.']);
  await runtime.dispose(); void view;
});

test('owned startup health: a present directory is broken, not a missing development build', async t => {
  const root = await directory(t); let missing = 0;
  const f = client(t, createLocalOwnedFactory({ command: root, requestDeadlineMs: 500, terminateGraceMs: 30,
    onMissing() { missing++; } }));
  await f.value.start(); await turn();
  assert.equal(f.health.snapshot().errors, 1); assert.equal(f.notifications.length, 1); assert.equal(missing, 0);
  await f.value.dispose(); brokerCleanup(f.value);
});

test('owned startup health: valid helper symlink stays usable and dangling helper symlink stays optional', async t => {
  const root = await directory(t), command = await script(root, 'valid'), linked = join(root, 'linked-helper');
  await symlink(command, linked);
  const owned = tracked(t, createLocalOwnedFactory({ command: linked, requestDeadlineMs: 500, terminateGraceMs: 30 }));
  const f = client(t, owned.acquire); await f.value.start();
  assert.equal(f.value.snapshot().provider.availability, 'ready'); assert.equal(f.health.snapshot().errors, 0);
  await f.value.setEnabled(false); cleanup(owned.transports); await rm(command);
  let missing = 0;
  const absent = client(t, createLocalOwnedFactory({ command: linked, requestDeadlineMs: 500, terminateGraceMs: 30,
    onMissing() { missing++; } }));
  await absent.value.start(); await turn();
  assert.equal(absent.value.snapshot().provider.reason, 'optional_unavailable');
  assert.equal(absent.health.snapshot().errors, 0); assert.equal(missing, 1);
  await f.value.dispose(); await absent.value.dispose(); brokerCleanup(f.value); brokerCleanup(absent.value);
});
