import type { ToolAdapter, ToolCardKind, ToolCallSnapshot, ToolReader, SavedToolResult } from './contracts.ts';
import { aftBashAdapter } from './aft/bash.ts';
import { aftReadAdapter } from './aft/read.ts';
import { aftFileAdapter } from './aft/file.ts';
import { piFileAdapter } from './pi/file.ts';
import { piBashAdapter } from './pi/bash.ts';

export interface ToolCallObservation {
  readonly name: string;
  readonly id: string;
  readonly args: Record<string, unknown>;
  readonly result?: SavedToolResult;
  readonly partial: boolean;
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
}

export function captureToolCall(observation: ToolCallObservation): ToolCallSnapshot {
  const result = observation.result;
  return {
    ...observation,
    resultFailed: result?.isError === true,
    hasResult: result !== undefined,
  };
}

export const toolAdapters: readonly ToolAdapter[] = [
  aftReadAdapter(),
  aftFileAdapter('read'),
  aftFileAdapter('write'),
  aftFileAdapter('edit'),
  aftBashAdapter,
  piFileAdapter('read'),
  piFileAdapter('write'),
  piFileAdapter('edit'),
  piBashAdapter,
];

function resolveAdapter(call: ToolCallSnapshot, adapters: readonly ToolAdapter[]): ToolAdapter | undefined {
  return adapters.find(candidate => candidate.names.includes(call.name) && candidate.matches(call));
}

export function toolCardKind(call: ToolCallSnapshot): ToolCardKind {
  return resolveAdapter(call, toolAdapters)?.kind ?? 'other';
}

/** Name-only candidates for host events which do not carry arguments or a result. */
export function supportsToolName(name: string, kinds: readonly ToolCardKind[]): boolean {
  return toolAdapters.some(adapter => adapter.names.includes(name) && kinds.includes(adapter.kind));
}

export function createToolReader(call: ToolCallSnapshot, adapters: readonly ToolAdapter[] = toolAdapters): ToolReader {
  const adapter = resolveAdapter(call, adapters);
  if (adapter) return adapter.create(call);
  return {
    kind: 'other', call, argsRef: call.args, resultRef: call.result,
    failed: call.resultFailed, succeeded: call.hasResult && !call.partial && !call.resultFailed,
    path: () => undefined, summaryArgs: () => call.args,
  };
}
