// Sequential fresh processes; rotated engine order; timing and memory separate.
import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const bin=process.env.RESEARCH_NODE ?? '/tmp/pi-tidy-ui-head-to-head/node-v22.19.0-linux-x64/bin/node';
const kinds=['tree-wasm','shiki-onig','tree-native','shiki-js'];
const target=new URL('./results.jsonl',import.meta.url);const refresh=process.argv[2]==='memory-refresh';const kept=refresh?readFileSync(target,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.scenario!=='memory'):[];writeFileSync(target,kept.map(JSON.stringify).join('\n')+(kept.length?'\n':''));
for(const scenario of refresh?['memory']:['bench','memory'])for(let trial=0;trial<(scenario==='bench'?5:3);trial++) {
  const order=kinds.map((_,i)=>kinds[(i+trial)%kinds.length]);
  for(const kind of order){
    const run=spawnSync(bin,['--expose-gc',new URL('./run.mjs',import.meta.url).pathname,kind,scenario],{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
    if(run.status!==0)throw new Error(`${kind} ${scenario}: ${run.error??run.stderr}`);
    const data=JSON.parse(run.stdout);data.trial=trial;appendFileSync(target,JSON.stringify(data)+'\n');console.log(`${scenario} trial ${trial} ${kind}: init ${data.initializationMs.toFixed(1)} ms`);
  }
}
if(!refresh)for(const lines of [1000,10000])for(const lang of ['typescript','bash'])for(const kind of kinds){
  const run=spawnSync(bin,['--expose-gc',new URL('./run.mjs',import.meta.url).pathname,kind,'profile',String(lines),lang],{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
  if(run.status!==0)throw new Error(`${kind} profile: ${run.error??run.stderr}`);
  const data=JSON.parse(run.stdout);appendFileSync(target,JSON.stringify(data)+'\n');console.log(`profile ${kind} ${lang} ${lines} complete`);
}
for(const [a,b]of [['tree-native','tree-wasm'],['shiki-js','shiki-onig']]) {
  const x=JSON.parse(readFileSync(new URL(`./check-${a}.json`,import.meta.url))),y=JSON.parse(readFileSync(new URL(`./check-${b}.json`,import.meta.url)));
  assert.deepEqual(x.quality.map(q=>({lang:q.lang,spans:q.spans})),y.quality.map(q=>({lang:q.lang,spans:q.spans})),`Cross-runtime role equality ${a}/${b}`);
}
console.log('All fresh-process trials and cross-runtime role controls passed.');
