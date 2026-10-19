import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { compileStyleAnsi, type AnsiStyle } from '../../../src/syntax/style-ansi.ts';
import { terminalRows } from '../../../src/plain-text.ts';

const widthKey = Symbol.for('test.flat-paint.width');
const hooks = globalThis as typeof globalThis & { [widthKey]?: () => void };
const widthModule = 'data:text/javascript,' + encodeURIComponent(`import { visibleWidth as original } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))}; export function visibleWidth(text) { globalThis[Symbol.for('test.flat-paint.width')]?.(); return original(text); }`);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-tui' && (context.parentURL?.endsWith('/src/syntax/measured-rows.ts') || context.parentURL?.endsWith('/src/syntax/flat-paint.ts'))) return { url: widthModule, shortCircuit: true };
  return next(specifier, context);
} });
const { measure, reflow } = await import('../../../src/syntax/measured-rows.ts');
const { paintFlat } = await import('../../../src/syntax/flat-paint.ts');
loader.deregister();
type Painted = NonNullable<ReturnType<typeof paintFlat>>;
type Reader = Parameters<typeof paintFlat>[3];
const neutral = compileStyleAnsi({ foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 }, 'truecolor');
const prompt = compileStyleAnsi({ foreground: { kind: 'indexed', index: 8 }, background: { kind: 'terminal-default' }, attributes: 8 }, 'truecolor');
function ink(index: number, attributes = 0): AnsiStyle {
  return compileStyleAnsi({ foreground: { kind: 'indexed', index }, background: { kind: 'terminal-default' }, attributes }, 'truecolor');
}
function readRows(painted: Painted): string[] {
  const rows: string[] = []; assert.equal(painted.visitRows((_index, row) => rows.push(row)), true); return rows;
}
const plain = (rows: string[]) => rows.map(row => row.replace(/\x1b\[[\d;]*m/g, ''));
const all = (bytes: number, style: AnsiStyle): Reader => visit => { if (bytes) visit(0, bytes, style); return true; };
function fixture(text: string, mode: 'file' | 'bash', width: number, budget = new DataBudget(4_000_000)) {
  const measured = measure(text, budget)!, layout = reflow(measured, { mode, width })!;
  const bytes = Buffer.byteLength(text);
  return { budget, measured, layout, bytes, paint: (reader = all(bytes, neutral), cutoff = bytes, n = neutral, p = prompt) => paintFlat(text, measured, layout, reader, n, p, cutoff, budget),
    dispose() { layout.dispose(); measured.dispose(); } };
}
async function terminal(text: string) {
  const value = new xterm.Terminal({ cols: 120, rows: 4, allowProposedApi: true });
  await new Promise<void>(resolve => value.write(text, resolve)); return value;
}

test('flat paint: actual cells preserve RGB/index/default and all four font attributes without exterior leakage', async () => {
  const f = fixture('abc', 'file', 20);
  const rgb = compileStyleAnsi({ foreground: { kind: 'rgb', r: 18, g: 52, b: 86 }, background: { kind: 'rgb', r: 4, g: 5, b: 6 }, attributes: 15 }, 'truecolor');
  const indexed = ink(6, 5);
  const painted = f.paint(visit => { visit(0, 1, rgb); visit(1, 2, indexed); visit(2, 3, neutral); return true; })!;
  const value = await terminal('\x1b[1;2;3;4;38;5;1;48;5;2m' + readRows(painted)[0] + '.');
  try {
    const row = value.buffer.active.getLine(0)!, a = row.getCell(0)!, b = row.getCell(1)!, c = row.getCell(2)!, exterior = row.getCell(3)!;
    assert.equal(a.getFgColor(), 0x123456); assert.equal(a.getBgColor(), 0x040506); assert.ok(a.isFgRGB() && a.isBgRGB());
    assert.ok(a.isBold() && a.isDim() && a.isItalic() && a.isUnderline());
    assert.equal(b.getFgColor(), 6); assert.ok(b.isFgPalette() && b.isBgDefault());
    assert.ok(b.isBold() && b.isUnderline() && !b.isDim() && !b.isItalic());
    for (const cell of [c, exterior]) assert.ok(cell.isFgDefault() && cell.isBgDefault() && !cell.isBold() && !cell.isDim() && !cell.isItalic() && !cell.isUnderline());
  } finally { value.dispose(); painted.dispose(); f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
});

test('flat paint: palettes reuse the same measured layout with zero measurement, reflow or UTF8 work', async () => {
  let measuredWidthCalls = 0; hooks[widthKey] = () => { measuredWidthCalls++; };
  const f = fixture('界é👩‍💻\tX', 'bash', 8); delete hooks[widthKey]; assert.ok(measuredWidthCalls > 0);
  const red = ink(1), blue = ink(4), originalSegment = Intl.Segmenter.prototype.segment, originalChar = String.prototype.charCodeAt;
  const originalReflow = Reflect.get(f.measured.constructor, 'reflow');
  let widthCalls = 0, segments = 0, utf8Reads = 0, reflows = 0, first: Painted | undefined, second: Painted | undefined;
  hooks[widthKey] = () => { widthCalls++; throw new Error('width during paint'); };
  Intl.Segmenter.prototype.segment = () => { segments++; throw new Error('segmentation during paint'); };
  String.prototype.charCodeAt = () => { utf8Reads++; throw new Error('UTF8 during paint'); };
  Reflect.set(f.measured.constructor, 'reflow', () => { reflows++; throw new Error('reflow during paint'); });
  try { first = f.paint(all(f.bytes, red))!; second = f.paint(all(f.bytes, blue))!; }
  finally { delete hooks[widthKey]; Intl.Segmenter.prototype.segment = originalSegment; String.prototype.charCodeAt = originalChar; Reflect.set(f.measured.constructor, 'reflow', originalReflow); }
  assert.ok(first && second); assert.deepEqual(plain(readRows(first)), plain(readRows(second)));
  assert.equal(widthCalls + segments + utf8Reads + reflows, 0);
  const value = await terminal(readRows(first)[0] + '\r\n' + readRows(second)[0]);
  try { assert.equal(value.buffer.active.getLine(0)!.getCell(2)!.getFgColor(), 1); assert.equal(value.buffer.active.getLine(1)!.getCell(2)!.getFgColor(), 4); }
  finally { value.dispose(); first.dispose(); second.dispose(); f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ flatPaintWork: { measuredWidthCalls, widthCalls, segments, utf8Reads, reflows } }));
});

test('flat paint: file/Bash rows preserve narrow tabs, prompt, words, newlines and oversized spacing marks', () => {
  const files = [[' ', ' ', ' ', ' ', 'X'], ['  ', '  ', 'X'], ['   ', ' X'], ['    ', 'X'], ['    X'], ['    X']];
  const bash = [['$', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', 'X'], ['$ ', '  ', '  ', '  ', 'X'], ['$  ', '   ', '  X'], ['$   ', '    ', 'X'], ['$    ', '   X'], ['$     ', '  X']];
  for (let width = 1; width <= 6; width++) for (const mode of ['file', 'bash'] as const) {
    const f = fixture('\tX', mode, width), painted = f.paint()!;
    assert.deepEqual(plain(readRows(painted)), (mode === 'file' ? files : bash)[width - 1]); painted.dispose(); f.dispose();
    assert.equal(f.budget.stats().retainedBytes, 0);
  }
  for (const [text, mode, width, expected] of [
    ['abc def ghi', 'file', 6, ['abc ', 'def ', 'ghi']], ['a\n\n界\n', 'file', 2, ['a', '', '界', '']],
    ['\u093e\u093e\u093eX', 'file', 2, ['� ', 'X']], ['\u093e\u093e\u093eX', 'bash', 2, ['$ ', '�X']],
    ['界é👩‍💻', 'file', 1, ['�', 'é', '�']], ['', 'file', 2, ['']], ['', 'bash', 1, ['$', ' ']],
  ] as const) {
    const f = fixture(text, mode, width), painted = f.paint()!; assert.deepEqual(plain(readRows(painted)), expected);
    painted.dispose(); f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  }
});

test('flat paint: first-scalar byte ownership survives intra-grapheme range splits and historical prefix ending inside a ZWJ cluster', async () => {
  const f = fixture('é👩‍💻Z', 'file', 40), red = ink(1), blue = ink(4);
  const painted = f.paint(visit => { visit(0, 1, red); visit(1, 3, blue); visit(3, 7, red); visit(7, f.bytes, blue); return true; }, 7)!;
  assert.deepEqual(plain(readRows(painted)), ['é👩‍💻Z']);
  const value = await terminal(readRows(painted)[0]), reference = await terminal('é👩‍💻Z');
  try {
    const row = value.buffer.active.getLine(0)!, expected = reference.buffer.active.getLine(0)!;
    let neutralTail = false;
    // Headless xterm's default Unicode provider does not combine this ZWJ emoji.
    // Compare its real cells against independent unstyled source, not Pi widths.
    for (let column = 0; column < 10; column++) {
      const cell = row.getCell(column)!, raw = expected.getCell(column)!;
      assert.equal(cell.getChars(), raw.getChars());
      if (raw.getChars() === 'Z') { assert.ok(cell.isFgDefault()); neutralTail = true; break; }
      if (raw.getChars()) assert.equal(cell.getFgColor(), 1);
    }
    assert.ok(neutralTail);
  } finally { value.dispose(); reference.dispose(); painted.dispose(); f.dispose(); }
  const gap = fixture('abc', 'file', 20), output = gap.paint(visit => { visit(0, 1, red); visit(2, 3, blue); return true; })!;
  const cells = await terminal(readRows(output)[0]);
  try { assert.equal(cells.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), 1); assert.ok(cells.buffer.active.getLine(0)!.getCell(1)!.isFgDefault()); assert.equal(cells.buffer.active.getLine(0)!.getCell(2)!.getFgColor(), 4); }
  finally { cells.dispose(); output.dispose(); gap.dispose(); }
  assert.equal(f.budget.stats().retainedBytes + gap.budget.stats().retainedBytes, 0);
});

test('flat paint: split tab fragments share source style and prompt uses its prepared pair', async () => {
  const f = fixture('\tX', 'bash', 3), painted = f.paint(all(1, ink(1)))!;
  const value = await terminal(readRows(painted).join('\r\n'));
  try {
    for (let row = 0; row < painted.rowCount; row++) {
      const line = value.buffer.active.getLine(row)!;
      for (let cell = 0; cell < 3; cell++) {
        const c = line.getCell(cell)!;
        if (row === 0 && cell < 2) { assert.equal(c.getFgColor(), 8); assert.ok(c.isDim()); }
        else if (!(row === 2 && cell === 2)) assert.equal(c.getFgColor(), 1);
        else assert.ok(c.isFgDefault());
      }
    }
  } finally { value.dispose(); painted.dispose(); f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
});

test('flat paint: source reader invalidation, geometry invalidation, exceptions and every denial preserve the old funded output', () => {
  const red = ink(1), blue = ink(2);
  const f = fixture('old\ttext\nnext', 'bash', 5), old = f.paint()!, expected = readRows(old), before = f.budget.stats();
  const blocker = f.budget.reserve(f.budget.limit - before.retainedBytes)!;
  assert.equal(old.retain(), undefined); blocker.close(); assert.deepEqual(f.budget.stats(), before);
  assert.equal(f.paint(visit => { visit(0, 3, red); return false; }), undefined); assert.deepEqual(f.budget.stats(), before);
  assert.throws(() => f.paint(visit => { visit(0, 3, red); throw new Error('reader failed'); }), /reader failed/); assert.deepEqual(f.budget.stats(), before);
  const join = Array.prototype.join;
  Array.prototype.join = () => { throw new Error('row allocation failed'); };
  try { assert.throws(() => f.paint(), /row allocation failed/); } finally { Array.prototype.join = join; }
  assert.deepEqual(f.budget.stats(), before); assert.deepEqual(readRows(old), expected);
  const reserve = DataBudget.prototype.reserve; let calls = 0, maxPolicyPeak = before.retainedBytes;
  DataBudget.prototype.reserve = function(bytes) {
    const grant = reserve.call(this, bytes);
    if (this === f.budget) { calls++; const stats = this.stats(); maxPolicyPeak = Math.max(maxPolicyPeak, stats.retainedBytes + stats.outstandingPeakBytes); }
    return grant;
  };
  try { f.paint()!.dispose(); } finally { DataBudget.prototype.reserve = reserve; }
  for (let target = 1; target <= calls; target++) {
    let count = 0;
    DataBudget.prototype.reserve = function(bytes) { if (this === f.budget && ++count === target) return undefined; return reserve.call(this, bytes); };
    try { assert.equal(f.paint(), undefined); } finally { DataBudget.prototype.reserve = reserve; }
    assert.deepEqual(f.budget.stats(), before); assert.deepEqual(readRows(old), expected);
  }
  assert.equal(f.paint(visit => { visit(0, 1, red); f.layout.dispose(); visit(1, f.bytes, blue); return true; }), undefined);
  old.dispose(); f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ flatPaintFunding: { deniedPoints: calls, oldRetainedBytes: before.retainedBytes, maxPolicyPeak, finalBytes: f.budget.stats().retainedBytes } }));
});

test('flat paint: one range traversal and monotonic indexed geometry scale linearly without waiting for a copied range table', () => {
  const samples: { ranges: number; glyphReads: number; spanReads: number }[] = [];
  for (const count of [400, 800]) {
    const f = fixture('x'.repeat(count), 'file', 17), a = ink(1), b = ink(2);
    let traversals = 0, delivered = 0, glyphReads = 0, spanReads = 0, firstSliceAt = 0;
    const lookup = f.layout.withLookup, slice = String.prototype.slice;
    f.layout.withLookup = function(measured, consume) {
      return lookup.call(this, measured, read => consume(new Proxy(read, { get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === 'glyphByte') return (...args: [number]) => { glyphReads++; return value(...args); };
        if (key === 'span') return (...args: Parameters<typeof read.span>) => { spanReads++; return value(...args); };
        return value;
      } })));
    };
    String.prototype.slice = function(start, end) { if (this.length === count && !firstSliceAt) firstSliceAt = delivered; return slice.call(this, start, end); };
    let painted: Painted | undefined;
    try { painted = f.paint(visit => { traversals++; for (let i = 0; i < count; i++) { delivered++; visit(i, i + 1, i % 2 ? a : b); } return true; }); }
    finally { f.layout.withLookup = lookup; String.prototype.slice = slice; }
    assert.ok(painted); assert.equal(traversals, 1); assert.equal(delivered, count); assert.ok(firstSliceAt > 0 && firstSliceAt < count);
    assert.ok(glyphReads <= count * 6); assert.ok(spanReads <= f.layout.spanCount * 2);
    samples.push({ ranges: count, glyphReads, spanReads }); painted.dispose(); f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  }
  assert.ok(samples[1]!.glyphReads <= samples[0]!.glyphReads * 2.1);
  console.log(JSON.stringify({ flatPaintLinear: samples }));
});

async function collect(weak: WeakRef<object>) {
  for (let i = 0; i < 30; i++) { await turn(); global.gc!(); await turn(); if (!weak.deref()) return; }
  assert.fail('owner retained');
}
function detached(budget: DataBudget) {
  const owner = { text: 'source\t界', root: {} }, weak = new WeakRef(owner);
  const f = fixture(owner.text, 'bash', 4, budget);
  const reader: Reader = visit => { void owner.root; visit(0, f.bytes, neutral); return true; };
  const painted = f.paint(reader)!; f.dispose(); return { weak, painted };
}
test('flat paint: retained output reader survives disposal without retaining source callback/root or first output owner', async () => {
  const budget = new DataBudget(1_000_000), held = detached(budget); await collect(held.weak);
  const retained = held.painted.retain()!, weak = new WeakRef(held.painted); held.painted.dispose();
  assert.ok(readRows(retained).length > 0); const retainedReaderBytes = budget.stats().retainedBytes; assert.ok(retainedReaderBytes > 0);
  (held as { painted: Painted | undefined }).painted = undefined; await collect(weak);
  retained.dispose(); assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ flatPaintGC: { inputOwnerCollected: true, firstOutputOwnerCollected: true, retainedReaderBytes, finalBytes: budget.stats().retainedBytes } }));
});

test('flat paint: actual output array remains funded through reentrant disposal and stops after one callback', async () => {
  const f = fixture('a\nb', 'file', 2), Original = globalThis.Array; let array: WeakRef<object> | undefined;
  globalThis.Array = new Proxy(Original, { construct(target, args) { const value = Reflect.construct(target, args); array ??= new WeakRef(value); return value; } });
  let painted: Painted;
  try { painted = f.paint()!; } finally { globalThis.Array = Original; }
  await turn(); let callbacks = 0, suspendedBytes = 0;
  assert.equal(painted!.visitRows(() => {
    callbacks++; painted!.dispose(); f.dispose(); global.gc!(); assert.ok(array!.deref());
    suspendedBytes = f.budget.stats().retainedBytes; assert.ok(suspendedBytes > 0); assert.equal(f.budget.reserve(f.budget.limit), undefined);
  }), false);
  assert.equal(callbacks, 1); assert.equal(f.budget.stats().retainedBytes, 0); await collect(array!);
  assert.equal(painted!.visitRows(() => assert.fail('disposed reader')), false);
  console.log(JSON.stringify({ flatPaintPhysicalBorrow: { actualArrayHeld: true, callbacks, suspendedBytes, finalBytes: f.budget.stats().retainedBytes } }));
});

function disposedLookup() {
  const f = fixture('a\tb', 'file', 2); let escaped: Parameters<Parameters<typeof f.layout.withLookup>[1]>[0] | undefined;
  const measured = new WeakRef(f.measured), layout = new WeakRef(f.layout);
  assert.equal(f.layout.withLookup(f.measured, read => {
    escaped = read; assert.equal(read.glyphStart(0), 0); f.layout.dispose(); f.measured.dispose();
    assert.equal(read.isValid, false); assert.ok(f.budget.stats().retainedBytes > 0);
  }), false);
  assert.equal(f.budget.stats().retainedBytes, 0);
  return { escaped: escaped!, measured, layout };
}
test('flat paint: geometry indexed borrow invalidates immediately and clears escaped lookup without pinning disposed owners', async () => {
  const held = disposedLookup(), successor = fixture('active', 'file', 2);
  assert.equal(held.escaped.isValid, false); assert.throws(() => held.escaped.glyphByte(0), /stale/);
  await collect(held.measured); await collect(held.layout);
  successor.dispose(); assert.equal(successor.budget.stats().retainedBytes, 0);
});


test('flat paint: prompt-free output uses the same painter and never reads command prompt styling', async () => {
  const { terminalRows } = await import('../../../src/plain-text.ts');
  const forbidden: AnsiStyle = { get open(): string { return assert.fail('output read prompt opener'); }, get close(): string { return assert.fail('output read prompt closer'); } };
  for (const text of ['', '\tX', '界é\tend', 'abc def ghi', '\u093e\u093e\u093eX']) for (let width = 1; width <= 6; width++) {
    const budget = new DataBudget(100_000), measured = measure(text, budget)!, layout = reflow(measured, { mode: 'bash', width, prompt: false })!;
    let painted: Painted | undefined;
    try {
      const bytes = Buffer.byteLength(text);
      painted = paintFlat(text, measured, layout, all(bytes, neutral), neutral, forbidden, bytes, budget);
      assert.ok(painted); assert.deepEqual(plain(readRows(painted)), terminalRows(text, width));
    } finally { painted?.dispose(); layout.dispose(); measured.dispose(); }
    assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  }
});


function fragmentPaint(budget: DataBudget) {
  const source = { lines: ['界é\tx', '👩‍💻 next'], marker: {} }, weak = new WeakRef(source);
  const text = source.lines.join('\n'), offsets = [0, source.lines[0]!.length + 1];
  const measured = measure(text, budget)!, layout = reflow(measured, { mode: 'bash', width: 4, prompt: false })!;
  let slices = 0, traversals = 0;
  const painted = paintFlat((start, end) => {
    slices++; const line = start < offsets[1]! ? 0 : 1, offset = offsets[line]!;
    assert.ok(start >= offset && end <= offset + source.lines[line]!.length, 'one raw piece must stay within its logical source row');
    void source.marker; return source.lines[line]!.slice(start - offset, end - offset);
  }, measured, layout, visit => { traversals++; visit(0, Buffer.byteLength(text), neutral); return true; }, neutral, prompt, Buffer.byteLength(text), budget)!;
  assert.ok(painted); assert.equal(traversals, 1); assert.ok(slices > 0 && slices < measured.glyphCount);
  assert.deepEqual(plain(readRows(painted)), source.lines.flatMap(line => terminalRows(line, 4)));
  layout.dispose(); measured.dispose(); return { weak, painted, slices, traversals };
}

test('flat paint: prepared row fragments share the common painter without retaining their source owner or reader', async () => {
  const budget = new DataBudget(100_000), held = fragmentPaint(budget);
  await collect(held.weak); assert.ok(readRows(held.painted).length > 0);
  held.painted.dispose(); assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
});

test('flat paint: fragment reader throw and geometry invalidation discard funded candidates without disturbing old output', () => {
  const f = fixture('abc', 'file', 2), old = f.paint()!, before = f.budget.stats(), expected = readRows(old);
  const failure = new Error('controlled source slice failure');
  assert.throws(() => paintFlat(() => { throw failure; }, f.measured, f.layout, all(f.bytes, neutral), neutral, prompt, f.bytes, f.budget), error => error === failure);
  assert.deepEqual(f.budget.stats(), before); assert.deepEqual(readRows(old), expected);
  let slices = 0;
  assert.equal(paintFlat((start, end) => { slices++; f.layout.dispose(); return 'abc'.slice(start, end); }, f.measured, f.layout, all(f.bytes, neutral), neutral, prompt, f.bytes, f.budget), undefined);
  assert.equal(slices, 1); assert.deepEqual(readRows(old), expected);
  assert.equal(f.budget.stats().retainedBytes, old.allocationBytes + f.measured.allocationBytes);
  old.dispose(); f.dispose(); assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
});


test('flat paint: recoloring a fragment-backed source performs no segmentation, width, UTF8 or reflow work', () => {
  const text = '界é\tend', f = fixture(text, 'file', 4), firstInk = ink(1), secondInk = ink(2);
  const originalSegment = Intl.Segmenter.prototype.segment, originalCharCode = String.prototype.charCodeAt, originalBytes = Buffer.byteLength;
  const originalReflow = Reflect.get(f.measured.constructor, 'reflow');
  let widthCalls = 0, segments = 0, utf8Reads = 0, byteCalls = 0, reflows = 0, slices = 0;
  let first: Painted | undefined, second: Painted | undefined;
  hooks[widthKey] = () => { widthCalls++; throw new Error('fragment paint measured width'); };
  Intl.Segmenter.prototype.segment = () => { segments++; throw new Error('fragment paint segmented text'); };
  String.prototype.charCodeAt = () => { utf8Reads++; throw new Error('fragment paint read UTF8 scalars'); };
  Buffer.byteLength = () => { byteCalls++; throw new Error('fragment paint encoded UTF8'); };
  Reflect.set(f.measured.constructor, 'reflow', () => { reflows++; throw new Error('fragment paint reflowed text'); });
  try {
    const source = (start: number, end: number) => { slices++; return text.slice(start, end); };
    first = paintFlat(source, f.measured, f.layout, all(f.bytes, firstInk), neutral, prompt, f.bytes, f.budget);
    second = paintFlat(source, f.measured, f.layout, all(f.bytes, secondInk), neutral, prompt, f.bytes, f.budget);
  } finally {
    delete hooks[widthKey]; Intl.Segmenter.prototype.segment = originalSegment; String.prototype.charCodeAt = originalCharCode;
    Buffer.byteLength = originalBytes; Reflect.set(f.measured.constructor, 'reflow', originalReflow);
  }
  try {
    assert.ok(first && second); assert.deepEqual(plain(readRows(first)), plain(readRows(second))); assert.ok(slices > 0);
    assert.deepEqual({ widthCalls, segments, utf8Reads, byteCalls, reflows }, { widthCalls: 0, segments: 0, utf8Reads: 0, byteCalls: 0, reflows: 0 });
  } finally { first?.dispose(); second?.dispose(); f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
});


for (const behavior of ['deny', 'throw', 'invalidate'] as const) test(`review R2: replacement padding is not constructed when its piece grant must ${behavior}`, () => {
  const text = '\u093e'.repeat(3), f = fixture(text, 'file', 2), repeat = String.prototype.repeat;
  // Existing fixed policy: piece header + string header + two UTF16 cells.
  // Deny this one allocation, not a preceding operation/store/lookup grant.
  const pieceBytes = 128 + 32 + 2 * 2;
  let pieces = 0, padding = 0;
  String.prototype.repeat = function(count) { if (String(this) === ' ' && count === 1) padding++; return repeat.call(this, count); };
  try {
    const run = () => paintFlat(text, f.measured, f.layout, () => true, neutral, prompt, f.bytes, f.budget, bytes => {
      if (bytes === pieceBytes) {
        pieces++;
        if (behavior === 'deny') return undefined;
        if (behavior === 'throw') throw Error('replacement piece refused');
        f.measured.dispose();
      }
      return f.budget.reserve(bytes);
    });
    if (behavior === 'throw') assert.throws(run, /replacement piece refused/); else assert.equal(run(), undefined);
    assert.equal(pieces, 1, 'the intended replacement piece reservation was reached');
    assert.equal(padding, 0, 'variable replacement padding must follow funding and validity checks');
  } finally { String.prototype.repeat = repeat; f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
});

test('review R2: admitted replacement padding has a positive construction control and exact occupied cells', () => {
  const f = fixture('\u093e'.repeat(3), 'file', 2), repeat = String.prototype.repeat;
  let padding = 0, output: Painted | undefined;
  String.prototype.repeat = function(count) { if (String(this) === ' ' && count === 1) padding++; return repeat.call(this, count); };
  try { output = f.paint()!; assert.equal(padding, 1); assert.deepEqual(plain(readRows(output)), ['� ']); }
  finally { String.prototype.repeat = repeat; output?.dispose(); f.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
});
