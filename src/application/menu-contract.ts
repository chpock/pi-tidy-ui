import type { ThemePreference } from '../appearance/theme-preference.ts';
import type { Switches } from '../settings.ts';
import type { SyntaxMenuOutcome, SyntaxMenuSnapshot } from './syntax-menu.ts';
import type { RuntimeHealthSnapshot } from '../runtime-health.ts';
import type { SessionLogging } from '../session-logging.ts';

export type TidyMenuMaintenanceKind = 'reapplyAppearance' | 'reapplyColors' | 'clearCache' | 'retryLogging' | 'snapshotLogs';
export type TidyMenuAction = { kind: 'switch'; key: keyof Switches; value: boolean }
  | { kind: 'theme'; choice: ThemePreference }
  | { kind: TidyMenuMaintenanceKind };
export interface TidyMenuSnapshot extends Switches {
  selected: ThemePreference;
  appearance: string;
  terminalColors: string;
  syntax?: SyntaxMenuSnapshot;
  logs?: ReturnType<SessionLogging['status']>;
  health?: RuntimeHealthSnapshot;
}
export interface TidyMenuOwner {
  /** Cached state only. Opening the root/status never constructs or starts syntax. */
  snapshot(): TidyMenuSnapshot;
  prepareThemes(): Promise<void>;
  /** Apply cached selection synchronously, without persisting or starting a provider. */
  previewTheme(choice: ThemePreference): void;
  act(action: TidyMenuAction): Promise<SyntaxMenuOutcome & { cache?: string[] }>;
  cacheDetails(): string[];
}
export type TidyMenuPage = 'root' | 'themes' | 'support' | 'service' | 'logs' | 'cache';
export type TidyMenuCommandIntent = { kind: 'toggle'; key: keyof Switches }
  | { kind: 'toggleVariant' }
  | { kind: 'choosePi' }
  | { kind: 'chooseFamily'; id: string }
  | { kind: 'maintain'; action: TidyMenuMaintenanceKind };
export type TidyMenuIntent = TidyMenuCommandIntent
  | { kind: 'navigate'; page: TidyMenuPage }
  | { kind: 'back' | 'close' | 'refreshStatus' | 'refreshCache' };
export interface TidyMenuRow {
  value: string;
  label: string;
  help: string;
  intent: TidyMenuIntent;
  valueText?: string;
  submenu?: boolean;
  disabled?: boolean;
}
