import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, readlinkSync, lstatSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { childEnv, digest, readInputs, rustLoaderEnvironment, validateHost, validateNative } from './context.mjs';

const project = resolve(import.meta.dirname, '../..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function systemTools(node, supplied = {}) {
  const dirs = process.platform === 'win32' ? [dirname(node), 'C:\\Windows\\System32', 'C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\usr\\bin'] : ['/usr/bin', '/bin', '/usr/local/bin'];
  const tools = {};
  for (const name of ['git', 'bash', 'python3', 'make', 'tar', 'gzip', 'getconf', 'dirname', 'id', 'bwrap', 'cc', 'ar', 'as', 'ld', 'ranlib', 'strip', 'xcrun', 'dsymutil', 'ps', 'objcopy', 'objdump', 'readelf', 'sh', 'cp', 'chmod', 'uname', 'mkdir', 'rm', 'printf', 'sleep', 'cat', 'head', 'wc', 'touch', 'true', 'false', 'env', 'ls', 'sed', 'grep', 'find', 'date', 'timeout', 'taskkill', 'tee', 'seq', 'tr', 'sort', 'cut', 'stty', 'tput', 'dd', 'du', 'rmdir', 'readlink']) {
    const path = supplied[name] ?? dirs.map(directory => join(directory, name + (process.platform === 'win32' ? '.exe' : ''))).find(existsSync);
    if (path) tools[name] = realpathSync(path);
  }
  const npm = supplied.npm ?? [join(dirname(realpathSync(node)), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(node), 'node_modules/npm/bin/npm-cli.js')].map(value => resolve(value)).find(existsSync);
  if (!npm) throw new Error('Supply the absolute npm CLI JavaScript entry in --tools JSON');
  tools.npm = realpathSync(npm);
  for (const [name, path] of Object.entries(supplied)) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`Invalid declared tool: ${name}`);
    tools[name] = realpathSync(path);
  }
  if (!tools.git || !tools.tar) throw new Error('Declared git and tar executables are required');
  return tools;
}

export function materializeTools(root, node, tools) {
  const bin = join(root, 'bin'); rmSync(bin, { recursive: true, force: true }); mkdirSync(bin, { recursive: true });
  for (const [name, path] of Object.entries({ ...tools, node })) {
    if (name === 'bin' || name === 'npm') continue;
    const destination = join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
    rmSync(destination, { force: true });
    // Windows Git/MSYS executables require their original installation tree and DLLs.
    if (process.platform === 'win32') { if (name === 'node') cpSync(path, destination); }
    else symlinkSync(path, destination);
  }
  const npmWrapper = process.platform === 'win32' ? `@echo off\r\n"${node}" "${tools.npm}" %*\r\n` : `#!/bin/sh\nexec ${quote(node)} ${quote(tools.npm)} "$@"\n`;
  writeFileSync(join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), npmWrapper, { mode: 0o755 });
  const path = process.platform === 'win32' ? [bin, ...new Set(Object.entries(tools).filter(([name]) => name !== 'npm').map(([, path]) => dirname(path)))].join(delimiter) : bin;
  return { ...tools, bin, path };
}

export function sourceIdentity(root, tools, env) {
  const commit = execFileSync(tools.git, ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const files = [...new Set(execFileSync(tools.git, ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env }).toString().split('\0').filter(Boolean))]
    .filter(name => existsSync(join(root, name)) && statSync(join(root, name)).isFile()).sort();
  return { root, commit, ...snapshotIdentity(root, files), files };
}

export function snapshotIdentity(root, files) {
  const tree = createHash('sha256'), native = createHash('sha256');
  for (const name of files) {
    const path = join(root, name);
    const bytes = readFileSync(path);
    tree.update(name + '\0').update(bytes).update('\0');
    if (/^(?:crates\/|Cargo\.(?:toml|lock)$|rust-toolchain\.toml$|\.cargo\/)/.test(name)) native.update(name + '\0').update(bytes).update('\0');
  }
  return { tree: tree.digest('hex'), nativeTree: native.digest('hex') };
}

export function materializeSource(root, destination, files) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of files) {
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    cpSync(join(root, name), join(destination, name), { dereference: true });
  }
  return snapshotIdentity(destination, files);
}

function run(inputs, root, command, args, extra = {}) {
  return execFileSync(command, args, { cwd: root, env: childEnv(join(inputs.preparation, 'environment'), extra, inputs), stdio: 'inherit' });
}

export async function archiveGraph(inputs, dependencies, offline = false, work = {}) {
  Object.assign(work, {archiveCacheHits:0, archiveCacheMisses:0, archiveRequests:0, archiveBytes:0,
    archiveTarCommands:0, archiveCacheMs:0, archiveFetchMs:0, archiveTarMs:0});
  const cache = join(inputs.preparation, 'environment/cache/npm/_cacache');
  let cacache;
  const lock = json(join(dependencies, 'package-lock.json')), directory = join(inputs.preparation, 'archives');
  mkdirSync(directory, { recursive: true });
  const records = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || !entry.resolved || !entry.integrity) continue;
    if (!entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error('Prepared npm lock contains an undeclared registry');
    const identity = entry.resolved + '\0' + entry.integrity;
    if (records.has(identity)) continue;
    const path = join(directory, digest(Buffer.from(identity)) + '.tgz');
    let cached = false;
    if (!existsSync(path)) {
      cacache ??= createRequire(inputs.tools.npm)('cacache');
      const started = performance.now();
      let bytes;
      try {
        bytes = await cacache.get.byDigest(cache, entry.integrity);
        work.archiveCacheHits++; cached = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        work.archiveCacheMisses++;
        if (offline) throw error;
      } finally { work.archiveCacheMs += performance.now() - started; }
      if (!cached) {
        const started = performance.now();
        work.archiveRequests++;
        try {
          const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`Prepared package acquisition failed: HTTP ${response.status}`);
          bytes = Buffer.from(await response.arrayBuffer());
        } finally { work.archiveFetchMs += performance.now() - started; }
      }
      writeFileSync(path, bytes);
    }
    const bytes = readFileSync(path), [algorithm, expected] = entry.integrity.split('-');
    if (!['sha512', 'sha256', 'sha1'].includes(algorithm) || createHash(algorithm).update(bytes).digest('base64') !== expected) throw new Error('Prepared npm archive integrity mismatch');
    work.archiveBytes += bytes.length;
    const options = { env: childEnv(join(inputs.preparation, 'environment'), {}, inputs), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const started = performance.now();
    let manifest;
    try {
      work.archiveTarCommands++;
      const members = execFileSync(inputs.tools.tar, ['-tzf', path], options).toString().split(/\r?\n/);
      const manifestPath = members.find(name => /^(?:\.\/)?[^/]+\/package\.json$/.test(name));
      if (!manifestPath) throw new Error('Prepared npm archive lacks a root package.json');
      work.archiveTarCommands++;
      manifest = JSON.parse(execFileSync(inputs.tools.tar, ['-xOzf', path, manifestPath], options).toString());
    } finally { work.archiveTarMs += performance.now() - started; }
    if (!offline && !cached) {
      cacache ??= createRequire(inputs.tools.npm)('cacache');
      await cacache.put(cache, 'tidy-prepared:' + identity, bytes, { algorithms: [algorithm] });
    }
    records.set(identity, { name: manifest.name, version: manifest.version, path, integrity: entry.integrity, manifest });
  }
  return { packages: [...records.values()], lock: join(dependencies, 'package-lock.json'), lockSha256: digest(readFileSync(join(dependencies, 'package-lock.json'))) };
}

export function validateNeutralRunRoot(root) {
  for (let cursor = realpathSync(root);;) {
    if (['.cargo/config.toml', '.cargo/config', '.git'].some(name => existsSync(join(cursor, name)))) {
      throw new Error('Test runtime root must have neutral ancestry: ancestor Cargo configuration or Git repository detected');
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export function materializeDependencies(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}

export function dependencyIdentity(root) {
  const hash = createHash('sha256'), boundary = realpathSync(root) + (process.platform === 'win32' ? '\\' : '/');
  const visit = (directory, relative = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), key = relative + name, info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (!realpathSync(path).startsWith(boundary)) throw new Error('Dependency link escapes its owned host graph');
        hash.update('link\0' + key + '\0' + readlinkSync(path) + '\0');
      }
      else if (info.isDirectory()) { hash.update('dir\0' + key + '\0'); visit(path, key + '/'); }
      else if (info.isFile()) hash.update('file\0' + key + '\0' + (info.mode & 0o111) + '\0').update(readFileSync(path)).update('\0');
      else throw new Error('Unexpected dependency input type');
    }
  };
  visit(root); return hash.digest('hex');
}

export function refreshInputs(inputPath) {
  const started = performance.now(), inputs = readInputs(inputPath), seal = inputs.install;
  process.umask(0o077);
  if (!seal) throw new Error('Source refresh requires a sealed owned host graph; prepare this profile once');
  validateHost(inputs, false);
  validateNeutralRunRoot(inputs.runRoot);
  const root = inputs.source.root, tree = realpathSync(inputs.pi.root);
  if (tree !== join(realpathSync(inputs.runRoot), 'project') || tree === realpathSync(root)) throw new Error('Source refresh requires its neutral owned runtime snapshot');
  if (seal.platform !== process.platform || seal.arch !== process.arch || seal.manifest !== digest(readFileSync(join(root, 'package.json'))) || seal.lock !== digest(readFileSync(join(root, 'package-lock.json')))) throw new Error('Source refresh host/dependency inputs changed; run test:prepare');
  if (dependencyIdentity(join(tree, 'node_modules')) !== seal.modules) throw new Error('Owned host dependency bytes changed; run test:prepare');
  const environment = childEnv(join(inputs.preparation, 'refresh-environment'), {}, inputs);
  if (execFileSync(inputs.node.path, ['--version'], { env: environment, encoding: 'utf8' }).trim() !== inputs.node.version) throw new Error('Source refresh Node runtime changed');
  const source = sourceIdentity(root, inputs.tools, environment), previous = json(join(inputs.runRoot, 'source-files.json'));
  for (const name of previous) if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/\\\\]/).includes('..') || /^(?:node_modules)(?:[\\/\\\\]|$)/.test(name)) throw new Error('Invalid owned source inventory');
  let copies = 0;
  if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree ||
      previous.length !== source.files.length || previous.some((name, index) => source.files[index] !== name)) {
    // Retain attempted additions too: a failed copy must not hide them from the next cleanup.
    save(join(inputs.runRoot, 'source-files.json'), [...new Set([...previous, ...source.files])]);
    for (const name of previous) {
      rmSync(join(tree, name), { force: true });
      for (let directory = dirname(join(tree, name)); directory !== tree; directory = dirname(directory)) {
        try { rmdirSync(directory); } catch (error) { if (error.code === 'ENOENT') continue; if (error.code === 'ENOTEMPTY') break; throw error; }
      }
    }
    for (const name of source.files) { mkdirSync(dirname(join(tree, name)), { recursive: true }); cpSync(join(root, name), join(tree, name), { dereference: true }); copies++; }
  }
  if (snapshotIdentity(tree, source.files).tree !== source.tree) throw new Error('Refreshed source snapshot differs from tested source');
  const { files, ...identity } = source;
  inputs.source = identity;
  inputs.preparationStats = { kind: 'refresh', elapsedMs: performance.now() - started, dependencyInstalls: 0, dependencyCopies: 0, sourceCopies: copies };
  save(join(inputs.runRoot, 'source-files.json'), files);
  save(inputPath, inputs);
  return inputs;
}

export async function prepare(options) {
  if (options['refresh-inputs']) return refreshInputs(resolve(options['refresh-inputs']));
  const started = performance.now();
  process.umask(0o077);
  const root = resolve(options.root ?? project), output = resolve(options.output ?? join(root, '.test-artifacts/harness', options['pi-version'] ?? '1.0.0'));
  const version = options['pi-version'] ?? json(join(root, 'package.json')).devDependencies['@earendil-works/pi-coding-agent'];
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version)) throw new Error('Supply one exact Pi version, not a tag/range');
  const node = realpathSync(options.node ?? process.execPath), tools = systemTools(node, options.tools ? json(resolve(options.tools)) : {});
  mkdirSync(output, { recursive: true });
  const inputs = { schema: 1, preparation: output, node: { path: node, version: '' }, tools: materializeTools(output, node, tools) };
  const phases = {}, archiveWork = {};
  let phaseStarted = started;
  const checkpoint = name => {
    phases[name] = performance.now() - phaseStarted;
    if (options.archives) save(join(output, 'consumer/diagnostics/installed-preparation-runtime/fixture.json'), {
      phases, elapsedMs: performance.now() - started, offline: options.offline === true,
      archiveRecords: inputs.registry?.packages.length ?? 0, ...archiveWork,
    });
    phaseStarted = performance.now();
  };
  if (process.platform === 'win32') inputs.systemRoot = options['system-root'] ?? 'C:\\Windows';
  const environment = childEnv(join(output, 'environment'), {}, inputs);
  if (options['npm-cache']) {
    const source = resolve(options['npm-cache'], '_cacache'), destination = join(output, 'environment/cache/npm/_cacache');
    if (source !== destination) cpSync(source, destination, { recursive: true });
  }
  const runParent = options['run-root'] ? resolve(options['run-root']) : process.platform === 'win32' ? join(inputs.systemRoot, 'Temp') : '/tmp';
  mkdirSync(runParent, { recursive: true, mode: 0o700 });
  validateNeutralRunRoot(runParent);
  inputs.node.version = execFileSync(node, ['--version'], { env: environment, encoding: 'utf8' }).trim();
  const source = sourceIdentity(root, tools, environment);
  inputs.runRoot = mkdtempSync(join(realpathSync(runParent), 'tt-'));
  try {
    if (realpathSync(inputs.runRoot) === realpathSync(root) || realpathSync(inputs.runRoot).startsWith(realpathSync(root) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Test runtime root must be outside the tested checkout');
    const tree = join(inputs.runRoot, 'project');
    const materialized = materializeSource(root, tree, source.files);
    if (materialized.tree !== source.tree) throw new Error('Materialized source snapshot differs from the tested source');
    save(join(inputs.runRoot, 'source-files.json'), source.files);
    const { files, ...identity } = source; inputs.source = identity;
    checkpoint('sourceAndSetup');
    const deps = join(output, 'dependencies'); mkdirSync(deps, { recursive: true });
    const manifest = json(join(root, 'package.json'));
    const baseline = manifest.devDependencies['@earendil-works/pi-coding-agent'];
    if (version === baseline) {
      cpSync(join(root, 'package.json'), join(deps, 'package.json')); cpSync(join(root, 'package-lock.json'), join(deps, 'package-lock.json'));
    } else if (options.offline) {
      if (!existsSync(join(deps, 'package.json')) || !existsSync(join(deps, 'package-lock.json'))) throw new Error('Offline preparation requires a previously resolved selected-host manifest and lock; prepare this exact version online first');
      const selected = json(join(deps, 'package.json'));
      if (selected.dependencies?.['@earendil-works/pi-coding-agent'] !== version || !selected.dependencies?.['@earendil-works/pi-tui']) throw new Error('Offline preparation requires the previously resolved exact selected-host manifest and lock');
    } else {
      const response = await fetch(`https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/${version}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Selected Pi release unavailable: HTTP ${response.status}`);
      const selected = await response.json();
      if (selected.version !== version || !selected.dependencies?.['@earendil-works/pi-tui']) throw new Error('Selected Pi release lacks coherent TUI dependency metadata');
      const dependencies = { ...manifest.devDependencies, ...manifest.optionalDependencies,
        '@earendil-works/pi-coding-agent': version, '@earendil-works/pi-tui': selected.dependencies['@earendil-works/pi-tui'] };
      const selectedManifest = { name: 'tidy-test-host', version: '0.0.0', private: true, type: 'module', dependencies };
      const old = existsSync(join(deps, 'package.json')) ? readFileSync(join(deps, 'package.json'), 'utf8') : '';
      const text = JSON.stringify(selectedManifest, null, 2) + '\n';
      if (old !== text) rmSync(join(deps, 'package-lock.json'), { force: true });
      writeFileSync(join(deps, 'package.json'), text);
    }
    run(inputs, deps, node, [tools.npm, existsSync(join(deps, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { npm_config_offline: options.offline ? 'true' : 'false' });
    checkpoint('hostInstall');
    materializeDependencies(join(deps, 'node_modules'), join(tree, 'node_modules'));
    checkpoint('dependencyCopy');
    const codingRoot = join(tree, 'node_modules/@earendil-works/pi-coding-agent');
    const coding = json(join(codingRoot, 'package.json'));
    const cli = typeof coding.bin === 'string' ? coding.bin : coding.bin.pi;
    const packages = ['pi-coding-agent', 'pi-tui', 'pi-ai', 'pi-agent-core'].map(name => {
      const path = join(tree, 'node_modules/@earendil-works', name, 'package.json');
      const entry = json(path); return { name: entry.name, version: entry.version, path, sha256: digest(readFileSync(path)) };
    });
    inputs.pi = { root: tree, version, cli: join(codingRoot, cli), packages, lock: join(deps, 'package-lock.json'), lockSha256: digest(readFileSync(join(deps, 'package-lock.json'))) };
    if (options['registry-inputs'] && !options.archives) throw new Error('--registry-inputs requires --archives');
    if (options.archives) {
      const previous = options['registry-inputs'] ? json(resolve(options['registry-inputs'])).registry
        : options.offline && existsSync(join(output, 'registry.json')) ? json(join(output, 'registry.json')) : undefined;
      inputs.registry = previous ?? await archiveGraph(inputs, deps, options.offline, archiveWork);
    }
    checkpoint('archiveInputs');
    if (options.integration) {
      const directory = join(output, 'integration'); mkdirSync(directory, { recursive: true });
      for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, 'tests/fixtures/integration-profile', name), join(directory, name));
      run(inputs, directory, node, [tools.npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { npm_config_offline: options.offline ? 'true' : 'false' });
      inputs.integration = { root: directory, manifest: join(directory, 'package.json'),
        lockSha256: digest(readFileSync(join(directory, 'package-lock.json'))) };
    }
    checkpoint('integrationInputs');
    if (options['native-artifact']) {
      const directory = resolve(options['native-artifact']);
      const info = json(join(directory, 'build-info.json')), release = json(join(directory, 'native-release.staged.json'));
      if (info.commit !== source.commit || info.version !== release.version) throw new Error('Native CI artifact source commit/version mismatch');
      const dirty = execFileSync(tools.git, ['-C', root, 'status', '--porcelain', '--', 'crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo'], { env: environment, encoding: 'utf8' });
      if (dirty.trim()) throw new Error('A commit-only CI artifact cannot attest modified local native sources; use --build-native');
      const record = release.artifacts.find(entry => entry.target === info.target);
      if (!record) throw new Error('Native CI artifact lacks its target declaration');
      const path = join(directory, 'packages', info.target, process.platform === 'win32' ? 'occipital.exe' : 'occipital');
      inputs.native = { path, bytes: record.maxBytes, sha256: record.sha256, version: info.version, target: info.target, commit: info.commit, nativeTree: source.nativeTree };
      validateNative(inputs);
      if (execFileSync(path, ['--version'], { env: environment, encoding: 'utf8' }).trim() !== `occipital ${info.version}`) throw new Error('CI helper executable version mismatch');
    }
    if (options['native-inputs']) {
      const previous = json(resolve(options['native-inputs']));
      inputs.native = previous.native; validateNative(inputs);
      if (previous.rust) inputs.rust = previous.rust;
    }
    if (options['shared-host']) {
      const path = realpathSync(resolve(options['shared-host'])); inputs.sharedHost = { path, sha256: digest(readFileSync(path)) };
    }
    if (options['rust-root']) {
      const rustRoot = realpathSync(resolve(options['rust-root']));
      const suffix = process.platform === 'win32' ? '.exe' : '';
      inputs.rust = { root: rustRoot, cargo: join(rustRoot, 'bin/cargo' + suffix), rustc: join(rustRoot, 'bin/rustc' + suffix), home: join(output, 'cargo-home'), target: join(output, 'cargo-target') };
      if (options['cargo-cache']) for (const name of ['registry', 'git']) {
        const source = resolve(options['cargo-cache'], name), destination = join(inputs.rust.home, name);
        if (source !== destination && existsSync(source)) cpSync(source, destination, { recursive: true });
      }
      if (options['rust-environment']) {
        const environment = json(resolve(options['rust-environment']));
        if (process.platform !== 'win32' || Object.keys(environment).some(key => !['PATH', 'INCLUDE', 'LIB', 'LIBPATH'].includes(key)) || Object.values(environment).some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Only explicit Windows build PATH/INCLUDE/LIB/LIBPATH are allowed');
        inputs.rust.environment = environment;
      }
      const expected = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1];
      for (const tool of [inputs.rust.cargo, inputs.rust.rustc]) {
        if (!execFileSync(tool, ['--version'], { env: { ...environment, ...rustLoaderEnvironment(rustRoot) }, encoding: 'utf8' }).includes(` ${expected} `)) throw new Error('Prepared Rust toolchain version mismatch');
      }
    }
    if (options['build-native']) {
      if (!inputs.rust) throw new Error('--build-native requires explicit --rust-root with the pinned toolchain');
      const nativeSource = join(inputs.runRoot, 'native-source');
      const nativeFiles = source.files.filter(name => /^(?:crates\/|Cargo\.(?:toml|lock)$|rust-toolchain\.toml$|\.cargo\/)/.test(name));
      if (materializeSource(root, nativeSource, nativeFiles).nativeTree !== source.nativeTree) throw new Error('Materialized native source differs from tested native source');
      const versionModule = new URL('../release/version.mjs', import.meta.url).href;
      const daemon = JSON.parse(execFileSync(node, ['--input-type=module', '-e',
        `import {nearestDaemonTag} from ${JSON.stringify(versionModule)}; console.log(JSON.stringify(await nearestDaemonTag(${JSON.stringify(root)})));`],
        { env: environment, encoding: 'utf8' }));
      const { stampDaemonVersion } = await import('../release/version.mjs');
      await stampDaemonVersion(nativeSource, daemon.version);
      const rustEnv = { ...inputs.rust.environment, ...rustLoaderEnvironment(inputs.rust.root), CARGO_HOME: inputs.rust.home, CARGO_TARGET_DIR: inputs.rust.target, RUSTC: inputs.rust.rustc, RUSTUP_AUTO_INSTALL: '0' };
      run(inputs, nativeSource, inputs.rust.cargo, ['fetch', '--locked', ...(options.offline ? ['--offline'] : [])], rustEnv);
      run(inputs, nativeSource, inputs.rust.cargo, ['build', '--release', '--locked', '--offline', '-p', 'occipital'], rustEnv);
      const path = join(inputs.rust.target, 'release', process.platform === 'win32' ? 'occipital.exe' : 'occipital');
      const bytes = readFileSync(path);
      const observed = execFileSync(path, ['--version'], { env: environment, encoding: 'utf8' }).trim();
      if (observed !== `occipital ${daemon.version}`) throw new Error('Built helper version mismatch');
      const { candidateTargets } = await import('../release/native-release.mjs');
      const target = Object.keys(candidateTargets).find(key => candidateTargets[key].os === process.platform && candidateTargets[key].cpu === process.arch);
      inputs.native = { path, bytes: bytes.length, sha256: digest(bytes), version: daemon.version, target, commit: source.commit, nativeTree: source.nativeTree };
    }
    checkpoint('nativeAndRustInputs');
    if (options.archives) {
      if (inputs.native) {
        const { prepareConsumerClosure } = await import('../../tests/fixtures/consumer-preparation.mjs');
        inputs.registry = await prepareConsumerClosure(inputs, { offline: options.offline });
      }
      save(join(output, 'registry.json'), inputs.registry);
    }
    checkpoint('consumerAcquisition');
    inputs.install = { manifest: digest(readFileSync(join(root, 'package.json'))), lock: digest(readFileSync(join(root, 'package-lock.json'))),
      platform: process.platform, arch: process.arch, modules: dependencyIdentity(join(tree, 'node_modules')) };
    checkpoint('dependencySeal');
    inputs.preparationStats = { kind: 'prepare', elapsedMs: performance.now() - started, dependencyInstalls: 1, dependencyCopies: 1, sourceCopies: source.files.length, phases };
    const path = join(output, 'inputs.json'); save(path, inputs);
    console.log(path);
    return { ...inputs, inputsPath: path };
  } catch (error) {
    rmSync(inputs.runRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'refresh-inputs': { type: 'string' }, root: { type: 'string' }, 'run-root': { type: 'string' }, output: { type: 'string' }, 'pi-version': { type: 'string' }, node: { type: 'string' }, tools: { type: 'string' },
    'system-root': { type: 'string' }, offline: { type: 'boolean' }, 'npm-cache': { type: 'string' }, 'registry-inputs': { type: 'string' }, 'cargo-cache': { type: 'string' }, 'rust-environment': { type: 'string' }, archives: { type: 'boolean' }, integration: { type: 'boolean' }, 'native-inputs': { type: 'string' }, 'native-artifact': { type: 'string' }, 'build-native': { type: 'boolean' }, 'rust-root': { type: 'string' }, 'shared-host': { type: 'string' },
  } });
  await prepare(values);
}
