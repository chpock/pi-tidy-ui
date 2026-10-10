// Real bundled CLI tests. Every capture is produced during this test run.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import xterm from '@xterm/headless';
import { getInstalledIntegrationProfile } from './fixtures/integration-profile.mjs';
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';

const { Terminal } = xterm;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.PI_TEST_CLI || 'pi';
const extension = join(root, 'src/index.ts');
const fixtures = join(root, 'tests/fixtures');
const artifacts = join(root, '.test-artifacts', `terminal-${Date.now()}-${process.pid}`);
mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const plain = (line) => stripVTControlCharacters(line).trimEnd();
const lines = (tool) => tool.lines.map(plain).filter((line) => line.trim());
const byName = (dump, name) => dump.tools.filter((tool) => tool.name === name);
const nativeTiming = (value) => value.replace(/Took \d+(?:\.\d+)?s/g, 'Took <runtime>s');
const toolLines = (dump) => dump.tools.map(({ name, lines }) => ({ name, lines: lines.map(nativeTiming) }));
async function assertFits(rows, width) {
  const terminal = new Terminal({ cols: width, rows: 4, allowProposedApi: true });
  try {
    for (const row of rows) {
      assert.ok(!/[\r\n]/.test(row), 'component row cannot contain a line break');
      terminal.reset();
      await new Promise((done) => terminal.write(row, done));
      assert.equal(terminal.buffer.active.cursorY, 0, `row must not wrap at ${width} columns`);
    }
  } finally { terminal.dispose(); }
}

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(30);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}; artifacts: ${artifacts}`);
}

export class PiTerminal {
  // The integration-profile helper may supply additional isolated settings, environment and explicit extensions.
  constructor(name, { toolview = false, mode = 'fullscreen', session, flags = [],
    agentSettings = {}, extraEnv = {}, extensions = [], workspace, profileFactory } = {}) {
    this.output = join(artifacts, name);
    mkdirSync(this.output);
    this.temp = mkdtempSync(join(tmpdir(), 'pi-toolview-terminal-'));
    this.work = workspace || join(this.temp, 'work');
    this.agent = join(this.temp, 'agent');
    mkdirSync(this.work, { recursive: true }); mkdirSync(this.agent);
    this.profile = profileFactory?.({ homeDir: this.temp, agentDir: this.agent, workDir: this.work,
      provider: 'toolview-offline', model: 'scripted' });
    for (const file of this.profile?.configFiles || []) {
      const path = resolve(file.path);
      assert.ok(path.startsWith(this.temp + '/'), 'profile config must remain inside the fresh test home');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    if (this.profile) writeFileSync(join(this.output, 'integration-profile.json'), JSON.stringify(this.profile, null, 2));
    if (!session) rmSync(join(this.work, 'written.txt'), { force: true });
    writeFileSync(join(this.work, 'a.txt'), 'READ_A_CONTENT\n');
    writeFileSync(join(this.work, 'b.txt'), 'READ_B_CONTENT\n');
    if (!session) {
      writeFileSync(join(this.work, 'write-empty.ts'), '');
      writeFileSync(join(this.work, 'write-cleared.ts'), 'const old = 1;\n');
      mkdirSync(join(this.work, 'write-directory'), { recursive: true });
      rmSync(join(this.work, 'write-stock.ts'), { force: true });
    }
    if (!session) {
      if (extraEnv.TOOLVIEW_TEST_EDIT_PERFORMANCE === '1') writeFileSync(join(this.work, 'edit-minified.ts'), 'x+=1;'.repeat(3200) + '\n');
      writeFileSync(join(this.work, 'edit-example.ts'), 'export const before = 10;\n' +
        Array.from({ length: 18 }, (_, i) => `const context${i} = ${i};`).join('\n') +
        '\nconst label = "old";\nexport function greet(name: string) { return "hello"; }\n/* syntax comment\ncontinued comment */\nconst multiline = `first\ncontinued template\nend`;\n');
      writeFileSync(join(this.work, 'edit-direction.ts'), 'const retained = 1;\nconst removeOnly = 2;\nconst directionTail = 3;\n');
      writeFileSync(join(this.work, 'edit-long.ts'), 'const before = "' + 'before 界é '.repeat(14) + '";\nconst tail = 40;\n');
      writeFileSync(join(this.work, 'index.html'), '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="theme-color" content="#0b1020">\n  <title>Neon Blocks — Tetris</title>\n' +
        '  <style>\n    :root { --bg: #0b1020; }\n    body { background: radial-gradient(ellipse at 50% 8%, #202b52 0, #10172c 38%, var(--bg) 75%); }\n    .app { width: min(100%, 760px); }\n  </style>\n</head>\n<body>\n  <main class="app">\n</body>\n</html>\n');
    }
    writeFileSync(join(this.work, 'abcdefghijklm'), 'BOUNDARY_READ_CONTENT\n');
    mkdirSync(join(this.work, 'long-directory'), { recursive: true });
    writeFileSync(join(this.work, 'long-directory', 'r'.repeat(180) + '.txt'), 'LONG_READ_CONTENT\n');
    writeFileSync(join(this.work, 'pixel.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
    writeFileSync(join(this.agent, 'settings.json'), JSON.stringify({
      theme: 'dark', quietStartup: true, ...this.profile?.settings, ...agentSettings,
      enableAnalytics: false, enableInstallTelemetry: false,
    }));
    this.term = new Terminal({ cols: 100, rows: 80, scrollback: 3000, allowProposedApi: true });
    this.raw = [];
    this.pointerInputs = [];
    this.queue = Promise.resolve();
    this.lastOutput = Date.now();
    this.resizeSequence = 0;
    const args = ['-ns', '-np', '-nc', '-na', '--offline', '-e', join(fixtures, 'driver.ts')];
    if (!this.profile) args.unshift('-ne', '--no-themes');
    for (const path of extensions) args.push('-e', resolve(path));
    if (toolview) args.push('-e', extension);
    args.push('--model', 'toolview-offline/scripted', '--tui-mode', mode, ...flags);
    if (session) args.push('--session', session);
    const env = this.profile ? { ...this.profile.env, TOOLVIEW_TEST_OUTPUT: this.output, TOOLVIEW_TEST_PROFILE: 'installed' } : {
      ...extraEnv,
      PATH: process.env.PATH, HOME: this.temp, XDG_CONFIG_HOME: join(this.temp, 'config'),
      XDG_CACHE_HOME: join(this.temp, 'cache'), XDG_DATA_HOME: join(this.temp, 'data'),
      TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
      PI_CODING_AGENT_DIR: this.agent, TOOLVIEW_TEST_OUTPUT: this.output,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
    this.child = spawn('python3', [join(fixtures, 'pty_bridge.py'), '100', '80', this.work, cli, ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => { this.error = error; });
    this.child.stdin.on('error', (error) => { if (!this.closing) this.error = error; });
    this.stderr = '';
    this.child.stderr.on('data', (data) => { this.stderr += data; });
    this.child.on('exit', (code, signal) => { this.exited = { code, signal }; });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.error) this.error = new Error(frame.error);
        if (frame.resized) this.ptySize = { id: frame.id, width: frame.resized[0], height: frame.resized[1] };
        if (frame.data) {
          const data = Buffer.from(frame.data, 'base64');
          this.raw.push(data);
          this.lastOutput = Date.now();
          this.queue = this.queue.then(() => new Promise((done) => this.term.write(data, done)));
        }
        if (frame.exit !== undefined && !this.closing) this.error = new Error(`Pi exited: ${frame.exit}`);
      } catch (error) { this.error = error; }
    });
    // Let the terminal emulator answer native cursor/device queries, just as a terminal would.
    this.term.onData((data) => this.send(data));
    writeFileSync(join(this.output, 'invocation.json'), JSON.stringify({ cli, args, mode, work: this.work }, null, 2));
  }
  send(data) {
    if (!this.closing && this.child.stdin.writable) {
      this.lastOutput = Date.now();
      if (/\x1b\[<|\x1b\[[IO]/u.test(data)) this.pointerInputs.push(data);
      this.child.stdin.write(JSON.stringify({ input: Buffer.from(data).toString('base64') }) + '\n');
    }
  }
  health() {
    if (this.error || this.exited) throw this.error || new Error(`Bridge exited ${JSON.stringify(this.exited)}: ${this.stderr}`);
  }
  events() {
    this.health();
    try {
      return readFileSync(join(this.output, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async event(type, count = 1) {
    return until(() => this.events().filter((event) => event.type === type).length >= count, `${type} #${count}`);
  }
  async ready() {
    await this.event('start');
    assert.equal(this.events().find((event) => event.type === 'start').sharedContainer, true);
    await this.settle();
  }
  async settle(animated = false) {
    if (animated) {
      // A running Pi spinner deliberately never becomes idle. Sample after a render interval.
      await sleep(220); this.health();
    } else {
      await until(() => { this.health(); return Date.now() - this.lastOutput >= 160; }, 'terminal idle');
    }
    await this.queue;
  }
  async command(command) {
    this.send(command + '\r');
    await this.settle();
  }
  screen() {
    const buffer = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
  }
  async capture(name, { animated = false } = {}) {
    this.send(`/tv-dump ${name}\r`);
    const dump = await until(() => {
      this.health();
      try { return JSON.parse(readFileSync(join(this.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `live capture ${name}`);
    await this.settle(animated);
    this.session = dump.session;
    return this.captureScreen(name, dump);
  }
  captureScreen(name, dump) {
    const screen = this.screen();
    writeFileSync(join(this.output, `${name}.screen.txt`), screen.join('\n'));
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    const buffer = this.term.buffer.active;
    const cells = screen.map((_, y) => Array.from({ length: this.term.cols }, (_, x) => {
      const cell = buffer.getLine(buffer.viewportY + y)?.getCell(x);
      return cell ? { text: cell.getChars(), width: cell.getWidth(),
        fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim(), bold: cell.isBold(),
        italic: cell.isItalic(), underline: cell.isUnderline(), inverse: !!cell.isInverse(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() } : null;
    }));
    writeFileSync(join(this.output, `${name}.screen.json`), JSON.stringify(cells));
    return { ...dump, screen, cells };
  }
  async run(scenario = 'suite') {
    const count = this.events().filter((e) => e.type === 'agent_end').length;
    this.send(`run ${scenario}\r`);
    await this.event('agent_end', count + 1);
    await this.settle();
    assert.ok(this.screen().some((line) => line.includes(`TERMINAL_DONE_${scenario}`)));
  }
  async resize(cols, rows = 80, animated = false) {
    const id = ++this.resizeSequence;
    this.term.resize(cols, rows);
    this.child.stdin.write(JSON.stringify({ resize: [cols, rows], id }) + '\n');
    await until(() => {
      this.health();
      return this.ptySize?.id === id && this.ptySize.width === cols && this.ptySize.height === rows;
    }, `PTY resize ${id}: ${cols}x${rows}`);
    // ioctl completion precedes Node's SIGWINCH/TTY refresh. Read the driver's
    // actual host observation, never infer dimensions from quiet output.
    // Identical sizes need no new resize event, but still require the fresh receipt above.
    await until(() => {
      const size = this.events().findLast(event => event.type === 'terminal_size');
      return size?.width === cols && size.height === rows;
    }, `Pi geometry ${id}: ${cols}x${rows}`);
    await this.settle(animated);
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    writeFileSync(join(this.output, 'bridge.stderr'), this.stderr);
    writeFileSync(join(this.output, 'pointer-inputs.json'), JSON.stringify(this.pointerInputs, null, 2));
    if (this.session && existsSync(this.session)) copyFileSync(this.session, join(this.output, 'session.jsonl'));
    if (existsSync(join(this.work, 'written.txt')))
      copyFileSync(join(this.work, 'written.txt'), join(this.output, 'written.txt'));
    if (!this.exited) {
      const done = once(this.child, 'exit');
      this.child.stdin.end('{"stop":true}\n');
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 2500);
      let deadline;
      try { await Promise.race([done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Bridge cleanup timeout')), 5500);
      })]); }
      finally { clearTimeout(timer); clearTimeout(deadline); }
    }
    this.rl.close(); this.term.dispose();
  }
  dispose() { rmSync(this.temp, { recursive: true, force: true }); }
}

function execution(terminal) {
  const events = terminal.events();
  assert.equal(events.filter((e) => e.type === 'call').length, 7);
  assert.equal(events.filter((e) => e.type === 'result').length, 7);
  assert.equal(events.filter((e) => e.type === 'model_context').length, 8);
  return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
}
function persisted(dump) {
  return dump.branch.filter((e) => e.type === 'message').flatMap(({ message }) => {
    if (message.role === 'toolResult') return [{ role: message.role, toolName: message.toolName,
      content: message.content, details: message.details, isError: message.isError }];
    if (message.role === 'assistant') return message.content.filter((c) => c.type === 'toolCall')
      .map(({ name, arguments: args }) => ({ name, arguments: args }));
    return [];
  });
}
// Separators are not content rows. Recover logical text without relying on a one-row preview.
const summaryText = (tool) => lines(tool).map((row) => row.slice(3)).join('').replace(/\s/gu, '');
const summaryExpected = (value) => value.replace(/\s/gu, '');
function compactContent(tool) {
  const rows = lines(tool);
  assert.ok(rows.length > 0, `compact content exists: ${tool.id}`);
  assert.equal(rows[0].slice(0, 3), tool.name === 'read' ? ' → ' : ['edit', 'write'].includes(tool.name) ? ' ← ' : ' ⚙ ', `compact prefix: ${tool.id}`);
  for (const row of rows.slice(1)) assert.match(row, /^ {3}\S/, `continuation aligns at tool-name column: ${tool.id}`);
  assert.doesNotMatch(rows.join(''), /✓|✗/u, `completion markers are disabled: ${tool.id}`);
  assert.ok(!rows.at(-1).endsWith(' '), `hidden marker leaves no trailing separator space: ${tool.id}`);
  return rows;
}
function compact(dump) {
  const reads = byName(dump, 'read');
  assert.equal(reads.length, 3);
  for (const [i, tool] of reads.entries()) {
    const rows = compactContent(tool);
    if (i < 2) assert.equal(rows.length, 1, `short read stays single-row: ${tool.id}`);
    assert.match(rows[0], /\bread\b/);
    assert.equal(summaryText(tool), summaryExpected(`read ${['a.txt', 'b.txt', 'missing.txt'][i]}${i === 0 ? ' [offset=1, limit=1]' : ''}`));
  }
  assert.doesNotMatch(summaryText(reads[2]), /ENOENT|nosuch|notfound|Error/i, 'failed summary contains call arguments, never the error body');
  const unknown = byName(dump, 'tv_unknown')[0];
  assert.equal(lines(unknown).length, 1);
  assert.equal(summaryText(unknown), summaryExpected('tv_unknown [query="wide 界 é query"]'));
  const a = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(a >= 0, 'first compact read is on the real screen');
  assert.match(dump.screen[a + 1], /\bread\b.*b\.txt/, 'consecutive compact reads have no blank screen row');
  assert.doesNotMatch(dump.screen[a], /✓|✗/u);
  assert.ok(!dump.screen.some((line) => /READ_[AB]_CONTENT|UNKNOWN_RESULT/.test(line)), 'collapsed output is hidden on screen');
  // Compact summaries have no card background, including their text cells.
  for (const y of [a, a + 1]) {
    const x = dump.screen[y].indexOf('read');
    assert.equal(dump.cells[y][x].bgMode, 0, 'compact summary has terminal-default background');
  }
  const doc = dump.document.map(plain);
  const first = doc.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(first >= 0);
  assert.match(doc[first + 1], /\bread\b.*b\.txt/);
}

async function semanticColors(dump) {
  const row = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(row >= 0);
  assert.match(dump.screen[row], /read a\.txt \[offset=1, limit=1\]/);
  const customRow = dump.screen.findIndex((line) => line.includes('⚙ tv_unknown'));
  assert.ok(customRow >= 0, 'gear-prefixed unknown tool appears on the actual screen');
  assert.equal(dump.cells[customRow][1].text, '⚙');
  assert.equal(dump.cells[customRow][1].width, 1, 'gear is one terminal column, not emoji presentation');
  assert.equal(dump.screen[customRow].indexOf('tv_unknown'), 3, 'gear keeps tool-name alignment');
  const samples = [
    [row, 'dim', '→'], [row, 'toolTitle', 'read'], [row, 'muted', 'a.txt'], [row, 'dim', '[offset='],
    [customRow, 'dim', '⚙'],
  ];
  const reference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    for (const [sampleRow, role, text] of samples) {
      reference.reset();
      await new Promise((done) => reference.write(dump.summaryStyles[role], done));
      const expected = reference.buffer.active.getLine(0).getCell(0);
      const actual = dump.cells[sampleRow][dump.screen[sampleRow].indexOf(text)];
      assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim },
        { fg: expected.getFgColor(), fgMode: expected.getFgColorMode(), dim: expected.isDim() },
        `real screen ${text} uses theme role ${role}`);
    }
  } finally { reference.dispose(); }
  const custom = dump.screen[customRow];
  assert.match(custom, /tv_unknown \[query="wide/);
  await errorSummaryColors(dump, byName(dump, 'read').find((tool) => tool.isError));
}

async function errorSummaryColors(dump, tool) {
  assert.equal(tool.isError, true);
  const rows = compactContent(tool);
  const y = dump.screen.findIndex((row, index) => row === rows[0] &&
    rows.every((expected, offset) => dump.screen[index + offset] === expected));
  assert.ok(y >= 0, 'complete failed compact call is present on the actual screen');
  const reference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  let checkedCells = 0;
  try {
    await new Promise((done) => reference.write(dump.summaryStyles.error, done));
    const sample = reference.buffer.active.getLine(0).getCell(0);
    const expected = { fg: sample.getFgColor(), fgMode: sample.getFgColorMode(), dim: sample.isDim() };
    for (let offset = 0; offset < rows.length; offset++) {
      for (const cell of dump.cells[y + offset]) {
        if (!cell.text.trim()) continue;
        assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, expected,
          'every visible failure glyph/name/description/connector/parameter cell uses the active error role');
        assert.equal(cell.bgMode, 0, 'failed compact summary retains terminal-default background');
        checkedCells++;
      }
      assert.ok(['', ' '].includes(dump.cells[y + offset][dump.width - 1].text), 'failure retains one blank right column');
    }
    assert.ok(checkedCells > 0);
    return checkedCells;
  } finally { reference.dispose(); }
}

const stockOnly = process.env.TOOLVIEW_TERMINAL_STOCK_ONLY === '1';
const leadingBlanks = (tool) => tool.lines.findIndex((row) => plain(row).trim());
function nativeAfterMultiline(tool, control) {
  const expected = leadingBlanks(control) === 0 ? ['', ...control.lines] : control.lines;
  assert.deepEqual(tool.lines, expected, `native ${tool.name} unchanged except missing separator`);
  assert.equal(leadingBlanks(tool), 1, `exactly one native separator: ${tool.name}`);
}
const summaryGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const summarySize = (text) => [...summaryGraphemes.segment(text)].length;
// Independent fixture oracle: serialized prefixes have no escape boundary at the cutoff.
function fixtureQuotedPreview(text) {
  const quoted = [...summaryGraphemes.segment(JSON.stringify(text))].map(({ segment }) => segment);
  return quoted.length <= 256 ? quoted.join('') : quoted.slice(0, 254).join('') + '…"';
}
function fixtureBoundedSummary(name, primary, parameters) {
  const title = name + (primary ? ' ' + primary : '');
  const retained = [];
  for (const [index, parameter] of parameters.entries()) {
    const candidate = [...retained, parameter, ...(index + 1 < parameters.length ? ['…'] : [])];
    if (summarySize(title + ' [' + candidate.join(', ') + ']') > 1024) { retained.push('…'); break; }
    retained.push(parameter);
  }
  return title + (retained.length ? ' [' + retained.join(', ') + ']' : '');
}
function multilineLayout(dump, wide) {
  const reads = byName(dump, 'read');
  const empty = byName(dump, 'tv_noargs');
  const summaries = byName(dump, 'tv_summary');
  assert.equal(reads.length, 4);
  assert.equal(summaries.length, 8);
  assert.equal(empty.length, 3);
  for (const hidden of byName(dump, 'tv_hidden')) assert.deepEqual(hidden.lines, [], 'hidden components have zero rows');
  for (const tool of dump.tools.filter((tool) => ['read', 'tv_noargs', 'tv_summary'].includes(tool.name))) {
    compactContent(tool);
    assert.ok(leadingBlanks(tool) <= 1, `never duplicate separator: ${tool.id}`);
    assert.ok(plain(tool.lines.at(-1)).trim(), `no trailing separator: ${tool.id}`);
    if (wide) assert.equal(summaryText(tool), summaryText(wide.tools.find((item) => item.id === tool.id)), 'every value survives narrow wrapping');
  }
  assert.equal(leadingBlanks(reads[1]), 0, 'single follows single without separator');
  assert.equal(leadingBlanks(reads[2]), 0, 'multiline following single has no separator');
  assert.ok(lines(reads[2]).length > 1, 'real long-path read wraps');
  assert.equal(leadingBlanks(empty[0]), 1, 'hidden between multiline and next is skipped');
  assert.equal(leadingBlanks(empty[1]), 0, 'leading separator does not turn prior single into multiline');
  assert.equal(leadingBlanks(summaries[0]), 0, 'multiline after single has no separator');
  assert.equal(leadingBlanks(summaries[1]), 0, 'pattern call follows single read without separator');
  assert.equal(summaryText(empty[0]), summaryExpected('tv_noargs'), 'no invented no-args placeholder');
  assert.equal(summaryText(reads[2]), summaryExpected('read long-directory/' + 'r'.repeat(180) + '.txt [offset=1, limit=1]'));
  const query = 'quoted "query"\\value 界 é ' + 'UNBREAKABLE'.repeat(30) + ' END_QUERY_VISIBLE';
  const parameters = [
    'op="trace"', 'action="inspect"', 'command="command"', `query=${fixtureQuotedPreview(query)}`, 'queries=["first","second"]', 'subject="subject"',
    'symbol="symbol"', 'symbols=["one","two"]', 'startLine=0', 'endLine=0', 'offset=0', 'limit=0', 'maxTokens=0',
    'AFirst="FIRST_ALPHA_VISIBLE"', 'Authorization="<redacted>"', 'Content="CASE_SENSITIVE_PAYLOAD_VISIBLE"', 'Token="CASE_SENSITIVE_TOKEN_VISIBLE"',
    'access_token="<redacted>"', 'apiKey="<redacted>"', 'api_key="<redacted>"', 'authorization="<redacted>"', 'count=0', 'empty=""', 'enabled=false',
    'nested={"input":"NESTED_PAYLOAD_VISIBLE","token":"NESTED_TOKEN_VISIBLE","values":[false,0,"nested quoted value"],"clean":"clean nestedvalue"}',
    'nothing=null', '"odd key"="QUOTED_KEY"', 'passwd="<redacted>"', 'password="<redacted>"', 'refresh_token="<redacted>"', 'sanitized="white space redend"', 'secret="<redacted>"', 'token="<redacted>"', 'zLast="LAST_FIELD_VISIBLE"',
    'content="PAYLOAD_CONTENT_HIDDEN"', 'edits=["PAYLOAD_EDITS_HIDDEN"]', 'code="PAYLOAD_CODE_HIDDEN"', 'input="PAYLOAD_INPUT_HIDDEN"',
    'messages=["PAYLOAD_MESSAGES_HIDDEN"]', 'prompt="PAYLOAD_PROMPT_HIDDEN"', 'newString="PAYLOAD_NEWSTRING_HIDDEN"', 'oldString="PAYLOAD_OLDSTRING_HIDDEN"',
    'appendContent="PAYLOAD_APPEND_HIDDEN"', 'rewrite="PAYLOAD_REWRITE_HIDDEN"', 'oldText="PAYLOAD_OLDTEXT_HIDDEN"', 'newText="PAYLOAD_NEWTEXT_HIDDEN"',
  ];
  assert.equal(summaryText(summaries[0]), summaryExpected(fixtureBoundedSummary('tv_summary', '', parameters)), 'action-first/alpha/content ordering, capped values, overall budget and exact masking');
  assert.doesNotMatch(summaries[0].lines.join(''), /\u202e|\u001b\[31m/u, 'top-level and nested controls cannot affect terminal presentation');
  assert.ok(lines(summaries[0]).length > (dump.width === 24 ? 30 : 4), 'bounded logical text still wraps normally rather than acquiring a row cap');
  const expected = [
    'tv_summary "needle \\"quoted\\"" [query="always named", paths=["ordinary-path"], path=["src dir","tests"], target="ordinary-target", url="https://example.invalid/ordinary", scope="ordinary-scope", enabled=true]',
    'tv_summary "chosen target" [query="named", paths=["ordinary-path"], path=null, url="ordinary-url", scope="ordinary-scope", pattern=0]',
    'tv_summary chosen-path [paths=["ordinary-path"], target="ordinary-target", url="ordinary-url", scope="ordinary-scope"]',
    'tv_summary https://example.invalid/chosen [paths=[], scope="ordinary-scope", pattern=false]',
    'tv_summary [paths=["ordinary-path"], scope=[]]',
    'tv_summary [paths=[]]',
    'tv_summary "" [query="", path=[]]',
  ];
  for (const [index, expectedSummary] of expected.entries())
    assert.equal(summaryText(summaries[index + 1]), summaryExpected(expectedSummary), `primary selection case ${index + 1}`);
}


test('real CLI: isolated offline stock control and terminal transport', { timeout: 60000 }, async () => {
  const stock = new PiTerminal('stock-control');
  try {
    await stock.ready(); await stock.run();
    const dump = await stock.capture('collapsed');
    assert.equal(dump.tools.length, 7);
    assert.deepEqual(stock.events().filter((e) => e.type === 'call').map((e) => e.name),
      ['read', 'read', 'bash', 'write', 'edit', 'tv_unknown', 'read']);
    assert.equal(stock.events().filter((e) => e.type === 'result').at(-1).isError, true);
    assert.ok(byName(dump, 'read')[0].lines.length > 2, 'stock read has card padding');
    const stockRow = dump.screen.findIndex((line) => line.includes('read a.txt'));
    assert.ok(stockRow >= 0);
    assert.notEqual(dump.cells[stockRow][dump.screen[stockRow].indexOf('read')].bgMode, 0);
    for (const text of ['BASH_RESULT', 'UNKNOWN_RESULT'])
      assert.ok(dump.screen.some((line) => line.includes(text)), `stock screen shows ${text}`);
    assert.equal(readFileSync(join(stock.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
    stock.send('\x0f'); await stock.settle();
    const expanded = await stock.capture('expanded');
    assert.ok(expanded.tools.every((tool) => tool.expanded), 'real Ctrl+O reaches Pi');
    for (const text of ['READ_A_CONTENT', 'READ_B_CONTENT'])
      assert.ok(expanded.screen.some((line) => line.includes(text)), `expanded stock shows ${text}`);
    stock.send('\x0f'); await stock.settle();
    await stock.resize(24);
    const narrow = await stock.capture('narrow');
    assert.equal(narrow.width, 24);
    await stock.resize(100);
    await stock.command('/tv-theme light');
    assert.equal(stock.events().findLast((e) => e.type === 'theme').result.success, true);
    await stock.capture('light');
    copyFileSync(dump.session, join(stock.output, 'session.jsonl'));
  } finally { await stock.close(); stock.dispose(); }
});

test('real CLI: delayed PTY resize confirms Pi geometry before width height and identical-size captures',
  { timeout: 60000 }, async () => {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`delayed-resize-${mode}`, { mode, toolview: true,
        extraEnv: { TOOLVIEW_TEST_RESIZE_DELAY_MS: '750', TOOLVIEW_TEST_RESIZE_HOLD_MS: '500' } });
      try {
        await terminal.ready();
        assert.deepEqual(terminal.events().findLast(e => e.type === 'terminal_size'),
          { type: 'terminal_size', width: 100, height: 80 });
        const sizes = [[24, 80], [24, 24], [24, 24], [100, 80], [24, 80]];
        for (const [index, [width, height]] of sizes.entries()) {
          await terminal.resize(width, height);
          assert.deepEqual(terminal.ptySize, { id: index + 1, width, height }, 'each resize has a fresh matching PTY receipt');
          assert.deepEqual(terminal.events().findLast(e => e.type === 'terminal_size'),
            { type: 'terminal_size', width, height }, 'resize cannot finish before Pi observes the requested geometry');
          const dump = await terminal.capture(`geometry-${index}`);
          assert.equal(dump.width, width); assert.equal(terminal.term.cols, width); assert.equal(terminal.term.rows, height);
          await assertFits(dump.editor.lines, width);
        }
        assert.equal(terminal.events().filter(e => ['call', 'model_context'].includes(e.type)).length, 0,
          'geometry synchronization does not submit model/tool input');
      } finally { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: Toolview policy, input, lifecycle and same-session stock replay',
  { skip: stockOnly, timeout: 180000 }, async () => {
    assert.ok(existsSync(extension), 'Implement src/index.ts first; use TOOLVIEW_TERMINAL_STOCK_ONLY=1 for transport validation');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); return terminal;
    };
    try {
      const stock = await start('comparison-stock', {});
      await stock.run(); const control = await stock.capture('collapsed');
      stock.send('\x0f'); await stock.settle(); const controlExpanded = await stock.capture('expanded');
      const live = await start('toolview-fullscreen', { toolview: true, workspace: stock.work });
      await live.run(); const collapsed = await live.capture('collapsed'); compact(collapsed);
      await semanticColors(collapsed);
      simpleBashCards(collapsed);
      assert.deepEqual(execution(live), execution(stock), 'real calls, results, and provider-visible results stay unchanged');
      assert.deepEqual(persisted(collapsed), persisted(control), 'persisted tool messages stay unchanged');
      assert.equal(readFileSync(join(live.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
      // Only cross-run live bash runtime text is normalized; same-process and replay checks below are exact.
      assert.match(byName(collapsed, 'write')[0].lines.map(plain).join('\n'), /← Wrote written\.txt[\s\S]*1 WRITE_BEFORE/u);
      assert.doesNotMatch(byName(collapsed, 'write')[0].lines.map(plain).join('\n'), /1 \+ WRITE_BEFORE/u);
      assert.ok(byName(collapsed, 'edit')[0].lines.some((row) => plain(row).includes('← Edited written.txt')), 'edit now uses the custom numbered diff card');
      assert.ok(byName(collapsed, 'edit')[0].lines.some((row) => /1 \+ WRITE_AFTER/.test(plain(row))));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      simpleBashCards(expanded);
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: controlExpanded.tools.filter((tool) => tool.name !== 'bash') }));
      assert.ok(expanded.screen.some((line) => line.includes('READ_A_CONTENT')));
      live.send('\x0f'); await live.settle(); const recollapsed = await live.capture('recollapsed');
      assert.deepEqual(toolLines(recollapsed), toolLines(collapsed)); compact(recollapsed);
      const row = recollapsed.screen.findIndex((line) => /\bread\b.*b\.txt/.test(line));
      const column = recollapsed.screen[row].indexOf('read') + 1;
      live.send(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await live.settle(); const clicked = await live.capture('clicked');
      assert.equal(byName(clicked, 'read')[0].expanded, false);
      assert.equal(byName(clicked, 'read')[1].expanded, true, 'SGR click expands precisely the chosen compact row');
      assert.ok(clicked.screen.some((line) => line.includes('READ_B_CONTENT')));
      // Collapse with stock mouse handling on the expanded title, not direct method invocation.
      const titleRow = clicked.screen.findIndex((line) => line.includes('b.txt'));
      assert.ok(titleRow >= 0);
      live.send(`\x1b[<0;${column};${titleRow + 1}M\x1b[<0;${column};${titleRow + 1}m`);
      await live.settle(); compact(await live.capture('mouse-collapsed'));
      await live.command('/toolview status');
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.ok(off.screen.some((line) => line.includes('read a.txt')));
      const offRow = off.screen.findIndex((line) => line.includes('read a.txt'));
      assert.notEqual(off.cells[offRow][off.screen[offRow].indexOf('read')].bgMode, 0, 'disabled read is a stock card on screen');
      await live.command('/toolview on'); compact(await live.capture('enabled'));
      await live.command('/toolview on'); compact(await live.capture('enabled-twice'));
      const starts = live.events().filter((e) => e.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      compact(await live.capture('reloaded'));
      await live.run('future');
      const future = await live.capture('future-after-reload');
      assert.equal(byName(future, 'tv_unknown').length, 2);
      assert.equal(lines(byName(future, 'tv_unknown')[1]).length, 1, 'future attachment is compact after reload');
      assert.match(lines(byName(future, 'tv_unknown')[1])[0], /^ ⚙ tv_unknown \[query="future after reload"\]$/u);
      compact(future);
      await live.resize(24); const narrow = await live.capture('narrow');
      assert.equal(narrow.width, 24);
      for (const tool of narrow.tools.filter((t) => ['read', 'tv_unknown'].includes(t.name))) {
        compactContent(tool);
        const wideTool = future.tools.find((candidate) => candidate.id === tool.id);
        assert.equal(summaryText(tool), summaryText(wideTool), 'narrow wrapping retains complete summary');
        await assertFits(tool.lines, 24);
      }
      const narrowReads = narrow.screen.filter((line) => /\bread\b/.test(line));
      assert.equal(narrowReads.length, 3, 'each narrow read has exactly one first row');
      assert.ok(narrow.screen.some((line) => /⚙ tv_unknown/.test(line)));
      assert.ok(narrow.screen.some((line) => line.includes('→ read missing.txt')), 'failed compact call remains visible without an error preview or failure badge');
      for (const tool of narrow.tools.filter((tool) => ['read', 'tv_unknown'].includes(tool.name))) assert.doesNotMatch(tool.lines.map(plain).join(''), /✓|✗/u);
      await live.resize(100);
      const dark = await live.capture('dark');
      await live.command('/tv-theme light'); const light = await live.capture('light'); compact(light);
      await semanticColors(light);
      assert.equal(live.events().findLast((e) => e.type === 'theme').result.success, true);
      assert.deepEqual(light.tools.map((t) => t.lines.map(plain)), dark.tools.map((t) => t.lines.map(plain)));
      assert.notDeepEqual(byName(light, 'read')[0].lines, byName(dark, 'read')[0].lines, 'theme colors are refreshed');
      await live.command('/tv-theme dark');
      const beforeReplay = await live.capture('before-replay');
      const session = beforeReplay.session;
      copyFileSync(session, join(live.output, 'session.jsonl'));
      await live.close();
      const replay = await start('toolview-replay', { toolview: true, session, workspace: stock.work });
      const resumed = await replay.capture('collapsed'); compact(resumed); simpleBashCards(resumed);
      const nativeReplay = await start('stock-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('collapsed');
      assert.deepEqual(byName(resumed, 'write')[0].lines, byName(beforeReplay, 'write')[0].lines, 'same-session Wrote replay retains the exact input-source card');
      assert.deepEqual(resumed.tools.map(({ name, content }) => ({ name, content })), beforeReplay.tools.map(({ name, content }) => ({ name, content })));
      await replay.command('/toolview off'); const disabledReplay = await replay.capture('disabled');
      assert.deepEqual(disabledReplay.tools.map((t) => t.lines), native.tools.map((t) => t.lines), 'disable restores exact same-session stock rendering');
      const regular = await start('toolview-regular', { toolview: true, mode: 'regular' });
      await regular.run(); compact(await regular.capture('collapsed'));
      regular.send('\x0f'); await regular.settle(); const regularExpanded = await regular.capture('expanded');
      assert.ok(regularExpanded.tools.every((t) => t.expanded));
      assert.ok(regularExpanded.screen.some((line) => line.includes('READ_B_CONTENT')));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: complete multiline summaries, adaptive separation, continuation clicks and replay',
  { skip: stockOnly, timeout: 180000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const events = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 19);
      assert.equal(observed.filter((event) => event.type === 'result').length, 19);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 20);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    const flags = ['--toolview-card', 'tv_card'];
    try {
      const stock = await start('multiline-stock');
      await stock.run('multiline'); const control = await stock.capture('collapsed');
      const live = await start('multiline-toolview', { toolview: true, flags, workspace: stock.work });
      await live.run('multiline'); const wide = await live.capture('wide');
      multilineLayout(wide);
      assert.deepEqual(events(live), events(stock), '19 real calls/results and 20 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(control), 'full payloads and synthetic secrets remain native session data');
      assert.ok(persisted(wide).some((entry) => entry.arguments?.token === 'TOP_TOKEN_HIDDEN'));
      assert.ok(byName(wide, 'tv_summary')[0].content[0].text.includes('PAYLOAD_CONTENT_HIDDEN'));
      for (const tool of wide.tools) await assertFits(tool.lines, 100);
      nativeAfterMultiline(byName(wide, 'tv_card')[0], byName(control, 'tv_card')[0]);
      simpleBashCards(wide, 'MULTILINE_NATIVE_BASH');
      const reads = byName(wide, 'read');
      const readRow = wide.screen.findIndex((row) => row === lines(reads[2])[0]);
      assert.ok(readRow >= 0, 'real multiline read is on screen');
      assert.deepEqual(wide.screen.slice(readRow, readRow + lines(reads[2]).length), lines(reads[2]), 'every read continuation is real screen content');
      const afterRead = readRow + lines(reads[2]).length;
      assert.equal(wide.screen[afterRead], '', 'one screen gap before following no-args call');
      assert.match(wide.screen[afterRead + 1], /⚙ tv_noargs$/u);
      assert.match(wide.screen[afterRead + 2], /⚙ tv_noargs$/u, 'single with leading gap is not counted as multiline');
      assert.match(wide.screen[afterRead + 3], /⚙ tv_summary/u, 'multiline after single stays adjacent');
      const summary = byName(wide, 'tv_summary')[0];
      const summaryRow = wide.screen.findIndex((row) => row === lines(summary)[0]);
      assert.ok(summaryRow >= 0);
      assert.deepEqual(wide.screen.slice(summaryRow, summaryRow + lines(summary).length), lines(summary), 'all bounded preview rows appear on the actual wide screen');
      const styleReference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
      try {
        await new Promise((done) => styleReference.write(wide.summaryStyles.dim, done));
        const expectedStyle = styleReference.buffer.active.getLine(0).getCell(0);
        for (let y = summaryRow; y < summaryRow + lines(summary).length; y++) {
          const x = wide.screen[y].search(/\S/u);
          const cell = wide.cells[y][x];
          assert.equal(cell.bgMode, 0, 'continuations have no native-card background');
          if (y > summaryRow) assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
            { fg: expectedStyle.getFgColor(), fgMode: expectedStyle.getFgColorMode(), dim: expectedStyle.isDim() },
            'wrapped parameter rows retain theme dim foreground');
        }
      } finally { styleReference.dispose(); }
      // Real fullscreen SGR on the extension-added gap must not expand either neighbor.
      live.send(`\x1b[<0;4;${afterRead + 1}M\x1b[<0;4;${afterRead + 1}m`);
      await live.settle(); const gap = await live.capture('gap-click');
      assert.ok(gap.tools.every((tool) => !tool.expanded), 'gap ignores primary clicks');
      // Click the last content row (not just the title) of the long built-in read.
      const continuation = gap.screen.findIndex((row) => row === lines(reads[2]).at(-1));
      assert.ok(continuation >= 0);
      live.send(`\x1b[<0;4;${continuation + 1}M\x1b[<0;4;${continuation + 1}m`);
      await live.settle(); const clicked = await live.capture('continuation-click');
      assert.deepEqual(clicked.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [reads[2].id], 'continuation expands precisely the completed built-in read');
      assert.ok(clicked.screen.some((row) => row.includes('LONG_READ_CONTENT')));
      // Collapse via the native title after the expanded long filename wraps.
      const pathRow = clicked.screen.findIndex((row) => row.includes('long-directory/'));
      assert.ok(pathRow > 0);
      const title = pathRow - 1; // Native read wraps a long filename below its title.
      assert.match(clicked.screen[title], /\bread\b/u);
      const titleColumn = clicked.screen[title].indexOf('read') + 1;
      assert.ok(titleColumn > 0);
      live.send(`\x1b[<0;${titleColumn};${title + 1}M\x1b[<0;${titleColumn};${title + 1}m`);
      await live.settle(); multilineLayout(await live.capture('native-collapsed'));
      // The next no-args call owns a leading separator; expand then native-collapse it.
      const withGap = await live.capture('with-gap');
      const emptyRow = withGap.screen.findIndex((row, index) => index > readRow && row.includes('⚙ tv_noargs'));
      assert.ok(emptyRow >= 0, 'separator-owner compact call is on screen');
      live.send(`\x1b[<0;4;${emptyRow + 1}M\x1b[<0;4;${emptyRow + 1}m`);
      await live.settle(); const emptyExpanded = await live.capture('separator-owner-expanded');
      assert.equal(byName(emptyExpanded, 'tv_noargs')[0].expanded, true);
      const emptyTitle = emptyExpanded.screen.findIndex((row) => row.includes('tv_noargs'));
      assert.ok(emptyTitle >= 0);
      const emptyColumn = emptyExpanded.screen[emptyTitle].indexOf('tv_noargs') + 1;
      live.send(`\x1b[<0;${emptyColumn};${emptyTitle + 1}M\x1b[<0;${emptyColumn};${emptyTitle + 1}m`);
      await live.settle(); multilineLayout(await live.capture('separator-owner-collapsed'));
      await live.resize(24, 120); const narrow = await live.capture('narrow');
      multilineLayout(narrow, wide);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      const compactTools = narrow.tools.filter((tool) => ['read', 'tv_summary', 'tv_noargs'].includes(tool.name));
      await t.test('live component render at width zero has no rows', () => {
        for (const tool of compactTools) assert.deepEqual(tool.tinyLines['0'], [], `width zero has no rows: ${tool.id}`);
      });
      await t.test('live component render at widths 1–5 preserves a tool glyph without completion badges', async () => {
        for (const tool of compactTools) {
          for (const width of [1, 2, 3, 4, 5]) {
            assert.deepEqual(tool.tinyLines[width].map(plain).filter((row) => row.trim()), [(width >= 3 ? ' ' : '') + (tool.name === 'read' ? '→' : ['edit', 'write'].includes(tool.name) ? '←' : '⚙')], `width ${width} retains the tool glyph with the margins that fit`);
            await assertFits(tool.tinyLines[width], Math.max(1, width - 1));
          }
        }
      });
      await live.resize(100, 120); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'wide→narrow→wide recalculates content and gaps without drift');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      simpleBashCards(expanded, 'MULTILINE_NATIVE_BASH');
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: nativeExpanded.tools.filter((tool) => tool.name !== 'bash') }), 'Ctrl+O returns exact native cards/results except custom bash');
      assert.deepEqual(persisted(expanded), persisted(wide));
      live.send('\x0f'); await live.settle(); multilineLayout(await live.capture('recollapsed'));
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.deepEqual(persisted(off), persisted(wide));
      await live.command('/toolview on'); multilineLayout(await live.capture('enabled'));
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); multilineLayout(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = events(live);
      assert.deepEqual(activity, events(stock), 'UI transitions do not re-execute or rewrite model context');
      const session = reloaded.session; await live.close();
      const replay = await start('multiline-replay', { toolview: true, flags, session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); multilineLayout(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(wide));
      const nativeReplay = await start('multiline-native-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('replayed');
      await replay.command('/toolview off'); const replayOff = await replay.capture('disabled');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session off restores native rendering exactly');
      const regular = await start('multiline-regular', { toolview: true, flags, mode: 'regular' });
      await regular.run('multiline'); const regularWide = await regular.capture('wide'); multilineLayout(regularWide);
      await regular.resize(24, 120); const regularNarrow = await regular.capture('narrow');
      multilineLayout(regularNarrow, regularWide);
      for (const tool of regularNarrow.tools) await assertFits(tool.lines, 24);
      await regular.resize(100, 120); const regularBack = await regular.capture('wide-again');
      assert.deepEqual(regularBack.tools.map((tool) => tool.lines), regularWide.tools.map((tool) => tool.lines));
      regular.send('\x0f'); await regular.settle(); assert.ok((await regular.capture('expanded')).tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'multiline-coverage.json'), JSON.stringify({
        calls: 19, results: 19, modelContexts: 20, widths: [0, 1, 2, 3, 4, 5, 24, 100],
        executed: [...new Set(activity.filter((event) => event.type === 'call').map((event) => event.name))],
        input: ['fullscreen SGR separator ignored', 'fullscreen SGR last continuation expands exact read', 'native mouse collapse', 'separator-owner native coordinate forwarding', 'Ctrl+O fullscreen/regular'],
        lifecycle: ['wide→narrow→wide fullscreen/regular', 'off/on', 'reload', 'same-session stock replay'],
        installedTools: 'Separate installed-profile smoke only; no installed tool execution added by multiline fixture',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: comma wrap points preserve array members and index lists in live and replay output',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(110, 80); return terminal;
    };
    const activity = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 3);
      assert.equal(observed.filter((event) => event.type === 'result').length, 3);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 4);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    const check = async (dump, width, wholeMembers) => {
      assert.equal(dump.tools.length, 3);
      const args = persisted(dump).filter((entry) => entry.arguments).map((entry) => entry.arguments);
      for (const [index, tool] of dump.tools.entries()) {
        const rows = compactContent(tool);
        const key = ['scope', 'target', 'drop'][index];
        const expected = `tv_summary [${key}=${JSON.stringify(args[index][key])}]`;
        assert.equal(summaryText(tool), summaryExpected(expected));
        await assertFits(tool.lines, width - 1);
        // Narrow summaries share the same title row; locate the complete call, not its first matching title.
        const y = dump.screen.findIndex((row, index) => row === rows[0] &&
          rows.every((expected, offset) => dump.screen[index + offset] === expected));
        assert.ok(y >= 0, 'complete compact call is present on the real terminal screen');
        assert.deepEqual(dump.screen.slice(y, y + rows.length), rows);
        for (let offset = 0; offset < rows.length; offset++) {
          const x = width - 1;
          assert.ok(['', ' '].includes(dump.cells[y + offset][x].text), 'the rightmost screen cell remains blank');
          assert.equal(dump.cells[y + offset][x].bgMode, 0, 'the reserved column keeps the terminal-default background');
        }
        if (!wholeMembers) continue;
        assert.match(rows[0], /^ ⚙ tv_summary \[/, 'parameters start on the first row');
        if (Array.isArray(args[index][key])) {
          assert.equal(rows.length, 3);
          for (const member of args[index][key]) {
            assert.equal(rows.filter((row) => row.includes(JSON.stringify(member))).length, 1,
              'each fitting array member remains whole on one row');
          }
        } else {
          assert.match(rows[0], /\[drop="1,2,3,/);
          assert.ok(rows.length >= 2);
          assert.ok(rows.slice(0, -1).every((row) => row.endsWith(',')), 'index list breaks after a comma');
        }
      }
    };
    try {
      const stock = await start('comma-wrap-stock');
      await stock.run('comma-wrap'); const native = await stock.capture('native');
      const live = await start('comma-wrap-toolview', { toolview: true, workspace: stock.work });
      await live.run('comma-wrap'); const wide = await live.capture('wide');
      await check(wide, 110, true);
      assert.deepEqual(activity(live), activity(stock), '3 calls/results and 4 model contexts are identical');
      assert.deepEqual(persisted(wide), persisted(native), 'raw arguments and complete results remain identical');
      const sessionBytes = readFileSync(wide.session);
      await live.resize(36, 80); const narrow = await live.capture('narrow');
      await check(narrow, 36, false);
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.resize(110, 80); const back = await live.capture('wide-again');
      assert.deepEqual(toolLines(back), toolLines(wide));
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'), 110, true);
      await live.command('/toolview off'); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      await live.command('/toolview on'); await check(await live.capture('on'), 110, true);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded, 110, true);
      assert.deepEqual(activity(live), activity(stock), 'UI-only changes do not execute tools or modify model context');
      assert.deepEqual(readFileSync(wide.session), sessionBytes, 'UI-only changes do not rewrite the session');
      await live.close();
      const replay = await start('comma-wrap-replay', { toolview: true, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed, 110, true);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      writeFileSync(join(artifacts, 'comma-wrap-coverage.json'), JSON.stringify({
        calls: 3, results: 3, modelContexts: 4, widths: [36, 110], rightMargin: 1,
        tools: 'Executed generic tv_summary fixture with user-provided array shapes and 60 comma-separated indices; no installed AFT/Magic Context execution',
        lifecycle: ['live native control', 'resize round trip', 'Ctrl+O native equality', 'off/on', 'reload', 'same-session replay'],
        identity: 'Exact calls/results/model contexts, persisted arguments/results, and unchanged session bytes',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: long-word summaries fill preceding space and prefer bounded punctuation cuts',
  { skip: stockOnly, timeout: 240000 }, async (t) => {
    for (const mode of ['fullscreen', 'regular']) await t.test(mode, async () => {
      const terminals = [];
      const start = async (name, options = {}) => {
        const terminal = new PiTerminal(`long-word-${mode}-${name}`, { mode, ...options }); terminals.push(terminal);
        await terminal.ready(); await terminal.resize(100, 80); return terminal;
      };
      const activity = terminal => {
        const events = terminal.events();
        assert.equal(events.filter(event => event.type === 'call').length, 4);
        assert.equal(events.filter(event => event.type === 'result').length, 4);
        assert.equal(events.filter(event => event.type === 'model_context').length, 5);
        return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
      };
      const check = async (dump, width) => {
        assert.equal(dump.tools.length, 4);
        const args = persisted(dump).filter(entry => entry.arguments).map(entry => entry.arguments);
        const expected = [
          `read ${args[0].path}`,
          `read ${args[1].path} [offset=1, limit=1]`,
          `tv_summary ${args[2].url} [fixtureError=true]`,
          `tv_summary ${args[3].target} [query=${JSON.stringify(args[3].query)}, offset=1, limit=1]`,
        ];
        let checkedRows = 0;
        for (const [index, tool] of dump.tools.entries()) {
          const rows = compactContent(tool);
          assert.equal(summaryText(tool), summaryExpected(expected[index]), 'all source characters survive wrapping');
          await assertFits(tool.lines, width - 1);
          if (index < 2) assert.ok(rows[0].startsWith(' → read long-directory/'), 'oversized path starts after the tool name with and without commas');
          if (index === 2) assert.ok(rows[0].endsWith({ 24: '/', 36: '.', 100: '_' }[width]), 'the nearest eligible URL separator determines the physical first-row cut');
          const y = dump.screen.findIndex((row, at) => row === rows[0] && rows.every((value, offset) => dump.screen[at + offset] === value));
          assert.ok(y >= 0, `complete tool ${index} is present on the physical ${mode} screen`);
          for (let offset = 0; offset < rows.length; offset++) {
            assert.ok(['', ' '].includes(dump.cells[y + offset][width - 1].text));
            assert.equal(dump.cells[y + offset][width - 1].bgMode, 0);
            if (offset) assert.equal(rows[offset].slice(0, 3), '   ');
            checkedRows++;
          }
        }
        await errorSummaryColors(dump, dump.tools[2]);
        return checkedRows;
      };
      try {
        const stock = await start('stock'); await stock.run('long-word-wrap'); const native = await stock.capture('native');
        const live = await start('toolview', { toolview: true, workspace: stock.work });
        await live.run('long-word-wrap'); const wide = await live.capture('wide');
        let checkedRows = await check(wide, 100);
        assert.deepEqual(activity(live), activity(stock)); assert.deepEqual(persisted(wide), persisted(native));
        const sessionBytes = readFileSync(wide.session);
        for (const width of [36, 24]) {
          await live.resize(width, 80); const dump = await live.capture(`width-${width}`);
          checkedRows += await check(dump, width); assert.deepEqual(persisted(dump), persisted(wide));
        }
        await live.resize(100, 80); const back = await live.capture('wide-again');
        assert.deepEqual(toolLines(back), toolLines(wide));
        await live.command('/tv-theme light'); const light = await live.capture('light'); checkedRows += await check(light, 100);
        await live.command('/tv-theme dark');
        stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
        live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
        assert.ok(expanded.tools.every(tool => tool.expanded)); assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
        live.send('\x0f'); await live.settle(); await check(await live.capture('collapsed'), 100);
        await live.command('/toolview off'); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
        await live.command('/toolview on'); await check(await live.capture('on'), 100);
        const starts = live.events().filter(event => event.type === 'start').length;
        await live.command('/reload'); await live.event('start', starts + 1);
        const reloaded = await live.capture('reloaded'); await check(reloaded, 100);
        assert.deepEqual(activity(live), activity(stock)); assert.deepEqual(readFileSync(wide.session), sessionBytes);
        await live.close();
        const replay = await start('replay', { toolview: true, session: wide.session, workspace: stock.work });
        const resumed = await replay.capture('resumed'); await check(resumed, 100);
        assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(wide));
        assert.deepEqual(readFileSync(wide.session), sessionBytes);
        assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
        writeFileSync(join(artifacts, `long-word-${mode}-coverage.json`), JSON.stringify({
          mode, calls: 4, results: 4, modelContexts: 5, widths: [24, 36, 100], checkedRows,
          colors: ['dark', 'light', 'all error rows'], controls: ['native', 'expansion', 'off/on', 'reload', 'zero-execution replay'],
          scope: 'Built-in read in the owned workspace and explicit generic URL/quoted Unicode fixtures; no installed package execution',
        }, null, 2));
      } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
    });
  });

test('real CLI: failed summaries are wholly error-colored, hide bodies and final badges, and expose native errors on click',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(80, 120); return terminal;
    };
    const activity = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 4);
      assert.equal(observed.filter((event) => event.type === 'result').length, 4);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 5);
      assert.deepEqual(observed.filter((event) => event.type === 'result').map((event) => event.isError), [true, true, true, false]);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    let checkedErrorCells = 0;
    const check = async (dump, width) => {
      assert.equal(dump.tools.length, 4);
      const args = persisted(dump).filter((entry) => entry.arguments).map((entry) => entry.arguments);
      const expected = [
        `read ${args[0].path} [offset=3, limit=7]`,
        `tv_summary "needle" in ${args[1].path} [query=${JSON.stringify(args[1].query)}, fixtureError=true]`,
        `tv_summary [query="named", target=${JSON.stringify(args[2].target)}, fixtureError=true]`,
        'tv_summary [query="SUCCESS_CALL"]',
      ];
      assert.deepEqual(dump.tools.map((tool) => tool.isError === true), [true, true, true, false]);
      for (const [index, tool] of dump.tools.entries()) {
        compactContent(tool);
        assert.equal(summaryText(tool), summaryExpected(expected[index]), 'collapsed call contains its full arguments and no result preview');
        assert.doesNotMatch(tool.lines.map(plain).join(''), /ERROR_BODY_SENTINEL|ERROR_STACK_SENTINEL|ENOENT|✓|✗/u);
        await assertFits(tool.lines, width - 1);
        if (index < 3) checkedErrorCells += await errorSummaryColors(dump, tool);
      }
      assert.ok(!dump.screen.some((row) => /ERROR_BODY_SENTINEL|ERROR_STACK_SENTINEL|ENOENT/u.test(row)), 'raw error bodies are absent from the real collapsed screen');
    };
    try {
      const stock = await start('compact-errors-stock');
      await stock.run('compact-errors'); const native = await stock.capture('native');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const live = await start('compact-errors-toolview', { toolview: true, workspace: stock.work });
      await live.run('compact-errors'); const wide = await live.capture('wide'); await check(wide, 80);
      assert.deepEqual(activity(live), activity(stock), '4 calls/results and 5 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(native), 'all raw error messages and supplied arguments remain native session data');
      assert.match(byName(wide, 'tv_summary')[0].content[0].text, /ERROR_BODY_SENTINEL.*\nERROR_STACK_SENTINEL/u);
      const sessionBytes = readFileSync(wide.session);
      await live.resize(21, 120); const narrow = await live.capture('narrow'); await check(narrow, 21);
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.resize(80, 120); const back = await live.capture('wide-again');
      assert.deepEqual(toolLines(back), toolLines(wide));
      await live.command('/tv-theme light'); await check(await live.capture('light'), 80);
      await live.command('/tv-theme dark'); const dark = await live.capture('dark'); await check(dark, 80);
      const target = dark.tools[1], rows = lines(target);
      const y = dark.screen.findIndex((row, index) => row === rows[0] && rows.every((expected, offset) => dark.screen[index + offset] === expected));
      assert.ok(y >= 0);
      const last = y + rows.length - 1;
      live.send(`\x1b[<0;4;${last + 1}M\x1b[<0;4;${last + 1}m`);
      await live.settle(); const clicked = await live.capture('failed-continuation-click');
      assert.deepEqual(clicked.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [target.id]);
      assert.deepEqual(clicked.tools[1].lines, nativeExpanded.tools[1].lines, 'failed continuation click delegates exactly to native full information');
      assert.ok(clicked.screen.some((row) => row.includes('ERROR_BODY_SENTINEL')));
      assert.ok(clicked.screen.some((row) => row.includes('ERROR_STACK_SENTINEL')), 'full available second error line is visible after expansion');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'), 80);
      await live.command('/toolview off'); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      await live.command('/toolview on'); await check(await live.capture('on'), 80);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded, 80);
      assert.deepEqual(activity(live), activity(stock), 'presentation/lifecycle changes do not modify execution or model context');
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      await live.close();
      const replay = await start('compact-errors-replay', { toolview: true, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed, 80);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      writeFileSync(join(artifacts, 'compact-errors-coverage.json'), JSON.stringify({
        calls: 4, results: 4, modelContexts: 5, failedCalls: 3, checkedErrorCells, widths: [21, 80],
        tools: 'Real built-in failing read plus two generic throwing summaries and one generic success; no installed third-party execution',
        lifecycle: ['real failed-continuation SGR click', 'exact native expansion', 'dark/light', 'resize round trip', 'off/on', 'reload', 'same-session replay'],
        identity: 'Exact raw arguments/results/model contexts and unchanged session bytes',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: width-21 colored-segment boundary preserves content and exact indentation',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((event) => event.type === 'call').length, 2);
      assert.equal(events.filter((event) => event.type === 'result').length, 2);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 3);
      assert.ok(events.filter((event) => event.type === 'result').every((event) => !event.isError));
      return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    try {
      const stock = await start('boundary-stock');
      await stock.run('boundary'); const control = await stock.capture('wide');
      const live = await start('boundary-toolview', { toolview: true, workspace: stock.work });
      await live.run('boundary'); const wide = await live.capture('wide');
      assert.deepEqual(activity(live), activity(stock), 'boundary execution/model context remain exact');
      assert.deepEqual(persisted(wide), persisted(control));
      await stock.resize(21); const native = await stock.capture('boundary');
      await live.resize(21); const narrow = await live.capture('boundary');
      assert.equal(narrow.width, 21, 'real PTY boundary viewport');
      assert.equal(narrow.tools.length, 2);
      const expected = ['read abcdefghijklm [limit=1]', `tv_summary abcdefghijklm [query="${'x'.repeat(40)}"]`];
      for (const [index, tool] of narrow.tools.entries()) {
        const rows = compactContent(tool);
        const allContentRows = tool.lines.map(plain).slice(leadingBlanks(tool));
        assert.ok(allContentRows.every((row) => row.trim()), 'no blank content row from colored inter-segment spaces');
        assert.deepEqual(allContentRows, rows, 'only an optional leading separator may be empty');
        assert.ok(rows.length > 1, 'both boundary calls wrap');
        assert.equal(summaryText(tool), summaryExpected(expected[index]), 'all content, quotes and status survive segment boundary');
        assert.equal(summaryText(tool), summaryText(wide.tools[index]), 'wide and boundary logical content are identical');
        await assertFits(tool.lines, 20);
        const y = narrow.screen.findIndex((row) => row === rows[0]);
        assert.ok(y >= 0, 'boundary compact call appears on actual ANSI-parsed screen');
        assert.deepEqual(narrow.screen.slice(y, y + rows.length), rows, 'every boundary content row appears on actual screen without extra blank rows');
        for (const row of narrow.screen.slice(y + 1, y + rows.length)) assert.match(row, /^ {3}\S/u, 'parsed continuation has exactly three spaces, never four');
        for (let offset = 0; offset < rows.length; offset++) {
          const x = rows[offset].search(/\S/u);
          assert.equal(narrow.cells[y + offset][x].bgMode, 0, 'boundary summary retains default background');
          assert.ok(['', ' '].includes(narrow.cells[y + offset][20].text), 'the rightmost column is blank on the actual boundary screen');
        }
      }
      assert.deepEqual(lines(narrow.tools[0]), [' → read', '   abcdefghijklm', '   [limit=1]'], 'right margin is reserved before wrapping; continuation starts at column three');
      await live.resize(22); const boundaryWithMargin = await live.capture('boundary-with-margin');
      assert.deepEqual(lines(boundaryWithMargin.tools[0]), [' → read abcdefghijklm', '   [limit=1]'], 'original colored segment boundary still works with one right column reserved');
      for (const tool of boundaryWithMargin.tools) await assertFits(tool.lines, 21);
      await live.resize(21); assert.deepEqual(toolLines(await live.capture('boundary-again')), toolLines(narrow));
      assert.equal(leadingBlanks(narrow.tools[1]), 1, 'following multiline call receives exactly one separator');
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(off.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'boundary disable restores exact stock native renderer');
      await live.command('/toolview on'); const enabled = await live.capture('enabled');
      assert.deepEqual(enabled.tools.map((tool) => tool.lines), narrow.tools.map((tool) => tool.lines));
      await live.resize(100); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'boundary resize restores exact wide rendering');
      assert.deepEqual(activity(live), activity(stock), 'boundary UI changes do not execute tools again');
      writeFileSync(join(artifacts, 'boundary-coverage.json'), JSON.stringify({
        calls: 2, results: 2, modelContexts: 3, widths: [100, 21, 22, 21, 100], rightMargin: 1,
        arguments: [{ name: 'read', path: 'abcdefghijklm', limit: 1 }, { name: 'tv_summary', path: 'abcdefghijklm', query: 'x'.repeat(40) }],
        checked: ['actual ANSI-parsed content rows', 'exactly three-space continuation', 'no blank content rows', 'one blank rightmost screen cell', 'original colored-boundary geometry at width22', 'complete argument text', 'row widths', 'native off control', 'resize back'],
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

for (const mode of ['regular', 'fullscreen']) test(`real CLI: spinner shares Working frames and falls back only during host silence (${mode})`,
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(`${name}-${mode}`, { ...options, mode, extraEnv: { TOOLVIEW_TEST_SPINNER_DIAGNOSTICS: '1' } });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    const busyCapture = (terminal, name) => terminal.capture(name, { animated: true });
    const normalTraffic = (terminal) => terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    const runningRow = terminal => terminal.screen().find(row => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tv_stream \[query="gated"\]$/u.test(row));
    const physicalFrames = async terminal => {
      const distinct = new Set();
      for (let i = 0; i < 5; i++) {
        await terminal.settle(true); const row = runningRow(terminal);
        assert.ok(row, 'a real PTY frame, without any diagnostic render, contains the running glyph');
        distinct.add(row[1]);
      }
      assert.ok(distinct.size >= 2, 'physical first cell really animates'); return [...distinct];
    };
    const assertBusy = async (dump) => {
      const tool = byName(dump, 'tv_stream')[0];
      assert.equal(tool.executionStarted, true); assert.equal(tool.partial, true);
      const rows = lines(tool);
      assert.equal(rows.length, 1);
      assert.match(rows[0], /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tv_stream \[query="gated"\]$/u);
      const y = dump.screen.findIndex((row) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tv_stream \[query="gated"\]$/u.test(row));
      assert.ok(y >= 0, 'actual physical screen has the running glyph; only animation phase may differ from the tree snapshot');
      assert.equal(dump.cells[y][1].width, 1); assert.equal(dump.cells[y][3].text, 't');
      const expected = await referenceCell(dump.summaryStyles.dim);
      assert.deepEqual({ fg: dump.cells[y][1].fg, fgMode: dump.cells[y][1].fgMode, dim: dump.cells[y][1].dim },
        { fg: expected.fg, fgMode: expected.fgMode, dim: expected.dim });
      assert.ok(['', ' '].includes(dump.cells[y][dump.width - 1].text));
      assert.ok(!dump.screen.some((row) => row.includes('STREAM_PARTIAL')));
      const stats = dump.spinnerStats;
      assert.equal(stats.maxActive, 1); assert.ok(stats.active <= 1, 'one deadline, or a pending host request');
      assert.equal(stats.starts - stats.cancels - stats.ticks, stats.active, 'all allocated deadlines are cancelled, fired or still pending');
      assert.equal(stats.unrefs, stats.starts, 'every shared deadline is unreferenced');
      assert.ok(stats.delays.every(delay => delay === 100));
      return dump.cells[y][1].text;
    };
    try {
      const stock = await start('spinner-stock');
      stock.send('run pending\r'); await stock.event('provider_gate');
      writeFileSync(join(stock.output, 'provider-go'), 'go'); await stock.event('tool_gate');
      const nativePartial = await busyCapture(stock, 'partial');
      writeFileSync(join(stock.output, 'tool-go'), 'go'); await stock.event('agent_end');
      const native = await stock.capture('complete');
      assert.equal(native.spinnerStats.starts, 0, 'observer ignores native Pi animation timers');
      const live = await start('spinner-toolview', { toolview: true, workspace: stock.work });
      const idle = await live.capture('idle'); assert.equal(idle.spinnerStats.starts, 0);
      live.send('run pending\r'); await live.event('provider_gate');
      const argumentsOnly = await busyCapture(live, 'arguments');
      assert.equal(argumentsOnly.spinnerStats.starts, 0); assert.equal(argumentsOnly.spinnerStats.ticks, 0);
      assert.equal(lines(argumentsOnly.tools[0])[0], ' → read a.txt');
      writeFileSync(join(live.output, 'provider-go'), 'go'); await live.event('tool_gate');
      live.send('/toolview cache\r'); await live.settle(true);
      const warm = await busyCapture(live, 'working-warm'); await assertBusy(warm);
      const builds = warm.cacheDiagnostics.at(-1).builds, bytesRunning = readFileSync(warm.session);
      const hostFrames = await physicalFrames(live);
      live.send('/toolview cache\r'); await live.settle(true);
      const hot = await busyCapture(live, 'working-hot'); await assertBusy(hot);
      assert.equal(hot.spinnerStats.ticks, 0, 'regular native Working frames never let fallback fire');
      assert.equal(hot.spinnerStats.requests, 0, 'Toolview adds zero UI requests while native Working supplies frames');
      assert.ok(hot.spinnerStats.starts > warm.spinnerStats.starts, 'real host document visits rearm the one-shot deadline');
      assert.equal(hot.cacheDiagnostics.at(-1).builds, builds, 'host-driven animation builds no custom body');
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      // A one-frame public Working configuration stops only Pi's native animation.
      // The still-running real tool must continue moving via Toolview's fallback.
      live.send('/tv-spinner-working static\r'); await live.event('spinner_working');
      await live.event('spinner_tick_checkpoint');
      live.send('/toolview cache\r'); await live.settle(true);
      const fallbackWarm = await busyCapture(live, 'fallback-warm'); await assertBusy(fallbackWarm);
      const fallbackFrames = await physicalFrames(live);
      await live.event('spinner_tick_checkpoint', 2);
      live.send('/toolview cache\r'); await live.settle(true);
      const fallbackHot = await busyCapture(live, 'fallback-hot'); await assertBusy(fallbackHot);
      assert.ok(fallbackHot.spinnerStats.ticks > fallbackWarm.spinnerStats.ticks);
      assert.equal(fallbackHot.spinnerStats.requests - fallbackWarm.spinnerStats.requests,
        fallbackHot.spinnerStats.ticks - fallbackWarm.spinnerStats.ticks, 'each eligible fallback wake requests exactly one frame');
      assert.equal(fallbackHot.cacheDiagnostics.at(-1).builds, builds, 'fallback-driven animation builds no custom body');
      assert.ok(Object.keys(fallbackHot.spinnerWork.widths).every(key => key.endsWith(':100')), 'clock diagnostics never render alternate widths');
      assert.equal(fallbackHot.spinnerWork.invalidations, hot.spinnerWork.invalidations, 'fallback requests no native tool invalidation');
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      live.send('/tv-spinner-working animated\r'); await live.event('spinner_working', 2); await live.settle(true);
      const sharedAgain = await busyCapture(live, 'working-restored'); await assertBusy(sharedAgain);
      await physicalFrames(live);
      const sharedHot = await busyCapture(live, 'working-restored-hot'); await assertBusy(sharedHot);
      assert.equal(sharedHot.spinnerStats.ticks, sharedAgain.spinnerStats.ticks, 'restoring Working suppresses fallback again');
      assert.equal(sharedHot.spinnerStats.requests, sharedAgain.spinnerStats.requests);
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      live.send('/toolview off\r'); await live.settle(true);
      const off = await busyCapture(live, 'off'); assert.equal(off.spinnerStats.active, 0);
      assert.equal(off.spinnerStats.starts - off.spinnerStats.cancels - off.spinnerStats.ticks, 0);
      assert.deepEqual(toolLines(off), toolLines(nativePartial), 'off delegates actual partial information exactly to native');
      const offAgain = await busyCapture(live, 'off-again'); assert.deepEqual(offAgain.spinnerStats, off.spinnerStats, 'zero Toolview ticks/redraws while off despite active native animation');
      live.send('/toolview on\r'); await live.settle(true);
      const on = await busyCapture(live, 'on'); await assertBusy(on); assert.ok(on.spinnerStats.starts > off.spinnerStats.starts);
      writeFileSync(join(live.output, 'tool-go'), 'go'); await live.event('agent_end');
      const complete = await live.capture('complete'); assert.equal(complete.spinnerStats.active, 0);
      assert.equal(complete.spinnerStats.starts - complete.spinnerStats.cancels - complete.spinnerStats.ticks, 0);
      assert.equal(lines(byName(complete, 'tv_stream')[0])[0], ' ⚙ tv_stream [query="gated"]');
      const idleAgain = await live.capture('idle-again'); assert.deepEqual(idleAgain.spinnerStats, complete.spinnerStats, 'zero ticks and zero spinner render requests after completion');
      const traffic = normalTraffic(live); assert.deepEqual(traffic, normalTraffic(stock));
      assert.equal(traffic.filter(event => event.type === 'call').length, 2);
      assert.equal(traffic.filter(event => event.type === 'result').length, 2);
      assert.equal(traffic.filter(event => event.type === 'model_context').length, 3);
      assert.deepEqual(persisted(complete), persisted(native));
      const bytes = readFileSync(complete.session), starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); assert.equal(reloaded.spinnerStats.starts, 0);
      assert.ok(complete.tools[1].before.some(entry => entry.kind === 'ThemedText' && entry.lines.some(row => row.includes('Pi Toolview: on'))),
        'live on-command notification is a visible native sibling, not persisted session data');
      assert.equal(complete.tools[1].lines[0], '', 'visible notification requires one native-text separator');
      assert.ok(reloaded.tools[1].before.some(entry => entry.name === 'read'));
      assert.deepEqual(reloaded.tools[0].lines, complete.tools[0].lines);
      assert.deepEqual(reloaded.tools[1].lines, complete.tools[1].lines.slice(1), 'reload removes only the separator for the vanished on-notification; call bytes stay exact');
      assert.deepEqual(readFileSync(complete.session), bytes);
      const replay = await start('spinner-replay', { toolview: true, session: complete.session, workspace: stock.work });
      const resumed = await replay.capture('replay'); assert.equal(resumed.spinnerStats.starts, 0); assert.equal(resumed.spinnerStats.ticks, 0);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(native));
      assert.deepEqual(readFileSync(complete.session), bytes);
      for (const terminal of [stock, live]) {
        rmSync(join(terminal.output, 'provider-go')); rmSync(join(terminal.output, 'tool-go'));
        terminal.send('run pending-abort\r'); await terminal.event('provider_gate', 2);
        writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate', 2);
        await terminal.settle(true);
        terminal.send('\x1b'); await terminal.event('agent_end', 2);
      }
      const aborted = await live.capture('aborted'), abortedNative = await stock.capture('aborted');
      assert.equal(aborted.spinnerStats.active, 0);
      assert.equal(byName(aborted, 'tv_stream').at(-1).isError, true);
      assert.deepEqual(normalTraffic(live), normalTraffic(stock), 'cancellation also preserves exact real tool/model traffic');
      assert.deepEqual(persisted(aborted), persisted(abortedNative));
      const afterAbort = await live.capture('after-abort'); assert.deepEqual(afterAbort.spinnerStats, aborted.spinnerStats);
      writeFileSync(join(artifacts, `spinner-coverage-${mode}.json`), JSON.stringify({
        mode, normalCalls: 2, normalResults: 2, normalModelContexts: 3, buildsBefore: builds, buildsAfter: fallbackHot.cacheDiagnostics.at(-1).builds,
        sharedClock: hot.spinnerStats, fallbackClock: fallbackHot.spinnerStats, sharedAgain: sharedHot.spinnerStats,
        stoppedClock: complete.spinnerStats, abortedClock: aborted.spinnerStats,
        hostPhysicalFrames: hostFrames, fallbackPhysicalFrames: fallbackFrames, idleRequestsAdded: 0, idleTicksAdded: 0,
        controls: ['native partial/complete', 'pre-execution zero clocks', 'Working reuse with zero extra requests', 'static Working fallback',
          'restored Working suppression', 'hot cached animation', 'off/on while running', 'completion idle', 'reload', 'same-session replay', 'native cancellation traffic'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: gated pending/streaming, image/hidden fallback and exact-name flags',
  { skip: stockOnly, timeout: 120000 }, async (t) => {
    assert.ok(existsSync(extension), 'src/index.ts is required for the implementation gate');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    try {
      const live = await start('pending', { toolview: true });
      live.send('run pending\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending', { animated: true });
      assert.equal(lines(byName(pending, 'read')[0]).length, 1);
      assert.equal(lines(byName(pending, 'read')[0])[0], ' → read a.txt');
      assert.equal(byName(pending, 'read')[0].executionStarted, false);
      assert.ok(pending.screen.some((line) => line === ' → read a.txt'), 'argument streaming retains the static glyph and has no trailing ellipsis');
      writeFileSync(join(live.output, 'provider-go'), 'go'); await live.event('tool_gate');
      const streaming = await live.capture('tool-pending', { animated: true });
      assert.equal(lines(byName(streaming, 'tv_stream')[0]).length, 1);
      assert.match(lines(byName(streaming, 'tv_stream')[0])[0], /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tv_stream \[query="gated"\]$/u);
      assert.equal(byName(streaming, 'tv_stream')[0].executionStarted, true);
      assert.ok(streaming.screen.some((line) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tv_stream \[query="gated"\]$/u.test(line)), 'actual screen shows a spinner in column one and no trailing marker');
      assert.ok(!streaming.screen.some((line) => line.includes('STREAM_PARTIAL')));
      writeFileSync(join(live.output, 'tool-go'), 'go'); await live.event('agent_end');
      const complete = await live.capture('complete');
      assert.equal(lines(byName(complete, 'tv_stream')[0])[0], ' ⚙ tv_stream [query="gated"]');
      await live.run('future');
      await live.run('fallback'); const fallback = await live.capture('fallback');
      assert.ok(byName(fallback, 'read').at(-1).content.some((c) => c.type === 'image'), 'real image read produced an image result');
      const native = await start('fallback-stock-replay', { session: fallback.session });
      const stock = await native.capture('fallback');
      await t.test('image fallback matches same-session stock replay', () => {
        assert.deepEqual(byName(fallback, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image rendering stays native');
        assert.ok(fallback.screen.some((line) => line.includes('pixel.png')));
      });
      await t.test('intentionally hidden renderer remains hidden live', () => {
        assert.deepEqual(byName(fallback, 'tv_hidden').map((tool) => tool.lines), byName(stock, 'tv_hidden').map((tool) => tool.lines));
        assert.equal(lines(byName(fallback, 'tv_hidden')[0]).length, 0);
        assert.ok(!fallback.screen.some((line) => line.includes('tv_hidden')));
      });
      const card = await start('flag-card', { toolview: true,
        flags: ['--toolview-card', 'tv_unknown,tv_stream'], session: fallback.session });
      const cards = await card.capture('cards');
      for (const name of ['tv_unknown', 'tv_stream'])
        assert.deepEqual(byName(cards, name)[0].lines, byName(stock, name)[0].lines, `comma-separated card flag: ${name}`);
      const override = await start('flag-override', { toolview: true,
        flags: ['--toolview-card', 'tv_stream,tv_hidden,read', '--toolview-compact', 'tv_stream,tv_hidden,read'], session: fallback.session });
      const overrides = await override.capture('override');
      assert.equal(lines(byName(overrides, 'tv_stream')[0]).length, 1, 'compact override wins');
      await t.test('hidden safeguard wins over flags on replay', () => {
        assert.equal(lines(byName(overrides, 'tv_hidden')[0]).length, 0, 'hidden safeguard wins over flags');
      });
      assert.deepEqual(byName(overrides, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image safeguard wins over flags');
      const exact = await start('flag-exact', { toolview: true,
        flags: ['--toolview-card', 'tv_strea,READ'], session: fallback.session });
      const exactDump = await exact.capture('exact');
      assert.equal(lines(byName(exactDump, 'tv_stream')[0]).length, 1, 'names are not prefixes');
      assert.equal(lines(byName(exactDump, 'read')[0]).length, 1, 'names are case-sensitive');
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });


test('real CLI: installed-profile registrations and real local task renderers',
  { skip: stockOnly, timeout: 120000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { profileFactory: getInstalledIntegrationProfile, ...options });
      terminals.push(terminal); await terminal.ready(); return terminal;
    };
    // Probe the audited installed sources without importing them or creating host configuration.
    let profile;
    try {
      profile = getInstalledIntegrationProfile({ homeDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`),
        agentDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`, 'agent'),
        workDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`, 'work') });
    } catch (error) {
      if (error.code === 'ENOENT') { t.skip(`Installed-profile source is absent: ${error.path}`); return; }
      throw error;
    }
    writeFileSync(join(artifacts, 'integration-profile-probe.json'), JSON.stringify(profile, null, 2));
    const includedNames = new Set(profile.inventory.filter((entry) => profile.packages.some((pkg) => pkg.source === entry.source))
      .map((entry) => entry.name));
    if (!includedNames.has('@tintinweb/pi-tasks')) {
      t.skip(`Audited configured pi-tasks is required for safe local execution. Exclusions: ${profile.exclusions.map((e) => `${e.name || e.source}: ${e.reason}`).join('; ')}`);
      return;
    }
    const registrationGroups = {
      '@tintinweb/pi-subagents': ['Agent'],
      '@tintinweb/pi-tasks': ['TaskCreate', 'TaskList', 'TaskExecute'],
      '@juicesharp/rpiv-ask-user-question': ['ask_user_question'],
      'pi-web-access': ['web_search', 'fetch_content'],
      '@cortexkit/pi-magic-context': ['ctx_memory', 'ctx_search', 'ctx_note', 'ctx_expand'],
    };
    const assertHealthy = (terminal, dump) => {
      for (const [pkg, names] of Object.entries(registrationGroups)) {
        if (!includedNames.has(pkg)) continue;
        for (const name of names) assert.ok(dump.registrations.includes(name), `installed registration: ${name}`);
      }
      assert.deepEqual(terminal.profile.packages, profile.packages, 'load exactly the current eligible audited configured packages');
      assert.deepEqual(terminal.profile.exclusions, profile.exclusions, 'retain the actual preflight exclusions');
      for (const name of ['@cortexkit/aft-pi', '@pedro_klein/pi-caffeinate'])
        assert.ok(!includedNames.has(name), `unsafe audited package remains excluded: ${name}`);
      const output = plain(Buffer.concat(terminal.raw).toString('utf8'));
      assert.doesNotMatch(output, /Extension "[^"\n]+" error:|Failed to load extension|Error loading extension/i,
        'no extension lifecycle errors (inspect stock-profile evidence separately on failure)');
      // Pi's resource diagnostic component colors load errors with the current error role.
      // [Extension issues] also contains harmless manifest warnings, so the heading alone is not a failure.
      const errorColor = dump.errorStyle.split('TERMINAL_ERROR')[0];
      assert.ok(errorColor, 'theme supplies an error style for native diagnostic inspection');
      assert.ok(dump.extensionIssues.flat().every((line) => !line.includes(errorColor)), 'native extension diagnostics contain no load errors');
      assert.equal(terminal.events().filter((e) => ['provider_error', 'unsafe_call_blocked'].includes(e.type)).length, 0);
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((e) => e.type === 'call').length, 2);
      assert.equal(events.filter((e) => e.type === 'result').length, 2);
      assert.equal(events.filter((e) => e.type === 'model_context').length, 3);
      assert.deepEqual(events.filter((e) => e.type === 'call').map((e) => e.name), ['TaskCreate', 'TaskList']);
      assert.ok(events.filter((e) => e.type === 'result').every((e) => !e.isError));
      return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
    };
    try {
      // Stock goes first so pre-existing package incompatibility cannot be blamed on Toolview.
      const stock = await start('installed-stock');
      const stockStartup = await stock.capture('startup'); assertHealthy(stock, stockStartup);
      await stock.run('integration'); const control = await stock.capture('collapsed'); assertHealthy(stock, control);
      assert.equal(control.tools.length, 2);
      assert.ok(control.screen.some((line) => line.includes('created successfully')));
      assert.match(byName(control, 'TaskList')[0].content[0].text, /#1 \[pending\] TERMINAL_LOCAL_TASK/);
      const live = await start('installed-toolview', { toolview: true, workspace: stock.work });
      await live.run('integration'); const compacted = await live.capture('collapsed'); assertHealthy(live, compacted);
      assert.deepEqual(compacted.extensionIssues, control.extensionIssues, 'existing package warnings are identical with and without Toolview');
      assert.deepEqual(activity(live), activity(stock), 'same installed-profile calls/results and model-facing contents are unchanged');
      assert.deepEqual(persisted(compacted), persisted(control));
      assert.equal(compacted.tools.length, 2);
      for (const name of ['TaskCreate', 'TaskList']) {
        const tool = byName(compacted, name)[0];
        const rows = compactContent(tool);
        assert.match(rows[0], new RegExp(name));
        assert.doesNotMatch(rows.join(''), /✓|✗/u);
        if (name === 'TaskList') assert.equal(rows.length, 1, 'no-args real task stays single-row');
        const row = compacted.screen.findIndex((line) => line.includes(`⚙ ${name}`));
        assert.ok(row >= 0, `real installed ${name} summary is on screen`);
        assert.equal(compacted.cells[row][compacted.screen[row].indexOf(name)].bgMode, 0);
      }
      assert.ok(!compacted.screen.some((line) => line.includes('created successfully')), 'native task result is hidden while collapsed');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.screen.some((line) => line.includes('created successfully')));
      assert.deepEqual(expanded.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content));
      live.send('\x0f'); await live.settle();
      await live.command('/toolview off'); const disabled = await live.capture('disabled'); assertHealthy(live, disabled);
      assert.deepEqual(disabled.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content), 'within-profile off preserves actual results');
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines));
      assert.ok(disabled.screen.some((line) => line.includes('created successfully')));
      const replay = await start('installed-stock-replay', { session: compacted.session, workspace: stock.work });
      const nativeReplay = await replay.capture('replay'); assertHealthy(replay, nativeReplay);
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), nativeReplay.tools.map((tool) => tool.lines), 'same-session installed stock renderer is restored exactly');
      writeFileSync(join(artifacts, 'integration-coverage.json'), JSON.stringify({
        executed: ['TaskCreate', 'TaskList'], registrations: compacted.registrations,
        stockExtensionDiagnostics: control.extensionIssues, patchedExtensionDiagnostics: compacted.extensionIssues,
        packages: live.profile.inventory.filter((entry) => live.profile.packages.some((p) => p.source === entry.source)),
        exclusions: live.profile.exclusions, limitations: live.profile.limitations,
        rendererCoverage: '@tintinweb/pi-tasks real tools through their registered native/default renderer; other installed tools registration only',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

// Bash-card oracle uses plain ASCII hard-cell wrapping, independent of production layout.
function bashArguments(dump) {
  return persisted(dump).filter((entry) => entry.name === 'bash').map((entry) => entry.arguments);
}
function hardRows(text, width) {
  return text.split('\n').flatMap((row) => {
    let expanded = '';
    for (const char of row) expanded += char === '\t' ? ' '.repeat(8 - expanded.length % 8) : char;
    return expanded.length ? Array.from({ length: Math.ceil(expanded.length / width) }, (_, i) => expanded.slice(i * width, (i + 1) * width)) : [''];
  });
}
// Contract arithmetic only: never import the production frame/layout/paint helpers.
function bashGeometry(width, outputPad = 1) {
  let spare = Math.max(0, width - 1);
  const border = Math.min(1, spare); spare -= border;
  const padding = Math.min(2, spare); spare -= padding;
  const inside = Math.ceil(padding / 2), insideRight = Math.floor(padding / 2);
  const left = Math.min(outputPad, Math.floor(spare / 2)), right = Math.min(outputPad, spare - left);
  return { left, border, inside, insideRight, right, origin: left + border + inside, content: width - left - right - border - padding };
}
function bashExpected(tool, args, dump, { partial = false } = {}) {
  const width = bashGeometry(dump.width, dump.outputPad).content;
  const comments = [];
  if (args.description?.trim()) comments.push('# ' + args.description.trim());
  if (args.workdir && resolve(dump.cwd, args.workdir) !== resolve(dump.cwd)) comments.push('# Running in ' + resolve(dump.cwd, args.workdir));
  const rows = comments.flatMap((row) => hardRows(row, width));
  if (comments.length) rows.push('');
  rows.push(...hardRows('$ ' + args.command, width));
  const output = (tool.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').replace(/\r\n?/g, '\n');
  const code = tool.details?.exit_code;
  const nonzero = Number.isFinite(code) && Number.isInteger(code) && code !== 0;
   const logical = output.split('\n');
   while (logical.length && !logical.at(-1).trim()) logical.pop();
   // Independent ASCII suffix expression, not production's logical-row indexing.
   const timeout = !partial && code === 124 && /(?:^|\n)[ \t]*\n\[command timed out\]\n\[exit code: 124\]$/.test(logical.join('\n'));
   const footer = timeout ? '[exit code: 124; error: command timed out]' :
     nonzero ? `[exit code: ${code}${tool.isError ? '; error: execution failed' : ''}]` : tool.isError ? '[error: execution failed]' : '';
   if (timeout) logical.splice(-2);
   else if (!partial && nonzero && logical.at(-1) === footer && logical.length > 1 && !logical.at(-2).trim()) logical.pop();
   while (logical.length && !logical.at(-1).trim()) logical.pop();
   // Keep the leading separator available for a suffix-only duplicate before edge trimming.
   while (logical.length && !logical[0].trim()) logical.shift();
   // Deliberately wrap all ASCII output; production's bounded 11-row iterator is not this oracle.
  const visual = logical.length ? hardRows(logical.join('\n'), width) : [];
  if (visual.length) {
    const preview = tool.expanded ? visual : visual.slice(0, 10);
    if (!tool.expanded && visual.length > 10) while (preview.length && !preview.at(-1).trim()) preview.pop();
    rows.push('', ...preview);
    if (!tool.expanded && visual.length > 10) {
      const hint = '… (Click to expand)';
      rows.push(hint.length <= width ? hint : width <= 3 ? '.'.repeat(width) : hint.slice(0, width - 3) + '...');
    }
  }
  if (!partial && footer) rows.push('', ...hardRows(footer, width));
  return rows;
}
function bashCard(tool, args, dump, options) {
  assert.equal(typeof args.command, 'string');
  const actual = tool.lines.map((row) => stripVTControlCharacters(row));
  if (dump.width === 0) { assert.deepEqual(actual, []); return; }
  const geometry = bashGeometry(dump.width, dump.outputPad);
  const top = geometry.border ? actual.findIndex((row) => row.includes('┃')) : actual[0] === '' ? 1 : 0;
  assert.ok(top === 0 || top === 1, 'at most one unpainted transcript separator before panel');
  if (top) assert.equal(actual[0], '', 'outside separator is genuinely empty, not a painted panel row');
  const frame = (body = '') => ' '.repeat(geometry.left) + (geometry.border ? '┃' : '') +
    ' '.repeat(geometry.inside) + body.padEnd(geometry.content) + ' '.repeat(geometry.insideRight + geometry.right);
  assert.equal(actual[top], frame(), 'exact full-panel top padding row, including left marker and exterior margins');
  assert.equal(actual.at(-1), frame(), 'exact full-panel bottom padding row');
  const expected = bashExpected(tool, args, dump, options);
  assert.deepEqual(actual.slice(top + 1, -1), expected.map(frame), 'independent Output-padding oracle: complete body, left marker, one inside cell per side, exact exterior margins');
  assert.doesNotMatch(actual.join('\n'), /Took \d|✓| [→⚙] bash/, 'custom bash card has no native title/runtime/success marker');
}
function allBashCards(dump, options) {
  const args = bashArguments(dump);
  assert.equal(args.length, byName(dump, 'bash').length);
  byName(dump, 'bash').forEach((tool, i) => bashCard(tool, args[i], dump, options));
}
function simpleBashCards(dump, result = 'BASH_RESULT') {
  allBashCards(dump);
  assert.ok(byName(dump, 'bash')[0].lines.some((row) => plain(row).includes(result)));
}
function traffic(terminal, count) {
  const events = terminal.events();
  assert.equal(events.filter((event) => event.type === 'call').length, count);
  assert.equal(events.filter((event) => event.type === 'result').length, count);
  assert.equal(events.filter((event) => event.type === 'model_context').length, count + 1);
  assert.equal(events.filter((event) => event.type === 'provider_error').length, 0);
  return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
}
async function mouseAt(terminal, dump, needle, { offset = 0, button = 0, animated = false } = {}) {
  const y = dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `mouse target is on real screen: ${needle}`);
  const x = Math.max(1, dump.screen[y].indexOf(needle) + 1);
  terminal.send(`\x1b[<${button};${x};${y + 1 + offset}M\x1b[<${button};${x};${y + 1 + offset}m`);
  await terminal.settle(animated);
}
async function bashScreenStyle(dump, needle, role, background) {
  // Heredoc data is present in both supplied command and returned output; sample the output occurrence.
  const y = role === 'toolOutput' ? dump.screen.findLastIndex((row) => row.includes(needle)) : dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `styled content appears on screen: ${needle}`);
  const actual = dump.cells[y][dump.screen[y].indexOf(needle)];
  const ref = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => ref.write(dump.summaryStyles[role], done));
    let cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ fg: actual.fg, mode: actual.fgMode, dim: actual.dim },
      { fg: cell.getFgColor(), mode: cell.getFgColorMode(), dim: cell.isDim() }, `screen foreground: ${role}`);
    ref.reset();
    await new Promise((done) => ref.write(dump.backgroundStyles[background], done));
    cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ bg: actual.bg, mode: actual.bgMode }, { bg: cell.getBgColor(), mode: cell.getBgColorMode() }, `screen background: ${background}`);
  } finally { ref.dispose(); }
}

function panelAt(dump, index, needle) {
  const tool = byName(dump, 'bash')[index];
  const component = tool.lines.map((row) => stripVTControlCharacters(row));
  const top = component.findIndex((row) => row.includes('┃'));
  const row = component.findIndex((line) => line.includes(needle));
  const screen = dump.screen.findIndex((line) => line.includes(needle));
  assert.ok(top >= 0 && row > top && screen >= 0, `panel ${index} anchor on actual screen: ${needle}`);
  const y = screen - row + top;
  const bottom = y + component.length - top - 1;
  assert.ok(y > 0 && bottom < dump.screen.length, 'complete panel and preceding separator visible');
  return { y, bottom, command: screen, left: 1, right: dump.width - 2 };
}
async function sgrAt(terminal, x, y, button = 0, release = true) {
  if (button === 0 && release && terminal.lastSingleClick) {
    // Distinct single clicks must not become Pi's native <=500ms word/line selection.
    await sleep(Math.max(0, 520 - (Date.now() - terminal.lastSingleClick)));
  }
  terminal.send(`\x1b[<${button};${x + 1};${y + 1}M` + (release ? `\x1b[<${button};${x + 1};${y + 1}m` : ''));
  if (button === 0 && release) terminal.lastSingleClick = Date.now();
  await terminal.settle();
}
async function moveAt(terminal, x, y) { await sgrAt(terminal, x, y, 35, false); }
async function referenceCell(style) {
  const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => term.write(style, done));
    const cell = term.buffer.active.getLine(0).getCell(0);
    return { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() };
  } finally { term.dispose(); }
}
async function panelCells(dump, index, needle, { error = false } = {}) {
  const panel = panelAt(dump, index, needle);
  const bg = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const border = await referenceCell(error ? dump.frameStyles.errorBorder : dump.frameStyles.border);
  assert.notEqual(border.fgMode, 0, 'semantic border reference is nondefault');
  if (error) {
    const footerY = dump.screen.findIndex((row, y) => y >= panel.y && y <= panel.bottom && /\[(?:exit code:|error:)/u.test(row));
    assert.ok(footerY >= 0, 'error footer is physically displayed inside the failed panel');
    const footerX = dump.screen[footerY].indexOf('['), footer = dump.cells[footerY][footerX];
    const stripe = dump.cells[footerY][1];
    assert.deepEqual({ fg: stripe.fg, mode: stripe.fgMode, dim: stripe.dim },
      { fg: footer.fg, mode: footer.fgMode, dim: footer.dim }, 'failed stripe matches actual footer foreground');
  }
  for (let y = panel.y; y <= panel.bottom; y++) {
    for (let x = 0; x < dump.width; x++) {
      const cell = dump.cells[y][x];
      if (x < 1 || x >= dump.width - 1) {
        assert.ok(cell.text === '' || cell.text === ' ', `exterior cell is blank at (${x},${y})`);
        assert.equal(cell.bgMode, 0, `exterior background remains terminal default at (${x},${y})`);
      } else if (x === 1) {
        assert.equal(cell.bgMode, 0, `ordinary/error stripe background is terminal default at (${x},${y})`);
      } else {
        assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: bg.bg, bgMode: bg.bgMode }, `whole panel background stays strictly neutral at (${x},${y})`);
      }
    }
    const cell = dump.cells[y][1];
    assert.equal(cell.text, '┃', 'left border on every panel row including padding');
    assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
      { fg: border.fg, fgMode: border.fgMode, dim: border.dim }, 'border foreground matches public active-theme reference');
    for (const x of [2, dump.width - 2]) assert.equal(dump.cells[y][x].text, ' ', 'one inside cell per side');
  }
  assert.equal(dump.screen[panel.y - 1], '', 'exactly one blank transcript separator precedes panel top');
  for (const cell of dump.cells[panel.y - 1]) assert.equal(cell.bgMode, 0, 'preceding transcript separator is outside panel painting');
  for (const y of [panel.y, panel.bottom]) for (let x = 2; x < dump.width - 1; x++)
    assert.equal(dump.cells[y][x].text, ' ', 'full top/bottom panel padding');
  return panel;
}
// Locate the actual stock editor's complete painted block, not horizontal
// border glyphs: input is now a user panel and never a transcript/tool frame.
function physicalEditor(dump) {
  assert.ok(dump.editor, 'actual public stock editor is recorded');
  const expected = dump.editor.lines.map(row => plain(row.replaceAll('\x1b_pi:c\x07', '')));
  const top = dump.screen.findLastIndex((_row, start) => expected.every((row, offset) => dump.screen[start + offset]?.trimEnd() === row));
  assert.ok(top >= 0, 'complete actual editor block is physically visible');
  return { top, bottom: top + expected.length - 1 };
}
// Real mouse transport and public selection observation; no component mutation or handler calls.
async function bashPointerChecks(live, initial) {
  let current = initial;
  const anchor = 'for i in $(seq 1 11)';
  const panel = () => panelAt(current, 2, anchor);
  const snapshot = async (name) => { current = await live.capture(`pointer-${name}`); return current; };
  const states = () => current.tools.map((tool) => tool.expanded);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  const noninteractive = panelAt(current, 0, "cat <<'TV_EOF'");
  await moveAt(live, 5, noninteractive.command); await snapshot('nonexpandable-move');
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await sgrAt(live, 2, noninteractive.y); await snapshot('nonexpandable-click');
  assert.ok(current.tools.every((tool) => !tool.expanded), 'nonexpandable panel does not toggle');
  // Native no-button motion must leave every panel cell strictly neutral.
  await moveAt(live, 5, panel().command); await snapshot('enter');
  await panelCells(current, 2, anchor);
  for (const x of [0, current.width - 1]) {
    await moveAt(live, 5, panel().command); await snapshot(`margin-${x}-enter`);
    await panelCells(current, 2, anchor);
    await moveAt(live, x, panel().command); await snapshot(`margin-${x}`);
    await panelCells(current, 2, anchor);
  }
  await moveAt(live, 5, panel().command); await snapshot('before-editor'); await panelCells(current, 2, anchor);
  const editor = physicalEditor(current);
  await moveAt(live, 5, editor.top + 1); await snapshot('editor-leave'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-focus'); await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('focus-out'); await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('focus-in'); await panelCells(current, 2, anchor);
  // Primary clicks on both exterior cells and the separator are ignored.
  for (const [x, y, label] of [[0, panel().command, 'left'],
    [current.width - 1, panel().command, 'right'], [3, panel().y - 1, 'separator']]) {
    const before = states(); await sgrAt(live, x, y); await snapshot(`outside-click-${label}`); assert.deepEqual(states(), before);
  }
  // A press and drag must remain a host selection, not a captured expansion gesture.
  let p = panel(); const beforeDrag = states();
  await sgrAt(live, 5, p.command, 0, false); await snapshot('press'); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 15, p.command, 32, false);
  live.send(`\x1b[<0;16;${p.command + 1}m`); await live.settle();
  await snapshot('selection-drag');
  assert.equal(current.selectionActive, true, 'public root confirms an actual text selection after SGR drag/release');
  assert.deepEqual(states(), beforeDrag);
  await moveAt(live, 5, p.command); await snapshot('selection-move'); assert.deepEqual(states(), beforeDrag);
  // An actual single click in the exterior resets native selection without toggling the card.
  await sgrAt(live, 0, p.command); await snapshot('selection-cleared'); assert.equal(current.selectionActive, false); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 5, panel().command, 2); await snapshot('secondary'); assert.deepEqual(states(), beforeDrag);
  // Native word selection on a deliberate double-click suppresses the second normalized click.
  await sleep(520); p = panel();
  const click = `\x1b[<0;8;${p.command + 1}M\x1b[<0;8;${p.command + 1}m`;
  live.send(click + click); await live.settle(); await snapshot('active-selection-click');
  assert.equal(current.selectionActive, true, 'actual native double-click selected the command word');
  assert.equal(current.tools[2].expanded, true, 'first click expands; active-selection second click does not collapse');
  assert.ok(current.tools.filter((_, i) => i !== 2).every((tool) => !tool.expanded));
  await sgrAt(live, 0, panel().command); await snapshot('double-selection-cleared'); assert.equal(current.selectionActive, false);
  await sgrAt(live, 2, panel().command); await snapshot('double-selection-restored'); assert.equal(current.tools[2].expanded, false);
  // These coordinates include exact left/right panel bounds, both padding rows and all content roles.
  for (const region of ['border', 'inside', 'inside-right', 'command', 'gap', 'right-edge', 'top', 'bottom']) {
    p = panel();
    const [x, y] = region === 'border' ? [1, p.command] : region === 'inside' ? [2, p.command] :
      region === 'inside-right' ? [current.width - 2, p.command] :
      region === 'command' ? [3, p.command] : region === 'gap' ? [3, p.command + 1] :
      region === 'right-edge' ? [current.width - 2, p.command] : region === 'top' ? [3, p.y] : [3, p.bottom];
    const before = states(); await sgrAt(live, x, y); await snapshot(`panel-${region}`);
    assert.equal(current.tools[2].expanded, !before[2], `whole-panel primary click toggles ${region}`);
    assert.deepEqual(states().filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), 'only receiving card toggles');
    // Restore collapsed through its border for the next region; no direct mutation.
    if (current.tools[2].expanded) { await sgrAt(live, 1, panel().command); await snapshot(`restore-${region}`); }
  }
  // Wheel remains native; no card toggles.
  const beforeWheel = states(); p = panel();
  await sgrAt(live, 5, p.command, 64, false); await snapshot('wheel'); assert.deepEqual(states(), beforeWheel);
  await sgrAt(live, 5, panel().command, 65, false); await snapshot('wheel-back'); assert.deepEqual(states(), beforeWheel);
  live.send('\x0f'); await live.settle(); await snapshot('expanded-transfer-base');
  assert.ok(current.tools.every((tool) => tool.expanded));
  await moveAt(live, 5, panel().command); await snapshot('transfer-from'); await panelCells(current, 2, anchor);
  const first = panelAt(current, 0, "cat <<'TV_EOF'");
  await moveAt(live, 5, first.command); await snapshot('transfer-to');
  await panelCells(current, 0, "cat <<'TV_EOF'"); await panelCells(current, 2, anchor);
  // Expanded error footer remains clickable; motion changes neither neutral paint nor error border.
  await moveAt(live, 5, panelAt(current, 3, "printf 'REAL_ERROR").command); await snapshot('error-move');
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await mouseAt(live, current, '[error: execution failed]'); await snapshot('footer-collapse'); assert.equal(current.tools[3].expanded, false);
  live.send('\x0f'); await live.settle(); await snapshot('collapsed-transfer-end');
  assert.ok(current.tools.every((tool) => !tool.expanded));
  await live.resize(100, 35); await snapshot('wheel-small-viewport');
  const wheelY = current.screen.findIndex((line) => line.includes('REAL_ROW_08'));
  assert.ok(wheelY >= 0, 'interactive output is visible in a genuinely scrollable viewport');
  const wheelScreen = [...current.screen], wheelStates = states();
  await sgrAt(live, 5, wheelY, 64, false); await snapshot('wheel-scroll');
  assert.notDeepEqual(current.screen, wheelScreen, 'uncaptured wheel reaches native transcript scrolling');
  assert.deepEqual(states(), wheelStates, 'native scrolling does not toggle any card');
  await live.resize(100, 150); await snapshot('wheel-restored');
  await moveAt(live, 5, panel().command); await snapshot('before-resize'); await panelCells(current, 2, anchor);
  await live.resize(24, 150); await snapshot('resized');
  await panelCells(current, 2, 'for i in $(seq');
  // Neutral paint must survive resize, re-entry and widening.
  await moveAt(live, 5, panelAt(current, 2, 'for i in $(seq').command); await snapshot('narrow-enter');
  await panelCells(current, 2, 'for i in $(seq');
  await live.resize(100, 150); await snapshot('resize-back'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-off'); await panelCells(current, 2, anchor);
  await live.command('/toolview off'); await snapshot('off');
  await live.command('/toolview on'); await snapshot('on'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-reload'); await panelCells(current, 2, anchor);
  const starts = live.events().filter((event) => event.type === 'start').length;
  await live.command('/reload'); await live.event('start', starts + 1); await snapshot('reload'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('post-reload-enter'); await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('post-reload-leave'); await panelCells(current, 2, anchor);
  // Native /settings replaces the renderer without reloading extensions or transcript components.
  const modeEvents = live.events();
  const modeTraffic = traffic(live, 4);
  const nativeMode = async (from, to) => {
    await live.command('/settings');
    live.send('TUI mode'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${from}\\s*$`, 'u').test(row)),
      `native settings search selects TUI mode: ${from}`);
    // SettingsList cycles values immediately on Enter; Esc only closes the selector.
    live.send('\r'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${to}\\s*$`, 'u').test(row)),
      `native settings Enter switches TUI mode: ${to}`);
    assert.equal(live.term.buffer.active.type, to === 'fullscreen' ? 'alternate' : 'normal',
      'actual terminal buffer reflects the native renderer replacement');
    live.send('\x1b'); await live.settle();
    assert.ok(!live.screen().some((row) => /→ TUI mode\s+/u.test(row)), 'Esc closes native settings');
  };
  await moveAt(live, 5, panel().command); await snapshot('mode-before-regular');
  await panelCells(current, 2, anchor);
  await nativeMode('fullscreen', 'regular'); await snapshot('mode-regular'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => !tool.expanded), 'regular replacement retains collapsed state');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-expanded'); allBashCards(current);
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => tool.expanded), 'real Ctrl+O expands retained tools in regular mode');
  assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')), 'regular expanded output appears on actual screen');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-collapsed'); allBashCards(current);
  await panelCells(current, 2, anchor);
  assert.ok(current.tools.every((tool) => !tool.expanded), 'real Ctrl+O collapses retained tools in regular mode');
  await nativeMode('regular', 'fullscreen'); await snapshot('mode-fullscreen'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-enter');
  await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('mode-fullscreen-margin-leave');
  await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-focus-enter');
  await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('mode-fullscreen-focus-out');
  await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('mode-fullscreen-focus-in');
  await panelCells(current, 2, anchor);
  assert.deepEqual(live.events(), modeEvents, 'native settings replacements emit no extra start/session_start/reload or execution events');
  assert.deepEqual(traffic(live, 4), modeTraffic, 'native settings replacements preserve four calls/results and five model contexts');
  assert.deepEqual(current.tools.map((tool) => tool.id), initial.tools.map((tool) => tool.id), 'native settings replacements retain the same transcript calls');
  assert.deepEqual(persisted(current), persisted(initial), 'pointer and lifecycle operations preserve exact stored traffic');
  return current;
}

 test('real CLI: built-in bash full commands, preview, resize, theme and same-session controls',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 150); return terminal;
    };
    try {
      const live = await start('bash-real', { toolview: true });
      await live.run('bash-real'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, false, 'real built-in bash was not replaced');
      assert.equal(byName(wide, 'bash').length, 4); allBashCards(wide);
      const args = bashArguments(wide);
       assert.ok(args[0].command.includes("<<'TV_EOF'\n  HEREDOC_INDENT\n"));
       for (const tool of wide.tools) for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
         bashCard({ ...tool, lines: tool.tinyLines[width] }, tool.args, { ...wide, width });
         if (width) await assertFits(tool.tinyLines[width], width);
       }
      assert.ok(wide.screen.map(plain).includes(' ┃   HEREDOC_INDENT'), 'supplied two-space heredoc indentation after column-three content origin');
      assert.ok(wide.screen.map(plain).includes(' ┃ HEREDOC_END'));
      assert.equal(lines(byName(wide, 'bash')[2]).filter((row) => /REAL_ROW_\d+/.test(row)).length, 10);
      assert.ok(wide.screen.some((row) => row.includes('… (Click to expand)')));
      assert.ok(!byName(wide, 'bash')[2].lines.some((row) => row.includes('REAL_ROW_11')));
      assert.ok(byName(wide, 'bash')[3].lines.some((row) => row.includes('[error: execution failed]')));
      assert.ok(!byName(wide, 'bash')[3].lines.some((row) => row.includes('[exit code: 7;')), 'built-in transient structuredContent is not a numeric footer source');
      await bashScreenStyle(wide, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, "cat <<'TV_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(wide, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(wide, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, '[error: execution failed]', 'error', 'toolPendingBg');
       // Every panel row is interactive for expandable cards; exterior cells are not.
       await mouseAt(live, wide, 'for i in $(seq 1 11)');
       let current = await live.capture('command-click'); assert.equal(current.tools[2].expanded, true);
       await mouseAt(live, current, 'for i in $(seq 1 11)', { offset: 1 });
       current = await live.capture('gap-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01', { button: 2 });
      current = await live.capture('secondary-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '… (Click to expand)');
      current = await live.capture('hint-click'); allBashCards(current);
      assert.deepEqual(current.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [wide.tools[2].id]);
      assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')));
      await mouseAt(live, current, 'REAL_ROW_11');
      current = await live.capture('output-collapse'); allBashCards(current); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01');
      current = await live.capture('output-expand'); allBashCards(current); assert.equal(current.tools[2].expanded, true);
      await mouseAt(live, current, 'REAL_ROW_11'); await live.capture('recollapsed');
      await live.resize(24, 150); const narrow = await live.capture('narrow'); allBashCards(narrow);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      // Wide command has no cap and every soft row starts at content origin.
       assert.ok(narrow.tools[1].lines.length > 20);
       assert.ok(narrow.tools[1].lines.length > wide.tools[1].lines.length, 'W-5 content width causes more actual visual rows after resize');
      await live.resize(100, 150); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded)); allBashCards(expanded);
      assert.ok(expanded.screen.some((row) => row.includes('REAL_ROW_11')));
      live.send('\x0f'); await live.settle();
      await live.command('/tv-theme light'); const light = await live.capture('light'); allBashCards(light);
      await bashScreenStyle(light, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, "cat <<'TV_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(light, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(light, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, '[error: execution failed]', 'error', 'toolPendingBg');
       await panelCells(light, 0, "cat <<'TV_EOF'");
       await panelCells(light, 2, 'for i in $(seq 1 11)');
       await panelCells(light, 3, "printf 'REAL_ERROR", { error: true });
       await moveAt(live, 5, panelAt(light, 2, 'for i in $(seq 1 11)').command);
       const lightEnter = await live.capture('pointer-light-enter');
       await panelCells(lightEnter, 2, 'for i in $(seq 1 11)');
       await moveAt(live, 0, panelAt(lightEnter, 2, 'for i in $(seq 1 11)').command);
       const lightLeave = await live.capture('pointer-light-leave'); await panelCells(lightLeave, 2, 'for i in $(seq 1 11)');
       live.send('\x0f'); await live.settle(); const lightExpanded = await live.capture('pointer-light-expanded');
       await moveAt(live, 5, panelAt(lightExpanded, 3, "printf 'REAL_ERROR").command);
       const lightErrorMove = await live.capture('pointer-light-error-move');
       await panelCells(lightErrorMove, 3, "printf 'REAL_ERROR", { error: true });
       live.send('\x0f'); await live.settle();
       await moveAt(live, 0, panelAt(lightErrorMove, 3, "printf 'REAL_ERROR").command);
       await live.capture('pointer-light-end');
       assert.notDeepEqual(light.tools[0].lines, wide.tools[0].lines);
      await live.command('/tv-theme dark');
      const session = wide.session;
      const stock = await start('bash-real-native', { session, workspace: live.work });
      const native = await stock.capture('native');
      assert.deepEqual(persisted(native), persisted(wide), 'same-session native control receives identical actual tool results and command arguments');
      assert.deepEqual(native.tools.map((tool) => tool.content), wide.tools.map((tool) => tool.content));
      assert.ok(native.tools[0].lines.some((row) => row.includes('$ cat')));
      await live.command('/toolview off'); const off = await live.capture('off');
      assert.ok(off.tools.every((tool) => tool.lines.some((row) => row.includes('Took'))), 'live native timing is displayed but not persisted by Pi');
      assert.deepEqual(off.tools.map((tool) => tool.content), native.tools.map((tool) => tool.content));
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live component native rendering restored exactly');
       await live.command('/toolview on');
       // Keep existing live-duration/native controls before the pointer matrix's reload:
       // Pi does not persist native execution durations in a reconstructed component.
       await bashPointerChecks(live, wide);
       const starts = live.events().filter((event) => event.type === 'start').length;
       await live.command('/reload'); await live.event('start', starts + 1);
       const reloaded = await live.capture('reloaded'); allBashCards(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = traffic(live, 4); await live.close();
      const replay = await start('bash-real-replay', { toolview: true, session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(native));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session native replay restored exactly without unpersisted live duration');
      await replay.command('/toolview on'); allBashCards(await replay.capture('on'));
      const card = await start('bash-real-card', { toolview: true, session, workspace: live.work, flags: ['--toolview-card', 'bash'] });
      const nativeCard = await card.capture('card');
      assert.deepEqual(nativeCard.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines));
      const compactOverride = await start('bash-real-compact', { toolview: true, session, workspace: live.work,
        flags: ['--toolview-card', 'bash', '--toolview-compact', 'bash'] });
      const compacted = await compactOverride.capture('compact');
      for (const tool of compacted.tools) compactContent(tool);
      compactOverride.send('\x0f'); await compactOverride.settle(); const overrideExpanded = await compactOverride.capture('expanded');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      assert.deepEqual(overrideExpanded.tools.map((tool) => tool.lines), nativeExpanded.tools.map((tool) => tool.lines), 'explicit compact opt-out uses native expanded cards');
      const regular = await start('bash-real-regular', { toolview: true, mode: 'regular', session, workspace: live.work });
      allBashCards(await regular.capture('collapsed'));
      await regular.resize(24, 150); allBashCards(await regular.capture('narrow'));
      await regular.resize(100, 150); regular.send('\x0f'); await regular.settle();
      const regularExpanded = await regular.capture('expanded'); allBashCards(regularExpanded); assert.ok(regularExpanded.tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'bash-real-coverage.json'), JSON.stringify({ calls: activity.filter((event) => event.type === 'call').length,
        results: activity.filter((event) => event.type === 'result').length, modelContexts: activity.filter((event) => event.type === 'model_context').length,
         builtIn: true, widths: [100, 24, 100], liveComponentWidths: [0, 1, 2, 3, 4, 5, 6, 7, 8],
         pointerViewport: [100, 35], pointerInputs: live.pointerInputs.length,
         selectionObserved: ['pointer-selection-drag', 'pointer-active-selection-click'],
         commands: args, session, modes: ['fullscreen', 'regular'],
        checked: ['heredoc indentation', 'uncapped hard-wrapped commands', '10-row preview', 'real nonzero exit generic footer', 'whole-panel command/gap/output/hint/border/inside/right-edge/top/bottom/footer clicks', 'exterior/separator/nonexpandable/secondary guards', 'actual SGR selection drag/double-click guard and public selection observation', 'native wheel scrolling', 'no-hover native SGR move/enter/margin/editor/focus leave/transfer with strictly steady neutral paint', 'steady neutral paint across resize/off/on/reload and re-entry', 'native /settings fullscreen→regular→fullscreen renderer replacement with retained traffic and no lifecycle events', 'regular replacement Ctrl+O expand/collapse and complete independent body oracle', 'steady neutral panel cells across native mode switches and fullscreen SGR enter/margin/focus leave', 'Ctrl+O', 'dark/light semantic/steady-neutral-background/normal-and-error-border cells', 'off/on/reload/replay', 'native-card and compact precedence', 'identical actual session args/results'] }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

 test('real CLI: gated actual built-in bash streaming and argument pending',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const live = new PiTerminal('bash-stream', { toolview: true });
    try {
      await live.ready(); await live.resize(100, 120);
      live.send('run bash-stream\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending', { animated: true });
      assert.equal(pending.bashShape, false);
      assert.ok(pending.tools[0].lines.some((row) => plain(row).includes('$ for i')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('… (Click')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('[error:')));
      await bashScreenStyle(pending, '$ ', 'dim', 'toolPendingBg');
      writeFileSync(join(live.output, 'provider-go'), 'go');
      await until(() => existsSync(join(live.output, 'shell-ready')), 'actual shell emitted 12 rows and reached gate');
      await until(() => live.events().some((event) => event.type === 'execution_update' && JSON.stringify(event.partialResult).includes('LIVE_ROW_12')), 'real built-in partial update');
      let streaming = await live.capture('partial', { animated: true }); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].content[0].text.includes('LIVE_ROW_12'), true);
      assert.ok(!streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await bashScreenStyle(streaming, 'LIVE_ROW_01', 'toolOutput', 'toolPendingBg');
      await mouseAt(live, streaming, '… (Click to expand)', { animated: true });
      streaming = await live.capture('partial-expanded', { animated: true }); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].expanded, true); assert.ok(streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await live.resize(24, 120, true); const narrow = await live.capture('partial-narrow', { animated: true }); allBashCards(narrow, { partial: true });
      await live.resize(100, 120, true); streaming = await live.capture('partial-wide', { animated: true });
      await mouseAt(live, streaming, 'LIVE_ROW_12', { animated: true });
      const collapsed = await live.capture('partial-collapsed', { animated: true }); assert.equal(collapsed.tools[0].expanded, false);
      writeFileSync(join(live.output, 'shell-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final);
      assert.ok(final.tools[0].content[0].text.includes('LIVE_FINAL'));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('final-expanded'); allBashCards(expanded);
      assert.equal(expanded.tools[0].lines.filter((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_ROW_01').length, 1, 'overlapping built-in snapshots were not appended');
      assert.ok(expanded.screen.some((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_FINAL'));
      const observed = traffic(live, 1);
      writeFileSync(join(artifacts, 'bash-stream-coverage.json'), JSON.stringify({ builtIn: true,
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        updates: live.events().filter((event) => event.type === 'execution_update').length,
        gates: ['provider-go', 'shell-ready', 'shell-final'], snapshots: ['arguments pending', '12-row actual partial', 'expanded partial', '24-column partial', 'final'],
        checked: ['pending theme', 'partial output mouse expansion/collapse', 'resize recomputes hit regions', 'final replaces overlapping snapshots', 'Ctrl+O'] }, null, 2));
    } finally { await live.close(); live.dispose(); }
  });

 test('real CLI: isolated opt-in representative bash metadata, comments and output boundaries',
  { skip: stockOnly, timeout: 90000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    try {
      const live = await start('bash-shapes'); await live.run('bash-shapes'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, true); allBashCards(wide);
      const tools = byName(wide, 'bash'); assert.equal(tools.length, 14);
      assert.ok(tools[0].lines.some((row) => row.includes('# Representative task description')));
      assert.ok(tools[0].lines.some((row) => row.includes('# Running in ' + resolve(wide.cwd, '../other/./dir'))));
      for (const text of ['(no output)', 'Background task started: task-id-123', '[exit code: 99]', 'Command exited with code 77'])
        assert.ok(tools[0].lines.some((row) => row.includes(text)), `returned literal preserved: ${text}`);
      assert.equal(tools[1].lines.filter((row) => stripVTControlCharacters(row).slice(3, -2).trim()).length, 1, 'whitespace-only output and equivalent cwd produce command only');
      assert.ok(!tools[2].lines.some((row) => row.includes('Running in')), 'absolute current cwd equivalent produces no comment');
      assert.ok(!tools[2].lines.some((row) => row.includes('Click to expand')), 'exactly ten visual output rows have no hint');
      assert.ok(tools[3].lines.some((row) => row.includes('Click to expand')), 'eleven visual output rows have hint');
      assert.ok(!tools[4].lines.some((row) => row.includes('Click to expand')), '221 characters wrap into three visual rows at 100');
      for (const index of [10, 11, 12, 13]) assert.ok(!tools[index].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')), 'zero/string/null/transient status has no footer');
      await bashScreenStyle(wide, '# Representative task description', 'muted', 'toolPendingBg');
      await bashScreenStyle(wide, '[exit code: 7]', 'error', 'toolPendingBg');
      await mouseAt(live, wide, '# Representative task description'); let current = await live.capture('comment-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '# Running in', { offset: 1 }); current = await live.capture('comment-gap-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '[exit code: 7]'); current = await live.capture('footer-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await live.resize(24, 240); const narrow = await live.capture('narrow'); allBashCards(narrow);
      assert.ok(narrow.tools[4].lines.some((row) => row.includes('… (Click')), 'more than ten W-5 visual output rows use a ten-row preview; allBashCards independently checks the complete shortened hint');
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      await live.resize(100, 240); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded'); allBashCards(expanded);
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.tools[3].lines.some((row) => row.includes('SHAPE_ROW_11')));
      live.send('\x0f'); await live.settle();
      const native = await start('bash-shapes-native', { toolview: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); assert.deepEqual(persisted(control), persisted(wide));
      await live.command('/toolview off'); const off = await live.capture('off');
      assert.deepEqual(off.tools.map((tool) => tool.content), control.tools.map((tool) => tool.content));
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live native fixture rendering restored exactly');
      await live.command('/toolview on');
      const observed = traffic(live, 14);
      const replay = await start('bash-shapes-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'details footer is stable live/replay; transient structuredContent intentionally ignored');
      assert.deepEqual(persisted(resumed), persisted(wide));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'same-session fixture native replay restored exactly');
      await replay.command('/toolview on');
      // Independent invocation for partial/final replacement, never an installed AFT execution.
      const stream = await start('bash-shape-stream'); stream.send('run bash-shape-stream\r'); await stream.event('shape_gate');
      let partial = await stream.capture('partial-one', { animated: true }); allBashCards(partial, { partial: true });
      assert.ok(!partial.tools[0].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')));
      await bashScreenStyle(partial, 'OLD_PARTIAL', 'toolOutput', 'toolPendingBg');
       await mouseAt(stream, partial, 'Streaming comment', { animated: true });
       partial = await stream.capture('stream-comment-click', { animated: true }); assert.equal(partial.tools[0].expanded, true);
       await mouseAt(stream, partial, 'Streaming comment', { offset: 1, animated: true });
       partial = await stream.capture('stream-comment-gap-collapse', { animated: true }); assert.equal(partial.tools[0].expanded, false);
       await mouseAt(stream, partial, '… (Click to expand)', { animated: true });
      partial = await stream.capture('partial-expanded', { animated: true }); allBashCards(partial, { partial: true }); assert.equal(partial.tools[0].expanded, true);
      writeFileSync(join(stream.output, 'shape-next'), 'go'); await stream.event('shape_gate', 2);
      const replacement = await stream.capture('partial-two', { animated: true }); allBashCards(replacement, { partial: true });
      assert.ok(!replacement.tools[0].lines.some((row) => row.includes('OLD_PARTIAL') || row.includes('SHAPE_ROW_')));
      assert.ok(replacement.tools[0].lines.some((row) => row.includes('REPLACEMENT_PARTIAL')));
      writeFileSync(join(stream.output, 'shape-final'), 'go'); await stream.event('agent_end');
      const final = await stream.capture('final'); allBashCards(final);
      assert.deepEqual(final.tools[0].content, [{ type: 'text', text: 'FINAL_ONLY' }]);
      assert.ok(!final.tools[0].lines.some((row) => row.includes('PARTIAL')));
      await bashScreenStyle(final, '[exit code: 7; error: execution failed]', 'error', 'toolPendingBg');
      traffic(stream, 1);
      writeFileSync(join(artifacts, 'bash-shapes-coverage.json'), JSON.stringify({ installedAFT: false, optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1',
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        streamCalls: 1, streamUpdates: stream.events().filter((event) => event.type === 'execution_update').length,
        cases: bashArguments(wide).map((args) => args.fixtureCase), widths: [100, 24, 100],
        checked: ['description/workdir comments', 'equivalent cwd omission', 'whitespace-only and interior blanks', 'literal task/status text', '10/11 visual rows',
          'structured persisted status combinations', 'transient structuredContent ignored', 'nonexpandable comments/gaps/footer ignored; streaming expandable comment/gap toggle', 'stream snapshots replace', 'partial footer suppressed', 'final generic error footer', 'native off/replay data identity'] }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: isolated bash presentation exceptions preserve exact traffic',
  { skip: stockOnly, timeout: 150000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 360); return terminal;
    };
    const row = (count) => Array.from({ length: count }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`);
    // Fresh literal fixture expectations: these checks do not derive expected traffic from the layout oracle.
    const cases = [
      ['suffix-match', 'BODY\n \t\n[exit code: 7]\n\n \t', 7, false],
      ['suffix-mismatch', 'BODY\n\n[exit code: 8]', 7, false],
      ['suffix-no-gap', 'BODY\n[exit code: 7]', 7, false],
      ['suffix-combined', 'BODY\n\n[exit code: -2; error: execution failed]', -2, true],
      ['suffix-error-only', 'BODY\n\n[error: execution failed]', undefined, true],
      ['suffix-error-mismatch', 'BODY\n\n[exit code: 7]', 7, true],
      ['suffix-success', 'BODY\n\n[exit code: 0]', 0, false],
      ['suffix-unknown', 'BODY\n\n[exit code: 7]', undefined, false],
      ['suffix-string', 'BODY\n\n[exit code: 7]', '7', false],
      ['suffix-indent', 'BODY\n\n [exit code: 7]', 7, false],
      ['suffix-spaces', 'BODY\n\n[exit code: 7] ', 7, false],
      ['suffix-fragment', 'BODY\n\nPREFIX [exit code: 7]', 7, false],
      ['suffix-nonterminal', 'BODY\n\n[exit code: 7]\nAFTER_SUFFIX', 7, false],
      ['suffix-double', 'BODY\n\n[exit code: 7]\n\n[exit code: 7]', 7, false],
      ['preview-one-blank', row(9).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-two-blanks', row(9).join('\n') + '\n\n \t\nHIDDEN_TAIL', undefined, false],
      ['preview-interior', row(3).join('\n') + '\n\n' + row(5).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-empty', ' '.repeat(1100) + 'HIDDEN_TAIL', undefined, false],
      ['suffix-deep', row(9).join('\n') + '\n\nEXTRA_CONTENT\nHIDDEN_TAIL\n\n[exit code: 7]', 7, false],
      ['suffix-only', '\n[exit code: 7]', 7, false],
    ];
    const body = (tool) => {
      const rows = tool.lines.map(stripVTControlCharacters);
      const top = rows.findIndex((line) => line.includes('┃'));
      return rows.slice(top + 1, -1).map((line) => line.slice(3, -2));
    };
    const byCase = (dump, name) => {
      const index = cases.findIndex(([fixtureCase]) => fixtureCase === name);
      assert.ok(index >= 0); return byName(dump, 'bash')[index];
    };
    const literalCount = (dump, name, literal, count) => assert.equal(
      body(byCase(dump, name)).filter((line) => line.includes(literal)).length, count, `${name}: exact visible count of ${literal}`);
    const identity = (actual, baseline, sessionBytes) => {
      assert.deepEqual(actual.branch, baseline.branch, 'complete branch remains byte-value exact');
      assert.deepEqual(persisted(actual), persisted(baseline), 'all persisted calls/results remain exact');
      assert.deepEqual(actual.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })),
        baseline.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })), 'live raw tool state remains exact');
      assert.equal(readFileSync(actual.session, 'utf8'), sessionBytes, 'saved session bytes unchanged by presentation');
    };
    const previewChecks = (dump) => {
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(dump, name));
        const hint = rows.findIndex((line) => line.startsWith('… (Click'));
        assert.ok(hint > 0, `${name}: overflow hint remains present`);
        assert.ok(rows[hint - 1].trim(), `${name}: no whitespace-only preview end before hint`);
        const first = rows.findIndex((line) => line.trimEnd() === 'SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5)] : row(9);
        assert.deepEqual(rows.slice(first, hint).map((line) => line.trimEnd()), expected, `${name}: nine rows, interior blanks preserved, no backfill`);
        assert.ok(!rows.some((line) => /HIDDEN_TAIL|EXTRA_CONTENT/.test(line)), `${name}: hidden later rows stay hidden`);
      }
      const empty = body(byCase(dump, 'preview-empty')).map((line) => line.trimEnd());
      const emptyHint = empty.findIndex((line) => line.startsWith('… (Click'));
      const commandRows = Math.ceil('$ shape preview-empty'.length / bashGeometry(dump.width).content);
      assert.equal(emptyHint, commandRows + 1, 'all-whitespace preview retains only the synthetic output section separator before hint');
      assert.equal(empty[emptyHint - 1], '');
      assert.ok(!empty.some((line) => line.includes('HIDDEN_TAIL')), 'empty preview never backfills the hidden nonblank row');
    };
    try {
      const live = await start('bash-shape-exceptions'); await live.run('bash-shape-exceptions');
      const wide = await live.capture('wide'); assert.equal(wide.bashShape, true); allBashCards(wide);
      assert.equal(wide.tools.length, 20);
      const observed = traffic(live, 20), sessionBytes = readFileSync(wide.session, 'utf8');
      const rawResults = cases.map(([, text, code, isError]) => ({ name: 'bash', content: [{ type: 'text', text }],
        ...(code === undefined ? {} : { details: { exit_code: code } }), isError }));
      const resultEvents = observed.filter((event) => event.type === 'result').map(({ type, ...result }) => result);
      assert.deepEqual(resultEvents, rawResults, 'every original output, trailing space, separator and metadata reaches tool_result exactly');
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        cases.map(([fixtureCase]) => ({ command: 'shape ' + fixtureCase, fixtureCase })), 'only harmless unique isolated commands are requested');
      observed.filter((event) => event.type === 'model_context').forEach((event, index) =>
        assert.deepEqual(event.results, rawResults.slice(0, index), `provider context ${index}: exact original cumulative results`));
      assert.deepEqual(persisted(wide).filter((entry) => entry.role === 'toolResult'),
        rawResults.map(({ name, details, ...result }) => ({ role: 'toolResult', toolName: name, ...result, details })), 'saved messages retain original suffixes and blanks');
      for (const name of ['suffix-match', 'suffix-combined']) {
        const footer = name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]';
        literalCount(wide, name, footer, 1);
        assert.deepEqual(body(byCase(wide, name)).map((line) => line.trimEnd()), ['$ shape ' + name, '', 'BODY', '', footer], 'only duplicated terminal block disappears');
      }
      literalCount(wide, 'suffix-only', '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-only')).map((line) => line.trimEnd()),
        ['$ shape suffix-only', '', '[exit code: 7]'], 'suffix-only output becomes an absent output section, not an extra footer');
      for (const name of ['suffix-no-gap', 'suffix-indent', 'suffix-spaces', 'suffix-fragment', 'suffix-nonterminal', 'suffix-double'])
        literalCount(wide, name, '[exit code: 7]', 2);
      literalCount(wide, 'suffix-mismatch', '[exit code: 8]', 1);
      literalCount(wide, 'suffix-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-only', '[error: execution failed]', 2);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7; error: execution failed]', 1);
      literalCount(wide, 'suffix-success', '[exit code: 0]', 1);
      for (const name of ['suffix-unknown', 'suffix-string', 'suffix-deep']) literalCount(wide, name, '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-no-gap')).map((line) => line.trimEnd()),
        ['$ shape suffix-no-gap', '', 'BODY', '[exit code: 7]', '', '[exit code: 7]'], 'missing separator preserves literal');
      previewChecks(wide);
      await bashScreenStyle(wide, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      for (const theme of ['light', 'dark']) {
        await live.command('/tv-theme ' + theme); const themed = await live.capture('theme-' + theme);
        allBashCards(themed); identity(themed, wide, sessionBytes);
        await bashScreenStyle(themed, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      }
      await live.resize(24, 360); const narrow = await live.capture('narrow'); allBashCards(narrow); previewChecks(narrow);
      identity(narrow, wide, sessionBytes); for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      live.send('\x0f'); await live.settle(); const narrowExpanded = await live.capture('narrow-expanded'); allBashCards(narrowExpanded);
      assert.ok(narrowExpanded.tools.every((tool) => tool.expanded)); identity(narrowExpanded, wide, sessionBytes);
      await live.resize(100, 360); const expanded = await live.capture('expanded'); allBashCards(expanded); identity(expanded, wide, sessionBytes);
      for (const name of ['suffix-match', 'suffix-combined']) literalCount(expanded, name,
        name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]', 1);
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(expanded, name)).map((line) => line.trimEnd());
        const first = rows.indexOf('SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5), '', 'HIDDEN_TAIL'] :
          name === 'suffix-deep' ? [...row(9), '', 'EXTRA_CONTENT', 'HIDDEN_TAIL', '', '[exit code: 7]'] :
          [...row(9), '', ...(name === 'preview-two-blanks' ? [''] : []), 'HIDDEN_TAIL'];
        assert.deepEqual(rows.slice(first), expected, `${name}: expansion retains all internal blank rows and hidden text`);
      }
      const emptyExpanded = body(byCase(expanded, 'preview-empty'));
      assert.equal(emptyExpanded.length, 14, 'expanded whitespace-prefix output retains all twelve visual output rows plus command and separator');
      assert.ok(emptyExpanded.slice(2, -1).every((line) => !line.trim()), 'eleven expanded whitespace-only content rows are not trimmed');
      assert.equal(emptyExpanded.at(-1).trim(), 'HIDDEN_TAIL');
      live.send('\x0f'); await live.settle(); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); identity(back, wide, sessionBytes);
      await live.command('/toolview off'); const off = await live.capture('off'); identity(off, wide, sessionBytes);
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'live native renderer restored without normalization');
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/toolview on'); await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); allBashCards(reloaded); identity(reloaded, wide, sessionBytes);
      assert.deepEqual(reloaded.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'same-session reload preserves exception presentation');
      const native = await start('bash-shape-exceptions-native', { toolview: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); identity(control, wide, sessionBytes);
      await live.command('/toolview off'); const reloadedOff = await live.capture('reloaded-off'); identity(reloadedOff, wide, sessionBytes);
      assert.deepEqual(reloadedOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'reloaded native output matches stock history byte-for-byte');
      const replay = await start('bash-shape-exceptions-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); identity(resumed, wide, sessionBytes);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off'); identity(replayOff, wide, sessionBytes);
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'disabled same-session replay restores exact native rendering');
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter((event) => event.type === type).length, 0, `history ${type} count remains zero`);
      assert.deepEqual(traffic(live, 20), observed, 'resize/theme/Ctrl+O/off/on/reload never rerun tool or provider');
      assert.equal(readFileSync(wide.session, 'utf8'), sessionBytes);
      writeFileSync(join(artifacts, 'bash-shape-exceptions-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        historyCalls: [native, replay].reduce((sum, terminal) => sum + terminal.events().filter((event) => event.type === 'call').length, 0),
        cases: cases.map(([name]) => name), widths: [100, 24, 100], themes: ['dark', 'light', 'dark'],
        checked: ['exact metadata-only terminal suffix', 'no-gap/mismatch/error-only/string/unknown/success literals retained',
          'one trailing block only', 'unwrapped footer comparison at narrow width', 'preview end blanks removed without backfill',
          'preview interior blanks and expanded blank rows retained', 'empty preview keeps only synthetic section separator', 'strict raw tool/session/branch/model/calls/context identity',
          'Ctrl+O', 'footer semantic cells', 'off/on/reload/native/history replay'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution', 'production bounded wrapping checked by parent unit tests'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: isolated bash presentation exceptions partial-to-final gate',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const raw = Array.from({ length: 9 }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`).join('\n') + '\n\n[exit code: 7]';
    const original = { content: [{ type: 'text', text: raw }], details: { exit_code: 7 }, isError: false };
    const rawIdentity = (dump) => assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), [original]);
    const visibleCount = (dump) => dump.tools[0].lines.filter((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd() === '[exit code: 7]').length;
    try {
      const live = await start('bash-shape-exception-stream'); live.send('run bash-shape-exception-stream\r');
      await live.event('shape_exception_gate');
      const partial = await live.capture('partial', { animated: true }); allBashCards(partial, { partial: true }); rawIdentity(partial);
      assert.equal(partial.tools[0].partial, true); assert.equal(partial.tools[0].expanded, false);
      const preview = partial.tools[0].lines.map(plain), hint = preview.findIndex((line) => line.includes('… (Click'));
      assert.ok(hint > 0); assert.ok(preview[hint - 1].includes('SHAPE_ROW_09'), 'partial preview trims blank tenth row without backfill');
      assert.equal(visibleCount(partial), 0, 'partial suffix is hidden by preview, not rendered as a synthesized status');
      await mouseAt(live, partial, '… (Click to expand)', { animated: true });
      const partialExpanded = await live.capture('partial-expanded', { animated: true }); allBashCards(partialExpanded, { partial: true }); rawIdentity(partialExpanded);
      assert.equal(partialExpanded.tools[0].expanded, true); assert.equal(visibleCount(partialExpanded), 1, 'expanded partial retains exact output suffix');
      const partialRows = partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd());
      assert.equal(partialRows[partialRows.indexOf('[exit code: 7]') - 1], '', 'partial retains the output blank separator');
      await bashScreenStyle(partialExpanded, '[exit code: 7]', 'toolOutput', 'toolPendingBg');
      await live.resize(24, 120, true); const narrow = await live.capture('partial-narrow', { animated: true });
      allBashCards(narrow, { partial: true }); rawIdentity(narrow); assert.equal(narrow.tools[0].expanded, true);
      await live.resize(100, 120, true);
      writeFileSync(join(live.output, 'shape-exception-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final); rawIdentity(final);
      assert.equal(final.tools[0].partial, false); assert.equal(final.tools[0].expanded, true);
      assert.equal(visibleCount(final), 1, 'final matching status appears exactly once, as metadata footer');
      assert.deepEqual(final.tools[0].lines.map((line) => stripVTControlCharacters(line)),
        partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line)), 'partial literal and final synthesized footer have identical plain rows');
      await bashScreenStyle(final, '[exit code: 7]', 'error', 'toolPendingBg');
      // A local hint click does not change Pi's global Ctrl+O setting (initially collapsed).
      // First synchronize global expansion, then toggle global collapse; assert both actual states.
      live.send('\x0f'); await live.settle(); const globalExpanded = await live.capture('final-global-expanded');
      allBashCards(globalExpanded); rawIdentity(globalExpanded); assert.equal(globalExpanded.tools[0].expanded, true);
      live.send('\x0f'); await live.settle(); const collapsed = await live.capture('final-collapsed'); allBashCards(collapsed); rawIdentity(collapsed);
      assert.equal(collapsed.tools[0].expanded, false); assert.equal(visibleCount(collapsed), 1);
      assert.ok(!collapsed.tools[0].lines.some((line) => line.includes('Click to expand')), 'final dedup leaves nine output rows: no overflow hint');
      await live.resize(24, 120); const narrowFinal = await live.capture('final-narrow'); allBashCards(narrowFinal); rawIdentity(narrowFinal);
      assert.ok(!narrowFinal.tools[0].lines.some((line) => line.includes('… (Click')), 'dedup uses logical unwrapped suffix at 24 columns too');
      await live.resize(100, 120);
      const observed = traffic(live, 1);
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        [{ command: 'shape exception-stream', fixtureCase: 'exception-stream' }]);
      assert.deepEqual(observed.filter((event) => event.type === 'result').map(({ type, name, ...result }) => result), [original]);
      assert.deepEqual(observed.filter((event) => event.type === 'model_context').map((event) => event.results),
        [[], [{ name: 'bash', ...original }]], 'final model context receives exact original suffix and blank');
      const updates = live.events().filter((event) => event.type === 'execution_update');
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].partialResult, original, 'one exact partial snapshot, not concatenated output');
      assert.deepEqual(persisted(final).filter((entry) => entry.role === 'toolResult'), [{ role: 'toolResult', toolName: 'bash', ...original }]);
      const sessionBytes = readFileSync(final.session, 'utf8');
      const replay = await start('bash-shape-exception-stream-replay', { session: final.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); rawIdentity(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), collapsed.tools.map((tool) => tool.lines));
      assert.deepEqual(resumed.branch, final.branch); assert.deepEqual(persisted(resumed), persisted(final));
      assert.equal(readFileSync(final.session, 'utf8'), sessionBytes, 'history did not rewrite original result');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.events().filter((event) => event.type === type).length, 0);
      assert.deepEqual(traffic(live, 1), observed);
      writeFileSync(join(artifacts, 'bash-shape-exception-stream-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        updates: updates.length, replayCalls: replay.events().filter((event) => event.type === 'call').length,
        gates: ['shape-exception-final'], widths: [100, 24, 100],
        checked: ['unchanged partial/final original content', 'partial suffix retained with output color', 'final dedup with error color',
          'blank preview edge trimmed while partial', 'real hint click', 'final nine-row no-overflow preview',
          'narrow unwrapped match', 'Ctrl+O', 'exact model/session/history identity'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

// Width regression: only ANSI-parsed physical cells are the display authority.
// Do not reuse the manual tool.render(viewportWidth) geometry/content oracle.
async function actualCommandCells(dump, commands, { mode, scrollbar }) {
  const panels = [], editor = physicalEditor(dump);
  // An always-visible native scrollbar also uses ┃, outside the tool allocation.
  const reserved = mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0;
  const hasCardBorder = (row) => row.slice(0, row.length - reserved).some((cell) => cell?.text === '┃');
  for (let y = 0; y < dump.cells.length; y++) {
    const statusEdge = dump.cells[y + 1]?.some(cell => cell?.text === '╹') &&
      dump.cells[y + 1]?.some(cell => cell?.text === '▀');
    if ((y >= editor.top && y <= editor.bottom) || statusEdge || !hasCardBorder(dump.cells[y])) continue;
    const top = y;
    while (y + 1 < dump.cells.length && y + 1 !== editor.top && hasCardBorder(dump.cells[y + 1])) y++;
    panels.push({ top, bottom: y });
  }
  assert.equal(panels.length, commands.length + dump.users.length,
    'exactly the user and command panels are displayed; no missing or extra frame');
  // User messages now share the frame. Identify command panels by their actual
  // first content cells, not by counting all stripes or assuming distinct colors.
  const commandPanels = panels.filter(({ top }) => dump.cells[top + 1]?.slice(3, 5)
    .map((cell) => cell?.text || ' ').join('') === '$ ');
  assert.equal(commandPanels.length, commands.length, 'every command owns exactly one complete displayed panel');
  const background = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const cellText = (cell) => cell.text || ' ';
  const observations = [];
  for (const [index, { top, bottom }] of commandPanels.entries()) {
    const padding = dump.cells[top];
    const left = padding.findIndex((cell) => cell.text === '┃');
    let panelEnd = left + 1; // stripe background is default, not panel paint
    while (panelEnd < padding.length && padding[panelEnd].bgMode === background.bgMode && padding[panelEnd].bg === background.bg) panelEnd++;
    // Observe the painted end, then add the contract's one unpainted exterior cell.
    // Fullscreen 'always' reserves a scrollbar column; regular/auto do not.
    const allocated = panelEnd + 1;
    assert.equal(allocated, dump.cells[top].length - (mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0),
      'observed frame width matches actual host allocation, not the manual dump width');
    assert.equal(left, 1, 'exact one-cell exterior-left margin');
    const origin = left + 2, contentWidth = panelEnd - 1 - origin;
    assert.equal(origin, 3, 'one border cell plus one inside-left cell');
    assert.equal(contentWidth, allocated - 5, 'observed content width excludes both inner and exterior paddings');
    const command = commands[index];
    assert.match(command, /^[\x20-\x7e\n]*$/u, 'this independent oracle is deliberately ASCII-only');
    const logical = ('$ ' + command).split('\n');
    const expected = logical.flatMap((line) => line.length ? Array.from({ length: Math.ceil(line.length / contentWidth) },
      (_, row) => line.slice(row * contentWidth, (row + 1) * contentWidth)) : ['']);
    assert.ok(top > 0 && bottom + 1 < dump.cells.length, 'all command rows and complete panel padding are visible');
    assert.ok(bottom > top + expected.length, 'panel includes every command row and bottom padding');
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < allocated; x++) {
        const cell = dump.cells[y][x];
        if (x === 0 || x === allocated - 1) {
          assert.equal(cellText(cell), ' ', `exact blank exterior (${x},${y})`);
          assert.equal(cell.bgMode, 0, `unpainted exterior (${x},${y})`);
        } else if (x === left) {
          assert.equal(cell.bgMode, 0, `default stripe background (${x},${y})`);
        } else {
          assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: background.bg, bgMode: background.bgMode },
            `panel physical background (${x},${y})`);
        }
      }
      assert.equal(dump.cells[y][left].text, '┃', 'one border on every physical row');
      for (const x of [left + 1, panelEnd - 1]) assert.equal(cellText(dump.cells[y][x]), ' ', 'exact inside-left/right padding');
    }
    for (const y of [top, bottom]) assert.equal(dump.cells[y].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'full top/bottom content padding');
    const actual = expected.map((row, offset) => {
      const cells = dump.cells[top + 1 + offset];
      const region = cells.slice(origin, panelEnd - 1);
      assert.ok(region.every((cell) => cell.width === 1), 'ASCII command occupies one physical cell per column');
      assert.equal(region.map(cellText).join(''), row.padEnd(contentWidth), 'every displayed command row, including whitespace and right padding');
      return region.slice(0, row.length).map(cellText).join('');
    });
    assert.equal(dump.cells[top + expected.length + 1].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'immediately after complete command is its blank output separator or bottom padding');
    // Restore only known logical newline boundaries; never trim or delete command whitespace.
    let cursor = 0;
    const reconstructed = logical.map((line) => actual.slice(cursor, cursor += Math.max(1, Math.ceil(line.length / contentWidth))).join('')).join('\n');
    assert.equal(reconstructed, '$ ' + command, 'all displayed command chars reconstructed exactly: no missing/duplicated chars');
    observations.push({ allocatedWidth: allocated, contentWidth, origin, commandChars: command.length,
      commandRows: actual.length, displayed: actual, reconstructed, equality: true });
  }
  return observations;
}

test('real CLI: actual-screen complete command width regression', { skip: stockOnly, timeout: 120000 }, async () => {
  const terminals = [], captures = [];
  const originalPython = "python3 -c \"from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))\" && node --check /tmp/neon-blocks-check.js";
  const commands = ["printf '" + 'LONGWORD'.repeat(30) + "'", originalPython.replaceAll('/tmp/neon-blocks-check.js', 'neon-blocks-check.js')];
  assert.equal(commands[0].length, 249, 'exact 249 ASCII-char safe built-in longword command');
  const start = async (name, options) => {
    const terminal = new PiTerminal(name, { toolview: true, ...options }); terminals.push(terminal);
    await terminal.ready(); await terminal.resize(100, 150); return terminal;
  };
  const observe = async (terminal, phase, settings) => {
    let baseline;
    for (const width of [100, 24, 140, 100]) {
      await terminal.resize(width, 150);
      const dump = await terminal.capture(`width-${phase}-${width}-${captures.length}`);
      assert.equal(dump.bashShape, false, 'native built-in bash is never replaced');
      assert.deepEqual(byName(dump, 'bash').map((tool) => tool.args.command), commands, 'original executed args remain exact');
      assert.deepEqual(bashArguments(dump).map((args) => args.command), commands, 'persisted commands remain exact');
      const observed = await actualCommandCells(dump, commands, settings);
      captures.push({ phase, mode: settings.mode, scrollbar: settings.scrollbar, viewportWidth: width, commands: observed });
      baseline ??= persisted(dump);
      assert.deepEqual(persisted(dump), baseline, 'resize cannot change persisted content');
    }
    return baseline;
  };
  try {
    for (const settings of [{ mode: 'fullscreen', scrollbar: 'auto' }, { mode: 'fullscreen', scrollbar: 'always' },
      { mode: 'regular', scrollbar: 'auto' }]) {
      const options = { mode: settings.mode, agentSettings: { fullscreenScrollbar: settings.scrollbar } };
      const live = await start(`width-${settings.mode}-${settings.scrollbar}-live`, options);
      writeFileSync(join(live.work, 'index.html'), '<html><script>const neonBlocksCheck = 1;\n</script></html>\n');
      await live.run('bash-width');
      const trafficBefore = traffic(live, 2);
      assert.ok(live.events().filter((event) => event.type === 'result').every((event) => !event.isError), 'both real commands succeed');
      assert.deepEqual(live.events().filter((event) => event.type === 'call').map((event) => event.input.command), commands);
      assert.equal(readFileSync(join(live.work, 'neon-blocks-check.js'), 'utf8'), 'const neonBlocksCheck = 1;\n', 'only owned workspace receives Python output');
      const beforeReplay = await observe(live, 'live', settings);
      assert.deepEqual(traffic(live, 2), trafficBefore, 'width transitions do not execute tools or provider again');
      const session = live.session; await live.close();
      const replay = await start(`width-${settings.mode}-${settings.scrollbar}-replay`, { ...options, session, workspace: live.work });
      const afterReplay = await observe(replay, 'replay', settings);
      assert.deepEqual(afterReplay, beforeReplay, 'same-session replay retains exact arguments/results');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `replay ${type} counter stays zero`);
      await replay.close();
    }
    writeFileSync(join(artifacts, 'actual-command-width-coverage.json'), JSON.stringify({
      originalPythonTextOnly: originalPython, executedCommands: commands,
      originalFixedTmpPathExecuted: false, installedAFTExecuted: false,
      liveInvocations: 3, calls: 6, results: 6, modelContexts: 9, replayInvocations: 3, replayCalls: 0,
      captures, checked: ['physical ASCII command cells', 'exact hardwrap reconstruction preserving whitespace',
        'observed allocated width', 'one inner/exterior cell on each side', 'full panel painting', 'same-session replay', 'resize back'],
    }, null, 2));
  } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
});


// Observable work counters come only from actual /toolview notifications in the live tree.
// pointer-cache-* deliberately avoids the pre-existing alternate-width dump probes.
test('real CLI: component-owned layout work counters and released retained memory',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [], snapshots = [];
    const start = async (name, options = {}, resizeTall = true) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); if (resizeTall) await terminal.resize(100, 320); return terminal;
    };
    const observe = async (terminal, name, command = '/toolview cache') => {
      await terminal.command(command);
      const dump = await terminal.capture(`pointer-cache-${name}`);
      const stats = dump.cacheDiagnostics.at(-1);
      assert.ok(stats, 'real cache command produced a JSON notification in the native tree');
      const numeric = ['retainedBytes', 'stringBytes', 'overheadBytes', 'rows', 'entries', 'hits', 'misses', 'builds', 'releases', 'collected'];
      const memory = ['retainedBytes', 'stringBytes', 'overheadBytes', 'rows', 'entries'];
      assert.deepEqual(Object.keys(stats).sort(), [...numeric, 'byKind', 'ordinary', 'cards', 'footerLayout',
        'presentationRetainedBytes', 'presentationEntries', 'presentationRows', 'memoryScope', 'processHeapUsedBytes', 'processMemoryScope'].sort());
      for (const key of [...numeric, 'presentationRetainedBytes', 'presentationEntries', 'presentationRows', 'processHeapUsedBytes'])
        assert.ok(Number.isSafeInteger(stats[key]) && stats[key] >= 0, `finite nonnegative diagnostic ${key}`);
      assert.equal(stats.processMemoryScope, 'whole Pi process, not Toolview');
      assert.match(stats.memoryScope, /estimated Toolview retained/);
      assert.ok(stats.processHeapUsedBytes > 0, 'process heap is sampled, not attributed to Toolview');
      assert.equal(stats.retainedBytes, stats.stringBytes + stats.overheadBytes);
      assert.equal(stats.presentationRetainedBytes, stats.retainedBytes + stats.footerLayout.retainedBytes);
      assert.equal(stats.presentationEntries, stats.entries + stats.footerLayout.entries);
      assert.equal(stats.presentationRows, stats.rows + stats.footerLayout.rows);
      assert.deepEqual(Object.keys(stats.byKind).sort(), ['summary', 'bash', 'edit', 'write', 'user'].sort());
      for (const group of ['ordinary', 'cards']) {
        assert.deepEqual(Object.keys(stats[group]).sort(), [...numeric, 'byKind'].sort());
        for (const key of numeric) {
          assert.ok(Number.isSafeInteger(stats[group][key]) && stats[group][key] >= 0);
          assert.equal(stats[key], stats.ordinary[key] + stats.cards[key], `aggregate ${key} equals both accounting groups`);
        }
        for (const key of memory)
          assert.equal(stats[group][key], Object.values(stats[group].byKind).reduce((total, item) => total + item[key], 0));
      }
      snapshots.push({ terminal: terminal.output, name, ...stats });
      return { dump, stats };
    };
    const delta = (before, after, builds, label) => {
      assert.equal(after.builds - before.builds, builds, `${label}: exact custom-body builds`);
      assert.equal(after.misses - before.misses, builds, `${label}: each necessary build is one miss`);
      for (const key of ['hits', 'misses', 'builds', 'releases', 'collected'])
        assert.ok(after[key] >= before[key], `${label}: ${key} remains monotonic`);
      assert.ok(after.hits > before.hits, `${label}: unchanged components actually hit the cache`);
    };
    const identity = (actual, original) => {
      assert.deepEqual(persisted(actual), persisted(original), 'UI probes never change stored arguments/results');
      assert.deepEqual(actual.branch, original.branch, 'commands and diagnostics add no session messages or entries');
      assert.deepEqual(actual.tools.map(({ id, content, details, args }) => ({ id, content, details, args })),
        original.tools.map(({ id, content, details, args }) => ({ id, content, details, args })), 'restored live results and args are exact');
    };
    try {
      const live = await start('cache-performance-live', { toolview: true,
        flags: ['--toolview-cache-mb', '1'], extraEnv: { TOOLVIEW_TEST_CACHE_DIAGNOSTICS: '1' } });
      await live.command('/toolview off');
      await live.run('cache-performance');
      const nativeLive = await live.capture('pointer-cache-native-live-original');
      await live.command('/toolview on');
      const wide = await live.capture('pointer-cache-wide');
      assert.equal(wide.bashShape, false, 'eight commands execute actual built-in bash, never shape mocks');
      assert.equal(wide.tools.length, 11);
      assert.equal(byName(wide, 'bash').length, 8);
      const activity = traffic(live, 11);
      assert.deepEqual(activity.filter((event) => event.type === 'call').map((event) => event.name),
        [...Array(8).fill('bash'), 'read', 'read', 'tv_hidden']);
      assert.ok(activity.filter((event) => event.type === 'result').every((event) => !event.isError));
      allBashCards(wide);
      for (const [index, tool] of byName(wide, 'bash').entries()) {
        const expected = Array.from({ length: 1000 }, (_, row) => `CACHE_OUTPUT_${index}_${String(row + 1).padStart(4, '0')}_ASCII_PAYLOAD`).join('\n') + '\n';
        assert.deepEqual(tool.content, [{ type: 'text', text: expected }], 'all 1000 real output lines remain exact and untruncated');
        assert.equal(tool.lines.filter((row) => plain(row).includes(`CACHE_OUTPUT_${index}_`)).length, 11,
          'command plus first ten output rows only; full-body oracle checks every character');
        assert.ok(!tool.lines.some((row) => row.includes(`CACHE_OUTPUT_${index}_0011_`)), 'eleventh row is hidden, not painted');
      }
      assert.deepEqual(byName(wide, 'tv_hidden')[0].lines, [], 'actual self-shell empty renderer remains hidden');
      for (const tool of byName(wide, 'read')) compactContent(tool);
      await panelCells(wide, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(wide, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      let { stats: previous } = await observe(live, 'warm');
      assert.equal('limitBytes' in previous, false, 'legacy launch budget does not reintroduce eviction');
      assert.equal(previous.byKind.summary.entries, 2); assert.equal(previous.byKind.user.entries, 1);
      assert.equal(previous.byKind.bash.entries, 8);
      assert.equal(previous.ordinary.entries, 3); assert.equal(previous.cards.entries, 8);
      assert.equal(wide.users.length, 1, 'one actual user message joins the ten custom tool components');
       assert.equal(previous.entries, 11, 'one latest layout per eight bash, two compact tools and one user card; hidden contributes none');
      assert.ok(previous.retainedBytes > 0 && previous.builds >= 11);
      for (const name of ['frame-one', 'frame-two', 'frame-three']) {
        const { dump, stats } = await observe(live, name);
        delta(previous, stats, 0, name);
        assert.equal(stats.entries, 11); assert.equal(stats.retainedBytes, previous.retainedBytes);
        assert.deepEqual(dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
        identity(dump, wide); previous = stats;
      }
      live.send('cache editor scratch'); await live.settle();
       const editorScreen = live.screen(); // Do not append a dump command to nonempty editor input.
       writeFileSync(join(live.output, 'pointer-cache-editor.screen.txt'), editorScreen.join('\n'));
       assert.ok(editorScreen.some((row) => row.includes('cache editor scratch')), 'actual native editor changed');
      live.send('\x15'); await live.settle();
      let measured = await observe(live, 'editor-cleared'); delta(previous, measured.stats, 0, 'native editor frames'); previous = measured.stats;
      await moveAt(live, 5, panelAt(measured.dump, 7, 'CACHE_OUTPUT_7_').command);
      measured = await observe(live, 'pointer-motion'); delta(previous, measured.stats, 0, 'native no-hover motion');
      await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_'); previous = measured.stats;

      // Use a genuinely scrollable host viewport, then establish its own warm baseline.
      await live.resize(100, 35);
      const wheel = await observe(live, 'wheel-base');
       const wheelRow = wheel.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
       assert.ok(wheelRow >= 0, 'actual bash command is visible in the small native transcript viewport');
      await sgrAt(live, 5, wheelRow, 64, false);
      assert.notDeepEqual(live.screen(), wheel.dump.screen, 'actual wheel scrolls before any new capture/notification can alter the screen');
      await live.capture('pointer-cache-wheel-scrolled');
      measured = await observe(live, 'wheel-stats'); delta(wheel.stats, measured.stats, 0, 'native wheel frames');
      assert.ok(measured.dump.tools.every((tool) => !tool.expanded));
      await live.resize(100, 320); measured = await observe(live, 'height-restored'); previous = measured.stats;

      // Update only a native component, not its persisted/model result; then exercise reused-object invalidation.
      const chosen = byName(wide, 'bash')[7];
      for (const [operation, marker] of [['replace', 'CACHE_UPDATE_REPLACED'], ['reuse', 'CACHE_UPDATE_REUSED'], ['restore', 'CACHE_OUTPUT_7_0001_ASCII_PAYLOAD']]) {
        await live.command(`/tv-cache-update ${chosen.id} ${operation}`);
        measured = await observe(live, `result-${operation}`);
        delta(previous, measured.stats, 1, `single native updateResult ${operation}`);
        const changed = measured.dump.tools.find((tool) => tool.id === chosen.id);
        assert.ok(changed.lines.some((row) => row.includes(marker)), 'actual rendered body follows the native result update');
        assert.deepEqual(measured.dump.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines),
          wide.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines), 'every other component remains byte-identical');
        assert.deepEqual(measured.dump.branch, wide.branch, 'isolated native mutation does not touch stored traffic');
        allBashCards(measured.dump); previous = measured.stats;
      }
      identity(measured.dump, wide);
      const sessionBeforeDetach = readFileSync(wide.session);
      await live.command(`/tv-cache-detach ${chosen.id} remove`);
      measured = await observe(live, 'detached-live-owner');
      delta(previous, measured.stats, 0, 'removing a retained native owner does not rebuild its neighbors');
      assert.equal(measured.stats.entries, 10); assert.equal(measured.stats.cards.entries, 7);
      assert.equal(measured.stats.releases - previous.releases, 1, 'representation is released even while the driver deliberately retains the removed component');
      assert.ok(!measured.dump.tools.some(tool => tool.id === chosen.id));
      assert.deepEqual(readFileSync(wide.session), sessionBeforeDetach);
      previous = measured.stats;
      await live.command(`/tv-cache-detach ${chosen.id} restore`);
      measured = await observe(live, 'reattached-live-owner');
      delta(previous, measured.stats, 1, 'reattachment rebuilds only the removed representation');
      assert.equal(measured.stats.entries, 11); identity(measured.dump, wide);
      assert.deepEqual(measured.dump.tools.map(tool => tool.lines), wide.tools.map(tool => tool.lines));
      assert.deepEqual(readFileSync(wide.session), sessionBeforeDetach); previous = measured.stats;
      await live.resize(24, 320); measured = await observe(live, 'narrow');
      delta(previous, measured.stats, 11, 'width resize affects ten tools and one user card once');
      assert.equal(measured.stats.entries, 11, 'width replacement does not retain historical variants');
      allBashCards(measured.dump); for (const tool of measured.dump.tools) await assertFits(tool.lines, 24);
      previous = measured.stats;
      await live.resize(100, 320); measured = await observe(live, 'wide-again');
      delta(previous, measured.stats, 11, 'resize back rebuilds exactly one latest width per component');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;
      await live.command('/tv-theme light'); measured = await observe(live, 'light');
      delta(previous, measured.stats, 11, 'theme invalidation builds each custom tool/user component once');
      allBashCards(measured.dump); await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(measured.dump, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      assert.notDeepEqual(measured.dump.tools[0].lines, wide.tools[0].lines);
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines.map(plain)), wide.tools.map((tool) => tool.lines.map(plain))); previous = measured.stats;
      await live.command('/tv-theme dark'); measured = await observe(live, 'dark'); delta(previous, measured.stats, 11, 'theme restored'); previous = measured.stats;
      const commandRow = measured.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
      assert.ok(commandRow >= 0, 'chosen expandable command is on actual screen');
      await sgrAt(live, 3, commandRow); measured = await observe(live, 'expanded-one');
      delta(previous, measured.stats, 1, 'one real normalized bash click expands only one custom component');
      assert.deepEqual(measured.dump.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [chosen.id]);
      allBashCards(measured.dump);
      assert.ok(measured.dump.screen.some((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD')), 'complete expanded tail appears on physical screen');
      assert.ok(measured.stats.retainedBytes > previous.retainedBytes, 'full expanded rendered data is accounted'); previous = measured.stats;
      const tail = measured.dump.screen.findIndex((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD'));
      await sgrAt(live, 3, tail); measured = await observe(live, 'collapsed-one');
      delta(previous, measured.stats, 1, 'whole-panel output click replaces expanded layout with preview');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;

      // Retired controls cannot evict any representation, including an explicit zero.
      for (const command of ['/toolview cache cards limit 0.02', '/toolview cache cards limit 0', '/toolview cache limit 0'])
        await live.command(command);
      measured = await observe(live, 'retired-limits-ignored');
      delta(previous, measured.stats, 0, 'retired limit commands preserve component-owned layouts');
      assert.equal(measured.stats.entries, 11); assert.equal(measured.stats.retainedBytes, previous.retainedBytes);
      allBashCards(measured.dump); identity(measured.dump, wide); previous = measured.stats;
      const clear = await observe(live, 'clear', '/toolview cache clear');
      assert.equal(clear.stats.entries, 0); assert.equal(clear.stats.retainedBytes, 0);
      assert.equal(clear.stats.builds, previous.builds, 'clear releases data before any next-frame builds');
      measured = await observe(live, 'clear-cold'); delta(previous, measured.stats, 11, 'clear causes exactly one on-demand rebuild per custom tool/user component');
      assert.equal(measured.stats.entries, 11); identity(measured.dump, wide);

      const session = wide.session;
      const native = await start('cache-performance-native', { session, workspace: live.work });
      const control = await native.capture('pointer-cache-native');
      assert.deepEqual(control.branch, wide.branch); identity(control, wide);
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(native.events().filter((event) => event.type === type).length, 0, `native replay emits no ${type}`);
      await live.command('/toolview off'); const off = await observe(live, 'off');
      assert.equal(off.stats.entries, 0); assert.equal(off.stats.retainedBytes, 0);
      const nativeRows = off.dump.tools.map((tool) => tool.lines);
      assert.deepEqual(off.dump.tools.map((tool) => tool.lines), nativeLive.tools.map((tool) => tool.lines),
        'off restores the original same-live native bodies byte-for-byte, including real unpersisted timing');
      await live.command('/toolview on'); const on = await observe(live, 'on-cold');
      assert.equal(on.stats.builds, 11, 'new controller starts cold and builds ten tool bodies plus one user card once');
      assert.equal(on.stats.entries, 11); identity(on.dump, wide);
      assert.deepEqual(on.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      const onWarm = await observe(live, 'on-warm'); delta(on.stats, onWarm.stats, 0, 'reenabled steady frames');
      await live.command('/toolview off'); const offAgain = await live.capture('pointer-cache-off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), nativeRows, 'same live native bodies are restored byte-for-byte');
      // Compare reconstructed native bodies with reconstructed native control; neither has unpersisted live durations.
      await live.command('/reload'); await live.command('/toolview off');
      const reloadedNative = await live.capture('pointer-cache-reloaded-native');
      assert.deepEqual(reloadedNative.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines),
        'native history after reload matches same-session stock replay byte-for-byte without normalization');
      identity(reloadedNative, wide);
      await live.command('/toolview on'); const final = await observe(live, 'final'); identity(final.dump, wide);
      assert.deepEqual(traffic(live, 11), activity, 'all editor/pointer/resize/theme/cache commands preserve eleven calls/results and twelve model contexts exactly');
      await live.close();
      const replay = await start('cache-performance-replay', { toolview: true, session, workspace: live.work, flags: ['--toolview-cache-mb', '1'] }, false);
      const resumed = await observe(replay, 'replayed'); identity(resumed.dump, wide);
      assert.equal(resumed.stats.entries, 11);
      assert.deepEqual(resumed.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); allBashCards(resumed.dump);
      // Pi asynchronously invalidates its whole tree after startup syntax-grammar loading.
      // Measure an explicit cold epoch instead of attributing all bootstrap work to one frame.
      const replayClear = await observe(replay, 'replay-clear', '/toolview cache clear');
      assert.equal(replayClear.stats.entries, 0); assert.equal(replayClear.stats.retainedBytes, 0);
      const replayCold = await observe(replay, 'replay-cold');
      delta(replayClear.stats, replayCold.stats, 11, 'explicit replay cold epoch builds exactly ten tool bodies plus one user card once');
      assert.equal(replayCold.stats.entries, 11); identity(replayCold.dump, wide);
      const replayWarm = await observe(replay, 'replay-warm'); delta(replayCold.stats, replayWarm.stats, 0, 'actual same-session replay warm frames');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `Toolview replay emits no ${type}`);
      const regular = await start('cache-performance-regular-replay', { toolview: true, mode: 'regular', session, workspace: live.work });
      const regularBase = await observe(regular, 'regular-base'); identity(regularBase.dump, wide);
      assert.equal(regularBase.stats.entries, 11);
      assert.deepEqual(regularBase.dump.tools.map(tool => tool.lines), wide.tools.map(tool => tool.lines));
      const regularWarm = await observe(regular, 'regular-warm'); delta(regularBase.stats, regularWarm.stats, 0, 'regular replay unchanged frame');
      const regularClear = await observe(regular, 'regular-clear', '/toolview cache clear');
      assert.equal(regularClear.stats.presentationEntries, 0);
      const regularCold = await observe(regular, 'regular-cold'); delta(regularClear.stats, regularCold.stats, 11, 'regular replay clear rebuild');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(regular.events().filter(event => event.type === type).length, 0, `regular replay emits no ${type}`);
      assert.deepEqual(readFileSync(session), sessionBeforeDetach);
      writeFileSync(join(artifacts, 'cache-performance-coverage.json'), JSON.stringify({
        builtInBash: true, installedAFTExecuted: false, calls: 11, results: 11, modelContexts: 12,
        bashCalls: 8, fullOutputLinesPerBash: 1000, customComponents: 11, userCards: 1, hiddenNativeComponents: 1,
        replayCalls: 0, replayResults: 0, replayModelContexts: 0, snapshots,
        checked: ['exact independent body oracle', 'physical panel/theme/output cells', 'native wheel/editor/no-hover frames',
          'single native result replacement/reused-object/restore', 'remove retained live owner/release/reinsert exact child order', 'one latest width', 'theme rebuild counts', 'one native bash click expansion/collapse',
          'regular/fullscreen replay warm and clear counters', 'retired byte/zero limits cannot evict component layouts', 'presentation-kind and footer memory estimates', 'clear cold rebuild', 'off release/on cold', 'native/replay/session/model identity'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

// Actual user-message renderer, no synthetic message components or source-text renderer replacement.
test('real CLI: user cards share Bash geometry with customMessageLabel and preserve native Markdown',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [], extraEnv = { TOOLVIEW_TEST_USER_CARDS: '1' };
    const source = 'run user-card\n\nUSER_CARD_PLAIN\n\n**bold** and `inline`\n\n7. seven\n8. eight\n\n> quote\n\n```ts\nconst userValue = 7;\n```\n\n[link](https://example.org) \\*literal\\* 文字 👩‍💻\n\nUSER_CARD_END';
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv, ...options }); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 180); return terminal;
    };
    const run = async (terminal) => {
      terminal.send('\x1b[200~' + source + '\x1b[201~\r');
      await terminal.event('agent_end'); await terminal.settle();
      assert.ok(terminal.screen().some((row) => row.includes('TERMINAL_DONE_user-card')));
    };
    const observed = (terminal) => {
      const events = terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
      assert.equal(events.filter((event) => event.type === 'call').length, 2);
      assert.equal(events.filter((event) => event.type === 'result').length, 2);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 3);
      assert.ok(events.filter((event) => event.type === 'model_context').every((event) => event.user === source),
        'Markdown transformations and framing never change model-facing user bytes');
      return events;
    };
    const body = (rows, start, width) => rows.slice(1, -1).map((row) => stripVTControlCharacters(sliceByColumn(row, start, width)));
    const check = async (dump, native) => {
      assert.equal(dump.users.length, 1); assert.equal(dump.users[0].text, source);
      const user = dump.users[0], geometry = bashGeometry(dump.width);
      const rows = user.lines.filter((row) => row !== '');
      assert.ok(rows[0].startsWith('\x1b]133;A\x07'));
      assert.ok(rows.at(-1).startsWith('\x1b]133;B\x07\x1b]133;C\x07'));
      assert.deepEqual(body(rows, geometry.origin, geometry.content),
        body(native.users[0].contentControl, native.users[0].outputPad, geometry.content),
        'complete Markdown body matches the actual native renderer at the same content width');
      await assertFits(rows, dump.width);
      const expected = rows.map(plain);
      const y = dump.screen.findIndex((_, index) => expected.every((row, offset) =>
        dump.screen[index + offset] !== undefined && plain(dump.screen[index + offset]) === row));
      assert.ok(y >= 0, 'complete user card is physically painted, including all Markdown rows');
      const border = await referenceCell(dump.frameStyles.userBorder), bg = await referenceCell(dump.backgroundStyles.userMessageBg);
      for (let offset = 0; offset < rows.length; offset++) {
        const cells = dump.cells[y + offset];
        assert.equal(cells[1].text, '┃');
        assert.deepEqual({ fg: cells[1].fg, mode: cells[1].fgMode }, { fg: border.fg, mode: border.fgMode });
        assert.equal(cells[1].bgMode, 0, 'user stripe stays on terminal-default background');
        for (const x of [0, dump.width - 1]) {
          assert.ok(!cells[x].text.trim()); assert.equal(cells[x].bgMode, 0, 'outside margins remain unpainted');
        }
        for (let x = 2; x < dump.width - 1; x++)
          assert.deepEqual({ bg: cells[x].bg, mode: cells[x].bgMode }, { bg: bg.bg, mode: bg.bgMode });
        for (const x of [2, dump.width - 2]) assert.equal(cells[x].text, ' ');
      }
      // Compare actual foreground/attributes of every body glyph with native Markdown,
      // not only its plain text. Match Pi's per-line style reset in the independent screen oracle.
      const controlWidth = geometry.content + 2 * native.users[0].outputPad;
      const oracle = new Terminal({ cols: controlWidth, rows: rows.length + 1, allowProposedApi: true });
      try {
        await new Promise((done) => oracle.write(native.users[0].contentControl
          .map((row) => row + '\x1b[0m\x1b]8;;\x1b\\').join('\r\n'), done));
        for (let offset = 1; offset < rows.length - 1; offset++) for (let x = 0; x < geometry.content; x++) {
          const actual = dump.cells[y + offset][geometry.origin + x];
          if (!actual.text.trim()) continue;
          const expectedCell = oracle.buffer.active.getLine(offset).getCell(native.users[0].outputPad + x);
          assert.deepEqual({ fg: actual.fg, mode: actual.fgMode, dim: actual.dim, bold: actual.bold,
            italic: actual.italic, underline: actual.underline },
          { fg: expectedCell.getFgColor(), mode: expectedCell.getFgColorMode(), dim: expectedCell.isDim(),
            bold: expectedCell.isBold(), italic: expectedCell.isItalic(), underline: expectedCell.isUnderline() },
          'every body glyph retains native Markdown foreground and attributes');
        }
      } finally { oracle.dispose(); }
      const plainY = dump.screen.findIndex((row) => row.includes('USER_CARD_PLAIN'));
      const text = await referenceCell(dump.summaryStyles.userMessageText), cell = dump.cells[plainY][3];
      assert.deepEqual({ fg: cell.fg, mode: cell.fgMode }, { fg: text.fg, mode: text.fgMode });
      for (const offset of [0, rows.length - 1])
        for (let x = 2; x < dump.width - 1; x++) assert.equal(dump.cells[y + offset][x].text, ' ');
      assert.ok(dump.screen.some((row) => row.includes('TRANSFORMED_USER')));
      assert.equal(dump.extensionIssues.length, 0);
      allBashCards(dump); compactContent(byName(dump, 'read')[0]);
      return plainY;
    };
    try {
      const stock = await start('user-stock'); await run(stock);
      let native = await stock.capture('native-user-wide');
      const live = await start('user-live', { toolview: true, workspace: stock.work }); await run(live);
      let wide = await live.capture('pointer-user-wide');
      assert.deepEqual(observed(live), observed(stock)); assert.deepEqual(persisted(wide), persisted(native));
      await check(wide, native);
      const sessionBytes = readFileSync(wide.session), activity = observed(live);
      const warm = wide.userWork.transforms;
      for (const name of ['warm-one', 'warm-two']) {
        const same = await live.capture(`pointer-user-${name}`);
        assert.equal(same.userWork.transforms, warm, 'unchanged real frames do no Markdown transform work');
        assert.deepEqual(same.users, wide.users);
      }
      const y = wide.screen.findIndex((row) => row.includes('USER_CARD_PLAIN'));
      await sgrAt(live, 3, y, 0, false); await sgrAt(live, 13, y, 32, false);
      live.send(`\x1b[<0;14;${y + 1}m`); await live.settle();
      const selected = await live.capture('pointer-user-selection');
      assert.equal(selected.selectionActive, true, 'user text remains selectable through native drag handling');
      assert.deepEqual(selected.users, wide.users); assert.ok(selected.tools.every((tool) => !tool.expanded));
      const copies = [...Buffer.concat(live.raw).toString('utf8').matchAll(/\x1b\]52;c;([^\x07]*)(?:\x07)/gu)]
        .map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
      assert.deepEqual(copies, ['USER_CARD_P'], 'native clipboard receives exactly the selected visual user text');
      await sgrAt(live, 0, y);
      // The native copy toast briefly overlays the first padding row; wait for it,
      // never weaken the complete-card or physical-cell assertions around that overlay.
      await until(() => !live.screen().some((row) => row.includes('Copied!')), 'native copy toast dismissed');
      const cleared = await live.capture('pointer-user-selection-cleared');
      assert.equal(cleared.selectionActive, false); await check(cleared, native);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('pointer-user-expanded');
      assert.deepEqual(expanded.users, wide.users, 'native tool expansion never changes user presentation');
      live.send('\x0f'); await live.settle();
      for (const width of [24, 60, 100]) {
        await stock.resize(width, 180); native = await stock.capture(`native-user-width-${width}`);
        await live.resize(width, 180); await check(await live.capture(`pointer-user-width-${width}`), native);
      }
      for (const name of ['light', 'dark']) {
        await stock.command(`/tv-theme ${name}`); native = await stock.capture(`native-user-${name}`);
        await live.command(`/tv-theme ${name}`); await check(await live.capture(`pointer-user-${name}`), native);
      }
      await live.command('/toolview off');
      const disabled = await live.capture('native-user-disabled');
      assert.deepEqual(disabled.users, native.users, 'off restores native user rows and padding byte-for-byte');
      await live.command('/toolview on'); wide = await live.capture('pointer-user-on'); await check(wide, native);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('pointer-user-reloaded'); await check(reloaded, native);
      assert.deepEqual(reloaded.users, wide.users); assert.deepEqual(observed(live), activity);
      assert.deepEqual(readFileSync(wide.session), sessionBytes, 'all UI probes preserve exact session bytes');
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`user-replay-${mode}`, { toolview: true, session: wide.session, workspace: live.work, mode });
        const resumed = await replay.capture(`pointer-user-replayed-${mode}`); await check(resumed, native);
        assert.deepEqual(resumed.users, reloaded.users); assert.deepEqual(resumed.branch, reloaded.branch);
        for (const type of ['call', 'result', 'model_context']) assert.equal(replay.events().filter((event) => event.type === type).length, 0);
      }
      writeFileSync(join(artifacts, 'user-card-coverage.json'), JSON.stringify({ calls: 2, results: 2, modelContexts: 3,
        actualNativeMarkdown: true, transformsPreserved: true, userSourceBytesUnchanged: true,
        physicalWidths: [24, 60, 100], themes: ['dark', 'light'], modes: ['fullscreen', 'regular'],
        checks: ['full native content-width equality', 'customMessageLabel stripe', 'userMessageBg/userMessageText',
          'OSC 133 zones', 'native selection and Ctrl+O', 'warm transform work', 'off/on/reload', 'same-session replay and bytes'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: OpenCode-style edit syntax, numbered unified/split format, errors and exact replay',
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv: { TOOLVIEW_TEST_EDIT_CARDS: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 160); return terminal;
    };
    const run = async (terminal) => {
      const turn = terminal.events().filter((event) => event.type === 'agent_end').length;
      terminal.send('run edit-cards\r'); await terminal.event('provider_gate');
      const pending = await terminal.capture('pending', { animated: true });
      assert.equal(pending.tools.length, 1);
      assert.equal(pending.tools[0].executionStarted, false);
      writeFileSync(join(terminal.output, 'provider-go'), 'go');
      await terminal.event('edit_execution_gate');
      const running = await terminal.capture('edit-running', { animated: true });
      assert.equal(running.tools[0].executionStarted, true);
      assert.equal(running.tools[0].partial, true);
      assert.equal(terminal.events().filter((event) => event.type === 'call').length, 1);
      assert.equal(terminal.events().filter((event) => event.type === 'result').length, 0);
      writeFileSync(join(terminal.output, 'edit-execution-go'), 'go');
      await terminal.event('agent_end', turn + 1); await terminal.settle(); return { pending, running };
    };
    const traffic = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((event) => event.type === 'call').length, 7);
      assert.equal(events.filter((event) => event.type === 'result').length, 7);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 8);
      assert.deepEqual(events.filter((event) => event.type === 'result').map((event) => !!event.isError), [false, false, true, true, false, false, false]);
      return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    let checkedSyntaxCells = 0, checkedPanelCells = 0;
    const reference = new Terminal({ cols: 100, rows: 4, allowProposedApi: true });
    const fg = async (dump, role) => {
      reference.reset(); await new Promise((done) => reference.write(dump.summaryStyles[role], done));
      const cell = reference.buffer.active.getLine(0).getCell(0);
      return { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim() };
    };
    const check = async (dump, split) => {
      assert.equal(dump.tools.length, 7);
      const first = dump.tools[0], second = dump.tools[1];
      const rows = lines(first);
      assert.ok(rows.some((row) => row.includes('← Edited edit-example.ts')));
      assert.doesNotMatch(rows.join('\n'), /@@|---|No newline|Click to expand/);
      for (const index of [0, 1, 2, 8, 9, 10, 15, 16, 17]) assert.ok(rows.some((row) => row.includes(`const context${index} =`)), 'three following/preceding logical context rows remain visible');
      for (const index of [3, 11, 14]) assert.ok(!rows.some((row) => row.includes(`const context${index} =`)), 'fourth context row on each side is omitted');
      assert.equal(rows.filter((row) => /^…(?:\s+…)?$/.test(row.slice(3).trim())).length, 1, 'interior omitted interval remains visible between distant TypeScript changes');
      const physical = dump.screen.map(plain);
      const matched = physical.findIndex((row, y) => row === rows[0] && rows.every((value, offset) => physical[y + offset] === value));
      assert.ok(matched >= 0, 'the full numbered diff card exists on the physical screen, not only a manual render');
      const oldRow = rows.findIndex((row) => row.includes('export const before = 10;'));
      const newRow = rows.findIndex((row) => row.includes('export const after = 20;'));
      assert.equal(oldRow === newRow, split, 'real screen switches from stacked to horizontally paired old/new lines');
      assert.match(rows[oldRow], /1 - export const before/);
      assert.match(rows[newRow], /1 \+ export const after/);
      const syntax = async (rowIndex, text, role) => {
        const column = rows[rowIndex].indexOf(text); assert.ok(column >= 0, `${text} exists`);
        const actual = dump.cells[matched + rowIndex][column];
        assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim }, await fg(dump, role), `${text} retains ${role} inside edit source`);
        checkedSyntaxCells++; return actual;
      };
      const keyword = await syntax(oldRow, 'export', 'syntaxKeyword');
      const oldNumber = await syntax(oldRow, '10', 'syntaxNumber');
      const newNumber = await syntax(newRow, '20', 'syntaxNumber');
      assert.notEqual(keyword.fg, oldNumber.fg, 'code is syntax-highlighted, not uniformly red');
      assert.equal(keyword.bg, oldNumber.bg);
      assert.notEqual(oldNumber.bg, newNumber.bg, 'red/green backgrounds are independent of syntax foreground');
      assert.notEqual(oldNumber.bgMode, 0); assert.notEqual(newNumber.bgMode, 0);
      const oldLabel = rows.findIndex((row) => row.includes('const label = "old";'));
      const newLabel = rows.findIndex((row) => row.includes('const label = "new";'));
      await syntax(oldLabel, '"old"', 'syntaxString'); await syntax(newLabel, '"new"', 'syntaxString');
      const functionRow = rows.findIndex((row) => row.includes('function greet'));
      await syntax(functionRow, 'greet', 'syntaxFunction'); await syntax(functionRow, 'string', 'syntaxType');
      await syntax(rows.findIndex((row) => row.includes('continued comment')), 'continued comment', 'syntaxComment');
      await syntax(rows.findIndex((row) => row.includes('continued template')), 'continued template', 'syntaxString');
      const oldSign = await syntax(oldRow, '-', 'toolDiffRemoved'), newSign = await syntax(newRow, '+', 'toolDiffAdded');
      const titleRow = rows.findIndex((row) => row.includes('← Edited edit-example.ts'));
      const panel = dump.cells[matched + titleRow][2];
      assert.equal(panel.bgMode, 0x3000000, 'physical panel supplies the RGB base for Multiply');
      assert.equal(dump.cells[matched + oldRow][2].bg, panel.bg, 'one neutral left padding cell before diff');
      assert.equal(dump.cells[matched + oldRow][3].bg, oldSign.bg, 'changed gutter begins at content origin without an extra diff inset');
      assert.notEqual(oldSign.bg, panel.bg);
      assert.notEqual(dump.cells[matched + oldRow][dump.width - 3].bg, panel.bg, 'changed diff fills the last content cell');
      assert.equal(dump.cells[matched + oldRow][dump.width - 2].bg, panel.bg, 'one neutral right padding cell after diff');
      const rgb = (value) => [value >>> 16, (value >>> 8) & 255, value & 255];
      for (const [code, sign] of [[oldNumber, oldSign], [newNumber, newSign]]) {
        assert.equal(sign.fgMode, 0x3000000, 'diff role supplies a concrete RGB overlay');
        const base = rgb(panel.bg), overlay = rgb(sign.fg);
        for (const [cell, alpha] of [[code, 0.16], [sign, 0.26]]) {
          assert.equal(cell.bgMode, 0x3000000);
          const expected = base.map((channel, index) => Math.round(channel * (1 - alpha + alpha * overlay[index] / 255)));
          assert.deepEqual(rgb(cell.bg), expected, 'physical edit backgrounds use exact 16%/26% Multiply');
          assert.ok(rgb(cell.bg).every((channel, index) => channel <= base[index]), 'no physical background channel is brighter than the panel');
        }
      }
      for (const tool of [first, second, ...dump.tools.slice(4)]) {
        await assertFits(tool.lines, dump.width);
        const block = lines(tool);
        const heading = block.findIndex((row) => row.includes('← Edited'));
        assert.equal(block[heading].indexOf('←'), 3, 'edit title shares the physical Bash-description content origin');
        const sourceRows = block.slice(heading + 2, -1).map((row) => row.slice(3).trim()).filter(Boolean);
        assert.ok(sourceRows.length);
        assert.doesNotMatch(sourceRows[0], /^…(?:\s+…)?$/, 'no leading omission marker');
        assert.doesNotMatch(sourceRows.at(-1), /^…(?:\s+…)?$/, 'no trailing omission marker');
        const start = physical.findIndex((row, y) => row === block[0] && block.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0, 'each complete diff card is present on the physical screen');
        for (let y = 0; y < block.length; y++) {
          if (block[y][1] !== '┃') continue; // Exclude native adaptive separators.
          const cells = dump.cells[start + y];
          for (let x = 2; x < dump.width - 1; x++) {
            assert.equal(cells[x].bgMode, 0x3000000, 'nested diff resets cannot expose page background inside any panel cell');
            checkedPanelCells++;
          }
          assert.equal(cells[dump.width - 2].bg, panel.bg, 'last internal right padding cell keeps the neutral card background');
          assert.equal(cells[dump.width - 1].bgMode, 0, 'exterior right margin stays page-colored');
        }
      }
      for (const [index, sign, code] of [[5, '+', 'const addOnly = 4;'], [6, '-', 'const removeOnly = 2;']]) {
        const tool = dump.tools[index], block = lines(tool);
        assert.equal(block.join('\n').split('const retained = 1;').length - 1, 1, 'one-sided context is unified even at wide widths');
        const sourceIndex = block.findIndex(row => row.includes(code)), source = block[sourceIndex];
        assert.ok(source); assert.ok(source.includes(`${index === 5 ? 2 : 3} ${sign} ${code}`), 'original changed line numbers/signs are preserved');
        assert.ok(source.indexOf(code) < dump.width / 2, 'addition/removal both use the left unified gutter');
        assert.ok(tool.details.diff.split('\n').some(row => row.startsWith(sign)));
        assert.ok(!tool.details.diff.split('\n').some(row => row.startsWith(sign === '+' ? '-' : '+')), 'actual persisted diff is one-sided');
        const start = physical.findIndex((row, y) => row === block[0] && block.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0);
        const keyword = dump.cells[start + sourceIndex][source.indexOf('const')];
        assert.deepEqual({ fg: keyword.fg, fgMode: keyword.fgMode, dim: keyword.dim }, await fg(dump, 'syntaxKeyword'));
        checkedSyntaxCells++;
        assert.equal(dump.cells[start + sourceIndex][dump.width - 3].bg, keyword.bg, 'changed unified background fills the whole content width, with no empty half-pane');
      }
      const html = lines(dump.tools[4]);
      assert.ok(!html.some((row) => row.includes('charset="utf-8"')), 'HTML fourth preceding context line is omitted');
      assert.ok(!html.some((row) => row.includes('</html>')), 'HTML fourth following context line is omitted');
      const htmlStart = physical.findIndex((row, y) => row === html[0] && html.every((value, offset) => physical[y + offset] === value));
      const link = html.findIndex((row) => row.includes('<link rel="stylesheet"'));
      const body = html.findIndex((row) => row.includes('<body>'));
      assert.ok(link >= 0 && body > link);
      if (split) {
        assert.ok(body > link + 2, 'the HTML replacement has unmatched removed rows before the next context');
        const rightX = 3 + Math.floor((dump.width - 5) / 2);
        let emptyRows = 0;
        for (let y = link + 1; y < body; y++) {
          if (html[y].slice(rightX, dump.width - 2).trim()) continue;
          emptyRows++;
          for (let x = rightX; x < dump.width - 2; x++) assert.equal(dump.cells[htmlStart + y][x].bg, panel.bg, 'empty added-side counterparts use card background, never page background');
        }
        assert.ok(emptyRows > 0, 'actual HTML output exercises blank right-hand counterparts');
      }
      const tail = lines(second).filter((row) => row.includes('const tail = 40;'));
      assert.equal(tail.length, 1, 'wrapped replacement does not duplicate the next context row');
      if (split) assert.equal(tail[0].match(/const tail = 40;/g)?.length, 2, 'unequal wrapped panes realign the following context');
      for (const failed of [dump.tools[2], dump.tools[3]]) {
        compactContent(failed);
        assert.doesNotMatch(lines(failed).join(''), /┃|← Edited|Could not find|ENOENT/);
        const failureRows = lines(failed);
        const y = physical.findIndex((row, index) => row === failureRows[0] && failureRows.every((value, offset) => physical[index + offset] === value));
        assert.ok(y >= 0, 'the complete failed edit summary exists on the physical screen');
        for (let offset = 0; offset < failureRows.length; offset++) for (const cell of dump.cells[y + offset]) {
          if (!cell.text.trim()) continue;
          assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await fg(dump, 'error'));
        }
      }
    };
    try {
      const stock = await start('edit-stock'); await run(stock); const native = await stock.capture('native');
      assert.ok(native.nativeRenderCalls.edit > 0, 'stock control proves the native counter is active');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const live = await start('edit-toolview', { toolview: true, workspace: stock.work });
      // Recreate only the four owned fixture inputs; no runtime package or project file is modified.
      const { pending, running } = await run(live);
      for (const dump of [pending, running]) assert.equal(dump.nativeRenderCalls.edit ?? 0, 0, 'stock edit streaming/execution performs no native visibility render');
      compactContent(pending.tools[0]);
      assert.match(lines(pending.tools[0]).join(''), /← edit edit-example.ts/);
      assert.doesNotMatch(lines(pending.tools[0]).join(''), /┃|← Edited/);
      assert.match(lines(running.tools[0]).join(''), /^[\s]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] edit edit-example.ts/);
      assert.doesNotMatch(lines(running.tools[0]).join(''), /┃|← Edited/);
      const wide = await live.capture('unified'); await check(wide, false);
      assert.equal(wide.nativeRenderCalls.edit ?? 0, 0, 'five cards and two failed summaries never build discarded native rows');
      assert.deepEqual(traffic(live), traffic(stock), '7 actual calls/results and 8 provider contexts are identical');
      assert.deepEqual(persisted(wide), persisted(native), 'the renderer never changes persisted diff/proposal/error bytes');
      const sessionBytes = readFileSync(wide.session);
      await live.resize(140, 160); const split = await live.capture('split'); await check(split, true);
      await live.resize(141, 160); await check(await live.capture('split-odd'), true);
      await live.command('/tv-theme light'); await check(await live.capture('split-light'), true);
      await live.resize(24, 160); const narrow = await live.capture('narrow');
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      await live.resize(100, 160); await live.command('/tv-theme dark');
      const unified = await live.capture('unified-again'); await check(unified, false);
      assert.equal(unified.nativeRenderCalls.edit ?? 0, 0, 'resize/theme changes do not reinstate native visibility work');
      assert.deepEqual(toolLines(unified), toolLines(wide), 'resize/theme round trip retains complete code and styling');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded), 'Ctrl+O exposes the unchanged full native presentation');
      assert.ok(expanded.nativeRenderCalls.edit > 0, 'expansion still visits the actual native renderer');
      live.send('\x0f'); await live.settle();
      const successful = await live.capture('before-successful-click');
      const successY = successful.screen.findIndex((row) => row.includes('← Edited edit-example.ts') && row.includes('┃'));
      assert.ok(successY >= 0);
      live.send(`\x1b[<0;8;${successY + 1}M\x1b[<0;8;${successY + 1}m`); await live.settle();
      const successClicked = await live.capture('successful-click');
      assert.equal(successClicked.tools[0].expanded, true, 'a real completed diff-panel click expands only that edit');
      assert.equal(successClicked.tools[1].expanded, false);
      assert.deepEqual(successClicked.tools[0].lines, nativeExpanded.tools[0].lines);
      live.send('\x0f'); await live.settle(); live.send('\x0f'); await live.settle();
      const failed = await live.capture('before-failed-click');
      const failedRows = lines(failed.tools[2]);
      const y = failed.screen.map(plain).findIndex((row, index) => row === failedRows[0] && failedRows.every((value, offset) => plain(failed.screen[index + offset] ?? '') === value));
      assert.ok(y >= 0);
      live.send(`\x1b[<0;8;${y + 1}M\x1b[<0;8;${y + 1}m`); await live.settle();
      const clicked = await live.capture('failed-click'); assert.equal(clicked.tools[2].expanded, true);
      assert.deepEqual(clicked.tools[2].lines, nativeExpanded.tools[2].lines, 'click exposes native failure details');
      // Ctrl+O is still the host's global expansion toggle.
      live.send('\x0f'); await live.settle(); live.send('\x0f'); await live.settle();
      await live.command('/toolview off'); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      await live.command('/toolview on'); await check(await live.capture('on'), false);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1); const reloaded = await live.capture('reload'); await check(reloaded, false);
      await live.command('/toolview cache'); const warm = await live.capture('warm');
      await live.command('/toolview cache'); const warmAgain = await live.capture('warm-again');
      assert.equal(warmAgain.cacheDiagnostics.at(-1).builds, warm.cacheDiagnostics.at(-1).builds, 'warm CLI frames do not rebuild/re-highlight edit layouts');
      assert.equal(warmAgain.nativeRenderCalls.edit ?? 0, 0, 'reload resets fixture counters and warm custom frames still skip native rows');
      assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(readFileSync(wide.session), sessionBytes);
      await live.close();
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`edit-replay-${mode}`, { toolview: true, session: wide.session, workspace: stock.work, mode });
        const resumed = await replay.capture('replayed'); await check(resumed, false);
        assert.deepEqual(toolLines(resumed), toolLines(wide)); assert.deepEqual(persisted(resumed), persisted(wide));
        assert.equal(resumed.nativeRenderCalls.edit ?? 0, 0, `${mode} replay uses the native-free custom path`);
      }
      // Native live calls have an async preview; native replay does not recompute it.
      // Compare the explicit override with unpatched Pi replaying the identical session.
      const stockReplay = await start('edit-stock-replay', { session: wide.session, workspace: stock.work });
      const nativeReplayed = await stockReplay.capture('native-replay');
      const optedOut = await start('edit-native-override', { toolview: true, session: wide.session, workspace: stock.work, flags: ['--toolview-card', 'edit'] });
      assert.deepEqual(toolLines(await optedOut.capture('native-override')), toolLines(nativeReplayed));
      const compactEdit = await start('edit-compact-override', { toolview: true, session: wide.session, workspace: stock.work, flags: ['--toolview-compact', 'edit'] });
      for (const tool of (await compactEdit.capture('compact-override')).tools) compactContent(tool);
      writeFileSync(join(artifacts, 'edit-coverage.json'), JSON.stringify({ calls: 7, results: 7, modelContexts: 8,
        oneSidedUnified: ['addition-only', 'removal-only'],
        checkedSyntaxCells, checkedPanelCells, widths: [24, 100, 140, 141], modes: ['fullscreen', 'regular'], themes: ['dark', 'light'],
        format: 'Ordinary compact edit while arguments stream/execute; wholly error-colored failed summaries; final successes use Bash-aligned Edited diff cards with context3 and symmetric padding',
        identity: 'exact traffic, persisted metadata and unchanged session bytes',
        cache: 'zero extra warm-frame builds; no alternate-width diagnostic probes',
        nativeWork: 'zero native edit renders while custom (pending/running/failure/success/resize/theme/reload/replay); stock/expanded controls are positive',
        scope: 'actual built-in edit; no installed AFT execution or pixel-perfect OpenCode screenshot claim' }, null, 2));
    } finally {
      reference.dispose();
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });


test('real CLI: minified edit keeps linear ANSI size, warm work, exact traffic and replay',
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [], snapshots = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv: { TOOLVIEW_TEST_EDIT_PERFORMANCE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const traffic = (terminal) => {
      const events = terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
      for (const [type, count] of [['call', 2], ['result', 2], ['model_context', 3]])
        assert.equal(events.filter((event) => event.type === type).length, count);
      return events;
    };
    const check = (dump, stacked = true) => {
      assert.equal(dump.tools.length, 2); assert.equal(dump.extensionIssues.length, 0);
      const edit = dump.tools[0], rows = lines(edit);
      assert.ok(rows.some((row) => row.includes('← Edited edit-minified.ts')));
      const sourceUnits = edit.details.patch.length;
      const chars = edit.lines.reduce((sum, row) => sum + row.length, 0);
      assert.ok(chars < sourceUnits * 20, `${chars} rendered units for ${sourceUnits} patch units`);
      if (stacked) {
        const old = rows.findIndex((row) => /1 - x/.test(row)), next = rows.findIndex((row) => /1 \+ x/.test(row));
        assert.ok(old >= 0 && next > old);
        // `lines()` already removes right padding; skip only stripe/padding and the numbered gutter.
        const code = (section) => section.map((row) => row.slice(8)).join('');
        assert.equal(code(rows.slice(old, next)), 'x+=1;'.repeat(3200), 'every removed source character remains');
        assert.equal(code(rows.slice(next, -1)), 'x+=2;'.repeat(3200), 'every added source character remains');
      }
      assert.ok(dump.screen.some((row) => row.includes('x+=2;')), 'real terminal viewport contains the long diff');
      snapshots.push({ width: dump.width, sourceUnits, renderedUnits: chars, rows: rows.length });
      return chars;
    };
    const observe = async (terminal, name) => {
      await terminal.command('/toolview cache');
      const dump = await terminal.capture(`pointer-minified-${name}`), stats = dump.cacheDiagnostics.at(-1);
      assert.ok(stats);
      assert.equal('limitBytes' in stats, false, 'component-owned diffs have no admission or byte limit');
      assert.equal(stats.byKind.edit.entries, 1, 'memory is attributed to the rendered edit representation');
      assert.equal(stats.cards.entries, 1, 'the actual minified diff is retained in the card pool');
      return { dump, stats };
    };
    try {
      const stock = await start('minified-stock'); await stock.run('edit-performance');
      const native = await stock.capture('native-minified');
      const live = await start('minified-live', { toolview: true, workspace: stock.work }); await live.run('edit-performance');
      const wide = await live.capture('pointer-minified-wide'); check(wide);
      assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(persisted(wide), persisted(native));
      const bytes = readFileSync(wide.session);
      const warm = await observe(live, 'warm'); check(warm.dump);
      const again = await observe(live, 'again'); check(again.dump);
      assert.equal(again.stats.builds, warm.stats.builds, 'unchanged real frames do no custom rebuilds');
      assert.equal(again.stats.cards.entries, 1); assert.equal(again.stats.cards.retainedBytes, warm.stats.cards.retainedBytes,
        'unchanged minified body remains retained with no admission-limit exception');
      for (const width of [140, 100]) {
        await live.resize(width); check(await live.capture(`pointer-minified-width-${width}`), width <= 120);
      }
      await live.command('/tv-theme light'); check(await live.capture('pointer-minified-light'));
      await live.command('/tv-theme dark'); const dark = await live.capture('pointer-minified-dark'); check(dark);
      const numeric = dark.cells.flat().filter((cell) => cell?.text === '2');
      const reference = new Terminal({ cols: 4, rows: 2, allowProposedApi: true });
      try {
        await new Promise((done) => reference.write(dark.summaryStyles.syntaxNumber, done));
        const expected = reference.buffer.active.getLine(0).getCell(0);
        assert.ok(numeric.some((cell) => cell.fg === expected.getFgColor() && cell.fgMode === expected.getFgColorMode()),
          'wrapped minified numbers retain native syntax foreground on the physical screen');
      } finally { reference.dispose(); }
      assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(readFileSync(wide.session), bytes);
      await live.close();
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`minified-replay-${mode}`, { toolview: true, session: wide.session, workspace: stock.work, mode });
        const resumed = await replay.capture('pointer-minified-replayed'); check(resumed);
        assert.deepEqual(toolLines(resumed), toolLines(wide)); assert.deepEqual(persisted(resumed), persisted(wide));
        assert.equal(replay.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      }
      writeFileSync(join(artifacts, 'edit-performance-coverage.json'), JSON.stringify({ calls: 2, results: 2, modelContexts: 3,
        componentOwnedRetention: true, warmBuildsBefore: warm.stats.builds, warmBuildsAfter: again.stats.builds,
        snapshots, identity: 'exact traffic, persisted metadata, session bytes and regular/fullscreen replay',
        scope: 'actual built-in edit/read; no cache policy change, truncation or timing threshold' }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });


test('real CLI: bounded argument previews, path-only edits and visible payloads preserve native data and replay',
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [], flags = ['--toolview-compact', 'write'];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 180); return terminal;
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter(event => event.type === 'call').length, 7);
      assert.equal(events.filter(event => event.type === 'result').length, 7);
      assert.equal(events.filter(event => event.type === 'model_context').length, 8);
      return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
    };
    const expected = [
      fixtureBoundedSummary('tv_summary', '', [
        'op="inspect"', 'action="preview"', 'command="echo"', `query=${fixtureQuotedPreview('STRING_BEGIN_' + 'x'.repeat(1000))}`,
        'paths=["src"]', 'symbol="render"', 'limit=0', 'wait=false', 'api_key="<redacted>"', 'mystery="UNKNOWN"',
        'content="CONTENT_VISIBLE"', 'edits=[{"oldText":"OLD_VISIBLE","newText":"NEW_VISIBLE"}]',
      ]),
      `tv_summary [content=${fixtureQuotedPreview('界é'.repeat(300))}, newText="ONE_REPLACEMENT"]`,
      `tv_summary [query=[${Array(18).fill('"ARRAY_ENTRY"').join(',')},…]]`,
      `tv_summary [query={"list":[${Array(16).fill('"OBJECT_ENTRY"').join(',')},…],…}, unknownTail="DISPLAY_TAIL"]`,
      fixtureBoundedSummary('tv_summary', '', Array.from({ length: 30 }, (_, i) => `field${String(i).padStart(2, '0')}="${'v'.repeat(180)}"`)),
      'edit missing-bounded.ts',
      'write bounded-write.txt',
    ];
    let checkedErrorCells = 0;
    const check = async (dump) => {
      assert.equal(dump.tools.length, 7);
      for (const [index, tool] of dump.tools.entries()) {
        compactContent(tool);
        assert.equal(summaryText(tool), summaryExpected(expected[index]), `bounded preview ${index}`);
        assert.ok(summarySize(expected[index]) <= 1024);
        const rows = lines(tool), start = dump.screen.findIndex((row, y) => row === rows[0] && rows.every((line, offset) => dump.screen[y + offset] === line));
        assert.ok(start >= 0, `complete physical row block ${index} at ${dump.width}`);
        for (let y = start; y < start + rows.length; y++) assert.ok(['', ' '].includes(dump.cells[y][dump.width - 1].text), 'one blank right column');
        await assertFits(tool.lines, dump.width - 1);
      }
      assert.doesNotMatch(dump.tools.map(tool => tool.lines.join('')).join(''), /COMPACT_SECRET_NEVER_VISIBLE|EDIT_PATTERN_IGNORED|EDIT_QUERY_IGNORED|PROPOSAL_IGNORED/u);
      assert.ok(dump.tools[5].isError, 'actual built-in edit failed');
      checkedErrorCells += await errorSummaryColors(dump, dump.tools[5]);
    };
    try {
      const stock = await start('bounded-stock');
      await stock.run('bounded-summaries'); const native = await stock.capture('native');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const live = await start('bounded-toolview', { toolview: true, flags, workspace: stock.work });
      await live.run('bounded-summaries'); const wide = await live.capture('wide'); await check(wide);
      assert.deepEqual(activity(live), activity(stock), '7 actual calls/results and 8 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(native));
      assert.equal(readFileSync(join(live.work, 'bounded-write.txt'), 'utf8'), 'WRITE_BODY_' + 'w'.repeat(1000));
      assert.equal(wide.tools[0].args.query.length, 1013, 'original unabridged string remains in component arguments');
      assert.equal(wide.tools[2].args.query.length, 100, 'original array remains complete');
      const bytes = readFileSync(wide.session);
      await live.resize(24, 180); await check(await live.capture('narrow'));
      await live.resize(100, 180); const back = await live.capture('wide-again'); await check(back);
      assert.deepEqual(toolLines(back), toolLines(wide));
      await live.command('/tv-theme light'); await check(await live.capture('light'));
      await live.command('/tv-theme dark'); await check(await live.capture('dark'));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every(tool => tool.expanded));
      assert.deepEqual(toolLines({ tools: expanded.tools.filter(tool => tool.name !== 'edit') }),
        toolLines({ tools: nativeExpanded.tools.filter(tool => tool.name !== 'edit') }), 'full generic/write native details are unchanged');
      assert.match(expanded.tools[5].lines.map(plain).join('\n'), /missing-bounded.ts/u);
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'));
      await live.command('/toolview off'); const off = await live.capture('off');
      assert.deepEqual(toolLines({ tools: off.tools.filter(tool => tool.name !== 'edit') }),
        toolLines({ tools: native.tools.filter(tool => tool.name !== 'edit') }));
      await live.command('/toolview on'); await check(await live.capture('on'));
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded);
      assert.deepEqual(activity(live), activity(stock));
      assert.deepEqual(readFileSync(wide.session), bytes, 'UI operations leave session bytes untouched');
      await live.close();
      const replay = await start('bounded-replay', { toolview: true, flags, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      const nativeReplay = await start('bounded-native-replay', { session: wide.session, workspace: stock.work });
      const sameSessionNative = await nativeReplay.capture('replayed');
      await replay.command('/toolview off');
      assert.deepEqual(toolLines(await replay.capture('off')), toolLines(sameSessionNative), 'same-session native control includes unchanged edit details');
      assert.deepEqual(readFileSync(wide.session), bytes);
      writeFileSync(join(artifacts, 'bounded-summary-coverage.json'), JSON.stringify({
        calls: 7, results: 7, modelContexts: 8, widths: [24, 100], valueLimit: 256, summaryLimit: 1024, checkedErrorCells,
        checks: ['action/target/control/unknown/content ordering', 'visible payloads', 'quoted Unicode/string and container caps', 'total text budget',
          'path-only actual edit failure', 'physical complete row blocks', 'dark/light error cells', 'native expansion', 'off/on/reload', 'same-session replay'],
        identity: 'Exact raw args/results/model contexts and unchanged session bytes; no tools re-executed during replay',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });


for (const shape of [false, true]) test(`real CLI: write cards ${shape ? 'representative saved diff shapes' : 'actual stock writes'} and lifecycle/native/replay`,
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [], captures = [], count = shape ? 11 : 5;
    const scenario = shape ? 'write-shapes' : 'write-stock';
    const extraEnv = { TOOLVIEW_TEST_WRITE_CARDS: '1', ...(shape ? { TOOLVIEW_TEST_WRITE_SHAPE: '1' } : {}) };
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(`${scenario}-${name}`, { ...options, extraEnv }); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    const run = async (terminal) => {
      terminal.send(`run ${scenario}\r`); await terminal.event('provider_gate');
      const pending = await terminal.capture('pointer-write-arguments', { animated: true });
      assert.equal(pending.tools.length, 1); assert.equal(pending.tools[0].executionStarted, false);
      assert.equal(terminal.events().filter(event => event.type === 'call').length, 0);
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('write_execution_gate');
      const running = await terminal.capture('pointer-write-running', { animated: true });
      assert.equal(running.tools[0].executionStarted, true);
      assert.equal(terminal.events().filter(event => event.type === 'call').length, 1);
      assert.equal(terminal.events().filter(event => event.type === 'result').length, 0);
      writeFileSync(join(terminal.output, 'write-execution-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      return { pending, running };
    };
    const events = terminal => {
      const events = terminal.events();
      assert.equal(events.filter(event => event.type === 'call').length, count);
      assert.equal(events.filter(event => event.type === 'result').length, count);
      assert.equal(events.filter(event => event.type === 'model_context').length, count + 1);
      assert.equal(events.filter(event => event.type === 'provider_error').length, 0);
      return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
    };
    const reference = new Terminal({ cols: 100, rows: 1, allowProposedApi: true });
    const style = async (dump, role, background = false) => {
      reference.reset(); await new Promise(done => reference.write((background ? dump.backgroundStyles : dump.summaryStyles)[role], done));
      const cell = reference.buffer.active.getLine(0).getCell(0);
      return background ? { bg: cell.getBgColor(), bgMode: cell.getBgColorMode() } : { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim() };
    };
    let panelCells = 0, syntaxCells = 0, errorCells = 0;
    const labels = shape ? ['Created', 'Edited', 'Replaced', 'Replaced', 'Wrote', 'Wrote', 'Wrote', null, 'Wrote', null] : ['Wrote', 'Wrote', 'Wrote', 'Wrote', null];
    const check = async (dump) => {
      if (shape && (nativeControl.width !== dump.width || nativeControl.backgroundStyles.toolPendingBg !== dump.backgroundStyles.toolPendingBg)) {
        await nativeTerminal.resize(dump.width, dump.width === 24 ? 320 : 240);
        await nativeTerminal.command(`/tv-theme ${dump.backgroundStyles.toolPendingBg === darkPanel ? 'dark' : 'light'}`);
        nativeControl = await nativeTerminal.capture(`pointer-write-native-matched-${captures.length}`);
      }
      assert.equal(dump.writeShape, shape); assert.equal(dump.tools.length, count);
      for (const [index, label] of labels.entries()) {
        const tool = dump.tools[index], rows = lines(tool), text = rows.join('\n');
        if (!label) continue;
        assert.ok(text.replace(/[┃\s]/gu, '').includes(`←${label}${tool.args.path}`), 'wrapped title retains its complete label/path');
        assert.ok(rows.some(row => row.startsWith(' ┃')));
        assert.doesNotMatch(text, /Click to expand|PROPOSED_WRITE/);
        await assertFits(tool.lines, dump.width);
      }
      if (shape) {
        assert.match(lines(dump.tools[0]).join('\n'), /WRITE_TAIL_19/); assert.doesNotMatch(lines(dump.tools[0]).join('\n'), /ARGS_CREATED_MUST_NOT_REPLACE_RESULT/);
        assert.ok(lines(dump.tools[1]).join('').replace(/[┃\s]/gu, '').includes('5+constADDED_WRITE=5;')); assert.doesNotMatch(lines(dump.tools[1]).join('\n'), /old1/);
        assert.ok(lines(dump.tools[2]).join('').replace(/[┃\s]/gu, '').includes('1-constBEFORE_WRITE=1;'));
        assert.ok(lines(dump.tools[2]).join('').replace(/[┃\s]/gu, '').includes('1+constAFTER_WRITE=3;'));
        assert.ok(lines(dump.tools[3]).join('').replace(/[┃\s]/gu, '').includes('1-constERASED_WRITE=1;'));
        assert.match(lines(dump.tools[4]).join('\n'), /No changes\./);
        assert.ok(lines(dump.tools[6]).join('').replace(/[┃\s]/gu, '').includes('Difftruncatedbytool;showingsuppliedcontent.'));
        assert.doesNotMatch(lines(dump.tools[6]).join('\n'), /INCOMPLETE_DIFF/);
        assert.ok(lines(dump.tools[7]).join('').replace(/\s/gu, '').includes('NATIVE_WRITE_RESULT_malformed'));
        nativeAfterMultiline(dump.tools[7], nativeControl.tools[7]);
        assert.deepEqual(dump.tools[9].lines, [], 'hidden same-name self renderer stays hidden, even with successful added source');
        assert.ok(leadingBlanks(dump.tools[10]) === 1, 'hidden write is skipped when locating the visible multiline predecessor');
      } else {
        assert.ok(dump.tools.slice(0, 4).every(tool => tool.details === undefined), 'actual stock writes have no diff/creation metadata');
        assert.match(lines(dump.tools[0]).join('\n'), /WRITE_TAIL_19/);
        compactContent(dump.tools[4]); assert.equal(summaryText(dump.tools[4]), summaryExpected('write write-directory'));
        errorCells += await errorSummaryColors(dump, dump.tools[4]);
      }
      const plainIndexes = shape ? [0, 4, 5, 6, 8] : [0, 1, 2, 3];
      for (const index of plainIndexes) assert.doesNotMatch(lines(dump.tools[index]).join('\n'), /┃ +\d+ [+-] /, 'plain source has no sign column');
      if (dump.width >= 100) {
        const body = lines(dump.tools[0]), physical = dump.screen.map(plain);
        const start = physical.findIndex((row, y) => row === body[0] && body.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0, 'the complete >10-line plain source card is physically painted');
        const neutral = await style(dump, 'toolPendingBg', true);
        for (let y = start; y < start + body.length; y++) {
          assert.equal(dump.cells[y][1].text, '┃'); assert.equal(dump.cells[y][0].bgMode, 0);
          assert.equal(dump.cells[y][dump.width - 1].bgMode, 0);
          for (let x = 2; x < dump.width - 1; x++) {
            assert.deepEqual({ bg: dump.cells[y][x].bg, bgMode: dump.cells[y][x].bgMode }, neutral, 'plain write has only neutral panel paint, including padding'); panelCells++;
          }
        }
        for (const [token, role] of [['continued', 'syntaxComment'], ['export', 'syntaxKeyword'], ['"界', 'syntaxString']]) {
          const row = body.findIndex(row => row.includes(token)); assert.ok(row >= 0);
          const cell = dump.cells[start + row][body[row].indexOf(token)];
          assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await style(dump, role)); syntaxCells++;
        }
        assert.match(body.join('\n'), /19 const WRITE_TAIL_19 = 19;/);
        if (shape) {
          const changed = lines(dump.tools[2]);
          assert.equal(changed.findIndex(row => row.includes('BEFORE_WRITE')) === changed.findIndex(row => row.includes('AFTER_WRITE')), dump.width > 120, 'mixed write changes split only above 120 columns');
        }
      }
      captures.push({ width: dump.width, sourceLines: 19, labels });
    };
    let nativeControl, nativeTerminal, darkPanel;
    try {
      const stock = await start('native'); nativeTerminal = stock; await run(stock); nativeControl = await stock.capture('pointer-write-native');
      darkPanel = nativeControl.backgroundStyles.toolPendingBg;
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('pointer-write-native-expanded');
      stock.send('\x0f'); await stock.settle();
      const live = await start('toolview', { toolview: true, workspace: stock.work }); const phases = await run(live);
      for (const phase of [phases.pending, phases.running]) {
        const tool = phase.tools[0], text = lines(tool).join('\n');
        assert.match(text, /write write-(created|stock)\.ts/); assert.doesNotMatch(text, /┃|← (?:Created|Edited|Replaced|Wrote)|write comment|ARGS_CREATED|PROPOSED_WRITE|content=/);
        assert.equal(lines(tool).length, 1);
        assert.match(text, tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u : /^ ← write /u, 'only actual execution animates the leading glyph');
        assert.ok(phase.screen.some(row => tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u.test(row) : /^ ← write /u.test(row)), 'compact lifecycle is physically painted');
      }
      const liveFirst = await live.capture('pointer-write-wide'); await check(liveFirst);
      assert.deepEqual(events(live), events(stock)); assert.deepEqual(persisted(liveFirst), persisted(nativeControl));
      if (!shape) {
        assert.equal(readFileSync(join(live.work, 'write-stock.ts'), 'utf8'), 'const overwritten = 20;\n');
        assert.equal(readFileSync(join(live.work, 'write-empty.ts'), 'utf8'), 'const filled = 21;\n');
        assert.equal(readFileSync(join(live.work, 'write-cleared.ts'), 'utf8'), '');
      }
      const bytes = readFileSync(liveFirst.session);
      await live.command('/toolview cache clear'); await live.capture('pointer-write-cold');
      await live.command('/toolview cache'); const cold = (await live.capture('pointer-write-cache-cold')).cacheDiagnostics.at(-1);
      await live.command('/toolview cache'); const warm = (await live.capture('pointer-write-cache-warm')).cacheDiagnostics.at(-1);
      assert.equal(warm.builds, cold.builds, 'unchanged frames rebuild no write body');
      assert.equal(warm.cards.builds, cold.cards.builds); assert.ok(warm.cards.hits > cold.cards.hits);
      assert.equal(warm.cards.entries, shape ? 8 : 4, 'successful write frames share the existing card pool; malformed/hidden/error stay outside');
      await live.resize(140, 240); await check(await live.capture('pointer-write-split'));
      await live.resize(24, 320); await check(await live.capture('pointer-write-narrow'));
      await live.resize(100, 240); const wideAgain = await live.capture('pointer-write-wide-again'); await check(wideAgain);
      assert.deepEqual(toolLines(wideAgain), toolLines(liveFirst));
      await live.command('/tv-theme light'); await check(await live.capture('pointer-write-light'));
      await live.command('/tv-theme dark'); await check(await live.capture('pointer-write-dark'));
      const beforeClick = await live.capture('pointer-write-before-click');
      const target = beforeClick.screen.findIndex(row => row.includes(`← ${labels[0]} ${beforeClick.tools[0].args.path}`));
      assert.ok(target >= 0); live.send(`\x1b[<0;3;${target + 1}M\x1b[<0;3;${target + 1}m`); await live.settle();
      const clicked = await live.capture('pointer-write-clicked');
      assert.equal(clicked.tools[0].expanded, true); assert.ok(clicked.tools.slice(1).every(tool => !tool.expanded));
      assert.deepEqual(clicked.tools[0].lines, nativeExpanded.tools[0].lines, 'panel click reveals the original native write');
      const nativeTitle = clicked.screen.findIndex(row => row.includes(shape ? 'NATIVE_WRITE write-created.ts' : 'write write-stock.ts'));
      assert.ok(nativeTitle >= 0); live.send(`\x1b[<0;5;${nativeTitle + 1}M\x1b[<0;5;${nativeTitle + 1}m`); await live.settle();
      assert.equal((await live.capture('pointer-write-click-recollapsed')).tools[0].expanded, false);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('pointer-write-expanded');
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('pointer-write-recollapsed'));
      await live.command('/toolview off'); assert.deepEqual(toolLines(await live.capture('pointer-write-off')), toolLines(nativeControl));
      await live.command('/toolview on'); await check(await live.capture('pointer-write-on'));
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1); const reloaded = await live.capture('pointer-write-reloaded'); await check(reloaded);
      assert.deepEqual(events(live), events(stock)); assert.deepEqual(readFileSync(liveFirst.session), bytes);
      await live.close();
      const replay = await start('replay', { toolview: true, session: liveFirst.session, workspace: stock.work });
      const resumed = await replay.capture('pointer-write-replayed'); await check(resumed);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(liveFirst));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      const sameSessionNative = await start('native-replay', { session: liveFirst.session, workspace: stock.work });
      const nativeReplay = await sameSessionNative.capture('pointer-write-native-replay');
      await replay.command('/toolview off'); assert.deepEqual(toolLines(await replay.capture('pointer-write-replay-off')), toolLines(nativeReplay));
      const explicit = await start('native-override', { toolview: true, flags: ['--toolview-card', 'write'], session: liveFirst.session, workspace: stock.work });
      const explicitNative = await explicit.capture('pointer-write-explicit-native');
      assert.deepEqual(toolLines({ tools: byName(explicitNative, 'write') }), toolLines({ tools: byName(nativeReplay, 'write') }), 'write-only native override preserves every write row');
      if (shape) compactContent(byName(explicitNative, 'read')[0]);
      const compactReplay = await start('compact', { toolview: true, flags: ['--toolview-card', 'write', '--toolview-compact', 'write'], session: liveFirst.session, workspace: stock.work });
      const forced = await compactReplay.capture('pointer-write-forced-compact');
      for (const tool of byName(forced, 'write')) {
        if (tool.args.fixtureCase === 'hidden') assert.deepEqual(tool.lines, []);
        else { compactContent(tool); assert.equal(summaryText(tool), summaryExpected(`write ${tool.args.path}`)); }
      }
      const regular = await start('regular-replay', { toolview: true, mode: 'regular', session: liveFirst.session, workspace: stock.work });
      const regularDump = await regular.capture('pointer-write-regular');
      assert.deepEqual(toolLines(regularDump), toolLines(reloaded));
      sameSessionNative.send('\x0f'); await sameSessionNative.settle();
      const sameSessionExpanded = await sameSessionNative.capture('pointer-write-native-replay-expanded');
      regular.send('\x0f'); await regular.settle();
      assert.deepEqual(toolLines(await regular.capture('pointer-write-regular-expanded')), toolLines(sameSessionExpanded));
      assert.deepEqual(readFileSync(liveFirst.session), bytes);
      writeFileSync(join(artifacts, `${scenario}-coverage.json`), JSON.stringify({
        actualStockExecuted: !shape, installedAFTExecuted: false, calls: count, results: count, modelContexts: count + 1,
        panelCells, syntaxCells, errorCells, captures, cardEntries: warm.cards.entries, warmBuildsDelta: warm.builds - cold.builds,
        checks: ['pre-execution/execution gates', 'saved-source classification/full 19-line source', 'no diff signs/tint for plain', 'physical syntax/panel cells',
          'native click/Ctrl+O', 'native and compact overrides', 'width/theme/lifecycle', 'fullscreen/regular replay', 'exact traffic/session bytes'],
      }, null, 2));
    } finally {
      reference.dispose(); for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });


test('main editor user-card styling preserves real draft input, cursor, menus and lifecycle', { skip: stockOnly }, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `editor ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'observation/style changes never transfer or rewrite the native draft');
    assert.equal(dump.exactStockPrototype, true); assert.equal(dump.sharedEditorPrototype, true);
    assert.equal(dump.inputMethodUnchanged, true);
    return terminal.captureScreen(name, dump);
  };
  const check = async (dump, needle) => {
    assert.ok(dump.rows.every(row => !row.includes('\0')), 'projection sentinels never reach the terminal');
    assert.ok(dump.rows.some(row => plain(row).includes('┃')), 'actual stock editor is framed');
    assert.ok(dump.rows.every(row => !plain(row).includes('─')), 'no native horizontal borders');
    const y = dump.screen.findIndex(row => row.includes(needle));
    assert.ok(y >= 0, `${needle} is physically painted`);
    const cells = dump.cells[y], border = cells.findIndex(cell => cell.text === '┃');
    assert.equal(border, 1, 'editor shares the user-card exterior margin');
    assert.equal(cells[2].text, ' ', 'one internal left pad');
    const background = await referenceCell(dump.styles.background), stripe = await referenceCell(dump.styles.border);
    for (let x = 2; x < dump.width - 1; x++) {
      assert.equal(cells[x].bgMode, background.bgMode); assert.equal(cells[x].bg, background.bg);
    }
    assert.equal(cells[1].fg, stripe.fg); assert.equal(cells[1].bgMode, 0);
    assert.equal(cells[0].bgMode, 0); assert.equal(cells.at(-1).bgMode, 0);
    const matching = dump.rows.findIndex(row => plain(row).includes(needle));
    assert.equal(dump.rows.filter(row => row.includes('\x1b_pi:c')).length, 1, 'native hardware-cursor marker is retained');
    assert.equal(dump.screen[y].trimEnd(), plain(dump.rows[matching].replaceAll('\x1b_pi:c\x07', '')), 'physical row equals actual component paint (cursor marker is zero-column metadata)');
    await assertFits(dump.rows, dump.width);
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const draft = 'EDITOR_FIRST\n  EDITOR_SECOND 界é\n> literal';
      terminal.send('\x1b[200~' + draft + '\x1b[201~'); await terminal.settle();
      let dump = await observe(terminal, 'draft'); await check(dump, 'EDITOR_FIRST');
      assert.equal(dump.after.expanded, draft);
      const identity = dump.identity;
      dump = await observe(terminal, 'off', 'off'); assert.equal(dump.identity, identity);
      assert.ok(dump.rows.some(row => plain(row).includes('─')));
      dump = await observe(terminal, 'on', 'on'); assert.equal(dump.identity, identity); await check(dump, 'EDITOR_FIRST');
      dump = await observe(terminal, 'light', 'light'); await check(dump, 'EDITOR_FIRST');
      dump = await observe(terminal, 'dark', 'dark'); await check(dump, 'EDITOR_FIRST');
      for (const width of [60, 24, 100]) {
        await terminal.resize(width); dump = await observe(terminal, `width-${width}`);
        assert.equal(dump.after.expanded, draft); await check(dump, 'EDITOR_FIRST');
      }
      if (mode === 'fullscreen') {
        const y = dump.screen.findIndex(row => row.includes('EDITOR_FIRST'));
        await sgrAt(terminal, 3, y); dump = await observe(terminal, 'click-start');
        assert.deepEqual(dump.after.cursor, { line: 0, col: 0 });
        terminal.send('Z'); await terminal.settle(); dump = await observe(terminal, 'insert-after-click');
        assert.equal(dump.after.expanded, 'Z' + draft);
        terminal.send('\x1f'); await terminal.settle();
      }
      terminal.send('\x1f'); await terminal.settle(); // Undo the original multiline paste.
      dump = await observe(terminal, 'undo-paste'); assert.equal(dump.after.expanded, '');
      const paste = 'LONG_EDITOR_PASTE_界é_'.repeat(100);
      terminal.send('\x1b[200~' + paste + '\x1b[201~'); await terminal.settle();
      dump = await observe(terminal, 'large-paste'); assert.match(dump.after.text, /\[paste #/u);
      assert.equal(dump.after.expanded, paste);
      for (const action of ['off', 'on']) {
        dump = await observe(terminal, `large-${action}`, action);
        assert.equal(dump.identity, identity); assert.equal(dump.after.expanded, paste);
      }
      terminal.send('\x1f'); await terminal.settle();
      terminal.send('/tv-d'); await terminal.settle(); dump = await observe(terminal, 'menu');
      assert.equal(dump.menu, true); assert.equal(dump.after.text, '/tv-d');
      const menu = dump.screen.findIndex(row => row.includes('tv-dump') && !row.includes('/tv-d'));
      assert.ok(menu >= 0, 'native command menu remains visible below the panel');
      assert.equal(dump.cells[menu].some(cell => cell.text === '┃'), false, 'autocomplete is not framed as editor text');
      terminal.send('\t'); await terminal.settle(); dump = await observe(terminal, 'completed');
      assert.match(dump.after.text, /^\/tv-dump/u);
      terminal.send('\x03'); await terminal.settle();
      await terminal.command('/reload'); await terminal.event('start', 2);
      terminal.send('EDITOR_RELOAD'); await terminal.settle(); dump = await observe(terminal, 'reload');
      await check(dump, 'EDITOR_RELOAD');
      terminal.send('\x03'); await terminal.settle();
      const fullWidth = dump.width;
      const full = 'EDITOR_FULL_' + 'x'.repeat(fullWidth - 5 - 'EDITOR_FULL_'.length);
      terminal.send(full); await terminal.settle(); dump = await observe(terminal, 'full-line');
      await check(dump, 'EDITOR_FULL_');
      const fullY = dump.screen.findIndex(row => row.includes('EDITOR_FULL_'));
      assert.equal(dump.cells[fullY][fullWidth - 2].inverse, true, 'end cursor consumes internal right padding only');
      assert.equal(dump.cells[fullY][fullWidth - 1].inverse, false, 'exterior margin is never inverted');
      for (const cell of dump.cells[fullY + 1]) assert.equal(cell.inverse, false, 'bottom padding is never inverted');
      terminal.send('\x03'); await terminal.settle();
      await terminal.run('user-card'); const final = await terminal.capture('editor-transcript');
      assert.equal(final.tools.length, 2); assert.equal(final.tools[0].name, 'bash');
      const user = final.branch.filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1);
      assert.deepEqual(user.message.content, [{ type: 'text', text: 'run user-card' }]);
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});


test('belowEditor metadata and separate native status preserve physical half-block paint, menus and active lifecycle', { skip: stockOnly }, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `belowEditor ${name}`);
    await terminal.settle(!dump.idle); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'status actions never rewrite drafts');
    return terminal.captureScreen(name, dump);
  };
  const nativeActivity = (dump, inputY) => {
    assert.equal(dump.embedWorkingStatus, false, 'Pi selects its native separate status container');
    assert.equal(dump.embeddedStatusPresent, false);
    assert.match(dump.nativeStatusRows.map(plain).join('\n'), /Working A─B ───/u, 'native component owns literal message output');
    assert.ok(!dump.rows.map(plain).join('\n').includes('Working'));
    assert.ok(!dump.statusRows.map(plain).join('\n').includes('Working'));
    const matches = dump.screen.map((row, index) => row.includes('Working A─B ───') ? index : -1).filter(index => index >= 0);
    assert.equal(matches.length, 1, 'one physical native status, no duplicate in input or metadata');
    assert.ok(matches[0] < inputY, 'native status physically precedes the input');
    return matches[0];
  };
  const hidden = (dump) => {
    assert.equal(dump.menu, true, 'native public getter confirms an open autocomplete menu');
    assert.deepEqual(dump.statusRows, [], 'both belowEditor rows disappear during autocomplete');
    assert.ok(!dump.screen.some(row => row.includes('╹▀')), 'half-block edge is physically absent');
    const inputY = dump.screen.findIndex(row => row.includes('/tv-d'));
    assert.ok(inputY >= 1);
    if (dump.statusPresent) nativeActivity(dump, inputY - 1);
    else assert.ok(!dump.screen.some(row => row.includes('Working A─B ───')));
    const nativeRows = dump.rows.map(row => plain(row.replaceAll('\x1b_pi:c\x07', '')));
    assert.deepEqual(dump.screen.slice(inputY - 1, inputY - 1 + nativeRows.length).map(row => row.trimEnd()), nativeRows,
      'native editor and menu occupy their unchanged contiguous rows');
    assert.deepEqual(dump.screen.slice(inputY - 1 + nativeRows.length, inputY - 1 + nativeRows.length + dump.footerRows.length).map(row => row.trimEnd()),
      dump.footerRows.map(plain), 'footer directly follows native menu with no reserved widget rows');
  };
  const check = async (dump, active = false) => {
    assert.equal(dump.menu, false, 'two widget rows return only after the menu closes');
    assert.equal(dump.statusRows.length, 2); await assertFits(dump.statusRows, dump.width);
    const edgeY = dump.screen.findIndex(row => row.includes('╹▀'));
    assert.ok(edgeY > 0, 'both widget rows physically precede the existing footer');
    const y = edgeY - 1, cells = dump.cells[y], edge = dump.cells[edgeY];
    assert.equal(cells[1].text, '┃'); assert.equal(edge[1].text, '╹');
    const panel = await referenceCell(dump.styles.background), bottom = await referenceCell(dump.styles.bottom);
    for (let x = 2; x < dump.width - 1; x++) {
      assert.equal(cells[x].bgMode, panel.bgMode); assert.equal(cells[x].bg, panel.bg);
      assert.equal(edge[x].text, '▀'); assert.equal(edge[x].fgMode, bottom.fgMode); assert.equal(edge[x].fg, bottom.fg);
      assert.equal(edge[x].bgMode, 0, 'bottom half remains terminal-default, not userMessageBg');
    }
    for (const line of [cells, edge]) for (const x of [0, 1, dump.width - 1]) assert.equal(line[x].bgMode, 0);
    if (dump.width === 100) {
      assert.ok(dump.screen[y].includes(dump.modelName), 'model.name, not its id');
       const shown = /\(([^)]+)\)/u.exec(dump.screen[y]);
       assert.ok(shown && dump.provider.startsWith(shown[1].replace(/…$/u, '')), 'literal provider ID prefix with balanced parentheses');
      assert.ok(dump.screen[y].includes(` • ${dump.thinking}`));
    }
    assert.equal(dump.screen[y].includes('Idle'), !active && dump.idle);
    const foreground = async (start, length, style, label) => {
      const reference = await referenceCell(style);
      for (let x = start; x < start + length; x++) {
        assert.equal(cells[x].fgMode, reference.fgMode, `${label}: physical foreground mode`);
        assert.equal(cells[x].fg, reference.fg, `${label}: physical foreground color`);
      }
    };
    const text = dump.screen[y];
    if (dump.width === 100) {
      await foreground(text.indexOf(dump.modelName), dump.modelName.length, dump.styles.model, 'model mdHeading');
      const shown = /\(([^)]+)\)/u.exec(text), providerX = shown.index;
      await foreground(providerX, 1, dump.styles.separator, 'opening parenthesis dim');
      await foreground(providerX + 1, shown[1].length, dump.styles.provider, 'provider muted including ellipsis');
      await foreground(providerX + 1 + shown[1].length, 1, dump.styles.separator, 'closing parenthesis dim');
      await foreground(text.indexOf(` • ${dump.thinking}`) + 3, dump.thinking.length, dump.styles.thinking, 'native thinking role');
    }
    for (let x = 0; x < text.length; x++) if (text[x] === '•') await foreground(x, 1, dump.styles.separator, 'bullet dim');
    assert.ok(!text.includes('Working'), 'working activity never enters belowEditor metadata');
    if (text.includes('Idle')) await foreground(text.indexOf('Idle'), 4, dump.styles.idle, 'Idle muted');
    assert.equal(dump.footerOwner, 'FooterView', 'recognized stock editor keeps its Toolview footer through metadata/autocomplete and reload');
    assert.ok(dump.footerRows.length > 0);
    assert.deepEqual(dump.screen.slice(edgeY + 1, edgeY + 1 + dump.footerRows.length).map(row => row.trimEnd()), dump.footerRows.map(plain),
      'actual managed footer rows physically follow the widget at every width');
    return active && dump.statusPresent ? nativeActivity(dump, y - dump.rows.length) : y;
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-status-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      let dump = await observe(terminal, 'idle'); await check(dump);
      assert.equal(dump.modelName, 'Offline terminal fixture'); assert.equal(dump.provider, 'toolview-offline');
      terminal.send('/tv-d'); await terminal.settle(); dump = await observe(terminal, 'menu');
      hidden(dump);
      const menu = dump.screen.findIndex(row => row.includes('tv-dump') && !row.includes('/tv-d'));
      assert.ok(menu >= 0, 'native autocomplete remains physically visible without widget rows');
      if (mode === 'fullscreen') {
        await sgrAt(terminal, 5, menu); dump = await observe(terminal, 'menu-click');
        assert.match(dump.after.text, /^\/tv-dump/u);
      } else { terminal.send('\t'); await terminal.settle(); }
      terminal.send('\x03'); await terminal.settle(); dump = await observe(terminal, 'menu-closed'); await check(dump);
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await check(dump); }
      for (const width of [24, 60, 100]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await check(dump); }
      dump = await observe(terminal, 'thinking', 'thinking-off'); assert.equal(dump.thinking, 'off'); await check(dump);
      terminal.send('run pending\r'); await terminal.event('provider_gate');
      dump = await observe(terminal, 'working-message', 'working-message'); let workY = await check(dump, true);
      assert.ok(dump.screen[workY].includes('Working A─B ───'), 'literal frame-like message glyphs survive');
      assert.ok(!dump.rows.map(plain).join('\n').includes('Working'), 'status is absent from input rows');
      const identity = dump.statusIdentity; assert.ok(identity);
      terminal.send('/tv-d'); await terminal.settle(true); dump = await observe(terminal, 'busy-menu'); hidden(dump);
      assert.equal(dump.statusIdentity, identity, 'autocomplete hiding retains the same native indicator');
      dump = await observe(terminal, 'busy-menu-off', 'off'); assert.equal(dump.statusIdentity, identity);
      dump = await observe(terminal, 'busy-menu-on', 'on'); hidden(dump); assert.equal(dump.statusIdentity, identity);
      terminal.send('\x1b'); await terminal.settle(true); dump = await observe(terminal, 'busy-menu-escape');
      await check(dump, true); assert.equal(dump.after.text, '/tv-d', 'Escape closes the menu without rewriting the draft');
      assert.equal(dump.statusIdentity, identity, 'same Working reappears after Escape');
      terminal.send('\x15'); await terminal.settle(true); dump = await observe(terminal, 'busy-draft-cleared'); await check(dump, true);
      assert.equal(dump.after.text, '', 'native line deletion clears only the draft, not the running request');
      const phases = new Set();
      for (let i = 0; i < 3; i++) {
        dump = await observe(terminal, `phase-${i}`); workY = await check(dump, true);
        phases.add(dump.screen[workY].trim().slice(0, 1));
        assert.equal(dump.statusIdentity, identity, 'the existing host-owned object is preserved');
      }
      assert.ok(phases.size >= 2, 'native animation moves on the physical screen');
      dump = await observe(terminal, 'active-off', 'off'); assert.deepEqual(dump.statusRows, []);
      assert.equal(dump.statusIdentity, identity); assert.ok(dump.rows.map(plain).join('\n').includes('Working A─B ───'));
      dump = await observe(terminal, 'active-on', 'on'); await check(dump, true); assert.equal(dump.statusIdentity, identity);
      dump = await observe(terminal, 'busy-hidden', 'working-hide');
      workY = await check(dump, true); assert.equal(dump.idle, false);
      assert.ok(!dump.screen[workY].includes('Working')); assert.ok(!dump.screen[workY].includes('Idle'));
      dump = await observe(terminal, 'busy-shown', 'working-show'); await check(dump, true);
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end');
      dump = await observe(terminal, 'complete'); await check(dump); assert.equal(dump.statusIdentity, undefined);
      const complete = await terminal.capture('status-traffic'); assert.equal(complete.tools.length, 2);
      await terminal.command('/reload'); await terminal.event('start', 2);
      dump = await observe(terminal, 'reload'); await check(dump);
      const native = new PiTerminal(`editor-status-native-${mode}`, { mode, workspace: terminal.work });
      terminals.push(native); await native.ready(); native.send('run pending\r'); await native.event('provider_gate');
      writeFileSync(join(native.output, 'provider-go'), 'go'); await native.event('tool_gate');
      writeFileSync(join(native.output, 'tool-go'), 'go'); await native.event('agent_end');
      await native.capture('native-complete'); assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'native model calls/results unchanged');
      const heightControls = [];
      for (const height of [16, 6]) {
        await terminal.resize(100, height); await native.resize(100, height);
        const projected = await observe(terminal, `height-${height}`), stock = await native.capture(`height-${height}`);
        assert.equal(projected.rows.length, stock.editor.lines.length, 'height pressure does not add editor-local rows');
        assert.equal(projected.rows.filter(row => row.includes('\x1b_pi:c')).length, 1, 'native cursor marker retained under height pressure');
        assert.equal(projected.after.text, '', 'height pressure never changes the native draft');
        if (height === 16) await check(projected);
        heightControls.push({ height, nativeEditorRows: stock.editor.lines.length, projectedEditorRows: projected.rows.length,
          physicalStatusVisible: projected.screen.some(row => row.includes('Idle')), physicalHalfBlockVisible: projected.screen.some(row => row.includes('╹▀')) });
      }
      writeFileSync(join(terminal.output, 'height-controls.json'), JSON.stringify(heightControls, null, 2));
      await terminal.resize(100); dump = await observe(terminal, 'height-restored'); await check(dump);
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'height controls add no calls/results/model contexts');
      const replay = new PiTerminal(`editor-status-replay-${mode}`, { mode, session: terminal.session, workspace: terminal.work, agentSettings: { editorPaddingX: 1 },
        extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready(); const replayDump = await observe(replay, 'replay'); await check(replayDump);
      const replayTraffic = await replay.capture('replay-traffic');
      assert.deepEqual(replayTraffic.branch, complete.branch, 'presentation adds no persisted/model content');
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});


test('belowEditor clipping leaves activity in Pi separate container without changing native Working ownership', { skip: stockOnly }, async () => {
  const terminal = new PiTerminal('editor-status-height-four', { mode: 'fullscreen', agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
  const observe = async (name, action) => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action })); terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `four-row ${name}`);
    await terminal.settle(true); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before);
    return terminal.captureScreen(name, dump);
  };
  try {
    await terminal.ready(); terminal.send('run pending\r'); await terminal.event('provider_gate');
    await terminal.resize(100, 4, true);
    const native = await observe('native-four', 'off');
    assert.ok(native.screen.some(row => row.includes('Working')), 'same active host indicator is visible in native editor at four rows');
    const projected = await observe('toolview-four', 'on');
    assert.equal(projected.statusIdentity, native.statusIdentity, 'no status replacement or restart');
    writeFileSync(join(terminal.output, 'height-counter.json'), JSON.stringify({ height: 4,
      nativeStatusVisible: native.screen.some(row => row.includes('Working')),
      toolviewStatusVisible: projected.screen.some(row => row.includes('Working')),
      sameNativeIndicator: projected.statusIdentity === native.statusIdentity }, null, 2));
    assert.equal(projected.embedWorkingStatus, false);
    assert.equal(projected.embeddedStatusPresent, false);
    assert.ok(projected.nativeStatusRows.some(row => plain(row).includes('Working')), 'native activity remains in its own container');
    assert.ok(!projected.statusRows.some(row => plain(row).includes('Working')), 'widget clipping is not activity projection');
    assert.equal(projected.statusRows.length, 2, 'component still supplies both rows; native parent allocation clips them');
    assert.equal(projected.toolviewRenderOverride, true, 'height pressure does not disable Toolview or introduce a height heuristic');
    assert.equal(projected.statusPresent, true, 'clipping never clears the native indicator');
    await terminal.resize(100, 80, true);
    const restored = await observe('height-restored');
    assert.equal(restored.statusIdentity, native.statusIdentity, 'resize recovery keeps the original native object');
    assert.ok(restored.screen.some(row => row.includes('Working')), 'status returns through normal native rendering when space returns');
  } finally { await terminal.close(); terminal.dispose(); }
});


test('editor padding settings move the complete input panel live in both terminal modes', { skip: stockOnly }, async () => {
  const terminals = [];
  const observe = async (terminal, name) => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name }));
    terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `padding ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'padding observation preserves native draft/cursor');
    return terminal.captureScreen(name, dump);
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-padding-${mode}`, { mode, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const initial = await observe(terminal, 'initial'); assert.equal(initial.padding, 0, 'native default tested without overrides');
      const identity = initial.identity;
      for (const [cycle, padding] of [0, 1, 2, 3, 0].entries()) {
        if (cycle > 0) {
          await terminal.command('/settings'); terminal.send('Editor padding'); await terminal.settle();
          terminal.send('\r'); await terminal.settle();
          assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ Editor padding\\s+${padding}\\s*$`, 'u').test(row)), 'native settings cycles selected value');
          terminal.send('\x1b'); await terminal.settle();
          const persisted = JSON.parse(readFileSync(join(terminal.agent, 'settings.json'), 'utf8'));
          assert.equal(persisted.editorPaddingX, padding, 'native setting persisted without Toolview writing settings');
        }
        for (const width of [24, 100]) {
          await terminal.resize(width);
          const content = 'PAD_TEXT_' + 'x'.repeat(width - 2 * padding - 3 - 'PAD_TEXT_'.length);
          terminal.send(content); await terminal.settle();
          const dump = await observe(terminal, `padding-${padding}-${width}-${terminals.length}-${cycle}`);
          assert.equal(dump.padding, padding); assert.equal(dump.identity, identity);
          assert.equal(dump.after.text, content); assert.equal(dump.statusRows.length, 2);
          const y = dump.screen.findIndex(row => row.includes('PAD_TEXT_'));
          const edgeY = dump.screen.findIndex(row => row.includes('╹▀'));
          assert.ok(y > 0 && edgeY > y);
          const background = await referenceCell(dump.styles.background), stripe = await referenceCell(dump.styles.border), bottom = await referenceCell(dump.styles.bottom);
          for (const line of [dump.cells[y], dump.cells[edgeY - 1]]) {
            assert.equal(line[padding].text, '┃'); assert.equal(line[padding].fg, stripe.fg);
            assert.equal(line[padding].bgMode, 0); assert.equal(line[padding + 1].text, ' ');
            for (let x = padding + 1; x < width - padding; x++) {
              assert.equal(line[x].bgMode, background.bgMode); assert.equal(line[x].bg, background.bg);
            }
          }
          assert.equal(dump.cells[y][width - padding - 1].inverse, true, 'end cursor occupies fixed internal right gap');
          for (const line of [dump.cells[y], dump.cells[edgeY - 1], dump.cells[edgeY]]) {
            for (let x = 0; x < width; x++) if (x < padding || x >= width - padding) {
              assert.equal(line[x].text, ' '); assert.equal(line[x].bgMode, 0); assert.equal(line[x].inverse, false);
            }
          }
          assert.equal(dump.cells[edgeY][padding].text, '╹');
          for (let x = padding + 1; x < width - padding; x++) {
            const cell = dump.cells[edgeY][x]; assert.equal(cell.text, '▀'); assert.equal(cell.bgMode, 0);
            assert.equal(cell.fgMode, bottom.fgMode); assert.equal(cell.fg, bottom.fg);
          }
          await assertFits([...dump.rows, ...dump.statusRows], width);
          if (mode === 'fullscreen') {
            await sgrAt(terminal, padding + 2, y);
            const click = await observe(terminal, `click-${padding}-${width}-${cycle}`);
            assert.deepEqual(click.after.cursor, { line: 0, col: 0 }); assert.equal(click.after.text, content);
          }
          terminal.send('\x03'); await terminal.settle();
        }
        terminal.send('/tv-d'); await terminal.settle();
        const menu = await observe(terminal, `menu-${padding}-${cycle}`);
        assert.equal(menu.menu, true); assert.deepEqual(menu.statusRows, []);
        const menuRow = menu.rows.find(row => plain(row).includes('tv-dump'));
        assert.ok(menuRow); assert.equal(plain(menuRow).search(/\S/u), padding + 2, 'native menu follows input text origin');
        assert.ok(!menu.screen.some(row => row.includes('╹▀')), 'edge remains hidden during autocomplete');
        terminal.send('\x1b'); await terminal.settle(); terminal.send('\x03'); await terminal.settle();
      }
      assert.equal(terminal.events().filter(event => event.type === 'start').length, 1, 'all geometry changes happen without reload');
      assert.equal(terminal.events().filter(event => event.type === 'tool_call' || event.type === 'context').length, 0, 'settings/drafts never become model traffic');
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});


test('aboveEditor widget separator stays immediately before input and follows zero height in real native layouts', { skip: stockOnly }, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `widget gap ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'widget controls preserve the actual draft and native cursor');
    assert.equal(dump.exactStockPrototype, true); assert.equal(dump.inputMethodUnchanged, true);
    assert.equal(dump.widgetCallsAfterEditor, dump.widgetCallsBeforeEditor, 'editor spacing never rerenders the foreign widget');
    return terminal.captureScreen(name, dump);
  };
  const change = async (terminal, name, action) => {
    // The action requests an ordinary native frame; inspect after that frame, not
    // an action-time manual editor render before its upper sibling has rendered.
    await observe(terminal, `${name}-action`, action);
    return observe(terminal, name);
  };
  const gap = async (dump, lastWidget, needle = 'WIDGET_INPUT_') => {
    assert.equal(dump.rows[0], '', 'SDK layout guard must activate: silently dropping the feature is a failing compatibility test');
    assert.ok(plain(dump.rows[1]).includes('┃'));
    const widgetY = dump.screen.findIndex(row => row.includes(lastWidget));
    const textY = dump.screen.findIndex(row => row.includes(needle));
    assert.ok(widgetY >= 0 && textY >= 0);
    assert.equal(textY, widgetY + 3, 'last widget, exterior empty row, existing panel padding, then input text');
    assert.equal(dump.cells[widgetY + 2][dump.padding].text, '┃', 'inside panel padding remains intact');
    for (const cell of dump.cells[widgetY + 1]) {
      assert.equal(cell.text.trim(), ''); assert.equal(cell.fgMode, 0); assert.equal(cell.bgMode, 0);
      assert.equal(cell.inverse, false); assert.equal(!!cell.bold, false);
    }
    const marker = dump.rows.find(row => row.includes('\x1b_pi:c\x07'));
    assert.ok(marker); assert.equal(dump.rows.filter(row => row.includes('\x1b_pi:c\x07')).length, 1);
    await assertFits([...dump.rows, ...dump.statusRows], dump.width);
  };
  const noGap = dump => {
    assert.notEqual(dump.rows[0], '', 'no additional editor-local empty row');
    assert.ok(plain(dump.rows[0]).includes('┃'));
    assert.ok(!dump.screen.some(row => /UPPER_WIDGET_A|LAST_UPPER_WIDGET_B/u.test(row)));
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-widget-gap-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const draft = 'WIDGET_INPUT_界é\n  SECOND_WIDGET_LINE';
      terminal.send('\x1b[200~' + draft + '\x1b[201~'); await terminal.settle();
      const baseline = await observe(terminal, 'absent'); noGap(baseline);
      const identity = baseline.identity;
      let dump = await change(terminal, 'lower-only', 'widget-lower'); noGap(dump);
      assert.equal(dump.rows.length, baseline.rows.length); assert.equal(dump.statusRows.length, 2);
      assert.ok(dump.screen.some(row => row.includes('LOWER_ONLY_WIDGET')));
      dump = await change(terminal, 'lower-removed', 'widget-lower-remove'); noGap(dump);
      dump = await change(terminal, 'registered-zero', 'widget-zero'); noGap(dump);
      assert.equal(dump.upperRegistered, true); assert.deepEqual(dump.upperRows, []);
      dump = await change(terminal, 'visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      assert.equal(dump.rows.length, baseline.rows.length + 1); assert.equal(dump.identity, identity);
      assert.equal(dump.after.expanded, draft); assert.ok(dump.widgetCallsBeforeEditor > 0);
      dump = await change(terminal, 'later-widget', 'widget-extra'); await gap(dump, 'LAST_UPPER_WIDGET_B');
      assert.equal(dump.rows.length, baseline.rows.length + 1, 'one gap for the whole group, not one per widget');
      dump = await change(terminal, 'one-zero', 'widget-zero'); await gap(dump, 'LAST_UPPER_WIDGET_B');
      dump = await change(terminal, 'all-zero', 'widget-extra-remove'); noGap(dump);
      assert.equal(dump.rows.length, baseline.rows.length);
      dump = await change(terminal, 'removed', 'widget-remove'); noGap(dump);
      dump = await change(terminal, 'visible-again', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await gap(dump, 'UPPER_WIDGET_A'); }
      for (const width of [24, 60, 100]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await gap(dump, 'UPPER_WIDGET_A'); }
      if (mode === 'fullscreen') {
        const widgetY = dump.screen.findIndex(row => row.includes('UPPER_WIDGET_A'));
        const cursor = dump.after.cursor;
        await sgrAt(terminal, 3, widgetY + 1); dump = await observe(terminal, 'gap-click');
        assert.deepEqual(dump.after.cursor, cursor, 'blank separator is not an input target');
        const textY = dump.screen.findIndex(row => row.includes('WIDGET_INPUT_'));
        await sgrAt(terminal, 3, textY); dump = await observe(terminal, 'input-click');
        assert.deepEqual(dump.after.cursor, { line: 0, col: 0 }, 'native y mapping compensates for the external prefix');
      }
      dump = await observe(terminal, 'off', 'off'); assert.notEqual(dump.rows[0], '');
      assert.ok(dump.rows.some(row => plain(row).includes('─')));
      dump = await observe(terminal, 'on', 'on'); await gap(dump, 'UPPER_WIDGET_A'); assert.equal(dump.identity, identity);
      terminal.send('\x03'); await terminal.settle(); terminal.send('/tv-d'); await terminal.settle();
      dump = await observe(terminal, 'menu'); assert.equal(dump.rows[0], ''); assert.deepEqual(dump.statusRows, []);
      const menuY = dump.screen.findIndex(row => row.includes('tv-dump') && !row.includes('/tv-d'));
      assert.ok(menuY >= 0);
      if (mode === 'fullscreen') { await sgrAt(terminal, 3, menuY); dump = await observe(terminal, 'menu-click'); assert.match(dump.after.text, /^\/tv-dump/u); }
      else { terminal.send('\t'); await terminal.settle(); }
      terminal.send('\x03'); await terminal.settle();
      assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'draft and widgets produce no model/tool traffic');
      await terminal.run('user-card'); const live = await terminal.capture('live-traffic');
      assert.equal(live.tools.length, 2); const bytes = readFileSync(live.session);
      const native = new PiTerminal(`editor-widget-gap-native-${mode}`, { mode, workspace: terminal.work, agentSettings: { editorPaddingX: 1 } });
      terminals.push(native); await native.ready(); await native.run('user-card'); await native.capture('native-traffic');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'same two real calls/results and three provider contexts remain exact');
      const opposite = mode === 'fullscreen' ? 'regular' : 'fullscreen';
      await terminal.command('/settings'); terminal.send('TUI mode'); await terminal.settle();
      assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ TUI mode\\s+${mode}\\s*$`, 'u').test(row)));
      terminal.send('\r'); await terminal.settle(); terminal.send('\x1b'); await terminal.settle();
      assert.equal(terminal.term.buffer.active.type, opposite === 'fullscreen' ? 'alternate' : 'normal');
      terminal.send('WIDGET_INPUT_MODE'); await terminal.settle(); dump = await observe(terminal, 'mode-replaced');
      await gap(dump, 'UPPER_WIDGET_A'); assert.equal(dump.identity, identity);
      terminal.send('\x03'); await terminal.settle();
      await terminal.command('/reload'); await terminal.event('start', 2);
      terminal.send('WIDGET_INPUT_RELOAD'); await terminal.settle(); dump = await observe(terminal, 'reload-absent'); noGap(dump);
      dump = await change(terminal, 'reload-visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      terminal.send('\x03'); await terminal.settle();
      assert.deepEqual(readFileSync(live.session), bytes, 'widgets and renderer/reload controls never rewrite stored traffic');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2));
      const replay = new PiTerminal(`editor-widget-gap-replay-${mode}`, { mode, session: live.session, workspace: terminal.work,
        agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready();
      dump = await observe(replay, 'replay-absent'); noGap(dump);
      replay.send('WIDGET_INPUT_REPLAY'); await replay.settle(); dump = await change(replay, 'replay-visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      replay.send('\x03'); await replay.settle();
      const replayDump = await replay.capture('replay-traffic');
      assert.deepEqual(replayDump.branch, live.branch); assert.deepEqual(readFileSync(live.session), bytes);
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'replay executes no new tools or model requests');
      writeFileSync(join(terminal.output, 'widget-gap-controls.json'), JSON.stringify({ mode, toolCalls: 2, toolResults: 2, providerContexts: 3,
        absent: baseline.rows.length, withUpperWidget: baseline.rows.length + 1, sameDraftEditor: identity, replayExecuted: 0 }, null, 2));
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});


// A real separately loaded extension owns this editor through setEditorComponent.
// Compare its complete input region with a process that never loads Toolview.
test('foreign editor extension retains native input, widgets, mouse and replay in both load orders', { skip: stockOnly, timeout: 240000 }, async () => {
  const terminals = [], coverage = [], workspace = mkdtempSync(join(tmpdir(), 'toolview-foreign-work-'));
  const ownerExtension = join(fixtures, 'foreign-editor.ts');
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'foreign-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `foreign editor ${name}`);
    await terminal.settle(!dump.idle); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'observation, themes and empty-draft takeover do not exchange draft data');
    const buffer = terminal.term.buffer.active;
    return terminal.captureScreen(name, { ...dump, hardware: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY } });
  };
  const region = dump => {
    assert.equal(dump.factoryOwned, true, 'actual public editor factory, not a mocked nativeEditor option');
    assert.deepEqual(dump.aboveRows, ['', 'FOREIGN_UPPER_ROW']);
    assert.deepEqual(dump.belowRows, ['FOREIGN_LOWER_ROW'], 'no Toolview metadata/edge rows, even with its widget registered');
    assert.equal(dump.padding, 2, 'foreign geometry is not converted to Toolview exterior margins');
    assert.equal(dump.git.watchers, 0, 'foreign editor releases Toolview Git watches');
    assert.equal(dump.git.activeJobs, 0, 'foreign editor starts no Toolview Git work');
    if (dump.custom) assert.equal(dump.ownerMethods, true, 'foreign render, input and mouse methods retain ownership');
    assert.doesNotMatch(dump.rows.map(plain).join('\n'), /┃|╹|▀/u, 'no panel, half-block edge or injected decoration');
    assert.notEqual(dump.rows[0], '', 'no Toolview upper-widget separator');
    const top = dump.screen.findIndex(row => row === 'FOREIGN_UPPER_ROW');
    assert.ok(top >= 0, 'real upper widget is painted');
    const rows = dump.rows.map(row => plain(row.replaceAll('\x1b_pi:c\x07', '')));
    const physical = dump.screen.slice(top + 1, top + 1 + rows.length).map(plain);
    if (!dump.idle && dump.embedWorkingStatus) {
      // Native clock ticks between the packet and the physical-screen sample.
      // Only its single top-border frame glyph is explicitly variable.
      const frame = row => row.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, '<native-frame>');
      rows[0] = frame(rows[0]); physical[0] = frame(physical[0]);
    }
    assert.deepEqual(physical, rows, 'foreign editor begins immediately after upper widget; no invisible inserted row');
    assert.equal(dump.screen[top + 1 + rows.length], 'FOREIGN_LOWER_ROW', 'own lower widget immediately follows editor/menu');
    return { top, cells: dump.cells.slice(top, top + rows.length + 2), rows };
  };
  const framePattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
  const phaseRows = rows => rows.map(row => plain(row).includes('Working') ? row.replace(framePattern, '<native-frame>') : row);
  const phaseCells = (cells, rowIndex) => {
    const indexes = cells[rowIndex].flatMap((cell, x) => framePattern.test(cell.text) ? [x] : []);
    assert.equal(indexes.length, 1, 'exactly one identified native spinner cell');
    return cells.map((row, y) => row.map((cell, x) => y === rowIndex && x === indexes[0] ? { ...cell, text: '<native-frame>' } : cell));
  };
  const same = (native, live) => {
    const control = region(native), actual = region(live);
    assert.equal(live.idle, native.idle);
    const busy = !native.idle;
    assert.deepEqual(busy ? phaseRows(live.rows) : live.rows, busy ? phaseRows(native.rows) : native.rows,
      'complete ANSI render matches native; only its identified animation glyph may vary');
    assert.deepEqual(busy ? phaseRows(live.nativeStatusRows) : live.nativeStatusRows,
      busy ? phaseRows(native.nativeStatusRows) : native.nativeStatusRows, 'separate native status rows remain untouched');
    assert.deepEqual(busy && live.embedWorkingStatus ? phaseCells(actual.cells, 1) : actual.cells,
      busy && native.embedWorkingStatus ? phaseCells(control.cells, 1) : control.cells,
      'all physical input/widget colors and attributes match native, including the spinner cell');
    if (busy) {
      const indicatorCells = dump => {
        const row = dump.screen.findIndex(text => text.includes('Working'));
        assert.ok(row >= 0, 'native Working is physically visible');
        return phaseCells([dump.cells[row]], 0);
      };
      assert.deepEqual(indicatorCells(live), indicatorCells(native), 'physical native indicator glyph attributes remain unchanged in either placement');
    }
    assert.deepEqual({ x: live.hardware.x, y: live.hardware.y - actual.top },
      { x: native.hardware.x, y: native.hardware.y - control.top }, 'hardware cursor geometry remains native');
    assert.deepEqual(live.after, native.after, 'text, expanded paste and cursor match native');
    assert.equal(live.menu, native.menu); assert.equal(live.mode, native.mode);
    assert.equal(live.footerOwner, 'FooterComponent');
    assert.deepEqual(live.footerRows, native.footerRows, 'disabled input restores the complete native footer data/ANSI at every lifecycle phase');
    assert.deepEqual(live.mouseEvents, native.mouseEvents, 'complete foreign mouse events including absolute screen coordinates stay native with the native footer');
  };
  try {
    for (const mode of ['fullscreen', 'regular']) for (const order of ['foreign-first', 'toolview-first']) {
      const prefix = `${mode}-${order}`, deferred = order === 'toolview-first';
      const embedded = !deferred;
      const extraEnv = { TOOLVIEW_TEST_DEFER_EDITOR: deferred ? '1' : '0', TOOLVIEW_TEST_FOREIGN_EMBED: embedded ? '1' : '0' };
      const sharedWork = join(workspace, prefix); mkdirSync(sharedWork, { recursive: true });
      const native = new PiTerminal(`foreign-native-${prefix}`, { mode, workspace: sharedWork, agentSettings: { editorPaddingX: 2 }, extensions: [ownerExtension], extraEnv });
      terminals.push(native); await native.ready();
      const live = new PiTerminal(`foreign-live-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, workspace: native.work, extraEnv,
        extensions: order === 'foreign-first' ? [ownerExtension, extension] : [extension, ownerExtension] });
      terminals.push(live); await live.ready();
      if (deferred) {
        const warm = await observe(live, 'stock-warm');
        assert.ok(warm.rows.some(row => plain(row).includes('┃')), 'production Toolview was active before late takeover');
        assert.equal(warm.rows[0], '', 'warm upper-widget measurement exists before ownership changes');
        assert.equal(warm.footerOwner, 'FooterView', 'footer starts enabled beside the recognized stock editor');
        assert.equal(warm.belowRows.length, 3, 'both Toolview rows existed before takeover beside the owner widget');
        await observe(native, 'install', 'install'); await observe(live, 'install', 'install');
      }
      let stock = await observe(native, 'initial'), styled = await observe(live, 'initial'); same(stock, styled);
      assert.equal(styled.custom, true); assert.equal(styled.mode, false);
      assert.equal(styled.footerOwner, 'FooterComponent', 'foreign editor disables Toolview footer as well as input styling');
      assert.equal(stock.footerOwner, 'FooterComponent');
      const identity = styled.identity, ownerQueries = styled.git.queries;
      const pair = async (name, action = 'snapshot') => {
        stock = await observe(native, name, action); styled = await observe(live, name, action); same(stock, styled);
        assert.equal(styled.identity, identity, 'ordinary Toolview/UI actions never replace the foreign editor');
        assert.equal(styled.git.queries, ownerQueries, 'foreign editor frames/operations do not query Git');
      };
      const send = async data => { native.send(data); live.send(data); await native.settle(); await live.settle(); };
      await send('\x1b\x18'); await pair('own-key'); assert.equal(styled.mode, true, 'extension-specific key remains effective');
      const draft = 'FOREIGN_INPUT_界é\n  FOREIGN_SECOND';
      await send('\x1b[200~' + draft + '\x1b[201~'); await pair('draft'); assert.equal(styled.after.expanded, draft);
      if (mode === 'fullscreen') {
        const clicked = new Map();
        for (const terminal of [native, live]) {
          const dump = terminal === native ? stock : styled;
          const y = dump.screen.findIndex(row => row.includes('FOREIGN_INPUT_')); clicked.set(terminal, y);
          assert.ok(y >= 0); await sgrAt(terminal, 2, y);
        }
        await pair('mouse'); assert.deepEqual(styled.after.cursor, { line: 0, col: 0 });
        assert.ok(styled.mouseEvents.length > 0, 'actual fullscreen mouse dispatch reaches the foreign override');
        for (const [terminal, dump] of [[native, stock], [live, styled]]) for (const event of dump.mouseEvents.slice(-3))
          assert.equal(event.screenY, clicked.get(terminal), 'absolute screen coordinate equals its actual physical click, not a fixed footer assumption');
        await send('Z'); await pair('insert'); assert.equal(styled.after.expanded, 'Z' + draft);
        await send('\x1f'); await pair('undo-insert'); assert.equal(styled.after.expanded, draft);
      }
      for (const width of [24, 60, 100]) {
        await native.resize(width); await live.resize(width); await pair(`width-${width}`); await assertFits(styled.rows, width);
      }
      for (const theme of ['light', 'dark']) await pair(theme, theme);
      await send('\x1f'); await pair('undo-paste'); assert.equal(styled.after.expanded, '');
      const paste = 'FOREIGN_PASTE_界é_'.repeat(100);
      await send('\x1b[200~' + paste + '\x1b[201~'); await pair('large-paste');
      assert.match(styled.after.text, /\[paste #/u); assert.equal(styled.after.expanded, paste);
      await send('\x1f'); await pair('large-undo'); assert.equal(styled.after.expanded, '');
      await send('/tv-d'); await pair('menu'); assert.equal(styled.menu, true);
      const menuClicked = new Map();
      if (mode === 'fullscreen') {
        for (const terminal of [native, live]) {
          const dump = terminal === native ? stock : styled;
          const y = dump.screen.findIndex(row => row.includes('tv-dump') && !row.includes('/tv-d')); menuClicked.set(terminal, y);
          assert.ok(y >= 0); await sgrAt(terminal, 5, y);
        }
      } else await send('\t');
      await pair('completion'); assert.match(styled.after.text, /^\/tv-dump/u);
      if (mode === 'fullscreen') for (const [terminal, dump] of [[native, stock], [live, styled]]) for (const event of dump.mouseEvents.slice(-3))
        assert.equal(event.screenY, menuClicked.get(terminal), 'autocomplete handler retains the independently measured physical click row');
      await send('\x03'); await pair('cleared');
      for (const action of ['off', 'on']) {
        await live.command(`/toolview ${action}`); await pair(action);
      }
      // A factory returning the exact stock class must also remain untouched.
      await observe(native, 'factory-stock', 'factory-stock'); await observe(live, 'factory-stock', 'factory-stock');
      stock = await observe(native, 'factory-stock-rows'); styled = await observe(live, 'factory-stock-rows'); same(stock, styled);
      assert.equal(styled.custom, false);
      assert.equal(styled.footerOwner, 'FooterComponent', 'even an exact stock class returned by a foreign factory keeps footer native');
      // Restore our subclass before testing native active status and history.
      await observe(native, 'owner-return', 'install'); await observe(live, 'owner-return', 'install');
      native.send('run pending\r'); live.send('run pending\r');
      await native.event('provider_gate'); await live.event('provider_gate');
      stock = await observe(native, 'working'); styled = await observe(live, 'working');
      for (const dump of [stock, styled]) {
        region(dump); assert.equal(dump.idle, false);
        const editorWorking = dump.rows.map(plain).join('\n').includes('Working');
        const separateWorking = dump.nativeStatusRows.map(plain).join('\n').includes('Working');
        assert.equal(editorWorking, embedded, 'native embedding follows the foreign factory option');
        assert.equal(separateWorking, !embedded, 'non-embedded native status retains its own container');
        assert.equal(dump.screen.filter(row => row.includes('Working')).length, 1, 'one physical native indicator, never a belowEditor duplicate');
      }
      same(stock, styled); // Includes active physical colors, spinner attributes and hardware cursor.
      for (const terminal of [native, live]) {
        writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
        writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      }
      stock = await observe(native, 'completed'); styled = await observe(live, 'completed'); same(stock, styled);
      const nativeTraffic = await native.capture('foreign-native-traffic'), liveTraffic = await live.capture('foreign-live-traffic');
      assert.deepEqual(traffic(live, 2), traffic(native, 2), 'two calls/results and three model contexts remain exact');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      const activeTools = (dump, control) => {
        assert.equal(dump.tools.length, 2);
        const read = byName(dump, 'read')[0]; compactContent(read);
        assert.equal(summaryText(read), summaryExpected('read a.txt'), 'known Toolview compact read presentation stays active');
        assert.doesNotMatch(lines(read).join('\n'), /READ_A_CONTENT/u, 'Toolview read summary does not show native result body');
        assert.notDeepEqual(toolLines(dump), toolLines(control), 'only editor integration is skipped, not Toolview tool presentation');
        assert.deepEqual(toolLines(dump), toolLines(liveTraffic), 'Toolview layouts survive ownership/lifecycle boundaries');
      };
      activeTools(liveTraffic, nativeTraffic);
      const bytes = readFileSync(liveTraffic.session);
      for (const terminal of [native, live]) {
        await terminal.command('/reload'); await terminal.event('start', 2);
      }
      stock = await observe(native, 'reload'); styled = await observe(live, 'reload'); same(stock, styled);
      assert.equal(styled.footerOwner, 'FooterComponent');
      const nativeReload = await native.capture('foreign-native-reload-tools'), liveReload = await live.capture('foreign-live-reload-tools');
      activeTools(liveReload, nativeReload);
      assert.deepEqual(traffic(live, 2), traffic(native, 2), 'reload adds no model/tool traffic');
      assert.deepEqual(readFileSync(liveTraffic.session), bytes, 'UI reload does not change saved session bytes');
      const replayNative = new PiTerminal(`foreign-native-replay-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, extraEnv: { TOOLVIEW_TEST_FOREIGN_EMBED: embedded ? '1' : '0' }, session: liveTraffic.session, workspace: native.work, extensions: [ownerExtension] });
      const replayLive = new PiTerminal(`foreign-live-replay-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, extraEnv: { TOOLVIEW_TEST_FOREIGN_EMBED: embedded ? '1' : '0' }, session: liveTraffic.session, workspace: native.work,
        extensions: order === 'foreign-first' ? [ownerExtension, extension] : [extension, ownerExtension] });
      terminals.push(replayNative, replayLive); await replayNative.ready(); await replayLive.ready();
      const unstyled = await observe(replayNative, 'replay'), resumed = await observe(replayLive, 'replay'); same(unstyled, resumed);
      assert.equal(resumed.footerOwner, 'FooterComponent', 'saved replay keeps footer native with the foreign editor');
      const nativeReplay = await replayNative.capture('foreign-native-replay-traffic'), liveReplay = await replayLive.capture('foreign-live-replay-traffic');
      activeTools(liveReplay, nativeReplay);
      for (const [terminal, dump] of [[replayNative, nativeReplay], [replayLive, liveReplay]]) {
        assert.deepEqual(persisted(dump), persisted(liveTraffic));
        assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      }
      assert.deepEqual(readFileSync(liveTraffic.session), bytes);
      coverage.push({ mode, order, runtimeTakeover: deferred, embeddedWorking: embedded, calls: 2, results: 2, modelContexts: 3, replayNewTraffic: 0 });
    }
    writeFileSync(join(artifacts, 'foreign-editor-coverage.json'), JSON.stringify({ installedPowerlineExecuted: false, coverage }, null, 2));
  } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } rmSync(workspace, { recursive: true, force: true }); }
});


test('right-aligned cwd and live Git branch preserve colors padding and zero hot-frame queries', { skip: stockOnly }, async () => {
  const terminals = [], base = mkdtempSync(join(tmpdir(), 'toolview-cwd-cli-'));
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action })); terminal.send('\x1b\x04');
    const dump = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `directory ${name}`);
    await terminal.settle(!dump.idle); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before); return terminal.captureScreen(name, dump);
  };
  const check = async (dump, { full = false, branch, name } = {}) => {
    assert.equal(dump.statusRows.length, 2); await assertFits(dump.statusRows, dump.width);
    const edge = dump.screen.findIndex(row => row.includes('╹▀')), y = edge - 1;
    assert.ok(y >= 0); const text = dump.screen[y].trimEnd(), cells = dump.cells[y];
    assert.equal(text, plain(dump.statusRows[0]), 'actual physical metadata row equals current component output');
    assert.equal(cells[dump.width - 2].text, ' ', 'exactly one painted right-padding cell');
    assert.equal(cells[dump.width - 1].bgMode, 0, 'exterior Editor padding remains unpainted');
    const bg = await referenceCell(dump.styles.background);
    assert.equal(cells[dump.width - 2].bg, bg.bg);
    assert.equal(cells[dump.width - 2].bgMode, bg.bgMode);
    const fg = async (start, count, style) => {
      const reference = await referenceCell(style);
      for (let x = start; x < start + count; x++) { assert.equal(cells[x].fg, reference.fg); assert.equal(cells[x].fgMode, reference.fgMode); }
    };
    if (full) {
      const right = dump.cwd + (branch ? ':' + branch : '');
      assert.ok(text.endsWith(right), 'full ctx.cwd and actual named branch are right-aligned');
      const start = dump.width - 2 - visibleWidth(right), nameX = start + visibleWidth(dump.cwd.slice(0, -name.length));
      assert.equal(cells[dump.width - 3].text, [...(branch || name)].at(-1) === '\u0301' ? 'é' : [...(branch || name)].at(-1));
      await fg(start, nameX - start, dump.styles.parent);
      await fg(nameX, visibleWidth(name), dump.styles.directory);
      if (branch) { const colon = nameX + visibleWidth(name); await fg(colon, 1, dump.styles.colon); await fg(colon + 1, visibleWidth(branch), dump.styles.branch); }
      assert.ok(text.slice(0, start).endsWith('  '), 'at least two spaces separate left and right');
    } else if (dump.width >= 60) assert.ok(text.includes(name), 'complete last directory outranks branch at medium width');
    assert.ok(!text.includes('Working'), 'activity is never budgeted into metadata');
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const repo = join(base, mode), name = 'important-界é', workspace = join(repo, 'parent', name);
      mkdirSync(workspace, { recursive: true });
      const git = (...args) => { const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
      let branch = 'feature/input-status'; git('init', '-b', branch);
      const terminal = new PiTerminal(`cwd-${mode}`, { mode, workspace, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(220);
      let dump = await observe(terminal, 'full'); await check(dump, { full: true, branch, name });
      assert.equal(dump.cwd, workspace); assert.ok(dump.git.watchers >= 2);
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await check(dump, { full: true, branch, name }); }
      const baseline = dump.git;
      for (let i = 0; i < 3; i++) { dump = await observe(terminal, `hot-${i}`); assert.equal(dump.git.queries, baseline.queries); assert.equal(dump.git.spawned, baseline.spawned); }
      for (const width of [100, 60, 24, 220]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await check(dump, { full: width === 220, branch, name }); }
      branch = 'external-next'; git('symbolic-ref', 'HEAD', 'refs/heads/' + branch); await terminal.settle();
      let external = 0;
      dump = await until(async () => {
        const value = await observe(terminal, `external-branch-${external++}`);
        return value.git.activeJobs === 0 && plain(value.statusRows[0] || '').includes(':' + branch) ? value : false;
      }, 'Git watch publishes external branch before physical capture');
      await check(dump, { full: true, branch, name });
      assert.ok(dump.git.branchReads > baseline.branchReads, 'external atomic HEAD mutation refreshes Git snapshot');
      terminal.send('/tv-d'); await terminal.settle(); dump = await observe(terminal, 'menu'); assert.deepEqual(dump.statusRows, []);
      terminal.send('\x03'); await terminal.settle();
      terminal.send('run pending\r'); await terminal.event('provider_gate');
      dump = await observe(terminal, 'busy'); const busy = dump.git;
      for (let i = 0; i < 3; i++) {
        dump = await observe(terminal, `busy-hot-${i}`); await check(dump, { full: true, branch, name });
        assert.equal(dump.git.queries, busy.queries); assert.equal(dump.git.spawned, busy.spawned);
        assert.ok(!dump.screen.some(row => row.includes(' • Idle'))); assert.ok(dump.screen.some(row => row.includes('Working')));
      }
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end');
      const complete = await terminal.capture('directory-traffic'); assert.equal(complete.tools.length, 2);
      dump = await observe(terminal, 'idle-after-operations'); await check(dump, { full: true, branch, name });
      assert.ok(dump.screen.some(row => row.includes(' • Idle')));
      const off = await observe(terminal, 'off', 'off'); assert.deepEqual(off.statusRows, []);
      assert.equal(off.git.watchers, 0); assert.equal(off.git.activeJobs, 0);
      dump = await observe(terminal, 'on', 'on'); await terminal.settle(); dump = await observe(terminal, 'on-ready'); await check(dump, { full: true, branch, name });
      await terminal.command('/reload'); await terminal.event('start', 2); dump = await observe(terminal, 'reload'); await check(dump, { full: true, branch, name });
      const native = new PiTerminal(`cwd-native-${mode}`, { mode, workspace }); terminals.push(native); await native.ready();
      native.send('run pending\r'); await native.event('provider_gate'); writeFileSync(join(native.output, 'provider-go'), 'go'); await native.event('tool_gate');
      writeFileSync(join(native.output, 'tool-go'), 'go'); await native.event('agent_end');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'cwd/status presentation leaves model traffic unchanged');
      const replay = new PiTerminal(`cwd-replay-${mode}`, { mode, workspace, session: terminal.session,
        agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready(); await replay.resize(220);
      const replayDump = await observe(replay, 'replay'); await check(replayDump, { full: true, branch, name });
      const persisted = await replay.capture('replay-traffic'); assert.deepEqual(persisted.branch, complete.branch);
      rmSync(join(repo, '.git'), { recursive: true }); await terminal.settle();
      let removed = 0;
      dump = await until(async () => {
        const value = await observe(terminal, `no-repository-${removed++}`);
        return value.git.activeJobs === 0 && plain(value.statusRows[0] || '').endsWith(value.cwd) ? value : false;
      }, 'repository removal clears branch before physical capture');
      await check(dump, { full: true, name });
      assert.ok(!dump.screen.some(row => row.endsWith(':' + branch)), 'no stale branch after repository removal');
      writeFileSync(join(terminal.output, 'git-counters.json'), JSON.stringify({ warm: baseline, busy: busy, final: dump.git }, null, 2));
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } rmSync(base, { recursive: true, force: true }); }
});


async function footerObserve(terminal, name, action = 'snapshot', animated = false) {
  writeFileSync(join(terminal.output, 'footer-request.json'), JSON.stringify({ name, action }));
  terminal.send('\x1b\x06');
  const dump = await until(() => {
    terminal.health();
    try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, `footer ${name}`);
  await terminal.settle(animated); terminal.session = dump.session;
  return terminal.captureScreen(name, dump);
}
function footerPhysical(dump) {
  const expected = dump.rows.map(plain), starts = dump.screen.flatMap((row, y) => plain(row) === expected[0] &&
    expected.every((value, offset) => plain(dump.screen[y + offset] || '') === value) ? [y] : []);
  assert.ok(starts.length > 0, `complete physical footer at ${dump.width}: ${expected.join('|')}`);
  for (const row of dump.rows) assert.ok(visibleWidth(row) <= dump.width);
  return starts.at(-1);
}

test('footer whole-status fitting colors native data warm counters ownership and replay in both modes', { skip: stockOnly }, async () => {
  const terminals = [], observations = [];
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const options = { mode, extraEnv: { TOOLVIEW_TEST_FOOTER: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] };
      const native = new PiTerminal(`footer-native-${mode}`, options); terminals.push(native); await native.ready();
      await native.run('future'); const nativeTraffic = await native.capture('traffic');
      const control = await footerObserve(native, 'accounting', 'accounting'); assert.equal(control.owner, 'FooterComponent');
      const live = new PiTerminal(`footer-live-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TOOLVIEW_TEST_FOOTER_PRESENTATION: '1' }, workspace: native.work }); terminals.push(live); await live.ready();
      await live.run('future'); const liveTraffic = await live.capture('traffic');
      const packet = await footerObserve(live, 'accounting', 'accounting');
      assert.equal(packet.owner, 'FooterView'); footerPhysical(packet);
      const usage = dump => dump.entries.flatMap(e => e.type === 'usage' ? [e.usage] : e.type === 'message' && e.message.role === 'assistant' ? [e.message.usage] : []);
      assert.deepEqual(usage(packet), usage(control), 'identical actual persisted usage for native and Toolview');
      assert.deepEqual(packet.context, control.context, 'same native current context estimate');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      assert.deepEqual(live.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)), native.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)));
      assert.equal(live.events().filter(e => e.type === 'call').length, 1); assert.equal(live.events().filter(e => e.type === 'result').length, 1);
      const bytes = readFileSync(packet.session);
      let dump = await footerObserve(live, 'statuses', 'statuses'); footerPhysical(dump);
      for (const width of [24, 60, 100, 140]) {
        await live.resize(width); dump = await footerObserve(live, `width-${width}`); const y = footerPhysical(dump);
        const text = dump.rows.map(plain).join('\n');
        for (const [, value] of dump.statuses) assert.ok(text.includes(plain(value)), 'ordinary status is never broken or truncated merely for leftover space');
        for (const row of dump.rows.map(plain)) assert.ok(!/^\s*•|•\s*$/u.test(row), 'no separator at row break');
        if (width === 140) {
          assert.equal(dump.rows.length, 1); const row = dump.screen[y];
          assert.ok(row.endsWith('OTHER_STATUS'), 'right edge is fully aligned');
          const refs = Object.fromEntries(await Promise.all(Object.entries(dump.styles).map(async ([role, style]) => [role, await referenceCell(style)])));
          const check = (value, role, offset = 0, count = value.length - offset) => {
            const x = row.indexOf(value); assert.ok(x >= 0, value);
            for (let i = x + offset; i < x + offset + count; i++) { const cell = dump.cells[y][i]; assert.equal(cell.fgMode, refs[role].fgMode, value); assert.equal(cell.fg, refs[role].fg, value); }
          };
          assert.doesNotMatch(row, /↑|↓|R243|W\d|\$|\(sub\)|\(auto\)/u);
          check('272k', 'muted'); check('········', 'muted'); check('▂▂', 'warning'); check('[', 'dim'); check(']', 'dim');
          const context = /^\[[^\]]{10}\] CH86\.4% • (\d+k\/272k) \(/u.exec(row); assert.ok(context); check(context[1], 'text', 0, context[1].indexOf('/'));
          check('/', 'dim'); check('(', 'dim'); check(')', 'dim'); check('CH86.4%', 'warning'); check(' • ', 'dim');
          const producer = 'mc: 104.5K (51%) · idle'; check(producer, 'success');
          const separator = row.indexOf(' • ', row.indexOf(producer) + producer.length);
          assert.ok(separator > row.indexOf(producer), 'check the producer separator independently of the statistics bullet');
          for (let i = separator; i < separator + 3; i++) {
            const cell = dump.cells[y][i]; assert.equal(cell.fgMode, refs.dim.fgMode); assert.equal(cell.fg, refs.dim.fg);
            assert.equal(cell.bgMode, 0); assert.ok(!cell.bold && !cell.italic && !cell.underline && !cell.inverse);
          }
          const other = row.indexOf('OTHER_STATUS'); assert.ok(dump.cells[y][other].bold, 'producer attributes remain unchanged');
        }
      }
      for (const action of ['light', 'dark']) { dump = await footerObserve(live, action, action); footerPhysical(dump); }
      dump = await footerObserve(live, 'long', 'long'); await live.resize(24); dump = await footerObserve(live, 'long-narrow'); footerPhysical(dump);
      const long = dump.rows.map(plain).filter(row => row.includes('LONG_STATUS_')); assert.equal(long.length, 1); assert.ok(long[0].endsWith('…'));
      dump = await footerObserve(live, 'delete', 'delete'); assert.ok(!dump.rows.map(plain).join('\n').includes('OTHER_STATUS'));
      dump = await footerObserve(live, 'clear', 'clear'); assert.ok(!dump.rows.map(plain).join('\n').includes('LONG_STATUS_'));
      await live.resize(100);
      for (const enabled of [false, true]) {
        const before = await footerObserve(live, `auto-before-${enabled}`);
        await live.command('/settings'); live.send('Auto-compact'); await live.settle();
        assert.ok(live.screen().some(row => row.includes('Auto-compact')), 'actual native settings row is selected');
        live.send('\r\x1b'); await live.settle();
        const changed = await footerObserve(live, `auto-${enabled}`); footerPhysical(changed);
        assert.equal(changed.rows.map(plain).join('\n').includes('(auto off)'), !enabled, 'native auto setting changes footer warning without reload');
        assert.ok(!changed.rows.map(plain).join('\n').includes('(auto)'), 'enabled auto no longer adds noise');
        if (!enabled) {
          const y = footerPhysical(changed), x = changed.screen[y].indexOf('(auto off)'); assert.ok(x >= 0);
          const warning = await referenceCell(changed.styles.warning), dim = await referenceCell(changed.styles.dim);
          for (let i = 0; i < '(auto off)'.length; i++) { const ref = i === 0 || i === 9 ? dim : warning; assert.equal(changed.cells[y][x + i].fg, ref.fg); }
        }
        for (const key of ['scans', 'contextReads', 'aggregations', 'entries']) assert.equal(changed.counters[key], before.counters[key], 'auto is presentation-only, not a history/context invalidation');
      }
      assert.deepEqual(readFileSync(packet.session), bytes, 'status/theme/resize/settings actions do not rewrite saved usage or session data');
      await live.command('/toolview off'); dump = await footerObserve(live, 'off'); assert.equal(dump.owner, 'FooterComponent');
      assert.ok(dump.rows.some(row => plain(row).includes(live.work)), 'off restores native cwd');
      await live.command('/toolview on'); dump = await footerObserve(live, 'on'); assert.equal(dump.owner, 'FooterView'); footerPhysical(dump);
      dump = await footerObserve(live, 'foreign', 'foreign'); await live.command('/toolview off'); dump = await footerObserve(live, 'foreign-off');
      assert.deepEqual(dump.rows, ['FOREIGN_FOOTER']); assert.equal(dump.foreignDisposals, 0, 'off never removes a later owner'); footerPhysical(dump);
      await live.command('/toolview on'); dump = await footerObserve(live, 'reclaimed'); assert.equal(dump.owner, 'FooterView'); assert.equal(dump.foreignDisposals, 1);
      await live.command('/reload'); dump = await footerObserve(live, 'reloaded', 'accounting'); assert.equal(dump.owner, 'FooterView');
      assert.deepEqual(usage(dump), usage(packet), 'reload never duplicates fixture side usage'); footerPhysical(dump);
      const warm = await footerObserve(live, 'warm');
      for (let i = 0; i < 8; i++) { const next = await footerObserve(live, `warm-${i}`); assert.deepEqual(next.counters, warm.counters, 'warm frames reuse stats/context/layout with zero scans'); }
      const replay = new PiTerminal(`footer-replay-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TOOLVIEW_TEST_FOOTER_PRESENTATION: '1' }, session: packet.session, workspace: live.work }); terminals.push(replay); await replay.ready();
      const resumed = await footerObserve(replay, 'accounting', 'accounting'); footerPhysical(resumed);
      assert.deepEqual(usage(resumed), usage(packet)); assert.deepEqual(resumed.rows, dump.rows, 'same usage/context presentation in live reload and saved replay');
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0, 'replay executes no tools or provider requests');
      observations.push({ mode, warm: warm.counters, nativeContext: control.context, replayContext: resumed.context });
    }
    writeFileSync(join(artifacts, 'footer-counters.json'), JSON.stringify(observations, null, 2));
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});

test('footer cache history tracks every real request including equal CH, cold zero, unknown, colors and replay', { skip: stockOnly, timeout: 180000 }, async () => {
  const terminals = [];
  const options = { extraEnv: { TOOLVIEW_TEST_FOOTER: '1', TOOLVIEW_TEST_FOOTER_HISTORY: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] };
  const reports = dump => dump.entries.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => {
    const u = e.message.usage, prompt = u.input + u.cacheRead + u.cacheWrite;
    return prompt > 0 ? u.cacheRead / prompt * 100 : undefined;
  });
  const expected = history => {
    const last = history.slice(-10), chars = [];
    for (let i = 0; i < 10 - last.length; i++) chars.push({ glyph: '·', role: 'muted' });
    for (const raw of last) {
      const rate = raw === undefined ? undefined : Number(raw.toFixed(1));
      chars.push(rate === undefined ? { glyph: '·', role: 'muted' } : {
        glyph: [...'▁▂▃▄▅▆▇█'][Math.round(7 * (1 - rate / 100))], role: rate >= 95 ? 'success' : rate < 80 ? 'error' : 'warning' });
    }
    const rate = history.at(-1), ch = rate === undefined ? 'CH—' : 'CH' + rate.toFixed(1) + '%';
    return { chars, text: '[' + chars.map(x => x.glyph).join('') + '] ' + ch };
  };
  const check = async dump => {
    const y = footerPhysical(dump), text = dump.rows.map(plain)[0], value = expected(reports(dump));
    assert.ok(text.startsWith(value.text), 'ten saved reports and latest CH precede current context');
    const suffix = text.slice(value.text.length);
    if (dump.context) assert.match(suffix, /^ • (?:\d+(?:\.\d+)?[kM]|\?)\/\d+(?:\.\d+)?[kM]/u, 'context follows the cache block');
    else assert.ok(suffix === '' || suffix === ' • (auto off)', 'no trailing separator without context or auto-off');
    assert.equal(dump.rows.length, 1, 'statistics is one status, never internally wrapped');
    const x = text.indexOf('['), refs = Object.fromEntries(await Promise.all(Object.entries(dump.styles).map(async ([role, style]) => [role, await referenceCell(style)])));
    for (let i = 0; i < 10; i++) {
      assert.equal(dump.cells[y][x + 1 + i].text, value.chars[i].glyph);
      assert.equal(dump.cells[y][x + 1 + i].fg, refs[value.chars[i].role].fg);
      assert.equal(dump.cells[y][x + 1 + i].fgMode, refs[value.chars[i].role].fgMode);
    }
    for (const i of [x, x + 11]) assert.equal(dump.cells[y][i].fg, refs.dim.fg);
    return value.text;
  };
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const native = new PiTerminal(`footer-history-native-${mode}`, { ...options, mode }); terminals.push(native); await native.ready();
      const live = new PiTerminal(`footer-history-live-${mode}`, { ...options, mode, workspace: native.work,
        extraEnv: { ...options.extraEnv, TOOLVIEW_TEST_FOOTER_PRESENTATION: '1' } }); terminals.push(live); await live.ready();
      let dump = await footerObserve(live, 'empty', 'accounting'); assert.equal(await check(dump), '[··········] CH—');
      for (const terminal of [native, live]) await terminal.run('footer-cold');
      dump = await footerObserve(live, 'cold', 'accounting'); assert.equal(await check(dump), '[·········█] CH0.0%');
      for (const terminal of [native, live]) await terminal.run('footer-history');
      dump = await footerObserve(live, 'twenty', 'accounting'); assert.equal(reports(dump).length, 21);
      assert.deepEqual(reports(dump).slice(-20), Array(20).fill(10)); assert.equal(await check(dump), '[▇▇▇▇▇▇▇▇▇▇] CH10.0%');
      for (const terminal of [native, live]) await terminal.run('footer-varied');
      dump = await footerObserve(live, 'varied', 'accounting'); assert.equal(reports(dump).length, 33); await check(dump);
      for (const action of ['light', 'dark']) {
        await footerObserve(live, action, action); dump = await footerObserve(live, `${action}-colors`, 'accounting'); await check(dump);
      }
      const initialRows = dump.rows, file = dump.session, bytes = readFileSync(file), context = dump.context;
      const warm = await footerObserve(live, 'history-warm');
      for (let i = 0; i < 4; i++) {
        const next = await footerObserve(live, `history-hot-${i}`);
        assert.deepEqual(next.rows, warm.rows); assert.deepEqual(next.counters, warm.counters, 'renders append no cache samples and perform zero history/context/layout work');
      }
      const cachePrefix = expected(reports(dump)).text;
      for (const width of [24, 60, 100]) {
        await live.resize(width); const narrow = await footerObserve(live, `history-width-${width}`); footerPhysical(narrow);
        assert.equal(narrow.rows.length, 1, 'our complete status is never internally wrapped');
        const text = plain(narrow.rows[0]); assert.equal(text.endsWith('…'), width === 24);
        assert.ok(text.startsWith(cachePrefix), 'narrow clipping keeps the full cache block from the preceding saved-report snapshot before the context tail');
      }
      await live.command('/toolview off'); await live.command('/toolview on'); dump = await footerObserve(live, 'history-on', 'accounting');
      assert.deepEqual(dump.rows, initialRows); await check(dump);
      await live.command('/reload'); dump = await footerObserve(live, 'history-reload', 'accounting');
      assert.deepEqual(dump.rows, initialRows); assert.deepEqual(dump.context, context); await check(dump);
      assert.deepEqual(readFileSync(file), bytes, 'presentation and restoration never rewrite saved report bytes');
      const liveTraffic = await live.capture('history-traffic'), nativeTraffic = await native.capture('history-traffic');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      const requests = terminal => terminal.events().filter(e => ['call', 'result', 'model_context'].includes(e.type));
      assert.deepEqual(requests(live), requests(native), 'strict real request/tool/result/native context equality');
      assert.equal(requests(live).filter(e => e.type === 'model_context').length, 33);
      assert.equal(requests(live).filter(e => e.type === 'call').length, 30);
      assert.equal(requests(live).filter(e => e.type === 'result').length, 30);
      const nativeData = await footerObserve(native, 'history-native-usage', 'accounting');
      assert.deepEqual(reports(dump), reports(nativeData));
      const replay = new PiTerminal(`footer-history-replay-${mode}`, { ...options, mode, session: file, workspace: live.work,
        extraEnv: { ...options.extraEnv, TOOLVIEW_TEST_FOOTER_PRESENTATION: '1' } }); terminals.push(replay); await replay.ready();
      const resumed = await footerObserve(replay, 'history-resumed', 'accounting'); assert.deepEqual(resumed.rows, initialRows);
      assert.deepEqual(reports(resumed), reports(dump)); await check(resumed); assert.equal(requests(replay).length, 0);
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});

test('footer animated Working and short-height clipping do not rescan session or replace native activity', { skip: stockOnly }, async () => {
  const terminals = [];
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const terminal = new PiTerminal(`footer-working-${mode}`, { mode, extraEnv: { TOOLVIEW_TEST_FOOTER: '1', TOOLVIEW_TEST_FOOTER_PRESENTATION: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] });
      terminals.push(terminal); await terminal.ready(); terminal.send('run pending\r'); await terminal.event('provider_gate');
      const baseline = await footerObserve(terminal, 'busy', 'statuses', true); footerPhysical(baseline);
      assert.ok(baseline.screen.some(row => row.includes('Working')));
      for (let i = 0; i < 8; i++) { const next = await footerObserve(terminal, `busy-${i}`, 'snapshot', true); assert.deepEqual(next.counters, baseline.counters, 'native activity ticks cause no stats or footer body rebuilds'); }
      if (mode === 'fullscreen') {
        await terminal.resize(100, 4, true); const clipped = await footerObserve(terminal, 'clipped', 'snapshot', true);
        assert.equal(clipped.owner, 'FooterView'); assert.ok(clipped.rows.length > 0);
        assert.equal(clipped.statusIdentity, baseline.statusIdentity, 'height clipping cannot replace or stop the native indicator');
        assert.ok(clipped.nativeStatusRows.some(row => plain(row).includes('Working')), 'native container still renders its active object despite dock clipping');
        const control = new PiTerminal('footer-height-native-separate', { mode, extraEnv: { TOOLVIEW_TEST_FOOTER: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] });
        terminals.push(control); await control.ready(); control.send('run pending\r'); await control.event('provider_gate');
        const before = await footerObserve(control, 'native-busy', 'snapshot', true);
        const separated = await footerObserve(control, 'native-separate', 'native-separate', true);
        assert.equal(separated.statusIdentity, before.statusIdentity, 'public native relocation keeps the same indicator');
        await control.resize(100, 4, true); const nativeClip = await footerObserve(control, 'native-clipped', 'snapshot', true);
        assert.equal(nativeClip.statusIdentity, before.statusIdentity); assert.ok(nativeClip.nativeStatusRows.some(row => plain(row).includes('Working')));
        assert.equal(clipped.screen.some(row => row.includes('Working')), nativeClip.screen.some(row => row.includes('Working')), 'low-height visibility matches Pi own separate-status dock allocation');
        await terminal.resize(100, 80, true); const restored = await footerObserve(terminal, 'height-restored', 'snapshot', true); footerPhysical(restored);
        assert.equal(restored.statusIdentity, baseline.statusIdentity); assert.ok(restored.screen.some(row => row.includes('Working')));
      }
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      const done = await footerObserve(terminal, 'done', 'accounting'); assert.equal(done.idle, true); footerPhysical(done);
      assert.ok(done.rows.map(plain).join('\n').includes('CH86.4%')); assert.ok(done.counters.aggregations > baseline.counters.aggregations);
    }
  } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
});


test('Output padding settings update summaries and all transcript cards live with native and replay controls', { skip: stockOnly, timeout: 180000 }, async () => {
  const terminals = [], extraEnv = { TOOLVIEW_TEST_USER_CARDS: '1' };
  const start = async (name, options) => {
    const terminal = new PiTerminal(name, { extraEnv, agentSettings: { outputPad: 0, editorPaddingX: 2 }, ...options });
    terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 220); return terminal;
  };
  const setPadding = async (terminal, value) => {
    await terminal.command('/settings'); terminal.send('Output padding'); await terminal.settle();
    terminal.send('\r'); await terminal.settle();
    assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ Output padding\\s+${value}\\s*$`, 'u').test(row)));
    terminal.send('\x1b'); await terminal.settle();
    assert.equal(JSON.parse(readFileSync(join(terminal.agent, 'settings.json'), 'utf8')).outputPad, value);
  };
  const check = async (terminal, padding, width, label) => {
    await terminal.resize(width, 220);
    const dump = await terminal.capture(`pointer-output-${label}`);
    assert.equal(dump.outputPad, padding); assert.equal(dump.width, width); assert.equal(dump.users.length, 1);
    assert.equal(dump.users[0].outputPad, padding);
    const cards = [dump.users[0], byName(dump, 'bash')[0], byName(dump, 'write')[0], byName(dump, 'edit')[0]];
    for (const [index, card] of cards.entries()) {
      const rows = card.lines.filter(row => row !== ''), expected = rows.map(plain);
      const y = dump.screen.findIndex((_, start) => expected.every((row, offset) => dump.screen[start + offset] !== undefined && plain(dump.screen[start + offset]) === row));
      assert.ok(y >= 0, `entire ${index} card physically visible: ${label}`);
      const background = await referenceCell(dump.backgroundStyles[index === 0 ? 'userMessageBg' : 'toolPendingBg']);
      const stripe = await referenceCell(dump.frameStyles[index === 0 ? 'userBorder' : 'border']);
      for (let offset = 0; offset < rows.length; offset++) {
        const cells = dump.cells[y + offset];
        assert.equal(cells[padding].text, '┃'); assert.equal(cells[padding].fg, stripe.fg); assert.equal(cells[padding].bgMode, 0);
        for (const x of [padding + 1, width - padding - 1]) {
          assert.equal(cells[x].text, ' '); assert.equal(cells[x].bg, background.bg); assert.equal(cells[x].bgMode, background.bgMode);
        }
        if (padding) for (const x of [0, width - 1]) { assert.equal(cells[x].text, ' '); assert.equal(cells[x].bgMode, 0); }
      }
      await assertFits(rows, width);
    }
    for (const summary of [...byName(dump, 'read'), ...byName(dump, 'tv_unknown')]) {
      const rows = summary.lines.filter(row => row !== '').map(plain);
      assert.ok(rows[0][padding] === (summary.name === 'read' ? '→' : '⚙'));
      assert.ok(rows.slice(1).every(row => row.startsWith(' '.repeat(padding + 2))));
      await assertFits(rows, width - padding);
      const y = dump.screen.findIndex((_, start) => rows.every((row, offset) => (dump.screen[start + offset] || '').slice(0, row.length) === row));
      assert.ok(y >= 0, 'complete wrapped summary block physically visible');
      if (padding) assert.ok(rows.every((_, offset) => dump.cells[y + offset][width - 1].text === ''));
    }
    allBashCards(dump);
    assert.equal(dump.editor.padding, 2); assert.ok(dump.editor.lines.every(row => plain(row)[2] === '┃'), 'Editor padding remains independent');
    assert.equal(dump.extensionIssues.length, 0);
    return dump;
  };
  const identity = dump => dump.tools.map(({ args, content, details, isError }) => ({ args, content, details, isError }));
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const live = await start(`output-padding-${mode}`, { toolview: true, mode });
      await live.run('suite'); const activity = traffic(live, 7), first = await check(live, 0, 100, `${mode}-initial`);
      const bytes = readFileSync(first.session), saved = new Map();
      for (const [cycle, padding] of [0, 1, 0].entries()) {
        if (cycle) await setPadding(live, padding);
        for (const width of [24, 100]) {
          const dump = await check(live, padding, width, `${mode}-${cycle}-${width}`);
          saved.set(`${padding}-${width}`, dump); assert.deepEqual(identity(dump), identity(first));
          const rows = dump.users[0].lines.filter(row => row !== '');
          await live.command('/toolview off');
          const native = await live.capture(`native-user-output-${mode}-${cycle}-${width}`);
          const contentWidth = width - 2 * padding - 3;
          assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding + 2, contentWidth))),
            native.users[0].contentControl.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding, contentWidth))), 'native Markdown body at equal content width');
          assert.deepEqual(identity(native), identity(first));
          await live.command('/toolview on');
          const restored = await check(live, padding, width, `${mode}-${cycle}-${width}-on`);
          assert.deepEqual(restored.tools.map(tool => tool.lines), dump.tools.map(tool => tool.lines));
        }
      }
      await live.resize(100, 220);
      const current = saved.get('0-100');
      await live.command('/reload'); await live.event('start', 2);
      const reloaded = await check(live, 0, 100, `${mode}-reload`);
      assert.deepEqual(reloaded.tools.map(tool => tool.lines), current.tools.map(tool => tool.lines));
      if (mode === 'fullscreen') {
        const edit = byName(reloaded, 'edit')[0], expected = edit.lines.filter(row => row !== '').map(plain);
        const y = reloaded.screen.findIndex((_, start) => expected.every((row, offset) => reloaded.screen[start + offset] !== undefined && plain(reloaded.screen[start + offset]) === row));
        assert.ok(y >= 0, 'complete zero-margin edit panel is on the physical screen');
        await sgrAt(live, 0, y);
        const expanded = await live.capture(`pointer-output-${mode}-click-zero`);
        assert.equal(byName(expanded, 'edit')[0].expanded, true, 'zero-margin stripe is a real panel click target');
        live.send('\x0f'); await live.settle(); // native global toggle from false to true
        live.send('\x0f'); await live.settle(); // restore every tool to collapsed
      }
      assert.deepEqual(traffic(live, 7), activity); assert.deepEqual(readFileSync(first.session), bytes);
      await live.close();
      const replay = await start(`output-padding-replay-${mode}`, { toolview: true, mode, session: first.session, workspace: live.work });
      const native = await start(`output-padding-native-${mode}`, { toolview: false, mode, session: first.session, workspace: live.work });
      for (const padding of [0, 1]) {
        if (padding) { await setPadding(replay, padding); await setPadding(native, padding); }
        for (const width of [24, 100]) {
          const custom = await check(replay, padding, width, `replay-${mode}-${padding}-${width}`), expected = saved.get(`${padding}-${width}`);
          assert.deepEqual(custom.tools.map(tool => tool.lines), expected.tools.map(tool => tool.lines));
          assert.deepEqual(custom.users.map(user => user.lines), expected.users.map(user => user.lines));
          await replay.command('/toolview off');
          const off = await replay.capture(`pointer-output-native-${mode}-${padding}-${width}`);
          await native.resize(width, 220);
          const control = await native.capture(`pointer-output-control-${mode}-${padding}-${width}`);
          assert.deepEqual(off.tools.map(tool => tool.lines), control.tools.map(tool => tool.lines), 'complete native same-session tool rows restored without padding changes');
          assert.deepEqual(off.users.map(user => user.lines), control.users.map(user => user.lines));
          await replay.command('/toolview on');
        }
      }
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter(event => event.type === type).length, 0);
      assert.deepEqual(readFileSync(first.session), bytes);
    }
  } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
});


test('Output padding project override stays consistent after native user padding changes', { skip: stockOnly, timeout: 60000 }, async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = new PiTerminal(`output-padding-project-${mode}`, {
      toolview: true, mode, extraEnv: { TOOLVIEW_TEST_USER_CARDS: '1' },
      // Override the harness's -na only for this isolated, test-owned project config.
      flags: ['--approve'], agentSettings: { outputPad: 1 },
      profileFactory: ({ workDir }) => {
        mkdirSync(join(workDir, '.pi'), { recursive: true });
        writeFileSync(join(workDir, '.pi', 'settings.json'), JSON.stringify({ outputPad: 0 }));
      },
    });
    try {
      await live.ready(); await live.resize(100, 220); await live.run('suite');
      const before = await live.capture(`pointer-project-before-${mode}`), activity = traffic(live, 7), bytes = readFileSync(before.session);
      assert.equal(before.outputPad, 0); assert.equal(before.users[0].outputPad, 0);
      await live.command('/settings'); live.send('Output padding'); await live.settle(); live.send('\r'); await live.settle();
      assert.ok(live.screen().some(row => /^\s*→ Output padding\s+1\s*$/u.test(row)));
      live.send('\x1b'); await live.settle();
      const after = await live.capture(`pointer-project-after-${mode}`);
      assert.equal(after.outputPad, 0, 'public effective settings keep the project override');
      assert.equal(after.users[0].outputPad, 1, 'actual Pi callback changes native user-component geometry separately');
      assert.deepEqual(after.tools.map(tool => tool.lines), before.tools.map(tool => tool.lines));
      assert.deepEqual(after.users.map(user => user.lines), before.users.map(user => user.lines), 'all Toolview margins continue using effective padding with identical Markdown');
      const body = after.users[0].lines.filter(row => row !== '').slice(1, -1);
      await live.command('/toolview off');
      const native = await live.capture(`native-user-project-${mode}`);
      assert.equal(native.users[0].outputPad, 1, 'never mutate Pi component geometry to reconcile settings');
      assert.deepEqual(body.map(row => stripVTControlCharacters(sliceByColumn(row, 2, 97))),
        native.users[0].contentControl.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, 1, 97))));
      assert.deepEqual(traffic(live, 7), activity); assert.deepEqual(readFileSync(before.session), bytes);
      assert.equal(after.extensionIssues.length, 0);
    } finally { await live.close(); live.dispose(); }
  }
});


// Terminal-default protocol model: runtime overrides survive profile changes.
// This is controlled real Pi traffic, not a claim every terminal implements OSC.
function colorProfile(agentDir, project = false, workDir) {
  const theme = JSON.parse(readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json'), 'utf8'));
  theme.name = 'terminal-colors'; theme.appearance = 'dark';
  theme.colors.userMessageBg = ''; theme.colors.toolPendingBg = '';
  theme.colors.toolDiffAdded = '#00ff00'; theme.colors.toolDiffRemoved = '#ff0000'; theme.colors.text = '#eeeeee';
  theme.vars.surface = '#123456'; theme.vars.surfaceAlias = 'surface'; theme.export = { ...theme.export, pageBg: 'surfaceAlias' };
  mkdirSync(join(agentDir, 'themes'), { recursive: true });
  const path = join(agentDir, 'themes', `${theme.name}.json`);
  writeFileSync(path, JSON.stringify(theme));
  if (project) { mkdirSync(join(workDir, '.pi'), { recursive: true }); writeFileSync(join(workDir, '.pi/settings.json'), '{"theme":"dark"}'); }
  return { theme, path };
}
function colorTerminal(name, mode, { native = false, project = false, automatic = false, driver = join(fixtures, 'terminal-colors-driver.ts'), session, workspace } = {}) {
  let source;
  const terminal = new PiTerminal(name, { mode, session, workspace, flags: project ? ['--approve'] : [],
    agentSettings: { theme: project ? 'dark' : automatic ? 'dark/dark' : 'terminal-colors' },
    extraEnv: native ? { TOOLVIEW_TEST_COLORS_NATIVE: '1' } : {},
    extensions: [driver],
    profileFactory: ({ agentDir, workDir }) => { source = colorProfile(agentDir, project, workDir); },
  });
  const profile = { foreground: '#e5e5e7', background: '#0a0b0c' }, owned = {}, protocol = [];
  for (const [code, key] of [[10, 'foreground'], [11, 'background']]) {
    terminal.term.parser.registerOscHandler(code, value => {
      if (value === '?') {
        const hex = owned[key] ?? profile[key]; protocol.push({ query: key, value: hex });
        terminal.send(`\x1b]${code};rgb:` + [1, 3, 5].map(i => hex.slice(i, i + 2).repeat(2)).join('/') + '\x07');
      } else if (/^#[\da-f]{6}$/iu.test(value)) { owned[key] = value.toLowerCase(); protocol.push({ set: key, value: owned[key] }); }
      return true;
    });
    terminal.term.parser.registerOscHandler(code + 100, () => { delete owned[key]; protocol.push({ reset: key }); return true; });
  }
  const capture = async (name, action = 'snapshot', theme) => {
    writeFileSync(join(terminal.output, 'colors-request.json'), JSON.stringify({ name, action, theme }));
    terminal.send('\x1b[98;7u');
    const data = await until(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `color snapshot ${name}`);
    await terminal.settle(); return terminal.captureScreen(name, data);
  };
  return { terminal, source, profile, owned, protocol, capture };
}
async function selectDarkDark(terminal) {
  await terminal.command('/settings'); terminal.send('Theme'); await terminal.settle(); terminal.send('\r'); await terminal.settle();
  assert.ok(terminal.screen().some(row => row.includes('automatic')), 'native Theme selector');
  terminal.send('\x1b[A'); await terminal.settle(); terminal.send('\r'); await terminal.settle();
  assert.ok(terminal.screen().some(row => row.includes('Automatic Theme')), 'native Automatic Theme selector');
  terminal.send('\x1b[B\x1b[B'); await terminal.settle(); terminal.send('\r'); await terminal.settle(); terminal.send('\x1b'); await terminal.settle();
}
function colorTraffic(terminal) {
  for (const [type, count] of [['call', 7], ['result', 7], ['model_context', 8], ['provider_error', 0]])
    assert.equal(terminal.events().filter(event => event.type === type).length, count, `exact ${type} count`);
  return terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
}

test('terminal colors: independent channels, hot reload, source errors, RGB projection, native traffic and replay in both modes', async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = colorTerminal(`colors-live-${mode}`, mode), native = colorTerminal(`colors-native-${mode}`, mode, { native: true, workspace: live.terminal.work });
    let replay;
    try {
      await Promise.all([live.terminal.ready(), native.terminal.ready()]);
      await until(() => live.owned.background === '#123456' && live.owned.foreground === '#eeeeee', 'initial explicit terminal colors');
      const initial = await live.capture('initial'), control = await native.capture('initial');
      assert.equal(initial.diagnostic.status.state, 'on'); assert.equal(initial.automatic, false);
      assert.equal(initial.nativeBackground, '#0a0b0c', 'Pi concrete defaults stay native/stale, not mutated');
      assert.equal(control.nativeBackground, '#0a0b0c'); assert.equal(initial.publicPrototypesUnchanged, true);
      assert.deepEqual(native.owned, {}); assert.equal(initial.belowRows.length, 2);
      const edgeRow = initial.cells.find(row => row.some(cell => cell?.text === '╹'));
      assert.ok(edgeRow); assert.ok(edgeRow.some(cell => cell?.text === '▀' && cell.fg === 0x123456 && cell.fgMode === 0x3000000), 'input edge uses requested default RGB');
      const warm = await live.capture('warm', 'warm');
      assert.deepEqual(warm.diagnostic.counters, initial.diagnostic.counters, '50 real renders do zero file/query/projection/output work');
      assert.deepEqual(warm.before, warm.after); assert.deepEqual(warm.editorRows, initial.editorRows);
      const foreign = await live.capture('foreign', 'foreign-query');
      assert.deepEqual(foreign.report.foreground, { r: 238, g: 238, b: 238 }); assert.deepEqual(foreign.report.background, { r: 18, g: 52, b: 86 });
      assert.deepEqual(foreign.diagnostic.counters, warm.diagnostic.counters); assert.equal(foreign.publicPrototypesUnchanged, true);
      live.source.theme.vars.surface = '#654321'; writeFileSync(live.source.path, '\uFEFF' + JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#654321', 'BOM/export-only same-name native hot reload');
      const hot = await live.capture('hot');
      assert.equal(hot.theme, initial.theme); assert.equal(hot.diagnostic.counters.sourceReads, initial.diagnostic.counters.sourceReads + 1);
      assert.equal(hot.diagnostic.counters.sets, initial.diagnostic.counters.sets + 1); assert.deepEqual(hot.before, hot.after);
      live.source.theme.colors.text = '#abcdef'; live.source.theme.export.pageBg = 'missing-terminal-var';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      let errorIndex = 0;
      const failure = await until(async () => { const snap = await live.capture(`error-${++errorIndex}`); return snap.diagnostic.status.state === 'source error' && snap; }, 'accepted source failure');
      assert.deepEqual(live.owned, { background: '#654321', foreground: '#eeeeee' }, 'whole prior valid snapshot, no partial foreground publication');
      assert.equal(failure.diagnostic.counters.warnings, 1);
      await live.capture('retry', 'colors on');
      const retried = await live.capture('retried'); assert.equal(retried.diagnostic.counters.warnings, 1);
      assert.equal(retried.diagnostic.counters.sourceReads, failure.diagnostic.counters.sourceReads + 1);
      live.source.theme.colors.text = ''; live.source.theme.export.pageBg = '';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => Object.keys(live.owned).length === 0, 'valid empty values release both owned channels');
      const empty = await live.capture('empty'); assert.equal(empty.diagnostic.status.state, 'on');
      assert.equal(empty.diagnostic.counters.releases, retried.diagnostic.counters.releases + 2);
      live.source.theme.colors.text = 'ink'; live.source.theme.vars.ink = 0;
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.foreground === '#000000', 'numeric zero is explicit foreground, not empty'); assert.equal(live.owned.background, undefined);
      live.source.theme.colors.text = '#eeeeee'; live.source.theme.export.pageBg = 'surfaceAlias'; live.source.theme.vars.surface = '#123456';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#123456' && live.owned.foreground === '#eeeeee', 'restore baseline theme');
      const enabled = await live.capture('enabled'); await live.capture('local-off', 'colors off');
      assert.deepEqual(live.owned, {});
      const localOff = await live.capture('local-off-stable');
      assert.deepEqual(localOff.editorRows, enabled.editorRows, 'colors off leaves the editor geometry/styling installed');
      await live.capture('master-off', 'off'); await live.capture('master-on', 'on'); assert.deepEqual(live.owned, {}, 'master on preserves local off');
      await live.capture('local-on', 'colors on'); await until(() => live.owned.background === '#123456', 'local on');
      await live.terminal.command('/reload'); await live.terminal.event('start', 2); await live.terminal.settle();
      const reloaded = await live.capture('reloaded'); assert.equal(reloaded.diagnostic.status.state, 'on'); assert.equal(reloaded.publicPrototypesUnchanged, true);
      await live.capture('post-reload-off', 'colors off');
      const released = await live.capture('post-reload-off-stable');
      assert.ok(released.cells.some(row => row.some(cell => cell?.text === '▀' && cell.fg === 0x0a0b0c)), 'local off repairs the input edge after native reload cached our former default');
      await live.capture('post-reload-on', 'colors on'); await until(() => live.owned.background === '#123456', 'reapply after release projection check');
      // Same cwd keeps genuine ENOENT payloads equal; sequential writers avoid sharing an execution race.
      await native.terminal.run('suite'); await live.terminal.run('suite');
      const result = await live.terminal.capture('traffic'), nativeResult = await native.terminal.capture('traffic');
      assert.deepEqual(colorTraffic(live.terminal), colorTraffic(native.terminal));
      assert.deepEqual(persisted(result), persisted(nativeResult));
      const edit = byName(result, 'edit')[0]; assert.ok(edit.lines.some(row => row.includes('\x1b[48;2;15;52;72m') && row.includes('WRITE_AFTER')), 'diff Multiply code tint uses actual requested background');
      assert.ok(result.cells.some(row => row.some(cell => cell?.text === 'W' && cell.bg === 0x0f3448)), 'the controlled physical screen contains the new tint');
      live.source.theme.export.pageBg = ''; writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === undefined, 'unowned background on existing diff');
      await live.capture('unowned-warm', 'warm');
      live.profile.background = '#f0f0f0'; await live.capture('unowned-refresh', 'colors on');
      await until(() => live.terminal.captureScreen('unowned-physical', {}).cells.some(row => row.some(cell => cell?.text === 'W' && cell.bg === 0xcaf0ca)), 'late reported defaults repaint existing physical diff without a native theme change');
      live.source.theme.export.pageBg = 'surfaceAlias'; writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#123456', 'restore requested replay background');
      const bytes = readFileSync(result.session, 'utf8');
      replay = colorTerminal(`colors-replay-${mode}`, mode, { session: result.session, workspace: live.terminal.work });
      await replay.terminal.ready(); await until(() => replay.owned.background === '#123456', 'replay applies fixed theme');
      const restored = await replay.terminal.capture('replay');
      assert.deepEqual(persisted(restored), persisted(result)); assert.equal(readFileSync(result.session, 'utf8'), bytes, 'presentation and replay do not rewrite session bytes');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.terminal.events().filter(event => event.type === type).length, 0);
      assert.ok(byName(restored, 'edit')[0].lines.some(row => row.includes('\x1b[48;2;15;52;72m') && row.includes('WRITE_AFTER')));
      writeFileSync(join(live.terminal.output, 'color-evidence.json'), JSON.stringify({ initial, hot, failure, empty, protocol: live.protocol }, null, 2));
      live.terminal.send('/quit\r'); await until(() => live.terminal.exited, 'normal Pi exit'); await live.terminal.queue;
      assert.deepEqual(live.owned, {}, 'normal shutdown restores only our applied defaults');
    } finally {
      await Promise.all([live.terminal.close(), native.terminal.close(), replay?.terminal.close()]);
      live.terminal.dispose(); native.terminal.dispose(); replay?.terminal.dispose();
    }
  }
});

test('terminal colors: trusted project override, native fixed-to-auto ordering, reload and renderer switch stay inactive', async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = colorTerminal(`colors-auto-${mode}`, mode, { project: true });
    try {
      await live.terminal.ready();
      const before = await live.capture('before'); assert.equal(before.diagnostic.status.state, 'on');
      assert.ok(Object.keys(live.owned).length > 0, 'positive fixed-theme activation');
      live.protocol.length = 0; await selectDarkDark(live.terminal);
      const after = await live.capture('auto'); assert.equal(after.configured, 'dark'); assert.equal(after.theme, 'dark'); assert.equal(after.automatic, true);
      assert.equal(after.diagnostic.status.state, 'automatic theme'); assert.deepEqual(live.owned, {});
      const firstQuery = live.protocol.findIndex(event => event.query);
      assert.ok(firstQuery >= 0); assert.ok(live.protocol.findIndex(event => event.reset === 'background') < firstQuery);
      assert.ok(live.protocol.filter(event => event.query).every(event => event.value === live.profile[event.query]), 'Pi only sees profile defaults');
      const stable = await live.capture('auto-warm', 'warm'); assert.deepEqual(stable.diagnostic.counters, after.diagnostic.counters);
      const scopeStart = live.protocol.length;
      await live.terminal.command('/reload'); await live.terminal.event('start', 2); await live.terminal.settle();
      const reloaded = await live.capture('auto-reloaded');
      assert.equal(reloaded.automatic, true); assert.equal(reloaded.diagnostic.counters.sourceReads, 0);
      assert.equal(reloaded.diagnostic.counters.sets, 0); assert.equal(reloaded.diagnostic.counters.releases, 0); assert.equal(reloaded.diagnostic.counters.reports, 0);
      await live.terminal.command('/settings'); live.terminal.send('TUI mode'); await live.terminal.settle(); live.terminal.send('\r'); await live.terminal.settle(); live.terminal.send('\x1b'); await live.terminal.settle();
      const swapped = await live.capture('auto-swapped'); assert.equal(swapped.automatic, true);
      assert.equal(swapped.diagnostic.counters.sourceReads, 0); assert.equal(swapped.diagnostic.counters.sets, 0);
      assert.equal(swapped.diagnostic.counters.releases, 0); assert.equal(swapped.diagnostic.counters.reports, 0);
      assert.ok(live.protocol.slice(scopeStart).every(event => !event.set && !event.reset), 'no transient activation during reload or renderer replacement');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(live.terminal.events().filter(event => event.type === type).length, 0);
    } finally { await live.terminal.close(); live.terminal.dispose(); }
  }
});


test('terminal colors: initially automatic and first production late load stay inactive without prior observation', async () => {
  const inactive = async (live, label) => {
    const packet = await live.capture(label);
    assert.equal(packet.automatic, true, 'real native automatic tracking is positively active');
    assert.equal(packet.diagnostic.status.state, 'automatic theme');
    for (const field of ['sourceReads', 'reports', 'sets', 'releases', 'packets', 'warnings', 'projections', 'staleReplies']) assert.equal(packet.diagnostic.counters[field], 0, `${label} ${field}`);
    assert.deepEqual(live.protocol.filter(event => event.set || event.reset), [], 'no transient applications or resets');
    assert.equal(live.terminal.events().filter(event => ['call', 'result', 'model_context', 'provider_error'].includes(event.type)).length, 0);
    const before = packet.diagnostic.counters, warm = await live.capture(`${label}-warm`, 'warm');
    assert.deepEqual(warm.diagnostic.counters, before, 'warm native frames add no feature work');
    return packet;
  };
  for (const mode of ['fullscreen', 'regular']) {
    const cold = colorTerminal(`colors-cold-auto-${mode}`, mode, { automatic: true });
    try { await cold.terminal.ready(); await inactive(cold, 'cold-auto'); }
    finally { await cold.terminal.close(); cold.terminal.dispose(); }
    for (const project of [false, true]) {
      const loader = join(artifacts, `colors-first-late-${mode}-${project}.ts`);
      const importDriver = `import driver from ${JSON.stringify(join(fixtures, 'terminal-colors-driver.ts'))};\n`;
      writeFileSync(loader, importDriver + 'export default async function(pi) { process.env.TOOLVIEW_TEST_COLORS_NATIVE = "1"; await driver(pi); }\n');
      const late = colorTerminal(`colors-first-late-${mode}-${project}`, mode, { automatic: !project, project, driver: loader });
      try {
        await late.terminal.ready();
        const noFeature = await late.capture('before-first-load'); assert.equal(noFeature.diagnostic, undefined);
        assert.deepEqual(late.protocol.filter(event => event.set || event.reset), []);
        if (project) await selectDarkDark(late.terminal);
        const nativeAuto = await late.capture('native-auto-before-load');
        assert.equal(nativeAuto.automatic, true); assert.equal(nativeAuto.configured, project ? 'dark' : 'dark/dark');
        // Introduce the production import/factory for the first time, not a re-enabled warm observer.
        writeFileSync(loader, importDriver + 'export default async function(pi) { delete process.env.TOOLVIEW_TEST_COLORS_NATIVE; await driver(pi); }\n');
        await late.terminal.command('/reload'); await late.terminal.event('start', 2);
        const first = await inactive(late, 'first-production-load');
        assert.equal(first.configured, project ? 'dark' : 'dark/dark', 'hidden project divergence remains real');
      } finally { await late.terminal.close(); late.terminal.dispose(); }
    }
  }
});

for (const mode of ['regular', 'fullscreen']) test(`real CLI: isolated bash timeout tails preserve exact traffic (${mode})`,
  { skip: stockOnly, timeout: 180000 }, async () => {
    const terminals = [], footer = '[exit code: 124; error: command timed out]';
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal('bash-timeout-' + mode + '-' + name,
        { toolview: true, mode, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 260); return terminal;
    };
    const row = (count) => Array.from({ length: count }, (_, index) => `SHAPE_ROW_${String(index + 1).padStart(2, '0')}`);
    // Literal expectations are independent of both the presenter and fixture implementation.
    const cases = [
      ['timeout-match', 'BODY\n \t\n[command timed out]\n[exit code: 124]\n \n', 124, false],
      ['timeout-both', 'BODY\n\n[command timed out]\n[exit code: 124]', 124, true],
      ['timeout-only', '\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-no-gap', 'BODY\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-mismatch', 'BODY\n\n[command timed out]\n[exit code: 125]', 124, false],
      ['timeout-string', 'BODY\n\n[command timed out]\n[exit code: 124]', '124', false],
      ['timeout-unknown', 'BODY\n\n[command timed out]\n[exit code: 124]', undefined, false],
      ['timeout-code-only', 'BODY\n\n[exit code: 124]', 124, false],
      ['timeout-interior', 'BODY\n\n[command timed out]\n[exit code: 124]\nAFTER_TIMEOUT', 124, false],
      ['timeout-preview', row(9).join('\n') + '\n\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-deep', row(11).join('\n') + '\n\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-indent', 'BODY\n\n [command timed out]\n[exit code: 124]', 124, false],
    ];
    const matching = ['timeout-match', 'timeout-both', 'timeout-only', 'timeout-preview', 'timeout-deep'];
    const tool = (dump, name) => dump.tools[cases.findIndex(([fixtureCase]) => fixtureCase === name)];
    const body = (value) => {
      const rows = value.lines.map(stripVTControlCharacters), top = rows.findIndex((line) => line.includes('┃'));
      return rows.slice(top + 1, -1).map((line) => line.slice(3, -2).trimEnd());
    };
    const identity = (dump, baseline, bytes) => {
      assert.deepEqual(dump.branch, baseline.branch);
      assert.deepEqual(persisted(dump), persisted(baseline));
      const raw = ({ id, args, content, details, isError }) => ({ id, args, content, details, isError });
      assert.deepEqual(dump.tools.map(raw), baseline.tools.map(raw));
      assert.equal(readFileSync(dump.session, 'utf8'), bytes, 'presentation must not rewrite the saved timeout marker or code');
    };
    const physicalSamples = [];
    const timeoutCells = async (dump, label) => {
      const error = await referenceCell(dump.summaryStyles.error), background = await referenceCell(dump.backgroundStyles.toolPendingBg);
      for (const name of matching) {
        // Keep the full frame width: painted terminal spaces are not necessarily
        // trimmed by xterm. Never compare trimmed component rows to full cells.
        const component = tool(dump, name).lines.map(stripVTControlCharacters);
        if (component[0] === '') component.shift();
        const start = dump.screen.findIndex((_, index) => component.every((line, offset) => dump.screen[index + offset]?.padEnd(dump.width) === line));
        assert.ok(start >= 0, `${name}: entire actual panel is on the physical screen at ${dump.width} columns`);
        const available = dump.width - 5, fragments = hardRows(footer, available);
        const first = component.length - 1 - fragments.length;
        assert.deepEqual(component.slice(first, -1).map((line) => line.slice(3, -2)), fragments.map((line) => line.padEnd(available)), 'complete physical frame rows preserve footer fragments and right padding');
        let checkedCells = 0;
        for (const [offset, fragment] of fragments.entries()) {
          const y = start + first + offset;
          for (let x = 3; x < 3 + fragment.length; x++) {
            const cell = dump.cells[y][x];
            assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
              { fg: error.fg, fgMode: error.fgMode, dim: error.dim }, `${name}: every footer cell uses error, including wrapped rows`);
            assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: background.bg, bgMode: background.bgMode });
            checkedCells++;
          }
          const stripe = dump.cells[y][1];
          assert.deepEqual({ fg: stripe.fg, fgMode: stripe.fgMode, dim: stripe.dim }, { fg: error.fg, fgMode: error.fgMode, dim: error.dim });
          for (const x of [0, 1, dump.width - 1]) assert.equal(dump.cells[y][x].bgMode, 0);
        }
        physicalSamples.push({ label, name, width: dump.width, footerRows: fragments.length, checkedCells });
      }
    };
    const wideChecks = (dump) => {
      for (const name of matching) {
        const rows = body(tool(dump, name));
        assert.equal(rows.filter((line) => line === footer).length, 1, `${name}: exactly one own timeout footer`);
        assert.ok(!rows.includes('[command timed out]') && !rows.includes('[exit code: 124]'), `${name}: both original service rows disappear`);
      }
      assert.deepEqual(body(tool(dump, 'timeout-only')), ['$ shape timeout-only', '', footer], 'timeout-only output leaves no empty output section');
      assert.deepEqual(body(tool(dump, 'timeout-preview')), ['$ shape timeout-preview', '', ...row(9), '', footer], 'timeout tail does not cause a false overflow hint');
      for (const name of ['timeout-no-gap', 'timeout-mismatch', 'timeout-string', 'timeout-unknown', 'timeout-interior', 'timeout-indent']) {
        const rows = body(tool(dump, name));
        assert.ok(rows.some((line) => line.includes('[command timed out]')), `${name}: original marker remains output`);
        assert.ok(!rows.includes(footer), `${name}: no synthesized timeout label`);
      }
      assert.deepEqual(body(tool(dump, 'timeout-code-only')), ['$ shape timeout-code-only', '', 'BODY', '', '[exit code: 124]']);
    };
    try {
      const live = await start('live'); await live.run('bash-shape-timeouts');
      const wide = await live.capture('wide'); allBashCards(wide); wideChecks(wide); await timeoutCells(wide, 'wide');
      const observed = traffic(live, cases.length), bytes = readFileSync(wide.session, 'utf8');
      const rawResults = cases.map(([, text, code, isError]) => ({ name: 'bash', content: [{ type: 'text', text }],
        ...(code === undefined ? {} : { details: { exit_code: code } }), isError }));
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        cases.map(([fixtureCase]) => ({ command: 'shape ' + fixtureCase, fixtureCase })));
      assert.deepEqual(observed.filter((event) => event.type === 'result').map(({ type, ...value }) => value), rawResults);
      observed.filter((event) => event.type === 'model_context').forEach((event, index) =>
        assert.deepEqual(event.results, rawResults.slice(0, index), `model context ${index}: exact original timeout text and metadata`));
      assert.deepEqual(persisted(wide).filter((entry) => entry.role === 'toolResult'),
        rawResults.map(({ name, details, ...value }) => ({ role: 'toolResult', toolName: name, ...value, details })));
      for (const theme of ['light', 'dark']) {
        await live.command('/tv-theme ' + theme); const dump = await live.capture('theme-' + theme);
        allBashCards(dump); wideChecks(dump); identity(dump, wide, bytes); await timeoutCells(dump, theme);
      }
      await live.resize(24, 360); const narrow = await live.capture('narrow'); allBashCards(narrow); identity(narrow, wide, bytes);
      await timeoutCells(narrow, 'narrow');
      assert.ok(!body(tool(narrow, 'timeout-preview')).some((line) => line.includes('Click')), 'filtering compares logical rows before wrapping');
      for (const value of narrow.tools) await assertFits(value.lines, 24);
      live.send('\x0f'); await live.settle(); const narrowExpanded = await live.capture('narrow-expanded');
      allBashCards(narrowExpanded); identity(narrowExpanded, wide, bytes); await timeoutCells(narrowExpanded, 'narrow-expanded');
      assert.ok(narrowExpanded.tools.every((value) => value.expanded));
      await live.resize(100, 260); const expanded = await live.capture('expanded');
      allBashCards(expanded); identity(expanded, wide, bytes); wideChecks(expanded); await timeoutCells(expanded, 'expanded');
      assert.deepEqual(body(tool(expanded, 'timeout-deep')), ['$ shape timeout-deep', '', ...row(11), '', footer]);
      live.send('\x0f'); await live.settle(); const collapsed = await live.capture('collapsed');
      assert.deepEqual(collapsed.tools.map((value) => value.lines), wide.tools.map((value) => value.lines)); identity(collapsed, wide, bytes);
      await live.command('/toolview off'); const off = await live.capture('off'); identity(off, wide, bytes);
      await live.command('/toolview on'); const on = await live.capture('on');
      allBashCards(on); identity(on, wide, bytes); assert.deepEqual(on.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); allBashCards(reloaded); identity(reloaded, wide, bytes);
      assert.deepEqual(reloaded.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      const native = await start('native', { toolview: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); identity(control, wide, bytes);
      await live.command('/toolview off'); const reloadedOff = await live.capture('reloaded-off'); identity(reloadedOff, wide, bytes);
      assert.deepEqual(reloadedOff.tools.map((value) => value.lines), control.tools.map((value) => value.lines), 'off restores exact native history');
      const replay = await start('replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); identity(resumed, wide, bytes); wideChecks(resumed); await timeoutCells(resumed, 'replay');
      assert.deepEqual(resumed.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off'); identity(replayOff, wide, bytes);
      assert.deepEqual(replayOff.tools.map((value) => value.lines), control.tools.map((value) => value.lines));
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter((event) => event.type === type).length, 0, `history ${type} remains zero`);
      assert.deepEqual(traffic(live, cases.length), observed);

      const stream = await start('stream'); stream.send('run bash-shape-timeout-stream\r'); await stream.event('shape_timeout_gate');
      const raw = row(9).join('\n') + '\n\n[command timed out]\n[exit code: 124]';
      const original = { content: [{ type: 'text', text: raw }], details: { exit_code: 124 }, isError: false };
      const streamIdentity = (dump) => assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), [original]);
      const partial = await stream.capture('partial', { animated: true }); allBashCards(partial, { partial: true }); streamIdentity(partial);
      assert.equal(partial.tools[0].partial, true); assert.ok(body(partial.tools[0]).includes('… (Click to expand)'));
      assert.ok(!body(partial.tools[0]).includes(footer));
      stream.send('\x0f'); await stream.settle(true); const partialExpanded = await stream.capture('partial-expanded', { animated: true });
      allBashCards(partialExpanded, { partial: true }); streamIdentity(partialExpanded);
      assert.deepEqual(body(partialExpanded.tools[0]), ['$ shape timeout-stream', '', ...row(9), '', '[command timed out]', '[exit code: 124]']);
      await bashScreenStyle(partialExpanded, '[command timed out]', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(partialExpanded, '[exit code: 124]', 'toolOutput', 'toolPendingBg');
      writeFileSync(join(stream.output, 'shape-timeout-final'), 'go'); await stream.event('agent_end');
      const final = await stream.capture('final'); allBashCards(final); streamIdentity(final);
      assert.equal(final.tools[0].partial, false); assert.deepEqual(body(final.tools[0]), ['$ shape timeout-stream', '', ...row(9), '', footer]);
      await bashScreenStyle(final, footer, 'error', 'toolPendingBg');
      stream.send('\x0f'); await stream.settle(); const streamCollapsed = await stream.capture('collapsed'); allBashCards(streamCollapsed); streamIdentity(streamCollapsed);
      assert.equal(streamCollapsed.tools[0].expanded, false); assert.ok(!body(streamCollapsed.tools[0]).some((line) => line.includes('Click')));
      const streamTraffic = traffic(stream, 1), updates = stream.events().filter((event) => event.type === 'execution_update');
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'call').map((event) => event.input),
        [{ command: 'shape timeout-stream', fixtureCase: 'timeout-stream' }]);
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'result').map(({ type, name, ...value }) => value), [original]);
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'model_context').map((event) => event.results), [[], [{ name: 'bash', ...original }]]);
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].partialResult, original);
      assert.deepEqual(persisted(final).filter((entry) => entry.role === 'toolResult'), [{ role: 'toolResult', toolName: 'bash', ...original }]);
      writeFileSync(join(artifacts, 'bash-timeout-' + mode + '-coverage.json'), JSON.stringify({ installedAFT: false, mode,
        optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1', calls: cases.length, results: cases.length, modelContexts: cases.length + 1,
        streamCalls: 1, streamResults: 1, streamContexts: 2, updates: updates.length, historyCalls: 0,
        cases: cases.map(([name]) => name), widths: [100, 24, 100], themes: ['dark', 'light', 'dark'], physicalSamples,
        checked: ['one exact separated terminal timeout pair', 'code-only/mismatching/string/unknown/interior/indent/no-gap guards',
          'before-preview filtering and real overflow retained', 'all wrapped footer cells error with neutral background',
          'partial literals toolOutput to final own error footer', 'exact raw results/model/session/branch identity',
          'Ctrl+O/off/on/reload/native/replay, no history execution'],
        limitations: ['real CLI with isolated deterministic AFT-shaped results; not installed AFT execution',
          'identical printed terminal pair is an accepted display ambiguity'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });
