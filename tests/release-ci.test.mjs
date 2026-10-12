import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  assert.deepEqual(files.sort(), ['LICENSE', 'NOTICE', 'native-release.json', 'SHA256SUMS',
    ...Object.keys(candidateTargets).map(target => assetName(f.version, target))].sort());
  assert.ok((await readFile(join(f.output, 'NOTICE'))).includes(Buffer.from('Inert fixture notice\n')));
  assert.ok(files.includes('occipital-v0.1.0-windows-arm64-msvc.exe'));
  assert.deepEqual(await readFile(join(f.root, 'package.json')), npm);
  assert.equal(files.some(name => name.endsWith('.tgz')), false);
});

test('one release NOTICE preserves every distinct platform text once and leaves native package notices unchanged', async t => {
  const f = await artifacts(t);
  const common = Buffer.from('Common exact license ☃\r\nSecond line without final newline');
  const windows = Buffer.from('Windows-specific dependency license\n');
  const windowsArm = Buffer.from('Windows ARM-specific dependency license\r\n');
  const originals = new Map();
  for (const target of Object.keys(candidateTargets)) {
    const bytes = target === 'windows-x64-msvc' ? windows : target === 'windows-arm64-msvc' ? windowsArm : common;
    const root = join(f.directory, artifactName(f.version, target));
    await writeFile(join(root, 'assets/NOTICE'), bytes);
    await writeFile(join(root, 'packages', target, 'NOTICE'), bytes);
    originals.set(target, bytes);
  }
  await assembleRelease({ ...f, repository, commit });
  const notice = await readFile(join(f.output, 'NOTICE'));
  for (const bytes of [common, windows, windowsArm]) {
    const first = notice.indexOf(bytes);
    assert.ok(first >= 0, 'original notice bytes must remain intact');
    assert.equal(notice.indexOf(bytes, first + bytes.length), -1, 'identical platform inventories appear only once');
  }
  for (const [target, bytes] of originals) {
    assert.ok(notice.includes(Buffer.from(target)), 'identify all covered targets');
    const root = join(f.directory, artifactName(f.version, target));
    assert.deepEqual(await readFile(join(root, 'assets/NOTICE')), bytes);
    assert.deepEqual(await readFile(join(root, 'packages', target, 'NOTICE')), bytes);
  }
  const sums = await readFile(join(f.output, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(`${createHash('sha256').update(notice).digest('hex')}  NOTICE\n`));
  assert.doesNotMatch(sums, /\.NOTICE\n/);
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

for (const change of ['commit', 'version', 'target', 'bytes', 'url', 'notice-gaps', 'license-bytes', 'missing-platform']) {
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
    } else if (change === 'license-bytes') {
      await writeFile(join(directory, 'assets/LICENSE'), (await readFile(join(directory, 'assets/LICENSE'), 'utf8')).replaceAll('\n', '\r\n'));
    } else await rm(directory, { recursive: true });
    await assert.rejects(assembleRelease({ ...f, repository, commit }));
    await assert.rejects(readFile(join(f.output, 'native-release.json')), { code: 'ENOENT' });
  });
}

test('Git Windows-style checkout preserves exact project and supplementary license bytes', async t => {
  const root = await source(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.safecrlf', 'false');
  const attributes = await readFile(join(repo, '.gitattributes')).catch(error => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  await writeFile(join(root, '.gitattributes'), attributes);
  const paths = ['LICENSE', ...new Set((await json(join(repo, 'scripts/release/notices/supplements.json')))
    .map(item => 'scripts/release/notices/' + item.file))];
  const originals = new Map();
  for (const path of paths) {
    const bytes = await readFile(join(repo, path)); originals.set(path, bytes);
    await mkdir(resolve(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await writeFile(join(root, 'ordinary.txt'), 'ordinary text\n');
  git('add', '--', '.gitattributes', 'ordinary.txt', ...paths);
  git('config', 'core.autocrlf', 'true');
  for (const path of [...paths, 'ordinary.txt']) await rm(join(root, path));
  git('checkout-index', '--all', '--force');
  assert.equal(await readFile(join(root, 'ordinary.txt'), 'utf8'), 'ordinary text\r\n', 'actual checkout conversion must be exercised');
  for (const path of paths) assert.deepEqual(await readFile(join(root, path)), originals.get(path), path);
});

test('CI release staging stays outside restored Cargo output and preserves stale cache contents', async t => {
  const root = await source(t);
  await stampVersion(root, 'refs/tags/occipital-v0.1.1');
  const stale = join(root, 'target/native-artifact');
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, 'old-release'), 'unchanged previous release');
  const runnerTemp = join(root, 'runner-temp'); await mkdir(runnerTemp);
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const argument = native.match(/node scripts\/release\/native-ci\.mjs stage "\$TARGET" "target\/\$RUST_TARGET\/release\/\$EXECUTABLE" ([^\n]+)/)?.[1].trim();
  assert.ok(argument);
  const external = argument.match(/^"\$RUNNER_TEMP\/([^"\n]+)"$/);
  if (!external) assert.equal(argument, 'target/native-artifact');
  const output = external ? join(runnerTemp, external[1]) : join(root, argument);
  const notice = join(root, 'NOTICE'), binary = join(root, 'tiny');
  await writeFile(notice, 'Inert fixture notice\n'); await writeFile(binary, 'new inert payload\n');
  await stageRelease({ root, output, input: { notice, artifacts: [{ target: 'linux-x64-gnu', path: binary,
    url: 'https://example.invalid/occipital-v0.1.1-linux-x64-gnu' }] } });
  assert.equal((await json(join(output, 'native-release.staged.json'))).version, '0.1.1');
  assert.deepEqual(await readFile(join(output, 'assets/occipital-v0.1.1-linux-x64-gnu')), await readFile(binary));
  assert.equal(await readFile(join(stale, 'old-release'), 'utf8'), 'unchanged previous release');
  assert.deepEqual(await readdir(stale), ['old-release']);
  assert.match(native, /path: \$\{\{ runner.temp \}\}\/occipital-native-artifact\//);
  await assert.rejects(stageRelease({ root, output, input: { notice, artifacts: [{ target: 'linux-x64-gnu', path: binary,
    url: 'https://example.invalid/occipital-v0.1.1-linux-x64-gnu' }] } }), { code: 'EEXIST' });
});

test('every executable workflow job has an explicit bounded timeout, including reusable workflows', async () => {
  const directory = join(repo, '.github/workflows');
  const files = (await readdir(directory)).filter(file => /\.ya?ml$/.test(file)).sort();
  const timeouts = {};
  for (const file of files) {
    const workflow = await readFile(join(directory, file), 'utf8');
    const section = workflow.match(/^jobs:\n([\s\S]*)/m)?.[1];
    assert.ok(section, `${file}: jobs declaration`);
    const jobs = [...section.matchAll(/^  ([\w-]+):\s*$/gm)];
    assert.ok(jobs.length, `${file}: executable or reusable jobs`);
    for (let i = 0; i < jobs.length; i++) {
      const id = jobs[i][1], body = section.slice(jobs[i].index, jobs[i + 1]?.index);
      const key = `${file}/${id}`;
      const caller = body.match(/^    uses: \.\/\.github\/workflows\/(\S+)$/m);
      if (caller) {
        assert.ok(files.includes(caller[1]), `${key}: referenced workflow is covered`);
        assert.doesNotMatch(body, /^    timeout-minutes:/m, `${key}: caller cannot define job timeout`);
        continue;
      }
      assert.match(body, /^    runs-on:/m, key);
      const timeout = body.match(/^    timeout-minutes: ([1-9]\d*)$/m)?.[1];
      assert.ok(timeout, `${key}: explicit positive integer timeout`);
      assert.ok(Number(timeout) <= 60, `${key}: no hours-long execution allowance`);
      timeouts[key] = Number(timeout);
    }
  }
  assert.deepEqual(timeouts, {
    'ci.yml/version': 5, 'ci.yml/extension': 10, 'ci.yml/terminal': 30,
    'occipital-release.yml/publish': 10, 'occipital.yml/packaging-fixtures': 5, 'occipital.yml/build': 45,
  });
  const ci = await readFile(join(directory, 'ci.yml'), 'utf8');
  assert.match(ci, /- name: Unit, actual-SDK and GC regressions\n        timeout-minutes: 5\n/);
});

test('CI reserves the full terminal suite for extension release refs and keeps syntax CLI in ordinary runs', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const terminal = ci.match(/^  terminal:\n([\s\S]*?)(?=^  \w[\w-]*:|$(?![\s\S]))/m)?.[1];
  assert.ok(terminal);
  assert.match(terminal, /^    needs: \[version, native\]$/m);
  const jobCondition = terminal.match(/^    if: ([^\n]+)$/m)?.[1];
  const full = terminal.match(/^      - name: Full physical CLI and replay \(extension release only\)\n        if: ([^\n]+)\n        run: npm run test:terminal$/m);
  assert.ok(full, 'full terminal step needs its own release guard, not a release-only job');
  assert.equal(full[1], "needs.version.outputs.product == 'pi-tidy-ui'");
  assert.equal([...ci.matchAll(/\brun: npm run test:terminal$/gm)].length, 1, 'no unguarded duplicate full-suite invocation');
  assert.match(terminal, /- name: Physical syntax CLI and replay using this commit's native artifact\n        env:\n          OCCIPITAL_TEST_BIN: [^\n]+\n        run: npm run test:syntax-terminal/);
  const enabled = (condition, ref) => {
    const match = condition?.match(/^needs\.version\.outputs\.product (==|!=) '([^']+)'$/);
    assert.ok(match, 'evaluate the actual workflow product comparison');
    const same = (releaseRef(ref).product ?? '') === match[2];
    return match[1] === '==' ? same : !same;
  };
  for (const [ref, syntax, complete] of [
    ['refs/heads/main', true, false],
    ['refs/heads/feature/ui', true, false],
    ['refs/heads/pi-tidy-ui-v0.2.0', true, false],
    ['refs/pull/1/merge', true, false],
    ['refs/tags/pi-tidy-ui-v0.2.0', true, true],
    ['refs/tags/pi-tidy-ui-v0.2.0-rc.1+build.2', true, true],
    ['refs/tags/occipital-v0.1.2', false, false],
  ]) {
    const job = enabled(jobCondition, ref);
    assert.equal(job, syntax, `${ref}: short syntax CLI eligibility`);
    assert.equal(job && enabled(full[1], ref), complete, `${ref}: full terminal eligibility`);
  }
});

test('CI retains the selected hidden-directory physical terminal failure captures', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const terminal = ci.match(/^  terminal:\n([\s\S]*?)(?=^  \w[\w-]*:|$(?![\s\S]))/m)?.[1];
  assert.ok(terminal);
  const upload = terminal.match(/^      - uses: actions\/upload-artifact@v4\n([\s\S]*)/m)?.[1];
  assert.ok(upload);
  assert.match(upload, /^        if: failure\(\)$/m);
  assert.match(upload, /^          path: \.test-artifacts\/terminal-\*\/$/m);
  assert.match(upload, /^          include-hidden-files: true$/m);
});

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
