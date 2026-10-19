import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubcClient } from '@cortexkit/subc-client';
import { childEnv, readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { until, reaped } from '../../../fixtures/shared-syntax-host.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { StdioTransport } from '../../../../src/occipital/stdio.ts';
import { SharedTransport } from '../../../../src/occipital/shared.ts';

const inputs = readInputs(), binary = validateNative(inputs).path;
function collectWhilePending() {
  const state = { pending: true, collected: false };
  const handle = setImmediate(() => { global.gc(); state.collected = state.pending; });
  return { state, handle };
}

// Bind both production transports directly, independently of the UI client.
async function launch() {
  assert.ok(inputs.sharedHost?.path, 'explicit prepared shared host required');
  assert.equal(createHash('sha256').update(await readFile(inputs.sharedHost.path)).digest('hex'), inputs.sharedHost.sha256);
  const root = await mkdtemp(join(tmpdir(), 'node-v3-wire-'));
  const env = childEnv(root, { SUBC_CGROUP_PLACEMENT: 'disabled' });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`, wrapper = join(root, 'module');
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(binary)} "$@"\n`); await chmod(wrapper, 0o700);
  const config = join(env.XDG_CONFIG_HOME, 'cortexkit'); await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, 'subc.jsonc'), JSON.stringify({ version: 1, modules: { occipital: { program: wrapper, reserved: true } } }), { mode: 0o600 });
  const host = spawn(inputs.sharedHost.path, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure; host.on('error', error => { failure = error; }); host.stdout.resume(); host.stderr.resume();
  const exit = new Promise(resolve => host.once('close', resolve));
  const connection = join(env.XDG_RUNTIME_DIR, 'subc-connection.json'), pids = new Set();
  let startup;
  const close = () => runCleanupSteps(() => startup?.close(), async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    const watchdog = setTimeout(() => host.kill('SIGKILL'), 2000);
    try { await exit; } finally { clearTimeout(watchdog); }
  }, () => reaped(host.pid), ...Array.from(pids, pid => () => reaped(pid)), () => rm(root, { recursive: true, force: true }));
  try {
    await until(async () => {
      if (failure) throw failure;
      assert.equal(host.exitCode, null, 'private shared host must stay alive');
      try { await readFile(connection); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'private host connection');
    startup = await SubcClient.connect({ connectionFile: connection, handshakeTimeoutMs: 2000 });
    await until(async () => {
      try { return await startup.resolveProvider('syntax-highlight/v3') === 'occipital'; }
      catch (error) { if (error.code === 'capability_unprovided') return false; throw error; }
    }, 'v3 capability publication');
    await assert.rejects(startup.resolveProvider('syntax-highlight/v2'), { code: 'capability_unprovided' });
    startup.close(); startup = undefined;
    return { root, env, connection, pids, close };
  } catch (error) { await close(); throw error; }
}

function source(key, text) { return { key, generation: 1, source_version: 0, hint: { language: 'rust' }, text }; }
function empty(transport, shared) {
  const stats = transport.stats();
  for (const key of shared
    ? ['unsettledData', 'unsettledControl', 'dataReservedBytes', 'controlReservedBytes', 'encodedRequestBytes', 'liveTimers', 'abortListeners']
    : ['unsettledData', 'unsettledControl', 'retainedBytes', 'queuedFrames', 'liveTimers', 'abortListeners', 'ownedListeners']) assert.equal(stats[key], 0, key);
  assert.equal(shared ? stats.state : stats.childState, shared ? 'closed' : 'exited');
  return stats;
}

test('Node v3 wire: both production transports carry source, native/client styles, empty palette and independent control with cleanup', { timeout: 120000 }, async t => {
  const host = await launch(), evidence = [];
  try {
    for (const shared of [false, true]) {
      const transport = shared
        ? new SharedTransport({ connectionFile: host.connection, identity: { project_root: host.root, harness: 'node-v3-wire', session: 'shared' }, initDeadlineMs: 3000, requestDeadlineMs: 30000 })
        : new StdioTransport({ command: binary, args: ['--stdio'], env: host.env, cwd: host.root, requestDeadlineMs: 30000, terminateGraceMs: 100 });
      // The test owns this weakly observed transport until cleanup. An awaited
      // request Promise alone cannot keep its suspended caller graph alive.
      t.after(() => transport.close());
      let pid;
      try {
        if (shared) await transport.ready;
        let sequence = 0;
        const call = async (op, fields = {}, options = {}) => {
          const ticket = `wire-${++sequence}`;
          const reply = await transport.request({ v: 3, ticket, op, ...fields }, options);
          assert.equal(reply.v, 3); assert.equal(reply.ticket, ticket); assert.equal(reply.status, 'ok');
          return reply;
        };
        const descriptor = await call('describe', {}, { waitOnly: true });
        pid = descriptor.body.runtime.pid; if (shared) host.pids.add(pid);
        assert.equal(descriptor.body.capability, 'syntax-highlight/v3'); assert.equal(descriptor.body.protocol_version, 3);
        const instance = descriptor.instance, vocabulary = descriptor.body.vocabulary.fingerprint;
        const data = fields => ({ instance, admission: 'bounded_queue', queue_wait_ms: 1000, ...fields });
        const profile = descriptor.body.profiles[0]; assert.ok(profile);
        const native = contexts => data({ vocabulary, contexts, rules: { kind: 'native', id: profile.id, fingerprint: profile.fingerprint } });
        await assert.rejects(transport.request({ v: 2, ticket: 'old', op: 'describe' }), { execution: 'not_started' });
        const finite = await call('highlight', data({ sources: [source('finite', 'let x = "界🙂";\n'), source('empty', '')] }));
        assert.equal(finite.body.kind, 'source'); assert.equal(finite.body.vocabulary, vocabulary);
        assert.ok(finite.body.sources.every(s => s.complete && !Object.hasOwn(s, 'lease')));
        assert.equal(finite.body.sources[0].counters.committed_line_calls, 1);
        const contexts = finite.body.sources[0].contexts; assert.ok(contexts.length > 0);
        const palette = await call('styles.resolve', native([]));
        assert.equal(palette.body.kind, 'styles'); assert.deepEqual(palette.body.indices, []); assert.equal(palette.body.palette.slots.length, 26);
        const painted = await call('styles.resolve', native(contexts));
        assert.equal(painted.body.indices.length, contexts.length); assert.equal(painted.body.palette.fingerprint, palette.body.palette.fingerprint);
        const declaration = { revision: 1, binding_slots: 1, default: { foreground: { kind: 'binding', slot: 0 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }, rules: [] };
        const generic = await call('styles.resolve', data({ vocabulary, contexts, rules: { kind: 'client', definition: declaration } }));
        assert.equal(generic.body.palette, null); assert.equal(generic.body.indices.length, contexts.length);
        assert.ok(generic.body.styles.every(style => style.foreground.kind === 'binding'));
        const opened = (await call('stream.open', data({ sources: [source('stream', 'fn f() {\n')] }))).body.sources[0];
        const appended = (await call('stream.append', data({ key: opened.key, generation: opened.generation, source_version: 1, lease: opened.lease, base_revision: opened.revision, base_bytes: opened.source_bytes, append: '}\n', final: true }))).body.sources[0];
        assert.equal(appended.revision, 2); assert.equal(appended.complete, true); assert.equal(appended.counters.committed_line_calls, 1);
        assert.equal((await call('stream.close', { instance, key: opened.key, generation: opened.generation, lease: opened.lease })).body.kind, 'closed');
        // Cycle the actual non-empty parser contexts: parsed-empty rows skip
        // native selector matching and can finish before metadata is dispatched.
        const backlog = Array.from({ length: 12000 }, (_, index) => contexts[index % contexts.length]);
        const styleSettlements = [];
        const held = [call('styles.resolve', native(backlog)), call('styles.resolve', native(backlog))].map((promise, index) => promise.then(
          reply => { styleSettlements.push(index); return reply; },
          error => { styleSettlements.push(index); throw error; }));
        // Always observe rejections, including when an overlap assertion fails.
        held.forEach(promise => { void promise.catch(() => {}); });
        assert.equal(transport.stats().unsettledData, 2);
        const beforeRefusal = transport.stats();
        await assert.rejects(transport.request({ v: 3, ticket: 'full', op: 'highlight' }), { execution: 'not_started' });
        if (shared) assert.equal(transport.stats().serializedRequests, beforeRefusal.serializedRequests);
        const describing = call('describe', { instance }, { waitOnly: true });
        void describing.catch(() => {});
        const metadataAdmission = transport.stats();
        assert.equal(metadataAdmission.unsettledData, 2);
        assert.equal(metadataAdmission.unsettledControl, 1, 'independent control admits synchronously while both DATA credits are owned');
        const during = await describing;
        const overlap = { metadataAdmission, native: during.body.runtime, transport: transport.stats(), styleSettlements: [...styleSettlements] };
        // Two slots are checked at submission above. An actual STYLE reply may
        // settle before this independent describe reply; that legitimately frees
        // its credit. Native two-job overlap has its own admission-witness test.
        assert.equal(during.body.kind, 'descriptor');
        assert.deepEqual((await Promise.all(held)).map(reply => reply.body.indices.length), [12000, 12000]);
        assert.equal(transport.stats().unsettledData, 0, 'both actual replies release their physical credits');
        const collection = collectWhilePending();
        let refreshed;
        try { refreshed = await call('themes.refresh', { instance }, { waitOnly: true }); }
        finally { collection.state.pending = false; clearImmediate(collection.handle); }
        assert.equal(collection.state.collected, true, 'GC ran while the control request was pending');
        assert.equal(refreshed.body.kind, 'descriptor');
        const after = (await call('describe', { instance }, { waitOnly: true })).body.runtime;
        assert.equal(after.data_jobs, 0); assert.equal(after.leases, 0);
        evidence.push({ carrier: shared ? 'shared' : 'stdio', pid, finiteSources: 2, finiteParserCalls: finite.body.sources[0].counters.committed_line_calls, streamRevisions: [opened.revision, appended.revision], appendParserCalls: appended.counters.committed_line_calls, nativeContextCount: contexts.length, clientContextCount: generic.body.indices.length, emptyPaletteSlots: palette.body.palette.slots.length, transportStyleOverlap: overlap, settledJobs: after.data_jobs, remainingLeases: after.leases });
      } finally {
        await transport.close();
        const cleanup = empty(transport, shared);
        if (!shared && pid) await reaped(pid);
        if (evidence.at(-1)?.pid === pid) evidence.at(-1).cleanup = cleanup;
      }
    }
  } finally { await host.close(); }
  console.log(JSON.stringify({ nodeV3Wire: evidence, node: process.version, source: inputs.source, helperSha256: inputs.native.sha256, hostSha256: inputs.sharedHost.sha256, ownedProcessesReaped: true }));
});
