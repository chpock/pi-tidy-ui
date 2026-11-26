import { blockText } from '../../plain-text.ts';
import type { ToolCallSnapshot } from '../contracts.ts';
import { resultDetails } from '../shared/result-details.ts';

export function bashOutputFileMessage(call: ToolCallSnapshot): string | undefined {
  if (!call.hasResult || call.partial) return;
  const { truncation, fullOutputPath, fullOutputError } = resultDetails(call);
  if (!truncation || typeof truncation !== 'object' || Array.isArray(truncation)
    || (truncation as Record<string, unknown>).truncated !== true) return;
  const path = typeof fullOutputPath === 'string' && fullOutputPath.trim() ? fullOutputPath : undefined;
  const error = typeof fullOutputError === 'string' && fullOutputError.trim() ? fullOutputError : undefined;
  if (path && !error) return `Full output: ${path}`;
  if (error && !path) return `Could not save the full output: ${error}`;
}

const trailerStart = '\n\n[Showing ';
const range = /^(?:lines \d+-\d+ of \d+(?: \(\d+(?:\.\d+)?(?:B|KB|MB) limit\))?|last \d+(?:\.\d+)?(?:B|KB|MB) of line \d+ \(line is \d+(?:\.\d+)?(?:B|KB|MB)\))$/u;

export function separateBashOutputNotice(parts: string[], message: string | undefined, failed: boolean): string | undefined {
  if (!message) return;
  // Pi places its truncation trailer in the first text block, before an optional exit status.
  const text = parts[0], suffix = `. ${message}]`;
  if (text !== undefined) {
    const status = failed ? /\n\nCommand exited with code -?\d+$/u.exec(text) : null;
    const end = status?.index ?? text.length, rangeEnd = end - suffix.length;
    if (!text.endsWith(suffix, end)) return `[${blockText(message)}]`;
    const start = text.lastIndexOf(trailerStart, rangeEnd), rangeStart = start + trailerStart.length;
    if (start >= 0 && rangeEnd - rangeStart <= 128 && range.test(text.slice(rangeStart, rangeEnd))) {
      const notice = blockText(text.slice(start + 2, end));
      const remaining = text.slice(0, start) + text.slice(end);
      if (remaining) parts[0] = remaining;
      else parts.shift();
      return notice;
    }
  }
  return `[${blockText(message)}]`;
}
