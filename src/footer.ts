import type { ContextUsage, SessionEntry, ThemeColor } from "@earendil-works/pi-coding-agent";
import { diagnose, type DiagnosticSink } from './diagnostics.ts';
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { layoutMemory, type LayoutMemory } from "./render-cache.ts";

/** Source-only switches; reload after changing them. No runtime setting or command. */
export const FOOTER_FIELDS = { tokenTotals: false, cacheTotals: false, cost: false };
const HISTORY_SIZE = 10;
const BARS = [..."▁▂▃▄▅▆▇█"];

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate?: number;
  cacheHitHistory: readonly (number | undefined)[];
}
export interface FooterData {
  usage: FooterUsage;
  context?: ContextUsage;
  auto: boolean;
  subscription: boolean;
}
interface FooterTheme { fg(color: ThemeColor, text: string): string }
const counters = { aggregations: 0, entries: 0, layouts: 0 };
/** Numeric test observations only; never retains a session/component. */
export const footerDiagnostics = () => ({ ...counters });

/** Unknown is not zero; trust normalized Pi usage, not provider capability guesses. */
function cacheRate(usage: Pick<FooterUsage, "input" | "cacheRead" | "cacheWrite"> | undefined): number | undefined {
  if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0)) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 && Number.isFinite(prompt) ? usage.cacheRead / prompt * 100 : undefined;
}

/** Match native cumulative accounting; retain ten primary reports, not ten distinct percentages. */
export function footerUsage(entries: readonly SessionEntry[]): FooterUsage {
  counters.aggregations++;
  const history: (number | undefined)[] = [];
  const total: FooterUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitHistory: history };
  for (const entry of entries) {
    counters.entries++;
    let usage;
    if (entry.type === "usage") usage = entry.usage;
    else if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      total.cacheHitRate = cacheRate(usage);
      history.push(total.cacheHitRate);
      if (history.length > HISTORY_SIZE) history.shift();
    } else if (entry.type === "message" && entry.message.role === "toolResult") usage = entry.message.usage;
    else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
    if (!usage) continue;
    total.input += usage.input; total.output += usage.output;
    total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite; total.cost += usage.cost.total;
  }
  return total;
}

/** Stock Pi compact format for cumulative counters, independent of context format. */
function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return (count / 1000).toFixed(1) + "k";
  if (count < 1000000) return Math.round(count / 1000) + "k";
  if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
  return Math.round(count / 1000000) + "M";
}
export function contextTokens(count: number): string {
  const thousands = Math.round(count / 1000);
  if (thousands < 1000) return thousands + "k";
  // Normalize rounding carries before selecting precision (9.995M -> 10.0M).
  const value = count / 1000000;
  const millions = value < 100 ? Number(value.toPrecision(3)) : Math.round(value);
  return millions.toFixed(millions < 10 ? 2 : millions < 100 ? 1 : 0) + "M";
}
const cacheColor = (rate: number): ThemeColor => rate >= 95 ? "success" : rate < 80 ? "error" : "warning";
function cacheGauge(history: FooterUsage["cacheHitHistory"], theme: FooterTheme): string {
  const latest = history.slice(-HISTORY_SIZE);
  const marks = theme.fg("muted", "·".repeat(HISTORY_SIZE - latest.length)) + latest.map(raw => {
    if (raw === undefined) return theme.fg("muted", "·");
    const rate = Number(raw.toFixed(1));
    return theme.fg(cacheColor(rate), BARS[Math.round(7 * (1 - rate / 100))]!);
  }).join("");
  return theme.fg("dim", "[") + marks + theme.fg("dim", "]");
}
function metrics(data: FooterData, theme: FooterTheme, fields: typeof FOOTER_FIELDS): string {
  const f = (role: ThemeColor, value: string) => theme.fg(role, value);
  const punctuation = (value: string) => f("dim", value);
  const parens = (value: string, role: ThemeColor = "muted") => punctuation("(") + f(role, value) + punctuation(")");
  const u = data.usage;
  const parts: string[] = [];
  if (fields.tokenTotals) parts.push(f("text", "↑") + f("muted", tokens(u.input)), f("text", "↓") + f("muted", tokens(u.output)));
  const context: string[] = [];
  if (data.context) {
    const c = data.context;
    context.push(f("text", c.tokens === null ? "?" : contextTokens(c.tokens)) + punctuation("/") + f("muted", contextTokens(c.contextWindow)));
    if (c.percent !== null) context.push(parens(c.percent.toFixed(1) + "%", c.percent > 90 ? "error" : c.percent > 70 ? "warning" : "muted"));
  }
  if (!data.auto) context.push(parens("auto off", "warning"));
  const cache: string[] = [];
  if (fields.cacheTotals) {
    if (u.cacheRead) cache.push(f("text", "R") + f("muted", tokens(u.cacheRead)));
    if (u.cacheWrite) cache.push(f("text", "W") + f("muted", tokens(u.cacheWrite)));
  }
  const ch = u.cacheHitRate === undefined ? f("muted", "CH—") : f(cacheColor(Number(u.cacheHitRate.toFixed(1))), "CH" + u.cacheHitRate.toFixed(1) + "%");
  cache.push(cacheGauge(u.cacheHitHistory, theme) + " " + ch);
  parts.push(cache.join(" ") + (context.length ? punctuation(" • ") + context.join(" ") : ""));
  if (fields.cost && (u.cost || data.subscription)) parts.push(f("text", "$") + f("muted", u.cost.toFixed(3)) + (data.subscription ? " " + parens("sub") : ""));
  return parts.join(" ");
}
const RESET = "\x1b[0m";
const CLOSE_LINK = "\x1b]8;;\x1b\\";
const isolated = (text: string) => RESET + text + CLOSE_LINK + RESET;

/** Pure width fitting: preserve producer ANSI, never parse extension-specific values. */
export function renderFooter(width: number, data: FooterData, statuses: readonly (readonly [string, string])[], theme: FooterTheme, fields = FOOTER_FIELDS): string[] {
  if (width < 1) return [];
  counters.layouts++;
  const left: string[] = [];
  const stats = truncateToWidth(metrics(data, theme, fields), width, theme.fg("dim", "…"));
  let leftRow = stats, leftWidth = visibleWidth(stats), right = "", rightWidth = 0;
  const flush = () => {
    if (right) left.push(leftRow + " ".repeat(Math.max(0, width - leftWidth - rightWidth)) + right);
    else if (leftRow) left.push(leftRow);
    leftRow = ""; leftWidth = 0; right = ""; rightWidth = 0;
  };
  for (const [, value] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
    const clean = value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
    const size = visibleWidth(clean);
    if (!size) continue;
    const required = rightWidth + (right ? 3 : 0) + size;
    if (leftWidth + (leftWidth ? 2 : 0) + required > width) flush();
    const fitted = size > width ? truncateToWidth(clean, width, theme.fg("dim", "…")) : clean;
    const fittedWidth = visibleWidth(fitted);
    right += (right ? isolated(theme.fg("dim", " • ")) : "") + isolated(fitted);
    rightWidth += (rightWidth ? 3 : 0) + fittedWidth;
  }
  flush();
  return left;
}

/** One latest transient layout per live footer, not a transcript/body cache pool. */
export class FooterView implements Component {
  private rows?: string[];
  private width = -1;
  private data?: FooterData;
  private theme?: FooterTheme;
  private statuses: readonly (readonly [string, string])[] = [];
  private readonly read: () => FooterData;
  private readonly readStatuses: () => ReadonlyMap<string, string>;
  private readonly readTheme: () => FooterTheme;
  private readonly isActive: () => boolean;
  private readonly diagnostic?: DiagnosticSink;
  constructor(read: () => FooterData, readStatuses: () => ReadonlyMap<string, string>, readTheme: () => FooterTheme, isActive: () => boolean = () => true, diagnostic?: DiagnosticSink) {
    this.read = read; this.readStatuses = readStatuses; this.readTheme = readTheme; this.isActive = isActive; this.diagnostic = diagnostic;
  }
  render(width: number): string[] {
    if (width < 1 || !this.isActive()) return [];
    const data = this.read(), theme = this.readTheme(), statuses = [...this.readStatuses()];
    if (this.rows && this.width === width && this.data === data && this.theme === theme &&
      this.statuses.length === statuses.length && this.statuses.every(([key, value], i) => key === statuses[i]?.[0] && value === statuses[i]?.[1])) return this.rows;
    this.width = width; this.data = data; this.theme = theme; this.statuses = statuses;
    this.rows = renderFooter(width, data, statuses, theme);
    diagnose(this.diagnostic, 'DEBUG', 'footer', 'Footer layout rebuilt from existing snapshots; producer status strings excluded', { width, rows: this.rows.length, statuses: statuses.length });
    return this.rows;
  }
  /** On-demand retained-row estimate; never reads session data or rebuilds the footer. */
  retainedMemory(): LayoutMemory {
    return this.rows ? layoutMemory(this.rows) : { retainedBytes: 0, stringBytes: 0, overheadBytes: 0, entries: 0, rows: 0 };
  }
  invalidate(): void { if (this.rows) diagnose(this.diagnostic, 'DEBUG', 'footer', 'Existing footer layout invalidated'); this.rows = undefined; }
  clear(): void { if (this.rows || this.data) diagnose(this.diagnostic, 'DEBUG', 'footer', 'Footer snapshots and layout cleared'); this.rows = undefined; this.data = undefined; this.theme = undefined; this.statuses = []; }
}
