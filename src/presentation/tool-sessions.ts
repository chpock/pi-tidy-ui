import { FilePreviewState } from './file-preview-state.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import { FileDetails } from './file-details.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import type { RenderCache, CacheEntry, LayoutKind } from '../render-cache.ts';
import type { FileToolReader, ToolDiagnosticsIdentity } from '../tool-adapters/contracts.ts';
import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { CardLayout, CardRows } from '../rendering/card-layout.ts';

export type PresentationConstructionKind = 'session' | 'observation' | 'plan';
export type PresentationConstructionObserver = (kind: PresentationConstructionKind) => void;

function equalLayoutIdentity(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ToolPresentationLayout {
  rows: string[];
  prefixLength?: number;
  prefixLeft?: number;
  prefixSpace?: boolean;
  framed?: boolean;
  native?: boolean;
}

export type PreparedLayout = {
  scene: CardLayout;
  output: CardRows;
  width: number;
  padding: number;
  expanded: boolean;
  geometryStamp: number;
  paintStamp: number;
  publication: number;
  origin: 'owned' | 'pi';
  gap?: number;
};

export type FileSourceSnapshot = { mode: FilePreviewMode; key: readonly unknown[] };
export type FileInputSnapshot = { reader: FileToolReader; source: FileSourceSnapshot; diagnostics: ToolDiagnosticsIdentity; token: object };

export type ToolSyntaxState = {
  attempt: number; revision: number; sourceRevision: number; serviceRevision: number; identity: unknown[]; service: unknown[];
  fileInput?: FileInputSnapshot;
  palette?: number; paletteColors?: WeakRef<object>; mode?: TerminalColorMode; complete: boolean; live: boolean; applied: boolean; paused?: boolean; owned?: boolean;
  refreshPending?: boolean; refreshToken?: object; refused?: boolean; paintRetry?: boolean;
  unreflected?: 'refresh' | 'bash-update';
  prefix?: { sourceRevision: number; basis: number; bytes: number };
};

export interface ToolLayoutState {
  signature: unknown[];
  entry: CacheEntry<ToolPresentationLayout>;
  pool: RenderCache;
  gap?: number;
}

export interface PreparedLayoutState {
  entry: CacheEntry<PreparedLayout>;
  pool: RenderCache;
}

export interface ReadImageWindow {
  width: number;
  start: number;
  end: number;
}

export interface ToolPresentationSession {
  lastRenderWidth?: number;
  readImageWindow?: ReadImageWindow;
  imageWindowVisible?: boolean;
  dirtyFileSources?: boolean;
}

export interface ToolDetailPorts<Owner extends object> {
  args(owner: Owner): object;
  result(owner: Owner): unknown;
  funding(): GeometryFunding | undefined;
  failed(owner: Owner, error: unknown): void;
}

export class ToolPresentationSessions<Owner extends object> {
  readonly filePreview: FilePreviewState<Owner>;
  readonly fileDetails: FileDetails<Owner>;
  private components = new WeakMap<Owner, ToolPresentationSession>();
  private layouts = new WeakMap<Owner, ToolLayoutState>();
  private prepared = new WeakMap<Owner, PreparedLayoutState>();
  private syntaxes = new WeakMap<Owner, ToolSyntaxState>();
  private readonly constructionObserver: PresentationConstructionObserver | undefined;

  constructor(detailPorts: ToolDetailPorts<Owner>, constructionObserver?: PresentationConstructionObserver) {
    this.constructionObserver = constructionObserver;
    this.filePreview = new FilePreviewState<Owner>();
    this.fileDetails = new FileDetails<Owner>(detailPorts);
  }

  session(owner: Owner): ToolPresentationSession {
    let session = this.components.get(owner);
    if (!session) {
      session = {};
      this.components.set(owner, session);
      this.constructionObserver?.('session');
    }
    return session;
  }

  peek(owner: Owner): ToolPresentationSession | undefined {
    return this.components.get(owner);
  }

  layout(owner: Owner): ToolLayoutState | undefined {
    return this.layouts.get(owner);
  }

  setLayout(owner: Owner, layout: ToolLayoutState): void {
    this.session(owner);
    this.layouts.set(owner, layout);
    this.observeConstruction('plan');
  }

  reusableLayout(owner: Owner, signature: readonly unknown[]): ToolPresentationLayout | undefined {
    const current = this.layouts.get(owner);
    if (!current || !equalLayoutIdentity(signature, current.signature)) return undefined;
    return current.pool.get(current.entry);
  }

  publishLayout(owner: Owner, signature: unknown[], pool: RenderCache, kind: LayoutKind, value: ToolPresentationLayout): void {
    pool.get(undefined);
    this.setLayout(owner, { signature, pool, entry: pool.put(value, value.rows, kind) });
  }

  dropLayout(owner: Owner): void {
    const layout = this.layouts.get(owner);
    if (layout) layout.pool.drop(layout.entry);
    this.layouts.delete(owner);
  }

  preparedLayout(owner: Owner): PreparedLayoutState | undefined {
    return this.prepared.get(owner);
  }

  setPreparedLayout(owner: Owner, entry: CacheEntry<PreparedLayout>, pool: RenderCache): void {
    this.session(owner);
    this.prepared.set(owner, { entry, pool });
    this.observeConstruction('plan');
  }

  dropPreparedLayout(owner: Owner): void {
    const prepared = this.prepared.get(owner);
    if (prepared) prepared.pool.drop(prepared.entry);
    this.prepared.delete(owner);
  }

  clearLayouts(): void {
    this.layouts = new WeakMap();
    this.prepared = new WeakMap();
  }

  syntax(owner: Owner): ToolSyntaxState | undefined {
    return this.syntaxes.get(owner);
  }

  hasCurrentDisplay(owner: Owner): boolean {
    const state = this.syntax(owner);
    return state?.applied === true && state.unreflected !== 'bash-update';
  }

  setSyntax(owner: Owner, state: ToolSyntaxState): void {
    this.session(owner);
    this.syntaxes.set(owner, state);
    this.observeConstruction('observation');
  }

  clearSyntax(): void {
    this.syntaxes = new WeakMap();
  }

  markFileSourcesDirty(owner: Owner): void {
    this.session(owner).dirtyFileSources = true;
  }

  takeFileSourcesDirty(owner: Owner): boolean {
    const session = this.peek(owner);
    if (!session?.dirtyFileSources) return false;
    session.dirtyFileSources = false;
    return true;
  }

  setLastRenderWidth(owner: Owner, width: number): void {
    this.session(owner).lastRenderWidth = width;
  }

  lastRenderWidth(owner: Owner): number | undefined {
    return this.peek(owner)?.lastRenderWidth;
  }

  setImageWindow(owner: Owner, width: number, start: number, end: number): void {
    const session = this.session(owner);
    const window = session.readImageWindow;
    if (window) { window.width = width; window.start = start; window.end = end; }
    else {
      session.readImageWindow = { width, start, end };
      this.observeConstruction('plan');
    }
    session.imageWindowVisible = true;
  }

  imageWindow(owner: Owner): ReadImageWindow | undefined {
    const session = this.peek(owner);
    return session?.imageWindowVisible ? session.readImageWindow : undefined;
  }

  clearImageWindow(owner: Owner): void {
    const session = this.peek(owner);
    if (session) session.imageWindowVisible = false;
  }

  presentRows(owner: Owner, rows: string[], offset: number): string[] {
    const window = this.imageWindow(owner);
    if (window) { window.start += offset; window.end += offset; }
    const layout = this.layouts.get(owner);
    if (layout) layout.gap = offset;
    const prepared = this.prepared.get(owner)?.entry.value;
    if (prepared) prepared.gap = offset;
    return offset ? ['', ...rows] : rows;
  }

  forgetSession(owner: Owner): void {
    this.components.delete(owner);
    this.syntaxes.delete(owner);
  }

  observeConstruction(kind: PresentationConstructionKind): void {
    this.constructionObserver?.(kind);
  }

  fileMode(owner: Owner, toolCallId: string, globallyExpanded: boolean): FilePreviewMode {
    return this.filePreview.mode(owner, toolCallId, globallyExpanded);
  }
}
