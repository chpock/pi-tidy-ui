import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { featurePlan, resolveSelection, testEntries, validateCatalogue } from '../../scripts/test/catalog.mjs';
import { childEnv, readInputs, validateRequirements } from '../../scripts/test/context.mjs';
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
  assert.deepEqual(featurePlan([], {baseline:false}),{features:[],node:[],cli:[],requirements:[],excluded:[]});
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

const suspendEntries = ['owned', 'shared'].flatMap(kind => ['fullscreen', 'regular'].map(mode => ({
  kind, mode, file: `cli/${kind === 'owned' ? 'native' : 'shared'}/syntax/linux/occipital-suspend-${kind}-${mode}.cli.test.mjs`,
})));
const suspendFiles = suspendEntries.map(entry => entry.file).sort();
const selectedSuspend = files => files.filter(file => file.includes('occipital-suspend'));

test('suspend discovery preserves all transport/mode cases and narrows service prerequisites', () => {
  const root = readInputs().pi.root;
  assert.deepEqual(selectedSuspend(testEntries.map(entry => entry.file)), suspendFiles);
  for (const { kind, file } of suspendEntries) {
    const selected = resolveSelection(root, { files: file, platform: 'linux' });
    assert.deepEqual(selected.files, [file]);
    assert.deepEqual(selected.requirements, kind === 'owned' ? ['native'] : ['native', 'shared']);
  }
  for (const [group, kind] of [['native', 'owned'], ['shared', 'shared']]) {
    const expected = suspendEntries.filter(entry => entry.kind === kind).map(entry => entry.file).sort();
    assert.deepEqual(selectedSuspend(resolveSelection(root, { groups: group, layer: 'cli', platform: 'linux' }).files), expected);
    const plan = featurePlan([group], { root, baseline: false, platform: 'linux' });
    assert.deepEqual(selectedSuspend(plan.cli), expected);
    assert.deepEqual(plan.requirements, kind === 'owned' ? ['native'] : ['native', 'shared']);
  }
  for (const options of [{ groups: 'syntax', layer: 'cli' }, { suite: 'syntax-terminal' }, { suite: 'cli' }]) {
    assert.deepEqual(selectedSuspend(resolveSelection(root, { ...options, platform: 'linux' }).files), suspendFiles);
  }
  const syntaxFeature = featurePlan(['syntax'], { root, baseline: false, platform: 'linux' });
  assert.deepEqual(selectedSuspend(syntaxFeature.cli), suspendFiles);
  assert.deepEqual(syntaxFeature.excluded, []);
  const nativeAlias = resolveSelection(root, { suite: 'native', platform: 'linux' });
  assert.equal(nativeAlias.files.some(file => file.startsWith('cli/')), false, 'native suite remains the Node/integration alias');
  const shards = [1, 2, 3, 4].flatMap(index => selectedSuspend(resolveSelection(root, { suite: 'cli', shard: `${index}/4`, platform: 'linux' }).files));
  assert.deepEqual(shards.sort(), suspendFiles, 'complete CLI shards discover each suspend entry once');
});

test('Linux-only suspend selection fails explicitly or reports automatic platform exclusion', () => {
  const root = readInputs().pi.root;
  for (const platform of ['darwin', 'win32']) {
    for (const { file } of suspendEntries) {
      for (const files of [file, file.split('/').at(-1)]) assert.throws(() => resolveSelection(root, { files, platform }), /platform scope/);
    }
    for (const options of [{ suite: 'cli' }, { suite: 'syntax-terminal' }, { groups: 'syntax', layer: 'cli' }, { groups: 'native', layer: 'cli' }, { groups: 'shared', layer: 'cli' }]) {
      const selection = resolveSelection(root, { ...options, platform });
      const expected = options.groups === 'native' ? suspendEntries.filter(entry => entry.kind === 'owned').map(entry => entry.file).sort()
        : options.groups === 'shared' ? suspendEntries.filter(entry => entry.kind === 'shared').map(entry => entry.file).sort() : suspendFiles;
      assert.deepEqual(selectedSuspend(selection.files), []);
      assert.deepEqual(selection.excluded.filter(entry => entry.file.includes('occipital-suspend')), expected.map(file => ({ file, reason: 'platform', supported: ['linux'] })));
    }
    for (const [group, kind] of [['syntax', undefined], ['native', 'owned'], ['shared', 'shared']]) {
      const plan = featurePlan([group], { root, baseline: false, platform });
      const expected = suspendEntries.filter(entry => kind === undefined || entry.kind === kind).map(entry => entry.file).sort();
      assert.deepEqual(selectedSuspend(plan.cli), []);
      assert.deepEqual(plan.excluded.filter(entry => entry.file.includes('occipital-suspend')), expected.map(file => ({ file, reason: 'platform', supported: ['linux'] })));
    }
  }
});

test('suspend support import registers no tests and requires no native/shared preparation', t => {
  const inputs = readInputs(), root = mkdtempSync(join(tmpdir(), 'suspend-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'inputs.json');
  writeFileSync(path, JSON.stringify({ ...inputs, native: undefined, sharedHost: undefined }));
  const result = spawnSync(inputs.node.path, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../fixtures/occipital-suspend.mjs', import.meta.url).href)}); console.log('SUSPEND_IMPORTED');`],
  { cwd: inputs.pi.root, env: childEnv(root, { TIDY_TEST_INPUTS: path }), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SUSPEND_IMPORTED\n', 'support imports must not register cases, hooks or prepare physical resources');
});

test('suspend entries register exactly twelve serial semantic cases with unchanged bounds', t => {
  const inputs = readInputs(), root = mkdtempSync(join(tmpdir(), 'suspend-registration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Execute the real entry modules, replacing only physical preparation/case execution and the test registrar.
  const probe = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const supportURL = ${JSON.stringify(new URL('../fixtures/occipital-suspend.mjs', import.meta.url).href)};
    const support = await import(supportURL);
    assert.deepEqual(support.suspendOperations, ['SOURCE', 'STYLE', 'APPEND']);
    const entries = ${JSON.stringify(suspendEntries.map(entry => ({ ...entry, url: pathToFileURL(join(inputs.pi.root, 'tests', entry.file)).href })))};
    const entryURLs = new Set(entries.map(entry => entry.url));
    globalThis.suspendProbe = { operations: support.suspendOperations, suites: [], cases: [], active: 0, maxActive: 0, prepared: 0, runs: [] };
    const sources = {
      'suspend-probe:test': \`export default function test(name, options, body) {
        const state = globalThis.suspendProbe;
        state.suites.push({name, options});
        const run = body({test: async (name, options, body) => {
          state.cases.push({name, options}); await body();
        }});
        state.runs.push(run); return run;
      }\`,
      'suspend-probe:support': \`const state = globalThis.suspendProbe;
        export const suspendOperations = state.operations;
        export async function prepareSyntaxNative() { state.prepared++; return {prepared: state.prepared}; }
        export async function runSuspendCase(selection, prepared) {
          assertPrepared(prepared);
          state.active++; state.maxActive = Math.max(state.maxActive, state.active);
          state.cases.at(-1).selection = selection;
          await new Promise(resolve => setImmediate(resolve)); state.active--;
        }
        function assertPrepared(prepared) { if (prepared.prepared !== state.prepared) throw Error('case lost its file preparation'); }
      \`,
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (entryURLs.has(context.parentURL)) {
          if (specifier === 'node:test') return {url: 'suspend-probe:test', shortCircuit: true};
          if (new URL(specifier, context.parentURL).href === supportURL) return {url: 'suspend-probe:support', shortCircuit: true};
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        return sources[url] ? {format: 'module', source: sources[url], shortCircuit: true} : nextLoad(url, context);
      },
    });
    for (const entry of entries) {
      await import(entry.url);
      await Promise.all(globalThis.suspendProbe.runs);
    }
    const {suites, cases, maxActive, prepared} = globalThis.suspendProbe;
    console.log(JSON.stringify({suites, cases, maxActive, prepared}));
  `;
  const result = spawnSync(inputs.node.path, ['--expose-gc', '--input-type=module', '-e', probe],
    { cwd: inputs.pi.root, env: childEnv(root, { TIDY_TEST_CONTEXT_READY: '1' }), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.prepared, 4);
  assert.equal(observed.suites.length, 4);
  assert.equal(observed.suites.every(suite => suite.options.timeout === 180000), true);
  assert.equal(observed.maxActive, 1, 'operations within each entry must not overlap');
  assert.equal(observed.suites.some(suite => suite.options.skip || suite.options.concurrency), false);
  const expected = suspendEntries.flatMap(({ kind, mode }) => ['SOURCE', 'STYLE', 'APPEND'].map(operation => ({
    name: `Occipital pending ${operation}: ${kind}, ${mode} past deadline during Ctrl+Z`,
    options: { timeout: 45000 }, selection: { kind, mode, operation },
  })));
  assert.deepEqual(observed.cases, expected);
});
