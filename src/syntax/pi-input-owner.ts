import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { GeometryFunding } from '../occipital/controller.ts';
import { preparePiInput, type PiInputCache, type PiInputTheme } from './pi-input.ts';

/** Data-only public Pi palette ownership; never activates a syntax provider. */
export class PiInputOwner {
  private colors?: WeakRef<object>;
  private revision = 0;
  private cache?: PiInputCache;
  private readonly diagnostic?: DiagnosticSink;
  constructor(diagnostic?: DiagnosticSink) { this.diagnostic = diagnostic; }
  palette(theme: { readonly colors: object }): number {
    const colors = theme.colors;
    if (this.colors?.deref() !== colors) { this.colors = new WeakRef(colors); this.revision++;
      diagnose(this.diagnostic, 'DEBUG', 'syntax', 'Public Pi palette generation changed', { palette: this.revision }); }
    return this.revision;
  }
  prepare(theme: PiInputTheme, mode: TerminalColorMode, funding: GeometryFunding) {
    const revision = this.palette(theme), lease = preparePiInput(theme, revision, mode, funding, this.cache);
    let adopted = false;
    try {
      if (this.revision !== revision || this.colors?.deref() !== theme.colors) return;
      if (lease) this.cache = lease.cache;
      adopted = true;
      return lease;
    } finally { if (!adopted) lease?.dispose(); }
  }
  dispose() { this.colors = undefined; this.cache = undefined; }
}
