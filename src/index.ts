import { VERSION, CustomEditor, highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Editor, Image, Markdown, Spacer, Text, TruncatedText, backgroundAnsi, type TerminalColorMode, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { SessionLogging } from "./session-logging.ts";
import { RuntimeHealth } from './runtime-health.ts';
import { notify } from './notifications.ts';
import { copyThemePreference, sameThemePreference, type ThemePreference } from './appearance/theme-preference.ts';
import { ExtensionSettings, processPreferences, type LocalPreferences, type SettingsLoadResult } from './settings.ts';
import { bindTerminalLifecycle } from "./terminal-lifecycle.ts";
import { TidyMenu, type TidyMenuOwner, type TidyMenuAction } from './tidy-menu.ts';
import type { SyntaxMenuOutcome } from './application/syntax-menu.ts';
import { type JournalOptions } from "./debug-log.ts";
import { diagnose, reportRuntime, type DiagnosticFields, type DiagnosticSink } from "./diagnostics.ts";
import { stripVTControlCharacters } from "node:util";
import type { FilePreviewMode } from './cards/file-preview-mode.ts';
import { PresentationCacheOwner } from './presentation/cache-owner.ts';
import { ToolPresentationSessions, type PresentationConstructionObserver } from './presentation/tool-sessions.ts';
import { createToolPreparationPresenter } from './presentation/tool-preparation.ts';
import { createToolViewPresenter, SPINNER_INTERVAL_MS, type NativeToolUpdate, type ToolUpdateName } from './presentation/tool-view-presenter.ts';
import { ToolProducerPresenter, type ToolFieldAccessors } from './presentation/tool-producers.ts';
import { ToolSummaryPresenter } from './presentation/tool-summary-presenter.ts';
import { FileDetailPresenter } from './presentation/file-detail-presenter.ts';
import { ToolPresentationPolicy } from './presentation/tool-policy.ts';
import { ToolRoutingPresenter } from './presentation/tool-routing-presenter.ts';
import { UserPresenter, type UserPresentationLayout } from './presentation/user-presenter.ts';
import { QueuedPresenter } from './presentation/queued-presenter.ts';
import { EDITOR_TOP, EDITOR_BOTTOM, renderEditorCard, type EditorLayout } from "./editor-card.ts";
import { renderEditorStatus, type EditorStatusInfo } from "./editor-status.ts";
import { GitBranchSource, gitDiagnostics } from "./git-branch.ts";
import { FOOTER_FIELDS, FooterView, footerFirstMessage, footerUsage, type FooterData } from "./footer.ts";
import { TerminalColors, processTerminalDefaults, type DefaultColors } from "./terminal-colors.ts";
import type { CardTheme } from "./card-theme.ts";
import type { CacheStats } from "./render-cache.ts";
import { supportsToolName } from './tool-adapters/registry.ts';
import { CardSources, type CardPreparation, type SyntaxCardClient } from "./syntax/cards.ts";
import { PreparedLayoutPresenter } from './presentation/prepared-layout-presenter.ts';
import { PaletteInputOwner } from './syntax/pi-input-owner.ts';
import type { PiInputTheme, PaletteInputLease } from './syntax/pi-input.ts';
import { resolveTheme, type ThemeDescription } from './themes/selection.ts';
import { SourceExecution } from './highlighting/source-execution.ts';
import type { SourceLifecyclePort, SourcePumpPort, SourceStatisticsPort } from './highlighting/source-ports.ts';
import type { GeometryFunding } from './resources/data-budget.ts';
import type { PiClassifier } from "./syntax/work.ts";
import { createSyntaxOptions } from "./application/syntax-options.ts";
import { SyntaxRuntime, type SyntaxRuntimeOptions } from "./application/syntax-runtime.ts";
import { createLazyNativeRendererResolver, isDeferredStockEditComponent, isDeferredStockEditPair, isDeferredStockFileCall, isDeferredStockFilePair, isDeferredStockReadPair, releaseNativeRendererCache, updateNativeRendererArgs, stockEditCall, stockEditResult, type NativeRendererFailureReporter } from './syntax/lazy-native-renderers.ts';
export { describeToolArgs as describeArgs } from "./tool-adapters/summary.ts";
export { sanitize } from "./summary-args.ts";
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

/** The private component contract verified against Pi 1.0.1; never import a second internal class. */
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
    client: SyntaxCardClient & { readonly sourcePump: SourcePumpPort; readonly sourceStatistics: SourceStatisticsPort };
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
type InternalTidyUiOptions = TidyUiOptions & { presentationConstructionObserver?: PresentationConstructionObserver };
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
  beginFileTurn(): void;
  completeFileCall(toolCallId: string): void;
  finishFileTurn(): void;
}
function localCardNotice(owner: WeakRef<TidyUiController>) {
  return (keys: readonly string[], groups?: readonly number[]) => owner.deref()?.syntaxSourceChanged(keys, groups);
}
type PreparedCardController = TidyUiController & { refreshPreparedPalette(node: ToolNode, token: object): void; retireRendererClears(): void };
function rendererClearRetirement(adapter: WeakRef<PreparedCardController>) {
  return () => adapter.deref()?.retireRendererClears();
}
const DEFAULT_CARDS = ["bash", "powershell", "write", "edit"];
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

const toolFields: ToolFieldAccessors<ToolNode> = {
  name: node => node.toolName, id: node => node.toolCallId, args: node => node.args, result: node => node.result,
  partial: node => node.isPartial, expanded: node => node.expanded, executionStarted: node => node.executionStarted,
  argsComplete: node => node.argsComplete,
};
/** The only compatibility-sensitive adapter. It does not change tools or session entries. */
export function installTidyUi(tui: LiveTui, getTheme: () => Palette, options: InternalTidyUiOptions = {}): TidyUiController {
  const toolProducer = new ToolProducerPresenter(toolFields);
  let active = false;
  let reason: string | undefined;
  const parents = new WeakMap<Component, { parent: Container; index: number }>();
  let rendererClears: WeakRef<Component>[] = [], rendererClearPending = false;
  const cacheOwner = new PresentationCacheOwner();
  const cache = cacheOwner.ordinary;
  const cardCache = cacheOwner.cards;
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
  const executing = (node: ToolNode) => toolView.executing(node);
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

  const forget = (node: ToolNode, cause?: string, preserveFileDetail?: boolean) => toolView.forget(node, cause, preserveFileDetail);
  const userPresenter = new UserPresenter<UserNode>(cache, options.diagnostic, options.presentationConstructionObserver);
  const forgetUser = (node: UserNode) => userPresenter.forget(node);
  const queuedPresenter = new QueuedPresenter<Component>(cache, options.diagnostic, options.presentationConstructionObserver);
  const forgetQueued = (node: Component) => queuedPresenter.forget(node);
  const clearCache = () => { fileDetails.clear(); cacheOwner.clear(); toolSessions.clearLayouts(); userPresenter.clear(); queuedPresenter.clear();
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
  const toolSessions = new ToolPresentationSessions<ToolNode>({
    args: node => node.args, result: node => node.result,
    funding: () => cardClient?.cardSource.geometryFunding(),
    failed: (node, error) => diagnose(options.diagnostic, 'ERROR', 'file-detail', 'Expanded file details could not be measured',
      { call: node.toolCallId, error: error instanceof Error ? error.name : 'UnknownError' }),
  }, options.presentationConstructionObserver);
  const fileDetails = toolSessions.fileDetails;
  const toolSummaryPresenter = new ToolSummaryPresenter<ToolNode>(toolProducer, fileDetails, toolSessions, cache);
  const filePreviewState = toolSessions.filePreview;
  const toolPresentationPolicy = new ToolPresentationPolicy(toolProducer, toolSessions, {
    active: () => active, name: node => node.toolName, toolCallId: node => node.toolCallId,
    expanded: node => node.expanded, hidden: node => node.hideComponent, attached,
  }, { cards, compact: overrides, native: nativeOverrides });
  let syntax: CardSources<ToolNode> | undefined;
  let cardClient = options.syntax?.client;
  let selectedPalette = cardClient?.snapshot().effective ?? resolveTheme({ kind: 'pi', variant: 'dark' }).effective;
  let ownedSources: SourceLifecyclePort | undefined;
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
      const snapshot = { enabled: false, selected: { kind: 'pi', variant: 'dark' } as const, standaloneVersion: extensionVersion,
        provider: { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false } };
      const execution = new SourceExecution({ snapshot: () => snapshot.provider, isReady: () => false,
        classificationAccepted: () => { throw new Error('Disabled card provider accepted work'); },
        request: () => { throw new Error('Disabled card provider requested work'); } },
        { diagnostic: options.diagnostic, onChange: localCardNotice(new WeakRef(controller)) });
      execution.setEnabled(false); ownedSources = execution;
      cardClient = { cardSource: execution, sourceWork: execution, pi: execution.pi, sourcePump: execution, sourceStatistics: execution, snapshot: () => snapshot };
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
      invalidate: node => toolPreparation.invalidated(node), requestRender: () => { if (active && !quiescing) tui.requestRender(); },
    });
    return syntax;
  }
  const toolRoutingPresenter = new ToolRoutingPresenter(toolPresentationPolicy, {
    fileRenderer: node => {
      const call = node.getCallRenderer?.(), result = node.getResultRenderer?.();
      return isDeferredStockFileCall(call) && (result === undefined || isDeferredStockFilePair(call, result));
    },
    readRenderer: node => isDeferredStockReadPair(node.getCallRenderer?.(), node.getResultRenderer?.()),
    selfShell: node => node.getRenderShell() === 'self',
    deferredFilePair: node => isDeferredStockFilePair(node.getCallRenderer?.(), node.getResultRenderer?.()),
    stockEditShell: nativeStockEditShell,
    visible: (node, width) => nativeRows(node, width).length > 0,
  });
  const toolPreparation = createToolPreparationPresenter({
    fields: toolFields, producer: toolProducer, sessions: toolSessions, policy: toolPresentationPolicy, routing: toolRoutingPresenter,
    cards: () => syntax, ensureCards,
    facts: { active: () => active, quiescing: () => quiescing, attached, hidden: node => node.hideComponent,
      cwd: node => { const cwd = (node.getRenderContext() as { cwd?: unknown } | null | undefined)?.cwd; return typeof cwd === 'string' ? cwd : undefined; },
      live: call => options.syntax?.isLiveCall?.(call) ?? true },
    palette: { needsInput: () => needsPiTheme(selectedPalette), input: publicInput, mode: terminalMode,
      generation: input => externalPaletteOwner ? options.syntax!.palette() : paletteOwner.palette(input?.theme, selectedPalette) },
    displayBasis: key => cardClient?.cardSource.displayBasis(key), invalidate: (node, cause) => toolView.invalidatePrepared(node, cause), forget,
    refreshTarget: () => controller, requestRender: () => tui.requestRender(), flush: () => cardClient!.sourcePump.flush(),
  });
  const { unsupportedFullFile, observePalette, refusePreparedPresentation, refreshPalette, finishFileTurn } = toolPreparation;
  const preparedPresenter = new PreparedLayoutPresenter<ToolNode>({
    sessions: toolSessions, ordinaryCache: cache, cardCache, producer: toolProducer,
    active: () => active, outputPadding,
    funding: () => cardClient?.cardSource.geometryFunding(),
    visit: (node, consume) => syntax?.visit(node, consume) ?? false,
    identities: node => syntax?.identities(node) ?? [],
    fileMode, unsupportedFullFile,
    refuse: refusePreparedPresentation, observePalette,
    displayBasis: key => cardClient?.cardSource.displayBasis(key),
    piDisplay: key => cardClient?.pi.borrowPiSource(key),
    decision: (node, choice, width, rows, fields) => decision(node, 'syntax', choice, width, rows,
      { call: node.toolCallId, tool: node.toolName, selected: fields.selected, origin: fields.origin }),
  });
  function fileDetailServiceRow(text: string, width: number, inset: number): string[] {
    return new Text(text, inset, 0).render(width);
  }
  const fileDetailPresenter = new FileDetailPresenter<ToolNode>({
    sessions: toolSessions, cache, producer: toolProducer, details: fileDetails, summaries: toolSummaryPresenter,
    theme: getTheme, padding: outputPadding, mode: fileMode,
    cwd: node => (node.getRenderContext() as { cwd?: string } | undefined)?.cwd,
    unsupported: node => syntax?.filePreparationOutcome(node) === 'unsupported',
    serviceRows: fileDetailServiceRow,
  });
  const toolView = createToolViewPresenter({
    fields: toolFields, producer: toolProducer, sessions: toolSessions, policy: toolPresentationPolicy,
    routing: toolRoutingPresenter, preparation: toolPreparation, summary: toolSummaryPresenter,
    detail: fileDetailPresenter, prepared: preparedPresenter,
    cards: () => syntax, funding: () => cardClient?.cardSource.geometryFunding(), theme: getTheme, padding: outputPadding,
    paletteOrigin: () => needsPiTheme(selectedPalette) ? 'pi' : 'owned', decision: toolDecision, phase: nativePhase,
    invalidated: (node, cause) => diagnose(options.diagnostic, 'DEBUG', 'cache', 'Tool layout invalidated',
      { call: node.toolCallId, tool: node.toolName, cause }),
    host: {
      active: () => active, quiescing: () => quiescing, attached, hidden: node => node.hideComponent,
      cwd: node => (node.getRenderContext() as { cwd?: string } | undefined)?.cwd,
      isTool: (node): node is ToolNode => candidate(node as Component),
      siblings: node => parents.get(node as Component)?.parent.children ?? [],
      index: (node, siblings) => {
        const position = parents.get(node as Component); let current = position?.index ?? -1;
        if (siblings[current] !== node) { current = siblings.indexOf(node); if (position) position.index = current; }
        return current;
      },
      otherRows: (node, width) => {
        const component = node as Component;
        const render = userCandidate(component) ? userPatches.get(Object.getPrototypeOf(component))?.render.value as UserRender | undefined : undefined;
        return render ? userLayout(component as UserNode, width, render).rows : nativeRows(component, width);
      },
      nativeRows, imageRows: nativeImageRows, releaseFileRenderer: releaseNativeFileRenderer,
      syncRendererArgs: (node, kind) => {
        const pair = kind === 'file' ? isDeferredStockFilePair(node.getCallRenderer?.(), node.getResultRenderer?.())
          : isDeferredStockReadPair(node.getCallRenderer?.(), node.getResultRenderer?.());
        if (!pair) return;
        const context = node.getRenderContext() as { state?: unknown } | null | undefined;
        updateNativeRendererArgs(context?.state, node.toolName, node.toolCallId, node.args);
      },
      selection: () => tui.hasActiveSelection?.() ?? false, setExpanded: (node, expanded) => node.setExpanded(expanded),
      requestRender: () => tui.requestRender(),
    },
    animation: { animate, remove: removeAnimation, time: () => passSpinnerTime ?? performance.now(), epoch: () => spinnerEpoch },
  });
  function nativeImageRows(node: ToolNode, width: number): string[] {
    const rendered: string[] = [], children = (node as unknown as Container).children;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (!(child instanceof Image)) continue;
      const spacer = children[index - 1];
      if (spacer instanceof Spacer) rendered.push(...spacer.render(width));
      rendered.push(...child.render(width));
    }
    return rendered;
  }
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
    cacheStats: () => cacheOwner.stats(),
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
    beginFileTurn() { if (active && !quiescing) filePreviewState.beginTurn(); },
    completeFileCall(toolCallId) { if (active && !quiescing) filePreviewState.completed(toolCallId); },
    finishFileTurn,
    syntaxMetadataChanged() {
      if (active && !quiescing) {
        selectedPalette = cardClient?.snapshot().effective ?? resolveTheme({ kind: 'pi', variant: 'dark' }).effective;
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
        syntax?.dispose(); ownedSources?.dispose(); paletteOwner?.dispose(); toolSessions.clearSyntax(); return;
      }
      diagnose(options.diagnostic, "INFO", "runtime", "Presentation restoring native ownership; later owners remain untouched",
        { animationWakes: spinnerWakes, animationRequests: spinnerRequests });
      active = false;
      filePreviewState.reset();
      rendererClears = []; rendererClearPending = false;
      syntax?.dispose(); ownedSources?.dispose(); paletteOwner?.dispose(); toolSessions.clearSyntax();
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
  function fileMode(node: ToolNode): FilePreviewMode | undefined { return toolPresentationPolicy.fileMode(node); }
  function nativeStockEditShell(node: ToolNode): boolean {
    // Stock edit always supplies a heading in an ordinary Box. Its native factory can reuse
    // a previous custom Box, so both renderer identities AND the current component must qualify.
    // Check every visit; no retained visibility proof or native-state mutation.
    const callRenderer = node.getCallRenderer?.(), resultRenderer = node.getResultRenderer?.();
    const stockEdit = callRenderer === stockEditCall && resultRenderer === stockEditResult &&
      node.callRendererComponent instanceof Box && Object.getPrototypeOf(node.callRendererComponent) === Box.prototype &&
      node.callRendererComponent.render === Box.prototype.render && node.callRendererComponent.clear === Box.prototype.clear &&
      node.callRendererComponent.addChild === Box.prototype.addChild;
    const deferredEdit = isDeferredStockEditPair(callRenderer, resultRenderer) &&
      isDeferredStockEditComponent(node.callRendererComponent);
    return node.constructor.name === 'ToolExecutionComponent' && node.toolName === 'edit' && typeof node.getCallRenderer === 'function' &&
      typeof node.getResultRenderer === 'function' && (stockEdit || deferredEdit);
  }

  function nativeRows(node: Component, width: number): string[] {
    const render = candidate(node) ? patches.get(Object.getPrototypeOf(node))?.render.value as Render | undefined : undefined;
    return render ? render.call(node as ToolNode, width) : node.render(width);
  }
  function releaseNativeFileRenderer(node: ToolNode): void {
    const context = node.getRenderContext() as { state?: unknown } | null | undefined;
    releaseNativeRendererCache(context?.state);
  }
  function install(node: ToolNode) {
    if (!compatible(node)) { fail("Tool component contract is incompatible; native rendering retained"); return; }
    patchPrototype(Object.getPrototypeOf(node) as object);
    toolView.attach(node);
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
      try { return toolView.render(this, width, originalRender); }
      catch { fail("pi-tidy-ui could not render this component; native rendering restored"); return originalRender.call(this, width); }
    };
    const patchedMouse: Mouse = function (event) {
      return toolView.mouse(this, event, originalRender, originalMouse);
    };
    const updateNames: ToolUpdateName[] = ['updateArgs', 'updateResult', 'setExpanded', 'invalidate', 'markExecutionStarted'];
    for (const name of ['setShowImages', 'setImageWidthCells'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value === 'function' && descriptor.writable && descriptor.configurable) updateNames.push(name);
    }
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
        return toolView.update(this, name, args, method as NativeToolUpdate<ToolNode>);
      };
      return { name, original, wrapper };
    });
    patches.set(prototype, { render, mouse, patchedRender, patchedMouse, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    Object.defineProperty(prototype, "handleMouse", { ...mouse, value: patchedMouse });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  function userLayout(node: UserNode, width: number, originalRender: UserRender): UserPresentationLayout {
    const theme = getTheme(), padding = options.outputPad ? outputPadding() : node.outputPad;
    return userPresenter.layout(node, width, theme, padding, node.text, node.outputPad, node.children[0], node.markdownTheme,
      node.markdownTransformers, originalRender);
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
        return toolView.presentUser(this, width, rows);
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
    const projected: { node: Component; rows: string[] }[] = [];
    const rowCount = spacerRows.length + queuedPresenter.project(messages, width, height, theme, padding, hint, projected);
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
    if (candidate(node)) {
      toolView.restorePreview(node);
      install(node);
    } else if (userCandidate(node)) installUser(node);
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
    if (candidate(node)) toolView.remove(node);
    else if (userCandidate(node)) forgetUser(node);
    parents.delete(node);
    if (node instanceof Container) for (const child of node.children) if (!attached(child)) releaseTree(child);
  }
  function pauseRendererTree(node: Component) {
    if (candidate(node)) toolView.pause(node);
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
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) notify(ctx.ui, message, 'error'); };
}
function syntaxNotice(owner: WeakRef<SyntaxContext>) {
  return (message: string, type: "error") => notify(owner.deref()?.current?.ui, message, type);
}
function loggingNotice(owner: WeakRef<SyntaxContext>) {
  return (message: string) => { const ctx = owner.deref()?.current; if (ctx?.hasUI) notify(ctx.ui, message, 'warning'); };
}

export default function tidyUi(pi: ExtensionAPI, options: TidyUiRuntimeOptions = {}) {
  if (typeof pi.registerToolRenderer !== 'function')
    throw new Error(`Pi ${VERSION} is unsupported; pi-tidy-ui requires Pi 1.0.1 or newer with public registerToolRenderer support.`);
  const nativeRendererFailureBridge: { current?: NativeRendererFailureReporter } = {};
  const rendererResolver = createLazyNativeRendererResolver(() => nativeRendererFailureBridge.current);
  pi.registerToolRenderer(rendererResolver);
  pi.registerFlag("tidy-ui-card", { type: "string", description: "Additional comma-separated tool names that retain native cards" });
  pi.registerFlag("tidy-ui-compact", { type: "string", description: "Comma-separated tool names that use compact summaries instead of native cards" });
  const retiredBudgetFlags = ["tidy-ui-cache-mb", "tidy-ui-card-cache-mb"];
  for (const flag of retiredBudgetFlags) pi.registerFlag(flag, { type: "string", description: "Deprecated and ignored: layouts are retained per component without eviction limits" });
  let warnedBudgetFlags = false;
  let controller: TidyUiController | undefined;
  const local = options.localPreferences ?? processPreferences();
  let enabled = local.appearanceEnabled, colorsEnabled = false, loggingEnabled = local.loggingEnabled;
  // Only confirmed choices survive runtime replacement; menu previews are client-local.
  let selectedTheme: ThemePreference = { kind: 'pi', variant: 'dark' };
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
        selectedTheme = copyThemePreference(loaded.themePreference);
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
    const choice = loaded.themePreference;
    const themeChanged = !sameThemePreference(choice, selectedTheme);
    const colorsChanged = colorsEnabled !== (loaded.terminalColorsEnabled ?? false);
    const nativeChanged = syntaxEnabled !== (loaded.nativeHighlightingEnabled ?? true);
    if (!themeChanged && !colorsChanged && !nativeChanged) return;
    selectedTheme = copyThemePreference(choice); syntaxEnabled = loaded.nativeHighlightingEnabled ?? true;
    if (colorsChanged) applyTerminalPreference(loaded.terminalColorsEnabled ?? false, ctx);
    const previewing = activeMenu?.preferencesChanged(selectedTheme);
    if (themeChanged && !previewing) syntax?.applySavedTheme(selectedTheme);
    if (nativeChanged) {
      void syntax?.setEnabled(syntaxEnabled).catch(() => { if (epoch === lifecycle && ctx.hasUI) notify(ctx.ui, 'Native highlighting preference could not be applied.', 'warning'); });
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
    const rendererSink = diagnostic;
    nativeRendererFailureBridge.current = (scope, tool, slot, outcome) => {
      const operation = `native-renderer:${tool}:${slot}`;
      if (outcome === 'failure') {
        diagnose(rendererSink, 'ERROR', 'appearance', 'Native file preview renderer failed; bounded fallback shown', { tool, slot });
        reportRuntime(rendererSink, { kind: 'failure', scope, operation, area: 'appearance', code: 'native_renderer' });
      } else reportRuntime(rendererSink, { kind: outcome, scope, operation });
    };
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
    if (syntax) { const stats = syntax.sourceStatistics.stats(), snapshot = syntax.snapshot(); diagnose(sink, "INFO", "syntax", "Snapshot of existing source/provider state", {
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
        warn: message => notify(liveContext?.ui, `Terminal colors: ${message}`, 'warning'),
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
        notify(ctx.ui, `--${flag} is ignored; layouts are retained per component without eviction limits`, 'warning');
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
        warn: (message) => { restoreFooter(); if (!diagnostic?.runtime) notify(liveContext?.ui, `Appearance disabled: ${message}`, 'warning'); },
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
    if (call?.type === 'toolCall' && supportsToolName(call.name, ['bash'])) liveBashCalls.add(call.id);
  });
  pi.on("session_tree", refreshFooter);
  pi.on("session_compact", refreshFooter);
  pi.on("model_select", refreshFooter);
  pi.on("message_end", refreshFooter);
  pi.on("turn_start", (_event, ctx) => { controller?.beginFileTurn(); refreshFooter(_event, ctx); });
  pi.on("turn_end", (event, ctx) => { controller?.finishFileTurn(); refreshFooter(event, ctx); });
  const refreshDirectory = (_event: unknown, ctx: ExtensionContext) => {
    const event = _event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
    if (typeof event.toolName === 'string' && supportsToolName(event.toolName, ['write', 'edit']) && event.isError === false && typeof event.toolCallId === 'string')
      controller?.completeFileCall(event.toolCallId);
    refreshFooter(_event, ctx);
    directorySource?.setDirectory(controller?.editorStatusActive ? ctx.cwd : undefined);
    directorySource?.refresh(true);
  };
  pi.on("tool_execution_end", refreshDirectory);
  pi.on("agent_end", (event, ctx) => { liveBashCalls.clear(); controller?.finishFileTurn(); refreshDirectory(event, ctx); });
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
    liveContext = ctx; logSnapshot(); pendingFooter = undefined; nativeRendererFailureBridge.current = undefined; health?.dispose();
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
        selectedTheme = copyThemePreference(action.choice);
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
          ...Object.entries(stats.byKind).map(([kind, memory]) => `${kind}: ${JSON.stringify(memory)}`),
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
      if (args.trim()) { notify(ctx.ui, 'Usage: /tidy-ui — open the settings menu; command arguments are no longer supported.', 'warning'); return; }
      if (ctx.mode !== 'tui' || !ctx.hasUI) { notify(ctx.ui, 'menu is available only in terminal mode with UI.', 'info'); return; }
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
      } catch { if (epoch === lifecycle) notify(ctx.ui, 'Settings menu could not be opened.', 'error'); }
      finally { opened?.dispose(); if (activeMenu === opened) activeMenu = undefined; }
    },
  });
  // Pi awaits the factory; startup can attach presentation without another I/O gap.
  return loadPreferences();
}
