import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuRows, menuAction, menuThemeChoice, menuSnapshot, menuDetails, menuCacheDetails, menuPageTitle, menuNavigation } from '../../../src/application/menu-model.ts';
import type { TidyMenuSnapshot, TidyMenuPage, TidyMenuCommandIntent } from '../../../src/application/menu-contract.ts';
import type { SyntaxMenuSnapshot } from '../../../src/application/syntax-menu.ts';
import type { CacheStats } from '../../../src/render-cache.ts';

const view = { themeLoading: false, themeLoadFailed: false };
const preferences = () => ({ appearanceEnabled: true, terminalColorsEnabled: true, nativeHighlightingEnabled: true, loggingEnabled: true,
  selectedTheme: { kind: 'pi' as const, variant: 'dark' as const } });
const state = (): TidyMenuSnapshot => menuSnapshot(preferences(), {});

function syntaxSnapshot(): SyntaxMenuSnapshot {
  return { enabled: false, provider: { availability: 'disabled', reason: 'disabled', generation: 0, initialShared: undefined },
    standaloneVersion: 'not loaded', selected: { kind: 'theme', id: 'gitlab', variant: 'light' } };
}

test('fixed page rows have unique stable widget values and closed data intentions', () => {
  const snapshot = state();
  const counts: Record<TidyMenuPage, number> = { root: 6, themes: 34, support: 8, service: 1, logs: 4, cache: 3 };
  const kinds = new Set(['toggle', 'toggleVariant', 'choosePi', 'chooseFamily', 'maintain', 'navigate', 'back', 'close', 'refreshStatus', 'refreshCache']);
  for (const [page, count] of Object.entries(counts) as [TidyMenuPage, number][]) {
    const rows = menuRows(page, snapshot, view);
    assert.equal(rows.length, count, page);
    assert.equal(new Set(rows.map(row => row.value)).size, count, page);
    for (const row of rows) {
      assert.equal(typeof row.label, 'string'); assert.equal(typeof row.help, 'string');
      assert.equal(kinds.has(row.intent.kind), true, `${page}: ${row.value}`);
      assert.equal(Object.values(row.intent).some(value => typeof value === 'function'), false);
    }
  }
  assert.equal(menuRows('root', snapshot, view).find(row => row.value === 'theme-variant')?.disabled, true);
  snapshot.selected = { kind: 'theme', id: 'github', variant: 'light' };
  assert.equal(menuRows('root', snapshot, view).find(row => row.value === 'theme-variant')?.disabled, false);
});

test('theme model filters by family identity without manufacturing unavailable or duplicate choices', () => {
  const snapshot = state();
  snapshot.selected = { kind: 'theme', id: 'not-bundled', variant: 'light' };
  assert.equal(menuRows('themes', snapshot, view).some(row => row.value === 'theme:not-bundled'), false);
  assert.deepEqual(menuRows('themes', snapshot, { ...view, query: 'GITHUB' }).map(row => row.value), ['theme:github', 'back']);
  for (const blocked of [{ themeLoading: true, themeLoadFailed: false }, { themeLoading: false, themeLoadFailed: true }])
    assert.deepEqual(menuRows('themes', snapshot, blocked).map(row => row.value), ['back']);
  assert.deepEqual(menuRows('themes', snapshot, { ...view, query: 'no-matching-family' }).map(row => row.value), ['back']);
});

test('switch intentions resolve against current state rather than displayed On or Off', () => {
  for (const [page, key] of [['root', 'appearanceEnabled'], ['root', 'terminalColorsEnabled'],
    ['support', 'nativeHighlightingEnabled'], ['logs', 'loggingEnabled']] as const) {
    const snapshot = state();
    const intent = menuRows(page, snapshot, view).find(row => row.intent.kind === 'toggle' && row.intent.key === key)!.intent;
    assert.equal(intent.kind, 'toggle');
    if (intent.kind !== 'toggle') assert.fail('missing fixed switch intention');
    snapshot[key] = false;
    assert.deepEqual(menuAction(intent, snapshot, undefined), { kind: 'switch', key, value: true });
  }
});

test('root variant uses current selection while family intentions preserve the picker visit variant', () => {
  const snapshot = state();
  const variant: TidyMenuCommandIntent = { kind: 'toggleVariant' };
  assert.equal(menuAction(variant, snapshot, 'dark'), undefined);
  snapshot.selected = { kind: 'theme', id: 'gitlab', variant: 'light' };
  assert.deepEqual(menuAction(variant, snapshot, 'light'), { kind: 'theme', choice: { kind: 'theme', id: 'gitlab', variant: 'dark' } });
  assert.deepEqual(menuAction({ kind: 'chooseFamily', id: 'github' }, snapshot, 'dark'),
    { kind: 'theme', choice: { kind: 'theme', id: 'github', variant: 'dark' } });
  assert.deepEqual(menuAction({ kind: 'choosePi' }, snapshot, 'dark'), { kind: 'theme', choice: { kind: 'pi', variant: 'dark' } });
  assert.equal(menuAction({ kind: 'chooseFamily', id: 'github' }, snapshot, undefined), undefined);
  assert.equal(menuAction({ kind: 'chooseFamily', id: 'not-bundled' }, snapshot, 'light'), undefined);
  assert.equal(menuThemeChoice({ kind: 'back' }, 'dark'), undefined);
  snapshot.selected = { kind: 'theme', id: 'not-bundled', variant: 'dark' };
  assert.deepEqual(menuAction(variant, snapshot, 'dark'), { kind: 'theme', choice: { kind: 'theme', id: 'not-bundled', variant: 'light' } });
  for (const action of ['reapplyAppearance', 'reapplyColors', 'clearCache', 'retryLogging', 'snapshotLogs'] as const)
    assert.deepEqual(menuAction({ kind: 'maintain', action }, snapshot, undefined), { kind: action });
});

test('appearance snapshot text distinguishes requested state from actual cached eligibility', () => {
  const enabled = preferences();
  for (const [appearance, expected] of [
    [undefined, 'Not active'],
    [{ active: false, editorActive: false }, 'Not active'],
    [{ active: false, editorActive: false, reason: 'Foreign editor' }, 'Foreign editor'],
    [{ active: true, editorActive: true }, 'Active'],
    [{ active: true, editorActive: false }, 'Cards active; input styling not applied'],
  ] as const) assert.equal(menuSnapshot(enabled, { appearance }).appearance, expected);
  assert.equal(menuSnapshot({ ...enabled, appearanceEnabled: false }, { appearance: { active: true, editorActive: true } }).appearance,
    'Off; using Pi’s interface');
});

test('terminal-color snapshot text preserves requested-off, automatic, unavailable, error and suspended states', () => {
  const enabled = preferences();
  for (const [color, expected] of [
    [undefined, 'Not started'], ['on', 'Matching Pi theme'],
    ['automatic theme', 'Controlled by Pi’s automatic/system theme'], ['system theme', 'Controlled by Pi’s automatic/system theme'],
    ['no source', 'No file-backed Pi theme available'], ['source error', 'Theme could not be read; last valid colors retained'],
    ['suspended', 'suspended'],
  ] as const) assert.equal(menuSnapshot(enabled, { color }).terminalColors, expected);
  assert.equal(menuSnapshot({ ...enabled, terminalColorsEnabled: false }, { color: 'on' }).terminalColors, 'Off');
  assert.equal(menuSnapshot({ ...enabled, appearanceEnabled: false, terminalColorsEnabled: false }, { color: 'on' }).terminalColors,
    'Inactive while Tidy UI appearance is off');
});

test('cached native preview selection is distinct from confirmed preferences without mutating either', () => {
  const flags = preferences(), syntax = syntaxSnapshot();
  const before = structuredClone({ flags, syntax });
  const projected = menuSnapshot(flags, { syntax });
  assert.deepEqual(projected.selected, { kind: 'theme', id: 'gitlab', variant: 'light' });
  assert.equal(projected.syntax, syntax);
  assert.deepEqual({ flags, syntax }, before);
  assert.deepEqual(menuSnapshot(flags, {}).selected, { kind: 'pi', variant: 'dark' });
});

test('status projections retain unknown-palette, loading, failure and owner-removed health explanations', () => {
  const snapshot = state();
  snapshot.selected = { kind: 'theme', id: 'not-bundled', variant: 'light' };
  assert.deepEqual(menuDetails('themes', snapshot, { themeLoading: true, themeLoadFailed: false }), ['Loading saved code theme…']);
  assert.deepEqual(menuDetails('themes', snapshot, { themeLoading: false, themeLoadFailed: true }), ['Saved code theme could not be loaded. Reopen this page to retry.']);
  assert.equal(menuDetails('themes', snapshot, view).includes('The saved palette is unknown; using Follow Pi colors.'), true);
  const issue = { area: 'syntax' as const, operation: 'parse', code: 'transport_closed', time: '2026-11-12T00:00:00.000Z', state: 'released' as const };
  snapshot.health = { errors: 3, active: 1, issues: [issue], last: issue };
  const support = menuDetails('support', snapshot, view);
  assert.equal(support.includes('Runtime status: Problems detected'), true);
  assert.equal(support.includes('Runtime errors: 3; active: 1'), true);
  assert.equal(support.includes('Last runtime error: transport_closed; 2026-11-12T00:00:00.000Z; owner removed; not a confirmed recovery'), true);
  assert.equal(menuDetails('service', snapshot, view).some(row => row.startsWith('Runtime errors:')), false);
  const receipt = ['Frozen layout receipt'];
  assert.equal(menuDetails('cache', snapshot, { ...view, cache: receipt }), receipt);
  assert.deepEqual(menuDetails('root', snapshot, view), []);
});

function cacheStats(): CacheStats {
  const memory = () => ({ retainedBytes: 100, stringBytes: 80, overheadBytes: 20, entries: 1, rows: 2 });
  return { retainedBytes: 700, stringBytes: 560, overheadBytes: 140, entries: 7, rows: 14,
    hits: 4, misses: 7, builds: 7, releases: 1, collected: 1,
    byKind: { summary: memory(), bash: memory(), edit: memory(), write: memory(), read: memory(), user: memory(), queued: memory() } };
}

test('cache projection preserves summed layout/footer counters and one space-escaped diagnostic JSON receipt', () => {
  assert.deepEqual(menuCacheDetails(), ['No active display cache.']);
  const stats = cacheStats(), footer = { retainedBytes: 25, entries: 1, rows: 1 };
  const before = structuredClone({ stats, footer });
  const lines = menuCacheDetails({ stats, footer, heapUsedBytes: 123456 });
  assert.equal(lines[0], 'Saved layouts: 8; rows: 15');
  assert.equal(lines[1], 'Estimated retained memory: 725 bytes');
  assert.equal(lines.includes('Whole Pi process heap: 123456 bytes (not Tidy UI memory)'), true);
  const json = lines[lines.indexOf('Diagnostic JSON:') + 1]!;
  assert.equal(json.includes(' '), false, 'diagnostic JSON must survive native column wrapping without embedded literal spaces');
  const parsed = JSON.parse(json);
  assert.equal(parsed.presentationRetainedBytes, 725); assert.equal(parsed.presentationEntries, 8); assert.equal(parsed.presentationRows, 15);
  assert.equal(parsed.retainedBytes, 700); assert.equal(parsed.processHeapUsedBytes, 123456);
  assert.equal(parsed.processMemoryScope, 'whole Pi process, not pi-tidy-ui');
  assert.deepEqual(parsed.footerLayout, footer); assert.deepEqual(parsed.byKind, stats.byKind);
  assert.equal(lines.at(-1), 'End diagnostic JSON');
  assert.deepEqual({ stats, footer }, before);
  assert.equal(menuCacheDetails({ stats, heapUsedBytes: 0 }).includes('Footer: {"retainedBytes":0,"entries":0,"rows":0}'), true);
});

test('page titles and native keyboard help retain their fixed wording', () => {
  assert.equal(menuPageTitle('root'), 'Tidy UI');
  assert.equal(menuPageTitle('themes'), 'Code color theme');
  assert.equal(menuPageTitle('support'), 'Status & troubleshooting');
  assert.equal(menuPageTitle('service'), 'Highlighting service details');
  assert.equal(menuPageTitle('logs'), 'Diagnostic logs');
  assert.equal(menuPageTitle('cache'), 'Display cache');
  assert.equal(menuNavigation('root'), '↑↓ Navigate · Enter Select · Esc Close');
  for (const page of ['themes', 'support', 'service', 'logs', 'cache'] as const)
    assert.equal(menuNavigation(page), '↑↓ Navigate · Enter Select · Esc Back');
});

for (const reason of ['activation_deferred', 'worker_unavailable', 'exhausted_route'] as const) {
  test(`service details preserve the cached ${reason} reason without changing state`, () => {
    const syntax = syntaxSnapshot(); syntax.provider = { ...syntax.provider, availability: 'unavailable', reason };
    const snapshot = menuSnapshot(preferences(), { syntax }), before = structuredClone(snapshot);
    for (let index = 0; index < 20; index++) {
      assert.equal(menuDetails('service', snapshot, view).includes(`Service: unavailable (${reason})`), true);
    }
    assert.deepEqual(snapshot, before);
  });
}
