import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInputs, childEnv } from '../../scripts/test/context.mjs';
import { candidateTargets, executableDigest } from '../../scripts/release/native-release.mjs';
import { rewriteConsumerLock } from './consumer-preparation.mjs';
import { startLocalRegistry } from './local-registry.mjs';
import { runNpmPreparation, summarizeTemporaryDrive } from './npm-preparation.ts';

const inputs = readInputs(), repo = inputs.source.root, native = inputs.native;
assert.equal(process.version, inputs.node.version);
assert.equal(await realpath(process.execPath), await realpath(inputs.node.path), 'Selected Node executable must match');
assert.ok(native && inputs.registry?.packages?.length, 'Installed consumer requires same-source native and prepared registry archives');
assert.match(inputs.source.commit, /^[a-f0-9]{40}$/, 'Tested source commit is required');
assert.match(inputs.source.nativeTree, /^[a-f0-9]{64}$/, 'Tested native tree identity is required');
assert.equal(native.commit, inputs.source.commit, 'Native commit must match tested source');
assert.equal(native.nativeTree, inputs.source.nativeTree, 'Native tree must match tested source');
assert.ok(native.version !== '0.0.0', 'Consumer requires a version-stamped same-source helper; prepare it before execution');
const glibc = process.platform !== 'linux' || typeof process.report.getReport().header.glibcVersionRuntime === 'string';
const target = Object.keys(candidateTargets).find(key => candidateTargets[key].os === process.platform && candidateTargets[key].cpu === process.arch && glibc);
assert.ok(target, 'Supported native platform required');
assert.equal(native.target, target, 'Native target must match this runtime');
assert.deepEqual(await executableDigest(native.path), { sha256: native.sha256, maxBytes: native.bytes });
const configuredThreads = Number(process.env.UV_THREADPOOL_SIZE);
const configuredThreadpoolSize = Number.isSafeInteger(configuredThreads) && configuredThreads > 0 ? configuredThreads : null;
const started = performance.now(), temporary = await mkdtemp(join(tmpdir(), 'occipital-installed-'));
const originalEnv = { ...process.env }, originalFetch = globalThis.fetch, originalSpawn = childProcess.spawn;
let npmMs = 0, npmCommands = 0, completed = false, fixtureError, client, wake, registry;
function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
const npm = async (args, registryURL = 'http://127.0.0.1:9', cwd = temporary) => {
  const before = performance.now(), configRoot = join(temporary, `npm-${npmCommands++}`);
  await mkdir(configRoot);
  const userconfig = join(configRoot, 'user.npmrc'), globalconfig = join(configRoot, 'global.npmrc');
  await writeFile(userconfig, ''); await writeFile(globalconfig, '');
  const env = childEnv(configRoot, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: join(configRoot, 'cache'), npm_config_registry: registryURL, npm_config_offline: 'false' }, inputs);
  const scopes = new Set(['@kchpock', ...inputs.registry.packages.filter(item => item.name.startsWith('@')).map(item => item.name.split('/')[0])]);
  try {
    return await runNpmPreparation([...args, `--registry=${registryURL}`, ...[...scopes].map(scope => `--${scope}:registry=${registryURL}`)], {
      cwd, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath: inputs.tools.npm, env,
      logsRoot: join(temporary, 'npm-logs'), reportsRoot: join(repo, '.test-artifacts') });
  } finally { npmMs += performance.now() - before; }
};
async function readHashed(path, sha256) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Prepared consumer file path must be absolute');
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'Prepared consumer file hash mismatch');
  return bytes;
}
try {
  assert.equal(childProcess.execFileSync(native.path, ['--version'], { encoding: 'utf8', timeout: 5000, env: childEnv(temporary, {}, inputs) }).trim(), `occipital ${native.version}`);
  // Keep the existing temp-alias/path-canonicalization control.
  const alias = join(temporary, 'alias');
  await symlink(await realpath(temporary), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const root = await realpath(await mkdtemp(join(alias, 'consumer-')));
  const preparedConsumer = inputs.registry.consumer;
  assert.ok(preparedConsumer, 'Prepare the complete consumer closure before execution');
  assert.deepEqual(preparedConsumer.source, { commit: inputs.source.commit, tree: inputs.source.tree,
    nativeTree: inputs.source.nativeTree, nativeSha256: native.sha256 }, 'Consumer archives must match tested sources');
  assert.equal(preparedConsumer.nodeVersion, inputs.node.version);
  assert.equal(childProcess.execFileSync(inputs.node.path, [inputs.tools.npm, '--version'], { encoding: 'utf8', env: childEnv(temporary, {}, inputs) }).trim(), preparedConsumer.npmVersion);
  const NATIVE_RELEASE = preparedConsumer.nativeRelease, artifact = NATIVE_RELEASE.artifacts.find(item => item.target === target);
  assert.equal(NATIVE_RELEASE.version, native.version);
  assert.equal(artifact.sha256, native.sha256); assert.equal(artifact.maxBytes, native.bytes);
  assert.equal(artifact.url, `https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v${native.version}/occipital-v${native.version}-${target}${process.platform === 'win32' ? '.exe' : ''}`);
  const executable = candidateTargets[target].executable, nativeName = `@kchpock/occipital-${target}`, prepared = inputs.registry.packages;
  registry = await startLocalRegistry({ packages: prepared, documents: inputs.registry.documents,
    downloads: [{ sourceURL: artifact.url, path: native.path, sha256: native.sha256 }] });
  const peers = Object.fromEntries(inputs.pi.packages.map(record => [record.name, record.version]));
  assert.equal(peers['@earendil-works/pi-coding-agent'], inputs.pi.version);
  assert.ok(peers['@earendil-works/pi-tui'], 'Selected Pi TUI is required');
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'with-native' : 'without-native'), home = join(consumer, 'home');
    await mkdir(consumer); await mkdir(home);
    const receipt = preparedConsumer.locks.find(item => item.installed === installed);
    assert.ok(receipt, 'Both consumer optionality locks must be prepared');
    const preparedLock = JSON.parse((await readHashed(receipt.path, receipt.sha256)).toString('utf8'));
    const expectedLock = rewriteConsumerLock(preparedLock, receipt.registryURL, registry.url);
    await writeFile(join(consumer, 'package.json'), await readHashed(receipt.manifestPath, receipt.manifestSha256));
    await writeFile(join(consumer, 'package-lock.json'), JSON.stringify(expectedLock));
    await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional'])], registry.url, consumer);
    registry.assertNoRejectedRequests();
    const lockBytes = await readFile(join(consumer, 'package-lock.json'));
    const consumerLockSha256 = createHash('sha256').update(lockBytes).digest('hex'), lock = JSON.parse(lockBytes.toString('utf8'));
    assert.deepEqual(lock, expectedLock, 'npm ci must preserve the exact prepared consumer graph');
    for (const [location, pkg] of Object.entries(lock.packages)) {
      if (!location) continue;
      const name = pkg.name ?? location.split('node_modules/').at(-1);
      const record = prepared.find(item => item.name === name && item.version === pkg.version);
      assert.ok(record, 'Installed graph contains an unprepared package identity');
      assert.equal(pkg.integrity, record.integrity, 'Installed graph must use the exact prepared archive');
      assert.equal(new URL(pkg.resolved).origin, registry.url, 'Package resolution must stay fixture-local');
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, childEnv(consumer, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'local'),
      PI_CODING_AGENT_DIR: join(home, 'agent'), SUBC_CONNECTION_FILE: join(home, 'missing-service.json'), PATH: '' }, inputs));
    const entry = join(consumer, 'node_modules/pi-tidy-ui/src'), require = createRequire(join(consumer, 'package.json'));
    for (const record of inputs.pi.packages) {
      const manifest = JSON.parse(await readFile(join(consumer, 'node_modules', record.name, 'package.json'), 'utf8'));
      assert.equal(manifest.name, record.name); assert.equal(manifest.version, record.version);
    }
    if (installed) assert.equal(require(`${nativeName}/package.json`).version, native.version);
    else assert.throws(() => require.resolve(`${nativeName}/package.json`), { code: 'MODULE_NOT_FOUND' });
    const { createJiti } = createRequire(join(consumer, 'node_modules/@earendil-works/pi-coding-agent/package.json'))('jiti');
    const jiti = createJiti(pathToFileURL(join(entry, 'index.ts')).href, { fsCache: false });
    const load = relative => jiti.import(pathToFileURL(join(entry, relative)).href);
    for (const record of inputs.pi.packages) {
      const resolved = jiti.esmResolve(record.name);
      const packageRoot = await realpath(join(consumer, 'node_modules', record.name));
      assert.ok((await realpath(fileURLToPath(resolved))).startsWith(packageRoot + sep), 'Consumer must resolve its selected host graph');
    }
    const tuiURL = jiti.esmResolve('@earendil-works/pi-tui'), codingURL = jiti.esmResolve('@earendil-works/pi-coding-agent');
    const tui = await jiti.import('@earendil-works/pi-tui'), coding = await jiti.import('@earendil-works/pi-coding-agent');
    assert.equal(typeof tui.Container, 'function'); assert.equal(typeof coding.getAgentDir, 'function');
    assert.equal(tui.Container, (await import(tuiURL)).Container, 'Consumer TUI runtime class identity');
    assert.equal(coding.getAgentDir, (await import(codingURL)).getAgentDir, 'Consumer SDK runtime identity');
    if (!installed) {
      assert.throws(() => createRequire(join(entry, 'occipital/shared.ts')).resolve('@cortexkit/subc-client'), { code: 'MODULE_NOT_FOUND' });
      await assert.rejects(jiti.import('@cortexkit/subc-client'), { code: 'MODULE_NOT_FOUND' });
    } else assert.ok(await jiti.import('@cortexkit/subc-client'));
    const starts = [], urls = [];
    let downloads = 0;
    globalThis.fetch = async (url, options) => {
      const sourceURL = String(url); assert.equal(sourceURL, artifact.url, 'Only the exact declared native URL may be fetched');
      urls.push(sourceURL);
      const reply = await originalFetch(registry.downloadURL(sourceURL), options);
      if (reply.ok && reply.body) downloads++;
      return reply;
    };
    childProcess.spawn = function (file, ...args) { starts.push(file); return originalSpawn.call(this, file, ...args); };
    syncBuiltinESMExports();
    const { createSyntaxOptions } = await load('occipital/bootstrap.ts');
    const { SyntaxClient } = await load('occipital/client.ts');
    assert.deepEqual((await load('occipital/release.ts')).NATIVE_RELEASE, NATIVE_RELEASE);
    for (const phase of ['cold', 'warm']) {
      const beforeUrls = urls.length, beforeDownloads = downloads, beforeStarts = starts.length, beforeHTTPDownloads = registry.counts().downloads;
      client = new SyntaxClient({ ...createSyntaxOptions({ cwd: home, sessionManager: { getSessionId: () => 'installed-native' } }), onChange: () => wake?.() });
      assert.equal(urls.length, beforeUrls); assert.equal(starts.length, beforeStarts);
      await client.start(); await client.start();
      const snapshot = client.snapshot();
      assert.equal(snapshot.standaloneVersion, NATIVE_RELEASE.version); assert.equal(snapshot.provider.kind, 'owned'); assert.equal(snapshot.provider.availability, 'ready');
      const nativeProfile = snapshot.provider.description.profiles.find(profile => profile.id === 'syntect:Nord'); assert.ok(nativeProfile);
      client.previewTheme({ kind: 'occipital', id: nativeProfile.id });
      client.sources.setStyleSelection({ kind: 'native', id: nativeProfile.id, fingerprint: nativeProfile.fingerprint });
      const expectedPath = installed ? join(consumer, 'node_modules', nativeName, executable)
        : join(home, 'agent/cache/occipital', NATIVE_RELEASE.version, target, executable);
      assert.equal(starts.length, beforeStarts + 1); assert.equal(starts.at(-1), expectedPath);
      assert.equal(childProcess.execFileSync(expectedPath, ['--version'], { encoding: 'utf8', timeout: 5000, env: process.env }).trim(), `occipital ${NATIVE_RELEASE.version}`);
      const expectedDownloads = !installed && phase === 'cold' ? 1 : 0;
      assert.equal(downloads - beforeDownloads, expectedDownloads);
      assert.equal(registry.counts().downloads - beforeHTTPDownloads, expectedDownloads);
      assert.deepEqual(await executableDigest(expectedPath), { sha256: native.sha256, maxBytes: native.bytes });
      registry.assertNoRejectedRequests();
      if (expectedDownloads) assert.equal(urls[beforeUrls], artifact.url); else assert.equal(urls.length, beforeUrls);
      async function classified(version, text, complete) {
        const profile = client.snapshot().effective; assert.ok(profile);
        assert.equal(client.sources.observe({ key: 'tiny', version, text, complete, path: 'tiny.ts', profile: profile.id, fingerprint: profile.fingerprint }), true);
        client.sources.flush();
        const ready = () => client.sources.status('tiny')?.exact && client.sources.displayBasis('tiny')?.version === version && client.sources.stats().unsettledJobs === 0;
        if (!ready()) await new Promise((yes, no) => {
          const timer = setTimeout(() => { wake = undefined; no(Error('Installed source did not complete')); }, 10000);
          wake = () => { if (ready()) { clearTimeout(timer); wake = undefined; yes(); } }; wake();
        });
        assert.ok(ready()); return client.sources.stats();
      }
      const prefix = 'let n="界";\n', first = await classified(1, prefix, false), tail = await classified(2, prefix + '//x', false);
      assert.equal(tail.committedLineCalls, first.committedLineCalls); assert.equal(tail.committedLineBytes, first.committedLineBytes);
      assert.equal(tail.tailCalls, first.tailCalls + 1);
      assert.equal(first.dispatches - first.styleDispatches, 1); assert.equal(tail.dispatches - tail.styleDispatches, 2);
      assert.equal(first.styleDispatches, 1, 'initial contexts need native styles');
      assert.equal(tail.styleDispatches, first.styleDispatches + 1, 'the new comment context needs native styles');
      const complete = await classified(3, prefix + '//x\n', true);
      assert.equal(complete.dispatches - complete.styleDispatches, 3);
      assert.equal(complete.styleDispatches, tail.styleDispatches, 'committing the same comment context reuses its styles');
      assert.equal(complete.committedLineCalls, tail.committedLineCalls + 1);
      assert.equal(complete.committedLineBytes, tail.committedLineBytes + Buffer.byteLength('//x\n'));
      const styles = [];
      assert.equal(client.sources.visitRanges('tiny', (start, end, style) => { if (end > Buffer.byteLength(prefix)) styles.push(style); }), true);
      assert.ok(styles.length > 0); assert.ok(styles.every(style => style.foreground.kind === 'rgb'), 'actual Nord comment uses literal native colors');
      for (let i = 0; i < 20; i++) await classified(3, prefix + '//x\n', true);
      const warm = client.sources.stats(), warmSourceDispatches = (warm.dispatches - warm.styleDispatches) - (complete.dispatches - complete.styleDispatches),
        warmStyleDispatches = warm.styleDispatches - complete.styleDispatches;
      assert.equal(warmSourceDispatches, 0); assert.equal(warmStyleDispatches, 0);
      assert.equal(warm.dispatches, complete.dispatches); assert.equal(warm.preparedBytes, complete.preparedBytes);
      const pid = snapshot.provider.description.runtime.pid;
      await client.dispose();
      assert.equal(client.sources.stats().retention.retainedBytes, 0); assert.equal(client.sources.stats().unsettledJobs, 0);
      assert.equal(client.broker.stats().liveTimers, 0); assert.equal(client.broker.stats().recoveryTimers, 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); client = undefined;
      console.log(JSON.stringify({ node: process.version, pi: inputs.pi.version, target, version: NATIVE_RELEASE.version,
        commit: native.commit, nativeTree: native.nativeTree, sha256: native.sha256, consumerLockSha256, installed, phase,
        nativeDownloads: downloads - beforeDownloads, httpRequests: urls.length - beforeUrls, localHTTPDownloads: registry.counts().downloads - beforeHTTPDownloads, nativeDispatches: complete.dispatches,
        sourceDispatches: complete.dispatches - complete.styleDispatches, styleDispatches: complete.styleDispatches,
        sourceProgression: [first, tail, complete].map(stats => stats.dispatches - stats.styleDispatches),
        styleProgression: [first, tail, complete].map(stats => stats.styleDispatches),
        prefixReparsed: false, warmDispatches: warm.dispatches - complete.dispatches, warmSourceDispatches, warmStyleDispatches,
        executable: expectedPath, sdkAbsent: !installed, processReaped: true }));
    }
    globalThis.fetch = originalFetch; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    restoreEnv();
  }
  completed = true;
} catch (error) {
  fixtureError = error;
  throw error;
} finally {
  await client?.dispose();
  await registry?.close();
  restoreEnv(); globalThis.fetch = originalFetch; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  const cleanupStarted = performance.now();
  await rm(temporary, { recursive: true, force: true });
  const cleanupMs = Math.round(performance.now() - cleanupStarted);
  const elapsedMs = Math.round(performance.now() - started);
  try {
    await mkdir(join(repo, '.test-artifacts'), { recursive: true });
    const report = await mkdtemp(join(repo, '.test-artifacts/installed-preparation-'));
    await writeFile(join(report, 'fixture.json'), JSON.stringify({ node: process.version, target, configuredThreadpoolSize, temporaryDrive: summarizeTemporaryDrive(temporary),
      completed, elapsedMs, npmMs: Math.round(npmMs), cleanupMs }, null, 2) + '\n');
  } catch (error) {
    if (fixtureError) throw new AggregateError([fixtureError, error], 'Installed acceptance failed and fixture diagnostics could not be saved');
    throw error;
  }
}
