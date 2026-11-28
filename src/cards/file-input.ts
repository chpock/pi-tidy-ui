import { visibleWidth } from '@earendil-works/pi-tui';
import { shebangLanguage } from './shebang-language.ts';
import type { FileCardInput, FileChangeClass, FileLogicalLine as DiffLine, FileView, SourceFileView, PreparedFileCard } from './file-model.ts';
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
  const newline = /[\r\n]/gu;
  let start = 0;
  for (let row = 0; row < maxRows; row++) {
    const match = newline.exec(diff);
    if (!match) { yield diff.slice(start); return; }
    yield diff.slice(start, match.index);
    start = newline.lastIndex + Number(match[0] === "\r" && diff[newline.lastIndex] === "\n");
    if (trimFinalNewline && start === diff.length) return;
    newline.lastIndex = start;
  }
}

/** Numbered context uses old-file coordinates; the unified projection uses new-file coordinates. */
function numberedDiff(diff: string, content: boolean, kinds: Set<" " | "+" | "-"> | undefined,
  logicalOnly: boolean, maxRows: number, detectUnified = false): DiffLine[] | undefined {
  const rows = sourceRows(diff, detectUnified, maxRows), result: DiffLine[] = [];
  let delta = 0, collecting = kinds;
  const unsupported = (row: string) => {
    if (!detectUnified) return undefined;
    // None of the prior valid numbered rows can start a unified hunk.
    // An arbitrary preamble is allowed; continue from this row without rewinding.
    function* remaining() { yield row; yield* rows; }
    kinds?.clear();
    return unifiedDiff(remaining(), content, kinds, logicalOnly, false);
  };
  for (const row of rows) {
    if (/^ +\.\.\.$/u.test(row)) { if (content) result.push({ kind: "gap" }); continue; }
    const match = /^([ +\-]) *(\d+) (.*)$/u.exec(row);
    if (!match) return unsupported(row);
    const kind = match[1] as " " | "+" | "-", number = Number(match[2]);
    if (!validNumber(number) || number < 1 || (kind === " " && (!validNumber(number + delta) || number + delta < 1))) return unsupported(row);
    if (collecting) {
      collecting.add(kind);
      // A removal settles the type, but the remaining rows must still validate.
      if (kind === '-') collecting = undefined;
    }
    if (content) {
      const old = kind !== "+" ? number : undefined, next = kind === " " ? number + delta : kind === "+" ? number : undefined;
      const line = match[3]!;
      const candidate = old === 1 || next === 1 ? shebangLanguage(line) : undefined;
      result.push({ kind, ...sourceText(line, logicalOnly), old, next, ...(candidate ? { languageHint: candidate } : {}) });
    }
    if (kind === "+") delta++;
    if (kind === "-") delta--;
  }
  // Detection skipped the terminal empty row in case this was unified.
  if (detectUnified && (diff.endsWith('\n') || diff.endsWith('\r'))) return undefined;
  return result;
}

/** Accept single-file unified patches only, and validate hunk counts before painting any edits. */
function unifiedDiff(rows: Iterable<string>, content: boolean, kinds: Set<" " | "+" | "-"> | undefined,
  logicalOnly: boolean, allowIncomplete: boolean): DiffLine[] | undefined {
  const result: DiffLine[] = [];
  let old = 0, next = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
  for (const row of rows) {
    const header = row[0] === '@' ? /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(row) : null;
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
    if (kinds) {
      kinds.add(kind);
      // A removal settles the type, but the remaining rows must still validate.
      if (kind === '-') kinds = undefined;
    }
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
  if (typeof saved.value !== 'string') return undefined;
  if (saved.value === '') return [];
  return saved.format === 'unified' ? unifiedDiff(sourceRows(saved.value, true, maxRows), content, kinds, logicalOnly, allowIncomplete)
    : numberedDiff(saved.value, content, kinds, logicalOnly, maxRows, saved.format === 'detect');
}
type PreviewText = { text: string; omitted: boolean };
export function filePreviewSource(source: string, maxUnits = FILE_PREVIEW_MAX_UNITS, maxRows = FILE_PREVIEW_MAX_ROWS): PreviewText {
  const end = Math.min(maxUnits, source.length), clipped = source.length > end;
  const rows: string[] = [];
  let start = 0;
  for (let index = 0; index < end; index++) {
    const code = source.charCodeAt(index);
    if (code !== 13 && code !== 10) continue;
    // After a raw-unit cut, the old prefix excludes a final empty row. Another
    // complete line is enough to prove an empty row at the row limit stays.
    if (rows.length === maxRows) return { text: rows.join("\n"), omitted: true };
    rows.push(source.slice(start, index));
    if (code === 13 && index + 1 < end && source.charCodeAt(index + 1) === 10) index++;
    start = index + 1;
    if (rows.length === maxRows && (!clipped || rows.at(-1) !== ""))
      return { text: rows.join("\n"), omitted: clipped || start < end };
  }
  if (clipped && rows.at(-1) === "") rows.pop();
  if (!clipped && (start < end || end === 0)) {
    if (rows.length === maxRows) return { text: rows.join("\n"), omitted: true };
    rows.push(source.slice(start, end));
  }
  return { text: rows.join("\n"), omitted: clipped };
}
export function filePreviewText(source: string, maxUnits = FILE_PREVIEW_MAX_UNITS, maxRows = FILE_PREVIEW_MAX_ROWS): PreviewText {
  // Pending display excerpts select cleaned rows rather than raw source rows.
  const bounded = clean(source.slice(0, maxUnits).replace(/\r\n?/gu, "\n")), clipped = source.length > maxUnits;
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
    const bounded = filePreviewSource(input.content), parsed = previewRows(bounded.text, logicalOnly);
    omitted = bounded.omitted || parsed.length > FILE_PREVIEW_MAX_ROWS;
    lines = parsed.slice(0, FILE_PREVIEW_MAX_ROWS); mode = "code";
  } else {
    if (!input.saved || typeof input.saved.value !== 'string') return undefined;
    const bounded = filePreviewSource(input.saved.value);
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
/** Classify supplied rows before projecting context; validation-only calls never materialize code. */
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
  if (input.truncated === true || input.knownChange === 'Wrote') return suppliedCode();
  const kinds = input.knownChange ? undefined : new Set<" " | "+" | "-">();
  const diff = savedDiff(input.saved, false, content, kinds, logicalOnly);
  if (!diff) return undefined;
  if (diff === "inline" || (kinds && !kinds.has("+") && !kinds.has("-"))) return suppliedCode();
  const label = input.knownChange ?? (kinds!.has('-') ? 'Replaced' : kinds!.has(' ') ? 'Edited' : 'Created');
  return { label, mode: label === 'Created' ? 'code' : 'diff', lines: diff };
}

export function classifySavedFileChange(input: FileCardInput): FileChangeClass | null {
  if (!input.complete || input.failed || !input.path || input.kind === 'read') return null;
  const label = filePresentation({ ...input, viewMode: 'full' }, false)?.label;
  return label === 'Edited' || label === 'Created' || label === 'Replaced' || label === 'Wrote' ? label : null;
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
