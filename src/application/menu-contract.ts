import type { ThemePreference } from '../appearance/theme-preference.ts';
import type { Switches } from '../settings.ts';
import type { SyntaxMenuOutcome, SyntaxMenuSnapshot } from './syntax-menu.ts';
import type { RuntimeHealthSnapshot } from '../runtime-health.ts';
import type { SessionLogging } from '../session-logging.ts';
import type { LayoutMemory } from '../render-cache.ts';
import type { PresentationCacheStats } from '../presentation/cache-owner.ts';

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
export interface CacheMenuSnapshot {
  readonly active: boolean;
  readonly stats: PresentationCacheStats;
  readonly footer?: LayoutMemory;
  readonly heapUsedBytes?: number;
}
export interface TidyMenuOwner {
  /** Cached state only. Opening the root/status never constructs or starts syntax. */
  snapshot(): TidyMenuSnapshot;
  prepareThemes(): Promise<void>;
  /** Apply cached selection synchronously, without persisting or starting a provider. */
  previewTheme(choice: ThemePreference): void;
  act(action: TidyMenuAction): Promise<SyntaxMenuOutcome & { clearedLayouts?: number }>;
  /** Read existing counters on entry and once per second while this cache page is open. */
  cacheDetails(page: CacheMenuPage): CacheMenuSnapshot | undefined;
  /** Read current Pi metadata on explicit Diagnostic logs navigation or refresh, never during render. */
  readSessionName(): string | undefined;
}
export type CacheMenuPage = 'cache' | 'cacheActivity';
export type TidyMenuPage = 'root' | 'themes' | 'support' | 'service' | 'logs' | CacheMenuPage;
export type TidyMenuCommandIntent = { kind: 'toggle'; key: keyof Switches }
  | { kind: 'toggleVariant' }
  | { kind: 'choosePi' }
  | { kind: 'chooseFamily'; id: string }
  | { kind: 'maintain'; action: TidyMenuMaintenanceKind };
export type TidyMenuIntent = TidyMenuCommandIntent
  | { kind: 'navigate'; page: TidyMenuPage }
  | { kind: 'back' | 'close' | 'refreshStatus' };
export interface TidyMenuRow {
  value: string;
  label: string;
  help: string;
  intent: TidyMenuIntent;
  valueText?: string;
  submenu?: boolean;
  disabled?: boolean;
}
