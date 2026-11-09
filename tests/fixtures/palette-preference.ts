import { themePreferenceFromSettings } from '../../src/settings.ts';
import type { ThemePreference } from '../../src/appearance/theme-preference.ts';

/** Explicit concrete-asset fixtures retain their variant; saved settings do not infer it. */
export function palettePreference(id: string): ThemePreference {
  return themePreferenceFromSettings({ kind: 'theme', id }, id.endsWith('-light') ? 'light' : 'dark');
}
