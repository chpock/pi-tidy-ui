import './fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, readdir, chmod, lstat, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnv, readInputs, toolPath } from '../scripts/test/context.mjs';
import { selectSuite } from '../scripts/test/run.mjs';
import { nativeTargets } from '../scripts/test/ci-scope.mjs';
import { releaseRef, stampVersion } from '../scripts/release/version.mjs';
import { assembleRelease, assetName, artifactName } from '../scripts/release/native-ci.mjs';
import * as nativeCI from '../scripts/release/native-ci.mjs';
import { candidateTargets, daemonVersion, stageRelease } from '../scripts/release/native-release.mjs';
import { acquireNative } from '../src/occipital/native.ts';

const repo = resolve(import.meta.dirname, '..'), commit = 'a'.repeat(40), repository = 'chpock/pi-tidy-ui';
async function source(t) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-release-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'crates/occipital'), { recursive: true });
  await writeFile(join(root, 'crates/occipital/Cargo.toml'), '[package]\nname = "occipital"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nfixture = "0.0.0"\n');
  await writeFile(join(root, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "occipital"\nversion = "0.0.0"\ndependencies = ["fixture"]\n\n[[package]]\nname = "fixture"\nversion = "0.0.0"\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pi-tidy-ui', version: '0.0.0', optionalDependencies: { fixture: '0.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'pi-tidy-ui', version: '0.0.0', lockfileVersion: 3, packages: { '': { name: 'pi-tidy-ui', version: '0.0.0' }, 'node_modules/fixture': { version: '0.0.0' } } }));
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
  assert.deepEqual(await json(join(root, 'package.json')), { name: 'pi-tidy-ui', version: '0.2.0', optionalDependencies: { fixture: '0.0.0' } });
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
  const git = (...args) => execFileSync(toolPath('git'), ['-C', root, ...args], { env: childEnv(join(root, 'git-environment')), stdio: 'pipe' });
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
  const external = native.match(/const output = join\(process.env.RUNNER_TEMP,'([^']+)'\)/)?.[1];
  assert.ok(external, 'staging directory must be external to restored compiler outputs');
  const output = join(runnerTemp, external);
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
    'ci.yml/version': 5, 'ci.yml/scope': 5, 'ci.yml/scope-decision': 5, 'ci.yml/baseline': 10, 'ci.yml/affected': 30,
    'ci.yml/extension': 10, 'ci.yml/terminal': 30, 'ci.yml/extension-package': 15,
    'occipital-npm-publish.yml/publish': 15, 'occipital-release.yml/publish': 10,
    'occipital.yml/targets': 5, 'occipital.yml/packaging-fixtures': 5, 'occipital.yml/build': 60,
  });
  const ci = await readFile(join(directory, 'ci.yml'), 'utf8');
  assert.match(ci, /- name: Unit, actual-SDK and GC regressions\n        timeout-minutes: 5\n/);
});

test('full compatibility owns the full terminal union; ordinary acceptance consumes affected scope', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const terminal = workflowJob(ci, 'terminal'), baseline = workflowJob(ci, 'baseline'), affected = workflowJob(ci, 'affected');
  assert.match(terminal, /^    if: needs.scope.outputs.full == 'true' && needs.version.outputs.product != 'occipital'$/m);
  assert.match(terminal, /--suite terminal --network-isolated/);
  assert.match(terminal, /--suite syntax-terminal --network-isolated/);
  assert.match(baseline, /^    needs: \[version, scope\]$/m, 'ordinary common checks cannot wait on native platforms');
  assert.match(baseline, /feature\.mjs .*--features "\$FEATURES"/);
  assert.match(baseline, /FEATURES:.*baselineFeatures/);
  assert.match(affected, /needs.scope.outputs.status == 'ready'/);
  assert.match(affected, /--features "\$FEATURES" --affected-only/);
  assert.match(affected, /CHECK_TYPES: \$\{\{ matrix\.pi != '1\.0\.0' && needs\.version\.outputs\.product != 'occipital' \}\}/);
  assert.match(affected, /if \[\[ "\$CHECK_TYPES" == true \]\]; then args\+=\(--check-types\); fi/);
  assert.match(affected, /--affected-only "\$\{args\[@\]\}"/);
  assert.match(affected, /matrix: \$\{\{ fromJSON\(needs.scope.outputs.profiles\) \}\}/);
});

test('CI retains the selected hidden-directory physical terminal failure captures', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const terminal = ci.match(/^  terminal:\n([\s\S]*?)(?=^  \w[\w-]*:|$(?![\s\S]))/m)?.[1];
  assert.ok(terminal);
  const upload = terminal.match(/^      - uses: actions\/upload-artifact@v4\n([\s\S]*)/m)?.[1];
  assert.ok(upload);
  assert.match(upload, /^        if: failure\(\)$/m);
  assert.match(upload, /^          path: \$\{\{ runner.temp \}\}\/terminal-captures\/terminal-\*\/$/m);
  assert.match(upload, /^          include-hidden-files: true$/m);
});

test('Windows builds statically link CRT for both targets and inspect the actual executable before staging', async () => {
  const config = await readFile(join(repo, '.cargo/config.toml'), 'utf8');
  const entries = [...config.matchAll(/^\[target\.([^\]]+)\]\nrustflags = (\[[^\n]+\])$/gm)];
  const targets = entries.map(match => match[1]);
  for (const entry of entries) assert.deepEqual(JSON.parse(entry[2]).slice(0, 2), ['-C', 'target-feature=+crt-static']);
  assert.deepEqual(targets.sort(), ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']);
  assert.equal([...config.matchAll(/^\[/gm)].length, 2, 'no flags for unrelated targets or host-wide build override');
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  assert.match(workflow, /- name: Install Windows executable inspection tool\n        if: startsWith\(matrix.target, 'windows-'\)\n        run: rustup component add llvm-tools-preview/);
  for (const command of ["['test','--workspace','--locked','--offline','--target',target]", "['clippy','--workspace','--all-targets','--locked','--offline','--target',target", "['build','--release','--locked','--offline','-p','occipital','--target',target]"]) {
    assert.ok(workflow.includes(command), 'explicit target flags must not become global RUSTFLAGS affecting proc macros');
  }
  const script = await readFile(join(repo, 'scripts/release/native-ci.mjs'), 'utf8');
  assert.match(script, /candidateTargets\[target\]\.os === 'win32'\) await verifyWindowsRuntime\(binary\)/);
  assert.ok(script.indexOf('await verifyWindowsRuntime(binary)') < script.indexOf('await stageRelease('));
});

test('Windows native builds request deterministic PE timestamps and CodeView identity without byte normalization', async () => {
  const config = await readFile(join(repo, '.cargo/config.toml'), 'utf8');
  const entries = [...config.matchAll(/^\[target\.([^\]]+)\]\nrustflags = (\[[^\n]+\])$/gm)];
  assert.deepEqual(entries.map(entry => entry[1]), ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']);
  for (const entry of entries) assert.deepEqual(JSON.parse(entry[2]), ['-C', 'target-feature=+crt-static', '-C', 'link-arg=/Brepro']);
});

test('Windows executable import guard rejects VC runtime variants and refuses empty inspection output', () => {
  assert.equal(typeof nativeCI.windowsRuntimeImports, 'function');
  const inspect = nativeCI.windowsRuntimeImports;
  const system = 'Import {\n  Name: KERNEL32.dll\n}\nImport {\n  Name: api-ms-win-core-synch-l1-2-0.dll\n}\n';
  assert.deepEqual(inspect(system), ['KERNEL32.dll', 'api-ms-win-core-synch-l1-2-0.dll']);
  for (const dll of ['VCRUNTIME140.dll', 'vcruntime140_1.dll', 'MSVCP140.dll', 'MSVCP140_ATOMIC_WAIT.dll', 'msvcr120.dll', 'CONCRT140.dll', 'ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']) {
    assert.throws(() => inspect(system + `DelayImport {\r\n  Name: ${dll}\r\n}\r\n`), /runtime DLL/i, dll);
  }
  for (const output of ['', 'File: example.exe\nFormat: COFF-ARM64\n', 'Import {}\n']) assert.throws(() => inspect(output), /imports/i);
});

test('Windows executable inspection uses Rust host tools, checks real command output and propagates failure', async () => {
  const calls = [], host = 'aarch64-pc-windows-msvc', sysroot = join(repo, 'inert-rust-root'), binary = 'inert spaced.exe';
  const tool = join(sysroot, 'lib/rustlib', host, 'bin', `llvm-readobj${process.platform === 'win32' ? '.exe' : ''}`);
  const execute = async (command, args, options) => {
    calls.push([command, args]);
    assert.equal(options.timeout, 30000);
    if (command === 'rustc') return { stdout: args[0] === '--print' ? `${sysroot}\r\n` : `rustc fixture\r\nhost: ${host}\r\n` };
    assert.equal(command, tool); assert.deepEqual(args, ['--coff-imports', binary]);
    return { stdout: 'Import {\n  Name: KERNEL32.dll\n}\nImport {\n  Name: VCRUNTIME140.dll\n}\n' };
  };
  await assert.rejects(nativeCI.verifyWindowsRuntime(binary, execute), /runtime DLL: VCRUNTIME140\.dll/);
  assert.deepEqual(calls, [['rustc', ['--print', 'sysroot']], ['rustc', ['-vV']], [tool, ['--coff-imports', binary]]]);
  const failed = new Error('LLVM inspection failed');
  await assert.rejects(nativeCI.verifyWindowsRuntime(binary, async (command, args) => {
    if (command === 'rustc') return { stdout: args[0] === '--print' ? sysroot : `host: ${host}` };
    throw failed;
  }), error => error === failed);
});

test('CI routes both tag families, reuses the same-run native matrix, and publishes only Occipital', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const release = await readFile(join(repo, '.github/workflows/occipital-release.yml'), 'utf8');
  assert.match(ci, /tags: \['pi-tidy-ui-v\*', 'occipital-v\*'\]/);
  assert.match(ci, /uses: \.\/\.github\/workflows\/occipital\.yml/);
  assert.match(ci, /release-occipital:[\s\S]*needs: \[version, native, affected\][\s\S]*refs\/tags\/occipital-v[\s\S]*uses: \.\/\.github\/workflows\/occipital-release\.yml/);
  assert.deepEqual(nativeTargets().map(value => value.target).sort(), Object.keys(candidateTargets).sort());
  assert.match(native, /fromJSON\(needs.targets.outputs.matrix\)/);
  assert.match(native, /Stamp daemon before compilation[\s\S]*\['build','--release','--locked','--offline'/);
  assert.match(release, /actions\/download-artifact@v4/);
  assert.doesNotMatch(release, /run-id:|cargo build|npm publish/);
  assert.match(release, /assemble native-artifacts/);
  assert.match(release, /sha256sum --check SHA256SUMS/);
});

test('GNU executable version-needs guard enforces glibc2.28 and distinguishes optional weak versions', () => {
  assert.equal(typeof nativeCI.linuxRuntimeVersions, 'function');
  const inspect = nativeCI.linuxRuntimeVersions;
  const entry = (name, flags = 'none') => `  0x0010:   Name: ${name}  Flags: ${flags}  Version: 2\n`;
  const allowed = entry('GLIBC_2.2.5') + entry('GLIBC_2.17') + entry('GLIBC_2.28');
  assert.deepEqual(inspect(allowed + entry('GLIBC_2.39', 'WEAK')), ['2.2.5', '2.17', '2.28']);
  for (const name of ['GLIBC_2.29', 'GLIBC_2.34', 'GLIBC_3.0', 'GLIBC_ABI_DT_RELR', 'GLIBC_PRIVATE']) {
    assert.throws(() => inspect(allowed + entry(name)), /glibc.*2\.28/i, name);
  }
  for (const output of ['', 'File: example.elf\n', '  004: 2 (GLIBC_2.28)\n', entry('GLIBC_2.28', 'WEAK')]) assert.throws(() => inspect(output), /requirements/i);
});

test('GNU executable inspection reads actual version needs before staging and propagates command failures', async () => {
  assert.equal(typeof nativeCI.verifyLinuxRuntime, 'function');
  const binary = 'inert spaced.elf', calls = [];
  await assert.rejects(nativeCI.verifyLinuxRuntime(binary, async (command, args, options) => {
    calls.push([command, args]);
    assert.equal(options.timeout, 30000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.LC_ALL, 'C');
    return { stdout: '  0x0010:   Name: GLIBC_2.34  Flags: none  Version: 2\n' };
  }), /glibc.*2\.28/i);
  assert.deepEqual(calls, [['readelf', ['--wide', '--version-info', binary]]]);
  const failure = new Error('ELF inspection failed');
  await assert.rejects(nativeCI.verifyLinuxRuntime(binary, async () => { throw failure; }), error => error === failure);
  const source = await readFile(join(repo, 'scripts/release/native-ci.mjs'), 'utf8');
  assert.match(source, /candidateTargets\[target\]\.os === 'linux'\) await verifyLinuxRuntime\(binary\)/);
  assert.ok(source.indexOf('await verifyLinuxRuntime(binary)') < source.indexOf('await stageRelease('));
});

// Actual GNU wrapper/Make invocation, ordering, isolation and failure controls live in makefile.test.ts.

test('installed npm preparation has five-minute headroom without changing native deadlines or output limits', async () => {
  const preparation = await readFile(join(repo, 'tests/fixtures/npm-preparation.ts'), 'utf8');
  assert.match(preparation, /timeout: 300000, maxBuffer: 1024 \* 1024/);
  const fixture = await readFile(join(repo, 'tests/fixtures/published-occipital.mjs'), 'utf8');
  assert.match(fixture, /Installed source did not complete[\s\S]*\}, 10000\)/);
  assert.match(fixture, /timeout: 5000/);
  assert.match(fixture, /nativeDispatches: complete\.dispatches/);
});

test('GNU tooling-image cache is recipe/platform scoped and leaves full native checks intact', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  assert.match(workflow, /id: gnu-image-cache\n        if: startsWith\(matrix.target, 'linux-'\)\n        uses: actions\/cache@v4/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/occipital-gnu-image.tar/);
  assert.match(workflow, /key: gnu-tooling-v1-\$\{\{ matrix.target \}\}-\$\{\{ hashFiles\('scripts\/release\/Dockerfile.linux-gnu'\) \}\}/);
  assert.match(workflow, /if: \$\{\{ startsWith\(matrix.target, 'linux-'\) && steps.gnu-image-cache.outputs.cache-hit == 'true' \}\}/);
  assert.match(workflow, /docker load --input "\$IMAGE_ARCHIVE"/);
  assert.match(workflow, /docker save --output "\$IMAGE_ARCHIVE" "occipital-gnu228-\$IMAGE_ARCH"/);
  assert.ok(workflow.indexOf('docker load --input') < workflow.indexOf('- name: GNU glibc 2.28 native build and runtime checks'));
  for (const name of ['linux-gnu.sh', 'installed-linux-gnu.sh']) {
    const helper = await readFile(join(repo, 'scripts/release', name), 'utf8');
    assert.match(helper, /cache_args=\(--build-arg BUILDKIT_INLINE_CACHE=1\)/);
    assert.match(helper, /if docker image inspect "\$image" >\/dev\/null 2>&1; then/);
    assert.match(helper, /cache_args\+=\(--cache-from "\$image"\)/);
    assert.match(helper, /docker build "\$\{cache_args\[@\]\}" --platform "linux\/\$docker_arch"/);
    assert.match(helper, /test "\$\(getconf GNU_LIBC_VERSION\)" = "glibc 2.28"/);
  }
});

test('extension release tags admit all-six current/public/npm bytes before packing generated native pins; branches and daemon tags do not', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const publication = workflow.slice(workflow.indexOf('\n  extension-package:'));
  assert.ok(workflow.includes('\n  extension-package:'), 'a release-only preparation gate is required');
  assert.match(publication, /needs: \[version, native, extension, terminal\]/);
  assert.match(publication, /if: needs\.version\.outputs\.product == 'pi-tidy-ui'/);
  assert.match(publication, /fetch-depth: 0/);
  assert.match(publication, /pattern: occipital-v\$\{\{ needs\.version\.outputs\.daemon_version \}\}-\*/);
  assert.match(publication, /gh api .*releases\/tags\/\$DAEMON_TAG/);
  assert.match(publication, /gh release download "\$DAEMON_TAG"/);
  assert.match(publication, /node scripts\/release\/extension-release\.mjs "\$RELEASE_REF"/);
  assert.ok(publication.indexOf('extension-release.mjs') < publication.indexOf('npm pack'));
  assert.match(publication, /npm pack .*\/extension --ignore-scripts/);
  assert.doesNotMatch(publication, /npm publish|contents: write|id-token: write/);
  const sourcePack = workflow.slice(workflow.indexOf('\n  extension:'), workflow.indexOf('\n  terminal:'));
  assert.match(sourcePack, /Pack development extension without publishing\n\s+if: needs\.version\.outputs\.product != 'pi-tidy-ui'/);
  assert.doesNotMatch(sourcePack, /version\.mjs "\$RELEASE_REF"/);
  const manifest = await json(join(repo, 'package.json')), lock = await json(join(repo, 'package-lock.json'));
  assert.equal(manifest.version, '0.0.0');
  assert.equal(Object.keys(manifest.optionalDependencies).some(name => name.startsWith('@kchpock/occipital-')), false);
  assert.equal(Object.keys(lock.packages).some(name => name.startsWith('node_modules/@kchpock/occipital-')), false);
});

function workflowJob(source, name) {
  const section = source.split(`\n  ${name}:\n`)[1];
  assert.ok(section, `${name} job required`);
  return section.split(/\n  [\w-]+:\n/)[0];
}
function workflowStep(source, name) {
  const section = source.split(`      - name: ${name}\n`)[1];
  assert.ok(section, `${name} step required`);
  return section.split('\n      - ')[0];
}

test('full native CI retains same-commit consumers on six targets and both Nodes, including daemon tags', async () => {
  const source = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8'), build = workflowJob(source, 'build');
  assert.match(build, /^    runs-on: \$\{\{ matrix.runner \}\}$/m);
  const targets = source.match(/^      targets:\n((?:        .*\n)+)/m)[1];
  assert.match(targets, /^        type: string$/m);
  assert.match(targets, /^        default: all$/m);
  assert.match(source, /      consumers:\n        type: boolean\n        default: true/);
  assert.deepEqual(nativeTargets().map(value => value.target).sort(), Object.keys(candidateTargets).sort());
  assert.match(build, /fromJSON\(needs.targets.outputs.matrix\)/);
  for (const version of ['22.19.0', '26.7.0']) {
    const step = workflowStep(build, `Same-commit clean consumer and actual helper on Node ${version}`);
    assert.match(step, /^        if: inputs.consumers \|\| startsWith\(inputs.release-ref, 'refs\/tags\/'\)$/m, 'host-only can omit consumers but release callers cannot');
    assert.match(step, /--archives --native-artifact "\$ARTIFACT"/);
    assert.match(step, /--suite native --files occipital-native.test.ts/);
    assert.match(step, /--suite consumer/);
    assert.match(step, /installed-linux-gnu.sh "\$RUST_TARGET" native "\$PREPARATION" "\$ARTIFACT"/);
    assert.match(step, /installed-linux-gnu.sh "\$RUST_TARGET" consumer "\$PREPARATION" "\$ARTIFACT"/);
    assert.ok(step.indexOf(' native "') < step.indexOf(' consumer "'), 'GNU same-artifact native smoke precedes consumer');
    assert.doesNotMatch(step, /published-consumer|published-occipital|npm run test:installed-native|npm_config_cache/);
  }
  assert.match(build, /Verify original source identity after neutral staging/);
  assert.ok(build.indexOf('await stageCI(') < build.indexOf('Verify original source identity'));
  assert.ok(build.indexOf('Verify original source identity') < build.indexOf('Same-commit clean consumer'));
  assert.doesNotMatch(build, /git restore --/, 'stamping must not modify the authoritative checkout');
});

test('published consumer routing is positive only for extension tags and negative for main, PR, daemon and compatibility refs', async () => {
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const steps = ['22.19.0', '26.7.0'].map(version => workflowStep(native, `Published delivery on Node ${version} (pi-tidy-ui release only)`));
  for (const step of steps) {
    assert.match(step, /^        if: startsWith\(inputs.release-ref, 'refs\/tags\/pi-tidy-ui-v'\)$/m);
    assert.match(step, /--suite published-consumer --release-ref "\$RELEASE_REF"/);
    assert.match(step, /installed-linux-gnu.sh "\$RUST_TARGET" published-consumer .* "\$RELEASE_REF"/);
  }
  for (const [ref, enabled] of [['refs/heads/main',false], ['refs/pull/1/merge',false], ['refs/heads/daily-compatibility',false], ['refs/tags/occipital-v0.1.5',false], ['refs/tags/pi-tidy-ui-v0.2.0',true]]) {
    for (const step of steps) {
      const prefix = step.match(/^        if: startsWith\(inputs.release-ref, '([^']+)'\)$/m)[1];
      assert.equal(ref.startsWith(prefix), enabled, ref);
    }
  }
  assert.equal((native.match(/--suite published-consumer/g) ?? []).length, 2, 'no ordinary duplicate public verifier');
  assert.doesNotMatch(await readFile(join(repo, 'Makefile'), 'utf8'), /test-installed:[\s\S]*?--suite published-consumer(?=[\s\S]*test-published:)/);
});

test('CI uses coherent prepared descriptors, catalogue capabilities and current-source native artifacts', async () => {
  const source = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  for (const name of ['extension', 'terminal']) {
    const job = workflowJob(source, name);
    assert.match(job, /needs: \[version, native, scope\]/);
    assert.match(job, /node: \['22.19.0', '26.7.0'\]/);
    assert.match(job, /pi: \['1.0.0', '1.2.0'\]/);
    assert.match(job, /prepare.mjs --pi-version "\$PI_VERSION"/);
    assert.match(job, /--native-artifact "\$GITHUB_WORKSPACE\/\.test-artifacts\/ci-native"/);
    assert.doesNotMatch(job, /node --(?:expose-gc|test)|OCCIPITAL_TEST_BIN|PI_TEST_CLI/);
  }
  const scope = workflowJob(source,'scope'), native = workflowJob(source,'native');
  assert.match(scope,/pull_request.base.sha \|\| github.sha/);
  assert.match(scope,/persist-credentials: false/);
  assert.match(scope,/githubScope\(/);
  assert.match(scope,/featurePlan/);
  assert.doesNotMatch(source,/pull_request_target|secrets\./);
  assert.match(native,/source-ref: \$\{\{ needs.scope.outputs.head \}\}/);
  assert.match(native,/targets: \$\{\{ fromJSON\(needs.scope.outputs.scope\).platforms \}\}/);
  assert.match(native,/consumers: \$\{\{ fromJSON\(needs.scope.outputs.scope\).consumers \}\}/);
  const affected = workflowJob(source,'affected');
  for (const capability of ['native','shared','integration']) assert.ok(affected.includes(`scope.capabilities.${capability}`));
  const extension = workflowJob(source,'extension'), terminal = workflowJob(source,'terminal');
  assert.equal(selectSuite(readInputs(), 'unit').includes('integration-profile.test.mjs'), true);
  for (const suite of ['check','unit','native-release']) assert.match(extension, new RegExp(`--suite ${suite} --network-isolated`));
  assert.match(terminal, /--integration/); assert.match(terminal, /--shared-host "\$RUNNER_TEMP\/shared-host\/ck-subc"/);
});

test('native execution has owned Cargo configuration and mandatory offline pinned toolchain without inherited build environment', async () => {
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const declaration = 'Declare pinned compiler and hosted setup Cargo artifact store';
  assert.ok(native.indexOf(declaration) < native.indexOf('Fetch locked native dependencies with owned config'), 'store admission must precede Cargo');
  const cache = native.match(/- uses: actions\/cache@v4\n        if: \$\{\{ !inputs.clean-build \}\}\n        with:\n          path: \|\n([\s\S]*?)          key:/)?.[1];
  assert.ok(cache, 'native artifact cache must be scoped');
  assert.deepEqual(cache.trim().split('\n').map(line => line.trim()), ['${{ env.CARGO_HOME }}/registry', '${{ env.CARGO_HOME }}/git', 'target']);
  assert.match(native, /RUSTUP_AUTO_INSTALL: '0'/);
  assert.match(native, /toolchain: \$\{\{ steps.toolchain.outputs.version \}\}/);
  const execution = workflowStep(native, 'Offline native correctness, strict lint and release build');
  assert.match(execution, /childEnv\(join\(inputs.runRoot,'native-runtime'\)/); assert.match(execution, /CARGO_NET_OFFLINE:'true'/);
  assert.match(execution, /cwd:process.env.NATIVE_SOURCE/);
  assert.doesNotMatch(execution, /\.\.\.process.env/);
  for (const command of ['test','clippy','build']) assert.match(execution, new RegExp(`\\['${command}'[^\\n]*'--offline'`));
  assert.match(execution, /if\(result.status!==0\) process.exit\(result.status \?\? 1\)/);
  const script = await readFile(join(repo, 'scripts/release/linux-gnu.sh'), 'utf8');
  assert.match(script, /RUST_ROOT:\?Supply the absolute pinned Rust sysroot/);
  assert.match(script, /CARGO_HOME:\?Supply an explicit owned Cargo artifact home/);
  assert.match(script, /--network=none/);
  assert.doesNotMatch(script, /\$HOME\/\.cargo|rustup default|rustup toolchain install/);
});

test('consumer diagnostics contain only the scoped safe reports, never raw cache logs or config', async () => {
  const source = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const step = workflowStep(source, 'Safe consumer preparation diagnostics');
  assert.match(step, /if: always\(\)/); assert.match(step, /include-hidden-files: true/);
  assert.match(step, /diagnostics\/installed-preparation-\*\//);
  assert.doesNotMatch(step, /_logs|environment\/|cache\/|\.npmrc|inputs.json/);
});

test('actual same-commit CI commands preserve artifact selection, native-before-consumer order and fail-fast behavior on both Nodes', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy ci command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), log = join(root, 'commands.jsonl'); await mkdir(bin);
  const stub = `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='-p') {console.log(process.execPath);process.exit(0);}
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes(process.env.FAIL_SUITE)) process.exit(17);
`;
  await writeFile(join(bin, 'node'), stub, { mode: 0o755 });
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  for (const version of ['22.19.0','26.7.0']) {
    const step = workflowStep(workflow, `Same-commit clean consumer and actual helper on Node ${version}`);
    const script = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    for (const TARGET of ['darwin-x64', 'windows-x64-msvc', 'windows-arm64-msvc']) {
      for (const FAIL_SUITE of ['', 'rust-harness', 'native', 'consumer']) {
        await rm(log, { force: true });
        const env = childEnv(join(root,'environment'), {PATH:bin + ':' + inputs.tools.bin, RUNNER_TEMP:root, TARGET, FAIL_SUITE, RUST_ROOT:join(root,'pinned-rust'), CARGO_HOME:join(root,'owned-cargo')});
        const result = (() => { try { execFileSync(toolPath('bash'), ['-e','-o','pipefail','-c',script], {env,cwd:root,stdio:'pipe'}); return 0; } catch(error) { return error.status; } })();
        const calls = (await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
        assert.equal(result, FAIL_SUITE ? 17 : 0, `${version}/${TARGET}/${FAIL_SUITE}`);
        assert.equal(calls[0][0], 'scripts/test/prepare.mjs');
        assert.equal(calls[0][calls[0].indexOf('--native-artifact')+1], join(root,'occipital-native-artifact'));
        assert.equal(calls[0].includes('--tools'), TARGET.startsWith('windows-'));
        assert.equal(calls[0].includes('--run-root'), TARGET.startsWith('windows-'));
        if (TARGET.startsWith('windows-')) assert.equal(calls[0][calls[0].indexOf('--run-root')+1], root, 'consumer execution must use explicit runner storage, not the system temporary default');
        assert.equal(calls[0][calls[0].indexOf('--rust-root')+1], join(root,'pinned-rust'));
        assert.equal(calls[0][calls[0].indexOf('--cargo-cache')+1], join(root,'owned-cargo'));
        assert.equal(calls[0].includes('--rust-environment'), TARGET.startsWith('windows-'));
        assert.deepEqual(calls.slice(1).map(args=>args[args.indexOf('--suite')+1]), FAIL_SUITE === 'rust-harness' ? ['rust-harness'] : FAIL_SUITE === 'native' ? ['rust-harness','native'] : ['rust-harness','native','consumer']);
        for (const args of calls.slice(1)) assert.equal(args[args.indexOf('--inputs')+1], join(root,`consumer-${version}/inputs.json`));
      }
    }
  }
  await rm(log,{force:true}); await writeFile(join(root,'runtime-tools.json'),'{}');
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(workflow,'Prepare neutral native source snapshot'))],{
    cwd:root,env:childEnv(join(root,'native-environment'),{PATH:bin+':'+inputs.tools.bin,RUNNER_TEMP:root,RUST_ROOT:join(root,'pinned-rust'),CARGO_HOME:join(root,'owned-cargo')},inputs),stdio:'pipe',
  });
  const nativeCalls = (await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row)).filter(args=>args[0]==='scripts/test/prepare.mjs');
  assert.equal(nativeCalls.length,1); assert.equal(nativeCalls[0].includes('--tools'),true);
  assert.equal(nativeCalls[0].includes('--run-root'),false,'consumer storage policy must not relocate native compilation');
});

function shellStep(step) {
  return step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
}

test('actual CI setup store admission preserves declared Cargo paths and refuses unsafe state before child launch', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-cargo-store-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const profile = join(root,'setup-home'), temp = join(root,'runner-temp'), rust = join(root,'rust'), log = join(root,'children.jsonl'), receipt = join(root,'github-env');
  const store = join(profile,'.cargo'), temporaryStore = join(temp,'setup-cargo'), outside = join(root,'unowned-store');
  for (const path of [store,temporaryStore,outside,join(rust,'bin'),join(temp,'native-build-inputs'),join(temp,'neutral/source')]) await mkdir(path,{recursive:true});
  await writeFile(join(temp,'native-build-inputs/inputs.json'),JSON.stringify({...inputs,runRoot:join(temp,'neutral')}));
  await writeFile(join(rust,'bin/rustc'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'rustc',args:process.argv.slice(2)})+'\\n');\nconsole.log(${JSON.stringify(rust)});\n`,{mode:0o755});
  await writeFile(join(rust,'bin/cargo'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'cargo',args:process.argv.slice(2),home:process.env.CARGO_HOME,toolchain:process.env.RUSTUP_TOOLCHAIN})+'\\n');\n`,{mode:0o755});
  // Observe prohibited config/credential reads/removal, not just final bytes: inspect metadata only.
  const monitor = join(root,'config-monitor.mjs'), forbidden = join(root,'config-accesses');
  await writeFile(monitor, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nfor (const name of ['readFileSync','unlinkSync','rmSync','rmdirSync']) {\n const original=fs[name]; fs[name]=function(path,...args) {\n  if (/[/\\\\](?:config|credentials)(?:\\.toml)?$/.test(String(path))) {fs.appendFileSync(${JSON.stringify(forbidden)},name+'\\n');throw new Error('Unexpected config access');}\n  return original.call(this,path,...args);\n };\n}\nsyncBuiltinESMExports();\n`);
  const workflow = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const declaration = shellStep(workflowStep(workflow,'Declare pinned compiler and hosted setup Cargo artifact store'));
  const fetch = shellStep(workflowStep(workflow,'Fetch locked native dependencies with owned config'));
  const base = childEnv(join(root,'caller'),{HOME:profile,USERPROFILE:profile,RUNNER_TEMP:temp,GITHUB_ENV:receipt,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',CARGO_HOME:store,PATH:join(rust,'bin') + ':' + inputs.tools.bin,NODE_OPTIONS:`--import=${pathToFileURL(monitor).href}`,RUSTUP_TOOLCHAIN:'ambient-toolchain-poison'},inputs);
  const run = async (extra = {}) => {
    await rm(log,{force:true}); await writeFile(receipt,'');
    return spawnSync(toolPath('bash'),['-e','-o','pipefail','-c',declaration],{cwd:repo,env:{...base,...extra},encoding:'utf8',timeout:10000});
  };
  const reject = async (extra = {}) => {
    const result = await run(extra);
    assert.equal(result.error,undefined); assert.notEqual(result.status,0); assert.match(result.stderr,/Error:/);
    assert.equal(await readFile(receipt,'utf8'),'');
    await assert.rejects(lstat(log),{code:'ENOENT'});
    await assert.rejects(lstat(forbidden),{code:'ENOENT'});
  };
  for (const CARGO_HOME of [store,temporaryStore]) {
    const result = await run({CARGO_HOME}); assert.equal(result.status,0,result.stderr);
    const declared = Object.fromEntries((await readFile(receipt,'utf8')).trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
    assert.equal(declared.CARGO_HOME,CARGO_HOME,'retain the exact setup path, not a relocated cache');
    assert.equal(declared.RUST_ROOT,rust); assert.equal(declared.NODE,process.execPath);
    execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',fetch],{cwd:repo,env:{...base,...declared,NATIVE_SOURCE:join(temp,'neutral/source'),CARGO_TARGET_DIR:join(temp,'target')},stdio:'pipe'});
    assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row)),[{tool:'rustc',args:['--print','sysroot']},{tool:'cargo',args:['fetch','--locked'],home:CARGO_HOME,toolchain:rust}]);
  }
  for (const extra of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{CARGO_HOME:''},{CARGO_HOME:'relative-cargo'},{CARGO_HOME:outside},{CARGO_HOME:temp},{CARGO_HOME:store + '\nPOISON=1'}]) await reject(extra);
  for (const name of ['config.toml','config','credentials.toml','credentials']) {
    const config = join(store,name), bytes = 'private state must not be read or deleted';
    await writeFile(config,bytes); await chmod(config,0o000);
    await reject(); assert.equal((await lstat(config)).mode & 0o777,0);
    await chmod(config,0o600); assert.equal(await readFile(config,'utf8'),bytes); await rm(config);
    const target = join(root,'absent-config-target'); await symlink(target,config);
    await reject(); assert.equal(await readlink(config),target); await rm(config);
    await mkdir(config); await reject(); assert.ok((await lstat(config)).isDirectory()); await rm(config,{recursive:true});
  }
  await chmod(store,0o777); await reject(); await chmod(store,0o700);
  const alias = join(temp,'aliased-store'); await symlink(store,alias); await reject({CARGO_HOME:alias}); assert.equal(await readlink(alias),store);
  const ancestor = join(temp,'aliased-parent'); await symlink(profile,ancestor); await reject({CARGO_HOME:join(ancestor,'.cargo')});
  // POSIX ownership is real filesystem metadata, not the declared path alone.
  if ((await lstat('/usr')).uid !== process.getuid()) await reject({HOME:'/usr',CARGO_HOME:'/usr/.cargo'});
  else if (process.getuid() === 0) {
    const {chown} = await import('node:fs/promises');
    await chown(store,1,1); await reject(); await chown(store,0,0);
  }
});

test('actual direct CI Cargo gates use the neutral source and neutral fixture root, never checkout ancestors', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-direct-ci-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const neutral = join(root,'neutral'), source = join(neutral,'source'), rust = join(root,'rust'), log = join(root,'cargo.jsonl');
  for (const path of [source,join(rust,'bin'),join(root,'native-environment'),join(root,'native-build-inputs')]) await mkdir(path,{recursive:true});
  await writeFile(join(root,'native-build-inputs/inputs.json'),JSON.stringify({...inputs,runRoot:neutral}));
  await writeFile(join(rust,'bin/cargo'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,tmp:process.env.TIDY_TEST_ROOT,offline:process.env.CARGO_NET_OFFLINE,ambient:process.env.AMBIENT_POISON,toolchain:process.env.RUSTUP_TOOLCHAIN})+'\\n');\n`,{mode:0o755});
  const workflow = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const env = childEnv(join(root,'caller'),{RUNNER_TEMP:root,RUST_ROOT:rust,NATIVE_SOURCE:source,CARGO_HOME:join(root,'owned-cargo'),CARGO_TARGET_DIR:join(root,'target'),RUST_TARGET:'fixture-target',AMBIENT_POISON:'not-native',RUSTUP_TOOLCHAIN:'ambient-toolchain-poison'},inputs);
  for (const name of ['Fetch locked native dependencies with owned config','Offline native correctness, strict lint and release build']) {
    execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(workflow,name))],{cwd:repo,env,stdio:'pipe'});
  }
  const calls = (await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
  assert.deepEqual(calls.map(call=>call.args[0]),['fetch','fmt','test','clippy','build']);
  for (const call of calls) {
    assert.equal(call.cwd,source); assert.ok(call.home.startsWith(neutral + '/')); assert.ok(call.tmp.startsWith(neutral + '/')); assert.equal(call.ambient,undefined); assert.equal(call.toolchain,rust,'Cargo-home proxies must select the absolute pinned compiler root');
    if (call.args[0] !== 'fetch') assert.equal(call.offline,'true');
  }
});

test('actual CI version stamp changes only the neutral native snapshot, leaving source authority untouched', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await source(t), neutral = join(root,'neutral');
  await mkdir(join(neutral,'crates/occipital'),{recursive:true});
  for (const name of ['Cargo.lock','crates/occipital/Cargo.toml']) await cp(join(root,name),join(neutral,name));
  const before = await readFile(join(root,'Cargo.lock')), manifest = await readFile(join(root,'crates/occipital/Cargo.toml'));
  const workflow = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const script = workflowStep(workflow,'Stamp daemon before compilation').match(/^        run: (.*)$/m)[1];
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',script],{cwd:repo,env:childEnv(join(root,'caller'),{NATIVE_SOURCE:neutral,DAEMON_VERSION:'0.1.5'},inputs),stdio:'pipe'});
  assert.deepEqual(await readFile(join(root,'Cargo.lock')),before); assert.deepEqual(await readFile(join(root,'crates/occipital/Cargo.toml')),manifest);
  assert.equal(await daemonVersion(neutral),'0.1.5');
});

test('actual CI diagnostics retention follows neutral descriptors and excludes raw npm logs and input receipts', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-captures-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const neutral = join(root,'neutral'), source = join(root,'source'), reports = join(source,'.test-artifacts'), safe = 'installed-preparation-safe';
  await mkdir(join(reports,safe),{recursive:true});
  for (const file of ['fixture.json','npm.json','raw-debug-0.log','inputs.json']) await writeFile(join(reports,safe,file),'{}');
  await mkdir(join(root,'consumer-22.19.0')); await writeFile(join(root,'consumer-22.19.0/inputs.json'),JSON.stringify({pi:{root:neutral},source:{root:source}}));
  const native = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const env = childEnv(join(root,'caller'),{RUNNER_TEMP:root},inputs);
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(native,'Retain only safe consumer diagnostics from neutral sources'))],{cwd:repo,env,stdio:'pipe'});
  assert.deepEqual((await readdir(join(root,'consumer-22.19.0/diagnostics',safe))).sort(),['fixture.json','npm.json']);
  await mkdir(join(root,'terminal-inputs')); await writeFile(join(root,'terminal-inputs/inputs.json'),JSON.stringify({pi:{root:source}}));
  await mkdir(join(reports,'terminal-syntax')); await writeFile(join(reports,'terminal-syntax/capture.txt'),'physical capture');
  const ci = await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(ci,'Retain selected physical terminal captures from neutral source'))],{cwd:repo,env,stdio:'pipe'});
  assert.deepEqual(await readdir(join(root,'terminal-captures')),['terminal-syntax']);
  assert.equal(await readFile(join(root,'terminal-captures/terminal-syntax/capture.txt'),'utf8'),'physical capture');
});


test('CI MSVC discovery passes quoted batch paths verbatim and retains only declared build variables', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy-msvc-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'native-environment'));
  const log = join(root, 'calls.json'), hook = join(root, 'discovery-probe.mjs');
  await writeFile(hook, `import child from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const calls=[];
child.execFileSync=(command,args,options)=>{
 calls.push({command,args,options});writeFileSync(${JSON.stringify(log)},JSON.stringify(calls));
 if(command.endsWith('vswhere.exe')) return 'C:\\\\Provisioned Tools\\\\Visual Studio\\r\\n';
 return 'VCToolsInstallDir=C:\\\\VC\\r\\nWindowsSdkDir=C:\\\\SDK\\r\\nWindowsSDKVersion=10.0.0\\\\\\r\\nINCLUDE=declared-include\\r\\nLIB=declared-lib\\r\\nLIBPATH=declared-libpath\\r\\nPATH=ambient-path-poison\\r\\nNODE_OPTIONS=ambient-startup-poison\\r\\n';
};
syncBuiltinESMExports();
`);
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const script = shellStep(workflowStep(workflow, 'Prepare explicit build-only MSVC context'));
  for (const [RUST_TARGET, cpu] of [['x86_64-pc-windows-msvc', 'x64'], ['aarch64-pc-windows-msvc', 'x64_arm64']]) {
    execFileSync(toolPath('bash'), ['-e', '-o', 'pipefail', '-c', script], {
      cwd: repo, env: childEnv(join(root, 'caller'), { RUNNER_TEMP: root, RUST_ROOT: join(root, 'rust'), RUST_TARGET, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` }, inputs), stdio: 'pipe',
    });
    const calls = JSON.parse(await readFile(log, 'utf8'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.windowsVerbatimArguments, true, 'cmd.exe needs its quoted command string without Node argv escaping');
    assert.deepEqual(calls[1].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(calls[1].args[3].startsWith('""C:\\Provisioned Tools\\Visual Studio'));
    assert.ok(calls[1].args[3].endsWith(`" ${cpu} >nul && set"`));
    const environment = JSON.parse(await readFile(join(root, 'native-environment/msvc.json'), 'utf8'));
    assert.deepEqual(Object.keys(environment).sort(), ['INCLUDE', 'LIB', 'LIBPATH', 'PATH']);
    assert.equal(environment.INCLUDE, 'declared-include'); assert.equal(environment.LIB, 'declared-lib');
    assert.equal(environment.PATH.includes('ambient-path-poison'), false);
  }
});

test('actual Windows CI checkout policy survives isolated Git configuration without changing source bytes or accepting edits', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await source(t), checkout = join(root, 'checkout');
  const env = childEnv(join(root, 'git-environment'), {}, inputs);
  const git = (cwd, args, extra = {}) => execFileSync(toolPath('git'), ['-C', cwd, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  git(root, ['init', '--quiet']);
  git(root, ['add', 'Cargo.lock', 'crates/occipital/Cargo.toml']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  git(root, ['clone', '--quiet', '--no-checkout', root, checkout]);
  const system = join(root, 'checkout-system.gitconfig');
  await writeFile(system, '[core]\nautocrlf = true\n');
  git(checkout, ['checkout', '--quiet', '--force', 'HEAD'], { GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: system });
  const files = ['Cargo.lock', 'crates/occipital/Cargo.toml'];
  const before = await Promise.all(files.map(file => readFile(join(checkout, file))));
  for (const bytes of before) assert.ok(bytes.includes('\r\n'), 'positive control represents a real Windows CRLF checkout');
  const status = () => git(checkout, ['status', '--porcelain', '--', 'crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo']);
  assert.notEqual(status().trim(), '', 'removing inherited Git policy reproduces the false dirty-source rejection');
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const step = workflowStep(workflow, 'Declare Windows checkout line-ending semantics');
  assert.match(step, /^        if: runner\.os == 'Windows'$/m, 'the declaration must not alter non-Windows Git semantics');
  execFileSync(toolPath('bash'), ['-e', '-o', 'pipefail', '-c', shellStep(step)], { cwd: checkout, env, stdio: 'pipe' });
  assert.equal(status().trim(), '', 'strict same-commit admission must see the unchanged checkout as clean');
  for (let index = 0; index < files.length; index++) assert.deepEqual(await readFile(join(checkout, files[index])), before[index], 'declaration must not rewrite source or change native build inputs');
  assert.equal(await readFile(system, 'utf8'), '[core]\nautocrlf = true\n', 'do not rewrite inherited system configuration');
  assert.equal(await readFile(env.GIT_CONFIG_GLOBAL, 'utf8'), '', 'do not rewrite inherited global configuration');
  await writeFile(join(checkout, 'crates/occipital/Cargo.toml'), before[1].toString() + '# actual source edit\r\n');
  assert.match(status(), /crates\/occipital\/Cargo\.toml/, 'genuine native edits still fail strict commit-only admission');
});

test('ordinary CI caches only content-addressed npm inputs in the actual owned preparation root', async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  for (const name of ['baseline', 'affected']) {
    const job = workflowJob(ci, name);
    assert.match(job, /uses: actions\/cache@v4/);
    assert.match(job, /path: \$\{\{ runner\.temp \}\}\/scoped-inputs\/environment\/cache\/npm\/_cacache/);
    assert.doesNotMatch(job, /^\s+cache: npm$/m, 'ambient ~/.npm is not an input to the isolated preparer');
    assert.match(job, /(?:--output "\$RUNNER_TEMP\/scoped-inputs"|process\.env\.RUNNER_TEMP \+ '\/scoped-inputs')/);
  }
});

test('current-source full union checks out the exact approved HEAD rather than a PR merge revision', async () => {
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  for(const name of ['extension','terminal']){
    const job=workflowJob(ci,name),checkout=job.match(/^      - uses: actions\/checkout@v4(?:\n(?!      - )[^\n]*)*/m)?.[0];
    assert.ok(checkout,`${name}: explicit checkout configuration`);
    assert.match(checkout,/          ref: \$\{\{ needs\.scope\.outputs\.head \}\}/,`${name}: current-source union must not silently switch to a synthetic merge`);
    assert.match(checkout,/          fetch-depth: 0/);
  }
  assert.match(workflowJob(ci,'native'),/source-ref: \$\{\{ needs\.scope\.outputs\.head \}\}/);
});


test('CI retains safe preparation reports even when npm failed before publishing inputs', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-preparation-captures-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const preparation = join(root,'consumer-26.7.0'), name = 'installed-preparation-before-inputs';
  const reports = join(preparation,'consumer/diagnostics',name);
  await mkdir(reports,{recursive:true});
  for (const file of ['npm.json','fixture.json','raw-debug-0.log','inputs.json']) await writeFile(join(reports,file),'{}');
  await mkdir(join(preparation,'consumer/diagnostics','private-cache'));
  await writeFile(join(preparation,'consumer/diagnostics/private-cache','npm.json'),'private');
  const workflow = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(workflow,'Retain only safe consumer diagnostics from neutral sources'))], {
    cwd:repo,env:childEnv(join(root,'caller'),{RUNNER_TEMP:root},inputs),stdio:'pipe',
  });
  assert.deepEqual(await readdir(join(preparation,'diagnostics')),[name]);
  assert.deepEqual((await readdir(join(preparation,'diagnostics',name))).sort(),['fixture.json','npm.json']);
  await assert.rejects(lstat(join(preparation,'inputs.json')),{code:'ENOENT'});
});


test('actual native target step emits a Windows-only diagnostic but keeps complete release plans', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-native-plan-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const source = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const step = source.match(/      - id: targets\n[\s\S]*?(?=\n  packaging-fixtures:)/)[0];
  for(const [TARGETS, RELEASE_REF, CONSUMERS, count, packaging] of [
    ['windows-only','refs/heads/windows-performance','true',2,false],
    ['all','refs/heads/main','true',6,true],['all','refs/heads/main','false',6,false],
    ['host-only','refs/heads/main','true',1,true],
    ['windows-only','refs/tags/pi-tidy-ui-v0.2.0','false',6,true],
    ['windows-only','refs/tags/occipital-v0.1.6','false',6,true],
  ]) {
    const output = join(root,'github-output'); await writeFile(output,'');
    execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(step)],{
      cwd:repo,env:childEnv(join(root,'environment'),{TARGETS,RELEASE_REF,CONSUMERS,GITHUB_OUTPUT:output},inputs),stdio:'pipe',
    });
    const record = Object.fromEntries((await readFile(output,'utf8')).trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
    const matrix = JSON.parse(record.matrix);assert.equal(matrix.length,count);assert.equal(record.packaging,String(packaging));
    if(count===2) assert.deepEqual(matrix.map(row=>row.target),['windows-x64-msvc','windows-arm64-msvc']);
  }
  assert.match(workflowJob(source,'packaging-fixtures'),/needs: targets\n    if: needs.targets.outputs.packaging == 'true'/);
  const ci = await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  assert.match(workflowJob(ci,'baseline'),/selection != 'windows-consumer-diagnostic'/);
});
