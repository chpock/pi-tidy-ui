import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena } from '../../../src/occipital/context-arena.ts';
import { decodeContextBatch, SemanticError } from '../../../src/occipital/semantic-codec.ts';

const vocabulary = 'a'.repeat(64), grant = () => true;
const decode = (rows: number[][][]) => decodeContextBatch(rows, { vocabularySize: 65536, maxBytes: 64 << 20 }).batches;

test('context arena: equivalent ordered contexts share handles across replies, but parsed-empty is not neutral zero', () => {
  const arena = new ContextArena();
  const first = arena.adopt(vocabulary, decode([[[0], [0, 2], [1, 3], [2, 3]]]), grant)!;
  const second = arena.adopt(vocabulary, decode([[[0, 2, 3], [0], [0, 2, 3, 3]]]), grant)!;
  assert.equal(first.batches[0]![2], second.batches[0]![0]);
  assert.equal(first.batches[0]![0], second.batches[0]![1]);
  assert.notEqual(first.batches[0]![2], first.batches[0]![3]);
  assert.ok(first.batches[0]!.every(ref => ref.id > 0));
  assert.equal(arena.stats().contexts, 4);
  assert.equal(arena.stats().words, 6);
  first.release();
  assert.equal(arena.stats().contexts, 3);
  second.release(); second.release();
  assert.equal(arena.stats().retainedBytes, 0);
});

test('context arena: denied whole-batch growth is atomic and precedes copying owned word vectors', () => {
  const arena = new ContextArena(), first = arena.adopt(vocabulary, decode([[[0, 1]]]), grant)!;
  const before = arena.stats();
  let requested = 0;
  assert.equal(arena.adopt(vocabulary, decode([[[0, 2]], [[0, 3]]]), bytes => { requested = bytes; return false; }), undefined);
  assert.ok(requested > 0);
  assert.deepEqual(arena.stats(), before);
  first.release();
});

test('context arena: equivalent replies own their copies and old handles cannot alias a replacement or another vocabulary', () => {
  const arena = new ContextArena(), raw = decode([[[0, 1, 2]]]);
  const first = arena.adopt(vocabulary, raw, grant)!, old = first.batches[0]![0]!;
  raw[0]![0]!.fill(7);
  assert.deepEqual(arena.encode(vocabulary, [old], grant), [[0, 1, 2]]);
  first.release();
  const current = arena.adopt(vocabulary, decode([[[0, 1, 2]]]), grant)!;
  assert.notEqual(current.batches[0]![0]!.id, old.id);
  assert.throws(() => arena.retain([old], grant), SemanticError);
  assert.throws(() => arena.retain([{ id: current.batches[0]![0]!.id }], grant), SemanticError);
  const different = arena.adopt('b'.repeat(64), decode([[[0, 1, 2]]]), grant)!;
  assert.notEqual(different.batches[0]![0], current.batches[0]![0]);
  assert.throws(() => arena.encode(vocabulary, different.batches[0]!, () => assert.fail('wrong authority must fail before reserve')), /identity_mismatch/);
  different.release();
  const other = new ContextArena(), otherLease = other.adopt(vocabulary, decode([[[0, 1, 2]]]), grant)!;
  assert.throws(() => other.encode(vocabulary, [current.batches[0]![0]!], grant), SemanticError);
  current.release(); otherLease.release();
});

test('context arena: a palette job retains descriptors independently of the removed source and can encode them after provider reset', () => {
  const arena = new ContextArena();
  const source = arena.adopt(vocabulary, decode([[[0, 1, 2], [1, 3]]]), grant)!;
  const job = arena.retain(source.batches[0]!, grant)!;
  source.release();
  const before = arena.stats();
  assert.equal(arena.encode(vocabulary, job.batches[0]!, () => false), undefined);
  assert.deepEqual(arena.stats(), before);
  assert.deepEqual(arena.encode(vocabulary, job.batches[0]!, grant), [[0, 1, 2], [1, 3]]);
  job.release();
  assert.equal(arena.stats().retainedBytes, 0);
});

test('context arena: sharing has no small entry cap and release never leaves sparse slots or retained words', () => {
  const arena = new ContextArena();
  const rows = Array.from({ length: 4096 }, (_, i) => [0, i + 1]);
  const wave = arena.adopt(vocabulary, decode([rows]), grant)!;
  assert.equal(arena.stats().contexts, rows.length);
  wave.release();
  for (let i = 0; i < 2000; i++) {
    const lease = arena.adopt(vocabulary, decode([[[0, 1]]]), grant)!;
    lease.release();
  }
  assert.equal(arena.stats().contexts, 0);
  assert.equal(arena.stats().words, 0);
  assert.equal(arena.stats().retainedBytes, 0);
});

test('context arena: disposal invalidates outstanding handles but preserves live lease charges until release', () => {
  const arena = new ContextArena(), source = arena.adopt(vocabulary, decode([[[0, 1]]]), grant)!;
  const before = arena.stats().retainedBytes;
  arena.dispose();
  assert.equal(arena.stats().retainedBytes, before); assert.equal(arena.budget.stats().retainedBytes, before);
  assert.throws(() => arena.encode(vocabulary, source.batches[0]!, grant), SemanticError);
  source.release();
  assert.equal(arena.stats().retainedBytes, 0); assert.equal(arena.budget.stats().retainedBytes, 0);
  assert.throws(() => arena.adopt(vocabulary, decode([[[0, 1]]]), grant), SemanticError);
});

function transient(arena: ContextArena) {
  const input = decode([[[0, 1, 2], [2, 3]]]);
  return { input: new WeakRef(input), lease: arena.adopt(vocabulary, input, grant)! };
}
test('context arena: active ownership does not retain decoded replies, and releasing it leaves a peer usable', async () => {
  assert.equal(typeof global.gc, 'function', 'the prepared runner must expose GC');
  const arena = new ContextArena(), first = transient(arena);
  const peer = arena.adopt(vocabulary, decode([[[0, 7]]]), grant)!;
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!first.input.deref()) break; }
  assert.equal(first.input.deref(), undefined);
  first.lease.release();
  assert.equal(arena.stats().contexts, 1);
  assert.deepEqual(arena.encode(vocabulary, peer.batches[0]!, grant), [[0, 7]]);
  peer.release();
  assert.equal(arena.stats().retainedBytes, 0);
});

function releasedOwner() {
  const arena = new ContextArena(), lease = arena.adopt(vocabulary, decode([[[0, 1]]]), grant)!;
  lease.release();
  return { owner: new WeakRef(arena), lease };
}
test('context arena: a retained released lease cannot keep its former owner alive while a peer is active', async () => {
  assert.equal(typeof global.gc, 'function');
  const first = releasedOwner(), peer = new ContextArena();
  const lease = peer.adopt(vocabulary, decode([[[0, 2]]]), grant)!;
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!first.owner.deref()) break; }
  assert.equal(first.owner.deref(), undefined);
  first.lease.release();
  assert.deepEqual(peer.encode(vocabulary, lease.batches[0]!, grant), [[0, 2]]);
  lease.release();
});

test('context arena: repeated replies and job pins share owned word storage and release only their own references', () => {
  const arena = new ContextArena(), input = decode([[[0, 1, 2], [2]]]);
  const first = arena.adopt(vocabulary, input, grant)!;
  const before = arena.stats();
  const duplicate = arena.adopt(vocabulary, input, grant)!, pin = arena.retain(first.batches[0]!, grant)!;
  assert.equal(arena.stats().allocatedWordBytes, before.allocatedWordBytes);
  assert.equal(arena.stats().contexts, 1);
  assert.ok(arena.stats().retainedBytes > before.retainedBytes, 'each owner has separately charged reference metadata');
  assert.equal(arena.retain(first.batches[0]!, () => false), undefined);
  first.release(); duplicate.release();
  assert.equal(arena.stats().contexts, 1);
  assert.deepEqual(arena.encode(vocabulary, pin.batches[0]!, grant), [[0, 1, 2], [2]]);
  pin.release();
  assert.equal(arena.stats().retainedBytes, 0);
});
