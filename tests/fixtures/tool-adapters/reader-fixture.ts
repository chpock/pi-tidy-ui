import type { BashToolReader, FileToolReader, SavedToolResult, ToolReader } from '../../../src/tool-adapters/contracts.ts';
import { captureToolCall, createToolReader } from '../../../src/tool-adapters/registry.ts';

export interface ToolCallFixture {
  readonly name?: string;
  readonly toolName?: string;
  readonly id?: string;
  readonly args?: Record<string, unknown>;
  readonly result?: SavedToolResult;
  readonly partial?: boolean;
  readonly isPartial?: boolean;
  readonly expanded?: boolean;
  readonly executionStarted?: boolean;
  readonly argsComplete?: boolean;
}

export function toolReaderFixture(input: ToolCallFixture, defaultName = 'other'): ToolReader {
  return createToolReader(captureToolCall({
    name: input.name ?? input.toolName ?? defaultName,
    id: input.id ?? 'test-tool-call',
    args: input.args ?? {},
    result: input.result,
    partial: input.partial ?? input.isPartial ?? false,
    expanded: input.expanded ?? false,
    executionStarted: input.executionStarted ?? false,
    argsComplete: input.argsComplete ?? true,
  }));
}

export function fileToolReaderFixture(input: ToolCallFixture, defaultName = 'edit'): FileToolReader {
  const reader = toolReaderFixture(input, defaultName);
  if (reader.kind === 'read' || reader.kind === 'write' || reader.kind === 'edit') return reader;
  throw new TypeError(`Expected a file tool reader, got ${reader.kind}`);
}

export function bashToolReaderFixture(input: ToolCallFixture): BashToolReader {
  const reader = toolReaderFixture(input, 'bash');
  if (reader.kind === 'bash') return reader;
  throw new TypeError(`Expected a Bash tool reader, got ${reader.kind}`);
}

export function prepareFileToolCall(input: ToolCallFixture, logicalOnly = false, mode: 'full' | 'preview' = 'full') {
  return fileToolReaderFixture(input).prepareFile(mode, logicalOnly);
}
