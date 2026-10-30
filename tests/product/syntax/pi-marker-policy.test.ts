import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { colorToOklch, colorToRgb, foregroundAnsi, indexedColor, rgbColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { samplePiBindings, samplePiPrefix } from '../../../src/syntax/pi-bindings.ts';
import { PI_MARKER_VARIANT_CANDIDATE_COUNT, PI_MARKER_VARIANT_SCRATCH_BYTES } from '../../../src/syntax/pi-variants.ts';
import { samplePiPalette, type PiPaletteTheme } from '../../../src/syntax/pi-palette.ts';
import { PI_MARKER_REGIONS, PI_RULE_BINDINGS, piBindingInkRole, type PiDerivedMarker, type PiMarkerBinding } from '../../../src/syntax/pi-adapter.ts';
import { followPiTheme } from '../../fixtures/follow-pi-themes.ts';

const slot = (region: typeof PI_RULE_BINDINGS[number]) => PI_RULE_BINDINGS.indexOf(region);
const markerSlot = (binding: PiMarkerBinding) => slot(PI_MARKER_REGIONS[binding]);
const directRegions = PI_RULE_BINDINGS.filter(region => !['markdown-heading-marker', 'markdown-code-delimiter', 'markdown-link-delimiter'].includes(region));
const policies = [
  { marker: 'headingMarker', parent: 'mdHeading', separation: 0.12, target: 0.22, tolerance: 0.05, neighbors: [['mdHeading', 0.12]] },
  { marker: 'inlineCodeDelimiter', parent: 'mdCode', separation: 0.07, target: 0.09, tolerance: 0.025, neighbors: [['mdCode', 0.07]] },
  { marker: 'linkDelimiter', parent: 'mdLink', separation: 0.07, target: 0.10, tolerance: 0.045, neighbors: [['mdLink', 0.07], ['mdLinkUrl', 0.055], ['toolOutput', 0.055]] },
] as const satisfies readonly { marker: PiDerivedMarker; parent: ThemeColor; separation: number; target: number; tolerance: number; neighbors: readonly (readonly [ThemeColor, number])[] }[];

function parseInk(prefix: string) {
  const rgb = prefix.match(/38;2;(\d+);(\d+);(\d+)m/);
  if (rgb) return rgbColor(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const indexed = prefix.match(/38;5;(\d+)m/);
  return indexed ? indexedColor(Number(indexed[1])) : undefined;
}
function colorFromInk(ink: ReturnType<typeof samplePiPrefix>['ink']): Color | undefined {
  if (ink.kind === 'rgb') return rgbColor(ink.r, ink.g, ink.b);
  return ink.kind === 'indexed' ? indexedColor(ink.index) : undefined;
}
function emittedRole(theme: PiPaletteTheme, role: ThemeColor, mode: TerminalColorMode): Color | undefined {
  const direct = parseInk(theme.getFgAnsi(role));
  return direct ? parseInk(foregroundAnsi(direct, mode)) : undefined;
}
function lab(color: Color) {
  const { l, c, h } = colorToOklch(color), angle = h * Math.PI / 180;
  return { l, a: c * Math.cos(angle), b: c * Math.sin(angle) };
}
function deltaE(first: Color, second: Color) {
  const a = lab(first), b = lab(second);
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}
function luminance(color: Color) {
  const { r, g, b } = colorToRgb(color);
  const channel = (value: number) => value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(first: Color, second: Color) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function fixture(name: string, mode: TerminalColorMode): PiPaletteTheme {
  const base = getThemeByName(name === 'light' ? 'light' : 'dark')!;
  return name === 'dark' || name === 'light' ? base : followPiTheme(name, mode, base);
}

for (const name of ['dark', 'light', 'gruvbox']) for (const mode of ['truecolor', '256color'] as const)
  test(`Pi marker palette: ${name}/${mode} derives visible colors from each marker's own Pi role`, () => {
    const theme = fixture(name, mode), prepared = samplePiPalette(theme, mode), raw = samplePiBindings(theme);
    for (const policy of policies) {
      const marker = prepared.bindings[markerSlot(policy.marker)]!, parent = emittedRole(theme, policy.parent, mode);
      assert.ok(parent, `${policy.marker}: public parent color is concrete`);
      assert.equal(marker.attributes, raw[markerSlot(policy.marker)]!.attributes, `${policy.marker}: preserve parent typography`);
      assert.equal(marker.attribute_mask, raw[markerSlot(policy.marker)]!.attribute_mask, `${policy.marker}: preserve parent attribute contract`);
      assert.notDeepEqual(marker.ink, raw[markerSlot(policy.marker)]!.ink,
        `${policy.marker}: selected palette provides a real derivative (${JSON.stringify(prepared.variantDecisions)})`);
      const decision = prepared.variantDecisions.find(item => item.binding === policy.marker);
      if (!decision || decision.status !== 'derived' || typeof decision.separation !== 'number')
        throw new Error(`${policy.marker}: palette records a selected derivative`);
      assert.ok(Math.abs(decision.separation - policy.target) <= policy.tolerance,
        `${policy.marker}: selected final separation stays near its role-specific target`);
      const markerColor = marker.ink.kind === 'inherit' ? undefined : colorFromInk(marker.ink);
      assert.ok(markerColor, `${policy.marker}: derived final ink is concrete`);
      for (const [neighbor, floor] of policy.neighbors) {
        const adjacent = emittedRole(theme, neighbor, mode);
        assert.ok(adjacent, `${policy.marker}: ${neighbor} has public concrete ink`);
        assert.ok(deltaE(markerColor!, adjacent!) >= floor, `${policy.marker}: final ${mode} ink must separate from ${neighbor}`);
      }
      for (const surface of [prepared.roles.panel.background, prepared.roles.addedCode.background, prepared.roles.removedCode.background]) {
        const background = colorFromInk(surface);
        assert.ok(background, `${policy.marker}: all frozen surfaces have a concrete comparison`);
        assert.ok(contrast(markerColor!, background!) >= 4.5, `${policy.marker}: emitted ink meets the readable-surface threshold`);
      }
    }
    for (const region of directRegions)
      assert.deepEqual(prepared.bindings[slot(region)]!, raw[slot(region)]!, `${region} remains the exact public Pi binding for ${piBindingInkRole(region)}`);
    assert.deepEqual(prepared.bindings[markerSlot('stringDelimiter')]!, raw[markerSlot('stringDelimiter')]!, 'quotes stay part of the same literal color');
  });

test('Pi marker palette: per-role candidate search is fixed and funded', () => {
  assert.equal(PI_MARKER_VARIANT_CANDIDATE_COUNT, 224);
  assert.ok(PI_MARKER_VARIANT_SCRATCH_BYTES >= PI_MARKER_VARIANT_CANDIDATE_COUNT * 256);
});

test('Pi marker palette: heading and list markers keep independent semantic sources', () => {
  const base = getThemeByName('dark')!, original = samplePiPalette(followPiTheme('gruvbox', 'truecolor', base), 'truecolor');
  const changed = followPiTheme('gruvbox', 'truecolor', base);
  const decorated: PiPaletteTheme = {
    colors: changed.colors,
    getBgAnsi: changed.getBgAnsi.bind(changed),
    getFgAnsi: role => role === 'syntaxPunctuation' ? '\x1b[38;2;255;0;255m'
      : role === 'mdListBullet' ? '\x1b[38;2;0;255;255m' : changed.getFgAnsi(role),
  };
  const next = samplePiPalette(decorated, 'truecolor');
  assert.deepEqual(next.bindings[markerSlot('headingMarker')], original.bindings[markerSlot('headingMarker')], 'generic punctuation and list ink cannot select heading colors');
  assert.notDeepEqual(next.bindings[slot('markdown-list-item')]!.ink, original.bindings[slot('markdown-list-item')]!.ink, 'list markers still follow their authored list role');
});

test('Pi marker palette: unknown surfaces, symbolic/indexed parents and faint parents use exact-parent fallback', () => {
  const base = getThemeByName('dark')!;
  const fallback = (theme: PiPaletteTheme, mode: TerminalColorMode, markers = policies.map(policy => policy.marker)) => {
    const sampled = samplePiPalette(theme, mode), direct = samplePiBindings(theme);
    for (const marker of markers) assert.deepEqual(sampled.bindings[markerSlot(marker)]!, direct[markerSlot(marker)]!, `${marker}: no numeric guess`);
    return { sampled, direct };
  };
  const terminal = followPiTheme('terminal-default', 'truecolor', base);
  fallback({ colors: terminal.colors, getFgAnsi: terminal.getFgAnsi.bind(terminal), getBgAnsi: role => role === 'toolPendingBg' ? '\x1b[49m' : terminal.getBgAnsi(role) }, 'truecolor');
  const faint = followPiTheme('faint-parent', 'truecolor', base);
  const faintValues = fallback(faint, 'truecolor', ['headingMarker', 'linkDelimiter']);
  assert.notDeepEqual(faintValues.sampled.bindings[markerSlot('inlineCodeDelimiter')]!.ink,
    faintValues.direct[markerSlot('inlineCodeDelimiter')]!.ink, 'unrelated non-faint semantic parent remains derivable');
  const indexed: PiPaletteTheme = {
    colors: { ...base.colors, mdHeading: indexedColor(23) } as typeof base.colors,
    getFgAnsi: role => role === 'mdHeading' ? '\x1b[38;5;23m' : base.getFgAnsi(role),
    getBgAnsi: base.getBgAnsi.bind(base),
  };
  const result = samplePiPalette(indexed, 'truecolor');
  assert.deepEqual(result.bindings[markerSlot('headingMarker')]!, samplePiBindings(indexed)[markerSlot('headingMarker')]!, 'authored indexed parent is not guessed as RGB');
});
