import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseRef, stampVersion } from '../scripts/release/version.mjs';
import { assembleRelease, assetName, artifactName } from '../scripts/release/native-ci.mjs';
import { candidateTargets, daemonVersion, stageRelease } from '../scripts/release/native-release.mjs';
import { acquireNative } from '../src/occipital/native.ts';

const repo = resolve(import.meta.dirname, '..'), commit = 'a'.repeat(40), repository = 'chpock/pi-tidy-ui';
async function source(t) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-release-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'crates/occipital'), { recursive: true });
  await writeFile(join(root, 'crates/occipital/Cargo.toml'), '[package]\nname = "occipital"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nfixture = "0.0.0"\n');
  await writeFile(join(root, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "occipital"\nversion = "0.0.0"\ndependencies = ["fixture"]\n\n[[package]]\nname = "fixture"\nversion = "0.0.0"\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pi-toolview', version: '0.0.0', optionalDependencies: { fixture: '0.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'pi-toolview', version: '0.0.0', lockfileVersion: 3, packages: { '': { name: 'pi-toolview', version: '0.0.0' }, 'node_modules/fixture': { version: '0.0.0' } } }));
  await cp(join(repo, 'packages'), join(root, 'packages'), { recursive: true });
  await cp(join(repo, 'LICENSE'), join(root, 'LICENSE'));
  return root;
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('release refs are strict independent SemVer tags; branches/PRs remain development builds', () => {
  assert.deepEqual(releaseRef('refs/tags/pi-tidy-ui-v0.2.0'), { product: 'pi-tidy-ui', version: '0.2.0', prerelease: false });
  assert.deepEqual(releaseRef('refs/tags/occipital-v0.1.0-rc.1+build.2'), { product: 'occipital', version: '0.1.0-rc.1+build.2', prerelease: true });
  for (const ref of ['refs/heads/main', 'refs/heads/occipital-v0.1.0', 'refs/pull/1/merge']) assert.equal(releaseRef(ref).product, undefined);
  for (const tag of ['occipital-v01.2.3', 'occipital-v1.2', 'occipital-v1.2.3-01', 'occipital-v1.2.3-rc..1', 'occipital-v1.2.3+', 'v1.2.3', 'occipital-v1.2.3\n']) assert.throws(() => releaseRef('refs/tags/' + tag));
});

test('extension stamping updates only npm root versions and preserves name/dependencies/Cargo', async t => {
  const root = await source(t), cargo = await readFile(join(root, 'Cargo.lock'));
  await stampVersion(root, 'refs/tags/pi-tidy-ui-v0.2.0');
  assert.deepEqual(await json(join(root, 'package.json')), { name: 'pi-toolview', version: '0.2.0', optionalDependencies: { fixture: '0.0.0' } });
  const lock = await json(join(root, 'package-lock.json'));
  assert.equal(lock.version, '0.2.0'); assert.equal(lock.packages[''].version, '0.2.0'); assert.equal(lock.packages['node_modules/fixture'].version, '0.0.0');
  assert.deepEqual(await readFile(join(root, 'Cargo.lock')), cargo);
  assert.match(await readFile(join(root, 'crates/occipital/Cargo.toml'), 'utf8'), /version = "0.0.0"/);
});

test('daemon stamping updates only its manifest and lock entry, never similarly versioned dependencies/npm', async t => {
  const root = await source(t), npm = await readFile(join(root, 'package.json'));
  await stampVersion(root, 'refs/tags/occipital-v0.1.0-rc.1');
  assert.match(await readFile(join(root, 'Cargo.lock'), 'utf8'), /name = "occipital"\nversion = "0.1.0-rc.1"/);
  assert.match(await readFile(join(root, 'Cargo.lock'), 'utf8'), /name = "fixture"\nversion = "0.0.0"/);
  const cargo = await readFile(join(root, 'crates/occipital/Cargo.toml'), 'utf8');
  assert.match(cargo, /version = "0.1.0-rc.1"/); assert.match(cargo, /fixture = "0.0.0"/);
  assert.deepEqual(await readFile(join(root, 'package.json')), npm);
});

test('non-tag stamping is inert; invalid tags or mismatched lock versions write nothing', async t => {
  const root = await source(t), manifest = await readFile(join(root, 'crates/occipital/Cargo.toml'));
  await stampVersion(root, 'refs/heads/main');
  await assert.rejects(stampVersion(root, 'refs/tags/occipital-v1.2.3-01'));
  await writeFile(join(root, 'Cargo.lock'), '[[package]]\nname = "occipital"\nversion = "9.0.0"\n');
  await assert.rejects(stampVersion(root, 'refs/tags/occipital-v0.1.0'));
  assert.deepEqual(await readFile(join(root, 'crates/occipital/Cargo.toml')), manifest);
});

async function artifacts(t, version = '0.1.0') {
  const root = await source(t), tag = 'occipital-v' + version;
  await stampVersion(root, 'refs/tags/' + tag);
  const directory = join(root, 'artifacts'); await mkdir(directory);
  const notice = join(root, 'NOTICE'), binary = join(root, 'tiny');
  await writeFile(notice, 'Inert fixture notice\n'); await writeFile(binary, 'inert fixture binary\n');
  for (const target of Object.keys(candidateTargets)) {
    const output = join(directory, artifactName(version, target));
    await stageRelease({ root, output, input: { notice, artifacts: [{ target, path: binary,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(version, target))}` }] } });
    await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }));
    await mkdir(join(output, 'notices'));
    await writeFile(join(output, 'notices/notice-sources.json'), JSON.stringify({ gaps: [], inventory: [{ name: 'inert-fixture' }] }));
  }
  return { root, directory, tag, version, output: join(root, 'publish') };
}

test('release assembles six exact-commit/version artifacts and publishes checksums/notices without npm or extension edits', async t => {
  const f = await artifacts(t), npm = await readFile(join(f.root, 'package.json'));
  await assembleRelease({ ...f, repository, commit });
  const metadata = await json(join(f.output, 'native-release.json'));
  assert.equal(metadata.version, '0.1.0'); assert.equal(metadata.artifacts.length, 6);
  const files = await readdir(f.output), sums = await readFile(join(f.output, 'SHA256SUMS'), 'utf8');
  for (const file of files.filter(name => name !== 'SHA256SUMS')) {
    const hash = createHash('sha256').update(await readFile(join(f.output, file))).digest('hex');
    assert.ok(sums.includes(`${hash}  ${file}\n`), file);
  }
  assert.equal(files.filter(name => name.endsWith('.NOTICE')).length, 6);
  assert.ok(files.includes('occipital-v0.1.0-windows-arm64-msvc.exe'));
  assert.deepEqual(await readFile(join(f.root, 'package.json')), npm);
  assert.equal(files.some(name => name.endsWith('.tgz')), false);
});

test('prerelease-plus-build version survives stamping, staging and exact artifact assembly', async t => {
  const version = '0.1.0-rc.1+build.2', f = await artifacts(t, version);
  assert.equal(await daemonVersion(f.root), version);
  assert.match(await readFile(join(f.root, 'Cargo.lock'), 'utf8'), /version = "0\.1\.0-rc\.1\+build\.2"/);
  const metadata = await assembleRelease({ ...f, repository, commit });
  assert.equal(metadata.version, version); assert.equal(metadata.artifacts.length, 6);
  assert.ok((await readdir(f.output)).includes(assetName(version, 'windows-arm64-msvc')));
  for (const record of metadata.artifacts) {
    assert.ok(record.url.includes('occipital-v0.1.0-rc.1%2Bbuild.2/occipital-v0.1.0-rc.1%2Bbuild.2-'));
  }
});

test('declared native acquisition accepts complete SemVer and keeps the exact version cache key', async t => {
  const root = await source(t), version = '0.1.0-rc.1+build.2', bytes = Buffer.from('inert native payload');
  const release = { version, target: 'linux-x64-gnu', sha256: createHash('sha256').update(bytes).digest('hex'),
    maxBytes: bytes.length, url: 'https://example.invalid/native' };
  let fetches = 0;
  const options = { release, cacheDir: join(root, 'cache'), fetcher: async () => { fetches++; return new Response(bytes); } };
  const first = await acquireNative(options), second = await acquireNative(options);
  assert.equal(first.path, join(root, 'cache', version, release.target, 'occipital'));
  assert.deepEqual(await readFile(first.path), bytes); assert.equal(first.downloaded, true);
  assert.equal(second.downloaded, false); assert.equal(second.path, first.path); assert.equal(fetches, 1);
});

for (const change of ['commit', 'version', 'target', 'bytes', 'url', 'notice-gaps', 'missing-platform']) {
  test(`release rejects ${change} before creating any publish directory`, async t => {
    const f = await artifacts(t), target = 'linux-x64-gnu', directory = join(f.directory, artifactName(f.version, target));
    if (['commit', 'version', 'target'].includes(change)) {
      const info = await json(join(directory, 'build-info.json')); info[change] = 'wrong';
      await writeFile(join(directory, 'build-info.json'), JSON.stringify(info));
    } else if (change === 'bytes') await writeFile(join(directory, 'assets', assetName(f.version, target)), 'changed');
    else if (change === 'url') {
      const info = await json(join(directory, 'native-release.staged.json')); info.artifacts[0].url = 'https://example.invalid/file';
      await writeFile(join(directory, 'native-release.staged.json'), JSON.stringify(info));
    } else if (change === 'notice-gaps') {
      await writeFile(join(directory, 'notices/notice-sources.json'), '{"gaps":["unresolved"]}');
    } else await rm(directory, { recursive: true });
    await assert.rejects(assembleRelease({ ...f, repository, commit }));
    await assert.rejects(readFile(join(f.output, 'native-release.json')), { code: 'ENOENT' });
  });
}

test('CI routes both tag families, reuses the same-run native matrix, and publishes only Occipital', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const release = await readFile(join(repo, '.github/workflows/occipital-release.yml'), 'utf8');
  assert.match(ci, /tags: \['pi-tidy-ui-v\*', 'occipital-v\*'\]/);
  assert.match(ci, /uses: \.\/\.github\/workflows\/occipital\.yml/);
  assert.match(ci, /release-occipital:[\s\S]*needs: \[version, native\][\s\S]*refs\/tags\/occipital-v[\s\S]*uses: \.\/\.github\/workflows\/occipital-release\.yml/);
  for (const target of Object.keys(candidateTargets)) assert.ok(native.includes(`target: ${target}\n`), target);
  assert.match(native, /Stamp daemon before compilation[\s\S]*cargo build --release --locked/);
  assert.match(release, /actions\/download-artifact@v4/);
  assert.doesNotMatch(release, /run-id:|cargo build|npm publish/);
  assert.match(release, /assemble native-artifacts/);
  assert.match(release, /sha256sum --check SHA256SUMS/);
});
