import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { candidateTargets } from '../../scripts/release/native-release.mjs';
import { publishedDeclaration, stageExtensionPackage } from '../../scripts/release/extension-release.mjs';
import { runNpmPreparation, summarizeTemporaryDrive } from './npm-preparation.ts';

const repo = resolve(import.meta.dirname, '../..');
if (process.env.EXPECTED_NODE) assert.equal(process.version, `v${process.env.EXPECTED_NODE}`);
assert.ok(process.env.npm_execpath, 'Invoke with npm run test:installed-native');
const glibc = process.platform !== 'linux' || typeof process.report.getReport().header.glibcVersionRuntime === 'string';
const target = Object.keys(candidateTargets).find(key => candidateTargets[key].os === process.platform && candidateTargets[key].cpu === process.arch && glibc);
assert.ok(target, 'Supported native platform required');
const started = performance.now();
const configuredThreads = Number(process.env.UV_THREADPOOL_SIZE);
const configuredThreadpoolSize = Number.isSafeInteger(configuredThreads) && configuredThreads > 0 ? configuredThreads : null;
const temporary = await mkdtemp(join(tmpdir(), 'occipital-installed-'));
let npmMs = 0, completed = false, fixtureError;
const npm = async args => {
  const before = performance.now();
  try {
    return await runNpmPreparation(args, { cwd: repo, npmPath: process.env.npm_execpath,
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
  // Exercise a macOS-style temp alias on every host; Windows junctions need no symlink privilege.
  const alias = join(temporary, 'alias');
  await symlink(await realpath(temporary), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const root = await realpath(await mkdtemp(join(alias, 'consumer-')));
  pack = join(root, 'pack');
  await mkdir(pack);
  const NATIVE_RELEASE = await publishedDeclaration(repo), artifact = NATIVE_RELEASE.artifacts.find(item => item.target === target);
  assert.ok(artifact);
  const extension = join(root, 'extension');
  await stageExtensionPackage({ root: repo, output: extension, version: '0.0.0-installed', release: NATIVE_RELEASE });
  const executable = candidateTargets[target].executable, nativeName = `@kchpock/occipital-${target}`;
  const extensionPack = await packed(extension);
  const peers = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).devDependencies;
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'with-native' : 'without-native'), home = join(consumer, 'home');
    await mkdir(consumer); await mkdir(home);
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional']), '--prefix', consumer,
      join(pack, extensionPack),
      `@earendil-works/pi-coding-agent@${peers['@earendil-works/pi-coding-agent']}`, `@earendil-works/pi-tui@${peers['@earendil-works/pi-tui']}`]);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'local'),
      PI_CODING_AGENT_DIR: join(home, 'agent'), SUBC_CONNECTION_FILE: join(home, 'missing-service.json'), PATH: '' });
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
    const { unpackStyle } = await load('occipital/protocol.ts');
    assert.deepEqual((await load('occipital/release.ts')).NATIVE_RELEASE, NATIVE_RELEASE);
    for (const phase of ['cold', 'warm']) {
      const beforeUrls = urls.length, beforeDownloads = downloads, beforeStarts = starts.length;
      client = new SyntaxClient({ ...createSyntaxOptions({ cwd: home, sessionManager: { getSessionId: () => 'installed-native' } }), onChange: () => wake?.() });
      assert.equal(urls.length, beforeUrls); assert.equal(starts.length, beforeStarts);
      await client.start(); await client.start();
      const snapshot = client.snapshot();
      assert.equal(snapshot.standaloneVersion, NATIVE_RELEASE.version); assert.equal(snapshot.provider.kind, 'owned'); assert.equal(snapshot.provider.availability, 'ready');
      const expectedPath = installed ? join(consumer, 'node_modules', nativeName, executable)
        : join(home, 'agent/cache/occipital', NATIVE_RELEASE.version, target, executable);
      assert.equal(starts.length, beforeStarts + 1); assert.equal(starts.at(-1), expectedPath);
      assert.equal(childProcess.execFileSync(expectedPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), `occipital ${NATIVE_RELEASE.version}`);
      const expectedDownloads = !installed && phase === 'cold' ? 1 : 0;
      assert.equal(downloads - beforeDownloads, expectedDownloads);
      if (expectedDownloads) assert.equal(urls[beforeUrls], artifact.url); else assert.equal(urls.length, beforeUrls);
      async function classified(version, text, complete) {
        const profile = client.snapshot().effective; assert.ok(profile);
        assert.equal(client.sources.observe({ key: 'tiny', version, text, complete, path: 'tiny.ts', profile: profile.id, fingerprint: profile.fingerprint }), true);
        client.sources.flush();
        const ready = () => client.sources.status('tiny')?.exact && client.sources.status('tiny')?.classificationVersion === version && client.sources.stats().unsettledJobs === 0;
        if (!ready()) await new Promise((yes, no) => {
          const timer = setTimeout(() => { wake = undefined; no(Error('Installed source did not complete')); }, 10000);
          wake = () => { if (ready()) { clearTimeout(timer); wake = undefined; yes(); } }; wake();
        });
        assert.ok(ready()); return client.sources.stats();
      }
      const prefix = 'let n="界";\n', first = await classified(1, prefix, false), tail = await classified(2, prefix + '//x', false);
      assert.equal(tail.committedLineCalls, first.committedLineCalls); assert.equal(tail.committedLineBytes, first.committedLineBytes);
      assert.equal(tail.tailCalls, first.tailCalls + 1);
      const complete = await classified(3, prefix + '//x\n', true);
      assert.equal(complete.dispatches, 3); assert.equal(complete.committedLineCalls, tail.committedLineCalls + 1);
      assert.equal(complete.committedLineBytes, tail.committedLineBytes + Buffer.byteLength('//x\n'));
      const roles = [];
      assert.equal(client.sources.visitRanges('tiny', (_start, _end, packed) => roles.push(unpackStyle(packed).role)), true); assert.ok(roles.includes('syntaxComment'));
      for (let i = 0; i < 20; i++) await classified(3, prefix + '//x\n', true);
      assert.equal(client.sources.stats().dispatches, complete.dispatches); assert.equal(client.sources.stats().preparedBytes, complete.preparedBytes);
      const pid = snapshot.provider.description.runtime.pid;
      await client.dispose();
      assert.equal(client.sources.stats().retention.retainedBytes, 0); assert.equal(client.sources.stats().unsettledJobs, 0);
      assert.equal(client.broker.stats().liveTimers, 0); assert.equal(client.broker.stats().recoveryTimers, 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); client = undefined;
      console.log(JSON.stringify({ node: process.version, target, version: NATIVE_RELEASE.version, installed, phase,
        nativeDownloads: downloads - beforeDownloads, httpRequests: urls.length - beforeUrls, nativeDispatches: complete.dispatches,
        prefixReparsed: false, warmDispatches: 0, executable: expectedPath, sdkAbsent: !installed, processReaped: true }));
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
