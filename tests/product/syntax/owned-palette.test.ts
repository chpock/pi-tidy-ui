import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { colorToRgb, rgbColor, type TerminalColorMode } from '@earendil-works/pi-tui';
import { diffPalette } from '../../../src/diff-palette.ts';
import type { Ink, LiteralInk } from '../../../src/occipital/semantic-codec.ts';
import type { DiagnosticSink } from '../../../src/diagnostics.ts';
import { inkColor, outputInk } from '../../../src/syntax/pi-color.ts';
import { SEMANTIC_REGIONS } from '../../../src/syntax/semantic-rules.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { OWNED_PALETTE_FILE_BYTES, parseOwnedPaletteBytes, parseOwnedPaletteData, sampleOwnedPalette, validateOwnedPaletteData } from '../../../src/themes/owned-palette.ts';
import { THEME_CATALOGUE } from '../../../src/themes/catalogue.ts';
import { resolveTheme } from '../../../src/themes/selection.ts';
import { PaletteInputOwner } from '../../../src/syntax/pi-input-owner.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { RuntimeHealth } from '../../../src/runtime-health.ts';

function paletteFile(id = 'gruvbox-dark'): any {
  return JSON.parse(readFileSync(new URL(`../../../src/themes/palettes/${id}.json`, import.meta.url), 'utf8'));
}
function color(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgbColor(value >>> 16, value >>> 8 & 255, value & 255);
}
function emitted(hex: string, mode: TerminalColorMode) { return inkColor(outputInk(color(hex), mode)); }
function ink(hex: string, mode: TerminalColorMode): LiteralInk { return outputInk(color(hex), mode); }
function literal(value: Ink): LiteralInk {
  if (value.kind === 'binding' || value.kind === 'inherit') throw new Error('expected materialized literal ink');
  return value;
}
function colorOf(value: Ink) { return inkColor(literal(value))!; }
function contrast(first: ReturnType<typeof colorOf>, second: ReturnType<typeof colorOf>): number {
  const luminance = (value: ReturnType<typeof colorOf>) => {
    const { r, g, b } = colorToRgb(value), linear = (n: number) => n <= 10.31475 ? n / 3294.6 : ((n / 255 + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function hex(value: Ink) {
  const rgb = colorToRgb(colorOf(value)); return `#${[rgb.r, rgb.g, rgb.b].map(part => part.toString(16).padStart(2, '0')).join('')}`;
}

test('all 72 owned semantic palettes supply every role and 44 bindings in both output modes', () => {
  assert.equal(THEME_CATALOGUE.length, 72);
  for (const theme of THEME_CATALOGUE) for (const mode of ['truecolor', '256color'] as const) {
    const palette = sampleOwnedPalette(theme.id, mode);
    assert.equal(palette.bindings.length, SEMANTIC_REGIONS.length, `${theme.id}/${mode}`);
    assert.deepEqual(Object.keys(palette.roles).sort(), [...CARD_ROLES].sort(), `${theme.id}/${mode}`);
    assert.deepEqual(Object.keys(palette.compiledRoles).sort(), [...CARD_ROLES].sort(), `${theme.id}/${mode}`);
    const panel = colorOf(palette.roles.panel.background);
    const codeInks = [...palette.bindings.map(binding => colorOf(binding.ink)), colorOf(palette.roles.code.foreground)];
    const gutterInks = [palette.roles.numbers.foreground, palette.roles.addedSign.foreground, palette.roles.removedSign.foreground].map(colorOf);
    for (const candidate of codeInks) {
      const floor = Math.min(4.5, contrast(candidate, panel));
      for (const role of ['addedCode', 'removedCode'] as const)
        assert.ok(contrast(candidate, colorOf(palette.roles[role].background)) + 1e-10 >= floor, `${theme.id}/${mode}/code/${role}`);
    }
    for (const [index, candidate] of gutterInks.entries()) {
      const floor = Math.min(index === 0 ? 3 : 4.5, contrast(candidate, panel));
      for (const role of ['addedGutter', 'removedGutter'] as const)
        assert.ok(contrast(candidate, colorOf(palette.roles[role].background)) + 1e-10 >= floor, `${theme.id}/${mode}/gutter/${role}`);
    }
  }
});

test('owned palette inputs compile each role once, share warm owners, and release prior stores across all 72 choices', () => {
  const owner = new PaletteInputOwner(), budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  type Lease = NonNullable<ReturnType<PaletteInputOwner['prepare']>>;
  let current: Lease | undefined, currentExpected: ReturnType<typeof sampleOwnedPalette> | undefined;
  let compilations = 0, observeCompilations = false;
  const freeze = Object.freeze;
  Object.freeze = ((value: any) => {
    if (observeCompilations && value && typeof value.open === 'string' && typeof value.close === 'string') compilations++;
    return freeze(value);
  }) as typeof Object.freeze;
  let peakOverlapBytes = 0;
  try {
    for (const { id } of THEME_CATALOGUE) {
      const palette = resolveTheme({ kind: 'theme', id }).effective;
      const revision = owner.palette(undefined, palette);
      observeCompilations = false;
      const expected = sampleOwnedPalette(id, 'truecolor');
      const beforeCold = compilations;
      observeCompilations = true;
      const cold = owner.prepare(undefined, palette, revision, 'truecolor', funding, false);
      observeCompilations = false;
      assert.ok(cold, `${id} receives a funded input`);
      assert.equal(compilations - beforeCold, CARD_ROLES.length, `${id} compiles exactly one immutable value per role`);
      assert.equal(cold.visit(read => assert.deepEqual(read.compiledRoles, expected.compiledRoles)), true);

      const beforeWarm = compilations;
      observeCompilations = true;
      const warm = owner.prepare(undefined, palette, revision, 'truecolor', funding, false);
      observeCompilations = false;
      assert.ok(warm, `${id} warm owner shares the live input`);
      assert.equal(compilations, beforeWarm, `${id} warm reuse performs no compilation`);
      assert.equal(warm.allocationBytes, cold.allocationBytes);
      if (current) assert.equal(current.visit(read => assert.deepEqual(read.compiledRoles, currentExpected!.compiledRoles)), true,
        'the prior immutable lease stays valid while its replacement is prepared');
      peakOverlapBytes = Math.max(peakOverlapBytes, budget.stats().retainedBytes);

      current?.dispose();
      cold.dispose();
      assert.equal(budget.stats().retainedBytes, warm.allocationBytes, `${id} settled state retains only the current shared store`);
      assert.equal(warm.visit(read => assert.deepEqual(read.compiledRoles, expected.compiledRoles)), true);
      current = warm;
      currentExpected = expected;
    }
  } finally {
    observeCompilations = false; Object.freeze = freeze;
    current?.dispose(); owner.dispose();
  }
  assert.equal(budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ ownedPaletteInputChurn: { choices: THEME_CATALOGUE.length, roleCompilationsPerColdStore: CARD_ROLES.length,
    warmCompilations: 0, peakOverlapBytes, settledStores: 1, finalRetainedBytes: budget.stats().retainedBytes } }));
});

test('owned palette input funding refusal refunds each partial reservation before parsing or compiling', () => {
  let compilations = 0, observeCompilations = false;
  const freeze = Object.freeze;
  Object.freeze = ((value: any) => {
    if (observeCompilations && value && typeof value.open === 'string' && typeof value.close === 'string') compilations++;
    return freeze(value);
  }) as typeof Object.freeze;
  try {
    for (const deniedGrant of [1, 2, 3]) {
      const owner = new PaletteInputOwner(), palette = resolveTheme({ kind: 'theme', id: 'gruvbox-dark' }).effective;
      const revision = owner.palette(undefined, palette), budget = new DataBudget(1_000_000);
      let grants = 0;
      const funding = { budget, grant(bytes: number) { grants++; return grants === deniedGrant ? undefined : budget.reserve(bytes); } };
      const before = compilations; observeCompilations = true;
      const lease = owner.prepare(undefined, palette, revision, 'truecolor', funding, false);
      observeCompilations = false;
      assert.equal(lease, undefined, `grant ${deniedGrant} refusal rejects the incomplete input`);
      assert.equal(grants, deniedGrant);
      assert.equal(compilations, before, 'unfunded candidates never compile role tables');
      assert.deepEqual(budget.stats(), { retainedBytes: 0, outstandingPeakBytes: 0, limit: 1_000_000, closed: false });
      owner.dispose();
    }
  } finally { observeCompilations = false; Object.freeze = freeze; }
});

test('owned palette schema accepts normal-typography #rrggbb strings and rejects unsupported hex shorthand', () => {
  const input = paletteFile();
  input.regions['syntax-comment'] = '#aabbcc';
  const normalized = validateOwnedPaletteData(input, input.id);
  assert.deepEqual(normalized.regions['syntax-comment'], { foreground: '#aabbcc', attributes: [] });
  const parsed = parseOwnedPaletteData(input, input.id, 'truecolor');
  const commentInk = parsed.bindings[SEMANTIC_REGIONS.indexOf('syntax-comment')]!.ink;
  assert.equal(commentInk.kind, 'rgb');
  if (commentInk.kind === 'rgb') assert.deepEqual(colorToRgb(commentInk), { r: 170, g: 187, b: 204 });
  input.regions['syntax-comment'] = '#abc';
  assert.throws(() => validateOwnedPaletteData(input, input.id), /invalid owned palette data/);
  assert.equal(parsed.bindings[SEMANTIC_REGIONS.indexOf('syntax-comment')]!.attributes, 0);
  assert.equal(parsed.bindings[SEMANTIC_REGIONS.indexOf('syntax-comment')]!.attribute_mask, 31);
});

test('owned palette parser accepts the exact 32-KiB cap and rejects cap plus one before JSON parsing', () => {
  assert.equal(OWNED_PALETTE_FILE_BYTES, 32 * 1024);
  const serialized = Buffer.from(JSON.stringify(paletteFile()));
  assert.ok(serialized.length < OWNED_PALETTE_FILE_BYTES);
  const exact = Buffer.alloc(OWNED_PALETTE_FILE_BYTES, 0x20); serialized.copy(exact);
  assert.equal(validateOwnedPaletteData(parseOwnedPaletteBytes(exact), 'gruvbox-dark').regions['syntax-comment'] !== undefined, true);
  const oversized = Buffer.from(`${serialized.toString('utf8').slice(0, -1)},"padding":"${'x'.repeat(OWNED_PALETTE_FILE_BYTES)}"}`);
  assert.ok(oversized.length > OWNED_PALETTE_FILE_BYTES);
  assert.doesNotThrow(() => JSON.parse(oversized.toString('utf8')), 'the over-cap control is otherwise valid JSON');
  assert.throws(() => parseOwnedPaletteBytes(oversized), /invalid owned palette data/);
});

test('owned palette rejects missing/extra regions and malformed styles before materializing inputs', () => {
  const missing = paletteFile(); delete missing.regions['syntax-comment'];
  assert.throws(() => parseOwnedPaletteData(missing, missing.id, 'truecolor'), /invalid owned palette data/);
  const extra = paletteFile(); extra.regions['unknown-region'] = '#aabbcc';
  assert.throws(() => parseOwnedPaletteData(extra, extra.id, 'truecolor'), /invalid owned palette data/);
  const malformed = paletteFile(); malformed.regions['syntax-comment'] = { foreground: '#12', attributes: ['bold'] };
  assert.throws(() => parseOwnedPaletteData(malformed, malformed.id, 'truecolor'), /invalid owned palette data/);
  const malformedCommit = paletteFile(); malformedCommit.source.commit = [malformedCommit.source.commit];
  assert.throws(() => validateOwnedPaletteData(malformedCommit, malformedCommit.id), /invalid owned palette data/);
});

test('missing selected assets use a bounded Pi fallback and recover on a new valid selection', () => {
  const native = getThemeByName('dark')!, counts = { fg: 0, bg: 0 };
  const theme = { colors: native.colors, getFgAnsi(role: Parameters<typeof native.getFgAnsi>[0]) { counts.fg++; return native.getFgAnsi(role); },
    getBgAnsi(role: Parameters<typeof native.getBgAnsi>[0]) { counts.bg++; return native.getBgAnsi(role); } };
  const warnings: string[] = [], owner = new PaletteInputOwner((level, _area, explanation) => { if (level === 'WARN') warnings.push(explanation); });
  const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  const missing = { kind: 'theme' as const, id: 'missing-palette', label: 'Missing', fingerprint: 'missing' };
  const revision = owner.palette(theme, missing);
  const fallback = owner.prepare(theme, missing, revision, 'truecolor', funding)!;
  assert.equal(fallback.paletteId, 'pi');
  const sampled = { ...counts };
  const repeated = owner.prepare(theme, missing, revision, 'truecolor', funding)!;
  assert.deepEqual(counts, sampled, 'a memoized missing identity does not resample Pi or reread the owned asset');
  assert.equal(warnings.length, 1, 'one visible warning for the failed identity');
  const expected = sampleOwnedPalette('gruvbox-dark', 'truecolor');
  const valid = resolveTheme({ kind: 'theme', id: 'gruvbox-dark' }).effective;
  const nextRevision = owner.palette(theme, valid);
  const recovered = owner.prepare(theme, valid, nextRevision, 'truecolor', funding)!;
  assert.equal(recovered.paletteId, valid.id);
  assert.equal(recovered.paletteRevision, nextRevision);
  let recoveredBindings = 0;
  assert.equal(recovered.visit(read => { recoveredBindings = read.bindings.length; }), true);
  assert.equal(recoveredBindings, expected.bindings.length);
  fallback.dispose(); repeated.dispose(); recovered.dispose(); owner.dispose();
  assert.equal(budget.stats().retainedBytes, 0);
});

test('failed owned identity refreshes and lazily reacquires its Pi fallback after a public theme change', () => {
  const dark = getThemeByName('dark')!, light = getThemeByName('light')!;
  const pi = (native: typeof dark) => ({ colors: native.colors,
    getFgAnsi: native.getFgAnsi.bind(native), getBgAnsi: native.getBgAnsi.bind(native) });
  const darkTheme = pi(dark), lightTheme = pi(light), owner = new PaletteInputOwner();
  const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
  const missing = { kind: 'theme' as const, id: 'missing-palette', label: 'Missing', fingerprint: 'missing' };
  const firstRevision = owner.palette(darkTheme, missing);
  const first = owner.prepare(darkTheme, missing, firstRevision, 'truecolor', funding)!;
  let firstInk = '';
  assert.equal(first.visit(read => { firstInk = read.compiledRoles.code.open; }), true);
  const nextRevision = owner.palette(lightTheme, missing);
  assert.ok(nextRevision > firstRevision, 'the failed palette follows the actual public Pi color object');
  let lazyReads = 0;
  const replacement = owner.prepare(undefined, missing, nextRevision, 'truecolor', funding, true, () => { lazyReads++; return lightTheme; })!;
  let replacementInk = '';
  assert.equal(replacement.paletteId, 'pi');
  assert.equal(replacement.paletteRevision, nextRevision);
  assert.equal(replacement.visit(read => { replacementInk = read.compiledRoles.code.open; }), true);
  assert.notEqual(replacementInk, firstInk, 'the fallback uses the newly sampled public Pi palette');
  assert.equal(lazyReads, 1, 'the owned card does not read Pi until fallback input is needed');
  replacement.dispose();
  const reacquired = owner.prepare(undefined, missing, nextRevision, 'truecolor', funding, true, () => { lazyReads++; return lightTheme; })!;
  assert.equal(reacquired.paletteId, 'pi', 'a released fallback is reacquired through its lazy Pi input');
  assert.equal(lazyReads, 2);
  first.dispose(); reacquired.dispose(); owner.dispose();
  assert.equal(budget.stats().retainedBytes, 0);
});

test('known missing, corrupt and incomplete palette assets notify once, retain status, and release on selection change', async () => {
  const native = getThemeByName('dark')!;
  const theme = { colors: native.colors, getFgAnsi: native.getFgAnsi.bind(native), getBgAnsi: native.getBgAnsi.bind(native) };
  const selected = resolveTheme({ kind: 'theme', id: 'gruvbox-dark' }).effective;
  const target = fileURLToPath(new URL('../../../src/themes/palettes/gruvbox-dark.json', import.meta.url));
  const directory = fs.mkdtempSync(join(tmpdir(), 'toolview-palette-failure-'));
  const corruptPath = join(directory, 'replacement.json');
  const originalOpen = fs.openSync;
  let replacement: string | undefined, opens = 0;
  const intercepted = ((file: string | URL, flags: string | number, mode?: number) => {
    if (String(file) === target) {
      opens++;
      if (replacement === undefined) throw Object.assign(new Error('missing palette'), { code: 'ENOENT' });
      return originalOpen(replacement, flags, mode);
    }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync;
  Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: intercepted });
  syncBuiltinESMExports();
  try {
    const incomplete = paletteFile(); delete incomplete.regions['syntax-comment'];
    const cases: readonly [string, string | undefined][] = [
      ['missing', undefined], ['corrupt', '{'], ['incomplete', JSON.stringify(incomplete)],
    ];
    for (const [name, contents] of cases) {
      replacement = contents === undefined ? undefined : corruptPath;
      if (contents !== undefined) fs.writeFileSync(corruptPath, contents);
      opens = 0;
      const notices: string[] = [], directNotices: string[] = [], health = new RuntimeHealth(message => notices.push(message), () => 1_000);
      const diagnostic: DiagnosticSink = health.sink(() => {}), owner = new PaletteInputOwner(diagnostic, message => directNotices.push(message));
      const budget = new DataBudget(1_000_000), funding = { budget, grant: (bytes: number) => budget.reserve(bytes) };
      const revision = owner.palette(theme, selected);
      const fallback = owner.prepare(theme, selected, revision, 'truecolor', funding);
      assert.ok(fallback, `${name} asset returns a usable whole-card fallback`);
      assert.equal(fallback.paletteId, 'pi');
      const opensAfterFailure = opens;
      const repeated = owner.prepare(theme, selected, revision, 'truecolor', funding);
      assert.ok(repeated); assert.equal(repeated.paletteId, 'pi');
      assert.equal(opens, opensAfterFailure, `${name} asset is not reread for an unchanged failed identity`);
      assert.equal(opens, 1, `${name} path was reached through the known catalogue ID`);
      assert.equal(health.snapshot().active, 1, `${name} failure is visible in the current status without relying on file logging`);
      await turn();
      assert.equal(notices.length, 1, `${name} failure uses runtime-health notification`);
       assert.equal(directNotices.length, 0, `${name} failure does not duplicate the health notification through direct UI`);
       assert.match(notices[0]!, /built-in color palette could not be loaded/u);
      const recoveredTheme = resolveTheme({ kind: 'theme', id: 'gruvbox-light' }).effective;
      const recoveredRevision = owner.palette(theme, recoveredTheme);
      assert.equal(health.snapshot().active, 0, `${name} issue is released when the failed selection is abandoned`);
      assert.equal(health.snapshot().last?.state, 'released');
      const recovered = owner.prepare(theme, recoveredTheme, recoveredRevision, 'truecolor', funding);
      assert.ok(recovered); assert.equal(recovered.paletteId, recoveredTheme.id, `${name} failure recovers for a valid selection`);
      fallback.dispose(); repeated.dispose(); recovered.dispose(); owner.dispose(); health.dispose();
      assert.equal(budget.stats().retainedBytes, 0);
    }
  } finally {
    Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen });
    syncBuiltinESMExports(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owned diff roles use the common diffPalette with final emitted inks in both terminal modes', () => {
  const input = paletteFile();
  for (const mode of ['truecolor', '256color'] as const) {
    const palette = parseOwnedPaletteData(input, input.id, mode);
    const expected = diffPalette({
      panel: colorOf(palette.roles.panel.background),
      codeInks: [...palette.bindings.map(binding => colorOf(binding.ink)), colorOf(palette.roles.code.foreground)],
      added: inkColor(ink(input.card.addedBackground, mode))!, removed: inkColor(ink(input.card.removedBackground, mode))!,
      numbers: inkColor(ink(input.card.dim, mode))!, addedSign: inkColor(ink(input.card.added, mode))!,
      removedSign: inkColor(ink(input.card.removed, mode))!, mode,
    });
    const added = expected.toolDiffAdded!, removed = expected.toolDiffRemoved!;
    assert.deepEqual(palette.roles.addedCode.background, outputInk(added.code, mode));
    assert.deepEqual(palette.roles.addedGutter.background, outputInk(added.gutter, mode));
    assert.deepEqual(palette.roles.addedSign.background, outputInk(added.gutter, mode));
    assert.deepEqual(palette.roles.removedCode.background, outputInk(removed.code, mode));
    assert.deepEqual(palette.roles.removedGutter.background, outputInk(removed.gutter, mode));
    assert.deepEqual(palette.roles.removedSign.background, outputInk(removed.gutter, mode));
    const surfaces = Object.fromEntries(['addedCode', 'addedGutter', 'addedSign', 'removedCode', 'removedGutter', 'removedSign']
      .map(role => [role, hex(palette.roles[role as keyof typeof palette.roles].background)]));
    assert.deepEqual(surfaces, mode === 'truecolor' ? {
      addedCode: '#16160b', addedGutter: '#111006', addedSign: '#111006',
      removedCode: '#1d1210', removedGutter: '#170d0b', removedSign: '#170d0b',
    } : {
      addedCode: '#1c1c1c', addedGutter: '#1c1c1c', addedSign: '#1c1c1c',
      removedCode: '#1c1c1c', removedGutter: '#1c1c1c', removedSign: '#1c1c1c',
    });
    assert.equal(hex(palette.roles.panel.foreground), mode === 'truecolor' ? '#ecdbb0' : '#ffd7af');
    assert.equal(hex(palette.roles.panel.background), mode === 'truecolor' ? '#1b1b1a' : '#1c1c1c');
  }
});

test('owned palette contrast does not impose a 4.5:1 repair on initially poor colors', () => {
  const input = paletteFile();
  input.card.background = '#101010'; input.card.foreground = '#111111'; input.card.addedBackground = '#101010'; input.card.removedBackground = '#101010';
  input.card.dim = '#111111'; input.card.added = '#111111'; input.card.removed = '#111111';
  for (const region of SEMANTIC_REGIONS) {
    const style = input.regions[region];
    input.regions[region] = typeof style === 'string' ? '#111111' : { ...style, foreground: '#111111' };
  }
  for (const mode of ['truecolor', '256color'] as const) {
    const palette = parseOwnedPaletteData(input, input.id, mode), panel = colorOf(palette.roles.panel.background);
    const ink = colorOf(palette.roles.code.foreground), initial = contrast(ink, panel);
    assert.ok(initial < 4.5, `${mode}: source intentionally starts below WCAG text contrast`);
    const floor = Math.min(4.5, initial);
    for (const role of ['addedCode', 'removedCode', 'addedGutter', 'removedGutter'] as const) {
      const final = contrast(ink, colorOf(palette.roles[role].background));
      assert.ok(final + 1e-10 >= floor, `${mode}/${role} preserves its source contrast floor`);
      assert.ok(final < 4.5, `${mode}/${role} is not forced through an unrelated contrast repair`);
    }
  }
});
