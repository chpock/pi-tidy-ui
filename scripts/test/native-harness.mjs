import assert from 'node:assert/strict';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {childEnv,toolPath} from './context.mjs';
import {materializeSource} from './prepare.mjs';
import {admitNativeTests,ownedNativePath} from './native-bootstrap.mjs';
import {readNativeInputs} from './prepare-native.mjs';
import {isolatedCommand} from './run.mjs';

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
    const env=childEnv(join(root,'environment'),{...inputs.rust.environment,CARGO_HOME:join(root,'cargo-home'),
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
  const report = { schema: 1, suite: 'native-build', selected: [], cases: [], counts: {},
    network: networkIsolated ? 'os-isolated' : 'prepared-fixtures', status: 'setup-failed', reason: 'native-inputs' };
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
      '--test', '--test-reporter=tap', '--test-concurrency=1', ...report.selected.map(file => join(inputs.project, 'tests', file))];
    if (networkIsolated) ({ command, args } = isolatedCommand(command, args, inputs));
    report.reason = 'child-start';
    const child = spawn(command, args, { cwd: inputs.project, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stdout.on('data', bytes => {
      process.stdout.write(bytes);
      tail += bytes.toString();
      const rows = tail.split('\n'); tail = rows.pop();
      for (const row of rows) {
        const result = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: (.*))?)?$/.exec(row);
        if (result) report.cases.push({ name: result[2], status: result[3]?.toLowerCase() ?? (result[1] === 'ok' ? 'passed' : 'failed') });
        const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(row);
        if (count) report.counts[count[1]] = Number(count[2]);
      }
    });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    Object.assign(report, await waitForNativeChild(child, { env, windowsTaskkill }));
    if (existsSync(bootstrapStatus) && !report.terminationFailed) { report.status = 'setup-failed'; report.reason = 'native-bootstrap'; }
  } finally {
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      report.status = 'harness-failed'; report.reason = 'cleanup';
      throw error;
    } finally {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log('Native test report: ' + reportPath);
    }
  }
  return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{inputs:{type:'string'},'network-isolated':{type:'boolean'},output:{type:'string'}}});
  const report = await executeNative(values);
  if (report.status !== 'passed') process.exitCode = 1;
}
