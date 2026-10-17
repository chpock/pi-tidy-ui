import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import xterm from '@xterm/headless';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { PiTerminal } from '../fixtures/terminal-harness.mjs';
import { assertFits } from '../fixtures/terminal-rows.mjs';
import { editorPaint } from '../fixtures/editor-paint.ts';
import * as native from '@earendil-works/pi-tui';

const { Terminal } = xterm;
function sample(terminal) {
  const buffer = terminal.buffer.active;
  return { x: buffer.cursorX, y: buffer.cursorY,
    cells: Array.from({ length: terminal.rows }, (_, y) => Array.from({ length: terminal.cols }, (_, x) => {
      const cell = buffer.getLine(y).getCell(x);
      return [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getFgColorMode(), cell.getBgColor(), cell.getBgColorMode(),
        cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isInvisible(), cell.isBlink(), cell.isStrikethrough()];
    })) };
}

async function withWrites(run) {
  const original = Terminal.prototype.write;
  const observed = { pending: 0, maximum: 0, callbacks: 0, values: [], states: [], errors: [] };
  const configured = new WeakSet();
  Terminal.prototype.write = function (data, done) {
    if (!configured.has(this)) {
      configured.add(this);
      this.options.logger = { ...console, error(...args) { observed.errors.push(args); console.error(...args); } };
    }
    observed.values.push(data);
    observed.pending++; observed.maximum = Math.max(observed.maximum, observed.pending);
    return original.call(this, data, () => {
      observed.states.push(sample(this)); observed.callbacks++; observed.pending--;
      done?.();
    });
  };
  try { await run(observed); } finally { Terminal.prototype.write = original; }
}

const samples = ['', 'plain', '界é', '\x1b[1;2;3;4;7;8;9;31;44mSTYLE', 'again',
  '\x1b[38;2;1;2;3mRGB', '\x1b[0mreset', '\x1b]8;;https://example.test\x07link', 'after',
  '\x1b[3Gshift', '\x1b[0m\x1b[4mu\x1b[24mp'];

test('row validation lets the native parser queue batch work without dropping callback checks', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => samples[i % samples.length]);
  await withWrites(async observed => {
    await assertFits(rows, 20);
    assert.equal(observed.values.length, rows.length, 'every source row must be parsed');
    assert.equal(observed.callbacks, rows.length, 'every row must reach its parse callback');
    assert.equal(observed.pending, 0, 'return only after the native queue drains');
    assert.ok(observed.maximum > 1, 'do not force a timer/turn boundary between every row');
  });
});

test('queued row checks preserve sampled cells, attributes and cursor against native reset per row', async () => {
  for (const width of [8, 20, 100]) {
    const reference = new Terminal({ cols: width, rows: 4, allowProposedApi: true });
    const expected = [];
    try {
      for (const row of samples) {
        reference.reset();
        await new Promise(resolve => reference.write(row, resolve));
        expected.push(sample(reference));
      }
    } finally { reference.dispose(); }
    await withWrites(async observed => {
      await assertFits(samples, width);
      assert.deepEqual(observed.states, expected, `same per-row sampled state at width ${width}`);
    });
  }
});

test('row checks drain the parser after overflow at every position, including wide glyphs', async () => {
  for (const invalid of ['123456789', '界'.repeat(5)]) for (const index of [0, 2, 4]) {
    const rows = ['a', '', '\x1b[31mred', 'plain', 'z']; rows[index] = invalid;
    await withWrites(async observed => {
      await assert.rejects(assertFits(rows, 8), /row must not wrap at 8 columns/);
      assert.equal(observed.pending, 0, 'never dispose a terminal with pending parse callbacks');
      assert.equal(observed.callbacks, observed.values.length);
    });
  }
});

test('all row boundaries are validated before queueing, including a later invalid row', async () => {
  for (const invalid of ['one\ntwo', 'one\rtwo']) await withWrites(async observed => {
    await assert.rejects(assertFits(['valid', invalid], 8), /component row cannot contain a line break/);
    assert.equal(observed.values.length, 0, 'invalid input must not leave earlier writes queued');
  });
  await assertFits([], 8);
  await assertFits(['', '', ''], 8);
});

function nativeCursor(text) {
  return typeof native.renderFakeCursor === 'function' ? native.renderFakeCursor(text) : `\x1b[7m${text}\x1b[27m`;
}

test('row validation composes native cursor metadata before measuring terminal cells', async () => {
  const rows = ['\x1b[31mAB\x1b[0m' + native.CURSOR_MARKER + nativeCursor('界') + '\x1b[34mCD\x1b[0m',
    'AB' + native.CURSOR_MARKER + nativeCursor('C') + 'DE'];
  const before = [...rows], reference = new Terminal({ cols: 6, rows: 4, allowProposedApi: true }), expected = [];
  try {
    for (const row of editorPaint(rows)) {
      reference.reset();
      await new Promise(resolve => reference.write(row, resolve));
      expected.push(sample(reference));
    }
  } finally { reference.dispose(); }
  await withWrites(async observed => {
    await assertFits(rows, 6);
    assert.deepEqual(observed.errors, [], 'valid composed cursor paint never enters an APC parser error');
    assert.deepEqual(observed.states, expected, 'measure complete native-composed text, attributes and cursor');
    assert.equal(observed.states[0].cells[0][2][0], '界');
    assert.equal(observed.states[0].cells[0][2][1], 2);
    assert.deepEqual(rows, before, 'validation must not change raw component rows');
  });
});

test('native cursor metadata cannot hide ASCII or wide-glyph row overflow', async () => {
  for (const [row,width] of [['ABC' + native.CURSOR_MARKER + nativeCursor('D') + 'EF',5],
    ['AB' + native.CURSOR_MARKER + nativeCursor('界') + 'CD',5]]) {
    await assert.rejects(assertFits([row], width), /row must not wrap/, 'every visible cell counts after native cursor composition');
  }
});

test('PTY chunks use the native parser queue and retain split UTF-8, styles, frame and receipt order', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_data, _encoding, done) { done(); } });
  child.stdin.on('finish', () => { child.emit('exit', 0, null); child.emit('close'); });
  const original = cp.spawn;
  let terminal;
  cp.spawn = () => child; syncBuiltinESMExports();
  try { terminal = new PiTerminal('parser-queued-transport'); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  try {
    await withWrites(async observed => {
      const frame = { type: 'frame', id: 1, generation: 1, frames: 1 };
      const chunks = [Buffer.from('\x1b[?2026h\x1b[31m'), ...[...Buffer.from('界éX')].map(byte => Buffer.from([byte])),
        Buffer.from('\x1b[0m\x1b[?2026l'), Buffer.from(`\x1b]777;tidy-test;${Buffer.from(JSON.stringify(frame)).toString('base64')}\x07`)];
      let reads = 0, published = false;
      terminal.events = () => { reads++; return published ? [{ type: 'agent_end' }] : []; };
      const pending = terminal.event('agent_end');
      for (const chunk of chunks.slice(0, -1)) child.stdout.write(JSON.stringify({ data: chunk.toString('base64') }) + '\n');
      await terminal.queue;
      assert.equal(reads, 1, 'raw data chunks do not repeatedly parse the journal');
      published = true;
      child.stdout.write(JSON.stringify({ data: chunks.at(-1).toString('base64') }) + '\n');
      await terminal.queue; await pending;
      assert.equal(reads, 2, 'a parsed notice rechecks actual published records');
      assert.equal(observed.callbacks, chunks.length);
      assert.ok(observed.maximum > 1, 'PTY delivery must not serialize native parser scheduling per transport chunk');
      assert.equal(observed.pending, 0);
      assert.deepEqual(Buffer.concat(terminal.raw), Buffer.concat(chunks));
      assert.equal(terminal.screen()[0], '界éX');
      assert.equal(terminal.term.buffer.active.getLine(0).getCell(0).getFgColor(), 1);
      assert.equal(terminal.rendering, false);
      assert.deepEqual(terminal.nativeReceipts.get('frame:1'), frame);
      assert.equal(terminal.error, undefined);
    });
  } finally { await terminal.close(); terminal.dispose(); }
});
