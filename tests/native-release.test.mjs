import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { candidateTargets, daemonVersion, stageRelease } from '../scripts/release/native-release.mjs';
import { decodeAcknowledgements, prepareNotices } from '../scripts/release/native-notices.mjs';
import { deflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'occipital-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notice = join(directory, 'NOTICE');
  await writeFile(notice, 'Fixture-only third-party notice, not release evidence.\n');
  const binary = join(directory, 'tiny');
  await writeFile(binary, 'tiny inert executable fixture\n');
  return { directory, notice, binary };
}
const inputFor = f => ({ notice: f.notice, artifacts: [{ target: 'linux-x64-gnu', path: f.binary,
  url: 'https://example.invalid/proposed/occipital-v0.0.0-linux-x64-gnu' }] });

test('daemon version comes only from Cargo, not the extension version', async () => {
  assert.equal(await daemonVersion(root), '0.0.0');
});

test('six candidate templates have exact npm OS/CPU/ABI metadata, without musl or JS installers', async () => {
  assert.deepEqual(Object.keys(candidateTargets), ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64', 'windows-x64-msvc', 'windows-arm64-msvc']);
  for (const [target, expected] of Object.entries(candidateTargets)) {
    const manifest = JSON.parse(await readFile(join(root, 'packages/native', target, 'package.json.template'), 'utf8'));
    assert.equal(manifest.name, `@kchpock/occipital-${target}`);
    assert.equal(manifest.version, '__OCCIPITAL_VERSION__');
    assert.deepEqual(manifest.os, [expected.os]);
    assert.deepEqual(manifest.cpu, [expected.cpu]);
    assert.deepEqual(manifest.libc, expected.libc ? [expected.libc] : undefined);
    assert.deepEqual(manifest.exports, { './package.json': './package.json' });
    assert.deepEqual(manifest.files, [expected.executable, 'LICENSE', 'NOTICE']);
    for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'bin', 'main']) assert.equal(manifest[key], undefined);
  }
});

test('staging hashes executable bytes, publishes raw download input, and preserves independent exact version', async t => {
  const f = await fixture(t), output = join(f.directory, 'stage');
  const metadata = await stageRelease({ root, input: inputFor(f), output });
  const bytes = await readFile(f.binary), hash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(metadata, { version: '0.0.0', artifacts: [{ target: 'linux-x64-gnu', sha256: hash,
    url: inputFor(f).artifacts[0].url, maxBytes: bytes.length }] });
  assert.deepEqual(JSON.parse(await readFile(join(output, 'native-release.staged.json'))), metadata);
  const directory = join(output, 'packages/linux-x64-gnu');
  const manifest = JSON.parse(await readFile(join(directory, 'package.json')));
  assert.equal(manifest.version, '0.0.0');
  assert.deepEqual(await readFile(join(directory, 'occipital')), bytes);
  assert.deepEqual(await readFile(join(output, 'assets/occipital-v0.0.0-linux-x64-gnu')), bytes);
  assert.deepEqual(await readFile(join(directory, 'LICENSE')), await readFile(join(root, 'LICENSE')));
  assert.deepEqual(await readFile(join(directory, 'NOTICE')), await readFile(f.notice));
  assert.deepEqual(await readFile(join(output, 'assets', 'NOTICE')), await readFile(f.notice));
  assert.deepEqual(await readFile(join(output, 'assets', 'LICENSE')), await readFile(join(root, 'LICENSE')));
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'occipital'))).mode & 0o777, 0o755);
  const require = createRequire(join(f.directory, 'consumer.cjs'));
  const scope = join(f.directory, 'node_modules/@kchpock');
  await mkdir(scope, { recursive: true });
  const { cp } = await import('node:fs/promises');
  await cp(directory, join(scope, manifest.name.split('/')[1]), { recursive: true });
  const installedManifest = require.resolve(`${manifest.name}/package.json`);
  assert.equal(installedManifest, join(scope, manifest.name.split('/')[1], 'package.json'));
  const { acquireNative } = await import('../src/occipital/native.ts');
  let downloads = 0;
  const acquired = await acquireNative({ cacheDir: join(f.directory, 'cache'),
    installedPath: join(scope, manifest.name.split('/')[1], 'occipital'),
    release: { version: metadata.version, ...metadata.artifacts[0] },
    fetcher: async () => { downloads++; throw new Error('Installed payload must not download'); } });
  assert.equal(acquired.downloaded, false); assert.equal(downloads, 0);
  assert.deepEqual(await readFile(acquired.path), bytes);
  await writeFile(join(directory, 'unrelated-build-output'), 'must not be packed');
  const pack = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: directory, env: { ...process.env, npm_config_cache: join(f.directory, 'npm-cache') } });
  assert.deepEqual(Object.values(JSON.parse(pack.stdout))[0].files.map(file => file.path).sort(), ['LICENSE', 'NOTICE', 'occipital', 'package.json']);
});

test('Windows payload uses .exe and stages only supplied targets, never the full candidate matrix', async t => {
  const f = await fixture(t), input = inputFor(f);
  input.artifacts[0].target = 'windows-arm64-msvc';
  const output = join(f.directory, 'windows');
  await stageRelease({ root, input, output });
  assert.deepEqual(await readdir(join(output, 'packages')), ['windows-arm64-msvc']);
  assert.deepEqual((await readdir(join(output, 'packages/windows-arm64-msvc'))).sort(), ['LICENSE', 'NOTICE', 'occipital.exe', 'package.json']);
});

test('invalid/duplicate/musl targets, unsafe URL, missing/empty notices, empty and oversized payloads fail before staging', async t => {
  const f = await fixture(t);
  const changes = [
    input => { input.artifacts[0].target = 'linux-x64-musl'; },
    input => { input.artifacts[0].target = '../target'; },
    input => { input.artifacts.push({ ...input.artifacts[0] }); },
    input => { input.artifacts[0].url = 'http://example.invalid/file'; },
    input => { input.artifacts[0].url = 'https://user:secret@example.invalid/file'; },
    input => { input.artifacts[0].url += '#fragment'; },
    input => { input.notice = join(f.directory, 'absent'); },
    input => { input.artifacts = []; },
  ];
  for (const [i, change] of changes.entries()) {
    const input = inputFor(f), output = join(f.directory, `invalid-${i}`);
    change(input);
    await assert.rejects(stageRelease({ root, input, output }));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await writeFile(f.notice, '');
  await assert.rejects(stageRelease({ root, input: inputFor(f), output: join(f.directory, 'empty-notice') }));
  await writeFile(f.notice, 'fixture');
  await writeFile(f.binary, '');
  await assert.rejects(stageRelease({ root, input: inputFor(f), output: join(f.directory, 'empty') }));
  const { open } = await import('node:fs/promises');
  const file = await open(f.binary, 'w');
  await file.truncate(64 * 1024 * 1024 + 1); await file.close();
  await assert.rejects(stageRelease({ root, input: inputFor(f), output: join(f.directory, 'oversized') }));
});

test('existing staging directory is not overwritten', async t => {
  const f = await fixture(t), output = join(f.directory, 'occupied');
  await mkdir(output); await writeFile(join(output, 'keep'), 'keep');
  await assert.rejects(stageRelease({ root, input: inputFor(f), output }));
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'keep');
});

function uint64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
function string(value) { const b = Buffer.from(value); return Buffer.concat([uint64(b.length), b]); }
test('pinned two-face acknowledgement decoder preserves original license text and rejects malformed dumps', () => {
  const kind = Buffer.alloc(4); kind.writeUInt32LE(1);
  const packed = deflateSync(Buffer.concat([uint64(1), kind, string('Exact license\n'), string('syntaxes/example/LICENSE'), uint64(0)]));
  assert.deepEqual(decodeAcknowledgements(packed), { syntaxes: [{ kind: 1, text: 'Exact license\n', path: 'syntaxes/example/LICENSE' }], themes: [] });
  assert.throws(() => decodeAcknowledgements(deflateSync(Buffer.from('bad'))));
  assert.throws(() => decodeAcknowledgements(Buffer.from('invalid zlib')));
  assert.throws(() => decodeAcknowledgements(deflateSync(Buffer.concat([uint64(0), uint64(0), Buffer.from('extra')]))));
});

test('extension-only version changes reuse an unchanged daemon release; daemon changes do not derive from extension version', async t => {
  const f = await fixture(t), sourceRoot = join(f.directory, 'source');
  await mkdir(join(sourceRoot, 'crates/occipital'), { recursive: true });
  const { cp } = await import('node:fs/promises');
  await cp(join(root, 'packages'), join(sourceRoot, 'packages'), { recursive: true });
  await cp(join(root, 'LICENSE'), join(sourceRoot, 'LICENSE'));
  const cargo = join(sourceRoot, 'crates/occipital/Cargo.toml');
  await writeFile(cargo, '[package]\nname = "occipital"\nversion = "0.1.0"\n\n[dependencies]\n');
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"pi-toolview","version":"99.0.0"}');
  const first = await stageRelease({ root: sourceRoot, input: inputFor(f), output: join(f.directory, 'independent-1') });
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"pi-toolview","version":"100.0.0"}');
  const second = await stageRelease({ root: sourceRoot, input: inputFor(f), output: join(f.directory, 'independent-2') });
  assert.deepEqual(first, second);
  await writeFile(cargo, '[package]\nname = "occipital"\nversion = "0.2.0"\n');
  const input = inputFor(f); input.artifacts[0].url = 'https://example.invalid/proposed/occipital-v0.2.0-linux-x64-gnu';
  const changed = await stageRelease({ root: sourceRoot, input, output: join(f.directory, 'independent-3') });
  assert.equal(changed.version, '0.2.0');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'independent-3/packages/linux-x64-gnu/package.json'))).version, '0.2.0');
  assert.equal(JSON.parse(await readFile(join(sourceRoot, 'package.json'))).version, '100.0.0');
});

test('notice preparation copies source texts exactly and reports unsourced dependency notices without inventing copyright', async t => {
  const f = await fixture(t), pkg = join(f.directory, 'dependency'), missing = join(f.directory, 'missing');
  await mkdir(pkg); await mkdir(missing);
  await writeFile(join(pkg, 'LICENSE'), 'Fixture copyright and license\n');
  const metadata = { packages: [
    { name: 'occipital', version: '0.1.0' },
    { name: 'fixture', version: '1.0.0', manifest_path: join(pkg, 'Cargo.toml') },
    { name: 'unsourced', version: '2.0.0', license: 'MIT', manifest_path: join(missing, 'Cargo.toml') },
  ] };
  const output = join(f.directory, 'notices');
  const report = await prepareNotices({ metadata, output });
  assert.equal(report.inventory.length, 1);
  assert.equal(report.gaps.length, 1); assert.match(report.gaps[0], /unsourced 2.0.0/);
  assert.match(await readFile(join(output, 'NOTICE'), 'utf8'), /Fixture copyright and license\n/);
  assert.doesNotMatch(await readFile(join(output, 'NOTICE'), 'utf8'), /Copyright.*unsourced/);
  const supplemented = await prepareNotices({ metadata, output: join(f.directory, 'supplemented'), supplements: [{
    name: 'unsourced', version: '2.0.0', file: f.notice, source: 'https://example.invalid/pinned-commit/LICENSE',
  }] });
  assert.deepEqual(supplemented.gaps, []); assert.equal(supplemented.inventory.length, 2);
  assert.equal(supplemented.inventory[1].source, 'https://example.invalid/pinned-commit/LICENSE');
});
