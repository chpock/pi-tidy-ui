import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { RenderCache, type CacheEntry } from '../../../src/render-cache.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { measure, reflow } from '../../../src/syntax/measured-rows.ts';
import { paintFlat, type FlatPaintRows } from '../../../src/syntax/flat-paint.ts';

const neutral = { open: '', close: '' };
function rows(painted: FlatPaintRows): string[] {
  const result: string[] = [];
  assert.equal(painted.visitRows((_index, row) => result.push(row)), true);
  return result;
}
function prepare(budget: DataBudget, text = 'cache\t界') {
  const measured = measure(text, budget)!, layout = reflow(measured, { mode: 'bash', width: 5 })!;
  const painted = paintFlat(text, measured, layout, () => true, neutral, neutral, 0, budget)!;
  layout.dispose(); measured.dispose();
  return painted;
}
async function collect(weak: WeakRef<object>) {
  for (let pass = 0; pass < 40; pass++) {
    await turn(); global.gc!(); await turn();
    if (!weak.deref()) return;
  }
  assert.fail('cache owner/payload must collect');
}

const adopted = (cache: RenderCache, painted: FlatPaintRows) => cache.put(painted, rows(painted), 'bash', painted.cleanupReceipt());

test('geometry cache: explicit drop clears the funded owner once and preserves normal cache statistics', () => {
  const cache = new RenderCache(), budget = new DataBudget(100_000), painted = prepare(budget);
  const entry = adopted(cache, painted);
  assert.equal(cache.get(entry), painted); assert.ok(budget.stats().retainedBytes > 0);
  cache.drop(entry);
  assert.equal(painted.isValid, false); assert.equal(entry.value, undefined); assert.equal(budget.stats().retainedBytes, 0);
  cache.drop(entry); cache.clear(); painted.dispose();
  const stats = cache.stats(); assert.equal(stats.entries, 0); assert.equal(stats.releases, 1); assert.equal(stats.collected, 0);
  assert.equal(cache.get(entry), undefined); assert.equal(budget.stats().outstandingPeakBytes, 0);
});

test('geometry cache: failed replacement leaves old output; complete replacement and clear release distinct owners', () => {
  const cache = new RenderCache(), budget = new DataBudget(100_000), old = prepare(budget);
  const previous = adopted(cache, old), expected = rows(old), before = budget.stats().retainedBytes;
  const measured = measure('replacement', budget)!, layout = reflow(measured, { mode: 'file', width: 4 })!;
  assert.equal(paintFlat('replacement', measured, layout, () => true, neutral, neutral, 0, budget, () => undefined), undefined);
  layout.dispose(); measured.dispose();
  assert.equal(cache.get(previous), old); assert.deepEqual(rows(old), expected); assert.equal(budget.stats().retainedBytes, before);
  const next = prepare(budget, 'new\t界'), current = adopted(cache, next);
  cache.drop(previous); assert.ok(cache.get(current)?.isValid); assert.equal(old.isValid, false);
  assert.equal(cache.stats().entries, 1);
  cache.clear(); cache.clear(); assert.equal(current.value, undefined); assert.equal(next.isValid, false);
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(cache.stats().releases, 2);
});

test('geometry cache: independent retained handles share output credit through separate entry release', () => {
  const cache = new RenderCache(), budget = new DataBudget(100_000), first = prepare(budget);
  const expected = rows(first), single = budget.stats().retainedBytes, second = first.retain()!;
  assert.ok(budget.stats().retainedBytes > single);
  const a = adopted(cache, first), b = adopted(cache, second);
  cache.drop(a); assert.equal(first.isValid, false); assert.equal(second.isValid, true);
  assert.equal(budget.stats().retainedBytes, single, 'shared rows remain charged exactly once with one handle');
  assert.deepEqual(rows(cache.get(b)!), expected);
  cache.drop(b); assert.equal(budget.stats().retainedBytes, 0);
});

function abandoned(cache: RenderCache, budget: DataBudget) {
  const text = 'cache\t界', measured = measure(text, budget)!, layout = reflow(measured, { mode: 'bash', width: 5 })!;
  const Original = globalThis.Array;
  let payload: WeakRef<object> | undefined;
  globalThis.Array = new Proxy(Original, { construct(target, args) {
    const value = Reflect.construct(target, args); payload ??= new WeakRef(value); return value;
  } });
  let painted: FlatPaintRows;
  try { painted = paintFlat(text, measured, layout, () => true, neutral, neutral, 0, budget)!; }
  finally { globalThis.Array = Original; layout.dispose(); measured.dispose(); }
  const entry = adopted(cache, painted!);
  const ownership: { entry?: CacheEntry<FlatPaintRows> } = { entry };
  return { ownership, entry: new WeakRef(entry), painted: new WeakRef(painted!), payload: payload! };
}

test('geometry cache: existing finalizer releases credit after actual entry, owner and row collection', async () => {
  const cache = new RenderCache(), budget = new DataBudget(100_000), weak = abandoned(cache, budget);
  await turn(); global.gc!(); await turn();
  assert.ok(weak.entry.deref() && weak.painted.deref() && weak.payload.deref(), 'live cache entry owns actual painted rows');
  assert.ok(budget.stats().retainedBytes > 0);
  weak.ownership.entry = undefined;
  await collect(weak.entry); await collect(weak.painted); await collect(weak.payload);
  for (let pass = 0; pass < 40 && budget.stats().retainedBytes; pass++) { await turn(); global.gc!(); await turn(); }
  assert.equal(budget.stats().retainedBytes, 0, 'automatic cleanup, without calling cache.stats() to trigger sweeping');
  assert.equal(cache.stats().collected, 1); assert.equal(cache.stats().entries, 0);
});

test('geometry cache: dead-entry sweeping releases detached credit before delayed finalizer; late callback is idempotent', async () => {
  const Original = globalThis.FinalizationRegistry, pending: (() => void)[] = [];
  class DelayedRegistry<T> extends Original<T> {
    constructor(callback: (held: T) => void) { super(held => pending.push(() => callback(held))); }
  }
  let cache: RenderCache;
  globalThis.FinalizationRegistry = DelayedRegistry;
  try { cache = new RenderCache(); } finally { globalThis.FinalizationRegistry = Original; }
  const budget = new DataBudget(100_000), weak = abandoned(cache!, budget);
  weak.ownership.entry = undefined;
  await collect(weak.entry); await collect(weak.painted); await collect(weak.payload);
  assert.ok(budget.stats().retainedBytes > 0, 'the delayed registry still holds numeric ownership');
  assert.equal(cache!.stats().entries, 0); assert.equal(budget.stats().retainedBytes, 0);
  for (const callback of pending) callback();
  assert.equal(cache!.stats().releases, 1); assert.equal(cache!.stats().collected, 1);
  cache!.clear(); assert.equal(budget.stats().retainedBytes, 0);
});

for (const throws of [false, true]) test(`geometry cache: drop inside pinned output visitor preserves credit through unwind (throws=${throws})`, () => {
  const cache = new RenderCache(), budget = new DataBudget(100_000), painted = prepare(budget), entry = adopted(cache, painted);
  const failure = new Error('reader callback failure'); let visits = 0;
  const read = () => painted.visitRows(() => {
    visits++; cache.drop(entry);
    assert.equal(painted.isValid, false); assert.equal(entry.value, undefined);
    assert.ok(budget.stats().retainedBytes > 0, 'physical callback-held rows remain charged');
    assert.equal(budget.reserve(budget.limit), undefined);
    if (throws) throw failure;
  });
  try { if (throws) assert.throws(read, error => error === failure); else assert.equal(read(), false); }
  finally { cache.clear(); painted.dispose(); }
  assert.equal(visits, 1); assert.equal(budget.stats().retainedBytes, 0);
});
