import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { cardGeometry, frameRows } from "./card-frame.ts";

import { toolCardPaint, type CardTheme } from "./card-theme.ts";

interface BashPresentation {
  args: Record<string, unknown>;
  expanded: boolean;
  isPartial: boolean;
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown };
}

/** Display only: keep indentation and joining marks, remove terminal/bidi controls. */
function blockText(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\r\n?/gu, "\n")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function terminalRows(line: string, width: number, limit = Infinity): string[] {
  const rows: string[] = [];
  let row = "", columns = 0;
  function append(segment: string) {
    let size = visibleWidth(segment);
    if (size > width) { segment = "�"; size = 1; }
    if (columns + size > width) {
      rows.push(row); row = ""; columns = 0;
      if (rows.length >= limit) return false;
    }
    row += segment; columns += size; return true;
  }
  for (const { segment } of graphemes.segment(line)) {
    if (segment === "\t") {
      const spaces = 8 - columns % 8;
      for (let index = 0; index < spaces; index++) if (!append(" ")) return rows;
    } else if (!append(segment)) return rows;
  }
  rows.push(row);
  return rows;
}
function exitCode(node: BashPresentation): number | undefined {
  const code = (node.result?.details as { exit_code?: unknown } | null | undefined)?.exit_code;
  return typeof code === "number" && Number.isFinite(code) && Number.isInteger(code) ? code : undefined;
}

/** Content policy is independent of both the host's tool class and the shared shell. */
export function renderBashCard(node: BashPresentation, directory: string | undefined, width: number, theme: CardTheme, outputPad = 1) {
  const geometry = cardGeometry(width, outputPad), available = geometry.contentWidth;
  if (!available) return { rows: [] as string[], geometry, expandable: false };
  const body: string[] = [];
  const styled = (text: string, role: ThemeColor) => terminalRows(text, available).map((row) => theme.fg(role, row));
  const description = typeof node.args.description === "string" ? blockText(node.args.description).replace(/\s+/gu, " ").trim() : "";
  if (description) body.push(...styled(`# ${description}`, "muted"));
  if (directory) body.push(...styled(`# Running in ${blockText(directory).replace(/[\n\t]/gu, " ")}`, "muted"));
  if (body.length) body.push("");
  blockText(node.args.command as string).split("\n").forEach((line, index) => {
    let prompt = index === 0 ? 2 : 0;
    for (const row of terminalRows(index === 0 ? `$ ${line}` : line, available)) {
      const count = Math.min(prompt, row.length);
      body.push((count ? theme.fg("dim", row.slice(0, count)) : "") + theme.fg("toolTitle", row.slice(count)));
      prompt -= count;
    }
  });
  const code = exitCode(node), final = !!node.result && !node.isPartial;
  const error = final && (node.result?.isError === true || (code !== undefined && code !== 0));
  const output = blockText(node.result?.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "").split("\n");
  let first = 0, last = output.length;
  while (last > first && !output[last - 1].trim()) last--;
  // AFT does not persist its timeout reason. This is an approved display-only
  // exception, not producer detection or proof of process status: an identical
  // printed tail is indistinguishable. Code 124 alone never implies a timeout.
  const timeout = final && code === 124 && last >= 3 && output[last - 1] === "[exit code: 124]"
    && output[last - 2] === "[command timed out]" && !output[last - 3].trim();
  const fields = error ? [code !== undefined && code !== 0 ? `exit code: ${code}` : "",
    timeout ? "error: command timed out" : node.result?.isError === true ? "error: execution failed" : ""].filter(Boolean) : [];
  const footer = fields.length ? `[${fields.join("; ")}]` : "";
  // Remove at most one exact separated terminal block, before wrapping/cutoff.
  // Do not rescan a newly exposed suffix or remove either kind during streaming.
  if (timeout) last -= 2;
  else if (footer && code !== undefined && code !== 0 && last >= 2 && output[last - 1] === footer && !output[last - 2].trim()) last--;
  while (last > first && !output[last - 1].trim()) last--;
  while (first < last && !output[first].trim()) first++;
  const outputRows: string[] = [], limit = node.expanded ? Infinity : 11;
  for (let index = first; index < last && outputRows.length < limit; index++)
    outputRows.push(...terminalRows(output[index], available, limit - outputRows.length));
  const overflow = outputRows.length > 10;
  const expandable = overflow || (node.expanded && outputRows.length > 0);
  const previewOverflow = overflow && !node.expanded;
  const displayed = node.expanded ? outputRows : outputRows.slice(0, 10);
  if (previewOverflow) while (displayed.length && !displayed[displayed.length - 1].trim()) displayed.pop();
  if (displayed.length || previewOverflow) body.push("");
  body.push(...displayed.map((row) => theme.fg("toolOutput", row)));
  // Pi's truncator inserts full SGR resets even for plain text; keep this
  // synthetic hint plain until styling, so it cannot reset the enclosing panel.
  if (previewOverflow) body.push(theme.fg("dim", stripVTControlCharacters(truncateToWidth("… (Click to expand)", available))));
  if (footer) body.push("", ...styled(footer, "error"));
  return { rows: frameRows(geometry, body, toolCardPaint(theme, error)), geometry, expandable };
}
