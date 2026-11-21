import { cardGeometry, insidePanel } from '../card-frame.ts';
import { reflow } from '../rendering/measured-rows.ts';
import type { TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { CardTheme } from '../card-theme.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import type { CardPreparationPort } from './card-preparation.ts';
import type { ToolFieldAccessors, ToolProducerPresenter } from './tool-producers.ts';
import type { ToolPresentationPolicy } from './tool-policy.ts';
import type { ToolRoutingPresenter } from './tool-routing-presenter.ts';
import type { ToolPreparationPresenter } from './tool-preparation.ts';
import type { ToolPresentationSessions, PreparedLayout } from './tool-sessions.ts';
import type { ToolSummaryPresenter } from './tool-summary-presenter.ts';
import type { FileDetailPresenter } from './file-detail-presenter.ts';
import type { PreparedLayoutPresenter } from './prepared-layout-presenter.ts';

const SPINNER_FRAMES = Array.from('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏');
export const SPINNER_INTERVAL_MS = 100;
export type NativeToolRender<Owner, NativeRows extends readonly string[]> = (this: Owner, width: number) => NativeRows;
export type NativeToolMouse<Owner> = (this: Owner, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
export type NativeToolUpdate<Owner> = (this: Owner, ...args: unknown[]) => unknown;
export type ToolUpdateName = 'updateArgs' | 'updateResult' | 'setExpanded' | 'invalidate' | 'markExecutionStarted'
  | 'setShowImages' | 'setImageWidthCells' | 'setArgsComplete';

export interface ToolViewPorts<Owner extends object, NativeRows extends readonly string[]> {
  fields: ToolFieldAccessors<Owner>;
  producer: ToolProducerPresenter<Owner>;
  sessions: ToolPresentationSessions<Owner>;
  policy: ToolPresentationPolicy<Owner>;
  routing: ToolRoutingPresenter<Owner>;
  preparation: ToolPreparationPresenter<Owner>;
  summary: ToolSummaryPresenter<Owner>;
  detail: FileDetailPresenter<Owner>;
  prepared: PreparedLayoutPresenter<Owner>;
  cards(): CardPreparationPort<Owner> | undefined;
  funding(): GeometryFunding | undefined;
  theme(): CardTheme;
  padding(): number;
  paletteOrigin(): 'pi' | 'owned';
  host: {
    active(): boolean;
    quiescing(): boolean;
    attached(owner: Owner): boolean;
    hidden(owner: Owner): boolean;
    cwd(owner: Owner): string | undefined;
    isTool(owner: object): owner is Owner;
    siblings(owner: object): readonly object[];
    index(owner: object, siblings: readonly object[]): number;
    otherRows(owner: object, width: number): readonly string[];
    nativeRows(owner: Owner, width: number): NativeRows;
    imageRows(owner: Owner, width: number): string[];
    releaseFileRenderer(owner: Owner): void;
    syncRendererArgs(owner: Owner, kind: 'file' | 'read'): void;
    selection(): boolean;
    setExpanded(owner: Owner, expanded: boolean): void;
    requestRender(): void;
  };
  animation: {
    animate(owner: Owner): void;
    remove(owner: Owner): void;
    time(): number;
    epoch(): number | undefined;
  };
  decision(owner: Owner, message: string, width: number, rows: number): void;
  invalidated(owner: Owner, cause: string): void;
  phase(owner: Owner, operation: ToolUpdateName): void;
}

/** Coordinates current view, spacing and hit geometry without owning source work or native component shapes. */
export function createToolViewPresenter<Owner extends object, NativeRows extends readonly string[]>(ports: ToolViewPorts<Owner, NativeRows>) {
  const { fields, producer, sessions, policy, routing, preparation, host, animation, cards } = ports;
  const { pauseSyntax, usefulSyntax, syntaxEligible, requestFilePreparation, observePalette, observeSyntax,
    unsupportedFullFile, prepareFileDetail } = preparation;
  const fileMode = (node: Owner) => policy.fileMode(node);
  const filePreviewMode = (node: Owner) => policy.filePreviewMode(node);
  const fileSucceeded = (node: Owner) => policy.fileSucceeded(node);
  const cardKind = (node: Owner) => producer.kind(node);
  const nativeRows = host.nativeRows;
  const preparedLayout = (node: Owner, width: number) => ports.prepared.prepare(node, width);
  function preparedRows(layout: PreparedLayout): string[] {
    let rows: string[] | undefined; layout.output.withRows(value => { rows = value; }); return rows ?? [];
  }
  const fileDetailLayout = (node: Owner, width: number) => ports.detail.layout(node, width);
  function executing(node: Owner): boolean {
    return fields.executionStarted(node) && (fields.partial(node) || !fields.result(node)) &&
      (host.isTool(node) && policy.eligible(node) || policy.ownedBash(node) && sessions.layout(node)?.signature[0] === 'summary');
  }
  function restorePreview(node: Owner): void {
    if (host.attached(node) && policy.fileTool(node) && policy.filePresentationEligible(node)) {
      sessions.filePreview.observe(node, fields.id(node));
      if (policy.fileSucceeded(node)) sessions.filePreview.finalize(node, fields.id(node));
    }
  }
  function pause(node: Owner): void { pauseSyntax(node); animation.remove(node); }
  function attach(node: Owner): void {
    preparation.observeFileTurn(node, true);
    if (policy.filePresentationTool(node)) preparation.seedFileState(node); else observeSyntax(node);
    prepareFileDetail(node);
  }
  function forget(node: Owner, cause = 'source or lifecycle changed', preserveFileDetail = false): void {
    const state = sessions.layout(node); sessions.dropLayout(node);
    if (!preserveFileDetail) sessions.fileDetails.drop(node);
    if (state) ports.invalidated(node, cause);
  }
  function invalidatePrepared(node: Owner, cause: string): void {
    forget(node, cause, true);
    sessions.clearImageWindow(node);
    host.requestRender();
  }
  function remove(node: Owner): void {
    sessions.filePreview.detach(node); forget(node); sessions.dropPreparedLayout(node);
    animation.remove(node); cards()?.remove(node); sessions.forgetSession(node);
  }

  function summaryLayout(node: Owner, width: number) {
    return ports.summary.layout(node, width, ports.theme(), ports.padding(), host.cwd(node), fileMode(node));
  }
  function fileLayout(node: Owner, width: number) {
    const mode = fileMode(node);
    if (!fileSucceeded(node)) {
      const layout = mode === 'full' ? fileDetailLayout(node, width) : summaryLayout(node, width);
      return { ...layout, native: false };
    }
    if (cardKind(node) === 'read' && mode !== 'full')
      return { ...summaryLayout(node, width), framed: false, native: false };
    const layout = preparedLayout(node, width);
    if (layout) return { geometry: layout.scene.geometry, framed: layout.scene.framed, native: false, rows: preparedRows(layout) };
    if (cardKind(node) !== 'read' && (mode === undefined || mode === 'full' && unsupportedFullFile(node)))
      return { rows: nativeRows(node, width), framed: false, native: true };
    return { ...fileDetailLayout(node, width), framed: false, native: false };
  }
  function readImageRows<Rows extends readonly string[]>(node: Owner, width: number, rows: Rows, framed: boolean): Rows | string[] {
    sessions.clearImageWindow(node);
    if (cardKind(node) !== 'read' || !fields.expanded(node) || !fields.result(node) || width < 1) return rows;
    const geometry = cardGeometry(width, ports.padding());
    if (geometry.contentWidth < 1) return rows;
    const rendered = host.imageRows(node, geometry.contentWidth);
    if (!rendered.length) return rows;
    const images = rendered.map(row => {
      if (!row) return '';
      if (row.includes('\x1b_G') || row.includes('\x1b]1337;File='))
        return `\x1b[0m${geometry.contentX ? `\x1b[${geometry.contentX}C` : ''}${row}`;
      return `${' '.repeat(geometry.contentX)}${row}`;
    });
    const insertion = framed && rows.length ? rows.length - 1 : rows.length;
    sessions.setImageWindow(node, width, insertion, insertion + images.length);
    return [...rows.slice(0, insertion), ...images, ...rows.slice(insertion)];
  }
  function fileMeasure(node: Owner, width: number) {
    const withImageRows = (measure: { framed: boolean; height: number }) => {
      const imageWindow = cardKind(node) === 'read' ? sessions.imageWindow(node) : undefined;
      return imageWindow?.width === width ? { ...measure, height: measure.height + imageWindow.end - imageWindow.start } : measure;
    };
    const fallback = () => {
      const mode = fileMode(node);
      if (!fileSucceeded(node)) {
        const layout = mode === 'full' ? fileDetailLayout(node, width) : summaryLayout(node, width);
        return { framed: layout.framed ?? false, height: layout.rows.length };
      }
      if (cardKind(node) === 'read' && mode !== 'full') {
        const summary = summaryLayout(node, width);
        return { framed: false, height: summary.rows.length };
      }
      if (cardKind(node) !== 'read' && (mode === undefined || unsupportedFullFile(node))) {
        const rows = nativeRows(node, width);
        return { framed: false, height: rows.length - (rows[0] === '' ? 1 : 0) };
      }
      const layout = fileDetailLayout(node, width);
      return { framed: layout.framed ?? false, height: layout.rows.length };
    };
    if (width < 1 && fileMode(node) !== undefined) { pauseSyntax(node); return { framed: false, height: 0 }; }
    if (!fileSucceeded(node)) return withImageRows(fallback());
    if (!sessions.syntax(node)?.applied || sessions.syntax(node)?.paintRetry) {
      if (fileMode(node) !== undefined && width > 0 && routing.fileVisible(node, width)) {
        sessions.setLastRenderWidth(node, width);
        requestFilePreparation(node, width);
      }
      return withImageRows(fallback());
    }
    observePalette(node, ports.paletteOrigin());
    if (!sessions.syntax(node)?.applied) return withImageRows(fallback());
    const existing = sessions.preparedLayout(node)?.entry.value, padding = ports.padding();
    let measurement: { framed: boolean; height: number } | undefined, unsupported = false;
    const requestedMode = fileMode(node);
    const accepted = cards()?.visit(node, display => {
      if (display.kind !== 'file') return;
      if (display.mode === undefined) {
        if (cardKind(node) !== 'read' && requestedMode !== 'preview') unsupported = true;
        return;
      }
      if (existing?.scene.isRetained && existing.width === width && existing.padding === padding && existing.geometryStamp === display.geometryStamp) {
        measurement = { framed: existing.scene.framed, height: existing.scene.rowCount }; return;
      }
      // Spacing distinguishes a frame from an inline heading without reflowing source rows.
      if (display.mode !== 'inline') { measurement = { framed: true, height: width > 0 ? 3 : 0 }; return; }
      const geometry = cardGeometry(width, padding), inset = Math.min(geometry.contentX, Math.max(0, geometry.width - geometry.marginRight - 1));
      const available = geometry.width - inset - geometry.marginRight;
      if (available <= 0 || !display.heading) { measurement = { framed: false, height: 0 }; return; }
      const funding = ports.funding(); if (!funding) return;
      const heading = reflow(display.heading.measured, { mode: 'file', width: available, wrap: 'fragments' }, funding.grant);
      try { if (heading) measurement = { framed: false, height: heading.rowCount }; }
      finally { heading?.dispose(); }
    });
    if (!accepted) return withImageRows(fallback());
    if (unsupported) {
      const rows = nativeRows(node, width);
      return withImageRows({ framed: false, height: rows.length - (rows[0] === '' ? 1 : 0) });
    }
    return withImageRows(measurement ?? fallback());
  }
  function paintSummary(node: Owner, width: number): string[] {
    const layout = summaryLayout(node, width);
    animation.animate(node);
    if (!executing(node) || !layout.rows.length) return layout.rows;
    const now = animation.time();
    const frame = SPINNER_FRAMES[Math.floor((now - (animation.epoch() ?? now)) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
    const prefix = ports.theme().fg('dim', ' '.repeat(layout.prefixLeft) + frame + (layout.prefixSpace ? ' ' : ''));
    return [prefix + layout.rows[0]!.slice(layout.prefixLength), ...layout.rows.slice(1)];
  }
  function presentSummary(node: Owner, width: number): string[] {
    if (width < 1) { animation.remove(node); pauseSyntax(node); return []; }
    const offset = gap(node, width), rows = paintSummary(node, width);
    ports.decision(node, 'Compact tool summary selected', width, rows.length);
    return sessions.presentRows(node, rows, offset);
  }
  function previousLayout(node: object, width: number): { compact: boolean; tool: boolean; height: number; separator?: boolean } | undefined {
    const siblings = host.siblings(node), current = host.index(node, siblings);
    for (let index = current - 1; index >= 0; index--) {
      const previous = siblings[index]!;
      if (width > 0 && host.isTool(previous) && routing.bash(previous, width)) {
        const state = sessions.layout(previous);
        if (state?.signature[0] !== 'summary' && sessions.hasCurrentDisplay(previous) && cards()?.visit(previous, () => {}))
          return { compact: false, tool: true, height: 3 };
        return { compact: true, tool: true, height: summaryLayout(previous, width).rows.length };
      }
      if (host.isTool(previous) && (filePreviewMode(previous) !== undefined ||
        cardKind(previous) === 'read' && policy.filePresentationEligible(previous))) {
        if (width < 1) { pauseSyntax(previous); continue; }
        if (width >= 1 && routing.file(previous, width)) {
          if (!routing.fileVisible(previous, width)) continue;
          const measure = fileMeasure(previous, width);
          if (measure?.height) return { compact: !measure.framed, tool: true, height: measure.height };
          const summary = summaryLayout(previous, width);
          if (summary.rows.length) return { compact: true, tool: true, height: summary.rows.length };
          continue;
        }
      }
      if (host.isTool(previous) && routing.compact(previous, width))
        return { compact: true, tool: true, height: summaryLayout(previous, width).rows.length };
      const lines = host.otherRows(previous, width);
      if (lines.length) return { compact: false, tool: host.isTool(previous), height: lines.length - (lines[0] === '' ? 1 : 0), separator: lines.at(-1) === '' };
    }
    return undefined;
  }
  function gap(node: Owner, width: number): number {
    const previous = previousLayout(node, width);
    return previous ? previous.compact && previous.height === 1 ? 0 : 1 : 0;
  }
  function nativeGap(node: Owner, width: number, lines: readonly string[]): number {
    if (!host.active() || !lines.length || lines[0] === '') return 0;
    const previous = previousLayout(node, width);
    return previous?.tool && previous.height > 1 ? 1 : 0;
  }
  function cleanupRows(node: Owner, width: number): string[] | undefined {
    const prepared = sessions.preparedLayout(node)?.entry.value;
    if (prepared && prepared.width === width && width > 0 && prepared.gap !== undefined &&
      prepared.scene.isValid && prepared.output.isValid && sessions.hasCurrentDisplay(node) && syntaxEligible(node)) {
      if (!routing.fileVisible(node, width)) return [];
      const baseRows = preparedRows(prepared);
      const rows = cardKind(node) === 'read' ? readImageRows(node, width, baseRows, prepared.scene.framed) : baseRows;
      return sessions.presentRows(node, rows, prepared.gap);
    }
    const state = sessions.layout(node);
    if (!state || state.gap === undefined || width < 1 || state.signature[1] !== width || host.hidden(node)
      || state.signature[6] !== fields.result(node) || state.signature[7] !== fields.expanded(node) || state.signature[8] !== fields.partial(node)) return;
    if (state.signature[5] !== fields.args(node)) return;
    if (!routing.fileVisible(node, width)) return [];
    const layout = state.pool.get(state.entry);
    if (!layout || layout.native) return undefined;
    const rows = cardKind(node) === 'read' ? readImageRows(node, width, layout.rows, layout.framed === true) : layout.rows;
    return sessions.presentRows(node, rows, state.gap ?? 0);
  }
  function render(node: Owner, width: number, originalRender: NativeToolRender<Owner, NativeRows>): NativeRows | string[] {
    if (host.isTool(node)) sessions.setLastRenderWidth(node, width);
    if (cardKind(node) === 'read') sessions.clearImageWindow(node);
    if (host.quiescing()) return cleanupRows(node, width) ?? originalRender.call(node, width);
    if (host.isTool(node)) preparation.observeFrame(node, width);
    if (width < 1 && fileMode(node) !== undefined && routing.fileSuppressed(node, width)) {
      animation.remove(node); pauseSyntax(node); return [];
    }
    if (host.isTool(node) && routing.bash(node, width)) {
      const layout = preparedLayout(node, width);
      if (!layout) return presentSummary(node, width);
      animation.remove(node);
      forget(node, 'prepared Bash replaces compact summary');
      const rows = preparedRows(layout);
      ports.decision(node, rows.length ? 'Bash card selected' : 'Bash card returned no rows', width, rows.length);
      if (!rows.length) { pauseSyntax(node); return rows; }
      usefulSyntax(node);
      return sessions.presentRows(node, rows, previousLayout(node, width) ? 1 : 0);
    }
    if (width >= 1 && host.isTool(node) && routing.file(node, width)) {
      if (!host.attached(node)) {
        animation.remove(node); pauseSyntax(node);
        const rows = originalRender.call(node, width);
        return nativeGap(node, width, rows) ? ['', ...rows] : rows;
      }
      const hidden = !routing.fileVisible(node, width);
      if (hidden) { animation.remove(node); pauseSyntax(node); return []; }
      if (fileSucceeded(node)) {
        animation.remove(node);
        if (cardKind(node) === 'read' && fileMode(node) !== 'full') pauseSyntax(node);
        else if (!sessions.syntax(node)?.applied || sessions.syntax(node)?.paintRetry) requestFilePreparation(node, width);
        else observePalette(node, ports.paletteOrigin());
      }
      else { if (!executing(node)) animation.remove(node); pauseSyntax(node); }
      const layout = fileLayout(node, width);
      if ((routing.fileRenderer(node) || routing.readRenderer(node)) && !layout.native && (fileSucceeded(node) || fields.expanded(node))) host.releaseFileRenderer(node);
      if (!layout.native && layout.rows.length && (layout.framed || fileSucceeded(node))) usefulSyntax(node);
      else pauseSyntax(node);
      const rows = layout.framed || fileSucceeded(node) || cardKind(node) === 'read' && fileMode(node) === 'full' ? layout.rows : [
        ...paintSummary(node, width), ...layout.rows.slice(summaryLayout(node, width).rows.length),
      ];
      const displayedRows = cardKind(node) === 'read' ? readImageRows(node, width, rows, layout.framed === true) : rows;
      ports.decision(node, layout.native ? 'File card delegated to native renderer; preparation/geometry guard rejected' : layout.framed ? 'Prepared file card selected' : 'Inline file result selected', width, displayedRows.length);
      const offset = layout.native ? nativeGap(node, width, layout.rows) : layout.framed ? (previousLayout(node, width) ? 1 : 0) : gap(node, width);
      return sessions.presentRows(node, displayedRows, offset);
    }
    pauseSyntax(node);
    if (policy.filePresentationTool(node)) sessions.fileDetails.drop(node);
    const intent = routing.summaryIntent(node, width);
    if (intent === 'native') {
      animation.remove(node);
      const lines = originalRender.call(node, width);
      ports.decision(node, 'Native tool renderer selected; custom/compact eligibility rejected', width, lines.length);
      return nativeGap(node, width, lines) ? ['', ...lines] : lines;
    }
    if (intent === 'suppressed') {
      ports.decision(node, width < 1 ? 'Tool suppressed at zero width' : 'Native self-shell returned no visible rows', width, 0);
      animation.remove(node); return [];
    }
    if (policy.filePresentationTool(node) && (routing.fileRenderer(node) || routing.readRenderer(node))) host.releaseFileRenderer(node);
    return presentSummary(node, width);
  }
  function mouse(node: Owner, event: TuiMouseEvent, originalRender: NativeToolRender<Owner, NativeRows>, originalMouse: NativeToolMouse<Owner>): TuiMouseEventResult | undefined {
    if (!host.active()) return originalMouse.call(node, event);
    if (event.width < 1 && filePreviewMode(node) !== undefined) { pauseSyntax(node); return undefined; }
    if (host.quiescing()) return undefined;
    if (event.width > 0 && host.isTool(node) && routing.bash(node, event.width)) {
      if (event.type !== 'click' || event.button !== 'left' || host.selection()) return undefined;
      const layout = preparedLayout(node, event.width);
      const offset = previousLayout(node, event.width) ? 1 : 0;
      const hit = layout?.scene.expandable && insidePanel(layout.scene.geometry, layout.output.rowCount, event.x, event.y - offset);
      if (!hit) return undefined;
      host.setExpanded(node, !fields.expanded(node));
      host.requestRender();
      return { handled: true };
    }
    if (event.width > 0 && host.isTool(node) && routing.file(node, event.width)) {
      const imageWindow = cardKind(node) === 'read' ? sessions.imageWindow(node) : undefined;
      if (imageWindow && imageWindow.width === event.width && imageWindow.start < event.height &&
        event.y >= imageWindow.start && event.y < Math.min(imageWindow.end, event.height)) return undefined;
      if (!host.attached(node) || !routing.fileVisible(node, event.width)) return originalMouse.call(node, event);
      if (!fields.result(node) || fields.partial(node) || event.type !== 'click' || event.button !== 'left' || host.selection()) {
        if (cardKind(node) === 'read') return undefined;
        const mode = fileMode(node);
        if (mode === undefined || mode === 'full' && cardKind(node) !== 'read' && unsupportedFullFile(node)) {
          const rows = nativeRows(node, event.width), offset = nativeGap(node, event.width, rows);
          if (event.y < offset) return undefined;
          return originalMouse.call(node, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
        }
        return undefined;
      }
      const layout = fileLayout(node, event.width);
      if (layout.native) {
        const offset = nativeGap(node, event.width, layout.rows);
        if (event.y < offset) return undefined;
        return originalMouse.call(node, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
      }
      const offset = layout.framed ? (previousLayout(node, event.width) ? 1 : 0) : gap(node, event.width);
      const currentImageWindow = cardKind(node) === 'read' ? sessions.imageWindow(node) : undefined;
      const contentY = event.y - offset;
      if (currentImageWindow?.width === event.width && event.y >= currentImageWindow.start && event.y < currentImageWindow.end) return undefined;
      const imageRows = currentImageWindow?.width === event.width && event.y >= currentImageWindow.end
        ? currentImageWindow.end - currentImageWindow.start : 0;
      const logicalY = contentY - imageRows;
      const hit = layout.framed || cardKind(node) === 'read'
        ? insidePanel(cardGeometry(event.width, ports.padding()), layout.rows.length, event.x, logicalY)
        : logicalY >= 0 && logicalY < layout.rows.length;
      if (!hit) return undefined;
      if (cardKind(node) === 'read') host.setExpanded(node, !fields.expanded(node));
      else {
        sessions.filePreview.toggle(node, fields.id(node), fields.expanded(node));
        if (fields.expanded(node)) host.setExpanded(node, false);
        else { forget(node, 'file preview expanded or collapsed'); sessions.dropPreparedLayout(node); observeSyntax(node); }
      }
      prepareFileDetail(node);
      host.requestRender(); return { handled: true };
    }
    if (!host.isTool(node) || !routing.compact(node, event.width)) {
      const offset = nativeGap(node, event.width, originalRender.call(node, event.width));
      if (event.y < offset) return undefined;
      return originalMouse.call(node, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
    }
    const offset = gap(node, event.width), summary = summaryLayout(node, event.width).rows;
    const localY = event.y - offset;
    if (!fields.result(node) || fields.partial(node) || event.type !== 'click' || event.button !== 'left' ||
      cardKind(node) === 'read' && host.selection() ||
      (cardKind(node) === 'read'
        ? !insidePanel(cardGeometry(event.width, ports.padding()), summary.length, event.x, localY)
        : localY < 0 || localY >= summary.length)) return undefined;
    host.setExpanded(node, true);
    host.requestRender();
    return { handled: true };
  }
  function presentUser<Rows extends readonly string[]>(node: object, width: number, rows: Rows): Rows | string[] {
    const previous = rows.length ? previousLayout(node, width) : undefined;
    return previous && !previous.separator ? ['', ...rows] : rows;
  }
  function update(node: Owner, name: ToolUpdateName, args: unknown[], method: NativeToolUpdate<Owner>): unknown {
    sessions.clearImageWindow(node);
    if (name === 'setShowImages' || name === 'setImageWidthCells') return method.apply(node, args);
    const preserveFileDetail = policy.fileTool(node) && (name === 'updateArgs' || name === 'updateResult' || name === 'setArgsComplete');
    const sameExpansion = name === 'setExpanded' && args[0] === fields.expanded(node);
    if (name !== 'markExecutionStarted' && !sameExpansion)
      forget(node, name, preserveFileDetail);
    if (host.quiescing() && name !== 'markExecutionStarted') sessions.dropPreparedLayout(node);
    if (policy.filePresentationTool(node) && (name === 'updateArgs' || name === 'updateResult' || name === 'invalidate')) sessions.markFileSourcesDirty(node);
    if (name === 'invalidate') producer.forgetImageResult(fields.result(node));
    const previousArgs = name === 'updateArgs' ? fields.args(node) : undefined;
    const result = method.apply(node, args);
    if (name === 'updateArgs') {
      if (policy.fileTool(node)) host.syncRendererArgs(node, 'file');
      else if (cardKind(node) === 'read') host.syncRendererArgs(node, 'read');
    }
    if (name === 'updateResult') producer.forgetImageResult(fields.result(node));
    preparation.observeFileTurn(node, name === 'updateResult');
    if (name !== 'invalidate') ports.phase(node, name);
    observeSyntax(node, undefined, name === 'invalidate' || sameExpansion ? undefined : previousArgs ?? true);
    if (policy.filePresentationTool(node)) prepareFileDetail(node, preserveFileDetail);
    if (name === 'setExpanded' && cardKind(node) !== 'bash' && fields.expanded(node)) sessions.dropPreparedLayout(node);
    if (name === 'updateResult') preparation.settleInterrupted(node);
    if (!executing(node) || !host.attached(node)) animation.remove(node);
    return result;
  }
  return { render, mouse, update, presentUser, executing, restorePreview, pause, attach, forget, invalidatePrepared, remove };
}
