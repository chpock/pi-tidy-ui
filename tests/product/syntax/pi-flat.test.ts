import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { highlightCode, initTheme } from '@earendil-works/pi-coding-agent';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import { measure, reflow } from '../../../src/syntax/measured-rows.ts';
import { paintFlat } from '../../../src/syntax/flat-paint.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import type { PiRowReader } from '../../../src/syntax/pi-flat.ts';
import xterm from '@xterm/headless';

const adapter = () => import('../../../src/syntax/pi-flat.ts');
const neutral: ConcreteStyle = Object.freeze({ foreground: Object.freeze({ kind: 'indexed', index: 7 }), background: Object.freeze({ kind: 'rgb', r: 4, g: 5, b: 6 }), attributes: 8 });
const rows = (values: readonly string[]): PiRowReader => consume => { values.forEach((value, index) => consume(index, value)); return true; };
type Projection = Extract<ReturnType<typeof import('../../../src/syntax/pi-flat.ts').preparePiFlat>, { outcome: 'ready' }>['projection'];
function ranges(projection: Projection) {
  const values: [number, number, number][] = [];
  assert.equal(projection.visitRanges((start, end, style) => values.push([start, end, style])), true); return values;
}
function styles(projection: Projection) {
  // Independent snapshots, not retained borrowed styles.
  const values: ConcreteStyle[] = [];
  assert.equal(projection.visitStyles((index, style) => { values[index] = structuredClone(style); }), true); return values;
}

test('Pi flat: one conversion retains UTF8 ranges and deduplicated literal styles, never rows or source', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  let reads = 0;
  const result = preparePiFlat('a界\t😀\né\n', consume => { reads++; return rows(['a\x1b[31m界\t😀', '\x1b[39mé', ''])(consume); }, neutral, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  const projection = result.projection;
  assert.equal(reads, 1); assert.equal(projection.sourceBytes, 14);
  assert.deepEqual(ranges(projection), [[0, 1, 0], [1, 10, 1], [10, 14, 0]]);
  assert.equal(projection.styleCount, 2);
  const values = styles(projection);
  assert.deepEqual(values[0], neutral);
  assert.deepEqual(values[1], { ...neutral, foreground: { kind: 'indexed', index: 1 } });
  for (let i = 0; i < 20; i++) ranges(projection);
  assert.equal(reads, 1, 'retained projection never revisits ANSI input');
  assert.ok(budget.stats().retainedBytes > 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  projection.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: complete fonts and resets preserve terminal defaults and neutral surface', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const caller: ConcreteStyle = { ...neutral, foreground: { kind: 'terminal-default' } };
  const result = preparePiFlat('ABCDEF', rows(['\x1b[38;2;18;52;86;48;5;2;1;2;3;4mA\x1b[22mB\x1b[23mC\x1b[24mD\x1b[39mE\x1b[0mF']), caller, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  const values = styles(result.projection);
  assert.deepEqual(ranges(result.projection).map(([from, to, style]) => [from, to, values[style]!.attributes]), [[0, 1, 15], [1, 2, 6], [2, 3, 4], [3, 4, 0], [4, 5, 0], [5, 6, 8]]);
  assert.deepEqual(values.at(-1), caller);
  for (const value of values) assert.deepEqual(value.background, neutral.background, 'Pi token backgrounds cannot override card surface');
  const ansi = values.map(value => compileStyleAnsi(value, 'truecolor'));
  let line = ''; result.projection.visitRanges((from, to, style) => { line += ansi[style]!.open + 'ABCDEF'.slice(from, to) + ansi[style]!.close; });
  const terminal = new xterm.Terminal({ cols: 12, rows: 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(line + '.', resolve));
    const row = terminal.buffer.active.getLine(0)!;
    assert.equal(row.getCell(0)!.getFgColor(), 0x123456); assert.equal(row.getCell(0)!.getBgColor(), 0x040506);
    assert.ok(row.getCell(0)!.isBold() && row.getCell(0)!.isDim() && row.getCell(0)!.isItalic() && row.getCell(0)!.isUnderline());
    assert.ok(!row.getCell(1)!.isBold() && !row.getCell(1)!.isDim());
    assert.ok(row.getCell(4)!.isFgDefault() && row.getCell(5)!.isDim());
    assert.ok(row.getCell(6)!.isFgDefault() && row.getCell(6)!.isBgDefault() && !row.getCell(6)!.isDim());
  } finally { terminal.dispose(); result.projection.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: strike survives selective font resets and clears with 29 and 0', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const result = preparePiFlat('ABCDE', rows(['\x1b[1;2;3;4;9mA\x1b[22;23;24mB\x1b[29mC\x1b[9mD\x1b[0mE']), neutral, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  try {
    const values = styles(result.projection);
    assert.deepEqual(ranges(result.projection).map(([, , style]) => values[style]!.attributes), [31, 16, 0, 16, 8]);
  } finally { result.projection.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: bad rows and controls reject the entire candidate and do not change an old projection', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const old = preparePiFlat('old', rows(['old']), neutral, budget);
  assert.equal(old.outcome, 'ready'); if (old.outcome !== 'ready') return;
  const before = budget.stats(), expected = ranges(old.projection);
  for (const reader of [rows(['a']), rows(['a', 'B']), rows(['a', 'b', '']), consume => { consume(1, 'a'); return true; }, consume => { consume(0, 'a'); consume(1, 'b'); return false; }] satisfies PiRowReader[]) {
    assert.equal(preparePiFlat('a\nb', reader, neutral, budget).outcome, 'invalid'); assert.deepEqual(budget.stats(), before);
  }
  for (const control of ['\x1b[38;2;1;2m', '\x1b[38;5;256m', '\x1b[31;;1m', '\x1b[38:2:1:2:3m', '\x1b[7m', '\x1b[2K', '\x1b]8;;url\x07', '\r', '\x00']) {
    assert.equal(preparePiFlat('x', rows([control + 'x']), neutral, budget).outcome, 'invalid', JSON.stringify(control));
    assert.deepEqual(budget.stats(), before);
  }
  assert.equal(preparePiFlat('😀', rows(['\ud83d\x1b[31m\ude00']), neutral, budget).outcome, 'invalid');
  assert.throws(() => preparePiFlat('x', () => { throw new Error('rows failed'); }, neutral, budget), /rows failed/);
  assert.deepEqual(budget.stats(), before); assert.deepEqual(ranges(old.projection), expected);
  old.projection.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: every denied allocation leaves old state intact and invalidated borrows stay charged until unwind', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(1_000_000);
  const source = 'xy'.repeat(100), highlighted = Array.from(source, (char, index) => `\x1b[38;5;${index % 8}m${char}`).join('');
  const original = DataBudget.prototype.reserve; let calls = 0;
  DataBudget.prototype.reserve = function(bytes) { if (this === budget) calls++; return original.call(this, bytes); };
  try { const result = preparePiFlat(source, rows([highlighted]), neutral, budget); assert.equal(result.outcome, 'ready'); if (result.outcome === 'ready') result.projection.dispose(); }
  finally { DataBudget.prototype.reserve = original; }
  for (let target = 1; target <= calls; target++) {
    let at = 0;
    DataBudget.prototype.reserve = function(bytes) { return this === budget && ++at === target ? undefined : original.call(this, bytes); };
    try { assert.equal(preparePiFlat(source, rows([highlighted]), neutral, budget).outcome, 'refused', `allocation ${target}`); }
    finally { DataBudget.prototype.reserve = original; }
    assert.equal(budget.stats().retainedBytes + budget.stats().outstandingPeakBytes, 0);
  }
  const result = preparePiFlat(source, rows([highlighted]), neutral, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  const held = result.projection.retain()!; assert.ok(held);
  result.projection.dispose(); assert.equal(held.isValid, true);
  assert.equal(held.visitRanges(() => {
    held.dispose(); assert.ok(budget.stats().retainedBytes > 0);
    assert.equal(budget.reserve(budget.limit), undefined, 'suspended vectors/styles cannot be spent twice');
  }), false);
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(held.visitRanges(() => assert.fail('disposed')), false);
  console.log(JSON.stringify({ piFlatDenials: calls }));
});

test('Pi flat: actual public highlight output feeds the common painter across widths without ANSI or glyph replay', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(1_000_000);
  initTheme('system', false);
  const source = 'const 界 = "😀";\n\t// é\n', highlighted = highlightCode(source, 'typescript');
  let rowVisits = 0;
  const result = preparePiFlat(source, consume => { rowVisits++; return rows(highlighted)(consume); }, neutral, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  const literals = styles(result.projection), compiled = literals.map(value => compileStyleAnsi(value, 'truecolor'));
  const measured = measure(source, budget)!, plain = compileStyleAnsi(neutral, 'truecolor');
  let sample: NonNullable<ReturnType<typeof paintFlat>> | undefined;
  const segment = Intl.Segmenter.prototype.segment, char = String.prototype.charCodeAt;
  Intl.Segmenter.prototype.segment = () => { throw new Error('segmentation repeated'); };
  String.prototype.charCodeAt = () => { throw new Error('UTF8/ANSI repeated'); };
  try {
    for (const width of [20, 40, 9]) {
      const layout = reflow(measured, { mode: 'file', width })!;
      const painted = paintFlat(source, measured, layout, consume => result.projection.visitRanges((from, to, style) => consume(from, to, compiled[style]!)), plain, plain, result.projection.sourceBytes, budget)!;
      assert.ok(painted); if (width === 40) sample = painted; else painted.dispose(); layout.dispose();
    }
  } finally { Intl.Segmenter.prototype.segment = segment; String.prototype.charCodeAt = char; result.projection.dispose(); measured.dispose(); initTheme('dark', false); }
  assert.ok(sample);
  const terminal = new xterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const reference = new xterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  try {
    let first = ''; assert.equal(sample.visitRows((index, line) => { if (!index) first = line; }), true);
    await Promise.all([new Promise<void>(resolve => terminal.write(first, resolve)), new Promise<void>(resolve => reference.write(plain.open + highlighted[0], resolve))]);
    let colored = 0;
    for (let column = 0; column < 18; column++) {
      const actual = terminal.buffer.active.getLine(0)!.getCell(column)!, expected = reference.buffer.active.getLine(0)!.getCell(column)!;
      assert.equal(actual.getChars(), expected.getChars());
      if (expected.getChars() && !expected.isFgDefault()) {
        assert.equal(actual.getFgColorMode(), expected.getFgColorMode()); assert.equal(actual.getFgColor(), expected.getFgColor());
        assert.equal(Boolean(actual.isBold()), Boolean(expected.isBold())); assert.equal(Boolean(actual.isDim()), Boolean(expected.isDim()));
        assert.equal(Boolean(actual.isItalic()), Boolean(expected.isItalic())); assert.equal(Boolean(actual.isUnderline()), Boolean(expected.isUnderline())); colored++;
      }
    }
    assert.ok(colored > 0, 'physical colors/attributes match actual public Pi tokens, not a generated self-reference');
  } finally { terminal.dispose(); reference.dispose(); sample.dispose(); }
  assert.equal(rowVisits, 1); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: empty input skips rows, late callbacks cannot mutate output and live projection holds no input owner', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const empty = preparePiFlat('', () => assert.fail('empty source visits rows'), neutral, budget);
  assert.equal(empty.outcome, 'ready'); if (empty.outcome === 'ready') { assert.deepEqual(ranges(empty.projection), []); empty.projection.dispose(); }
  let late: ((index: number, text: string) => void) | undefined;
  function create() {
    const owner = { text: 'x', lines: ['\x1b[31mx'] };
    const result = preparePiFlat(owner.text, consume => { late = consume; return rows(owner.lines)(consume); }, neutral, budget);
    assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') throw new Error('projection refused');
    return { owner: new WeakRef(owner), projection: result.projection };
  }
  const current = create(), expected = ranges(current.projection);
  late!(0, 'wrong'); assert.deepEqual(ranges(current.projection), expected);
  for (let i = 0; i < 20; i++) { await turn(); global.gc!(); }
  assert.equal(current.owner.deref(), undefined);
  current.projection.dispose(); late = undefined;
  assert.equal(budget.stats().retainedBytes + budget.stats().outstandingPeakBytes, 0);
});

test('Pi flat: invalid sources skip rows and style-table borrows retain immutable data through disposal and exceptions', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  for (const source of ['\ud800', '\udc00', '\r', '\x00', '\x1b[31mx', '\x85']) {
    assert.equal(preparePiFlat(source, () => assert.fail('invalid source visited rows'), neutral, budget).outcome, 'invalid');
    assert.equal(budget.stats().retainedBytes + budget.stats().outstandingPeakBytes, 0);
  }
  const caller = { foreground: { kind: 'indexed' as const, index: 3 }, background: { kind: 'indexed' as const, index: 2 }, attributes: 0 };
  const result = preparePiFlat('ab', rows(['a\x1b[31mb']), caller, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  caller.attributes = 8; // The adapter must not retain a mutable caller object.
  const expected = styles(result.projection); assert.equal(expected[0]!.attributes, 0);
  assert.throws(() => result.projection.visitStyles((_index, style) => {
    assert.ok(Object.isFrozen(style) && Object.isFrozen(style.foreground) && Object.isFrozen(style.background));
    result.projection.dispose();
    assert.ok(budget.stats().retainedBytes > 0); assert.equal(budget.reserve(budget.limit), undefined);
    throw new Error('style borrow failed');
  }), /style borrow failed/);
  assert.equal(budget.stats().retainedBytes + budget.stats().outstandingPeakBytes, 0);
});

test('Pi flat: RGB/index/basic/bright FG39 and empty reset restore caller neutral across rows', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const caller: ConcreteStyle = { ...neutral, attributes: 0 };
  const result = preparePiFlat('ABCDEF\n\nG\n', rows(['\x1b[38;2;17;190;93mA\x1b[39mB\x1b[38;5;255mC\x1b[0mD\x1b[90mE\x1b[37mF', '', '\x1b[97mG\x1b[m', '']), caller, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') return;
  try {
    const values = styles(result.projection);
    assert.deepEqual(ranges(result.projection).map(([from, to, id]) => [from, to, values[id]!.foreground]), [
      [0, 1, { kind: 'rgb', r: 17, g: 190, b: 93 }], [1, 2, caller.foreground], [2, 3, { kind: 'indexed', index: 255 }],
      [3, 4, caller.foreground], [4, 5, { kind: 'indexed', index: 8 }], [5, 8, { kind: 'indexed', index: 7 }],
      [8, 9, { kind: 'indexed', index: 15 }], [9, 10, caller.foreground],
    ]);
  } finally { result.projection.dispose(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi flat: malformed control corpus and nonmonotonic nonexact rows fail before publication', async () => {
  const { preparePiFlat } = await adapter(), budget = new DataBudget(100_000);
  const controls = ['\x1b[', '\x1b[31', '\x1b[38;2;256;2;3m', '\x1b[38;5;-1m', '\x1b[38;3;1m', '\x1b[48;2;1;2m', '\x1b[48;5;256m',
    '\x1b[8m', '\x1b[5m', '\x1b[21m', '\x1b[999m', '\x1bPdata\x1b\\', '\x9b31m', '\x7f'];
  for (const control of controls) assert.equal(preparePiFlat('x', rows([control + 'x']), neutral, budget).outcome, 'invalid', JSON.stringify(control));
  for (const reader of [rows(['a\nb', 'b']), consume => { consume(0, 'a'); consume(0, 'b'); return true; }, consume => { consume(0, 'a'); consume(2, 'b'); return true; }, consume => { consume(0, 'a'); consume(1.5, 'b'); return true; }] satisfies PiRowReader[]) {
    assert.equal(preparePiFlat('a\nb', reader, neutral, budget).outcome, 'invalid');
  }
  for (const [source, line] of [['\tx', '    x'], ['é', 'é'], ['😀', '�'], ['x\n', 'x']]) assert.equal(preparePiFlat(source!, rows([line!]), neutral, budget).outcome, 'invalid');
  assert.equal(budget.stats().retainedBytes + budget.stats().outstandingPeakBytes, 0);
});
