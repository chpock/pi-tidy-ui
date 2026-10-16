import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnv, readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { decodeDescription, decodeSources, PROTOCOL_VERSION } from '../../../src/occipital/protocol.ts';

type Source = {
  key: string; lease: string | null; revision: number; source_bytes: number;
  replace_from: number; complete: boolean; styles: unknown[]; runs: number[];
  counters: Record<string, number>;
};
type Profile = { id: string; fingerprint: string };
type Reply = {
  v: number; ticket: string; instance: string; assets: string; status: string;
  error?: { code: string; execution: string };
  body?: { sources?: Source[]; profiles?: Profile[]; category_version?: number; runtime?: { leases: number } };
};
const binary = validateNative(readInputs()).path;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'occipital-native-client-'));
  for (const name of ['home', 'config', 'data', 'cache', 'run']) await mkdir(join(root, name));
  const env = childEnv(root);
  Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run') });
  const transport = new StdioTransport({ command: binary!, args: ['--stdio', '--config', join(root, 'config', 'config.json')], env, cwd: root, requestDeadlineMs: 10_000, terminateGraceMs: 100 });
  let sequence = 0;
  async function call(request: Record<string, unknown>): Promise<Reply> {
    const ticket = `call-${++sequence}`;
    const reply = await transport.request({ ...request, v: PROTOCOL_VERSION, ticket }) as Reply;
    assert.equal(reply.ticket, ticket);
    assert.equal(reply.v, PROTOCOL_VERSION);
    return reply;
  }
  async function close() {
    await transport.close();
    const state = transport.stats();
    assert.equal(state.childState, 'exited');
    assert.equal(state.unsettledData, 0); assert.equal(state.unsettledControl, 0);
    assert.equal(state.retainedBytes, 0); assert.equal(state.liveTimers, 0);
    assert.equal(state.abortListeners, 0); assert.equal(state.ownedListeners, 0);
    await rm(root, { recursive: true, force: true });
  }
  return { transport, call, close };
}

function request(instance: string, profile: Profile, op: string, text: string) {
  return { op, instance, admission: 'bounded_queue', queue_wait_ms: 1000,
    sources: [{ key: 'code', generation: 1, source_version: 1, profile: profile.id,
      fingerprint: profile.fingerprint, hint: { language: 'bash' }, text }] };
}
function append(instance: string, profile: Profile, previous: Source, suffix: string, final: boolean) {
  return { op: 'stream.append', instance, admission: 'bounded_queue', queue_wait_ms: 1000,
    key: 'code', lease: previous.lease, generation: 1, source_version: 2,
    base_revision: previous.revision, base_bytes: previous.source_bytes,
    profile: profile.id, fingerprint: profile.fingerprint, append: suffix, final };
}
function canonical(source: Source): Source {
  let end=source.replace_from;
  const runs:number[]=[];
  for(let i=0;i<source.runs.length;i+=2) {end+=source.runs[i]!;runs.push(end,source.runs[i+1]!);}
  assert.equal(end,source.source_bytes);
  return {...source,runs};
}
function lengths(runs: readonly number[]): number[] {
  let previous=0;
  const result:number[]=[];
  for(let i=0;i<runs.length;i+=2) {result.push(runs[i]!-previous,runs[i+1]!);previous=runs[i]!;}
  return result;
}
function patched(previous: Source, next: Source): number[] {
  const result: number[] = [];
  let start = 0;
  for (let i = 0; i < previous.runs.length && start < next.replace_from; i += 2) {
    result.push(Math.min(previous.runs[i]!, next.replace_from), previous.runs[i + 1]!);
    start = previous.runs[i]!;
  }
  for (let i = 0; i < next.runs.length; i += 2) {
    const end = next.runs[i]!, style = next.runs[i + 1]!;
    if (result.length && result[result.length - 1] === style) result[result.length - 2] = end;
    else result.push(end, style);
  }
  return result;
}

// An explicit compiled product binary is required: fixture helpers cannot satisfy
// these controls. The ordinary JS-only gate does not require a Rust toolchain.
test('actual owned helper preserves compact UTF8 highlighting and incremental work counters', {}, async () => {
  const f = await fixture();
  try {
    const descriptor = await f.call({ op: 'describe' });
    assert.equal(descriptor.status, 'ok');
    assert.equal(descriptor.body!.category_version, 1);
    const negotiated = decodeDescription(descriptor, descriptor.ticket);
    const profile = descriptor.body!.profiles!.find(value => value.id === 'pi')!;
    const prefix = "echo α\necho '";
    const suffix = "value'\n";
    const opened = await f.call(request(descriptor.instance, profile, 'stream.open', prefix));
    assert.equal(opened.status, 'ok');
    const first = opened.body!.sources![0]!;
    const firstDecoded = decodeSources(opened, opened.ticket, negotiated, [{key:'code',generation:1,source_version:1,profile:profile.id,fingerprint:profile.fingerprint,revision:1,source_bytes:Buffer.byteLength(prefix),replace_from:0,complete:false,replacementText:prefix}])[0]!;
    assert.equal(first.counters.committed_line_calls, 1);
    assert.equal(first.counters.tail_calls, 1);
    assert.equal(first.source_bytes, Buffer.byteLength(prefix));
    const appended = await f.call(append(descriptor.instance, profile, first, suffix, true));
    assert.equal(appended.status, 'ok');
    const final = appended.body!.sources![0]!;
    const finalDecoded = decodeSources(appended, appended.ticket, negotiated, [{key:'code',generation:1,source_version:2,profile:profile.id,fingerprint:profile.fingerprint,revision:2,source_bytes:Buffer.byteLength(prefix+suffix),replace_from:firstDecoded.committed_bytes,complete:true,lease:firstDecoded.lease!,replacementText:"echo '"+suffix}])[0]!;
    assert.equal(final.counters.committed_line_calls, 1);
    assert.equal(final.counters.tail_calls, 0);
    assert.equal(final.replace_from, Buffer.byteLength('echo α\n'));
    assert.equal(final.source_bytes, Buffer.byteLength(prefix + suffix));
    assert.equal(final.complete, true);
    const shot = await f.call(request(descriptor.instance, profile, 'highlight', prefix + suffix));
    assert.equal(shot.status, 'ok');
    const complete = shot.body!.sources![0]!;
    const shotDecoded = decodeSources(shot, shot.ticket, negotiated, [{key:'code',generation:1,source_version:1,profile:profile.id,fingerprint:profile.fingerprint,revision:1,source_bytes:Buffer.byteLength(prefix+suffix),replace_from:0,complete:true,replacementText:prefix+suffix}])[0]!;
    assert.deepEqual([...shotDecoded.runs], patched({...first,runs:[...firstDecoded.runs]}, {...final,runs:[...finalDecoded.runs]}));
    assert.equal(complete.counters.committed_line_calls, 2);
    assert.deepEqual(complete.styles, final.styles);
    assert.deepEqual(complete.runs, lengths(patched(canonical(first), canonical(final))));
    const stale = await f.call(append(descriptor.instance, profile, first, 'x', false));
    assert.equal(stale.status, 'error');
    assert.equal(stale.error!.code, 'restart_required');
    assert.equal(stale.error!.execution, 'not_started');
    assert.equal(f.transport.stats().spawnCount, 1);
  } finally { await f.close(); }
});

test('actual owned helper validates whole batches before work and supports independent native profiles', {}, async () => {
  const f = await fixture();
  try {
    const descriptor = await f.call({ op: 'describe' });
    const pi = descriptor.body!.profiles!.find(value => value.id === 'pi')!;
    const native = descriptor.body!.profiles!.find(value => value.id === 'syntect:Nord')!;
    const text = 'echo "literal"\n';
    const plain = await f.call(request(descriptor.instance, pi, 'highlight', text));
    const colored = await f.call(request(descriptor.instance, native, 'highlight', text));
    assert.equal(plain.status, 'ok'); assert.equal(colored.status, 'ok');
    const negotiated = decodeDescription(descriptor, descriptor.ticket);
    for (const [reply,profile] of [[plain,pi],[colored,native]] as const) {
      const chunks = decodeSources(reply,reply.ticket,negotiated,[{key:'code',generation:1,source_version:1,profile:profile.id,fingerprint:profile.fingerprint,revision:1,source_bytes:Buffer.byteLength(text),replace_from:0,complete:true,replacementText:text}]);
      assert.equal(chunks[0]!.runs[chunks[0]!.runs.length-2],Buffer.byteLength(text));
    }
    assert.notDeepEqual(plain.body!.sources![0]!.styles, colored.body!.sources![0]!.styles);
    const batch = request(descriptor.instance, pi, 'stream.open', text);
    batch.sources.push({ ...batch.sources[0]!, key: 'second', fingerprint: 'wrong' });
    const rejected = await f.call(batch);
    assert.equal(rejected.status, 'error');
    assert.equal(rejected.error!.execution, 'not_started');
    assert.equal(Object.hasOwn(rejected, 'body'), false);
    const after = await f.call({ op: 'describe' });
    assert.equal(after.body!.runtime!.leases, 0);
    const largeLine = await f.call(request(descriptor.instance, pi, 'highlight', 'x'.repeat(8193)));
    assert.equal(largeLine.status, 'ok');
    assert.equal(largeLine.body!.sources![0]!.source_bytes, 8193);
    assert.equal(largeLine.body!.sources![0]!.counters.tail_bytes, 8193);
  } finally { await f.close(); }
});

test('actual current helper commits a no-newline tail on one-shot and empty final append without reparsing it', {},async()=> {
  const f=await fixture();
  try {
    const raw=await f.call({op:'describe'}),descriptor=decodeDescription(raw,raw.ticket);
    const profile=descriptor.profiles.find(value=>value.id==='pi')!;
    const text='echo é\nprintf x',bytes=Buffer.byteLength(text);
    const opened=await f.call(request(raw.instance,profile,'stream.open',text));
    const first=decodeSources(opened,opened.ticket,descriptor,[{key:'code',generation:1,source_version:1,revision:1,source_bytes:bytes,replace_from:0,complete:false,profile:profile.id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
    assert.equal(first.committed_bytes,Buffer.byteLength('echo é\n'));
    const ended=await f.call(append(raw.instance,profile,opened.body!.sources![0]!,'',true));
    const final=decodeSources(ended,ended.ticket,descriptor,[{key:'code',generation:1,source_version:2,revision:2,source_bytes:bytes,replace_from:first.committed_bytes,complete:true,profile:profile.id,fingerprint:profile.fingerprint,lease:first.lease!,replacementText:'printf x'}])[0]!;
    assert.equal(final.committed_bytes,bytes);assert.equal(final.lease,first.lease);
    assert.equal(final.counters.committed_line_calls,0);assert.equal(final.counters.tail_calls,0);
    const shot=await f.call(request(raw.instance,profile,'highlight',text));
    const one=decodeSources(shot,shot.ticket,descriptor,[{key:'code',generation:1,source_version:1,revision:1,source_bytes:bytes,replace_from:0,complete:true,profile:profile.id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
    assert.equal(one.committed_bytes,bytes);assert.equal(one.lease,undefined);
    assert.deepEqual([...one.runs],patched({...opened.body!.sources![0]!,runs:[...first.runs]},{...ended.body!.sources![0]!,runs:[...final.runs]}));
  } finally {await f.close();}
});

 test('actual owned helper honors the 64 KiB window, zero-reparse tail growth and native Plain coverage', {},async()=> {
   const f=await fixture();
   try {
     const raw=await f.call({op:'describe'}),descriptor=decodeDescription(raw,raw.ticket);
     assert.equal(descriptor.limits.line_bytes,65536);
     assert.match(descriptor.assets,/line-prefix\/65536\/v1/);
     for(const id of ['pi','syntect:Nord']) {
       const profile=descriptor.profiles.find(value=>value.id===id)!;
       let text='/*'+'a'.repeat(65534);
       const opening=request(raw.instance,profile,'stream.open',text);
       opening.sources[0]!.hint.language='typescript';
       const opened=await f.call(opening);
       assert.equal(opened.status,'ok');
       let prior=opened.body!.sources![0]!;
       let decoded=decodeSources(opened,opened.ticket,descriptor,[{key:'code',generation:1,source_version:1,revision:1,source_bytes:65536,replace_from:0,complete:false,profile:id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
       assert.equal(decoded.counters.tail_calls,1);assert.equal(decoded.counters.tail_bytes,65536);
       let accumulated=[...decoded.runs],version=1;
       for(const [delta,complete] of [['*/',false],['\nconst later = 1;\n',true]] as const) {
         text+=delta;++version;
         const reply=await f.call({...append(raw.instance,profile,prior,delta,complete),source_version:version});
         assert.equal(reply.status,'ok');
         const next=decodeSources(reply,reply.ticket,descriptor,[{key:'code',generation:1,source_version:version,revision:decoded.revision+1,source_bytes:Buffer.byteLength(text),replace_from:decoded.committed_bytes,complete,lease:decoded.lease!,profile:id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
         accumulated=patched({...prior,runs:accumulated},{...reply.body!.sources![0]!,runs:[...next.runs]});
         assert.equal(next.counters.tail_calls,0);assert.equal(next.counters.tail_bytes,0);
         assert.equal(next.counters.committed_line_calls,complete?1:0);
         assert.equal(next.counters.committed_line_bytes,complete?Buffer.byteLength('const later = 1;\n'):0);
         assert.equal(next.source_bytes,Buffer.byteLength(text));
         prior=reply.body!.sources![0]!;decoded=next;
       }
       const whole=request(raw.instance,profile,'highlight',text);
       whole.sources[0]!.hint.language='typescript';
       const reply=await f.call(whole);
       const shot=decodeSources(reply,reply.ticket,descriptor,[{key:'code',generation:1,source_version:1,revision:1,source_bytes:Buffer.byteLength(text),replace_from:0,complete:true,profile:id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
       assert.deepEqual([...shot.runs],accumulated);
       // Packed Plain is zero, distinct from both the Pi comment role and native RGB.
       const plainIndex=[...shot.runs].findIndex((value,index)=>index%2===1&&value===0);
       assert.notEqual(plainIndex,-1);
       assert.equal(shot.runs[plainIndex-3],65536);
       const after=await f.call({op:'describe'});
       assert.equal(after.body!.runtime!.leases,0);
     }
     assert.equal(f.transport.stats().spawnCount,1);
   } finally {await f.close();}
 });

test('actual owned helper accepts above-old-ceiling source and keeps saturated growth work at zero', {},async()=> {
  const f=await fixture();
  try {
    const raw=await f.call({op:'describe'}),descriptor=decodeDescription(raw,raw.ticket);
    assert.equal(descriptor.limits.source_bytes,64<<20);
    assert.equal(descriptor.limits.request_bytes,64<<20);
    assert.equal(descriptor.limits.runs,(64<<20)/4);
    assert.equal(descriptor.limits.styles,4105);
    const profile=descriptor.profiles.find(value=>value.id==='pi')!,text='a'.repeat((1<<20)+1);
    const opening=request(raw.instance,profile,'stream.open',text); opening.sources[0]!.hint.language='text';
    const opened=await f.call(opening); assert.equal(opened.status,'ok');
    const first=decodeSources(opened,opened.ticket,descriptor,[{key:'code',generation:1,source_version:1,revision:1,source_bytes:text.length,replace_from:0,complete:false,profile:profile.id,fingerprint:profile.fingerprint,replacementText:text}])[0]!;
    assert.equal(first.counters.tail_bytes,65536); assert.equal(first.runs.at(-2),text.length);
    const ended=await f.call(append(raw.instance,profile,opened.body!.sources![0]!,'tail',true));
    assert.equal(ended.status,'ok');
    const final=decodeSources(ended,ended.ticket,descriptor,[{key:'code',generation:1,source_version:2,revision:2,source_bytes:text.length+4,replace_from:0,complete:true,lease:first.lease!,profile:profile.id,fingerprint:profile.fingerprint,replacementText:text+'tail'}])[0]!;
    assert.equal(final.counters.tail_calls,0); assert.equal(final.counters.committed_line_calls,0);
    assert.equal(final.runs.at(-2),text.length+4);
    const after=await f.call({op:'describe'}); assert.equal(after.body!.runtime!.leases,0);
    assert.equal(f.transport.stats().spawnCount,1);
  } finally {await f.close();}
});
