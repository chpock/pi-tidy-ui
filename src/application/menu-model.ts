import { readableDiagnosticText as safe } from '../debug-log.ts';
import { displayPath } from '../display-path.ts';
import type { ThemePreference, ThemeVariant } from '../appearance/theme-preference.ts';
import { SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION } from '../occipital/semantic-protocol.ts';
import { THEME_FAMILIES, themeFamilyEntry } from '../themes/catalogue.ts';
import { resolveTheme } from '../themes/selection.ts';
import type { TidyMenuAction, TidyMenuSnapshot, TidyMenuPage, TidyMenuRow, TidyMenuIntent, TidyMenuCommandIntent } from './menu-contract.ts';

interface MenuView {
  themeLoading: boolean;
  themeLoadFailed: boolean;
  query?: string;
  sessionName?: string;
}
const titles: Record<TidyMenuPage, string> = { root: 'Tidy UI', themes: 'Code color theme', support: 'Status & troubleshooting',
  service: 'Highlighting service details', logs: 'Diagnostic logs', cache: 'Display cache', cacheActivity: 'Layout cache activity' };
const onOff = (value: boolean) => value ? 'On' : 'Off';
export const menuPageTitle = (page: TidyMenuPage) => titles[page];
export const menuNavigation = (page: TidyMenuPage) => page === 'root' ? '↑↓ Navigate · Enter Select · Esc Close' : '↑↓ Navigate · Enter Select · Esc Back';

export function themeLabels(themes: typeof THEME_FAMILIES): string[] {
  const labels = themes.map(theme => safe(theme.label));
  return themes.map((theme, index) => labels.filter(label => label === labels[index]).length > 1 ||
    ['Follow Pi theme', 'Back'].includes(labels[index]!)
    ? `${labels[index]} [${JSON.stringify(theme.id)}]` : labels[index]!);
}
function selectedLabel(state: TidyMenuSnapshot): string {
  const choice = state.selected;
  return choice.kind === 'pi' ? 'Follow Pi' : safe(themeFamilyEntry(choice.id)?.label ?? choice.id);
}

export function menuRows(page: TidyMenuPage, state: TidyMenuSnapshot, view: MenuView): TidyMenuRow[] {
  const back: TidyMenuRow = { value: 'back', label: 'Back', help: 'Return to the previous page.', intent: { kind: 'back' } };
  const item = (value: string, label: string, help: string, intent: TidyMenuIntent,
    valueText?: string, submenu = false, disabled = false): TidyMenuRow => ({ value, label, help, intent, valueText, submenu, disabled });
  switch (page) {
    case 'root': return [
      item('appearance', 'Tidy UI appearance', 'Style cards, messages, input and footer.', { kind: 'toggle', key: 'appearanceEnabled' }, onOff(state.appearanceEnabled)),
      item('themes', 'Code color theme', 'Choose colors for Bash and file previews.', { kind: 'navigate', page: 'themes' }, selectedLabel(state), true),
      item('theme-variant', 'Code color variant', 'Switch between dark and light palettes.', { kind: 'toggleVariant' }, state.selected.variant === 'dark' ? 'Dark' : 'Light', false, state.selected.kind === 'pi'),
      item('colors', 'Set terminal colors from Pi theme', 'Use Pi colors for terminal background and text.', { kind: 'toggle', key: 'terminalColorsEnabled' }, onOff(state.terminalColorsEnabled)),
      item('support', 'Status & troubleshooting', 'Check status and troubleshoot display issues.', { kind: 'navigate', page: 'support' }, state.health?.active ? 'Issues' : undefined, true),
      item('close', 'Close', 'Close this menu.', { kind: 'close' }),
    ];
    case 'themes': {
      if (view.themeLoading || view.themeLoadFailed) return [back];
      const query = (view.query ?? '').toLocaleLowerCase();
      const labels = themeLabels(THEME_FAMILIES);
      const choices = [item('theme:pi', 'Follow Pi theme', 'Use Pi’s code colors.', { kind: 'choosePi' }, state.selected.kind === 'pi' ? 'Selected' : undefined),
        ...THEME_FAMILIES.map((family, index) => item(`theme:${family.id}`, labels[index]!, 'Preview this family. Enter saves; Esc restores the previous choice.',
          { kind: 'chooseFamily', id: family.id }, state.selected.kind === 'theme' && state.selected.id === family.id ? 'Selected' : undefined))];
      return [...choices.filter(choice => choice.label.toLocaleLowerCase().includes(query) ||
        choice.value.slice(6).toLocaleLowerCase().includes(query)), back];
    }
    case 'support': return [
      item('reapplyAppearance', 'Reapply Tidy UI appearance', 'Retry styling without changing your preference.', { kind: 'maintain', action: 'reapplyAppearance' }),
      item('reapplyColors', 'Reapply terminal colors', 'Retry terminal color matching if it is on.', { kind: 'maintain', action: 'reapplyColors' }),
      item('native', 'Use Occipital highlighting', 'Use native highlighting instead of the fallback.', { kind: 'toggle', key: 'nativeHighlightingEnabled' }, onOff(state.nativeHighlightingEnabled)),
      item('service', 'Highlighting service details', 'Inspect the service and current code colors.', { kind: 'navigate', page: 'service' }, undefined, true),
      item('logs', 'Diagnostic logs', 'Inspect logging or write a state snapshot.', { kind: 'navigate', page: 'logs' }, undefined, true),
      item('cache', titles.cache, 'Inspect or clear saved display layouts.', { kind: 'navigate', page: 'cache' }, undefined, true),
      item('cacheActivity', titles.cacheActivity, 'See layout reuse, builds and releases.', { kind: 'navigate', page: 'cacheActivity' }, undefined, true),
      back,
    ];
    case 'logs': return [item('logging', 'Record diagnostic logs', 'Record diagnostics even when appearance is off.', { kind: 'toggle', key: 'loggingEnabled' }, onOff(state.loggingEnabled)),
      ...(state.logs?.state === 'failed' ? [item('retryLogging', 'Retry recording', 'Retry the failed log destination.', { kind: 'maintain', action: 'retryLogging' })] : []),
      item('snapshotLogs', 'Write state snapshot', 'Write the current state if recording is on.', { kind: 'maintain', action: 'snapshotLogs' }),
      item('refresh-status', 'Refresh status', 'Read current log counters and paths.', { kind: 'refreshStatus' }), back];
    case 'cache': return [
      item('clearCache', 'Clear saved layouts', 'Clear only display layouts; later frames rebuild them.', { kind: 'maintain', action: 'clearCache' }), back];
    case 'cacheActivity': case 'service': return [back];
  }
}

export function menuThemeChoice(intent: TidyMenuIntent, variant: ThemeVariant | undefined): ThemePreference | undefined {
  if (!variant) return undefined;
  if (intent.kind === 'choosePi') return { kind: 'pi', variant };
  if (intent.kind === 'chooseFamily' && themeFamilyEntry(intent.id)) return { kind: 'theme', id: intent.id, variant };
  return undefined;
}
export function menuAction(intent: TidyMenuCommandIntent, state: TidyMenuSnapshot, variant: ThemeVariant | undefined): TidyMenuAction | undefined {
  switch (intent.kind) {
    case 'toggle': return { kind: 'switch', key: intent.key, value: !state[intent.key] };
    case 'toggleVariant': return state.selected.kind === 'theme'
      ? { kind: 'theme', choice: { kind: 'theme', id: state.selected.id, variant: state.selected.variant === 'dark' ? 'light' : 'dark' } } : undefined;
    case 'choosePi':
    case 'chooseFamily': {
      const choice = menuThemeChoice(intent, variant);
      return choice ? { kind: 'theme', choice } : undefined;
    }
    case 'maintain': return { kind: intent.action };
    default: { const unreachable: never = intent; return unreachable; }
  }
}

function healthSummary(state: TidyMenuSnapshot, syntaxOnly = false): string[] {
  const health = state.health;
  if (!health) return [];
  const issues = health.issues.filter(issue => !syntaxOnly || issue.area === 'syntax');
  const last = health.last;
  return [
    ...(!syntaxOnly ? [`Runtime status: ${health.active ? 'Problems detected' : 'No active runtime errors'}`,
      `Runtime errors: ${health.errors}; active: ${health.active}`] : []),
    ...issues.map(issue => `Unresolved ${issue.area}: ${safe(issue.code)} (${safe(issue.operation)}); ${safe(issue.time)}`),
    ...(last && (!syntaxOnly || last.area === 'syntax') ? [`Last runtime error: ${safe(last.code)}; ${safe(last.time)}; ${last.state === 'released' ? 'owner removed; not a confirmed recovery' : last.state}`] : []),
  ];
}
export function menuDetails(page: TidyMenuPage, state: TidyMenuSnapshot, view: MenuView): string[] {
  if (page === 'support') return [...healthSummary(state), `Appearance: ${state.appearance}`, `Terminal colors: ${state.terminalColors}`,
    `Code colors: ${!state.appearanceEnabled ? 'Pi interface' : selectedLabel(state)}`];
  if (page === 'themes') {
    if (view.themeLoading) return ['Loading saved code theme…'];
    if (view.themeLoadFailed) return ['Saved code theme could not be loaded. Reopen this page to retry.'];
    const lines = [`Selected: ${selectedLabel(state)}`];
    if (resolveTheme(state.selected).missing) lines.push('The saved palette is unknown; using Follow Pi colors.');
    if (state.selected.kind === 'theme' && !state.nativeHighlightingEnabled)
      lines.push('Local palette colors remain active while syntax highlighting is off.');
    else if (state.selected.kind === 'theme' && state.syntax?.provider.availability !== 'ready')
      lines.push('Local palette colors remain active while the highlighting service is unavailable.');
    return lines;
  }
  if (page === 'logs') {
    const log = state.logs;
    return [...healthSummary(state), ...(log ? [`Recording: ${log.capture ? log.state === 'failed' ? 'Failed; retry available' : 'On' : 'Off'}`,
      ...(log.state === 'off' ? ['No log file created.'] : [`Journal: ${safe(displayPath(log.path))}`, `Session index: ${safe(displayPath(log.commonPath))}`]),
      `Run: ${safe(log.run)}; session: ${safe(log.session)}`,
      `Session name: ${safe(view.sessionName ?? 'unknown')}`,
      `Records: ${log.records}; writes: ${log.writes}`,
      `Dropped records: ${log.dropped}; log write errors: ${log.writeErrors}`,
      ...(log.dropped ? ['Some diagnostic records were lost because the log buffer was full.'] : []),
      ...(log.failure ? [`Last logging issue: ${safe(log.failure)}`] : [])] : ['Diagnostic logging is unavailable in this host.'])];
  }
  if (page === 'service') {
    const syntax = state.syntax, provider = syntax?.provider;
    return [...healthSummary(state, true), `Native highlighting: ${onOff(state.nativeHighlightingEnabled)}`, `Service: ${provider ? `${provider.availability} (${provider.reason})` : 'Not started'}`,
      `Provider: ${provider?.kind ?? 'none'}`, `Daemon version: ${safe(provider?.description?.backend_version ?? 'unavailable')}`,
      `Protocol: ${provider?.description ? PROTOCOL_VERSION : 'unavailable'}`,
      `Standalone version: ${safe(syntax?.standaloneVersion ?? 'not loaded')}`, `Selected theme: ${selectedLabel(state)}`,
      `Effective code palette: ${safe(syntax?.effective?.label ?? 'unavailable')}`, `Last issue: ${safe(syntax?.lastIssue ?? 'none')}`];
  }
  return [];
}

type MenuPreferences = Pick<TidyMenuSnapshot, 'appearanceEnabled' | 'terminalColorsEnabled' | 'nativeHighlightingEnabled' | 'loggingEnabled'> & { readonly selectedTheme: ThemePreference };
interface MenuFacts {
  color?: string;
  appearance?: { readonly active: boolean; readonly editorActive: boolean; readonly reason?: string };
  syntax?: TidyMenuSnapshot['syntax'];
  logs?: TidyMenuSnapshot['logs'];
  health?: TidyMenuSnapshot['health'];
}
export function menuSnapshot(preferences: MenuPreferences, facts: MenuFacts): TidyMenuSnapshot {
  const color = facts.color, snapshot = facts.syntax;
  const terminalColors = !preferences.appearanceEnabled ? 'Inactive while Tidy UI appearance is off' : !preferences.terminalColorsEnabled ? 'Off' :
    color === 'automatic theme' || color === 'system theme' ? 'Controlled by Pi’s automatic/system theme' :
    color === 'on' ? 'Matching Pi theme' : color === 'no source' ? 'No file-backed Pi theme available' :
    color === 'source error' ? 'Theme could not be read; last valid colors retained' : color ?? 'Not started';
  return { appearanceEnabled: preferences.appearanceEnabled, terminalColorsEnabled: preferences.terminalColorsEnabled,
    nativeHighlightingEnabled: preferences.nativeHighlightingEnabled, loggingEnabled: preferences.loggingEnabled,
    selected: snapshot?.selected ?? preferences.selectedTheme, syntax: snapshot, logs: facts.logs, health: facts.health, terminalColors,
    appearance: !preferences.appearanceEnabled ? 'Off; using Pi’s interface' : !facts.appearance?.active ? facts.appearance?.reason ?? 'Not active' :
      facts.appearance.editorActive ? 'Active' : 'Cards active; input styling not applied' };
}
