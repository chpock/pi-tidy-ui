import '../../fixtures/test-guard.mjs';
import { installProjection, visitProjection, projectionRanges } from '../../fixtures/pi-projection.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena, type ContextRef } from '../../../src/occipital/context-arena.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import { SemanticRetentionPool, type ReadyPresentation } from '../../../src/occipital/semantic-retention.ts';
import { decodeSemanticSources, type SemanticExpectation } from '../../../src/occipital/semantic-source.ts';
import { CARD_ROLES, decodeStyleResult, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';

const A = 'a'.repeat(64), B = 'd'.repeat(64), rules = 'b'.repeat(64), grant = () => true;
const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/vectors.json', import.meta.url), 'utf8'));
const literalFixture = vectors.styles.find((value: { name: string }) => value.name === 'literal-binding-inherit-and-explicit-clear');
const decoded = decodeStyleResult(literalFixture.body, { vocabulary: A, rules, bindingSlots: literalFixture.binding_slots }, 4, 1 << 20);
const base: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const literal = materializeStyle(decoded.styles[0]!, [], base);
const indexedFixture = vectors.styles.find((value: { name: string }) => value.name === 'indexed-is-not-guessed-rgb');
const indexed = decodeStyleResult(indexedFixture.body, { vocabulary: A, rules, bindingSlots: indexedFixture.binding_slots }, 1, 1 << 20);
const recolored = materializeStyle(indexed.styles[0]!, [], base);
function source(vocabulary: string, key = 'source', generation = 1, options: Partial<SemanticExpectation> & { neutral?: boolean; parsedEmpty?: boolean } = {}) {
  const { neutral = false, parsedEmpty = false, ...metadata } = options;
  const expected = { key, generation, source_version: 1, revision: 1, source_bytes: 1, replace_from: 0, complete: false,
    lease: 'lease', replacementText: 'x', ...metadata };
  const { replacementText, ...wire } = expected;
  const bytes = expected.source_bytes - expected.replace_from;
  return decodeSemanticSources({ kind: 'source', vocabulary, sources: [{ ...wire,
    committed_bytes: expected.complete ? expected.source_bytes : expected.replace_from + Buffer.from(replacementText).lastIndexOf(10) + 1,
    contexts: neutral || !bytes ? [] : [parsedEmpty ? [0] : vectors.contexts[0].encoded[1]], runs: bytes ? [bytes, neutral ? 0 : 1] : [],
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }] },
  { vocabulary, vocabularySize: vectors.vocabulary_size, sourceBytes: 1 << 20, runs: 1000, batchSources: 8 }, [expected], 64 << 20).sources[0]!;
}
function refs(pool: SemanticRetentionPool, generation: number) {
  const result = new Set<ContextRef>(); pool.visitRanges(generation, (_a, _b, ref) => { if (ref) result.add(ref); }); return [...result];
}
function ready(vocabulary: string, contexts: readonly ContextRef[], style = literal): ReadyPresentation {
  return { vocabulary, rules, palette: 'palette:test', bindingRevision: 1,
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, structuredClone(style)])) as Record<CardRole, ConcreteStyle>,
    contexts: contexts.map(context => ({ context, style: structuredClone(style) })) };
}
function publish(pool: SemanticRetentionPool, generation: number, vocabulary: string) {
  const status = pool.status(generation)!;
  return pool.publishDisplay(generation, { sourceVersion: status.sourceVersion!, semanticStamp: status.semanticStamp, presentation: ready(vocabulary, refs(pool, generation)) });
}

test('vocabulary epochs: decoded provenance and unbound before-discovery text/bridge survive first native adoption', () => {
  const chunk = source(A); assert.equal(chunk.vocabulary, A);
  const pool = new SemanticRetentionPool(), generation = pool.admit('source', 1, 'x').generation!;
  assert.equal(pool.status(generation)!.vocabulary, undefined);
  assert.equal(installProjection(pool, generation, 1, 'x', ['\x1b[31mx']).accepted, true);
  assert.equal(pool.installChunk(generation, source(A, 'source', generation)).accepted, true);
  assert.equal(pool.status(generation)!.vocabulary, A); assert.equal(pool.bridgeVersion(generation), 1);
  assert.deepEqual(projectionRanges(pool, generation), [[0, 1, 0]]);
  assert.equal(publish(pool, generation, A).accepted, true); assert.equal(pool.displayStatus(generation)!.vocabulary, A);
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('vocabulary epochs: identical ordered paths have distinct namespace handles/styles, while compatible reuse stays shared', () => {
  const arena = new ContextArena(), a = arena.adopt(A, [[Uint32Array.of(2, 3)]], grant)!, b = arena.adopt(B, [[Uint32Array.of(2, 3)]], grant)!;
  const ar = a.batches[0]![0]!, br = b.batches[0]![0]!;
  assert.notEqual(ar, br); assert.notEqual(ar.id, br.id);
  const styleA = decoded.styles[0]!, styleB = { ...styleA, foreground: { kind: 'indexed' as const, index: 255 } };
  arena.installStyles(A, rules, [ar], [styleA], Uint32Array.of(1), grant);
  arena.installStyles(B, rules, [br], [styleB], Uint32Array.of(1), grant);
  assert.deepEqual(arena.style(A, ar, rules), styleA); assert.deepEqual(arena.style(B, br, rules), styleB);
  const before = arena.stats(), again = arena.adopt(A, [[Uint32Array.of(2, 3)]], grant)!;
  assert.equal(again.batches[0]![0], ar); assert.equal(arena.stats().allocatedWordBytes, before.allocatedWordBytes);
  assert.equal(arena.installStyles(A, rules, again.batches[0]!, [styleA], Uint32Array.of(1), () => assert.fail('compatible cached style needs no grant')), true);
  assert.deepEqual(arena.encode(A, [ar], grant), [[0, 2, 3]]); assert.deepEqual(arena.encode(B, [br], grant), [[0, 2, 3]]);
  a.release(); b.release(); again.release(); assert.equal(arena.stats().retainedBytes, 0); assert.equal(arena.stats().keyBytes, 0);
});

test('vocabulary epochs: every wrong/foreign/stale or late mixed handle fails before grant/output writes/adoption', () => {
  const arena = new ContextArena(), foreign = new ContextArena();
  const a = arena.adopt(A, [[Uint32Array.of(2)]], grant)!, b = arena.adopt(B, [[Uint32Array.of(2)]], grant)!, other = foreign.adopt(A, [[Uint32Array.of(2)]], grant)!;
  const stale = arena.adopt(A, [[Uint32Array.of(3)]], grant)!, dead = stale.batches[0]![0]!; stale.release();
  const ar = a.batches[0]![0]!, br = b.batches[0]![0]!, outsider = other.batches[0]![0]!;
  arena.installStyles(A, rules, [ar], decoded.styles, Uint32Array.of(1), grant);
  for (const refs of [[br], [ar, br], [ar, outsider], [ar, dead]]) {
    const before = arena.stats(), indices = Uint32Array.from(refs, () => 1), original = globalThis.Map, push = Array.prototype.push;
    let grants = 0, maps = 0, outputWrites = 0, rejected = 0;
    globalThis.Map = new Proxy(original, { construct(target, args) { maps++; return Reflect.construct(target, args); } });
    Array.prototype.push = function<T>(...items: T[]): number { outputWrites++; return push.apply(this, items); };
    try {
      try { arena.encode(A, refs, () => { grants++; return true; }); } catch { rejected++; }
      try { arena.installStyles(A, rules, refs, decoded.styles, indices, () => { grants++; return true; }); } catch { rejected++; }
      try { arena.style(A, refs[refs.length - 1]!, rules); } catch { rejected++; }
    } finally { globalThis.Map = original; Array.prototype.push = push; }
    assert.equal(rejected, 3); assert.equal(grants, 0); assert.equal(maps, 0); assert.equal(outputWrites, 0); assert.deepEqual(arena.stats(), before);
  }
  console.log(JSON.stringify({ namespaceAuthority: { testedWrongMixedForeignStale: 4, grants: 0, outputWrites: 0, maps: 0 } }));
  a.release(); b.release(); other.release(); assert.equal(arena.stats().retainedBytes, 0);
});

test('vocabulary epochs: neutral, positive-empty and zero-context captured views carry namespace independent of handles', () => {
  const arena = new ContextArena(), empty = new SemanticRanges(arena), neutral = new SemanticRanges(arena), parsed = new SemanticRanges(arena);
  empty.apply(source(A, 'empty', 1, { source_bytes: 0, replacementText: '', complete: true }), grant);
  neutral.apply(source(B, 'neutral', 2, { neutral: true }), grant);
  parsed.apply(source(A, 'parsed', 3, { parsedEmpty: true }), grant);
  const a = empty.captureView(grant)!, b = neutral.captureView(grant)!;
  assert.equal(a.vocabulary, A); assert.equal(b.vocabulary, B); assert.equal(empty.stats().vocabulary, A);
  let neutralID: ContextRef | undefined; neutral.visit((_a, _b, ref) => { neutralID = ref; }); assert.equal(neutralID, undefined);
  parsed.visit((_a, _b, ref) => { assert.ok(ref); assert.ok(ref.id > 0); assert.deepEqual(arena.encode(A, [ref], grant), [[0]]); });
  const before = neutral.stats(); let grants = 0;
  assert.throws(() => neutral.apply(source(A, 'neutral', 2, { neutral: true, revision: 2, source_version: 2, source_bytes: 2, replacementText: 'xy' }), () => { grants++; return true; }));
  assert.equal(grants, 0); assert.deepEqual(neutral.stats(), before);
  empty.dispose(); neutral.dispose(); parsed.dispose(); assert.equal(arena.stats().retainedBytes, 0);
  assert.equal(SemanticRanges.ownershipStats(undefined, [a]).retainedBytes, 256 + 256 + 32 + 2 * A.length,
    'empty captured store owns its fingerprint in addition to store/view metadata');
  a.release(); b.release(); assert.equal(SemanticRanges.ownershipStats(undefined, [a, b]).retainedBytes, 0);
});

test('vocabulary epochs: restart to B preserves concrete A plus actual A job pin; only A may recolor retained A', () => {
  const pool = new SemanticRetentionPool(), generation = pool.admit('source', 1, 'x').generation!;
  pool.installChunk(generation, source(A, 'source', generation)); publish(pool, generation, A);
  const a = pool.displayStatus(generation)!, aRefs = refs(pool, generation), job = pool.arena.retain(aRefs, grant)!;
  pool.arena.installStyles(A, rules, aRefs, decoded.styles, Uint32Array.of(1), grant);
  pool.replaceSnapshot(generation, 2, 'xy');
  const append = source(B, 'source', generation, { revision: 2, source_version: 2, source_bytes: 2, replacementText: 'xy' });
  assert.equal(pool.installChunk(generation, append).accepted, false);
  assert.equal(pool.status(generation)!.vocabulary, A);
  assert.equal(pool.installChunk(generation, source(B, 'source', generation, { source_version: 2, source_bytes: 2, replacementText: 'xy', lease: 'new' }), undefined, true).accepted, true);
  assert.equal(pool.status(generation)!.vocabulary, B); assert.equal(pool.displayStatus(generation)!.vocabulary, A);
  assert.equal(pool.borrowDisplay(generation, a.effectStamp)!.text, 'x');
  const wrong = { sourceVersion: a.sourceVersion, semanticStamp: a.semanticStamp, presentation: ready(B, aRefs) };
  assert.equal(pool.publishDisplay(generation, wrong).accepted, false);
  assert.equal(pool.publishDisplay(generation, { ...wrong, presentation: { ...ready(A, aRefs, recolored), rules: 'e'.repeat(64), palette: 'f'.repeat(64) } }).accepted, true);
  assert.equal(pool.displayStatus(generation)!.geometryStamp, a.geometryStamp);
  assert.notEqual(pool.displayStatus(generation)!.effectStamp, a.effectStamp);
  pool.arena.clearStyles(); assert.deepEqual(pool.displayRole(generation, pool.displayStatus(generation)!.effectStamp, 'code'), recolored);
  pool.arena.installStyles(A, rules, job.batches[0]!, decoded.styles, Uint32Array.of(1), grant);
  assert.equal(publish(pool, generation, B).accepted, true);
  pool.remove(generation); assert.ok(pool.stats().retainedBytes > 0); assert.equal(pool.arena.stats().contexts, 1);
  assert.deepEqual(pool.arena.encode(A, job.batches[0]!, grant), [[0, 2]]);
  assert.throws(() => pool.arena.encode(B, job.batches[0]!, () => assert.fail('old pin cannot be sent to B')));
  const pinned = pool.stats().retainedBytes; job.release(); assert.equal(pool.stats().retainedBytes, 0);
  console.log(JSON.stringify({ namespaceHandoff: { current: B, retained: A, pinnedAfterSourceRemoval: pinned, finalBytes: pool.stats().retainedBytes } }));
});

test('vocabulary epochs: atomic group refuses mixed namespaces even without positive contexts', () => {
  const pool = new SemanticRetentionPool(), generations = [pool.admit('a', 1, 'x').generation!, pool.admit('b', 1, 'x').generation!];
  const updates = generations.map((generation, index) => {
    const vocabulary = index ? B : A; pool.installChunk(generation, source(vocabulary, index ? 'b' : 'a', generation, { neutral: true }));
    publish(pool, generation, vocabulary); const status = pool.status(generation)!;
    return { generation, candidate: { sourceVersion: status.sourceVersion!, semanticStamp: status.semanticStamp, presentation: ready(vocabulary, []) } };
  });
  const before = generations.map(generation => pool.displayStatus(generation));
  assert.equal(pool.publishDisplays(updates).accepted, false); assert.deepEqual(generations.map(generation => pool.displayStatus(generation)), before);
  assert.equal(pool.arena.stats().contexts, 0); assert.equal(pool.stats().rangeStores, 2);
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

function retired(arena: ContextArena) {
  const ranges = new SemanticRanges(arena); ranges.apply(source(A), grant);
  const view = ranges.captureView(grant)!, refs: ContextRef[] = []; view.visit((_a, _b, ref) => { if (ref) refs.push(ref); });
  const pin = arena.retain(refs, grant)!, owner = new WeakRef(ranges); ranges.dispose(); return { view, pin, owner };
}
test('vocabulary epochs: first retired owner collects with A view/pin and active B peer; final actual holders free keys', async () => {
  const arena = new ContextArena(), first = retired(arena), peer = new SemanticRanges(arena); peer.apply(source(B, 'peer', 2), grant);
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!first.owner.deref()) break; }
  assert.equal(first.owner.deref(), undefined); assert.equal(first.view.vocabulary, A); assert.equal(peer.stats().vocabulary, B);
  peer.dispose(); assert.equal(arena.stats().contexts, 1);
  let visits = 0; first.view.visit(() => { visits++; }); assert.equal(visits, 1, 'A view survives B owner removal');
  first.view.release(); assert.equal(arena.stats().contexts, 1);
  assert.deepEqual(arena.encode(A, first.pin.batches[0]!, grant), [[0, 2]]);
  const keyBytes = arena.stats().keyBytes; assert.ok(keyBytes > 0);
  first.pin.release(); assert.equal(arena.stats().retainedBytes, 0); assert.equal(arena.stats().keyBytes, 0);
  console.log(JSON.stringify({ namespaceGC: { firstOwnerCollected: !first.owner.deref(), lastPinKeyBytes: keyBytes, finalBytes: arena.stats().retainedBytes } }));
});

test('vocabulary epochs: namespace/key adoption peak is additional, denial atomic, and final owners release every key byte', () => {
  const arena = new ContextArena(), first = arena.adopt(A, [[Uint32Array.of(2, 3)]], grant)!, before = arena.stats();
  const input = [[Uint32Array.of(2, 3)]], Original = globalThis.Uint32Array, OriginalMap = globalThis.Map;
  let allocations = 0, maps = 0, peak = 0;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  globalThis.Map = new Proxy(OriginalMap, { construct(target, args) { maps++; return Reflect.construct(target, args); } });
  try {
    assert.equal(arena.adopt(B, input, bytes => { peak = bytes; assert.deepEqual(arena.stats(), before); return false; }), undefined);
  } finally { globalThis.Uint32Array = Original; globalThis.Map = OriginalMap; }
  assert.equal(allocations, 0); assert.equal(maps, 0); assert.deepEqual(arena.stats(), before);
  const second = arena.adopt(B, input, grant)!, delta = arena.stats().retainedBytes - before.retainedBytes;
  assert.ok(peak >= delta); assert.ok(arena.stats().keyBytes > before.keyBytes);
  first.release(); assert.ok(arena.stats().keyBytes > 0); second.release(); assert.equal(arena.stats().keyBytes, 0); assert.equal(arena.stats().retainedBytes, 0);
  console.log(JSON.stringify({ namespaceFunding: { additionalPeak: peak, retainedDelta: delta, deniedWordAllocations: allocations, deniedMaps: maps, finalKeyBytes: arena.stats().keyBytes } }));
});
