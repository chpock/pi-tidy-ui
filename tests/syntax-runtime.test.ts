import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SyntaxRuntime } from '../src/syntax/runtime.ts';
import type { ProviderTransport } from '../src/occipital/provider.ts';
import type { TransportEnd } from '../src/occipital/transport-end.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import type { SettingsLoadResult, SettingsSaveResult, SyntaxTheme } from '../src/settings.ts';

const profile = { id: 'pi', label: 'Pi palette', fingerprint: 'a'.repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function descriptor(ticket: unknown) {
  return { v: 2, ticket, instance: 'runtime', assets: 'assets', status: 'ok', body: {
    kind: 'descriptor', backend_version: '0.1.0-test', protocol_version: 2, category_version: 1, assets: 'assets',
    capability: 'syntax-highlight/v2', service: 'syntax', operations: ['describe', 'themes.refresh', 'highlight', 'stream.open', 'stream.append', 'stream.close'],
    modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'], catalogue_revision: 0, profiles: [profile], diagnostic: null,
    runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
    limits: { request_bytes: OCCIPITAL_LIMITS.wireBytes, reply_bytes: OCCIPITAL_LIMITS.wireBytes,
      control_request_bytes: 4096, control_reply_bytes: 32768, source_bytes: OCCIPITAL_LIMITS.sourceBytes,
      line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: OCCIPITAL_LIMITS.retainedBytes,
      leases: 4096, leases_per_route: 512, runs: OCCIPITAL_LIMITS.runs, styles: OCCIPITAL_LIMITS.styles,
      idle_ms: 300000, age_ms: 3600000, quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
  } };
}
class Peer implements ProviderTransport {
  private termination = deferred<TransportEnd>();
  ended = this.termination.promise;
  endReason: TransportEnd | undefined;
  calls: { request: Record<string, any>; reply: ReturnType<typeof deferred<unknown>> }[] = [];
  closes = 0;
  request(request: Record<string, unknown>) {
    const reply = deferred<unknown>(); this.calls.push({ request, reply });
    if (request.op === 'describe' || request.op === 'themes.refresh') reply.resolve(descriptor(request.ticket));
    return reply.promise;
  }
  answer(index: number) {
    const { request: r, reply } = this.calls[index]!, s = r.sources[0];
    const bytes = Buffer.byteLength(s.text);
    reply.resolve({ v: 2, ticket: r.ticket, instance: 'runtime', assets: 'assets', status: 'ok', body: {
      kind: 'source', sources: [{ key: s.key, generation: s.generation, source_version: s.source_version,
        profile: s.profile, fingerprint: s.fingerprint, revision: 1, replace_from: 0, source_bytes: bytes,
        committed_bytes: bytes, complete: true, styles: [{ role: 'syntaxKeyword' }], runs: [bytes, 0],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes } }],
    } });
  }
  close() {
    this.closes++; this.endReason ??= 'closed'; this.termination.resolve(this.endReason);
    for (const call of this.calls) call.reply.resolve({});
    return Promise.resolve();
  }
}
class Store {
  loads = 0; writes: { choice: SyntaxTheme; signal?: AbortSignal }[] = [];
  loadResult?: Promise<SettingsLoadResult>;
  saveResult: SettingsSaveResult | Promise<SettingsSaveResult> = { ok: true };
  load() { this.loads++; return this.loadResult ?? Promise.resolve({ ok: true, syntaxTheme: { kind: 'pi' } } as SettingsLoadResult); }
  update(patch: { syntaxTheme: SyntaxTheme }, options?: { signal?: AbortSignal }) {
    this.writes.push({ choice: patch.syntaxTheme, signal: options?.signal }); return Promise.resolve(this.saveResult);
  }
}
function presentation() {
  const calls = { metadata: 0, keys: [] as string[][] };
  return { active: true, calls, syntaxMetadataChanged() { calls.metadata++; },
    syntaxSourceChanged(keys: readonly string[]) { calls.keys.push([...keys]); } };
}
const runtimes = new Set<SyntaxRuntime>();
function fixture(enabled = true) {
  const store = new Store(), peers: Peer[] = [], errors: string[] = [], changes: boolean[] = [];
  let shared = 0, owned = 0;
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.1.0-test', settings: store,
    provider: { tryShared: async () => { shared++; const peer = new Peer(); peers.push(peer); return peer; },
      acquireOwned: async () => { owned++; throw Error('unexpected owned startup'); } },
    notify: message => errors.push(message), enabled, enabledChanged: value => changes.push(value) });
  const f = { runtime, store, peers, errors, changes, shared: () => shared, owned: () => owned };
  runtimes.add(runtime); return f;
}
async function settled() { await turn(); }
afterEach(async () => { for (const runtime of runtimes) await runtime.dispose(); runtimes.clear(); await settled(); });
function demand(runtime: SyntaxRuntime, key = 'one') {
  const p = runtime.snapshot().effective!;
  assert.ok(p); return { key, version: 1, text: 'x', complete: true, profile: p.id, fingerprint: p.fingerprint };
}

test('runtime construction and warm metadata/palette inspection do not restore settings or start providers', async () => {
  const f = fixture(), theme = { colors: {}, fg() { throw Error('palette must not sample tokens'); } };
  const stamp = f.runtime.palette(theme);
  for (let i = 0; i < 20; i++) { f.runtime.snapshot(); assert.equal(f.runtime.palette(theme), stamp); }
  await settled();
  assert.equal(f.store.loads, 0); assert.equal(f.shared(), 0); assert.equal(f.owned(), 0);
  assert.deepEqual(f.changes, []); assert.equal(f.runtime.snapshot().enabled, true);
  assert.notEqual(f.runtime.palette({ colors: {} }), stamp); assert.equal(f.store.writes.length, 0);
});

test('only an active presentation starts one client asynchronously; repeated attachment is warm', async () => {
  const f = fixture(), view = presentation(), load = deferred<SettingsLoadResult>();
  f.store.loadResult = load.promise;
  f.runtime.attach({ ...view, active: false }); await settled();
  assert.equal(f.shared(), 0); assert.equal(f.store.loads, 0);
  f.runtime.attach(view);
  assert.equal(f.shared(), 0, 'attach must return before discovery work starts');
  await settled(); assert.equal(f.store.loads, 1); assert.equal(f.shared(), 1);
  assert.equal(f.runtime.snapshot().effective, undefined);
  load.resolve({ ok: true, syntaxTheme: { kind: 'pi' } }); await settled();
  assert.equal(f.runtime.snapshot().effective?.id, 'pi'); assert.ok(view.calls.metadata > 0);
  const before = [f.shared(), f.store.loads, f.peers[0]!.calls.length];
  f.runtime.attach(view); await settled(); assert.deepEqual([f.shared(), f.store.loads, f.peers[0]!.calls.length], before);
});

test('source notification targets only its keyed current presentation without a second observe/flush', async () => {
  const f = fixture(), view = presentation(); f.runtime.attach(view); await settled();
  assert.equal(f.runtime.sources.observe(demand(f.runtime)), true); f.runtime.sources.flush(); await settled();
  assert.deepEqual(f.peers[0]!.calls.map(c => c.request.op), ['describe', 'highlight']);
  f.peers[0]!.answer(1); await settled(); await settled();
  assert.deepEqual(view.calls.keys, [['one']]);
  for (let i = 0; i < 20; i++) f.runtime.snapshot(); await settled();
  assert.equal(f.peers[0]!.calls.length, 2); assert.equal(f.runtime.sources.stats().globalUnsettledJobs, 0);
});

test('native off/on preserves the client lifetime but a retained old source veto survives off', async () => {
  const f = fixture(), view = presentation(); f.runtime.attach(view); await settled();
  assert.equal(f.runtime.sources.observe(demand(f.runtime)), true); f.runtime.sources.flush(); await settled();
  const sources = f.runtime.sources, initial = f.runtime.snapshot().provider.initialShared;
  // Peer.close confirms logical closure, not whether an already dispatched parser stopped.
  f.peers[0]!.close = async () => { f.peers[0]!.closes++; };
  await f.runtime.setEnabled(false); await settled();
  assert.equal(f.runtime.sources, sources); assert.equal(f.runtime.snapshot().enabled, false);
  assert.equal(f.runtime.sources.workStatus('one').fallbackEligible, false);
  assert.deepEqual(f.changes, [false]); assert.equal(f.store.writes.length, 0);
  await f.runtime.setEnabled(true); await settled();
  assert.equal(f.runtime.sources, sources); assert.equal(f.runtime.snapshot().provider.initialShared, initial);
  assert.equal(f.shared(), 2); assert.deepEqual(f.changes, [false, true]);
  f.peers[0]!.answer(1); await settled();
});

test('master-off menu status and native enable never start a provider without an active presentation', async () => {
  const f = fixture(false);
  await f.runtime.prepareThemes(); await f.runtime.setEnabled(true); await settled();
  assert.equal(f.runtime.snapshot().enabled, true); assert.equal(f.runtime.snapshot().provider.availability, 'disabled');
  assert.equal(f.store.loads, 1); assert.equal(f.shared(), 0); assert.equal(f.owned(), 0);
  assert.deepEqual(f.changes, [true]); assert.equal(f.store.writes.length, 0);
  f.runtime.attach(presentation()); await settled(); assert.equal(f.shared(), 1);
});

test('native-off remembered by a fresh presentation client does not start providers or persist enablement', async () => {
  const f = fixture(false); f.runtime.attach(presentation()); await settled();
  assert.equal(f.shared(), 0); assert.equal(f.owned(), 0); assert.equal(f.store.loads, 1);
  assert.equal(f.runtime.snapshot().enabled, false); assert.equal(f.store.writes.length, 0);
});

test('explicit preference preparation waits for saved theme without starting a provider', async () => {
  const f = fixture(false), loaded = deferred<SettingsLoadResult>(); f.store.loadResult = loaded.promise;
  const preparing = f.runtime.prepareThemes(); await settled();
  assert.equal(f.store.loads, 1); assert.equal(f.shared(), 0); assert.equal(f.owned(), 0);
  loaded.resolve({ ok: true, syntaxTheme: { kind: 'occipital', id: 'saved' } }); await preparing;
  assert.deepEqual(f.runtime.snapshot().selected, { kind: 'occipital', id: 'saved' });
  assert.equal(f.store.writes.length, 0);
});

test('retired runtime preference preparation is inert', async () => {
  const f = fixture(); await f.runtime.dispose(); await f.runtime.prepareThemes();
  assert.equal(f.store.loads, 0); assert.equal(f.shared(), 0); assert.equal(f.store.writes.length, 0);
});

test('disposal aborts an already delegated settings save, with no late UI or presentation resurrection', async () => {
  const f = fixture(), view = presentation(), save = deferred<SettingsSaveResult>();
  f.runtime.attach(view); await settled(); f.store.saveResult = save.promise;
  const selecting = f.runtime.selectTheme({ kind: 'pi' }); assert.equal(f.store.writes.length, 1);
  await f.runtime.dispose(); const before = { metadata: view.calls.metadata, keys: [...view.calls.keys] };
  assert.equal(f.store.writes[0]!.signal!.aborted, true); save.resolve({ ok: true });
  assert.equal((await selecting).ok, false); f.runtime.attach(view); await settled();
  assert.deepEqual(view.calls, before); assert.equal(f.shared(), 1); assert.equal(f.peers[0]!.closes, 1);
  assert.equal(f.runtime.snapshot().provider.availability, 'disposed');
});

test('inactive former presentation receives no provider or source callback after retirement', async () => {
  const f = fixture(), old = presentation(); f.runtime.attach(old); await settled();
  old.active = false; const before = old.calls.metadata;
  await f.runtime.setEnabled(false); await settled(); assert.equal(old.calls.metadata, before);
  const current = presentation(); f.runtime.attach(current); await f.runtime.setEnabled(true); await settled();
  assert.ok(current.calls.metadata > 0); assert.equal(old.calls.metadata, before);
});

async function collected(reference: WeakRef<object>) {
  for (let i = 0; i < 30; i++) {
    await turn(); global.gc!(); await turn();
    if (!reference.deref()) return true;
  }
  return false;
}
function borrowedClient() {
  const f = fixture(), view = presentation(); f.runtime.attach(view); runtimes.delete(f.runtime);
  return { reference: new WeakRef(f.runtime), client: (f.runtime as unknown as { client: import('../src/occipital/client.ts').SyntaxClient }).client, view };
}
test('first runtime is collectible while its borrowed client still has active provider callbacks', { skip: !global.gc }, async () => {
  const borrowed = borrowedClient(); await settled();
  try {
    assert.equal(borrowed.client.snapshot().provider.availability, 'ready');
    assert.equal(await collected(borrowed.reference), true);
    const before = structuredClone(borrowed.view.calls);
    await borrowed.client.setEnabled(false); await settled();
    assert.deepEqual(borrowed.view.calls, before, 'retained weak callbacks cannot resurrect their installer');
  } finally { await borrowed.client.dispose(); }
});
function temporaryTheme(runtime: SyntaxRuntime) {
  const theme = { colors: {} }; runtime.palette(theme); return new WeakRef(theme.colors);
}
test('palette generation does not retain the first public Pi palette object', { skip: !global.gc }, async () => {
  const f = fixture(); assert.equal(await collected(temporaryTheme(f.runtime)), true);
  assert.equal(f.shared(), 0); assert.equal(f.store.loads, 0);
});

test('actual SDK stable Theme proxy changes its palette generation on a real dark/light switch', async () => {
  const themes = await import('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');
  themes.initTheme('dark', false);
  const f = fixture(), proxy = themes.theme, colors = proxy.colors, stamp = f.runtime.palette(proxy);
  try {
    for (let i = 0; i < 20; i++) assert.equal(f.runtime.palette(proxy), stamp);
    themes.initTheme('light', false);
    assert.equal(themes.theme, proxy, 'the public Theme is a stable proxy');
    assert.notEqual(proxy.colors, colors, 'the documented cached palette is replaced');
    const changed = f.runtime.palette(proxy);
    assert.notEqual(changed, stamp);
    for (let i = 0; i < 20; i++) assert.equal(f.runtime.palette(proxy), changed);
    await settled(); assert.equal(f.shared(), 0); assert.equal(f.store.loads, 0); assert.equal(f.owned(), 0);
  } finally { themes.initTheme('dark', false); }
});
