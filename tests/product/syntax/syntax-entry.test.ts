import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalOptions } from '../../../src/debug-log.ts';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Container, colorToHex } from '@earendil-works/pi-tui';
import { Theme, createWriteToolDefinition, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import tidyUi, { debugLoggingDiagnostics } from '../../../src/index.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { CardSources, type CardDisplayInput } from '../../../src/syntax/cards.ts';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { ExpectedOwnedUnavailable } from '../../../src/occipital/owned-startup.ts';
import { samplePiCardPalette } from '../../../src/syntax/pi-palette.ts';
import { menuPage, withMenu, setAppearance, setLogging } from '../../helpers/menu-driver.ts';
import { ExtensionSettings, type SettingsLoadResult, type SettingsPatch, type LocalPreferences } from '../../../src/settings.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const cleanups: (() => Promise<void>)[] = [];
function fixture(mode = 'tui', logging: false | Omit<JournalOptions, 'warn' | 'enabled'> = false,
  settings?: Pick<ExtensionSettings, 'load' | 'update'> & Partial<Pick<ExtensionSettings, 'watch'>>,
  localPreferences: LocalPreferences = { appearanceEnabled: true, loggingEnabled: true }) {
  const root = new UI(), events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const counts = { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 }, notices: string[] = [];
  let saved: SettingsLoadResult = { ok: true, syntaxTheme: { kind: 'pi' } }, view = '';
  const store = settings ?? { async load() { counts.load++; return { ...saved }; },
    async update(patch: SettingsPatch) { counts.saves++; saved = { ...saved, ...patch }; return { ok: true as const }; } };
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp', isIdle: () => true,
    sessionManager: { getSessionId: () => 'entry-fixture', getSessionFile: () => '/example/entry-fixture.jsonl',
      getSessionName: () => { throw Error('Logging must not scan history for a session name'); } }, ui: { theme: themes.theme,
      getEditorComponent: () => undefined, notify: (message: string) => notices.push(message),
      setWidget(_name: string, factory?: (tui: UI) => unknown) { factory?.(root); } } } as unknown as ExtensionContext;
  const pi = { on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, callback),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag() {}, getFlag() {}, getSettings: () => ({}), getThinkingLevel: () => 'off' } as unknown as ExtensionAPI;
  tidyUi(pi, { logging, settings: store, localPreferences, terminalDefaults: {}, syntax: () => {
    counts.constructed++;
    return { standaloneVersion: 'fixture',
      provider: { async tryShared() { counts.shared++; return undefined; }, async acquireOwned() { counts.owned++; throw new ExpectedOwnedUnavailable(); } } };
  } });
  const command = (args: string) => commands.get('tidy-ui')!.handler(args, ctx);
  const stop = async () => { await events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, ctx); await settled(); };
  cleanups.push(stop);
  return { root, ctx, counts, notices, events, stop, get view() { return view; },
    start: (event: unknown = { type: 'session_start', reason: 'startup' }) => events.get('session_start')!(event, ctx), command,
    async page(...path: string[]) { return view = await menuPage(commands.get('tidy-ui')!.handler, ctx, path); },
    async appearance(value: boolean) { return view = await setAppearance(commands.get('tidy-ui')!.handler, ctx, value); },
    async recording(value: boolean) { return view = await setLogging(commands.get('tidy-ui')!.handler, ctx, value); } };
}
async function settled() { for (let i = 0; i < 5; i++) await turn(); }
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test('entry starts syntax only asynchronously after eligible interactive adapter attachment', async () => {
  const h = fixture(); assert.deepEqual(h.counts, { constructed: 0, load: 1, saves: 0, shared: 0, owned: 0 });
  const starting = h.start(); assert.equal(h.counts.constructed, 0); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 1);
  await starting; assert.equal(h.counts.constructed, 1);
  await settled(); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1); assert.equal(h.counts.owned, 1);
  await h.start(); h.root.render(80); await settled(); assert.equal(h.counts.constructed, 1); assert.equal(h.counts.shared, 1);
});

test('entry print/json/rpc modes restore preferences for logging but never construct syntax or open a menu', async () => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = fixture(mode); await h.start(); await h.command(''); await settled();
    assert.equal(h.counts.constructed, 0); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 1);
    assert.match(h.notices.at(-1)!, /terminal mode/);
  }
});

test('entry native disable is saved and survives master off/on without provider reactivation or duplicate loads', async () => {
  const h = fixture(); await h.start(); await settled();
  await h.page('Status & troubleshooting', 'Use Occipital highlighting');
  assert.equal(h.counts.saves, 1);
  await h.appearance(false); const before = { ...h.counts };
  await h.appearance(true); await settled();
  assert.equal(h.counts.constructed, before.constructed + 1); assert.equal(h.counts.load, before.load);
  assert.equal(h.counts.shared, before.shared); assert.equal(h.counts.owned, before.owned); assert.equal(h.counts.saves, 1);
});

test('entry root/status while master-off never construct syntax; theme page never starts a provider', async () => {
  const h = fixture(); await h.appearance(false);
  await h.page('Status & troubleshooting', 'Highlighting service details');
  assert.equal(h.counts.constructed, 0); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 0);
  await h.page('Code color theme'); await settled();
  assert.equal(h.counts.constructed, 1); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 0); assert.equal(h.counts.owned, 0);
});

test('entry uses prepared file path and preserves actual SDK args/results on warm and resized frames', async () => {
  const h = fixture();
  const tool = new ToolExecutionComponent('write', 'entry-write', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    createWriteToolDefinition('/tmp'), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const args = JSON.stringify(Reflect.get(tool, 'args')), result = JSON.stringify(Reflect.get(tool, 'result'));
  const original = SourceController.prototype.adoptPiFlat;
  let stores = 0, inRender = false, storesInRender = 0;
  SourceController.prototype.adoptPiFlat = function (...parameters) {
    stores++; if (inRender) storesInRender++;
    return original.apply(this, parameters);
  };
  const render = (width: number) => { inRender = true; try { return h.root.render(width); } finally { inRender = false; } };
  try {
    await h.start(); render(80); assert.equal(stores, 0); await settled(); const before = { ...h.counts };
    assert.equal(stores, 1, 'one prepared public Pi bridge, not the legacy render classifier');
    for (const width of [80, 60, 100, 80]) render(width);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(stores, 1); assert.equal(storesInRender, 0);
    assert.equal(JSON.stringify(Reflect.get(tool, 'args')), args); assert.equal(JSON.stringify(Reflect.get(tool, 'result')), result);
  } finally { SourceController.prototype.adoptPiFlat = original; }
});


test('entry projects trusted terminal backgrounds into prepared Pi input without replacing public foreground bindings', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-entry-colors-')), path = join(directory, 'theme.json');
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string> = {}, bg: Record<string, string> = {}, stock: Theme = themes.getThemeByName('dark')!;
  for (const [role, color] of Object.entries(stock.colors))
    (backgrounds.has(role) ? bg : fg)[role] = colorToHex(color);
  Object.assign(fg, { text: '', toolOutput: '#eeeeee', dim: '', muted: '', toolDiffAdded: '#00ff00', toolDiffRemoved: '#ff0000' });
  for (const role of Object.keys(fg)) if (role.startsWith('syntax')) fg[role] = '#eeeeee';
  Object.assign(bg, { toolPendingBg: '', toolSuccessBg: '#2d4935', toolErrorBg: '#492d35' });
  themes.setTerminalColors({ foreground: { r: 229, g: 229, b: 231 }, background: { r: 10, g: 11, b: 12 } });
  const original = SyntaxRuntime.prototype.preparePiInput;
  try {
    for (const [background, mode] of [['#123456', 'truecolor'], ['#0a0b0c', 'truecolor'], ['#123456', '256color']] as const) {
      await fs.writeFile(path, JSON.stringify({ colors: { text: '#eeeeee' }, export: { pageBg: background } }));
      const h = fixture(), theme = new Theme(fg as never, bg as never, mode, { name: 'entry-colors', sourcePath: path, dim: ['dim', 'muted'] });
      Object.assign(h.ctx.ui, { theme });
      Object.assign(h.root, { terminalColorSchemeNotificationsEnabled: false, terminal: { start() {}, stop() {}, write() {} } });
      const nativeColors = theme.colors, nativePrefix = theme.getBgAnsi('toolPendingBg');
      const tool = new ToolExecutionComponent('write', 'entry-colors-write', { path: 'tiny.txt', content: 'TRUSTED_COLOR' }, undefined,
        createWriteToolDefinition('/tmp'), h.root as never, '/tmp');
      tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
      const samples: { roles: ReturnType<typeof samplePiCardPalette>; mode: string; foregrounds: string[] }[] = [];
      SyntaxRuntime.prototype.preparePiInput = function (input, mode, funding) {
        samples.push({ roles: samplePiCardPalette(input, mode), mode, foregrounds: (['toolOutput', 'dim', 'muted'] as const).map(role => input.getFgAnsi(role)) });
        return original.call(this, input, mode, funding);
      };
      try {
        await h.start(); await settled(); h.root.render(80); await settled();
        const rows = h.root.render(80);
        assert.ok(rows.some(row => row.includes('TRUSTED_COLOR'))); assert.ok(samples.length > 0);
        const sample = samples.at(-1)!;
        const explicit = new Theme(fg as never, { ...bg, toolPendingBg: background } as never, mode, { dim: ['dim', 'muted'] });
        const expected = samplePiCardPalette(explicit, mode);
        assert.deepEqual(sample.roles.panel.background, expected.panel.background, 'known default must not be mistaken for an unknown terminal default');
        assert.equal(sample.roles.panel.background.kind, mode === 'truecolor' ? 'rgb' : 'indexed');
        if (mode === '256color') assert.ok(rows.every(row => !/\x1b\[(?:38|48);2;/.test(row)), 'current public mode also governs projected background output');
        assert.equal(sample.roles.prompt.foreground.kind, 'terminal-default');
        assert.equal(sample.roles.prompt.attributes, 8, 'raw faint must not be reapplied to an already blended RGB');
        assert.equal(sample.mode, theme.getColorMode());
        assert.deepEqual(sample.foregrounds, (['toolOutput', 'dim', 'muted'] as const).map(role => theme.getFgAnsi(role)));
        assert.deepEqual(sample.roles.addedCode.background, expected.addedCode.background, 'known equal-default and explicit background derive the same tint');
        if (background === '#123456' && mode === 'truecolor') {
          assert.deepEqual(sample.roles.panel.background, { kind: 'rgb', r: 18, g: 52, b: 86 }, 'the declared concrete background is projected exactly');
          assert.notDeepEqual(sample.roles.addedCode.background, sample.roles.panel.background, 'known foreground constraints still admit a structural tint');
        }
        const before = samples.length;
        for (const width of [80, 60, 100, 80]) h.root.render(width);
        await settled(); assert.equal(samples.length, before, 'warm/resize never resample the public Pi bindings');
        assert.equal(theme.colors, nativeColors); assert.equal(theme.getBgAnsi('toolPendingBg'), nativePrefix);
        assert.equal(nativePrefix, '\x1b[49m'); assert.equal(colorToHex(theme.colors.toolPendingBg), '#0a0b0c');
      } finally { await h.stop(); }
    }
  } finally {
    SyntaxRuntime.prototype.preparePiInput = original; themes.setTerminalColors({});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('entry logging controls use public session metadata, remain alive while presentation is off, and contain no bodies', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-entry-log-'));
  const h = fixture('tui', { root: directory });
  try {
    await h.start(); await settled();
    await h.events.get('session_info_changed')!({ name: 'Readable session' }, h.ctx);
    await h.page('Status & troubleshooting', 'Diagnostic logs');
    assert.match(h.view, /entry-fixture/);
    assert.match(h.view, /Readable session/);
    await h.appearance(false);
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /snapshot/i);
    await h.recording(false);
    assert.match(h.view, /off/i);
    await h.recording(true);
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    const names = await fs.readdir(directory);
    assert.ok(names.every(name => /\.log(?:\.1)?$/u.test(name)), names.join(', '));
    assert.equal(names.filter(name => name.endsWith('.closed.log')).length, 1);
    const body = await fs.readFile(join(directory, names.find(name => name.endsWith('.closed.log'))!), 'utf8');
    assert.match(body, /Pi session: \/example\/entry-fixture\.jsonl/);
    assert.match(body, /Pi session name changed; name=Readable session/);
    assert.match(body, /Snapshot.*presentation=false/i);
    assert.match(body, /capture disabled/i); assert.match(body, /capture resumed/i);
    assert.match(await fs.readFile(join(directory, 'sessions.log'), 'utf8'), /session=entry-fixture/);
    const filesBefore = await fs.readdir(directory);
    await h.command('logs list');
    assert.match(h.notices.at(-1)!, /Usage:.*tidy-ui/u);
    assert.deepEqual(await fs.readdir(directory), filesBefore);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('entry logging escapes UI session metadata and separates switch/resume/reload runs without history scans', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-session-events-')), h = fixture('tui', { root });
  try {
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const first = debugLoggingDiagnostics()!;
    assert.equal(first.session, 'entry-fixture'); assert.equal(first.state, 'active');
    await h.events.get('session_info_changed')!({ name: 'name\nforged\x1b[31m' }, h.ctx);
    await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /name\\nforged\\x1b\[31m/);
    assert.equal(h.view.includes('name\nforged'), false);
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.equal(debugLoggingDiagnostics()!.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'resume' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'other-session' });
    await h.start({ type: 'session_start', reason: 'resume' }); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const second = debugLoggingDiagnostics()!;
    assert.equal(second.session, 'other-session'); assert.notEqual(second.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'entry-fixture' });
    await h.start({ type: 'session_start', reason: 'resume' }); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const resumed = debugLoggingDiagnostics()!;
    assert.equal(resumed.session, first.session); assert.notEqual(resumed.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    const common = await fs.readFile(join(root, 'sessions.log'), 'utf8');
    assert.equal((common.match(/Session started:/gu) ?? []).length, 3);
    assert.equal((common.match(/Session ended:/gu) ?? []).length, 3);
    assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.closed.log')).length, 3);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('entry logging failure and disabled snapshot are truthful, isolate presentation, and retry only on explicit on', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-entry-error-'));
  let refuse = false;
  const io = { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (refuse) throw Object.assign(Error('PRIVATE_DISK_ERROR_BODY'), { code: 'ENOSPC' });
      return writev(buffers, position);
    };
    return handle;
  } };
  const h = fixture('tui', { root, io });
  try {
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); await settled(); const before = { ...h.counts }, initial = debugLoggingDiagnostics()!;
    await h.recording(false); const disabled = debugLoggingDiagnostics()!;
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.match(h.view, /Snapshot not written.*off/i);
    assert.equal(debugLoggingDiagnostics()!.records, disabled.records); assert.equal(debugLoggingDiagnostics()!.writes, disabled.writes);
    await h.recording(true); refuse = true;
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.match(h.view, /snapshot could not be written/i); assert.match(h.view, /ENOSPC/);
    const failed = debugLoggingDiagnostics()!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.pendingBytes, 0); assert.equal(failed.inFlightBytes, 0); assert.equal(failed.timer, false);
    assert.equal(h.notices.filter(message => message.includes('Debug logging stopped')).length, 1);
    assert.equal(h.notices.some(message => message.includes('PRIVATE_DISK_ERROR_BODY')), false);
    for (let i = 0; i < 50; i++) h.root.render(80);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(debugLoggingDiagnostics()!.writes, failed.writes);
    refuse = false; await h.recording(true); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.equal(debugLoggingDiagnostics()!.state, 'active'); assert.equal(debugLoggingDiagnostics()!.run, initial.run);
    assert.notEqual(debugLoggingDiagnostics()!.path, initial.path); assert.deepEqual(h.counts, before);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('logging review H3: explicit snapshot includes existing Git and owned fallback-animation aggregates', async t => {
  let release!: () => void;
  const opening = new Promise<void>(resolve => { release = resolve; });
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-snapshot-'));
  const h = fixture('tui', { root, io: { ...fs, async open(...args: Parameters<typeof fs.open>) {
    await opening; return fs.open(...args);
  } } });
  try {
    await h.start(); assert.equal(debugLoggingDiagnostics()!.state, 'starting');
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /Snapshot not written.*unavailable/u);
    assert.equal(debugLoggingDiagnostics()!.state, 'starting');
    release();
    await t.waitFor(() => assert.equal(debugLoggingDiagnostics()!.state, 'active'));
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /Done\./u);
    const status = debugLoggingDiagnostics()!;
    const text = await fs.readFile(status.path, 'utf8');
    assert.match(text, /\[git\].*Snapshot.*queries=/);
    assert.match(text, /\[animation\].*Snapshot.*wakes=0.*requests=0/);
  } finally {
    release();
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('entry public streaming identities separate quick live abort from restored terminal cards without history lookup', async () => {
  const h = fixture(), observed: { text: string; complete: boolean }[] = [];
  const prepare = CardSources.prototype.prepare;
  CardSources.prototype.prepare = function (ticket) {
    const state = Reflect.get(ticket, 'state') as WeakRef<{ input?: CardDisplayInput }>;
    const input = state.deref()?.input;
    if (input?.kind === 'bash') observed.push({ text: String(input.args.command), complete: input.complete });
    return prepare.call(this, ticket);
  };
  const tool = (id: string, text: string) => {
    const node = new ToolExecutionComponent('bash', id, { command: text }, undefined, undefined,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(node); return node;
  };
  const abort = (node: ToolExecutionComponent) => node.updateResult({ content: [{ type: 'text', text: 'Operation aborted' }], isError: true }, false);
  const stream = async (id: string, kind: string) => {
    const message = { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: ": 'live" } }] };
    await h.events.get('message_start')!({ type: 'message_start', message }, h.ctx);
    await h.events.get('message_update')!({ type: 'message_update', message,
      assistantMessageEvent: { type: kind, contentIndex: 0, partial: message } }, h.ctx);
  };
  try {
    await h.start(); await settled();
    const restored = tool('restored', ": 'saved"); abort(restored);
    h.root.render(80); await settled();
    assert.deepEqual(observed, [{ text: ": 'saved", complete: true }]);
    const baseline = observed.length;
    for (const kind of ['toolcall_start', 'toolcall_delta', 'toolcall_end']) {
      await stream(`live-${kind}`, kind);
      const live = tool(`live-${kind}`, ": 'live");
      await h.events.get('message_end')!({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }, h.ctx);
      abort(live); h.root.render(80); await settled();
      assert.equal(observed.length, baseline, 'quick live abort starts no classifier, even before its first useful frame');
      await h.events.get('agent_end')!({ type: 'agent_end' }, h.ctx);
      h.root.removeChild(live);
      const reopened = tool(`live-${kind}`, ": 'reopened"); abort(reopened);
      h.root.render(80); await settled();
      assert.deepEqual(observed.at(-1), { text: ": 'reopened", complete: true }, 'agent-end releases only primitive live IDs; same ID/new owner is static');
      h.root.removeChild(reopened); observed.length = baseline;
    }
    for (let i = 0; i < 100; i++) h.root.render(80);
    await settled(); assert.equal(observed.length, baseline);
    assert.equal(Reflect.get(restored, 'argsComplete'), false); assert.equal(Reflect.get(restored, 'executionStarted'), false);
  } finally { CardSources.prototype.prepare = prepare; }
});

test('entry persists shared preferences; a same-process runtime restores local Off before any provider or log IO', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-preferences-entry-'));
  const file = join(directory, 'config.json'), store = new ExtensionSettings({ file });
  const local = { appearanceEnabled: true, loggingEnabled: true };
  const first = fixture('tui', { root: join(directory, 'first-logs') }, store, local);
  try {
    await first.start(); await settled();
    await first.page('Status & troubleshooting', 'Use Occipital highlighting');
    await first.page('Set terminal colors from Pi theme');
    await first.recording(false); await first.appearance(false);
    await first.page('Code color theme', 'Follow Pi theme');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { syntaxTheme: { kind: 'pi' },
      terminalColorsEnabled: false, nativeHighlightingEnabled: false });
    await first.stop();
    const nextRoot = join(directory, 'restored-logs');
    const next = fixture('tui', { root: nextRoot }, new ExtensionSettings({ file }), local);
    await next.start(); await settled();
    assert.equal(next.counts.constructed, 0); assert.equal(next.counts.shared, 0); assert.equal(next.counts.owned, 0);
    const log = debugLoggingDiagnostics()!;
    assert.equal(log.capture, false); assert.equal(log.writes, 0); assert.equal(log.scans, 0); assert.equal(log.timer, false);
    await assert.rejects(fs.stat(nextRoot), { code: 'ENOENT' });
    await next.page(); assert.match(next.view, /Tidy UI appearance\s+Off/); assert.match(next.view, /Set terminal colors from Pi theme\s+Off/);
    await next.page('Status & troubleshooting'); assert.match(next.view, /Use Occipital highlighting\s+Off/);
    assert.equal(next.counts.constructed, 0);
    await next.page('Code color theme'); assert.equal(next.counts.constructed, 1); assert.equal(next.counts.shared, 0);
    await next.appearance(true); await settled(); assert.equal(next.counts.shared, 0); assert.equal(next.counts.owned, 0);
    await next.page('Status & troubleshooting', 'Use Occipital highlighting'); await settled();
    assert.equal(next.counts.shared, 1); assert.equal(next.counts.owned, 1);
    assert.equal(debugLoggingDiagnostics()!.writes, 0); await next.stop();
  } finally { await first.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry failed switch persistence reports applied-but-unsaved without undoing the live choice', async () => {
  let saves = 0;
  const store = { async load(): Promise<SettingsLoadResult> { return { ok: true, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false }; },
    async update() { saves++; return { ok: false as const, issue: { code: 'write-failed' as const, message: 'Settings could not be saved.' } }; } };
  const h = fixture('tui', false, store); await h.start();
  await h.page('Set terminal colors from Pi theme');
  assert.match(h.view, /Set terminal colors from Pi theme\s+On/); assert.match(h.view, /Applied for now, but not saved/);
  assert.equal(saves, 1); await h.stop();
  const fresh = fixture('tui', false, store); await fresh.start(); await fresh.page();
  assert.match(fresh.view, /Set terminal colors from Pi theme\s+Off/); assert.equal(fresh.counts.constructed, 1);
});

test('entry one overlay survives native generation changes and master off/on, using the new syntax owner afterward', async () => {
  const h = fixture(); await h.start(); await settled();
  let mounts = 0;
  await withMenu(async (args, ctx) => { mounts++; await h.command(args); }, h.ctx, async menu => {
    await menu.select('Status & troubleshooting'); await menu.select('Use Occipital highlighting');
    await menu.key('\x1b'); await menu.select('Tidy UI appearance');
    assert.match(menu.text(), /Tidy UI appearance\s+Off/);
    await menu.select('Tidy UI appearance'); assert.match(menu.text(), /Tidy UI appearance\s+On/);
    await menu.select('Code color theme'); await menu.select('Follow Pi theme');
    assert.match(menu.text(), /Code color theme\s+Follow Pi/);
    assert.doesNotMatch(menu.text(), /Applying|Applied and saved|Choices are saved automatically/);
  });
  assert.equal(mounts, 1); assert.equal(h.counts.constructed, 2); assert.equal(h.counts.saves, 2);
  assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1);
});

test('entry shutdown aborts a pending switch save and closes the overlay; late completion cannot notify or restart anything', async () => {
  let release!: (value: { ok: true }) => void, signal: AbortSignal | undefined;
  const saving = new Promise<{ ok: true }>(resolve => { release = resolve; });
  const h = fixture('tui', false, {
    async load() { return { ok: true, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false }; },
    update(_patch, options) { signal = options?.signal; return saving; },
  });
  await h.start();
  await withMenu((_args, _ctx) => h.command(''), h.ctx, async menu => {
    const changing = menu.select('Set terminal colors from Pi theme'); await turn();
    assert.equal(signal?.aborted, false);
    await h.stop(); assert.equal(signal?.aborted, true);
    const before = { ...h.counts }, notices = [...h.notices];
    release({ ok: true }); await changing; await settled();
    assert.deepEqual(h.counts, before); assert.deepEqual(h.notices, notices); assert.equal(menu.text(), '');
  });
});

test('entry a retired pending initial load cannot install UI, open logs, start providers, or emit a stale warning', async () => {
  let release!: (value: SettingsLoadResult) => void;
  const loading = new Promise<SettingsLoadResult>(resolve => { release = resolve; });
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-retired-start-')), logs = join(directory, 'logs');
  const h = fixture('tui', { root: logs }, { load: () => loading, async update() { return { ok: true }; } });
  try {
    const starting = h.start(); await h.stop();
    release({ ok: false, syntaxTheme: { kind: 'pi' }, issue: { code: 'invalid-json', message: 'Settings JSON could not be read.' } });
    await starting; await settled();
    assert.deepEqual(h.counts, { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 });
    assert.equal(h.notices.length, 0); await assert.rejects(fs.stat(logs), { code: 'ENOENT' });
  } finally { await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('latest local appearance choice wins across popup reopening while older cleanup is pending without config writes', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-switch-order-'));
  const disk = new ExtensionSettings({ file: join(directory, 'config.json') });
  const saves: Promise<unknown>[] = [];
  const store = { load: () => disk.load(), update(...args: Parameters<ExtensionSettings['update']>) {
    const operation = disk.update(...args); saves.push(operation); return operation;
  } };
  let release!: () => void, entered!: () => void;
  const heldCleanup = new Promise<void>(resolve => { release = resolve; });
  const disposing = new Promise<void>(resolve => { entered = resolve; });
  const original = SyntaxRuntime.prototype.dispose; let first = true;
  SyntaxRuntime.prototype.dispose = function () {
    const stopped = original.call(this);
    if (!first) return stopped;
    first = false; entered(); return Promise.all([stopped, heldCleanup]).then(() => {});
  };
  try {
    const h = fixture('tui', false, store); await h.start(); await settled();
    await withMenu(() => h.command(''), h.ctx, async menu => {
      await menu.key('\x1b[A'); menu.input('\r'); await disposing; menu.input('\x03');
    });
    await h.appearance(true);
    assert.equal(saves.length, 0, 'local confirmation never enters the config writer while older cleanup remains held');
    release(); await settled(); await Promise.all(saves);
    assert.equal(saves.length, 0, 'neither confirmation nor cleanup writes a local preference');
    await assert.rejects(fs.stat(disk.file), { code: 'ENOENT' });
    await h.page(); assert.match(h.view, /Tidy UI appearance\s+On/);
    const restored = fixture('tui', false, store); await restored.start(); await restored.page();
    assert.match(restored.view, /Tidy UI appearance\s+On/);
  } finally { release(); SyntaxRuntime.prototype.dispose = original; await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry gives the same overlay live per-page sizing without remounts or preference/provider side effects', async () => {
  const h = fixture(); await h.start(); await settled(); const before = { ...h.counts };
  let mounts = 0;
  await withMenu(async args => { mounts++; await h.command(args); }, h.ctx, async menu => {
    const root = menu.width(); assert.ok(root < 72);
    for (let i = 0; i < 10; i++) { await menu.key('\x1b[B'); assert.equal(menu.width(), root); }
    await menu.select('Status & troubleshooting'); const support = menu.width();
    assert.notEqual(support, root, 'one live options object exposes the new page width');
    await menu.select('Highlighting service details');
    assert.ok(menu.width() < 50);
    await menu.key('\x1b'); assert.equal(menu.width(), support);
    await menu.key('\x1b'); assert.equal(menu.width(), root);
  });
  assert.equal(mounts, 1); assert.deepEqual(h.counts, before);
});


test('entry discards an unconfirmed theme preview when a session shuts down and constructs its next runtime', async () => {
  let saves = 0;
  const original = { kind: 'occipital' as const, id: 'saved-independent-theme' };
  const h = fixture('tui', false, { load: async () => ({ ok: true, syntaxTheme: original }),
    update: async () => { saves++; return { ok: true }; } });
  await h.start(); await settled();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme');
    assert.match(menu.text(), /Selected: saved-independent-theme/);
    // The missing native choice is intentionally not fabricated as a row.
    await menu.key('\x1b[A'); await menu.key('\x1b[B');
    assert.match(menu.text(), /Selected: Follow Pi/);
    assert.equal(saves, 0);
    await h.stop();
  });
  await h.start({ type: 'session_start', reason: 'resume' }); await settled();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme');
    assert.match(menu.text(), /Selected: saved-independent-theme/);
  });
  assert.equal(saves, 0);
});

test('settings policy: appearance and diagnostic recording are process-local actions without config writes', async () => {
  const h = fixture(); await h.start();
  await h.appearance(false); await h.recording(false);
  assert.equal(h.counts.saves, 0);
  await h.page(); assert.match(h.view, /Tidy UI appearance\s+Off/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Record diagnostic logs\s+Off/);
});

test('settings sync: external shared fields apply without saves, local flags stay local, and retired callbacks cannot act', async () => {
  let changed!: (value: SettingsLoadResult) => void, stops = 0, saves = 0;
  const h = fixture('tui', false, { load: async () => ({ ok: true, syntaxTheme: { kind: 'pi' } }),
    async update() { saves++; return { ok: true }; }, watch(callback) { changed = callback; return () => { stops++; }; } });
  await h.start(); await h.appearance(false); await h.recording(false);
  changed({ ok: true, syntaxTheme: { kind: 'occipital', id: 'peer-B' }, terminalColorsEnabled: false, nativeHighlightingEnabled: false });
  await h.page(); assert.match(h.view, /Tidy UI appearance\s+Off/); assert.match(h.view, /Set terminal colors from Pi theme\s+Off/); assert.match(h.view, /peer-B/);
  await h.page('Status & troubleshooting'); assert.match(h.view, /Use Occipital highlighting\s+Off/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Record diagnostic logs\s+Off/);
  changed({ ok: false, syntaxTheme: { kind: 'pi' }, issue: { code: 'invalid-json', message: 'Settings contain invalid JSON or UTF-8.' } });
  await h.page(); assert.match(h.view, /peer-B/); assert.equal(saves, 0);
  await h.stop(); assert.equal(stops, 1); const counts = { ...h.counts }, warnings = [...h.notices];
  changed({ ok: true, syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: true }); await settled();
  assert.deepEqual(h.counts, counts); assert.deepEqual(h.notices, warnings); assert.equal(saves, 0);
});

test('settings policy: reload restores local flags from process memory while a fresh process owner starts On', async () => {
  const memory = { appearanceEnabled: true, loggingEnabled: true };
  const first = fixture('tui', false, undefined, memory); await first.start();
  await first.appearance(false); await first.recording(false); await first.stop();
  const reloaded = fixture('tui', false, undefined, memory); await reloaded.start(); await reloaded.page();
  assert.match(reloaded.view, /Tidy UI appearance\s+Off/); assert.equal(reloaded.counts.constructed, 0);
  await reloaded.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(reloaded.view, /Record diagnostic logs\s+Off/);
  assert.equal(first.counts.saves + reloaded.counts.saves, 0); await reloaded.stop();
  const fresh = fixture(); await fresh.start(); await fresh.page();
  assert.match(fresh.view, /Tidy UI appearance\s+On/);
  await fresh.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(fresh.view, /Record diagnostic logs\s+On/);
});

test('settings sync: entry preserves an unconfirmed preview and Esc uses the latest peer confirmation without writes', async () => {
  let changed!: (value: SettingsLoadResult) => void, saves = 0;
  const h = fixture('tui', false, { load: async () => ({ ok: true, syntaxTheme: { kind: 'occipital', id: 'saved-A' } }),
    async update() { saves++; return { ok: true }; }, watch(callback) { changed = callback; return () => {}; } });
  await h.start();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme'); await menu.key('\x1b[A'); await menu.key('\x1b[B');
    assert.match(menu.text(), /Selected: Follow Pi/);
    changed({ ok: true, syntaxTheme: { kind: 'occipital', id: 'peer-B' } }); await settled();
    assert.match(menu.text(), /Selected: Follow Pi/); assert.equal(saves, 0);
    await menu.key('\x1b'); assert.match(menu.text(), /peer-B/);
  });
  assert.equal(saves, 0);
});

test('entry shutdown keeps prepared card presentation during cleanup and fully unhooks before return', async () => {
  const h = fixture();
  const tool = new ToolExecutionComponent('write', 'shutdown-write', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    createWriteToolDefinition('/tmp'), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const native = ToolExecutionComponent.prototype.render;
  await h.start(); h.root.render(80); await settled(); const before = h.root.render(80);
  assert.notEqual(ToolExecutionComponent.prototype.render, native);
  const dispose = SyntaxRuntime.prototype.dispose;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  SyntaxRuntime.prototype.dispose = function () { const stopped = dispose.call(this); return Promise.all([stopped, gate]).then(() => {}); };
  const stopping = h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx) as Promise<void>;
  try {
    await settled();
    assert.notEqual(ToolExecutionComponent.prototype.render, native, 'only our own hooks remain until cleanup finishes');
    assert.deepEqual(h.root.render(80), before, 'unchanged prepared content does not switch to native while cleanup waits');
    const progress = { render: () => ['CLEANUP_PROGRESS'], invalidate() {} }; h.root.addChild(progress);
    assert.ok(h.root.render(80).some(row => row.includes('CLEANUP_PROGRESS')), 'normal host updates remain visible');
    tool.updateResult({ content: [{ type: 'text', text: 'CLEANUP_ERROR' }], isError: true }, false);
    assert.ok(h.root.render(80).some(row => row.includes('CLEANUP_ERROR')), 'changed content is never hidden by old rows');
  } finally { release(); await stopping; SyntaxRuntime.prototype.dispose = dispose; }
  assert.equal(ToolExecutionComponent.prototype.render, native, 'no visual hooks survive shutdown return');
});

test('entry shutdown restores hooks and closes the journal even if source cleanup fails', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-shutdown-error-')), h = fixture('tui', { root: directory });
  const native = ToolExecutionComponent.prototype.render, dispose = SyntaxRuntime.prototype.dispose;
  const tool = new ToolExecutionComponent('write', 'shutdown-error', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    createWriteToolDefinition('/tmp'), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  await h.start(); await settled(); const failure = Error('source cleanup failed');
  SyntaxRuntime.prototype.dispose = function () { return dispose.call(this).then(() => { throw failure; }); };
  try {
    await assert.rejects(h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx) as Promise<void>, error => error === failure);
    assert.equal(ToolExecutionComponent.prototype.render, native);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.closed.log')).length, 1);
  } finally { SyntaxRuntime.prototype.dispose = dispose; await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry preloads preferences before startup and attaches without another asynchronous gap', async () => {
  const h = fixture(); await settled();
  assert.equal(h.counts.load, 1); assert.equal(h.counts.constructed, 0);
  const starting = h.start();
  assert.equal(h.counts.constructed, 1, 'loaded factory preferences do not defer UI attachment until another turn');
  await starting; assert.equal(h.counts.load, 1);
});

test('runtime health entry: settings errors are visible with recording unavailable, recover on valid read, and reset for a new session', async () => {
  let changed!: (value: SettingsLoadResult) => void;
  const h = fixture('tui', false, { async load() { return { ok: true, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false }; },
    async update() { return { ok: true }; }, watch(callback) { changed = callback; return () => {}; } });
  await h.start(); await settled();
  const before = h.notices.length;
  const bad: SettingsLoadResult = { ok: false, syntaxTheme: { kind: 'pi' }, issue: { code: 'invalid-json', message: 'PRIVATE_CONFIG_DETAIL' } };
  changed(bad); changed(bad); await settled();
  assert.equal(h.notices.length, before + 1); assert.doesNotMatch(h.notices.at(-1)!, /PRIVATE_CONFIG_DETAIL/);
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  assert.match(h.view, /Diagnostic logging is unavailable/);
  changed({ ok: true, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false }); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 0/); assert.match(h.view, /recovered/);
  await h.stop();
  const after = h.notices.length; changed(bad); await settled(); assert.equal(h.notices.length, after, 'old watcher cannot report after shutdown');
  await h.start({ type: 'session_start', reason: 'resume' }); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 0; active: 0/);
});

test('runtime health entry: explicit appearance Off and reinstallation retire the old failed owner without GC', async () => {
  const h = fixture('tui', false, { async load() { return { ok: true, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false }; }, async update() { return { ok: true }; } });
  const foreign = Object.assign(new Container(), { toolCallId: 'incompatible', toolName: 'bash' });
  h.root.addChild(foreign); await h.start(); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  await h.appearance(false); await h.page('Status & troubleshooting');
  assert.match(h.view, /Runtime errors: 1; active: 0/); assert.match(h.view, /owner removed/);
  h.root.removeChild(foreign); await h.appearance(true); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 0/);
  h.root.addChild(foreign); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 2; active: 1/);
  h.root.removeChild(foreign); await h.page('Status & troubleshooting', 'Reapply Tidy UI appearance'); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 2; active: 0/); assert.match(h.view, /owner removed/);
});
