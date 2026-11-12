import { diagnose, diagnosticError, reportRuntime, type DiagnosticSink } from '../diagnostics.ts';
import { copyThemePreference, sameThemePreference, type ThemePreference } from '../appearance/theme-preference.ts';
import { themePatch, type ExtensionSettings, type LocalPreferences, type SettingsLoadResult, type Switches } from '../settings.ts';
import { RETIRED_SETTINGS_ACTION as retired, type SyntaxMenuOutcome } from './syntax-menu.ts';

export type PreferenceStore = Pick<ExtensionSettings, 'load' | 'update'> & Partial<Pick<ExtensionSettings, 'watch'>>;
export interface PreferenceScope { readonly signal: AbortSignal; current(): boolean }
export interface SwitchApplication {
  appearance(value: boolean): void | Promise<void>;
  terminalColors(value: boolean): void;
  nativeHighlighting(value: boolean): Promise<void> | undefined;
  logging(value: boolean): Promise<void> | undefined;
  recordingFailed(): boolean;
}
export interface SharedPreferenceApplication {
  terminalColors(value: boolean): void;
  theme(choice: ThemePreference, changed: boolean): void;
  nativeHighlighting(value: boolean): Promise<void> | undefined;
  nativeFailed(): void;
}
interface ThemeApplication {
  applyConfirmedTheme(choice: ThemePreference): void;
  reportPreferenceIssue(message: string): void;
}
const SAVE_FAILED = 'Syntax theme selection could not be saved.';
// Abort reasons must not retain a caller's receiver or native graph.
const saveCancelled = new Error('Syntax preference retired');
function activationNotice(owner: WeakRef<ThemeConfirmationScope>) { return () => owner.deref()?.activationChanged(); }
function disposalNotice(owner: WeakRef<ThemeConfirmationScope>) { return () => owner.deref()?.dispose(); }

/** A native incarnation, deliberately independent of popup and application epochs. */
class ThemeConfirmationScope {
  private target?: WeakRef<ThemeApplication>;
  private disposed = false;
  readonly onActivationChanged = activationNotice(new WeakRef(this));
  readonly onDisposed = disposalNotice(new WeakRef(this));
  private readonly owner: WeakRef<ApplicationPreferences>;
  readonly diagnostic?: DiagnosticSink;
  constructor(owner: WeakRef<ApplicationPreferences>, diagnostic?: DiagnosticSink) { this.owner = owner; this.diagnostic = diagnostic; }
  bind(target: ThemeApplication): void { this.target = new WeakRef(target); }
  current(): boolean { return !this.disposed && this.target?.deref() !== undefined; }
  apply(choice: ThemePreference): void { this.target?.deref()?.applyConfirmedTheme(choice); }
  issue(message: string): void { this.target?.deref()?.reportPreferenceIssue(message); }
  activationChanged(): void { this.owner.deref()?.cancelTheme(this); }
  dispose(): void { this.disposed = true; this.owner.deref()?.retireTheme(this); }
}

/** Factory-lived confirmed intent and persistence policy; native state and preview stay separate. */
export class ApplicationPreferences {
  private selected: ThemePreference = { kind: 'pi', variant: 'dark' };
  private colors = false;
  private native = true;
  private loaded = false;
  private readyPromise?: Promise<void>;
  private themePromise?: Promise<ThemePreference>;
  private themeRevision = 0;
  private initialIssue?: string;
  private lastReadIssue?: string;
  private unwatch?: () => void;
  private themeScope?: ThemeConfirmationScope;
  private save?: { scope: ThemeConfirmationScope; abort: AbortController };

  private readonly store: PreferenceStore;
  private readonly local: LocalPreferences;
  constructor(store: PreferenceStore, local: LocalPreferences) { this.store = store; this.local = local; }
  get initialized(): boolean { return this.loaded; }
  get appearanceEnabled(): boolean { return this.local.appearanceEnabled; }
  get loggingEnabled(): boolean { return this.local.loggingEnabled; }
  get terminalColorsEnabled(): boolean { return this.colors; }
  get nativeHighlightingEnabled(): boolean { return this.native; }
  get selectedTheme(): ThemePreference { return copyThemePreference(this.selected); }
  acceptNativePreference(value: boolean): void { this.native = value; }

  ready(): Promise<void> { return this.readyPromise ??= this.load(); }
  /** Application wiring starts the read; data clients only receive its decided value or producer. */
  themeInput(): ThemePreference | Promise<ThemePreference> {
    return this.loaded ? this.selectedTheme : this.themePromise ??= this.ready().then(() => this.selectedTheme);
  }
  private async load(): Promise<void> {
    const revision = this.themeRevision;
    try {
      const loaded = await this.store.load();
      this.colors = loaded.terminalColorsEnabled ?? false;
      this.native = loaded.nativeHighlightingEnabled ?? true;
      if (revision === this.themeRevision) this.selected = copyThemePreference(loaded.themePreference);
      if (!loaded.ok) this.initialIssue = this.lastReadIssue = loaded.issue.message;
    } catch { this.initialIssue = 'Settings could not be read; using defaults.'; }
    finally { this.loaded = true; }
  }
  reportInitialIssue(diagnostic?: DiagnosticSink): void {
    if (!this.initialIssue) return;
    this.readFailure(diagnostic);
    diagnose(diagnostic, 'ERROR', 'settings', 'Preferences could not be loaded; defaults used');
    this.initialIssue = undefined;
  }
  watch(scope: PreferenceScope, application: SharedPreferenceApplication, diagnostic?: DiagnosticSink, journal?: DiagnosticSink): void {
    this.stopWatching();
    this.unwatch = this.store.watch?.(loaded => {
      if (scope.current()) this.published(loaded, scope, application, diagnostic, journal);
    });
  }
  stopWatching(): void { this.unwatch?.(); this.unwatch = undefined; }
  private published(loaded: SettingsLoadResult, scope: PreferenceScope, application: SharedPreferenceApplication,
    diagnostic?: DiagnosticSink, journal?: DiagnosticSink): void {
    if (!loaded.ok) {
      this.readFailure(diagnostic);
      if (this.lastReadIssue !== loaded.issue.message) diagnose(diagnostic, 'ERROR', 'settings', 'Shared preferences could not be read; current preferences retained');
      this.lastReadIssue = loaded.issue.message; return;
    }
    this.lastReadIssue = undefined;
    reportRuntime(diagnostic, { kind: 'recovered', scope: this.store, operation: 'read' });
    const choice = loaded.themePreference;
    const themeChanged = !sameThemePreference(choice, this.selected);
    const colorsChanged = this.colors !== (loaded.terminalColorsEnabled ?? false);
    const nativeChanged = this.native !== (loaded.nativeHighlightingEnabled ?? true);
    if (!themeChanged && !colorsChanged && !nativeChanged) return;
    this.selected = copyThemePreference(choice); ++this.themeRevision;
    this.native = loaded.nativeHighlightingEnabled ?? true;
    if (colorsChanged) { this.colors = loaded.terminalColorsEnabled ?? false; application.terminalColors(this.colors); }
    application.theme(this.selectedTheme, themeChanged);
    if (nativeChanged) void application.nativeHighlighting(this.native)?.catch(() => { if (scope.current()) application.nativeFailed(); });
    diagnose(journal, 'INFO', 'runtime', 'Shared preferences refreshed without writing configuration', { themeChanged, colorsChanged, nativeChanged });
  }
  openThemeScope(diagnostic?: DiagnosticSink): ThemeConfirmationScope {
    this.themeScope?.dispose();
    return this.themeScope = new ThemeConfirmationScope(new WeakRef(this), diagnostic);
  }
  cancelTheme(scope: ThemeConfirmationScope): void {
    if (this.save?.scope !== scope) return;
    this.save.abort.abort(saveCancelled); this.save = undefined;
  }
  retireTheme(scope: ThemeConfirmationScope): void {
    this.cancelTheme(scope);
    if (this.themeScope === scope) this.themeScope = undefined;
  }
  async confirmTheme(scope: ThemeConfirmationScope, choice: ThemePreference): Promise<SyntaxMenuOutcome> {
    if (this.themeScope !== scope || !scope.current()) return { ok: false, message: SAVE_FAILED };
    const selected = copyThemePreference(choice);
    this.selected = copyThemePreference(selected); ++this.themeRevision;
    scope.apply(selected);
    diagnose(scope.diagnostic, 'INFO', 'syntax', 'Syntax theme selected; applying before persistence', {
      choice: selected.kind, theme: selected.kind === 'theme' ? selected.id : 'Pi' });
    this.cancelTheme(scope);
    const save = { scope, abort: new AbortController() }; this.save = save;
    const current = () => scope.current() && !save.abort.signal.aborted && this.save === save;
    try {
      const result = await this.store.update(themePatch(selected), { signal: save.abort.signal });
      if (!current()) return { ok: false, message: SAVE_FAILED };
      if (!result.ok) {
        diagnose(scope.diagnostic, 'ERROR', 'settings', 'Theme persistence failed; selection remains session-local');
        this.saveFailure(scope.diagnostic); scope.issue(result.issue.message);
        return { ok: false, message: result.issue.message };
      }
      this.saveRecovered(scope.diagnostic);
      diagnose(scope.diagnostic, 'INFO', 'syntax', 'Syntax theme persisted'); return { ok: true };
    } catch (error) {
      diagnose(scope.diagnostic, 'INFO', 'syntax', 'Theme persistence did not complete', { code: diagnosticError(error), cancelled: save.abort.signal.aborted });
      if (current()) {
        diagnose(scope.diagnostic, 'ERROR', 'settings', 'Theme persistence failed unexpectedly', { code: diagnosticError(error) });
        this.saveFailure(scope.diagnostic); scope.issue(SAVE_FAILED);
      }
      return { ok: false, message: SAVE_FAILED };
    } finally { if (this.save === save) this.save = undefined; }
  }
  async setSwitch(key: keyof Switches, value: boolean, scope: PreferenceScope, application: SwitchApplication,
    diagnostic?: DiagnosticSink): Promise<SyntaxMenuOutcome> {
    if (!scope.current()) return retired;
    const persistent = key === 'terminalColorsEnabled' || key === 'nativeHighlightingEnabled';
    // Preserve confirmation order even when applying the choice awaits native cleanup.
    const saving = persistent ? this.store.update({ [key]: value }, { signal: scope.signal }).catch(() => undefined) : undefined;
    switch (key) {
      case 'appearanceEnabled': {
        this.local.appearanceEnabled = value;
        const applying = application.appearance(value); if (applying) await applying;
        break;
      }
      case 'terminalColorsEnabled': this.colors = value; application.terminalColors(value); break;
      case 'nativeHighlightingEnabled': this.native = value; await application.nativeHighlighting(value); break;
      case 'loggingEnabled': this.local.loggingEnabled = value; await application.logging(value); break;
    }
    const outcome = await saving;
    if (!scope.current()) return retired;
    if (persistent && (!outcome || !outcome.ok)) {
      this.saveFailure(diagnostic); diagnose(diagnostic, 'ERROR', 'settings', 'Applied preference could not be saved');
      return { ok: false, message: outcome && !outcome.ok ? `Applied for now, but not saved: ${outcome.issue.message}` : 'Applied for now, but settings could not be saved.' };
    }
    if (persistent) this.saveRecovered(diagnostic);
    if (key === 'loggingEnabled' && value && application.recordingFailed())
      return { ok: false, message: 'Recording failed. See Diagnostic logs to retry.' };
    return { ok: true };
  }
  private readFailure(diagnostic?: DiagnosticSink): void {
    reportRuntime(diagnostic, { kind: 'failure', scope: this.store, operation: 'read', area: 'settings', code: 'settings_read' });
  }
  private saveFailure(diagnostic?: DiagnosticSink): void {
    reportRuntime(diagnostic, { kind: 'failure', scope: this.store, operation: 'save', area: 'settings', code: 'settings_save' });
  }
  private saveRecovered(diagnostic?: DiagnosticSink): void {
    reportRuntime(diagnostic, { kind: 'recovered', scope: this.store, operation: 'save' });
  }
}
