import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from './limits.ts';

// Captured/codec application credit, not a V8/SDK/parser heap or RSS limit.
// UTF16 captures/replacements/request slices and the suffix codec buffer are
// separate from the frame family and explicitly funded decoded semantic data.
export function sourceReservation(facts: { captureUnits: number; replacementUnits: number; inputUnits: number;
  replacementBytes: number; frameBytes: number; decodedBytes: number }): number {
  for (const value of Object.values(facts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid source reservation');
  return 2 * (facts.captureUnits + facts.replacementUnits + facts.inputUnits) + facts.replacementBytes
    + 4 * facts.frameBytes + facts.decodedBytes + 32768 + 1024;
}

const fullFamily = sourceReservation({ captureUnits: HIGHLIGHT_LIMITS.sourceBytes, replacementUnits: HIGHLIGHT_LIMITS.sourceBytes,
  inputUnits: HIGHLIGHT_LIMITS.sourceBytes, replacementBytes: HIGHLIGHT_LIMITS.sourceBytes,
  frameBytes: HIGHLIGHT_LIMITS.dataWireBytes, decodedBytes: HIGHLIGHT_LIMITS.decodedBytes });
export const CONTROLLER_LIMITS = Object.freeze({ jobs: 2, transientBytes: 2 * fullFamily,
  bookkeepingBytes: OCCIPITAL_LIMITS.retainedBytes, restarts: 1 });

/** Admission only, never clipping: callers supply the actual finite parser input. */
export function sourceFits(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return false;
  let bytes = 0, lines = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 10 && ++lines > HIGHLIGHT_LIMITS.sourceLines) return false;
    if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > maxBytes) return false;
  }
  return lines + (text.length && !text.endsWith('\n') ? 1 : 0) <= HIGHLIGHT_LIMITS.sourceLines;
}
