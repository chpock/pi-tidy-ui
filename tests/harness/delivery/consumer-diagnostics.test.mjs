import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {printConsumerDiagnostics,projectConsumerDiagnostics} from '../../../scripts/test/consumer-diagnostics.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'consumer-summary-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const save=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
  return {root,save};
}

test('consumer summaries log fixed numeric and enum fields without commands, paths, URLs or opaque error text',()=>{
  const value={node:'v22.19.0',operation:'install',mode:'dry-run',elapsedMs:123,exitCode:1,errno:'ENOENT',killed:false,temporaryDrive:'D',command:'SECRET',error:'SECRET',environment:{token:'SECRET'},stdout:'SECRET',debugLogs:[{event:'http',url:'SECRET'}],
    phases:{hostInstall:25,unknown:'SECRET',dependencyCopy:-1},timings:[{phases:{'reify:unpack':7,unknown:'SECRET'},reifyNodes:{count:2,totalMs:10,maxMs:7,secret:'SECRET'}}]};
  const result=projectConsumerDiagnostics(value,'npm');
  assert.equal(result.mode,'dry-run');assert.equal(result.elapsedMs,123);assert.equal(result.errno,'ENOENT');
  assert.deepEqual(result.phases,{hostInstall:25});assert.deepEqual(result.timings,[{phases:{'reify:unpack':7},reifyNodes:{count:2,totalMs:10,maxMs:7}}]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('debugLogs'));
  assert.deepEqual(projectConsumerDiagnostics({node:'SECRET',operation:'SECRET',mode:'SECRET',signal:'SECRET',errno:'SECRET',temporaryDrive:'SECRET',elapsedMs:'SECRET',npmMs:-1},'fixture'),{kind:'fixture'});
  assert.throws(()=>projectConsumerDiagnostics(null,'fixture'),/Invalid/);
});

test('consumer summaries survive preparation failure before inputs and create no diagnostic copies',t=>{
  const {root,save}=fixture(t), preparation=join(root,'prepared'), lines=[];
  save(join(preparation,'consumer/diagnostics/installed-preparation-runtime/fixture.json'),{phases:{hostInstall:45},elapsedMs:50});
  printConsumerDiagnostics(preparation,line=>lines.push(line));
  assert.equal(lines.length,1);assert.match(lines[0],/"hostInstall":45/);assert.ok(!existsSync(join(preparation,'diagnostics')));
});

test('consumer summaries read actual source publisher, ignore raw files and reject relative source authority',t=>{
  const {root,save}=fixture(t), preparation=join(root,'prepared'), source=join(root,'checkout'), lines=[];
  save(join(preparation,'inputs.json'),{source:{root:source},pi:{root:join(root,'wrong-sdk-tree')}});
  save(join(source,'.test-artifacts/installed-preparation-real/npm.json'),{operation:'install',mode:'standard',elapsedMs:80});
  save(join(source,'.test-artifacts/installed-preparation-real/raw.log'),{secret:'SECRET'});
  save(join(source,'.test-artifacts/unrelated/npm.json'),{secret:'SECRET'});
  printConsumerDiagnostics(preparation,line=>lines.push(line));
  assert.equal(lines.length,1);assert.match(lines[0],/"elapsedMs":80/);assert.ok(!lines.join('').includes('SECRET'));
  assert.ok(!existsSync(join(preparation,'diagnostics')));
  save(join(preparation,'inputs.json'),{source:{root:'relative'}});
  assert.throws(()=>printConsumerDiagnostics(preparation),/absolute/);
  assert.throws(()=>printConsumerDiagnostics('relative'),/absolute/);
});

test('missing diagnostic data is explicitly unavailable rather than a successful test assertion',t=>{
  const {root}=fixture(t),lines=[];printConsumerDiagnostics(root,line=>lines.push(line));
  assert.deepEqual(lines,['Consumer summary: no completed diagnostic reports are available.']);
});

test('consumer summaries preserve archive work counters but never cache identities or raw failure details',()=>{
  const counters={archiveCacheHits:155,archiveCacheMisses:1,archiveRequests:1,archiveBytes:100,archiveTarCommands:310,archiveCacheMs:2.5,archiveFetchMs:4.2,archiveTarMs:7};
  const result=projectConsumerDiagnostics({...counters,archivePaths:['SECRET'],archiveError:'SECRET',cacheKeys:['SECRET']},'fixture');
  assert.deepEqual(result,{kind:'fixture',...counters});
  assert.deepEqual(projectConsumerDiagnostics({archiveRequests:-1,archiveCacheHits:'SECRET',archiveCacheMs:Infinity},'fixture'),{kind:'fixture'});
});
