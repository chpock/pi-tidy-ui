import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { childEnv, readInputs, toolPath } from '../scripts/test/context.mjs';

const inputs = readInputs(), repo = resolve(import.meta.dirname, '..');
const skip = process.platform === 'win32';
const make = skip ? '' : toolPath('make', inputs), bash = skip ? '' : toolPath('bash', inputs);
if (!skip) assert.match(spawnSync(make, ['--version'], { env: childEnv(join(process.env.TIDY_TEST_ROOT!, 'make-prerequisite')), encoding: 'utf8' }).stdout, /GNU Make/);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(process.env.TIDY_TEST_ROOT!, 'tidy-make space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['Makefile', 'rust-toolchain.toml', 'scripts/release', 'scripts/test', 'src/occipital/version.ts']) {
    await mkdir(resolve(root, file, '..'), { recursive: true });
    await cp(join(repo, file), join(root, file), { recursive: true });
  }
  const bin = join(root, 'bin'), log = join(root, 'commands.jsonl'), control = join(root, 'control.json');
  await mkdir(bin); await mkdir(join(root, 'cargo-home')); await writeFile(join(root, 'inputs.json'), '{}');
  await writeFile(control, '{}');
  await mkdir(join(root, '.cargo')); await writeFile(join(root, '.cargo/config.toml'), '[build]\nincremental = false\n');
  // Real Make/Bash execute the recipes. Inert tools observe order and fail-closed routing.
  const stub = `#!${process.execPath}
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=${JSON.stringify(root)}, tool=basename(process.argv[1]), args=process.argv.slice(2), control=JSON.parse(readFileSync(${JSON.stringify(control)}));
if(tool==='node' && args[0]==='-e') process.exit(0);
if(tool==='uname') {console.log(control.arch ?? 'x86_64');process.exit(0);}
if(tool==='getconf') {console.log('glibc '+(control.baseline ?? '2.28'));process.exit(0);}
if(tool==='node' && args.includes('--input-type=module')) {
 const r=spawnSync(${JSON.stringify(process.execPath)},args,{env:process.env,stdio:'inherit'});process.exit(r.status??1);
}
appendFileSync(${JSON.stringify(log)},JSON.stringify({tool,args,offline:process.env.CARGO_NET_OFFLINE,home:process.env.CARGO_HOME,testRoot:process.env.TIDY_TEST_ROOT,autoInstall:process.env.RUSTUP_AUTO_INSTALL,toolchain:process.env.RUSTUP_TOOLCHAIN,ambient:process.env.AMBIENT_POISON,cwd:process.cwd(),repoConfig:tool==='cargo' && args[0]!=='--version' ? readFileSync(join(process.cwd(),'.cargo/config.toml'),'utf8'):undefined})+'\\n');
if(args[0]==='--version') {
 if(control.missing) {console.error('pinned toolchain is not installed');process.exit(69);}
 console.log(tool+' '+(control.rust??'1.99.0')+' (fixture)');process.exit(0);
}
if(args[0]===control.fail || args.includes(control.fail)) process.exit(71);
if(tool==='docker') {
 if(args[0]!=='run') process.exit(0);
 const env={PATH:${JSON.stringify(bin)}+':/usr/bin:/bin'};
 for(let i=0;i<args.length;i++) if(args[i]==='--env') {const pair=args[++i], n=pair.indexOf('=');if(n>=0)env[pair.slice(0,n)]=pair.slice(n+1);}
 env.HOME=join(root,'docker-home');
 const result=spawnSync(${JSON.stringify(bash)},args.slice(args.indexOf('bash')+1),{env,stdio:'inherit'});process.exit(result.status??1);
}
if(tool==='readelf') {console.log('  0x0010:   Name: GLIBC_'+(control.glibc??'2.28')+'  Flags: none  Version: 2');process.exit(0);}
if(tool==='cargo' && args[0]==='build') {
 const i=args.indexOf('--target'), target=i<0?'':args[i+1], path=join(process.env.CARGO_TARGET_DIR,target,'release');mkdirSync(path,{recursive:true});
 writeFileSync(join(path,'occipital'),'inert executable\\n',{mode:0o700});
}
`;
  for (const name of ['node', 'npm', 'cargo', 'rustc', 'readelf', 'docker', 'uname', 'getconf']) {
    await writeFile(join(bin, name), stub); await chmod(join(bin, name), 0o700);
  }
  const env = childEnv(join(root, 'environment'), { PATH: bin + ':' + inputs.tools.bin,
    NODE: join(bin, 'node'), NPM: join(bin, 'npm'), RUST_ROOT: root, CARGO_HOME: join(root, 'cargo-home'), CARGO_TARGET_DIR: join(root, 'custom target'), INPUTS: join(root, 'inputs.json'), EXPECTED_NODE: '22.19.0', RUSTUP_TOOLCHAIN: 'ambient-toolchain-must-not-win', AMBIENT_POISON: 'must-not-reach-rust' });
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(make, ['--no-print-directory', ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  const entries = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
  const set = (value: object) => writeFile(control, JSON.stringify(value));
  const gnu = (target: string) => spawnSync(bash, ['scripts/release/linux-gnu.sh', target], { cwd: root, env, encoding: 'utf8' });
  const installed = (suite: string, ref = '') => spawnSync(bash, ['scripts/release/installed-linux-gnu.sh', 'x86_64-unknown-linux-gnu', suite, root, join(root, 'artifact'), ref], { cwd: root, env, encoding: 'utf8' });
  return { root, env, run, entries, set, gnu, installed };
}

test('Makefile defaults to help without executing preparation, build or tests', { skip }, async t => {
  const f = await fixture(t), result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['build', 'check', 'test', 'test-gc', 'test-focus', 'test-native', 'test-syntax', 'test-terminal', 'test-release', 'test-installed']) assert.match(result.stdout, new RegExp('\\b'+name+'\\b'));
  assert.deepEqual(await f.entries(), []);
});

test('Makefile selected suites require explicit prepared inputs, never a colocated helper', { skip }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'occipital'), 'stale same-version helper', { mode: 0o700 });
  for (const target of ['check', 'test', 'test-gc', 'test-native', 'test-syntax', 'test-terminal', 'test-release', 'test-installed', 'native-smoke', 'test-rust', 'test-rust-harness', 'check-native']) {
    const result = f.run([target, 'INPUTS=']); assert.notEqual(result.status, 0); assert.match(result.stderr, /INPUTS/);
  }
  assert.deepEqual(await f.entries(), []);
  const result = f.run(['check', 'test', 'test-gc', 'test-native', 'test-syntax', 'test-terminal', 'test-release', 'test-installed', 'test-rust', 'test-rust-harness', 'check-native']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.entries()).map(e => e.args), ['check', 'unit', 'unit', 'native', 'syntax-terminal', 'terminal', 'native-release', 'consumer', 'rust', 'rust-harness', 'rust-check'].map(suite => ['scripts/test/run.mjs', '--inputs', f.env.INPUTS, '--suite', suite]));
});

test('Makefile focused routing preserves exact filenames/pattern and runner failures', { skip }, async t => {
  const f = await fixture(t); assert.notEqual(f.run(['test-focus']).status, 0); assert.deepEqual(await f.entries(), []);
  const pattern = "^bash 'quoted'|color \\\"cell\\\"$";
  const result = f.run(['test-focus', 'TEST_FILES=one.test.ts,two.test.ts', `TEST_PATTERN=${pattern}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.entries())[0].args, ['scripts/test/run.mjs', '--inputs', f.env.INPUTS, '--suite', 'unit', '--files', 'one.test.ts,two.test.ts', '--pattern', pattern]);
  await f.set({ fail: 'scripts/test/run.mjs' }); assert.notEqual(f.run(['test-native']).status, 0);
});

test('Makefile offline build requires explicit owned stores and pinned compiler without auto-install', { skip }, async t => {
  const f = await fixture(t);
  assert.notEqual(f.run(['build', 'RUST_ROOT=']).status, 0);
  await f.set({ rust: '1.98.0' }); assert.notEqual(f.run(['build']).status, 0);
  await f.set({ missing: true }); assert.notEqual(f.run(['build'], { RUSTUP_AUTO_INSTALL: '1' }).status, 0);
  await f.set({});
  const result = f.run(['build', 'RUST_TARGET=x86_64-unknown-linux-gnu']); assert.equal(result.status, 0, result.stderr);
  const build = (await f.entries()).find(e => e.args[0] === 'build');
  assert.deepEqual(build.args, ['build', '--release', '--locked', '--offline', '-p', 'occipital', '--target', 'x86_64-unknown-linux-gnu']);
  assert.equal(build.cwd.startsWith(f.root), false, 'Cargo cannot discover checkout ancestor config');
  assert.equal(build.repoConfig, await readFile(join(f.root,'.cargo/config.toml'),'utf8'), 'owned repo Cargo config survives snapshot materialization');
  await assert.rejects(readFile(join(build.cwd, '.cargo/config.toml')), {code:'ENOENT'}, 'temporary native working tree is cleaned after build');
  assert.equal(build.offline, 'true'); assert.equal(build.autoInstall, '0'); assert.equal(build.toolchain, f.root); assert.equal(build.ambient, undefined); assert.ok(build.testRoot);
  assert.equal(await readFile(join(f.root, 'occipital'), 'utf8'), 'inert executable\n');
  await writeFile(join(f.env.CARGO_HOME!, 'config.toml'), '[net]\noffline=false\n');
  assert.notEqual(f.run(['build']).status, 0, 'user Cargo configuration is not admitted');
});

test('GNU native gate orders offline fmt/tests/allocator/lint/build/ABI and stops before later phases on failure', { skip }, async t => {
  const f = await fixture(t), result = f.run(['-j4', '_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu']);
  assert.equal(result.status, 0, result.stderr);
  const entries = (await f.entries()).filter(e => e.args[0] !== '--version');
  assert.deepEqual(entries.map(e => e.tool === 'cargo' ? e.args[0] : 'abi'), ['fmt', 'test', 'test', 'clippy', 'build', 'abi']);
  for (const e of entries.filter(e => e.tool === 'cargo')) { assert.equal(e.offline, 'true'); assert.equal(e.autoInstall, '0'); assert.equal(e.toolchain, f.root); assert.equal(e.ambient, undefined); if(e.args[0] !== 'fmt') { assert.ok(e.args.includes('--offline')); assert.ok(e.args.includes('--locked')); assert.ok(e.args.includes('x86_64-unknown-linux-gnu')); } }
  assert.ok(entries[2].args.includes('allocator_diagnostic_tracks_the_actual_glibc_api'));
  await rm(join(f.root, 'commands.jsonl')); await f.set({ fail: 'clippy' });
  assert.notEqual(f.run(['-j4', '_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu']).status, 0);
  assert.equal((await f.entries()).some(e => e.args[0] === 'build' || e.tool === 'readelf'), false);
});

test('GNU wrapper executes native architecture/glibc2.28 offline checks with explicit SDK mounts', { skip }, async t => {
  for (const [target, arch] of [['x86_64-unknown-linux-gnu', 'x86_64'], ['aarch64-unknown-linux-gnu', 'aarch64']]) {
    const f = await fixture(t); await f.set({ arch }); const result = f.gnu(target);
    assert.equal(result.status, 0, result.stderr);
    const entries = await f.entries(), docker = entries.filter(e => e.tool === 'docker');
    assert.equal(docker.length, 3); assert.ok(docker[1].args.includes('--cache-from')); assert.ok(docker[2].args.includes('--network=none'));
    assert.ok(docker[2].args.includes(`${f.root}:${f.root}:ro`));
    assert.ok(docker[2].args.includes(`RUSTUP_TOOLCHAIN=${f.root}`), 'container selects the declared mounted Rust root before Make sanitizes again');
    for (const e of entries.filter(e => e.tool === 'cargo')) assert.equal(e.toolchain, f.root);
    assert.deepEqual(entries.filter(e => e.tool === 'cargo' && e.args[0] !== '--version').map(e => e.args[0]), ['fmt', 'test', 'test', 'clippy', 'build']);
    assert.equal(entries.filter(e => e.tool === 'readelf').length, 1);
  }
});

test('GNU wrapper rejects invalid architecture/userspace and ABI failure cannot pass', { skip }, async t => {
  for (const [target, control] of [['invalid', {}], ['aarch64-unknown-linux-gnu', { arch: 'x86_64' }], ['x86_64-unknown-linux-gnu', { baseline: '2.34' }]] as [string, object][]) {
    const f = await fixture(t); await f.set(control); assert.notEqual(f.gnu(target).status, 0);
    assert.equal((await f.entries()).some(e => e.tool === 'cargo'), false);
  }
  const f = await fixture(t); await f.set({ glibc: '2.34' });
  const result = f.run(['_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exceeds glibc 2\.28/);
});

test('GNU native smoke and consumer use offline container-local preparation, not public fallback', { skip }, async t => {
  for (const suite of ['native', 'consumer']) {
    const f = await fixture(t), result = f.installed(suite); assert.equal(result.status, 0, result.stderr);
    const entries = await f.entries(), container = entries.find(e => e.tool === 'docker' && e.args[0] === 'run');
    assert.ok(container.args.includes('--network=none'));
    const calls = entries.filter(e => e.tool === 'node'); assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes('--offline')); assert.ok(calls[0].args.includes('--archives')); assert.ok(calls[0].args.includes('--native-artifact')); assert.ok(calls[0].args.includes('--npm-cache'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--registry-inputs')+1], join(f.root,'inputs.json'), 'frozen registry metadata/locks, not cache alone, must survive offline replay');
    assert.deepEqual(calls[1].args.slice(0, 5), ['scripts/test/run.mjs', '--inputs', join(f.root, 'gnu/inputs.json'), '--suite', suite]);
    await rm(join(f.root, 'commands.jsonl')); await f.set({ fail: 'scripts/test/prepare.mjs' });
    assert.notEqual(f.installed(suite).status, 0); assert.equal((await f.entries()).some(e => e.args[0] === 'scripts/test/run.mjs'), false);
  }
});

test('GNU published consumer is an explicit extension-release-only networked runner', { skip }, async t => {
  const f = await fixture(t);
  for (const ref of ['', 'refs/heads/main', 'refs/pull/1/merge', 'refs/tags/occipital-v0.1.5']) assert.notEqual(f.installed('published-consumer', ref).status, 0);
  assert.deepEqual(await f.entries(), []);
  const ref = 'refs/tags/pi-tidy-ui-v0.2.0', result = f.installed('published-consumer', ref); assert.equal(result.status, 0, result.stderr);
  const entries = await f.entries(); assert.equal(entries.find(e => e.tool === 'docker' && e.args[0] === 'run').args.includes('--network=none'), false);
  const calls = entries.filter(e => e.tool === 'node'); assert.equal(calls[0].args.includes('--native-artifact'), false);
  assert.deepEqual(calls[1].args.slice(-4), ['--suite', 'published-consumer', '--release-ref', ref]);
});

test('GNU wrapper retains only safe neutral-source diagnostics before the container exits, including failed suites', { skip }, async t => {
  const f = await fixture(t), source = join(f.root,'neutral-source'), reports = join(source,'.test-artifacts/installed-preparation-safe');
  await mkdir(reports,{recursive:true}); await mkdir(join(f.root,'gnu'));
  await writeFile(join(f.root,'gnu/inputs.json'),JSON.stringify({pi:{root:source}}));
  for (const file of ['fixture.json','npm.json','raw-debug-0.log','inputs.json']) await writeFile(join(reports,file),'{}');
  let result = f.installed('consumer'); assert.equal(result.status,0,result.stderr);
  const output = join(f.root,'gnu/diagnostics/installed-preparation-safe');
  assert.deepEqual((await readdir(output)).sort(),['fixture.json','npm.json']);
  await f.set({fail:'scripts/test/run.mjs'}); await writeFile(join(reports,'fixture.json'),'{"status":"failed"}');
  result = f.installed('consumer'); assert.notEqual(result.status,0,'retention must not turn a failed suite green');
  assert.equal(await readFile(join(output,'fixture.json'),'utf8'),'{"status":"failed"}');
});

test('GNU consumer retains linked-worktree source metadata through an explicit read-only mount', { skip }, async t => {
  const f = await fixture(t), common = await mkdtemp(join(process.env.TIDY_TEST_ROOT!, 'external git '));
  t.after(() => rm(common, { recursive: true, force: true }));
  const gitDir = join(common, 'worktrees', 'fixture'); await mkdir(gitDir, { recursive: true });
  await writeFile(join(f.root, '.git'), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  f.env.GIT_DIR = '/ambient-must-not-select-source-metadata';
  const result = f.installed('consumer'); assert.equal(result.status, 0, result.stderr);
  const docker = (await f.entries()).find(entry => entry.tool === 'docker' && entry.args[0] === 'run');
  assert.ok(docker);
  const canonical = await realpath(common);
  assert.equal(docker.args.includes(`${canonical}:${canonical}:ro`), true);
  assert.equal(docker.args.includes('--network=none'), true);
  assert.equal(await readFile(join(f.root, '.git'), 'utf8'), `gitdir: ${gitDir}\n`);
});
