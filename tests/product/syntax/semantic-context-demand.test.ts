import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { ContextArena, type ContextRef } from '../../../src/occipital/context-arena.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import { SemanticRetentionPool, type ReadyPresentation } from '../../../src/occipital/semantic-retention.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { CARD_ROLES, decodeStyleResult, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
const vocabulary = 'a'.repeat(64), otherVocabulary = 'd'.repeat(64), rules = 'b'.repeat(64), grant = () => true;
const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/vectors.json', import.meta.url), 'utf8'));
const fixture = vectors.styles.find((v: { name: string }) => v.name === 'literal-binding-inherit-and-explicit-clear');
const decoded = decodeStyleResult(fixture.body, { vocabulary, rules, bindingSlots: fixture.binding_slots }, fixture.context_count, 1 << 20);
const base: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const literal = materializeStyle(decoded.styles[0]!, [], base);
function patch(revision: number, tail = 2, namespace = vocabulary): SemanticChunk {
  return { vocabulary: namespace, key: 'a', generation: 1, source_version: revision, revision, lease: 'lease',
    replace_from: (revision - 1) * 2, committed_bytes: revision * 2, source_bytes: revision * 2 + 1, complete: false,
    contexts: [new Uint32Array([1]), new Uint32Array([tail])], runs: new Uint32Array([revision * 2, 1, revision * 2 + 1, 2]),
    counters: { committed_line_calls: 1, committed_line_bytes: 2, tail_calls: 1, tail_bytes: 1 } };
}
function contexts(owner: { visitContexts(consume: (ref: ContextRef) => void): boolean }): ContextRef[] {
  const refs: ContextRef[] = []; assert.equal(owner.visitContexts(ref => refs.push(ref)), true); return refs;
}
function current(pool: SemanticRetentionPool, generation = 1) { return contexts({ visitContexts: consume => pool.visitContexts(generation, consume) }); }
function presentation(refs: readonly ContextRef[], revision = 1): ReadyPresentation {
  return { vocabulary, rules, palette: 'palette:test', bindingRevision: revision,
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, structuredClone(literal)])) as Record<CardRole, ConcreteStyle>,
    contexts: refs.map(context => ({ context, style: structuredClone(literal) })) };
}
function publish(pool: SemanticRetentionPool, revision = 1) {
  const status = pool.status(1)!;
  return pool.publishDisplay(1, { semanticStamp: status.semanticStamp, sourceVersion: status.sourceVersion!, presentation: presentation(current(pool), revision) });
}
function root() { const pool = new SemanticRetentionPool(); pool.admit('a', 1, 'x\nx'); pool.installChunk(1, patch(1)); return pool; }

test('context demand: duplicate prefix usage enumerates once; historical tail and independent pin are not current demand', () => {
  const arena = new ContextArena(), ranges = new SemanticRanges(arena);
  assert.equal(ranges.visitContexts(() => assert.fail('uninitialized')), false);
  ranges.apply(patch(1), grant); const old = contexts(ranges), view = ranges.captureView(grant)!, pin = arena.retain([old[1]!], grant)!;
  for (let i = 2; i <= 40; i++) ranges.apply(patch(i, 3), grant);
  const refs = contexts(ranges); assert.equal(refs.length, 2); assert.equal(refs[0], old[0]); assert.ok(!refs.includes(old[1]!));
  assert.equal(arena.stats().contexts, 3); assert.equal(ranges.stats().currentContexts, 2);
  const before = ranges.stats().contextIndexBytes; assert.ok(before > 0);
  ranges.dispose(); const retired = ranges.stats().contextIndexBytes;
  assert.equal(retired, 0); assert.equal(ranges.visitContexts(() => assert.fail('disposed')), false);
  view.release(); assert.equal(arena.stats().contexts, 1); assert.deepEqual(arena.encode(vocabulary, pin.batches[0]!, grant), [[0, 2]]);
  pin.release(); assert.equal(arena.stats().retainedBytes, 0);
  console.log(JSON.stringify({ demandLifetime: { committedBlocks: 40, uniqueCurrent: refs.length, indexBefore: before, retiredIndex: retired, finalArenaBytes: arena.stats().retainedBytes } }));
});

test('context demand: neutral absent, parsed-empty positive, dictionary aliases counted once, namespaces remain distinct', () => {
  const arena = new ContextArena(), ranges = new SemanticRanges(arena);
  ranges.apply({ ...patch(1), contexts: [new Uint32Array(), new Uint32Array()], runs: Uint32Array.of(1, 0, 2, 1, 3, 2) }, grant);
  const refs = contexts(ranges); assert.equal(refs.length, 1); assert.deepEqual(arena.encode(vocabulary, refs, grant), [[0]]);
  ranges.apply({ ...patch(2), contexts: [Uint32Array.of(3)], runs: Uint32Array.of(5, 1) }, grant);
  assert.equal(contexts(ranges).length, 2, 'committed parsed-empty survives alias tail removal');
  ranges.dispose(); assert.equal(arena.stats().retainedBytes, 0);
  const other = new SemanticRanges(arena); other.apply({ ...patch(1, 2, otherVocabulary), contexts: [], runs: Uint32Array.of(3, 0) }, grant);
  assert.deepEqual(contexts(other), []); assert.equal(other.stats().vocabulary, otherVocabulary); other.dispose();
});

test('context demand: denied new index peak precedes allocation and leaves current, view and accounts unchanged', () => {
  const arena = new ContextArena(), ranges = new SemanticRanges(arena); ranges.apply(patch(1), grant);
  const old = contexts(ranges), view = ranges.captureView(grant)!, stats = SemanticRanges.ownershipStats(ranges, [view]), arenaStats = arena.stats();
  const input = patch(2, 3), Original = globalThis.Map, OriginalArray = globalThis.Uint32Array; let maps = 0, vectors = 0, peak = 0;
  globalThis.Map = new Proxy(Original, { construct(target, args) { maps++; return Reflect.construct(target, args); } });
  globalThis.Uint32Array = new Proxy(OriginalArray, { construct(target, args) { vectors++; return Reflect.construct(target, args); } });
  try { assert.equal(ranges.apply(input, bytes => { peak = bytes; return false; }), false); }
  finally { globalThis.Map = Original; globalThis.Uint32Array = OriginalArray; }
  assert.equal(maps, 0); assert.equal(vectors, 0); assert.ok(peak > 0);
  assert.deepEqual(contexts(ranges), old); assert.deepEqual(SemanticRanges.ownershipStats(ranges, [view]), stats); assert.deepEqual(arena.stats(), arenaStats);
  assert.equal(ranges.apply(input, grant), true); assert.equal(contexts(ranges).length, 2);
  view.release(); ranges.dispose(); assert.equal(arena.stats().retainedBytes, 0);
  console.log(JSON.stringify({ demandDenial: { peak, maps, vectors, finalBytes: arena.stats().retainedBytes } }));
});

test('context demand: long-prefix append and current/historical theme enumeration never read old runs or dictionaries', () => {
  const pool = new SemanticRetentionPool(); pool.admit('a', 1, 'x\nx');
  const Original = globalThis.Uint32Array, adopt = ContextArena.prototype.adopt;
  let runReads = 0, dictionaryReads = 0, watch = true, firstRun = false, firstDictionary = false;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) {
    const array = Reflect.construct(target, args);
    if (!firstRun) return array; firstRun = false; const watched = watch;
    return new Proxy(array, { get(value, key) { if (watched && typeof key === 'string' && /^\d+$/.test(key)) runReads++; return Reflect.get(value, key, value); } });
  } });
  ContextArena.prototype.adopt = function(v, batches, reserve) {
    const lease = adopt.call(this, v, batches, reserve); if (!lease || !firstDictionary) return lease;
    firstDictionary = false; const watched = watch, refs = new Proxy(lease.batches[0]!, { get(value, key) {
      if (watched && typeof key === 'string' && /^\d+$/.test(key)) dictionaryReads++; return Reflect.get(value, key, value);
    } });
    return { batches: [refs], release: () => lease.release() };
  };
  function append(i: number) {
    const input = patch(i), text = 'x\n'.repeat(i) + 'x'; if (i > 1) pool.replaceSnapshot(1, i, text);
    firstRun = firstDictionary = true; assert.equal(pool.installChunk(1, input).accepted, true);
  }
  try {
    for (let i = 1; i <= 64; i++) append(i);
    watch = false; runReads = dictionaryReads = 0;
    for (let i = 65; i <= 80; i++) { append(i); assert.equal(current(pool).length, 2); }
    assert.equal(publish(pool).accepted, true);
    const status = pool.displayStatus(1)!; let historical = 0;
    for (let i = 0; i < 20; i++) {
      assert.equal(publish(pool, i + 2).accepted, true);
      assert.equal(pool.visitDisplayContexts(1, status.effectStamp, () => { historical++; }), true);
      assert.equal(current(pool).length, 2); pool.stats();
    }
    assert.equal(runReads, 0); assert.equal(dictionaryReads, 0);
    const demandRunReads = runReads, demandDictionaryReads = dictionaryReads;
    pool.visitRanges(1, () => {}); assert.ok(runReads > 0); assert.ok(dictionaryReads > 0);
    console.log(JSON.stringify({ demandProxy: { prefixBlocks: 64, appendedBlocks: 16, demandRunReads, demandDictionaryReads,
      positiveRunReads: runReads, positiveDictionaryReads: dictionaryReads, historicalCallbacks: historical, indexBytes: pool.stats().contextIndexBytes } }));
  } finally { ContextArena.prototype.adopt = adopt; globalThis.Uint32Array = Original; pool.dispose(); }
});

test('context demand: current and historical provisional visits stop on revision, retirement or token replacement', () => {
  const pool = root(); assert.equal(pool.visitContexts(999, () => assert.fail('missing')), false);
  let calls = 0;
  assert.equal(pool.visitContexts(1, () => { calls++; pool.replaceSnapshot(1, 2, 'x\nx\nx'); pool.installChunk(1, patch(2, 3)); }), false);
  assert.equal(calls, 1); assert.equal(publish(pool).accepted, true);
  const display = pool.displayStatus(1)!; calls = 0;
  assert.equal(pool.visitDisplayContexts(1, display.effectStamp, () => { calls++; assert.equal(publish(pool, 2).accepted, true); }), false);
  assert.equal(calls, 1); assert.equal(pool.displayStatus(1)!.effectStamp, display.effectStamp);
  calls = 0;
  assert.equal(pool.visitDisplayContexts(1, display.effectStamp, () => { calls++; pool.remove(1); }), false);
  assert.equal(calls, 1); assert.equal(pool.visitContexts(1, () => assert.fail('removed')), false);
  assert.equal(pool.visitDisplayContexts(1, display.effectStamp, () => assert.fail('removed')), false); assert.equal(pool.stats().retainedBytes, 0);
});

function observe(build: () => void) {
  const set = Map.prototype.set, freeze = Object.freeze, adopt = ContextArena.prototype.adopt, push = Array.prototype.push;
  const refs: WeakRef<object>[] = [], words: WeakRef<object>[] = [], dictionaries: WeakRef<object>[] = [], keyLists: WeakRef<object>[] = [], maps: WeakRef<object>[] = [];
  const indexMaps: WeakRef<object>[] = [], indexKeys: WeakRef<object>[] = [], snapshots: WeakRef<object>[] = [];
  let readyMap = false, indexPush = false;
  Map.prototype.set = function<K, V>(key: K, value: V): Map<K, V> {
    if (key === 1 && value && typeof value === 'object' && 'basis' in value) snapshots.push(new WeakRef(value.basis as object));
    if (typeof key === 'string' && value && typeof value === 'object' && 'words' in value && 'ref' in value) {
      words.push(new WeakRef(value.words as object)); refs.push(new WeakRef(value.ref as object));
    }
    if (key && typeof key === 'object' && 'id' in key && value && typeof value === 'object' && 'foreground' in value) { readyMap = true; maps.push(new WeakRef(this)); }
    if (key && typeof key === 'object' && 'id' in key && value && typeof value === 'object' && 'count' in value && 'position' in value) {
      indexMaps.push(new WeakRef(this)); indexPush = true;
    }
    return set.call(this, key, value) as Map<K, V>;
  };
  Array.prototype.push = function<T>(...items: T[]): number {
    if (indexPush && items[0] && typeof items[0] === 'object' && 'id' in items[0]) {
      indexPush = false; indexKeys.push(new WeakRef(this));
    }
    return push.apply(this, items);
  };
  Object.freeze = new Proxy(freeze, { apply(target, receiver, args) {
    const value = args[0];
    if (readyMap && Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && 'id' in value[0]) keyLists.push(new WeakRef(value));
    return Reflect.apply(target, receiver, args);
  } });
  ContextArena.prototype.adopt = function(v, batches, reserve) {
    const lease = adopt.call(this, v, batches, reserve); if (lease) for (const refs of lease.batches) dictionaries.push(new WeakRef(refs)); return lease;
  };
  try { build(); } finally { Map.prototype.set = set; Object.freeze = freeze; ContextArena.prototype.adopt = adopt; Array.prototype.push = push; }
  return { refs, words, dictionaries, keyLists, maps, indexMaps, indexKeys, snapshots };
}
for (const historical of [false, true]) test(`context demand: ${historical ? 'historical nested replacement' : 'current retirement'} frees actual unvisited keys/dictionaries during suspended callback with arena/peer alive`, async () => {
  const pool = new SemanticRetentionPool(), seen = observe(() => { pool.admit('a', 1, 'x\nx'); pool.installChunk(1, patch(1)); if (historical) assert.equal(publish(pool).accepted, true); });
  const peer = pool.admit('peer', 1, 'x').generation!;
  pool.installChunk(peer, { ...patch(1), key: 'peer', generation: peer, source_bytes: 1, committed_bytes: 0, contexts: [Uint32Array.of(8)], runs: Uint32Array.of(1, 1) });
  const peerBytes = pool.status(peer)!.retainedBytes, peerArenaBytes = pool.arena.stats().retainedBytes;
  const status = historical ? pool.displayStatus(1)! : undefined;
  let alternate = historical ? presentation(current(pool), 2) : undefined;
  await turn(); // No deref before synchronous callback GC: WeakRef construction job is over.
  let calls = 0;
  function removeAndCollect() {
    pool.remove(1); assert.equal(pool.stats().contextIndexBytes > 0, true, 'peer index stays funded');
    assert.equal(pool.reserve(peer, pool.stats().maxBytes - pool.stats().retainedBytes).accepted, true);
    global.gc!(); global.gc!();
    const unvisitedRefCollected = !seen.refs[1]!.deref(), wordsCollected = seen.words.every(ref => !ref.deref()), dictionariesCollected = seen.dictionaries.every(ref => !ref.deref());
    const mapsCollected = seen.maps.every(ref => !ref.deref()), keyListsCollected = seen.keyLists.every(ref => !ref.deref());
    assert.ok(seen.indexMaps.length); assert.ok(seen.indexKeys.length); assert.ok(seen.snapshots.length);
    const snapshotsCollected = seen.snapshots.every(ref => !ref.deref()); assert.equal(snapshotsCollected, true);
    const indexMapsCollected = seen.indexMaps.every(ref => !ref.deref()), indexKeysCollected = seen.indexKeys.every(ref => !ref.deref());
    assert.equal(indexMapsCollected, true); assert.equal(indexKeysCollected, true);
    if (historical) { assert.ok(seen.maps.length); assert.ok(seen.keyLists.length); }
    assert.equal(unvisitedRefCollected, true, 'neither suspended visitor nor retired backing storage may retain an unvisited key');
    assert.equal(wordsCollected, true); assert.equal(dictionariesCollected, true); assert.equal(mapsCollected, true); assert.equal(keyListsCollected, true);
    assert.ok(pool.status(peer)!.retainedBytes >= peerBytes); assert.ok(pool.arena.stats().retainedBytes < peerArenaBytes);
    console.log(JSON.stringify({ demandGC: { historical, unvisitedRefCollected, wordsCollected, dictionariesCollected, mapsCollected, keyListsCollected, indexMapsCollected, indexKeysCollected, snapshotsCollected, peerEntries: pool.stats().entries, livePeerIndexBytes: pool.stats().contextIndexBytes } }));
  }
  const ok = historical ? pool.visitDisplayContexts(1, status!.effectStamp, () => {
    calls++; assert.equal(pool.publishDisplay(1, { semanticStamp: status!.semanticStamp, sourceVersion: status!.sourceVersion, presentation: alternate! }).accepted, true);
    alternate = undefined; // Producer input no longer owns otherwise unvisited handles.
    assert.equal(pool.visitDisplayContexts(1, status!.effectStamp, () => { calls++; removeAndCollect(); }), false);
  }) : pool.visitContexts(1, () => { calls++; removeAndCollect(); });
  assert.equal(ok, false); assert.equal(calls, historical ? 2 : 1); pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('context demand: historical ready keys survive tail change and namespace restart without joining current demand', () => {
  const pool = root(); publish(pool); const display = pool.displayStatus(1)!;
  const old: ContextRef[] = []; assert.equal(pool.visitDisplayContexts(1, display.effectStamp, ref => old.push(ref)), true);
  pool.replaceSnapshot(1, 2, 'x\nx\nx'); pool.installChunk(1, patch(2, 3));
  const next = current(pool); assert.equal(next.length, 2); assert.ok(!next.includes(old[1]!));
  const historical: ContextRef[] = []; pool.visitDisplayContexts(1, display.effectStamp, ref => historical.push(ref)); assert.deepEqual(historical, old);
  pool.replaceSnapshot(1, 3, 'x\nx\nx\nx');
  const restart = { ...patch(1, 6, otherVocabulary), source_version: 3, source_bytes: 7, committed_bytes: 6,
    contexts: [Uint32Array.of(5), Uint32Array.of(6)], runs: Uint32Array.of(6, 1, 7, 2) };
  assert.equal(pool.installChunk(1, restart, undefined, true).accepted, true);
  assert.equal(pool.stats().rangeStores, 2); assert.equal(pool.stats().currentContexts, 2); assert.equal(pool.arena.stats().contexts, 4);
  assert.equal(pool.displayStatus(1)!.vocabulary, vocabulary); assert.equal(pool.status(1)!.vocabulary, otherVocabulary);
  const b = current(pool); assert.ok(b.every(ref => !old.includes(ref)));
  const after: ContextRef[] = []; assert.equal(pool.visitDisplayContexts(1, display.effectStamp, ref => after.push(ref)), true); assert.deepEqual(after, old);
  const indexBytes = pool.stats().contextIndexBytes;
  assert.equal(pool.publishDisplay(1, { semanticStamp: display.semanticStamp, sourceVersion: display.sourceVersion, presentation: presentation(old, 2) }).accepted, true);
  assert.deepEqual(current(pool), b); assert.equal(pool.stats().contextIndexBytes, indexBytes);
  const receipt = pool.remove(1)[0]!; assert.equal(receipt.contextIndexBytes, indexBytes); assert.equal(receipt.currentContexts, 2);
  assert.equal(pool.stats().retainedBytes, 0); assert.equal(pool.stats().contextIndexBytes, 0);
  console.log(JSON.stringify({ demandHistorical: { retiredStores: 1, liveCurrentContexts: 2, historicalContexts: after.length, indexBytes, finalBytes: pool.stats().retainedBytes } }));
});

test('context demand: measured funded source cost distinguishes the old20KB fixture from eight-source precondition', () => {
  const observations = [];
  for (const maxBytes of [20000, 26000]) {
    const pool = new SemanticRetentionPool({ maxBytes }), generations: number[] = [];
    for (let i = 0; i < 8; i++) {
      const key = `s${i}`, admitted = pool.admit(key, 1, 'abc'); assert.equal(admitted.accepted, true);
      const generation = admitted.generation!; generations.push(generation);
      assert.equal(pool.installChunk(generation, { vocabulary, key, generation, source_version: 1, revision: 1, source_bytes: 3,
        replace_from: 0, committed_bytes: 3, complete: true, contexts: [Uint32Array.of(1)], runs: Uint32Array.of(3, 1),
        counters: { committed_line_calls: 1, committed_line_bytes: 3, tail_calls: 0, tail_bytes: 0 } }).accepted, true);
    }
    const retainedSources = generations.filter(generation => pool.status(generation)).length, stats = pool.stats();
    assert.equal(retainedSources === 8, maxBytes === 26000);
    observations.push({ maxBytes, retainedSources, retainedBytes: stats.retainedBytes, indexBytes: stats.contextIndexBytes });
    pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
  }
  console.log(JSON.stringify({ demandPressureCost: observations }));
});
