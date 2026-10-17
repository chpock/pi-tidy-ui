import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {childEnv,readInputs,rustLoaderEnvironment} from '../../scripts/test/context.mjs';

test('Rust tool environment derives Darwin loader path from the declared toolchain, never ambient SDK or libraries', t => {
  const root=mkdtempSync(join(process.env.TIDY_TEST_ROOT,'rust-env-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const keys=['DYLD_FALLBACK_LIBRARY_PATH','DYLD_LIBRARY_PATH','LD_LIBRARY_PATH','SDKROOT','DEVELOPER_DIR'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)process.env[key]='AMBIENT_MUST_NOT_WIN';
  t.after(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
  const toolchain=join(root,'declared toolchain');
  for(const platform of ['darwin','linux','win32']){
    const env=childEnv(join(root,platform),rustLoaderEnvironment(toolchain,platform),readInputs());
    const result=spawnSync(process.execPath,['-e',`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]??null]))))`],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const observed=JSON.parse(result.stdout);
    assert.deepEqual(observed,Object.fromEntries(keys.map(key=>[key,key==='DYLD_FALLBACK_LIBRARY_PATH'&&platform==='darwin'?join(toolchain,'lib'):null])));
  }
});
