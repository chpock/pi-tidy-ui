import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

/** Display only: keep indentation and joining marks, remove terminal/bidi controls. */
export function blockText(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\r\n?/gu, "\n")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function terminalRows(line: string, width: number, limit = Infinity): string[] {
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
