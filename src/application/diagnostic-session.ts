import { VERSION, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
import type { JournalOptions } from '../debug-log.ts';
import type { DiagnosticSink } from '../diagnostics.ts';
import { notify } from '../notifications.ts';
import { RuntimeHealth } from '../runtime-health.ts';
import { SessionLogging } from '../session-logging.ts';

const extensionVersion = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
let loggingDebug: WeakRef<SessionLogging> | undefined;
/** Existing in-memory journal status only, for actual CLI overhead controls. */
export function debugLoggingDiagnostics() { return loggingDebug?.deref()?.status(); }

interface ContextCell { current?: ExtensionContext }
interface DiagnosticContext extends ContextCell { session: string; logging?: SessionLogging }
function diagnosticCapture(owner: WeakRef<DiagnosticContext>): DiagnosticSink {
  return (level, area, message, fields) => owner.deref()?.logging?.sink(level, area, message, fields);
}
function runtimeNotice(owner: WeakRef<DiagnosticContext>) {
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) notify(ctx.ui, message, 'error'); };
}
function loggingNotice(owner: WeakRef<ContextCell>) {
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) notify(ctx.ui, message, 'warning'); };
}

/** Factory-lived selection of session health and optional run-bound journals. */
export class SessionDiagnostics {
  private readonly options: false | Omit<JournalOptions, 'warn' | 'enabled'> | undefined;
  private health?: RuntimeHealth;
  private diagnostic?: DiagnosticSink;
  private diagnosticContext?: DiagnosticContext;
  private logging?: SessionLogging;
  private loggingContext?: ContextCell;

  constructor(options?: false | Omit<JournalOptions, 'warn' | 'enabled'>) { this.options = options; }
  get sink(): DiagnosticSink | undefined { return this.diagnostic; }
  get journal(): SessionLogging | undefined { return this.logging; }
  healthSnapshot() { return this.health?.snapshot(); }

  begin(ctx: ExtensionContext, reason: string, captureEnabled: boolean, onSelectedSink?: (sink: DiagnosticSink) => void): void {
    const identity = ctx.sessionManager.getSessionId();
    if (this.diagnosticContext?.session !== identity) {
      this.health?.dispose();
      if (this.diagnosticContext) { this.diagnosticContext.current = undefined; this.diagnosticContext.logging = undefined; }
      this.diagnosticContext = { current: ctx, session: identity };
      const owner = new WeakRef(this.diagnosticContext);
      this.health = new RuntimeHealth(runtimeNotice(owner)); this.diagnostic = this.health.sink(diagnosticCapture(owner));
    } else this.diagnosticContext.current = ctx;
    // Journal construction can invoke supplied clock/I/O callbacks before returning.
    onSelectedSink?.(this.diagnostic!);
    if (this.options === false) return;
    const session = ctx.sessionManager.getSessionId();
    if (this.logging?.status().session === session) { if (this.loggingContext) this.loggingContext.current = ctx; return; }
    const previous = this.logging; if (this.loggingContext) this.loggingContext.current = undefined;
    void previous?.close('session switch');
    this.loggingContext = { current: ctx };
    this.logging = new SessionLogging({ session, sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd,
      extension: extensionVersion, pi: VERSION, reason, mode: ctx.mode, provider: ctx.model?.provider, theme: ctx.ui.theme.name },
    { ...this.options, enabled: captureEnabled, warn: loggingNotice(new WeakRef(this.loggingContext)) });
    this.diagnosticContext!.logging = this.logging;
    loggingDebug = new WeakRef(this.logging);
  }

  refreshJournalContext(ctx: ExtensionContext): void { if (this.loggingContext) this.loggingContext.current = ctx; }
  retireHealth(): void { this.health?.dispose(); }
  closeJournal(reason: string): Promise<void> | undefined { return this.logging?.close(reason); }
  releaseJournal(): void {
    // Outgoing cleanup still reaches its journal until final observation release.
    this.logging = undefined;
    if (this.loggingContext) this.loggingContext.current = undefined;
    this.loggingContext = undefined;
  }
  release(): void {
    if (this.diagnosticContext) { this.diagnosticContext.current = undefined; this.diagnosticContext.logging = undefined; }
    this.diagnosticContext = undefined; this.diagnostic = undefined; this.health = undefined;
  }
}
