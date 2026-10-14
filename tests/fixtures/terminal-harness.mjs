// Reusable physical terminal support. Importing this module registers no tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import xterm from '@xterm/headless';
import { readInputs, childEnv, toolPath } from '../../scripts/test/context.mjs';

const { Terminal } = xterm;
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const extension = join(root, 'tests/fixtures/presentation-driver.ts');
export const fixtures = join(root, 'tests/fixtures');
export const artifacts = join(root, '.test-artifacts', `terminal-${Date.now()}-${process.pid}`);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const plain = (line) => stripVTControlCharacters(line).trimEnd();
export const lines = (tool) => tool.lines.map(plain).filter((line) => line.trim());
export const byName = (dump, name) => dump.tools.filter((tool) => tool.name === name);
export const nativeTiming = (value) => value.replace(/Took \d+(?:\.\d+)?s/g, 'Took <runtime>s');
export const toolLines = (dump) => dump.tools.map(({ name, lines }) => ({ name, lines: lines.map(nativeTiming) }));
export async function assertFits(rows, width) {
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

export async function until(check, label, timeout = 12000) {
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
  constructor(name, { tidyUi = false, mode = 'fullscreen', session, flags = [],
    agentSettings = {}, extraEnv = {}, extensions = [], workspace, profileFactory } = {}) {
    const inputs = readInputs(), python = toolPath('python3');
    this.output = join(artifacts, name);
    mkdirSync(this.output, { recursive: true });
    this.temp = mkdtempSync(join(tmpdir(), 'pi-tidy-ui-terminal-'));
    this.work = workspace || join(this.temp, 'work');
    this.agent = join(this.temp, 'agent');
    mkdirSync(this.work, { recursive: true }); mkdirSync(this.agent);
    try {
      this.profile = profileFactory?.({ homeDir: this.temp, agentDir: this.agent, workDir: this.work,
        provider: 'tidy-ui-offline', model: 'scripted' });
    } catch (error) {
      this.dispose();
      throw error;
    }
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
      if (extraEnv.TIDY_UI_TEST_EDIT_PERFORMANCE === '1') writeFileSync(join(this.work, 'edit-minified.ts'), 'x+=1;'.repeat(3200) + '\n');
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
    if (tidyUi) args.push('-e', extension);
    args.push('--model', 'tidy-ui-offline/scripted', '--tui-mode', mode, ...flags);
    if (session) args.push('--session', session);
    const env = childEnv(this.temp, {
      HOME: this.temp, USERPROFILE: this.temp,
      ...this.profile?.env, ...extraEnv,
      TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
      PI_CODING_AGENT_DIR: this.agent, TIDY_UI_TEST_OUTPUT: this.output,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      ...(this.profile ? { TIDY_UI_TEST_PROFILE: 'installed' } : {}),
    });
    const command = [inputs.node.path, inputs.pi.cli, ...args];
    this.child = spawn(python, ['-I', '-S', join(fixtures, 'pty_bridge.py'), '100', '80', this.work, ...command],
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
    writeFileSync(join(this.output, 'invocation.json'), JSON.stringify({ command, mode, work: this.work }, null, 2));
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
      // A live read may end inside the producer's newline-delimited record.
      return readFileSync(join(this.output, 'events.jsonl'), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
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
    this.send(`/tidy-ui-dump ${name}\r`);
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
