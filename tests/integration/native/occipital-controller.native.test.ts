import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceController, type SourceDemand } from '../../../src/occipital/controller.ts';
import { decodeSemanticSourceReply, SEMANTIC_PROTOCOL_VERSION as VERSION } from '../../../src/occipital/semantic-protocol.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { ownedStyleSelection } from '../../fixtures/owned-style-selection.ts';

const inputs = readInputs(), binary = validateNative(inputs);
function demand(text: string, version = 1, complete = false, key = 'source'): SourceDemand {
  return { key, version, text, language: 'bash', complete };
}
function semanticRows(controller: SourceController, key = 'source') {
  const pool = Reflect.get(controller, 'pool'); assert.ok(pool instanceof SemanticRetentionPool);
  const status = controller.status(key)!;
  const states = Reflect.get(controller, 'states'); assert.ok(states instanceof Map);
  const current = status.generation === undefined ? undefined : pool.status(status.generation);
  const generation = current?.sourceVersion === undefined ? states.get(key)?.previous : status.generation;
  assert.equal(typeof generation, 'number');
  const rows: { from: number; to: number; context: number[] | null }[] = [];
  const vocabulary = pool.status(generation)!.vocabulary!;
  assert.equal(pool.visitRanges(generation, (from, to, context) => {
    const encoded = context ? pool.arena.encode(vocabulary, [context], () => true) : undefined;
    rows.push({ from, to, context: encoded ? encoded[0]!.slice(1) : null });
  }), true);
  return rows;
}
function coalesce(rows: ReturnType<typeof semanticRows>) {
  const result: ReturnType<typeof semanticRows> = [];
  for (const row of rows) {
    const prior = result.at(-1);
    if (prior && prior.to === row.from && JSON.stringify(prior.context) === JSON.stringify(row.context)) prior.to = row.to;
    else result.push({ ...row });
  }
  return result;
}
async function drain(controller: SourceController) {
  await awaitFixture((async () => {
    for (let i = 0; i < 4 || controller.stats().unsettledJobs || controller.stats().pendingCloses; i++) { controller.flush(); await turn(); }
  })());
}
function environment(root: string) {
  return { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root };
}
function pipe(root: string) {
  return new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], env: environment(root), cwd: root,
    requestDeadlineMs: 5000, terminateGraceMs: 100 });
}
function cleaned(transport: StdioTransport, controller: SourceController) {
  assert.equal(transport.stats().childState, 'exited');
  assert.equal(transport.stats().ownedListeners, 0); assert.equal(transport.stats().liveTimers, 0); assert.equal(transport.stats().retainedBytes, 0);
  assert.throws(() => process.kill(transport.stats().pid!, 0), { code: 'ESRCH' });
  assert.equal(controller.stats().bookkeepingBytes, 0); assert.equal(controller.stats().globalUnsettledJobs, 0);
  assert.equal(controller.stats().globalTransientBytes, 0); assert.equal(controller.stats().retention.retainedBytes, 0);
}

test('actual product stdio controller opens, coalesces, finalizes and resolves common styles independently of parse counters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-controller-')), transport = pipe(root);
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => transport });
  const c = new SourceController(broker, { deadlineMs: 5000 });
  try {
    await awaitFixture(broker.start());
    c.setStyleSelection(ownedStyleSelection());
    const d = demand('echo α\necho t'); c.observe(d); c.flush(); await drain(c);
    assert.equal(c.status('source')!.committedBytes, Buffer.byteLength('echo α\n'));
    assert.ok(c.displayBasis('source')); assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().styleDispatches, 1);
    c.observe({ ...d, version: 2, text: d.text + 'ail' }); c.observe({ ...d, version: 3, text: d.text + 'ail\n' }); c.flush(); await drain(c);
    c.observe({ ...d, version: 3, text: d.text + 'ail\n', complete: true }); c.flush(); await drain(c);
    assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().remoteLeases, 0);
    assert.equal(broker.stats().sourceDispatches, 3); assert.equal(c.stats().committedLineCalls, 2); assert.equal(c.stats().tailCalls, 1);
    assert.equal(c.stats().retention.prefixCopiedBytes, 0); assert.equal(c.stats().preparedBytes, Buffer.byteLength(d.text) + 4);
    const fullText = d.text + 'ail\n', descriptor = broker.snapshot().description!;
    const source = { key: 'control', generation: 1, source_version: 3, hint: { language: 'bash' }, text: fullText };
    const raw = await awaitFixture(broker.request(broker.snapshot().generation, { v: VERSION, ticket: 'independent-batch', instance: descriptor.instance,
      op: 'highlight', admission: 'bounded_queue', queue_wait_ms: 1000, sources: [source] }, { deadlineMs: 5000 }));
    const chunk = decodeSemanticSourceReply(raw, 'independent-batch', descriptor, [{ key: source.key, generation: 1, source_version: 3,
      revision: 1, replace_from: 0, source_bytes: Buffer.byteLength(fullText), complete: true, replacementText: fullText }], 16384).sources[0]!;
    const independent: ReturnType<typeof semanticRows> = []; let from = 0;
    for (let i = 0; i < chunk.runs.length; i += 2) {
      const to = chunk.runs[i]!, context = chunk.runs[i + 1]!;
      independent.push({ from, to, context: context ? [...chunk.contexts[context - 1]!] : null }); from = to;
    }
    assert.deepEqual(coalesce(semanticRows(c)), coalesce(independent));
    const warm = c.stats(), wire = broker.stats();
    for (let i = 0; i < 100; i++) { c.observe({ ...d, version: 3, text: fullText, complete: true }); c.flush(); c.displayBasis('source'); }
    await drain(c); assert.deepEqual(c.stats(), warm); assert.deepEqual(broker.stats(), wire);
    c.observe(demand('cleanup\ntail', 1, false, 'cleanup')); c.flush(); await drain(c);
    c.remove('cleanup'); c.flush(); await drain(c);
    assert.equal(broker.stats().sourceDispatches, 6, 'three original parses, independent batch, cleanup open and actual close');
    assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().transientBytes, 0);
    assert.equal(c.stats().dispatches, 5 + broker.stats().styleDispatches, 'separate styles and close are counted, not filtered away');
    console.log(JSON.stringify({ controllerCommonStyles: { node: process.version, source: inputs.source, native: binary,
      sourceDispatches: broker.stats().sourceDispatches, styleDispatches: broker.stats().styleDispatches,
      dispatches: c.stats().dispatches, preparedBytes: c.stats().preparedBytes, committedLineCalls: c.stats().committedLineCalls,
      tailCalls: c.stats().tailCalls, warmFrames: 100, remoteLeases: c.stats().remoteLeases, transientBytes: c.stats().transientBytes } }));
  } finally { c.dispose(); await awaitFixture(broker.dispose()); cleaned(transport, c); await rm(root, { recursive: true, force: true }); }
});

test('review F2 pressure: six actual source bytes recover once after verified semantic eviction, without a warm parse carousel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-controller-pressure-')), transport = pipe(root);
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => transport });
  const c = new SourceController(broker, { retention: { maxBytes: 8192 }, deadlineMs: 5000 });
  try {
    await awaitFixture(broker.start()); const d = demand('echo x', 1, true);
    c.observe(d); c.flush(); await drain(c);
    const original = coalesce(semanticRows(c)), preload = c.stats().retention.retainedBytes;
    assert.equal(c.status('source')!.exact, true); assert.ok(c.stats().retention.rangeBytes > 0);
    assert.ok(preload > 2200 && preload <= 8192); assert.equal(c.stats().dispatches, 1);
    c.observe(demand('p'.repeat(3000), 1, true, 'pressure'));
    assert.equal(c.status('source')!.generation, undefined, 'the six-byte semantic basis was really evicted');
    assert.ok(c.stats().retention.retainedBytes <= 8192);
    c.remove('pressure'); assert.equal(c.retryEvicted('source'), true); c.observe(d); c.flush(); await drain(c);
    assert.equal(c.stats().dispatches, 2); assert.equal(c.stats().preparedBytes, 12); assert.equal(c.status('source')!.exact, true);
    assert.deepEqual(coalesce(semanticRows(c)), original);
    const before = c.stats(), wire = broker.stats();
    for (let i = 0; i < 100; i++) { c.observe(d); c.flush(); c.status('source'); }
    assert.deepEqual(c.stats(), before); assert.deepEqual(broker.stats(), wire);
    assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().remoteLeases, 0);
    console.log(JSON.stringify({ pressureNative: { preload, maxBytes: 8192, pressureUnits: 3000, sourceDispatches: wire.sourceDispatches,
      preparedBytes: before.preparedBytes, warmFrames: 100 } }));
  } finally { c.dispose(); await awaitFixture(broker.dispose()); cleaned(transport, c); await rm(root, { recursive: true, force: true }); }
});

test('real owned exits stop after two restarts; only a validated six-byte source classification opens a fresh pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-crash-budget-')), pipes: StdioTransport[] = [];
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => { const transport = pipe(root); pipes.push(transport); return transport; } });
  const c = new SourceController(broker);
  async function exitAndRecover() {
    const generation = broker.snapshot().generation, transport = pipes.at(-1)!;
    process.kill(transport.stats().pid!, 'SIGKILL'); await awaitFixture(transport.ended); assert.equal(transport.endReason, 'lost');
    await awaitFixture(broker.start()); assert.notEqual(broker.snapshot().generation, generation);
    assert.equal(transport.stats().childState, 'exited'); assert.throws(() => process.kill(transport.stats().pid!, 0), { code: 'ESRCH' });
    assert.equal(transport.stats().retainedBytes, 0); assert.equal(transport.stats().liveTimers, 0); assert.equal(transport.stats().ownedListeners, 0);
  }
  try {
    await awaitFixture(broker.start()); await exitAndRecover(); await exitAndRecover();
    assert.equal(pipes.length, 3); assert.equal(broker.stats().ownedRestarts, 2);
    const d = demand('echo x', 1, true); c.observe(d); c.flush(); await drain(c);
    assert.equal(c.status(d.key)!.exact, true); assert.equal(c.stats().dispatches, 1); assert.equal(broker.stats().successfulClassifications, 1);
    const retained = semanticRows(c); assert.ok(retained.length); assert.equal(retained.at(-1)!.to, 6);
    assert.equal(c.displayBasis(d.key), undefined, 'source-only success does not pretend a palette presentation was resolved');
    await exitAndRecover(); await exitAndRecover(); await exitAndRecover();
    assert.equal(pipes.length, 5); assert.equal(broker.stats().ownedRestarts, 4); assert.equal(broker.stats().ownedRestartStops, 1);
    assert.equal(broker.snapshot().reason, 'restart_limit'); c.observe(d); c.flush();
    assert.deepEqual(semanticRows(c), retained); assert.equal(c.status(d.key)!.exact, true);
    assert.equal(c.stats().dispatches, 1); assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().styleDispatches, 0);
  } finally {
    c.dispose(); await awaitFixture(broker.dispose());
    for (const transport of pipes) { await awaitFixture(transport.close()); cleaned(transport, c); }
    await rm(root, { recursive: true, force: true });
  }
});

test('owned palette changes repaint ready groups locally without source replay or STYLE requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-palette-burst-')), transport = pipe(root);
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => transport });
  const c = new SourceController(broker);
  const themes = ['gruvbox-dark', 'nord-dark', 'monokai-dark'] as const;
  const demands = Array.from({ length: 20 }, (_, i) => ({ ...demand(i % 2 ? `const x${i} = 1;\n` : `echo source-${i}`, 1, true, `source-${i}`), language: i % 2 ? 'typescript' : 'bash' }));
  try {
    await awaitFixture(broker.start()); c.setStyleSelection(ownedStyleSelection(themes[0]));
    for (const d of demands) c.observe(d); c.flush(); await drain(c);
    assert.ok(demands.every(d => c.displayBasis(d.key)?.palette === `owned-palette-v1:${themes[0]}`));
    const baseline = c.stats(), sourceDispatches = broker.stats().sourceDispatches, styleDispatches = broker.stats().styleDispatches;
    for (let i = 0; i < 100; i++) {
      const selected = themes[i % themes.length]!;
      c.setStyleSelection(ownedStyleSelection(selected)); c.flush();
    }
    await drain(c);
    assert.ok(demands.every(d => c.displayBasis(d.key)?.palette === `owned-palette-v1:${themes[(99) % themes.length]}`));
    assert.equal(broker.stats().sourceDispatches, sourceDispatches);
    assert.equal(broker.stats().styleDispatches, styleDispatches);
    const warm = c.stats();
    for (let i = 0; i < 100; i++) { for (const d of demands) c.observe(d); c.flush(); }
    await drain(c); assert.deepEqual(c.stats(), warm); assert.ok(baseline.preparedBytes > 0);
    console.log(JSON.stringify({ localPaletteBurst: { node: process.version, helper: binary.sha256, source: inputs.source,
      sourceDispatches, styleDispatches, paletteChanges: 100, warmFrames: 100, preparedBytes: warm.preparedBytes, transientBytes: warm.transientBytes } }));
  } finally { c.dispose(); await awaitFixture(broker.dispose()); cleaned(transport, c); await rm(root, { recursive: true, force: true }); }
});
