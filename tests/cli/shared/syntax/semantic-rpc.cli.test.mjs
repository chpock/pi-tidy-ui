import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { SubcClient, SubcError } from '@cortexkit/subc-client';
import { readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { sharedHostEnv } from '../../../fixtures/shared-host-environment.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { createSemanticRuleDefinition } from '../../../../src/syntax/semantic-rules.ts';
import { fingerprintRules } from '../../../../src/occipital/style-rules.ts';

const inputs = readInputs();
const binary = validateNative(inputs).path;
const hash = value => createHash('sha256').update(value).digest('hex');
async function until(check, label) {
  for (const end = Date.now() + 12000; Date.now() < end;) {
    const value = await check(); if (value) return value; await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function reaped(pid) {
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'owned process reaping');
}

// This producer-level control uses the public SDK and private host roots,
// independently from the production SyntaxClient/Pi integration.
async function launch() {
  assert.ok(inputs.sharedHost?.path, 'explicit prepared host required');
  assert.equal(hash(await readFile(inputs.sharedHost.path)), inputs.sharedHost.sha256);
  const root = await mkdtemp(join(tmpdir(), 'semantic-rpc-'));
  const env = sharedHostEnv(root);
  const wrapper = join(root, 'module');
  await writeFile(wrapper, `#!/bin/sh\nexec "${resolve(binary)}" "$@"\n`); await chmod(wrapper, 0o700);
  const directory = join(env.XDG_CONFIG_HOME, 'cortexkit'); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'subc.jsonc'), JSON.stringify({ version: 1, port: 0, modules: { occipital: { program: wrapper, reserved: true } } }), { mode: 0o600 });
  const host = spawn(inputs.sharedHost.path, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure, stderr = ''; host.on('error', error => { failure = error; }); host.stdout.resume(); host.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  const exit = new Promise(resolve => host.once('close', resolve));
  const clients = [], pids = new Set(), connection = join(env.XDG_RUNTIME_DIR, 'subc-connection.json');
  const close = () => runCleanupSteps(...clients.map(client => () => client.close()), async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    const watchdog = setTimeout(() => host.kill('SIGKILL'), 2000);
    try { await exit; } finally { clearTimeout(watchdog); }
  }, ...Array.from(pids, pid => () => reaped(pid)), () => rm(root, { recursive: true, force: true }));
  try {
    await until(async () => { if (failure) throw failure; assert.equal(host.exitCode, null, stderr); try { await readFile(connection); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'private host connection');
    const peer = async session => {
      const client = await SubcClient.connect({ connectionFile: connection, handshakeTimeoutMs: 2000 }); clients.push(client);
      await until(async () => { try { return await client.resolveProvider('syntax-highlight/v4') === 'occipital'; } catch (error) { if (error.code === 'capability_unprovided') return false; throw error; } }, 'v4 capability publication');
      const route = await client.routeOpen({ kind: 'internal_service', module_id: 'occipital', service_id: 'syntax' }, { project_root: root, harness: 'native-semantic-rpc', session }, { consumerIdentity: null });
      let sequence = 0;
      const call = async (op, fields = {}, options = {}) => {
        const reply = await client.request(route, Buffer.from(JSON.stringify({ v: 4, ticket: `${session}-${++sequence}`, op, ...fields })), { binary: false, timeoutMs: 10000, ...options });
        assert.equal(reply.v, 4); assert.match(reply.assets, /^[0-9a-f]{64}$/); return reply;
      };
      const description = await call('describe'); assert.equal(description.status, 'ok'); pids.add(description.body.runtime.pid);
      return { client, route, call, description, close: () => client.closeRoute(route) };
    };
    return { peer, close, pids, hostPid: host.pid };
  } catch (error) { await close(); throw error; }
}
function source(key, text) { return { key, generation: 1, source_version: 0, hint: { language: 'rust' }, text }; }
function append(s, text, final = false, version = 1) { return { key: s.key, generation: s.generation, source_version: version, lease: s.lease, base_revision: s.revision, base_bytes: s.source_bytes, append: text, final }; }
function coverage(source, text) {
  let cursor = source.replace_from, previous;
  for (let n = 0; n < source.runs.length; n += 2) {
    const length = source.runs[n], context = source.runs[n + 1]; assert.ok(length > 0); assert.ok(context >= 0 && context <= source.contexts.length); assert.notEqual(context, previous);
    assert.equal(Buffer.from(text).subarray(0, cursor).toString().includes('\ufffd'), false); cursor += length; previous = context;
  }
  assert.equal(cursor, Buffer.byteLength(text)); assert.equal(source.source_bytes, cursor);
  for (const field of ['profile', 'fingerprint', 'styles', 'palette']) assert.equal(Object.hasOwn(source, field), false);
}

test('native v4 semantic RPC: shared source and generic style routes preserve peer, leases and cleanup', { timeout: 120000 }, async () => {
  const host = await launch();
  try {
    const a = await host.peer('a'), b = await host.peer('b');
    const descriptor = a.description, instance = descriptor.instance, vocabulary = descriptor.body.vocabulary.fingerprint;
    assert.equal(descriptor.body.capability, 'syntax-highlight/v4'); assert.equal(descriptor.body.protocol_version, 4);
    assert.equal(descriptor.body.assets, descriptor.assets);
    assert.deepEqual([...descriptor.body.operations].sort(), ['describe', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve'].sort());
    assert.equal(Object.hasOwn(descriptor.body, 'profiles'), false); assert.equal(Object.hasOwn(descriptor.body, 'catalogue_revision'), false);
    assert.equal(descriptor.body.runtime.pid, b.description.body.runtime.pid);
    const meta = op => a.call(op, { instance });
    const data = fields => ({ instance, admission: 'bounded_queue', queue_wait_ms: 1000, ...fields });
    const rules = createSemanticRuleDefinition(), ruleFingerprint = fingerprintRules(rules);
    const generic = contexts => data({ vocabulary, contexts, rules });
    const empty = await a.call('styles.resolve', generic([]));
    assert.equal(empty.status, 'ok'); assert.equal(empty.body.kind, 'styles');
    assert.deepEqual(empty.body.indices, []); assert.deepEqual(empty.body.styles, []);
    assert.equal(empty.body.rules, ruleFingerprint); assert.equal(Object.hasOwn(empty.body, 'palette'), false);
    assert.equal(Object.hasOwn(empty.body, 'profile'), false);

    const text = ['fn f() {', 'let s = "界'].join('\n');
    const opened = await a.call('stream.open', data({ sources: [source('stream', text)] })); assert.equal(opened.status, 'ok');
    const first = opened.body.sources[0]; coverage(first, text); assert.equal(first.revision, 1);
    assert.equal(first.counters.committed_line_calls, 1); assert.equal(opened.body.vocabulary, vocabulary);
    const batch = await b.call('highlight', data({ sources: [source('finite', 'let x = 1;\n'), source('empty', '')] }));
    assert.equal(batch.status, 'ok'); assert.equal(batch.body.sources.length, 2);
    assert.ok(batch.body.sources.every(s => s.complete && !Object.hasOwn(s, 'lease')));
    const styled = await b.call('styles.resolve', generic(first.contexts));
    assert.equal(styled.status, 'ok'); assert.equal(styled.body.rules, ruleFingerprint);
    assert.equal(styled.body.indices.length, first.contexts.length); assert.equal(Object.hasOwn(styled.body, 'palette'), false);

    const ids = [...new Set(first.contexts.flatMap(row => row.slice(1)))];
    assert.ok(ids.length >= 2, 'real Rust SOURCE provides two registered scope IDs');
    const backlog = Array.from({ length: 4096 }, (_, i) => [0, ids[i % 2], ...Array(15).fill(ids[0])]);
    const before = await meta('describe'); assert.equal(before.body.runtime.data_jobs, 0);
    const styleSettlements = [];
    const observeStyle = (name, promise) => {
      const observed = promise.then(reply => { styleSettlements.push(name); return reply; }, error => { styleSettlements.push(name); throw error; });
      void observed.catch(() => {}); return observed;
    };
    const stylesA = observeStyle('a', a.call('styles.resolve', generic(backlog)));
    const stylesB = observeStyle('b', a.call('styles.resolve', generic(backlog)));
    const during = await until(async () => {
      assert.equal(styleSettlements.length, 0, 'STYLE must not settle before both generic admissions are observed');
      const current = await meta('describe'); assert.equal(current.status, 'ok');
      return current.body.runtime.data_jobs === 2 ? current : undefined;
    }, 'both generic STYLE credits outstanding');
    assert.deepEqual({ dataJobs: during.body.runtime.data_jobs, settledStyles: [...styleSettlements] }, { dataJobs: 2, settledStyles: [] });
    const peerReply = await b.call('highlight', data({ sources: [source('peer-during-style', 'fn peer(){}\n')] })); assert.equal(peerReply.status, 'ok');
    const afterPeerProgress = await meta('describe'); assert.equal(afterPeerProgress.status, 'ok');
    assert.deepEqual({ dataJobs: afterPeerProgress.body.runtime.data_jobs, settledStyles: [...styleSettlements] }, { dataJobs: 2, settledStyles: [] });
    const overlapWitness = { metadata: during.body.runtime, afterPeer: afterPeerProgress.body.runtime, settledStyles: [...styleSettlements] };
    const firstStyles = await stylesA; assert.equal(firstStyles.status, 'ok'); assert.equal(firstStyles.body.indices.length, backlog.length);
    const secondStyles = await stylesB; assert.equal(secondStyles.status, 'ok'); assert.equal(secondStyles.body.rules, ruleFingerprint);
    assert.equal(firstStyles.body.rules, secondStyles.body.rules);

    const controller = new AbortController();
    const cancelled = a.call('styles.resolve', generic(backlog), { signal: controller.signal }); controller.abort();
    const cancellation = await cancelled.then(reply => {
      if (reply.status === 'error') { assert.equal(reply.error.code, 'cancelled'); assert.ok(['started', 'not_started'].includes(reply.error.execution)); return `native-${reply.error.execution}`; }
      assert.equal(reply.status, 'ok'); assert.equal(reply.body.indices.length, backlog.length); return 'completed-before-cancel';
    }, error => { assert.ok(error instanceof SubcError); assert.equal(error.code, 'cancelled'); return 'public-sdk-cancelled'; });
    await until(async () => (await meta('describe')).body.runtime.data_jobs === 0, 'actual cancelled STYLE ownership settlement');

    const suffix = ['🙂";', '}'].join('\n');
    const appended = await a.call('stream.append', data(append(first, suffix)));
    assert.equal(appended.status, 'ok'); const second = appended.body.sources[0]; coverage(second, text + suffix);
    assert.equal(second.lease, first.lease); assert.equal(second.revision, 2); assert.equal(second.counters.committed_line_calls, 1);
    const retainedRules = await a.call('styles.resolve', generic(first.contexts));
    assert.equal(retainedRules.status, 'ok'); assert.equal(retainedRules.body.rules, ruleFingerprint, 'generic rules survive SOURCE append without a profile receipt');
    const old = await a.call('describe', { v: 3 }); assert.equal(old.error.code, 'protocol_mismatch'); assert.equal(old.error.execution, 'not_started');
    await a.close(); const afterPeer = await b.call('highlight', data({ sources: [source('survivor', 'let survivor = 1;\n')] })); assert.equal(afterPeer.status, 'ok');
    const after = await b.call('describe'); assert.equal(after.body.runtime.leases, 0); assert.equal(after.body.runtime.data_jobs, 0);
    assert.equal(before.body.runtime.leases, 1);
    console.log(JSON.stringify({ semanticSharedV4: true, node: process.version, sourceNativeTree: inputs.source.nativeTree,
      helperSha256: inputs.native.sha256, hostSha256: inputs.sharedHost.sha256, managedPid: descriptor.body.runtime.pid,
      operations: descriptor.body.operations, sourceRevisions: [first.revision, second.revision],
      styleContexts: [0, first.contexts.length, backlog.length], concurrentGenericStyles: 2,
      independentMetadataAndPeer: overlapWitness, publicSdkStyleCancellationSettled: cancellation,
      remainingLeases: after.body.runtime.leases, physicalJobs: after.body.runtime.data_jobs }));
  } finally { await host.close(); }
});
