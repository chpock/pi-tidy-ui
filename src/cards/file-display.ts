import { stripVTControlCharacters } from 'node:util';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { FileDisplayLine as DisplayLine } from './file-model.ts';

// Display-only maximum on each side of a change; metadata may supply fewer rows.
const DIFF_CONTEXT_LINES = 3;

/** Display-only cleaning. Preserve code whitespace; no file reads or proposal diffing. */
export function cleanFileDisplayText(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\p{Bidi_Control}/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2060-\u206f]/gu, '');
}

/** Project available context without changing source positions or joining separate hunks. */
export function contextRows<T extends DisplayLine>(lines: readonly T[]): (T | { kind: 'gap' })[] {
  const rows: (T | { kind: 'gap' })[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind !== ' ') { rows.push(line); index++; continue; }
    const start = index;
    while (index < lines.length) {
      const context = lines[index]!;
      if (context.kind !== ' ' || context.hunk !== line.hunk) break;
      index++;
    }
    const changed = (neighbor: DisplayLine | undefined) => neighbor && (neighbor.kind === '+' || neighbor.kind === '-') && neighbor.hunk === line.hunk;
    const before = changed(lines[start - 1]), after = changed(lines[index]);
    const count = index - start;
    const head = before ? Math.min(DIFF_CONTEXT_LINES, count) : 0;
    const tail = after ? Math.max(head, count - DIFF_CONTEXT_LINES) : count;
    for (let row = start; row < start + head; row++) rows.push(lines[row]!);
    if (before && after && tail > head) rows.push({ kind: 'gap' });
    for (let row = start + tail; row < index; row++) rows.push(lines[row]!);
  }
  let first = 0, last = rows.length;
  while (first < last && rows[first]!.kind === 'gap') first++;
  while (last > first && rows[last - 1]!.kind === 'gap') last--;
  return rows.slice(first, last);
}

export function fileDiagnosticText(input: readonly { readonly line?: number; readonly message: string }[]): string[] {
  return input.map(diagnostic => {
    const location = Number.isSafeInteger(diagnostic.line) && diagnostic.line! > 0 ? ` [${diagnostic.line}]` : '';
    return `Error${location}: ${cleanFileDisplayText(diagnostic.message).replace(/\s+/gu, ' ')}`;
  });
}
