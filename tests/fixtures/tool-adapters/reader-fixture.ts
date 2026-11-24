import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { BashToolReader, FileToolReader, SavedToolResult, ToolCardKind } from '../../../src/tool-adapters/contracts.ts';
import { captureToolCall, createToolReader, toolCards } from '../../../src/tool-adapters/registry.ts';

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

export function installTestToolNames(t: TestContext, names: Readonly<Record<string, ToolCardKind>>): void {
  for (const [name, kind] of Object.entries(names)) {
    const card = toolCards.get(kind);
    assert.ok(card && !toolCards.has(name));
    Map.prototype.set.call(toolCards, name, card);
    t.after(() => { Map.prototype.delete.call(toolCards, name); });
  }
}

function toolReaderFixture(input: ToolCallFixture, defaultName: string) {
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
  assert.ok(reader && reader.kind !== 'bash', 'expected a supported file tool reader');
  return reader;
}

export function bashToolReaderFixture(input: ToolCallFixture): BashToolReader {
  const reader = toolReaderFixture(input, 'bash');
  assert.ok(reader?.kind === 'bash', 'expected a Bash tool reader');
  return reader;
}

export function prepareFileToolCall(input: ToolCallFixture, logicalOnly = false, mode: 'full' | 'preview' = 'full') {
  return fileToolReaderFixture(input).prepareFile(mode, logicalOnly);
}
