import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, readInputs } from '../../../scripts/test/context.mjs';
import { snapshotIdentity, sourceIdentity, validateNeutralRunRoot } from '../../../scripts/test/prepare.mjs';
import { prepareNative, readNativeInputs } from '../../../scripts/test/prepare-native.mjs';

const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path, value) => fs.writeFileSync(path, JSON.stringify(value));
const suffix = process.platform === 'win32' ? '.exe' : '';

function fixture(t) {
  const parent = readInputs(), root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'native-preparation-')));
  const checkout = join(root, 'checkout'), output = join(root, 'prepared'), runParent = join(root, 'runs'), rust = join(root, 'rust');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of [checkout, runParent, join(rust, 'bin')]) fs.mkdirSync(directory, { recursive: true });
  const files = {
    '.gitignore': 'node_modules/\n.test-artifacts/\n',
    'package.json': JSON.stringify({ type: 'module', engines: { node: '>=22.19.0' } }),
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.99.0"\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/example"]\n',
    'Cargo.lock': '# source lock\n',
    'crates/example/src/lib.rs': 'pub fn original() {}\n',
    'scripts/release/input.txt': 'unstamped source\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(checkout, name)), { recursive: true }); fs.writeFileSync(join(checkout, name), bytes);
  }
  const environment = childEnv(join(root, 'git-environment'), {}, parent);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    childProcess.execFileSync(parent.tools.git, args, { cwd: checkout, env: environment });
  }
  const npmMarker = join(root, 'npm-invocations'), poisonNpm = join(root, 'poison-npm.mjs');
  fs.writeFileSync(poisonNpm, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(npmMarker)}, 'install\\n'); process.exit(99);\n`);
  const toolsPath = join(root, 'tools.json');
  save(toolsPath, { git: parent.tools.git, tar: parent.tools.tar, npm: poisonNpm });
  const compilers = Object.fromEntries(['cargo', 'rustc'].map(name => [name, join(rust, 'bin', name + suffix)]));
  // These inert files are only unit-test identities. The observer below answers
  // --version; none of these cases claims an actual Rust build/toolchain check.
  for (const path of Object.values(compilers)) fs.writeFileSync(path, 'inert unit-only compiler', { mode: 0o755 });
  fs.mkdirSync(join(checkout, 'node_modules'), { recursive: true });
  fs.writeFileSync(join(checkout, 'node_modules/ambient-pi'), 'must never be copied');
  const options = { root: checkout, output, node: process.execPath, tools: toolsPath, 'rust-root': rust, 'run-root': runParent };
  return { root, checkout, output, runParent, rust, compilers, options, environment, tools: parent.tools, npmMarker, toolsPath };
}

function observe(t, f, { versions = {}, copy, version } = {}) {
  const execute = childProcess.execFileSync, copyFile = fs.cpSync, calls = [], copies = [];
  childProcess.execFileSync = (path, args, options) => {
    const name = Object.keys(f.compilers).find(name => f.compilers[name] === path);
    if (name) {
      calls.push({ name, args, options });
      assert.deepEqual(args, ['--version'], 'preparation must not fetch/build/stamp with Cargo');
      version?.(name, options);
      return `${name} ${versions[name] ?? '1.99.0'} (unit-only)\n`;
    }
    return execute(path, args, options);
  };
  fs.cpSync = (source, destination, options) => {
    copies.push({ source, destination });
    copy?.(source, destination);
    return copyFile(source, destination, options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = execute; fs.cpSync = copyFile; syncBuiltinESMExports(); });
  return { calls, copies };
}

function noDescriptor(f) {
  assert.equal(fs.existsSync(join(f.output, 'inputs.json')), false);
  assert.deepEqual(fs.readdirSync(f.runParent), []);
  assert.equal(fs.existsSync(f.npmMarker), false);
}

test('native preparation materializes verified real Git source with zero npm installations or dependency/cache copies', t => {
  const f = fixture(t), { calls, copies } = observe(t, f);
  const cache = join(f.root, 'ambient-cargo'); fs.mkdirSync(join(cache, 'registry'), { recursive: true });
  fs.writeFileSync(join(cache, 'registry/poison'), 'not an input');
  const previous = process.env.CARGO_HOME; process.env.CARGO_HOME = cache;
  t.after(() => { if (previous === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = previous; });
  const before = sourceIdentity(f.checkout, f.tools, f.environment), inputs = prepareNative(f.options);
  assert.equal(inputs.schema, 1); assert.equal(inputs.kind, 'native-build');
  assert.deepEqual(Object.keys(inputs).sort(), ['kind', 'node', 'preparation', 'project', 'runRoot', 'rust', 'schema', 'source', 'tools', ...(process.platform === 'win32' ? ['systemRoot'] : [])].sort());
  assert.deepEqual(inputs.source, Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'files')));
  assert.equal(inputs.project, join(inputs.runRoot, 'project'));
  assert.match(inputs.runRoot.slice(f.runParent.length + 1), /^tt-/);
  validateNeutralRunRoot(inputs.runRoot);
  assert.deepEqual(snapshotIdentity(inputs.project, before.files), { tree: before.tree, nativeTree: before.nativeTree });
  assert.deepEqual(json(join(inputs.runRoot, 'source-files.json')), before.files);
  assert.deepEqual(readNativeInputs(join(f.output, 'inputs.json')), inputs);
  assert.equal(inputs.node.version, process.version);
  assert.deepEqual(inputs.rust, { root: fs.realpathSync(f.rust), ...f.compilers, home: join(f.output, 'cargo-home'), target: join(f.output, 'cargo-target'), environment: {} });
  assert.deepEqual(calls.map(call => call.name), ['cargo', 'rustc']);
  for (const { options } of calls) {
    assert.equal(options.env.RUSTUP_AUTO_INSTALL, '0');
    assert.equal(options.env.CARGO_HOME, inputs.rust.home);
    assert.equal(options.env.CARGO_TARGET_DIR, inputs.rust.target);
    assert.equal(options.env.RUSTC, inputs.rust.rustc);
    assert.notEqual(options.env.HOME, process.env.HOME);
    assert.equal(options.cwd, f.runParent);
  }
  assert.equal(fs.existsSync(f.npmMarker), false, 'poison npm must observe zero invocations');
  assert.equal(fs.existsSync(join(inputs.project, 'node_modules')), false);
  assert.equal(fs.existsSync(join(inputs.rust.home, 'registry')), false);
  assert.equal(fs.existsSync(join(f.output, 'dependencies')), false);
  assert.equal(copies.some(({ source }) => source.includes('node_modules') || source.startsWith(cache)), false);
  assert.deepEqual(sourceIdentity(f.checkout, f.tools, f.environment), before, 'original checkout remains unstamped and unchanged');
});

test('native preparation accepts modified and untracked sources only with their exact current identities', t => {
  const f = fixture(t); observe(t, f);
  const before = sourceIdentity(f.checkout, f.tools, f.environment);
  fs.writeFileSync(join(f.checkout, 'crates/example/src/lib.rs'), 'pub fn modified() {}\n');
  fs.writeFileSync(join(f.checkout, 'crates/example/build.rs'), 'fn main() {}\n');
  fs.rmSync(join(f.checkout, 'scripts/release/input.txt'));
  const expected = sourceIdentity(f.checkout, f.tools, f.environment), inputs = prepareNative(f.options);
  assert.equal(inputs.source.commit, before.commit);
  assert.notEqual(inputs.source.tree, before.tree); assert.notEqual(inputs.source.nativeTree, before.nativeTree);
  assert.equal(inputs.source.tree, expected.tree); assert.equal(inputs.source.nativeTree, expected.nativeTree);
  assert.equal(fs.readFileSync(join(inputs.project, 'crates/example/src/lib.rs'), 'utf8'), 'pub fn modified() {}\n');
  assert.equal(fs.readFileSync(join(inputs.project, 'crates/example/build.rs'), 'utf8'), 'fn main() {}\n');
  assert.equal(fs.existsSync(join(inputs.project, 'scripts/release/input.txt')), false);
});

for (const marker of ['.git', '.cargo/config', '.cargo/config.toml']) {
  test(`native preparation rejects runtime ancestor ${marker} before accepting source`, t => {
    const f = fixture(t); observe(t, f);
    const poison = join(f.root, 'poison'), parent = join(poison, 'nested');
    fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(dirname(join(poison, marker)), { recursive: true });
    fs.writeFileSync(join(poison, marker), 'poison ancestor');
    assert.throws(() => prepareNative({ ...f.options, 'run-root': parent }), /neutral ancestry/);
    assert.deepEqual(fs.readdirSync(parent), []); noDescriptor(f);
  });
}

for (const name of ['cargo', 'rustc']) {
  test(`native preparation rejects mismatched ${name} without publishing source`, t => {
    const f = fixture(t); observe(t, f, { versions: { [name]: '1.98.0' } });
    assert.throws(() => prepareNative(f.options), /Rust toolchain version mismatch/);
    noDescriptor(f);
  });
}

test('native preparation rejects unsupported options, invalid tools and non-pinned Rust before accepting source', t => {
  const f = fixture(t); observe(t, f);
  for (const values of [{ 'pi-version': '1.0.0' }, { 'cargo-cache': f.root }, { 'build-native': 'true' }, { 'rust-root': 'relative' }, { node: 'relative' }]) {
    assert.throws(() => prepareNative({ ...f.options, ...values }), /options|absolute/); noDescriptor(f);
  }
  save(f.toolsPath, { '../escape': f.tools.git });
  assert.throws(() => prepareNative(f.options), /declared native tools/); noDescriptor(f);
  save(f.toolsPath, { git: 'relative' });
  assert.throws(() => prepareNative(f.options), /absolute/); noDescriptor(f);
  save(f.toolsPath, { git: f.tools.git, tar: f.tools.tar, npm: join(f.root, 'poison-npm.mjs') });
  fs.writeFileSync(join(f.checkout, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
  assert.throws(() => prepareNative(f.options), /exact repository Rust pin/); noDescriptor(f);
});

test('native preparation rejects Node below the repository minimum before copying sources', t => {
  const f = fixture(t), { copies } = observe(t, f);
  fs.writeFileSync(join(f.checkout, 'package.json'), JSON.stringify({ engines: { node: '>=999.0.0' } }));
  assert.throws(() => prepareNative(f.options), /Node runtime.*minimum/);
  assert.equal(copies.some(({ source }) => source.startsWith(f.checkout)), false); noDescriptor(f);
});

test('native preparation never copies a node_modules directory admitted by Git', t => {
  const f = fixture(t); observe(t, f);
  fs.writeFileSync(join(f.checkout, '.gitignore'), '.test-artifacts/\n');
  assert.throws(() => prepareNative(f.options), /must not contain node_modules/); noDescriptor(f);
});

test('native preparation removes only the newly allocated runtime after source-copy failure', t => {
  const f = fixture(t), prior = join(f.runParent, 'tt-prior'); fs.mkdirSync(prior);
  fs.writeFileSync(join(prior, 'keep'), 'earlier success');
  observe(t, f, { copy(source) { if (source.startsWith(f.checkout)) throw new Error('unit copy failure'); } });
  assert.throws(() => prepareNative(f.options), /unit copy failure/);
  assert.deepEqual(fs.readdirSync(f.runParent), ['tt-prior']);
  assert.equal(fs.readFileSync(join(prior, 'keep'), 'utf8'), 'earlier success');
  assert.equal(fs.existsSync(join(f.output, 'inputs.json')), false);
});

test('native preparation rejects a copy that differs from original source and cleans its runtime', t => {
  const f = fixture(t); let changed = false;
  observe(t, f, { copy(source) {
    if (!changed && source.startsWith(f.checkout)) { changed = true; fs.appendFileSync(source, '\nmodified during copy\n'); }
  } });
  assert.throws(() => prepareNative(f.options), /snapshot differs/); noDescriptor(f);
});

test('native and generic test descriptors cannot be substituted; admission preserves original identity after stamping', t => {
  const f = fixture(t); observe(t, f);
  const inputs = prepareNative(f.options), path = join(f.output, 'inputs.json');
  assert.throws(() => readInputs(path), /Invalid prepared test inputs/);
  const generic = join(f.root, 'generic.json'); save(generic, readInputs());
  assert.throws(() => readNativeInputs(generic), /Invalid prepared native-build inputs/);
  fs.appendFileSync(join(inputs.project, 'Cargo.toml'), '\n# deliberately stamped later\n');
  assert.equal(readNativeInputs(path).source.nativeTree, inputs.source.nativeTree, 'reader does not relabel original source after stamping');
  save(path, { ...inputs, project: f.checkout });
  assert.throws(() => readNativeInputs(path), /owned neutral paths/);
  save(path, { ...inputs, pi: readInputs().pi });
  assert.throws(() => readNativeInputs(path), /Invalid prepared native-build inputs/);
  save(path, inputs);
  fs.mkdirSync(join(f.runParent, '.cargo')); fs.writeFileSync(join(f.runParent, '.cargo/config.toml'), 'new ancestor poison');
  assert.throws(() => readNativeInputs(path), /neutral ancestry/);
});

test('native preparation accepts only the explicit Windows build environment allowlist', t => {
  const f = fixture(t); observe(t, f);
  const path = join(f.root, 'build-environment.json'), options = { ...f.options, 'rust-environment': path };
  for (const value of [null, [], { HOME: 'poison' }, { PATH: 42 }, { LIB: 'nul\0poison' }]) {
    save(path, value); assert.throws(() => prepareNative(options), /Only explicit Windows/); noDescriptor(f);
  }
  save(path, { PATH: 'declared-msvc-path', INCLUDE: 'declared-include', LIB: 'declared-lib', LIBPATH: 'declared-libpath' });
  if (process.platform === 'win32') assert.deepEqual(prepareNative(options).rust.environment, json(path));
  else { assert.throws(() => prepareNative(options), /Only explicit Windows/); noDescriptor(f); }
});

test('native preparation CLI rejects Pi/install flags without invoking npm or accepting a source snapshot', t => {
  const f = fixture(t), script = fileURLToPath(new URL('../../../scripts/test/prepare-native.mjs', import.meta.url));
  const result = childProcess.spawnSync(process.execPath, [script, '--root', f.checkout, '--output', f.output,
    '--node', process.execPath, '--tools', f.toolsPath, '--rust-root', f.rust, '--run-root', f.runParent, '--pi-version', '1.0.0'],
  { env: childEnv(join(f.root, 'cli-environment'), {}, readInputs()), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Unknown option '--pi-version'/); noDescriptor(f);
});

test('native preparation CLI writes a native-only descriptor using explicit source/tool/runtime arguments', t => {
  const f = fixture(t), script = fileURLToPath(new URL('../../../scripts/test/prepare-native.mjs', import.meta.url));
  const observer = join(f.root, 'unit-compiler-observer.mjs');
  fs.writeFileSync(observer, `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const original = cp.execFileSync, compilers = ${JSON.stringify(f.compilers)};
    cp.execFileSync = (path, args, options) => {
      const name = Object.keys(compilers).find(name => compilers[name] === path);
      if (!name) return original(path, args, options);
      if (JSON.stringify(args) !== '["--version"]') throw new Error('unit observer prohibits compiler work');
      return name + ' 1.99.0 (unit-only)\\n';
    };
    syncBuiltinESMExports();
  `);
  const result = childProcess.spawnSync(process.execPath, ['--import', pathToFileURL(observer).href, script,
    ...Object.entries(f.options).flatMap(([name, value]) => ['--' + name, value])],
  { env: childEnv(join(f.root, 'cli-environment'), {}, readInputs()), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(f.output, 'inputs.json'));
  assert.equal(readNativeInputs(result.stdout.trim()).kind, 'native-build');
  assert.equal(fs.existsSync(f.npmMarker), false);
});


test('macOS dependency cache cleanup executes package-only debug and release clean after staging, preserving dependencies', t => {
  const f=fixture(t);observe(t,f);const inputs=prepareNative(f.options);
  const repo=join(import.meta.dirname,'../../..'),workflow=fs.readFileSync(join(repo,'.github/workflows/occipital.yml'),'utf8');
  const scripts=[...workflow.matchAll(/node --input-type=module <<'JS'\r?\n([\s\S]*?)\r?\n\s+JS/g)].map(match=>match[1].replace(/^          /gm,''));
  const entries=scripts.filter(script=>script.includes('Native dependency cache summary:'));
  assert.equal(entries.length,1);
  assert.ok(workflow.indexOf('Keep reusable macOS dependencies')>workflow.indexOf('Version smoke, pinned-source notices'));
  const cleanup=workflow.slice(workflow.indexOf('      - name: Keep reusable macOS dependencies'),workflow.indexOf('      - name: Verify original source identity'));
  assert.match(cleanup,/runner\.os == 'macOS' && !inputs\.clean-build && steps\.native-cache\.outputs\.cache-hit != 'true'/);
  assert.match(workflow,/runner\.os == 'macOS' && 'v3-dependencies' \|\| 'v2'/);
  const home=join(f.root,'hosted-cargo'),target=join(f.root,'target'),log=join(f.root,'clean.jsonl');
  for(const [name,text]of [['hosted-cargo/registry/input','dependency'],['target/debug/deps/dependency.rlib','cached-dependency'],['target/debug/workspace','debug'],['target/release/workspace','release'],['staged/occipital','verified-binary']]){
    fs.mkdirSync(dirname(join(f.root,name)),{recursive:true});fs.writeFileSync(join(f.root,name),text);
  }
  fs.mkdirSync(join(f.root,'native-build-inputs'));save(join(f.root,'native-build-inputs/inputs.json'),inputs);
  const imports=entries[0].replace(/from '(\.\/scripts\/test\/[^']+)'/g,(_all,name)=>`from ${JSON.stringify(pathToFileURL(join(repo,name)).href)}`);
  const source=imports.replace("import {spawnSync} from 'node:child_process';",`import {appendFileSync,rmSync} from 'node:fs';
const spawnSync=(command,args,options)=>{
  appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args,cwd:options.cwd,home:options.env.CARGO_HOME,target:options.env.CARGO_TARGET_DIR,toolchain:options.env.RUSTUP_TOOLCHAIN,ambient:options.env.AMBIENT_POISON})+'\\n');
  const profile=args.includes('--release')?'release':'debug';
  if(process.env.FAIL_CLEAN===profile)return {status:71};
  rmSync(${JSON.stringify(target)}+'/'+profile+'/workspace',{force:true});return {status:0};
};`);
  assert.notEqual(source,imports,'Execute the actual workflow body through the subprocess seam');
  const env=childEnv(join(f.root,'workflow-environment'),{RUNNER_TEMP:f.root,NATIVE_SOURCE:inputs.project,CARGO_HOME:home,CARGO_TARGET_DIR:target,RUST_TARGET:'x86_64-apple-darwin',AMBIENT_POISON:'must-not-reach-clean'},readInputs());
  const run=extra=>childProcess.spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:repo,env:{...env,...extra},encoding:'utf8'});
  const result=run({});assert.equal(result.status,0,result.stderr);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,2);
  for(const [index,call]of calls.entries()){
    assert.equal(call.command,inputs.rust.cargo);assert.equal(call.cwd,inputs.project);assert.equal(call.toolchain,inputs.rust.root);assert.equal(call.ambient,undefined);
    assert.deepEqual(call.args,['clean','--offline','--package','occipital','--target','x86_64-apple-darwin',...(index?['--release']:[])]);
    assert.equal(call.home,home);assert.equal(call.target,target);
  }
  assert.equal(fs.readFileSync(join(target,'debug/deps/dependency.rlib'),'utf8'),'cached-dependency');
  assert.equal(fs.readFileSync(join(home,'registry/input'),'utf8'),'dependency');
  assert.equal(fs.readFileSync(join(f.root,'staged/occipital'),'utf8'),'verified-binary');
  assert.equal(fs.existsSync(join(target,'debug/workspace')),false);assert.equal(fs.existsSync(join(target,'release/workspace')),false);
  assert.match(result.stdout,/Native dependency cache summary:/);
  for(const profile of ['debug','release']){
    fs.writeFileSync(log,'');const failed=run({FAIL_CLEAN:profile});assert.equal(failed.status,71,failed.stderr);
    const seen=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(seen.length,profile==='debug'?1:2);
    assert.doesNotMatch(failed.stdout,/Native dependency cache summary:/);
  }
});
