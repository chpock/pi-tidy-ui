import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childEnv, readInputs } from '../../../scripts/test/context.mjs';
import { archiveGraph } from '../../../scripts/test/prepare.mjs';

function fixture(t) {
  const declared = readInputs(), root = mkdtempSync(join(tmpdir(), 'archive-cache-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const inputs = {...declared, preparation:root}, dependencies = join(root,'dependencies');
  const directory = join(root,'package'); mkdirSync(directory); mkdirSync(dependencies);
  writeFileSync(join(directory,'package.json'), JSON.stringify({name:'archive-fixture',version:'1.0.0'}));
  const archive = join(root,'fixture.tgz');
  execFileSync(inputs.tools.tar, ['-czf',archive,'-C',root,'package'], {env:childEnv(join(root,'environment'),{},inputs)});
  const bytes = readFileSync(archive), integrity = 'sha512-'+createHash('sha512').update(bytes).digest('base64');
  const url = 'https://registry.npmjs.org/archive-fixture/-/archive-fixture-1.0.0.tgz';
  writeFileSync(join(dependencies,'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{'node_modules/archive-fixture':{version:'1.0.0',resolved:url,integrity}}}));
  const cacache = createRequire(inputs.tools.npm)('cacache'), cache = join(root,'environment/cache/npm/_cacache');
  let requests = 0; const original = globalThis.fetch;
  globalThis.fetch = async address => {assert.equal(address,url);requests++;return new Response(bytes);};
  t.after(() => {globalThis.fetch = original;});
  return {inputs,dependencies,bytes,integrity,cacache,cache,requests:()=>requests,
    stage:()=>rmSync(join(root,'archives'),{recursive:true,force:true})};
}

test('prepared archives: a warm content cache makes no network requests and retains exact bytes/manifest', async t => {
  const f = fixture(t); await f.cacache.put(f.cache,'fixture',f.bytes);
  const work = {}, result = await archiveGraph(f.inputs,f.dependencies,false,work);
  assert.equal(f.requests(),0);
  assert.equal(work.archiveCacheHits,1); assert.equal(work.archiveCacheMisses,0); assert.equal(work.archiveRequests,0);
  assert.equal(work.archiveBytes,f.bytes.length); assert.equal(work.archiveTarCommands,2);
  for (const key of ['archiveCacheMs','archiveFetchMs','archiveTarMs']) assert.ok(Number.isFinite(work[key]) && work[key]>=0);
  assert.equal(result.packages.length,1); assert.equal(result.packages[0].integrity,f.integrity);
  assert.deepEqual(readFileSync(result.packages[0].path),f.bytes);
  assert.deepEqual(result.packages[0].manifest,{name:'archive-fixture',version:'1.0.0'});
});

test('prepared archives: a missing archive is fetched once and then reused through its exact digest', async t => {
  const f = fixture(t), cold = {}, warm = {}; const first = await archiveGraph(f.inputs,f.dependencies,false,cold);
  assert.equal(f.requests(),1); assert.equal(cold.archiveCacheMisses,1); assert.equal(cold.archiveRequests,1); f.stage();
  const second = await archiveGraph(f.inputs,f.dependencies,false,warm);
  assert.equal(warm.archiveCacheHits,1); assert.equal(warm.archiveRequests,0);
  assert.equal(f.requests(),1,'fresh staged directory must still use the warmed npm cache');
  assert.deepEqual(first.packages.map(({name,version,integrity,manifest})=>({name,version,integrity,manifest})),
    second.packages.map(({name,version,integrity,manifest})=>({name,version,integrity,manifest})));
});

test('prepared archives: corrupt cache content fails without a network recovery that masks it', async t => {
  const f = fixture(t); await f.cacache.put(f.cache,'fixture',f.bytes);
  const files = readdirSync(join(f.cache,'content-v2'),{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile());
  assert.equal(files.length,1); writeFileSync(join(files[0].parentPath,files[0].name),'corrupted');
  await assert.rejects(archiveGraph(f.inputs,f.dependencies),error=>error.code==='EINTEGRITY');
  assert.equal(f.requests(),0);
});

test('prepared archives: cache permissions/unexpected failures never become network misses', async t => {
  const f = fixture(t), original = f.cacache.get.byDigest;
  f.cacache.get.byDigest = async()=>{throw Object.assign(new Error('fixture'),{code:'EACCES'});};
  try {await assert.rejects(archiveGraph(f.inputs,f.dependencies),{code:'EACCES'});}
  finally {f.cacache.get.byDigest = original;}
  assert.equal(f.requests(),0);
});

test('prepared archives: offline misses fail and never request public data', async t => {
  const f = fixture(t); await assert.rejects(archiveGraph(f.inputs,f.dependencies,true),{code:'ENOENT'});
  assert.equal(f.requests(),0);
});

test('prepared archives: cached omitted/nonhost optional archives still join the complete lock closure', async t => {
  const f = fixture(t); await f.cacache.put(f.cache,'fixture',f.bytes);
  const file = join(f.dependencies,'package-lock.json'), lock = JSON.parse(readFileSync(file));
  lock.packages = {'node_modules/omitted': {...lock.packages['node_modules/archive-fixture'],optional:true,os:['not-this-platform']}};
  writeFileSync(file,JSON.stringify(lock));
  const result = await archiveGraph(f.inputs,f.dependencies);
  assert.equal(result.packages.length,1,'identical archive identities are deduplicated, not excluded by platform');
  assert.equal(f.requests(),0);
});

test('prepared archives: mixed cache hits and misses preserve both records and fetch only the missing digest', async t => {
  const f = fixture(t); await f.cacache.put(f.cache,'fixture',f.bytes);
  writeFileSync(join(f.inputs.preparation,'package/package.json'),JSON.stringify({name:'archive-fixture',version:'1.0.1'}));
  const path=join(f.inputs.preparation,'second.tgz');
  execFileSync(f.inputs.tools.tar,['-czf',path,'-C',f.inputs.preparation,'package'],{env:childEnv(join(f.inputs.preparation,'environment'),{},f.inputs)});
  const bytes=readFileSync(path),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64'),url='https://registry.npmjs.org/archive-fixture/-/archive-fixture-1.0.1.tgz';
  const lockPath=join(f.dependencies,'package-lock.json'),lock=JSON.parse(readFileSync(lockPath));
  lock.packages['node_modules/second']={version:'1.0.1',resolved:url,integrity};writeFileSync(lockPath,JSON.stringify(lock));
  let requests=0;globalThis.fetch=async address=>{assert.equal(address,url);requests++;return new Response(bytes);};
  const work={},result=await archiveGraph(f.inputs,f.dependencies,false,work);
  assert.deepEqual(result.packages.map(row=>row.version).sort(),['1.0.0','1.0.1']);
  assert.equal(requests,1);assert.equal(work.archiveCacheHits,1);assert.equal(work.archiveCacheMisses,1);assert.equal(work.archiveRequests,1);assert.equal(work.archiveTarCommands,4);
  f.stage();const warm={};await archiveGraph(f.inputs,f.dependencies,false,warm);
  assert.equal(requests,1);assert.equal(warm.archiveCacheHits,2);assert.equal(warm.archiveRequests,0);
});
