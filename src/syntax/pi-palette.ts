import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Color, TerminalColorMode } from '@earendil-works/pi-tui';
import { diffPalette } from '../diff-palette.ts';
import { CARD_ROLES, type CardRole, type LiteralInk } from '../occipital/semantic-codec.ts';
import { samplePiBindings, samplePiPrefix } from './pi-bindings.ts';
import { effectiveColor, inkColor, outputInk } from './pi-color.ts';
import { derivePiMarkerVariants, type PiDerivedMarker, type PiMarkerVariantContext } from './pi-variants.ts';
import { PI_MARKER_BINDINGS, PI_MARKER_REGIONS, PI_RULE_BINDINGS, piBindingInkRole } from './pi-adapter.ts';
import type { ConcreteStyle } from './style-materialization.ts';

const foregrounds = {
  panel: 'toolOutput', plain: 'toolOutput', code: 'toolOutput', output: 'toolOutput',
  empty: 'dim', padding: 'toolOutput', service: 'muted', muted: 'muted', footer: 'muted', reminder: 'muted',
  overflow: 'dim', diagnostic: 'error', title: 'toolTitle', prompt: 'dim', frame: 'borderMuted',
  error: 'error', errorFrame: 'error', warning: 'warning', gutter: 'dim', numbers: 'dim',
  addedCode: 'toolOutput', addedGutter: 'dim', addedSign: 'toolDiffAdded',
  removedCode: 'toolOutput', removedGutter: 'dim', removedSign: 'toolDiffRemoved',
} as const satisfies Record<CardRole, ThemeColor>;

export type PiPaletteTheme = Pick<Theme, 'getFgAnsi' | 'getBgAnsi' | 'colors'>;

/** Direct Pi inks freeze structural surfaces before optional role-derived markers.
 * Everything returned is detached from the theme. */
export function samplePiPalette(theme: PiPaletteTheme, mode: TerminalColorMode) {
  const sampled = new Map<ThemeColor, ReturnType<typeof samplePiPrefix>>();
  const baseBindings = samplePiBindings(theme, sampled);
  const foreground = (role: ThemeColor) => {
    let value = sampled.get(role);
    if (!value) { value = samplePiPrefix(theme.getFgAnsi(role)); sampled.set(role, value); }
    return value;
  };
  const known = (role: ThemeColor) => effectiveColor(foreground(role), theme.colors?.[role], mode);
  const background = (role: 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg') => {
    const sample = samplePiPrefix(theme.getBgAnsi(role), 'background');
    return { ink: sample.ink, color: effectiveColor(sample, theme.colors?.[role], mode) };
  };
  const panel = background('toolPendingBg');
  const surfaces: Partial<Record<CardRole, LiteralInk>> = {};
  if (panel.color) {
    const inks = PI_RULE_BINDINGS.flatMap((role, index) => {
      const source = piBindingInkRole(role), donor = foreground(source);
      // Public faint colors lose indexed provenance; a composed normal font cannot make that RGB known.
      if (donor.attributes & 8 && donor.ink.kind === 'indexed') return [];
      const value = effectiveColor(baseBindings[index]!, theme.colors?.[source], mode);
      return value ? [value] : [];
    });
    const code = known('toolOutput');
    if (code) inks.push(code);
    const diff = diffPalette({ panel: panel.color, codeInks: inks,
      added: background('toolSuccessBg').color, removed: background('toolErrorBg').color,
      numbers: known('dim'), addedSign: known('toolDiffAdded'), removedSign: known('toolDiffRemoved'), mode });
    for (const [code, gutter, sign, source] of [
      ['addedCode', 'addedGutter', 'addedSign', 'toolDiffAdded'],
      ['removedCode', 'removedGutter', 'removedSign', 'toolDiffRemoved'],
    ] as const) {
      const tint = diff[source]!;
      surfaces[code] = tint.code === panel.color ? panel.ink : outputInk(tint.code, mode);
      surfaces[gutter] = surfaces[sign] = tint.gutter === panel.color ? panel.ink : outputInk(tint.gutter, mode);
    }
  }
  const finalSurfaces: (Color | undefined)[] = panel.color ? [panel.color,
    surfaces.addedCode ? inkColor(surfaces.addedCode) : undefined,
    surfaces.removedCode ? inkColor(surfaces.removedCode) : undefined] : [];
  const frozenSurfaces = finalSurfaces.length && finalSurfaces.every((color): color is Color => color !== undefined)
    ? Object.freeze(finalSurfaces) : undefined;
  const variantContext = (binding: PiDerivedMarker, neighbors: readonly ThemeColor[]): PiMarkerVariantContext => {
    const source = PI_MARKER_BINDINGS[binding].ink;
    const parent = effectiveColor(baseBindings[PI_RULE_BINDINGS.indexOf(PI_MARKER_REGIONS[binding])]!, theme.colors?.[source], mode);
    return { parent, neighbors: Object.fromEntries(neighbors.map(role => [role, known(role)])), surfaces: frozenSurfaces };
  };
  const variants = derivePiMarkerVariants(baseBindings, {
    headingMarker: variantContext('headingMarker', ['mdHeading']),
    inlineCodeDelimiter: variantContext('inlineCodeDelimiter', ['mdCode']),
    linkDelimiter: variantContext('linkDelimiter', ['mdLink', 'mdLinkUrl', 'toolOutput']),
  }, mode);
  const roles = {} as Record<CardRole, ConcreteStyle>;
  for (const role of CARD_ROLES) {
    const value = foreground(foregrounds[role]);
    roles[role] = Object.freeze({ foreground: value.ink, background: surfaces[role] ?? panel.ink, attributes: value.attributes });
  }
  return Object.freeze({ bindings: variants.bindings, roles: Object.freeze(roles), variantDecisions: variants.decisions });
}

export function samplePiCardPalette(theme: PiPaletteTheme, mode: TerminalColorMode = 'truecolor'): Readonly<Record<CardRole, ConcreteStyle>> {
  return samplePiPalette(theme, mode).roles;
}
