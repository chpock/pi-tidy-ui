import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    'occipital-npm-publish.yml/publish': 15, 'occipital-release.yml/publish': 10,
    'occipital.yml/packaging-fixtures': 5, 'occipital.yml/build': 45,
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

test('Windows builds statically link CRT for both targets and inspect the actual executable before staging', async () => {
  const config = await readFile(join(repo, '.cargo/config.toml'), 'utf8');
  const targets = [...config.matchAll(/^\[target\.([^\]]+)\]\nrustflags = \["-C", "target-feature=\+crt-static"\]$/gm)].map(match => match[1]);
  assert.deepEqual(targets.sort(), ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']);
  assert.equal([...config.matchAll(/^\[/gm)].length, 2, 'no flags for unrelated targets or host-wide build override');
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  assert.match(workflow, /- name: Install Windows executable inspection tool\n        if: startsWith\(matrix.target, 'windows-'\)\n        run: rustup component add llvm-tools-preview/);
  for (const command of ['test --workspace', 'clippy --workspace', 'build --release']) {
    assert.match(workflow, new RegExp(`cargo ${command}[^\\n]*--target "\\$RUST_TARGET"`), 'target flags must not affect host build scripts/proc macros');
  }
  const script = await readFile(join(repo, 'scripts/release/native-ci.mjs'), 'utf8');
  assert.match(script, /candidateTargets\[target\]\.os === 'win32'\) await verifyWindowsRuntime\(binary\)/);
  assert.ok(script.indexOf('await verifyWindowsRuntime(binary)') < script.indexOf('await stageRelease('));
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

test('native CI verifies the installed adopted pin on both Nodes without coupling independent daemon tags', async () => {
  const source = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const workflow = source.match(/^  build:\n([\s\S]*)/m)?.[1];
  assert.ok(workflow, 'installed acceptance must run inside the native platform matrix');
  assert.match(workflow, /^    runs-on: \$\{\{ matrix\.runner \}\}$/m);
  for (const version of ['22.19.0', '26.7.0']) {
    const step = workflow.match(new RegExp(`- name: Installed adopted pin on Node ${version.replaceAll('.', '\\.') }\\n        if: ([^\\n]+)\\n        timeout-minutes: 15\\n        env:\\n          EXPECTED_NODE: '${version.replaceAll('.', '\\.') }'\\n          TARGET: \\$\\{\\{ matrix.target \\}\\}\\n          RUST_TARGET: \\$\\{\\{ matrix.rust \\}\\}\\n          npm_config_cache: \\$\\{\\{ runner.temp \\}\\}/occipital-npm-cache\\n          UV_THREADPOOL_SIZE: '4'\\n          SYSTEM_TEMP: \\$\\{\\{ steps.windows-temp.outputs.system-temp \\}\\}\\n        run: \\|\\n([\\s\\S]*?)(?=\\n      -|$)`));
    assert.ok(step, `${version}: actual installed pin gate on every native runner`);
    assert.equal(step[1], "${{ !startsWith(inputs.release-ref, 'refs/tags/occipital-v') }}");
    assert.match(step[2], /elif \[\[ "\$TARGET" == linux-\* \]\]; then\s+bash scripts\/release\/installed-linux-gnu\.sh "\$RUST_TARGET"\s+else\s+npm run test:installed-native\s+fi/);
  }
  assert.match(workflow, /- uses: actions\/setup-node@v4\n        if: \$\{\{ !startsWith\(inputs.release-ref, 'refs\/tags\/occipital-v'\) \}\}\n        with:\n          node-version: '26\.7\.0'/);
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:installed-native'], 'node tests/fixtures/installed-occipital.mjs');
  for (const [ref, enabled] of [['refs/heads/main', true], ['refs/pull/1/merge', true], ['refs/tags/pi-tidy-ui-v0.2.0', true], ['refs/tags/occipital-v0.1.3', false]]) {
    assert.equal(!ref.startsWith('refs/tags/occipital-v'), enabled, ref);
  }
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


test('GNU CI builds and tests natively in verified glibc2.28 without restoring newer-host compiler outputs', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  assert.match(workflow, /- name: GNU glibc 2\.28 native build and runtime checks\n        if: startsWith\(matrix.target, 'linux-'\)\n        env:\n          RUST_TARGET: \$\{\{ matrix.rust \}\}\n        run: bash scripts\/release\/linux-gnu.sh "\$RUST_TARGET"/);
  assert.match(workflow, /- uses: Swatinem\/rust-cache@v2\n        with:\n          key: \$\{\{ startsWith\(matrix.target, 'linux-'\) && 'glibc-2\.28' \|\| '' \}\}/);
  for (const step of ['Native correctness, pipe protocol and parser-affinity doctest', 'Strict native lint', 'Build release executable', 'Real release-binary protocol, UTF8 colors, append counters and cleanup']) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: \${{ !startsWith(matrix.target, 'linux-') }}`), step);
  }
  const image = await readFile(join(repo, 'scripts/release/Dockerfile.linux-gnu'), 'utf8');
  assert.match(image, /^FROM almalinux:8@sha256:[a-f0-9]{64}$/m);
  assert.match(image, /dnf install -y gcc gcc-c\+\+ make binutils/);
  assert.match(image, /getconf GNU_LIBC_VERSION/);
  const script = await readFile(join(repo, 'scripts/release/linux-gnu.sh'), 'utf8');
  assert.match(script, /x86_64-unknown-linux-gnu/); assert.match(script, /aarch64-unknown-linux-gnu/);
  assert.match(script, /uname -m/); assert.match(script, /getconf GNU_LIBC_VERSION/);
  assert.match(script, /rustc --print sysroot/); assert.match(script, /process.execPath/);
  assert.match(script, /--network=none/); assert.match(script, /--user/);
  for (const command of ['test --workspace', 'clippy --workspace --all-targets', 'build --release']) {
    const line = script.split('\n').find(line => line.includes(`cargo ${command}`));
    assert.ok(line?.includes('--locked --offline') && line.includes('--target "$RUST_TARGET"'), command);
  }
  assert.match(script, /allocator_diagnostic_tracks_the_actual_glibc_api/);
  assert.match(script, /await verifyLinuxRuntime\(process.env.OCCIPITAL_TEST_BIN\)/);
  assert.match(script, /\^actual owned helper preserves compact UTF8 highlighting and incremental work counters\$/);
});


test('GNU gate forwards the mounted SDK selection to Cargo-home Rustup proxies', async () => {
  const script = await readFile(join(repo, 'scripts/release/linux-gnu.sh'), 'utf8');
  assert.match(script, /rust_sysroot="\$\(rustc --print sysroot\)"/);
  assert.match(script, /-v "\$rust_sysroot:\$rust_sysroot:ro"/);
  assert.match(script, /--env RUSTUP_TOOLCHAIN="\$rust_sysroot"/);
  assert.doesNotMatch(script, /rustup default|rustup toolchain install/);
});


test('GNU installed consumer verifies the public pin in glibc2.28 without compiler or payload overrides', async () => {
  const image = await readFile(join(repo, 'scripts/release/Dockerfile.linux-gnu'), 'utf8');
  assert.match(image, /dnf install -y[^\n]*\blibatomic\b/, 'official Node25+ runtime prerequisite must exist in the GNU test image');
  const script = await readFile(join(repo, 'scripts/release/installed-linux-gnu.sh'), 'utf8');
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) assert.ok(script.includes(target));
  assert.match(script, /uname -m/);
  assert.match(script, /process\.execPath/);
  assert.match(script, /process\.env\.EXPECTED_NODE/, 'do not overwrite a fixed CI Node requirement with the detected host version');
  assert.match(script, /--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(script, /--env EXPECTED_NODE="\$node_version"/);
  assert.match(script, /test "\$\(getconf GNU_LIBC_VERSION\)" = "glibc 2\.28"/);
  assert.match(script, /npm run test:installed-native/);
  assert.doesNotMatch(script, /cargo|rustc|OCCIPITAL_TEST_BIN|RUSTUP|--network=none|\.cargo|npm publish/);
});


test('installed npm preparation retains successful and failed safe diagnostics without weakening independent daemon releases', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const upload = workflow.match(/      - name: Installed npm preparation diagnostics\n[\s\S]*?(?=      - |$)/)?.[0];
  assert.ok(upload, 'installed preparation diagnostics upload required');
  assert.match(upload, /always\(\) && !startsWith\(inputs\.release-ref, 'refs\/tags\/occipital-v'\)/);
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /path: \.test-artifacts\/installed-preparation-\*\//);
  assert.match(upload, /include-hidden-files: true/);
  assert.match(upload, /if-no-files-found: ignore/);
  assert.match(upload, /name: installed-preparation-\$\{\{ matrix\.target \}\}/);
  const fixture = await readFile(join(repo, 'tests/fixtures/installed-occipital.mjs'), 'utf8');
  assert.match(fixture, /runNpmPreparation/);
  assert.match(fixture, /finally[\s\S]*await rm\(temporary, \{ recursive: true, force: true \}\)/);
  assert.match(fixture, /fixture\.json/);
  assert.match(fixture, /npmMs: Math\.round\(npmMs\), cleanupMs/);
  assert.ok(fixture.indexOf('await rm(temporary') < fixture.indexOf("join(report, 'fixture.json')"));
});


test('all native platforms reuse only the npm content cache across both installed runtimes', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const step = workflow.match(/      - name: Installed npm package cache\n[\s\S]*?(?=      - |$)/)?.[0];
  assert.ok(step, 'installed npm package cache required on the whole native matrix');
  assert.match(step, /if: \$\{\{ !startsWith\(inputs\.release-ref, 'refs\/tags\/occipital-v'\) \}\}/);
  assert.doesNotMatch(step, /startsWith\(matrix\.target|windows-|linux-/);
  assert.match(step, /uses: actions\/cache@v4/);
  assert.match(step, /path: \$\{\{ runner\.temp \}\}\/occipital-npm-cache\/_cacache/);
  assert.match(step, /key: installed-npm-v1-\$\{\{ matrix\.target \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
  assert.match(step, /restore-keys: installed-npm-v1-\$\{\{ matrix\.target \}\}-/);
  assert.doesNotMatch(step, /node_modules|_logs|\.npmrc|payload-preparation|cache\/occipital/);
  assert.ok(workflow.indexOf(step) < workflow.indexOf('- name: Installed adopted pin on Node 22.19.0'));
  for (const version of ['22.19.0', '26.7.0']) {
    const installed = workflow.match(new RegExp(`      - name: Installed adopted pin on Node ${version.replaceAll('.', '\\.')}\\n[\\s\\S]*?(?=      - |$)`))?.[0];
    assert.ok(installed);
    assert.match(installed, /timeout-minutes: 15/);
    assert.match(installed, /npm_config_cache: \$\{\{ runner\.temp \}\}\/occipital-npm-cache/);
  }
});

test('installed npm preparation has five-minute headroom without changing native deadlines or output limits', async () => {
  const preparation = await readFile(join(repo, 'tests/fixtures/npm-preparation.ts'), 'utf8');
  assert.match(preparation, /timeout: 300000, maxBuffer: 1024 \* 1024/);
  const fixture = await readFile(join(repo, 'tests/fixtures/installed-occipital.mjs'), 'utf8');
  assert.match(fixture, /Installed source did not complete[\s\S]*\}, 10000\)/);
  assert.match(fixture, /timeout: 5000/);
  assert.match(fixture, /nativeDispatches: complete\.dispatches/);
});

test('GNU installed checks bind and forward the optional host npm cache without changing isolation', async () => {
  const script = await readFile(join(repo, 'scripts/release/installed-linux-gnu.sh'), 'utf8');
  assert.match(script, /npm_cache_args=\(\)/);
  assert.match(script, /if \[\[ -n "\$\{npm_config_cache:-\}" \]\]; then/);
  assert.match(script, /mkdir -p "\$npm_config_cache"/);
  assert.match(script, /npm_cache="\$\(cd "\$npm_config_cache" && pwd -P\)"/);
  assert.match(script, /npm_cache_args=\(-v "\$npm_cache:\$npm_cache" --env "npm_config_cache=\$npm_cache"\)/);
  assert.match(script, /"\$\{npm_cache_args\[@\]\}"/);
  assert.match(script, /--env HOME=\/tmp\/occipital-installed-home/);
  assert.match(script, /--env EXPECTED_NODE="\$node_version"/);
  assert.doesNotMatch(script, /node_modules|OCCIPITAL_TEST_BIN|NATIVE_RELEASE|\/cache\/occipital/);
});


test('research installed checks compare Windows temporary volumes without changing npm cache or gates', async () => {
  const workflow = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const preparation = workflow.split('      - name: Prepare Windows temporary-volume comparison\n')[1]?.split('\n      - ')[0];
  assert.ok(preparation);
  assert.match(preparation, /id: windows-temp/);
  assert.match(preparation, /startsWith\(matrix.target, 'windows-'\).*!startsWith\(inputs.release-ref, 'refs\/tags\/occipital-v'\)/);
  assert.match(preparation, /shell: pwsh/);
  assert.match(preparation, /GetPathRoot\(\$env:SystemRoot\)/);
  assert.match(preparation, /system-temp=\$systemTemp/);
  for (const [version, order] of [['22.19.0', 'runner system'], ['26.7.0', 'system runner']]) {
    const step = workflow.split(`      - name: Installed adopted pin on Node ${version}\n`)[1]?.split('\n      - ')[0];
    assert.ok(step);
    assert.match(step, /timeout-minutes: 15/);
    assert.match(step, /UV_THREADPOOL_SIZE: '4'/);
    assert.match(step, /npm_config_cache: \$\{\{ runner.temp \}\}\/occipital-npm-cache/);
    assert.match(step, /SYSTEM_TEMP: \$\{\{ steps.windows-temp.outputs.system-temp \}\}/);
    assert.ok(step.includes(`for location in ${order}; do`));
    assert.match(step, /if \[\[ "\$TARGET" == windows-\* \]\]; then/);
    assert.match(step, /temp_root="\$RUNNER_TEMP"/);
    assert.match(step, /temp_root="\$SYSTEM_TEMP"/);
    assert.match(step, /TEMP="\$temp_root" TMP="\$temp_root" npm run test:installed-native/);
    assert.match(step, /elif \[\[ "\$TARGET" == linux-\* \]\]; then\n +bash scripts\/release\/installed-linux-gnu.sh "\$RUST_TARGET"/);
    assert.match(step, /else\n +npm run test:installed-native/);
    assert.doesNotMatch(step, /4 16|16 4|--omit|--offline|--prefer-offline|--test-name-pattern|Set-MpPreference/);
  }
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
