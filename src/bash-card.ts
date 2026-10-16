import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { cardGeometry, frameRows } from "./card-frame.ts";

import { toolCardPaint, type CardTheme } from "./card-theme.ts";
import { blockText, terminalRows } from "./plain-text.ts";

interface BashPresentation {
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

/** Content policy is independent of both the host's tool class and the shared shell. */
export function renderBashCard(node: BashPresentation, directory: string | undefined, width: number, theme: CardTheme, outputPad = 1, commandRows?: readonly string[] | ((text: string) => readonly string[] | undefined)) {
  const geometry = cardGeometry(width, outputPad), available = geometry.contentWidth;
  if (!available) return { rows: [] as string[], geometry, expandable: false };
  const body: string[] = [];
  const styled = (text: string, role: ThemeColor) => terminalRows(text, available).map((row) => theme.fg(role, row));
  const description = typeof node.args.description === "string" ? blockText(node.args.description).replace(/\s+/gu, " ").trim() : "";
  if (description) body.push(...styled(`# ${description}`, "muted"));
  if (directory) body.push(...styled(`# Running in ${blockText(directory).replace(/[\n\t]/gu, " ")}`, "muted"));
  if (body.length) body.push("");
  // Current display is normalized once. The optional projector borrows colors,
  // never parser authority, and includes prompt and viewport-aware tab stops.
  const command = blockText(node.args.command as string);
  const projected = typeof commandRows === 'function' ? commandRows(command) : commandRows;
  if (projected) body.push(...projected);
  else command.split("\n").forEach((line, index) => {
    let prompt = index === 0 ? 2 : 0;
    for (const row of terminalRows(index === 0 ? `$ ${line}` : line, available)) {
      const count = Math.min(prompt, row.length);
      body.push((count ? theme.fg("dim", row.slice(0, count)) : "") + theme.fg("toolTitle", row.slice(count)));
      prompt -= count;
    }
  });
  const code = exitCode(node), final = !!node.result && !node.isPartial;
  const error = final && (node.result?.isError === true || (code !== undefined && code !== 0));
  const { rows: output, reminder, end } = resultRows(node, final);
  let first = 0, last = reminder;
  while (last > first && !output[last - 1].trim()) last--;
  // AFT does not persist its timeout reason. This is an approved display-only
  // exception, not producer detection or proof of process status: an identical
  // printed tail is indistinguishable. Code 124 alone never implies a timeout.
  const timeout = final && code === 124 && last >= 3 && output[last - 1] === "[exit code: 124]"
    && output[last - 2] === "[command timed out]" && !output[last - 3].trim();
  const fields = error ? [code !== undefined && code !== 0 ? `exit code: ${code}` : "",
    timeout ? "error: command timed out" : node.result?.isError === true
      ? bashFailurePhase(node) === 'formation' ? "error: incomplete tool call"
         : bashFailurePhase(node) === 'execution' ? "error: execution failed" : "error: tool call failed" : ""].filter(Boolean) : [];
  const footer = fields.length ? `[${fields.join("; ")}]` : "";
  // Remove at most one exact separated terminal block, before wrapping/cutoff.
  // Do not rescan a newly exposed suffix or remove either kind during streaming.
  if (timeout) last -= 2;
  else if (footer && code !== undefined && code !== 0 && last >= 2 && output[last - 1] === footer && !output[last - 2].trim()) last--;
  while (last > first && !output[last - 1].trim()) last--;
  while (first < last && !output[first].trim()) first++;
  const section = (first: number, last: number, role: ThemeColor) => {
    const rows: string[] = [], limit = node.expanded ? Infinity : 11;
    for (let index = first; index < last && rows.length < limit; index++)
      for (const row of terminalRows(output[index]!, available, limit - rows.length)) rows.push(row);
    const overflow = rows.length > 10, previewOverflow = overflow && !node.expanded;
    const displayed = node.expanded ? rows : rows.slice(0, 10);
    if (previewOverflow) while (displayed.length && !displayed[displayed.length - 1]!.trim()) displayed.pop();
    if (displayed.length || previewOverflow) body.push('');
    for (const row of displayed) body.push(theme.fg(role, row));
    // Pi's truncator inserts SGR resets even for plain text; style only afterwards.
    if (previewOverflow) body.push(theme.fg('dim', stripVTControlCharacters(truncateToWidth('… (Click to expand)', available))));
    return overflow || node.expanded && rows.length > 0;
  };
  const outputExpandable = section(first, last, 'toolOutput');
  if (footer) body.push('', ...styled(footer, 'error'));
  const reminderExpandable = section(reminder, end, 'muted');
  return { rows: frameRows(geometry, body, toolCardPaint(theme, error)), geometry, expandable: outputExpandable || reminderExpandable };
}
