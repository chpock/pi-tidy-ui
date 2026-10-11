import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntaxClient, type SyntaxClientOptions } from '../src/occipital/client.ts';
import { ExtensionSettings, SETTINGS_FILE_MAX_BYTES, type SettingsLoadResult, type SettingsSaveResult, type SyntaxTheme } from '../src/settings.ts';
import type { ProviderClock, ProviderTransport } from '../src/occipital/provider.ts';
import type { TransportEnd } from '../src/occipital/transport-end.ts';
import { SharedTransport, type SharedClient } from '../src/occipital/shared.ts';

const pi = { id: 'pi', label: 'Pi palette', fingerprint: 'a'.repeat(64) };
const native = { id: 'custom:one', label: 'One', fingerprint: 'b'.repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function descriptor(ticket: unknown, profiles = [pi, native], revision = 0, diagnostic: string | null = null) {
  return { v: 2, ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
    kind: 'descriptor', backend_version: '0.1.0', protocol_version: 2, category_version: 1, assets: 'assets',
    capability: 'syntax-highlight/v2', service: 'syntax', operations: ['describe', 'themes.refresh', 'highlight', 'stream.open', 'stream.append', 'stream.close'],
    modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'], catalogue_revision: revision, profiles, diagnostic,
    runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
    limits: { request_bytes: 2097152, reply_bytes: 2097152, control_request_bytes: 4096, control_reply_bytes: 32768,
      source_bytes: 1048576, line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: 2097152,
      leases: 32, leases_per_route: 4, runs: 131072, styles: 512, idle_ms: 60000, age_ms: 300000,
      quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
  } };
}
type Call = { request: Record<string, any>; options?: Parameters<ProviderTransport['request']>[1]; resolve(value: unknown): void; reject(error: unknown): void };
class Peer implements ProviderTransport {
  private termination = deferred<TransportEnd>();
  ended = this.termination.promise;
  endReason: TransportEnd | undefined;
  calls: Call[] = [];
  profiles = [pi, native]; revision = 0; diagnostic: string | null = null;
  holdMetadata = false; closes = 0; exit = Promise.resolve();
  end(reason: TransportEnd) { if (this.endReason === undefined) { this.endReason = reason; this.termination.resolve(reason); } }
  request(request: Record<string, unknown>, options?: Call['options']) {
    const pending = deferred<unknown>(); const call = { request, options, ...pending }; this.calls.push(call);
    if ((request.op === 'describe' || request.op === 'themes.refresh') && !this.holdMetadata) this.answerMetadata(this.calls.length - 1);
    return pending.promise;
  }
  answerMetadata(index: number) { this.calls[index]!.resolve(descriptor(this.calls[index]!.request.ticket, this.profiles, this.revision, this.diagnostic)); }
  fault(index: number, code = 'profile_changed') {
    this.calls[index]!.resolve({ v: 2, ticket: this.calls[index]!.request.ticket, instance: 'instance', assets: 'assets', status: 'error', error: { code, execution: 'not_started' } });
  }
  answerSource(index: number) {
    const r = this.calls[index]!.request, s = r.sources[0], bytes = Buffer.byteLength(s.text);
    this.calls[index]!.resolve({ v: 2, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: { kind: 'source', sources: [{
      key: s.key, generation: s.generation, source_version: s.source_version, profile: s.profile, fingerprint: s.fingerprint,
      revision: 1, replace_from: 0, source_bytes: bytes, committed_bytes: bytes, complete: true,
      styles: [{ role: 'plain' }], runs: [bytes, 0], counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes },
    }] } });
  }
  close() { this.closes++; this.end('closed'); for (const call of this.calls) call.reject(new Error('SECRET')); return this.exit; }
}
class Clock implements ProviderClock {
  time = 0; serial = 0; timers = new Map<number, { at: number; callback(): void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, ms: number) {
    const id = ++this.serial; this.timers.set(id, { at: this.time + ms, callback });
    return { cancel: () => { this.timers.delete(id); }, unref() {} };
  }
  async advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
    await settle();
  }
}
class Store {
  loads = 0; writes: { choice: SyntaxTheme; signal?: AbortSignal }[] = [];
  restored: SettingsLoadResult = { ok: true, syntaxTheme: { kind: 'pi' } };
  loadResult?: Promise<SettingsLoadResult>;
  saveResult: SettingsSaveResult | Promise<SettingsSaveResult> = { ok: true };
  load() { this.loads++; return this.loadResult ?? Promise.resolve(this.restored); }
  update(patch: { syntaxTheme: SyntaxTheme }, options?: { signal?: AbortSignal }) {
    this.writes.push({ choice: patch.syntaxTheme, signal: options?.signal }); return Promise.resolve(this.saveResult);
  }
}
const clients = new Set<SyntaxClient>();
afterEach(async () => { for (const c of clients) await c.dispose(); clients.clear(); await settle(); });
async function settle() { await turn(); }
function fixture(extra: Partial<SyntaxClientOptions> = {}, store = new Store(), peer = new Peer()) {
  let acquisitions = 0, sharedAttempts = 0, notices = 0; const errors: string[] = [];
  const c = new SyntaxClient({ provider: { tryShared: async () => { sharedAttempts++; return peer; }, acquireOwned: async () => { acquisitions++; return new Peer(); } },
    standaloneVersion: '0.1.0', settings: store, notify: message => { errors.push(message); }, onChange: () => { notices++; }, ...extra });
  clients.add(c); return { c, peer, store, errors, acquisitions: () => acquisitions, sharedAttempts: () => sharedAttempts, notices: () => notices };
}
function demand(c: SyntaxClient, key = 'one') {
  const profile = c.snapshot().effective!;
  return { key, version: 1, text: 'x', complete: true, profile: profile.id, fingerprint: profile.fingerprint };
}

test('constructor, snapshots, source inspection and menu captures never load, acquire or dispatch', async () => {
  const f = fixture(); const before = f.c.sources.stats(); const capture = f.c.captureMenu();
  for (let i = 0; i < 20; i++) { f.c.snapshot(); f.c.sources.status('one'); f.c.sources.flush(); assert.equal(capture(), true); }
  assert.equal(f.store.loads, 0); assert.equal(f.store.writes.length, 0); assert.equal(f.sharedAttempts(), 0);
  assert.equal(f.acquisitions(), 0); assert.equal(f.peer.calls.length, 0); assert.deepEqual(f.c.sources.stats(), before);
  assert.equal(f.c.sources.observe({ key: 'one', version: 1, text: 'x', complete: true, profile: pi.id, fingerprint: pi.fingerprint }), false);
  assert.equal(f.c.snapshot().enabled, true); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal((await f.c.refreshThemes()).ok, false); assert.equal(f.peer.calls.length, 0);
});
for (const choice of [{ kind: 'pi' }, { kind: 'occipital', id: native.id }, { kind: 'occipital', id: 'missing' }] as SyntaxTheme[]) {
  test(`one startup restores ${JSON.stringify(choice)} without writing defaults`, async () => {
    const store = new Store(); store.restored = { ok: true, syntaxTheme: choice }; const f = fixture({}, store);
    const a = f.c.start(), b = f.c.start(); assert.equal(a, b); await a; await f.c.start();
    assert.equal(store.loads, 1); assert.equal(store.writes.length, 0); assert.equal(f.sharedAttempts(), 1); assert.equal(f.acquisitions(), 0);
    assert.deepEqual(f.c.snapshot().selected, choice); assert.equal(f.c.snapshot().effective?.id, choice.kind === 'occipital' && choice.id === native.id ? native.id : pi.id);
    assert.equal(f.errors.length, choice.kind === 'occipital' && choice.id === 'missing' ? 1 : 0);
    assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
  });
}

test('ready catalogue is inspectable during load, but sources and effective profile wait; explicit choice beats slow load', async () => {
  const restored = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = restored.promise; const f = fixture({}, store);
  const start = f.c.start(); await settle(); assert.ok(f.c.snapshot().provider.description); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.c.sources.observe({ key: 'one', version: 1, text: 'x', complete: true, profile: pi.id, fingerprint: pi.fingerprint }), false);
  const choice: SyntaxTheme = { kind: 'occipital', id: native.id }; await f.c.selectTheme(choice); choice.id = 'mutated';
  assert.deepEqual(f.c.snapshot().selected, { kind: 'occipital', id: native.id }); assert.equal(f.c.snapshot().effective?.id, native.id);
  restored.resolve({ ok: true, syntaxTheme: { kind: 'pi' } }); await start;
  assert.equal(f.c.snapshot().effective?.id, native.id); assert.equal(f.peer.calls.length, 1);
  const snapshot = f.c.snapshot(); (snapshot.selected as { id: string }).id = 'bad'; (snapshot.effective as { fingerprint: string }).fingerprint = 'bad';
  assert.equal(f.c.snapshot().effective?.fingerprint, native.fingerprint); assert.equal((f.c.snapshot().selected as { id: string }).id, native.id);
  assert.equal(f.c.snapshot().provider.description, f.c.broker.snapshot().description);
});

test('invalid settings default and rejected load report only fixed bounded errors, never raw details', async () => {
  const store = new Store(); store.restored = { ok: false, syntaxTheme: { kind: 'pi' }, issue: { code: 'invalid-theme', message: 'Settings contain an invalid syntax theme preference.' } };
  const f = fixture({}, store); await f.c.start(); assert.equal(f.c.snapshot().effective?.id, 'pi'); assert.equal(store.writes.length, 0);
  assert.equal(f.errors.length, 1); assert.ok(f.c.snapshot().lastIssue);
  const other = fixture({ settings: { load: async () => { throw Error('/SECRET/path'); }, update: async () => ({ ok: true }) } });
  await other.c.start(); assert.equal(other.c.snapshot().effective?.id, 'pi'); assert.equal(other.errors.length, 1);
  assert.equal(JSON.stringify(other.c.snapshot()).includes('SECRET'), false);
});

test('real store failure keeps prior disk and new active choice; cancellation signals are per-save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syntax-client-')); const file = join(directory, 'config.json');
  try {
    const previous = '{"syntaxTheme":{"kind":"pi"}}\n'; await writeFile(file, previous);
    const settings = new ExtensionSettings({ file }); const f = fixture({ settings }); await f.c.start();
    await writeFile(file, 'invalid'); assert.equal((await f.c.selectTheme({ kind: 'occipital', id: native.id })).ok, false);
    assert.equal(f.c.snapshot().effective?.id, native.id); assert.equal(await readFile(file, 'utf8'), 'invalid');
    assert.equal(f.c.snapshot().lastIssue?.includes('invalid JSON'), true);
    const fixed = { syntaxTheme: { kind: 'pi' }, unknown: '' };
    fixed.unknown = 'x'.repeat(SETTINGS_FILE_MAX_BYTES - Buffer.byteLength(JSON.stringify(fixed)));
    const valid = JSON.stringify(fixed); await writeFile(file, valid);
    const retained = fixture({ settings }); await retained.c.start();
    assert.equal(retained.c.snapshot().effective?.id, 'pi');
    assert.equal((await retained.c.selectTheme({ kind: 'occipital', id: native.id })).ok, false);
    assert.equal(retained.c.snapshot().effective?.id, native.id);
    assert.equal(await readFile(file, 'utf8'), valid, 'failed oversized replacement must keep previous valid disk file');
  } finally { await rm(directory, { recursive: true, force: true }); }
  const held = deferred<SettingsSaveResult>(), store = new Store(); store.saveResult = held.promise; const f = fixture({}, store); await f.c.start();
  const first = f.c.selectTheme({ kind: 'occipital', id: native.id }); const second = f.c.selectTheme({ kind: 'pi' });
  assert.notEqual(store.writes[0]!.signal, store.writes[1]!.signal); assert.equal(store.writes[0]!.signal!.aborted, true);
  const off = f.c.setEnabled(false); assert.equal(store.writes[1]!.signal!.aborted, true); await off;
  const third = f.c.selectTheme({ kind: 'pi' }); assert.equal(store.writes[2]!.signal!.aborted, false);
  await f.c.dispose(); assert.equal(store.writes[2]!.signal!.aborted, true);
  held.resolve({ ok: false, issue: { code: 'write-failed', message: 'SECRET' } }); await Promise.all([first, second, third]);
  assert.equal(f.c.snapshot().lastIssue, undefined); assert.equal(f.errors.length, 0);
});

test('off retires sources and saves synchronously; captures never revive, including initially disabled captures', async () => {
  const f = fixture(); const initial = f.c.captureMenu(); await f.c.setEnabled(false);
  assert.equal(initial(), false); const disabled = f.c.captureMenu(); assert.equal(disabled(), true); await f.c.start();
  assert.equal(f.sharedAttempts(), 0); assert.equal(f.store.loads, 1); assert.equal(f.c.snapshot().effective, undefined);
  await f.c.selectTheme({ kind: 'occipital', id: native.id }); assert.equal(f.sharedAttempts(), 0);
  await f.c.setEnabled(true); assert.equal(disabled(), false); assert.equal(initial(), false); assert.equal(f.c.snapshot().effective?.id, native.id);
  const live = f.c.captureMenu(); const source = demand(f.c); f.c.sources.observe(source); f.c.sources.flush();
  const call = f.peer.calls.at(-1)!; const exit = deferred<void>(); f.peer.exit = exit.promise;
  const stopping = f.c.setEnabled(false); assert.equal(call.options!.signal!.aborted, true); assert.equal(f.c.sources.stats().sourceRecords, 1, 'off retains paid primitive execution evidence, not native payload');
  assert.equal(f.c.sources.stats().retention.retainedBytes, 0); assert.equal(live(), false);
  assert.equal(f.c.snapshot().enabled, false); exit.resolve(); await stopping;
  await f.c.setEnabled(true); assert.equal(live(), false); assert.equal(f.store.loads, 1); assert.equal(f.store.writes.length, 1);
  const final = f.c.captureMenu(); await f.c.dispose(); assert.equal(final(), false); assert.equal(f.c.captureMenu()(), false);
  const counts = [f.sharedAttempts(), f.store.writes.length, f.notices(), f.errors.length];
  await f.c.start(); await f.c.setEnabled(true); await f.c.selectTheme({ kind: 'pi' }); await f.c.refreshThemes(); await settle();
  assert.deepEqual([f.sharedAttempts(), f.store.writes.length, f.notices(), f.errors.length], counts);
});

test('missing episode survives unready and different providers; exact restoration or selection ends it; IDs are JSON escaped', async () => {
  const missing = 'quote"\n\u001b'; const store = new Store(); store.restored = { ok: true, syntaxTheme: { kind: 'occipital', id: missing } };
  const peers = [new Peer(), new Peer(), new Peer()]; let next = 0;
  const f = fixture({ provider: { tryShared: async () => peers[next++]!, acquireOwned: async () => new Peer() } }, store);
  await f.c.start(); assert.equal(f.errors.length, 1); assert.ok(f.errors[0]!.includes(JSON.stringify(missing))); assert.equal(f.errors[0]!.includes('\u001b'), false);
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(f.errors.length, 1);
  peers[1]!.profiles = [pi, { ...native, id: 'another' }]; peers[1]!.revision++; await f.c.refreshThemes(); assert.equal(f.errors.length, 1);
  await f.c.selectTheme({ kind: 'occipital', id: native.id }); assert.equal(f.errors.length, 2);
  peers[1]!.profiles = [pi, native]; peers[1]!.revision++; await f.c.refreshThemes(); assert.equal(f.c.snapshot().effective?.id, native.id);
  peers[1]!.profiles = [pi]; peers[1]!.revision++; await f.c.refreshThemes(); assert.equal(f.errors.length, 3);
  assert.deepEqual(f.c.snapshot().selected, { kind: 'occipital', id: native.id }); assert.equal(store.writes.length, 1);
});

test('refresh fingerprint, no-change, unrelated and diagnostic metadata never sweep sources or reset crash budget', async () => {
  const f = fixture(); await f.c.start(); await f.c.selectTheme({ kind: 'occipital', id: native.id });
  const source = demand(f.c); f.c.sources.observe(source); f.c.sources.flush(); f.peer.answerSource(1); await settle();
  const stats = f.c.sources.stats(); const accepted = f.c.broker.stats().successfulClassifications;
  for (const profiles of [[pi, native], [pi, native, { ...native, id: 'other' }], [pi, { ...native, fingerprint: 'c'.repeat(64) }]]) {
    f.peer.profiles = profiles; f.peer.revision++; assert.equal((await f.c.refreshThemes()).ok, true); await settle();
    assert.deepEqual(f.c.sources.stats(), stats); assert.equal(f.c.broker.stats().successfulClassifications, accepted);
  }
  assert.equal(f.c.snapshot().effective?.fingerprint, 'c'.repeat(64));
  f.peer.diagnostic = 'SECRET /file/path'; const outcome = await f.c.refreshThemes(); assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.message, 'Syntax themes could not be reloaded.');
  assert.equal(f.c.snapshot().effective?.fingerprint, 'c'.repeat(64)); assert.equal(f.store.writes.length, 1);
  assert.equal(f.c.snapshot().lastIssue, 'Syntax themes could not be reloaded.'); assert.deepEqual(f.c.sources.stats(), stats);
  f.c.sources.observe(demand(f.c)); f.c.sources.flush(); assert.equal(f.c.sources.stats().dispatches, stats.dispatches + 1);
});

test('refresh rejection, stale revision, and late reply after off cannot replace validated profile', async () => {
  const f = fixture(); await f.c.start(); await f.c.selectTheme({ kind: 'occipital', id: native.id });
  f.peer.revision = 1; await f.c.refreshThemes(); const profile = f.c.snapshot().effective;
  f.peer.revision = 0; assert.equal((await f.c.refreshThemes()).ok, false); assert.deepEqual(f.c.snapshot().effective, profile);
  f.peer.holdMetadata = true; const refresh = f.c.refreshThemes(); await settle(); const index = f.peer.calls.length - 1;
  const off = f.c.setEnabled(false); f.peer.revision = 2; f.peer.profiles = [pi]; f.peer.answerMetadata(index);
  assert.equal((await refresh).ok, false); await off; assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.c.snapshot().provider.availability, 'disabled'); assert.equal(f.store.writes.length, 1);
});

test('source profile notice starts one source-free describe, busy refresh refuses; only subsequent current demand retries', async () => {
  const f = fixture(); await f.c.start(); f.peer.holdMetadata = true;
  const source = demand(f.c); f.c.sources.observe(source); f.c.sources.flush(); f.peer.fault(1); await settle();
  assert.deepEqual(f.peer.calls.map(c => c.request.op), ['describe', 'highlight', 'describe']);
  assert.deepEqual(Object.keys(f.peer.calls[2]!.request).sort(), ['op', 'ticket', 'v']); assert.equal(f.peer.calls[2]!.options?.waitOnly, true);
  assert.equal((await f.c.refreshThemes()).ok, false); assert.equal(f.peer.calls.length, 3);
  f.peer.answerMetadata(2); await settle(); assert.equal(f.c.sources.profileReconciliationNeeded(), undefined); assert.equal(f.peer.calls.length, 3);
  f.c.sources.flush(); await settle(); assert.equal(f.peer.calls.length, 3);
  f.c.sources.observe(source); f.c.sources.flush(); assert.equal(f.peer.calls.length, 4); f.peer.fault(3); await settle();
  assert.equal(f.peer.calls.length, 4, 'single retry must not become a metadata loop'); assert.equal(f.c.sources.stats().dispatches, 2);
});

test('newer refusal during describe is not swallowed; failed same need never loops, newer need tries once', async () => {
  const f = fixture(); await f.c.start(); f.peer.holdMetadata = true;
  f.c.sources.observe(demand(f.c, 'one')); f.c.sources.observe(demand(f.c, 'two')); f.c.sources.flush();
  f.peer.fault(1); await settle(); assert.equal(f.peer.calls.length, 4); const firstNeed = f.c.sources.profileReconciliationNeeded()!;
  f.peer.fault(2); await settle(); const secondNeed = f.c.sources.profileReconciliationNeeded()!; assert.ok(secondNeed.sequence > firstNeed.sequence);
  f.peer.answerMetadata(3); await settle(); assert.equal(f.peer.calls.length, 5); assert.deepEqual(f.c.sources.profileReconciliationNeeded(), secondNeed);
  f.peer.calls[4]!.reject(new Error('SECRET')); await settle(); const notices = f.notices();
  f.c.sources.wake(); f.c.sources.flush(); await settle(); assert.equal(f.peer.calls.length, 5); assert.equal(f.notices(), notices);
  f.c.sources.observe(demand(f.c, 'three')); f.c.sources.flush(); f.peer.fault(5, 'theme_unavailable'); await settle();
  assert.equal(f.peer.calls.length, 7); f.peer.answerMetadata(6); await settle(); assert.equal(f.c.sources.profileReconciliationNeeded(), undefined);
  assert.equal(f.c.sources.stats().dispatches, 3); assert.equal(f.c.broker.stats().successfulClassifications, 0);
});

test('external notices coalesce same-turn preferences and never observe or prepare sources', async () => {
  const f = fixture(); await f.c.start(); await settle(); const baseline = f.notices(), stats = f.c.sources.stats();
  const operations = [f.c.selectTheme({ kind: 'occipital', id: native.id }), f.c.selectTheme({ kind: 'pi' }), f.c.selectTheme({ kind: 'occipital', id: native.id })];
  await Promise.all(operations); await settle(); assert.equal(f.notices(), baseline + 1); assert.deepEqual(f.c.sources.stats(), stats);
});

test('ordinary off/on preserves initialShared and does not restart an old return window', async () => {
  const clock = new Clock(), first = new Peer(); let attempts = 0; const owned: Peer[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => ++attempts === 1 ? first : undefined, acquireOwned: async () => { const peer = new Peer(); owned.push(peer); return peer; } } });
  await f.c.start(); first.end('lost'); await settle(); assert.equal(f.c.snapshot().provider.kind, 'owned');
  assert.equal(f.c.broker.stats().recoveryTimers, 1); const episodes = f.c.broker.stats().recoveryEpisodes;
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(f.c.snapshot().provider.initialShared, true);
  assert.equal(f.c.broker.stats().recoveryTimers, 0); assert.equal(f.c.broker.stats().recoveryEpisodes, episodes);
  await clock.advance(600000); assert.equal(f.c.broker.stats().probesStarted, 0); assert.equal(f.store.writes.length, 0);
});

async function sharedFixture() {
  const calls: { request: Record<string, any>; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const sdk: SharedClient = { resolveProvider: async () => 'module', routeOpen: async () => ({ channel: 1, epoch: 1 }), closeRoute: async () => {}, close() {},
    request: async (_route, bytes) => { const request = JSON.parse(Buffer.from(bytes).toString()); const pending = deferred<unknown>(); calls.push({ request, pending });
      if (calls.length === 1) pending.resolve(descriptor(request.ticket)); return pending.promise; } };
  const transport = new SharedTransport({ connectionFile: '/fixture', identity: { project_root: '/fixture', harness: 'pi', session: 'fixture' },
    initDeadlineMs: 5000, requestDeadlineMs: 5000, loadSdk: async () => ({ SubcClient: { connect: async () => sdk } }) });
  await transport.ready; const clock = new Clock(); const f = fixture({ provider: { clock, tryShared: async () => transport, acquireOwned: async () => new Peer() } });
  await f.c.start(); return { ...f, calls, transport, clock };
}
test('actual shared waitOnly expiry retains unanswered credit; further refresh refuses and late metadata cannot publish', async () => {
  const f = await sharedFixture(); const profile = f.c.snapshot().effective;
  const refresh = f.c.refreshThemes(); await settle(); await f.clock.advance(5000); assert.equal((await refresh).ok, false);
  assert.equal(f.transport.stats().unsettledControl, 1); assert.equal(f.c.snapshot().provider.availability, 'ready');
  assert.equal((await f.c.refreshThemes()).ok, false); assert.equal(f.calls.length, 2); assert.equal(f.transport.stats().unsettledControl, 1);
  f.calls[1]!.pending.resolve(descriptor(f.calls[1]!.request.ticket, [pi], 1)); await settle();
  assert.equal(f.transport.stats().unsettledControl, 0); assert.deepEqual(f.c.snapshot().effective, profile);
});
function detachedOwner(peer: Peer) {
  const c = new SyntaxClient({ provider: { tryShared: async () => peer, acquireOwned: async () => new Peer() }, standaloneVersion: '0.1.0', settings: new Store() });
  return { weak: new WeakRef(c), broker: c.broker, sources: c.sources, start: c.start() };
}
test('retained production broker/source observer callbacks cannot retain first owner under active second client', async () => {
  assert.equal(typeof global.gc, 'function', 'run this control with --expose-gc');
  const peer = new Peer(), first = detachedOwner(peer); await first.start;
  const second = fixture(); await second.c.start();
  for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
  assert.equal(first.weak.deref(), undefined); assert.equal(second.c.snapshot().provider.availability, 'ready');
  await first.broker.catalogue(first.broker.snapshot().generation, 'describe');
  first.sources.observe({ key: 'collected', version: 1, text: 'x', complete: true, profile: pi.id, fingerprint: pi.fingerprint });
  first.sources.flush(); peer.fault(2); await settle();
  assert.equal(peer.calls.length, 3, 'retained source observer must not resurrect collected client metadata work');
  assert.equal(second.c.snapshot().provider.availability, 'ready'); first.sources.dispose(); await first.broker.dispose();
});

test('explicit preference before start is not overwritten by startup restore; known late restore gates native work', async () => {
  const early = fixture(); await early.c.selectTheme({ kind: 'occipital', id: native.id }); await early.c.start();
  assert.equal(early.c.snapshot().effective?.id, native.id); assert.equal(early.store.loads, 1);
  const load = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = load.promise;
  const f = fixture({}, store); const start = f.c.start(); await settle();
  const piDemand = { key: 'one', version: 1, text: 'x', complete: true, profile: pi.id, fingerprint: pi.fingerprint };
  assert.equal(f.c.sources.observe(piDemand), false); f.c.sources.flush(); assert.equal(f.peer.calls.length, 1);
  load.resolve({ ok: true, syntaxTheme: { kind: 'occipital', id: native.id } }); await start;
  f.c.sources.observe(demand(f.c)); f.c.sources.flush();
  assert.equal(f.peer.calls[1]!.request.sources[0].profile, native.id); f.peer.answerSource(1); await settle();
  assert.equal(f.c.broker.stats().successfulClassifications, 1);
});

test('stale source reply after current preference demand cannot publish or reset classification crash budget', async () => {
  const f = fixture(); await f.c.start(); f.c.sources.observe(demand(f.c)); f.c.sources.flush();
  const old = f.peer.calls[1]!; await f.c.selectTheme({ kind: 'occipital', id: native.id });
  f.c.sources.observe(demand(f.c)); f.c.sources.flush(); assert.equal(old.options?.signal?.aborted, true);
  f.peer.answerSource(1); await settle(); assert.equal(f.c.sources.stats().staleReplies, 1);
  assert.equal(f.c.broker.stats().successfulClassifications, 0); assert.equal(f.c.sources.status('one')?.classificationVersion, undefined);
  assert.equal(f.peer.calls[2]!.request.sources[0].profile, native.id); f.peer.answerSource(2); await settle();
  assert.equal(f.c.sources.status('one')?.exact, true); assert.equal(f.c.broker.stats().successfulClassifications, 1);
});

for (const fault of ['rejected', 'malformed', 'refused'] as const) test(`explicit ${fault} metadata keeps effective profile and reports fixed failure`, async () => {
  const f = fixture(); await f.c.start(); await f.c.selectTheme({ kind: 'occipital', id: native.id });
  f.peer.holdMetadata = true; const before = f.c.sources.stats(), effective = f.c.snapshot().effective;
  const refresh = f.c.refreshThemes(); await settle(); const index = f.peer.calls.length - 1;
  if (fault === 'rejected') f.peer.calls[index]!.reject(new Error('SECRET /path'));
  else if (fault === 'malformed') f.peer.calls[index]!.resolve({ secret: 'SECRET' });
  else f.peer.fault(index, 'busy');
  const outcome = await refresh; assert.deepEqual(outcome, { ok: false, message: 'Syntax themes could not be reloaded.' });
  assert.deepEqual(f.c.snapshot().effective, effective); assert.deepEqual(f.c.sources.stats(), before);
  assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(f.c.snapshot().lastIssue, 'Syntax themes could not be reloaded.');
  assert.equal(f.c.broker.stats().successfulClassifications, 0);
});

test('same-turn source refusals coalesce one latest metadata sequence; unrelated accepted source notice cannot retry failed need', async () => {
  const f = fixture(); await f.c.start(); f.peer.holdMetadata = true;
  f.c.sources.observe(demand(f.c, 'one')); f.c.sources.observe(demand(f.c, 'two')); f.c.sources.flush();
  f.peer.fault(1); f.peer.fault(2); await settle(); assert.equal(f.peer.calls.length, 4);
  const need = f.c.sources.profileReconciliationNeeded(); assert.equal(need?.sequence, 2);
  f.peer.calls[3]!.reject(new Error('SECRET')); await settle();
  f.c.sources.observe(demand(f.c, 'other')); f.c.sources.flush(); f.peer.answerSource(4); await settle();
  assert.equal(f.peer.calls.length, 5); assert.deepEqual(f.c.sources.profileReconciliationNeeded(), need);
  assert.equal(f.c.sources.stats().preparedBytes, 3); assert.equal(f.c.broker.stats().successfulClassifications, 1);
});

function sharedPeer() {
  const calls: { request: Record<string, any>; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const sdk: SharedClient = { resolveProvider: async () => 'module', routeOpen: async () => ({ channel: 1, epoch: 1 }), closeRoute: async () => {}, close() {},
    request: async (_route, bytes) => {
      const request = JSON.parse(Buffer.from(bytes).toString()), pending = deferred<unknown>(); calls.push({ request, pending });
      if (calls.length === 1) pending.resolve(descriptor(request.ticket)); return pending.promise;
    } };
  const transport = new SharedTransport({ connectionFile: '/fixture', identity: { project_root: '/fixture', harness: 'pi', session: 'gc' },
    initDeadlineMs: 5000, requestDeadlineMs: 5000, loadSdk: async () => ({ SubcClient: { connect: async () => sdk } }) });
  return { transport, calls };
}
async function detachedMetadataOwner(transport: SharedTransport, clock: Clock) {
  const c = new SyntaxClient({ provider: { clock, tryShared: async () => transport, acquireOwned: async () => new Peer() }, standaloneVersion: '0.1.0', settings: new Store() });
  await c.start(); return { weak: new WeakRef(c), broker: c.broker, sources: c.sources, expired: c.refreshThemes() };
}
test('first client is collectable after actual metadata caller expiry while SDK promise/observers remain pending', async () => {
  assert.equal(typeof global.gc, 'function');
  const peer = sharedPeer(), clock = new Clock(); await peer.transport.ready;
  const first = await detachedMetadataOwner(peer.transport, clock); await settle(); await clock.advance(5000);
  assert.equal((await first.expired).ok, false); assert.equal(peer.transport.stats().unsettledControl, 1);
  const second = fixture(); await second.c.start();
  try {
    for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
    assert.equal(first.weak.deref(), undefined); assert.equal(second.c.snapshot().provider.availability, 'ready');
    peer.calls[1]!.pending.resolve(descriptor(peer.calls[1]!.request.ticket, [pi], 1)); await settle();
    assert.equal(peer.transport.stats().unsettledControl, 0); assert.equal(first.broker.snapshot().description?.catalogue_revision, 0);
    assert.equal(second.c.snapshot().provider.availability, 'ready');
  } finally { first.sources.dispose(); await first.broker.dispose(); }
});

test('late startup preference/provider completions after disposal neither publish nor notify nor acquire owned', async () => {
  const load = deferred<SettingsLoadResult>(), connection = deferred<ProviderTransport | undefined>(), store = new Store(); store.loadResult = load.promise;
  let acquired = 0; const f = fixture({ provider: { tryShared: async () => connection.promise, acquireOwned: async () => { acquired++; return new Peer(); } } }, store);
  const start = f.c.start(); await settle(); await f.c.dispose(); const notices = f.notices();
  const late = new Peer(); connection.resolve(late); load.resolve({ ok: true, syntaxTheme: { kind: 'occipital', id: 'missing' } });
  await start; await settle(); assert.equal(acquired, 0); assert.equal(late.closes, 1); assert.equal(late.calls.length, 0);
  assert.equal(f.c.snapshot().provider.availability, 'disposed'); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.c.sources.observe({ key: 'one', version: 1, text: 'x', complete: true, profile: pi.id, fingerprint: pi.fingerprint }), false);
  assert.equal(f.notices(), notices); assert.equal(f.errors.length, 0); assert.equal(store.writes.length, 0);
});

test('metadata and UI never reset owned crash chain; deliberate off/on alone permits a new attempt', async () => {
  const peers: Peer[] = []; const f = fixture({ provider: { tryShared: async () => undefined, acquireOwned: async () => { const peer = new Peer(); peers.push(peer); return peer; } } });
  await f.c.start(); assert.equal(peers.length, 1);
  for (let i = 0; i < 3; i++) {
    await f.c.refreshThemes(); await f.c.selectTheme({ kind: 'pi' }); f.c.snapshot(); f.c.captureMenu()();
    peers[i]!.end('lost'); await settle();
  }
  assert.equal(peers.length, 3); assert.equal(f.c.snapshot().provider.reason, 'restart_limit');
  assert.equal(f.c.broker.stats().successfulClassifications, 0); assert.equal(f.c.broker.stats().ownedRestarts, 2);
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(peers.length, 4);
  assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(f.c.snapshot().provider.initialShared, false);
});


test('client forwards coalesced source keys without turning metadata/theme changes into source notifications', async () => {
  const packets: string[][] = [];
  const { c, peer } = fixture({ onSourceChange: (keys: readonly string[]) => { packets.push([...keys]); } });
  await c.start(); await settle(); assert.deepEqual(packets, []);
  c.sources.observe(demand(c, 'one')); c.sources.observe(demand(c, 'two')); c.sources.flush();
  assert.equal(peer.calls.length, 3); peer.answerSource(1); peer.answerSource(2); await settle();
  assert.deepEqual(packets, [['one', 'two']]);
  const before = c.sources.stats();
  await c.refreshThemes(); await c.selectTheme({ kind: 'occipital', id: native.id }); await settle();
  assert.deepEqual(packets, [['one', 'two']]);
  assert.equal(c.sources.stats().dispatches, before.dispatches);
  assert.equal(c.sources.stats().preparedBytes, before.preparedBytes);
});

test('a throwing source-specific client observer cannot lose generic delivery or metadata reconciliation', async () => {
  let sourceNotices = 0;
  const { c, peer, notices } = fixture({ onSourceChange: (_keys: readonly string[]) => { sourceNotices++; throw Error('external presentation'); } });
  await c.start(); await settle(); const before = notices();
  c.sources.observe(demand(c)); c.sources.flush(); peer.fault(1); await settle();
  assert.equal(sourceNotices, 2, 'terminal refusal and metadata retry permission are distinct source-state changes'); assert.ok(notices() > before);
  assert.equal(peer.calls.filter(call => call.request.op === 'describe').length, 2);
  assert.equal(c.sources.profileReconciliationNeeded(), undefined);
  const source = c.sources.stats(); assert.equal(source.globalUnsettledJobs, 0);
  await c.setEnabled(false); await settle();
  c.acceptSourceChange(['one']); await settle();
  assert.equal(sourceNotices, 2, 'retired source delivery cannot reach the external observer');
});


test('client forwards useful canonical permission notices while off, never guessing stop from shared or failed owned cleanup', async () => {
  for (const kind of ['shared', 'owned', 'failed'] as const) {
    const peer = new Peer(), exit = deferred<void>(), packets: string[][] = [];
    peer.exit = exit.promise;
    const f = fixture({ provider: { tryShared: async () => kind === 'shared' ? peer : undefined, acquireOwned: async () => peer },
      onSourceChange: keys => packets.push([...keys]) }, new Store(), peer);
    await f.c.start(); f.c.sources.observe(demand(f.c)); f.c.sources.flush();
    const off = f.c.setEnabled(false); await settle();
    assert.equal(f.c.sources.workStatus('one').fallbackEligible, false);
    assert.equal(f.c.sources.workStatus('unrelated').fallbackEligible, true);
    assert.equal(f.c.sources.stats().retention.retainedBytes, 0);
    packets.length = 0;
    if (kind === 'failed') exit.reject(new Error('failed reap')); else exit.resolve();
    await off; await settle();
    assert.equal(f.c.sources.workStatus('one').fallbackEligible, kind === 'owned');
    assert.deepEqual(packets, kind === 'owned' ? [['one']] : []);
    assert.equal(f.c.broker.stats().successfulClassifications, 0);
    assert.equal(peer.calls.length, 2, 'no hidden retry/native source work');
  }
});

test('canonical client receives a fully validated retired shared outcome without stale publication or useful credit', async () => {
  for (const outcome of ['complete', 'not_started', 'malformed'] as const) {
    const peer = new Peer(), packets: string[][] = [];
    peer.close = () => { peer.closes++; peer.end('closed'); return Promise.resolve(); };
    const f = fixture({ onSourceChange: keys => packets.push([...keys]) }, new Store(), peer);
    await f.c.start(); f.c.sources.observe(demand(f.c)); f.c.sources.flush();
    await f.c.setEnabled(false); await settle(); assert.equal(f.c.sources.workStatus('one').execution, 'unsettled');
    if (outcome === 'complete') peer.answerSource(1);
    else if (outcome === 'not_started') peer.fault(1, 'busy');
    else peer.calls[1]!.resolve({ v: 2, status: 'ok' });
    await settle();
    assert.equal(f.c.sources.workStatus('one').fallbackEligible, outcome !== 'malformed');
    assert.deepEqual(packets, [['one']]);
    assert.equal(f.c.broker.stats().successfulClassifications, 0);
    assert.equal(f.c.sources.stats().retention.retainedBytes, 0);
    assert.equal(f.c.sources.status('one'), undefined); assert.equal(peer.calls.length, 2);
  }
});
