import type { FileToolReader, ToolAdapter, ToolCardKind, ToolCallSnapshot, ToolReader, SavedToolResult } from './contracts.ts';
import { aftBashAdapter } from './aft/bash.ts';
import { aftReadAdapter } from './aft/read.ts';
import { aftFileAdapter } from './aft/file.ts';
import { piFileReader } from './pi/file.ts';
import { piBashReader } from './pi/bash.ts';

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

interface ToolCardDefinition {
  readonly kind: ToolCardKind;
  readonly formats: readonly ToolAdapter[];
  readonly stockReader: (call: ToolCallSnapshot) => ToolReader;
}

function fileCard(kind: FileToolReader['kind'], ...formats: ToolAdapter[]): [string, ToolCardDefinition] {
  return [kind, { kind, formats: [...formats, aftFileAdapter(kind)], stockReader: call => piFileReader(call, kind) }];
}

export const toolCards: ReadonlyMap<string, ToolCardDefinition> = new Map<string, ToolCardDefinition>([
  fileCard('read', aftReadAdapter()), fileCard('write'), fileCard('edit'),
  ['bash', { kind: 'bash', formats: [aftBashAdapter], stockReader: piBashReader }],
]);

export function isToolArgs(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Host events carry a name without arguments or a result. */
export function supportsToolName(name: string, kinds: readonly ToolCardKind[]): boolean {
  const card = toolCards.get(name);
  return card !== undefined && kinds.includes(card.kind);
}

export function createToolReader(call: ToolCallSnapshot): ToolReader | undefined {
  if (!isToolArgs(call.args)) return;
  const card = toolCards.get(call.name);
  if (!card) return;
  const format = card.formats.find(candidate => candidate.matches(call));
  return format ? format.create(call) : card.stockReader(call);
}
