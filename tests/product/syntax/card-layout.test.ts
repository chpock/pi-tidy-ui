import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { stripVTControlCharacters as plain } from 'node:util';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import type { PreparedCard, PreparedRegion, ReadyCardPaint, CardDisplayInput } from '../../../src/syntax/cards.ts';
import type { CardLayout, CardRows, CardFunding } from '../../../src/syntax/card-layout.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { fingerprintRules, fingerprintNative } from '../../../src/occipital/style-rules.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { highlightCode } from '@earendil-works/pi-coding-agent';

const key = Symbol.for('test.card-layout.width');
const compileKey = Symbol.for('test.card-layout.compile');
let compilations = 0;
const global = globalThis as typeof globalThis & { [key]?: () => void; [compileKey]?: () => void };
global[compileKey] = () => { compilations++; };
const widthModule = 'data:text/javascript,' + encodeURIComponent(`import { visibleWidth as original } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))}; export function visibleWidth(s) { globalThis[Symbol.for('test.card-layout.width')]?.(); return original(s); }`);
const styleModule = 'data:text/javascript,' + encodeURIComponent(`import { compileStyleAnsi as original } from ${JSON.stringify(import.meta.resolve('../../../src/syntax/style-ansi.ts'))}; export function compileStyleAnsi(...args) { globalThis[Symbol.for('test.card-layout.compile')]?.(); return original(...args); }`);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('style-ansi.ts') && context.parentURL?.includes('/src/')) return { url: styleModule, shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui' && (context.parentURL?.endsWith('/src/syntax/measured-rows.ts') || context.parentURL?.endsWith('/src/card-frame.ts'))) return { url: widthModule, shortCircuit: true };
  return next(specifier, context);
} });
const { measure } = await import('../../../src/syntax/measured-rows.ts');
const { layoutCard } = await import('../../../src/syntax/card-layout.ts');
const { CardSources } = await import('../../../src/syntax/cards.ts');
const { SyntaxRuntime } = await import('../../../src/syntax/runtime.ts');
const glyphOracle = JSON.parse(readFileSync(new URL('../../fixtures/card-glyph-oracle.json', import.meta.url), 'utf8')).cases as { revision: number; width: number; outputPad: number; rows: string[] }[];
loader.deregister();
function funding(budget = new DataBudget(64_000_000)): CardFunding { return { budget, grant: bytes => budget.reserve(bytes) }; }
function fixture() {
  const f = funding(), regions: PreparedRegion[] = [];
  const region = (text: string) => { const r = { text, measured: measure(text, f.budget, f.grant)! }; regions.push(r); return r; };
  return { ...f, region, dispose() { for (const r of regions) r.measured.dispose(); assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0); } };
}
function paint(color = 2): ReadyCardPaint {
  const roles = Object.fromEntries(CARD_ROLES.map((role, i) => [role, compileStyleAnsi({ foreground: { kind: 'indexed', index: role === 'title' ? color : (i + 1) % 16 },
    background: { kind: 'indexed', index: role === 'addedCode' ? 22 : role === 'removedCode' ? 52 : role === 'addedGutter' ? 28 : role === 'removedGutter' ? 88 : 17 }, attributes: role === 'prompt' ? 8 : role === 'frame' || role === 'errorFrame' ? 7 : 0 }, 'truecolor')])) as ReadyCardPaint['roles'];
  return { publication: color, paintStamp: color, mode: 'truecolor', origin: 'native', roles, ranges: () => undefined, basis: () => false };
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
function bash(f: ReturnType<typeof fixture>, command: string, output: string[] = [], reminder = output.length): Mutable<Extract<PreparedCard, { kind: 'bash' }>> {
  return { kind: 'bash', revision: 1, geometryStamp: 1, command: f.region(command),
    service: { description: '', heading: '', output, first: 0, last: reminder, reminder, end: output.length, footer: '', error: false },
    regions: { output: output.map(s => s ? f.region(s) : undefined) } };
}
function file(f: ReturnType<typeof fixture>, texts: string[], kinds: (' ' | '+' | '-')[] = texts.map(() => ' ')): Mutable<Extract<PreparedCard, { kind: 'file' }>> {
  let offset = 0;
  return { kind: 'file', revision: 1, geometryStamp: 1, mode: 'code', error: false, diagnostics: [], heading: f.region('← Wrote a.ts'),
    rows: texts.map((text, i) => { const r = { index: i, kind: kinds[i]!, old: i + 1, next: i + 1, region: f.region(text), oldSource: { key: 'old', byte: offset, utf16: offset }, nextSource: { key: 'next', byte: offset, utf16: offset } }; offset += Buffer.byteLength(text) + 1; return r; }) };
}
function rows(output: CardRows) { const result: string[] = []; assert.equal(output.visitRows((_i, row) => result.push(row)), true); return result; }
async function terminal(output: CardRows, width: number) {
  const t = new xterm.Terminal({ cols: width, rows: Math.max(4, output.rowCount + 1), allowProposedApi: true });
  await new Promise<void>(resolve => t.write(rows(output).join('\r\n'), resolve)); return t;
}

test('card layout: prepared Bash cells, metadata separator, full text, tab stops, neutral first frame and recolor', async () => {
  const f = fixture(), d = bash(f, 'a\t界é\nlast');
  if (d.kind !== 'bash') throw Error('fixture');
  d.regions = { ...d.regions, description: f.region('# comment'), heading: f.region('# Running in /x') };
  const layout = layoutCard(d, { width: 24 }, f)!, first = layout.paint(d, paint(2), f)!;
  assert.deepEqual(rows(first).map(plain), [' ', '# comment', '# Running in /x', '', '$ a     界é', 'last', ''].map((s, i) => {
    const text = i === 0 || i === 6 ? '' : s; return ' ┃ ' + text + ' '.repeat(19 - (i === 4 ? 11 : text.length)) + '  ';
  }));
  const t = await terminal(first, 24);
  try {
    const command = t.buffer.active.getLine(4)!;
    assert.equal(command.getCell(3)!.getChars(), '$'); assert.ok(command.getCell(3)!.isDim());
    assert.equal(command.getCell(5)!.getChars(), 'a'); assert.equal(command.getCell(5)!.getFgColor(), 2);
    const stripe = command.getCell(1)!;
    assert.ok(stripe.isBgDefault() && stripe.isBold() && stripe.isItalic() && stripe.isUnderline());
    assert.equal(command.getCell(0)!.getChars(), ' '); assert.ok(command.getCell(0)!.isBgDefault());
    assert.equal(command.getCell(23)!.getChars(), ' '); assert.ok(command.getCell(23)!.isBgDefault());
  } finally { t.dispose(); }
  const next = layout.paint(d, paint(4), f)!; assert.deepEqual(rows(next).map(plain), rows(first).map(plain));
  first.dispose(); next.dispose(); layout.dispose(); f.dispose();
});

test('card layout: independent ten-visual-row output/reminder previews and expansion, footer ordering', () => {
  const f = fixture(), output = [...Array.from({ length: 12 }, (_, i) => `out${i}`), ...Array.from({ length: 12 }, (_, i) => `note${i}`)];
  const d = bash(f, 'echo x', output, 12); if (d.kind !== 'bash') throw Error('fixture');
  d.regions = { ...d.regions, footer: f.region('[exit code: 1]') };
  const layout = layoutCard(d, { width: 40 }, f)!, p = layout.paint(d, paint(), f)!;
  const text = rows(p).map(plain).join('\n');
  assert.equal((text.match(/Click to expand/g) ?? []).length, 2); assert.ok(layout.expandable);
  assert.ok(text.includes('out9') && !text.includes('out10') && text.includes('note9') && !text.includes('note10'));
  assert.ok(text.indexOf('out9') < text.indexOf('[exit code: 1]') && text.indexOf('[exit code: 1]') < text.indexOf('note0'));
  const expanded = layoutCard(d, { width: 40, expanded: true }, f)!, e = expanded.paint(d, paint(), f)!;
  assert.ok(rows(e).map(plain).join('\n').includes('note11')); assert.ok(expanded.expandable);
  p.dispose(); e.dispose(); layout.dispose(); expanded.dispose(); f.dispose();
});

test('card layout: caller-proved partial Bash prefix owns unfinished grapheme but never the new tail', async () => {
  const f = fixture(), d = bash(f, 'é👩‍💻Z'), l = layoutCard(d, { width: 40 }, f)!;
  const red = compileStyleAnsi({ foreground: { kind: 'indexed', index: 1 }, background: { kind: 'indexed', index: 17 }, attributes: 7 }, 'truecolor');
  let reads = 0;
  const p = l.paint(d, paint(2), f, { eligibleBytes: 7, ranges: cb => { reads++; cb(0, 7, red); return true; } })!;
  const t = await terminal(p, 40);
  try {
    const line = t.buffer.active.getLine(1)!;
    let tail = false;
    for (let i = 5; i < 20; i++) {
      const c = line.getCell(i)!; if (c.getChars() === 'Z') { tail = true; assert.equal(c.getFgColor(), 2); assert.ok(!c.isBold() && !c.isItalic() && !c.isUnderline()); break; }
      if (c.getChars().trim()) { assert.equal(c.getFgColor(), 1); assert.ok(c.isBold() && c.isItalic() && c.isUnderline()); }
    }
    assert.ok(tail); assert.equal(reads, 1);
  } finally { t.dispose(); p.dispose(); l.dispose(); f.dispose(); }
});

test('card layout: sparse FILE full-source byte offsets, side selection, gaps, signs, numbers and complete surfaces', async () => {
  const f = fixture(), d = file(f, ['old', '界new', 'ctx'], ['-', '+', ' ']);
  d.mode = 'diff'; d.heading = f.region('← Edited a.ts');
  d.rows = [
    { ...d.rows[0]!, old: 20, next: undefined, oldSource: { key: 'old', utf16: 99, byte: 101 } },
    { ...d.rows[1]!, old: undefined, next: 30, nextSource: { key: 'next', utf16: 500, byte: 600 } },
    { kind: 'gap', index: -1 },
    { ...d.rows[2]!, old: 90, next: 100, nextSource: { key: 'next2', utf16: 80, byte: 90 } },
  ];
  const calls: string[] = [], red = compileStyleAnsi({ foreground: { kind: 'indexed', index: 1 }, background: { kind: 'indexed', index: 52 }, attributes: 1 }, 'truecolor');
  const blue = compileStyleAnsi({ foreground: { kind: 'indexed', index: 4 }, background: { kind: 'indexed', index: 22 }, attributes: 0 }, 'truecolor');
  const p = paint(); p.ranges = (key, surface) => cb => { calls.push(key + ':' + surface); if (key === 'old') cb(101, 104, red); else if (key === 'next') cb(600, 606, blue); return true; };
  const l = layoutCard(d, { width: 60 }, f)!, out = l.paint(d, p, f)!;
  const text = rows(out).map(plain).join('\n'); assert.match(text, / 20 - old/); assert.match(text, / 30 \+ 界new/); assert.match(text, /100   ctx/); assert.match(text, /…/);
  assert.deepEqual(calls, ['old:removed', 'next:added', 'next2:undefined']);
  const t = await terminal(out, 60);
  try {
    const old = t.buffer.active.getLine(3)!, added = t.buffer.active.getLine(4)!;
    assert.equal(old.getCell(5)!.getBgColor(), 88); assert.equal(added.getCell(5)!.getBgColor(), 28);
    assert.equal(old.getCell(10)!.getChars(), 'o'); assert.equal(old.getCell(10)!.getFgColor(), 1); assert.equal(old.getCell(10)!.getBgColor(), 52);
    assert.equal(added.getCell(10)!.getChars(), '界'); assert.equal(added.getCell(10)!.getFgColor(), 4); assert.equal(added.getCell(10)!.getBgColor(), 22);
  } finally { t.dispose(); out.dispose(); l.dispose(); f.dispose(); }
});

test('card layout: split threshold, matching runs/hunks, continuation gutters, note and diagnostics', () => {
  const f = fixture(), d = file(f, ['before', 'after', 'left2', 'ctx', 'last'], ['-', '+', '-', ' ', '+']); d.mode = 'diff';
  d.rows = d.rows.map((r, i) => ({ ...r, hunk: i < 3 ? 1 : 2 })); d.note = f.region('No changes.'); d.diagnostics = [f.region('Error [3]: bad')];
  for (const width of [120, 121, 140]) {
    const l = layoutCard(d, { width }, f)!, out = l.paint(d, paint(), f)!, text = rows(out).map(plain);
    const both = text.some(s => s.includes('before') && s.includes('after'));
    assert.equal(both, width > 120); assert.ok(text.some(s => s.includes('No changes.'))); assert.ok(text.some(s => s.includes('Error [3]: bad')));
    assert.ok(!text.some(s => s.includes('left2') && s.includes('last'))); out.dispose(); l.dispose();
  }
  const small = file(f, ['abcdefghijklmnop']);
  const l = layoutCard(small, { width: 16 }, f)!, out = l.paint(small, paint(), f)!;
  const text = rows(out).map(plain); assert.ok(text.some(s => s.includes(' 1 abcdefgh'))); assert.ok(text.some(s => s.includes('   ijklmnop')));
  out.dispose(); l.dispose(); f.dispose();
});

test('card layout: narrow/zero width, inline failure, blank code, tabs and replacement geometry', () => {
  const f = fixture(), d = bash(f, '\t界é');
  for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 12]) {
    const l = layoutCard(d, { width, outputPad: 0 }, f)!, out = l.paint(d, paint(), f)!;
    if (width <= 3) assert.equal(out.rowCount, width === 0 ? 0 : l.rowCount);
    assert.ok(rows(out).every(s => !plain(s).includes('\t'))); out.dispose(); l.dispose();
  }
  const inline = file(f, []); inline.mode = 'inline'; inline.error = true; inline.heading = f.region('← Edited a.ts');
  const l = layoutCard(inline, { width: 24 }, f)!, out = l.paint(inline, paint(), f)!;
  assert.equal(l.framed, false); assert.ok(!rows(out).join('').includes('┃')); assert.ok(rows(out).map(plain).join('').includes('← Edited a.ts'));
  out.dispose(); l.dispose(); f.dispose();
});

test('card layout: warm paint/recolor and geometry-only resize do zero width, segmentation, UTF8, normalization or compilation work', () => {
  const f = fixture(), d = bash(f, '界é👩‍💻\tZ'), p = paint();
  const segment = Intl.Segmenter.prototype.segment, byteLength = Buffer.byteLength, encode = TextEncoder.prototype.encode, normalize = String.prototype.normalize;
  const compileBefore = compilations;
  const counters = { width: 0, segments: 0, utf8: 0, normalization: 0, ranges: 0, compilations: 0 };
  global[key] = () => { counters.width++; throw Error('unexpected width'); };
  Intl.Segmenter.prototype.segment = () => { counters.segments++; throw Error('unexpected segmentation'); };
  Buffer.byteLength = () => { counters.utf8++; throw Error('unexpected UTF8'); };
  TextEncoder.prototype.encode = () => { counters.utf8++; throw Error('unexpected encoding'); };
  String.prototype.normalize = () => { counters.normalization++; throw Error('unexpected normalization'); };
  const outputs: CardRows[] = [], layouts: CardLayout[] = [];
  try {
    for (const width of [24, 40, 12]) {
      const l = layoutCard(d, { width }, f)!; layouts.push(l);
      for (let i = 0; i < 3; i++) outputs.push(l.paint(d, p, f, { eligibleBytes: 1, ranges: cb => { counters.ranges++; cb(0, 1, p.roles.code); return true; } })!);
    }
  } finally {
    delete global[key]; Intl.Segmenter.prototype.segment = segment; Buffer.byteLength = byteLength; TextEncoder.prototype.encode = encode; String.prototype.normalize = normalize;
  }
  counters.compilations = compilations - compileBefore;
  assert.deepEqual(counters, { width: 0, segments: 0, utf8: 0, normalization: 0, ranges: 9, compilations: 0 });
  for (const out of outputs) { assert.ok(out); out.dispose(); } for (const l of layouts) l.dispose(); f.dispose();
  console.log(JSON.stringify({ commonCardRenderWork: counters }));
});

test('card layout: every allocation refusal and unexpected throw releases scratch/candidate while old output stays funded', () => {
  const f = fixture(), d = bash(f, 'old\ttext'), l = layoutCard(d, { width: 24 }, f)!, old = l.paint(d, paint(), f)!;
  const baseline = f.budget.stats().retainedBytes;
  let attempts = 0; const count: CardFunding = { budget: f.budget, grant: n => { attempts++; return f.grant(n); } };
  const probe = l.paint(d, paint(), count)!; probe.dispose(); const total = attempts;
  for (let stop = 1; stop <= total; stop++) {
    let n = 0; const deny: CardFunding = { budget: f.budget, grant: bytes => ++n === stop ? undefined : f.grant(bytes) };
    assert.equal(l.paint(d, paint(), deny), undefined); assert.equal(f.budget.stats().retainedBytes, baseline); assert.ok(old.isValid);
  }
  for (let stop = 1; stop <= total; stop++) {
    let n = 0; const throwing: CardFunding = { budget: f.budget, grant: bytes => { if (++n === stop) throw Error('injected'); return f.grant(bytes); } };
    assert.throws(() => l.paint(d, paint(), throwing), /injected/); assert.equal(f.budget.stats().retainedBytes, baseline);
  }
  attempts = 0; const layoutProbe = layoutCard(d, { width: 12 }, count)!; layoutProbe.dispose();
  for (let stop = 1; stop <= attempts; stop++) {
    let n = 0; assert.equal(layoutCard(d, { width: 12 }, { budget: f.budget, grant: bytes => ++n === stop ? undefined : f.grant(bytes) }), undefined);
    assert.equal(f.budget.stats().retainedBytes, baseline);
  }
  console.log(JSON.stringify({ cardAllocationRefusals: { paint: total, layout: attempts } }));
  old.dispose(); l.dispose(); f.dispose();
});

test('card layout: false member and active-reader disposal invalidate whole candidate with charged overlap until unwind', () => {
  const f = fixture(), d = file(f, ['abc', 'def']), l = layoutCard(d, { width: 24 }, f)!, p = paint();
  const baseline = f.budget.stats().retainedBytes;
  p.ranges = () => cb => { cb(0, 3, p.roles.code); return false; };
  assert.equal(l.paint(d, p, f), undefined); assert.equal(f.budget.stats().retainedBytes, baseline);
  let overlap = 0;
  p.ranges = () => cb => { cb(0, 3, p.roles.code); l.dispose(); overlap = f.budget.stats().retainedBytes; return true; };
  assert.equal(l.paint(d, p, f), undefined); assert.ok(overlap > 0); assert.equal(l.isValid, false);
  const replacement = layoutCard(d, { width: 24 }, f)!, out = replacement.paint(d, paint(), f)!;
  let during = 0; assert.equal(out.visitRows(() => { out.dispose(); during = f.budget.stats().retainedBytes; }), false); assert.ok(during > 0);
  replacement.dispose(); f.dispose();
});

test('card layout: dense many-row/multi-source projection visits each reader once, not once per row', () => {
  const observed: { rows: number; readers: number; ranges: number; geometryValidityChecks: number }[] = [];
  for (const count of [100, 200, 400]) {
    const f = fixture(), d = file(f, Array.from({ length: count }, () => 'abc'));
    d.rows = d.rows.map((r, i) => ({ ...r, nextSource: { key: 'source' + Math.floor(i / 20), utf16: (i % 20) * 4, byte: (i % 20) * 4 } }));
    const p = paint(); let readers = 0, ranges = 0;
    p.ranges = () => cb => { readers++; for (let i = 0; i < 20; i++) for (let j = 0; j < 3; j++) { ranges++; cb(i * 4 + j, i * 4 + j + 1, p.roles.code); } return true; };
    const l = layoutCard(d, { width: 40 }, f)!;
    const prototype = Object.getPrototypeOf(d.rows[0]!.region!.measured), descriptor = Object.getOwnPropertyDescriptor(prototype, 'isValid')!;
    let checks = 0, out: CardRows | undefined;
    Object.defineProperty(prototype, 'isValid', { ...descriptor, get() { checks++; return descriptor.get!.call(this); } });
    try { out = l.paint(d, p, f)!; } finally { Object.defineProperty(prototype, 'isValid', descriptor); }
    assert.ok(out); assert.equal(readers, count / 20); assert.equal(ranges, count * 3); observed.push({ rows: count, readers, ranges, geometryValidityChecks: checks });
    out.dispose(); l.dispose(); f.dispose();
  }
  assert.equal(observed[2]!.geometryValidityChecks - observed[1]!.geometryValidityChecks, 2 * (observed[1]!.geometryValidityChecks - observed[0]!.geometryValidityChecks));
  console.log(JSON.stringify({ commonProjectionScaling: observed }));
});

function realCards() {
  let classifications = 0, samples = 0, sourceStyle = 0;
  const provider = { snapshot: () => ({ generation: 1, availability: 'initializing' as const, reason: 'initializing' as const, kind: 'owned' as const, initialShared: false }),
    isReady: () => false, classificationAccepted: () => false, request: async () => { sourceStyle++; throw Error('unexpected SOURCE/STYLE'); } };
  const sources = new SourceController(provider), runtime = new SyntaxRuntime({ standaloneVersion: '0.0.0', settings: { load: async () => ({ ok: true, syntaxTheme: { kind: 'pi' } }), update: async () => ({ ok: true }) },
    provider: { tryShared: async () => undefined, acquireOwned: async () => { throw Error('unexpected provider'); } } });
  const theme = getThemeByName('system')!;
  const sampled = { colors: theme.colors, getFgAnsi(role: Parameters<typeof theme.getFgAnsi>[0]) { samples++; return theme.getFgAnsi(role); }, getBgAnsi(role: Parameters<typeof theme.getBgAnsi>[0]) { samples++; return theme.getBgAnsi(role); } };
  runtime.palette(sampled);
  const cards = new CardSources<object>({ sources, snapshot: () => ({ enabled: true, provider: provider.snapshot(), selected: { kind: 'pi' },
    effective: { id: 'pi', label: 'Pi', fingerprint: fingerprintRules(createPiRuleDefinition()) }, standaloneVersion: 'test' }) },
  { preparePiInput: f => runtime.preparePiInput(sampled, 'truecolor', f), classify: text => { classifications++; return highlightCode(text, 'typescript'); }, invalidate() {}, requestRender() {} });
  const input: CardDisplayInput = { kind: 'bash', args: { command: 'echo x' }, complete: true, revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor' };
  return { cards, sources, runtime, input, counters: () => ({ classifications, samples, sourceStyle, compilations }) };
}

test('card layout: real C9 outer transaction rejects returned candidates, construction invalidation and throws without retiring accepted output', async () => {
  const f = realCards(), owner = {}; assert.equal(f.cards.updateDisplay(owner, f.input), true);
  const funding = f.sources.geometryFunding()!;
  let acceptedLayout: CardLayout | undefined, acceptedRows: CardRows | undefined;
  assert.equal(f.cards.visit(owner, (d, p) => { acceptedLayout = layoutCard(d, { width: 24 }, funding)!; acceptedRows = acceptedLayout.paint(d, p, funding)!; }), true);
  const before = f.counters();
  for (const width of [24, 40, 12]) assert.equal(f.cards.visit(owner, (d, p) => {
    const layout = layoutCard(d, { width }, funding)!;
    try { for (let i = 0; i < 3; i++) { const output = layout.paint(d, p, funding)!; output.dispose(); } }
    finally { layout.dispose(); }
  }), true);
  assert.deepEqual(f.counters(), before);
  console.log(JSON.stringify({ realCardWarmDelta: { classifications: 0, samples: 0, sourceStyle: 0, compilations: 0, paints: 9, widths: 3 } }));
  let layout: CardLayout | undefined, output: CardRows | undefined, committed = false;
  try {
    committed = f.cards.visit(owner, (d, p) => { layout = layoutCard(d, { width: 40 }, funding)!; output = layout.paint(d, p, funding)!; f.cards.updateDisplay(owner, { ...f.input, revision: 2, serviceRevision: 2 }); assert.ok(output.isValid); });
  } finally { if (!committed) { output?.dispose(); layout?.dispose(); } }
  assert.equal(committed, false); assert.ok(acceptedRows!.isValid); assert.equal(output!.isValid, false);
  assert.equal(f.counters().classifications, before.classifications);
  assert.equal(f.counters().sourceStyle, before.sourceStyle);
  assert.equal(f.cards.updateDisplay(owner, { ...f.input, revision: 3 }), true);
  let grants = 0;
  assert.throws(() => f.cards.visit(owner, (d, p) => {
    const interrupted: CardFunding = { budget: funding.budget, grant: n => { if (++grants === 2) { f.cards.remove(owner); acceptedRows!.dispose(); acceptedLayout!.dispose(); throw Error('construction failure'); } return funding.grant(n); } };
    layoutCard(d, { width: 24 }, interrupted); void p;
  }), /construction failure/);
  assert.equal(f.cards.updateDisplay(owner, { ...f.input, revision: 4 }), true);
  let interruptedLayout: CardLayout | undefined, removalGrants = 0;
  assert.equal(f.cards.visit(owner, d => {
    interruptedLayout = layoutCard(d, { width: 24 }, { budget: funding.budget, grant: n => { if (++removalGrants === 2) f.cards.remove(owner); return funding.grant(n); } });
  }), false);
  assert.equal(interruptedLayout, undefined);
  assert.equal(acceptedRows!.isValid, false, 'real lifecycle removal releases the previous cache too');
  assert.equal(f.cards.updateDisplay(owner, { ...f.input, revision: 5 }), true);
  let replacement: CardLayout | undefined, replacementRows: CardRows | undefined;
  assert.equal(f.cards.visit(owner, (d, p) => { replacement = layoutCard(d, { width: 24 }, funding)!; replacementRows = replacement.paint(d, p, funding)!; }), true);
  replacementRows!.dispose(); replacement!.dispose(); acceptedRows!.dispose(); acceptedLayout!.dispose();
  f.cards.dispose(); f.sources.dispose(); await f.runtime.dispose(); await turn();
  assert.equal(funding.budget.stats().retainedBytes, 0); assert.equal(funding.budget.stats().outstandingPeakBytes, 0);
  console.log(JSON.stringify({ realCardTransactionWork: { ...before, after: f.counters() } }));
});


test('card layout: fixed stripe background override preserves prepared normal/error typography and error footer versus muted reminder', async () => {
  const f = fixture(), d = bash(f, 'x', ['note'], 0);
  d.service = { ...d.service, error: true }; d.regions = { ...d.regions, footer: f.region('[error]') };
  const p = paint();
  for (const width of [1, 2, 3, 6, 24]) {
    const l = layoutCard(d, { width, outputPad: 0 }, f)!, out = l.paint(d, p, f)!, t = await terminal(out, width);
    try {
      if (width > 1) {
        const stripe = t.buffer.active.getLine(1)!.getCell(0)!;
        assert.equal(stripe.getChars(), '┃'); assert.ok(stripe.isBgDefault());
        assert.ok(stripe.isBold() && stripe.isItalic() && stripe.isUnderline());
        assert.equal(stripe.getFgColor(), (CARD_ROLES.indexOf('errorFrame') + 1) % 16);
      }
      if (width === 24) {
        const footerIndex = rows(out).map(plain).findIndex(s => s.includes('[error]'));
        const reminderIndex = rows(out).map(plain).findIndex(s => s.includes('note'));
        const footer = t.buffer.active.getLine(footerIndex)!.getCell(2)!;
        const reminder = t.buffer.active.getLine(reminderIndex)!.getCell(2)!;
        assert.equal(footer.getFgColor(), (CARD_ROLES.indexOf('error') + 1) % 16);
        assert.notEqual(footer.getFgColor(), (CARD_ROLES.indexOf('footer') + 1) % 16);
        assert.equal(reminder.getFgColor(), (CARD_ROLES.indexOf('reminder') + 1) % 16);
        assert.equal(footer.getBgColor(), 17); assert.ok(!footer.isBold() && !footer.isItalic() && !footer.isUnderline());
      }
    } finally { t.dispose(); out.dispose(); l.dispose(); }
  }
  f.dispose();
});

test('card layout: detached receipts do not retain layout, output, borrowed display or palette; explicit GC receipts refund all storage', async () => {
  const f = fixture();
  function create() {
    const d = bash(f, 'not retained'), p = paint(), layout = layoutCard(d, { width: 24 }, f)!, output = layout.paint(d, p, f)!;
    return { refs: [new WeakRef(d), new WeakRef(p), new WeakRef(layout), new WeakRef(output)], receipts: [layout.cleanupReceipt(), output.cleanupReceipt()] };
  }
  const { refs, receipts } = create();
  for (let i = 0; i < 60; i++) { await turn(); globalThis.gc!(); await turn(); if (refs.every(ref => !ref.deref())) break; }
  assert.ok(refs.every(ref => !ref.deref()), 'numeric receipts must not retain payload owners');
  for (const receipt of receipts) receipt.release();
  f.dispose();
});

test('card layout: FILE projection allocations refuse atomically and service preview geometry also unwinds every refusal', () => {
  const f = fixture(), d = file(f, ['abc', 'def']), p = paint();
  p.ranges = () => cb => { for (let i = 0; i < 7; i++) cb(i, i + 1, p.roles.code); return true; };
  const l = layoutCard(d, { width: 24 }, f)!, baseline = f.budget.stats().retainedBytes;
  let count = 0;
  const probe = l.paint(d, p, { budget: f.budget, grant: bytes => { count++; return f.grant(bytes); } })!; probe.dispose();
  for (let stop = 1; stop <= count; stop++) {
    let seen = 0; assert.equal(l.paint(d, p, { budget: f.budget, grant: bytes => ++seen === stop ? undefined : f.grant(bytes) }), undefined);
    assert.equal(f.budget.stats().retainedBytes, baseline);
  }
  const b = bash(f, 'x', ['a b', '', 'z']), before = f.budget.stats().retainedBytes;
  let calls = 0;
  const probeLayout = layoutCard(b, { width: 12 }, { budget: f.budget, grant: bytes => { calls++; return f.grant(bytes); } })!; probeLayout.dispose();
  for (let stop = 1; stop <= calls; stop++) {
    let seen = 0; assert.equal(layoutCard(b, { width: 12 }, { budget: f.budget, grant: bytes => ++seen === stop ? undefined : f.grant(bytes) }), undefined);
    assert.equal(f.budget.stats().retainedBytes, before);
  }
  console.log(JSON.stringify({ cardAdditionalRefusals: { filePaint: count, serviceLayout: calls } }));
  l.dispose(); f.dispose();
});


test('card layout: C7 group membership and indexed lookup work is linear within nested projection transactions', async () => {
  const observed: { members: number; emittedRanges: number; currentDisplayChecks: number; memberKeyReads: number }[] = [];
  for (const [size, rangeCount] of [[4, 1], [8, 1], [16, 1], [64, 1], [4, 32], [4, 128]] as const) {
    const description = decodeSemanticDescription(semanticDescriptor('describe', 'instance', []), 'describe');
    const pending: { q: Record<string, any>; resolve(value: unknown): void; reject(error: unknown): void; done: boolean }[] = [];
    const provider = { snapshot: () => ({ generation: 1, availability: 'ready' as const, reason: 'ready' as const, kind: 'shared' as const, initialShared: true, description }),
      isReady: (g: number) => g === 1, classificationAccepted: () => true,
      request: (_g: number, q: Record<string, any>) => new Promise<unknown>((resolve, reject) => pending.push({ q, resolve, reject, done: false })) };
    const source = new SourceController(provider);
    const keys = new Set(Array.from({ length: size }, (_, i) => 'member:' + i));
    const preparation = { keys, prepare() { for (const key of keys) source.observe({ key, text: 'x'.repeat(rangeCount!), version: 1, complete: true, language: 'text', profile: 'native', fingerprint: 'a'.repeat(64) }); }, needsRefresh: () => false, requiresCredit: () => false };
    const group = source.registerPreparation(preparation)!;
    source.setStyleSelection({ kind: 'native', id: 'native', fingerprint: 'a'.repeat(64) }); source.queuePreparation(group, true); source.flush();
    try {
      for (let turns = 0; turns < 100 && !source.groupPresentation(group); turns++) {
        await turn();
        for (const item of pending) if (!item.done) {
          item.done = true; const q = item.q, s = q.sources?.[0] ?? q;
          const body = q.op === 'styles.resolve' ? { kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintNative(q.rules.fingerprint, 'rules'),
            styles: [{ foreground: { kind: 'indexed', index: 2 }, background: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 15 }], indices: q.contexts.map(() => 1),
            palette: { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } }
            : { kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: s.key, generation: s.generation, source_version: s.source_version, revision: 1, source_bytes: rangeCount,
              replace_from: 0, committed_bytes: rangeCount, complete: true, contexts: rangeCount === 1 ? [[0, 1]] : [[0, 1], [0, 2]], runs: Array.from({ length: rangeCount! }, (_, i) => [1, i % 2 + 1]).flat(), counters: { committed_line_calls: 1, committed_line_bytes: rangeCount, tail_calls: 0, tail_bytes: 0 } }] };
          item.resolve({ v: 3, ticket: q.ticket, instance: description.instance, assets: description.assets, status: 'ok', body });
        }
      }
      const view = source.groupPresentation(group); assert.ok(view);
      const original = Reflect.get(source, 'currentDisplay') as (...args: unknown[]) => unknown;
      let checks = 0, ranges = 0, keyReads = 0;
      const work = Reflect.get(source, 'work') as Map<unknown, { ready: { members: any } }>;
      const members = work.get(group)!.ready.members;
      for (const member of members instanceof Map ? members.values() : members) {
        const key = member.key;
        Object.defineProperty(member, 'key', { configurable: true, get() { keyReads++; return key; } });
      }
      Reflect.set(source, 'currentDisplay', function(this: SourceController, ...args: unknown[]) { checks++; return original.apply(this, args); });
      try {
        assert.equal(view.visit(() => { for (const key of keys) {
          let read: import('../../../src/occipital/controller.ts').DisplayRangeReader | undefined;
          assert.equal(view.visit(member => { read = member(key)!.read; }), true);
          assert.equal(read!(() => { ranges++; assert.ok(view.role('code')); }), true);
        } }), true);
      } finally { Reflect.set(source, 'currentDisplay', original); }
      assert.equal(ranges, size! * rangeCount!);
      observed.push({ members: size!, emittedRanges: ranges, currentDisplayChecks: checks, memberKeyReads: keyReads });
      console.log(JSON.stringify({ controllerGroupReadScaling: observed.at(-1) }));
      assert.ok(checks >= 2 * size, 'outer entry and exit must validate every actual member');
      assert.ok(checks <= 12 * size! + 4 * ranges, `whole-membership work exceeded linear bound: ${checks}`);
      assert.ok(keyReads <= 8 * size! + 2 * ranges, `member lookup work exceeded linear bound: ${keyReads}`);
    } finally {
      source.dispose(); for (const item of pending) item.reject(new RequestFailure('cleanup', 'not_started'));
      for (let i = 0; i < 8; i++) await turn();
      assert.equal(source.stats().globalUnsettledJobs, 0); assert.equal(source.stats().retention.retainedBytes, 0); void preparation;
    }
  }
  console.log(JSON.stringify({ linearC7MembershipScaling: observed }));
});


test('card layout: actual card demand and controller lookups are linear across nested reads', async () => {
  const observed: { members: number; ranges: number; currentDisplayChecks: number; slotKeyReads: number }[] = [];
  for (const segments of [2, 4, 8, 32]) {
    const description = decodeSemanticDescription(semanticDescriptor('describe', 'instance', []), 'describe');
    const pending: { q: Record<string, any>; resolve(value: unknown): void; reject(error: unknown): void; done: boolean }[] = [];
    const provider = { snapshot: () => ({ generation: 1, availability: 'ready' as const, reason: 'ready' as const, kind: 'shared' as const, initialShared: true, description }),
      isReady: (g: number) => g === 1, classificationAccepted: () => true,
      request: (_g: number, q: Record<string, any>) => new Promise<unknown>((resolve, reject) => pending.push({ q, resolve, reject, done: false })) };
    const source = new SourceController(provider, { onChange(keys, groups) { cards.sourceChanged(keys, groups); } }), owner = {};
    const cards = new CardSources<object>({ sources: source, snapshot: () => ({ enabled: true, provider: provider.snapshot(), selected: { kind: 'occipital', id: 'native' },
      effective: { id: 'native', label: 'native', fingerprint: 'a'.repeat(64) }, standaloneVersion: 'test' }) },
    { preparePiInput: () => undefined, classify: () => assert.fail('native card classified with Pi'), invalidate() {}, requestRender() {} });
    source.setStyleSelection({ kind: 'native', id: 'native', fingerprint: 'a'.repeat(64) });
    const input: CardDisplayInput = { kind: 'file', revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor', language: 'text',
      node: { toolName: 'edit', args: { path: 'a.txt' }, isPartial: false, result: { details: { diff: Array.from({ length: segments }, (_, i) => `-${i * 10 + 1} x\n+${i * 10 + 1} y`).join('\n   ...\n') } } } };
    try {
      assert.equal(cards.updateDisplay(owner, input), true); cards.useful(owner, 1); source.flush();
      for (let turns = 0; turns < 100; turns++) {
        await turn();
        for (const item of pending) if (!item.done) {
          item.done = true; const q = item.q, s = q.sources?.[0] ?? q, bytes = Buffer.byteLength(s.text ?? '');
          const body = q.op === 'styles.resolve' ? { kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintNative(q.rules.fingerprint, 'rules'),
            styles: [{ foreground: { kind: 'indexed', index: 2 }, background: { kind: 'terminal-default' }, attributes: 0, attribute_mask: 15 }], indices: q.contexts.map(() => 1),
            palette: { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } }
            : { kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: s.key, generation: s.generation, source_version: s.source_version, revision: 1, source_bytes: bytes,
              replace_from: 0, committed_bytes: bytes, complete: true, contexts: [[0, 1]], runs: [bytes, 1], counters: { committed_line_calls: 1, committed_line_bytes: bytes, tail_calls: 0, tail_bytes: 0 } }] };
          item.resolve({ v: 3, ticket: q.ticket, instance: description.instance, assets: description.assets, status: 'ok', body });
        }
        cards.metadataChanged();
        let native = false; cards.visit(owner, (_d, p) => { native = p.origin === 'native'; }); if (native) break;
      }
      const state = (Reflect.get(cards, 'states') as WeakMap<object, { slots: readonly { key: string }[] | ReadonlyMap<string, { key: string }> }>).get(owner)!;
      const slots = Array.from(state.slots.values()), keys = slots.map(slot => slot.key), count = keys.length; assert.equal(count, segments * 2);
      let checks = 0, ranges = 0, slotReads = 0;
      for (const slot of slots) { const key = slot.key; Object.defineProperty(slot, 'key', { configurable: true, get() { slotReads++; return key; } }); }
      const original = Reflect.get(source, 'currentDisplay') as (...args: unknown[]) => unknown, before = source.stats(), calls = pending.length;
      Reflect.set(source, 'currentDisplay', function(this: SourceController, ...args: unknown[]) { checks++; return original.apply(this, args); });
      try { assert.equal(cards.visit(owner, (_d, p) => {
        assert.equal(p.origin, 'native');
        for (const key of keys) {
          for (const surface of [undefined, 'added', 'removed'] as const) {
            const read = p.ranges(key, surface); assert.ok(read); assert.equal(read(() => { ranges++; }), true);
          }
          assert.equal(p.basis(key, (text, read) => { assert.ok(text.length); assert.equal(read(() => { ranges++; }), true); }), true);
        }
        assert.equal(p.ranges('foreign:key'), undefined); assert.equal(p.basis('foreign:key', () => assert.fail('foreign source emitted text')), false);
      }), true); } finally { Reflect.set(source, 'currentDisplay', original); }
      assert.equal(ranges, 4 * count); assert.ok(checks <= 8 * count + 4 * ranges);
      assert.ok(slotReads <= 2 * count, `card demand lookup must be linear: ${slotReads} key reads for ${count} sources`);
      assert.equal(pending.length, calls); assert.equal(source.stats().stylePreparations, before.stylePreparations);
      observed.push({ members: count, ranges, currentDisplayChecks: checks, slotKeyReads: slotReads });
    } finally {
      cards.dispose(); source.dispose(); for (const item of pending) item.reject(new RequestFailure('cleanup', 'not_started'));
      for (let i = 0; i < 8; i++) await turn();
      assert.equal(source.stats().retention.retainedBytes, 0); assert.equal(source.stats().retention.outstandingPeakBytes, 0); assert.equal(source.stats().globalUnsettledJobs, 0);
    }
  }
  console.log(JSON.stringify({ actualC9ControllerBorrowScaling: observed }));
});

test('card layout: actual C9 FILE exact projection then stale reader removal refuses colors without source recovery or geometry changes', async () => {
  const f = realCards(), owner = {};
  const input: CardDisplayInput = { kind: 'file', revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor', language: 'typescript',
    node: { toolName: 'write', args: { path: 'a.ts', content: 'const x = 1;' }, isPartial: false, result: {} } };
  assert.equal(f.cards.updateDisplay(owner, input), true); f.cards.useful(owner, 1);
  for (let i = 0; i < 8; i++) await turn();
  const funding = f.sources.geometryFunding()!, before = f.counters();
  assert.equal(before.classifications, 1);
  let layout: CardLayout | undefined, out: CardRows | undefined, sourceKey = '';
  assert.equal(f.cards.visit(owner, (d, p) => {
    assert.equal(d.kind, 'file'); if (d.kind !== 'file') return;
    sourceKey = d.rows[0]!.nextSource!.key;
    assert.ok(p.ranges(sourceKey)); layout = layoutCard(d, { width: 40 }, funding)!; out = layout.paint(d, p, funding)!;
  }), true);
  const original = rows(out!).map(plain); out!.dispose();
  f.sources.remove(sourceKey);
  assert.equal(f.cards.visit(owner, (d, p) => {
    assert.equal(p.ranges(sourceKey), undefined); out = layout!.paint(d, p, funding)!;
  }), true);
  assert.deepEqual(rows(out!).map(plain), original); assert.deepEqual(f.counters(), before);
  out!.dispose(); layout!.dispose(); f.cards.dispose(); f.sources.dispose(); await f.runtime.dispose();
  assert.equal(funding.budget.stats().retainedBytes, 0);
});


test('card layout: supplementary legacy-policy oracle retains complete text across padding, split threshold and tiny widths', async () => {
  const f = realCards(), owner = {}, funding = f.sources.geometryFunding()!;
  const bashNode = { args: { command: 'a\t界é\nb', description: 'run it' }, expanded: false, isPartial: false,
    result: { content: [{ type: 'text', text: 'out\n\n<system-reminder>\nremember\n</system-reminder>' }], details: { exit_code: 1 }, isError: true } };
  const inputs: CardDisplayInput[] = [
    { ...f.input, kind: 'bash', node: bashNode, args: bashNode.args, directory: '/work', revision: 1, sourceRevision: 1, serviceRevision: 1 },
    { kind: 'file', revision: 2, sourceRevision: 2, serviceRevision: 2, palette: 1, mode: 'truecolor', node: { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false,
      result: { details: { diff: '-20 old\n+20 new\n-21 again\n   ...\n+90 later', diagnostics: [{ severity: 'error', line: 90, message: 'bad' }] } } } },
    { kind: 'file', revision: 3, sourceRevision: 3, serviceRevision: 3, palette: 1, mode: 'truecolor', node: { toolName: 'write', args: { path: 'a.ts', content: 'abc def\n\t界é' }, isPartial: false, result: {} } },
    { kind: 'file', revision: 4, sourceRevision: 4, serviceRevision: 4, palette: 1, mode: 'truecolor', node: { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { isError: true } } },
  ];
  try {
    for (const input of inputs) {
      assert.equal(f.cards.updateDisplay(owner, input), true);
      for (const width of [0, 1, 2, 6, 24, 60, 120, 121, 140]) for (const outputPad of [0, 1]) {
        assert.equal(f.cards.visit(owner, (d, p) => {
          const layout = layoutCard(d, { width, outputPad }, funding)!, out = layout.paint(d, p, funding)!;
          try {
            const expected = glyphOracle.find(c => c.revision === input.revision && c.width === width && c.outputPad === outputPad)!;
            assert.deepEqual(rows(out).map(plain), expected.rows, `${input.kind} revision=${input.revision} width=${width} pad=${outputPad}`);
          } finally { out.dispose(); layout.dispose(); }
        }), true);
      }
    }
  } finally { f.cards.dispose(); f.sources.dispose(); await f.runtime.dispose(); }
  assert.equal(funding.budget.stats().retainedBytes, 0);
});


test('card layout: ordered card demand reuse retires absent FILE keys and preserves exact Pi reads', async () => {
  const f = realCards(), owner = {};
  const diff = (segments: number) => Array.from({ length: segments }, (_, i) => `-${i * 10 + 1} const old${i} = 1;\n+${i * 10 + 1} const next${i} = 2;`).join('\n   ...\n');
  const input: CardDisplayInput = { kind: 'file', revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor', language: 'typescript',
    node: { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { details: { diff: diff(3) } } } };
  const settle = async () => { for (let i = 0; i < 8; i++) await turn(); };
  try {
    assert.equal(f.cards.updateDisplay(owner, input), true); f.cards.useful(owner, 1); f.sources.flush(); await settle();
    const original = f.cards.identities(owner); assert.equal(original.length, 6);
    const before = f.counters();
    assert.equal(f.cards.updateDisplay(owner, { ...input, revision: 2, serviceRevision: 2 }), true);
    f.cards.useful(owner, 2); f.sources.flush(); await settle();
    assert.deepEqual(f.cards.identities(owner), original); assert.equal(f.counters().classifications, before.classifications);
    const changed: CardDisplayInput = { ...input, revision: 3, sourceRevision: 2, serviceRevision: 3,
      node: { ...input.node, result: { details: { diff: '-1 const smaller = 3;\n+1 const smaller = 4;' } } } };
    assert.equal(f.cards.updateDisplay(owner, changed), true); f.cards.useful(owner, 3); f.sources.flush(); await settle();
    const current = f.cards.identities(owner); assert.equal(current.length, 2);
    assert.deepEqual(current.map(i => i.key), original.slice(0, 2).map(i => i.key));
    assert.ok(current.every(i => i.version === 2 && i.fallback === 'pi'));
    assert.equal(f.cards.visit(owner, (_d, p) => {
      assert.equal(p.origin, 'pi');
      for (const item of current) { let ranges = 0; assert.equal(p.ranges(item.key)!(() => { ranges++; }), true); assert.ok(ranges); }
      for (const item of original.slice(2)) { assert.equal(p.ranges(item.key), undefined); assert.equal(f.sources.piProjection(item.key, item.version, item.palette), undefined); }
    }), true);
    const stable = f.counters();
    for (let i = 0; i < 20; i++) assert.equal(f.cards.visit(owner, (_d, p) => {
      for (const item of current) assert.equal(p.ranges(item.key)!(() => {}), true);
    }), true);
    assert.deepEqual(f.counters(), stable); assert.equal(stable.sourceStyle, 0);
    f.cards.remove(owner); assert.deepEqual(f.cards.identities(owner), []);
    assert.equal(f.cards.visit(owner, () => assert.fail('removed demands remained useful')), false);
  } finally {
    f.cards.dispose(); f.sources.dispose(); await f.runtime.dispose();
    assert.equal(f.sources.stats().retention.retainedBytes, 0); assert.equal(f.sources.stats().retention.outstandingPeakBytes, 0);
  }
});


for (const multiline of [false, true]) test(`card layout: bounded preview kernel reads and funded layout/paint stop inside long ${multiline ? 'multiple' : 'single'} logical output and reminder lines`, () => {
  const observed: Record<string, unknown>[] = [];
    const runs = [];
    for (const length of [2000, 20000]) {
      const f = fixture(), Original = globalThis.Uint32Array;
      let phase: 'idle' | 'layout' | 'paint' = 'idle';
      const reads = { layout: 0, paint: 0 }, granted = { layout: 0, paint: 0 };
      // Observe actual numeric reads of the retained measurement vectors, not a
      // caller's row count or a replacement wrapping implementation.
      globalThis.Uint32Array = new Proxy(Original, { construct(target, args) {
        const words = Reflect.construct(target, args) as Uint32Array;
        return new Proxy(words, { get(array, property) {
          if (phase !== 'idle' && typeof property === 'string' && /^\d+$/.test(property)) reads[phase]++;
          return Reflect.get(array, property, array);
        } });
      } });
      let d: ReturnType<typeof bash>;
      const prefix = multiline ? Array<string>(8).fill('7'.repeat(20)) : [];
      const notes = multiline ? Array<string>(8).fill('8'.repeat(20)) : [];
      try { d = bash(f, 'cmd', [...prefix, '7'.repeat(length), ...notes, '8'.repeat(length)], prefix.length + 1); }
      finally { globalThis.Uint32Array = Original; }
      const p = paint(), counted: CardFunding = { budget: f.budget, grant: bytes => {
        if (phase !== 'idle') granted[phase] += bytes;
        return f.grant(bytes);
      } };
      phase = 'layout';
      const l = layoutCard(d!, { width: 25 }, counted)!;
      phase = 'paint'; const out = l.paint(d!, p, counted)!; phase = 'idle';
      const text = rows(out).map(plain).join('\n');
      assert.equal((text.match(/7/g) ?? []).length, 200);
      assert.equal((text.match(/8/g) ?? []).length, 200);
      assert.equal((text.match(/Click to expand/g) ?? []).length, 2);
      assert.ok(l.expandable);
      runs.push({ length, reads: { ...reads }, granted: { ...granted } });
      out.dispose(); l.dispose();
      reads.layout = reads.paint = granted.layout = granted.paint = 0;
      phase = 'layout'; const expanded = layoutCard(d!, { width: 25, expanded: true }, counted)!;
      phase = 'paint'; const full = expanded.paint(d!, p, counted)!; phase = 'idle';
      const complete = rows(full).map(plain).join('\n');
      assert.equal((complete.match(/7/g) ?? []).length, length + prefix.length * 20);
      assert.equal((complete.match(/8/g) ?? []).length, length + notes.length * 20);
      assert.ok(!complete.includes('Click to expand'));
      assert.ok(reads.layout > length * 4 && reads.paint > length * 4, 'expanded control must traverse the complete measured source');
      assert.ok(reads.layout < (length + prefix.length * 20) * 5 && reads.paint < (length + notes.length * 20) * 7, 'expanded geometry and paint must remain linear in the complete source');
      observed.push({ multiline, collapsed: runs.at(-1), expanded: { reads: { ...reads }, granted: { ...granted } } });
      full.dispose(); expanded.dispose(); f.dispose();
    }
    console.log(JSON.stringify({ boundedPreviewWork: observed.slice(-2) }));
    assert.deepEqual(runs[1]!.reads, runs[0]!.reads, 'hidden complete reflow/paint must not scale with an unseen logical-line tail');
    assert.deepEqual(runs[1]!.granted, runs[0]!.granted, 'all funded width-dependent layout/paint allocations must be bounded');
    assert.ok(runs[0]!.reads.layout < 1200 && runs[0]!.reads.paint < 1800);
});


test('card layout: bounded service rows retain complete command metadata/footer, trim blank preview edges and preserve prepared cells', async () => {
  const f = fixture(), d = bash(f, '1'.repeat(300), ['7'.repeat(180) + ' '.repeat(20) + '9'.repeat(500), '8'.repeat(180) + ' '.repeat(20) + '9'.repeat(500)], 1);
  d.regions = { ...d.regions, description: f.region('2'.repeat(260)), heading: f.region('3'.repeat(280)), footer: f.region('4'.repeat(300)) };
  const p = paint(), decorated: ReadyCardPaint = { ...p, roles: { ...p.roles,
    output: compileStyleAnsi({ foreground: { kind: 'rgb', r: 18, g: 52, b: 86 }, background: { kind: 'indexed', index: 22 }, attributes: 15 }, 'truecolor'),
    reminder: compileStyleAnsi({ foreground: { kind: 'indexed', index: 6 }, background: { kind: 'indexed', index: 52 }, attributes: 8 }, 'truecolor') } };
  const l = layoutCard(d, { width: 25 }, f)!, out = l.paint(d, decorated, f)!;
  const lines = rows(out).map(plain), text = lines.join('\n');
  for (const [digit, count] of [['1', 300], ['2', 260], ['3', 280], ['4', 300], ['7', 180], ['8', 180], ['9', 0]] as const) {
    assert.equal(text.split(digit).length - 1, count);
  }
  const overflows = lines.flatMap((line, i) => line.includes('Click to expand') ? [i] : []);
  assert.equal(overflows.length, 2);
  assert.ok(lines[overflows[0]! - 1]!.includes('7') && lines[overflows[1]! - 1]!.includes('8'), 'blank tenth rows must be trimmed before each overflow label');
  const t = await terminal(out, 25);
  try {
    const output = t.buffer.active.getLine(lines.findIndex(s => s.includes('7')))!.getCell(l.geometry.contentX)!;
    const reminder = t.buffer.active.getLine(lines.findIndex(s => s.includes('8')))!.getCell(l.geometry.contentX)!;
    assert.equal(output.getFgColor(), 0x123456); assert.equal(output.getBgColor(), 22);
    assert.ok(output.isBold() && output.isItalic() && output.isUnderline() && output.isDim());
    assert.equal(reminder.getFgColor(), 6); assert.equal(reminder.getBgColor(), 52);
    assert.ok(reminder.isDim() && !reminder.isBold() && !reminder.isItalic() && !reminder.isUnderline());
  } finally { t.dispose(); out.dispose(); l.dispose(); f.dispose(); }
});


test('card layout: oversized file grapheme fills its declared replacement slot and complete frame background', async () => {
  const f = fixture(), d = file(f, ['\u093e'.repeat(3)]), p = paint();
  const l = layoutCard(d, { width: 7 }, f)!, out = l.paint(d, p, f)!;
  try {
    const text = rows(out).map(plain);
    const row = text.findIndex(s => s.includes('�'));
    assert.ok(row >= 0);
    assert.equal(text[row]!.length, 7, 'replacement and frame must fill every declared cell');
    const t = await terminal(out, 7);
    try {
      const line = t.buffer.active.getLine(row)!;
      assert.equal(line.getCell(3)!.getChars(), '�');
      assert.equal(line.getCell(4)!.getChars(), ' ');
      assert.equal(line.getCell(4)!.getBgColor(), 17);
      assert.equal(line.getCell(5)!.getBgColor(), 17);
      assert.ok(line.getCell(6)!.isBgDefault());
    } finally { t.dispose(); }
  } finally { out.dispose(); l.dispose(); f.dispose(); }
});


test('card rows: nested operation borrows hold every row charge through disposal and throwing callbacks', () => {
  for (const throws of [false, true]) {
    const f = fixture(), d = bash(f, 'x'.repeat(400)), l = layoutCard(d, { width: 24 }, f)!;
    const baseline = f.budget.stats().retainedBytes, out = l.paint(d, paint(), f)!;
    const funded = f.budget.stats().retainedBytes;
    let visits = 0;
    const run = () => out.withRows(outer => {
      visits++;
      assert.equal(out.withRows(inner => {
        assert.equal(inner === outer, true);
        out.cleanupReceipt().release(); out.dispose();
        assert.equal(f.budget.stats().retainedBytes, funded, 'no row credit is returned while actual array is borrowed');
        assert.ok(outer.length > 10 && outer[1]!.includes('x'));
        if (throws) throw Error('borrow callback failed');
      }), false);
      assert.equal(f.budget.stats().retainedBytes, funded, 'outer borrow still protects all rows');
    });
    if (throws) assert.throws(run, /borrow callback failed/); else assert.equal(run(), false);
    assert.equal(visits, 1); assert.equal(f.budget.stats().retainedBytes, baseline);
    assert.equal(out.withRows(() => assert.fail('disposed array escaped')), false);
    l.dispose(); f.dispose();
  }
});
