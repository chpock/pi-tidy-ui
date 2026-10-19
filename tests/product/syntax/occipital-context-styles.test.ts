import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena } from '../../../src/occipital/context-arena.ts';
import type { StyleExpression } from '../../../src/occipital/semantic-codec.ts';

const vocabulary = 'a'.repeat(64), a = 'b'.repeat(64), b = 'c'.repeat(64), grant = () => true;
const ink = (red: number): StyleExpression => ({ foreground: { kind: 'rgb', r: red, g: 20, b: 30 },
  background: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 15 });
function source(arena: ContextArena, ...words: number[][]) {
  return arena.adopt(vocabulary, [words.map(path => Uint32Array.from(path))], grant)!;
}

test('context styles: one resolution serves equal live contexts across cards, definitions stay independent', () => {
  const arena = new ContextArena(), first = source(arena, [1], [1, 2]), second = source(arena, [1]);
  const refs = first.batches[0]!;
  assert.equal(arena.style(vocabulary, refs[0]!, a), undefined);
  assert.equal(arena.installStyles(vocabulary, a, refs, [ink(40)], new Uint32Array([1, 1]), grant), true);
  const before = arena.stats();
  assert.equal(arena.style(vocabulary, second.batches[0]![0]!, a), arena.style(vocabulary, refs[0]!, a));
  assert.equal(arena.style(vocabulary, refs[0]!, a), arena.style(vocabulary, refs[1]!, a), 'equal payload expressions share one immutable value');
  assert.equal(arena.installStyles(vocabulary, a, refs, [ink(40)], new Uint32Array([1, 1]), () => { assert.fail('warm hits need no admission'); }), true);
  assert.deepEqual(arena.stats(), before);
  assert.equal(arena.installStyles(vocabulary, b, refs, [ink(80)], new Uint32Array([1, 1]), grant), true);
  assert.deepEqual(arena.style(vocabulary, refs[0]!, a), ink(40));
  assert.deepEqual(arena.style(vocabulary, refs[0]!, b), ink(80));
  assert.equal(arena.stats().styles, 4);
  first.release();
  assert.equal(arena.stats().styles, 2);
  second.release();
  assert.equal(arena.stats().styles, 0);
  assert.equal(arena.stats().retainedBytes, 0);
});

test('context styles: denial, immutable-rule conflict and duplicate-context conflict cannot partly populate a batch', () => {
  const arena = new ContextArena(), lease = source(arena, [1], [2]), refs = lease.batches[0]!;
  assert.equal(arena.installStyles(vocabulary, a, refs, [ink(40)], new Uint32Array([1, 1]), () => false), false);
  assert.equal(arena.stats().styles, 0);
  arena.installStyles(vocabulary, a, [refs[1]!], [ink(40)], new Uint32Array([1]), grant);
  const before = arena.stats();
  assert.throws(() => arena.installStyles(vocabulary, a, refs, [ink(80)], new Uint32Array([1, 1]), grant), /identity_mismatch/);
  assert.equal(arena.style(vocabulary, refs[0]!, a), undefined);
  assert.deepEqual(arena.stats(), before);
  assert.throws(() => arena.installStyles(vocabulary, b, [refs[0]!, refs[0]!], [ink(40), ink(80)], new Uint32Array([1, 2]), grant), /identity_mismatch/);
  assert.equal(arena.style(vocabulary, refs[0]!, b), undefined);
  assert.deepEqual(arena.stats(), before);
  lease.release();
});

test('context styles: cached copies preserve binding inheritance, explicit faint clearing and native values', () => {
  const arena = new ContextArena(), lease = source(arena, [], [1]), refs = lease.batches[0]!;
  const expressions: StyleExpression[] = [
    { foreground: { kind: 'binding', slot: 2 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 8 },
    { foreground: { kind: 'indexed', index: 16 }, background: { kind: 'rgb', r: 20, g: 30, b: 40 }, attributes: 7, attribute_mask: 15 },
  ];
  const expected = structuredClone(expressions);
  arena.installStyles(vocabulary, a, refs, expressions, new Uint32Array([1, 2]), grant);
  Object.assign(expressions[0]!.foreground, { slot: 9 });
  Object.assign(expressions[1]!, { attributes: 0 });
  assert.deepEqual(arena.style(vocabulary, refs[0]!, a), expected[0]);
  assert.deepEqual(arena.style(vocabulary, refs[1]!, a), expected[1]);
  assert.ok(Object.isFrozen(arena.style(vocabulary, refs[0]!, a)));
  assert.ok(Object.isFrozen(arena.style(vocabulary, refs[0]!, a)!.foreground));
  lease.release();
});

test('context styles: pending jobs keep useful late results alive but removal frees them after real settlement', () => {
  const arena = new ContextArena(), card = source(arena, [1]), job = arena.retain(card.batches[0]!, grant)!;
  card.release();
  assert.equal(arena.installStyles(vocabulary, a, job.batches[0]!, [ink(40)], new Uint32Array([1]), grant), true);
  assert.equal(arena.stats().styles, 1);
  const ref = job.batches[0]![0]!;
  job.release();
  assert.equal(arena.stats().styles, 0);
  assert.equal(arena.stats().retainedBytes, 0);
  assert.throws(() => arena.style(vocabulary, ref, a));
  const replacement = source(arena, [1]);
  assert.equal(arena.style(vocabulary, replacement.batches[0]![0]!, a), undefined);
  replacement.release();
});

test('context styles: cache pressure can discard styles without retiring descriptors, parser coverage or peers', () => {
  const arena = new ContextArena(), lease = source(arena, [1], [2]), refs = lease.batches[0]!;
  const words = arena.stats();
  arena.installStyles(vocabulary, a, refs, [ink(40)], new Uint32Array([1, 1]), grant);
  arena.installStyles(vocabulary, b, refs, [ink(80)], new Uint32Array([1, 1]), grant);
  const all = arena.stats();
  arena.clearStyles(a);
  assert.equal(arena.style(vocabulary, refs[0]!, a), undefined);
  assert.deepEqual(arena.style(vocabulary, refs[0]!, b), ink(80));
  assert.equal(arena.stats().styles, 2);
  assert.ok(arena.stats().retainedBytes < all.retainedBytes);
  arena.clearStyles();
  assert.deepEqual(arena.stats(), words);
  assert.deepEqual(arena.encode(vocabulary, refs, grant), [[0, 1], [0, 2]]);
  lease.release();
});

function cachedInput(arena: ContextArena) {
  const expressions = [ink(40)], input = new WeakRef(expressions), value = new WeakRef(expressions[0]!);
  const lease = source(arena, [1]);
  arena.installStyles(vocabulary, a, lease.batches[0]!, expressions, new Uint32Array([1]), grant);
  return { input, value, lease };
}
test('context styles: an active cache does not retain decoded arrays or expression objects', async () => {
  assert.equal(typeof global.gc, 'function');
  const arena = new ContextArena(), first = cachedInput(arena), peer = source(arena, [2]);
  for (let i = 0; i < 30; i++) {
    await turn(); global.gc!(); await turn();
    if (!first.input.deref() && !first.value.deref()) break;
  }
  assert.equal(first.input.deref(), undefined);
  assert.equal(first.value.deref(), undefined);
  assert.deepEqual(arena.style(vocabulary, first.lease.batches[0]![0]!, a), ink(40));
  first.lease.release();
  assert.equal(arena.stats().styles, 0);
  assert.equal(arena.stats().contexts, 1);
  peer.release();
});

test('context styles: stale or foreign handles and disposal cannot alias live cached expressions', () => {
  const arena = new ContextArena(), other = new ContextArena();
  const first = source(arena, [1]), foreign = source(other, [1]);
  assert.throws(() => arena.installStyles(vocabulary, a, foreign.batches[0]!, [ink(40)], new Uint32Array([1]), grant));
  assert.equal(arena.stats().styles, 0);
  arena.installStyles(vocabulary, a, first.batches[0]!, [ink(40)], new Uint32Array([1]), grant);
  const descriptors = arena.stats().retainedBytes - arena.stats().styleBytes;
  arena.dispose();
  assert.equal(arena.stats().styles, 0);
  assert.equal(arena.stats().retainedBytes, descriptors); assert.equal(arena.budget.stats().retainedBytes, descriptors);
  assert.throws(() => arena.style(vocabulary, first.batches[0]![0]!, a));
  first.release(); foreign.release();
  assert.equal(arena.budget.stats().retainedBytes, 0); assert.equal(other.budget.stats().retainedBytes, 0);
});

test('context styles: cold admission remains funded if pressure clears previously cached hits', () => {
  const arena = new ContextArena(), lease = source(arena, [1], [2]), refs = lease.batches[0]!;
  arena.installStyles(vocabulary, a, [refs[0]!], [ink(40)], Uint32Array.of(1), grant);
  let requested = 0, afterCleanup = 0;
  assert.equal(arena.installStyles(vocabulary, a, refs, [ink(40)], Uint32Array.of(1, 1), bytes => {
    requested = bytes;
    arena.clearStyles(a);
    afterCleanup = arena.stats().retainedBytes;
    return true;
  }), true);
  assert.ok(requested >= arena.stats().retainedBytes - afterCleanup,
    `admission ${requested} cannot be smaller than its adopted storage ${arena.stats().retainedBytes - afterCleanup}`);
  assert.equal(arena.stats().styles, 2);
  lease.release();
  assert.equal(arena.stats().retainedBytes, 0);
});
