import type { CardTheme } from '../card-theme.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import type { LayoutKind, RenderCache } from '../render-cache.ts';
import type { FileDetails } from './file-details.ts';
import type { ToolProducerPresenter } from './tool-producers.ts';
import type { ToolPresentationLayout, ToolPresentationSessions } from './tool-sessions.ts';
import type { ToolSummaryPresenter } from './tool-summary-presenter.ts';

export interface FileDetailPresenterPorts<Owner extends object> {
  sessions: ToolPresentationSessions<Owner>;
  cache: RenderCache;
  producer: ToolProducerPresenter<Owner>;
  details: FileDetails<Owner>;
  summaries: ToolSummaryPresenter<Owner>;
  theme(): CardTheme;
  padding(): number;
  mode(owner: Owner): FilePreviewMode | undefined;
  cwd(owner: Owner): string | undefined;
  unsupported(owner: Owner): boolean;
  serviceRows(text: string, width: number, inset: number): readonly string[];
}

export class FileDetailPresenter<Owner extends object> {
  private readonly ports: FileDetailPresenterPorts<Owner>;

  constructor(ports: FileDetailPresenterPorts<Owner>) {
    this.ports = ports;
  }

  layout(owner: Owner, width: number): ToolPresentationLayout {
    const { ports } = this;
    const call = ports.producer.capture(owner);
    const kind = ports.producer.kindFrom(call);
    const theme = ports.theme(), padding = ports.padding(), mode = ports.mode(owner) ?? 'preview';
    const cwd = ports.cwd(owner);
    const layoutKind: LayoutKind = kind === 'other' ? 'summary' : kind;
    const signature = [layoutKind, width, padding, theme, theme.fg, call.args, call.result, call.expanded, call.partial, cwd, mode];

    const reusable = ports.sessions.reusableLayout(owner, signature);
    if (reusable) return reusable;
    ports.sessions.dropLayout(owner);
    const value = this.build(owner, width, call, kind, theme, padding, mode, cwd);
    ports.sessions.publishLayout(owner, signature, ports.cache, layoutKind, value);
    return value;
  }

  private serviceRows(text: string, width: number, padding: number): readonly string[] {
    if (width < 1) return [];
    const inset = Math.min(Math.max(0, padding), Math.floor((width - 1) / 2));
    return this.ports.serviceRows(text, width, inset);
  }

  private build(owner: Owner, width: number, call: ReturnType<ToolProducerPresenter<Owner>['capture']>,
    kind: ReturnType<ToolProducerPresenter<Owner>['kindFrom']>, theme: CardTheme, padding: number, mode: FilePreviewMode,
    cwd: string | undefined): ToolPresentationLayout {
    const { ports } = this;
    const detail = mode === 'full' ? ports.details.peek(owner, mode) : undefined;
      if (mode === 'full' && !call.partial && call.resultFailed)
        return ports.summaries.fileError(owner, width, theme, padding, cwd, detail);

      const summary = ports.summaries.rows(owner, width, theme, padding, kind === 'read' && mode === 'full' ? 'Read' : undefined, cwd);
      const state = ports.sessions.syntax(owner);
      const paintRetry = state?.paintRetry === true;
      const rows = [...summary.rows];
      const fileKind = kind === 'read' || kind === 'edit' || kind === 'write';
      const succeeded = fileKind && call.hasResult && !call.partial && !call.resultFailed;
      if (succeeded && mode === 'preview') {
        const unsupported = ports.unsupported(owner);
        const refused = state?.refused === true;
        rows.push(...this.serviceRows(theme.fg('muted', unsupported ? '  No saved file change details are available; expand for full validation.'
          : paintRetry ? '  File preview unavailable within the current preparation or paint budget.'
            : refused ? '  File preview unavailable within the current geometry budget; expand to continue.'
              : '  Preparing file preview.'), width, padding));
      }
      if (mode === 'full' && (!detail || detail.denied)) {
        const refused = detail?.denied === true || state?.refused === true;
        const message = paintRetry ? kind === 'read' ? '  Full read body unavailable within the current preparation or paint budget.'
          : '  Full file view unavailable within the current preparation or paint budget.'
          : refused ? detail?.denied && !succeeded
            ? '  File details are unavailable within the current geometry budget.'
            : kind === 'read' ? '  Full read body unavailable within the current preparation or geometry budget.'
              : '  Full file view unavailable within the current preparation or geometry budget.'
          : succeeded ? kind === 'read' ? '  Preparing full read body.' : '  Preparing full file view.'
            : call.resultFailed ? '  The tool reported an error without text details.' : '  Waiting for file content.';
        rows.push(...this.serviceRows(theme.fg(refused ? 'muted' : call.resultFailed ? 'error' : 'muted', message), width, padding));
      }
      else if (mode === 'full' && detail?.hasText && !paintRetry) {
        const measured = ports.details.rows(detail, width);
        if (measured) rows.push(...measured);
        else rows.push(...this.serviceRows(theme.fg('muted', '  File details are unavailable within the current geometry budget.'), width, padding));
      }
      if (detail?.omitted) rows.push(...this.serviceRows(theme.fg('muted', '  … additional file content is omitted from this bounded view'), width, padding));
      else if (!detail?.denied && call.resultFailed && mode === 'full' && !detail?.hasText)
        rows.push(...this.serviceRows(theme.fg('error', '  The tool reported an error without text details.'), width, padding));
      else if (!detail?.denied && (call.partial || !call.hasResult) && mode === 'full' && !detail?.hasText)
        rows.push(...this.serviceRows(theme.fg('muted', '  Waiting for file content.'), width, padding));
      if (mode === 'preview' && call.hasResult && !call.partial)
        rows.push(...this.serviceRows(theme.fg('muted', '  … (Click to expand)'), width, padding));
    return { ...summary, rows };
  }
}
