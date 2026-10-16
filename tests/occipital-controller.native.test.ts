import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { SourceController, CONTROLLER_LIMITS, sourceReservation, type SourceDemand } from '../src/occipital/controller.ts';
import { decodeSources, PROTOCOL_VERSION, type Description } from '../src/occipital/protocol.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import { RequestFailure } from '../src/occipital/request-failure.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';
import { StdioTransport } from '../src/occipital/stdio.ts';
import { ProviderBroker } from '../src/occipital/provider.ts';
import { RetentionPool, RETENTION_LIMITS } from '../src/occipital/retention.ts';
import { awaitFixture } from './fixtures/await-fixture.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SyntaxClient } from '../src/occipital/client.ts';
import { CardSources, type CardSourceInput } from '../src/syntax/cards.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readInputs, validateNative } from '../scripts/test/context.mjs';
const binary = validateNative(readInputs()).path;
const fingerprint = 'a'.repeat(64);
function demand(text: string, version = 1, complete = false, key = 'source'): SourceDemand {
  return { key, version, text, language: 'bash', profile: 'pi', fingerprint, complete };
}
function ranges(controller: SourceController, key = 'source') {
  const rows: number[][] = []; controller.visitRanges(key, (a, b, s) => rows.push([a, b, s])); return rows;
}
async function settle() { await turn(); }

test('actual product stdio controller opens, coalesces, finalizes and retains native parse counters', {}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-controller-'));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root };
  const transport = new StdioTransport({ command: binary, args: ['--stdio', '--config', join(root, 'config.json')], env, cwd: root, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => transport });
  let changes = 0;
  const c = new SourceController(broker, { deadlineMs: 5000, onChange: () => { changes++; } });
  try {
    await awaitFixture(broker.start()); const profile = broker.snapshot().description!.profiles.find(p => p.id === 'pi')!;
    const d = { ...demand('echo α\necho t'), fingerprint: profile.fingerprint }; c.observe(d); c.flush();
    await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })()); assert.equal(c.status('source')!.committedBytes, Buffer.byteLength('echo α\n'));
    c.observe({ ...d, version: 2, text: d.text + 'ail' }); c.observe({ ...d, version: 3, text: d.text + 'ail\n' }); c.flush();
    await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    c.observe({ ...d, version: 3, text: d.text + 'ail\n', complete: true }); c.flush();
    await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().dispatches, 3); assert.equal(c.stats().remoteLeases, 0);
    assert.equal(changes, 3);
    assert.equal(c.stats().committedLineCalls, 2); assert.equal(c.stats().tailCalls, 1); assert.equal(c.stats().retention.prefixCopiedBytes, 0);
    assert.equal(c.stats().preparedBytes, Buffer.byteLength(d.text) + 4); assert.equal(c.stats().transientBytes, 0);
    const fullText = d.text + 'ail\n', descriptor = broker.snapshot().description!;
    const wire = await awaitFixture(broker.request(broker.snapshot().generation, { v: PROTOCOL_VERSION, ticket: 'independent-batch', instance: descriptor.instance,
      op: 'highlight', admission: 'bounded_queue', queue_wait_ms: 1000, sources: [{ key: 'control', generation: 1, source_version: 3,
        profile: 'pi', fingerprint: profile.fingerprint, hint: { language: 'bash' }, text: fullText }] }, { deadlineMs: 5000 }));
    const chunk = decodeSources(wire, 'independent-batch', descriptor, [{ key: 'control', generation: 1, source_version: 3,
      profile: 'pi', fingerprint: profile.fingerprint, revision: 1, replace_from: 0, source_bytes: Buffer.byteLength(fullText), complete: true, replacementText: fullText }])[0]!;
    const independent: number[][] = []; let from = 0;
    for (let i = 0; i < chunk.runs.length; i += 2) { independent.push([from, chunk.runs[i]!, chunk.runs[i + 1]!]); from = chunk.runs[i]!; }
    const coalesce = (input: number[][]) => { const result: number[][] = []; for (const row of input) {
      const prior = result.at(-1); if (prior && prior[1] === row[0] && prior[2] === row[2]) prior[1] = row[1]!; else result.push([...row]);
    } return result; };
    assert.deepEqual(coalesce(ranges(c)), coalesce(independent));
    c.observe({ ...demand('cleanup\ntail', 1, false, 'cleanup'), fingerprint: profile.fingerprint }); c.flush();
    await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    c.remove('cleanup'); c.flush(); await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    assert.equal(c.stats().dispatches, 5); assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().transientBytes, 0);
    assert.equal(changes, 4); // native close is bookkeeping, not another color change.
  } finally { c.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
});

test('review F2 pressure: six actual source bytes recover once after restart admission evicts completed colors', {}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-controller-pressure-'));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root };
  const pipe = new StdioTransport({ command: binary, args: ['--stdio', '--config', join(root, 'config.json')], env, cwd: root, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => pipe });
  // Only generation notification is controlled; this is not a physical loss/failover proof.
  let generation = 1;
  const provider = { snapshot: () => ({ ...broker.snapshot(), generation }), isReady: (g: number) => g === generation && broker.snapshot().availability === 'ready',
    classificationAccepted: (g: number) => g === generation && broker.classificationAccepted(broker.snapshot().generation),
    request: (_g: number, r: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineMs?: number }) => broker.request(broker.snapshot().generation, r, options) };
  const c = new SourceController(provider, { retention: { maxBytes: 2200 }, deadlineMs: 5000 });
  try {
    await awaitFixture(broker.start()); const profile = broker.snapshot().description!.profiles.find(p => p.id === 'pi')!;
    const d = { ...demand('echo x', 1, true), fingerprint: profile.fingerprint };
    c.observe(d); c.flush(); await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    const original = ranges(c); assert.deepEqual(original, [[0, 4, 6], [4, 6, 0]]);
    assert.ok(c.stats().retention.retainedBytes > 1800 && c.stats().retention.retainedBytes <= 2200);
    generation++; c.observe(d); assert.equal(c.stats().retention.rangeBytes, 0); c.flush();
    assert.equal(c.stats().dispatches, 2); assert.equal(c.stats().preparedBytes, 12);
    assert.equal(c.status('source')!.acknowledgedVersion, undefined);
    await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    assert.equal(c.status('source')!.exact, true); assert.deepEqual(ranges(c), original);
    const before = c.stats(); for (let i = 0; i < 10; i++) { c.observe(d); c.flush(); ranges(c); }
    assert.deepEqual(c.stats(), before); assert.equal(c.stats().dispatches, 2);
    assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().remoteLeases, 0);
  } finally { c.dispose(); await awaitFixture(broker.dispose()); assert.equal(c.stats().bookkeepingBytes, 0); await rm(root, { recursive: true, force: true }); }
});

test('real owned exits stop after two restarts; a validated six-byte classification opens a fresh pair', {}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-crash-budget-'));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root };
  const pipes: StdioTransport[] = [];
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => {
    const pipe = new StdioTransport({ command: binary, args: ['--stdio', '--config', join(root, 'config.json')], env, cwd: root, requestDeadlineMs: 5000, terminateGraceMs: 100 });
    pipes.push(pipe); return pipe;
  } });
  const c = new SourceController(broker);
  async function exitAndRecover() {
    const generation = broker.snapshot().generation, pipe = pipes.at(-1)!;
    process.kill(pipe.stats().pid!, 'SIGKILL');
    await awaitFixture(pipe.ended); assert.equal(pipe.endReason, 'lost');
    await awaitFixture(broker.start()); // Published end observer already started this generation's recovery.
    assert.notEqual(broker.snapshot().generation, generation);
    assert.equal(pipe.stats().childState, 'exited'); assert.throws(() => process.kill(pipe.stats().pid!, 0), {code:'ESRCH'});
    assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().liveTimers, 0); assert.equal(pipe.stats().ownedListeners, 0);
  }
  try {
    await awaitFixture(broker.start());
    await exitAndRecover(); await exitAndRecover();
    assert.equal(pipes.length, 3); assert.equal(broker.stats().ownedRestarts, 2);
    const profile = broker.snapshot().description!.profiles.find(p => p.id==='pi')!;
    const d = {...demand('echo x', 1, true), fingerprint:profile.fingerprint};
    c.observe(d); c.flush(); await awaitFixture((async () => { while (c.stats().unsettledJobs) await turn(); })());
    assert.equal(c.status(d.key)!.exact, true); assert.equal(c.stats().dispatches, 1);
    assert.equal(broker.stats().successfulClassifications, 1);
    const retained = ranges(c); assert.deepEqual(retained, [[0, 4, 6], [4, 6, 0]]);
    await exitAndRecover(); await exitAndRecover(); await exitAndRecover();
    assert.equal(pipes.length, 5); assert.equal(broker.stats().ownedRestarts, 4);
    assert.equal(broker.stats().ownedRestartStops, 1); assert.equal(broker.snapshot().reason, 'restart_limit');
    c.observe(d); c.flush(); assert.deepEqual(ranges(c), retained); assert.equal(c.status(d.key)!.exact, true);
    assert.equal(c.stats().dispatches, 1); assert.equal(broker.stats().sourceDispatches, 1);
  } finally {
    c.dispose(); await awaitFixture(broker.dispose());
    for (const pipe of pipes) await awaitFixture(pipe.close());
    await rm(root, {recursive:true,force:true});
  }
});

test('theme burst: 100 ten-millisecond previews converge through genuinely unsettled product stdio replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-theme-burst-'));
  const report = join(root, 'gate.json');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root };
  const pipe = new StdioTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/occipital-reply-gate.mjs', import.meta.url)), binary, report], env, cwd: root,
    requestDeadlineMs: 10000, terminateGraceMs: 100 });
  type Owner = { input: CardSourceInput };
  let cards: CardSources<Owner> | undefined, reads = 0, saves = 0, piCalls = 0;
  const client = new SyntaxClient({ standaloneVersion: 'test', settings: {
    load: async () => ({ ok: true as const, syntaxTheme: { kind: 'pi' as const } }),
    update: async () => { saves++; return { ok: true as const }; }
  }, provider: { tryShared: async () => undefined, acquireOwned: async () => pipe },
    onChange: () => cards?.metadataChanged(), onSourceChange: keys => cards?.sourceChanged(keys) });
  const owners = Array.from({ length: 20 }, (_, i): Owner => ({ input: i % 2 ? {
    kind: 'file', palette: 1, language: 'typescript', node: { toolName: 'write', args: { path: `source-${i}.ts`, content: `const x${i} = 1;\n` }, result: {}, isPartial: false }
  } : { kind: 'bash', args: { command: `echo source-${i}` }, palette: 1, language: 'bash', complete: true } }));
  async function until(predicate: () => boolean | Promise<boolean>) {
    await awaitFixture((async () => { while (!await predicate()) await delay(2); })(), 10000);
  }
  async function gate() { return JSON.parse(await readFile(report, 'utf8')) as { data: { profile: string; key: string }[]; cancelled: number; held: number; peakHeld: number }; }
  try {
    await awaitFixture(client.start());
    cards = new CardSources(client, { read: owner => { reads++; return owner.input; }, classify: () => { piCalls++; return ['']; }, invalidate() {}, requestRender() {} });
    for (const owner of owners) cards.useful(owner, 1);
    await until(() => owners.every(owner => { const key = cards!.identities(owner)[0]?.key; return key && client.sources.status(key)?.exact; }));
    const baseline = client.sources.stats(), baselineReads = reads;
    const profiles = client.snapshot().provider.description!.profiles.filter(profile => profile.id !== 'pi');
    assert.ok(profiles.length >= 2);
    await pipe.request({ v: PROTOCOL_VERSION, op: 'describe', ticket: 'gate-arm' });
    client.previewTheme({ kind: 'occipital', id: profiles[0]!.id });
    await until(async () => (await gate()).held === 2);
    assert.equal(pipe.stats().unsettledData, 2, 'actual transport promises, not post-transport callbacks, are held');
    const heldReads = reads, heldBytes = client.sources.stats().preparedBytes;
    for (let i = 1; i < 100; i++) {
      await delay(10);
      client.previewTheme({ kind: 'occipital', id: profiles[i % 2]!.id });
    }
    await settle();
    assert.equal(reads, heldReads); assert.equal(client.sources.stats().preparedBytes, heldBytes);
    assert.equal(pipe.stats().unsettledData, 2); assert.equal((await gate()).cancelled, 0);
    for (const owner of owners) assert.equal(client.sources.displayBasis(cards.identities(owner)[0]!.key)?.profile, 'pi');
    await pipe.request({ v: PROTOCOL_VERSION, op: 'describe', ticket: 'gate-release' });
    const final = profiles[1]!;
    await until(() => owners.every(owner => client.sources.displayBasis(cards!.identities(owner)[0]!.key)?.profile === final.id));
    await until(() => client.sources.stats().unsettledJobs === 0);
    const observed = await gate(), updates = observed.data.slice(baseline.dispatches);
    assert.equal(updates.length, owners.length + 2);
    assert.ok(updates.slice(2).every(request => request.profile === final.id));
    assert.equal(reads - baselineReads, owners.length + 2);
    assert.equal(observed.cancelled, 0); assert.equal(observed.peakHeld, 2);
    assert.equal(saves, 0); assert.equal(piCalls, 0); assert.equal(client.sources.stats().peakJobs, 2);
    assert.ok(client.sources.stats().retention.retainedBytes < baseline.retention.retainedBytes * 3);
    const warm = client.sources.stats(); for (let i = 0; i < 20; i++) { for (const owner of owners) cards.useful(owner, 1); client.sources.flush(); }
    assert.deepEqual(client.sources.stats(), warm); assert.equal(reads, baselineReads + owners.length + 2);
  } finally {
    cards?.dispose(); await awaitFixture(client.dispose()); await awaitFixture(pipe.close());
    assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().liveTimers, 0);
    assert.equal(client.sources.stats().bookkeepingBytes, 0); assert.equal(client.sources.stats().globalUnsettledJobs, 0);
    await rm(root, { recursive: true, force: true });
  }
});
