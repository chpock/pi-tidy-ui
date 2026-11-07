import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { cardGeometry } from "./card-frame.ts";
import { displayPath } from "./display-path.ts";
import { wrapText } from "./text-wrap.ts";
import { shebangLanguage } from "./syntax/shebang-language.ts";

export type FileCardInput = {
  readonly kind: 'read' | 'write' | 'edit';
  readonly path: string;
  readonly complete: boolean;
  readonly failed: boolean;
  readonly viewMode: 'full' | 'preview';
  readonly content?: unknown;
  readonly saved?: { readonly format: 'numbered' | 'unified'; readonly value: unknown };
  readonly truncated?: boolean;
  readonly noOp?: boolean;
  readonly note?: string;
  readonly readRows?: readonly { readonly text: string; readonly line?: number }[];
};
type DisplayLine = { kind: " " | "+" | "-"; text: string; old?: number; next?: number; hunk?: number } | { kind: "gap" };
type DiffLine = (Exclude<DisplayLine, { kind: "gap" }> & { logical: string; languageHint?: string }) | { kind: "gap" };

// Display-only maximum on each side of a change; metadata may supply fewer rows.
const DIFF_CONTEXT_LINES = 3;
export const FILE_PREVIEW_MAX_UNITS = 8192;
export const FILE_PREVIEW_MAX_ROWS = 10;

/** Display-only cleaning. Preserve code whitespace; no file reads or proposal diffing. */
function clean(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2060-\u206f]/gu, "");
}
export function cleanFileDisplayText(value: string): string { return clean(value); }
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
type FileView = { label: "Edited" | "Created" | "Replaced" | "Wrote" | "Edit" | "Write" | "Read"; mode: "inline" | "diff" | "code";
  lines: readonly DisplayLine[]; note?: string; preview?: boolean; omitted?: boolean };
type SourceFileView = Omit<FileView, "lines"> & { lines: DiffLine[] };


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
function presentation(input: FileCardInput, content = true, logicalOnly = false): SourceFileView | undefined {
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

export interface FileSource {
  readonly side: "old" | "next";
  readonly text: string;
  readonly languageHint?: string;
  /** Full prepared-view indices, not visible-context or wrapped row indices. */
  readonly rows: readonly number[];
}
export interface PreparedFileCard {
  readonly path: string;
  readonly view: SourceFileView;
  readonly sources: readonly FileSource[];
}

/** Lifecycle/demand preparation, never classifier work or a render-time callback.
 * Sources retain tabs and include all available context. Positions prove continuity;
 * explicit omissions always reset it. Missing source is not reconstructed/read.
 */
export function prepareFileCard(input: FileCardInput, logicalOnly = false): PreparedFileCard | undefined {
  if (!input.complete || !input.path) return undefined;
  const view = presentation(input, true, logicalOnly);
  if (!view) return undefined;
  return { path: input.path, view, sources: logicalOnly ? [] : fileSources(view) };
}

/** Join only at the useful source boundary; lifecycle owners retain logical fragments. */
export function fileSources(view: PreparedFileCard['view']): FileSource[] {
  const sources: FileSource[] = [];
  const first = (side: 'old' | 'next') => view.lines.find((line): line is Exclude<DiffLine, { kind: 'gap' }> => line.kind !== 'gap' && line[side] === 1)?.languageHint;
  const oldCandidate = first('old'), nextCandidate = first('next');
  for (const side of ["old", "next"] as const) {
    const candidate = side === 'old' ? oldCandidate ?? nextCandidate : nextCandidate ?? oldCandidate;
    let rows: number[] = [], parts: string[] = [], previous: number | undefined;
    const flush = () => {
      if (rows.length) sources.push({ side, text: parts.join("\n"), rows, ...(candidate ? { languageHint: candidate } : {}) });
      rows = []; parts = []; previous = undefined;
    };
    for (let index = 0; index < view.lines.length; index++) {
      const line = view.lines[index]!;
      if (line.kind === "gap") { flush(); continue; }
      const position = line[side];
      if (position === undefined) continue;
      if (previous !== undefined && position !== previous + 1) flush();
      rows.push(index); parts.push(line.logical); previous = position;
    }
    flush();
  }
  return sources;
}

function headingPath(path: string, cwd: string | undefined): string {
  const local = cwd && isAbsolute(cwd) && isAbsolute(path) ? relative(cwd, path) : path;
  return clean(displayPath(local || path, cwd)).replace(/\s+/gu, " ").trim();
}
export function fileHeading(path: string, cwd: string | undefined, label: FileView["label"]): string {
  return `← ${label} ${headingPath(path, cwd)}`;
}

export function readHeading(path: string, cwd: string | undefined): string {
  return `→ Read ${headingPath(path, cwd)}`;
}

/** Class/height needed for spacing or rejected clicks, not a rendered layout or a second cache. */
export function measureFileCard(input: FileCardInput, cwd: string | undefined, width: number, outputPad = 1) {
  if (!input.path) return undefined;
  if (!width) return { framed: false, height: 0 };
  const view = presentation(input, false);
  if (!view) return undefined;
  if (view.mode !== "inline") return { framed: true, height: 3 };
  const geometry = cardGeometry(width, outputPad);
  const inset = Math.min(geometry.contentX, Math.max(0, width - geometry.marginRight - 1));
  return { framed: false, height: wrapText(fileHeading(input.path, cwd, view.label), width - inset - geometry.marginRight, { wide: 'replace' }).length };
}

/** Project available context without changing source positions or joining separate hunks. */
export function contextRows<T extends DisplayLine>(lines: readonly T[]): (T | { kind: 'gap' })[] {
  const rows: (T | { kind: 'gap' })[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind !== " ") { rows.push(line); index++; continue; }
    const start = index;
    while (index < lines.length) {
      const context = lines[index]!;
      if (context.kind !== " " || context.hunk !== line.hunk) break;
      index++;
    }
    const changed = (neighbor: DisplayLine | undefined) => neighbor && (neighbor.kind === "+" || neighbor.kind === "-") && neighbor.hunk === line.hunk;
    const before = changed(lines[start - 1]), after = changed(lines[index]);
    const count = index - start;
    const head = before ? Math.min(DIFF_CONTEXT_LINES, count) : 0;
    const tail = after ? Math.max(head, count - DIFF_CONTEXT_LINES) : count;
    for (let row = start; row < start + head; row++) rows.push(lines[row]!);
    if (before && after && tail > head) rows.push({ kind: "gap" });
    for (let row = start + tail; row < index; row++) rows.push(lines[row]!);
  }
  let first = 0, last = rows.length;
  while (first < last && rows[first]!.kind === "gap") first++;
  while (last > first && rows[last - 1]!.kind === "gap") last--;
  return rows.slice(first, last);
}

export function fileDiagnosticText(input: readonly { readonly line?: number; readonly message: string }[]): string[] {
  return input.map(diagnostic => {
    const location = Number.isSafeInteger(diagnostic.line) && diagnostic.line! > 0 ? ` [${diagnostic.line}]` : '';
    return `Error${location}: ${clean(diagnostic.message).replace(/\s+/gu, ' ')}`;
  });
}
