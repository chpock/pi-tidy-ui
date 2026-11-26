import { argumentParts, summaryName } from '../summary-args.ts';
import type { CardTheme } from '../card-theme.ts';
import { toolCardPaint } from '../card-theme.ts';
import { cardGeometry, frameRows } from '../card-frame.ts';
import type { FileDetailView, FileDetails } from './file-details.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import type { LayoutKind, RenderCache } from '../render-cache.ts';
import type { ToolPresentationLayout, ToolPresentationSessions } from './tool-sessions.ts';
import { wrapText } from '../text-wrap.ts';
import type { FileCardInput } from '../cards/file-model.ts';
import type { ToolProducerPresenter } from './tool-producers.ts';

export interface SummaryPresentationLayout extends ToolPresentationLayout {
  prefixLength: number;
  prefixLeft: number;
  prefixSpace: boolean;
}

const SHOW_COMPLETION_MARKERS = false;

type SummaryColor = Parameters<CardTheme['fg']>[0];

function summaryGlyph(kind: ReturnType<ToolProducerPresenter<object>['kind']>): string {
  return kind === 'read' ? '→' : kind === 'edit' || kind === 'write' ? '←' : '⚙';
}

function isSummaryPresentationLayout(layout: ToolPresentationLayout): layout is SummaryPresentationLayout {
  return typeof layout.prefixLength === 'number' && typeof layout.prefixLeft === 'number' && typeof layout.prefixSpace === 'boolean';
}

export class ToolSummaryPresenter<Owner extends object> {
  private readonly producer: ToolProducerPresenter<Owner>;
  private readonly fileDetails: FileDetails<Owner>;
  private readonly sessions: ToolPresentationSessions<Owner>;
  private readonly cache: RenderCache;

  constructor(producer: ToolProducerPresenter<Owner>, fileDetails: FileDetails<Owner>,
    sessions: ToolPresentationSessions<Owner>, cache: RenderCache) {
    this.producer = producer;
    this.fileDetails = fileDetails;
    this.sessions = sessions;
    this.cache = cache;
  }


  fileError(kind: FileCardInput['kind'], path: string | undefined, width: number, theme: CardTheme, padding: number,
    cwd: string | undefined, detail?: FileDetailView): ToolPresentationLayout {
    const geometry = cardGeometry(width, padding), available = geometry.contentWidth;
    const location = path ? argumentParts('write', { path }, cwd).object : undefined;
    const title = kind === 'read' ? '→ Read' : kind === 'edit' ? '← Edit' : '← Write';
    const heading = title + (location ? ` ${location}` : '');
    const service = (text: string, role: SummaryColor) => wrapText(text, available, { wide: 'replace' }).map(row => theme.fg(role, row));
    const body = service(heading, 'muted');
    body.push('');
    const output = detail && !detail.denied ? this.fileDetails.rows(detail, available) : undefined;
    if (output?.length) for (const row of output) body.push(theme.fg('toolOutput', row));
    else body.push(...service(!detail || detail.denied || output === undefined
      ? 'File details are unavailable within the current geometry budget.'
      : 'The tool reported an error without text details.', 'muted'));
    body.push('', ...service('[error: tool call failed]', 'error'));
    return { rows: frameRows(geometry, body, toolCardPaint(theme, true)), framed: true };
  }

  layout(owner: Owner, width: number, theme: CardTheme, padding: number, cwd: string | undefined, mode?: FilePreviewMode): SummaryPresentationLayout {
    const call = this.producer.capture(owner);
    const signature = ['summary', width, padding, theme, theme.fg, call.args, call.result, call.expanded, call.partial, cwd, mode];
    const reusable = this.sessions.reusableLayout(owner, signature);
    if (reusable && isSummaryPresentationLayout(reusable)) return reusable;
    this.sessions.dropLayout(owner);
    const value = this.buildRows(width, theme, padding, undefined, cwd, call);
    const kind: LayoutKind = 'summary';
    this.sessions.publishLayout(owner, signature, this.cache, kind, value);
    return value;
  }

  rows(owner: Owner, width: number, theme: CardTheme, padding: number, title?: string, cwd?: string): SummaryPresentationLayout {
    return this.buildRows(width, theme, padding, title, cwd, this.producer.capture(owner));
  }

  private buildRows(width: number, theme: CardTheme, padding: number, title: string | undefined, cwd: string | undefined,
    call: ReturnType<ToolProducerPresenter<Owner>['capture']>): SummaryPresentationLayout {
    if (width < 1) return { rows: [], prefixLength: 0, prefixLeft: 0, prefixSpace: false };
    const available = width - padding, indent = padding + 2;
    const failed = !call.partial && call.resultFailed;
    const pending = call.partial || !call.hasResult;
    const marker = SHOW_COMPLETION_MARKERS ? pending ? '…' : failed ? '✗' : '✓' : '';
    const statusColor: SummaryColor = failed ? 'error' : pending ? 'muted' : 'success';
    if (available < indent + 2) {
      const left = Math.min(padding, Math.max(0, width - 1 - padding));
      const prefix = theme.fg(marker ? statusColor : failed ? 'error' : 'dim', ' '.repeat(left) + (marker || summaryGlyph(this.producer.kindFrom(call))));
      return { rows: [prefix], prefixLength: prefix.length, prefixLeft: left, prefixSpace: false };
    }
    const reader = this.producer.readerFrom(call);
    const prefix = theme.fg(failed ? 'error' : 'dim', `${' '.repeat(padding)}${summaryGlyph(reader?.kind)} `);
    const parts: { color?: SummaryColor; text: string }[] = [{ color: 'toolTitle', text: title ?? summaryName(call.name) }];
    const { pattern, object, params } = argumentParts(call.name, reader?.summaryArgs() ?? call.args, cwd);
    if (pattern) {
      parts.push({ color: 'muted', text: ` ${pattern}` });
      if (object) parts.push({ color: 'dim', text: ' in ' }, { color: 'muted', text: object });
    } else if (object) parts.push({ color: 'muted', text: ` ${object}` });
    const parameterStart = parts.reduce((length, part) => length + part.text.length, 0) + 1;
    if (params) parts.push({ color: 'dim', text: ` ${params}` });
    if (marker) parts.push({ text: ' ' }, { color: statusColor, text: marker });
    const plain = parts.map(part => part.text).join('');
    let end = 0;
    const spans = parts.map(part => { const start = end; end += part.text.length; return { ...part, start, end }; });
    let cursor = 0;
    const rows = wrapText(plain, available - indent, { json: true, parameterStart, parameterLength: params.length }).map((rawLine, index) => {
      const line = rawLine.trimEnd();
      const start = plain.indexOf(line, cursor);
      if (start < 0) throw new Error('Wrapped text is not a source substring');
      cursor = start + line.length;
      const styled = spans.map(span => {
        const from = Math.max(start, span.start), to = Math.min(cursor, span.end);
        if (from >= to) return '';
        const text = plain.slice(from, to);
        return failed ? theme.fg('error', text) : span.color ? theme.fg(span.color, text) : text;
      }).join('');
      return (index === 0 ? prefix : ' '.repeat(indent)) + styled;
    });
    if (reader?.kind === 'read') appendNotice(rows, reader.compactNotice?.(), theme, indent, available - indent);
    return { rows, prefixLength: prefix.length, prefixLeft: padding, prefixSpace: true };
  }
}

function appendNotice(rows: string[], notice: string | undefined, theme: CardTheme, indent: number, width: number): void {
  if (!notice) return;
  const prefix = ' '.repeat(indent);
  for (const line of wrapText(notice, width)) rows.push(prefix + theme.fg('muted', line));
}
