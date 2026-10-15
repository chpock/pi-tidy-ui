import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, readlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, digest, readInputs } from '../scripts/test/context.mjs';
import { dependencyIdentity, materializeDependencies, materializeSource, refreshInputs, sourceIdentity } from '../scripts/test/prepare.mjs';
import { runFeature } from '../scripts/test/feature.mjs';
function temporary(t) { const root=mkdtempSync(join(tmpdir(),'feature-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
function sourceFixture(t) {
  const root=temporary(t), source=join(root,'source'), runRoot=join(root,'runtime'), tree=join(runRoot,'project'), preparation=join(root,'preparation'), original=readInputs();
  mkdirSync(source); mkdirSync(preparation);
  for(const [name,value] of Object.entries({'package.json':'{"type":"module"}','package-lock.json':'{}','old.ts':'old source'})) writeFileSync(join(source,name),value);
  const env=childEnv(join(root,'environment'),{},original);
  const git=(...args)=>execFileSync(original.tools.git,args,{cwd:source,env,encoding:'utf8'});
  git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const identity=sourceIdentity(source,original.tools,env); materializeSource(source,tree,identity.files);
  const coding=join(tree,'node_modules/@earendil-works/pi-coding-agent');mkdirSync(coding,{recursive:true});
  const manifest=join(coding,'package.json');writeFileSync(manifest,JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.0.0',bin:{pi:'cli.js'}}));writeFileSync(join(coding,'cli.js'),'actual sealed bytes');
  const {files,...record}=identity, lock=join(source,'package-lock.json');
  const inputs={...original,native:{commit:'a'.repeat(40),nativeTree:'b'.repeat(64)},runRoot,preparation,source:record,pi:{root:tree,version:'1.0.0',cli:join(coding,'cli.js'),lock,lockSha256:digest(readFileSync(lock)),packages:[{name:'@earendil-works/pi-coding-agent',version:'1.0.0',path:manifest,sha256:digest(readFileSync(manifest))}]},
    install:{manifest:digest(readFileSync(join(source,'package.json'))),lock:digest(readFileSync(lock)),platform:process.platform,arch:process.arch,modules:dependencyIdentity(join(tree,'node_modules'))}};
  const path=join(preparation,'inputs.json');writeFileSync(path,JSON.stringify(inputs));writeFileSync(join(runRoot,'source-files.json'),JSON.stringify(files));
  return {root,source,tree,inputs,path,coding,save:()=>writeFileSync(path,JSON.stringify(inputs))};
}
test('source refresh removes deleted sources and reuses sealed dependencies without install or copy', t=>{
  const f=sourceFixture(t);rmSync(join(f.source,'old.ts'));writeFileSync(join(f.source,'next.ts'),'new source');
  const result=refreshInputs(f.path);
  assert.equal(readFileSync(join(f.tree,'next.ts'),'utf8'),'new source');
  assert.throws(()=>readFileSync(join(f.tree,'old.ts')),{code:'ENOENT'});
  assert.equal(readFileSync(join(f.coding,'cli.js'),'utf8'),'actual sealed bytes');
  assert.deepEqual({...result.preparationStats,elapsedMs:0},{kind:'refresh',elapsedMs:0,dependencyInstalls:0,dependencyCopies:0,sourceCopies:3});
  assert.equal(refreshInputs(f.path).preparationStats.sourceCopies,0);
  assert.equal(result.native.commit,f.inputs.native.commit,'refresh never relabels native provenance');
});
test('source refresh supports directory-to-file changes and refuses dependency tampering',t=>{
  const f=sourceFixture(t);mkdirSync(join(f.source,'shape'));writeFileSync(join(f.source,'shape/child.ts'),'child');refreshInputs(f.path);
  rmSync(join(f.source,'shape'),{recursive:true});writeFileSync(join(f.source,'shape'),'file');refreshInputs(f.path);assert.equal(readFileSync(join(f.tree,'shape'),'utf8'),'file');
  writeFileSync(join(f.coding,'cli.js'),'tampered');assert.throws(()=>refreshInputs(f.path),/dependency bytes changed/);
});
test('refresh rejects changed host manifest/lock, unsealed stores and corrupt source inventories',t=>{
  for(const name of ['package.json','package-lock.json']) {const f=sourceFixture(t);writeFileSync(join(f.source,name),'{"changed":true}');assert.throws(()=>refreshInputs(f.path),/inputs changed|lock identity changed/);}
  const f=sourceFixture(t);writeFileSync(join(f.inputs.runRoot,'source-files.json'),'["../escape"]');assert.throws(()=>refreshInputs(f.path),/source inventory/);
  delete f.inputs.install;f.save();assert.throws(()=>refreshInputs(f.path),/sealed owned host/);
});
test('feature completion composes types product baseline smoke and affected physical group once',async t=>{
  const output=join(temporary(t),'results'), calls=[];
  const report=await runFeature({inputs:readInputs().inputsPath,features:'footer,footer',output},async options=>{
    calls.push(options);return {status:'passed',counts:{pass:1,fail:0,skipped:0},selected:options.files?.split(',')??[]};
  });
  assert.equal(report.status,'passed');assert.deepEqual(calls.map(c=>c.suite),['check','groups','groups']);assert.deepEqual(report.features,['footer']);
  assert.ok(calls[1].files.includes('occipital-controller.test.ts'));assert.ok(!calls[1].files.includes('occipital-controller.native.test.ts'));
  assert.deepEqual(calls[2].files.split(','),['footer.cli.test.mjs','smoke.cli.test.mjs']);assert.deepEqual(report.requirements,[]);
  assert.ok(JSON.parse(readFileSync(join(output,'report.json'))).elapsedMs>=0);
});
test('affected-only stages do not duplicate baseline, and no selection is silently a default',async t=>{
  const root=temporary(t), calls=[];
  const report=await runFeature({inputs:readInputs().inputsPath,features:'footer',output:root,'affected-only':true},async options=>{calls.push(options);return {status:'passed',counts:{skipped:0},selected:[]};});
  assert.equal(report.purpose,'affected-only');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.suite!=='check'));assert.ok(!calls.at(-1).files.includes('smoke.cli.test.mjs'));
  await assert.rejects(runFeature({features:'','affected-only':true,output:root}),/Empty feature/);
  await assert.rejects(runFeature({output:root}),/explicit --features/);
});
test('failed or skipped stages cannot become feature acceptance or run later stages',async t=>{
  for(const result of [{status:'failed',counts:{fail:1}},{status:'passed',counts:{skipped:1}}]) {
    let calls=0;const output=temporary(t), report=await runFeature({inputs:readInputs().inputsPath,features:'footer',output},async()=>{calls++;return result;});
    assert.notEqual(report.status,'passed');assert.equal(calls,1);assert.notEqual(JSON.parse(readFileSync(join(output,'report.json'))).status,'passed');
  }
});

test('owned dependency copy retains relative POSIX executables and Windows wrapper bytes',t=>{
  const root=temporary(t), source=join(root,'dependencies/node_modules'), copy=join(root,'runtime/node_modules');
  mkdirSync(join(source,'.bin'),{recursive:true});mkdirSync(join(source,'tool'));
  writeFileSync(join(source,'tool/cli.js'),'selected tool');
  if(process.platform==='win32')writeFileSync(join(source,'.bin/tool.cmd'),'@node ..\\tool\\cli.js');
  else symlinkSync('../tool/cli.js',join(source,'.bin/tool'));
  materializeDependencies(source,copy);
  if(process.platform!=='win32')assert.equal(readlinkSync(join(copy,'.bin/tool')),'../tool/cli.js');
  assert.equal(dependencyIdentity(copy),dependencyIdentity(source));
  rmSync(source,{recursive:true});assert.equal(readFileSync(join(copy,'tool/cli.js'),'utf8'),'selected tool');
  if(process.platform!=='win32')assert.equal(readFileSync(join(copy,'.bin/tool'),'utf8'),'selected tool');
});

test('additional Pi type checking is explicit and cannot restore unrelated baseline runtime groups',async t=>{
  const calls=[],output=temporary(t),options={inputs:readInputs().inputsPath,features:'footer',output,'affected-only':true,'check-types':true};
  const report=await runFeature(options,async option=>{calls.push(option);return{status:'passed',counts:{skipped:0},selected:option.files?.split(',')??[]};});
  assert.equal(report.status,'passed');assert.deepEqual(calls.map(call=>call.suite),['check','groups','groups']);
  assert.equal(calls[1].files,'footer-session-name.test.ts,footer-session-title.test.ts,footer.sdk.test.ts');assert.equal(calls[2].files,'footer.cli.test.mjs');
  let invoked=0;const failure=await runFeature({...options,output:temporary(t)},async option=>{invoked++;assert.equal(option.suite,'check');return{status:'failed',counts:{fail:1}};});
  assert.equal(failure.status,'failed');assert.equal(invoked,1,'a type failure prevents runtime acceptance');
});

test('interrupted source refresh remembers attempted additions until later cleanup',t=>{
  const f=sourceFixture(t),added=join(f.source,'a-added.ts'),last=join(f.source,'z-added.ts');writeFileSync(added,'partially copied addition');writeFileSync(last,'last addition');
  const copy=fs.cpSync;
  fs.cpSync=(source,...args)=>{if(source===last)throw new Error('controlled copy interruption');return copy(source,...args);};syncBuiltinESMExports();
  try{assert.throws(()=>refreshInputs(f.path),/controlled copy interruption/);}finally{fs.cpSync=copy;syncBuiltinESMExports();}
  assert.equal(readFileSync(join(f.tree,'a-added.ts'),'utf8'),'partially copied addition');
  rmSync(added);rmSync(last);refreshInputs(f.path);
  assert.throws(()=>readFileSync(join(f.tree,'a-added.ts')),{code:'ENOENT'});
  assert.equal(readFileSync(join(f.tree,'old.ts'),'utf8'),'old source');
});

test('actual feature CLI accepts additional Pi type-check option before sealed input admission',t=>{
  const root=temporary(t),output=join(root,'report'),inputs=readInputs();
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/test/feature.mjs',import.meta.url)),'--inputs',join(root,'missing-inputs.json'),'--features','footer','--affected-only','--check-types','--output',output],{env:childEnv(join(root,'invocation'),{},inputs),encoding:'utf8'});
  assert.notEqual(result.status,0,'an absent sealed graph must still fail');
  assert.doesNotMatch(result.stderr,/ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  const report=JSON.parse(readFileSync(join(output,'report.json'),'utf8'));
  assert.equal(report.purpose,'affected-only');assert.equal(report.status,'setup-failed');assert.deepEqual(report.requirements,[]);
});
