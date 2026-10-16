import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnv, validateNative, validateHost, readInputs } from '../../scripts/test/context.mjs';
import { execute, isolatedCommand, selectSuite } from '../../scripts/test/run.mjs';
import { discoverEntries, resolveSelection, testEntries } from '../../scripts/test/catalog.mjs';
import { dependencyIdentity, materializeSource, materializeTools, refreshInputs, snapshotIdentity, sourceIdentity, validateNeutralRunRoot } from '../../scripts/test/prepare.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = { schema: 1, node: { path: process.execPath, version: process.version },
    tools: { bin: join(root, 'bin') }, source: { commit: 'a'.repeat(40), nativeTree: 'b'.repeat(64) } };
  mkdirSync(inputs.tools.bin);
  return { root, inputs };
}

test('test environment excludes ambient Pi, credentials, proxies and Node startup controls', t => {
  const { root, inputs } = fixture(t);
  const poison = { HOME: '/wrong-home', PATH: '/wrong-bin', PI_CODING_AGENT_DIR: '/wrong-agent',
    API_KEY: 'secret', HTTPS_PROXY: 'http://wrong-proxy', NODE_OPTIONS: '--require=/wrong-code',
    NODE_PATH: '/wrong-modules', GIT_CONFIG_GLOBAL: '/wrong-git', npm_config_registry: 'https://wrong-registry' };
  const previous = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  Object.assign(process.env, poison);
  const env = childEnv(root, {}, inputs);
  assert.equal(env.PATH, inputs.tools.bin);
  assert.equal(env.HOME, join(root, 'home'));
  assert.equal(env.PI_CODING_AGENT_DIR, join(root, 'agent'));
  for (const key of ['API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'NODE_PATH']) assert.equal(env[key], undefined);
  assert.notEqual(env.GIT_CONFIG_GLOBAL, poison.GIT_CONFIG_GLOBAL);
  assert.notEqual(env.npm_config_registry, poison.npm_config_registry);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.TZ, 'UTC');
});

test('runtime roots never inherit the tested checkout repository ancestry', () => {
  const inputs = readInputs(), checkout = realpathSync(inputs.source.root), runtime = realpathSync(inputs.runRoot);
  assert.notEqual(runtime, checkout);
  assert.equal(runtime.startsWith(checkout + sep), false);
  assert.equal(realpathSync(inputs.pi.root).startsWith(runtime + sep), true);
  assert.equal(realpathSync(inputs.pi.root).startsWith(checkout + sep), false);
});

test('Linux network namespace preserves trusted filesystem ancestry and real local HTTP without public egress', { skip: process.platform !== 'linux' }, async t => {
  const { root } = fixture(t), inputs = readInputs();
  const probe = `
    import { statSync } from 'node:fs'; import { dirname } from 'node:path';
    import { createServer } from 'node:http'; import { createConnection } from 'node:net';
    let trusted = true, cursor = process.env.TIDY_TEST_ROOT;
    for (;;) { const uid = statSync(cursor).uid; trusted &&= uid === 0 || uid === process.geteuid(); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
    let requests = 0; const server = createServer((_, response) => { requests++; response.end('fixture'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const text = await (await fetch('http://127.0.0.1:' + server.address().port)).text();
    await new Promise(resolve => server.close(resolve));
    const publicError = await new Promise(resolve => {
      const socket = createConnection({ host: '1.1.1.1', port: 80 });
      socket.setTimeout(1000, () => { socket.destroy(); resolve('timeout'); });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', error => resolve(error.code));
    });
    console.log(JSON.stringify({ trusted, requests, text, publicError }));
  `;
  const command = isolatedCommand(inputs.node.path, ['--input-type=module', '-e', probe], inputs);
  const result = JSON.parse(execFileSync(command.command, command.args, { env: childEnv(root), encoding: 'utf8', timeout: 15000 }));
  assert.deepEqual(result, { trusted: true, requests: 1, text: 'fixture', publicError: 'ENETUNREACH' });
});

test('a fresh child sees only declared environment before evaluating its modules', t => {
  const { root, inputs } = fixture(t);
  const env = childEnv(root, { FIXTURE_INPUT: 'explicit' }, inputs);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    'console.log(JSON.stringify({home:process.env.HOME,fixture:process.env.FIXTURE_INPUT,node:process.version}))'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { home: join(root, 'home'), fixture: 'explicit', node: process.version });
  assert.equal(readFileSync(env.npm_config_userconfig, 'utf8'), '');
});

test('native acceptance rejects a different source commit even when version and bytes match', t => {
  const { root, inputs } = fixture(t);
  const path = join(root, 'occipital'); writeFileSync(path, 'native fixture bytes');
  const bytes = readFileSync(path);
  inputs.native = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    version: '0.1.5', commit: 'c'.repeat(40), nativeTree: inputs.source.nativeTree };
  assert.throws(() => validateNative(inputs), /source commit/);
  inputs.native.commit = inputs.source.commit;
  inputs.native.nativeTree = 'd'.repeat(64);
  assert.throws(() => validateNative(inputs), /source tree/);
  inputs.native.nativeTree = inputs.source.nativeTree;
  validateNative(inputs);
  writeFileSync(path, 'changed binary');
  assert.throws(() => validateNative(inputs), /bytes|hash/);
});

test('missing run context cannot fall back to a configured Pi installation', t => {
  const old = process.env.TIDY_TEST_INPUTS;
  delete process.env.TIDY_TEST_INPUTS;
  try { assert.throws(() => readInputs(), /prepared test inputs/); }
  finally { if (old !== undefined) process.env.TIDY_TEST_INPUTS = old; }
});


test('suite selection accounts for every test file without environment-gated omissions', () => {
  const inputs = readInputs();
  const all = discoverEntries(inputs.pi.root).filter(entry => entry.layer === 'node' || entry.layer === 'cli').map(entry => entry.file).sort();
  const plans = ['unit', 'native-release', 'terminal', 'syntax-terminal', 'rust-harness'].map(suite => resolveSelection(inputs.pi.root, { suite }));
  const selected = new Set(plans.flatMap(plan => plan.files)), excluded = new Set(plans.flatMap(plan => plan.excluded.map(entry => entry.file)));
  assert.deepEqual([...new Set([...selected, ...excluded])].sort(), all);
  for (const file of excluded) assert.ok(!selected.has(file), 'explicitly out-of-platform controls are not executed');
  const release = new Set(selectSuite(inputs, 'native-release'));
  assert.deepEqual(selectSuite(inputs, 'unit').filter(file => release.has(file)), [], 'Pi-independent release/Make checks run only in their declared profile');
});

test('host acceptance rejects an external CLI and a changed SDK manifest', t => {
  const { root, inputs } = fixture(t);
  const codingRoot = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(codingRoot, { recursive: true });
  const manifest = join(codingRoot, 'package.json'), cli = join(codingRoot, 'cli.js');
  writeFileSync(manifest, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', bin: { pi: 'cli.js' } }));
  writeFileSync(cli, '');
  const lock = join(root, 'package-lock.json'); writeFileSync(lock, '{}');
  inputs.pi = { root, version: '1.0.0', cli, lock, lockSha256: createHash('sha256').update(readFileSync(lock)).digest('hex'), packages: [{ name: '@earendil-works/pi-coding-agent', version: '1.0.0', path: manifest,
    sha256: createHash('sha256').update(readFileSync(manifest)).digest('hex') }] };
  validateHost(inputs, false);
  const originalManifest = readFileSync(manifest);
  const external = join(root, 'other-cli.js'); writeFileSync(external, '');
  inputs.pi.cli = external;
  assert.throws(() => validateHost(inputs, false), /outside the selected/);
  inputs.pi.cli = cli;
  writeFileSync(manifest, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.0', bin: { pi: 'cli.js' } }));
  assert.throws(() => validateHost(inputs, false), /version mismatch/);
  writeFileSync(manifest, originalManifest); writeFileSync(lock, '{"changed":true}');
  assert.throws(() => validateHost(inputs, false), /lock identity changed/);
});

test('setup failure writes a failed report and removes case configuration and temporary directories', async t => {
  const { root } = fixture(t);
  const inputs = { ...readInputs(), preparation: join(root, 'preparation') };
  inputs.source = { ...inputs.source, tree: '0'.repeat(64) };
  const path = join(root, 'inputs.json'), output = join(root, 'report.json');
  writeFileSync(path, JSON.stringify(inputs));
  await assert.rejects(execute({ inputs: path, suite: 'harness', output }), /sources changed/);
  assert.deepEqual(readdirSync(join(inputs.preparation, 'runs')), []);
  const report = JSON.parse(readFileSync(output));
  assert.equal(existsSync(report.runDirectory), false);
  assert.equal(report.status, 'setup-failed');
  assert.deepEqual(report.counts, {});
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('public delivery cannot be selected by an ordinary or Occipital release ref', async t => {
  const { root } = fixture(t);
  const inputs = { ...readInputs(), preparation: join(root, 'preparation') };
  const path = join(root, 'inputs.json'); writeFileSync(path, JSON.stringify(inputs));
  for (const releaseRef of [undefined, 'refs/heads/main', 'refs/tags/occipital-v0.1.5']) {
    await assert.rejects(execute({ inputs: path, suite: 'published-consumer', 'release-ref': releaseRef, output: join(root, 'report.json') }), /explicit pi-tidy-ui release/);
  }
});


test('case configuration permissions do not inherit a permissive caller umask', t => {
  const { root, inputs } = fixture(t);
  const previous = process.umask(0);
  try {
    const env = childEnv(root, {}, inputs);
    if (process.platform !== 'win32') for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) assert.equal(statSync(path).mode & 0o777, 0o700);
  } finally { process.umask(previous); }
});

function repository(t, files) {
  const { root } = fixture(t), checkout = join(root, 'checkout'), parent = readInputs();
  mkdirSync(checkout);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, name)), { recursive: true }); writeFileSync(join(checkout, name), bytes);
  }
  const env = childEnv(join(root, 'git-environment'), {}, parent);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']])
    execFileSync(parent.tools.git, args, { cwd: checkout, env });
  return { root, checkout, env, tools: parent.tools };
}

function admissionFixture(t, probe = 'import {test} from "node:test"; test("intentional assertion", () => { throw new Error("intentional product assertion"); });', runtimeName = 'runtime') {
  const value = repository(t, {
    '.gitignore': 'node_modules/\n', 'package.json': '{"type":"module"}', 'package-lock.json': '{}',
    'scripts/test/bootstrap.mjs': readFileSync(new URL('../../scripts/test/bootstrap.mjs', import.meta.url)),
    'scripts/test/context.mjs': readFileSync(new URL('../../scripts/test/context.mjs', import.meta.url)),
    ...Object.fromEntries(testEntries.map(({ file }) => ['tests/' + file, ''])),
    'tests/harness/test-fixtures.test.ts': probe,
  });
  const { root, checkout, tools, env } = value, original = readInputs();
  const source = sourceIdentity(checkout, tools, env), runRoot = join(root, runtimeName), tree = join(runRoot, 'project');
  materializeSource(checkout, tree, source.files);
  writeFileSync(join(runRoot, 'source-files.json'), JSON.stringify(source.files));
  const coding = join(tree, 'node_modules/@earendil-works/pi-coding-agent'), tui = join(tree, 'node_modules/@earendil-works/pi-tui');
  for (const directory of [coding, tui]) mkdirSync(directory, { recursive: true });
  const version = original.pi.version;
  writeFileSync(join(coding, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, type: 'module', exports: './index.js', bin: { pi: 'cli.js' } }));
  writeFileSync(join(tui, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-tui', version, type: 'module', exports: './index.js' }));
  writeFileSync(join(coding, 'index.js'), 'import {Editor} from "@earendil-works/pi-tui"; export class CustomEditor extends Editor {}');
  writeFileSync(join(coding, 'cli.js'), ''); writeFileSync(join(tui, 'index.js'), 'export class Editor {}');
  const packages = [coding, tui].map(directory => {
    const path = join(directory, 'package.json'), bytes = readFileSync(path), manifest = JSON.parse(bytes);
    return { name: manifest.name, version: manifest.version, path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const lock = join(checkout, 'package-lock.json'), { files, ...identity } = source;
  const inputs = { ...original, preparation: join(root, 'preparation'), runRoot, source: identity,
    pi: { root: tree, cli: join(coding, 'cli.js'), version, packages, lock, lockSha256: createHash('sha256').update(readFileSync(lock)).digest('hex') } };
  const path = join(root, 'inputs.json'), output = join(root, 'report.json');
  const save = () => writeFileSync(path, JSON.stringify(inputs)); save();
  return { ...value, inputs, path, output, coding, save, execute: () => execute({ inputs: path, output, suite: 'harness', files: 'harness/test-fixtures.test.ts' }) };
}

test('repeated materialization removes tracked deletions and removed untracked native build inputs', t => {
  const { root, checkout, tools, env } = repository(t, { 'tests/deleted.test.mjs': 'old test', 'crates/occipital/src/lib.rs': 'pub fn current() {}' });
  writeFileSync(join(checkout, 'crates/occipital/build.rs'), 'fn main() { panic!("stale build script"); }');
  const tree = join(root, 'project'), native = join(root, 'native-source'), first = sourceIdentity(checkout, tools, env);
  materializeSource(checkout, tree, first.files); materializeSource(checkout, native, first.files.filter(name => name.startsWith('crates/')));
  assert.ok(existsSync(join(tree, 'tests/deleted.test.mjs'))); assert.ok(existsSync(join(native, 'crates/occipital/build.rs')));
  rmSync(join(checkout, 'tests/deleted.test.mjs')); rmSync(join(checkout, 'crates/occipital/build.rs'));
  const second = sourceIdentity(checkout, tools, env);
  assert.notEqual(second.tree, first.tree);
  assert.deepEqual(materializeSource(checkout, tree, second.files), snapshotIdentity(checkout, second.files));
  materializeSource(checkout, native, second.files.filter(name => name.startsWith('crates/')));
  assert.equal(existsSync(join(tree, 'tests/deleted.test.mjs')), false);
  assert.equal(existsSync(join(tree, 'crates/occipital/build.rs')), false);
  assert.equal(existsSync(join(native, 'crates/occipital/build.rs')), false);
});

test('bootstrap loads the owned project from paths containing URL-reserved characters', async t => {
  const f = admissionFixture(t, 'import {test} from "node:test"; import {writeFileSync} from "node:fs"; test("owned project loaded", () => { writeFileSync("probe-counter", "hit"); });', 'runtime # 100% bootstrap');
  const report = await f.execute();
  assert.equal(report.status, 'passed'); assert.equal(report.counts.pass, 1);
  assert.equal(readFileSync(join(f.inputs.pi.root, 'probe-counter'), 'utf8'), 'hit');
  assert.equal(existsSync(report.runDirectory), false);
});

test('host admission failure still writes an explicit safe setup report', async t => {
  const f = admissionFixture(t); writeFileSync(join(f.coding, 'package.json'), '{}');
  await assert.rejects(f.execute(), /version mismatch/);
  const report = JSON.parse(readFileSync(f.output));
  assert.equal(report.status, 'setup-failed'); assert.equal(report.reason, 'host-inputs');
  assert.equal(report.runDirectory, undefined); assert.deepEqual(report.counts, {});
});

test('missing runtime root still writes an explicit setup report', async t => {
  const f = admissionFixture(t); f.inputs.runRoot = join(f.root, 'missing-runtime'); f.save();
  await assert.rejects(f.execute(), /existing runtime root/);
  const report = JSON.parse(readFileSync(f.output));
  assert.equal(report.status, 'setup-failed'); assert.equal(report.reason, 'runtime-root');
});

test('staged source corruption cannot execute under an unchanged original source identity', async t => {
  const f = admissionFixture(t); writeFileSync(join(f.inputs.pi.root, 'tests/harness/test-fixtures.test.ts'), 'throw new Error("stale source");');
  await assert.rejects(f.execute(), /source snapshot differs/);
  const report = JSON.parse(readFileSync(f.output));
  assert.equal(report.reason, 'source-snapshot'); assert.equal(existsSync(report.runDirectory), false);
});

test('bootstrap runtime mismatch is a setup failure, not a product assertion', async t => {
  const f = admissionFixture(t); f.inputs.node = { ...f.inputs.node, version: 'v0.0.0' }; f.save();
  const report = await f.execute();
  assert.equal(report.status, 'setup-failed'); assert.equal(report.reason, 'bootstrap-runtime');
  assert.equal(existsSync(report.runDirectory), false);
});

test('native bootstrap class identity mismatch is reported as a harness failure', async t => {
  const f = admissionFixture(t); writeFileSync(join(f.coding, 'index.js'), 'export class CustomEditor {}');
  const report = await f.execute();
  assert.equal(report.status, 'harness-failed'); assert.equal(report.reason, 'bootstrap-class-identity');
  assert.equal(existsSync(report.runDirectory), false);
});

test('intentional product assertion remains distinct from setup and harness failures', async t => {
  const f = admissionFixture(t), report = await f.execute();
  assert.equal(report.status, 'failed'); assert.equal(report.reason, 'test-failure'); assert.equal(report.counts.fail, 1);
  assert.equal(existsSync(report.runDirectory), false);
});

test('SIGTERM stops a running test and its descendant before removing owned case roots', { skip: process.platform === 'win32' }, async t => {
  const f = admissionFixture(t, `
    import {test} from 'node:test'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    test('active descendant', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      writeFileSync('descendant.pid', String(child.pid));
      await new Promise(() => {});
    });
  `);
  const runner = spawn(f.inputs.node.path, [fileURLToPath(new URL('../../scripts/test/run.mjs', import.meta.url)),
    '--inputs', f.path, '--suite', 'harness', '--files', 'harness/test-fixtures.test.ts', '--output', f.output],
    { env: childEnv(join(f.root, 'outer'), {}, f.inputs), stdio: 'ignore' });
  let pid;
  const alive = value => { try { process.kill(value, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() >= deadline) return false; await delay(10); }
    return true;
  };
  try {
    assert.equal(await waitFor(() => existsSync(join(f.inputs.pi.root, 'descendant.pid'))), true, 'real test descendant must start');
    pid = Number(readFileSync(join(f.inputs.pi.root, 'descendant.pid'), 'utf8'));
    runner.kill('SIGTERM');
    assert.equal(await waitFor(() => runner.exitCode !== null || runner.signalCode !== null), true, 'runner must finish interruption');
    assert.equal(await waitFor(() => !alive(pid)), true, 'no descendant may survive runner interruption');
    const report = JSON.parse(readFileSync(f.output));
    assert.equal(report.status, 'failed'); assert.equal(report.reason, 'interrupted'); assert.equal(existsSync(report.runDirectory), false);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
  }
});

test('repeated tool preparation removes tools no longer declared without inheriting a search path', t => {
  const { root } = fixture(t), original = readInputs(), directory = join(root, 'sentinel-tools'); mkdirSync(directory);
  const sentinel = join(directory, process.platform === 'win32' ? 'sentinel.exe' : 'sentinel'); writeFileSync(sentinel, 'fixture');
  const base = { git: original.tools.git, npm: original.tools.npm };
  const first = materializeTools(root, original.node.path, { ...base, sentinel });
  if (process.platform === 'win32') assert.ok(first.path.split(delimiter).includes(directory));
  else assert.equal(existsSync(join(first.bin, 'sentinel')), true);
  const second = materializeTools(root, original.node.path, base);
  assert.equal(existsSync(join(second.bin, 'sentinel')), false);
  assert.equal(second.path.split(delimiter).includes(directory), false);
  assert.equal(second.path.includes('wrong-bin'), false);
});

test('importing preparation and runner APIs never executes CLI parsing for caller positional arguments', t => {
  const { root, inputs } = fixture(t);
  const modules = ['../../scripts/test/prepare.mjs', '../../scripts/test/run.mjs'].map(path => new URL(path, import.meta.url).href);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    `for (const url of ${JSON.stringify(modules)}) await import(url); console.log('import-only');`, 'build'],
    { cwd: root, env: childEnv(root, {}, inputs), encoding: 'utf8' });
  assert.equal(result.trim(), 'import-only');
});

test('clean and poisoned callers execute the same coverage without loading ambient startup hooks in tests', async t => {
  const f = admissionFixture(t, `
    import {test} from 'node:test'; import assert from 'node:assert/strict';
    test('isolated import boundary', () => {
      for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'HTTPS_PROXY', 'OPENAI_API_KEY', 'SUBC_CONNECTION_FILE', 'TIDY_AMBIENT_SENTINEL']) assert.equal(process.env[key], undefined, key);
      assert.equal(process.env.LC_ALL, 'C.UTF-8'); assert.equal(process.env.TZ, 'UTC');
      assert.equal(process.env.PI_OFFLINE, '1'); assert.ok(process.env.PI_CODING_AGENT_DIR.endsWith('agent'));
    });
  `);
  const pollution = join(f.root, 'polluted'); mkdirSync(pollution);
  const marker = join(pollution, 'startup.jsonl'), hook = join(pollution, 'startup.cjs');
  writeFileSync(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({entry:process.argv[1]})+'\\n');`);
  const npmrc = join(pollution, '.npmrc'); writeFileSync(npmrc, 'registry=http://127.0.0.1:1/\n');
  const before = readFileSync(npmrc), base = childEnv(join(f.root, 'caller'), {}, f.inputs);
  const runner = fileURLToPath(new URL('../../scripts/test/run.mjs', import.meta.url));
  const run = async (name, env) => {
    const output = join(f.root, name + '.json');
    const child = spawn(f.inputs.node.path, [runner, '--inputs', f.path, '--suite', 'harness', '--files', 'harness/test-fixtures.test.ts', '--output', output], { env, stdio: 'ignore' });
    const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); });
    assert.equal(code, 0, name);
    return JSON.parse(readFileSync(output));
  };
  const clean = await run('clean', base);
  const dirty = await run('dirty', { ...base, HOME: pollution, USERPROFILE: pollution, PI_CODING_AGENT_DIR: pollution,
    NODE_OPTIONS: '--require ' + JSON.stringify(hook), NODE_PATH: pollution,
    HTTPS_PROXY: 'http://127.0.0.1:1', OPENAI_API_KEY: 'fixture-not-a-key', SUBC_CONNECTION_FILE: join(pollution, 'service.json'),
    npm_config_userconfig: npmrc, npm_config_registry: 'http://127.0.0.1:1/',
    TZ: 'Pacific/Honolulu', LC_ALL: 'fixture-invalid', TIDY_AMBIENT_SENTINEL: 'poison' });
  assert.deepEqual(dirty.selected, clean.selected); assert.deepEqual(dirty.counts, clean.counts);
  assert.equal(dirty.pi, clean.pi); assert.equal(dirty.status, 'passed');
  const hooks = readFileSync(marker, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(hooks, [{ entry: runner }], 'only the explicitly out-of-bound caller starts with NODE_OPTIONS, never test parents/workers');
  assert.deepEqual(readFileSync(npmrc), before);
});

test('owned npm setup rejects an unsupported selected Node engine instead of producing warning-only inputs', t => {
  const { root } = fixture(t), inputs = readInputs();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'engine-admission-fixture', version: '0.0.0', private: true, engines: { node: '>=999.0.0' } }));
  const result = spawnSync(inputs.node.path, [inputs.tools.npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, env: childEnv(join(root, 'environment'), {}, inputs), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes('EBADENGINE'), true, 'npm must reject the incompatible declared engine');
});

test('every Node test entry rejects direct execution without bootstrap even when inputs are supplied', t => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  for (const { file } of discoverEntries(readInputs().pi.root).filter(entry => entry.layer !== 'script' && entry.category !== 'native-build')) {
    const contents = readFileSync(join(directory, file), 'utf8');
    for (const source of [contents, '// Comment header\r\n' + contents.replace(/\r?\n/g, '\r\n')]) {
      const firstImport = source.match(/^import[^\r\n]*/m)?.[0] ?? '';
      const guard = firstImport.match(/^import\s+(['"])([^'"\r\n]+)\1;?$/)?.[2];
      assert.ok(guard, file);
      assert.equal(fileURLToPath(new URL(guard, pathToFileURL(join(directory, file)))), join(directory, 'fixtures/test-guard.mjs'), file);
    }
  }
  const { root } = fixture(t), inputs = readInputs();
  const result = spawnSync(inputs.node.path, ['--test', '--test-name-pattern=^no-tests-selected$', join(directory, 'harness/terminal-harness.test.mjs')],
    { cwd: inputs.pi.root, env: childEnv(join(root, 'direct'), { TIDY_TEST_CONTEXT_READY: undefined }, inputs), encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes('Tests require a fresh isolated process'), true);
});

function preparationFixture(t) {
  const f = repository(t, {
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify({ type: 'module', devDependencies: { '@earendil-works/pi-coding-agent': '1.0.0' } }),
    'package-lock.json': '{"packages":{}}',
    '.cargo/config.toml': '[build]\njobs = 1\n',
  });
  const original = readInputs(), marker = join(f.root, 'npm-started'), compileMarker = join(f.root, 'compile-started');
  const npm = join(f.root, 'npm.mjs');
  writeFileSync(npm, `
    import {mkdirSync, writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'started');
    for (const name of ['pi-coding-agent', 'pi-tui', 'pi-ai', 'pi-agent-core']) {
      const root = 'node_modules/@earendil-works/' + name; mkdirSync(root, {recursive:true});
      writeFileSync(root + '/package.json', JSON.stringify({name:'@earendil-works/' + name, version:'1.0.0', bin:{pi:'cli.js'}}));
      writeFileSync(root + '/cli.js', '');
    }
  `);
  const rustRoot = join(f.root, 'rust'); mkdirSync(join(rustRoot, 'bin'), { recursive: true });
  for (const name of ['cargo', 'rustc']) writeFileSync(join(rustRoot, 'bin', name), `#!/bin/sh\nprintf started > '${compileMarker}'\nexit 1\n`, { mode: 0o755 });
  const tools = join(f.root, 'tools.json'); writeFileSync(tools, JSON.stringify({ npm }));
  const output = join(f.root, 'prepared'), runParent = join(f.root, 'runtime'); mkdirSync(runParent);
  const invoke = (args = []) => spawnSync(original.node.path, [fileURLToPath(new URL('../../scripts/test/prepare.mjs', import.meta.url)),
    '--root', f.checkout, '--output', output, '--run-root', runParent, '--tools', tools, '--offline', ...args],
    { cwd: f.root, env: childEnv(join(f.root, 'caller'), {}, original), encoding: 'utf8', timeout: 15000 });
  return { ...f, output, runParent, marker, compileMarker, rustRoot, invoke };
}

test('preparation rejects poisoned Cargo ancestry before npm or compilation and resolves runtime aliases', { skip: process.platform === 'win32' }, t => {
  for (const name of ['config.toml', 'config']) {
    const f = preparationFixture(t);
    mkdirSync(join(f.root, '.cargo')); writeFileSync(join(f.root, '.cargo', name), '[build]\nrustc-wrapper = "unowned-wrapper"\n');
    const alias = join(f.root, 'runtime-alias'); symlinkSync(f.runParent, alias);
    const result = f.invoke(['--run-root', alias, '--rust-root', f.rustRoot, '--build-native']);
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /neutral ancestry/);
    assert.equal(existsSync(f.marker), false); assert.equal(existsSync(f.compileMarker), false);
    assert.deepEqual(readdirSync(f.runParent), []); assert.equal(existsSync(join(f.output, 'inputs.json')), false);
  }
});

test('preparation rejects Git ancestry before npm starts', t => {
  const f = preparationFixture(t); writeFileSync(join(f.root, '.git'), 'gitdir: fixture-unowned\n');
  const result = f.invoke();
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.match(result.stderr, /neutral ancestry/);
  assert.equal(existsSync(f.marker), false); assert.deepEqual(readdirSync(f.runParent), []);
});

test('neutral runtime accepts owned project Cargo configuration and retains successful receipt on failed retry', t => {
  const f = preparationFixture(t), success = f.invoke();
  assert.equal(success.error, undefined); assert.equal(success.status, 0, success.stderr);
  const receiptPath = join(f.output, 'inputs.json'), receipt = readFileSync(receiptPath), inputs = JSON.parse(receipt);
  validateNeutralRunRoot(inputs.runRoot);
  assert.equal(readFileSync(join(inputs.pi.root, '.cargo/config.toml'), 'utf8'), '[build]\njobs = 1\n');
  const runtimeFiles = readdirSync(f.runParent), before = readFileSync(join(inputs.pi.root, 'package.json'));
  const failure = f.invoke(['--pi-version', '1.2.0']);
  assert.equal(failure.error, undefined); assert.notEqual(failure.status, 0); assert.match(failure.stderr, /previously resolved/);
  assert.deepEqual(readFileSync(receiptPath), receipt); assert.deepEqual(readdirSync(f.runParent), runtimeFiles);
  assert.deepEqual(readFileSync(join(inputs.pi.root, 'package.json')), before);
  assert.ok(existsSync(join(f.output, 'dependencies/node_modules'))); assert.ok(existsSync(join(f.output, 'environment/cache')));
});

test('first offline alternate-host preparation removes only its new runtime root on missing lock', t => {
  const f = preparationFixture(t), cargoCache = join(f.root, 'cargo-cache'); mkdirSync(cargoCache);
  const cacheFile = join(cargoCache, 'owned-cache'); writeFileSync(cacheFile, 'retain');
  const result = f.invoke(['--pi-version', '1.2.0', '--cargo-cache', cargoCache]);
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.match(result.stderr, /previously resolved/);
  assert.deepEqual(readdirSync(f.runParent), []); assert.equal(existsSync(join(f.output, 'inputs.json')), false);
  assert.equal(existsSync(f.marker), false); assert.equal(readFileSync(cacheFile, 'utf8'), 'retain');
  assert.ok(existsSync(join(f.output, 'environment/cache')));
});

test('runner rejects newly introduced ancestor Cargo or Git configuration as setup failure without starting a child', async t => {
  for (const name of ['.cargo/config.toml', '.cargo/config', '.git']) {
    const f = admissionFixture(t, "import {writeFileSync} from 'node:fs'; writeFileSync('child-started', 'started');");
    const marker = join(f.inputs.pi.root, 'child-started'), retained = readdirSync(f.inputs.runRoot);
    mkdirSync(dirname(join(f.root, name)), { recursive: true }); writeFileSync(join(f.root, name), 'fixture poison');
    await assert.rejects(f.execute(), /neutral ancestry/);
    const report = JSON.parse(readFileSync(f.output));
    assert.equal(report.status, 'setup-failed'); assert.equal(report.reason, 'runtime-root-neutrality');
    assert.equal(report.runDirectory, undefined); assert.equal(report.steps, undefined); assert.deepEqual(report.counts, {});
    assert.equal(existsSync(marker), false); assert.deepEqual(readdirSync(f.inputs.runRoot), retained);
  }
});


test('preparation records canonical runtime and dependency paths when the requested parent is a symlink', { skip: process.platform === 'win32' }, t => {
  const f = preparationFixture(t), alias = join(f.root, 'runtime-alias');
  symlinkSync(f.runParent, alias);
  const result = f.invoke(['--run-root', alias]);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const inputs = JSON.parse(readFileSync(join(f.output, 'inputs.json'), 'utf8'));
  assert.equal(inputs.runRoot, realpathSync(inputs.runRoot), 'npm must see one physical root, not separate alias/real locations');
  assert.equal(dirname(inputs.runRoot), realpathSync(f.runParent), 'canonicalization must not relocate the requested runtime parent');
  assert.equal(inputs.pi.root, realpathSync(inputs.pi.root));
});

test('archive preparation reads real root manifests from LF and CRLF tar listings without accepting nested manifests', { skip: process.platform === 'win32' }, t => {
  const original = readInputs();
  for (const format of ['lf', 'crlf', 'nested-crlf']) {
    const f = preparationFixture(t), staging = join(f.root, 'staging');
    const member = format === 'nested-crlf' ? 'package/nested' : 'package';
    mkdirSync(join(staging, member), { recursive: true });
    const manifest = { name: 'tidy-archive-fixture', version: '1.0.0' };
    writeFileSync(join(staging, member, 'package.json'), JSON.stringify(manifest));
    const archive = join(f.root, 'fixture.tgz'), environment = childEnv(join(f.root, 'packing'), {}, original);
    execFileSync(original.tools.tar, ['-czf', archive, '-C', staging, 'package'], { env: environment });
    const bytes = readFileSync(archive), integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    const resolved = 'https://registry.npmjs.org/tidy-archive-fixture/-/tidy-archive-fixture-1.0.0.tgz';
    writeFileSync(join(f.checkout, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/tidy-archive-fixture': { resolved, integrity } } }));
    const archiveDirectory = join(f.output, 'archives'); mkdirSync(archiveDirectory, { recursive: true });
    writeFileSync(join(archiveDirectory, createHash('sha256').update(resolved + '\0' + integrity).digest('hex') + '.tgz'), bytes);
    const tar = join(f.root, 'tar-wrapper'), script = tar + '.mjs';
    writeFileSync(script, `import {execFileSync} from 'node:child_process';\nconst args = process.argv.slice(2), bytes = execFileSync(${JSON.stringify(original.tools.tar)}, args);\nprocess.stdout.write(args[0] === '-tzf' && ${JSON.stringify(format)} !== 'lf' ? bytes.toString().replace(/\\r?\\n/g, '\\r\\n') : bytes);\n`);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(tar, `#!/bin/sh\nexec ${quote(original.node.path)} ${quote(script)} "$@"\n`, { mode: 0o755 });
    const toolsPath = join(f.root, 'tools.json'), tools = JSON.parse(readFileSync(toolsPath));
    writeFileSync(toolsPath, JSON.stringify({ ...tools, tar }));
    const result = f.invoke(['--archives']);
    if (format === 'nested-crlf') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Prepared npm archive lacks a root package\.json/);
    } else {
      assert.equal(result.status, 0, format + '\n' + result.stderr);
      const registry = JSON.parse(readFileSync(join(f.output, 'registry.json')));
      assert.equal(registry.packages.length, 1);
      assert.deepEqual(registry.packages[0].manifest, manifest);
    }
  }
});

test('failed replacement preparation cannot hide a deleted source from the surviving runtime refresh',t=>{
  const f=preparationFixture(t);mkdirSync(join(f.checkout,'src'));writeFileSync(join(f.checkout,'src/removed.ts'),'export const removed = true;\n');
  const success=f.invoke();assert.equal(success.status,0,success.stderr);
  const path=join(f.output,'inputs.json'),before=JSON.parse(readFileSync(path,'utf8')),stale=join(before.pi.root,'src/removed.ts');
  assert.equal(existsSync(stale),true);rmSync(join(f.checkout,'src/removed.ts'));
  const failure=f.invoke(['--pi-version','1.2.0']);assert.notEqual(failure.status,0);assert.match(failure.stderr,/previously resolved/);
  assert.equal(existsSync(stale),true,'failed replacement leaves the previous successful runtime intact');
  const refreshed=refreshInputs(path);assert.equal(refreshed.pi.root,before.pi.root);
  assert.equal(existsSync(stale),false,'refresh must remove the deleted module rather than accept an unlisted stale import');
});

test('runner refuses an interrupted-refresh inventory before any child, then accepts successful recovery', async t => {
  const probe = 'import {test} from "node:test"; import {writeFileSync,readFileSync} from "node:fs"; import {join} from "node:path"; writeFileSync(join(JSON.parse(readFileSync(process.env.TIDY_TEST_INPUTS)).runRoot,"child-started"),"started"); test("recovered source",()=>{});';
  const f = admissionFixture(t, probe), tree = f.inputs.pi.root, hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  f.inputs.install = { platform: process.platform, arch: process.arch, manifest: hash(join(f.checkout, 'package.json')), lock: hash(join(f.checkout, 'package-lock.json')), modules: dependencyIdentity(join(tree, 'node_modules')) };
  f.save(); writeFileSync(join(f.inputs.runRoot, 'source-files.json'), JSON.stringify(sourceIdentity(f.checkout, f.tools, f.env).files));
  mkdirSync(join(f.checkout, 'src')); const addition = join(f.checkout, 'src/card-extension-extra.ts'), last = join(f.checkout, 'z-added.ts');
  writeFileSync(addition, 'export const abandoned: string = 123;'); writeFileSync(last, 'last addition');
  const copy = fs.cpSync;
  fs.cpSync = (source, ...args) => { if (source === last) throw new Error('controlled final-copy interruption'); return copy(source, ...args); }; syncBuiltinESMExports();
  try { assert.throws(() => refreshInputs(f.path), /controlled final-copy interruption/); } finally { fs.cpSync = copy; syncBuiltinESMExports(); }
  rmSync(addition); rmSync(last);
  assert.equal(existsSync(join(tree, 'src/card-extension-extra.ts')), true);
  await assert.rejects(f.execute(), /Prepared source refresh is incomplete/);
  const rejected = JSON.parse(readFileSync(f.output, 'utf8')); assert.equal(rejected.status, 'setup-failed'); assert.equal(rejected.reason, 'source-snapshot');
  assert.equal(existsSync(join(f.inputs.runRoot, 'child-started')), false, 'stale additional source must never be launched');
  refreshInputs(f.path); assert.equal(existsSync(join(tree, 'src/card-extension-extra.ts')), false);
  const recovered = await f.execute(); assert.equal(recovered.status, 'passed'); assert.equal(recovered.counts.pass, 1);
  assert.equal(existsSync(join(f.inputs.runRoot, 'child-started')), true);
});

test('legacy unsealed descriptors keep byte-checked execution but cannot enter source refresh', async t => {
  const f = admissionFixture(t, 'import {test} from "node:test"; test("legacy descriptor",()=>{});');
  delete f.inputs.install; f.save(); rmSync(join(f.inputs.runRoot, 'source-files.json'));
  assert.throws(() => refreshInputs(f.path), /sealed owned host graph/);
  const report = await f.execute(); assert.equal(report.status, 'passed'); assert.equal(report.counts.pass, 1);
});
