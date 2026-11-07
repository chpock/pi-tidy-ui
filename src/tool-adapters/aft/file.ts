import { filePreviewText, prepareFileCard } from '../../file-card.ts';
import type { FileCardInput, PreparedFileCard } from '../../file-card.ts';
import type { FilePreviewMode } from '../../file-preview-state.ts';
import type { FileDiagnostic, FileToolReader, ToolAdapter, ToolCallSnapshot } from '../contracts.ts';
import { pendingPiFile, piFileReader } from '../pi/file.ts';
import { resultDetails as fileData } from '../shared/result-details.ts';

type FileKind = FileToolReader['kind'];
function diagnostics(call: ToolCallSnapshot, mode: FilePreviewMode): readonly unknown[] | boolean {
  const value = fileData(call).diagnostics;
  if (mode === 'preview') return Array.isArray(value) && value.length > 0;
  if (!Array.isArray(value)) return [];
  const identity: unknown[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const diagnostic = item as { severity?: unknown; message?: unknown; line?: unknown };
    if (diagnostic.severity !== 'error' || typeof diagnostic.message !== 'string') continue;
    identity.push(typeof diagnostic.line === 'number' && Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? diagnostic.line : undefined,
      diagnostic.message);
  }
  return identity;
}
function diagnosticText(call: ToolCallSnapshot): readonly FileDiagnostic[] {
  const value = fileData(call).diagnostics;
  if (!Array.isArray(value)) return [];
  const records: FileDiagnostic[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const diagnostic = item as { severity?: unknown; message?: unknown; line?: unknown };
    if (diagnostic.severity !== 'error' || typeof diagnostic.message !== 'string') continue;
    records.push({ ...(typeof diagnostic.line === 'number' && Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0
      ? { line: diagnostic.line } : {}), message: diagnostic.message });
  }
  return records;
}
function selectedSource(call: ToolCallSnapshot, kind: FileKind) {
  const data = fileData(call), args = call.args;
  if (kind === 'write' && data.truncated === true) return { type: 'content', value: args.content } as const;
  if (data.patch !== undefined) return { type: 'patch', value: data.patch } as const;
  if (data.diff !== undefined) return { type: 'diff', value: data.diff } as const;
  return kind === 'write' ? { type: 'content', value: args.content } as const : { type: 'newText', value: args.newText } as const;
}
function source(base: FileToolReader, call: ToolCallSnapshot, kind: FileKind, mode: FilePreviewMode): readonly unknown[] {
  if (kind === 'read') return base.source(mode);
  const data = fileData(call), selected = selectedSource(call, kind);
  const text = typeof selected.value === 'string' ? selected.value : undefined;
  const bounded = text === undefined ? undefined : mode === 'preview' ? filePreviewText(text) : { text, omitted: false };
  return [kind, mode, base.path(), selected.type, bounded?.text, bounded?.omitted,
    mode === 'full' ? call.args.content : undefined, data.truncated === true, data.noOp === true, call.partial, call.resultFailed];
}
function note(call: ToolCallSnapshot, kind: FileKind, view: Pick<PreparedFileCard['view'], 'label' | 'mode'>): string | undefined {
  if (kind !== 'write' || !call.hasResult || call.partial || call.resultFailed || view.label !== 'Wrote' || view.mode !== 'code') return undefined;
  const data = fileData(call);
  return data.truncated === true ? 'Diff truncated by tool; showing supplied content.' : data.noOp === true ? 'No changes.' : undefined;
}
function diffFormat(value: unknown, mode: FilePreviewMode): 'unified' | 'numbered' {
  if (typeof value !== 'string') return 'numbered';
  const text = mode === 'preview' ? filePreviewText(value).text : value;
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(text) ? 'unified' : 'numbered';
}
function prepare(base: FileToolReader, call: ToolCallSnapshot, kind: FileKind, mode: FilePreviewMode, logicalOnly: boolean) {
  if (kind === 'read' || !call.hasResult || call.partial || call.resultFailed) return base.prepareFile(mode, logicalOnly);
  const path = base.path();
  if (!path) return undefined;
  const data = fileData(call), selected = selectedSource(call, kind);
  let saved: FileCardInput['saved'];
  if (selected.type === 'patch') saved = { format: 'unified', value: selected.value };
  else if (selected.type === 'diff') saved = { format: diffFormat(selected.value, mode), value: selected.value };
  return prepareFileCard({ kind, path, complete: call.hasResult && !call.partial, failed: call.resultFailed, viewMode: mode,
    content: call.args.content, saved, truncated: data.truncated === true, noOp: data.noOp === true,
    note: note(call, kind, { label: 'Wrote', mode: 'code' }) }, logicalOnly);
}
export function aftFileReader(call: ToolCallSnapshot, kind: FileKind): FileToolReader {
  const base = piFileReader(call, kind);
  return {
    ...base,
    source: mode => source(base, call, kind, mode),
    diagnostics: mode => diagnostics(call, mode),
    diagnosticText: () => diagnosticText(call),
    note: view => note(call, kind, view),
    estimateBytes(context) {
      const data = fileData(call);
      let units = 0, rows = 0;
      const size = (text: string) => {
        for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10 || text.charCodeAt(index) === 13) rows++;
        return text.length;
      };
      for (const value of [kind === 'edit' ? undefined : data.diff, data.patch]) if (typeof value === 'string')
        units += size(context.mode === 'preview' ? filePreviewText(value).text : value);
      if (Array.isArray(data.diagnostics)) {
        if (context.mode === 'preview') { if (data.diagnostics.length) { units += 64; rows++; } }
        else for (const item of data.diagnostics) if (item && typeof item === 'object' && typeof item.message === 'string') {
          units += size(item.message); rows++;
        }
      }
      return base.estimateBytes(context) + units * 6 + rows * 1024;
    },
    prepareFile: (mode, logicalOnly = false) => prepare(base, call, kind, mode, logicalOnly),
    pendingDetail: mode => !call.partial && call.resultFailed ? base.pendingDetail(mode)
      : pendingPiFile(call, kind, mode, kind === 'edit' && Array.isArray(call.args.edits) ? call.args.edits : undefined),
  };
}
export function aftFileAdapter(kind: FileKind): ToolAdapter {
  return {
    names: [kind], kind,
    matches(call) {
      const data = fileData(call);
      return ['diff', 'patch', 'truncated', 'noOp', 'diagnostics'].some(key => Object.hasOwn(data, key))
        || kind === 'edit' && Object.hasOwn(call.args, 'edits');
    },
    create: call => aftFileReader(call, kind),
  };
}
