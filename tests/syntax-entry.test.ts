import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalOptions } from '../src/debug-log.ts';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Container } from '@earendil-works/pi-tui';
import { createWriteToolDefinition, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import tidyUi, { debugLoggingDiagnostics } from '../src/index.ts';
import { SourceController } from '../src/occipital/controller.ts';
import { CardSources, type CardSourceHost } from '../src/syntax/cards.ts';
import { SyntaxRuntime } from '../src/syntax/runtime.ts';
import { menuPage, withMenu, setAppearance, setLogging } from './helpers/menu-driver.ts';
import { ExtensionSettings, type SettingsLoadResult, type SettingsPatch } from '../src/settings.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const cleanups: (() => Promise<void>)[] = [];
function fixture(mode = 'tui', logging: false | Omit<JournalOptions, 'warn' | 'enabled'> = false,
  settings?: Pick<ExtensionSettings, 'load' | 'update'>) {
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
  tidyUi(pi, { logging, settings: store, syntax: () => {
    counts.constructed++;
    return { standaloneVersion: 'fixture',
      provider: { async tryShared() { counts.shared++; return undefined; }, async acquireOwned() { counts.owned++; throw Error('fixture unavailable'); } } };
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
  const h = fixture(); assert.deepEqual(h.counts, { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 });
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
  assert.equal(h.counts.shared, before.shared); assert.equal(h.counts.owned, before.owned); assert.equal(h.counts.saves, 3);
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
  const original = SourceController.prototype.installPiBridge;
  let stores = 0, inRender = false, storesInRender = 0;
  SourceController.prototype.installPiBridge = function (...parameters) {
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
  } finally { SourceController.prototype.installPiBridge = original; }
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
    await settled(); assert.deepEqual(h.counts, { ...before, saves: before.saves + 2 }); assert.equal(debugLoggingDiagnostics()!.writes, failed.writes);
    refuse = false; await h.recording(true); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.equal(debugLoggingDiagnostics()!.state, 'active'); assert.equal(debugLoggingDiagnostics()!.run, initial.run);
    assert.notEqual(debugLoggingDiagnostics()!.path, initial.path); assert.deepEqual(h.counts, { ...before, saves: before.saves + 2 });
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('logging review H3: explicit snapshot includes existing Git and owned fallback-animation aggregates', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-snapshot-')), h = fixture('tui', { root });
  try {
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const status = debugLoggingDiagnostics()!;
    const text = await fs.readFile(status.path, 'utf8');
    assert.match(text, /\[git\].*Snapshot.*queries=/);
    assert.match(text, /\[animation\].*Snapshot.*wakes=0.*requests=0/);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('entry public streaming identities separate quick live abort from restored terminal cards without history lookup', async () => {
  const h = fixture(), observed: { text: string; complete: boolean }[] = [];
  const drain = CardSources.prototype.drain;
  CardSources.prototype.drain = function () {
    const host = Reflect.get(this, 'host') as CardSourceHost<object>, read = host.read;
    host.read = owner => { const input = read(owner);
      if (input?.kind === 'bash') observed.push({ text: String(input.args.command), complete: input.complete });
      return input;
    };
    try { return drain.call(this); } finally { host.read = read; }
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
  } finally { CardSources.prototype.drain = drain; }
});

test('entry persists every switch and theme through the popup; a fresh runtime restores Off before any provider or log IO', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-preferences-entry-'));
  const file = join(directory, 'config.json'), store = new ExtensionSettings({ file });
  const first = fixture('tui', { root: join(directory, 'first-logs') }, store);
  try {
    await first.start(); await settled();
    await first.page('Status & troubleshooting', 'Use Occipital highlighting');
    await first.page('Set terminal colors from Pi theme');
    await first.recording(false); await first.appearance(false);
    await first.page('Code color theme', 'Follow Pi theme');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { syntaxTheme: { kind: 'pi' },
      appearanceEnabled: false, terminalColorsEnabled: false, nativeHighlightingEnabled: false, loggingEnabled: false });
    await first.stop();
    const nextRoot = join(directory, 'restored-logs');
    const next = fixture('tui', { root: nextRoot }, new ExtensionSettings({ file }));
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
  const store = { async load(): Promise<SettingsLoadResult> { return { ok: true, syntaxTheme: { kind: 'pi' }, appearanceEnabled: false }; },
    async update() { saves++; return { ok: false as const, issue: { code: 'write-failed' as const, message: 'Settings could not be saved.' } }; } };
  const h = fixture('tui', false, store); await h.start();
  await h.appearance(true);
  assert.match(h.view, /Tidy UI appearance\s+On/); assert.match(h.view, /Applied for now, but not saved/);
  assert.equal(saves, 1); await h.stop();
  const fresh = fixture('tui', false, store); await fresh.start(); await fresh.page();
  assert.match(fresh.view, /Tidy UI appearance\s+Off/); assert.equal(fresh.counts.constructed, 0);
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
  assert.equal(mounts, 1); assert.equal(h.counts.constructed, 2); assert.equal(h.counts.saves, 4);
  assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1);
});

test('entry shutdown aborts a pending switch save and closes the overlay; late completion cannot notify or restart anything', async () => {
  let release!: (value: { ok: true }) => void, signal: AbortSignal | undefined;
  const saving = new Promise<{ ok: true }>(resolve => { release = resolve; });
  const h = fixture('tui', false, {
    async load() { return { ok: true, syntaxTheme: { kind: 'pi' }, appearanceEnabled: false }; },
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

test('latest confirmed switch wins across popup reopening while older cleanup is pending', async () => {
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
    assert.equal((await disk.load()).appearanceEnabled, true, 'new confirmation is saved while older cleanup remains held');
    release(); await settled(); await Promise.all(saves);
    assert.equal(saves.length, 2, 'one save per explicit confirmation, no cleanup-time rewrite');
    assert.equal((await disk.load()).appearanceEnabled, true, 'older completion cannot overwrite the newer preference');
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
