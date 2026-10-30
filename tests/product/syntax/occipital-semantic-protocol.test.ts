import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSemanticDescription, decodeSemanticEnvelope, decodeSemanticStyleReply, decodeSemanticSourceReply, decodeSemanticClosed } from '../../../src/occipital/semantic-protocol.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';
const fp = 'a'.repeat(64), rules = 'b'.repeat(64);
const limits = {
  request_bytes: 64 << 20, reply_bytes: HIGHLIGHT_LIMITS.dataWireBytes, control_request_bytes: 64 << 10, control_reply_bytes: 64 << 10,
  source_bytes: 64 << 20, line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000,
  state_pool_bytes: 256 << 20, leases: 4096, leases_per_route: 1024, runs: (64 << 20) / 4,
  idle_ms: 60000, age_ms: 600000, quantum_ms: 2, data_per_route: 2, control_per_route: 2, routes: 8, workers: 4,
};
const runtime = { pid: 123, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 };
const descriptor = () => ({ kind: 'descriptor', protocol_version: 4, contexts_revision: 1, resolver_revision: 3, source_hint_revision: 2,
  vocabulary: { fingerprint: fp, count: 20 }, assets: 'syntax-assets', backend_version: '0.2.0',
  capability: 'syntax-highlight/v4', service: 'syntax', operations: ['describe', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve'],
  modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'], limits, runtime });
const envelope = (body: unknown, patch: Record<string, unknown> = {}) => ({ v: 4, ticket: 'ticket', instance: 'instance', assets: 'syntax-assets', status: 'ok', body, ...patch });
const identity = { instance: 'instance', assets: 'syntax-assets', vocabulary: { fingerprint: fp, count: 20 } };
const expression = { foreground: { kind: 'rgb', r: 200, g: 100, b: 50 }, background: { kind: 'rgb', r: 0, g: 0, b: 0 }, attributes: 0, attribute_mask: 31 };
const styles = () => ({ kind: 'styles', vocabulary: fp, rules, styles: [expression], indices: [1] });

test('semantic protocol v4: headers validate exact framing, correlation and provider identity before exposing a body', () => {
  const body = { kind: 'closed' };
  assert.equal(decodeSemanticEnvelope(envelope(body), 'ticket', identity).body, body);
  for (const patch of [{ v: 2 }, { ticket: 'old' }, { instance: 'other' }, { assets: 'other' }, { extra: true }, { status: 'error' }, { error: { code: 'busy', execution: 'not_started' } }]) {
    assert.throws(() => decodeSemanticEnvelope(envelope(body, patch), 'ticket', identity));
  }
  for (const execution of ['not_started', 'started']) {
    const raw = { v: 4, ticket: 'ticket', instance: 'instance', assets: 'syntax-assets', status: 'error', error: { code: 'busy', execution } };
    assert.throws(() => decodeSemanticEnvelope(raw, 'ticket', identity), (error: unknown) => error instanceof Error && 'execution' in error && error.execution === execution);
  }
});

test('semantic protocol v4: descriptor advertises the bounded source/style contract without a theme catalogue', () => {
  const raw = descriptor(), value = decodeSemanticDescription(envelope(raw), 'ticket');
  assert.equal(value.vocabulary.fingerprint, fp); assert.equal(value.vocabulary.count, 20);
  assert.deepEqual(raw.operations, ['describe', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve']);
  assert.equal(value.source_hint_revision, 2);
  assert.ok(!Object.hasOwn(value, 'profiles'));
  for (const patch of [{ protocol_version: 3 }, { contexts_revision: 0 }, { resolver_revision: 2 }, { source_hint_revision: 0 }, { source_hint_revision: 1 },
    { vocabulary: { fingerprint: 'other', count: 20 } }, { vocabulary: { fingerprint: fp, count: 0 } },
    { operations: raw.operations.filter(op => op !== 'styles.resolve') }, { operations: [...raw.operations, 'themes.refresh'] },
    { profiles: [{ id: 'pi', label: 'Pi', fingerprint: fp }] }, { palette_revision: 1 }, { catalogue_revision: 0 },
    { limits: { ...limits, styles: 4105 } }]) assert.throws(() => decodeSemanticDescription(envelope({ ...raw, ...patch }), 'ticket'));
});

test('semantic protocol v4: rule identity is checked before typed style indices are allocated', () => {
  const expected = { vocabulary: fp, rules, bindingSlots: 0 } as const;
  const result = decodeSemanticStyleReply(envelope(styles()), 'ticket', identity, expected, 1, 1 << 20);
  assert.equal(result.styles.length, 1);
  assert.equal(Object.hasOwn(result, 'palette'), false);
  const wrong = { ...styles(), rules: 'd'.repeat(64) };
  const original = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try {
    assert.throws(() => decodeSemanticStyleReply(envelope(wrong), 'ticket', identity, expected, 1, 1 << 20));
    assert.equal(allocations, 0);
  } finally { globalThis.Uint32Array = original; }
});

test('semantic protocol v4: source replies bind to described vocabulary and exact source authority, never a palette', () => {
  const provider = decodeSemanticDescription(envelope(descriptor()), 'ticket');
  const counters = { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 2 };
  const chunk = { key: 'source', generation: 1, source_version: 1, revision: 1, source_bytes: 2, replace_from: 0,
    committed_bytes: 2, complete: true, contexts: [[0, 1]], runs: [2, 1], counters };
  const expected = { key: 'source', generation: 1, source_version: 1, revision: 1, source_bytes: 2, replace_from: 0, complete: true, replacementText: 'λ' };
  const source = { kind: 'source', vocabulary: fp, sources: [chunk] };
  assert.deepEqual(decodeSemanticSourceReply(envelope(source), 'ticket', provider, [expected], 1 << 20).sources[0]!.contexts[0], new Uint32Array([1]));
  for (const patch of [{ vocabulary: 'd'.repeat(64) }, { sources: [{ ...chunk, generation: 2 }] }, { sources: [{ ...chunk, profile: 'pi' }] }])
    assert.throws(() => decodeSemanticSourceReply(envelope({ ...source, ...patch }), 'ticket', provider, [expected], 1 << 20));
  assert.throws(() => decodeSemanticSourceReply(envelope(source, { instance: 'old' }), 'ticket', provider, [expected], 1 << 20));
  decodeSemanticClosed(envelope({ kind: 'closed' }), 'ticket', provider);
  assert.throws(() => decodeSemanticClosed(envelope({ kind: 'closed', lease: 'other' }), 'ticket', provider));
});

test('semantic protocol v4: raw DATA decoding enforces negotiated bytes before typed allocation', () => {
  // A direct unknown-object call has no transport-admission receipt. The decoder
  // must still enforce smaller negotiated limits before materializing arrays.
  const provider = decodeSemanticDescription(envelope(descriptor()), 'ticket');
  const pairs = 4096, text = 'x'.repeat(pairs), values: number[] = [];
  for (let i = 0; i < pairs; i++) values.push(1, 1 + i % 2);
  const runs = values;
  const counters = { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: pairs };
  const chunk = { key: 'source', generation: 1, source_version: 1, revision: 1, source_bytes: pairs, replace_from: 0,
    committed_bytes: pairs, complete: true, contexts: [[0, 1], [0, 2]], runs, counters };
  const expected = { key: 'source', generation: 1, source_version: 1, revision: 1, source_bytes: pairs, replace_from: 0, complete: true, replacementText: text };
  const decoded = decodeSemanticSourceReply(envelope({ kind: 'source', vocabulary: fp, sources: [chunk] }), 'ticket', provider, [expected], 1 << 24);
  assert.equal(decoded.sources.length, 1);
  const original = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try {
    const smaller = { ...provider, limits: { ...provider.limits, reply_bytes: 2048 } };
    assert.throws(() => decodeSemanticSourceReply(envelope({ kind: 'source', vocabulary: fp, sources: [chunk] }), 'ticket', smaller, [expected], 1 << 24));
    assert.equal(allocations, 0);
  } finally { globalThis.Uint32Array = original; }
});

test('semantic protocol v4: smaller advertised run and batch caps apply before any typed-vector allocation', () => {
  const provider = decodeSemanticDescription(envelope({ ...descriptor(), limits: { ...limits, runs: 1, batch_sources: 1 } }), 'ticket');
  const counters = { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 2 };
  const source = (key: string, runs = [2, 1]) => ({ key, generation: 1, source_version: 1, revision: 1, source_bytes: 2,
    replace_from: 0, committed_bytes: 2, complete: true, contexts: [[0, 1]], runs, counters });
  const expected = (key: string) => ({ key, generation: 1, source_version: 1, revision: 1, source_bytes: 2,
    replace_from: 0, complete: true, replacementText: 'ab' });
  const body = (...sources: ReturnType<typeof source>[]) => envelope({ kind: 'source', vocabulary: fp, sources });
  assert.equal(decodeSemanticSourceReply(body(source('a')), 'ticket', provider, [expected('a')], 1 << 20).sources.length, 1);
  const original = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try {
    assert.throws(() => decodeSemanticSourceReply(body(source('a', [1, 1, 1, 0])), 'ticket', provider, [expected('a')], 1 << 20));
    assert.throws(() => decodeSemanticSourceReply(body(source('a'), source('b')), 'ticket', provider, [expected('a'), expected('b')], 1 << 20));
    assert.equal(allocations, 0);
  } finally { globalThis.Uint32Array = original; }
});

test('semantic protocol v4: descriptor metadata remains bounded, exact and detached with actual server limits', () => {
  const raw = descriptor();
  for (const patch of [{ capability: null }, { service: null }, { assets: 'other' }, { modes: [] }, { admission: [] },
    { profiles: [] }, { catalogue_revision: 0 }, { palette_revision: 1 }, { diagnostic: 'x'.repeat(257) },
    { operations: [...raw.operations, 'themes.refresh'] }, { limits: { ...limits, source_bytes: 0 } }])
    assert.throws(() => decodeSemanticDescription(envelope({ ...raw, ...patch }), 'ticket'));
  const value = decodeSemanticDescription(envelope({ ...raw, limits: { ...limits, age_ms: 900000, quantum_ms: 10 } }), 'ticket');
  assert.equal(value.limits.age_ms, 900000); assert.equal(value.limits.quantum_ms, 10);
});

test('semantic protocol v4: generic styles support more than 512 admitted foreground/font combinations', () => {
  const count = 600, body = styles();
  body.styles = Array.from({ length: count }, (_, i) => ({ foreground: { kind: 'rgb', r: Math.floor(i / 16), g: 0, b: 0 },
    background: { kind: 'rgb', r: 0, g: 0, b: 0 }, attributes: i % 16, attribute_mask: 31 }));
  body.indices = Array.from({ length: count }, (_, i) => i + 1);
  const result = decodeSemanticStyleReply(envelope(body), 'ticket', identity, { vocabulary: fp, rules, bindingSlots: 0 }, count, 1 << 20);
  assert.equal(result.styles.length, count); assert.equal(result.indices.length, count); assert.equal(result.styles.at(-1)!.attributes, 7);
});

test('semantic protocol v4: measured STYLE bytes preserve smaller caps, shape checks and raw-call fallback', () => {
  const expected = { vocabulary: fp, rules, bindingSlots: 0 } as const;
  const value = envelope(styles()), bytes = Buffer.byteLength(JSON.stringify(value));
  const measured = { ticket: 'ticket', bytes };
  assert.equal(decodeSemanticStyleReply(value, 'ticket', identity, expected, 1, 1 << 20, measured).styles.length, 1);
  const smaller = { ...identity, limits: { ...decodeSemanticDescription(envelope(descriptor()), 'ticket').limits, reply_bytes: bytes - 1 } };
  assert.throws(() => decodeSemanticStyleReply(value, 'ticket', smaller, expected, 1, 1 << 20, measured), /byte limit/);
  for (const invalid of [0, -1, NaN, Infinity, 0.5, HIGHLIGHT_LIMITS.dataWireBytes + 1])
    assert.throws(() => decodeSemanticStyleReply(value, 'ticket', identity, expected, 1, 1 << 20, { ticket: 'ticket', bytes: invalid }), /byte limit/);
  assert.throws(() => decodeSemanticStyleReply(value, 'ticket', smaller, expected, 1, 1 << 20, { ticket: 'another', bytes: 1 }), /byte limit/);
  assert.throws(() => decodeSemanticStyleReply(envelope({ ...styles(), rules: 'd'.repeat(64) }), 'ticket', identity, expected, 1, 1 << 20, measured));
  assert.throws(() => decodeSemanticStyleReply(envelope(styles(), { ticket: 'other' }), 'ticket', identity, expected, 1, 1 << 20, measured));
});
