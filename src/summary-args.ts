import { stripVTControlCharacters } from "node:util";
import { displayPath } from "./display-path.ts";

export const VALUE_TEXT_LIMIT = 256;
export const SUMMARY_TEXT_LIMIT = 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const OBJECT_KEYS = ["path", "target", "url", "scope"];
const PATH_FIELDS = new Set(["path", "paths", "file_path", "filePath", "target", "targets", "scope", "files", "destination",
  "cwd", "workdir", "dir", "toPath", "handoffPath", "sessionDir", "outputPaths"]);

/** Exact top-level names, ordered by action, target, selection, then auxiliary settings. */
export const PRIORITY_FIELDS = [
  "op", "action", "command", "query", "queries", "subject", "description", "agent", "subagent_type", "task", "workflow",
  "claim", "question", "goal", "objective", "summary", "topic",
  "paths", "path", "file_path", "filePath", "target", "targets", "url", "urls", "scope", "files", "destination",
  "repo", "project", "cwd", "workdir", "machine", "symbol", "symbols", "toSymbol", "toPath", "expression",
  "ids", "note_ids", "taskId", "id", "runId", "laneId", "childId", "toolCallId", "missionId", "handoffPath", "planId", "dir", "to", "replyTo", "tag", "drop",
  "pattern", "include", "globs", "lang", "filter", "status", "category", "name", "header", "module", "names", "namespace", "alias",
  "defaultImport", "removeName", "importKind", "modifiers", "sources", "domainFilter", "recencyFilter", "from",
  "startLine", "endLine", "start", "end", "offset", "limit", "topK", "numResults", "timestamp", "frames", "depth",
  "mode", "view", "sections", "provider", "model", "answerModel", "thinking", "skill", "agentScope", "context", "isolation", "baseRef",
  "runMode", "runStatus", "missionStatus", "missionScope", "surface_condition", "reason", "labels", "claims", "options", "questions", "todos",
  "preview", "message", "output", "outputMode", "outputPaths", "outputSchema", "config", "args", "extensionBindings", "preflight", "lane",
  "mission", "missionUpdate", "merge", "supersession", "control", "agentContract", "acceptance", "gate", "toolBudget", "usageBudget",
  "timeout", "timeout_ms", "timeoutMs", "maxRuntimeMs", "checkpointBeforeDeadlineMs", "toolTimeoutMs", "wait", "background", "async",
  "nonBlocking", "all", "stopOnAttention", "once", "compressed", "pty", "ptyRows", "ptyCols", "output_mode",
  "includeTests", "includeUnresolved", "callgraph", "callgraphDepth", "filesOnly", "verbose", "limitBytes", "maxTokens",
  "num", "lines", "index", "additional", "capabilities", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun", "toolActivation",
  "validate", "dryRun", "recursive", "replaceAll", "occurrence", "typeOnly", "multiSelect", "contextLines", "contextLinesBefore",
  "contextLinesAfter", "forceClone", "includeContent", "fetchContent", "auth", "proxy", "findText", "findMode", "responseId",
  "queryIndex", "urlIndex", "urlOffset", "sessionDir", "chatProgress", "worktree", "focus", "steeringRecovery", "artifacts", "includeProgress", "share", "fast",
  // Unknown names rank immediately before this large-content suffix; nothing is hidden.
  "content", "edits", "code", "input", "messages", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText",
] as readonly string[];
const ranks = new Map(PRIORITY_FIELDS.map((key, index) => [key, index]));
const unknownRank = PRIORITY_FIELDS.indexOf("content") - 0.5;
const SECRET_KEYS = new Set(["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"]);

/** Display sanitization only; caller-owned source is never changed. */
export function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\s+/gu, " ")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2060-\u206f]/gu, "");
}
const size = (text: string) => { let count = 0; for (const _part of graphemes.segment(text)) count++; return count; };
function prefix(text: string, limit: number): { text: string; truncated: boolean } {
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(text)) {
    if (parts.length === limit) return { text: parts.join(""), truncated: true };
    parts.push(segment);
  }
  return { text: parts.join(""), truncated: false };
}
function cleanPrefix(text: string, limit: number, cwd?: string) {
  const value = prefix(text, Math.max(0, Math.min(VALUE_TEXT_LIMIT, limit)));
  return { text: sanitize(value.truncated ? value.text : displayPath(value.text, cwd)), truncated: value.truncated };
}
function plainPrefix(value: { text: string; truncated: boolean }, limit: number): string {
  const clipped = prefix(value.text, limit);
  if (!value.truncated && !clipped.truncated) return clipped.text;
  return prefix(clipped.text, Math.max(0, limit - 1)).text + (limit ? "…" : "");
}
function quotedPrefix(value: { text: string; truncated: boolean }, limit: number): string {
  if (limit < 2) return limit ? "…" : "";
  const parts: { text: string; size: number }[] = [];
  // Serialize one bounded prefix, then partition its escaped wire text at source-grapheme boundaries.
  const wire = JSON.stringify(value.text).slice(1, -1);
  let used = 0, cursor = 0, truncated = value.truncated;
  for (const { segment } of graphemes.segment(value.text)) {
    const start = cursor;
    for (let unit = 0; unit < segment.length; unit++)
      cursor += wire[cursor] === "\\" ? wire[cursor + 1] === "u" ? 6 : 2 : 1;
    const text = wire.slice(start, cursor), length = size(text);
    if (used + length > limit - 2) { truncated = true; break; }
    parts.push({ text, size: length }); used += length;
  }
  if (truncated) {
    if (limit < 3) return "…";
    while (used > limit - 3) used -= parts.pop()!.size;
  }
  return '"' + parts.map(part => part.text).join("") + (truncated ? "…" : "") + '"';
}
const quoted = (text: string, limit: number, cwd?: string) => quotedPrefix(cleanPrefix(text, limit, cwd), limit);
const location = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function objectText(text: string, limit: number, cwd?: string): string {
  const value = cleanPrefix(text, limit, cwd);
  return !value.text || /[\s"\\\[\],]/u.test(value.text) ? quotedPrefix(value, limit) : plainPrefix(value, limit);
}
export function summaryName(name: string): string {
  const value = cleanPrefix(name, VALUE_TEXT_LIMIT);
  value.text = value.text.trim();
  return plainPrefix(value, VALUE_TEXT_LIMIT);
}

/** Enumerate keys without fetching values past the preview's remaining budget. */
function* keys(value: object): Generator<string> {
  if (Array.isArray(value)) { for (let index = 0; index < value.length; index++) yield String(index); }
  else for (const key in value) if (Object.hasOwn(value, key)) yield key;
}
function jsonPreview(value: unknown, limit: number, parents: Set<object>, cwd?: string, pathValue = false): string {
  if (typeof value === "string") return quoted(value, limit, pathValue ? cwd : undefined);
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value) ?? '"[unavailable]"';
    return size(text) <= limit ? text : "…";
  }
  if (parents.has(value)) throw new Error("Cyclic JSON");
  if (limit < 3) return "…";
  parents.add(value);
  try {
    const array = Array.isArray(value), members: string[] = [];
    const iterator = keys(value);
    let current = iterator.next(), used = 0;
    while (!current.done) {
      const next = iterator.next(), separator = members.length ? "," : "";
      const available = limit - 2 - used - separator.length - (next.done ? 0 : 2); // reserve ,… and closing delimiter
      if (available < 1) { members.push("…"); break; }
      const label = array ? "" : quoted(current.value, Math.min(VALUE_TEXT_LIMIT, limit)) + ":";
      const remaining = available - size(label);
      if (remaining < 1) { members.push("…"); break; }
      const item = (value as Record<string, unknown>)[current.value];
      if (!array && (item === undefined || typeof item === "function" || typeof item === "symbol")) { current = next; continue; }
      const child = jsonPreview(array && item === undefined ? null : item, remaining, parents, cwd, array ? pathValue : PATH_FIELDS.has(current.value));
      const text = label + child;
      members.push(text); used += separator.length + size(text);
      if (child === "…") {
        if (!array && !next.done) members.push("…"); // the named value and the object suffix are distinct omissions
        break;
      }
      current = next;
    }
    return (array ? "[" : "{") + members.join(",") + (array ? "]" : "}");
  } finally { parents.delete(value); }
}
function valueText(value: unknown, limit: number, cwd?: string, pathValue = false): string {
  try { return jsonPreview(value, limit, new Set(), cwd, pathValue); }
  catch { return quoted("[unavailable]", limit); }
}

/** Name and argument text share one budget; outside glyphs, indentation and status do not. */
export function argumentParts(name: string, args: Record<string, unknown>, cwd?: string) {
  let remaining = SUMMARY_TEXT_LIMIT - size(summaryName(name)) - 1;
  const used = new Set<string>();
  let pattern: string | undefined, object: string | undefined;
  if (typeof args.pattern === "string") {
    pattern = valueText(args.pattern, Math.min(VALUE_TEXT_LIMIT, remaining)); remaining -= size(pattern); used.add("pattern");
    if (location(args.path)) {
      object = objectText(args.path, Math.min(VALUE_TEXT_LIMIT, remaining - 4), cwd); remaining -= 4 + size(object); used.add("path");
    }
  } else {
    const key = OBJECT_KEYS.find(key => location(args[key]));
    if (key) { object = objectText(args[key] as string, Math.min(VALUE_TEXT_LIMIT, remaining), PATH_FIELDS.has(key) ? cwd : undefined); remaining -= size(object); used.add(key); }
  }
  if (pattern !== undefined || object !== undefined) remaining--; // space before a parameter block
  const rank = (key: string) => ranks.get(key) ?? unknownRank;
  const fields = Object.keys(args).filter(key => !used.has(key));
  fields.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const params: string[] = [];
  let usedSpace = 0;
  for (let index = 0; index < fields.length; index++) {
    const key = fields[index]!, separator = params.length ? ", " : "";
    const available = remaining - 2 - usedSpace - separator.length - (index + 1 < fields.length ? 3 : 0); // reserve , … and brackets
    if (available < 3) { params.push("…"); break; }
    const label = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? plainPrefix(cleanPrefix(key, VALUE_TEXT_LIMIT), VALUE_TEXT_LIMIT) : quoted(key, VALUE_TEXT_LIMIT);
    if (available <= size(label) + 1) { params.push("…"); break; }
    const value = args[key];
    if (value === undefined) continue;
    const text = `${label}=${valueText(SECRET_KEYS.has(key) ? "<redacted>" : value, VALUE_TEXT_LIMIT, cwd, PATH_FIELDS.has(key))}`;
    if (size(text) > available) { params.push("…"); break; }
    params.push(text); usedSpace += separator.length + size(text);
  }
  return { pattern, object, params: params.length ? `[${params.join(", ")}]` : "" };
}

export function describeArgs(name: string, args: Record<string, unknown>, cwd?: string): string {
  const { pattern, object, params } = argumentParts(name, args, cwd);
  const primary = pattern !== undefined ? `${pattern}${object !== undefined ? ` in ${object}` : ""}` : object ?? "";
  return [primary, params].filter(Boolean).join(" ");
}
