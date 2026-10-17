import "../../fixtures/test-guard.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, readdir, chmod, lstat, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnv, readInputs, toolPath } from "../../../scripts/test/context.mjs";
import { selectSuite } from "../../../scripts/test/run.mjs";
import { buildCIPlan } from "../../../scripts/test/ci-plan.mjs";
import {enabledTargets} from "../../../scripts/release/platforms.mjs";
import { releaseRef, stampVersion } from "../../../scripts/release/version.mjs";
import { assembleRelease, assetName, artifactName } from "../../../scripts/release/native-ci.mjs";
import * as nativeCI from "../../../scripts/release/native-ci.mjs";
import { candidateTargets, daemonVersion, stageRelease } from "../../../scripts/release/native-release.mjs";
import { acquireNative } from "../../../src/occipital/native.ts";

const repo = resolve(import.meta.dirname, "../../.."), commit = 'a'.repeat(40), repository = 'chpock/pi-tidy-ui';
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

async function nativeDescriptor(inputs, root, runRoot, rust) {
  const preparation=join(root,'native-build-inputs');
  for(const path of [join(preparation,'bin'),join(runRoot,'project')])await mkdir(path,{recursive:true});
  const descriptor={schema:1,kind:'native-build',preparation,node:inputs.node,tools:{...inputs.tools,bin:join(preparation,'bin')},source:inputs.source,runRoot,project:join(runRoot,'project'),rust:{root:rust,cargo:join(rust,'bin/cargo'),rustc:join(rust,'bin/rustc'),home:join(preparation,'cargo-home'),target:join(preparation,'cargo-target'),environment:{}}};
  await writeFile(join(preparation,'inputs.json'),JSON.stringify(descriptor));
}


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

async function artifacts(t, version = '0.1.0', targets = enabledTargets({windowsArm64:true})) {
  const root = await source(t), tag = 'occipital-v' + version;
  await stampVersion(root, 'refs/tags/' + tag);
  const directory = join(root, 'artifacts'); await mkdir(directory);
  const notice = join(root, 'NOTICE'), binary = join(root, 'tiny');
  await writeFile(notice, 'Inert fixture notice\n'); await writeFile(binary, 'inert fixture binary\n');
  for (const target of targets) {
    const output = join(directory, artifactName(version, target));
    await stageRelease({ root, output, targets, input: { notice, artifacts: [{ target, path: binary,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(version, target))}` }] } });
    await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }));
    await mkdir(join(output, 'notices'));
    await writeFile(join(output, 'notices/notice-sources.json'), JSON.stringify({ gaps: [], inventory: [{ name: 'inert-fixture' }] }));
  }
  return { root, directory, tag, version, targets, output: join(root, 'publish') };
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
      const timeout = body.match(/^    timeout-minutes: (.+)$/m)?.[1];
      assert.ok(timeout, `${key}: explicit bounded timeout`);
      if (key === 'ci-checks.yml/checks') {
        assert.equal(timeout, "${{ inputs.layer == 'cli' && 30 || 10 }}");
        timeouts[key] = [10, 30];
      } else {
        assert.match(timeout, /^[1-9]\d*$/);
        assert.ok(Number(timeout) <= 60, `${key}: no hours-long execution allowance`);
        timeouts[key] = Number(timeout);
      }
    }
  }
  assert.deepEqual(timeouts, {
    'ci-checks.yml/checks': [10, 30], 'ci.yml/metadata': 5, 'ci.yml/result': 5, 'ci.yml/extension-package': 15,
    'occipital-npm-publish.yml/publish': 15, 'occipital-release.yml/publish': 10,
    'occipital.yml/build': 60, 'occipital-consumer.yml/consumer': 25,
  });
  const checks = await readFile(join(directory, 'ci-checks.yml'), 'utf8');
  assert.match(checks, /- name: Complete Node, actual-SDK and GC checks\n        if: inputs.layer == 'node'\n        timeout-minutes: 5\n/);
});

test('CI retains only same-run native transfers, never diagnostics, results or development packages', async()=>{
  const files=await readdir(join(repo,'.github/workflows'));
  let uploads=0;
  for(const file of files.filter(name=>/\.ya?ml$/.test(name))){
    const text=await readFile(join(repo,'.github/workflows',file),'utf8');
    if(!text.includes('uses: actions/upload-artifact@'))continue;
    assert.equal(file,'occipital.yml','only the native producer transfers payloads to other jobs');
    const upload=workflowStep(text,"Transfer this commit's native inputs to dependent jobs");
    assert.match(upload,/retention-days: 1/);assert.match(upload,/occipital-native-artifact/);
    assert.equal((upload.match(/^          overwrite: true$/gm)||[]).length,1,'retain one same-run replacement declaration for producer retries');
    assert.doesNotMatch(upload,/diagnostics|receipts|terminal-captures|\.tgz|target\//);
    uploads+=(text.match(/uses: actions\/upload-artifact@v\d+(?:\.\d+){0,2}/g)||[]).length;
  }
  assert.equal(uploads,1);
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  assert.doesNotMatch(ci,/Retain selected physical terminal captures/);
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

test('CI publishes Occipital GitHub and npm only after every selected platform and both Node controls',async()=>{
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  const native=await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const release=await readFile(join(repo,'.github/workflows/occipital-release.yml'),'utf8');
  assert.match(ci,/tags: \['pi-tidy-ui-v\*', 'occipital-v\*'\]/);
  const publication=workflowJob(ci,'release-occipital');
  for(const name of ['metadata','native-linux','native-platforms','consumer-linux','delivery','daemon-regressions'])assert.ok(publication.match(/^    needs: \[([^\n]+)\]/m)[1].split(', ').includes(name));
  assert.match(publication,/github.event_name == 'push'.*refs\/tags\/occipital-v/);
  assert.match(publication,/targets: \$\{\{ needs.metadata.outputs.targets \}\}/);
  const npm=workflowJob(ci,'publish-occipital-npm');
  assert.match(npm,/needs: \[metadata, release-occipital\]/);
  assert.match(npm,/refs\/tags\/occipital-v/);assert.match(npm,/id-token: write/);
  assert.match(npm,/uses: \.\/\.github\/workflows\/occipital-npm-publish.yml/);
  assert.deepEqual((await buildCIPlan({eventName:'push',ref:'refs/heads/main',sha:commit,fetchLatest:async()=>Response.json({name:'@earendil-works/pi-coding-agent',version:'1.3.0'})})).native.targets,enabledTargets());
  assert.match(native,/fromJSON\(inputs.platforms\)/);
  assert.match(native,/Stamp daemon before compilation[\s\S]*\['build','--release','--locked','--offline'/);
  assert.match(release,/actions\/download-artifact@v\d+(?:\.\d+){0,2}/);
  assert.doesNotMatch(release,/run-id:|cargo build|run: npm publish/);
  assert.match(workflowStep(release,'Publish admitted assets or verify an identical completed release'),/native-ci.mjs publish "\$TAG" release-assets/);
  assert.match(release,/assemble native-artifacts.*"\$NATIVE_TARGETS"/);assert.match(release,/sha256sum --check SHA256SUMS/);
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
  assert.match(workflow, /id: gnu-image-cache\n        if: startsWith\(matrix.target, 'linux-'\)\n        uses: actions\/cache@v\d+(?:\.\d+){0,2}/);
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

test('extension release retains exact admission and packing, but npm publication is a commented placeholder without stored tarballs',async()=>{
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8'),publication=workflowJob(ci,'extension-package');
  const gates=publication.match(/^    needs: \[([^\n]+)\]/m)[1].split(', ');
  for(const gate of ['metadata','native-linux','native-platforms','consumer-linux','delivery','sdk','cli'])assert.ok(gates.includes(gate),gate);
  assert.match(publication,/if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/pi-tidy-ui-v'\)/);
  assert.match(publication,/fetch-depth: 0/);assert.match(publication,/pattern: occipital-v\$\{\{ needs\.metadata\.outputs\.daemon_version \}\}-\*/);
  assert.match(publication,/gh api .*releases\/tags\/\$DAEMON_TAG/);assert.match(publication,/gh release download "\$DAEMON_TAG"/);
  assert.match(publication,/node scripts\/release\/extension-release\.mjs "\$RELEASE_REF"/);
  assert.match(publication,/prepared "\$NATIVE_TARGETS"/);
  assert.ok(publication.indexOf('extension-release.mjs')<publication.indexOf('npm pack'));
  assert.match(publication,/npm pack .*\/extension --ignore-scripts/);
  assert.match(publication,/^      #   run: npm publish .*--provenance/m);
  const executable=publication.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(executable,/npm publish|contents: write|id-token: write|upload-artifact|gh release create/);
  assert.doesNotMatch(workflowJob(ci,'sdk'),/npm pack/,'same-source consumer preparation already packs the extension; product jobs must not duplicate it');
  const checks = await readFile(join(repo,'.github/workflows/ci-checks.yml'),'utf8');
  assert.doesNotMatch(checks,/npm pack/,'delegating SDK execution must not move duplicate packing into its reusable workflow');
  const manifest=await json(join(repo,'package.json')),lock=await json(join(repo,'package-lock.json'));
  assert.equal(manifest.version,'0.0.0');
  assert.equal(Object.keys(manifest.optionalDependencies).some(name=>name.startsWith('@kchpock/occipital-')),false);
  assert.equal(Object.keys(lock.packages).some(name=>name.startsWith('node_modules/@kchpock/occipital-')),false);
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

test('each platform compiles once and its event-selected consumers can start without waiting for other platforms',async()=>{
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  const producer=await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const platform=await readFile(join(repo,'.github/workflows/occipital-platform.yml'),'utf8');
  const consumer=await readFile(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
  assert.match(workflowJob(ci,'native-platforms'),/strategy:[\s\S]*fromJSON\(needs.metadata.outputs.remaining\)/);
  assert.match(workflowJob(ci,'native-platforms'),/uses: \.\/\.github\/workflows\/occipital-platform.yml/);
  assert.match(workflowJob(platform,'consumers'),/^    needs: build$/m);
  assert.doesNotMatch(workflowJob(platform,'consumers'),/native-platforms|native-linux/);
  assert.match(workflowJob(ci,'consumer-linux'),/needs: \[metadata, native-linux\]/);
  for(const name of ['sdk','cli'])assert.match(workflowJob(ci,name),/needs: \[metadata, native-linux\]/);
  assert.doesNotMatch(producer,/Same-commit clean consumer|setup-node[\s\S]*26\.7\.0|packaging-fixtures/);
  assert.match(workflowStep(producer,'Prepare enforced Linux network isolation'),/^        if: startsWith\(matrix.target, 'linux-'\)$/m);
  assert.doesNotMatch(consumer,/rust-toolchain|Resolve fixed Rust|build-only MSVC|apt-get|rust-harness/,'consumers execute delivered bytes, not a second compiler setup');
  assert.match(workflowStep(producer,'All native-build controls before source stamping'),/scripts\/test\/native-harness.mjs --inputs/);
  const staging=workflowStep(producer,'Version smoke, pinned-source notices, hashes and native package staging');
  assert.match(staging,/stageCI\(\{[^\n]*targets: ?\[target\]/);
  assert.match(staging,/console\.log\(JSON\.stringify\(\{target,version:staged.version,commit:inputs.source.commit,nativeTree:inputs.source.nativeTree,/);
  assert.match(staging,/bytes:staged.artifacts\[0\].maxBytes,sha256:staged.artifacts\[0\].sha256/);
  const step=workflowStep(consumer,'Same-commit clean consumer and actual helper');
  assert.match(step,/--archives --native-artifact "\$ARTIFACT"/);
  assert.match(step,/--suite native --files occipital-native.test.ts/);assert.match(step,/--suite consumer/);
  assert.match(step,/installed-linux-gnu.sh "\$RUST_TARGET" native-consumer "\$PREPARATION" "\$ARTIFACT"/);
  assert.doesNotMatch(step,/--cargo-cache|published-consumer/);
  assert.match(producer,/Verify original source identity after neutral staging/);
  assert.ok(producer.indexOf('await stageCI(')<producer.indexOf('Verify original source identity'));
  assert.ok(producer.indexOf('Verify original source identity')<producer.indexOf('uses: actions/upload-artifact'));
  for(const windowsArm64 of [false,true])for(const ref of ['refs/heads/main','refs/tags/occipital-v0.2.0','refs/tags/pi-tidy-ui-v0.3.0']){
    const plan=(await buildCIPlan({eventName:'push',ref,sha:commit,windowsArm64,fetchLatest:async()=>Response.json({name:'@earendil-works/pi-coding-agent',version:'1.3.0'})})).native;
    for(const target of plan.targets){
      const rows=target==='linux-x64-gnu'?plan.hostConsumers:plan.remaining.find(row=>row.target===target).consumerMatrix;
      assert.deepEqual(rows.map(row=>row.node),ref==='refs/heads/main'?['22.19.0']:['22.19.0','26.7.0']);
    }
  }
});

test('published consumer routing remains extension-tag only on the selected platform by Node matrix',async()=>{
  const native=await readFile(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
  const step=workflowStep(native,'Published delivery (pi-tidy-ui release only)');
  assert.match(step,/^        if: github.event_name == 'push' && startsWith\(inputs.release-ref, 'refs\/tags\/pi-tidy-ui-v'\)$/m);
  assert.match(step,/--suite published-consumer --release-ref "\$RELEASE_REF"/);
  assert.match(step,/installed-linux-gnu.sh "\$RUST_TARGET" published-consumer .* "\$RELEASE_REF"/);
  const prefix=step.match(/^        if: github.event_name == 'push' && startsWith\(inputs.release-ref, '([^']+)'\)$/m)[1];
  for(const[ref,enabled]of[['refs/heads/main',false],['refs/pull/1/merge',false],['refs/heads/daily-compatibility',false],['refs/tags/occipital-v0.1.5',false],['refs/tags/pi-tidy-ui-v0.2.0',true]])assert.equal(ref.startsWith(prefix),enabled,ref);
  assert.match(native,/fromJSON\(inputs.platforms\)/);assert.match(native,/node-version: \$\{\{ matrix.node \}\}/);
  assert.equal((native.match(/--suite published-consumer/g)||[]).length,1);
  assert.doesNotMatch(await readFile(join(repo,'Makefile'),'utf8'),/test-installed:[\s\S]*?--suite published-consumer(?=[\s\S]*test-published:)/);
});

test('CI uses coherent prepared descriptors, catalogue capabilities and current-source native artifacts', async () => {
  const source = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const checks = await readFile(join(repo, '.github/workflows/ci-checks.yml'), 'utf8');
  for (const name of ['sdk', 'cli']) {
    const job = workflowJob(source, name);
    assert.match(job, /needs: \[metadata, native-linux\]/);
    assert.match(job, /fromJSON\(needs.metadata.outputs.(?:profiles|cli_profiles)\)/);
    assert.match(job, /uses: \.\/\.github\/workflows\/ci-checks.yml/);
    assert.match(job, /source-ref: \$\{\{ needs.metadata.outputs.source \}\}/);
    assert.doesNotMatch(job, /node --(?:expose-gc|test)|OCCIPITAL_TEST_BIN|PI_TEST_CLI/);
  }
  assert.match(checks, /prepare.mjs --pi-version "\$PI_VERSION"/);
  assert.match(checks, /--native-artifact "\$GITHUB_WORKSPACE\/\.test-artifacts\/ci-native"/);
  assert.match(checks, /selection.requirements.includes\(key\)/);
  assert.match(checks, /--integration/); assert.match(checks, /--shared-host "\$RUNNER_TEMP\/shared-host\/ck-subc"/);
  assert.match(workflowJob(source,'metadata'), /pull_request.head.sha \|\| github.sha/);
  assert.doesNotMatch(source, /pull_request_target|secrets\.|ci-scope|scope-decision/);
  assert.ok(selectSuite(readInputs(), 'unit').some(file => file.endsWith('/integration-profile.test.mjs')));
  for (const suite of ['check','native-release']) assert.match(checks, new RegExp(`--suite ${suite} --network-isolated`));
  assert.match(checks, /nightly \? 'compatibility' : 'unit'/);
});

test('native execution has owned Cargo configuration and mandatory offline pinned toolchain without inherited build environment', async () => {
  const native = await readFile(join(repo, '.github/workflows/occipital.yml'), 'utf8');
  const declaration = 'Declare pinned compiler and hosted setup Cargo artifact store';
  assert.ok(native.indexOf(declaration) < native.indexOf('Fetch locked native dependencies with owned config'), 'store admission must precede Cargo');
  const cache = native.match(/- uses: actions\/cache@v\d+(?:\.\d+){0,2}\n        if: \$\{\{ !inputs.clean-build \}\}\n        with:\n          path: \|\n([\s\S]*?)          key:/)?.[1];
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

test('consumer diagnostics are projected into job logs and never uploaded',async()=>{
  const native=await readFile(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
  const step=workflowStep(native,'Print safe consumer diagnostics');
  assert.match(step,/if: always\(\)/);assert.match(step,/printConsumerDiagnostics/);
  assert.doesNotMatch(native,/upload-artifact|collectConsumerDiagnostics/);
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
  const workflow = await readFile(join(repo, '.github/workflows/occipital-consumer.yml'), 'utf8');
  for (const version of ['22.19.0','26.7.0']) {
    const step = workflowStep(workflow, 'Same-commit clean consumer and actual helper');
    const script = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    for (const TARGET of ['darwin-x64', 'windows-x64-msvc', 'windows-arm64-msvc']) {
      for (const FAIL_SUITE of ['', 'native', 'consumer']) {
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
        assert.equal(calls[0].includes('--rust-root'),false,'actual consumers do not provision a compiler');
        assert.equal(calls[0].includes('--cargo-cache'),false,'consumer does not copy compiler dependency caches it never uses');
        assert.equal(calls[0].includes('--rust-environment'),false,'actual consumers do not construct an MSVC environment');
        assert.deepEqual(calls.slice(1).map(args=>args[args.indexOf('--suite')+1]), FAIL_SUITE === 'native' ? ['native'] : ['native','consumer']);
        for (const args of calls.slice(1)) assert.equal(args[args.indexOf('--inputs')+1], join(root,'consumer-inputs/inputs.json'));
      }
    }
  }
  const buildWorkflow=await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const ancestry=shellStep(workflowStep(buildWorkflow,'All native-build controls before source stamping'));
  for(const TARGET of ['linux-x64-gnu','darwin-x64','windows-arm64-msvc'])for(const fail of [false,true]){
    await rm(log,{force:true});
    const result=spawnSync(toolPath('bash'),['-e','-o','pipefail','-c',ancestry],{cwd:root,env:childEnv(join(root,'ancestry-env'),{PATH:bin+':'+inputs.tools.bin,RUNNER_TEMP:root,TARGET,FAIL_SUITE:fail?'scripts/test/native-harness.mjs':''},inputs),encoding:'utf8'});
    assert.equal(result.status,fail?17:0,result.stderr);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);
    assert.equal(calls[0][0],'scripts/test/native-harness.mjs');assert.equal(calls[0][calls[0].indexOf('--inputs')+1],join(root,'native-build-inputs/inputs.json'));
    assert.equal(calls[0].includes('--network-isolated'),TARGET.startsWith('linux-'));
  }
  await rm(log,{force:true}); await writeFile(join(root,'runtime-tools.json'),'{}');
  execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(buildWorkflow,'Prepare neutral native source snapshot'))],{
    cwd:root,env:childEnv(join(root,'native-environment'),{PATH:bin+':'+inputs.tools.bin,RUNNER_TEMP:root,RUST_ROOT:join(root,'pinned-rust'),CARGO_HOME:join(root,'owned-cargo')},inputs),stdio:'pipe',
  });
  const nativeCalls = (await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row)).filter(args=>args[0]==='scripts/test/prepare-native.mjs');
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
  await nativeDescriptor(inputs,temp,join(temp,'neutral'),rust);
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
  const neutral = join(root,'neutral'), source = join(neutral,'project'), rust = join(root,'rust'), log = join(root,'cargo.jsonl');
  for (const path of [source,join(rust,'bin'),join(root,'native-environment'),join(root,'native-build-inputs')]) await mkdir(path,{recursive:true});
  await nativeDescriptor(inputs,root,neutral,rust);
  await writeFile(join(rust,'bin/cargo'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,tmp:process.env.TIDY_TEST_ROOT,offline:process.env.CARGO_NET_OFFLINE,ambient:process.env.AMBIENT_POISON,toolchain:process.env.RUSTUP_TOOLCHAIN})+'\\n');\n`,{mode:0o755});
  const workflow = await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  await writeFile(join(rust,'bin/rustc'),'inert unused compiler marker');
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

test('actual CI diagnostics log neutral-source summaries without copying raw files or physical captures', {skip:process.platform==='win32'},async t=>{
  const inputs=readInputs(),root=await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-log-summary-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const preparation=join(root,'consumer-inputs'),source=join(root,'source'),reports=join(source,'.test-artifacts/installed-preparation-safe');
  await mkdir(reports,{recursive:true});await mkdir(preparation);
  await writeFile(join(reports,'fixture.json'),JSON.stringify({completed:true,elapsedMs:25,error:'SECRET'}));
  await writeFile(join(reports,'npm.json'),JSON.stringify({operation:'install',mode:'standard',elapsedMs:20,command:'SECRET'}));
  await writeFile(join(reports,'raw.log'),'SECRET');
  await writeFile(join(preparation,'inputs.json'),JSON.stringify({source:{root:source},pi:{root:join(root,'wrong-sdk')}}));
  const workflow=await readFile(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
  const stdout=execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(workflow,'Print safe consumer diagnostics'))],{cwd:repo,env:childEnv(join(root,'caller'),{RUNNER_TEMP:root},inputs),encoding:'utf8'});
  assert.match(stdout,/"elapsedMs":25/);assert.match(stdout,/"elapsedMs":20/);assert.doesNotMatch(stdout,/SECRET|command|error/);
  await assert.rejects(lstat(join(preparation,'diagnostics')),{code:'ENOENT'});
  assert.equal(await readFile(join(reports,'raw.log'),'utf8'),'SECRET');
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

test('current-source full union checks out the exact approved HEAD rather than a PR merge revision', async () => {
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8');
  const checks=await readFile(join(repo,'.github/workflows/ci-checks.yml'),'utf8');
  for(const name of ['sdk','cli','delivery']) assert.match(workflowJob(ci,name), /source-ref: \$\{\{ needs.metadata.outputs.source \}\}/);
  assert.match(workflowJob(ci,'metadata'), /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(checks, /ref: \$\{\{ inputs.source-ref \}\}/);
  assert.match(checks, /fetch-depth: 0/);
  assert.match(workflowJob(ci,'native-linux'), /source-ref: \$\{\{ needs.metadata.outputs.source \}\}/);
});


test('actual CI logs preparation progress even when npm failed before publishing inputs', {skip:process.platform==='win32'},async t=>{
  const inputs=readInputs(),root=await mkdtemp(join(process.env.TIDY_TEST_ROOT,'tidy-before-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const preparation=join(root,'consumer-inputs'),reports=join(preparation,'consumer/diagnostics/installed-preparation-before-inputs');
  await mkdir(reports,{recursive:true});await writeFile(join(reports,'fixture.json'),JSON.stringify({elapsedMs:35,phases:{hostInstall:30},error:'SECRET'}));
  await writeFile(join(reports,'raw.log'),'SECRET');
  const workflow=await readFile(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
  const stdout=execFileSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(workflowStep(workflow,'Print safe consumer diagnostics'))],{cwd:repo,env:childEnv(join(root,'caller'),{RUNNER_TEMP:root},inputs),encoding:'utf8'});
  assert.match(stdout,/"hostInstall":30/);assert.doesNotMatch(stdout,/SECRET/);
  await assert.rejects(lstat(join(preparation,'inputs.json')),{code:'ENOENT'});await assert.rejects(lstat(join(preparation,'diagnostics')),{code:'ENOENT'});
});


test('automatic GitHub publication reuses only an identical completed release and never turns API failure into creation',async t=>{
  const {publishGitHubRelease}=await import("../../../scripts/release/native-ci.mjs");
  assert.equal(typeof publishGitHubRelease,'function');
  const root=await mkdtemp(join(process.env.TIDY_TEST_ROOT,'release-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'admitted');await mkdir(directory);
  const tag='occipital-v0.2.0',repository='chpock/pi-tidy-ui',commit='b'.repeat(40);
  const bytes=new Map([['native-release.json',Buffer.from('{"version":"0.2.0","artifacts":[]}')],['NOTICE',Buffer.from('retained notices')],['LICENSE',Buffer.from('retained license')],['SHA256SUMS',Buffer.from('admitted checksum bytes')]]);
  for(const[name,value]of bytes)await writeFile(join(directory,name),value);
  const base={tag_name:tag,draft:false,prerelease:false,assets:[...bytes].map(([name,value],index)=>({name,id:index+1,size:value.length}))};
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/tags/'+tag,GITHUB_REPOSITORY:repository,GITHUB_SHA:commit,GH_TOKEN:'inert-not-a-credential'};
  async function attempt({status=200,release=base,alter,lookupError,sourceCommit=commit,...patch}={}){
    const mutations=[],reads=[];
    const execute=async(command,args)=>{
      reads.push([command,...args]);
      if(command==='git')return {stdout:sourceCommit+'\n'};
      assert.equal(command,'gh');
      if(args[0]==='api'){
        const stdout='HTTP/2.0 '+status+' Status\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(release);
        if(lookupError)throw Error('lookup unavailable');
        if(status!==200)throw Object.assign(Error('HTTP lookup rejected'),{stdout,code:1});
        return {stdout};
      }
      if(args[0]==='release'&&args[1]==='download'){
        const destination=args[args.indexOf('--dir')+1];
        for(const[name,value]of bytes)if(alter?.missing!==name)await writeFile(join(destination,name),alter?.changed===name?Buffer.from('different bytes'):value);
        if(alter?.extra)await writeFile(join(destination,'extra-file'),'not admitted');return {stdout:''};
      }
      assert.ok(args[0]==='release'&&['create','edit'].includes(args[1]));mutations.push(args);return {stdout:''};
    };
    const error=await publishGitHubRelease({root,directory,tag,repository,commit,env:{...env,...patch},execute}).then(value=>{return {value};},error=>({error}));
    return {...error,mutations,reads};
  }
  const absent=await attempt({status:404});assert.equal(absent.error,undefined);assert.equal(absent.value.status,'published');assert.deepEqual(absent.mutations.map(args=>args[1]),['create','edit']);
  const identical=await attempt();assert.equal(identical.error,undefined);assert.equal(identical.value.status,'already-published');assert.deepEqual(identical.mutations,[]);
  for(const options of [{release:{...base,draft:true}},{release:{...base,tag_name:'occipital-v0.3.0'}},{release:{...base,prerelease:true}},
    {release:{...base,assets:base.assets.slice(1)}},{release:{...base,assets:[...base.assets,{name:'extra',id:99,size:1}]}},
    {release:{...base,assets:[...base.assets,base.assets[0]]}},{release:{...base,assets:base.assets.map((value,index)=>index?value:{...value,size:999})}},
    {alter:{changed:'NOTICE'}},{alter:{missing:'LICENSE'}},{alter:{extra:true}},{status:403},{status:500},{lookupError:true},
    {sourceCommit:'c'.repeat(40)},{GITHUB_SHA:'c'.repeat(40)},{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_REF:'refs/heads/main'}]){
    const result=await attempt(options);assert.ok(result.error,JSON.stringify(options));assert.deepEqual(result.mutations,[],'invalid/replaced/incomplete inputs never create, edit or delete a release');
  }
});


test('actual version gate rejects npm-incompatible native tags before any production job',async()=>{
  const ci=await readFile(join(repo,'.github/workflows/ci.yml'),'utf8'),inputs=readInputs();
  const step=workflowStep(ci,'Validate automatic native npm version before building');
  assert.match(step,/^        if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/occipital-v'\)$/m);
  for(const version of ['0.2.0','0.2.0-rc.1','0.2.0+build.1']){
    const result=spawnSync(toolPath('bash'),['-e','-o','pipefail','-c',shellStep(step)],{cwd:repo,env:childEnv(join(process.env.TIDY_TEST_ROOT,'native-version-gate'),{RELEASE_REF:'refs/tags/occipital-v'+version},inputs),encoding:'utf8'});
    if(version.includes('+')){assert.notEqual(result.status,0);assert.match(result.stderr,/npm publication does not preserve SemVer build metadata/);}
    else assert.equal(result.status,0,result.stderr);
  }
});


test('actual producer staging logs admitted file fields when stageCI resolves without a return value',async t=>{
  const inputs=readInputs(),root=await mkdtemp(join(process.env.TIDY_TEST_ROOT,'staging-summary-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const temporary=join(root,'runner'),descriptor=join(temporary,'native-build-inputs');
  for(const path of [descriptor,join(root,'scripts/test'),join(root,'scripts/release')])await mkdir(path,{recursive:true});
  const native={kind:'native-build',node:inputs.node,tools:inputs.tools,runRoot:join(root,'native-run'),preparation:descriptor,
    source:{commit:'b'.repeat(40),nativeTree:'a'.repeat(64)},rust:{root:join(root,'inert-rust'),rustc:join(root,'inert-rust/bin/rustc'),environment:{}}};
  await writeFile(join(descriptor,'inputs.json'),JSON.stringify(native));
  await writeFile(join(root,'scripts/test/context.mjs'),`export {childEnv} from ${JSON.stringify(pathToFileURL(join(repo,'scripts/test/context.mjs')).href)};`);
  await writeFile(join(root,'scripts/test/prepare-native.mjs'),`import {readFileSync} from 'node:fs';export const readNativeInputs=path=>JSON.parse(readFileSync(path));`);
  const staged={version:'0.2.0',artifacts:[{target:'linux-x64-gnu',maxBytes:123,sha256:'c'.repeat(64),url:'https://not-a-log-field.invalid/private'}]};
  const workflow=await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8'),script=shellStep(workflowStep(workflow,'Version smoke, pinned-source notices, hashes and native package staging'));
  for(const fail of [false,true]){
    await rm(join(temporary,'occipital-native-artifact'),{recursive:true,force:true});
    await writeFile(join(root,'scripts/release/native-ci.mjs'),`import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';export async function stageCI({output}){${fail?`throw Error('controlled staging rejection');`:`await mkdir(output);await writeFile(join(output,'native-release.staged.json'),${JSON.stringify(JSON.stringify(staged))});`} }`);
    const env=childEnv(join(root,'outer-env'),{RUNNER_TEMP:temporary,NATIVE_SOURCE:root,TARGET:'linux-x64-gnu',RUST_TARGET:'x86_64-unknown-linux-gnu',EXECUTABLE:'occipital',CARGO_TARGET_DIR:join(root,'target'),CARGO_HOME:join(root,'cargo'),GITHUB_REPOSITORY:'chpock/pi-tidy-ui'},inputs);
    const result=spawnSync(toolPath('bash'),['-e','-o','pipefail','-c',script],{cwd:root,env,encoding:'utf8'});
    if(fail){assert.notEqual(result.status,0);assert.match(result.stderr,/controlled staging rejection/);assert.equal(result.stdout,'');}
    else{assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{target:'linux-x64-gnu',version:'0.2.0',commit:native.source.commit,nativeTree:native.source.nativeTree,bytes:123,sha256:'c'.repeat(64)});}
  }
});


test('maintained JavaScript actions use reviewed Node24 releases without changing tested Node or enabling ambient npm caching',async()=>{
  const versions={'checkout':'v7.0.1','setup-node':'v7.1.0','cache':'v6.1.0','upload-artifact':'v7.0.2','download-artifact':'v8.0.2'},seen=new Set();
  for(const name of (await readdir(join(repo,'.github/workflows'))).filter(name=>/\.ya?ml$/.test(name))){
    const source=await readFile(join(repo,'.github/workflows',name),'utf8');
    for(const match of source.matchAll(/uses: actions\/([a-z-]+)@([^\s]+)/g)){
      assert.ok(Object.hasOwn(versions,match[1]),'review the action runtime before adding a new official JavaScript action');
      assert.equal(match[2],versions[match[1]],name+':'+match[1]);seen.add(match[1]);
    }
    for(const step of source.split(/^      - /m).slice(1).filter(step=>step.startsWith('uses: actions/setup-node@'))){
      assert.match(step,/^          package-manager-cache: false$/m,'only the explicit owned _cacache is restored');
      assert.match(step,/^          node-version: (?:'22\.19\.0'|'26\.7\.0'|\$\{\{ (?:matrix|inputs).node \}\})$/m,'the action runtime does not select test/runtime versions');
    }
    assert.doesNotMatch(source,/FORCE_JAVASCRIPT_ACTIONS_TO_NODE|ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/,'do not hide warnings by forcing an unsupported runtime');
  }
  assert.deepEqual([...seen].sort(),Object.keys(versions).sort());
});

test('macOS CI Cargo diagnostics preserve real gate arguments, sanitized environment and failure status', {skip:process.platform==='win32'}, async t=>{
  const inputs=readInputs(), root=await mkdtemp(join(process.env.TIDY_TEST_ROOT,'mac-cargo-gates-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const neutral=join(root,'neutral'), source=join(neutral,'project'),rust=join(root,'rust'),log=join(root,'calls.jsonl');
  for(const path of [source,join(rust,'bin'),join(root,'native-environment'),join(root,'native-build-inputs')])await mkdir(path,{recursive:true});
  await nativeDescriptor(inputs,root,neutral,rust);await writeFile(join(rust,'bin/rustc'),'inert unused compiler');
  const workflow=await readFile(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const script=shellStep(workflowStep(workflow,'Offline native correctness, strict lint and release build'))
    .replace("node --input-type=module <<'JS'\n","node --input-type=module <<'JS'\nObject.defineProperty(process,'platform',{value:'darwin'});\n");
  assert.match(script,/Object.defineProperty/);
  for(const fail of [false,true]){
    await rm(log,{force:true});
    await writeFile(join(rust,'bin/cargo'),`#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),trace:process.env.CARGO_LOG,ambient:process.env.AMBIENT_POISON,toolchain:process.env.RUSTUP_TOOLCHAIN})+'\\n');
console.error('0.001s INFO cargo::compiler::fingerprint: dirty: FsStatusOutdated(StaleItem(ChangedFile { stale: "PRIVATE_CARGO_PATH" }))');
if(${fail}&&process.argv[2]==='build'){console.error('error: deliberate native failure');process.exitCode=17;}
`,{mode:0o755});
    const result=spawnSync(toolPath('bash'),['-e','-o','pipefail','-c',script],{cwd:repo,env:childEnv(join(root,'caller'),{RUNNER_TEMP:root,RUST_ROOT:rust,NATIVE_SOURCE:source,CARGO_HOME:join(root,'cargo'),CARGO_TARGET_DIR:join(root,'target'),RUST_TARGET:'fixture-target',AMBIENT_POISON:'private'},inputs),encoding:'utf8'});
    assert.equal(result.status,fail?17:0,result.stderr);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
    assert.deepEqual(calls.map(row=>row.args[0]),['fmt','test','clippy','build']);
    for(const call of calls){assert.equal(call.trace,'cargo::compiler::fingerprint=info');assert.equal(call.ambient,undefined);assert.equal(call.toolchain,rust);}
    const summaries=result.stdout.trim().split('\n').filter(line=>line.startsWith('Cargo summary: ')).map(line=>JSON.parse(line.slice('Cargo summary: '.length)));
    assert.equal(summaries.length,4);assert.equal(summaries.at(-1).exitCode,fail?17:0);
    assert.ok(summaries.every(row=>row.sourceChanged===1));assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CARGO_PATH/);
    if(fail)assert.match(result.stderr,/deliberate native failure/);
  }
});
