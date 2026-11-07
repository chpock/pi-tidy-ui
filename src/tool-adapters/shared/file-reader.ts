import type { PreparedFileCard } from '../../file-card.ts';
import type { FilePreviewMode } from '../../file-preview-state.ts';
import type { FileToolReader, PendingFileDetail, ReaderEstimateContext, ToolCallSnapshot, ToolDiagnosticsIdentity, FileDiagnostic, FileDetailSource } from '../contracts.ts';

export interface FileReaderBehavior {
  readonly kind: FileToolReader['kind'];
  path(call: ToolCallSnapshot): string | undefined;
  source(call: ToolCallSnapshot, mode: FilePreviewMode): readonly unknown[];
  diagnostics(call: ToolCallSnapshot, mode: FilePreviewMode): ToolDiagnosticsIdentity;
  diagnosticText(call: ToolCallSnapshot): readonly FileDiagnostic[];
  note(call: ToolCallSnapshot, view: Pick<PreparedFileCard['view'], 'label' | 'mode'>): string | undefined;
  service(call: ToolCallSnapshot, cwd: string | undefined, mode: FilePreviewMode): readonly unknown[];
  language(call: ToolCallSnapshot): string | undefined;
  summaryArgs(call: ToolCallSnapshot): Record<string, unknown>;
  estimateBytes(call: ToolCallSnapshot, context: ReaderEstimateContext): number;
  prepareFile(call: ToolCallSnapshot, mode: FilePreviewMode, logicalOnly: boolean): PreparedFileCard | undefined;
  pendingDetail(call: ToolCallSnapshot, mode: FilePreviewMode): PendingFileDetail;
}

export function createFileReader(call: ToolCallSnapshot, behavior: FileReaderBehavior): FileToolReader {
  const argsRef = call.args, resultRef = call.result;
  return {
    kind: behavior.kind,
    call,
    argsRef,
    resultRef,
    failed: call.resultFailed,
    succeeded: call.hasResult && !call.partial && !call.resultFailed,
    path: () => behavior.path(call),
    source: mode => behavior.source(call, mode),
    diagnostics: mode => behavior.diagnostics(call, mode),
    diagnosticText: () => behavior.diagnosticText(call),
    note: view => behavior.note(call, view),
    service: (cwd, mode) => behavior.service(call, cwd, mode),
    language: () => behavior.language(call),
    summaryArgs: () => behavior.summaryArgs(call),
    estimateBytes: context => behavior.estimateBytes(call, context),
    prepareFile: (mode, logicalOnly = false) => behavior.prepareFile(call, mode, logicalOnly),
    pendingDetail: mode => behavior.pendingDetail(call, mode),
    errorSources: function* (): IterableIterator<FileDetailSource> {
      for (const part of resultRef?.content ?? []) if (part.type === 'text' && typeof part.text === 'string')
        yield { prefix: '', text: part.text };
    },
  };
}
