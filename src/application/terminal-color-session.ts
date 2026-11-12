import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import { terminalAppearanceTracking } from '../host/pi/native-bindings.ts';
import { notify } from '../notifications.ts';
import { TerminalColors, processTerminalDefaults, type ColorTheme, type DefaultColors } from '../terminal-colors.ts';
import { bindTerminalLifecycle, type TerminalLifecycle } from '../terminal-lifecycle.ts';

interface TerminalColorFacts {
  context(): ExtensionContext | undefined;
  appearanceEnabled(): boolean;
  terminalColorsEnabled(): boolean;
  diagnosticSink(): DiagnosticSink | undefined;
  journalSink(): DiagnosticSink | undefined;
  themeSetting(): string | undefined;
  terminalLifecycle(ctx: ExtensionContext): TerminalLifecycle;
  defaults?(): DefaultColors | undefined;
}
const widget = 'pi-tidy-ui-terminal-colors';
let observation: WeakRef<TerminalColors> | undefined;
/** Primitive last-instance counters; the observation does not retain its owner. */
export function terminalColorDiagnostics() {
  const view = observation?.deref();
  return view ? { status: view.status(), counters: view.stats() } : undefined;
}

/** Owns one public observer widget and its terminal attachment, not applied channels. */
export class TerminalColorSession {
  private readonly facts: TerminalColorFacts;
  private current: TerminalColors | undefined;
  private detach: (() => void) | undefined;

  constructor(facts: TerminalColorFacts) { this.facts = facts; }
  status() { return this.current?.status(); }
  stats() { return this.current?.stats(); }
  palette(theme: ColorTheme) { return this.current?.palette(theme) ?? theme; }
  stop(preserveDefaults = false): void {
    const previous = this.current; this.current = undefined;
    this.detach?.(); this.detach = undefined;
    if (previous) diagnose(this.facts.journalSink(), 'INFO', 'terminal-colors', 'Terminal-color observer removed from public widget', { preserveDefaults });
    previous?.dispose({ preserveDefaults });
    if (previous) this.facts.context()?.ui.setWidget(widget, undefined);
  }
  start(ctx: ExtensionContext): void {
    if (!this.facts.appearanceEnabled() || ctx.mode !== 'tui') return;
    if (this.current) { this.current.observe(); return; }
    ctx.ui.setWidget(widget, tui => {
      const reference = new WeakRef(tui);
      const view = new TerminalColors({
        defaults: this.facts.defaults?.() ?? processTerminalDefaults(),
        diagnostic: this.facts.diagnosticSink(),
        snapshot: () => {
          const current = this.facts.context()!;
          return { enabled: this.facts.appearanceEnabled() && this.facts.terminalColorsEnabled() && current?.mode === 'tui',
            presenting: this.facts.appearanceEnabled() && current?.mode === 'tui', theme: current.ui.theme,
            configured: this.facts.themeSetting(), automatic: this.detach && reference.deref() ? terminalAppearanceTracking(reference.deref()!) : undefined };
        },
        source: name => name ? this.facts.context()?.ui.getAllThemes?.().find(item => item.name === name)?.path : undefined,
        write: data => {
          const terminal = reference.deref()?.terminal;
          if (!terminal || typeof terminal.write !== 'function') throw new Error('Terminal writer unavailable');
          terminal.write(data);
        },
        query: late => reference.deref()?.queryTerminalColors({ timeoutMs: 100, onLateReply: late }) ?? Promise.resolve({}),
        changed: force => {
          // A forced request resets TUI diff state, so wait until observer rendering returns.
          if (force) queueMicrotask(() => { if (this.current === view) reference.deref()?.requestRender(true); });
          else reference.deref()?.requestRender();
        },
        warn: message => notify(this.facts.context()?.ui, `Terminal colors: ${message}`, 'warning'),
      });
      this.detach = bindTerminalLifecycle(tui.terminal, this.facts.terminalLifecycle(ctx), view);
      this.current = view; observation = new WeakRef(view);
      view.observe();
      return { render: () => { if (this.current === view) view.observe(); return []; }, invalidate: () => { if (this.current === view) view.observe(); } };
    }, { placement: 'belowEditor' });
  }
  applyPreference(value: boolean, ctx: ExtensionContext): void {
    if (!value) this.current?.observe();
    else if (this.current) this.current.observe(true);
    else this.start(ctx);
  }
  reapply(ctx: ExtensionContext): void {
    if (this.current) this.current.reapply(); else this.start(ctx);
  }
}
