import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { childEnv, readInputs, toolPath, validateHost, validateNative } from '../context.mjs';
import { sourceIdentity, snapshotIdentity, validateNeutralRunRoot } from '../prepare.mjs';
import { isolatedCommand } from '../run.mjs';
import { CONTRACT, plan, trialOrder, integer } from './workloads.mjs';
import { validateRun, summarizeRun, renderSummary, compareRuns } from './results.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const main = pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
const identity = files => {
  const digest = createHash('sha256');
  for (const [name, bytes] of files) digest.update(name).update('\0').update(bytes).update('\0');
  return digest.digest('hex');
};

export function performanceIdentity(root, files) {
  // Conservatively include execution support, even when a workload uses only part of it.
  const collectorFiles = files.filter(name => name.startsWith('scripts/test/') || /^tests\/(?:fixtures|support|helpers)\//.test(name)).sort();
  const fingerprint = names => identity(names.map(name => [name, readFileSync(join(root, name))]));
  return { collectorFiles, collectorHash: fingerprint(collectorFiles),
    extensionHash: fingerprint(files.filter(name => name.startsWith('src/') || name === 'package.json').sort()) };
}

export function executionPolicy(scenario) {
  const cli = scenario.driver === 'cli';
  return { entry: scenario.entry ?? scenario.driver, requiresNative: scenario.requiresNative === true || (cli && scenario.variant === 'on'),
    codeCachePolicy: cli ? 'fresh-per-trial-node-jiti-cache-fresh-app' : 'no-runner-compile-cache-fresh-process',
    startupPolicy: cli ? 'preload-to-ready-includes-cold-application-loading-and-compilation' : 'bootstrap-and-module-loading-before-target-phases' };
}

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    inputs: { type: 'string' }, output: { type: 'string' }, profile: { type: 'string', default: 'quick' },
    cases: { type: 'string' }, variants: { type: 'string', default: 'native,off,on' }, repetitions: { type: 'string', default: '3' },
    cards: { type: 'string' }, iterations: { type: 'string' }, warmup: { type: 'string' }, seed: { type: 'string' },
    width: { type: 'string' }, height: { type: 'string' }, mode: { type: 'string', default: 'fullscreen' },
    'gc-profile': { type: 'boolean', default: false }, 'allocation-profile': { type: 'boolean', default: false },
    'native-build-policy': { type: 'string' }, policy: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!['fullscreen', 'regular'].includes(values.mode)) throw new Error('Unknown terminal mode');
  const repetitions = Number(values.repetitions); integer(repetitions, 'repetitions', 1, 15);
  const overrides = Object.fromEntries(['cards', 'iterations', 'warmup', 'seed', 'width', 'height'].filter(key => values[key] !== undefined).map(key => [key, Number(values[key])]));
  return { ...values, positionals, repetitions, overrides };
}

export function prepared(inputs, environment) {
  validateHost(inputs, false); validateNeutralRunRoot(inputs.runRoot);
  const source = sourceIdentity(inputs.source.root, inputs.tools, environment);
  if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree || snapshotIdentity(inputs.pi.root, source.files).tree !== source.tree) throw new Error('Prepared performance sources are stale; refresh test:prepare');
  return source;
}

function launch(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function guarded(inputs, directory, label, args, env, receipt) {
  const environmentFile = join(directory, `${label}-env.json`);
  writeFileSync(environmentFile, JSON.stringify(env), { mode: 0o600, flag: 'wx' });
  const target = isolatedCommand(inputs.node.path, args, inputs);
  const result = await launch(toolPath('python3', inputs), ['-I', '-S', join(inputs.pi.root, 'scripts/test/performance/scope.py'),
    '--label', label, '--receipt', receipt, '--limit-seconds', '120', '--env-file', environmentFile, '--', target.command, ...target.args], inputs.pi.root);
  if (!existsSync(receipt)) throw new Error(`Guard failed without a receipt (${result.code ?? result.signal})`);
  return json(receipt);
}

export function compareCollections(before, after, policy = {}) {
  if (before?.schema !== 1 || after?.schema !== 1 || before.kind !== 'performance-collection' || after.kind !== 'performance-collection') throw new Error('Invalid performance collection');
  if (before.status !== 'passed' || after.status !== 'passed') throw new Error('Incomplete/failed collections cannot pass comparison');
  if (!Array.isArray(before.runs) || !Array.isArray(after.runs) || before.runs.length !== after.runs.length || !before.runs.length) throw new Error('Collection selection mismatch');
  for (const collection of [before, after]) {
    integer(collection.requested?.repetitions, 'planned repetitions', 1, 15);
    const ids = collection.runs.map(run => run.measurement.workloadHash);
    if (!Array.isArray(collection.requested.cases) || collection.requested.cases.length !== ids.length || collection.requested.cases.some(id => !ids.includes(id))) throw new Error('Planned case coverage mismatch');
    if (!Array.isArray(collection.order) || collection.order.length !== ids.length * collection.requested.repetitions) throw new Error('Incomplete trial order');
    const order = new Set(collection.order.map((value, index) => {
      if (value.index !== index || value.outcome !== 'passed' || !ids.includes(value.workload) || !Number.isSafeInteger(value.repetition) || value.repetition < 0 || value.repetition >= collection.requested.repetitions) throw new Error('Invalid completed trial order');
      return `${value.workload}/${value.repetition}`;
    }));
    if (order.size !== collection.order.length || collection.runs.some(run => run.repetitions.length !== collection.requested.repetitions || run.repetitions.some(value => value.scope?.outcome !== 'passed'))) throw new Error('Incomplete guarded repetition coverage');
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(id => !after.runs.some(run => run.scenario.id === id))) throw new Error('Unknown comparison policy case');
  const indexed = new Map(before.runs.map(run => [run.measurement.workloadHash, run]));
  if (indexed.size !== before.runs.length || new Set(after.runs.map(run => run.measurement.workloadHash)).size !== after.runs.length) throw new Error('Duplicate comparison case');
  return after.runs.map(next => {
    const previous = indexed.get(next.measurement.workloadHash);
    if (!previous) throw new Error('Collection workload selection mismatch');
    const thresholds = policy[next.scenario.id] ?? {};
    const result = compareRuns(previous, next, { thresholds });
    if (previous.product.native && next.product.native && previous.product.native.sha256 !== next.product.native.sha256 && next.environment.nativeBuildPolicy === 'unrecorded')
      return { workload: next.scenario, status: 'not-comparable', reasons: ['Changed native binary needs an explicit matching native build policy'] };
    return { workload: next.scenario, ...result };
  });
}

async function executePrepared(options, output, inputs, directory, guard, readMachineId) {
  const baseEnv = childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1' }, inputs);
  const source = prepared(inputs, baseEnv);
  const cases = plan({ profile: options.profile, cases: options.cases?.split(','), selectedVariants: options.variants.split(','), overrides: options.overrides });
  const native = cases.some(value => executionPolicy(value).requiresNative) ? validateNative(inputs) : null;
  if (native && !options['native-build-policy']?.trim()) throw new Error('Record --native-build-policy for native-required trials');
  const { collectorFiles, collectorHash, extensionHash } = performanceIdentity(inputs.pi.root, source.files);
  const collection = { schema: 1, kind: 'performance-collection', status: 'running', createdAt: new Date().toISOString(),
    provenance: { commit: source.commit, tree: source.tree, nativeTree: source.nativeTree, collectorFiles },
    requested: { profile: options.profile, repetitions: options.repetitions, cases: cases.map(value => value.hash) }, order: [], runs: [] };
  const resultPath = join(output, 'results.json'); save(resultPath, collection);
  const probePath = join(directory, 'capabilities.json');
  const probe = `import {writeFileSync} from 'node:fs';import {capabilities} from ${JSON.stringify(pathToFileURL(join(inputs.pi.root, 'scripts/test/performance/metrics.mjs')).href)};writeFileSync(${JSON.stringify(probePath)},JSON.stringify(capabilities()));`;
  const probeReceipt = await guard(inputs, directory, 'perf-capabilities', ['--expose-gc', '--input-type=module', '-e', probe], baseEnv, join(output, 'capability-scope.json'));
  if (probeReceipt.outcome !== 'passed' || !existsSync(probePath)) throw new Error('Isolated runtime capability probe failed');
  const capabilities = json(probePath);
  if (options['allocation-profile'] && capabilities.allocationProfile.status !== 'available') throw new Error('Required allocation profiler is unavailable on selected Node');
  const environment = { node: inputs.node.version, nodeSha256: hash(readFileSync(inputs.node.path)), v8: capabilities.runtime.v8,
    platform: platform(), arch: arch(), kernel: release(), cpuModels: [...new Set(cpus().map(value => value.model))], cpuCount: cpus().length, totalMemoryBytes: totalmem(),
    machine: hash(readMachineId()),
    piVersion: inputs.pi.version, hostLock: inputs.pi.lockSha256, hostPackages: inputs.pi.packages.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
    limits: probeReceipt.limits, affinity: probeReceipt.cpus, network: 'os-isolated', nodeThreadpool: 4,
    nativeBuildPolicy: options['native-build-policy'] ?? 'unrecorded' };
  const indexed = new Map();
  for (const [orderIndex, trial] of trialOrder(cases, options.repetitions).entries()) {
    const { scenario, repetition } = trial, key = scenario.hash;
    const policy = executionPolicy(scenario);
    if (!indexed.has(key)) {
      const run = { schema: 1, environment: { ...environment, nativeBuildPolicy: policy.requiresNative ? environment.nativeBuildPolicy : 'not-used' },
        product: { source: scenario.variant === 'native' ? { usage: 'not-loaded' } : { tree: extensionHash }, native: policy.requiresNative
          ? { sha256: native.sha256, nativeTree: native.nativeTree, bytes: native.bytes, target: native.target, version: native.version } : null },
        provenance: collection.provenance,
        measurement: { contract: CONTRACT, workloadHash: key, collectorHash, mode: scenario.driver === 'cli' ? options.mode : 'sdk-layout',
          gcPolicy: 'post-phase-explicit-three-turns', gcProfile: options['gc-profile'], allocationProfile: options['allocation-profile'], codeCachePolicy: policy.codeCachePolicy, startupPolicy: policy.startupPolicy },
        scenario: { id: scenario.id, driver: scenario.driver, variant: scenario.variant, parameters: scenario.parameters }, capabilities, repetitions: [] };
      indexed.set(key, run); collection.runs.push(run);
    }
    const trialDirectory = join(directory, `trial-${orderIndex}`); mkdirSync(trialDirectory, { mode: 0o700 });
    const configPath = join(trialDirectory, 'config.json'), targetPath = join(trialDirectory, 'target.json');
    save(configPath, { scenario, repetition, mode: options.mode, gcProfile: options['gc-profile'], allocationProfile: options['allocation-profile'] });
    const label = `perf-${orderIndex}-${randomUUID().slice(0, 8)}`, scopePath = join(output, `${label}.json`);
    const env = childEnv(trialDirectory, { TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_PERF_CONFIG: configPath, TIDY_TEST_PERF_RESULT: targetPath,
      TIDY_TEST_PERF_PROFILE: join(output, `${label}-allocation-profile.json`) }, inputs);
    const args = ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
      join(inputs.pi.root, `tests/fixtures/performance-${policy.entry}.mjs`)];
    const proof = prepared(inputs, env); if (proof.tree !== source.tree) throw new Error('Source changed during performance batch');
    const scope = await guard(inputs, trialDirectory, label, args, env, scopePath);
    const target = existsSync(targetPath) ? json(targetPath) : { outcome: 'failed', phases: [], failure: { message: 'Target did not produce its result' } };
    const scopePassed = scope.outcome === 'passed';
    const value = { ...target, index: repetition, outcome: target.outcome === 'passed' && scopePassed ? 'passed' : 'failed', scope };
    if (value.outcome === 'failed' && !value.failure) value.failure = { message: scope.failure ?? 'Guard rejected target outcome' };
    indexed.get(key).repetitions.push(value);
    collection.order.push({ index: orderIndex, workload: key, repetition, scope: scopePath, outcome: value.outcome });
    console.log(`${scenario.id}/${scenario.variant}/${scenario.parameters.cards} repeat ${repetition + 1}: ${value.outcome}`);
    save(resultPath, collection);
    if (value.outcome !== 'passed') { collection.status = 'failed'; save(resultPath, collection); throw new Error(`Performance trial failed; preserved ${resultPath}`); }
  }
  for (const run of collection.runs) validateRun(run);
  collection.status = 'passed'; save(resultPath, collection);
  const summaries = collection.runs.map(run => ({ scenario: run.scenario, summary: summarizeRun(run) }));
  save(join(output, 'summaries.json'), summaries);
  writeFileSync(join(output, 'summary.txt'), summaries.map(value => `${value.scenario.id}/${value.scenario.variant}/${value.scenario.parameters.cards}\n${renderSummary(value.summary)}`).join('\n\n'));
  console.log(`Saved ${resultPath}; detailed distributions: ${join(output, 'summary.txt')}`);
  return collection;
}

export async function executePerformance(options, { guarded: guard = guarded, remove = rmSync, readMachineId = () => readFileSync('/etc/machine-id') } = {}) {
  if (!options.inputs || !options.output) throw new Error('Supply --inputs and a fresh --output directory');
  const output = resolve(options.output);
  if (existsSync(output)) throw new Error('Performance output directory already exists; evidence is never overwritten');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const path = join(output, 'results.json');
  save(path, { schema: 1, kind: 'performance-collection', status: 'running', runs: [], order: [] });
  let directory, failed = false;
  try {
    const inputs = readInputs(resolve(options.inputs));
    validateNeutralRunRoot(inputs.runRoot);
    directory = mkdtempSync(join(inputs.runRoot, 'performance-'));
    return await executePrepared(options, output, inputs, directory, guard, readMachineId);
  } catch (error) {
    failed = true;
    const partial = json(path); partial.status = 'failed'; partial.failure = { message: String(error.message).slice(0, 1500) };
    save(path, partial); throw error;
  } finally {
    if (directory) {
      try { remove(directory, { recursive: true, force: true }); }
      catch (error) {
        const partial = json(path); partial.status = 'failed'; partial.cleanupFailure = { message: String(error.message).slice(0, 1500) };
        save(path, partial);
        if (!failed) throw error;
      }
    }
  }
}

if (main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('Manual performance runs: --inputs ABS --output NEW_DIR [--profile quick|standard|extended] [--cases render,frames,...] [--variants native,off,on] [--repetitions 3]. Compare: compare BEFORE/results.json AFTER/results.json [--policy FILE] [--output NEW_FILE]. See docs/performance-testing.md.');
    else if (options.positionals[0] === 'compare') {
      if (options.positionals.length !== 3 || !options.output) throw new Error('compare requires two collections and a new --output file');
      if (existsSync(resolve(options.output))) throw new Error('Comparison output already exists');
      const results = compareCollections(json(resolve(options.positionals[1])), json(resolve(options.positionals[2])), options.policy ? json(resolve(options.policy)) : {});
      save(resolve(options.output), results); for (const value of results) console.log(`${value.workload.id}/${value.workload.variant}/${value.workload.parameters.cards}: ${value.status}`);
      if (results.some(value => !['pass', 'observed'].includes(value.status))) process.exitCode = 1;
    } else { if (options.positionals.length) throw new Error('Unknown performance command'); await executePerformance(options); }
  } catch (error) { console.error(`Performance framework: ${error.message}`); process.exitCode = 1; }
}
