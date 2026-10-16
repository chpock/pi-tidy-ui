import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, SelectList, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { readableDiagnosticText } from './debug-log.ts';
import type { Switches, SyntaxTheme } from './settings.ts';
import type { SyntaxMenuOutcome, SyntaxMenuSnapshot } from './occipital/menu.ts';
import type { SessionLogging } from './session-logging.ts';
import { PROTOCOL_VERSION } from './occipital/protocol.ts';

export type TidyMenuAction = { kind: 'switch'; key: keyof Switches; value: boolean }
  | { kind: 'theme'; choice: SyntaxTheme }
  | { kind: 'refreshThemes' | 'reapplyAppearance' | 'reapplyColors' | 'clearCache' | 'retryLogging' | 'snapshotLogs' };
export interface TidyMenuSnapshot extends Switches {
  selected: SyntaxTheme;
  appearance: string;
  terminalColors: string;
  syntax?: SyntaxMenuSnapshot;
  logs?: ReturnType<SessionLogging['status']>;
}
export interface TidyMenuOwner {
  /** Cached state only. Opening the root/status never constructs or starts syntax. */
  snapshot(): TidyMenuSnapshot;
  prepareThemes(): Promise<void>;
  /** Apply cached selection synchronously, without persisting or starting a provider. */
  previewTheme(choice: SyntaxTheme): void;
  act(action: TidyMenuAction): Promise<SyntaxMenuOutcome & { cache?: string[] }>;
  cacheDetails(): string[];
}
type Page = 'root' | 'themes' | 'support' | 'service' | 'logs' | 'cache';
interface Item extends SelectItem { valueText?: string; submenu?: boolean; help: string }
const columnGap = 2;
function itemColumns(items: Item[], width = Infinity) {
  let label = 0, value = 0;
  for (const item of items) { label = Math.max(label, visibleWidth(item.label)); value = Math.max(value, visibleWidth(item.valueText ?? '')); }
  const available = Math.max(1, width - 2);
  const arrow = items.some(item => item.submenu) && available >= 4 ? columnGap + 1 : 0;
  if (value && available - arrow >= columnGap + 2) {
    // Preserve On/Off before allocating extra space to longer values in narrow terminals.
    label = Math.min(label, Math.max(1, available - arrow - columnGap - Math.min(value, 3)));
    value = Math.min(value, Math.max(0, available - arrow - columnGap - label));
  } else { label = Math.min(label, Math.max(1, available - arrow)); value = 0; }
  return { label, value, arrow };
}
const title: Record<Page, string> = { root: 'Tidy UI', themes: 'Code color theme', support: 'Status & troubleshooting',
  service: 'Highlighting service details', logs: 'Diagnostic logs', cache: 'Display cache' };
const onOff = (value: boolean) => value ? 'On' : 'Off';
const safe = (value: string) => readableDiagnosticText(value);

export function profileLabels(profiles: NonNullable<SyntaxMenuSnapshot['provider']['description']>['profiles']): string[] {
  const labels = profiles.map(profile => safe(profile.label));
  return profiles.map((profile, index) => labels.filter(label => label === labels[index]).length > 1 ||
    ['Follow Pi theme', 'Refresh theme list', 'Back'].includes(labels[index]!)
    ? `${labels[index]} [${JSON.stringify(profile.id)}]` : labels[index]!);
}
function selectedLabel(state: TidyMenuSnapshot): string {
  const choice = state.selected;
  return choice.kind === 'pi' ? 'Follow Pi' : safe(state.syntax?.provider.description?.profiles.find(profile => profile.id === choice.id)?.label ?? choice.id);
}
function themesUnavailable(state: TidyMenuSnapshot): string | undefined {
  if (!state.appearanceEnabled) return 'Turn on Tidy UI appearance to use native themes.';
  if (!state.nativeHighlightingEnabled) return 'Turn on Occipital highlighting in Status & troubleshooting to use native themes.';
  if (!state.syntax || state.syntax.provider.availability !== 'ready') return 'Native themes are unavailable. Follow Pi remains selectable.';
  if (!state.syntax.provider.description) return 'The native theme list is not available yet.';
  return undefined;
}

/** One invocation owns one overlay. Syntax/provider generations cannot retire it. */
export class TidyMenu implements Component {
  private page: Page = 'root';
  private selected: Partial<Record<Page, string>> = { root: 'themes' };
  private list?: SelectList;
  private listKey = '';
  private items: Item[] = [];
  private readonly search = new Input();
  private closed = false;
  private busy = false;
  private notice = '';
  private noticeError = false;
  private themeLoading = false;
  private themeLoadFailed = false;
  private themeVisit = 0;
  private originalTheme?: SyntaxTheme;
  private themePreviewed = false;
  private cache: string[] = [];
  private detailOffset = 0;
  private listHeight = 0;
  private bodyWidth = 0;
  private detailLines: string[] = [];
  private detailHeight = 0;
  private frameInset = 0;
  private readonly owner: TidyMenuOwner;
  private readonly theme: Pick<Theme, 'fg' | 'bold'>;
  private readonly requestRender: () => void;
  private readonly done: () => void;
  private readonly height: () => number;
  constructor(owner: TidyMenuOwner, theme: Pick<Theme, 'fg' | 'bold'>,
    requestRender: () => void, done: () => void, height: () => number) {
    this.owner = owner; this.theme = theme; this.requestRender = requestRender; this.done = done; this.height = height;
  }

  close(): void {
    if (this.closed) return;
    this.dispose(); this.done();
  }
  dispose(): void {
    this.closed = true; this.restoreTheme();
    if (this.list) { this.list.onSelect = undefined; this.list.onCancel = undefined; this.list.onSelectionChange = undefined; }
    this.list = undefined;
  }
  invalidate(): void { this.listKey = ''; this.search.invalidate(); }
  /** Confirmed external state changes the rollback point, not an active preview. */
  preferencesChanged(choice: SyntaxTheme): boolean {
    if (this.closed) return false;
    const preview = this.page === 'themes' && !!this.originalTheme && this.themePreviewed;
    if (this.page === 'themes' && this.originalTheme) this.originalTheme = { ...choice };
    this.listKey = ''; this.requestRender();
    return preview;
  }
  private back(): void {
    if (this.page === 'root') { this.close(); return; }
    if (this.page === 'themes') this.restoreTheme();
    this.page = this.page === 'themes' || this.page === 'support' ? 'root' : 'support';
    this.listKey = ''; this.detailOffset = 0; this.notice = ''; this.requestRender();
  }
  private open(page: Page): void {
    this.page = page; this.listKey = ''; this.notice = ''; this.detailOffset = 0;
    if (page === 'cache') this.cache = this.owner.cacheDetails();
    if (page === 'themes') {
      const visit = ++this.themeVisit; this.themePreviewed = false;
      this.themeLoading = true; this.themeLoadFailed = false; this.search.setValue('');
      void this.owner.prepareThemes().then(() => {
        if (!this.closed && this.page === 'themes' && visit === this.themeVisit) {
          this.themeLoading = false;
          const choice = this.owner.snapshot().selected; this.originalTheme = { ...choice };
          this.selected.themes = choice.kind === 'pi' ? 'theme:pi' : `profile:${choice.id}`;
          this.listKey = ''; this.requestRender();
        }
      }, () => {
        if (!this.closed && this.page === 'themes' && visit === this.themeVisit) { this.themeLoading = false; this.themeLoadFailed = true;
          this.feedback('Saved code theme could not be loaded.', true); }
      });
    }
    this.requestRender();
  }
  private restoreTheme(): void {
    const original = this.originalTheme; this.originalTheme = undefined; this.themePreviewed = false; ++this.themeVisit;
    if (original) this.owner.previewTheme(original);
  }
  private previewTheme(value: string): void {
    if (this.closed || this.busy || this.page !== 'themes' || !this.originalTheme) return;
    const state = this.owner.snapshot();
    const profile = !themesUnavailable(state) && state.syntax?.provider.description?.profiles.find(profile => `profile:${profile.id}` === value);
    const choice: SyntaxTheme | undefined = value === 'theme:pi' ? { kind: 'pi' } : profile ? { kind: 'occipital', id: profile.id } : undefined;
    if (choice) { this.themePreviewed = true; this.owner.previewTheme(choice); }
  }
  private confirmTheme(choice: SyntaxTheme): void {
    this.originalTheme = undefined; this.themePreviewed = false; ++this.themeVisit;
    void this.perform({ kind: 'theme', choice });
  }
  private feedback(message: string, error = false): void {
    if (this.closed) return;
    this.notice = message; this.noticeError = error; this.listKey = ''; this.requestRender();
  }
  private async perform(action: TidyMenuAction): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true; this.notice = ''; this.noticeError = false; this.requestRender();
    try {
      const outcome = await this.owner.act(action);
      if (this.closed) return;
      if (action.kind === 'clearCache' && outcome.cache) this.cache = outcome.cache;
      if (action.kind === 'theme' && this.page === 'themes') { this.page = 'root'; this.detailOffset = 0; }
      this.feedback(outcome.ok ? action.kind === 'theme' || action.kind === 'switch' ? '' : 'Done.' : outcome.message, !outcome.ok);
    } catch { this.feedback('This action could not be completed.', true); }
    finally { this.busy = false; if (!this.closed) this.requestRender(); }
  }
  private activate(value: string): void {
    if (this.closed || this.busy) return;
    const state = this.owner.snapshot();
    if (value === 'back') { this.back(); return; }
    if (value === 'close') { this.close(); return; }
    if (['themes', 'support', 'service', 'logs', 'cache'].includes(value)) { this.open(value as Page); return; }
    const switches: Record<string, keyof Switches> = { appearance: 'appearanceEnabled', colors: 'terminalColorsEnabled', native: 'nativeHighlightingEnabled', logging: 'loggingEnabled' };
    const key = switches[value];
    if (key) { void this.perform({ kind: 'switch', key, value: !state[key] }); return; }
    if (value === 'refresh-status') { this.listKey = ''; this.feedback('Status refreshed.'); return; }
    if (value === 'refresh-cache') { this.cache = this.owner.cacheDetails(); this.feedback('Cache statistics refreshed.'); return; }
    if (value === 'refreshThemes' && themesUnavailable(state)) { this.feedback(themesUnavailable(state)!, true); return; }
    if (value === 'theme:pi') { this.confirmTheme({ kind: 'pi' }); return; }
    if (value.startsWith('profile:')) {
      const profile = !themesUnavailable(state) && state.syntax?.provider.description?.profiles.find(profile => `profile:${profile.id}` === value);
      if (profile) this.confirmTheme({ kind: 'occipital', id: profile.id });
      return;
    }
    if (['refreshThemes', 'reapplyAppearance', 'reapplyColors', 'clearCache', 'retryLogging', 'snapshotLogs'].includes(value))
      void this.perform({ kind: value as Exclude<TidyMenuAction, { key: unknown } | { choice: unknown }>['kind'] });
  }
  private navigation(): string {
    return this.page === 'root' ? '↑↓ Navigate · Enter Select · Esc Close' : '↑↓ Navigate · Enter Select · Esc Back';
  }
  preferredWidth(): number {
    if (this.closed) return 1;
    const items = this.pageItems(this.owner.snapshot(), false);
    const columns = itemColumns(items);
    const content = 2 + columns.label + (columns.value ? columnGap + columns.value : 0) + columns.arrow;
    return Math.min(72, Math.max(content, visibleWidth(title[this.page]), visibleWidth(this.navigation())) + 2);
  }
  private pageItems(state: TidyMenuSnapshot, filtered = true): Item[] {
    const back: Item = { value: 'back', label: 'Back', help: 'Return to the previous page.' };
    const item = (value: string, label: string, help: string, valueText?: string, submenu = false): Item => ({ value, label, help, valueText, submenu });
    switch (this.page) {
      case 'root': return [
        item('appearance', 'Tidy UI appearance', 'Style cards, messages, input and footer. Diagnostic logs are independent.', onOff(state.appearanceEnabled)),
        item('themes', 'Code color theme', 'Colors for Bash commands and file previews; does not change Pi’s overall theme.', selectedLabel(state), true),
        item('colors', 'Set terminal colors from Pi theme', 'Set background and default text color from Pi’s theme. Pi controls automatic themes.', onOff(state.terminalColorsEnabled)),
        item('support', 'Status & troubleshooting', 'Check what is active, resolve display problems, or collect diagnostics.', undefined, true),
        item('close', 'Close', 'Close this panel without changing anything.'),
      ];
      case 'themes': {
        if (this.themeLoading || this.themeLoadFailed) return [back];
        const query = filtered ? this.search.getValue().toLocaleLowerCase() : '';
        const profiles = themesUnavailable(state) ? [] : state.syntax?.provider.description?.profiles.filter(profile => profile.id !== 'pi') ?? [];
        const labels = profileLabels(profiles);
        const choices = [item('theme:pi', 'Follow Pi theme', 'Use Pi’s code colors.', state.selected.kind === 'pi' ? 'Selected' : undefined),
          ...profiles.map((profile, index) => item(`profile:${profile.id}`, labels[index]!, 'Preview this theme. Enter saves; Esc restores the previous theme.',
            state.selected.kind === 'occipital' && state.selected.id === profile.id ? 'Selected' : undefined))];
        return [...choices.filter(choice => choice.label.toLocaleLowerCase().includes(query) ||
          choice.value.startsWith('profile:') && choice.value.slice(8).toLocaleLowerCase().includes(query)),
          item('refreshThemes', 'Refresh theme list', 'Reload available native themes explicitly.'), back];
      }
      case 'support': return [
        item('reapplyAppearance', 'Reapply Tidy UI appearance', 'Retry styling without switching it off first. Does not change your current preference.'),
        item('reapplyColors', 'Reapply terminal colors', 'Retry the current color preference. Does not turn synchronization on if it is off.'),
        item('native', 'Use Occipital highlighting', 'Native code colors. Off keeps Pi fallback for files and one color for Bash commands.', onOff(state.nativeHighlightingEnabled)),
        item('service', 'Highlighting service details', 'Versions, connection, selected and effective code colors.', undefined, true),
        item('logs', 'Diagnostic logs', 'Capture, paths, errors, and a snapshot of the current state.', undefined, true),
        item('cache', 'Display cache', 'Statistics and cleanup of saved display layouts, not conversation or syntax data.', undefined, true),
        item('refresh-status', 'Refresh status', 'Read current state only; never starts a service or highlights code.'), back,
      ];
      case 'logs': return [item('logging', 'Record diagnostic logs', 'Capture extension diagnostics independently of appearance.', onOff(state.loggingEnabled)),
        ...(state.logs?.state === 'failed' ? [item('retryLogging', 'Retry recording', 'Retry the failed log destination without toggling the setting.')] : []),
        item('snapshotLogs', 'Write state snapshot', 'Write current extension state to enabled diagnostic logs; does not enable capture.'),
        item('refresh-status', 'Refresh status', 'Read existing logging counters and paths only.'), back];
      case 'cache': return [item('refresh-cache', 'Refresh statistics', 'Read current cache counters.'),
        item('clearCache', 'Clear saved layouts', 'Remove only display layouts. Following frames rebuild them; conversation and syntax data stay intact.'), back];
      case 'service': return [back];
    }
  }
  private summary(state: TidyMenuSnapshot): string[] {
    if (this.page === 'support') return [`Appearance: ${state.appearance}`, `Terminal colors: ${state.terminalColors}`,
      `Code colors: ${!state.appearanceEnabled ? 'Pi interface' : !state.nativeHighlightingEnabled ? 'Native highlighting off; fallback colors' : state.syntax?.provider.availability === 'ready' ? 'Native service available' : 'Fallback colors; native service unavailable'}`];
    if (this.page === 'themes') {
      if (this.themeLoading) return ['Loading saved code theme…'];
      if (this.themeLoadFailed) return ['Saved code theme could not be loaded. Reopen this page to retry.'];
      const lines = [`Selected: ${selectedLabel(state)}`];
      const effective = state.syntax?.effective;
      if (state.selected.kind === 'occipital' && effective?.id !== state.selected.id)
        lines.push('Native selection is not active; using available fallback colors.');
      const unavailable = themesUnavailable(state); if (unavailable) lines.push(unavailable);
      return lines;
    }
    if (this.page === 'logs') {
      const log = state.logs;
      return log ? [`Recording: ${log.capture ? log.state === 'failed' ? 'Failed; retry available' : 'On' : 'Off'}`,
        ...(log.state === 'off' ? ['No log file created.'] : [`Journal: ${safe(log.path)}`, `Session index: ${safe(log.commonPath)}`]),
        `Run: ${safe(log.run)}; session: ${safe(log.session)}`,
        `Session name: ${safe(log.name ?? 'unknown')}`,
        `Records: ${log.records}; writes: ${log.writes}; dropped: ${log.dropped}; errors: ${log.writeErrors}`,
        ...(log.failure ? [`Last issue: ${safe(log.failure)}`] : [])] : ['Diagnostic logging is unavailable in this host.'];
    }
    if (this.page === 'cache') return this.cache;
    if (this.page === 'service') {
      const syntax = state.syntax, provider = syntax?.provider;
      return [`Native highlighting: ${onOff(state.nativeHighlightingEnabled)}`, `Service: ${provider ? `${provider.availability} (${provider.reason})` : 'Not started'}`,
        `Provider: ${provider?.kind ?? 'none'}`, `Daemon version: ${safe(provider?.description?.backend_version ?? 'unavailable')}`,
        `Protocol: ${provider?.description ? PROTOCOL_VERSION : 'unavailable'}`,
        `Standalone version: ${safe(syntax?.standaloneVersion ?? 'not loaded')}`, `Selected theme: ${selectedLabel(state)}`,
        `Effective native theme: ${safe(syntax?.effective?.label ?? 'unavailable')}`, `Last issue: ${safe(syntax?.lastIssue ?? 'none')}`];
    }
    return [];
  }

  focused = false;
  private mouseRows = new Map<number, number>();
  render(width: number): string[] {
    if (this.closed || width <= 0) return [];
    const height = Math.max(1, Math.floor(this.height()));
    const state = this.owner.snapshot();
    this.items = this.pageItems(state);
    const details = this.summary(state);
    const searchRows = this.page === 'themes' && !this.themeLoading && !this.themeLoadFailed && height >= 6 ? 1 : 0;
    // In tiny terminals keep the selectable row and details before adding chrome.
    const noticeHeight = this.notice ? Math.min(2, wrapTextWithAnsi(safe(this.notice), Math.max(1, width - (width >= 8 ? 2 : 0))).length) : 0;
    const sections = height >= 10 + Number(details.length > 0) + searchRows + noticeHeight;
    const framed = width >= 8 && sections;
    const innerWidth = Math.max(1, width - (framed ? 2 : 0));
    const room = height - (framed ? 2 : 0);
    const rule = this.theme.fg('border', '─'.repeat(innerWidth));
    const heading = sections ? [this.theme.fg('accent', this.theme.bold(title[this.page])), rule] : [];
    const helpHeight = height >= 4 ? 3 : 0;
    const fixed = heading.length + searchRows + (sections ? 2 : 0) + helpHeight;
    const noticeRoom = Math.max(0, room - fixed - 1 - Number(details.length > 0));
    const notice = this.notice ? wrapTextWithAnsi(safe(this.notice), innerWidth).slice(0, Math.min(2, noticeRoom))
      .map(line => this.theme.fg(this.noticeError ? 'error' : 'muted', line)) : [];
    const summaries = details.flatMap(line => wrapTextWithAnsi(line, innerWidth));
    const available = room - fixed - notice.length;
    const summaryRoom = Math.min(summaries.length, Math.max(available >= 2 ? 1 : 0,
      available - Math.min(this.items.length + 1, this.page === 'support' ? 9 : 4) - (this.page === 'support' ? 3 : 0)));
    this.detailHeight = summaryRoom;
    this.frameInset = framed ? 1 : 0;
    this.detailLines = summaries;
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, summaries.length - Math.max(1, summaryRoom)));
    const summary = summaries.slice(this.detailOffset, this.detailOffset + summaryRoom).map(line => this.theme.fg('muted', line));
    const groupRoom = this.page === 'support' && available - summary.length >= 8 ? 3 : 0;
    const listRoom = Math.max(1, available - summary.length - groupRoom);
    const maxVisible = Math.max(1, listRoom - 1);
    const columns = itemColumns(this.pageItems(state, false), innerWidth);
    const formatted = this.items.map(item => {
      let label = truncateToWidth(item.label, columns.label, '…');
      if (columns.value) label += ' '.repeat(columns.label - visibleWidth(label) + columnGap) + truncateToWidth(item.valueText ?? '', columns.value, '…');
      if (item.submenu && columns.arrow) label += ' '.repeat(innerWidth - 2 - visibleWidth(label) - 1) + '›';
      return { value: item.value, label };
    });
    const key = JSON.stringify([this.page, innerWidth, maxVisible, formatted]);
    if (!this.list || this.listKey !== key) {
      this.listKey = key;
      this.list = new SelectList(formatted, maxVisible, { selectedPrefix: text => this.theme.fg('accent', text),
        selectedText: text => this.theme.fg('accent', text), description: text => this.theme.fg('muted', text),
        scrollInfo: text => this.theme.fg('dim', text), noMatch: text => this.theme.fg('muted', text) });
      const index = this.items.findIndex(item => item.value === this.selected[this.page]);
      this.list.setSelectedIndex(Math.max(0, index));
      this.list.onSelect = item => this.activate(item.value);
      this.list.onSelectionChange = item => { this.selected[this.page] = item.value; };
      this.list.onCancel = () => this.back();
    }
    const body = [...heading, ...summary];
    this.search.focused = this.focused && this.page === 'themes';
    if (searchRows) body.push(truncateToWidth(`Search: ${this.search.render(Math.max(1, innerWidth - 8))[0] ?? ''}`, innerWidth));
    const rows = this.list.render(innerWidth + 2).slice(0, listRoom);
    this.listHeight = rows.length;
    this.bodyWidth = innerWidth;
    this.mouseRows.clear();
    let previousGroup = '';
    const firstVisible = Math.max(0, Math.min(this.items.findIndex(item => item.value === this.list!.getSelectedItem()?.value) - Math.floor(maxVisible / 2), this.items.length - maxVisible));
    rows.forEach((row, index) => {
      const value = this.items[firstVisible + index]?.value;
      const group = ['reapplyAppearance', 'reapplyColors'].includes(value ?? '') ? 'Appearance' : ['native', 'service'].includes(value ?? '') ? 'Code highlighting' : 'Diagnostics';
      if (groupRoom && index < Math.min(maxVisible, this.items.length) && group !== previousGroup) {
        body.push(this.theme.fg('dim', group)); previousGroup = group;
      }
      this.mouseRows.set(body.length, index);
      body.push(row);
    });
    body.push(...notice);
    if (helpHeight) {
      const help = this.items.find(item => item.value === this.list!.getSelectedItem()?.value)?.help ?? '';
      const wrapped = wrapTextWithAnsi(help, innerWidth);
      const second = wrapped.length > 2 ? truncateToWidth(wrapped[1] ?? '', innerWidth - 1, '') + '…' : wrapped[1] ?? '';
      body.push('', this.theme.fg('muted', wrapped[0] ?? ''), this.theme.fg('muted', second));
    }
    if (sections) {
      const paged = summaries.length > summaryRoom;
      let navigation = (paged ? 'PgUp/PgDn details · ' : '') + this.navigation();
      if (paged && visibleWidth(navigation) > innerWidth) navigation = '↑↓ · Enter · Esc Back · PgUp/PgDn';
      if (paged && visibleWidth(navigation) > innerWidth) navigation = 'Esc Back · PgUp/PgDn';
      body.push(rule, this.theme.fg('dim', navigation));
    }
    const border = (text: string) => this.theme.fg('border', text);
    if (!framed) return body.slice(0, height).map(row => truncateToWidth(row, width));
    return [border(`╭${'─'.repeat(innerWidth)}╮`), ...body.slice(0, room).map((row, index) => index === 1 || index === body.length - 2 ? border(`├${'─'.repeat(innerWidth)}┤`)
        : border('│') + truncateToWidth(row, innerWidth, '…', true) + border('│')),
      border(`╰${'─'.repeat(innerWidth)}╯`)];
  }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = getKeybindings();
    if (matchesKey(data, 'ctrl+c')) { this.close(); return; }
    if (kb.matches(data, 'tui.select.cancel')) { this.back(); return; }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.detailOffset = Math.max(0, Math.min(this.detailLines.length - 1,
        this.detailOffset + (matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, this.detailHeight))); this.requestRender(); return;
    }
    if (!this.list) return;
    if (this.page === 'themes' && !this.themeLoading && !this.themeLoadFailed && !kb.matches(data, 'tui.select.up') &&
      !kb.matches(data, 'tui.select.down') && !kb.matches(data, 'tui.select.confirm')) {
      const before = this.search.getValue(); this.search.handleInput(data);
      if (this.search.getValue() !== before) {
        const first = this.pageItems(this.owner.snapshot())[0]?.value;
        this.selected.themes = first; this.listKey = '';
        if (first) this.previewTheme(first);
      }
    } else {
      this.list.handleInput(data);
      const value = this.list.getSelectedItem()?.value; if (value) this.previewTheme(value);
    }
    if (!this.closed) this.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || !this.list) return undefined;
    if (event.x < this.frameInset || event.x >= this.frameInset + this.bodyWidth) return undefined;
    const y = event.y - this.frameInset;
    const row = this.mouseRows.get(y);
    if (row === undefined && event.type !== 'wheel') return undefined;
    const page = this.page, list = this.list;
    const result = list.handleMouse({ ...event, x: event.x - this.frameInset,
      y: row ?? 0, width: this.bodyWidth + 2, height: this.listHeight });
    if (result) {
      if (this.page === page) {
        const value = list.getSelectedItem()?.value; this.selected[page] = value;
        // Press/click is one confirmation gesture; preview must not replace the
        // native list (and its pressed-row identity) between those two events.
        if (event.type === 'wheel' && value) this.previewTheme(value);
      }
      this.requestRender();
    }
    return result;
  }
}
