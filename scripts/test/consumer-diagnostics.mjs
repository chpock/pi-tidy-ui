import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const numeric = (source, keys) => Object.fromEntries(keys.filter(key => typeof source?.[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0).map(key => [key,source[key]]));
const phases = ['sourceAndSetup','hostInstall','dependencyCopy','archiveInputs','integrationInputs','nativeAndRustInputs','consumerAcquisition','dependencySeal'];
const npmPhases = ['npm','npm:load','idealTree','idealTree:init','idealTree:userRequests','idealTree:buildDeps','idealTree:fixDepFlags','idealTree:inflate','idealTree:prune','reify','reify:loadTrees','reify:diffTrees','reify:retireShallow','reify:createSparse','reify:loadBundles','reify:unpack','reify:unretire','reify:build','reify:trash','reify:save','build','build:deps','build:queue','build:link','command:install','command:pack'];
const oneOf = (value, allowed) => allowed.includes(value) ? value : undefined;

export function projectConsumerDiagnostics(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid consumer diagnostic object');
  const result = {kind,...numeric(value,['elapsedMs','npmMs','cleanupMs','archiveRecords','configuredThreadpoolSize','exitCode','invalidTimings','archiveCacheHits','archiveCacheMisses','archiveRequests','archiveBytes','archiveTarCommands','archiveCacheMs','archiveFetchMs','archiveTarMs'])};
  if (typeof value.node === 'string' && /^v\d+\.\d+\.\d+$/.test(value.node)) result.node = value.node;
  for (const key of ['completed','offline','killed']) if (typeof value[key] === 'boolean') result[key] = value[key];
  const operation = oneOf(value.operation,['pack','install']), mode = oneOf(value.mode,['standard','lock-only','dry-run']);
  if (operation) result.operation = operation;
  if (mode) result.mode = mode;
  if (typeof value.temporaryDrive === 'string' && /^[A-Z]$/.test(value.temporaryDrive)) result.temporaryDrive = value.temporaryDrive;
  if (value.phases) result.phases = numeric(value.phases,phases);
  if (Array.isArray(value.timings)) result.timings = value.timings.map(timing => ({phases:numeric(timing?.phases,npmPhases),reifyNodes:numeric(timing?.reifyNodes,['count','totalMs','maxMs'])}));
  const errno = oneOf(value.errno,['ENOENT','EACCES','EPERM','ENOSPC','EINTEGRITY','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOBUFS']);
  if (errno) result.errno = errno;
  const signal = oneOf(value.signal,['SIGTERM','SIGKILL','SIGINT','SIGABRT']);
  if (signal) result.signal = signal;
  return result;
}

export function printConsumerDiagnostics(preparation, write = console.log) {
  if (!isAbsolute(preparation)) throw new Error('Consumer preparation path must be absolute');
  const directories = [join(preparation,'consumer','diagnostics')];
  const receipt = join(preparation,'inputs.json');
  if (existsSync(receipt)) {
    const inputs = JSON.parse(readFileSync(receipt,'utf8'));
    if (typeof inputs.source?.root !== 'string' || !isAbsolute(inputs.source.root)) throw new Error('Consumer source root must be absolute');
    directories.push(join(inputs.source.root,'.test-artifacts'));
  }
  let count = 0;
  for (const root of new Set(directories)) {
    if (!existsSync(root)) continue;
    for (const directory of readdirSync(root,{withFileTypes:true})) {
      if (!directory.isDirectory() || !/^installed-preparation-[\w-]+$/.test(directory.name)) continue;
      for (const file of ['fixture.json','npm.json']) {
        const path = join(root,directory.name,file);
        if (!existsSync(path)) continue;
        write('Consumer summary: ' + JSON.stringify(projectConsumerDiagnostics(JSON.parse(readFileSync(path,'utf8')),file === 'npm.json' ? 'npm' : 'fixture')));
        count++;
      }
    }
  }
  if (!count) write('Consumer summary: no completed diagnostic reports are available.');
}
