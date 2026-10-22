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
import { childEnv, readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';

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
const theme = (color, workload = false) => {
  // Admitted multi-scope rules exercise matching rather than an empty-context no-op.
  const selectors = workload ? Array.from({ length: 256 }, () => `<dict><key>scope</key><string>${Array(8).fill('source.rust').join(' ')}</string><key>settings</key><dict><key>foreground</key><string>${color}</string></dict></dict>`).join('') : '';
  return `<plist><dict><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>${color}</string></dict></dict>${selectors}</array></dict></plist>`;
};

// This producer-level control uses the public SDK and private host roots,
// independently from the production SyntaxClient/Pi integration.
async function launch() {
  assert.ok(inputs.sharedHost?.path, 'explicit prepared host required');
  assert.equal(hash(await readFile(inputs.sharedHost.path)), inputs.sharedHost.sha256);
  const root = await mkdtemp(join(tmpdir(), 'semantic-rpc-'));
  const env = childEnv(root, { SUBC_CGROUP_PLACEMENT: 'disabled' });
  const themes = join(root, 'themes'), config = join(root, 'occipital.json');
  await mkdir(themes, { mode: 0o700 });
  const themeFile = join(themes, 'semantic.tmTheme'); await writeFile(themeFile, theme('#223344', true));
  await writeFile(config, JSON.stringify({ themeDirectories: ['themes'] }));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`, wrapper = join(root, 'module');
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(resolve(binary))} --config ${quote(config)} "$@"\n`); await chmod(wrapper, 0o700);
  const directory = join(env.XDG_CONFIG_HOME, 'cortexkit'); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'subc.jsonc'), JSON.stringify({ version: 1, modules: { occipital: { program: wrapper, reserved: true } } }), { mode: 0o600 });
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
      await until(async () => { try { return await client.resolveProvider('syntax-highlight/v3') === 'occipital'; } catch (error) { if (error.code === 'capability_unprovided') return false; throw error; } }, 'v3 capability publication');
      const route = await client.routeOpen({ kind: 'internal_service', module_id: 'occipital', service_id: 'syntax' }, { project_root: root, harness: 'native-semantic-rpc', session }, { consumerIdentity: null });
      let sequence = 0;
      const call = async (op, fields = {}, options = {}) => {
        const reply = await client.request(route, Buffer.from(JSON.stringify({ v: 3, ticket: `${session}-${++sequence}`, op, ...fields })), { binary: false, timeoutMs: 10000, ...options });
        assert.equal(reply.v, 3); assert.match(reply.assets, /^[0-9a-f]{64}$/); return reply;
      };
      const description = await call('describe'); assert.equal(description.status, 'ok'); pids.add(description.body.runtime.pid);
      return { client, route, call, description, close: () => client.closeRoute(route) };
    };
    return { peer, themeFile, close, pids, hostPid: host.pid };
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

test('native v3 semantic RPC: real managed shared source/style/control routes preserve peer, leases and cleanup', { timeout: 120000 }, async () => {
  const host = await launch();
  try {
    const a = await host.peer('a'), b = await host.peer('b');
    const descriptor = a.description, instance = descriptor.instance, vocabulary = descriptor.body.vocabulary.fingerprint;
    assert.equal(descriptor.body.capability, 'syntax-highlight/v3'); assert.equal(descriptor.body.protocol_version, 3);
    assert.equal(descriptor.body.assets, descriptor.assets); assert.ok(descriptor.body.operations.includes('styles.resolve'));
    assert.ok(descriptor.body.profiles.every(p => p.id !== 'pi')); assert.equal(descriptor.body.runtime.pid, b.description.body.runtime.pid);
    const meta = op => a.call(op, { instance });
    const data = fields => ({ instance, admission: 'bounded_queue', queue_wait_ms: 1000, ...fields });
    const selected = descriptor.body.profiles.find(p => p.id.startsWith('custom:')); assert.ok(selected);
    const native = (contexts, profile = selected) => data({ vocabulary, contexts, rules: { kind: 'native', id: profile.id, fingerprint: profile.fingerprint } });
    const palette = await a.call('styles.resolve', native([])); assert.equal(palette.status, 'ok'); assert.deepEqual(palette.body.indices, []); assert.equal(palette.body.palette.slots.length, 26);
    assert.equal(palette.body.rules, hash(`occipital-native-rules/2\0${selected.fingerprint}`)); assert.equal(palette.body.palette.fingerprint, hash(`occipital-native-palette/2\0${selected.fingerprint}`));
    const text = 'fn f() {\nlet s = "界';
    const opened = await a.call('stream.open', data({ sources: [source('stream', text)] })); assert.equal(opened.status, 'ok');
    const first = opened.body.sources[0]; coverage(first, text); assert.equal(first.revision, 1); assert.equal(first.counters.committed_line_calls, 1); assert.equal(opened.body.vocabulary, vocabulary);
    const batch = await b.call('highlight', data({ sources: [source('finite', 'let x = 1;\n'), source('empty', '')] })); assert.equal(batch.status, 'ok'); assert.equal(batch.body.sources.length, 2); assert.ok(batch.body.sources.every(s => s.complete && !Object.hasOwn(s, 'lease')));
    const declaration = { revision: 1, binding_slots: 1, default: { foreground: { kind: 'binding', slot: 0 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }, rules: [] };
    const generic = await b.call('styles.resolve', data({ vocabulary, contexts: first.contexts, rules: { kind: 'client', definition: declaration } })); assert.equal(generic.status, 'ok'); assert.equal(generic.body.palette, null); assert.equal(generic.body.indices.length, first.contexts.length); assert.ok(generic.body.styles.every(s => s.foreground.kind === 'binding'));
    // No other data calls exist in this interval. Before peer submission and
    // after its actual SDK settlement, two physical jobs can only be the styles.
    const ids = [...new Set(first.contexts.flatMap(row => row.slice(1)))];
    assert.ok(ids.length >= 2, 'real Rust SOURCE provides two registered scope IDs');
    // Exactly 65,536 expanded IDs, below the 2 MiB decoded charge and 512 KiB
    // wire limits. Alternating the first scope prevents identical-path reuse.
    const backlog = Array.from({ length: 4096 }, (_, i) => [0, ids[i % 2], ...Array(15).fill(ids[0])]);
    const before = await meta('describe'); assert.equal(before.body.runtime.data_jobs, 0);
    const styleSettlements = [];
    const observeStyle = (name, promise) => {
      const observed = promise.then(reply => { styleSettlements.push(name); return reply; }, error => { styleSettlements.push(name); throw error; });
      // Failed overlap assertions still close clients with pending requests.
      void observed.catch(() => {}); return observed;
    };
    const stylesA = observeStyle('a', a.call('styles.resolve', native(backlog)));
    const stylesB = observeStyle('b', a.call('styles.resolve', native(backlog)));
    const during = await until(async () => {
      assert.equal(styleSettlements.length, 0, 'STYLE must not settle before both native admissions are observed');
      const current = await meta('describe'); assert.equal(current.status, 'ok');
      return current.body.runtime.data_jobs === 2 ? current : undefined;
    }, 'both STYLE native credits outstanding');
    assert.deepEqual({ dataJobs: during.body.runtime.data_jobs, settledStyles: [...styleSettlements] }, { dataJobs: 2, settledStyles: [] }, 'overlap: both style jobs must remain physically outstanding during metadata before peer submission');
    const peerReply = await b.call('highlight', data({ sources: [source('peer-during-style', 'fn peer(){}\n')] })); assert.equal(peerReply.status, 'ok');
    const afterPeerProgress = await meta('describe'); assert.equal(afterPeerProgress.status, 'ok');
    assert.deepEqual({ dataJobs: afterPeerProgress.body.runtime.data_jobs, settledStyles: [...styleSettlements] }, { dataJobs: 2, settledStyles: [] }, 'overlap: both style jobs must remain physically outstanding after peer SDK settlement');
    const overlapWitness = { metadata: during.body.runtime, afterPeer: afterPeerProgress.body.runtime, settledStyles: [...styleSettlements] };
    const stale = await stylesA; assert.equal(stale.status, 'ok'); assert.equal(stale.body.indices.length, backlog.length);
    await writeFile(host.themeFile, theme('#667788')); const refreshed = await meta('themes.refresh'); assert.equal(refreshed.status, 'ok');
    const changed = refreshed.body.profiles.find(p => p.id === selected.id); assert.ok(changed); assert.notEqual(changed.fingerprint, selected.fingerprint);
    const staleOther = await stylesB;
    // A queued request has no compiled owner until its entitled turn. Refresh
    // may therefore reject it; already-started work retains the original owner.
    let queuedStyleSettlement;
    if (staleOther.status === 'ok') { assert.equal(staleOther.body.rules, palette.body.rules); queuedStyleSettlement = 'original-definition'; }
    else { assert.equal(staleOther.error.code, 'profile_changed'); assert.equal(staleOther.error.execution, 'not_started'); queuedStyleSettlement = 'profile-changed-before-start'; }
    assert.equal(stale.body.rules, palette.body.rules); assert.equal(stale.body.palette.fingerprint, palette.body.palette.fingerprint);
    const controller = new AbortController();
    const cancelled = a.call('styles.resolve', native(backlog, changed), { signal: controller.signal });
    // CANCEL is best effort. Native JSON, public SDK cancellation, or a result
    // already committed to the SDK are distinct legitimate terminal outcomes.
    // Deterministic worker controls separately require exact start/ready states.
    controller.abort();
    const cancellation = await cancelled.then(reply => {
      if (reply.status === 'error') { assert.equal(reply.error.code, 'cancelled'); assert.ok(['started', 'not_started'].includes(reply.error.execution)); return `native-${reply.error.execution}`; }
      assert.equal(reply.status, 'ok'); assert.equal(reply.body.indices.length, backlog.length); return 'completed-before-cancel';
    }, error => { assert.ok(error instanceof SubcError); assert.equal(error.code, 'cancelled'); return 'public-sdk-cancelled'; });
    await until(async () => (await meta('describe')).body.runtime.data_jobs === 0, 'actual cancelled style ownership settlement');
    const suffix = '🙂";\n}'; const appended = await a.call('stream.append', data(append(first, suffix))); assert.equal(appended.status, 'ok'); const second = appended.body.sources[0]; coverage(second, text + suffix); assert.equal(second.lease, first.lease); assert.equal(second.revision, 2); assert.equal(second.counters.committed_line_calls, 1);
    const rejected = await a.call('styles.resolve', native(first.contexts)); assert.equal(rejected.error.code, 'profile_changed'); assert.equal(rejected.error.execution, 'not_started');
    const replacement = await a.call('styles.resolve', native(first.contexts, changed)); assert.equal(replacement.status, 'ok'); assert.notEqual(replacement.body.rules, stale.body.rules);
    const final = await a.call('stream.append', data(append(second, '', true))); assert.equal(final.status, 'ok'); const last = final.body.sources[0]; assert.equal(last.revision, 3); assert.equal(last.lease, first.lease); assert.equal(last.complete, true); assert.equal(last.committed_bytes, Buffer.byteLength(text + suffix)); assert.deepEqual(last.counters, { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 });
    for (let n = 0; n < 2; n++) assert.equal((await a.call('stream.close', { instance, key: last.key, generation: last.generation, lease: last.lease })).body.kind, 'closed');
    const old = await a.call('describe', { v: 2 }); assert.equal(old.error.code, 'protocol_mismatch'); assert.equal(old.error.execution, 'not_started');
    await a.close(); const afterPeer = await b.call('highlight', data({ sources: [source('survivor', 'let survivor = 1;\n')] })); assert.equal(afterPeer.status, 'ok');
    const after = await b.call('describe'); assert.equal(after.body.runtime.leases, 0); assert.equal(after.body.runtime.data_jobs, 0); assert.equal(before.body.runtime.leases, 1);
    console.log(JSON.stringify({ nativeSemanticShared: true, node: process.version, protocol: 3, sourceNativeTree: inputs.source.nativeTree, helperSha256: inputs.native.sha256, hostSha256: inputs.sharedHost.sha256, managedPid: descriptor.body.runtime.pid, finiteOperations: 3, finiteSources: batch.body.sources.length + peerReply.body.sources.length + afterPeer.body.sources.length, streamRevisions: [first.revision, second.revision, last.revision], styleContexts: [0, first.contexts.length, backlog.length, backlog.length], paletteSlots: 26, sourceParsesAfterThemeRefresh: second.counters.committed_line_calls, finalParserCalls: last.counters.committed_line_calls + last.counters.tail_calls, independentMetadataAndPeer: overlapWitness, publicSdkStyleCancellationSettled: cancellation, queuedStyleSettlement, remainingLeases: after.body.runtime.leases, physicalJobs: after.body.runtime.data_jobs }));
  } finally { await host.close(); }
});
