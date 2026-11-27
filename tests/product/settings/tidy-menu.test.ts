import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TidyMenu } from '../../../src/tidy-menu.ts';
import { themeLabels } from '../../../src/application/menu-model.ts';
import type { TidyMenuOwner, TidyMenuSnapshot, TidyMenuAction } from '../../../src/application/menu-contract.ts';
import { DataBudget } from '../../../src/resources/data-budget.ts';
import { SyntaxRuntime } from '../../../src/application/syntax-runtime.ts';
import { THEME_CATALOGUE, THEME_FAMILIES } from '../../../src/themes/catalogue.ts';
import { observePaletteInput } from '../../fixtures/palette-input-observer.mjs';
import { cacheMenuSample } from '../../fixtures/cache-menu-sample.ts';

const colors = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const preference = (id: string, variant?: 'dark' | 'light') => {
  const suffix = /-(dark|light)$/u.exec(id)?.[1] as 'dark' | 'light' | undefined;
  return { kind: 'theme' as const, id: id.replace(/-(?:dark|light)$/u, ''), variant: variant ?? suffix ?? 'dark' };
};
function fixture(width = 70, height = 24, paint = colors) {
  const calls: TidyMenuAction[] = [];
  const previews: TidyMenuSnapshot['selected'][] = [];
  const state: TidyMenuSnapshot = { appearanceEnabled: true, terminalColorsEnabled: true, nativeHighlightingEnabled: true, loggingEnabled: true,
    selected: { kind: 'pi', variant: 'dark' }, appearance: 'Active', terminalColors: 'Following Pi theme', syntax: undefined };
  let prepared = 0, cacheReads = 0, closed = 0, renderRequests = 0;
  let perform: TidyMenuOwner['act'] = async action => {
    calls.push(action);
    if (action.kind === 'switch') state[action.key] = action.value;
    if (action.kind === 'theme') state.selected = action.choice;
    if (action.kind === 'clearCache') return { ok: true, clearedLayouts: 2 };
    return { ok: true };
  };
  const owner: TidyMenuOwner = { snapshot: () => state, readSessionName: () => undefined, prepareThemes: async () => { prepared++; },
    previewTheme(choice) { const copy = structuredClone(choice); previews.push(copy); state.selected = copy; },
    act: action => perform(action), cacheDetails: () => { cacheReads++; return cacheMenuSample(); } };
  const menu = new TidyMenu(owner, paint as any, () => { renderRequests++; }, () => { closed++; }, () => height);
  const render = () => menu.render(width).map(plain);
  const key = async (data: string) => { menu.handleInput(data); await turn(); render(); };
  const select = async (label: string) => {
    let direction = '\x1b[B';
    for (let i = 0; i < 100; i++) {
      if (render().some(row => /^│?→ /u.test(row) && row.includes(label))) { await key('\r'); return; }
      const before = render().find(row => row.includes('→ '));
      await key(direction);
      if (render().find(row => row.includes('→ ')) === before) direction = '\x1b[A';
    }
    assert.fail(`Missing selected item ${label}: ${render().join('\n')}`);
  };
  return { menu, owner, state, calls, previews, render, key, select, get closed() { return closed; },
    get prepared() { return prepared; }, get cacheReads() { return cacheReads; }, get renderRequests() { return renderRequests; },
    set perform(next: typeof perform) { perform = next; } };
}

test('menu root exposes ordinary appearance choices only; first Enter navigates, never toggles', async () => {
  const f = fixture();
  assert.match(f.render().join('\n'), /Tidy UI appearance.*On/);
  assert.match(f.render().join('\n'), /Code color theme.*Follow Pi/);
  assert.match(f.render().join('\n'), /Set terminal colors from Pi theme.*On/);
  assert.doesNotMatch(f.render().join('\n'), /cache|Diagnostic logs|Occipital|shared|owned/i);
  await f.key('\r'); assert.equal(f.prepared, 1); assert.equal(f.calls.length, 0);
  assert.match(f.render().join('\n'), /Follow Pi theme/);
  await f.key('\x1b'); assert.match(f.render().join('\n'), /Tidy UI appearance/);
  assert.equal(f.cacheReads, 0);
});

test('terminal-color setting describes applying Pi defaults independently of effective status', async () => {
  const f = fixture();
  f.state.terminalColors = 'Automatic Pi theme: native control';
  f.render(); await f.key('\x1b[B');
  assert.match(f.render().join('\n'), /→ Set terminal colors from Pi theme\s+On/u);
  const help = helpRows(f.menu.render(f.menu.preferredWidth()).map(plain))[0]!;
  assert.match(help, /Pi colors for terminal background and text/u);
  assert.equal(f.calls.length, 0, 'reading the preference does not apply colors');
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'terminalColorsEnabled', value: false }]);
  assert.equal(f.state.appearanceEnabled, true);
  assert.equal(f.state.nativeHighlightingEnabled, true);
  await f.select('Status & troubleshooting');
  assert.match(f.render().join('\n'), /Terminal colors: Automatic Pi theme: native control/u);
});

test('master off changes appearance without closing the root or disabling logs; navigation retains selection', async () => {
  const f = fixture(); await f.select('Tidy UI appearance');
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'appearanceEnabled', value: false }]);
  assert.equal(f.closed, 0); assert.equal(f.state.loggingEnabled, true);
  assert.match(f.render().join('\n'), /Tidy UI appearance.*Off/);
  await f.select('Status & troubleshooting'); assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0);
  await f.key('\x1b'); assert.ok(f.render().some(row => row.includes('→ Status & troubleshooting')));
});

test('cache and log operations are behind support and remain explicit, not status-reading side effects', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  await f.select('Display cache'); assert.equal(f.cacheReads, 1);
  await f.select('Clear saved layouts'); assert.deepEqual(f.calls, [{ kind: 'clearCache' }]);
  assert.equal(f.cacheReads, 1, 'clear does not sample counters to infer its result');
  await f.key('\x1b'); await f.select('Diagnostic logs');
  await f.select('Write state snapshot'); assert.equal(f.calls.at(-1)?.kind, 'snapshotLogs');
});

test('troubleshooting polls only while open and repaints only when its own status or choices change', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(98, 36); let reads = 0, nameReads = 0;
  t.after(() => f.menu.dispose());
  f.owner.snapshot = () => { reads++; return f.state; };
  f.owner.readSessionName = () => { nameReads++; return 'Current name'; };
  await f.select('Status & troubleshooting');
  const selected = () => f.render().find(row => row.startsWith('│→'));
  assert.doesNotMatch(f.render().join('\n'), /Refresh status/u);
  await f.key('\x1b[B'); const current = selected();
  let requests = f.renderRequests, before = reads;
  f.state.appearance = 'Changed appearance';
  t.mock.timers.tick(999); assert.equal(reads, before); assert.equal(f.renderRequests, requests);
  t.mock.timers.tick(1); assert.equal(reads, before + 1); assert.equal(f.renderRequests, ++requests);
  assert.match(f.render().join('\n'), /Appearance: Changed appearance/u);
  assert.equal(selected(), current, 'live updates do not move selection');
  f.state.loggingEnabled = false;
  t.mock.timers.tick(1000); assert.equal(f.renderRequests, requests, 'a change confined to another page needs no repaint');
  f.state.nativeHighlightingEnabled = false;
  t.mock.timers.tick(1000); assert.equal(f.renderRequests, ++requests);
  assert.match(f.render().join('\n'), /Use Occipital highlighting\s+Off/u);
  await f.select('Diagnostic logs'); assert.equal(nameReads, 1);
  assert.doesNotMatch(f.render().join('\n'), /Refresh status/u);
  requests = f.renderRequests; before = reads;
  f.state.appearance = 'Not shown in logs';
  t.mock.timers.tick(2000);
  assert.equal(reads, before + 2, 'only one timer samples the open logs page');
  assert.equal(f.renderRequests, requests, 'unrelated appearance changes do not repaint logs');
  assert.equal(nameReads, 1, 'polling does not search Pi session history');
  f.state.loggingEnabled = true;
  t.mock.timers.tick(1000); assert.equal(f.renderRequests, ++requests);
  assert.match(f.render().join('\n'), /Record diagnostic logs\s+On/u);
  f.state.appearance = 'Changed appearance';
  await f.key('\x1b'); assert.match(f.render().join('\n'), /Appearance: Changed appearance/u);
  before = reads; t.mock.timers.tick(1000); assert.equal(reads, before + 1, 'Back resumes just one timer');
  await f.key('\x1b'); before = reads; t.mock.timers.tick(2000); assert.equal(reads, before, 'root has no timer');
  await f.select('Status & troubleshooting'); await f.select('Diagnostic logs'); f.menu.close();
  before = reads; t.mock.timers.tick(2000); assert.equal(reads, before, 'closing logs stops sampling');
  assert.deepEqual(f.calls, []); assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0);
});

for (const first of ['Display cache', 'Layout cache activity']) test(`only visible cache pages read their own live statistics: ${first}`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(98, 36); let live = 2, reads = 0;
  t.after(() => f.menu.dispose());
  const other = first === 'Display cache' ? 'Layout cache activity' : 'Display cache';
  const check = (page: string, count: number) => {
    const screen = f.render().join('\n');
    assert.equal(f.render()[1]!.slice(1, -1).trim(), page);
    assert.match(screen, new RegExp(page === 'Display cache' ? `Total\\s+${count}\\s+${count}\\s+` : `Layouts built\\s+${count}\\s+0\\s+${count}`, 'u'));
    assert.equal(/Clear saved layouts/u.test(screen), page === 'Display cache');
    assert.doesNotMatch(screen, /Refresh statistics/u);
    assert.equal(f.menu.preferredWidth(), 98);
  };
  f.owner.cacheDetails = () => { reads++; return cacheMenuSample(live); };
  await f.select('Status & troubleshooting'); t.mock.timers.tick(1000);
  assert.equal(reads, 0, 'status does not sample the cache');
  await f.select(first); check(first, 2); assert.equal(reads, 1);
  live = 7;
  await f.key('\x1b[6~'); t.mock.timers.tick(999);
  check(first, 2); assert.equal(reads, 1);
  t.mock.timers.tick(1); check(first, 7); assert.equal(reads, 2);
  const paints = f.renderRequests;
  t.mock.timers.tick(1000); assert.equal(reads, 3); assert.equal(f.renderRequests, paints, 'equal values need no repaint');
  await f.select('Back');
  assert.equal(f.render()[1]!.slice(1, -1).trim(), 'Status & troubleshooting');
  t.mock.timers.tick(3000); assert.equal(reads, 3, 'Back stops sampling');
  live = 3; await f.select(other); check(other, 3); assert.equal(reads, 4);
  live = 8; t.mock.timers.tick(1000); check(other, 8); assert.equal(reads, 5);
  f.menu.close(); t.mock.timers.tick(3000); assert.equal(reads, 5, 'close stops sampling');
});

test('unavailable cache recovers from a new live sample', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(98, 36); let reads = 0;
  t.after(() => f.menu.dispose());
  f.owner.cacheDetails = () => ++reads === 2 ? cacheMenuSample(4) : undefined;
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  assert.match(f.render().join('\n'), /Display cache unavailable/u);
  t.mock.timers.tick(1000);
  assert.match(f.render().join('\n'), /Total\s+4\s+4/u);
  await f.key('\x1b'); await f.select('Layout cache activity');
  assert.match(f.render().join('\n'), /Layout cache activity unavailable/u);
  assert.equal(reads, 3);
});

test('clear result remains visible as both pages show rebuilt layouts', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(98, 36); let layouts = 2;
  t.after(() => f.menu.dispose());
  f.owner.cacheDetails = () => cacheMenuSample(layouts);
  f.perform = async () => {
    const clearedLayouts = layouts; layouts = 0;
    queueMicrotask(() => { layouts = 3; });
    return { ok: true, clearedLayouts };
  };
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  const height = f.render().length;
  await f.select('Clear saved layouts');
  t.mock.timers.tick(1000);
  assert.match(f.render().join('\n'), /Total\s+3\s+3/u);
  assert.equal(helpRows(f.render())[0], 'Cleared 2 layouts.');
  assert.equal(f.render().length, height, 'success reuses the hint row');
  await f.key('\x1b'); await f.select('Layout cache activity');
  assert.match(f.render().join('\n'), /Layouts built\s+3\s+0\s+3/u);
  assert.equal(helpRows(f.render())[0], 'Cleared 2 layouts.');
  await f.key('\x1b'); await f.select('Display cache');
  f.perform = async () => ({ ok: true, clearedLayouts: 0 });
  await f.select('Clear saved layouts');
  assert.equal(helpRows(f.render())[0], 'No saved layouts to clear.');
});

test('inline failure is bounded and remains visible after the operation; no raw error text', async () => {
  const f = fixture(); f.perform = async () => { throw new Error('PRIVATE_URL_TOKEN'); };
  await f.select('Set terminal colors from Pi theme');
  assert.match(f.render().join('\n'), /could not be completed/i);
  assert.doesNotMatch(f.render().join('\n'), /PRIVATE_URL_TOKEN/);
});

test('menu close: Enter on Close retires the popup during delegated input', async () => {
  const f = fixture(); f.render();
  for (let i = 0; i < 3; i++) await f.key('\x1b[B');
  assert.ok(f.render().some(row => row.includes('→ Close')));
  const requests = f.renderRequests;

  f.menu.handleInput('\r');

  assert.equal(f.closed, 1);
  assert.deepEqual(f.render(), []);
  assert.equal(f.renderRequests, requests, 'a completed input must not request another popup render');
  assert.equal(f.calls.length, 0); assert.equal(f.previews.length, 0);
  f.menu.handleInput('\r'); f.menu.handleInput('\x1b[B'); f.menu.close(); f.menu.dispose();
  assert.equal(f.closed, 1); assert.equal(f.renderRequests, requests);
});

test('menu close: mouse confirmation retires the popup during delegated input', () => {
  const f = fixture(), rows = f.render(), y = rows.findIndex(row => row.includes('Close'));
  assert.ok(y >= 0);
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' });
  assert.equal(f.closed, 0, 'pressing alone does not confirm Close');
  const requests = f.renderRequests;

  assert.equal(f.menu.handleMouse({ ...event, type: 'click' })?.handled, true);

  assert.equal(f.closed, 1);
  assert.deepEqual(f.render(), []);
  assert.equal(f.renderRequests, requests, 'a completed click must not request another popup render');
  assert.equal(f.calls.length, 0); assert.equal(f.previews.length, 0);
  assert.equal(f.menu.handleMouse({ ...event, type: 'click' }), undefined);
  f.menu.close(); f.menu.dispose();
  assert.equal(f.closed, 1); assert.equal(f.renderRequests, requests);
});

test('closing pending menu work ignores late completion and input', async () => {
  const f = fixture(); let settle!: (value: { ok: true }) => void;
  f.perform = () => new Promise(resolve => { settle = resolve; });
  await f.select('Set terminal colors from Pi theme'); await f.key('\x1b');
  assert.equal(f.closed, 1); settle({ ok: true }); await turn();
  await f.key('\r'); assert.equal(f.closed, 1); assert.equal(f.calls.length, 0);
});

for (const [width, height] of [[70, 24], [24, 12], [24, 5], [24, 2], [24, 1], [1, 1]]) test(`menu is bounded and navigable at ${width}x${height}`, async () => {
  const f = fixture(width, height);
  for (let i = 0; i < 12; i++) {
    const rows = f.render(); assert.ok(rows.length <= height);
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    await f.key('\x1b[B');
  }
  await f.key('\x1b'); assert.equal(f.closed, 1);
});

test('the fixed local palette catalogue has unique safe labels and exact stable IDs', () => {
  const labels = themeLabels(THEME_FAMILIES);
  assert.equal(labels.length, 32); assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every(label => !/[\n\x1b\p{Cc}\p{Cs}]/u.test(label)));
  assert.equal(THEME_CATALOGUE.find(theme => theme.id === 'gruvbox-dark')?.label, 'Gruvbox Dark');
});

function native(f: ReturnType<typeof fixture>, _count?: number) {
  f.state.syntax = { enabled: true, standaloneVersion: 'test', selected: f.state.selected,
    provider: { availability: 'ready', reason: 'ready', generation: 1, initialShared: false, kind: 'owned',
      description: { backend_version: 'test' } as any } };
  return THEME_FAMILIES;
}

for (const [width, height] of [[70, 24], [24, 12], [24, 5], [24, 2], [24, 1]]) test(`local theme catalogue: all ${THEME_FAMILIES.length} families are reachable at ${width}x${height}`, async () => {
  const f = fixture(width, height); const themes = native(f);
  f.render(); await f.key('\r');
  for (let i = 0; i < themes.length; i++) {
    await f.key('\x1b[B');
    const rows = f.render();
    const choice = { kind: 'theme' as const, id: themes[i]!.id, variant: 'dark' as const };
    assert.deepEqual(f.state.selected, choice, `choice ${themes[i]!.id} is selected through the public input path`);
    assert.deepEqual(f.previews.at(-1), choice, `choice ${themes[i]!.id} is previewed through its selection callback`);
    assert.ok(rows.some(row => row.includes('→') || row.includes('›')), 'the active selection remains visible');
    assert.ok(rows.length <= height); assert.ok(rows.every(row => visibleWidth(row) <= width));
  }
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: themes.at(-1)!.id, variant: 'dark' } }]);
  const rows = f.render();
  assert.ok(rows.some(row => /^│?→ Code colo.*› {2}│?$/u.test(row)), `confirmation returns to the main page with its theme entry selected: ${rows.join('\n')}`);
});

test('a wrapped theme selection still ends with a blank row before search', async () => {
  const f = fixture(24, 12);
  f.state.selected = preference('synthwave84-dark'); native(f);
  f.render(); await f.key('\r');
  const content = f.render().filter(row => row.startsWith('│')).map(row => row.slice(1, -1).trimEnd());
  const selected = content.findIndex(row => row.startsWith('Selected: '));
  const search = content.findIndex(row => row.startsWith('Search:'));
  assert.ok(selected >= 0 && search > selected);
  assert.equal(content[search - 1], '', 'the blank follows the last wrapped row');
  const selection = content.slice(selected, search - 1);
  assert.ok(selection.length > 1, 'the fixture forces the selected label to wrap');
  assert.equal(selection.join(' '), "Selected: Synthwave '84");
  assert.ok(content.some(row => row.startsWith('→ ')), 'the list still has a selectable row');
});

test('a ten-row theme picker keeps its warning and list position visible', async () => {
  const f = fixture(100, 10);
  f.state.selected = preference('github-dark'); f.state.nativeHighlightingEnabled = false;
  f.render(); await f.key('\r');
  const rows = f.menu.render(Math.min(100, f.menu.preferredWidth())).map(plain);
  assert.match(rows.join('\n'), /Local palette colors remain active/u);
  assert.ok(rows.some(row => /\(\d+\/\d+\)/u.test(row)), 'the scrolling list retains its position indicator');
});

test('theme picker previews a local stable ID, then restores its entry choice without saving', async () => {
  const f = fixture(); native(f); f.state.selected = preference('gruvbox-dark');
  f.render(); await f.key('\r');
  await f.key('solarized');
  assert.ok(f.render().some(row => row.includes('→ Solarized')));
  assert.deepEqual(f.state.selected, preference('solarized-dark'));
  assert.deepEqual(f.previews, [preference('solarized-dark')]);
  assert.equal(f.calls.length, 0);
  await f.key('\x1b'); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.state.selected, preference('gruvbox-dark'));
});

test('menu-only local theme preview does not prepare or read an asset until selected card input is requested', async () => {
  const f = fixture(); native(f);
  let providerStarts = 0;
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.1.0-test', initialTheme: { kind: 'pi', variant: 'dark' },
    provider: { tryShared: async () => { providerStarts++; return undefined; }, acquireOwned: async () => { providerStarts++; throw Error('unexpected provider'); } } });
  let preparation: Promise<void> | undefined;
  f.owner.prepareThemes = () => {
    preparation = runtime.prepareThemes().then(() => { f.state.selected = runtime.snapshot().selected; });
    return preparation;
  };
  f.owner.previewTheme = choice => { runtime.previewTheme(choice); f.state.selected = choice; };
  const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  const leases: NonNullable<ReturnType<SyntaxRuntime['preparePaletteInput']>>[] = [];
  const observed = observePaletteInput('solarized-dark');
  try {
    f.render();
    await f.key('\r'); assert.ok(preparation); await preparation;
    f.render();
    await f.key('solarized');
    assert.deepEqual(runtime.snapshot().selected, preference('solarized-dark'));
    assert.deepEqual(observed.snapshot(), { opens: 0, reads: 0, ownerLookups: 0 });
    assert.equal(providerStarts, 0);
    assert.equal(runtime.sourceStatistics.stats().sourceRecords, 0); assert.equal(runtime.sourceStatistics.stats().dispatches, 0);

    const palette = runtime.snapshot().effective; assert.ok(palette);
    const revision = runtime.palette({ colors: {} });
    const first = runtime.preparePaletteInput(palette, undefined, revision, 'truecolor', funding); assert.ok(first); leases.push(first);
    const cold = observed.snapshot();
    assert.equal(cold.opens, 1, 'the selected-asset control reaches the package-relative file');
    assert.ok(cold.reads > 0); assert.equal(cold.ownerLookups, 1);

    const warm = runtime.preparePaletteInput(palette, undefined, revision, 'truecolor', funding); assert.ok(warm); leases.push(warm);
    assert.deepEqual(observed.snapshot(), { opens: cold.opens, reads: cold.reads, ownerLookups: cold.ownerLookups + 1 },
      'a warm owner lookup reuses the compiled store without reopening or rereading its asset');
    assert.equal(providerStarts, 0);
    assert.equal(runtime.sourceStatistics.stats().sourceRecords, 0); assert.equal(runtime.sourceStatistics.stats().dispatches, 0);
  } finally {
    for (const lease of leases) lease.dispose();
    observed.restore();
    await runtime.dispose();
  }
  assert.equal(budget.stats().retainedBytes, 0);
});

for (const availability of ['disabled', 'initializing', 'transitioning', 'unavailable', 'disposed'] as const)
  test(`theme picker ${availability}: local palettes remain available without helper catalogue access`, async () => {
    const f = fixture(); native(f); f.state.syntax!.provider.availability = availability;
    f.render(); await f.key('\r'); assert.match(f.render().join('\n'), /Aura/);
    await f.select('Solarized'); assert.deepEqual(f.calls, [{ kind: 'theme', choice: preference('solarized-dark') }]);
    assert.equal(f.prepared, 1, 'only the local selection boundary is prepared');
  });

test('helper-off and appearance-off do not hide locally owned palettes', async () => {
  for (const key of ['nativeHighlightingEnabled', 'appearanceEnabled'] as const) {
    const f = fixture(); native(f); f.state[key] = false; f.render(); await f.key('\r');
    assert.match(f.render().join('\n'), /Aura/); assert.equal(f.calls.length, 0);
  }
});

test('public mouse hover has no action, click changes only the clicked preference, and borders do nothing', async () => {
  const f = fixture(); const rows = f.render();
  const y = rows.findIndex(row => row.includes('Tidy UI appearance'));
  const event = { type: 'move' as const, button: 'left' as const, x: 4, y, screenX: 4, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse(event); assert.equal(f.calls.length, 0);
  f.menu.handleMouse({ ...event, type: 'click', y: 0 }); assert.equal(f.calls.length, 0);
  for (const x of [0, 69]) {
    f.menu.handleMouse({ ...event, x, type: 'press' });
    f.menu.handleMouse({ ...event, x, type: 'click' });
  }
  assert.equal(f.calls.length, 0, 'neither vertical frame can change a preference');
  f.menu.handleMouse({ ...event, type: 'press' }); f.render();
  f.menu.handleMouse({ ...event, type: 'click' }); await turn(); f.render();
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'appearanceEnabled', value: false }]);
});

test('fixed palette IDs remain separate from navigation and action values', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  await f.select('Synthwave \'84');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: preference('synthwave84-dark') }]);
  assert.equal(f.closed, 0);
});

test('status does not prepare themes, read cache, or claim a protocol for an absent provider', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  await f.select('Highlighting service details');
  assert.match(f.render().join('\n'), /Protocol: unavailable/);
  assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0); assert.equal(f.calls.length, 0);
});

test('service details report negotiated protocol 3 without acquiring a provider', async () => {
  const f = fixture(); native(f);
  await f.select('Status & troubleshooting'); await f.select('Highlighting service details');
  assert.match(f.render().join('\n'), /Protocol: 4/u);
  assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0); assert.equal(f.calls.length, 0);
});

test('theme search filters by local ID; confirmation saves once and returns to root', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  await f.key('solarized');
  assert.ok(f.render().some(row => row.includes('→ Solarized')));
  assert.equal(f.calls.length, 0);
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: preference('solarized-dark') }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
});

test('theme mouse confirmation returns to the main page and saves the clicked local identity', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  const rows = f.render(), y = rows.findIndex(row => row.includes('Aura'));
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' }); f.render();
  assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' }); assert.equal(f.previews.length, 0); assert.equal(f.calls.length, 0);
  f.menu.handleMouse({ ...event, type: 'click' }); await turn();
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: preference('aura-dark') }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
  assert.equal(f.closed, 0);
});

for (const rebuild of [false, true]) test(`theme press at a recentered divider ${rebuild ? 'cannot outlive a rebuilt list' : 'keeps its original item'}`, async () => {
  const f = fixture(70, 16); native(f); f.render(); await f.key('\r');
  for (let i = 0; i < THEME_FAMILIES.length - 1; i++) await f.key('\x1b[B');
  const family = THEME_FAMILIES.at(-1)!;
  const before = f.render();
  const y = before.findIndex(row => row.includes(family.label));
  assert.ok(y >= 0 && !before.some(row => /^│\s*Back\s*│$/u.test(row)), 'the last family is in view but Back is not');
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y, width: 70, height: before.length, shift: false, alt: false, ctrl: false };
  assert.equal(f.menu.handleMouse({ ...event, type: 'press' })?.handled, true);
  assert.match(f.render()[y]!, /^│  ─+  │$/u, 'recentering places the divider above Back at the press coordinates');
  assert.equal(f.calls.length, 0);
  if (rebuild) {
    f.menu.invalidate();
    assert.match(f.render()[y]!, /^│  ─+  │$/u, 'the rebuilt layout has the same divider');
    assert.equal(f.menu.handleMouse({ ...event, type: 'click' }), undefined);
    await turn();
    assert.equal(f.calls.length, 0, 'a click on decoration cannot reuse a retired list press');
    return;
  }
  assert.equal(f.menu.handleMouse({ ...event, type: 'click' })?.handled, true);
  await turn();
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: family.id, variant: 'dark' } }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
});

test('Follow Pi remains a separate option from the fixed local palette catalogue', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  assert.match(f.render().join('\n'), /Follow Pi theme/); assert.match(f.render().join('\n'), /Aura/);
  assert.equal(THEME_CATALOGUE.some(theme => theme.id === 'pi'), false);
});

for (const height of [5, 6]) for (const page of ['cache', 'logs'])
  test(`all ${page} details and Back stay accessible at 24x${height}`, async () => {
    const f = fixture(24, height), markers = page === 'cache' ? ['Compact tool summaries', 'Bash cards', 'Read cards',
      'Edit cards', 'Write cards', 'User messages', 'Queued messages', 'Tidy UI footer:']
      : ['JOURNAL_PATH_MARKER', 'INDEX_PATH_MARKER', 'SESSION_ID_MARKER', 'RUN_MARKER', 'NAME_MARKER', 'FAILURE_MARKER'];
    if (page === 'logs') f.owner.readSessionName = () => markers[4];
    f.state.logs = { capture: true, state: 'failed', path: markers[0], commonPath: markers[1], session: markers[2],
      run: markers[3], name: 'Journal-only name', failure: markers[5], records: 1, writes: 2, dropped: 0, writeErrors: 0 } as any;
    f.render(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r');
    for (let i = 0; i < (page === 'cache' ? 5 : 4); i++) await f.key('\x1b[B');
    await f.key('\r');
    const painted = [];
    for (let i = 0; i < 64; i++) {
      const rows = f.render(); assert.ok(rows.length <= height); assert.ok(rows.every(row => visibleWidth(row) <= 24));
      painted.push(...rows); await f.key('\x1b[6~');
    }
    for (const marker of markers) assert.ok(painted.some(row => row.includes(marker)), `detail is reachable: ${marker}`);
    assert.equal(f.calls.length, 0, 'scrolling only reads details');
    if (page === 'cache') { await f.key('\x1b[B'); await f.key('\r'); }
    else { for (let i = 0; i < 4; i++) await f.key('\x1b[B'); await f.key('\r'); }
    assert.ok(f.render().some(row => row.includes('Appearance: Active')), 'Back returns to support');
  });

function helpRows(rows: string[]): string[] {
  const divider = rows.findLastIndex(row => /^├─+┤$/u.test(row));
  const body = divider < 0 ? rows : rows.slice(0, divider).map(row => row.startsWith('│') ? row.slice(1, -1).trimEnd() : row);
  assert.equal(body.at(-2)?.trim(), '', 'one blank row precedes the reserved help');
  return body.slice(-1).map(row => row.trimEnd());
}

test('header and navigation occupy their own separated sections on every page', async () => {
  const f = fixture();
  const check = (heading: string) => {
    const rows = f.render(), dividers = rows.flatMap((row, index) => /^├─+┤$/u.test(row) ? [index] : []);
    assert.equal(rows[1]?.slice(1, -1).trim(), heading);
    assert.deepEqual(dividers, [2, rows.length - 3]);
    assert.match(rows.at(-2)!, /↑↓ Navigate.*Enter Select.*Esc (?:Close|Back)/u);
    if (heading !== 'Code color theme') assert.ok(helpRows(rows)[0]);
  };
  check('Tidy UI');
  await f.select('Code color theme'); check('Code color theme'); await f.key('\x1b');
  await f.select('Status & troubleshooting'); check('Status & troubleshooting');
  for (const page of ['Highlighting service details', 'Diagnostic logs', 'Display cache', 'Layout cache activity']) {
    await f.select(page); check(page); await f.key('\x1b');
  }
});

test('each root item has one short help line at the preferred width', async () => {
  const f = fixture(); f.state.selected = preference('github-dark');
  const descriptions = new Set<string>();
  for (const label of ['Tidy UI appearance', 'Code color theme', 'Code color variant', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close']) {
    if (label === 'Tidy UI appearance') { f.render(); await f.key('\x1b[A'); }
    else await f.key('\x1b[B');
    const rows = f.menu.render(f.menu.preferredWidth()).map(plain);
    assert.ok(rows.some(row => row.startsWith(`│→ ${label}`)), label);
    const [help] = helpRows(rows);
    assert.ok(help && !help.endsWith('…'), `full one-line help for ${label}`);
    descriptions.add(help);
  }
  assert.equal(descriptions.size, 6);
  assert.equal(f.calls.length, 0);
});

test('new pages describe their initially selected item before any selection movement', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  assert.match(helpRows(f.render()).join(' '), /Retry styling/u);
  await f.select('Display cache');
  assert.match(helpRows(f.render()).join(' '), /Clear only display layouts/u);
});

test('action outcomes replace only the help line and use the Pi success and error colors', async () => {
  const ink = new Map<string, string>();
  const f = fixture(70, 24, { ...colors, fg: (role, text) => { ink.set(text, role); return text; } });
  const line = () => helpRows(f.render())[0]!;
  let finish!: (value: { ok: true }) => void;
  f.perform = () => new Promise(resolve => { finish = resolve; });
  f.render(); await f.key('\x1b[B');
  const hint = line(), height = f.render().length;
  await f.key('\r'); assert.equal(line(), hint, 'pending work does not replace the hint');
  finish({ ok: true }); await turn();
  assert.equal(line(), 'Done.'); assert.equal(ink.get('Done.'), 'success');
  assert.equal(f.render().length, height);
  await f.key('\x1b[B'); assert.match(line(), /troubleshoot/u);
  await f.key('\x1b[A'); assert.equal(line(), hint, 'returning does not restore the obsolete result');
  f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.key('\r'); assert.equal(line(), 'SAVE_FAILURE'); assert.equal(ink.get('SAVE_FAILURE'), 'error');
  assert.equal(f.render().length, height);
  const rows = f.render(), y = rows.findIndex(row => row.includes('→ Set terminal colors'));
  assert.ok(y >= 0);
  f.menu.handleMouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false });
  assert.match(line(), /troubleshoot/u, 'mouse wheel navigation also resets the result');
  await f.key('\x1b[A'); await f.key('\r'); assert.equal(line(), 'SAVE_FAILURE');
  const current = f.render(), supportY = current.findIndex(row => row.includes('  Status & troubleshooting'));
  assert.ok(supportY >= 0);
  f.menu.handleMouse({ type: 'press', button: 'left', x: 4, y: supportY, screenX: 4, screenY: supportY,
    width: 70, height: current.length, shift: false, alt: false, ctrl: false });
  assert.match(line(), /troubleshoot/u, 'a press that changes selection clears the result before click');
});

test('a delayed action cannot show its result after navigation away and back', async () => {
  const f = fixture(); let finish!: () => void;
  f.perform = () => new Promise(resolve => { finish = () => resolve({ ok: true }); });
  f.render(); await f.key('\x1b[B');
  const hint = helpRows(f.render())[0];
  await f.key('\r'); await f.key('\x1b[B'); await f.key('\x1b[A');
  finish(); await turn();
  assert.equal(helpRows(f.render())[0], hint);
});

test('the clear result stays visible after moving onto Back', async () => {
  const f = fixture();
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  let complete!: () => void;
  f.perform = () => new Promise(resolve => { complete = () => resolve({ ok: true, clearedLayouts: 1 }); });
  await f.select('Clear saved layouts'); await f.key('\x1b[B');
  complete(); await turn();
  assert.equal(helpRows(f.render())[0], 'Cleared 1 layout.');
});

for (const leaveVisit of [false, true]) test(`a delayed clear ${leaveVisit ? 'does not affect the next visit' : 'reaches the peer after Escape'}`, async () => {
  const f = fixture(98, 36); let reads = 0;
  f.owner.cacheDetails = () => cacheMenuSample(++reads);
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  let complete!: () => void;
  f.perform = () => new Promise(resolve => { complete = () => resolve({ ok: true, clearedLayouts: 1 }); });
  await f.select('Clear saved layouts'); await f.key('\x1b');
  if (leaveVisit) await f.key('\x1b');
  complete(); await turn();
  assert.doesNotMatch(f.render().join('\n'), /Done\./u, 'the result does not replace the new page hint');
  if (leaveVisit) await f.select('Status & troubleshooting');
  await f.select('Layout cache activity');
  assert.match(f.render().join('\n'), /Layouts built\s+2\s+0\s+2/u);
  assert.equal(helpRows(f.render())[0], leaveVisit ? 'Return to the previous page.' : 'Cleared 1 layout.');
  assert.equal(reads, 2);
});

test('the last clear result is still visible while paging live statistics', async () => {
  const f = fixture(70, 16);
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  await f.select('Clear saved layouts');
  const line = () => helpRows(f.render())[0];
  assert.equal(line(), 'Cleared 2 layouts.');
  await f.key('\x1b[5~'); assert.equal(line(), 'Cleared 2 layouts.');
  await f.key('\x1b[6~'); assert.equal(line(), 'Cleared 2 layouts.');
  assert.doesNotMatch(f.render().join('\n'), /Type\s+Layouts\s+Rows\s+Est\. size/u, 'the viewport moved past the first detail');
});

test('clicking separators, description, blank row or navigation cannot activate a setting', () => {
  const f = fixture(), rows = f.render();
  const positions = [2, 3, rows.length - 5, rows.length - 4, rows.length - 3, rows.length - 2];
  for (const y of positions) for (const type of ['press', 'click'] as const) f.menu.handleMouse({
    type, button: 'left', x: 4, y, screenX: 4, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false,
  });
  assert.equal(f.calls.length, 0);
  assert.ok(f.render().some(row => row.includes('→ Code color theme')));
});

test('description slots survive every short-height transition without clipping list or navigation', async () => {
  for (let height = 4; height <= 16; height++) {
    const f = fixture(24, height);
    const check = () => {
      const rows = f.render(); assert.ok(rows.length <= height, `height ${height}`);
      assert.ok(rows.every(row => visibleWidth(row) <= 24));
      assert.ok(helpRows(rows)[0]);
      assert.ok(rows.some(row => row.includes('→ ')), `the selected item stays visible at height ${height}`);
    };
    check(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r'); check();
    await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r'); check();
    await f.key('\x1b'); check();
    assert.equal(f.calls.length, 0);
  }
});

for (const height of [10, 11, 12]) test(`root save errors use a single truncated help row at height ${height}`, async () => {
  const f = fixture(24, height);
  f.perform = async action => { f.calls.push(action); return { ok: false, message: 'Not saved. Settings remain applied.' }; };
  f.render(); await f.key('\x1b[B'); await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'terminalColorsEnabled', value: false }]);
  assert.match(helpRows(f.render())[0]!, /^Not saved\..*…$/u);
  assert.ok(f.render().length <= height);
});

for (const page of ['support', 'logs']) test(`short ${page} page drops chrome before losing an action failure`, async () => {
  const f = fixture(70, 11);
  await f.select('Status & troubleshooting');
  if (page === 'logs') await f.select('Diagnostic logs');
  f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.key('\r');
  assert.match(f.render().join('\n'), /SAVE_FAILURE/u);
  assert.ok(helpRows(f.render())[0]);
  assert.ok(f.render().length <= 11);
});

test('a one-row failure retains chrome when all sections still fit', async () => {
  const f = fixture(70, 11); f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.select('Set terminal colors from Pi theme');
  const rows = f.render();
  assert.equal(rows.filter(row => /^├─+┤$/u.test(row)).length, 2);
  assert.match(rows.join('\n'), /SAVE_FAILURE/u);
  assert.ok(helpRows(rows)[0]);
  assert.ok(rows.length <= 11);
});

test('preferred width fits root labels, values and navigation without stretching for descriptions', async () => {
  const f = fixture();
  const width = f.menu.preferredWidth();
  assert.equal(width, 61, 'standard Follow Pi root is 20% wider than its previous 51 columns');
  const rows = f.menu.render(width).map(plain);
  for (const label of ['Tidy UI appearance', 'Code color theme', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close'])
    assert.ok(rows.some(row => row.includes(label)), `complete label: ${label}`);
  assert.match(rows.join('\n'), /↑↓ Navigate · Enter Select · Esc Close/u);
  assert.ok(helpRows(rows)[0]);
  assert.ok(rows.every(row => visibleWidth(row) <= width));
  for (let i = 0; i < 15; i++) {
    await f.key('\x1b[B');
    assert.equal(f.menu.preferredWidth(), width, 'selection and its description do not resize the page');
  }
  f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE '.repeat(100) });
  await f.select('Set terminal colors from Pi theme');
  assert.equal(f.menu.preferredWidth(), width, 'error text wraps instead of widening the page');
  assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0);
});

test('root width still grows with the current theme label but stays bounded', () => {
  const f = fixture();
  f.state.selected = preference('x'.repeat(20));
  assert.equal(f.menu.preferredWidth(), 74, 'a 62-column content fit is scaled and rounded independently');
  f.state.selected = preference('x'.repeat(120));
  assert.equal(f.menu.preferredWidth(), 86, 'the original 72-column ceiling bounds the scaled width');
});

test('theme picker measures the full fixed catalogue, not only visible or searched choices', async () => {
  const f = fixture(); native(f); const root = f.menu.preferredWidth();
  await f.select('Code color theme'); const themes = f.menu.preferredWidth();
  const labelWidth = Math.max(...themeLabels(THEME_FAMILIES).map(visibleWidth));
  const expected = Math.min(72, Math.max(4 + labelWidth + visibleWidth('Selected'),
    visibleWidth('Code color theme'), visibleWidth('↑↓ Navigate · Enter Select · Esc Back')) + 2);
  assert.equal(themes, expected, 'full local palette catalogue determines picker width, even when the root page is wider');
  for (let i = 0; i < 20; i++) { await f.key('\x1b[B'); assert.equal(f.menu.preferredWidth(), themes); }
  await f.key('solarized'); assert.equal(f.menu.preferredWidth(), themes, 'filtering does not shrink the picker');
  assert.ok(f.render().some(row => row.includes('→ Solarized')));
  await f.key('\x1b'); assert.equal(f.menu.preferredWidth(), root);
  assert.equal(f.calls.length, 0, 'measuring/navigating/filtering has no preference action');
});

test('cache detail scrolling does not widen the page or hide paging keys', async () => {
  const f = fixture(70, 16);
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  const width = f.menu.preferredWidth();
  assert.equal(width, 98);
  const rows = f.menu.render(width).map(plain);
  for (const control of ['↑↓', 'Enter', 'Esc Back', 'PgUp/PgDn']) assert.ok(rows.at(-2)!.includes(control), `missing navigation key: ${control}`);
  assert.ok(helpRows(rows)[0]);
  await f.key('\x1b[6~'); assert.equal(f.menu.preferredWidth(), width);
});

test('narrow detail pages keep Back and paging discoverable inside the actual frame', async () => {
  const f = fixture(24, 12);
  f.render(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r');
  for (let i = 0; i < 5; i++) await f.key('\x1b[B');
  await f.key('\r');
  assert.match(f.render().at(-2)!, /Esc Back.*PgUp\/PgDn/u);
  assert.ok(helpRows(f.render())[0]);
  assert.ok(f.render().every(row => visibleWidth(row) <= 24));
});

const rootLabels = ['Tidy UI appearance', 'Code color theme', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close'];
const cellOf = (row: string, text: string) => {
  const index = row.indexOf(text); assert.ok(index >= 0, `missing ${JSON.stringify(text)} in ${JSON.stringify(row)}`);
  return visibleWidth(row.slice(0, index));
};
function rootRows(f: ReturnType<typeof fixture>, width = f.menu.preferredWidth()) {
  const rows = f.menu.render(width).map(plain);
  return ['Tidy', 'Code colo', 'Set', 'Status', 'Close'].map(label => {
    const row = rows.find(row => /^│[→ ] /u.test(row) && row.slice(3).startsWith(label));
    assert.ok(row, `missing root item ${label}: ${rows.join('\n')}`); return row;
  });
}

test('root reserves common left-aligned values and insets submenu arrows by two cells', async () => {
  const f = fixture(); f.state.appearanceEnabled = false;
  const width = f.menu.preferredWidth(), rows = rootRows(f);
  const valueColumn = cellOf(rows[0]!, 'Off');
  assert.equal(cellOf(rows[1]!, 'Follow Pi'), valueColumn, 'long and short values start in one column');
  assert.equal(cellOf(rows[2]!, 'On'), valueColumn);
  for (let i = 0; i < rootLabels.length; i++) {
    assert.ok(rows[i]!.includes(rootLabels[i]!), 'preferred width fits every label in full');
    assert.ok(cellOf(rows[i]!, rootLabels[i]!) + visibleWidth(rootLabels[i]!) + 2 <= valueColumn,
      'no label enters the value column, including labels on rows with no value');
  }
  const arrow = cellOf(rows[1]!, '›');
  assert.equal(arrow, width - 4); assert.equal(cellOf(rows[3]!, '›'), arrow);
  for (const row of [rows[1]!, rows[3]!]) assert.match(row, /› {2}│$/u);
  assert.ok(valueColumn + visibleWidth('Follow Pi') + 2 <= arrow, 'submenu indicator is not part of the value');
  for (let i = 0; i < 10; i++) { await f.key('\x1b[B'); assert.equal(f.menu.preferredWidth(), width); }
  assert.equal(f.calls.length, 0); assert.equal(f.prepared, 0);
});

for (const width of [24, 30, 40, 45, 72]) test(`shared root columns stay disjoint when clamped to ${width} columns`, () => {
  const f = fixture(); f.state.appearanceEnabled = false;
  const rows = rootRows(f, width), valueColumn = cellOf(rows[0]!, 'Off');
  assert.equal(cellOf(rows[2]!, 'On'), valueColumn);
  const themeValue = rows[1]!.slice(3).split(/ {2,}/u)[1]!;
  assert.ok(themeValue); assert.equal(cellOf(rows[1]!, themeValue), valueColumn);
  for (const row of rows) {
    const label = row.slice(3).split(/ {2,}/u)[0]!.replace(/\s+│$/u, '').trimEnd();
    assert.ok(3 + visibleWidth(label) + 2 <= valueColumn, `label stays outside values: ${row}`);
    assert.ok(visibleWidth(row) <= width);
  }
  for (const row of [rows[1]!, rows[3]!]) assert.match(row, /› {2}│$/u);
});

for (const width of [7, 10, 11]) test(`a ${width}-column menu preserves the label before adding the inset arrow`, async () => {
  const f = fixture(width);
  const rows = f.render(), selected = rows.find(row => /^│?→ /u.test(row))!;
  assert.ok(rows.every(row => visibleWidth(row) <= width));
  assert.match(selected, /^│?→ C/u, 'the highlighted label starts with a real letter, not just an ellipsis');
  if (width < 11) assert.doesNotMatch(selected, /›/u, 'the arrow is omitted if it cannot coexist with a readable label');
  else assert.match(selected, /› {2}│$/u, 'show the arrow as soon as it can fit with the label');
  await f.key('\r');
  assert.equal(f.prepared, 1, 'the highlighted submenu still opens');
});

test('support actions share the toggle label column and a distinct submenu indicator column', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  const width = f.menu.preferredWidth(), rows = f.menu.render(width).map(plain);
  const labels = ['Reapply Tidy UI appearance', 'Reapply terminal colors', 'Use Occipital highlighting', 'Highlighting service details',
    'Diagnostic logs', 'Display cache', 'Layout cache activity', 'Back'];
  const nativeRow = rows.find(row => row.includes('Use Occipital highlighting'))!;
  const valueColumn = cellOf(nativeRow, 'On');
  const submenus = new Set(['Highlighting service details', 'Diagnostic logs', 'Display cache', 'Layout cache activity']);
  for (const label of labels) {
    const row = rows.find(row => /^│[→ ] /u.test(row) && row.includes(label)); assert.ok(row);
    assert.ok(cellOf(row, label) + visibleWidth(label) + 2 <= valueColumn);
    if (submenus.has(label)) assert.match(row, /› {2}│$/u);
    else assert.doesNotMatch(row, /›/u);
  }
});

test('selected marker stays aligned across the full fixed catalogue and filtering', async () => {
  const f = fixture(); native(f); f.state.selected = preference('aura-dark');
  await f.select('Code color theme'); const width = f.menu.preferredWidth();
  const selectedRow = () => f.menu.render(width).map(plain).find(row => /^│[→ ] /u.test(row) && row.includes('Aura'))!;
  const column = cellOf(selectedRow(), 'Selected');
  const longest = Math.max(...themeLabels(THEME_FAMILIES).map(visibleWidth));
  assert.ok(3 + longest + 2 <= column, 'the marker follows the longest static label');
  await f.key('aura');
  assert.equal(f.menu.preferredWidth(), width); assert.equal(cellOf(selectedRow(), 'Selected'), column);
  assert.equal(f.calls.length, 0);
});

test('fixed palette labels and ID searches remain bounded at narrow widths', () => {
  const f = fixture(); native(f);
  const width = f.menu.preferredWidth(); assert.ok(width <= 72);
  for (const columns of [1, 6, 24, 40, 100]) {
    const rows = f.menu.render(Math.min(columns, width)); assert.ok(rows.every(row => visibleWidth(row) <= columns));
  }
  assert.ok(THEME_CATALOGUE.some(theme => theme.label === "Synthwave '84 Dark"));
});


for (const exit of ['escape', 'back', 'ctrl+c', 'close', 'dispose'] as const) {
  test(`theme preview: ${exit} restores the entry theme without persisting or repeating on dispose`, async () => {
    const f = fixture(); native(f, 3);
    f.render(); await f.key('\r');
    assert.equal(f.previews.length, 0, 'opening is not a theme change');
    await f.key('\x1b[B');
    assert.deepEqual(f.state.selected, preference('aura-dark'));
    assert.equal(f.calls.length, 0);
    const before = f.previews.length;
    for (let i = 0; i < 30; i++) f.render();
    assert.equal(f.previews.length, before, 'rendering cannot initiate preview work');
    if (exit === 'escape') await f.key('\x1b');
    else if (exit === 'back') await f.select('Back');
    else if (exit === 'ctrl+c') await f.key('\x03');
    else if (exit === 'close') f.menu.close();
    else f.menu.dispose();
    assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' });
    assert.equal(f.calls.length, 0);
    const restored = f.previews.length;
    f.menu.dispose(); f.menu.dispose();
    assert.equal(f.previews.length, restored, 'rollback is idempotent');
  });
}

test('theme preview: confirming promotes the preview; the next visit has its own rollback point', async () => {
  const f = fixture(); native(f, 3); f.render(); await f.key('\r');
  await f.key('\x1b[B'); await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: preference('aura-dark') }]);
  assert.deepEqual(f.state.selected, preference('aura-dark'));
  const before = f.previews.length;
  await f.key('\r'); assert.equal(f.previews.length, before);
  assert.ok(f.render().some(row => row.includes('→ Aura')));
  await f.key('\x1b[B');
  assert.deepEqual(f.state.selected, preference('ayu-dark'));
  await f.key('\x1b'); f.menu.close();
  assert.deepEqual(f.state.selected, preference('aura-dark'));
  assert.equal(f.calls.length, 1);
});

test('theme preview: closing during confirmed persistence is not rollback and late completion cannot reopen', async () => {
  const f = fixture(); native(f, 3); f.render(); await f.key('\r'); await f.key('\x1b[B');
  let resolve!: (value: { ok: true }) => void;
  f.perform = action => { f.calls.push(action); return new Promise(done => { resolve = done; }); };
  await f.key('\r');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.state.selected, preference('aura-dark'));
  const before = f.previews.length;
  await f.key('\x1b[B'); await f.key('\x03');
  assert.equal(f.closed, 1); assert.equal(f.previews.length, before);
  resolve({ ok: true }); await turn();
  assert.deepEqual(f.state.selected, preference('aura-dark'));
  assert.deepEqual(f.render(), []); assert.equal(f.previews.length, before);
});

test('a delayed theme confirmation returns to the root without a stale result after picker navigation', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r'); await f.key('\x1b[B');
  let complete!: () => void;
  f.perform = () => new Promise(resolve => { complete = () => resolve({ ok: true }); });
  await f.key('\r'); await f.key('\x1b[B');
  complete(); await turn();
  const rows = f.render();
  assert.ok(rows.some(row => row.includes('→ Code color theme')));
  assert.match(helpRows(rows)[0]!, /Choose colors/u);
});

test('theme preview: failed confirmation keeps the live choice and does not silently revert on close', async () => {
  const f = fixture(); native(f, 1); f.render(); await f.key('\r'); await f.key('\x1b[B');
  f.perform = async action => { f.calls.push(action); return { ok: false, message: 'Applied but not saved.' }; };
  await f.key('\r'); assert.match(helpRows(f.render())[0]!, /Applied but not saved/);
  f.menu.close();
  assert.deepEqual(f.state.selected, preference('aura-dark')); assert.equal(f.calls.length, 1);
});

test('an unexpected theme confirmation failure returns to the root with a safe result', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r'); await f.key('\x1b[B');
  f.perform = async () => { throw new Error('PRIVATE_THEME_ERROR'); };
  await f.key('\r');
  const rows = f.render();
  assert.ok(rows.some(row => row.includes('→ Code color theme')));
  assert.match(helpRows(rows)[0]!, /could not be completed/i);
  assert.doesNotMatch(rows.join('\n'), /PRIVATE_THEME_ERROR/u);
});

test('theme preview: empty search results and action rows do not become theme choices', async () => {
  const f = fixture(); native(f, 2); f.render(); await f.key('\r'); await f.key('aura');
  assert.deepEqual(f.state.selected, preference('aura-dark'));
  const before = f.previews.length;
  await f.key('not-a-theme');
  assert.match(f.render().join('\n'), /→ Back/u);
  assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' });
  assert.equal(f.previews.length, before + 1, 'Back-only search clears the active preview');
  await f.key('\x1b[B'); await f.key('\x1b');
  assert.equal(f.previews.length, before + 1, 'staying on or leaving Back does not repeat the rollback');
  assert.equal(f.calls.length, 0);
});

for (const input of ['arrow', 'wheel'] as const) test(`theme preview: ${input} to Back restores the confirmed theme without leaving the picker`, async () => {
  const f = fixture(); f.state.selected = preference('github', 'light');
  await f.select('Code color theme'); await f.key('github');
  const move = async (direction: 1 | -1) => {
    if (input === 'arrow') { await f.key(direction === 1 ? '\x1b[B' : '\x1b[A'); return; }
    const rows = f.render(), y = rows.findIndex(row => row.includes('→ '));
    assert.ok(y >= 0);
    f.menu.handleMouse({ type: 'wheel', button: 'none', wheelDelta: direction, x: 4, y, screenX: 4, screenY: y,
      width: 70, height: rows.length, shift: false, alt: false, ctrl: false });
  };
  // A confirmation from another process is held until the current preview stops.
  const confirmed = { kind: 'pi' as const, variant: 'dark' as const };
  assert.equal(f.menu.preferencesChanged(confirmed), true);
  await move(1);
  assert.match(f.render().join('\n'), /→ Back/u);
  assert.match(f.render().join('\n'), /Selected: Follow Pi/u);
  assert.deepEqual(f.state.selected, confirmed);

  const next = preference('github', 'dark');
  assert.equal(f.menu.preferencesChanged(next), false, 'no local preview hides a confirmation while Back is selected');
  f.state.selected = next; // Apply the external confirmation, as the menu owner does.
  const rows = f.render().join('\n');
  assert.match(rows, /→ Back/u);
  assert.match(rows, /Selected: GitHub/u);
  assert.match(rows, /  GitHub\s+Selected/u, 'the saved family also regains the inline marker');
  await move(-1);
  assert.match(f.render().join('\n'), /→ GitHub/u);
  assert.deepEqual(f.state.selected, next);
  assert.equal(f.calls.length, 0);
});

test('theme preview: loading from a cancelled visit cannot establish a later visit rollback point', async () => {
  const f = fixture(); native(f, 3); const pending: (() => void)[] = [];
  f.owner.prepareThemes = () => new Promise<void>(resolve => { pending.push(resolve); });
  f.render(); await f.key('\r'); await f.key('\x1b');
  f.state.selected = preference('aura-light');
  await f.key('\r'); pending[1]!(); await turn(); f.render();
  await f.key('\x1b[B'); assert.deepEqual(f.state.selected, preference('ayu-light'));
  pending[0]!(); await turn(); f.render();
  await f.key('\x1b'); assert.deepEqual(f.state.selected, preference('aura-light'));
  assert.equal(f.calls.length, 0);
});

test('theme preview: rapid arrow input keeps only the latest selection and cancellation restores the entry choice', async () => {
  const f = fixture(); native(f, 12); f.render(); await f.key('\r');
  for (let i = 0; i < 8; ++i) f.menu.handleInput('\x1b[B');
  assert.deepEqual(f.state.selected, preference('cursor-dark'));
  assert.equal(f.calls.length, 0);
  await f.key('\x1b');
  assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' }); assert.equal(f.calls.length, 0);
});

test('theme preview: native wheel selection previews without confirming or persisting', async () => {
  const f = fixture(); native(f, 4); f.render(); await f.key('\r');
  const rows = f.render(), y = rows.findIndex(row => row.includes('Follow Pi theme'));
  f.menu.handleMouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false });
  assert.deepEqual(f.state.selected, preference('aura-dark')); assert.equal(f.calls.length, 0);
  await f.key('\x1b'); assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' });
});

for (const finish of ['escape', 'confirm'] as const) test(`settings sync: external confirmation preserves local preview until ${finish}`, async () => {
  const f = fixture(); native(f, 3); await f.select('Code color theme'); await f.key('\x1b[B');
  const preview = preference('aura-dark'), external = preference('ayu-dark');
  assert.deepEqual(f.state.selected, preview);
  const change = Reflect.get(f.menu, 'preferencesChanged'); assert.equal(typeof change, 'function');
  assert.equal(change.call(f.menu, external), true, 'host must not apply the external theme over a local preview');
  assert.deepEqual(f.state.selected, preview); assert.equal(f.calls.length, 0);
  await f.key(finish === 'escape' ? '\x1b' : '\r');
  assert.deepEqual(f.state.selected, finish === 'escape' ? external : preview);
  assert.deepEqual(f.calls, finish === 'escape' ? [] : [{ kind: 'theme', choice: preview }]);
});

for (const variant of ['dark', 'light'] as const) for (const finish of ['escape', 'confirm'] as const)
  test(`settings sync: ${variant} picker preview keeps its pair across an opposite-variant publication until ${finish}`, async () => {
    const f = fixture(); f.state.selected = { kind: 'pi', variant }; native(f);
    await f.select('Code color theme'); await f.key('\x1b[B');
    const preview = preference('aura', variant), external = preference('ayu', variant === 'dark' ? 'light' : 'dark');
    assert.deepEqual(f.state.selected, preview);
    const previews = f.previews.length;
    assert.equal(f.menu.preferencesChanged(external), true);
    assert.deepEqual(f.state.selected, preview); assert.equal(f.previews.length, previews); assert.equal(f.calls.length, 0);
    await f.key(finish === 'escape' ? '\x1b' : '\r');
    assert.deepEqual(f.state.selected, finish === 'escape' ? external : preview);
    assert.deepEqual(f.calls, finish === 'escape' ? [] : [{ kind: 'theme', choice: preview }]);
    assert.deepEqual(f.previews.at(-1), finish === 'escape' ? external : preview);
  });

test('runtime health menu: faults remain visible with logging off or unavailable and provider ready', async () => {
  const f = fixture(110, 45); native(f);
  f.state.loggingEnabled = false;
  f.state.health = { errors: 3, active: 2, issues: [{ area: 'syntax', operation: 'source', code: 'invalid_source', time: '2026-10-19T08:22:52.282Z', state: 'active' }],
    last: { area: 'syntax', operation: 'styles', code: 'invalid_header', time: '2026-10-19T08:22:53.282Z', state: 'recovered' } };
  await f.select('Status & troubleshooting'); let text = f.render().join('\n');
  assert.match(text, /Runtime status: Problems detected/); assert.match(text, /Runtime errors: 3; active: 2/);
  assert.match(text, /Unresolved syntax: invalid_source/);
  await f.select('Diagnostic logs'); text = f.render().join('\n');
  assert.match(text, /Runtime errors: 3; active: 2/); assert.match(text, /Diagnostic logging is unavailable/);
  await f.key('\x1b'); await f.select('Highlighting service details'); text = f.render().join('\n');
  assert.match(text, /Service: ready \(ready\)/); assert.match(text, /Protocol: 4/);
  assert.equal(f.prepared, 0); assert.equal(f.calls.length, 0);
});

test('runtime health menu: log write errors and lost records are explicitly distinct from runtime errors', async () => {
  const f = fixture(120, 45);
  f.state.health = { errors: 4, active: 1, issues: [] };
  f.state.logs = { state: 'active', capture: true, records: 39370, writes: 3277, dropped: 1598, writeErrors: 0,
    path: '/tmp/run.log', commonPath: '/tmp/sessions.log', run: 'run', session: 'session' } as NonNullable<TidyMenuSnapshot['logs']>;
  await f.select('Status & troubleshooting'); await f.select('Diagnostic logs');
  const text = f.render().join('\n');
  assert.match(text, /Runtime errors: 4; active: 1/);
  assert.match(text, /Dropped records: 1598; log write errors: 0/);
  assert.match(text, /Some diagnostic records were lost/);
  assert.doesNotMatch(text, /dropped: 1598; errors: 0/);
});


test('theme picker offers families and root variant control follows the confirmed theme pair', async () => {
  const f = fixture(); native(f);
  f.state.selected = preference('github', 'light');
  f.render(); await f.key('\r');
  const picker = f.render().join('\n');
  assert.match(picker, /GitHub/u);
  assert.doesNotMatch(picker, /GitHub (?:Dark|Light)/u);
  assert.match(picker, /Search:/u);
  assert.equal(THEME_CATALOGUE.length, 64, 'family menu changes do not replace concrete asset catalogue');

  await f.key('\x1b');
  await f.select('Code color variant');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'github', variant: 'dark' } }]);
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'github', variant: 'dark' });
});

test('Pi disables root variant choice and keyboard/wheel/pointer cannot select it', async () => {
  const f = fixture();
  const rows = f.render();
  const variantRow = rows.findIndex(row => row.includes('Code color variant'));
  assert.ok(variantRow >= 0, `root exposes variant row: ${rows.join('\n')}`);

  await f.key('\x1b[B');
  assert.ok(f.render().some(row => row.includes('→ Set terminal colors from Pi theme')), 'keyboard skips the disabled row');
  await f.key('\x1b[A');
  f.menu.handleMouse({ type: 'wheel', button: 'left', wheelDelta: 1, x: 4, y: 0, screenX: 4, screenY: 0,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false });
  assert.ok(f.render().some(row => row.includes('→ Set terminal colors from Pi theme')), 'wheel skips the disabled row');

  const event = { button: 'left' as const, x: 4, y: variantRow, screenX: 4, screenY: variantRow,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' }); f.render();
  f.menu.handleMouse({ ...event, type: 'click' }); await turn(); f.render();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'dark' });
});


test('accepted root press survives recentering onto the disabled variant row', async () => {
  const f = fixture(70, 12); f.render();
  await f.key('\x1b[B'); await f.key('\x1b[B');
  assert.ok(f.render().some(row => row.includes('→ Status & troubleshooting')));
  const rows = f.render(), y = rows.findIndex(row => row.includes('Set terminal colors from Pi theme'));
  assert.ok(y >= 0);
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' });
  assert.ok(f.render()[y]?.includes('Code color variant'), 'the native selection recenters before release');
  f.menu.handleMouse({ ...event, type: 'click' }); await turn();
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'terminalColorsEnabled', value: false }]);
  assert.equal(f.state.terminalColorsEnabled, false);
});

for (const variant of ['dark', 'light'] as const) test(`theme family warning matches catalogue membership (${variant})`, async () => {
  const f = fixture(); native(f);
  f.state.selected = { kind: 'theme', id: 'github', variant };
  f.state.syntax!.selected = f.state.selected;
  f.state.syntax!.effective = { kind: 'theme', id: `github-${variant}`, label: `GitHub ${variant}`, fingerprint: `owned-palette-v1:github-${variant}` };
  f.render(); await f.key('\r');
  assert.doesNotMatch(f.render().join('\n'), /saved palette is unknown/u);
});

test('theme family warning retains the actual unknown-family fallback', async () => {
  const f = fixture(); native(f);
  f.state.selected = { kind: 'theme', id: 'not-installed', variant: 'dark' };
  f.state.syntax!.selected = f.state.selected;
  f.state.syntax!.effective = { kind: 'pi', id: 'pi', label: 'Follow Pi', fingerprint: 'pi-palette-v1' };
  f.render(); await f.key('\r');
  assert.match(f.render().join('\n'), /saved palette is unknown/u);
});


test('disabled-origin root press stays inert when an external confirmation enables its row', async () => {
  const f = fixture(), rows = f.render(), y = rows.findIndex(row => row.includes('Code color variant'));
  assert.ok(y >= 0);
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  try {
    f.menu.handleMouse({ ...event, type: 'press' });
    f.state.selected = { kind: 'theme', id: 'github', variant: 'dark' };
    assert.equal(f.menu.preferencesChanged(f.state.selected), false);
    assert.match(f.render()[y]!, /Code color variant\s+Dark/u, 'the external family confirmation rebuilds the now-enabled row');
    f.menu.handleMouse({ ...event, type: 'click' }); await turn();
    assert.equal(f.calls.length, 0, 'release from a disabled-origin press cannot confirm a newly enabled control');
    assert.deepEqual(f.state.selected, { kind: 'theme', id: 'github', variant: 'dark' });
    f.menu.handleMouse({ ...event, type: 'press' }); f.render();
    f.menu.handleMouse({ ...event, type: 'click' }); await turn();
    assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'github', variant: 'light' } }], 'a fresh enabled-origin click still confirms Light');
  } finally { f.menu.dispose(); }
});

for (const [page, path, first, last] of [
  ['root', [], 'Tidy UI appearance', 'Close'],
  ['themes', ['Code color theme'], 'Follow Pi theme', 'Back'],
  ['support', ['Status & troubleshooting'], 'Reapply Tidy UI appearance', 'Back'],
  ['service', ['Status & troubleshooting', 'Highlighting service details'], 'Back', 'Back'],
  ['logs', ['Status & troubleshooting', 'Diagnostic logs'], 'Record diagnostic logs', 'Back'],
  ['cache', ['Status & troubleshooting', 'Display cache'], 'Clear saved layouts', 'Back'],
  ['cacheActivity', ['Status & troubleshooting', 'Layout cache activity'], 'Back', 'Back'],
] as const) test(`keyboard bounds: ${page} stops at both list edges`, async () => {
  const f = fixture();
  try {
    for (const label of path) await f.select(label);
    const selected = () => f.render().find(row => row.includes('→ '))?.split('→ ')[1] ?? '';
    for (let i = 0; i < 100 && !selected().startsWith(first); i++) await f.key('\x1b[A');
    assert.ok(selected().startsWith(first), `first ${page} row is reachable`);
    const calls = f.calls.length, previews = f.previews.length;
    for (let i = 0; i < 3; i++) {
      await f.key('\x1b[A');
      assert.ok(selected().startsWith(first), `Up stays on the first ${page} row`);
    }
    assert.equal(f.previews.length, previews, 'an outward step does not change the theme preview');
    for (let i = 0; i < 100 && !selected().startsWith(last); i++) await f.key('\x1b[B');
    assert.ok(selected().startsWith(last), `last ${page} row is reachable`);
    const endPreviews = f.previews.length;
    for (let i = 0; i < 3; i++) {
      await f.key('\x1b[B');
      assert.ok(selected().startsWith(last), `Down stays on the last ${page} row`);
    }
    assert.equal(f.previews.length, endPreviews);
    assert.equal(f.calls.length, calls, 'navigation neither activates nor saves a preference');
  } finally { f.menu.dispose(); }
});

for (const query of ['github', 'no-matching-family']) test(`keyboard bounds: filtered theme list (${query})`, async () => {
  const f = fixture();
  try {
    await f.select('Code color theme'); await f.key(query);
    const selected = () => f.render().find(row => row.includes('→ '))?.split('→ ')[1] ?? '';
    const first = query === 'github' ? 'GitHub' : 'Back';
    assert.ok(selected().startsWith(first));
    const preview = structuredClone(f.state.selected), count = f.previews.length;
    await f.key('\x1b[A');
    assert.ok(selected().startsWith(first), 'Up respects the filtered first row');
    assert.deepEqual(f.state.selected, preview); assert.equal(f.previews.length, count);
    await f.key('\x1b[B'); assert.ok(selected().startsWith('Back'));
    await f.key('\x1b[B'); assert.ok(selected().startsWith('Back'), 'Down respects filtered Back');
    if (query === 'github') {
      await f.key('\x1b[A'); assert.ok(selected().startsWith('GitHub'), 'inward navigation still works');
    }
    assert.equal(f.calls.length, 0);
  } finally { f.menu.dispose(); }
});


test('switch activation uses the current preference, not the last rendered On/Off value', async () => {
  for (const key of ['terminalColorsEnabled', 'nativeHighlightingEnabled'] as const) {
    const f = fixture();
    f.render();
    if (key === 'terminalColorsEnabled') await f.key('\x1b[B');
    else {
      await f.select('Status & troubleshooting');
      await f.key('\x1b[B'); await f.key('\x1b[B');
    }
    const label = key === 'terminalColorsEnabled' ? 'Set terminal colors from Pi theme' : 'Use Occipital highlighting';
    assert.ok(f.render().some(row => row.includes('→ ') && row.includes(label)));
    f.state[key] = false;
    f.menu.handleInput('\r');
    await turn();
    assert.deepEqual(f.calls, [{ kind: 'switch', key, value: true }]);
    assert.equal(f.state[key], true);
    f.menu.dispose();
  }
});

test('root variant activation uses the current confirmed family and variant without requiring a frame', async () => {
  const f = fixture();
  f.state.selected = { kind: 'theme', id: 'github', variant: 'dark' };
  f.render(); await f.key('\x1b[B');
  assert.ok(f.render().some(row => row.includes('→ ') && row.includes('Code color variant')));
  f.state.selected = { kind: 'theme', id: 'gitlab', variant: 'light' };
  f.menu.handleInput('\r');
  await turn();
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'gitlab', variant: 'dark' } }]);
  f.menu.dispose();
});

test('root variant activation rechecks Follow Pi when the last frame still showed an enabled row', async () => {
  const f = fixture();
  f.state.selected = { kind: 'theme', id: 'github', variant: 'dark' };
  f.render(); await f.key('\x1b[B');
  assert.ok(f.render().some(row => row.includes('→ ') && row.includes('Code color variant')));
  f.state.selected = { kind: 'pi', variant: 'light' };
  f.menu.handleInput('\r');
  await turn();
  assert.equal(f.calls.length, 0);
  assert.equal(f.previews.length, 0);
  assert.deepEqual(f.state.selected, { kind: 'pi', variant: 'light' });
  f.menu.dispose();
});


test('clearing theme search previews the newly revealed first row before another list frame', async () => {
  const f = fixture();
  try {
    f.render(); await f.key('\r'); await f.key('github');
    assert.deepEqual(f.previews.at(-1), { kind: 'theme', id: 'github', variant: 'dark' });
    assert.equal(f.render().some(row => row.includes('Follow Pi theme')), false);
    const saves = f.calls.length;
    f.menu.handleInput('\x15');
    assert.deepEqual(f.previews.at(-1), { kind: 'pi', variant: 'dark' });
    assert.equal(f.calls.length, saves);
  } finally { f.menu.dispose(); }
});
