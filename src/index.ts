import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type TerminalColorMode } from "@earendil-works/pi-tui";
import { NativeSession } from './host/pi/native-session.ts';
import { classifyNativeCode, nativeServiceRows, observeFooterSlot } from './host/pi/native-bindings.ts';
import type { UserRows } from './host/pi/user-components.ts';
import { PresentationSpinner } from './presentation/spinner.ts';
import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
import { SessionDiagnostics } from './application/diagnostic-session.ts';
import { notify } from './notifications.ts';
import { ExtensionSettings, processPreferences, type LocalPreferences } from './settings.ts';
import { ApplicationPreferences } from './application/preferences.ts';
import { ApplicationScope } from './application/scope.ts';
import { FooterSession } from './application/footer-session.ts';
import { TerminalColorSession } from './application/terminal-color-session.ts';
import { TidyMenu } from './tidy-menu.ts';
import type { TidyMenuOwner } from './application/menu-contract.ts';
import { menuSnapshot } from './application/menu-model.ts';
import { performMenuAction } from './application/menu-actions.ts';
import { type JournalOptions } from "./debug-log.ts";
import { diagnose, reportRuntime, type DiagnosticFields, type DiagnosticSink } from "./diagnostics.ts";
import type { FilePreviewMode } from './cards/file-preview-mode.ts';
import { PresentationCacheOwner } from './presentation/cache-owner.ts';
import { ToolPresentationSessions, type PresentationConstructionObserver } from './presentation/tool-sessions.ts';
import { createToolPreparationPresenter } from './presentation/tool-preparation.ts';
import { createToolViewPresenter } from './presentation/tool-view-presenter.ts';
import { ToolProducerPresenter } from './presentation/tool-producers.ts';
import { ToolSummaryPresenter } from './presentation/tool-summary-presenter.ts';
import { FileDetailPresenter } from './presentation/file-detail-presenter.ts';
import { ToolPresentationPolicy } from './presentation/tool-policy.ts';
import { ToolRoutingPresenter } from './presentation/tool-routing-presenter.ts';
import { UserPresenter } from './presentation/user-presenter.ts';
import { QueuedPresenter } from './presentation/queued-presenter.ts';
import type { EditorStatusInfo } from './editor-status.ts';
import { GitBranchSource, gitDiagnostics } from "./git-branch.ts";
import type { DefaultColors } from './terminal-colors.ts';
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
import { createLazyNativeRendererResolver, type NativeRendererFailureReporter } from './host/pi/lazy-native-renderers.ts';
export { describeToolArgs as describeArgs } from "./tool-adapters/summary.ts";
export { sanitize } from "./summary-args.ts";
const extensionVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
type LiveTui = { requestRender(): void; invalidate(): void };
type Palette = CardTheme;

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
  /** Explicit journal capture; reconciles collected layouts without rendering. */
  logSnapshot(): void;
  clearCache(): number;
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
type PreparedCardController = TidyUiController & { refreshPreparedPalette(node: object, token: object): void };
const DEFAULT_CARDS = ["bash", "powershell", "write", "edit"];
/** Composes source and presentation owners against one native installation. */
export function installTidyUi(tui: LiveTui, getTheme: () => Palette, options: InternalTidyUiOptions = {}): TidyUiController {
  const cacheOwner = new PresentationCacheOwner();
  const cache = cacheOwner.ordinary, cardCache = cacheOwner.cards;
  const decisions = new WeakMap<object, Map<string, { choice: string; width: number; rows: number; geometry?: string }>>();
  function decision(owner: object, area: string, choice: string, width: number, rows: number, fields?: DiagnosticFields, geometry?: string): void {
    if (!options.diagnostic) return;
    let marks = decisions.get(owner);
    const previous = marks?.get(area);
    if (previous?.choice === choice && previous.width === width && previous.rows === rows && previous.geometry === geometry) return;
    if (!marks) { marks = new Map(); decisions.set(owner, marks); }
    marks.set(area, { choice, width, rows, geometry });
    diagnose(options.diagnostic, 'DEBUG', area, choice, { width, rows, ...fields });
  }
  let passOutputPad: number | undefined;
  const outputPadding = () => passOutputPad ?? (options.outputPad?.() === 0 ? 0 : 1);
  let quiescing = false;
  // Construction only captures hooks; install invokes these ports after their consumers exist.
  const native: NativeSession = new NativeSession(tui, {
    theme: getTheme, decision,
    tool: {
      restorePreview: node => toolView.restorePreview(node), attach: node => toolView.attach(node),
      render: (node, width, render) => toolView.render(node, width, render),
      mouse: (node, event, render, mouse) => toolView.mouse(node, event, render, mouse),
      update: (node, name, args, method) => toolView.update(node, name, args, method),
      remove: node => toolView.remove(node), pause: node => toolView.pause(node),
    },
    user: {
      forget: node => userPresenter.forget(node),
      layout: (node, width, render) => {
        const theme = getTheme(), padding = options.outputPad ? outputPadding() : native.user.padding(node);
        return userPresenter.layout(node, width, theme, padding, native.user.text(node), native.user.padding(node),
          native.user.markdown(node), native.user.markdownTheme(node), native.user.transformers(node), render);
      },
      present: (node, width, rows) => toolView.presentUser(node, width, rows),
    },
    queued: {
      forget: node => queuedPresenter.forget(node),
      project: (messages, width, height, hint, projected) =>
        queuedPresenter.project(messages, width, height, getTheme(), outputPadding(), hint, projected),
    },
    document: {
      running: () => passOutputPad !== undefined,
      begin: () => { passOutputPad = outputPadding(); spinner.beginPass(); },
      end: completed => { passOutputPad = undefined; spinner.endPass(completed); },
    },
    failure: message => {
      diagnose(options.diagnostic, 'ERROR', 'compatibility', message);
      reportRuntime(options.diagnostic, { kind: 'failure', scope: controller, operation: 'appearance', area: 'appearance', code: 'unsupported_host' });
    },
    release: full => {
      if (full) {
        const animation = spinner.snapshot();
        diagnose(options.diagnostic, 'INFO', 'runtime', 'Presentation restoring native ownership; later owners remain untouched',
          { animationWakes: animation.wakes, animationRequests: animation.requests });
        filePreviewState.reset();
      }
      syntax?.dispose(); ownedSources?.dispose(); paletteOwner.dispose(); toolSessions.clearSyntax();
      if (full) { spinner.reset(); clearCache(); }
    },
  }, {
    nativeEditor: options.nativeEditor, editorStatus: options.editorStatus,
    rerouteEditorStatus: options.rerouteEditorStatus, editorStatusRestored: options.editorStatusRestored, warn: options.warn,
  });
  const active = () => native.active, attached = (node: object) => native.attached(node);
  const toolFields = native.fields;
  const toolProducer = new ToolProducerPresenter(toolFields);
  const spinner: PresentationSpinner<object> = new PresentationSpinner<object>({ active, quiescing: () => quiescing,
    executing: node => toolView.executing(node), attached, requestRender: () => tui.requestRender(), fields: toolFields, diagnostic: options.diagnostic });
  let lifecycleCallbacks = 0, lifecyclePhaseChanges = 0;
  function nativePhase(node: object, operation: string): void {
    lifecycleCallbacks++;
    if (!options.diagnostic) return;
    const phase = String(Number(toolFields.partial(node)) | Number(toolFields.argsComplete(node)) << 1 | Number(toolFields.executionStarted(node)) << 2
      | Number(toolFields.expanded(node)) << 3 | Number(!!toolFields.result(node)) << 4 | Number(toolFields.result(node)?.isError === true) << 5);
    if (decisions.get(node)?.get('tool-phase')?.geometry === phase) return;
    lifecyclePhaseChanges++;
    decision(node, 'tool-phase', 'Native tool phase changed; repeated same-phase callbacks counted only', 0, 0,
      { call: toolFields.id(node), tool: toolFields.name(node), operation, partial: toolFields.partial(node), complete: toolFields.argsComplete(node),
        executing: toolFields.executionStarted(node), expanded: toolFields.expanded(node), result: !!toolFields.result(node), error: toolFields.result(node)?.isError === true }, phase);
  }
  function toolDecision(node: object, choice: string, width: number, rows: number): void {
    if (options.diagnostic) decision(node, 'tool', choice, width, rows, { call: toolFields.id(node), tool: toolFields.name(node),
      expanded: toolFields.expanded(node), hidden: native.tool.hidden(node), partial: toolFields.partial(node), complete: toolFields.argsComplete(node) });
  }
  const userPresenter = new UserPresenter<object, UserRows>(cache, options.diagnostic, options.presentationConstructionObserver);
  const queuedPresenter = new QueuedPresenter<object>(cache, options.diagnostic, options.presentationConstructionObserver);
  const clearCache = () => {
    fileDetails.clear(); const cleared = cacheOwner.clear(); toolSessions.clearLayouts(); userPresenter.clear(); queuedPresenter.clear();
    diagnose(options.diagnostic, 'INFO', 'cache', 'Presentation layouts cleared; native/source caches are unchanged');
    return cleared;
  };
  const cards = new Set([...DEFAULT_CARDS, ...options.cards ?? []]);
  const overrides = new Set(options.compact ?? []);
  const nativeOverrides = new Set(options.cards ?? []);
  const toolSessions = new ToolPresentationSessions<object>({
    args: toolFields.args, result: toolFields.result,
    funding: () => cardClient?.cardSource.geometryFunding(),
    failed: (node, error) => diagnose(options.diagnostic, 'ERROR', 'file-detail', 'Expanded file details could not be measured',
      { call: toolFields.id(node), error: error instanceof Error ? error.name : 'UnknownError' }),
  }, options.presentationConstructionObserver);
  const fileDetails = toolSessions.fileDetails;
  const toolSummaryPresenter = new ToolSummaryPresenter(toolProducer, fileDetails, toolSessions, cache);
  const filePreviewState = toolSessions.filePreview;
  const toolPresentationPolicy = new ToolPresentationPolicy(toolProducer, toolSessions, {
    active, name: toolFields.name, toolCallId: toolFields.id,
    expanded: toolFields.expanded, hidden: node => native.tool.hidden(node), attached,
  }, { cards, compact: overrides, native: nativeOverrides });
  let syntax: CardSources<object> | undefined;
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
  function ensureCards(): CardSources<object> {
    if (syntax) return syntax;
    if (!cardClient) {
      const snapshot = { enabled: false, selected: { kind: 'pi', variant: 'dark' } as const, standaloneVersion: extensionVersion,
        provider: { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false } };
      const execution = new SourceExecution({ snapshot: () => snapshot.provider, isReady: () => false,
        recover: async () => { throw new Error('Disabled card provider requested recovery'); },
        workerUnavailable: async () => { throw new Error('Disabled card provider reported a worker'); },
        exhaustedRoute: async () => { throw new Error('Disabled card provider exhausted a route'); },
        classificationAccepted: () => { throw new Error('Disabled card provider accepted work'); },
        request: () => { throw new Error('Disabled card provider requested work'); } },
        { diagnostic: options.diagnostic, onChange: localCardNotice(new WeakRef(controller)) });
      execution.setEnabled(false); ownedSources = execution;
      cardClient = { cardSource: execution, sourceWork: execution, pi: execution.pi, sourcePump: execution, sourceStatistics: execution, snapshot: () => snapshot };
    }
    syntax = new CardSources(cardClient, {
      diagnostic: options.diagnostic, identify: node => ({ call: toolFields.id(node), tool: toolFields.name(node) }),
      preparation: options.cardPreparation ? (node, receipt) => options.cardPreparation?.({ ...receipt, call: toolFields.id(node), tool: toolFields.name(node) }) : undefined,
      preparePaletteInput: (effective, revision, mode, funding, usePiFallback) => {
        const input = needsPiTheme(effective) ? publicInput() : undefined;
        const fallbackTheme = () => publicInput().theme;
        if (options.preparePaletteInput) return options.preparePaletteInput(effective, input?.theme, revision, mode, funding, usePiFallback, fallbackTheme);
        return paletteOwner.prepare(input?.theme, effective, revision, mode, funding, usePiFallback, fallbackTheme);
      },
      classify: options.syntax?.classify ?? classifyNativeCode,
      invalidate: node => toolPreparation.invalidated(node), requestRender: () => { if (active() && !quiescing) tui.requestRender(); },
    });
    return syntax;
  }
  const nativeRows = (node: object, width: number) => native.tool.nativeRows(node, width);
  const toolRoutingPresenter = new ToolRoutingPresenter(toolPresentationPolicy, {
    fileRenderer: node => native.tool.fileRenderer(node), readRenderer: node => native.tool.readRenderer(node),
    selfShell: node => native.tool.selfShell(node), deferredFilePair: node => native.tool.deferredFilePair(node),
    stockEditShell: node => native.tool.stockEditShell(node), visible: (node, width) => nativeRows(node, width).length > 0,
  });
  const forget = (node: object, cause?: string, preserveFileDetail?: boolean) => toolView.forget(node, cause, preserveFileDetail);
  const toolPreparation = createToolPreparationPresenter({
    fields: toolFields, producer: toolProducer, sessions: toolSessions, policy: toolPresentationPolicy, routing: toolRoutingPresenter,
    cards: () => syntax, ensureCards,
    facts: { active, workActive: () => cardClient?.cardSource.active ?? true, quiescing: () => quiescing, attached, hidden: node => native.tool.hidden(node),
      cwd: node => { const cwd = (native.tool.context(node) as { cwd?: unknown } | null | undefined)?.cwd; return typeof cwd === 'string' ? cwd : undefined; },
      live: call => options.syntax?.isLiveCall?.(call) ?? true },
    palette: { needsInput: () => needsPiTheme(selectedPalette), input: publicInput, mode: terminalMode,
      generation: input => externalPaletteOwner ? options.syntax!.palette() : paletteOwner.palette(input?.theme, selectedPalette) },
    invalidate: (node, cause) => toolView.invalidatePrepared(node, cause), forget,
    refreshTarget: () => controller, requestRender: () => tui.requestRender(), flush: () => cardClient!.sourcePump.flush(),
  });
  const { unsupportedFullFile, observePalette, refusePreparedPresentation, refreshPalette, finishFileTurn } = toolPreparation;
  const fileMode = (node: object): FilePreviewMode | undefined => toolPresentationPolicy.fileMode(node);
  const preparedPresenter = new PreparedLayoutPresenter<object>({
    sessions: toolSessions, ordinaryCache: cache, cardCache, expanded: toolFields.expanded, kind: node => toolProducer.kind(node),
    active, outputPadding, funding: () => cardClient?.cardSource.geometryFunding(),
    visit: (node, consume) => syntax?.visit(node, consume) ?? false, identities: node => syntax?.identities(node) ?? [],
    fileMode, unsupportedFullFile, refuse: refusePreparedPresentation, observePalette,
    displayBasis: key => cardClient?.cardSource.displayBasis(key), piDisplay: key => cardClient?.pi.borrowPiSource(key),
    decision: (node, choice, width, rows, fields) => decision(node, 'syntax', choice, width, rows,
      { call: toolFields.id(node), tool: toolFields.name(node), selected: fields.selected, origin: fields.origin }),
  });
  const fileDetailPresenter = new FileDetailPresenter<object>({
    sessions: toolSessions, cache, producer: toolProducer, details: fileDetails, summaries: toolSummaryPresenter,
    theme: getTheme, padding: outputPadding, mode: fileMode,
    cwd: node => (native.tool.context(node) as { cwd?: string } | undefined)?.cwd,
    unsupported: node => syntax?.filePreparationOutcome(node) === 'unsupported', serviceRows: nativeServiceRows,
  });
  const toolView = createToolViewPresenter({
    fields: toolFields, producer: toolProducer, sessions: toolSessions, policy: toolPresentationPolicy,
    routing: toolRoutingPresenter, preparation: toolPreparation, summary: toolSummaryPresenter,
    detail: fileDetailPresenter, prepared: preparedPresenter,
    cards: () => syntax, funding: () => cardClient?.cardSource.geometryFunding(), theme: getTheme, padding: outputPadding,
    paletteOrigin: () => needsPiTheme(selectedPalette) ? 'pi' : 'owned', decision: toolDecision, phase: nativePhase,
    invalidated: (node, cause) => diagnose(options.diagnostic, 'DEBUG', 'cache', 'Tool layout invalidated',
      { call: toolFields.id(node), tool: toolFields.name(node), cause }),
    host: {
      active, quiescing: () => quiescing, attached, hidden: node => native.tool.hidden(node),
      cwd: node => (native.tool.context(node) as { cwd?: string } | undefined)?.cwd,
      isTool: (node): node is object => native.tool.isTool(node), siblings: node => native.siblings(node),
      index: (node, siblings) => native.index(node, siblings), otherRows: (node, width) => native.otherRows(node, width),
      nativeRows, imageRows: (node, width) => native.tool.imageRows(node, width),
      releaseFileRenderer: node => native.tool.releaseFileRenderer(node), syncRendererArgs: node => native.tool.syncRendererArgs(node),
      selection: () => native.selection(), setExpanded: (node, expanded) => native.tool.setExpanded(node, expanded),
      requestRender: () => tui.requestRender(),
    },
    animation: { animate: node => spinner.animate(node), remove: node => spinner.remove(node), time: () => spinner.time(), epoch: () => spinner.epoch() },
  });
  const controller: PreparedCardController = {
    refreshPreparedPalette: refreshPalette,
    get active() { return native.active; }, get reason() { return native.reason; },
    get editorActive() { return native.editorActive; }, get editorStatusActive() { return native.editorStatusActive; },
    cacheStats: () => cacheOwner.stats(),
    logSnapshot() {
      cacheOwner.reconcileCollected();
      diagnose(options.diagnostic, 'INFO', 'tool', 'Native lifecycle callback counters; these are not source dispatches',
        { callbacks: lifecycleCallbacks, phaseChanges: lifecyclePhaseChanges });
      diagnose(options.diagnostic, 'INFO', 'animation', 'Snapshot of owned fallback animation; native Pi clock is not intercepted', spinner.snapshot());
    },
    renderEditorStatus: (width, info) => native.renderEditorStatus(width, info),
    clearCache,
    syntaxSourceChanged(keys, groups) { if (active() && !quiescing) syntax?.sourceChanged(keys, groups); },
    beginFileTurn() { if (active() && !quiescing) filePreviewState.beginTurn(); },
    completeFileCall(toolCallId) { if (active() && !quiescing) filePreviewState.completed(toolCallId); },
    finishFileTurn,
    syntaxMetadataChanged() {
      if (active() && !quiescing) {
        selectedPalette = cardClient?.snapshot().effective ?? resolveTheme({ kind: 'pi', variant: 'dark' }).effective;
        const paletteRevision = externalPaletteOwner ? options.syntax!.palette()
          : paletteOwner.palette(needsPiTheme(selectedPalette) ? publicInput().theme : undefined, selectedPalette);
        syntax?.metadataChanged(paletteRevision);
      }
    },
    quiesce() { quiescing = true; spinner.reset(); },
    restore: settings => native.restore(settings),
  };
  native.install();
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
  /** Existing provider/choice bindings for controlled SDK embeddings. */
  syntax?: (ctx: ExtensionContext) => SyntaxRuntimeOptions;
}
interface SyntaxContext { current?: ExtensionContext }
function syntaxNotice(owner: WeakRef<SyntaxContext>) {
  return (message: string, type: "error") => notify(owner.deref()?.current?.ui, message, type);
}
function syntaxDetachFailure(sink?: DiagnosticSink) {
  return () => diagnose(sink, 'ERROR', 'syntax', 'Could not deactivate highlighting after native presentation was restored');
}
function nativeRendererFailureReporter(rendererSink: DiagnosticSink): NativeRendererFailureReporter {
  return (scope, tool, slot, outcome) => {
    const operation = `native-renderer:${tool}:${slot}`;
    if (outcome === 'failure') {
      diagnose(rendererSink, 'ERROR', 'appearance', 'Native file preview renderer failed; bounded fallback shown', { tool, slot });
      reportRuntime(rendererSink, { kind: 'failure', scope, operation, area: 'appearance', code: 'native_renderer' });
    } else reportRuntime(rendererSink, { kind: outcome, scope, operation });
  };
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
  const settings = options.settings ?? new ExtensionSettings();
  const preferences = new ApplicationPreferences(settings, local);
  const applicationScope = new ApplicationScope();
  let activeMenu: TidyMenu | undefined;
  let liveContext: ExtensionContext | undefined;
  let syntax: SyntaxRuntime | undefined;
  let syntaxTheme: ReturnType<ApplicationPreferences['openThemeScope']> | undefined;
  // Only primitive IDs for the current assistant stream; never retain message bodies/history.
  const liveBashCalls = new Set<string>();
  const syntaxContext: SyntaxContext = {};
  const diagnostics = new SessionDiagnostics(options.logging);
  function startLogging(ctx: ExtensionContext, reason: string) {
    diagnostics.begin(ctx, reason, preferences.loggingEnabled, sink => {
      nativeRendererFailureBridge.current = nativeRendererFailureReporter(sink);
    });
  }
  function logSnapshot() {
    const logging = diagnostics.journal;
    if (!logging?.status().capture) return;
    const sink = logging.sink;
    diagnose(sink, "INFO", "runtime", "Snapshot of existing runtime state", { presentation: preferences.appearanceEnabled, adapter: controller?.active ?? false,
      syntax: preferences.nativeHighlightingEnabled, terminalColors: preferences.terminalColorsEnabled, footer: footer.active, mode: liveContext?.mode });
    controller?.logSnapshot();
    diagnose(sink, "INFO", "git", "Snapshot of existing process Git counters", gitDiagnostics());
    if (controller) { const stats = controller.cacheStats(); diagnose(sink, "INFO", "cache", "Snapshot of existing layout counters", {
      entries: stats.entries, rows: stats.rows, bytes: stats.retainedBytes, hits: stats.hits, misses: stats.misses, builds: stats.builds,
      releases: stats.releases, collected: stats.collected }); }
    const health = diagnostics.healthSnapshot();
    if (health) diagnose(sink, 'INFO', 'runtime', 'Snapshot of runtime health; distinct from log write failures', { errors: health.errors, active: health.active, code: health.last?.code, state: health.last?.state });
    if (syntax) { const stats = syntax.sourceStatistics.stats(), snapshot = syntax.snapshot(); diagnose(sink, "INFO", "syntax", "Snapshot of existing source/provider state", {
      availability: snapshot.provider.availability, reason: snapshot.provider.reason, generation: snapshot.provider.generation,
      kind: snapshot.provider.kind, theme: snapshot.selected.kind, palette: snapshot.effective?.id,
      sourceRecords: stats.sourceRecords, piSourceRecords: stats.piSourceRecords, leases: stats.remoteLeases,
      jobs: stats.unsettledJobs, closes: stats.pendingCloses, bytes: stats.transientBytes, bookkeepingBytes: stats.bookkeepingBytes }); }
    const colorStatus = colors.status();
    if (colorStatus) diagnose(sink, "INFO", "terminal-colors", "Snapshot of existing terminal-color counters", { ...colorStatus, ...colors.stats() });
  }
  function ensureSyntax(ctx: ExtensionContext) {
    syntaxContext.current = ctx;
    if (!syntax) {
      const theme = preferences.openThemeScope(diagnostics.sink);
      syntax = new SyntaxRuntime({ ...(options.syntax ? options.syntax(ctx) : createSyntaxOptions(ctx, undefined, diagnostics.sink)),
        initialTheme: preferences.themeInput(), onActivationChanged: theme.onActivationChanged, onDisposed: theme.onDisposed,
        diagnostic: diagnostics.sink, enabled: preferences.nativeHighlightingEnabled,
        enabledChanged: value => preferences.acceptNativePreference(value), notify: syntaxNotice(new WeakRef(syntaxContext)) });
      theme.bind(syntax); syntaxTheme = theme;
    }
    return syntax;
  }
  function stopSyntax() {
    const previous = syntax;
    syntax = undefined; syntaxTheme = undefined;
    return previous?.dispose();
  }
  const colors = new TerminalColorSession({
    context: () => liveContext, appearanceEnabled: () => preferences.appearanceEnabled,
    terminalColorsEnabled: () => preferences.terminalColorsEnabled,
    diagnosticSink: () => diagnostics.sink, journalSink: () => diagnostics.journal?.sink,
    themeSetting: () => pi.getSettings().theme, terminalLifecycle: ensureSyntax, defaults: () => options.terminalDefaults,
  });
  const palette = () => colors.palette(liveContext!.ui.theme);
  let directorySource: GitBranchSource | undefined;
  const footer = new FooterSession({
    context: () => liveContext, appearanceEnabled: () => preferences.appearanceEnabled,
    editorEligible: () => controller?.editorActive ?? false, journalSink: () => diagnostics.journal?.sink,
    autoCompaction: () => pi.getSettings().compaction?.enabled ?? true,
  });
  const statusWidget = "pi-tidy-ui-editor-status";
  const names = (flag: string) => String(pi.getFlag(flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  function startPresentation(ctx: ExtensionContext) {
    liveContext = ctx; syntaxContext.current = ctx;
    startLogging(ctx, "presentation startup");
    footer.advance();
    directorySource?.refresh(true);
    if (ctx.mode !== "tui" || !preferences.appearanceEnabled) { diagnose(diagnostics.journal?.sink, "INFO", "runtime", "Presentation startup skipped", { mode: ctx.mode, enabled: preferences.appearanceEnabled }); return; }
    colors.start(ctx);
    if (controller?.active) { diagnose(diagnostics.journal?.sink, "INFO", "runtime", "Existing presentation reused"); footer.start(ctx); return; }
    if (!warnedBudgetFlags) {
      warnedBudgetFlags = true;
      for (const flag of retiredBudgetFlags) if (pi.getFlag(flag) !== undefined)
        notify(ctx.ui, `--${flag} is ignored; layouts are retained per component without eviction limits`, 'warning');
    }
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-tidy-ui-capture", (tui) => {
      const slot = ctx.ui.getEditorComponent() === undefined ? observeFooterSlot(tui) : undefined;
      if (slot) footer.defer(slot);
      const sourceRuntime = ensureSyntax(ctx);
      if (controller) reportRuntime(diagnostics.sink, { kind: 'released', scope: controller, operation: '*' });
      let installed: TidyUiController | undefined;
      installed = installTidyUi(tui, palette, {
        diagnostic: diagnostics.sink, cardPreparation: options.cardPreparation,
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
        warn: (message) => {
          // Native hooks and card work are already restored. Initial install failure has no attachment to revoke.
          if (installed) void sourceRuntime.detach(installed).catch(syntaxDetachFailure(diagnostics.sink));
          footer.restore();
          if (!diagnostics.sink?.runtime) notify(liveContext?.ui, `Appearance disabled: ${message}`, 'warning');
        },
      });
      controller = installed;
      diagnose(diagnostics.journal?.sink, "INFO", "runtime", "Presentation installation finished", { active: installed.active, reason: installed.reason });
      if (installed.active) sourceRuntime.attach(installed);
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-tidy-ui-capture", undefined);
    if (controller?.active) ctx.ui.setWidget(statusWidget, (tui) => {
      directorySource ??= new GitBranchSource(() => tui.requestRender(), { diagnostic: diagnostics.sink });
      return {
      render(width) {
        const current = liveContext;
        if (!current || !controller?.active) return [];
        footer.finishStart();
        directorySource?.setDirectory(controller.editorStatusActive && typeof current.cwd === "string" ? current.cwd : undefined);
        return controller.renderEditorStatus(width, { model: current.model?.name || "No model",
          provider: current.model?.provider || "—", thinking: current.thinkingLevel ?? pi.getThinkingLevel(), idle: current.isIdle(),
          cwd: current.cwd, branch: directorySource?.branch(current.cwd) });
      },
      invalidate() {},
    }; }, { placement: "belowEditor" });
    footer.start(ctx);
  }
  const refreshFooter = (event: unknown, ctx: ExtensionContext) => {
    liveContext = ctx; syntaxContext.current = ctx; footer.advance();
    const kind = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
    diagnose(diagnostics.journal?.sink, "DEBUG", "runtime", "Pi semantic boundary observed; existing footer snapshot invalidated", {
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
  async function startSession(ctx: ExtensionContext, reason: string) {
    activeMenu?.close(); activeMenu = undefined;
    const current = applicationScope.beginSession();
    liveBashCalls.clear(); footer.resetName();
    if (!preferences.initialized) await preferences.ready();
    if (!applicationScope.isGeneration(current)) return;
    startLogging(ctx, reason); preferences.reportInitialIssue(diagnostics.sink); startPresentation(ctx);
    preferences.watch(applicationScope.scope(current), {
      terminalColors: value => colors.applyPreference(value, ctx),
      theme(choice, changed) {
        const previewing = activeMenu?.preferencesChanged(choice);
        if (changed && !previewing) syntax?.applySavedTheme(choice);
      },
      nativeHighlighting: value => syntax?.setEnabled(value),
      nativeFailed: () => { if (ctx.hasUI) notify(ctx.ui, 'Native highlighting preference could not be applied.', 'warning'); },
    }, diagnostics.sink, diagnostics.journal?.sink);
  }
  pi.on('session_start', (event, ctx) => startSession(ctx, event.reason));
  pi.on("session_info_changed", (event) => {
    // Async handlers may deliver old notifications last; reread current saved metadata once.
    footer.nameChanged();
    diagnostics.journal?.nameChanged(event.name);
  });
  function quiesceSession(ctx: ExtensionContext): void {
    applicationScope.retire(); preferences.stopWatching(); activeMenu?.close(); activeMenu = undefined;
    liveBashCalls.clear(); footer.resetName();
    liveContext = ctx; logSnapshot(); footer.cancelDeferred(); nativeRendererFailureBridge.current = undefined; diagnostics.retireHealth();
    controller?.quiesce();
  }
  async function shutdownSession(ctx: ExtensionContext, reason: string) {
    quiesceSession(ctx);
    try { await stopSyntax(); }
    finally {
      try { await diagnostics.closeJournal(reason); }
      finally {
        diagnostics.releaseJournal();
        try { colors.stop(reason !== 'quit'); }
        finally {
          try { footer.restore(); }
          finally {
            try { controller?.restore({ repaint: false }); }
            finally { controller = undefined; liveContext = undefined; syntaxContext.current = undefined;
              diagnostics.release(); }
          }
        }
      }
    }
  }
  pi.on('session_shutdown', (event, ctx) => shutdownSession(ctx, event.reason));
  function menuOwner(ctx: ExtensionContext, epoch: number): TidyMenuOwner {
    const scope = applicationScope.scope(epoch);
    const current = scope.current;
    const owner: TidyMenuOwner = {
      snapshot() {
        return menuSnapshot(preferences, { color: colors.status()?.state, syntax: syntax?.snapshot(),
          logs: diagnostics.journal?.status(), health: diagnostics.healthSnapshot(), appearance: controller });
      },
      readSessionName: () => current() ? ctx.sessionManager.getSessionName() : undefined,
      async prepareThemes() { if (current()) await ensureSyntax(ctx).prepareThemes(); },
      previewTheme(choice) { if (current()) syntax?.previewTheme(choice); },
      act: action => performMenuAction(action, {
        preferences, scope, diagnostic: diagnostics.sink, journal: diagnostics.journal?.sink,
        switches: {
          appearance(value) {
            if (value) startPresentation(ctx);
            else {
              footer.cancelDeferred(); colors.stop(); footer.restore();
              if (controller) reportRuntime(diagnostics.sink, { kind: 'released', scope: controller, operation: '*' });
              controller?.restore(); return stopSyntax();
            }
          },
          terminalColors: value => colors.applyPreference(value, ctx),
          nativeHighlighting: value => syntax?.setEnabled(value),
          logging: value => diagnostics.journal?.setEnabled(value),
          recordingFailed: () => diagnostics.journal?.status().state === 'failed',
        },
        applyAppearance: () => startPresentation(ctx),
        reapplyTerminalColors() { colors.reapply(ctx); },
        async confirmTheme(choice) {
          const runtime = ensureSyntax(ctx);
          const outcome = await preferences.confirmTheme(syntaxTheme!, choice);
          if (!current() || syntax !== runtime) return { kind: 'retired' };
          return { kind: 'completed', outcome };
        },
        clearLayouts() {
          if (!controller?.active) return undefined;
          return controller.clearCache() + footer.clearLayouts();
        },
        recording: {
          async retry() {
            if (!preferences.loggingEnabled || !diagnostics.journal) return 'unavailable';
            await diagnostics.journal.setEnabled(true);
            return diagnostics.journal.status().state === 'active' ? 'active' : 'inactive';
          },
          async writeSnapshot() {
            const log = diagnostics.journal;
            if (!log?.status().capture || log.status().state !== 'active') return 'notCapturing';
            logSnapshot(); await log.flush();
            if (!current() || diagnostics.journal !== log) return 'retired';
            return log.status().state === 'active' ? 'written' : 'writeFailed';
          },
        },
      }),
      cacheDetails(page) {
        if (!current() || !controller) return undefined;
        return { active: controller.active, stats: controller.cacheStats(),
          ...(page === 'cache' ? { footer: footer.retainedMemory(), heapUsedBytes: getHeapStatistics().used_heap_size } : {}) };
      },
    };
    return owner;
  }
  pi.registerCommand('tidy-ui', {
    description: 'Open Tidy UI appearance settings, status and troubleshooting',
    handler: async (args, ctx) => {
      if (args.trim()) { notify(ctx.ui, 'Usage: /tidy-ui — open the settings menu; command arguments are no longer supported.', 'warning'); return; }
      if (ctx.mode !== 'tui' || !ctx.hasUI) { notify(ctx.ui, 'menu is available only in terminal mode with UI.', 'info'); return; }
      const epoch = applicationScope.generation;
      await preferences.ready();
      if (!applicationScope.isGeneration(epoch)) return;
      preferences.reportInitialIssue(diagnostics.sink);
      liveContext = ctx; syntaxContext.current = ctx;
      diagnostics.refreshJournalContext(ctx);
      activeMenu?.close();
      let opened: TidyMenu | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          if (!applicationScope.isGeneration(epoch)) { done(); return { render: () => [], invalidate() {} }; }
          const menu = new TidyMenu(menuOwner(ctx, epoch), theme, () => tui.requestRender(), () => done(), () => tui.terminal.rows);
          opened = activeMenu = menu; return menu;
        }, { overlay: true, overlayOptions: { anchor: 'center', get width() { return opened?.preferredWidth() ?? 1; }, maxHeight: '100%', margin: 0 } });
      } catch { if (applicationScope.isGeneration(epoch)) notify(ctx.ui, 'Settings menu could not be opened.', 'error'); }
      finally { opened?.dispose(); if (activeMenu === opened) activeMenu = undefined; }
    },
  });
  // Pi awaits the factory; startup can attach presentation without another I/O gap.
  return preferences.ready();
}
