import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { CardPreparationPort } from './card-preparation.ts';
import type { FileDetailDraft } from './file-details.ts';
import type { ToolFieldAccessors, ToolProducerPresenter } from './tool-producers.ts';
import type { ToolPresentationPolicy } from './tool-policy.ts';
import type { ToolRoutingPresenter } from './tool-routing-presenter.ts';
import type { FileInputSnapshot, FileSourceSnapshot, ToolPresentationSessions, ToolSyntaxState } from './tool-sessions.ts';

interface PaletteObservation {
  theme: { colors: object };
  mode: TerminalColorMode;
}

export interface ToolPreparationPorts<Owner extends object, Input extends PaletteObservation> {
  fields: ToolFieldAccessors<Owner>;
  producer: ToolProducerPresenter<Owner>;
  sessions: ToolPresentationSessions<Owner>;
  policy: ToolPresentationPolicy<Owner>;
  routing: ToolRoutingPresenter<Owner>;
  cards(): CardPreparationPort<Owner> | undefined;
  ensureCards(): CardPreparationPort<Owner>;
  facts: {
    active(): boolean;
    workActive(): boolean;
    quiescing(): boolean;
    attached(owner: Owner): boolean;
    hidden(owner: Owner): boolean;
    cwd(owner: Owner): string | undefined;
    live(call: string): boolean;
  };
  palette: {
    needsInput(): boolean;
    input(): Input;
    mode(): TerminalColorMode;
    generation(input: Input | undefined): number;
  };
  invalidate(owner: Owner, cause: string): void;
  forget(owner: Owner, cause: string): void;
  refreshTarget(): PreparedRefreshTarget<Owner>;
  requestRender(): void;
  flush(): void;
}

export interface PreparedRefreshTarget<Owner extends object> {
  readonly active: boolean;
  refreshPreparedPalette(owner: Owner, token: object): void;
}

function paletteRefresh<Owner extends object>(owner: WeakRef<Owner>, target: WeakRef<PreparedRefreshTarget<Owner>>, token: object) {
  return () => { const node = owner.deref(), current = target.deref(); if (node && current?.active) current.refreshPreparedPalette(node, token); };
}

// An argument update supplies the previous SDK record. Other updates may change the display.
type ToolObservationUpdate = true | Record<string, unknown>;

function equalArguments(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  if (before === after) return true;
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every(key => Object.hasOwn(after, key) && before[key] === after[key]);
}

export interface ToolPreparationPresenter<Owner extends object> {
  seedFileState(owner: Owner): ToolSyntaxState;
  observeSyntax(owner: Owner, readVisible?: boolean, update?: ToolObservationUpdate): ToolSyntaxState | undefined;
  syntaxEligible(owner: Owner, readVisible?: boolean): boolean;
  requestFilePreparation(owner: Owner, width: number): void;
  observeFrame(owner: Owner, width: number): void;
  unsupportedFullFile(owner: Owner): boolean;
  pauseSyntax(owner: Owner): void;
  usefulSyntax(owner: Owner): void;
  observePalette(owner: Owner, origin: 'owned' | 'pi'): void;
  refusePreparedPresentation(owner: Owner, cause: string): void;
  refreshPalette(owner: Owner, token: object): void;
  invalidated(owner: Owner): void;
  prepareFileDetail(owner: Owner, refreshContent?: boolean): void;
  observeFileTurn(owner: Owner, finalize?: boolean): void;
  finishFileTurn(): void;
  settleInterrupted(owner: Owner): void;
}

/** UI demand/currentness only; the supplied card owner keeps preparation and publication authority. */
export function createToolPreparationPresenter<Owner extends object, Input extends PaletteObservation>(
  ports: ToolPreparationPorts<Owner, Input>,
): ToolPreparationPresenter<Owner> {
  const { fields, producer, sessions, policy, routing, cards, ensureCards, facts, palette } = ports;
  const fileDetails = sessions.fileDetails, filePreviewState = sessions.filePreview;
  const filePresentationTool = (node: Owner) => policy.filePresentationTool(node);
  const fileMode = (node: Owner) => policy.fileMode(node);
  const filePreviewMode = (node: Owner) => policy.filePreviewMode(node);
  const dropPrepared = (node: Owner) => sessions.dropPreparedLayout(node);
  const toolReader = (node: Owner) => producer.reader(node);
  const cardKind = (node: Owner) => producer.kind(node);
  const equalIdentity = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);

  function seedFileState(node: Owner): ToolSyntaxState {
    let state = sessions.syntax(node);
    if (!state) {
      state = { attempt: 0, revision: 0, sourceRevision: 0, serviceRevision: 0, identity: [], service: [], complete: false, live: false, applied: false };
      sessions.setSyntax(node, state);
    }
    return state;
  }
  function cancelPreparedRefresh(state: ToolSyntaxState | undefined): void {
    if (!state) return;
    state.refreshPending = false; state.refreshToken = undefined;
  }
  function schedulePreparedRefresh(node: Owner, state: ToolSyntaxState): boolean {
    if (state.refreshPending) return false;
    const token = {};
    state.refreshPending = true; state.refreshToken = token;
    queueMicrotask(paletteRefresh(new WeakRef(node), new WeakRef(ports.refreshTarget()), token));
    return true;
  }
  function deferObservation(node: Owner, update?: ToolObservationUpdate): ToolSyntaxState {
    const bash = cardKind(node) === 'bash';
    const live = bash && liveBashSource(node);
    const state = seedFileState(node);
    state.live = live;
    // Pi may reparse unchanged arguments. Compare only the shallow fields, never the result or source preparation.
    if (state.unreflected !== 'bash-update') {
      const changed = bash && (update === true || update && !equalArguments(update, fields.args(node)));
      state.unreflected = changed ? 'bash-update' : 'refresh';
    }
    cancelPreparedRefresh(state);
    return state;
  }
  function observeFrame(node: Owner, width: number): void {
    const state = sessions.syntax(node);
    if (!state?.unreflected || !facts.active() || !facts.workActive() || facts.quiescing()
      || width < 1 || !facts.attached(node) || facts.hidden(node)) return;
    if (filePresentationTool(node) && !routing.fileVisible(node, width)) return;
    schedulePreparedRefresh(node, state);
  }
  function requestFilePreparation(node: Owner, width: number): void {
    if (!facts.active() || !facts.workActive() || facts.quiescing() || !filePresentationTool(node) || fileMode(node) === undefined || width < 1) return;
    const state = seedFileState(node);
    if (!state.applied || state.paintRetry) schedulePreparedRefresh(node, state);
  }
  function discardFullFile(node: Owner): void {
    const state = sessions.syntax(node);
    if (state) { state.applied = false; state.paintRetry = false; }
    dropPrepared(node);
    cards()?.discardFile(node);
  }
  function unsupportedFullFile(node: Owner): boolean {
    return filePreviewMode(node) === 'full' && sessions.syntax(node)?.applied === true
      && cards()?.filePreparationOutcome(node) === 'unsupported';
  }
  function liveBashSource(node: Owner): boolean { return sessions.syntax(node)?.live ?? facts.live(fields.id(node)); }
  function interruptedLiveBash(reader: ReturnType<typeof toolReader>, live: boolean): boolean {
    return reader?.kind === 'bash' && !reader.call.partial && reader.failed && reader.failurePhase() === 'formation' && live;
  }
  function syntaxEligible(node: Owner, readVisible?: boolean, reader = toolReader(node)): boolean {
    if (!reader || !facts.active() || !facts.attached(node) || facts.hidden(node)) return false;
    if (reader.kind === 'bash') {
      const cwd = facts.cwd(node);
      return policy.bashSourceSelected(node) && reader.hasCommand() && reader.directory(cwd) !== null
        && !fields.result(node)?.content!.some(part => part.type === 'image');
    }
    if (reader.kind === 'read') {
      if (policy.readPresentationMode(node) !== 'full' || !reader.succeeded) return false;
      return routing.readSyntaxVisible(node, sessions.lastRenderWidth(node), readVisible);
    }
    return (reader.kind === 'write' || reader.kind === 'edit') && reader.succeeded
      && filePreviewMode(node) !== undefined && !policy.hasImage(node);
  }
  function sameFileSource(a: FileSourceSnapshot, b: FileSourceSnapshot): boolean { return a.mode === b.mode && equalIdentity(a.key, b.key); }
  function observeSyntax(node: Owner, readVisible?: boolean, update?: ToolObservationUpdate): ToolSyntaxState | undefined {
    if (!facts.active()) return;
    if (!facts.workActive()) return deferObservation(node, update);
    const reader = toolReader(node);
    const prior = sessions.syntax(node);
    const pendingBashUpdate = prior?.unreflected === 'bash-update';
    if (prior) prior.unreflected = undefined;
    cancelPreparedRefresh(prior);
    if (!facts.quiescing() && filePresentationTool(node) && facts.attached(node) && !prior) seedFileState(node);
    if (!facts.quiescing() && filePresentationTool(node) && !facts.attached(node)) {
      const state = sessions.syntax(node); if (state) { state.applied = false; state.paintRetry = false; }
      pauseSyntax(node); return;
    }
    if (!reader || facts.quiescing() || !syntaxEligible(node, readVisible, reader)) {
      const state = sessions.syntax(node); if (state) {
        state.applied = false; state.refused = false; state.paintRetry = false;
        if (reader?.kind !== 'bash') state.fileInput = undefined;
      }
      if (reader?.kind !== 'bash') { dropPrepared(node); if (!facts.quiescing()) cards()?.discardFile(node); }
      pauseSyntax(node); return;
    }
    const owner = ensureCards();
    let state = sessions.syntax(node);
    const viewMode = reader.kind === 'bash' ? undefined : fileMode(node)!;
    let fileInput: FileInputSnapshot | undefined;
    let identity: unknown[];
    const cwd = facts.cwd(node);
    let directory: string | undefined;
    let service: unknown[];
    if (reader.kind === 'bash') {
      const resolved = reader.directory(cwd);
      if (resolved === null) { pauseSyntax(node); return; }
      directory = resolved;
      identity = [...reader.source()];
      service = [...reader.service(directory)];
    } else {
      const previous = state?.fileInput;
      const sourceDirty = sessions.takeFileSourcesDirty(node);
      const sameObservation = previous && previous.reader.argsRef === reader.argsRef && previous.reader.resultRef === reader.resultRef
        && previous.reader.call.partial === reader.call.partial && previous.reader.call.expanded === reader.call.expanded
        && previous.reader.call.executionStarted === reader.call.executionStarted && previous.reader.call.argsComplete === reader.call.argsComplete;
      const reusable = sameObservation && !sourceDirty && previous.source.mode === viewMode;
      const source = reusable ? previous.source : { mode: viewMode!, key: reader.source(viewMode!) };
      const diagnostics = reusable ? previous.diagnostics : reader.diagnostics(viewMode!);
      const token = previous && sameFileSource(previous.source, source) ? previous.token : {};
      const activeReader = reusable ? previous.reader : reader;
      fileInput = { reader: activeReader, source, diagnostics, token };
      identity = [activeReader.kind, token, viewMode];
      service = [...activeReader.service(cwd, viewMode!), ...(Array.isArray(diagnostics) ? diagnostics : [diagnostics])];
    }
    const readerChanged = !!fileInput && (state?.fileInput?.reader.argsRef !== fileInput.reader.argsRef
      || state?.fileInput?.reader.resultRef !== fileInput.reader.resultRef);
    if (state && fileInput) state.fileInput = fileInput;
    const input = palette.needsInput() ? palette.input() : undefined;
    const mode = input?.mode ?? palette.mode();
    const generation = palette.generation(input);
    const changed = !state || !equalIdentity(identity, state.identity), serviceChanged = !state || !equalIdentity(service, state.service);
    if (!state) { state = { attempt: 0, revision: 0, sourceRevision: 0, serviceRevision: 0, identity: [], service: [], palette: generation, mode, complete: false, applied: false, live: liveBashSource(node) }; sessions.setSyntax(node, state); }
    const complete = reader.kind === 'bash' ? reader.isComplete(liveBashSource(node)) : true;
    if (!state.applied || state.paintRetry || readerChanged || changed || serviceChanged || state.palette !== generation || state.mode !== mode || complete !== state.complete) {
      const wasPaintRetry = state.paintRetry === true;
      const unchangedDisplay = state.applied && !changed && !serviceChanged
        && state.palette === generation && state.mode === mode && complete === state.complete;
      const paintOnlyRetry = unchangedDisplay && wasPaintRetry;
      const attempt = ++state.attempt;
      const common = { revision: unchangedDisplay ? state.revision : attempt, sourceRevision: changed ? attempt : state.sourceRevision,
        serviceRevision: serviceChanged ? attempt : state.serviceRevision, palette: generation, mode };
      state.applied = false;
      const accepted = reader.kind === 'bash'
        ? owner.updateDisplay(node, { ...common, kind: 'bash', reader, complete, directory })
        : owner.updateDisplay(node, { ...common, kind: 'file', reader: fileInput!.reader, diagnostics: fileInput!.diagnostics,
          viewMode: viewMode!, cwd });
      if (sessions.syntax(node) !== state || state.attempt !== attempt) return;
      if (!facts.workActive()) return deferObservation(node, pendingBashUpdate ? true : update);
      if (!accepted) {
        if (filePresentationTool(node)) {
          if (viewMode === 'full') discardFullFile(node);
          state.paintRetry = false; state.refused = true;
        }
        pauseSyntax(node); return filePresentationTool(node) ? state : undefined;
      }
      if (!syntaxEligible(node)) { pauseSyntax(node); return; }
      let paintRetry = false;
      if (filePresentationTool(node) && owner.filePreparationOutcome(node) === 'supported')
        paintRetry = !owner.visit(node, () => {});
      Object.assign(state, common, { identity, service, ...(fileInput ? { fileInput } : {}), complete, applied: true,
        paintRetry, refused: paintRetry || paintOnlyRetry && state.refused === true, paletteColors: input ? new WeakRef(input.theme.colors) : undefined });
      if (paintRetry !== wasPaintRetry) ports.invalidate(node, paintRetry ? 'accepted file source has no funded paint' : 'accepted file paint recovered');
    }
    if (reader.kind === 'bash' && interruptedLiveBash(reader, liveBashSource(node))) owner.freeze(node);
    return state;
  }
  function pauseSyntax(node: Owner) {
    const state = sessions.syntax(node); if (state) state.paused = true;
    cards()?.pause(node);
  }
  function usefulSyntax(node: Owner) {
    if (!facts.workActive()) return;
    const state = sessions.syntax(node);
    if (state?.applied && syntaxEligible(node)) { state.paused = false; cards()?.useful(node, state.revision); }
  }
  function observePalette(node: Owner, origin: 'owned' | 'pi') {
    if (!facts.workActive() || facts.quiescing() || !facts.attached(node) || facts.hidden(node)) return;
    const width = sessions.lastRenderWidth(node);
    if (width === undefined || width < 1) return;
    const state = sessions.syntax(node); if (!state || state.refreshPending) return;
    const input = origin === 'pi' ? palette.input() : undefined;
    const hasColorBaseline = state.paletteColors !== undefined;
    const previousColors = state.paletteColors?.deref();
    if (!hasColorBaseline && input) state.paletteColors = new WeakRef(input.theme.colors);
    const colorsChanged = !!input && hasColorBaseline && previousColors !== input.theme.colors;
    const mode = input?.mode ?? palette.mode();
    if (state.mode !== mode || colorsChanged) schedulePreparedRefresh(node, state);
  }
  function refusePreparedPresentation(node: Owner, cause: string): void {
    const state = sessions.syntax(node);
    if (!filePresentationTool(node) || !state || state.refused) return;
    state.refused = true;
    ports.invalidate(node, cause);
  }
  function refreshPalette(node: Owner, token: object) {
    const state = sessions.syntax(node);
    if (!state || !state.refreshPending || state.refreshToken !== token) return;
    cancelPreparedRefresh(state);
    if (!facts.active() || facts.quiescing()) return;
    if (!facts.workActive()) { state.unreflected ??= 'refresh'; return; }
    const unreflected = state.unreflected !== undefined;
    if (filePresentationTool(node)) {
      const mode = fileMode(node), width = sessions.lastRenderWidth(node);
      if (!facts.attached(node) || facts.hidden(node) || mode === undefined || cardKind(node) === 'read' && mode !== 'full') {
        observeSyntax(node, cardKind(node) === 'read' ? false : undefined); return;
      }
      if (width === undefined || width < 1) return;
      if (!routing.fileVisible(node, width)) { pauseSyntax(node); return; }
      const wasRefused = state.refused, previousRevision = state.revision;
      const current = observeSyntax(node, true);
      if (unreflected) {
        prepareFileDetail(node, true);
        if (facts.workActive() && !policy.fileSucceeded(node)) ports.invalidate(node, 'current file details prepared after work resumed');
      }
      if (current?.paintRetry) return;
      if (current?.applied && current.revision !== previousRevision) {
        usefulSyntax(node); ports.invalidate(node, 'prepared file presentation changed');
      } else if (current?.refused && !wasRefused) {
        ports.invalidate(node, 'file presentation funding refused');
      } else if (current && !current.paused) usefulSyntax(node);
      return;
    }
    const replacesFallback = unreflected && !sessions.hasCurrentDisplay(node) && cardKind(node) === 'bash';
    const current = observeSyntax(node);
    if (current && !current.paused) usefulSyntax(node);
    // The service rows can change without a paint notice, even while the command keeps its colors.
    if (replacesFallback && current?.applied && facts.workActive()) ports.invalidate(node, 'current Bash presentation reflected after work resumed');
  }
  function invalidated(node: Owner): void {
    const state = sessions.syntax(node); let owned: boolean | undefined;
    const accepted = cards()?.visit(node, (_display, paint) => { owned = paint.origin === 'owned'; });
    if (accepted && state) state.owned = owned;
    else if (state && filePresentationTool(node)) { state.applied = false; dropPrepared(node); }
  }
  function buildFileDetail(node: Owner, mode: 'preview' | 'full'): FileDetailDraft {
    const reader = toolReader(node);
    if (!reader || reader.kind === 'bash' || reader.succeeded && reader.kind !== 'read')
      return { text: '', omitted: false, error: false, pending: false };
    const detail = reader.pendingDetail(mode);
    return detail.pending || mode === 'preview' ? detail : { ...detail, sources: () => reader.errorSources() };
  }
  function prepareFileDetail(node: Owner, refreshContent = false): void {
    if (facts.active() && !facts.workActive()) { deferObservation(node); return; }
    if (!facts.active() || facts.quiescing() || !facts.attached(node) || policy.fileSucceeded(node) || fileMode(node) !== 'full') {
      fileDetails.drop(node); return;
    }
    ensureCards();
    fileDetails.prepare(node, 'full', buildFileDetail, refreshContent);
  }
  function observeFileTurn(node: Owner, finalize = false): void {
    if (!facts.active() || facts.quiescing() || !policy.fileTool(node) || !facts.attached(node)) return;
    filePreviewState.observe(node, fields.id(node));
    if (finalize && policy.fileSucceeded(node)) filePreviewState.finalize(node, fields.id(node));
  }
  function finishFileTurn(): void {
    if (!facts.active() || facts.quiescing()) return;
    const live = filePreviewState.candidates().filter(({ owner, toolCallId }) => facts.attached(owner) && fields.id(owner) === toolCallId);
    const previous = new Map(live.map(({ owner, toolCallId }) => [owner, filePreviewState.mode(owner, toolCallId, fields.expanded(owner))]));
    const successful = live.filter(({ owner }) => policy.fileSucceeded(owner));
    const completed = new Set(successful.filter(({ owner, toolCallId }) => policy.filePresentationEligible(owner)
      && filePreviewState.isCurrentSuccess(owner, toolCallId)).map(({ owner }) => owner));
    filePreviewState.finishTurn(successful);
    let changed = false;
    for (const { owner, toolCallId } of live) {
      if (!policy.filePresentationEligible(owner)) continue;
      const modeChanged = previous.get(owner) !== filePreviewState.mode(owner, toolCallId, fields.expanded(owner));
      if (modeChanged) { dropPrepared(owner); ports.forget(owner, 'file turn preview window changed'); }
      if (modeChanged || completed.has(owner)) { observeSyntax(owner); changed = true; }
    }
    if (changed) ports.requestRender();
  }
  function settleInterrupted(node: Owner): void {
    if (facts.workActive() && !facts.quiescing() && cards() && interruptedLiveBash(toolReader(node), liveBashSource(node))) {
      cards()!.freeze(node); ports.flush();
    }
  }
  return { seedFileState, observeSyntax, syntaxEligible, requestFilePreparation, observeFrame,
    unsupportedFullFile, pauseSyntax, usefulSyntax, observePalette, refusePreparedPresentation, refreshPalette,
    invalidated, prepareFileDetail, observeFileTurn, finishFileTurn, settleInterrupted };
}
