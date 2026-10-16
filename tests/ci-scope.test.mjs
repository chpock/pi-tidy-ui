import './fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {changedPaths, githubScope, groups, nativePlan, nativeTargets, parseScope, resolveScope, reviewedScopes} from '../scripts/test/ci-scope.mjs';
import { featurePlan as cataloguePlan, testEntries } from '../scripts/test/catalog.mjs';
import {enabledTargets,platforms} from '../scripts/release/platforms.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), prior = 'c'.repeat(40);
// A small injected catalogue makes routing tests independent of SDK/file discovery.
const featurePlan = features => ({features, requirements:[
  ...(features.some(value => ['syntax','native','shared'].includes(value)) ? ['native'] : []),
  ...(features.includes('shared') ? ['shared'] : []),
  ...(features.includes('profile') ? ['integration'] : []),
]});
const scope = (paths, options = {}) => resolveScope({paths,head,ref:'refs/heads/main',featurePlan,...options});
const fence = record => '```ci-scope\n' + JSON.stringify(record) + '\n```';
const decision = (features, extra = {}) => ({head,features,rationale:'Only footer history changed; installation authority is untouched.',authority:{kind:'comment',login:'maintainer',id:42},...extra});

test('localized presentation routes do not acquire unrelated services or all platforms', () => {
  for (const [path, feature] of [['src/footer.ts','footer'],['src/editor-card.ts','editor'],['src/bash-card.ts','bash'],['src/terminal-colors.ts','terminal-colors'],['src/file-card.ts','edit']]) {
    const result = scope([path]);
    assert.equal(result.status,'ready'); assert.ok(result.features.includes(feature));
    assert.deepEqual(result.capabilities,{native:false,shared:false,integration:false,registry:false,rust:false});
    assert.equal(result.platforms,'host-only'); assert.equal(result.full,false);
  }
  assert.deepEqual(scope(['src/bash-card.ts']).profiles,[{node:'22.19.0',pi:'1.0.0'}]);
});

test('host/runtime dependence selects a symbolic latest role without resolving dependencies', () => {
  assert.deepEqual(scope(['src/editor-card.ts']).profiles,[{node:'22.19.0',pi:'1.0.0'},{node:'22.19.0',pi:'latest'}]);
  assert.deepEqual(scope(['src/git-branch.ts']).profiles,[{node:'22.19.0',pi:'1.0.0'},{node:'26.7.0',pi:'1.0.0'}]);
  assert.equal(scope(['src/syntax/work.ts']).profiles.length,4);
  const narrowed = scope(['src/index.ts'],{decisions:[decision(['footer'])]});
  assert.equal(narrowed.profiles.length,4,'review narrows contracts, not potentially affected host/runtime graphs');
  assert.deepEqual(narrowed.features,['footer']); assert.equal(narrowed.capabilities.native,false);
});

test('real helper, wire, shared, profile and delivery obligations remain distinct', () => {
  const native = scope(['src/occipital/controller.ts']);
  assert.equal(native.capabilities.native,true); assert.equal(native.capabilities.shared,false); assert.equal(native.consumers,false);
  const wire = scope(['src/occipital/protocol.ts']);
  assert.equal(wire.capabilities.native,true); assert.equal(wire.capabilities.rust,true); assert.equal(wire.capabilities.shared,true);
  assert.equal(scope(['src/occipital/discovery.ts']).capabilities.shared,true);
  assert.equal(scope(['src/syntax/paint.ts']).capabilities.shared,true);
  assert.equal(scope(['src/syntax/work.ts']).capabilities.shared,false);
  assert.equal(scope(['tests/profile.cli.test.mjs']).capabilities.integration,true);
  const delivery = scope(['scripts/release/native-ci.mjs']);
  assert.equal(delivery.platforms,'all'); assert.equal(delivery.consumers,true); assert.equal(delivery.capabilities.registry,true);
  assert.equal(delivery.capabilities.native,true);
  const rust = scope(['crates/occipital/src/engine.rs']);
  assert.equal(rust.capabilities.rust,true); assert.equal(rust.platforms,'host-only');
  assert.equal(scope(['Cargo.lock']).platforms,'all');
});

test('catalogue requirements are used rather than a duplicate capability catalogue', () => {
  const result = scope(['src/footer.ts'],{featurePlan:(features,options) => {
    assert.deepEqual(options,{baseline:false}); assert.deepEqual(features,['footer']);
    return {requirements:['shared','integration','native']};
  }});
  assert.equal(result.capabilities.shared,true); assert.equal(result.capabilities.integration,true);
});

test('unknown and broad hotspots retain unresolved conservative obligations before spending', () => {
  for (const path of ['src/index.ts','src/card-frame.ts','src/settings.ts','package-lock.json','scripts/test/context.mjs','future-production.ts']) {
    const result = scope([path]);
    assert.equal(result.status,'scope-decision-required',path); assert.ok(result.defaults.length); assert.ok(result.obligations.length);
    const stale = scope([path],{decisions:[decision(['footer'],{head:prior})]});
    assert.deepEqual(stale.features,result.features); assert.equal(stale.status,'scope-decision-required');
  }
  assert.deepEqual(scope(['future-production.ts']).unknownPaths,['future-production.ts']);
  assert.deepEqual(scope(['docs/testing.md']).features,[]);
});

test('reviewed narrowing cannot waive unambiguous obligations; explicit selections only add', () => {
  const result = scope(['src/index.ts','src/occipital/controller.ts'],{decisions:[decision(['footer'])],additions:['profile']});
  assert.equal(result.status,'ready'); assert.deepEqual(result.features,['footer','native','profile','syntax']);
  assert.equal(result.capabilities.native,true); assert.equal(result.capabilities.integration,true);
  assert.equal(result.authority.login,'maintainer'); assert.equal(result.rationale,decision([]).rationale);
  const conservative = scope(['src/index.ts'],{decisions:[decision([],{executeConservative:true})]});
  assert.equal(conservative.status,'ready'); assert.deepEqual(conservative.features,scope(['src/index.ts']).features);
  assert.throws(() => scope(['src/footer.ts'],{additions:['typo']}),/Unknown/);
});

test('full/manual and both release families cannot be narrowed', () => {
  for (const options of [{full:true},{ref:'refs/tags/pi-tidy-ui-v0.2.0'}]) {
    const result = scope([],{...options,decisions:[decision([])]});
    assert.equal(result.full,true); assert.equal(result.status,'ready'); assert.deepEqual(result.features,[...groups].sort());
    assert.equal(result.profiles.length,4); assert.equal(result.platforms,'all'); assert.equal(result.consumers,true);
    assert.ok(Object.values(result.capabilities).every(Boolean)); assert.equal(result.authority.kind,'default');
  }
  const daemon = scope([],{ref:'refs/tags/occipital-v0.1.6',decisions:[decision([])]});
  assert.equal(daemon.full,true); assert.deepEqual(daemon.features,['delivery','native']);
  assert.deepEqual(daemon.profiles,[{node:'22.19.0',pi:'1.0.0'},{node:'26.7.0',pi:'1.0.0'}]);
  assert.equal(daemon.platforms,'all'); assert.equal(daemon.consumers,true); assert.equal(daemon.publishedConsumer,false);
  assert.equal(daemon.capabilities.shared,false); assert.equal(daemon.capabilities.integration,false);
  assert.equal(daemon.releaseKind,'daemon'); assert.ok(daemon.productExclusion);
  assert.equal(scope([],{ref:'refs/tags/pi-tidy-ui-v0.2.0'}).publishedConsumer,true);
  assert.equal(scope([],{ref:'refs/heads/pi-tidy-ui-v0.2.0'}).full,false);
  assert.throws(() => scope([],{ref:'refs/tags/occipital-v0.1.6',additions:['footer']}),/fixed native\/delivery union/);
});

test('scope metadata requires exact revision, explicit groups and contract rationale', () => {
  assert.equal(parseScope('unreviewed label footer'),undefined);
  for (const record of [{head,features:['footer']},{head:'main',features:['footer'],rationale:'x'},{head,features:['wrong'],rationale:'x'},{head,features:['footer','footer'],rationale:'x'},{head,features:['footer'],rationale:'\n'},{head,features:['footer'],rationale:'x',executeConservative:'yes'}]) assert.equal(parseScope(fence(record)),undefined);
  assert.deepEqual(parseScope(fence({head,features:[],rationale:'Documentation only'})),{head,features:[],rationale:'Documentation only',executeConservative:false,compatibility:'baseline'});
});

test('PR comments/reviews are metadata-only, permission-checked, paginated and revision-bound', async () => {
  const calls = [], permissions = {maintainer:'maintain',writer:'write',outsider:'read'};
  const comment = (id,login,sha = head) => ({id,user:{login},created_at:`2026-01-${String(id).padStart(2,'0')}T00:00:00Z`,body:fence({head:sha,features:['footer'],rationale:'Footer-only history contract.'})});
  const filler = Array.from({length:99},(_,id)=>({...comment(1,'outsider'),id,body:'no scope'}));
  const api = async (route,args) => {
    calls.push([route,args]);
    if (route.endsWith('/permission')) return {data:{permission:permissions[args.username]}};
    if (route.endsWith('/comments')) return {data:args.page === 1 ? [...filler,comment(1,'outsider')] : [comment(2,'maintainer',prior)]};
    if (route.endsWith('/reviews')) return {data:[{...comment(3,'writer'),state:'APPROVED',commit_id:head},{...comment(4,'maintainer'),state:'DISMISSED'},{...comment(5,'maintainer'),state:'APPROVED',commit_id:prior}]};
    assert.fail('Unexpected API route');
  };
  const decisions = await reviewedScopes({api,owner:'owner',repo:'repo',pullNumber:7});
  assert.equal(decisions.length,2); assert.equal(decisions[0].authority.login,'writer');
  assert.equal(scope(['src/index.ts'],{decisions}).authority.login,'writer');
  assert.equal(calls.filter(([route,args])=>route.endsWith('/comments') && args.page === 2).length,1);
  assert.ok(calls.every(([route])=>route.startsWith('GET ')));
  const staleOnly = decisions.filter(value=>value.head !== head);
  assert.equal(scope(['src/index.ts'],{decisions:staleOnly}).status,'scope-decision-required');
});

test('ordinary push defaults, exact-commit manual authority and release isolation use injected API/Git', async () => {
  const payload = {before:base,repository:{owner:{login:'owner'},name:'repo'}};
  const git = args => {assert.deepEqual(args,['diff','--no-renames','--name-only','-z',base,head]);return 'src/index.ts\0';};
  const make = options => githubScope({api:async()=>assert.fail('No API required for ordinary push/full'),eventName:'push',payload,ref:'refs/heads/main',commit:head,actor:'writer',featurePlan,git,...options});
  assert.equal((await make()).status,'scope-decision-required');
  const inputs = {full:false,'scope-head':head,'base-sha':base,features:'footer',rationale:'Only history accounting; no ownership changes.'};
  const authorized = async (route,args) => {assert.ok(route.endsWith('/permission'));assert.equal(args.username,'writer');return {data:{permission:'write'}};};
  const accepted = await make({eventName:'workflow_dispatch',inputs,api:authorized});
  assert.deepEqual(accepted.features,['footer']); assert.equal(accepted.authority.kind,'dispatch');
  await assert.rejects(make({eventName:'workflow_dispatch',inputs:{...inputs,'scope-head':prior},api:authorized}),/exact tested HEAD/);
  await assert.rejects(make({eventName:'workflow_dispatch',inputs:{...inputs,'base-sha':''},api:authorized}),/exact commit SHA/);
  await assert.rejects(make({eventName:'workflow_dispatch',inputs,api:async()=>({data:{permission:'read'}})}),/maintainer authority/);
  const full = await make({eventName:'workflow_dispatch',inputs:{features:'footer'}});
  assert.equal(full.full,true); assert.equal(full.features.length,groups.length);
  const release = await make({ref:'refs/tags/pi-tidy-ui-v0.2.0',inputs:{full:false,features:'footer'}});
  assert.equal(release.full,true);
});

test('PR HEAD and merge base, not synthetic merge SHA, identify tested paths', async () => {
  const calls = [], git = args => {calls.push(args);return args[0] === 'merge-base' ? prior + '\n' : 'src/bash-card.ts\0src/footer.ts\0';};
  const result = await githubScope({api:async()=>({data:[]}),eventName:'pull_request',payload:{pull_request:{number:7,head:{sha:head},base:{sha:base}},repository:{owner:{login:'owner'},name:'repo'}},ref:'refs/pull/7/merge',commit:'d'.repeat(40),actor:'author',featurePlan,git});
  assert.equal(result.head,head); assert.deepEqual(calls,[['merge-base',base,head],['diff','--no-renames','--name-only','-z',prior,head]]);
  assert.ok(result.features.includes('bash')); assert.ok(result.features.includes('footer'));
  assert.deepEqual(changedPaths('0'.repeat(40),head,args => {assert.deepEqual(args,['ls-tree','-r','--name-only','-z',head]);return 'src/bash-card.ts\0';}),['src/bash-card.ts']);
  assert.throws(() => changedPaths('--injected',head,()=>assert.fail()),/exact commit SHA/);
});

test('native workflow selects enabled platforms; release tags cannot narrow their required results', () => {
  assert.deepEqual(nativeTargets().map(row=>row.target),enabledTargets());
  assert.deepEqual(nativeTargets('host-only').map(value=>value.target),['linux-x64-gnu']);
  for (const windowsArm64 of [false,true]) {
    const options={windowsArm64}, selected=enabledTargets(options);
    for(const ref of ['refs/tags/pi-tidy-ui-v0.2.0','refs/tags/occipital-v0.1.6']) for(const mode of ['all','host-only','windows-only']) assert.deepEqual(nativeTargets(mode,ref,options).map(row=>row.target),selected);
  }
  assert.throws(() => nativeTargets('none'),/Unknown native target/);
  assert.throws(() => nativeTargets('all','',{windowsArm64:'true'}),/boolean/);
});

test('metadata lookup failures cannot manufacture authorized scope or hide unresolved work', async () => {
  const failure = new Error('injected metadata unavailable');
  await assert.rejects(reviewedScopes({api:async()=>{throw failure;},owner:'owner',repo:'repo',pullNumber:7}),error=>error === failure);
  const decisions = await reviewedScopes({api:async()=>({data:{permission:'read'}}),owner:'owner',repo:'repo',actor:'outsider',manual:parseScope(fence({head,features:['footer'],rationale:'Claimed authority',authority:{login:'maintainer'}}))});
  assert.deepEqual(decisions,[]);
  assert.equal(scope(['src/index.ts'],{decisions}).status,'scope-decision-required');
});

test('daemon full scheduling actually selects every native/delivery node contract on both Nodes',()=>{
  const daemon=resolveScope({paths:[],head,ref:'refs/tags/occipital-v0.1.6',featurePlan:cataloguePlan});
  assert.equal(daemon.runAffected,true);assert.deepEqual(daemon.profiles,[{node:'22.19.0',pi:'1.0.0'},{node:'26.7.0',pi:'1.0.0'}]);
  const selected=cataloguePlan(daemon.features,{baseline:false});
  assert.deepEqual(selected.node,testEntries.filter(e=>['native','delivery'].includes(e.owner)&&e.layer==='node').map(e=>e.file).sort());
  assert.ok(selected.node.includes('occipital-controller.native.test.ts'));assert.ok(selected.node.includes('occipital-factories.native.test.ts'));
  assert.ok(selected.node.includes('consumer-preparation.test.mjs'));assert.deepEqual(selected.cli,[]);
  assert.equal(scope([],{full:true}).runAffected,false,'full extension acceptance has its own unit/CLI jobs');
  assert.equal(scope(['src/bash-card.ts']).runAffected,false,'ordinary presentation runs in the baseline job, not a duplicate setup');assert.equal(scope(['docs/testing.md']).runAffected,false);
});

test('ordinary presentation uses one setup; service prerequisites and extra profiles retain their jobs',()=>{
  const bash=scope(['src/bash-card.ts']);assert.deepEqual(bash.baselineFeatures,['bash']);assert.deepEqual(bash.affectedProfiles,[]);assert.equal(bash.runAffected,false);
  const footer=scope(['src/footer.ts']);assert.deepEqual(footer.baselineFeatures,['footer']);assert.deepEqual(footer.affectedProfiles,[]);
  assert.equal(footer.runAffected,false,'formatting/session aggregation does not change native editor eligibility in index.ts');
  const compatibility=scope(['src/footer.ts','src/native-api.ts']);
  assert.equal(compatibility.status,'scope-decision-required');assert.deepEqual(compatibility.baselineFeatures,[]);
  const reviewed=scope(['src/index.ts'],{decisions:[decision(['footer'])]});
  assert.deepEqual(reviewed.baselineFeatures,['footer']);assert.equal(reviewed.affectedProfiles.length,3);assert.equal(reviewed.runAffected,true);
  assert.ok(!reviewed.affectedProfiles.some(p=>p.node==='22.19.0'&&p.pi==='1.0.0'));
  const native=scope(['src/occipital/controller.ts']);assert.deepEqual(native.baselineFeatures,[]);assert.equal(native.runAffected,true);
  assert.deepEqual(native.affectedProfiles,native.profiles);
});

test('known regression files route by their real catalogue owner, not expensive filename prefixes',()=>{
  assert.deepEqual(scope(['tests/argument-previews.cli.test.mjs']).features,['edit','summaries']);
  assert.deepEqual(scope(['tests/occipital-controller.test.ts']).features,['syntax']);
  assert.deepEqual(scope(['tests/occipital-controller.native.test.ts']).features,['native']);
  assert.deepEqual(scope(['tests/integration-profile.compat.test.mjs']).features,['profile']);
  assert.deepEqual(scope(['tests/logging-fallback.cli.test.mjs']).features,['logging']);
  assert.equal(scope(['tests/logging-fallback.cli.test.mjs']).capabilities.native,false);
});

test('reviewed compatibility only adds affected profiles and cannot waive conservative expansion',()=>{
  for(const [compatibility,length]of[['baseline',1],['pi',2],['node',2],['all',4]]) {
    const result=scope(['src/footer.ts'],{decisions:[decision(['footer'],{compatibility})]});
    assert.equal(result.profiles.length,length);assert.deepEqual(result.features,['footer']);assert.equal(result.requestedCompatibility,compatibility);
    assert.equal(result.affectedProfiles.length,length-1);
  }
  const hooks=scope(['src/editor-card.ts'],{decisions:[decision(['editor','activity'],{compatibility:'baseline'})]});
  assert.equal(hooks.profiles.length,2,'baseline request cannot waive known changed Pi hooks');
  assert.equal(parseScope(fence({...decision(['footer']),compatibility:'only-node18'})),undefined);
  const stale=scope(['src/footer.ts'],{decisions:[decision(['footer'],{head:prior,compatibility:'all'})]});assert.equal(stale.profiles.length,1);
});

test('conservative catalogue evolution selects new HEAD owners through fixed unions, not the base namespace', async t => {
  const {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
  const {join,dirname}=await import('node:path'),{tmpdir}=await import('node:os');
  const original=readFileSync(new URL('../scripts/test/catalog.mjs',import.meta.url),'utf8');
  const evolved=original.replace('export const featureNames = Object.freeze([',"export const featureNames = Object.freeze(['evolved-feature',")
    .replace('export const testEntries = Object.freeze(entries);',"add('evolved-feature','evolved-feature.cli.test.mjs',{layer:'cli',requirements:['integration'],suites:['terminal']});\nexport const testEntries = Object.freeze(entries);");
  assert.notEqual(evolved,original);
  const current=await import('data:text/javascript;base64,'+Buffer.from(evolved).toString('base64'));
  assert.ok(current.featureNames.includes('evolved-feature'));assert.ok(!groups.includes('evolved-feature'));
  const root=mkdtempSync(join(tmpdir(),'scope-catalogue-evolution-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const entry of current.testEntries){const file=join(root,'tests',entry.file);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'// Selection fixture, not an executed test\n');}
  const paths=['scripts/test/catalog.mjs','tests/evolved-feature.cli.test.mjs'];
  const unresolved=scope(paths,{ref:'refs/pull/7/merge'});
  assert.equal(unresolved.status,'scope-decision-required');assert.equal(unresolved.full,false);
  const approved=scope(paths,{ref:'refs/pull/7/merge',decisions:[decision([],{executeConservative:true,rationale:'Accept the complete current-source union after adding a new owner.'})]});
  assert.equal(approved.status,'ready');assert.equal(approved.head,head);
  const selected=approved.full?current.resolveSelection(root,{suite:'terminal'}).files:current.featurePlan(approved.features,{baseline:false}).cli;
  assert.ok(selected.includes('evolved-feature.cli.test.mjs'),'conservative approval must execute the new non-product integration, not just base-known owners');
  assert.equal(approved.full,true);assert.equal(approved.runAffected,false);assert.equal(approved.authority.login,'maintainer');
  assert.equal(approved.capabilities.integration,true);assert.equal(approved.publishedConsumer,false);
  const footer=scope(['src/footer.ts']);assert.equal(footer.full,false);assert.deepEqual(footer.features,['footer']);
  const stale=scope(paths,{decisions:[decision([],{executeConservative:true,head:prior})]});assert.equal(stale.status,'scope-decision-required');
});


test('explicit Windows diagnostic is maintainer- and exact-HEAD-bound without claiming feature or release acceptance', async () => {
  const payload = {repository:{owner:{login:'owner'},name:'repo'}};
  const inputs = {full:false,'windows-only':true,'scope-head':head};
  const make = options => githubScope({eventName:'workflow_dispatch',payload,ref:'refs/heads/windows-performance',commit:head,actor:'writer',inputs,featurePlan,
    git:()=>assert.fail('Windows diagnostic has no changed-feature scope'),api:async (route,args)=>{
      assert.ok(route.endsWith('/permission'));assert.equal(args.username,'writer');return {data:{permission:'write'}};
    },...options});
  const result = await make();
  assert.equal(result.selection,'windows-consumer-diagnostic'); assert.equal(result.platforms,'windows-only');
  assert.equal(result.full,false); assert.equal(result.publishedConsumer,false); assert.equal(result.release,false);
  assert.deepEqual(result.features,[]); assert.deepEqual(result.affectedProfiles,[]); assert.equal(result.runAffected,false);
  assert.deepEqual(result.profiles,[{node:'22.19.0',pi:'1.0.0'},{node:'26.7.0',pi:'1.0.0'}]);
  assert.equal(result.capabilities.native,true); assert.equal(result.consumers,true); assert.equal(result.authority.kind,'dispatch');
  assert.match(result.productExclusion,/not.*acceptance/);
  await assert.rejects(make({inputs:{...inputs,'scope-head':prior}}),/exact tested HEAD/);
  await assert.rejects(make({api:async()=>({data:{permission:'read'}})}),/maintainer authority/);
  await assert.rejects(make({inputs:{...inputs,full:true}}),/full=false/);
  for(const ref of ['refs/tags/pi-tidy-ui-v0.2.0','refs/tags/occipital-v0.1.6','refs/pull/7/merge']) await assert.rejects(make({ref}),/branch/);
  for(const extra of [{features:'footer'},{'add-features':'native'},{compatibility:'all'},{'execute-conservative':true}]) {
    await assert.rejects(make({inputs:{...inputs,...extra}}),/cannot combine/);
  }
  const push = await make({eventName:'push',payload:{...payload,before:base},git:()=>'src/bash-card.ts\0'});
  assert.notEqual(push.selection,'windows-consumer-diagnostic'); assert.deepEqual(push.features,['bash']);
});

test('manual Windows target subset cannot narrow either release family',()=>{
  assert.deepEqual(nativeTargets('windows-only','refs/heads/windows-performance').map(row=>row.target),['windows-x64-msvc']);
  assert.deepEqual(nativeTargets('windows-only','refs/heads/windows-performance',{windowsArm64:true}).map(row=>row.target),['windows-x64-msvc','windows-arm64-msvc']);
  for(const ref of ['refs/tags/pi-tidy-ui-v0.2.0','refs/tags/occipital-v0.1.6']) assert.deepEqual(nativeTargets('windows-only',ref).map(row=>row.target),enabledTargets());
  for(const ref of ['', 'refs/pull/7/merge']) assert.throws(()=>nativeTargets('windows-only',ref),/branch/);
});


test('native planner compiles once per enabled target and fans out both Nodes after each producer',()=>{
  const branch='refs/heads/main';
  for(const windowsArm64 of [false,true]) {
    const plan=nativePlan('all',branch,true,{windowsArm64});
    assert.deepEqual(plan.targets,enabledTargets({windowsArm64}));
    assert.deepEqual(plan.host.map(row=>row.target),['linux-x64-gnu']);
    assert.deepEqual([...plan.host,...plan.remaining].map(row=>row.target),plan.targets);
    const consumers=[...plan.hostConsumers,...plan.remaining.flatMap(row=>row.consumerMatrix)];
    for(const target of plan.targets) assert.deepEqual(consumers.filter(row=>row.target===target).map(row=>row.node),['22.19.0','26.7.0']);
    assert.ok(!plan.remaining.some(row=>row.target==='linux-x64-gnu'));
    assert.equal(plan.targets.includes('windows-arm64-msvc'),windowsArm64);
  }
  const disabled=platforms.find(row=>row.target==='windows-arm64-msvc');assert.equal(disabled.enabled,false);assert.equal(disabled.runner,'windows-11-arm');
  const hostOnly=nativePlan('host-only',branch,false);assert.deepEqual(hostOnly.hostConsumers,[]);assert.deepEqual(hostOnly.remaining,[]);
  const windows=nativePlan('windows-only',branch,true);assert.deepEqual(windows.host,[]);assert.deepEqual(windows.hostConsumers,[]);
  for(const ref of ['refs/tags/pi-tidy-ui-v0.2.0','refs/tags/occipital-v0.1.6']) {
    const release=nativePlan('host-only',ref,false);assert.deepEqual(release.targets,enabledTargets());
    assert.equal(release.hostConsumers.length,2);assert.ok(release.remaining.every(row=>row.consumerMatrix.length===2));
  }
  assert.throws(()=>nativePlan('all',branch,'false'),/boolean/);
});
