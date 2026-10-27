import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInputs } from '../../scripts/test/context.mjs';
import { planTerminalObserver } from '../fixtures/terminal-observer-plan.mjs';
import { installTerminalObserver } from '../fixtures/terminal-observer.mjs';
import { PiTerminal, observeNativeReceipts, observeRenderFrames, detachTerminalScreen } from '../fixtures/terminal-harness.mjs';
import xterm from '@xterm/headless';

function fixture(t, paint = () => 'NATIVE_FRAME', capture, Editor) {
  class Mode {
    constructor() {
      this.pendingUserInputs = [];
      this.lastSigintTime = 0;
      this.defaultEditor = this.editor = Editor
        ? new Editor({ requestRender: () => { this.renderer.renderRequested = true; } }, { borderColor: text => text }) : {};
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
  const restore = installTerminalObserver(Mode, { restorable: true, capture, Editor });
  t.after(restore);
  const packets = [], writes = [], packetEvents = new EventEmitter();
  function renderer() {
    return {
      renderRequested: false, renderTimer: undefined, immediateRenderScheduled: false, stopped: false,
      columns: 80, rows: 24,
      terminal: { columns: 80, rows: 24, write(data) {
        writes.push(data);
        const match = /^\x1b\]777;tidy-test;([^\x07]+)\x07$/.exec(data);
        if (match) { packets.push(JSON.parse(Buffer.from(match[1], 'base64').toString())); packetEvents.emit('progress'); }
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
  return { mode, first, packets, writes, renderer, packetEvents,
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
  h.send = data => { request = Number(/^\x1b\[\?997;(\d+);3n$/.exec(data)?.[1]); assert.ok(request); };
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
  const packet = { type: 'capture', id: request, generation: 1, frames: 1, columns: 20, rows: 3 };
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

for (const split of [false, true]) test(`capture receipt retains its own cells before later output (split=${split})`, { timeout: 2000 }, async () => {
  const term = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true }), state = {};
  observeRenderFrames(term, state);
  const observer = observeNativeReceipts(term, state);
  const packet = { type: 'capture', id: 91, generation: 1, frames: 1, columns: 12, rows: 2 };
  state.nativeRequests.set(packet.id, { type: 'capture' });
  const marker = `\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`;
  const write = data => new Promise(resolve => term.write(data, resolve));
  try {
    if (split) {
      await write(`FRAME_A${marker.slice(0, -1)}`);
      await write(`${marker.slice(-1)}\rFRAME_B`);
    } else await write(`FRAME_A${marker}\rFRAME_B`);
    const received = state.nativeReceipts.get('capture:91'), snapshot = state.nativeSnapshots?.get(received);
    assert.equal(term.buffer.active.getLine(0).translateToString(true), 'FRAME_B');
    assert.equal(snapshot?.screen[0], 'FRAME_A', 'snapshot belongs to the receipt, not subsequently parsed bytes');
    assert.equal(snapshot.cells[0][6].text, 'A');
  } finally { observer.dispose(); term.dispose(); }
});

test('explicit native capture observes the current frame without requesting another render', { timeout: 2000 }, async t => {
  const h = fixture(t);
  h.mode.getUserInput();
  const receipt = PiTerminal.prototype.waitForProgress.call({ nativeProgress: h.packetEvents },
    () => h.packets.find(packet => packet.type === 'capture' && packet.id === 92), 'capture receipt');
  h.input(92, 3);
  assert.equal((await receipt).frames, 1);
  assert.equal(h.writes.filter(value => value.includes('NATIVE_FRAME')).length, 1);
});

test('frame acknowledgements read zero cells; an explicit capture copies cells exactly once', { timeout: 2000 }, async () => {
  const term = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true }), state = {};
  const observer = observeNativeReceipts(term, state);
  const prototype = Object.getPrototypeOf(term.buffer.active.getLine(0)), original = prototype.getCell;
  let reads = 0;
  prototype.getCell = function (...args) { reads++; return Reflect.apply(original, this, args); };
  const write = data => new Promise(resolve => term.write(data, resolve));
  const marker = type => `\x1b]777;tidy-test;${Buffer.from(JSON.stringify({ type, id: 93 })).toString('base64')}\x07`;
  try {
    await write(marker('frame'));
    assert.equal(reads, 0);
    assert.equal(state.snapshotCopies, 0);
    state.nativeRequests.set(93, { type: 'capture' });
    await write(marker('capture'));
    assert.equal(reads, 24);
    assert.equal(state.snapshotCopies, 1);
    assert.equal(state.nativeSnapshots.get(state.nativeReceipts.get('capture:93')).cells.length, 2);
  } finally { prototype.getCell = original; observer.dispose(); term.dispose(); }
});

test('capture progress obeys the caller watchdog and removes its event listener', { timeout: 2000 }, async () => {
  const state = { nativeProgress: new EventEmitter() }, controller = new AbortController();
  const reason = new Error('controlled watchdog');
  const pending = PiTerminal.prototype.waitForProgress.call(state, () => false, 'held completion', controller.signal);
  assert.equal(state.nativeProgress.listenerCount('progress'), 1);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(state.nativeProgress.listenerCount('progress'), 0);
});

test('persisted capture preserves every cell attribute and surfaces an unwritable cell destination', { timeout: 2000 }, async () => {
  const output = mkdtempSync(join(tmpdir(), 'terminal-screen-')), term = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true });
  try {
    await new Promise(resolve => term.write('\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m\x1b[1;2;3;4;7;9mA', resolve));
    const snapshot = detachTerminalScreen(term), state = { output, raw: [] };
    const capture = PiTerminal.prototype.captureScreen.call(state, 'cells', {}, snapshot);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'cells.screen.json'), 'utf8')), capture.cells);
    for (const attribute of ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse']) assert.ok(capture.cells[0][0][attribute], attribute);
    assert.equal(capture.cells[0][0].text, 'A');
    mkdirSync(join(output, 'denied.screen.json'));
    assert.throws(() => PiTerminal.prototype.captureScreen.call(state, 'denied', {}, snapshot));
  } finally { term.dispose(); rmSync(output, { recursive: true, force: true }); }
});

test('prepared capture spends one watchdog budget across stages rather than resetting it', { timeout: 2000 }, async t => {
  const output = mkdtempSync(join(tmpdir(), 'prepared-deadline-'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, 'setTimeout', (...args) => timeout(...args));
  t.mock.method(console, 'error', () => {});
  let captures = 0, signal;
  const state = { output, nativeSequence: 0, nativeProgress: new EventEmitter(), snapshotCopies: 0,
    nativeFence: async (_id, kind, currentSignal) => {
      captures++; signal = currentSignal; assert.equal(kind, 0); t.mock.timers.tick(11999); return { generation: 1 };
    },
    events: () => [{ type: 'card_preparation', tool: 'edit', call: 'a', update: 'one', phase: 'updated', sourceEligible: true },
      { type: 'card_preparation', call: 'a', update: 'one', phase: 'prepared', applied: true, refused: 0, publication: 1, outcomes: ['pi'] }],
    waitForProgress: PiTerminal.prototype.waitForProgress,
    command: async (_command, currentSignal) => {
      assert.equal(currentSignal === signal, true); t.mock.timers.tick(1); currentSignal.throwIfAborted();
    } };
  try {
    await assert.rejects(() => PiTerminal.prototype.capturePrepared.call(state, 'deadline', { tool: 'edit', count: 1 }),
      error => error.code === 'CAPTURE_TIMEOUT');
    assert.equal(timer.mock.callCount(), 1);
    assert.equal(captures, 1, 'only the input acknowledgement occurs; no physical capture after expiry');
    assert.equal(state.nativeProgress.listenerCount('progress'), 0);
    assert.equal(existsSync(join(output, 'deadline.screen.json')), false);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('a parsed native receipt does not wait for unrelated following parser work', { timeout: 2000 }, async () => {
  const state = Object.create(PiTerminal.prototype), term = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true });
  state.term = term; observeRenderFrames(term, state); const observer = observeNativeReceipts(term, state);
  let release, watchdog, released = false;
  state.queue = new Promise(resolve => { release = () => { released = true; resolve(); }; });
  state.send = () => {
    const packet = { type: 'frame', id: 94, generation: 1, frames: 1, columns: 12, rows: 2 };
    term.write(`\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`);
  };
  try {
    const receipt = await Promise.race([state.nativeFence(94), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Native receipt unnecessarily waited for later parser work')), 1000);
    })]);
    assert.equal(receipt.id, 94);
    assert.equal(released, false, 'no release of later bytes is needed for the already parsed receipt');
    assert.equal(state.snapshotCopies, 0);
  } finally { clearTimeout(watchdog); release(); observer.dispose(); term.dispose(); }
});

function heldProducer() {
  let release, calls = 0, subscriptions = 0, work = 0;
  let pending;
  const producer = { whenSettled() { calls++; return pending ?? Promise.resolve(true); } };
  const capture = { producer: { owner: new WeakRef(producer), sample() { return { work }; } } };
  return { producer, capture, calls: () => calls, subscriptions: () => subscriptions, work: () => work,
    hold() {
      pending = new Promise(resolve => { release = result => { pending = undefined; resolve(result); }; });
      const then = pending.then;
      pending.then = function (...args) { subscriptions++; return Reflect.apply(then, this, args); };
    },
    finish(result = true) { work++; release?.(result); },
  };
}

for (const later of [false, true]) test(`settled capture: waits for work admitted by ${later ? 'a later' : 'the first'} normal frame`, async t => {
  const source = heldProducer();
  let frames = 0, samples = 0;
  source.capture.producer.sample = () => { samples++; return { work: source.work() }; };
  const h = fixture(t, () => { frames++; if (frames === 2 || later && frames === 3) source.hold(); return 'SAME_PIXELS'; }, source.capture);
  h.mode.getUserInput();
  h.first.renderRequested = true;
  assert.deepEqual(h.input(101, 4), { consume: true });
  await turn();
  assert.equal(source.calls(), 0, 'native requested rendering must admit its own lazy work first');
  h.first.doRender();
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 101), false);
  assert.equal(source.subscriptions(), 1, 'one passive observation of held producer work');
  source.finish();
  h.first.renderRequested = true;
  await turn();
  assert.equal(h.packets.some(packet => packet.id === 101), false, 'publication still owes its normal frame');
  h.first.doRender();
  if (later) {
    await turn();
    assert.equal(source.work(), 1, 'the first operation completed before this later frame admitted a second');
    assert.equal(source.subscriptions(), 2);
    assert.equal(samples, 0, 'the earlier completed producer proof cannot authorize this later frame');
    assert.equal(h.packets.some(packet => packet.id === 101), false);
    source.finish(); h.first.renderRequested = true; await turn();
    assert.equal(samples, 0);
    h.first.doRender();
  }
  const receipt = await h.packet(101, 'capture');
  assert.equal(receipt.sample.work, later ? 2 : 1);
  assert.equal(samples, 1);
  assert.equal(receipt.frames, later ? 4 : 3);
  assert.equal(frames, later ? 4 : 3, 'sampling never invokes a renderer');
});

test('settled capture: samples changed counters once even when pixels and frame count are unchanged', async t => {
  const source = heldProducer(); let samples = 0, counter = 4;
  source.capture.producer.sample = () => { samples++; return { count: counter }; };
  const h = fixture(t, () => 'UNCHANGED', source.capture); h.mode.getUserInput();
  assert.deepEqual(h.input(102, 4), { consume: true });
  const first = await h.packet(102, 'capture');
  counter = 9;
  assert.deepEqual(h.input(103, 4), { consume: true });
  const second = await h.packet(103, 'capture');
  assert.equal(first.frames, 1); assert.equal(second.frames, 1);
  assert.equal(first.sample.count, 4); assert.equal(second.sample.count, 9);
  assert.equal(samples, 2); assert.equal(counter, 9); assert.equal(source.work(), 0);
  assert.equal(h.writes.filter(row => row.includes('UNCHANGED')).length, 1);
});

test('settled capture: producer replacement never publishes a successor sample', async t => {
  const source = heldProducer(); source.hold();
  const h = fixture(t, undefined, source.capture); h.mode.getUserInput();
  assert.deepEqual(h.input(104, 4), { consume: true }); await turn();
  const replacement = heldProducer();
  source.capture.producer = replacement.capture.producer;
  source.capture.changed();
  const cancelled = await h.packet(104, 'cancelled');
  assert.equal(cancelled.id, 104);
  assert.equal(h.packets.some(packet => packet.id === 104 && packet.type === 'capture'), false);
  source.finish(); await turn();
  h.input(105, 4);
  assert.equal((await h.packet(105, 'capture')).sample.work, 0);
  assert.equal(h.packets.some(packet => packet.id === 104 && packet.type === 'capture'), false);
});

test('settled capture: repeated cancellation does not resubscribe to one unresolved producer', async t => {
  const source = heldProducer(); source.hold();
  const h = fixture(t, undefined, source.capture); h.mode.getUserInput();
  for (let id = 110; id < 113; id++) {
    assert.deepEqual(h.input(id, 4), { consume: true }); await turn();
    assert.deepEqual(h.input(id, 5), { consume: true });
    await h.packet(id, 'cancelled');
  }
  assert.equal(source.subscriptions(), 1);
  h.input(113, 4); await turn();
  assert.equal(h.packets.some(packet => packet.id === 113), false);
  source.finish(); await h.packet(113, 'capture');
  assert.equal(h.packets.filter(packet => packet.type === 'capture').length, 1);
});

test('settled capture: renderer replacement cancels capture while ordinary reload authority can transfer', async t => {
  const source = heldProducer(); source.hold();
  const h = fixture(t, undefined, source.capture); h.mode.getUserInput();
  assert.deepEqual(h.input(114, 4), { consume: true }); await turn();
  const second = h.renderer(); h.mode.mountInteractiveTui(second); second.doRender();
  await h.packet(114, 'cancelled');
  source.finish(); await turn();
  assert.equal(h.packets.some(packet => packet.id === 114 && packet.type === 'capture'), false);
  h.input(115, 4);
  assert.equal((await h.packet(115, 'capture')).generation, 2);
});

test('settled capture: shared helper awaits the actual action and never runs diagnostic dump/render commands', async t => {
  const output = mkdtempSync(join(tmpdir(), 'settled-helper-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let finish, fences = 0, writes = 0;
  const action = new Promise(resolve => { finish = resolve; });
  const state = Object.create(PiTerminal.prototype);
  Object.assign(state, { output, nativeSequence: 0, nativeProgress: new EventEmitter(),
    command() { throw new Error('diagnostic command is not passive'); },
    nativeFence: async (_id, kind) => { fences++; assert.equal(kind, 4); return { sample: { count: 17 }, columns: 1, rows: 1 }; },
    nativeSnapshots: { get: () => ({ width: 1, rows: 1, screen: ['A'], cells: [[{ text: 'A' }]] }) },
    captureScreen(_name, dump, snapshot) { writes++; return { ...dump, ...snapshot }; },
  });
  const pending = state.captureSettled('passive', { action: () => action });
  await turn(); assert.equal(fences, 0); assert.equal(writes, 0);
  finish(); const result = await pending;
  assert.equal(result.sample.count, 17); assert.equal(result.screen[0], 'A');
  assert.equal(fences, 1); assert.equal(writes, 1);
});

for (const frame of ['unchanged', 'later', 'pending', 'stopped']) test(`settled capture: same-owner false completion cancels without sampling and permits a new observation (frame=${frame})`, async t => {
  const source = heldProducer(); source.hold(); let samples = 0;
  source.capture.producer.sample = () => { samples++; return { work: source.work() }; };
  const h = fixture(t, undefined, source.capture); h.mode.getUserInput();
  assert.deepEqual(h.input(116, 4), { consume: true }); await turn();
  source.finish(false);
  await Promise.resolve();
  if (frame === 'later') h.first.doRender();
  if (frame === 'pending') h.first.renderRequested = true;
  if (frame === 'stopped') h.first.stopped = true;
  await h.packet(116, 'cancelled');
  assert.equal(source.calls(), 1, 'a delivered cancellation is not replaced by a successor drain');
  assert.equal(samples, 0);
  assert.equal(h.packets.some(packet => packet.id === 116 && packet.type === 'capture'), false);
  h.first.stopped = false; h.first.renderRequested = false;
  h.input(117, 4);
  assert.equal((await h.packet(117, 'capture')).sample.work, 1);
  assert.equal(samples, 1);
});

async function loadedEditor() {
  const plan = planTerminalObserver(readInputs());
  const source = readFileSync(new URL(plan.editor.module));
  assert.equal(createHash('sha256').update(source).digest('hex'), plan.editor.sha256);
  assert.ok(plan.visited.includes(plan.editor.module));
  return (await import(plan.editor.module))[plan.editor.exportName];
}

function suggestions(editor) {
  const queries = [];
  editor.setAutocompleteProvider({ triggerCharacters: [], getSuggestions(_lines, _line, _col, options) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    queries.push({ options, resolve }); return promise;
  } });
  return queries;
}

test('settled capture: actual loaded native debounce cancellation wakes observation without polling or starting a task', async t => {
  const Editor = await loadedEditor(), source = heldProducer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nativeTimeout = globalThis.setTimeout;
  const timeouts = t.mock.method(globalThis, 'setTimeout', (...args) => nativeTimeout(...args));
  const h = fixture(t, undefined, source.capture, Editor); h.mode.getUserInput();
  const editor = h.mode.editor, queries = suggestions(editor);
  editor.setText('@held'); editor.requestAutocomplete({ force: false, explicitTab: false });
  const timer = editor.autocompleteDebounceTimer;
  assert.ok(timer, 'the real native attachment debounce is pending');
  h.input(120, 4); await turn();
  assert.equal(h.packets.some(packet => packet.id === 120), false);
  assert.equal(editor.autocompleteDebounceTimer === timer, true);
  editor.cancelAutocompleteRequest();
  await turn(); await turn(); await turn();
  assert.equal(queries.length, 0);
  assert.equal(editor.autocompleteDebounceTimer, undefined);
  assert.equal(timeouts.mock.callCount(), 1, 'only native debounce allocation; no observer polling timer');
  assert.equal(h.packets.filter(packet => packet.id === 120 && packet.type === 'capture').length, 1);
});

for (const successor of [false, true]) test(`settled capture: actual native abort-ignoring task ${successor ? 'chains its successor' : 'still owes real completion'}`, async t => {
  const Editor = await loadedEditor(), source = heldProducer();
  const h = fixture(t, undefined, source.capture, Editor); h.mode.getUserInput();
  const editor = h.mode.editor, queries = suggestions(editor);
  editor.setText('/held'); editor.requestAutocomplete({ force: false, explicitTab: true });
  await turn(); assert.equal(queries.length, 1);
  const old = editor.autocompleteRequestTask;
  h.input(121, 4); await turn();
  editor.cancelAutocompleteRequest();
  assert.equal(queries[0].options.signal.aborted, true);
  assert.equal(editor.autocompleteRequestTask === old, true, 'native cancellation does not settle or replace its task');
  await turn(); assert.equal(h.packets.some(packet => packet.id === 121), false);
  if (successor) {
    editor.requestAutocomplete({ force: false, explicitTab: true });
    assert.equal(editor.autocompleteRequestTask === old, false);
    await turn(); assert.equal(queries.length, 1, 'native successor awaits the previous task');
  }
  queries[0].resolve(undefined); await turn();
  if (successor) {
    assert.equal(queries.length, 2);
    assert.equal(h.packets.some(packet => packet.id === 121), false, 'old completion cannot release the successor');
    queries[1].resolve(undefined); await turn();
    assert.equal(h.packets.some(packet => packet.id === 121), false, 'current completion still owes its normal frame');
    h.first.doRender();
  }
  await h.packet(121, 'capture');
});

function physicalObserver(t, h, { split = false, afterReceipt, receiptGate } = {}) {
  const host = Object.create(PiTerminal.prototype), output = mkdtempSync(join(tmpdir(), 'settled-physical-'));
  host.output = output; host.raw = []; host.queue = Promise.resolve();
  host.term = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true });
  observeRenderFrames(host.term, host); const receipts = observeNativeReceipts(host.term, host);
  h.first.terminal.columns = 12; h.first.terminal.rows = 2;
  const nativeWrite = h.first.terminal.write;
  h.first.terminal.write = data => {
    nativeWrite(data); host.raw.push(Buffer.from(data));
    const packet = data.startsWith('\x1b]777;tidy-test;') && JSON.parse(Buffer.from(data.slice(16, -1), 'base64').toString());
    if (packet && receiptGate?.(packet, data)) return;
    if (packet && packet.type === 'capture' && afterReceipt) {
      if (split) host.term.write(data.slice(0, -1));
      host.queue = new Promise(resolve => host.term.write(`${split ? data.slice(-1) : data}\r\x1b[32mFRAME_B`, resolve));
      afterReceipt();
    } else host.queue = new Promise(resolve => host.term.write(data, resolve));
  };
  host.send = data => h.first.listener(data);
  t.after(async () => { await host.queue; receipts.dispose(); host.term.dispose(); rmSync(output, { recursive: true, force: true }); });
  return host;
}

for (const split of [false, true]) test(`settled capture: counter/screen belong to A before receipt then B (split=${split})`, async t => {
  const source = heldProducer(); let counter = 10, samples = 0;
  source.capture.producer.sample = () => { samples++; return { count: counter }; };
  const h = fixture(t, () => '\x1b[H\x1b[31mFRAME_A', source.capture);
  const host = physicalObserver(t, h, { split, afterReceipt() { counter = 20; } });
  h.mode.getUserInput(); h.first.doRender(); await host.queue;
  await host.nativeFence();
  assert.equal(host.snapshotCopies, 0);
  const result = await host.captureSettled('ordered');
  await host.queue;
  assert.equal(result.sample.count, 10); assert.equal(counter, 20); assert.equal(samples, 1);
  assert.equal(result.screen[0], 'FRAME_A'); assert.equal(result.cells[0][6].text, 'A'); assert.equal(result.cells[0][0].fg, 1);
  assert.equal(host.screen()[0], 'FRAME_B'); assert.equal(host.snapshotCopies, 1);
  assert.equal(h.writes.filter(value => value.includes('FRAME_A')).length, 2, 'only explicit normal frames, never capture rendering');
  assert.deepEqual(JSON.parse(readFileSync(join(host.output, 'ordered.screen.json'), 'utf8')), result.cells);
});

test('settled capture: deliberate held-work frame capture remains available and ordinary acknowledgements copy nothing', async t => {
  const source = heldProducer(); source.hold();
  const h = fixture(t, undefined, source.capture), host = physicalObserver(t, h);
  h.mode.getUserInput(); h.first.doRender();
  h.input(130, 4); await turn();
  await host.nativeFence(); assert.equal(host.snapshotCopies, 0);
  const frame = await host.nativeFence(++host.nativeSequence, 3);
  assert.equal(frame.frames, 2); assert.equal(host.snapshotCopies, 1);
  assert.equal(h.packets.some(packet => packet.id === 130), false);
  h.input(130, 5); await h.packet(130, 'cancelled'); source.finish();
});

test('settled capture: caller abort releases the waiter and correlated native request without cells or later successor output', async t => {
  const source = heldProducer(); source.hold();
  const h = fixture(t, undefined, source.capture), host = physicalObserver(t, h), controller = new AbortController();
  h.mode.getUserInput(); h.first.doRender();
  const reason = new Error('controlled capture cancellation');
  const pending = host.captureSettled('cancelled', { signal: controller.signal });
  await turn(); await turn();
  assert.equal(source.subscriptions(), 1);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  await host.queue;
  assert.equal(host.nativeProgress.listenerCount('progress'), 0);
  assert.equal(host.nativeRequests.size, 0);
  assert.equal(host.nativeReceipts.has('capture:1'), false);
  assert.equal(host.snapshotCopies, 0);
  source.finish(); await turn(); await turn();
  assert.equal(h.packets.some(packet => packet.id === 1 && packet.type === 'capture'), false);
  assert.equal(existsSync(join(host.output, 'cancelled.screen.json')), false);
});

test('settled capture: process exit releases an action waiter before its held action completes', async t => {
  const source = heldProducer(), h = fixture(t, undefined, source.capture), host = physicalObserver(t, h);
  let finish;
  const action = new Promise(resolve => { finish = resolve; });
  const pending = host.captureSettled('exited', { action: () => action });
  await turn();
  host.exited = { code: 1, signal: null }; host.nativeProgress.emit('progress');
  await assert.rejects(pending, /Bridge exited/);
  assert.equal(host.nativeProgress.listenerCount('progress'), 0);
  assert.equal(host.snapshotCopies, 0);
  finish(); await turn();
  assert.equal(h.packets.some(packet => packet.type === 'capture'), false);
});

test('settled capture: one watchdog covers the held action and receipt and is removed after failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = globalThis.setTimeout;
  const timers = t.mock.method(globalThis, 'setTimeout', (...args) => timeout(...args));
  const state = Object.create(PiTerminal.prototype);
  let captures = 0, samples = 0;
  Object.assign(state, { nativeSequence: 0, nativeProgress: new EventEmitter(), nativeReceipts: new Map(),
    nativeFence: async (_id, kind, signal) => { captures++; assert.equal(kind, 4); t.mock.timers.tick(1); signal.throwIfAborted(); },
    captureScreen() { samples++; }, send() {},

  });
  await assert.rejects(state.captureSettled('deadline', { action: async () => { t.mock.timers.tick(11999); } }),
    error => error.code === 'CAPTURE_TIMEOUT');
  assert.equal(timers.mock.callCount(), 1); assert.equal(captures, 1); assert.equal(samples, 0);
  assert.equal(state.nativeProgress.listenerCount('progress'), 0);
});

test('settled capture: held cancellation acknowledgements retain no inactive request history', async t => {
  const source = heldProducer(); source.hold(); t.after(() => source.finish());
  const held = [], h = fixture(t, undefined, source.capture);
  const host = physicalObserver(t, h, { receiptGate(packet, data) {
    if (packet.type !== 'cancelled') return false;
    held.push(data); return true;
  } });
  h.mode.getUserInput(); h.first.doRender(); await host.nativeReceipt('ready');
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController(), pending = host.captureSettled(`inactive-${i}`, { signal: controller.signal });
    await turn(); await turn();
    controller.abort(new Error('cancelled before acknowledgement'));
    await assert.rejects(pending, /cancelled before acknowledgement/);
  }
  assert.equal(held.length, 8);
  assert.equal(source.subscriptions(), 1);
  assert.equal((host.nativeCancelled?.size ?? 0) + (host.nativeRequests?.size ?? 0), 0, 'no active capture means no retained request identities');
  for (const data of held) await new Promise(resolve => host.term.write(data, resolve));
  assert.equal(host.nativeReceipts.size, 0, 'late cancellation acknowledgements are discarded');
  assert.equal(host.snapshotCopies, 0);
  assert.equal(host.nativeProgress.listenerCount('progress'), 0);
});

test('settled capture: already-queued receipt after bridge exit cannot copy cells or publish a late result', async t => {
  const source = heldProducer(); source.hold(); t.after(() => source.finish());
  const queued = [], h = fixture(t, undefined, source.capture);
  const host = physicalObserver(t, h, { receiptGate(packet, data) {
    if (packet.type !== 'capture') return false;
    queued.push(data); return true;
  } });
  h.mode.getUserInput(); h.first.doRender(); await host.nativeReceipt('ready');
  const pending = host.captureSettled('queued-after-exit');
  await turn(); await turn(); source.finish(); await h.packet(1, 'capture');
  assert.equal(queued.length, 1); assert.equal(host.snapshotCopies, 0);
  // Child exit can precede parsing bytes already written into the bridge queue.
  host.exited = { code: 1, signal: null };
  host.nativeCancelled?.clear(); host.nativeRequests?.clear();
  host.nativeProgress.emit('progress');
  await assert.rejects(pending, /Bridge exited/);
  for (const data of queued) await new Promise(resolve => host.term.write(data, resolve));
  assert.equal(host.snapshotCopies, 0);
  assert.equal(host.nativeReceipts.has('capture:1'), false);
  assert.equal(host.nativeProgress.listenerCount('progress'), 0);
  assert.equal(existsSync(join(host.output, 'queued-after-exit.screen.json')), false);
});

test('settled capture counter-only: same action/producer/later-frame proof samples once with no cells or persistence', async t => {
  const source = heldProducer(); source.hold();
  let counter = 31, samples = 0, finishAction;
  source.capture.producer.sample = () => { samples++; return { counter, work: source.work() }; };
  const h = fixture(t, undefined, source.capture), host = physicalObserver(t, h), controller = new AbortController();
  const action = new Promise(resolve => { finishAction = resolve; });
  t.after(() => { finishAction(); source.finish(); controller.abort(new Error('test cleanup')); });
  h.mode.getUserInput(); h.first.renderRequested = true;
  const persist = t.mock.method(host, 'captureScreen', () => { throw new Error('counter-only capture attempted screen persistence'); });
  const pending = host.captureSettled('only-counters', { screen: false, signal: controller.signal, action: () => action });
  void pending.catch(() => {});
  await turn();
  assert.equal(source.calls(), 0); assert.equal(samples, 0);
  finishAction(); await turn();
  assert.equal(source.calls(), 0, 'the requested normal frame still precedes producer observation');
  h.first.doRender(); await turn();
  await host.nativeReceipt('ready');
  assert.equal(source.subscriptions(), 1); assert.equal(samples, 0);
  counter = 73; source.finish(); h.first.renderRequested = true;
  await turn(); assert.equal(samples, 0, 'producer delivery cannot bypass the later requested normal frame');
  h.first.doRender();
  const result = await pending;
  assert.deepEqual(result.sample, { counter: 73, work: 1 });
  assert.deepEqual(Object.keys(result).sort(), ['receipt', 'sample']);
  assert.equal(samples, 1); assert.equal(counter, 73); assert.equal(source.work(), 1);
  assert.equal(h.writes.filter(value => value.includes('NATIVE_FRAME')).length, 3, 'only the three deliberately completed normal frames');
  assert.equal(host.snapshotCopies, 0); assert.equal(persist.mock.callCount(), 0);
  assert.deepEqual(readdirSync(host.output), []);
  assert.equal(host.nativeRequests.size, 0); assert.equal(host.nativeProgress.listenerCount('progress'), 0);
});

test('settled capture counter-only: mixed concurrent requests correlate cells per request even with reversed receipts', async t => {
  const source = heldProducer(); source.hold(); t.after(() => source.finish());
  let samples = 0;
  source.capture.producer.sample = () => { samples++; return { counter: 42, work: source.work() }; };
  const queued = [], h = fixture(t, undefined, source.capture);
  const host = physicalObserver(t, h, { receiptGate(packet, data) {
    if (packet.type !== 'capture') return false;
    queued.push({ packet, data }); return true;
  } });
  h.mode.getUserInput(); h.first.doRender(); await host.nativeReceipt('ready');
  const counters = host.captureSettled('mixed-counters', { screen: false });
  const screen = host.captureSettled('mixed-screen');
  await turn(); await turn(); assert.equal(source.subscriptions(), 1);
  source.finish(); await h.packet(2, 'capture');
  assert.equal(queued.length, 2); assert.equal(host.snapshotCopies, 0);
  const deliver = row => new Promise(resolve => host.term.write(row.data, resolve));
  await deliver(queued.find(row => row.packet.id === 2));
  const shown = await screen;
  assert.equal(host.snapshotCopies, 1); assert.equal(host.nativeRequests.size, 1);
  await deliver(queued.find(row => row.packet.id === 1));
  const counted = await counters;
  assert.deepEqual(counted.sample, shown.sample); assert.equal(counted.receipt.id, 1); assert.equal(shown.receipt.id, 2);
  assert.equal(counted.receipt.frames, shown.receipt.frames); assert.equal(counted.receipt.generation, shown.receipt.generation);
  assert.equal('cells' in counted, false); assert.equal('screen' in counted, false);
  assert.ok(shown.cells.length > 0); assert.equal(samples, 2); assert.equal(source.work(), 1);
  assert.equal(host.snapshotCopies, 1);
  assert.deepEqual(readdirSync(host.output).sort(), ['mixed-screen.screen.json', 'mixed-screen.screen.txt', 'terminal.ansi']);
  assert.equal(host.nativeRequests.size, 0); assert.equal(host.nativeProgress.listenerCount('progress'), 0);
});

test('settled capture counter-only: cancelled late counter receipt cannot copy cells or complete an active screen successor', async t => {
  const source = heldProducer(), queued = [], h = fixture(t, undefined, source.capture);
  const host = physicalObserver(t, h, { receiptGate(packet, data) {
    if (packet.type !== 'capture') return false;
    queued.push({ packet, data }); return true;
  } });
  h.mode.getUserInput(); h.first.doRender(); await host.nativeReceipt('ready');
  const controller = new AbortController(), reason = new Error('cancel queued counter receipt');
  const cancelled = host.captureSettled('cancelled-counters', { screen: false, signal: controller.signal });
  await h.packet(1, 'capture'); controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  let completed = false;
  const pending = host.captureSettled('screen-successor').then(value => { completed = true; return value; });
  await h.packet(2, 'capture');
  const deliver = row => new Promise(resolve => host.term.write(row.data, resolve));
  await deliver(queued.find(row => row.packet.id === 1)); await turn();
  assert.equal(completed, false); assert.equal(host.snapshotCopies, 0);
  assert.equal(host.nativeRequests.size, 1); assert.equal(host.nativeReceipts.has('capture:1'), false);
  await deliver(queued.find(row => row.packet.id === 2)); await pending;
  assert.equal(host.snapshotCopies, 1); assert.equal(host.nativeRequests.size, 0);
  assert.equal(existsSync(join(host.output, 'cancelled-counters.screen.json')), false);
  assert.equal(existsSync(join(host.output, 'cancelled-counters.screen.txt')), false);
});

test('settled capture counter-only: queued receipt after exit releases all correlation without cells or persistence', async t => {
  const source = heldProducer(), queued = [], h = fixture(t, undefined, source.capture);
  const host = physicalObserver(t, h, { receiptGate(packet, data) {
    if (packet.type !== 'capture') return false;
    queued.push(data); return true;
  } });
  h.mode.getUserInput(); h.first.doRender(); await host.nativeReceipt('ready');
  const pending = host.captureSettled('counter-exit', { screen: false });
  await h.packet(1, 'capture');
  host.exited = { code: 1, signal: null }; host.nativeRequests.clear(); host.nativeProgress.emit('progress');
  await assert.rejects(pending, /Bridge exited/);
  for (const data of queued) await new Promise(resolve => host.term.write(data, resolve));
  assert.equal(host.snapshotCopies, 0); assert.equal(host.nativeRequests.size, 0);
  assert.equal(host.nativeReceipts.has('capture:1'), false); assert.equal(host.nativeProgress.listenerCount('progress'), 0);
  assert.deepEqual(readdirSync(host.output), []);
});
