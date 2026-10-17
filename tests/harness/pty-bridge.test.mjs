import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs, toolPath } from '../../scripts/test/context.mjs';

const posixOnly = process.platform === 'win32' ? 'POSIX PTY prerequisite; unavailable on Windows' : false;
const bridgePath = fileURLToPath(new URL('../fixtures/pty_bridge.py', import.meta.url));
const payload = Buffer.from('shutdown:\x1b[31m界\x1b[0m\r\n'.repeat(32768));
const childSource = `
import os, signal, sys, time, tty
mode = sys.argv[1]
payload = ('shutdown:\\x1b[31m界\\x1b[0m\\r\\n' * 32768).encode('utf-8')
tty.setraw(0)
def write(data):
    while data:
        data = data[os.write(1, data):]
def terminate(*_):
    if mode == 'ignore':
        write(b'TERM\\n')
        time.sleep(1.8)
        write(b'GRACE\\n')
    else:
        write(payload)
        os._exit(37)
# Queue shutdown before readiness; pause can miss a deferred Python handler.
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
write(b'READY\\n')
assert os.read(0, 1) == b'G'
if mode == 'natural':
    write(payload)
    os._exit(37)
write(b'ARMED\\n')
if mode == 'pending':
    os.kill(os.getpid(), signal.SIGTERM)
while True:
    signal.sigwait({signal.SIGTERM})
    terminate()
`;

function assertBytes(actual, expected, frames = []) {
  const status=frames.filter(frame=>frame.exit!==undefined||frame.shutdown).map(({exit,shutdown})=>({exit,shutdown}));
  assert.equal(actual.length, expected.length, 'forwarded PTY byte count; shutdown='+JSON.stringify(status));
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256(actual), sha256(expected), 'forwarded PTY bytes must be unchanged');
}

async function startBridge(t, mode) {
  const inputs = readInputs(), python = toolPath('python3', inputs);
  const directory = mkdtempSync(join(tmpdir(), 'tidy-pty-bridge-'));
  const child = spawn(python, ['-I', '-S', bridgePath, '80', '24', directory,
    python, '-I', '-S', '-c', childSource, mode], {
    cwd: directory, env: childEnv(directory, {}, inputs), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [], bytes = [];
  let stderr = '', failure, closed = false, resolveChange;
  let change = new Promise(resolve => { resolveChange = resolve; });
  const notify = () => {
    resolveChange();
    change = new Promise(resolve => { resolveChange = resolve; });
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.data !== undefined) bytes.push(Buffer.from(frame.data, 'base64'));
      if (frame.error) failure = new Error(frame.error);
    } catch (error) { failure = error; }
    notify();
  });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { failure = error; notify(); });
  child.stdin.on('error', error => { failure = error; notify(); });
  const completion = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    notify();
    resolve({ code, signal });
  }));
  const watchdog = setTimeout(() => {
    failure = new Error('PTY bridge exceeded the 8-second subprocess bound');
    const pid = frames.find(frame => frame.ready)?.ready;
    if (pid) try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = error; }
    child.kill('SIGKILL');
    notify();
  }, 8000);
  t.after(async () => {
    if (!closed) {
      child.kill('SIGTERM');
      await completion;
    }
    clearTimeout(watchdog);
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const waitFor = async (predicate, label) => {
    while (!predicate()) {
      assert.ifError(failure);
      assert.equal(closed, false, `Bridge closed before ${label}: ${stderr}`);
      await change;
    }
    assert.ifError(failure);
  };
  const output = () => Buffer.concat(bytes);
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  await waitFor(() => frames.some(frame => frame.ready) && output().equals(Buffer.from('READY\n')), 'child startup gate');
  const pid = frames.find(frame => frame.ready).ready;
  send({ input: Buffer.from('G').toString('base64') });
  if (!['natural','pending'].includes(mode)) await waitFor(() => output().equals(Buffer.from('READY\nARMED\n')), 'armed shutdown receiver');
  return {
    child, frames, output, send,
    async finish() {
      const result = await completion;
      assert.ifError(failure);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      assert.equal(stderr, '');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned child must be reaped, not a surviving process or zombie');
    },
  };
}

for (const trigger of ['stop message', 'stdin EOF', 'bridge SIGTERM']) {
  test(`PTY bridge drains a large graceful shutdown on ${trigger}`, { skip: posixOnly, timeout: 12000 }, async t => {
    const bridge = await startBridge(t, 'graceful');
    if (trigger === 'stop message') bridge.send({ stop: true });
    else if (trigger === 'stdin EOF') bridge.child.stdin.end();
    else bridge.child.kill('SIGTERM');
    await bridge.finish();
    assertBytes(bridge.output(), Buffer.concat([Buffer.from('READY\nARMED\n'), payload]),bridge.frames);
    assert.deepEqual(bridge.frames.filter(frame => frame.exit !== undefined), [{ exit: 37 }]);
    assert.deepEqual(bridge.frames.filter(frame => frame.shutdown), [{ shutdown: { drainedBytes: payload.length, escalations: 0 } }]);
    assert.ok(bridge.frames.at(-2).exit !== undefined, 'terminal bytes must be forwarded before final exit status');
  });
}

test('PTY child consumes a shutdown already pending before its signal wait', { skip: posixOnly, timeout: 12000 }, async t => {
  const bridge=await startBridge(t,'pending');
  await bridge.finish();
  assertBytes(bridge.output(),Buffer.concat([Buffer.from('READY\nARMED\n'),payload]),bridge.frames);
  assert.deepEqual(bridge.frames.filter(frame=>frame.exit!==undefined),[{exit:37}]);
  assert.equal(bridge.frames.at(-1).shutdown.escalations,0);
});

test('PTY bridge preserves the two-second grace and escalates an unresponsive child', { skip: posixOnly, timeout: 12000 }, async t => {
  const bridge = await startBridge(t, 'ignore');
  const started = performance.now();
  bridge.send({ stop: true });
  await bridge.finish();
  assert.ok(performance.now() - started >= 1900, 'SIGKILL must not shorten the existing two-second grace');
  assert.deepEqual(bridge.output(), Buffer.from('READY\nARMED\nTERM\nGRACE\n'));
  assert.deepEqual(bridge.frames.filter(frame => frame.exit !== undefined), [{ exit: -9 }]);
  assert.deepEqual(bridge.frames.filter(frame => frame.shutdown), [{ shutdown: { drainedBytes: 11, escalations: 1 } }]);
});

test('PTY bridge drains terminal tail bytes before reporting a natural child exit', { skip: posixOnly, timeout: 12000 }, async t => {
  const bridge = await startBridge(t, 'natural');
  await bridge.finish();
  assertBytes(bridge.output(), Buffer.concat([Buffer.from('READY\n'), payload]),bridge.frames);
  assert.deepEqual(bridge.frames.filter(frame => frame.exit !== undefined), [{ exit: 37 }]);
  assert.equal(bridge.frames.at(-2).exit, 37);
  assert.equal(bridge.frames.at(-1).shutdown.escalations, 0);
});
