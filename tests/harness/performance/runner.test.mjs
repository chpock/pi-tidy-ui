import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities } from '../../../scripts/test/performance/metrics.mjs';
import { parseOptions, compareCollections } from '../../../scripts/test/performance/run.mjs';
import * as runner from '../../../scripts/test/performance/run.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, win32 } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { childEnv, readInputs } from '../../../scripts/test/context.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const readMachineId = () => Buffer.from('runner-control-machine');
function assertCachePaths(cache, root, paths = { join, relative }) {
  assert.equal(paths.relative(root, cache.node), paths.join('pi-terminal-code', 'node'));
  assert.equal(paths.relative(root, cache.jiti), paths.join('pi-terminal-code', 'jiti'));
}
function assertDriverPath(target, root, entry, paths = { join, relative }) {
  assert.equal(paths.relative(root, target), paths.join('tests', 'fixtures', `performance-${entry}.mjs`));
}
function temporary(t) {
  const directory = mkdtempSync(join(readInputs().runRoot, 'runner-control-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function options(output, extra = []) {
  return parseOptions(['--inputs', process.env.TIDY_TEST_INPUTS, '--output', output, '--cases', 'render', '--variants', 'native', '--repetitions', '1', ...extra]);
}
function executor(seen, outcome = 'passed') {
  return async (inputs, directory, label, args, env, receipt) => {
    seen.push({ directory, args, env });
    if (label === 'perf-capabilities') writeFileSync(join(directory, 'capabilities.json'), JSON.stringify(capabilities()));
    else writeFileSync(env.TIDY_TEST_PERF_RESULT, JSON.stringify({ ...collection().runs[0].repetitions[0], outcome }));
    const value = { outcome: label === 'perf-capabilities' ? 'passed' : outcome, limits: { memoryMaxBytes: 2147483648 }, cpus: [0] };
    writeFileSync(receipt, JSON.stringify(value));
    return value;
  };
}
function collection() {
  const caps = capabilities();
  const memory = { heapUsed: 1024, heapTotal: 4096, external: 256, arrayBuffers: 128, rss: 8192, maxRssKiB: 64 };
  const run = { schema: 1, environment: { host: 'fixed', nativeBuildPolicy: 'not-used' }, product: { source: { tree: 'old' }, native: null },
    measurement: { contract: 'fixture/v1', workloadHash: 'workload1', collectorHash: 'fixed' },
    scenario: { id: 'frames', driver: 'cli', variant: 'on', parameters: { iterations: 2 } }, capabilities: caps,
    repetitions: [{ index: 0, outcome: 'passed', scope: { outcome: 'passed' }, phases: [{ id: 'warm', operations: 2, counts: { dispatches: 0, nativeCalls: 2 },
      metrics: { elapsedMs: 2, cpuUserMs: 1, cpuSystemMs: 0, allocatedBytes: caps.allocatedBytes.status === 'available' ? 4096 : null },
      memory: { before: memory, after: memory }, gc: null }] }] };
  return { schema: 1, kind: 'performance-collection', status: 'passed', requested: { cases: ['workload1'], repetitions: 1 }, runs: [run],
    order: [{ index: 0, workload: 'workload1', repetition: 0, outcome: 'passed' }] };
}

test('performance runner: strict options and bounded explicit repetitions', () => {
  const options = parseOptions(['--inputs', '/inputs.json', '--output', '/results', '--cards', '100', '--variants', 'on', '--allocation-profile']);
  assert.equal(options.inputs, '/inputs.json'); assert.equal(options.repetitions, 3);
  assert.equal(options.overrides.cards, 100); assert.equal(options['allocation-profile'], true);
  assert.equal(options['gc-profile'], false); assert.equal(options.mode, 'fullscreen');
  assert.throws(() => parseOptions(['--repetitions', '0']), /repetitions/);
  assert.throws(() => parseOptions(['--repetitions', '1.5']), /repetitions/);
  assert.throws(() => parseOptions(['--repetitions', '16']), /repetitions/);
  assert.throws(() => parseOptions(['--mode', 'other']), /mode/);
  assert.throws(() => parseOptions(['--unknown']), /Unknown option/);
});

test('performance runner: preserve source changes, descriptive policy and deterministic count regression', () => {
  const before = collection(), after = clone(before); after.runs[0].product.source.tree = 'new';
  assert.equal(compareCollections(before, after)[0].status, 'observed');
  assert.equal(compareCollections(before, after)[0].productChange, 'extension');
  after.runs[0].repetitions[0].phases[0].counts.dispatches = 1;
  const result = compareCollections(before, after, { frames: { 'warm.counts.dispatches': { absolute: 0, relative: 0 } } });
  assert.equal(result[0].status, 'regression');
  assert.throws(() => compareCollections(before, after, { typo: {} }), /Unknown comparison policy case/);
});

test('performance runner: missing, failed, unguarded and duplicated coverage cannot pass', () => {
  const before = collection();
  for (const alter of [
    value => { value.status = 'running'; },
    value => { value.status = 'failed'; },
    value => { value.order.length = 0; },
    value => { value.order[0].outcome = 'failed'; },
    value => { value.runs[0].repetitions[0].scope.outcome = 'failed'; },
    value => { value.requested.repetitions = 2; },
    value => { value.requested.cases = ['other']; },
    value => { value.runs.push(clone(value.runs[0])); },
  ]) {
    const broken = clone(before); alter(broken);
    assert.throws(() => compareCollections(before, broken));
  }
});

test('performance runner: environmental mismatch and unknown native build policy remain explicit', () => {
  const before = collection(), after = clone(before); after.runs[0].environment.host = 'another';
  assert.equal(compareCollections(before, after)[0].status, 'not-comparable');
  before.runs[0].environment.nativeBuildPolicy = 'unrecorded';
  after.runs[0].environment = clone(before.runs[0].environment);
  before.runs[0].product.native = { sha256: 'old', nativeTree: 'same' };
  after.runs[0].product.native = { sha256: 'new', nativeTree: 'same' };
  assert.equal(compareCollections(before, after)[0].status, 'not-comparable');
});

test('performance runner: execution-support closure changes collector identity, source-only changes remain comparable', t => {
  assert.equal(typeof runner.performanceIdentity, 'function');
  const root = temporary(t);
  const files = ['scripts/test/bootstrap.mjs', 'scripts/test/context.mjs', 'scripts/test/performance/run.mjs',
    'tests/fixtures/driver.ts', 'tests/fixtures/output.mjs', 'tests/support/nested/control.mjs', 'tests/helpers/control.mjs', 'src/index.ts', 'package.json'];
  for (const name of files) { const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, name); }
  const before = runner.performanceIdentity(root, files);
  assert.deepEqual(before.collectorFiles, files.filter(name => !name.startsWith('src/') && name !== 'package.json').sort());
  for (const name of before.collectorFiles) {
    writeFileSync(join(root, name), name + ' changed');
    const changed = runner.performanceIdentity(root, files);
    assert.notEqual(changed.collectorHash, before.collectorHash, name);
    assert.equal(changed.extensionHash, before.extensionHash, name);
    writeFileSync(join(root, name), name);
  }
  writeFileSync(join(root, 'src/index.ts'), 'new product');
  const after = runner.performanceIdentity(root, [...files].reverse());
  assert.equal(after.collectorHash, before.collectorHash);
  assert.notEqual(after.extensionHash, before.extensionHash);
  const a = collection(), b = clone(a);
  a.runs[0].measurement.collectorHash = before.collectorHash; b.runs[0].measurement.collectorHash = after.collectorHash;
  a.runs[0].product.source.tree = before.extensionHash; b.runs[0].product.source.tree = after.extensionHash;
  assert.equal(compareCollections(a, b)[0].productChange, 'extension');
  assert.equal(compareCollections(a, b)[0].status, 'observed');
  writeFileSync(join(root, 'tests/fixtures/driver.ts'), 'changed driver');
  b.runs[0].measurement.collectorHash = runner.performanceIdentity(root, files).collectorHash;
  assert.equal(compareCollections(a, b)[0].status, 'not-comparable');
});

test('performance runner: definition-owned source entry requires native admission without changing other SDK cases', () => {
  assert.equal(typeof runner.executionPolicy, 'function');
  const source = runner.executionPolicy({ driver: 'sdk', variant: 'on', entry: 'source', requiresNative: true });
  assert.equal(source.entry, 'source'); assert.equal(source.requiresNative, true);
  assert.equal(runner.executionPolicy({ driver: 'sdk', variant: 'on' }).requiresNative, false);
  assert.equal(runner.executionPolicy({ driver: 'sdk', variant: 'native' }).entry, 'sdk');
  assert.equal(runner.executionPolicy({ driver: 'cli', variant: 'on' }).requiresNative, true);
  assert.equal(runner.executionPolicy({ driver: 'cli', variant: 'off' }).requiresNative, false);
});

test('performance runner: driver policies match fresh per-trial terminal caches and untimed SDK loading', t => {
  assert.equal(typeof runner.executionPolicy, 'function');
  const root = temporary(t), inputs = readInputs(), caches = [];
  for (let index = 0; index < 2; index++) {
    const env = childEnv(join(root, String(index)), {}, inputs);
    const module = pathToFileURL(join(inputs.pi.root, 'tests/fixtures/terminal-code-cache.mjs')).href;
    const script = `import {terminalCodeCache} from ${JSON.stringify(module)}; console.log(JSON.stringify(terminalCodeCache(process.env.HOME)));`;
    mkdirSync(join(env.HOME, 'tmp'));
    const child = spawnSync(inputs.node.path, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
    assert.equal(child.status, 0, child.stderr?.slice(0, 1000));
    const cache = JSON.parse(child.stdout); caches.push(cache);
    assertCachePaths(cache, env.TMPDIR);
    assert.equal(readdirSync(cache.node).length, 0); assert.equal(readdirSync(cache.jiti).length, 0);
    assert.equal(env.NODE_COMPILE_CACHE, undefined);
  }
  assert.notEqual(caches[0].node, caches[1].node); assert.notEqual(caches[0].jiti, caches[1].jiti);
  const cli = runner.executionPolicy({ driver: 'cli', variant: 'native' }), sdk = runner.executionPolicy({ driver: 'sdk', variant: 'native' });
  assert.equal(cli.codeCachePolicy, 'fresh-per-trial-node-jiti-cache-fresh-app');
  assert.equal(cli.startupPolicy, 'preload-to-ready-includes-cold-application-loading-and-compilation');
  assert.equal(sdk.codeCachePolicy, 'no-runner-compile-cache-fresh-process');
  assert.equal(sdk.startupPolicy, 'bootstrap-and-module-loading-before-target-phases');
});

test('performance runner: setup failure preserves durable failure and removes newly owned temporary tree', async t => {
  const inputs = readInputs(), root = temporary(t), before = new Set(readdirSync(inputs.runRoot));
  // Invalid selection fails after the runner allocates its tree, without launching a target.
  await assert.rejects(runner.executePerformance(options(join(root, 'failed'), ['--cases', 'unknown'])), /selected cases/);
  const leaked = readdirSync(inputs.runRoot).filter(name => name.startsWith('performance-') && !before.has(name));
  t.after(() => { for (const name of leaked) rmSync(join(inputs.runRoot, name), { recursive: true, force: true }); });
  assert.equal(json(join(root, 'failed/results.json')).status, 'failed');
  assert.equal(leaked.length, 0);
});

test('performance runner: harmless executor success and failure preserve results before tree removal', async t => {
  assert.equal(typeof runner.performanceIdentity, 'function');
  const root = temporary(t);
  for (const outcome of ['passed', 'failed']) {
    const output = join(root, outcome), seen = [];
    const execute = runner.executePerformance(options(output), { guarded: executor(seen, outcome), readMachineId });
    if (outcome === 'passed') await execute; else await assert.rejects(execute, /Performance trial failed/);
    assert.equal(json(join(output, 'results.json')).status, outcome);
    assert.equal(seen.length, 2); assert.equal(existsSync(seen[0].directory), false);
    assert.ok(existsSync(join(output, 'capability-scope.json')));
    const repetition = json(join(output, 'results.json')).runs[0].repetitions[0];
    assert.equal(repetition.outcome, outcome); assert.equal(repetition.phases.length, 1);
    assert.equal(repetition.scope.outcome, outcome);
    if (outcome === 'passed') {
      const saved = json(join(output, 'results.json')).runs[0];
      assert.deepEqual(saved.product.source, { usage: 'not-loaded' });
      assert.equal(saved.product.native, null); assert.equal(saved.environment.nativeBuildPolicy, 'not-used');
      assert.equal(saved.measurement.codeCachePolicy, runner.executionPolicy(saved.scenario).codeCachePolicy);
      assert.equal(saved.measurement.startupPolicy, runner.executionPolicy(saved.scenario).startupPolicy);
      assertDriverPath(seen[1].args.at(-1), readInputs().pi.root, 'sdk');
    }
  }
});

test('performance runner: cleanup failure after successful trials is a visible failed result', async t => {
  const root = temporary(t), output = join(root, 'success-cleanup-failed'), seen = [];
  t.after(() => { if (seen.length) rmSync(seen[0].directory, { recursive: true, force: true }); });
  await assert.rejects(runner.executePerformance(options(output), {
    guarded: executor(seen), readMachineId, remove: () => {
      assert.equal(json(join(output, 'results.json')).status, 'passed');
      assert.ok(existsSync(join(output, 'summaries.json')));
      throw new Error('injected cleanup failure');
    },
  }), /injected cleanup failure/);
  const saved = json(join(output, 'results.json'));
  assert.equal(saved.status, 'failed'); assert.equal(saved.runs[0].repetitions[0].outcome, 'passed');
  assert.match(saved.cleanupFailure.message, /injected cleanup failure/);
});

test('performance runner: cleanup errors cannot replace primary trial failure or discard evidence', async t => {
  assert.equal(typeof runner.performanceIdentity, 'function');
  const root = temporary(t), output = join(root, 'failed-cleanup'), seen = [];
  t.after(() => { if (seen.length) rmSync(seen[0].directory, { recursive: true, force: true }); });
  await assert.rejects(runner.executePerformance(options(output), {
    guarded: executor(seen, 'failed'), readMachineId, remove: () => { throw new Error('injected cleanup failure'); },
  }), /Performance trial failed/);
  const saved = json(join(output, 'results.json'));
  assert.equal(saved.status, 'failed'); assert.match(saved.failure.message, /Performance trial failed/);
  assert.match(saved.cleanupFailure.message, /injected cleanup failure/);
  assert.ok(existsSync(join(output, 'capability-scope.json')));
});


test('performance runner: native admission and recorded product policy apply only to native-required trials', async t => {
  const root = temporary(t), inputs = readInputs(), seen = [];
  // Admission uses inert bytes; the executor double never starts a helper.
  const bytes = Buffer.from('inert helper fixture'), path = join(root, 'helper'), descriptor = join(root, 'inputs.json');
  inputs.native = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    commit: inputs.source.commit, nativeTree: inputs.source.nativeTree, target: 'fixture', version: '0.0.0' };
  writeFileSync(path, bytes); writeFileSync(descriptor, JSON.stringify(inputs));
  const selected = (output, extra = []) => options(output, ['--inputs', descriptor, ...extra]);
  await assert.rejects(runner.executePerformance(selected(join(root, 'missing-policy'), ['--cases', 'frames', '--variants', 'on']),
    { guarded: executor(seen), readMachineId }), /native-build-policy/);
  assert.equal(seen.length, 0);
  const enabled = await runner.executePerformance(selected(join(root, 'native-required'),
    ['--cases', 'frames', '--variants', 'on', '--native-build-policy', 'fixture-admitted-policy']), { guarded: executor(seen), readMachineId });
  const run = enabled.runs[0];
  assert.equal(run.product.native.sha256, inputs.native.sha256);
  assert.equal(run.environment.nativeBuildPolicy, 'fixture-admitted-policy');
  assertDriverPath(seen[1].args.at(-1), inputs.pi.root, 'cli');
  const sdk = await runner.executePerformance(selected(join(root, 'sdk-enabled'), ['--variants', 'on']), { guarded: executor([]), readMachineId });
  assert.equal(sdk.runs[0].product.native, null); assert.equal(sdk.runs[0].environment.nativeBuildPolicy, 'not-used');
});


test('performance runner: injected machine reader avoids real identity access while the default fails closed', async t => {
  const root = temporary(t), reads = [], injectedSeen = [], defaultSeen = [];
  const denied = Object.assign(new Error('machine identity read denied by control'), { code: 'EACCES' });
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (path, ...args) {
    if (path === '/etc/machine-id') { reads.push(path); throw denied; }
    return originalRead.call(this, path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let injectedCalls = 0;
  const output = join(root, 'injected-identity');
  const saved = await runner.executePerformance(options(output), {
    guarded: executor(injectedSeen), readMachineId: () => { injectedCalls++; return readMachineId(); },
  });
  assert.equal(saved.status, 'passed'); assert.equal(injectedCalls, 1); assert.equal(reads.length, 0);
  assert.equal(saved.runs[0].environment.machine, createHash('sha256').update(readMachineId()).digest('hex'));
  assert.equal(injectedSeen.length, 2);
  const failedOutput = join(root, 'default-identity');
  await assert.rejects(runner.executePerformance(options(failedOutput), { guarded: executor(defaultSeen) }), error => error === denied);
  assert.deepEqual(reads, ['/etc/machine-id']); assert.equal(defaultSeen.length, 1);
  const failed = json(join(failedOutput, 'results.json'));
  assert.equal(failed.status, 'failed'); assert.match(failed.failure.message, /machine identity read denied/);
  assert.equal(existsSync(defaultSeen[0].directory), false);
  assert.throws(() => parseOptions(['--machine-id', 'control']), /Unknown option/);
});

test('performance runner: Windows cache and driver predicates use path semantics', () => {
  const root = String.raw`C:\runner\trial\tmp`, project = String.raw`C:\runner\project`;
  const cache = { node: win32.join(root, 'pi-terminal-code', 'node'), jiti: win32.join(root, 'pi-terminal-code', 'jiti') };
  assertCachePaths(cache, root, win32);
  assertCachePaths({ node: 'C:/runner/trial/tmp/pi-terminal-code/node', jiti: 'C:/runner/trial/tmp/pi-terminal-code/jiti' }, root, win32);
  for (const node of [win32.join(root + '-sibling', 'pi-terminal-code', 'node'), String.raw`D:\runner\trial\tmp\pi-terminal-code\node`]) {
    assert.throws(() => assertCachePaths({ ...cache, node }, root, win32));
  }
  for (const entry of ['sdk', 'cli']) {
    const target = win32.join(project, 'tests', 'fixtures', `performance-${entry}.mjs`);
    assertDriverPath(target, project, entry, win32);
    assertDriverPath(target.replaceAll('\\', '/'), project, entry, win32);
    assert.throws(() => assertDriverPath(win32.join(project + '-sibling', 'tests', 'fixtures', `performance-${entry}.mjs`), project, entry, win32));
  }
});
