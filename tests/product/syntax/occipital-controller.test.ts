import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController, CONTROLLER_LIMITS, sourceReservation, type SourceDemand } from '../../../src/occipital/controller.ts';
import { decodeSemanticDescription, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { fingerprintNative } from '../../../src/occipital/style-rules.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import type { ProviderSnapshot } from '../../../src/occipital/provider.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
import { RenderCache } from '../../../src/render-cache.ts';
import { RuntimeHealth } from '../../../src/runtime-health.ts';
import { measure, reflow, type MeasuredRowLayout } from '../../../src/syntax/measured-rows.ts';
import { paintFlat, type FlatPaintRows } from '../../../src/syntax/flat-paint.ts';
import type { DataCleanupReceipt } from '../../../src/occipital/data-budget.ts';

function frameCleanup(layout: DataCleanupReceipt, paint: DataCleanupReceipt): DataCleanupReceipt {
  return { release() { layout.release(); paint.release(); } };
}
function paintRows(painted: FlatPaintRows) {
  const rows: string[] = []; assert.equal(painted.visitRows((_index, text) => rows.push(text)), true); return rows;
}

const fingerprint = 'a'.repeat(64);
const description = decodeSemanticDescription(semanticDescriptor('describe', 'daemon'), 'describe');
const fixtureHosts = new Set<Host>();
const fixtureControllers = new Set<SourceController>();
type Call = { request: Record<string, any>; signal?: AbortSignal; deadlineMs?: number; resolve: (value: unknown) => void; reject: (error: unknown) => void };
class Host {
  constructor() { fixtureHosts.add(this); }
  generation = 1;
  ready = true;
  description = { ...description, profiles: [...description.profiles], limits: { ...description.limits } };
  calls: Call[] = [];
  acceptedClassifications: number[] = [];
  classificationAccepted(generation: number) { this.acceptedClassifications.push(generation); return this.isReady(generation); }
  streams = new Map<string, { text: string; revision: number; committed: number; lease: string }>();
  snapshot(): ProviderSnapshot { return { availability: this.ready ? 'ready' : 'initializing', reason: this.ready ? 'ready' : 'initializing', generation: this.generation, initialShared: false, kind: 'owned', description: this.ready ? this.description : undefined }; }
  isReady(generation: number) { return this.ready && generation === this.generation; }
  request(_generation: number, request: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineMs?: number }) {
    return new Promise<unknown>((resolve, reject) => this.calls.push({ request, signal: options?.signal, deadlineMs: options?.deadlineMs, resolve, reject }));
  }
  answer(index: number) {
    const c = this.calls[index]!, r = c.request;
    if (r.op === 'stream.close') { this.streams.delete(r.key); c.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok', body: { kind: 'closed' } }); return; }
    const s = r.sources?.[0] ?? r, prior = this.streams.get(s.key);
    const text = r.op === 'stream.append' ? prior!.text + r.append : s.text;
    const complete = r.op === 'highlight' || r.final === true;
    const revision = r.op === 'stream.append' ? prior!.revision + 1 : 1;
    const replace_from = r.op === 'stream.append' ? prior!.committed : 0;
    const source_bytes = Buffer.byteLength(text);
    const committed_bytes = complete ? source_bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1));
    const lease = prior?.lease ?? `lease-${index}`;
    if (!complete) this.streams.set(s.key, { text, revision, committed: committed_bytes, lease });
    else this.streams.delete(s.key);
    const result = { key: s.key, generation: s.generation, source_version: s.source_version,
      revision, replace_from, source_bytes, committed_bytes, complete, ...(r.op !== 'highlight' ? { lease } : {}),
      contexts: source_bytes > replace_from ? [[0, 1]] : [], runs: source_bytes > replace_from ? [source_bytes - replace_from, 1] : [],
      counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
    c.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok', body: { kind: 'source', vocabulary: this.description.vocabulary.fingerprint, sources: [result] } });
  }
  style(index: number, red = 80) {
    const call = this.calls[index]!, r = call.request;
    assert.equal(r.op, 'styles.resolve');
    const style = { foreground: { kind: 'rgb', r: red, g: 120, b: 160 },
      background: { kind: 'rgb', r: 10, g: 20, b: 30 }, attributes: 0, attribute_mask: 31 };
    call.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets,
      status: 'ok', body: { kind: 'styles', vocabulary: r.vocabulary,
        rules: fingerprintNative(r.rules.fingerprint, 'rules'), styles: [style], indices: r.contexts.map(() => 1),
        palette: { revision: 1, fingerprint: fingerprintNative(r.rules.fingerprint, 'palette'),
          slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } } });
  }
  fault(index: number, code: string, execution = 'not_started') {
    const r = this.calls[index]!.request;
    this.calls[index]!.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'error', error: { code, execution } });
  }
}
function demand(text: string, version = 1, complete = false, key = 'source'): SourceDemand {
  return { key, version, text, language: 'bash', profile: 'pi', fingerprint, complete };
}
function fixture(options: ConstructorParameters<typeof SourceController>[1] = { deadlineMs: 1000 }) {
  const host = new Host(), controller = new SourceController(host, options);
  fixtureControllers.add(controller);
  return { host, controller };
}
// Source-only controls inspect canonical semantics, never claim these are ready colors.
function semanticPool(controller: SourceController): SemanticRetentionPool {
  const pool = Reflect.get(controller, 'pool'); assert.ok(pool instanceof SemanticRetentionPool); return pool;
}
function ranges(controller: SourceController, key = 'source') {
  const pool = semanticPool(controller), status = controller.status(key);
  if (!status?.classificationVersion) return [];
  const states = Reflect.get(controller, 'states'); assert.ok(states instanceof Map);
  const state = states.get(key), current = status.generation === undefined ? undefined : pool.status(status.generation);
  const generation = current?.sourceVersion === undefined ? state?.previous : status.generation;
  if (typeof generation !== 'number') return [];
  const limit = status.exact ? pool.status(generation)!.sourceBytes : status.committedBytes;
  const rows: (number | boolean)[][] = [];
  pool.visitRanges(generation, (a, b, context) => { if (a < limit) rows.push([a, Math.min(b, limit), context !== undefined]); });
  return rows;
}
async function settle() { await turn(); }
afterEach(async () => {
  for (const controller of fixtureControllers) controller.dispose();
  // Synthetic hosts deliberately hold promises; every terminal fixture outcome
  // must release module-global credit before the next independent test.
  for (let turnIndex = 0; turnIndex < 10; turnIndex++) {
    for (const host of fixtureHosts) for (const call of host.calls) call.resolve({});
    await settle();
  }
  for (const controller of fixtureControllers) {
    assert.equal(controller.stats().globalUnsettledJobs, 0);
    assert.equal(controller.stats().bookkeepingBytes, 0); assert.equal(controller.stats().sourceRecords, 0);
  }
  fixtureControllers.clear(); fixtureHosts.clear();
});

test('observe is inert; explicit flush coalesces latest; warmed observations do no preparation', async () => {
  const { host, controller: c } = fixture();
  for (let version = 1; version <= 100; version++) c.observe(demand('x'.repeat(version), version, true));
  assert.equal(host.calls.length, 0); assert.equal(c.stats().preparedBytes, 0);
  c.flush(); assert.equal(host.calls.length, 1); assert.equal(host.calls[0]!.request.sources[0].source_version, 100);
  host.answer(0); await settle();
  const before = c.stats();
  for (let i = 0; i < 100; i++) { c.observe(demand('x'.repeat(100), 100, true)); c.flush(); ranges(c); }
  assert.deepEqual(c.stats(), before); assert.equal(host.calls.length, 1); assert.equal(c.status('source')!.exact, true);
});

test('two unsettled captures, latest replacement, older useful acknowledgement then only suffix', async () => {
  const { host, controller: c } = fixture();
  c.observe(demand('a\nt', 1)); c.flush(); c.observe(demand('b\n', 1, true, 'second')); c.flush();
  assert.equal(host.calls.length, 2); const held = c.stats().transientBytes; assert.ok(held > 0 && held <= CONTROLLER_LIMITS.transientBytes);
  assert.equal(c.stats().captures, 2); assert.equal(c.stats().peakJobs, 2);
  c.observe(demand('a\ntx', 2)); c.observe(demand('a\ntxy', 3));
  c.observe(demand('third', 1, true, 'third')); c.flush(); assert.equal(host.calls.length, 2);
  host.answer(0); await settle();
  assert.equal(c.status('source')!.acknowledgedVersion, 1); assert.equal(c.status('source')!.exact, false);
  assert.deepEqual(host.acceptedClassifications, [host.generation], 'older useful parser acknowledgement is validated native success');
  assert.deepEqual(ranges(c), [[0, 2, true]]);
  assert.equal(host.calls[2]!.request.sources[0].text, 'third', 'newer source uses the free slot without waiting for older work');
  host.answer(1); await settle();
  assert.equal(host.calls[3]!.request.op, 'stream.append'); assert.equal(host.calls[3]!.request.append, 'xy');
  assert.equal(host.calls[3]!.request.base_revision, 1); assert.equal(host.calls[3]!.request.source_version, 3);
  host.answer(2); await settle(); host.answer(3); await settle();
  assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().unsettledJobs, 0);
  assert.equal(c.stats().retention.prefixCopiedBytes, 0); assert.equal(c.stats().preparedBytes, 12);
});

test('empty final suffix is dispatched once and commits tail without invented bytes', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush(); host.answer(0); await settle();
  c.observe(demand('a\nt', 1, true)); c.flush();
  assert.equal(host.calls[1]!.request.append, ''); assert.equal(host.calls[1]!.request.final, true);
  host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true);
  assert.equal(c.status('source')!.committedBytes, 3); assert.equal(c.stats().remoteLeases, 0);
  c.observe(demand('a\nt', 1, true)); c.flush(); assert.equal(host.calls.length, 2);
});

test('restart_required preserves independently valid semantics and retries latest once with fresh identity', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush(); host.answer(0); await settle();
  c.observe(demand('a\ntx', 2)); c.flush(); host.fault(1, 'restart_required'); await settle();
  assert.equal(host.calls[2]!.request.op, 'stream.close'); host.answer(2); await settle();
  const restarted = host.calls[3]!.request;
  assert.equal(restarted.op, 'stream.open'); assert.equal(restarted.sources[0].text, 'a\ntx');
  assert.notEqual(restarted.sources[0].generation, host.calls[0]!.request.sources[0].generation);
  assert.notEqual(restarted.sources[0].key, host.calls[0]!.request.sources[0].key);
  assert.deepEqual(ranges(c), [[0, 2, true]]); assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  host.fault(3, 'restart_required'); await settle();
  assert.equal(c.status('source')!.execution, 'not_started'); assert.equal(c.status('source')!.protective, true);
  for (let v = 3; v < 10; v++) { c.observe(demand('a\ntx'.padEnd(v + 3, 'x'), v)); c.flush(); }
  assert.equal(host.calls.length, 4); assert.equal(c.stats().restarts, 1);
});

test('no-start refusal never loops unchanged work; untyped rejection stays unknown across new demands', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('echo x', 1, true)); c.flush(); host.fault(0, 'busy'); await settle();
  assert.equal(c.status('source')!.fallbackEligible, true);
  for (let i = 0; i < 10; i++) { c.observe(demand('echo x', 1, true)); c.flush(); }
  assert.equal(host.calls.length, 1);
  c.observe(demand('echo xy', 2, true)); c.flush(); host.calls[1]!.reject(new Error('anything')); await settle();
  assert.equal(c.status('source')!.execution, 'unknown'); assert.equal(c.status('source')!.fallbackEligible, false);
  c.observe(demand('echo xyz', 3, true)); c.flush(); assert.equal(host.calls.length, 2);
  host.generation++; c.observe(demand('echo xyz', 3, true)); c.flush(); assert.equal(host.calls.length, 3);
  host.answer(2); await settle(); assert.equal(c.status('source')!.exact, true);
});

test('rewrite/language retire generations; theme selection preserves parser generation and lease', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('before')); c.flush(); const held = c.stats().transientBytes;
  c.observe(demand('after', 2)); c.flush();
  assert.equal(host.calls[0]!.signal!.aborted, true); assert.equal(host.calls.length, 1); assert.equal(c.stats().transientBytes, held);
  host.answer(0); await settle(); assert.equal(host.calls[1]!.request.op, 'stream.close'); host.answer(1); await settle();
  assert.equal(host.calls[2]!.request.sources[0].text, 'after'); assert.deepEqual(ranges(c), []);
  host.answer(2); await settle(); c.observe({ ...demand('after', 2), language: 'rust' }); c.flush();
  assert.deepEqual(ranges(c), []); assert.equal(host.calls[3]!.request.op, 'stream.close');
  host.answer(3); await settle(); host.answer(4); await settle();
  const generation = c.status('source')!.generation;
  c.observe({ ...demand('after', 2), language: 'rust', profile: 'missing' }); c.flush();
  assert.equal(host.calls.length, 5); assert.equal(c.status('source')!.generation, generation);
  assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.protective, false);
});

test('provider epoch change rejects late acknowledgement and allows only newly observed demand replay', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('old', 1, true)); c.flush(); host.generation++;
  host.answer(0); await settle(); assert.deepEqual(ranges(c), []); assert.equal(host.calls.length, 1);
  c.observe(demand('old', 1, true)); c.flush(); host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true);
});

test('pool pressure retires evicted leases, rejects late suffix, then caller re-admits fresh full source', async () => {
  const { host, controller: c } = fixture({ deadlineMs: 1000, retention: { maxBytes: 8192 } });
  c.observe(demand('a\nt')); c.flush(); host.answer(0); await settle();
  assert.equal(c.status('source')!.classificationVersion, 1); assert.equal(c.stats().remoteLeases, 1);
  assert.equal(host.calls.length, 1); assert.ok(c.stats().retention.rangeBytes > 0);
  assert.ok(c.stats().retention.retainedBytes > 3300 && c.stats().retention.retainedBytes <= 8192);
  c.observe(demand('a\ntx', 2)); c.flush(); assert.equal(host.calls[1]!.request.op, 'stream.append');
  c.observe(demand('p'.repeat(3000), 1, true, 'pressure')); c.flush();
  assert.equal(c.status('source')!.generation, undefined); assert.equal(host.calls[1]!.signal!.aborted, true);
  assert.ok(c.stats().retention.retainedBytes <= 8192);
  host.answer(1); await settle();
  assert.deepEqual(ranges(c), [], 'late suffix cannot reinstall an evicted incarnation');
  for (let i = 2; i < host.calls.length; i++) { host.answer(i); await settle(); }
  assert.equal(c.observe(demand('a\ntx', 2)), false); c.flush();
  c.retryEvicted('source'); c.observe(demand('a\ntx', 2, true)); c.flush(); const last = host.calls.at(-1)!;
  assert.equal(last.request.op, 'highlight'); assert.equal(last.request.sources[0].text, 'a\ntx');
  assert.notEqual(last.request.sources[0].generation, host.calls[0]!.request.sources[0].generation);
  last.resolve({}); await settle(); assert.equal(c.stats().retention.prefixCopiedBytes, 0);
});

test('transient admission precedes preparation, capacity waits and abort never releases a capture', async () => {
  const f = fixture({ deadlineMs: 1000, maxTransientBytes: 128 }); f.controller.observe(demand('echo x', 1, true)); f.controller.flush();
  assert.equal(f.host.calls.length, 0); assert.equal(f.controller.stats().preparedBytes, 0);
  assert.equal(f.controller.status('source')!.execution, 'not_started');
  const { host, controller: c } = fixture(); c.observe(demand('one', 1, true)); c.observe(demand('two', 1, true, 'two')); c.flush();
  const held = c.stats().transientBytes; c.dispose(); assert.equal(c.stats().transientBytes, held); assert.equal(c.stats().retention.entries, 0);
  assert.ok(host.calls.every(call => call.signal!.aborted)); host.answer(0); host.answer(1); await settle();
  assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().unsettledJobs, 0); assert.equal(c.status('source'), undefined);
  c.observe(demand('new')); c.flush(); assert.equal(host.calls.length, 2);
});

test('malformed UTF16 waits without encoding; append preparation and decode never encode a committed prefix', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('echo \ud83d')); c.flush(); assert.equal(host.calls.length, 0);
  c.observe(demand('echo 😀\n', 2)); c.flush(); host.answer(0); await settle();
  const original = Buffer.from, encoded: string[] = [];
  Buffer.from = ((value: unknown, ...args: any[]) => { if (typeof value === 'string') encoded.push(value); return (original as any)(value, ...args); }) as typeof Buffer.from;
  try {
    for (let v = 3; v <= 12; v++) { c.observe(demand('echo 😀\n' + 'x\n'.repeat(v - 2), v)); c.flush(); host.answer(host.calls.length - 1); await settle(); }
  } finally { Buffer.from = original; }
  assert.deepEqual(encoded, Array(10).fill('x\n')); assert.equal(c.stats().preparedBytes, Buffer.byteLength('echo 😀\n') + 20);
  assert.equal(c.stats().decodedBytes, Buffer.byteLength('echo 😀\n') + 20); assert.equal(c.stats().retention.prefixCopiedBytes, 0);
});

test('remote stream leases remain bounded; empty sources never launch parse work', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('', 1, true)); c.flush(); assert.equal(host.calls.length, 0); assert.equal(c.status('source')!.exact, true);
  host.description.limits.leases_per_route = 4;
  for (let i = 0; i < 5; i++) { c.observe(demand(`x${i}`, 1, false, `s${i}`)); c.flush(); }
  for (let i = 0; i < 4; i++) { host.answer(i); await settle(); }
  assert.equal(host.calls.length, 4); assert.equal(c.stats().remoteLeases, 4); assert.equal(c.status('s2')!.execution, 'not_started');
  c.remove('s0'); c.flush(); assert.equal(host.calls[4]!.request.op, 'stream.close'); host.answer(4); await settle();
  assert.equal(host.calls[5]!.request.op, 'stream.open'); assert.equal(c.stats().remoteLeases, 4);
});

test('first discarded controller collects while externally held request and second controller remain active', async () => {
  assert.ok(global.gc, 'run controller gate with --expose-gc');
  const host = new Host();
  function discarded() { const c = new SourceController(host, { deadlineMs: 1000 }); c.observe(demand('first', 1, true)); c.flush(); return new WeakRef(c); }
  const weak = discarded(); const second = new SourceController(host, { deadlineMs: 1000 }); second.observe(demand('second', 1, true)); second.flush();
  second.observe(demand('third', 1, true, 'third')); second.flush();
  assert.equal(host.calls.length, 2); assert.equal(second.stats().globalUnsettledJobs, 2);
  const held = second.stats().globalTransientBytes;
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); }
  assert.equal(weak.deref(), undefined); assert.equal(host.calls.length, 2);
  assert.equal(second.stats().globalTransientBytes, held);
  assert.equal(second.stats().globalBookkeepingBytes, second.stats().bookkeepingBytes);
  host.answer(0); await settle(); assert.equal(host.calls.length, 3);
  assert.equal(second.stats().globalUnsettledJobs, 2); assert.equal(second.stats().unsettledJobs, 2);
  host.answer(1); host.answer(2); await settle(); assert.equal(second.status('source')!.exact, true);
  assert.equal(second.status('third')!.exact, true); assert.equal(second.stats().globalTransientBytes, 0);
  second.dispose();
});



test('borrowed snapshot accessor reuses cached byte length and cannot mutate pool records', () => {
  const pool = new SemanticRetentionPool(); const generation = pool.admit('snapshot', 1, '😀').generation!;
  const first = pool.borrowSnapshot(generation)!; assert.deepEqual(first, { version: 1, text: '😀', utf8Bytes: 4 });
  (first as { text: string }).text = 'changed'; assert.equal(pool.borrowSnapshot(generation)!.text, '😀');
  pool.replaceSnapshot(generation, 2, '😀é'); assert.equal(pool.borrowSnapshot(generation)!.utf8Bytes, 6);
  assert.equal(pool.borrowSnapshot(generation, 'basis')!.version, 1);
  pool.remove(generation); assert.equal(pool.borrowSnapshot(generation), undefined);
});

test('unknown obsolete outcome blocks replacement and survives eviction/re-admission on same provider', async () => {
  const { host, controller: c } = fixture({ deadlineMs: 1000, retention: { maxBytes: 4096 } });
  c.observe(demand('first')); c.flush(); c.observe(demand('rewrite', 2)); c.flush(); assert.equal(host.calls.length, 1);
  host.calls[0]!.reject(new Error('untyped rejection after abort')); await settle();
  assert.equal(host.calls.length, 1); assert.equal(c.status('source')!.execution, 'unknown');
  c.observe(demand('o'.repeat(1300), 1, true, 'other')); c.flush();
  assert.equal(c.status('source')!.generation, undefined, 'pressure actually evicts the uncertain replacement');
  host.answer(1); await settle();
  c.retryEvicted('source'); c.observe(demand('rewrite', 3)); c.flush(); assert.equal(host.calls.length, 2);
  assert.equal(c.status('source')!.fallbackEligible, false);
  host.generation++; c.observe(demand('rewrite', 3)); c.flush(); host.answer(2); await settle();
  assert.equal(c.status('source')!.exact, true);
});

test('retirement close waits for same-source append settlement rather than overlapping physical jobs', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('line\ntail')); c.flush(); host.answer(0); await settle();
  c.observe(demand('line\ntails', 2)); c.flush(); c.remove('source'); c.flush();
  assert.equal(host.calls.length, 2); assert.equal(c.stats().unsettledJobs, 1); assert.equal(c.stats().pendingCloses, 1);
  host.answer(1); await settle(); assert.equal(host.calls[2]!.request.op, 'stream.close');
  host.answer(2); await settle(); assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().transientBytes, 0);
});

test('provider replay retains exact classifications but does not transfer old parser acknowledgement', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('line\ntail')); c.flush(); host.answer(0); await settle();
  const old = ranges(c); host.generation++; c.observe(demand('line\ntail')); c.flush();
  assert.deepEqual(ranges(c), old); assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  assert.equal(host.calls[1]!.request.op, 'stream.open');
  c.observe(demand('line\ntail', 1, true)); host.answer(1); await settle();
  assert.equal(host.calls[2]!.request.op, 'stream.append'); assert.equal(host.calls[2]!.request.append, '');
  host.answer(2); await settle(); assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().retention.entries, 1);
});

test('previous recovery result obeys pool pressure and reset retry budget survives evictions', async () => {
  const { host, controller: c } = fixture({ deadlineMs: 1000, retention: { maxBytes: 8192 } });
  c.observe(demand('a\nt')); c.flush(); host.answer(0); await settle();
  assert.equal(c.status('source')!.classificationVersion, 1); assert.ok(c.stats().retention.rangeBytes > 0);
  c.observe(demand('a\ntx', 2)); c.flush(); host.fault(1, 'restart_required'); await settle(); host.answer(2); await settle();
  assert.deepEqual(ranges(c), [[0, 2, true]]); assert.equal(c.stats().retention.entries, 2);
  assert.equal(host.calls[3]!.request.op, 'stream.open');
  assert.equal(c.borrowSource('source')!.text, 'a\ntx', 'keep the current target newer than its borrowed historical basis');
  c.observe(demand('p'.repeat(2000), 1, true, 'pressure')); c.flush();
  assert.deepEqual(ranges(c), []); assert.equal(host.calls[3]!.signal!.aborted, false, 'evicting historical semantics does not cancel the retained current parser');
  assert.ok(c.stats().retention.retainedBytes <= 8192);
  assert.notEqual(c.status('source')!.generation, undefined, 'only historical semantics were evicted');
  host.fault(3, 'restart_required'); await settle();
  c.retryEvicted('source'); c.observe(demand('a\ntxyz', 4)); c.flush();
  assert.notEqual(c.status('source')?.execution, 'unsettled'); assert.equal(c.stats().restarts, 1);
});

test('disable drops demand, keeps unsettled accounting, and re-enable requires fresh caller observations', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('first', 1, true)); c.flush(); c.observe(demand('waiting', 2, true));
  c.setEnabled(false); const bytes = c.stats().transientBytes; assert.ok(bytes > 0); assert.equal(c.stats().retention.entries, 0);
  assert.equal(c.observe(demand('ignored', 1, true)), false); c.setEnabled(true); c.flush(); assert.equal(host.calls.length, 1);
  host.answer(0); await settle(); assert.equal(c.stats().transientBytes, 0); assert.equal(host.calls.length, 1);
  c.observe(demand('fresh', 3, true)); c.flush(); host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true);
});


test('byte credit can serialize two admitted sources without preparing the waiting source early', async () => {
  const { host, controller: c } = fixture({ deadlineMs: 1000, maxTransientBytes: 50000, retention: { maxBytes: 8192 } });
  host.description.limits.request_bytes = 1024; host.description.limits.reply_bytes = 1024;
  c.observe(demand('one', 1, true)); c.observe(demand('two', 1, true, 'two')); c.flush();
  assert.equal(host.calls.length, 1); assert.equal(c.stats().preparedBytes, 3); assert.equal(c.stats().transientBytes, 46101);
  c.flush(); assert.equal(host.calls.length, 1); assert.equal(c.stats().preparedBytes, 3);
  host.answer(0); await settle(); assert.equal(host.calls.length, 2); assert.equal(c.stats().preparedBytes, 6);
  assert.equal(c.stats().transientBytes, 46101); host.answer(1); await settle();
  assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().peakJobs, 1);
});

test('bad decoded reply and explicit started fault cannot enable fallback or unchanged-frame retries', async () => {
  for (const outcome of ['invalid', 'started']) {
    const { host, controller: c } = fixture(); c.observe(demand('echo x', 1, true)); c.flush();
    if (outcome === 'invalid') host.calls[0]!.resolve({ v: 1 }); else host.fault(0, 'engine_failure', 'started');
    await settle(); assert.equal(c.status('source')!.fallbackEligible, false); assert.equal(c.status('source')!.protective, true);
    assert.deepEqual(ranges(c), []); c.observe(demand('echo xy', 2, true)); c.flush(); assert.equal(host.calls.length, 1);
  }
});

test('provider startup/read paths stay inert, readiness flushes queued demand, absence preserves exact semantics', async () => {
  const { host, controller: c } = fixture(); host.ready = false; c.observe(demand('echo x', 1, true));
  for (let i = 0; i < 20; i++) { c.status('source'); ranges(c); c.flush(); }
  assert.equal(host.calls.length, 0); assert.equal(c.stats().preparedBytes, 0);
  assert.equal(c.status('source')!.availability, 'initializing'); assert.equal(c.status('source')!.execution, 'not_started');
  host.ready = true; c.flush(); host.answer(0); await settle(); const parsed = ranges(c);
  const generation = c.status('source')!.generation, prepared = c.stats().preparedBytes;
  host.ready = false; host.generation++; assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  assert.equal(c.status('source')!.exact, true); assert.deepEqual(ranges(c), parsed); c.flush(); assert.equal(host.calls.length, 1);
  c.observe(demand('echo x', 1, true)); c.flush(); assert.equal(host.calls.length, 1);
  host.ready = true; c.flush(); await settle();
  assert.equal(host.calls.length, 1, 'compatible completed annotations do not need a ready presentation to prevent source replay');
  assert.equal(c.stats().preparedBytes, prepared); assert.equal(c.status('source')!.generation, generation);
  assert.deepEqual(ranges(c), parsed); assert.equal(c.displayBasis('source'), undefined);
  assert.equal(c.status('source')!.acknowledgedVersion, undefined, 'the new provider has not parsed this source');
  assert.deepEqual(host.acceptedClassifications, [1]);
  const before = c.stats();
  for (let i = 0; i < 30; i++) { c.observe(demand('echo x', 1, true)); c.flush(); }
  assert.deepEqual(c.stats(), before);
});

for (const change of ['assets', 'vocabulary', 'incomplete'] as const) test(`provider recovery: ${change} does not reuse incompatible or unfinished source coverage`, async () => {
  const { host, controller: c } = fixture(); const complete = change !== 'incomplete';
  const source = demand('echo x', 1, complete); c.observe(source); c.flush(); host.answer(0); await settle();
  const generation = c.status('source')!.generation, bytes = c.stats().preparedBytes;
  assert.equal(c.status('source')!.classificationVersion, 1);
  host.ready = false; host.generation++; c.observe(source); c.flush();
  if (change === 'assets') host.description = { ...host.description, assets: 'different-assets' };
  if (change === 'vocabulary') host.description = { ...host.description,
    vocabulary: { ...host.description.vocabulary, fingerprint: 'f'.repeat(64) } };
  host.ready = true; c.flush(); await settle();
  assert.equal(host.calls.length, 2, 'incompatible assets or unfinished parser state require one fresh source request');
  assert.equal(host.calls[1]!.request.op, complete ? 'highlight' : 'stream.open');
  assert.notEqual(c.status('source')!.generation, generation);
  assert.equal(c.stats().preparedBytes, bytes * 2);
  assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  assert.equal(c.displayBasis('source'), undefined);
});

test('provider recovery: compatible complete semantics become local at full physical credit', async () => {
  const { host, controller: c } = fixture(); const source = demand('echo x', 1, true);
  c.observe(source); c.flush(); host.answer(0); await settle(); const generation = c.status('source')!.generation;
  host.ready = false; host.generation++; c.observe(source);
  c.observe(demand('one', 1, true, 'one')); c.observe(demand('two', 1, true, 'two'));
  host.ready = true; c.flush(); await settle();
  assert.equal(host.calls.length, 3); assert.equal(c.stats().unsettledJobs, 2);
  assert.equal(c.status('source')!.generation, generation, 'semantic reuse is local work, not capacity waiting');
  assert.equal(c.stats().preparedBytes, 12); assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  assert.equal(c.displayBasis('source'), undefined);
  host.answer(1); host.answer(2); await settle();
  assert.equal(host.calls.length, 3, 'credit wake must not start a deferred duplicate parser');
  assert.equal(c.stats().unsettledJobs, 0); assert.deepEqual(host.acceptedClassifications, [1, 2, 2]);
});

test('mismatched desired profile does not block theme-independent parsing or become ready color evidence', async () => {
  const { host, controller: c } = fixture();
  c.observe({ ...demand('echo x', 1, true), profile: 'missing', fingerprint: 'b'.repeat(64) }); c.flush();
  assert.equal(host.calls.length, 1); assert.equal(c.stats().preparedBytes, 6);
  assert.equal(Object.hasOwn(host.calls[0]!.request.sources[0], 'profile'), false);
  host.answer(0); await settle();
  assert.equal(c.status('source')!.exact, true); assert.equal(c.displayBasis('source'), undefined);
  assert.equal(c.workStatus('source').fallbackEligible, false, 'pending styles are not Pi classifier permission');
});

test('current temporary family holds two full64KiB source jobs with independent2MiB decoded reservations', async () => {
  const l = HIGHLIGHT_LIMITS, { host, controller: c } = fixture();
  const full = 7*l.sourceBytes + 4*l.dataWireBytes + l.decodedBytes + 32768 + 1024;
  assert.equal(CONTROLLER_LIMITS.transientBytes, 2*full);
  const text = 'x'.repeat(l.sourceBytes);
  assert.equal(c.observe(demand(text, 1, true, 'a')), true);
  assert.equal(c.observe(demand(text, 1, true, 'b')), true); c.flush();
  assert.equal(host.calls.length, 2); assert.equal(c.stats().unsettledJobs, 2);
  assert.equal(c.stats().transientBytes, 2*full);
  assert.equal(c.observe(demand('waiting', 1, true, 'third')), true); c.flush();
  assert.equal(host.calls.length, 2, 'queued source cannot reuse either held physical slot');
  host.answer(0); await settle(); c.flush();
  assert.equal(host.calls.length, 3); assert.equal(c.stats().unsettledJobs, 2);
  host.answer(1); host.answer(2); await settle();
  assert.equal(c.stats().unsettledJobs, 0); assert.equal(c.stats().transientBytes, 0);
});

test('warm visits never traverse full source via prefix comparisons or UTF8 measurement', async () => {
  const { host, controller: c } = fixture(); const text = 'a distinctive raw source\nwith tail';
  const d = demand(text, 1, true); c.observe(d); c.flush(); host.answer(0); await settle();
  const prefix = String.prototype.startsWith, size = Buffer.byteLength; let visits = 0;
  String.prototype.startsWith = function (...args) { if (String(this) === text) visits++; return prefix.apply(this, args); };
  Buffer.byteLength = ((value: any, ...args: any[]) => { if (value === text) visits++; return (size as any)(value, ...args); }) as typeof Buffer.byteLength;
  try { for (let i = 0; i < 20; i++) { c.observe(d); c.flush(); c.status(d.key); ranges(c); } }
  finally { String.prototype.startsWith = prefix; Buffer.byteLength = size; }
  assert.equal(visits, 0); assert.equal(host.calls.length, 1);
});

test('257 tiny demands have no unrelated count eviction and removal drops all primitive refusal records', () => {
  const { controller: c } = fixture();
  for (let i = 0; i < 257; i++) assert.equal(c.observe(demand('x', 1, true, `tiny-${i}`)), true);
  assert.equal(c.stats().retention.entries, 257);
  for (let i = 0; i < 257; i++) c.remove(`tiny-${i}`);
  assert.equal(c.stats().sourceRecords, 0); assert.equal(c.stats().guardRecords, 0);
});


test('reviewed typed local no-start is current-attempt proof; foreign structure and untyped failures are unknown', async () => {
  const errors = [new RequestFailure('preflight only', 'not_started'), new RequestFailure('not_started in message'),
    { execution: 'not_started' }, new Error('no-start')];
  for (let i = 0; i < errors.length; i++) {
    const { host, controller: c } = fixture(); c.observe(demand('echo x', 1, true)); c.flush(); host.calls[0]!.reject(errors[i]); await settle();
    assert.equal(c.status('source')!.execution, i === 0 ? 'not_started' : 'unknown');
    assert.equal(c.status('source')!.fallbackEligible, i === 0);
    c.observe(demand('echo x', 1, true)); c.flush(); assert.equal(host.calls.length, 1); c.dispose();
  }
});


test('working-set pressure never evicts and resends on identical visits; explicit retry is finite', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 2000 } });
  const demands = Array.from({ length: 4 }, (_, i) => demand('x', 1, true, `pressure-${i}`));
  for (const d of demands) c.observe(d); c.flush(); assert.equal(host.calls.length, 1);
  host.answer(0); await settle(); assert.equal(c.stats().retention.entries, 1);
  const before = c.stats();
  for (let visit = 0; visit < 30; visit++) for (const d of demands) { c.observe(d); c.flush(); c.status(d.key); ranges(c, d.key); }
  assert.deepEqual(c.stats(), before); assert.equal(c.stats().preparedBytes, 1);
  assert.equal(c.retryEvicted(demands[0]!.key), true); c.observe(demands[0]!); c.flush(); host.answer(1); await settle();
  assert.equal(c.retryEvicted(demands[0]!.key), false);
  for (const d of demands) c.remove(d.key);
  assert.equal(c.stats().sourceRecords, 0); assert.equal(c.stats().guardRecords, 0); assert.equal(c.stats().bookkeepingBytes, 128);
});

test('unretainable result keeps a primitive refusal without repeated source measurements or dispatch', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 1500 } }); const d = demand('unretainable result', 1, true);
  c.observe(d); c.flush(); host.answer(0); await settle(); assert.equal(c.status(d.key)!.classificationVersion, undefined); assert.equal(c.workStatus(d.key).execution, 'acknowledged');
  assert.deepEqual(host.acceptedClassifications, [host.generation], 'local retention pressure does not undo validated native success');
  const before = c.stats(), byteLength = Buffer.byteLength; let scans = 0;
  Buffer.byteLength = ((value: any, ...args: any[]) => { if (value === d.text) scans++; return (byteLength as any)(value, ...args); }) as typeof Buffer.byteLength;
  try { for (let i = 0; i < 30; i++) { c.observe(d); c.flush(); } } finally { Buffer.byteLength = byteLength; }
  assert.equal(scans, 0); assert.deepEqual(c.stats(), before); assert.equal(host.calls.length, 1);
  assert.deepEqual(host.acceptedClassifications, [host.generation]);
  c.remove(d.key); assert.equal(c.stats().guardRecords, 0); c.dispose(); assert.equal(c.stats().bookkeepingBytes, 0);
});

test('bookkeeping has byte admission, deterministic removal and no separate source count limit', () => {
  const { controller: c } = fixture({ maxBookkeepingBytes: 1400 });
  assert.equal(c.observe(demand('x', 1, true, 'first')), true);
  assert.equal(c.observe(demand('x', 1, true, 'second')), false);
  c.remove('first'); assert.equal(c.observe(demand('x', 1, true, 'second')), true);
  assert.ok(c.stats().bookkeepingBytes <= 1400); c.dispose(); assert.equal(c.stats().bookkeepingBytes, 0);
});

test('full raw path hint and exact64KiB logical line are transmitted without truncation', async () => {
  const { host, controller: c } = fixture(); const text = 'x'.repeat(HIGHLIGHT_LIMITS.sourceBytes);
  const d = { ...demand(text, 1, true), language: undefined, path: '/raw/source/example.json' };
  c.observe(d); assert.equal(host.calls.length, 0); c.flush();
  assert.deepEqual(host.calls[0]!.request.sources[0].hint, { path: d.path });
  assert.equal(host.calls[0]!.request.sources[0].text, text); host.answer(0); await settle();
  assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().preparedBytes, HIGHLIGHT_LIMITS.sourceBytes);
  c.observe({ ...d, path: '/raw/source/example.rs' }); c.flush();
  assert.notEqual(host.calls[1]!.request.sources[0].generation, host.calls[0]!.request.sources[0].generation);
  assert.deepEqual(ranges(c), []); host.answer(1); await settle();
});

test('exact frame admission stays transport-owned rather than an escaping estimate or second stringify', async () => {
  const { host, controller: c } = fixture(); host.description.limits.request_bytes = 1024; host.description.limits.reply_bytes = 1024;
  const text = 'x'.repeat(300); const stringify = JSON.stringify; let encodes = 0;
  JSON.stringify = ((...args: any[]) => { encodes++; return (stringify as any)(...args); }) as typeof JSON.stringify;
  try { c.observe(demand(text, 1, true)); c.flush(); } finally { JSON.stringify = stringify; }
  assert.equal(encodes, 0); assert.equal(host.calls.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(host.calls[0]!.request)) < 1024);
  assert.ok(6*Buffer.byteLength(text) > 1024); host.answer(0); await settle(); assert.equal(c.status('source')!.exact, true);
});

test('default source usefulness deadline is five minutes and no-start preserves newer waiting demand', async () => {
  const host = new Host(), c = new SourceController(host); fixtureControllers.add(c);
  c.observe(demand('first', 1, true)); c.flush(); assert.equal(host.calls[0]!.deadlineMs, 300000);
  c.observe(demand('first waiting', 2, true)); host.calls[0]!.reject(new RequestFailure('local preflight', 'not_started')); await settle();
  assert.equal(host.calls.length, 2); assert.equal(host.calls[1]!.request.sources[0].source_version, 2);
  host.answer(1); await settle(); c.observe(demand('first waiting', 2, true)); c.flush(); assert.equal(host.calls.length, 2);
});

test('typed local no-start releases only that opening reservation, never guesses loss or clears an earlier unknown', async () => {
  const { host, controller: c } = fixture(); host.description.limits.leases_per_route = 1;
  c.observe(demand('first')); c.flush(); c.observe(demand('second', 1, false, 'second')); c.flush(); assert.equal(host.calls.length, 1);
  host.calls[0]!.reject(new RequestFailure('local refusal', 'not_started')); await settle();
  assert.equal(host.calls.length, 2); assert.equal(c.stats().remoteLeases, 1); host.answer(1); await settle();
  c.observe(demand('first changed', 2)); c.remove('second'); c.flush(); host.answer(2); await settle();
  host.calls[3]!.reject(new RequestFailure('unknown')); await settle(); assert.equal(c.status('source')!.execution, 'unknown');
  c.observe(demand('first changed again', 3)); c.flush(); assert.equal(host.calls.length, 4);
  assert.equal(c.status('source')!.fallbackEligible, false); assert.equal(host.generation, 1);
});

test('reservation arithmetic uses tiny positions/facts rather than source allocation and rejects invalid arithmetic', () => {
  assert.equal(sourceReservation({ captureUnits: 32*1024*1024, replacementUnits: 3, inputUnits: 3, replacementBytes: 3,
    frameBytes: OCCIPITAL_LIMITS.wireBytes, decodedBytes: OCCIPITAL_LIMITS.retainedBytes }),
    2*(32*1024*1024 + 3 + 3) + 3 + 4*OCCIPITAL_LIMITS.wireBytes + OCCIPITAL_LIMITS.retainedBytes + 33792);
  assert.throws(() => sourceReservation({ captureUnits: -1, replacementUnits: 0, inputUnits: 0, replacementBytes: 0, frameBytes: 0, decodedBytes: 0 }));
});


test('completed tail never masquerades as stable prefix after provider replay and changed finite text', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('if', 1, true)); c.flush(); host.answer(0); await settle();
  host.generation++; c.observe(demand('if', 1, true)); c.flush(); assert.equal(host.calls.length, 1);
  assert.deepEqual(ranges(c), [[0, 2, true]]);
  c.observe(demand('iffy', 2, true)); c.flush(); assert.deepEqual(ranges(c), []);
  host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true);
});

test('changed already-complete demand retires a pending one-shot instead of admitting its completed tail as prefix', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('if', 1, true)); c.flush();
  c.observe(demand('iffy', 2, true)); c.flush(); assert.equal(host.calls[0]!.signal!.aborted, true);
  host.answer(0); await settle(); assert.deepEqual(ranges(c), []); assert.equal(host.calls.length, 2);
  host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true);
});


test('review F1: held physical source attempt forbids fallback for original, changed, retired and reused demand', async () => {
  for (const mode of ['original', 'changed', 'retired', 'reused']) {
    const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush();
    if (mode === 'changed') c.observe(demand('a\ntx', 2));
    if (mode === 'retired') c.observe({ ...demand('a\nt', 2), language: 'rust' });
    if (mode === 'reused') { c.remove('source'); c.observe(demand('new', 1, true)); }
    assert.equal(c.status('source')!.execution, 'unsettled', mode);
    assert.equal(c.status('source')!.fallbackEligible, false, mode);
    const held = c.stats().transientBytes; c.flush(); assert.equal(host.calls.length, 1);
    assert.equal(c.stats().transientBytes, held);
    host.calls[0]!.reject(new RequestFailure('explicit preflight proof', 'not_started')); await settle();
    if (mode !== 'original') {
      assert.equal(host.calls.length, 2); assert.equal(c.status('source')!.fallbackEligible, false);
      host.calls[1]!.reject(new RequestFailure('current attempt proof', 'not_started')); await settle();
    }
    assert.equal(c.status('source')!.execution, 'not_started'); assert.equal(c.status('source')!.fallbackEligible, true);
    c.dispose();
  }
});

test('review F2: real broker retire/publish preserves completed aliases without a new parser acknowledgement', async () => {
  const first = new Host(), next = new Host(); let publish!: () => void; let acquisitions = 0, closes = 0;
  const gate = new Promise<void>(resolve => { publish = resolve; });
  function transport(host: Host) {
    let endReason: 'closed' | undefined, resolveEnd!: (reason: 'closed') => void;
    const ended = new Promise<'closed'>(resolve => { resolveEnd = resolve; });
    return { ended, get endReason() { return endReason; }, request: (r: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineMs?: number }) => r.op === 'describe'
      ? Promise.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok',
        body: semanticDescriptor(r.ticket, description.instance).body })
      : host.request(0, r, options), close: async () => { closes++; endReason = 'closed'; resolveEnd('closed'); } };
  }
  const broker = new ProviderBroker({ tryShared: async () => undefined, acquireOwned: async () => {
    if (++acquisitions === 1) return transport(first); await gate; return transport(next);
  } });
  const c = new SourceController(broker); fixtureControllers.add(c);
  try {
    await awaitFixture(broker.start()); const d = demand('echo x', 1, true); c.observe(d); c.flush(); first.answer(0); await settle();
    c.observe({ ...d, version: 2 }); const original = ranges(c); assert.deepEqual(original, [[0, 6, true]]);
    const generation = broker.snapshot().generation, loss = broker.provenLoss(generation);
    assert.equal(broker.snapshot().availability, 'transitioning'); assert.equal(broker.snapshot().generation, generation + 1);
    c.observe({ ...d, version: 2 }); c.flush(); assert.deepEqual(ranges(c), original);
    assert.equal(c.status('source')!.acknowledgedVersion, undefined);
    publish(); await awaitFixture(loss); assert.equal(broker.snapshot().generation, generation + 2);
    c.observe({ ...d, version: 2 }); c.flush(); assert.deepEqual(ranges(c), original);
    assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.acknowledgedVersion, undefined);
    assert.equal(c.status('source')!.classificationVersion, 1);
    assert.equal(first.calls.length, 1); assert.equal(next.calls.length, 0); assert.equal(c.stats().dispatches, 1);
    assert.equal(c.stats().preparedBytes, 6);
  } finally { publish(); c.dispose(); await awaitFixture(broker.dispose()); assert.equal(closes, 2); }
});


test('review F3: identical newer snapshots before flush preserve initial work for the latest version', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.observe(demand('a\nt', 2)); c.flush();
  assert.equal(host.calls.length, 1); assert.equal(host.calls[0]!.request.sources[0].source_version, 2);
  host.answer(0); await settle(); assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().preparedBytes, 3);
});

test('review F3: identical newer waiting text preserves one owed suffix after useful older acknowledgement', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush();
  c.observe(demand('a\ntx', 2)); c.observe(demand('a\ntx', 3)); host.answer(0); await settle();
  assert.equal(host.calls.length, 2); assert.equal(host.calls[1]!.request.append, 'x');
  assert.equal(host.calls[1]!.request.source_version, 3); assert.equal(host.calls[1]!.request.base_revision, 1);
  assert.deepEqual(ranges(c), [[0, 2, true]]); assert.equal(c.status('source')!.acknowledgedVersion, 1);
  host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().preparedBytes, 4);
  assert.equal(c.stats().retention.prefixCopiedBytes, 0);
});

test('review F3: classified identical aliases retain full tail but never invent a newer remote acknowledgement', async () => {
  for (const complete of [false, true]) {
    const { host, controller: c } = fixture(); c.observe(demand('a\nt', 1, complete)); c.flush(); host.answer(0); await settle();
    const original = ranges(c), bytes = c.stats().preparedBytes;
    for (let version = 2; version <= 4; version++) {
      c.observe(demand('a\nt', version, complete)); c.flush(); assert.deepEqual(ranges(c), original);
      assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.version, version);
      assert.equal(c.status('source')!.acknowledgedVersion, 1); assert.equal(c.status('source')!.classificationVersion, 1);
      assert.equal(host.calls.length, 1); assert.equal(c.stats().preparedBytes, bytes);
    }
    if (!complete) {
      c.observe(demand('a\ntx', 5)); c.flush(); assert.deepEqual(ranges(c), [[0, 2, true]]);
      assert.equal(host.calls[1]!.request.append, 'x'); assert.equal(host.calls[1]!.request.base_revision, 1);
      assert.equal(host.calls[1]!.request.source_version, 5); host.answer(1); await settle();
      assert.equal(c.status('source')!.acknowledgedVersion, 5); assert.equal(c.status('source')!.exact, true);
    }
    c.dispose();
  }
});

test('review F3: repeated equal content while in flight aliases its real acknowledgement without a redundant append', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush(); c.observe(demand('a\nt', 2));
  host.answer(0); await settle(); assert.equal(host.calls.length, 1); assert.deepEqual(ranges(c), [[0, 2, true], [2, 3, true]]);
  assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.acknowledgedVersion, 1);
  c.observe(demand('a\nt', 3, true)); c.flush(); assert.equal(host.calls[1]!.request.append, '');
  assert.equal(host.calls[1]!.request.source_version, 3); assert.equal(host.calls[1]!.request.base_revision, 1);
  host.answer(1); await settle(); assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().remoteLeases, 0);
  c.observe(demand('a\nt', 4, true)); c.flush(); assert.equal(host.calls.length, 2);
  assert.equal(c.status('source')!.acknowledgedVersion, 3); assert.equal(c.status('source')!.classificationVersion, 3);
});

test('review F3: equal version aliases cannot retry identical authoritative no-start work', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('a\nt')); c.flush(); c.observe(demand('a\nt', 2));
  host.fault(0, 'busy'); await settle(); assert.equal(host.calls.length, 1);
  assert.equal(c.status('source')!.execution, 'not_started'); assert.equal(c.status('source')!.fallbackEligible, true);
  for (let version = 3; version <= 8; version++) { c.observe(demand('a\nt', version)); c.flush(); }
  assert.equal(host.calls.length, 1); assert.equal(c.stats().preparedBytes, 3);
});

test('source changes notify once after two useful settlements, expose installed semantics/zero credits, and never on warm reads', async () => {
  let notices = 0; const snapshots: boolean[] = [], credits: number[][] = [];
  const { host, controller } = fixture({ onChange: () => {
    notices++; snapshots.push(controller.status('a')!.exact && controller.status('b')!.exact);
    const stats = controller.stats();
    credits.push([stats.unsettledJobs, stats.globalUnsettledJobs, stats.transientBytes, stats.globalTransientBytes]);
  } });
  controller.observe(demand('a', 1, true, 'a')); controller.observe(demand('b', 1, true, 'b')); controller.flush();
  assert.equal(notices, 0); host.answer(0); host.answer(1); await settle();
  assert.equal(notices, 1); assert.deepEqual(snapshots, [true]); assert.deepEqual(credits, [[0, 0, 0, 0]]);
  for (let i = 0; i < 10; i++) { controller.observe(demand('a', 1, true, 'a')); controller.status('a'); ranges(controller, 'a'); controller.stats(); controller.flush(); }
  await settle(); assert.equal(notices, 1); assert.equal(host.calls.length, 2);
});

test('source no-start and unknown terminal outcomes notify without inventing fallback permission', async () => {
  for (const execution of ['not_started', 'unknown'] as const) {
    let notices = 0; const { host, controller } = fixture({ onChange: () => { notices++; } });
    controller.observe(demand('tail')); controller.flush();
    host.calls[0]!.reject(new RequestFailure('fixed local reason', execution)); await settle();
    assert.equal(notices, 1); assert.equal(controller.status('source')!.fallbackEligible, execution === 'not_started');
    assert.equal(controller.stats().unsettledJobs, 0); controller.dispose();
  }
});

test('queued source notification cannot cross off/on or disposal, including stale completion after removal', async () => {
  let notices = 0; const { host, controller } = fixture({ onChange: () => { notices++; } });
  controller.observe(demand('first', 1, true)); controller.flush();
  const original = globalThis.queueMicrotask, queued: (() => void)[] = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try {
    host.answer(0); await turn();
    assert.equal(controller.status('source')!.exact, true); assert.equal(notices, 0);
    controller.setEnabled(false); controller.setEnabled(true);
    while (queued.length) queued.shift()!(); assert.equal(notices, 0);
    controller.observe(demand('second', 2, true)); controller.flush(); host.answer(1); await turn();
    controller.dispose(); while (queued.length) queued.shift()!(); assert.equal(notices, 0);
  } finally { globalThis.queueMicrotask = original; }
  const other = fixture({ onChange: () => { notices++; } });
  other.controller.observe(demand('removed')); other.controller.flush(); other.controller.remove('source');
  assert.equal(other.controller.status('source'), undefined); assert.equal(notices, 0);
  other.host.answer(0); await settle(); assert.equal(notices, 0);
  // The obsolete open really created a lease: settle its required close too.
  assert.equal(other.host.calls.length, 2); assert.equal(other.host.calls[1]!.request.op, 'stream.close');
  other.host.answer(1); await settle();
  assert.equal(notices, 0); assert.equal(other.controller.stats().unsettledJobs, 0);
});

test('throwing source observer cannot prevent classification, credit release or later notifications', async () => {
  let notices = 0; const { host, controller } = fixture({ onChange: () => { notices++; throw Error('caller observer'); } });
  controller.observe(demand('one', 1, true)); controller.flush(); host.answer(0); await settle();
  assert.equal(controller.status('source')!.exact, true); assert.equal(controller.stats().unsettledJobs, 0);
  controller.observe(demand('two', 2, true)); controller.flush(); host.answer(1); await settle();
  assert.equal(controller.status('source')!.exact, true); assert.equal(notices, 2);
});

test('source observer is validated before ownership and an empty source needs no asynchronous notice', async () => {
  const host = new Host();
  assert.throws(() => new SourceController(host, { onChange: 1 as unknown as () => void }), /observer/);
  let notices = 0; const { controller } = fixture({ onChange: () => { notices++; } });
  controller.observe(demand('', 1, true)); controller.flush(); await settle();
  assert.equal(notices, 0); assert.equal(controller.stats().dispatches, 0);
});

function observedOwner(host: Host, onChange: () => void) {
  const controller = new SourceController(host, { onChange });
  controller.observe(demand('first', 1, true)); controller.flush();
  return new WeakRef(controller);
}
test('first source owner collects with its production notice externally held and another source owner active', async () => {
  assert.equal(typeof global.gc, 'function');
  let notices = 0; const firstHost = new Host(), first = observedOwner(firstHost, () => { notices++; });
  const second = fixture(); second.controller.observe(demand('still pending', 1, false, 'second')); second.controller.flush();
  const original = globalThis.queueMicrotask, queued: (() => void)[] = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try { firstHost.answer(0); await turn(); assert.equal(queued.length, 2); }
  finally { globalThis.queueMicrotask = original; }
  for (let i = 0; i < 100; i++) { await turn(); global.gc!(); await turn(); if (!first.deref()) break; }
  assert.equal(first.deref(), undefined); assert.equal(second.controller.stats().unsettledJobs, 1);
  for (const callback of queued) callback();
  await settle(); assert.equal(notices, 0);
  second.host.answer(0); await settle();
  assert.equal(second.controller.status('second')!.exact, true);
});

test('obsolete source callback cannot clear newer pending notice before a second current settlement', async () => {
  let notices = 0; const exact: boolean[] = [], packets: string[][] = [];
  const { host, controller } = fixture({ onChange: keys => { notices++; packets.push([...keys]); exact.push(controller.status('b')!.exact && controller.status('c')!.exact); } });
  controller.observe(demand('first', 1, true)); controller.flush();
  const original = globalThis.queueMicrotask, queued: (() => void)[] = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try {
    host.answer(0); await turn(); assert.equal(queued.length, 2);
    const oldContinuation = queued.shift()!, oldNotice = queued.shift()!;
    oldContinuation(); controller.setEnabled(false); controller.setEnabled(true);
    controller.observe(demand('second', 2, true, 'b')); controller.flush(); host.answer(1); await turn();
    assert.equal(queued.length, 2); oldNotice(); assert.equal(notices, 0);
    controller.observe(demand('third', 3, true, 'c')); controller.flush(); host.answer(2); await turn();
    assert.equal(queued.length, 3); // two continuations, still only one CURRENT notice.
    while (queued.length) queued.shift()!();
    assert.equal(notices, 1); assert.deepEqual(exact, [true]);
    assert.deepEqual(packets, [['b', 'c']], 'obsolete epoch cannot erase a current source key or deliver its old key');
  } finally { globalThis.queueMicrotask = original; }
});

test('classification success is emitted only after full source validation, never warm cached visits or stream close', async () => {
  const {host, controller:c} = fixture(); c.observe(demand('a\nt')); c.flush();
  assert.deepEqual(host.acceptedClassifications, []); host.answer(0); await settle();
  assert.deepEqual(host.acceptedClassifications, [host.generation]);
  for (let i=0; i<10; i++) { c.observe(demand('a\nt')); c.flush(); ranges(c); }
  assert.deepEqual(host.acceptedClassifications, [host.generation]); assert.equal(host.calls.length, 1);
  c.remove('source'); c.flush(); assert.equal(host.calls[1]!.request.op, 'stream.close');
  host.answer(1); await settle(); assert.deepEqual(host.acceptedClassifications, [host.generation]);
});

for (const outcome of ['malformed','wrong_coverage','wrong_vocabulary','wrong_revision','not_started','started','unknown','stale_provider','removed','disabled'] as const)
  test(`classification success is not emitted for ${outcome} source outcome`, async () => {
    const {host, controller:c} = fixture(); c.observe(demand('hello', 1, true)); c.flush();
    if (outcome==='malformed') host.calls[0]!.resolve({});
    else if (outcome==='wrong_coverage' || outcome==='wrong_vocabulary' || outcome==='wrong_revision') {
      const call = host.calls[0]!, resolve = call.resolve;
      call.resolve = (raw: any) => {
        call.resolve = resolve; // Do not intercept the common afterEach's later empty settlement.
        const chunk = raw.body.sources[0];
        if (outcome==='wrong_coverage') chunk.runs = [1, 0];
        if (outcome==='wrong_vocabulary') raw.body.vocabulary = 'b'.repeat(64);
        if (outcome==='wrong_revision') chunk.revision++;
        resolve(raw);
      };
      host.answer(0);
    }
    else if (outcome==='not_started' || outcome==='started') host.fault(0, 'busy', outcome);
    else if (outcome==='unknown') host.calls[0]!.reject(new Error('uncertain dispatched source'));
    else {
      if (outcome==='stale_provider') host.generation++;
      if (outcome==='removed') c.remove('source');
      if (outcome==='disabled') c.setEnabled(false);
      host.answer(0);
    }
    await settle(); assert.deepEqual(host.acceptedClassifications, []);
  });


test('style refusal requests metadata once; reconciliation never restarts a parser', async () => {
  const { host, controller: c } = await pendingStyle();
  host.fault(1, 'profile_changed'); await settle();
  const notice = c.profileReconciliationNeeded(); assert.ok(notice);
  assert.equal(notice.generation, host.generation); assert.equal(c.status('source')!.exact, true);
  assert.equal(c.workStatus('source').fallbackEligible, false);
  c.acknowledgeProfiles(notice.generation, notice.sequence); c.observe(demand('echo x', 1, true)); c.flush(); await settle();
  assert.equal(c.profileReconciliationNeeded(), undefined); assert.equal(host.calls.length, 2);
  assert.equal(c.stats().preparedBytes, 6); assert.equal(c.stats().styleRejections, 1);
});
test('style refusal metadata acknowledgment cannot erase a newer pending refusal', async () => {
  const { host, controller: c } = await pendingStyle();
  host.fault(1, 'profile_unavailable'); await settle(); const first = c.profileReconciliationNeeded(); assert.ok(first);
  selectNative(c, 'next', 'b'.repeat(64)); await settle(); host.fault(2, 'profile_changed'); await settle();
  const second = c.profileReconciliationNeeded(); assert.ok(second); assert.ok(second.sequence > first.sequence);
  c.acknowledgeProfiles(first.generation, first.sequence); assert.deepEqual(c.profileReconciliationNeeded(), second);
  c.acknowledgeProfiles(second.generation, second.sequence); c.flush();
  assert.equal(c.profileReconciliationNeeded(), undefined); assert.equal(host.calls.length, 3);
  assert.equal(c.stats().preparedBytes, 6); assert.equal(host.acceptedClassifications.length, 1);
});
test('repeated unavailable styles stop unchanged work without reopening source or clearing uncertainty', async () => {
  const { host, controller: c } = await pendingStyle(false);
  c.observe(demand('echo xy', 2)); c.flush(); host.calls[2]!.reject(new RequestFailure('unknown source append')); await settle();
  host.fault(1, 'profile_unavailable'); await settle(); const notice = c.profileReconciliationNeeded(); assert.ok(notice);
  c.acknowledgeProfiles(notice.generation, notice.sequence);
  for (let i = 0; i < 20; i++) { c.observe(demand('echo xy', 2)); c.flush(); }
  assert.equal(host.calls.length, 3); assert.equal(c.workStatus('source').execution, 'unknown');
  assert.equal(c.workStatus('source').fallbackEligible, false); assert.equal(c.stats().restarts, 0);
});
for (const outcome of ['busy', 'started', 'invalid_header', 'stale', 'removed'] as const) test(`style metadata demand excludes ${outcome} resolver outcome`, async () => {
  const { host, controller: c } = await pendingStyle();
  if (outcome === 'stale') host.generation++;
  if (outcome === 'removed') c.remove('source');
  if (outcome === 'invalid_header') host.calls[1]!.resolve({ v: 2, ticket: 'wrong', instance: 'daemon', assets: 'assets', status: 'error', error: { code: 'profile_changed', execution: 'not_started' } });
  else host.fault(1, outcome === 'busy' ? 'busy' : 'profile_changed', outcome === 'started' ? 'started' : 'not_started');
  await settle();
  // Even a style computation that started has not executed source work. A valid
  // definition fault still requests catalogue reconciliation independently.
  assert.equal(!!c.profileReconciliationNeeded(), outcome === 'started');
  assert.equal(host.calls.length, 2); assert.equal(c.stats().restarts, 0);
  assert.equal(host.acceptedClassifications.length, 1);
});
test('style metadata acknowledgment is inert after provider change, off and disposal', async () => {
  for (const transition of ['provider', 'off', 'dispose'] as const) {
    const { host, controller: c } = await pendingStyle(); host.fault(1, 'profile_changed'); await settle();
    const notice = c.profileReconciliationNeeded(); assert.ok(notice, `${transition} starts with its own pending reconciliation`);
    const calls = host.calls.length, prepared = c.stats().preparedBytes;
    if (transition === 'provider') host.generation++;
    else if (transition === 'off') c.setEnabled(false);
    else c.dispose();
    assert.equal(c.profileReconciliationNeeded(), undefined);
    c.acknowledgeProfiles(notice.generation, notice.sequence); c.flush(); await settle();
    assert.equal(c.profileReconciliationNeeded(), undefined); assert.equal(host.calls.length, calls);
    assert.equal(c.stats().preparedBytes, prepared);
  }
});

test('source observer identifies only changed keys and coalesces two current completions', async () => {
  const observed: string[][] = [];
  const { host, controller } = fixture({ onChange: (keys: readonly string[] = []) => { observed.push([...keys]); } });
  controller.observe(demand('a', 1, true, 'a')); controller.observe(demand('b', 1, true, 'b')); controller.flush();
  assert.equal(observed.length, 0);
  host.answer(0); host.answer(1); await settle();
  assert.deepEqual(observed.map(keys => keys.toSorted()), [['a', 'b']]);
  const before = controller.stats();
  controller.observe(demand('a', 1, true, 'a')); controller.flush(); await settle();
  assert.deepEqual(observed.map(keys => keys.toSorted()), [['a', 'b']]); assert.deepEqual(controller.stats(), before);
});

test('queued keyed notification removes a retired source without losing its current sibling', async () => {
  const observed: string[][] = [], queued: (() => void)[] = [];
  const { host, controller } = fixture({ onChange: (keys: readonly string[] = []) => { observed.push([...keys]); } });
  const original = global.queueMicrotask; global.queueMicrotask = callback => { queued.push(callback); };
  try {
    controller.observe(demand('a', 1, true, 'a')); controller.observe(demand('b', 1, true, 'b')); controller.flush();
    host.answer(0); host.answer(1); await Promise.resolve(); await Promise.resolve();
    assert.equal(controller.status('a')!.exact, true); assert.equal(controller.status('b')!.exact, true);
    assert.ok(queued.length); controller.remove('a');
    while (queued.length) queued.shift()!();
    assert.deepEqual(observed, [['b']]);
    controller.observe(demand('new', 1, true, 'a')); controller.flush(); host.answer(2);
    await Promise.resolve(); await Promise.resolve(); controller.remove('a');
    while (queued.length) queued.shift()!();
    assert.deepEqual(observed, [['b']], 'retirement after settlement cannot paint a recycled key');
  } finally { global.queueMicrotask = original; }
});

test('keyed terminal refusal identifies the failed source but not a warm unrelated owner', async () => {
  const observed: string[][] = [];
  const { host, controller } = fixture({ onChange: (keys: readonly string[] = []) => { observed.push([...keys]); } });
  controller.observe(demand('a', 1, true, 'a')); controller.flush(); host.answer(0); await settle(); observed.length = 0;
  controller.observe(demand('b', 1, true, 'b')); controller.flush(); host.fault(1, 'busy'); await settle();
  assert.deepEqual(observed, [['b']]);
  assert.equal(controller.status('a')!.exact, true); assert.equal(controller.status('b')!.fallbackEligible, true);
});

test('a source completion observed reentrantly belongs to a fresh notification packet', async () => {
  const observed: string[][] = [];
  const { host, controller } = fixture({ onChange: (keys: readonly string[] = []) => {
    observed.push([...keys]);
    if (observed.length === 1) {
      controller.observe(demand('b', 1, true, 'b')); controller.flush(); host.answer(1);
    }
  } });
  controller.observe(demand('a', 1, true, 'a')); controller.flush(); host.answer(0); await settle();
  assert.deepEqual(observed, [['a'], ['b']]);
  assert.equal(controller.status('a')!.exact, true); assert.equal(controller.status('b')!.exact, true);
  assert.equal(controller.stats().globalUnsettledJobs, 0);
});


test('canonical work permission survives off, unknown settlement and permits unrelated fresh fallback', async () => {
  const packets: string[][] = [];
  const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
  c.observe(demand('x', 1, true)); c.flush(); c.setEnabled(false);
  assert.equal(c.status('source'), undefined);
  assert.equal(c.workStatus('source').execution, 'unsettled');
  assert.equal(c.workStatus('source').fallbackEligible, false);
  assert.equal(c.workStatus('fresh').fallbackEligible, true);
  assert.equal(c.stats().retention.retainedBytes, 0);
  assert.ok(c.stats().bookkeepingBytes > 128, 'retired primitive evidence remains charged');
  host.calls[0]!.reject(new RequestFailure('unknown after cancellation')); await settle();
  assert.equal(c.workStatus('source').execution, 'unknown');
  assert.equal(c.workStatus('source').fallbackEligible, false);
  assert.deepEqual(packets, [['source']]);
  c.dispose(); assert.equal(c.stats().sourceRecords, 0); assert.equal(c.stats().bookkeepingBytes, 0);
});

test('canonical retired settlement distinguishes validated completion, no-start, malformed and started outcomes', async () => {
  for (const outcome of ['complete', 'not_started', 'malformed', 'started', 'forged', 'old_not_started'] as const) {
    const packets: string[][] = [];
    const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
    c.observe(demand('x', 1, true)); c.flush(); c.setEnabled(false);
    if (outcome === 'complete') host.answer(0);
    else if (outcome === 'not_started') host.fault(0, 'busy');
    else if (outcome === 'started') host.fault(0, 'engine_failure', 'started');
    else if (outcome === 'forged') host.calls[0]!.reject({ execution: 'not_started' });
    else if (outcome === 'old_not_started') host.calls[0]!.resolve({ v: PROTOCOL_VERSION, ticket: 'old-ticket', instance: description.instance,
      assets: description.assets, status: 'error', error: { code: 'busy', execution: 'not_started' } });
    else host.calls[0]!.resolve({ status: 'ok' });
    await settle();
    assert.equal(c.workStatus('source').fallbackEligible, outcome === 'complete' || outcome === 'not_started', outcome);
    assert.equal(c.workStatus('source').execution, outcome === 'complete' ? 'acknowledged' : outcome === 'not_started' ? 'not_started' : outcome === 'started' ? 'started' : 'unknown');
    assert.deepEqual(host.acceptedClassifications, []);
    assert.deepEqual(ranges(c), []); assert.equal(c.stats().retention.entries, 0);
    assert.equal(c.stats().committedLineCalls, 0); assert.equal(c.stats().tailCalls, 0);
    assert.deepEqual(packets, [['source']]); c.dispose();
  }
});

test('canonical style reconciliation never grants parser retry permission', async () => {
  const { host, controller: c } = await pendingStyle(); host.fault(1, 'profile_changed'); await settle();
  const need = c.profileReconciliationNeeded(); assert.ok(need);
  assert.equal(c.workStatus('source').profileRetryAllowed, false);
  c.acknowledgeProfiles(need.generation, need.sequence);
  for (let i = 0; i < 100; i++) assert.equal(c.workStatus('source').profileRetryAllowed, false);
  assert.equal(host.calls.length, 2); assert.equal(c.status('source')!.acknowledgedVersion, 1);
  c.setEnabled(false); assert.equal(c.workStatus('source').profileRetryAllowed, false);
});


test('terminal shared unknown survives provider changes and later no-start; pending alone is not sticky unknown', async () => {
  for (const terminalUnknown of [true, false]) {
    const { host, controller: c } = fixture();
    host.snapshot = () => ({ availability: host.ready ? 'ready' : 'initializing', reason: host.ready ? 'ready' : 'initializing',
      generation: host.generation, kind: 'shared', initialShared: true, description: host.ready ? host.description : undefined });
    c.observe(demand('x', 1, true)); c.flush();
    if (terminalUnknown) { host.calls[0]!.reject(new RequestFailure('shared unknown')); await settle(); }
    host.generation++; host.ready = false;
    c.observe(demand('x', 1, true));
    assert.equal(c.workStatus('source').fallbackEligible, false);
    if (!terminalUnknown) { host.answer(0); await settle(); assert.equal(c.workStatus('source').fallbackEligible, true); }
    host.ready = true; c.flush(); host.fault(1, 'busy'); await settle();
    assert.equal(c.workStatus('source').fallbackEligible, !terminalUnknown);
    c.ownedStopped(host.generation); assert.equal(c.workStatus('source').fallbackEligible, !terminalUnknown, 'owned reap never clears shared unknown');
    c.setEnabled(false); c.setEnabled(true);
    assert.equal(c.workStatus('source').fallbackEligible, !terminalUnknown);
    c.remove('source'); assert.equal(c.workStatus('source').fallbackEligible, true, 'explicit owner removal ends its evidence');
    assert.deepEqual(host.acceptedClassifications, []); c.dispose();
  }
});

test('owned reap releases only matching source evidence, never newer job or shared terminal unknown', async () => {
  const packets: string[][] = [];
  const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
  c.observe(demand('x', 1, true)); c.flush(); const generation = host.generation;
  host.calls[0]!.reject(new RequestFailure('owned unknown')); await settle(); c.setEnabled(false);
  assert.equal(c.workStatus('source').fallbackEligible, false);
  c.ownedStopped(generation + 1); assert.equal(c.workStatus('source').fallbackEligible, false);
  c.ownedStopped(generation); await settle(); assert.equal(c.workStatus('source').fallbackEligible, true);
  c.setEnabled(true); host.generation++; c.observe(demand('x', 1, true)); c.flush();
  c.ownedStopped(generation); assert.equal(c.workStatus('source').execution, 'unsettled');
  assert.equal(c.workStatus('source').fallbackEligible, false);
  host.fault(1, 'busy'); await settle(); assert.equal(c.workStatus('source').fallbackEligible, true);
  assert.deepEqual(host.acceptedClassifications, []); assert.ok(packets.length >= 2);
});

function retiredCaptureOwner(host: Host) {
  const c = new SourceController(host); c.observe(demand('x', 1, true)); c.flush(); c.setEnabled(false);
  const job = (c as unknown as { jobs: Map<number, { source?: object }> }).jobs.values().next().value!;
  return { owner: new WeakRef(c), payload: new WeakRef(job.source!) };
}
test('first off owner GC releases necessary retired-validation payload while retained callback keeps physical credit', async () => {
  assert.equal(typeof global.gc, 'function');
  const firstHost = new Host(), first = retiredCaptureOwner(firstHost), second = fixture();
  second.controller.observe(demand('y', 1, true)); second.controller.flush();
  const credit = second.controller.stats().globalTransientBytes;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
  assert.equal(first.owner.deref(), undefined); assert.equal(first.payload.deref(), undefined);
  assert.equal(second.controller.stats().globalTransientBytes, credit);
  assert.equal(second.controller.stats().globalBookkeepingBytes, second.controller.stats().bookkeepingBytes);
  firstHost.calls[0]!.resolve({}); await settle();
  assert.equal(second.controller.stats().globalUnsettledJobs, 1);
  second.host.answer(0); await settle(); assert.equal(second.controller.stats().globalUnsettledJobs, 0);
});

test('explicit owner/key reuse rejects stale terminal authority and disposal drops validation payload without early credit release', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('x', 1, true)); c.flush();
  c.remove('source'); c.observe(demand('y', 1, true));
  assert.equal(c.workStatus('source').execution, 'unsettled');
  host.calls[0]!.reject(new RequestFailure('old owner unknown')); await settle();
  assert.equal(host.calls.length, 2); assert.equal(c.workStatus('source').execution, 'unsettled');
  host.fault(1, 'busy'); await settle(); assert.equal(c.workStatus('source').fallbackEligible, true);
  c.observe(demand('z', 2, true)); c.flush();
  const jobs = (c as unknown as { jobs: Map<number, { source?: object }> }).jobs;
  assert.ok([...jobs.values()][0]!.source);
  const credit = c.stats().transientBytes; c.dispose();
  assert.equal([...jobs.values()][0]!.source, undefined); assert.equal(c.stats().transientBytes, credit);
  host.calls[2]!.resolve({}); await settle(); assert.equal(c.stats().transientBytes, 0); assert.equal(c.stats().bookkeepingBytes, 0);
});


test('validated old completion notifies current fallback permission across provider retirement without useful credit', async () => {
  const packets: string[][] = [];
  const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
  c.observe(demand('x', 1, true)); c.flush();
  host.generation++; host.ready = false; c.observe(demand('x', 1, true));
  assert.equal(c.workStatus('source').fallbackEligible, false);
  host.answer(0); await settle();
  assert.equal(c.workStatus('source').fallbackEligible, true); assert.deepEqual(packets, [['source']]);
  assert.deepEqual(host.acceptedClassifications, []); assert.deepEqual(ranges(c), []); assert.equal(host.calls.length, 1);
});

test('owned stopped pending capture drops payload and notifies off permission without early physical-credit release', async () => {
  const packets: string[][] = [];
  const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
  c.observe(demand('x', 1, true)); c.flush(); c.setEnabled(false);
  const credit = c.stats().transientBytes;
  c.ownedStopped(host.generation); await settle();
  assert.equal(c.workStatus('source').fallbackEligible, true); assert.deepEqual(packets, [['source']]);
  assert.equal(c.stats().captures, 0); assert.equal(c.stats().transientBytes, credit);
  host.calls[0]!.reject(new RequestFailure('old uncertain cancellation')); await settle();
  assert.equal(c.workStatus('source').fallbackEligible, true); assert.equal(c.stats().transientBytes, 0);
  assert.deepEqual(host.acceptedClassifications, []); assert.deepEqual(packets, [['source']]);
});


test('dispose preserves only required pending-open validation capture until validated remote lease cleanup settles', async () => {
  const { host, controller: c } = fixture(); c.observe(demand('x', 1, false)); c.flush();
  const credit = c.stats().transientBytes; c.dispose();
  assert.equal(c.stats().sourceRecords, 0); assert.equal(c.stats().retention.retainedBytes, 0);
  assert.equal(c.stats().captures, 1, 'required physical cleanup capture remains under its existing credit');
  assert.equal(c.stats().transientBytes, credit); assert.equal(c.workStatus('source').fallbackEligible, false);
  host.answer(0); await settle();
  assert.equal(host.calls.length, 2); assert.equal(host.calls[1]!.request.op, 'stream.close');
  assert.deepEqual(host.acceptedClassifications, []); assert.deepEqual(ranges(c), []);
  host.answer(1); await settle(); assert.equal(c.stats().remoteLeases, 0);
  assert.equal(c.stats().captures, 0); assert.equal(c.stats().globalTransientBytes, 0); assert.equal(c.stats().bookkeepingBytes, 0);
});


test('canonical correction F1: ready dirty demand forbids Pi before explicit native flush', async () => {
  const { host, controller: c } = fixture();
  c.observe(demand('x', 1, true));
  assert.equal(host.calls.length, 0);
  assert.equal(c.workStatus('source').fallbackEligible, false);
  assert.equal(c.workStatus('fresh').fallbackEligible, true);
  c.flush(); assert.equal(host.calls.length, 1);
  assert.equal(c.workStatus('source').fallbackEligible, false);
  host.fault(0, 'busy'); await settle();
  assert.equal(c.workStatus('source').fallbackEligible, true, 'terminal no-start is not queued native demand');
  c.observe(demand('x', 1, true)); c.flush(); assert.equal(host.calls.length, 1);
});

test('canonical correction F1: native capacity wait forbids Pi until its queued job settles no-start', async () => {
  const { host, controller: c } = fixture();
  for (const key of ['first', 'second', 'third']) c.observe(demand('x', 1, true, key));
  c.flush(); assert.equal(host.calls.length, 2); assert.equal(c.stats().captures, 2);
  assert.equal(c.workStatus('first').fallbackEligible, false);
  host.answer(0); await settle();
  assert.equal(host.calls.length, 3); assert.equal(host.calls[2]!.request.sources[0].text, 'x');
  assert.equal(c.workStatus('first').fallbackEligible, false);
  host.fault(2, 'busy'); await settle(); assert.equal(c.workStatus('first').fallbackEligible, true);
  host.answer(1); await settle();
});

for (const proof of ['owned_stop', 'validated_reply', 'typed_no_start', 'local_no_start'] as const) {
  test(`canonical correction F2: reobserve unavailable provider before ${proof} initializes only current execution`, async () => {
    for (const identityChange of [false, true]) {
      const packets: string[][] = [];
      const { host, controller: c } = fixture({ onChange: keys => packets.push([...keys]) });
      c.observe(demand('x', 1, true)); c.flush(); const credit = c.stats().transientBytes;
      c.setEnabled(false); assert.equal(c.stats().retention.retainedBytes, 0);
      host.generation++; host.ready = false; c.setEnabled(true);
      c.observe({ ...demand('x', 1, true), ...(identityChange ? { language: 'rust' } : {}) });
      assert.equal(c.workStatus('source').execution, 'unsettled');
      assert.equal(c.workStatus('source').fallbackEligible, false, 'prior held attempt remains authoritative');
      assert.equal(c.stats().transientBytes, credit); assert.equal(host.calls.length, 1);
      if (proof === 'owned_stop') c.ownedStopped(1);
      else if (proof === 'validated_reply') host.answer(0);
      else if (proof === 'typed_no_start') host.fault(0, 'busy');
      else host.calls[0]!.reject(new RequestFailure('local preflight', 'not_started'));
      await settle();
      assert.equal(c.workStatus('source').execution, 'not_started');
      assert.equal(c.workStatus('source').fallbackEligible, true);
      assert.deepEqual(packets, [['source']]); assert.equal(host.calls.length, 1);
      assert.deepEqual(host.acceptedClassifications, []); assert.deepEqual(ranges(c), []);
      assert.equal(c.stats().committedLineCalls, 0); assert.equal(c.stats().tailCalls, 0);
      if (proof === 'owned_stop') {
        assert.equal(c.stats().transientBytes, credit, 'reaping proof does not invent RPC settlement');
        host.calls[0]!.reject(new RequestFailure('old cancellation after reap')); await settle();
        assert.equal(c.workStatus('source').fallbackEligible, true); assert.deepEqual(packets, [['source']]);
      }
      assert.equal(c.stats().transientBytes, 0); c.dispose(); assert.equal(c.stats().bookkeepingBytes, 0);
    }
  });
}

test('canonical correction permission preserves fresh off startup unavailable and admission-refused no-start', () => {
  const { host, controller: c } = fixture();
  assert.equal(c.workStatus('fresh').fallbackEligible, true);
  host.ready = false; c.observe(demand('x', 1, true));
  assert.equal(c.workStatus('source').fallbackEligible, true, 'startup does not queue dispatchable native work');
  host.snapshot = () => ({ generation: host.generation, availability: 'unavailable', reason: 'optional_unavailable', initialShared: false });
  assert.equal(c.workStatus('source').fallbackEligible, true);
  c.setEnabled(false); assert.equal(c.workStatus('source').fallbackEligible, true); c.setEnabled(true);
  const refused = fixture({ maxTransientBytes: 128 });
  refused.controller.observe(demand('x', 1, true)); refused.controller.flush();
  assert.equal(refused.host.calls.length, 0);
  assert.equal(refused.controller.workStatus('source').fallbackEligible, true, 'local no-start admission refusal remains distinct');
});


test('canonical correction F2 guards retain old unknown evidence until exact owned proof, never shared proof', async () => {
  for (const kind of ['owned', 'shared'] as const) {
    const { host, controller: c } = fixture();
    host.snapshot = () => ({ availability: host.ready ? 'ready' : 'initializing', reason: host.ready ? 'ready' : 'initializing',
      generation: host.generation, kind, initialShared: kind === 'shared', description: host.ready ? host.description : undefined });
    c.observe(demand('x', 1, true)); c.flush();
    host.calls[0]!.reject(new RequestFailure('old terminal unknown')); await settle();
    c.setEnabled(false); host.generation++; host.ready = false; c.setEnabled(true);
    c.observe({ ...demand('x', 1, true), language: 'rust' });
    assert.equal(c.workStatus('source').execution, 'unknown'); assert.equal(c.workStatus('source').fallbackEligible, false);
    c.ownedStopped(2); assert.equal(c.workStatus('source').fallbackEligible, false, 'unrelated receipt is not old-work proof');
    c.ownedStopped(1); await settle();
    assert.equal(c.workStatus('source').fallbackEligible, kind === 'owned');
    assert.deepEqual(host.acceptedClassifications, []); assert.equal(host.calls.length, 1); c.dispose();
  }
});

for (const guard of ['transient', 'source-limit', 'missing-theme'] as const) {
  test(`local native admission ${guard} keeps source permission independent of desired theme`, async () => {
    const notices: string[][] = [];
    const { host, controller } = fixture({ ...(guard === 'transient' ? { maxTransientBytes: 128 } : {}), onChange: keys => { notices.push([...keys]); } });
    controller.observe(demand('xy', 1, true));
    if (guard === 'source-limit') host.description.limits.source_bytes = 1;
    if (guard === 'missing-theme') host.description.profiles = [{ ...description.profiles[0]!, id: 'new-profile' }];
    assert.equal(controller.workStatus('source').fallbackEligible, false);
    controller.flush(); await settle();
    assert.equal(controller.workStatus('source').fallbackEligible, guard !== 'missing-theme');
    if (guard === 'missing-theme') {
      assert.deepEqual(notices, []); assert.equal(host.calls.length, 1); host.answer(0); await settle();
      assert.equal(controller.status('source')!.exact, true); assert.equal(controller.displayBasis('source'), undefined);
    } else { assert.deepEqual(notices, [['source']]); assert.equal(host.calls.length, 0); }
    controller.flush(); await settle();
    assert.deepEqual(notices, [['source']]);
  });
}
test('local native admission after credit wake reports refusal and preserves its validated peer', async () => {
  const notices: string[] = [];
  const { host, controller } = fixture({ onChange: keys => { notices.push(...keys); } });
  controller.observe(demand('x', 1, true, 'peer')); controller.flush();
  controller.observe(demand('x', 1, true, 'busy-peer')); controller.flush();
  controller.observe(demand('xy', 1, true, 'waiting'));
  controller.flush(); assert.equal(host.calls.length, 2);
  assert.equal(controller.workStatus('waiting').fallbackEligible, false);
  host.description.limits.source_bytes = 1;
  host.answer(0); await settle();
  assert.equal(controller.workStatus('waiting').fallbackEligible, true);
  assert.equal(controller.status('peer')?.exact, true);
  assert.equal(notices.filter(key => key === 'waiting').length, 1);
  assert.equal(notices.filter(key => key === 'peer').length, 1);
  assert.equal(host.calls.length, 2);
  controller.flush(); await settle(); assert.equal(notices.filter(key => key === 'waiting').length, 1);
  host.answer(1); await settle();
  assert.equal(controller.status('busy-peer')?.exact, true);
});

async function pendingStyle(complete = true) {
  const result = fixture(); selectNative(result.controller);
  result.controller.observe(demand('echo x', 1, complete)); result.controller.flush(); result.host.answer(0); await settle();
  assert.equal(result.host.calls[1]!.request.op, 'styles.resolve');
  return result;
}
function selectNative(c: SourceController, id = 'native', selectedFingerprint = fingerprint) {
  assert.equal(c.setStyleSelection({ kind: 'native', id, fingerprint: selectedFingerprint }), true);
}
async function paint(c: SourceController, host: Host, sourceIndex: number, red = 80) {
  host.answer(sourceIndex); await settle();
  const index = host.calls.length - 1;
  if (host.calls[index]!.request.op === 'styles.resolve') { host.style(index, red); await settle(); }
  assert.ok(c.displayBasis('source'), 'display checks require an independently validated STYLE result');
}

function displaySnapshot(controller: SourceController, key = 'source') {
  const basis = controller.displayBasis(key);
  if (!basis) return undefined;
  let text: string | undefined;
  const spans: { start: number; end: number; style: ConcreteStyle }[] = [];
  const available = basis.visit((value, read) => {
    text = value;
    assert.equal(read((start, end, style) => spans.push({ start, end, style })), true);
  });
  return available ? { version: basis.version, generation: basis.generation, stamp: basis.stamp, text, spans } : undefined;
}

test('display basis: acknowledged full provisional colors stay paired with their own text during an append', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('a\nt')); c.flush(); await paint(c, host, 0);
  const initial = displaySnapshot(c)!; assert.equal(initial.text, 'a\nt'); assert.equal(initial.version, 1);
  assert.deepEqual(initial.spans.map(({ start, end }) => [start, end]), [[0, 2], [2, 3]]);
  assert.ok(initial.spans.every(({ style }) => style.foreground.kind === 'rgb' && style.foreground.r === 80));
  const before = c.stats(); c.observe(demand('a\ntx', 2));
  assert.deepEqual(displaySnapshot(c), initial); assert.deepEqual(ranges(c), [[0, 2, true]]);
  assert.equal(c.borrowSource('source')!.text, 'a\ntx');
  for (let i = 0; i < 100; i++) { assert.equal(c.displayStamp('source'), initial.stamp); displaySnapshot(c); }
  assert.equal(host.calls.length, 2); assert.equal(c.stats().preparedBytes, before.preparedBytes);
  c.flush(); await paint(c, host, 2);
  assert.equal(displaySnapshot(c)!.text, 'a\ntx'); assert.notEqual(c.displayStamp('source'), initial.stamp);
  assert.equal(host.calls.length, 3, 'existing context style is reused after append');
});

test('display basis: completion-only acknowledgement preserves paint effect but settles authority and lease', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('a\nt')); c.flush(); await paint(c, host, 0);
  const initial = displaySnapshot(c)!, paintStamp = c.displayBasis('source')!.paintStamp;
  c.observe(demand('a\nt', 2, true)); c.flush(); assert.equal(host.calls[2]!.request.append, '');
  host.answer(2); await settle(); const final = displaySnapshot(c)!;
  assert.equal(final.text, initial.text); assert.deepEqual(final.spans, initial.spans);
  assert.equal(c.displayBasis('source')!.paintStamp, paintStamp);
  assert.equal(final.version, 1, 'unchanged paint keeps its own semantic capture version');
  assert.equal(c.status('source')!.acknowledgedVersion, 2); assert.equal(c.status('source')!.exact, true);
  assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().globalUnsettledJobs, 0); assert.equal(host.calls.length, 3);
});

test('display basis: source rewrites retain one charged historical basis without asserting current coverage', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('echo red')); c.flush(); await paint(c, host, 0); const initial = displaySnapshot(c)!;
  c.observe(demand('echo blue', 2)); assert.deepEqual(displaySnapshot(c), initial);
  assert.deepEqual(ranges(c), []); assert.equal(c.status('source')!.exact, false); assert.equal(c.stats().retention.entries, 2);
  c.observe(demand('echo green', 3)); assert.deepEqual(displaySnapshot(c), initial); assert.equal(c.stats().retention.entries, 2);
  assert.equal(c.borrowSource('source')!.text, 'echo green'); c.flush();
  assert.equal(host.calls[2]!.request.op, 'stream.close'); host.answer(2); await settle();
  await paint(c, host, 3); assert.equal(displaySnapshot(c)!.text, 'echo green'); assert.equal(c.stats().retention.entries, 1);
  c.observe({ ...demand('echo green', 3), language: 'rust' }); assert.equal(c.displayBasis('source'), undefined); assert.equal(c.displayStamp('source'), 0);
});

test('display basis: frozen formation retains charged colors, closes work and ignores a late append', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('a\nt')); c.flush(); await paint(c, host, 0);
  const initial = displaySnapshot(c)!, retained = c.stats().retention.snapshotBytes;
  c.observe(demand('a\ntxy', 2)); c.flush();
  const physical = c.stats().globalTransientBytes;
  c.freeze('source');
  assert.equal(host.calls[2]!.signal!.aborted, true);
  assert.equal(c.stats().globalTransientBytes, physical, 'Abort is not actual settlement');
  assert.deepEqual(displaySnapshot(c), initial);
  assert.equal(c.borrowSource('source'), undefined);
  assert.equal(c.workStatus('source').fallbackEligible, false, 'Frozen presentation admits no new parser');
  assert.equal(c.stats().retention.snapshotBytes, retained, 'Discard waiting text without leaking frozen basis credit');
  assert.equal(c.observe(demand('resurrection', 3)), false);
  host.answer(2); await settle();
  assert.deepEqual(displaySnapshot(c), initial, 'Late colors cannot replace the frozen presentation');
  assert.equal(host.calls[3]!.request.op, 'stream.close');
  host.answer(3); await settle();
  assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().globalUnsettledJobs, 0);
  assert.deepEqual(host.acceptedClassifications, [host.generation], 'Stale reply does not reset useful native-work budget');
  const borrowed = c.displayBasis('source')!;
  c.remove('source');
  assert.equal(c.stats().retention.entries, 0); assert.equal(c.stats().retention.contexts, 0); assert.equal(c.stats().retention.styles, 0);
  assert.equal(borrowed.visit(() => assert.fail('Removed basis must not be visited')), false);
});

test('display basis: a frozen unanswered open closes its late lease while a neighboring source progresses', async () => {
  const { host, controller: c } = fixture();
  c.observe(demand('held')); c.flush(); c.freeze('source');
  assert.equal(c.stats().globalUnsettledJobs, 1); assert.equal(c.displayBasis('source'), undefined);
  c.observe(demand('peer', 1, true, 'peer')); c.flush();
  host.answer(1); await settle();
  assert.equal(c.status('peer')!.exact, true);
  host.answer(0); await settle();
  assert.equal(c.displayBasis('source'), undefined);
  assert.equal(host.calls[2]!.request.op, 'stream.close');
  host.answer(2); await settle();
  assert.equal(c.stats().remoteLeases, 0); assert.equal(c.stats().globalUnsettledJobs, 0);
  assert.equal(host.calls.length, 3);
  assert.equal(c.observe(demand('held', 2)), false);
});

test('display basis: zero parser-call counters cannot conceal changed validated styles', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('x')); c.flush(); await paint(c, host, 0); const initial = c.displayStamp('source');
  const parsed = c.stats().preparedBytes; selectNative(c, 'second', 'b'.repeat(64)); await settle();
  assert.equal(host.calls[2]!.request.op, 'styles.resolve'); host.style(2, 190); await settle();
  assert.equal(c.stats().tailCalls, 0); assert.equal(c.stats().committedLineCalls, 0); assert.equal(c.stats().preparedBytes, parsed);
  assert.notEqual(c.displayStamp('source'), initial);
  assert.ok(displaySnapshot(c)!.spans.every(({ style }) => style.foreground.kind === 'rgb' && style.foreground.r === 190));
  assert.equal(host.acceptedClassifications.length, 1);
});

async function detachedDisplayOwner(host: Host) {
  const controller = new SourceController(host);
  selectNative(controller); controller.observe(demand('owned display', 1, true)); controller.flush(); await paint(controller, host, 0);
  controller.freeze('source');
  return { owner: new WeakRef(controller), pool: new WeakRef((controller as unknown as { pool: object }).pool), view: controller.displayBasis('source')! };
}

test('display basis: a persistent view does not retain the first frozen owner or its pool', async () => {
  assert.equal(typeof global.gc, 'function');
  const first = await detachedDisplayOwner(new Host());
  const { controller: active } = fixture(); active.observe(demand('active', 1, true));
  assert.ok(first.view);
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await turn(); }
  assert.equal(first.owner.deref(), undefined); assert.equal(first.pool.deref(), undefined);
  assert.equal(first.view.visit(() => assert.fail('Collected display owner must not be visited')), false);
  assert.equal(active.stats().sourceRecords, 1);
});

test('display basis: frozen colors can be evicted without native re-admission and off drops charged payload', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } }); selectNative(c);
  c.observe(demand('echo one')); c.flush(); await paint(c, host, 0);
  const view = c.displayBasis('source')!; assert.ok(view); assert.ok(c.stats().retention.displayBytes > 0);
  assert.ok(c.stats().retention.retainedBytes > 4096 && c.stats().retention.retainedBytes < 65536);
  c.freeze('source'); c.flush(); assert.equal(host.calls[2]!.request.op, 'stream.close'); host.answer(2); await settle();
  assert.equal(c.observe(demand('x'.repeat(22000), 1, true, 'peer')), true);
  assert.equal(c.displayBasis('source'), undefined); assert.equal(c.displayStamp('source'), 0);
  assert.equal(view.visit(() => assert.fail('Evicted view cannot deliver')), false);
  assert.ok(c.stats().retention.retainedBytes <= 65536);
  const calls = host.calls.length;
  assert.equal(c.observe(demand('echo two', 2)), false); c.flush(); assert.equal(host.calls.length, calls + 1);
  assert.equal(host.calls[calls]!.request.op, 'highlight'); host.answer(calls); await settle();
  c.setEnabled(false); assert.equal(c.stats().retention.entries, 0); assert.equal(c.stats().retention.styles, 0);
  c.setEnabled(true); assert.equal(c.observe(demand('echo two', 3)), false);
  c.remove('source'); assert.equal(c.observe(demand('echo two', 1)), true);
});

test('display basis: retaining rewrite colors does not clear unresolved same-provider authority', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('echo old')); c.flush(); await paint(c, host, 0); const initial = c.displayStamp('source');
  c.observe(demand('echo older', 2)); c.flush(); host.calls[2]!.reject(new Error('uncertain RPC')); await settle();
  assert.equal(c.workStatus('source').execution, 'unknown'); c.observe(demand('echo rewrite', 3)); c.flush();
  assert.equal(c.displayStamp('source'), initial); assert.equal(c.workStatus('source').fallbackEligible, false);
  assert.equal(c.workStatus('source').execution, 'unknown');
  assert.deepEqual(host.calls.map(call => call.request.op), ['stream.open', 'styles.resolve', 'stream.append', 'stream.close']);
  host.answer(3); await settle(); assert.equal(c.workStatus('source').execution, 'unknown');
});

test('stream review F2: rewrite then provider recovery never promotes historical colors into committed coverage', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('if', 1, true)); c.flush(); await paint(c, host, 0);
  c.observe(demand('zz', 2, true)); c.flush();
  assert.deepEqual(ranges(c), []); assert.equal(c.status('source')?.exact, false);
  host.generation++; c.observe(demand('zz', 2, true)); c.flush();
  assert.deepEqual(ranges(c), [], 'recovery cannot make the old keyword apply to corrected text');
  assert.equal(c.status('source')?.exact, false); assert.equal(c.workStatus('source').fallbackEligible, false);
  let historical = '';
  assert.equal(c.displayBasis('source')?.visit(text => { historical = text; }), true);
  assert.equal(historical, 'if');
});

test('LIFO registry: standalone sources start newest first without serializing completion', async () => {
  const { host, controller: c } = fixture();
  for (let i = 0; i < 5; i++) c.observe(demand(`source ${i}`, 1, true, `source-${i}`));
  c.flush(); assert.deepEqual(host.calls.map(call => call.request.sources[0].text), ['source 4', 'source 3']);
  host.answer(1); await settle();
  assert.equal(c.status('source-3')?.exact, true); assert.equal(c.status('source-4')?.exact, false);
  assert.equal(host.calls[2]!.request.sources[0].text, 'source 2');
  for (const i of [0, 2, 3, 4]) { host.answer(i); await settle(); }
  assert.deepEqual(host.calls.map(call => call.request.sources[0].text), ['source 4', 'source 3', 'source 2', 'source 1', 'source 0']);
  assert.equal(c.stats().unsettledJobs, 0);
});

test('LIFO registry: preparation records obey capacity, retirement and native-off fallback lifetime', async () => {
  const limited = fixture({ maxBookkeepingBytes: 128 });
  assert.equal(limited.controller.registerPreparation({ keys: new Set(), prepare() { assert.fail('refused preparation'); } }), undefined);
  assert.equal(limited.controller.stats().bookkeepingBytes, 128);
  const { controller: c } = fixture();
  let visits = 0;
  const preparation = { keys: new Set<string>(), prepare() { visits++; } };
  const group = c.registerPreparation(preparation)!; assert.ok(group);
  c.setEnabled(false); c.queuePreparation(group); await settle(); assert.equal(visits, 1, 'local work remains eligible with native off');
  c.queuePreparation(group); c.unregisterPreparation(group); await settle(); assert.equal(visits, 1);
  assert.equal(c.stats().bookkeepingBytes, 128);
  const retired = c.registerPreparation(preparation)!;
  c.queuePreparation(retired); c.dispose(); await settle();
  assert.equal(visits, 1); assert.equal(c.stats().bookkeepingBytes, 0);
});

test('theme display: requested identity never relabels retained colors; rollback reuses matching styles without parsing', async () => {
  const { host, controller: c } = fixture(); selectNative(c); const a = demand('echo retained', 1, true);
  c.observe(a); c.flush(); await paint(c, host, 0); const display = displaySnapshot(c)!, prepared = c.stats().preparedBytes;
  selectNative(c, 'B', 'b'.repeat(64)); c.observe({ ...a, profile: 'B', fingerprint: 'b'.repeat(64) }); c.flush();
  assert.equal(host.calls[2]!.request.op, 'styles.resolve'); assert.equal(c.borrowSource('source')!.profile, 'B');
  assert.equal(c.displayBasis('source')!.profile, 'native'); assert.deepEqual(displaySnapshot(c), display);
  assert.equal(c.status('source')!.exact, true, 'semantic completion is independent of desired palette');
  selectNative(c); c.observe(a); c.flush(); await settle();
  assert.deepEqual(displaySnapshot(c)!.spans, display.spans); assert.equal(host.calls.length, 3); assert.equal(c.stats().preparedBytes, prepared);
  assert.equal(c.stats().unsettledJobs, 1, 'cached rollback never releases held obsolete STYLE credit');
  host.style(2, 170); await settle(); assert.deepEqual(displaySnapshot(c)!.spans, display.spans);
  assert.equal(c.displayBasis('source')!.profile, 'native'); assert.equal(host.acceptedClassifications.length, 1);
});

test('theme display: repeated pending palettes retain one semantic basis; actual language changes discard it', async () => {
  const { host, controller: c } = fixture(); selectNative(c); const a = demand('echo retained', 1, true);
  c.observe(a); c.flush(); await paint(c, host, 0); const initial = displaySnapshot(c)!, generation = c.status('source')!.generation;
  for (const byte of ['b', 'c', 'd', 'e']) {
    selectNative(c, byte, byte.repeat(64)); c.observe({ ...a, profile: byte, fingerprint: byte.repeat(64) });
    assert.deepEqual(displaySnapshot(c), initial); assert.equal(c.status('source')!.generation, generation);
    assert.equal(c.stats().retention.entries, 1, 'no parser or source history for theme selection');
  }
  c.observe({ ...a, version: 2, language: 'python' }); assert.equal(c.displayBasis('source'), undefined);
});

test('theme display: provisional rollback keeps parser lease; completion still needs one empty final append', async () => {
  const { host, controller: c } = fixture(); selectNative(c); const original = demand('echo partial');
  c.observe(original); c.flush(); await paint(c, host, 0); assert.equal(c.displayBasis('source')!.complete, false);
  const generation = c.status('source')!.generation;
  selectNative(c, 'preview', 'b'.repeat(64)); selectNative(c);
  c.observe({ ...original, complete: true }); c.flush();
  assert.equal(c.status('source')!.generation, generation); assert.equal(host.calls[2]!.request.op, 'stream.append');
  assert.equal(host.calls[2]!.request.append, ''); assert.equal(host.calls[2]!.request.final, true);
  host.answer(2); await settle(); assert.equal(c.status('source')!.exact, true); assert.equal(c.stats().remoteLeases, 0);
  assert.equal(host.calls.length, 3); assert.equal(host.acceptedClassifications.length, 2);
});

for (const alreadyPending of [false, true]) test(`theme display recovery: compatible provider resolves requested styles without source replay ${alreadyPending ? 'after' : 'during'} selection`, async () => {
  const { host, controller: c } = fixture(); selectNative(c); const original = demand('echo recovery', 1, true);
  c.observe(original); c.flush(); await paint(c, host, 0); const display = displaySnapshot(c)!;
  selectNative(c, 'B', 'b'.repeat(64));
  if (alreadyPending) { c.flush(); assert.equal(host.calls.length, 3); }
  host.generation++; c.observe({ ...original, profile: 'B', fingerprint: 'b'.repeat(64) }); c.flush();
  assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.acknowledgedVersion, undefined);
  assert.deepEqual(displaySnapshot(c), display); assert.equal(c.stats().preparedBytes, 13);
  if (alreadyPending) { host.style(2, 130); await settle(); }
  const styles = host.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.request.op === 'styles.resolve' && call.request.rules.id === 'B');
  for (const { index } of styles) { host.style(index, 130); await settle(); }
  assert.equal(c.displayBasis('source')!.profile, 'B'); assert.equal(c.displayBasis('source')!.fingerprint, 'b'.repeat(64));
  assert.equal(host.calls.filter(call => call.request.op === 'highlight').length, 1);
});

test('theme burst: superseding styles leaves already-dispatched work to settle normally without parser replay', async () => {
  const { host, controller: c } = fixture(); selectNative(c); const source = demand('echo original', 1, true);
  c.observe(source); c.flush(); await paint(c, host, 0);
  selectNative(c, 'B', 'b'.repeat(64)); await settle(); selectNative(c, 'C', 'c'.repeat(64)); await settle();
  assert.equal(host.calls[2]!.signal!.aborted, false); assert.equal(c.displayBasis('source')!.profile, 'native');
  host.style(2, 140); await settle(); assert.equal(host.calls[3]!.request.rules.id, 'C');
  assert.equal(c.workStatus('source').execution, 'acknowledged'); assert.equal(c.stats().preparedBytes, 13);
  host.style(3, 180); await settle(); assert.equal(c.displayBasis('source')!.profile, 'C');
  assert.equal(host.calls.length, 4); assert.equal(host.acceptedClassifications.length, 1);
});

test('theme burst: yielded preparation visits a linear number of weak registry entries', async () => {
  const { host, controller: c } = fixture(); selectNative(c); host.ready = false;
  const tasks: { keys: Set<string>; prepare(): void }[] = [];
  let prepared = 0, visits = 0;
  for (let i = 0; i < 32; i++) {
    const task = { keys: new Set<string>(), prepare() { prepared++; } }; tasks.push(task);
    const group = c.registerPreparation(task)!;
    const deref = group.preparation.deref.bind(group.preparation);
    group.preparation.deref = () => { visits++; return deref(); };
    c.queuePreparation(group);
  }
  for (let i = 0; i < 32; i++) await settle();
  assert.equal(prepared, tasks.length);
  assert.ok(visits <= 4 * tasks.length, `one preparation wave visited ${visits} entries for ${tasks.length} owners`);
  assert.equal(host.calls.length, 0);
});

test('theme burst: two same-turn settlements cannot strand a newer coalesced source', async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  c.observe(demand('old a', 1, true, 'a')); c.flush(); c.observe(demand('old b', 1, true, 'b')); c.flush();
  c.observe(demand('new a', 2, true, 'a')); c.observe(demand('new b', 2, true, 'b')); c.flush();
  host.answer(1); host.answer(0); await settle();
  assert.deepEqual(host.calls.slice(2).map(call => call.request.sources[0].text).sort(), ['new a', 'new b']);
});

test('theme burst: byte backpressure defers repeated group preparation with one physical job', async () => {
  const { host, controller: c } = fixture({ maxTransientBytes: 50000, retention: { maxBytes: 8192 } });
  host.description.limits.request_bytes = 1024; host.description.limits.reply_bytes = 1024;
  let prepared = 0;
  const tasks = Array.from({ length: 8 }, (_, i) => ({ keys: new Set([`byte-${i}`]), prepare() {
    prepared++; c.observe(demand('one', 1, true, `byte-${i}`));
  } }));
  for (const task of tasks) c.queuePreparation(c.registerPreparation(task)!);
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(host.calls.length, 1); assert.equal(prepared, 2, 'one bounded look-ahead discovers the byte refusal');
  for (let i = 0; i < 100; i++) { c.refreshPreparations(); await settle(); }
  assert.equal(host.calls.length, 1); assert.equal(prepared, 2, 'metadata cannot bypass exhausted byte credit');
});

for (const action of ['remove', 'freeze', 'off', 'rewrite'] as const) test(`theme selection: ${action} still cancels a held parser despite a changed desired palette`, async () => {
  const { host, controller: c } = fixture(); selectNative(c);
  host.description.profiles = [...description.profiles, { id: 'B', label: 'B', fingerprint: 'b'.repeat(64) }];
  const source = demand('echo old', 1, true);
  c.observe(source); c.flush();
  c.observe({ ...source, profile: 'B', fingerprint: 'b'.repeat(64) }); c.flush();
  assert.equal(host.calls[0]!.signal?.aborted, false);
  if (action === 'remove') c.remove('source');
  else if (action === 'freeze') c.freeze('source');
  else if (action === 'off') c.setEnabled(false);
  else c.observe({ ...source, profile: 'B', fingerprint: 'b'.repeat(64), text: 'corrected', version: 2 });
  assert.equal(host.calls[0]!.signal?.aborted, true, 'lifecycle cancellation owns every pending generation of this incarnation');
  assert.equal(c.stats().globalUnsettledJobs, 1, 'cancel delivery is not physical settlement');
  host.answer(0); await settle();
  assert.equal(c.displayBasis('source'), undefined, 'obsolete completion cannot restore retired display');
});

for (const code of ['profile_changed', 'profile_unavailable'] as const) test(`native definition refusal notifies source metadata demand: ${code}`, async () => {
  const packets: { keys: readonly string[]; groups: readonly number[] }[] = [];
  const { host, controller: c } = fixture({ onChange(keys, groups = []) { packets.push({ keys, groups }); } });
  selectNative(c); c.observe(demand('echo x', 1, true)); c.flush(); host.answer(0); await settle();
  assert.equal(host.calls[1]!.request.op, 'styles.resolve'); packets.length = 0;
  const prepared = c.stats().preparedBytes, classifications = host.acceptedClassifications.length;
  host.fault(1, code); await settle();
  const need = c.profileReconciliationNeeded(); assert.ok(need, 'a native STYLE definition fault must request fresh catalogue metadata');
  assert.deepEqual(packets, [{ keys: ['source'], groups: [] }], 'the client must be woken by one targeted coalesced notice');
  assert.equal(c.status('source')!.exact, true); assert.equal(c.status('source')!.acknowledgedVersion, 1);
  assert.equal(c.workStatus('source').profileRetryAllowed, false); assert.equal(c.workStatus('source').fallbackEligible, false);
  c.acknowledgeProfiles(need.generation, need.sequence); packets.length = 0;
  for (let i = 0; i < 100; i++) { c.observe(demand('echo x', 1, true)); c.flush(); }
  await settle(); assert.equal(host.calls.length, 2); assert.deepEqual(packets, []);
  selectNative(c, 'replacement', 'b'.repeat(64)); await settle();
  assert.equal(host.calls[2]!.request.op, 'styles.resolve'); host.style(2); await settle();
  assert.ok(c.displayBasis('source')); assert.equal(c.stats().preparedBytes, prepared);
  assert.equal(host.acceptedClassifications.length, classifications); assert.equal(c.stats().restarts, 0);
  assert.deepEqual(host.calls.map(call => call.request.op), ['highlight', 'styles.resolve', 'styles.resolve']);
});

test('unknown STYLE error codes do not invent a catalogue need or source retry', async () => {
  for (const code of ['busy', 'theme_unavailable']) {
    const packets: string[][] = [];
    const { host, controller: c } = fixture({ onChange(keys) { packets.push([...keys]); } });
    selectNative(c); c.observe(demand('echo x', 1, true)); c.flush(); host.answer(0); await settle();
    packets.length = 0; host.fault(1, code); await settle();
    assert.equal(c.profileReconciliationNeeded(), undefined); assert.deepEqual(packets, []);
    assert.equal(c.workStatus('source').profileRetryAllowed, false); assert.equal(c.status('source')!.exact, true);
    c.flush(); await settle(); assert.equal(host.calls.length, 2); assert.equal(host.acceptedClassifications.length, 1);
  }
});

test('geometry funding: useful group generations survive pressure; admission is not source authority', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  const preparation = { keys: new Set(['source']), prepare() { c.observe(demand('echo useful', 1, true)); } };
  const group = c.registerPreparation(preparation)!;
  c.queuePreparation(group, true); c.flush(); host.answer(0); await settle();
  const pool = semanticPool(c), own = c.status('source')!.generation!;
  assert.equal(pool.status(own)!.sourceVersion, 1);
  const neighbor = pool.admit('pressure-victim', 1, 'n'.repeat(4000)); assert.equal(neighbor.accepted, true);
  const funding = c.geometryFunding(group)!;
  assert.equal(funding.budget, pool.budget);
  const counts = c.stats(), calls = host.calls.length;
  const remaining = pool.budget.limit - pool.budget.stats().retainedBytes;
  const grant = funding.grant(remaining + 1); assert.ok(grant, 'evictable neighbor must fund the operation');
  assert.equal(grant.budget, pool.budget); assert.equal(pool.status(neighbor.generation!), undefined);
  assert.equal(pool.status(own)!.sourceVersion, 1, 'useful source remains resident without copying a protected-generation list');
  grant.close(); assert.equal(pool.budget.stats().outstandingPeakBytes, 0);
  await settle(); assert.equal(host.calls.length, calls); assert.equal(c.stats().preparedBytes, counts.preparedBytes);
  assert.equal(c.stats().piSourceRecords, counts.piSourceRecords); assert.equal(c.workStatus('source').fallbackEligible, false);
  c.unregisterPreparation(group); assert.equal(funding.grant(0), undefined, 'released group cannot mint new grants');
  const successor = c.registerPreparation(preparation)!; assert.notEqual(successor, group);
  assert.equal(funding.grant(0), undefined, 'new membership cannot revive the old operation handle');
  void preparation;
});

test('geometry funding: native Off preserves funded geometry; explicit removal and disposal close only new admission', () => {
  const { controller: c } = fixture();
  const preparation = { keys: new Set<string>(), prepare() {} }, group = c.registerPreparation(preparation)!;
  const funding = c.geometryFunding(group)!;
  assert.equal(c.geometryFunding({ ...group }), undefined, 'structural identity is insufficient');
  const grant = funding.grant(128)!; const retained = grant.consume(128); grant.close();
  c.setEnabled(false);
  const off = funding.grant(64); assert.ok(off, 'native Off is not presentation shutdown'); off.close();
  assert.equal(funding.budget.stats().retainedBytes, 128);
  c.dispose(); assert.equal(funding.grant(1), undefined); assert.equal(funding.budget.stats().retainedBytes, 128);
  retained.release(); assert.equal(funding.budget.stats().retainedBytes, 0); void preparation;
});

for (const settleFirst of [false, true]) test(`geometry funding: source/style pressure cancels only after render, credit waits for outcome (${settleFirst})`, async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  selectNative(c); c.observe(demand('echo A', 1, true)); c.flush(); await paint(c, host, 0);
  const previous = c.displayBasis('source')!;
  selectNative(c, 'next', 'b'.repeat(64)); await settle();
  assert.equal(host.calls[2]!.request.op, 'styles.resolve');
  c.observe(demand('echo other', 1, true, 'other')); c.flush();
  assert.equal(host.calls[3]!.request.op, 'highlight');
  let renderDepth = 0, duringRender = 0; const cancellations: number[] = [];
  let drained!: () => void; const cancellation = new Promise<void>(resolve => { drained = resolve; });
  for (const index of [2, 3]) host.calls[index]!.signal!.addEventListener('abort', () => {
    if (renderDepth) duringRender++; cancellations.push(index);
    if (cancellations.length === (settleFirst ? 1 : 2)) drained();
  }, { once: true });
  const funding = c.geometryFunding()!, before = c.stats();
  renderDepth++; try {
    assert.equal(funding.grant(funding.budget.limit), undefined, 'held physical captures prevent whole-budget admission');
    assert.equal(previous.role('panel'), undefined); assert.equal(c.stats().retention.entries, 0);
    c.flush(); assert.equal(duringRender, 0, 'transport cancellation would encode/write synchronously here');
    assert.deepEqual(cancellations, [], 'a synchronous flush cannot drain render-pressure cancellation');
    assert.equal(c.stats().globalUnsettledJobs, before.globalUnsettledJobs); assert.equal(host.calls.length, 4);
  } finally { renderDepth--; }
  if (settleFirst) host.answer(3);
  await awaitFixture(cancellation);
  assert.deepEqual(cancellations, settleFirst ? [2] : [2, 3]);
  assert.equal(c.stats().globalUnsettledJobs, settleFirst ? 1 : 2, 'abort alone is never settlement evidence');
  if (!settleFirst) host.answer(3); host.style(2); await settle();
  assert.equal(c.stats().globalUnsettledJobs, 0); assert.equal(c.displayBasis('source'), undefined);
  assert.equal(c.stats().preparedBytes, before.preparedBytes); assert.equal(host.calls.length, 4);
});

for (const action of ['off', 'remove', 'dispose'] as const) test(`geometry funding: explicit ${action} drains retired job synchronously without waiting for the render continuation`, async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  c.observe(demand('held', 1, true)); c.flush();
  let cancelled = 0; host.calls[0]!.signal!.addEventListener('abort', () => { cancelled++; }, { once: true });
  const funding = c.geometryFunding()!, grant = funding.grant(funding.budget.limit);
  assert.ok(grant, 'SOURCE request credit is separate from released logical data'); grant.close();
  assert.equal(cancelled, 0); assert.equal(c.stats().globalUnsettledJobs, 1);
  if (action === 'off') c.setEnabled(false); else if (action === 'remove') c.remove('source'); else c.dispose();
  assert.equal(cancelled, 1); assert.equal(c.stats().globalUnsettledJobs, 1); host.answer(0); await settle();
  assert.equal(c.stats().globalUnsettledJobs, 0); assert.equal(cancelled, 1);
});

function detachedGeometryFunding(host: Host) {
  const controller = new SourceController(host);
  return { weak: new WeakRef(controller), funding: controller.geometryFunding()! };
}
test('geometry funding: retained funding capability has no strong controller or source owner', async () => {
  assert.equal(typeof global.gc, 'function');
  const probe = detachedGeometryFunding(new Host());
  for (let i = 0; i < 80; i++) { await turn(); global.gc!(); await turn(); if (!probe.weak.deref()) break; }
  assert.equal(probe.weak.deref(), undefined); assert.equal(probe.funding.grant(0), undefined);
});

async function abandonedGeometryPreparation(controller: SourceController, kind: 'empty' | 'source' | 'palette') {
  let preparation: { keys: Set<string>; prepare(): void } | undefined = {
    keys: new Set(kind === 'source' ? ['source'] : []),
    prepare() { if (kind === 'source') controller.observe(demand('held group source', 1, true)); },
  };
  const group = controller.registerPreparation(preparation)!;
  if (kind !== 'empty') { controller.queuePreparation(group, true); controller.flush(); }
  // Keep the owner alive until previous cooperative continuations have finished.
  await turn(); await turn();
  const weak = new WeakRef(preparation); preparation = undefined;
  return { group, weak };
}
for (const kind of ['empty', 'source', 'palette'] as const) test(`geometry funding: automatic ${kind} preparation GC sweep cannot drain transport cancellation inside render`, async () => {
  assert.equal(typeof global.gc, 'function');
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  if (kind !== 'source') { c.observe(demand('held independent source', 1, true)); c.flush(); }
  if (kind === 'palette') selectNative(c);
  const abandoned = await abandonedGeometryPreparation(c, kind);
  for (let i = 0; i < 80; i++) { await turn(); global.gc!(); await turn(); if (!abandoned.weak.deref()) break; }
  assert.equal(abandoned.weak.deref(), undefined, 'actual owner GC is a required precondition');
  assert.equal(host.calls[0]!.request.op, 'highlight');
  if (kind === 'palette') assert.equal(host.calls[1]!.request.op, 'styles.resolve');
  const jobs = kind === 'palette' ? 2 : 1;
  assert.equal(c.stats().globalUnsettledJobs, jobs);
  let renderDepth = 0, inside = 0, aborted = 0, done!: () => void;
  const cancelled = new Promise<void>(resolve => { done = resolve; });
  for (const call of host.calls) call.signal!.addEventListener('abort', () => {
    if (renderDepth) inside++; if (++aborted === jobs) done();
  }, { once: true });
  c.refreshPreparations(); // Cold notification parks the actual existing cursor at the abandoned record.
  const funding = c.geometryFunding()!, before = c.stats();
  renderDepth++; try {
    funding.grant(funding.budget.limit)?.close();
    assert.equal(aborted, 0, 'geometry pressure alone defers cancellation');
    c.flush();
    assert.equal(inside, 0, 'automatic weak sweeping, including nested source removal, must stay transport-free');
    assert.equal(aborted, 0); assert.equal(c.stats().globalUnsettledJobs, jobs);
    assert.equal(c.geometryFunding(abandoned.group), undefined);
    assert.ok(c.stats().bookkeepingBytes < before.bookkeepingBytes, 'dead registration must actually be removed');
  } finally { renderDepth--; }
  await awaitFixture(cancelled); assert.equal(inside, 0); assert.equal(aborted, jobs);
  assert.equal(c.stats().globalUnsettledJobs, jobs, 'cleanup does not release physical request credit');
  host.answer(0); if (kind === 'palette') host.style(1); await settle();
  assert.equal(c.stats().globalUnsettledJobs, 0); assert.equal(c.displayBasis('source'), undefined);
  assert.equal(c.stats().preparedBytes, before.preparedBytes); assert.equal(host.calls.length, jobs);
});

test('geometry funding: explicit unregister remains immediate for a retired owned source', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  const preparation = { keys: new Set(['source']), prepare() { c.observe(demand('held owned source', 1, true)); } };
  const group = c.registerPreparation(preparation)!;
  c.queuePreparation(group, true); c.flush(); assert.equal(host.calls[0]!.request.op, 'highlight');
  let aborted = 0; host.calls[0]!.signal!.addEventListener('abort', () => { aborted++; }, { once: true });
  const funding = c.geometryFunding()!; funding.grant(funding.budget.limit)?.close();
  assert.equal(c.stats().retention.entries, 0); assert.equal(aborted, 0);
  c.unregisterPreparation(group);
  assert.equal(aborted, 1); assert.equal(c.stats().globalUnsettledJobs, 1);
  assert.equal(c.stats().sourceRecords, 0); assert.equal(c.geometryFunding(group), undefined);
  host.answer(0); await settle(); assert.equal(aborted, 1); assert.equal(c.stats().globalUnsettledJobs, 0);
  void preparation;
});

test('geometry funding: actual kernel, protected source and cache cleanup share one ledger through resize, pressure and native Off', async () => {
  const { host, controller: c } = fixture({ retention: { maxBytes: 65536 } });
  const text = 'echo 界\nnext', preparation = { keys: new Set(['source']), prepare() { c.observe(demand(text, 1, true)); } };
  const group = c.registerPreparation(preparation)!;
  c.queuePreparation(group, true); c.flush(); host.answer(0); await settle();
  const pool = semanticPool(c), generation = c.status('source')!.generation!, funding = c.geometryFunding(group)!;
  const cache = new RenderCache(), neutral = { open: '', close: '' };
  assert.equal(funding.budget, pool.budget);
  let grants = 0, peak = 0, segments = 0;
  const grant = (bytes: number) => {
    grants++; const result = funding.grant(bytes), stats = funding.budget.stats();
    peak = Math.max(peak, stats.retainedBytes + stats.outstandingPeakBytes);
    assert.ok(peak <= funding.budget.limit); return result;
  };
  const measured = measure(text, funding.budget, grant)!;
  const frame = (layout: MeasuredRowLayout) => {
    const painted = paintFlat(text, measured, layout, () => true, neutral, neutral, 0, funding.budget, grant);
    assert.ok(painted);
    return cache.put({ layout, painted }, paintRows(painted), 'bash', frameCleanup(layout.cleanupReceipt(), painted.cleanupReceipt()));
  };
  const previous = frame(reflow(measured, { mode: 'bash', width: 8 }, grant)!);
  const oldRows = paintRows(previous.value!.painted), measurementBytes = measured.allocationBytes;
  const before = c.stats(), calls = host.calls.length, accepted = host.acceptedClassifications.length;
  const neighbor = pool.admit('geometry-victim', 1, 'n'.repeat(8000)); assert.equal(neighbor.accepted, true);
  const fillingBytes = funding.budget.limit - funding.budget.stats().retainedBytes - 32;
  assert.ok(fillingBytes > 0);
  const raw = funding.budget.reserve(fillingBytes)!, filler = raw.consume(fillingBytes); raw.close();
  const filled = funding.budget.stats(); peak = Math.max(peak, filled.retainedBytes + filled.outstandingPeakBytes);
  const segment = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = () => { segments++; throw new Error('resize repeated source measurement'); };
  try {
    assert.equal(reflow(measured, { mode: 'bash', width: 4 }), undefined, 'raw budget cannot bypass the controlled pressure precondition');
    assert.deepEqual(paintRows(previous.value!.painted), oldRows); assert.ok(measured.isValid);
    const layout = reflow(measured, { mode: 'bash', width: 4 }, grant); assert.ok(layout);
    assert.equal(pool.status(neighbor.generation!), undefined, 'the controller evicts the unrelated source, not useful geometry');
    assert.equal(pool.status(generation)!.sourceVersion, 1, 'the active source generation is protected');
    const current = frame(layout); cache.drop(previous);
    assert.ok(current.value!.layout.isValid && current.value!.painted.isValid && measured.isValid);
    assert.equal(c.stats().preparedBytes, before.preparedBytes); assert.equal(c.stats().piSourceRecords, 0);
    await settle(); assert.equal(host.calls.length, calls); assert.equal(host.acceptedClassifications.length, accepted);
    filler.release(); c.setEnabled(false);
    assert.ok(measured.isValid && current.value!.layout.isValid && current.value!.painted.isValid);
    const off = funding.grant(0); assert.ok(off, 'native Off must not disable neutral presentation funding'); off.close();
    let callbacks = 0;
    const painted = current.value!.painted;
    assert.equal(painted.visitRows(() => {
      callbacks++; cache.clear();
      assert.ok(funding.budget.stats().retainedBytes > measurementBytes, 'callback-held painted rows stay charged after cache invalidation');
      assert.equal(funding.budget.reserve(funding.budget.limit), undefined);
    }), false);
    assert.equal(callbacks, 1); assert.equal(funding.budget.stats().retainedBytes, measurementBytes);
    measured.cleanupReceipt().release(); assert.equal(funding.budget.stats().retainedBytes, 0);
    assert.equal(host.calls.length, calls); assert.equal(host.acceptedClassifications.length, accepted);
    assert.equal(preparation.keys.size, 1); assert.equal(segments, 0);
    console.log(JSON.stringify({ geometryControllerCache: { grants, peak, limit: funding.budget.limit, segments,
      nativeRequestDelta: host.calls.length - calls, sourceAcceptanceDelta: host.acceptedClassifications.length - accepted,
      piSources: c.stats().piSourceRecords, finalBytes: funding.budget.stats().retainedBytes } }));
  } finally { Intl.Segmenter.prototype.segment = segment; filler.release(); cache.clear(); measured.dispose(); }
  assert.equal(funding.budget.stats().outstandingPeakBytes, 0);
});

test('runtime health: invalid SOURCE remains visible despite success of another source, without journal capture', async () => {
  const notices: string[] = [], records: string[] = [], health = new RuntimeHealth(message => notices.push(message));
  const { host, controller: c } = fixture({ diagnostic: health.sink(level => records.push(level)) });
  c.observe(demand('bad', 1, true, 'a')); c.observe(demand('good', 1, true, 'b')); c.flush();
  const a = host.calls.findIndex(call => call.request.sources?.[0]?.text === 'bad');
  const b = host.calls.findIndex(call => call.request.sources?.[0]?.text === 'good');
  host.calls[a]!.resolve({}); await settle();
  assert.equal(health.snapshot().errors, 1); assert.equal(health.snapshot().active, 1);
  assert.equal(c.workStatus('a').execution, 'unknown'); assert.ok(records.includes('ERROR'));
  host.answer(b); await settle(); assert.equal(c.workStatus('b').execution, 'acknowledged');
  assert.equal(health.snapshot().active, 1); assert.equal(notices.length, 1);
  c.remove('a'); assert.equal(health.snapshot().active, 0); assert.equal(health.snapshot().last?.state, 'released');
});

test('runtime health: expected SOURCE limit refusal and explicit native Off are not runtime errors', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  c.observe(demand('x', 1, true)); c.flush(); host.fault(0, 'source_limit'); await settle();
  assert.equal(health.snapshot().errors, 0);
  c.observe(demand('y', 1, true, 'pending')); c.flush(); const pending = host.calls.at(-1)!;
  c.setEnabled(false); pending.reject(new Error('cancelled during Off')); await settle();
  assert.equal(health.snapshot().errors, 0);
});

test('runtime health: unexpected STYLE response clears only after that owner publishes valid replacement styles', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  selectNative(c); c.observe(demand('x', 1, true)); c.flush(); host.answer(0); await settle();
  assert.equal(host.calls[1]!.request.op, 'styles.resolve'); host.calls[1]!.resolve({}); await settle();
  assert.equal(health.snapshot().active, 1); assert.equal(health.snapshot().issues[0]!.operation, 'styles');
  selectNative(c, 'replacement', 'b'.repeat(64)); c.flush(); await settle();
  const index = host.calls.length - 1; assert.equal(host.calls[index]!.request.op, 'styles.resolve');
  host.style(index); await settle(); assert.equal(health.snapshot().active, 0);
  assert.equal(health.snapshot().errors, 1); assert.equal(health.snapshot().last?.state, 'recovered');
});

test('runtime health: actual encoded frame refusal keeps no-start authority without reporting an unexpected error', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  host.description.limits.request_bytes = 1024;
  c.observe(demand('"'.repeat(600), 1, true)); c.flush(); await settle();
  assert.equal(host.calls.length, 0); assert.equal(c.workStatus('source').execution, 'not_started');
  assert.equal(health.snapshot().errors, 0); assert.equal(c.stats().unsettledJobs, 0);
});

for (const rejected of [false, true]) test(`runtime health: obsolete STYLE ${rejected ? 'rejection' : 'invalid reply'} cannot reopen healthy cached rollback`, async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  selectNative(c); const a = demand('echo retained', 1, true); c.observe(a); c.flush(); await paint(c, host, 0);
  selectNative(c, 'B', 'b'.repeat(64)); c.observe({ ...a, profile: 'B', fingerprint: 'b'.repeat(64) }); c.flush();
  assert.equal(host.calls[2]!.request.op, 'styles.resolve');
  selectNative(c); c.observe(a); c.flush(); await settle(); assert.equal(c.stats().unsettledJobs, 1);
  if (rejected) host.calls[2]!.reject(new Error('PRIVATE_OLD_THEME')); else host.calls[2]!.resolve({});
  await settle(); assert.equal(c.displayBasis('source')!.profile, 'native');
  assert.equal(health.snapshot().errors, 0); assert.equal(health.snapshot().active, 0);
});

test('runtime health: unexpected lease-close failure belongs to the live source despite the cleanup-job sentinel', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  c.observe(demand('x\n', 1)); c.flush(); host.answer(0); await settle();
  c.freeze('source'); c.flush(); await settle();
  const index = host.calls.findIndex(call => call.request.op === 'stream.close'); assert.ok(index >= 0);
  host.calls[index]!.resolve({}); await settle();
  assert.equal(health.snapshot().errors, 1); assert.match(health.snapshot().issues[0]!.operation, /^lease:/);
  c.remove('source'); assert.equal(health.snapshot().active, 0); assert.equal(health.snapshot().last?.state, 'released');
});

test('runtime health: removed owners and replacement sources cannot inherit an obsolete close failure', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  c.observe(demand('x\n', 1)); c.flush(); host.answer(0); await settle(); c.freeze('source'); c.flush(); await settle();
  const index = host.calls.findIndex(call => call.request.op === 'stream.close'); assert.ok(index >= 0);
  c.remove('source'); c.observe(demand('new owner', 1, true));
  host.calls[index]!.resolve({}); await settle(); assert.equal(health.snapshot().errors, 0);
});

test('runtime health: cleanup generated by a late removed-source open cannot blame a replacement with the same key', async () => {
  const health = new RuntimeHealth(() => {}), { host, controller: c } = fixture({ diagnostic: health.sink(() => {}) });
  c.observe(demand('old\n', 1)); c.flush();
  c.remove('source'); c.observe(demand('', 1, true));
  host.answer(0); await settle(); c.flush(); await settle();
  const index = host.calls.findIndex(call => call.request.op === 'stream.close'); assert.ok(index >= 0, 'late lease still requires cleanup');
  host.calls[index]!.resolve({}); await settle();
  assert.equal(health.snapshot().errors, 0); assert.equal(health.snapshot().active, 0);
  assert.equal(c.stats().pendingCloses, 0);
});
