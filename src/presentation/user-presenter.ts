import { renderUserCard } from '../user-card.ts';
import type { CardTheme } from '../card-theme.ts';
import type { RenderCache, CacheEntry } from '../render-cache.ts';
import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import type { PresentationConstructionObserver } from './tool-sessions.ts';

export interface UserPresentationLayout {
  rows: string[];
  framed?: boolean;
  native?: boolean;
}

export type NativeUserRender<Owner extends object> = (this: Owner, width: number) => string[];

export class UserPresenter<Owner extends object> {
  private layouts = new WeakMap<Owner, { signature: unknown[]; entry: CacheEntry<UserPresentationLayout> }>();

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

  layout(owner: Owner, width: number, theme: CardTheme, padding: number, text: string, outputPad: number,
    markdown: unknown, markdownTheme: object, transformers: unknown[], renderNative: NativeUserRender<Owner>): UserPresentationLayout {
    const signature = [width, theme, theme.fg, theme.bg, padding, text, outputPad, markdown, markdownTheme, transformers];
    const state = this.layouts.get(owner);
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const value = this.cache.get(state.entry); if (value) return value;
    } else { this.cache.drop(state?.entry); this.cache.get(undefined); }
    const value = renderUserCard(owner, width, outputPad, theme, renderNative, padding);
    this.layouts.set(owner, { signature, entry: this.cache.put(value, value.rows, 'user') });
    this.constructionObserver?.('plan');
    diagnose(this.diagnostic, 'DEBUG', 'cache', 'User layout built around Pi-owned Markdown; no content logged',
      { width, padding, rows: value.rows.length });
    return value;
  }
}
