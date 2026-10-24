import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { acquireNative, NativeDeliveryError } from '../../../src/occipital/native.ts';

const bytes = new TextEncoder().encode('fixture exact immutable native artifact');
const digest = createHash('sha256').update(bytes).digest('hex');
const release = { version: '0.1.0-fixture', target: 'linux-x64-gnu', sha256: digest, url: 'https://fixture.invalid/occipital-v0.1.0-fixture', maxBytes: 1024 };
async function fixture(t: any) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'occipital-delivery-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return cacheDir;
}
const response = () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
async function seedVersion(cacheDir: string, version: string, target = release.target) {
  const path = join(cacheDir, version, target, target.startsWith('windows-') ? 'occipital.exe' : 'occipital');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

test('retention keeps the exact current version through upgrade and rollback with explicit download counts', async t => {
  const cacheDir = await fixture(t); let downloads = 0;
  const fetcher: typeof fetch = async () => { downloads++; return response(); };
  const first = await acquireNative({ cacheDir, release, fetcher });
  assert.equal(first.downloaded, true); assert.deepEqual(new Uint8Array(await readFile(first.path)), bytes);
  const warm = await acquireNative({ cacheDir, release, fetcher });
  assert.equal(warm.path, first.path); assert.equal(warm.downloaded, false); assert.equal(downloads, 1);
  const other = await acquireNative({ cacheDir, release: { ...release, version: '0.2.0-fixture' }, fetcher });
  assert.notEqual(other.path, first.path); assert.equal(downloads, 2);
  await assert.rejects(stat(dirname(dirname(first.path))), { code: 'ENOENT' });
  assert.deepEqual(new Uint8Array(await readFile(other.path)), bytes);
  const rollback = await acquireNative({ cacheDir, release, fetcher });
  assert.equal(rollback.path, first.path); assert.equal(rollback.downloaded, true); assert.equal(downloads, 3);
  await assert.rejects(stat(dirname(dirname(other.path))), { code: 'ENOENT' });
  assert.equal((await acquireNative({ cacheDir, release, fetcher })).downloaded, false);
  assert.equal(downloads, 3);
});

test('checksum, empty, size and interrupted failures preserve previous versions and never publish partial bytes', async t => {
  const cacheDir = await fixture(t);
  const previous = await acquireNative({ cacheDir, release, fetcher: async () => response() });
  const cases: [string, typeof fetch][] = [
    ['checksum', async () => new Response('wrong')],
    ['empty', async () => new Response(new Uint8Array())],
    ['declared', async () => new Response(bytes, { headers: { 'content-length': '1025' } })],
    ['streamed', async () => new Response(new Uint8Array(1025))],
    ['interrupted', async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 5)); c.error(new Error('fixture interrupted')); } }))],
  ];
  for (const [kind, fetcher] of cases) {
    const version = `0.1.0-${kind}`;
    await assert.rejects(acquireNative({ cacheDir, release: { ...release, version }, fetcher }), NativeDeliveryError);
    assert.deepEqual(await readdir(join(cacheDir, version, release.target)), [], kind);
    assert.deepEqual(new Uint8Array(await readFile(previous.path)), bytes, kind);
  }
});

test('corrupt exact artifact is repaired once; unrelated installed version is not substituted', async t => {
  const cacheDir = await fixture(t); let downloads = 0;
  const fetcher: typeof fetch = async () => { downloads++; return response(); };
  const good = await acquireNative({ cacheDir, release, fetcher });
  await writeFile(good.path, 'corrupt');
  const repaired = await acquireNative({ cacheDir, release, fetcher });
  assert.equal(repaired.path, good.path); assert.equal(repaired.downloaded, true); assert.equal(downloads, 2);
  const wrongVersion = await acquireNative({ cacheDir, release: { ...release, version: '0.9.0-fixture' }, fetcher });
  assert.notEqual(wrongVersion.path, good.path); assert.equal(downloads, 3);
});

test('cancellation before temporary-file creation leaves complete versions intact', async t => {
  const cacheDir = await fixture(t); const cancel = new AbortController();
  const good = await acquireNative({ cacheDir, release, fetcher: async () => response() });
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 5)); cancel.abort(); c.close(); } }));
  await assert.rejects(acquireNative({ cacheDir, release: { ...release, version: '0.1.0-cancelled' }, fetcher, signal: cancel.signal }), NativeDeliveryError);
  assert.deepEqual(await readdir(join(cacheDir, '0.1.0-cancelled', release.target)), []);
  assert.deepEqual(new Uint8Array(await readFile(good.path)), bytes);
});

test('concurrent cold acquirers publish one complete pathname without a lock or stale-lock dependency', async t => {
  const cacheDir = await fixture(t); let downloads = 0;
  const fetcher: typeof fetch = async () => { downloads++; return response(); };
  const results = await Promise.all(Array.from({ length: 3 }, () => acquireNative({ cacheDir, release, fetcher })));
  assert.equal(new Set(results.map(r => r.path)).size, 1);
  assert.ok(downloads >= 1 && downloads <= 3);
  assert.deepEqual(await readdir(dirname(results[0].path)), ['occipital']);
  assert.deepEqual(new Uint8Array(await readFile(results[0].path)), bytes);
});

test('unsafe identities/non-HTTPS origins and excessive/downgraded redirects refuse before publication', async t => {
  const cacheDir = await fixture(t); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response(); };
  for (const invalid of [ { ...release, version: '../other' }, { ...release, target: '../target' }, { ...release, sha256: 'x' }, { ...release, url: 'http://fixture.invalid/file' }, { ...release, maxBytes: Infinity } ]) {
    await assert.rejects(acquireNative({ cacheDir, release: invalid, fetcher }), NativeDeliveryError);
  }
  assert.equal(calls, 0);
  await assert.rejects(acquireNative({ cacheDir, release, fetcher: async () => Response.redirect('http://fixture.invalid/file') }), NativeDeliveryError);
  calls = 0;
  await assert.rejects(acquireNative({ cacheDir, release, fetcher: async () => { calls++; return Response.redirect(release.url); } }), NativeDeliveryError);
  assert.equal(calls, 4);
  assert.deepEqual(await readdir(join(cacheDir, release.version, release.target)), []);
});

test('cancellation during a pending real transfer removes the observed partial temporary file', async t => {
  const cacheDir = await fixture(t), cancel = new AbortController();
  const good = await acquireNative({ cacheDir, release, fetcher: async () => response() });
  const pendingRelease = { ...release, version: '0.1.0-pending' };
  const directory = join(cacheDir, pendingRelease.version, release.target);
  await mkdir(directory, { recursive: true });
  let resolvePartial!: (file: string) => void, rejectPartial!: (error: Error) => void;
  const partial = new Promise<string>((resolve, reject) => { resolvePartial = resolve; rejectPartial = reject; });
  const deadline = setTimeout(() => rejectPartial(new Error('fixture partial-file observation deadline')), 5000);
  t.after(() => clearTimeout(deadline));
  const watcher = watch(directory, (_event, filename) => {
    if (typeof filename !== 'string' || !filename.startsWith('.occipital-') || !filename.endsWith('.tmp')) return;
    void readFile(join(directory, filename)).then(data => { if (data.length === 5) resolvePartial(filename); }, () => {});
  });
  t.after(() => watcher.close());
  let requests = 0;
  const server = createServer((_request, res) => {
    requests++;
    res.writeHead(200, { 'content-length': String(bytes.length) });
    res.write(bytes.subarray(0, 5)); // Intentionally pending; only abort settles the body.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  // Keep declared HTTPS metadata untouched; redirect only this fixture fetcher to loopback.
  const fetcher: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/pending`, init);
  const acquisition = acquireNative({ cacheDir, release: pendingRelease, fetcher, signal: cancel.signal });
  const rejected = assert.rejects(acquisition, NativeDeliveryError);
  const filename = await partial;
  clearTimeout(deadline);
  assert.deepEqual(new Uint8Array(await readFile(join(directory, filename))), bytes.subarray(0, 5));
  assert.equal(requests, 1);
  cancel.abort();
  await rejected;
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(new Uint8Array(await readFile(good.path)), bytes);
});


test('explicit trusted installed payload prunes old downloads without download or metadata mutation', async t => {
  const cacheDir = await fixture(t), installedPath = join(cacheDir, 'installed-payload'); let downloads = 0;
  const obsolete = await seedVersion(cacheDir, '0.0.9');
  await writeFile(installedPath, bytes); await chmod(installedPath, 0o700);
  const trusted = Object.freeze({ ...release });
  const result = await acquireNative({ cacheDir, release: trusted, installedPath, fetcher: async () => { downloads++; return response(); } });
  assert.deepEqual(result, { path: installedPath, downloaded: false });
  assert.equal(downloads, 0); assert.deepEqual(trusted, release);
  await assert.rejects(stat(dirname(dirname(obsolete))), { code: 'ENOENT' });
  assert.deepEqual(new Uint8Array(await readFile(installedPath)), bytes);
});

test('wrong digest, over-bound and missing installed payload use only the exact declared cache/download', async t => {
  const cacheDir = await fixture(t), installedPath = join(cacheDir, 'installed-payload'); let downloads = 0;
  const fetcher: typeof fetch = async () => { downloads++; return response(); };
  await writeFile(installedPath, 'wrong digest'); await chmod(installedPath, 0o700);
  const cold = await acquireNative({ cacheDir, release, installedPath, fetcher });
  assert.notEqual(cold.path, installedPath); assert.equal(cold.downloaded, true); assert.equal(downloads, 1);
  await writeFile(installedPath, new Uint8Array(release.maxBytes + 1));
  const bounded = await acquireNative({ cacheDir, release, installedPath, fetcher });
  assert.equal(bounded.path, cold.path); assert.equal(bounded.downloaded, false);
  const missing = await acquireNative({ cacheDir, release, installedPath: join(cacheDir, 'absent'), fetcher });
  assert.equal(missing.path, cold.path); assert.equal(downloads, 1);
  assert.deepEqual(new Uint8Array(await readFile(cold.path)), bytes);
});

const run = promisify(execFile);
const executableBytes = Buffer.from('#!/bin/sh\nprintf VERIFIED\n'.padEnd(64, ' '));
const executableRelease = Object.freeze({ ...release, sha256: createHash('sha256').update(executableBytes).digest('hex'), maxBytes: 64 });
const unixOnly = { skip: process.platform === 'win32' };

test('exact installed mode0644 falls back to executable exact cache without mutating installed package', unixOnly, async t => {
  const cacheDir = await fixture(t), installedPath = join(cacheDir, 'nonexec'); let downloads = 0;
  await writeFile(installedPath, executableBytes); await chmod(installedPath, 0o644);
  const options = { cacheDir, installedPath, release: executableRelease, fetcher: async () => { downloads++; return new Response(executableBytes); } };
  const cold = await acquireNative(options), warm = await acquireNative(options);
  assert.notEqual(cold.path, installedPath); assert.equal(cold.downloaded, true);
  assert.equal(warm.path, cold.path); assert.equal(warm.downloaded, false); assert.equal(downloads, 1);
  assert.equal((await run(cold.path)).stdout, 'VERIFIED');
  assert.deepEqual(await readFile(installedPath), executableBytes); assert.equal((await stat(installedPath)).mode & 0o777, 0o644);
  assert.equal(executableRelease.sha256, createHash('sha256').update(executableBytes).digest('hex'));
});

test('relative installed path executes verified absolute file, never controlled PATH file or distinct child cwd file', unixOnly, async t => {
  const root = await fixture(t), previousCwd = process.cwd(); let downloads = 0;
  const childCwd = join(root, 'other'), bin = join(root, 'bin'), installed = join(root, 'occipital');
  await mkdir(childCwd); await mkdir(bin);
  await writeFile(installed, executableBytes); await chmod(installed, 0o755);
  for (const foreign of [join(bin, 'occipital'), join(childCwd, 'occipital')]) {
    await writeFile(foreign, '#!/bin/sh\nprintf PATH_OTHER'); await chmod(foreign, 0o755);
  }
  const options = { cacheDir: 'cache', installedPath: 'occipital', release: executableRelease,
    fetcher: async () => { downloads++; return new Response(executableBytes); } };
  try {
    process.chdir(root);
    const result = await acquireNative(options);
    assert.equal((await run(result.path, [], { cwd: childCwd, env: { PATH: bin } })).stdout, 'VERIFIED');
    assert.equal(isAbsolute(result.path), true); assert.equal(result.path, installed); assert.equal(downloads, 0);
    assert.equal(options.installedPath, 'occipital'); assert.equal(options.cacheDir, 'cache');
    assert.deepEqual(await readFile(installed), executableBytes); assert.equal((await stat(installed)).mode & 0o777, 0o755);
  } finally { process.chdir(previousCwd); }
});

test('relative cache directory returns the same verified absolute executable despite distinct child cwd', unixOnly, async t => {
  const root = await fixture(t), previousCwd = process.cwd(); let downloads = 0;
  const childCwd = join(root, 'other'); await mkdir(childCwd);
  const foreign = join(childCwd, 'cache', executableRelease.version, executableRelease.target, 'occipital');
  await mkdir(dirname(foreign), { recursive: true });
  await writeFile(foreign, '#!/bin/sh\nprintf PATH_OTHER'); await chmod(foreign, 0o755);
  const options = { cacheDir: 'cache', release: executableRelease, fetcher: async () => { downloads++; return new Response(executableBytes); } };
  try {
    process.chdir(root);
    const cold = await acquireNative(options), warm = await acquireNative(options);
    assert.equal((await run(cold.path, [], { cwd: childCwd, env: { PATH: childCwd } })).stdout, 'VERIFIED');
    assert.equal(isAbsolute(cold.path), true); assert.equal(cold.path, join(root, 'cache', executableRelease.version, executableRelease.target, 'occipital'));
    assert.equal(warm.path, cold.path); assert.equal(downloads, 1); assert.equal(options.cacheDir, 'cache');
  } finally { process.chdir(previousCwd); }
});

test('absolute anchoring preserves symlink parent traversal for installed payload and relative cache', unixOnly, async t => {
  const root = await fixture(t), previousCwd = process.cwd(); let downloads = 0;
  await mkdir(join(root, 'user', 'state'), { recursive: true });
  await symlink(join(root, 'user', 'state'), join(root, 'alias'), 'dir');
  const installed = join(root, 'user', 'payload');
  await writeFile(installed, executableBytes); await chmod(installed, 0o755);
  await writeFile(join(root, 'payload'), '#!/bin/sh\nprintf PATH_OTHER'); await chmod(join(root, 'payload'), 0o755);
  const installedOptions = { cacheDir: 'unused', installedPath: 'alias/../payload', release: executableRelease,
    fetcher: async () => { downloads++; return new Response(executableBytes); } };
  try {
    process.chdir(root);
    const selected = await acquireNative(installedOptions);
    assert.equal(selected.path, `${root}/alias/../payload`); assert.equal(downloads, 0);
    assert.equal((await run(selected.path, [], { cwd: join(root, 'user'), env: { PATH: root } })).stdout, 'VERIFIED');
    const cacheOptions = { cacheDir: 'alias/../cache', release: executableRelease, fetcher: installedOptions.fetcher };
    const cold = await acquireNative(cacheOptions), warm = await acquireNative(cacheOptions);
    assert.equal(cold.path, `${root}/alias/../cache/${executableRelease.version}/${executableRelease.target}/occipital`);
    assert.deepEqual(await readFile(join(root, 'user', 'cache', executableRelease.version, executableRelease.target, 'occipital')), executableBytes);
    assert.equal((await run(cold.path, [], { cwd: join(root, 'user'), env: { PATH: root } })).stdout, 'VERIFIED');
    assert.equal(warm.path, cold.path); assert.equal(downloads, 1);
    assert.equal((await readdir(root)).includes('cache'), false);
    assert.equal(installedOptions.installedPath, 'alias/../payload'); assert.equal(cacheOptions.cacheDir, 'alias/../cache');
    assert.deepEqual(await readFile(installed), executableBytes); assert.equal((await stat(installed)).mode & 0o777, 0o755);
  } finally { process.chdir(previousCwd); }
});


test('retention on a warm hit removes only other bounded version directories and preserves every current target', async t => {
  const root = await fixture(t), cacheDir = join(root, 'occipital'); let downloads = 0;
  const options = { cacheDir, release, fetcher: async () => { downloads++; return response(); } };
  const current = await acquireNative(options);
  const otherTarget = await seedVersion(cacheDir, release.version, 'windows-x64');
  const obsolete = await seedVersion(cacheDir, '0.0.9');
  const unknown = await seedVersion(cacheDir, 'not-a-version');
  const oversized = await seedVersion(cacheDir, `1.0.0-${'x'.repeat(64)}`);
  const external = await seedVersion(join(root, 'external'), '0.0.8');
  const legacy = await seedVersion(join(root, 'cache', 'occipital'), '0.0.7');
  const config = join(root, 'config.json'), dev = join(root, 'source', 'occipital');
  await writeFile(config, '{"unchanged":true}'); await mkdir(dirname(dev)); await writeFile(dev, bytes);
  const versionFile = join(cacheDir, '8.0.0'); await writeFile(versionFile, bytes);
  await symlink(dirname(dirname(external)), join(cacheDir, '0.0.8'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await acquireNative(options)).path, current.path);
  assert.equal(downloads, 1);
  await assert.rejects(stat(dirname(dirname(obsolete))), { code: 'ENOENT' });
  for (const path of [current.path, otherTarget, unknown, oversized, external, legacy, dev, versionFile]) {
    assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
  }
  assert.equal(await readFile(config, 'utf8'), '{"unchanged":true}');
  assert.equal((await fs.lstat(join(cacheDir, '0.0.8'))).isSymbolicLink(), true);
});

test('retention ignores a blocked deletion, removes other versions and retries on the next warm hit', async t => {
  const cacheDir = await fixture(t); let downloads = 0, refused = 0, blocked = true;
  const options = { cacheDir, release, fetcher: async () => { downloads++; return response(); } };
  const current = await acquireNative(options);
  const locked = await seedVersion(cacheDir, '0.0.8'), obsolete = await seedVersion(cacheDir, '0.0.9');
  const lockedDirectory = dirname(dirname(locked)), realRm = fs.rm;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === lockedDirectory) {
      refused++;
      if (blocked) throw Object.assign(new Error('fixture locked executable'), { code: 'EPERM' });
    }
    return realRm(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await acquireNative(options)).path, current.path);
  assert.equal(refused, 1); assert.equal(downloads, 1);
  assert.deepEqual(new Uint8Array(await readFile(locked)), bytes);
  await assert.rejects(stat(dirname(dirname(obsolete))), { code: 'ENOENT' });
  blocked = false;
  assert.equal((await acquireNative(options)).downloaded, false);
  assert.equal(refused, 2); assert.equal(downloads, 1);
  await assert.rejects(stat(lockedDirectory), { code: 'ENOENT' });
  assert.deepEqual(new Uint8Array(await readFile(current.path)), bytes);
});

test('retention ignores enumeration failure and retries after a later successful acquisition', async t => {
  const cacheDir = await fixture(t); let downloads = 0, scans = 0;
  const options = { cacheDir, release, fetcher: async () => { downloads++; return response(); } };
  const current = await acquireNative(options), obsolete = await seedVersion(cacheDir, '0.0.9');
  const scan = t.mock.method(fs, 'readdir', async () => {
    scans++;
    throw Object.assign(new Error('fixture unreadable download root'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await acquireNative(options)).path, current.path);
  assert.equal(scans, 1); assert.equal(downloads, 1);
  assert.deepEqual(new Uint8Array(await readFile(obsolete)), bytes);
  scan.mock.restore(); syncBuiltinESMExports();
  assert.equal((await acquireNative(options)).downloaded, false);
  assert.equal(downloads, 1);
  await assert.rejects(stat(dirname(dirname(obsolete))), { code: 'ENOENT' });
});


test('retention preserves the current directory when filesystem enumeration uses different letter case', async t => {
  const cacheDir = await fixture(t), selected = { ...release, version: '1.0.0-rc' };
  const options = { cacheDir, release: selected, fetcher: async () => response() };
  const current = await acquireNative(options), directory = dirname(dirname(current.path)), alias = join(cacheDir, '1.0.0-RC');
  const realReaddir = fs.readdir, realStat = fs.stat, realRm = fs.rm;
  let aliasRemovals = 0;
  t.mock.method(fs, 'readdir', async (path: Parameters<typeof fs.readdir>[0], options: { withFileTypes: true }) => {
    const entries = await realReaddir(path, options);
    if (path === cacheDir) for (const entry of entries) if (entry.name === selected.version) entry.name = '1.0.0-RC';
    return entries;
  });
  t.mock.method(fs, 'stat', (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === alias) args[0] = directory;
    return realStat(...args);
  });
  t.mock.method(fs, 'rm', (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === alias) { aliasRemovals++; args[0] = directory; }
    return realRm(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await acquireNative(options)).path, current.path);
  assert.equal(aliasRemovals, 0);
  assert.deepEqual(new Uint8Array(await readFile(current.path)), bytes);
});

test('retention removes distinct differently-cased versions but preserves a real case-insensitive alias', async t => {
  const cacheDir = await fixture(t), selected = { ...release, version: '1.0.0-rc' };
  const previous = await seedVersion(cacheDir, '1.0.0-RC'), selectedDirectory = join(cacheDir, selected.version);
  const aliases = await stat(selectedDirectory).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
  const current = await acquireNative({ cacheDir, release: selected, fetcher: async () => response() });
  assert.deepEqual(new Uint8Array(await readFile(current.path)), bytes);
  if (aliases) assert.deepEqual(new Uint8Array(await readFile(previous)), bytes);
  else await assert.rejects(stat(dirname(dirname(previous))), { code: 'ENOENT' });
});
