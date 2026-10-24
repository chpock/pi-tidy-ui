import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { cardGeometry } from "./card-frame.ts";
import { shebangLanguage } from "./syntax/shebang-language.ts";

interface FilePresentation {
  toolName?: string;
  args: Record<string, unknown>;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
}
type DisplayLine = { kind: " " | "+" | "-"; text: string; old?: number; next?: number; hunk?: number } | { kind: "gap" };
type DiffLine = (Exclude<DisplayLine, { kind: "gap" }> & { logical: string; languageHint?: string }) | { kind: "gap" };

// Display-only maximum on each side of a change; metadata may supply fewer rows.
const DIFF_CONTEXT_LINES = 3;

/** Display-only cleaning. Preserve code whitespace; no file reads or proposal diffing. */
function clean(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2060-\u206f]/gu, "");
}
export function filePath(args: Record<string, unknown>): string | undefined {
  const path = args.path ?? args.file_path ?? args.filePath;
  return typeof path === "string" && path.length ? path : undefined;
}
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
function* sourceRows(diff: string, trimFinalNewline = false): Generator<string> {
  const text = diff.replace(/\r\n?/gu, "\n");
  const length = text.length - (trimFinalNewline && text.endsWith("\n") ? 1 : 0);
  let start = 0;
  do {
    const newline = text.indexOf("\n", start), end = newline < 0 ? length : Math.min(newline, length);
    yield text.slice(start, end); start = end + 1;
  } while (start <= length);
}

/** Pi/AFT number context in the old file; OpenCode's unified view numbers context in the new file. */
function numberedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">, logicalOnly = false): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let delta = 0;
  for (const row of sourceRows(diff)) {
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
function unifiedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">, logicalOnly = false): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let old = 0, next = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
  for (const row of sourceRows(diff, true)) {
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
  return hunks && !oldRemaining && !newRemaining ? result : undefined;
}

/** Validation-only calls collect no source rows and do no cleaning, segmentation or highlighting. */
function savedDiff(node: FilePresentation, content = true, kinds?: Set<" " | "+" | "-">, logicalOnly = false): DiffLine[] | "inline" | undefined {
  // Reject stale/proposed source before even looking at diff metadata on final errors.
  if (!node.isPartial && node.result?.isError === true) return "inline";
  const details = node.result?.details as { diff?: unknown; patch?: unknown } | undefined;
  if (details?.diff === undefined && details?.patch === undefined) return "inline";
  if (details?.patch !== undefined) return typeof details.patch === "string" ? unifiedDiff(details.patch, content, kinds, logicalOnly) : undefined;
  return typeof details?.diff === "string" ? /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(details.diff) ?
    unifiedDiff(details.diff, content, kinds, logicalOnly) : numberedDiff(details.diff, content, kinds, logicalOnly) : undefined;
}
type FileView = { label: "Edited" | "Created" | "Replaced" | "Wrote"; mode: "inline" | "diff" | "code"; lines: readonly DisplayLine[]; note?: string };
type SourceFileView = Omit<FileView, "lines"> & { lines: DiffLine[] };

/** Current service metadata; it does not require rebuilding the source rows. */
export function fileNote(node: FilePresentation, view: Pick<FileView, 'label' | 'mode'>): string | undefined {
  if (node.toolName !== 'write' || !node.result || node.isPartial || node.result.isError || view.label !== 'Wrote' || view.mode !== 'code') return undefined;
  const details = node.result.details as { truncated?: unknown; noOp?: unknown } | undefined;
  return details?.truncated === true ? 'Diff truncated by tool; showing supplied content.' : details?.noOp === true ? 'No changes.' : undefined;
}

/** Classify supplied rows before projecting context; validation-only calls never materialize code. */
function presentation(node: FilePresentation, content = true, logicalOnly = false): SourceFileView | undefined {
  if (node.toolName !== "write") {
    const diff = savedDiff(node, content, undefined, logicalOnly);
    return diff === "inline" ? { label: "Edited", mode: "inline", lines: [] } :
      diff ? { label: "Edited", mode: "diff", lines: diff } : undefined;
  }
  // Partial/failure source is never a candidate for a completed write card.
  if (!node.result || node.isPartial || node.result.isError) return undefined;
  const details = node.result.details as { truncated?: unknown; noOp?: unknown } | undefined;
  const suppliedCode = (): SourceFileView | undefined => {
    if (typeof node.args.content !== "string") return undefined;
    const lines: DiffLine[] = [];
    if (content && node.args.content.length) {
      let next = 1;
      for (const text of sourceRows(node.args.content)) {
        const candidate = next === 1 ? shebangLanguage(text) : undefined;
        lines.push({ kind: " ", ...sourceText(text, logicalOnly), next: next++, ...(candidate ? { languageHint: candidate } : {}) });
      }
    }
    const view: SourceFileView = { label: 'Wrote', mode: 'code', lines };
    view.note = fileNote(node, view);
    return view;
  };
  // An explicitly incomplete diff cannot establish a change class, even if some rows survived.
  if (details?.truncated === true) return suppliedCode();
  const kinds = new Set<" " | "+" | "-">(), diff = savedDiff(node, content, kinds, logicalOnly);
  if (!diff) return undefined; // Malformed/present unsupported metadata stays native.
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
export function prepareFileCard(node: FilePresentation, logicalOnly = false): PreparedFileCard | undefined {
  if ((node.toolName !== "edit" && node.toolName !== "write") || !node.result || node.isPartial) return undefined;
  const path = filePath(node.args);
  if (!path) return undefined;
  const view = presentation(node, true, logicalOnly);
  if (!view) return undefined;
  return { path, view, sources: logicalOnly ? [] : fileSources(view) };
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

export function fileHeading(path: string, cwd: string | undefined, label: FileView["label"]): string {
  const local = cwd && isAbsolute(path) ? relative(cwd, path) : path;
  return `← ${label} ${clean(local || path).replace(/\s+/gu, " ").trim()}`;
}

/** Class/height needed for spacing or rejected clicks, not a rendered layout or a second cache. */
export function measureFileCard(node: FilePresentation, cwd: string | undefined, width: number, outputPad = 1) {
  const path = filePath(node.args);
  if (!path) return undefined;
  if (!width) return { framed: false, height: 0 };
  const view = presentation(node, false);
  if (!view) return undefined;
  // A frame always has padding plus a title: only height > 1 matters to transcript spacing.
  if (view.mode !== "inline") return { framed: true, height: 3 };
  const geometry = cardGeometry(width, outputPad);
  const inset = Math.min(geometry.contentX, Math.max(0, width - geometry.marginRight - 1));
  return { framed: false, height: chunks(fileHeading(path, cwd, view.label), width - inset - geometry.marginRight).length };
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

/** Word-preferred grapheme wrapping, retaining every space and keeping ANSI out of layout. */
type Chunk = { text: string; length: number; size: number };
function chunks(text: string, width: number): Chunk[] {
  const units = Array.from(segments.segment(text), ({ segment }) => ({ text: segment, width: visibleWidth(segment) }));
  const rows: Chunk[] = [];
  let index = 0;
  do {
    let end = index, size = 0, boundary = index, boundarySize = 0;
    while (end < units.length) {
      const unit = units[end]!, columns = Math.min(unit.width, width);
      if (size + columns > width) break;
      size += columns; end++;
      if (/\s/u.test(unit.text) && end > index + 1) { boundary = end; boundarySize = size; }
    }
    if (end < units.length && boundary > index && boundarySize > 0) { end = boundary; size = boundarySize; }
    const parts: string[] = [];
    let length = 0;
    for (let part = index; part < end; part++) {
      const unit = units[part]!;
      parts.push(unit.width > width ? "�" : unit.text); length += unit.text.length;
    }
    rows.push({ text: parts.join(""), length, size });
    index = end;
  } while (index < units.length);
  return rows;
}
/** AFT supplies flattened display positions, not OpenCode's zero-based LSP range map. */
export function fileDiagnosticText(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter(value => value && typeof value === 'object' && value.severity === 'error' && typeof value.message === 'string').map(diagnostic => {
    const location = Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? ` [${diagnostic.line}]` : '';
    return `Error${location}: ${clean(diagnostic.message).replace(/\s+/gu, ' ')}`;
  });
}
