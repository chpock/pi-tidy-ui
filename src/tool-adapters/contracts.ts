import type { BashService } from '../bash-card.ts';
import type { PreparedFileCard } from '../file-card.ts';
import type { FilePreviewMode } from '../file-preview-state.ts';

export type ToolCardKind = 'read' | 'write' | 'edit' | 'bash' | 'other';

export interface SavedToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly role?: unknown;
}

export interface ToolCallSnapshot {
  readonly name: string;
  readonly id: string;
  readonly args: Record<string, unknown>;
  readonly result?: SavedToolResult;
  readonly partial: boolean;
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
  readonly resultFailed: boolean;
  readonly hasResult: boolean;
}

export type ToolDiagnosticsIdentity = readonly unknown[] | boolean;
export interface FileDiagnostic {
  readonly line?: number;
  readonly message: string;
}

export interface FileDetailSource {
  readonly prefix: string;
  readonly text: string;
}

export interface PendingFileDetail {
  readonly text: string;
  readonly omitted: boolean;
  readonly error: boolean;
  readonly pending: boolean;
}

export interface ReaderEstimateContext {
  readonly mode?: FilePreviewMode;
  readonly cwd?: string;
  readonly directory?: string;
  readonly language?: string;
}

export interface FileToolReader {
  readonly kind: 'read' | 'write' | 'edit';
  readonly call: ToolCallSnapshot;
  readonly argsRef: Record<string, unknown>;
  readonly resultRef?: SavedToolResult;
  readonly failed: boolean;
  readonly succeeded: boolean;
  path(): string | undefined;
  source(mode: FilePreviewMode): readonly unknown[];
  diagnostics(mode: FilePreviewMode): ToolDiagnosticsIdentity;
  diagnosticText(): readonly FileDiagnostic[];
  note(view: Pick<PreparedFileCard['view'], 'label' | 'mode'>): string | undefined;
  service(cwd: string | undefined, mode: FilePreviewMode): readonly unknown[];
  language(): string | undefined;
  summaryArgs(): Record<string, unknown>;
  estimateBytes(context: ReaderEstimateContext): number;
  prepareFile(mode: FilePreviewMode, logicalOnly?: boolean): PreparedFileCard | undefined;
  pendingDetail(mode: FilePreviewMode): PendingFileDetail;
  errorSources(): Iterable<FileDetailSource>;
}

export interface BashToolReader {
  readonly kind: 'bash';
  readonly call: ToolCallSnapshot;
  readonly argsRef: Record<string, unknown>;
  readonly resultRef?: SavedToolResult;
  readonly failed: boolean;
  readonly succeeded: boolean;
  path(): undefined;
  source(): readonly unknown[];
  service(directory: string | undefined): readonly unknown[];
  summaryArgs(): Record<string, unknown>;
  language(): string;
  directory(cwd: string | undefined): string | undefined | null;
  estimateBytes(context: ReaderEstimateContext): number;
  command(): string | undefined;
  prepareService(directory: string | undefined): BashService;
  hasCommand(): boolean;
  isComplete(live: boolean): boolean;
  failurePhase(): 'formation' | 'execution' | undefined;
}

export interface GenericToolReader {
  readonly kind: 'other';
  readonly call: ToolCallSnapshot;
  readonly argsRef: Record<string, unknown>;
  readonly resultRef?: SavedToolResult;
  readonly failed: boolean;
  readonly succeeded: boolean;
  path(): undefined;
  summaryArgs(): Record<string, unknown>;
}

export type ToolReader = FileToolReader | BashToolReader | GenericToolReader;

export interface ToolAdapter {
  readonly names: readonly string[];
  readonly kind: Exclude<ToolCardKind, 'other'>;
  matches(call: ToolCallSnapshot): boolean;
  create(call: ToolCallSnapshot): FileToolReader | BashToolReader;
}
