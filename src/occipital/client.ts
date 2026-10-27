import { diagnose, diagnosticError, reportRuntime, type DiagnosticFields, type DiagnosticSink, type RuntimeEvent } from '../diagnostics.ts';
import { ExtensionSettings, type SyntaxTheme } from '../settings.ts';
import { SourceController, type ControllerOptions } from './controller.ts';
import type { SyntaxMenuOutcome, SyntaxMenuOwner, SyntaxMenuSnapshot } from './menu.ts';
import { resolveTheme } from './profiles.ts';
import type { ProfileDescription } from './protocol.ts';
import { ProviderBroker, type ProviderOptions, type ProviderSnapshot } from './provider.ts';

export interface SyntaxClientOptions {
  diagnostic?: DiagnosticSink;
  provider: Omit<ProviderOptions, 'onChange' | 'onOwnedStopped'>;
  /** Trusted delivery metadata, not a version discovery request. */
  standaloneVersion: string;
  settings?: Pick<ExtensionSettings, 'load' | 'update'>;
  /** A validated preference already loaded by the extension before activation. */
  initialTheme?: SyntaxTheme;
  source?: Omit<ControllerOptions, 'onChange'>;
  notify?: (message: string, type: 'error') => void;
  onChange?: () => void;
  /** Coalesced source keys and primitive group IDs for targeted presentation invalidation.
    * Generic onChange still delivers metadata/availability; source dispatch stays explicit. */
  onSourceChange?: (keys: readonly string[], changedGroups?: readonly number[]) => void;
}

type ProfileNeed = Readonly<{ generation: number; sequence: number }>;
const SAVE_FAILED = 'Syntax theme selection could not be saved.';
const REFRESH_FAILED = 'Syntax themes could not be reloaded.';
const LOAD_FAILED = 'Settings could not be read.';
// Abort reasons can retain their creation stack; keep this outside receiver scopes.
const saveCancelled = new Error('Syntax preference retired');
function copyTheme(choice: SyntaxTheme): SyntaxTheme {
  return choice.kind === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: choice.id };
}
// Each factory has its own receiver-free lexical scope, even when observers are
// retained through a still-live broker/controller after the client is collected.
function brokerDiagnostic(owner: WeakRef<SyntaxClient>, diagnostic?: DiagnosticSink): DiagnosticSink {
  if (diagnostic?.runtime) return diagnostic;
  const sink: DiagnosticSink = (level, area, explanation, fields) => diagnose(diagnostic, level, area, explanation, fields);
  sink.runtime = event => owner.deref()?.acceptStartupEvent(event);
  return sink;
}
function brokerObserver(owner: WeakRef<SyntaxClient>) { return () => owner.deref()?.acceptBrokerChange(); }
function ownedStopObserver(owner: WeakRef<SyntaxClient>) { return (generation: number) => owner.deref()?.sources.ownedStopped(generation); }
function sourceObserver(owner: WeakRef<SyntaxClient>) { return (keys: readonly string[], groups?: readonly number[]) => owner.deref()?.acceptSourceChange(keys, groups); }
type CompletionPart = 'sources' | 'provider' | 'restore' | 'startup' | 'catalogue';
type ClientCompletion = { promise: Promise<boolean>; resolve(value: boolean): void };
type CompletionState = { current?: ClientCompletion;
  parts: Partial<Record<CompletionPart, { promise: Promise<unknown>; done: boolean }>> };
function clientCompletion(): ClientCompletion {
  let resolve!: ClientCompletion['resolve'];
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
const clientCancelled = Promise.resolve(false);
function completionNotice(owner: WeakRef<SyntaxClient>, state: CompletionState, part: CompletionPart, promise: Promise<unknown>) {
  return (result: unknown) => {
    const client = owner.deref();
    if (client) client.completionSettled(part, promise, result !== false);
    else { const current = state.current; state.current = undefined; state.parts = {}; current?.resolve(false); }
  };
}
function changeNotice(owner: WeakRef<SyntaxClient>) { return () => owner.deref()?.deliverChange(); }
function menuCapture(owner: WeakRef<SyntaxClient>, epoch: number) { return () => owner.deref()?.menuCurrent(epoch) ?? false; }

/** UI-independent composition only. Sources, transport recovery and disk publication
 * retain their existing owners; preference reconciliation never observes source text. */
export class SyntaxClient implements SyntaxMenuOwner {
  readonly broker: ProviderBroker;
  readonly sources: SourceController;
  private readonly settings: Pick<ExtensionSettings, 'load' | 'update'>;
  private readonly standaloneVersion: string;
  private readonly diagnostic?: DiagnosticSink;
  private readonly notify?: SyntaxClientOptions['notify'];
  private readonly onChange?: SyntaxClientOptions['onChange'];
  private readonly onSourceChange?: SyntaxClientOptions['onSourceChange'];
  private provider: ProviderSnapshot;
  private enabled = true;
  private suspended = false;
  private disposed = false;
  private menuEpoch = 0;
  private preferenceRevision = 0;
  private preferenceKnown = false;
  private selected: SyntaxTheme = { kind: 'pi' };
  private effective?: ProfileDescription;
  private missingEpisode = false;
  private lastIssue?: string;
  private restore?: Promise<void>;
  private startup?: Promise<void>;
  private shutdown?: Promise<void>;
  private save?: AbortController;
  private metadata?: { epoch: number; generation: number; operation?: Promise<SyntaxMenuOutcome> };
  private attemptedNeed?: ProfileNeed;
  private noticeScheduled = false;
  private delivering = false;
  private readonly completion: CompletionState = { parts: {} };
  private startupIssue = false;

  constructor(options: SyntaxClientOptions) {
    this.settings = options.settings ?? new ExtensionSettings();
    if (options.initialTheme) {
      this.selected = copyTheme(options.initialTheme); this.preferenceKnown = true; this.restore = Promise.resolve();
    }
    this.standaloneVersion = options.standaloneVersion; this.diagnostic = options.diagnostic;
    this.notify = options.notify; this.onChange = options.onChange; this.onSourceChange = options.onSourceChange;
    this.broker = new ProviderBroker({ ...options.provider, diagnostic: brokerDiagnostic(new WeakRef(this), options.diagnostic ?? options.provider.diagnostic), onChange: brokerObserver(new WeakRef(this)),
      onOwnedStopped: ownedStopObserver(new WeakRef(this)) });
    this.provider = this.broker.snapshot();
    this.sources = new SourceController(this.broker, { ...options.source, diagnostic: options.diagnostic ?? options.source?.diagnostic, onChange: sourceObserver(new WeakRef(this)) });
    this.sources.setEnabled(false);
  }

  start(): Promise<void> {
    if (this.disposed) return this.shutdown ?? Promise.resolve();
    if (!this.startup) this.startup = Promise.all([this.restorePreference(), this.broker.start()]).then(() => {});
    return this.startup;
  }

  /** Observe existing producers through delivered presentation continuations, not successful highlighting. */
  whenSettled(): Promise<boolean> {
    if (this.disposed || this.suspended) return clientCancelled;
    if (this.completion.current) return this.completion.current.promise;
    const completion = clientCompletion(); this.completion.current = completion;
    this.checkCompletion(); return completion.promise;
  }
  private watchCompletion(part: CompletionPart, promise: Promise<unknown> | undefined): void {
    const state = this.completion;
    if (!promise) { delete state.parts[part]; return; }
    if (state.parts[part]?.promise === promise) return;
    state.parts[part] = { promise, done: false };
    const done = completionNotice(new WeakRef(this), state, part, promise);
    void promise.then(done, done);
  }
  /** Producer slots outlive cancelled observations so an unchanged pending Promise gets only one observer. */
  completionSettled(part: CompletionPart, promise: Promise<unknown>, settled: boolean): void {
    const current = this.completion.parts[part]; if (current?.promise !== promise) return;
    current.done = true;
    if (!settled) { this.cancelCompletion(); return; }
    this.checkCompletion();
  }
  private checkCompletion(): void {
    const state = this.completion, completion = state.current; if (!completion) return;
    this.watchCompletion('sources', this.sources.whenSettled());
    this.watchCompletion('provider', this.broker.whenSettled());
    this.watchCompletion('restore', this.restore);
    this.watchCompletion('startup', this.startup);
    this.watchCompletion('catalogue', this.metadata?.operation);
    if (this.noticeScheduled || this.delivering || Object.values(state.parts).some(part => !part.done)) return;
    state.current = undefined; completion.resolve(true);
  }
  private cancelCompletion(): void {
    const completion = this.completion.current; this.completion.current = undefined; completion?.resolve(false);
  }

  snapshot(): SyntaxMenuSnapshot {
    return { enabled: this.enabled, provider: { ...this.provider }, standaloneVersion: this.standaloneVersion,
      selected: copyTheme(this.selected), effective: this.effective ? { ...this.effective } : undefined, lastIssue: this.lastIssue };
  }

  async selectTheme(choice: SyntaxTheme): Promise<SyntaxMenuOutcome> {
    if (this.disposed) return { ok: false, message: SAVE_FAILED };
    const selected = copyTheme(choice);
    this.applyTheme(selected);
    this.log('Syntax theme selected; applying before persistence', { choice: selected.kind, theme: selected.kind === 'occipital' ? selected.id : 'Pi', revision: this.preferenceRevision });
    this.cancelSave(); const save = new AbortController(); this.save = save;
    try {
      const result = await this.settings.update({ syntaxTheme: copyTheme(selected) }, { signal: save.signal });
      if (this.disposed || save.signal.aborted || this.save !== save) { this.log('Theme save result ignored; request cancelled or retired'); return { ok: false, message: SAVE_FAILED }; }
      if (!result.ok) {
        diagnose(this.diagnostic, 'ERROR', 'settings', 'Theme persistence failed; selection remains session-local');
        reportRuntime(this.diagnostic, { kind: 'failure', scope: this.settings, operation: 'save', area: 'settings', code: 'settings_save' });
        this.issue(result.issue.message); return { ok: false, message: result.issue.message };
      }
      reportRuntime(this.diagnostic, { kind: 'recovered', scope: this.settings, operation: 'save' });
      this.log('Syntax theme persisted'); return { ok: true };
    } catch (error) {
      this.log('Theme persistence did not complete', { code: diagnosticError(error), cancelled: save.signal.aborted });
      if (!this.disposed && !save.signal.aborted && this.save === save) {
        diagnose(this.diagnostic, 'ERROR', 'settings', 'Theme persistence failed unexpectedly', { code: diagnosticError(error) });
        reportRuntime(this.diagnostic, { kind: 'failure', scope: this.settings, operation: 'save', area: 'settings', code: 'settings_save' });
        this.issue(SAVE_FAILED);
      }
      return { ok: false, message: SAVE_FAILED };
    } finally { if (this.save === save) this.save = undefined; }
  }

  /** Session-local application only; an earlier confirmed save remains independent. */
  previewTheme(choice: SyntaxTheme): void {
    if (this.disposed || this.preferenceKnown && choice.kind === this.selected.kind &&
      (choice.kind === 'pi' || this.selected.kind === 'occipital' && choice.id === this.selected.id)) return;
    this.applyTheme(copyTheme(choice));
    this.log('Syntax theme preview applied without persistence', { choice: choice.kind, theme: choice.kind === 'occipital' ? choice.id : 'Pi', revision: this.preferenceRevision });
  }
  /** Apply a confirmed shared preference without writing it back. */
  applySavedTheme(choice: SyntaxTheme): void {
    if (this.disposed) return;
    this.applyTheme(copyTheme(choice));
    this.log('Confirmed syntax preference applied from settings without persistence', { choice: choice.kind, theme: choice.kind === 'occipital' ? choice.id : 'Pi' });
  }
  private applyTheme(selected: SyntaxTheme): void {
    if (selected.kind !== this.selected.kind || selected.kind === 'occipital' && this.selected.kind === 'occipital' && selected.id !== this.selected.id)
      this.missingEpisode = false;
    ++this.preferenceRevision; this.preferenceKnown = true; this.selected = selected;
    this.reconcile();
  }

  refreshThemes(): Promise<SyntaxMenuOutcome> {
    if (this.disposed) return Promise.resolve({ ok: false, message: REFRESH_FAILED });
    if (!this.enabled || this.suspended || this.provider.availability !== 'ready' || this.metadata) {
      this.issue(REFRESH_FAILED); return Promise.resolve({ ok: false, message: REFRESH_FAILED });
    }
    const need = this.sources.profileReconciliationNeeded();
    if (need) this.attemptedNeed = need;
    return this.readCatalogue('themes.refresh', need);
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return this.shutdown ?? Promise.resolve();
    if (this.enabled === enabled) return Promise.resolve();
    this.cancelCompletion(); this.enabled = enabled; ++this.menuEpoch; this.cancelSave();
    this.log('Native highlighting session activation changed', { enabled });
    this.sources.setEnabled(enabled && this.preferenceKnown);
    const operation = this.broker.setEnabled(enabled);
    this.acceptBrokerChange();
    return enabled ? Promise.all([this.restorePreference(), operation]).then(() => {}) : operation;
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.cancelCompletion(); this.suspended = true; ++this.menuEpoch;
    this.sources.suspend();
    const interrupted = this.broker.suspend();
    if (interrupted !== undefined) this.sources.interruptProvider(interrupted);
    this.acceptBrokerChange();
  }
  resume(): Promise<void> {
    if (this.disposed || !this.suspended) return Promise.resolve();
    this.suspended = false;
    const operation = this.broker.resume();
    this.sources.resume(); this.acceptBrokerChange();
    return operation;
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.cancelCompletion(); this.completion.parts = {}; this.disposed = true; ++this.menuEpoch; this.cancelSave(); this.sources.dispose();
    this.shutdown = this.broker.dispose(); this.provider = this.broker.snapshot(); this.effective = undefined;
    return this.shutdown;
  }

  captureMenu(): () => boolean { return menuCapture(new WeakRef(this), this.menuEpoch); }
  /** Internal weak callback delivery, not a source/metadata demand. */
  menuCurrent(epoch: number): boolean { return !this.disposed && epoch === this.menuEpoch; }
  /** Broker-only fallback for embeddings without the runtime-health observer. */
  acceptStartupEvent(event: RuntimeEvent): void {
    if (this.disposed || event.operation !== 'startup') return;
    if (event.kind !== 'failure') { this.startupIssue = false; return; }
    if (this.startupIssue) return;
    this.startupIssue = true;
    try { this.notify?.('Syntax highlighting could not be started.', 'error'); } catch { /* UI is optional. */ }
  }
  /** Internal weak broker observer; reconcile only real cached publication events. */
  acceptBrokerChange(): void {
    if (this.disposed) return;
    const next = this.broker.snapshot(), previous = this.provider;
    if (next.availability === previous.availability && next.reason === previous.reason && next.generation === previous.generation
      && next.initialShared === previous.initialShared && next.kind === previous.kind && next.description === previous.description) return;
    this.provider = next; this.reconcile();
    this.tryProfileMetadata();
  }
  /** Internal weak source observer, called after the controller's coalesced notice. */
  acceptSourceChange(keys: readonly string[] = [], groups?: readonly number[]): void {
    if (this.disposed) return;
    const current = keys.filter(key => this.sources.workStatus(key).version !== undefined);
    try { if (current.length || groups?.length) this.onSourceChange?.(current, groups); } catch { /* Presentation cannot suppress reconciliation. */ }
    this.changed(); this.tryProfileMetadata();
  }
  /** Internal weak coalesced presentation delivery. No source observation/flush. */
  deliverChange(): void {
    this.noticeScheduled = false;
    if (this.disposed) return;
    this.delivering = true;
    try { this.onChange?.(); } catch { /* Presentation cannot disturb ownership. */ }
    finally { this.delivering = false; this.checkCompletion(); }
  }

  restorePreference(): Promise<void> {
    if (!this.restore) this.restore = this.loadPreference(this.preferenceRevision);
    return this.restore;
  }
  private async loadPreference(revision: number): Promise<void> {
    try {
      const result = await this.settings.load();
      if (this.disposed || revision !== this.preferenceRevision || this.preferenceRevision !== 0) return;
      this.selected = copyTheme(result.syntaxTheme); this.preferenceKnown = true;
      this.log('Syntax preference restored', { ok: result.ok, choice: this.selected.kind, theme: this.selected.kind === 'occipital' ? this.selected.id : 'Pi' });
      if (!result.ok) this.issue(result.issue.message, true);
    } catch {
      if (this.disposed || revision !== this.preferenceRevision || this.preferenceRevision !== 0) return;
      this.preferenceKnown = true; this.issue(LOAD_FAILED, true);
    }
    this.reconcile();
  }
  private reconcile(): void {
    const active = this.preferenceKnown && this.enabled;
    const resolved = resolveTheme(this.selected, active && this.provider.availability === 'ready'
      ? this.provider.description?.profiles : undefined);
    const previous = this.effective; this.effective = active ? resolved.effective : undefined;
    if (previous?.id !== this.effective?.id || previous?.fingerprint !== this.effective?.fingerprint)
      this.log('Effective syntax profile changed without observing source text', { profile: this.effective?.id ?? 'unavailable', missing: resolved.missing });
    this.sources.setEnabled(this.preferenceKnown && this.enabled);
    if (resolved.missing && this.selected.kind === 'occipital') {
      if (!this.missingEpisode) {
        this.missingEpisode = true;
        this.issue(`Syntax theme ${JSON.stringify(this.selected.id)} is unavailable; using Pi palette temporarily.`, true);
      }
    } else if (resolved.effective) this.missingEpisode = false;
    // Unavailability alone cannot end an unresolved missing-theme episode.
    this.changed();
  }
  private log(explanation: string, fields?: DiagnosticFields): void { diagnose(this.diagnostic, 'INFO', 'syntax', explanation, fields); }
  private cancelSave(): void { this.save?.abort(saveCancelled); this.save = undefined; }
  private issue(message: string, notify = false): void {
    this.lastIssue = message; this.changed();
    if (notify && !this.disposed) { try { this.notify?.(message, 'error'); } catch { /* UI is optional. */ } }
  }
  private changed(): void {
    if (this.disposed || !this.onChange || this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(changeNotice(new WeakRef(this)));
  }
  private tryProfileMetadata(): void {
    if (this.disposed || this.suspended || !this.enabled || !this.preferenceKnown || this.metadata) return;
    const need = this.sources.profileReconciliationNeeded();
    if (!need || need.generation === this.attemptedNeed?.generation && need.sequence === this.attemptedNeed.sequence) return;
    this.attemptedNeed = need;
    void this.readCatalogue('describe', need);
  }
  private readCatalogue(op: 'describe' | 'themes.refresh', need?: ProfileNeed): Promise<SyntaxMenuOutcome> {
    const attempt: NonNullable<SyntaxClient['metadata']> = { epoch: this.menuEpoch, generation: this.provider.generation };
    this.metadata = attempt;
    const operation = this.readCatalogueAttempt(attempt, op, need); attempt.operation = operation;
    this.checkCompletion(); return operation;
  }
  private async readCatalogueAttempt(attempt: NonNullable<SyntaxClient['metadata']>, op: 'describe' | 'themes.refresh', need?: ProfileNeed): Promise<SyntaxMenuOutcome> {
    this.log('Provider catalogue read started; this is not source classification', { operation: op, generation: attempt.generation });
    try {
      const description = await this.broker.catalogue(attempt.generation, op);
      if (!this.menuCurrent(attempt.epoch) || !this.broker.isReady(attempt.generation)) return { ok: false, message: REFRESH_FAILED };
      this.acceptBrokerChange();
      // A newer refusal that arrived in flight remains a separate metadata need.
      if (need) this.sources.acknowledgeProfiles(need.generation, need.sequence);
      if (op === 'themes.refresh' && description.diagnostic !== null) {
        this.issue(REFRESH_FAILED); return { ok: false, message: REFRESH_FAILED };
      }
      this.log('Provider catalogue read completed', { operation: op, generation: attempt.generation, profiles: description.profiles.length });
      return { ok: true };
    } catch (error) {
      this.log('Provider catalogue read failed or wait expired; source deadline policy is unchanged', { operation: op, code: diagnosticError(error) });
      if (this.menuCurrent(attempt.epoch) && this.broker.isReady(attempt.generation)) this.issue(REFRESH_FAILED, op === 'describe');
      return { ok: false, message: REFRESH_FAILED };
    } finally {
      if (this.metadata === attempt) this.metadata = undefined;
      this.tryProfileMetadata();
    }
  }
}
