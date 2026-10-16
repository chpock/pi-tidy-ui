import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { StdioTransport, STDIO_LIMITS } from '../../../src/occipital/stdio.ts';

const fixture = fileURLToPath(new URL('../../fixtures/occipital-stdio.mjs', import.meta.url));
// Keep boundary/backpressure controls scaled rather than moving 64 MiB per case.
const fixtureDataBytes=2*1024*1024;
const fixtureRetainedBytes=2*(2*fixtureDataBytes+STDIO_LIMITS.cancelBytes+8)
  +STDIO_LIMITS.controlRequestBytes+STDIO_LIMITS.controlReplyBytes+STDIO_LIMITS.cancelBytes+8;
function peer(mode = 'echo', requestDeadlineMs = 3000, terminateGraceMs = 40) {
  return new StdioTransport({ command: process.execPath, args: [fixture, mode], requestDeadlineMs, terminateGraceMs, dataBytes:fixtureDataBytes });
}
function data(ticket: string, text = '') { return { v: 2 as const, ticket, op: 'highlight' as const, text }; }
function control(ticket: string) { return { v: 2 as const, ticket, op: 'describe' as const }; }
function body(reply: unknown): Record<string, unknown> { return (reply as { body: Record<string, unknown> }).body; }
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('observable state did not arrive');
}
function gone(pid: number) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }
function empty(transport: StdioTransport) {
  const s = transport.stats();
  assert.equal(s.childState, 'exited');
  assert.equal(s.unsettledData, 0);
  assert.equal(s.unsettledControl, 0);
  assert.equal(s.retainedBytes, 0);
  assert.equal(s.queuedFrames, 0);
  assert.equal(s.liveTimers, 0);
  assert.equal(s.abortListeners, 0);
  assert.equal(s.ownedListeners, 0);
}

for (const mode of ['reverse', 'chunks']) test(`correlates reversed ${mode} packets from one persistent subprocess`, async t => {
  const p = peer(mode); t.after(() => p.close());
  const first = p.request(data('a', 'é\t🙂\r\n\u0000'));
  const second = p.request(data('b', 'other'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(body(a).text, 'é\t🙂\r\n\u0000');
  assert.equal(body(b).text, 'other');
  assert.equal(body(a).pid, body(b).pid);
  assert.equal(body(b).sequence, 1);
  assert.equal(body(a).bytes, Buffer.byteLength('é\t🙂\r\n\u0000'));
  assert.equal(p.stats().spawnCount, 1);
  await p.close(); empty(p);
});

test('two held data calls reserve their slots while metadata has its own lane', async t => {
  const p = peer('hold'); t.after(() => p.close());
  const a = p.request(data('a')); const b = p.request(data('b'));
  assert.equal(p.stats().unsettledData, 2);
  assert.ok(p.stats().retainedBytes > 4 * 1024 * 1024);
  await assert.rejects(p.request(data('c')), /capacity/);
  const c = p.request(control('inspect'));
  assert.equal(p.stats().unsettledControl, 1);
  await assert.rejects(p.request(control('extra')), /capacity/);
  await c;
  await p.request(control('release'));
  await Promise.all([a, b]);
  assert.equal(p.stats().retainedBytes, 0);
  await p.close(); empty(p);
});

test('abort sends transport cancel, keeps settlement/credit, and leaves another call alive', async t => {
  const p = peer('late'); t.after(() => p.close());
  const abort = new AbortController();
  let settled = false;
  const a = p.request(data('first'), { signal: abort.signal });
  const rejected = assert.rejects(a, /aborted/).then(() => { settled = true; });
  const b = p.request(data('second', 'unaffected'));
  const credit = p.stats().retainedBytes;
  abort.abort(); abort.abort();
  assert.equal(p.stats().unsettledData, 2);
  assert.ok(p.stats().retainedBytes >= credit);
  await assert.rejects(p.request(data('third')), /capacity/);
  const report = await p.request(control('inspection'));
  assert.deepEqual(body(report).cancelled, ['first']);
  assert.equal(settled, false);
  await rejected;
  assert.equal(p.stats().unsettledData, 1);
  const afterSettlement = p.request(data('third', 'slot reused after actual reply'));
  assert.equal(p.stats().unsettledData, 2);
  assert.equal(body(await b).text, 'unaffected');
  assert.equal(body(await afterSettlement).text, 'slot reused after actual reply');
  assert.equal(p.stats().retainedBytes, 0);
  await p.close(); empty(p);
});

test('already aborted requests never reserve/write; active duplicate tickets never dispatch', async t => {
  const p = peer('hold'); t.after(() => p.close());
  const abort = new AbortController(); abort.abort();
  await assert.rejects(p.request(data('unused'), { signal: abort.signal }), /aborted/);
  assert.equal(p.stats().unsettledData, 0);
  const a = p.request(data('same'));
  await assert.rejects(p.request(control('same')), /ticket/);
  await p.request(control('release')); await a;
});

test('real slow reader/backpressure bounds outbound frames and preserves content bytes', async t => {
  const p = peer('slow'); t.after(() => p.close());
  const text = 'é🙂\n'.repeat(220000);
  const a = p.request(data('a', text)); const b = p.request(data('b', text));
  await assert.rejects(p.request(data('overflow')), /capacity/);
  assert.ok(p.stats().retainedBytes <= fixtureRetainedBytes);
  await eventually(() => p.stats().backpressureEvents > 0);
  const c = p.request(control('metadata'));
  assert.ok(p.stats().queuedFrames <= 3);
  const expected = createHash('sha256').update(text).digest('hex');
  for (const reply of await Promise.all([a, b])) {
    assert.equal(body(reply).hash, expected);
    assert.equal(body(reply).bytes, Buffer.byteLength(text));
  }
  await c;
  assert.equal(p.stats().spawnCount, 1);
  await p.close(); empty(p);
});

test('request bounds are UTF8/escaped JSON bytes; malformed headers are local refusals', async t => {
  const p = peer(); t.after(() => p.close());
  for (const ticket of ['', 'x'.repeat(65), '🙂'.repeat(17), 'a\u0085b', 'a\nb', '\ud800']) {
    await assert.rejects(p.request(data(ticket)), /request/);
  }
  await assert.rejects(p.request({ ...data('v'), v: 1 }), /request/);
  await assert.rejects(p.request({ ...data('op'), op: 'cancel' }), /request/);
  await assert.rejects(p.request(data('huge', '🙂'.repeat(600000))), /limit/);
  await assert.rejects(p.request(data('escaped', '\u0000'.repeat(400000))), /limit/);
  await assert.rejects(p.request({ ...control('huge-control'), text: 'x'.repeat(4096) }), /limit/);
  const cyclic: Record<string, unknown> = data('cycle'); cyclic.self = cyclic;
  await assert.rejects(p.request(cyclic), /request/);
  const hook = Object.defineProperty(data('hook'), 'toJSON', { value: () => 'private text' });
  await assert.rejects(p.request(hook), /JSON hook/);
  const getter = Object.defineProperty(data('getter'), 'v', { get() { throw new Error('stdio private source'); } });
  await assert.rejects(p.request(getter), { message: 'stdio invalid request JSON' });
  assert.equal(p.stats().unsettledData, 0);
  const r = await p.request(data('🙂'.repeat(16), 'exact'));
  assert.equal(body(r).text, 'exact');
});

test('deadline retires whole helper, waits for ignored SIGTERM kill/reap, settles all calls at exit', async t => {
  const p = peer('ignore-term', 3000, 120); t.after(() => p.close());
  const pid = body(await p.request(control('ready'))).pid as number;
  let settled = 0;
  const a = p.request(data('a'), { deadlineMs: 30 });
  const b = p.request(data('b'));
  const outcomes = [a, b].map(r => assert.rejects(r, /deadline/).then(() => { settled++; }));
  await eventually(() => p.stats().childState === 'retiring');
  assert.equal(settled, 0); assert.equal(p.stats().unsettledData, 2);
  assert.equal(p.stats().liveTimers, 1);
  assert.equal(p.stats().abortListeners, 0);
  process.kill(pid, 0);
  await Promise.all(outcomes); gone(pid);
  await p.close(); empty(p);
  await assert.rejects(p.request(data('no-respawn')), /retired/);
  assert.equal(p.stats().spawnCount, 1);
});

for (const mode of ['zero', 'oversize', 'truncated-header', 'truncated-body', 'eof', 'utf8', 'json', 'unknown', 'version', 'instance', 'assets', 'status', 'missing-body', 'reply-ticket-control', 'error-body', 'control-oversize']) {
  test(`retires/reaps safely on ${mode}`, async t => {
    const p = peer(mode); t.after(() => p.close());
    const request = mode === 'control-oversize' ? control('a') : data('a');
    await assert.rejects(p.request(request), mode === 'reply-ticket-control'
      ? { message: 'stdio invalid reply header' } : /stdio/);
    await p.close(); empty(p);
    if (p.stats().pid) gone(p.stats().pid!);
    await assert.rejects(p.request(data('later')), /retired/);
  });
}

test('a duplicate settled response retires without settling another call as that ticket', async t => {
  const p = peer('duplicate'); t.after(() => p.close());
  const a = p.request(data('a')); const b = p.request(data('b'));
  const failure = assert.rejects(b, /correlation/);
  assert.equal(body(await a).bytes, 0);
  await failure; await p.close(); empty(p);
});

test('instance reset on a live pipe remains an application/header identity, not transport loss', async t => {
  const p = peer('changed-instance'); t.after(() => p.close());
  const a = await p.request(control('first'));
  const b = await p.request(control('second'));
  assert.notEqual((a as {instance: string}).instance, (b as {instance: string}).instance);
  assert.equal(p.stats().childState, 'running');
});

test('typed native no-start error remains an unknown structured application reply', async t => {
  const p = peer('application-error'); t.after(() => p.close());
  const r = await p.request(data('a'));
  assert.deepEqual(r, { v: 2, ticket: 'a', instance: 'fixture-instance', assets: 'fixture-assets', status: 'error', error: { code: 'busy', execution: 'not_started' } });
  assert.equal(p.stats().childState, 'running');
});

test('broken input pipe retires and stderr is drained without exposing its private text', async t => {
  const p = peer('pipe-error'); t.after(() => p.close());
  await p.request(control('ready'));
  await assert.rejects(p.request(data('large', 'x'.repeat(1000000))), /stdio/);
  await p.close(); empty(p);
  const stderr = peer('stderr'); t.after(() => stderr.close());
  await stderr.request(control('ready'));
  assert.ok(stderr.stats().stderrBytes > 0);
  await stderr.close(); empty(stderr);
});

test('missing spawn and idempotent close remove owned listeners/timers and reject only at termination', async t => {
  const missing = new StdioTransport({ command: '/nonexistent/occipital', requestDeadlineMs: 1000, terminateGraceMs: 20 });
  t.after(() => missing.close());
  await assert.rejects(missing.request(control('a')), /stdio/);
  await missing.close(); empty(missing);
  const p = peer('ignore-term', 3000, 80); t.after(() => p.close());
  const pid = body(await p.request(control('ready'))).pid as number;
  const abort = new AbortController();
  const a = p.request(data('held'), { signal: abort.signal });
  const failure = assert.rejects(a, /closed/);
  const first = p.close(); const second = p.close();
  assert.equal(first, second);
  assert.equal(p.stats().unsettledData, 1);
  await first; await failure; gone(pid); empty(p);
  abort.abort(); await p.close(); empty(p);
});

test('deadline seams must be finite positive bounded integers before spawning', () => {
  for (const value of [0, -1, Infinity, NaN, 1.5, 2147483648]) {
    assert.throws(() => new StdioTransport({ command: process.execPath, requestDeadlineMs: value, terminateGraceMs: 20 }), /deadline/);
    assert.throws(() => new StdioTransport({ command: process.execPath, requestDeadlineMs: 20, terminateGraceMs: value }), /grace/);
  }
});

test('exact request/reply limits include UTF8 JSON bytes, not the four-byte prefix', async t => {
  const p = peer('slow'); t.after(() => p.close());
  const overhead = Buffer.byteLength(JSON.stringify(data('max', '')));
  const text = 'x'.repeat(fixtureDataBytes - overhead);
  assert.equal(body(await p.request(data('max', text))).bytes, text.length);
  await assert.rejects(p.request(data('over', text + 'x')), /limit/);
  const c = peer(); t.after(() => c.close());
  const base = { ...control('max-control'), text: '' };
  const maxControl = 'x'.repeat(4096 - Buffer.byteLength(JSON.stringify(base)));
  assert.equal(body(await c.request({ ...base, text: maxControl })).text, maxControl);
  await assert.rejects(c.request({ ...control('over-control'), text: maxControl + 'x' }), /limit/);
  for (const mode of ['reply-max', 'control-max']) {
    const r = peer(mode); t.after(() => r.close());
    const reply = await r.request(mode === 'reply-max' ? data('a') : control('a'));
    assert.equal(Buffer.byteLength(JSON.stringify(reply)), mode === 'reply-max' ? 2 * 1024 * 1024 : 32768);
  }
});

test('mixed data and metadata applies the smaller correlated reply cap after bounded decode', async t => {
  const p = peer('mixed-control-oversize'); t.after(() => p.close());
  const a = p.request(data('a')); const b = p.request(data('b')); const c = p.request(control('c'));
  await Promise.all([a, b, c].map(r => assert.rejects(r, /control reply byte limit/)));
  await p.close(); empty(p);
});

test('delayed unmatched duplicate retires an otherwise live helper with no historical ticket set', async t => {
  const p = peer('delayed-duplicate'); t.after(() => p.close());
  assert.equal(body(await p.request(data('unique'))).bytes, 0);
  await eventually(() => p.stats().childState !== 'running');
  await p.close(); empty(p);
  assert.equal(p.stats().spawnCount, 1);
});

test('backpressured aborts stay bounded with an independent cancelled metadata slot', async t => {
  const p = peer('slow'); t.after(() => p.close());
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const text = 'x'.repeat(1900000);
  const requests = [p.request(data('a', text), { signal: controllers[0].signal }),
    p.request(data('b', text), { signal: controllers[1].signal }),
    p.request(control('c'), { signal: controllers[2].signal })];
  const rejected = requests.map(r => assert.rejects(r, /aborted/));
  controllers.forEach(c => c.abort());
  assert.equal(p.stats().unsettledData, 2);
  assert.equal(p.stats().unsettledControl, 1);
  assert.equal(p.stats().abortListeners, 0);
  assert.ok(p.stats().queuedFrames <= STDIO_LIMITS.queuedFrames);
  assert.ok(p.stats().retainedBytes <= fixtureRetainedBytes);
  await Promise.all(rejected);
  assert.equal(p.stats().retainedBytes, 0);
  await p.close(); empty(p);
});

test('close before spawn notification and invalid per-call deadlines have no leaks', async t => {
  const p = peer(); t.after(() => p.close());
  await assert.rejects(p.request(control('invalid'), { deadlineMs: Infinity }), /deadline/);
  assert.equal(p.stats().unsettledControl, 0);
  await p.close(); empty(p);
});

test('trusted command arguments/env/cwd are forwarded without a shell or ambient configuration', async t => {
  const cwd = fileURLToPath(new URL('../../fixtures/', import.meta.url));
  const argument = '$literal argument; not a shell command';
  const p = new StdioTransport({ command: process.execPath, args: [fixture, 'context', argument],
    env: { ...process.env, OCCIPITAL_TEST_VALUE: 'fixture-value' }, cwd, requestDeadlineMs: 3000, terminateGraceMs: 40 });
  t.after(() => p.close());
  const r = body(await p.request(control('context')));
  assert.equal(r.cwd, cwd.replace(/\/$/, ''));
  assert.equal(r.env, 'fixture-value'); assert.equal(r.argument, argument);
  await p.close(); empty(p);
});

test('premature queued replies cannot release slots or leave uncredited frames behind a paused writer', async t => {
  const p = peer('premature', 10000, 200); t.after(() => p.close());
  const ready = body(await p.request(control('ready')));
  assert.equal(ready.inputPaused, true);
  assert.equal(ready.applicationFrames, 1);
  assert.equal(ready.receivedBytes, Buffer.byteLength(JSON.stringify(control('ready'))) + 4);
  const pid = ready.pid as number;
  const text = 'x'.repeat(1900000);
  let settled = 0, fulfilled = 0;
  const held = p.request(data('held', text)).then(
    () => { settled++; fulfilled++; return 'resolved'; },
    error => { settled++; return (error as Error).message; });
  const samples = [];
  for (let i = 0; i < 9; i++) {
    let queuedSettled = false;
    const queued = p.request(data(`b${i}`, text)).then(
      () => { queuedSettled = true; settled++; fulfilled++; return 'resolved'; },
      error => { queuedSettled = true; settled++; return (error as Error).message; });
    const reserved = p.stats().retainedBytes;
    await assert.rejects(p.request(data(`overflow${i}`)), /capacity/);
    await eventually(() => p.stats().childState === 'retiring' || queuedSettled);
    if (p.stats().childState === 'retiring') {
      const retiring = p.stats();
      t.diagnostic(JSON.stringify({ phase: 'premature reply retirement', ready, settled, fulfilled, ...retiring }));
      assert.equal(settled, 0);
      assert.equal(fulfilled, 0);
      assert.equal(retiring.unsettledData, 2);
      assert.equal(retiring.retainedBytes, reserved);
      assert.ok(retiring.queuedFrames <= STDIO_LIMITS.queuedFrames);
      assert.ok(retiring.retainedBytes <= fixtureRetainedBytes);
      assert.equal(retiring.backpressureEvents, 1);
      assert.equal(retiring.liveTimers, 1);
      process.kill(pid, 0);
      await assert.rejects(p.request(data('no-slot-reuse')), /retired/);
      assert.deepEqual(await Promise.all([held, queued]), ['stdio reply correlation', 'stdio reply correlation']);
      break;
    }
    await queued;
    samples.push(p.stats());
  }
  // The original implementation consumes all nine premature packets: ten
  // frames remain queued with only the held writer's credit. Keep that first-red
  // evidence observable rather than hiding it behind a generic rejection check.
  if (samples.length) t.diagnostic(JSON.stringify({ phase: 'premature reply incorrectly settled', samples, settled, fulfilled }));
  assert.ok(p.stats().queuedFrames <= STDIO_LIMITS.queuedFrames);
  assert.equal(fulfilled, 0);
  assert.equal(settled, 2);
  gone(pid);
  await p.close(); empty(p);
});

test('a handed-to-write reply remains valid before a paused writer callback or drain completes', async t => {
  const p = peer('reply-before-drain', 10000, 200); t.after(() => p.close());
  const ready = body(await p.request(control('ready')));
  assert.equal(ready.inputPaused, true);
  assert.equal(ready.applicationFrames, 1);
  const request = data('held', 'x'.repeat(1900000));
  const result = p.request(request);
  await eventually(() => p.stats().backpressureEvents === 1);
  const response = body(await result);
  assert.equal(response.applicationFrames, 1);
  assert.equal(response.receivedBytes, ready.receivedBytes);
  assert.equal(response.repliesEmitted, 1);
  const stats = p.stats();
  assert.equal(stats.childState, 'running');
  assert.equal(stats.unsettledData, 0);
  assert.equal(stats.queuedFrames, 1);
  assert.equal(stats.retainedBytes, Buffer.byteLength(JSON.stringify(request)) + 4);
  assert.ok(stats.retainedBytes <= fixtureRetainedBytes);
  t.diagnostic(JSON.stringify({ phase: 'handed writer response before completion', ...stats }));
  await p.close(); empty(p);
});

for (const mode of ['reply-instance-control', 'reply-assets-control']) {
  test(`valid-correlated ${mode} rejects actual U+0085 as an invalid reply header`, async t => {
    const p = peer(mode); t.after(() => p.close());
    await assert.rejects(p.request(data('a')), { message: 'stdio invalid reply header' });
    await p.close(); empty(p);
    gone(p.stats().pid!);
  });
}

test('production owned frame family carries escaped data beyond the former ceiling intact', async t => {
  const p=new StdioTransport({command:process.execPath,args:[fixture,'wide-echo'],requestDeadlineMs:3000,terminateGraceMs:40});
  t.after(()=>p.close());
  assert.equal(STDIO_LIMITS.requestBytes,64<<20);
  const text='\u0000'.repeat(400000), request=data('ordinary-escaped',text);
  assert.ok(Buffer.byteLength(JSON.stringify(request))>2<<20);
  const received=body(await p.request(request));
  assert.equal(received.text,text); assert.equal(received.bytes,400000);
  assert.equal(p.stats().spawnCount,1); assert.equal(p.stats().retainedBytes,0);
  await p.close(); empty(p);
});

test('narrower owned allowance is validated before spawn and never expands the family', () => {
  for(const dataBytes of [0,-1,Infinity,1.5,STDIO_LIMITS.requestBytes+1]) {
    assert.throws(()=>new StdioTransport({command:process.execPath,requestDeadlineMs:3000,terminateGraceMs:40,dataBytes}),/data allowance/);
  }
});

test('narrow data replies do not constrain the independent pending metadata lane', async t=> {
  const p=new StdioTransport({command:process.execPath,args:[fixture,'narrow-mixed-control'],requestDeadlineMs:3000,terminateGraceMs:40,dataBytes:1024});
  t.after(()=>p.close());
  const [dataReply,metadata]=await Promise.all([p.request(data('data')),p.request(control('metadata'))]);
  assert.equal(body(metadata).text,'x'.repeat(2048));assert.equal(body(dataReply).bytes,0);
  assert.equal(p.stats().unsettledData,0);assert.equal(p.stats().unsettledControl,0);
  assert.equal(p.stats().retainedBytes,0);
  await p.close();empty(p);
});

test('pending metadata cannot enlarge a correlated data reply allowance', async t=> {
  const p=new StdioTransport({command:process.execPath,args:[fixture,'narrow-mixed-data'],requestDeadlineMs:3000,terminateGraceMs:40,dataBytes:1024});
  t.after(()=>p.close());
  const ended=[p.request(data('data')),p.request(control('metadata'))].map(reply=>assert.rejects(reply,/data reply byte limit/));
  await Promise.all(ended);await p.close();empty(p);
});

function disposition(expected: 'not_started' | 'unknown') {
  return (error: unknown) => { assert.ok(error instanceof RequestFailure);assert.equal(error.execution,expected);return true; };
}

test('typed stdio refusal proves only local pre-dispatch rejection; held work remains intact', async t=> {
  const p=peer('hold');t.after(()=>p.close());
  const abort=new AbortController();abort.abort();
  await assert.rejects(p.request(data('aborted'),{signal:abort.signal}),disposition('not_started'));
  await assert.rejects(p.request({...data('invalid'),v:99}),disposition('not_started'));
  assert.equal(p.stats().unsettledData,0);
  const a=p.request(data('a')),b=p.request(data('b'));
  await assert.rejects(p.request(data('capacity')),disposition('not_started'));
  assert.equal(p.stats().unsettledData,2);
  await p.request(control('release'));await Promise.all([a,b]);await p.close();empty(p);
  await assert.rejects(p.request(data('retired')),disposition('not_started'));
});

test('typed stdio failure after write stays unknown through actual process settlement', async t=> {
  const p=peer('hold');t.after(()=>p.close());
  const result=p.request(data('held')), ended=assert.rejects(result,disposition('unknown'));
  await p.request(control('inspection'));
  await p.close();await ended;empty(p);
});

// Lifetime origin is independent from this request's no-start/unknown outcome.
test('stdio lifetime reports actual idle process loss and late subscribers see the same proof', async t => {
  const p = peer(); t.after(() => p.close());
  const first = p.ended;
  assert.equal(p.endReason, undefined);
  await p.request(control('ready'));
  process.kill(p.stats().pid!, 'SIGKILL');
  assert.equal(await first, 'lost');
  await p.close(); empty(p);
  assert.equal(await p.ended, 'lost');
  assert.equal(p.endReason, 'lost');
});

test('stdio deadline-driven child exit never becomes unexpected loss', async t => {
  const p = peer('hold', 40); t.after(() => p.close());
  await assert.rejects(p.request(data('deadline')), disposition('unknown'));
  await p.close(); empty(p);
  assert.equal(await p.ended, 'uncertain');
  assert.equal(p.endReason, 'uncertain');
});

test('stdio owner close and malformed-reply retirement retain different lifetime origins', async t => {
  const owned = peer(); t.after(() => owned.close());
  await owned.request(control('ready'));
  await owned.close(); empty(owned);
  assert.equal(await owned.ended, 'closed');
  const malformed = peer('json'); t.after(() => malformed.close());
  await assert.rejects(malformed.request(data('bad')), disposition('unknown'));
  await malformed.close(); empty(malformed);
  assert.equal(await malformed.ended, 'uncertain');
});


test('wait-only catalogue expiry keeps the process, source requests and control credit until the late framed reply', async t => {
  const p = peer('wait-only-catalogue', 30000); t.after(() => p.close());
  const pid = body(await p.request(control('ready'))).pid as number;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sourceSettled = false;
  const source = p.request(data('source', 'x')).then(value => { sourceSettled = true; return value; }); void source.catch(() => {});
  const catalogue = p.request({ ...control('catalogue'), op: 'themes.refresh' }, { deadlineMs: 5, waitOnly: true });
  const refused = assert.rejects(catalogue, { message: 'stdio control wait deadline', execution: 'unknown' });
  t.mock.timers.tick(5); await refused;
  process.kill(pid, 0); assert.equal(p.stats().childState, 'running'); assert.equal(p.endReason, undefined);
  assert.equal(p.stats().unsettledControl, 1); assert.equal(p.stats().unsettledData, 1);
  assert.ok(p.stats().retainedBytes >= STDIO_LIMITS.controlReplyBytes); assert.equal(p.stats().liveTimers, 1);
  assert.equal(sourceSettled, false);
  await assert.rejects(p.request(control('blocked'), { waitOnly: true }), (e: unknown) => e instanceof RequestFailure && e.execution === 'not_started' && /capacity/.test(e.message));
  const report = body(await p.request(data('release-data')));
  assert.deepEqual(report.cancelled, ['catalogue']); assert.equal(body(await source).text, 'x');
  assert.equal(p.stats().unsettledData, 0); assert.equal(p.stats().unsettledControl, 1);
  await p.request(data('release-control'));
  // The peer emits the late control frame before the release acknowledgment.
  assert.equal(p.stats().unsettledControl, 0);
  assert.equal(p.stats().retainedBytes, 0); assert.equal(p.stats().spawnCount, 1);
  assert.equal(body(await p.request(control('ready'), { waitOnly: true })).pid, pid);
  t.mock.timers.reset(); await p.close(); empty(p); gone(pid);
});

test('wait-only is refused on stdio source calls without weakening ordinary deadlines', async t => {
  const p = peer(); t.after(() => p.close());
  await assert.rejects(p.request(data('source', 'x'), { waitOnly: true }), (e: unknown) => e instanceof RequestFailure && e.execution === 'not_started' && /control/.test(e.message));
  assert.equal(p.stats().unsettledData, 0); await p.close(); empty(p);
});

for (const outcome of ['ok', 'not_started', 'started'] as const) test(`canonical aborted stdio request preserves terminal ${outcome} evidence`, async t => {
  const p = peer('hold'); t.after(() => p.close());
  const abort = new AbortController(), options = { signal: abort.signal, acceptRetired: true };
  const pending = p.request({ ...data('retired', 'original'), ...(outcome === 'ok' ? {} : { fixtureExecution: outcome }) }, options);
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  abort.abort();
  const inspection = await p.request(control('inspection'));
  assert.deepEqual(body(inspection).cancelled, ['retired']);
  assert.equal(settled, false, 'cancellation alone cannot settle or release the physical request');
  assert.equal(p.stats().unsettledData, 1);
  await p.request(control('release'));
  const result = await pending as Record<string, any>;
  assert.equal(result.status, outcome === 'ok' ? 'ok' : 'error');
  if (outcome === 'ok') assert.equal(result.body.text, 'original');
  else assert.deepEqual(result.error, { code: 'cancelled', execution: outcome });
  assert.equal(p.stats().unsettledData, 0); assert.equal(p.stats().retainedBytes, 0);
  await p.close(); empty(p);
});
