import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import { FOOTER_FIELDS, FooterView, footerFirstMessage, footerUsage, type FooterData } from '../footer.ts';
import type { NativeFooterSlot } from '../host/pi/native-bindings.ts';

interface FooterFacts {
  context(): ExtensionContext | undefined;
  editorEligible(): boolean;
  appearanceEnabled(): boolean;
  journalSink(): DiagnosticSink | undefined;
  autoCompaction(): boolean;
}

/** Owns the public footer slot and its semantic invalidations, not session history. */
export class FooterSession {
  private readonly facts: FooterFacts;
  private owned: FooterView | undefined;
  private render: WeakRef<{ requestRender(): void }> | undefined;
  private epoch = 0;
  private name: { session: string; value: string | undefined } | undefined;
  private restoreQueued = false;
  private startQueued = false;
  private pending: NativeFooterSlot | undefined;

  constructor(facts: FooterFacts) { this.facts = facts; }
  get active(): boolean { return !!this.owned; }
  advance(): void { this.epoch++; }
  resetName(): void { this.name = undefined; }
  nameChanged(): void {
    this.resetName();
    if (this.owned) this.render?.deref()?.requestRender();
  }
  defer(slot: NativeFooterSlot): void { this.pending = slot; }
  cancelDeferred(): void { this.pending = undefined; }
  clearLayouts(): number { return this.owned?.clear() ?? 0; }
  retainedMemory() { return this.owned?.retainedMemory(); }

  restore(): void {
    // Public dispose tells us when another owner replaced our component.
    if (this.owned) {
      diagnose(this.facts.journalSink(), 'INFO', 'footer', 'Owned footer released through public UI; native placement restored');
      this.facts.context()?.ui.setFooter(undefined);
    }
  }
  finishStart(): void {
    if (!this.pending || !this.facts.editorEligible() || this.startQueued) return;
    this.startQueued = true;
    const pending = this.pending;
    queueMicrotask(() => {
      this.startQueued = false;
      if (this.pending !== pending) return;
      this.pending = undefined;
      // A reload selector can disappear only after the native measurement pass.
      const current = pending.current();
      if (current && this.facts.context()) {
        diagnose(this.facts.journalSink(), 'INFO', 'footer', 'Deferred footer installation allowed after stock editor return');
        this.start(this.facts.context()!);
      } else diagnose(this.facts.journalSink(), 'INFO', 'footer', 'Deferred footer installation cancelled; former slot is no longer owned');
    });
  }
  private readonly visible = (): boolean => {
    if (this.facts.editorEligible()) return true;
    if (this.owned && !this.restoreQueued) {
      this.restoreQueued = true;
      diagnose(this.facts.journalSink(), 'INFO', 'footer', 'Footer release queued after stock editor ownership lost');
      // Finish native measurement before changing its footer container.
      queueMicrotask(() => {
        this.restoreQueued = false;
        if (!this.facts.editorEligible()) this.restore();
      });
    }
    return false;
  };

  start(ctx: ExtensionContext): void {
    if (ctx.mode !== 'tui' || !this.facts.appearanceEnabled() || !this.facts.editorEligible() || this.owned || typeof ctx.ui.setFooter !== 'function') return;
    this.pending = undefined;
    const diagnostic = this.facts.journalSink();
    diagnose(diagnostic, 'INFO', 'footer', 'Custom footer installed beside owned stock input');
    ctx.ui.setFooter((tui, _theme, data) => {
      this.render = new WeakRef(tui);
      let snapshot: FooterData | undefined;
      let firstMessage: string | undefined;
      let stamp: { epoch: number; session: string; leaf: string | null; model: ExtensionContext['model'] } | undefined;
      const view = new FooterView(() => {
        const current = this.facts.context()!;
        const manager = current.sessionManager, session = manager.getSessionId(), leaf = manager.getLeafId(), model = current.model;
        if (this.name?.session !== session) this.name = { session, value: manager.getSessionName() };
        if (stamp?.session !== session) firstMessage = undefined;
        if (stamp?.session === session && stamp.leaf !== leaf) {
          // Metadata-only appends move the leaf but do not change usage/context.
          let entry = manager.getLeafEntry();
          while (entry?.type === 'session_info') {
            if (entry.parentId === stamp.leaf) { stamp.leaf = leaf; break; }
            entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
          }
        }
        const auto = this.facts.autoCompaction();
        const subscription = FOOTER_FIELDS.cost && !!model && (model.provider === 'kimi-coding' ||
          (current.modelRegistry.isUsingOAuth(model) && current.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true));
        if (!snapshot || !stamp || stamp.epoch !== this.epoch || stamp.session !== session || stamp.leaf !== leaf || stamp.model !== model) {
          const entries = manager.getEntries();
          firstMessage ??= footerFirstMessage(entries);
          snapshot = { usage: footerUsage(entries), context: current.getContextUsage(), auto, subscription, sessionName: this.name.value ?? firstMessage ?? '(no messages)' };
          diagnose(diagnostic, 'DEBUG', 'footer', 'Footer usage snapshot refreshed by existing semantic boundary', { epoch: this.epoch, session, model: model?.name, provider: model?.provider, auto });
          stamp = { epoch: this.epoch, session, leaf, model };
        } else {
          const sessionName = this.name.value ?? firstMessage ?? '(no messages)';
          if (snapshot.auto !== auto || snapshot.subscription !== subscription || snapshot.sessionName !== sessionName)
            snapshot = { ...snapshot, auto, subscription, sessionName };
        }
        return snapshot;
      }, () => data.getExtensionStatuses(), () => this.facts.context()!.ui.theme, this.visible, diagnostic);
      this.owned = view;
      return Object.assign(view, { dispose: () => {
        view.clear(); snapshot = undefined; stamp = undefined; firstMessage = undefined;
        diagnose(diagnostic, 'INFO', 'footer', 'Public footer disposal observed; no replacement of a later owner');
        if (this.owned === view) { this.owned = undefined; this.render = undefined; }
      } });
    });
  }
}
