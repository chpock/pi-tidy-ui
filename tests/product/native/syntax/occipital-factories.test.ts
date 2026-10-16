import "../../../fixtures/test-guard.mjs";
import { deferred, bytes, release, setup } from "../../../fixtures/factory-contract-support.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createOwnedFactory } from "../../../../src/occipital/factories.ts";
import * as factories from "../../../../src/occipital/factories.ts";
import type { SharedFactoryOptions } from "../../../../src/occipital/factories.ts";
import { ProviderBroker, type ProviderTransport } from "../../../../src/occipital/provider.ts";
import { SharedTransport, type SharedSdk, type SharedClient, type SharedRouteHandle } from "../../../../src/occipital/shared.ts";
import { connectionCandidates } from "../../../../src/occipital/discovery.ts";
import { awaitFixture } from "../../../fixtures/await-fixture.ts";





test('owned pre-abort performs zero acquisition and zero spawn', async t => {
  const f = await setup(t), abort = new AbortController(); let fetches = 0;
  abort.abort();
  const acquire = createOwnedFactory({ cacheDir: f.cacheDir, release, requestDeadlineMs: 1000, terminateGraceMs: 30, fetcher: async () => { fetches++; return new Response(bytes); } });
  await assert.rejects(acquire(abort.signal), /owned factory unavailable/);
  assert.equal(fetches, 0); assert.equal(f.spawns(), 0);
});

test('abort during acquisition settles promptly; late delivery never spawns', async t => {
  const f = await setup(t), abort = new AbortController(), started = deferred<void>(), response = deferred<Response>();
  const acquire = createOwnedFactory({ cacheDir: f.cacheDir, release, requestDeadlineMs: 1000, terminateGraceMs: 30,
    fetcher: async () => { started.resolve(); return response.promise; } });
  const pending = acquire(abort.signal), rejected = assert.rejects(pending, /owned factory unavailable/);
  await started.promise; abort.abort(); await awaitFixture(rejected);
  assert.equal(f.spawns(), 0);
  const disposed = deferred<void>();
  response.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { disposed.resolve(); } })));
  await awaitFixture(disposed.promise); assert.equal(f.spawns(), 0);
});

test('owned absolute attempt deadline aborts underlying acquisition; no late spawn', async t => {
  const f = await setup(t), started = deferred<void>(), response = deferred<Response>(); let signal: AbortSignal | undefined;
  const acquire = createOwnedFactory({ cacheDir: f.cacheDir, release, attemptDeadlineMs: 30, requestDeadlineMs: 1000, terminateGraceMs: 30,
    fetcher: async (_url, init) => { signal = init?.signal ?? undefined; started.resolve(); return response.promise; } });
  const rejected = assert.rejects(acquire(new AbortController().signal), /owned factory unavailable/);
  await started.promise; await awaitFixture(rejected);
  assert.equal(signal?.aborted, true); assert.equal(f.spawns(), 0);
  const disposed = deferred<void>();
  response.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { disposed.resolve(); } })));
  await awaitFixture(disposed.promise); assert.equal(f.spawns(), 0);
});

test('cancellation at last acquisition continuation refuses spawn and preserves trusted release', async t => {
  const f = await setup(t), abort = new AbortController(); let fetches = 0;
  const acquire = createOwnedFactory({ cacheDir: f.cacheDir, release, requestDeadlineMs: 1000, terminateGraceMs: 30,
    fetcher: async () => { fetches++; abort.abort(); return new Response(bytes); } });
  await assert.rejects(acquire(abort.signal), /owned factory unavailable/);
  assert.equal(fetches, 1); assert.equal(f.spawns(), 0); assert.equal(release.sha256, createHash('sha256').update(bytes).digest('hex'));
});



test('local owned factory refuses pre-abort and missing binary without download, cache or spawn', async t => {
  assert.equal(typeof factories.createLocalOwnedFactory, 'function');
  const f = await setup(t), command = join(f.cacheDir, 'absent-local-binary');
  const abort = new AbortController(); abort.abort();
  let warnings = 0;
  const acquire = factories.createLocalOwnedFactory({ command, onMissing() { warnings++; }, requestDeadlineMs: 1000, terminateGraceMs: 30 });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; throw new Error('Local mode must not download'); });
  await assert.rejects(acquire(abort.signal), /owned factory unavailable/); assert.equal(warnings, 0);
  await assert.rejects(acquire(new AbortController().signal), /owned factory unavailable/); assert.equal(warnings, 1);
  const existing = join(f.cacheDir, process.platform === 'win32' ? 'occipital.exe' : 'occipital');
  await writeFile(existing, `#!${process.execPath}\nsetInterval(() => {}, 1000000);\n`); await chmod(existing, 0o755);
  const relativeAcquire = factories.createLocalOwnedFactory({ command: relative(process.cwd(), existing), onMissing() { warnings++; }, requestDeadlineMs: 1000, terminateGraceMs: 30 });
  await assert.rejects(async () => { const unexpected = await relativeAcquire(new AbortController().signal); await unexpected.close(); }, /owned factory unavailable/);
  assert.equal(warnings, 1);
  assert.equal(f.spawns(), 0); assert.equal(downloads, 0);
});


// Tiny public SDK adapter: the product SharedTransport owns all route/readiness cleanup.
const identity = { project_root: '/factory/project', harness: 'fixture', session: 'factory' };
const discovery = { env: { XDG_RUNTIME_DIR: '/factory/run', HOME: '/factory/home' }, tempDir: '/factory/tmp', uid: 7, platform: 'linux' as const };
const candidates = connectionCandidates(discovery);
function description(ticket: unknown) {
  return { v: 2, ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
    kind: 'descriptor', backend_version: '0.1.0', protocol_version: 2, category_version: 1, assets: 'assets', capability: 'syntax-highlight/v2', service: 'syntax',
    operations: ['describe', 'themes.refresh', 'highlight', 'stream.open', 'stream.append', 'stream.close'], modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'],
    catalogue_revision: 0, profiles: [{ id: 'pi', label: 'Pi palette', fingerprint: 'a'.repeat(64) }], diagnostic: null,
    runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
    limits: { request_bytes: 2097152, reply_bytes: 2097152, control_request_bytes: 4096, control_reply_bytes: 32768, source_bytes: 1048576, line_bytes: 8192, batch_sources: 8,
      queue_wait_ms: 1000, state_pool_bytes: 2097152, leases: 32, leases_per_route: 4, runs: 131072, styles: 512, idle_ms: 60000, age_ms: 300000, quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
  } };
}
function sdkFixture() {
  const connected: { file: string; timeout: number }[] = [], opened: SharedRouteHandle[] = [], routeCloses: SharedRouteHandle[] = [], closed: string[] = [];
  const requests: { file: string; handle: SharedRouteHandle; body: Record<string, unknown>; timeout: number }[] = [];
  let imports = 0;
  const hooks: {
    load?: () => Promise<void>;
    connect?: (file: string) => Promise<void>;
    resolve?: (file: string) => Promise<void>;
    open?: (file: string) => Promise<void>;
    reply?: (file: string, body: Record<string, unknown>) => Promise<unknown>;
  } = {};
  const sdk: SharedSdk = { SubcClient: { connect: async options => {
    const file = options.connectionFile; connected.push({ file, timeout: options.handshakeTimeoutMs });
    const route = Object.freeze({ channel: connected.length, epoch: 9 });
    const client: SharedClient = {
      resolveProvider: async () => { await hooks.resolve?.(file); return 'fixture-module'; },
      routeOpen: async () => { await hooks.open?.(file); opened.push(route); return route; },
      request: async (handle, bytes, options) => {
        const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
        requests.push({ file, handle, body, timeout: options.timeoutMs });
        return hooks.reply ? hooks.reply(file, body) : description(body.ticket);
      },
      closeRoute: async handle => { routeCloses.push(handle); },
      close: () => { closed.push(file); },
    };
    await hooks.connect?.(file); return client;
  } } };
  const loadSdk = async () => { imports++; await hooks.load?.(); return sdk; };
  const options: SharedFactoryOptions = { identity, discovery, requestDeadlineMs: 777, loadSdk };
  return { connected, opened, routeCloses, closed, requests, hooks, sdk, options, imports: () => imports };
}
function brokerFixture(f: ReturnType<typeof sdkFixture>, options = f.options) {
  let owned = 0; const ownedRequests: Record<string, unknown>[] = [], seen: ProviderTransport[] = [];
  const shared = factories.createSharedFactory(options);
  const broker = new ProviderBroker({
    tryShared: (signal, negotiate) => shared(signal, transport => { seen.push(transport); return negotiate(transport); }),
    acquireOwned: async () => {
      owned++; let endReason: 'closed' | undefined, resolveEnd!: (reason: 'closed') => void;
      const ended = new Promise<'closed'>(resolve => { resolveEnd = resolve; });
      return { ended, get endReason() { return endReason; }, request: async body => { ownedRequests.push(body); return description(body.ticket); },
        close: async () => { endReason = 'closed'; resolveEnd('closed'); } };
    },
  });
  return { broker, seen, ownedRequests, owned: () => owned };
}
function sourceFree(f: ReturnType<typeof sdkFixture>) {
  assert.ok(f.requests.every(call => call.body.op === 'describe'));
  for (const call of f.requests) assert.deepEqual(Object.keys(call.body).sort(), ['op', 'ticket', 'v']);
}
function emptyShared(transport: ProviderTransport) {
  assert.ok(transport instanceof SharedTransport);
  const stats = transport.stats(); assert.equal(stats.state, 'closed');
  for (const field of ['unsettledData', 'unsettledControl', 'liveTimers', 'abortListeners', 'encodedRequestBytes'] as const) assert.equal(stats[field], 0, field);
}
async function flushShared() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

test('shared factory negotiates first-ready bad metadata then exact later compatible candidate without owned acquisition', async t => {
  const f = sdkFixture(); f.hooks.reply = async (file, body) => file === candidates[0] ? { ...description(body.ticket), body: {} } : description(body.ticket);
  const s = brokerFixture(f); t.after(() => s.broker.dispose()); await s.broker.start();
  assert.equal(s.broker.snapshot().kind, 'shared'); assert.equal(s.owned(), 0); assert.equal(s.broker.stats().controls, 2);
  assert.deepEqual(f.connected.map(call => call.file), candidates.slice(0, 2)); assert.equal(f.opened.length, 2);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.closed, [candidates[0]]); assert.equal(f.routeCloses.length, 1);
  f.requests.forEach((call, index) => assert.equal(call.handle, f.opened[index])); assert.equal(f.routeCloses[0], f.opened[0]);
  assert.equal(s.seen.length, 2); emptyShared(s.seen[0]); assert.ok(s.seen[1] instanceof SharedTransport);
  assert.equal(s.seen[1].stats().state, 'ready');
  for (const field of ['unsettledData', 'unsettledControl', 'liveTimers', 'abortListeners', 'encodedRequestBytes'] as const) assert.equal(s.seen[1].stats()[field], 0, field);
  assert.equal(s.broker.stats().abortListeners, 0); assert.equal(s.broker.stats().liveTimers, 0); assert.equal(s.broker.stats().sourceDispatches, 0); sourceFree(f);
  await s.broker.dispose(); emptyShared(s.seen[1]); assert.equal(f.closed.length, 2); assert.equal(f.routeCloses.length, 2);
});

test('shared factory all metadata rejections exhaust ordered discovery then broker acquires owned exactly once', async t => {
  const f = sdkFixture(); f.hooks.reply = async (_file, body) => ({ ...description(body.ticket), body: {} });
  const s = brokerFixture(f); t.after(() => s.broker.dispose()); await s.broker.start();
  assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(s.owned(), 1);
  assert.deepEqual(f.connected.map(call => call.file), candidates); assert.equal(f.requests.length, 3);
  assert.equal(f.closed.length, 3); assert.equal(f.routeCloses.length, 3); assert.equal(f.opened.length, 3);
  assert.deepEqual(s.ownedRequests.map(body => body.op), ['describe']); s.seen.forEach(emptyShared); sourceFree(f);
});

for (const selection of ['explicit', 'env'] as const) test(`shared factory ${selection} connection failure stays exclusive`, async t => {
  const f = sdkFixture(); f.hooks.connect = async () => { throw new Error('fixture connection refused'); };
  const selected = `/factory/${selection}.json`;
  const selectedDiscovery = { ...discovery, env: { ...discovery.env, SUBC_CONNECTION_FILE: selection === 'env' ? selected : '/factory/ignored-env.json' }, ...(selection === 'explicit' ? { explicit: selected } : {}) };
  const s = brokerFixture(f, { ...f.options, discovery: selectedDiscovery }); t.after(() => s.broker.dispose()); await s.broker.start();
  assert.equal(s.owned(), 1); assert.deepEqual(f.connected.map(call => call.file), [selected]);
  assert.equal(f.opened.length, 0); assert.equal(f.requests.length, 0); sourceFree(f);
});

test('shared factory readiness failure closes first connection and tries later ready candidate', async t => {
  const f = sdkFixture(); f.hooks.resolve = async file => { if (file === candidates[0]) throw new Error('fixture capability unavailable'); };
  const s = brokerFixture(f); t.after(() => s.broker.dispose()); await s.broker.start();
  assert.equal(s.broker.snapshot().kind, 'shared'); assert.equal(s.owned(), 0); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.connected.map(call => call.file), candidates.slice(0, 2)); assert.deepEqual(f.closed, [candidates[0]]);
  assert.equal(f.opened.length, 1); assert.equal(f.routeCloses.length, 0); sourceFree(f);
});

test('shared factory pre-abort does zero SDK work, route work or metadata negotiation', async () => {
  const f = sdkFixture(), caller = new AbortController(); let negotiations = 0;
  caller.abort(); const result = await factories.createSharedFactory(f.options)(caller.signal, async () => { negotiations++; return true; });
  assert.equal(result, undefined); assert.equal(f.imports(), 0); assert.equal(f.connected.length, 0); assert.equal(f.requests.length, 0); assert.equal(negotiations, 0);
});

test('shared factory optional SDK import failure remains optional and source-free', async t => {
  const f = sdkFixture(); f.hooks.load = async () => { throw new Error('fixture missing optional SDK'); };
  const s = brokerFixture(f, { ...f.options, discovery: { explicit: '/factory/only' } }); t.after(() => s.broker.dispose()); await s.broker.start();
  assert.equal(s.owned(), 1); assert.equal(f.imports(), 1); assert.equal(f.connected.length, 0); assert.equal(f.requests.length, 0);
});

for (const stage of ['load', 'connect', 'resolve', 'open'] as const) test(`shared factory abort during ${stage} closes real transport and late public resources`, async t => {
  const f = sdkFixture(), caller = new AbortController(), started = deferred<void>(), late = deferred<void>(), retired: SharedTransport[] = [];
  const close = SharedTransport.prototype.close;
  t.mock.method(SharedTransport.prototype, 'close', function(this: SharedTransport) { retired.push(this); return close.call(this); });
  f.hooks[stage] = async () => { started.resolve(); await late.promise; };
  let negotiations = 0;
  const pending = factories.createSharedFactory(f.options)(caller.signal, async () => { negotiations++; return true; });
  await started.promise; caller.abort(); assert.equal(await awaitFixture(pending), undefined);
  late.resolve(); await flushShared();
  assert.equal(negotiations, 0); assert.equal(f.requests.length, 0); assert.ok(retired.length > 0); retired.forEach(emptyShared);
  assert.equal(f.connected.length, stage === 'load' ? 0 : 1);
  assert.equal(f.closed.length, stage === 'load' ? 0 : 1);
  assert.equal(f.routeCloses.length, stage === 'open' ? 1 : 0); sourceFree(f);
});

test('shared factory broker cancellation during metadata closes route, drains controls and rejects late publication', async t => {
  const f = sdkFixture(), started = deferred<void>(), late = deferred<unknown>();
  let ticket: unknown;
  f.hooks.reply = async (_file, body) => { ticket = body.ticket; started.resolve(); return late.promise; };
  const s = brokerFixture(f); t.after(() => s.broker.dispose()); const pending = s.broker.start();
  await started.promise; await s.broker.dispose(); await pending;
  assert.equal(s.owned(), 0); assert.equal(f.requests.length, 1); assert.equal(f.closed.length, 1); assert.equal(f.routeCloses.length, 1);
  s.seen.forEach(emptyShared); late.resolve(description(ticket)); await flushShared(); s.seen.forEach(emptyShared);
  assert.equal(s.broker.snapshot().availability, 'disposed'); assert.equal(f.requests.length, 1); sourceFree(f);
});

test('shared factory one absolute budget spans candidates and metadata despite delayed timer delivery', async t => {
  const f = sdkFixture(); let now = 0, negotiations = 0;
  t.mock.method(performance, 'now', () => now);
  const result = await factories.createSharedFactory({ ...f.options, attemptDeadlineMs: 100 })(new AbortController().signal, async transport => {
    negotiations++; await transport.request({ v: 2, op: 'describe', ticket: `fixture:${negotiations}` });
    if (negotiations === 1) { await transport.close(); now = 60; return false; }
    now = 100; return true;
  });
  assert.equal(result, undefined); assert.equal(negotiations, 2); assert.deepEqual(f.connected.map(call => call.timeout), [100, 40]);
  assert.equal(f.requests.length, 2); assert.equal(f.closed.length, 2); assert.equal(f.routeCloses.length, 2); sourceFree(f);
});

test('shared factory transfer releases caller listener and keeps configured public request deadline', async t => {
  const f = sdkFixture(), caller = new AbortController(); let now = 0;
  t.mock.method(performance, 'now', () => now);
  const selected = await factories.createSharedFactory({ ...f.options, attemptDeadlineMs: 100 })(caller.signal, async () => { now = 80; return true; });
  assert.ok(selected instanceof SharedTransport); t.after(() => selected.close());
  caller.abort(); await flushShared(); assert.equal(selected.stats().state, 'ready'); assert.equal(f.closed.length, 0); assert.equal(f.requests.length, 0);
  await selected.request({ v: 2, op: 'describe', ticket: 'fixture:published' });
  assert.deepEqual(f.requests.map(call => call.timeout), [777]); assert.deepEqual(f.connected.map(call => call.timeout), [100]);
  await selected.close(); emptyShared(selected); assert.equal(f.closed.length, 1); assert.equal(f.routeCloses.length, 1); sourceFree(f);
});

test('shared factory caller may narrow but cannot extend existing 5s attempt allowance', async t => {
  const f = sdkFixture(); t.mock.method(performance, 'now', () => 0);
  const selected = await factories.createSharedFactory({ ...f.options, attemptDeadlineMs: 6000 })(new AbortController().signal, async () => true);
  assert.ok(selected instanceof SharedTransport); t.after(() => selected.close());
  assert.deepEqual(f.connected.map(call => call.timeout), [5000]); assert.equal(f.requests.length, 0);
  await selected.close(); emptyShared(selected);
});
