import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnv, readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';
import { decodeSemanticDescription, decodeSemanticSourceReply, decodeSemanticStyleReply, SEMANTIC_PROTOCOL_VERSION as VERSION } from '../../../src/occipital/semantic-protocol.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { createSemanticRuleDefinition } from '../../../src/syntax/semantic-rules.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';

const binary = validateNative(readInputs()).path;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'occipital-native-client-'));
  for (const name of ['home', 'config', 'data', 'cache', 'run']) await mkdir(join(root, name));
  const env = childEnv(root);
  Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run') });
  const transport = new StdioTransport({ command: binary, args: ['--stdio'], env, cwd: root, requestDeadlineMs: 10_000, terminateGraceMs: 100 });
  let sequence = 0;
  async function call(request: Record<string, unknown>): Promise<any> {
    const ticket = `call-${++sequence}`, reply = await transport.request({ ...request, v: VERSION, ticket }) as any;
    assert.equal(reply.ticket, ticket); assert.equal(reply.v, VERSION); return reply;
  }
  const raw = await call({ op: 'describe' }), descriptor = decodeSemanticDescription(raw, raw.ticket);
  function decode(reply: any, text: string, version = 1, previous?: SemanticChunk, complete = true): SemanticChunk {
    return decodeSemanticSourceReply(reply, reply.ticket, descriptor, [{ key: 'code', generation: 1, source_version: version,
      revision: previous ? previous.revision + 1 : 1, source_bytes: Buffer.byteLength(text), replace_from: previous?.committed_bytes ?? 0, complete,
      ...(previous?.lease ? { lease: previous.lease } : {}), replacementText: Buffer.from(text).subarray(previous?.committed_bytes ?? 0).toString('utf8') }], 64 << 20).sources[0]!;
  }
  async function source(text: string, language = 'bash', complete = true) {
    const reply = await call({ op: complete ? 'highlight' : 'stream.open', instance: descriptor.instance, admission: 'bounded_queue', queue_wait_ms: 1000,
      sources: [{ key: 'code', generation: 1, source_version: 1, hint: { language }, text }] });
    assert.equal(reply.status, 'ok'); return decode(reply, text, 1, undefined, complete);
  }
  async function append(previous: SemanticChunk, delta: string, complete: boolean) {
    return call({ op: 'stream.append', instance: descriptor.instance, admission: 'bounded_queue', queue_wait_ms: 1000, key: 'code', lease: previous.lease,
      generation: 1, source_version: previous.source_version + 1, base_revision: previous.revision, base_bytes: previous.source_bytes, append: delta, final: complete });
  }
  async function close() {
    await transport.close(); const state = transport.stats();
    assert.equal(state.childState, 'exited'); assert.equal(state.unsettledData, 0); assert.equal(state.unsettledControl, 0);
    assert.equal(state.retainedBytes, 0); assert.equal(state.liveTimers, 0); assert.equal(state.abortListeners, 0); assert.equal(state.ownedListeners, 0);
    await rm(root, { recursive: true, force: true });
  }
  return { transport, descriptor, call, decode, source, append, close };
}
// Compare actual scope stacks, never reply-local context IDs. Coalesce equivalent
// adjacent spans so independent finite/stream response factoring is irrelevant.
type Span = [number, string];
function spans(chunk: SemanticChunk): Span[] {
  const result: Span[] = [];
  for (let i = 0; i < chunk.runs.length; i += 2) {
    const id = chunk.runs[i + 1]!, value = id ? JSON.stringify([...chunk.contexts[id - 1]!]) : 'unclassified';
    if (result.at(-1)?.[1] === value) result[result.length - 1]![0] = chunk.runs[i]!;
    else result.push([chunk.runs[i]!, value]);
  }
  return result;
}
function patched(previous: Span[], next: SemanticChunk): Span[] {
  const result = previous.filter((_row, index) => !index || previous[index - 1]![0] < next.replace_from).map(([end, value]): Span => [Math.min(end, next.replace_from), value]);
  if (!next.replace_from) result.length = 0;
  for (const row of spans(next)) {
    if (result.at(-1)?.[1] === row[1]) result[result.length - 1]![0] = row[0]; else result.push(row);
  }
  return result;
}

test('actual owned helper preserves compact UTF8 highlighting and incremental work counters', async () => {
  const f = await fixture();
  try {
    const prefix = "echo α\necho '", suffix = "value'\n", first = await f.source(prefix, 'bash', false);
    assert.equal(first.counters.committed_line_calls, 1); assert.equal(first.counters.tail_calls, 1); assert.equal(first.source_bytes, Buffer.byteLength(prefix));
    const reply = await f.append(first, suffix, true); assert.equal(reply.status, 'ok');
    const final = f.decode(reply, prefix + suffix, 2, first);
    assert.equal(final.counters.committed_line_calls, 1); assert.equal(final.counters.tail_calls, 0); assert.equal(final.replace_from, Buffer.byteLength('echo α\n'));
    assert.equal(final.source_bytes, Buffer.byteLength(prefix + suffix)); assert.equal(final.complete, true);
    const shot = await f.source(prefix + suffix);
    assert.deepEqual(spans(shot), patched(spans(first), final)); assert.equal(shot.counters.committed_line_calls, 2);
    const stale = await f.append(first, 'x', false);
    assert.equal(stale.status, 'error'); assert.equal(stale.error.code, 'restart_required'); assert.equal(stale.error.execution, 'not_started');
    assert.equal(f.transport.stats().spawnCount, 1);
  } finally { await f.close(); }
});

test('actual owned helper validates whole batches before work and resolves the common rule definition', async () => {
  const f = await fixture();
  try {
    const parsed = await f.source('echo "literal"\n'), contexts = parsed.contexts.map(context => [0, ...context]);
    const definition = createSemanticRuleDefinition();
    const reply = await f.call({ op: 'styles.resolve', instance: f.descriptor.instance, vocabulary: f.descriptor.vocabulary.fingerprint,
      admission: 'bounded_queue', queue_wait_ms: 1000, rules: definition, contexts });
    const result = decodeSemanticStyleReply(reply, reply.ticket, f.descriptor, { vocabulary: f.descriptor.vocabulary.fingerprint,
      rules: fingerprintRules(definition), bindingSlots: definition.binding_slots }, contexts.length, 64 << 20);
    assert.equal(result.indices.length, contexts.length);
    assert.equal(Object.hasOwn(reply.body, 'palette'), false);
    const beforeOldVersion = f.transport.stats();
    await assert.rejects(f.transport.request({ v: 3, ticket: 'old-v3-source', instance: f.descriptor.instance, op: 'highlight',
      admission: 'bounded_queue', queue_wait_ms: 1000, sources: [{ key: 'old', generation: 1, source_version: 1, hint: { language: 'bash' }, text: 'echo old' }] }),
    /stdio invalid request header/);
    assert.deepEqual(f.transport.stats(), beforeOldVersion, 'the TypeScript adapter rejects v3 before native dispatch');
    const rejected = await f.call({ op: 'stream.open', instance: f.descriptor.instance, admission: 'bounded_queue', queue_wait_ms: 1000,
      sources: [{ key: 'first', generation: 1, source_version: 1, text: 'echo x' }, { key: 'second', generation: 0, source_version: 1, text: 'echo y' }] });
    assert.equal(rejected.status, 'error'); assert.equal(rejected.error.execution, 'not_started'); assert.equal(Object.hasOwn(rejected, 'body'), false);
    assert.equal((await f.call({ op: 'describe' })).body.runtime.leases, 0);
    const large = await f.source('x'.repeat(8193)); assert.equal(large.source_bytes, 8193); assert.equal(large.counters.tail_bytes, 8193);
  } finally { await f.close(); }
});

test('actual current helper commits a no-newline tail on one-shot and empty final append without reparsing it', async () => {
  const f = await fixture();
  try {
    const text = 'echo é\nprintf x', bytes = Buffer.byteLength(text), first = await f.source(text, 'bash', false);
    assert.equal(first.committed_bytes, Buffer.byteLength('echo é\n'));
    const final = f.decode(await f.append(first, '', true), text, 2, first);
    assert.equal(final.committed_bytes, bytes); assert.equal(final.lease, first.lease); assert.equal(final.counters.committed_line_calls, 0); assert.equal(final.counters.tail_calls, 0);
    const shot = await f.source(text); assert.equal(shot.committed_bytes, bytes); assert.equal(shot.lease, undefined);
    assert.deepEqual(spans(shot), patched(spans(first), final));
  } finally { await f.close(); }
});

test('actual owned helper refuses growth past cumulative coverage and still finalizes its at-limit tail without reparsing', async () => {
  const f = await fixture();
  try {
    assert.equal(f.descriptor.limits.line_bytes, 65536);
    const text = '/*' + 'a'.repeat(HIGHLIGHT_LIMITS.sourceBytes - 2), prior = await f.source(text, 'typescript', false);
    assert.equal(prior.source_bytes, HIGHLIGHT_LIMITS.sourceBytes);
    assert.equal(prior.counters.tail_calls, 1);
    assert.equal(prior.counters.tail_bytes, Math.min(HIGHLIGHT_LIMITS.sourceBytes, f.descriptor.limits.line_bytes));
    assert.ok(prior.lease);
    const sampledLeases: number[] = [];
    for (const delta of ['*/', '\nconst later = 1;\n']) {
      const rejected = await f.append(prior, delta, false);
      assert.equal(rejected.status, 'error'); assert.deepEqual(rejected.error, { code: 'source_limit', execution: 'not_started' });
      assert.equal(Object.hasOwn(rejected, 'body'), false);
      // describe reads an asynchronously sampled actor counter. The final append
      // below, using the unchanged lease/revision, is the actual survival proof.
      sampledLeases.push((await f.call({ op: 'describe' })).body.runtime.leases);
    }
    const final = f.decode(await f.append(prior, '', true), text, 2, prior);
    assert.equal(final.source_bytes, HIGHLIGHT_LIMITS.sourceBytes);
    assert.equal(final.committed_bytes, HIGHLIGHT_LIMITS.sourceBytes);
    assert.equal(final.counters.tail_calls, 0); assert.equal(final.counters.tail_bytes, 0);
    assert.equal(final.counters.committed_line_calls, 0); assert.equal(final.counters.committed_line_bytes, 0);
    assert.equal(final.lease, prior.lease, 'both no-start refusals preserve the exact parser lease and revision');
    console.log(JSON.stringify({ boundaryRefusal: { sampledLeases, sameLeaseFinalized: final.lease === prior.lease,
      finalTailCalls: final.counters.tail_calls, finalCommittedCalls: final.counters.committed_line_calls } }));
    assert.deepEqual(spans(await f.source(text, 'typescript')), patched(spans(prior), final));
    assert.equal((await f.call({ op: 'describe' })).body.runtime.leases, 0); assert.equal(f.transport.stats().spawnCount, 1);
  } finally { await f.close(); }
});

test('actual owned helper advertises bounded DATA and refuses byte or line overflow without losing later boundary admission', async () => {
  const f = await fixture();
  try {
    assert.equal(f.descriptor.limits.source_bytes, HIGHLIGHT_LIMITS.sourceBytes);
    assert.equal(f.descriptor.limits.request_bytes, HIGHLIGHT_LIMITS.dataWireBytes);
    assert.equal(f.descriptor.limits.reply_bytes, HIGHLIGHT_LIMITS.dataWireBytes);
    for (const text of ['a'.repeat(HIGHLIGHT_LIMITS.sourceBytes + 1), '\n'.repeat(HIGHLIGHT_LIMITS.sourceLines + 1)]) {
      const rejected = await f.call({ op: 'stream.open', instance: f.descriptor.instance, admission: 'bounded_queue', queue_wait_ms: 1000,
        sources: [{ key: 'code', generation: 1, source_version: 1, hint: { language: 'text' }, text }] });
      assert.equal(rejected.status, 'error'); assert.deepEqual(rejected.error, { code: 'source_limit', execution: 'not_started' });
      assert.equal(Object.hasOwn(rejected, 'body'), false);
      assert.equal((await f.call({ op: 'describe' })).body.runtime.leases, 0, 'refused text must not acquire a lease');
    }
    for (const text of ['a'.repeat(HIGHLIGHT_LIMITS.sourceBytes), '\n'.repeat(HIGHLIGHT_LIMITS.sourceLines)]) {
      const accepted = await f.source(text, 'text');
      assert.equal(accepted.source_bytes, Buffer.byteLength(text)); assert.equal(accepted.committed_bytes, Buffer.byteLength(text));
      assert.equal(accepted.runs.at(-2), Buffer.byteLength(text)); assert.equal(accepted.lease, undefined);
    }
    assert.equal((await f.call({ op: 'describe' })).body.runtime.leases, 0); assert.equal(f.transport.stats().spawnCount, 1);
  } finally { await f.close(); }
});
