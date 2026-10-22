import { backgroundAnsi, foregroundAnsi, indexedColor, rgbColor, type TerminalColorMode } from '@earendil-works/pi-tui';
import type { LiteralInk } from '../occipital/semantic-codec.ts';
import type { ConcreteStyle } from './style-materialization.ts';

export interface AnsiStyle { readonly open: string; readonly close: string }
const resetFonts = '\x1b[22;23;24;29m';
const close = resetFonts + '\x1b[49m\x1b[39m';

/** Compile each prepared style once per palette/terminal-mode revision, outside
 * render. Every span applies complete typography: only setting enabled bits
 * would leave caller faint/bold active after an explicit selector clear. */
export function compileStyleAnsi(style: ConcreteStyle, mode: TerminalColorMode): AnsiStyle {
  let open = color(style.foreground, mode, false) + color(style.background, mode, true) + resetFonts;
  if (style.attributes & 1) open += '\x1b[1m';
  if (style.attributes & 2) open += '\x1b[3m';
  if (style.attributes & 4) open += '\x1b[4m';
  if (style.attributes & 8) open += '\x1b[2m';
  if (style.attributes & 16) open += '\x1b[9m';
  return Object.freeze({ open, close });
}

function color(ink: LiteralInk, mode: TerminalColorMode, background: boolean): string {
  if (ink.kind === 'terminal-default') return background ? '\x1b[49m' : '\x1b[39m';
  const value = ink.kind === 'rgb' ? rgbColor(ink.r, ink.g, ink.b) : indexedColor(ink.index);
  return background ? backgroundAnsi(value, mode) : foregroundAnsi(value, mode);
}
