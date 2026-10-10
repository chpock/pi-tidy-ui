import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sep, win32 } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { cardGeometry, frameRows, type CardGeometry } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";
import { sanitize } from "./summary-args.ts";

export interface EditorStatusInfo {
  model: string;
  provider: string;
  thinking: string;
  idle: boolean;
  cwd?: string;
  branch?: string;
}

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function label(value: string): string {
  const parts: string[] = [];
  for (const part of segments.segment(value)) {
    if (parts.length === 256) { parts.push("…"); break; }
    parts.push(part.segment);
  }
  return sanitize(parts.join(""));
}

/** Same dedicated thinking roles as Pi's public Theme.getThinkingBorderColor. */
const thinkingColors: Readonly<Record<string, ThemeColor>> = {
  off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium",
  high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
};

/** Fit plain values first so parentheses and semantic color spans stay intact. */
function metadata(info: EditorStatusInfo, width: number, theme: CardTheme): string {
  if (width <= 0) return "";
  let model = label(info.model), provider = label(info.provider), thinking = label(info.thinking);
  const joined = () => [model, provider ? `(${provider})` : ""].filter(Boolean).join(" ") +
    (thinking ? (model || provider ? " • " : "") + thinking : "");
  for (const field of ["provider", "model"] as const) {
    const overflow = visibleWidth(joined()) - width;
    if (overflow <= 0) break;
    const value = field === "provider" ? provider : model, available = visibleWidth(value) - overflow;
    const fitted = available > 1 ? end(value, available) : "";
    if (field === "provider") provider = fitted; else model = fitted;
  }
  if (visibleWidth(joined()) > width) thinking = end(thinking, width);
  const target = [model ? theme.fg("mdHeading", model) : "", provider ?
    theme.fg("dim", "(") + theme.fg("muted", provider) + theme.fg("dim", ")") : ""].filter(Boolean).join(" ");
  const thinkingColor = Object.hasOwn(thinkingColors, info.thinking) ? thinkingColors[info.thinking]! : "thinkingOff";
  return target + (thinking ? (target ? theme.fg("dim", " • ") : "") + theme.fg(thinkingColor, thinking) : "");
}

/** Two noninteractive public-widget rows, with the editor's panel geometry. */
export function renderEditorStatus(width: number, theme: CardTheme, info: EditorStatusInfo,
  geometry: CardGeometry = cardGeometry(width)): string[] {
  if (width < 7) return [];
  const budget = geometry.contentWidth;
  const left = (size: number) => {
    const status = info.idle ? theme.fg("muted", end("Idle", size)) : "";
    const prefix = metadata(info, size - visibleWidth(status) - (status ? 3 : 0), theme);
    return prefix + (prefix && status ? theme.fg("dim", " • ") : "") + status;
  };
  const home = homedir(), homePath = home.replace(sep === "\\" ? /\\+$/u : /\/+$/u, "");
  const cwd = info.cwd ?? "";
  const directory = cwd && home && (cwd === homePath || cwd.startsWith(homePath + sep)) ? `~${cwd.slice(homePath.length)}` : cwd;
  const fullLeft = left(Number.MAX_SAFE_INTEGER);
  const fullRight = directoryStatus(directory, info.branch, Number.MAX_SAFE_INTEGER, theme);
  let text: string;
  if (!fullRight) text = left(budget);
  else {
    const idleWidth = info.idle ? Math.min(4, budget) : 0;
    const remaining = Math.max(0, budget - idleWidth - 2);
    let l = Math.ceil(remaining / 2), r = remaining - l;
    const leftWant = visibleWidth(fullLeft) - idleWidth, rightWant = visibleWidth(fullRight);
    if (leftWant < l) { r += l - leftWant; l = leftWant; }
    if (rightWant < r) { l += r - rightWant; r = rightWant; }
    let lhs = left(l + idleWidth), rhs = directoryStatus(directory, info.branch, r, theme);
    if (!rhs) text = left(budget);
    else {
      if (!lhs) rhs = directoryStatus(directory, info.branch, budget, theme);
      if (visibleWidth(fullLeft) + rightWant + 2 <= budget) { lhs = fullLeft; rhs = fullRight; }
      text = lhs + " ".repeat(budget - visibleWidth(lhs) - visibleWidth(rhs)) + rhs;
    }
  }
  const paint = { border: (value: string) => theme.fg("customMessageLabel", value), panel: (value: string) => {
    const foreground = theme.fg("userMessageText", value);
    return theme.bg ? theme.bg("userMessageBg", foreground) : foreground;
  } };
  const row = frameRows(geometry, [text], paint)[1]!;
  const blocks = "▀".repeat(geometry.panelWidth - geometry.borderWidth);
  const color = theme.colors?.userMessageBg;
  const edge = color !== undefined && theme.style ? theme.style(blocks, { fg: color }) : blocks;
  const bottom = "\x1b[0m" + " ".repeat(geometry.marginLeft) + theme.fg("customMessageLabel", "╹") +
    edge + "\x1b[0m" + " ".repeat(geometry.marginRight);
  return [row, bottom];
}

/** Column-balanced middle removal; only parent fragments may be ellipsis-only. */
function middle(value: string, budget: number, parent = false): string {
  if (visibleWidth(value) <= budget) return value;
  if (budget < 1) return "";
  const parts = Array.from(segments.segment(value), part => part.segment);
  const widths = parts.map(part => visibleWidth(part));
  let first = 0, last = parts.length, used = 0;
  const prefixBudget = Math.ceil((budget - 1) / 2), suffixBudget = Math.floor((budget - 1) / 2);
  while (first < last && used + widths[first]! <= prefixBudget) used += widths[first++]!;
  let suffix = 0;
  while (last > first && suffix + widths[last - 1]! <= suffixBudget) suffix += widths[--last]!;
  while (first < last && used + suffix + widths[first]! <= budget - 1) used += widths[first++]!;
  while (last > first && used + suffix + widths[last - 1]! <= budget - 1) suffix += widths[--last]!;
  return used + suffix > 0 || parent ? parts.slice(0, first).join("") + "…" + parts.slice(last).join("") : "";
}

/** Pure staged cwd/branch presentation. Git validation belongs to the data source. */
export function directoryStatus(cwd: string, branch: string | undefined, budget: number, theme: CardTheme): string {
  if (!cwd || budget < 1) return "";
  let path = sanitize(cwd);
  const windows = /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\") || path.startsWith("~\\");
  const root = windows ? win32.parse(path).root : path.match(/^\/+/u)?.[0] ?? "";
  // Keep filesystem/drive/UNC roots intact, but not non-root trailing separators.
  const separators = windows ? /[\\/]/u : /\//u;
  while (path.length > root.length && separators.test(path.at(-1)!)) path = path.slice(0, -1);
  const boundary = path === root ? -1 : Math.max(path.lastIndexOf("/"), windows ? path.lastIndexOf("\\") : -1);
  let prefix = boundary >= 0 ? path.slice(0, boundary + 1) : "";
  let name = boundary >= 0 ? path.slice(boundary + 1) : path;
  const originalRef = branch ? sanitize(branch) : "";
  let ref = originalRef;
  const separator = prefix.at(-1) ?? (windows ? "\\" : "/");
  const total = () => visibleWidth(prefix) + visibleWidth(name) + (ref ? 1 + visibleWidth(ref) : 0);
  const painted = () => (prefix ? theme.fg("dim", prefix) : "") + theme.fg("mdLinkUrl", name) +
    (ref ? theme.fg("muted", ":") + theme.fg("text", ref) : "");
  if (total() <= budget) return painted();

  // 1. Root + first parent + a balanced middle + complete last name.
  const first = (windows ? /[^\\/]+/u : /[^/]+/u).exec(prefix.slice(root.length));
  if (first) {
    const anchorEnd = root.length + first.index + first[0].length + 1;
    const anchor = prefix.slice(0, anchorEnd), value = prefix.slice(anchorEnd, -1);
    if (value) {
      const available = Math.max(1, budget - visibleWidth(anchor + separator + name) - (ref ? 1 + visibleWidth(ref) : 0));
      const reduced = anchor + middle(value, available, true) + separator;
      if (visibleWidth(reduced) < visibleWidth(prefix)) prefix = reduced;
    }
  }
  if (total() <= budget) return painted();
  // 2. Branch down to five columns, including its ellipsis.
  if (ref) ref = middle(originalRef, Math.max(5, budget - visibleWidth(prefix + name) - 1));
  if (total() <= budget) return painted();
  // 3. Discard the remaining parent anchor in one useful step.
  if (visibleWidth(prefix) > visibleWidth("…" + separator)) prefix = "…" + separator;
  if (total() <= budget) return painted();
  // 4. Branch down to one real grapheme + ellipsis, then omit colon as well.
  if (ref) ref = middle(originalRef, budget - visibleWidth(prefix + name) - 1);
  if (total() <= budget) return painted();
  // 5. Give the remaining parent-prefix columns to the complete last name.
  prefix = "";
  if (total() <= budget) return painted();
  // 6–7. Right-truncate the last name, never a sole ellipsis.
  name = end(name, budget);
  return name && name !== "…" && visibleWidth(name) > 1 ? painted() : "";
}

/** Plain-text suffix removal: native ANSI truncation inserts resets into ellipsis. */
function end(value: string, budget: number): string {
  if (budget <= 0) return "";
  if (visibleWidth(value) <= budget) return value;
  let prefix = "", used = 0;
  for (const part of segments.segment(value)) {
    const size = visibleWidth(part.segment);
    if (used + size > budget - 1) break;
    prefix += part.segment; used += size;
  }
  return prefix + "…";
}
