import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs } from '../../../scripts/test/context.mjs';

const run = promisify(execFile);

test('installed consumer rejects missing, unstamped and mismatched same-source inputs before npm/helper work', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'never-executed-native'), bytes = Buffer.from('input validation only');
  await writeFile(path, bytes);
  const source = { ...prepared.source, commit: 'a'.repeat(40), nativeTree: 'b'.repeat(64) };
  const native = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: '1.0.0',
    target: process.platform === 'linux' ? `linux-${process.arch}-gnu` : process.platform === 'darwin' ? `darwin-${process.arch}` : `windows-${process.arch}-msvc`,
    commit: source.commit, nativeTree: source.nativeTree };
  const base = { ...prepared, source, native, registry: { packages: [{ name: 'never-read-archive' }] } };
  const fixture = resolve(import.meta.dirname, "../../fixtures/installed-occipital.mjs");
  for (const [patch, expected] of [[{ native: undefined }, /same-source native/], [{ registry: undefined }, /prepared registry archives/],
    [{ native: { ...native, version: '0.0.0' } }, /version-stamped same-source helper/],
    [{ native: { ...native, commit: 'c'.repeat(40) } }, /Native commit must match/],
    [{ native: { ...native, nativeTree: 'd'.repeat(64) } }, /Native tree must match/],
    [{ native: { ...native, sha256: '0'.repeat(64) } }, /AssertionError/]]) {
    const inputsPath = join(root, 'inputs.json'); await writeFile(inputsPath, JSON.stringify({ ...base, ...patch }));
    await assert.rejects(run(prepared.node.path, [fixture], { env: childEnv(root, { TIDY_TEST_INPUTS: inputsPath }, prepared), timeout: 10000 }), error => {
      assert.match(error.stderr, expected);
      assert.equal(error.stdout, '');
      return true;
    });
    assert.deepEqual(await readFile(path), bytes);
  }
});


test('published consumer rejects ordinary/native refs before any public lookup', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-published-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = pathToFileURL(resolve(import.meta.dirname, "../../fixtures/published-occipital.mjs")).href;
  for (const ref of [undefined, 'refs/tags/occipital-v0.1.5']) {
    const code = `let fetches=0;globalThis.fetch=()=>{fetches++;throw Error('network must not run')};
      const error=await import(${JSON.stringify(fixture)}).then(()=>undefined,error=>error);
      console.log(JSON.stringify({message:error?.message,fetches}));`;
    const result = await run(prepared.node.path, ['--input-type=module', '-e', code], {
      env: childEnv(root, { TIDY_TEST_RELEASE_REF: ref }, prepared), timeout: 10000 });
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.fetches, 0);
    assert.match(packet.message, ref ? /restricted to pi-tidy-ui releases/ : /explicit pi-tidy-ui release authorization/);
  }
});


test('consumer test files require bootstrap even when an explicit descriptor is supplied', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-test-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['consumer-preparation', 'local-registry', 'installed-consumer']) {
    await assert.rejects(run(prepared.node.path, [join(import.meta.dirname, `${name}.test.mjs`)], {
      env: childEnv(root, { TIDY_TEST_CONTEXT_READY: undefined, TIDY_TEST_INPUTS: process.env.TIDY_TEST_INPUTS }, prepared), timeout: 10000,
    }), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      assert.match(error.stderr, /Tests require a fresh isolated process/); return true;
    });
  }
});


test('opted-in ARM64 published fixture preserves its artifact and native dependency before npm work', async t=>{
  const inputs=readInputs(),root=await mkdtemp(join(tmpdir(),'tidy-published-arm-policy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo');await mkdir(join(repo,'src/occipital'),{recursive:true});
  await writeFile(join(repo,'package.json'),JSON.stringify({name:'pi-tidy-ui',version:'0.0.0',files:['src']}));
  await writeFile(join(repo,'src/occipital/release.ts'),'export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = undefined;\n');
  const git=async args=>(await run(inputs.tools.git,['-C',repo,...args],{env:childEnv(join(root,'git'),{},inputs)})).stdout.trim();
  await git(['init']);await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','inert published admission fixture']);
  const commit=await git(['rev-parse','HEAD']);await git(['tag','occipital-v0.1.5']);await git(['tag','pi-tidy-ui-v0.2.0']);
  const descriptor=join(root,'inputs.json');await writeFile(descriptor,JSON.stringify({...inputs,source:{...inputs.source,root:repo,commit}}));
  const fixture=pathToFileURL(join(import.meta.dirname, "../../fixtures/published-occipital.mjs")).href;
  const platforms=pathToFileURL(join(import.meta.dirname, "../../../scripts/release/platforms.mjs")).href;
  const code=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {readFileSync} from 'node:fs';import {join} from 'node:path';import 'node:os';
    const {candidateTargets}=await import(${JSON.stringify(platforms)}),version='0.1.5';
    const declaration={version,artifacts:Object.keys(candidateTargets).map(target=>({target,sha256:'a'.repeat(64),maxBytes:16,
      url:'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v'+version+'/occipital-v'+version+'-'+target+(candidateTargets[target].os==='win32'?'.exe':'')}))};
    Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'arm64'});
    let fetches=0,packs=0,manifest,staged;
    globalThis.fetch=async url=>{if(String(url)!=='https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.5/native-release.json')throw Error('Unexpected lookup');fetches++;return {ok:true,json:async()=>declaration};};
    const original=cp.execFile;
    cp.execFile=function(command,args,...rest){
      if(command!==${JSON.stringify(inputs.node.path)})return original.call(this,command,args,...rest);
      if(args[0]!==${JSON.stringify(inputs.tools.npm)}||args[1]!=='pack')throw Error('Unexpected Node/npm work');
      packs++;manifest=JSON.parse(readFileSync(join(args[2],'package.json'),'utf8'));staged=readFileSync(join(args[2],'src/occipital/release.ts'),'utf8');
      throw Error('Intentional admission-only stop before npm execution');
    };cp.execFile[Symbol.for('nodejs.util.promisify.custom')]=(...args)=>new Promise((resolve,reject)=>cp.execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));syncBuiltinESMExports();
    const error=await import(${JSON.stringify(fixture)}).then(()=>undefined,error=>error);
    console.log('POLICY_RESULT '+JSON.stringify({fetches,packs,manifest,staged,error:error?.message}));`;
  const result=await run(inputs.node.path,['--input-type=module','-e',code],{env:childEnv(join(root,'child'),{TIDY_TEST_INPUTS:descriptor,TIDY_TEST_RELEASE_REF:'refs/tags/pi-tidy-ui-v0.2.0'},inputs),timeout:15000});
  const packet=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('POLICY_RESULT ')).slice(14));
  assert.equal(packet.fetches,1,JSON.stringify(packet));assert.equal(packet.packs,1,'the actual published fixture must retain ARM64 through staging, not fail before the first pack');
  assert.equal(packet.manifest.optionalDependencies['@kchpock/occipital-windows-arm64-msvc'],'0.1.5');
  assert.match(packet.staged,/"target": "windows-arm64-msvc"/);assert.match(packet.error,/Intentional admission-only stop/);
});
