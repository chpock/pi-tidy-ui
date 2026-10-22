import { colorToRgb, foregroundAnsi, indexedColor, rgbColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import type { LiteralInk } from '../occipital/semantic-codec.ts';
import { samplePiPrefix } from './pi-bindings.ts';

export function outputInk(color: Color, mode: TerminalColorMode): LiteralInk {
  return samplePiPrefix(foregroundAnsi(color, mode)).ink;
}

/** Indexed output uses Pi's conventional palette model, not a terminal query. */
export function inkColor(ink: LiteralInk): Color | undefined {
  if (ink.kind === 'terminal-default') return;
  const color = ink.kind === 'rgb' ? ink : indexedColor(ink.index);
  const { r, g, b } = colorToRgb(color);
  return rgbColor(r, g, b);
}

/** Public prefixes provide ink/typography; authored kind distinguishes a concrete
 * color quantized for output from a user-authored terminal palette reference. */
export function effectiveColor(sample: ReturnType<typeof samplePiPrefix>, authored: Color | undefined,
  mode: TerminalColorMode): Color | undefined {
  if (!authored || authored.kind === 'indexed' || sample.attributes & 8 || sample.ink.kind === 'terminal-default') return;
  const color = inkColor(sample.ink);
  return color && inkColor(outputInk(color, mode));
}

export function luminance(color: Color): number {
  const { r, g, b } = colorToRgb(color);
  const channel = (n: number) => n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a: number, b: number): number { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
