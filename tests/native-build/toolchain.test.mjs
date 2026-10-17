import '../../scripts/test/native-guard.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,delimiter} from 'node:path';
import test from 'node:test';
import {childEnv,rustLoaderEnvironment} from '../../scripts/test/context.mjs';
import {readNativeInputs} from '../../scripts/test/prepare-native.mjs';

test('native toolchain: owned macOS SDK discovery and real LLVM stripping work without ambient overrides', t => {
  const inputs=readNativeInputs(process.env.TIDY_NATIVE_TEST_INPUTS);
  if(process.platform!=='darwin'){
    assert.deepEqual(rustLoaderEnvironment(inputs.rust.root),{});
    return;
  }
  const root=mkdtempSync(join(process.env.TIDY_NATIVE_TEST_ENVIRONMENT,'mac-toolchain-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env=childEnv(join(root,'environment'),{...rustLoaderEnvironment(inputs.rust.root),
    PATH:join(inputs.rust.root,'bin')+delimiter+inputs.tools.path,CARGO_HOME:inputs.rust.home,
    CARGO_TARGET_DIR:join(root,'target'),CARGO_NET_OFFLINE:'true',RUSTC:inputs.rust.rustc,
    RUSTUP_TOOLCHAIN:inputs.rust.root,RUSTUP_AUTO_INSTALL:'0'},inputs);
  assert.equal(env.SDKROOT,undefined);assert.equal(env.DEVELOPER_DIR,undefined);assert.equal(env.DYLD_LIBRARY_PATH,undefined);
  assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH,join(inputs.rust.root,'lib'));
  const run=(command,args)=>{
    const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:30000});
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
    return result;
  };
  assert.ok(inputs.tools.xcrun,'The native tool inventory must declare xcrun');
  assert.ok(inputs.tools.dsymutil,'The native tool inventory must declare dsymutil for debug linking');
  const sdk=run('xcrun',['--sdk','macosx','--show-sdk-path']).stdout.trim();
  assert.ok(isAbsolute(sdk)&&statSync(sdk).isDirectory(),'Declared xcrun discovers the provisioned SDK');
  const host=run(inputs.rust.rustc,['-vV']).stdout.match(/^host:\s*(\S+)$/m)?.[1];assert.ok(host);
  const objcopy=join(inputs.rust.root,'lib/rustlib',host,'bin/rust-objcopy');
  assert.ok(existsSync(objcopy));assert.ok(existsSync(join(inputs.rust.root,'lib/libLLVM.dylib')));
  run(objcopy,['--version']);
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src/main.rs'),'fn main(){println!("native-toolchain-ok");}\n');
  const unstripped=join(root,'unstripped'),stripped=join(root,'stripped');
  run(inputs.rust.rustc,['-g','src/main.rs','-o',unstripped]);copyFileSync(unstripped,stripped);
  run(objcopy,['--strip-all',stripped]);
  assert.ok(statSync(stripped).size<statSync(unstripped).size,'Actual LLVM stripping reduces the debug fixture');
  assert.equal(run(stripped,[]).stdout.trim(),'native-toolchain-ok');
  writeFileSync(join(root,'Cargo.toml'),'[package]\nname="native-toolchain-control"\nversion="0.0.0"\nedition="2021"\n[profile.release]\nstrip=true\n');
  const built=run(inputs.rust.cargo,['build','--release','--offline']);
  assert.doesNotMatch(built.stderr,/warning:.*(?:xcrun|stripping debug info)/);
  assert.equal(run(join(root,'target/release/native-toolchain-control'),[]).stdout.trim(),'native-toolchain-ok');
  console.log('macOS toolchain control: '+JSON.stringify({sdkFound:true,llvmStarted:true,strippedBytes:statSync(stripped).size,unstrippedBytes:statSync(unstripped).size,cargoStripSucceeded:true}));
});
