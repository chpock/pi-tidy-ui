import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {cpus,freemem,loadavg,totalmem} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {childEnv,rustLoaderEnvironment} from './context.mjs';
import {readNativeInputs} from './prepare-native.mjs';
import {snapshotIdentity} from './prepare.mjs';
import {runNativeCommand,summarizeNativeCache} from './native-diagnostics.mjs';

export async function compareNativeArm({inputs,home,targetDirectory,target,mode,prepare=false,platform=process.platform}) {
  assert.equal(platform,'darwin','This diagnostic requires macOS');
  assert.equal(target,'x86_64-apple-darwin','This diagnostic compares only Intel macOS');
  assert.ok(['default','disabled'].includes(mode),'Unknown incremental comparison mode');
  assert.ok(isAbsolute(home)&&isAbsolute(targetDirectory),'Explicit absolute Cargo paths are required');
  const state=join(inputs.runRoot,'native-comparison.json');
  const files=JSON.parse(readFileSync(join(inputs.runRoot,'source-files.json'),'utf8'));
  const sourceTree=snapshotIdentity(inputs.project,files).tree;
  const baseline=mode==='disabled'?JSON.parse(readFileSync(state,'utf8')):undefined;
  if(baseline) {
    assert.equal(baseline.mode,'default');assert.equal(baseline.sourceTree,sourceTree);
    assert.equal(baseline.targetDirectory,targetDirectory);assert.equal(baseline.home,home);
  } else assert.equal(existsSync(state),false,'A comparison must begin with a fresh baseline');
  const env=childEnv(join(inputs.runRoot,'native-runtime'),{
    ...rustLoaderEnvironment(inputs.rust.root,platform),PATH:[join(inputs.rust.root,'bin'),inputs.tools.path??inputs.tools.bin].join(':'),
    CARGO_HOME:home,CARGO_TARGET_DIR:targetDirectory,CARGO_NET_OFFLINE:'true',RUSTC:inputs.rust.rustc,
    RUSTUP_AUTO_INSTALL:'0',RUSTUP_TOOLCHAIN:inputs.rust.root,...(mode==='disabled'?{CARGO_INCREMENTAL:'0'}:{}),
  },inputs);
  const cargo=inputs.rust.cargo;
  if(prepare)for(const release of [false,true]) {
    const args=['clean','--locked','--offline','-p','occipital','--target',target,...(release?['--release']:[])];
    const result=spawnSync(cargo,args,{cwd:inputs.project,env,stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)return result.status??1;
  }
  if(prepare)return 0;
  const before=summarizeNativeCache(home,targetDirectory);
  assert.equal(before.groups.targetIncremental.bytes,0,'Workspace incremental state survived package cleanup');
  assert.equal(before.groups.targetWorkspaceNamed.bytes,0,'Workspace outputs survived package cleanup');
  console.log('Native comparison start: '+JSON.stringify({mode,sourceTree,commit:inputs.source.commit,
    host:{cpuCount:cpus().length,model:cpus()[0]?.model,load:loadavg(),freeBytes:freemem(),totalBytes:totalmem()}}));
  const phases=[];
  for(const args of [['fmt','--all','--check'],['test','--workspace','--locked','--offline','--target',target],
    ['clippy','--workspace','--all-targets','--locked','--offline','--target',target,'--','-D','warnings'],
    ['build','--release','--locked','--offline','-p','occipital','--target',target]]) {
    const result=await runNativeCommand(cargo,args,{cwd:inputs.project,env,phase:args[0],writeSummary:summary=>{
      phases.push(summary);console.log('Cargo summary: '+JSON.stringify({...summary,comparisonMode:mode}));
    }});
    if(result.status!==0)return result.status??1;
    assert.equal(phases.at(-1).dependencyCompileNotices,0,'Comparison requires a warm dependency cache');
  }
  assert.equal(snapshotIdentity(inputs.project,files).tree,sourceTree,'Native tests changed the comparison source');
  const binary=readFileSync(join(targetDirectory,target,'release','occipital'));
  const sha256=createHash('sha256').update(binary).digest('hex');
  const incremental=summarizeNativeCache(home,targetDirectory).groups.targetIncremental;
  if(mode==='disabled') {
    assert.equal(sha256,baseline.sha256,'Incremental policy changed release bytes');
    assert.equal(incremental.bytes,0,'Disabled incremental compilation still produced state');
  }
  const record={mode,sourceTree,commit:inputs.source.commit,targetDirectory,home,sha256,bytes:binary.length,incremental,phases};
  if(mode==='default')writeFileSync(state,JSON.stringify(record));
  // Absolute paths remain private comparison state, not diagnostic log fields.
  const {targetDirectory:ignoredTarget,home:ignoredHome,...summary}=record;
  console.log('Native comparison result: '+JSON.stringify(summary));
  return 0;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length<=4&&(process.argv[3]===undefined||process.argv[3]==='--prepare'),'Unknown comparison argument');
  const inputs=readNativeInputs(join(process.env.RUNNER_TEMP,'native-build-inputs/inputs.json'));
  process.exitCode=await compareNativeArm({inputs,home:process.env.CARGO_HOME,targetDirectory:process.env.CARGO_TARGET_DIR,
    target:process.env.RUST_TARGET,mode:process.argv[2],prepare:process.argv[3]==='--prepare'});
}
