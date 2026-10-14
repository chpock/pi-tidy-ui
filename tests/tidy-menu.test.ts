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
  assert.match(f.render().join('\n'), /Match terminal colors to Pi.*On/);
  assert.doesNotMatch(f.render().join('\n'), /cache|Diagnostic logs|Occipital|shared|owned/i);
  await f.key('\r'); assert.equal(f.prepared, 1); assert.equal(f.calls.length, 0);
  assert.match(f.render().join('\n'), /Follow Pi theme/);
  await f.key('\x1b'); assert.match(f.render().join('\n'), /Tidy UI appearance/);
  assert.equal(f.cacheReads, 0);
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
  await f.select('Match terminal colors to Pi');
  assert.match(f.render().join('\n'), /could not be completed/i);
  assert.doesNotMatch(f.render().join('\n'), /PRIVATE_URL_TOKEN/);
});

test('closing pending menu work ignores late completion and input', async () => {
  const f = fixture(); let settle!: (value: { ok: true }) => void;
  f.perform = () => new Promise(resolve => { settle = resolve; });
  await f.select('Match terminal colors to Pi'); await f.key('\x1b');
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
