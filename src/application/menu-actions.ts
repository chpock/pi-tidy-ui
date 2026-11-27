import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import type { ThemePreference } from '../appearance/theme-preference.ts';
import type { TidyMenuAction, TidyMenuOwner } from './menu-contract.ts';
import type { ApplicationPreferences, PreferenceScope, SwitchApplication } from './preferences.ts';
import { RETIRED_SETTINGS_ACTION, type SyntaxMenuOutcome } from './syntax-menu.ts';

export type MenuThemeConfirmation = { kind: 'retired' } | { kind: 'completed'; outcome: SyntaxMenuOutcome };
export type MenuRecordingRetry = 'unavailable' | 'inactive' | 'active';
export type MenuSnapshotWrite = 'notCapturing' | 'writeFailed' | 'retired' | 'written';

export interface MenuActionCapabilities {
  preferences: Pick<ApplicationPreferences, 'setSwitch' | 'appearanceEnabled' | 'terminalColorsEnabled'>;
  scope: PreferenceScope;
  switches: SwitchApplication;
  diagnostic?: DiagnosticSink;
  journal?: DiagnosticSink;
  applyAppearance(): void;
  reapplyTerminalColors(): void;
  confirmTheme(choice: ThemePreference): Promise<MenuThemeConfirmation>;
  /** Capture the receipt synchronously, before a scheduled repaint can rebuild layouts. */
  clearLayouts(): number | undefined;
  recording: { retry(): Promise<MenuRecordingRetry>; writeSnapshot(): Promise<MenuSnapshotWrite> };
}

/** Action policy borrows scoped operations; their native owners and lifetimes stay in composition. */
export async function performMenuAction(action: TidyMenuAction, c: MenuActionCapabilities): ReturnType<TidyMenuOwner['act']> {
  if (!c.scope.current()) return RETIRED_SETTINGS_ACTION;
  diagnose(c.journal, 'INFO', 'runtime', 'Settings menu action requested', { action: action.kind });
  if (action.kind === 'switch') return c.preferences.setSwitch(action.key, action.value, c.scope, c.switches, c.diagnostic);
  if (action.kind === 'theme') {
    const confirmation = await c.confirmTheme(action.choice);
    if (confirmation.kind === 'retired') return RETIRED_SETTINGS_ACTION;
    const outcome = confirmation.outcome;
    return outcome.ok ? outcome : { ok: false, message: `Theme applied for now, but not saved: ${outcome.message}` };
  }
  if (action.kind === 'reapplyAppearance') {
    if (!c.preferences.appearanceEnabled) return { ok: false, message: 'Turn on Tidy UI appearance first.' };
    c.applyAppearance();
  } else if (action.kind === 'reapplyColors') {
    if (!c.preferences.appearanceEnabled || !c.preferences.terminalColorsEnabled)
      return { ok: false, message: 'Turn on appearance and terminal color matching first.' };
    c.reapplyTerminalColors();
  } else if (action.kind === 'clearCache') {
    const clearedLayouts = c.clearLayouts();
    return clearedLayouts === undefined ? { ok: false, message: 'There are no active Tidy UI layouts to clear.' } : { ok: true, clearedLayouts };
  } else if (action.kind === 'retryLogging') {
    const outcome = await c.recording.retry();
    if (outcome === 'unavailable') return { ok: false, message: 'Turn on diagnostic recording first.' };
    if (outcome === 'inactive') return { ok: false, message: 'Recording could not be started. See the log status for details.' };
  } else if (action.kind === 'snapshotLogs') {
    const outcome = await c.recording.writeSnapshot();
    if (outcome === 'notCapturing') return { ok: false, message: 'Snapshot not written: diagnostic recording is off or unavailable.' };
    if (outcome === 'retired') return RETIRED_SETTINGS_ACTION;
    if (outcome === 'writeFailed') return { ok: false, message: 'The diagnostic snapshot could not be written.' };
  }
  return c.scope.current() ? { ok: true } : RETIRED_SETTINGS_ACTION;
}
