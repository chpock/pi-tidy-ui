import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { cardGeometry, frameRows } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";

// Pi's user-message renderer places these zones on its two vertical padding rows.
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";

/** Reframe native Markdown, not its source: preserve transforms, syntax colors and links. */
export function renderUserCard<Owner extends object>(owner: Owner, width: number, padding: number, theme: CardTheme,
  renderNative: (this: Owner, width: number) => string[], outputPad = padding): { rows: string[] } {
  const geometry = cardGeometry(width, outputPad);
  if (!geometry.width) return { rows: [] };
  // The native Markdown removes its own horizontal padding before wrapping/transforming.
  const native = renderNative.call(owner, geometry.contentWidth + 2 * padding);
  if (!native.length) return { rows: [] };
  if (native.length < 3 || !native[0]!.startsWith(ZONE_START) || !native.at(-1)!.startsWith(ZONE_END))
    throw new Error("User-message terminal-zone/padding contract is incompatible");
  const content = native.slice(1, -1);
  // Image protocols cannot be moved like text. Impossible narrow native glyphs are
  // delegated too, rather than clipped to make the frame fit.
  if (content.some((row) => row.includes("\x1b_G") || row.includes("\x1b]1337;File=")))
    return { rows: renderNative.call(owner, width) };
  const body = content.map((row) => sliceByColumn(row, padding, Math.max(0, visibleWidth(row) - 2 * padding)));
  if (body.some((row) => visibleWidth(row) > geometry.contentWidth)) return { rows: renderNative.call(owner, width) };
  const rows = frameRows(geometry, body, {
    border: (text) => theme.fg("customMessageLabel", text),
    panel: (text) => theme.bg ? theme.bg("userMessageBg", text) : text,
  });
  rows[0] = ZONE_START + rows[0];
  rows[rows.length - 1] = ZONE_END + rows[rows.length - 1];
  return { rows };
}
