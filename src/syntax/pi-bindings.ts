import type { Theme } from '@earendil-works/pi-coding-agent';
import type { LiteralInk } from '../occipital/semantic-codec.ts';
import type { StyleBinding } from './style-materialization.ts';
import { PI_RULE_BINDINGS } from './pi-rules.ts';

const invalid = (): never => { throw new Error('invalid Pi binding prefix'); };

/** Sample one bounded public-role set per local palette revision, never in render.
 * getFgAnsi preserves symbolic defaults and faint; theme.colors substitutes
 * terminal guesses and approximates faint with a different RGB. These bindings
 * describe each role in isolation, including its otherwise-normal typography.
 * No theme owner or source text survives in the returned immutable data. */
export function samplePiBindings(theme: Pick<Theme, 'getFgAnsi'>): readonly StyleBinding[] {
  return Object.freeze(PI_RULE_BINDINGS.map(role => samplePiPrefix(theme.getFgAnsi(role))));
}

export function samplePiPrefix(prefix: string, channel: 'foreground' | 'background' = 'foreground'): StyleBinding & { readonly ink: LiteralInk } {
  const normal = channel === 'foreground' ? 30 : 40, bright = normal + 60, extended = normal + 8;
  let ink: LiteralInk = { kind: 'terminal-default' }, attributes = 0, offset = 0;
  while (offset < prefix.length) {
    if (prefix[offset] !== '\x1b' || prefix[offset + 1] !== '[') invalid();
    const end = prefix.indexOf('m', offset + 2);
    if (end < 0) invalid();
    const parts = prefix.slice(offset + 2, end).split(';').map(part => {
      if (part === '') return 0;
      if (!/^\d{1,3}$/.test(part)) return invalid();
      const value = Number(part);
      return value <= 255 ? value : invalid();
    });
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]!;
      if (code === 0) { ink = { kind: 'terminal-default' }; attributes = 0; }
      else if (code === 1 || code === 2 || code === 3 || code === 4) attributes |= code === 1 ? 1 : code === 2 ? 8 : code === 3 ? 2 : 4;
      else if (code === 22) attributes &= ~(1 | 8);
      else if (code === 23) attributes &= ~2;
      else if (code === 24) attributes &= ~4;
      else if (code === normal + 9) ink = { kind: 'terminal-default' };
      else if (code >= normal && code <= normal + 7 || code >= bright && code <= bright + 7) {
        ink = { kind: 'indexed', index: code >= bright ? code - bright + 8 : code - normal };
      } else if (code === extended) {
        const mode = parts[++i];
        if (mode === 5 && i + 1 < parts.length) ink = { kind: 'indexed', index: parts[++i]! };
        else if (mode === 2 && i + 3 < parts.length) ink = { kind: 'rgb', r: parts[++i]!, g: parts[++i]!, b: parts[++i]! };
        else invalid();
      } else invalid();
    }
    offset = end + 1;
  }
  return Object.freeze({ ink: Object.freeze(ink), attributes, attribute_mask: 15 });
}
