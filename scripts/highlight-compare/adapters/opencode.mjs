import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mapOpenCodeSource, styledSourceWitness } from './opencode-source.mjs';
import { observeOpenCodeDiff } from './opencode-diff.mjs';
import { loadOpenCodeTheme, prepareOpenCodeTheme } from './opencode-theme.mjs';
import { digest, normalizeSource } from '../model.mjs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { isolatedCommand } from '../../test/run.mjs';
import { childEnv, toolPath } from '../../test/context.mjs';
import { detachTerminalScreen, observeRenderFrames } from '../../../tests/fixtures/terminal-harness.mjs';

const PINNED_VERSION = '1.19.5';
const PINNED_SHA256 = '7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c';
const OPEN_CODE_COMMIT = '810c0eba1a7348036f8bdf61e6632d0c36c6876c';
const OPEN_TUI_COMMIT = '0c8c4f7cff2927e3df63a9757a45eff9a343611c';
const OPEN_TUI_CODE_SOURCE = 'packages/core/src/renderables/Code.ts';
const OPEN_TUI_CODE_LINES = '317-421';
// Unknown native names silently fall back, so the accepted catalogue belongs to the executable profile.
const NATIVE_THEMES = new Set(('aura ayu carbonfox catppuccin catppuccin-frappe catppuccin-macchiato cobalt2 cursor dracula everforest flexoki github gruvbox kanagawa lucent-orng material matrix mercury monokai nightowl nord one-dark opencode orng osaka-jade palenight rosepine solarized synthwave84 tokyonight vercel vesper zenburn').split(' '));
const ASSET_EXTENSIONS = new Set(['.wasm', '.scm']);
const SAVED_MODEL = { providerID: 'opencode', modelID: 'big-pickle' };
const BRIDGE_PATH = fileURLToPath(new URL('../../../tests/fixtures/pty_bridge.py', import.meta.url));

function readInputs(value) {
  const inputs = typeof value === 'string' ? JSON.parse(readFileSync(value, 'utf8')) : value;
  assert.ok(inputs && typeof inputs === 'object' && inputs.schema === 1, 'OpenCode capture requires prepared test inputs');
  assert.ok(inputs.tools?.python3 && inputs.tools?.bwrap && inputs.pi?.root, 'prepared inputs must declare Python, bwrap and the selected Pi graph');
  return inputs;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function runProcess(command, args, { cwd, env, timeoutMs = 20000, outputLimit = 4 * 1024 * 1024 } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > outputLimit) {
        child.kill('SIGKILL');
        reject(new Error(`${command} exceeded its ${outputLimit}-byte output limit`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${command} exited ${code}: ${result.stderr || result.stdout}`));
      resolvePromise(result);
    });
  });
}

async function verifyBinary(binary, env) {
  assert.equal(typeof binary, 'string', 'binary must name the pinned OpenCode executable');
  const actual = realpathSync(binary);
  assert.ok(statSync(actual).isFile(), 'OpenCode executable must be a regular file');
  const [hash, versionResult] = await Promise.all([
    sha256File(actual),
    runProcess(actual, ['--version'], { cwd: env.OPENCODE_TEST_HOME, env, timeoutMs: 10000, outputLimit: 4096 }),
  ]);
  const version = versionResult.stdout.trim().split(/\s+/).at(-1);
  assert.equal(version, PINNED_VERSION, `expected OpenCode ${PINNED_VERSION}`);
  assert.equal(hash, PINNED_SHA256, 'installed OpenCode executable hash differs from the pinned 1.19.5 binary');
  return { path: actual, version, sha256: hash, bytes: statSync(actual).size };
}

function privateEnvironment(root, theme, variant, inputs, diffStyle = 'stacked') {
  const dirs = {
    root,
    home: join(root, 'home'),
    configHome: join(root, 'config'),
    cacheHome: join(root, 'cache'),
    dataHome: join(root, 'data'),
    stateHome: join(root, 'state'),
    runtime: join(root, 'run'),
    tmp: join(root, 'tmp'),
    config: join(root, 'config', 'opencode'),
    cache: join(root, 'cache', 'opencode'),
    data: join(root, 'data', 'opencode'),
    state: join(root, 'state', 'opencode'),
  };
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const configPath = join(dirs.config, 'tui.json');
  const kvPath = join(dirs.state, 'kv.json');
  writeFileSync(join(dirs.config, 'opencode.json'), '{}\n', { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ theme, mouse: false, diff_style: diffStyle }, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(kvPath, JSON.stringify({ theme, theme_mode_lock: variant, tool_details_visibility: true, sidebar: 'hide' }, null, 2) + '\n', { mode: 0o600 });
  const env = childEnv(root, {
    XDG_CONFIG_HOME: dirs.configHome,
    XDG_CACHE_HOME: dirs.cacheHome,
    XDG_DATA_HOME: dirs.dataHome,
    XDG_STATE_HOME: dirs.stateHome,
    XDG_RUNTIME_DIR: dirs.runtime,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_TELEMETRY: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_TEST_HOME: dirs.home,
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCODE_TUI_CONFIG: configPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }, inputs);
  return { dirs, configPath, kvPath, env };
}

export function validateTheme(theme, variant) {
  assert.equal(typeof theme, 'string', 'theme must be a native OpenCode family id');
  assert.ok(NATIVE_THEMES.has(theme), 'theme must be a built-in family in the pinned OpenCode TUI catalogue');
  assert.ok(['dark', 'light'].includes(variant), 'variant must be dark or light');
}

function validateFilename(filename) {
  assert.equal(typeof filename, 'string', 'fixture filename is required');
  assert.ok(filename.length > 0 && !filename.includes('\0') && !filename.includes('\n') && !filename.includes('\r'), 'fixture filename must be a plain relative path');
  assert.ok(!isAbsolute(filename), 'fixture filename must be relative to the isolated project');
  const components = filename.split(/[\\/]/);
  assert.ok(components.every(part => part && part !== '.' && part !== '..'), 'fixture filename may not contain empty or traversal path components');
  return components.join(sep);
}

function makeId(prefix) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(26);
  return `${prefix}_${Array.from(bytes, byte => chars[byte % chars.length]).join('')}`;
}

function nativeSession(fixture, workspace, sessionId) {
  const now = Date.now();
  const userId = makeId('msg');
  const assistantId = makeId('msg');
  const userPartId = makeId('prt');
  const toolPartId = makeId('prt');
  const filename = validateFilename(fixture.filename);
  const filePath = join(workspace, filename);
  const isSource = fixture.kind === 'source';
  const tool = isSource ? 'write' : 'edit';
  const input = isSource
    ? { filePath, content: fixture.content }
    : { filePath, oldString: fixture.before, newString: fixture.after };
  const toolMetadata = isSource ? { diagnostics: {} } : { diff: fixture.patch };
  const session = {
    info: {
      id: sessionId,
      slug: `highlight-${fixture.id}`,
      projectID: makeId('prj'),
      directory: workspace,
      path: '.',
      title: `Highlight comparison ${fixture.id}`,
      version: PINNED_VERSION,
      time: { created: now, updated: now },
    },
    messages: [
      {
        info: {
          id: userId,
          sessionID: sessionId,
          role: 'user',
          time: { created: now },
          agent: 'build',
          model: { ...SAVED_MODEL },
        },
        parts: [{ id: userPartId, sessionID: sessionId, messageID: userId, type: 'text', text: `Render the completed ${tool} call for ${fixture.filename}.` }],
      },
      {
        info: {
          id: assistantId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created: now + 1, completed: now + 2 },
          parentID: userId,
          ...SAVED_MODEL,
          mode: 'build',
          agent: 'build',
          path: { cwd: workspace, root: workspace },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: toolPartId,
          sessionID: sessionId,
          messageID: assistantId,
          type: 'tool',
          callID: makeId('call'),
          tool,
          state: {
            status: 'completed',
            input,
            output: `${isSource ? 'Wrote' : 'Edited'} ${fixture.filename}`,
            title: `${tool} ${fixture.filename}`,
            metadata: toolMetadata,
            time: { start: now, end: now + 1 },
          },
        }],
      },
    ],
  };
  return { session, filePath };
}

function validateFixture(fixture) {
  assert.ok(fixture && typeof fixture === 'object', 'fixture must be supplied');
  assert.equal(typeof fixture.id, 'string');
  validateFilename(fixture.filename);
  if (fixture.kind === 'source') {
    assert.equal(extname(fixture.filename).toLowerCase(), '.py', 'the initial OpenCode source adapter supports the planned Python corpus only');
    assert.equal(typeof fixture.content, 'string');
  } else if (fixture.kind === 'diff') {
    assert.equal(typeof fixture.before, 'string');
    assert.equal(typeof fixture.after, 'string');
    assert.equal(typeof fixture.patch, 'string');
    assert.match(fixture.patch, /^(?:diff --git .*\n)?--- .*\n\+\+\+ .*\n@@ /m, 'diff fixture must contain a standard unified patch');
    assert.match(fixture.patch, /(?:^|\n)[ +\\-]/, 'unified patch must contain at least one hunk row');
  } else {
    throw new Error(`unsupported OpenCode fixture kind: ${fixture.kind}`);
  }
}

export function writeSessionFixture(fixture, workspace, sessionId, sessionPath) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const { session, filePath } = nativeSession(fixture, workspace, sessionId);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  if (fixture.kind === 'source') writeFileSync(filePath, fixture.content, { mode: 0o600 });
  else writeFileSync(filePath, fixture.after, { mode: 0o600 });
  writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  return { session, filePath };
}

function walkAssets(root, base = root, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkAssets(path, base, found);
    else if (entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
}

async function runtimeAssets(dirs) {
  const roots = [dirs.home, dirs.configHome, dirs.cacheHome, dirs.dataHome, dirs.stateHome];
  const paths = [...new Set(roots.flatMap(root => walkAssets(root)))].sort();
  const assets = [];
  for (const path of paths) {
    const stat = statSync(path);
    assets.push({ path, sha256: await sha256File(path), bytes: stat.size });
  }
  return assets;
}

async function waitForWarmRuntimeAssets(dirs, timeoutMs = 45000) {
  const roots = [dirs.home, dirs.configHome, dirs.cacheHome, dirs.dataHome, dirs.stateHome];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paths = [...new Set(roots.flatMap(root => walkAssets(root)))];
    const hasWasm = paths.some(path => extname(path).toLowerCase() === '.wasm');
    const hasQuery = paths.some(path => extname(path).toLowerCase() === '.scm');
    if (hasWasm && hasQuery) return await runtimeAssets(dirs);
    await sleep(250);
  }
  throw new Error(`OpenCode warmup acquired no complete private WASM/query asset set within ${timeoutMs}ms`);
}

function verifyRuntimeAssets(assets) {
  assert.ok(assets.length > 0, 'OpenCode prepared no runtime Tree-sitter WASM/query assets');
  assert.ok(assets.some(asset => extname(asset.path).toLowerCase() === '.wasm'), 'OpenCode did not persist the runtime Tree-sitter WASM grammar');
  assert.ok(assets.some(asset => extname(asset.path).toLowerCase() === '.scm'), 'OpenCode did not persist the runtime Tree-sitter query');
}

function debugPathsMatch(output, dirs) {
  const expected = new Map([
    ['home', dirs.home], ['config', dirs.config], ['cache', dirs.cache], ['data', dirs.data], ['state', dirs.state],
  ]);
  const actual = new Map(output.split(/\r?\n/).map(line => line.trim().split(/\s+/, 2)).filter(parts => parts.length === 2));
  for (const [name, path] of expected) assert.equal(actual.get(name), path, `OpenCode debug paths did not resolve the private ${name} directory`);
}

export function neutralWorkspace(parent) {
  assert.ok(isAbsolute(parent ?? ''), 'OpenCode workspace requires the explicit prepared neutral run root');
  const workspace = mkdtempSync(join(parent, 'tidy-opencode-compare-'));
  try {
    for (let current = workspace; ; current = dirname(current)) {
      assert.ok(!existsSync(join(current, '.opencode')), 'OpenCode workspace has a foreign .opencode ancestor');
      if (dirname(current) === current) break;
    }
    return workspace;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

class OpenCodePty {
  constructor({ inputs, binary, cwd, env, dimensions, output, networkIsolated }) {
    this.inputs = inputs;
    this.binary = binary;
    this.cwd = cwd;
    this.env = env;
    this.dimensions = dimensions;
    this.output = output;
    this.networkIsolated = networkIsolated;
    this.term = null;
    this.state = { completedRenders: 0, rendering: false };
    this.raw = [];
    this.events = [];
    this.sequence = 0;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.failed = null;
  }

  async start(sessionId) {
    this.sessionId = sessionId;
    this.spawnArgs = this.networkIsolated
      ? isolatedCommand(this.binary, ['--pure', '--session', sessionId, '.'], this.inputs)
      : { command: this.binary, args: ['--pure', '--session', sessionId, '.'] };
    const xtermModule = createXterm(this.inputs);
    this.term = new xtermModule.Terminal({ cols: this.dimensions.columns, rows: this.dimensions.rows, scrollback: 3000, allowProposedApi: true });
    observeRenderFrames(this.term, this.state);
    this.child = spawn(toolPath('python3', this.inputs), ['-I', '-S', BRIDGE_PATH, String(this.dimensions.columns), String(this.dimensions.rows), this.cwd, this.spawnArgs.command, ...this.spawnArgs.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ready = new Promise((resolvePromise, reject) => {
      let stderr = '';
      this.child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      this.child.once('error', reject);
      this.child.once('close', code => {
        this.closed = true;
        if (!this.stopping) this.failed ??= new Error(`OpenCode PTY bridge exited unexpectedly (${code}): ${stderr}`);
      });
      this.child.stdout.on('data', chunk => {
        this.pending += this.decoder.write(chunk);
        let end;
        while ((end = this.pending.indexOf('\n')) >= 0) {
          const line = this.pending.slice(0, end);
          this.pending = this.pending.slice(end + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch (error) { this.failed = new Error(`invalid PTY bridge event: ${error.message}`); continue; }
          this.events.push(event);
          if (event.error) this.failed = new Error(`PTY bridge: ${event.error}`);
          if (event.ready) resolvePromise(event);
          if (event.data) {
            const bytes = Buffer.from(event.data, 'base64');
            this.raw.push(bytes);
            this.term.write(bytes);
          }
        }
      });
      setTimeout(() => reject(new Error('OpenCode PTY bridge did not become ready')), 10000).unref();
    });
    return await this.ready;
  }

  check() { if (this.failed) throw this.failed; }

  async waitFrame(after, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      this.check();
      if (this.state.completedRenders > after && !this.state.rendering) return this.state.completedRenders;
      await sleep(20);
    }
    throw new Error(`OpenCode produced no completed synchronized render after PTY input; observed ${this.state.completedRenders} complete frames`);
  }

  async sendInput(bytes, kind) {
    this.check();
    const before = this.state.completedRenders;
    const sequence = { sequence: ++this.sequence, kind, bytes: Buffer.from(bytes).toString('base64'), frameBefore: before };
    this.events.push({ input: sequence });
    this.child.stdin.write(JSON.stringify({ input: sequence.bytes }) + '\n');
    return before;
  }

  async resize(columns, rows) {
    this.check();
    this.term.resize(columns, rows);
    const id = ++this.sequence;
    this.events.push({ resize: { id, columns, rows } });
    this.child.stdin.write(JSON.stringify({ resize: [columns, rows], id }) + '\n');
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      this.check();
      if (this.events.some(event => event.resized?.[0] === columns && event.resized?.[1] === rows && event.id === id)) return;
      await sleep(10);
    }
    throw new Error(`PTY bridge did not acknowledge resize ${columns}x${rows}`);
  }

  snapshot() {
    this.check();
    const page = detachTerminalScreen(this.term);
    return { ...page, frame: this.state.completedRenders, rendering: this.state.rendering };
  }

  async stop() {
    this.stopping = true;
    if (this.child && !this.closed) {
      this.child.stdin.write(JSON.stringify({ stop: true }) + '\n');
      this.child.stdin.end();
      await new Promise(resolvePromise => {
        const timer = setTimeout(() => { this.child.kill('SIGTERM'); resolvePromise(); }, 5000);
        this.child.once('close', () => { clearTimeout(timer); resolvePromise(); });
      });
    }
    if (this.term) {
      writeFileSync(join(this.output, 'last-native-screen.json'), JSON.stringify({ ...detachTerminalScreen(this.term),
        frame: this.state.completedRenders, rendering: this.state.rendering }), { mode: 0o600 });
      this.term.dispose();
    }
    writeFileSync(join(this.output, 'raw-pty.bin'), Buffer.concat(this.raw), { mode: 0o600 });
    writeFileSync(join(this.output, 'pty-events.json'), JSON.stringify({ events: this.events, bridge: this.events.filter(event => event.shutdown || event.exit) }, null, 2) + '\n', { mode: 0o600 });
  }
}

function createXterm(inputs) {
  // Resolve the already-prepared test dependency from its owned graph, not from operator state.
  const require = createRequire(join(inputs.pi.root, 'package.json'));
  const loaded = require('@xterm/headless');
  return loaded.default ?? loaded;
}

async function importSession(binary, sessionPath, workspace, env, output) {
  const result = await runProcess(binary, ['--pure', 'import', sessionPath], { cwd: workspace, env, timeoutMs: 30000 });
  writeFileSync(join(output, 'import.stdout.txt'), result.stdout, { mode: 0o600 });
  writeFileSync(join(output, 'import.stderr.txt'), result.stderr, { mode: 0o600 });
  assert.match(result.stdout, /Imported session:/, 'OpenCode did not confirm importing the native saved session');
}

function loadPrepared(prepared) {
  if (typeof prepared === 'string') return JSON.parse(readFileSync(prepared, 'utf8'));
  if (prepared && typeof prepared === 'object' && prepared.descriptorPath && !prepared.root) return JSON.parse(readFileSync(prepared.descriptorPath, 'utf8'));
  return prepared;
}

function safeCopyRuntimeAssets(prepared, destinationRoot) {
  const assets = prepared.runtimeAssets;
  verifyRuntimeAssets(assets);
  for (const asset of assets) {
    const source = resolve(asset.path);
    const relativePath = relative(prepared.root, source);
    assert.ok(relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath), 'runtime asset escaped the prepared OpenCode root');
    assert.equal(statSync(source).size, asset.bytes, `prepared runtime asset size changed: ${asset.path}`);
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), asset.sha256, `prepared runtime asset hash changed: ${asset.path}`);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, readFileSync(source), { mode: 0o600 });
  }
  return assets.map(asset => ({ ...asset, path: join(destinationRoot, relative(prepared.root, asset.path)) }));
}

async function runWarmup(root, inputs, binary, theme, variant) {
  const warmOutput = join(root, 'warmup');
  const envState = privateEnvironment(root, theme, variant, inputs);
  const workspace = neutralWorkspace(inputs.runRoot);
  let pty;
  try {
    const fixture = { kind: 'source', id: 'runtime-asset-warmup', filename: 'warmup.py',
      content: 'def highlight_ready():\n    value = "prepared"\n    return value\n' };
    const sessionId = makeId('ses'), sessionPath = join(warmOutput, 'session.json');
    mkdirSync(warmOutput, { recursive: true, mode: 0o700 });
    writeSessionFixture(fixture, workspace, sessionId, sessionPath);
    await importSession(binary, sessionPath, workspace, envState.env, warmOutput);
    pty = new OpenCodePty({ inputs, binary, cwd: workspace, env: envState.env,
      dimensions: { columns: 100, rows: 50 }, output: warmOutput, networkIsolated: false });
    await pty.start(sessionId);
    await pty.waitFrame(0, 15000);
    const deadline = Date.now() + 25000;
    let visible = false;
    while (Date.now() < deadline) {
      if (pty.snapshot().screen.join('\n').includes('def highlight_ready')) { visible = true; break; }
      const frame = pty.state.completedRenders;
      try { await pty.waitFrame(frame, 1000); } catch { await pty.sendInput('\x1b[5~', 'warmup-page-up'); }
    }
    assert.ok(visible, 'OpenCode PTY did not show the imported Python Write body');
    await waitForWarmRuntimeAssets(envState.dirs);
    writeFileSync(join(warmOutput, 'prepared-screen.json'), JSON.stringify(pty.snapshot()), { flag: 'wx', mode: 0o600 });
  } finally {
    try { await pty?.stop(); } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
}

export async function prepareOpenCode({ inputs: inputValue, binary = '/usr/bin/opencode', theme, variant, output }) {
  const inputs = readInputs(inputValue);
  validateTheme(theme, variant);
  assert.ok(typeof output === 'string' && output.length > 0 && isAbsolute(output), 'prepare output must be absolute');
  const root = resolve(output);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const themeInputs = prepareOpenCodeTheme({ inputs, output: root, theme, variant, commit: OPEN_CODE_COMMIT, version: PINNED_VERSION });
  const envState = privateEnvironment(root, theme, variant, inputs);
  const app = await verifyBinary(binary, envState.env);
  const paths = await runProcess(app.path, ['debug', 'paths'], { cwd: root, env: envState.env, timeoutMs: 10000 });
  writeFileSync(join(root, 'debug-paths.txt'), paths.stdout, { mode: 0o600 });
  debugPathsMatch(paths.stdout, envState.dirs);
  await runWarmup(root, inputs, app.path, theme, variant);
  const assets = await runtimeAssets(envState.dirs);
  verifyRuntimeAssets(assets);
  const descriptor = {
    schema: 1,
    application: 'OpenCode TUI',
    binary: app,
    root,
    paths: envState.dirs,
    configPath: envState.configPath,
    kvPath: envState.kvPath,
    runtimeAssets: assets,
    themeInputs,
    openCode: { commit: OPEN_CODE_COMMIT, themeCatalogue: 'packages/tui/src/theme/index.ts' },
    openTui: { commit: OPEN_TUI_COMMIT, codeSource: OPEN_TUI_CODE_SOURCE, lines: OPEN_TUI_CODE_LINES },
    preparedAt: new Date().toISOString(),
  };
  return descriptor;
}

export function verifyThemeState(theme, variant, configPath, kvPath, nativeLog, diffStyle = 'stacked') {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const kv = JSON.parse(readFileSync(kvPath, 'utf8'));
  assert.equal(config.theme, theme, 'OpenCode TUI config no longer selects the requested native theme');
  assert.equal(config.mouse, false, 'OpenCode source capture must disable native mouse selection');
  assert.equal(config.diff_style, diffStyle, 'OpenCode capture must retain the declared native diff style');
  assert.equal(kv.theme, theme, 'OpenCode KV state no longer selects the requested native theme');
  assert.equal(kv.theme_mode_lock, variant, 'OpenCode KV variant lock does not match the requested variant');
  assert.equal(kv.tool_details_visibility, true, 'OpenCode must retain the native detailed Write view');
  assert.equal(kv.sidebar, 'hide', 'OpenCode source collection requires the native sidebar hidden');
  const evidence = { configPath, configSha256: digest(readFileSync(configPath)), kvPath,
    configTheme: config.theme, themeModeLock: kv.theme_mode_lock, mouse: config.mouse, diffStyle: config.diff_style };
  if (nativeLog !== undefined) {
    const applied = nativeLog.split('\n').filter(line => line.includes('message="applying tui config"'));
    assert.ok(applied.length, 'native TUI did not confirm applying its private configuration');
    for (const line of applied) {
      const value = /\bpath=("(?:[^"\\]|\\.)*"|\S+)/.exec(line)?.[1];
      assert.equal(value?.startsWith('"') ? JSON.parse(value) : value, configPath, 'native TUI applied an undeclared configuration');
    }
    evidence.nativeApplied = { sha256: digest(nativeLog), records: applied.length };
  }
  return { family: theme, variant, evidence };
}

export async function collectOpenCode({ inputs: inputValue, binary = '/usr/bin/opencode', prepared: preparedValue, fixture, theme, variant, dimensions, output }) {
  const inputs = readInputs(inputValue);
  validateTheme(theme, variant);
  validateFixture(fixture);
  assert.ok(dimensions && Number.isInteger(dimensions.columns) && dimensions.columns >= 24 && dimensions.columns <= 240, 'columns must be an integer from 24 to 240');
  assert.ok(Number.isInteger(dimensions.rows) && dimensions.rows >= 10 && dimensions.rows <= 150, 'rows must be an integer from 10 to 150');
  assert.ok(typeof output === 'string' && isAbsolute(output), 'collection output must be an absolute path');
  const prepared = loadPrepared(preparedValue);
  assert.equal(prepared?.schema, 1, 'invalid OpenCode prepared descriptor');
  assert.equal(prepared.openTui?.commit, OPEN_TUI_COMMIT, 'prepared OpenTUI does not match the publication protocol');
  const captureRoot = resolve(output);
  mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
  const themeProfile = loadOpenCodeTheme(prepared, theme, variant, OPEN_CODE_COMMIT, PINNED_VERSION);
  const environmentRoot = join(captureRoot, 'environment');
  const diffStyle = fixture.kind === 'diff' ? 'auto' : 'stacked';
  const envState = privateEnvironment(environmentRoot, theme, variant, inputs, diffStyle);
  const app = await verifyBinary(binary, envState.env);
  assert.equal(app.sha256, prepared.binary.sha256, 'collection binary differs from the prepared OpenCode binary');
  const copiedAssets = safeCopyRuntimeAssets(prepared, environmentRoot);
  const workspace = neutralWorkspace(inputs.runRoot);
  const finishEnvironment = async () => {
    const nativeLog = readFileSync(join(envState.dirs.data, 'log', 'opencode.log'), 'utf8');
    const effectiveTheme = verifyThemeState(theme, variant, envState.configPath, envState.kvPath, nativeLog, diffStyle);
    writeFileSync(join(captureRoot, 'native-config-evidence.json'), JSON.stringify(effectiveTheme, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const finalAssets = await runtimeAssets(envState.dirs);
    const assetIds = assets => assets.map(asset => `${relative(environmentRoot, asset.path)}:${asset.sha256}:${asset.bytes}`).sort();
    assert.deepEqual(assetIds(finalAssets), assetIds(copiedAssets), 'network-isolated OpenCode collection changed runtime parser assets');
    return effectiveTheme;
  };
  let pty;
  try {
    const sessionId = makeId('ses'), sessionPath = join(captureRoot, 'session.json');
    const { filePath } = writeSessionFixture(fixture, workspace, sessionId, sessionPath);
    const record = { application: 'OpenCode TUI', identity: { binary: app, openCode: { commit: OPEN_CODE_COMMIT },
      openTui: prepared.openTui, themeInputs: themeProfile.provenance }, session: { id: sessionId, sessionPath, filePath },
      dimensions, runtimeAssets: copiedAssets };
    await importSession(app.path, sessionPath, workspace, envState.env, captureRoot);
    verifyThemeState(theme, variant, envState.configPath, envState.kvPath, undefined, diffStyle);
    pty = new OpenCodePty({ inputs, binary: app.path, cwd: workspace, env: envState.env, dimensions, output: captureRoot, networkIsolated: true });
    await pty.start(sessionId);
    await pty.waitFrame(0, 15000);
    if (fixture.kind === 'diff') {
      const deadline = Date.now() + 15000;
      let page, initial, failure, preliminaryFrames = 0;
      while (Date.now() < deadline) {
        page = pty.snapshot(); preliminaryFrames++;
        try { initial = observeOpenCodeDiff(fixture, [page], themeProfile); break; }
        catch (error) { failure = error.message; }
        const before = !page.rendering && !page.screen.some(row => row.includes('← Edit ') && row.includes(fixture.filename))
          ? await pty.sendInput('\x1b[5~', 'diff-header-page-up') : pty.state.completedRenders;
        try { await pty.waitFrame(before, 1000); } catch { pty.check(); }
      }
      if (!initial) return { ...record, pages: [page], effectiveTheme: await finishEnvironment(),
        readiness: { status: 'unresolved', reason: failure, preliminaryFrames } };
      const alternateColumns = dimensions.columns === 240 ? dimensions.columns - 1 : dimensions.columns + 1;
      let before = pty.state.completedRenders;
      await pty.resize(alternateColumns, dimensions.rows); await pty.waitFrame(before, 3000);
      before = pty.state.completedRenders;
      await pty.resize(dimensions.columns, dimensions.rows); await pty.waitFrame(before, 5000);
      const pages = [page, pty.snapshot()];
      let observation;
      try { observation = observeOpenCodeDiff(fixture, pages, themeProfile); }
      catch (error) { return { ...record, pages, effectiveTheme: await finishEnvironment(),
        readiness: { status: 'unresolved', reason: error.message, preliminaryFrames, initial: initial.readiness } }; }
      return { ...record, ...observation, pages, effectiveTheme: await finishEnvironment(),
        readiness: { ...observation.readiness, preliminaryFrames },
        viewportSequence: pty.events.filter(event => event.input || event.resize) };
    }
    const deadline = Date.now() + 30000;
    let witness, headerSeen = false, preliminaryFrames = 0;
    while (Date.now() < deadline) {
      const page = pty.snapshot();
      preliminaryFrames++;
      headerSeen ||= page.screen.some(row => row.includes('# Wrote ') && row.includes(fixture.filename));
      let alignment;
      if (!page.rendering) {
        try { alignment = mapOpenCodeSource(fixture.content, [page]); }
        catch (error) { if (!/Ambiguous or missing native source gutter/.test(error.message)) throw error; }
      }
      if (alignment && headerSeen) witness = styledSourceWitness(fixture.content, page, alignment);
      if (witness) break;
      const before = alignment && !headerSeen ? await pty.sendInput('\x1b[5~', 'source-header-page-up') : pty.state.completedRenders;
      try { await pty.waitFrame(before, 1000); } catch { pty.check(); }
    }
    assert.ok(witness && headerSeen, 'OpenCode whole-source publication unresolved: no exact mapped multistyle source witness in the native detailed Write block');

    const pages = [], maps = [];
    let bodyColumn, normalized;
    for (let navigation = 0; navigation < 256; navigation++) {
      const page = pty.snapshot(), alignment = mapOpenCodeSource(fixture.content, [page]);
      assert.equal(page.rendering, false, 'OpenCode source page is inside an incomplete synchronized frame');
      bodyColumn ??= alignment.bodyColumn;
      assert.equal(alignment.bodyColumn, bodyColumn, 'native Write source gutter changed during collection');
      pages.push(page); maps.push(alignment.maps[0]);
      try { normalized = normalizeSource(fixture.content, pages, maps, { tabSize: alignment.tabSize, tabMode: alignment.tabMode }); }
      catch (error) { if (!error.message.startsWith('Incomplete source coverage:')) throw error; }
      if (normalized) break;
      const before = await pty.sendInput('\x1b[6~', 'source-page-down');
      await pty.waitFrame(before, 3000);
    }
    assert.ok(normalized, 'OpenCode navigation did not expose the complete immutable source within the bounded page count');
    const alternateColumns = dimensions.columns === 240 ? dimensions.columns - 1 : dimensions.columns + 1;
    let before = pty.state.completedRenders;
    await pty.resize(alternateColumns, dimensions.rows);
    await pty.waitFrame(before, 3000);
    before = pty.state.completedRenders;
    await pty.resize(dimensions.columns, dimensions.rows);
    await pty.waitFrame(before, 5000);
    const repeated = pty.snapshot(), repeatedMap = mapOpenCodeSource(fixture.content, [repeated]);
    assert.equal(repeated.rendering, false, 'Repeated OpenCode source page is inside an incomplete synchronized frame');
    assert.equal(repeatedMap.bodyColumn, bodyColumn, 'repeated native frame changed source gutter');
    pages.push(repeated); maps.push(repeatedMap.maps[0]);
    normalizeSource(fixture.content, pages, maps, { tabSize: normalized.tabSize, tabMode: normalized.tabMode });
    const effectiveTheme = await finishEnvironment();
    return {
      ...record, fixture: { id: fixture.id, sha256: digest(fixture.content) }, effectiveTheme,
      readiness: { status: 'ready', sourceSha256: digest(fixture.content), witness, preliminaryFrames,
        sourceCoveredLines: normalized.coveredLines, repeatedSourceFrame: repeated.frame,
        fixedTheme: { theme, modeLock: variant, providerMountGates: 'KV.ready and Theme.ready', input: 'page-navigation and resize only' } },
      pages, tabSize: normalized.tabSize, tabMode: normalized.tabMode,
      sourceMap: { maps, bodyColumn, tabSize: normalized.tabSize, tabMode: normalized.tabMode },
      viewportSequence: pty.events.filter(event => event.input || event.resize),
    };
  } finally {
    try { await pty?.stop(); } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
}
