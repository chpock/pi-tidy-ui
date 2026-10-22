import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiAltScreen, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import { bindTerminalLifecycle } from '../../../src/terminal-lifecycle.ts';
import { TerminalColors } from '../../../src/terminal-colors.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const events: string[] = [];
  const terminal: Terminal = { columns: 80, rows: 24, kittyProtocolActive: false,
    start() { events.push('start'); }, stop() { events.push('stop'); }, write(data) { events.push(data); },
    drainInput: async () => {}, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, ...{ setProgramStatus() {} } };
  const theme = { name: 'fixed', sourcePath: '/theme', fg: (_role: string, text: string) => text };
  const view = new TerminalColors({ snapshot: () => ({ enabled: true, automatic: false, theme }), source: () => undefined,
    read: () => '{"export":{"pageBg":"#123456"}}', write: value => terminal.write(value) });
  return { terminal, view, events };
}

for (const Host of [TuiMainScreen, TuiAltScreen]) test(`terminal lifecycle: ${Host.name} releases before stop and reapplies after native start`, async () => {
  const f = fixture(), ui = new Host(f.terminal, false);
  const descriptor = Object.getOwnPropertyDescriptor(f.terminal, 'stop');
  const detach = bindTerminalLifecycle(f.terminal, f.view)!;
  try {
    ui.start(); f.view.observe(); await tick();
    f.events.length = 0; ui.stop();
    assert.deepEqual(f.events.filter(value => value === '\x1b]111\x07' || value === 'stop'), ['\x1b]111\x07', 'stop']);
    assert.equal(f.view.status().state, 'suspended');
    const stopped = f.events.length; f.view.observe(); await tick(); assert.equal(f.events.length, stopped);
    ui.start(); await tick();
    assert.deepEqual(f.events.filter(value => value === 'start' || value === '\x1b]11;#123456\x07'), ['start', '\x1b]11;#123456\x07']);
    assert.equal(f.view.status().state, 'on');
  } finally { ui.stop(); detach(); f.view.dispose(); }
  assert.equal(Object.getOwnPropertyDescriptor(f.terminal, 'stop')?.value, descriptor?.value);
});

test('terminal lifecycle: inherited methods and receivers survive; disposal cannot erase a later method owner', async () => {
  const f = fixture();
  const receiver = Object.create(f.terminal) as Terminal;
  let args: unknown[] = [];
  Object.defineProperty(receiver, 'start', { configurable: true, writable: true,
    value: function(this: unknown, ...values: unknown[]) { assert.equal(this === receiver, true); args = values; return 'result'; } });
  const before = Object.getOwnPropertyDescriptor(receiver, 'start');
  const detach = bindTerminalLifecycle(receiver, f.view)!;
  f.view.observe(); await tick(); receiver.stop();
  const input = () => {}, resize = () => {};
  const result = receiver.start(input, resize);
  assert.equal(result, 'result'); assert.equal(args[0] === input && args[1] === resize, true);
  const chained = receiver.stop;
  const later = () => chained.call(receiver);
  receiver.stop = later;
  detach();
  assert.equal(receiver.stop === later, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(receiver, 'start'), before);
  await tick(); const packets = f.events.length; receiver.stop();
  assert.equal(f.events.length, packets + 1, 'retired wrapper delegates native stop without touching colors');
  f.view.dispose();
});

test('terminal lifecycle: incompatible hosts fail without partial hooks; failed starts do not claim resumed ownership', async () => {
  for (const host of [{}, Object.freeze({ start() {}, stop() {} }), { get start() { return () => {}; }, stop() {} }]) {
    const f = fixture(), original = Object.getOwnPropertyDescriptor(host, 'stop');
    assert.equal(bindTerminalLifecycle(host, f.view), undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(host, 'stop'), original);
    f.view.dispose();
  }
  const f = fixture(); f.terminal.start = () => { throw new Error('native start failed'); };
  const detach = bindTerminalLifecycle(f.terminal, f.view)!;
  f.view.observe(); await tick(); f.terminal.stop();
  assert.throws(() => f.terminal.start(() => {}, () => {}), /native start failed/);
  assert.equal(f.view.status().state, 'suspended');
  detach(); f.view.dispose();
});

test('terminal lifecycle: active wrappers do not retain a retired color controller', async () => {
  function retired() {
    const f = fixture();
    const detach = bindTerminalLifecycle(f.terminal, f.view)!;
    f.view.dispose();
    return { terminal: f.terminal, detach, weak: new WeakRef(f.view) };
  }
  const f = retired();
  let collected = false;
  for (let i = 0; i < 100; i++) {
    await tick(); global.gc!(); await tick();
    if (!f.weak.deref()) { collected = true; break; }
  }
  assert.equal(collected, true);
  f.terminal.stop(); f.detach();
});

test('terminal lifecycle: all owners suspend before stop, and resume only after successful start', () => {
  const events: string[] = [];
  const terminal = { stop() { events.push('native-stop'); }, start() { events.push('native-start'); } };
  const syntax = { suspend() { events.push('syntax-stop'); }, resume() { events.push('syntax-start'); } };
  const colors = { suspend() { events.push('colors-stop'); }, resume() { events.push('colors-start'); } };
  const detach = bindTerminalLifecycle(terminal, syntax, colors)!;
  terminal.stop(); terminal.start();
  assert.deepEqual(events, ['syntax-stop', 'colors-stop', 'native-stop', 'native-start', 'syntax-start', 'colors-start']);
  detach(); events.length = 0; terminal.stop(); terminal.start(); assert.deepEqual(events, ['native-stop', 'native-start']);
});
