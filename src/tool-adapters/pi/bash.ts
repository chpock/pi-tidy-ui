import { blockText } from '../../plain-text.ts';
import { prepareBashService } from '../../bash-card.ts';
import type { BashReaderBehavior } from '../shared/bash-reader.ts';
import { createBashReader } from '../shared/bash-reader.ts';
import { commandFooter } from '../shared/command-footer.ts';
import type { ReaderEstimateContext, ToolAdapter, ToolCallSnapshot } from '../contracts.ts';

function failurePhase(call: ToolCallSnapshot): 'formation' | 'execution' | undefined {
  if (call.executionStarted || call.result?.role === 'toolResult') return 'execution';
  return call.argsComplete ? undefined : 'formation';
}
function estimateBytes(call: ToolCallSnapshot, context: ReaderEstimateContext): number {
  let rows = 1;
  const size = (text: string) => {
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10 || text.charCodeAt(index) === 13) rows++;
    return text.length;
  };
  let units = (context.cwd?.length ?? 0) + (context.directory?.length ?? 0) + (context.language?.length ?? 0);
  if (typeof call.args.command === 'string') units += size(call.args.command);
  for (const part of call.result?.content ?? []) units += size(part.text ?? '');
  return 4096 + units * 6 + rows * 1024;
}
const behavior: BashReaderBehavior = {
  source: call => [call.args.command === null || (typeof call.args.command !== 'object' && typeof call.args.command !== 'function')
    ? call.args.command : typeof call.args.command],
  service: (call, directory) => [call.expanded, undefined, undefined, directory, call.resultFailed, call.partial,
    call.resultFailed ? call.executionStarted : undefined, call.resultFailed ? call.argsComplete : undefined,
    undefined, ...(call.result?.content?.flatMap(part => [part.type, part.text]) ?? [])],
  summaryArgs: call => call.args,
  language: () => 'bash',
  directory: () => undefined,
  estimateBytes,
  command: call => typeof call.args.command === 'string' ? blockText(call.args.command) : undefined,
  prepareService(call, directory) {
    const output = blockText((call.result?.content?.filter(part => part.type === 'text').map(part => part.text ?? '') ?? []).join('\n')).split('\n');
    let first = 0, last = output.length;
    while (last && !output[last - 1]!.trim()) last--;
    const end = last;
    while (first < last && !output[first]!.trim()) first++;
    const error = call.hasResult && !call.partial && call.resultFailed;
    const footer = commandFooter({ error, toolFailed: call.resultFailed, phase: failurePhase(call) });
    return prepareBashService({ output, first, last, reminder: end, end, footer, error }, directory);
  },
  hasCommand: call => typeof call.args.command === 'string',
  complete: (call, live) => call.argsComplete || !call.partial && call.result?.role === 'toolResult'
    || !live && !call.partial && call.resultFailed && failurePhase(call) === 'formation',
  failurePhase,
};
export function piBashReader(call: ToolCallSnapshot) { return createBashReader(call, behavior); }

export const piBashAdapter: ToolAdapter = {
  names: ['bash'], kind: 'bash', matches: () => true, create: piBashReader,
};
