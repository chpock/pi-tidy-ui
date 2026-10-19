import '../../fixtures/test-guard.mjs';
import { installProjection, visitProjection, projectionRanges } from '../../fixtures/pi-projection.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { DataBudget, DataGrant } from '../../../src/occipital/data-budget.ts';
import { ContextArena } from '../../../src/occipital/context-arena.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { CONTROLLER_LIMITS, sourceReservation } from '../../../src/occipital/controller-limits.ts';
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
const vocabulary = 'a'.repeat(64);
const chunk = (key = 'a', generation = 1): SemanticChunk => ({ key, generation, vocabulary, source_version: 1, revision: 1,
  source_bytes: 3, replace_from: 0, committed_bytes: 2, complete: false, lease: 'lease',
  contexts: [Uint32Array.of(1), Uint32Array.of(2)], runs: Uint32Array.of(2, 1, 3, 2),
  counters: { committed_line_calls: 1, committed_line_bytes: 2, tail_calls: 1, tail_bytes: 1 } });
function borrowed() {
  const arena = new ContextArena(), ranges = new SemanticRanges(arena), Original = globalThis.Uint32Array;
  const input = chunk(); let runs: WeakRef<object> | undefined;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { const value = Reflect.construct(target, args); runs ??= new WeakRef(value); return value; } });
  try { ranges.apply(input, () => true); } finally { globalThis.Uint32Array = Original; }
  assert.ok(runs); const view = ranges.captureView(() => true)!;
  return { arena, ranges, view, runs };
}
test('data lifetime: actual suspended range payload remains charged until read unwind, not merely logical invalidation', async () => {
  const held = borrowed(); await turn(); let callbacks = 0;
  held.view.visit(() => {
    callbacks++; held.ranges.dispose(); held.view.release(); global.gc!(); global.gc!();
    assert.ok(held.runs.deref(), 'actual owned run array remains on visitBlock stack');
    const charged = held.arena.budget?.stats().retainedBytes ?? SemanticRanges.ownershipStats(undefined, [held.view]).retainedBytes + held.arena.stats().retainedBytes;
    console.log(JSON.stringify({ suspendedPayload: { actualRunsLive: true, charged, callbacks } }));
    assert.ok(charged > 0, 'stack-owned bytes cannot already be spent by a replacement');
    assert.equal(held.arena.budget.reserve(held.arena.budget.limit), undefined);
  });
  assert.equal(callbacks, 1); assert.equal(held.arena.budget.stats().retainedBytes, 0);
});
test('data lifetime: tiny captures plus two full policy-bounded framing/decoded families fit physical authority', () => {
  const root = new SemanticRetentionPool(), groups: NonNullable<ReturnType<SemanticRetentionPool['captureDisplays']>['group']>[] = [];
  try {
    for (const key of ['a', 'b']) { const g = root.admit(key, 1, 'x\nx').generation!; root.installChunk(g, chunk(key, g)); groups.push(root.captureDisplays([g], () => true).group!); }
    const privateBytes = groups.reduce((sum, group) => sum + group.reservationBytes, 0);
    const family = sourceReservation({ captureUnits: 0, replacementUnits: 0, inputUnits: 0, replacementBytes: 0,
      frameBytes: HIGHLIGHT_LIMITS.dataWireBytes, decodedBytes: HIGHLIGHT_LIMITS.decodedBytes });
    const total = privateBytes + 2 * family;
    assert.ok(total <= CONTROLLER_LIMITS.transientBytes);
    console.log(JSON.stringify({ actualAdmission: { privateBytes, twoFramesAndDecodedWorkspace: 2 * family, total, authority: CONTROLLER_LIMITS.transientBytes } }));
  } finally { root.dispose(); for (const group of groups) group.release(); }
});

test('data budget: consumable peaks and shared charges cannot replenish allowance before final ownership ends', () => {
  const budget = new DataBudget(100), grant = budget.reserve(100)!;
  assert.equal(budget.reserve(1), undefined); const charge = grant.consume(40);
  assert.deepEqual(budget.stats(), { retainedBytes: 40, outstandingPeakBytes: 60, limit: 100, closed: false });
  grant.close(); grant.close(); assert.equal(budget.stats().outstandingPeakBytes, 0);
  assert.throws(() => grant.consume(1), /unfunded/); assert.throws(() => new DataGrant(budget, 100, {}), /foreign/);
  charge.retain(); charge.release(); assert.equal(budget.stats().retainedBytes, 40);
  charge.release(); charge.release(); assert.equal(budget.stats().retainedBytes, 0);
  const held = budget.reserve(50)!.consume(50); budget.close(); assert.equal(budget.reserve(1), undefined);
  held.release(); assert.equal(budget.stats().retainedBytes, 0);
  const replacement = new SemanticRetentionPool({ budget: new DataBudget(OCCIPITAL_LIMITS.retainedBytes) });
  assert.equal(replacement.admit('valid', 1, 'x').accepted, true);
  const same = replacement.budget; replacement.dispose();
  assert.equal(new SemanticRetentionPool({ budget: same }).admit('no-replenishment', 1, 'x').accepted, false);
});

test('data lifetime: capture metadata is independent of source size; removal receipts never return retained shared payload', () => {
  const rows: { textUnits: number; privateBytes: number; detachedBytes: number; actuallyFreed: number }[] = [];
  for (const text of ['x', 'x'.repeat(1024 * 1024)]) {
    const root = new SemanticRetentionPool(), g = root.admit('a', 1, text).generation!;
    root.installChunk(g, { ...chunk('a', g), complete: true, committed_bytes: text.length, source_bytes: text.length, runs: Uint32Array.of(text.length, 1) });
    const before = root.budget.stats().retainedBytes, capture = root.captureDisplays([g], () => true).group!, added = root.budget.stats().retainedBytes - before;
    assert.equal(added, capture.reservationBytes); const beforeRemoval = root.stats().retainedBytes, receipt = root.remove(g)[0]!;
    const detachedBytes = root.stats().retainedBytes; assert.ok(detachedBytes >= 2 * text.length);
    assert.equal(receipt.retainedBytes, beforeRemoval - detachedBytes); assert.ok(receipt.retainedBytes < beforeRemoval);
    assert.ok(receipt.attributedBytes > receipt.retainedBytes);
    rows.push({ textUnits: text.length, privateBytes: capture.reservationBytes, detachedBytes, actuallyFreed: receipt.retainedBytes });
    capture.release(); assert.equal(root.stats().retainedBytes, 0); root.dispose();
  }
  assert.equal(rows[0]!.privateBytes, rows[1]!.privateBytes);
  console.log(JSON.stringify({ sharedCaptureStorage: rows }));
});

function disposedWithPin() {
  const root = new SemanticRetentionPool(), g = root.admit('a', 1, 'x\nx').generation!; root.installChunk(g, chunk('a', g));
  const group = root.captureDisplays([g], () => true).group!, refs: { readonly id: number }[] = [];
  group.captures[0]!.visitContexts(ref => refs.push(ref)); const pin = root.arena.retain(refs, bytes => root.reserve(g, bytes).accepted)!;
  const budget = root.budget, weak = new WeakRef(root), arena = new WeakRef(root.arena);
  root.dispose(); assert.ok(budget.stats().retainedBytes > 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  return { group, pin, budget, weak, arena };
}
test('data lifetime: disposed root collects while held capture/pin owns exact charges; final cleanup needs no live root', async () => {
  const held = disposedWithPin(); await turn();
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!held.weak.deref()) break; }
  assert.equal(held.weak.deref(), undefined); assert.ok(held.arena.deref());
  const beforeCaptureRelease = held.budget.stats().retainedBytes; held.group.release();
  const pinned = held.budget.stats().retainedBytes; assert.ok(pinned > 0 && pinned < beforeCaptureRelease);
  held.pin.release(); assert.equal(held.budget.stats().retainedBytes, 0); held.group.release(); held.pin.release();
  assert.equal(held.budget.stats().retainedBytes, 0);
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!held.arena.deref()) break; }
  assert.equal(held.arena.deref(), undefined);
  console.log(JSON.stringify({ disposedOwnerGC: { rootCollected: true, beforeCaptureRelease, independentPinBytes: pinned, finalBytes: held.budget.stats().retainedBytes, arenaCollected: true } }));
});

test('data lifetime: failed descriptor/lease allocation and denied peaks restore grants and old ownership', () => {
  const arena = new ContextArena(), originalFreeze = Object.freeze, originalSlice = Uint32Array.prototype.slice;
  let copies = 0;
  Uint32Array.prototype.slice = function(...args: Parameters<typeof originalSlice>) { if (++copies === 2) throw new Error('controlled descriptor failure'); return originalSlice.apply(this, args); };
  try { assert.throws(() => arena.adopt(vocabulary, [[Uint32Array.of(1), Uint32Array.of(2)]], () => true), /descriptor failure/); }
  finally { Uint32Array.prototype.slice = originalSlice; }
  assert.equal(arena.budget.stats().retainedBytes, 0); assert.equal(arena.budget.stats().outstandingPeakBytes, 0);
  Object.freeze = new Proxy(originalFreeze, { apply(target, receiver, args) { if (Array.isArray(args[0])) throw new Error('controlled lease failure'); return Reflect.apply(target, receiver, args); } });
  try { assert.throws(() => arena.adopt(vocabulary, [[Uint32Array.of(1)]], () => true), /lease failure/); }
  finally { Object.freeze = originalFreeze; }
  assert.equal(arena.budget.stats().retainedBytes, 0); assert.equal(arena.stats().contexts, 0); assert.equal(arena.budget.stats().outstandingPeakBytes, 0);
  const live = arena.adopt(vocabulary, [[Uint32Array.of(1)]], () => true)!, before = arena.budget.stats();
  assert.equal(arena.adopt(vocabulary, [[Uint32Array.of(2)]], () => false), undefined); assert.deepEqual(arena.budget.stats(), before);
  live.release(); arena.dispose(); assert.equal(arena.budget.stats().retainedBytes, 0);
});

test('data lifetime: equal-text source versions retain the existing text holder and cached UTF8, not another source allocation', () => {
  const root = new SemanticRetentionPool(), text = 'a'.repeat(1024 * 1024), g = root.admit('a', 1, text).generation!, before = root.stats().retainedBytes;
  const byteLength = Buffer.byteLength; let utf8Calls = 0;
  Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => { utf8Calls++; return byteLength(...args); }) as typeof Buffer.byteLength;
  try { assert.equal(root.replaceSnapshot(g, 2, text.slice(0, -1) + 'a').accepted, true); }
  finally { Buffer.byteLength = byteLength; }
  assert.equal(utf8Calls, 0); assert.equal(root.stats().retainedBytes - before, 32, 'new snapshot record only; same owned text');
  assert.equal(root.borrowSnapshot(g)!.version, 2); assert.equal(root.borrowSnapshot(g)!.text, text);
  root.retainBasis(g); assert.equal(root.stats().retainedBytes, before); root.dispose(); assert.equal(root.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ sharedVersionText: { textUnits: text.length, extraRecordBytes: 32, utf8Calls, finalBytes: root.budget.stats().retainedBytes } }));
});

test('data lifetime: snapshot and grouped capture staging exceptions return every consumed charge and unused peak', () => {
  const root = new SemanticRetentionPool(), g = root.admit('a', 1, 'x\nx').generation!; root.installChunk(g, chunk('a', g));
  const before = root.stats(), status = root.status(g), freeze = Object.freeze;
  Object.freeze = new Proxy(freeze, { apply(target, receiver, args) {
    if (args[0] && typeof args[0] === 'object' && 'version' in args[0] && 'text' in args[0]) throw new Error('snapshot allocation failure');
    return Reflect.apply(target, receiver, args);
  } });
  try { assert.throws(() => root.replaceSnapshot(g, 2, 'x\nxx'), /snapshot allocation failure/); }
  finally { Object.freeze = freeze; }
  assert.deepEqual(root.stats(), before); assert.deepEqual(root.status(g), status); assert.equal(root.budget.stats().outstandingPeakBytes, 0);
  Object.freeze = new Proxy(freeze, { apply(target, receiver, args) {
    if (args[0] && typeof args[0] === 'object' && 'semanticStamp' in args[0] && 'generation' in args[0]) throw new Error('capture allocation failure');
    return Reflect.apply(target, receiver, args);
  } });
  try { assert.throws(() => root.captureDisplays([g], () => true), /capture allocation failure/); }
  finally { Object.freeze = freeze; }
  assert.deepEqual(root.stats(), before); assert.deepEqual(root.status(g), status); assert.equal(root.budget.stats().outstandingPeakBytes, 0);
  root.dispose(); assert.equal(root.budget.stats().retainedBytes, 0);
});

test('data lifetime: current range read invalidates immediately on removal but cannot reuse stack-owned charges until unwind', () => {
  const root = new SemanticRetentionPool(), g = root.admit('a', 1, 'x\nx').generation!; root.installChunk(g, chunk('a', g)); let calls = 0;
  assert.equal(root.visitRanges(g, () => {
    calls++; const before = root.budget.stats().retainedBytes, receipt = root.remove(g)[0]!;
    assert.ok(root.budget.stats().retainedBytes > 0); assert.equal(receipt.retainedBytes, before - root.budget.stats().retainedBytes);
    assert.equal(root.reserve(undefined, root.stats().maxBytes).accepted, false);
  }), false);
  assert.equal(calls, 1); assert.equal(root.budget.stats().retainedBytes, 0);
  assert.equal(root.reserve(undefined, root.stats().maxBytes).accepted, true); root.dispose();
});


test('data lifetime: bridge replacement invalidates the read before it can borrow successor lines', () => {
  const root = new SemanticRetentionPool(), original = 'old:first\nold:second';
  const generation = root.admit('a', 1, original).generation!, seen: number[] = [];
  assert.equal(installProjection(root, generation, 1, original, ['old:first', '\x1b[31mold:second']).accepted, true);
  const replacement = ['new:first', 'successor:' + 'x'.repeat(8192)], text = replacement.join('\n');
  try {
    const valid = visitProjection(root, generation, (start, end) => {
      seen.push(start);
      if (seen.length === 1) {
        assert.equal(end, 'old:first\n'.length);
        assert.equal(root.replaceSnapshot(generation, 2, text).accepted, true);
        assert.equal(installProjection(root, generation, 2, text, [replacement[0]!, '\x1b[31m' + replacement[1]!]).accepted, true);
      } else {
        root.remove(generation);
        const retained = root.budget.stats().retainedBytes;
        console.log(JSON.stringify({ successorBridgeBorrow: { retained } }));
        assert.ok(retained > 0, 'successor range was borrowed without retaining its charge');
        assert.fail('a bridge read followed its replacement');
      }
    });
    assert.equal(valid, false);
    assert.deepEqual(seen, [0]);
    assert.equal(root.bridgeVersion(generation), 2);
    assert.deepEqual(projectionRanges(root, generation), [[0, replacement[0]!.length + 1, 0], [replacement[0]!.length + 1, Buffer.byteLength(text), 1]]);
  } finally { root.dispose(); }
  assert.equal(root.budget.stats().retainedBytes, 0);
});

test('data lifetime: bridge removal and throwing consumers retain the borrowed line until unwind', () => {
  for (const throwing of [false, true]) {
    const root = new SemanticRetentionPool(), text = 'borrowed:' + 'x'.repeat(8192);
    const generation = root.admit('a', 1, text).generation!, stop = new Error('consumer stopped');
    assert.equal(installProjection(root, generation, 1, text, [text]).accepted, true);
    let calls = 0;
    const payloadBytes = root.stats().bridgeBytes; assert.ok(payloadBytes > 0);
    const read = () => visitProjection(root, generation, (start, end) => {
      calls++;
      root.remove(generation);
      assert.equal(start, 0); assert.equal(end, Buffer.byteLength(text));
      assert.equal(root.budget.stats().retainedBytes, payloadBytes);
      assert.equal(root.budget.reserve(root.budget.limit), undefined, 'cannot reuse bytes still on the read stack');
      if (throwing) throw stop;
    });
    try {
      if (throwing) assert.throws(read, error => error === stop);
      else assert.equal(read(), false);
      assert.equal(calls, 1);
      assert.equal(root.budget.stats().retainedBytes, 0);
      assert.equal(root.budget.stats().outstandingPeakBytes, 0);
      const full = root.budget.reserve(root.budget.limit);
      assert.ok(full, 'all capacity returns after the read unwinds'); full.close();
    } finally { root.dispose(); }
  }
});
