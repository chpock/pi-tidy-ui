import { CustomEditor, createEditToolDefinition, highlightCode, getLanguageFromPath, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Editor, Markdown, Spacer, TruncatedText, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { isAbsolute, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderBashCard } from "./bash-card.ts";
import { filePath, measureFileCard, renderFileCard } from "./file-card.ts";
import { renderUserCard } from "./user-card.ts";
import { prepareQueuedCard, projectQueuedCards, type QueuedCard } from "./queued-card.ts";
import { EDITOR_TOP, EDITOR_BOTTOM, renderEditorCard, type EditorLayout } from "./editor-card.ts";
import { cardGeometry, insidePanel } from "./card-frame.ts";
import { renderEditorStatus, type EditorStatusInfo } from "./editor-status.ts";
import { GitBranchSource } from "./git-branch.ts";
import { FOOTER_FIELDS, FooterView, footerUsage, type FooterData } from "./footer.ts";
import { TerminalColors, terminalColorExit } from "./terminal-colors.ts";
import type { CardTheme } from "./card-theme.ts";
import { RenderCache, LAYOUT_KINDS, MEMORY_FIELDS, type LayoutKind, type LayoutMemory, type CacheEntry, type CacheStats } from "./render-cache.ts";
import { argumentParts, summaryName } from "./summary-args.ts";
export { describeArgs, sanitize } from "./summary-args.ts";
let terminalColorDebug: WeakRef<TerminalColors> | undefined;
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
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown };
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

export interface ToolviewOptions {
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
export interface ToolviewCacheStats extends CacheStats { ordinary: CacheStats; cards: CacheStats }
export interface ToolviewController {
  readonly active: boolean;
  readonly reason: string | undefined;
  readonly editorStatusActive: boolean;
  /** Recognized input ownership, including temporary native selector detachment. */
  readonly editorActive: boolean;
  restore(): void;
  renderEditorStatus(width: number, info: EditorStatusInfo): string[];
  cacheStats(): ToolviewCacheStats;
  clearCache(): void;
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
export function installToolview(tui: LiveTui, getTheme: () => Palette, options: ToolviewOptions = {}): ToolviewController {
  let active = false;
  let reason: string | undefined;
  const parents = new WeakMap<Component, { parent: Container; index: number }>();
  const cache = new RenderCache();
  const cardCache = new RenderCache();
  type Layout = { rows: string[]; framed?: boolean; native?: boolean };
  type SummaryLayout = Layout & { prefixLength: number; prefixLeft: number; prefixSpace: boolean };
  // One plain snapshot per normal transcript pass; direct component visits read live settings.
  let passOutputPad: number | undefined;
  const outputPadding = () => passOutputPad ?? (options.outputPad?.() === 0 ? 0 : 1);
  const animated = new Set<WeakRef<ToolNode>>();
  let animationRefs = new WeakMap<ToolNode, WeakRef<ToolNode>>();
  let spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerEpoch: number | undefined, passSpinnerTime: number | undefined;
  let spinnerGeneration = 0, spinnerPending = false;
  function stopSpinner() {
    if (spinnerTimer !== undefined) clearTimeout(spinnerTimer);
    spinnerTimer = undefined;
    spinnerGeneration++; // Cancel callbacks already queued for the old deadline/lifecycle.
    spinnerPending = false;
    spinnerEpoch = undefined;
  }
  function removeAnimation(node: ToolNode) {
    const reference = animationRefs.get(node);
    if (reference) { animated.delete(reference); animationRefs.delete(node); }
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
    if (!active || !animated.size || spinnerPending) return;
    if (spinnerTimer !== undefined) clearTimeout(spinnerTimer);
    const generation = ++spinnerGeneration;
    // Native Working already drives whole-document frames. This is a fallback
    // after 100ms without a successful document visit, not another periodic clock.
    // Construct it here, never in animate(node)'s component-containing scope.
    spinnerTimer = setTimeout(function tickSpinner() {
      if (!active || generation !== spinnerGeneration) return;
      spinnerTimer = undefined;
      pruneAnimation();
      if (!animated.size) return;
      spinnerPending = true; // Wait for the host visit; do not flood a delayed/stopped TUI.
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
    }
    spinnerEpoch ??= passSpinnerTime ?? performance.now();
    // Normal document passes arm once on successful return. Direct tool visits
    // may start participation, but cannot acknowledge/postpone an existing frame.
    if (passSpinnerTime === undefined && spinnerTimer === undefined) armSpinner();
  }
  let states = new WeakMap<ToolNode, { signature: unknown[]; entry: CacheEntry<Layout>; pool: RenderCache }>();
  const forget = (node: ToolNode) => { const state = states.get(node); state?.pool.drop(state.entry); states.delete(node); };
  let userStates = new WeakMap<UserNode, { signature: unknown[]; entry: CacheEntry<Layout> }>();
  const forgetUser = (node: UserNode) => { cache.drop(userStates.get(node)?.entry); userStates.delete(node); };
  let queuedStates = new WeakMap<Component, { signature: unknown[]; entry: CacheEntry<QueuedCard> }>();
  const forgetQueued = (node: Component) => { cache.drop(queuedStates.get(node)?.entry); queuedStates.delete(node); };
  const clearCache = () => { cache.clear(); cardCache.clear(); states = new WeakMap(); userStates = new WeakMap(); queuedStates = new WeakMap(); };
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
  function layoutSignature(node: ToolNode, kind: string, width: number, theme: Palette, directory: string | undefined, padding: number): unknown[] {
    return [kind, width, padding, theme, theme.fg, kind === "bash" ? undefined : node.args, node.result, node.expanded, node.isPartial,
      node.toolName, node.result?.isError, kind === "bash" ? (node.result?.details as { exit_code?: unknown } | undefined)?.exit_code : undefined,
      kind === "bash" ? node.args.command : undefined, kind === "bash" ? node.args.description : undefined,
      kind === "bash" ? node.args.workdir : undefined, directory,
      kind === "edit" || kind === "write" ? theme.colors : undefined,
      kind === "edit" || kind === "write" ? theme.style : undefined, kind === "edit" || kind === "write" ? theme.bg : undefined];
  }
  function memo<T extends Layout>(node: ToolNode, kind: LayoutKind, width: number, theme: Palette, directory: string | undefined, padding: number, build: () => T): T {
    const signature = layoutSignature(node, kind, width, theme, directory, padding);
    const state = states.get(node);
    const matches = state && signature.every((value, index) => value === state.signature[index]);
    if (matches) {
      const value = state.pool.get(state.entry); if (value) return value as T;
    } else { state?.pool.drop(state.entry); }
    const value = build();
    // Select by the materialized presentation, not tool name: inline/native file fallback is ordinary.
    const pool = kind === "bash" || ((kind === "edit" || kind === "write") && value.framed && !value.native) ? cardCache : cache;
    if (!matches) pool.get(undefined); // Attribute exactly one miss to the target pool.
    states.set(node, { signature, pool, entry: pool.put(value, value.rows, kind) });
    return value;
  }
  const bashLayout = (node: ToolNode, width: number) => {
    const theme = getTheme(), directory = bashDirectory(node) ?? undefined, padding = outputPadding();
    return memo(node, "bash", width, theme, directory, padding, () => renderBashCard(node, directory, width, theme, padding));
  };
  const fileLayout = (node: ToolNode, width: number) => {
    const theme = getTheme();
    const context = node.getRenderContext() as { cwd?: unknown } | undefined;
    const cwd = typeof context?.cwd === "string" ? context.cwd : undefined;
    const padding = outputPadding();
    return memo(node, node.toolName as "edit" | "write", width, theme, cwd, padding, () => renderFileCard(node, cwd, width, theme,
      theme.colors && theme.style ? (code, path) => highlightCode(code, getLanguageFromPath(path)) : undefined, padding) ??
      { rows: nativeRows(node, width), framed: false, native: true });
  };
  function fileMeasure(node: ToolNode, width: number) {
    const theme = getTheme();
    const context = node.getRenderContext() as { cwd?: unknown } | undefined;
    const cwd = typeof context?.cwd === "string" ? context.cwd : undefined;
    const padding = outputPadding();
    const state = states.get(node), signature = layoutSignature(node, node.toolName, width, theme, cwd, padding);
    // Read only the existing exact layout. Never admit another cache entry or retain measurement data.
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const layout = state.pool.get(state.entry) as ReturnType<typeof renderFileCard>;
      if (layout) return layout.native ? undefined : { framed: layout.framed, height: layout.rows.length };
    }
    return measureFileCard(node, cwd, width, padding);
  }
  const summaryLayout = (node: ToolNode, width: number) => {
    const theme = getTheme(), padding = outputPadding();
    return memo(node, "summary", width, theme, undefined, padding, () => summaryRows(node, width, theme, padding));
  };
  const controller: ToolviewController = {
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
    renderEditorStatus(width, info) {
      const editor = statusEditor?.deref(), state = editor && editorStates.get(editor);
      if (!active || !options.editorStatus || !editor || !stockEditor(editor) || !state?.framed || state.width !== width) return [];
      try {
        if (editor.isShowingAutocomplete()) return [];
        const group = managedEditorSlots(editor)?.[2] as Container | undefined;
        const activity = group?.render === observeWidgetRows ? nativeStatusRows.get(group) : undefined;
        return renderEditorStatus(width, getTheme(), { ...info,
          idle: info.idle && !(activity?.width === width && activity.visible) }, state.geometry);
      }
      catch { fail("Toolview could not render editor status; native rendering restored"); return []; }
    },
    clearCache,
    restore() {
      if (!active && !patches.size && !userPatches.size && !editorPatches.size) return;
      active = false;
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
      refresh();
    },
  };
  const fail = (message: string) => {
    if (reason) return;
    reason = message;
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
  function install(node: ToolNode) {
    if (!compatible(node)) { fail("Tool component contract is incompatible; native rendering retained"); return; }
    patchPrototype(Object.getPrototypeOf(node) as object);
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
        if (bashCard(this, width)) {
          removeAnimation(this);
          const rows = bashLayout(this, width).rows;
          if (!rows.length) return rows;
          return previousLayout(this, width) ? ["", ...rows] : rows;
        }
        if (fileCard(this, width)) {
          removeAnimation(this);
          const layout = fileLayout(this, width);
          const offset = layout.native ? nativeGap(this, width, layout.rows) : layout.framed ? (previousLayout(this, width) ? 1 : 0) : gap(this, width);
          return offset ? [""].concat(layout.rows) : layout.rows;
        }
        if (!eligible(this)) {
          removeAnimation(this);
          const lines = originalRender.call(this, width);
          return nativeGap(this, width, lines) ? ["", ...lines] : lines;
        }
        if (width < 1) { removeAnimation(this); return []; }
        if (!nativeVisible(this, width)) { removeAnimation(this); return []; }
        const offset = gap(this, width), rows = paintSummary(this, width);
        return offset ? ["", ...rows] : rows;
      }
      catch { fail("Toolview could not render this component; native rendering restored"); return originalRender.call(this, width); }
    };
    const patchedMouse: Mouse = function (event) {
      if (event.width > 0 && bashCard(this, event.width)) {
        if (event.type !== "click" || event.button !== "left" || tui.hasActiveSelection?.()) return undefined;
        const layout = bashLayout(this, event.width);
        const offset = previousLayout(this, event.width) ? 1 : 0;
        const hit = layout.expandable && insidePanel(layout.geometry, layout.rows.length, event.x, event.y - offset);
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
    const updates = ["updateArgs", "updateResult", "setExpanded", "invalidate", "markExecutionStarted"].map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("Tool cache invalidation methods cannot be wrapped");
      const wrapper = function (this: ToolNode, ...args: unknown[]) {
        // Bash keys include every displayed argument; unrelated/same argument updates reuse its body.
        if (name !== "markExecutionStarted" && !(name === "updateArgs" && this.toolName === "bash" && !overrides.has("bash")) &&
          !(name === "setExpanded" && args[0] === this.expanded)) forget(this);
        const result = method.apply(this, args);
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
        const previous = rows.length ? previousLayout(this, width) : undefined;
        return previous && !previous.separator ? ["", ...rows] : rows;
      } catch {
        fail("Toolview could not render this user message; native rendering restored");
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
        catch { fail("Toolview could not route native editor activity; native rendering restored"); }
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
    const fallback = () => { for (const child of group.children) forgetQueued(child); return undefined; };
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
      queuedStates.set(node, { signature, entry: cache.put(card, [...card.rows, ...card.ellipsis], "queued") });
      return card;
    });
    // Height is a soft policy, not Pi's allocated dock height. Selecting prepared
    // rows cannot prevent the host from clipping an oversized minimum block.
    const blocks = projectQueuedCards(cards, height);
    return renderQueuedProjection(group, width, [{ node: spacer, rows: spacerRows },
      ...messages.map(({ node }, position) => ({ node, rows: blocks[position]! })),
      { node: children[index]!, rows: [] }]);
  }
  function observeContainerRows(this: Container, width: number): string[] {
    if (active) {
      try { const rows = queuedRows(this, width); if (rows) return rows; }
      catch { fail("Toolview could not render queued messages; native rendering restored"); }
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
        editorStates.delete(this); return editorRender.call(this, width);
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
        if (mapping.framed && options.editorStatus) statusEditor = new WeakRef(this);
        return offsetY ? ["", ...rows] : rows;
      } catch {
        fail("Toolview could not render this editor; native rendering restored");
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
    if (candidate(node)) { forget(node); removeAnimation(node); }
    else if (userCandidate(node)) forgetUser(node);
    parents.delete(node);
    if (node instanceof Container) for (const child of node.children) releaseTree(child);
  }
  function patchedRemove(this: Container, child: Component) {
    containerRemove.call(this, child);
    // A component already moved to another attached parent keeps its current layout.
    if (!this.children.includes(child) && !attached(child)) releaseTree(child);
  }
  function patchedClear(this: Container) {
    const children = this.children;
    containerClear.call(this);
    for (const child of children) if (!this.children.includes(child) && !attached(child)) releaseTree(child);
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
    fail("Toolview could not install its UI hooks; native rendering restored");
  }
  return controller;
}

export default function toolview(pi: ExtensionAPI) {
  pi.registerFlag("toolview-card", { type: "string", description: "Additional comma-separated tool names that retain native cards" });
  pi.registerFlag("toolview-compact", { type: "string", description: "Comma-separated tool names that use compact summaries instead of native cards" });
  const retiredBudgetFlags = ["toolview-cache-mb", "toolview-card-cache-mb"];
  for (const flag of retiredBudgetFlags) pi.registerFlag(flag, { type: "string", description: "Deprecated and ignored: layouts are retained per component without eviction limits" });
  let warnedBudgetFlags = false;
  let controller: ToolviewController | undefined;
  let enabled = true, colorsEnabled = true;
  let liveContext: ExtensionContext | undefined;
  let colors: TerminalColors | undefined;
  let colorExit: (() => void) | undefined;
  const colorWidget = "pi-toolview-terminal-colors";
  function stopColors() {
    const previous = colors; colors = undefined;
    if (colorExit) process.off("exit", colorExit);
    colorExit = undefined;
    previous?.dispose();
    if (previous) liveContext?.ui.setWidget(colorWidget, undefined);
  }
  function startColors(ctx: ExtensionContext) {
    if (!enabled || ctx.mode !== "tui") return;
    if (colors) { colors.observe(); return; }
    ctx.ui.setWidget(colorWidget, tui => {
      const reference = new WeakRef(tui);
      const view = new TerminalColors({
        snapshot() {
          const current = liveContext!;
          return { enabled: enabled && colorsEnabled && current?.mode === "tui", presenting: enabled && current?.mode === "tui", theme: current.ui.theme,
            configured: pi.getSettings().theme, automatic: reference.deref() ? terminalAppearanceTracking(reference.deref()!) : undefined };
        },
        source: name => name ? liveContext?.ui.getAllThemes?.().find(item => item.name === name)?.path : undefined,
        write: data => {
          const terminal = reference.deref()?.terminal;
          if (!terminal || typeof terminal.write !== "function") throw new Error("Terminal writer unavailable");
          terminal.write(data);
        },
        query: late => reference.deref()?.queryTerminalColors({ timeoutMs: 100, onLateReply: late }) ?? Promise.resolve({}),
        changed: () => reference.deref()?.requestRender(),
        warn: message => liveContext?.ui.notify(`Pi Toolview colors: ${message}`, "warning"),
      });
      colors = view; terminalColorDebug = new WeakRef(view);
      if (colorsEnabled) { colorExit = terminalColorExit(new WeakRef(view)); process.on("exit", colorExit); }
      view.observe();
      return { render() { if (colors === view) view.observe(); return []; }, invalidate() { if (colors === view) view.observe(); } };
    }, { placement: "belowEditor" });
  }
  const palette = () => colors?.palette(liveContext!.ui.theme) ?? liveContext!.ui.theme;
  let directorySource: GitBranchSource | undefined;
  let ownedFooter: FooterView | undefined;
  let footerEpoch = 0;
  function restoreFooter() {
    // Public dispose tells us when another owner replaced our component.
    if (ownedFooter) liveContext?.ui.setFooter(undefined);
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
      if (owner && liveContext && pending?.slot.deref()?.children[0] === owner) startFooter(liveContext);
    });
  }
  function footerActive() {
    if (controller?.editorActive) return true;
    if (ownedFooter && !footerRestoreQueued) {
      footerRestoreQueued = true;
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
    ctx.ui.setFooter((_tui, _theme, data) => {
      let snapshot: FooterData | undefined;
      let stamp: { epoch: number; session: string; leaf: string | null; model: ExtensionContext["model"] } | undefined;
      const view = new FooterView(() => {
        const current = liveContext!;
        const manager = current.sessionManager, session = manager.getSessionId(), leaf = manager.getLeafId(), model = current.model;
        const auto = pi.getSettings().compaction?.enabled ?? true;
        const subscription = FOOTER_FIELDS.cost && !!model && (model.provider === "kimi-coding" ||
          (current.modelRegistry.isUsingOAuth(model) && current.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true));
        if (!snapshot || !stamp || stamp.epoch !== footerEpoch || stamp.session !== session || stamp.leaf !== leaf || stamp.model !== model) {
          snapshot = { usage: footerUsage(manager.getEntries()), context: current.getContextUsage(), auto, subscription };
          stamp = { epoch: footerEpoch, session, leaf, model };
        } else if (snapshot.auto !== auto || snapshot.subscription !== subscription) snapshot = { ...snapshot, auto, subscription };
        return snapshot;
      }, () => data.getExtensionStatuses(), () => liveContext!.ui.theme, footerActive);
      ownedFooter = view;
      return Object.assign(view, { dispose() {
        view.clear(); snapshot = undefined; stamp = undefined;
        if (ownedFooter === view) ownedFooter = undefined;
      } });
    });
  }
  const statusWidget = "pi-toolview-editor-status";
  const names = (flag: string) => String(pi.getFlag(flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  function start(ctx: ExtensionContext) {
    liveContext = ctx;
    footerEpoch++;
    directorySource?.refresh(true);
    if (ctx.mode !== "tui" || !enabled) return;
    startColors(ctx);
    if (controller?.active) { startFooter(ctx); return; }
    if (!warnedBudgetFlags) {
      warnedBudgetFlags = true;
      for (const flag of retiredBudgetFlags) if (pi.getFlag(flag) !== undefined)
        ctx.ui.notify(`Pi Toolview: --${flag} is ignored; layouts are retained per component without eviction limits`, "warning");
    }
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-toolview-capture", (tui) => {
      const slot = tui.children.length === 7 ? tui.children[6] : undefined;
      if (ctx.ui.getEditorComponent() === undefined && slot instanceof Container && slot.children.length === 1)
        pendingFooter = { slot: new WeakRef(slot), owner: new WeakRef(slot.children[0]!) };
      controller = installToolview(tui, palette, {
        cards: names("toolview-card"), compact: names("toolview-compact"),
        outputPad: () => pi.getSettings().outputPad ?? 1,
        nativeEditor: () => liveContext?.ui.getEditorComponent() === undefined,
        editorStatus: true,
        rerouteEditorStatus: () => liveContext?.ui.setEditorComponent(undefined),
        editorStatusRestored: () => {
          directorySource?.dispose(); directorySource = undefined;
          liveContext?.ui.setWidget(statusWidget, undefined);
        },
        warn: (message) => { restoreFooter(); liveContext?.ui.notify(`Pi Toolview disabled: ${message}`, "warning"); },
      });
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-toolview-capture", undefined);
    if (controller?.active) ctx.ui.setWidget(statusWidget, (tui) => {
      directorySource ??= new GitBranchSource(() => tui.requestRender());
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
  const refreshFooter = (_event: unknown, ctx: ExtensionContext) => { liveContext = ctx; footerEpoch++; };
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
  pi.on("agent_end", refreshDirectory);
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", (_event, ctx) => { liveContext = ctx; pendingFooter = undefined; stopColors(); restoreFooter(); controller?.restore(); controller = undefined; liveContext = undefined; });
  pi.registerCommand("toolview", {
    description: "Control presentation, terminal colors and component-layout diagnostics: on, off, status, colors, cache",
    handler: async (args, ctx) => {
      liveContext = ctx;
      const command = args.trim() || "status";
      const words = command.split(/\s+/u);
      if (words[0] === "colors") {
        const action = words[1] ?? "status";
        if (words.length > 2 || !["on", "off", "status"].includes(action)) {
          ctx.ui.notify("Usage: /toolview colors on|off|status", "warning"); return;
        }
        if (action === "off") {
          colorsEnabled = false; colors?.observe();
          if (colorExit) process.off("exit", colorExit); colorExit = undefined;
        } else if (action === "on") {
          colorsEnabled = true;
          if (colors) {
            if (!colorExit) { colorExit = terminalColorExit(new WeakRef(colors)); process.on("exit", colorExit); }
            colors.observe(true);
          } else startColors(ctx);
        }
        const state = !enabled ? "off (Toolview off)" : !colorsEnabled ? "off" : ctx.mode !== "tui" ? "unavailable outside terminal mode" : colors?.status().state ?? "starting";
        ctx.ui.notify(`Pi Toolview colors: ${state}`, "info"); return;
      }
      if (words[0] === "cache") {
        if (!controller || ctx.mode !== "tui") { ctx.ui.notify("Pi Toolview cache: unavailable outside an initialized terminal runtime", "info"); return; }
        if (words.length === 2 && words[1] === "clear") { controller.clearCache(); ownedFooter?.clear(); }
        else if (words[1] === "limit" || (words[1] === "cards" && words[2] === "limit")) {
          ctx.ui.notify("Pi Toolview: cache limits have been removed; layouts are retained per component. Use /toolview cache [clear]", "warning"); return;
        } else if (words.length !== 1) {
          ctx.ui.notify("Usage: /toolview cache [clear]", "warning"); return;
        }
        const stats = controller.cacheStats();
        const footerLayout = ownedFooter?.retainedMemory() ?? { retainedBytes: 0, stringBytes: 0, overheadBytes: 0, entries: 0, rows: 0 };
        ctx.ui.notify(`Pi Toolview cache: ${JSON.stringify({ ...stats, footerLayout,
          presentationRetainedBytes: stats.retainedBytes + footerLayout.retainedBytes,
          presentationEntries: stats.entries + footerLayout.entries, presentationRows: stats.rows + footerLayout.rows,
          memoryScope: "estimated Toolview retained transcript, queued-message and footer layouts; excludes native caches, source/signature data and transient rendering",
          processHeapUsedBytes: process.memoryUsage().heapUsed, processMemoryScope: "whole Pi process, not Toolview" })}`, "info");
        return;
      }
      if (command === "off") { enabled = false; pendingFooter = undefined; stopColors(); restoreFooter(); controller?.restore(); }
      else if (command === "on") { enabled = true; start(ctx); }
      else if (command !== "status") { ctx.ui.notify("Usage: /toolview on|off|status|colors on|off|status|cache [clear]", "warning"); return; }
      const status = controller?.active ? "on" : ctx.mode !== "tui" ? "unavailable outside terminal mode" : controller?.reason ?? "off";
      ctx.ui.notify(`Pi Toolview: ${status}`, "info");
    },
  });
}
