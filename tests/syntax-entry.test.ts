import './fixtures/test-guard.mjs';
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

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const cleanups: (() => Promise<void>)[] = [];
function fixture(mode = 'tui', logging: false | Omit<JournalOptions, 'warn'> = false) {
  const root = new UI(), events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const counts = { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 }, actions: (string | undefined)[] = [], notices: string[] = [];
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp', isIdle: () => true,
    sessionManager: { getSessionId: () => 'entry-fixture', getSessionFile: () => '/example/entry-fixture.jsonl',
      getSessionName: () => { throw Error('Logging must not scan history for a session name'); } }, ui: { theme: themes.theme,
      getEditorComponent: () => undefined, select: async () => actions.shift(), notify: (message: string) => notices.push(message),
      setWidget(_name: string, factory?: (tui: UI) => unknown) { factory?.(root); } } } as unknown as ExtensionContext;
  const pi = { on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, callback),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag() {}, getFlag() {}, getSettings: () => ({}), getThinkingLevel: () => 'off' } as unknown as ExtensionAPI;
  tidyUi(pi, { logging, syntax: () => {
    counts.constructed++;
    return { standaloneVersion: 'fixture', settings: {
      async load() { counts.load++; return { ok: true, syntaxTheme: { kind: 'pi' } }; },
      async update() { counts.saves++; return { ok: true }; } },
      provider: { async tryShared() { counts.shared++; return undefined; }, async acquireOwned() { counts.owned++; throw Error('fixture unavailable'); } } };
  } });
  const stop = async () => { await events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, ctx); await settled(); };
  cleanups.push(stop);
  return { root, ctx, counts, actions, notices, events, start: (event: unknown = { type: 'session_start', reason: 'startup' }) => events.get('session_start')!(event, ctx),
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


test('entry logging controls use public session metadata, remain alive while presentation is off, and contain no bodies', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-entry-log-'));
  const h = fixture('tui', { root: directory });
  try {
    h.start(); await settled();
    await h.events.get('session_info_changed')!({ name: 'Readable session' }, h.ctx);
    await h.command('logs');
    assert.match(h.notices.at(-1)!, /entry-fixture/);
    assert.match(h.notices.at(-1)!, /Readable session/);
    await h.command('off');
    await h.command('logs snapshot');
    assert.match(h.notices.at(-1)!, /snapshot/i);
    await h.command('logs off');
    assert.match(h.notices.at(-1)!, /off/i);
    await h.command('logs on');
    await h.command('logs snapshot');
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
    assert.match(h.notices.at(-1)!, /Usage:.*logs/u);
    assert.deepEqual(await fs.readdir(directory), filesBefore);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('entry logging escapes UI session metadata and separates switch/resume/reload runs without history scans', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-session-events-')), h = fixture('tui', { root });
  try {
    h.start(); await h.command('logs snapshot'); const first = debugLoggingDiagnostics()!;
    assert.equal(first.session, 'entry-fixture'); assert.equal(first.state, 'active');
    await h.events.get('session_info_changed')!({ name: 'name\nforged\x1b[31m' }, h.ctx);
    await h.command('logs'); assert.match(h.notices.at(-1)!, /name\\nforged\\x1b\[31m/);
    assert.equal(h.notices.at(-1)!.includes('name\nforged'), false);
    h.start(); await h.command('logs snapshot'); assert.equal(debugLoggingDiagnostics()!.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'resume' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'other-session' });
    h.start({ type: 'session_start', reason: 'resume' }); await h.command('logs snapshot'); const second = debugLoggingDiagnostics()!;
    assert.equal(second.session, 'other-session'); assert.notEqual(second.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'entry-fixture' });
    h.start({ type: 'session_start', reason: 'resume' }); await h.command('logs snapshot'); const resumed = debugLoggingDiagnostics()!;
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
    h.start(); await h.command('logs snapshot'); await settled(); const before = { ...h.counts }, initial = debugLoggingDiagnostics()!;
    await h.command('logs off'); const disabled = debugLoggingDiagnostics()!;
    await h.command('logs snapshot'); assert.match(h.notices.at(-1)!, /snapshot not written.*off/);
    assert.equal(debugLoggingDiagnostics()!.records, disabled.records); assert.equal(debugLoggingDiagnostics()!.writes, disabled.writes);
    await h.command('logs on'); refuse = true;
    await h.command('logs snapshot'); assert.match(h.notices.at(-1)!, /snapshot not written.*ENOSPC/);
    const failed = debugLoggingDiagnostics()!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.pendingBytes, 0); assert.equal(failed.inFlightBytes, 0); assert.equal(failed.timer, false);
    assert.equal(h.notices.filter(message => message.includes('Debug logging stopped')).length, 1);
    assert.equal(h.notices.some(message => message.includes('PRIVATE_DISK_ERROR_BODY')), false);
    for (let i = 0; i < 50; i++) h.root.render(80);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(debugLoggingDiagnostics()!.writes, failed.writes);
    refuse = false; await h.command('logs on'); await h.command('logs snapshot');
    assert.equal(debugLoggingDiagnostics()!.state, 'active'); assert.equal(debugLoggingDiagnostics()!.run, initial.run);
    assert.notEqual(debugLoggingDiagnostics()!.path, initial.path); assert.deepEqual(h.counts, before);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('logging review H3: explicit snapshot includes existing Git and owned fallback-animation aggregates', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-snapshot-')), h = fixture('tui', { root });
  try {
    h.start(); await h.command('logs snapshot'); const status = debugLoggingDiagnostics()!;
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
    h.start(); await settled();
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
