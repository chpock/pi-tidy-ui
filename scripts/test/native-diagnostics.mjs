import { spawn } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

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

export async function runNativeCommand(cargo, args, {cwd,env,phase,writeError=value=>process.stderr.write(value),writeSummary=value=>console.log('Cargo summary: '+JSON.stringify(value))}) {
  if (!['fmt','test','clippy','build'].includes(phase)) throw new Error('Unknown native diagnostic phase');
  const counts = {workspaceCompileNotices:0,dependencyCompileNotices:0}, started = performance.now();
  const child = spawn(cargo,args,{cwd,env,stdio:['inherit','inherit','pipe']});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',writeError);
  const lines = createInterface({input:child.stderr,crlfDelay:Infinity});
  lines.on('line',raw=>{
    const compiling = raw.replace(/\x1b\[[0-9;]*m/g,'').match(/^\s*(?:Compiling|Checking)\s+([a-zA-Z0-9_-]+)\s+v\d/);
    if (compiling) counts[compiling[1]==='occipital'?'workspaceCompileNotices':'dependencyCompileNotices']++;
  });
  try {
    const result = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
    writeSummary({phase,elapsedMs:performance.now()-started,exitCode:result.status,signal:result.signal,...counts});
    return result;
  } finally {lines.close();}
}
