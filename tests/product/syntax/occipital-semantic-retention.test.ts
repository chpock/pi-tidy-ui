import '../../fixtures/test-guard.mjs';
import { installProjection, visitProjection, projectionRanges } from '../../fixtures/pi-projection.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64), grant = () => true;
function chunk(key: string, generation: number, text: string, options: Partial<SemanticChunk> = {}): SemanticChunk {
  const bytes = Buffer.byteLength(text), from = options.replace_from ?? 0, complete = options.complete ?? false;
  return { vocabulary, key, generation, source_version: 1, revision: 1, source_bytes: bytes, replace_from: from,
    committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
    ...(!complete ? { lease: 'lease' } : {}), contexts: [Uint32Array.of(1)],
    runs: bytes > from ? Uint32Array.of(bytes, 1) : new Uint32Array(),
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 }, ...options };
}
const data = () => new SemanticRetentionPool();

test('semantic retention: source strings, semantic ranges and shared styles use one root byte account', () => {
  const pool = data(), first = pool.admit('a', 1, 'abc').generation!, second = pool.admit('b', 1, 'abc').generation!;
  assert.equal(pool.installChunk(first, chunk('a', first, 'abc')).accepted, true);
  assert.equal(pool.installChunk(second, chunk('b', second, 'abc')).accepted, true);
  const refs: Parameters<typeof pool.arena.retain>[0][number][] = [];
  pool.visitRanges(first, (_from, _to, ref) => { if (ref) refs.push(ref); });
  const before = pool.stats();
  assert.equal(before.contexts, 1);
  assert.equal(pool.arena.installStyles(vocabulary, rules, refs, [{ foreground: { kind: 'rgb', r: 1, g: 2, b: 3 },
    background: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 31 }], Uint32Array.of(1), bytes => pool.reserve(first, bytes).accepted), true);
  assert.equal(pool.stats().retainedBytes - before.retainedBytes, pool.stats().styleBytes);
  pool.remove(first);
  assert.equal(pool.stats().contexts, 1);
  assert.equal(pool.stats().styles, 1);
  pool.remove(second);
  assert.equal(pool.stats().retainedBytes, 0);
});

test('semantic retention: an intermediate dispatched capture becomes the basis without losing the newer target', () => {
  const pool = data(), generation = pool.admit('a', 1, 'a').generation!;
  pool.replaceSnapshot(generation, 3, 'abc');
  const result = chunk('a', generation, 'ab', { source_version: 2 });
  assert.equal(pool.installChunk(generation, result, { version: 2, text: 'ab' }).accepted, true);
  assert.equal(pool.borrowSnapshot(generation, 'basis')!.text, 'ab');
  assert.equal(pool.borrowSnapshot(generation)!.text, 'abc');
  const before = pool.stats();
  assert.equal(pool.installChunk(generation, chunk('a', generation, 'wrong', { source_version: 2, revision: 2 }), { version: 2, text: 'wrong' }).accepted, false);
  assert.deepEqual(pool.stats(), before);
  pool.clear();
});

test('semantic retention: append installs only a replacement suffix and finalization preserves identical display coverage', () => {
  const pool = data(), generation = pool.admit('a', 1, 'a\nb').generation!;
  pool.installChunk(generation, chunk('a', generation, 'a\nb'));
  const words = pool.stats().allocatedWordBytes;
  pool.replaceSnapshot(generation, 2, 'a\nbc');
  pool.installChunk(generation, chunk('a', generation, 'a\nbc', { source_version: 2, revision: 2, replace_from: 2 }));
  assert.equal(pool.stats().allocatedWordBytes, words);
  assert.equal(pool.stats().prefixCopiedBytes, 0);
  const before = pool.status(generation)!;
  pool.installChunk(generation, chunk('a', generation, 'a\nbc', { source_version: 2, revision: 3, replace_from: 2, complete: true, lease: 'lease' }));
  assert.equal(pool.status(generation)!.displayRevision, before.displayRevision);
  assert.equal(pool.status(generation)!.complete, true);
  pool.clear();
  assert.equal(pool.stats().retainedBytes, 0);
});

test('semantic retention: explicit parser restart replaces coverage atomically without changing source incarnation', () => {
  const pool = data(), generation = pool.admit('a', 1, 'abc').generation!;
  pool.installChunk(generation, chunk('a', generation, 'abc', { complete: true }));
  const replacement = chunk('a', generation, 'abc', { lease: 'new-lease', contexts: [Uint32Array.of(2)] });
  assert.equal(pool.installChunk(generation, replacement).accepted, false);
  assert.equal(pool.installChunk(generation, replacement, undefined, true).accepted, true);
  assert.equal(pool.status(generation)!.generation, generation);
  const encoded: number[][][] = [];
  pool.visitRanges(generation, (_start, _end, ref) => { if (ref) encoded.push(pool.arena.encode(vocabulary, [ref], grant)!); });
  assert.deepEqual(encoded, [[[0, 2]]]);
  pool.clear();
});

test('semantic retention: root pressure evicts actual oldest records and includes pending-job descriptors', () => {
  // Eight fully retained sources must fit before this test can exercise read-touch LRU.
  const pool = new SemanticRetentionPool({ maxBytes: 26000 }), generations: number[] = [];
  for (let i = 0; i < 8; i++) {
    const key = `s${i}`, admitted = pool.admit(key, 1, 'abc');
    assert.equal(admitted.accepted, true);
    const generation = admitted.generation!;
    assert.equal(pool.installChunk(generation, chunk(key, generation, 'abc', { complete: true })).accepted, true);
    generations.push(generation);
  }
  for (const generation of generations) assert.ok(pool.status(generation), 'all eight sources remain before read-touch');
  const preload = pool.stats();
  pool.status(generations[0]!);
  const admission = pool.admit('large', 1, 'x'.repeat(6000));
  assert.equal(admission.accepted, true);
  assert.ok(admission.released.length > 0, 'the larger fixture still requires actual pressure');
  assert.equal(admission.released[0]!.key, 's1', 'reading s0 made it useful, without changing source identity');
  assert.ok(pool.stats().retainedBytes <= pool.stats().maxBytes);
  const refs: Parameters<typeof pool.arena.retain>[0][number][] = [];
  pool.visitRanges(generations[0]!, (_from, _to, ref) => { if (ref) refs.push(ref); });
  assert.ok(refs.length > 0, 'the pending job pins actual descriptors');
  const pin = pool.arena.retain(refs, bytes => pool.reserve(generations[0]!, bytes).accepted)!;
  pool.clear();
  assert.ok(pool.stats().retainedBytes > 0, 'an unresolved style job still owns descriptors');
  assert.equal(pool.stats().entries, 0);
  pin.release();
  assert.equal(pool.stats().retainedBytes, 0);
  console.log(JSON.stringify({ rootPressureIndexFixture: { preloadBytes: preload.retainedBytes, indexBytes: preload.contextIndexBytes,
    sameSourcesWithoutIndexCharge: preload.retainedBytes - preload.contextIndexBytes, released: admission.released.map(receipt => receipt.key), finalBytes: pool.stats().retainedBytes } }));
});

test('semantic retention: an impossible reservation or stale suffix cannot destroy the protected basis', () => {
  const pool = new SemanticRetentionPool({ maxBytes: 4000 }), generation = pool.admit('a', 1, 'abc').generation!;
  pool.installChunk(generation, chunk('a', generation, 'abc'));
  const before = pool.stats();
  assert.equal(pool.reserve(generation, 4001).accepted, false);
  assert.equal(pool.replaceSnapshot(generation, 2, 'x'.repeat(3000)).accepted, false);
  assert.equal(pool.borrowSnapshot(generation)!.text, 'abc');
  assert.deepEqual(pool.stats(), before);
  assert.equal(pool.installChunk(generation, chunk('a', generation, 'abc', { revision: 3 })).accepted, false);
  assert.deepEqual(pool.stats(), before);
  pool.clear();
});

test('semantic retention: finite Pi bridge is exact-text data and is not current-parser evidence', () => {
  const pool = data(), generation = pool.admit('a', 1, 'abc').generation!, rows = ['\x1b[31mabc\x1b[39m'];
  assert.equal(installProjection(pool, generation, 1, 'abc', rows).accepted, true);
  rows[0] = 'changed';
  assert.deepEqual(projectionRanges(pool, generation), [[0, 3, 0]]);
  const styles: unknown[] = []; pool.visitPiStyles(generation, pool.piProjectionStatus(generation)!.revision, (_index, style) => styles.push(style.foreground));
  assert.deepEqual(styles, [{ kind: 'indexed', index: 1 }]);
  assert.equal(pool.status(generation)!.revision, 0);
  assert.equal(pool.bridgeVersion(generation), 1);
  assert.equal(installProjection(pool, generation, 1, 'different', ['different']).accepted, false);
  pool.clear();
  assert.equal(pool.stats().retainedBytes, 0);
});

test('semantic retention: clear never rewinds generations and disposal cannot revive old data', () => {
  const pool = new SemanticRetentionPool({ maxGeneration: 2 });
  const first = pool.admit('a', 1, 'abc').generation!;
  pool.clear();
  const second = pool.admit('a', 1, 'abc').generation!;
  assert.ok(second > first);
  assert.equal(pool.installChunk(first, chunk('a', first, 'abc')).accepted, false);
  pool.clear();
  assert.equal(pool.admit('a', 1, 'abc').accepted, false);
  pool.dispose(); pool.dispose();
  assert.equal(pool.admit('a', 1, 'abc').accepted, false);
  assert.equal(pool.stats().retainedBytes, 0);
});

test('semantic retention: UTF8 snapshot memoization handles scalar boundaries, corrections and empty sources', () => {
  const pool = data(), generation = pool.admit('a', 0, 'é\ud83d').generation!;
  assert.equal(pool.borrowSnapshot(generation)!.utf8Bytes, Buffer.byteLength('é\ud83d'));
  pool.replaceSnapshot(generation, 1, 'é😀');
  assert.equal(pool.borrowSnapshot(generation)!.utf8Bytes, 6);
  pool.replaceSnapshot(generation, 2, '界');
  assert.equal(pool.borrowSnapshot(generation)!.utf8Bytes, 3);
  assert.equal(pool.replaceSnapshot(generation, 2, 'different').accepted, false);
  const empty = pool.admit('empty', 0, '').generation!;
  assert.equal(pool.installChunk(empty, chunk('empty', empty, '', { source_version: 0, complete: true, contexts: [] })).accepted, true);
  assert.equal(pool.status(empty)!.complete, true);
  assert.equal(pool.status(empty)!.sourceBytes, 0);
  pool.clear();
});

function adopted(pool: SemanticRetentionPool) {
  const generation = pool.admit('a', 1, 'abc').generation!, raw = chunk('a', generation, 'abc');
  pool.installChunk(generation, raw);
  return { generation, raw: new WeakRef(raw), contexts: new WeakRef(raw.contexts), runs: new WeakRef(raw.runs) };
}
function disposedPool() {
  const released = data(); released.admit('old', 1, 'old'); released.dispose();
  return new WeakRef(released);
}
test('semantic retention: live data does not retain decoded replies; disposed pools are collectible while a peer is active', async () => {
  assert.equal(typeof global.gc, 'function');
  const pool = data(), first = adopted(pool), peer = data(), peerGeneration = peer.admit('peer', 1, 'x').generation!;
  for (let i = 0; i < 30; i++) {
    await turn(); global.gc!(); await turn();
    if (!first.raw.deref() && !first.contexts.deref() && !first.runs.deref()) break;
  }
  assert.equal(first.raw.deref(), undefined);
  assert.equal(first.contexts.deref(), undefined);
  assert.equal(first.runs.deref(), undefined);
  assert.equal(pool.status(first.generation)!.sourceBytes, 3);
  const old = disposedPool();
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!old.deref()) break; }
  assert.equal(old.deref(), undefined);
  assert.equal(peer.borrowSnapshot(peerGeneration)!.text, 'x');
  pool.dispose(); peer.dispose();
});

test('semantic retention: callbacks cannot keep visiting removed source data or alias a later incarnation', () => {
  const pool = data(), generation = pool.admit('a', 1, 'a\nb').generation!;
  pool.installChunk(generation, chunk('a', generation, 'a\nb'));
  let calls = 0;
  pool.visitRanges(generation, () => { calls++; pool.remove(generation); });
  assert.equal(calls, 1);
  assert.equal(pool.stats().retainedBytes, 0);
  const next = pool.admit('a', 1, 'new').generation!;
  assert.notEqual(next, generation);
  assert.equal(pool.visitRanges(generation, () => assert.fail('removed source revived')), false);
  installProjection(pool, next, 1, 'new', ['n\x1b[31me\x1b[32mw']);
  visitProjection(pool, next, () => pool.remove(next));
  assert.equal(pool.stats().retainedBytes, 0);
});
