// Explicit isolated runtime only. The host binary and product helper must be supplied.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { childEnv } from '../../scripts/test/context.mjs';
import { runCleanupSteps } from './terminal-cleanup.mjs';
import { SyntaxClient } from '../../src/occipital/client.ts';
import { createSharedFactory } from '../../src/occipital/factories.ts';
import { ExtensionSettings } from '../../src/settings.ts';
import { CAPABILITY } from '../../src/occipital/protocol.ts';

export async function until(check, label) {
  for (const end = Date.now() + 12000; Date.now() < end;) {
    const result = await check(); if (result) return result;
    await pause(25);
  }
  throw new Error('Timed out: ' + label);
}
export async function reaped(pid) {
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'reaped process ' + pid);
}
export const themeDefinition = color => `<plist><dict><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>${color}</string></dict></dict></array></dict></plist>`;
export async function sharedSyntaxHost(hostBinary, helperBinary) {
  const root = await mkdtemp(join(tmpdir(), 'occipital-cli-shared-'));
  const env = childEnv(root, { SUBC_CGROUP_PLACEMENT: 'disabled' });
  const runtime = env.XDG_RUNTIME_DIR, themes = join(root, 'themes'), config = join(root, 'occipital.json');
  await mkdir(themes, { mode: 0o700 });
  const themeFile = join(themes, 'cli-shared.tmTheme');
  await writeFile(themeFile, themeDefinition('#223344'));
  await writeFile(config, JSON.stringify({ themeDirectories: ['themes'] }));
  const wrapper = join(root, 'module'), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(resolve(helperBinary))} --config ${quote(config)} "$@"\n`);
  await chmod(wrapper, 0o700);
  const daemonConfig = join(env.XDG_CONFIG_HOME, 'cortexkit'); await mkdir(daemonConfig, { mode: 0o700 });
  await writeFile(join(daemonConfig, 'subc.jsonc'), JSON.stringify({ version: 1, modules: { occipital: { program: wrapper, reserved: true } } }), { mode: 0o600 });
  const host = spawn(resolve(hostBinary), [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', failure;
  host.on('error', error => { failure = error; }); host.stdout.resume(); host.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const hostExit = new Promise(resolve => host.once('close', (code, signal) => resolve({ code, signal })));
  const connection = join(runtime, 'subc-connection.json'), alias = join(root, 'pi-connection.json');
  const clients = [], pids = new Set();
  const close = () => runCleanupSteps(
    ...clients.map(client => () => client.dispose()),
    async () => {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await hostExit;
    },
    ...Array.from(pids, pid => () => reaped(pid)),
    () => rm(root, { recursive: true, force: true }),
  );
  try {
    await until(async () => {
      if (failure) throw failure;
      assert.equal(host.exitCode, null, stderr);
      try { await readFile(connection); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'isolated shared connection');
    await writeFile(alias, await readFile(connection), { mode: 0o600 });
    const peer = async () => {
      const { SubcClient } = await import('@cortexkit/subc-client');
      const startup = await SubcClient.connect({ connectionFile: connection, handshakeTimeoutMs: 2000 });
      try {
        await until(async () => {
          try { return await startup.resolveProvider(CAPABILITY) === 'occipital'; }
          catch (error) { if (error.code === 'capability_unprovided') return false; throw error; }
        }, 'actual shared capability publication');
      } finally { startup.close(); }
      const client = new SyntaxClient({ standaloneVersion: '0.1.0', settings: new ExtensionSettings({ file: join(root, `peer-${clients.length}.json`) }),
        provider: { tryShared: createSharedFactory({ identity: { project_root: root, harness: 'pi', session: `peer-${clients.length}` },
          discovery: { explicit: connection, env: {} }, requestDeadlineMs: 5000 }),
          acquireOwned: async () => { throw new Error('peer must remain shared'); } } });
      clients.push(client); await client.start();
      assert.equal(client.snapshot().provider.kind, 'shared'); assert.equal(client.snapshot().provider.availability, 'ready');
      pids.add(client.snapshot().provider.description.runtime.pid); return client;
    };
    const initialPeer = await peer();
    return { root, alias, connection, themeFile, peer, initialPeer, close, pids };
  } catch (error) { await close(); throw error; }
}
