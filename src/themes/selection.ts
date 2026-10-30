import type { SyntaxTheme } from '../settings.ts';
import { themeEntry } from '../themes/catalogue.ts';

export interface ThemeDescription {
  readonly kind: 'pi' | 'theme';
  readonly id: string;
  readonly label: string;
  readonly fingerprint: string;
}
export interface ResolvedTheme { readonly effective: ThemeDescription; readonly missing: boolean }

const PI_THEME: ThemeDescription = Object.freeze({ kind: 'pi', id: 'pi', label: 'Follow Pi', fingerprint: 'pi-palette-v1' });

/** Palette identity is local and independent of the helper's availability. */
export function resolveTheme(selected: SyntaxTheme): ResolvedTheme {
  if (selected.kind === 'pi') return { effective: PI_THEME, missing: false };
  const entry = themeEntry(selected.id);
  return entry
    ? { effective: Object.freeze({ kind: 'theme', id: entry.id, label: entry.label, fingerprint: `owned-palette-v1:${entry.id}` }), missing: false }
    : { effective: PI_THEME, missing: true };
}
