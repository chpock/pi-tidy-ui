import type { SyntaxTheme } from '../settings.ts';
import type { ThemeDescription } from '../themes/selection.ts';
import type { ProviderSnapshot } from './provider.ts';

export type SyntaxMenuOutcome = { ok: true } | { ok: false; message: string };

export interface SyntaxMenuSnapshot {
  enabled: boolean;
  provider: ProviderSnapshot;
  standaloneVersion: string;
  selected: SyntaxTheme;
  effective?: ThemeDescription;
  /** Owner-supplied bounded, public-safe issue; never a raw transport/settings error. */
  lastIssue?: string;
}

/** Cached metadata only. The owner guards its own asynchronous mutations against
 * retirement; the menu's current callback cannot cancel work already delegated.
 * Outcome messages and declared versions must be bounded and public-safe. */
export interface SyntaxMenuOwner {
  /** Read cached, validated metadata only; no describe, refresh or startup. */
  snapshot(): SyntaxMenuSnapshot;
  /** May apply the live selection even when persistence returns an error. */
  selectTheme(choice: SyntaxTheme): Promise<SyntaxMenuOutcome>;
  setEnabled(enabled: boolean): Promise<void>;
}
