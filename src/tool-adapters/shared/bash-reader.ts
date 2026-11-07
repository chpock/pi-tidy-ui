import type { BashService } from '../../bash-card.ts';
import type { BashToolReader, ReaderEstimateContext, ToolCallSnapshot } from '../contracts.ts';

export interface BashReaderBehavior {
  source(call: ToolCallSnapshot): readonly unknown[];
  service(call: ToolCallSnapshot, directory: string | undefined): readonly unknown[];
  summaryArgs(call: ToolCallSnapshot): Record<string, unknown>;
  language(call: ToolCallSnapshot): string;
  directory(call: ToolCallSnapshot, cwd: string | undefined): string | undefined | null;
  estimateBytes(call: ToolCallSnapshot, context: ReaderEstimateContext): number;
  command(call: ToolCallSnapshot): string | undefined;
  prepareService(call: ToolCallSnapshot, directory: string | undefined): BashService;
  hasCommand(call: ToolCallSnapshot): boolean;
  complete(call: ToolCallSnapshot, live: boolean): boolean;
  failurePhase(call: ToolCallSnapshot): 'formation' | 'execution' | undefined;
}

export function createBashReader(call: ToolCallSnapshot, behavior: BashReaderBehavior): BashToolReader {
  const argsRef = call.args, resultRef = call.result;
  return {
    kind: 'bash',
    call,
    argsRef,
    resultRef,
    failed: call.resultFailed,
    succeeded: call.hasResult && !call.partial && !call.resultFailed,
    path: () => undefined,
    source: () => behavior.source(call),
    service: directory => behavior.service(call, directory),
    summaryArgs: () => behavior.summaryArgs(call),
    language: () => behavior.language(call),
    directory: cwd => behavior.directory(call, cwd),
    estimateBytes: context => behavior.estimateBytes(call, context),
    command: () => behavior.command(call),
    prepareService: directory => behavior.prepareService(call, directory),
    hasCommand: () => behavior.hasCommand(call),
    isComplete: live => behavior.complete(call, live),
    failurePhase: () => behavior.failurePhase(call),
  };
}
