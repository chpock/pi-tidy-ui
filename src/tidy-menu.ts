import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, SelectList, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { readableDiagnosticText } from './debug-log.ts';
import { wrapText } from './text-wrap.ts';
import { cacheClearResult, cacheMenuDetails, isCacheMenuPage } from './application/cache-menu.ts';
import { copyThemePreference, type ThemePreference, type ThemeVariant } from './appearance/theme-preference.ts';
import { isDeepStrictEqual } from 'node:util';
import type { CacheMenuSnapshot, TidyMenuAction, TidyMenuSnapshot, TidyMenuOwner, TidyMenuPage as Page, TidyMenuRow as Item, TidyMenuIntent } from './application/menu-contract.ts';
import { menuRows, menuDetails, menuAction, menuThemeChoice, menuPageTitle, menuNavigation } from './application/menu-model.ts';
const columnGap = 2;
const submenuPadding = '  ';
const diagnosticWidth = 98; // Fits the 96-column cache scope note plus the frame.
const supportGroupCount = 3;
function itemColumns(items: Item[], width = Infinity) {
  let label = 0, value = 0;
  for (const item of items) { label = Math.max(label, visibleWidth(item.label)); value = Math.max(value, visibleWidth(item.valueText ?? '')); }
  const available = Math.max(1, width - 2);
  const hasSubmenus = items.some(item => item.submenu);
  const minText = hasSubmenus ? 2 : 1; // Leave room for a letter and the ellipsis before adding an arrow or value.
  const arrowWidth = columnGap + 1;
  const arrow = hasSubmenus && available >= arrowWidth + submenuPadding.length + minText ? arrowWidth : 0;
  const textRoom = available - (arrow ? arrow + submenuPadding.length : 0);
  if (value && (!hasSubmenus || arrow) && textRoom >= columnGap + 2 * minText) {
    // Preserve On/Off before allocating extra space to longer values in narrow terminals.
    label = Math.min(label, Math.max(minText, textRoom - columnGap - Math.min(value, 3)));
    value = Math.min(value, Math.max(0, textRoom - columnGap - label));
  } else { label = Math.min(label, Math.max(1, textRoom)); value = 0; }
  return { label, value, arrow };
}
const safe = (value: string) => readableDiagnosticText(value);

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
  private outcome?: { text: string; color: 'success' | 'error' };
  private navigationRevision = 0;
  private themeLoading = false;
  private themeLoadFailed = false;
  private themeVisit = 0;
  private originalTheme?: ThemePreference;
  private themeVariant?: ThemeVariant;
  private themePreviewed = false;
  private cacheVisit?: { clearedLayouts?: number };
  private cacheSnapshot?: CacheMenuSnapshot;
  private pageTimer?: ReturnType<typeof setInterval>;
  private paintedSupport?: { items: Item[]; details: string[] };
  private sessionName?: string;
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
    this.closed = true; this.mousePressOrigin = undefined; this.stopPageSampling(); this.cacheVisit = undefined; this.restoreTheme();
    if (this.list) { this.list.onSelect = undefined; this.list.onCancel = undefined; this.list.onSelectionChange = undefined; }
    this.list = undefined;
  }
  invalidate(): void { this.listKey = ''; this.search.invalidate(); }
  /** Confirmed external state changes the rollback point, not an active preview. */
  preferencesChanged(choice: ThemePreference): boolean {
    if (this.closed) return false;
    const preview = this.page === 'themes' && !!this.originalTheme && this.themePreviewed;
    if (this.page === 'themes' && this.originalTheme) {
      this.originalTheme = copyThemePreference(choice);
      if (!this.themePreviewed) {
        this.themeVariant = choice.variant;
        if (this.selected.themes !== 'back') this.selected.themes = choice.kind === 'pi' ? 'theme:pi' : `theme:${choice.id}`;
      }
    }
    this.listKey = ''; this.requestRender();
    return preview;
  }
  private back(): void {
    if (this.page === 'root') { this.close(); return; }
    if (this.page === 'themes') this.restoreTheme();
    if (this.page === 'support') this.cacheVisit = undefined;
    this.open(this.page === 'themes' || this.page === 'support' ? 'root' : 'support');
  }
  private open(page: Page): void {
    this.stopPageSampling();
    this.page = page; this.listKey = ''; this.detailOffset = 0; this.moved();
    this.startPageSampling(page);
    if (page === 'logs') this.sessionName = this.owner.readSessionName();
    if (page === 'themes') {
      const visit = ++this.themeVisit; this.themePreviewed = false; this.themeVariant = undefined;
      this.themeLoading = true; this.themeLoadFailed = false; this.search.setValue('');
      void this.owner.prepareThemes().then(() => {
        if (!this.closed && this.page === 'themes' && visit === this.themeVisit) {
          this.themeLoading = false;
          const choice = this.owner.snapshot().selected; this.originalTheme = copyThemePreference(choice); this.themeVariant = choice.variant;
          this.selected.themes = choice.kind === 'pi' ? 'theme:pi' : `theme:${choice.id}`;
          this.listKey = ''; this.requestRender();
        }
      }, () => {
        if (!this.closed && this.page === 'themes' && visit === this.themeVisit) { this.themeLoading = false; this.themeLoadFailed = true;
          this.listKey = ''; this.requestRender(); }
      });
    }
    this.requestRender();
  }
  private startPageSampling(page: Page): void {
    if (isCacheMenuPage(page)) {
      this.cacheVisit ??= {};
      this.cacheSnapshot = this.owner.cacheDetails(page);
    } else if (page !== 'support') return;
    this.pageTimer = setInterval(() => {
      if (page === 'support') {
        const state = this.owner.snapshot();
        const support = { items: this.pageItems(state), details: this.summary(state) };
        if (!isDeepStrictEqual(support, this.paintedSupport)) this.requestRender();
      } else {
        const snapshot = this.owner.cacheDetails(page);
        if (!isDeepStrictEqual(snapshot, this.cacheSnapshot)) { this.cacheSnapshot = snapshot; this.requestRender(); }
      }
    }, 1000);
    this.pageTimer.unref?.();
  }
  private stopPageSampling(): void {
    clearInterval(this.pageTimer); this.pageTimer = undefined; this.cacheSnapshot = undefined; this.paintedSupport = undefined;
  }
  private resetThemePreview(): void {
    const original = this.originalTheme;
    if (!this.themePreviewed || !original) return;
    this.themePreviewed = false; this.themeVariant = original.variant;
    this.owner.previewTheme(original);
  }
  private restoreTheme(): void {
    this.resetThemePreview(); this.originalTheme = undefined; ++this.themeVisit;
  }
  private rowIntent(value: string): TidyMenuIntent | undefined {
    return this.items.find(item => item.value === value)?.intent;
  }
  private previewTheme(intent: TidyMenuIntent | undefined): void {
    if (this.closed || this.busy || this.page !== 'themes' || !this.originalTheme) return;
    if (intent?.kind === 'back') { this.resetThemePreview(); return; }
    const choice = intent && menuThemeChoice(intent, this.themeVariant);
    if (choice) { this.themePreviewed = true; this.owner.previewTheme(choice); }
  }
  private confirmTheme(choice: ThemePreference): void {
    this.originalTheme = undefined; this.themePreviewed = false; ++this.themeVisit;
    void this.perform({ kind: 'theme', choice });
  }
  private moved(): void {
    this.outcome = undefined; ++this.navigationRevision;
  }
  private select(value: string): void {
    if (this.selected[this.page] === value) return;
    this.selected[this.page] = value; this.moved();
  }
  private feedback(text: string, color: 'success' | 'error' = 'success'): void {
    this.outcome = { text, color };
  }
  private async perform(action: TidyMenuAction): Promise<void> {
    if (this.closed || this.busy) return;
    const revision = this.navigationRevision;
    const cacheVisit = action.kind === 'clearCache' ? this.cacheVisit : undefined;
    this.busy = true; this.requestRender();
    let outcome: Awaited<ReturnType<TidyMenuOwner['act']>>;
    try { outcome = await this.owner.act(action); }
    catch { outcome = { ok: false, message: 'This action could not be completed.' }; }
    this.busy = false;
    if (this.closed) return;
    const cleared = outcome.ok ? outcome.clearedLayouts : undefined;
    if (cacheVisit && cacheVisit === this.cacheVisit && cleared !== undefined) cacheVisit.clearedLayouts = cleared;
    const current = this.navigationRevision === revision;
    if (action.kind === 'theme' && this.page === 'themes') { this.page = 'root'; this.detailOffset = 0; this.moved(); }
    if (current && cleared === undefined) this.feedback(outcome.ok ? 'Done.' : outcome.message, outcome.ok ? 'success' : 'error');
    this.requestRender();
  }
  private activate(value: string): void {
    if (this.closed || this.busy) return;
    const intent = this.rowIntent(value);
    if (!intent) return;
    const state = this.owner.snapshot();
    switch (intent.kind) {
      case 'back': this.back(); return;
      case 'close': this.close(); return;
      case 'navigate': this.open(intent.page); return;
      case 'refreshStatus':
        if (this.page === 'logs') this.sessionName = this.owner.readSessionName();
        this.feedback('Status refreshed.'); this.requestRender(); return;
      case 'toggle':
      case 'toggleVariant':
      case 'choosePi':
      case 'chooseFamily':
      case 'maintain': {
        const action = menuAction(intent, state, this.themeVariant);
        if (action?.kind === 'theme') this.confirmTheme(action.choice);
        else if (action) void this.perform(action);
        return;
      }
      default: { const unreachable: never = intent; return unreachable; }
    }
  }
  preferredWidth(): number {
    if (this.closed) return 1;
    if (this.page === 'support' || this.page === 'service' || this.page === 'logs' || isCacheMenuPage(this.page)) return diagnosticWidth;
    const items = this.pageItems(this.owner.snapshot(), false);
    const columns = itemColumns(items);
    const content = 2 + columns.label + (columns.value ? columnGap + columns.value : 0) + columns.arrow;
    // The main menu's extra width already covers the arrow's right padding.
    const fitted = Math.min(72, Math.max(content, visibleWidth(menuPageTitle(this.page)), visibleWidth(menuNavigation(this.page))) + 2);
    return this.page === 'root' ? Math.round(fitted * 1.2) : fitted;
  }
  private pageItems(state: TidyMenuSnapshot, filtered = true): Item[] {
    return menuRows(this.page, state, { query: filtered ? this.search.getValue() : undefined,
      themeLoading: this.themeLoading, themeLoadFailed: this.themeLoadFailed });
  }
  private summary(state: TidyMenuSnapshot): string[] {
    return menuDetails(this.page, state, { themeLoading: this.themeLoading, themeLoadFailed: this.themeLoadFailed,
      sessionName: this.sessionName });
  }

  focused = false;
  private mouseRows = new Map<number, { row: number; value?: string }>();
  private mousePressOrigin?: 'accepted' | 'disabled';
  render(width: number): string[] {
    if (this.closed || width <= 0) return [];
    const height = Math.max(1, Math.floor(this.height()));
    const state = this.owner.snapshot();
    this.items = this.pageItems(state);
    const root = this.page === 'root', themes = this.page === 'themes', logs = this.page === 'logs';
    if (root && state.selected.kind === 'pi' && this.selected.root === 'theme-variant') this.select('themes');
    const cachePage = isCacheMenuPage(this.page) ? this.page : undefined;
    const details = cachePage ? undefined : this.summary(state);
    if (this.page === 'support') this.paintedSupport = { items: this.items, details: details! };
    const hasDetails = Number(!!cachePage || !!details?.length);
    const searchRows = this.page === 'themes' && !this.themeLoading && !this.themeLoadFailed && height >= 6 ? 1 : 0;
    const helpHeight = !themes && height >= 4 ? 2 : 0;
    // In tiny terminals keep the selectable row and details before adding chrome.
    const sections = height >= 10 + hasDetails + searchRows;
    const framed = width >= 8 && sections;
    const innerWidth = Math.max(1, width - (framed ? 2 : 0));
    const room = height - (framed ? 2 : 0);
    const rule = this.theme.fg('border', '─'.repeat(innerWidth));
    const heading = sections ? [this.theme.fg('accent', this.theme.bold(menuPageTitle(this.page))), rule] : [];
    const fixed = heading.length + searchRows + (sections ? 2 : 0) + helpHeight;
    const detailRows = cachePage ? cacheMenuDetails(cachePage, this.cacheSnapshot, innerWidth) : details!;
    const wrappedDetails = logs || cachePage
      ? detailRows.map(line => visibleWidth(line) <= innerWidth ? [line] : wrapText(line, innerWidth, { wide: 'replace' }))
      : detailRows.map(line => wrapTextWithAnsi(line, innerWidth));
    let minimumDetails = hasDetails;
    if (searchRows) {
      const selection = wrappedDetails[0]!;
      selection.push('');
      minimumDetails = selection.length;
    }
    const summaries = wrappedDetails.flat();
    const available = room - fixed;
    const support = this.page === 'support';
    const reservedListRows = support ? this.items.length + 1 : Math.min(this.items.length + 1, 4);
    const summaryRoom = Math.min(summaries.length, Math.max(0, Math.min(available - 1, minimumDetails),
      available - reservedListRows - (support ? supportGroupCount : 0)));
    this.detailHeight = summaryRoom;
    this.frameInset = framed ? 1 : 0;
    this.detailLines = summaries;
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, summaries.length - Math.max(1, summaryRoom)));
    const summary = summaries.slice(this.detailOffset, this.detailOffset + summaryRoom).map(line => this.theme.fg('muted', line));
    const afterSummary = available - summary.length;
    const detailGap = !root && !themes && summary.length > 0 && afterSummary > Math.min(2, this.items.length) ? 1 : 0;
    const groupRoom = support && afterSummary - detailGap >= this.items.length + supportGroupCount ? supportGroupCount : 0;
    const rootGap = root && sections && available > 2 ? 1 : 0;
    const unspacedListRoom = afterSummary - detailGap - groupRoom - rootGap;
    // Keep details, headings and all choices ahead of gaps between groups or above Back.
    const gapCount = logs || cachePage === 'cache' ? 1 : groupRoom;
    const gapRoom = unspacedListRoom - this.items.length >= gapCount ? gapCount : 0;
    const listSpace = Math.max(1, unspacedListRoom - gapRoom);
    const searchGap = searchRows && listSpace > 3 ? 1 : 0;
    const themeBoundaries: number[] = [];
    const dividerPadding = '  ';
    const dividerColumns = innerWidth - 2 * dividerPadding.length;
    if (this.page === 'themes' && dividerColumns > 0 && this.items.length > 1) {
      if (this.items.length > 2 && this.items[0]!.intent.kind === 'choosePi') themeBoundaries.push(1);
      themeBoundaries.push(this.items.length - 1); // Back is always the last theme-picker row.
    }
    const choiceSpace = listSpace - searchGap;
    const themeListHeight = this.items.length + themeBoundaries.length;
    const wholeThemeListFits = this.page === 'themes' && themeListHeight <= choiceSpace;
    // A scrolling window cannot include both ends, so reserve at most one line.
    let separatorsLeft = wholeThemeListFits ? themeBoundaries.length : Math.min(1, themeBoundaries.length, Math.max(0, choiceSpace - 3));
    const backGap = searchRows && (wholeThemeListFits ? themeListHeight < choiceSpace : choiceSpace - separatorsLeft > 3) ? 1 : 0;
    const listRoom = choiceSpace - separatorsLeft - backGap;
    const wholeDiagnosticListFits = (this.page === 'support' || logs || cachePage) && this.items.length <= listRoom;
    const maxVisible = Math.max(1, listRoom - (wholeThemeListFits || wholeDiagnosticListFits ? 0 : 1));
    const columns = itemColumns(this.pageItems(state, false), innerWidth);
    const formatted = this.items.map(item => {
      let label = truncateToWidth(item.label, columns.label, '…');
      if (columns.value) label += ' '.repeat(columns.label - visibleWidth(label) + columnGap) + truncateToWidth(item.valueText ?? '', columns.value, '…');
      if (item.submenu && columns.arrow) label += ' '.repeat(innerWidth - 3 - submenuPadding.length - visibleWidth(label)) + '›' + submenuPadding;
      if (item.disabled) label = this.theme.fg('dim', label);
      return { value: item.value, label };
    });
    const key = JSON.stringify([this.page, innerWidth, maxVisible, this.items.map(item => item.disabled ?? false), formatted]);
    if (!this.list || this.listKey !== key) {
      this.listKey = key;
      // Rebuilding drops native press identity, but a disabled-origin release stays blocked.
      if (this.mousePressOrigin === 'accepted') this.mousePressOrigin = undefined;
      this.list = new SelectList(formatted, maxVisible, { selectedPrefix: text => this.theme.fg('accent', text),
        selectedText: text => this.theme.fg('accent', text), description: text => this.theme.fg('muted', text),
        scrollInfo: text => this.theme.fg('dim', text), noMatch: text => this.theme.fg('muted', text) });
      const index = this.items.findIndex(item => item.value === this.selected[this.page]);
      this.list.setSelectedIndex(Math.max(0, index));
      this.list.onSelect = item => this.activate(item.value);
      this.list.onSelectionChange = item => this.select(item.value);
      this.list.onCancel = () => this.back();
    }
    const body = [...heading, ...summary];
    if (rootGap || detailGap) body.push('');
    this.search.focused = this.focused && this.page === 'themes';
    if (searchRows) {
      body.push(truncateToWidth(`Search: ${this.search.render(Math.max(1, innerWidth - 8))[0] ?? ''}`, innerWidth));
      if (searchGap) body.push('');
    }
    const rows = this.list.render(innerWidth + 2).slice(0, listRoom);
    this.listHeight = rows.length;
    this.bodyWidth = innerWidth;
    this.mouseRows.clear();
    let previousGroup = '';
    const firstVisible = Math.max(0, Math.min(this.items.findIndex(item => item.value === this.list!.getSelectedItem()?.value) - Math.floor(maxVisible / 2), this.items.length - maxVisible));
    rows.forEach((row, index) => {
      const value = this.items[firstVisible + index]?.value;
      if (separatorsLeft && index > 0 && index < maxVisible && themeBoundaries.includes(firstVisible + index)) {
        body.push(this.theme.fg('dim', `${dividerPadding}${'─'.repeat(dividerColumns)}${dividerPadding}`)); separatorsLeft--;
      }
      if (groupRoom && index < Math.min(maxVisible, this.items.length)) {
        const group = value === 'back' ? '' : value === 'reapplyAppearance' || value === 'reapplyColors' ? 'Appearance'
          : value === 'native' || value === 'service' ? 'Code highlighting' : 'Diagnostics';
        if (group !== previousGroup) {
          if (gapRoom && previousGroup) body.push('');
          if (group) body.push(this.theme.fg('dim', group));
          previousGroup = group;
        }
      }
      if (gapRoom && (logs || cachePage === 'cache') && value === 'back') body.push('');
      this.mouseRows.set(body.length, { row: index, value: index < maxVisible ? value : undefined });
      body.push(row);
      if (backGap && index < maxVisible && this.items[firstVisible + index]?.intent.kind === 'back') body.push('');
    });
    if (helpHeight) {
      const help = this.items.find(item => item.value === this.list!.getSelectedItem()?.value)?.help ?? '';
      const cleared = cachePage ? this.cacheVisit?.clearedLayouts : undefined;
      const line = this.outcome ? safe(this.outcome.text) : cleared === undefined ? help : cacheClearResult(cleared);
      body.push('', this.theme.fg(this.outcome?.color ?? (cleared === undefined ? 'muted' : 'success'), truncateToWidth(line, innerWidth, '…')));
    }
    if (sections) {
      const paged = summaries.length > summaryRoom;
      let navigation = (paged ? 'PgUp/PgDn details · ' : '') + menuNavigation(this.page);
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
      const offset = Math.max(0, Math.min(this.detailLines.length - Math.max(1, this.detailHeight),
        this.detailOffset + (matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, this.detailHeight)));
      if (offset !== this.detailOffset) { this.detailOffset = offset; this.moved(); this.requestRender(); }
      return;
    }
    if (!this.list) return;
    if (this.page === 'themes' && !this.themeLoading && !this.themeLoadFailed && !kb.matches(data, 'tui.select.up') &&
      !kb.matches(data, 'tui.select.down') && !kb.matches(data, 'tui.select.confirm')) {
      const before = this.search.getValue(); this.search.handleInput(data);
      if (this.search.getValue() !== before) {
        const first = this.pageItems(this.owner.snapshot())[0];
        this.selected.themes = first?.value; this.listKey = ''; this.moved();
        if (first) this.previewTheme(first.intent);
      }
    } else {
      const down = kb.matches(data, 'tui.select.down'), up = kb.matches(data, 'tui.select.up');
      const selected = this.list.getSelectedItem()?.value;
      if (up && selected === this.items[0]?.value || down && selected === this.items.at(-1)?.value) return;
      this.list.handleInput(data);
      // Selection callbacks may synchronously close and dispose this popup.
      if (this.closed) return;
      this.skipDisabledRootSelection(down ? 1 : up ? -1 : 0);
      const value = this.list.getSelectedItem()?.value; if (value) this.previewTheme(this.rowIntent(value));
    }
    if (!this.closed) this.requestRender();
  }
  private skipDisabledRootSelection(direction: number): void {
    if (this.page !== 'root' || this.owner.snapshot().selected.kind !== 'pi' || !this.list ||
      this.list.getSelectedItem()?.value !== 'theme-variant') return;
    const index = this.items.findIndex(item => item.value === 'theme-variant');
    const next = Math.max(0, Math.min(this.items.length - 1, index + (direction < 0 ? -1 : 1)));
    this.list.setSelectedIndex(next);
    const value = this.list.getSelectedItem()?.value;
    if (value) this.select(value);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || !this.list) return undefined;
    const origin = this.mousePressOrigin;
    const acceptedClick = event.type === 'click' && origin === 'accepted';
    if (event.type === 'press' || event.type === 'click') this.mousePressOrigin = undefined;
    if (event.type === 'click' && origin === 'disabled') return { handled: true };
    if (event.x < this.frameInset || event.x >= this.frameInset + this.bodyWidth) return undefined;
    const y = event.y - this.frameInset;
    const target = this.mouseRows.get(y);
    // Recentering can replace the pressed row with decoration. The same native list still owns the press.
    const row = acceptedClick && this.page === 'themes' && !target?.value ? 0 : target?.row;
    if (row === undefined && event.type !== 'wheel') return undefined;
    // A native press retains its original item when selection recenters the list.
    if (!acceptedClick && this.page === 'root' && target?.value === 'theme-variant' && this.owner.snapshot().selected.kind === 'pi' &&
      (event.type === 'press' || event.type === 'click')) {
      if (event.type === 'press') this.mousePressOrigin = 'disabled';
      return { handled: true };
    }
    const page = this.page, list = this.list;
    const result = list.handleMouse({ ...event, x: event.x - this.frameInset,
      y: row ?? 0, width: this.bodyWidth + 2, height: this.listHeight });
    if (this.closed) return result;
    if (event.type === 'press') this.mousePressOrigin = result?.handled ? 'accepted' : undefined;
    if (result) {
      if (this.page === page) {
        const value = list.getSelectedItem()?.value; this.selected[page] = value;
        this.skipDisabledRootSelection(event.type === 'wheel' ? Math.sign(event.wheelDelta ?? 0) : 0);
        // Press/click is one confirmation gesture; preview must not replace the
        // native list (and its pressed-row identity) between those two events.
        if (event.type === 'wheel' && value) this.previewTheme(this.rowIntent(list.getSelectedItem()?.value ?? value));
      }
      this.requestRender();
    }
    return result;
  }
}
