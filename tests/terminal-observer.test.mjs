import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInputs } from '../scripts/test/context.mjs';
import { planTerminalObserver } from './fixtures/terminal-observer-plan.mjs';
import { installTerminalObserver } from './fixtures/terminal-observer.mjs';
import { PiTerminal, observeNativeReceipts, observeRenderFrames } from './fixtures/terminal-harness.mjs';
import xterm from '@xterm/headless';

function fixture(t, paint = () => 'NATIVE_FRAME') {
  class Mode {
    constructor() {
      this.pendingUserInputs = [];
      this.lastSigintTime = 0;
      this.defaultEditor = this.editor = {};
      this.ui = {};
    }
    mountInteractiveTui(tui) { this.renderer = tui; }
    setupEditorSubmitHandler() {
      this.defaultEditor.onSubmit = text => {
        if (this.direct) return this.direct(text);
        if (this.onInputCallback) this.onInputCallback(text);
        else this.pendingUserInputs.push(text);
        return Promise.resolve();
      };
    }
    getUserInput() {
      if (this.pendingUserInputs.length) return Promise.resolve(this.pendingUserInputs.shift());
      return new Promise(resolve => { this.onInputCallback = text => { this.onInputCallback = undefined; resolve(text); }; });
    }
  }
  const restore = installTerminalObserver(Mode, { restorable: true });
  t.after(restore);
  const packets = [], writes = [];
  function renderer() {
    return {
      renderRequested: false, renderTimer: undefined, immediateRenderScheduled: false, stopped: false,
      columns: 80, rows: 24,
      terminal: { columns: 80, rows: 24, write(data) {
        writes.push(data);
        const match = /^\x1b\]777;tidy-test;([^\x07]+)\x07$/.exec(data);
        if (match) packets.push(JSON.parse(Buffer.from(match[1], 'base64').toString()));
      } },
      addInputListener(listener) { this.listener = listener; return () => { this.listener = undefined; }; },
      doRender() {
        this.renderRequested = false;
        this.renderTimer = undefined;
        this.immediateRenderScheduled = false;
        this.terminal.write(`\x1b[?2026h${paint()}\x1b[?2026l`);
      },
    };
  }
  const mode = new Mode(), first = renderer();
  mode.mountInteractiveTui(first);
  mode.setupEditorSubmitHandler();
  first.doRender();
  return { mode, first, packets, writes, renderer,
    input(id, kind = 0, tui = mode.renderer) { return tui.listener(`\x1b[?997;${id};${kind}n`); },
    async packet(id, type = 'frame') {
      await t.waitFor(() => assert.ok(packets.some(packet => packet.id === id && packet.type === type)));
      return packets.find(packet => packet.id === id && packet.type === type);
    },
  };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('observer plan locates the actual selected CLI class through its import graph', () => {
  const inputs = readInputs(), plan = planTerminalObserver(inputs);
  assert.match(plan.module, /^file:/);
  assert.match(plan.binding, /^[$A-Z_a-z][$\w]*$/);
  const source = readFileSync(new URL(plan.module));
  assert.equal(plan.sha256, createHash('sha256').update(source).digest('hex'));
  assert.ok(plan.visited.includes(pathToFileURL(inputs.pi.cli).href));
  assert.notEqual(plan.module, pathToFileURL(join(inputs.pi.root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js')).href,
    'the bundled CLI must not silently instrument the separate SDK class');
});

test('frame fences wait for the native pending frame and never request one themselves', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  h.first.renderRequested = true;
  h.first.renderTimer = {};
  assert.deepEqual(h.input(1), { consume: true });
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 1), false);
  assert.equal(h.writes.filter(value => value.includes('NATIVE_FRAME')).length, 1);
  h.first.doRender();
  const packet = await h.packet(1);
  assert.equal(packet.frames, 2);
  assert.ok(h.writes.at(-1).includes('tidy-test'));
  h.input(2);
  assert.equal((await h.packet(2)).frames, 2, 'unchanged regular-mode frames do not need another physical write');
});

test('fences run after input listener dispatch and its follow-on microtasks', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  assert.deepEqual(h.first.listener(`TEXT\x1b[?997;3;0n`), { data: 'TEXT' });
  queueMicrotask(() => { h.first.immediateRenderScheduled = true; });
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 3), false);
  h.first.doRender();
  await h.packet(3);
});

test('a queued extension command completes at the next native input-loop entry, not onSubmit resolution', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  h.input(4, 1);
  await h.packet(4, 'armed');
  h.mode.defaultEditor.onSubmit('/command');
  h.input(4, 2);
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 4 && packet.type === 'frame'), false);
  h.mode.getUserInput();
  await h.packet(4);
});

test('a direct command preserves native promise identity and waits for its real completion', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let complete;
  const original = new Promise(resolve => { complete = resolve; });
  h.mode.direct = () => original;
  h.input(5, 1);
  await h.packet(5, 'armed');
  assert.equal(h.mode.defaultEditor.onSubmit('/reload'), original);
  h.input(5, 2);
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 5 && packet.type === 'frame'), false);
  complete();
  await h.packet(5);
});

test('an open popup does not block an unrelated frame fence', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let close;
  h.mode.direct = () => new Promise(resolve => { close = resolve; });
  h.input(6, 1);
  await h.packet(6, 'armed');
  const popup = h.mode.defaultEditor.onSubmit('/popup');
  h.input(7);
  await h.packet(7);
  close();
  await popup;
});

test('renderer replacement rejects stale frame authority and retains an outstanding reload operation', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let complete;
  h.mode.direct = () => new Promise(resolve => { complete = resolve; });
  h.input(8, 1);
  await h.packet(8, 'armed');
  h.mode.defaultEditor.onSubmit('/reload');
  h.input(8, 2);
  const second = h.renderer();
  second.renderRequested = true;
  h.mode.mountInteractiveTui(second);
  complete();
  h.first.doRender();
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 8 && packet.type === 'frame'), false);
  second.doRender();
  assert.equal((await h.packet(8)).generation, 2);
});

test('autocomplete completion is observed without invoking or replacing native work', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let finish;
  const task = new Promise(resolve => { finish = resolve; });
  h.mode.editor.autocompleteRequestTask = task;
  h.input(9);
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 9), false);
  assert.equal(h.mode.editor.autocompleteRequestTask, task);
  h.first.renderRequested = true;
  finish();
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 9), false);
  h.first.doRender();
  await h.packet(9);
});

test('an obsolete autocomplete completion cannot release a newer pending request', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let finishOld, finishCurrent;
  h.mode.editor.autocompleteRequestTask = new Promise(resolve => { finishOld = resolve; });
  h.input(10);
  await turn();
  h.mode.editor.autocompleteRequestTask = new Promise(resolve => { finishCurrent = resolve; });
  h.input(11);
  await turn();
  finishOld();
  await turn(); await turn();
  assert.equal(h.packets.some(packet => packet.type === 'frame' && [10, 11].includes(packet.id)), false);
  finishCurrent();
  await h.packet(10);
  await h.packet(11);
});

test('a replaced editor does not inherit an obsolete autocomplete wait', async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  let finish;
  h.mode.editor.autocompleteRequestTask = new Promise(resolve => { finish = resolve; });
  h.input(13);
  await turn();
  h.mode.editor = {};
  h.input(14);
  try {
    await h.packet(14);
    await h.packet(13);
  } finally { finish(); }
});

test('a command queued before the native input loop waits for its later execution', async t => {
  const h = fixture(t);
  h.input(12, 1);
  await h.packet(12, 'armed');
  h.mode.defaultEditor.onSubmit('/queued');
  h.input(12, 2);
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 12 && packet.type === 'frame'), false);
  h.mode.getUserInput();
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 12 && packet.type === 'frame'), false);
  h.mode.getUserInput();
  await h.packet(12);
});

for (const unfinished of [false, true]) test(`physical receipt ${unfinished ? 'rejects an unfinished' : 'follows a complete'} synchronized frame`, async t => {
  const h = Object.create(PiTerminal.prototype);
  const term = new xterm.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  t.after(() => term.dispose());
  observeRenderFrames(term, h);
  observeNativeReceipts(term, h);
  const packet = { type: 'frame', id: 20, generation: 1, frames: 1 };
  const osc = `\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`;
  const write = data => new Promise(resolve => term.write(data, resolve));
  const received = h.nativeReceipt('frame', 20);
  // Attach rejection observation before delivering an intentionally invalid receipt.
  const checked = unfinished ? assert.rejects(received, /inside synchronized output/) : received;
  await write('\x1b[?2026h\x1b[31m界TEXT\x1b[0m');
  assert.equal(h.nativeReceipts.size, 0);
  assert.equal(h.rendering, true);
  if (!unfinished) await write('\x1b[?2026l');
  await write(osc.slice(0, 19));
  assert.equal(h.nativeReceipts.size, 0, 'a partial OSC must not acknowledge a frame');
  await write(osc.slice(19));
  if (!unfinished) assert.deepEqual(await checked, packet);
  else await checked;
  assert.equal(term.buffer.active.getLine(0).translateToString(true), '界TEXT');
  assert.equal(term.buffer.active.cursorX, 6, 'receipt bytes must not change physical cursor or cells');
  assert.equal(term.buffer.active.getLine(0).getCell(2).getFgColor(), 1);
});

for (const [label, loading, loaded] of [
  ['populated resume picker', 'Loading sessions…', '› run future'],
  ['published Git branch', '~/work', '~/work:home-main'],
]) test(`loaded-screen readiness waits for ${label}, not merely the first completed frame`, async () => {
  const h = Object.create(PiTerminal.prototype);
  let rows = [loading], finished = false, barriers = 0;
  h.screen = () => rows;
  h.settle = async () => { barriers++; };
  const ready = h.waitForScreen(screen => screen.includes(loaded), label).then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  rows = [loaded];
  await ready;
  assert.ok(barriers >= 2, 'the predicate must be checked after the later physical barrier');
});

test('draft clearing sends the same native CtrlC only after its real double-interrupt window', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const h = Object.create(PiTerminal.prototype), calls = [];
  h.nativeFence = async () => ({ clearAfter: 10501 });
  h.send = data => { calls.push([data, Date.now()]); };
  h.settle = async () => { calls.push(['physical', Date.now()]); };
  const clearing = h.clearDraft();
  await turn();
  assert.deepEqual(calls, []);
  t.mock.timers.tick(500); await turn();
  assert.deepEqual(calls, [], 'a second interrupt must not fall inside the native exit interval');
  t.mock.timers.tick(1); await clearing;
  assert.deepEqual(calls, [['\x03', 10501], ['physical', 10501]]);
});

test('transport errors received during close reject only after output and terminal cleanup', async t => {
  const h = Object.create(PiTerminal.prototype), output = mkdtempSync(join(tmpdir(), 'tidy-close-error-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  Object.assign(h, { output, raw: [Buffer.from('FINAL OUTPUT')], pointerInputs: [], work: output, queue: Promise.resolve() });
  let disposed = false, readerClosed = false;
  h.term = { dispose() { disposed = true; } };
  h.rl = { close() { readerClosed = true; } };
  h.child = new EventEmitter();
  h.child.stdin = { end(message) {
    assert.equal(message, '{"stop":true}\n');
    queueMicrotask(() => { h.error = new Error('PTY tail drain exceeded 2 seconds'); h.child.emit('close'); });
  } };
  h.stderr = '';
  await assert.rejects(h.close(), /PTY tail drain exceeded/);
  assert.equal(disposed, true); assert.equal(readerClosed, true);
  assert.equal(readFileSync(join(output, 'terminal.ansi'), 'utf8'), 'FINAL OUTPUT');
});

test('unsupported native method and renderer shapes fail explicitly', t => {
  assert.throws(() => installTerminalObserver(class {}), /unsupported.*getUserInput/i);
  const h = fixture(t);
  assert.throws(() => h.mode.mountInteractiveTui({}), /unsupported.*renderer/i);
});

for (const input of ['/quit\r', '\x04']) for (const status of [0, 1, undefined])
test(`intentional quit drains the output and requires the actual successful exit receipt (${JSON.stringify(input)}, ${status})`, async () => {
  const h = Object.create(PiTerminal.prototype);
  h.nativeProgress = new EventEmitter();
  let parsed = false;
  h.queue = turn().then(() => { parsed = true; });
  h.send = data => {
    assert.equal(data, input);
    assert.equal(h.expectedPiExit, 0);
    h.piExit = status;
    h.exited = { code: 0, signal: null };
    h.closed = true;
  };
  if (status === 0) await h.quit(input);
  else await assert.rejects(h.quit(input), /actual Pi exit receipt/);
  assert.equal(parsed, true, 'normal-exit verification follows final terminal parsing');
});

test('popup selection waits for the completed physical frame instead of reading a cleared viewport', async t => {
  const h = Object.create(PiTerminal.prototype);
  h.term = new xterm.Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  t.after(() => h.term.dispose());
  observeRenderFrames(h.term, h);
  observeNativeReceipts(h.term, h);
  const write = data => h.queue = new Promise(resolve => h.term.write(data, resolve));
  let request;
  h.send = data => {
    const match = /^\x1b\[\?997;(\d+);0n$/.exec(data);
    assert.ok(match, 'selection must first await an ordered physical frame');
    request = Number(match[1]);
  };
  await write('\x1b[?2026h\x1b[2J\x1b[H');
  assert.equal(h.rendering, true);
  let finished = false;
  const selection = h.selectTidyItem('Display cache', false).then(
    row => { finished = true; return { row }; },
    error => { finished = true; return { error }; });
  await turn();
  assert.equal(finished, false, 'an intermediate empty viewport is not a missing popup selection');
  assert.ok(request, 'physical readiness is requested before inspecting the popup');
  const packet = { type: 'frame', id: request, generation: 1, frames: 1 };
  await write('→ Display cache\x1b[?2026l' +
    `\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`);
  const result = await selection;
  assert.ifError(result.error);
  assert.equal(result.row, '→ Display cache');
  assert.equal(h.rendering, false);
});


test('physical color captures wait for the complete frame and its parsed receipt', async t => {
  const h = Object.create(PiTerminal.prototype), output = mkdtempSync(join(tmpdir(), 'tidy-complete-screen-'));
  h.term = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true });
  t.after(() => { h.term.dispose(); rmSync(output, { recursive: true, force: true }); });
  Object.assign(h, { output, raw: [] });
  observeRenderFrames(h.term, h);
  observeNativeReceipts(h.term, h);
  const write = data => h.queue = new Promise(resolve => h.term.write(data, resolve));
  let request;
  h.send = data => { request = Number(/^\x1b\[\?997;(\d+);0n$/.exec(data)?.[1]); assert.ok(request); };
  await write('\x1b[?2026h\x1b[2J\x1b[H');
  let finished = false;
  const pending = h.captureCompleteScreen('preview', {}).then(
    dump => { finished = true; return { dump }; }, error => { finished = true; return { error }; });
  await turn();
  assert.equal(finished, false, 'the temporarily cleared viewport is not captured');
  await write('\x1b[H\x1b[38;2;1;2;3mTHEME_BASH_0');
  await turn();
  assert.equal(finished, false, 'even the expected new color remains provisional inside the frame');
  await write('\x1b[?2026l');
  await turn();
  assert.equal(finished, false, 'frame completion still precedes the ordered physical receipt');
  const packet = { type: 'frame', id: request, generation: 1, frames: 1 };
  await write(`\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`);
  const result = await pending;
  assert.ifError(result.error);
  assert.equal(result.dump.screen[0], 'THEME_BASH_0');
  assert.equal(result.dump.cells[0][0].fg, 0x010203);
});


test('reload completion follows the native submit promise when an unchanged status is not repainted', async t => {
  let phase = 'initial', release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = fixture(t, () => phase === 'initial'
    ? '\x1b[HReloaded keybindings'
    : phase === 'loading' ? '\x1b[2;1HReloading keybindings' : '\x1b[2;1H\x1b[2K');
  const host = Object.create(PiTerminal.prototype);
  host.term = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  host.raw = []; host.queue = Promise.resolve();
  t.after(() => host.term.dispose());
  observeRenderFrames(host.term, host); observeNativeReceipts(host.term, host);
  const write = h.first.terminal.write;
  h.first.terminal.write = data => {
    write(data); host.raw.push(Buffer.from(data));
    host.queue = new Promise(resolve => host.term.write(data, resolve));
  };
  host.send = data => {
    if (data === '/reload\r') h.mode.defaultEditor.onSubmit('/reload');
    else h.first.listener(data);
  };
  h.mode.direct = async text => {
    assert.equal(text, '/reload'); phase = 'loading'; h.first.doRender();
    await gate; phase = 'complete'; h.first.doRender();
  };
  h.first.doRender(); h.mode.getUserInput(); await host.queue;
  const offset = host.raw.length;
  let settled = false;
  // Expire the former byte-polling predicate without a twelve-second unit test.
  let clock = 0; t.mock.method(Date, 'now', () => clock += 12001);
  const completed = host.command('/reload');
  completed.then(() => { settled = true; }, () => { settled = true; });
  await t.waitFor(() => assert.equal(phase, 'loading')); await host.queue;
  assert.equal(settled, false, 'a mounted reload box cannot acknowledge the pending native command');
  assert.ok(host.screen().some(row => row.includes('Reloading keybindings')));
  release(); await completed;
  assert.ok(host.screen().some(row => row.includes('Reloaded keybindings')));
  assert.ok(!host.screen().some(row => row.includes('Reloading keybindings')));
  assert.ok(!Buffer.concat(host.raw.slice(offset)).toString().includes('Reloaded'), 'the completed frame reuses the already visible status cells');
});
