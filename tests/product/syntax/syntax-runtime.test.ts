import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import type { ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { CARD_ROLES, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import type { SourceController } from '../../../src/occipital/controller.ts';
import type { SettingsLoadResult, SettingsSaveResult, SyntaxTheme } from '../../../src/settings.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function descriptor(ticket: unknown) {
  return semanticDescriptor(ticket, 'runtime');
}
class Peer implements ProviderTransport {
  private termination = deferred<TransportEnd>();
  ended = this.termination.promise;
  endReason: TransportEnd | undefined;
  calls: { request: Record<string, any>; reply: ReturnType<typeof deferred<unknown>> }[] = [];
  closes = 0;
  request(request: Record<string, unknown>) {
    assert.equal(request.v, 4);
    const reply = deferred<unknown>(); this.calls.push({ request, reply });
    if (request.op === 'describe') reply.resolve(descriptor(request.ticket));
    return reply.promise;
  }
  answer(index: number) {
    const { request: r, reply } = this.calls[index]!, s = r.sources[0];
    const bytes = Buffer.byteLength(s.text);
    assert.equal(Object.hasOwn(s, 'profile'), false, 'v4 SOURCE is theme-independent');
    assert.equal(Object.hasOwn(s, 'fingerprint'), false);
    reply.resolve({ v: 4, ticket: r.ticket, instance: 'runtime', assets: 'assets', status: 'ok', body: {
      kind: 'source', vocabulary: 'a'.repeat(64), sources: [{ key: s.key, generation: s.generation, source_version: s.source_version,
        revision: 1, replace_from: 0, source_bytes: bytes,
        committed_bytes: bytes, complete: true, contexts: [[0, 1]], runs: [bytes, 1],
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
  const calls = { metadata: 0, keys: [] as string[][], groups: [] as number[][], order: [] as string[] };
  return { active: true, calls, syntaxMetadataChanged() { calls.metadata++; calls.order.push('metadata'); },
    syntaxSourceChanged(keys: readonly string[], groups?: readonly number[]) {
      calls.keys.push([...keys]); calls.groups.push([...(groups ?? [])]); calls.order.push('source');
    } };
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
  assert.ok(p); return { key, version: 1, text: 'x', complete: true };
}

const definition = { revision: 2 as const, binding_slots: 0,
  default: { foreground: { kind: 'inherit' as const }, background: { kind: 'inherit' as const }, attributes: 0, attribute_mask: 0 }, rules: [] };
function localSelection(revision = 1) {
  const style: ConcreteStyle = { foreground: { kind: 'rgb', r: revision, g: 2, b: 3 }, background: { kind: 'terminal-default' }, attributes: 0 };
  return { definition, bindingRevision: revision, palette: `local:${revision}`, bindings: [],
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, style])) as Record<CardRole, ConcreteStyle> };
}
function emptyPreparation(sources: SourceController) {
  let preparations = 0;
  const preparation = { keys: new Set<string>(), prepare() { preparations++; }, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const group = sources.registerPreparation(preparation)!; assert.ok(group);
  return { preparation, group, preparations: () => preparations, publish() { sources.queuePreparation(group, true); sources.flush(); } };
}
function queuedGroup(sources: SourceController, id: number) {
  const pending = sources as unknown as { noticeScheduled: boolean; noticeGroups: Set<number> };
  assert.equal(pending.noticeScheduled, true, 'a real controller notice is scheduled before lifecycle changes');
  assert.deepEqual([...pending.noticeGroups], [id]);
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
  assert.deepEqual(view.calls.keys, [['one']]); assert.deepEqual(view.calls.groups, [[]]);
  assert.equal(f.runtime.sources.status('one')?.acknowledgedVersion, 1, 'notice follows a validated v4 source reply');
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
  loaded.resolve({ ok: true, syntaxTheme: { kind: 'theme', id: 'saved' } }); await preparing;
  assert.deepEqual(f.runtime.snapshot().selected, { kind: 'theme', id: 'saved' });
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
  await f.runtime.dispose(); const before = structuredClone(view.calls);
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
  return { reference: new WeakRef(f.runtime), client: (f.runtime as unknown as { client: import('../../../src/occipital/client.ts').SyntaxClient }).client, view };
}
test('first runtime is collectible while its borrowed client still has active provider callbacks', async () => {
  assert.equal(typeof global.gc, 'function');
  const borrowed = borrowedClient(); await settled();
  const target = emptyPreparation(borrowed.client.sources);
  try {
    assert.equal(borrowed.client.snapshot().provider.availability, 'ready');
    borrowed.client.sources.setStyleSelection(localSelection()); target.publish(); await settled();
    assert.deepEqual(borrowed.view.calls.groups, [[target.group.id]], 'borrowed client has exercised the real runtime callback');
    assert.equal(await collected(borrowed.reference), true);
    const before = structuredClone(borrowed.view.calls);
    borrowed.client.sources.setStyleSelection(localSelection(2)); borrowed.client.sources.flush();
    queuedGroup(borrowed.client.sources, target.group.id); await settled();
    assert.equal(borrowed.client.snapshot().provider.availability, 'ready', 'the borrowed client stays active after its first runtime collects');
    await borrowed.client.setEnabled(false); await settled();
    assert.deepEqual(borrowed.view.calls, before, 'retained source and metadata callbacks cannot resurrect their installer');
  } finally { void target.preparation; await borrowed.client.dispose(); }
});
function temporaryTheme(runtime: SyntaxRuntime) {
  const theme = { colors: {} }; runtime.palette(theme); return new WeakRef(theme.colors);
}
test('palette generation does not retain the first public Pi palette object', async () => {
  assert.equal(typeof global.gc, 'function');
  const f = fixture(); assert.equal(await collected(temporaryTheme(f.runtime)), true);
  assert.equal(f.shared(), 0); assert.equal(f.store.loads, 0);
});

test('actual SDK stable Theme proxy changes its palette generation on a real dark/light switch', async () => {
  const themes = await import('../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');
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


test('runtime v4: palette-only publication forwards only the exact useful group through the real weak client chain', async () => {
  const f = fixture(), view = presentation(); f.runtime.attach(view); await settled();
  const sources = f.runtime.sources;
  assert.equal(sources.setStyleSelection(localSelection()), true); await settled();
  const dormant = emptyPreparation(sources), target = emptyPreparation(sources);
  try {
    const before = structuredClone(view.calls);
    assert.equal(sources.groupPresentation(dormant.group), undefined); assert.equal(sources.groupPresentation(target.group), undefined);
    target.publish(); queuedGroup(sources, target.group.id);
    assert.ok(sources.groupPresentation(target.group), 'empty sealed preparation publishes local roles before notice delivery');
    assert.deepEqual(view.calls, before, 'the runtime does not synchronously invent notifications');
    await settled();
    assert.deepEqual(view.calls.keys, [[]]); assert.deepEqual(view.calls.groups, [[target.group.id]]);
    assert.equal(sources.groupPresentation(target.group)!.role('panel')?.foreground.kind, 'rgb');
    assert.equal(sources.groupPresentation(dormant.group), undefined); assert.equal(dormant.preparations(), 0);
    assert.equal(target.preparations(), 1);
    assert.equal(view.calls.metadata - before.metadata, 1, 'only the frozen client coalesced metadata notice is delivered');
    assert.deepEqual(view.calls.order.slice(before.order.length), ['source', 'metadata']);
    const after = structuredClone(view.calls), stats = sources.stats();
    for (let i = 0; i < 20; i++) { f.runtime.snapshot(); sources.groupPresentation(target.group); sources.flush(); }
    await settled(); assert.deepEqual(view.calls, after);
    assert.deepEqual(f.peers[0]!.calls.map(c => c.request.op), ['describe'], 'no SOURCE or STYLE RPC for local empty contexts');
    assert.equal(stats.sourceRecords, 0); assert.equal(stats.preparedBytes, 0); assert.equal(stats.remoteLeases, 0);
    assert.equal(stats.retention.entries, 0); assert.equal(stats.globalUnsettledJobs, 0);
    assert.equal(sources.stats().stylePreparations, stats.stylePreparations);
    console.log(JSON.stringify({ runtimePaletteOnly: { groups: view.calls.groups, keys: view.calls.keys,
      metadataDelta: view.calls.metadata - before.metadata, order: view.calls.order.slice(before.order.length),
      sourceRecords: stats.sourceRecords, preparedBytes: stats.preparedBytes, rpc: f.peers[0]!.calls.map(c => c.request.op), dormantPreparations: dormant.preparations() } }));
  } finally { void dormant.preparation; void target.preparation; }
});

test('runtime v4: a genuinely queued palette notice follows the current presentation, not a still-active former owner', async () => {
  const f = fixture(), old = presentation(), current = presentation(); f.runtime.attach(old); await settled();
  const target = emptyPreparation(f.runtime.sources);
  try {
    f.runtime.sources.setStyleSelection(localSelection()); target.publish(); queuedGroup(f.runtime.sources, target.group.id);
    const before = structuredClone(old.calls); f.runtime.attach(current); await settled();
    assert.equal(old.active, true); assert.deepEqual(old.calls, before);
    assert.deepEqual(current.calls.keys, [[]]); assert.deepEqual(current.calls.groups, [[target.group.id]]);
    assert.deepEqual(current.calls.order, ['source', 'metadata']);
    assert.deepEqual(f.peers[0]!.calls.map(c => c.request.op), ['describe']);
  } finally { void target.preparation; }
});

test('runtime v4: inactive presentation suppresses a real queued notice and a later current owner receives fresh local publication', async () => {
  const f = fixture(), old = presentation(); f.runtime.attach(old); await settled();
  const target = emptyPreparation(f.runtime.sources);
  try {
    f.runtime.sources.setStyleSelection(localSelection()); target.publish(); queuedGroup(f.runtime.sources, target.group.id);
    const before = structuredClone(old.calls); old.active = false; await settled();
    assert.deepEqual(old.calls, before);
    const current = presentation(); f.runtime.attach(current); await settled();
    const currentBefore = current.calls.metadata;
    f.runtime.sources.setStyleSelection(localSelection(2)); f.runtime.sources.flush(); queuedGroup(f.runtime.sources, target.group.id);
    await settled(); assert.deepEqual(current.calls.keys, [[]]); assert.deepEqual(current.calls.groups, [[target.group.id]]);
    assert.equal(current.calls.metadata - currentBefore, 1); assert.deepEqual(old.calls, before);
    assert.equal(f.runtime.sources.stats().sourceRecords, 0);
  } finally { void target.preparation; }
});

for (const lifecycle of ['dispose', 'off/on'] as const) {
  test(`runtime v4: ${lifecycle} suppresses an actually scheduled palette-only notice`, async () => {
    const f = fixture(), view = presentation(); f.runtime.attach(view); await settled();
    const target = emptyPreparation(f.runtime.sources);
    try {
      f.runtime.sources.setStyleSelection(localSelection()); target.publish(); queuedGroup(f.runtime.sources, target.group.id);
      const before = structuredClone(view.calls);
      if (lifecycle === 'dispose') {
        await f.runtime.dispose(); await settled(); assert.deepEqual(view.calls, before);
        f.runtime.attach(presentation()); await settled(); assert.deepEqual(view.calls, before);
      } else {
        await f.runtime.setEnabled(false); await f.runtime.setEnabled(true); await settled();
        assert.deepEqual(view.calls.keys, []); assert.deepEqual(view.calls.groups, []);
        f.runtime.sources.setStyleSelection(localSelection(2)); target.publish(); queuedGroup(f.runtime.sources, target.group.id);
        await settled(); assert.deepEqual(view.calls.keys, [[]]); assert.deepEqual(view.calls.groups, [[target.group.id]]);
      }
      assert.equal(f.runtime.sources.stats().sourceRecords, 0);
      assert.ok(f.peers.every(peer => peer.calls.every(c => c.request.op === 'describe')));
    } finally { void target.preparation; }
  });
}


test('runtime Pi input remains lazy across attachment, menu and current native selection; explicit fallback preserves selection and source authority', async () => {
  const { DataBudget } = await import('../../../src/occipital/data-budget.ts');
  const { getThemeByName } = await import('../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');
  const f = fixture(), view = presentation(), native = getThemeByName('dark')!;
  let fg = 0, bg = 0;
  const theme = { colors: native.colors, getFgAnsi(role: Parameters<typeof native.getFgAnsi>[0]) { fg++; return native.getFgAnsi(role); },
    getBgAnsi(role: Parameters<typeof native.getBgAnsi>[0]) { bg++; return native.getBgAnsi(role); } };
  const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  f.runtime.palette(theme); f.runtime.attach(view); await settled();
  await f.runtime.prepareThemes(); f.runtime.previewTheme({ kind: 'theme', id: 'native-selected' });
  for (let i = 0; i < 20; i++) { f.runtime.snapshot(); f.runtime.palette(theme); }
  assert.deepEqual([fg, bg, budget.stats().retainedBytes], [0, 0, 0]);
  const selected = f.runtime.snapshot().selected, stats = f.runtime.sources.stats(), calls = f.peers[0]!.calls.length;
  const palette = f.runtime.snapshot().effective!;
  const lease = f.runtime.preparePaletteInput(palette, theme, f.runtime.palette(theme), 'truecolor', funding)!; assert.ok(lease); assert.ok(fg > 0 && bg > 0);
  assert.deepEqual(f.runtime.snapshot().selected, selected); assert.deepEqual(f.runtime.sources.stats(), stats);
  assert.equal(f.peers[0]!.calls.length, calls); assert.equal(f.store.writes.length, 0);
  lease.cleanupReceipt().release(); assert.equal(budget.stats().retainedBytes, 0);
});

test('runtime intentional suspend recovers outstanding source without destroying the source owner', async () => {
  const f = fixture(), view = presentation(); f.runtime.attach(view); await settled();
  const sources = f.runtime.sources, initial = demand(f.runtime);
  sources.observe(initial); sources.flush(); await settled();
  const first = f.peers[0]!;
  f.runtime.suspend(); await settled();
  assert.equal(first.closes, 1); assert.equal(f.shared(), 1); assert.equal(f.runtime.sources, sources);
  assert.equal(f.runtime.snapshot().enabled, true); assert.equal(f.runtime.snapshot().provider.reason, 'suspended');
  f.runtime.resume(); await settled(); await settled(); sources.flush(); await settled();
  assert.equal(f.shared(), 2); assert.deepEqual(f.peers[1]!.calls.map(c => c.request.op), ['describe', 'highlight']);
  f.peers[1]!.answer(1); await settled(); assert.equal(sources.status(initial.key)?.exact, true);
  const before = f.peers[1]!.calls.length;
  f.runtime.suspend(); f.runtime.resume(); await settled(); sources.flush();
  assert.equal(f.shared(), 2); assert.equal(f.peers[1]!.calls.length, before);
  assert.deepEqual(f.changes, []); assert.equal(f.store.writes.length, 0);
});
