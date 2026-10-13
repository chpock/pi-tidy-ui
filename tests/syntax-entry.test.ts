import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Container } from '@earendil-works/pi-tui';
import { createWriteToolDefinition, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import tidyUi from '../src/index.ts';
import { SourceController } from '../src/occipital/controller.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const cleanups: (() => Promise<void>)[] = [];
function fixture(mode = 'tui') {
  const root = new UI(), events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const counts = { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 }, actions: (string | undefined)[] = [], notices: string[] = [];
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp', isIdle: () => true,
    sessionManager: { getSessionId: () => 'entry-fixture' }, ui: { theme: themes.theme,
      getEditorComponent: () => undefined, select: async () => actions.shift(), notify: (message: string) => notices.push(message),
      setWidget(_name: string, factory?: (tui: UI) => unknown) { factory?.(root); } } } as unknown as ExtensionContext;
  const pi = { on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, callback),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag() {}, getFlag() {}, getSettings: () => ({}), getThinkingLevel: () => 'off' } as unknown as ExtensionAPI;
  tidyUi(pi, { syntax: () => {
    counts.constructed++;
    return { standaloneVersion: 'fixture', settings: {
      async load() { counts.load++; return { ok: true, syntaxTheme: { kind: 'pi' } }; },
      async update() { counts.saves++; return { ok: true }; } },
      provider: { async tryShared() { counts.shared++; return undefined; }, async acquireOwned() { counts.owned++; throw Error('fixture unavailable'); } } };
  } });
  const stop = async () => { await events.get('session_shutdown')!({}, ctx); await settled(); };
  cleanups.push(stop);
  return { root, ctx, counts, actions, notices, start: () => events.get('session_start')!({}, ctx),
    command: (args: string) => commands.get('tidy-ui')!.handler(args, ctx) };
}
async function settled() { for (let i = 0; i < 5; i++) await turn(); }
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test('entry starts syntax only asynchronously after eligible interactive adapter attachment', async () => {
  const h = fixture(); assert.deepEqual(h.counts, { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 });
  h.start(); assert.equal(h.counts.constructed, 1); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 0);
  await settled(); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1); assert.equal(h.counts.owned, 1);
  h.start(); h.root.render(80); await settled(); assert.equal(h.counts.constructed, 1); assert.equal(h.counts.shared, 1);
});

test('entry print/json/rpc modes and syntax commands construct no syntax owner', async () => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = fixture(mode); h.start(); await h.command('syntax'); await settled();
    assert.equal(h.counts.constructed, 0); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 0);
    assert.match(h.notices.at(-1)!, /terminal mode/);
  }
});

test('entry native session disable survives master off/on without persistence or provider activation', async () => {
  const h = fixture(); h.start(); await settled();
  h.actions.push('Disable for this session', 'Close'); await h.command('syntax');
  await h.command('off'); const before = { ...h.counts };
  await h.command('on'); await settled();
  assert.equal(h.counts.constructed, before.constructed + 1); assert.equal(h.counts.load, before.load + 1);
  assert.equal(h.counts.shared, before.shared); assert.equal(h.counts.owned, before.owned); assert.equal(h.counts.saves, 0);
});

test('entry menu while master-off may read preference, never starts provider', async () => {
  const h = fixture(); await h.command('off'); h.actions.push('Service status', 'Close'); await h.command('syntax'); await settled();
  assert.equal(h.counts.constructed, 1); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 0); assert.equal(h.counts.owned, 0);
  assert.ok(h.notices.some(message => message.includes('pi-tidy-ui presentation is off.')));
});

test('entry uses prepared file path and preserves actual SDK args/results on warm and resized frames', async () => {
  const h = fixture();
  const tool = new ToolExecutionComponent('write', 'entry-write', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    createWriteToolDefinition('/tmp'), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const args = JSON.stringify(Reflect.get(tool, 'args')), result = JSON.stringify(Reflect.get(tool, 'result'));
  const original = SourceController.prototype.installPiBridge;
  let stores = 0, inRender = false, storesInRender = 0;
  SourceController.prototype.installPiBridge = function (...parameters) {
    stores++; if (inRender) storesInRender++;
    return original.apply(this, parameters);
  };
  const render = (width: number) => { inRender = true; try { return h.root.render(width); } finally { inRender = false; } };
  try {
    h.start(); render(80); assert.equal(stores, 0); await settled(); const before = { ...h.counts };
    assert.equal(stores, 1, 'one prepared public Pi bridge, not the legacy render classifier');
    for (const width of [80, 60, 100, 80]) render(width);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(stores, 1); assert.equal(storesInRender, 0);
    assert.equal(JSON.stringify(Reflect.get(tool, 'args')), args); assert.equal(JSON.stringify(Reflect.get(tool, 'result')), result);
  } finally { SourceController.prototype.installPiBridge = original; }
});
