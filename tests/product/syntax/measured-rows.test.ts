import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { visibleWidth as piWidth } from '@earendil-works/pi-tui';

const widthKey = Symbol.for('test.measured-rows.width');
const hooks = globalThis as typeof globalThis & { [widthKey]?: (text: string) => void };
const widthModule = 'data:text/javascript,' + encodeURIComponent(`import { visibleWidth as original } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))}; export function visibleWidth(text) { globalThis[Symbol.for('test.measured-rows.width')]?.(text); return original(text); }`);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-tui' && context.parentURL?.endsWith('/src/syntax/measured-rows.ts')) return { url: widthModule, shortCircuit: true };
  return next(specifier, context);
} });
const { measure, prepareMeasuredAppend, reflow, GlyphFlag, SpanKind } = await import('../../../src/syntax/measured-rows.ts');
loader.deregister();
type Measured = NonNullable<ReturnType<typeof measure>>;
type Layout = NonNullable<ReturnType<typeof reflow>>;
function rows(text: string, measured: Measured, layout: Layout): string[] {
  const result: string[] = [];
  assert.equal(layout.visitRows((row, columns) => {
    let output = '';
    assert.equal(layout.visitSpans(row, (kind, first, end, cells, offset) => {
      if (kind === SpanKind.Source) {
        let start = -1, stop = -1;
        assert.equal(measured.visitGlyphs(first, end, (_index, a, b) => { if (start < 0) start = a; stop = b; }), true);
        output += text.slice(start, stop);
      } else if (kind === SpanKind.Tab) output += ' '.repeat(cells);
      else if (kind === SpanKind.Replacement) output += '�';
      else output += '$ '.slice(offset, offset + cells);
    }), true);
    assert.ok(columns >= 0); result.push(output);
  }), true);
  return result;
}
function project(text: string, mode: 'file' | 'bash', width: number) {
  const budget = new DataBudget(1_000_000), measured = measure(text, budget)!;
  const layout = reflow(measured, { mode, width })!;
  try { return rows(text, measured, layout); }
  finally { layout.dispose(); measured.dispose(); assert.equal(budget.stats().retainedBytes, 0); }
}

test('measured rows: exact file words, spaces, original logical tab stops and newlines', () => {
  assert.deepEqual(project('abc def ghi', 'file', 6), ['abc ', 'def ', 'ghi']);
  assert.deepEqual(project('a\tb\tc', 'file', 3), ['a  ', ' b ', '  c']);
  assert.deepEqual(project('  a  ', 'file', 3), ['  ', 'a  ']);
  assert.deepEqual(project('a\n\n界\n', 'file', 2), ['a', '', '界', '']);
  assert.deepEqual(project('', 'file', 1), ['']);
  const tabs = [[' ', ' ', ' ', ' ', 'X'], ['  ', '  ', 'X'], ['   ', ' X'], ['    ', 'X'], ['    X'], ['    X']];
  for (let width = 1; width <= 6; width++) assert.deepEqual(project('\tX', 'file', width), tabs[width - 1]);
  assert.deepEqual(project('界\tX', 'file', 1), ['�', ' ', ' ', 'X']);
});

test('measured rows: exact Bash prompt, visual tab stops, split tabs and newline reset', () => {
  assert.deepEqual(project('a\tb', 'bash', 4), ['$ a ', '    ', 'b']);
  assert.deepEqual(project('abc\td', 'bash', 3), ['$ a', 'bc ', '   ', '  d']);
  assert.deepEqual(project('a\n\tb', 'bash', 4), ['$ a', '    ', '    ', 'b']);
  assert.deepEqual(project('', 'bash', 1), ['$', ' ']);
  assert.deepEqual(project('a\n', 'bash', 4), ['$ a', '']);
  const tabs = [['$', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', 'X'], ['$ ', '  ', '  ', '  ', 'X'], ['$  ', '   ', '  X'], ['$   ', '    ', 'X'], ['$    ', '   X'], ['$     ', '  X']];
  for (let width = 1; width <= 6; width++) assert.deepEqual(project('\tX', 'bash', width), tabs[width - 1]);
});

test('measured rows: widths one through six retain whole CJK, combining, ZWJ and emoji glyphs', () => {
  const source = '界é👩‍💻🙂';
  const expected = [['�', 'é', '�', '�'], ['界', 'é', '👩‍💻', '🙂'], ['界é', '👩‍💻', '🙂'], ['界é', '👩‍💻🙂'], ['界é👩‍💻', '🙂'], ['界é👩‍💻', '🙂']];
  for (let width = 1; width <= 6; width++) assert.deepEqual(project(source, 'file', width), expected[width - 1]);
  for (let width = 1; width <= 6; width++) assert.equal(project(source, 'bash', width).join(''), '$ ' + (width === 1 ? '�é��' : source));
  assert.deepEqual(project('anything', 'bash', 0), []);
});

test('measured rows: original UTF16/UTF8 endpoints and flags, not expanded tab coordinates', () => {
  const budget = new DataBudget(100_000), measured = measure('A\t界é👩‍💻\n', budget)!;
  const actual: number[][] = [];
  measured.visitGlyphs(0, measured.glyphCount, (...values) => actual.push(values));
  assert.deepEqual(actual, [
    [0, 0, 1, 0, 1, 1, 0], [1, 1, 2, 1, 2, 0, GlyphFlag.Whitespace | GlyphFlag.Tab],
    [2, 2, 3, 2, 5, 2, 0], [3, 3, 5, 5, 8, 1, 0], [4, 5, 10, 8, 19, 2, 0],
    [5, 10, 11, 19, 20, 0, GlyphFlag.Whitespace | GlyphFlag.Newline],
  ]);
  const layout = reflow(measured, { mode: 'bash', width: 3 })!;
  let tabSpans = 0;
  layout.visitRows(row => layout.visitSpans(row, (kind, first, end) => {
    if (kind === SpanKind.Tab) { tabSpans++; assert.equal(first, 1); assert.equal(end, 2); }
  }));
  assert.ok(tabSpans > 1); layout.dispose(); measured.dispose();
  assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: resize uses numeric data only after actual Segmenter, width and UTF8 hooks reject new work', () => {
  const budget = new DataBudget(1_000_000); let widthCalls = 0, segments = 0;
  hooks[widthKey] = () => { widthCalls++; };
  const originalSegment = Intl.Segmenter.prototype.segment, originalCharCode = String.prototype.charCodeAt;
  Intl.Segmenter.prototype.segment = function(text) { segments++; return originalSegment.call(this, text); };
  let measured: Measured;
  try { measured = measure('a\t界é👩‍💻\nwords  end', budget)!; }
  finally { Intl.Segmenter.prototype.segment = originalSegment; }
  assert.ok(widthCalls > 0 && segments > 0);
  let resizeWidthCalls = 0, resizeSegments = 0, resizeUtf8Reads = 0, resizeOperations = 0;
  hooks[widthKey] = () => { resizeWidthCalls++; throw new Error('width during resize'); };
  Intl.Segmenter.prototype.segment = () => { resizeSegments++; throw new Error('segmentation during resize'); };
  String.prototype.charCodeAt = () => { resizeUtf8Reads++; throw new Error('UTF8 during resize'); };
  try {
    for (let pass = 0; pass < 10; pass++) for (let width = 1; width <= 6; width++) for (const mode of ['file', 'bash'] as const) {
      const layout = reflow(measured!, { mode, width })!;
      assert.ok(layout.rowCount > 0); resizeOperations++; layout.dispose();
    }
    assert.equal(resizeWidthCalls + resizeSegments + resizeUtf8Reads, 0);
  } finally { delete hooks[widthKey]; Intl.Segmenter.prototype.segment = originalSegment; String.prototype.charCodeAt = originalCharCode; measured!.dispose(); }
  console.log(JSON.stringify({ geometryWork: { segments, widthCalls, resizeOperations, resizeWidthCalls, resizeSegments, resizeUtf8Reads } }));
  assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: denial and allocation exceptions preserve old measurement/layout and refund all grants', () => {
  const budget = new DataBudget(100_000), measured = measure('old\ttext', budget)!, old = reflow(measured, { mode: 'file', width: 3 })!;
  const before = budget.stats(), expected = rows('old\ttext', measured, old), Original = globalThis.Uint32Array;
  const blocker = budget.reserve(budget.limit - before.retainedBytes)!;
  assert.equal(measure('new', budget), undefined); assert.equal(reflow(measured, { mode: 'bash', width: 2 }), undefined);
  blocker.close(); assert.deepEqual(budget.stats(), before);
  for (const operation of [() => measure('new'.repeat(1000), budget), () => reflow(measured, { mode: 'bash', width: 1 })]) {
    let allocations = 0;
    globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { if (++allocations === 2) throw new Error('controlled allocation failure'); return Reflect.construct(target, args); } });
    try { assert.throws(operation, /controlled allocation failure/); }
    finally { globalThis.Uint32Array = Original; }
    assert.deepEqual(budget.stats(), before); assert.deepEqual(rows('old\ttext', measured, old), expected);
  }
  for (const text of ['\ud800', '\udc00', 'a\ud800b']) {
    const partial = measure(text, budget)!;
    let bytes = 0; partial.visitGlyphs(0, partial.glyphCount, (_i, _a, _b, _c, end) => { bytes = end; });
    assert.equal(bytes, Buffer.byteLength(text)); partial.dispose();
    assert.deepEqual(budget.stats(), before);
  }
  old.dispose(); measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: reentrant disposal stops visitors and cannot spend suspended physical arrays', () => {
  const budget = new DataBudget(100_000), measured = measure('abc\tdef', budget)!, layout = reflow(measured, { mode: 'bash', width: 2 })!;
  let visits = 0;
  assert.equal(layout.visitRows(() => {
    visits++; layout.dispose(); measured.dispose();
    assert.ok(budget.stats().retainedBytes > 0); assert.equal(budget.reserve(budget.limit), undefined);
    console.log(JSON.stringify({ geometryBorrow: { retainedDuringDispose: budget.stats().retainedBytes, visits } }));
  }), false);
  assert.equal(visits, 1); assert.equal(budget.stats().retainedBytes, 0);
  assert.equal(layout.visitRows(() => assert.fail('disposed layout')), false);
  assert.equal(measured.visitGlyphs(0, 0, () => assert.fail('disposed measurement')), false);
  const second = measure('abc', budget)!, stale = reflow(second, { mode: 'file', width: 1 })!;
  second.dispose(); assert.equal(stale.visitSpans(0, () => assert.fail('stale dependency')), false); stale.dispose();
  const third = measure('abc', budget)!;
  assert.equal(third.visitGlyphs(0, 3, () => { third.dispose(); assert.ok(budget.stats().retainedBytes > 0); }), false);
  assert.equal(budget.stats().retainedBytes, 0);
  const fourth = measure('abc', budget)!, retained = reflow(fourth, { mode: 'file', width: 1 })!;
  let callbacks = 0;
  assert.equal(retained.visitSpans(0, () => { callbacks++; fourth.dispose(); }), false);
  assert.equal(callbacks, 1); assert.equal(budget.stats().retainedBytes, retained.allocationBytes);
  retained.dispose();
  const fifth = measure('abc', budget)!;
  assert.throws(() => fifth.visitGlyphs(0, 3, () => { fifth.dispose(); throw new Error('visitor failed'); }), /visitor failed/);
  assert.equal(budget.stats().retainedBytes, 0);
});

function detachedOwner(budget: DataBudget) {
  const owner = { text: 'first\t界👩‍💻' }, weak = new WeakRef(owner), measured = measure(owner.text, budget)!;
  const layout = reflow(measured, { mode: 'bash', width: 3 })!;
  return { weak, measured, layout };
}
async function collect(weak: WeakRef<object>) {
  for (let pass = 0; pass < 30; pass++) { await turn(); global.gc!(); await turn(); if (!weak.deref()) return; }
  assert.fail('owner did not collect');
}
test('measured rows: live geometry retains no input owner and explicit disposal collects first geometry owner', async () => {
  const budget = new DataBudget(1_000_000), held = detachedOwner(budget);
  await collect(held.weak); assert.equal(held.measured.isValid, true); assert.equal(held.layout.isValid, true);
  const weakMeasured = new WeakRef(held.measured);
  held.measured.dispose(); held.layout.dispose();
  const replacement = detachedOwner(budget);
  // A layout is only a weak dependency; retaining the disposed layout must not retain its old measurement.
  const disposedLayout = held.layout;
  (held as { measured: Measured | undefined }).measured = undefined;
  await collect(weakMeasured); assert.equal(disposedLayout.isValid, false);
  replacement.layout.dispose(); replacement.measured.dispose();
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ geometryGC: { inputOwnerCollectedWhileLive: true, firstMeasuredOwnerCollected: true, finalBytes: 0 } }));
});

test('measured rows: compact buffer receipts and coalesced ordinary spans use the caller ledger exactly', () => {
  const budget = new DataBudget(8_000_000), source = 'a'.repeat(10_000), measured = measure(source, budget)!;
  assert.equal(measured.bufferBytes, 10_000 * 4 * 4);
  assert.equal(budget.stats().retainedBytes, measured.allocationBytes);
  const layout = reflow(measured, { mode: 'file', width: 100 })!;
  assert.equal(layout.rowCount, 100); assert.equal(layout.spanCount, 100);
  assert.equal(layout.bufferBytes, 100 * (2 + 5) * 4);
  assert.equal(budget.stats().retainedBytes, measured.allocationBytes + layout.allocationBytes);
  assert.equal(budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ geometryStorage: { glyphs: measured.glyphCount, measuredBufferBytes: measured.bufferBytes, layoutBufferBytes: layout.bufferBytes, spans: layout.spanCount, retainedBytes: budget.stats().retainedBytes } }));
  measured.dispose(); assert.equal(budget.stats().retainedBytes, layout.allocationBytes);
  layout.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: every funded growth/compaction failure leaves old data intact, including old/new peak', () => {
  const budget = new DataBudget(1_000_000), source = 'old\tdata', measured = measure(source, budget)!, layout = reflow(measured, { mode: 'bash', width: 2 })!;
  const before = budget.stats(), expected = rows(source, measured, layout), originalReserve = DataBudget.prototype.reserve, Original = globalThis.Uint32Array;
  const operations = [() => measure('abc\t界'.repeat(80), budget), () => reflow(measured, { mode: 'bash', width: 1 })];
  let deniedPeaks = 0, failedAllocations = 0, peakBytes = 0;
  for (const operation of operations) {
    let reserves = 0, allocations = 0;
    DataBudget.prototype.reserve = function(bytes) { if (this === budget) reserves++; return originalReserve.call(this, bytes); };
    globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { allocations++; peakBytes = Math.max(peakBytes, budget.stats().retainedBytes); return Reflect.construct(target, args); } });
    try { operation()!.dispose(); }
    finally { DataBudget.prototype.reserve = originalReserve; globalThis.Uint32Array = Original; }
    assert.deepEqual(budget.stats(), before);
    for (let target = 1; target <= reserves; target++) {
      let calls = 0;
      DataBudget.prototype.reserve = function(bytes) { if (this === budget && ++calls === target) return undefined; return originalReserve.call(this, bytes); };
      try { assert.equal(operation(), undefined); deniedPeaks++; }
      finally { DataBudget.prototype.reserve = originalReserve; }
      assert.deepEqual(budget.stats(), before); assert.deepEqual(rows(source, measured, layout), expected);
    }
    for (let target = 1; target <= allocations; target++) {
      let calls = 0;
      globalThis.Uint32Array = new Proxy(Original, { construct(type, args) { if (++calls === target) throw new Error('allocation point failure'); return Reflect.construct(type, args); } });
      try { assert.throws(operation, /allocation point failure/); failedAllocations++; }
      finally { globalThis.Uint32Array = Original; }
      assert.deepEqual(budget.stats(), before); assert.deepEqual(rows(source, measured, layout), expected);
    }
  }
  assert.ok(peakBytes > before.retainedBytes); assert.ok(deniedPeaks > 10 && failedAllocations > 5);
  console.log(JSON.stringify({ geometryFunding: { deniedPeaks, failedAllocations, oldRetainedBytes: before.retainedBytes, maxFundedBytesAtAllocation: peakBytes, outstandingBytes: budget.stats().outstandingPeakBytes } }));
  layout.dispose(); measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: actual suspended vectors survive disposal and remain funded until visitor unwind', async () => {
  const budget = new DataBudget(100_000), Original = globalThis.Uint32Array;
  let actual: WeakRef<Uint32Array> | undefined;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { const array = Reflect.construct(target, args) as Uint32Array; actual = new WeakRef(array); return array; } });
  let measured: Measured;
  try { measured = measure('first\t界', budget)!; } finally { globalThis.Uint32Array = Original; }
  const vector = actual!;
  await turn();
  assert.equal(measured!.visitGlyphs(0, measured!.glyphCount, () => {
    measured!.dispose(); global.gc!();
    assert.ok(vector.deref()); assert.equal(budget.stats().retainedBytes, measured!.allocationBytes);
    assert.equal(budget.reserve(budget.limit), undefined);
  }), false);
  assert.equal(budget.stats().retainedBytes, 0); await collect(vector);
  const next = measure('second\t界', budget)!;
  let rowVector: WeakRef<Uint32Array> | undefined;
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { const array = Reflect.construct(target, args) as Uint32Array; rowVector = new WeakRef(array); return array; } });
  let layout: Layout;
  try { layout = reflow(next, { mode: 'bash', width: 2 })!; } finally { globalThis.Uint32Array = Original; }
  await turn(); let visits = 0;
  assert.equal(layout!.visitSpans(0, () => {
    visits++; layout!.dispose(); next.dispose(); global.gc!();
    assert.ok(rowVector!.deref()); assert.equal(budget.stats().retainedBytes, layout!.allocationBytes);
  }), false);
  assert.equal(visits, 1); assert.equal(budget.stats().retainedBytes, 0); await collect(rowVector!);
  console.log(JSON.stringify({ geometryPhysicalBorrow: { measurementVectorHeldAndCharged: true, layoutVectorsHeldAndCharged: true, finalBytes: 0 } }));
});

test('measured rows: actual Pi spacing marks preserve clipped file occupancy, distinct from Bash replacement', () => {
  const cluster = '\u093e'.repeat(3);
  // Reachability witness independent of our measurement/reflow implementation.
  assert.equal(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cluster)).length, 1);
  assert.equal(piWidth(cluster), 3);
  const budget = new DataBudget(100_000), source = cluster + 'X', measured = measure(source, budget)!;
  const file = reflow(measured, { mode: 'file', width: 2 })!, bash = reflow(measured, { mode: 'bash', width: 2 })!;
  try {
    assert.deepEqual(rows(source, measured, file), ['�', 'X']);
    const occupancy: number[] = [], replacements: number[][] = [];
    file.visitRows((row, cells) => {
      occupancy.push(cells);
      file.visitSpans(row, (kind, first, end, cells) => { if (kind === SpanKind.Replacement) replacements.push([first, end, cells]); });
    });
    assert.deepEqual(occupancy, [2, 1]); assert.deepEqual(replacements, [[0, 1, 2]]);
    assert.deepEqual(rows(source, measured, bash), ['$ ', '�X']);
    assert.deepEqual(project(cluster + '\tX', 'file', 2), ['�', ' X']);
  } finally { file.dispose(); bash.dispose(); measured.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: source-proportional width scratch is admitted before the actual public call', () => {
  const huge = '\u093e'.repeat(65_536);
  let calls = 0, deniedCalls = 0;
  hooks[widthKey] = () => { calls++; };
  try {
    for (const limit of [192, 1024, 200_000]) {
      const budget = new DataBudget(limit), before = budget.stats();
      assert.equal(measure(huge, budget), undefined);
      assert.equal(calls, 0, 'insufficient scratch must deny before entering Pi width');
      assert.deepEqual(budget.stats(), before);
    }
    deniedCalls += calls;
    const budget = new DataBudget(100_000), measured = measure('old', budget)!, old = reflow(measured, { mode: 'file', width: 2 })!;
    const before = budget.stats(), expected = rows('old', measured, old), beforeCalls = calls;
    assert.equal(measure(huge, budget), undefined); deniedCalls += calls - beforeCalls; assert.equal(calls, beforeCalls);
    assert.deepEqual(budget.stats(), before); assert.deepEqual(rows('old', measured, old), expected);
    hooks[widthKey] = () => { throw new Error('controlled width failure'); };
    assert.throws(() => measure('👩‍💻', budget), /controlled width failure/);
    assert.deepEqual(budget.stats(), before); assert.deepEqual(rows('old', measured, old), expected);
    old.dispose(); measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
    const small = new DataBudget(4096); let chargedAtCall = 0;
    hooks[widthKey] = () => { calls++; chargedAtCall = small.stats().retainedBytes; };
    const tiny = measure('界', small)!; assert.ok(tiny); assert.ok(chargedAtCall > tiny.allocationBytes);
    tiny.dispose(); assert.equal(small.stats().retainedBytes, 0); assert.equal(small.stats().outstandingPeakBytes, 0);
    console.log(JSON.stringify({ geometryScratch: { deniedClusterUnits: huge.length, deniedCalls, tinyInputAdmitted: true, chargedAtCall, finalBytes: small.stats().retainedBytes } }));
  } finally { delete hooks[widthKey]; }
});

test('measured rows: one local width memo covers more than 512 unique CJK glyphs and reflow survives unrelated host calls', () => {
  const unique = Array.from({ length: 600 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const source = unique.join('').repeat(3), budget = new DataBudget(1_000_000), calls = new Map<string, number>();
  hooks[widthKey] = text => { calls.set(text, (calls.get(text) ?? 0) + 1); };
  let measured: Measured | undefined;
  try {
    measured = measure(source, budget)!; assert.ok(measured);
    assert.equal(calls.size, 600); assert.ok([...calls.values()].every(count => count === 1));
    assert.equal(budget.stats().retainedBytes, measured.allocationBytes, 'temporary memo and scratch are gone');
    // Public unrelated traffic displaces the host's useful entries; no private cache is read or flushed.
    let unrelatedCalls = 0;
    for (let i = 0; i < 1200; i++) { piWidth(String.fromCodePoint(0x6000 + i)); unrelatedCalls++; }
    let resizeCalls = 0;
    hooks[widthKey] = () => { resizeCalls++; throw new Error('public width re-entry after unrelated traffic'); };
    for (const width of [1, 2, 6, 80, 120]) for (const mode of ['file', 'bash'] as const) {
      const layout = reflow(measured, { mode, width })!; assert.ok(layout); layout.dispose();
    }
    assert.equal(resizeCalls, 0);
    console.log(JSON.stringify({ geometryWidthReuse: { uniqueGlyphs: calls.size, sourceGlyphs: measured.glyphCount, publicCalls: [...calls.values()].reduce((a, b) => a + b, 0), unrelatedCalls, resizeCalls } }));
  } finally { delete hooks[widthKey]; measured?.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
});

test('measured rows: actual UTF8 traversal is positive on tabs/newlines and forbidden in numeric reflow', () => {
  const budget = new DataBudget(100_000), original = String.prototype.charCodeAt;
  let measured: Measured | undefined, utf8Reads = 0, widthCalls = 0, resizeReads = 0, resizeOperations = 0;
  hooks[widthKey] = () => { widthCalls++; throw new Error('tabs/newlines must not enter public width'); };
  String.prototype.charCodeAt = function(index) { utf8Reads++; return original.call(this, index); };
  try { measured = measure('\t\n\t\n', budget)!; }
  finally { String.prototype.charCodeAt = original; delete hooks[widthKey]; }
  assert.ok(measured); assert.ok(utf8Reads > 0); assert.equal(widthCalls, 0);
  String.prototype.charCodeAt = () => { resizeReads++; throw new Error('UTF8 during numeric reflow'); };
  try {
    for (const width of [1, 2, 3, 4, 5, 6]) for (const mode of ['file', 'bash'] as const) {
      const layout = reflow(measured, { mode, width })!; resizeOperations++; layout.dispose();
    }
    assert.equal(resizeReads, 0);
  } finally { String.prototype.charCodeAt = original; measured.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ geometryUtf8: { utf8Reads, widthCalls, resizeReads, resizeOperations } }));
});


test('measured rows: prompt-free Bash body preserves the existing terminal-row policy without synthetic source bytes', async () => {
  const { terminalRows } = await import('../../../src/plain-text.ts');
  for (const text of ['', '\tX', 'abc\td', 'abc def ghi', '  a   ', '界é👩‍💻🙂', '\u093e\u093e\u093eX']) {
    const budget = new DataBudget(100_000), measured = measure(text, budget)!;
    const original: number[][] = []; measured.visitGlyphs(0, measured.glyphCount, (...glyph) => original.push(glyph));
    try {
      for (let width = 1; width <= 10; width++) {
        const layout = reflow(measured, { mode: 'bash', width, prompt: false })!;
        try {
          assert.deepEqual(rows(text, measured, layout), terminalRows(text, width));
          layout.visitRows(row => layout.visitSpans(row, kind => assert.notEqual(kind, SpanKind.Prompt)));
        } finally { layout.dispose(); }
        const defaultCommand = reflow(measured, { mode: 'bash', width })!;
        const explicitCommand = reflow(measured, { mode: 'bash', width, prompt: true })!;
        try { assert.deepEqual(rows(text, measured, explicitCommand), rows(text, measured, defaultCommand)); }
        finally { defaultCommand.dispose(); explicitCommand.dispose(); }
      }
      const unchanged: number[][] = []; measured.visitGlyphs(0, measured.glyphCount, (...glyph) => unchanged.push(glyph));
      assert.deepEqual(unchanged, original, 'prompt policy cannot change source endpoints or measurements');
      const multiline = text + '\n\tend\n';
      const lines = measure(multiline, budget)!, layout = reflow(lines, { mode: 'bash', width: 3, prompt: false })!;
      try { assert.deepEqual(rows(multiline, lines, layout), multiline.split('\n').flatMap(line => terminalRows(line, 3))); }
      finally { layout.dispose(); lines.dispose(); }
    } finally { measured.dispose(); }
    assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  }
});

test('measured rows: toggling the command prompt on retained measurements performs no new text work', () => {
  const budget = new DataBudget(100_000), text = '界\tend\nline', measured = measure(text, budget)!;
  const originalSegment = Intl.Segmenter.prototype.segment, originalCharCode = String.prototype.charCodeAt;
  let widthCalls = 0, segments = 0, utf8Reads = 0, layouts = 0;
  hooks[widthKey] = () => { widthCalls++; throw new Error('body policy remeasured width'); };
  Intl.Segmenter.prototype.segment = () => { segments++; throw new Error('body policy resegmented text'); };
  String.prototype.charCodeAt = () => { utf8Reads++; throw new Error('body policy recounted UTF8'); };
  try {
    for (let pass = 0; pass < 4; pass++) for (let width = 1; width <= 6; width++) for (const prompt of [false, true]) {
      const layout = reflow(measured, { mode: 'bash', width, prompt })!;
      try { assert.ok(layout.rowCount > 0); layouts++; } finally { layout.dispose(); }
    }
  } finally {
    delete hooks[widthKey]; Intl.Segmenter.prototype.segment = originalSegment; String.prototype.charCodeAt = originalCharCode; measured.dispose();
  }
  assert.deepEqual({ layouts, widthCalls, segments, utf8Reads }, { layouts: 48, widthCalls: 0, segments: 0, utf8Reads: 0 });
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
});


test('measured rows: indexed row columns match declared layout cells without text measurement', () => {
  const text = '界é\tword\n\nlast', budget = new DataBudget(100_000), measured = measure(text, budget)!;
  for (const mode of ['file', 'bash'] as const) for (const prompt of [false, true]) for (let width = 1; width <= 6; width++) {
    const layout = reflow(measured, { mode, width, prompt })!;
    try {
      const expected: number[] = []; layout.visitRows((_index, cells) => expected.push(cells));
      const actual: number[] = [];
      assert.equal(layout.withLookup(measured, read => {
        for (let row = expected.length - 1; row >= 0; row--) actual[row] = read.rowColumns(row);
        assert.throws(() => read.rowColumns(-1), /index/); assert.throws(() => read.rowColumns(expected.length), /index/);
      }), true);
      assert.deepEqual(actual, expected);
    } finally { layout.dispose(); }
  }
  const layout = reflow(measured, { mode: 'bash', width: 4, prompt: false })!;
  let escaped: Parameters<Parameters<typeof layout.withLookup>[1]>[0] | undefined;
  assert.equal(layout.withLookup(measured, read => { escaped = read; layout.dispose(); }), false);
  assert.throws(() => escaped!.rowColumns(0), /stale/);
  measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});


test('measured rows: bounded reflow is the exact complete row prefix across tabs, Unicode, prompts, blanks and newlines', () => {
  for (const text of ['', 'a'.repeat(2000), '\tX\t\n\n界é👩‍💻🙂\n', '\u093e\u093e\u093eX\tend\n', 'word  spaces\n\t\nlast']) {
    const budget = new DataBudget(1_000_000), measured = measure(text, budget)!;
    for (const mode of ['file', 'bash'] as const) for (const prompt of [false, true]) for (const width of [0, 1, 2, 3, 6, 20]) {
      const complete = reflow(measured, { mode, width, prompt })!;
      const expected = rows(text, measured, complete), expectedCells: number[] = [];
      complete.visitRows((_row, cells) => expectedCells.push(cells));
      for (const maxRows of [0, 1, 2, 3, 10, 11, expected.length, expected.length + 1]) {
        const bounded = reflow(measured, { mode, width, prompt, maxRows })!;
        try {
          assert.deepEqual(rows(text, measured, bounded), expected.slice(0, maxRows), `${mode} prompt=${prompt} width=${width} maxRows=${maxRows}`);
          assert.equal(bounded.rowCount, Math.min(maxRows, expected.length));
          bounded.visitRows((row, cells) => assert.equal(cells, expectedCells[row]));
        } finally { bounded.dispose(); }
      }
      complete.dispose();
    }
    for (const maxRows of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => reflow(measured, { mode: 'bash', width: 20, maxRows }), /policy/);
    }
    measured.dispose(); assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  }
});

test('measured rows: bounded candidate denial, throw and reentrant invalidation preserve funded complete geometry', () => {
  const budget = new DataBudget(1_000_000), text = 'a'.repeat(2000), measured = measure(text, budget)!;
  const complete = reflow(measured, { mode: 'bash', width: 20, prompt: false })!;
  assert.equal(complete.rowCount, 100); assert.equal(rows(text, measured, complete).join(''), text);
  const before = budget.stats(); let grants = 0;
  const candidate = reflow(measured, { mode: 'bash', width: 20, prompt: false, maxRows: 11 }, bytes => { grants++; return budget.reserve(bytes); })!;
  assert.equal(candidate.rowCount, 11); assert.equal(candidate.spanCount, 11); assert.equal(candidate.bufferBytes, 11 * 28);
  candidate.dispose(); assert.deepEqual(budget.stats(), before);
  for (let stop = 1; stop <= grants; stop++) {
    let seen = 0;
    assert.equal(reflow(measured, { mode: 'bash', width: 20, prompt: false, maxRows: 11 }, bytes => ++seen === stop ? undefined : budget.reserve(bytes)), undefined);
    assert.deepEqual(budget.stats(), before); assert.equal(complete.isValid, true);
    seen = 0;
    assert.throws(() => reflow(measured, { mode: 'bash', width: 20, prompt: false, maxRows: 11 }, bytes => {
      if (++seen === stop) throw Error('bounded failure'); return budget.reserve(bytes);
    }), /bounded failure/);
    assert.deepEqual(budget.stats(), before);
  }
  let seen = 0, overlap = 0;
  assert.equal(reflow(measured, { mode: 'bash', width: 20, prompt: false, maxRows: 11 }, bytes => {
    if (++seen === 4) { measured.dispose(); overlap = budget.stats().retainedBytes; }
    return budget.reserve(bytes);
  }), undefined);
  assert.ok(overlap >= before.retainedBytes, 'borrowed measurement remains funded across early-return construction');
  assert.equal(complete.isValid, false); complete.dispose();
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ boundedGeometryFunding: { grants, rowCount: 11, spanCount: 11, bufferBytes: 308, finalBytes: 0 } }));
});


test('measured rows: streamed append reuses prefix widths and amortizes numeric storage without retaining obsolete owners', () => {
  const budget = new DataBudget(2_000_000), Original = globalThis.Uint32Array, segment = Intl.Segmenter.prototype.segment;
  let text = 'prefix ', measured = measure(text, budget)!, units = 0, widthUnits = 0, allocatedWords = 0;
  hooks[widthKey] = text => { widthUnits += text.length; };
  Intl.Segmenter.prototype.segment = function(text) { units += text.length; return segment.call(this, text); };
  globalThis.Uint32Array = new Proxy(Original, { construct(target, args) { if (typeof args[0] === 'number') allocatedWords += args[0]; return Reflect.construct(target, args); } });
  try {
    for (let i = 0; i < 64; i++) {
      text += 'abcdefghijklmnopqrstuvwxyz012345';
      const old = measured, append = prepareMeasuredAppend(old, text)!;
      assert.ok(append); assert.equal(old.isValid, true);
      assert.equal(append.commit(), true); measured = append.measured; append.dispose();
      assert.equal(old.isValid, false);
      assert.equal(budget.stats().retainedBytes, measured.allocationBytes, 'only current capacity remains funded');
    }
  } finally { delete hooks[widthKey]; Intl.Segmenter.prototype.segment = segment; globalThis.Uint32Array = Original; }
  try {
    assert.ok(units > 2048 && units <= 2048 + 64 * 2);
    assert.ok(widthUnits > 0 && widthUnits <= units);
    assert.ok(allocatedWords < text.length * 40, 'numeric allocation must not copy the complete prefix per append');
    const layout = reflow(measured, { mode: 'file', width: 100 })!;
    try { assert.equal(rows(text, measured, layout).join(''), text); } finally { layout.dispose(); }
    console.log(JSON.stringify({ appendGeometryWork: { updates: 64, finalUnits: text.length, units, widthUnits, allocatedWords, retainedBytes: budget.stats().retainedBytes } }));
  } finally { measured.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('measured rows: append boundary graphemes match full measurement, including incomplete UTF16 and regional pairs', () => {
  for (const chunks of [['e', '\u0301', ' tail'], ['👩', '\u200d', '💻', ' tail'], ['\ud83d', '\ude00', 'x'], ['🇦', '🇧', '🇨', '🇩'], ['\r', '\n', 'x']]) {
    const budget = new DataBudget(100_000); let text = chunks[0]!, measured = measure(text, budget)!;
    try {
      for (const chunk of chunks.slice(1)) {
        text += chunk;
        const previous = measured, oldLayout = reflow(previous, { mode: 'file', width: 2 })!, append = prepareMeasuredAppend(previous, text)!;
        assert.equal(append.commit(), true); measured = append.measured; append.dispose();
        assert.equal(oldLayout.isValid, false); oldLayout.dispose();
        const complete = measure(text, budget)!, actual: number[][] = [], expected: number[][] = [];
        try {
          measured.visitGlyphs(0, measured.glyphCount, (...glyph) => actual.push(glyph));
          complete.visitGlyphs(0, complete.glyphCount, (...glyph) => expected.push(glyph));
          assert.deepEqual(actual, expected);
        } finally { complete.dispose(); }
      }
    } finally { measured.dispose(); }
    assert.equal(budget.stats().retainedBytes, 0);
  }
});

test('measured rows: append preparation refusal, throw, cancellation and reentrant disposal preserve funded prefix until adoption', () => {
  const budget = new DataBudget(100_000), original = measure('old', budget)!, before = budget.stats();
  let grants = 0;
  const probe = prepareMeasuredAppend(original, 'old plus text', n => { grants++; return budget.reserve(n); })!;
  probe.dispose(); assert.deepEqual(budget.stats(), before); assert.equal(original.isValid, true);
  for (let stop = 1; stop <= grants; stop++) {
    let seen = 0;
    assert.equal(prepareMeasuredAppend(original, 'old plus text', n => ++seen === stop ? undefined : budget.reserve(n)), undefined);
    assert.deepEqual(budget.stats(), before);
    seen = 0;
    assert.throws(() => prepareMeasuredAppend(original, 'old plus text', n => { if (++seen === stop) throw Error('append refused'); return budget.reserve(n); }), /append refused/);
    assert.deepEqual(budget.stats(), before);
  }
  const cancelled = prepareMeasuredAppend(original, 'old tail')!;
  original.dispose(); assert.equal(cancelled.commit(), false); cancelled.dispose();
  assert.equal(budget.stats().retainedBytes, 0);
  const live = measure('prefix', budget)!; let seen = 0;
  assert.equal(prepareMeasuredAppend(live, 'prefix tail', n => { if (++seen === 2) live.dispose(); return budget.reserve(n); }), undefined);
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
});


test('measured rows: append adoption during a geometry borrow invalidates it without refunding suspended storage', () => {
  for (const throws of [false, true]) {
    const budget = new DataBudget(100_000), old = measure('abcdef', budget)!;
    const append = prepareMeasuredAppend(old, 'abcdefg')!;
    let visits = 0;
    const run = () => old.visitGlyphs(0, old.glyphCount, () => {
      visits++; assert.equal(append.commit(), true);
      assert.ok(budget.stats().retainedBytes > append.measured.allocationBytes, 'old suspended header stays charged');
      if (throws) throw Error('adoption callback failed');
    });
    if (throws) assert.throws(run, /adoption callback failed/); else assert.equal(run(), false);
    assert.equal(visits, 1); assert.equal(budget.stats().retainedBytes, append.measured.allocationBytes);
    append.dispose(); append.measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
  }
});


test('measured rows: borrowed old layout rejects reads after append adoption and keeps actual vectors funded until unwind', () => {
  for (const throws of [false, true]) for (const spareCapacity of [false, true]) {
    const budget = new DataBudget(100_000); let old = measure(spareCapacity ? 'abcd' : 'abcdef', budget)!;
    if (spareCapacity) {
      const prime = prepareMeasuredAppend(old, 'abcdef')!;
      assert.equal(prime.commit(), true); old = prime.measured; prime.dispose();
    }
    const layout = reflow(old, { mode: 'file', width: 2 })!, append = prepareMeasuredAppend(old, 'abcdefg')!;
    const run = () => layout.withLookup(old, read => {
      assert.equal(read.rowColumns(0), 2);
      assert.equal(append.commit(), true); layout.dispose();
      assert.equal(read.isValid, false);
      assert.throws(() => read.rowColumns(0), /stale/);
      assert.ok(budget.stats().retainedBytes > append.measured.allocationBytes + layout.allocationBytes,
        'suspended old lookup still owns its header and all arrays, including shared capacity');
      if (throws) throw Error('old layout callback failed');
    });
    if (throws) assert.throws(run, /old layout callback failed/); else assert.equal(run(), false);
    assert.equal(budget.stats().retainedBytes, append.measured.allocationBytes);
    append.dispose(); append.measured.dispose(); assert.equal(budget.stats().retainedBytes, 0);
  }
});


for (const [label, base, completion] of [
  ['modifier', '👍\ud83c', '\udffd'],
  ['regional indicator', '🇦\ud83c', '\udde7'],
  ['ZWJ', '👩\u200d\ud83d', '\udcbb'],
] as const) test(`review R1: trailing surrogate completion joins preceding ${label} grapheme without rescanning stable prefix`, () => {
  const prefix = 'stable '.repeat(12), budget = new DataBudget(100_000), initial = prefix + base, text = initial + completion;
  const old = measure(initial, budget)!, segment = Intl.Segmenter.prototype.segment;
  let units = 0, append: ReturnType<typeof prepareMeasuredAppend>;
  Intl.Segmenter.prototype.segment = function(text) { units += text.length; return segment.call(this, text); };
  try { append = prepareMeasuredAppend(old, text)!; }
  finally { Intl.Segmenter.prototype.segment = segment; }
  assert.ok(append); assert.equal(append.commit(), true);
  const actual = append.measured, complete = measure(text, budget)!, actualGlyphs: number[][] = [], expectedGlyphs: number[][] = [];
  try {
    actual.visitGlyphs(0, actual.glyphCount, (...glyph) => actualGlyphs.push(glyph));
    complete.visitGlyphs(0, complete.glyphCount, (...glyph) => expectedGlyphs.push(glyph));
    assert.equal(actualGlyphs.length === expectedGlyphs.length && actualGlyphs.every((glyph, i) => glyph.every((value, j) => value === expectedGlyphs[i]![j])),
      true, 'completed scalar may merge with the grapheme before the old isolated high surrogate');
    // Pi's uncached public width call may segment the same boundary once more.
    assert.ok(units > 0 && units <= 2 * (base.length + completion.length),
      `earlier stable measurements must not be rescanned: ${units} actual segmentation units`);
    for (const width of [1, 2, 3, 6]) {
      const a = reflow(actual, { mode: 'bash', width })!, b = reflow(complete, { mode: 'bash', width })!;
      try { assert.deepEqual(rows(text, actual, a), rows(text, complete, b)); }
      finally { a.dispose(); b.dispose(); }
    }
    console.log(JSON.stringify({ surrogateJoin: { label, prefixUnits: prefix.length, resegmentedUnits: units, glyphs: actual.glyphCount } }));
  } finally { append.dispose(); actual.dispose(); complete.dispose(); old.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});
