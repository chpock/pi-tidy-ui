import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import xterm from '@xterm/headless';
import { PiTerminal, observeRenderFrames } from './fixtures/terminal-harness.mjs';
import { compareEditReplayColors } from './fixtures/edit-replay-comparator.mjs';

const { Terminal } = xterm;

function journalReader(t) {
  const output = mkdtempSync(join(tmpdir(), 'pi-tidy-ui-journal-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  return Object.assign(Object.create(PiTerminal.prototype), { output, nativeProgress: new EventEmitter() });
}

test('CLI event journal: incomplete model-context record never reaches the JSON parser', t => {
  const reader = journalReader(t), path = join(reader.output, 'events.jsonl');
  const event = { type: 'model_context', text: 'x'.repeat(600) };
  const bytes = Buffer.from(JSON.stringify(event) + '\n');
  writeFileSync(path, bytes.subarray(0, 537));
  assert.deepEqual(reader.events(), []);
  appendFileSync(path, bytes.subarray(537));
  assert.deepEqual(reader.events(), [event]);
});

test('CLI event journal: every UTF8 snapshot returns only complete exact records', t => {
  const reader = journalReader(t), path = join(reader.output, 'events.jsonl');
  const events = [{ type: 'start' }, { type: 'call', text: 'я🙂\nline\r\n' }, { type: 'agent_end' }];
  const records = events.map(event => Buffer.from(JSON.stringify(event) + '\n'));
  const bytes = Buffer.concat(records);
  const ends = records.map((_, index) => records.slice(0, index + 1).reduce((sum, record) => sum + record.length, 0));
  for (let length = 0; length <= bytes.length; length++) {
    writeFileSync(path, bytes.subarray(0, length));
    assert.deepEqual(reader.events(), events.filter((_, index) => ends[index] <= length), `snapshot ${length}`);
  }
});

test('CLI event journal: valid JSON remains unpublished until its newline arrives', t => {
  const reader = journalReader(t), path = join(reader.output, 'events.jsonl');
  const event = { type: 'agent_end' };
  writeFileSync(path, JSON.stringify(event));
  assert.deepEqual(reader.events(), []);
  appendFileSync(path, '\n');
  assert.deepEqual(reader.events(), [event]);
});

test('CLI event journal: notification publishes an event exactly after its delimiter', async t => {
  const reader = journalReader(t), path = join(reader.output, 'events.jsonl');
  const event = { type: 'agent_end' };
  writeFileSync(path, JSON.stringify(event));
  let observed = false;
  const waiting = reader.event('agent_end').then(() => { observed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, false);
  reader.nativeProgress.emit('progress');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, false, 'a notification cannot publish an incomplete record');
  appendFileSync(path, '\n');
  reader.nativeProgress.emit('progress');
  await waiting;
  assert.equal(observed, true);
  assert.deepEqual(reader.events(), [event]);
});

test('CLI event journal: malformed completed records still fail immediately', t => {
  const reader = journalReader(t), path = join(reader.output, 'events.jsonl');
  for (const body of ['not-json\n', '{"type":\n', '{"type":"start"}\n{"type":\n{"unfinished":"']) {
    writeFileSync(path, body);
    assert.throws(() => reader.events(), SyntaxError);
  }
});

test('CLI event journal: missing files are empty and host failures remain visible', t => {
  const reader = journalReader(t);
  assert.deepEqual(reader.events(), []);
  const error = new Error('fixture host failed'); reader.error = error;
  assert.throws(() => reader.events(), thrown => thrown === error);
  delete reader.error;
  reader.exited = { code: 1, signal: null }; reader.stderr = 'fixture host exited';
  assert.throws(() => reader.events(), /Bridge exited/);
});

test('edit replay comparison: accepts exact cold foreground including wrapped source and rejects all unrelated changes', () => {
  const uncolored = { fg: 0x68b58d, fgMode: 50331648, dim: 0 };
  const colored = 0xa798d7, width = 36;
  const rows = [' ┃ ← Edited html-example.html', ' ┃   1 -   <meta charset>', ' ┃         var(--bg) 75%); }', ' ┃ …', ' ┃ +1 -1'];
  const expected = { width, screen: rows, tools: Array.from({ length: 7 }, (_, index) =>
    ({ name: 'edit', lines: index === 4 ? rows.map(row => `\x1b[38;2;167;152;215m${row}\x1b[39m`) : ['other'] })),
    cells: rows.map(row => Array.from({ length: width }, (_, x) => ({ text: row[x] ?? ' ', width: 1,
      fg: colored, fgMode: uncolored.fgMode, dim: 0, bold: 0, italic: 0, underline: 0, inverse: false, bg: 0x333435, bgMode: uncolored.fgMode }))) };
  const actual = { ...expected, tools: expected.tools.map(tool => ({ ...tool, lines: tool.lines.slice() })),
    cells: expected.cells.map(row => row.map(cell => ({ ...cell }))) };
  actual.tools[4].lines = rows.map(row => `\x1b[38;2;104;181;141m${row}\x1b[39m`);
  const sourceOrigin = /^\s*┃\s+\d+ [ +\-] /.exec(rows[1])[0].length;
  for (const row of [1, 2]) for (let x = sourceOrigin; x < width; x++) actual.cells[row][x].fg = uncolored.fg;
  compareEditReplayColors(expected, expected, uncolored);
  compareEditReplayColors(actual, expected, uncolored);
  for (const [row, column, field] of [[1, sourceOrigin, 'fg'], [1, sourceOrigin + 2, 'fg'],
    [2, sourceOrigin + 2, 'fg'], [1, sourceOrigin + 2, 'bg'], [1, sourceOrigin + 2, 'bold'],
    [1, 1, 'fg'], [0, 4, 'fg'], [3, 3, 'fg'], [4, 3, 'fg']]) {
    const damaged = { ...actual, cells: actual.cells.slice() };
    damaged.cells[row] = actual.cells[row].slice();
    damaged.cells[row][column] = { ...actual.cells[row][column], [field]: actual.cells[row][column][field] ^ 1 };
    assert.throws(() => compareEditReplayColors(damaged, expected, uncolored), `${field} at ${row}:${column} stays protected`);
  }
  const eagerChanged = { ...actual, tools: actual.tools.map(tool => ({ ...tool, lines: tool.lines.slice() })) };
  eagerChanged.tools[0].lines[0] = '\x1b[31mother\x1b[39m';
  assert.throws(() => compareEditReplayColors(eagerChanged, expected, uncolored), 'non-HTML color changes are never accepted');
});

for (const framed of [true, false]) test(`CLI popup closure distinguishes its own rows from native read arrows (${framed ? 'framed' : 'compact'})`,
  { timeout: 1000 }, async () => {
    const terminal = Object.create(PiTerminal.prototype);
    terminal.term = { cols: 24, rows: framed ? 12 : 3 };
    let closed = false, sends = 0;
    const selected = '→ Tidy UI appearan… On';
    terminal.screen = () => closed ? ['→ read a.txt'] : framed
      ? ['╭──────────────────────╮', `│${selected.padEnd(22)}│`, '╰──────────────────────╯'] : [selected];
    terminal.send = data => { assert.equal(data, '\x03'); sends++; closed = true; };
    terminal.settle = async () => {};
    assert.ok(terminal.tidyRows().some(row => row === selected));
    await terminal.closeTidyMenu();
    assert.equal(sends, 1); assert.deepEqual(terminal.tidyRows(), ['→ read a.txt']);
  });

for (const width of [39, 58, 72]) test(`CLI popup geometry observes ${width}-column frames after wide transcript characters`, () => {
  const terminal = Object.create(PiTerminal.prototype); terminal.term = { cols: 100, rows: 30 };
  const left = Math.floor((100 - width) / 2), prefix = '界'.repeat(4) + ' '.repeat(left - 8), inner = width - 2;
  terminal.screen = () => [prefix + `╭${'─'.repeat(inner)}╮` + 'background',
    prefix + `│${'→ Code color theme'.padEnd(inner)}│` + 'background', prefix + `╰${'─'.repeat(inner)}╯` + 'background'];
  assert.deepEqual(terminal.tidyFrame(), { left, width, top: 0, bottom: 2 });
  assert.deepEqual(terminal.tidyRows(), ['', '→ Code color theme', '']);
});

test('CLI cache JSON reader follows more than 100 public detail pages without truncation', async () => {
  const terminal = Object.create(PiTerminal.prototype), expected = Array.from({ length: 160 }, (_, value) => ({ value }));
  const details = ['Diagnostic JSON:', '[', ...expected.map((value, index) => JSON.stringify(value) + (index + 1 < expected.length ? ',' : '')), ']', 'End diagnostic JSON'];
  let offset = 0, closed = 0; const selected = [];
  terminal.openTidyMenu = async () => {};
  terminal.selectTidyItem = async label => { selected.push(label); };
  terminal.closeTidyMenu = async () => { closed++; };
  terminal.tidyRows = () => ['Display cache', '', details[offset], '→ Refresh statistics'];
  terminal.send = data => { assert.equal(data, '\x1b[6~'); offset = Math.min(details.length - 1, offset + 1); };
  assert.deepEqual(await terminal.cacheSnapshot(), expected);
  assert.ok(offset > 100); assert.equal(closed, 1);
  assert.deepEqual(selected, ['Status & troubleshooting', 'Display cache']);
});

test('CLI cache JSON reader waits for synchronized render completion instead of parsing a half-painted viewport', async () => {
  const terminal = Object.create(PiTerminal.prototype);
  terminal.term = new Terminal({ cols: 39, rows: 12, allowProposedApi: true });
  observeRenderFrames(terminal.term, terminal);
  terminal.queue = Promise.resolve();
  const write = text => terminal.queue = new Promise(done => terminal.term.write(text, done));
  const body = text => '│' + text.padEnd(37) + '│';
  const rows = ['╭' + '─'.repeat(37) + '╮', body('Display cache'), '├' + '─'.repeat(37) + '┤',
    body('Diagnostic JSON:'), body('{"answer":1}{"stale":2}'), body('End diagnostic JSON'), body('→ Refresh statistics'),
    body(''), body('Read current cache counters.'), '├' + '─'.repeat(37) + '┤', body('Esc Back · PgUp/PgDn'), '╰' + '─'.repeat(37) + '╯'];
  terminal.openTidyMenu = terminal.selectTidyItem = terminal.closeTidyMenu = async () => {};
  let unsafeReads = 0, closed = 0, outcome;
  terminal.closeTidyMenu = async () => { closed++; };
  terminal.captureScreen = () => {};
  terminal.tidyRows = () => { if (terminal.rendering) unsafeReads++; return PiTerminal.prototype.tidyRows.call(terminal); };
  await write('\x1b[?2026h\x1b[H' + rows.join('\r\n'));
  assert.equal(terminal.rendering, true, 'the actual emulator has parsed Begin Synchronized Output but not End');
  const pending = terminal.cacheSnapshot().then(value => { outcome = { value }; }, error => { outcome = { error }; });
  try {
    await new Promise(setImmediate);
    assert.equal(unsafeReads, 0, 'a syntactically invalid intermediate viewport must not be consumed as JSON');
    assert.equal(outcome, undefined, 'the reader remains pending rather than accepting or rejecting partial output');
    await write('\x1b[5;2H' + '{"answer":1}'.padEnd(37) + '\x1b[?2026l');
    await pending;
    if (outcome.error) throw outcome.error;
    assert.deepEqual(outcome.value, { answer: 1 });
    assert.equal(unsafeReads, 0); assert.equal(terminal.completedRenders, 1); assert.equal(closed, 1);
  } finally {
    if (terminal.rendering) await write('\x1b[?2026l');
    await pending; terminal.term.dispose();
  }
});


test('CLI scenario completion waits for the final complete frame after agent_end and output silence', async () => {
  const terminal = Object.create(PiTerminal.prototype);
  terminal.term = new Terminal({ cols: 60, rows: 4, allowProposedApi: true });
  observeRenderFrames(terminal.term, terminal);
  terminal.queue = Promise.resolve();
  const write = text => terminal.queue = new Promise(done => terminal.term.write(text, done));
  terminal.events = () => [];
  terminal.send = data => { assert.equal(data, 'run delayed-frame\r'); };
  terminal.event = async (name, count) => { assert.equal(name, 'agent_end'); assert.equal(count, 1); };
  let checks = 0, observeProvisional;
  const provisionalCheck = new Promise(resolve => { observeProvisional = resolve; });
  terminal.health = () => { checks++; if (terminal.rendering) observeProvisional(); };
  terminal.settle = async () => { await write('Working'); };
  let unsafeReads = 0, outcome;
  terminal.screen = () => { if (terminal.rendering) unsafeReads++; return PiTerminal.prototype.screen.call(terminal); };
  const pending = terminal.run('delayed-frame').then(() => { outcome = { passed: true }; }, error => { outcome = { error }; });
  try {
    await new Promise(setImmediate);
    assert.equal(outcome, undefined, 'agent_end and a quiet terminal do not prove that final output has rendered');
    const initialChecks = checks;
    await write('\x1b[?2026h\x1b[HTERMINAL_DONE_delayed-frame');
    await provisionalCheck; await new Promise(setImmediate);
    assert.ok(checks > initialChecks, 'a readiness iteration has observed the provisional marker frame');
    assert.equal(outcome, undefined, 'even the marker is provisional until its synchronized frame ends');
    await write('\x1b[?2026l');
    await pending;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.passed, true); assert.equal(unsafeReads, 0);
  } finally {
    if (terminal.rendering) await write('\x1b[?2026l');
    await pending; terminal.term.dispose();
  }
});


test('CLI reload command waits for fresh native completion rather than an old status or output silence', { timeout: 2000 }, async () => {
  const terminal = Object.create(PiTerminal.prototype);
  terminal.term = new Terminal({ cols: 100, rows: 5, allowProposedApi: true });
  observeRenderFrames(terminal.term, terminal);
  terminal.raw = []; terminal.queue = Promise.resolve();
  const write = text => {
    terminal.raw.push(Buffer.from(text));
    return terminal.queue = new Promise(done => terminal.term.write(text, done));
  };
  const done = 'Reloaded keybindings, extensions, skills, prompts, themes, and context files';
  const loading = 'Reloading keybindings, extensions, skills, prompts, themes, and context files...';
  await write(`\x1b[?2026h${done}\x1b[?2026l`);
  let sends = 0, outcome, observeProvisional, observedQuiet;
  const provisionalCheck = new Promise(resolve => { observeProvisional = resolve; });
  const quiet = new Promise(resolve => { observedQuiet = resolve; });
  terminal.nativeSequence = 0;
  terminal.send = data => {
    if (data === '/reload\r') sends++;
    else assert.equal(data, '\x1b[?997;1;1n');
  };
  terminal.nativeReceipt = async (type, id) => { assert.equal(type, 'armed'); assert.equal(id, 1); };
  terminal.health = () => { if (terminal.rendering) observeProvisional(); };
  terminal.nativeFence = async (id, kind) => {
    assert.equal(id, 1); assert.equal(kind, 2);
    await write(`\x1b[?2026h\x1b[H${done}\r\n${loading}\x1b[?2026l`); observedQuiet();
  };
  const pending = terminal.command('/reload').then(() => { outcome = { passed: true }; }, error => { outcome = { error }; });
  try {
    await quiet; await new Promise(setImmediate);
    assert.equal(outcome, undefined, 'quiet output and a previous success status do not establish current reload completion');
    await write(`\x1b[?2026h\x1b[H${done}`);
    await provisionalCheck; await new Promise(setImmediate);
    assert.equal(outcome, undefined, 'the fresh native completion remains provisional until the frame ends');
    await write('\x1b[?2026l'); await pending;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.passed, true); assert.equal(sends, 1, 'no retry of the reload action');
  } finally {
    if (terminal.rendering) await write('\x1b[?2026l');
    await pending; terminal.term.dispose();
  }
});
