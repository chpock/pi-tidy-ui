import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';
import { discoverNativeTests, executeNative } from '../../scripts/test/native-harness.mjs';
import { prepareNative } from '../../scripts/test/prepare-native.mjs';
import { snapshotIdentity } from '../../scripts/test/prepare.mjs';

const posix = { skip: process.platform === 'win32' };
const guard = "import '../../scripts/test/native-guard.mjs';\n";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), original = readInputs();
  const put = (name, bytes) => { const path = join(checkout, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  for (const name of ['context', 'prepare', 'prepare-native', 'native-harness', 'native-bootstrap', 'native-guard', 'run', 'catalog']) {
    put(`scripts/test/${name}.mjs`, readFileSync(new URL(`../../scripts/test/${name}.mjs`, import.meta.url)));
  }
  put('tests/native-build/rust-harness.test.mjs', readFileSync(new URL('../native-build/rust-harness.test.mjs', import.meta.url)));
  put('package.json', '{"type":"module","engines":{"node":">=22.19.0"}}');
  put('rust-toolchain.toml', '[toolchain]\nchannel = "1.99.0"\n');
  const env = childEnv(join(root, 'git-environment'), {}, original);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    execFileSync(original.tools.git, args, { cwd: checkout, env });
  }
  const tools = join(root, 'tools.json');
  writeFileSync(tools, JSON.stringify(Object.fromEntries(Object.entries(original.tools).filter(([name]) => !['bin', 'path'].includes(name)))));
  const rust = join(root, 'inert-rust'), calls = join(root, 'cargo-check-calls');
  mkdirSync(join(rust, 'bin'), { recursive: true });
  // This executor exercises process boundaries and the real ancestry-control function,
  // not Rust compilation. Actual pinned Cargo acceptance belongs to the producer.
  writeFileSync(join(rust, 'bin/cargo'), `#!${process.execPath}\n
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
if(process.argv[2] === '--version') console.log('cargo 1.99.0 (inert-fixture)');
else {
  appendFileSync(${JSON.stringify(calls)}, 'check\\n');
  const config = join(dirname(process.cwd()), '.cargo/config.toml');
  if(existsSync(config)) {
    const wrapper = JSON.parse(readFileSync(config, 'utf8').match(/rustc-wrapper = (.*)/)[1]);
    const result = spawnSync(wrapper, [], {env:process.env});
    process.exitCode = result.status ?? 1;
  }
}
`, { mode: 0o755 });
  writeFileSync(join(rust, 'bin/rustc'), `#!${process.execPath}\nconsole.log('rustc 1.99.0 (inert-fixture)');\n`, { mode: 0o755 });
  let generation = 0;
  const prepare = () => {
    const output = join(root, 'prepared-' + generation++);
    const inputs = prepareNative({ root: checkout, output, node: process.execPath, tools, 'rust-root': rust, 'run-root': root });
    t.after(() => rmSync(inputs.runRoot, { recursive: true, force: true }));
    return { inputs, path: join(output, 'inputs.json'), output: join(output, 'report.json') };
  };
  return { root, checkout, calls, put, prepare };
}

function assertClean(report) {
  assert.equal(existsSync(report.runDirectory), false, 'disposable run environment was removed');
}

test('native runner autoexecutes added nested mjs and ts tests with no registry edit (inert Rust, not compiler acceptance)', posix, async t => {
  const f = fixture(t), initial = f.prepare();
  const first = await executeNative({ inputs: initial.path, output: initial.output });
  assert.equal(first.status, 'passed');
  assert.deepEqual(first.selected, ['native-build/rust-harness.test.mjs']);
  assert.equal(readFileSync(f.calls, 'utf8'), 'check\ncheck\n', 'one ancestry control executes poisoned and neutral Cargo exactly once each');
  assertClean(first);
  writeFileSync(f.calls, '');
  const marker = join(f.root, 'additional-tests');
  for (const extension of ['mjs', 'ts']) {
    f.put(`tests/native-build/nested/additional.test.${extension}`, "import '../../../scripts/test/native-guard.mjs';\n" + `
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {test} from 'node:test';
import {readNativeInputs} from '../../../scripts/test/prepare-native.mjs';
test('new ${extension} test automatically executes', () => {
  const inputs = readNativeInputs(process.env.TIDY_NATIVE_TEST_INPUTS);
  assert.equal(inputs.kind, 'native-build');
  assert.equal(inputs.pi, undefined);
  assert.equal(process.env.TIDY_TEST_INPUTS, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.NODE_PATH, undefined);
  assert.equal(process.env.API_KEY, undefined);
  assert.equal(process.env.PATH, inputs.tools.path);
  assert.equal(process.execPath, inputs.node.path);
  appendFileSync(${JSON.stringify(marker)}, '${extension}\\n');
});\n`);
  }
  const next = f.prepare(), previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH, API_KEY: process.env.API_KEY };
  Object.assign(process.env, { NODE_OPTIONS: '--require=/must-not-load.cjs', NODE_PATH: '/must-not-load', API_KEY: 'secret' });
  let report;
  try { report = await executeNative({ inputs: next.path, output: next.output }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.selected, ['native-build/nested/additional.test.mjs', 'native-build/nested/additional.test.ts', 'native-build/rust-harness.test.mjs']);
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n').sort(), ['mjs', 'ts']);
  assert.equal(readFileSync(f.calls, 'utf8'), 'check\ncheck\n', 'discovery must not duplicate the existing ancestry control');
  assert.equal(report.counts.tests, 3);
  assertClean(report);
});

test('native assertion failure fails runner CLI and prevents a following producer stamp (inert Rust)', posix, t => {
  const f = fixture(t), marker = join(f.root, 'producer-stamp');
  f.put('tests/native-build/failure.test.mjs', guard + "import {test} from 'node:test'; test('deliberate native failure', () => { throw new Error('deliberate failure'); });\n");
  const prepared = f.prepare();
  const result = spawnSync(prepared.inputs.node.path, [join(prepared.inputs.project, 'scripts/test/native-harness.mjs'), '--inputs', prepared.path, '--output', prepared.output], {
    env: childEnv(join(f.root, 'producer-environment'), {}, prepared.inputs), encoding: 'utf8', timeout: 60000,
  });
  if (result.status === 0) writeFileSync(marker, 'stamped');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(marker), false);
  const report = JSON.parse(readFileSync(prepared.output));
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'test-failure');
  assert.equal(report.counts.fail, 1);
  assert.equal(readFileSync(f.calls, 'utf8'), 'check\ncheck\n');
  assertClean(report);
});

test('native admission rejects descriptor, runtime, source, snapshot and ancestor poisoning before tests (inert Rust)', posix, async t => {
  const f = fixture(t), marker = join(f.root, 'test-executed');
  f.put('tests/native-build/probe.test.mjs', guard + `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  const prepared = f.prepare(), { inputs, path, output } = prepared;
  const save = value => writeFileSync(path, JSON.stringify(value));
  for (const [name, invalid, expected] of [
    ['kind', { ...inputs, kind: 'pi-host' }, /native-build/],
    ['runtime', { ...inputs, node: { ...inputs.node, version: 'v22.0.0' } }, /Node runtime changed/],
    ['source', { ...inputs, source: { ...inputs.source, tree: '0'.repeat(64) } }, /sources changed/],
    ['tools', { ...inputs, tools: { ...inputs.tools, git: join(f.root, 'missing-git') } }, /ENOENT/],
  ]) {
    save(invalid);
    await assert.rejects(executeNative({ inputs: path, output }), expected, name);
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.status, 'setup-failed');
    if (report.runDirectory) assertClean(report);
    assert.equal(existsSync(marker), false);
  }
  save(inputs);
  const changed = join(inputs.project, 'tests/native-build/probe.test.mjs');
  appendFileSync(changed, '// changed snapshot\n');
  await assert.rejects(executeNative({ inputs: path, output }), /snapshot differs/);
  assertClean(JSON.parse(readFileSync(output)));
  writeFileSync(changed, readFileSync(join(f.checkout, 'tests/native-build/probe.test.mjs')));
  mkdirSync(join(inputs.runRoot, '.cargo'));
  writeFileSync(join(inputs.runRoot, '.cargo/config.toml'), '[build]\n');
  await assert.rejects(executeNative({ inputs: path, output }), /neutral ancestry/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.calls), false, 'no ancestry test ran after invalid admission');
  assert.equal(readdirSync(inputs.runRoot).some(name => name.startsWith('native-build-')), false);
});

test('native-build test guard rejects direct execution without native bootstrap', t => {
  const original = readInputs(), root = mkdtempSync(join(tmpdir(), 'native-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/test/native-guard.mjs', import.meta.url))], {
    env: childEnv(root, {}, original), encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh isolated Node context/);
});


test('native runner rejects byte-identical external trees at the native root and its tests ancestor before execution', posix, async t => {
  for (const replacement of ['tests/native-build', 'tests']) await t.test(replacement, async t => {
    const f = fixture(t), marker = join(f.root, 'escaped-test-marker');
    f.put('tests/native-build/escape.test.mjs', guard + `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped');\n`);
    const prepared = f.prepare(), project = prepared.inputs.project;
    const external = join(f.root, 'external');
    cpSync(join(project, 'tests'), join(external, 'tests'), { recursive: true });
    cpSync(join(project, 'scripts'), join(external, 'scripts'), { recursive: true });
    const inventory = JSON.parse(readFileSync(join(prepared.inputs.runRoot, 'source-files.json')));
    const admitted = snapshotIdentity(project, inventory);
    rmSync(join(project, replacement), { recursive: true });
    symlinkSync(join(external, replacement), join(project, replacement), 'dir');
    assert.deepEqual(snapshotIdentity(project, inventory), admitted, 'byte checks alone cannot detect the external replacement');
    await assert.rejects(executeNative({ inputs: prepared.path, output: prepared.output }), /owned regular.*symbolic links/);
    const report = JSON.parse(readFileSync(prepared.output));
    assert.equal(report.status, 'setup-failed');
    assert.deepEqual(report.selected, []);
    assert.equal(existsSync(marker), false, 'external byte-identical test must never execute');
    assert.equal(existsSync(f.calls), false);
    assertClean(report);
  });
});

function outputMarker(child, marker) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => finish(new Error('Child did not publish readiness')), 15000);
    const data = bytes => { text += bytes; if (text.includes(marker)) finish(); };
    const close = () => finish(new Error('Child exited before readiness'));
    const finish = error => {
      clearTimeout(timer); child.stdout.off('data', data); child.off('close', close);
      if (error) reject(error); else resolve();
    };
    child.stdout.on('data', data); child.once('close', close);
  });
}

test('native runner interruption waits for real POSIX suite shutdown before cleanup and failure report', { ...posix, timeout: 30000 }, async t => {
  const f = fixture(t), stopped = join(f.root, 'native-worker-stopped');
  f.put('tests/native-build/interrupt.test.mjs', guard + `
import {writeFileSync} from 'node:fs';
import {test} from 'node:test';
test('interruptible real Node worker', async () => new Promise(() => {
  process.once('SIGTERM', () => { writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM'); process.exit(0); });
  setInterval(() => {}, 1000);
  console.log('NATIVE_INTERRUPT_READY');
}));\n`);
  const prepared = f.prepare(), runner = spawn(prepared.inputs.node.path, [join(prepared.inputs.project, 'scripts/test/native-harness.mjs'), '--inputs', prepared.path, '--output', prepared.output], {
    env: childEnv(join(f.root, 'producer-environment'), {}, prepared.inputs), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(runner, 'close');
  runner.stderr.resume();
  try {
    await outputMarker(runner, 'NATIVE_INTERRUPT_READY');
    runner.stdout.resume();
    runner.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 1); assert.equal(signal, null);
    assert.equal(readFileSync(stopped, 'utf8'), 'SIGTERM', 'the actual native test worker received tree termination');
    const report = JSON.parse(readFileSync(prepared.output));
    assert.equal(report.status, 'failed'); assert.equal(report.reason, 'interrupted');
    assert.equal(report.interruption, 'SIGTERM');
    assertClean(report);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) { runner.kill('SIGTERM'); await closed; }
  }
});

test('native Windows termination-command failure stays contained and cannot finish cleanup before child exit', { ...posix, timeout: 15000 }, async t => {
  const { waitForNativeChild } = await import('../../scripts/test/native-harness.mjs');
  assert.equal(typeof waitForNativeChild, 'function', 'native lifecycle must expose its controlled termination seam');
  const root = mkdtempSync(join(tmpdir(), 'native-termination-'));
  const original = readInputs(), signals = new EventEmitter(), attempts = [];
  const child = spawn(process.execPath, ['-e', "console.log('TERMINATION_CONTROL_READY'); setInterval(() => {}, 1000)"], {
    env: childEnv(root, {}, original), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  child.stderr.resume();
  const owned = join(root, 'owned-workspace'); mkdirSync(owned);
  let finished = false;
  const waited = waitForNativeChild(child, { signalSource: signals, windowsTaskkill: '/declared/taskkill.exe', env: {},
    runTaskkill(command, args) { attempts.push({ command, args }); throw new Error('controlled taskkill failure'); },
  }).finally(() => { finished = true; rmSync(owned, { recursive: true }); });
  try {
    await outputMarker(child, 'TERMINATION_CONTROL_READY');
    assert.doesNotThrow(() => signals.emit('SIGTERM'), 'termination errors must not escape a signal callback');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(existsSync(owned), true, 'failure cannot dispose a running child workspace');
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.deepEqual(attempts, [{ command: '/declared/taskkill.exe', args: ['/PID', String(child.pid), '/T', '/F'] }]);
    child.kill('SIGTERM');
    const report = await waited;
    assert.equal(report.status, 'harness-failed'); assert.equal(report.reason, 'termination');
    assert.equal(report.terminationFailed, true); assert.equal(report.interruption, 'SIGTERM');
    assert.equal(existsSync(owned), false);
    assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed; await waited; rmSync(root, { recursive: true, force: true });
  }
});

test('native termination tolerates a target only after its actual exit is confirmed', posix, async t => {
  const { waitForNativeChild } = await import('../../scripts/test/native-harness.mjs');
  assert.equal(typeof waitForNativeChild, 'function', 'native lifecycle must expose its controlled termination seam');
  const root = mkdtempSync(join(tmpdir(), 'native-exited-'));
  const original = readInputs(), signals = new EventEmitter();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: childEnv(root, {}, original), stdio: 'ignore' });
  let attempts = 0;
  const waited = waitForNativeChild(child, { signalSource: signals, windowsTaskkill: '/declared/taskkill.exe', env: {},
    runTaskkill() { attempts++; throw new Error('must not terminate a confirmed exited target'); },
  });
  child.once('exit', () => signals.emit('SIGTERM'));
  try {
    const report = await waited;
    assert.equal(attempts, 0);
    assert.equal(report.terminationFailed, undefined);
    assert.equal(report.exitCode, 0);
    assert.equal(report.reason, 'interrupted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('native discovery canonicalizes a runtime ancestor alias without permitting links inside the project', posix, t => {
  const root = mkdtempSync(join(tmpdir(), 'native-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'actual/project');
  mkdirSync(join(project, 'tests/native-build'), { recursive: true });
  writeFileSync(join(project, 'tests/native-build/alias.test.mjs'), 'not executed');
  symlinkSync(join(root, 'actual'), join(root, 'runtime-alias'), 'dir');
  assert.deepEqual(discoverNativeTests(join(root, 'runtime-alias/project')), ['native-build/alias.test.mjs']);
});

test('native child spawn failure waits for close before releasing the owned lifecycle', { ...posix, timeout: 10000 }, async t => {
  const { waitForNativeChild } = await import('../../scripts/test/native-harness.mjs');
  assert.equal(typeof waitForNativeChild, 'function');
  const root = mkdtempSync(join(tmpdir(), 'native-spawn-failure-')), signals = new EventEmitter();
  let closed = false;
  const child = spawn(join(root, 'missing-node'), [], { env: {}, stdio: 'ignore' });
  child.once('close', () => { closed = true; });
  try {
    await assert.rejects(waitForNativeChild(child, { signalSource: signals }), { code: 'ENOENT' });
    assert.equal(closed, true);
    assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
