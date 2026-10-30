import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TidyMenu, themeLabels, type TidyMenuOwner, type TidyMenuSnapshot, type TidyMenuAction } from '../../../src/tidy-menu.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { THEME_CATALOGUE } from '../../../src/themes/catalogue.ts';
import { observePaletteInput } from '../../fixtures/palette-input-observer.mjs';

const colors = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function fixture(width = 70, height = 24) {
  const calls: TidyMenuAction[] = [];
  const previews: TidyMenuSnapshot['selected'][] = [];
  const state: TidyMenuSnapshot = { appearanceEnabled: true, terminalColorsEnabled: true, nativeHighlightingEnabled: true, loggingEnabled: true,
    selected: { kind: 'pi' }, appearance: 'Active', terminalColors: 'Following Pi theme', syntax: undefined };
  let prepared = 0, cacheReads = 0, closed = 0;
  let perform: TidyMenuOwner['act'] = async action => {
    calls.push(action);
    if (action.kind === 'switch') state[action.key] = action.value;
    if (action.kind === 'theme') state.selected = action.choice;
    if (action.kind === 'clearCache') return { ok: true, cache: owner.cacheDetails() };
    return { ok: true };
  };
  const owner: TidyMenuOwner = { snapshot: () => state, prepareThemes: async () => { prepared++; },
    previewTheme(choice) { const copy = structuredClone(choice); previews.push(copy); state.selected = copy; },
    act: action => perform(action), cacheDetails: () => { cacheReads++; return ['Cached layouts: 2', 'Estimated memory: 1 KiB']; } };
  const menu = new TidyMenu(owner, colors as any, () => {}, () => { closed++; }, () => height);
  const render = () => menu.render(width).map(plain);
  const key = async (data: string) => { menu.handleInput(data); await turn(); render(); };
  const select = async (label: string) => {
    for (let i = 0; i < 100; i++) {
      if (render().some(row => /^.*[→›] /.test(row) && row.includes(label))) { await key('\r'); return; }
      await key('\x1b[B');
    }
    assert.fail(`Missing selected item ${label}: ${render().join('\n')}`);
  };
  return { menu, owner, state, calls, previews, render, key, select, get closed() { return closed; },
    get prepared() { return prepared; }, get cacheReads() { return cacheReads; }, set perform(next: typeof perform) { perform = next; } };
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
  const help = helpRows(f.menu.render(f.menu.preferredWidth()).map(plain)).join(' ');
  assert.match(help, /Set background and default text color from Pi’s theme\./u);
  assert.match(help, /Pi controls automatic themes\./u);
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
  assert.equal(f.cacheReads, 2);
  await f.key('\x1b'); await f.select('Diagnostic logs');
  await f.select('Write state snapshot'); assert.equal(f.calls.at(-1)?.kind, 'snapshotLogs');
});

test('clear receipt stays at zero when a native repaint rebuilds layouts before the action returns', async () => {
  const f = fixture(); let layouts = 2;
  f.owner.cacheDetails = () => [`Cached layouts: ${layouts}`];
  f.perform = async () => {
    layouts = 0; const cache = f.owner.cacheDetails();
    queueMicrotask(() => { layouts = 2; });
    return { ok: true, cache };
  };
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  await f.select('Clear saved layouts');
  assert.equal(layouts, 2, 'a later frame has rebuilt the live layouts');
  assert.match(f.render().join('\n'), /Cached layouts: 0/);
  assert.doesNotMatch(f.render().join('\n'), /Cached layouts: 2/);
});

test('inline failure is bounded and remains visible after the operation; no raw error text', async () => {
  const f = fixture(); f.perform = async () => { throw new Error('PRIVATE_URL_TOKEN'); };
  await f.select('Set terminal colors from Pi theme');
  assert.match(f.render().join('\n'), /could not be completed/i);
  assert.doesNotMatch(f.render().join('\n'), /PRIVATE_URL_TOKEN/);
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
  const labels = themeLabels(THEME_CATALOGUE);
  assert.equal(labels.length, 72); assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every(label => !/[\n\x1b\p{Cc}\p{Cs}]/u.test(label)));
  assert.equal(THEME_CATALOGUE.find(theme => theme.id === 'gruvbox-dark')?.label, 'Gruvbox Dark');
});

function native(f: ReturnType<typeof fixture>, _count?: number) {
  f.state.syntax = { enabled: true, standaloneVersion: 'test', selected: f.state.selected,
    provider: { availability: 'ready', reason: 'ready', generation: 1, initialShared: false, kind: 'owned',
      description: { backend_version: 'test' } as any } };
  return THEME_CATALOGUE;
}

for (const [width, height] of [[70, 24], [24, 12], [24, 5], [24, 2], [24, 1]]) test(`local theme catalogue: all ${THEME_CATALOGUE.length} palettes are reachable at ${width}x${height}`, async () => {
  const f = fixture(width, height); const themes = native(f);
  f.render(); await f.key('\r');
  for (let i = 0; i < themes.length; i++) {
    await f.key('\x1b[B');
    const rows = f.render();
    const choice = { kind: 'theme' as const, id: themes[i]!.id };
    assert.deepEqual(f.state.selected, choice, `choice ${themes[i]!.id} is selected through the public input path`);
    assert.deepEqual(f.previews.at(-1), choice, `choice ${themes[i]!.id} is previewed through its selection callback`);
    assert.ok(rows.some(row => row.includes('→') || row.includes('›')), 'the active selection remains visible');
    assert.ok(rows.length <= height); assert.ok(rows.every(row => visibleWidth(row) <= width));
  }
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: themes.at(-1)!.id } }]);
  assert.ok(f.render().some(row => row.includes('→ Code color')), `confirmation returns to the main page with its theme entry selected: ${f.render().join('\n')}`);
});

test('theme picker previews a local stable ID, then restores its entry choice without saving', async () => {
  const f = fixture(); native(f); f.state.selected = { kind: 'theme', id: 'gruvbox-dark' };
  f.render(); await f.key('\r');
  await f.key('solarized-light');
  assert.ok(f.render().some(row => row.includes('→ Solarized Light')));
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'solarized-light' });
  assert.deepEqual(f.previews, [{ kind: 'theme', id: 'solarized-light' }]);
  assert.equal(f.calls.length, 0);
  await f.key('\x1b'); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'gruvbox-dark' });
});

test('menu-only local theme preview does not prepare or read an asset until selected card input is requested', async () => {
  const f = fixture(); native(f);
  let settingsLoads = 0, providerStarts = 0;
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.1.0-test',
    settings: { load: async () => { settingsLoads++; return { ok: true, syntaxTheme: { kind: 'pi' } }; }, update: async () => ({ ok: true }) },
    provider: { tryShared: async () => { providerStarts++; return undefined; }, acquireOwned: async () => { providerStarts++; throw Error('unexpected provider'); } } });
  let preparation: Promise<void> | undefined;
  f.owner.prepareThemes = () => {
    preparation = runtime.prepareThemes().then(() => { f.state.selected = runtime.snapshot().selected; });
    return preparation;
  };
  f.owner.previewTheme = choice => { runtime.previewTheme(choice); f.state.selected = choice; };
  const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  const leases: NonNullable<ReturnType<SyntaxRuntime['preparePaletteInput']>>[] = [];
  const observed = observePaletteInput('solarized-light');
  try {
    f.render();
    await f.key('\r'); assert.ok(preparation); await preparation;
    f.render();
    await f.key('solarized-light');
    assert.deepEqual(runtime.snapshot().selected, { kind: 'theme', id: 'solarized-light' });
    assert.deepEqual(observed.snapshot(), { opens: 0, reads: 0, ownerLookups: 0 });
    assert.equal(settingsLoads, 1); assert.equal(providerStarts, 0);
    assert.equal(runtime.sources.stats().sourceRecords, 0); assert.equal(runtime.sources.stats().dispatches, 0);

    const palette = runtime.snapshot().effective; assert.ok(palette);
    const revision = runtime.palette({ colors: {} });
    const first = runtime.preparePaletteInput(palette, undefined, revision, 'truecolor', funding); assert.ok(first); leases.push(first);
    const cold = observed.snapshot();
    assert.equal(cold.opens, 1, 'the selected-asset control reaches the package-relative file');
    assert.ok(cold.reads > 0); assert.equal(cold.ownerLookups, 1);

    const warm = runtime.preparePaletteInput(palette, undefined, revision, 'truecolor', funding); assert.ok(warm); leases.push(warm);
    assert.deepEqual(observed.snapshot(), { opens: cold.opens, reads: cold.reads, ownerLookups: cold.ownerLookups + 1 },
      'a warm owner lookup reuses the compiled store without reopening or rereading its asset');
    assert.equal(settingsLoads, 1); assert.equal(providerStarts, 0);
    assert.equal(runtime.sources.stats().sourceRecords, 0); assert.equal(runtime.sources.stats().dispatches, 0);
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
    f.render(); await f.key('\r'); assert.match(f.render().join('\n'), /AMOLED Dark/);
    await f.select('Solarized Dark'); assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'solarized-dark' } }]);
    assert.equal(f.prepared, 1, 'only the local selection boundary is prepared');
  });

test('helper-off and appearance-off do not hide locally owned palettes', async () => {
  for (const key of ['nativeHighlightingEnabled', 'appearanceEnabled'] as const) {
    const f = fixture(); native(f); f.state[key] = false; f.render(); await f.key('\r');
    assert.match(f.render().join('\n'), /AMOLED Dark/); assert.equal(f.calls.length, 0);
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
  await f.select('Synthwave \'84 Dark');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'synthwave84-dark' } }]);
  assert.equal(f.closed, 0);
});

test('status and Refresh do not prepare themes, read cache, or claim a protocol for an absent provider', async () => {
  const f = fixture(); await f.select('Status & troubleshooting'); await f.select('Refresh status');
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
  await f.key('solarized-light');
  assert.ok(f.render().some(row => row.includes('→ Solarized Light')));
  assert.equal(f.calls.length, 0);
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'solarized-light' } }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
});

test('theme mouse confirmation returns to the main page and saves the clicked local identity', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  const rows = f.render(), y = rows.findIndex(row => row.includes('AMOLED Dark'));
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' }); f.render();
  assert.deepEqual(f.state.selected, { kind: 'pi' }); assert.equal(f.previews.length, 0); assert.equal(f.calls.length, 0);
  f.menu.handleMouse({ ...event, type: 'click' }); await turn();
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'amoled-dark' } }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
  assert.equal(f.closed, 0);
});

test('Follow Pi remains a separate option from the fixed local palette catalogue', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  assert.match(f.render().join('\n'), /Follow Pi theme/); assert.match(f.render().join('\n'), /AMOLED Dark/);
  assert.equal(THEME_CATALOGUE.some(theme => theme.id === 'pi'), false);
});

for (const height of [5, 6]) for (const page of ['cache', 'logs'])
  test(`all ${page} details and Back stay accessible at 24x${height}`, async () => {
    const f = fixture(24, height), markers = page === 'cache' ? Array.from({ length: 10 }, (_, i) => `CACHE_DETAIL_${i}`)
      : ['JOURNAL_PATH_MARKER', 'INDEX_PATH_MARKER', 'SESSION_ID_MARKER', 'RUN_MARKER', 'NAME_MARKER', 'FAILURE_MARKER'];
    f.owner.cacheDetails = () => markers;
    f.state.logs = { capture: true, state: 'failed', path: markers[0], commonPath: markers[1], session: markers[2],
      run: markers[3], name: markers[4], failure: markers[5], records: 1, writes: 2, dropped: 0, writeErrors: 0 } as any;
    f.render(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r');
    for (let i = 0; i < (page === 'cache' ? 5 : 4); i++) await f.key('\x1b[B');
    await f.key('\r');
    const painted = [];
    for (let i = 0; i < 40; i++) {
      const rows = f.render(); assert.ok(rows.length <= height); assert.ok(rows.every(row => visibleWidth(row) <= 24));
      painted.push(...rows); await f.key('\x1b[6~');
    }
    for (const marker of markers) assert.ok(painted.some(row => row.includes(marker)), `detail is reachable: ${marker}`);
    assert.equal(f.calls.length, 0, 'scrolling only reads details');
    for (let i = 0; i < (page === 'cache' ? 2 : 4); i++) await f.key('\x1b[B');
    await f.key('\r');
    assert.ok(f.render().some(row => row.includes('Appearance: Active')), 'Back returns to support');
  });

function helpRows(rows: string[]): string[] {
  const divider = rows.findLastIndex(row => /^├─+┤$/u.test(row));
  const body = divider < 0 ? rows : rows.slice(0, divider).map(row => row.startsWith('│') ? row.slice(1, -1).trimEnd() : row);
  assert.equal(body.at(-3)?.trim(), '', 'one blank row precedes the two reserved description rows');
  return body.slice(-2).map(row => row.trimEnd());
}

test('header and navigation occupy their own separated sections on every page', async () => {
  const f = fixture();
  const check = (heading: string) => {
    const rows = f.render(), dividers = rows.flatMap((row, index) => /^├─+┤$/u.test(row) ? [index] : []);
    assert.equal(rows[1]?.slice(1, -1).trim(), heading);
    assert.deepEqual(dividers, [2, rows.length - 3]);
    assert.match(rows.at(-2)!, /↑↓ Navigate.*Enter Select.*Esc (?:Close|Back)/u);
    assert.equal(helpRows(rows).length, 2);
  };
  check('Tidy UI');
  await f.select('Code color theme'); check('Code color theme'); await f.key('\x1b');
  await f.select('Status & troubleshooting'); check('Status & troubleshooting');
  for (const page of ['Highlighting service details', 'Diagnostic logs', 'Display cache']) {
    await f.select(page); check(page); await f.key('\x1b');
  }
});

for (const [width, height] of [[70, 24], [24, 12], [24, 5]]) test(`description always reserves two rows, pads and ellipsizes at ${width}x${height}`, async () => {
  const f = fixture(width, height);
  const initial = helpRows(f.render());
  assert.match(initial.join(' '), /Colors for Bash/u);
  if (width === 24) assert.ok(initial[1]!.endsWith('…'), 'a third wrapped line is indicated by an ellipsis');
  await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\x1b[B');
  const close = helpRows(f.render());
  assert.match(close.join(' '), /Close this panel/u);
  if (width === 70) assert.equal(close[1], '', 'short descriptions retain an empty second row');
  assert.equal(f.calls.length, 0);
});

test('new pages describe their initially selected item before any selection movement', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  assert.match(helpRows(f.render()).join(' '), /Retry styling/u);
  await f.select('Display cache');
  assert.match(helpRows(f.render()).join(' '), /Read current cache counters/u);
});

test('settings changes are silent before, during and after saving; errors do not replace description rows', async () => {
  const f = fixture(); let finish!: (value: { ok: true }) => void;
  const quiet = () => assert.doesNotMatch(f.render().join('\n'), /Choices are saved automatically|Saving|Applying|Applied and saved/u);
  quiet();
  f.perform = action => {
    if (action.kind === 'switch') f.state[action.key] = action.value;
    return new Promise(resolve => { finish = resolve; });
  };
  await f.select('Set terminal colors from Pi theme'); quiet();
  const pendingHelp = helpRows(f.render()); const pendingHeight = f.render().length;
  assert.match(f.render().join('\n'), /Set terminal colors from Pi theme.*Off/u);
  await f.key('\r');
  finish({ ok: true }); await turn(); quiet();
  assert.equal(f.render().length, pendingHeight, 'saving does not resize the panel');
  assert.deepEqual(helpRows(f.render()), pendingHelp);
  f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.key('\r');
  assert.match(f.render().join('\n'), /SAVE_FAILURE/u);
  assert.deepEqual(helpRows(f.render()), pendingHelp, 'error feedback cannot consume the description slot');
});

test('clicking separators, description, blank row or navigation cannot activate a setting', () => {
  const f = fixture(), rows = f.render();
  const positions = [2, rows.length - 6, rows.length - 5, rows.length - 4, rows.length - 3, rows.length - 2];
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
      assert.equal(helpRows(rows).length, 2);
      assert.ok(rows.some(row => row.includes('→ ')), `the selected item stays visible at height ${height}`);
    };
    check(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r'); check();
    await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r'); check();
    await f.key('\x1b'); check();
    assert.equal(f.calls.length, 0);
  }
});

for (const height of [10, 11, 12]) test(`save errors remain readable beside both description rows at height ${height}`, async () => {
  const f = fixture(24, height);
  f.perform = async action => { f.calls.push(action); return { ok: false, message: 'Settings were applied but not saved.' }; };
  f.render(); await f.key('\x1b[B'); await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'switch', key: 'terminalColorsEnabled', value: false }]);
  assert.match(f.render().join('\n'), /not saved\./u);
  assert.match(helpRows(f.render()).join(' '), /Set background/u);
  assert.ok(f.render().length <= height);
});

for (const page of ['support', 'logs']) test(`short ${page} page drops chrome before losing an action failure`, async () => {
  const f = fixture(70, 11);
  await f.select('Status & troubleshooting');
  if (page === 'logs') await f.select('Diagnostic logs');
  f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.key('\r');
  assert.match(f.render().join('\n'), /SAVE_FAILURE/u);
  assert.equal(helpRows(f.render()).length, 2);
  assert.ok(f.render().length <= 11);
});

test('a one-row failure retains chrome when all sections still fit', async () => {
  const f = fixture(70, 11); f.perform = async () => ({ ok: false, message: 'SAVE_FAILURE' });
  await f.select('Set terminal colors from Pi theme');
  const rows = f.render();
  assert.equal(rows.filter(row => /^├─+┤$/u.test(row)).length, 2);
  assert.match(rows.join('\n'), /SAVE_FAILURE/u);
  assert.equal(helpRows(rows).length, 2);
  assert.ok(rows.length <= 11);
});

test('preferred width fits root labels, values and navigation without stretching for descriptions', async () => {
  const f = fixture();
  const width = f.menu.preferredWidth();
  assert.ok(width < 72, 'ordinary settings fit their labels and values below the page-width ceiling');
  const rows = f.menu.render(width).map(plain);
  for (const label of ['Tidy UI appearance', 'Code color theme', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close'])
    assert.ok(rows.some(row => row.includes(label)), `complete label: ${label}`);
  assert.match(rows.join('\n'), /↑↓ Navigate · Enter Select · Esc Close/u);
  assert.equal(helpRows(rows).length, 2, 'description space is fixed even when the text now fits in full');
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

test('different pages measure the full fixed catalogue, not only visible or searched choices', async () => {
  const f = fixture(); native(f); const root = f.menu.preferredWidth();
  await f.select('Code color theme'); const themes = f.menu.preferredWidth();
  const labelWidth = Math.max(...themeLabels(THEME_CATALOGUE).map(visibleWidth));
  const expected = Math.min(72, Math.max(4 + labelWidth + visibleWidth('Selected'),
    visibleWidth('Code color theme'), visibleWidth('↑↓ Navigate · Enter Select · Esc Back')) + 2);
  assert.equal(themes, expected, 'full local palette catalogue determines picker width, even when the root page is wider');
  for (let i = 0; i < 20; i++) { await f.key('\x1b[B'); assert.equal(f.menu.preferredWidth(), themes); }
  await f.key('solarized-light'); assert.equal(f.menu.preferredWidth(), themes, 'filtering does not shrink the picker');
  assert.ok(f.render().some(row => row.includes('→ Solarized Light')));
  await f.key('\x1b'); assert.equal(f.menu.preferredWidth(), root);
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  assert.ok(f.menu.preferredWidth() < themes, 'cache actions need not inherit the picker width');
  assert.equal(f.calls.length, 0, 'measuring/navigating/filtering has no preference action');
});

test('long diagnostic paths, IDs and detail scrolling do not widen a page or hide paging keys', async () => {
  const f = fixture();
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  const width = f.menu.preferredWidth();
  f.owner.cacheDetails = () => ['PATH_' + '/long-directory'.repeat(200)];
  await f.select('Refresh statistics');
  assert.equal(f.menu.preferredWidth(), width);
  const rows = f.menu.render(width).map(plain);
  assert.match(rows.at(-2)!, /↑↓.*Enter.*Esc.*PgUp\/PgDn/u);
  assert.equal(helpRows(rows).length, 2);
  await f.key('\x1b[6~'); assert.equal(f.menu.preferredWidth(), width);
});

test('narrow detail pages keep Back and paging discoverable inside the actual frame', async () => {
  const f = fixture(24, 12); f.owner.cacheDetails = () => Array.from({ length: 30 }, (_, i) => `Cache detail ${i}`);
  f.render(); await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\r');
  for (let i = 0; i < 5; i++) await f.key('\x1b[B');
  await f.key('\r');
  assert.match(f.render().at(-2)!, /Esc Back.*PgUp\/PgDn/u);
  assert.equal(helpRows(f.render()).length, 2);
  assert.ok(f.render().every(row => visibleWidth(row) <= 24));
});

const rootLabels = ['Tidy UI appearance', 'Code color theme', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close'];
const cellOf = (row: string, text: string) => {
  const index = row.indexOf(text); assert.ok(index >= 0, `missing ${JSON.stringify(text)} in ${JSON.stringify(row)}`);
  return visibleWidth(row.slice(0, index));
};
function rootRows(f: ReturnType<typeof fixture>, width = f.menu.preferredWidth()) {
  const rows = f.menu.render(width).map(plain);
  return ['Tidy', 'Code color', 'Set', 'Status', 'Close'].map(label => {
    const row = rows.find(row => /^│[→ ] /u.test(row) && row.slice(3).startsWith(label));
    assert.ok(row, `missing root item ${label}: ${rows.join('\n')}`); return row;
  });
}

test('root reserves common left-aligned value and separate rightmost submenu columns', async () => {
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
  assert.equal(arrow, width - 2); assert.equal(cellOf(rows[3]!, '›'), arrow);
  assert.ok(valueColumn + visibleWidth('Follow Pi') + 2 <= arrow, 'submenu indicator is not part of the value');
  for (let i = 0; i < 10; i++) { await f.key('\x1b[B'); assert.equal(f.menu.preferredWidth(), width); }
  assert.equal(f.calls.length, 0); assert.equal(f.prepared, 0);
});

for (const width of [24, 30, 40, 45, 72]) test(`shared root columns stay disjoint when clamped to ${width} columns`, () => {
  const f = fixture(); f.state.appearanceEnabled = false;
  const rows = rootRows(f, width), valueColumn = cellOf(rows[0]!, 'Off');
  assert.equal(cellOf(rows[2]!, 'On'), valueColumn);
  const themeValue = rows[1]!.slice(rows[1]!.indexOf('Code color')).split(/ {2,}/u)[1]!;
  assert.ok(themeValue); assert.equal(cellOf(rows[1]!, themeValue), valueColumn);
  for (const row of rows) {
    const label = row.slice(3).split(/ {2,}/u)[0]!.replace(/\s+│$/u, '').trimEnd();
    assert.ok(3 + visibleWidth(label) + 2 <= valueColumn, `label stays outside values: ${row}`);
    assert.ok(visibleWidth(row) <= width);
  }
  assert.equal(cellOf(rows[1]!, '›'), width - 2); assert.equal(cellOf(rows[3]!, '›'), width - 2);
});

test('support actions share the toggle label column and a distinct submenu indicator column', async () => {
  const f = fixture(); await f.select('Status & troubleshooting');
  const width = f.menu.preferredWidth(), rows = f.menu.render(width).map(plain);
  const labels = ['Reapply Tidy UI appearance', 'Reapply terminal colors', 'Use Occipital highlighting', 'Highlighting service details',
    'Diagnostic logs', 'Display cache', 'Refresh status', 'Back'];
  const nativeRow = rows.find(row => row.includes('Use Occipital highlighting'))!;
  const valueColumn = cellOf(nativeRow, 'On');
  for (const label of labels) {
    const row = rows.find(row => /^│[→ ] /u.test(row) && row.includes(label)); assert.ok(row);
    assert.ok(cellOf(row, label) + visibleWidth(label) + 2 <= valueColumn);
    if (row.includes('›')) assert.equal(cellOf(row, '›'), width - 2);
  }
});

test('selected marker stays aligned across the full fixed catalogue and filtering', async () => {
  const f = fixture(); native(f); f.state.selected = { kind: 'theme', id: 'amoled-dark' };
  await f.select('Code color theme'); const width = f.menu.preferredWidth();
  const selectedRow = () => f.menu.render(width).map(plain).find(row => /^│[→ ] /u.test(row) && row.includes('AMOLED Dark'))!;
  const column = cellOf(selectedRow(), 'Selected');
  const longest = Math.max(...THEME_CATALOGUE.map(theme => visibleWidth(theme.label)));
  assert.ok(3 + longest + 2 <= column, 'the marker follows the longest static label');
  await f.key('amoled-dark');
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
    assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' });
    assert.equal(f.calls.length, 0);
    const before = f.previews.length;
    for (let i = 0; i < 30; i++) f.render();
    assert.equal(f.previews.length, before, 'rendering cannot initiate preview work');
    if (exit === 'escape') await f.key('\x1b');
    else if (exit === 'back') await f.select('Back');
    else if (exit === 'ctrl+c') await f.key('\x03');
    else if (exit === 'close') f.menu.close();
    else f.menu.dispose();
    assert.deepEqual(f.state.selected, { kind: 'pi' });
    assert.equal(f.calls.length, 0);
    const restored = f.previews.length;
    f.menu.dispose(); f.menu.dispose();
    assert.equal(f.previews.length, restored, 'rollback is idempotent');
  });
}

test('theme preview: confirming promotes the preview; the next visit has its own rollback point', async () => {
  const f = fixture(); native(f, 3); f.render(); await f.key('\r');
  await f.key('\x1b[B'); await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'theme', id: 'amoled-dark' } }]);
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' });
  const before = f.previews.length;
  await f.key('\r'); assert.equal(f.previews.length, before);
  assert.ok(f.render().some(row => row.includes('→ AMOLED Dark')));
  await f.key('\x1b[B');
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-light' });
  await f.key('\x1b'); f.menu.close();
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' });
  assert.equal(f.calls.length, 1);
});

test('theme preview: closing during confirmed persistence is not rollback and late completion cannot reopen', async () => {
  const f = fixture(); native(f, 3); f.render(); await f.key('\r'); await f.key('\x1b[B');
  let resolve!: (value: { ok: true }) => void;
  f.perform = action => { f.calls.push(action); return new Promise(done => { resolve = done; }); };
  await f.key('\r');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' });
  const before = f.previews.length;
  await f.key('\x1b[B'); await f.key('\x03');
  assert.equal(f.closed, 1); assert.equal(f.previews.length, before);
  resolve({ ok: true }); await turn();
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' });
  assert.deepEqual(f.render(), []); assert.equal(f.previews.length, before);
});

test('theme preview: failed confirmation keeps the live choice and does not silently revert on close', async () => {
  const f = fixture(); native(f, 1); f.render(); await f.key('\r'); await f.key('\x1b[B');
  f.perform = async action => { f.calls.push(action); return { ok: false, message: 'Applied but not saved.' }; };
  await f.key('\r'); assert.match(f.render().join('\n'), /Applied but not saved/);
  f.menu.close();
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' }); assert.equal(f.calls.length, 1);
});

test('theme preview: empty search results and action rows do not become theme choices', async () => {
  const f = fixture(); native(f, 2); f.render(); await f.key('\r'); await f.key('amoled-light');
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-light' });
  const before = f.previews.length;
  await f.key('not-a-theme'); assert.equal(f.previews.length, before);
  await f.key('\x1b[B'); assert.equal(f.previews.length, before);
  await f.key('\x1b'); assert.deepEqual(f.state.selected, { kind: 'pi' }); assert.equal(f.calls.length, 0);
});

test('theme preview: loading from a cancelled visit cannot establish a later visit rollback point', async () => {
  const f = fixture(); native(f, 3); const pending: (() => void)[] = [];
  f.owner.prepareThemes = () => new Promise<void>(resolve => { pending.push(resolve); });
  f.render(); await f.key('\r'); await f.key('\x1b');
  f.state.selected = { kind: 'theme', id: 'amoled-light' };
  await f.key('\r'); pending[1]!(); await turn(); f.render();
  await f.key('\x1b[B'); assert.deepEqual(f.state.selected, { kind: 'theme', id: 'aura-dark' });
  pending[0]!(); await turn(); f.render();
  await f.key('\x1b'); assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-light' });
  assert.equal(f.calls.length, 0);
});

test('theme preview: rapid arrow input keeps only the latest selection and cancellation restores the entry choice', async () => {
  const f = fixture(); native(f, 12); f.render(); await f.key('\r');
  for (let i = 0; i < 8; ++i) f.menu.handleInput('\x1b[B');
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'carbonfox-light' });
  assert.equal(f.calls.length, 0);
  await f.key('\x1b');
  assert.deepEqual(f.state.selected, { kind: 'pi' }); assert.equal(f.calls.length, 0);
});

test('theme preview: native wheel selection previews without confirming or persisting', async () => {
  const f = fixture(); native(f, 4); f.render(); await f.key('\r');
  const rows = f.render(), y = rows.findIndex(row => row.includes('Follow Pi theme'));
  f.menu.handleMouse({ type: 'wheel', button: 'none', wheelDelta: 1, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false });
  assert.deepEqual(f.state.selected, { kind: 'theme', id: 'amoled-dark' }); assert.equal(f.calls.length, 0);
  await f.key('\x1b'); assert.deepEqual(f.state.selected, { kind: 'pi' });
});

for (const finish of ['escape', 'confirm'] as const) test(`settings sync: external confirmation preserves local preview until ${finish}`, async () => {
  const f = fixture(); native(f, 3); await f.select('Code color theme'); await f.key('\x1b[B');
  const preview = { kind: 'theme' as const, id: 'amoled-dark' }, external = { kind: 'theme' as const, id: 'aura-dark' };
  assert.deepEqual(f.state.selected, preview);
  const change = Reflect.get(f.menu, 'preferencesChanged'); assert.equal(typeof change, 'function');
  assert.equal(change.call(f.menu, external), true, 'host must not apply the external theme over a local preview');
  assert.deepEqual(f.state.selected, preview); assert.equal(f.calls.length, 0);
  await f.key(finish === 'escape' ? '\x1b' : '\r');
  assert.deepEqual(f.state.selected, finish === 'escape' ? external : preview);
  assert.deepEqual(f.calls, finish === 'escape' ? [] : [{ kind: 'theme', choice: preview }]);
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
