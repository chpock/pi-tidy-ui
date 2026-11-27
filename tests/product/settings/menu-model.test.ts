import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuRows, menuAction, menuThemeChoice, menuSnapshot, menuDetails, menuPageTitle, menuNavigation } from '../../../src/application/menu-model.ts';
import type { TidyMenuSnapshot, TidyMenuPage, TidyMenuCommandIntent } from '../../../src/application/menu-contract.ts';
import type { SyntaxMenuSnapshot } from '../../../src/application/syntax-menu.ts';
import { cacheMenuDetails } from '../../../src/application/cache-menu.ts';
import { layoutMemory } from '../../../src/render-cache.ts';
import { cacheMenuSample } from '../../fixtures/cache-menu-sample.ts';
import { observedCacheLayouts, observedCacheActivity } from '../../fixtures/cache-menu-observation.ts';

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
  const counts: Record<TidyMenuPage, number> = { root: 6, themes: 34, support: 8, service: 1, logs: 4, cache: 2, cacheActivity: 1 };
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
  assert.deepEqual(menuDetails('root', snapshot, view), []);
});

test('cache screens start with their tables, with scope notes below the rows', () => {
  const snapshot = cacheMenuSample();
  const layouts = cacheMenuDetails('cache', snapshot, 96), activity = cacheMenuDetails('cacheActivity', snapshot, 96);
  assert.match(layouts[0]!, /^Type\s+Layouts\s+Rows\s+Est\. size$/u);
  assert.match(activity[0]!, /^\s*Total\s+Tool cards\s+Other layouts$/u);
  assert.ok(layouts.findIndex(row => row.includes('model prompt cache')) > layouts.findIndex(row => row.startsWith('Queued messages')));
  assert.ok(activity.findIndex(row => row.includes('Footer not counted')) > activity.findIndex(row => row.startsWith('Of those, collected by GC')));
  assert.doesNotMatch([...layouts, ...activity].join('\n'), /Snapshot · Refresh to update/u);
});

for (const [bytes, display] of [
  [0, '0 KiB'], [1, '0.000977 KiB'], [512, '0.5 KiB'], [1024, '1 KiB'], [123456, '120.6 KiB'],
  [1048575, '1024 KiB'], [1048576, '1 MiB'], [1610612736, '1.5 GiB'],
] as const) test(`cache sizes use binary units and four-digit precision: ${bytes} bytes`, () => {
  const snapshot = { ...cacheMenuSample(0), heapUsedBytes: bytes };
  const details = cacheMenuDetails('cache', snapshot, 96);
  assert.ok(details.includes(`Whole Pi JS heap: ${display} (not the display cache).`));
  assert.match(details.find(row => row.startsWith('Total'))!, /0 KiB$/u);
  assert.ok(details.includes('Estimated text: 0 KiB'));
  assert.ok(details.includes('Estimated bookkeeping: 0 KiB'));
});

test('cache screens preserve exact counts in wide and narrow presentations without exposing JSON', () => {
  const snapshot = { ...cacheMenuSample(), footer: layoutMemory(['Footer content']) };
  const before = structuredClone(snapshot);
  for (const width of [96, 36]) {
    const layouts = cacheMenuDetails('cache', snapshot, width), activity = cacheMenuDetails('cacheActivity', snapshot, width);
    const detail = observedCacheLayouts(layouts);
    assert.equal(detail.presentationEntries, 3);
    assert.equal(detail.presentationRows, 3);
    assert.doesNotMatch(layouts.join('\n'), /Cache hits/u);
    assert.ok(Math.abs(detail.presentationRetainedBytes - (snapshot.stats.retainedBytes + snapshot.footer.retainedBytes)) < 0.512,
      'the displayed total is within half of the last decimal of 1.770 KiB');
    assert.equal(detail.footerLayout?.entries, 1);
    assert.ok(layouts.includes('Whole Pi JS heap: 120.6 KiB (not the display cache).'));
    assert.match(layouts.join('\n'), /not the display cache/u);
    assert.equal(observedCacheActivity(activity).builds, 2, 'footer is excluded from every work counter');
    assert.doesNotMatch([...layouts, ...activity].join('\n'), /retainedBytes|\{/u);
  }
  assert.deepEqual(snapshot, before);
});

test('missing cache, inactive cache and unowned footer are not interchangeable with zero', () => {
  assert.match(cacheMenuDetails('cache', undefined, 96).join('\n'), /unavailable/u);
  const snapshot = { ...cacheMenuSample(0), active: false };
  const rows = cacheMenuDetails('cache', snapshot, 96);
  assert.match(rows.join('\n'), /inactive/u);
  assert.equal(observedCacheLayouts(rows).presentationEntries, 0);
  assert.equal(observedCacheLayouts(rows).footerLayout, undefined);
  const footer = { entries: 0, rows: 0, retainedBytes: 0, stringBytes: 0, overheadBytes: 0 };
  assert.deepEqual(observedCacheLayouts(cacheMenuDetails('cache', { ...snapshot, footer }, 96)).footerLayout,
    { entries: 0, rows: 0, retainedBytes: 0 });
});

test('page titles and native keyboard help retain their fixed wording', () => {
  assert.equal(menuPageTitle('root'), 'Tidy UI');
  assert.equal(menuPageTitle('themes'), 'Code color theme');
  assert.equal(menuPageTitle('support'), 'Status & troubleshooting');
  assert.equal(menuPageTitle('service'), 'Highlighting service details');
  assert.equal(menuPageTitle('logs'), 'Diagnostic logs');
  assert.equal(menuPageTitle('cache'), 'Display cache');
  assert.equal(menuPageTitle('cacheActivity'), 'Layout cache activity');
  assert.equal(menuNavigation('root'), '↑↓ Navigate · Enter Select · Esc Close');
  for (const page of ['themes', 'support', 'service', 'logs', 'cache', 'cacheActivity'] as const)
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
