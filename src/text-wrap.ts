import { visibleWidth } from '@earendil-works/pi-tui';

export const WrapFlag = Object.freeze({ Whitespace: 1, BreakAfter: 8, Cjk: 16, Preferred: 32 } as const);
const cjk = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const separators = new Set(['/', '\\', '.', '-', '_', ':', ',', ';', '?', '!', '&', '=', '+', '@', '#', '%']);
const lookback = 20;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Classify whole graphemes once; callers may exclude context-sensitive cuts. */
export function wrapFlags(segment: string): number {
  return (segment === ' ' ? WrapFlag.Whitespace : 0) | (cjk.test(segment) ? WrapFlag.Cjk : 0)
    | (separators.has(segment) ? WrapFlag.Preferred : 0);
}
export interface WrapUnits {
  readonly length: number;
  width(index: number): number;
  flags(index: number): number;
}
function boundary(previous: number, next: number): boolean {
  return !!((previous ^ next) & WrapFlag.Whitespace) || !!((previous | next) & WrapFlag.Cjk)
    || !!(previous & WrapFlag.BreakAfter);
}
function fragment(units: WrapUnits, first: number): { end: number; cells: number } {
  let end = first + 1, cells = units.width(first);
  while (end < units.length && !boundary(units.flags(end - 1), units.flags(end))) cells += units.width(end++);
  return { end, cells };
}
function cut(units: WrapUnits, first: number, end: number, available: number): { end: number; cells: number } {
  let hard = first, cells = 0;
  while (hard < end && cells + units.width(hard) <= available) cells += units.width(hard++);
  if (hard === first || hard === end) return { end: hard, cells };
  let filled = cells;
  for (let candidate = hard; candidate > first && hard - candidate <= lookback; candidate--) {
    if (filled * 2 < available) break;
    if (units.flags(candidate - 1) & WrapFlag.Preferred) return { end: candidate, cells: filled };
    filled -= units.width(candidate - 1);
  }
  return { end: hard, cells };
}

type Emit = (first: number, end: number, cells: number) => void | boolean;
interface Row { first: number; end: number; cells: number; contentCells: number }
function flush(row: Row, emit: Emit): boolean {
  const keepGoing = row.first < 0 || row.end <= row.first || emit(row.first, row.end, row.contentCells) !== false;
  row.first = -1; row.end = 0; row.cells = 0; row.contentCells = 0;
  return keepGoing;
}
function append(row: Row, first: number, end: number, cells: number, whitespace: boolean): void {
  if (row.first < 0) row.first = first;
  row.cells += cells;
  if (!whitespace) { row.end = end; row.contentCells = row.cells; }
}
function fillOversized(units: WrapUnits, first: number, end: number, width: number, row: Row, emit: Emit): boolean {
  for (let from = first; from < end;) {
    let next = cut(units, from, end, width - row.cells);
    if (next.end === from) {
      if (row.first >= 0) { if (!flush(row, emit)) return false; continue; }
      next = { end: from + 1, cells: units.width(from) };
    }
    append(row, from, next.end, next.cells, false); from = next.end;
    if (from < end && !flush(row, emit)) return false;
  }
  return true;
}
function placeFitting(first: number, part: { end: number; cells: number }, whitespace: boolean, width: number, row: Row, emit: Emit): boolean {
  if (row.cells + part.cells > width && !flush(row, emit)) return false;
  if (row.first >= 0 || !whitespace) append(row, first, part.end, part.cells, whitespace);
  return true;
}

/** Emit source-unit intervals without measuring, slicing or retaining the input.
 * False from the synchronous visitor stops at that complete row boundary. */
export function wrapUnits(units: WrapUnits, width: number, emit: Emit): void {
  if (!width) return;
  const row: Row = { first: -1, end: 0, cells: 0, contentCells: 0 };
  for (let token = 0; token < units.length;) {
    const part = fragment(units, token), whitespace = !!(units.flags(token) & WrapFlag.Whitespace);
    const placed = part.cells > width && !whitespace
      ? fillOversized(units, token, part.end, width, row, emit)
      : placeFitting(token, part, whitespace, width, row, emit);
    if (!placed) return;
    token = part.end;
  }
  flush(row, emit);
}

export interface WrapTextOptions {
  json?: boolean;
  parameterStart?: number;
  parameterLength?: number;
  wide?: 'preserve' | 'replace';
}
interface EscapeState { quoted: boolean; end: number }
interface TextUnit { segment: string; start: number; end: number; width: number; flags: number }
function scanEscapes(text: string, first: number, end: number, state: EscapeState): void {
  for (let position = first; position < end; position++) {
    if (position < state.end) continue;
    if (text[position] === '"') state.quoted = !state.quoted;
    else if (state.quoted && text[position] === '\\') {
      const escape = /^\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/u.exec(text.slice(position, position + 6));
      if (escape) state.end = position + escape[0].length;
    }
  }
}
function textFlags(text: string, segment: string, index: number, parameterStart: number, parameterEnd: number, state?: EscapeState): number {
  let flags = wrapFlags(segment);
  if (state) {
    const end = index + segment.length;
    scanEscapes(text, index, end, state);
    if (end < state.end) flags &= ~WrapFlag.Preferred;
  }
  if (segment === ',' && index >= parameterStart && index < parameterEnd) flags |= WrapFlag.BreakAfter;
  return flags;
}
function textUnits(text: string, width: number, options: WrapTextOptions): TextUnit[] {
  const units: TextUnit[] = [], replace = options.wide === 'replace';
  const parameterStart = options.parameterStart ?? -1, parameterEnd = parameterStart + (options.parameterLength ?? 0);
  const state = options.json ? { quoted: false, end: 0 } : undefined;
  for (const { segment, index } of graphemes.segment(text)) {
    const size = visibleWidth(segment);
    units.push({ segment: replace && size > width ? '�' : segment, start: index, end: index + segment.length,
      width: replace ? Math.min(size, width) : size, flags: textFlags(text, segment, index, parameterStart, parameterEnd, state) });
  }
  return units;
}
/** String adapter for callers without retained measurements. */
export function wrapText(text: string, width: number, options: WrapTextOptions = {}): string[] {
  if (!Number.isSafeInteger(width) || width < 0) throw new Error('invalid text wrap width');
  if (!width) return [];
  const units = textUnits(text, width, options), rows: string[] = [];
  wrapUnits({ length: units.length, width: i => units[i]!.width, flags: i => units[i]!.flags }, width, (first, end) => {
    if (options.wide === 'replace') rows.push(units.slice(first, end).map(unit => unit.segment).join(''));
    else rows.push(text.slice(units[first]!.start, units[end - 1]!.end));
  });
  return rows;
}
