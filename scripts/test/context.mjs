import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function readInputs(path = process.env.TIDY_TEST_INPUTS) {
  if (!path || !isAbsolute(path)) throw new Error('Use prepared test inputs: run test:prepare, then supply --inputs /absolute/path/inputs.json');
  const inputs = JSON.parse(readFileSync(path, 'utf8'));
  if (inputs.schema !== 1 || !inputs.node || !inputs.source || !inputs.tools || !inputs.pi) throw new Error('Invalid prepared test inputs');
  for (const value of [inputs.node.path, inputs.source.root, inputs.tools.bin, inputs.pi.root, inputs.pi.cli]) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Prepared test input paths must be absolute');
  }
  return { ...inputs, inputsPath: path };
}

export function toolPath(name, inputs = readInputs()) {
  const path = inputs.tools[name];
  if (!path || !isAbsolute(path) || !statSync(path).isFile()) throw new Error(`Missing declared test tool: ${name}`);
  return path;
}

export function childEnv(root, extra = {}, inputs = readInputs()) {
  if (!isAbsolute(root)) throw new Error('Test environment root must be absolute');
  const home = join(root, 'home'), config = join(root, 'config'), agent = join(root, 'agent');
  for (const directory of [root, home, config, agent, 'tmp', 'cache', 'data', 'state', 'run', 'empty'].map(value => isAbsolute(value) ? value : join(root, value))) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const npmUser = join(root, 'user.npmrc'), npmGlobal = join(root, 'global.npmrc'), gitConfig = join(root, 'gitconfig');
  for (const path of [npmUser, npmGlobal, gitConfig]) if (!existsSync(path)) writeFileSync(path, '');
  const env = {
    PATH: inputs.tools.path ?? inputs.tools.bin, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'),
    APPDATA: config, LOCALAPPDATA: join(root, 'data'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TEMPLATE_DIR: join(root, 'empty'), GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(root, 'empty'),
    npm_config_userconfig: npmUser, npm_config_globalconfig: npmGlobal,
    npm_config_cache: join(root, 'cache', 'npm'), npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_offline: 'true', npm_config_engine_strict: 'true', npm_execpath: inputs.tools.npm,
    UV_THREADPOOL_SIZE: '4', TIDY_TEST_ROOT: join(root, 'tmp'),
  };
  if (inputs.systemRoot) {
    env.SystemRoot = inputs.systemRoot;
    env.WINDIR = inputs.systemRoot;
    env.ComSpec = join(inputs.systemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.TIDY_TEST_SYSTEMROOT = inputs.systemRoot;
  }
  if (inputs.tools.bash) env.SHELL = inputs.tools.bash;
  if (inputs.tools.getconf) env.TIDY_TEST_GETCONF = inputs.tools.getconf;
  if (inputs.inputsPath) env.TIDY_TEST_INPUTS = inputs.inputsPath;
  return Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
}

export function validateNative(inputs) {
  const artifact = inputs.native;
  if (!artifact) throw new Error('Missing required same-source Occipital build; prepare native inputs first');
  if (artifact.commit !== inputs.source.commit) throw new Error('Occipital source commit differs from tested commit');
  if (artifact.nativeTree !== inputs.source.nativeTree) throw new Error('Occipital source tree differs from tested source tree');
  const bytes = readFileSync(artifact.path);
  if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new Error('Occipital bytes/hash differ from prepared artifact');
  return artifact;
}

export function validateHost(inputs, runtime = true) {
  if (!inputs.pi.lock || !inputs.pi.lockSha256 || digest(readFileSync(inputs.pi.lock)) !== inputs.pi.lockSha256) throw new Error('Prepared selected-host lock identity changed or is missing; refresh test:prepare');
  if (runtime && (realpathSync(process.execPath) !== realpathSync(inputs.node.path) || process.version !== inputs.node.version)) throw new Error('Test Node runtime differs from prepared runtime');
  const coding = JSON.parse(readFileSync(join(inputs.pi.root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  if (coding.version !== inputs.pi.version) throw new Error('Prepared Pi CLI/SDK version mismatch');
  const cli = typeof coding.bin === 'string' ? coding.bin : coding.bin.pi;
  if (realpathSync(inputs.pi.cli) !== realpathSync(join(inputs.pi.root, 'node_modules/@earendil-works/pi-coding-agent', cli))) throw new Error('Prepared CLI is outside the selected Pi host graph');
  for (const entry of inputs.pi.packages) {
    if (!realpathSync(entry.path).startsWith(realpathSync(inputs.pi.root) + sep)) throw new Error('Prepared SDK points outside the selected host tree');
    const manifest = JSON.parse(readFileSync(entry.path, 'utf8'));
    if (manifest.name !== entry.name || manifest.version !== entry.version || digest(readFileSync(entry.path)) !== entry.sha256) throw new Error('Prepared Pi host graph changed');
  }
}

export function validateRequirements(inputs, requirements) {
  const env = {};
  for (const requirement of requirements) {
    if (requirement === 'native') env.OCCIPITAL_TEST_BIN = validateNative(inputs).path;
    else if (requirement === 'shared') {
      const host = inputs.sharedHost;
      if (!host || !isAbsolute(host.path)) throw new Error('Selected shared tests require the prepared --shared-host input');
      if (digest(readFileSync(host.path)) !== host.sha256) throw new Error('Prepared shared host changed');
      env.OCCIPITAL_TEST_SHARED_HOST = host.path;
    } else if (requirement === 'integration') {
      const profile = inputs.integration;
      if (!profile || !isAbsolute(profile.root) || !isAbsolute(profile.manifest)) throw new Error('Selected profile tests require the prepared locked integration profile');
      if (digest(readFileSync(join(profile.root, 'package-lock.json'))) !== profile.lockSha256) throw new Error('Prepared integration lock changed');
    } else if (requirement === 'registry') {
      if (!inputs.registry) throw new Error('Selected consumer tests require prepared registry archives');
    } else if (requirement === 'rust') {
      if (!inputs.rust) throw new Error('Selected Rust tests require the prepared pinned Rust toolchain');
    } else throw new Error('Unknown test requirement: ' + requirement);
  }
  return env;
}
