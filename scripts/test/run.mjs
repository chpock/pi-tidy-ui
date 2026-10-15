import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv, digest, readInputs, toolPath, validateHost, validateNative } from './context.mjs';
import { snapshotIdentity, sourceIdentity, validateNeutralRunRoot } from './prepare.mjs';

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
  collect(inputs);
  for (const path of temporary) mounts.push('--bind', path, path);
  return { command: toolPath('bwrap', inputs), args: [...mounts, '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--', command, ...args] };
}

const rustHarnessFiles = ['rust-harness.test.mjs'];
const releaseFiles = ['native-release.test.mjs', 'release-ci.test.mjs', 'release-version.test.mjs', 'npm-release.test.mjs', 'extension-release.test.mjs', 'makefile.test.ts'];

export function selectSuite(inputs, suite) {
  const tests = readdirSync(join(inputs.pi.root, 'tests')).filter(name => /\.test\.(?:ts|mjs)$/.test(name)).sort();
  switch (suite) {
    case 'unit': return tests.filter(name => !releaseFiles.includes(name) && !rustHarnessFiles.includes(name) && !['terminal.test.mjs', 'syntax-terminal.test.mjs'].includes(name));
    case 'native-release': return releaseFiles;
    case 'native': return ['occipital-native.test.ts', 'occipital-factories.test.ts'];
    case 'terminal': return ['terminal.test.mjs'];
    case 'syntax-terminal': return ['syntax-terminal.test.mjs'];
    case 'harness': return ['test-harness.test.mjs'];
    case 'rust-harness': return rustHarnessFiles;
    case 'consumer': return ['fixtures/installed-occipital.mjs'];
    case 'published-consumer': return ['fixtures/published-occipital.mjs'];
    case 'check': return [];
    case 'rust': case 'rust-check': case 'rust-allocator': return [];
    default: throw new Error(`Unknown test suite: ${suite}`);
  }
}

export async function execute({ inputs: path, suite = 'unit', files, pattern, skip, 'network-isolated': networkIsolated = false, 'release-ref': releaseRef, 'rust-test': rustTests = [], output }) {
  process.umask(0o077);
  const inputPath = resolve(path ?? join(import.meta.dirname, '../../.test-artifacts/harness/1.0.0/inputs.json'));
  const reportPath = output ? resolve(output) : join(dirname(inputPath), 'runs', suite + '-' + randomUUID(), 'report.json');
  const report = { schema: 1, suite, selected: [], selection: { files: files ?? null, pattern: pattern ?? null, skip: skip ?? null, rustTests }, cases: [], network: networkIsolated ? 'os-isolated' : 'prepared-fixtures', status: 'setup-failed', reason: 'inputs', counts: {} };
  let directory;
  try {
    const inputs = readInputs(inputPath);
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
    const selected = files ? files.split(',') : selectSuite(inputs, suite);
    for (const file of selected) if (!/^(?:fixtures\/)?[\w.-]+\.(?:ts|mjs)$/.test(file) || !existsSync(join(inputs.pi.root, 'tests', file))) throw new Error('Invalid selected test file');
    report.selected = selected;
    const needsNative = ['unit', 'native', 'syntax-terminal', 'consumer'].includes(suite);
    if (needsNative) {
      env.OCCIPITAL_TEST_BIN = validateNative(inputs).path;
      report.native = { commit: inputs.native.commit, nativeTree: inputs.native.nativeTree, sha256: inputs.native.sha256 };
    }
    if (suite === 'syntax-terminal') {
      if (!inputs.sharedHost) throw new Error('syntax-terminal requires --shared-host prepared input; shared coverage cannot be skipped');
      if (digest(readFileSync(inputs.sharedHost.path)) !== inputs.sharedHost.sha256) throw new Error('Prepared shared host changed');
      env.OCCIPITAL_TEST_SHARED_HOST = inputs.sharedHost.path;
    }
    if (suite === 'terminal' && !inputs.integration) throw new Error('terminal requires the prepared locked integration profile');
    if (suite === 'rust-harness' && !inputs.rust) throw new Error('rust-harness requires the prepared pinned Rust toolchain');
    let command = inputs.node.path;
    let args = ['--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href];
    if (suite === 'check') args.push(join(inputs.pi.root, 'node_modules/typescript/bin/tsc'), '--noEmit');
    else if (['rust', 'rust-check', 'rust-allocator'].includes(suite)) {
      if (!inputs.rust) throw new Error('Rust execution requires prepared pinned toolchain and offline dependency home');
      command = inputs.rust.cargo;
      Object.assign(env, { ...inputs.rust.environment, CARGO_HOME: inputs.rust.home, CARGO_TARGET_DIR: inputs.rust.target,
        CARGO_NET_OFFLINE: 'true', RUSTC: inputs.rust.rustc, RUSTUP_AUTO_INSTALL: '0', PATH: join(inputs.rust.root, 'bin') + (process.platform === 'win32' ? ';' : ':') + (inputs.rust.environment?.PATH ?? env.PATH) });
      if (suite === 'rust') {
        if (rustTests.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Invalid Rust test target');
        args = ['test', '--workspace', '--locked', '--offline', ...rustTests.flatMap(name => ['--test', name])];
      }
      else if (suite === 'rust-allocator') args = ['test', '--locked', '--offline', '-p', 'occipital', '--example', 'engine_probe', 'allocator_diagnostic_tracks_the_actual_glibc_api'];
      else args = ['clippy', '--workspace', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings'];
    } else if (suite === 'consumer' || suite === 'published-consumer') args.push(join(inputs.pi.root, 'tests', selected[0]));
    else {
      args.push('--expose-gc', '--test', '--test-reporter=tap');
      args.push('--test-concurrency=' + (suite === 'terminal' || suite === 'syntax-terminal' ? '1' : '2'));
      if (pattern) args.push('--test-name-pattern=' + pattern);
      if (skip) args.push('--test-skip-pattern=' + skip);
      args.push(...selected.map(file => join(inputs.pi.root, 'tests', file)));
    }
    const stages = suite === 'rust-check' ? [['fmt', '--all', '--', '--check'], args] : [args];
    report.steps = [];
    for (const stage of stages) {
      let executable = command, argv = stage;
      if (networkIsolated) {
        const isolated = isolatedCommand(command, stage, inputs);
        executable = isolated.command; argv = isolated.args;
      }
      let tail = '';
      report.reason = 'child-start';
      const child = spawn(executable, argv, { cwd: inputs.pi.root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => {
        process.stdout.write(bytes);
        tail += bytes.toString();
        const rows = tail.split('\n'); tail = rows.pop();
        for (const row of rows) {
          const result = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: (.*))?)?$/.exec(row);
          if (result) report.cases.push({ name: result[2], status: result[3]?.toLowerCase() ?? (result[1] === 'ok' ? 'passed' : 'failed'), ...(result[3] ? { reason: result[4] ?? null } : {}) });
          const tap = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(row);
          if (tap) report.counts[tap[1]] = Number(tap[2]);
          const rust = suite.startsWith('rust') && /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/.exec(row);
          if (rust) for (const [key, count] of Object.entries({ pass: +rust[1], fail: +rust[2], skipped: +rust[3], measured: +rust[4], filteredOut: +rust[5], tests: +rust[1] + +rust[2] + +rust[3] })) report.counts[key] = (report.counts[key] ?? 0) + count;
        }
      });
      child.stderr.on('data', bytes => process.stderr.write(bytes));
      let interruption;
      const signalTree = signal => {
        if (!child.pid) return;
        if (process.platform === 'win32') execFileSync(toolPath('taskkill', inputs), ['/PID', String(child.pid), '/T', '/F'], { env, stdio: 'ignore' });
        else try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      const interrupt = () => { interruption = 'SIGINT'; signalTree('SIGINT'); };
      const terminate = () => { interruption = 'SIGTERM'; signalTree('SIGTERM'); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
      try {
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
        report.steps.push({ kind: suite === 'rust-check' ? stage[0] : suite, status: report.status, exitCode: result.code, signal: result.signal });
        if (report.status !== 'passed') break;
      } finally {
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        if (process.platform !== 'win32') signalTree('SIGTERM');
      }
    }
  } finally {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (directory) rmSync(directory, { recursive: true, force: true });
    console.log('Test report: ' + reportPath);
  }
  return report;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: {
    inputs: { type: 'string' }, suite: { type: 'string' }, files: { type: 'string' }, pattern: { type: 'string' }, skip: { type: 'string' },
    'network-isolated': { type: 'boolean' }, 'release-ref': { type: 'string' }, 'rust-test': { type: 'string', multiple: true }, output: { type: 'string' },
  } });
  const report = await execute(values); if (report.status !== 'passed') process.exitCode = 1;
}
