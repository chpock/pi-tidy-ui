import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, copyFile, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { candidateTargets } from '../scripts/release/native-release.mjs';
import { stageExtensionPackage } from '../scripts/release/extension-release.mjs';
import * as extensionRelease from '../scripts/release/extension-release.mjs';
import { stageRelease } from '../scripts/release/native-release.mjs';
import { artifactName, assetName, assembleRelease } from '../scripts/release/native-ci.mjs';

const repo = resolve(import.meta.dirname, '..'), run = promisify(execFile);
const release = JSON.parse(await readFile(join(repo, 'tests/fixtures/occipital-release-0.1.4.json'), 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'extension-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/occipital'), { recursive: true });
  const manifest = { name: 'pi-tidy-ui', version: '0.0.0', type: 'module', files: ['src', 'README.md', 'LICENSE'],
    optionalDependencies: { '@cortexkit/subc-client': '0.21.1' } };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'package-lock.json'), '{"version":"0.0.0","packages":{}}');
  await writeFile(join(root, 'README.md'), 'Fixture package, not release evidence.\n'); await writeFile(join(root, 'LICENSE'), 'MIT\n');
  await writeFile(join(root, 'src/occipital/release.ts'), await readFile(join(repo, 'src/occipital/release.ts')));
  return { root, manifest, output: join(root, 'disposable-package') };
}

test('extension staging generates six exact native dependencies and matching metadata without touching source manifests or lock', async t => {
  const f = await fixture(t), paths = ['package.json', 'package-lock.json', 'src/occipital/release.ts'];
  const before = await Promise.all(paths.map(path => readFile(join(f.root, path))));
  await stageExtensionPackage({ root: f.root, output: f.output, version: '0.2.0', release });
  const manifest = JSON.parse(await readFile(join(f.output, 'package.json'), 'utf8'));
  assert.equal(manifest.name, f.manifest.name); assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.optionalDependencies['@cortexkit/subc-client'], '0.21.1');
  for (const target of Object.keys(candidateTargets)) assert.equal(manifest.optionalDependencies[`@kchpock/occipital-${target}`], release.version);
  assert.equal(Object.keys(manifest.optionalDependencies).length, 7);
  const declaration = await readFile(join(f.output, 'src/occipital/release.ts'), 'utf8');
  const value = declaration.match(/export const NATIVE_RELEASE[^=]*= ([\s\S]*);\s*$/)?.[1];
  assert.ok(value); assert.deepEqual(JSON.parse(value), release);
  for (let i = 0; i < paths.length; i++) assert.deepEqual(await readFile(join(f.root, paths[i])), before[i]);
  await assert.rejects(stat(join(f.output, 'package-lock.json')), { code: 'ENOENT' });
  await assert.rejects(stageExtensionPackage({ root: f.root, output: f.output, version: '0.2.0', release }), { code: 'EEXIST' });
});

test('extension staging refuses development or npm-normalized versions before creating output', async t => {
  const f = await fixture(t);
  for (const version of ['0.0.0', '0.2', '0.2.0+build.1']) {
    await assert.rejects(stageExtensionPackage({ root: f.root, output: f.output, version, release }));
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
});

test('extension staging admits one complete canonical native family, not partial or mismatched metadata', async t => {
  const f = await fixture(t);
  const mutations = [r => r.artifacts.pop(), r => r.artifacts.push(r.artifacts[0]), r => r.artifacts[0].target = 'unsupported',
    r => r.artifacts[0].url = r.artifacts[1].url, r => r.artifacts[0].sha256 = 'invalid', r => r.artifacts[0].maxBytes = 0,
    r => r.version = '0.1.4+build.1'];
  for (const mutate of mutations) {
    const candidate = structuredClone(release); mutate(candidate);
    await assert.rejects(stageExtensionPackage({ root: f.root, output: f.output, version: '0.2.0', release: candidate }));
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
});

test('generated extension packs its own version and native declaration without repository lock or local binary', async t => {
  const f = await fixture(t); await stageExtensionPackage({ root: f.root, output: f.output, version: '0.2.0', release });
  const { stdout } = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: f.output, timeout: 30000, maxBuffer: 1024 * 1024 });
  const records = JSON.parse(stdout), result = Array.isArray(records) ? records[0] : Object.values(records)[0];
  assert.equal(result.name, 'pi-tidy-ui'); assert.equal(result.version, '0.2.0');
  assert.deepEqual(result.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'package.json', 'src/occipital/release.ts']);
});

async function preparedFamily(t) {
  const f = await fixture(t), version = '0.1.4', tag = 'occipital-v' + version, ref = 'refs/tags/pi-tidy-ui-v0.2.0';
  await mkdir(join(f.root, 'crates/occipital'), { recursive: true });
  await writeFile(join(f.root, 'crates/occipital/Cargo.toml'), '[package]\nname = "occipital"\nversion = "0.1.4"\nedition = "2021"\n');
  await cp(join(repo, 'packages'), join(f.root, 'packages'), { recursive: true });
  const git = args => run('git', args, { cwd: f.root, timeout: 10000 });
  await git(['init', '-q']); await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Fixture']);
  await git(['add', '.']); await git(['commit', '-qm', 'fixture: native release']); await git(['tag', tag]);
  await writeFile(join(f.root, 'README.md'), 'Extension-only change.\n'); await git(['add', 'README.md']);
  await git(['commit', '-qm', 'fixture: extension release']); await git(['tag', ref.slice('refs/tags/'.length)]);
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim(), directory = join(f.root, 'native-ci'); await mkdir(directory);
  const binary = join(f.root, 'inert-binary'), notice = join(f.root, 'fixture-notice');
  await writeFile(binary, 'inert exact native bytes\n'); await writeFile(notice, 'Fixture notice\n');
  for (const target of Object.keys(candidateTargets)) {
    const output = join(directory, artifactName(version, target));
    await stageRelease({ root: f.root, output, input: { notice, artifacts: [{ target, path: binary,
      url: `https://github.com/chpock/pi-tidy-ui/releases/download/${tag}/${assetName(version, target)}` }] } });
    await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }));
    await mkdir(join(output, 'notices')); await writeFile(join(output, 'notices/notice-sources.json'), '{"gaps":[],"inventory":[{"name":"fixture"}]}');
  }
  const publicDirectory = join(f.root, 'public');
  await assembleRelease({ directory, tag, repository: 'chpock/pi-tidy-ui', commit, output: publicDirectory });
  const assets = await Promise.all((await readdir(publicDirectory)).map(async name => ({ name, state: 'uploaded', size: (await stat(join(publicDirectory, name))).size })));
  await writeFile(join(publicDirectory, 'release.json'), JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets }));
  const registry = new Map(), archiveRoot = join(f.root, 'registry'); await mkdir(archiveRoot);
  for (const [target, platform] of Object.entries(candidateTargets)) {
    const packageRoot = join(archiveRoot, target); await mkdir(packageRoot);
    await cp(join(directory, artifactName(version, target), 'packages', target), join(packageRoot, 'package'), { recursive: true });
    const filename = `kchpock-occipital-${target}-${version}.tgz`, archive = join(archiveRoot, filename);
    await run('tar', ['-czf', archive, '-C', packageRoot, 'package']);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package/package.json')));
    const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
    registry.set(`${manifest.name}@${version}`, { manifest: { ...manifest, dist: { integrity } }, archive,
      packed: { name: manifest.name, version, filename, integrity, files: ['LICENSE', 'NOTICE', 'package.json', platform.executable].map(path => ({ path })) } });
  }
  const calls = [], execute = async (command, args, options) => {
    calls.push({ command, args });
    if (args[0] === 'view') return { stdout: JSON.stringify(registry.get(args[1])?.manifest) };
    if (args[0] === 'pack') {
      const item = registry.get(args[1]); await copyFile(item.archive, join(args[args.indexOf('--pack-destination') + 1], item.packed.filename));
      return { stdout: JSON.stringify([item.packed]) };
    }
    assert.equal(command, 'tar'); return run(command, args, options);
  };
  return { ...f, version, tag, ref, commit, directory, publicDirectory, registry, calls, execute };
}

test('extension release preparation binds exact tag history, all-six raw CI/public/npm bytes and generated-only pins', async t => {
  assert.equal(typeof extensionRelease.prepareExtensionRelease, 'function');
  const f = await preparedFamily(t), before = await readFile(join(f.root, 'package-lock.json'));
  const result = await extensionRelease.prepareExtensionRelease(f);
  assert.equal(result.daemonTag, f.tag); assert.equal(result.version, '0.2.0');
  assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 6);
  assert.equal(f.calls.filter(call => call.args[0] === 'pack').length, 6);
  assert.deepEqual(await readFile(join(f.root, 'package-lock.json')), before);
  const manifest = JSON.parse(await readFile(join(result.packageDirectory, 'package.json')));
  for (const target of Object.keys(candidateTargets)) assert.equal(manifest.optionalDependencies[`@kchpock/occipital-${target}`], '0.1.4');
});

test('changed native bytes refuse extension publication before registry access or package creation', async t => {
  assert.equal(typeof extensionRelease.prepareExtensionRelease, 'function');
  const f = await preparedFamily(t), root = join(f.directory, artifactName(f.version, 'windows-arm64-msvc'));
  const file = join(root, 'assets', assetName(f.version, 'windows-arm64-msvc')), bytes = await readFile(file); bytes[0] ^= 1;
  await writeFile(file, bytes);
  const path = join(root, 'native-release.staged.json'), metadata = JSON.parse(await readFile(path));
  metadata.artifacts[0].sha256 = createHash('sha256').update(bytes).digest('hex'); await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(extensionRelease.prepareExtensionRelease(f), /Occipital.*first|differs/);
  assert.equal(f.calls.length, 0); await assert.rejects(stat(join(f.output, 'extension')), { code: 'ENOENT' });
});

test('unpublished selected daemon release stops instead of falling back to an older version', async t => {
  assert.equal(typeof extensionRelease.prepareExtensionRelease, 'function');
  const f = await preparedFamily(t), path = join(f.publicDirectory, 'release.json'), value = JSON.parse(await readFile(path));
  value.draft = true; await writeFile(path, JSON.stringify(value));
  await assert.rejects(extensionRelease.prepareExtensionRelease(f), /published/);
  assert.equal(f.calls.length, 0); await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('all six npm identities must be ready before any archive packing or extension package creation', async t => {
  assert.equal(typeof extensionRelease.prepareExtensionRelease, 'function');
  const f = await preparedFamily(t); f.registry.get('@kchpock/occipital-windows-arm64-msvc@0.1.4').manifest.version = '0.1.3';
  await assert.rejects(extensionRelease.prepareExtensionRelease(f), /registry.*identity/);
  assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 6);
  assert.equal(f.calls.filter(call => call.args[0] === 'pack').length, 0);
  await assert.rejects(stat(join(f.output, 'extension')), { code: 'ENOENT' });
});

test('native archive manifest admission rejects a hidden installer even when registry metadata and executable stay valid', async t => {
  const f = await preparedFamily(t), target = 'linux-x64-gnu';
  const item = f.registry.get(`@kchpock/occipital-${target}@${f.version}`);
  const path = join(f.root, 'registry', target, 'package/package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.scripts = { postinstall: 'hidden-installer' };
  await writeFile(path, JSON.stringify(manifest));
  await run('tar', ['-czf', item.archive, '-C', join(f.root, 'registry', target), 'package']);
  item.manifest.dist.integrity = item.packed.integrity = 'sha512-' + createHash('sha512').update(await readFile(item.archive)).digest('base64');
  assert.equal(item.manifest.scripts, undefined);
  await assert.rejects(extensionRelease.prepareExtensionRelease(f), /native.*package.*scripts/i);
  await assert.rejects(stat(join(f.output, 'extension')), { code: 'ENOENT' });
});

test('public native admission explicitly overrides a conflicting scoped npm registry for view and pack', async t => {
  const f = await preparedFamily(t);
  await writeFile(join(f.root, '.npmrc'), '@kchpock:registry=https://fixture.invalid/\n');
  const execute = async (command, args, options) => {
    if (args[0] === 'view' || args[0] === 'pack') {
      const flags = args.filter(arg => arg.startsWith('--registry=') || arg.startsWith('--@kchpock:registry='));
      const actual = await run(command, ['config', 'get', '@kchpock:registry', ...flags], { cwd: f.root, timeout: 10000 });
      assert.equal(actual.stdout.trim(), 'https://registry.npmjs.org', 'scoped configuration must not redirect the public readiness gate');
    }
    return f.execute(command, args, options);
  };
  await extensionRelease.prepareExtensionRelease({ ...f, execute });
  assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 6);
  assert.equal(f.calls.filter(call => call.args[0] === 'pack').length, 6);
});
