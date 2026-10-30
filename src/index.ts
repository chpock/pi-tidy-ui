import { VERSION, CustomEditor, createEditToolDefinition, highlightCode, getLanguageFromPath, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Editor, Markdown, Spacer, TruncatedText, backgroundAnsi, visibleWidth, type TerminalColorMode, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { SessionLogging } from "./session-logging.ts";
import { RuntimeHealth } from './runtime-health.ts';
import { ExtensionSettings, processPreferences, type LocalPreferences, type SettingsLoadResult, type SyntaxTheme } from './settings.ts';
import { bindTerminalLifecycle } from "./terminal-lifecycle.ts";
import { TidyMenu, type TidyMenuOwner, type TidyMenuAction } from './tidy-menu.ts';
import type { SyntaxMenuOutcome } from './occipital/menu.ts';
import { type JournalOptions } from "./debug-log.ts";
import { diagnose, reportRuntime, type DiagnosticFields, type DiagnosticSink } from "./diagnostics.ts";
import { stripVTControlCharacters } from "node:util";
import { bashFailurePhase } from "./bash-card.ts";
import { filePath } from "./file-card.ts";
import { reflow } from './syntax/measured-rows.ts';
import { renderUserCard } from "./user-card.ts";
import { prepareQueuedCard, projectQueuedCards, type QueuedCard } from "./queued-card.ts";
import { EDITOR_TOP, EDITOR_BOTTOM, renderEditorCard, type EditorLayout } from "./editor-card.ts";
import { cardGeometry, insidePanel } from "./card-frame.ts";
import { renderEditorStatus, type EditorStatusInfo } from "./editor-status.ts";
import { GitBranchSource, gitDiagnostics } from "./git-branch.ts";
import { FOOTER_FIELDS, FooterView, footerFirstMessage, footerUsage, type FooterData } from "./footer.ts";
import { TerminalColors, processTerminalDefaults, type DefaultColors } from "./terminal-colors.ts";
import type { CardTheme } from "./card-theme.ts";
import { RenderCache, LAYOUT_KINDS, MEMORY_FIELDS, type LayoutKind, type LayoutMemory, type CacheEntry, type CacheStats } from "./render-cache.ts";
import { argumentParts, summaryName } from "./summary-args.ts";
import { CardSources, type CardPreparation } from "./syntax/cards.ts";
import { layoutCard, type CardLayout, type CardRows, type BashPaintProof } from './syntax/card-layout.ts';
import { PaletteInputOwner } from './syntax/pi-input-owner.ts';
import type { PiInputTheme, PaletteInputLease } from './syntax/pi-input.ts';
import { resolveTheme, type ThemeDescription } from './themes/selection.ts';
import { SourceController, type GeometryFunding } from './occipital/controller.ts';
import type { PiClassifier } from "./syntax/work.ts";
import type { SyntaxClient } from "./occipital/client.ts";
import { createSyntaxOptions } from "./occipital/bootstrap.ts";
import { SyntaxRuntime, type SyntaxRuntimeOptions } from "./syntax/runtime.ts";
export { describeArgs, sanitize } from "./summary-args.ts";
const extensionVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
let terminalColorDebug: WeakRef<TerminalColors> | undefined;
let loggingDebug: WeakRef<SessionLogging> | undefined;
/** Existing in-memory journal status only, for actual CLI overhead controls. */
export function debugLoggingDiagnostics() { return loggingDebug?.deref()?.status(); }
/** Primitive current-instance counters for controlled CLI diagnostics; no retained owner. */
export function terminalColorDiagnostics() {
  const view = terminalColorDebug?.deref();
  return view ? { status: view.status(), counters: view.stats() } : undefined;
}

/** The private contract verified against Pi 1.0.0; never import a second internal class. */
interface ToolNode extends Component {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expanded: boolean;
  hideComponent: boolean;
  isPartial: boolean;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown; role?: unknown };
  markExecutionStarted(): void;
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  setExpanded(expanded: boolean): void;
  getRenderContext(): unknown;
  getRenderShell(): string;
  callRendererComponent?: Component;
  getCallRenderer?(): unknown;
  getResultRenderer?(): unknown;
}
interface UserNode extends Container {
  text: string;
  outputPad: number;
  markdownTheme: object;
  markdownTransformers: unknown[];
  rebuild(): void;
  setOutputPad(padding: number): void;
}
type UserRender = (this: UserNode, width: number) => string[];
const userCandidate = (node: Component): node is UserNode =>
  node instanceof Container && node.constructor.name === "UserMessageComponent";
const compatibleUser = (node: UserNode) => typeof node.text === "string" &&
  Number.isSafeInteger(node.outputPad) && node.outputPad >= 0 &&
  typeof node.markdownTheme === "object" && node.markdownTheme !== null && Array.isArray(node.markdownTransformers) &&
  typeof node.rebuild === "function" && typeof node.setOutputPad === "function" &&
  node.children.length === 1 && node.children[0] instanceof Markdown;

type LiveTui = Component & {
  requestRender(): void;
  terminal?: { readonly rows: number };
  hasActiveSelection?(): boolean;
  getFocusedComponent?(): Component | null;
  setFocus?(component: Component | null): void;
};
type Palette = CardTheme;
/** Approved one-field read; never infer absence/unknown shape as fixed mode. */
export function terminalAppearanceTracking(tui: object): boolean | undefined {
  try {
    const value: unknown = Reflect.get(tui, "terminalColorSchemeNotificationsEnabled");
    return typeof value === "boolean" ? value : undefined;
  } catch { return undefined; }
}
type Render = (this: ToolNode, width: number) => string[];
type Mouse = (this: ToolNode, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

export interface TidyUiOptions {
  diagnostic?: DiagnosticSink;
  cardPreparation?: (event: CardPreparation & { call: string; tool: string }) => void;
  /** Optional composed client; lifecycle/startup remains the caller's responsibility. */
  syntax?: {
    client: Pick<SyntaxClient, "sources" | "snapshot">;
    /** Established cheap Pi palette generation, never color sampling or theme inference. */
    palette(): number;
    classify?: PiClassifier;
    /** Public streaming-event identity; absent embedders conservatively treat formation errors as live. */
    isLiveCall?(toolCallId: string): boolean;
  };
  /** Coherent public Pi data; projected colors and actual public ANSI getters. */
  piInput?: () => { theme: PiInputTheme; mode: TerminalColorMode };
  /** Terminal output mode without reading Pi colors for an owned palette. */
  colorMode?: () => TerminalColorMode;
  preparePaletteInput?: (palette: ThemeDescription, theme: PiInputTheme | undefined, revision: number, mode: TerminalColorMode,
    funding: GeometryFunding, usePiFallback?: boolean, fallbackTheme?: () => PiInputTheme) => PaletteInputLease | undefined;
  /** Pi-only fallback for isolated embedders that do not supply the generic lease owner. */
  preparePiInput?: (theme: PiInputTheme, mode: TerminalColorMode, funding: GeometryFunding) => PaletteInputLease | undefined;
  cards?: readonly string[];
  compact?: readonly string[];
  warn?: (reason: string) => void;
  /** Current effective Pi Output padding (0 or 1); no settings mutation. */
  outputPad?: () => number;
  /** Do not compete with a public editor factory owned by another extension. */
  nativeEditor?: () => boolean;
  /** The runtime has a public belowEditor metadata widget. */
  editorStatus?: boolean;
  /** Public setEditorComponent(undefined), retaining the same stock default editor. */
  rerouteEditorStatus?: () => void;
  editorStatusRestored?: () => void;
}
export interface TidyUiCacheStats extends CacheStats { ordinary: CacheStats; cards: CacheStats }
export interface TidyUiController {
  readonly active: boolean;
  readonly reason: string | undefined;
  readonly editorStatusActive: boolean;
  /** Recognized input ownership, including temporary native selector detachment. */
  readonly editorActive: boolean;
  /** Stop new presentation work while existing layouts remain usable until restore. */
  quiesce(): void;
  restore(options?: { repaint?: boolean }): void;
  renderEditorStatus(width: number, info: EditorStatusInfo): string[];
  cacheStats(): TidyUiCacheStats;
  /** Explicit diagnostic command only; does not render or advance a clock. */
  logSnapshot(): void;
  clearCache(): void;
  /** Forward composed-client notices without traversing transcript history. */
  syntaxSourceChanged(keys: readonly string[], groups?: readonly number[]): void;
  syntaxMetadataChanged(): void;
}
function preparedRelease(receipts: { geometry?: { release(): void }; output: { release(): void } }) {
  return { release() { receipts.geometry?.release(); receipts.geometry = undefined; receipts.output.release(); } };
}
function localCardNotice(owner: WeakRef<TidyUiController>) {
  return (keys: readonly string[], groups?: readonly number[]) => owner.deref()?.syntaxSourceChanged(keys, groups);
}
type PreparedCardController = TidyUiController & { refreshPreparedPalette(node: ToolNode): void; retireRendererClears(): void };
function rendererClearRetirement(adapter: WeakRef<PreparedCardController>) {
  return () => adapter.deref()?.retireRendererClears();
}
function paletteRefresh(owner: WeakRef<ToolNode>, adapter: WeakRef<PreparedCardController>) {
  return () => { const node = owner.deref(), host = adapter.deref(); if (node && host?.active) host.refreshPreparedPalette(node); };
}
const DEFAULT_CARDS = ["bash", "powershell", "write", "edit"];
// The public factory exposes the stable stock renderer functions; no execution or file I/O.
const { renderCall: stockEditCall, renderResult: stockEditResult } = createEditToolDefinition(".");
// Controls all trailing status markers, including the pending ellipsis, not the leading spinner.
const SHOW_COMPLETION_MARKERS = false;
const SPINNER_FRAMES = Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
const SPINNER_INTERVAL_MS = 100;


const summaryGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Keep Pi's CJK/space boundaries and the existing parameter-comma soft breaks.
const summaryCjkBreak = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const SUMMARY_SPLIT_LOOKBACK = 20;
// Path/URL/identifier separators, not quotes or brackets. Match whole graphemes.
const summarySplitSeparators = new Set(["/", "\\", ".", "-", "_", ":", ",", ";", "?", "!", "&", "=", "+", "@", "#", "%"]);

/** Wrap plain source before coloring; only oversized tokens gain preferred cuts. */
function wrapSummary(text: string, width: number, parameterStart: number, parameterLength: number): string[] {
  const tokens: { text: string; start: number }[] = [];
  const preferred = new Set<number>();
  let word = "", wordStart = 0, wordIsSpace = false, quoted = false, escapeEnd = 0;
  const flushWord = () => { if (word) tokens.push({ text: word, start: wordStart }); word = ""; };
  for (const { segment, index } of summaryGraphemes.segment(text)) {
    const end = index + segment.length;
    // JSON syntax and grapheme boundaries are independent: quotes may share a
    // grapheme with following marks or preceding Unicode Prepend characters.
    // Visit every code unit for ASCII syntax; prefer cuts only after whole units.
    for (let position = index; position < end; position++) {
      if (position < escapeEnd) continue;
      if (text[position] === '"') quoted = !quoted;
      else if (quoted && text[position] === "\\") {
        const escape = /^\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/u.exec(text.slice(position, position + 6));
        if (escape) escapeEnd = position + escape[0].length;
      }
    }
    if (summarySplitSeparators.has(segment) && end >= escapeEnd) preferred.add(end);
    if (summaryCjkBreak.test(segment)) {
      flushWord(); tokens.push({ text: segment, start: index }); continue;
    }
    const space = segment === " ";
    if (word && wordIsSpace !== space) flushWord();
    if (!word) wordStart = index;
    word += segment;
    wordIsSpace = space;
    if (segment === "," && index >= parameterStart && index < parameterStart + parameterLength) flushWord();
  }
  flushWord();
  const rows: string[] = [];
  let line = "", lineWidth = 0;
  const flush = () => { if (line.trimEnd()) rows.push(line.trimEnd()); line = ""; lineWidth = 0; };
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token.text);
    const whitespace = token.text.trim() === "";
    if (tokenWidth > width && !whitespace) {
      // Segment this oversized token once. Prefix widths make each bounded
      // lookback constant work; no rescanning the remaining suffix per row.
      const units = Array.from(summaryGraphemes.segment(token.text));
      const columns = [0];
      for (const unit of units) columns.push(columns.at(-1)! + visibleWidth(unit.segment));
      let from = 0;
      while (from < units.length) {
        const remaining = width - lineWidth;
        let hardEnd = from;
        while (hardEnd < units.length && columns[hardEnd + 1]! - columns[from]! <= remaining) hardEnd++;
        if (hardEnd === from && line) { flush(); continue; }
        // Preserve an indivisible over-wide grapheme at impossible tiny widths,
        // rather than dropping it or looping without progress, as native does.
        if (hardEnd === from) hardEnd++;
        let cut = hardEnd;
        if (hardEnd < units.length) {
          for (let candidate = hardEnd; candidate > from && hardEnd - candidate <= SUMMARY_SPLIT_LOOKBACK; candidate--) {
            const end = units[candidate - 1]!.index + units[candidate - 1]!.segment.length;
            const filled = columns[candidate]! - columns[from]!;
            if (filled * 2 < remaining) break; // Never waste over half this row's free columns.
            if (preferred.has(token.start + end)) { cut = candidate; break; }
          }
        }
        const end = cut < units.length ? units[cut]!.index : token.text.length;
        line += token.text.slice(units[from]!.index, end);
        lineWidth += columns[cut]! - columns[from]!;
        from = cut;
        if (from < units.length) flush();
      }
    } else if (lineWidth + tokenWidth > width) {
      flush();
      if (!whitespace) { line = token.text; lineWidth = tokenWidth; }
    } else {
      if (!line && whitespace) continue;
      line += token.text;
      lineWidth += tokenWidth;
    }
  }
  flush();
  return rows;
}


function candidate(node: Component): node is ToolNode {
  const tool = node as Partial<ToolNode>;
  return typeof tool.toolCallId === "string" && typeof tool.toolName === "string";
}
function compatible(node: ToolNode): boolean {
  return node instanceof Container && typeof node.expanded === "boolean" &&
    typeof node.hideComponent === "boolean" && typeof node.isPartial === "boolean" &&
    typeof node.executionStarted === "boolean" && typeof node.argsComplete === "boolean" &&
    !!node.args && typeof node.args === "object" && !Array.isArray(node.args) &&
    typeof node.markExecutionStarted === "function" && typeof node.updateArgs === "function" && typeof node.updateResult === "function" &&
    typeof node.setExpanded === "function" && typeof node.getRenderContext === "function" &&
    typeof node.getRenderShell === "function" &&
    typeof node.render === "function" && typeof node.handleMouse === "function";
}

function bashDirectory(node: ToolNode): string | null | undefined {
  if (typeof node.args.workdir !== "string" || !node.args.workdir.length) return undefined;
  const context = node.getRenderContext() as { cwd?: unknown } | null | undefined;
  if (typeof context?.cwd !== "string" || !isAbsolute(context.cwd)) return null;
  const directory = resolve(context.cwd, node.args.workdir);
  return directory === resolve(context.cwd) ? undefined : directory;
}

/** The only compatibility-sensitive adapter. It does not change tools or session entries. */
export function installTidyUi(tui: LiveTui, getTheme: () => Palette, options: TidyUiOptions = {}): TidyUiController {
  let active = false;
  let reason: string | undefined;
  const parents = new WeakMap<Component, { parent: Container; index: number }>();
  let rendererClears: WeakRef<Component>[] = [], rendererClearPending = false;
  const cache = new RenderCache();
  const cardCache = new RenderCache();
  const decisions = new WeakMap<object, Map<string, { choice: string; width: number; rows: number; geometry?: string }>>();
  function decision(owner: object, area: string, choice: string, width: number, rows: number, fields?: DiagnosticFields, geometry?: string): void {
    if (!options.diagnostic) return;
    let marks = decisions.get(owner);
    const previous = marks?.get(area);
    if (previous?.choice === choice && previous.width === width && previous.rows === rows && previous.geometry === geometry) return;
    if (!marks) { marks = new Map(); decisions.set(owner, marks); }
    marks.set(area, { choice, width, rows, geometry });
    diagnose(options.diagnostic, "DEBUG", area, choice, { width, rows, ...fields });
  }
  let lifecycleCallbacks = 0, lifecyclePhaseChanges = 0;
  function nativePhase(node: ToolNode, operation: string): void {
    lifecycleCallbacks++;
    if (!options.diagnostic) return;
    const phase = String(Number(node.isPartial) | Number(node.argsComplete) << 1 | Number(node.executionStarted) << 2
      | Number(node.expanded) << 3 | Number(!!node.result) << 4 | Number(node.result?.isError === true) << 5);
    if (decisions.get(node)?.get('tool-phase')?.geometry === phase) return;
    lifecyclePhaseChanges++;
    decision(node, 'tool-phase', 'Native tool phase changed; repeated same-phase callbacks counted only', 0, 0,
      { call: node.toolCallId, tool: node.toolName, operation, partial: node.isPartial, complete: node.argsComplete,
        executing: node.executionStarted, expanded: node.expanded, result: !!node.result, error: node.result?.isError === true }, phase);
  }
  function toolDecision(node: ToolNode, choice: string, width: number, rows: number): void {
    if (options.diagnostic) decision(node, "tool", choice, width, rows, { call: node.toolCallId, tool: node.toolName,
      expanded: node.expanded, hidden: node.hideComponent, partial: node.isPartial, complete: node.argsComplete });
  }
  type Layout = { rows: string[]; framed?: boolean; native?: boolean };
  type PreparedLayout = { scene: CardLayout; output: CardRows; width: number; padding: number; expanded: boolean;
    geometryStamp: number; paintStamp: number; publication: number; origin: 'owned' | 'pi'; gap?: number };
  let preparedStates = new WeakMap<ToolNode, CacheEntry<PreparedLayout>>();
  const preparedPools = new WeakMap<CacheEntry<PreparedLayout>, RenderCache>();
  function dropPrepared(node: ToolNode) {
    const entry = preparedStates.get(node); if (entry) preparedPools.get(entry)?.drop(entry);
    preparedStates.delete(node);
  }
  type SummaryLayout = Layout & { prefixLength: number; prefixLeft: number; prefixSpace: boolean };
  // One plain snapshot per normal transcript pass; direct component visits read live settings.
  let passOutputPad: number | undefined;
  const outputPadding = () => passOutputPad ?? (options.outputPad?.() === 0 ? 0 : 1);
  let quiescing = false;
  const animated = new Set<WeakRef<ToolNode>>();
  let animationRefs = new WeakMap<ToolNode, WeakRef<ToolNode>>();
  let spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerEpoch: number | undefined, passSpinnerTime: number | undefined;
  let spinnerGeneration = 0, spinnerPending = false;
  let spinnerWakes = 0, spinnerRequests = 0;
  function stopSpinner() {
    if (spinnerTimer !== undefined) clearTimeout(spinnerTimer);
    spinnerTimer = undefined;
    spinnerGeneration++; // Cancel callbacks already queued for the old deadline/lifecycle.
    spinnerPending = false;
    spinnerEpoch = undefined;
  }
  function removeAnimation(node: ToolNode) {
    const reference = animationRefs.get(node);
    if (reference) { animated.delete(reference); animationRefs.delete(node);
      diagnose(options.diagnostic, "DEBUG", "animation", "Tool stopped participating in the existing spinner", { call: node.toolCallId, tool: node.toolName }); }
    if (!animated.size) stopSpinner();
  }
  // Public tree edges also recognize the stable TUI proxy without probing its receiver.
  function attached(node: Component): boolean {
    let current = node;
    while (current !== tui) {
      if (current instanceof Container && tui instanceof Container && current.children === tui.children) return true;
      const position = parents.get(current);
      if (!position) return false;
      const children = position.parent.children;
      if (children[position.index] !== current) position.index = children.indexOf(current);
      if (position.index < 0) return false;
      current = position.parent;
    }
    return true;
  }
  const executing = (node: ToolNode) => node.executionStarted && (node.isPartial || !node.result) && eligible(node);
  function pruneAnimation() {
    // Only the small weak set of painted running calls, never a full transcript traversal.
    for (const reference of animated) {
      const node = reference.deref();
      if (!node) animated.delete(reference);
      else if (!executing(node) || !attached(node)) removeAnimation(node);
    }
    if (!animated.size) stopSpinner();
  }
  function armSpinner() {
    if (!active || quiescing || !animated.size || spinnerPending) return;
    if (spinnerTimer !== undefined) clearTimeout(spinnerTimer);
    const generation = ++spinnerGeneration;
    // Native Working already drives whole-document frames. This is a fallback
    // after 100ms without a successful document visit, not another periodic clock.
    // Construct it here, never in animate(node)'s component-containing scope.
    spinnerTimer = setTimeout(function tickSpinner() {
      if (!active || generation !== spinnerGeneration) return;
      spinnerTimer = undefined;
      spinnerWakes++;
      pruneAnimation();
      if (!animated.size) return;
      spinnerPending = true; // Wait for the host visit; do not flood a delayed/stopped TUI.
      spinnerRequests++;
      tui.requestRender(); // No global/native invalidation or custom body rebuild.
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref?.();
  }
  function finishSpinnerPass() {
    if (!active) return;
    // Also prune on host-driven passes: Working may prevent the fallback from
    // ever firing, so timeout-only cleanup would keep silent detachments alive.
    pruneAnimation();
    spinnerPending = false;
    armSpinner();
  }
  function animate(node: ToolNode) {
    if (!executing(node) || !attached(node)) { removeAnimation(node); return; }
    if (!animationRefs.has(node)) {
      const reference = new WeakRef(node); animationRefs.set(node, reference); animated.add(reference);
      diagnose(options.diagnostic, "DEBUG", "animation", "Tool participates in the existing spinner; no logging clock added", { call: node.toolCallId, tool: node.toolName });
    }
    spinnerEpoch ??= passSpinnerTime ?? performance.now();
    // Normal document passes arm once on successful return. Direct tool visits
    // may start participation, but cannot acknowledge/postpone an existing frame.
    if (passSpinnerTime === undefined && spinnerTimer === undefined) armSpinner();
  }
  let states = new WeakMap<ToolNode, { signature: unknown[]; entry: CacheEntry<Layout>; pool: RenderCache; gap?: number }>();
  const forget = (node: ToolNode, cause = "source or lifecycle changed") => { const state = states.get(node); state?.pool.drop(state.entry); states.delete(node);
    if (state) diagnose(options.diagnostic, "DEBUG", "cache", "Tool layout invalidated", { call: node.toolCallId, tool: node.toolName, cause }); };
  let userStates = new WeakMap<UserNode, { signature: unknown[]; entry: CacheEntry<Layout> }>();
  const forgetUser = (node: UserNode) => { cache.drop(userStates.get(node)?.entry); userStates.delete(node); };
  let queuedStates = new WeakMap<Component, { signature: unknown[]; entry: CacheEntry<QueuedCard> }>();
  const forgetQueued = (node: Component) => { cache.drop(queuedStates.get(node)?.entry); queuedStates.delete(node); };
  const clearCache = () => { cache.clear(); cardCache.clear(); preparedStates = new WeakMap(); states = new WeakMap(); userStates = new WeakMap(); queuedStates = new WeakMap();
    diagnose(options.diagnostic, "INFO", "cache", "Presentation layouts cleared; native/source caches are unchanged"); };
  const cards = new Set([...DEFAULT_CARDS, ...options.cards ?? []]);
  const overrides = new Set(options.compact ?? []);
  const nativeOverrides = new Set(options.cards ?? []);
  const originalAdd = Container.prototype.addChild;
  const containerRender = Object.getOwnPropertyDescriptor(Container.prototype, "render")!;
  const containerClear = Container.prototype.clear;
  const containerRemove = Container.prototype.removeChild;
  const spacerRender = Object.getOwnPropertyDescriptor(Spacer.prototype, "render")!;
  const truncatedRender = TruncatedText.prototype.render, truncatedInvalidate = TruncatedText.prototype.invalidate;
  let widgetSpacerPass: { spacer: Spacer; width: number; rows?: number; blank?: boolean } | undefined;
  let upperWidgetRows = new WeakMap<Container, { width: number; rows: number; spacer: WeakRef<Spacer> }>();
  const patches = new Map<object, {
    render: PropertyDescriptor; mouse: PropertyDescriptor; patchedRender: Render; patchedMouse: Mouse;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();

  const userPatches = new Map<object, {
    render: PropertyDescriptor; patchedRender: UserRender;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();
  const refresh = () => { tui.invalidate(); tui.requestRender(); };
  // Native argument identity only, not prepared/encoded source or a reader cache.
  type SyntaxState = { attempt: number; revision: number; sourceRevision: number; serviceRevision: number; identity: unknown[]; service: unknown[];
    palette: number; paletteColors?: WeakRef<object>; mode: TerminalColorMode; complete: boolean; live: boolean; applied: boolean; paused?: boolean; owned?: boolean; refreshPending?: boolean; prefix?: { sourceRevision: number; basis: number; bytes: number } };
  let syntaxStates = new WeakMap<ToolNode, SyntaxState>();
  let syntax: CardSources<ToolNode> | undefined;
  let cardClient = options.syntax?.client;
  let selectedPalette = cardClient?.snapshot().effective ?? resolveTheme({ kind: 'pi' }).effective;
  let ownedSources: SourceController | undefined;
  const paletteOwner = new PaletteInputOwner(options.diagnostic);
  const externalPaletteOwner = !!(options.syntax && options.preparePaletteInput);
  function needsPiTheme(palette: ThemeDescription) {
    return palette.kind === 'pi' || !externalPaletteOwner && paletteOwner.usesPiInput(palette);
  }
  function terminalMode(): TerminalColorMode {
    if (options.colorMode) return options.colorMode();
    const theme = getTheme() as unknown as { getColorMode?: () => TerminalColorMode };
    return typeof theme.getColorMode === 'function' ? theme.getColorMode() : publicInput().mode;
  }
  function publicInput() {
    if (options.piInput) return options.piInput();
    const theme = getTheme() as Palette & PiInputTheme & { getColorMode(): TerminalColorMode };
    if (!theme.colors || typeof theme.getFgAnsi !== 'function' || typeof theme.getBgAnsi !== 'function' || typeof theme.getColorMode !== 'function')
      throw new Error('Custom cards require coherent public Pi theme input');
    return { theme, mode: theme.getColorMode() };
  }
  function ensureCards(): CardSources<ToolNode> {
    if (syntax) return syntax;
    if (!cardClient) {
      const snapshot = { enabled: false, selected: { kind: 'pi' } as const, standaloneVersion: extensionVersion,
        provider: { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false } };
      ownedSources = new SourceController({ snapshot: () => snapshot.provider, isReady: () => false,
        classificationAccepted: () => { throw new Error('Disabled card provider accepted work'); },
        request: () => { throw new Error('Disabled card provider requested work'); } },
        { diagnostic: options.diagnostic, onChange: localCardNotice(new WeakRef(controller)) });
      ownedSources.setEnabled(false); cardClient = { sources: ownedSources, snapshot: () => snapshot };
    }
    syntax = new CardSources(cardClient, {
      diagnostic: options.diagnostic, identify: node => ({ call: node.toolCallId, tool: node.toolName }),
      preparation: options.cardPreparation ? (node, receipt) => options.cardPreparation?.({ ...receipt, call: node.toolCallId, tool: node.toolName }) : undefined,
      preparePaletteInput: (effective, revision, mode, funding, usePiFallback) => {
        const input = needsPiTheme(effective) ? publicInput() : undefined;
        const fallbackTheme = () => publicInput().theme;
        if (options.preparePaletteInput) return options.preparePaletteInput(effective, input?.theme, revision, mode, funding, usePiFallback, fallbackTheme);
        if (effective.kind === 'pi' && options.preparePiInput) return options.preparePiInput(input!.theme, mode, funding);
        return paletteOwner.prepare(input?.theme, effective, revision, mode, funding, usePiFallback, fallbackTheme);
      },
      classify: options.syntax?.classify ?? ((text, info) => highlightCode(text, info.language)),
      invalidate: node => { const state = syntaxStates.get(node); let owned: boolean | undefined;
        const accepted = syntax?.visit(node, (_display, paint) => { owned = paint.origin === 'owned'; });
        if (accepted && state) state.owned = owned;
        preparePrefix(node); }, requestRender: () => { if (active && !quiescing) tui.requestRender(); },
    });
    return syntax;
  }
  const primitiveIdentity = (value: unknown) => value !== null && (typeof value === 'object' || typeof value === 'function') ? typeof value : value;
  function liveBashSource(node: ToolNode): boolean { return syntaxStates.get(node)?.live ?? options.syntax?.isLiveCall?.(node.toolCallId) ?? true; }
  function bashInputComplete(node: ToolNode): boolean {
    return node.argsComplete || !node.isPartial && node.result?.role === 'toolResult' || abandonedBashSource(node) && !liveBashSource(node);
  }
  function abandonedBashSource(node: ToolNode): boolean {
    return node.toolName === 'bash' && !node.isPartial && node.result?.isError === true && bashFailurePhase(node) === 'formation';
  }
  function interruptedLiveBash(node: ToolNode): boolean { return abandonedBashSource(node) && liveBashSource(node); }
  function syntaxEligible(node: ToolNode): boolean {
    if (!active || !attached(node) || node.hideComponent || node.result?.content.some(part => part.type === 'image')) return false;
    if (node.toolName === 'bash') return !overrides.has('bash') && !nativeOverrides.has('bash') && typeof node.args.command === 'string' && bashDirectory(node) !== null;
    return fileSucceeded(node) && !node.expanded && !overrides.has(node.toolName) && !nativeOverrides.has(node.toolName) && !!filePath(node.args);
  }
  const equalIdentity = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  function observeSyntax(node: ToolNode): SyntaxState | undefined {
    if (quiescing || !syntaxEligible(node)) { if (node.toolName !== 'bash') dropPrepared(node); pauseSyntax(node); return; }
    const owner = ensureCards();
    const identity = node.toolName === 'bash' ? [node.toolName, primitiveIdentity(node.args.command)] : (() => {
      const d = node.result?.details as { diff?: unknown; patch?: unknown; truncated?: unknown; noOp?: unknown } | undefined;
      return [node.toolName, filePath(node.args), node.toolName === 'write' ? primitiveIdentity(node.args.content) : undefined,
        primitiveIdentity(d?.diff), primitiveIdentity(d?.patch), primitiveIdentity(d?.truncated), primitiveIdentity(d?.noOp)];
    })();
    const context = node.getRenderContext() as { cwd?: string };
    const diagnostics = (node.result?.details as { diagnostics?: unknown } | undefined)?.diagnostics;
    const diagnosticIdentity = node.toolName !== 'bash' && Array.isArray(diagnostics) ? diagnostics.flatMap(value => {
      const diagnostic = value as { severity?: unknown; message?: unknown; line?: unknown } | null;
      return diagnostic?.severity === 'error' && typeof diagnostic.message === 'string' ? [diagnostic.message, primitiveIdentity(diagnostic.line)] : [];
    }) : [];
    const service = node.toolName === 'bash' ? [node.expanded, node.args.description, node.args.workdir, bashDirectory(node), node.result?.isError,
      node.isPartial, node.result?.isError ? node.executionStarted : undefined, node.result?.isError ? node.argsComplete : undefined,
      (node.result?.details as { exit_code?: unknown } | undefined)?.exit_code,
      ...(node.result?.content.flatMap(p => [p.type, p.text]) ?? [])] : [context?.cwd, ...diagnosticIdentity];
    let state = syntaxStates.get(node);
    const input = needsPiTheme(selectedPalette) ? publicInput() : undefined;
    const mode = input?.mode ?? terminalMode();
    const palette = externalPaletteOwner ? options.syntax!.palette() : paletteOwner.palette(input?.theme, selectedPalette);
    const changed = !state || !equalIdentity(identity, state.identity), serviceChanged = !state || !equalIdentity(service, state.service);
    if (!state) { state = { attempt: 0, revision: 0, sourceRevision: 0, serviceRevision: 0, identity: [], service: [], palette, mode, complete: false, applied: false, live: liveBashSource(node) }; syntaxStates.set(node, state); }
    const complete = node.toolName === 'bash' ? bashInputComplete(node) : true;
    if (!state.applied || changed || serviceChanged || state.palette !== palette || state.mode !== mode || complete !== state.complete) {
      const attempt = ++state.attempt;
      const common = { revision: attempt, sourceRevision: changed ? attempt : state.sourceRevision,
        serviceRevision: serviceChanged ? attempt : state.serviceRevision, palette, mode };
      state.applied = false;
      const accepted = owner.updateDisplay(node, node.toolName === 'bash' ? { ...common, kind: 'bash', args: node.args, node,
        complete, language: 'bash', directory: bashDirectory(node) ?? undefined }
        : { ...common, kind: 'file', node, cwd: context?.cwd, language: getLanguageFromPath(filePath(node.args)!) });
      if (syntaxStates.get(node) !== state || state.attempt !== attempt) return;
      if (!accepted || !syntaxEligible(node)) { pauseSyntax(node); return; }
      Object.assign(state, common, { identity, service, complete, applied: true,
        paletteColors: input ? new WeakRef(input.theme.colors) : undefined });
      preparePrefix(node);
    }
    if (interruptedLiveBash(node)) owner.freeze(node);
    return state;
  }
  function preparePrefix(node: ToolNode) {
    const state = syntaxStates.get(node); if (!state?.applied || node.toolName !== 'bash' || !syntax) return;
    const key = syntax.identities(node)[0]?.key; if (!key) return;
    const basis = cardClient!.sources.displayBasis(key); if (!basis || state.prefix?.sourceRevision === state.sourceRevision && state.prefix.basis === basis.geometryStamp) return;
    let bytes = 0, valid = false;
    const accepted = syntax.visit(node, (display, paint) => {
      if (display.kind !== 'bash') return;
      valid = paint.basis(key, text => {
        const current = display.command.text; let i = 0;
        while (i < text.length && i < current.length) {
          const cp = text.codePointAt(i)!; if (cp !== current.codePointAt(i)) break;
          bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; i += cp > 65535 ? 2 : 1;
        }
      });
    });
    if (accepted && valid) state.prefix = { sourceRevision: state.sourceRevision, basis: basis.geometryStamp, bytes };
  }
  function pauseSyntax(node: ToolNode) {
    const state = syntaxStates.get(node); if (state) state.paused = true;
    syntax?.pause(node);
  }
  function usefulSyntax(node: ToolNode) {
    const state = syntaxStates.get(node);
    if (state?.applied && syntaxEligible(node)) { state.paused = false; syntax?.useful(node, state.revision); }
  }
  function observePalette(node: ToolNode, origin: 'owned' | 'pi') {
    if (origin === 'owned' || quiescing) return;
    const state = syntaxStates.get(node); if (!state || state.refreshPending) return;
    const input = publicInput();
    if (!state.paletteColors) {
      state.paletteColors = new WeakRef(input.theme.colors);
      state.mode = input.mode;
      return;
    }
    if (state.paletteColors.deref() === input.theme.colors && state.mode === input.mode) return;
    state.refreshPending = true;
    queueMicrotask(paletteRefresh(new WeakRef(node), new WeakRef(controller)));
  }
  function refreshPalette(node: ToolNode) {
    const state = syntaxStates.get(node); if (state) state.refreshPending = false;
    if (active && !quiescing) {
      const current = observeSyntax(node);
      // A palette refresh is not a visibility transition; only a useful frame resumes paused owners.
      if (current && !current.paused) usefulSyntax(node);
    }
  }
  function memo<T extends Layout>(node: ToolNode, kind: LayoutKind, width: number, theme: Palette, directory: string | undefined, padding: number, build: () => T): T {
    const signature = [kind, width, padding, theme, theme.fg, node.args, node.result, node.expanded, node.isPartial, directory];
    const state = states.get(node);
    if (state && equalIdentity(signature, state.signature)) { const value = state.pool.get(state.entry); if (value) return value as T; }
    state?.pool.drop(state.entry); const value = build(); cache.get(undefined);
    states.set(node, { signature, pool: cache, entry: cache.put(value, value.rows, kind) }); return value;
  }
  const preparedCleanup = new WeakMap<CacheEntry<PreparedLayout>, { geometry?: ReturnType<CardLayout['cleanupReceipt']>; output: ReturnType<CardRows['cleanupReceipt']> }>();
  function preparedLayout(node: ToolNode, width: number): PreparedLayout | undefined {
    if (!syntaxStates.get(node)?.applied) return;
    const previousEntry = preparedStates.get(node), previous = previousEntry?.value;
    const padding = outputPadding(), funding = cardClient?.sources.geometryFunding();
    let scene: CardLayout | undefined, output: CardRows | undefined, candidate: PreparedLayout | undefined, adopted = false, nativeFile = false;
    try {
      const accepted = !!funding && !!syntax?.visit(node, (display, paint) => {
        if (display.kind === 'file' && display.mode === undefined) { nativeFile = true; return; }
        observePalette(node, paint.origin);
        const sameGeometry = previous?.scene.isRetained && previous.width === width && previous.padding === padding && previous.expanded === node.expanded && previous.geometryStamp === display.geometryStamp;
        if (sameGeometry && previous.output.isValid && previous.paintStamp === paint.paintStamp) { candidate = previous; return; }
        scene = sameGeometry ? previous.scene : layoutCard(display, { width, outputPad: padding, expanded: node.expanded }, funding);
        if (!scene) return;
        let proof: BashPaintProof | undefined;
        if (display.kind === 'bash') {
          const key = syntax!.identities(node)[0]?.key, prefix = syntaxStates.get(node)?.prefix;
          if (key && prefix && prefix.sourceRevision === syntaxStates.get(node)?.sourceRevision) paint.basis(key, (_text, ranges) => { proof = { ranges, eligibleBytes: prefix.bytes }; });
        }
        output = scene.paint(display, paint, funding, proof); if (!output) return;
        candidate = { scene, output, width, padding, expanded: node.expanded, geometryStamp: display.geometryStamp, paintStamp: paint.paintStamp, publication: paint.publication, origin: paint.origin };
      });
      if (accepted && nativeFile) dropPrepared(node);
      if (!accepted || !candidate || !active) return undefined;
      const state = syntaxStates.get(node); if (state) state.owned = candidate.origin === 'owned';
      if (candidate === previous) { preparedPools.get(previousEntry!)?.get(previousEntry); return previous; }
      let rows: string[] | undefined; if (!candidate.output.withRows(value => { rows = value; }) || !rows) return previous;
      const oldRelease = previousEntry && preparedCleanup.get(previousEntry);
      const release = { geometry: candidate.scene.cleanupReceipt() as ReturnType<CardLayout['cleanupReceipt']> | undefined, output: candidate.output.cleanupReceipt() };
      const pool = candidate.scene.framed ? cardCache : cache;
      pool.get(undefined);
      const entry = pool.put(candidate, rows, node.toolName as LayoutKind, preparedRelease(release));
      if (candidate.scene === previous?.scene && oldRelease) oldRelease.geometry = undefined;
      preparedCleanup.set(entry, release); preparedPools.set(entry, pool); dropPrepared(node); preparedStates.set(node, entry); adopted = true;
      const identity = syntax?.identities(node)[0];
      const basis = identity && cardClient!.sources.displayBasis(identity.key);
      const pi = identity && cardClient!.sources.borrowPiSource(identity.key);
      const selected = node.toolName === 'bash' ? syntaxStates.get(node)?.prefix?.bytes ? 'historical-native-prefix' : 'toolTitle'
        : basis ? 'exact-native' : pi ? pi.styleDirectives ? 'styled-pi' : 'plain-pi' : 'waiting';
      decision(node, 'syntax', selected === 'historical-native-prefix' ? 'Validated historical-prefix display, not parser authority'
        : selected === 'plain-pi' ? 'Pi returned plain text; complete card palette supplies neutral ink'
        : selected === 'waiting' ? 'Native work is queued, unsettled or uncertain; full text shown without duplicate Pi classification'
        : 'Complete prepared card palette and source display selected', width, candidate.output.rowCount,
        { call: node.toolCallId, tool: node.toolName, selected, origin: candidate.origin });
      return candidate;
    } finally { if (!adopted) { output?.dispose(); if (scene !== previous?.scene) scene?.dispose(); } }
  }
  function preparedRows(layout: PreparedLayout | undefined): string[] {
    let rows: string[] | undefined; layout?.output.withRows(value => { rows = value; }); return rows ?? [];
  }
  const bashLayout = preparedLayout;
  const fileLayout = (node: ToolNode, width: number) => {
    const layout = preparedLayout(node, width);
    return layout ? { geometry: layout.scene.geometry, framed: layout.scene.framed, native: false, rows: preparedRows(layout) }
      : { rows: nativeRows(node, width), framed: false, native: true };
  };
  function fileMeasure(node: ToolNode, width: number) {
    if (!syntaxStates.get(node)?.applied) return;
    const existing = preparedStates.get(node)?.value, padding = outputPadding();
    let measurement: { framed: boolean; height: number } | undefined;
    const accepted = syntax?.visit(node, display => {
      if (display.kind !== 'file' || display.mode === undefined) return;
      if (existing?.scene.isRetained && existing.width === width && existing.padding === padding && existing.geometryStamp === display.geometryStamp) {
        measurement = { framed: existing.scene.framed, height: existing.scene.rowCount }; return;
      }
      // Spacing only distinguishes a frame from a one-row inline heading. No
      // source rows need reflowing or parsing for this classification.
      if (display.mode !== 'inline') { measurement = { framed: true, height: width > 0 ? 3 : 0 }; return; }
      const geometry = cardGeometry(width, padding), inset = Math.min(geometry.contentX, Math.max(0, geometry.width - geometry.marginRight - 1));
      const available = geometry.width - inset - geometry.marginRight;
      if (available <= 0 || !display.heading) { measurement = { framed: false, height: 0 }; return; }
      const funding = cardClient?.sources.geometryFunding(); if (!funding) return;
      const heading = reflow(display.heading.measured, { mode: 'file', width: available }, funding.grant);
      try { if (heading) measurement = { framed: false, height: heading.rowCount }; }
      finally { heading?.dispose(); }
    });
    return accepted ? measurement : undefined;
  }
  const summaryLayout = (node: ToolNode, width: number) => {
    const theme = getTheme(), padding = outputPadding();
    return memo(node, 'summary', width, theme, undefined, padding, () => summaryRows(node, width, theme, padding));
  };
  const controller: PreparedCardController = {
    refreshPreparedPalette: refreshPalette,
    retireRendererClears() {
      const detached = rendererClears; rendererClears = []; rendererClearPending = false;
      if (active) for (const reference of detached) { const node = reference.deref(); if (node && !attached(node)) releaseTree(node); }
    },
    get active() { return active; },
    get reason() { return reason; },
    get editorActive() {
      const editor = statusEditor?.deref();
      return !!(active && editor && managedStockEditor(editor));
    },
    get editorStatusActive() {
      const editor = statusEditor?.deref();
      return !!(active && options.editorStatus && editor && stockEditor(editor));
    },
    cacheStats: () => {
      const ordinary = cache.stats(), cards = cardCache.stats();
      return { ordinary, cards,
        retainedBytes: ordinary.retainedBytes + cards.retainedBytes,
        stringBytes: ordinary.stringBytes + cards.stringBytes, overheadBytes: ordinary.overheadBytes + cards.overheadBytes,
        rows: ordinary.rows + cards.rows, entries: ordinary.entries + cards.entries,
        hits: ordinary.hits + cards.hits, misses: ordinary.misses + cards.misses, builds: ordinary.builds + cards.builds,
        releases: ordinary.releases + cards.releases, collected: ordinary.collected + cards.collected,
        byKind: Object.fromEntries(LAYOUT_KINDS.map(kind => {
          const memory = { ...ordinary.byKind[kind] };
          for (const field of MEMORY_FIELDS) memory[field] += cards.byKind[kind][field];
          return [kind, memory];
        })) as Record<LayoutKind, LayoutMemory> };
    },
    logSnapshot() {
      diagnose(options.diagnostic, 'INFO', 'tool', 'Native lifecycle callback counters; these are not source dispatches',
        { callbacks: lifecycleCallbacks, phaseChanges: lifecyclePhaseChanges });
      diagnose(options.diagnostic, "INFO", "animation", "Snapshot of owned fallback animation; native Pi clock is not intercepted",
        { wakes: spinnerWakes, requests: spinnerRequests, participants: animated.size, timer: spinnerTimer !== undefined, pending: spinnerPending });
    },
    renderEditorStatus(width, info) {
      const editor = statusEditor?.deref(), state = editor && editorStates.get(editor);
      if (!active || !options.editorStatus || !editor || !stockEditor(editor) || !state?.framed || state.width !== width) {
        decision(tui, "editor-status", "Below-editor metadata withheld; owned stock geometry is unavailable", width, 0); return []; }
      try {
        if (editor.isShowingAutocomplete()) { decision(tui, "editor-status", "Below-editor metadata suppressed by public autocomplete state", width, 0); return []; }
        const group = managedEditorSlots(editor)?.[2] as Container | undefined;
        const activity = group?.render === observeWidgetRows ? nativeStatusRows.get(group) : undefined;
        const idle = info.idle && !(activity?.width === width && activity.visible);
        const rows = renderEditorStatus(width, getTheme(), { ...info, idle }, state.geometry);
        decision(tui, "editor-status", idle ? "Below-editor metadata projected with Idle" : "Below-editor metadata projected; native activity stays in Pi-owned status container", width, rows.length);
        return rows;
      }
      catch { fail("pi-tidy-ui could not render editor status; native rendering restored"); return []; }
    },
    clearCache,
    syntaxSourceChanged(keys, groups) { if (active && !quiescing) syntax?.sourceChanged(keys, groups); },
    syntaxMetadataChanged() {
      if (active && !quiescing) {
        selectedPalette = cardClient?.snapshot().effective ?? resolveTheme({ kind: 'pi' }).effective;
        const paletteRevision = externalPaletteOwner ? options.syntax!.palette()
          : paletteOwner.palette(needsPiTheme(selectedPalette) ? publicInput().theme : undefined, selectedPalette);
        syntax?.metadataChanged(paletteRevision);
      }
    },
    quiesce() {
      quiescing = true; stopSpinner(); animated.clear(); animationRefs = new WeakMap();
    },
    restore({ repaint = true } = {}) {
      if (!active && !patches.size && !userPatches.size && !editorPatches.size) {
        syntax?.dispose(); ownedSources?.dispose(); paletteOwner?.dispose(); syntaxStates = new WeakMap(); return;
      }
      diagnose(options.diagnostic, "INFO", "runtime", "Presentation restoring native ownership; later owners remain untouched",
        { animationWakes: spinnerWakes, animationRequests: spinnerRequests });
      active = false;
      rendererClears = []; rendererClearPending = false;
      syntax?.dispose(); ownedSources?.dispose(); paletteOwner?.dispose(); syntaxStates = new WeakMap();
      stopSpinner(); animated.clear(); animationRefs = new WeakMap();
      clearCache();
      if (Container.prototype.addChild === patchedAdd) Container.prototype.addChild = originalAdd;
      if (Container.prototype.clear === patchedClear) Container.prototype.clear = containerClear;
      if (Container.prototype.removeChild === patchedRemove) Container.prototype.removeChild = containerRemove;
      if (Container.prototype.render === observeWidgetRows) Object.defineProperty(Container.prototype, "render", containerRender);
      if (Spacer.prototype.render === observeWidgetSpacer) Object.defineProperty(Spacer.prototype, "render", spacerRender);
      upperWidgetRows = new WeakMap(); nativeStatusRows = new WeakMap(); widgetSpacerPass = undefined;
      for (const [prototype, patch] of patches) {
        if (Object.getOwnPropertyDescriptor(prototype, "render")?.value === patch.patchedRender)
          Object.defineProperty(prototype, "render", patch.render);
        if (Object.getOwnPropertyDescriptor(prototype, "handleMouse")?.value === patch.patchedMouse)
          Object.defineProperty(prototype, "handleMouse", patch.mouse);
        for (const update of patch.updates) {
          if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
          if (update.original) Object.defineProperty(prototype, update.name, update.original);
          else Reflect.deleteProperty(prototype, update.name);
        }
      }
      patches.clear();
      for (const [prototype, patch] of userPatches) {
        if (Object.getOwnPropertyDescriptor(prototype, "render")?.value === patch.patchedRender)
          Object.defineProperty(prototype, "render", patch.render);
        for (const update of patch.updates) {
          if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
          if (update.original) Object.defineProperty(prototype, update.name, update.original);
          else Reflect.deleteProperty(prototype, update.name);
        }
      }
      userPatches.clear();
      const restoredPlacement = new WeakSet<CustomEditor>();
      for (const reference of editorFlagRefs) {
        const editor = reference.deref(), flag = editor && editorFlags.get(editor);
        const descriptor = editor && Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus");
        if (editor && flag && descriptor?.get === statusEmbedding && descriptor.configurable) {
          Object.defineProperty(editor, "embedWorkingStatus", flag); restoredPlacement.add(editor);
        }
      }
      try { rerouteNativeStatus(restoredPlacement); } catch { /* Retain native ownership on an unsupported host. */ }
      editorFlagRefs.clear();
      for (const [prototype, hooks] of editorPatches) for (const hook of hooks) {
        if (Object.getOwnPropertyDescriptor(prototype, hook.name)?.value !== hook.wrapper) continue;
        if (hook.original) Object.defineProperty(prototype, hook.name, hook.original);
        else Reflect.deleteProperty(prototype, hook.name);
      }
      editorPatches.clear(); editorStates = new WeakMap(); editorPasses = new WeakMap(); statusEditor = undefined;
      options.editorStatusRestored?.();
      if (repaint) refresh();
    },
  };
  const fail = (message: string) => {
    if (reason) return;
    reason = message;
    diagnose(options.diagnostic, "ERROR", "compatibility", message);
    reportRuntime(options.diagnostic, { kind: 'failure', scope: controller, operation: 'appearance', area: 'appearance', code: 'unsupported_host' });
    controller.restore();
    options.warn?.(message);
  };
  const fileTool = (node: ToolNode) => node.toolName === "edit" || node.toolName === "write";
  const fileSucceeded = (node: ToolNode) => fileTool(node) && !!node.result && !node.isPartial && !node.result.isError;
  const eligible = (node: Component): node is ToolNode => active && candidate(node) &&
    !node.hideComponent && !node.expanded && (overrides.has(node.toolName) || !cards.has(node.toolName) ||
      (fileTool(node) && !nativeOverrides.has(node.toolName) && !fileSucceeded(node))) &&
    !node.result?.content.some((content) => content.type === "image");
  const compact = (node: Component, width: number): node is ToolNode => {
    if (!eligible(node)) return false;
    return nativeVisible(node, width);
  };
  function nativeVisible(node: ToolNode, width: number): boolean {
    if (node.getRenderShell() !== "self") return true;
    // Stock edit always supplies a heading in an ordinary Box. Its native factory can reuse
    // a previous custom Box, so both renderer identities AND the current component must qualify.
    // Check every visit; no retained visibility proof or native-state mutation.
    if (typeof stockEditCall === "function" && typeof stockEditResult === "function" &&
      node.constructor.name === "ToolExecutionComponent" && node.toolName === "edit" &&
      typeof node.getCallRenderer === "function" && node.getCallRenderer() === stockEditCall &&
      typeof node.getResultRenderer === "function" && node.getResultRenderer() === stockEditResult &&
      node.callRendererComponent instanceof Box && Object.getPrototypeOf(node.callRendererComponent) === Box.prototype &&
      node.callRendererComponent.render === Box.prototype.render &&
      node.callRendererComponent.clear === Box.prototype.clear && node.callRendererComponent.addChild === Box.prototype.addChild) return true;
    // Unknown self shells can be empty/width-dependent even when hideComponent is false.
    return nativeRows(node, width).length > 0;
  }

  function bashCard(node: Component, width: number): boolean {
    if (!active || !candidate(node) || node.toolName !== "bash" || node.hideComponent ||
      overrides.has("bash") || nativeOverrides.has("bash") || typeof node.args.command !== "string" ||
      node.result?.content.some((part) => part.type === "image") || bashDirectory(node) === null) return false;
    return nativeVisible(node, width);
  }

  function fileCard(node: Component, width: number): boolean {
    if (!active || !candidate(node) || !fileSucceeded(node) || node.hideComponent || node.expanded ||
      overrides.has(node.toolName) || nativeOverrides.has(node.toolName) || !filePath(node.args) ||
      node.result?.content.some((part) => part.type === "image")) return false;
    return nativeVisible(node, width);
  }

  function summaryRows(node: ToolNode, width: number, theme: Palette, padding: number): SummaryLayout {
    if (width < 1) return { rows: [], prefixLength: 0, prefixLeft: 0, prefixSpace: false };
    const available = width - padding, indent = padding + 2;
    const failed = !node.isPartial && node.result?.isError;
    const pending = node.isPartial || !node.result;
    const marker = SHOW_COMPLETION_MARKERS ? pending ? "…" : failed ? "✗" : "✓" : "";
    const statusColor = failed ? "error" : pending ? "muted" : "success";
    const glyph = node.toolName === "read" ? "→" : fileTool(node) ? "←" : "⚙";
    if (available < indent + 2) {
      const left = Math.min(padding, Math.max(0, width - 1 - padding));
      const prefix = theme.fg(marker ? statusColor : failed ? "error" : "dim", " ".repeat(left) + (marker || glyph));
      return { rows: [prefix], prefixLength: prefix.length, prefixLeft: left, prefixSpace: false };
    }
    const prefix = theme.fg(failed ? "error" : "dim", `${" ".repeat(padding)}${glyph} `);
    const parts: { color?: ThemeColor; text: string }[] = [{ color: "toolTitle", text: summaryName(node.toolName) }];
    const { pattern, object, params } = argumentParts(node.toolName, node.args);
    if (pattern) {
      parts.push({ color: "muted", text: ` ${pattern}` });
      if (object) parts.push({ color: "dim", text: " in " }, { color: "muted", text: object });
    } else if (object) parts.push({ color: "muted", text: ` ${object}` });
    const parameterStart = parts.reduce((length, part) => length + part.text.length, 0) + 1;
    if (params) parts.push({ color: "dim", text: ` ${params}` });
    if (marker) parts.push({ text: " " }, { color: statusColor, text: marker });
    // Layout plain text before styling. Pi 1.0.0's ANSI word wrapper mistakes
    // colored whitespace for content, adding padding or empty content rows.
    const plain = parts.map((part) => part.text).join("");
    let end = 0;
    const spans = parts.map((part) => { const start = end; end += part.text.length; return { ...part, start, end }; });
    let cursor = 0;
    const rows = wrapSummary(plain, available - indent, parameterStart, params.length).map((line, index) => {
      const start = plain.indexOf(line, cursor);
      if (start < 0) throw new Error("Wrapped text is not a source substring");
      cursor = start + line.length;
      const styled = spans.map((span) => {
        const from = Math.max(start, span.start), to = Math.min(cursor, span.end);
        if (from >= to) return "";
        const text = plain.slice(from, to);
        return failed ? theme.fg("error", text) : span.color ? theme.fg(span.color, text) : text;
      }).join("");
      return (index === 0 ? prefix : " ".repeat(indent)) + styled;
    });
    return { rows, prefixLength: prefix.length, prefixLeft: padding, prefixSpace: true };
  }
  function paintSummary(node: ToolNode, width: number): string[] {
    const layout = summaryLayout(node, width);
    animate(node);
    if (!executing(node) || !layout.rows.length) return layout.rows;
    // Time, not fallback ticks, advances the glyph even when all frames come
    // from Working. One call-local sample keeps parallel calls in phase.
    const now = passSpinnerTime ?? performance.now();
    const frame = SPINNER_FRAMES[Math.floor((now - (spinnerEpoch ?? now)) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
    const prefix = getTheme().fg("dim", " ".repeat(layout.prefixLeft) + frame + (layout.prefixSpace ? " " : ""));
    return [prefix + layout.rows[0]!.slice(layout.prefixLength), ...layout.rows.slice(1)];
  }
  function nativeRows(node: Component, width: number): string[] {
    const render = candidate(node) ? patches.get(Object.getPrototypeOf(node))?.render.value as Render | undefined : undefined;
    return render ? render.call(node as ToolNode, width) : node.render(width);
  }
  function previousLayout(node: Component, width: number): { compact: boolean; tool: boolean; height: number; separator?: boolean } | undefined {
    const position = parents.get(node);
    const siblings = position?.parent.children ?? [];
    let current = position?.index ?? -1;
    if (siblings[current] !== node) { current = siblings.indexOf(node); if (position) position.index = current; }
    for (let index = current - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (width > 0 && bashCard(previous, width)) return { compact: false, tool: true, height: 3 };
      if (width > 0 && candidate(previous) && fileCard(previous, width)) {
        const measure = fileMeasure(previous, width);
        if (measure?.height) return { compact: !measure.framed, tool: true, height: measure.height };
      }
      if (compact(previous, width)) return { compact: true, tool: true, height: summaryLayout(previous, width).rows.length };
      // User cards contribute cached content metadata, not recursive predecessor rendering.
      const userRender = userCandidate(previous) ? userPatches.get(Object.getPrototypeOf(previous))?.render.value as UserRender | undefined : undefined;
      const lines = userRender ? userLayout(previous as UserNode, width, userRender).rows : nativeRows(previous, width);
      if (lines.length) return { compact: false, tool: candidate(previous), height: lines.length - (lines[0] === "" ? 1 : 0), separator: lines.at(-1) === "" };
    }
    return undefined;
  }
  function gap(node: ToolNode, width: number): number {
    const previous = previousLayout(node, width);
    return previous ? previous.compact && previous.height === 1 ? 0 : 1 : 0;
  }
  function nativeGap(node: ToolNode, width: number, lines: string[]): number {
    if (!active || !lines.length || lines[0] === "") return 0;
    const previous = previousLayout(node, width);
    return previous?.tool && previous.height > 1 ? 1 : 0;
  }
  function presentedRows(node: ToolNode, rows: string[], offset: number): string[] {
    const state = states.get(node);
    if (state) state.gap = offset;
    const prepared = preparedStates.get(node)?.value;
    if (prepared) prepared.gap = offset;
    return offset ? ['', ...rows] : rows;
  }
  function cleanupRows(node: ToolNode, width: number): string[] | undefined {
    const prepared = preparedStates.get(node)?.value;
    if (prepared && prepared.width === width && width > 0 && prepared.gap !== undefined &&
      prepared.scene.isValid && prepared.output.isValid && syntaxStates.get(node)?.applied && syntaxEligible(node)) {
      if (!nativeVisible(node, width)) return [];
      const rows = preparedRows(prepared);
      return prepared.gap ? ['', ...rows] : rows;
    }
    // No source borrowing during disposal. Native update wrappers invalidate these
    // layouts; Bash's raw argument keys also guard its deliberately retained fast path.
    const state = states.get(node);
    if (!state || state.gap === undefined || width < 1 || state.signature[1] !== width || node.hideComponent
      || state.signature[6] !== node.result || state.signature[7] !== node.expanded || state.signature[8] !== node.isPartial) return;
    const bash = state.signature[0] === 'bash';
    if (bash ? state.signature[12] !== node.args.command || state.signature[13] !== node.args.description || state.signature[14] !== node.args.workdir : state.signature[5] !== node.args) return;
    if (!nativeVisible(node, width)) return [];
    const layout = state.pool.get(state.entry);
    return layout && !layout.native ? presentedRows(node, layout.rows, state.gap) : undefined;
  }
  function install(node: ToolNode) {
    if (!compatible(node)) { fail("Tool component contract is incompatible; native rendering retained"); return; }
    patchPrototype(Object.getPrototypeOf(node) as object);
    observeSyntax(node);
  }
  // Persistent wrappers must be created in a scope with no tool-instance parameter.
  function patchPrototype(prototype: object) {
    if (patches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, "render");
    const mouse = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
    if (!render?.writable || !mouse?.writable || typeof render.value !== "function" || typeof mouse.value !== "function") {
      fail("Tool rendering methods cannot be safely replaced; native rendering retained"); return;
    }
    const originalRender = render.value as Render;
    const originalMouse = mouse.value as Mouse;
    const patchedRender: Render = function (width) {
      try {
        if (quiescing) return cleanupRows(this, width) ?? originalRender.call(this, width);
        if (bashCard(this, width)) {
          removeAnimation(this);
          const layout = bashLayout(this, width);
          if (!layout) return originalRender.call(this, width);
          const rows = preparedRows(layout);
          toolDecision(this, rows.length ? "Bash card selected" : "Bash card returned no rows", width, rows.length);
          if (!rows.length) { pauseSyntax(this); return rows; }
          usefulSyntax(this);
          return presentedRows(this, rows, previousLayout(this, width) ? 1 : 0);
        }
        if (fileCard(this, width)) {
          removeAnimation(this);
          const layout = fileLayout(this, width);
          toolDecision(this, layout.native ? "File card delegated to native renderer; preparation/geometry guard rejected" : layout.framed ? "Prepared file card selected" : "Inline file result selected", width, layout.rows.length);
          if (layout.framed && !layout.native && layout.rows.length) usefulSyntax(this);
          else pauseSyntax(this);
          const offset = layout.native ? nativeGap(this, width, layout.rows) : layout.framed ? (previousLayout(this, width) ? 1 : 0) : gap(this, width);
          return presentedRows(this, layout.rows, offset);
        }
        pauseSyntax(this);
        if (!eligible(this)) {
          removeAnimation(this);
          const lines = originalRender.call(this, width);
          toolDecision(this, "Native tool renderer selected; custom/compact eligibility rejected", width, lines.length);
          return nativeGap(this, width, lines) ? ["", ...lines] : lines;
        }
        if (width < 1) { toolDecision(this, "Tool suppressed at zero width", width, 0); removeAnimation(this); return []; }
        if (!nativeVisible(this, width)) { toolDecision(this, "Native self-shell returned no visible rows", width, 0); removeAnimation(this); return []; }
        const offset = gap(this, width), rows = paintSummary(this, width);
        toolDecision(this, "Compact tool summary selected", width, rows.length);
        return presentedRows(this, rows, offset);
      }
       catch { fail("pi-tidy-ui could not render this component; native rendering restored"); return originalRender.call(this, width); }
    };
    const patchedMouse: Mouse = function (event) {
      if (!active) return originalMouse.call(this, event);
      if (quiescing) return undefined;
      if (event.width > 0 && bashCard(this, event.width)) {
        if (event.type !== "click" || event.button !== "left" || tui.hasActiveSelection?.()) return undefined;
        const layout = bashLayout(this, event.width);
        const offset = previousLayout(this, event.width) ? 1 : 0;
        const hit = layout?.scene.expandable && insidePanel(layout.scene.geometry, layout.output.rowCount, event.x, event.y - offset);
        if (!hit) return undefined;
        this.setExpanded(!this.expanded);
        tui.requestRender();
        return { handled: true };
      }
      if (event.width > 0 && fileCard(this, event.width)) {
        const rejected = !this.result || this.isPartial || tui.hasActiveSelection?.() || event.type !== "click" || event.button !== "left";
        if (rejected) {
          // Unsupported metadata must still delegate; supported cards need no body to reject an event.
          if (fileMeasure(this, event.width)) return undefined;
        } else {
          const layout = fileLayout(this, event.width);
          if (!layout.native) {
            const offset = layout.framed ? (previousLayout(this, event.width) ? 1 : 0) : gap(this, event.width);
            const hit = layout.framed ? insidePanel(cardGeometry(event.width, outputPadding()), layout.rows.length, event.x, event.y - offset) :
              this.result?.isError && event.y >= offset && event.y < offset + layout.rows.length;
            if (!hit) return undefined;
            this.setExpanded(true); tui.requestRender(); return { handled: true };
          }
        }
      }
      if (!compact(this, event.width)) {
        const offset = nativeGap(this, event.width, originalRender.call(this, event.width));
        if (event.y < offset) return undefined;
        return originalMouse.call(this, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
      }
      const offset = gap(this, event.width);
      if (!this.result || this.isPartial || event.type !== "click" || event.button !== "left" ||
        event.y < offset || event.y >= offset + summaryLayout(this, event.width).rows.length) return undefined;
      this.setExpanded(true);
      tui.requestRender();
      return { handled: true };
    };
    const updateNames = ["updateArgs", "updateResult", "setExpanded", "invalidate", "markExecutionStarted"];
    const argsCompleteDescriptor = Object.getOwnPropertyDescriptor(prototype, "setArgsComplete");
    // Compatible older/foreign tools need not expose an observable finalization method.
    if (typeof argsCompleteDescriptor?.value === "function" && argsCompleteDescriptor.writable && argsCompleteDescriptor.configurable)
      updateNames.push("setArgsComplete");
    const updates = updateNames.map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("Tool cache invalidation methods cannot be wrapped");
      const wrapper = function (this: ToolNode, ...args: unknown[]) {
        // Bash keys include every displayed argument; unrelated/same argument updates reuse its body.
        if (name !== "markExecutionStarted" && !((name === "updateArgs" || name === 'setArgsComplete') && this.toolName === "bash" && !overrides.has("bash")) &&
          !(name === "setExpanded" && args[0] === this.expanded)) forget(this, name);
        if (quiescing && name !== 'markExecutionStarted') { dropPrepared(this); }
        const result = method.apply(this, args);
        if (name !== "invalidate") nativePhase(this, name);
        observeSyntax(this);
        if (name === 'setExpanded' && this.toolName !== 'bash' && this.expanded) {
          dropPrepared(this);
        }
        if (!quiescing && syntax && name === "updateResult" && interruptedLiveBash(this)) {
          // Terminal formation retires native work, not the still-displayed presentation.
          syntax.freeze(this);
          cardClient!.sources.flush();
        }
        if (!executing(this) || !attached(this)) removeAnimation(this);
        return result;
      };
      return { name, original, wrapper };
    });
    patches.set(prototype, { render, mouse, patchedRender, patchedMouse, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    Object.defineProperty(prototype, "handleMouse", { ...mouse, value: patchedMouse });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  function userLayout(node: UserNode, width: number, originalRender: UserRender): Layout {
    const theme = getTheme(), padding = options.outputPad ? outputPadding() : node.outputPad;
    const signature = [width, theme, theme.fg, theme.bg, padding, node.text, node.outputPad, node.children[0], node.markdownTheme, node.markdownTransformers];
    const state = userStates.get(node);
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const value = cache.get(state.entry); if (value) return value;
    } else { cache.drop(state?.entry); cache.get(undefined); }
    const value = renderUserCard(width, node.outputPad, theme, (size) => originalRender.call(node, size), padding);
    userStates.set(node, { signature, entry: cache.put(value, value.rows, "user") });
    diagnose(options.diagnostic, "DEBUG", "cache", "User layout built around Pi-owned Markdown; no content logged", { width, padding, rows: value.rows.length });
    return value;
  }
  function installUser(node: UserNode) {
    if (!compatibleUser(node)) { fail("User-message component contract is incompatible; native rendering retained"); return; }
    patchUserPrototype(Object.getPrototypeOf(node) as object);
  }
  // Like tool hooks, these persistent closures are built without an installer-node parameter.
  function patchUserPrototype(prototype: object) {
    if (userPatches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, "render");
    if (!render?.writable || !render.configurable || typeof render.value !== "function") {
      fail("User-message rendering cannot be safely replaced; native rendering retained"); return;
    }
    const originalRender = render.value as UserRender;
    const patchedRender: UserRender = function (width) {
      if (!active) return originalRender.call(this, width);
      if (width < 1) return [];
      try {
        if (!compatibleUser(this)) throw new Error("User-message component contract changed");
        const rows = userLayout(this, width, originalRender).rows;
        decision(this, "user", "Native Markdown rows projected by user-card policy; inner fallback cause is unknown", width, rows.length);
        const previous = rows.length ? previousLayout(this, width) : undefined;
        return previous && !previous.separator ? ["", ...rows] : rows;
      } catch {
        fail("pi-tidy-ui could not render this user message; native rendering restored");
        return originalRender.call(this, width);
      }
    };
    const updates = ["rebuild", "setOutputPad", "invalidate"].map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("User-message invalidation methods cannot be wrapped");
      const wrapper = function (this: UserNode, ...args: unknown[]) { forgetUser(this); return method.apply(this, args); };
      return { name, original, wrapper };
    });
    userPatches.set(prototype, { render, patchedRender, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  type EditorHook = { name: string; original: PropertyDescriptor | undefined; wrapper: Function };
  const editorPatches = new Map<object, EditorHook[]>();
  let statusEditor: WeakRef<CustomEditor> | undefined;
  let editorStates = new WeakMap<CustomEditor, Omit<EditorLayout, "rows"> & { width: number; offsetY: number }>();
  const editorFlags = new WeakMap<CustomEditor, PropertyDescriptor>();
  const editorFlagRefs = new Set<WeakRef<CustomEditor>>();
  const selfTransfers = new WeakMap<CustomEditor, Function>();
  let installingEditorHooks = true, queuedEditorRoute = false;
  let nativeStatusRows = new WeakMap<Container, { width: number; visible: boolean }>();
  let editorPasses = new WeakMap<CustomEditor, { width: number; top: string; bottom: string }>();
  // Public stock identities are resolved before installing any hooks. No editor
  // instance is captured in these persistent closures; editing methods stay native.
  const editorRender = Editor.prototype.render, editorMouse = Editor.prototype.handleMouse;
  const editorPrototype = CustomEditor.prototype as unknown as Record<string, Function>;
  const editorTop = editorPrototype.renderTopBorder!, editorBottom = editorPrototype.renderBottomBorder!;
  function plainStockEditor(node: CustomEditor): boolean {
    const hooks = editorPatches.get(CustomEditor.prototype);
    return Object.getPrototypeOf(node) === CustomEditor.prototype && Object.getPrototypeOf(CustomEditor.prototype) === Editor.prototype &&
      ["render", "handleMouse", "renderTopBorder", "renderBottomBorder"].every(name =>
        (node as unknown as Record<string, unknown>)[name] === hooks?.find(hook => hook.name === name)?.wrapper) &&
      node.getPaddingX === Editor.prototype.getPaddingX && node.getText === Editor.prototype.getText &&
      (node.setText === Editor.prototype.setText || node.setText === selfTransfers.get(node)) &&
      typeof node.borderColor === "function" && !!Object.getOwnPropertyDescriptor(node, "borderColor")?.writable &&
      (options.nativeEditor?.() ?? true);
  }
  function managedStockEditor(node: CustomEditor): boolean {
    return plainStockEditor(node) && (!options.editorStatus ||
      Object.getOwnPropertyDescriptor(node, "embedWorkingStatus")?.get === statusEmbedding);
  }
  function stockEditor(node: CustomEditor): boolean { return managedStockEditor(node) && attached(node); }
  // Public readonly in TypeScript, but an own configurable data field in the
  // supported SDK. Native Pi consumes this flag and owns routing/lifecycle.
  function statusEmbedding(this: CustomEditor): boolean {
    return active && plainStockEditor(this) ? false : editorFlags.get(this)?.value as boolean;
  }
  function patchEditorPlacement(editor: CustomEditor) {
    if (!options.editorStatus || editorFlags.has(editor) || !plainStockEditor(editor) ||
      (options.rerouteEditorStatus && !managedEditorSlots(editor))) return;
    const flag = Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus");
    const setter = Object.getOwnPropertyDescriptor(editor, "setText");
    if (!flag?.configurable || !flag.writable || typeof flag.value !== "boolean" ||
      (setter ? !setter.writable : !Object.isExtensible(editor))) return;
    editorFlags.set(editor, flag); editorFlagRefs.add(new WeakRef(editor));
    Object.defineProperty(editor, "embedWorkingStatus", { configurable: true, enumerable: flag.enumerable, get: statusEmbedding });
    if (!installingEditorHooks && options.rerouteEditorStatus && !queuedEditorRoute) {
      queuedEditorRoute = true;
      // A selector can temporarily remove the default editor. Rebind after its
      // normal attachment finishes, never inside addChild or with a modal mounted.
      queueMicrotask(() => {
        queuedEditorRoute = false;
        if (active) try { rerouteNativeStatus(); }
        catch { fail("pi-tidy-ui could not route native editor activity; native rendering restored"); }
      });
    }
  }
  function rerouteNativeStatus(restored?: WeakSet<CustomEditor>) {
    if (!options.rerouteEditorStatus) return;
    for (const reference of editorFlagRefs) {
      const editor = reference.deref();
      if (!editor || !plainStockEditor(editor) || !managedEditorSlots(editor) || !attached(editor) ||
        (restored ? !restored.has(editor) : Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus")?.get !== statusEmbedding)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(editor, "setText");
      if (descriptor ? !descriptor.writable : !Object.isExtensible(editor)) continue;
      const text = editor.getText(), transfers: string[] = [], focus = tui.getFocusedComponent?.();
      // Native same-default rebinding copies getText() through setText(), which
      // would reset cursor/undo and turn collapsed pastes into literal markers.
      // Suppress only this synchronous self-transfer; no editor is constructed.
      const setter = function (this: CustomEditor, value: string) {
        if (this === editor) transfers.push(value); else Editor.prototype.setText.call(this, value);
      };
      selfTransfers.set(editor, setter);
      Object.defineProperty(editor, "setText", { configurable: true, writable: true, ...descriptor, value: setter });
      try {
        options.rerouteEditorStatus();
        if (transfers.length !== 1 || transfers[0] !== text || !attached(editor))
          throw new Error("Native same-editor status routing contract changed");
      } finally {
        selfTransfers.delete(editor);
        if (Object.getOwnPropertyDescriptor(editor, "setText")?.value === setter) {
          if (descriptor) Object.defineProperty(editor, "setText", descriptor); else Reflect.deleteProperty(editor, "setText");
        }
        if (focus !== undefined && focus !== editor) tui.setFocus?.(focus);
      }
      return; // The public API has one current default editor, never a factory substitution.
    }
  }
  // Both native modes retain seven managed public children, even when fullscreen
  // paints a separate dock. Never infer this slot from names or arbitrary siblings.
  function managedEditorSlots(editor: CustomEditor): Component[] | undefined {
    const input = parents.get(editor)?.parent;
    if (!input || Object.getPrototypeOf(input) !== Container.prototype || input.children.length !== 1 || input.children[0] !== editor)
      return undefined;
    const position = parents.get(input), slots = position?.parent.children;
    if (!(tui instanceof Container) || !slots || slots !== tui.children || slots.length !== 7 || slots[4] !== input ||
      !slots.every(node => Object.getPrototypeOf(node) === Container.prototype)) return undefined;
    return slots;
  }
  function upperWidgetGroup(editor: CustomEditor): Container | undefined {
    const slots = managedEditorSlots(editor);
    if (!slots) return undefined;
    const group = slots[3] as Container, spacer = group.children[0];
    if (group.render !== observeWidgetRows || group.clear !== patchedClear || group.addChild !== patchedAdd ||
      !spacer || Object.getPrototypeOf(spacer) !== Spacer.prototype || spacer.render !== observeWidgetSpacer)
      return undefined;
    return group;
  }
  // Observe the already-required native group render, not each widget and not a
  // second render for spacing. This closure owns no installer/group/editor node.
  function observeWidgetRows(this: Container, width: number): string[] {
    const document = tui instanceof Container && (this === tui || (this === tui.children[0] && Object.getPrototypeOf(this) === Container.prototype));
    if (!active || !document || passOutputPad !== undefined) return observeContainerRows.call(this, width);
    try { passOutputPad = outputPadding(); }
    catch { fail("Pi Output padding could not be read; native rendering restored"); return containerRender.value.call(this, width) as string[]; }
    // Pi exposes no after-present event. A successful document render is the
    // available signal, not proof of terminal output; diagnostic document visits
    // count too. Never observe requestRender(), individual cards or private timers.
    passSpinnerTime = performance.now();
    let completed = false;
    try {
      const rows = observeContainerRows.call(this, width);
      completed = true;
      return rows;
    } finally {
      passOutputPad = undefined;
      passSpinnerTime = undefined;
      if (completed) finishSpinnerPass(); // A failed pass must not postpone fallback.
    }
  }
  function renderQueuedProjection(group: Container, width: number, projections: { node: Component; rows: string[] }[]): string[] {
    const restores: { node: Component; own?: PropertyDescriptor; render: Component["render"] }[] = [];
    try {
      for (const { node, rows } of projections) {
        const own = Object.getOwnPropertyDescriptor(node, "render"), original = node.render;
        const render = function (this: Component, requestedWidth: number) {
          return requestedWidth === width ? rows : original.call(this, requestedWidth);
        };
        Object.defineProperty(node, "render", { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: render });
        restores.push({ node, own, render });
      }
      // Container.render also refreshes native hit geometry and strong child
      // references. Returning a fabricated block would leave that state stale.
      // Feed it projected rows through call-local public methods, not private fields.
      return containerRender.value.call(group, width) as string[];
    } finally {
      for (const { node, own, render } of restores) if (Object.getOwnPropertyDescriptor(node, "render")?.value === render) {
        if (own) Object.defineProperty(node, "render", own); else Reflect.deleteProperty(node, "render");
      }
    }
  }
  // Pi owns queued items and their edit-all shortcut. Only this verified native
  // prefix is projected; appended Bash/foreign components still render normally.
  // TruncatedText has no public source getter, so read its own text data field,
  // never queue/session internals or an arbitrary accessor. Do not patch its prototype.
  function queuedRows(group: Container, width: number): string[] | undefined {
    if (!(tui instanceof Container) || tui.children[1] !== group) return undefined;
    const fallback = () => { for (const child of group.children) forgetQueued(child);
      decision(group, "queued", "Queued-message projection delegated; no supported native prefix", width, 0); return undefined; };
    const height = tui.terminal?.rows, slots = tui.children, children = group.children, spacer = children[0];
    if (slots.length !== 7 || !slots.every(node => Object.getPrototypeOf(node) === Container.prototype) ||
      group.render !== observeWidgetRows || group.addChild !== patchedAdd || group.clear !== patchedClear || group.removeChild !== patchedRemove ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
      !spacer || Object.getPrototypeOf(spacer) !== Spacer.prototype || spacer.render !== observeWidgetSpacer) return fallback();
    const text = (node: Component): string | undefined => {
      if (Object.getPrototypeOf(node) !== TruncatedText.prototype || node.render !== truncatedRender || node.invalidate !== truncatedInvalidate) return undefined;
      const value: unknown = Object.getOwnPropertyDescriptor(node, "text")?.value;
      return typeof value === "string" ? value : undefined;
    };
    const messages: { node: Component; raw: string; mode: "Steering" | "Follow-up"; prefix: number }[] = [];
    let index = 1, hint = "";
    for (; index < children.length; index++) {
      const node = children[index]!, raw = text(node);
      if (raw === undefined) return fallback();
      // Inspect only the small native prefix on warm frames, not the entire body.
      const match = /^(?:\x1b\[[0-9;:]*m)*(Steering|Follow-up): /u.exec(raw);
      if (match) { messages.push({ node, raw, mode: match[1] as "Steering" | "Follow-up", prefix: match[0].length }); continue; }
      const label = /^↳ (.+ to edit all queued messages)$/u.exec(stripVTControlCharacters(raw));
      if (!label) return fallback();
      hint = label[1]!; break;
    }
    if (!messages.length || !hint) return fallback();
    const prefix = children.slice(0, index + 1);
    if (!prefix.every(node => {
      const own = Object.getOwnPropertyDescriptor(node, "render");
      return own ? "value" in own && own.configurable : Object.isExtensible(node);
    })) return fallback();
    if (width < 1) return renderQueuedProjection(group, width, prefix.map(node => ({ node, rows: [] })));
    const spacerRows = spacer.render(width);
    if (spacerRows.length !== 1 || spacerRows[0] !== "") {
      fallback();
      return renderQueuedProjection(group, width, [{ node: spacer, rows: spacerRows }]);
    }
    const theme = getTheme(), padding = outputPadding();
    const cards = messages.map(({ node, raw, mode, prefix }, position) => {
      const editHint = position === messages.length - 1 ? hint : "";
      const signature = [width, padding, theme, theme.fg, theme.bg, theme.style, theme.colors, raw, editHint];
      const state = queuedStates.get(node);
      if (state && signature.every((value, key) => value === state.signature[key])) {
        const retained = cache.get(state.entry); if (retained) return retained;
      } else { forgetQueued(node); cache.get(undefined); }
      const card = prepareQueuedCard(raw.slice(prefix), mode, editHint, width, theme, padding);
      diagnose(options.diagnostic, "DEBUG", "cache", "Queued-message layout built; native text is not logged", { mode, width, padding, rows: card.rows.length });
      queuedStates.set(node, { signature, entry: cache.put(card, [...card.rows, ...card.ellipsis], "queued") });
      return card;
    });
    // Height is a soft policy, not Pi's allocated dock height. Selecting prepared
    // rows cannot prevent the host from clipping an oversized minimum block.
    const blocks = projectQueuedCards(cards, height);
    let rowCount = spacerRows.length;
    const projected = messages.map(({ node }, position) => { const rows = blocks[position]!; rowCount += rows.length; return { node, rows }; });
    decision(group, "queued", "Verified queued-message prefix projected; Pi still owns editing and dock clipping", width, rowCount, { height, messages: messages.length });
    return renderQueuedProjection(group, width, [{ node: spacer, rows: spacerRows },
      ...projected,
      { node: children[index]!, rows: [] }]);
  }
  function observeContainerRows(this: Container, width: number): string[] {
    if (active) {
      try { const rows = queuedRows(this, width); if (rows) return rows; }
      catch { fail("pi-tidy-ui could not render queued messages; native rendering restored"); }
    }
    const position = active && parents.get(this);
    const input = tui instanceof Container && position && position.parent.children === tui.children &&
      (position.parent.children[3] === this || position.parent.children[2] === this) && position.parent.children[4];
    const editor = input instanceof Container && input.children[0];
    if (!(editor instanceof CustomEditor) || !stockEditor(editor))
      return containerRender.value.call(this, width) as string[];
    if (managedEditorSlots(editor)?.[2] === this) {
      const rows = containerRender.value.call(this, width) as string[];
      nativeStatusRows.set(this, { width, visible: rows.some(row => stripVTControlCharacters(row).trim().length > 0) });
      return rows;
    }
    if (upperWidgetGroup(editor) !== this) return containerRender.value.call(this, width) as string[];
    const previous = widgetSpacerPass;
    const pass = { spacer: this.children[0] as Spacer, width } as NonNullable<typeof widgetSpacerPass>;
    widgetSpacerPass = pass;
    try {
      const rows = containerRender.value.call(this, width) as string[];
      if (pass.rows === 1 && pass.blank && rows.length >= 1 && rows[0] === "" && upperWidgetGroup(editor) === this)
        upperWidgetRows.set(this, { width, rows: rows.length - 1, spacer: new WeakRef(pass.spacer) });
      else upperWidgetRows.delete(this);
      return rows;
    } finally { widgetSpacerPass = previous; }
  }
  function observeWidgetSpacer(this: Spacer, width: number): string[] {
    const rows = spacerRender.value.call(this, width) as string[];
    if (widgetSpacerPass?.spacer === this && widgetSpacerPass.width === width) {
      widgetSpacerPass.rows = rows.length;
      widgetSpacerPass.blank = rows[0] === "";
    }
    return rows;
  }
  function editorGap(editor: CustomEditor, width: number): number {
    const group = upperWidgetGroup(editor), measured = group && upperWidgetRows.get(group);
    return group && group.children.length > 1 && measured?.width === width && measured.rows > 0 &&
      measured.spacer.deref() === group.children[0] ? 1 : 0;
  }
  function patchEditorPrototype(prototype: object) {
    if (editorPatches.has(prototype)) return;
    if (editorPrototype.render !== editorRender || editorPrototype.handleMouse !== editorMouse ||
      editorPrototype.renderBottomBorder !== editorBottom) return;
    const patchedRender = function (this: CustomEditor, width: number): string[] {
      if (!active || !stockEditor(this) || (width > 0 && width < 7)) {
        editorStates.delete(this); const rows = editorRender.call(this, width);
        decision(this, "editor", "Native editor delegated; ownership or narrow-width guard rejected", width, rows.length); return rows;
      }
      try {
        const layout = renderEditorCard(width, this.getPaddingX(), getTheme(), (size, borderWidth) => {
          if (borderWidth === undefined) return { rows: editorRender.call(this, size), top: "", bottom: "" };
          const pass = { width: borderWidth, top: "", bottom: "" };
          editorPasses.set(this, pass);
          try { return { rows: editorRender.call(this, size), top: pass.top, bottom: pass.bottom }; }
          finally { editorPasses.delete(this); }
        });
        const { rows, ...mapping } = layout;
        const offsetY = mapping.framed ? editorGap(this, width) : 0;
        editorStates.set(this, { ...mapping, width, offsetY });
        decision(this, "editor", mapping.framed ? "Stock editor presentation projected; native input engine retained" : "Native editor projection fallback; inner geometry/content guard rejected", width, rows.length,
          { nativeWidth: mapping.nativeWidth, offsetX: mapping.offsetX, offsetY }, `${mapping.nativeWidth}:${mapping.offsetX}:${offsetY}`);
        if (mapping.framed && options.editorStatus) statusEditor = new WeakRef(this);
        return offsetY ? ["", ...rows] : rows;
      } catch {
        fail("pi-tidy-ui could not render this editor; native rendering restored");
        return editorRender.call(this, width);
      }
    };
    const patchedMouse = function (this: CustomEditor, event: TuiMouseEvent) {
      const state = editorStates.get(this);
      if (!active || !stockEditor(this) || !state?.framed || state.width !== event.width)
        return editorMouse.call(this, event);
      if (event.y < state.offsetY) return undefined; // The outside separator is not input or autocomplete.
      return editorMouse.call(this, { ...event, x: event.x - state.offsetX, y: event.y - state.offsetY,
        width: state.nativeWidth, height: Math.max(0, event.height - state.offsetY) });
    };
    const border = (name: "top" | "bottom", original: Function) => function (this: CustomEditor, width: number, hidden: number): string {
      const pass = editorPasses.get(this);
      if (!pass) return original.call(this, width, hidden) as string;
      const descriptor = Object.getOwnPropertyDescriptor(this, "borderColor")!, color = this.borderColor;
      // Only stock border-decoration fragments pass through this callback.
      // Native status literals/semantic styles use independent indicator callbacks.
      Object.defineProperty(this, "borderColor", { ...descriptor, value: (text: string) => color.call(this, text.replaceAll("─", " ")) });
      try { pass[name] = original.call(this, pass.width, hidden) as string; }
      finally { Object.defineProperty(this, "borderColor", descriptor); }
      return name === "top" ? EDITOR_TOP : EDITOR_BOTTOM;
    };
    const replacements = { render: patchedRender, handleMouse: patchedMouse,
      renderTopBorder: border("top", editorTop), renderBottomBorder: border("bottom", editorBottom) };
    const hooks = Object.entries(replacements).map(([name, wrapper]) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      if (original && (!original.writable || !original.configurable)) throw new Error("Native editor presentation hooks cannot be restored");
      return { name, original, wrapper };
    });
    editorPatches.set(prototype, hooks);
    for (const hook of hooks) Object.defineProperty(prototype, hook.name,
      { configurable: true, writable: true, ...hook.original, value: hook.wrapper });
  }
  function visit(node: Component, parent?: Container, index = -1) {
    if (!active) return;
    if (parent) parents.set(node, { parent, index });
    if (candidate(node)) install(node);
    else if (userCandidate(node)) installUser(node);
    else if (Object.getPrototypeOf(node) === CustomEditor.prototype) {
      patchEditorPrototype(CustomEditor.prototype); patchEditorPlacement(node as CustomEditor);
      if (stockEditor(node as CustomEditor)) statusEditor = new WeakRef(node as CustomEditor);
    }
    if (node instanceof Container) node.children.forEach((child, index) => visit(child, node, index));
  }
  function patchedAdd(this: Container, child: Component) {
    originalAdd.call(this, child);
    // A whole prebuilt subtree can be attached during history reconstruction.
    visit(child, this, this.children.length - 1);
  }
  function releaseTree(node: Component) {
    forgetQueued(node);
    if (candidate(node)) { forget(node); dropPrepared(node); removeAnimation(node); syntax?.remove(node); syntaxStates.delete(node); }
    else if (userCandidate(node)) forgetUser(node);
    parents.delete(node);
    if (node instanceof Container) for (const child of node.children) if (!attached(child)) releaseTree(child);
  }
  function pauseRendererTree(node: Component) {
    if (candidate(node)) { pauseSyntax(node); removeAnimation(node); }
    if (node instanceof Container) for (const child of node.children) pauseRendererTree(child);
  }
  function patchedRemove(this: Container, child: Component) {
    containerRemove.call(this, child);
    // A component already moved to another attached parent keeps its current layout.
    if (!this.children.includes(child) && !attached(child)) releaseTree(child);
  }
  function patchedClear(this: Container) {
    const children = this.children;
    // Pi clears the current renderer before moving the same tree through its stable TUI reference.
    const renderer = tui instanceof Container && this !== tui && children === tui.children;
    containerClear.call(this);
    for (const child of children) if (!this.children.includes(child) && !attached(child)) {
      if (!renderer) releaseTree(child);
      else { pauseRendererTree(child); rendererClears.push(new WeakRef(child)); }
    }
    if (rendererClears.length && !rendererClearPending) {
      rendererClearPending = true;
      queueMicrotask(rendererClearRetirement(new WeakRef(controller)));
    }
  }

  if (!(tui instanceof Container) || typeof tui.requestRender !== "function") {
    fail("The live Pi TUI does not share the host Container; native rendering retained");
    return controller;
  }
  try {
    active = true;
    visit(tui);
    if (active) {
      Container.prototype.addChild = patchedAdd;
      Container.prototype.clear = patchedClear;
      Container.prototype.removeChild = patchedRemove;
      Object.defineProperty(Container.prototype, "render", { ...containerRender, value: observeWidgetRows });
      Object.defineProperty(Spacer.prototype, "render", { ...spacerRender, value: observeWidgetSpacer });
      installingEditorHooks = false;
      rerouteNativeStatus();
      refresh();
    }
  } catch {
    fail("pi-tidy-ui could not install its UI hooks; native rendering restored");
  }
  return controller;
}

export interface TidyUiRuntimeOptions {
  cardPreparation?: TidyUiOptions['cardPreparation'];
  /** Isolated embedding/test roots; false explicitly disables automatic journals. */
  logging?: false | Omit<JournalOptions, "warn" | "enabled">;
  settings?: Pick<ExtensionSettings, 'load' | 'update'> & Partial<Pick<ExtensionSettings, 'watch'>>;
  /** An isolated process-memory owner for SDK embeddings. */
  localPreferences?: LocalPreferences;
  /** Isolated applied-color ownership for SDK terminals; production uses process memory. */
  terminalDefaults?: DefaultColors;
  /** Existing provider/settings bindings for controlled SDK embeddings. */
  syntax?: (ctx: ExtensionContext) => SyntaxRuntimeOptions;
}
interface SyntaxContext { current?: ExtensionContext }
interface DiagnosticContext extends SyntaxContext { session: string; logging?: SessionLogging }
function diagnosticCapture(owner: WeakRef<DiagnosticContext>): DiagnosticSink {
  return (level, area, message, fields) => owner.deref()?.logging?.sink(level, area, message, fields);
}
function runtimeNotice(owner: WeakRef<DiagnosticContext>) {
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) ctx.ui.notify(message, 'error'); };
}
function syntaxNotice(owner: WeakRef<SyntaxContext>) {
  return (message: string, type: "error") => owner.deref()?.current?.ui.notify(message, type);
}
function loggingNotice(owner: WeakRef<SyntaxContext>) {
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) ctx.ui.notify(message, "warning"); };
}

export default function tidyUi(pi: ExtensionAPI, options: TidyUiRuntimeOptions = {}) {
  pi.registerFlag("tidy-ui-card", { type: "string", description: "Additional comma-separated tool names that retain native cards" });
  pi.registerFlag("tidy-ui-compact", { type: "string", description: "Comma-separated tool names that use compact summaries instead of native cards" });
  const retiredBudgetFlags = ["tidy-ui-cache-mb", "tidy-ui-card-cache-mb"];
  for (const flag of retiredBudgetFlags) pi.registerFlag(flag, { type: "string", description: "Deprecated and ignored: layouts are retained per component without eviction limits" });
  let warnedBudgetFlags = false;
  let controller: TidyUiController | undefined;
  const local = options.localPreferences ?? processPreferences();
  let enabled = local.appearanceEnabled, colorsEnabled = false, loggingEnabled = local.loggingEnabled;
  // Only confirmed choices survive runtime replacement; menu previews are client-local.
  let selectedTheme: SyntaxTheme = { kind: 'pi' };
  const settings = options.settings ?? new ExtensionSettings();
  let preferencesReady: Promise<void> | undefined, preferencesLoaded = false;
  let preferencesIssue: string | undefined;
  let lifecycle = 0;
  let saveAbort = new AbortController();
  let activeMenu: TidyMenu | undefined;
  let unwatchSettings: (() => void) | undefined;
  let lastSettingsIssue: string | undefined;
  function loadPreferences(): Promise<void> {
    return preferencesReady ??= (async () => {
      try {
        const loaded = await settings.load();
        colorsEnabled = loaded.terminalColorsEnabled ?? false;
        syntaxEnabled = loaded.nativeHighlightingEnabled ?? true;
        selectedTheme = loaded.syntaxTheme;
        if (!loaded.ok) preferencesIssue = lastSettingsIssue = loaded.issue.message;
      } catch { preferencesIssue = 'Settings could not be read; using defaults.'; }
      finally { preferencesLoaded = true; }
    })();
  }
  function applySavedPreferences(loaded: SettingsLoadResult, ctx: ExtensionContext, epoch: number) {
    if (epoch !== lifecycle || saveAbort.signal.aborted) return;
    if (!loaded.ok) {
      reportRuntime(diagnostic, { kind: 'failure', scope: settings, operation: 'read', area: 'settings', code: 'settings_read' });
      if (lastSettingsIssue !== loaded.issue.message) diagnose(diagnostic, 'ERROR', 'settings', 'Shared preferences could not be read; current preferences retained');
      lastSettingsIssue = loaded.issue.message; return;
    }
    lastSettingsIssue = undefined;
    reportRuntime(diagnostic, { kind: 'recovered', scope: settings, operation: 'read' });
    const choice = loaded.syntaxTheme;
    const themeChanged = choice.kind !== selectedTheme.kind || choice.kind === 'theme' && selectedTheme.kind === 'theme' && choice.id !== selectedTheme.id;
    const colorsChanged = colorsEnabled !== (loaded.terminalColorsEnabled ?? false);
    const nativeChanged = syntaxEnabled !== (loaded.nativeHighlightingEnabled ?? true);
    if (!themeChanged && !colorsChanged && !nativeChanged) return;
    selectedTheme = { ...choice }; syntaxEnabled = loaded.nativeHighlightingEnabled ?? true;
    if (colorsChanged) applyTerminalPreference(loaded.terminalColorsEnabled ?? false, ctx);
    const previewing = activeMenu?.preferencesChanged(selectedTheme);
    if (themeChanged && !previewing) syntax?.applySavedTheme(selectedTheme);
    if (nativeChanged) {
      void syntax?.setEnabled(syntaxEnabled).catch(() => { if (epoch === lifecycle && ctx.hasUI) ctx.ui.notify('pi-tidy-ui: Native highlighting preference could not be applied.', 'warning'); });
    }
    diagnose(logging?.sink, 'INFO', 'runtime', 'Shared preferences refreshed without writing configuration', { themeChanged, colorsChanged, nativeChanged });
  }
  function reportPreferencesIssue() {
    if (preferencesIssue) {
      reportRuntime(diagnostic, { kind: 'failure', scope: settings, operation: 'read', area: 'settings', code: 'settings_read' });
      diagnose(diagnostic, 'ERROR', 'settings', 'Preferences could not be loaded; defaults used');
      preferencesIssue = undefined;
    }
  }
  let liveContext: ExtensionContext | undefined;
  let syntax: SyntaxRuntime | undefined, syntaxEnabled = true;
  // Only primitive IDs for the current assistant stream; never retain message bodies/history.
  const liveBashCalls = new Set<string>();
  const syntaxContext: SyntaxContext = {};
  let logging: SessionLogging | undefined, loggingContext: SyntaxContext | undefined;
  let health: RuntimeHealth | undefined, diagnostic: DiagnosticSink | undefined, diagnosticContext: DiagnosticContext | undefined;
  function startLogging(ctx: ExtensionContext, reason: string) {
    const identity = ctx.sessionManager.getSessionId();
    if (diagnosticContext?.session !== identity) {
      health?.dispose();
      if (diagnosticContext) { diagnosticContext.current = undefined; diagnosticContext.logging = undefined; }
      diagnosticContext = { current: ctx, session: identity };
      const owner = new WeakRef(diagnosticContext);
      health = new RuntimeHealth(runtimeNotice(owner)); diagnostic = health.sink(diagnosticCapture(owner));
    } else diagnosticContext.current = ctx;
    if (options.logging === false) return;
    const session = ctx.sessionManager.getSessionId();
    if (logging?.status().session === session) { if (loggingContext) loggingContext.current = ctx; return; }
    const previous = logging; if (loggingContext) loggingContext.current = undefined;
    void previous?.close("session switch");
    loggingContext = { current: ctx };
    logging = new SessionLogging({ session, sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd,
      extension: extensionVersion, pi: VERSION, reason, mode: ctx.mode, provider: ctx.model?.provider, theme: ctx.ui.theme.name },
      { ...options.logging, enabled: loggingEnabled, warn: loggingNotice(new WeakRef(loggingContext)) });
    diagnosticContext!.logging = logging;
    loggingDebug = new WeakRef(logging);
  }
  function logSnapshot() {
    if (!logging?.status().capture) return;
    const sink = logging.sink;
    diagnose(sink, "INFO", "runtime", "Snapshot of existing runtime state", { presentation: enabled, adapter: controller?.active ?? false,
      syntax: syntaxEnabled, terminalColors: colorsEnabled, footer: !!ownedFooter, mode: liveContext?.mode });
    controller?.logSnapshot();
    diagnose(sink, "INFO", "git", "Snapshot of existing process Git counters", gitDiagnostics());
    if (controller) { const stats = controller.cacheStats(); diagnose(sink, "INFO", "cache", "Snapshot of existing layout counters", {
      entries: stats.entries, rows: stats.rows, bytes: stats.retainedBytes, hits: stats.hits, misses: stats.misses, builds: stats.builds,
      releases: stats.releases, collected: stats.collected }); }
    if (health) { const status = health.snapshot(); diagnose(sink, 'INFO', 'runtime', 'Snapshot of runtime health; distinct from log write failures', { errors: status.errors, active: status.active, code: status.last?.code, state: status.last?.state }); }
    if (syntax) { const stats = syntax.sources.stats(), snapshot = syntax.snapshot(); diagnose(sink, "INFO", "syntax", "Snapshot of existing source/provider state", {
      availability: snapshot.provider.availability, reason: snapshot.provider.reason, generation: snapshot.provider.generation,
      kind: snapshot.provider.kind, theme: snapshot.selected.kind, palette: snapshot.effective?.id,
      sourceRecords: stats.sourceRecords, piSourceRecords: stats.piSourceRecords, leases: stats.remoteLeases,
      jobs: stats.unsettledJobs, closes: stats.pendingCloses, bytes: stats.transientBytes, bookkeepingBytes: stats.bookkeepingBytes }); }
    if (colors) diagnose(sink, "INFO", "terminal-colors", "Snapshot of existing terminal-color counters", { ...colors.status(), ...colors.stats() });
  }
  function ensureSyntax(ctx: ExtensionContext) {
    syntaxContext.current = ctx;
    syntax ??= new SyntaxRuntime({ ...(options.syntax ? options.syntax(ctx) : createSyntaxOptions(ctx, undefined, diagnostic)),
      settings, initialTheme: selectedTheme,
      diagnostic, enabled: syntaxEnabled,
      enabledChanged: value => { syntaxEnabled = value; }, notify: syntaxNotice(new WeakRef(syntaxContext)) });
    return syntax;
  }
  function stopSyntax() {
    const previous = syntax;
    syntax = undefined;
    return previous?.dispose();
  }
  let colors: TerminalColors | undefined;
  const colorWidget = "pi-tidy-ui-terminal-colors";
  let detachColorLifecycle: (() => void) | undefined;
  function stopColors(preserveDefaults = false) {
    const previous = colors; colors = undefined;
    detachColorLifecycle?.(); detachColorLifecycle = undefined;
    if (previous) diagnose(logging?.sink, "INFO", "terminal-colors", "Terminal-color observer removed from public widget", { preserveDefaults });
    previous?.dispose({ preserveDefaults });
    if (previous) liveContext?.ui.setWidget(colorWidget, undefined);
  }
  function startColors(ctx: ExtensionContext) {
    if (!enabled || ctx.mode !== "tui") return;
    if (colors) { colors.observe(); return; }
    ctx.ui.setWidget(colorWidget, tui => {
      const reference = new WeakRef(tui);
      const view = new TerminalColors({
        defaults: options.terminalDefaults ?? processTerminalDefaults(),
        diagnostic,
        snapshot() {
          const current = liveContext!;
          return { enabled: enabled && colorsEnabled && current?.mode === "tui", presenting: enabled && current?.mode === "tui", theme: current.ui.theme,
            configured: pi.getSettings().theme, automatic: detachColorLifecycle && reference.deref() ? terminalAppearanceTracking(reference.deref()!) : undefined };
        },
        source: name => name ? liveContext?.ui.getAllThemes?.().find(item => item.name === name)?.path : undefined,
        write: data => {
          const terminal = reference.deref()?.terminal;
          if (!terminal || typeof terminal.write !== "function") throw new Error("Terminal writer unavailable");
          terminal.write(data);
        },
        query: late => reference.deref()?.queryTerminalColors({ timeoutMs: 100, onLateReply: late }) ?? Promise.resolve({}),
        changed: force => {
          // A forced request resets TUI diff state, so wait until observer rendering returns.
          if (force) queueMicrotask(() => { if (colors === view) reference.deref()?.requestRender(true); });
          else reference.deref()?.requestRender();
        },
        warn: message => liveContext?.ui.notify(`pi-tidy-ui colors: ${message}`, "warning"),
      });
      detachColorLifecycle = bindTerminalLifecycle(tui.terminal, ensureSyntax(ctx), view);
      colors = view; terminalColorDebug = new WeakRef(view);
      view.observe();
      return { render() { if (colors === view) view.observe(); return []; }, invalidate() { if (colors === view) view.observe(); } };
    }, { placement: "belowEditor" });
  }
  function applyTerminalPreference(value: boolean, ctx: ExtensionContext) {
    colorsEnabled = value;
    if (!value) colors?.observe();
    else if (colors) colors.observe(true);
    else startColors(ctx);
  }
  const palette = () => colors?.palette(liveContext!.ui.theme) ?? liveContext!.ui.theme;
  let directorySource: GitBranchSource | undefined;
  let ownedFooter: FooterView | undefined;
  let footerRender: WeakRef<{ requestRender(): void }> | undefined;
  let footerEpoch = 0;
  let footerName: { session: string; value: string | undefined } | undefined;
  function restoreFooter() {
    // Public dispose tells us when another owner replaced our component.
    if (ownedFooter) { diagnose(logging?.sink, "INFO", "footer", "Owned footer released through public UI; native placement restored"); liveContext?.ui.setFooter(undefined); }
  }
  let footerRestoreQueued = false, footerStartQueued = false;
  let pendingFooter: { slot: WeakRef<Container>; owner: WeakRef<Component> } | undefined;
  function finishFooterStart() {
    if (!pendingFooter || !controller?.editorActive || footerStartQueued) return;
    footerStartQueued = true;
    const pending = pendingFooter;
    queueMicrotask(() => {
      footerStartQueued = false;
      if (pendingFooter !== pending) return;
      pendingFooter = undefined;
      // /reload can mount a selector during session_start. Wait for the default
      // input, but never claim a slot another extension replaced meanwhile.
      const owner = pending?.owner.deref();
      if (owner && liveContext && pending?.slot.deref()?.children[0] === owner) { diagnose(logging?.sink, "INFO", "footer", "Deferred footer installation allowed after stock editor return"); startFooter(liveContext); }
      else diagnose(logging?.sink, "INFO", "footer", "Deferred footer installation cancelled; former slot is no longer owned");
    });
  }
  function footerActive() {
    if (controller?.editorActive) return true;
    if (ownedFooter && !footerRestoreQueued) {
      footerRestoreQueued = true;
      diagnose(logging?.sink, "INFO", "footer", "Footer release queued after stock editor ownership lost");
      // Finish native measurement before changing its footer container.
      queueMicrotask(() => {
        footerRestoreQueued = false;
        if (!controller?.editorActive) restoreFooter();
      });
    }
    return false;
  }
  function startFooter(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !enabled || !controller?.editorActive || ownedFooter || typeof ctx.ui.setFooter !== "function") return;
    pendingFooter = undefined;
    const diagnostic = logging?.sink;
    diagnose(diagnostic, "INFO", "footer", "Custom footer installed beside owned stock input");
    ctx.ui.setFooter((_tui, _theme, data) => {
      footerRender = new WeakRef(_tui);
      let snapshot: FooterData | undefined;
      let firstMessage: string | undefined;
      let stamp: { epoch: number; session: string; leaf: string | null; model: ExtensionContext["model"] } | undefined;
      const view = new FooterView(() => {
        const current = liveContext!;
        const manager = current.sessionManager, session = manager.getSessionId(), leaf = manager.getLeafId(), model = current.model;
        if (footerName?.session !== session) footerName = { session, value: manager.getSessionName() };
        if (stamp?.session !== session) firstMessage = undefined;
        if (stamp?.session === session && stamp.leaf !== leaf) {
          // Metadata-only appends move the leaf but do not change usage/context.
          let entry = manager.getLeafEntry();
          while (entry?.type === "session_info") {
            if (entry.parentId === stamp.leaf) { stamp.leaf = leaf; break; }
            entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
          }
        }
        const auto = pi.getSettings().compaction?.enabled ?? true;
        const subscription = FOOTER_FIELDS.cost && !!model && (model.provider === "kimi-coding" ||
          (current.modelRegistry.isUsingOAuth(model) && current.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true));
        if (!snapshot || !stamp || stamp.epoch !== footerEpoch || stamp.session !== session || stamp.leaf !== leaf || stamp.model !== model) {
          const entries = manager.getEntries();
          firstMessage ??= footerFirstMessage(entries);
          snapshot = { usage: footerUsage(entries), context: current.getContextUsage(), auto, subscription, sessionName: footerName.value ?? firstMessage ?? "(no messages)" };
          diagnose(diagnostic, "DEBUG", "footer", "Footer usage snapshot refreshed by existing semantic boundary", { epoch: footerEpoch, session, model: model?.name, provider: model?.provider, auto });
          stamp = { epoch: footerEpoch, session, leaf, model };
        } else {
          const sessionName = footerName.value ?? firstMessage ?? "(no messages)";
          if (snapshot.auto !== auto || snapshot.subscription !== subscription || snapshot.sessionName !== sessionName)
            snapshot = { ...snapshot, auto, subscription, sessionName };
        }
        return snapshot;
      }, () => data.getExtensionStatuses(), () => liveContext!.ui.theme, footerActive, diagnostic);
      ownedFooter = view;
      return Object.assign(view, { dispose() {
        view.clear(); snapshot = undefined; stamp = undefined; firstMessage = undefined;
        diagnose(diagnostic, "INFO", "footer", "Public footer disposal observed; no replacement of a later owner");
        if (ownedFooter === view) { ownedFooter = undefined; footerRender = undefined; }
      } });
    });
  }
  const statusWidget = "pi-tidy-ui-editor-status";
  const names = (flag: string) => String(pi.getFlag(flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  function start(ctx: ExtensionContext) {
    liveContext = ctx; syntaxContext.current = ctx;
    startLogging(ctx, "presentation startup");
    footerEpoch++;
    directorySource?.refresh(true);
    if (ctx.mode !== "tui" || !enabled) { diagnose(logging?.sink, "INFO", "runtime", "Presentation startup skipped", { mode: ctx.mode, enabled }); return; }
    startColors(ctx);
    if (controller?.active) { diagnose(logging?.sink, "INFO", "runtime", "Existing presentation reused"); startFooter(ctx); return; }
    if (!warnedBudgetFlags) {
      warnedBudgetFlags = true;
      for (const flag of retiredBudgetFlags) if (pi.getFlag(flag) !== undefined)
        ctx.ui.notify(`pi-tidy-ui: --${flag} is ignored; layouts are retained per component without eviction limits`, "warning");
    }
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-tidy-ui-capture", (tui) => {
      const slot = tui.children.length === 7 ? tui.children[6] : undefined;
      if (ctx.ui.getEditorComponent() === undefined && slot instanceof Container && slot.children.length === 1)
        pendingFooter = { slot: new WeakRef(slot), owner: new WeakRef(slot.children[0]!) };
      const sourceRuntime = ensureSyntax(ctx);
      if (controller) reportRuntime(diagnostic, { kind: 'released', scope: controller, operation: '*' });
      controller = installTidyUi(tui, palette, {
        diagnostic, cardPreparation: options.cardPreparation,
        syntax: { client: sourceRuntime, palette: () => sourceRuntime.palette({ colors: palette().colors! }), isLiveCall: id => liveBashCalls.has(id) },
         colorMode: () => liveContext!.ui.theme.getColorMode(),
         piInput: () => { const theme = liveContext!.ui.theme, projected = palette().colors as PiInputTheme['colors'], mode = theme.getColorMode();
          return { theme: { colors: projected, getFgAnsi: role => theme.getFgAnsi(role),
            // Only the local terminal-default projection proves a concrete background.
            getBgAnsi: role => projected[role] !== theme.colors[role] ? backgroundAnsi(projected[role], mode) : theme.getBgAnsi(role) }, mode }; },
         preparePaletteInput: (effective, theme, revision, mode, funding, usePiFallback, fallbackTheme) =>
           sourceRuntime.preparePaletteInput(effective, theme, revision, mode, funding, usePiFallback, fallbackTheme),
        cards: names("tidy-ui-card"), compact: names("tidy-ui-compact"),
        outputPad: () => pi.getSettings().outputPad ?? 1,
        nativeEditor: () => liveContext?.ui.getEditorComponent() === undefined,
        editorStatus: true,
        rerouteEditorStatus: () => liveContext?.ui.setEditorComponent(undefined),
        editorStatusRestored: () => {
          directorySource?.dispose(); directorySource = undefined;
          liveContext?.ui.setWidget(statusWidget, undefined);
        },
        warn: (message) => { restoreFooter(); if (!diagnostic?.runtime) liveContext?.ui.notify(`pi-tidy-ui disabled: ${message}`, "warning"); },
      });
      diagnose(logging?.sink, "INFO", "runtime", "Presentation installation finished", { active: controller.active, reason: controller.reason });
      if (controller.active) sourceRuntime.attach(controller);
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-tidy-ui-capture", undefined);
    if (controller?.active) ctx.ui.setWidget(statusWidget, (tui) => {
      directorySource ??= new GitBranchSource(() => tui.requestRender(), { diagnostic });
      return {
      render(width) {
        const current = liveContext;
        if (!current || !controller?.active) return [];
        finishFooterStart();
        directorySource?.setDirectory(controller.editorStatusActive && typeof current.cwd === "string" ? current.cwd : undefined);
        return controller.renderEditorStatus(width, { model: current.model?.name || "No model",
          provider: current.model?.provider || "—", thinking: current.thinkingLevel ?? pi.getThinkingLevel(), idle: current.isIdle(),
          cwd: current.cwd, branch: directorySource?.branch(current.cwd) });
      },
      invalidate() {},
    }; }, { placement: "belowEditor" });
    startFooter(ctx);
  }
  const refreshFooter = (event: unknown, ctx: ExtensionContext) => {
    liveContext = ctx; syntaxContext.current = ctx; footerEpoch++;
    const kind = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
    diagnose(logging?.sink, "DEBUG", "runtime", "Pi semantic boundary observed; existing footer snapshot invalidated", {
      event: typeof kind === "string" && ["session_tree", "session_compact", "model_select", "message_end", "turn_end", "agent_end", "tool_execution_end"].includes(kind) ? kind : "unspecified",
      model: ctx.model?.name, provider: ctx.model?.provider, thinking: ctx.thinkingLevel });
  };
  pi.on("message_start", (event) => { if (event.message.role === 'assistant') liveBashCalls.clear(); });
  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== 'tui') return;
    const delta = event.assistantMessageEvent;
    if (delta.type !== 'toolcall_start' && delta.type !== 'toolcall_delta' && delta.type !== 'toolcall_end') return;
    const call = delta.partial.content[delta.contentIndex];
    if (call?.type === 'toolCall' && call.name === 'bash') liveBashCalls.add(call.id);
  });
  pi.on("session_tree", refreshFooter);
  pi.on("session_compact", refreshFooter);
  pi.on("model_select", refreshFooter);
  pi.on("message_end", refreshFooter);
  pi.on("turn_end", refreshFooter);
  const refreshDirectory = (_event: unknown, ctx: ExtensionContext) => {
    refreshFooter(_event, ctx);
    directorySource?.setDirectory(controller?.editorStatusActive ? ctx.cwd : undefined);
    directorySource?.refresh(true);
  };
  pi.on("tool_execution_end", refreshDirectory);
  pi.on("agent_end", (event, ctx) => { liveBashCalls.clear(); refreshDirectory(event, ctx); });
  pi.on('session_start', async (event, ctx) => {
    activeMenu?.close(); activeMenu = undefined;
    const current = ++lifecycle;
    saveAbort.abort(); saveAbort = new AbortController();
    liveBashCalls.clear(); footerName = undefined;
    if (!preferencesLoaded) await loadPreferences();
    if (current !== lifecycle) return;
    startLogging(ctx, event.reason); reportPreferencesIssue(); start(ctx);
    unwatchSettings?.(); unwatchSettings = settings.watch?.(loaded => applySavedPreferences(loaded, ctx, current));
  });
  pi.on("session_info_changed", (event) => {
    // Async handlers may deliver old notifications last; reread current saved metadata once.
    footerName = undefined;
    if (ownedFooter) footerRender?.deref()?.requestRender();
    logging?.nameChanged(event.name);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    ++lifecycle; saveAbort.abort(); unwatchSettings?.(); unwatchSettings = undefined; activeMenu?.close(); activeMenu = undefined;
    liveBashCalls.clear(); footerName = undefined;
    liveContext = ctx; logSnapshot(); pendingFooter = undefined; health?.dispose();
    controller?.quiesce();
    try { await stopSyntax(); }
    finally {
      try { await logging?.close(event.reason); }
      finally {
        logging = undefined;
        if (loggingContext) loggingContext.current = undefined; loggingContext = undefined;
        try { stopColors(event.reason !== 'quit'); }
        finally {
          try { restoreFooter(); }
          finally {
            try { controller?.restore({ repaint: false }); }
            finally { controller = undefined; liveContext = undefined; syntaxContext.current = undefined;
              if (diagnosticContext) { diagnosticContext.current = undefined; diagnosticContext.logging = undefined; }
              diagnosticContext = undefined; diagnostic = undefined; health = undefined; }
          }
        }
      }
    }
  });
  function menuOwner(ctx: ExtensionContext, epoch: number): TidyMenuOwner {
    const current = () => lifecycle === epoch && !saveAbort.signal.aborted;
    const retired: SyntaxMenuOutcome = { ok: false, message: 'This settings action belongs to a closed runtime.' };
    async function act(action: TidyMenuAction): Promise<SyntaxMenuOutcome & { cache?: string[] }> {
      if (!current()) return retired;
      diagnose(logging?.sink, 'INFO', 'runtime', 'Settings menu action requested', { action: action.kind });
      if (action.kind === 'switch') {
        // Queue confirmations in order, before cleanup can outlive this popup.
        const persistent = action.key === 'terminalColorsEnabled' || action.key === 'nativeHighlightingEnabled';
        const saving = persistent ? settings.update({ [action.key]: action.value }, { signal: saveAbort.signal }).catch(() => undefined) : undefined;
        switch (action.key) {
          case 'appearanceEnabled':
            enabled = local.appearanceEnabled = action.value;
            if (enabled) start(ctx);
            else {
              pendingFooter = undefined; stopColors(); restoreFooter();
              if (controller) reportRuntime(diagnostic, { kind: 'released', scope: controller, operation: '*' });
              controller?.restore(); await stopSyntax();
            }
            break;
          case 'terminalColorsEnabled':
            applyTerminalPreference(action.value, ctx);
            break;
          case 'nativeHighlightingEnabled':
            syntaxEnabled = action.value; await syntax?.setEnabled(action.value); break;
          case 'loggingEnabled':
            loggingEnabled = local.loggingEnabled = action.value; await logging?.setEnabled(action.value); break;
        }
        const outcome = await saving;
        if (!current()) return retired;
        if (persistent && (!outcome || !outcome.ok)) {
          reportRuntime(diagnostic, { kind: 'failure', scope: settings, operation: 'save', area: 'settings', code: 'settings_save' });
          diagnose(diagnostic, 'ERROR', 'settings', 'Applied preference could not be saved');
          return { ok: false, message: outcome && !outcome.ok ? `Applied for now, but not saved: ${outcome.issue.message}` : 'Applied for now, but settings could not be saved.' };
        }
        if (persistent) reportRuntime(diagnostic, { kind: 'recovered', scope: settings, operation: 'save' });
        if (action.key === 'loggingEnabled' && action.value && logging?.status().state === 'failed')
          return { ok: false, message: 'Recording failed. See Diagnostic logs to retry.' };
        return { ok: true };
      }
      if (action.kind === 'theme') {
        const runtime = ensureSyntax(ctx);
        selectedTheme = action.choice;
        const outcome = await runtime.selectTheme(action.choice);
        if (!current() || syntax !== runtime) return retired;
        return outcome.ok ? outcome : { ok: false, message: `Theme applied for now, but not saved: ${outcome.message}` };
      }
      if (action.kind === 'reapplyAppearance') {
        if (!enabled) return { ok: false, message: 'Turn on Tidy UI appearance first.' };
        start(ctx);
      } else if (action.kind === 'reapplyColors') {
        if (!enabled || !colorsEnabled) return { ok: false, message: 'Turn on appearance and terminal color matching first.' };
        if (colors) colors.reapply(); else startColors(ctx);
      } else if (action.kind === 'clearCache') {
        if (!controller?.active) return { ok: false, message: 'There are no active Tidy UI layouts to clear.' };
        controller.clearCache(); ownedFooter?.clear();
        return { ok: true, cache: owner.cacheDetails() };
      } else if (action.kind === 'retryLogging') {
        if (!loggingEnabled || !logging) return { ok: false, message: 'Turn on diagnostic recording first.' };
        await logging.setEnabled(true);
        if (logging.status().state !== 'active') return { ok: false, message: 'Recording could not be started. See the log status for details.' };
      } else if (action.kind === 'snapshotLogs') {
        const log = logging;
        if (!log?.status().capture || log.status().state !== 'active')
          return { ok: false, message: 'Snapshot not written: diagnostic recording is off or unavailable.' };
        logSnapshot(); await log.flush();
        if (!current() || logging !== log) return retired;
        if (log.status().state !== 'active') return { ok: false, message: 'The diagnostic snapshot could not be written.' };
      }
      return current() ? { ok: true } : retired;
    }
    const owner: TidyMenuOwner = {
      snapshot() {
        const color = colors?.status().state;
        const terminalColors = !enabled ? 'Inactive while Tidy UI appearance is off' : !colorsEnabled ? 'Off' :
          color === 'automatic theme' || color === 'system theme' ? 'Controlled by Pi’s automatic/system theme' :
          color === 'on' ? 'Matching Pi theme' : color === 'no source' ? 'No file-backed Pi theme available' :
          color === 'source error' ? 'Theme could not be read; last valid colors retained' : color ?? 'Not started';
        const snapshot = syntax?.snapshot();
        return { appearanceEnabled: enabled, terminalColorsEnabled: colorsEnabled, nativeHighlightingEnabled: syntaxEnabled, loggingEnabled,
          selected: snapshot?.selected ?? selectedTheme, syntax: snapshot, logs: logging?.status(), health: health?.snapshot(), terminalColors,
          appearance: !enabled ? 'Off; using Pi’s interface' : !controller?.active ? controller?.reason ?? 'Not active' :
            controller.editorActive ? 'Active' : 'Cards active; input styling not applied' };
      },
      async prepareThemes() { if (current()) await ensureSyntax(ctx).prepareThemes(); },
      previewTheme(choice) { if (current()) syntax?.previewTheme(choice); },
      act,
      cacheDetails() {
        if (!controller) return ['No active display cache.'];
        const stats = controller.cacheStats();
        const footer = ownedFooter?.retainedMemory() ?? { retainedBytes: 0, entries: 0, rows: 0 };
        const diagnostic = { ...stats, footerLayout: footer,
          presentationRetainedBytes: stats.retainedBytes + footer.retainedBytes, presentationEntries: stats.entries + footer.entries,
          presentationRows: stats.rows + footer.rows, memoryScope: 'estimated pi-tidy-ui retained UTF-16 strings plus structural overhead; excludes Pi caches, Markdown/editor and temporary rendering',
          processHeapUsedBytes: process.memoryUsage().heapUsed, processMemoryScope: 'whole Pi process, not pi-tidy-ui' };
        return [`Saved layouts: ${stats.entries + footer.entries}; rows: ${stats.rows + footer.rows}`,
          `Estimated retained memory: ${stats.retainedBytes + footer.retainedBytes} bytes`,
          `Hits: ${stats.hits}; misses: ${stats.misses}; builds: ${stats.builds}; releases: ${stats.releases}; collected: ${stats.collected}`,
          ...LAYOUT_KINDS.map(kind => `${kind}: ${JSON.stringify(stats.byKind[kind])}`),
          `Footer: ${JSON.stringify(footer)}`,
          'Scope: Tidy UI display layouts only; excludes Pi caches, syntax sources and temporary rendering.',
          `Whole Pi process heap: ${diagnostic.processHeapUsedBytes} bytes (not Tidy UI memory)`,
          'Diagnostic JSON:', JSON.stringify(diagnostic).replaceAll(' ', '\\u0020'), 'End diagnostic JSON'];
      },
    };
    return owner;
  }
  pi.registerCommand('tidy-ui', {
    description: 'Open Tidy UI appearance settings, status and troubleshooting',
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify('Usage: /tidy-ui — open the settings menu; command arguments are no longer supported.', 'warning'); return; }
      if (ctx.mode !== 'tui' || !ctx.hasUI) { ctx.ui.notify('pi-tidy-ui: menu is available only in terminal mode with UI.', 'info'); return; }
      const epoch = lifecycle;
      await loadPreferences();
      if (epoch !== lifecycle) return;
      reportPreferencesIssue();
      liveContext = ctx; syntaxContext.current = ctx;
      if (loggingContext) loggingContext.current = ctx;
      activeMenu?.close();
      let opened: TidyMenu | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          if (epoch !== lifecycle) { done(); return { render: () => [], invalidate() {} }; }
          const menu = new TidyMenu(menuOwner(ctx, epoch), theme, () => tui.requestRender(), () => done(), () => tui.terminal.rows);
          opened = activeMenu = menu; return menu;
        }, { overlay: true, overlayOptions: { anchor: 'center', get width() { return opened?.preferredWidth() ?? 1; }, maxHeight: '100%', margin: 0 } });
      } catch { if (epoch === lifecycle) ctx.ui.notify('pi-tidy-ui: Settings menu could not be opened.', 'error'); }
      finally { opened?.dispose(); if (activeMenu === opened) activeMenu = undefined; }
    },
  });
  // Pi awaits the factory; startup can attach presentation without another I/O gap.
  return loadPreferences();
}
