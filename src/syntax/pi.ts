import type { RangeReader } from './paint.ts';

/** Synchronously visit each exact logical highlightCode row once, in index order.
 * Rows exclude LF, retain tabs, and include the final empty row after a final LF. */
export type PiRowReader = (consume: (index: number, line: string) => void) => boolean;
// Fourth local projection bit is Pi faint; the daemon wire keeps its three font bits.
const attributeMask = 15 << 24;

function validNeutral(style: number): boolean {
  if (!Number.isInteger(style) || style < 0 || style > 0xffffffff) return false;
  if (style === 0) return true;
  const kind = style >>> 30;
  const mask = kind === 1 ? 0x47ffffff : kind === 2 ? 0x870000ff : 0;
  return mask !== 0 && ((style & mask) >>> 0) === style;
}

/** Scalar UTF16 only; source preparation has already removed terminal controls.
 * Do not normalize, expand tabs, or substitute invalid text at this boundary. */
function logicalRows(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) count++;
    else if ((code < 32 && code !== 9) || (code >= 127 && code <= 159)) return 0;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return 0;
    } else if (code >= 0xdc00 && code <= 0xdfff) return 0;
  }
  return count;
}

/** Terminal projection, not classification: public Pi Theme.fg/highlightCode use
 * semicolon CSI SGR (38;2 RGB, 38;5 index, 39); Theme fonts use 1/2/3/4 and
 * 22/23/24. Also accept standard basic/bright colors and 0/empty reset. Remove
 * only background SGR (40–47, 100–107, 48;2/5, 49). Other controls/effects,
 * including inverse/strike and colon CSI, are not representable here.
 *
 * FG39 restores the caller's neutral color; SGR0 restores its complete style.
 * Neutral is Plain0 or a canonical RGB/index packed style, never terminal default.
 * Plain cannot encode fonts: callers must supply concrete neutral for glyphs
 * carrying bare attributes. No theme inference or dropped font attributes.
 *
 * All state is call-local, with one coalesced pending span and no source/range
 * arrays or buffers. Consumer callbacks are PROVISIONAL until true: a false
 * result invalidates every callback, as required by paint.ts. The caller owns
 * source/palette authority and any accepted result retention outside this reader.
 * Empty source succeeds without visiting rows; invalid source/neutral fails
 * before visiting rows. Reader creation does not inspect source or invoke Pi. */
export function piRangeReader(text: string, rows: PiRowReader, neutralStyle = 0,
  diagnostics?: { styleDirectives: boolean }): RangeReader {
  return consume => {
    if (!validNeutral(neutralStyle)) return false;
    const expectedRows = logicalRows(text);
    if (!expectedRows) return false;
    if (!text.length) return true;
    const neutralFg = (neutralStyle & ~attributeMask) >>> 0;
    const neutralAttributes = (neutralStyle >>> 24) & 7;
    let foreground = neutralFg, attributes = neutralAttributes;
    let source = 0, byte = 0, rowIndex = 0, invalid = false, visiting = true;
    let spanStart = 0, spanStyle: number | undefined;
    const flush = () => {
      if (spanStyle !== undefined && byte > spanStart) consume(spanStart, byte, spanStyle);
      spanStart = byte;
    };
    const append = (bytes: number): boolean => {
      if (foreground === 0 && attributes !== 0) return false;
      const style = (foreground | (attributes << 24)) >>> 0;
      if (spanStyle !== style) { flush(); spanStyle = style; }
      byte += bytes;
      return true;
    };
    const reset = () => { foreground = neutralFg; attributes = neutralAttributes; };
    const sgr = (line: string, start: number): number => {
      if (line[start + 1] !== '[') return -1;
      let at = start + 2, finished = false;
      if (line[at] === 'm') { reset(); return at + 1; }
      // No parameter array: only the current CSI number is retained.
      const parameter = (): number | undefined => {
        if (finished || !(line.charCodeAt(at) >= 48 && line.charCodeAt(at) <= 57)) return undefined;
        let value = 0;
        while (line.charCodeAt(at) >= 48 && line.charCodeAt(at) <= 57) {
          value = value * 10 + line.charCodeAt(at++) - 48;
          if (value > 255) return undefined;
        }
        if (line[at] === 'm') finished = true;
        else if (line[at] !== ';') return undefined;
        at++;
        return value;
      };
      while (!finished) {
        const code = parameter();
        if (code === undefined) return -1;
        if (code === 0) reset();
        else if (code === 1 || code === 2 || code === 3 || code === 4) {
          attributes |= code === 1 ? 1 : code === 2 ? 8 : code === 3 ? 4 : 2;
          if (diagnostics) diagnostics.styleDirectives = true;
        }
        else if (code === 22) attributes &= ~(1 | 8);
        else if (code === 23) attributes &= ~4;
        else if (code === 24) attributes &= ~2;
        else if (code === 39) foreground = neutralFg;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          foreground = ((2 << 30) | (code >= 90 ? code - 90 + 8 : code - 30)) >>> 0;
          if (diagnostics) diagnostics.styleDirectives = true;
        } else if (code === 38 || code === 48) {
          const mode = parameter();
          let color: number;
          if (mode === 5) {
            const index = parameter();
            if (index === undefined) return -1;
            color = ((2 << 30) | index) >>> 0;
          } else if (mode === 2) {
            const r = parameter(), g = parameter(), b = parameter();
            if (r === undefined || g === undefined || b === undefined) return -1;
            color = ((1 << 30) | (r << 16) | (g << 8) | b) >>> 0;
          } else return -1;
          if (code === 38) { foreground = color; if (diagnostics) diagnostics.styleDirectives = true; }
        } else if (!(code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107))) return -1;
      }
      return at;
    };
    let available: boolean;
    try {
      available = rows((index, line) => {
        // A retained/asynchronous callback must not emit after rows returns.
        if (!visiting || invalid) return;
        if (index !== rowIndex || rowIndex >= expectedRows || typeof line !== 'string') { invalid = true; return; }
        for (let at = 0; at < line.length;) {
          const code = line.codePointAt(at)!;
          if (code === 27) {
            at = sgr(line, at);
            if (at < 0) { invalid = true; return; }
            continue;
          }
          if ((code < 32 && code !== 9) || (code >= 127 && code <= 159)
            || (code >= 0xd800 && code <= 0xdfff) || code !== text.codePointAt(source)) { invalid = true; return; }
          if (!append(code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4)) { invalid = true; return; }
          const units = code > 65535 ? 2 : 1;
          at += units; source += units;
        }
        if (rowIndex < expectedRows - 1) {
          if (text.charCodeAt(source) !== 10 || !append(1)) { invalid = true; return; }
          source++;
        } else if (source !== text.length) { invalid = true; return; }
        rowIndex++;
      });
    } catch {
      return false;
    } finally {
      visiting = false;
    }
    if (available !== true || invalid || rowIndex !== expectedRows || source !== text.length) return false;
    flush();
    return true;
  };
}
