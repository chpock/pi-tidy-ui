import { blockText } from '../../plain-text.ts';
import { prepareBashService, type BashService } from '../../bash-card.ts';
import { commandFooter } from '../shared/command-footer.ts';

export interface AftBashServiceInput {
  readonly description?: string;
  readonly outputParts: readonly string[];
  readonly final: boolean;
  readonly error: boolean;
  readonly exitCode?: number;
  readonly failurePhase?: 'formation' | 'execution';
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

function resultRows(parts: readonly string[], final: boolean) {
  const normalized = blockText(parts.join('\n')), rows = normalized.split('\n');
  let end = rows.length;
  while (end && !rows[end - 1]!.trim()) end--;
  let reminder = end, cursor = end;
  if (!final || rows[end - 1] !== '</system-reminder>') return { rows, reminder, end };
  const boundaries = [0];
  if (parts.length <= 1) boundaries.push(rows.length);
  else {
    const chunks = parts.map((part, index) => blockText(part + (index < parts.length - 1 ? '\n' : '')));
    // Keep joined normalization authoritative when cross-part control sequences erase boundaries.
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

export function prepareAftBashService(input: AftBashServiceInput, directory?: string): BashService {
  const code = input.exitCode, final = input.final;
  const error = final && (input.error || (code !== undefined && code !== 0));
  const { rows: output, reminder, end } = resultRows(input.outputParts, final);
  let first = 0, last = reminder;
  while (last > first && !output[last - 1]!.trim()) last--;
  // Only the exact separated terminal timeout pair is a display exception.
  const timeout = final && code === 124 && last >= 3 && output[last - 1] === '[exit code: 124]'
    && output[last - 2] === '[command timed out]' && !output[last - 3]!.trim();
  const footer = commandFooter({ error, exitCode: code, toolFailed: input.error, phase: input.failurePhase, timedOut: timeout });
  if (timeout) last -= 2;
  else if (footer && code !== undefined && code !== 0 && last >= 2 && output[last - 1] === footer && !output[last - 2]!.trim()) last--;
  while (last > first && !output[last - 1]!.trim()) last--;
  while (first < last && !output[first]!.trim()) first++;
  return prepareBashService({ description: input.description, output, first, last, reminder, end, footer, error }, directory);
}
