import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';
import { runNativeCommand, summarizeNativeCache } from '../../scripts/test/native-diagnostics.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'native-diagnostics-'));
  t.after(()=>rmSync(root,{recursive:true,force:true})); return root;
}

test('native diagnostics: cache breakdown counts logical bytes once and never follows external symlinks', t => {
  const root = fixture(t), home = join(root,'cargo'), target = join(root,'target');
  for (const [file,text] of [['cargo/registry/cache/package.crate','123'],['cargo/registry/src/package/lib.rs','12345'],
    ['target/debug/deps/liboccipital-123.rlib','12'],['target/debug/deps/libdependency-123.rlib','1234'],
    ['target/debug/incremental/occipital/private','123456'],['target/debug/.fingerprint/dependency/hash','1234567'],
    ['target/debug/build/dependency/output','12345678'],['outside/PRIVATE_MARKER','must not be counted']]) {
    const path = join(root,file); mkdirSync(join(path,'..'),{recursive:true}); writeFileSync(path,text);
  }
  symlinkSync(join(root,'outside'),join(target,'debug/deps/external'),process.platform==='win32'?'junction':'dir');
  const result = summarizeNativeCache(home,target);
  const expected = {registryArchives:[1,3],registrySources:[1,5],targetWorkspaceNamed:[1,2],targetDepsDirectory:[1,4],targetIncremental:[1,6],targetFingerprints:[1,7],targetBuildScripts:[1,8]};
  for (const [key,[files,bytes]] of Object.entries(expected)) {assert.equal(result.groups[key].files,files);assert.equal(result.groups[key].bytes,bytes);}
  assert.equal(result.groups.targetDepsDirectory.symlinks,1);
  assert.equal(result.groups.registryIndex.files,0); assert.equal(result.groups.targetOther.bytes,0);
  assert.ok(result.elapsedMs>=0); assert.doesNotMatch(JSON.stringify(result),/PRIVATE_MARKER|package|dependency|outside|\.rlib|\/tmp/);
});

test('native diagnostics: command counters preserve stderr, default logging, isolation and failure status/signal', async t => {
  const root = fixture(t), script = join(root,'fixture.mjs'), inputs = readInputs(), summaries = []; let errors = '';
  const stderr = '\x1b[32m   Compiling occipital v0.1.5\x1b[0m\r\n    Checking fixture_dependency v1.0.0\nerror: deliberate compiler failure\n  --> PRIVATE_SOURCE.rs:1:1\nwarning: visible warning\nerror: user code mentions cargo::compiler::fingerprint: not a trace\nCaused by:\n    PRIVATE_MARKER — 原因';
  writeFileSync(script,`if(process.env.CARGO_LOG!==undefined)throw Error('unexpected Cargo logging override');
if(process.env.PRIVATE_AMBIENT_MARKER)throw Error('ambient inherited');
process.stderr.write(${JSON.stringify(stderr)});process.exitCode=17;`);
  const previous = process.env.PRIVATE_AMBIENT_MARKER; process.env.PRIVATE_AMBIENT_MARKER='private';
  t.after(()=>{if(previous===undefined)delete process.env.PRIVATE_AMBIENT_MARKER;else process.env.PRIVATE_AMBIENT_MARKER=previous;});
  const result = await runNativeCommand(process.execPath,[script],{cwd:root,env:childEnv(join(root,'environment'),{},inputs),phase:'build',writeError:value=>{errors+=value;},writeSummary:value=>summaries.push(value)});
  assert.deepEqual(result,{status:17,signal:null}); assert.equal(errors,stderr);
  assert.equal(summaries.length,1);
  const summary = summaries[0];
  assert.deepEqual(Object.keys(summary).sort(),['phase','elapsedMs','exitCode','signal','workspaceCompileNotices','dependencyCompileNotices'].sort());
  assert.equal(summary.phase,'build');assert.ok(summary.elapsedMs>=0);assert.equal(summary.exitCode,17);assert.equal(summary.signal,null);
  assert.equal(summary.workspaceCompileNotices,1);assert.equal(summary.dependencyCompileNotices,1);
  assert.doesNotMatch(JSON.stringify(summary),/PRIVATE|fixture_dependency|原因/);
  await assert.rejects(runNativeCommand(join(root,'missing'),[],{cwd:root,env:{},phase:'test'}),{code:'ENOENT'});
  if (process.platform !== 'win32') {
    writeFileSync(script,'process.kill(process.pid,"SIGTERM");');
    const signaled=await runNativeCommand(process.execPath,[script],{cwd:root,env:childEnv(join(root,'environment'),{},inputs),phase:'test',writeSummary:value=>summaries.push(value)});
    assert.deepEqual(signaled,{status:null,signal:'SIGTERM'});assert.equal(summaries.at(-1).signal,'SIGTERM');
  }
});
