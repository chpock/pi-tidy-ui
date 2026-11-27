import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiagnosticSink } from '../../../src/diagnostics.ts';
import type { ThemePreference } from '../../../src/appearance/theme-preference.ts';
import type { ApplicationPreferences } from '../../../src/application/preferences.ts';
import { RETIRED_SETTINGS_ACTION, type SyntaxMenuOutcome } from '../../../src/application/syntax-menu.ts';
import { performMenuAction, type MenuActionCapabilities, type MenuRecordingRetry, type MenuSnapshotWrite } from '../../../src/application/menu-actions.ts';

function fixture() {
  const state = { current: true, appearance: true, colors: true }, effects: string[] = [], requests: string[] = [];
  const receipt = 0, switchOutcome: SyntaxMenuOutcome = { ok: false, message: 'Existing switch outcome' };
  let switchArgs: Parameters<ApplicationPreferences['setSwitch']> | undefined, selected: ThemePreference | undefined;
  const journal: DiagnosticSink = (_level, _area, _message, fields) => { requests.push(String(fields?.action)); };
  const diagnostic: DiagnosticSink = () => {};
  const capabilities: MenuActionCapabilities = {
    scope: { signal: new AbortController().signal, current: () => state.current },
    preferences: {
      get appearanceEnabled() { return state.appearance; }, get terminalColorsEnabled() { return state.colors; },
      async setSwitch(...args: Parameters<ApplicationPreferences['setSwitch']>) { effects.push('switch'); switchArgs = args; return switchOutcome; },
    },
    switches: { appearance() {}, terminalColors() {}, nativeHighlighting: () => undefined, logging: () => undefined, recordingFailed: () => false },
    journal, diagnostic,
    applyAppearance() { effects.push('appearance'); }, reapplyTerminalColors() { effects.push('colors'); },
    async confirmTheme(choice: ThemePreference) { effects.push('theme'); selected = choice; return { kind: 'completed' as const, outcome: { ok: true as const } }; },
    clearLayouts() { effects.push('clear'); return receipt; },
    recording: {
      async retry() { effects.push('retry'); return 'active' as const; },
      async writeSnapshot() { effects.push('snapshot'); return 'written' as const; },
    },
  };
  return { capabilities, state, effects, requests, receipt, switchOutcome, get switchArgs() { return switchArgs; }, get selected() { return selected; } };
}

test('menu action admission: a retired scope returns the shared outcome without a request record or effect', async () => {
  const f = fixture(); f.state.current = false;
  const outcome = await performMenuAction({ kind: 'reapplyAppearance' }, f.capabilities);
  assert.equal(outcome === RETIRED_SETTINGS_ACTION, true); assert.deepEqual(f.effects, []); assert.deepEqual(f.requests, []);
  assert.deepEqual(outcome, { ok: false, message: 'This settings action belongs to a closed runtime.' });
});

test('menu switches delegate the exact existing scope, application and diagnostic authority without remapping their outcome', async () => {
  const f = fixture(), c = f.capabilities;
  const outcome = await performMenuAction({ kind: 'switch', key: 'appearanceEnabled', value: false }, c);
  assert.equal(outcome === f.switchOutcome, true);
  assert.equal(f.switchArgs?.[0], 'appearanceEnabled'); assert.equal(f.switchArgs?.[1], false);
  assert.equal(f.switchArgs?.[2] === c.scope, true); assert.equal(f.switchArgs?.[3] === c.switches, true);
  assert.equal(f.switchArgs?.[4] === c.diagnostic, true); assert.deepEqual(f.effects, ['switch']); assert.deepEqual(f.requests, ['switch']);
});

test('menu theme confirmation keeps the submitted pair and successful scoped outcome', async () => {
  const f = fixture(), choice: ThemePreference = { kind: 'theme', id: 'github', variant: 'light' };
  const outcome = await performMenuAction({ kind: 'theme', choice }, f.capabilities);
  assert.deepEqual(outcome, { ok: true }); assert.equal(f.selected === choice, true); assert.deepEqual(f.effects, ['theme']);
});

test('menu theme confirmation distinguishes a retired runtime from an applied-but-unsaved completed choice', async () => {
  const f = fixture(), action = { kind: 'theme' as const, choice: { kind: 'pi' as const, variant: 'dark' as const } };
  f.capabilities.confirmTheme = async (_choice: ThemePreference) => ({ kind: 'retired' as const });
  assert.equal(await performMenuAction(action, f.capabilities) === RETIRED_SETTINGS_ACTION, true);
  f.capabilities.confirmTheme = async (_choice: ThemePreference) => ({ kind: 'completed' as const, outcome: { ok: false as const, message: 'Save refused.' } });
  assert.deepEqual(await performMenuAction(action, f.capabilities), { ok: false, message: 'Theme applied for now, but not saved: Save refused.' });
});

for (const [kind, appearance, colors, message] of [
  ['reapplyAppearance', false, true, 'Turn on Tidy UI appearance first.'],
  ['reapplyColors', false, true, 'Turn on appearance and terminal color matching first.'],
  ['reapplyColors', true, false, 'Turn on appearance and terminal color matching first.'],
] as const) test(`menu eligibility: ${kind} with appearance=${appearance}, colors=${colors} admits no reapply`, async () => {
  const f = fixture(); f.state.appearance = appearance; f.state.colors = colors;
  assert.deepEqual(await performMenuAction({ kind }, f.capabilities), { ok: false, message }); assert.deepEqual(f.effects, []);
});

for (const kind of ['reapplyAppearance', 'reapplyColors'] as const) test(`menu effect: ${kind} executes exactly its admitted operation`, async () => {
  const f = fixture();
  assert.deepEqual(await performMenuAction({ kind }, f.capabilities), { ok: true });
  assert.deepEqual(f.effects, [kind === 'reapplyAppearance' ? 'appearance' : 'colors']);
});

test('menu ordinary-effect success still checks the session after synchronous reentrant retirement', async () => {
  const f = fixture(); f.capabilities.applyAppearance = () => { f.state.current = false; };
  assert.equal(await performMenuAction({ kind: 'reapplyAppearance' }, f.capabilities) === RETIRED_SETTINGS_ACTION, true);
});

test('menu clear returns the exact eager receipt from its single synchronous operation', async () => {
  const f = fixture(), pending = performMenuAction({ kind: 'clearCache' }, f.capabilities);
  assert.deepEqual(f.effects, ['clear']);
  const outcome = await pending;
  assert.equal(outcome.ok, true); assert.equal(outcome.clearedLayouts, f.receipt);
});

test('menu clear reports the absence of active layouts without fabricating an empty receipt', async () => {
  const f = fixture(); f.capabilities.clearLayouts = () => undefined;
  assert.deepEqual(await performMenuAction({ kind: 'clearCache' }, f.capabilities), { ok: false, message: 'There are no active Tidy UI layouts to clear.' });
});

for (const [status, outcome] of [
  ['unavailable', { ok: false, message: 'Turn on diagnostic recording first.' }],
  ['inactive', { ok: false, message: 'Recording could not be started. See the log status for details.' }],
  ['active', { ok: true }],
] as const) test(`menu recording retry interprets ${status} without borrowing a writer`, async () => {
  const f = fixture(); f.capabilities.recording.retry = async (): Promise<MenuRecordingRetry> => status;
  assert.deepEqual(await performMenuAction({ kind: 'retryLogging' }, f.capabilities), outcome);
});

for (const status of ['active', 'inactive'] as const) test(`menu recording retry preserves ${status} precedence after an awaited epoch change`, async () => {
  const f = fixture(); let release!: (value: MenuRecordingRetry) => void;
  const held = new Promise<MenuRecordingRetry>(resolve => { release = resolve; });
  f.capabilities.recording.retry = () => held;
  const pending = performMenuAction({ kind: 'retryLogging' }, f.capabilities);
  f.state.current = false; release(status);
  const outcome = await pending;
  if (status === 'active') assert.equal(outcome === RETIRED_SETTINGS_ACTION, true);
  else assert.deepEqual(outcome, { ok: false, message: 'Recording could not be started. See the log status for details.' });
});

for (const [status, outcome] of [
  ['notCapturing', { ok: false, message: 'Snapshot not written: diagnostic recording is off or unavailable.' }],
  ['writeFailed', { ok: false, message: 'The diagnostic snapshot could not be written.' }],
  ['retired', RETIRED_SETTINGS_ACTION],
  ['written', { ok: true }],
] as const) test(`menu snapshot interprets the bounded ${status} receipt`, async () => {
  const f = fixture(); f.capabilities.recording.writeSnapshot = async (): Promise<MenuSnapshotWrite> => status;
  const actual = await performMenuAction({ kind: 'snapshotLogs' }, f.capabilities);
  assert.deepEqual(actual, outcome); if (status === 'retired') assert.equal(actual === RETIRED_SETTINGS_ACTION, true);
});

for (const kind of ['retryLogging', 'snapshotLogs'] as const) test(`menu ${kind} propagates an operational exception to the existing popup failure boundary`, async () => {
  const f = fixture(), error = new Error('PRIVATE_OPERATIONAL_FAILURE');
  if (kind === 'retryLogging') f.capabilities.recording.retry = async () => { throw error; };
  else f.capabilities.recording.writeSnapshot = async () => { throw error; };
  await assert.rejects(performMenuAction({ kind }, f.capabilities), candidate => candidate === error);
});
