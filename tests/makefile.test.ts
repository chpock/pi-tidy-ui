import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const available = spawnSync('make', ['--version'], { encoding: 'utf8' });
const skip = process.platform === 'win32' || !available.stdout?.includes('GNU Make');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-make space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['Makefile', 'rust-toolchain.toml', 'scripts/release', 'src/occipital/version.ts']) {
    const destination = join(root, file);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await cp(join(repo, file), destination, { recursive: true });
  }
  const bin = join(root, 'bin'), log = join(root, 'commands.jsonl');
  await mkdir(bin);
  // Inert executors check actual make routing/order without compiling, testing or network access.
  const stub = `#!${process.execPath}
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {spawnSync} from 'node:child_process';
const tool=basename(process.argv[1]), args=process.argv.slice(2);
if(tool==='node' && args[0]==='-p') { console.log(join(process.env.MAKE_TEST_ROOT,'bin','node')); process.exit(0); }
if(tool==='rustc' && args[0]==='--print') { console.log(process.env.MAKE_TEST_ROOT); process.exit(0); }
if(tool==='uname') { console.log(process.env.MAKE_TEST_ARCH??'x86_64'); process.exit(0); }
if(tool==='getconf') { console.log('glibc '+(process.env.MAKE_TEST_BASELINE??'2.28')); process.exit(0); }
if(tool==='node' && args.includes('--input-type=module')) {
  const r=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'}); process.exit(r.status??1);
}
appendFileSync(process.env.MAKE_TEST_LOG,JSON.stringify({tool,args,term:process.env.TERM,color:process.env.COLORTERM,offline:process.env.CARGO_NET_OFFLINE,helper:process.env.OCCIPITAL_TEST_BIN,toolchain:process.env.RUSTUP_TOOLCHAIN,autoInstall:process.env.RUSTUP_AUTO_INSTALL})+'\\n');
if(process.env.MAKE_TEST_RUST_MISSING==='1' && (tool==='cargo' || tool==='rustc')) {
  if(process.env.RUSTUP_AUTO_INSTALL==='0') { console.error('pinned toolchain is not installed'); process.exit(69); }
  writeFileSync(join(process.env.MAKE_TEST_ROOT,'compiler-install-attempt'), 'attempted');
}
if(args[0]==='--version') { console.log(tool+' '+(process.env.MAKE_TEST_RUST??'1.99.0')+' (fixture)'); process.exit(0); }
if(args[0]===process.env.MAKE_TEST_FAIL) process.exit(71);
if(tool==='docker') {
  if(args[0]!=='run') process.exit(0);
  const env={...process.env};
  for(let i=0;i<args.length;i++) if(args[i]==='--env') { const pair=args[++i], split=pair.indexOf('='); if(split>=0)env[pair.slice(0,split)]=pair.slice(split+1); }
  env.HOME=join(process.env.MAKE_TEST_ROOT,'docker-home');
  const r=spawnSync('bash',args.slice(args.indexOf('bash')+1),{env,stdio:'inherit'}); process.exit(r.status??1);
}
if(tool==='readelf') { console.log('  0x0010:   Name: GLIBC_'+(process.env.MAKE_TEST_GLIBC??'2.28')+'  Flags: none  Version: 2'); process.exit(0); }
if(tool==='cargo' && args[0]==='build') {
  const i=args.indexOf('--target'), target=i<0?'':args[i+1];
  const path=join(process.env.CARGO_TARGET_DIR,target,'release'); mkdirSync(path,{recursive:true});
  writeFileSync(join(path,'occipital'), 'inert executable\\n',{mode:0o700});
}
`;
  for (const name of ['node', 'npm', 'cargo', 'rustc', 'readelf', 'docker', 'uname', 'getconf']) {
    await writeFile(join(bin, name), stub); await chmod(join(bin, name), 0o700);
  }
  await mkdir(join(root, 'cargo-home'));
  const env = { ...process.env, MAKEFLAGS: '', MAKEOVERRIDES: '', MFLAGS: '', MAKELEVEL: '0', TEST_FILES: '', TEST_PATTERN: '',
    OCCIPITAL_TEST_BIN: undefined, RUST_TARGET: '', CARGO_BUILD_TARGET: undefined, CARGO_NET_OFFLINE: undefined,
    MAKE_TEST_ROOT: root, CARGO_HOME: join(root, 'cargo-home'), NODE: join(bin, 'node'), NPM: join(bin, 'npm'), CARGO: join(bin, 'cargo'), RUSTC: join(bin, 'rustc'),
    CARGO_TARGET_DIR: join(root, 'custom target'), MAKE_TEST_LOG: log, PATH: bin + ':' + process.env.PATH };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync('make', ['--no-print-directory', ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  const entries = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } };
  const gnu = (target: string, extra: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['scripts/release/linux-gnu.sh', target], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  return { root, env, run, entries, gnu };
}

test('Makefile defaults to help without invoking build/test/network executors', { skip }, async t => {
  const f = await fixture(t), result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['build', 'check', 'test', 'test-gc', 'test-focus', 'test-native', 'test-syntax', 'test-terminal', 'test-release', 'test-installed']) assert.match(result.stdout, new RegExp('\\b'+name+'\\b'));
  assert.deepEqual(await f.entries(), []);
});

test('Makefile npm shortcuts retain canonical scripts and keep installed/network checks opt-in', { skip }, async t => {
  const f = await fixture(t), result = f.run(['check', 'test', 'test-release', 'pack-check', 'test-installed']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.entries()).map(e => e.args), [['run', 'check'], ['test'], ['run', 'test:native-release'], ['pack', '--dry-run', '--ignore-scripts'], ['run', 'test:installed-native']]);
});

test('Makefile GC/focused modes enable ownership checks, preserve exact patterns and require selected files', { skip }, async t => {
  const f = await fixture(t);
  assert.notEqual(f.run(['test-focus']).status, 0);
  assert.deepEqual(await f.entries(), []);
  const pattern = "^bash 'quoted'|color \\\"cell\\\"$";
  const result = f.run(['test-focus', 'TEST_FILES=tests/one.test.ts tests/two.test.ts', `TEST_PATTERN=${pattern}`, 'test-gc']);
  assert.equal(result.status, 0, result.stderr);
  const entries = await f.entries();
  assert.deepEqual(entries[0].args, ['--expose-gc', '--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, 'tests/one.test.ts', 'tests/two.test.ts']);
  for (const e of entries) { assert.equal(e.term, 'xterm-256color'); assert.equal(e.color, 'truecolor'); assert.ok(e.args.includes('--expose-gc')); }
  assert.ok(entries[1].args.includes('--test-concurrency=2'));
});

test('Makefile native and syntax modes refuse a missing helper instead of a green skipped suite', { skip }, async t => {
  const f = await fixture(t);
  for (const target of ['test-native', 'test-syntax', 'native-smoke']) {
    const result = f.run([target]); assert.notEqual(result.status, 0); assert.match(result.stderr, /Occipital|helper/);
  }
  assert.deepEqual(await f.entries(), []);
  const helper = join(f.root, 'existing helper'); await writeFile(helper, 'inert', { mode: 0o700 });
  const result = f.run(['test-native', 'test-syntax', `OCCIPITAL_TEST_BIN=${helper}`]);
  assert.equal(result.status, 0, result.stderr);
  const entries = await f.entries();
  assert.equal(entries[0].helper, helper); assert.ok(entries[0].args.includes('--expose-gc'));
  assert.equal(entries[1].helper, helper); assert.deepEqual(entries[1].args, ['run', 'test:syntax-terminal']);
});

test('Makefile build copies only the chosen locked native output and refuses the wrong compiler', { skip }, async t => {
  const f = await fixture(t);
  const wrong = f.run(['build'], { MAKE_TEST_RUST: '1.98.0' });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /1\.99\.0/);
  assert.equal((await f.entries()).some(e => e.args[0] === 'build'), false);
  await rm(join(f.root, 'commands.jsonl'));
  const result = f.run(['build', 'RUST_TARGET=x86_64-unknown-linux-gnu']);
  assert.equal(result.status, 0, result.stderr);
  const build = (await f.entries()).find(e => e.args[0] === 'build');
  assert.deepEqual(build.args, ['build', '--release', '--locked', '-p', 'occipital', '--target', 'x86_64-unknown-linux-gnu']);
  assert.equal(build.autoInstall, '0');
  assert.equal(await readFile(join(f.root, 'occipital'), 'utf8'), 'inert executable\n');
});

test('Makefile refuses a missing pinned compiler without implicitly installing it, even if host Rustup enables installation', { skip }, async t => {
  const f = await fixture(t);
  for (const target of ['build', 'test-rust', 'check-native']) {
    const result = f.run([target], { MAKE_TEST_RUST_MISSING: '1', RUSTUP_AUTO_INSTALL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned toolchain is not installed/);
  }
  await assert.rejects(readFile(join(f.root, 'compiler-install-attempt')), { code: 'ENOENT' });
  const entries = await f.entries();
  assert.equal(entries.length, 3);
  for (const e of entries) { assert.deepEqual(e.args, ['--version']); assert.equal(e.autoInstall, '0'); }
});

test('Makefile GNU gate preserves ordered offline tests, allocator diagnostic, strict lint, build, ABI and actual smoke', { skip }, async t => {
  const f = await fixture(t);
  const result = f.run(['-j4', '_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu'], { CARGO_NET_OFFLINE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  const entries = (await f.entries()).filter(e => e.args[0] !== '--version');
  assert.deepEqual(entries.map(e => e.tool === 'cargo' ? e.args[0] : e.tool === 'readelf' ? 'abi' : 'smoke'), ['test', 'test', 'clippy', 'build', 'abi', 'smoke']);
  for (const e of entries.filter(e => e.tool === 'cargo')) { assert.ok(e.args.includes('--locked')); assert.equal(e.offline, 'true'); assert.equal(e.autoInstall, '0'); assert.deepEqual(e.args.slice(e.args.indexOf('--target'), e.args.indexOf('--target') + 2), ['--target', 'x86_64-unknown-linux-gnu']); }
  assert.ok(entries[1].args.includes('allocator_diagnostic_tracks_the_actual_glibc_api'));
  assert.deepEqual(entries[2].args.slice(-3), ['--', '-D', 'warnings']);
  assert.deepEqual(entries[4].args, ['--wide', '--version-info', join(f.env.CARGO_TARGET_DIR, 'x86_64-unknown-linux-gnu', 'release', 'occipital')]);
  assert.ok(entries[5].args.includes('--test-name-pattern=^actual owned helper preserves compact UTF8 highlighting and incremental work counters$'));
  await rm(join(f.root, 'commands.jsonl'));
  const failed = f.run(['-j4', '_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu'], { CARGO_NET_OFFLINE: 'true', MAKE_TEST_FAIL: 'clippy' });
  assert.notEqual(failed.status, 0);
  assert.equal((await f.entries()).some(e => e.args[0] === 'build' || e.tool === 'readelf' || e.args.includes('--test')), false);
});

test('GNU release wrapper executes the Make gate with native/offline SDK isolation and image cache reuse', { skip }, async t => {
  for (const [target, architecture] of [['x86_64-unknown-linux-gnu', 'x86_64'], ['aarch64-unknown-linux-gnu', 'aarch64']]) {
    const f = await fixture(t), result = f.gnu(target, { MAKE_TEST_ARCH: architecture });
    assert.equal(result.status, 0, result.stderr);
    const entries = await f.entries(), docker = entries.filter(e => e.tool === 'docker');
    assert.equal(docker.length, 3);
    assert.ok(docker[1].args.includes('--cache-from'));
    assert.ok(docker[2].args.includes('--network=none')); assert.ok(docker[2].args.includes('--user'));
    const phases = entries.filter(e => e.tool === 'cargo' && e.args[0] !== '--version');
    assert.deepEqual(phases.map(e => e.args[0]), ['test', 'test', 'clippy', 'build']);
    for (const e of phases) { assert.equal(e.offline, 'true'); assert.equal(e.toolchain, f.root); assert.ok(e.args.includes(target)); assert.ok(e.args.includes('--locked')); }
    assert.equal(entries.filter(e => e.tool === 'readelf').length, 1);
    assert.equal(entries.filter(e => e.tool === 'node' && e.args.includes('--test')).length, 1);
  }
});

test('GNU release wrapper refuses nonnative/invalid targets and a wrong userspace before native work', { skip }, async t => {
  for (const [target, extra] of [
    ['unrecognized-target', {}],
    ['aarch64-unknown-linux-gnu', { MAKE_TEST_ARCH: 'x86_64' }],
    ['x86_64-unknown-linux-gnu', { MAKE_TEST_BASELINE: '2.34' }],
  ] as [string, NodeJS.ProcessEnv][]) {
    const f = await fixture(t), result = f.gnu(target, extra);
    assert.notEqual(result.status, 0);
    assert.equal((await f.entries()).some(e => e.tool === 'cargo'), false);
  }
});

test('Makefile GNU ABI rejection prevents the actual-helper smoke instead of masking a failed guard', { skip }, async t => {
  const f = await fixture(t), result = f.run(['_gnu-native', 'RUST_TARGET=x86_64-unknown-linux-gnu'], { CARGO_NET_OFFLINE: 'true', MAKE_TEST_GLIBC: '2.34' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exceeds glibc 2\.28/);
  const entries = await f.entries();
  assert.equal(entries.filter(e => e.tool === 'readelf').length, 1);
  assert.equal(entries.some(e => e.tool === 'node' && e.args.includes('--test')), false);
});
