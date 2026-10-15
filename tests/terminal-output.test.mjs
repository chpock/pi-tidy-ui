import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import xterm from '@xterm/headless';
import { createEventRecorder, writeDiagnosticJson } from './fixtures/terminal-output.ts';
import { PiTerminal, observeNativeReceipts } from './fixtures/terminal-harness.mjs';

import { CustomEditor } from '@earendil-works/pi-coding-agent';
import foreignEditorExtension from './fixtures/foreign-editor.ts';

const { Terminal } = xterm;

function capturePublication(action, onPacket) {
  const original = process.stdout.write;
  process.stdout.write = function (packet, ...args) {
    if (typeof packet !== 'string') return Reflect.apply(original, this, [packet, ...args]);
    onPacket(packet); return true;
  };
  try { return action(); }
  finally { process.stdout.write = original; }
}

test('shared journal publisher appends exact complete records before each parsed nonprinting wakeup', async t => {
  const output = mkdtempSync(join(tmpdir(), 'tidy-journal-writer-'));
  const h = Object.assign(Object.create(PiTerminal.prototype), { output, rendering: false });
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  observeNativeReceipts(term, h);
  t.after(() => { term.dispose(); rmSync(output, { recursive: true, force: true }); });
  const write = packet => new Promise(done => term.write(packet, done));
  const notice = `\x1b]777;tidy-test;${Buffer.from(JSON.stringify({ type: 'journal' })).toString('base64')}\x07`;
  const records = [{ type: 'target', text: '界🙂\nline' }, { type: 'target', state: { count: 2 } }];
  const packets = [];
  const record = createEventRecorder(output);
  const publish = event => capturePublication(() => record(event), packet => {
    const text = readFileSync(join(output, 'events.jsonl'), 'utf8');
    assert.ok(text.endsWith('\n'), 'a publisher must finish its record before notifying');
    assert.deepEqual(text.trimEnd().split('\n').map(JSON.parse), records.slice(0, packets.length + 1));
    packets.push(packet);
  });
  let finished = false;
  const pending = h.event('target', 2).then(() => { finished = true; });
  await write(notice); await turn();
  assert.equal(finished, false, 'a notice alone proves no journal event');
  publish(records[0]); await write(packets[0]); await turn();
  assert.equal(finished, false, 'a different event count is still pending');
  publish(records[1]); await write(packets[1]); await pending;
  assert.deepEqual(h.events(), records);
  assert.deepEqual(packets, [notice, notice]);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), '', 'notices paint no cells');
  assert.equal(h.nativeReceipts.size, 0, 'journal notices are not cached success receipts');
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});

test('a failed journal append is surfaced and publishes no completion notice', t => {
  const output = mkdtempSync(join(tmpdir(), 'tidy-journal-failed-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let notices = 0;
  const record = createEventRecorder(join(output, 'missing'));
  capturePublication(() => assert.throws(() => record({ type: 'target' }), { code: 'ENOENT' }), () => { notices++; });
  assert.equal(notices, 0);
});

test('diagnostic publication wakes a bounded reader after the complete file without polling or screen output', async t => {
  const output = mkdtempSync(join(tmpdir(), 'tidy-diagnostic-writer-'));
  const h = Object.assign(Object.create(PiTerminal.prototype), { output, rendering: false });
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  observeNativeReceipts(term, h);
  t.after(() => { term.dispose(); rmSync(output, { recursive: true, force: true }); });
  const value = { rows: ['界🙂\u001b[31mred'], missing: undefined, count: 7 };
  let packet, reads = 0;
  const pending = h.waitForProgress(() => {
    reads++;
    try { return JSON.parse(readFileSync(join(output, 'snapshot.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'diagnostic file');
  await turn(); await turn();
  assert.equal(reads, 1, 'a pending file is not repeatedly polled');
  capturePublication(() => writeDiagnosticJson(output, 'snapshot', value, 2), data => {
    assert.equal(readFileSync(join(output, 'snapshot.json'), 'utf8'), JSON.stringify(value, null, 2));
    packet = data;
  });
  await new Promise(done => term.write(packet, done));
  assert.deepEqual(await pending, JSON.parse(JSON.stringify(value)));
  assert.equal(reads, 2);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), '');
  assert.equal(h.nativeReceipts.size, 0);
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});

test('diagnostic serialization/write failures propagate without publishing completion', t => {
  const output = mkdtempSync(join(tmpdir(), 'tidy-diagnostic-failed-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let notices = 0;
  capturePublication(() => {
    assert.throws(() => writeDiagnosticJson(join(output, 'missing'), 'snapshot', {}), { code: 'ENOENT' });
    const circular = {}; circular.self = circular;
    assert.throws(() => writeDiagnosticJson(output, 'snapshot', circular), TypeError);
  }, () => { notices++; });
  assert.equal(notices, 0);
});

test('the actual foreign-editor shortcut publishes its diagnostic to an idle reader without unrelated progress', async t => {
  const output = mkdtempSync(join(tmpdir(), 'tidy-foreign-publisher-'));
  const previous = { output: process.env.TIDY_UI_TEST_OUTPUT, deferred: process.env.TIDY_UI_TEST_DEFER_EDITOR };
  process.env.TIDY_UI_TEST_OUTPUT = output; process.env.TIDY_UI_TEST_DEFER_EDITOR = '1';
  const h = Object.assign(Object.create(PiTerminal.prototype), { output, rendering: false });
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  observeNativeReceipts(term, h);
  t.after(() => {
    h.error = new Error('diagnostic reader cleanup'); h.nativeProgress.emit('progress');
    term.dispose(); rmSync(output, { recursive: true, force: true });
    for (const [key, value] of [['TIDY_UI_TEST_OUTPUT', previous.output], ['TIDY_UI_TEST_DEFER_EDITOR', previous.deferred]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  // Only the publisher boundary is under test; real editor behavior stays in the CLI case.
  const editor = Object.assign(Object.create(CustomEditor.prototype), {
    getText: () => 'draft', getExpandedText: () => 'draft', getCursor: () => ({ line: 0, col: 5 }),
    render: () => ['FOREIGN_DIAGNOSTIC_SOURCE'], getPaddingX: () => 2, isShowingAutocomplete: () => false,
  });
  let renders = 0, sessionStart, shortcut;
  const tui = { children: Array.from({ length: 7 }, (_, i) => ({ children: i === 4 ? [editor] : [], render: () => [`group${i}`] })),
    requestRender: () => { renders++; } };
  const ctx = { ui: { setWidget(_name, factory) { factory?.(tui); }, getEditorComponent: () => undefined },
    isIdle: () => true, sessionManager: { getSessionFile: () => 'publisher-session.jsonl' } };
  foreignEditorExtension({ on(name, handler) { assert.equal(name, 'session_start'); sessionStart = handler; },
    registerShortcut(key, value) { assert.equal(key, 'ctrl+alt+d'); shortcut = value.handler; } });
  sessionStart({}, ctx);
  writeFileSync(join(output, 'foreign-request.json'), JSON.stringify({ name: 'idle-author' }));
  let reads = 0;
  const pending = h.waitForProgress(() => {
    reads++;
    try { return JSON.parse(readFileSync(join(output, 'idle-author.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'actual foreign publisher');
  void pending.catch(() => {});
  const packets = [];
  await capturePublication(() => shortcut(ctx), packet => packets.push(packet));
  assert.equal(reads, 1, 'a completed file alone does not wake a sleeping reader');
  assert.equal(packets.length, 1, 'the actual author must notify, without needing a later frame');
  await new Promise(done => term.write(packets[0], done));
  const dump = await pending;
  assert.deepEqual(dump.rows, ['FOREIGN_DIAGNOSTIC_SOURCE']);
  assert.deepEqual(dump.before, dump.after);
  assert.equal(dump.session, 'publisher-session.jsonl');
  assert.equal(reads, 2);
  assert.equal(renders, 1, 'the original snapshot request remains the only requested native frame');
  assert.equal(h.nativeProgress.listenerCount('progress'), 0);
});
