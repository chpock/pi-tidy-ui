import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { DataBudget, DataGrant, type DataGrantFactory } from '../../../src/occipital/data-budget.ts';
import { measure, reflow } from '../../../src/syntax/measured-rows.ts';
import { paintFlat } from '../../../src/syntax/flat-paint.ts';
const neutral = { open: '', close: '' };
async function collect(weak: WeakRef<object>) {
  for (let pass = 0; pass < 40; pass++) { await turn(); global.gc!(); await turn(); if (!weak.deref()) return; }
  assert.fail('mandatory payload GC failed');
}
function probe() {
  const budget = new DataBudget(1_000_000), Original = globalThis.Uint32Array, ArrayOriginal = globalThis.Array;
  const vectors: WeakRef<object>[] = [], buffers: WeakRef<object>[] = []; let rowArray: WeakRef<object> | undefined;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { const value = Reflect.construct(target, args); vectors.push(new WeakRef(value)); buffers.push(new WeakRef(value.buffer)); return value; } });
  let measured: NonNullable<ReturnType<typeof measure>>, layout: NonNullable<ReturnType<typeof reflow>>;
  try { measured = measure('first\t界', budget)!; } finally { globalThis.Uint32Array = Original; }
  const measurement = vectors.at(-1)!, measurementBuffer = buffers.at(-1)!; vectors.length = buffers.length = 0;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { const value = Reflect.construct(target, args); vectors.push(new WeakRef(value)); buffers.push(new WeakRef(value.buffer)); return value; } });
  try { layout = reflow(measured!, { mode: 'bash', width: 3 })!; } finally { globalThis.Uint32Array = Original; }
  globalThis.Array = new Proxy(ArrayOriginal, { construct(target, args) { const value = Reflect.construct(target, args); rowArray ??= new WeakRef(value); return value; } });
  let painted: NonNullable<ReturnType<typeof paintFlat>>;
  try { painted = paintFlat('first\t界', measured!, layout!, () => true, neutral, neutral, 0, budget)!; } finally { globalThis.Array = ArrayOriginal; }
  const owners: { measured?: typeof measured; layout?: typeof layout; painted?: typeof painted } = { measured: measured!, layout: layout!, painted: painted! };
  const weak = [new WeakRef(measured!), new WeakRef(layout!), new WeakRef(painted!)];
  return { budget, owners, weak, payloads: [measurement, ...vectors.slice(-2), rowArray!], buffers: [measurementBuffer, ...buffers.slice(-2)], receipts: [measured!.cleanupReceipt(), layout!.cleanupReceipt(), painted!.cleanupReceipt()] };
}
test('geometry cleanup: detached receipts survive real handle and payload collection without retaining them', async () => {
  const held = probe(); await turn(); global.gc!();
  for (const payload of [...held.payloads, ...held.buffers]) assert.ok(payload.deref(), 'live-owner positive physical payload control');
  const retained = held.budget.stats().retainedBytes; assert.ok(retained > 0);
  held.owners.measured = held.owners.layout = held.owners.painted = undefined;
  for (const owner of held.weak) await collect(owner);
  for (const payload of [...held.payloads, ...held.buffers]) await collect(payload);
  for (const receipt of held.receipts) { receipt.release(); receipt.release(); }
  console.log(JSON.stringify({ geometryOwnerLeak: { actualPayloadsCollected: held.payloads.length, backingBuffersCollected: held.buffers.length, before: retained, afterDetachedCleanup: held.budget.stats().retainedBytes } }));
  assert.equal(held.budget.stats().retainedBytes, 0, 'collected payload must return credit through detached cleanup');
});

test('geometry funding: optional operation factory observes every reservation including lookup and retained output', () => {
  const budget = new DataBudget(1_000_000); let calls = 0, inside = false;
  const reserve = DataBudget.prototype.reserve;
  DataBudget.prototype.reserve = function(bytes) { if (this === budget) assert.ok(inside, 'every allocation must use the supplied factory'); return reserve.call(this, bytes); };
  const grant = (bytes: number) => { calls++; inside = true; try { return budget.reserve(bytes); } finally { inside = false; } };
  try {
  const measured = measure('x\t界'.repeat(20), budget, grant)!; assert.ok(calls > 5);
  const before = calls, layout = reflow(measured, { mode: 'bash', width: 3 }, grant)!; assert.ok(calls > before);
  const lookup = calls; assert.equal(layout.withLookup(measured, read => assert.ok(read.isValid), grant), true); assert.ok(calls > lookup);
  const paint = calls, painted = paintFlat('x\t界'.repeat(20), measured, layout, () => true, neutral, neutral, 0, budget, grant)!; assert.ok(calls > paint);
  const retain = calls, copy = painted.retain(grant)!; assert.ok(calls > retain);
  copy.dispose(); painted.dispose(); layout.dispose(); measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ geometryHookCoverage: { calls, measureCalls: before, reflowCalls: lookup - before, lookupCalls: paint - lookup, paintCalls: retain - paint, retainCalls: calls - retain } }));
  } finally { DataBudget.prototype.reserve = reserve; }
});

function make(budget = new DataBudget(1_000_000), funding?: DataGrantFactory) {
  const text = 'old\t界\nnext', measured = measure(text, budget, funding)!, layout = reflow(measured, { mode: 'bash', width: 3 }, funding)!;
  const paint = (grant?: DataGrantFactory) => paintFlat(text, measured, layout, () => true, neutral, neutral, 0, budget, grant);
  const output = paint(funding)!;
  return { budget, measured, layout, output, paint, dispose() { output.dispose(); layout.dispose(); measured.dispose(); } };
}
function rows(output: NonNullable<ReturnType<typeof paintFlat>>) {
  const values: string[] = []; assert.equal(output.visitRows((_i, text) => values.push(text)), true); return values;
}
test('geometry funding: every denial, throw, foreign and undersized grant closes returned grants and preserves useful old data', () => {
  const f = make(), before = f.budget.stats(), expected = rows(f.output), foreign = new DataBudget(1_000_000);
  const operations = [
    (grant: DataGrantFactory) => measure('candidate\t界'.repeat(20), f.budget, grant),
    (grant: DataGrantFactory) => reflow(f.measured, { mode: 'file', width: 2 }, grant),
    (grant: DataGrantFactory) => f.layout.withLookup(f.measured, read => assert.ok(read.isValid), grant),
    (grant: DataGrantFactory) => f.paint(grant),
    (grant: DataGrantFactory) => f.output.retain(grant),
  ];
  let denied = 0, thrown = 0, rejected = 0, returned = 0, closed = 0;
  for (const operation of operations) {
    let count = 0;
    const result = operation(bytes => { count++; return f.budget.reserve(bytes); });
    if (result && typeof result === 'object') result.dispose();
    assert.deepEqual(f.budget.stats(), before);
    for (const behavior of ['deny', 'throw', 'foreign', 'small'] as const) for (let target = 1; target <= count; target++) {
      let calls = 0;
      const grants: DataGrant[] = [], closeCounts = new Map<DataGrant, number>(), close = DataGrant.prototype.close;
      DataGrant.prototype.close = function() { if (grants.includes(this)) closeCounts.set(this, (closeCounts.get(this) ?? 0) + 1); return close.call(this); };
      const grant: DataGrantFactory = bytes => {
        const hit = ++calls === target;
        if (hit && behavior === 'deny') return undefined;
        if (hit && behavior === 'throw') throw new Error('controlled funding callback');
        const value = hit && behavior === 'foreign' ? foreign.reserve(bytes + 17) : f.budget.reserve(hit && behavior === 'small' ? bytes - 1 : bytes + 17);
        assert.ok(value); grants.push(value); return value;
      };
      try {
        if (behavior === 'deny') { assert.ok(!operation(grant)); denied++; }
        else { assert.throws(() => operation(grant), behavior === 'throw' ? /controlled funding callback/ : behavior === 'foreign' ? /foreign.*grant/ : /unfunded/); if (behavior === 'throw') thrown++; else rejected++; }
        for (const value of grants) { assert.equal(closeCounts.get(value), 1); assert.throws(() => value.consume(1), /unfunded/); }
        returned += grants.length; closed += closeCounts.size;
      } finally { DataGrant.prototype.close = close; }
      assert.deepEqual(f.budget.stats(), before); assert.equal(foreign.stats().retainedBytes, 0); assert.equal(foreign.stats().outstandingPeakBytes, 0);
      assert.ok(f.measured.isValid && f.layout.isValid && f.output.isValid); assert.deepEqual(rows(f.output), expected);
    }
  }
  f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ geometryAdversarialGrants: { denied, thrown, rejected, returned, closed, finalBytes: f.budget.stats().retainedBytes } }));
});

test('geometry funding: operation pressure releases only unrelated data and preserves useful geometry without remeasurement', () => {
  const f = make(new DataBudget(30_000)), expected = rows(f.output), before = f.budget.stats().retainedBytes;
  let unrelated = f.budget.reserve(f.budget.limit - before)!.consume(f.budget.limit - before), pressureReleases = 0, calls = 0, peak = 0;
  const segment = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = () => { throw new Error('useful measurement was repeated'); };
  const grant: DataGrantFactory = bytes => {
    calls++; let candidate = f.budget.reserve(bytes);
    if (!candidate) { unrelated.release(); pressureReleases++; candidate = f.budget.reserve(bytes); }
    const stats = f.budget.stats(); peak = Math.max(peak, stats.retainedBytes + stats.outstandingPeakBytes); assert.ok(peak <= f.budget.limit);
    return candidate;
  };
  let layout: ReturnType<typeof reflow>, output: ReturnType<typeof paintFlat>;
  try {
    layout = reflow(f.measured, { mode: 'bash', width: 3 }, grant)!;
    output = paintFlat('old\t界\nnext', f.measured, layout, () => true, neutral, neutral, 0, f.budget, grant)!;
    assert.deepEqual(rows(output), expected); assert.deepEqual(rows(f.output), expected);
    assert.ok(f.measured.isValid && f.layout.isValid); assert.equal(pressureReleases, 1);
  } finally { Intl.Segmenter.prototype.segment = segment; output?.dispose(); layout?.dispose(); unrelated.release(); }
  f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ geometryPressure: { pressureReleases, calls, peak, finalBytes: f.budget.stats().retainedBytes } }));
});

function hookOwned() {
  const owner = { root: {} }, weak = new WeakRef(owner), budget = new DataBudget(1_000_000);
  const funding: DataGrantFactory = bytes => { void owner.root; return budget.reserve(bytes); }, callback = new WeakRef(funding);
  const f = make(budget, funding), copy = f.output.retain(funding)!;
  return { f, copy, weak, callback };
}
test('geometry cleanup: operation hook and its root collect while every returned owner and detached receipt remains live', async () => {
  const held = hookOwned(), receipts = [held.f.measured.cleanupReceipt(), held.f.layout.cleanupReceipt(), held.f.output.cleanupReceipt(), held.copy.cleanupReceipt()];
  await collect(held.weak); await collect(held.callback);
  assert.ok(held.f.measured.isValid && held.f.layout.isValid && held.f.output.isValid && held.copy.isValid);
  for (const receipt of receipts) receipt.release(); held.f.dispose(); held.copy.dispose();
  assert.equal(held.f.budget.stats().retainedBytes, 0);
});

test('geometry cleanup: receipt/dispose orders share exactly one owner token for geometry and retained paint', () => {
  for (const measuredFirst of [false, true]) for (const receiptFirst of [false, true]) {
    const f = make(); f.output.dispose();
    const first = measuredFirst ? f.measured : f.layout, second = measuredFirst ? f.layout : f.measured;
    const firstReceipt = first.cleanupReceipt(), secondReceipt = second.cleanupReceipt();
    assert.equal(first.cleanupReceipt(), firstReceipt);
    if (receiptFirst) firstReceipt.release(); else first.dispose();
    firstReceipt.release(); first.dispose(); assert.equal(f.budget.stats().retainedBytes, second.allocationBytes);
    if (receiptFirst) second.dispose(); else secondReceipt.release();
    second.dispose(); secondReceipt.release(); assert.equal(f.budget.stats().retainedBytes, 0);
  }
  for (const copyFirst of [false, true]) for (const receiptFirst of [false, true]) {
    const f = make(), copy = f.output.retain()!; f.measured.dispose(); f.layout.dispose();
    const first = copyFirst ? copy : f.output, second = copyFirst ? f.output : copy;
    const firstReceipt = first.cleanupReceipt(), secondReceipt = second.cleanupReceipt();
    if (receiptFirst) firstReceipt.release(); else first.dispose();
    first.dispose(); firstReceipt.release(); assert.ok(second.visitRows(() => {}));
    assert.equal(f.budget.stats().retainedBytes, second.allocationBytes);
    if (receiptFirst) second.dispose(); else secondReceipt.release();
    second.dispose(); secondReceipt.release(); firstReceipt.release();
    assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
  }
});

function sharedProbe() {
  const held = probe(), first = held.owners.painted!, before = held.budget.stats().retainedBytes;
  const copy = first.retain()!, metadataBytes = held.budget.stats().retainedBytes - before;
  held.owners.measured!.dispose(); held.owners.layout!.dispose();
  return { budget: held.budget, owners: { first: first as typeof first | undefined, copy: copy as typeof copy | undefined },
    first: held.weak[2]!, copy: new WeakRef(copy), payload: held.payloads[3]!, metadataBytes,
    receipts: [first.cleanupReceipt(), copy.cleanupReceipt()] };
}
test('geometry cleanup: receipts retain shared charges but not row payload after both output owners collect', async () => {
  const held = sharedProbe(); await turn(); global.gc!(); assert.ok(held.payload.deref(), 'two live output holders keep the actual row array');
  held.owners.first = undefined; await collect(held.first); assert.ok(held.payload.deref(), 'retained output still owns payload');
  const before = held.budget.stats().retainedBytes;
  held.receipts[0]!.release(); held.receipts[0]!.release();
  assert.equal(held.budget.stats().retainedBytes, before - held.metadataBytes);
  assert.ok(held.owners.copy!.visitRows(() => {}));
  held.owners.copy = undefined; await collect(held.copy); await collect(held.payload);
  assert.ok(held.budget.stats().retainedBytes > 0, 'the final receipt holds numeric charge ownership, not payload');
  held.receipts[1]!.release(); held.receipts[1]!.release(); held.receipts[0]!.release();
  assert.equal(held.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ sharedPaintCleanup: { metadataBytes: held.metadataBytes, bothOwnersAndArrayCollected: true, finalBytes: held.budget.stats().retainedBytes } }));
});

test('geometry cleanup: funding reentrancy releases owner tokens but cannot spend lookup, reflow or retain pins', () => {
  let witnesses = 0, finalBytes = -1;
  for (const operation of ['lookup', 'reflow', 'paint', 'retain'] as const) for (const throws of [false, true]) {
    const held = probe(), { measured, layout, painted } = held.owners;
    assert.ok(measured && layout && painted);
    if (operation === 'retain') { measured.dispose(); layout.dispose(); }
    else { painted.dispose(); if (operation === 'reflow') layout.dispose(); }
    const before = held.budget.stats().retainedBytes;
    let calls = 0, paintWorkspace = 0;
    const funding: DataGrantFactory = bytes => {
      calls++; if (operation === 'paint' && calls === 1) paintWorkspace = bytes;
      if (calls !== (operation === 'paint' ? 2 : 1)) return held.budget.reserve(bytes);
      held.receipts[0]!.release(); held.receipts[1]!.release(); held.receipts[2]!.release();
      global.gc!();
      assert.equal(held.budget.stats().retainedBytes, before + paintWorkspace, 'all actual borrowed ownership stays charged');
      const payloads = operation === 'retain' ? held.payloads.slice(3) : operation === 'reflow' ? held.payloads.slice(0, 1) : held.payloads.slice(0, 3);
      for (const payload of payloads) assert.ok(payload.deref(), 'actual operation-held array remains live');
      assert.equal(held.budget.reserve(held.budget.limit), undefined);
      if (throws) throw new Error('funding reentrant throw');
      return held.budget.reserve(bytes);
    };
    const run = () => operation === 'lookup' ? layout.withLookup(measured, () => assert.fail('invalidated lookup callback'), funding)
      : operation === 'reflow' ? reflow(measured, { mode: 'file', width: 2 }, funding)
      : operation === 'paint' ? paintFlat('first\t界', measured, layout, () => true, neutral, neutral, 0, held.budget, funding)
      : painted.retain(funding);
    if (throws) assert.throws(run, /funding reentrant throw/); else assert.ok(!run());
    measured.dispose(); layout.dispose(); painted.dispose();
    assert.equal(held.budget.stats().retainedBytes, 0); assert.equal(held.budget.stats().outstandingPeakBytes, 0); finalBytes = held.budget.stats().retainedBytes; witnesses++;
  }
  console.log(JSON.stringify({ geometryFundingPins: { witnesses, finalBytes } }));
});

test('geometry cleanup: receipt release inside each numeric visitor invalidates immediately and survives throwing callbacks', () => {
  for (const kind of ['glyphs', 'rows', 'spans', 'lookup'] as const) for (const throws of [false, true]) {
    const f = make(); f.output.dispose(); let callbacks = 0;
    const callback = () => {
      callbacks++; f.measured.cleanupReceipt().release(); f.layout.cleanupReceipt().release();
      assert.ok(f.budget.stats().retainedBytes > 0); assert.equal(f.budget.reserve(f.budget.limit), undefined);
      if (throws) throw new Error('receipt visitor throw');
    };
    const run = () => kind === 'glyphs' ? f.measured.visitGlyphs(0, f.measured.glyphCount, callback)
      : kind === 'rows' ? f.layout.visitRows(callback) : kind === 'spans' ? f.layout.visitSpans(0, callback)
      : f.layout.withLookup(f.measured, read => { callback(); assert.equal(read.isValid, false); assert.throws(() => read.glyphByte(0), /stale/); });
    if (throws) assert.throws(run, /receipt visitor throw/); else assert.equal(run(), false);
    assert.equal(callbacks, 1); f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  }
});

test('geometry cleanup: nested output retains and receipt releases keep actual rows charged until all callback unwind', () => {
  let witnesses = 0, finalBytes = -1;
  for (const throws of [false, true]) {
    const held = probe(), output = held.owners.painted!; held.owners.measured!.dispose(); held.owners.layout!.dispose();
    let callbacks = 0, nestedCallbacks = 0;
    const run = () => output.visitRows(() => {
      callbacks++; const copy = output.retain()!, copyReceipt = copy.cleanupReceipt();
      held.receipts[2]!.release(); assert.equal(output.isValid, false); assert.ok(copy.isValid);
      const nested = () => copy.visitRows(() => {
        nestedCallbacks++; copyReceipt.release(); copy.dispose(); held.receipts[2]!.release(); global.gc!();
        assert.ok(held.payloads[3]!.deref()); assert.ok(held.budget.stats().retainedBytes > 0);
        assert.equal(held.budget.reserve(held.budget.limit), undefined);
        if (throws) throw new Error('nested row throw');
      });
      if (throws) assert.throws(nested, /nested row throw/); else assert.equal(nested(), false);
      assert.ok(held.budget.stats().retainedBytes > 0, 'outer callback still pins the physical store');
      if (throws) throw new Error('outer row throw');
    });
    if (throws) assert.throws(run, /outer row throw/); else assert.equal(run(), false);
    assert.equal(callbacks, 1); assert.equal(nestedCallbacks, 1); assert.equal(held.budget.stats().retainedBytes, 0); finalBytes = held.budget.stats().retainedBytes; witnesses++;
  }
  console.log(JSON.stringify({ geometryNestedOutputPins: { witnesses, finalBytes } }));
});

test('geometry funding: store admission after lookup rejects receipt invalidation without hiding real callback errors', () => {
  for (const victim of ['measurement', 'layout', 'both'] as const) for (const throws of [false, true]) {
    const f = make(), expected = rows(f.output), failure = new Error('store funding callback failure');
    let calls = 0, rangeReads = 0;
    const funding: DataGrantFactory = bytes => {
      if (++calls === 3) {
        if (victim !== 'layout') f.measured.cleanupReceipt().release();
        if (victim !== 'measurement') f.layout.cleanupReceipt().release();
        if (throws) throw failure;
      }
      return f.budget.reserve(bytes);
    };
    const run = () => paintFlat('old\t界\nnext', f.measured, f.layout, () => { rangeReads++; return true; }, neutral, neutral, 0, f.budget, funding);
    try {
      if (throws) assert.throws(run, error => error === failure, 'funding callback failures remain visible');
      else {
        let candidate: ReturnType<typeof paintFlat>;
        assert.doesNotThrow(() => { candidate = run(); }, 'invalidated geometry is a normal candidate refusal');
        assert.equal(candidate, undefined);
      }
      assert.equal(calls, 3); assert.equal(rangeReads, 0);
      assert.ok(f.output.isValid); assert.deepEqual(rows(f.output), expected);
      assert.equal(f.budget.stats().outstandingPeakBytes, 0);
    } finally { f.dispose(); }
    assert.equal(f.budget.stats().retainedBytes, 0);
  }
});
