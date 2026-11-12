import { SourceExecution } from '../../../src/highlighting/source-execution.ts';
import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeHealth } from '../../../src/runtime-health.ts';
import { reportRuntime } from '../../../src/diagnostics.ts';
import { SyntaxClient, type SyntaxClientOptions } from '../../../src/application/syntax-client.ts';
import { ApplicationPreferences, type PreferenceStore } from '../../../src/application/preferences.ts';
import { ExtensionSettings, SETTINGS_FILE_MAX_BYTES, type SettingsLoadResult, type SettingsPatch, type SettingsSaveResult,
  type SyntaxTheme } from '../../../src/settings.ts';
import type { ThemePreference, ThemeVariant } from '../../../src/appearance/theme-preference.ts';
import type { ProviderClock, ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { createSemanticRuleDefinition } from '../../../src/syntax/semantic-rules.ts';
import { ownedStyleSelection } from '../../fixtures/owned-style-selection.ts';

const pi = { id: 'pi', label: 'Follow Pi', fingerprint: 'pi-palette-v1' };
const piPreference: ThemePreference = { kind: 'pi', variant: 'dark' };
const preference = (id: string, variant: ThemeVariant = 'dark'): Extract<ThemePreference, { kind: 'theme' }> =>
  ({ kind: 'theme', id: id.replace(/-(?:dark|light)$/u, ''), variant });
const themeChoice = preference('gruvbox-dark');
const native = { id: 'gruvbox-dark', label: 'Gruvbox Dark', fingerprint: 'owned-palette-v2:gruvbox-dark' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function descriptor(ticket: unknown) { return semanticDescriptor(ticket, 'instance'); }
type Call = { request: Record<string, any>; options?: Parameters<ProviderTransport['request']>[1]; resolve(value: unknown): void; reject(error: unknown): void };
class Peer implements ProviderTransport {
  private termination = deferred<TransportEnd>();
  ended = this.termination.promise;
  endReason: TransportEnd | undefined;
  calls: Call[] = [];
  holdMetadata = false; closes = 0; exit = Promise.resolve();
  end(reason: TransportEnd) { if (this.endReason === undefined) { this.endReason = reason; this.termination.resolve(reason); } }
  request(request: Record<string, unknown>, options?: Call['options']) {
    const pending = deferred<unknown>(); const call = { request, options, ...pending }; this.calls.push(call);
    if (request.op === 'describe' && !this.holdMetadata) this.answerMetadata(this.calls.length - 1);
    return pending.promise;
  }
  answerMetadata(index: number) { this.calls[index]!.resolve(descriptor(this.calls[index]!.request.ticket)); }
  fault(index: number, code: string) {
    this.calls[index]!.resolve({ v: 4, ticket: this.calls[index]!.request.ticket, instance: 'instance', assets: 'assets', status: 'error', error: { code, execution: 'not_started' } });
  }
  sourceReply(index: number, context = 1) {
    const r = this.calls[index]!.request, s = r.sources[0], bytes = Buffer.byteLength(s.text);
    assert.equal(r.v, 4); assert.equal(r.op, 'highlight');
    return { v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
      kind: 'source', vocabulary: descriptor(r.ticket).body.vocabulary.fingerprint, sources: [{
        key: s.key, generation: s.generation, source_version: s.source_version,
        revision: 1, replace_from: 0, source_bytes: bytes, committed_bytes: bytes, complete: true,
        contexts: bytes ? [[0, context]] : [], runs: bytes ? [bytes, 1] : [],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes },
      }] } };
  }
  answerSource(index: number, context = 1) { this.calls[index]!.resolve(this.sourceReply(index, context)); }
  answerStyle(index: number) {
    const r = this.calls[index]!.request; assert.equal(r.op, 'styles.resolve');
    assert.equal(Object.hasOwn(r, 'sources'), false); assert.equal(Object.hasOwn(r, 'text'), false);
    const expression = r.rules.default;
    this.calls[index]!.resolve({ v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
      kind: 'styles', vocabulary: r.vocabulary, rules: fingerprintRules(r.rules),
      styles: r.contexts.length ? [expression] : [], indices: r.contexts.map(() => 1),
    } });
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
  loads = 0; writes: { choice: SyntaxTheme; variant: ThemeVariant; signal?: AbortSignal }[] = [];
  restored: SettingsLoadResult = { ok: true, themePreference: piPreference };
  loadResult?: Promise<SettingsLoadResult>;
  saveResult: SettingsSaveResult | Promise<SettingsSaveResult> = { ok: true };
  load() { this.loads++; return this.loadResult ?? Promise.resolve(this.restored); }
  update(patch: SettingsPatch, options?: { signal?: AbortSignal }) {
    this.writes.push({ choice: patch.syntaxTheme!, variant: patch.syntaxThemeVariant!, signal: options?.signal });
    return Promise.resolve(this.saveResult);
  }
}
const clients = new Set<SyntaxClient>();
afterEach(async () => { for (const c of clients) await c.dispose(); clients.clear(); await settle(); });
async function settle() { await turn(); }
function fixture(extra: Partial<SyntaxClientOptions> & { settings?: PreferenceStore } = {}, store = new Store(), peer = new Peer()) {
  let acquisitions = 0, sharedAttempts = 0, notices = 0; const errors: string[] = [];
  const { settings = store, ...options } = extra;
  const preferences = new ApplicationPreferences(settings, { appearanceEnabled: true, loggingEnabled: true });
  const themeScope = preferences.openThemeScope(options.diagnostic);
  const c = new SyntaxClient({ provider: { tryShared: async () => { sharedAttempts++; return peer; }, acquireOwned: async () => { acquisitions++; return new Peer(); } },
    standaloneVersion: '0.1.0', initialTheme: options.initialTheme ?? preferences.themeInput(),
    onActivationChanged: themeScope.onActivationChanged, onDisposed: themeScope.onDisposed,
    notify: message => { errors.push(message); }, onChange: () => { notices++; }, ...options });
  themeScope.bind(c);
  clients.add(c); return { c, preferences, themeScope, peer, store, errors, acquisitions: () => acquisitions, sharedAttempts: () => sharedAttempts, notices: () => notices };
}
function demand(c: SyntaxClient, key = 'one') {
  return { key, version: 1, text: 'x', complete: true };
}

function nativeStyles(c: Pick<SyntaxClient, 'cardSource' | 'sourcePump'>, id = native.id) {
  c.cardSource.setStyleSelection(ownedStyleSelection(id)); c.sourcePump.flush();
}
async function parsedSources(f: ReturnType<typeof fixture>, keys: string[], firstContext = 1) {
  for (const [offset, key] of keys.entries()) {
    f.c.sourceWork.observe(demand(f.c, key)); f.c.sourcePump.flush();
    const index = f.peer.calls.length - 1; assert.equal(f.peer.calls[index]!.request.op, 'highlight');
    f.peer.answerSource(index, firstContext + offset); await settle();
  }
}

test('constructor, snapshots, source inspection and menu captures never load, acquire or dispatch', async () => {
  const f = fixture({ initialTheme: piPreference }); const before = f.c.sourceStatistics.stats(); const capture = f.c.captureMenu();
  for (let i = 0; i < 20; i++) { f.c.snapshot(); f.c.sourceWork.status('one'); f.c.sourcePump.flush(); assert.equal(capture(), true); }
  assert.equal(f.store.loads, 0); assert.equal(f.store.writes.length, 0); assert.equal(f.sharedAttempts(), 0);
  assert.equal(f.acquisitions(), 0); assert.equal(f.peer.calls.length, 0); assert.deepEqual(f.c.sourceStatistics.stats(), before);
  assert.equal(f.c.sourceWork.observe({ key: 'one', version: 1, text: 'x', complete: true }), false);
  assert.equal(f.c.snapshot().enabled, true); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.peer.calls.length, 0);
});
for (const choice of [piPreference, themeChoice, preference('missing')] as ThemePreference[]) {
  test(`one startup restores ${JSON.stringify(choice)} without writing defaults`, async () => {
    const store = new Store(); store.restored = { ok: true, themePreference: choice }; const f = fixture({}, store);
    const a = f.c.start(), b = f.c.start(); assert.equal(a, b); await a; await f.c.start();
    assert.equal(store.loads, 1); assert.equal(store.writes.length, 0); assert.equal(f.sharedAttempts(), 1); assert.equal(f.acquisitions(), 0);
    assert.deepEqual(f.c.snapshot().selected, choice); assert.equal(f.c.snapshot().effective?.id, choice.kind === 'theme' && choice.id === 'gruvbox' ? native.id : pi.id);
    assert.equal(f.errors.length, choice.kind === 'theme' && choice.id === 'missing' ? 1 : 0);
    assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
  });
}

test('provider readiness does not publish a palette before settings load; explicit choice beats slow load', async () => {
  const restored = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = restored.promise; const f = fixture({}, store);
  const start = f.c.start(); await settle(); assert.ok(f.c.snapshot().provider.description); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.c.sourceWork.observe({ key: 'one', version: 1, text: 'x', complete: true }), false);
  const choice: ThemePreference = preference(native.id); await f.preferences.confirmTheme(f.themeScope, choice); choice.id = 'mutated';
  assert.deepEqual(f.c.snapshot().selected, themeChoice); assert.equal(f.c.snapshot().effective?.id, native.id);
  restored.resolve({ ok: true, themePreference: piPreference }); await start;
  assert.equal(f.c.snapshot().effective?.id, native.id); assert.equal(f.peer.calls.length, 1);
  const snapshot = f.c.snapshot(); (snapshot.selected as { id: string }).id = 'bad'; (snapshot.effective as { fingerprint: string }).fingerprint = 'bad';
  assert.equal(f.c.snapshot().effective?.fingerprint, native.fingerprint); assert.equal((f.c.snapshot().selected as { id: string }).id, 'gruvbox');
  assert.equal(f.c.snapshot().provider.description, f.c.broker.snapshot().description);
});

test('application settings failure supplies Pi defaults and one bounded health report without a second native reader', async () => {
  const store = new Store(); store.restored = { ok: false, themePreference: piPreference, issue: { code: 'invalid-theme', message: 'Settings contain an invalid syntax theme preference.' } };
  const notices: string[] = [], health = new RuntimeHealth(message => notices.push(message)), diagnostic = health.sink(() => {});
  const f = fixture({ diagnostic }, store); await f.c.start(); f.preferences.reportInitialIssue(diagnostic); await settle();
  assert.equal(f.c.snapshot().effective?.id, 'pi'); assert.equal(store.writes.length, 0); assert.equal(store.loads, 1);
  assert.equal(f.errors.length, 0); assert.equal(health.snapshot().errors, 1); assert.equal(notices.length, 1);
  const otherNotices: string[] = [], otherHealth = new RuntimeHealth(message => otherNotices.push(message)), otherDiagnostic = otherHealth.sink(() => {});
  const other = fixture({ diagnostic: otherDiagnostic, settings: { load: async () => { throw Error('/SECRET/path'); }, update: async () => ({ ok: true }) } });
  await other.c.start(); other.preferences.reportInitialIssue(otherDiagnostic); await settle();
  assert.equal(other.c.snapshot().effective?.id, 'pi'); assert.equal(other.errors.length, 0); assert.equal(otherNotices.length, 1);
  assert.doesNotMatch(otherNotices[0]!, /SECRET/); assert.equal(JSON.stringify(other.c.snapshot()).includes('SECRET'), false);
});

test('real store failure keeps prior disk and new active choice; cancellation signals are per-save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syntax-client-')); const file = join(directory, 'config.json');
  try {
    const previous = '{"syntaxTheme":{"kind":"pi"}}\n'; await writeFile(file, previous);
    const settings = new ExtensionSettings({ file }); const f = fixture({ settings }); await f.c.start();
    await writeFile(file, 'invalid'); assert.equal((await f.preferences.confirmTheme(f.themeScope, preference(native.id))).ok, false);
    assert.equal(f.c.snapshot().effective?.id, native.id); assert.equal(await readFile(file, 'utf8'), 'invalid');
    assert.equal(f.c.snapshot().lastIssue?.includes('invalid JSON'), true);
    const fixed = { syntaxTheme: { kind: 'pi' }, unknown: '' };
    fixed.unknown = 'x'.repeat(SETTINGS_FILE_MAX_BYTES - Buffer.byteLength(JSON.stringify(fixed)));
    const valid = JSON.stringify(fixed); await writeFile(file, valid);
    const retained = fixture({ settings }); await retained.c.start();
    assert.equal(retained.c.snapshot().effective?.id, 'pi');
    assert.equal((await retained.preferences.confirmTheme(retained.themeScope, preference(native.id))).ok, false);
    assert.equal(retained.c.snapshot().effective?.id, native.id);
    assert.equal(await readFile(file, 'utf8'), valid, 'failed oversized replacement must keep previous valid disk file');
  } finally { await rm(directory, { recursive: true, force: true }); }
  const held = deferred<SettingsSaveResult>(), store = new Store(); store.saveResult = held.promise; const f = fixture({}, store); await f.c.start();
  const first = f.preferences.confirmTheme(f.themeScope, preference(native.id)); const second = f.preferences.confirmTheme(f.themeScope, piPreference);
  assert.notEqual(store.writes[0]!.signal, store.writes[1]!.signal); assert.equal(store.writes[0]!.signal!.aborted, true);
  const off = f.c.setEnabled(false); assert.equal(store.writes[1]!.signal!.aborted, true); await off;
  const third = f.preferences.confirmTheme(f.themeScope, piPreference); assert.equal(store.writes[2]!.signal!.aborted, false);
  await f.c.dispose(); assert.equal(store.writes[2]!.signal!.aborted, true);
  held.resolve({ ok: false, issue: { code: 'write-failed', message: 'SECRET' } }); await Promise.all([first, second, third]);
  assert.equal(f.c.snapshot().lastIssue, undefined); assert.equal(f.errors.length, 0);
});

test('off retires sources and saves synchronously; captures never revive, including initially disabled captures', async () => {
  const f = fixture(); const initial = f.c.captureMenu(); await f.c.setEnabled(false);
  assert.equal(initial(), false); const disabled = f.c.captureMenu(); assert.equal(disabled(), true); await f.c.start();
  assert.equal(f.sharedAttempts(), 0); assert.equal(f.store.loads, 1); assert.equal(f.c.snapshot().effective?.id, pi.id);
  await f.preferences.confirmTheme(f.themeScope, preference(native.id)); assert.equal(f.sharedAttempts(), 0);
  await f.c.setEnabled(true); assert.equal(disabled(), false); assert.equal(initial(), false); assert.equal(f.c.snapshot().effective?.id, native.id);
  const live = f.c.captureMenu(); const source = demand(f.c); f.c.sourceWork.observe(source); f.c.sourcePump.flush();
  const call = f.peer.calls.at(-1)!; const exit = deferred<void>(); f.peer.exit = exit.promise;
  const stopping = f.c.setEnabled(false); assert.equal(call.options!.signal!.aborted, true); assert.equal(f.c.sourceStatistics.stats().sourceRecords, 1, 'off retains paid primitive execution evidence, not native payload');
  assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, 0); assert.equal(live(), false);
  assert.equal(f.c.snapshot().enabled, false); exit.resolve(); await stopping;
  await f.c.setEnabled(true); assert.equal(live(), false); assert.equal(f.store.loads, 1); assert.equal(f.store.writes.length, 1);
  const final = f.c.captureMenu(); await f.c.dispose(); assert.equal(final(), false); assert.equal(f.c.captureMenu()(), false);
  const counts = [f.sharedAttempts(), f.store.writes.length, f.notices(), f.errors.length];
  await f.c.start(); await f.c.setEnabled(true); await f.preferences.confirmTheme(f.themeScope, piPreference); await settle();
  assert.deepEqual([f.sharedAttempts(), f.store.writes.length, f.notices(), f.errors.length], counts);
});

test('unknown local theme warns once; palette choice is independent of provider metadata', async () => {
  const missing = 'quote"\n\u001b'; const store = new Store(); store.restored = { ok: true, themePreference: preference(missing) };
  const f = fixture({}, store); await f.c.start();
  assert.equal(f.errors.length, 1); assert.ok(f.errors[0]!.includes(JSON.stringify(missing))); assert.equal(f.errors[0]!.includes('\u001b'), false);
  assert.equal(f.c.snapshot().effective?.id, 'pi');
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(f.errors.length, 1);
  await f.preferences.confirmTheme(f.themeScope, themeChoice);
  assert.equal(f.errors.length, 1); assert.equal(f.c.snapshot().effective?.id, native.id);
  assert.deepEqual(f.c.snapshot().selected, themeChoice); assert.equal(store.writes.length, 1);
  assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
});

test('local palette changes never reparse or re-request SOURCE', async () => {
  const f = fixture(); await f.c.start(); await f.preferences.confirmTheme(f.themeScope, themeChoice);
  const source = demand(f.c); f.c.sourceWork.observe(source); f.c.sourcePump.flush(); f.peer.answerSource(1); await settle();
  const stats = f.c.sourceStatistics.stats(), accepted = f.c.broker.stats().successfulClassifications;
  const calls = f.peer.calls.length;
  await f.preferences.confirmTheme(f.themeScope, preference('solarized')); await settle();
  assert.equal(f.c.snapshot().effective?.id, 'solarized-dark');
  assert.equal(f.peer.calls.length, calls, 'owned palette selection is local and does not ask the helper for a theme catalogue');
  assert.deepEqual(f.c.sourceStatistics.stats(), stats); assert.equal(f.c.broker.stats().successfulClassifications, accepted);
});
test('ordinary off/on preserves initialShared and does not restart an old return window', async () => {
  const clock = new Clock(), first = new Peer(); let attempts = 0;
  const f = fixture({ provider: { clock, tryShared: async () => ++attempts === 1 ? first : undefined, acquireOwned: async () => new Peer() } });
  await f.c.start(); first.end('lost'); await settle(); assert.equal(f.c.snapshot().provider.kind, 'owned');
  const episodes = f.c.broker.stats().recoveryEpisodes;
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(f.c.snapshot().provider.initialShared, true);
  assert.equal(f.c.broker.stats().recoveryTimers, 0); assert.equal(f.c.broker.stats().recoveryEpisodes, episodes);
  await clock.advance(600000); assert.equal(f.c.broker.stats().probesStarted, 0); assert.equal(f.store.writes.length, 0);
});

function detachedOwner(peer: Peer, preferences: ApplicationPreferences) {
  const themeScope = preferences.openThemeScope();
  const c = new SyntaxClient({ provider: { tryShared: async () => peer, acquireOwned: async () => new Peer() }, standaloneVersion: '0.1.0', initialTheme: piPreference,
    onActivationChanged: themeScope.onActivationChanged, onDisposed: themeScope.onDisposed });
  themeScope.bind(c);
  const execution = c.sourceWork;
  assert.ok(execution instanceof SourceExecution);
  assert.equal(c.sourcePump, execution); assert.equal(c.sourceStatistics, execution); assert.equal(c.sourceLifecycle, execution);
  return { weak: new WeakRef(c), broker: c.broker, execution, start: c.start() };
}
function nativeScopeProbe(preferences: ApplicationPreferences) {
  const scope = preferences.openThemeScope();
  const client = new SyntaxClient({ standaloneVersion: 'scope-release', initialTheme: piPreference,
    provider: { tryShared: async () => new Peer(), acquireOwned: async () => new Peer() },
    onActivationChanged: scope.onActivationChanged, onDisposed: scope.onDisposed });
  scope.bind(client); clients.add(client);
  return { client, scope: new WeakRef(scope) };
}
test('application preference owner releases retired native scope while the factory and client remain live', { timeout: 10000 }, async () => {
  assert.equal(typeof global.gc, 'function');
  const preferences = new ApplicationPreferences(new Store(), { appearanceEnabled: true, loggingEnabled: true });
  const probe = nativeScopeProbe(preferences);
  for (let i = 0; i < 3; i++) { await delay(0); global.gc!(); await delay(0); }
  assert.equal(probe.scope.deref() !== undefined, true, 'an active native incarnation has a real retained confirmation scope');
  await probe.client.dispose();
  for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!probe.scope.deref()) break; }
  assert.equal(probe.scope.deref() === undefined, true, 'actual native disposal releases the matching confirmation scope');
  assert.deepEqual(preferences.selectedTheme, piPreference);
  assert.equal(probe.client.snapshot().provider.availability, 'disposed');
});
test('retained production broker/source observer callbacks cannot retain first owner under active second client', async () => {
  assert.equal(typeof global.gc, 'function', 'run this control with --expose-gc');
  const preferences = new ApplicationPreferences(new Store(), { appearanceEnabled: true, loggingEnabled: true });
  const peer = new Peer(), first = detachedOwner(peer, preferences); await first.start;
  const second = fixture(); await second.c.start();
  for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
  assert.equal(first.weak.deref() === undefined, true, 'live preference scope and borrowed native owners must not retain the first client');
  assert.deepEqual(preferences.selectedTheme, piPreference);
  assert.equal(second.c.snapshot().provider.availability, 'ready');
  first.execution.observe({ key: 'collected', version: 1, text: 'x', complete: true });
  first.execution.flush(); peer.answerSource(1); await settle();
  assert.equal(peer.calls.length, 2, 'retained source observer must not resurrect collected client metadata work');
  assert.equal(second.c.snapshot().provider.availability, 'ready'); first.execution.dispose(); await first.broker.dispose();
});

test('explicit preference before start is not overwritten by startup restore; known late restore gates native work', async () => {
  const early = fixture(); await early.preferences.confirmTheme(early.themeScope, preference(native.id)); await early.c.start();
  assert.equal(early.c.snapshot().effective?.id, native.id); assert.equal(early.store.loads, 1);
  const load = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = load.promise;
  const f = fixture({}, store); const start = f.c.start(); await settle();
  const piDemand = { key: 'one', version: 1, text: 'x', complete: true };
  assert.equal(f.c.sourceWork.observe(piDemand), false); f.c.sourcePump.flush(); assert.equal(f.peer.calls.length, 1);
  load.resolve({ ok: true, themePreference: preference(native.id) }); await start;
  f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
  assert.equal(f.c.snapshot().effective?.id, native.id);
  assert.equal(Object.hasOwn(f.peer.calls[1]!.request.sources[0], 'profile'), false);
  assert.equal(Object.hasOwn(f.peer.calls[1]!.request.sources[0], 'fingerprint'), false);
  f.peer.answerSource(1); await settle(); nativeStyles(f.c); f.peer.answerStyle(2); await settle();
  assert.ok(f.c.sourceWork.displayBasis('one')); assert.equal(f.peer.calls[2]!.request.rules.revision, 2);
  assert.equal(f.peer.calls[2]!.request.rules.binding_slots, 44);
  assert.equal(f.c.broker.stats().successfulClassifications, 1); assert.equal(f.c.broker.stats().styleDispatches, 1);
});

test('stale source reply after current content demand cannot publish or reset classification crash budget', async () => {
  const f = fixture(); await f.c.start(); f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
  const old = f.peer.calls[1]!; await f.preferences.confirmTheme(f.themeScope, preference(native.id));
  f.c.sourceWork.observe({ ...demand(f.c), version: 2, text: 'y' }); f.c.sourcePump.flush();
  assert.equal(old.options?.signal?.aborted, true, 'content replacement retires parser work, unlike theme-only selection');
  assert.equal(old.options?.acceptRetired, true, 'canonical terminal evidence passes through the broker');
  f.peer.answerSource(1); await settle(); assert.equal(f.c.sourceStatistics.stats().staleReplies, 1);
  assert.equal(f.c.broker.stats().successfulClassifications, 0); assert.equal(f.c.sourceWork.status('one')?.classificationVersion, undefined);
  assert.equal(Object.hasOwn(f.peer.calls[2]!.request.sources[0], 'profile'), false); f.peer.answerSource(2); await settle();
  assert.equal(f.c.sourceWork.status('one')?.exact, true); assert.equal(f.c.broker.stats().successfulClassifications, 1);
});

test('theme-only selection accepts held SOURCE once while obsolete STYLE cannot publish the new definition', async () => {
  const f = fixture(); await f.c.start(); f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
  const source = f.peer.calls[1]!;
  await f.preferences.confirmTheme(f.themeScope, themeChoice); nativeStyles(f.c, 'gruvbox-dark');
  f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
  assert.equal(f.peer.calls.length, 2); assert.equal(source.options?.signal?.aborted, false);
  f.peer.answerSource(1); await settle(); assert.equal(f.c.sourceWork.status('one')?.exact, true);
  assert.equal(f.c.broker.stats().successfulClassifications, 1); assert.equal(f.peer.calls[2]!.request.op, 'styles.resolve');
  nativeStyles(f.c, 'solarized-dark');
  f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
  assert.equal(f.peer.calls[2]!.options?.signal?.aborted, false, 'the shared semantic definition keeps its physical settlement');
  f.peer.answerStyle(2); await settle(); assert.ok(f.c.sourceWork.displayBasis('one'));
  assert.equal(f.c.sourceStatistics.stats().staleReplies, 0);
  assert.equal(f.c.broker.stats().sourceDispatches, 1); assert.equal(f.c.broker.stats().styleDispatches, 1);
  assert.equal(f.c.broker.stats().successfulClassifications, 1); assert.equal(f.peer.calls.length, 3);
});



test('late startup preference/provider completions after disposal neither publish nor notify nor acquire owned', async () => {
  const load = deferred<SettingsLoadResult>(), connection = deferred<ProviderTransport | undefined>(), store = new Store(); store.loadResult = load.promise;
  let acquired = 0; const f = fixture({ provider: { tryShared: async () => connection.promise, acquireOwned: async () => { acquired++; return new Peer(); } } }, store);
  const start = f.c.start(); await settle(); await f.c.dispose(); const notices = f.notices();
  const late = new Peer(); connection.resolve(late); load.resolve({ ok: true, themePreference: preference('missing') });
  await start; await settle(); assert.equal(acquired, 0); assert.equal(late.closes, 1); assert.equal(late.calls.length, 0);
  assert.equal(f.c.snapshot().provider.availability, 'disposed'); assert.equal(f.c.snapshot().effective, undefined);
  assert.equal(f.c.sourceWork.observe({ key: 'one', version: 1, text: 'x', complete: true }), false);
  assert.equal(f.notices(), notices); assert.equal(f.errors.length, 0); assert.equal(store.writes.length, 0);
});

test('local palette and UI changes never reset the owned restart budget; deliberate off/on permits a new attempt', async () => {
  const peers: Peer[] = []; const f = fixture({ provider: { tryShared: async () => undefined, acquireOwned: async () => { const peer = new Peer(); peers.push(peer); return peer; } } });
  await f.c.start(); assert.equal(peers.length, 1);
  for (let i = 0; i < 3; i++) {
    await f.preferences.confirmTheme(f.themeScope, piPreference); f.c.snapshot(); f.c.captureMenu()();
    peers[i]!.end('lost'); await settle();
  }
  assert.equal(peers.length, 3); assert.equal(f.c.snapshot().provider.reason, 'restart_limit');
  assert.equal(f.c.broker.stats().successfulClassifications, 0); assert.equal(f.c.broker.stats().ownedRestarts, 2);
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(peers.length, 4);
  assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(f.c.snapshot().provider.initialShared, false);
});


test('client forwards coalesced source keys without turning local palette changes into source notifications', async () => {
  const packets: string[][] = [];
  const { c, preferences, themeScope, peer } = fixture({ onSourceChange: (keys: readonly string[]) => { packets.push([...keys]); } });
  await c.start(); await settle(); assert.equal(packets.length, 0);
  c.sourceWork.observe(demand(c, 'one')); c.sourceWork.observe(demand(c, 'two')); c.sourcePump.flush();
  assert.equal(peer.calls.length, 3); peer.answerSource(1); peer.answerSource(2); await settle();
  assert.deepEqual(packets.map(keys => keys.toSorted()), [['one', 'two']]);
  const before = c.sourceStatistics.stats();
  await preferences.confirmTheme(themeScope, themeChoice); await settle();
  assert.deepEqual(packets.map(keys => keys.toSorted()), [['one', 'two']]);
  assert.equal(c.sourceStatistics.stats().dispatches, before.dispatches);
  assert.equal(c.sourceStatistics.stats().preparedBytes, before.preparedBytes);
});

test('a throwing source-specific client observer cannot lose generic delivery or trigger metadata work', async () => {
  let sourceNotices = 0;
  const { c, preferences, themeScope, peer, notices } = fixture({ onSourceChange: (_keys: readonly string[]) => { sourceNotices++; throw Error('external presentation'); } });
  await c.start(); await preferences.confirmTheme(themeScope, themeChoice); await settle(); const before = notices();
  c.sourceWork.observe(demand(c)); c.sourcePump.flush(); peer.answerSource(1); await settle();
  assert.equal(sourceNotices, 1); nativeStyles(c); peer.fault(2, 'busy'); await settle();
  assert.equal(sourceNotices, 1, 'STYLE refusal is generic presentation state, not a new source/group publication'); assert.ok(notices() > before);
  assert.equal(peer.calls.filter(call => call.request.op === 'describe').length, 1);
  const source = c.sourceStatistics.stats(); assert.equal(source.globalUnsettledJobs, 0);
  assert.equal(c.broker.stats().successfulClassifications, 1); assert.equal(c.broker.stats().styleDispatches, 1);
  await c.setEnabled(false); await settle();
  c.acceptSourceChange(['one']); await settle();
  assert.equal(sourceNotices, 1, 'retired source delivery cannot reach the external observer');
});


test('client forwards useful canonical permission notices while off, never guessing stop from shared or failed owned cleanup', async () => {
  for (const kind of ['shared', 'owned', 'failed'] as const) {
    const peer = new Peer(), exit = deferred<void>(), packets: string[][] = [];
    peer.exit = exit.promise;
    const f = fixture({ provider: { tryShared: async () => kind === 'shared' ? peer : undefined, acquireOwned: async () => peer },
      onSourceChange: keys => packets.push([...keys]) }, new Store(), peer);
    await f.c.start(); f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
    const off = f.c.setEnabled(false); await settle();
    assert.equal(f.c.sourceWork.workStatus('one').fallbackEligible, false);
    assert.equal(f.c.sourceWork.workStatus('unrelated').fallbackEligible, true);
    assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, 0);
    packets.length = 0;
    if (kind === 'failed') exit.reject(new Error('failed reap')); else exit.resolve();
    await off; await settle();
    assert.equal(f.c.sourceWork.workStatus('one').fallbackEligible, kind === 'owned');
    assert.deepEqual(packets, kind === 'owned' ? [['one']] : []);
    assert.equal(f.c.broker.stats().successfulClassifications, 0);
    assert.equal(peer.calls.length, 2, 'no hidden retry/native source work');
  }
});

test('canonical client receives a fully validated retired shared outcome without stale publication or useful credit', async () => {
  for (const outcome of ['complete', 'not_started', 'malformed', 'wrong_vocabulary', 'wrong_source', 'wrong_job'] as const) {
    const peer = new Peer(), packets: string[][] = [];
    peer.close = () => { peer.closes++; peer.end('closed'); return Promise.resolve(); };
    const f = fixture({ onSourceChange: keys => packets.push([...keys]) }, new Store(), peer);
    await f.c.start(); f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush();
    await f.c.setEnabled(false); await settle(); assert.equal(f.c.sourceWork.workStatus('one').execution, 'unsettled');
    if (outcome === 'complete') peer.answerSource(1);
    else if (outcome === 'not_started') peer.fault(1, 'busy');
    else if (outcome === 'malformed') peer.calls[1]!.resolve({ v: 4, status: 'ok' });
    else {
      const reply = peer.sourceReply(1);
      if (outcome === 'wrong_vocabulary') reply.body.vocabulary = 'd'.repeat(64);
      else if (outcome === 'wrong_source') reply.body.sources[0]!.generation++;
      else reply.ticket = 'wrong:job';
      peer.calls[1]!.resolve(reply);
    }
    await settle();
    assert.equal(f.c.sourceWork.workStatus('one').fallbackEligible, outcome === 'complete' || outcome === 'not_started');
    assert.equal(f.c.sourceStatistics.stats().staleReplies, outcome === 'complete' ? 1 : 0);
    assert.deepEqual(packets, [['one']]);
    assert.equal(f.c.broker.stats().successfulClassifications, 0);
    assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, 0);
    assert.equal(f.c.sourceWork.status('one'), undefined); assert.equal(peer.calls.length, 2);
  }
});


test('theme preview applies immediately, copies the choice, coalesces notices and never persists', async () => {
  const f = fixture(); await f.c.start(); await settle();
  const choice: ThemePreference = preference(native.id);
  f.c.previewTheme(choice); choice.id = 'mutated';
  assert.deepEqual(f.c.snapshot().selected, themeChoice);
  assert.equal(f.c.snapshot().effective?.id, native.id);
  f.c.previewTheme(piPreference); f.c.previewTheme(preference(native.id)); f.c.previewTheme(piPreference);
  await settle(); assert.equal(f.c.snapshot().effective?.id, pi.id);
  assert.equal(f.store.writes.length, 0); assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
  const before = f.notices();
  for (let i = 0; i < 100; i++) f.c.previewTheme(piPreference);
  await settle(); assert.equal(f.notices(), before, 'unchanged previews are not new metadata demand');
  assert.equal((await f.preferences.confirmTheme(f.themeScope, piPreference)).ok, true);
  assert.deepEqual(f.store.writes.map(write => write.choice), [{ kind: 'pi' }]);
});

test('theme preview cannot cancel an earlier confirmation or be overwritten by its late save result', async () => {
  const held = deferred<SettingsSaveResult>(), store = new Store(); store.saveResult = held.promise;
  const f = fixture({}, store); await f.c.start();
  const confirming = f.preferences.confirmTheme(f.themeScope, preference(native.id));
  f.c.previewTheme(piPreference);
  assert.equal(store.writes[0]!.signal!.aborted, false);
  held.resolve({ ok: true }); assert.equal((await confirming).ok, true);
  assert.deepEqual(f.c.snapshot().selected, piPreference);
  f.c.previewTheme(preference(native.id));
  assert.equal(f.c.snapshot().effective?.id, native.id); assert.equal(store.writes.length, 1);
});

test('theme preview and rollback remain current after a late preference load', async () => {
  const restored = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = restored.promise;
  const f = fixture({}, store); const starting = f.c.start(); await settle();
  f.c.previewTheme(themeChoice); f.c.previewTheme(piPreference);
  restored.resolve({ ok: true, themePreference: themeChoice }); await starting;
  assert.equal(f.c.snapshot().effective?.id, pi.id);
  f.c.previewTheme(themeChoice); f.c.previewTheme(piPreference);
  assert.equal(f.c.snapshot().effective?.id, pi.id); assert.equal(store.writes.length, 0);
  assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
});

test('theme preview and rollback leave the real settings bytes intact; only confirmation writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theme-preview-')), file = join(directory, 'config.json');
  try {
    const original = '{"syntaxTheme":{"kind":"pi"},"unknown":{"preserved":true}}\n'; await writeFile(file, original);
    const store = new ExtensionSettings({ file }); let writes = 0;
    const f = fixture({ settings: { load: () => store.load(), update: (...args) => { writes++; return store.update(...args); } } });
    await f.c.start();
    f.c.previewTheme(preference(native.id)); f.c.previewTheme(piPreference);
    assert.equal(writes, 0); assert.equal(await readFile(file, 'utf8'), original);
    f.c.previewTheme(preference(native.id));
    assert.equal((await f.preferences.confirmTheme(f.themeScope, preference(native.id))).ok, true);
    assert.equal(writes, 1);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { syntaxTheme: { kind: 'theme', id: 'gruvbox' }, syntaxThemeVariant: 'dark', unknown: { preserved: true } });
    await f.c.dispose(); const selected = f.c.snapshot().selected;
    f.c.previewTheme(piPreference);
    assert.deepEqual(f.c.snapshot().selected, selected); assert.equal(writes, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime health: actual theme-save failure is counted without capture and successful theme save recovers the shared settings operation', async () => {
  const notices: string[] = [], health = new RuntimeHealth(message => notices.push(message));
  const diagnostic = health.sink(() => {}), f = fixture({ diagnostic });
  f.store.saveResult = { ok: false, issue: { code: 'write-failed', message: 'PRIVATE_SAVE_FAILURE' } };
  assert.equal((await f.preferences.confirmTheme(f.themeScope, piPreference)).ok, false); await settle();
  assert.equal(health.snapshot().errors, 1); assert.equal(health.snapshot().active, 1); assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0]!, /PRIVATE_SAVE_FAILURE/);
  f.store.saveResult = { ok: true }; await f.preferences.confirmTheme(f.themeScope, piPreference);
  assert.equal(health.snapshot().active, 0); assert.equal(health.snapshot().last?.state, 'recovered');
  reportRuntime(diagnostic, { kind: 'failure', scope: f.store, operation: 'save', area: 'settings', code: 'settings_save' });
  await f.preferences.confirmTheme(f.themeScope, preference(native.id)); assert.equal(health.snapshot().active, 0);
});

test('runtime health: a retired theme-save failure is not a runtime incident', async () => {
  const health = new RuntimeHealth(() => {}), f = fixture({ diagnostic: health.sink(() => {}) });
  const pending = deferred<SettingsSaveResult>(); f.store.saveResult = pending.promise;
  const saving = f.preferences.confirmTheme(f.themeScope, piPreference); await f.c.dispose();
  pending.resolve({ ok: false, issue: { code: 'write-failed', message: 'cancelled' } }); await saving;
  assert.equal(health.snapshot().errors, 0);
});


test('completion boundary: client observes held preference restoration without initiating startup', { timeout: 12000 }, async () => {
  const load = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = load.promise;
  const f = fixture({}, store);
  try {
    const pending = f.c.whenSettled(); await settle();
    assert.equal(store.loads, 1, 'application wiring, not client inspection, owns the already-started read');
    assert.equal(f.sharedAttempts(), 0);
    const start = f.c.start(), completion = f.c.whenSettled();
    assert.equal(completion, pending, 'startup joins the existing observation rather than replacing it');
    let completed = false; void completion.then(() => { completed = true; });
    await f.c.broker.start(); await settle();
    assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(completed, false);
    load.resolve(store.restored); await start;
    assert.equal(await completion, true); assert.equal(f.c.snapshot().effective?.id, 'pi');
    assert.equal(f.peer.calls.length, 1);
  } finally { load.resolve(store.restored); }
});

for (const action of ['suspend', 'dispose', 'off'] as const) test(`completion boundary: client ${action} cancels held producer work`, { timeout: 12000 }, async () => {
  const f = fixture(); await f.c.start();
  f.c.sourceWork.observe(demand(f.c)); f.c.sourcePump.flush(); await settle();
  const completion = f.c.whenSettled();
  if (action === 'off') await f.c.setEnabled(false); else await f.c[action]();
  assert.equal(await completion, false);
});

async function detachedWaitingClient(peer: Peer) {
  const client = new SyntaxClient({ provider: { tryShared: async () => peer, acquireOwned: async () => new Peer() }, standaloneVersion: '0.2.0', initialTheme: piPreference });
  const execution = client.sourceWork;
  assert.ok(execution instanceof SourceExecution);
  assert.equal(client.sourcePump, execution); assert.equal(client.sourceStatistics, execution); assert.equal(client.sourceLifecycle, execution);
  await client.start(); execution.observe(demand(client)); execution.flush();
  return { weak: new WeakRef(client), execution, broker: client.broker, completion: client.whenSettled() };
}
test('completion boundary: source/provider completion callbacks do not retain their first client', { timeout: 12000 }, async () => {
  assert.equal(typeof global.gc, 'function');
  const peer = new Peer(), first = await detachedWaitingClient(peer), second = fixture(); await second.c.start();
  try {
    assert.equal(first.execution.stats().unsettledJobs, 1);
    for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
    assert.equal(first.weak.deref() === undefined, true);
    peer.answerSource(1); await settle();
    assert.equal(await first.completion, false, 'an abandoned client cannot acknowledge an operation from retained producer callbacks');
    assert.equal(second.c.snapshot().provider.availability, 'ready');
  } finally { first.execution.dispose(); await first.broker.dispose(); }
});


test('completion boundary: cancelled waits reuse observers of unchanged pending startup and restore Promises', { timeout: 12000 }, async t => {
  const load = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = load.promise;
  const f = fixture({}, store), start = f.c.start();
  const restore = Reflect.get(f.c, 'restore') as Promise<void>;
  function subscriptions(promise: Promise<void>) {
    let count = 0; const then = promise.then.bind(promise);
    t.mock.method(promise, 'then', (...args: Parameters<Promise<void>['then']>) => { count++; return then(...args); });
    return () => count;
  }
  const restoreSubscriptions = subscriptions(restore), startupSubscriptions = subscriptions(start);
  try {
    await f.c.broker.start();
    for (let cycle = 0; cycle < 3; cycle++) {
      const completion = f.c.whenSettled(); await settle();
      f.c.suspend(); assert.equal(await completion, false); await f.c.resume();
    }
    const completion = f.c.whenSettled(); let completed = false;
    void completion.then(() => { completed = true; }); await settle();
    assert.equal(completed, false);
    assert.equal(restoreSubscriptions(), 1, 'one observer per unchanged producer, not one per cancelled wait');
    assert.equal(startupSubscriptions(), 1);
    load.resolve(store.restored); assert.equal(await completion, true);
  } finally { load.resolve(store.restored); await start; }
});


test('completion boundary: cancelled source callbacks cannot cancel a successor client observation', { timeout: 12000 }, async t => {
  const load = deferred<SettingsLoadResult>(), store = new Store(); store.loadResult = load.promise;
  const f = fixture({}, store), start = f.c.start();
  let release: (() => void) | undefined, held!: () => void;
  const yielding = new Promise<void>(resolve => { held = resolve; });
  const execution = f.c.sourceWork;
  assert.ok(execution instanceof SourceExecution);
  const resume = execution.resumePreparation;
  t.mock.method(execution, 'resumePreparation', function(this: SourceExecution) {
    if (!release) { release = () => resume.call(this); held(); return; }
    return resume.call(this);
  });
  let visits = 0;
  const tasks = Array.from({ length: 3 }, () => ({ keys: new Set<string>(), requiresCredit() { return false; }, needsRefresh() { return false; }, prepare() { visits++; } }));
  try {
    await f.c.broker.start();
    for (const task of tasks) execution.queuePreparation(execution.registerPreparation(task)!, true);
    await yielding;
    const old = f.c.whenSettled(); f.c.suspend();
    const resumed = f.c.resume(), successor = f.c.whenSettled();
    let completed = false; void successor.then(() => { completed = true; });
    assert.equal(await old, false); await resumed; await settle();
    assert.equal(completed, false, 'old source cancellation must not cancel or resolve the successor');
    assert.ok(release); release();
    load.resolve(store.restored); assert.equal(await successor, true); assert.equal(visits, 3);
  } finally { release?.(); load.resolve(store.restored); await start; }
});


test('theme preferences retain the chosen variant for Pi and save both canonical settings keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syntax-theme-variant-'));
  const file = join(directory, 'config.json');
  try {
    const settings = new ExtensionSettings({ file });
    const f = fixture({ settings });
    const piLight: ThemePreference = { kind: 'pi', variant: 'light' };
    f.c.applySavedTheme(piPreference);
    f.c.previewTheme(piLight);
    assert.deepEqual(f.c.snapshot().selected, piLight, 'variant-only Pi preview updates its remembered choice');
    f.c.applySavedTheme(piLight);
    assert.deepEqual(f.c.snapshot().selected, piLight, 'Pi retains a variant even though its effective palette ignores it');
    assert.equal(f.c.snapshot().effective?.id, 'pi');

    const light: ThemePreference = { kind: 'theme', id: 'github', variant: 'light' };
    assert.equal((await f.preferences.confirmTheme(f.themeScope, light)).ok, true);
    assert.deepEqual(f.c.snapshot().selected, light);
    assert.equal(f.c.snapshot().effective?.id, 'github-light');
    const saved = await readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(saved), {
      syntaxTheme: { kind: 'theme', id: 'github' }, syntaxThemeVariant: 'light',
    });
    const dark: ThemePreference = { ...light, variant: 'dark' };
    f.c.previewTheme(dark);
    assert.deepEqual(f.c.snapshot().selected, dark, 'variant-only owned preview updates its selected pair');
    assert.equal(f.c.snapshot().effective?.id, 'github-dark');
    assert.equal(await readFile(file, 'utf8'), saved, 'preview does not save its variant');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('unknown-family warning is not repeated for variant-only changes', async () => {
  const store = new Store();
  const missing: ThemePreference = { kind: 'theme', id: 'not-installed', variant: 'dark' };
  store.restored = { ok: true, themePreference: missing };
  const f = fixture({}, store); await f.c.start();
  assert.equal(f.errors.length, 1);
  f.c.previewTheme({ ...missing, variant: 'light' });
  assert.equal(f.errors.length, 1, 'previewing a variant does not start another missing-family episode');
  f.c.applySavedTheme(missing);
  assert.equal(f.errors.length, 1, 'an external variant-only update retains the same warning episode');
  await f.preferences.confirmTheme(f.themeScope, { ...missing, variant: 'light' });
  assert.equal(f.errors.length, 1, 'explicit variant confirmation retains the same warning episode');
  f.c.applySavedTheme({ kind: 'theme', id: 'another-missing-family', variant: 'light' });
  assert.equal(f.errors.length, 2, 'a different missing family is a new episode');
  f.c.applySavedTheme(piPreference); f.c.applySavedTheme(missing);
  assert.equal(f.errors.length, 3, 'returning after a known preference starts a new episode');
});


test('completion boundary: supplied running choice data is observed without starting its provider', { timeout: 12000 }, async () => {
  const input = deferred<ThemePreference>(), f = fixture({ initialTheme: input.promise });
  try {
    const completion = f.c.whenSettled(); let completed = false;
    void completion.then(() => { completed = true; }); await settle();
    assert.equal(completed, false, 'an already-running application input is a real pending producer');
    assert.equal(f.store.loads, 0); assert.equal(f.store.writes.length, 0);
    assert.equal(f.sharedAttempts(), 0); assert.equal(f.acquisitions(), 0); assert.equal(f.peer.calls.length, 0);
    input.resolve(themeChoice); assert.equal(await completion, true);
    assert.equal(f.sharedAttempts(), 0, 'completion does not turn input readiness into provider demand');
    await f.c.start(); assert.deepEqual(f.c.snapshot().selected, themeChoice);
    assert.equal(f.c.snapshot().effective?.id, native.id);
  } finally { input.resolve(themeChoice); }
});


test('retired native preference scopes cannot cancel or publish through a successor confirmation', async () => {
  const store = new Store(), preferences = new ApplicationPreferences(store, { appearanceEnabled: true, loggingEnabled: true });
  const oldScope = preferences.openThemeScope();
  const first = new SyntaxClient({ standaloneVersion: 'scope-first', initialTheme: piPreference,
    onActivationChanged: oldScope.onActivationChanged, onDisposed: oldScope.onDisposed,
    provider: { tryShared: async () => undefined, acquireOwned: async () => new Peer() } });
  oldScope.bind(first); clients.add(first);
  const held = deferred<SettingsSaveResult>(); store.saveResult = held.promise;
  const oldSave = preferences.confirmTheme(oldScope, themeChoice), scope = preferences.openThemeScope();
  const second = new SyntaxClient({ standaloneVersion: 'scope-second', initialTheme: piPreference,
    onActivationChanged: scope.onActivationChanged, onDisposed: scope.onDisposed,
    provider: { tryShared: async () => undefined, acquireOwned: async () => new Peer() } });
  scope.bind(second); clients.add(second);
  const currentSave = preferences.confirmTheme(scope, piPreference);
  try {
    assert.equal(store.writes.length, 2); assert.equal(store.writes[0]!.signal!.aborted, true);
    await first.setEnabled(false); await first.dispose();
    assert.equal(store.writes[1]!.signal!.aborted, false, 'old native callbacks cannot retire a successor request');
    assert.equal((await preferences.confirmTheme(oldScope, themeChoice)).ok, false);
    assert.equal(store.writes.length, 2, 'an obsolete scope cannot admit a new write');
    held.resolve({ ok: true });
    assert.equal((await oldSave).ok, false); assert.equal((await currentSave).ok, true);
    assert.deepEqual(second.snapshot().selected, piPreference); assert.deepEqual(preferences.selectedTheme, piPreference);
  } finally { held.resolve({ ok: true }); await Promise.all([oldSave, currentSave]); }
});
