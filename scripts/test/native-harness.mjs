import assert from 'node:assert/strict';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,delimiter,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {childEnv,rustLoaderEnvironment,toolPath} from './context.mjs';
import {materializeSource} from './prepare.mjs';
import {admitNativeTests,ownedNativePath} from './native-bootstrap.mjs';
import {readNativeInputs} from './prepare-native.mjs';
import {isolatedCommand} from './run.mjs';
import {appendProgress,progressPaths,readProgressEvents,resetProgressFile,summarizeTestEvents,writeReport} from './progress.mjs';

export function checkCargoAncestry(inputs) {
  assert.ok(inputs.rust,'Cargo ancestry requires an explicitly prepared pinned Cargo/rustc');
  const project=inputs.kind==='native-build'?inputs.project:inputs.pi.root;
  assert.equal(realpathSync(project).startsWith(realpathSync(inputs.source.root)+sep),false);
  assert.equal(realpathSync(project).startsWith(realpathSync(inputs.runRoot)+sep),true);
  const root=mkdtempSync(join(tmpdir(),'cargo-ancestor-'));
  try {
    const ancestor=join(root,'polluted'),checkout=join(ancestor,'checkout'),neutral=join(root,'neutral');
    for(const path of [join(ancestor,'.cargo'),join(checkout,'src'),join(root,'cargo-home')])mkdirSync(path,{recursive:true});
    const counter=join(root,'wrapper-calls'),wrapper=join(root,process.platform==='win32'?'wrapper.cmd':'wrapper.sh');
    writeFileSync(wrapper,process.platform==='win32'?'@echo off\r\necho hit>>"%TIDY_RUST_WRAPPER_COUNTER%"\r\nexit /b 73\r\n':'#!/bin/sh\nprintf hit >> "$TIDY_RUST_WRAPPER_COUNTER"\nexit 73\n',{mode:0o700});
    writeFileSync(join(ancestor,'.cargo/config.toml'),`[build]\nrustc-wrapper = ${JSON.stringify(wrapper)}\n`);
    writeFileSync(join(checkout,'Cargo.toml'),'[package]\nname = "harness-probe"\nversion = "0.0.0"\nedition = "2024"\n');
    writeFileSync(join(checkout,'Cargo.lock'),'version = 4\n[[package]]\nname = "harness-probe"\nversion = "0.0.0"\n');
    writeFileSync(join(checkout,'src/lib.rs'),'pub fn probe() -> u32 { 42 }\n');
    const env=childEnv(join(root,'environment'),{...inputs.rust.environment,...rustLoaderEnvironment(inputs.rust.root),CARGO_HOME:join(root,'cargo-home'),
      CARGO_TARGET_DIR:join(root,'target'),CARGO_NET_OFFLINE:'true',RUSTC:inputs.rust.rustc,RUSTUP_AUTO_INSTALL:'0',
      PATH:dirname(inputs.rust.rustc)+delimiter+(inputs.rust.environment?.PATH??inputs.tools.bin),TIDY_RUST_WRAPPER_COUNTER:counter},inputs);
    const check=cwd=>spawnSync(inputs.rust.cargo,['check','--locked','--offline'],{cwd,env,encoding:'utf8',timeout:30000});
    const poisoned=check(checkout);
    assert.notEqual(poisoned.status,0,'positive control must observe ancestor Cargo configuration');
    assert.ok(readFileSync(counter).length>0,'positive control executed the actual configured wrapper');
    writeFileSync(counter,'');
    materializeSource(checkout,neutral,['Cargo.toml','Cargo.lock','src/lib.rs']);
    const isolated=check(neutral);
    assert.equal(isolated.status,0,isolated.stderr);
    assert.equal(readFileSync(counter).length,0,'owned neutral materialization executes the ambient wrapper zero times');
    return {poisonedWrapperObserved:true,neutralWrapperCalls:0};
  }finally{rmSync(root,{recursive:true,force:true});}
}

export function discoverNativeTests(project) {
  const files = [];
  const visit = (directory, relative) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) visit(ownedNativePath(project, 'tests/' + name, true), name);
      else if (entry.isFile() && /\.test\.(?:mjs|ts)$/.test(entry.name)) {
        ownedNativePath(project, 'tests/' + name);
        files.push(name);
      }
      else if (entry.isSymbolicLink()) throw new Error('Native test discovery requires owned regular files, not symbolic links');
    }
  };
  visit(ownedNativePath(project, 'tests/native-build', true), 'native-build');
  if (!files.length) throw new Error('No native-build tests discovered');
  return files.sort();
}

// The command seam lets POSIX controls exercise Windows taskkill failures without
// changing process.platform or claiming execution of the Windows system utility.
export async function waitForNativeChild(child, { env, windowsTaskkill, signalSource = process, runTaskkill = execFileSync } = {}) {
  let interruption, terminationFailed = false, childError;
  const rememberError = error => { childError ??= error; };
  const closed = new Promise(resolve => {
    child.on('error', rememberError);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const signalTree = signal => {
    if (!child.pid || windowsTaskkill && exited()) return;
    try {
      if (windowsTaskkill) runTaskkill(windowsTaskkill, ['/PID', String(child.pid), '/T', '/F'], { env, stdio: 'ignore' });
      else process.kill(-child.pid, signal);
    } catch (error) {
      // A retained pid, or ESRCH alone, is not evidence that Node observed exit.
      if (!exited() || !windowsTaskkill && error.code !== 'ESRCH') terminationFailed = true;
    }
  };
  const interrupt = () => { interruption ??= 'SIGINT'; signalTree('SIGINT'); };
  const terminate = () => { interruption ??= 'SIGTERM'; signalTree('SIGTERM'); };
  signalSource.on('SIGINT', interrupt); signalSource.on('SIGTERM', terminate);
  let result;
  try {
    // Even failed termination must await actual close before callers can dispose
    // the workspace. Error events alone do not prove that a running child exited.
    result = await closed;
    if (!windowsTaskkill) signalTree('SIGTERM');
  } finally {
    signalSource.off('SIGINT', interrupt); signalSource.off('SIGTERM', terminate);
    child.off('error', rememberError);
  }
  if (childError) throw childError;
  return {
    status: terminationFailed ? 'harness-failed' : result.code === 0 && !interruption ? 'passed' : 'failed',
    reason: terminationFailed ? 'termination' : interruption ? 'interrupted' : result.code === 0 ? 'passed' : 'test-failure',
    exitCode: result.code, signal: result.signal,
    ...(interruption ? { interruption } : {}), ...(terminationFailed ? { terminationFailed: true } : {}),
  };
}

export async function executeNative({ inputs: path, 'network-isolated': networkIsolated = false, output } = {}) {
  process.umask(0o077);
  const inputPath = resolve(path ?? join(import.meta.dirname, '../../.test-artifacts/native-build/inputs.json'));
  const reportPath = output ? resolve(output) : join(dirname(inputPath), 'runs', 'native-build-' + randomUUID(), 'report.json');
  const artifacts = progressPaths(reportPath), started = performance.now(), startedAt = new Date().toISOString();
  const report = { schema: 1, suite: 'native-build', selected: [], cases: [], counts: {}, steps: [],
    network: networkIsolated ? 'os-isolated' : 'prepared-fixtures', status: 'setup-failed', phase: 'setup', reason: 'native-inputs',
    startedAt, elapsedMs: null, currentStep: null, progress: { events: basename(artifacts.events), tests: basename(artifacts.tests) } };
  resetProgressFile(artifacts.events); resetProgressFile(artifacts.tests);
  appendProgress(artifacts.events, { event: 'run-started', suite: 'native-build', at: startedAt });
  writeReport(reportPath, report);
  let directory;
  try {
    // Admission uses the native descriptor only. It must happen before any test import.
    const inputs = readNativeInputs(inputPath);
    directory = mkdtempSync(join(inputs.runRoot, 'native-build-'));
    report.runDirectory = directory;
    const { files } = admitNativeTests(inputPath, directory);
    Object.assign(report, { source: inputs.source, node: inputs.node, rust: { root: inputs.rust.root } });
    report.reason = 'native-discovery';
    report.selected = discoverNativeTests(inputs.project);
    const expected = files.filter(name => /^tests\/native-build\/.*\.test\.(?:mjs|ts)$/.test(name)).map(name => name.slice('tests/'.length));
    assert.deepEqual(report.selected, expected, 'Native discovered tests must belong to the admitted source inventory');
    const windowsTaskkill = process.platform === 'win32' ? toolPath('taskkill', inputs) : undefined;
    const bootstrapStatus = join(directory, 'bootstrap-status.json');
    const env = childEnv(directory, { TIDY_NATIVE_TEST_INPUTS: inputPath, TIDY_NATIVE_TEST_CONTEXT_READY: '1',
      TIDY_NATIVE_TEST_ENVIRONMENT: directory, TIDY_NATIVE_TEST_BOOTSTRAP_STATUS: bootstrapStatus }, inputs);
    let command = inputs.node.path;
    let args = ['--import', pathToFileURL(join(inputs.project, 'scripts/test/native-bootstrap.mjs')).href,
      '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
      `--test-reporter=${pathToFileURL(join(inputs.project, 'scripts/test/progress-reporter.mjs')).href}`,
      `--test-reporter-destination=${artifacts.tests}`, '--test-concurrency=1', ...report.selected.map(file => join(inputs.project, 'tests', file))];
    if (networkIsolated) ({ command, args } = isolatedCommand(command, args, inputs));
    const stepStarted = performance.now(), stepStartedAt = new Date().toISOString();
    const step = { name: 'node-tests', startedAt: stepStartedAt, status: 'running', elapsedMs: null };
    report.steps.push(step); report.status = 'running'; report.phase = 'execution'; report.currentStep = step.name; report.reason = 'child-start';
    appendProgress(artifacts.events, { event: 'step-started', step: step.name, at: stepStartedAt });
    writeReport(reportPath, report);
    let child;
    try {
      child = spawn(command, args, { cwd: inputs.project, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      child.stdout.on('data', bytes => {
        process.stdout.write(bytes);
        tail += bytes.toString();
        const rows = tail.split('\n'); tail = rows.pop();
        for (const row of rows) {
          const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(row);
          if (count) report.counts[count[1]] = Number(count[2]);
        }
      });
      child.stderr.on('data', bytes => process.stderr.write(bytes));
      Object.assign(report, await waitForNativeChild(child, { env, windowsTaskkill }));
      if (existsSync(bootstrapStatus) && !report.terminationFailed) { report.status = 'setup-failed'; report.reason = 'native-bootstrap'; }
      step.status = report.status; step.exitCode = report.exitCode; step.signal = report.signal;
    } catch (error) {
      report.status = 'harness-failed'; report.reason = 'runner-exception';
      step.status = 'harness-failed'; step.reason = 'runner-exception';
      throw error;
    } finally {
      step.finishedAt = new Date().toISOString(); step.elapsedMs = performance.now() - stepStarted;
      report.currentStep = null;
      appendProgress(artifacts.events, { event: 'step-complete', step: step.name, status: step.status, elapsedMs: step.elapsedMs, at: step.finishedAt });
      writeReport(reportPath, report);
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
      report.cases = summary.cases; report.activeTests = summary.activeTests;
      report.slowestTests = summary.slowestTests; report.slowestSuites = summary.slowestSuites;
      report.truncatedProgressLines = progress.truncatedLines;
      report.elapsedMs = performance.now() - started; report.finishedAt = new Date().toISOString(); report.phase = 'complete'; report.currentStep = null;
      appendProgress(artifacts.events, { event: 'run-complete', status: report.status, elapsedMs: report.elapsedMs, at: report.finishedAt });
      writeReport(reportPath, report);
      console.log('Native test report: ' + reportPath);
      console.log('Native test progress: ' + artifacts.events);
      if (summary.slowestTests.length) {
        console.log('Slowest native tests:');
        for (const item of summary.slowestTests.slice(0, 10)) {
          const location = item.line ? `:${item.line}` : '';
          console.log(`  ${item.durationMs?.toFixed(1) ?? '?'} ms ${item.file ?? '(unknown file)'}${location} — ${item.name}`);
        }
      }
    }
  }
  return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{inputs:{type:'string'},'network-isolated':{type:'boolean'},output:{type:'string'}}});
  const report = await executeNative(values);
  if (report.status !== 'passed') process.exitCode = 1;
}
