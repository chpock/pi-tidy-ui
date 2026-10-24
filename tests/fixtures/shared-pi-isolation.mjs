// Only explicit prepared binaries and suite-private configuration enter this host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { SubcClient } from '@cortexkit/subc-client';
import { sharedHostEnv } from './shared-host-environment.mjs';
import { SyntaxClient } from '../../src/occipital/client.ts';
import { createSharedFactory } from '../../src/occipital/factories.ts';
import { runCleanupSteps } from './terminal-cleanup.mjs';

// Condition-driven I/O turns, never a quiet-period or elapsed-time success fence.
export async function sharedPiProgress(check) {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await turn(); }
  throw new Error('shared Pi isolation progress deadline');
}
export async function sharedPiIsolationHost(inputs, binary) {
  assert.ok(inputs.sharedHost?.path, 'an explicit private host is required');
  assert.equal(createHash('sha256').update(await readFile(inputs.sharedHost.path)).digest('hex'), inputs.sharedHost.sha256);
  const root = await mkdtemp(join(tmpdir(), 'shared-pi-isolation-'));
  const env = sharedHostEnv(root);
  const config = join(root, 'occipital.json'), wrapper = join(root, 'module');
  await writeFile(config, '{}');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(resolve(binary))} --config ${quote(config)} "$@"\n`);
  await chmod(wrapper, 0o700);
  const directory = join(env.XDG_CONFIG_HOME, 'cortexkit'); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'subc.jsonc'), JSON.stringify({ version: 1, port: 0, modules: { occipital: { program: wrapper, reserved: true } } }), { mode: 0o600 });
  const host = spawn(inputs.sharedHost.path, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure, stderr = ''; host.on('error', error => { failure = error; }); host.stdout.resume();
  host.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  const exited = new Promise(resolve => host.once('close', (code, signal) => resolve({ code, signal })));
  const connection = join(env.XDG_RUNTIME_DIR, 'subc-connection.json'), peers = [], pids = new Set();
  const gone = pid => sharedPiProgress(() => {
    try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  });
  let cleanup;
  const close = () => cleanup ??= runCleanupSteps(
    ...peers.map(peer => () => peer.client.dispose()),
    async () => {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
      const deadline = setTimeout(() => host.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(deadline); }
    },
    ...Array.from(pids, pid => () => gone(pid)), () => gone(host.pid),
    () => rm(root, { recursive: true, force: true }),
  );
  try {
    await sharedPiProgress(async () => {
      if (failure) throw failure;
      assert.equal(host.exitCode, null, stderr);
      try { await readFile(connection); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    const startup = await SubcClient.connect({ connectionFile: connection, handshakeTimeoutMs: 2000 });
    try {
      await sharedPiProgress(async () => {
        try { return await startup.resolveProvider('syntax-highlight/v3') === 'occipital'; }
        catch (error) { if (error.code === 'capability_unprovided') return false; throw error; }
      });
    } finally { startup.close(); }
    const peer = async () => {
      let transport;
      const factory = createSharedFactory({ identity: { project_root: root, harness: 'pi', session: `isolation-${peers.length}` },
        discovery: { explicit: connection, env: {} }, requestDeadlineMs: 5000 });
      const client = new SyntaxClient({ standaloneVersion: '0.1.0', initialTheme: { kind: 'pi' }, provider: {
        async tryShared(...args) { transport = await factory(...args); return transport; },
        async acquireOwned() { throw new Error('isolation consumer must remain shared'); },
      } });
      const result = { client, transport: () => transport }; peers.push(result);
      await client.start();
      assert.equal(client.snapshot().provider.kind, 'shared'); assert.equal(client.snapshot().provider.availability, 'ready');
      assert.equal(client.broker.stats().ownedAttempts, 0);
      pids.add(client.snapshot().provider.description.runtime.pid);
      return result;
    };
    return { peer, close, root, hostPid: host.pid, pids };
  } catch (error) { await close(); throw error; }
}
