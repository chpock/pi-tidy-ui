import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { colorToRgb, rgbColor, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Color } from "@earendil-works/pi-tui";
import { cardGeometry, frameRows } from "./card-frame.ts";
import { toolCardPaint, type CardTheme } from "./card-theme.ts";

interface FilePresentation {
  toolName?: string;
  args: Record<string, unknown>;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
}
type DisplayLine = { kind: " " | "+" | "-"; text: string; old?: number; next?: number; styled?: string; hunk?: number } | { kind: "gap" };
type DiffLine = (Exclude<DisplayLine, { kind: "gap" }> & { logical: string }) | { kind: "gap" };
export type CodeHighlight = (code: string, path: string) => string[];

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
function sourceText(value: string): { text: string; logical: string } {
  const logical = clean(value);
  return { logical, text: tabText(logical) };
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
function numberedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">): DiffLine[] | undefined {
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
    if (content) result.push({ kind, ...sourceText(match[3]!), old: kind !== "+" ? number : undefined,
      next: kind === " " ? number + delta : kind === "+" ? number : undefined });
    if (kind === "+") delta++;
    if (kind === "-") delta--;
  }
  return result;
}

/** Accept single-file unified patches only, and validate hunk counts before painting any edits. */
function unifiedDiff(diff: string, content = true, kinds?: Set<" " | "+" | "-">): DiffLine[] | undefined {
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
    if (content) result.push({ kind, ...sourceText(row.slice(1)), old: kind !== "+" ? old : undefined, next: kind !== "-" ? next : undefined, hunk: hunks });
    if (kind !== "+") old++;
    if (kind !== "-") next++;
  }
  return hunks && !oldRemaining && !newRemaining ? result : undefined;
}

/** Validation-only calls collect no source rows and do no cleaning, segmentation or highlighting. */
function savedDiff(node: FilePresentation, content = true, kinds?: Set<" " | "+" | "-">): DiffLine[] | "inline" | undefined {
  // Reject stale/proposed source before even looking at diff metadata on final errors.
  if (!node.isPartial && node.result?.isError === true) return "inline";
  const details = node.result?.details as { diff?: unknown; patch?: unknown } | undefined;
  if (details?.diff === undefined && details?.patch === undefined) return "inline";
  if (details?.patch !== undefined) return typeof details.patch === "string" ? unifiedDiff(details.patch, content, kinds) : undefined;
  return typeof details?.diff === "string" ? /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(details.diff) ?
    unifiedDiff(details.diff, content, kinds) : numberedDiff(details.diff, content, kinds) : undefined;
}
type FileView = { label: "Edited" | "Created" | "Replaced" | "Wrote"; mode: "inline" | "diff" | "code"; lines: readonly DisplayLine[]; note?: string };
type SourceFileView = Omit<FileView, "lines"> & { lines: DiffLine[] };

/** Classify supplied rows before projecting context; validation-only calls never materialize code. */
function presentation(node: FilePresentation, content = true): SourceFileView | undefined {
  if (node.toolName !== "write") {
    const diff = savedDiff(node, content);
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
      for (const text of sourceRows(node.args.content)) lines.push({ kind: " ", ...sourceText(text), next: next++ });
    }
    return { label: "Wrote", mode: "code", lines,
      note: details?.truncated === true ? "Diff truncated by tool; showing supplied content." : details?.noOp === true ? "No changes." : undefined };
  };
  // An explicitly incomplete diff cannot establish a change class, even if some rows survived.
  if (details?.truncated === true) return suppliedCode();
  const kinds = new Set<" " | "+" | "-">(), diff = savedDiff(node, content, kinds);
  if (!diff) return undefined; // Malformed/present unsupported metadata stays native.
  if (diff === "inline" || (!kinds.has("+") && !kinds.has("-"))) return suppliedCode();
  if (kinds.has("-")) return { label: "Replaced", mode: "diff", lines: diff };
  if (kinds.has(" ")) return { label: "Edited", mode: "diff", lines: diff };
  return { label: "Created", mode: "code", lines: diff };
}

export interface FileSource {
  readonly side: "old" | "next";
  readonly text: string;
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
export function prepareFileCard(node: FilePresentation): PreparedFileCard | undefined {
  if ((node.toolName !== "edit" && node.toolName !== "write") || !node.result || node.isPartial) return undefined;
  const path = filePath(node.args);
  if (!path) return undefined;
  const view = presentation(node);
  if (!view) return undefined;
  const sources: FileSource[] = [];
  for (const side of ["old", "next"] as const) {
    let rows: number[] = [], parts: string[] = [], previous: number | undefined;
    const flush = () => {
      if (rows.length) sources.push({ side, text: parts.join("\n"), rows });
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
  return { path, view, sources };
}

export type FileDisplayCard = FileView & { readonly path: string };
/** Component-owned glyph/layout data only; joined logical snapshots belong to the source pool. */
export function displayFileCard(prepared: PreparedFileCard): FileDisplayCard {
  return { path: prepared.path, label: prepared.view.label, mode: prepared.view.mode, note: prepared.view.note,
    lines: prepared.view.lines.map(line => line.kind === "gap" ? { kind: "gap" } :
      { kind: line.kind, text: line.text, old: line.old, next: line.next, hunk: line.hunk }) };
}

function heading(path: string, cwd: string | undefined, label: FileView["label"]): string {
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
  return { framed: false, height: chunks(heading(path, cwd, view.label), width - inset - geometry.marginRight).length };
}

/** Project available context without changing source positions or joining separate hunks. */
function contextRows(lines: readonly DisplayLine[]): DisplayLine[] {
  const rows: DisplayLine[] = [];
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
/** Partition ANSI text monotonically at plain UTF-16 boundaries, then carry only active SGR state.
 * No repeated column scans or historical prefix copies. Pi's public no-wrap path preserves spaces.
 */
function styledChunks(text: string, rows: Chunk[]): string[] {
  if (rows.length === 1) return [text];
  const codes = text.matchAll(/\x1b\[[\d;:]*m/gu);
  let code = codes.next().value, position = 0;
  const fragments = rows.map((row) => {
    const parts: string[] = [];
    let remaining = row.length;
    while (remaining > 0 || code?.index === position) {
      if (code?.index === position) {
        parts.push(code[0]); position += code[0].length; code = codes.next().value;
      } else {
        const length = Math.min(remaining, (code?.index ?? text.length) - position);
        if (length <= 0) break;
        parts.push(text.slice(position, position + length)); position += length; remaining -= length;
      }
    }
    return parts.join("");
  });
  return wrapTextWithAnsi(fragments.join("\n"), Number.MAX_SAFE_INTEGER);
}
function highlight(lines: DiffLine[], path: string, paint: CardTheme, highlighter?: CodeHighlight) {
  // Highlight before/after separately so removed strings/comments cannot color new code.
  for (const side of ["old", "next"] as const) {
    const source = lines.filter((line): line is Extract<DiffLine, { text: string }> => line.kind !== "gap" && line[side] !== undefined);
    if (!source.length) continue;
    const highlighted = highlighter?.(source.map((line) => line.text).join("\n"), path);
    // Restore multiline token ANSI state before styling individual rows. This public helper
    // only splits/carries styles here: the unlimited width avoids its ANSI/space wrap path.
    const styled = highlighted ? wrapTextWithAnsi(highlighted.join("\n"), Number.MAX_SAFE_INTEGER) : undefined;
    source.forEach((line, index) => {
      if (side === "next" || line.kind === "-") {
        const row = styled?.[index];
        line.styled = paint.fg("toolOutput", row !== undefined && stripVTControlCharacters(row) === line.text ? row : line.text);
      }
    });
  }
}
type DiffTints = Partial<Record<"toolDiffAdded" | "toolDiffRemoved", { code: Color; gutter: Color }>>;
function diffTints(theme: CardTheme): DiffTints {
  const tints: DiffTints = {};
  if (!theme.colors?.toolPendingBg || !theme.style) return tints;
  const base = colorToRgb(theme.colors.toolPendingBg);
  for (const role of ["toolDiffAdded", "toolDiffRemoved"] as const) {
    const color = theme.colors[role];
    if (!color) continue;
    const overlay = colorToRgb(color);
    const blend = (alpha: number) => {
      // Opacity-weighted Multiply in sRGB; round only after blending, never brighten the panel.
      const channel = (key: "r" | "g" | "b") => Math.round(base[key] * (1 - alpha + alpha * overlay[key] / 255));
      return rgbColor(channel("r"), channel("g"), channel("b"));
    };
    tints[role] = { code: blend(0.16), gutter: blend(0.26) };
  }
  return tints;
}
function cell(line: DisplayLine | undefined, side: "old" | "next", width: number, digits: number, theme: CardTheme, tints: DiffTints, plain = false): string[] {
  if (!line) return [" ".repeat(width)];
  if (line.kind === "gap") return [theme.fg("dim", "…") + " ".repeat(width - 1)];
  const gutterSize = digits + (plain ? 2 : 4);
  const gutterWidth = gutterSize < width ? gutterSize : 0;
  const contentWidth = width - gutterWidth;
  const role = plain ? undefined : line.kind === "+" ? "toolDiffAdded" : line.kind === "-" ? "toolDiffRemoved" : undefined;
  const tint = (text: string, part: "gutter" | "code") => {
    const bg = role ? tints[role]?.[part] : undefined;
    return bg && theme.style ? theme.style(text, { bg }) : text;
  };
  const wrapped = chunks(line.text, contentWidth), styled = styledChunks(line.styled ?? theme.fg("toolOutput", line.text), wrapped);
  return wrapped.map((chunk, index) => {
    const number = index === 0 ? String(line[side] ?? "").padStart(digits) : " ".repeat(digits);
    const sign = plain ? "" : index === 0 && role ? theme.fg(role, ` ${line.kind}`) : "  ";
    const gutter = gutterWidth ? tint(theme.fg("dim", " " + number) + sign + " ", "gutter") : "";
    const fragment = styled[index] ?? "";
    const code = stripVTControlCharacters(fragment) === chunk.text ? fragment : theme.fg("toolOutput", chunk.text);
    return gutter + tint(code + " ".repeat(contentWidth - chunk.size), "code");
  });
}
function* codeRows(lines: readonly DisplayLine[], width: number, split: boolean, theme: CardTheme, plain = false): Generator<string> {
  const tints = plain ? {} : diffTints(theme);
  const digits = String(lines.reduce((max, line) => line.kind === "gap" ? max : Math.max(max, line.old ?? 0, line.next ?? 0), 1)).length;
  if (!split) {
    for (const line of lines) yield* cell(line, line.kind === "-" ? "old" : "next", width, digits, theme, tints, plain);
    return;
  }
  const leftWidth = Math.floor(width / 2), rightWidth = width - leftWidth;
  function* pair(left?: DisplayLine, right?: DisplayLine) {
    const before = cell(left, "old", leftWidth, digits, theme, tints), after = cell(right, "next", rightWidth, digits, theme, tints);
    for (let index = 0; index < Math.max(before.length, after.length); index++)
      yield (before[index] ?? " ".repeat(leftWidth)) + (after[index] ?? " ".repeat(rightWidth));
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === " " || line.kind === "gap") { yield* pair(line, line); index++; continue; }
    const removes: DisplayLine[] = [], adds: DisplayLine[] = [];
    while (index < lines.length) {
      const changed = lines[index]!;
      if (changed.kind === "gap" || changed.kind === " " || changed.hunk !== line.hunk) break;
      index++;
      (changed.kind === "-" ? removes : adds).push(changed);
    }
    for (let part = 0; part < Math.max(removes.length, adds.length); part++) yield* pair(removes[part], adds[part]);
  }
}

/** Shared edit/write source presentation inside the accepted frame. Undefined means native fallback. */
export function renderFileCard(node: FilePresentation, cwd: string | undefined, width: number, theme: CardTheme, highlighter?: CodeHighlight, outputPad = 1) {
  const path = filePath(node.args);
  if (!path) return undefined;
  if (!width) return { rows: [] as string[], framed: false, native: false };
  const view = presentation(node);
  if (!view) return undefined;
  if (view.mode !== "inline") highlight(view.lines, path, theme, highlighter);
  return renderPreparedFileCard({ path, ...view }, cwd, width, theme, {
    outputPad, error: !node.isPartial && node.result?.isError === true,
    diagnostics: (node.result?.details as { diagnostics?: unknown } | undefined)?.diagnostics,
  });
}
export interface FileRenderOptions {
  outputPad?: number;
  error?: boolean;
  diagnostics?: unknown;
  /** Full display-model indices; validated painter rows already have four-column tabs. */
  styledRows?: ReadonlyMap<number, string>;
}
/** Layout/projection only. Does not read tool arguments, normalize source or classify code. */
export function renderPreparedFileCard(view: FileDisplayCard, cwd: string | undefined, width: number, theme: CardTheme, options: FileRenderOptions = {}) {
  const geometry = cardGeometry(width, options.outputPad ?? 1), available = geometry.contentWidth;
  if (!width) return { rows: [] as string[], framed: false, native: false };
  const title = heading(view.path, cwd, view.label);
  if (view.mode === "inline") {
    const inset = Math.min(geometry.contentX, Math.max(0, width - geometry.marginRight - 1));
    return { rows: chunks(title, width - inset - geometry.marginRight).map((row) => " ".repeat(inset) + theme.fg(options.error ? "error" : "muted", row.text)),
      framed: false, native: false };
  }
  const styledRows = options.styledRows;
  const diff = styledRows ? view.lines.map((line, index): DisplayLine => {
    const styled = styledRows.get(index);
    return line.kind === "gap" || styled === undefined ? line : { ...line, styled };
  }) : view.lines;
  // Highlight all supplied source first: hidden context can open a multiline token.
  const visible = view.mode === "code" ? diff : contextRows(diff);
  const body = chunks(title, available).map((row) => theme.fg("muted", row.text));
  if (visible.length) {
    body.push("");
    // Only mixed edits benefit from two panes; classify the entire parsed diff, not each hunk.
    const split = view.mode === "diff" && width > 120 && diff.some(line => line.kind === "+") && diff.some(line => line.kind === "-");
    for (const row of codeRows(visible, available, split, theme, view.mode === "code")) body.push(row);
  }
  if (view.note) {
    body.push("");
    for (const row of chunks(view.note, available)) body.push(theme.fg("muted", row.text));
  }
  // AFT supplies flattened display positions, not OpenCode's zero-based LSP range map.
  if (Array.isArray(options.diagnostics)) {
    const diagnostics = options.diagnostics.filter((value) => value && typeof value === "object" && value.severity === "error" && typeof value.message === "string");
    if (diagnostics.length) body.push("");
    for (const diagnostic of diagnostics) {
      const location = Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? ` [${diagnostic.line}]` : "";
      for (const row of chunks(`Error${location}: ${clean(diagnostic.message).replace(/\s+/gu, " ")}`, available)) body.push(theme.fg("error", row.text));
    }
  }
  return { rows: frameRows(geometry, body, toolCardPaint(theme, false)), framed: true, native: false };
}
