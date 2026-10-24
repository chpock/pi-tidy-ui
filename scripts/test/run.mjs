import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv, readInputs, rustLoaderEnvironment, toolPath, validateHost, validateRequirements } from './context.mjs';
import { resolveSelection } from './catalog.mjs';
export { selectSuite } from './catalog.mjs';
import { snapshotIdentity, sourceIdentity, validateNeutralRunRoot } from './prepare.mjs';
import { appendProgress, progressPaths, readProgressEvents, resetProgressFile, summarizeTestEvents, writeReport } from './progress.mjs';
import { focusedRerun, readWorkerResources, resourceIntervalMs, scopeResources, summarizeWorkerResources } from './resources.mjs';

export function fileJobs(value, suite, _layers) {
  const ordinary = !['check', 'rust', 'rust-check', 'rust-allocator', 'consumer', 'published-consumer', 'rust-harness'].includes(suite);
  if (!ordinary) {
    if (value !== undefined) throw new Error('This fixed entry does not support file jobs');
    return null;
  }
  if (value === undefined) return 2;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('File jobs must be a positive safe integer');
  return Number(value);
}

export function isolatedCommand(command, args, inputs) {
  if (process.platform !== 'linux') throw new Error('Built-in real egress restriction requires Linux bwrap; use an explicit platform/container restriction elsewhere');
  // Binding the host root would expose uid 0 as unmapped nobody; Subconscious validates every connection-file ancestor.
  const mounts = ['--unshare-user', '--unshare-net', '--unshare-pid', '--tmpfs', '/'];
  for (const entry of readdirSync('/', { withFileTypes: true })) {
    if (['proc', 'dev', 'tmp'].includes(entry.name)) continue;
    const path = '/' + entry.name;
    mounts.push(...entry.isSymbolicLink() ? ['--symlink', readlinkSync(path), path] : ['--bind', path, path]);
  }
  mounts.push('--dir', '/tmp');
  const temporary = new Set();
  const collect = value => {
    if (typeof value === 'string' && value.startsWith('/tmp/') && existsSync(value)) temporary.add('/tmp/' + value.split('/')[2]);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect([inputs, args.map(value => value.startsWith('--test-reporter-destination=') ? value.slice('--test-reporter-destination='.length) : value)]);
  for (const path of temporary) mounts.push('--bind', path, path);
  return { command: toolPath('bwrap', inputs), args: [...mounts, '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--', command, ...args] };
}

async function executeStep({ command, args, cwd, env, inputs, networkIsolated, bootstrapStatus, report, reportPath, artifacts, suite, name }) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const step = { name, startedAt, status: 'running', elapsedMs: null, resources: { scopeBefore: scopeResources() } };
  report.steps.push(step); report.status = 'running'; report.phase = 'execution'; report.currentStep = name; report.reason = 'child-start';
  appendProgress(artifacts.events, { event: 'step-started', step: name, at: startedAt });
  writeReport(reportPath, report);
  let executable = command, argv = args, child, interruption;
  const signalTree = signal => {
    if (!child?.pid) return;
    if (process.platform === 'win32') execFileSync(toolPath('taskkill', inputs), ['/PID', String(child.pid), '/T', '/F'], { env, stdio: 'ignore' });
    else try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => { interruption = 'SIGINT'; signalTree('SIGINT'); };
  const terminate = () => { interruption = 'SIGTERM'; signalTree('SIGTERM'); };
  try {
    if (networkIsolated) {
      const isolated = isolatedCommand(command, args, inputs);
      executable = isolated.command; argv = isolated.args;
    }
    let tail = '';
    child = spawn(executable, argv, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => {
      process.stdout.write(bytes);
      tail += bytes.toString();
      const rows = tail.split('\n'); tail = rows.pop();
      for (const row of rows) {
        const tap = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(row);
        if (tap) report.counts[tap[1]] = Number(tap[2]);
        const rustCase = suite.startsWith('rust') && /^test (.+) \.\.\. (ok|FAILED|ignored)$/.exec(row);
        if (rustCase) report.cases.push({ name: rustCase[1], status: rustCase[2] === 'ok' ? 'passed' : rustCase[2] === 'ignored' ? 'skipped' : 'failed', kind: 'rust-test', durationMs: null });
        const rust = suite.startsWith('rust') && /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/.exec(row);
        if (rust) for (const [key, count] of Object.entries({ pass: +rust[1], fail: +rust[2], skipped: +rust[3], measured: +rust[4], filteredOut: +rust[5], tests: +rust[1] + +rust[2] + +rust[3] })) report.counts[key] = (report.counts[key] ?? 0) + count;
      }
    });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const result = await new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
    report.status = result.code === 0 && !interruption ? 'passed' : 'failed';
    report.reason = interruption ? 'interrupted' : result.code === 0 ? 'passed' : 'test-failure';
    if (interruption) report.interruption = interruption;
    report.exitCode = result.code; report.signal = result.signal;
    if (existsSync(bootstrapStatus)) {
      const bootstrap = JSON.parse(readFileSync(bootstrapStatus, 'utf8'));
      const allowed = ['bootstrap-runtime', 'bootstrap-sdk-import', 'bootstrap-class-identity'];
      report.status = bootstrap.reason === 'bootstrap-runtime' ? 'setup-failed' : 'harness-failed';
      report.reason = allowed.includes(bootstrap.reason) ? bootstrap.reason : 'bootstrap-status';
    }
    step.status = report.status; step.exitCode = result.code; step.signal = result.signal;
  } catch (error) {
    report.status = 'harness-failed'; report.reason = 'runner-exception';
    step.status = 'harness-failed'; step.reason = 'runner-exception';
    throw error;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    if (child?.pid && process.platform !== 'win32') signalTree('SIGTERM');
    step.finishedAt = new Date().toISOString(); step.elapsedMs = performance.now() - started;
    step.resources.scopeAfter = scopeResources();
    report.currentStep = null;
    appendProgress(artifacts.events, { event: 'step-complete', step: name, status: step.status, elapsedMs: step.elapsedMs, at: step.finishedAt });
    writeReport(reportPath, report);
  }
  return report.status;
}

export async function execute({ inputs: path, suite = 'unit', files, groups, layer, pattern, skip, shard, jobs, 'network-isolated': networkIsolated = false, 'release-ref': releaseRef, 'rust-test': rustTests = [], output }) {
  process.umask(0o077);
  const inputPath = resolve(path ?? join(import.meta.dirname, '../../.test-artifacts/harness/1.0.0/inputs.json'));
  const reportPath = output ? resolve(output) : join(dirname(inputPath), 'runs', suite + '-' + randomUUID(), 'report.json');
  const artifacts = progressPaths(reportPath), started = performance.now(), startedAt = new Date().toISOString();
  const report = { schema: 1, suite, selected: [], selection: { files: files ?? null, groups: groups ?? null, layer: layer ?? null, pattern: pattern ?? null, skip: skip ?? null, shard: shard ?? null, jobs: jobs ?? null, rustTests }, cases: [], network: networkIsolated ? 'os-isolated' : 'prepared-fixtures', status: 'setup-failed', phase: 'setup', reason: 'inputs', counts: {}, startedAt, elapsedMs: null, currentStep: null,
    progress: { events: basename(artifacts.events), tests: basename(artifacts.tests) } };
  resetProgressFile(artifacts.events); resetProgressFile(artifacts.tests);
  appendProgress(artifacts.events, { event: 'run-started', suite, at: startedAt });
  writeReport(reportPath, report);
  let directory, resourceDirectory, admittedInputs;
  try {
    const inputs = readInputs(inputPath);
    admittedInputs = inputs;
    mkdirSync(join(inputs.preparation, 'runs'), { recursive: true });
    report.reason = 'host-inputs';
    validateHost(inputs, false);
    Object.assign(report, { source: inputs.source, pi: inputs.pi.version, hostLockSha256: inputs.pi.lockSha256,
      hostPackages: inputs.pi.packages.map(({ name, version }) => ({ name, version })), node: inputs.node.version });
    report.reason = 'runtime-root';
    if (!inputs.runRoot || !isAbsolute(inputs.runRoot) || !existsSync(inputs.runRoot)) throw new Error('Prepared input lacks an existing runtime root outside the checkout; refresh test:prepare');
    report.reason = 'runtime-root-neutrality';
    validateNeutralRunRoot(inputs.runRoot);
    directory = mkdtempSync(join(inputs.runRoot, suite + '-'));
    report.runDirectory = directory;
    const bootstrapStatus = join(directory, 'bootstrap-status.json');
    const env = childEnv(directory, { TIDY_TEST_INPUTS: inputs.inputsPath, TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_BOOTSTRAP_STATUS: bootstrapStatus }, inputs);
    report.reason = 'source-inputs';
    const source = sourceIdentity(inputs.source.root, inputs.tools, env);
    if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree) throw new Error('Tested sources changed since preparation; refresh test:prepare inputs');
    report.reason = 'source-snapshot';
    if (inputs.install) {
      const inventory = JSON.parse(readFileSync(join(inputs.runRoot, 'source-files.json'), 'utf8'));
      if (!Array.isArray(inventory) || inventory.length !== source.files.length || inventory.some((name, index) => source.files[index] !== name)) throw new Error('Prepared source refresh is incomplete; refresh test:prepare before execution');
    }
    if (snapshotIdentity(inputs.pi.root, source.files).tree !== inputs.source.tree) throw new Error('Prepared source snapshot differs from tested sources; refresh test:prepare');
    report.reason = 'suite-inputs';
    if (process.platform === 'win32') toolPath('taskkill', inputs);
    if (suite === 'published-consumer') {
      if (networkIsolated || !/^refs\/tags\/pi-tidy-ui-v\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(releaseRef ?? '')) throw new Error('Published Occipital checks require an explicit pi-tidy-ui release tag and public-release network');
      const commit = execFileSync(inputs.tools.git, ['-C', inputs.source.root, 'rev-parse', releaseRef + '^{commit}'], { env, encoding: 'utf8' }).trim();
      if (commit !== inputs.source.commit) throw new Error('Published delivery release tag does not identify the tested commit');
      report.network = 'public-release';
      env.TIDY_TEST_RELEASE_REF = releaseRef;
    }
    const selection = resolveSelection(inputs.pi.root, { suite, files, groups, layer, shard, pattern, skip });
    const selected = selection.files;
    report.selected = selected;
    if (selection.completeSelection) report.completeSelection = selection.completeSelection;
    if (selection.coverage) report.coverage = selection.coverage;
    if (selection.shard) {
      report.shard = { ...selection.shard, selected };
    }
    report.requirements = selection.requirements;
    report.platformExclusions = selection.excluded;
    report.reason = 'file-jobs';
    report.jobs = fileJobs(jobs, suite, selection.layers);
    report.resources = { schema: 1, aggregateBefore: scopeResources(), files: [] };
    if (report.jobs !== null) {
      resourceDirectory = mkdtempSync(join(dirname(reportPath), basename(reportPath, '.json') + '.workers-'));
      report.resources.observations = basename(resourceDirectory);
      report.resources.collection = { mode: 'worker-lifetime-high-water', checkpointIntervalMs: resourceIntervalMs, descendantsIncluded: false };
      env.TIDY_TEST_RESOURCE_DIR = resourceDirectory;
      env.TIDY_TEST_RESOURCE_FILES = JSON.stringify(selected);
    }
    if (selected.some(file => file.startsWith('native-build/'))) throw new Error('Native-build controls require scripts/test/native-harness.mjs, not the Pi runner');
    Object.assign(env, validateRequirements(inputs, selection.requirements));
    if (selection.requirements.includes('native')) report.native = { commit: inputs.native.commit, nativeTree: inputs.native.nativeTree, sha256: inputs.native.sha256 };
    let command = inputs.node.path;
    let args = ['--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href];
    if (suite === 'check') args.push(join(inputs.pi.root, 'node_modules/typescript/bin/tsc'), '--noEmit');
    else if (['rust', 'rust-check', 'rust-allocator'].includes(suite)) {
      if (!inputs.rust) throw new Error('Rust execution requires prepared pinned toolchain and offline dependency home');
      command = inputs.rust.cargo;
      Object.assign(env, { ...inputs.rust.environment, ...rustLoaderEnvironment(inputs.rust.root), CARGO_HOME: inputs.rust.home, CARGO_TARGET_DIR: inputs.rust.target,
        CARGO_NET_OFFLINE: 'true', RUSTC: inputs.rust.rustc, RUSTUP_AUTO_INSTALL: '0', PATH: join(inputs.rust.root, 'bin') + (process.platform === 'win32' ? ';' : ':') + (inputs.rust.environment?.PATH ?? env.PATH) });
      if (suite === 'rust') {
        if (rustTests.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Invalid Rust test target');
        args = ['test', '--workspace', '--locked', '--offline', ...rustTests.flatMap(name => ['--test', name])];
      }
      else if (suite === 'rust-allocator') args = ['test', '--locked', '--offline', '-p', 'occipital', '--example', 'engine_probe', 'allocator_diagnostic_tracks_the_actual_glibc_api'];
      else args = ['clippy', '--workspace', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings'];
    } else if (suite === 'consumer' || suite === 'published-consumer') args.push(join(inputs.pi.root, 'tests', selected[0]));
    else {
      args.unshift('--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/resource-worker.mjs')).href);
      args.push('--expose-gc', '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
        `--test-reporter=${pathToFileURL(join(inputs.pi.root, 'scripts/test/progress-reporter.mjs')).href}`,
        `--test-reporter-destination=${artifacts.tests}`);
      args.push('--test-concurrency=' + report.jobs);
      if (pattern) args.push('--test-name-pattern=' + pattern);
      if (skip) args.push('--test-skip-pattern=' + skip);
      args.push(...selected.map(file => join(inputs.pi.root, 'tests', file)));
    }
    const stages = suite === 'rust-check' ? [['fmt', '--all', '--', '--check'], args] : [args];
    report.steps = [];
    for (const stage of stages) {
      const name = suite === 'rust-check' ? stage[0] : suite;
      const status = await executeStep({ command, args: stage, cwd: inputs.pi.root, env, inputs, networkIsolated, bootstrapStatus, report, reportPath, artifacts, suite, name });
      if (status !== 'passed') break;
    }
  } finally {
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      report.status = 'harness-failed'; report.reason = 'cleanup';
      throw error;
    } finally {
      let progress = { events: [], truncatedLines: 0 };
      try { progress = readProgressEvents(artifacts.tests); }
      catch { report.status = 'harness-failed'; report.reason = 'progress-report'; }
      const summary = summarizeTestEvents(progress.events);
      if (suite.startsWith('rust')) report.rustPerTestTiming = 'stable-libtest-does-not-report-individual-durations';
      else report.cases = summary.cases;
      report.activeTests = summary.activeTests;
      report.slowestTests = summary.slowestTests;
      report.slowestSuites = summary.slowestSuites;
      report.truncatedProgressLines = progress.truncatedLines;
      if (report.resources) {
        report.resources.aggregateAfter = scopeResources();
        if (resourceDirectory) {
          try {
            const records = readWorkerResources(resourceDirectory, report.selected).map(record => ({
              ...record, rerun: focusedRerun(admittedInputs.node.path, inputPath, record.file, { pattern, skip, networkIsolated }),
            }));
            Object.assign(report.resources, { files: records, ...summarizeWorkerResources(records) });
          } catch {
            report.status = 'harness-failed'; report.reason = 'resource-report';
            report.resources.unavailableReason = 'malformed-or-unreadable-worker-observations';
          }
        }
      }
      report.elapsedMs = performance.now() - started; report.finishedAt = new Date().toISOString(); report.phase = 'complete'; report.currentStep = null;
      appendProgress(artifacts.events, { event: 'run-complete', status: report.status, elapsedMs: report.elapsedMs, at: report.finishedAt });
      writeReport(reportPath, report);
      console.log('Test report: ' + reportPath);
      console.log('Test progress: ' + artifacts.events);
      if (report.resources?.largestWorkers?.length) {
        console.log('Largest test-file workers (process max RSS; excludes descendants):');
        for (const item of report.resources.largestWorkers.slice(0, 10)) console.log(`  ${(item.memoryPeakBytes / 1048576).toFixed(1)} MiB ${item.file}${item.complete ? '' : ' (partial)'}`);
      }
      if (summary.slowestTests.length) {
        console.log('Slowest tests:');
        for (const item of summary.slowestTests.slice(0, 10)) {
          const location = item.line ? `:${item.line}` : '';
          console.log(`  ${item.durationMs?.toFixed(1) ?? '?'} ms ${item.file ?? '(unknown file)'}${location} — ${item.name}`);
        }
      }
    }
  }
  return report;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: {
    inputs: { type: 'string' }, suite: { type: 'string' }, files: { type: 'string' }, groups: { type: 'string' }, layer: { type: 'string' }, pattern: { type: 'string' }, skip: { type: 'string' }, shard: { type: 'string' }, jobs: { type: 'string' },
    'network-isolated': { type: 'boolean' }, 'release-ref': { type: 'string' }, 'rust-test': { type: 'string', multiple: true }, output: { type: 'string' },
  } });
  const report = await execute(values); if (report.status !== 'passed') process.exitCode = 1;
}
