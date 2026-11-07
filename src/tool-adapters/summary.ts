import { describeArgs } from '../summary-args.ts';
import { captureToolCall, createToolReader } from './registry.ts';

export function describeToolArgs(name: string, args: Record<string, unknown>, cwd?: string): string {
  const reader = createToolReader(captureToolCall({ name, id: '', args, partial: true,
    expanded: false, executionStarted: false, argsComplete: false }));
  return describeArgs(name, reader.summaryArgs(), cwd);
}
