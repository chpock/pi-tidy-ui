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
import { PROVIDER_LIMITS, type ProviderClock, type ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { ExpectedOwnedUnavailable } from '../../../src/occipital/owned-startup.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { createSemanticRuleDefinition } from '../../../src/syntax/semantic-rules.ts';
import { ownedStyleSelection } from '../../fixtures/owned-style-selection.ts';
import { compactSelection } from '../../fixtures/test-style-selection.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { PaletteInputOwner } from '../../../src/syntax/pi-input-owner.ts';
import { bashToolReaderFixture, fileToolReaderFixture } from '../../fixtures/tool-adapters/reader-fixture.ts';
import { highlightCode } from '@earendil-works/pi-coding-agent';
import { getThemeByName, initTheme, setThemeInstance } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

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
  fault(index: number, code: string, execution: 'not_started' | 'started' = 'not_started') {
    this.calls[index]!.resolve({ v: 4, ticket: this.calls[index]!.request.ticket, instance: 'instance', assets: 'assets', status: 'error', error: { code, execution } });
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

test('unclassified SOURCE rejection keeps truthful uncertainty without inventing timed retry or harming its peer', async () => {
  const clock = new Clock(), peer = new Peer(); let sharedAttempts = 0, ownedStarts = 0;
  const f = fixture({ provider: { clock, tryShared: async () => { sharedAttempts++; return peer; },
    acquireOwned: async () => { ownedStarts++; return new Peer(); } } }, new Store(), peer);
  await f.c.start();
  const input = { ...demand(f.c, 'unclassified'), text: 'unclassified input' };
  const healthy = { ...demand(f.c, 'healthy'), text: 'healthy input' };
  f.c.sourceWork.observe(input); f.c.sourceWork.observe(healthy); f.c.sourcePump.flush();
  const data = () => peer.calls.filter(call => call.request.op === 'highlight');
  const failed = peer.calls.findIndex(call => call.request.op === 'highlight' && call.request.sources[0].text === input.text);
  const sibling = peer.calls.findIndex(call => call.request.op === 'highlight' && call.request.sources[0].text === healthy.text);
  assert.ok(failed >= 0 && sibling >= 0); assert.equal(data().length, 2);
  peer.calls[failed]!.reject(new Error('busy deadline retry'));
  peer.answerSource(sibling); assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.workStatus(input.key).execution, 'unknown');
  assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false);
  assert.equal(f.c.sourceWork.status(healthy.key)!.exact, true);
  assert.equal(f.c.sourceStatistics.stats().globalTransientBytes, 0); assert.equal(peer.closes, 0);
  for (let version = 2; version <= 4; version++) { f.c.sourceWork.observe({ ...input, version }); f.c.sourcePump.flush(); }
  await clock.advance(59999); assert.equal(data().length, 2);
  await clock.advance(1); assert.equal(data().length, 2, 'unclassified rejection cannot mint a minute-based retry');
  await clock.advance(120000); f.c.sourcePump.flush(); assert.equal(data().length, 2);
  assert.equal(clock.timers.size, 0); assert.equal(sharedAttempts, 1); assert.equal(ownedStarts, 0); assert.equal(peer.closes, 0);
  assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false);
  assert.equal(f.c.sourceWork.status(healthy.key)!.exact, true);
  const changed = { ...input, version: 5, text: 'genuinely changed input' };
  assert.equal(f.c.sourceWork.observe(changed), true); f.c.sourcePump.flush(); assert.equal(data().length, 3);
  assert.equal(f.c.sourceWork.workStatus(input.key).execution, 'unsettled');
  assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false);
  peer.answerSource(peer.calls.indexOf(data().at(-1)!)); assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
  assert.equal(f.c.sourceWork.workStatus(input.key).execution, 'unknown', 'later native success does not erase ordinary shared history');
  assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false);
  assert.equal(f.c.sourceStatistics.stats().globalTransientBytes, 0);
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
  await f.c.start(); first.end('lost'); await settle();
  assert.equal(f.c.snapshot().provider.availability, 'unavailable');
  assert.equal(await f.c.broker.whenSettled(), true);
  await f.c.broker.recover(); assert.equal(f.c.broker.snapshot().kind, 'owned');
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.snapshot().provider.kind, 'owned');
  const episodes = f.c.broker.stats().recoveryEpisodes;
  await clock.advance(60000);
  const probes = f.c.broker.stats().probesStarted;
  assert.equal(probes, 1, 'the existing return-window tick occurs during the service-spacing interval');
  await f.c.setEnabled(false); await f.c.setEnabled(true); assert.equal(f.c.snapshot().provider.initialShared, true);
  assert.equal(f.c.snapshot().provider.availability, 'ready');
  assert.equal(f.c.broker.stats().recoveryTimers, 0); assert.equal(f.c.broker.stats().recoveryEpisodes, episodes);
  await clock.advance(600000); assert.equal(f.c.broker.stats().probesStarted, probes, 'Off/On creates no new return-window probe');
  assert.equal(f.store.writes.length, 0);
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

test('local palette and UI changes neither create recovery demand nor reset service pacing; explicit off/on waits for its deadline', async () => {
  const clock = new Clock(), peers: Peer[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => { const peer = new Peer(); peers.push(peer); return peer; } } });
  await f.c.start(); assert.equal(peers.length, 1);
  peers[0]!.end('lost'); await settle();
  for (let frame = 0; frame < 3; frame++) {
    await f.preferences.confirmTheme(f.themeScope, piPreference); f.c.snapshot(); f.c.captureMenu()();
    await clock.advance(60000);
    assert.equal(peers.length, 1, 'local presentation and inspection do not create native interest');
  }
  const input = demand(f.c, 'ui-recovery');
  assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
  assert.equal(peers.length, 2); assert.equal(f.c.broker.stats().ownedRestarts, 1);
  const source = peers[1]!.calls.findIndex(call => call.request.op === 'highlight'); assert.ok(source >= 0);
  peers[1]!.fault(source, 'busy', 'not_started'); assert.equal(await f.c.whenSettled(), true);
  for (let frame = 0; frame < 3; frame++) {
    await f.preferences.confirmTheme(f.themeScope, piPreference); f.c.snapshot(); f.c.captureMenu()();
  }
  assert.equal(peers.length, 2); assert.equal(f.c.broker.stats().successfulClassifications, 0);
  await f.c.setEnabled(false); await f.c.setEnabled(true);
  assert.equal(f.c.snapshot().provider.reason, 'activation_deferred'); assert.equal(peers.length, 2);
  assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
  await clock.advance(59999); assert.equal(peers.length, 2);
  await clock.advance(1); await settle(); assert.equal(peers.length, 3);
  assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(f.c.snapshot().provider.initialShared, false);
  assert.equal(f.c.broker.stats().ownedRestarts, 1, 'due explicit activation is not another automatic failure cycle');
  const resumed = peers[2]!.calls.findIndex(call => call.request.op === 'highlight'); assert.ok(resumed >= 0);
  peers[2]!.answerSource(resumed); assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.broker.stats().successfulClassifications, 1);
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

for (const disruption of ['uncertain connection end', 'failed initial acquisition'] as const) {
  test(`general native recovery: ${disruption} resumes useful current SOURCE without terminal callbacks`, async () => {
    const clock = new Clock(), first = new Peer(), next = new Peer();
    let attempts = 0, available = disruption === 'uncertain connection end';
    const f = fixture({ provider: {
      clock,
      tryShared: async () => {
        attempts++;
        return available ? (attempts === 1 ? first : next) : undefined;
      },
      acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); },
    } });
    const input = { key: 'recover-current', version: 1, text: 'const current = 1;', language: 'typescript', complete: true };
    await f.c.start();
    if (disruption === 'failed initial acquisition') {
      assert.equal(f.c.snapshot().provider.availability, 'unavailable');
      assert.equal(first.calls.length, 0);
      available = true;
    }
    assert.equal(f.c.sourceWork.observe(input), true);
    f.c.sourcePump.flush();
    if (disruption === 'uncertain connection end') {
      assert.equal(first.calls.filter(call => call.request.op === 'highlight').length, 1);
      first.end('uncertain');
      await settle();
      assert.equal(first.closes, 1);
      assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false);
    }
    await settle();
    if (!next.calls.some(call => call.request.op === 'highlight')) {
      assert.equal(clock.timers.size > 0, true, 'useful native work must have an automatic recovery opportunity');
      const at = Math.min(...[...clock.timers.values()].map(timer => timer.at));
      assert.equal(Number.isFinite(at), true);
      await clock.advance(Math.max(0, at - clock.now()));
      await settle();
    }
    const index = next.calls.findIndex(call => call.request.op === 'highlight');
    assert.equal(index >= 0, true, 'automatic recovery must dispatch the retained current SOURCE without terminal callbacks, reobservation or Off/On');
    assert.equal(next.calls[index]!.request.sources[0].text, input.text);
    assert.equal(next.calls.filter(call => call.request.op === 'highlight').length, 1);
    next.answerSource(index);
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
    if (disruption === 'uncertain connection end') {
      assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, false, 'new native success does not erase prior shared uncertainty or expand Pi permission');
    }
  });
}


test('general native recovery: parser resynchronization remains available after useful success and respects the minute bound', async () => {
  const clock = new Clock(), peer = new Peer();
  let acquisitions = 0;
  const f = fixture({ provider: { clock, tryShared: async () => peer,
    acquireOwned: async () => { acquisitions++; throw new Error('fixture must keep its healthy shared route'); } } });
  const input = (text: string, version: number) => ({ key: 'repeat-resync', text, version, language: 'bash', complete: false });
  function answerOpen(index: number, text: string) {
    const call = peer.calls[index]!, r = call.request;
    assert.equal(r.op, 'stream.open');
    assert.equal(r.sources[0].text, text);
    const s = r.sources[0], bytes = Buffer.byteLength(text);
    call.resolve({ v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
      kind: 'source', vocabulary: descriptor(r.ticket).body.vocabulary.fingerprint, sources: [{
        key: s.key, generation: s.generation, source_version: s.source_version,
        revision: 1, replace_from: 0, source_bytes: bytes,
        committed_bytes: Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete: false,
        lease: `resync-lease-${index}`, contexts: [[0, 1]], runs: [bytes, 1],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes },
      }] } });
  }
  function answerClose(index: number) {
    const call = peer.calls[index]!;
    assert.equal(call.request.op, 'stream.close');
    call.resolve({ v: 4, ticket: call.request.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  }
  const opens = () => peer.calls.filter(call => call.request.op === 'stream.open');
  await f.c.start();
  const generation = f.c.snapshot().provider.generation;
  assert.equal(f.c.sourceWork.observe(input('a\nt', 1)), true); f.c.sourcePump.flush();
  answerOpen(1, 'a\nt'); await settle();
  assert.equal(f.c.sourceWork.status('repeat-resync')!.exact, true);

  assert.equal(f.c.sourceWork.observe(input('a\ntx', 2)), true); f.c.sourcePump.flush();
  assert.equal(peer.calls[2]!.request.op, 'stream.append'); peer.fault(2, 'restart_required'); await settle();
  answerClose(3); await settle();
  assert.equal(opens().length, 2, 'the first parser recovery does not wait for a minute');
  assert.notEqual(peer.calls[4]!.request.sources[0].key, peer.calls[1]!.request.sources[0].key);
  answerOpen(4, 'a\ntx'); await settle();
  assert.equal(f.c.sourceWork.status('repeat-resync')!.acknowledgedVersion, 2);
  assert.equal(f.c.sourceWork.status('repeat-resync')!.exact, true, 'the first recovery must actually succeed before testing another loss');

  await clock.advance(1000);
  assert.equal(f.c.sourceWork.observe(input('a\ntxy', 3)), true); f.c.sourcePump.flush();
  assert.equal(peer.calls[5]!.request.op, 'stream.append'); peer.fault(5, 'restart_required'); await settle();
  answerClose(6); await settle();
  assert.equal(opens().length, 2, 'useful success does not reset the per-card recovery interval');
  await clock.advance(58999);
  assert.equal(opens().length, 2, 'the second recovery cannot start before sixty seconds from the first');
  await clock.advance(1);
  assert.equal(opens().length, 3, 'a second independent loss must not exhaust automatic parser recovery permanently');
  answerOpen(7, 'a\ntxy');
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('repeat-resync')!.acknowledgedVersion, 3);
  assert.equal(f.c.sourceWork.status('repeat-resync')!.exact, true);
  assert.equal(f.c.snapshot().provider.generation, generation);
  assert.equal(peer.closes, 0, 'parser repair must not retire a functioning route');
  assert.equal(acquisitions, 0);
  const requests = peer.calls.length;
  for (let i = 0; i < 3; i++) { f.c.sourcePump.flush(); await settle(); }
  assert.equal(peer.calls.length, requests, 'successful unchanged work does not keep retrying');
});


for (const [failure, code, execution] of [
  ['invalid SOURCE body', undefined, undefined],
  ['busy', 'busy', 'not_started'],
  ['queue_expired', 'queue_expired', 'not_started'],
  ['data_limit (not_started)', 'data_limit', 'not_started'],
  ['data_limit (started)', 'data_limit', 'started'],
  ['state_limit (not_started)', 'state_limit', 'not_started'],
  ['state_limit (started)', 'state_limit', 'started'],
  ['session_limit', 'session_limit', 'not_started'],
  ['busy (started)', 'busy', 'started'],
] as const) {
  test(`general native recovery: ${failure} retries only the useful affected SOURCE once per minute on its functioning route`, async () => {
    const clock = new Clock(), peer = new Peer();
    let acquisitions = 0;
    const f = fixture({ provider: { clock,
      tryShared: async () => { acquisitions++; return peer; },
      acquireOwned: async () => { throw new Error('fixture must keep its functioning shared route'); },
    } });
    await f.c.start();
    const generation = f.c.snapshot().provider.generation;
    const affected = { key: 'paced-source', version: 1, text: 'const affected = 1;', language: 'typescript', complete: true };
    const sibling = { ...affected, key: 'healthy-sibling', text: 'const sibling = 2;' };
    assert.equal(f.c.sourceWork.observe(affected), true);
    assert.equal(f.c.sourceWork.observe(sibling), true);
    f.c.sourcePump.flush();
    const attempts = (text: string) => peer.calls.filter(call => call.request.op === 'highlight' && call.request.sources[0].text === text);
    assert.equal(attempts(affected.text).length, 1);
    assert.equal(attempts(sibling.text).length, 1);
    const affectedIndex = peer.calls.indexOf(attempts(affected.text)[0]!);
    const siblingIndex = peer.calls.indexOf(attempts(sibling.text)[0]!);
    const answerFailure = (index: number) => {
      if (failure === 'invalid SOURCE body') {
        const reply = peer.sourceReply(index);
        reply.body.sources[0]!.runs = [0, 1];
        peer.calls[index]!.resolve(reply);
      } else peer.fault(index, code!, execution);
    };
    await clock.advance(5000);
    answerFailure(affectedIndex); peer.answerSource(siblingIndex);
    assert.equal(await f.c.whenSettled(), true, 'future retry opportunities are not current work');
    assert.equal(f.c.sourceWork.status(sibling.key)!.exact, true);
    assert.equal(f.c.sourceStatistics.stats().globalUnsettledJobs, 0);
    const unproven = failure === 'invalid SOURCE body' || execution === 'started';
    assert.equal(f.c.sourceWork.workStatus(affected.key).fallbackEligible, !unproven);
    if (execution) assert.equal(f.c.sourceWork.workStatus(affected.key).execution, execution);
    assert.equal(peer.closes, 0);
    assert.equal(acquisitions, 1);
    for (let index = 0; index < 3; index++) {
      f.c.sourceWork.status(affected.key); f.c.sourceWork.workStatus(affected.key); f.c.sourcePump.flush();
      await settle();
    }
    await clock.advance(59999);
    assert.equal(attempts(affected.text).length, 1, 'warm visits and elapsed time below the bound cannot resend');
    await clock.advance(1);
    assert.equal(attempts(affected.text).length, 2, 'useful recovery must run automatically when its minute is due');
    assert.equal(attempts(sibling.text).length, 1, 'a successful sibling must not be resent');
    assert.equal(f.c.snapshot().provider.generation, generation);
    assert.equal(peer.closes, 0);
    assert.equal(acquisitions, 1);
    for (let attempt = 2; attempt <= 3; attempt++) {
      answerFailure(peer.calls.indexOf(attempts(affected.text)[attempt - 1]!));
      assert.equal(await f.c.whenSettled(), true);
      assert.equal(f.c.sourceStatistics.stats().globalUnsettledJobs, 0);
      await clock.advance(59999);
      assert.equal(attempts(affected.text).length, attempt, 'each new failure establishes its own full remaining interval');
      await clock.advance(1);
      assert.equal(attempts(affected.text).length, attempt + 1, 'repeated failures cannot exhaust a small lifetime retry allowance');
    }
    assert.equal(peer.closes, 0); assert.equal(acquisitions, 1);
    peer.answerSource(peer.calls.indexOf(attempts(affected.text)[3]!));
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(affected.key)!.exact, true);
    if (unproven) assert.equal(f.c.sourceWork.workStatus(affected.key).fallbackEligible, false,
      'later native success cannot erase earlier shared execution history');
    await clock.advance(60000);
    f.c.sourcePump.flush(); await settle();
    assert.equal(attempts(affected.text).length, 4, 'successful unchanged work must stop retrying');
    assert.equal(attempts(sibling.text).length, 1);
  });
}


test('general native recovery: loss without useful work closes the route and waits for actual demand before acquisition', async () => {
  const clock = new Clock(), first = new Peer(), next = new Peer();
  let acquisitions = 0;
  const f = fixture({ provider: { clock,
    tryShared: async () => ++acquisitions === 1 ? first : next,
    acquireOwned: async () => { throw new Error('fixture expects the shared route to return'); },
  } });
  await f.c.start();
  assert.equal(acquisitions, 1);
  first.end('lost'); await settle();
  assert.equal(first.closes, 1, 'absence of card interest must not postpone connection cleanup');
  assert.equal(acquisitions, 1, 'an enabled but idle client has no useful card work to recover');
  await clock.advance(120000);
  assert.equal(acquisitions, 1, 'elapsed time without useful demand cannot start failure recovery');
  const input = { key: 'first-useful-after-loss', version: 1, text: 'const useful = 1;', complete: true };
  assert.equal(f.c.sourceWork.observe(input), true);
  f.c.sourcePump.flush(); await settle();
  assert.equal(acquisitions, 2, 'the first useful recovery is immediate even after an idle interval');
  const index = next.calls.findIndex(call => call.request.op === 'highlight');
  assert.equal(index >= 0, true);
  assert.equal(next.calls[index]!.request.sources[0].text, input.text);
  next.answerSource(index);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
});


for (const observation of ['equal alias', 'changed input'] as const) {
  test(`general native recovery: evicted ${observation} preserves the remaining failure cooldown without delaying admitted text`, async () => {
    const clock = new Clock(), peer = new Peer();
    const f = fixture({ provider: { clock, tryShared: async () => peer,
      acquireOwned: async () => { throw new Error('fixture must keep its functioning shared route'); } },
      source: { retention: { maxBytes: 64 * 1024 } },
    });
    await f.c.start();
    const execution = f.c.cardSource;
    assert.ok(execution instanceof SourceExecution);
    const input = { key: 'evicted-retry', version: 1, text: 'const current = 1;', complete: true };
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush();
    peer.fault(1, 'busy');
    assert.equal(await f.c.whenSettled(), true);
    await clock.advance(1000);
    const funding = execution.geometryFunding()!;
    const pressure = funding.grant(funding.budget.limit);
    assert.equal(pressure !== undefined, true, 'bounded public funding must actually evict the unpinned input');
    assert.equal(f.c.sourceWork.borrowSource(input.key), undefined);
    pressure!.close();
    assert.equal(execution.retryEvicted(input.key), true);
    const latest = { ...input, version: 2, text: observation === 'equal alias' ? input.text : 'const changed = 2;' };
    assert.equal(f.c.sourceWork.observe(latest), true);
    assert.equal(f.c.sourceWork.borrowSource(input.key)!.text, latest.text, 'latest input is admitted before the native-color opportunity');
    f.c.sourcePump.flush(); await settle();
    const sources = () => peer.calls.filter(call => call.request.op === 'highlight');
    assert.equal(sources().length, 1, 'eviction or readmission cannot erase the unexpired failure cooldown');
    await clock.advance(58999);
    assert.equal(sources().length, 1);
    await clock.advance(1);
    assert.equal(sources().length, 2, 'readmission must preserve the original deadline, not start another whole minute');
    const retry = sources()[1]!;
    assert.equal(retry.request.sources[0].text, latest.text);
    assert.equal(retry.request.sources[0].source_version, latest.version);
    peer.answerSource(peer.calls.indexOf(retry));
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
    assert.equal(peer.closes, 0);
  });
}

for (const missing of [false, true]) {
  test(`general native recovery: unavailable STYLE-only ${missing ? 'miss reconnects' : 'cache hit publishes locally'} without reparsing SOURCE`, async () => {
    const clock = new Clock(), first = new Peer(), next = new Peer();
    let acquisitions = 0;
    const f = fixture({ onChange: undefined, provider: {
      clock,
      tryShared: async () => { acquisitions++; return acquisitions === 1 ? first : next; },
      acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); },
    } });
    const input = { key: 'retained-style-only', version: 1, text: 'const retained = 1;', complete: true };
    const initial = compactSelection(1, 'retained-style', 'A');
    await f.c.start();
    assert.equal(f.c.cardSource.setStyleSelection(initial), true);
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush();
    const source = first.calls.findIndex(call => call.request.op === 'highlight');
    assert.equal(source >= 0, true); first.answerSource(source); await settle();
    const style = first.calls.findIndex(call => call.request.op === 'styles.resolve');
    assert.equal(style >= 0, true); first.answerStyle(style);
    assert.equal(await f.c.whenSettled(), true);
    const generation = f.c.sourceWork.borrowSource(input.key)!.generation;
    assert.equal(f.c.sourceWork.displayBasis(input.key)!.palette, initial.palette);
    first.end('uncertain'); await settle(); await settle();
    assert.equal(first.closes, 1, 'idle connection cleanup does not depend on presentation callbacks');
    assert.equal(acquisitions, 1, 'satisfied retained source and styles do not sustain failure acquisition');
    const selection = compactSelection(2, 'retained-style', missing ? 'B' : 'A');
    assert.equal(f.c.cardSource.setStyleSelection(selection), true);
    f.c.sourcePump.flush(); await settle();
    if (missing) {
      if (!next.calls.some(call => call.request.op === 'styles.resolve')) {
        assert.equal(clock.timers.size > 0, true, 'actual missing styles over retained scopes need an automatic useful recovery opportunity');
        const at = Math.min(...[...clock.timers.values()].map(timer => timer.at));
        await clock.advance(Math.max(0, at - clock.now())); await settle();
      }
      const resolve = next.calls.findIndex(call => call.request.op === 'styles.resolve');
      assert.equal(resolve >= 0, true, 'STYLE-only demand reconnects without another observation, terminal callback or presenter');
      next.answerStyle(resolve);
    } else {
      assert.equal(f.c.sourceWork.displayBasis(input.key)!.palette, selection.palette, 'cached expressions publish the changed local bindings while disconnected');
      await clock.advance(180000);
      assert.equal(acquisitions, 1, 'lack of a ready provider alone cannot manufacture missing work');
      assert.equal(next.calls.length, 0);
    }
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.borrowSource(input.key)!.generation, generation);
    assert.equal(f.c.sourceWork.displayBasis(input.key)!.palette, selection.palette);
    assert.equal(first.calls.filter(call => call.request.op === 'highlight').length, 1);
    assert.equal(next.calls.filter(call => call.request.op === 'highlight').length, 0, 'reconnection reuses complete parsed scopes');
    assert.equal(next.calls.filter(call => call.request.op === 'styles.resolve').length, missing ? 1 : 0);
    const calls = first.calls.length + next.calls.length, stats = f.c.sourceStatistics.stats();
    for (let frame = 0; frame < 8; frame++) {
      f.c.sourcePump.flush(); f.c.sourceWork.status(input.key); f.c.sourceWork.workStatus(input.key);
      assert.equal(await f.c.whenSettled(), true);
    }
    const warm = f.c.sourceStatistics.stats();
    assert.equal(first.calls.length + next.calls.length, calls);
    assert.equal(warm.styleContextVisits, stats.styleContextVisits, 'warm reads/visits do not repeat the missing-style derivation');
    assert.equal(warm.preparedBytes, stats.preparedBytes);
    assert.equal(warm.decodedBytes, stats.decodedBytes);
  });
}

for (const [failure, code, execution] of [
  ['invalid STYLE body', undefined, undefined],
  ['busy', 'busy', 'not_started'],
  ['queue_expired', 'queue_expired', 'not_started'],
  ['data_limit (started)', 'data_limit', 'started'],
  ['data_limit (not_started)', 'data_limit', 'not_started'],
] as const) {
  const retryable = failure !== 'data_limit (not_started)';
  test(retryable ? `general native recovery: coalesced ${failure} keeps the actual failure deadline across a late owner visit and local rebinding`
    : 'general native recovery: coalesced preflight data_limit waits for changed rules without a timed retry', async () => {
    const clock = new Clock(), peer = new Peer(); let acquisitions = 0;
    const f = fixture({ provider: {
      clock,
      tryShared: async () => { acquisitions++; return peer; },
      acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); },
    } });
    await f.c.start();
    const selection = compactSelection(1, 'coalesced-retry', 'same-rules');
    assert.equal(f.c.cardSource.setStyleSelection(selection), true);
    const inputs = ['older', 'newer'].map(key => ({ key, version: 1, text: `const ${key} = 1;`, complete: true }));
    const preparations = inputs.map(input => ({ keys: new Set([input.key]), prepare() { f.c.sourceWork.observe(input); } }));
    const groups = preparations.map(preparation => {
      const group = f.c.cardSource.registerPreparation(preparation);
      assert.equal(group !== undefined, true); f.c.cardSource.queuePreparation(group!); return group!;
    });
    f.c.sourcePump.flush(); await settle();
    const sources = peer.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.request.op === 'highlight');
    assert.equal(sources.length, 2);
    for (const { index } of sources) peer.answerSource(index);
    await settle();
    const styles = () => peer.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.request.op === 'styles.resolve');
    assert.equal(styles().length, 1, 'overlapping missing contexts use one actual held STYLE request');
    const generations = inputs.map(input => f.c.sourceWork.borrowSource(input.key)!.generation);
    f.c.cardSource.pausePreparation(groups[0]!);
    const answerFailure = (index: number) => {
      const call = peer.calls[index]!;
      if (failure === 'invalid STYLE body') call.resolve({ v: 4, ticket: call.request.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: { kind: 'invalid' } });
      else peer.fault(index, code!, execution);
    };
    await clock.advance(5000);
    answerFailure(styles()[0]!.index); await settle();
    assert.equal(await f.c.whenSettled(), true, 'a future retry opportunity is not held physical work');
    for (const input of inputs) {
      assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
      assert.equal(f.c.sourceWork.workStatus(input.key).execution, 'acknowledged', 'STYLE failure does not corrupt SOURCE acknowledgement');
    }
    await clock.advance(30000);
    const rebound = compactSelection(2, 'coalesced-retry', 'same-rules');
    assert.equal(f.c.cardSource.setStyleSelection(rebound), true);
    f.c.cardSource.queuePreparation(groups[0]!, true); f.c.sourcePump.flush(); await settle();
    assert.equal(styles().length, 1, 'late coalescer observation and local bindings cannot bypass the shared generic deadline');
    await clock.advance(29999); f.c.sourcePump.flush(); await settle();
    assert.equal(styles().length, 1);
    assert.equal(peer.closes, 0); assert.equal(acquisitions, 1);
    if (!retryable) {
      await clock.advance(180001); f.c.sourcePump.flush(); await settle();
      assert.equal(styles().length, 1, 'a fixed preflight refusal does not become a periodic resource-pressure retry');
      assert.equal(peer.closes, 0); assert.equal(acquisitions, 1);
      assert.equal(f.c.cardSource.setStyleSelection(compactSelection(3, 'coalesced-retry', 'changed-rules')), true);
      f.c.sourcePump.flush(); await settle();
      assert.equal(styles().length, 2, 'a genuinely different generic input can be resolved after the preflight refusal');
      peer.answerStyle(styles()[1]!.index);
      assert.equal(await f.c.whenSettled(), true);
      assert.equal(peer.calls.filter(call => call.request.op === 'highlight').length, 2);
      assert.equal(preparations.every(preparation => preparation.keys.size === 1), true);
      return;
    }
    await clock.advance(1); await settle();
    assert.equal(styles().length, 2, 'all owners share sixty seconds from the actual failure, not from their later visit');
    assert.equal(peer.calls.filter(call => call.request.op === 'highlight').length, 2, 'STYLE retry never reparses either source');
    assert.equal(peer.closes, 0); assert.equal(acquisitions, 1);
    for (let attempt = 2; attempt <= 3; attempt++) {
      answerFailure(styles()[attempt - 1]!.index);
      assert.equal(await f.c.whenSettled(), true);
      await clock.advance(59999);
      assert.equal(styles().length, attempt, 'a repeated shared failure cannot resend early');
      await clock.advance(1);
      assert.equal(styles().length, attempt + 1, 'useful shared STYLE retries remain available after repeated failure');
    }
    assert.equal(peer.closes, 0); assert.equal(acquisitions, 1);
    peer.answerStyle(styles()[3]!.index);
    assert.equal(await f.c.whenSettled(), true);
    for (let index = 0; index < inputs.length; index++) {
      assert.equal(f.c.cardSource.groupPresentation(groups[index]!)!.palette, rebound.palette, 'both owners publish the recovered latest binding without another cooldown');
      assert.equal(f.c.sourceWork.borrowSource(inputs[index]!.key)!.generation, generations[index]);
    }
    const calls = peer.calls.length;
    await clock.advance(180000);
    for (let frame = 0; frame < 8; frame++) { f.c.sourcePump.flush(); assert.equal(await f.c.whenSettled(), true); }
    assert.equal(peer.calls.length, calls, 'successful shared resolution ends the repeating opportunity');
    assert.equal(preparations.every(preparation => preparation.keys.size === 1), true, 'weak preparations stay strongly owned through recovered publication');
  });
}

for (const stranded of [false, true]) {
  test(`general native recovery: ${stranded ? 'unaddressable' : 'known live'} stream capacity ${stranded ? 'recovers after peers settle' : 'waits for its ordinary close without retiring the route'}`, async () => {
    class OneLeasePeer extends Peer {
      override answerMetadata(index: number) {
        const reply = descriptor(this.calls[index]!.request.ticket);
        reply.body.limits.leases_per_route = 1;
        this.calls[index]!.resolve(reply);
      }
    }
    const clock = new Clock(), first = new OneLeasePeer(), next = new OneLeasePeer(); let acquisitions = 0;
    const f = fixture({ onChange: undefined, provider: {
      clock,
      tryShared: async () => { acquisitions++; return acquisitions === 1 ? first : next; },
      acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); },
    } });
    function answerOpen(peer: Peer, index: number) {
      const call = peer.calls[index]!, r = call.request, s = r.sources[0], bytes = Buffer.byteLength(s.text);
      assert.equal(r.op, 'stream.open');
      call.resolve({ v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
        kind: 'source', vocabulary: descriptor(r.ticket).body.vocabulary.fingerprint, sources: [{
          key: s.key, generation: s.generation, source_version: s.source_version,
          revision: 1, replace_from: 0, source_bytes: bytes, committed_bytes: 0, complete: false,
          lease: `capacity-lease-${index}`, contexts: [[0, 1]], runs: [bytes, 1],
          counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes },
        }] } });
    }
    await f.c.start();
    assert.equal(f.c.snapshot().provider.description!.limits.leases_per_route, 1, 'protocol-legal lower-cap fixture, not a native-default claim');
    const initial = { key: 'first-stream', version: 1, text: 'echo first', language: 'bash', complete: false };
    const finite = { key: 'finite-peer', version: 1, text: 'const finite = 1;', complete: true };
    const waiting = { key: 'waiting-stream', version: 1, text: 'echo waiting', language: 'bash', complete: false };
    assert.equal(f.c.sourceWork.observe(initial), true); f.c.sourcePump.flush();
    const open = first.calls.findIndex(call => call.request.op === 'stream.open'); assert.equal(open >= 0, true);
    assert.equal(f.c.sourceWork.observe(finite), true); f.c.sourcePump.flush();
    const held = first.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(held >= 0, true);
    if (stranded) first.calls[open]!.resolve({ v: 4, ticket: first.calls[open]!.request.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: { kind: 'invalid' } });
    else answerOpen(first, open);
    await settle();
    assert.equal(f.c.sourceStatistics.stats().remoteLeases, 1);
    assert.equal(f.c.sourceStatistics.stats().unsettledJobs, 1, 'finite peer is still physically held');
    if (!stranded) { assert.equal(f.c.sourceWork.observe(waiting), true); f.c.sourcePump.flush(); }
    await clock.advance(60000);
    assert.equal(first.closes, 0, 'no cleanup escalation may abort an in-flight finite SOURCE peer');
    assert.equal(acquisitions, 1); assert.equal(first.calls[held]!.options?.signal?.aborted, false);
    first.answerSource(held); await settle(); await settle();
    assert.equal(f.c.sourceWork.status(finite.key)!.exact, true, 'the unrelated finite reply must remain usable');
    if (!stranded) {
      await clock.advance(180000); f.c.sourcePump.flush(); await settle();
      assert.equal(first.closes, 0, 'known stream holders are normal finite-capacity contention, not all-unaddressable debt');
      assert.equal(acquisitions, 1);
      f.c.cardSource.remove(initial.key); f.c.sourcePump.flush(); await settle();
      const close = first.calls.findIndex(call => call.request.op === 'stream.close'); assert.equal(close >= 0, true);
      assert.equal(first.closes, 0, 'an addressable queued close must be allowed to settle normally');
      first.calls[close]!.resolve({ v: 4, ticket: first.calls[close]!.request.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
      await settle();
      const admitted = first.calls.findIndex((call, index) => index > open && call.request.op === 'stream.open');
      assert.equal(admitted >= 0, true); answerOpen(first, admitted);
    } else {
      if (!next.calls.some(call => call.request.op === 'stream.open') && clock.timers.size > 0) {
        const at = Math.min(...[...clock.timers.values()].map(timer => timer.at));
        await clock.advance(Math.max(0, at - clock.now())); await settle();
      }
      const admitted = next.calls.findIndex(call => call.request.op === 'stream.open');
      assert.equal(admitted >= 0, true, 'fully unaddressable exhausted quota must get ordinary useful recovery, not a credit wait with no producer');
      assert.equal(first.closes, 1); assert.equal(acquisitions, 2);
      for (let index = 0; index < next.calls.length; index++) if (next.calls[index]!.request.op === 'stream.open') answerOpen(next, index);
      assert.equal(f.c.sourceWork.workStatus(initial.key).fallbackEligible, false, 'namespace retirement does not erase earlier shared uncertainty');
      assert.equal(next.calls.filter(call => call.request.op === 'highlight').length, 0, 'complete peer scopes need no reparse after cleanup');
    }
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(stranded ? initial.key : waiting.key)!.exact, true);
    assert.equal(f.c.sourceWork.status(finite.key)!.exact, true);
    if (stranded) assert.equal(f.c.sourceWork.workStatus(initial.key).fallbackEligible, false);
    else { assert.equal(first.closes, 0); assert.equal(acquisitions, 1); }
  });
}

test('general native recovery: reentrant terminal stop rejects local STYLE publication until useful return', async () => {
  const first = new Peer(), next = new Peer(); let acquisitions = 0, stopOnSelection = false, stops = 0;
  const f = fixture({ provider: { tryShared: async () => { acquisitions++; return acquisitions === 1 ? first : next; },
    acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); } } });
  await f.c.start();
  const selected = compactSelection(1, 'stop-at-publication', 'same-rules');
  assert.equal(f.c.cardSource.setStyleSelection(selected), true);
  const input = { key: 'stop-at-publication', version: 1, text: 'const staged = 1;', complete: true };
  const preparation = { keys: new Set([input.key]),
    prepare() { f.c.sourceWork.observe(input); }, needsRefresh() { return false; },
    acceptsSelection() { if (stopOnSelection) { stopOnSelection = false; stops++; f.c.suspend(); } return true; } };
  const group = f.c.cardSource.registerPreparation(preparation)!;
  f.c.cardSource.queuePreparation(group); f.c.sourcePump.flush(); await settle();
  const source = first.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(source >= 0, true);
  first.answerSource(source); await settle();
  const style = first.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.equal(style >= 0, true);
  first.answerStyle(style);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.cardSource.groupPresentation(group)!.palette, selected.palette, 'a real ready publication precedes the stop control');
  const before = f.c.sourceStatistics.stats();
  const rebound = compactSelection(2, 'stop-at-publication', 'same-rules'); stopOnSelection = true;
  assert.equal(f.c.cardSource.setStyleSelection(rebound), true); f.c.sourcePump.flush(); await settle();
  assert.equal(stops, 1, 'the public selection predicate stops the real client during local reconciliation');
  assert.equal(await f.c.whenSettled(), false);
  assert.equal(f.c.sourceStatistics.stats().stylePublications, before.stylePublications, 'an already entered visit cannot publish after reentrant terminal stop');
  const stoppedView = f.c.cardSource.groupPresentation(group);
  if (stoppedView) assert.equal(stoppedView.palette, selected.palette, 'stopping does not replace the retained ready palette');
  assert.equal(f.c.sourceStatistics.stats().dispatches, before.dispatches);
  await f.c.resume(); await settle();
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.cardSource.groupPresentation(group)!.palette, rebound.palette);
  assert.equal(f.c.sourceStatistics.stats().dispatches, before.dispatches, 'useful return reuses complete scopes and cached expressions without SOURCE or STYLE RPC');
  assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
  assert.equal(preparation.keys.has(input.key), true, 'the preparation remains live through recovered publication');
});

for (const execution of ['not_started', 'started'] as const) {
  test(`worker availability: validated SOURCE ${execution} retires only its connection and recovers useful work`, async () => {
    const clock = new Clock(), peer = new Peer(), replacement = new Peer(), otherPeer = new Peer();
    let acquisitions = 0;
    const reported: unknown[] = [];
    const f = fixture({ provider: { clock, tryShared: async () => ++acquisitions === 1 ? peer : replacement, acquireOwned: async () => new Peer() },
      diagnostic: (level, _area, _explanation, fields) => { if (level === 'ERROR' && fields?.code === 'worker_gone') reported.push(fields.execution); } }, new Store(), peer);
    const other = fixture({}, new Store(), otherPeer);
    await f.c.start(); await other.c.start();
    const input = { key: 'failed-worker-source', version: 1, text: 'fn affected() {}', language: 'rust', complete: true };
    other.c.sourceWork.observe({ ...input, key: 'independent-worker-source', text: 'fn independent() {}' }); other.c.sourcePump.flush();
    const otherIndex = otherPeer.calls.findIndex(call => call.request.op === 'highlight');
    assert.equal(otherIndex >= 0, true);
    f.c.sourceWork.observe(input); f.c.sourcePump.flush();
    const index = peer.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(index >= 0, true);
    peer.fault(index, 'worker_gone', execution); await settle();
    assert.equal(reported.includes(execution), true, 'preserve the actual typed error and execution diagnostic');
    assert.equal(otherPeer.closes, 0); assert.equal(otherPeer.calls[otherIndex]!.options?.signal?.aborted, false);
    assert.equal(peer.closes, 1, 'validated worker unavailability retires our route even without a transport-end notice');
    await clock.advance(60000);
    assert.equal(acquisitions, 2);
    const retried = replacement.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(retried >= 0, true);
    assert.equal(otherPeer.closes, 0); assert.equal(otherPeer.calls[otherIndex]!.options?.signal?.aborted, false);
    otherPeer.answerSource(otherIndex); replacement.answerSource(retried);
    assert.equal(await other.c.whenSettled(), true); assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
    if (execution === 'started') assert.equal(f.c.sourceLifecycle.workStatus(input.key).execution, 'unknown', 'native recovery cannot erase prior shared execution uncertainty');
    const calls = replacement.calls.length;
    await clock.advance(120000); f.c.sourcePump.flush(); assert.equal(await f.c.whenSettled(), true);
    assert.equal(replacement.calls.length, calls); assert.equal(acquisitions, 2); assert.equal(otherPeer.closes, 0);
  });

  test(`worker availability: validated STYLE ${execution} recovers missing styles without SOURCE replay`, async () => {
    const clock = new Clock(), peer = new Peer(), replacement = new Peer(); let acquisitions = 0;
    const f = fixture({ provider: { clock, tryShared: async () => ++acquisitions === 1 ? peer : replacement, acquireOwned: async () => new Peer() } }, new Store(), peer);
    await f.c.start();
    const input = { key: 'failed-worker-style', version: 1, text: 'fn styled() {}', language: 'rust', complete: true };
    const preparation = { keys: new Set([input.key]), prepare() { f.c.sourceWork.observe(input); }, needsRefresh: () => false, acceptsSelection: () => true };
    const group = f.c.cardSource.registerPreparation(preparation)!;
    f.c.cardSource.queuePreparation(group); f.c.sourcePump.flush();
    const source = peer.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(source >= 0, true);
    peer.answerSource(source); assert.equal(await f.c.whenSettled(), true);
    const generation = f.c.sourceWork.borrowSource(input.key)!.generation;
    const selected = compactSelection(1); f.c.cardSource.setStyleSelection(selected); f.c.sourcePump.flush();
    const style = peer.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.equal(style >= 0, true);
    peer.fault(style, 'worker_gone', execution); await settle();
    assert.equal(peer.closes, 1, 'STYLE worker failure has provider availability authority but no SOURCE outcome authority');
    await clock.advance(60000); assert.equal(acquisitions, 2);
    assert.equal(replacement.calls.filter(call => call.request.op === 'highlight' || call.request.op.startsWith('stream.')).length, 0);
    const retry = replacement.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.equal(retry >= 0, true);
    replacement.answerStyle(retry); assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.cardSource.groupPresentation(group)!.palette, selected.palette);
    assert.equal(f.c.sourceWork.borrowSource(input.key)!.generation, generation);
    assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
    const calls = replacement.calls.length;
    await clock.advance(120000); f.c.sourcePump.flush(); assert.equal(await f.c.whenSettled(), true);
    assert.equal(replacement.calls.length, calls); assert.equal(acquisitions, 2);
    assert.equal(preparation.keys.has(input.key), true);
  });

  test(`worker availability: validated CLOSE ${execution} retires an unusable idle route without useless reacquisition`, async () => {
    const clock = new Clock(), peer = new Peer(); let acquisitions = 0;
    const f = fixture({ provider: { clock, tryShared: async () => { acquisitions++; return peer; }, acquireOwned: async () => new Peer() } }, new Store(), peer);
    await f.c.start();
    const input = { key: 'failed-worker-close', version: 1, text: 'echo x', language: 'bash', complete: false };
    f.c.sourceWork.observe(input); f.c.sourcePump.flush();
    const open = peer.calls.findIndex(call => call.request.op === 'stream.open'); assert.equal(open >= 0, true);
    const r = peer.calls[open]!.request, source = r.sources[0], bytes = Buffer.byteLength(source.text);
    peer.calls[open]!.resolve({ v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
      kind: 'source', vocabulary: descriptor(r.ticket).body.vocabulary.fingerprint, sources: [{ key: source.key, generation: source.generation,
        source_version: source.source_version, revision: 1, replace_from: 0, source_bytes: bytes, committed_bytes: 0, complete: false,
        lease: 'failed-worker-close-lease', contexts: [[0, 1]], runs: [bytes, 1],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes } }] } });
    assert.equal(await f.c.whenSettled(), true);
    f.c.cardSource.remove(input.key); f.c.sourcePump.flush();
    const close = peer.calls.findIndex(call => call.request.op === 'stream.close'); assert.equal(close >= 0, true);
    peer.fault(close, 'worker_gone', execution); await settle();
    assert.equal(peer.closes, 1, 'connection cleanup does not require surviving card demand');
    assert.equal(await f.c.whenSettled(), true);
    await clock.advance(120000); assert.equal(await f.c.whenSettled(), true);
    assert.equal(acquisitions, 1, 'no removed card can cause automatic replacement acquisition');
    assert.equal(f.c.sourceWork.status(input.key), undefined);
    assert.equal(f.c.sourceStatistics.stats().globalUnsettledJobs, 0);
  });
}

for (const rejection of ['uncorrelated native fault', 'local message'] as const) {
  test(`worker availability: ${rejection} cannot retire a functioning provider`, async () => {
    const peer = new Peer(), f = fixture({}, new Store(), peer); await f.c.start();
    const input = { key: 'non-authoritative-worker-fault', version: 1, text: 'fn safe() {}', complete: true };
    f.c.sourceWork.observe(input); f.c.sourcePump.flush();
    const index = peer.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(index >= 0, true);
    if (rejection === 'local message') peer.calls[index]!.reject(new Error('worker_gone'));
    else peer.calls[index]!.resolve({ v: 4, ticket: 'wrong-ticket', instance: 'instance', assets: 'assets', status: 'error', error: { code: 'worker_gone', execution: 'started' } });
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(peer.closes, 0); assert.equal(f.c.snapshot().provider.availability, 'ready');
    assert.equal(f.c.sourceLifecycle.workStatus(input.key).fallbackEligible, false);
  });
}

test('worker availability: a delayed fault from a deliberately stopped generation cannot retire its replacement', async () => {
  class DelayedPeer extends Peer {
    override close() { this.closes++; this.end('closed'); return this.exit; }
  }
  const peer = new DelayedPeer(), replacement = new Peer(); let acquisitions = 0;
  const f = fixture({ provider: { tryShared: async () => ++acquisitions === 1 ? peer : replacement, acquireOwned: async () => new Peer() } }, new Store(), peer);
  await f.c.start();
  const input = { key: 'old-worker-fault', version: 1, text: 'fn resumed() {}', complete: true };
  f.c.sourceWork.observe(input); f.c.sourcePump.flush();
  const old = peer.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(old >= 0, true);
  const waiting = f.c.whenSettled(); f.c.suspend(); assert.equal(await waiting, false);
  await f.c.resume(); const generation = f.c.snapshot().provider.generation;
  assert.equal(f.c.snapshot().provider.availability, 'ready'); assert.equal(acquisitions, 2);
  peer.fault(old, 'worker_gone', 'started'); await settle();
  assert.equal(replacement.closes, 0); assert.equal(f.c.snapshot().provider.generation, generation);
  f.c.sourceWork.observe(input); f.c.sourcePump.flush();
  for (const [index, call] of replacement.calls.entries()) if (call.request.op === 'highlight') replacement.answerSource(index);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(replacement.closes, 0); assert.equal(acquisitions, 2);
});

test('a real prepared Pi card retains native acquisition interest after startup failed before its first SOURCE', async () => {
  initTheme('system', false);
  const theme = getThemeByName('system')!, paletteInputs = new PaletteInputOwner(), clock = new Clock(); setThemeInstance(theme);
  let available = false, cards: CardSources<object> | undefined, classifications = 0, sharedAttempts = 0;
  const f = fixture({ provider: { clock,
    async tryShared() { sharedAttempts++; return available ? f.peer : undefined; },
    async acquireOwned() { throw new Error('fixture owned provider unavailable'); } },
    initialTheme: { kind: 'pi', variant: 'dark' },
    onChange() { if (cards) cards.metadataChanged(paletteInputs.palette(theme, f.c.snapshot().effective!)); },
    onSourceChange(keys, groups) { cards?.sourceChanged(keys, groups); }
  });
  try {
    await f.c.start();
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.snapshot().provider.availability, 'unavailable');
    const palette = paletteInputs.palette(theme, f.c.snapshot().effective!), owner = {};
    cards = new CardSources(f.c, {
      preparePaletteInput: (selection, revision, mode, funding, usePiFallback) => paletteInputs.prepare(theme, selection, revision, mode, funding, usePiFallback),
      classify(text) { classifications++; return highlightCode(text, 'typescript'); },
      invalidate() {}, requestRender() {}
    });
    const text = 'const firstUsefulCard = 1;';
    const reader = fileToolReaderFixture({ name: 'write', args: { path: 'first.ts', content: text }, result: {} });
    const input = { kind: 'file' as const, reader, diagnostics: reader.diagnostics('full'),
      revision: 1, sourceRevision: 1, serviceRevision: 1, palette, mode: 'truecolor' as const };
    assert.equal(cards.updateDisplay(owner, input), true); cards.useful(owner, input.revision);
    assert.equal(await f.c.whenSettled(), true);
    assert.ok(classifications > 0, 'the existing real Pi classifier prepared the first useful card');
    assert.equal(cards.visit(owner, (display, paint) => {
      assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'pi');
      if (display.kind === 'file') assert.ok(display.rows.some(row => row.region?.text === text));
    }), true);
    const key = cards.identities(owner)[0]?.key;
    assert.ok(key);
    assert.equal(f.c.sourceStatistics.stats().sourceRecords, 1, 'useful preparation admits native input before readiness');
    assert.equal(f.c.sourceWork.borrowSource(key)?.text, text);
    assert.equal(f.c.sourceWork.status(key)?.acknowledgedVersion, undefined, 'admission is not native execution');
    assert.equal(f.c.sourceWork.workStatus(key).fallbackEligible, true, 'never-ready input does not veto the eligible Pi path');
    assert.equal(f.peer.calls.length, 0);
    const before = sharedAttempts;
    available = true;
    assert.ok(clock.timers.size > 0, 'admitted native demand survives the real Pi preparation without an executed SOURCE');
    const at = Math.min(...[...clock.timers.values()].map(timer => timer.at));
    assert.equal(Number.isFinite(at), true); await clock.advance(Math.max(0, at - clock.now())); await settle();
    assert.ok(sharedAttempts > before);
    const source = f.peer.calls.findIndex(call => call.request.op === 'highlight');
    assert.ok(source >= 0, 'the same actual card, without terminal callbacks or text changes, reacquires SOURCE');
    f.peer.answerSource(source); await settle();
    const styles = f.peer.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.ok(styles >= 0);
    f.peer.answerStyle(styles); assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(key)?.exact, true);
    assert.equal(cards.visit(owner, display => {
      assert.equal(display.kind, 'file'); if (display.kind === 'file') assert.ok(display.rows.some(row => row.region?.text === text));
    }), true);
    const calls = f.peer.calls.length, classified = classifications;
    cards.useful(owner, input.revision); await settle();
    assert.equal(f.peer.calls.length, calls); assert.equal(classifications, classified);
  } finally { cards?.dispose(); paletteInputs.dispose(); }
});

for (const withdrawn of [false, true]) test(`general native recovery: late exit of an unpublished owned candidate ${withdrawn ? 'does not acquire for withdrawn work' : 'wakes useful work without a generation receipt'}`, async () => {
  const clock = new Clock(), rejected = new Peer(), replacement = new Peer(), exit = deferred<void>();
  rejected.holdMetadata = true; rejected.exit = exit.promise;
  let acquisitions = 0;
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => ++acquisitions === 1 ? rejected : replacement } });
  try {
    const startup = f.c.start(); await settle();
    assert.equal(acquisitions, 1); assert.equal(rejected.calls[0]?.request.op, 'describe');
    await clock.advance(PROVIDER_LIMITS.controlMs);
    assert.equal(rejected.closes, 1, 'failed negotiation must begin actual cleanup');
    await clock.advance(PROVIDER_LIMITS.closeMs); await startup;
    assert.equal(f.c.snapshot().provider.availability, 'unavailable');
    assert.equal(f.c.snapshot().provider.reason, 'unproved_exit');
    assert.equal(f.c.snapshot().provider.description, undefined, 'the old candidate was never published');
    const input = { key: 'after-unpublished-exit', version: 1, text: 'const useful = 1;', complete: true };
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
    await clock.advance(60000);
    assert.equal(acquisitions, 1, 'a bounded close timeout and elapsed recovery time are not actual exit');
    assert.equal(replacement.calls.length, 0);
    assert.equal(clock.timers.size, 0, 'cleanup-blocked work waits for actual completion, not a timer chain');
    if (withdrawn) f.c.cardSource.remove(input.key);
    exit.resolve(); await settle(); await settle();
    assert.equal(acquisitions, withdrawn ? 1 : 2,
      'actual unpublished cleanup must wake useful reconciliation, not blindly start an acquisition');
    if (withdrawn) {
      assert.equal(await f.c.whenSettled(), true);
      await clock.advance(120000);
      assert.equal(acquisitions, 1); assert.equal(replacement.calls.length, 0);
    } else {
      const source = replacement.calls.findIndex(call => call.request.op === 'highlight');
      assert.ok(source >= 0, 'no published-generation receipt, input update or UI refresh drives this recovery');
      assert.equal(replacement.calls[source]!.request.sources[0].text, input.text);
      replacement.answerSource(source);
      assert.equal(await f.c.whenSettled(), true);
      assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
      const requests = replacement.calls.length;
      await clock.advance(120000); f.c.sourcePump.flush(); await settle();
      assert.equal(replacement.calls.length, requests, 'ready unchanged work stops recovery');
    }
  } finally { exit.resolve(); }
});

test('service recovery preserves its start interval across useful success and skips missed rounds', async () => {
  const clock = new Clock(), peers: Peer[] = [], sharedAt: number[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => {
    const peer = new Peer(); peers.push(peer); sharedAt.push(clock.now()); return peer;
  }, acquireOwned: async () => { throw new Error('shared fixture must remain available'); } } });
  await f.c.start();
  assert.deepEqual(sharedAt, [0], 'initial selection is not a failure cycle');
  f.c.sourceWork.observe(demand(f.c, 'before-first-loss')); f.c.sourcePump.flush();
  assert.equal(peers[0]!.calls.at(-1)!.request.op, 'highlight');
  peers[0]!.end('lost'); await settle(); await settle();
  assert.deepEqual(sharedAt, [0, 0], 'first failure cycle can start immediately');
  f.c.cardSource.remove('before-first-loss');
  const successInput = { ...demand(f.c, 'successful-replacement'), text: 'const successful = 1;' };
  f.c.sourceWork.observe(successInput); f.c.sourcePump.flush();
  const successful = peers[1]!.calls.findIndex(call => call.request.op === 'highlight' && call.request.sources[0].text === successInput.text);
  assert.ok(successful >= 0);
  for (let index = 0; index < peers[1]!.calls.length; index++) {
    if (peers[1]!.calls[index]!.request.op === 'highlight') peers[1]!.answerSource(index);
  }
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('successful-replacement')?.exact, true, 'actual SOURCE succeeds before another loss');
  f.c.cardSource.remove('successful-replacement');
  await clock.advance(1000);
  f.c.sourceWork.observe(demand(f.c, 'next-independent-loss')); f.c.sourcePump.flush();
  assert.equal(peers[1]!.calls.at(-1)!.request.op, 'highlight');
  peers[1]!.end('lost'); await settle(); await settle();
  assert.deepEqual(sharedAt, [0, 0], 'useful success and a fresh key cannot reset the failure-cycle start interval');
  await clock.advance(58999);
  assert.deepEqual(sharedAt, [0, 0]);
  await clock.advance(1); await settle();
  assert.deepEqual(sharedAt, [0, 0, 60000]);
  assert.equal(peers[2]!.calls.at(-1)!.request.op, 'highlight');
  await clock.advance(1);
  peers[2]!.end('lost'); await settle(); await settle();
  assert.deepEqual(sharedAt, [0, 0, 60000]);
  await clock.advance(300000); await settle();
  assert.deepEqual(sharedAt, [0, 0, 60000, 360001], 'late timer delivery admits one cycle at actual time, not missed slots');
  await clock.advance(0);
  assert.equal(sharedAt.length, 4, 'there is no immediate catch-up cycle');
  const current = peers[3]!;
  assert.equal(current.calls.filter(call => call.request.op === 'highlight').length, 1);
  current.answerSource(current.calls.findIndex(call => call.request.op === 'highlight'));
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('next-independent-loss')?.exact, true);
  assert.equal(clock.timers.size, 0, 'no delayed useful work remains');
  await clock.advance(120000);
  assert.equal(sharedAt.length, 4);
});

test('service recovery retains its failure interval across ordinary terminal activation', async () => {
  const clock = new Clock(), peers: Peer[] = [], sharedAt: number[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => {
    const peer = new Peer(); peers.push(peer); sharedAt.push(clock.now()); return peer;
  }, acquireOwned: async () => { throw new Error('shared fixture must remain available'); } } });
  await f.c.start();
  f.c.sourceWork.observe(demand(f.c, 'before-stop-loss')); f.c.sourcePump.flush();
  peers[0]!.end('lost'); await settle(); await settle();
  assert.deepEqual(sharedAt, [0, 0]);
  f.c.cardSource.remove('before-stop-loss');
  f.c.sourceWork.observe(demand(f.c, 'during-stop')); f.c.sourcePump.flush();
  assert.equal(peers[1]!.calls.at(-1)!.request.op, 'highlight');
  await clock.advance(1000);
  const waiting = f.c.whenSettled();
  f.c.suspend();
  assert.equal(await waiting, false);
  await clock.advance(1000);
  await f.c.resume(); await settle();
  assert.deepEqual(sharedAt, [0, 0, 2000], 'normal lifecycle activation is allowed independently of failure-cycle pacing');
  f.c.cardSource.remove('during-stop');
  f.c.sourceWork.observe(demand(f.c, 'after-stop-loss')); f.c.sourcePump.flush();
  assert.equal(peers[2]!.calls.at(-1)!.request.op, 'highlight');
  peers[2]!.end('lost'); await settle(); await settle();
  assert.deepEqual(sharedAt, [0, 0, 2000], 'successful ordinary activation must not erase the earlier failure deadline');
  await clock.advance(57999);
  assert.deepEqual(sharedAt, [0, 0, 2000]);
  await clock.advance(1); await settle();
  assert.deepEqual(sharedAt, [0, 0, 2000, 60000]);
  const current = peers[3]!;
  assert.equal(current.calls.filter(call => call.request.op === 'highlight').length, 1);
  current.answerSource(current.calls.findIndex(call => call.request.op === 'highlight'));
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('after-stop-loss')?.exact, true);
  assert.equal(clock.timers.size, 0);
});

test('service recovery outlives the former owned restart cap without useful success', async () => {
  const clock = new Clock(), peers: Peer[] = [], ownedAt: number[] = [];
  let shared = 0;
  const f = fixture({ provider: { clock, tryShared: async () => { shared++; return undefined; }, acquireOwned: async () => {
    const peer = new Peer(); peers.push(peer); ownedAt.push(clock.now()); return peer;
  } } });
  await f.c.start();
  assert.equal(shared, 1);
  assert.deepEqual(ownedAt, [0]);
  for (let loss = 0; loss < 4; loss++) {
    if (loss) await clock.advance(60000);
    const peer = peers[loss]!;
    assert.equal(f.c.sourceWork.observe({ key: 'persistent-owned-loss', version: loss + 1, text: `const wanted = ${loss};`, complete: true }), true);
    f.c.sourcePump.flush();
    assert.equal(peer.calls.some(call => call.request.op === 'highlight'), true, 'actual useful SOURCE precedes each independent loss');
    peer.end('lost'); await settle(); await settle();
    assert.equal(peer.closes, 1);
    assert.equal(ownedAt.length, loss + 2, 'each due useful cycle remains available without a lifetime restart stop');
    assert.equal(ownedAt.at(-1), clock.now());
    assert.equal(shared, 1, 'an owned-loss cycle keeps its existing owned-only selection strategy');
  }
  assert.deepEqual(ownedAt, [0, 0, 60000, 120000, 180000]);
  const current = peers.at(-1)!;
  assert.equal(current.calls.filter(call => call.request.op === 'highlight').length, 1);
  current.answerSource(current.calls.findIndex(call => call.request.op === 'highlight'));
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('persistent-owned-loss')?.exact, true);
  assert.equal(clock.timers.size, 0);
});

for (const interrupted of [false, true]) test(`prepared Bash completion: same-version final input reaches native after ${interrupted ? 'interrupted' : 'ready'} preparation`, { timeout: 12000 }, async () => {
  initTheme('system', false);
  const theme = getThemeByName('system')!, palettes = new PaletteInputOwner(), clock = new Clock(); setThemeInstance(theme);
  const first = new Peer(), next = new Peer(); next.holdMetadata = true;
  let cards: CardSources<object> | undefined, acquisitions = 0, classifications = 0;
  const f = fixture({ provider: { clock, tryShared: async () => ++acquisitions === 1 ? first : next,
    acquireOwned: async () => { throw new Error('shared fixture must remain available'); } },
    onChange() { cards?.metadataChanged(palettes.palette(theme, f.c.snapshot().effective!)); },
    onSourceChange(keys, groups) { cards?.sourceChanged(keys, groups); } });
  const text = 'printf ready\n', bytes = Buffer.byteLength(text), owner = {};
  function answer(peer: Peer, index: number) {
    const r = peer.calls[index]!.request, append = r.op === 'stream.append', source = append ? r : r.sources[0], complete = r.op !== 'stream.open';
    if (append) { assert.equal(r.append, ''); assert.equal(r.final, true); }
    peer.calls[index]!.resolve({ v: 4, ticket: r.ticket, instance: 'instance', assets: 'assets', status: 'ok', body: {
      kind: 'source', vocabulary: descriptor(r.ticket).body.vocabulary.fingerprint, sources: [{
        key: source.key, generation: source.generation, source_version: source.source_version,
        revision: append ? 2 : 1, replace_from: append ? bytes : 0, source_bytes: bytes, committed_bytes: bytes, complete,
        ...(complete ? {} : { lease: 'completion-lease' }), contexts: append ? [] : [[0, 1]], runs: append ? [] : [bytes, 1],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: append ? 0 : bytes },
      }] } });
  }
  try {
    await f.c.start();
    cards = new CardSources(f.c, {
      preparePaletteInput: (selection, revision, mode, funding, fallback) => palettes.prepare(theme, selection, revision, mode, funding, fallback),
      classify() { classifications++; return []; }, invalidate() {}, requestRender() {}
    });
    const reader = bashToolReaderFixture({ args: { command: text }, partial: true, argsComplete: false });
    const input = { kind: 'bash' as const, reader, complete: false, revision: 1, sourceRevision: 1, serviceRevision: 1,
      palette: palettes.palette(theme, f.c.snapshot().effective!), mode: 'truecolor' as const };
    assert.equal(cards.updateDisplay(owner, input), true); cards.useful(owner, input.revision);
    await settle(); await settle();
    const open = first.calls.findIndex(call => call.request.op === 'stream.open'); assert.ok(open >= 0);
    answer(first, open); await settle();
    const styles = first.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.ok(styles >= 0);
    first.answerStyle(styles); assert.equal(await f.c.whenSettled(), true);
    assert.equal(cards.visit(owner, display => { assert.equal(display.kind, 'bash'); }), true);
    const original = cards.identities(owner)[0]!;
    assert.equal(original.complete, false); assert.equal(f.c.sourceWork.status(original.key)?.complete, false);
    if (interrupted) {
      f.c.sourceWork.observe(demand(f.c, 'independent-connection-need')); f.c.sourcePump.flush();
      assert.equal(first.calls.at(-1)!.request.op, 'highlight');
      first.end('lost'); await settle(); await settle();
      assert.equal(acquisitions, 2); assert.equal(next.calls[0]!.request.op, 'describe');
      assert.notEqual(f.c.snapshot().provider.availability, 'ready');
    }
    const finishedReader = bashToolReaderFixture({ args: { command: text }, partial: false, argsComplete: true });
    assert.deepEqual(finishedReader.source(), reader.source(), 'normal reader identity excludes completion');
    const finished = { ...input, reader: finishedReader, complete: true, revision: 2, serviceRevision: 2 };
    assert.equal(cards.updateDisplay(owner, finished), true); cards.useful(owner, finished.revision);
    f.c.sourcePump.flush(); await settle(); await settle();
    const current = cards.identities(owner)[0]!;
    assert.equal(current.version, original.version, 'completion does not manufacture a new text version');
    assert.equal(current.complete, true, 'the real card prepared the latest formation');
    if (interrupted) {
      assert.equal(f.c.sourceWork.status(original.key)?.complete, true, 'latest completion is admitted before native readiness');
      assert.equal(next.calls.filter(call => call.request.op !== 'describe').length, 0, 'admission cannot dispatch before readiness');
      next.answerMetadata(0); await settle(); await settle();
    }
    const peer = interrupted ? next : first, operation = interrupted ? 'highlight' : 'stream.append';
    const finish = peer.calls.findIndex(call => call.request.op === operation && (operation === 'stream.append' || call.request.sources[0].text === text));
    assert.ok(finish >= 0, 'native must receive the latest completion even though retained text already looks exact');
    assert.equal(f.c.sourceWork.status(original.key)?.complete, true);
    answer(peer, finish);
    for (let index = 0; index < peer.calls.length; index++) {
      if (index !== finish && peer.calls[index]!.request.op === 'highlight') peer.answerSource(index);
    }
    await settle();
    for (let index = 0; index < peer.calls.length; index++) if (peer.calls[index]!.request.op === 'styles.resolve') peer.answerStyle(index);
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(original.key)?.exact, true);
    const calls = peer.calls.length;
    cards.useful(owner, finished.revision); await settle();
    assert.equal(peer.calls.length, calls); assert.equal(classifications, 0, 'Bash never uses Pi fallback');
  } finally { cards?.dispose(); palettes.dispose(); }
});

for (const initial of ['empty', 'first metadata refusal', 'unavailable metadata refusal'] as const) test(initial === 'empty'
  ? 'native interest boundary: empty stays idle until a genuinely new deferred input'
  : initial === 'first metadata refusal'
    ? 'native interest boundary: first metadata refusal creates no source record or healthy-route churn'
    : 'native interest boundary: unavailable metadata refusal preserves real Pi without acquisition interest', async () => {
  initTheme('system', false);
  const theme = getThemeByName('system')!, palettes = new PaletteInputOwner(), clock = new Clock(); setThemeInstance(theme);
  const first = new Peer(), next = new Peer();
  let available = false, attempts = 0, offered = 0, classifications = 0, cards: CardSources<object> | undefined;
  const sourcePath = initial === 'unavailable metadata refusal' ? 'p'.repeat(1536) + '.ts' : 'interest.ts';
  const f = fixture({ provider: { clock,
    tryShared: async () => { attempts++; return initial === 'first metadata refusal' && attempts === 1 ? first : available ? next : undefined; },
    acquireOwned: async () => { throw new Error('fixture owned route unavailable'); } },
    ...(initial !== 'empty' ? { source: { maxBookkeepingBytes: initial === 'unavailable metadata refusal' ? 4096 : 2047 } } : {}),
    onChange() { cards?.metadataChanged(palettes.palette(theme, f.c.snapshot().effective!)); },
    onSourceChange(keys, groups) { cards?.sourceChanged(keys, groups); } });
  const observe = f.c.sourceWork.observe.bind(f.c.sourceWork);
  f.c.sourceWork.observe = input => { offered++; return observe(input); };
  try {
    await f.c.start();
    cards = new CardSources(f.c, {
      preparePaletteInput: (selection, revision, mode, funding, fallback) => palettes.prepare(theme, selection, revision, mode, funding, fallback),
      classify(text) { classifications++; return highlightCode(text, 'typescript'); }, invalidate() {}, requestRender() {}
    });
    const owner = {}, reader = fileToolReaderFixture({ name: 'write', args: { path: sourcePath, content: 'const refused = 1;' }, result: {} });
    const common = { revision: 1, sourceRevision: 1, serviceRevision: 1,
      palette: palettes.palette(theme, f.c.snapshot().effective!), mode: 'truecolor' as const };
    const input = initial === 'empty'
      ? { ...common, kind: 'bash' as const, reader: bashToolReaderFixture({ args: { command: '' } }), complete: true }
      : { ...common, kind: 'file' as const, reader, diagnostics: reader.diagnostics('full') };
    assert.equal(cards.updateDisplay(owner, input), true);
    const nativeBookkeeping = f.c.sourceStatistics.stats().bookkeepingBytes;
    assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0, 'cold registration does not offer SOURCE');
    cards.useful(owner, input.revision);
    assert.equal(await f.c.whenSettled(), true);
    if (initial === 'unavailable metadata refusal') {
      assert.equal(f.c.snapshot().provider.availability, 'unavailable');
      assert.ok(classifications > 0, 'the actual SDK Pi classifier succeeds independently of native admission');
      assert.equal(cards.visit(owner, (display, paint) => {
        assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'pi');
        if (display.kind === 'file') assert.ok(display.rows.some(row => row.region?.text === 'const refused = 1;'));
      }), true);
      const before = attempts;
      await clock.advance(120000);
      assert.equal(attempts, before, 'unfunded native input does not sustain recovery');
      assert.equal(clock.timers.size, 0); assert.equal(first.calls.length, 0); assert.equal(next.calls.length, 0);
      const bookkeeping = f.c.sourceStatistics.stats().bookkeepingBytes;
      assert.equal(observe({ key: 'native-meta-fit', version: 1, text: 'x', complete: true }), true,
        'the same enabled unavailable owner can fund a small native record');
      assert.ok(f.c.sourceStatistics.stats().bookkeepingBytes > bookkeeping);
      f.c.cardSource.remove('native-meta-fit');
      assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, bookkeeping);
      assert.equal(observe({ key: cards.identities(owner)[0]!.key, version: 1,
        text: 'const refused = 1;', path: sourcePath, complete: true }), false,
      'the actual native boundary refuses this path while the real Pi publication remains funded');
      assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, bookkeeping);
      assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0);
    }
    assert.equal(offered > 0, true, 'useful preparation offers bounded SOURCE before readiness, including locally empty input');
    assert.equal(f.c.sourceStatistics.stats().sourceRecords, initial === 'empty' ? 1 : 0);
    assert.equal(cards.identities(owner).length, 1, 'the paid current card slot survives');
    if (initial === 'empty') {
      const key = cards.identities(owner)[0]!.key, admitted = f.c.sourceWork.borrowSource(key);
      assert.ok(admitted !== undefined); assert.equal(admitted.text, '');
      assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes - nativeBookkeeping,
        1024 + 2 * (key.length + (admitted.language?.length ?? 0) + (admitted.path?.length ?? 0)),
        'the B admission delta is exactly the existing source record fee, not recovery work');
      assert.equal(f.c.sourceWork.status(key)?.acknowledgedVersion, undefined);
    }
    if (initial !== 'empty') {
      assert.equal(f.c.sourceWork.status(cards.identities(owner)[0]!.key), undefined);
      assert.equal(f.c.snapshot().provider.availability, initial === 'first metadata refusal' ? 'ready' : 'unavailable');
      assert.equal(first.calls.filter(call => call.request.op !== 'describe').length, 0);
      const before = attempts;
      await clock.advance(120000);
      assert.equal(attempts, before); assert.equal(first.closes, 0);
      const changedReader = fileToolReaderFixture({ name: 'write', args: { path: sourcePath, content: 'const stillRefused = 2;' }, result: {} });
      const changed = { ...common, kind: 'file' as const, reader: changedReader, diagnostics: changedReader.diagnostics('full'),
        revision: 2, sourceRevision: 2, serviceRevision: 2 };
      const priorOffers = offered, classified = classifications;
      assert.equal(cards.updateDisplay(owner, changed), true); cards.useful(owner, changed.revision);
      assert.equal(await f.c.whenSettled(), true); assert.ok(offered > priorOffers);
      if (initial === 'unavailable metadata refusal') {
        assert.ok(classifications > classified);
        assert.equal(cards.visit(owner, (display, paint) => {
          assert.equal(paint.origin, 'pi');
          if (display.kind === 'file') assert.ok(display.rows.some(row => row.region?.text === 'const stillRefused = 2;'));
        }), true);
      }
      assert.equal(attempts, before); assert.equal(first.closes, 0);
      assert.equal(first.calls.filter(call => call.request.op !== 'describe').length, 0);
      assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0);
      return;
    }
    assert.equal(f.c.snapshot().provider.availability, 'unavailable');
    const before = attempts; available = true;
    assert.equal(clock.timers.size, 0, 'neither known refusal nor empty input sustains service recovery');
    await clock.advance(120000);
    assert.equal(attempts, before); assert.equal(next.calls.length, 0);
    const latest = 'const newlyDeferred = 2;';
    const changedReader = fileToolReaderFixture({ name: 'write', args: { path: 'interest.ts', content: latest }, result: {} });
    const changed = input.kind === 'file'
      ? { ...input, reader: changedReader, diagnostics: changedReader.diagnostics('full'), revision: 2, sourceRevision: 2, serviceRevision: 2 }
      : { ...input, reader: bashToolReaderFixture({ args: { command: latest } }), revision: 2, sourceRevision: 2, serviceRevision: 2 };
    assert.equal(cards.updateDisplay(owner, changed), true); cards.useful(owner, changed.revision);
    await settle(); await settle();
    assert.ok(attempts > before, 'the paired actual new nonempty deferred input must request an available route');
    const source = next.calls.findIndex(call => call.request.op === 'highlight');
    assert.ok(source >= 0); assert.equal(next.calls[source]!.request.sources[0].text, latest);
    next.answerSource(source); await settle();
    for (let index = 0; index < next.calls.length; index++) if (next.calls[index]!.request.op === 'styles.resolve') next.answerStyle(index);
    assert.equal(await f.c.whenSettled(), true);
    const stable = attempts, calls = next.calls.length;
    await clock.advance(120000); cards.useful(owner, changed.revision); await settle();
    assert.equal(attempts, stable); assert.equal(next.calls.length, calls);
  } finally { cards?.dispose(); palettes.dispose(); f.c.sourceWork.observe = observe; }
});

test('terminal inactive: idle provider closes and later useful input uses ordinary activation', async () => {
  const clock = new Clock(), next = new Peer(); let connections = 0;
  const f = fixture({ provider: { clock,
    tryShared: async () => ++connections === 1 ? f.peer : next,
    acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
  await f.c.start();
  assert.equal(f.c.snapshot().provider.availability, 'ready');
  assert.equal(f.c.sourceStatistics.stats().unsettledJobs, 0);
  assert.deepEqual(f.peer.calls.map(call => call.request.op), ['describe']);
  f.c.suspend();
  assert.equal(await f.c.whenSettled(), false);
  assert.equal(f.peer.closes, 1, 'actual terminal stop closes an idle connection too');
  await settle();
  assert.equal(clock.timers.size, 0, 'after bounded connection cleanup there is no recovery wake for idle work');
  await f.c.resume();
  const input = demand(f.c, 'after-idle-terminal-return');
  assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush();
  await settle(); await settle();
  const source = next.calls.findIndex(call => call.request.op === 'highlight');
  assert.ok(source >= 0, 'normal activation/current demand replaces the closed route');
  assert.equal(next.calls[source]!.request.sources[0].text, input.text);
  next.answerSource(source); assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
  const calls = next.calls.length;
  await clock.advance(120000); f.c.sourcePump.flush(); await settle();
  assert.equal(next.calls.length, calls);
});


for (const failure of ['busy', 'invalid SOURCE body'] as const) {
  test(`SOURCE delay lifetime: effective Off resets ${failure} without deadline-only retention`, async () => {
    const clock = new Clock(), first = new Peer(), next = new Peer(); let acquisitions = 0;
    const f = fixture({ provider: { clock,
      tryShared: async () => ++acquisitions === 1 ? first : next,
      acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
    const input = { key: 'off-delay', version: 1, text: 'const current = 1;', complete: true };
    await f.c.start();
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush();
    const failed = first.calls.findIndex(call => call.request.op === 'highlight'); assert.ok(failed >= 0);
    if (failure === 'busy') first.fault(failed, 'busy');
    else {
      const reply = first.sourceReply(failed); reply.body.sources[0]!.runs = [0, 1];
      first.calls[failed]!.resolve(reply);
    }
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, failure === 'busy');
    await clock.advance(1000);
    await f.c.setEnabled(false);
    assert.equal(first.closes, 1);
    assert.equal(clock.timers.size, 0, 'Off retains no delayed execution wake');
    assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, 0);
    assert.equal(f.c.sourceStatistics.stats().sourceRecords, failure === 'busy' ? 0 : 1,
      'only independent execution history may retain the source record');
    assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, failure === 'busy');
    await f.c.setEnabled(true);
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
    assert.equal(clock.now(), 1000, 'no minute has elapsed across effective Off/On');
    assert.equal(acquisitions, 2);
    const retry = next.calls.findIndex(call => call.request.op === 'highlight');
    assert.ok(retry >= 0, 'both a deleted and a retained source may retry immediately after On');
    assert.equal(next.calls[retry]!.request.sources[0].text, input.text);
    next.answerSource(retry); await settle();
    nativeStyles(f.c); await settle();
    const style = next.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.ok(style >= 0);
    next.answerStyle(style);
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
    assert.equal(f.c.sourceWork.workStatus(input.key).fallbackEligible, failure === 'busy',
      'the delay reset and later success cannot erase shared uncertainty');
    const calls = next.calls.length;
    await clock.advance(120000); f.c.sourcePump.flush(); await settle();
    assert.equal(next.calls.length, calls); assert.equal(next.closes, 0);
  });
}

test('execution wake funding: exhausted bookkeeping still permits one live wake and refunds its ordinary source records', async () => {
  const clock = new Clock(), peer = new Peer(); let acquisitions = 0;
  const sourceBytes = 1024 + 2, limit = 128 + 2 * sourceBytes;
  const f = fixture({ source: { maxBookkeepingBytes: limit }, provider: { clock,
    tryShared: async () => { acquisitions++; return peer; },
    acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
  await f.c.start();
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 128);
  const a = { key: 'a', version: 1, text: 'const a = 1;', complete: true };
  const b = { ...a, key: 'b', text: 'const b = 2;' };
  assert.equal(f.c.sourceWork.observe(a), true); assert.equal(f.c.sourceWork.observe(b), true);
  f.c.sourcePump.flush();
  const attempts = (text: string) => peer.calls.filter(call => call.request.op === 'highlight' && call.request.sources[0].text === text);
  assert.equal(attempts(a.text).length, 1); assert.equal(attempts(b.text).length, 1);
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, limit, 'no new bookkeeping grant can fit');
  assert.equal(clock.timers.size, 0, 'the ready shared route has no unrelated broker timer');
  peer.fault(peer.calls.indexOf(attempts(a.text)[0]!), 'busy'); await settle();
  assert.equal(clock.timers.size, 1, 'the complete control is already paid before the first failure');
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, limit);
  await clock.advance(1000);
  peer.fault(peer.calls.indexOf(attempts(b.text)[0]!), 'busy');
  assert.equal(await f.c.whenSettled(), true, 'future execution opportunities are not current work');
  assert.equal(clock.timers.size, 1, 'multiple useful sources share one execution wake');
  assert.equal(Math.min(...[...clock.timers.values()].map(timer => timer.at)), 60000);
  f.c.cardSource.remove(a.key);
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 128 + sourceBytes);
  assert.equal(clock.timers.size <= 1, true);
  await clock.advance(59000);
  assert.equal(attempts(a.text).length, 1); assert.equal(attempts(b.text).length, 1,
    'a possibly stale early wake cannot run the remaining source before its own deadline');
  assert.equal(clock.timers.size, 1);
  await clock.advance(1000);
  assert.equal(attempts(a.text).length, 1); assert.equal(attempts(b.text).length, 2);
  assert.equal(clock.timers.size, 0, 'a fired wake is no longer live');
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 128 + sourceBytes);
  peer.answerSource(peer.calls.indexOf(attempts(b.text)[1]!));
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(b.key)?.exact, true);
  f.c.cardSource.remove(b.key);
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 128);
  assert.equal(clock.timers.size, 0); assert.equal(acquisitions, 1); assert.equal(peer.closes, 0);
  await f.c.dispose();
  assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 0);
  assert.equal(clock.timers.size, 0);
});


test('terminal inactive: direct SOURCE observation refuses admission and ordinary return accepts current input', async () => {
  const clock = new Clock(), peers: Peer[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => { const peer = new Peer(); peers.push(peer); return peer; },
    acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
  await f.c.start();
  const input = { key: 'inactive-direct', version: 1, text: 'const current = 1;', complete: true };
  assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0);
  f.c.suspend();
  assert.equal(await f.c.whenSettled(), false);
  assert.equal(f.c.sourceWork.observe(input), false, 'inactivity is checked at the source admission boundary');
  f.c.sourcePump.flush(); await settle();
  assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0);
  assert.equal(peers.flatMap(peer => peer.calls).filter(call => call.request.op !== 'describe').length, 0);
  assert.equal(clock.timers.size, 0);
  await f.c.resume();
  assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
  const current = peers.at(-1)!, source = current.calls.findIndex(call => call.request.op === 'highlight');
  assert.ok(source >= 0); assert.equal(current.calls[source]!.request.sources[0].text, input.text);
  current.answerSource(source);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
});


for (const [code, execution] of [['busy', 'not_started'], ['data_limit', 'started']] as const) {
  test(`SOURCE delay lifetime: actual owned stop and provider replacement preserve ${code} ${execution} cooldown`, async () => {
    const clock = new Clock(), first = new Peer(), next = new Peer(); let acquisitions = 0;
    const f = fixture({ provider: { clock, tryShared: async () => undefined,
      acquireOwned: async () => ++acquisitions === 1 ? first : next } });
    const input = { key: 'provider-delay', version: 1, text: 'const current = 1;', complete: true };
    await f.c.start();
    assert.equal(f.c.snapshot().provider.kind, 'owned');
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush();
    const failed = first.calls.findIndex(call => call.request.op === 'highlight'); assert.ok(failed >= 0);
    await clock.advance(5000); first.fault(failed, code, execution);
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.workStatus(input.key).execution, execution);
    await clock.advance(1000);
    first.end('lost'); await settle(); await settle();
    assert.equal(first.closes, 1); assert.equal(acquisitions, 2);
    assert.equal(f.c.snapshot().provider.availability, 'ready');
    assert.equal(f.c.sourceWork.workStatus(input.key).execution, 'not_started',
      'actual owned cleanup may end the old execution barrier independently of the delay');
    assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
    const sources = () => next.calls.filter(call => call.request.op === 'highlight');
    assert.equal(sources().length, 0, 'equal reobservation and a truthful stopped receipt cannot reset the existing delay');
    await clock.advance(58999);
    assert.equal(sources().length, 0);
    await clock.advance(1);
    assert.equal(clock.now(), 65000); assert.equal(sources().length, 1,
      'retry uses the original failure deadline, not the new connection time');
    assert.equal(sources()[0]!.request.sources[0].text, input.text);
    next.answerSource(next.calls.indexOf(sources()[0]!));
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
    await clock.advance(120000); f.c.sourcePump.flush(); await settle();
    assert.equal(sources().length, 1); assert.equal(next.closes, 0); assert.equal(acquisitions, 2);
  });
}


for (const consumer of ['direct', 'prepared file'] as const) for (const smaller of [false, true]) {
  test(`pre-ready SOURCE admission: ${consumer} reconciles ${smaller ? 'smaller' : 'fitting'} negotiated source cap`, async () => {
    initTheme('system', false);
    const theme = getThemeByName('system')!, palettes = new PaletteInputOwner(); setThemeInstance(theme);
    const clock = new Clock(), peer = new Peer(); peer.holdMetadata = true;
    let cards: CardSources<object> | undefined, classifications = 0;
    const f = fixture({ provider: { clock, tryShared: async () => peer,
      acquireOwned: async () => { throw new Error('the selected shared route remains available'); } },
      onChange() { cards?.metadataChanged(palettes.palette(theme, f.c.snapshot().effective!)); },
      onSourceChange(keys, groups) { cards?.sourceChanged(keys, groups); } });
    const starting = f.c.start(), owner = {}, text = 'const bounded = 1;';
    const input = { key: 'pre-ready-cap', version: 1, text, complete: true };
    let key = input.key;
    try {
      await settle(); await settle();
      assert.equal(f.c.snapshot().enabled, true);
      assert.equal(f.c.snapshot().provider.availability, 'initializing');
      assert.equal(peer.calls.length, 1); assert.equal(peer.calls[0]!.request.op, 'describe');
      if (consumer === 'direct') {
        assert.equal(f.c.sourceWork.observe(input), true); f.c.sourcePump.flush(); await settle();
      } else {
        cards = new CardSources(f.c, {
          preparePaletteInput: (selection, revision, mode, funding, fallback) => palettes.prepare(theme, selection, revision, mode, funding, fallback),
          classify(value) { classifications++; return highlightCode(value, 'typescript'); }, invalidate() {}, requestRender() {}
        });
        const reader = fileToolReaderFixture({ name: 'write', args: { path: 'bounded.ts', content: text }, result: {} });
        const display = { kind: 'file' as const, reader, diagnostics: reader.diagnostics('full'),
          revision: 1, sourceRevision: 1, serviceRevision: 1,
          palette: palettes.palette(theme, f.c.snapshot().effective!), mode: 'truecolor' as const };
        assert.equal(cards.updateDisplay(owner, display), true); cards.useful(owner, display.revision);
        await settle(); await settle();
        assert.ok(classifications > 0);
        key = cards.identities(owner)[0]!.key;
        assert.equal(cards.visit(owner, (prepared, paint) => {
          assert.equal(paint.origin, 'pi'); assert.equal(prepared.kind, 'file');
          let colored = 0;
          assert.equal(paint.ranges(key)?.((_start, _end, style) => { if (style.open !== paint.roles.code.open) colored++; }), true);
          assert.ok(colored > 0, 'real Pi classification is distinguishable from the peer default-code styles');
          if (prepared.kind === 'file') assert.ok(prepared.rows.some(row => row.region?.text === text));
        }), true);
      }
      assert.equal(f.c.sourceStatistics.stats().sourceRecords, 1, 'the ordinary useful input is admitted before negotiation');
      assert.equal(f.c.sourceWork.borrowSource(key)?.text, text);
      assert.ok(f.c.sourceStatistics.stats().retention.snapshotBytes > 0, 'early retention is already funded');
      assert.equal(f.c.sourceWork.status(key)?.acknowledgedVersion, undefined);
      assert.equal(f.c.sourceWork.workStatus(key).fallbackEligible, true, 'never-ready input adds no priority-only Pi veto');
      assert.equal(peer.calls.length, 1, 'no SOURCE is sent before descriptor validation');
      const metadata = descriptor(peer.calls[0]!.request.ticket);
      if (smaller) metadata.body.limits.source_bytes = 4;
      peer.calls[0]!.resolve(metadata);
      await starting; await settle(); await settle();
      assert.equal(f.c.snapshot().provider.availability, 'ready');
      f.c.sourcePump.flush(); await settle();
      const sources = () => peer.calls.filter(call => call.request.op === 'highlight');
      if (smaller) {
        assert.equal(sources().length, 0, 'new negotiated limits are checked before any oversized RPC');
        assert.equal(f.c.sourceStatistics.stats().unsettledJobs, 0);
        assert.equal(f.c.sourceWork.status(key)?.acknowledgedVersion, undefined);
        assert.equal(f.c.sourceWork.workStatus(key).fallbackEligible, true);
        if (cards) assert.equal(cards.visit(owner, (_prepared, paint) => { assert.equal(paint.origin, 'pi'); }), true);
        await clock.advance(120000); f.c.sourcePump.flush(); await settle();
        assert.equal(sources().length, 0); assert.equal(peer.closes, 0);
      } else {
        assert.equal(sources().length, 1, 'readiness reconciles admitted input without a new caller observation');
        assert.equal(sources()[0]!.request.sources[0].text, text);
        peer.answerSource(peer.calls.indexOf(sources()[0]!)); await settle();
        for (let index = 0; index < peer.calls.length; index++) if (peer.calls[index]!.request.op === 'styles.resolve') peer.answerStyle(index);
        assert.equal(await f.c.whenSettled(), true);
        assert.equal(f.c.sourceWork.status(key)?.exact, true);
        if (cards) assert.equal(cards.visit(owner, (prepared, paint) => {
          let nativeRanges = 0;
          assert.equal(paint.ranges(key)?.((_start, _end, style) => {
            nativeRanges++; assert.equal(style.open, paint.roles.code.open);
          }), true);
          assert.ok(nativeRanges > 0, 'native scopes use the peer default-code styles instead of cached Pi token colors');
          assert.equal(paint.origin, 'pi', 'palette origin is independent of the native SOURCE/STYLE executor');
          if (prepared.kind === 'file') assert.ok(prepared.rows.some(row => row.region?.text === text));
        }), true);
        const requests = peer.calls.length;
        await clock.advance(120000); f.c.sourcePump.flush(); await settle();
        assert.equal(peer.calls.length, requests);
      }
      if (cards) cards.remove(owner); else f.c.cardSource.remove(key);
      await settle();
      assert.equal(f.c.sourceStatistics.stats().sourceRecords, 0);
      assert.equal(f.c.sourceStatistics.stats().retention.snapshotBytes, 0);
    } finally {
      cards?.dispose(); palettes.dispose(); await f.c.dispose(); await starting;
      assert.equal(f.c.sourceStatistics.stats().bookkeepingBytes, 0);
      assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, 0);
    }
  });
}


test('execution wake lifetime: a cancelled callback cannot clear a successor wake after Off/On', async () => {
  const clock = new Clock(), peers: Peer[] = [];
  const f = fixture({ provider: { clock, tryShared: async () => { const peer = new Peer(); peers.push(peer); return peer; },
    acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
  const input = { key: 'stale-wake', version: 1, text: 'const current = 1;', complete: true };
  await f.c.start();
  f.c.sourceWork.observe(input); f.c.sourcePump.flush();
  peers[0]!.fault(peers[0]!.calls.findIndex(call => call.request.op === 'highlight'), 'busy');
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(clock.timers.size, 1);
  const stale = [...clock.timers.values()][0]!.callback;
  await clock.advance(1000); await f.c.setEnabled(false);
  assert.equal(clock.timers.size, 0);
  await f.c.setEnabled(true);
  f.c.sourceWork.observe(input); f.c.sourcePump.flush();
  const next = peers[1]!, sources = () => next.calls.filter(call => call.request.op === 'highlight');
  assert.equal(sources().length, 1);
  next.fault(next.calls.indexOf(sources()[0]!), 'busy');
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(clock.timers.size, 1);
  const [id, successor] = [...clock.timers][0]!;
  assert.equal(successor.at, 61000);
  stale(); await settle();
  assert.equal(clock.timers.size, 1); assert.equal(clock.timers.has(id), true);
  assert.equal(sources().length, 1);
  await clock.advance(59999); assert.equal(sources().length, 1);
  await clock.advance(1); assert.equal(sources().length, 2);
  assert.equal(clock.timers.size, 0);
  next.answerSource(next.calls.indexOf(sources()[1]!));
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
  assert.equal(clock.timers.size, 0);
});

async function detachedExecutionWake(clock: Clock, peer: Peer) {
  const client = new SyntaxClient({ provider: { clock, tryShared: async () => peer, acquireOwned: async () => new Peer() },
    standaloneVersion: 'wake-lifetime', initialTheme: piPreference });
  try {
    await client.start();
    client.sourceWork.observe({ key: 'weak-wake', version: 1, text: 'const weak = 1;', complete: true }); client.sourcePump.flush();
    peer.fault(peer.calls.findIndex(call => call.request.op === 'highlight'), 'busy');
    assert.equal(await client.whenSettled(), true);
    assert.equal(clock.timers.size, 1);
    const stats = client.sourceStatistics.stats();
    assert.ok(stats.bookkeepingBytes > 128);
    return { client: new WeakRef(client), execution: new WeakRef(client.sourceWork),
      globalBytes: stats.globalBookkeepingBytes, charged: stats.bookkeepingBytes };
  } catch (error) { await client.dispose(); throw error; }
}

test('execution wake lifetime: a live delayed callback does not retain its first client or source owner', { timeout: 12000 }, async () => {
  assert.equal(typeof global.gc, 'function');
  const clock = new Clock(), peer = new Peer(), live = fixture(); await live.c.start();
  const first = await detachedExecutionWake(clock, peer);
  try {
    for (let index = 0; index < 40; index++) {
      await turn(); global.gc!(); await turn();
      if (!first.client.deref() && !first.execution.deref() && clock.timers.size === 0) break;
    }
    assert.equal(first.client.deref() === undefined, true);
    assert.equal(first.execution.deref() === undefined, true);
    assert.equal(clock.timers.size, 0, 'finalization cancels the same live execution handle');
    assert.equal(live.c.sourceStatistics.stats().globalBookkeepingBytes, first.globalBytes - first.charged);
    assert.equal(live.c.snapshot().provider.availability, 'ready');
    const calls = peer.calls.length;
    await clock.advance(120000);
    assert.equal(peer.calls.length, calls);
  } finally {
    await first.client.deref()?.dispose();
    const execution = first.execution.deref(); if (execution instanceof SourceExecution) execution.dispose();
    await peer.close();
  }
});

test('execution wake pass minimum: partial quota visits preserve the older deadline and firing cannot reset quota', { timeout: 12000 }, async t => {
  const clock = new Clock(), f = fixture({ provider: { clock, tryShared: async () => f.peer,
    acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
  await f.c.start();
  const input = { key: 'oldest-deadline', version: 1, text: 'const oldest = 1;', complete: true };
  f.c.sourceWork.observe(input); f.c.sourcePump.flush();
  const sources = () => f.peer.calls.filter(call => call.request.op === 'highlight');
  f.peer.fault(f.peer.calls.indexOf(sources()[0]!), 'busy');
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(clock.timers.size, 1);
  const execution = f.c.sourceWork; assert.ok(execution instanceof SourceExecution);
  const resume = execution.resumePreparation, held = deferred<void>();
  let release: (() => void) | undefined, intercepted = false;
  t.mock.method(execution, 'resumePreparation', function(this: SourceExecution) {
    if (!intercepted) { intercepted = true; release = () => resume.call(this); held.resolve(); return; }
    return resume.call(this);
  });
  const visits: number[] = [];
  const tasks = Array.from({ length: 3 }, (_, index) => ({ keys: new Set<string>(), requiresCredit() { return false; },
    needsRefresh() { return false; }, prepare() { visits.push(index); } }));
  const groups = tasks.map(task => execution.registerPreparation(task)!);
  try {
    for (const group of groups) execution.queuePreparation(group, true);
    await held.promise;
    assert.deepEqual(visits, [2, 1]);
    assert.equal(clock.timers.size, 1, 'an incomplete pass cannot prove that the unseen older deadline disappeared');
    execution.flush(); await Promise.resolve(); execution.flush();
    assert.deepEqual(visits, [2, 1]); assert.equal(clock.timers.size, 1);
    await clock.advance(60000);
    assert.deepEqual(visits, [2, 1]); assert.equal(sources().length, 1, 'timer delivery never resets the host-turn budget');
    assert.ok(release); const next = release; release = undefined; next();
    await settle();
    assert.deepEqual(visits, [2, 1, 0]); assert.equal(sources().length, 2);
    f.peer.answerSource(f.peer.calls.indexOf(sources()[1]!));
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.sourceWork.status(input.key)?.exact, true);
    assert.equal(clock.timers.size, 0);
  } finally { release?.(); for (const group of groups) execution.unregisterPreparation(group); }
});


test('SOURCE delay qualification: retired payload before deferred abort cannot seed a later retry deadline', { timeout: 12000 }, async t => {
  const clock = new Clock(), f = fixture({ source: { retention: { maxBytes: 65536 } },
    provider: { clock, tryShared: async () => f.peer, acquireOwned: async () => { throw new Error('shared route remains available'); } } });
  await f.c.start();
  const execution = f.c.sourceWork; assert.ok(execution instanceof SourceExecution);
  const input = { key: 'retired-before-abort', version: 1, text: 'x'.repeat(4096), complete: true };
  assert.equal(execution.observe(input), true); execution.flush();
  const sources = () => f.peer.calls.filter(call => call.request.op === 'highlight');
  assert.equal(sources().length, 1);
  const bytes = f.c.sourceStatistics.stats().transientBytes; assert.ok(bytes > 0);
  const gate = t.mock.method(execution, 'continueWork', function() {});
  let held: { release(): void } | undefined;
  try {
    const grant = execution.geometryFunding()!.grant(60000); assert.ok(grant);
    held = grant.consume(60000); grant.close();
    assert.equal(execution.borrowSource(input.key), undefined, 'real geometry pressure evicts the admitted source payload');
    assert.equal(f.c.sourceStatistics.stats().unsettledJobs, 1);
    assert.equal(f.c.sourceStatistics.stats().transientBytes, bytes);
    assert.equal(sources()[0]!.options?.signal?.aborted, false, 'the real continuation has not applied deferred abort');
    f.peer.fault(f.peer.calls.indexOf(sources()[0]!), 'busy');
    await settle(); await settle();
    assert.equal(f.c.sourceStatistics.stats().unsettledJobs, 0);
    assert.equal(f.c.sourceStatistics.stats().transientBytes, 0);
    assert.equal(clock.timers.size, 0);
    held.release(); held = undefined;
    gate.mock.restore();
    assert.equal(execution.retryEvicted(input.key), true);
    assert.equal(execution.observe(input), true); execution.flush(); await settle();
    assert.equal(clock.now(), 0);
    assert.equal(sources().length, 2, 'an obsolete pre-abort failure cannot postpone new funded reobservation');
    f.peer.answerSource(f.peer.calls.indexOf(sources()[1]!));
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(execution.status(input.key)?.exact, true);
    await clock.advance(120000); execution.flush(); await settle();
    assert.equal(sources().length, 2); assert.equal(clock.timers.size, 0); assert.equal(f.peer.closes, 0);
  } finally { held?.release(); gate.mock.restore(); execution.continueWork(); }
});


test('terminal activity: Pi admission stays inactive until ordinary return even with Native Off', async () => {
  const f = fixture(); await f.c.start(); await f.c.setEnabled(false); f.c.suspend();
  const request: Parameters<typeof f.c.pi.classify>[0] = { key: 'stopped-pi', version: 1, text: 'x', language: 'typescript', palette: 1,
    neutral: { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 } };
  const before = f.c.sourceStatistics.stats(); let classified = 0;
  const classify = () => { classified++; return ['x']; };
  f.c.pi.classify(request, classify);
  assert.equal(classified, 0, 'terminal inactivity forbids a new Pi classification independently of Native Off');
  assert.equal(f.c.pi.piProjection(request.key, 1, 1), undefined);
  assert.equal(f.c.sourceStatistics.stats().piSourceRecords, before.piSourceRecords);
  assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, before.retention.retainedBytes);
  assert.equal(f.c.sourceStatistics.stats().retention.outstandingPeakBytes, 0);
  await f.c.resume();
  assert.equal(f.c.pi.classify(request, classify).outcome, 'pi', 'Native Off still permits Pi while the terminal is active');
  assert.equal(classified, 1); assert.ok(f.c.pi.piProjection(request.key, 1, 1));
  assert.equal(f.c.sourceStatistics.stats().dispatches, 0);
});

test('terminal activity: reentrant stop prevents Pi projection adoption and preserves the prior ready projection', async () => {
  const f = fixture(); await f.c.start(); await f.c.setEnabled(false);
  const request: Parameters<typeof f.c.pi.classify>[0] = { key: 'staging-pi', version: 1, text: 'x', language: 'typescript', palette: 1,
    neutral: { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 } };
  assert.equal(f.c.pi.classify(request, () => ['x']).outcome, 'pi', 'active Native Off positively completes the existing Pi transaction');
  assert.equal(await f.c.whenSettled(), true);
  const prior = f.c.pi.piProjection(request.key, 1, 1)!;
  assert.ok(prior); const before = f.c.sourceStatistics.stats();
  let stop = true, classified = 0, result: string | undefined;
  const preparation = { keys: new Set([request.key]), requiresCredit: () => false,
    prepare() {
      result = f.c.pi.classify({ ...request, palette: 2 }, () => {
        classified++; if (stop) { stop = false; f.c.suspend(); }
        return ['\x1b[31mx\x1b[39m'];
      }).outcome;
    } };
  const group = f.c.cardSource.registerPreparation(preparation)!;
  try {
    f.c.cardSource.queuePreparation(group, true);
    const waiting = f.c.whenSettled(); f.c.sourcePump.flush();
    assert.equal(await waiting, false, 'stop ends a real outstanding work observation');
    assert.equal(classified, 1);
    assert.equal(result, 'stale', 'a classifier that stops the client cannot continue preparing or adopting its returned rows');
    assert.equal(f.c.pi.piProjection(request.key, 1, 2), undefined);
    assert.equal(f.c.pi.piProjection(request.key, 1, 1)?.revision, prior.revision);
    let visited = 0; assert.equal(prior.visitRanges(() => { visited++; }), true); assert.ok(visited > 0);
    assert.equal(f.c.sourceStatistics.stats().retention.retainedBytes, before.retention.retainedBytes);
    assert.equal(f.c.sourceStatistics.stats().retention.outstandingPeakBytes, 0);
    assert.equal(f.c.pi.piFailure(request.key, 1, 2), undefined, 'inactivation is not a cached permanent Pi failure');
    await f.c.resume(); assert.equal(await f.c.whenSettled(), true);
    assert.equal(classified, 2); assert.equal(result, 'pi'); assert.ok(f.c.pi.piProjection(request.key, 1, 2));
    assert.equal(f.c.sourceStatistics.stats().dispatches, 0);
    for (let index = 0; index < 5; index++) f.c.sourcePump.flush();
    await settle(); assert.equal(classified, 2, 'completed warm visits do not classify again');
  } finally { f.c.cardSource.unregisterPreparation(group); }
});


test('service recovery scope: known optional absence keeps useful minute retries without a permanent stop', async () => {
  const clock = new Clock(); let owned = 0;
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => { owned++; throw new ExpectedOwnedUnavailable(); } } });
  await f.c.start(); assert.equal(owned, 1); assert.equal(f.c.snapshot().provider.reason, 'optional_unavailable');
  assert.equal(f.c.sourceWork.observe({ key: 'absent-native', version: 1, text: 'x', complete: true }), true);
  f.c.sourcePump.flush(); await settle(); await settle();
  assert.equal(owned, 2, 'known optional absence is not a permanent stop for useful native demand');
  assert.equal(await f.c.whenSettled(), true, 'a future opportunity is not current joined work');
  for (let round = 0; round < 3; round++) {
    await clock.advance(59999); assert.equal(owned, round + 2);
    await clock.advance(1); assert.equal(owned, round + 3);
    assert.equal(f.c.sourceStatistics.stats().dispatches, 0);
  }
  f.c.cardSource.remove('absent-native'); await clock.advance(120000);
  assert.equal(owned, 5, 'withdrawn native interest cannot keep attempting acquisition');
});

test('service recovery scope: explicit native Off/On preserves a charged service deadline across useful success', async () => {
  const clock = new Clock(), peers = [new Peer(), new Peer(), new Peer()]; let owned = 0;
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => peers[owned++]! } });
  await f.c.start(); assert.equal(owned, 1);
  assert.equal(f.c.sourceWork.observe({ key: 'lost-route', version: 1, text: 'x', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.equal(peers[0]!.calls.filter(call => call.request.op === 'highlight').length, 1);
  peers[0]!.end('lost'); await settle(); await settle(); f.c.sourcePump.flush(); await settle();
  assert.equal(owned, 2, 'the first useful automatic service cycle starts immediately');
  assert.equal(f.c.sourceWork.observe({ key: 'useful-success', version: 1, text: 'y', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  for (const [index, call] of peers[1]!.calls.entries()) if (call.request.op === 'highlight') peers[1]!.answerSource(index);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.workStatus('useful-success').execution, 'acknowledged');
  await clock.advance(10000); await f.c.setEnabled(false); await f.c.setEnabled(true);
  assert.equal(f.c.sourceWork.observe({ key: 'after-on', version: 1, text: 'z', complete: true }), true);
  f.c.sourcePump.flush(); await settle(); await settle();
  assert.equal(owned, 2, 'explicit On waits the remaining service interval instead of erasing its deadline');
  assert.equal(await f.c.whenSettled(), true, 'rate-deferred On does not join a minute-long pending operation');
  await clock.advance(49999); assert.equal(owned, 2);
  await clock.advance(1); assert.equal(owned, 3, 'the existing useful opportunity admits ordinary acquisition exactly when due');
  assert.equal(peers[0]!.closes, 1); assert.equal(peers[1]!.closes, 1);
});


for (const lossAfterReturn of [1000, 45000]) test(`normal terminal return: immediate activation ${lossAfterReturn === 1000 ? 'preserves the old failure deadline' : 'does not start a new service minute'}`, async () => {
  const clock = new Clock(), peers = Array.from({ length: 4 }, () => new Peer()); let owned = 0;
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => peers[owned++]! } });
  const answerSources = (peer: Peer) => {
    for (const [index, call] of peer.calls.entries()) if (call.request.op === 'highlight') peer.answerSource(index);
  };
  await f.c.start();
  assert.equal(f.c.sourceWork.observe({ key: 'first-loss', version: 1, text: 'x', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.equal(peers[0]!.calls.filter(call => call.request.op === 'highlight').length, 1);
  peers[0]!.end('lost'); await settle(); await settle();
  assert.equal(owned, 2, 'the first useful automatic recovery starts immediately');
  assert.equal(f.c.sourceWork.observe({ key: 'before-stop', version: 1, text: 'y', complete: true }), true);
  f.c.sourcePump.flush(); await settle(); answerSources(peers[1]!);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.workStatus('before-stop').execution, 'acknowledged');
  await clock.advance(15000);
  assert.equal(f.c.sourceWork.observe({ key: 'held-at-stop', version: 1, text: 'z', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.ok(peers[1]!.calls.some(call => call.request.op === 'highlight' && call.request.sources[0].text === 'z'));
  const waiting = f.c.whenSettled(); f.c.suspend();
  assert.equal(await waiting, false);
  assert.equal(peers[1]!.closes, 1, 'ordinary terminal stop closes this working connection');
  await f.c.resume(); await settle(); await settle();
  assert.equal(clock.now(), 15000);
  assert.equal(owned, 3, 'ordinary terminal return does not wait for the prior service deadline');
  f.c.sourcePump.flush(); await settle(); answerSources(peers[2]!);
  assert.equal(await f.c.whenSettled(), true);
  await clock.advance(lossAfterReturn);
  assert.equal(f.c.sourceWork.observe({ key: 'later-failure', version: 1, text: 'later', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.ok(peers[2]!.calls.some(call => call.request.op === 'highlight' && call.request.sources[0].text === 'later'));
  peers[2]!.end('lost'); await settle(); await settle(); f.c.sourcePump.flush(); await settle();
  if (lossAfterReturn === 1000) {
    assert.equal(owned, 3, 'normal return cannot erase the old automatic-recovery deadline');
    await clock.advance(43999); assert.equal(owned, 3);
    await clock.advance(1);
  }
  assert.equal(clock.now(), 60000);
  assert.equal(owned, 4, 'the next failure cycle is due at the original deadline, not a minute after terminal return');
  f.c.sourcePump.flush(); await settle(); answerSources(peers[3]!);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('later-failure')?.exact, true);
  assert.equal(f.c.sourceStatistics.stats().transientBytes, 0);
});


test('interrupted failure acquisition: terminal return waits the charged deadline and starts a newly charged cycle', async () => {
  const clock = new Clock(), first = new Peer(), late = new Peer(), next = new Peer(), final = new Peer();
  const acquiring = deferred<Peer>(); let owned = 0;
  const f = fixture({ provider: { clock, tryShared: async () => undefined,
    acquireOwned: async () => ++owned === 1 ? first : owned === 2 ? acquiring.promise : owned === 3 ? next : final } });
  const answerSources = (peer: Peer) => {
    for (const [index, call] of peer.calls.entries()) if (call.request.op === 'highlight') peer.answerSource(index);
  };
  await f.c.start();
  assert.equal(f.c.sourceWork.observe({ key: 'held-recovery', version: 1, text: 'first', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.equal(first.calls.filter(call => call.request.op === 'highlight').length, 1);
  first.end('lost'); await settle(); await settle();
  assert.equal(owned, 2, 'the first automatic cycle has actually entered its held factory at t0');
  assert.equal(clock.now(), 0);
  await clock.advance(5000);
  f.c.suspend(); assert.equal(await f.c.whenSettled(), false);
  acquiring.resolve(late); await settle(); await settle();
  assert.equal(late.closes, 1, 'the interrupted unpublished candidate is really closed, not adopted');
  await clock.advance(3000);
  await f.c.resume(); await settle(); await settle();
  assert.equal(clock.now(), 8000);
  assert.equal(owned, 2, 'a cancelled failure cycle cannot become uncharged healthy-route activation');
  await clock.advance(51999); assert.equal(owned, 2);
  await clock.advance(1); await settle(); await settle();
  assert.equal(clock.now(), 60000); assert.equal(owned, 3);
  assert.equal(f.c.sourceWork.observe({ key: 'due-proof', version: 1, text: 'ready', complete: true }), true);
  f.c.sourcePump.flush(); await settle(); answerSources(next);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('due-proof')?.exact, true);
  await clock.advance(1);
  assert.equal(f.c.sourceWork.observe({ key: 'subsequent-loss', version: 1, text: 'later', complete: true }), true);
  f.c.sourcePump.flush(); await settle();
  assert.ok(next.calls.some(call => call.request.op === 'highlight' && call.request.sources[0].text === 'later'));
  next.end('lost'); await settle(); await settle();
  assert.equal(owned, 3, 'the cycle at60000 charged its own next deadline; this is not a free old-cycle continuation');
  await clock.advance(59998); assert.equal(owned, 3);
  await clock.advance(1); await settle(); await settle();
  assert.equal(clock.now(), 120000); assert.equal(owned, 4);
  f.c.sourcePump.flush(); await settle(); answerSources(final);
  assert.equal(await f.c.whenSettled(), true);
  assert.equal(f.c.sourceWork.status('subsequent-loss')?.exact, true);
  assert.equal(f.c.sourceStatistics.stats().transientBytes, 0);
});

for (const delivery of ['timer-first', 'continuation-first'] as const) {
  test(`execution first wake: an unfinished positive pass survives a pause (${delivery})`, { timeout: 12000 }, async t => {
    const clock = new Clock(), f = fixture({ provider: { clock, tryShared: async () => f.peer,
      acquireOwned: async () => { throw new Error('shared fixture remains available'); } } });
    await f.c.start();
    const execution = f.c.sourceWork; assert.ok(execution instanceof SourceExecution);
    const visits: number[] = [];
    const tasks = Array.from({ length: 3 }, (_, index) => ({ keys: new Set<string>(), requiresCredit() { return false; },
      needsRefresh() { return false; }, prepare() { visits.push(index); } }));
    const groups = tasks.map(task => execution.registerPreparation(task)!);
    const input = { key: 'first-positive-deadline', version: 1, text: 'const delayed = 1;', complete: true };
    const sources = () => f.peer.calls.filter(call => call.request.op === 'highlight');
    const resume = execution.resumePreparation, held = deferred<void>();
    let release: (() => void) | undefined, intercepted = false;
    t.mock.method(execution, 'resumePreparation', function(this: SourceExecution) {
      if (!intercepted) { intercepted = true; release = () => resume.call(this); held.resolve(); return; }
      return resume.call(this);
    });
    const continuation = t.mock.method(execution, 'continueWork', function() {});
    try {
      assert.equal(execution.observe(input), true); execution.flush(); assert.equal(sources().length, 1);
      for (const group of groups) execution.queuePreparation(group, true);
      f.peer.fault(f.peer.calls.indexOf(sources()[0]!), 'busy');
      await settle();
      assert.equal(clock.timers.size, 0, 'no prior pass has admitted a delayed wake');
      assert.deepEqual(visits, []);
      continuation.mock.restore(); execution.flush(); await held.promise;
      assert.deepEqual(visits, [2, 1], 'older local work consumes the host-turn quota before pass exhaustion');
      assert.equal(clock.timers.size, 1, 'the visited useful SOURCE arms its first wake without waiting for the older cursor');
      if (delivery === 'timer-first') {
        await clock.advance(60000);
        assert.deepEqual(visits, [2, 1]); assert.equal(sources().length, 1, 'wake delivery cannot reset the held host-turn quota');
      } else clock.time += 60000;
      assert.ok(release); const next = release; release = undefined; next();
      await settle();
      if (delivery === 'continuation-first') {
        assert.equal(clock.timers.size, 1, 'a resumed older cursor cannot cancel the already-due positive wake');
        await clock.advance(0);
      }
      await settle();
      assert.deepEqual(visits, [2, 1, 0]); assert.equal(sources().length, 2);
      f.peer.answerSource(f.peer.calls.indexOf(sources()[1]!));
      assert.equal(await f.c.whenSettled(), true); assert.equal(execution.status(input.key)?.exact, true);
      assert.equal(clock.timers.size, 0); assert.equal(execution.stats().unsettledJobs, 0);
      assert.equal(execution.stats().transientBytes, 0);
    } finally { continuation.mock.restore(); release?.(); for (const group of groups) execution.unregisterPreparation(group); }
  });
}

for (const interruption of ['stop', 'selection'] as const) {
  test(`general native recovery: STYLE settlement ${interruption} cannot cache stale publication as local refusal`, async () => {
    const first = new Peer(), next = new Peer(); let acquisitions = 0, interruptOnSelection = false, interruptions = 0;
    const f = fixture({ provider: { tryShared: async () => ++acquisitions === 1 ? first : next,
      acquireOwned: async () => { throw new Error('fixture owned provider unavailable'); } } });
    await f.c.start();
    const selected = compactSelection(1, 'settlement-publication', 'settlement-rules');
    const rebound = compactSelection(2, 'settlement-publication', 'settlement-rules');
    assert.equal(f.c.cardSource.setStyleSelection(selected), true);
    const input = { key: `settlement-${interruption}`, version: 1, text: 'const settled = 1;', complete: true };
    const preparation = { keys: new Set([input.key]),
      prepare() { f.c.sourceWork.observe(input); }, needsRefresh() { return false; },
      acceptsSelection() {
        if (interruptOnSelection) {
          interruptOnSelection = false; interruptions++;
          if (interruption === 'stop') f.c.suspend();
          else assert.equal(f.c.cardSource.setStyleSelection(rebound), true);
        }
        return true;
      } };
    const group = f.c.cardSource.registerPreparation(preparation)!;
    f.c.cardSource.queuePreparation(group); f.c.sourcePump.flush(); await settle();
    const source = first.calls.findIndex(call => call.request.op === 'highlight'); assert.equal(source >= 0, true);
    first.answerSource(source); await settle();
    const style = first.calls.findIndex(call => call.request.op === 'styles.resolve'); assert.equal(style >= 0, true);
    const before = f.c.sourceStatistics.stats();
    assert.equal(before.globalUnsettledJobs, 1, 'the controlled interruption occurs during a real pending STYLE settlement');
    interruptOnSelection = true; first.answerStyle(style); await settle();
    assert.equal(interruptions, 1);
    assert.equal(f.c.sourceStatistics.stats().globalUnsettledJobs, 0, 'lifecycle or selection invalidation must not retain physical STYLE credit');
    assert.equal(f.c.sourceStatistics.stats().globalTransientBytes, 0);
    if (interruption === 'stop') {
      assert.equal(await f.c.whenSettled(), false);
      assert.equal(f.c.sourceStatistics.stats().stylePublications, before.stylePublications, 'inactive settlement cannot publish');
      await f.c.resume(); await settle();
    }
    assert.equal(await f.c.whenSettled(), true);
    assert.equal(f.c.cardSource.groupPresentation(group)?.palette, interruption === 'stop' ? selected.palette : rebound.palette,
      'ordinary useful reconciliation publishes installed expressions without a poisoned local refusal');
    assert.equal(f.c.sourceStatistics.stats().dispatches, before.dispatches, 'no replacement SOURCE or STYLE RPC is needed');
    assert.equal(first.calls.filter(call => call.request.op === 'highlight').length, 1);
    assert.equal(first.calls.filter(call => call.request.op === 'styles.resolve').length, 1);
    assert.deepEqual(next.calls.map(call => call.request.op), interruption === 'stop' ? ['describe'] : [],
      'ordinary reconnection may negotiate metadata, but cannot repeat data work');
    assert.equal(first.closes, interruption === 'stop' ? 1 : 0);
    assert.equal(acquisitions, interruption === 'stop' ? 2 : 1);
    assert.equal(f.c.sourceWork.status(input.key)!.exact, true);
    assert.equal(preparation.keys.has(input.key), true);
  });
}
