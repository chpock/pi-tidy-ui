import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { PiTerminal } from '../fixtures/terminal-harness.mjs';

function receiver() {
  return Object.assign(Object.create(PiTerminal.prototype), {
    nativeProgress: new EventEmitter(), nativeReceipts: new Map(), resizeSequence: 0,
  });
}

function countPollingTimers(t) {
  const original = globalThis.setTimeout, delays = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay); return original(callback, delay, ...args);
  };
  t.after(() => { globalThis.setTimeout = original; });
  return () => assert.equal(delays.filter(delay => delay === 30).length, 0, 'confirmed progress needs no polling timer');
}

test('journal progress checks exact records and requested count without a polling delay', async t => {
  const h = receiver(), noPolling = countPollingTimers(t), records = [];
  h.events = () => { h.health(); return records; };
  let settled = false;
  const pending = h.event('agent_end', 2).then(() => { settled = true; });
  records.push({ type: 'call' }, { type: 'agent_end' }); h.nativeProgress.emit('progress');
  await turn(); assert.equal(settled, false);
  records.push({ type: 'agent_end' }); h.nativeProgress.emit('progress');
  await pending;
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
  noPolling();
});

test('an already-published journal event is accepted without waiting for a future notification', async t => {
  const h = receiver(), noPolling = countPollingTimers(t);
  h.events = () => [{ type: 'agent_end' }];
  await h.event('agent_end');
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
  noPolling();
});

test('resize needs a fresh matching PTY receipt and actual Pi dimensions, not unrelated progress', async t => {
  const h = receiver(), noPolling = countPollingTimers(t), sent = [], geometry = [];
  let fenced = 0, settled = false;
  h.term = { resize(cols, rows) { assert.deepEqual([cols, rows], [24, 12]); } };
  h.child = { stdin: { write(line) { sent.push(JSON.parse(line)); } } };
  h.events = () => { h.health(); return geometry; };
  h.settle = async () => { fenced++; };
  h.ptySize = { id: 0, width: 24, height: 12 };
  const pending = h.resize(24, 12).then(() => { settled = true; });
  assert.deepEqual(sent, [{ resize: [24, 12], id: 1 }]);
  h.nativeProgress.emit('progress'); await turn();
  assert.equal(settled, false); assert.equal(fenced, 0);
  h.ptySize = { id: 1, width: 24, height: 12 };
  h.nativeProgress.emit('progress'); await turn();
  assert.equal(settled, false); assert.equal(fenced, 0);
  geometry.push({ type: 'terminal_size', width: 24, height: 80 });
  h.nativeProgress.emit('progress'); await turn();
  assert.equal(settled, false); assert.equal(fenced, 0);
  geometry.push({ type: 'terminal_size', width: 24, height: 12 });
  h.nativeProgress.emit('progress'); await pending;
  assert.equal(fenced, 1);
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
  noPolling();
});

test('unchanged dimensions still require a new PTY receipt but no invented Pi resize event', async t => {
  const h = receiver(), noPolling = countPollingTimers(t);
  h.term = { resize() {} }; h.child = { stdin: { write() {} } };
  h.events = () => [{ type: 'terminal_size', width: 100, height: 80 }];
  h.settle = async () => {};
  let settled = false;
  const pending = h.resize(100, 80).then(() => { settled = true; });
  await turn(); assert.equal(settled, false);
  h.ptySize = { id: 1, width: 100, height: 80 };
  h.nativeProgress.emit('progress'); await pending;
  noPolling();
});

test('journal wait fails on transport error and removes its progress listener', async () => {
  const h = receiver(), error = new Error('transport failed');
  h.events = () => { h.health(); return []; };
  const pending = h.event('agent_end');
  h.error = error; h.nativeProgress.emit('progress');
  await assert.rejects(pending, thrown => thrown === error);
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});

test('resize fails on process exit instead of waiting out its deadline', async () => {
  const h = receiver();
  h.term = { resize() {} }; h.child = { stdin: { write() {} } };
  const pending = h.resize(24);
  h.exited = { code: 1, signal: null }; h.nativeProgress.emit('progress');
  await assert.rejects(pending, /Bridge exited/);
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});

test('progress notification retains the existing twelve-second failure deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = receiver();
  h.events = () => [];
  let rejected = false;
  const pending = assert.rejects(h.event('missing'), /Timed out: missing #1/).then(() => { rejected = true; });
  t.mock.timers.tick(11999); await turn();
  assert.equal(rejected, false);
  t.mock.timers.tick(1); await pending;
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});

test('only explicit animation observations retain the complete temporal interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = receiver();
  let fences = 0;
  h.nativeFence = async () => { fences++; };
  await h.settle(); assert.equal(fences, 1, 'ordinary observation needs a physical fence, not elapsed time');
  const pending = h.observeAnimation();
  t.mock.timers.tick(219); await turn();
  assert.equal(fences, 1, 'animation observation cannot finish early');
  t.mock.timers.tick(1); await pending;
  assert.equal(fences, 2, 'elapsed time still requires its final physical fence');
});
