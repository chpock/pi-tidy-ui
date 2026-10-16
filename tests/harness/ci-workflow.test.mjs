import '../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildCIPlan} from '../../scripts/test/ci-plan.mjs';
import {childEnv,readInputs} from '../../scripts/test/context.mjs';

const repo=resolve(import.meta.dirname, "../.."),commit='a'.repeat(40);
const ci=()=>readFileSync(join(repo,'.github/workflows/ci.yml'),'utf8');
function job(source,name){const start=source.indexOf('\n  '+name+':\n');assert.ok(start>=0,name);return source.slice(start+1).split(/\n(?=  [a-z][\w-]*:\s*\n)/)[0];}
function step(source,name){const start=source.indexOf('      - name: '+name+'\n');assert.ok(start>=0,name);return source.slice(start).split(/\n(?=      - )/)[0];}
function javascript(source){const script=source.split("          node --input-type=module <<'JS'\n")[1]?.split('\n          JS')[0];assert.ok(script,'Actual executable workflow JavaScript');return script.split('\n').map(line=>line.replace(/^          /,'')).join('\n');}
function fixture(t){const root=mkdtempSync(join(tmpdir(),'fixed-ci-workflow-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function executeScript(root,script,extra={},preload){const inputs=readInputs();return spawnSync(inputs.node.path,[...(preload?['--import',pathToFileURL(preload).href]:[]),'--input-type=module','-e',script],{cwd:repo,env:childEnv(root,extra,inputs),encoding:'utf8',timeout:15000});}
const fetchLatest=async()=>Response.json({name:'@earendil-works/pi-coding-agent',version:'1.3.0'});

function needsFor(plan){
 const needs={metadata:{result:'success'}};
 for(const [branch,name]of Object.entries({nativeHost:'native-linux',nativeRemaining:'native-platforms',nativeHostConsumers:'consumer-linux',sdk:'sdk',cli:'cli',delivery:'delivery',daemonRegressions:'daemon-regressions',preparedPack:'extension-package',daemonRelease:'release-occipital',daemonNpm:'publish-occipital-npm'}))needs[name]={result:plan.requiredBranches[branch]?'success':'skipped'};
 return needs;
}

test('every ordinary push and PR runs fixed complete profiles without diff routing or manual selection',()=>{
 const source=ci();
 assert.match(source,/push:\n    branches: \[main\]/);assert.match(source,/  pull_request:/);assert.match(source,/  schedule:\n    - cron: '23 3 \* \* \*'/);
 const dispatch=source.split('  workflow_dispatch:\n')[1].split('\npermissions:')[0];
 assert.match(dispatch,/clean-native-build:/);assert.doesNotMatch(dispatch,/full:|features:|scope-head:|base-sha:|compatibility:|rationale:|windows-only:/);
 assert.doesNotMatch(source,/ci-scope|git diff|scope-decision|add-features|execute-conservative|pull_request_target|github\.request|pull-requests: write/);
 for(const name of ['sdk','cli','delivery']){
  const branch=job(source,name);assert.match(branch,/uses: \.\/\.github\/workflows\/ci-checks.yml/);assert.match(branch,/fail-fast: false/);
  assert.match(branch,new RegExp('requiredBranches\\.'+name));assert.match(branch,/source-ref: \$\{\{ needs.metadata.outputs.source \}\}/);
  assert.doesNotMatch(branch,/--files|--groups|--pattern|--skip|scope|affected/);
 }
 assert.match(job(source,'sdk'),/needs: \[metadata, native-linux\]/);assert.match(job(source,'cli'),/needs: \[metadata, native-linux\]/);
 assert.match(job(source,'cli'),/shard: \$\{\{ matrix.shard \}\}/);
 assert.match(job(source,'delivery'),/needs: metadata/,'inert delivery must not wait for unrelated compilers');
});

test('actual metadata step pins one latest, records exact source and emits complete Node and CLI matrices',t=>{
 const root=fixture(t),output=join(root,'outputs'),trace=join(root,'fetches'),preload=join(root,'fetch.mjs');
 writeFileSync(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options)=>{if(url!=='https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest'||options.redirect!=='error')throw new Error('Unexpected metadata request');appendFileSync(process.env.FETCH_TRACE,'fetch\\n');return Response.json({name:'@earendil-works/pi-coding-agent',version:'1.3.0'});};`);
 const script=javascript(step(ci(),'Plan the complete fixed event obligations'));
 for(const eventName of ['push','schedule']){
  writeFileSync(output,'');writeFileSync(trace,'');
  const result=executeScript(root,script,{EVENT_NAME:eventName,EVENT_REF:'refs/heads/main',SOURCE_SHA:commit,WINDOWS_ARM64:'false',GITHUB_OUTPUT:output,FETCH_TRACE:trace},preload);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(readFileSync(trace,'utf8'),'fetch\n');
  const outputs=Object.fromEntries(readFileSync(output,'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  const plan=JSON.parse(outputs.plan),profiles=JSON.parse(outputs.profiles).include,shards=JSON.parse(outputs.cli_profiles).include;
  assert.equal(outputs.source,commit);assert.equal(plan.sourceRef,commit);assert.deepEqual(profiles,plan.profiles);
  assert.deepEqual(shards,plan.cliProfiles);assert.equal(plan.piSelection.latest,'1.3.0');assert.equal(shards.length,profiles.length*4);
  assert.deepEqual(JSON.parse(outputs.targets),plan.native.targets);
  if(eventName==='schedule'){assert.deepEqual([...new Set(profiles.map(row=>row.pi))],['1.3.0']);assert.deepEqual(JSON.parse(outputs.host_consumers),[]);assert.deepEqual(JSON.parse(outputs.delivery_profiles).include,[]);assert.deepEqual(JSON.parse(outputs.remaining),[]);}
  else{assert.equal(profiles.length,4);assert.equal(JSON.parse(outputs.remaining).length,4);}
 }
});

test('nightly has separate concurrency and final result; it cannot replace ordinary acceptance',()=>{
 const source=ci();
 assert.match(source,/group: \$\{\{ github.event_name == 'schedule' && 'nightly-latest' \|\| 'complete-ci' \}\}-\$\{\{ github.ref \}\}/);
 assert.match(job(source,'result'),/name: \$\{\{ github.event_name == 'schedule' && 'Nightly latest-Pi result' \|\| 'Complete CI result' \}\}/);
 assert.match(job(source,'sdk'),/nightly: \$\{\{ needs.metadata.outputs.kind == 'nightly' \}\}/);
 const checks=readFileSync(join(repo,'.github/workflows/ci-checks.yml'),'utf8');
 assert.match(checks,/nightly \? 'compatibility' : 'unit'/);assert.match(checks,/\['delivery','daemon'\].includes\(layer\) && \(nightly \|\| process.env.PI_VERSION !== '1.0.0'\)/);
});

test('actual required-result step rejects failed, cancelled, missing or skipped planned branches on subsequent commits',async t=>{
 const root=fixture(t),script=javascript(step(ci(),'Require every planned branch, including every CLI partition'));
 for(const eventName of ['push','schedule']){
  const plan=await buildCIPlan({eventName,ref:'refs/heads/main',sha:commit,fetchLatest}),needs=needsFor(plan);
  const execute=(candidate,selected=plan)=>executeScript(root,script,{CI_PLAN:JSON.stringify(selected),CI_NEEDS:JSON.stringify(candidate)});
  assert.equal(execute(needs).status,0);
  for(const result of ['failure','cancelled','skipped',undefined]){
   const candidate=structuredClone(needs);if(result===undefined)delete candidate.cli;else candidate.cli.result=result;
   const failed=execute(candidate,{...plan,sourceRef:'b'.repeat(40)});assert.notEqual(failed.status,0,'a later unrelated commit must not hide its CLI obligation');
  }
  const failed=structuredClone(needs);failed.metadata.result='failure';assert.notEqual(execute(failed).status,0);
 }
 const ordinary=await buildCIPlan({eventName:'push',ref:'refs/heads/main',sha:commit,fetchLatest}),needs=needsFor(ordinary);needs['native-platforms'].result='failure';
 assert.notEqual(executeScript(root,script,{CI_PLAN:JSON.stringify(ordinary),CI_NEEDS:JSON.stringify(needs)}).status,0,'other platform failures remain required even after Linux SDK success');
});

test('actual daemon result and publication dependencies require the complete native regression branch',async t=>{
 const root=fixture(t),source=ci(),script=javascript(step(source,'Require every planned branch, including every CLI partition'));
 const plan=await buildCIPlan({eventName:'push',ref:'refs/tags/occipital-v0.2.0',sha:commit,fetchLatest:()=>{throw new Error('No latest lookup for daemon');}}),needs=needsFor(plan);
 const execute=candidate=>executeScript(root,script,{CI_PLAN:JSON.stringify(plan),CI_NEEDS:JSON.stringify(candidate)});
 assert.equal(execute(needs).status,0);
 for(const result of ['failure','cancelled','skipped',undefined]){
  const candidate=structuredClone(needs);if(result===undefined)delete candidate['daemon-regressions'];else candidate['daemon-regressions'].result=result;
  assert.notEqual(execute(candidate).status,0);
 }
 assert.match(job(source,'release-occipital'),/needs: \[metadata, native-linux, native-platforms, consumer-linux, delivery, daemon-regressions\]/);
 assert.match(job(source,'daemon-regressions'),/requiredBranches.daemonRegressions/);
 assert.match(job(source,'daemon-regressions'),/layer: daemon/);
});

test('complete role uses discovered requirements and fixed suites; CLI cannot narrow its planned partition',()=>{
 const source=readFileSync(join(repo,'.github/workflows/ci-checks.yml'),'utf8');
 assert.match(source,/resolveSelection\(process.cwd\(\), \{suite,/);assert.match(source,/selection.requirements.includes\(key\)/);
 assert.match(source,/suite = layer === 'cli' \? 'cli' : layer === 'delivery' \? 'native-release' : layer === 'daemon' \? 'daemon-regression' : nightly \? 'compatibility' : 'unit'/);
 assert.match(source,/--suite cli --shard "\$CLI_SHARD" --network-isolated/);
 assert.doesNotMatch(source,/--files|--groups|--pattern|--skip|--affected-only|test:feature|upload-artifact/);
 assert.match(source,/Strict selected-host types\n        if: inputs.layer == 'node'/);
 assert.match(source,/--pi-version "\$PI_VERSION"/);assert.match(source,/--integration/);assert.match(source,/--shared-host/);assert.match(source,/--native-artifact/);
  const cachePath=source.match(/path: \$\{\{ runner\.temp \}\}\/([^/\s]+)\/environment\/cache\/npm\/_cacache/);
  assert.ok(cachePath,'only the owned content-addressed npm cache is retained');
  assert.ok(step(source,'Prepare exact host and required execution inputs').includes('--output "$RUNNER_TEMP/'+cachePath[1]+'"'),'cache and preparation must use the same owned root');
  const key=source.match(/^          key: (.+)$/m)[1];
  assert.ok(key.includes('inputs.pi'),'different Pi graphs must not freeze each other out of an immutable cache');
  assert.ok(key.includes('steps.selection.outputs.integration'),'profile packages must not depend on a core-only cache');
  for(const lock of ['package-lock.json','tests/fixtures/integration-profile/package-lock.json'])assert.ok(key.includes("'"+lock+"'"),'each dependency lock participates in the cache key');
});

test('only real release push tags can run publication or public-consumer release gates',()=>{
 const source=ci();
 for(const [name,product]of [['release-occipital','occipital'],['publish-occipital-npm','occipital'],['extension-package','pi-tidy-ui']]){
  assert.match(job(source,name),new RegExp("if: github.event_name == 'push' && startsWith\\(github.ref, 'refs/tags/"+product+"-v'\\)"));
 }
 const consumers=readFileSync(join(repo,'.github/workflows/occipital-consumer.yml'),'utf8');
 assert.match(step(consumers,'Published delivery (pi-tidy-ui release only)'),/if: github.event_name == 'push' && startsWith\(inputs.release-ref, 'refs\/tags\/pi-tidy-ui-v'\)/);
 assert.match(job(source,'publish-occipital-npm'),/needs: \[metadata, release-occipital\]/);
});


test('actual metadata step preserves explicit ARM64 opt-in and rejects invalid inputs before writing outputs',t=>{
 const root=fixture(t),output=join(root,'outputs'),trace=join(root,'fetches'),preload=join(root,'metadata.mjs');
 writeFileSync(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options)=>{if(url!=='https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest'||options.redirect!=='error')throw new Error('Unexpected metadata request');appendFileSync(process.env.FETCH_TRACE,'fetch\\n');if(process.env.RESPONSE_MODE==='unavailable')throw new Error('CONTROLLED_METADATA_UNAVAILABLE');const metadata=JSON.parse(process.env.METADATA);return Response.json(metadata,{status:Number(process.env.HTTP_STATUS)});};`);
 const script=javascript(step(ci(),'Plan the complete fixed event obligations'));
 const execute=extra=>{
  writeFileSync(output,'');writeFileSync(trace,'');
  return executeScript(root,script,{EVENT_NAME:'push',EVENT_REF:'refs/heads/main',SOURCE_SHA:commit,WINDOWS_ARM64:'true',GITHUB_OUTPUT:output,FETCH_TRACE:trace,RESPONSE_MODE:'ready',HTTP_STATUS:'200',METADATA:JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.3.0'}),...extra},preload);
 };
 const enabled=execute({});assert.equal(enabled.status,0,enabled.stdout+enabled.stderr);assert.equal(readFileSync(trace,'utf8'),'fetch\n');
 const outputs=Object.fromEntries(readFileSync(output,'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 const remaining=JSON.parse(outputs.remaining),targets=JSON.parse(outputs.targets),arm=remaining.find(row=>row.target==='windows-arm64-msvc');
 assert.equal(targets.length,6);assert.equal(remaining.length,5);assert.ok(arm);assert.deepEqual(arm.consumerMatrix.map(row=>row.node),['22.19.0','26.7.0']);
 assert.deepEqual(JSON.parse(outputs.plan).native.targets,targets);
 const cases=[
  ...['typo','TRUE','1',''].map(value=>({extra:{WINDOWS_ARM64:value},fetches:'',error:/CI_WINDOWS_ARM64 must be true or false/})),
  {extra:{RESPONSE_MODE:'unavailable'},error:/CONTROLLED_METADATA_UNAVAILABLE/},
  {extra:{HTTP_STATUS:'503'},error:/Pi latest metadata HTTP status 503/},
  {extra:{METADATA:JSON.stringify({name:'wrong-package',version:'1.3.0'})},error:/Unexpected Pi latest package identity/},
  ...[undefined,'^1.3.0','latest'].map(version=>({extra:{METADATA:JSON.stringify({name:'@earendil-works/pi-coding-agent',version})},error:/Expected an exact npm Pi latest version/})),
  {extra:{METADATA:JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.9.0'})},error:/Pi latest is below minimum/},
 ];
 for(const {extra,fetches='fetch\n',error}of cases){
  const result=execute(extra);assert.equal(result.error,undefined);assert.notEqual(result.status,0,JSON.stringify(extra));
  assert.match(result.stderr,error);assert.equal(readFileSync(output,'utf8'),'','failure must not publish a partial plan');assert.equal(readFileSync(trace,'utf8'),fetches);
 }
});
