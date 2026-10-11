import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDescription, decodeSources, decodeClosed, unpackStyle, ProtocolError, RemoteFault, type ExpectedSource } from '../src/occipital/protocol.ts';

const fingerprint = 'a'.repeat(64);
const envelope = (body: unknown) => ({v:2,ticket:'t',instance:'instance',assets:'assets',status:'ok',body});
function description() {
  return envelope({kind:'descriptor',backend_version:'0.1.0',protocol_version:2,category_version:1,assets:'assets',capability:'syntax-highlight/v2',service:'syntax',operations:['describe','themes.refresh','highlight','stream.open','stream.append','stream.close'],modes:['one_shot','growing'],admission:['try_now','bounded_queue'],catalogue_revision:0,profiles:[{id:'pi',label:'Pi palette',fingerprint},{id:'syntect:Nord',label:'Nord',fingerprint}],diagnostic:null,runtime:{pid:1,routes:1,leases:0,data_bytes:0,data_jobs:0,queued:0,control_bytes:0,control_jobs:0},limits:{request_bytes:2097152,reply_bytes:2097152,control_request_bytes:4096,control_reply_bytes:32768,source_bytes:1048576,line_bytes:8192,batch_sources:8,queue_wait_ms:1000,state_pool_bytes:2097152,leases:32,leases_per_route:4,runs:131072,styles:512,idle_ms:60000,age_ms:300000,quantum_ms:2,data_per_route:2,control_per_route:1,routes:8,workers:2}});
}
function source() {
  return {key:'code',generation:1,source_version:2,complete:false,lease:'lease',revision:2,source_bytes:6,committed_bytes:3,replace_from:3,profile:'pi',fingerprint,styles:[{role:'syntaxString'}],runs:[3,0],counters:{committed_line_calls:0,committed_line_bytes:0,tail_calls:1,tail_bytes:3}};
}
function expected(): ExpectedSource {
  return {key:'code',generation:1,source_version:2,complete:false,lease:'lease',revision:2,source_bytes:6,replace_from:3,profile:'pi',fingerprint,replacementText:'éx'};
}
const desc = () => decodeDescription(description(),'t');
const packet = (value: unknown = source()) => envelope({kind:'source',sources:[value]});

test('descriptor validates actual negotiated modes, profiles, identities and bounded limits', () => {
  const d = desc();
  assert.equal(d.instance,'instance');assert.equal(d.assets,'assets');assert.equal(d.limits.runs,131072);
  assert.deepEqual(d.profiles.map(p=>p.id),['pi','syntect:Nord']);
  assert.equal(d.backend_version,'0.1.0');assert.equal(d.runtime.data_bytes,0);assert.equal(d.catalogue_revision,0);
});
for(const field of ['protocol_version','category_version','capability','service','assets','modes','operations','admission','profiles','limits','catalogue_revision'] as const) test(`invalid descriptor ${field} is rejected, never negotiated from partial data`, () => {
  const value = description();
  const body = value.body as Record<string,unknown>;
  body[field] = field==='limits'?{...body.limits as object,source_bytes:0}:field==='profiles'?[]:field==='catalogue_revision'?Number.MAX_SAFE_INTEGER+1:null;
  assert.throws(()=>decodeDescription(value,'t'),ProtocolError);
});
test('duplicate profiles, bad fingerprints, excessive metadata and asset disagreement are rejected', () => {
  for(const mutate of [(body:any)=>body.profiles.push(body.profiles[0]),(body:any)=>body.profiles[0].fingerprint='bad',(body:any)=>body.profiles[0].label='x'.repeat(129),(body:any)=>body.diagnostic='x'.repeat(257)]) {
    const value=description();mutate(value.body);assert.throws(()=>decodeDescription(value,'t'),ProtocolError);
  }
  assert.throws(()=>decodeDescription({...description(),assets:'changed'},'t'),ProtocolError);
  assert.throws(()=>decodeDescription(description(),'another'),ProtocolError);
});
test('native errors preserve no-start versus started without fabricating source acknowledgment', () => {
  for(const execution of ['not_started','started']) {
    assert.throws(()=>decodeSources({v:2,ticket:'t',instance:'instance',assets:'assets',status:'error',error:{code:'busy',execution}},'t',desc(),[expected()]),(e:unknown)=>e instanceof RemoteFault && e.code==='busy'&&e.execution===execution);
  }
  assert.throws(()=>decodeSources({...packet(),instance:'new-instance'},'t',desc(),[expected()]),(e:unknown)=>e instanceof ProtocolError&&e.code==='provider_changed');
});
test('compact source suffix becomes bounded packed owned ranges with exact UTF8 coverage', () => {
  const result=decodeSources(packet(),'t',desc(),[expected()]);
  assert.equal(result.length,1);assert.equal(result[0]!.runs.byteLength,8);
  assert.equal(result[0]!.runs[0],6);assert.deepEqual(unpackStyle(result[0]!.runs[1]!),{role:'syntaxString'});
  assert.equal(result[0]!.replace_from,3);assert.equal(result[0]!.lease,'lease');
  assert.equal(result[0]!.counters.tail_bytes,3);
});
for(const change of [
  {key:'wrong'},{generation:2},{source_version:3},{revision:1},{source_bytes:7},{replace_from:0},{fingerprint:'b'.repeat(64)},{profile:'syntect:Nord'},{complete:true},{lease:'other'},
  {runs:[1,0,2,0]},{runs:[2,1,1,0]},{runs:[3]},{runs:[2,0]},{runs:[3.5,0]},{runs:[3,-1]},{committed_bytes:2},{committed_bytes:7},{styles:[{role:'unknown'}]},{styles:[{role:'syntaxString',rgb:[1,2,3]}]},
  {counters:{committed_line_calls:-1,committed_line_bytes:0,tail_calls:0,tail_bytes:0}},
]) test(`source shape/identity/UTF8 disagreement is rejected: ${JSON.stringify(change)}`,()=> {
  assert.throws(()=>decodeSources(packet({...source(),...change}),'t',desc(),[expected()]),ProtocolError);
});
test('each style kind/attribute survives without terminal escape or palette guessing',()=> {
  const styles=[{rgb:[255,0,128],attributes:7},{index:255,attributes:3},{terminal_default:true,attributes:0}];
  const s={...source(),profile:'syntect:Nord',source_bytes:6,styles,runs:[1,0,1,1,1,2]};
  const e={...expected(),profile:'syntect:Nord',replacementText:'abc'};
  const output=decodeSources(packet(s),'t',desc(),[e])[0]!;
  assert.deepEqual([1,3,5].map(i=>unpackStyle(output.runs[i]!)),styles);
  for(const style of [{rgb:[256,0,0],attributes:0},{rgb:[0,0,0],attributes:8},{index:-1,attributes:0},{terminal_default:false,attributes:0},{role:'syntaxString'}]) {
    assert.throws(()=>decodeSources(packet({...s,styles:[style],runs:[3,0]}),'t',desc(),[e]),ProtocolError);
  }
});
test('batch match is exact and atomic; duplicate or missing sources are not partial output',()=> {
  const first=source(),second={...source(),key:'second'};
  const demand=[expected(),{...expected(),key:'second'}];
  const body={kind:'source',sources:[second,first]};
  assert.deepEqual(decodeSources(envelope(body),'t',desc(),demand).map(s=>s.key),['code','second']);
  for(const sources of [[first],[first,first],[first,{...second,runs:[1,0,2,0]}]])assert.throws(()=>decodeSources(envelope({kind:'source',sources}),'t',desc(),demand),ProtocolError);
});
test('empty complete source and no-suffix finalization have no artificial range or lease',()=> {
  const value={...source(),complete:true,revision:1,source_bytes:0,committed_bytes:0,replace_from:0,styles:[],runs:[],counters:{committed_line_calls:0,committed_line_bytes:0,tail_calls:0,tail_bytes:0}} as Record<string,unknown>;delete value.lease;
  const demand={...expected(),complete:true,revision:1,source_bytes:0,replace_from:0,replacementText:''};delete demand.lease;
  assert.equal(decodeSources(packet(value as ReturnType<typeof source>),'t',desc(),[demand])[0]!.runs.length,0);
  const finish={...value,source_bytes:6,committed_bytes:6,replace_from:6};
  assert.equal(decodeSources(packet(finish as ReturnType<typeof source>),'t',desc(),[{...demand,source_bytes:6,replace_from:6}])[0]!.runs.length,0);
  assert.throws(()=>decodeSources(packet({...source(),complete:true,lease:'wrong'}),'t',desc(),[{...expected(),complete:true}]),ProtocolError);
});
test('close acknowledgment is source-free and provider-bound',()=> {
  decodeClosed(envelope({kind:'closed'}),'t',desc());
  assert.throws(()=>decodeClosed(envelope({kind:'source',sources:[]}), 't',desc()),ProtocolError);
  assert.throws(()=>decodeClosed({...envelope({kind:'closed'}),assets:'changed'},'t',desc()),ProtocolError);
});

test('server-owned timing and resource limits are preserved, not fabricated by client allocation caps',()=> {
  const value=description(),body=value.body as {limits:Record<string,number>};
  body.limits.age_ms=900000;body.limits.quantum_ms=10;body.limits.source_bytes=2097152;body.limits.runs=262144;
  const d=decodeDescription(value,'t');
  assert.equal(d.limits.age_ms,900000);assert.equal(d.limits.quantum_ms,10);assert.equal(d.limits.source_bytes,2097152);
  assert.throws(()=>decodeSources(packet({...source(),runs:Array(262146).fill(6)}),'t',d,[expected()]),ProtocolError);
});
test('replacement context must itself be coherent Unicode, not silently replaced while checking byte offsets',()=> {
  assert.throws(()=>decodeSources(packet(),'t',desc(),[{...expected(),replacementText:'\ud800'}]),ProtocolError);
});

test('final append acknowledges its ended lease and commits the existing tail without adding a newline',()=> {
  const value={...source(),complete:true,committed_bytes:6};
  const result=decodeSources(packet(value),'t',desc(),[{...expected(),complete:true}])[0]!;
  assert.equal(result.complete,true);assert.equal(result.lease,'lease');assert.equal(result.committed_bytes,6);
  assert.equal(result.source_bytes,6);
  const oneShot={...value,source_bytes:3,replace_from:0,committed_bytes:3,runs:[3,0]} as Record<string,unknown>;delete oneShot.lease;
  const demand={...expected(),complete:true,source_bytes:3,replace_from:0};delete demand.lease;
  assert.equal(decodeSources(packet(oneShot),'t',desc(),[demand])[0]!.committed_bytes,3);
});

test('parser commitment is semantic progress, not just a valid UTF8 character boundary',()=> {
  assert.throws(()=>decodeSources(packet({...source(),committed_bytes:5}),'t',desc(),[expected()]),ProtocolError);
  assert.throws(()=>decodeSources(packet({...source(),complete:true}),'t',desc(),[{...expected(),complete:true}]),ProtocolError);
  const demand={...expected(),source_bytes:7,replacementText:'é\nx'};
  assert.equal(decodeSources(packet({...source(),source_bytes:7,committed_bytes:6,runs:[4,0]}),'t',desc(),[demand])[0]!.committed_bytes,6);
  assert.throws(()=>decodeSources(packet({...source(),source_bytes:7,committed_bytes:3,runs:[4,0]}),'t',desc(),[demand]),ProtocolError);
});
test('aggregate source admission happens before any owned range allocation',()=> {
  const text='a'.repeat(524289),profile=desc();
  const a={...source(),source_bytes:text.length,replace_from:0,committed_bytes:text.length,complete:true,runs:[text.length,0]} as Record<string,unknown>;delete a.lease;
  const b={...a,key:'second'};
  const demand={...expected(),source_bytes:text.length,replace_from:0,complete:true,replacementText:text};delete demand.lease;
  const Original=globalThis.Uint32Array;let allocations=0;
  globalThis.Uint32Array=new Proxy(Original,{construct(target,args,newTarget){allocations++;return Reflect.construct(target,args,newTarget);}});
  try {assert.throws(()=>decodeSources({...packet(a),body:{kind:'source',sources:[a,b]}},'t',profile,[demand,{...demand,key:'second'}]),ProtocolError);assert.equal(allocations,0);}
  finally {globalThis.Uint32Array=Original;}
});


test('JSON v2 length/style pairs reconstruct canonical absolute UTF8 ranges',()=> {
  const descriptor={...description(),v:2,body:{...(description().body as object),protocol_version:2,capability:'syntax-highlight/v2'}};
  const profile=decodeDescription(descriptor,'t');
  const value={...source(),styles:[{role:'syntaxString'},{role:'plain'}],runs:[2,0,1,1]};
  const reply={...packet(value),v:2};
  const result=decodeSources(reply,'t',profile,[expected()])[0]!;
  assert.deepEqual([result.runs[0],result.runs[2]],[5,6]);
  assert.deepEqual([unpackStyle(result.runs[1]!),unpackStyle(result.runs[3]!)],[{role:'syntaxString'},{role:'plain'}]);
  assert.equal(result.replace_from,3);assert.equal(result.source_bytes,6);
});

test('old endpoint-format peers cannot negotiate as length-format peers',()=> {
  assert.throws(()=>decodeDescription({...description(),v:1,body:{...(description().body as object),protocol_version:1,capability:'syntax-highlight/v1'}},'t'),ProtocolError);
});


test('invalid later source rejects the whole batch before allocating any owned range vector',()=> {
  const original=globalThis.Uint32Array;
  let allocations=0;
  class Observed extends original {constructor(length:number) {super(length);allocations++;}}
  globalThis.Uint32Array=Observed as typeof Uint32Array;
  try {
    const descriptor=decodeDescription(description(),'t');
    const other={...expected(),key:'other'};
    for(const malformed of [{runs:[1,0,2,0]},{styles:[{role:'unknown'}]}]) {
      allocations=0;
      const second={...source(),key:'other',...malformed};
      assert.throws(()=>decodeSources(envelope({kind:'source',sources:[source(),second]}),'t',descriptor,[expected(),other]),ProtocolError);
      assert.equal(allocations,0,'a rejected batch must not materialize its valid first source');
    }
  } finally {globalThis.Uint32Array=original;}
});

 test('native profiles permit explicit plain coverage but not Pi syntax-role colors',()=> {
   const value={...source(),profile:'syntect:Nord',styles:[{rgb:[120,130,140],attributes:2},{role:'plain'}],runs:[2,0,1,1]};
   const e={...expected(),profile:'syntect:Nord'};
   const [chunk]=decodeSources(packet(value),'t',desc(),[e]);
   assert.deepEqual(unpackStyle(chunk!.runs[1]!),{rgb:[120,130,140],attributes:2});
   assert.deepEqual(unpackStyle(chunk!.runs[3]!),{role:'plain'});
   for(const role of ['syntaxComment','syntaxString','syntaxKeyword']) {
     assert.throws(()=>decodeSources(packet({...value,styles:[value.styles[0],{role}]}),'t',desc(),[e]),ProtocolError);
   }
 });

// Large absolute positions need only the changed suffix, not a copied prefix.
test('two 32 MiB source positions admit exact three-byte patches without prefix allocation', () => {
  const d=desc(); d.limits.source_bytes=64<<20; d.limits.runs=(64<<20)/4;
  const size=32<<20;
  const demands=['left','right'].map(key=>({...expected(),key,source_bytes:size,replace_from:size-3,replacementText:'xyz'}));
  const sources=demands.map(item=>({...source(),key:item.key,source_bytes:size,replace_from:size-3,committed_bytes:size-3}));
  const chunks=decodeSources(envelope({kind:'source',sources}),'t',d,demands);
  assert.equal(chunks.length,2);
  for(const chunk of chunks) { assert.equal(chunk.runs.byteLength,8); assert.equal(chunk.runs[0],size); }
});

test('native palettes support admitted foreground/font combinations above 512 output styles', () => {
  const d=desc(); d.limits.styles=4105;
  const profile='custom:combinations'; d.profiles=[...d.profiles,{id:profile,label:'Compound fonts',fingerprint}];
  // 75 admitted foregrounds x all eight font-bit combinations, not 600 colors.
  const styles=Array.from({length:600},(_,i)=>({rgb:[i>>3,0,0],attributes:i%8}));
  const value={...source(),profile,styles};
  const [chunk]=decodeSources(packet(value),'t',d,[{...expected(),profile}]);
  assert.deepEqual(unpackStyle(chunk!.runs[1]!),styles[0]);
});
