import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestFailure } from '../src/occipital/request-failure.ts';
import { SharedTransport, SHARED_LIMITS, type SharedSdk, type SharedClient, type SharedRouteHandle } from '../src/occipital/shared.ts';
import { awaitFixture } from './fixtures/await-fixture.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const identity = { project_root: '/fixture/project', harness: 'fixture', session: 'session' };
const request = (ticket: string, op = 'highlight', text = '') => ({ v: 2, ticket, op, text });
const reply = (ticket: string) => ({ v: 2, ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {} });
function fixture() {
  const route: SharedRouteHandle = Object.freeze({ channel: 7, epoch: 9 });
  const calls: { handle: SharedRouteHandle; bytes: Uint8Array; options: { binary?: boolean; timeoutMs?: number; signal?: AbortSignal }; result: ReturnType<typeof deferred<unknown>> }[] = [];
  const connect = deferred<SharedClient>(), catalog = deferred<string>(), open = deferred<SharedRouteHandle>();
  const observed: unknown[] = [];
  let closes = 0, routeCloses = 0, push!: (value: { op: string; body: Record<string, unknown> }) => void;
  const client: SharedClient = {
    resolveProvider: capability => { observed.push(capability); return catalog.promise; },
    routeOpen: (target, bind, options) => { observed.push([target, bind, options]); return open.promise; },
    request: (handle, bytes, options) => { const result = deferred<unknown>(); calls.push({ handle, bytes, options, result }); return result.promise; },
    closeRoute: async handle => { assert.equal(handle, route); routeCloses++; },
    close: () => { closes++; },
  };
  const sdk: SharedSdk = { SubcClient: { connect: options => { observed.push(options.connectionFile); push = options.onControlPush; return connect.promise; } } };
  function transport(initDeadlineMs = 3000, loader: () => Promise<SharedSdk> = async () => sdk) {
    return new SharedTransport({ connectionFile: '/fixture/connection.json', identity, initDeadlineMs, requestDeadlineMs: 3000, loadSdk: loader, dataBytes:2*1024*1024 });
  }
  async function ready(p: SharedTransport) { connect.resolve(client); catalog.resolve('occipital'); open.resolve(route); await p.ready; }
  return { route, calls, connect, catalog, open, observed, client, sdk, transport, ready, push: (value: Parameters<typeof push>[0]) => push(value), counts: () => ({ closes, routeCloses }) };
}
function empty(p: SharedTransport) {
  assert.equal(p.stats().state, 'closed');
  for (const key of ['unsettledData', 'unsettledControl', 'dataReservedBytes', 'controlReservedBytes', 'encodedRequestBytes', 'liveTimers', 'abortListeners'] as const) assert.equal(p.stats()[key], 0, key);
}
async function tick() { await delay(0); }

test('optional import rejection is handled and diagnostics never echo raw errors', async t => {
  const f = fixture(); let imports = 0;
  const p = f.transport(3000, async () => { imports++; throw new Error('credential /private/path source'); });
  await assert.rejects(p.ready, { message: 'shared initialization failed' });
  assert.equal(imports, 1); await p.close(); empty(p);
  const missing = new SharedTransport({ connectionFile: '/fixture/missing', identity, initDeadlineMs: 1000, requestDeadlineMs: 1000 });
  // The readiness notification intentionally does not keep its transport alive.
  t.after(() => missing.close());
  await assert.rejects(missing.ready, /initialization/); await missing.close(); empty(missing);
});

for (const stage of ['import', 'connect', 'catalog', 'open'] as const) test(`close during ${stage} disposes late public resources without publishing readiness`, async () => {
  const f = fixture(), imported = deferred<SharedSdk>();
  const p = f.transport(3000, () => imported.promise);
  const refused = assert.rejects(p.ready, /closed/);
  if (stage !== 'import') { imported.resolve(f.sdk); await tick(); }
  if (stage === 'catalog' || stage === 'open') { f.connect.resolve(f.client); await tick(); }
  if (stage === 'open') { f.catalog.resolve('occipital'); await tick(); }
  await p.close(); await refused;
  imported.resolve(f.sdk); f.connect.resolve(f.client); f.catalog.resolve('occipital'); f.open.resolve(f.route);
  await tick(); await p.close(); empty(p);
  assert.equal(f.counts().closes, stage === 'import' ? 0 : 1);
  assert.equal(f.counts().routeCloses, stage === 'open' ? 1 : 0);
});

for (const stage of ['import', 'connect', 'catalog', 'open'] as const) test(`finite ${stage} deadline owns late cleanup`, async () => {
  const f = fixture(), imported = deferred<SharedSdk>();
  const p = f.transport(15, () => imported.promise);
  const refused = assert.rejects(p.ready, /initialization deadline/);
  if (stage !== 'import') { imported.resolve(f.sdk); await tick(); }
  if (stage === 'catalog' || stage === 'open') { f.connect.resolve(f.client); await tick(); }
  if (stage === 'open') { f.catalog.resolve('occipital'); await tick(); }
  await awaitFixture(refused); empty(p);
  imported.resolve(f.sdk); f.connect.resolve(f.client); f.catalog.resolve('occipital'); f.open.resolve(f.route); await tick();
  assert.equal(f.counts().closes, stage === 'import' ? 0 : 1);
  assert.equal(f.counts().routeCloses, stage === 'open' ? 1 : 0);
});

for (const code of ['capability_ambiguous', 'capability_unprovided', 'route_rejected']) test(`public ${code} fails closed without retry or raw diagnostics`, async () => {
  const f = fixture(), p = f.transport(); f.connect.resolve(f.client);
  if (code === 'route_rejected') { f.catalog.resolve('occipital'); f.open.reject({ code, message: 'secret' }); }
  else f.catalog.reject({ code, message: 'secret' });
  await assert.rejects(p.ready, { message: 'shared initialization failed' });
  assert.equal(f.calls.length, 0); assert.equal(f.counts().closes, 1); empty(p);
});

test('explicit public connect, sole capability and complete route identity; no init request queue', async () => {
  const f = fixture(), p = f.transport();
  await assert.rejects(p.request(request('early')), /not ready/);
  await f.ready(p);
  assert.deepEqual(f.observed, ['/fixture/connection.json', 'syntax-highlight/v2', [{ kind: 'internal_service', module_id: 'occipital', service_id: 'syntax' }, identity, { consumerIdentity: null }]]);
  const a = p.request(request('a', 'highlight', 'é\t🙂\n'));
  assert.equal(f.calls[0].handle, f.route); assert.equal(f.calls[0].options.binary, false);
  assert.deepEqual(JSON.parse(Buffer.from(f.calls[0].bytes).toString()), request('a', 'highlight', 'é\t🙂\n'));
  f.calls[0].result.resolve(reply('a')); assert.deepEqual(await a, reply('a'));
  await p.close(); empty(p); assert.deepEqual(f.counts(), { closes: 1, routeCloses: 1 });
});

test('two data calls plus independent metadata; reverse settlement and no invisible queue', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const a = p.request(request('a')), b = p.request(request('b')), c = p.request(request('c', 'describe'));
  assert.equal(p.stats().unsettledData, 2); assert.equal(p.stats().unsettledControl, 1);
  assert.equal(p.stats().controlReservedBytes, SHARED_LIMITS.controlReservationBytes);
  const bomb = Object.defineProperty(request('overflow'), 'text', { get() { assert.fail('capacity refusal must precede source read'); } });
  await assert.rejects(p.request(bomb), /capacity/);
  await assert.rejects(p.request(request('metadata-extra', 'themes.refresh')), /capacity/);
  assert.equal(f.calls.length, 3);
  f.calls[2].result.resolve(reply('c')); await c;
  f.calls[1].result.resolve(reply('b')); await b;
  f.calls[0].result.resolve(reply('a')); await a;
  assert.equal(p.stats().dataReservedBytes, 0); await p.close(); empty(p);
});

test('bounded UTF8/escaped JSON preflight, no serialization hooks or SDK call on refusal', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  for (const ticket of ['', 'x'.repeat(65), '\ud800', 'a\n']) await assert.rejects(p.request(request(ticket)), /request/);
  for (const text of ['x'.repeat(2*1024*1024), '\u0000'.repeat(400000)]) await assert.rejects(p.request(request('large', 'highlight', text)), /byte limit/);
  await assert.rejects(p.request(request('control', 'describe', 'x'.repeat(4096))), /byte limit/);
  const cycle = request('cyclic') as Record<string, unknown>; cycle.self = cycle;
  await assert.rejects(p.request(cycle), /JSON/);
  await assert.rejects(p.request({ ...request('bad'), v: 1 }), /header/);
  await assert.rejects(p.request({ ...request('bad'), op: 'call' }), /header/);
  await assert.rejects(p.request(Object.defineProperty(request('hook'), 'toJSON', { value() { assert.fail('hook called'); } })), /JSON/);
  await assert.rejects(p.request(request('surrogate', 'highlight', '\ud800')), /JSON/);
  assert.equal(f.calls.length, 0); await p.close(); empty(p);
});

test('full data reservation does not consume metadata credit', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const overhead = Buffer.byteLength(JSON.stringify(request('a')));
  const a = p.request(request('a', 'highlight', 'x'.repeat(2*1024*1024 - overhead)));
  const b = p.request(request('b', 'highlight', 'x'.repeat(2*1024*1024 - overhead)));
  assert.equal(p.stats().dataReservedBytes, 8*1024*1024);
  assert.equal(p.stats().encodedRequestBytes, 4*1024*1024);
  const c = p.request(request('c', 'describe'));
  assert.equal(p.stats().controlReservedBytes, 65536);
  const ended = [a, b, c].map(call => assert.rejects(call, /closed/));
  await p.close(); await Promise.all(ended); empty(p);
});

test('abort is best effort: SDK signal, credit and promise held until terminal settlement', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p); const abort = new AbortController();
  const a = p.request(request('a'), { signal: abort.signal }); const rejected = assert.rejects(a, /aborted after settlement/);
  const b = p.request(request('b')); const bytes = p.stats().dataReservedBytes;
  abort.abort(); assert.equal(f.calls[0].options.signal?.aborted, true);
  assert.equal(p.stats().dataReservedBytes, bytes); assert.equal(p.stats().unsettledData, 2);
  await assert.rejects(p.request(request('extra')), /capacity/);
  f.calls[0].result.resolve(reply('a')); await rejected;
  const c = p.request(request('c')); f.calls[2].result.resolve(reply('c')); await c;
  f.calls[1].result.resolve(reply('b')); await b;
  assert.equal(p.stats().abortListeners, 0); await p.close(); empty(p);
});

for (const malformed of [reply('other'), { ...reply('a'), v: 1 }, { ...reply('a'), instance: 'x'.repeat(65) }, { ...reply('a'), status: 'error', error: { code: 'bad', execution: 'started' } }, { ...reply('a'), error: {} }]) test('strict reply header/outcome/correlation retires entire owned connection', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const a = p.request(request('a')), b = p.request(request('b'));
  const rejected = [a, b].map(call => assert.rejects(call, /reply/));
  f.calls[0].result.resolve(malformed); await Promise.all(rejected); empty(p);
  assert.equal(f.counts().closes, 1);
});

test('reply body is not reserialized for a fictional predecode byte cap', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const body = Object.defineProperty({}, 'toJSON', { value() { assert.fail('reply stringify called'); } });
  const call = p.request(request('a')); f.calls[0].result.resolve({ ...reply('a'), body });
  assert.equal((await call as { body: unknown }).body, body); await p.close();
});

for (const failure of [{ code: 'request_deadline' }, { kind: 'outcome_unknown' }, { code: 'stale_route_handle' }, { code: 'unknown_channel' }, new Error('credential source')]) test('SDK unknown/deadline/route failures retire before admitting replacement', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const a = p.request(request('a')), b = p.request(request('b'));
  const rejected = [a, b].map(call => assert.rejects(call, { message: 'shared request failed; outcome uncertain' }));
  f.calls[0].result.reject(failure); await Promise.all(rejected); empty(p);
  await assert.rejects(p.request(request('c')), /not ready/); assert.equal(f.calls.length, 2);
});

test('outer finite request deadline closes owned connection and clears listener/timer ownership', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p); const signal = new AbortController().signal;
  const a = p.request(request('a'), { deadlineMs: 15, signal }); const rejected = assert.rejects(a, /request deadline/);
  assert.equal(p.stats().liveTimers, 1); assert.equal(p.stats().abortListeners, 1);
  await awaitFixture(rejected); empty(p); assert.equal(f.counts().closes, 1);
  f.calls[0].result.resolve(reply('a')); await tick(); empty(p);
});

test('public route-close observer retires only owned matching route and is inert after close', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  f.push({ op: 'route.closed', body: { channels: [8], reason: 'module_stopped' } }); assert.equal(p.stats().state, 'ready');
  const a = p.request(request('a')); const ended = assert.rejects(a, /route lost/);
  f.push({ op: 'route.closed', body: { channels: [7], reason: 'module_stopped' } }); await ended;
  await p.close(); f.push({ op: 'route.closed', body: { channels: [7], reason: 'module_stopped' } }); empty(p);
  assert.equal(f.counts().closes, 1);
});

test('bounded explicit connection and identity validation never invokes loader', () => {
  let imports = 0; const loadSdk = async () => { imports++; return fixture().sdk; };
  for (const connectionFile of ['', 'x'.repeat(4097), 'bad\u0000path']) assert.throws(() => new SharedTransport({ connectionFile, identity, loadSdk, initDeadlineMs: 100, requestDeadlineMs: 100 }), /options/);
  assert.throws(() => new SharedTransport({ connectionFile: '/fixture', identity: { ...identity, session: 'x'.repeat(257) }, loadSdk, initDeadlineMs: 100, requestDeadlineMs: 100 }), /options/);
  assert.equal(imports, 0);
});


test('connection refusal and invalid complete route handle close finite initialization', async () => {
  const f = fixture(), p = f.transport(); f.connect.reject(new Error('/secret'));
  await assert.rejects(p.ready, { message: 'shared initialization failed' }); empty(p);
  const second = fixture(), q = second.transport(); second.connect.resolve(second.client); second.catalog.resolve('occipital');
  second.open.resolve({ channel: 0, epoch: 1 });
  // This fake closeRoute normally asserts exact identity; throwing cleanup is contained.
  await assert.rejects(q.ready, /invalid route/); empty(q); assert.equal(second.counts().closes, 1);
});

test('already aborted and active duplicate calls do not encode or dispatch; terminal errors release exactly once', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(p.request(request('unused'), { signal: abort.signal }), /before dispatch/);
  await assert.rejects(p.request(Object.defineProperty(request('hidden'), 'ticket', { value: 'hidden', enumerable: false })), /header/);
  assert.equal(p.stats().serializedRequests, 0);
  const a = p.request(request('a'));
  await assert.rejects(p.request(request('a', 'describe')), /duplicate ticket/);
  assert.equal(p.stats().serializedRequests, 1); assert.equal(f.calls.length, 1);
  const error = { v: 2, ticket: 'a', instance: 'instance', assets: 'assets', status: 'error', error: { code: 'busy', execution: 'not_started' } };
  f.calls[0].result.resolve(error); assert.deepEqual(await a, error);
  assert.equal(p.stats().dataReservedBytes, 0); assert.equal(p.stats().state, 'ready');
  const b = p.request(request('b', 'themes.refresh')); f.calls[1].result.resolve(reply('b')); await b;
  assert.equal(p.stats().serializedRequests, 2);
  await p.close(); empty(p);
});

test('close disposes an unresolved public route cleanup without waiting or retaining request credit', async () => {
  const f = fixture(); const stuck = deferred<void>(); let closes = 0;
  f.client.closeRoute = () => { closes++; return stuck.promise; };
  const p = f.transport(); await f.ready(p);
  const a = p.request(request('a')); const ended = assert.rejects(a, /closed/);
  assert.equal(p.close(), p.close()); await p.close(); await ended; empty(p);
  assert.equal(closes, 1); assert.equal(f.counts().closes, 1);
  stuck.reject(new Error('/private cleanup')); await tick(); empty(p);
});

test('production JSON family admits escaped data beyond the former two-MiB ceiling', async () => {
  const f=fixture(), p=new SharedTransport({connectionFile:'/fixture/connection.json',identity,initDeadlineMs:3000,requestDeadlineMs:3000,loadSdk:async()=>f.sdk});
  await f.ready(p);
  try {
    assert.equal(SHARED_LIMITS.requestBytes,64<<20);
    const text='\u0000'.repeat(400000), sent=request('ordinary-escaped','highlight',text);
    const pending=p.request(sent);
    assert.equal(f.calls.length,1);
    assert.ok(f.calls[0]!.bytes.byteLength>2<<20);
    assert.deepEqual(JSON.parse(Buffer.from(f.calls[0]!.bytes).toString()),sent);
    assert.equal(p.stats().serializedRequests,1);
    f.calls[0]!.result.resolve(reply('ordinary-escaped')); await pending;
    assert.equal(p.stats().dataReservedBytes,0);
  } finally { await p.close(); }
  empty(p);
});

test('narrower data allowance cannot expand the public transport family', () => {
  const f=fixture();
  for(const dataBytes of [0,-1,Infinity,1.5,SHARED_LIMITS.requestBytes+1]) {
    assert.throws(()=>new SharedTransport({connectionFile:'/fixture/connection.json',identity,initDeadlineMs:3000,requestDeadlineMs:3000,loadSdk:async()=>f.sdk,dataBytes}),/data allowance/);
  }
  assert.equal(f.observed.length,0);
});

function disposition(expected: 'not_started' | 'unknown') {
  return (error: unknown) => { assert.ok(error instanceof RequestFailure);assert.equal(error.execution,expected);return true; };
}

test('typed shared local refusal proves no SDK request and does not revoke held work', async()=> {
  const f=fixture(),p=f.transport();
  try {
    await assert.rejects(p.request(request('early')),disposition('not_started'));
    assert.equal(f.calls.length,0);await f.ready(p);
    const abort=new AbortController();abort.abort();
    await assert.rejects(p.request(request('aborted'),{signal:abort.signal}),disposition('not_started'));
    await assert.rejects(p.request({...request('invalid'),v:99}),disposition('not_started'));
    assert.equal(f.calls.length,0);
    const a=p.request(request('a')),b=p.request(request('b'));
    await assert.rejects(p.request(request('capacity')),disposition('not_started'));
    assert.equal(f.calls.length,2);assert.equal(p.stats().unsettledData,2);
    f.calls[0].result.resolve(reply('a'));f.calls[1].result.resolve(reply('b'));await Promise.all([a,b]);
  } finally { await p.close();empty(p); }
});

test('typed shared post-dispatch rejection stays unknown even for a capacity-like message', async()=> {
  const f=fixture(),p=f.transport();await f.ready(p);
  const ended=assert.rejects(p.request(request('sent')),disposition('unknown'));
  f.calls[0].result.reject(Error('shared request capacity'));
  await ended;await p.close();empty(p);
});

class PublicSdkFailure extends Error {
  readonly closeReason: string;
  constructor(reason: string) { super('opaque SDK failure'); this.closeReason = reason; }
}
class PublicStaleHandleFailure extends Error {}

for (const reason of ['crash', 'restart', 'reload']) test(`typed SDK ${reason} supplies lifetime loss proof without no-start`, async () => {
  const f = fixture(); f.sdk.SubcError = PublicSdkFailure;
  const p = f.transport(); await f.ready(p);
  assert.equal(p.endReason, undefined);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  f.calls[0]!.result.reject(new PublicSdkFailure(reason));
  await rejected;
  assert.equal(await p.ended, 'lost');
  assert.equal(p.endReason, 'lost');
  await p.close(); empty(p);
});

test('public stale-handle class reveals quiet loss; a matching string/code is not that proof', async () => {
  const f = fixture(); f.sdk.StaleRouteHandleError = PublicStaleHandleFailure;
  const p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  f.calls[0]!.result.reject(new PublicStaleHandleFailure()); await rejected;
  assert.equal(await p.ended, 'lost'); await p.close(); empty(p);
  const other = fixture(); other.sdk.StaleRouteHandleError = PublicStaleHandleFailure;
  const q = other.transport(); await other.ready(q);
  const unknown = assert.rejects(q.request(request('unknown')), disposition('unknown'));
  other.calls[0]!.result.reject({ code: 'stale_route_handle', closeReason: 'connection_lost' }); await unknown;
  assert.equal(await q.ended, 'uncertain'); await q.close(); empty(q);
});

for (const reason of ['disable', 'scope_ended', 'capability_denied', 'unknown']) test(`policy ${reason} closure cannot authorize automatic recovery`, async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  f.push({ op: 'route.closed', body: { channels: [7], reason } });
  assert.equal(await p.ended, 'denied'); await p.close(); empty(p);
});

test('matching idle route restart is observable; unrelated pushes and request abort are not loss', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  f.push({ op: 'route.closed', body: { channels: [8], reason: 'restart' } });
  assert.equal(p.endReason, undefined);
  const abort = new AbortController();
  const rejected = assert.rejects(p.request(request('sent'), { signal: abort.signal }), disposition('unknown'));
  abort.abort(); assert.equal(p.endReason, undefined);
  f.calls[0]!.result.resolve(reply('sent')); await rejected;
  assert.equal(p.endReason, undefined);
  f.push({ op: 'route.closing', body: { channels: [7], reason: 'restart' } });
  assert.equal(await p.ended, 'lost'); await p.close(); empty(p);
});

test('local deadline and owner-close callbacks cannot later upgrade to unexpected loss', async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent'), { deadlineMs: 15 }), disposition('unknown'));
  await awaitFixture(rejected); assert.equal(await p.ended, 'uncertain');
  f.push({ op: 'route.closed', body: { channels: [7], reason: 'crash' } });
  assert.equal(await p.ended, 'uncertain'); empty(p);
  const other = fixture(), q = other.transport(); await other.ready(q); await q.close();
  assert.equal(await q.ended, 'closed'); empty(q);
});

test('public SocketClosedError identifies quiet connection loss without a fabricated SDK callback', async () => {
  class ClosedSocket extends Error {}
  const f = fixture(); f.sdk.SocketClosedError = ClosedSocket;
  const p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  f.calls[0]!.result.reject(new ClosedSocket()); await rejected;
  assert.equal(await p.ended, 'lost'); await p.close(); empty(p);
});

test('typed caller closure remains local, not a failover proof', async () => {
  const f = fixture(); f.sdk.SubcError = PublicSdkFailure;
  const p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  f.calls[0]!.result.reject(new PublicSdkFailure('closed_by_caller')); await rejected;
  assert.equal(await p.ended, 'closed'); await p.close(); empty(p);
});

function pendingLifetime(f: ReturnType<typeof fixture>) {
  const p = f.transport();
  // Holding this notification must not keep its owner alive across SDK awaits.
  return { owner: new WeakRef(p), ended: p.ended };
}
test('first lifecycle owner collects during public connect while its notification and another owner survive', { skip: !global.gc }, async () => {
  const first = fixture(), held = pendingLifetime(first);
  const second = fixture(), live = second.transport(); await second.ready(live);
  try {
    for (let i = 0; i < 100; i++) {
      await tick(); global.gc!(); await tick();
      if (!held.owner.deref()) break;
    }
    assert.equal(held.owner.deref(), undefined);
    first.connect.resolve(first.client); first.catalog.resolve('occipital'); first.open.resolve(first.route);
    await tick();
    assert.equal(first.counts().closes, 1);
    assert.equal(first.counts().routeCloses, 0);
    assert.equal(live.stats().state, 'ready');
    assert.equal(live.endReason, undefined);
    assert.equal(held.ended instanceof Promise, true);
  } finally { await live.close(); empty(live); }
});

test('SDK route-death helper receives its public flags/code signature, not a guessed error argument', async () => {
  class RouteFailure extends Error { code = 'unknown_channel'; }
  const f = fixture(); f.sdk.SubcError = RouteFailure;
  const observed: unknown[] = [];
  f.sdk.isEstablishedRouteDead = (flags, code) => { observed.push([flags, code]); return code === 'unknown_channel'; };
  const p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  f.calls[0]!.result.reject(new RouteFailure()); await rejected;
  assert.deepEqual(observed, [[0, 'unknown_channel']]);
  assert.equal(await p.ended, 'lost'); await p.close(); empty(p);
});

test('review: SDK deadline-normalized connection_lost is not proof of a peer failure', async () => {
  const f = fixture(); f.sdk.SubcError = PublicSdkFailure;
  const p = f.transport(); await f.ready(p);
  const rejected = assert.rejects(p.request(request('sent')), disposition('unknown'));
  // SDK fail() gives this exact public shape to a pending route call after
  // SocketTimeoutError as well as SocketClosedError; neither cause survives.
  f.calls[0]!.result.reject(new PublicSdkFailure('connection_lost')); await rejected;
  assert.equal(await p.ended, 'uncertain'); assert.equal(p.endReason, 'uncertain');
  await p.close(); assert.equal(p.endReason, 'uncertain'); empty(p);
});


test('wait-only catalogue expiry rejects just its waiter and holds control credit until the SDK settles', async t => {
  const f = fixture(), p = f.transport(); await f.ready(p); t.after(() => p.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = p.request(request('data', 'highlight', 'x'), { deadlineMs: 30000 });
  void a.catch(() => {});
  const c = p.request(request('catalogue', 'themes.refresh'), { deadlineMs: 5, waitOnly: true });
  const refused = assert.rejects(c, { message: 'shared control wait deadline', execution: 'unknown' });
  const bytes = p.stats().encodedRequestBytes, control = p.stats().controlReservedBytes;
  t.mock.timers.tick(5); await refused;
  assert.equal(p.stats().state, 'ready'); assert.equal(p.endReason, undefined);
  assert.equal(p.stats().unsettledControl, 1); assert.equal(p.stats().controlReservedBytes, control);
  assert.equal(p.stats().encodedRequestBytes, bytes); assert.equal(p.stats().liveTimers, 1);
  assert.deepEqual(f.counts(), { closes: 0, routeCloses: 0 });
  await assert.rejects(p.request(request('again', 'describe'), { waitOnly: true }), (e: unknown) => e instanceof RequestFailure && e.execution === 'not_started' && /capacity/.test(e.message));
  assert.equal(f.calls.length, 2);
  f.calls[0].result.resolve(reply('data')); await a;
  const b = p.request(request('second-data', 'highlight', 'y'));
  f.calls[2].result.resolve(reply('second-data')); await b;
  assert.equal(p.stats().unsettledControl, 1); assert.equal(p.stats().unsettledData, 0);
  f.calls[1].result.resolve(reply('catalogue')); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.stats().unsettledControl, 0); assert.equal(p.stats().encodedRequestBytes, 0);
  const next = p.request(request('fresh', 'describe'), { waitOnly: true });
  f.calls[3].result.resolve(reply('fresh')); await next;
  assert.equal(f.calls.length, 4); await p.close(); empty(p); t.mock.timers.reset();
});

test('wait-only expired catalogue SDK rejection frees only its actual settled control lane', async t => {
  const f = fixture(), p = f.transport(); await f.ready(p); t.after(() => p.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = p.request(request('data'), { deadlineMs: 30000 }); void a.catch(() => {});
  const c = p.request(request('catalogue', 'describe'), { deadlineMs: 5, waitOnly: true });
  const refused = assert.rejects(c, /control wait deadline/); t.mock.timers.tick(5); await refused;
  f.calls[1].result.reject(new Error('private path source timeout')); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.stats().state, 'ready'); assert.equal(p.stats().unsettledControl, 0);
  assert.equal(p.stats().controlReservedBytes, 0); assert.equal(p.stats().unsettledData, 1);
  assert.equal(p.endReason, undefined); assert.deepEqual(f.counts(), { closes: 0, routeCloses: 0 });
  f.calls[0].result.resolve(reply('data')); await a; await p.close(); empty(p); t.mock.timers.reset();
});

test('wait-only control cannot hide a confirmed public route loss after its wait expired', async t => {
  const f = fixture(), p = f.transport(); await f.ready(p); t.after(() => p.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = p.request(request('data'), { deadlineMs: 30000 }), sourceRejected = assert.rejects(a, /route lost/);
  void sourceRejected.catch(() => {}); // still awaited below; avoid stray rejection if the earlier control assertion fails
  const c = p.request(request('catalogue', 'describe'), { deadlineMs: 5, waitOnly: true });
  const refused = assert.rejects(c, /control wait deadline/); t.mock.timers.tick(5); await refused;
  f.push({ op: 'route.closed', body: { channels: [7], reason: 'restart' } });
  await sourceRejected; assert.equal(await p.ended, 'lost'); empty(p); t.mock.timers.reset();
});

test('wait-only is rejected before dispatch on the source lane', async t => {
  const f = fixture(), p = f.transport(); await f.ready(p); t.after(() => p.close());
  const result = p.request(request('source'), { waitOnly: true });
  const refusal = assert.rejects(result, (e: unknown) => e instanceof RequestFailure && e.execution === 'not_started' && /control/.test(e.message));
  // Old code ignores the option: settle its unexpected dispatch so the red is a
  // behavioral assertion, not a hang or request-deadline race.
  if (f.calls[0]) f.calls[0].result.resolve(reply('source'));
  await refusal; assert.equal(f.calls.length, 0); await p.close(); empty(p);
});


test('wait-only expired control cannot suppress a typed SDK socket-loss rejection', async t => {
  class SocketClosed extends Error {}
  const f = fixture(); f.sdk.SocketClosedError = SocketClosed;
  const p = f.transport(); await f.ready(p); t.after(() => p.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = p.request(request('data'), { deadlineMs: 30000 });
  const sourceRejected = assert.rejects(source, { message: 'shared request failed; outcome uncertain' }); void sourceRejected.catch(() => {});
  const control = p.request(request('catalogue', 'describe'), { waitOnly: true, deadlineMs: 5 });
  const refused = assert.rejects(control, /control wait deadline/); t.mock.timers.tick(5); await refused;
  f.calls[1].result.reject(new SocketClosed('private socket details'));
  await sourceRejected; assert.equal(await p.ended, 'lost'); empty(p); t.mock.timers.reset();
});

test('wait-only does not change unexpected SDK failure before the catalogue deadline', async t => {
  const f = fixture(), p = f.transport(); await f.ready(p); t.after(() => p.close());
  const source = p.request(request('data'));
  const control = p.request(request('catalogue', 'describe'), { waitOnly: true });
  const rejected = [source, control].map(value => assert.rejects(value, { message: 'shared request failed; outcome uncertain' }));
  f.calls[1].result.reject(new Error('not a local timeout'));
  await Promise.all(rejected); assert.equal(await p.ended, 'uncertain'); empty(p);
});

for (const outcome of ['ok', 'not_started', 'started'] as const) test(`canonical aborted shared request preserves terminal ${outcome} evidence`, async () => {
  const f = fixture(), p = f.transport(); await f.ready(p);
  try {
    const abort = new AbortController(), options = { signal: abort.signal, acceptRetired: true };
    const pending = p.request(request('retired'), options);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    abort.abort(); await tick();
    assert.equal(settled, false); assert.equal(p.stats().unsettledData, 1);
    const terminal = outcome === 'ok' ? reply('retired') : { v: 2, ticket: 'retired', instance: 'instance', assets: 'assets',
      status: 'error', error: { code: 'cancelled', execution: outcome } };
    f.calls[0].result.resolve(terminal);
    assert.deepEqual(await pending, terminal, 'terminal evidence must reach the canonical decoder, not become transport uncertainty');
    assert.equal(p.stats().unsettledData, 0); assert.equal(p.stats().dataReservedBytes, 0);
  } finally { await p.close(); empty(p); }
});
