import type { ThemePreference } from '../appearance/theme-preference.ts';
import type { ThemeDescription } from '../themes/selection.ts';
import type { ProviderSnapshot } from '../occipital/provider.ts';

export type SyntaxMenuOutcome = { ok: true } | { ok: false; message: string };

export interface SyntaxMenuSnapshot {
  enabled: boolean;
  provider: ProviderSnapshot;
  standaloneVersion: string;
  selected: ThemePreference;
  effective?: ThemeDescription;
  /** Owner-supplied bounded, public-safe issue; never a raw transport/settings error. */
  lastIssue?: string;
}
