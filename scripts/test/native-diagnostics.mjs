import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {cpus,loadavg} from 'node:os';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

export function nativeHostLoad(tool, env, phase) {
  if(!['before','after'].includes(phase))throw new Error('Unknown native host snapshot phase');
  const host={phase,cpuCount:cpus().length,load:loadavg()};
  if(typeof tool!=='string'||!isAbsolute(tool))return {...host,available:false,reason:'missing-tool'};
  const result=spawnSync(tool,['-A','-ww','-o','pid=,pcpu=,comm='],{env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)return {...host,available:false,reason:'process-failed',exitCode:result.status,signal:result.signal};
  const groups=Object.fromEntries(['compiler','native','power','indexing','security','kernel','runner','diagnostic','other'].map(role=>[role,{processes:0,cpuPercent:0}]));
  for(const line of result.stdout.trim().split('\n')) {
    const match=/^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if(!match||!Number.isFinite(Number(match[1]))||!Number.isFinite(Number(match[2])))return {...host,available:false,reason:'parse-failed'};
    const name=basename(match[3].trim());
    const role=Number(match[1])===process.pid||name==='ps'?'diagnostic'
      :/^(?:rustc|rustdoc|cargo|clippy-driver|clang|clang\+\+|ld|ld64|rust-lld|dsymutil|rust-objcopy)$/.test(name)?'compiler'
      :/^occipital(?:$|[-.])/.test(name)?'native'
      :name==='PerfPowerServices'?'power'
      :/^(?:mds|mds_stores|mdworker|mdworker_shared)$/.test(name)?'indexing'
      :/^(?:syspolicyd|trustd|XProtectService|XProtectBehaviorService|XProtectRemediator)$/.test(name)?'security'
      :name==='kernel_task'?'kernel'
      :/^(?:node|bash|sh|Runner\.Worker|Runner\.Listener)$/.test(name)?'runner':'other';
    groups[role].processes++;groups[role].cpuPercent+=Number(match[2]);
  }
  for(const group of Object.values(groups))group.cpuPercent=Math.round(group.cpuPercent*100)/100;
  return {...host,available:true,groups};
}

export function summarizeNativeCache(home, target) {
  const started = performance.now(), groups = {};
  for (const name of ['registryArchives','registrySources','registryIndex','cargoGit','targetWorkspaceNamed','targetDepsDirectory','targetBuildScripts','targetFingerprints','targetIncremental','targetOther']) {
    groups[name] = {files:0, bytes:0, symlinks:0};
  }
  const walk = (root, classify) => {
    if (!lstatSync(root,{throwIfNoEntry:false})) return;
    const pending = [{path:root,parts:[]}];
    while (pending.length) {
      const {path,parts} = pending.pop(), info = lstatSync(path), bucket = groups[classify(parts)];
      if (info.isSymbolicLink()) {bucket.symlinks++;continue;}
      if (info.isDirectory()) {
        for (const name of readdirSync(path)) pending.push({path:join(path,name),parts:[...parts,name]});
      } else if (info.isFile()) {bucket.files++;bucket.bytes+=info.size;}
    }
  };
  for (const [name,path] of [['registryArchives',join(home,'registry/cache')],['registrySources',join(home,'registry/src')],['registryIndex',join(home,'registry/index')],['cargoGit',join(home,'git')]]) walk(path,()=>name);
  walk(target,parts=>{
    if (parts.includes('incremental')) return 'targetIncremental';
    // This is a name-based subset, not a claim that all workspace test binaries share the crate name.
    if (parts.some(name=>/^(?:lib)?occipital(?:[-_.]|$)/.test(name))) return 'targetWorkspaceNamed';
    for (const [directory,name] of [['deps','targetDepsDirectory'],['build','targetBuildScripts'],['.fingerprint','targetFingerprints']]) if (parts.includes(directory)) return name;
    return 'targetOther';
  });
  return {groups,elapsedMs:performance.now()-started};
}

export function cargoLogProjection(writeError) {
  const counts = {messages:0,dirtyUnits:0,fingerprintErrors:0,sourceChanged:0,missingFile:0,dependencyChanged:0,compilerChanged:0,flagsChanged:0,featuresChanged:0,environmentChanged:0,otherDirty:0,workspaceCompileNotices:0,dependencyCompileNotices:0};
  let causes = false;
  return {counts, line(raw) {
    const plain = raw.replace(/\x1b\[[0-9;]*m/g,''), marker = plain.match(/^\s*\d+(?:\.\d+)?s\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b.*?\bcargo::(?:core::)?compiler::fingerprint:\s*(.*)/);
    if (marker) {
      counts.messages++;
      const message = marker[1];
      if (message.startsWith('fingerprint dirty for ')) counts.dirtyUnits++;
      if (message.startsWith('fingerprint error for ')) counts.fingerprintErrors++;
      if (message.startsWith('err:')) causes = true;
      if (message.startsWith('dirty:')) {
        const name = /StaleItem\(ChangedFile\b/.test(message) ? 'sourceChanged'
          : /\bMissingFile\b/.test(message) ? 'missingFile'
          : /\b(?:UnitDependencyInfoChanged|DepFingerprintChanged|DependencyChanged|StaleDepFingerprint)\b/.test(message) ? 'dependencyChanged'
          : /\bRustcChanged\b/.test(message) ? 'compilerChanged'
          : /\bRustflagsChanged\b/.test(message) ? 'flagsChanged'
          : /\bFeaturesChanged\b/.test(message) ? 'featuresChanged'
          : /\bEnvVarChanged\b/.test(message) ? 'environmentChanged' : 'otherDirty';
        counts[name]++;
      }
      return;
    }
    if (causes && (!plain.trim() || plain==='Caused by:' || /^\s/.test(plain) && !/^\s*(?:Compiling|Checking|Finished|Fresh|Updating|Downloading|Downloaded|Locking|Running|Doc-tests|Blocking|warning:|error:)/.test(plain))) return;
    causes = false;
    const compiling=plain.match(/^\s*(?:Compiling|Checking)\s+([a-zA-Z0-9_-]+)\s+v\d/);
    if(compiling) counts[compiling[1]==='occipital'?'workspaceCompileNotices':'dependencyCompileNotices']++;
    writeError(raw+'\n');
  }};
}

export async function runNativeCommand(cargo, args, {cwd,env,phase,writeError=value=>process.stderr.write(value),writeSummary=value=>console.log('Cargo summary: '+JSON.stringify(value))}) {
  if (!['fmt','test','clippy','build'].includes(phase)) throw new Error('Unknown native diagnostic phase');
  const projection = cargoLogProjection(writeError), started = performance.now();
  const child = spawn(cargo,args,{cwd,env:{...env,CARGO_LOG:'cargo::compiler::fingerprint=info'},stdio:['inherit','inherit','pipe']});
  const lines = createInterface({input:child.stderr,crlfDelay:Infinity});
  lines.on('line',raw=>projection.line(raw));
  try {
    const result = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
    writeSummary({phase,elapsedMs:performance.now()-started,exitCode:result.status,signal:result.signal,...projection.counts});
    return result;
  } finally {lines.close();}
}
