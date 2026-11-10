import { visibleWidth } from '@earendil-works/pi-tui';
import { shebangLanguage } from './shebang-language.ts';
import type { FileCardInput, FileLogicalLine as DiffLine, FileView, SourceFileView, PreparedFileCard } from './file-model.ts';
import { fileSources } from './file-sources.ts';
import { cleanFileDisplayText as clean } from './file-display.ts';
export const FILE_PREVIEW_MAX_UNITS = 8192;
export const FILE_PREVIEW_MAX_ROWS = 10;

function tabText(text: string): string {
  if (!text.includes("\t")) return text;
  let column = 0, output = "";
  for (const { segment } of segments.segment(text)) {
    const value = segment === "\t" ? " ".repeat(4 - column % 4) : segment;
    output += value; column += visibleWidth(value);
  }
  return output;
}
function sourceText(value: string, logicalOnly = false): { text: string; logical: string } {
  const logical = clean(value);
  return { logical, text: logicalOnly ? logical : tabText(logical) };
}
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const validNumber = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Stream source rows; validation-only callers need no temporary array of the whole diff. */
export function* sourceRows(diff: string, trimFinalNewline = false, maxRows = Number.POSITIVE_INFINITY): Generator<string> {
  const text = diff.replace(/\r\n?/gu, "\n");
  const length = text.length - (trimFinalNewline && text.endsWith("\n") ? 1 : 0);
  let start = 0, rows = 0;
  do {
    if (rows++ >= maxRows) return;
    const newline = text.indexOf("\n", start), end = newline < 0 ? length : Math.min(newline, length);
    yield text.slice(start, end); start = end + 1;
  } while (start <= length);
}

/** Numbered context uses old-file coordinates; the unified projection uses new-file coordinates. */
function numberedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">, logicalOnly = false, maxRows = Number.POSITIVE_INFINITY): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let delta = 0;
  for (const row of sourceRows(diff, false, maxRows)) {
    if (/^ +\.\.\.$/u.test(row)) { if (content) result.push({ kind: "gap" }); continue; }
    const match = /^([ +\-]) *(\d+) (.*)$/u.exec(row);
    if (!match) return undefined;
    const kind = match[1] as " " | "+" | "-", number = Number(match[2]);
    if (!validNumber(number) || number < 1 || (kind === " " && (!validNumber(number + delta) || number + delta < 1))) return undefined;
    kinds?.add(kind);
    if (content) {
      const old = kind !== "+" ? number : undefined, next = kind === " " ? number + delta : kind === "+" ? number : undefined;
      const line = match[3]!;
      const candidate = old === 1 || next === 1 ? shebangLanguage(line) : undefined;
      result.push({ kind, ...sourceText(line, logicalOnly), old, next, ...(candidate ? { languageHint: candidate } : {}) });
    }
    if (kind === "+") delta++;
    if (kind === "-") delta--;
  }
  return result;
}

/** Accept single-file unified patches only, and validate hunk counts before painting any edits. */
function unifiedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">, logicalOnly = false, maxRows = Number.POSITIVE_INFINITY, allowIncomplete = false): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let old = 0, next = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
  for (const row of sourceRows(diff, true, maxRows)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(row);
    if (header) {
      if (oldRemaining || newRemaining) return undefined;
      old = Number(header[1]); next = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1); newRemaining = Number(header[4] ?? 1);
      if (![old, next, oldRemaining, newRemaining].every(validNumber) ||
        (oldRemaining > 0 && (old < 1 || !validNumber(old + oldRemaining - 1))) ||
        (newRemaining > 0 && (next < 1 || !validNumber(next + newRemaining - 1)))) return undefined;
      hunks++; continue;
    }
    if (row === "\\ No newline at end of file") continue;
    if (!hunks) continue; // File headers are not display content.
    const kind = row[0];
    if (kind !== " " && kind !== "+" && kind !== "-") return undefined;
    if (kind !== "+" && --oldRemaining < 0) return undefined;
    if (kind !== "-" && --newRemaining < 0) return undefined;
    kinds?.add(kind);
    if (content) {
      const text = row.slice(1), oldLine = kind !== "+" ? old : undefined, nextLine = kind !== "-" ? next : undefined;
      const candidate = oldLine === 1 || nextLine === 1 ? shebangLanguage(text) : undefined;
      result.push({ kind, ...sourceText(text, logicalOnly), old: oldLine, next: nextLine, hunk: hunks, ...(candidate ? { languageHint: candidate } : {}) });
    }
    if (kind !== "+") old++;
    if (kind !== "-") next++;
  }
  return hunks && (allowIncomplete || !oldRemaining && !newRemaining) ? result : undefined;
}

/** Validation-only calls collect no source rows and do no cleaning, segmentation or highlighting. */
function savedDiff(saved: FileCardInput['saved'], failed: boolean, content = true, kinds?: Set<" " | "+" | "-">,
  logicalOnly = false, maxRows = Number.POSITIVE_INFINITY, allowIncomplete = false): DiffLine[] | "inline" | undefined {
  if (failed) return "inline";
  if (!saved) return "inline";
  if (saved.format === 'unified') return typeof saved.value === 'string'
    ? unifiedDiff(saved.value, content, kinds, logicalOnly, maxRows, allowIncomplete) : undefined;
  return typeof saved.value === 'string' ? numberedDiff(saved.value, content, kinds, logicalOnly, maxRows) : undefined;
}
/** Classify supplied rows before projecting context; validation-only calls never materialize code. */
type PreviewText = { text: string; omitted: boolean };
export function filePreviewText(source: string, maxUnits = FILE_PREVIEW_MAX_UNITS, maxRows = FILE_PREVIEW_MAX_ROWS): PreviewText {
  const sourcePrefix = source.slice(0, maxUnits).replace(/\r\n?/gu, "\n"), bounded = clean(sourcePrefix), clipped = source.length > maxUnits;
  const end = clipped ? bounded.lastIndexOf("\n") : bounded.length;
  const complete = end < 0 ? "" : bounded.slice(0, end);
  const rows = Array.from(sourceRows(complete, true, maxRows + 1));
  return { text: rows.slice(0, maxRows).join("\n"), omitted: clipped || rows.length > maxRows };
}
function previewRows(source: string, logicalOnly: boolean): DiffLine[] {
  if (!source) return [];
  const lines: DiffLine[] = []; let next = 1;
  for (const text of sourceRows(source, false, FILE_PREVIEW_MAX_ROWS + 1)) {
    const candidate = next === 1 ? shebangLanguage(text) : undefined;
    lines.push({ kind: " ", ...sourceText(text, logicalOnly), next: next++, ...(candidate ? { languageHint: candidate } : {}) });
  }
  return lines;
}
function previewPresentation(input: FileCardInput, logicalOnly: boolean): SourceFileView | undefined {
  if (!input.complete || input.failed) return undefined;
  let lines: DiffLine[] = [], omitted = true, mode: FileView["mode"] = "diff";
  const useContent = input.kind === 'write' && (input.truncated === true || !input.saved);
  if (useContent) {
    if (typeof input.content !== 'string') return undefined;
    const bounded = filePreviewText(input.content), parsed = previewRows(bounded.text, logicalOnly);
    omitted = bounded.omitted || parsed.length > FILE_PREVIEW_MAX_ROWS;
    lines = parsed.slice(0, FILE_PREVIEW_MAX_ROWS); mode = "code";
  } else {
    if (!input.saved || typeof input.saved.value !== 'string') return undefined;
    const bounded = filePreviewText(input.saved.value);
    const saved = { ...input.saved, value: bounded.text };
    const parsed = savedDiff(saved, false, true, undefined, logicalOnly, FILE_PREVIEW_MAX_ROWS, bounded.omitted);
    if (!parsed || parsed === "inline") return undefined;
    omitted = bounded.omitted;
    lines = parsed;
  }
  const label = input.kind === "write" ? "Write" : "Edit";
  const note = [input.noOp === true && input.kind === "write" ? "No changes." : undefined,
    input.truncated === true && input.kind === "write" ? "Diff truncated by tool; showing supplied content." : undefined,
    omitted ? "Preview is limited to a bounded source prefix; expand for the complete card." : undefined].filter(Boolean).join(" ");
  return { label, mode, lines, preview: true, omitted, note: note || undefined };
}
function readPresentation(input: FileCardInput, logicalOnly: boolean): SourceFileView | undefined {
  if (!input.complete) return undefined;
  if (input.viewMode === "preview") return { label: "Read", mode: "code", lines: [], preview: true };
  const rows = input.readRows ?? [];
  const languageHint = rows[0]?.line === 1 ? shebangLanguage(rows[0].text) : undefined;
  const lines = rows.map((row, index): DiffLine => ({ kind: " ", ...sourceText(row.text, logicalOnly), next: row.line,
    ...(index === 0 && languageHint ? { languageHint } : {}) }));
  return { label: "Read", mode: "code", lines };
}
export function filePresentation(input: FileCardInput, content = true, logicalOnly = false): SourceFileView | undefined {
  if (input.kind === 'read') return readPresentation(input, logicalOnly);
  if (input.viewMode === "preview") return previewPresentation(input, logicalOnly);
  if (input.kind === 'edit') {
    const diff = savedDiff(input.saved, input.failed, content, undefined, logicalOnly);
    return diff === "inline" ? { label: "Edited", mode: "inline", lines: [] } :
      diff ? { label: "Edited", mode: "diff", lines: diff } : undefined;
  }
  if (!input.complete || input.failed) return undefined;
  const suppliedCode = (): SourceFileView | undefined => {
    if (typeof input.content !== "string") return undefined;
    const lines: DiffLine[] = [];
    if (content && input.content.length) {
      let next = 1;
      for (const text of sourceRows(input.content)) {
        const candidate = next === 1 ? shebangLanguage(text) : undefined;
        lines.push({ kind: " ", ...sourceText(text, logicalOnly), next: next++, ...(candidate ? { languageHint: candidate } : {}) });
      }
    }
    return { label: 'Wrote', mode: 'code', lines, note: input.note };
  };
  if (input.truncated === true) return suppliedCode();
  const kinds = new Set<" " | "+" | "-">(), diff = savedDiff(input.saved, false, content, kinds, logicalOnly);
  if (!diff) return undefined;
  if (diff === "inline" || (!kinds.has("+") && !kinds.has("-"))) return suppliedCode();
  if (kinds.has("-")) return { label: "Replaced", mode: "diff", lines: diff };
  if (kinds.has(" ")) return { label: "Edited", mode: "diff", lines: diff };
  return { label: "Created", mode: "code", lines: diff };
}

/** Lifecycle/demand preparation, never classifier work or a render-time callback.
 * Sources retain tabs and include all available context. Positions prove continuity;
 * explicit omissions always reset it. Missing source is not reconstructed/read.
 */
export function prepareFileCard(input: FileCardInput, logicalOnly = false): PreparedFileCard | undefined {
  if (!input.complete || !input.path) return undefined;
  const view = filePresentation(input, true, logicalOnly);
  if (!view) return undefined;
  return { path: input.path, view, sources: logicalOnly ? [] : fileSources(view) };
}
