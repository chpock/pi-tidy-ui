import './test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../src/index.ts';
import { ExpectedOwnedUnavailable } from '../../src/occipital/owned-startup.ts';
import { Root, Tool, cardInputTheme } from './sdk-contract-support.ts';
import { setAppearance } from '../helpers/menu-driver.ts';

const directory = mkdtempSync(join(tmpdir(), 'tidy-color-defaults-'));
const root = new Root(); root.addChild(new Tool());
const widgets = new Map<string, Component>();
const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const notices: { message: string; type?: string }[] = [], packets: string[] = [];
let command: Parameters<typeof setAppearance>[0] | undefined;
Object.defineProperties(cardInputTheme, { name: { value: 'missing-fixed-theme', configurable: true },
  sourcePath: { value: join(directory, 'missing.json'), configurable: true } });
Object.assign(root, { queryTerminalColors: async () => ({}) });
root.terminal.write = data => { packets.push(data); };
const ctx = { mode: 'tui', hasUI: true, cwd: directory, isIdle: () => true,
  sessionManager: { getSessionId: () => 'default-color-session' }, ui: {
    theme: cardInputTheme, getEditorComponent: () => undefined,
    notify(message: string, type?: string) { notices.push({ message, type }); },
    setWidget(name: string, factory?: (tui: Root) => Component) {
      if (factory) widgets.set(name, factory(root)); else widgets.delete(name);
    },
  } } as unknown as ExtensionContext;
const api = { registerToolRenderer() {}, registerFlag() {}, getFlag() {}, getSettings: () => ({}), getThinkingLevel: () => 'off',
  registerCommand(name: string, options: { handler: Parameters<typeof setAppearance>[0] }) { if (name === 'tidy-ui') command = options.handler; },
  on(name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, callback); },
} as unknown as ExtensionAPI;
const listeners = process.listenerCount('exit');
assert.equal(Object.hasOwn(globalThis, Symbol.for('pi-tidy-ui.terminal-defaults')), false, 'fresh child has no earlier applied-channel owner');
const ready = tidyUi(api, { logging: false, localPreferences: { appearanceEnabled: true, loggingEnabled: false },
  settings: { async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: true }; },
    async update() { return { ok: true }; } },
  syntax: () => ({ standaloneVersion: 'fixture', provider: { async tryShared() { return undefined; }, async acquireOwned() { throw new ExpectedOwnedUnavailable(); } } }),
});
const colorNotices = () => notices.filter(notice => notice.message.startsWith('[pi-tidy-ui] Terminal colors encountered an unexpected error'));
try {
  assert.equal(process.listenerCount('exit'), listeners, 'extension construction must not initialize process defaults');
  await ready;
  await events.get('session_start')!({ reason: 'startup' }, ctx); await turn();
  assert.equal(process.listenerCount('exit'), listeners + 1, 'first color-widget construction initializes the sole process cleanup');
  assert.equal(colorNotices().length, 1, 'first color source failure reaches the already selected health sink');
  assert.equal(colorNotices()[0]!.type, 'error', 'health routing is distinct from the no-health warning fallback');
  assert.equal(notices.filter(notice => notice.message.startsWith('[pi-tidy-ui] Terminal colors:')).length, 0);
  const retired = widgets.get('pi-tidy-ui-terminal-colors')!;
  await events.get('session_start')!({ reason: 'reload' }, ctx); await turn();
  assert.equal(colorNotices().length, 1); assert.equal(process.listenerCount('exit'), listeners + 1);
  await setAppearance(command!, ctx, false); await turn();
  await setAppearance(command!, ctx, true); await turn();
  assert.equal(colorNotices().length, 2, 'replacement color owner starts one new health episode');
  assert.equal(process.listenerCount('exit'), listeners + 1, 'replacement reuses the process-only defaults');
  assert.equal(widgets.get('pi-tidy-ui-terminal-colors') !== retired, true);
  retired.render(80); retired.invalidate(); await turn();
  assert.equal(colorNotices().length, 2, 'retired widget cannot reenter the replacement owner');
  assert.equal(packets.length, 0, 'broken sources never own or reset channels');
  console.log(JSON.stringify({ listenerAdditions: process.listenerCount('exit') - listeners, healthEpisodes: colorNotices().length,
    errorNotices: colorNotices().filter(notice => notice.type === 'error').length, terminalPackets: packets.length }));
} finally {
  await events.get('session_shutdown')!({ reason: 'quit' }, ctx);
  rmSync(directory, { recursive: true, force: true });
}
