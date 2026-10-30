import { diagnose, reportRuntime, type DiagnosticSink } from '../diagnostics.ts';
import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { GeometryFunding } from '../occipital/controller.ts';
import type { ThemeDescription } from '../themes/selection.ts';
import { preparePaletteInput, type PaletteInputCache, type PiInputTheme } from './pi-input.ts';
import { OwnedPaletteDataError } from '../themes/owned-palette.ts';

/** One weak-cache owner for Follow Pi samples and locally owned palettes. */
export class PaletteInputOwner {
  private colors?: WeakRef<object>;
  private identity = '';
  private revision = 0;
  private cache?: PaletteInputCache;
  private failed?: { readonly identity: string; readonly revision: number; readonly mode: TerminalColorMode };
  private readonly diagnostic?: DiagnosticSink;
  private readonly notify?: (message: string) => void;
  constructor(diagnostic?: DiagnosticSink, notify?: (message: string) => void) {
    this.diagnostic = diagnostic;
    this.notify = diagnostic?.runtime ? undefined : notify;
  }
  palette(theme: { readonly colors: object } | undefined, palette: ThemeDescription): number {
    const identity = `${palette.kind}:${palette.id}:${palette.fingerprint}`;
    const failed = this.failed?.identity === identity ? this.failed : undefined;
    const followsPi = palette.kind === 'pi' || failed !== undefined;
    const colors = followsPi ? theme?.colors : undefined;
    const identityChanged = this.identity !== identity, colorsChanged = followsPi && this.colors?.deref() !== colors;
    if (identityChanged || colorsChanged) {
      if (identityChanged && this.failed) reportRuntime(this.diagnostic, { kind: 'released', scope: this, operation: 'owned-palette' });
      this.identity = identity; this.colors = colors ? new WeakRef(colors) : undefined; this.revision++;
      if (identityChanged) this.failed = undefined;
      else if (this.failed) this.failed = { ...this.failed, revision: this.revision };
      diagnose(this.diagnostic, 'DEBUG', 'syntax', 'Selected palette generation changed', { palette: this.revision, kind: palette.kind });
    }
    return this.revision;
  }
  prepare(theme: PiInputTheme | undefined, palette: ThemeDescription, paletteRevision: number,
    mode: TerminalColorMode, funding: GeometryFunding, usePiFallback = true, fallbackTheme?: () => PiInputTheme) {
    const identity = `${palette.kind}:${palette.id}:${palette.fingerprint}`;
    if (this.failed?.identity === identity && this.failed.revision === paletteRevision && this.failed.mode === mode) {
      const fallback = usePiFallback ? theme ?? fallbackTheme?.() : undefined;
      return fallback ? this.preparePiFallback(fallback, identity, paletteRevision, mode, funding) : undefined;
    }
    let lease;
    try { lease = preparePaletteInput(theme, palette.kind === 'pi' ? 'pi' : palette.id, paletteRevision, mode, funding, this.cache); }
    catch (error) {
      if (palette.kind !== 'theme' || !(error instanceof OwnedPaletteDataError)) throw error;
      const fallback = usePiFallback ? (theme ?? fallbackTheme?.()) : undefined;
      this.failed = { identity, revision: paletteRevision, mode };
      const colors = fallback?.colors;
      this.colors = colors ? new WeakRef(colors) : undefined;
      diagnose(this.diagnostic, 'WARN', 'syntax', 'Owned palette data is unavailable; retaining prior card colors where possible',
        { palette: palette.id, revision: paletteRevision, mode });
      const message = 'The selected syntax palette could not be loaded; existing card colors are retained where possible, otherwise cards may use Pi colors.';
      try { this.notify?.(message); } catch { /* UI is optional. */ }
      reportRuntime(this.diagnostic, { kind: 'failure', scope: this, operation: 'owned-palette', area: 'syntax', code: 'owned_palette_unavailable' });
      return usePiFallback && fallback ? this.preparePiFallback(fallback, identity, paletteRevision, mode, funding) : undefined;
    }
    let adopted = false;
    try {
      if (this.revision !== paletteRevision || this.identity !== identity
        || palette.kind === 'pi' && this.colors?.deref() !== theme?.colors) return;
      if (lease) {
        this.cache = lease.cache;
        if (palette.kind === 'theme' && this.failed?.identity === identity) {
          this.failed = undefined; this.colors = undefined;
          reportRuntime(this.diagnostic, { kind: 'recovered', scope: this, operation: 'owned-palette' });
        }
      }
      adopted = true;
      return lease;
    } finally { if (!adopted) lease?.dispose(); }
  }
  private preparePiFallback(theme: PiInputTheme, failedIdentity: string, paletteRevision: number,
    mode: TerminalColorMode, funding: GeometryFunding) {
    const lease = preparePaletteInput(theme, 'pi', paletteRevision, mode, funding, this.cache);
    let adopted = false;
    try {
      if (this.revision !== paletteRevision || this.identity !== failedIdentity
        || this.failed?.identity !== failedIdentity || this.failed.revision !== paletteRevision || this.failed.mode !== mode) return;
      if (lease) this.cache = lease.cache;
      adopted = true;
      return lease;
    } finally { if (!adopted) lease?.dispose(); }
  }
  usesPiInput(palette: ThemeDescription): boolean {
    return palette.kind === 'pi' || this.failed?.identity === `${palette.kind}:${palette.id}:${palette.fingerprint}`;
  }
  paletteUnavailable(palette: ThemeDescription, paletteRevision: number, mode: TerminalColorMode): boolean {
    return this.failed?.identity === `${palette.kind}:${palette.id}:${palette.fingerprint}`
      && this.failed.revision === paletteRevision && this.failed.mode === mode;
  }
  dispose() {
    if (this.failed) reportRuntime(this.diagnostic, { kind: 'released', scope: this, operation: 'owned-palette' });
    this.colors = undefined; this.identity = ''; this.cache = undefined; this.failed = undefined;
  }
}
