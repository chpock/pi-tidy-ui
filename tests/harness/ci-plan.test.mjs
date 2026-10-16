import '../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCIPlan, validateCIResults, MINIMUM_PI, NODE_VERSIONS, CLI_SHARDS } from '../../scripts/test/ci-plan.mjs';
import { candidateTargets, enabledTargets, platforms } from '../../scripts/release/platforms.mjs';
import { readInputs } from '../../scripts/test/context.mjs';
import { resolveSelection } from '../../scripts/test/catalog.mjs';

const sha = 'a'.repeat(40);
const packageName = '@earendil-works/pi-coding-agent';
const metadataURL = 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest';
const options = { eventName:'push', ref:'refs/heads/main', sha };
const response = version => Response.json({ name:packageName, version });
const plan = (extra = {}) => buildCIPlan({ ...options, fetchLatest:async () => response('1.7.3'), ...extra });
const success = result => Object.fromEntries(Object.entries(result.requiredBranches).map(([key, required]) => [key, required ? 'success' : 'skipped']));
const productProfiles = pis => NODE_VERSIONS.flatMap(node => pis.map(pi => ({node,pi})));
const cliProfiles = profiles => profiles.flatMap(profile => Array.from({length:CLI_SHARDS}, (_, index) => ({...profile,shard:`${index + 1}/${CLI_SHARDS}`})));
const branches = ['nativeHost','nativeRemaining','nativeHostConsumers','sdk','cli','delivery','daemonRegressions','publishedConsumer','preparedPack','daemonRelease','daemonNpm'];

test('fixed main push, PR and manual events have the same complete obligations and exact source authority', async () => {
  assert.equal(MINIMUM_PI,'1.0.0');
  assert.deepEqual(NODE_VERSIONS,['22.19.0','26.7.0']);
  assert.equal(CLI_SHARDS,4);
  const baseline = await plan();
  for (const event of [
    {eventName:'push',ref:'refs/heads/main'},
    {eventName:'pull_request',ref:'refs/pull/42/merge'},
    {eventName:'workflow_dispatch',ref:'refs/heads/feature/new-tests'},
  ]) {
    const result = await plan(event);
    assert.equal(result.kind,'ordinary');
    assert.equal(result.sourceRef,sha);
    assert.equal(result.sdkSuite,'unit');
    assert.deepEqual(result.profiles,productProfiles([MINIMUM_PI,'1.7.3']));
    assert.deepEqual(result.cliProfiles,cliProfiles(result.profiles));
    assert.deepEqual(result.deliveryProfiles,productProfiles([MINIMUM_PI]));
    assert.equal(result.delivery,true);
    assert.equal(result.release,false);
    assert.deepEqual(result.requiredBranches,baseline.requiredBranches);
    assert.deepEqual(result.native,baseline.native);
    assert.equal(result.publishedConsumer,false);
    assert.equal(result.preparedPack,false);
    assert.equal(result.daemonRelease,false);
    assert.equal(result.daemonNpm,false);
    assert.deepEqual(Object.keys(result.requiredBranches),branches);
    assert.equal(validateCIResults(result,success(result)),true);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(baseline)),baseline,'plan is a complete serializable Actions output');
});

test('latest is acquired once with bounded no-redirect fetch and shared exact SDK/CLI pins', async t => {
  const before = Date.now();
  let calls = 0, deadlines = 0;
  t.mock.method(AbortSignal,'timeout',milliseconds => {
    deadlines++;
    assert.equal(milliseconds,30000);
    return new AbortController().signal;
  });
  const result = await plan({fetchLatest:async (url, settings) => {
    calls++;
    assert.equal(url,metadataURL);
    assert.equal(settings.redirect,'error');
    assert.ok(settings.signal instanceof AbortSignal);
    assert.equal(settings.signal.aborted,false);
    assert.deepEqual(Object.keys(settings).sort(),['redirect','signal']);
    return response('1.7.3');
  }});
  assert.equal(calls,1);
  assert.equal(deadlines,1);
  assert.equal(result.piSelection.minimum,MINIMUM_PI);
  assert.equal(result.piSelection.latest,'1.7.3');
  const timestamp = Date.parse(result.piSelection.resolvedAt);
  assert.ok(timestamp >= before && timestamp <= Date.now());
  assert.equal(new Date(timestamp).toISOString(),result.piSelection.resolvedAt);
  assert.deepEqual(new Set(result.cliProfiles.map(({node,pi}) => `${node}/${pi}`)),new Set(result.profiles.map(({node,pi}) => `${node}/${pi}`)));
});

test('equal minimum/latest collapses SDK profiles and every CLI shard, but nightly remains latest-only', async () => {
  for (const event of [{}, {eventName:'schedule'}]) {
    let calls = 0;
    const result = await plan({...event,fetchLatest:async () => { calls++; return response(MINIMUM_PI); }});
    assert.equal(calls,1);
    assert.deepEqual(result.profiles,productProfiles([MINIMUM_PI]));
    assert.deepEqual(result.cliProfiles,cliProfiles(result.profiles));
    assert.equal(result.piSelection.latest,MINIMUM_PI);
  }
});

test('nightly is exclusively latest SDK/profile and every physical CLI shard with a Linux producer prerequisite', async () => {
  const result = await plan({eventName:'schedule',windowsArm64:true});
  assert.equal(result.kind,'nightly');
  assert.equal(result.sdkSuite,'compatibility');
  assert.deepEqual(result.profiles,productProfiles(['1.7.3']));
  assert.deepEqual(result.cliProfiles,cliProfiles(result.profiles));
  assert.deepEqual(result.native.targets,['linux-x64-gnu']);
  assert.deepEqual(result.native.matrix,result.native.host);
  assert.deepEqual(result.native.remaining,[]);
  assert.deepEqual(result.native.hostConsumers,[]);
  assert.deepEqual(result.deliveryProfiles,[]);
  for (const key of ['delivery','release','publishedConsumer','preparedPack','daemonRelease','daemonNpm']) assert.equal(result[key],false,key);
  assert.deepEqual(result.requiredBranches,{
    nativeHost:true,nativeRemaining:false,nativeHostConsumers:false,sdk:true,cli:true,
    delivery:false,daemonRegressions:false,publishedConsumer:false,preparedPack:false,daemonRelease:false,daemonNpm:false,
  });
});

test('enabled central platforms all build once and all consumers include both Nodes, including Windows ARM64 toggle', async () => {
  for (const windowsArm64 of [false,true]) {
    for (const ref of ['refs/heads/main','refs/tags/occipital-v0.2.0','refs/tags/pi-tidy-ui-v0.3.0']) {
      const result = await plan({windowsArm64,ref});
      const targets = enabledTargets({windowsArm64});
      assert.deepEqual(result.native.targets,targets);
      assert.deepEqual(result.native.matrix.map(row => row.target),targets);
      assert.deepEqual(result.native.host.map(row => row.target),['linux-x64-gnu']);
      assert.deepEqual(result.native.remaining.map(row => row.target),targets.filter(target => target !== 'linux-x64-gnu'));
      const consumers = [...result.native.hostConsumers,...result.native.remaining.flatMap(row => row.consumerMatrix)];
      assert.deepEqual(consumers.map(row => `${row.target}/${row.node}`).sort(),targets.flatMap(target => NODE_VERSIONS.map(node => `${target}/${node}`)).sort());
      for (const row of result.native.matrix) {
        assert.ok(Object.hasOwn(candidateTargets,row.target));
        const platform = platforms.find(platform => platform.target === row.target);
        assert.deepEqual(row,{target:platform.target,runner:platform.runner,rust:platform.rust,executable:platform.executable});
      }
      assert.equal(targets.includes('windows-arm64-msvc'),windowsArm64);
    }
  }
});

test('actual Occipital push tags require native/delivery and daemon gates without UI/latest acquisition', async () => {
  const result = await plan({ref:'refs/tags/occipital-v0.2.0',fetchLatest:() => assert.fail('native-only release must not fetch Pi')});
  assert.equal(result.kind,'occipital-release');
  assert.equal(result.sdkSuite,null);
  assert.deepEqual(result.profiles,[]);
  assert.deepEqual(result.cliProfiles,[]);
  assert.deepEqual(result.piSelection,{minimum:MINIMUM_PI,latest:null,resolvedAt:null});
  assert.deepEqual(result.deliveryProfiles,productProfiles([MINIMUM_PI]));
  for (const key of ['delivery','release','daemonRelease','daemonNpm']) assert.equal(result[key],true,key);
  for (const key of ['publishedConsumer','preparedPack']) assert.equal(result[key],false,key);
  assert.deepEqual(result.requiredBranches,{
    nativeHost:true,nativeRemaining:true,nativeHostConsumers:true,sdk:false,cli:false,
    delivery:true,daemonRegressions:true,publishedConsumer:false,preparedPack:false,daemonRelease:true,daemonNpm:true,
  });
});

test('actual extension push tags add public delivery and required inert pack, never daemon publication', async () => {
  const result = await plan({ref:'refs/tags/pi-tidy-ui-v0.3.0'});
  assert.equal(result.kind,'extension-release');
  assert.equal(result.release,true);
  assert.equal(result.sdkSuite,'unit');
  assert.deepEqual(result.profiles,productProfiles([MINIMUM_PI,'1.7.3']));
  assert.deepEqual(result.cliProfiles,cliProfiles(result.profiles));
  assert.equal(result.publishedConsumer,true);
  assert.equal(result.preparedPack,true);
  assert.equal(result.requiredBranches.publishedConsumer,true);
  assert.equal(result.requiredBranches.preparedPack,true);
  assert.equal(result.daemonRelease,false);
  assert.equal(result.daemonNpm,false);
  const statuses = success(result);
  statuses.preparedPack = 'skipped';
  assert.equal(validateCIResults(result,statuses),false);
});

test('manual tag refs stay ordinary and PRs cannot gain publication through ref substitution', async () => {
  for (const ref of ['refs/tags/occipital-v0.2.0','refs/tags/pi-tidy-ui-v0.3.0']) {
    const result = await plan({eventName:'workflow_dispatch',ref});
    assert.equal(result.kind,'ordinary');
    for (const key of ['release','daemonRelease','daemonNpm','publishedConsumer','preparedPack']) assert.equal(result[key],false,key);
    assert.equal(result.sdkSuite,'unit');
    await assert.rejects(plan({eventName:'pull_request',ref}),/ref/i);
    await assert.rejects(plan({eventName:'schedule',ref}),/ref/i);
  }
});

test('unknown inputs cannot narrow obligations; a later SHA cannot omit a previously failing branch', async () => {
  for (const key of ['paths','changedPaths','base','head','inputs','groups','features','rationale','approval','api','git','full','windowsOnly']) {
    await assert.rejects(plan({[key]:[]}),/Unsupported CI plan option/);
  }
  const a = await plan();
  const b = await plan({sha:'b'.repeat(40)});
  assert.equal(b.sourceRef,'b'.repeat(40));
  assert.deepEqual(a.requiredBranches,b.requiredBranches);
  assert.deepEqual(a.profiles,b.profiles);
  const statuses = success(b);
  statuses.sdk = 'failure';
  assert.equal(validateCIResults(b,statuses),false);
  delete statuses.sdk;
  assert.equal(validateCIResults(b,statuses),false,'changed-source metadata cannot waive a planned failure');
});

test('required result join rejects every missing, failed, cancelled, skipped or unknown planned result', async () => {
  for (const event of [{},{eventName:'schedule'},{ref:'refs/tags/occipital-v0.2.0'},{ref:'refs/tags/pi-tidy-ui-v0.3.0'}]) {
    const result = await plan(event);
    assert.equal(validateCIResults(result,success(result)),true);
    for (const [branch, required] of Object.entries(result.requiredBranches)) {
      for (const status of ['failure','cancelled','pending','neutral','',null,undefined,...(required ? ['skipped'] : [])]) {
        const statuses = {...success(result),[branch]:status};
        if (status === undefined) delete statuses[branch];
        assert.equal(validateCIResults(result,statuses),!required && (status === undefined || status === null),`${result.kind}/${branch}/${status}`);
      }
    }
    assert.equal(validateCIResults(result,{...success(result),typo:'success'}),false);
  }
});

test('malformed events, refs, SHAs and runtime flags fail before any metadata request', async () => {
  const bad = [
    {eventName:'pull_request_target'}, {eventName:''}, {eventName:null},
    {ref:'main'}, {ref:'refs/heads/feature'}, {ref:'refs/heads/main\n'},
    {ref:'refs/tags/unknown-v1.0.0'}, {ref:'refs/tags/occipital-v01.0.0'},
    {ref:'refs/tags/pi-tidy-ui-v1.0.0-01'}, {ref:'refs/tags/pi-tidy-ui-v1.0.0\n'},
    {eventName:'pull_request',ref:'refs/pull/0/merge'},
    {eventName:'workflow_dispatch',ref:'refs/heads/../main'},
    {eventName:'workflow_dispatch',ref:'refs/heads/a.lock'},
    {eventName:'workflow_dispatch',ref:'refs/heads/a@{b'},
    {eventName:'workflow_dispatch',ref:'refs/heads/a//b'},
    {sha:'a'.repeat(39)}, {sha:'A'.repeat(40)}, {sha:'0'.repeat(40)}, {sha:null},
    {windowsArm64:'false'}, {windowsArm64:1}, {windowsArm64:null},
    {fetchLatest:null},
  ];
  for (const extra of bad) {
    await assert.rejects(plan({...extra,fetchLatest:extra.fetchLatest === null ? null : () => assert.fail('invalid inputs fetched metadata')}));
  }
  await assert.rejects(buildCIPlan(null));
  await assert.rejects(buildCIPlan());
});

test('invalid or unavailable latest metadata fails without fallback, retry or minimum-only success', async () => {
  const versions = ['0.9.9','1.0.0-alpha','latest','^1.7.3','1.7','01.7.3','1.7.03','1.7.3-01','1.7.3+build','1.7.3\n',null,17];
  for (const version of versions) {
    let calls = 0;
    await assert.rejects(plan({fetchLatest:async () => { calls++; return response(version); }}),/Pi latest/);
    assert.equal(calls,1);
  }
  for (const fetchLatest of [
    async () => Response.json({name:'other-package',version:'1.7.3'}),
    async () => new Response('',{status:503}),
    async () => new Response('',{status:302,headers:{location:'https://example.invalid'}}),
    async () => new Response('not-json'),
    async () => { throw new Error('transport unavailable'); },
  ]) await assert.rejects(plan({fetchLatest}));
  for (const version of ['1.0.1-alpha.0','1.1.0-rc.1','2.0.0','99999999999999999999.0.0']) {
    assert.equal((await plan({fetchLatest:async () => response(version)})).piSelection.latest,version);
  }
});

test('daemon publication requires full native and Pi-graph packaging regressions on both Nodes',async()=>{
  const result=await plan({ref:'refs/tags/occipital-v0.2.0',fetchLatest:()=>{throw new Error('Daemon release must not resolve Pi latest');}});
  assert.equal(result.requiredBranches.daemonRegressions,true);
  assert.deepEqual(result.daemonRegressionProfiles,productProfiles([MINIMUM_PI]));
  const root=readInputs().pi.root,selected=resolveSelection(root,{suite:'daemon-regression'}).files;
  for(const name of ['occipital-native.test.ts','occipital-controller.native.test.ts','occipital-factories.native.test.ts','consumer-preparation.test.mjs','installed-consumer.test.mjs','local-registry.test.mjs','npm-preparation.test.ts'])assert.ok(selected.some(file=>file.endsWith('/'+name)),name+' must remain a release gate');
  assert.deepEqual(resolveSelection(root,{suite:'daemon-regression'}).requirements,['native']);
  const unit=resolveSelection(root,{suite:'unit'}).files,compatibility=resolveSelection(root,{suite:'compatibility'}).files;
  assert.ok(selected.every(file=>unit.includes(file)),'ordinary full profiles retain every native/packaging check');
  assert.ok(selected.every(file=>compatibility.includes(file)),'latest-only compatibility retains Pi-dependent packaging checks');
  for(const status of ['failure','cancelled','skipped',undefined]){
    const statuses=success(result);if(status===undefined)delete statuses.daemonRegressions;else statuses.daemonRegressions=status;
    assert.equal(validateCIResults(result,statuses),false,'daemon regression '+status+' cannot authorize publication');
  }
  assert.equal(validateCIResults(result,success(result)),true);
});
