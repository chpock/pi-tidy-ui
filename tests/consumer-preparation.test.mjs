import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import childProcess, { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs, toolPath } from '../scripts/test/context.mjs';
import { installConsumer, prepareConsumerClosure, readConsumerArchiveManifest, rewriteConsumerLock, seedConsumerLock, verifyConsumerReplay } from './fixtures/consumer-preparation.mjs';
import { runNpmPreparation } from './fixtures/npm-preparation.ts';
import { startLocalRegistry } from './fixtures/local-registry.mjs';

const run = promisify(execFile);

test('consumer lock rewriting changes only validated fixture URL origins', () => {
  const source = 'http://127.0.0.1:1234', destination = 'http://127.0.0.1:4321';
  const lock = { lockfileVersion: 3, packages: { '': { private: true }, 'node_modules/fixture': {
    version: '1.0.0', integrity: 'unchanged', resolved: `${source}/archives/${'a'.repeat(64)}`, optional: true } } };
  const rewritten = rewriteConsumerLock(lock, source, destination);
  assert.equal(rewritten.packages['node_modules/fixture'].resolved, `${destination}/archives/${'a'.repeat(64)}`);
  rewritten.packages['node_modules/fixture'].resolved = lock.packages['node_modules/fixture'].resolved;
  assert.deepEqual(rewritten, lock);
  for (const resolved of ['https://registry.npmjs.org/fixture', `${source}/unknown`, `${source}/archives/${'a'.repeat(64)}?query=1`]) {
    assert.throws(() => rewriteConsumerLock({ packages: { 'node_modules/fixture': { resolved } } }, source, destination));
  }
  assert.throws(() => rewriteConsumerLock(lock, 'https://registry.npmjs.org', destination));
  assert.throws(() => rewriteConsumerLock(lock, source, 'http://user:secret@127.0.0.1:4321'));
});

test('consumer preparation import has no setup/network/install side effects', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(import.meta.dirname, 'fixtures/consumer-preparation.mjs')).href;
  const result = await run(inputs.node.path, ['--input-type=module', '-e', `let fetches=0;globalThis.fetch=()=>{fetches++;throw Error('unexpected network')};
    const module=await import(${JSON.stringify(module)});console.log(JSON.stringify({fetches,exported:typeof module.prepareConsumerClosure}));`], {
    env: childEnv(root, { TIDY_TEST_INPUTS: undefined }, inputs), timeout: 10000 });
  assert.deepEqual(JSON.parse(result.stdout), { fetches: 0, exported: 'function' });
});

test('offline consumer preparation requires explicit frozen consumer metadata before npm or output creation', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-offline-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparation = join(root, 'not-created');
  await assert.rejects(prepareConsumerClosure({ ...inputs, preparation, registry: { packages: [{ name: 'seed' }] } }, { offline: true }), /explicit previously frozen consumer registry/);
  await assert.rejects(access(preparation), { code: 'ENOENT' });
});


test('consumer seed uses exact prepared host lock identities and rejects missing or changed archive records', () => {
  const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-fixture', dev: true };
  const lock = { name: 'source', version: '9.0.0', lockfileVersion: 3, packages: { '': { devDependencies: { fixture: '^1.0.0' } }, 'node_modules/fixture': entry } };
  const records = [{ name: 'fixture', version: '1.0.0', integrity: entry.integrity }];
  const manifest = { name: 'consumer', version: '0.0.0', dependencies: { fixture: '1.0.0', extension: '1.0.0' } };
  const seeded = seedConsumerLock(lock, records, manifest, 'http://127.0.0.1:4321');
  assert.equal(seeded.name, manifest.name); assert.deepEqual(seeded.packages[''].dependencies, manifest.dependencies);
  const projected = seeded.packages['node_modules/fixture'];
  assert.equal(projected.version, entry.version); assert.equal(projected.integrity, entry.integrity); assert.equal(projected.dev, true);
  assert.equal(new URL(projected.resolved).origin, 'http://127.0.0.1:4321');
  assert.equal(lock.packages['node_modules/fixture'].resolved, entry.resolved); assert.equal(lock.name, 'source');
  assert.throws(() => seedConsumerLock(lock, [], manifest, 'http://127.0.0.1:4321'), /lock archive missing/);
  assert.throws(() => seedConsumerLock(lock, [{ ...records[0], integrity: 'changed' }], manifest, 'http://127.0.0.1:4321'), /integrity changed/);
});


test('consumer preparation replays both optional modes through clean ci without changing the locked graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tidy-consumer-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'package-lock.json'), lock = { lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/fixture': { version: '1.0.0' } } };
  await writeFile(path, JSON.stringify(lock));
  const requests = [], registry = 'http://127.0.0.1:4321';
  const npm = async (args, url, cwd) => { requests.push({ args, url, cwd }); };
  for (const installed of [true, false]) await verifyConsumerReplay(npm, root, installed, registry);
  assert.deepEqual(requests, [true, false].map(installed => ({
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional'])], url: registry, cwd: root,
  })));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), lock);
  const failure = new Error('required ci metadata unavailable');
  await assert.rejects(verifyConsumerReplay(async () => { throw failure; }, root, true, registry), error => error === failure);
  await assert.rejects(verifyConsumerReplay(async () => {
    await writeFile(path, JSON.stringify({ ...lock, packages: {} }));
  }, root, true, registry), /preserve the frozen graph/);
});

test('consumer preparation extracts unchanged real archives from LF and CRLF listings and rejects non-root or ambiguous manifests', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy-consumer-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "Node Runtime's bin", 'node');
  await mkdir(join(root, "Node Runtime's bin")); await copyFile(inputs.node.path, executable);
  const script = join(root, "tar wrapper's code.mjs"), wrapper = join(root, 'tar-crlf');
  await writeFile(script, `import {execFileSync} from 'node:child_process';\nconst args=process.argv.slice(2), bytes=execFileSync(${JSON.stringify(toolPath('tar'))},args);\nprocess.stdout.write(args[0]==='-tzf'?bytes.toString().replace(/\\r?\\n/g,'\\r\\n'):bytes);\n`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  for (const [name, members, valid] of [
    ['root', ['package/package.json'], true],
    ['dot-root', ['./package/package.json'], true],
    ['nested', ['package/nested/package.json'], false],
    ['ambiguous', ['first/package.json', 'second/package.json'], false],
  ]) {
    const source = join(root, name); await mkdir(source);
    const manifest = { name: 'archive-fixture', version: '1.2.3' };
    for (const member of members) {
      const directory = join(source, member, '..'); await mkdir(directory, { recursive: true });
      await writeFile(join(source, member), JSON.stringify(manifest));
    }
    const archive = join(root, name + '.tgz');
    execFileSync(toolPath('tar'), ['-czf', archive, '-C', source, ...members], { env: childEnv(join(root, 'environment'), {}, inputs) });
    const bytes = await readFile(archive);
    for (const tar of [toolPath('tar'), wrapper]) {
      const selected = { ...inputs, tools: { ...inputs.tools, tar } };
      if (valid) assert.deepEqual(readConsumerArchiveManifest(selected, join(root, 'environment'), archive), manifest);
      else assert.throws(() => readConsumerArchiveManifest(selected, join(root, 'environment'), archive), /exactly one root manifest/);
      assert.deepEqual(await readFile(archive), bytes, 'listing conversion must not rewrite archive bytes');
    }
  }
});

test('consumer npm installs from its own cwd without the Windows prefix self-install branch', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy-consumer-npm-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmPath = join(root, 'windows-layout.cjs');
  // Use the actual selected npm; only its global-directory layout models Windows on POSIX.
  await writeFile(npmPath, `const {createRequire}=require('node:module'),{join}=require('node:path');\nconst cli=${JSON.stringify(inputs.tools.npm)},load=createRequire(cli),Npm=load('../lib/npm.js');\nObject.defineProperty(Npm.prototype,'globalDir',{get(){return join(this.globalPrefix,'node_modules')}});\nprocess.argv[1]=cli;load(cli);\n`);
  let commands = 0;
  const npm = async (args, url, cwd = root) => runNpmPreparation([...args, `--registry=${url}`], {
    cwd, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath,
    env: childEnv(join(root, `command-${commands++}`), { npm_config_registry: url }, inputs),
    logsRoot: join(root, 'logs'), reportsRoot: join(root, 'reports'),
  });
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'present' : 'absent'); await mkdir(consumer);
    const manifest = { name: 'cwd-consumer', version: '0.0.0', private: true };
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest));
    await installConsumer(npm, consumer, installed, 'http://127.0.0.1:9');
    await verifyConsumerReplay(npm, consumer, installed, 'http://127.0.0.1:9');
    assert.deepEqual(JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')), manifest, 'do not install the consumer or its parent as a dependency');
    const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.packages), [''], 'only the consumer root belongs in this empty locked graph');
    assert.equal(lock.packages[''].name, manifest.name);
    await assert.rejects(access(join(root, 'package.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' });
  }
});


test('consumer acquisition preserves clean-ci graphs and peers without materializing preparation consumers', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(),'tidy-metadata-consumer-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const packages = [];
  for (const [short, extras] of [['peer', {}], ['core', {peerDependencies:{'@fixture/peer':'^1.0.0'}}],
    ['optional', {os:[process.platform],cpu:[process.arch]}]]) {
    const directory = join(root,short), manifest = {name:`@fixture/${short}`,version:'1.0.0',...extras};
    await mkdir(join(directory,'package'),{recursive:true});
    await writeFile(join(directory,'package/package.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'package/marker.txt'),short);
    const path = join(root,short+'.tgz');
    execFileSync(toolPath('tar'),['-czf',path,'-C',directory,'package'],{env:childEnv(join(root,'tar'),{},inputs)});
    const bytes = await readFile(path);
    packages.push({name:manifest.name,version:manifest.version,manifest,path,synthetic:true,
      integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});
  }
  const recording = await startLocalRegistry({packages});
  t.after(() => recording.close());
  let commands = 0;
  const observations = [];
  const npm = async (args,url,cwd) => {
    const command = commands++, wrapper = join(root,`npm-${command}.cjs`), observation = join(root,`work-${command}.json`);
    await writeFile(wrapper,`const {createRequire}=require('node:module'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const cli=${JSON.stringify(inputs.tools.npm)},load=createRequire(cli),pacote=load('pacote'),extract=pacote.extract;
let extracts=0,materializedDirectories=0;
const inside=value=>{const p=path.resolve(String(value)),base=path.join(process.cwd(),'node_modules');return p===base||p.startsWith(base+path.sep)};
pacote.extract=async function(...args){const result=await extract.apply(this,args);extracts++;return result};
const mkdir=fs.mkdir,mkdirSync=fs.mkdirSync,mkdirAsync=fsp.mkdir;
fs.mkdir=function(...args){const callback=args.pop();return mkdir.call(this,...args,function(error,...rest){if(!error&&inside(args[0]))materializedDirectories++;callback(error,...rest)})};
fs.mkdirSync=function(...args){const result=mkdirSync.apply(this,args);if(inside(args[0]))materializedDirectories++;return result};
fsp.mkdir=async function(...args){const result=await mkdirAsync.apply(this,args);if(inside(args[0]))materializedDirectories++;return result};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({extracts,materializedDirectories})));
process.argv[1]=cli;load(cli);
`);
    const result = await runNpmPreparation([...args,`--registry=${url}`],{
      cwd,nodePath:inputs.node.path,nodeVersion:inputs.node.version,npmPath:wrapper,
      env:childEnv(join(root,`command-${command}`),{npm_config_offline:'false',npm_config_registry:url,npm_config_fetch_retries:'0'},inputs),
      logsRoot:join(root,'logs'),reportsRoot:join(root,'reports'),
    });
    observations.push(JSON.parse(await readFile(observation,'utf8')));
    return result;
  };
  const manifest = {name:'metadata-consumer',version:'0.0.0',private:true,
    dependencies:{'@fixture/core':'1.0.0'},optionalDependencies:{'@fixture/optional':'1.0.0'}};
  const create = async name => {const consumer=join(root,name);await mkdir(consumer);await writeFile(join(consumer,'package.json'),JSON.stringify(manifest));return consumer;};
  for (const installed of [true,false]) {
    const original = await create(`original-${installed}`);
    await npm(['install','--ignore-scripts','--no-audit','--no-fund',...(installed?[]:['--omit=optional'])],recording.url,original);
    await verifyConsumerReplay(npm,original,installed,recording.url);
    const baseline = JSON.parse(await readFile(join(original,'package-lock.json'),'utf8'));
    assert.ok(observations.at(-1).extracts>0,'positive control observes actual package extraction');
    assert.ok(observations.at(-1).materializedDirectories>0,'positive control observes consumer file-tree creation');
    const candidate = await create(`candidate-${installed}`);
    await installConsumer(npm,candidate,installed,recording.url);
    assert.deepEqual(observations.at(-1),{extracts:0,materializedDirectories:0});
    await assert.rejects(access(join(candidate,'node_modules')),{code:'ENOENT'});
    await verifyConsumerReplay(npm,candidate,installed,recording.url,{dryRun:true});
    assert.deepEqual(observations.at(-1),{extracts:0,materializedDirectories:0});
    await assert.rejects(access(join(candidate,'node_modules')),{code:'ENOENT'});
    assert.deepEqual(JSON.parse(await readFile(join(candidate,'package-lock.json'),'utf8')),baseline,'all graph and peer fields match actual-install acquisition');
    const inconsistent = await create(`inconsistent-${installed}`), invalidLock = structuredClone(baseline);
    delete invalidLock.packages['node_modules/@fixture/core'];
    await writeFile(join(inconsistent,'package-lock.json'),JSON.stringify(invalidLock));
    await assert.rejects(verifyConsumerReplay(npm,inconsistent,installed,recording.url,{dryRun:true}),{code:1});
    await assert.rejects(access(join(inconsistent,'node_modules')),{code:'ENOENT'});
    const frozen = await startLocalRegistry({packages});
    try {
      const actual = await create(`actual-${installed}`), lock = rewriteConsumerLock(baseline,recording.url,frozen.url);
      await writeFile(join(actual,'package-lock.json'),JSON.stringify(lock));
      await verifyConsumerReplay(npm,actual,installed,frozen.url);
      assert.equal(await readFile(join(actual,'node_modules/@fixture/core/marker.txt'),'utf8'),'core');
      assert.equal(await readFile(join(actual,'node_modules/@fixture/peer/marker.txt'),'utf8'),'peer');
      if(installed) assert.equal(await readFile(join(actual,'node_modules/@fixture/optional/marker.txt'),'utf8'),'optional');
      else await assert.rejects(access(join(actual,'node_modules/@fixture/optional')),{code:'ENOENT'});
      assert.ok(observations.at(-1).extracts>0);
      frozen.assertNoRejectedRequests();
    } finally {await frozen.close();}
  }
  recording.assertNoRejectedRequests();
});


test('complete offline closure is preflight-only while default replay still installs both fresh optionality consumers', async t=>{
  const inputs=readInputs(),root=await mkdtemp(join(tmpdir(),'tidy-offline-preflight-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'inert-source'),archives=join(root,'archives'),runs=join(root,'runtime');
  for(const path of [archives,runs,join(repo,'src/occipital'),join(repo,'crates/occipital')])await mkdir(path,{recursive:true});
  for(const file of ['Cargo.lock','crates/occipital/Cargo.toml','src/occipital/release.ts','LICENSE'])await copyFile(join(inputs.pi.root,file),join(repo,file));
  await cp(join(inputs.pi.root,'packages'),join(repo,'packages'),{recursive:true});
  const peers=inputs.pi.packages.map(({name,version})=>({name,version})),dependencies=Object.fromEntries(peers.map(row=>[row.name,row.version]));
  await writeFile(join(repo,'package.json'),JSON.stringify({name:'pi-tidy-ui',version:'0.0.0',files:['src'],peerDependencies:dependencies}));
  const packages=[],documents=[],hostLock={name:'inert-host',version:'0.0.0',lockfileVersion:3,packages:{'':{name:'inert-host',version:'0.0.0',dependencies}}};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  for(const[index,record]of peers.entries()){
    const directory=join(root,'inert-package-'+index);await mkdir(join(directory,'package'),{recursive:true});
    await writeFile(join(directory,'package/package.json'),JSON.stringify(record));
    const path=join(archives,index+'.tgz');execFileSync(toolPath('tar'),['-czf',path,'-C',directory,'package'],{env:childEnv(join(root,'tar'),{},inputs)});
    const bytes=await readFile(path),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
    const sourceURL='https://registry.npmjs.org/inert/'+index+'.tgz';
    packages.push({...record,path,integrity,manifest:record,sourceURL});hostLock.packages['node_modules/'+record.name]={version:record.version,integrity,resolved:sourceURL};
    const document={name:record.name,versions:{[record.version]:{...record,dist:{integrity,tarball:sourceURL}}}},documentPath=join(archives,index+'.json');
    const documentBytes=Buffer.from(JSON.stringify(document));await writeFile(documentPath,documentBytes);documents.push({name:record.name,path:documentPath,sha256:hash(documentBytes)});
  }
  const lock=join(root,'host-lock.json');await writeFile(lock,JSON.stringify(hostLock));
  const nativePath=join(root,'inert-version-only'),nativeBytes=Buffer.from('This unit fixture cannot classify source or replace real helper acceptance.');await writeFile(nativePath,nativeBytes);
  const target=process.platform==='linux'?'linux-'+process.arch+'-gnu':process.platform==='darwin'?'darwin-'+process.arch:'windows-'+process.arch+'-msvc';
  const base={...inputs,preparation:join(root,'online'),runRoot:runs,pi:{...inputs.pi,root:repo,lock,lockSha256:hash(await readFile(lock)),packages:peers},
    native:{path:nativePath,bytes:nativeBytes.length,sha256:hash(nativeBytes),version:'0.1.5',target,commit:inputs.source.commit,nativeTree:inputs.source.nativeTree},registry:{packages,documents}};
  const originalExec=childProcess.execFileSync,originalRm=fs.promises.rm,materialized=[];
  childProcess.execFileSync=function(command,args,...rest){
    if(command!==nativePath)return originalExec.call(this,command,args,...rest);
    assert.deepEqual(args,['--version'],'the inert native fixture must never execute real helper work');assert.equal(rest[0].encoding,'utf8');return 'occipital 0.1.5\n';
  };
  fs.promises.rm=async function(path,...rest){
    if(String(path).startsWith(join(runs,'tidy-consumer-preparation-')))materialized.push(['present','absent'].filter(name=>fs.existsSync(join(path,name,'node_modules'))).length);
    return originalRm.call(this,path,...rest);
  };
  syncBuiltinESMExports();
  let registry;
  try{
    const frozen=await prepareConsumerClosure(base);
    const immutable=await Promise.all(frozen.consumer.locks.map(async record=>({record,lock:await readFile(record.path),manifest:await readFile(record.manifestPath)})));
    materialized.length=0;
    const offline={...base,preparation:join(root,'offline'),registry:frozen};
    assert.deepEqual(await prepareConsumerClosure(offline,{offline:true}),frozen);
    assert.deepEqual(materialized,[0],'offline closure must not materialize either consumer tree');
    const reports=join(offline.preparation,'consumer/diagnostics'),npmReports=[];
    for(const directory of await readdir(reports)){
      const file=join(reports,directory,'npm.json');if(fs.existsSync(file))npmReports.push(JSON.parse(await readFile(file,'utf8')));
    }
    assert.equal(npmReports.length,2);assert.ok(npmReports.every(report=>report.mode==='dry-run'&&report.exitCode===0));
    assert.ok(npmReports.every(report=>report.timings.every(timing=>timing.reifyNodes.count===0)));
    for(const item of immutable){assert.deepEqual(await readFile(item.record.path),item.lock);assert.deepEqual(await readFile(item.record.manifestPath),item.manifest);}
    const attempt=async(name,patch)=>prepareConsumerClosure({...offline,...patch,preparation:join(root,name)},{offline:true});
    await assert.rejects(attempt('wrong-source',{source:{...base.source,tree:'0'.repeat(64)}}),/Frozen offline consumer closure is incomplete/);
    await assert.rejects(attempt('missing-lock',{registry:{...frozen,consumer:{...frozen.consumer,locks:frozen.consumer.locks.slice(0,1)}}}),/Frozen offline consumer closure is incomplete/);
    const nonhost=frozen.packages.find(row=>row.name.startsWith('@kchpock/occipital-')&&row.name!=='@kchpock/occipital-'+target);assert.ok(nonhost);
    await assert.rejects(attempt('missing-nonhost',{registry:{...frozen,packages:frozen.packages.filter(row=>row!==nonhost)}}),/Frozen offline consumer closure is incomplete/);
    const corrupt=join(root,'corrupt.tgz');await writeFile(corrupt,'not the admitted archive bytes');
    await assert.rejects(attempt('corrupt-archive',{registry:{...frozen,packages:frozen.packages.map((row,index)=>index?row:{...row,path:corrupt})}}),/Frozen offline consumer closure is incomplete/);
    const badLock=JSON.parse(immutable[0].lock.toString());delete badLock.packages['node_modules/'+peers[0].name];
    const badPath=join(root,'bad-lock.json');await writeFile(badPath,JSON.stringify(badLock));
    await assert.rejects(attempt('invalid-lock',{registry:{...frozen,consumer:{...frozen.consumer,locks:[{...frozen.consumer.locks[0],path:badPath,sha256:hash(await readFile(badPath))},frozen.consumer.locks[1]]}}}),/Frozen offline consumer closure is incomplete/);
    registry=await startLocalRegistry({packages:frozen.packages,documents:frozen.documents});
    let commands=0;
    for(const installed of [true,false]){
      const consumer=join(root,installed?'real-present':'real-absent');await mkdir(consumer);
      const receipt=frozen.consumer.locks.find(row=>row.installed===installed);
      await writeFile(join(consumer,'package.json'),await readFile(receipt.manifestPath));
      await writeFile(join(consumer,'package-lock.json'),JSON.stringify(rewriteConsumerLock(JSON.parse(await readFile(receipt.path,'utf8')),receipt.registryURL,registry.url)));
      const npm=(args,url,cwd)=>runNpmPreparation([...args,'--registry='+url],{cwd,nodePath:inputs.node.path,nodeVersion:inputs.node.version,npmPath:inputs.tools.npm,
        env:childEnv(join(root,'real-command-'+commands++),{npm_config_offline:'false',npm_config_registry:url},inputs),logsRoot:join(root,'real-logs'),reportsRoot:join(root,'real-reports')});
      await verifyConsumerReplay(npm,consumer,installed,registry.url);
      for(const peer of peers)assert.equal(JSON.parse(await readFile(join(consumer,'node_modules',peer.name,'package.json'),'utf8')).version,peer.version);
    }
    assert.equal(commands,2);registry.assertNoRejectedRequests();
  }finally{await registry?.close();childProcess.execFileSync=originalExec;fs.promises.rm=originalRm;syncBuiltinESMExports();}
});
