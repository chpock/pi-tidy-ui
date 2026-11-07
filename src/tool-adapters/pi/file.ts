import { getLanguageFromPath } from '@earendil-works/pi-coding-agent';
import { FILE_PREVIEW_MAX_ROWS, FILE_PREVIEW_MAX_UNITS, filePreviewText, prepareFileCard, sourceRows } from '../../file-card.ts';
import type { FileCardInput } from '../../file-card.ts';
import type { FilePreviewMode } from '../../file-preview-state.ts';
import type { FileToolReader, PendingFileDetail, ReaderEstimateContext, ToolAdapter, ToolCallSnapshot } from '../contracts.ts';
import { createFileReader, type FileReaderBehavior } from '../shared/file-reader.ts';
import { weakIdentity } from '../shared/identity.ts';
import { resultDetails as fileData } from '../shared/result-details.ts';

type FileKind = FileToolReader['kind'];
function savedParts(call: ToolCallSnapshot): string[] {
  return call.result?.content?.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!) ?? [];
}
function pathOf(args: Record<string, unknown>): string | undefined {
  const path = args.path ?? args.file_path ?? args.filePath;
  return typeof path === 'string' && path.length ? path : undefined;
}
function source(call: ToolCallSnapshot, kind: FileKind, mode: FilePreviewMode): readonly unknown[] {
  const args = call.args, path = pathOf(args);
  if (kind === 'read') {
    const key = mode === 'full' ? ['saved-text', ...savedParts(call), args.offset] : ['saved-result', weakIdentity(call.result)];
    return [kind, mode, path, ...key, call.partial, call.resultFailed];
  }
  const diff = kind === 'edit' ? fileData(call).diff : undefined;
  const value = kind === 'write' ? args.content : diff !== undefined ? diff : args.newText;
  const text = typeof value === 'string' ? value : undefined;
  const bounded = text === undefined ? undefined : mode === 'preview' ? filePreviewText(text) : { text, omitted: false };
  return [kind, mode, path, kind === 'write' ? 'content' : diff !== undefined ? 'diff' : 'newText', bounded?.text, bounded?.omitted,
    mode === 'full' ? args.content : undefined, false, false, call.partial, call.resultFailed];
}
function estimateBytes(call: ToolCallSnapshot, context: ReaderEstimateContext, kind: FileKind): number {
  let rows = 1;
  const size = (text: string) => {
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10 || text.charCodeAt(index) === 13) rows++;
    return text.length;
  };
  let units = (context.cwd?.length ?? 0) + (context.directory?.length ?? 0) + (context.language?.length ?? 0);
  for (const key of ['command', 'description', 'content', 'path', 'file_path', 'filePath']) {
    const value = call.args[key];
    if (typeof value === 'string') units += size(context.mode === 'preview' && key === 'content' ? filePreviewText(value).text : value);
  }
  if (kind === 'read' && context.mode !== 'preview') {
    let first = true;
    for (const part of call.result?.content ?? []) if (part.type === 'text' && typeof part.text === 'string') {
      if (!first) units += size('\n');
      units += size(part.text); first = false;
    }
  }
  const diff = kind === 'edit' ? fileData(call).diff : undefined;
  if (typeof diff === 'string') units += size(context.mode === 'preview' ? filePreviewText(diff).text : diff);
  return 4096 + units * 6 + rows * 1024;
}
function prepare(call: ToolCallSnapshot, kind: FileKind, mode: FilePreviewMode, logicalOnly: boolean) {
  if (!call.hasResult || call.partial) return undefined;
  const path = pathOf(call.args);
  if (!path) return undefined;
  const common = { kind, path, complete: call.hasResult && !call.partial, failed: call.resultFailed, viewMode: mode };
  if (call.resultFailed && kind !== 'read') return kind === 'edit' ? prepareFileCard(common, logicalOnly) : undefined;
  let input: FileCardInput;
  if (kind === 'read') {
    const rawOffset = call.args.offset;
    const offset = typeof rawOffset === 'number' && Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 1;
    const readRows = mode === 'preview' ? [] : Array.from(sourceRows(savedParts(call).join('\n')), (text, index) => ({ text, line: offset + index }));
    input = { ...common, readRows };
  } else input = { ...common, content: call.args.content, saved: kind === 'edit' && fileData(call).diff !== undefined
    ? { format: 'numbered', value: fileData(call).diff } : undefined };
  return prepareFileCard(input, logicalOnly);
}

/** The aggregate prefix allowance covers all borrowed parts/entries, not each part separately. */
export function pendingPiFile(call: ToolCallSnapshot, kind: FileKind, mode: FilePreviewMode,
  entries: readonly unknown[] = [call.args]): PendingFileDetail {
  const error = !call.partial && call.resultFailed, pendingCall = call.partial || !call.hasResult;
  if (error && mode === 'preview') return { text: '', omitted: false, error: true, pending: false };
  if (!pendingCall) return { text: '', omitted: false, error, pending: false };
  if (mode === 'preview') return { text: '', omitted: false, error: false, pending: true };
  let omitted = false, text = '';
  const bounded = (value: unknown, maxUnits = FILE_PREVIEW_MAX_UNITS, maxRows = FILE_PREVIEW_MAX_ROWS) =>
    typeof value === 'string' ? filePreviewText(value, maxUnits, maxRows) : { text: '', omitted: false };
  if (kind === 'read') {
    let rows = 0, visited = 0, textParts = 0;
    for (const part of call.result?.content ?? []) {
      if (visited >= FILE_PREVIEW_MAX_ROWS) { omitted = true; break; }
      visited++;
      if (part.type !== 'text' || typeof part.text !== 'string') continue;
      const separator = textParts++ ? '\n' : '';
      const remainingUnits = FILE_PREVIEW_MAX_UNITS - text.length - separator.length;
      const remainingRows = FILE_PREVIEW_MAX_ROWS - rows;
      if (remainingUnits < 1 || remainingRows < 1) { omitted = true; break; }
      const piece = bounded(part.text, remainingUnits, remainingRows);
      text += separator + piece.text;
      rows = text.split('\n').length;
      if (piece.omitted) { omitted = true; break; }
    }
    if ((call.result?.content?.length ?? 0) > visited) omitted = true;
    if (text) text = `Available read output:\n${text}`;
  } else if (kind === 'write') {
    const request = bounded(call.args.content);
    text = request.text ? `Requested file content:\n${request.text}` : '';
    omitted = request.omitted;
  } else {
    const multiple = entries.length > 1;
    let combined = '', visited = 0, stop = false;
    for (let index = 0; index < Math.min(entries.length, FILE_PREVIEW_MAX_ROWS); index++) {
      visited = index + 1;
      const entry = entries[index];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { omitted = true; continue; }
      const value = entry as Record<string, unknown>, suffix = multiple ? ` (edit ${index + 1})` : '';
      for (const [label, raw] of [['Original file content', value.oldText], ['Requested replacement', value.newText]] as const) {
        if (typeof raw !== 'string' || !raw) continue;
        const prefix = `${label}${suffix}:\n`, separator = combined ? '\n' : '';
        const currentRows = combined ? combined.split('\n').length : 0;
        const remainingRows = FILE_PREVIEW_MAX_ROWS - currentRows - (separator ? 1 : 0) - 1;
        const remainingUnits = FILE_PREVIEW_MAX_UNITS - combined.length - separator.length - prefix.length;
        if (remainingRows < 1 || remainingUnits < 1) { omitted = true; stop = true; break; }
        const piece = bounded(raw, remainingUnits, remainingRows);
        const preview = filePreviewText(`${combined}${separator}${prefix}${piece.text}`, FILE_PREVIEW_MAX_UNITS, FILE_PREVIEW_MAX_ROWS);
        combined = preview.text;
        omitted ||= piece.omitted || preview.omitted;
        if (piece.omitted || preview.omitted) { stop = true; break; }
      }
      if (stop) break;
    }
    if (entries.length > visited) omitted = true;
    text = combined;
  }
  const preview = filePreviewText(text, FILE_PREVIEW_MAX_UNITS, FILE_PREVIEW_MAX_ROWS);
  return { text: preview.text, omitted: omitted || preview.omitted, error: false, pending: true };
}
function behavior(kind: FileKind): FileReaderBehavior {
  return {
    kind,
    path: call => pathOf(call.args),
    source: (call, mode) => source(call, kind, mode),
    diagnostics: (_call, mode) => mode === 'preview' ? false : [],
    diagnosticText: () => [],
    note: () => undefined,
    service: (call, cwd, mode) => mode === 'preview' ? [cwd, call.partial, call.resultFailed] : [cwd, weakIdentity(call.result), call.partial],
    language: call => { const path = pathOf(call.args); return path ? getLanguageFromPath(path) : undefined; },
    summaryArgs: call => (kind === 'write' || kind === 'edit') && typeof call.args.path === 'string' && call.args.path.length ? { path: call.args.path } : call.args,
    estimateBytes: (call, context) => estimateBytes(call, context, kind),
    prepareFile: (call, mode, logicalOnly) => prepare(call, kind, mode, logicalOnly),
    pendingDetail: (call, mode) => pendingPiFile(call, kind, mode),
  };
}
const behaviors = { read: behavior('read'), write: behavior('write'), edit: behavior('edit') };
export function piFileReader(call: ToolCallSnapshot, kind: FileKind): FileToolReader { return createFileReader(call, behaviors[kind]); }
export function piFileAdapter(kind: FileKind): ToolAdapter {
  return { names: [kind], kind, matches: () => true, create: call => piFileReader(call, kind) };
}
