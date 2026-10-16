import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { cardGeometry, frameRows } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";
import { blockText, terminalRows } from "./plain-text.ts";

export interface QueuedCard {
  rows: string[];
  bodyRows: number;
  ellipsis: string[];
}

/** One owner's prepared rows; screen height only selects a prefix, never reparses text. */
export function prepareQueuedCard(text: string, mode: "Steering" | "Follow-up", hint: string,
  width: number, theme: CardTheme, outputPad: number): QueuedCard {
  const geometry = cardGeometry(width, outputPad), available = geometry.contentWidth;
  const paint = { border: (value: string) => theme.fg("customMessageLabel", value),
    panel: (value: string) => theme.bg ? theme.bg("userMessageBg", value) : value };
  const body = blockText(text).split("\n").flatMap(line => terminalRows(line, available));
  const label = ` QUEUED · ${mode} `;
  const badge = (value: string) => theme.style && theme.colors?.customMessageLabel && theme.colors.userMessageBg
    ? theme.style(value, { bg: theme.colors.customMessageLabel, fg: theme.colors.userMessageBg })
    : theme.fg("customMessageLabel", `\x1b[7m${value}\x1b[27m`);
  const spans = [
    { text: label, paint: badge },
    ...(hint ? [
      { text: " ", paint: (value: string) => value },
      { text: "(", paint: (value: string) => theme.fg("dim", value) },
      { text: hint, paint: (value: string) => theme.fg("muted", value) },
      { text: ")", paint: (value: string) => theme.fg("dim", value) },
    ] : []),
  ];
  let offset = 0;
  const metadata = terminalRows(spans.map(span => span.text).join(""), available).map(row => {
    let start = 0, styled = "";
    for (const span of spans) {
      const first = Math.max(offset, start), last = Math.min(offset + row.length, start + span.text.length);
      if (last > first) styled += span.paint(span.text.slice(first - start, last - start));
      start += span.text.length;
    }
    offset += row.length;
    return styled;
  });
  const rows = frameRows(geometry, [...body.map(row => theme.fg("userMessageText", row)), "", ...metadata], paint);
  // At most five possible clipped endings. Prepare paint once, not on every
  // Working frame or height-only resize; these rows share the owner's lifetime.
  const ellipsis = body.slice(0, Math.min(5, body.length - 1)).map(row =>
    frameRows(geometry, [theme.fg("userMessageText", stripVTControlCharacters(truncateToWidth(row + "…", available, "…")))], paint)[1]!);
  return { rows, bodyRows: body.length, ellipsis };
}

/** A soft whole-block budget: all cards survive even when their minimum cannot fit. */
export function projectQueuedCards(cards: readonly QueuedCard[], screenRows: number): string[][] {
  const budget = Math.max(10, Math.floor(screenRows / 3));
  const shown = cards.map(card => card.bodyRows);
  // One outside row before every card, including Pi's existing leading spacer.
  let total = cards.reduce((sum, card) => sum + card.rows.length + 1, 0);
  for (let cap = 5; cap >= 1 && total > budget; cap--) {
    for (let index = 0; index < cards.length && total > budget; index++) {
      const next = Math.min(shown[index]!, cap);
      total -= shown[index]! - next; shown[index] = next;
    }
  }
  const blocks: string[][] = [];
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index]!, count = shown[index]!;
    const rows = index === 0 ? [] : [""]; // Pi's own spacer supplies the first outside row.
    rows.push(card.rows[0]!);
    for (let line = 0; line < count; line++) rows.push(line === count - 1 && count < card.bodyRows
      ? card.ellipsis[line]! : card.rows[line + 1]!);
    for (let line = card.bodyRows + 1; line < card.rows.length; line++) rows.push(card.rows[line]!);
    blocks.push(rows);
  }
  return blocks;
}
