import { HIGHLIGHT_LIMITS } from '../occipital/limits.ts';

/** UTF16 endpoint and UTF8 size without allocating or encoding the visible suffix.
 * LF terminates a logical line; a terminal LF does not add an empty extra line.
 * Unpaired surrogates cost the UTF8 replacement scalar's three bytes. */
export function highlightingPrefix(text: string, byteLimit: number): { end: number; bytes: number; lines: number; saturated: boolean } {
  let end = 0, bytes = 0, terminated = 0, tail = false;
  while (end < text.length && bytes < byteLimit && terminated < HIGHLIGHT_LIMITS.sourceLines) {
    const first = text.charCodeAt(end);
    const paired = first >= 0xd800 && first <= 0xdbff && end + 1 < text.length
      && text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff;
    const size = paired ? 4 : first < 0x80 ? 1 : first < 0x800 ? 2 : 3;
    if (bytes + size > byteLimit) return { end, bytes, lines: terminated + Number(tail), saturated: true };
    bytes += size; end += paired ? 2 : 1;
    if (first === 10) { terminated++; tail = false; } else tail = true;
  }
  return { end, bytes, lines: terminated + Number(tail),
    saturated: bytes === byteLimit || terminated === HIGHLIGHT_LIMITS.sourceLines };
}
