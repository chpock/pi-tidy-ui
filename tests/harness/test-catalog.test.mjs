import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { featurePlan, resolveSelection, testEntries, validateCatalogue } from '../../scripts/test/catalog.mjs';
import { readInputs, validateRequirements } from '../../scripts/test/context.mjs';
import { execute } from '../../scripts/test/run.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { file } of testEntries) { mkdirSync(dirname(join(root,'tests',file)), {recursive:true}); writeFileSync(join(root,'tests',file),''); }
  return root;
}
test('structural discovery accepts new cases and excludes support without registration', t => {
  const root = fixture(t); assert.equal(validateCatalogue(root), true);
  assert.equal(new Set(testEntries.map(e=>e.file)).size, testEntries.length);
  writeFileSync(join(root,'tests/product/footer/new.test.mjs'),'');
  assert.ok(resolveSelection(root,{suite:'product'}).files.includes('product/footer/new.test.mjs'));
  mkdirSync(join(root,'tests/fixtures'),{recursive:true});
  writeFileSync(join(root,'tests/fixtures/support.test.mjs'),'');
  assert.ok(!resolveSelection(root,{suite:'unit'}).files.includes('fixtures/support.test.mjs'));
  rmSync(join(root,'tests/product/footer/new.test.mjs'));
  assert.ok(!resolveSelection(root,{suite:'product'}).files.includes('product/footer/new.test.mjs'));
});
test('selected files rather than suite labels establish native shared and profile obligations', t => {
  const root = fixture(t);
  assert.deepEqual(resolveSelection(root,{suite:'native',files:'product/footer/footer.sdk.test.ts'}).requirements,[]);
  assert.deepEqual(resolveSelection(root,{suite:'unit',files:'integration/native/occipital-controller.native.test.ts'}).requirements,['native']);
  assert.deepEqual(resolveSelection(root,{suite:'terminal',files:'cli/shared/syntax-shared.cli.test.mjs'}).requirements,['native','shared']);
  assert.deepEqual(resolveSelection(root,{suite:'unit',files:'cli/profile/profile.cli.test.mjs'}).requirements,['integration']);
  const footer=featurePlan(['footer']); assert.deepEqual(footer.requirements,[]); assert.ok(footer.cli.includes('cli/footer/footer.cli.test.mjs'));
  assert.ok(footer.node.includes('product/syntax/occipital-controller.test.ts')); assert.ok(!footer.node.includes('integration/native/occipital-controller.native.test.ts'));
});
test('unknown empty and consumer selection cannot masquerade as passing feature coverage', t => {
  const root=fixture(t);
  for(const options of [{suite:'groups'}, {groups:''}, {groups:'unknown'}, {files:''}, {files:'../x.test.mjs'}, {layer:'wrong'}]) assert.throws(()=>resolveSelection(root,options));
  assert.throws(()=>resolveSelection(root,{files:'fixtures/published-occipital.mjs'}),/explicit authorized suite/);
  assert.throws(()=>featurePlan(['unknown']),/Unknown feature/);
  assert.deepEqual(featurePlan([], {baseline:false}),{features:[],node:[],cli:[],requirements:[]});
});
test('platform scope is recorded, never advertised as an executed POSIX control', t=>{
  const root=fixture(t), windows=resolveSelection(root,{suite:'unit',platform:'win32'});
  assert.ok(windows.excluded.some(e=>e.file==='product/native/syntax/posix/occipital-factories.posix.test.ts'));
  assert.ok(!windows.files.includes('product/native/syntax/posix/occipital-factories.posix.test.ts'));
  assert.throws(()=>resolveSelection(root,{files:'product/native/syntax/posix/occipital-factories.posix.test.ts',platform:'win32'}),/platform scope/);
});
test('full legacy aliases form the complete owned union without dropping controller/profile cases',t=>{
  const root=fixture(t);
  for(const platform of ['linux','win32']) {
    const plans=['unit','native-release','terminal','syntax-terminal','rust-harness','consumer','published-consumer'].map(suite=>resolveSelection(root,{suite,platform}));
    const all=new Set(plans.flatMap(plan=>[...plan.files,...plan.excluded.map(entry=>entry.file)]));
    assert.deepEqual([...all].sort(),testEntries.map(e=>e.file).sort());
    for(const excluded of plans.flatMap(plan=>plan.excluded)) assert.ok(!plans.some(plan=>plan.files.includes(excluded.file)));
  }
  const combined=featurePlan(['footer','footer']); assert.equal(new Set([...combined.node,...combined.cli]).size,combined.node.length+combined.cli.length);
});
test('required services fail closed before execution rather than becoming missing-input skips',()=>{
  for(const requirement of ['native','shared','integration','registry','rust']) assert.throws(()=>validateRequirements({},[requirement]));
  assert.deepEqual(validateRequirements({},[]),{});
});
test('actual footer SDK command runs without native shared profile registry or Cargo inputs',async t=>{
  const root=fixture(t), original=readInputs(), path=join(root,'inputs.json'), output=join(root,'report.json');
  const base={...original,native:undefined,sharedHost:undefined,integration:undefined,registry:undefined,rust:undefined}; writeFileSync(path,JSON.stringify(base));
  const result=await execute({inputs:path,suite:'groups',groups:'footer',layer:'node',output});
  assert.equal(result.status,'passed'); assert.equal(result.counts.fail,0); assert.equal(result.counts.skipped,0); assert.deepEqual(result.requirements,[]);
  assert.ok(result.selected.includes('product/footer/footer.sdk.test.ts'));
  for(const file of ['integration/native/occipital-controller.native.test.ts','cli/shared/syntax-shared.cli.test.mjs','cli/profile/profile.cli.test.mjs']) {
    await assert.rejects(execute({inputs:path,suite:'groups',files:file,output}));
    const failed=JSON.parse(readFileSync(output)); assert.equal(failed.status,'setup-failed'); assert.deepEqual(failed.counts,{}); assert.ok(failed.requirements.length>0);
  }
});

test('fixed tool/consumer entries cannot be replaced by file selection or an unknown suite',t=>{
  const root=fixture(t);
  assert.throws(()=>resolveSelection(root,{suite:'made-up',files:'product/footer/footer.sdk.test.ts'}),/Unknown test suite/);
  for(const suite of ['check','rust','rust-check','rust-allocator','consumer','published-consumer'])assert.throws(()=>resolveSelection(root,{suite,files:'product/footer/footer.sdk.test.ts'}),/fixed entry/);
  assert.deepEqual(resolveSelection(root,{suite:'rust'}).requirements,['rust']);
  assert.throws(()=>resolveSelection(root,{suite:'groups',files:'product/footer/footer.sdk.test.ts',groups:''}),/not both/);
  assert.ok(featurePlan(['edit'],{baseline:false}).cli.includes('cli/summaries/edit/argument-previews.cli.test.mjs'));
  const summary=featurePlan(['summaries','edit'],{baseline:false}).cli;
  assert.equal(summary.filter(file=>file==='cli/summaries/edit/argument-previews.cli.test.mjs').length,1,'coupled boundaries share a single physical test owner');
});
