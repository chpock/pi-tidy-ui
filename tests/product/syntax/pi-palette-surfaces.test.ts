import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { colorToRgb, indexedColor, rgbColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { samplePiCardPalette, samplePiPalette } from '../../../src/syntax/pi-palette.ts';
import { samplePiPrefix } from '../../../src/syntax/pi-bindings.ts';
import { effectiveColor } from '../../../src/syntax/pi-color.ts';
import { PI_MARKER_REGIONS, PI_RULE_BINDINGS, piBindingInkRole, type PiMarkerBinding } from '../../../src/syntax/pi-adapter.ts';

const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
const slot = (region: typeof PI_RULE_BINDINGS[number]) => PI_RULE_BINDINGS.indexOf(region);
const markerSlot = (binding: PiMarkerBinding) => slot(PI_MARKER_REGIONS[binding]);
const directRegions = PI_RULE_BINDINGS.filter(region => !['markdown-heading-marker', 'markdown-code-delimiter', 'markdown-link-delimiter'].includes(region));
function fixture(panel: string | number, options: { mode?: TerminalColorMode; fg?: Record<string, string | number>; bg?: Record<string, string | number>; faint?: ThemeColor[] } = {}) {
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  for (const role of Object.keys(getThemeByName('dark')!.colors)) (backgrounds.has(role) ? bg : fg)[role] = backgrounds.has(role) ? '#12141a' : '#dddddd';
  Object.assign(bg, { toolPendingBg: panel, toolSuccessBg: '#18301a', toolErrorBg: '#381c19' }, options.bg);
  Object.assign(fg, options.fg);
  return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], options.mode ?? 'truecolor', { dim: options.faint ?? [] });
}
function color(ink: { kind: string; index?: number; r?: number; g?: number; b?: number }): Color {
  assert.notEqual(ink.kind, 'inherit'); assert.notEqual(ink.kind, 'terminal-default');
  return ink.kind === 'indexed' ? indexedColor(ink.index!) : rgbColor(ink.r!, ink.g!, ink.b!);
}
function contrast(first: Color, second: Color): number {
  const luminance = (value: Color) => {
    const { r, g, b } = colorToRgb(value), linear = (n: number) => n <= 10.31475 ? n / 3294.6 : ((n / 255 + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('Pi surfaces: authored indexed panel is exact, never a guessed RGB tint origin', () => {
  const values = samplePiCardPalette(fixture(17));
  for (const role of CARD_ROLES) assert.deepEqual(values[role].background, { kind: 'indexed', index: 17 }, role);
});

test('Pi surfaces: all direct Markdown/diagnostic inks constrain emitted diff surfaces, never toolTitle', () => {
  for (const mode of ['truecolor', '256color'] as const) {
    const theme = fixture('#12141a', { mode, fg: { mdHeading: '#6c7090', toolTitle: '#000000' } });
    const result = samplePiPalette(theme, mode), panel = color(result.roles.code.background);
    for (const region of directRegions) {
      const role = piBindingInkRole(region), ink = color(result.bindings[slot(region)]!.ink), floor = Math.min(4.5, contrast(ink, panel));
      for (const row of ['addedCode', 'removedCode'] as const)
        assert.ok(contrast(ink, color(result.roles[row].background)) + 1e-10 >= floor, `${mode}/${region}/${role}/${row}`);
    }
    const other = samplePiPalette(fixture('#12141a', { mode, fg: { mdHeading: '#6c7090', toolTitle: '#ffffff' } }), mode);
    assert.deepEqual(other.roles.addedCode.background, result.roles.addedCode.background);
    assert.deepEqual(other.roles.removedCode.background, result.roles.removedCode.background);
  }
});

test('Pi surfaces: unrelated faint punctuation never donates ink to role-derived marker shades', () => {
  const prepare = (punctuation: string) => {
    const theme = fixture('#12141a', { mode: 'truecolor', fg: { syntaxPunctuation: punctuation }, faint: ['syntaxPunctuation'] });
    const result = samplePiPalette(theme, 'truecolor');
    const donor = result.bindings[slot('syntax-punctuation')]!;
    assert.equal(donor.attributes & 8, 8);
    for (const [name, sourceRole] of [['headingMarker', 'mdHeading'], ['inlineCodeDelimiter', 'mdCode'], ['linkDelimiter', 'mdLink']] as const) {
      const marker = result.bindings[markerSlot(name)]!;
      const parent = samplePiPrefix(theme.getFgAnsi(sourceRole));
      const decision = result.variantDecisions.find(item => item.binding === name)!;
      assert.equal(marker.attributes, parent.attributes, `${name}: keep its own role's typography`);
      if (decision.status === 'parent') assert.deepEqual(marker.ink, parent.ink, `${name}: exact own-parent fallback`);
      else assert.deepEqual(marker.ink, decision.emittedInk, `${name}: publish the selected emitted color`);
    }
    return result;
  };
  const first = prepare('#777777'), second = prepare('#999999');
  assert.notDeepEqual(first.bindings[slot('syntax-punctuation')]!.ink,
    second.bindings[slot('syntax-punctuation')]!.ink);
  for (const name of ['headingMarker', 'inlineCodeDelimiter', 'linkDelimiter'] as const)
    assert.deepEqual(first.bindings[markerSlot(name)], second.bindings[markerSlot(name)],
      `${name}: changing unrelated faint punctuation cannot change its own role-derived shade`);
  for (const role of CARD_ROLES) assert.deepEqual(first.roles[role].background, second.roles[role].background,
    `${role}: unverified faint ink cannot influence numeric diff-surface selection`);
});

test('Pi surfaces: default panel and unusable side hint never gain guessed tints', () => {
  const defaults = samplePiPalette(fixture(''), 'truecolor');
  for (const role of CARD_ROLES) assert.deepEqual(defaults.roles[role].background, { kind: 'terminal-default' });
  const result = samplePiPalette(fixture('#12141a', { bg: { toolSuccessBg: 17 } }), 'truecolor');
  for (const role of ['addedCode', 'addedGutter', 'addedSign'] as const)
    assert.deepEqual(result.roles[role].background, result.roles.panel.background);
  assert.notDeepEqual(result.roles.removedCode.background, result.roles.panel.background, 'only the unusable side loses tint');
});

test('Pi surfaces: symbolic/faint primary inks stay exact without globally vetoing useful tints', () => {
  const theme = fixture('#12141a', { fg: { syntaxString: 17, mdCode: '', mdHeading: '#dddddd' }, faint: ['mdHeading', 'dim'] });
  const result = samplePiPalette(theme, 'truecolor');
  for (const region of directRegions) {
    const role = piBindingInkRole(region);
    assert.deepEqual(result.bindings[slot(region)], samplePiPrefix(theme.getFgAnsi(role)), region);
  }
  assert.notDeepEqual(result.roles.addedCode.background, result.roles.panel.background);
  assert.notDeepEqual(result.roles.removedCode.background, result.roles.panel.background);
  assert.equal(result.roles.numbers.attributes & 8, 8);
});

test('Pi surfaces: identical indexed output is numerically eligible only with concrete public provenance', () => {
  const prefix = samplePiPrefix('\x1b[38;5;180m');
  assert.equal(effectiveColor(prefix, indexedColor(180), '256color'), undefined);
  assert.deepEqual(effectiveColor(prefix, rgbColor(215, 175, 135), '256color'), rgbColor(215, 175, 135));
  assert.equal(effectiveColor(samplePiPrefix('\x1b[39m'), rgbColor(255, 255, 255), 'truecolor'), undefined);
  assert.equal(effectiveColor(samplePiPrefix('\x1b[2;38;2;1;2;3m'), rgbColor(1, 2, 3), 'truecolor'), undefined);
});

test('Pi surfaces: neutral themes gain no invented hue and preparation is deterministic', () => {
  for (const mode of ['truecolor', '256color'] as const) {
    const theme = fixture('#121212', { mode, bg: { toolSuccessBg: '#181818', toolErrorBg: '#202020' } });
    const first = samplePiPalette(theme, mode);
    assert.deepEqual(first, samplePiPalette(theme, mode));
    for (const value of first.bindings) {
      const rgb = colorToRgb(color(value.ink)); assert.equal(rgb.r, rgb.g); assert.equal(rgb.g, rgb.b);
    }
  }
});

for (const mode of ['truecolor', '256color'] as const) test(`Pi surfaces: ${mode} faint indexed punctuation cannot donate or become guessed RGB for marker shades`, () => {
  const prepare = (index: number) => {
    const theme = fixture('#181818', { mode, fg: { syntaxPunctuation: index }, faint: ['syntaxPunctuation'],
      bg: { toolSuccessBg: '#88cc88', toolErrorBg: '#cc6666' } });
    assert.equal(theme.colors.syntaxPunctuation!.kind, 'oklch', 'real public Theme approximates faint and loses indexed provenance');
    const result = samplePiPalette(theme, mode), donor = result.bindings[slot('syntax-punctuation')]!;
    assert.deepEqual(donor.ink, { kind: 'indexed', index }); assert.equal(donor.attributes & 8, 8);
    for (const [name, sourceRole] of [['headingMarker', 'mdHeading'], ['linkDelimiter', 'mdLink']] as const) {
      const marker = result.bindings[markerSlot(name)]!;
      const parent = samplePiPrefix(theme.getFgAnsi(sourceRole));
      const decision = result.variantDecisions.find(item => item.binding === name)!;
      assert.equal(marker.attributes, parent.attributes, `${name}: keep its own role's typography`);
      if (decision.status === 'parent') assert.deepEqual(marker.ink, parent.ink, `${name}: exact own-parent fallback`);
      else assert.deepEqual(marker.ink, decision.emittedInk, `${name}: publish the selected emitted color`);
    }
    return result;
  };
  const dim = prepare(243), bright = prepare(255);
  for (const name of ['headingMarker', 'linkDelimiter'] as const) {
    assert.deepEqual(dim.bindings[markerSlot(name)], bright.bindings[markerSlot(name)],
      `${name}: a different unknown faint palette entry cannot change its own role-derived shade`);
  }
  for (const role of CARD_ROLES) assert.deepEqual(dim.roles[role].background, bright.roles[role].background,
    `${role}: an unknown authored palette entry cannot influence numeric surface constraints`);
});
