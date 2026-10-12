import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import * as npmPreparation from './fixtures/npm-preparation.ts';
import { NATIVE_RELEASE } from '../src/occipital/release.ts';
const { runNpmPreparation, summarizeNpmLog, summarizeNpmTimings } = npmPreparation;
const configuredThreads = Number(process.env.UV_THREADPOOL_SIZE);
const configuredThreadpoolSize = Number.isSafeInteger(configuredThreads) && configuredThreads > 0 ? configuredThreads : null;

const secret = 'PRIVATE_AUTH_MARKER';
const log = `0 verbose cli /private/${secret}/node /private/npm
1 silly config load:/private/${secret}/.npmrc
2 silly fetch manifest @private/${secret}@1.0.0
3 http fetch GET 200 https://user:${secret}@registry.example/pkg?token=${secret} 40ms (cache miss)
4 timing idealTree:${secret} Completed in 42ms
5 silly tarball no local data for ${secret}. Extracting by manifest.
6 silly placeDep ROOT ${secret}
7 silly reify mark retired [ '/private/${secret}' ]
8 error code ETIMEDOUT
9 error ${secret}
10 verbose stack Error: ${secret}
11 timing ${secret} Completed in 99ms
`;

test('npm diagnostics project only known stages and numeric progress, never opaque log data', () => {
  assert.deepEqual(summarizeNpmLog(log), [
    { line: 1, event: 'configuration' }, { line: 2, event: 'fetchManifest' },
    { line: 3, event: 'http', status: 200, elapsedMs: 40, cache: 'miss', resource: 'document' },
    { line: 4, event: 'idealTree', elapsedMs: 42 }, { line: 5, event: 'tarball' },
    { line: 6, event: 'placeDependency' }, { line: 7, event: 'reify' }, { line: 8, event: 'ETIMEDOUT' },
  ]);
  assert.doesNotMatch(JSON.stringify(summarizeNpmLog(log)), /PRIVATE_AUTH_MARKER|private|https|registry|npmrc/);
  assert.deepEqual(summarizeNpmLog('partial row\nunknown\n99999999999999999999 silly fetch manifest secret\n12 http fetch GET 999 secret 1ms'), []);
});

const timing = {
  metadata: { command: ['install', secret], logfiles: [`/private/${secret}`] },
  timers: { npm: 1700, 'idealTree:buildDeps': 300, 'reify:unpack': 1200,
    [`reifyNode:node_modules/${secret}`]: 800, 'reifyNode:node_modules/other': 900,
    [`reify:${secret}`]: 42, 'reify:save': -1, command: 'opaque' },
  unfinishedTimers: { [secret]: [123, 456] },
};

test('npm cache counters distinguish body hits, revalidation and misses without retaining request data', () => {
  const observations = summarizeNpmLog(`1 http cache https://user:${secret}@registry.example/pkg 12ms (cache hit)
2 http fetch GET 200 https://registry.example/pkg/-/pkg.tgz?token=${secret} 100ms attempt #2 (cache revalidated)
3 http fetch GET 200 https://registry.example/pkg 20ms (cache updated)
4 http fetch GET 200 https://registry.example/pkg 30ms (cache skip)
5 http fetch GET 200 https://registry.example/pkg 40ms (cache ${secret})
6 http cache https://registry.example/pkg 12ms (cache ${secret})
7 http cache @private/${secret}@1.0.0 0ms (cache hit)`);
  assert.deepEqual(observations, [
    { line: 1, event: 'cache', elapsedMs: 12, cache: 'hit', resource: 'document' },
    { line: 2, event: 'http', status: 200, elapsedMs: 100, cache: 'revalidated', resource: 'tarball' },
    { line: 3, event: 'http', status: 200, elapsedMs: 20, cache: 'updated', resource: 'document' },
    { line: 4, event: 'http', status: 200, elapsedMs: 30, cache: 'skip', resource: 'document' },
    { line: 5, event: 'http', status: 200, elapsedMs: 40, resource: 'document' },
    { line: 7, event: 'cache', elapsedMs: 0, cache: 'hit', resource: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_AUTH_MARKER|https|registry/);
});

test('npm timing projection preserves named phases and unpack work counts without opaque keys or metadata', () => {
  assert.deepEqual(summarizeNpmTimings(timing), {
    phases: { npm: 1700, 'idealTree:buildDeps': 300, 'reify:unpack': 1200 },
    reifyNodes: { count: 2, totalMs: 1700, maxMs: 900 },
  });
  assert.doesNotMatch(JSON.stringify(summarizeNpmTimings(timing)), /PRIVATE_AUTH_MARKER|private|node_modules|metadata|command/);
  for (const invalid of [null, [], 'opaque', { timers: null }, { timers: [] }]) {
    assert.deepEqual(summarizeNpmTimings(invalid), { phases: {}, reifyNodes: { count: 0, totalMs: 0, maxMs: 0 } });
  }
});

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, failure: boolean, logsPresent = true, malformedTiming = false) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-npm-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporary = join(root, 'temporary'), reportsRoot = join(root, 'reports');
  await mkdir(temporary);
  const npmPath = join(root, 'npm-fixture.mjs');
  await writeFile(npmPath, `import { writeFile } from 'node:fs/promises';
const logs = process.argv.find(arg => arg.startsWith('--logs-dir=')).slice('--logs-dir='.length);
if (${logsPresent}) {
  await writeFile(logs + '/fixture-debug-0.log', ${JSON.stringify(log)});
  if (!process.argv.includes('--timing')) throw Error('Preparation must enable real npm phase timers');
  await writeFile(logs + '/fixture-timing.json', ${JSON.stringify(malformedTiming ? `{"metadata":"${secret}"` : JSON.stringify(timing))});
}
console.log(${JSON.stringify(failure ? secret : '[{"filename":"fixture.tgz"}]')});
console.error(${JSON.stringify(secret)});
process.exitCode = ${failure ? 17 : 0};
`);
  return { temporary, reportsRoot, options: { cwd: root, npmPath, logsRoot: join(temporary, 'npm-logs'), reportsRoot } };
}

test('failed real preparation child preserves original failure and safe diagnostic after consumer cleanup', async t => {
  const f = await fixture(t, true);
  await assert.rejects(runNpmPreparation(['install', 'private-package'], f.options), { code: 17 });
  await rm(f.temporary, { recursive: true, force: true });
  const [directory] = await readdir(f.reportsRoot);
  const bytes = await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8');
  assert.doesNotMatch(bytes, /PRIVATE_AUTH_MARKER|private|https|registry|npmrc|stdout|stderr|cmd|environment/);
  const packet = JSON.parse(bytes);
  assert.equal(packet.node, process.version); assert.equal(packet.operation, 'install');
  assert.equal(packet.configuredThreadpoolSize, configuredThreadpoolSize);
  assert.equal(packet.exitCode, 17); assert.equal(packet.killed, false);
  assert.equal(packet.signal, null); assert.deepEqual(packet.debugLogs, [summarizeNpmLog(log)]);
  assert.deepEqual(packet.timings, [summarizeNpmTimings(timing)]);
});

test('successful preparation preserves exact pack stdout/stderr and safe cache/timing evidence', async t => {
  const f = await fixture(t, false);
  const result = await runNpmPreparation(['pack'], f.options);
  assert.equal(result.stdout, '[{"filename":"fixture.tgz"}]\n');
  assert.equal(result.stderr, secret + '\n');
  const [directory] = await readdir(f.reportsRoot);
  const bytes = await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8');
  assert.doesNotMatch(bytes, /PRIVATE_AUTH_MARKER|private|https|registry|npmrc|stdout|stderr|cmd|environment/);
  const packet = JSON.parse(bytes);
  assert.equal(packet.exitCode, 0); assert.equal(packet.operation, 'pack');
  assert.equal(packet.configuredThreadpoolSize, configuredThreadpoolSize);
  assert.equal(typeof packet.elapsedMs, 'number'); assert.ok(packet.elapsedMs >= 0);
  assert.deepEqual(packet.debugLogs, [summarizeNpmLog(log)]);
  assert.deepEqual(packet.timings, [summarizeNpmTimings(timing)]);
});

test('configured I/O pool projection preserves valid integers and drops invalid or opaque values', async t => {
  const original = process.env.UV_THREADPOOL_SIZE;
  try {
    for (const [value, expected] of [['4', 4], ['16', 16], ['1.5', null], [secret, null]] as const) {
      process.env.UV_THREADPOOL_SIZE = value;
      const f = await fixture(t, false);
      await runNpmPreparation(['pack'], f.options);
      const [directory] = await readdir(f.reportsRoot);
      const bytes = await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8');
      assert.equal(JSON.parse(bytes).configuredThreadpoolSize, expected);
      assert.doesNotMatch(bytes, /PRIVATE_AUTH_MARKER/);
    }
  } finally {
    if (original === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = original;
  }
});

test('successful preparation does not silently discard capture I/O failures', async t => {
  const f = await fixture(t, false);
  const file = join(f.temporary, 'not-a-directory'); await writeFile(file, 'occupied');
  await assert.rejects(runNpmPreparation(['pack'], { ...f.options, reportsRoot: file }));
});

test('partial timing JSON is reported as incomplete without leaking bytes or losing the child outcome', async t => {
  for (const failure of [true, false]) {
    const f = await fixture(t, failure, true, true);
    if (failure) await assert.rejects(runNpmPreparation(['install'], f.options), { code: 17 });
    else await runNpmPreparation(['pack'], f.options);
    const [directory] = await readdir(f.reportsRoot);
    const bytes = await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8');
    assert.doesNotMatch(bytes, /PRIVATE_AUTH_MARKER/);
    const packet = JSON.parse(bytes);
    assert.deepEqual(packet.timings, []); assert.equal(packet.invalidTimings, 1);
    assert.equal(packet.exitCode, failure ? 17 : 0);
  }
});

test('actual installed fixture retains npm child and capture failures when its final report also fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tidy-npm-outer-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, '..');
  assert.ok(NATIVE_RELEASE);
  const artifacts = NATIVE_RELEASE.artifacts.map(({ target }) => ({ target,
    sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', url: 'https://example.invalid/payload', maxBytes: 16 }));
  const fixtures = join(root, 'tests/fixtures'), native = join(root, 'src/occipital');
  await mkdir(fixtures, { recursive: true }); await mkdir(native, { recursive: true });
  const aliasType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(repo, 'scripts'), join(root, 'scripts'), aliasType);
  await symlink(join(repo, 'packages'), join(root, 'packages'), aliasType);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(join(repo, 'LICENSE'), join(root, 'LICENSE'));
  for (const name of ['installed-occipital.mjs', 'npm-preparation.ts']) await copyFile(join(repo, 'tests/fixtures', name), join(fixtures, name));
  for (const name of ['native.ts', 'version.ts']) await copyFile(join(repo, 'src/occipital', name), join(native, name));
  await writeFile(join(native, 'release.ts'), `export const NATIVE_RELEASE = ${JSON.stringify({ version: '1.0.0', artifacts })};`);
  await writeFile(join(root, '.test-artifacts'), 'block reports');
  const fakeNpm = join(root, 'fake-npm.mjs');
  await writeFile(fakeNpm, `console.error(${JSON.stringify(secret)}); process.exitCode=17;`);
  const wrapper = join(root, 'verify.mjs');
  await writeFile(wrapper, `import assert from 'node:assert/strict';
let fetches=0; globalThis.fetch=async()=>{fetches++;return new Response('x')};
process.env.npm_execpath=${JSON.stringify(fakeNpm)};
process.env.EXPECTED_NODE=process.version.slice(1);
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(fixtures, 'installed-occipital.mjs')).href)}),error=>{
  assert.ok(error instanceof AggregateError, 'final reporting must not replace the npm failure');
  assert.equal(error.errors.length,2);
  const original=error.errors[0]; assert.ok(original instanceof AggregateError);
  assert.equal(original.errors[0].code,17); assert.equal(original.errors[0].stderr,${JSON.stringify(secret + '\n')});
  assert.ok(['EEXIST','ENOTDIR'].includes(original.errors[1].code));
  assert.ok(['EEXIST','ENOTDIR'].includes(error.errors[1].code));
  return true;
});
assert.equal(fetches,2);
console.log('original failure preserved');`);
  const result = await promisify(execFile)(process.execPath, [wrapper], { timeout: 10000 });
  assert.equal(result.stdout, 'original failure preserved\n');
});

test('missing npm log stays explicit and capture I/O failure preserves both errors', async t => {
  const f = await fixture(t, true, false);
  await assert.rejects(runNpmPreparation(['install'], f.options), { code: 17 });
  const [directory] = await readdir(f.reportsRoot);
  const packet = JSON.parse(await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8'));
  assert.deepEqual(packet.debugLogs, []); assert.deepEqual(packet.timings, []); assert.equal(packet.invalidTimings, 0);
  const file = join(f.temporary, 'not-a-directory'); await writeFile(file, 'occupied');
  await assert.rejects(runNpmPreparation(['install'], { ...f.options, reportsRoot: file }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, 17); return true;
  });
});
