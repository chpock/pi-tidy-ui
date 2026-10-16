// Holds exact product reply frames before the client's transport can settle them.
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [binary, report] = process.argv.slice(2);
const child = spawn(binary, ['--stdio', '--config', join(process.cwd(), 'config.json')], { stdio: ['pipe', 'pipe', 'inherit'] });
let gated = false;
const held = [], stats = { data: [], cancelled: 0, held: 0, peakHeld: 0 };
function record() { writeFileSync(`${report}.tmp`, JSON.stringify(stats)); renameSync(`${report}.tmp`, report); }
function frames(stream, consume) {
  let buffer = Buffer.alloc(0);
  stream.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const end = 4 + buffer.readUInt32BE(0), frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end);
      consume(frame, JSON.parse(frame.subarray(4).toString('utf8')));
    }
  });
}
frames(process.stdin, (frame, request) => {
  if (request.cancel) { stats.cancelled++; record(); }
  if (request.ticket === 'gate-arm') gated = true;
  if (request.ticket === 'gate-release') {
    gated = false;
    for (const reply of held.splice(0)) process.stdout.write(reply);
    stats.held = 0; record();
  }
  if (request.op === 'highlight') {
    stats.data.push({ profile: request.sources[0].profile, key: request.sources[0].key }); record();
  }
  child.stdin.write(frame);
});
frames(child.stdout, (frame, reply) => {
  if (gated && reply.body?.kind === 'source') {
    held.push(frame); stats.held = held.length; stats.peakHeld = Math.max(stats.peakHeld, held.length); record();
  } else process.stdout.write(frame);
});
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('exit', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
child.on('error', () => process.exit(1));
child.on('exit', (code, signal) => { record(); process.exit(code ?? (signal === 'SIGTERM' ? 0 : 1)); });
