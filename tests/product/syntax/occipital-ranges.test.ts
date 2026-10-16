import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RangeAccumulator } from '../../../src/occipital/ranges.ts';
import type { SourceChunk } from '../../../src/occipital/protocol.ts';
const chunk=(change:Partial<SourceChunk>={}):SourceChunk=>({key:'code',generation:1,source_version:1,revision:1,profile:'pi',fingerprint:'a'.repeat(64),lease:'lease',complete:false,source_bytes:5,committed_bytes:2,replace_from:0,runs:new Uint32Array([2,2,5,3]),counters:{committed_line_calls:1,committed_line_bytes:2,tail_calls:1,tail_bytes:3},...change});
function spans(value:RangeAccumulator) {const result:number[][]=[];value.visit((start,end,style)=>result.push([start,end,style]));return result;}
test('immutable committed chunks survive replacement of only the acknowledged provisional tail',()=> {
  const value=new RangeAccumulator();assert.equal(value.apply(chunk()),true);
  assert.deepEqual(spans(value),[[0,2,2],[2,5,3]]);
  assert.equal(value.apply(chunk({revision:2,source_version:2,replace_from:2,source_bytes:8,committed_bytes:4,runs:new Uint32Array([4,7,8,3])})),true);
  assert.deepEqual(spans(value),[[0,2,2],[2,4,7],[4,8,3]]);
  assert.equal(value.stats().prefixCopiedBytes,0);assert.equal(value.stats().committedChunks,2);
  assert.equal(value.stats().tailBytes,8);
});
test('source palette objects and mutable response arrays are not retained aliases',()=> {
  const source=chunk(),value=new RangeAccumulator();value.apply(source);source.runs.fill(0);
  assert.deepEqual(spans(value),[[0,2,2],[2,5,3]]);
});
test('finalization keeps exact coverage, discards provisional storage and refuses subsequent mutation',()=> {
  const value=new RangeAccumulator();value.apply(chunk());
  value.apply(chunk({revision:2,source_version:2,replace_from:2,committed_bytes:5,complete:true,runs:new Uint32Array([5,3])}));
  assert.deepEqual(spans(value),[[0,2,2],[2,5,3]]);
  assert.equal(value.stats().complete,true);assert.equal(value.stats().tailBytes,0);
  assert.throws(()=>value.apply(chunk({revision:3,replace_from:2})),/state/);
});
for(const change of [{revision:3},{generation:2},{source_version:0},{replace_from:1},{profile:'native'},{fingerprint:'b'.repeat(64)},{lease:'wrong'},{source_bytes:1}] as Partial<SourceChunk>[])test(`ack mismatch never mutates retained coverage: ${JSON.stringify(change)}`,()=> {
  const value=new RangeAccumulator();value.apply(chunk());const before=spans(value);
  assert.throws(()=>value.apply(chunk({revision:2,replace_from:2,...change})),/state/);
  assert.deepEqual(spans(value),before);
});
test('payload admission precedes allocation; losing required coverage makes late suffixes unusable',()=> {
  const value=new RangeAccumulator();value.apply(chunk());
  assert.equal(value.apply(chunk({revision:2,replace_from:2}),0),false);
  assert.equal(value.stats().retainedBytes,0);assert.deepEqual(spans(value),[]);
  assert.throws(()=>value.apply(chunk({revision:2,replace_from:2})),/state/);
});
test('empty one-shot and empty final suffix add no artificial range or committed chunk',()=> {
  const empty=new RangeAccumulator();empty.apply(chunk({source_bytes:0,committed_bytes:0,runs:new Uint32Array(),complete:true,lease:undefined}));
  assert.deepEqual(spans(empty),[]);assert.equal(empty.stats().committedChunks,0);
  const done=new RangeAccumulator();done.apply(chunk({source_bytes:2,committed_bytes:2,runs:new Uint32Array([2,2])}));
  done.apply(chunk({revision:2,replace_from:2,source_bytes:2,committed_bytes:2,runs:new Uint32Array(),complete:true}));
  assert.deepEqual(spans(done),[[0,2,2]]);
});
test('many small committed chunks account finite metadata allowance without prefix vector copies',()=> {
  const value=new RangeAccumulator();
  for(let i=0;i<1000;i++)assert.equal(value.apply(chunk({revision:i+1,source_version:i+1,replace_from:i,source_bytes:i+1,committed_bytes:i+1,runs:new Uint32Array([i+1,i%10])})),true);
  assert.equal(value.stats().committedChunks,1000);assert.equal(value.stats().prefixCopiedBytes,0);
  assert.ok(value.stats().retainedBytes>=1000*8);assert.equal(spans(value).length,1000);
  value.invalidate();assert.equal(value.stats().retainedBytes,0);
});

test('prospective size shares exact mutation accounting without allocating ranges or mutating state', t => {
  const value=new RangeAccumulator(),first=chunk();
  const allocations=t.mock.method(globalThis,'Uint32Array',function(){throw new Error('unexpected range allocation');});
  assert.equal(value.requiredBytes(first),1040);
  assert.equal(value.requiredBytes(first),1040);
  assert.equal(allocations.mock.calls.length,0);
  assert.equal(value.stats().retainedBytes,0);
  assert.deepEqual(spans(value),[]);
  allocations.mock.restore();
  const required=value.requiredBytes(first);
  assert.equal(value.apply(first,required),true);
  assert.equal(value.stats().retainedBytes,required);
  const next=chunk({revision:2,source_version:2,replace_from:2,source_bytes:8,committed_bytes:4,runs:new Uint32Array([4,7,8,3])});
  const before=spans(value),subsequent=value.requiredBytes(next);
  assert.deepEqual(spans(value),before);
  assert.equal(value.apply(next,subsequent),true);
  assert.equal(value.stats().retainedBytes,subsequent);
});

test('prospective size rejects stale and lost state without changing pressure invalidation',()=>{
  const value=new RangeAccumulator(),first=chunk();
  value.apply(first);
  const before=spans(value);
  assert.throws(()=>value.requiredBytes(first),/state mismatch/);
  assert.deepEqual(spans(value),before);
  const next=chunk({revision:2,source_version:2,replace_from:2});
  const required=value.requiredBytes(next);
  assert.equal(value.apply(next,required-1),false);
  assert.equal(value.stats().retainedBytes,0);
  assert.throws(()=>value.requiredBytes(next),/state mismatch/);
});

test('range bookkeeping accepts the global allowance without allocating its advertised capacity',()=> {
  const value=new RangeAccumulator();
  assert.equal(value.apply(chunk(),1<<30),true);
  assert.equal(value.stats().retainedBytes,1040);
  assert.deepEqual(spans(value),[[0,2,2],[2,5,3]]);
});

test('display effect compares normalized touched spans, not completion metadata or parser counters', () => {
  const value = new RangeAccumulator(); value.apply(chunk());
  const initial = value.stats().displayRevision;
  value.apply(chunk({ revision: 2, replace_from: 2, committed_bytes: 5, complete: true,
    runs: new Uint32Array([3, 3, 5, 3]), counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }));
  assert.equal(value.stats().displayRevision, initial, 'Adjacent equal style spans and finalized tail have identical effect');
  const changed = new RangeAccumulator(); changed.apply(chunk());
  changed.apply(chunk({ revision: 2, replace_from: 2, committed_bytes: 5, complete: true,
    runs: new Uint32Array([5, 4]), counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }));
  assert.notEqual(changed.stats().displayRevision, initial, 'Zero work counters do not prove style equality');
});
