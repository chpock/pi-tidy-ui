import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {childEnv} from './context.mjs';
import {materializeSource} from './prepare.mjs';
import {readNativeInputs} from './prepare-native.mjs';
import {isolatedCommand} from './run.mjs';

export function checkCargoAncestry(inputs) {
  assert.ok(inputs.rust,'Cargo ancestry requires an explicitly prepared pinned Cargo/rustc');
  const project=inputs.kind==='native-build'?inputs.project:inputs.pi.root;
  assert.equal(realpathSync(project).startsWith(realpathSync(inputs.source.root)+sep),false);
  assert.equal(realpathSync(project).startsWith(realpathSync(inputs.runRoot)+sep),true);
  const root=mkdtempSync(join(tmpdir(),'cargo-ancestor-'));
  try {
    const ancestor=join(root,'polluted'),checkout=join(ancestor,'checkout'),neutral=join(root,'neutral');
    for(const path of [join(ancestor,'.cargo'),join(checkout,'src'),join(root,'cargo-home')])mkdirSync(path,{recursive:true});
    const counter=join(root,'wrapper-calls'),wrapper=join(root,process.platform==='win32'?'wrapper.cmd':'wrapper.sh');
    writeFileSync(wrapper,process.platform==='win32'?'@echo off\r\necho hit>>"%TIDY_RUST_WRAPPER_COUNTER%"\r\nexit /b 73\r\n':'#!/bin/sh\nprintf hit >> "$TIDY_RUST_WRAPPER_COUNTER"\nexit 73\n',{mode:0o700});
    writeFileSync(join(ancestor,'.cargo/config.toml'),`[build]\nrustc-wrapper = ${JSON.stringify(wrapper)}\n`);
    writeFileSync(join(checkout,'Cargo.toml'),'[package]\nname = "harness-probe"\nversion = "0.0.0"\nedition = "2024"\n');
    writeFileSync(join(checkout,'Cargo.lock'),'version = 4\n[[package]]\nname = "harness-probe"\nversion = "0.0.0"\n');
    writeFileSync(join(checkout,'src/lib.rs'),'pub fn probe() -> u32 { 42 }\n');
    const env=childEnv(join(root,'environment'),{...inputs.rust.environment,CARGO_HOME:join(root,'cargo-home'),
      CARGO_TARGET_DIR:join(root,'target'),CARGO_NET_OFFLINE:'true',RUSTC:inputs.rust.rustc,RUSTUP_AUTO_INSTALL:'0',
      PATH:dirname(inputs.rust.rustc)+delimiter+(inputs.rust.environment?.PATH??inputs.tools.bin),TIDY_RUST_WRAPPER_COUNTER:counter},inputs);
    const check=cwd=>spawnSync(inputs.rust.cargo,['check','--locked','--offline'],{cwd,env,encoding:'utf8',timeout:30000});
    const poisoned=check(checkout);
    assert.notEqual(poisoned.status,0,'positive control must observe ancestor Cargo configuration');
    assert.ok(readFileSync(counter).length>0,'positive control executed the actual configured wrapper');
    writeFileSync(counter,'');
    materializeSource(checkout,neutral,['Cargo.toml','Cargo.lock','src/lib.rs']);
    const isolated=check(neutral);
    assert.equal(isolated.status,0,isolated.stderr);
    assert.equal(readFileSync(counter).length,0,'owned neutral materialization executes the ambient wrapper zero times');
    return {poisonedWrapperObserved:true,neutralWrapperCalls:0};
  }finally{rmSync(root,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{inputs:{type:'string'},'network-isolated':{type:'boolean'}}});
  const inputs=readNativeInputs(values.inputs);
  if(values['network-isolated']){
    const command=isolatedCommand(inputs.node.path,[import.meta.filename,'--inputs',values.inputs],inputs);
    const result=spawnSync(command.command,command.args,{env:childEnv(join(inputs.runRoot,'cargo-ancestry-launch'),{},inputs),stdio:'inherit'});
    if(result.error)throw result.error;process.exitCode=result.status??1;
  }else console.log(JSON.stringify({check:'cargo-ancestry',...checkCargoAncestry(inputs)}));
}
