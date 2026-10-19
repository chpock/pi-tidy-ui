import { blockText } from "./plain-text.ts";

export interface BashPresentation {
  args: Record<string, unknown>;
  expanded: boolean;
  isPartial: boolean;
  argsComplete?: boolean;
  executionStarted?: boolean;
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown; role?: unknown };
}

/** Logical parser input only: no prompt, synthetic metadata or execution output. */
export function bashCommandSource(args: Record<string, unknown>): string | undefined {
  return typeof args.command === "string" ? blockText(args.command) : undefined;
}
function exitCode(node: BashPresentation): number | undefined {
  const code = (node.result?.details as { exit_code?: unknown } | null | undefined)?.exit_code;
  return typeof code === "number" && Number.isFinite(code) && Number.isInteger(code) ? code : undefined;
}

/** Reconstructed SDK components default both lifecycle flags to false. A persisted
 * toolResult is positive execution-result evidence; those defaults must not turn it into a formation failure. */
export function bashFailurePhase(node: BashPresentation): 'formation' | 'execution' | undefined {
  if (node.executionStarted === true || node.result?.role === 'toolResult' || exitCode(node) !== undefined) return 'execution';
  return node.argsComplete === false ? 'formation' : undefined;
}

/** Return only a complete, nonnested reminder suffix within one content block. */
function reminderSuffix(rows: readonly string[], first: number, last: number): number {
  let depth = 0, nested = false, open = last, start = last, previousEnd = -1;
  for (let index = first; index < last; index++) {
    const row = rows[index];
    if (row === '<system-reminder>') {
      if (depth++ === 0) { open = index; nested = false; }
      else nested = true;
    } else if (row === '</system-reminder>') {
      if (depth === 0) { start = last; previousEnd = -1; }
      else if (--depth === 0) {
        if (nested || open !== first && open !== previousEnd && rows[open - 1]!.trim()) {
          start = last; previousEnd = -1;
        } else {
          if (start === last) start = open;
          previousEnd = index + 1;
        }
      }
    } else if (depth === 0 && start !== last && row!.trim()) {
      start = last; previousEnd = -1;
    }
  }
  return depth === 0 ? start : last;
}

function resultRows(node: BashPresentation, final: boolean) {
  const parts = node.result?.content.filter(part => part.type === 'text').map(part => part.text ?? '') ?? [];
  const normalized = blockText(parts.join('\n')), rows = normalized.split('\n');
  let end = rows.length;
  while (end && !rows[end - 1]!.trim()) end--;
  let reminder = end, cursor = end;
  if (!final || rows[end - 1] !== '</system-reminder>') return { rows, reminder, end };
  const boundaries = [0];
  if (parts.length <= 1) boundaries.push(rows.length);
  else {
    const chunks = parts.map((part, index) => blockText(part + (index < parts.length - 1 ? '\n' : '')));
    // Keep the original joined normalization (including CR + separator LF). A
    // cross-part control sequence can erase boundaries: then leave the tail ordinary.
    if (chunks.some((chunk, index) => index < chunks.length - 1 && !chunk.endsWith('\n'))
      || chunks.join('') !== normalized) return { rows, reminder, end };
    for (let index = 0; index < chunks.length; index++)
      boundaries.push(boundaries[index]! + chunks[index]!.split('\n').length - (index < chunks.length - 1 ? 1 : 0));
  }
  for (let block = boundaries.length - 2; block >= 0; block--) {
    const first = boundaries[block]!;
    let last = Math.min(boundaries[block + 1]!, cursor);
    while (last > first && !rows[last - 1]!.trim()) last--;
    if (last <= first) { cursor = first; continue; }
    const start = reminderSuffix(rows, first, last);
    if (start === last) break;
    reminder = start;
    let prefix = start;
    while (prefix > first && !rows[prefix - 1]!.trim()) prefix--;
    if (prefix !== first) break;
    cursor = first;
  }
  return { rows, reminder, end };
}

export interface BashService {
  readonly description: string; readonly heading: string; readonly output: readonly string[];
  readonly first: number; readonly last: number; readonly reminder: number; readonly end: number;
  readonly footer: string; readonly error: boolean;
}

/** Width-independent service policy shared by lifecycle preparation and frame rendering. */
export function prepareBashService(node: BashPresentation, directory?: string): BashService {
  const description = typeof node.args.description === 'string' ? blockText(node.args.description).replace(/\s+/gu, ' ').trim() : '';
  const heading = directory ? `# Running in ${blockText(directory).replace(/[\n\t]/gu, ' ')}` : '';
  const code = exitCode(node), final = !!node.result && !node.isPartial;
  const error = final && (node.result?.isError === true || (code !== undefined && code !== 0));
  const { rows: output, reminder, end } = resultRows(node, final);
  let first = 0, last = reminder;
  while (last > first && !output[last - 1]!.trim()) last--;
  // Only the exact separated terminal timeout pair is a display exception.
  const timeout = final && code === 124 && last >= 3 && output[last - 1] === '[exit code: 124]'
    && output[last - 2] === '[command timed out]' && !output[last - 3]!.trim();
  const fields = error ? [code !== undefined && code !== 0 ? `exit code: ${code}` : '',
    timeout ? 'error: command timed out' : node.result?.isError === true
      ? bashFailurePhase(node) === 'formation' ? 'error: incomplete tool call'
        : bashFailurePhase(node) === 'execution' ? 'error: execution failed' : 'error: tool call failed' : ''].filter(Boolean) : [];
  const footer = fields.length ? `[${fields.join('; ')}]` : '';
  if (timeout) last -= 2;
  else if (footer && code !== undefined && code !== 0 && last >= 2 && output[last - 1] === footer && !output[last - 2]!.trim()) last--;
  while (last > first && !output[last - 1]!.trim()) last--;
  while (first < last && !output[first]!.trim()) first++;
  return Object.freeze({ description, heading, output: Object.freeze(output), first, last, reminder, end, footer, error });
}
