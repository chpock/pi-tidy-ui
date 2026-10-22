// Reusable physical terminal support. Importing this module registers no tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import xterm from '@xterm/headless';
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';
import { readInputs, childEnv, toolPath } from '../../scripts/test/context.mjs';
import { planTerminalObserver } from './terminal-observer-plan.mjs';
import { planPerformanceLayout } from './performance-layout-plan.mjs';
import { terminalCodeCache } from './terminal-code-cache.mjs';

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
export { assertFits } from './terminal-rows.mjs';

export async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(30);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}; artifacts: ${artifacts}`);
}

export function observeRenderFrames(term, state) {
  state.rendering = false; state.completedRenders = 0;
  for (const [final, rendering] of [['h', true], ['l', false]]) term.parser.registerCsiHandler({ prefix: '?', final }, params => {
    if (params.includes(2026)) { state.rendering = rendering; if (!rendering) state.completedRenders++; }
    return false;
  });
}

export function observeNativeReceipts(term, state) {
  state.nativeReceipts = new Map();
  state.nativeProgress = new EventEmitter();
  state.nativeSequence = 0;
  return term.parser.registerOscHandler(777, data => {
    if (!data.startsWith('tidy-test;')) return false;
    try {
      const packet = JSON.parse(Buffer.from(data.slice('tidy-test;'.length), 'base64').toString());
      if (packet.type === 'error') state.error = new Error(packet.message);
      if (packet.type === 'frame' && state.rendering) state.error = new Error('Native frame fence arrived inside synchronized output');
      if (packet.type !== 'journal' && packet.type !== 'diagnostic') state.nativeReceipts.set(`${packet.type}:${packet.id ?? 0}`, packet);
    } catch (error) { state.error = error; }
    state.nativeProgress.emit('progress');
    return true;
  });
}

export class PiTerminal {
  // The integration-profile helper may supply additional isolated settings, environment and explicit extensions.
  constructor(name, { tidyUi = false, mode = 'fullscreen', session, flags = [],
    agentSettings = {}, extraEnv = {}, extensions = [], workspace, profileFactory, tidyUiSettings, dimensions = { columns: 100, rows: 80 } } = {}) {
    const inputs = readInputs(), python = toolPath('python3');
    this.output = join(artifacts, name);
    this.observeMenuBounds = extraEnv.TIDY_UI_TEST_MENU_GEOMETRY === '1';
    const measuring = extraEnv.TIDY_UI_TEST_PERFORMANCE === '1';
    const { columns, rows } = dimensions;
    assert.ok(Number.isInteger(columns) && columns >= 24 && columns <= 240 && Number.isInteger(rows) && rows >= 10 && rows <= 150, 'bounded initial terminal dimensions');
    mkdirSync(this.output, { recursive: true });
    this.temp = mkdtempSync(join(tmpdir(), 'pi-tidy-ui-terminal-'));
    this.work = workspace || join(this.temp, 'work');
    this.agent = join(this.temp, 'agent');
    mkdirSync(this.work, { recursive: true }); mkdirSync(this.agent);
    if (tidyUiSettings) {
      const config = join(this.agent, 'extensions/pi-tidy-ui/config.json');
      mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, JSON.stringify(tidyUiSettings));
    }
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
    this.term = new Terminal({ cols: columns, rows, scrollback: measuring ? 0 : 3000, allowProposedApi: true });
    observeRenderFrames(this.term, this);
    observeNativeReceipts(this.term, this);
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
    const observerPlan = join(this.output, 'native-observer.json');
    writeFileSync(observerPlan, JSON.stringify({ ...planTerminalObserver(inputs), ...(measuring ? { layout: planPerformanceLayout(inputs) } : {}) }, null, 2));
    const env = childEnv(this.temp, {
      HOME: this.temp, USERPROFILE: this.temp,
      ...this.profile?.env, ...extraEnv,
      TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
      PI_CODING_AGENT_DIR: this.agent, TIDY_UI_TEST_OUTPUT: this.output,
      TIDY_UI_TEST_OBSERVER_PLAN: observerPlan,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      ...(this.profile ? { TIDY_UI_TEST_PROFILE: 'installed' } : {}),
    });
    this.codeCache = terminalCodeCache(this.temp);
    env.NODE_COMPILE_CACHE = this.codeCache.node;
    const command = [inputs.node.path, ...(measuring ? ['--expose-gc'] : []), '--import', pathToFileURL(join(fixtures, 'terminal-preload.mjs')).href, inputs.pi.cli, ...args];
    this.child = spawn(python, ['-I', '-S', join(fixtures, 'pty_bridge.py'), String(columns), String(rows), this.work, ...command],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => { this.error = error; this.nativeProgress.emit('progress'); });
    this.child.stdin.on('error', (error) => {
      if (!this.closing) { this.error = error; this.nativeProgress.emit('progress'); }
    });
    this.stderr = '';
    this.child.stderr.on('data', (data) => { this.stderr = measuring ? (this.stderr + data).slice(-16384) : this.stderr + data; });
    this.child.on('exit', (code, signal) => { this.exited = { code, signal }; this.nativeProgress.emit('progress'); });
    this.child.on('close', () => { this.closed = true; this.nativeProgress.emit('progress'); });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      let forwardedData = false;
      try {
        const frame = JSON.parse(line);
        if (frame.error) this.error = new Error(frame.error);
        if (frame.resized) this.ptySize = { id: frame.id, width: frame.resized[0], height: frame.resized[1] };
        if (frame.data) {
          const data = Buffer.from(frame.data, 'base64');
          if (measuring) this.raw[0] = data.subarray(Math.max(0, data.length - 65536));
          else this.raw.push(data);
          this.lastOutput = Date.now();
          // Native parsing is FIFO: the newest callback also drains all earlier chunks.
          this.queue = new Promise((done) => this.term.write(data, done));
          forwardedData = true;
        }
        if (frame.exit !== undefined) {
          this.piExit = frame.exit;
          if (!this.closing && frame.exit !== this.expectedPiExit) this.error = new Error(`Pi exited: ${frame.exit}`);
        }
        if (frame.shutdown) this.shutdown = frame.shutdown;
      } catch (error) { this.error = error; }
      if (!forwardedData || this.error) this.nativeProgress.emit('progress');
    });
    // Let the terminal emulator answer native cursor/device queries, just as a terminal would.
    this.term.onData((data) => this.send(data));
    writeFileSync(join(this.output, 'invocation.json'), JSON.stringify({ command, mode, work: this.work, codeCache: this.codeCache }, null, 2));
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
    return this.waitForProgress(() => this.events().filter((event) => event.type === type).length >= count, `${type} #${count}`);
  }
  async ready() {
    await this.event('start');
    assert.equal(this.events().find((event) => event.type === 'start').sharedContainer, true);
    await this.nativeReceipt('ready');
    await this.settle();
  }
  waitForProgress(predicate, label) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(deadline); this.nativeProgress.off('progress', check); };
      const check = () => {
        try {
          const value = predicate();
          if (!value) return;
          cleanup(); resolve(value);
        } catch (error) { cleanup(); reject(error); }
      };
      const deadline = setTimeout(() => {
        cleanup(); reject(new Error(`Timed out: ${label}; artifacts: ${this.output}`));
      }, 12000);
      this.nativeProgress.on('progress', check);
      check();
    });
  }
  async nativeReceipt(type, id = 0) {
    const key = `${type}:${id}`;
    return this.waitForProgress(() => {
      this.health();
      const packet = this.nativeReceipts.get(key);
      if (packet) this.nativeReceipts.delete(key);
      return packet;
    }, `native ${key}`);
  }
  async nativeFence(id = ++this.nativeSequence, kind = 0) {
    this.send(`\x1b[?997;${id};${kind}n`);
    const receipt = await this.nativeReceipt('frame', id);
    assert.ok(receipt.generation >= (this.nativeGeneration ?? 0), 'stale native renderer receipt');
    this.nativeGeneration = receipt.generation;
    await this.queue;
    return receipt;
  }
  async settle() { await this.nativeFence(); }
  async observeAnimation() {
    await sleep(220); this.health();
    await this.nativeFence();
  }
  async command(command) {
    const id = ++this.nativeSequence;
    this.send(`\x1b[?997;${id};1n`);
    await this.nativeReceipt('armed', id);
    this.send(command + '\r');
    // The native submit promise includes reload and shortcut rebinding. Its
    // unchanged completion-status cells need not produce fresh terminal bytes.
    await this.nativeFence(id, 2);
  }
  async waitForScreen(predicate, label) {
    return until(async () => { await this.settle(); return predicate(this.screen()); }, label);
  }
  async clearDraft() {
    const receipt = await this.nativeFence();
    assert.equal(typeof receipt.clearAfter, 'number', 'native clear-key policy must be observable');
    const remaining = receipt.clearAfter - Date.now();
    if (remaining > 0) await sleep(remaining);
    this.send('\x03');
    await this.settle();
  }
  screen() {
    const buffer = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
  }
  tidyFrame() {
    const rows = this.screen();
    for (let top = 0; top < rows.length; top++) {
      const match = /╭─+╮/u.exec(rows[top]);
      if (!match) continue;
      const left = visibleWidth(rows[top].slice(0, match.index)), width = visibleWidth(match[0]);
      const bottom = rows.findIndex((row, index) => index > top && /^╰─+╯$/u.test(sliceByColumn(row, left, width)));
      if (bottom >= 0) return { left, width, top, bottom };
    }
    return undefined;
  }
  async refreshTidyBounds() {
    await this.settle();
    if (!this.observeMenuBounds) return;
    const count = this.events().filter(event => event.type === 'menu_bounds').length;
    this.send('\x1b\x07'); await this.event('menu_bounds', count + 1);
    await this.settle();
    this.menuBounds = this.events().filter(event => event.type === 'menu_bounds').at(-1).bounds ?? undefined;
  }
  tidyRows() {
    const frame = this.tidyFrame();
    if (!frame && this.menuBounds) {
      const bounds = this.menuBounds;
      return this.screen().map((row, index) => index >= bounds.row && index < bounds.row + bounds.height
        ? sliceByColumn(row, bounds.col, bounds.width).trimEnd() : '');
    }
    if (!frame) return this.screen().map(row => row.trimEnd());
    return this.screen().map((row, index) => index > frame.top && index < frame.bottom
      ? sliceByColumn(row, frame.left + 1, frame.width - 2).trimEnd() : '');
  }
  tidyHeading(title) { return this.tidyRows().some(row => row === title || row.length >= 4 && row.endsWith('…') && title.startsWith(row.slice(0, -1))); }
  async completeTidyRows() {
    return until(async () => {
      await this.queue;
      return !this.rendering && this.tidyRows();
    }, 'complete synchronized popup frame');
  }
  async openTidyMenu() {
    this.send('/tidy-ui\r');
    await until(async () => { await this.refreshTidyBounds(); return this.tidyHeading('Tidy UI') || this.tidyRows().some(row => row.startsWith('→ Code color theme')); }, 'public Tidy UI popup');
    await this.refreshTidyBounds();
  }
  async selectTidyItem(label, activate = true) {
    const selected = () => this.tidyRows().findIndex(row => row.startsWith('→ '));
    for (let i = 0; i < 100; i++) {
      await this.refreshTidyBounds();
      const index = selected(), row = this.tidyRows()[index];
      assert.ok(row, `selected public popup row for ${label}: ${this.screen().join('\n')}`);
      const paintedLabel = row.slice(2).split('…')[0].split(/ {2,}/u)[0].replace(/\s+›$/u, '').trimEnd();
      // This root row has an arbitrary theme value; an exact-fit label can leave only one separating space.
      const rootTheme = label === 'Code color theme' && row.startsWith(`→ ${label} `);
      if (rootTheme || label.startsWith(paintedLabel)) {
        if (!activate) return row;
        const before = row;
        this.send('\r');
        const pages = ['Code color theme', 'Status & troubleshooting', 'Highlighting service details', 'Diagnostic logs', 'Display cache'];
        if (pages.includes(label)) await until(async () => {
          await this.refreshTidyBounds();
          const rows = this.tidyRows(), selected = rows.find(line => line.startsWith('→ ')) ?? '';
          const first = { 'Status & troubleshooting': 'Reapply Tidy UI appearance', 'Highlighting service details': 'Back',
            'Diagnostic logs': 'Record diagnostic logs', 'Display cache': 'Refresh statistics' }[label];
          const prefix = selected.slice(2).split('…')[0].split(/ {2,}/u)[0].trimEnd();
          return (this.tidyHeading(label) || this.menuBounds && !this.tidyFrame()) && !rows.some(line => line.includes('Loading saved code theme')) &&
            (first ? prefix && first.startsWith(prefix) : selected.includes('Follow Pi') || selected.endsWith('Selected'));
        }, `popup page ${label}`);
        else await until(async () => {
          await this.refreshTidyBounds();
          const rows = this.tidyRows();
          const switches = { 'Tidy UI appearance': 'appearanceEnabled', 'Set terminal colors from Pi theme': 'terminalColorsEnabled',
            'Use Occipital highlighting': 'nativeHighlightingEnabled', 'Record diagnostic logs': 'loggingEnabled' };
          const key = switches[label];
          if (key) {
            const selected = rows.find(line => line.startsWith('→ '));
            if (selected === before) return false;
            if (key === 'appearanceEnabled' || key === 'loggingEnabled') return selected?.endsWith(before.endsWith('Off') ? 'On' : 'Off') && !rows.includes('Applying…');
            try { return JSON.parse(readFileSync(join(this.agent, 'extensions/pi-tidy-ui/config.json'), 'utf8'))[key] === before.endsWith('Off'); }
            catch { return false; }
          }
          const rootSelection = rows.some(line => line.startsWith('→ Code color theme'));
          if (this.tidyHeading('Tidy UI') || this.menuBounds && rootSelection) {
            if (!rootSelection) return false;
            try {
              const choice = JSON.parse(readFileSync(join(this.agent, 'extensions/pi-tidy-ui/config.json'), 'utf8')).syntaxTheme;
              return choice?.kind === (label === 'Follow Pi theme' ? 'pi' : 'occipital');
            } catch { return false; }
          }
          return rows.some(line => /Done\.|Status refreshed\.|Cache statistics refreshed\./u.test(line));
        }, `popup action ${label}`);
        await this.refreshTidyBounds();
        return;
      }
      const before = `${index}:${row}`;
      this.send('\x1b[B');
      await until(async () => { await this.refreshTidyBounds(); return `${selected()}:${this.tidyRows()[selected()]}` !== before; }, `popup selection after ${paintedLabel}`);
    }
    assert.fail(`Public popup item not found: ${label}`);
  }
  async closeTidyMenu() {
    const framed = !!this.tidyFrame(), selected = this.tidyRows().find(row => row.startsWith('→ '));
    this.send('\x03');
    // The restored transcript may itself contain native → read summaries.
    await until(async () => {
      await this.refreshTidyBounds();
      return this.observeMenuBounds ? !this.menuBounds : framed ? !this.tidyFrame() : !this.tidyRows().includes(selected);
    }, 'popup closed');
  }
  async tidyPage(path = []) {
    await this.openTidyMenu();
    try { for (const label of path) await this.selectTidyItem(label); return this.tidyRows(); }
    finally { await this.closeTidyMenu(); }
  }
  async appearance(enabled, { alreadyOpen = false, leaveOpen = false } = {}) {
    if (alreadyOpen) await until(async () => { await this.refreshTidyBounds(); return this.tidyRows().some(row => row.startsWith('→ ')); }, 'shortcut opened public settings popup');
    else await this.openTidyMenu();
    try {
      const row = await this.selectTidyItem('Tidy UI appearance', false);
      if (row.endsWith(enabled ? 'Off' : 'On')) await this.selectTidyItem('Tidy UI appearance');
      else if (enabled) { await this.selectTidyItem('Status & troubleshooting'); await this.selectTidyItem('Reapply Tidy UI appearance'); }
    } finally { if (!leaveOpen) await this.closeTidyMenu(); }
  }
  async terminalColors(enabled, { alreadyOpen = false } = {}) {
    if (alreadyOpen) await until(() => this.tidyHeading('Tidy UI'), 'shortcut opened terminal-color settings');
    else await this.openTidyMenu();
    try {
      const row = await this.selectTidyItem('Set terminal colors from Pi theme', false);
      if (row.endsWith(enabled ? 'Off' : 'On')) await this.selectTidyItem('Set terminal colors from Pi theme');
      else if (enabled) { await this.selectTidyItem('Status & troubleshooting'); await this.selectTidyItem('Reapply terminal colors'); }
    } finally { await this.closeTidyMenu(); }
  }
  async diagnosticLogging(enabled) {
    await this.openTidyMenu();
    try {
      await this.selectTidyItem('Status & troubleshooting'); await this.selectTidyItem('Diagnostic logs');
      const row = await this.selectTidyItem('Record diagnostic logs', false);
      if (row.endsWith(enabled ? 'Off' : 'On')) await this.selectTidyItem('Record diagnostic logs');
    } finally { await this.closeTidyMenu(); }
  }
  async cacheSnapshot(clear = false, { alreadyOpen = false, beforeClose, refreshAfterClear = false } = {}) {
    if (alreadyOpen) await until(() => this.tidyHeading('Tidy UI'), 'shortcut opened cache popup');
    else await this.openTidyMenu();
    try {
      await this.selectTidyItem('Status & troubleshooting'); await this.selectTidyItem('Display cache');
      if (clear) {
        await this.selectTidyItem('Clear saved layouts');
        await until(() => this.tidyRows().some(row => row.startsWith('Saved layouts: 0;')), 'zero-layout clear receipt in public popup');
      }
      if (clear && refreshAfterClear) await this.selectTidyItem('Refresh statistics');
      let combined = [], previous = []; const observations = [];
      // The frozen snapshot is finite; stop at its marker or fail on a stalled viewport.
      for (;;) {
        const rows = await this.completeTidyRows(), start = rows.indexOf('Display cache') + 2;
        const end = rows.findIndex(row => /^(?:→ |  )(?:Refresh statistics|Clear saved layouts|Back)/u.test(row));
        assert.ok(start > 0 && end > start, `public cache detail region is visible: ${JSON.stringify(rows)}`);
        const current = rows.slice(start, end);
        let overlap = Math.min(previous.length, current.length);
        while (overlap && JSON.stringify(previous.slice(-overlap)) !== JSON.stringify(current.slice(0, overlap))) overlap--;
        combined.push(...current.slice(overlap)); previous = current;
        observations.push({ current, overlap, rendering: this.rendering, completedRenders: this.completedRenders, chunks: this.raw?.length });
        const begin = combined.indexOf('Diagnostic JSON:'), finish = combined.indexOf('End diagnostic JSON');
        if (begin >= 0 && finish > begin) {
          let result;
          try { result = JSON.parse(combined.slice(begin + 1, finish).join('')); }
          catch (error) {
            writeFileSync(join(this.output, 'cache-json-parse-failure.json'), JSON.stringify({ combined, observations }, null, 2));
            this.captureScreen('cache-json-parse-failure', {}); throw error;
          }
          if (clear) this.captureScreen('tidy-cache-cleared', { cacheSnapshot: result });
          beforeClose?.(result); return result;
        }
        this.send('\x1b[6~');
        await until(async () => JSON.stringify((await this.completeTidyRows()).slice(start, end)) !== JSON.stringify(current), 'scroll public cache details');
      }
    } finally { await this.closeTidyMenu(); }
  }
  async capture(name, { sampleAnimation = false } = {}) {
    await this.command(`/tidy-ui-dump ${name}`);
    const dump = await until(() => {
      this.health();
      try { return JSON.parse(readFileSync(join(this.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `live capture ${name}`);
    this.session = dump.session;
    return this.captureCompleteScreen(name, dump, sampleAnimation);
  }
  async captureCompleteScreen(name, dump, sampleAnimation = false) {
    if (sampleAnimation) await this.observeAnimation(); else await this.settle();
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
        italic: cell.isItalic(), underline: cell.isUnderline(), strike: !!cell.isStrikethrough(), inverse: !!cell.isInverse(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() } : null;
    }));
    writeFileSync(join(this.output, `${name}.screen.json`), JSON.stringify(cells));
    return { ...dump, screen, cells };
  }
  async run(scenario = 'suite') {
    const count = this.events().filter((e) => e.type === 'agent_end').length;
    this.send(`run ${scenario}\r`);
    await this.event('agent_end', count + 1);
    await this.settle();
    await until(async () => {
      this.health(); await this.queue;
      return !this.rendering && this.screen().some(line => line.includes(`TERMINAL_DONE_${scenario}`));
    }, `completed scenario frame: ${scenario}`);
  }
  async resize(cols, rows = 80, sampleAnimation = false) {
    const id = ++this.resizeSequence;
    this.term.resize(cols, rows);
    this.child.stdin.write(JSON.stringify({ resize: [cols, rows], id }) + '\n');
    await this.waitForProgress(() => {
      this.health();
      return this.ptySize?.id === id && this.ptySize.width === cols && this.ptySize.height === rows;
    }, `PTY resize ${id}: ${cols}x${rows}`);
    // ioctl completion precedes Node's SIGWINCH/TTY refresh. Read the driver's
    // actual host observation, never infer dimensions from quiet output.
    // Identical sizes need no new resize event, but still require the fresh receipt above.
    await this.waitForProgress(() => {
      const size = this.events().findLast(event => event.type === 'terminal_size');
      return size?.width === cols && size.height === rows;
    }, `Pi geometry ${id}: ${cols}x${rows}`);
    if (sampleAnimation) await this.observeAnimation(); else await this.settle();
  }
  async quit(input = '/quit\r') {
    this.health();
    this.expectedPiExit = 0;
    this.send(input);
    await this.waitForProgress(() => {
      if (this.error) throw this.error;
      return this.closed;
    }, 'normal Pi exit');
    await this.queue;
    assert.equal(this.piExit, 0, 'normal quit requires the actual Pi exit receipt');
    assert.deepEqual(this.exited, { code: 0, signal: null }, 'normal quit requires successful bridge closure');
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
    if (!this.closed) {
      const done = once(this.child, 'close');
      if (!this.exited) this.child.stdin.end('{"stop":true}\n');
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 2500);
      let deadline;
      try { await Promise.race([done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Bridge cleanup timeout')), 5500);
      })]); }
      finally { clearTimeout(timer); clearTimeout(deadline); }
    }
    await this.queue;
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    if (this.shutdown) writeFileSync(join(this.output, 'shutdown.json'), JSON.stringify(this.shutdown));
    this.rl.close(); this.term.dispose();
    if (this.error) throw this.error;
  }
  dispose() { rmSync(this.temp, { recursive: true, force: true }); }
}
