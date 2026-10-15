import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestFailure } from '../src/occipital/request-failure.ts';
import type { TransportEnd } from '../src/occipital/transport-end.ts';
import { StdioTransport } from '../src/occipital/stdio.ts';
import { SharedTransport, type SharedClient } from '../src/occipital/shared.ts';
import { ProviderBroker, PROVIDER_LIMITS, type ProviderClock, type ProviderTransport, type ProviderOptions, type SharedNegotiator } from '../src/occipital/provider.ts';

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
async function flush() { for(let i=0;i<50;i++) await Promise.resolve(); }
class Clock implements ProviderClock {
  time=0; serial=0; unrefs=0;
  timers=new Map<number,{at:number;callback:()=>void}>();
  now() { return this.time; }
  setTimeout(callback:()=>void,ms:number) { const id=++this.serial;this.timers.set(id,{at:this.time+ms,callback});return {cancel:()=>{this.timers.delete(id);},unref:()=>{this.unrefs++;}}; }
  async advance(ms:number) { const end=this.time+ms;for(;;) { const next=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;this.time=next[1].at;this.timers.delete(next[0]);next[1].callback();await flush(); }this.time=end;await flush(); }
  async sleep(ms:number) { this.time+=ms;const due=[...this.timers].filter(([,t])=>t.at<=this.time);for(const [id,t] of due){this.timers.delete(id);t.callback();}await flush(); }
}
function descriptor(ticket:unknown,instance='instance') {
  return {v:2,ticket,instance,assets:'assets',status:'ok',body:{kind:'descriptor',backend_version:'0.1.0',protocol_version:2,category_version:1,assets:'assets',capability:'syntax-highlight/v2',service:'syntax',operations:['describe','themes.refresh','highlight','stream.open','stream.append','stream.close'],modes:['one_shot','growing'],admission:['try_now','bounded_queue'],catalogue_revision:0,profiles:[{id:'pi',label:'Pi palette',fingerprint:'a'.repeat(64)}],diagnostic:null as string | null,runtime:{pid:1,routes:1,leases:0,data_bytes:0,data_jobs:0,queued:0,control_bytes:0,control_jobs:0},limits:{request_bytes:2097152,reply_bytes:2097152,control_request_bytes:4096,control_reply_bytes:32768,source_bytes:1048576,line_bytes:8192,batch_sources:8,queue_wait_ms:1000,state_pool_bytes:2097152,leases:32,leases_per_route:4,runs:131072,styles:512,idle_ms:60000,age_ms:300000,quantum_ms:2,data_per_route:2,control_per_route:1,routes:8,workers:2}}};
}
class Transport implements ProviderTransport {
  private termination = deferred<TransportEnd>();
  readonly ended = this.termination.promise;
  endReason: TransportEnd | undefined;
  end(reason: TransportEnd) { if (this.endReason === undefined) { this.endReason = reason; this.termination.resolve(reason); } }
  requests:Record<string,unknown>[]=[]; closes=0;
  reply:(request:Record<string,unknown>)=>Promise<unknown>=async r=>r.op==='describe'?descriptor(r.ticket):{answer:true};
  exit=Promise.resolve();
  request(r:Record<string,unknown>) { this.requests.push(r);return this.reply(r); }
  close() { this.closes++; this.end('closed'); return this.exit; }
}
function setup(shared:ProviderOptions['tryShared'],owned?:Transport) {
  const clock=new Clock();let acquisitions=0;
  const broker=new ProviderBroker({clock,tryShared:shared,acquireOwned:async()=>{acquisitions++;return acquisitions===1&&owned?owned:new Transport();}});
  return {broker,clock,acquisitions:()=>acquisitions};
}
async function failover(shared:Transport,owned:Transport,probe:(signal:AbortSignal)=>Promise<ProviderTransport|undefined>=async()=>undefined) {
  let calls=0;const s=setup(async signal=>++calls===1?shared:probe(signal),owned);await s.broker.start();const generation=s.broker.snapshot().generation;await s.broker.provenLoss(generation);assert.equal(s.broker.snapshot().kind,'owned');return {...s,calls:()=>calls};
}
function released(broker:ProviderBroker,clock:Clock) { const s=broker.stats();assert.equal(s.liveTimers,0);assert.equal(s.abortListeners,0);assert.equal(s.activeCandidates,0);assert.equal(s.activeProbes,0);assert.equal(clock.timers.size,0); }

test('initial compatible shared is source-free and requires zero binary acquisition',async()=>{
  const shared=new Transport(),s=setup(async()=>shared);await s.broker.start();await s.broker.start();
  assert.equal(s.acquisitions(),0);assert.equal(s.broker.snapshot().initialShared,true);assert.equal(s.broker.snapshot().description?.instance,'instance');
  assert.deepEqual(shared.requests.map(r=>r.op),['describe']);assert.deepEqual(Object.keys(shared.requests[0]!).sort(),['op','ticket','v']);assert.match(String(shared.requests[0]!.ticket),/^broker:/);
  await s.broker.dispose();assert.equal(shared.closes,1);released(s.broker,s.clock);
});
test('initial standalone has no periodic probes even after owned loss',async()=>{
  const owned=new Transport(),s=setup(async()=>undefined,owned);await s.broker.start();await s.clock.advance(1200000);assert.equal(s.broker.snapshot().initialShared,false);assert.equal(s.broker.stats().sharedAttempts,1);assert.equal(s.broker.stats().probesStarted,0);await s.broker.provenLoss(s.broker.snapshot().generation);assert.equal(s.broker.stats().sharedAttempts,1);await s.broker.dispose();released(s.broker,s.clock);
});
for(const fault of ['denied','malformed','oversized']) test(`${fault} shared candidate is optional and cleaned before owned`,async()=>{
  const bad=new Transport();bad.reply=async r=>fault==='denied'?{v:2,ticket:r.ticket,instance:'i',assets:'a',status:'error',error:{code:'future_error',execution:'not_started'}}:fault==='oversized'?{extra:'x'.repeat(32769)}:{};
  const s=setup(async()=>bad);await s.broker.start();assert.equal(bad.closes,1);assert.equal(s.acquisitions(),1);assert.equal(s.broker.snapshot().kind,'owned');assert.equal(s.broker.snapshot().reason,'ready');await s.broker.dispose();released(s.broker,s.clock);
});
test('optional factory rejection does not escape startup; owned refusal leaves unavailable',async()=>{
  const clock=new Clock(),broker=new ProviderBroker({clock,tryShared:async()=>{throw Error('SECRET');},acquireOwned:async()=>{throw Error('SECRET');}});await broker.start();assert.equal(broker.snapshot().availability,'unavailable');assert.equal(JSON.stringify(broker.snapshot()).includes('SECRET'),false);await broker.dispose();released(broker,clock);
});
test('proven shared loss performs exactly two bounded reconnects before takeover',async()=>{
  const shared=new Transport(),owned=new Transport();let count=0;const pending=deferred<ProviderTransport|undefined>();const s=setup(async()=>++count===1?shared:pending.promise,owned);await s.broker.start();const loss=s.broker.provenLoss(s.broker.snapshot().generation);await flush();await s.clock.advance(PROVIDER_LIMITS.factoryMs*2);await loss;
  assert.equal(count,3);assert.equal(s.acquisitions(),1);assert.equal(shared.closes,1);assert.equal(s.broker.stats().reconnectAttempts,2);const late=new Transport();pending.resolve(late);await flush();assert.equal(late.closes,1);await s.broker.dispose();released(s.broker,s.clock);
});
test('source timeout/unknown outcome never implies actual transport loss',async()=>{
  const shared=new Transport(),s=setup(async()=>shared);await s.broker.start();shared.reply=async()=>{throw Error('local timeout-close');};await assert.rejects(s.broker.request(s.broker.snapshot().generation,{v:2,op:'highlight',ticket:'source:1'}));assert.equal(s.acquisitions(),0);assert.equal(s.broker.stats().sharedAttempts,1);assert.equal(s.broker.snapshot().kind,'shared');await s.broker.dispose();released(s.broker,s.clock);
});
test('verified return retires generation, rejects held source and waits for owned exit',async()=>{
  const shared=new Transport(),owned=new Transport(),returned=new Transport(),exit=deferred<void>(),source=deferred<unknown>();owned.exit=exit.promise;
  let n=0;const s=await failover(shared,owned,async()=>++n<=2?undefined:returned);const old=s.broker.snapshot().generation;owned.reply=async()=>source.promise;const request=s.broker.request(old,{v:2,op:'highlight',ticket:'source:1'});const rejected=assert.rejects(request,/retired/);
  await s.clock.advance(60000);assert.equal(owned.closes,1);assert.equal(s.broker.snapshot().availability,'transitioning');await assert.rejects(s.broker.request(old,{v:2,op:'highlight',ticket:'source:2'}));assert.equal(returned.requests.length,1);
  source.resolve({old:true});await rejected;exit.resolve();await flush();assert.equal(s.broker.snapshot().kind,'shared');assert.notEqual(s.broker.snapshot().generation,old);await s.broker.request(s.broker.snapshot().generation,{v:2,op:'highlight',ticket:'source:3'});assert.equal(returned.requests.length,2);assert.equal(s.broker.stats().handoffsSucceeded,1);await s.broker.dispose();released(s.broker,s.clock);
});
test('failed readiness leaves owned serving; ten probes do not extend window',async()=>{
  const bad=new Transport();bad.reply=async()=>({});let n=0;const s=await failover(new Transport(),new Transport(),async()=>++n<=2?undefined:TransportWithBadReply());
  function TransportWithBadReply() { const t=new Transport();t.reply=bad.reply;return t; }
  for(let minute=1;minute<=10;minute++){await s.clock.advance(60000);await s.broker.request(s.broker.snapshot().generation,{v:2,op:'highlight',ticket:`s:${minute}`});assert.equal(s.broker.snapshot().kind,'owned');}
  assert.equal(s.broker.stats().probesStarted,10);assert.equal(s.broker.stats().probesCompleted,10);assert.equal(s.broker.stats().handoffsSucceeded,0);await s.clock.advance(600000);assert.equal(s.broker.stats().probesStarted,10);assert.equal(s.broker.stats().recoveryTimers,0);await s.broker.dispose();released(s.broker,s.clock);
});
test('sleep misses slots without catch-up or extending beyond minute10',async()=>{
  const s=await failover(new Transport(),new Transport());await s.clock.sleep(250000);assert.equal(s.broker.stats().probesStarted,1);await s.clock.advance(50000);assert.equal(s.broker.stats().probesStarted,2);await s.clock.sleep(400000);assert.equal(s.broker.stats().probesStarted,2);assert.equal(s.broker.stats().recoveryTimers,0);await s.broker.dispose();released(s.broker,s.clock);
});
test('one pending probe has finite deadline and cannot overlap or catch up',async()=>{
  const held=deferred<ProviderTransport|undefined>();let n=0;const s=await failover(new Transport(),new Transport(),async()=>++n<=2?undefined:held.promise);await s.clock.advance(60000);assert.equal(s.broker.stats().activeProbes,1);await s.clock.sleep(130000);assert.equal(s.broker.stats().activeProbes,0);assert.equal(s.broker.stats().probesStarted,1);await s.clock.advance(50000);assert.equal(s.broker.stats().probesStarted,2);await s.broker.dispose();const late=new Transport();held.resolve(late);await flush();assert.equal(late.closes,1);released(s.broker,s.clock);
});
test('tenth in-time probe may complete after window within deadline',async()=>{
  const held=deferred<ProviderTransport|undefined>();let n=0;const returned=new Transport();const s=await failover(new Transport(),new Transport(),async()=>++n<=11?undefined:held.promise);await s.clock.advance(600000);assert.equal(s.broker.stats().probesStarted,10);await s.clock.advance(PROVIDER_LIMITS.factoryMs-1);held.resolve(returned);await flush();assert.equal(s.broker.snapshot().kind,'shared');assert.equal(s.broker.stats().handoffsSucceeded,1);assert.equal(s.broker.stats().recoveryTimers,0);await s.broker.dispose();released(s.broker,s.clock);
});
test('late initialization after disposal closes resource, never acquires or resurrects',async()=>{
  const held=deferred<ProviderTransport|undefined>(),s=setup(async()=>held.promise);const init=s.broker.start();await flush();await s.broker.dispose();await init;const late=new Transport();held.resolve(late);await flush();assert.equal(late.closes,1);assert.equal(s.acquisitions(),0);assert.equal(s.broker.snapshot().availability,'disposed');released(s.broker,s.clock);
});
test('late control reply and probe after disposal cannot switch provider',async()=>{
  const reply=deferred<unknown>(),candidate=new Transport();candidate.reply=async()=>reply.promise;let n=0;const s=await failover(new Transport(),new Transport(),async()=>++n<=2?undefined:candidate);await s.clock.advance(60000);assert.equal(s.broker.stats().activeProbes,1);const ticket=candidate.requests[0]!.ticket;await s.broker.dispose();reply.resolve(descriptor(ticket));await flush();assert.equal(candidate.closes,1);assert.equal(s.broker.snapshot().availability,'disposed');released(s.broker,s.clock);
});
test('owned exit timeout quarantines without dispatch or acquisition; late exit never resurrects',async()=>{
  const owned=new Transport(),exit=deferred<void>();owned.exit=exit.promise;const returned=new Transport();let n=0;const s=await failover(new Transport(),owned,async()=>++n<=2?undefined:returned);await s.clock.advance(60000);await s.clock.advance(PROVIDER_LIMITS.closeMs);assert.equal(s.broker.snapshot().availability,'unavailable');assert.equal(s.broker.snapshot().reason,'unproved_exit');assert.equal(returned.closes,1);assert.equal(s.acquisitions(),1);await assert.rejects(s.broker.request(s.broker.snapshot().generation,{op:'highlight'}));exit.resolve();await flush();assert.equal(s.broker.snapshot().availability,'unavailable');await s.broker.dispose();released(s.broker,s.clock);
});
test('factory and control timeouts dispose late resources and all timers are unref',async()=>{
  const candidate=new Transport(),reply=deferred<unknown>();candidate.reply=async()=>reply.promise;const s=setup(async()=>candidate);const init=s.broker.start();await flush();await s.clock.advance(PROVIDER_LIMITS.controlMs);await init;assert.equal(candidate.closes,1);assert.equal(s.acquisitions(),1);assert.equal(s.clock.unrefs,s.clock.serial);reply.resolve(descriptor(candidate.requests[0]!.ticket));await flush();assert.equal(s.broker.snapshot().kind,'owned');await s.broker.dispose();released(s.broker,s.clock);
});
test('control namespace is reserved and provider incarnations have distinct tickets',async()=>{
  const shared=new Transport(),returned=new Transport();let n=0;const s=await failover(shared,new Transport(),async()=>++n<=2?undefined:returned);await s.clock.advance(60000);assert.notEqual(shared.requests[0]!.ticket,returned.requests[0]!.ticket);await assert.rejects(s.broker.request(s.broker.snapshot().generation,{v:2,op:'highlight',ticket:'broker:forged'}),/reserved/);await s.broker.dispose();released(s.broker,s.clock);
});

test('immediate compatible reconnect stays shared without owned takeover or periodic episode',async()=>{
  const first=new Transport(),next=new Transport();let n=0;const s=setup(async()=>++n===1?first:next);await s.broker.start();const old=s.broker.snapshot().generation;await s.broker.provenLoss(old);await s.broker.provenLoss(old);assert.equal(s.acquisitions(),0);assert.equal(s.broker.stats().reconnectAttempts,1);assert.equal(s.broker.stats().recoveryEpisodes,0);assert.equal(s.broker.snapshot().kind,'shared');await s.broker.dispose();released(s.broker,s.clock);
});
test('owned restart preserves the original window, including after expiry',async()=>{
  const s=await failover(new Transport(),new Transport());await s.clock.advance(250000);await s.broker.provenLoss(s.broker.snapshot().generation);assert.equal(s.broker.stats().recoveryEpisodes,1);await s.clock.advance(350000);assert.equal(s.broker.stats().probesStarted,10);await s.broker.provenLoss(s.broker.snapshot().generation);await s.clock.advance(600000);assert.equal(s.broker.stats().recoveryEpisodes,1);assert.equal(s.broker.stats().probesStarted,10);await s.broker.dispose();released(s.broker,s.clock);
});
test('a genuine shared loss after successful return starts a new finite episode',async()=>{
  const returned=new Transport();let n=0;const s=await failover(new Transport(),new Transport(),async()=>++n===3?returned:undefined);await s.clock.advance(60000);assert.equal(s.broker.snapshot().kind,'shared');await s.broker.provenLoss(s.broker.snapshot().generation);assert.equal(s.broker.snapshot().kind,'owned');assert.equal(s.broker.stats().recoveryEpisodes,2);await s.clock.advance(60000);assert.equal(s.broker.stats().probesStarted,2);await s.broker.dispose();released(s.broker,s.clock);
});
test('late owned acquisition after dispose closes the child and never publishes',async()=>{
  const clock=new Clock(),held=deferred<ProviderTransport>(),broker=new ProviderBroker({clock,tryShared:async()=>undefined,acquireOwned:async()=>held.promise});const init=broker.start();await flush();await broker.dispose();await init;const child=new Transport();held.resolve(child);await flush();assert.equal(child.closes,1);assert.equal(broker.snapshot().availability,'disposed');released(broker,clock);
});
test('owned close rejection quarantines without a replacement parser',async()=>{
  const owned=new Transport();owned.close=()=>{owned.closes++;return Promise.reject(Error('unknown exit'));};const returned=new Transport();let n=0;const s=await failover(new Transport(),owned,async()=>++n<=2?undefined:returned);await s.clock.advance(60000);assert.equal(s.broker.snapshot().reason,'unproved_exit');assert.equal(s.broker.stats().handoffsFailed,1);assert.equal(s.acquisitions(),1);assert.equal(returned.closes,1);await s.broker.dispose();released(s.broker,s.clock);
});
test('dispose during held owned exit closes candidate once and cannot resurrect on late exit',async()=>{
  const owned=new Transport(),held=deferred<void>();owned.exit=held.promise;const returned=new Transport();let n=0;const s=await failover(new Transport(),owned,async()=>++n<=2?undefined:returned);await s.clock.advance(60000);const shutdown=s.broker.dispose();await flush();assert.equal(returned.closes,1);held.resolve();await shutdown;await flush();assert.equal(owned.closes,1);assert.equal(s.broker.snapshot().availability,'disposed');assert.equal(s.broker.stats().handoffsSucceeded,0);released(s.broker,s.clock);
});
test('held descriptor has bounded deadline; fake future numeric metadata cannot enter status',async()=>{
  const reply=deferred<unknown>(),bad=new Transport();bad.reply=async()=>reply.promise;let n=0;const s=await failover(new Transport(),new Transport(),async()=>++n<=2?undefined:bad);await s.clock.advance(60000);assert.equal(s.broker.stats().activeCandidates,1);await s.clock.advance(PROVIDER_LIMITS.controlMs);assert.equal(bad.closes,1);assert.equal(s.broker.snapshot().kind,'owned');reply.resolve({...descriptor(bad.requests[0]!.ticket),future_number:Infinity});await flush();assert.equal(JSON.stringify(s.broker.snapshot()).includes('future_number'),false);await s.broker.dispose();released(s.broker,s.clock);
});
test('production cadence and metadata/control engineering bounds are explicit',()=>{
  assert.equal(PROVIDER_LIMITS.recoveryIntervalMs,60000);assert.equal(PROVIDER_LIMITS.recoveryWindowMs,600000);assert.equal(PROVIDER_LIMITS.metadataBytes,32768);assert.equal(PROVIDER_LIMITS.reconnectAttempts,2);
});

test('public StdioTransport fixture reap precedes returned source dispatch, with zero owned listeners after exit',async t=>{
  // Explicit isolated subprocess fixture, no real daemon/discovery/config/download.
  const program=`const description=${JSON.stringify(descriptor(''))};let bytes=Buffer.alloc(0);process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE(0)){const n=bytes.readUInt32BE(0),r=JSON.parse(bytes.subarray(4,4+n));bytes=bytes.subarray(4+n);if(r.op==='describe'){const b=Buffer.from(JSON.stringify({...description,ticket:r.ticket})),h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));}}});`;
  const owned=new StdioTransport({command:process.execPath,args:['-e',program],requestDeadlineMs:3000,terminateGraceMs:40});
  t.after(()=>owned.close());
  const first=new Transport(),returned=new Transport();let attempts=0;const clock=new Clock();
  const broker=new ProviderBroker({clock,tryShared:async()=>++attempts===1?first:attempts<=3?undefined:returned,acquireOwned:async()=>owned});t.after(()=>broker.dispose());
  await broker.start();await broker.provenLoss(broker.snapshot().generation);assert.equal(broker.snapshot().kind,'owned');const pid=owned.stats().pid;assert.equal(typeof pid,'number');
  const generation=broker.snapshot().generation;const held=assert.rejects(broker.request(generation,{v:2,op:'highlight',ticket:'source:held'}),/retired/);
  returned.reply=async r=>{if(r.op!=='describe'){assert.equal(owned.stats().childState,'exited');assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});}return r.op==='describe'?descriptor(r.ticket):{answer:true};};
  await clock.advance(60000);
  for(let i=0;i<400&&broker.snapshot().availability!=='ready';i++)await delay(5);
  assert.equal(broker.snapshot().kind,'shared');await held;await broker.request(broker.snapshot().generation,{v:2,op:'highlight',ticket:'source:new'});
  assert.equal(owned.stats().spawnCount,1);assert.equal(owned.stats().retainedBytes,0);assert.equal(owned.stats().liveTimers,0);assert.equal(owned.stats().abortListeners,0);assert.equal(owned.stats().ownedListeners,0);assert.equal(owned.stats().unsettledData,0);
  await broker.dispose();released(broker,clock);
});
test('public SharedTransport structural API accepts broker describe and closes only its dedicated connection',async()=>{
  let connectionCloses=0;const sent:Record<string,unknown>[]=[];
  const client:SharedClient={resolveProvider:async()=> 'fixture-module',routeOpen:async()=>({channel:1,epoch:1}),request:async(_handle,bytes)=>{const request=JSON.parse(Buffer.from(bytes).toString()) as Record<string,unknown>;sent.push(request);return descriptor(request.ticket);},closeRoute:async()=>{},close:()=>{connectionCloses++;}};
  const transport=new SharedTransport({connectionFile:'/explicit-test-fixture-only',identity:{project_root:'/tmp',harness:'fixture',session:'fixture'},initDeadlineMs:3000,requestDeadlineMs:3000,loadSdk:async()=>({SubcClient:{connect:async()=>client}})});
  const s=setup(async()=>transport);await s.broker.start();assert.equal(s.broker.snapshot().kind,'shared');assert.equal(s.acquisitions(),0);assert.deepEqual(sent.map(r=>r.op),['describe']);await s.broker.dispose();assert.equal(connectionCloses,1);assert.equal(transport.stats().unsettledControl,0);assert.equal(transport.stats().controlReservedBytes,0);assert.equal(transport.stats().liveTimers,0);assert.equal(transport.stats().abortListeners,0);released(s.broker,s.clock);
});

test('same-turn disposal prevents even invoking the queued factory',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return new Transport();});const init=s.broker.start();await s.broker.dispose();await init;assert.equal(calls,0);assert.equal(s.acquisitions(),0);released(s.broker,s.clock);
});
test('control metadata preflight rejects future non-finite values without retaining raw data',async()=>{
  const candidate=new Transport();candidate.reply=async r=>({...descriptor(r.ticket),future_number:Infinity});const s=setup(async()=>candidate);await s.broker.start();assert.equal(candidate.closes,1);assert.equal(s.broker.stats().candidatesRejected,1);assert.equal(s.broker.snapshot().kind,'owned');assert.equal(JSON.stringify(s.broker.snapshot()).includes('future_number'),false);await s.broker.dispose();released(s.broker,s.clock);
});

test('terminal disposed survives failed handoff cleanup resolving later',async()=>{
  const owned=new Transport(),ownedExit=deferred<void>(),returned=new Transport(),returnedExit=deferred<void>();
  owned.exit=ownedExit.promise;returned.exit=returnedExit.promise;
  let n=0;const s=await failover(new Transport(),owned,async()=>++n<=2?undefined:returned);
  await s.clock.advance(60000);
  assert.equal(owned.closes,1);
  await s.clock.advance(PROVIDER_LIMITS.closeMs);
  assert.equal(returned.closes,1);
  const disposed=s.broker.dispose();
  assert.equal(s.broker.snapshot().availability,'disposed');
  returnedExit.resolve();await disposed;await flush();
  assert.equal(s.broker.snapshot().availability,'disposed');
  assert.equal(s.broker.stats().handoffsSucceeded,0);
  assert.equal(s.acquisitions(),1);
  ownedExit.resolve();await flush();
  released(s.broker,s.clock);
});

function disposition(expected: 'not_started' | 'unknown') {
  return (error: unknown) => { assert.ok(error instanceof RequestFailure);assert.equal(error.execution,expected);return true; };
}

test('typed broker local refusal is no-start; discarded in-flight reply is not', async()=> {
  const shared=new Transport(),s=setup(async()=>shared);
  try {
    await assert.rejects(s.broker.request(s.broker.snapshot().generation,{v:2,op:'highlight',ticket:'before'}),disposition('not_started'));
    assert.equal(shared.requests.length,0);await s.broker.start();
    const generation=s.broker.snapshot().generation;
    await assert.rejects(s.broker.request(generation,{v:2,op:'highlight',ticket:'broker:reserved'}),disposition('not_started'));
    assert.equal(shared.requests.length,1);
    const held=deferred<unknown>();shared.reply=()=>held.promise;
    const ended=assert.rejects(s.broker.request(generation,{v:2,op:'highlight',ticket:'sent'}),disposition('unknown'));
    await s.broker.dispose();held.resolve({late:true});await ended;
    assert.equal(s.broker.stats().sourceDispatches,1);
  } finally { await s.broker.dispose();released(s.broker,s.clock); }
});

test('broker preserves explicit local no-start but normalizes opaque transport failure as unknown',async()=> {
  const shared=new Transport(),s=setup(async()=>shared);
  try {
    await s.broker.start();const generation=s.broker.snapshot().generation;
    shared.reply=async()=>{throw new RequestFailure('local refusal','not_started');};
    await assert.rejects(s.broker.request(generation,{v:2,op:'highlight',ticket:'local'}),disposition('not_started'));
    shared.reply=async()=>{throw Error('request capacity');};
    await assert.rejects(s.broker.request(generation,{v:2,op:'highlight',ticket:'opaque'}),disposition('unknown'));
    shared.request=()=>{throw Error('synchronous request capacity');};
    await assert.rejects(s.broker.request(generation,{v:2,op:'highlight',ticket:'sync'}),disposition('unknown'));
    assert.equal(s.broker.stats().sharedAttempts,1);assert.equal(s.acquisitions(),0);
  } finally {await s.broker.dispose();released(s.broker,s.clock);}
});

test('availability observer reports accepted metadata, no acquisition on shared and zero notifications on warm snapshots', async () => {
  const clock = new Clock(), shared = new Transport(); let acquisitions = 0;
  const seen: string[] = [];
  const broker = new ProviderBroker({ clock, tryShared: async () => shared, acquireOwned: async () => { acquisitions++; return new Transport(); },
    onChange: () => { const s = broker.snapshot(); seen.push(`${s.availability}:${s.kind}:${s.description?.instance}`); } });
  try {
    await broker.start(); await flush(); assert.deepEqual(seen, ['ready:shared:instance']);
    for (let i = 0; i < 10; i++) { broker.snapshot(); broker.stats(); broker.isReady(broker.snapshot().generation); await broker.start(); }
    await flush(); assert.equal(seen.length, 1); assert.equal(acquisitions, 0); assert.equal(shared.requests.length, 1);
  } finally { await broker.dispose(); released(broker, clock); }
});

test('availability observer reports optional unavailable without exposing factory errors', async () => {
  const clock = new Clock(), seen: string[] = [];
  const broker = new ProviderBroker({ clock, tryShared: async () => { throw Error('private factory details'); }, acquireOwned: async () => { throw Error('private factory details'); },
    onChange: () => { seen.push(JSON.stringify(broker.snapshot())); } });
  try {
    await broker.start(); await flush(); assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0]!).availability, 'unavailable'); assert.equal(seen[0]!.includes('private factory'), false);
  } finally { await broker.dispose(); released(broker, clock); }
});

test('availability observer sees native timer return and never publishes returned shared before actual owned exit', async () => {
  const clock = new Clock(), first = new Transport(), owned = new Transport(), returned = new Transport(), exit = deferred<void>();
  let attempts = 0; const seen: string[] = [];
  const broker = new ProviderBroker({ clock, tryShared: async () => ++attempts === 1 ? first : attempts <= 3 ? undefined : returned, acquireOwned: async () => owned,
    onChange: () => { const s = broker.snapshot(); seen.push(`${s.availability}:${s.kind}`); } });
  try {
    await broker.start(); await broker.provenLoss(broker.snapshot().generation); await flush();
    assert.equal(seen.at(-1), 'ready:owned'); const before = seen.length; owned.exit = exit.promise;
    await clock.advance(60000); assert.equal(seen.at(-1), 'transitioning:undefined');
    assert.equal(seen.slice(before).includes('ready:shared'), false); assert.equal(owned.closes, 1);
    exit.resolve(); await flush(); assert.equal(seen.at(-1), 'ready:shared'); assert.equal(broker.stats().handoffsSucceeded, 1);
  } finally { exit.resolve(); await broker.dispose(); released(broker, clock); }
});

test('queued availability callback is weak and suppressed by permanent disposal', async () => {
  const clock = new Clock(); let notices = 0;
  const broker = new ProviderBroker({ clock, tryShared: async () => new Transport(), acquireOwned: async () => new Transport(), onChange: () => { notices++; } });
  const original = globalThis.queueMicrotask, queued: (() => void)[] = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try {
    await broker.start(); assert.equal(queued.length, 1); assert.equal(notices, 0);
    await broker.dispose(); for (const callback of queued) callback(); assert.equal(notices, 0); released(broker, clock);
  } finally { globalThis.queueMicrotask = original; await broker.dispose(); }
});

test('availability observer errors do not disturb readiness, exact recovery or resource release', async () => {
  const clock = new Clock(); let notices = 0, attempts = 0;
  const broker = new ProviderBroker({ clock, tryShared: async () => ++attempts === 1 ? new Transport() : undefined, acquireOwned: async () => new Transport(),
    onChange: () => { notices++; throw Error('caller observer'); } });
  try {
    await broker.start(); await flush(); assert.equal(broker.snapshot().kind, 'shared'); assert.equal(notices, 1);
    await broker.provenLoss(broker.snapshot().generation); await flush();
    assert.equal(broker.snapshot().kind, 'owned'); assert.equal(broker.stats().reconnectAttempts, 2); assert.equal(notices, 3);
  } finally { await broker.dispose(); released(broker, clock); }
});

test('availability observer validates before any asynchronous acquisition', () => {
  let calls = 0;
  assert.throws(() => new ProviderBroker({ tryShared: async () => { calls++; return undefined; }, acquireOwned: async () => new Transport(),
    onChange: 1 as unknown as () => void }), /observer/);
  assert.equal(calls, 0);
});

function noticeFactories(transport: Transport) { return { tryShared: async () => transport, acquireOwned: async () => new Transport() }; }
function queuedAvailabilityOwner(transport: Transport, clock: Clock) {
  const broker = new ProviderBroker({ ...noticeFactories(transport), clock, onChange: () => {} });
  return { owner: new WeakRef(broker), started: broker.start() };
}
test('first active provider collects with its production availability notice retained and another provider alive', { skip: !global.gc }, async () => {
  const firstClock = new Clock(), firstTransport = new Transport(), second = setup(async () => new Transport());
  const original = globalThis.queueMicrotask, queued: (() => void)[] = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  let first!: ReturnType<typeof queuedAvailabilityOwner>;
  try { first = queuedAvailabilityOwner(firstTransport, firstClock); await first.started; assert.equal(queued.length, 1); }
  finally { globalThis.queueMicrotask = original; }
  try {
    await second.broker.start();
    for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.owner.deref()) break; }
    assert.equal(first.owner.deref(), undefined); assert.equal(second.broker.snapshot().availability, 'ready');
    for (const callback of queued) callback(); assert.equal(firstClock.timers.size, 0);
  } finally { await firstTransport.close(); await second.broker.dispose(); released(second.broker, second.clock); }
});

test('broker negotiation rejects first metadata and selects second shared without acquisition or duplicate describe', async () => {
  const first = new Transport(), second = new Transport(); first.reply = async () => ({});
  const s = setup(async (_signal, negotiate) => {
    for (const transport of [first, second]) if (await negotiate(transport)) return transport;
    return undefined;
  });
  try {
    await s.broker.start(); assert.equal(s.acquisitions(), 0); assert.equal(s.broker.snapshot().kind, 'shared');
    assert.equal(first.closes, 1); assert.equal(second.closes, 0);
    assert.deepEqual(first.requests.map(r => r.op), ['describe']); assert.deepEqual(second.requests.map(r => r.op), ['describe']);
    assert.equal(s.broker.stats().controls, 2); assert.equal(s.broker.stats().candidatesRejected, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('repeated broker negotiation of same candidate never sends another describe', async () => {
  const shared = new Transport(); const answers: boolean[] = [];
  const s = setup(async (_signal, negotiate) => { answers.push(await negotiate(shared), await negotiate(shared)); return shared; });
  try {
    await s.broker.start(); assert.deepEqual(answers, [true, true]); assert.equal(s.acquisitions(), 0);
    assert.equal(shared.requests.length, 1); assert.equal(s.broker.stats().controls, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('broker negotiation uses the same absolute factory budget for late candidate metadata', async () => {
  const discovered = deferred<void>(), reply = deferred<unknown>(), first = new Transport(), second = new Transport(); first.reply = async () => reply.promise;
  let signal!: AbortSignal;
  const s = setup(async (attempt, negotiate) => {
    signal = attempt; await discovered.promise;
    if (await negotiate(first)) return first;
    if (!attempt.aborted && await negotiate(second)) return second;
    return undefined;
  });
  try {
    const started = s.broker.start(); await flush(); await s.clock.advance(PROVIDER_LIMITS.factoryMs - 10);
    discovered.resolve(); await flush(); assert.equal(first.requests.length, 1);
    await s.clock.advance(10); await started;
    assert.equal(signal.aborted, true); assert.equal(first.closes, 1); assert.equal(second.requests.length, 0);
    assert.equal(s.acquisitions(), 1); assert.equal(s.broker.snapshot().kind, 'owned');
    reply.resolve(descriptor(first.requests[0]!.ticket)); await flush(); assert.equal(s.broker.snapshot().kind, 'owned');
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('broker negotiation cannot lend accepted metadata to a different returned transport', async () => {
  const accepted = new Transport(), wrong = new Transport();
  const s = setup(async (_signal, negotiate) => { await negotiate(accepted); return wrong; });
  try {
    await s.broker.start(); assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(s.acquisitions(), 1);
    assert.equal(accepted.requests.length, 1); assert.equal(wrong.requests.length, 0);
    assert.equal(accepted.closes, 1); assert.equal(wrong.closes, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('old broker negotiation callback closes late candidates but cannot retire its transferred shared transport', async () => {
  let negotiate!: SharedNegotiator; const shared = new Transport();
  const s = setup(async (_signal, callback) => { negotiate = callback; await callback(shared); return shared; });
  try {
    await s.broker.start(); assert.equal(s.broker.snapshot().kind, 'shared');
    assert.equal(await negotiate(shared), false); assert.equal(shared.closes, 0); assert.equal(s.broker.snapshot().kind, 'shared');
    const late = new Transport(); assert.equal(await negotiate(late), false); assert.equal(late.closes, 1); assert.equal(late.requests.length, 0);
    await s.broker.dispose(); const after = new Transport(); assert.equal(await negotiate(after), false); assert.equal(after.closes, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('broker negotiation admits only one metadata request at a time without closing its in-flight candidate', async () => {
  const held = deferred<unknown>(), first = new Transport(), extra = new Transport(); first.reply = async () => held.promise;
  const answers: boolean[] = [];
  const s = setup(async (_signal, negotiate) => {
    const pending = negotiate(first); await flush();
    answers.push(await negotiate(first), await negotiate(extra));
    held.resolve(descriptor(first.requests[0]!.ticket)); answers.push(await pending); return first;
  });
  try {
    await s.broker.start(); assert.deepEqual(answers, [false, false, true]); assert.equal(s.broker.snapshot().kind, 'shared');
    assert.equal(first.closes, 0); assert.equal(extra.closes, 1); assert.equal(extra.requests.length, 0); assert.equal(first.requests.length, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

function capturedNegotiationFactory(transport: Transport, save: (callback: SharedNegotiator) => void): ProviderOptions['tryShared'] {
  return async (_signal, negotiate) => { save(negotiate); return await negotiate(transport) ? transport : undefined; };
}
function firstNegotiatingOwner(transport: Transport, clock: Clock, save: (callback: SharedNegotiator) => void) {
  const broker = new ProviderBroker({ clock, tryShared: capturedNegotiationFactory(transport, save), acquireOwned: async () => new Transport() });
  return { weak: new WeakRef(broker), started: broker.start() };
}
test('captured production negotiator does not retain the first active broker while a second remains alive', { skip: !global.gc }, async () => {
  let callback!: SharedNegotiator; const transport = new Transport(), clock = new Clock();
  const first = firstNegotiatingOwner(transport, clock, value => { callback = value; }); await first.started;
  const other = setup(async () => new Transport());
  try {
    assert.equal(typeof callback, 'function'); await other.broker.start();
    for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
    assert.equal(first.weak.deref(), undefined); assert.equal(other.broker.snapshot().kind, 'shared');
    transport.end('lost'); await flush(); assert.equal(clock.timers.size, 0);
    assert.equal(other.broker.snapshot().kind, 'shared');
    const late = new Transport(); assert.equal(await callback(late), false); assert.equal(late.closes, 1); assert.equal(clock.timers.size, 0);
  } finally { await transport.close(); await other.broker.dispose(); released(other.broker, other.clock); }
});

test('accepted broker negotiation abandoned by factory is closed on deadline; late return never publishes', async () => {
  const returned = deferred<ProviderTransport>(), shared = new Transport();
  const s = setup(async (_signal, negotiate) => { await negotiate(shared); return returned.promise; });
  try {
    const started = s.broker.start(); await flush(); assert.equal(shared.requests.length, 1);
    assert.equal(s.broker.stats().candidatesAccepted, 1); assert.equal(shared.closes, 0);
    await s.clock.advance(PROVIDER_LIMITS.factoryMs); await started;
    assert.equal(shared.closes, 1); assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(s.acquisitions(), 1);
    returned.resolve(shared); await flush(); assert.equal(shared.closes, 1); assert.equal(s.broker.snapshot().kind, 'owned');
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('broker negotiation checks absolute time before transfer even when timer dispatch is delayed', async () => {
  const shared = new Transport(); let clock!: Clock;
  const s = setup(async (_signal, negotiate) => {
    await negotiate(shared); clock.time += PROVIDER_LIMITS.factoryMs + 1; return shared;
  }); clock = s.clock;
  try {
    await s.broker.start(); assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(shared.closes, 1); assert.equal(s.acquisitions(), 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('review: legacy negotiation cannot transfer after describe passes the absolute budget with delayed timers', async () => {
  const shared = new Transport(), s = setup(async () => shared);
  shared.reply = async request => { s.clock.time += PROVIDER_LIMITS.factoryMs + 1; return descriptor(request.ticket); };
  try {
    await s.broker.start(); assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(s.acquisitions(), 1);
    assert.equal(shared.requests.length, 1); assert.equal(shared.closes, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('owned recovery admits two consecutive restarts, not an unlimited ready-generation chain', async () => {
  const s = setup(async () => undefined);
  try {
    await s.broker.start(); assert.equal(s.acquisitions(), 1);
    for (let i = 0; i < 2; i++) {
      await s.broker.provenLoss(s.broker.snapshot().generation);
      assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(s.acquisitions(), i + 2);
    }
    await s.broker.provenLoss(s.broker.snapshot().generation);
    assert.equal(s.acquisitions(), 3); assert.equal(s.broker.snapshot().availability, 'unavailable');
    assert.equal(s.broker.snapshot().reason, 'restart_limit');
    assert.equal(s.broker.stats().ownedRestarts, 2); assert.equal(s.broker.stats().ownedRestartStops, 1);
    await s.broker.start(); assert.equal(s.acquisitions(), 3); released(s.broker, s.clock);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('only current validated classification resets owned crash budget; metadata/raw RPC/stale success do not', async () => {
  const s = setup(async () => undefined);
  try {
    await s.broker.start(); const obsolete = s.broker.snapshot().generation;
    for (let i = 0; i < 2; i++) await s.broker.provenLoss(s.broker.snapshot().generation);
    const generation = s.broker.snapshot().generation;
    await s.broker.request(generation, {v:2,op:'describe',ticket:'source:metadata'});
    await s.broker.request(generation, {v:2,op:'highlight',ticket:'source:unvalidated'});
    assert.equal(s.broker.classificationAccepted(obsolete), false);
    await s.broker.provenLoss(generation);
    assert.equal(s.acquisitions(), 3); assert.equal(s.broker.snapshot().reason, 'restart_limit');
    assert.equal(s.broker.classificationAccepted(generation), false);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('a successful validated current classification allows a fresh pair of owned restarts', async () => {
  const s = setup(async () => undefined);
  try {
    await s.broker.start();
    for (let i = 0; i < 2; i++) await s.broker.provenLoss(s.broker.snapshot().generation);
    assert.equal(s.broker.classificationAccepted(s.broker.snapshot().generation), true);
    for (let i = 0; i < 2; i++) await s.broker.provenLoss(s.broker.snapshot().generation);
    assert.equal(s.acquisitions(), 5); assert.equal(s.broker.stats().ownedRestarts, 4);
    await s.broker.provenLoss(s.broker.snapshot().generation);
    assert.equal(s.acquisitions(), 5); assert.equal(s.broker.snapshot().reason, 'restart_limit');
    assert.equal(s.broker.stats().successfulClassifications, 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});

test('published owned lifetime consumes automatic loss exactly once and stops after two replacements', async () => {
  const clock = new Clock(), owned: Transport[] = [];
  const broker = new ProviderBroker({clock, tryShared:async()=>undefined, acquireOwned:async()=>{const t=new Transport();owned.push(t);return t;}});
  try {
    await broker.start(); assert.equal(owned.length,1);
    for (let i=0;i<2;i++) {
      owned[i]!.end('lost'); await flush(); assert.equal(owned.length,i+2);
      assert.equal(owned[i]!.closes,1); assert.equal(broker.snapshot().kind,'owned');
    }
    owned[2]!.end('lost'); await flush();
    assert.equal(owned.length,3); assert.equal(owned[2]!.closes,1); assert.equal(broker.snapshot().reason,'restart_limit');
    assert.equal(broker.stats().sourceDispatches,0); assert.equal(broker.stats().ownedRestarts,2); released(broker,clock);
  } finally {await broker.dispose(); released(broker,clock);}
});

test('published shared loss automatically performs two reconnects then owned takeover', async () => {
  const shared = new Transport(); let calls=0;
  const s=setup(async()=>++calls===1?shared:undefined);
  try {
    await s.broker.start(); shared.end('lost'); await flush();
    assert.equal(calls,3); assert.equal(shared.closes,1); assert.equal(s.acquisitions(),1);
    assert.equal(s.broker.snapshot().kind,'owned'); assert.equal(s.broker.snapshot().initialShared,true);
    assert.equal(s.broker.stats().reconnectAttempts,2); assert.equal(s.broker.stats().recoveryTimers,1);
  } finally {await s.broker.dispose();released(s.broker,s.clock);}
});

for (const reason of ['uncertain','denied','closed'] as const)
  test(`published ${reason} ending retires availability without recovery or source replay`, async () => {
    const shared=new Transport(), s=setup(async()=>shared);
    try {
      await s.broker.start(); shared.end(reason); await flush();
      assert.equal(s.broker.snapshot().availability,'unavailable'); assert.equal(s.broker.snapshot().reason,`transport_${reason}`);
      assert.equal(shared.closes,1); assert.equal(s.acquisitions(),0); assert.equal(s.broker.stats().sharedAttempts,1);
      assert.equal(s.broker.stats().sourceDispatches,0); assert.equal(shared.endReason,reason); released(s.broker,s.clock);
    } finally {await s.broker.dispose();released(s.broker,s.clock);}
  });

test('a late previous published ending cannot retire or replace the new shared generation', async () => {
  const first=new Transport(), next=new Transport(); first.close=async()=>{first.closes++;}; let calls=0;
  const s=setup(async()=>++calls===1?first:next);
  try {
    await s.broker.start(); await s.broker.provenLoss(s.broker.snapshot().generation);
    const generation=s.broker.snapshot().generation; first.end('lost'); await flush();
    assert.equal(s.broker.snapshot().generation,generation); assert.equal(s.broker.snapshot().kind,'shared');
    assert.equal(calls,2); assert.equal(s.acquisitions(),0); assert.equal(first.closes,1);
  } finally {await s.broker.dispose();released(s.broker,s.clock);}
});

test('already ended shared candidate is never publication or initial shared availability', async () => {
  const shared=new Transport(); shared.end('lost'); const s=setup(async()=>shared);
  try {
    await s.broker.start(); assert.equal(s.broker.snapshot().initialShared,false); assert.equal(s.broker.snapshot().kind,'owned');
    assert.equal(s.acquisitions(),1); assert.equal(shared.requests.length,0); assert.equal(shared.closes,1);
    assert.equal(s.broker.stats().reconnectAttempts,0); assert.equal(s.broker.stats().recoveryTimers,0);
  } finally {await s.broker.dispose();released(s.broker,s.clock);}
});

test('observed owned ending waits real close proof before replacement; disposal cannot resurrect', async () => {
  const owned=new Transport(), exit=deferred<void>();owned.exit=exit.promise;const s=setup(async()=>undefined,owned);
  try {
    await s.broker.start();owned.end('lost');await flush();assert.equal(s.broker.snapshot().availability,'transitioning');
    assert.equal(s.acquisitions(),1);assert.equal(owned.closes,1);
    const shutdown=s.broker.dispose();exit.resolve();await shutdown;await flush();
    assert.equal(s.acquisitions(),1);assert.equal(s.broker.snapshot().availability,'disposed');released(s.broker,s.clock);
  } finally {exit.resolve();await s.broker.dispose();released(s.broker,s.clock);}
});

test('shared ending during owned reap is not a successful return and cannot renew recovery window', async () => {
  const owned = new Transport(), returned = new Transport(), exit = deferred<void>(); owned.exit = exit.promise;
  let probes = 0;
  const s = await failover(new Transport(), owned, async () => ++probes === 3 ? returned : undefined);
  try {
    await s.clock.advance(60000);
    assert.equal(s.broker.snapshot().availability, 'transitioning'); assert.equal(owned.closes, 1);
    returned.end('lost'); exit.resolve(); await flush();
    assert.equal(s.broker.snapshot().kind, 'owned'); assert.equal(returned.closes, 1);
    assert.equal(s.acquisitions(), 2); assert.equal(s.broker.stats().ownedRestarts, 0);
    assert.equal(s.broker.stats().handoffsSucceeded, 0); assert.equal(s.broker.stats().handoffsFailed, 1);
    assert.equal(s.broker.stats().recoveryEpisodes, 1); assert.equal(s.broker.stats().reconnectAttempts, 2);
    assert.equal(s.broker.stats().recoveryTimers, 1); assert.equal(s.broker.stats().sourceDispatches, 0);
    await s.clock.advance(540000);
    assert.equal(s.broker.stats().probesStarted, 10); assert.equal(s.broker.stats().recoveryTimers, 0);
    await s.clock.advance(60000); assert.equal(s.broker.stats().probesStarted, 10);
  } finally { exit.resolve(); await s.broker.dispose(); released(s.broker, s.clock); }
});

// Session lifecycle controls: deterministic clock, metadata only unless explicitly held.
test('session off is observable, source-retiring, coalesced and inert under ordinary start/status', async () => {
  const clock=new Clock(), shared=new Transport(), source=deferred<unknown>(); let calls=0, notices=0;
  const broker=new ProviderBroker({clock,tryShared:async()=>{calls++;return shared;},acquireOwned:async()=>new Transport(),onChange:()=>{notices++;}});
  await broker.start(); const old=broker.snapshot().generation; shared.reply=()=>source.promise;
  const stale=assert.rejects(broker.request(old,{op:'highlight',ticket:'held'}),disposition('unknown'));
  await broker.setEnabled(false); await flush(); const off=broker.snapshot(), stats=broker.stats(), before=notices;
  assert.equal(off.availability,'disabled'); assert.equal(off.reason,'disabled'); assert.equal(off.kind,undefined);
  assert.equal(broker.classificationAccepted(old),false); assert.equal(shared.closes,1);
  for(let i=0;i<3;i++) {await broker.start();await broker.setEnabled(false);broker.snapshot();broker.stats();}
  await assert.rejects(broker.request(old,{op:'highlight',ticket:'off'}),disposition('not_started'));
  await clock.advance(1200000); assert.deepEqual(broker.snapshot(),off); assert.deepEqual(broker.stats(),stats);
  assert.equal(notices,before); assert.equal(calls,1); source.resolve({old:true});await stale;
  await broker.dispose(); released(broker,clock);
});

for(const phase of ['queued','discovery','describe','reconnect'] as const)
  test(`session off during ${phase} cancels startup authority and closes late candidates`,async()=>{
    const clock=new Clock(),held=deferred<ProviderTransport|undefined>(),reply=deferred<unknown>(),candidate=new Transport(),first=new Transport();
    let calls=0,acquisitions=0,signal:AbortSignal|undefined;
    candidate.reply=()=>reply.promise;
    const broker=new ProviderBroker({clock,tryShared:async attempt=>{signal=attempt;calls++;return phase==='describe'?candidate:phase==='reconnect'&&calls===1?first:held.promise;},acquireOwned:async()=>{acquisitions++;return new Transport();}});
    let operation=broker.start(); if(phase==='reconnect') {await operation;operation=broker.provenLoss(broker.snapshot().generation);}
    if(phase!=='queued') await flush();
    await broker.setEnabled(false);await operation;assert.equal(broker.snapshot().availability,'disabled');
    if(phase==='queued') assert.equal(calls,0);else assert.equal(signal?.aborted,true);
    const late=new Transport();held.resolve(late);if(phase==='describe')reply.resolve(descriptor(candidate.requests[0]!.ticket));await flush();
    if(phase!=='queued'&&phase!=='describe')assert.equal(late.closes,1);
    if(phase==='describe')assert.equal(candidate.closes,1);
    assert.equal(acquisitions,0);await broker.start();released(broker,clock);await broker.dispose();
  });

for(const phase of ['probe','probe-describe','handoff'] as const)
  test(`session off during ${phase} cannot publish a late return or revive the owned helper`,async()=>{
    const held=deferred<ProviderTransport|undefined>(),reply=deferred<unknown>(),exit=deferred<void>(),candidate=new Transport(),owned=new Transport();let n=0;
    if(phase==='probe-describe')candidate.reply=()=>reply.promise;
    const s=await failover(new Transport(),owned,async()=>++n<=2?undefined:phase==='probe'?held.promise:candidate);
    if(phase==='handoff')owned.exit=exit.promise;
    await s.clock.advance(60000);assert.equal(s.broker.stats().activeProbes,1);
    const off=s.broker.setEnabled(false);await flush();assert.equal(s.broker.snapshot().availability,'disabled');
    if(phase==='handoff') {assert.equal(owned.closes,1);assert.equal(candidate.closes,1);exit.resolve();}
    await off;held.resolve(candidate);if(phase==='probe-describe')reply.resolve(descriptor(candidate.requests[0]!.ticket));await flush();
    assert.equal(candidate.closes,1);assert.equal(owned.closes,1);assert.equal(s.broker.stats().handoffsSucceeded,0);
    await s.clock.advance(600000);assert.equal(s.broker.snapshot().availability,'disabled');released(s.broker,s.clock);await s.broker.dispose();
  });

test('session rapid off/on waits actual owned exit and old ending cannot retire the replacement',async()=>{
  const clock=new Clock(),owned=new Transport(),exit=deferred<void>(),children:Transport[]=[];owned.exit=exit.promise;
  owned.close=()=>{owned.closes++;return owned.exit;};
  const broker=new ProviderBroker({clock,tryShared:async()=>undefined,acquireOwned:async()=>{const t=children.length?new Transport():owned;children.push(t);return t;}});
  await broker.start();const old=broker.snapshot().generation,off=broker.setEnabled(false),on=broker.setEnabled(true);await flush();
  assert.equal(children.length,1);assert.equal(owned.closes,1);assert.equal(broker.isReady(old),false);
  exit.resolve();await off;await on;assert.equal(children.length,2);assert.equal(broker.snapshot().kind,'owned');
  const snapshot=broker.snapshot();owned.end('lost');await flush();assert.deepEqual(broker.snapshot(),snapshot);
  await broker.setEnabled(true);await broker.start();assert.equal(children.length,2);await broker.dispose();released(broker,clock);
});

test('session enable resets exhausted crash chain only after deliberate off',async()=>{
  const s=setup(async()=>undefined);await s.broker.start();for(let i=0;i<3;i++)await s.broker.provenLoss(s.broker.snapshot().generation);
  assert.equal(s.broker.snapshot().reason,'restart_limit');await s.broker.setEnabled(true);await s.broker.start();assert.equal(s.acquisitions(),3);
  await s.broker.setEnabled(false);await s.broker.setEnabled(true);assert.equal(s.acquisitions(),4);assert.equal(s.broker.snapshot().initialShared,false);
  for(let i=0;i<3;i++)await s.broker.provenLoss(s.broker.snapshot().generation);
  assert.equal(s.acquisitions(),6);assert.equal(s.broker.stats().ownedRestarts,4);assert.equal(s.broker.snapshot().reason,'restart_limit');
  await s.broker.dispose();released(s.broker,s.clock);
});

for(const elapsed of [150000,650000])
  test(`session on preserves initial shared memory but never revives the episode after ${elapsed}ms off`,async()=>{
    const s=await failover(new Transport(),new Transport());await s.clock.advance(60000);
    await s.broker.setEnabled(false);const probes=s.broker.stats().probesStarted;await s.clock.advance(elapsed);released(s.broker,s.clock);
    await s.broker.setEnabled(true);assert.equal(s.broker.snapshot().initialShared,true);assert.equal(s.broker.stats().recoveryEpisodes,1);
    assert.equal(s.broker.stats().probesStarted,probes);assert.equal(s.broker.stats().sourceDispatches,0);
    assert.equal(s.broker.stats().recoveryTimers,0);released(s.broker,s.clock);
    await s.clock.advance(1200000);assert.equal(s.broker.stats().probesStarted,probes);const done=s.broker.stats().probesStarted;
    await s.broker.setEnabled(false);await s.broker.setEnabled(true);await s.clock.advance(1200000);
    assert.equal(s.broker.stats().probesStarted,done);assert.equal(s.broker.stats().recoveryEpisodes,1);await s.broker.dispose();released(s.broker,s.clock);
  });

test('session initial standalone memory survives enable selecting shared and later failing owned',async()=>{
  const shared=new Transport();let calls=0;const s=setup(async()=>++calls===2?shared:undefined);
  await s.broker.start();await s.broker.setEnabled(false);await s.broker.setEnabled(true);
  assert.equal(s.broker.snapshot().kind,'shared');assert.equal(s.broker.snapshot().initialShared,false);
  await s.broker.provenLoss(s.broker.snapshot().generation);assert.equal(s.broker.snapshot().kind,'owned');assert.equal(s.broker.stats().recoveryEpisodes,0);
  await s.broker.dispose();released(s.broker,s.clock);
});

test('session disposal remains terminal during off/on cleanup and redundant actions do nothing',async()=>{
  const owned=new Transport(),exit=deferred<void>();owned.exit=exit.promise;const s=setup(async()=>undefined,owned);await s.broker.start();
  const off=s.broker.setEnabled(false),on=s.broker.setEnabled(true);await flush();const shutdown=s.broker.dispose();exit.resolve();await off;await on;await shutdown;
  const stats=s.broker.stats(),snapshot=s.broker.snapshot();await s.broker.setEnabled(true);await s.broker.setEnabled(false);await s.broker.start();
  assert.deepEqual(s.broker.snapshot(),snapshot);assert.deepEqual(s.broker.stats(),stats);assert.equal(snapshot.availability,'disposed');assert.equal(s.acquisitions(),1);released(s.broker,s.clock);
});


test('session on from initially shared starts no first episode; only later genuine shared loss starts one',async()=>{
  const first=new Transport(),returned=new Transport();let calls=0;const s=setup(async()=>++calls===1?first:calls===3?returned:undefined);
  await s.broker.start();await s.broker.setEnabled(false);await s.broker.setEnabled(true);
  assert.equal(s.broker.snapshot().kind,'owned');assert.equal(s.broker.snapshot().initialShared,true);
  assert.equal(s.broker.stats().recoveryEpisodes,0);await s.clock.advance(1200000);assert.equal(calls,2);released(s.broker,s.clock);
  await s.broker.setEnabled(false);await s.broker.setEnabled(true);assert.equal(s.broker.snapshot().kind,'shared');
  await s.broker.provenLoss(s.broker.snapshot().generation);assert.equal(s.broker.stats().recoveryEpisodes,1);
  await s.clock.advance(60000);assert.equal(s.broker.stats().probesStarted,1);await s.broker.dispose();released(s.broker,s.clock);
});

for(const phase of ['owned-describe','handoff','loss'] as const)
  test(`session on after ${phase} waits known actual owned exit, not the bounded close timeout`,async()=>{
    const clock=new Clock(),owned=new Transport(),exit=deferred<void>(),reply=deferred<unknown>(),shared=new Transport(),returned=new Transport();
    owned.exit=exit.promise;let calls=0,acquisitions=0;
    if(phase==='owned-describe')owned.reply=()=>reply.promise;
    const broker=new ProviderBroker({clock,tryShared:async()=>{calls++;return phase==='owned-describe'?undefined:calls===1?shared:calls<=3?undefined:returned;},acquireOwned:async()=>{acquisitions++;return acquisitions===1?owned:new Transport();}});
    const started=broker.start();await flush();
    if(phase!=='owned-describe') {await started;await broker.provenLoss(broker.snapshot().generation);}
    if(phase==='handoff')await clock.advance(60000);
    if(phase==='loss') {owned.end('lost');await flush();}
    const off=broker.setEnabled(false);await clock.advance(PROVIDER_LIMITS.closeMs);await off;
    const beforeCalls=calls,on=broker.setEnabled(true);await flush();assert.equal(calls,beforeCalls);assert.equal(acquisitions,1);
    await clock.advance(PROVIDER_LIMITS.closeMs);await on;assert.equal(broker.snapshot().reason,'unproved_exit');
    exit.resolve();if(phase==='owned-describe')reply.resolve(descriptor(owned.requests[0]!.ticket));await started;await flush();
    assert.equal(broker.snapshot().reason,'unproved_exit');assert.equal(acquisitions,1);assert.equal(owned.closes,1);
    await broker.setEnabled(false);await broker.setEnabled(true);assert.equal(broker.snapshot().availability,'ready');
    assert.equal(broker.stats().handoffsSucceeded,0);await broker.dispose();released(broker,clock);
  });

test('session known owned close rejection cannot authorize a second helper or shared publication',async()=>{
  const owned=new Transport(),shared=new Transport();owned.close=()=>{owned.closes++;return Promise.reject(Error('no exit proof'));};let calls=0;
  const s=setup(async()=>++calls===1?undefined:shared,owned);await s.broker.start();await s.broker.setEnabled(false);await s.broker.setEnabled(true);
  assert.equal(s.broker.snapshot().reason,'unproved_exit');assert.equal(calls,1);assert.equal(s.acquisitions(),1);assert.equal(shared.requests.length,0);
  await s.broker.dispose();released(s.broker,s.clock);
});

test('session rapid off/on pending acquisition uses the factory-owned late-child cleanup slot',async()=>{
  const clock=new Clock(),acquired=deferred<ProviderTransport>(),exit=deferred<void>(),late=new Transport(),fresh=new Transport();late.exit=exit.promise;
  let calls=0,active=0,maxActive=0;const signals:AbortSignal[]=[];
  // Contract-compliant acquisition seam: transfer abort keeps the slot through
  // late child disposal/actual exit, just as createOwnedFactory does across owners.
  const slot=acquired.promise.then(async()=>{active++;maxActive=Math.max(maxActive,active);await exit.promise;active--;});
  const broker=new ProviderBroker({clock,tryShared:async()=>undefined,acquireOwned:async signal=>{
    signals.push(signal);if(++calls===1)return acquired.promise;
    await slot;if(signal.aborted)throw Error('aborted');active++;maxActive=Math.max(maxActive,active);return fresh;
  }});
  const started=broker.start();await flush();assert.equal(calls,1);
  await broker.setEnabled(false);await started;assert.equal(signals[0]!.aborted,true);
  const on=broker.setEnabled(true);await flush();assert.equal(calls,2);assert.equal(fresh.requests.length,0);
  acquired.resolve(late);await flush();assert.equal(late.closes,1);assert.equal(late.requests.length,0);assert.equal(fresh.requests.length,0);
  exit.resolve();await on;assert.equal(maxActive,1);assert.equal(broker.snapshot().kind,'owned');assert.deepEqual(fresh.requests.map(r=>r.op),['describe']);
  await broker.dispose();released(broker,clock);
});


test('session public stdio off/on requires actual reap before shared metadata or source authority',async t=>{
  const program=`const d=${JSON.stringify(descriptor(''))};let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);while(b.length>=4&&b.length>=4+b.readUInt32BE(0)){const n=b.readUInt32BE(0),r=JSON.parse(b.subarray(4,4+n));b=b.subarray(4+n);if(r.op==='describe'){const v=Buffer.from(JSON.stringify({...d,ticket:r.ticket})),h=Buffer.alloc(4);h.writeUInt32BE(v.length);process.stdout.write(Buffer.concat([h,v]));}}});`;
  const owned=new StdioTransport({command:process.execPath,args:['-e',program],requestDeadlineMs:3000,terminateGraceMs:40});t.after(()=>owned.close());
  const clock=new Clock(),returned=new Transport();let calls=0,acquisitions=0;
  const broker=new ProviderBroker({clock,tryShared:async()=>++calls===1?undefined:returned,acquireOwned:async()=>{acquisitions++;return owned;}});t.after(()=>broker.dispose());
  await broker.start();const pid=owned.stats().pid;
  returned.reply=async r=>{assert.equal(owned.stats().childState,'exited');assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});return r.op==='describe'?descriptor(r.ticket):{answer:true};};
  const off=broker.setEnabled(false),on=broker.setEnabled(true);await off;await on;
  assert.equal(broker.snapshot().kind,'shared');assert.equal(acquisitions,1);assert.equal(owned.stats().spawnCount,1);
  await broker.request(broker.snapshot().generation,{op:'highlight',ticket:'new'});
  assert.equal(owned.stats().ownedListeners,0);assert.equal(owned.stats().liveTimers,0);assert.equal(owned.stats().abortListeners,0);
  await broker.dispose();released(broker,clock);
});

test('session old ended event delivered while disabled cannot acquire or notify again',async()=>{
  const shared=new Transport();shared.close=async()=>{shared.closes++;};const s=setup(async()=>shared);
  await s.broker.start();await s.broker.setEnabled(false);const snapshot=s.broker.snapshot(),stats=s.broker.stats();
  shared.end('lost');await flush();assert.deepEqual(s.broker.snapshot(),snapshot);assert.deepEqual(s.broker.stats(),stats);
  assert.equal(s.acquisitions(),0);await s.broker.dispose();released(s.broker,s.clock);
});

function catalogueReply(ticket: unknown, revision = 1, diagnostic: string | null = null) {
  const reply = descriptor(ticket);
  reply.body.catalogue_revision = revision; reply.body.diagnostic = diagnostic;
  reply.body.profiles.push({ id: 'bundled:test', label: 'Independent', fingerprint: 'b'.repeat(64) });
  return reply;
}
test('catalogue control publishes validated metadata without provider replacement or source work', async () => {
  const transport = new Transport(), s = setup(async () => transport); await s.broker.start();
  const old = s.broker.snapshot(), before = s.broker.stats();
  transport.reply = async r => catalogueReply(r.ticket);
  try {
    const result = await s.broker.catalogue(old.generation, 'themes.refresh');
    assert.equal(result.catalogue_revision, 1); assert.deepEqual(result, s.broker.snapshot().description);
    assert.equal(s.broker.snapshot().generation, old.generation); assert.equal(s.broker.snapshot().initialShared, true);
    assert.equal(s.acquisitions(), 0); assert.equal(transport.closes, 0);
    assert.deepEqual(transport.requests.map(r => r.op), ['describe', 'themes.refresh']);
    assert.deepEqual(Object.keys(transport.requests[1]!).sort(), ['op', 'ticket', 'v']);
    assert.notEqual(transport.requests[0]!.ticket, transport.requests[1]!.ticket);
    assert.equal(s.broker.stats().controls, before.controls + 1); assert.equal(s.broker.stats().sourceDispatches, 0);
    assert.equal(s.broker.stats().successfulClassifications, 0); assert.equal(s.broker.stats().recoveryEpisodes, 0);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});
test('catalogue control notifies metadata changes once; identical description is not a new generation or notice', async () => {
  const transport = new Transport(), clock = new Clock(); let notices = 0;
  const broker = new ProviderBroker({ clock, tryShared: async () => transport, acquireOwned: async () => { throw Error('unexpected'); }, onChange: () => { notices++; } });
  await broker.start(); await flush(); const initial = notices, generation = broker.snapshot().generation;
  transport.reply = async r => catalogueReply(r.ticket);
  try {
    await broker.catalogue(generation, 'describe'); await flush(); assert.equal(notices, initial + 1);
    await broker.catalogue(generation, 'describe'); await flush(); assert.equal(notices, initial + 1);
    assert.equal(broker.snapshot().generation, generation); assert.equal(broker.stats().sourceDispatches, 0);
    transport.reply = async r => catalogueReply(r.ticket, 1, 'theme_read_failed');
    await broker.catalogue(generation, 'themes.refresh'); await flush(); assert.equal(notices, initial + 2);
    assert.equal(broker.snapshot().description?.profiles[1]?.fingerprint, 'b'.repeat(64));
    assert.equal(broker.snapshot().description?.diagnostic, 'theme_read_failed');
  } finally { await broker.dispose(); released(broker, clock); }
});
for (const bad of ['malformed', 'oversized', 'instance', 'assets', 'revision', 'same_revision_definition']) test(`catalogue ${bad} reply preserves usable provider and last validated metadata`, async () => {
  const transport = new Transport(), s = setup(async () => transport); await s.broker.start();
  const generation = s.broker.snapshot().generation;
  transport.reply = async r => catalogueReply(r.ticket); await s.broker.catalogue(generation, 'describe');
  const previous = s.broker.snapshot().description;
  transport.reply = async r => {
    const value = catalogueReply(r.ticket);
    if (bad === 'malformed') return {};
    if (bad === 'oversized') return { ...value, excess: 'x'.repeat(32769) };
    if (bad === 'instance') value.instance = 'replacement';
    if (bad === 'assets') { value.assets = 'replacement'; value.body.assets = 'replacement'; }
    if (bad === 'revision') value.body.catalogue_revision = 0;
    if (bad === 'same_revision_definition') value.body.profiles[1]!.fingerprint = 'c'.repeat(64);
    return value;
  };
  try {
    await assert.rejects(s.broker.catalogue(generation, 'themes.refresh'));
    assert.deepEqual(s.broker.snapshot().description, previous); assert.equal(s.broker.isReady(generation), true);
    assert.equal(s.acquisitions(), 0); assert.equal(transport.closes, 0); assert.equal(s.broker.stats().sourceDispatches, 0);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});
test('catalogue does not acquire or dispatch while initializing, disabled or stale', async () => {
  const s = setup(async () => undefined);
  try {
    for (const action of [undefined, 'off'] as const) {
      if (action === 'off') await s.broker.setEnabled(false);
      const before = s.broker.stats();
      await assert.rejects(s.broker.catalogue(s.broker.snapshot().generation, 'describe'), (e: unknown) => e instanceof RequestFailure && e.execution === 'not_started');
      assert.deepEqual(s.broker.stats(), before); assert.equal(s.acquisitions(), 0);
    }
    await s.broker.setEnabled(true);
    const before = s.broker.stats();
    await assert.rejects(s.broker.catalogue(s.broker.snapshot().generation - 1, 'describe'));
    assert.deepEqual(s.broker.stats(), before); assert.equal(s.acquisitions(), 1);
  } finally { await s.broker.dispose(); released(s.broker, s.clock); }
});
test('late catalogue after off/on cannot publish to a new provider', async () => {
  const first = new Transport(), second = new Transport(), held = deferred<unknown>(); let selections = 0;
  const s = setup(async () => ++selections === 1 ? first : second); await s.broker.start();
  first.reply = async () => held.promise;
  const generation = s.broker.snapshot().generation, operation = s.broker.catalogue(generation, 'themes.refresh');
  const rejection = assert.rejects(operation); await flush(); const ticket = first.requests[1]!.ticket;
  try {
    await s.broker.setEnabled(false); await rejection; await s.broker.setEnabled(true);
    const current = s.broker.snapshot(); held.resolve(catalogueReply(ticket, 9)); await flush();
    assert.deepEqual(s.broker.snapshot(), current); assert.equal(current.description?.catalogue_revision, 0);
    assert.equal(first.closes, 1); assert.equal(second.requests.length, 1); assert.equal(s.broker.stats().sourceDispatches, 0);
  } finally { held.resolve({}); await s.broker.dispose(); released(s.broker, s.clock); }
});
test('catalogue wait is finite without closing transport; late response never updates metadata', async () => {
  const transport = new Transport(), held = deferred<unknown>(), s = setup(async () => transport); await s.broker.start();
  const previous = s.broker.snapshot(); transport.reply = async () => held.promise;
  const operation = s.broker.catalogue(previous.generation, 'themes.refresh'), rejected = assert.rejects(operation); await flush();
  try {
    const ticket = transport.requests[1]!.ticket; await s.clock.advance(PROVIDER_LIMITS.controlMs); await rejected;
    assert.deepEqual(s.broker.snapshot(), previous); assert.equal(transport.closes, 0); assert.equal(s.acquisitions(), 0);
    held.resolve(catalogueReply(ticket)); await flush(); assert.deepEqual(s.broker.snapshot(), previous);
    assert.equal(s.broker.stats().liveTimers, 0); assert.equal(s.broker.stats().abortListeners, 0);
  } finally { held.resolve({}); await s.broker.dispose(); released(s.broker, s.clock); }
});
test('catalogue updates cannot retire a held source on an unchanged provider', async () => {
  const transport = new Transport(), held = deferred<unknown>(), s = setup(async () => transport); await s.broker.start();
  const generation = s.broker.snapshot().generation;
  transport.reply = r => r.op === 'highlight' ? held.promise : Promise.resolve(catalogueReply(r.ticket));
  const source = s.broker.request(generation, { v: 2, op: 'highlight', ticket: 'source:held' });
  try {
    await s.broker.catalogue(generation, 'themes.refresh'); held.resolve({ old_source: true });
    assert.deepEqual(await source, { old_source: true }); assert.equal(s.broker.isReady(generation), true);
    assert.equal(s.broker.stats().sourceDispatches, 1); assert.equal(s.broker.stats().successfulClassifications, 0);
  } finally { held.resolve({}); await Promise.allSettled([source]); await s.broker.dispose(); released(s.broker, s.clock); }
});


test('catalogue real shared adapter timeout preserves publication, independent data and bounded pending control', async t => {
  const calls: Record<string, unknown>[] = [], heldControl = deferred<unknown>(), heldData = deferred<unknown>();
  let refreshTicket: unknown;
  const client: SharedClient = {
    resolveProvider: async () => 'occipital', routeOpen: async () => ({ channel: 7, epoch: 9 }),
    request: (_route, bytes) => {
      const r = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>; calls.push(r);
      if (r.op === 'themes.refresh') { refreshTicket = r.ticket; return heldControl.promise; }
      if (r.op === 'highlight') return heldData.promise;
      return Promise.resolve(descriptor(r.ticket));
    }, closeRoute: async () => {}, close: () => {},
  };
  const transport = new SharedTransport({ connectionFile: '/fixture', identity: { project_root: '/fixture', harness: 'test', session: 'one' }, initDeadlineMs: 3000, requestDeadlineMs: 30000,
    loadSdk: async () => ({ SubcClient: { connect: async () => client } }) });
  const broker = new ProviderBroker({ tryShared: async () => { await transport.ready; return transport; }, acquireOwned: async () => { throw Error('must not acquire'); } });
  t.after(() => broker.dispose()); await broker.start(); const previous = broker.snapshot();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = broker.request(previous.generation, { v: 2, op: 'highlight', ticket: 'data', instance: previous.description!.instance, admission: 'try_now',
    sources: [{ key: 'file:probe', generation: 1, source_version: 1, profile: 'pi', fingerprint: 'a'.repeat(64), hint: { language: 'Plain Text' }, text: 'x' }] }, { deadlineMs: 30000 });
  void data.catch(() => {});
  const refused = assert.rejects(broker.catalogue(previous.generation, 'themes.refresh')); await flush();
  assert.equal(transport.stats().unsettledData, 1); assert.equal(transport.stats().unsettledControl, 1);
  t.mock.timers.tick(PROVIDER_LIMITS.controlMs); await refused; await flush();
  assert.deepEqual(broker.snapshot(), previous); assert.equal(transport.endReason, undefined);
  assert.equal(transport.stats().unsettledControl, 1); assert.equal(transport.stats().unsettledData, 1);
  assert.equal(broker.stats().ownedAttempts, 0); assert.equal(broker.stats().recoveryEpisodes, 0);
  assert.equal(broker.stats().closesStarted, 0); assert.equal(transport.stats().liveTimers, 1);
  await assert.rejects(broker.catalogue(previous.generation, 'describe'), { message: 'occipital control unavailable' }); assert.equal(calls.length, 3);
  heldData.resolve({ v: 2, ticket: 'data', instance: 'instance', assets: 'assets', status: 'ok', body: { text: 'x' } });
  assert.equal((await data as { body: { text: string } }).body.text, 'x');
  heldControl.resolve(catalogueReply(refreshTicket, 9)); await flush();
  assert.deepEqual(broker.snapshot(), previous); assert.equal(transport.stats().unsettledControl, 0);
  await broker.catalogue(previous.generation, 'describe'); assert.equal(calls.length, 4);
  assert.deepEqual(broker.snapshot(), previous); assert.equal(broker.stats().sourceDispatches, 1);
  t.mock.timers.reset(); await broker.dispose(); assert.equal(transport.stats().state, 'closed');
});

test('catalogue real stdio timeout does not reap the helper or lose a concurrent one-byte source', async t => {
  const program = `const d=${JSON.stringify(descriptor(''))};let b=Buffer.alloc(0),data,metadata;
    function send(v){const body=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([h,body]));}
    process.stdin.on('data',c=>{b=Buffer.concat([b,c]);while(b.length>=4&&b.length>=4+b.readUInt32BE(0)){const n=b.readUInt32BE(0),r=JSON.parse(b.subarray(4,4+n));b=b.subarray(4+n);
      if(r.cancel&&metadata&&r.cancel===metadata.ticket)setTimeout(()=>{send({...d,ticket:metadata.ticket,body:{...d.body,catalogue_revision:9}});send({...d,ticket:data.ticket,body:{text:data.sources[0].text}});},20);
      else if(r.op==='describe')send({...d,ticket:r.ticket});else if(r.op==='themes.refresh')metadata=r;else if(r.op==='highlight')data=r;
    }});`;
  const transport = new StdioTransport({ command: process.execPath, args: ['-e', program], requestDeadlineMs: 30000, terminateGraceMs: 40 });
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => transport });
  t.after(() => broker.dispose()); await broker.start(); const previous = broker.snapshot(), pid = transport.stats().pid!;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = broker.request(previous.generation, { v: 2, op: 'highlight', ticket: 'data', instance: previous.description!.instance, admission: 'try_now',
    sources: [{ key: 'file:probe', generation: 1, source_version: 1, profile: 'pi', fingerprint: 'a'.repeat(64), hint: { language: 'Plain Text' }, text: 'x' }] }, { deadlineMs: 30000 });
  void data.catch(() => {});
  const refused = assert.rejects(broker.catalogue(previous.generation, 'themes.refresh')); await flush();
  t.mock.timers.tick(PROVIDER_LIMITS.controlMs); await refused; await flush();
  process.kill(pid, 0); assert.equal(transport.stats().childState, 'running'); assert.equal(transport.endReason, undefined);
  assert.deepEqual(broker.snapshot(), previous); assert.equal(transport.stats().unsettledControl, 1);
  assert.equal(transport.stats().unsettledData, 1); assert.equal(transport.stats().liveTimers, 1);
  await assert.rejects(broker.catalogue(previous.generation, 'describe'), { message: 'occipital control unavailable' });
  assert.equal((await data as { body: { text: string } }).body.text, 'x');
  assert.equal(transport.stats().unsettledControl, 0); assert.deepEqual(broker.snapshot(), previous);
  await broker.catalogue(previous.generation, 'describe'); assert.deepEqual(broker.snapshot(), previous);
  assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().ownedAttempts, 1);
  assert.equal(broker.stats().ownedRestarts, 0); assert.equal(transport.stats().spawnCount, 1);
  t.mock.timers.reset(); await broker.dispose(); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(transport.stats().liveTimers, 0); assert.equal(transport.stats().ownedListeners, 0);
});


async function firstTimedOutCatalogueOwner(transport: ProviderTransport) {
  const broker = new ProviderBroker({ tryShared: async () => transport, acquireOwned: async () => { throw Error('unused'); } });
  await broker.start();
  return { weak: new WeakRef(broker), waiting: broker.catalogue(broker.snapshot().generation, 'themes.refresh') };
}
test('completed catalogue waiter releases the first broker while a real adapter retains the unanswered control', { skip: !global.gc }, async t => {
  const held = deferred<unknown>(); let ticket: unknown;
  const transport = new SharedTransport({ connectionFile: '/fixture', identity: { project_root: '/fixture', harness: 'gc', session: 'one' }, initDeadlineMs: 3000, requestDeadlineMs: 30000,
    loadSdk: async () => ({ SubcClient: { connect: async () => ({
      resolveProvider: async () => 'occipital', routeOpen: async () => ({ channel: 7, epoch: 9 }),
      request: (_route, bytes) => { const r = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>; if (r.op === 'describe') return Promise.resolve(descriptor(r.ticket)); ticket = r.ticket; return held.promise; },
      closeRoute: async () => {}, close: () => {},
    }) } }) });
  await transport.ready; t.after(() => transport.close());
  const second = setup(async () => new Transport()); await second.broker.start(); t.after(() => second.broker.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = await firstTimedOutCatalogueOwner(transport), refused = assert.rejects(first.waiting, { message: 'occipital control unavailable' }); await flush();
  t.mock.timers.tick(PROVIDER_LIMITS.controlMs); await refused; await flush(); t.mock.timers.reset();
  assert.equal(transport.stats().unsettledControl, 1); assert.equal(transport.stats().state, 'ready');
  for (let i = 0; i < 100; i++) { await delay(0); global.gc!(); await delay(0); if (!first.weak.deref()) break; }
  assert.equal(first.weak.deref(), undefined); assert.equal(second.broker.snapshot().availability, 'ready');
  held.resolve(catalogueReply(ticket)); await flush(); assert.equal(transport.stats().unsettledControl, 0);
  await transport.close(); await second.broker.dispose(); released(second.broker, second.clock);
});


test('owned stop receipt comes only from successful published-generation close, never shared or failed cleanup', async () => {
  for (const kind of ['owned', 'shared', 'failed'] as const) {
    const transport = new Transport(), clock = new Clock(), receipts: number[] = [], exit = deferred<void>();
    transport.exit = exit.promise;
    const broker = new ProviderBroker({ clock, tryShared: async () => kind === 'shared' ? transport : undefined,
      acquireOwned: async () => transport, onOwnedStopped: generation => receipts.push(generation) });
    await broker.start(); const generation = broker.snapshot().generation;
    const off = broker.setEnabled(false); await flush(); assert.deepEqual(receipts, []);
    if (kind === 'failed') exit.reject(new Error('not reaped')); else exit.resolve();
    await off; await flush();
    assert.deepEqual(receipts, kind === 'owned' ? [generation] : []);
    assert.equal(broker.stats().successfulClassifications, 0);
    await broker.dispose(); assert.deepEqual(receipts, kind === 'owned' ? [generation] : []); released(broker, clock);
  }
});


test('late fulfilled owned close is an old-generation stop receipt, never availability or replacement authority', async () => {
  const owned = new Transport(), clock = new Clock(), exit = deferred<void>(), receipts: number[] = [];
  owned.exit = exit.promise;
  let acquisitions = 0;
  const broker = new ProviderBroker({ clock, tryShared: async () => undefined,
    acquireOwned: async () => { acquisitions++; return owned; }, onOwnedStopped: generation => receipts.push(generation) });
  await broker.start(); const generation = broker.snapshot().generation;
  const off = broker.setEnabled(false); await flush(); await clock.advance(PROVIDER_LIMITS.closeMs); await off;
  assert.deepEqual(receipts, []); assert.equal(broker.stats().closeFailures, 1);
  exit.resolve(); await flush();
  assert.deepEqual(receipts, [generation]); assert.equal(acquisitions, 1);
  assert.equal(broker.snapshot().availability, 'disabled'); assert.equal(broker.stats().successfulClassifications, 0);
  await broker.dispose(); released(broker, clock);
});

test('provider diagnostics: candidate callback is not represented as a shared discovery or connection', async () => {
  const clock = new Clock(), owned = new Transport(), records: { explanation: string; fields?: Record<string, unknown> }[] = [];
  let sharedCallbacks = 0;
  const broker = new ProviderBroker({ clock, diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }),
    tryShared: async () => { sharedCallbacks++; return undefined; }, acquireOwned: async () => owned });
  try {
    await broker.start();
    const callbacks = records.filter(record => record.explanation.includes('candidate callback started'));
    assert.deepEqual(callbacks.map(record => [record.fields?.candidate, record.fields?.stage]), [['shared', 'factory'], ['owned', 'factory']]);
    assert.ok(callbacks.every(record => record.explanation.includes('not proof of discovery or connection')));
    assert.equal(sharedCallbacks, 1); assert.equal(broker.stats().sharedAttempts, 1);
    assert.equal(broker.snapshot().kind, 'owned'); assert.equal(broker.stats().probesScheduled, 0);
  } finally { await broker.dispose(); released(broker, clock); }
});
