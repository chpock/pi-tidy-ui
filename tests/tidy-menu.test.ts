import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TidyMenu, profileLabels, type TidyMenuOwner, type TidyMenuSnapshot, type TidyMenuAction } from '../src/tidy-menu.ts';

const colors = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function fixture(width = 70, height = 24) {
  const calls: TidyMenuAction[] = [];
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
  return { menu, owner, state, calls, render, key, select, get closed() { return closed; },
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

test('theme label collision and terminal controls are escaped while opaque IDs remain exact', () => {
  const labels = profileLabels([{ id: 'first', label: 'Back', fingerprint: 'a'.repeat(64) },
    { id: 'second', label: 'Back', fingerprint: 'b'.repeat(64) }, { id: '\u001b[31m', label: '\nsecret', fingerprint: 'c'.repeat(64) }]);
  assert.equal(new Set(labels).size, 3); assert.ok(labels.every(label => !/[\n\x1b]/u.test(label)));
});

function native(f: ReturnType<typeof fixture>, count = 49) {
  const profiles = Array.from({ length: count }, (_, i) => ({ id: `opaque-${i}`, label: `Theme ${String(i).padStart(2, '0')}`, fingerprint: 'a'.repeat(64) }));
  f.state.syntax = { enabled: true, standaloneVersion: 'test', selected: f.state.selected,
    provider: { availability: 'ready', reason: 'ready', generation: 1, initialShared: false, kind: 'owned',
      description: { profiles, backend_version: 'test' } as any } };
  return profiles;
}

for (const [width, height] of [[70, 24], [24, 12], [24, 5], [24, 2], [24, 1]]) test(`theme catalogue: every one of 49 choices is reachable at ${width}x${height}`, async () => {
  const f = fixture(width, height); native(f);
  f.render(); await f.key('\r');
  for (let i = 0; i < 49; i++) {
    await f.key('\x1b[B');
    const rows = f.render();
    assert.ok(rows.some(row => row.includes(`Theme ${String(i).padStart(2, '0')}`)), `choice ${i} is painted`);
    assert.ok(rows.length <= height); assert.ok(rows.every(row => visibleWidth(row) <= width));
  }
  await f.key('\r');
   assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'occipital', id: 'opaque-48' } }]);
   assert.ok(f.render().some(row => row.includes('→ Code color')), `confirmation returns to the main page with its theme entry selected: ${f.render().join('\n')}`);
});

test('theme picker restores chosen identity, supports search, and never applies on navigation/cancel', async () => {
  const f = fixture(); native(f); f.state.selected = { kind: 'occipital', id: 'opaque-37' };
  f.render(); await f.key('\r');
  assert.ok(f.render().some(row => row.includes('→ Theme 37')));
  await f.key('Theme 12');
  assert.ok(f.render().some(row => row.includes('→ Theme 12')));
  assert.equal(f.calls.length, 0);
  await f.key('\x1b'); assert.equal(f.calls.length, 0);
});

for (const availability of ['disabled', 'initializing', 'transitioning', 'unavailable', 'disposed'] as const)
  test(`theme picker ${availability}: no stale native choices or catalogue requests; Follow Pi selectable`, async () => {
    const f = fixture(); native(f); f.state.syntax!.provider.availability = availability;
    f.render(); await f.key('\r'); assert.doesNotMatch(f.render().join('\n'), /Theme 00/);
    await f.select('Refresh theme list'); assert.equal(f.calls.length, 0);
    await f.select('Follow Pi theme'); assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'pi' } }]);
  });

test('native-off and appearance-off hide cached profiles without disabling ordinary preferences', async () => {
  for (const key of ['nativeHighlightingEnabled', 'appearanceEnabled'] as const) {
    const f = fixture(); native(f); f.state[key] = false; f.render(); await f.key('\r');
    assert.doesNotMatch(f.render().join('\n'), /Theme 00/); assert.equal(f.calls.length, 0);
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

test('opaque native IDs and duplicate/action-like labels never become control actions', async () => {
  const f = fixture(), profiles = native(f, 3);
  profiles[0] = { ...profiles[0]!, id: 'opaque\n\u001b-id', label: 'Back' };
  profiles[1] = { ...profiles[1]!, label: 'Back' };
  profiles[2] = { ...profiles[2]!, label: 'Follow Pi theme' };
  f.render(); await f.key('\r'); await f.key('\x1b[B'); await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'occipital', id: 'opaque\n\u001b-id' } }]);
  assert.equal(f.closed, 0);
});

test('status and Refresh do not prepare themes, read cache, or claim a protocol for an absent provider', async () => {
  const f = fixture(); await f.select('Status & troubleshooting'); await f.select('Refresh status');
  await f.select('Highlighting service details');
  assert.match(f.render().join('\n'), /Protocol: unavailable/);
  assert.equal(f.prepared, 0); assert.equal(f.cacheReads, 0); assert.equal(f.calls.length, 0);
});

test('theme search matches stable IDs without applying on typing; confirmation returns to root once', async () => {
  const f = fixture(); native(f); f.render(); await f.key('\r');
  await f.key('opaque-37');
  assert.ok(f.render().some(row => row.includes('→ Theme 37')));
  assert.equal(f.calls.length, 0);
  await f.key('\r');
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'occipital', id: 'opaque-37' } }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
});

test('theme mouse confirmation returns to the main page and saves exactly the clicked identity', async () => {
  const f = fixture(); native(f, 1); f.render(); await f.key('\r');
  const rows = f.render(), y = rows.findIndex(row => row.includes('Theme 00'));
  const event = { button: 'left' as const, x: 4, y, screenX: 4, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  f.menu.handleMouse({ ...event, type: 'press' }); f.render();
  f.menu.handleMouse({ ...event, type: 'click' }); await turn();
  assert.deepEqual(f.calls, [{ kind: 'theme', choice: { kind: 'occipital', id: 'opaque-0' } }]);
  assert.ok(f.render().some(row => row.includes('Tidy UI appearance')));
  assert.equal(f.closed, 0);
});

test('native Pi palette is not offered as a duplicate independent theme', async () => {
  const f = fixture(), profiles = native(f, 1); profiles[0]!.id = 'pi';
  f.render(); await f.key('\r');
  assert.match(f.render().join('\n'), /Follow Pi theme/);
  assert.doesNotMatch(f.render().join('\n'), /Theme 00/);
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

test('different pages fit their own full catalogue, never just the visible or searched choices', async () => {
  const f = fixture(); const profiles = native(f);
  profiles[48]!.label = 'An unusually long but perfectly ordinary native theme';
  const root = f.menu.preferredWidth();
  await f.select('Code color theme');
  const themes = f.menu.preferredWidth();
  assert.ok(themes > root && themes < 72, 'the long offscreen label determines the picker width');
  for (let i = 0; i < 20; i++) { await f.key('\x1b[B'); assert.equal(f.menu.preferredWidth(), themes); }
  await f.key('opaque-37'); assert.equal(f.menu.preferredWidth(), themes, 'filtering does not shrink the picker');
  assert.ok(f.render().some(row => row.includes('→ Theme 37')));
  await f.key('\x1b'); assert.equal(f.menu.preferredWidth(), root);
  await f.select('Status & troubleshooting'); await f.select('Display cache');
  assert.ok(f.menu.preferredWidth() < themes, 'cache actions need not inherit the picker width');
  assert.equal(f.calls.length, 0, 'measuring/navigating/filtering has no preference action');
});

test('preferred width measures terminal columns for Unicode values and caps pathological labels', () => {
  const f = fixture(); const profiles = native(f, 1);
  profiles[0]!.label = '界'.repeat(14); f.state.selected = { kind: 'occipital', id: profiles[0]!.id };
  const width = f.menu.preferredWidth();
  assert.ok(width >= visibleWidth(`→ Code color theme ${profiles[0]!.label} ›`) + 2);
  assert.ok(f.menu.render(width).map(plain).some(row => row.includes(profiles[0]!.label)), 'a wide Unicode value is not cut at its JS string length');
  profiles[0]!.label = '界'.repeat(1000);
  assert.equal(f.menu.preferredWidth(), 72, '72 is a ceiling, not a fixed or unbounded page width');
  for (const columns of [1, 6, 24, 40, 100]) {
    const available = Math.min(columns, f.menu.preferredWidth()), rows = f.menu.render(available);
    assert.ok(rows.every(row => visibleWidth(row) <= columns));
  }
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

test('theme marker never intrudes on catalogue labels and stays aligned when the longest label is filtered out', async () => {
  const f = fixture(), profiles = native(f);
  profiles[48]!.label = 'A long complete catalogue label without a marker';
  f.state.selected = { kind: 'occipital', id: profiles[0]!.id };
  await f.select('Code color theme');
  const width = f.menu.preferredWidth();
  const selectedRow = () => f.menu.render(width).map(plain).find(row => /^│[→ ] /u.test(row) && row.includes('Theme 00'))!;
  const column = cellOf(selectedRow(), 'Selected');
  assert.ok(3 + visibleWidth(profiles[48]!.label) + 2 <= column, 'offscreen long labels cannot enter the marker column');
  await f.key('opaque-0');
  assert.equal(f.menu.preferredWidth(), width); assert.equal(cellOf(selectedRow(), 'Selected'), column);
  assert.equal(f.calls.length, 0);
});

test('Unicode and literal arrows inside theme values do not become layout separators', () => {
  const f = fixture(), profiles = native(f, 1);
  profiles[0]!.label = '界e\u0301 › value'; f.state.selected = { kind: 'occipital', id: profiles[0]!.id };
  const rows = rootRows(f), valueColumn = cellOf(rows[0]!, 'On');
  assert.equal(cellOf(rows[1]!, profiles[0]!.label), valueColumn);
  assert.equal(visibleWidth(rows[1]!.slice(0, rows[1]!.lastIndexOf('›'))), f.menu.preferredWidth() - 2);
  profiles[0]!.label = '界'.repeat(100);
  assert.equal(f.menu.preferredWidth(), 72);
  const capped = rootRows(f);
  assert.equal(cellOf(capped[1]!, '界'), cellOf(capped[0]!, 'On'));
  assert.ok(capped[1]!.includes('…')); assert.ok(capped.every(row => visibleWidth(row) === 72));
});
