import { indexedColor, rgbColor, styleTextWithAnsi, visibleWidth } from '@earendil-works/pi-tui';
import type { CardTheme } from '../card-theme.ts';
import { unpackStyle } from '../occipital/protocol.ts';

/** Current-source authority/coverage is supplied by the controller, not inferred
 * from a palette or ANSI. Its visitor includes only exact or proven stable bytes. */
export type RangeReader = (consume: (start: number, end: number, packedStyle: number) => void) => boolean;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
type Paint = number | 'prompt';

function styled(text: string, paint: Paint, theme: CardTheme, neutral: 'toolOutput' | 'toolTitle'): string {
  if (paint === 'prompt') return theme.fg('dim', text);
  const style = unpackStyle(paint);
  if ('role' in style) return theme.fg(style.role === 'plain' ? neutral : style.role, text);
  // Pi fallback alone may set the fourth local font bit; native wire decoding cannot.
  const attributes = { bold: !!(style.attributes & 1), underline: !!(style.attributes & 2), italic: !!(style.attributes & 4),
    dim: !!(paint & (8 << 24)) };
  // A terminal-default foreground is NOT Plain. Theme's concrete Color has no
  // default variant; the public ANSI style helper supports it without resetting
  // the enclosing card background or rewriting the user's Theme.
  if ('terminal_default' in style) return styleTextWithAnsi(text, '\x1b[39m', undefined, attributes);
  const fg = 'rgb' in style ? rgbColor(...style.rgb) : indexedColor(style.index);
  return theme.style ? theme.style(text, { fg, ...attributes }) : theme.fg(neutral, text);
}
export type HistoricalBashCoverage = { matchedBytes: number; styledBytes: number };
type Prefix = { text: string; matching: boolean; owns: boolean; matchedBytes: number; styledBytes: number };
function utf8Length(text: string, prefix?: Prefix, offset = 0): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const first = index, before = bytes, code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return NaN;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return NaN;
    else bytes += 3;
    if (prefix) {
      const matches = prefix.matching && prefix.text.charCodeAt(offset + first) === code
        && (index === first || prefix.text.charCodeAt(offset + index) === text.charCodeAt(index));
      if (first === 0) prefix.owns = matches;
      prefix.matching = matches;
      if (matches) prefix.matchedBytes += bytes - before;
    }
  }
  return bytes;
}

/** Terminal projection only: no classifier, request, source normalization or
 * full-source UTF8 buffer. First-scalar color owns an entire displayed grapheme.
 * Contiguous unmodified units are sliced as one span, not retained per glyph. */
function project(text: string, theme: CardTheme, read: RangeReader, commandWidth?: number, basis?: string, coverage?: HistoricalBashCoverage): string[] | undefined {
  const prefix: Prefix | undefined = basis === undefined ? undefined : { text: basis, matching: true, owns: false, matchedBytes: 0, styledBytes: 0 };
  const command = commandWidth !== undefined, neutral = command ? 'toolTitle' : 'toolOutput';
  const rows: string[] = [];
  let row: string[] = [], fragments: string[] = [], active: Paint | undefined;
  let rawStart: number | undefined, rawEnd = 0, columns = 0;
  const flushRaw = () => {
    if (rawStart !== undefined) fragments.push(text.slice(rawStart, rawEnd));
    rawStart = undefined;
  };
  const flushSpan = () => {
    flushRaw();
    if (fragments.length) row.push(styled(fragments.join(''), active!, theme, neutral));
    fragments = []; active = undefined;
  };
  const flushRow = () => { flushSpan(); rows.push(row.join('')); row = []; columns = 0; };
  const append = (unit: string, paint: Paint, index?: number) => {
    let size = visibleWidth(unit);
    if (command && size > commandWidth!) { unit = '�'; size = 1; index = undefined; }
    if (command && columns + size > commandWidth!) flushRow();
    if (active !== paint) { flushSpan(); active = paint; }
    if (index !== undefined) {
      if (rawStart === undefined) rawStart = index;
      else if (rawEnd !== index) { flushRaw(); rawStart = index; }
      rawEnd = index + unit.length;
    } else { flushRaw(); fragments.push(unit); }
    columns += size;
  };
  if (command) { append('$', 'prompt'); append(' ', 'prompt'); }
  const iterator = graphemes.segment(text)[Symbol.iterator]();
  let next = iterator.next(), byte = 0, covered = 0, invalid = false;
  const consume = (paint: number) => {
    const { segment, index } = next.value!;
    const bytes = utf8Length(segment, prefix, index);
    if (!Number.isFinite(bytes)) { invalid = true; return; }
    if (prefix && !prefix.owns) paint = 0;
    if (prefix && paint !== 0 && segment !== '\n') prefix.styledBytes += bytes;
    if (segment === '\n') flushRow();
    else if (segment === '\t') {
      const spaces = (command ? 8 : 4) - columns % (command ? 8 : 4);
      for (let index = 0; index < spaces; index++) append(' ', paint);
    } else append(segment, paint, index);
    byte += bytes; next = iterator.next();
  };
  const available = read((start, end, paint) => {
    if (invalid) return;
    // Canonical classifications are already decoded/validated by the controller.
    // Reject a mismatched reader as a whole rather than painting partial trust.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== covered || end <= start
      || !Number.isInteger(paint) || paint < 0 || paint > 0xffffffff || (paint >>> 30 === 0 && paint > 9)) {
      invalid = true; return;
    }
    covered = end;
    while (!next.done && byte < end && !invalid && (!prefix || prefix.matching)) consume(paint);
    if (!prefix && next.done && end > byte) invalid = true;
  });
  if (!available || invalid) return undefined;
  while (!next.done && !invalid) consume(0); // Remaining current graphemes have no selected historical style.
  if (invalid) return undefined;
  if (coverage && prefix) { coverage.matchedBytes = prefix.matchedBytes; coverage.styledBytes = prefix.styledBytes; }
  flushRow();
  return rows;
}

/** Unwrapped file rows; existing four-column logical stops precede card wrapping. */
export function paintFileSource(text: string, theme: CardTheme, ranges: RangeReader): string[] | undefined {
  return project(text, theme, ranges);
}
/** Eight-column command stops include the synthetic prompt and real soft wraps.
 * Description/cwd/output never enter either this source or its range reader. */
export function paintBashCommand(text: string, width: number, theme: CardTheme, ranges: RangeReader): string[] | undefined {
  if (width <= 0) return [];
  return project(text, theme, ranges, width);
}

/** Historical colors are presentation only. Scalar-prefix proof runs inside the
 * existing cold grapheme/byte walk; a current grapheme inherits its first scalar's style. */
export function paintHistoricalBashCommand(text: string, basis: string, width: number, theme: CardTheme, ranges: RangeReader, coverage?: HistoricalBashCoverage): string[] | undefined {
  if (width <= 0) return [];
  return project(text, theme, ranges, width, basis, coverage);
}
