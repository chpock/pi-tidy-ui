import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';
import { cargoLogProjection, runNativeCommand, summarizeNativeCache } from '../../scripts/test/native-diagnostics.mjs';

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

test('native diagnostics: Cargo reasons are fixed counters, while real compiler warnings/errors remain visible', () => {
  let errors = ''; const projection = cargoLogProjection(value=>{errors+=value;});
  const prefix = '0.001s INFO prepare_target{package_id=PRIVATE_MARKER}: cargo::compiler::fingerprint: ';
  for (const line of [prefix+'fingerprint dirty for PRIVATE_MARKER',prefix+'dirty: FsStatusOutdated(StaleItem(ChangedFile { stale: "/private/PRIVATE_MARKER" }))',
    prefix+'fingerprint error for PRIVATE_MARKER',prefix+'err: failed to read /private/PRIVATE_MARKER','', 'Caused by:', '    No such file or directory (os error 2)',
    '   Compiling fixture v0.0.0', 'error: deliberate compiler failure', '  --> source.rs:1:1', 'warning: visible warning',
    'error: user code mentions cargo::compiler::fingerprint: not a trace']) projection.line(line);
  assert.equal(projection.counts.sourceChanged,1);assert.equal(projection.counts.dirtyUnits,1);assert.equal(projection.counts.fingerprintErrors,1);
  assert.equal(projection.counts.otherDirty,0);
  assert.doesNotMatch(errors,/PRIVATE_MARKER|Caused by:|No such file/);
  assert.match(errors,/Compiling fixture/);assert.match(errors,/deliberate compiler failure/);assert.match(errors,/source.rs:1:1/);assert.match(errors,/visible warning/);
  assert.match(errors,/user code mentions cargo::compiler::fingerprint: not a trace/);
  assert.doesNotMatch(JSON.stringify(projection.counts),/PRIVATE_MARKER|source.rs/);
});

test('native diagnostics: command status/signal and stderr survive explicit sanitized Cargo logging', async t => {
  const root = fixture(t), script = join(root,'fixture.mjs'), inputs = readInputs(), summaries = []; let errors = '';
  writeFileSync(script,`if(process.env.CARGO_LOG!=='cargo::compiler::fingerprint=info')throw Error('missing explicit trace');
if(process.env.PRIVATE_AMBIENT_MARKER)throw Error('ambient inherited');
console.error('0.001s INFO cargo::compiler::fingerprint: dirty: EnvVarChanged("PRIVATE_MARKER")');
console.error('error: fixture compiler failed');process.exitCode=17;`);
  const previous = process.env.PRIVATE_AMBIENT_MARKER; process.env.PRIVATE_AMBIENT_MARKER='private';
  t.after(()=>{if(previous===undefined)delete process.env.PRIVATE_AMBIENT_MARKER;else process.env.PRIVATE_AMBIENT_MARKER=previous;});
  const result = await runNativeCommand(process.execPath,[script],{cwd:root,env:childEnv(join(root,'environment'),{},inputs),phase:'build',writeError:value=>{errors+=value;},writeSummary:value=>summaries.push(value)});
  assert.deepEqual(result,{status:17,signal:null}); assert.equal(summaries.length,1); assert.equal(summaries[0].exitCode,17);
  assert.equal(summaries[0].environmentChanged,1);assert.match(errors,/fixture compiler failed/);assert.doesNotMatch(errors,/PRIVATE_MARKER/);
  await assert.rejects(runNativeCommand(join(root,'missing'),[],{cwd:root,env:{},phase:'test'}),{code:'ENOENT'});
  if (process.platform !== 'win32') {
    writeFileSync(script,'process.kill(process.pid,"SIGTERM");');
    const signaled=await runNativeCommand(process.execPath,[script],{cwd:root,env:childEnv(join(root,'environment'),{},inputs),phase:'test',writeSummary:value=>summaries.push(value)});
    assert.deepEqual(signaled,{status:null,signal:'SIGTERM'});assert.equal(summaries.at(-1).signal,'SIGTERM');
  }
});
