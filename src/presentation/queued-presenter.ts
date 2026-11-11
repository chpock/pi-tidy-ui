import { prepareQueuedCard, projectQueuedCards, type QueuedCard } from '../queued-card.ts';
import type { CardTheme } from '../card-theme.ts';
import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import type { PresentationConstructionObserver } from './tool-sessions.ts';
import type { CacheEntry, RenderCache } from '../render-cache.ts';

export interface QueuedMessage<Owner extends object> {
  node: Owner;
  raw: string;
  mode: 'Steering' | 'Follow-up';
  prefix: number;
}

export interface QueuedProjection<Owner extends object> {
  node: Owner;
  rows: string[];
}

export class QueuedPresenter<Owner extends object> {
  private layouts = new WeakMap<Owner, { signature: unknown[]; entry: CacheEntry<QueuedCard> }>();

  private readonly cache: RenderCache;
  private readonly diagnostic: DiagnosticSink | undefined;
  private readonly constructionObserver: PresentationConstructionObserver | undefined;

  constructor(cache: RenderCache, diagnostic?: DiagnosticSink, constructionObserver?: PresentationConstructionObserver) {
    this.cache = cache;
    this.diagnostic = diagnostic;
    this.constructionObserver = constructionObserver;
  }

  forget(owner: Owner): void {
    this.cache.drop(this.layouts.get(owner)?.entry);
    this.layouts.delete(owner);
  }

  clear(): void {
    this.layouts = new WeakMap();
  }

  project(messages: readonly QueuedMessage<Owner>[], width: number, height: number, theme: CardTheme, padding: number,
    hint: string, projected: QueuedProjection<Owner>[]): number {
    const cards = messages.map(({ node, raw, mode, prefix }, position) => {
      const editHint = position === messages.length - 1 ? hint : '';
      const signature = [width, padding, theme, theme.fg, theme.bg, theme.style, theme.colors, raw, editHint];
      const state = this.layouts.get(node);
      if (state && signature.every((value, key) => value === state.signature[key])) {
        const retained = this.cache.get(state.entry); if (retained) return retained;
      } else { this.forget(node); this.cache.get(undefined); }
      const card = prepareQueuedCard(raw.slice(prefix), mode, editHint, width, theme, padding);
      diagnose(this.diagnostic, 'DEBUG', 'cache', 'Queued-message layout built; native text is not logged',
        { mode, width, padding, rows: card.rows.length });
      this.layouts.set(node, { signature, entry: this.cache.put(card, [...card.rows, ...card.ellipsis], 'queued') });
      this.constructionObserver?.('plan');
      return card;
    });
    const blocks = projectQueuedCards(cards, height);
    let rowCount = 0;
    messages.forEach(({ node }, position) => {
      const rows = blocks[position]!;
      rowCount += rows.length;
      projected.push({ node, rows });
    });
    return rowCount;
  }
}
