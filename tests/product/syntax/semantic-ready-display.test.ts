import '../../fixtures/test-guard.mjs';
import { installProjection, visitProjection, projectionRanges } from '../../fixtures/pi-projection.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { SemanticRetentionPool, type ReadyPresentation } from '../../../src/occipital/semantic-retention.ts';
import { CARD_ROLES, decodeContextBatch, decodeStyleResult, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { decodeSemanticSources, type SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import type { ContextRef } from '../../../src/occipital/context-arena.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v3/vectors.json', import.meta.url), 'utf8'));
const vocabulary = 'a'.repeat(64), rules = 'b'.repeat(64), grant = () => true;
const paths = decodeContextBatch([vectors.contexts[0].encoded], { vocabularySize: vectors.vocabulary_size, maxBytes: 1 << 20 }).batches[0]!;
const nativeFixture = vectors.styles.find((vector: { name: string }) => vector.name === 'empty-source-complete-native-palette');
const native = decodeStyleResult(nativeFixture.body, { vocabulary, rules, mode: 'native', bindingSlots: 0 }, 0, 1 << 20);
const indexedFixture = vectors.styles.find((vector: { name: string }) => vector.name === 'indexed-is-not-guessed-rgb');
const indexed = decodeStyleResult(indexedFixture.body, { vocabulary, rules, mode: 'client', bindingSlots: 0 }, 1, 1 << 20);
const caller: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const nativeStyle = materializeStyle(native.styles[0]!, [], caller), indexedStyle = materializeStyle(indexed.styles[0]!, [], caller);

function chunk(key: string, generation: number, text: string, options: Partial<SemanticChunk> = {}): SemanticChunk {
  const source_bytes = Buffer.byteLength(text), replace_from = options.replace_from ?? 0, complete = options.complete ?? false;
  const replacementText = Buffer.from(text).subarray(replace_from).toString();
  const expected = { key, generation, source_version: 1, revision: 1, source_bytes, replace_from, complete,
    ...(!complete || options.lease ? { lease: options.lease ?? 'lease' } : {}), ...options, replacementText };
  const { replacementText: _text, contexts: _contexts, runs: _runs, counters: _counters, committed_bytes: _committed, ...metadata } = expected;
  const contexts = (options.contexts ?? [paths[1]!]).map(path => [0, ...path]);
  const runs = options.runs ? Array.from(options.runs).map((value, index, all) => index % 2 ? value : value - (index ? all[index - 2]! : replace_from))
    : source_bytes > replace_from ? [source_bytes - replace_from, 1] : [];
  return decodeSemanticSources({ kind: 'source', vocabulary, sources: [{ ...metadata,
    committed_bytes: complete ? source_bytes : replace_from + Buffer.from(replacementText).lastIndexOf(10) + 1, contexts, runs,
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }] },
  { vocabulary, vocabularySize: vectors.vocabulary_size, sourceBytes: 1 << 20, runs: 10000, batchSources: 8 }, [expected], 64 << 20).sources[0]!;
}
function references(pool: SemanticRetentionPool, generation: number) {
  const refs = new Set<ContextRef>(); pool.visitRanges(generation, (_a, _b, ref) => { if (ref) refs.add(ref); }); return [...refs];
}
function presentation(refs: readonly ContextRef[], style: ConcreteStyle = nativeStyle): ReadyPresentation {
  return { vocabulary, rules, palette: native.palette!.fingerprint, bindingRevision: 1,
    roles: Object.fromEntries(CARD_ROLES.map((role, index) => [role, structuredClone(style === nativeStyle
      ? materializeStyle(native.styles[native.palette!.slots[index]! - 1]!, [], caller) : style)])) as Record<CardRole, ConcreteStyle>,
    contexts: refs.map(context => ({ context, style: structuredClone(style) })) };
}
function publish(pool: SemanticRetentionPool, generation: number, data = presentation(references(pool, generation))) {
  const status = pool.status(generation)!;
  return pool.publishDisplay(generation, { semanticStamp: status.semanticStamp, sourceVersion: status.sourceVersion!, presentation: data });
}
function displayRows(pool: SemanticRetentionPool, generation: number) {
  const status = pool.displayStatus(generation); assert.ok(status);
  const rows: { from: number; to: number; id: number; style: ConcreteStyle }[] = [];
  assert.equal(pool.visitDisplay(generation, status.effectStamp, (from, to, id, style) => rows.push({ from, to, id, style })), true);
  return rows;
}
function provisional(pool: SemanticRetentionPool, key = 'a') {
  const generation = pool.admit(key, 1, 'a\nb').generation!;
  pool.installChunk(generation, chunk(key, generation, 'a\nb', { contexts: [paths[1]!, paths[2]!], runs: Uint32Array.of(2, 1, 3, 2) }));
  return generation;
}

test('ready display: V1 exact text and literal palette survive V2 parser progress, then atomic V2 publication frees V1 tail/text', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool);
  assert.equal(pool.displayStatus(generation), undefined);
  const data = presentation(references(pool, generation));
  assert.equal(publish(pool, generation, data).accepted, true);
  const old = pool.displayStatus(generation)!, oldRows = displayRows(pool, generation), oldSnapshot = pool.borrowDisplay(generation, old.effectStamp)!;
  const oldTail = references(pool, generation)[1]!;
  pool.arena.installStyles(vocabulary, rules, [oldTail], native.styles, Uint32Array.of(1), grant);
  pool.replaceSnapshot(generation, 2, 'a\nbc');
  pool.installChunk(generation, chunk('a', generation, 'a\nbc', { revision: 2, source_version: 2, replace_from: 2, contexts: [paths[3]!] }));
  assert.equal(pool.borrowSnapshot(generation, 'basis')!.text, 'a\nbc');
  assert.equal(pool.status(generation)!.sourceVersion, 2);
  assert.deepEqual(pool.borrowDisplay(generation, old.effectStamp), oldSnapshot);
  assert.deepEqual(displayRows(pool, generation), oldRows);
  assert.equal(pool.stats().retainedTails, 2); assert.equal(pool.stats().displayOnlyRangeBytes, 8);
  pool.arena.clearStyles(); assert.deepEqual(displayRows(pool, generation), oldRows);
  assert.equal(pool.arena.style(vocabulary, references(pool, generation)[1]!, rules), undefined);
  assert.equal(publish(pool, generation, presentation(references(pool, generation), indexedStyle)).accepted, true);
  const next = pool.displayStatus(generation)!;
  assert.notEqual(next.effectStamp, old.effectStamp); assert.notEqual(next.geometryStamp, old.geometryStamp);
  assert.equal(pool.borrowDisplay(generation, next.effectStamp)!.text, 'a\nbc');
  assert.equal(pool.borrowDisplay(generation, old.effectStamp), undefined);
  assert.equal(pool.stats().retainedTails, 1); assert.equal(pool.stats().displayOnlyRangeBytes, 0);
  assert.throws(() => pool.arena.style(vocabulary, oldTail, rules));
  assert.equal(pool.stats().snapshotBytes, 32 + 2 * 'a\nbc'.length);
  assert.deepEqual(displayRows(pool, generation)[1]!.style, indexedStyle);
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('ready display: unready appends and parser restart retain only captured prefix/tail and exact ready snapshot', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool);
  publish(pool, generation);
  const old = pool.displayStatus(generation)!, expected = displayRows(pool, generation);
  pool.replaceSnapshot(generation, 2, 'a\nb\nc');
  pool.installChunk(generation, chunk('a', generation, 'a\nb\nc', { revision: 2, source_version: 2, replace_from: 2,
    contexts: [paths[3]!, paths[4]!], runs: Uint32Array.of(4, 1, 5, 2) }));
  pool.replaceSnapshot(generation, 3, 'a\nb\ncd');
  pool.installChunk(generation, chunk('a', generation, 'a\nb\ncd', { source_version: 3, lease: 'restarted', contexts: [paths[0]!] }), undefined, true);
  assert.equal(pool.status(generation)!.sourceVersion, 3);
  assert.equal(pool.stats().rangeStores, 2); assert.equal(pool.stats().rangeViews, 1);
  assert.equal(pool.stats().rangeBlocks, 2, 'one captured prefix block and one restarted current block; unseen V2 block is gone');
  assert.equal(pool.arena.stats().contexts, 3, 'only captured prefix/tail plus restarted parsed-empty');
  assert.deepEqual(displayRows(pool, generation), expected);
  assert.equal(pool.borrowDisplay(generation, old.effectStamp)!.text, 'a\nb');
  assert.equal(pool.stats().snapshotBytes, (32 + 2 * 3) + (32 + 2 * 6), 'unreachable intermediate text is not retained');
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('ready display: theme-only publication reads no prefix, keeps geometry, and equal literals ignore rule metadata for effect', () => {
  const pool = new SemanticRetentionPool(), original = globalThis.Uint32Array;
  const generation = pool.admit('a', 1, 'a\nb').generation!;
  const source = chunk('a', generation, 'a\nb', { contexts: [paths[1]!, paths[2]!], runs: Uint32Array.of(2, 1, 3, 2) });
  let constructs = 0, prefixReads = 0;
  globalThis.Uint32Array = new Proxy(original, { construct(target, args) {
    const value = Reflect.construct(target, args); if (++constructs !== 1) return value;
    return new Proxy(value, { get(array, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) prefixReads++;
      return Reflect.get(array, property, array);
    } });
  } });
  try { pool.installChunk(generation, source); } finally { globalThis.Uint32Array = original; }
  const refs = references(pool, generation), a = presentation(refs), b = presentation(refs, indexedStyle);
  publish(pool, generation, a);
  const first = pool.displayStatus(generation)!, progress = pool.status(generation)!;
  const byteLength = Buffer.byteLength; let utf8Calls = 0;
  prefixReads = 0;
  Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => { utf8Calls++; return byteLength(...args); }) as typeof Buffer.byteLength;
  try { assert.equal(publish(pool, generation, b).accepted, true); }
  finally { Buffer.byteLength = byteLength; }
  const changed = pool.displayStatus(generation)!, role = pool.displayRole(generation, changed.effectStamp, 'code');
  assert.equal(prefixReads, 0); assert.equal(utf8Calls, 0);
  assert.equal(changed.geometryStamp, first.geometryStamp); assert.equal(changed.semanticStamp, first.semanticStamp);
  assert.notEqual(changed.effectStamp, first.effectStamp); assert.equal(pool.stats().rangeViews, 1);
  const metadata = { ...b, rules: 'd'.repeat(64), palette: 'e'.repeat(64), bindingRevision: 7 };
  assert.equal(publish(pool, generation, metadata).accepted, true);
  const equal = pool.displayStatus(generation)!;
  assert.equal(equal.effectStamp, changed.effectStamp); assert.equal(equal.geometryStamp, changed.geometryStamp);
  assert.equal(equal.rules, metadata.rules); assert.equal(equal.bindingRevision, 7);
  assert.equal(pool.displayRole(generation, equal.effectStamp, 'code'), role, 'equal concrete data reuse the owned literal objects');
  assert.equal(pool.status(generation)!.semanticStamp, progress.semanticStamp);
  assert.equal(prefixReads, 0);
  const publicationPrefixReads = prefixReads;
  displayRows(pool, generation); assert.ok(prefixReads > 0, 'the numeric-access proxy has a positive visit control');
  console.log(JSON.stringify({ readyTheme: { publicationPrefixReads, positiveVisitReads: prefixReads, utf8Calls,
    firstGeometry: first.geometryStamp, nextGeometry: equal.geometryStamp, changedEffect: changed.effectStamp, equalEffect: equal.effectStamp } }));
  pool.dispose();
});

test('ready display: old display may recolor while current parser advances, but V1 cannot replace a published V2', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool), oldData = presentation(references(pool, generation));
  publish(pool, generation, oldData); const old = pool.displayStatus(generation)!;
  pool.replaceSnapshot(generation, 2, 'a\nbc');
  pool.installChunk(generation, chunk('a', generation, 'a\nbc', { revision: 2, source_version: 2, replace_from: 2, contexts: [paths[3]!] }));
  const historical = { semanticStamp: old.semanticStamp, sourceVersion: old.sourceVersion, presentation: presentation(oldData.contexts.map(pair => pair.context), indexedStyle) };
  assert.equal(pool.publishDisplay(generation, historical).accepted, true);
  assert.equal(pool.displayStatus(generation)!.geometryStamp, old.geometryStamp);
  publish(pool, generation);
  const next = pool.displayStatus(generation)!;
  assert.equal(pool.publishDisplay(generation, historical).accepted, false);
  assert.deepEqual(pool.displayStatus(generation), next);
  const current = pool.status(generation)!;
  for (const bad of [{ semanticStamp: current.semanticStamp + 1, sourceVersion: 2 }, { semanticStamp: current.semanticStamp, sourceVersion: 1 }]) {
    assert.equal(pool.publishDisplay(generation, { ...bad, presentation: presentation(references(pool, generation)) }).accepted, false);
  }
  pool.clear(); const successor = provisional(pool);
  assert.notEqual(successor, generation); assert.equal(pool.publishDisplay(generation, historical).accepted, false);
  pool.dispose();
});

test('ready display: denied old/new peak protects old display and returns every pressure eviction receipt', () => {
  // Namespace keys/provenance are now charged: admit one ready pair, still deny its old/new peak.
  const pool = new SemanticRetentionPool({ maxBytes: 21000 }), generation = provisional(pool);
  assert.equal(publish(pool, generation).accepted, true);
  pool.admit('peer1', 1, 'peer'); pool.admit('peer2', 1, 'peer');
  const old = pool.displayStatus(generation)!, before = displayRows(pool, generation), snapshot = pool.borrowDisplay(generation, old.effectStamp);
  const replacement = presentation(references(pool, generation), indexedStyle), OriginalMap = globalThis.Map, OriginalSet = globalThis.Set;
  let deniedMapAllocations = 0, deniedSetAllocations = 0;
  globalThis.Map = new Proxy(OriginalMap, { construct(target, args) { deniedMapAllocations++; return Reflect.construct(target, args); } });
  globalThis.Set = new Proxy(OriginalSet, { construct(target, args) { deniedSetAllocations++; return Reflect.construct(target, args); } });
  let failed;
  try { failed = publish(pool, generation, replacement); }
  finally { globalThis.Map = OriginalMap; globalThis.Set = OriginalSet; }
  assert.equal(deniedMapAllocations, 0); assert.equal(deniedSetAllocations, 0);
  assert.equal(failed.accepted, false);
  assert.deepEqual(failed.released.map(receipt => receipt.key), ['peer1', 'peer2']);
  assert.deepEqual(pool.displayStatus(generation), old); assert.deepEqual(displayRows(pool, generation), before);
  assert.deepEqual(pool.borrowDisplay(generation, old.effectStamp), snapshot);
  assert.equal(pool.stats().entries, 1); assert.equal(pool.stats().rangeViews, 1); assert.ok(pool.stats().retainedBytes <= 21000);
  console.log(JSON.stringify({ readyDenial: { accepted: failed.accepted, deniedMapAllocations, deniedSetAllocations, receipts: failed.released.map(receipt => ({ key: receipt.key, bytes: receipt.retainedBytes })), retained: pool.stats().retainedBytes } }));
  pool.clear(); assert.equal(pool.stats().retainedBytes, 0);
});

test('ready display: native ready data are detached immutable literals; complete neutral and parsed-empty stay exact', () => {
  const pool = new SemanticRetentionPool(), generation = pool.admit('a', 1, 'a雪é').generation!;
  pool.installChunk(generation, chunk('a', generation, 'a雪é', { complete: true, contexts: [paths[0]!, paths[1]!], runs: Uint32Array.of(1, 0, 4, 1, 6, 2) }));
  const data = presentation(references(pool, generation)); publish(pool, generation, data);
  const status = pool.displayStatus(generation)!, expected = displayRows(pool, generation), code = pool.displayRole(generation, status.effectStamp, 'code')!;
  assert.equal(status.complete, true); assert.equal(pool.borrowDisplay(generation, status.effectStamp)!.text, 'a雪é');
  assert.deepEqual(expected.map(row => [row.from, row.to, row.id === 0]), [[0, 1, true], [1, 4, false], [4, 6, false]]);
  assert.equal(expected[0]!.style, code); assert.deepEqual(code, nativeStyle);
  Object.assign(data.roles.code.foreground, { r: 1 }); Object.assign(data.contexts[0]!.style, { attributes: 15 });
  (data.contexts as { context: ContextRef; style: ConcreteStyle }[]).pop();
  assert.deepEqual(displayRows(pool, generation), expected); assert.ok(Object.isFrozen(code)); assert.ok(Object.isFrozen(code.foreground));
  assert.equal(expected[1]!.style, expected[2]!.style, 'literal table deduplicates equal independent input styles');
  pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

test('ready display: missing roles, forged handles and duplicates are refused; incomplete internal context coverage throws a whole-visit invariant', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool), data = presentation(references(pool, generation));
  publish(pool, generation, data); const old = pool.displayStatus(generation)!;
  const missing = { ...data, roles: { ...data.roles } }; delete (missing.roles as Partial<typeof missing.roles>).frame;
  assert.equal(publish(pool, generation, missing).accepted, false);
  assert.equal(publish(pool, generation, { ...data, contexts: [{ context: { id: data.contexts[0]!.context.id }, style: nativeStyle }] }).accepted, false);
  assert.equal(publish(pool, generation, { ...data, contexts: [data.contexts[0]!, data.contexts[0]!] }).accepted, false);
  assert.deepEqual(pool.displayStatus(generation), old);
  assert.equal(publish(pool, generation, { ...data, contexts: data.contexts.slice(0, 1) }).accepted, true, 'caller owns completeness; root does not scan prefix');
  const incomplete = pool.displayStatus(generation)!; const published: unknown[] = [];
  assert.throws(() => {
    const staged: unknown[] = [];
    if (pool.visitDisplay(generation, incomplete.effectStamp, (a, b) => staged.push([a, b]))) published.push(...staged);
  }, /incomplete ready presentation/);
  assert.deepEqual(published, [], 'provisional callbacks cannot be committed after an invariant failure');
  pool.dispose();
});

test('ready display: removal during visit stops callbacks and stale read identity cannot alias a successor', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool); publish(pool, generation);
  const status = pool.displayStatus(generation)!; let calls = 0;
  assert.equal(pool.visitDisplay(generation, status.effectStamp, () => { calls++; pool.remove(generation); }), false);
  assert.equal(calls, 1); assert.equal(pool.stats().retainedBytes, 0);
  const successor = provisional(pool); publish(pool, successor);
  assert.equal(pool.borrowDisplay(generation, status.effectStamp), undefined);
  assert.equal(pool.displayRole(generation, status.effectStamp, 'code'), undefined);
  assert.equal(pool.visitDisplay(generation, status.effectStamp, () => assert.fail('stale display revived')), false);
  pool.dispose();
});

test('ready display: no-op finalization changes parser completion but not historical geometry/effect or finite authority', () => {
  const pool = new SemanticRetentionPool(), generation = pool.admit('a', 1, 'abc').generation!;
  pool.installChunk(generation, chunk('a', generation, 'abc')); publish(pool, generation);
  const old = pool.displayStatus(generation)!, before = pool.status(generation)!;
  pool.installChunk(generation, chunk('a', generation, 'abc', { revision: 2, complete: true, lease: 'lease' }));
  publish(pool, generation);
  const next = pool.displayStatus(generation)!;
  assert.equal(pool.status(generation)!.complete, true); assert.equal(pool.status(generation)!.semanticStamp, before.semanticStamp);
  assert.equal(next.geometryStamp, old.geometryStamp); assert.equal(next.effectStamp, old.effectStamp);
  assert.equal(next.complete, false, 'capture metadata is historical presentation, not new finite evidence');
  pool.dispose();
});

test('ready display: independent pending pins outlive entry clear, while display/range/snapshot ownership returns to zero', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool); publish(pool, generation);
  const pin = pool.arena.retain(references(pool, generation), grant)!;
  pool.replaceSnapshot(generation, 2, 'a\nbc'); pool.retainBasis(generation);
  assert.ok(installProjection(pool, generation, 1, 'a\nb').accepted);
  const released = pool.clear(); assert.equal(released.length, 1); assert.ok(released[0]!.displayBytes > 0);
  assert.equal(pool.stats().entries, 0); assert.equal(pool.stats().rangeBytes, 0); assert.equal(pool.stats().snapshotBytes, 0); assert.equal(pool.stats().displayBytes, 0);
  assert.equal(pool.stats().retainedBytes, pool.arena.stats().retainedBytes); assert.ok(pool.stats().retainedBytes > 0);
  pin.release(); assert.equal(pool.stats().retainedBytes, 0); pool.dispose();
});

function weakReader(owner: WeakRef<SemanticRetentionPool>, generation: number, effect: number) {
  return { read: () => owner.deref()?.borrowDisplay(generation, effect), visit: () => owner.deref()?.visitDisplay(generation, effect, () => {}) ?? false };
}
function disposedFirst() {
  const pool = new SemanticRetentionPool(), generation = provisional(pool); publish(pool, generation);
  const status = pool.displayStatus(generation)!, saved = pool.borrowDisplay(generation, status.effectStamp), role = pool.displayRole(generation, status.effectStamp, 'code');
  const owner = new WeakRef(pool), arena = new WeakRef(pool.arena), reader = weakReader(owner, generation, status.effectStamp);
  pool.dispose(); return { owner, arena, reader, saved, role };
}
test('ready display: saved invalidated weak reader and detached containers do not pin first root/arena while peer is active', async () => {
  assert.equal(typeof global.gc, 'function'); const first = disposedFirst(), peer = new SemanticRetentionPool();
  const generation = provisional(peer); publish(peer, generation);
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!first.owner.deref() && !first.arena.deref()) break; }
  assert.equal(first.owner.deref(), undefined); assert.equal(first.arena.deref(), undefined);
  assert.equal(first.reader.read(), undefined); assert.equal(first.reader.visit(), false);
  assert.equal(first.saved!.text, 'a\nb'); assert.deepEqual(first.role, nativeStyle); assert.ok(peer.stats().retainedBytes > 0);
  console.log(JSON.stringify({ readyGC: { rootCollected: !first.owner.deref(), arenaCollected: !first.arena.deref(), staleVisit: first.reader.visit(), peerEntries: peer.stats().entries } }));
  peer.dispose();
});

test('ready display: snapshot/bridge/source growth and retainBasis preserve union charges and complete release receipts', () => {
  // Namespace keys/provenance are now charged: admit one ready pair, still deny its old/new peak.
  const pool = new SemanticRetentionPool({ maxBytes: 21000 }), generation = provisional(pool); publish(pool, generation);
  const ready = pool.displayStatus(generation)!, expected = displayRows(pool, generation);
  const peer = pool.admit('peer', 1, 'x'.repeat(5000)).generation!; assert.ok(peer);
  const text = 'a\nb' + 'y'.repeat(5000), growth = pool.replaceSnapshot(generation, 2, text);
  assert.equal(growth.accepted, true); assert.deepEqual(growth.released.map(receipt => receipt.key), ['peer']);
  assert.equal(pool.installChunk(generation, chunk('a', generation, text, { source_version: 2, revision: 2, replace_from: 2, contexts: [paths[3]!] })).accepted, true);
  assert.equal(pool.stats().retainedTails, 2); assert.equal(pool.stats().snapshotBytes, (32 + 2 * 3) + (32 + 2 * text.length));
  assert.equal(installProjection(pool, generation, 2, text).accepted, true);
  pool.replaceSnapshot(generation, 3, text + 'z'); pool.retainBasis(generation);
  assert.equal(pool.status(generation)!.latestVersion, undefined);
  assert.equal(pool.bridgeVersion(generation), 2); assert.equal(pool.stats().rangeViews, 1);
  assert.equal(pool.stats().snapshotBytes, (32 + 2 * 3) + (32 + 2 * text.length));
  const before = pool.stats(), status = pool.status(generation)!;
  assert.equal(pool.replaceSnapshot(generation, 3, text + 'z'.repeat(20000)).accepted, false);
  assert.deepEqual(pool.stats(), before); assert.deepEqual(pool.status(generation), status);
  assert.equal(pool.borrowDisplay(generation, ready.effectStamp)!.text, 'a\nb'); assert.deepEqual(displayRows(pool, generation), expected);
  const receipt = pool.remove(generation)[0]!;
  assert.equal(receipt.retainedBytes, before.retainedBytes); assert.equal(receipt.displayBytes, before.displayBytes);
  assert.equal(receipt.rangeBytes, before.rangeBytes); assert.equal(receipt.snapshotBytes, before.snapshotBytes);
  assert.equal(pool.stats().retainedBytes, 0); assert.equal(pool.stats().rangeStores, 0); assert.equal(pool.stats().rangeViews, 0);
  console.log(JSON.stringify({ readyAccounting: { pressureReleased: growth.released.map(receipt => receipt.key),
    beforeRelease: before, releaseReceipt: receipt, afterRelease: pool.stats() } }));
  pool.dispose();
});

test('ready display: replacing colors during a provisional visit invalidates its remaining callbacks without releasing shared geometry', () => {
  const pool = new SemanticRetentionPool(), generation = provisional(pool); publish(pool, generation);
  const before = pool.displayStatus(generation)!, replacement = presentation(references(pool, generation), indexedStyle); let calls = 0;
  assert.equal(pool.visitDisplay(generation, before.effectStamp, () => { calls++; publish(pool, generation, replacement); }), false);
  assert.equal(calls, 1); assert.equal(pool.displayStatus(generation)!.geometryStamp, before.geometryStamp);
  assert.equal(pool.stats().rangeViews, 1); assert.deepEqual(displayRows(pool, generation)[0]!.style, indexedStyle);
  pool.dispose(); assert.equal(pool.stats().retainedBytes, 0);
});

/** Observe root-owned objects, not borrowed literals/copies. The temporary native
 * Map hook sees only the root Entry insertion and adopted ContextRef-keyed map. */
function instrumentReadyOwnership(pool: SemanticRetentionPool) {
  const set = Map.prototype.set;
  let snapshot: WeakRef<object> | undefined, contexts: WeakRef<object> | undefined;
  Map.prototype.set = function<K, V>(key: K, value: V): Map<K, V> {
    if (key === 1 && value && typeof value === 'object' && 'basis' in value) {
      snapshot = new WeakRef((value as { basis: object }).basis);
    }
    if (key && typeof key === 'object' && 'id' in key && value && typeof value === 'object' && 'foreground' in value) {
      contexts = new WeakRef(this);
    }
    return set.call(this, key, value) as Map<K, V>;
  };
  try {
    const generation = provisional(pool); publish(pool, generation);
    assert.ok(snapshot); assert.ok(contexts);
    return { generation, snapshot, contexts };
  } finally { Map.prototype.set = set; }
}

for (const nested of [false, true]) test(`ready display P1: ${nested ? 'replacement and nested visit' : 'removal'} relinquishes owned map/snapshot while stack-held ranges remain funded`, async () => {
  assert.equal(typeof global.gc, 'function');
  const pool = new SemanticRetentionPool(), observed = instrumentReadyOwnership(pool);
  const generation = observed.generation, old = pool.displayStatus(generation)!;
  if (nested) {
    pool.replaceSnapshot(generation, 2, 'a\nbc');
    pool.installChunk(generation, chunk('a', generation, 'a\nbc', { revision: 2, source_version: 2, replace_from: 2, contexts: [paths[3]!] }));
  }
  const replacement = nested ? presentation(references(pool, generation), indexedStyle) : undefined;
  // WeakRef construction pins a target for that job. No deref occurs before the
  // relevant synchronous GC; a real host turn separates adoption from visitation.
  await turn();
  let outerCalls = 0, nestedCalls = 0;
  function removeAndReuse() {
    pool.remove(generation);
    assert.ok(pool.stats().retainedBytes > 0, 'actual suspended range payload stays funded');
    assert.equal(pool.reserve(undefined, pool.stats().maxBytes).accepted, false);
    global.gc!(); global.gc!();
    const mapCollected = observed.contexts.deref() === undefined, snapshotCollected = observed.snapshot.deref() === undefined;
    console.log(JSON.stringify({ readyP1: { nested, wholeBudgetAccepted: false, retainedBytes: pool.stats().retainedBytes, mapCollected, snapshotCollected } }));
    assert.equal(mapCollected, true, 'payload-free visitor must not retain retired OWNED context lookup');
    assert.equal(snapshotCollected, true, 'payload-free visitor must not retain retired OWNED snapshot');
  }
  assert.equal(pool.visitDisplay(generation, old.effectStamp, () => {
    outerCalls++;
    if (!nested) { removeAndReuse(); return; }
    assert.equal(publish(pool, generation, replacement!).accepted, true);
    const current = pool.displayStatus(generation)!;
    assert.equal(pool.visitDisplay(generation, current.effectStamp, () => {
      nestedCalls++;
      assert.equal(publish(pool, generation, presentation(references(pool, generation))).accepted, true);
      removeAndReuse();
    }), false);
  }), false);
  assert.equal(outerCalls, 1); assert.equal(nestedCalls, nested ? 1 : 0);
  assert.equal(pool.stats().retainedBytes, 0); assert.equal(pool.reserve(undefined, pool.stats().maxBytes).accepted, true);
  pool.dispose();
});

test('ready display P1: nested palette-only replacement frees retired lookup while its shared live view remains charged', async () => {
  const pool = new SemanticRetentionPool(), observed = instrumentReadyOwnership(pool), generation = observed.generation;
  const old = pool.displayStatus(generation)!, refs = references(pool, generation);
  const metadata = { ...presentation(refs), rules: 'd'.repeat(64), bindingRevision: 2 }, replacement = presentation(refs, indexedStyle);
  await turn(); // No weak deref in the adoption job.
  let calls = 0;
  assert.equal(pool.visitDisplay(generation, old.effectStamp, () => {
    calls++;
    assert.equal(publish(pool, generation, metadata).accepted, true);
    const rebound = pool.displayStatus(generation)!;
    assert.equal(rebound.effectStamp, old.effectStamp, 'metadata changes do not change actual effect');
    assert.equal(pool.visitDisplay(generation, rebound.effectStamp, () => {
      calls++;
      assert.equal(publish(pool, generation, replacement).accepted, true);
      const current = pool.displayStatus(generation)!;
      assert.equal(current.geometryStamp, old.geometryStamp); assert.equal(pool.stats().rangeViews, 1);
      assert.equal(pool.reserve(generation, pool.stats().maxBytes - pool.stats().retainedBytes).accepted, true);
      global.gc!(); global.gc!();
      const mapCollectedWhileViewLive = observed.contexts.deref() === undefined;
      assert.equal(mapCollectedWhileViewLive, true, 'only the new palette may remain owned while shared geometry is live');
      assert.deepEqual(pool.displayRole(generation, current.effectStamp, 'code'), indexedStyle);
      pool.remove(generation);
      assert.ok(pool.stats().retainedBytes > 0);
      assert.equal(pool.reserve(undefined, pool.stats().maxBytes).accepted, false);
      global.gc!(); global.gc!();
      const snapshotCollected = observed.snapshot.deref() === undefined;
      assert.equal(snapshotCollected, true);
      console.log(JSON.stringify({ readyP1SharedView: { mapCollectedWhileViewLive, snapshotCollected, geometry: current.geometryStamp,
        oldEffect: old.effectStamp, metadataEffect: rebound.effectStamp, newEffect: current.effectStamp, retainedAfterRemoval: pool.stats().retainedBytes } }));
    }), false);
  }), false);
  assert.equal(calls, 2); assert.equal(pool.stats().retainedBytes, 0); pool.dispose();
});
