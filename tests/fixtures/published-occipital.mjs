import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { readInputs, childEnv } from '../../scripts/test/context.mjs';
import { releaseRef } from '../../scripts/release/version.mjs';
import { candidateTargets } from '../../scripts/release/native-release.mjs';
import {enabledTargets} from '../../scripts/release/platforms.mjs';
import { publishedDeclaration, stageExtensionPackage } from '../../scripts/release/extension-release.mjs';
import { runNpmPreparation, summarizeTemporaryDrive } from './npm-preparation.ts';

// External delivery control: parent invokes this only for pi-tidy-ui releases.
const inputs = readInputs(), repo = inputs.source.root, authorizedRef = process.env.TIDY_TEST_RELEASE_REF;
assert.ok(authorizedRef, 'Published consumer requires explicit pi-tidy-ui release authorization');
assert.equal(releaseRef(authorizedRef).product, 'pi-tidy-ui', 'Published consumer is restricted to pi-tidy-ui releases');
assert.equal(process.version, inputs.node.version);
const glibc = process.platform !== 'linux' || typeof process.report.getReport().header.glibcVersionRuntime === 'string';
const target = Object.keys(candidateTargets).find(key => candidateTargets[key].os === process.platform && candidateTargets[key].cpu === process.arch && glibc);
assert.ok(target, 'Supported native platform required');
const targets=enabledTargets({windowsArm64:target === 'windows-arm64-msvc'});
const started = performance.now();
const configuredThreads = Number(process.env.UV_THREADPOOL_SIZE);
const configuredThreadpoolSize = Number.isSafeInteger(configuredThreads) && configuredThreads > 0 ? configuredThreads : null;
const temporary = await mkdtemp(join(tmpdir(), 'occipital-installed-'));
let npmMs = 0, completed = false, fixtureError;
const npm = async args => {
  const before = performance.now();
  try {
    return await runNpmPreparation(args, { cwd: temporary, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath: inputs.tools.npm, env: childEnv(temporary, { npm_config_offline: 'false' }, inputs),
      logsRoot: join(temporary, 'npm-logs'), reportsRoot: join(repo, '.test-artifacts') });
  } finally { npmMs += performance.now() - before; }
};
async function packed(spec) {
  const output = JSON.parse((await npm(['pack', spec, '--ignore-scripts', '--json', '--pack-destination', pack])).stdout);
  // npm <=11 returns an array; npm 12 keys the same records by package name.
  const records = Array.isArray(output) ? output : Object.values(output);
  assert.equal(records.length, 1); assert.equal(typeof records[0].filename, 'string');
  return records[0].filename;
}
const originalEnv = { ...process.env }, originalFetch = globalThis.fetch, originalSpawn = childProcess.spawn;
function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
let client, wake, pack;
try {
  assert.equal(childProcess.execFileSync(inputs.tools.git, ['-C', repo, 'rev-parse', '--verify', '--end-of-options', `${authorizedRef}^{commit}`], {
    encoding: 'utf8', timeout: 10000, env: childEnv(temporary, {}, inputs) }).trim(), inputs.source.commit, 'Authorized release must match tested source commit');
  // Exercise a macOS-style temp alias on every host; Windows junctions need no symlink privilege.
  const alias = join(temporary, 'alias');
  await symlink(await realpath(temporary), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const root = await realpath(await mkdtemp(join(alias, 'consumer-')));
  pack = join(root, 'pack');
  await mkdir(pack);
  const NATIVE_RELEASE = await publishedDeclaration(repo,'HEAD',targets), artifact = NATIVE_RELEASE.artifacts.find(item => item.target === target);
  assert.ok(artifact);
  const extension = join(root, 'extension');
  await stageExtensionPackage({ root: repo, output: extension, version: '0.0.0-installed', release: NATIVE_RELEASE, targets });
  const executable = candidateTargets[target].executable, nativeName = `@kchpock/occipital-${target}`;
  const extensionPack = await packed(extension);
  const peers = Object.fromEntries(inputs.pi.packages.map(record => [record.name, record.version]));
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'with-native' : 'without-native'), home = join(consumer, 'home');
    await mkdir(consumer); await mkdir(home);
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional']), '--prefix', consumer,
      join(pack, extensionPack),
      `@earendil-works/pi-coding-agent@${peers['@earendil-works/pi-coding-agent']}`, `@earendil-works/pi-tui@${peers['@earendil-works/pi-tui']}`]);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, childEnv(consumer, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'local'),
      PI_CODING_AGENT_DIR: join(home, 'agent'), SUBC_CONNECTION_FILE: join(home, 'missing-service.json'), PATH: '' }, inputs));
    const entry = join(consumer, 'node_modules/pi-tidy-ui/src'), require = createRequire(join(consumer, 'package.json'));
    const { createJiti } = createRequire(join(consumer, 'node_modules/@earendil-works/pi-coding-agent/package.json'))('jiti');
    const jiti = createJiti(pathToFileURL(join(entry, 'index.ts')).href, { fsCache: false });
    const load = relative => jiti.import(pathToFileURL(join(entry, relative)).href);
    if (!installed) {
      assert.throws(() => createRequire(join(entry, 'occipital/shared.ts')).resolve('@cortexkit/subc-client'), { code: 'MODULE_NOT_FOUND' });
      await assert.rejects(jiti.import('@cortexkit/subc-client'), { code: 'MODULE_NOT_FOUND' });
    } else {
      assert.ok(await jiti.import('@cortexkit/subc-client'));
    }
    const starts = [], urls = [];
    let downloads = 0;
    globalThis.fetch = async (...args) => { urls.push(String(args[0])); const reply = await originalFetch(...args); if (reply.ok && reply.body) downloads++; return reply; };
    childProcess.spawn = function (file, ...args) { starts.push(file); return originalSpawn.call(this, file, ...args); };
    syncBuiltinESMExports();
    const { createSyntaxOptions } = await load('occipital/bootstrap.ts');
    const { SyntaxClient } = await load('occipital/client.ts');
    assert.deepEqual((await load('occipital/release.ts')).NATIVE_RELEASE, NATIVE_RELEASE);
    for (const phase of ['cold', 'warm']) {
      const beforeUrls = urls.length, beforeDownloads = downloads, beforeStarts = starts.length;
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
      console.log(JSON.stringify({ node: process.version, target, version: NATIVE_RELEASE.version, installed, phase,
        nativeDownloads: downloads - beforeDownloads, httpRequests: urls.length - beforeUrls, nativeDispatches: complete.dispatches,
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
