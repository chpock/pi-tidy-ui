import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SyntaxClient, type SyntaxClientOptions } from '../occipital/client.ts';
import { openSyntaxMenu, type SyntaxMenuOwner } from '../occipital/menu.ts';
import type { SyntaxTheme } from '../settings.ts';

interface Presentation {
  readonly active: boolean;
  syntaxMetadataChanged(): void;
  syntaxSourceChanged(keys: readonly string[]): void;
}
export interface SyntaxRuntimeOptions extends Omit<SyntaxClientOptions, 'onChange' | 'onSourceChange'> {
  enabled?: boolean;
  enabledChanged?: (enabled: boolean) => void;
}
// Retained client callbacks cannot keep their presentation/runtime installer alive.
function metadataNotice(owner: WeakRef<SyntaxRuntime>) { return () => owner.deref()?.metadataChanged(); }
function sourceNotice(owner: WeakRef<SyntaxRuntime>) { return (keys: readonly string[]) => owner.deref()?.sourceChanged(keys); }
function activation(owner: WeakRef<SyntaxRuntime>) { return () => owner.deref()?.activate(); }
function startupFailure(owner: WeakRef<SyntaxRuntime>) {
  return () => owner.deref()?.reportStartupFailure();
}
function menuCurrent(owner: WeakRef<SyntaxRuntime>, epoch: number) { return () => owner.deref()?.current(epoch) ?? false; }

/** One extension runtime's existing client and public menu. Source ownership stays
 * with CardSources; this is not a second source store or a cross-adapter registry. */
export class SyntaxRuntime implements SyntaxMenuOwner {
  private readonly client: SyntaxClient;
  private readonly options: SyntaxRuntimeOptions;
  private readonly owner = new WeakRef(this);
  private presentation?: WeakRef<Presentation>;
  private paletteColors?: WeakRef<object>;
  private paletteRevision = 0;
  private enabled: boolean;
  private started = false;
  private scheduled = false;
  private disposed = false;
  private epoch = 0;

  constructor(options: SyntaxRuntimeOptions) {
    this.options = options; this.enabled = options.enabled ?? true;
    this.client = new SyntaxClient({ ...options, onChange: metadataNotice(this.owner), onSourceChange: sourceNotice(this.owner) });
    // Construction is resource-free. Only attach or an explicit UI menu restores
    // settings; a menu without an active adapter must never activate a provider.
    void this.client.setEnabled(false).catch(startupFailure(this.owner));
  }

  get sources() { return this.client.sources; }
  snapshot() {
    const snapshot = this.client.snapshot();
    return { ...snapshot, enabled: this.enabled,
      lastIssue: snapshot.lastIssue ?? (!this.presentation?.deref()?.active && !this.disposed ? 'pi-tidy-ui presentation is off.' : undefined) };
  }
  /** The public Theme proxy is stable; its cached colors object changes on theme
   * or terminal-default changes. Never sample tokens or inspect its private target. */
  palette(theme: { readonly colors: object }): number {
    const colors = theme.colors;
    if (this.paletteColors?.deref() !== colors) { this.paletteColors = new WeakRef(colors); ++this.paletteRevision; }
    return this.paletteRevision;
  }
  attach(presentation: Presentation): void {
    if (this.disposed || !presentation.active) return;
    if (this.presentation?.deref() === presentation) return;
    this.presentation = new WeakRef(presentation); ++this.epoch;
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(activation(this.owner)); }
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.enabled !== enabled) {
      this.enabled = enabled; ++this.epoch; this.options.enabledChanged?.(enabled);
    }
    return this.client.setEnabled(enabled && this.presentation?.deref()?.active === true);
  }
  selectTheme(choice: SyntaxTheme) { return this.client.selectTheme(choice); }
  refreshThemes() { return this.client.refreshThemes(); }
  async menu(ctx: Pick<ExtensionContext, 'mode' | 'hasUI' | 'ui'>): Promise<void> {
    if (this.disposed) return;
    if (ctx.mode === 'tui' && ctx.hasUI) this.start();
    await openSyntaxMenu(ctx, this, menuCurrent(this.owner, ++this.epoch));
  }
  dispose(): Promise<void> {
    if (!this.disposed) { this.disposed = true; ++this.epoch; this.presentation = undefined; this.paletteColors = undefined; }
    return this.client.dispose();
  }

  /** Internal weak callbacks. Never observe a source or scan the transcript. */
  metadataChanged(): void {
    const presentation = !this.disposed && this.presentation?.deref();
    if (presentation && presentation.active) presentation.syntaxMetadataChanged();
  }
  sourceChanged(keys: readonly string[]): void {
    const presentation = !this.disposed && this.presentation?.deref();
    if (presentation && presentation.active) presentation.syntaxSourceChanged(keys);
  }
  current(epoch: number): boolean { return !this.disposed && this.epoch === epoch; }
  activate(): void {
    this.scheduled = false;
    if (this.disposed || !this.presentation?.deref()?.active) return;
    void this.setEnabled(this.enabled).catch(startupFailure(this.owner));
    this.start();
  }
  reportStartupFailure(): void {
    if (!this.disposed) this.options.notify?.('Syntax highlighting could not be started.', 'error');
  }
  private start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.client.start().catch(startupFailure(this.owner));
  }
}
