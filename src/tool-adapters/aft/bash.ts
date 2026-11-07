import { isAbsolute, resolve } from 'node:path';
import type { ReaderEstimateContext, ToolAdapter, ToolCallSnapshot } from '../contracts.ts';
import { piBashReader } from '../pi/bash.ts';
import { prepareAftBashService } from './service.ts';
import { resultDetails as data } from '../shared/result-details.ts';

const extendedArgs = ['description', 'workdir', 'content', 'path', 'file_path', 'filePath'] as const;
function exitCode(call: ToolCallSnapshot): number | undefined {
  const code = data(call).exit_code;
  return typeof code === 'number' && Number.isFinite(code) && Number.isInteger(code) ? code : undefined;
}
function taskId(call: ToolCallSnapshot): string | undefined {
  const value = data(call).task_id;
  return typeof value === 'string' && /^bash-[0-9a-f]{16}$/u.test(value) ? value : undefined;
}
function outputParts(call: ToolCallSnapshot): string[] {
  const parts = call.result?.content?.filter(part => part.type === 'text').map(part => part.text ?? '') ?? [];
  const task = taskId(call);
  if (!call.hasResult || call.partial || !task) return parts;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    let row: RegExpExecArray | undefined;
    for (const match of part.matchAll(/(^|\r\n|[\r\n])\[task (bash-[0-9a-f]{16})(?: \(job [^\s()[\]]+\))?\](?=\r\n|[\r\n]|$)/gu))
      if (match[2] === task) row = match;
    if (!row) continue;
    let end = row.index + row[0].length;
    if (!row[1] && end < part.length) end += part.startsWith('\r\n', end) ? 2 : 1;
    const text = part.slice(0, row.index) + part.slice(end);
    parts.splice(index, 1, ...(text ? [text] : []));
    break;
  }
  return parts;
}
function extraBytes(call: ToolCallSnapshot): number {
  let rows = 0, units = 0;
  const size = (text: string) => {
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10 || text.charCodeAt(index) === 13) rows++;
    return text.length;
  };
  for (const key of extendedArgs) if (key !== 'workdir' && typeof call.args[key] === 'string') units += size(call.args[key] as string);
  const details = data(call);
  for (const value of [details.diff, details.patch]) if (typeof value === 'string') units += size(value);
  if (Array.isArray(details.diagnostics)) for (const item of details.diagnostics)
    if (item && typeof item === 'object' && typeof item.message === 'string') { units += size(item.message); rows++; }
  return units * 6 + rows * 1024;
}
export function aftBashReader(call: ToolCallSnapshot) {
  const base = piBashReader(call);
  const failurePhase = () => exitCode(call) !== undefined ? 'execution' as const : base.failurePhase();
  return {
    ...base,
    service: (directory: string | undefined) => [call.expanded, call.args.description, call.args.workdir, directory, call.resultFailed,
      call.partial, call.resultFailed ? call.executionStarted : undefined, call.resultFailed ? call.argsComplete : undefined,
      exitCode(call), ...(call.result?.content?.flatMap(part => [part.type, part.text]) ?? [])],
    directory(cwd: string | undefined) {
      const workdir = call.args.workdir;
      if (typeof workdir !== 'string' || !workdir.length) return undefined;
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
      const resolved = resolve(cwd, workdir);
      return resolved === resolve(cwd) ? undefined : resolved;
    },
    estimateBytes: (context: ReaderEstimateContext) => base.estimateBytes(context) + extraBytes(call),
    prepareService: (directory: string | undefined) => prepareAftBashService({
      description: typeof call.args.description === 'string' ? call.args.description : undefined,
      outputParts: outputParts(call), final: call.hasResult && !call.partial, error: call.resultFailed,
      exitCode: exitCode(call), failurePhase: failurePhase(),
    }, directory),
    isComplete: (live: boolean) => call.argsComplete || !call.partial && call.result?.role === 'toolResult'
      || !live && !call.partial && call.resultFailed && failurePhase() === 'formation',
    failurePhase,
  };
}
export const aftBashAdapter: ToolAdapter = {
  names: ['bash'], kind: 'bash',
  // Result envelopes are candidates, not provenance: plain output is a compatible subset.
  matches: call => call.hasResult || extendedArgs.some(key => Object.hasOwn(call.args, key)),
  create: aftBashReader,
};
