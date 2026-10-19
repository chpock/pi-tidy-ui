import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { colorToRgb, type Color } from '@earendil-works/pi-tui';
import { diffPalette } from '../diff-palette.ts';
import { CARD_ROLES, type CardRole, type LiteralInk } from '../occipital/semantic-codec.ts';
import { samplePiPrefix } from './pi-bindings.ts';
import type { ConcreteStyle } from './style-materialization.ts';

const foregrounds = {
  panel: 'toolOutput', plain: 'toolOutput', code: 'toolOutput', output: 'toolOutput',
  empty: 'dim', padding: 'toolOutput', service: 'muted', muted: 'muted', footer: 'muted', reminder: 'muted',
  overflow: 'dim', diagnostic: 'error', title: 'toolTitle', prompt: 'dim', frame: 'borderMuted',
  error: 'error', errorFrame: 'error', warning: 'warning', gutter: 'dim', numbers: 'dim',
  addedCode: 'toolOutput', addedGutter: 'dim', addedSign: 'toolDiffAdded',
  removedCode: 'toolOutput', removedGutter: 'dim', removedSign: 'toolDiffRemoved',
} as const satisfies Record<CardRole, ThemeColor>;

/** Bounded Follow Pi input adapter, once per local palette revision. Native
 * palettes never use this adapter. The caller funds/adopts its detached data. */
export function samplePiCardPalette(theme: Pick<Theme, 'getFgAnsi' | 'getBgAnsi' | 'colors'>): Readonly<Record<CardRole, ConcreteStyle>> {
  const panel = samplePiPrefix(theme.getBgAnsi('toolPendingBg'), 'background').ink;
  // Terminal-default is not an RGB color. Preserve it instead of deriving tints
  // from the color helper's fallback guess for an unknown terminal background.
  const diff = panel.kind === 'terminal-default' ? {} : diffPalette(theme.colors);
  const surfaces: Partial<Record<CardRole, LiteralInk>> = {};
  for (const [code, gutter, sign, source] of [
    ['addedCode', 'addedGutter', 'addedSign', 'toolDiffAdded'],
    ['removedCode', 'removedGutter', 'removedSign', 'toolDiffRemoved'],
  ] as const) {
    const tint = diff[source];
    if (tint) { surfaces[code] = rgb(tint.code); surfaces[gutter] = surfaces[sign] = rgb(tint.gutter); }
  }
  const sampled = new Map<ThemeColor, ReturnType<typeof samplePiPrefix>>(), roles = {} as Record<CardRole, ConcreteStyle>;
  for (const role of CARD_ROLES) {
    const key = foregrounds[role];
    let foreground = sampled.get(key);
    if (!foreground) { foreground = samplePiPrefix(theme.getFgAnsi(key)); sampled.set(key, foreground); }
    roles[role] = Object.freeze({ foreground: foreground.ink, background: surfaces[role] ?? panel, attributes: foreground.attributes });
  }
  return Object.freeze(roles);
}
function rgb(color: Color): LiteralInk {
  const { r, g, b } = colorToRgb(color);
  return Object.freeze({ kind: 'rgb', r, g, b });
}
