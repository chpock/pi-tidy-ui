import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { sharedSyntaxHost } from '../../../fixtures/shared-syntax-host.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';

test('two concurrently live shared hosts use independent OS-assigned loopback ports', { timeout: 45000 }, async () => {
  const inputs = readInputs(), binary = validateNative(inputs).path;
  assert.ok(inputs.sharedHost?.path, 'prepared shared host is required');
  const hosts = [];
  try {
    const attempts = await Promise.allSettled([sharedSyntaxHost(inputs.sharedHost.path, binary), sharedSyntaxHost(inputs.sharedHost.path, binary)]);
    for (const attempt of attempts) if (attempt.status === 'fulfilled') hosts.push(attempt.value);
    const failures = attempts.filter(attempt => attempt.status === 'rejected');
    assert.equal(failures.length, 0, failures.map(attempt => attempt.reason.message).join('\n'));
    const ports = [];
    for (const host of hosts) {
      const connection = JSON.parse(await readFile(host.connection, 'utf8'));
      const endpoint = connection.endpoints.find(item => item.host === '127.0.0.1');
      assert.equal(Number.isInteger(endpoint?.port) && endpoint.port > 0, true);
      ports.push(endpoint.port);
      assert.equal((await host.initialPeer.refreshThemes()).ok, true, 'each independent host must serve real traffic while both remain live');
    }
    assert.notEqual(ports[0], ports[1]);
    assert.notEqual(hosts[0].alias, hosts[1].alias);
    const pids = hosts.map(host => host.initialPeer.snapshot().provider.description.runtime.pid);
    assert.notEqual(pids[0], pids[1], 'helpers must not be accidentally shared across private hosts');
    console.log(JSON.stringify({ sharedHostIsolation: { ports, helperPids: pids } }));
  } finally {
    await runCleanupSteps(...hosts.map(host => () => host.close()));
  }
});
