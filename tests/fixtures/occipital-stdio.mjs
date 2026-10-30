// Transport-only adversarial peer. This is not a native highlighting fixture.
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { HIGHLIGHT_LIMITS } from '../../src/occipital/limits.ts';
const dataBytes = HIGHLIGHT_LIMITS.dataWireBytes;

const mode = process.argv[2] ?? 'echo';
const replyControlCharacter = String.fromCodePoint(0x85);
const held = [];
const cancelled = [];
let heldDescribe;
let incoming = Buffer.alloc(0);
let sequence = 0;
let receivedBytes = 0;
let applicationFrames = 0;
const keepAlive = setInterval(() => {}, 1000);
if (['ignore-term', 'premature', 'reply-before-drain'].includes(mode)) process.on('SIGTERM', () => {});
if (mode === 'slow') {
  process.stdin.pause();
  setTimeout(() => process.stdin.resume(), 250);
}
function packet(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function reply(request) {
  if (request.fixtureExecution) return { v: 4, ticket: request.ticket, instance: 'fixture-instance', assets: 'fixture-assets',
    status: 'error', error: { code: 'cancelled', execution: request.fixtureExecution } };
  return {
    v: 4, ticket: request.ticket, instance: 'fixture-instance', assets: 'fixture-assets', status: 'ok',
    body: {
      pid: process.pid, sequence: ++sequence, cancelled: [...cancelled],
      ...(mode === 'context' ? { cwd: process.cwd(), env: process.env.OCCIPITAL_TEST_VALUE, argument: process.argv[3] } : {}),
      text: mode === 'slow' ? undefined : request.text,
      bytes: Buffer.byteLength(request.text ?? ''),
      hash: createHash('sha256').update(request.text ?? '').digest('hex'),
    },
  };
}
function send(request) { process.stdout.write(packet(reply(request))); }
function onRequest(request) {
  if ('cancel' in request) {
    if (request.v !== 4 || Object.keys(request).length !== 2) process.exit(3);
    cancelled.push(request.cancel);
    return;
  }
  if (request.v !== 4) process.exit(3);
  applicationFrames++;
  if (mode === 'wait-only-describe') {
    if (request.op === 'describe') {
      if (request.ticket === 'ready') send(request); else heldDescribe = request;
    } else if (request.ticket === 'release-data') {
      send(request); held.splice(0).forEach(send);
    } else if (request.ticket === 'release-control') {
      if (heldDescribe) { send(heldDescribe); heldDescribe = undefined; } send(request);
    } else held.push(request);
    return;
  }
  if (mode === 'premature' || mode === 'reply-before-drain') {
    // Read exactly the readiness request, then never consume the large writer
    // or any queued application frame. Replies deliberately bypass ingress.
    process.stdin.pause();
    const counters = { pid: process.pid, inputPaused: process.stdin.isPaused(), receivedBytes, applicationFrames };
    process.stdout.write(packet({ ...reply(request), body: counters }));
    let index = 0;
    const premature = setInterval(() => {
      const ticket = mode === 'premature' ? `b${index}` : 'held';
      process.stdout.write(packet({ v: 4, ticket, instance: 'fixture-instance', assets: 'fixture-assets', status: 'ok',
        body: { ...counters, repliesEmitted: ++index } }));
      if (index === (mode === 'premature' ? 9 : 1)) clearInterval(premature);
    }, 150);
    return;
  }
  if (mode === 'reverse' || mode === 'chunks') {
    held.push(request);
    if (held.length === 2) {
      const bytes = Buffer.concat(held.reverse().map(r => packet(reply(r))));
      if (mode === 'reverse') process.stdout.write(bytes);
      else {
        const sizes = [1, 2, 1, 7, 3, 11];
        let offset = 0;
        function part() {
          if (offset === bytes.length) return;
          const end = Math.min(bytes.length, offset + (sizes.shift() ?? 17));
          process.stdout.write(bytes.subarray(offset, end));
          offset = end;
          setTimeout(part, 1);
        }
        part();
      }
    }
    return;
  }
  if (mode === 'narrow-mixed-control' || mode === 'narrow-mixed-data') {
    if (request.op !== 'describe') { held.push(request); return; }
    const data=held.shift(), large=mode==='narrow-mixed-control'?request:data;
    const largeReply=reply(large);largeReply.body.text='x'.repeat(2048);
    process.stdout.write(Buffer.concat([packet(largeReply),packet(reply(mode==='narrow-mixed-control'?data:request))]));
    return;
  }
  if (mode === 'hold' || mode === 'ignore-term') {
    if (request.op === 'describe') {
      send(request);
      if (request.ticket === 'release') held.splice(0).forEach(send);
    } else held.push(request);
    return;
  }
  if (mode === 'late') {
    if (request.op === 'describe') send(request);
    else setTimeout(() => send(request), request.ticket === 'first' ? 180 : 350);
    return;
  }
  if (mode === 'pipe-error') {
    send(request);
    closeSync(0);
    process.stdin.destroy();
    return;
  }
  if (mode === 'stderr') {
    // Drain must not retain or publish this intentionally large private payload.
    process.stderr.write('private source '.repeat(100000));
    send(request);
    return;
  }
  const valid = reply(request);
  if (mode === 'mixed-control-oversize') {
    if (request.op === 'highlight') return;
    process.stdout.write(packet({ ...valid, body: { text: 'x'.repeat(32768) } }));
    return;
  }
  if (mode === 'reply-max' || mode === 'control-max') {
    valid.body = { text: '' };
    const cap = mode === 'reply-max' ? dataBytes : 32768;
    valid.body.text = 'x'.repeat(cap - Buffer.byteLength(JSON.stringify(valid)));
    process.stdout.write(packet(valid));
    return;
  }
  if (mode === 'delayed-duplicate') {
    const bytes = packet(valid);
    process.stdout.write(bytes);
    setTimeout(() => process.stdout.write(bytes), 60);
    return;
  }
  switch (mode) {
    case 'zero': process.stdout.write(Buffer.alloc(4)); break;
    case 'oversize': { const b = Buffer.alloc(4); b.writeUInt32BE(dataBytes + 1); process.stdout.write(b); break; }
    case 'truncated-header': process.stdout.end(Buffer.from([0, 0])); break;
    case 'truncated-body': process.stdout.end(Buffer.from([0, 0, 0, 8, 123])); break;
    case 'eof': process.stdout.end(); break;
    case 'utf8': process.stdout.write(Buffer.from([0, 0, 0, 2, 0xc3, 0x28])); break;
    case 'json': process.stdout.write(Buffer.from([0, 0, 0, 1, 123])); break;
    case 'unknown': process.stdout.write(packet({ ...valid, ticket: 'unknown' })); break;
    case 'duplicate': process.stdout.write(Buffer.concat([packet(valid), packet(valid)])); break;
    case 'version': process.stdout.write(packet({ ...valid, v: 2 })); break;
    case 'instance': process.stdout.write(packet({ ...valid, instance: '' })); break;
    case 'assets': process.stdout.write(packet({ ...valid, assets: 3 })); break;
    case 'status': process.stdout.write(packet({ ...valid, status: 'maybe' })); break;
    case 'missing-body': { delete valid.body; process.stdout.write(packet(valid)); break; }
    case 'reply-ticket-control': process.stdout.write(packet({ ...valid, ticket: `a${replyControlCharacter}` })); break;
    case 'reply-instance-control': process.stdout.write(packet({ ...valid, instance: `instance${replyControlCharacter}` })); break;
    case 'reply-assets-control': process.stdout.write(packet({ ...valid, assets: `assets${replyControlCharacter}` })); break;
    case 'error-body': process.stdout.write(packet({ ...valid, status: 'error', error: { code: 'busy', execution: 'maybe' } })); break;
    case 'control-oversize': process.stdout.write(packet({ ...valid, body: { text: 'x'.repeat(32768) } })); break;
    case 'changed-instance': process.stdout.write(packet({ ...valid, instance: sequence === 1 ? 'first-instance' : 'other-instance' })); break;
    case 'application-error': process.stdout.write(packet({ v: 4, ticket: request.ticket, instance: 'fixture-instance', assets: 'fixture-assets', status: 'error', error: { code: 'busy', execution: 'not_started' } })); break;
    default: send(request);
  }
}
process.stdin.on('data', chunk => {
  receivedBytes += chunk.length;
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4) {
    const length = incoming.readUInt32BE();
    const cap=mode==='wide-echo'?64*1024*1024:2*1024*1024;
    if (!length || length > cap) process.exit(4);
    if (incoming.length < length + 4) break;
    const body = incoming.subarray(4, length + 4);
    incoming = incoming.subarray(length + 4);
    onRequest(JSON.parse(body.toString('utf8')));
  }
});
process.stdin.on('end', () => {
  if (mode !== 'ignore-term') { clearInterval(keepAlive); process.exit(0); }
});
