import { diagnose, diagnosticError, type DiagnosticSink } from './diagnostics.ts';
import { readFileSync, writeSync } from "node:fs";
import { colorToHex, mixColors, parseColor, rgbColor, type TerminalColors as ReportedColors } from "@earendil-works/pi-tui";
import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { CardTheme } from "./card-theme.ts";

export interface DefaultColors { foreground?: string; background?: string }
const defaultsKey = Symbol.for('pi-tidy-ui.terminal-defaults');
/** Only applied channel values survive runtime replacement, never a UI/session owner. */
export function processTerminalDefaults(): DefaultColors {
  const state = globalThis as typeof globalThis & { [defaultsKey]?: DefaultColors };
  if (!state[defaultsKey]) {
    const defaults: DefaultColors = {};
    state[defaultsKey] = defaults;
    process.once('exit', defaultColorCleanup(defaults));
  }
  return state[defaultsKey];
}
function defaultColorCleanup(defaults: DefaultColors): () => void {
  return () => {
    const packet = (defaults.background === undefined ? '' : '\x1b]111\x07') + (defaults.foreground === undefined ? '' : '\x1b]110\x07');
    try { if (packet) writeSync(1, packet); } catch { /* Best effort if stdout is already closed. */ }
    delete defaults.background; delete defaults.foreground;
  };
}
export interface ColorTheme extends CardTheme {
  readonly name?: string;
  readonly sourcePath?: string;
  getFgAnsi?(role: ThemeColor): string;
  getBgAnsi?(role: ThemeBg): string;
}
export interface ColorSnapshot {
  enabled: boolean;
  /** Cards remain active when only default-color application is locally disabled. */
  presenting?: boolean;
  /** Guarded current renderer flag, read only by the host adapter. */
  automatic: boolean | undefined;
  configured?: string;
  theme: ColorTheme;
}
export interface TerminalColorHost {
  diagnostic?: DiagnosticSink;
  /** Applied process defaults, or an isolated store for an embedded terminal. */
  defaults?: DefaultColors;
  snapshot(): ColorSnapshot;
  source(name?: string): string | undefined;
  write(data: string): void;
  read?(path: string): string;
  query?(late: (colors: ReportedColors) => void): Promise<ReportedColors>;
  /** Force terminal repaint only after a changed OSC packet, not RGB-only reports. */
  changed?(force?: boolean): void;
  warn?(message: string): void;
}
const backgroundRoles = new Set(["selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function section(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!object(value)) throw new TypeError(`Invalid theme ${label}`);
  return value;
}

/** Resolve only explicit terminal targets; absent/default values never become guessed RGB. */
export function resolveTerminalDefaults(value: unknown): DefaultColors {
  if (!object(value)) throw new TypeError("Invalid theme document");
  const vars = section(value.vars, "vars");
  function resolve(value: unknown): string | undefined {
    if (value === undefined || value === "") return undefined;
    const seen = new Set<string>();
    while (typeof value === "string" && !/^(?:#|oklch\(|okhsl\()/iu.test(value)) {
      if (!Object.hasOwn(vars, value)) throw new TypeError(`Unknown theme variable: ${value}`);
      if (seen.has(value)) throw new TypeError(`Circular theme variable: ${value}`);
      seen.add(value); value = vars[value];
      if (value === "") return undefined;
    }
    if (typeof value !== "string" && typeof value !== "number") throw new TypeError("Invalid theme color value");
    if (typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 255)) throw new RangeError("Theme color index must be 0–255");
    return colorToHex(parseColor(value));
  }
  return { foreground: resolve(section(value.colors, "colors").text), background: resolve(section(value.export, "export").pageBg) };
}
export function parseThemeDefaults(content: string): DefaultColors {
  return resolveTerminalDefaults(JSON.parse(content.replace(/^\uFEFF/u, "")));
}
function autoPair(setting: string | undefined): boolean {
  const parts = setting?.split("/");
  return !!parts && parts.length === 2 && parts.every(part => part.trim().length > 0);
}
function unavailable(snapshot: ColorSnapshot): string | undefined {
  if (!snapshot.enabled) return "off";
  if (snapshot.automatic === undefined) return "unsupported host";
  if (snapshot.automatic || autoPair(snapshot.configured)) return "automatic theme";
  if (snapshot.configured === "system" || snapshot.theme.name === "system") return "system theme";
  return undefined;
}
const stamp = ({ theme }: ColorSnapshot) => [theme.colors, theme.name, theme.sourcePath, theme.fg];
const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((value, index) => value === b[index]);
function reportedDefaults(colors: ReportedColors): DefaultColors {
  const result: DefaultColors = {};
  for (const key of ["foreground", "background"] as const) {
    const color = colors[key];
    if (color && [color.r, color.g, color.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255))
      result[key] = colorToHex(rgbColor(color.r, color.g, color.b));
  }
  return result;
}
/** Inspect SGR operations, not parameters inside an indexed/RGB color. */
function sgr(ansi: string, wanted: number): boolean {
  for (const match of ansi.matchAll(/\x1b\[([\d;]*)m/gu)) {
    const codes = match[1]!.split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 38 || codes[i] === 48) { i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0; continue; }
      if (codes[i] === wanted) return true;
    }
  }
  return false;
}
function defaultRole(theme: ColorTheme, role: string): { background: boolean; dim: boolean } | undefined {
  const background = backgroundRoles.has(role);
  try {
    const ansi = background ? theme.getBgAnsi?.(role as ThemeBg) : theme.getFgAnsi?.(role as ThemeColor);
    return ansi && sgr(ansi, background ? 49 : 39) ? { background, dim: !background && sgr(ansi, 2) } : undefined;
  } catch { return undefined; } // Preserve unfamiliar future tokens; our arithmetic uses known roles.
}

/** Latest rendered-color snapshot only: no timer, history scan, owner-keyed LRU or native theme mutation. */
export class TerminalColors {
  private applied: DefaultColors = {};
  private reported: DefaultColors = {};
  private revision: unknown[] | undefined;
  private sourceIdentity: { revision: unknown[]; path: string } | undefined;
  private generation = 0;
  private disposed = false;
  private state = "starting";
  private failure: string | undefined;
  private paletteStamp: unknown[] | undefined;
  private projected: CardTheme | undefined;
  private counters = { sourceReads: 0, sets: 0, releases: 0, packets: 0, reports: 0, staleReplies: 0, projections: 0, warnings: 0 };
  private host: TerminalColorHost;
  constructor(host: TerminalColorHost) { this.host = host; this.applied = { ...host.defaults }; }
  stats() { return { ...this.counters }; }
  status() { return { state: this.state, ...this.applied }; }
  private warn(message: string, explanation = 'Terminal color warning; raw error text excluded', error?: unknown) {
    if (message === this.failure) return;
    this.failure = message; this.counters.warnings++;
    diagnose(this.host.diagnostic, 'WARN', 'terminal-colors', explanation, { state: this.state, code: error === undefined ? undefined : diagnosticError(error) });
    this.host.warn?.(message);
  }
  private apply(next: DefaultColors): boolean {
    let packet = "", sets = 0, releases = 0;
    for (const [key, code] of [["background", 11], ["foreground", 10]] as const) {
      if (next[key] === this.applied[key]) continue;
      if (next[key] !== undefined) { packet += `\x1b]${code};${next[key]}\x07`; sets++; }
      else if (this.applied[key] !== undefined) { packet += `\x1b]${code + 100}\x07`; releases++; }
    }
    if (packet) {
      this.host.write(packet);
      this.counters.packets++; this.counters.sets += sets; this.counters.releases += releases;
      diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'Terminal-default changes written; raw OSC packet excluded', { sets, releases, foreground: next.foreground, background: next.background });
    }
    this.applied = { ...next };
    if (this.host.defaults) {
      for (const key of ['foreground', 'background'] as const) {
        if (next[key] === undefined) delete this.host.defaults[key];
        else this.host.defaults[key] = next[key];
      }
    }
    return !!packet;
  }
  private block(reason: string) {
    if (this.state === reason && !this.revision && !this.applied.foreground && !this.applied.background) return;
    this.generation++; this.revision = undefined; this.sourceIdentity = undefined; this.reported = {}; this.paletteStamp = undefined; this.projected = undefined;
    this.state = reason;
    diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'Terminal-default application suspended', { reason, generation: this.generation });
    try { if (this.apply({})) this.host.changed?.(true); }
    catch (error) { this.warn(`Could not release terminal colors: ${String(error)}`, 'Could not release terminal colors', error); }
    if (reason === "unsupported host") this.warn("Terminal colors unavailable: Pi's appearance flag is missing or incompatible");
  }
  private current(generation: number, revision: unknown[], presentationOnly = false): boolean {
    if (this.disposed || this.generation !== generation) return false;
    try {
      const snapshot = this.host.snapshot();
      const eligible = presentationOnly ? snapshot.presenting && !unavailable({ ...snapshot, enabled: true }) : !unavailable(snapshot);
      return !!eligible && same(revision, stamp(snapshot));
    } catch { return false; }
  }
  private queryDefaults(theme: ColorTheme, generation: number, revision: unknown[], presentationOnly = false) {
    const needsReport = Object.keys(theme.colors ?? {}).some(role => {
      const kind = defaultRole(theme, role);
      return kind && this.applied[kind.background ? "background" : "foreground"] === undefined;
    });
    if (!needsReport || !this.host.query) return;
    this.counters.reports++;
    diagnose(this.host.diagnostic, 'DEBUG', 'terminal-colors', 'Existing terminal-default query started; no extra query added', { generation, presentationOnly });
    const receive = terminalColorReport(new WeakRef(this), generation, revision, presentationOnly);
    try { this.host.query(receive).then(receive, ignoreColorReport); } catch { /* Unreported defaults stay native. */ }
  }
  /** Only weak query callbacks reach this method; stale generations cannot change presentation. */
  receiveReport(colors: ReportedColors, generation: number, revision: unknown[], presentationOnly = false): void {
    if (!this.current(generation, revision, presentationOnly)) { this.counters.staleReplies++;
      diagnose(this.host.diagnostic, 'DEBUG', 'terminal-colors', 'Late terminal-default report ignored', { generation }); return; }
    const incoming = reportedDefaults(colors);
    if (!incoming.foreground && !incoming.background) return;
    const next = { ...this.reported, ...incoming };
    if (next.foreground === this.reported.foreground && next.background === this.reported.background) return;
    this.reported = next; this.paletteStamp = undefined; this.projected = undefined;
    diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'Reported terminal defaults changed; projected card palette invalidated', { generation, ...next });
    this.host.changed?.();
  }
  /** Eligibility loss is synchronous; eligible file/query work is queued outside render. */
  observe(force = false): void {
    if (this.disposed) return;
    let snapshot: ColorSnapshot;
    try { snapshot = this.host.snapshot(); }
    catch { this.block("unsupported host"); return; }
    const reason = unavailable(snapshot);
    const revision = stamp(snapshot);
    if (reason === "off" && snapshot.presenting && !unavailable({ ...snapshot, enabled: true })) {
      if (this.state === "off" && same(this.revision, revision)) return;
      this.block("off"); this.revision = revision;
      const generation = ++this.generation;
      // Release synchronously, then learn profile RGB outside render. Never read theme metadata here.
      queueMicrotask(() => { if (this.current(generation, revision, true)) this.queryDefaults(this.host.snapshot().theme, generation, revision, true); });
      return;
    }
    if (reason) { this.block(reason); return; }
    if (!force && this.state !== "off" && same(this.revision, revision)) return;
    this.revision = revision;
    const generation = ++this.generation, name = snapshot.theme.name, path = snapshot.theme.sourcePath;
    queueMicrotask(() => {
      if (!this.current(generation, revision)) return;
      try {
        const source = path || this.host.source(name) || (same(this.sourceIdentity?.revision, revision) ? this.sourceIdentity?.path : undefined);
        if (!source) {
          const changed = this.apply({});
          this.sourceIdentity = undefined; this.reported = {}; this.paletteStamp = undefined; this.projected = undefined; this.state = "no source";
          diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'No file-backed theme source; terminal defaults remain native', { generation, theme: name });
          if (changed) { this.host.changed?.(true); this.queryDefaults(this.host.snapshot().theme, generation, revision); }
          return;
        }
        this.sourceIdentity = { revision, path: source };
        this.counters.sourceReads++;
        diagnose(this.host.diagnostic, 'DEBUG', 'terminal-colors', 'Reading terminal defaults from existing theme source', { generation, path: source, theme: name });
        const desired = parseThemeDefaults(this.host.read ? this.host.read(source) : readFileSync(source, "utf8"));
        if (!this.current(generation, revision)) return;
        const changed = this.apply(desired);
        this.reported = {}; this.paletteStamp = undefined; this.projected = undefined;
        this.state = "on"; this.failure = undefined;
        diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'Fixed-theme terminal defaults resolved', { generation, theme: name, ...desired });
        if (changed) this.host.changed?.(true);
        this.queryDefaults(this.host.snapshot().theme, generation, revision);
      } catch (error) { if (this.current(generation, revision)) { this.state = "source error"; this.warn(`Could not read terminal theme colors: ${String(error)}`, 'Theme-default resolution failed; last valid applied colors retained', error); } }
    });
  }
  palette(theme: ColorTheme): CardTheme {
    if (this.disposed || !["on", "source error", "off", "no source"].includes(this.state) || !theme.colors) return theme;
    const foreground = this.applied.foreground ?? this.reported.foreground, background = this.applied.background ?? this.reported.background;
    const signature = [theme.colors, theme.fg, theme.bg, theme.style, foreground, background];
    if (same(this.paletteStamp, signature)) return this.projected!;
    this.paletteStamp = signature; this.counters.projections++;
    let colors: NonNullable<CardTheme["colors"]> | undefined;
    for (const [role, original] of Object.entries(theme.colors)) {
      const kind = defaultRole(theme, role), value = kind?.background ? background : foreground;
      if (!kind || !value || !original) continue;
      let concrete = parseColor(value);
      if (kind.dim && background) concrete = mixColors(concrete, parseColor(background), 0.5, "srgb");
      if (colorToHex(concrete) === colorToHex(original)) continue;
      colors ??= { ...theme.colors };
      (colors as Record<string, typeof concrete>)[role] = concrete;
    }
    this.projected = colors ? { colors, fg: theme.fg.bind(theme), bg: theme.bg?.bind(theme), style: theme.style?.bind(theme) } : theme;
    diagnose(this.host.diagnostic, 'DEBUG', 'terminal-colors', 'Cached local card palette projection rebuilt; native Pi theme unchanged', { state: this.state, projected: !!colors });
    return this.projected;
  }
  dispose({ preserveDefaults = false } = {}): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.revision = undefined; this.sourceIdentity = undefined; this.reported = {}; this.paletteStamp = undefined; this.projected = undefined;
    if (!preserveDefaults) try { this.apply({}); } catch { /* Best effort once the terminal is gone. */ }
    this.state = "off";
    diagnose(this.host.diagnostic, 'INFO', 'terminal-colors', 'Terminal-color observer disposed', { preserveDefaults });
  }
}

/** Separate weak-only closure: an exit listener must not root the adapter or its live UI. */
export function terminalColorExit(reference: WeakRef<TerminalColors>): () => void {
  return () => reference.deref()?.dispose();
}

function terminalColorReport(reference: WeakRef<TerminalColors>, generation: number, revision: unknown[], presentationOnly: boolean): (colors: ReportedColors) => void {
  return colors => reference.deref()?.receiveReport(colors, generation, revision, presentationOnly);
}
function ignoreColorReport(): void {}
