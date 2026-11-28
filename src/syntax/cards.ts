import type { TerminalColorMode } from '@earendil-works/pi-tui';
import { diagnose, type DiagnosticFields, type DiagnosticSink } from '../diagnostics.ts';
import { cardSourceKey as sourceKey } from '../cards/preparation.ts';
import type { FileChangeClass, PreparedFileCard } from '../cards/file-model.ts';
import { fileSources } from '../cards/file-sources.ts';
import { CONTROLLER_LIMITS } from '../highlighting/controller-limits.ts';
import type { CardSourcePort, GroupDisplayBasis, GroupDisplayMember } from '../highlighting/source-ports.ts';
import type { SourceWorkGroup } from '../highlighting/work-registry.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import { type DataCharge, type DataCleanupReceipt } from '../resources/data-budget.ts';
import { RETENTION_LIMITS } from '../highlighting/storage/retention.ts';
import { CARD_ROLES, type CardRole } from '../appearance/card-roles.ts';
import type { PreparedCard, ReadyCardPaint } from '../rendering/card-values.ts';
import { visitPreparedCard } from './card-read.ts';
import { bindCoverage, captureNative, capturePi, fund, matchingPrefixBytes, type Coverage, type NativeCoverage } from './card-coverage.ts';
import { beginDisplayBuild, displayEntry, reuseFileDescriptor, type BuiltDisplay, type DisplayEntry } from './card-display.ts';
import { compileCardStyles, type LiteralPaint } from '../rendering/card-styles.ts';
import type { PaletteInputLease, PiInputRead } from './pi-input.ts';
import { CardPaletteSelection, followPiPalette, groupKey, matchesLease } from './card-palette.ts';
import type { ThemeDescription } from '../themes/selection.ts';
import type { AnsiStyle } from '../appearance/style-ansi.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import { requestSyntax, resolveSyntax, type PiClassifier, type SyntaxIdentity, type SyntaxSourceClient, type SyntaxWorkResult } from './work.ts';

import type { CardDisplayInput } from '../cards/display-input.ts';
export type CardPreparation = { readonly update: string; readonly revision: number; readonly palette: number; readonly sourceEligible: boolean } & (
  { readonly phase: 'updated' } |
  { readonly phase: 'prepared'; readonly applied: boolean; readonly refused: number; readonly publication: number; readonly outcomes: readonly SyntaxWorkResult['outcome'][] }
);
export interface CardSourceHost<Owner extends object> {
  /** Cold acquisition only. The returned lease becomes this owner's responsibility. */
  preparePaletteInput?(palette: ThemeDescription, revision: number, mode: TerminalColorMode, funding: GeometryFunding, usePiFallback?: boolean): PaletteInputLease | undefined;
  classify: PiClassifier;
  invalidate(owner: Owner): void;
  requestRender(): void;
  diagnostic?: DiagnosticSink;
  identify?(owner: Owner): DiagnosticFields;
  /** Observes accepted inputs and actual preparation completion; never requests work. */
  preparation?(owner: Owner, receipt: CardPreparation): void;
}
type Slot = SyntaxIdentity & { outcome: SyntaxWorkResult['outcome'] };
const noSlots: ReadonlyMap<string, Slot> = new Map();
type Compiled = { charge: DataCharge; table: Map<ConcreteStyle, LiteralPaint>; roles: Record<CardRole, AnsiStyle>;
  groupStamp?: number; groupPaint?: number; rules?: string; native: ReadonlyMap<string, NativeCoverage>;
  pi: ReadonlyMap<string, Coverage>; holds: readonly DataCharge[]; palette: string; paletteRevision: number;
  publication: number; paintStamp: number; origin: 'owned' | 'pi'; mode: TerminalColorMode;
  token: string; effects: string; eligibility: string; signature: string };
type PaintTarget = { group?: GroupDisplayBasis; identity: string; isOwned: boolean; paletteReady: boolean;
  token: string; effects: string; eligibility: string };
type PaintAttempt = { charge?: DataCharge; holds: DataCharge[] };
type State = { input?: CardDisplayInput; revision: number; sourceRevision: number; serviceRevision: number;
  version: number; slots: ReadonlyMap<string, Slot>; sourceEligible?: boolean; display?: PreparedCard; file?: PreparedFileCard;
  paletteInput?: PaletteInputLease; paletteFallback?: string; paint?: Compiled; ticket?: RecordTicket; paused?: boolean; frozen?: boolean; expanded?: boolean;
  useful?: boolean; processed?: string; preparedTheme?: number; preparedPalette?: string; mutation: number; geometry: number; bashPrefix?: number };
type RecordTicket = { id: number; owner: WeakRef<object>; state: WeakRef<State>; keys: Set<string>; bytes: number;
  consumer: WeakRef<CardSources<object>>; prepare(): void; acceptsSelection(palette: string, rules: string): boolean;
  needsRefresh(newest: boolean): boolean; requiresCredit(): boolean; work?: SourceWorkGroup;
  measured: Set<DataCleanupReceipt>; descriptorCharge?: DataCharge; paletteCleanup?: DataCleanupReceipt; compiledCharge?: DataCharge; coverage?: readonly DataCharge[] };
type Release = { consumer: WeakRef<CardSources<object>>; sources: WeakRef<CardSourcePort>; ticket: RecordTicket };
let sequence = 0;
const collected = new FinalizationRegistry<Release>(release => {
  const consumer = release.consumer.deref();
  if (consumer) consumer.release(release.ticket);
  else { if (release.ticket.work) release.sources.deref()?.unregisterPreparation(release.ticket.work); releaseCardResources(release.ticket); }
});

// The weak ticket keeps accepted numeric holds, never their display payloads.
function releaseCardResources(ticket: RecordTicket): void {
  const { descriptorCharge, compiledCharge, paletteCleanup, measured, coverage } = ticket;
  ticket.descriptorCharge = ticket.compiledCharge = ticket.paletteCleanup = ticket.coverage = undefined;
  descriptorCharge?.release(); compiledCharge?.release(); paletteCleanup?.release();
  for (const charge of coverage ?? []) charge.release();
  for (const receipt of measured) receipt.release();
  measured.clear();
}
function prepareTicket(this: RecordTicket) { this.consumer.deref()?.prepare(this); }
function acceptsTicket(this: RecordTicket, palette: string, rules: string) { return this.consumer.deref()?.acceptsSelection(this, palette, rules) ?? false; }
function refreshTicket(this: RecordTicket, newest: boolean) { return this.consumer.deref()?.needsRefresh(this, newest) ?? false; }
function creditTicket(this: RecordTicket) { return this.consumer.deref()?.requiresCredit(this) ?? false; }
function renderNotice(owner: WeakRef<CardSources<object>>) { return () => owner.deref()?.renderPrepared(); }
const keyBytes = (key: string) => RETENTION_LIMITS.entryAllowance + 2 * key.length;
function wireHint(value: string | undefined, cap: number) {
  return value && value.length <= cap && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value) ? value : undefined;
}
function sourceStamp(input: CardDisplayInput) { return `${input.sourceRevision}:${input.kind === 'file' ? input.viewMode ?? 'full' : 'bash'}`; }
function inputBytes(input: CardDisplayInput) {
  return input.reader.estimateBytes({ mode: input.kind === 'file' ? input.viewMode ?? 'full' : undefined,
    cwd: input.kind === 'file' ? input.cwd : undefined, directory: input.kind === 'bash' ? input.directory : undefined,
    language: input.reader.language() });
}

/** Local prepared display and one weak controller registry entry per owner.
 * Host lifecycle updates establish first-frame display; useful only schedules. */
export interface SyntaxCardClient extends SyntaxSourceClient {
  readonly cardSource: CardSourcePort;
}

export class CardSources<Owner extends object> {
  private readonly owner = new WeakRef(this as unknown as CardSources<object>);
  private readonly states = new WeakMap<Owner, State>();
  private readonly records = new Map<number, RecordTicket>();
  private readonly keys = new Map<string, RecordTicket>();
  private readonly groups = new Map<number, RecordTicket>();
  private bytes = 0;
  private readonly maxBytes: number;
  private disposed = false;
  private readonly paletteSelection: CardPaletteSelection;
  private publication = 0;
  private renderScheduled = false;
  private readonly client: SyntaxCardClient;
  private readonly host: CardSourceHost<Owner>;
  constructor(client: SyntaxCardClient, host: CardSourceHost<Owner>,
    options: { maxBookkeepingBytes?: number } = {}) {
    this.client = client; this.host = host;
    this.paletteSelection = new CardPaletteSelection(client.cardSource);
    this.maxBytes = options.maxBookkeepingBytes ?? CONTROLLER_LIMITS.bookkeepingBytes;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < RETENTION_LIMITS.entryAllowance || this.maxBytes > CONTROLLER_LIMITS.bookkeepingBytes)
      throw new Error('invalid card bookkeeping allowance');
    this.metadataChanged();
  }
  private register(owner: Owner, state: State): RecordTicket | undefined {
    if (state.ticket) return state.ticket;
    if (this.bytes + RETENTION_LIMITS.entryAllowance > this.maxBytes) return undefined;
    const ticket: RecordTicket = { id: ++sequence, owner: new WeakRef(owner), state: new WeakRef(state), keys: new Set(), bytes: RETENTION_LIMITS.entryAllowance,
      consumer: this.owner, prepare: prepareTicket, acceptsSelection: acceptsTicket, needsRefresh: refreshTicket, requiresCredit: creditTicket, measured: new Set() };
    ticket.work = this.client.cardSource.registerPreparation(ticket); if (!ticket.work) return undefined;
    state.ticket = ticket; this.records.set(ticket.id, ticket); this.groups.set(ticket.work.id, ticket); this.bytes += ticket.bytes;
    collected.register(owner, { consumer: this.owner, sources: new WeakRef(this.client.cardSource), ticket }, ticket);
    this.client.cardSource.pausePreparation(ticket.work);
    this.client.cardSource.updatePreparation(ticket.work);
    return ticket;
  }
  /** Explicit cold lifecycle boundary. Never call from render. */
  updateDisplay(owner: Owner, input: CardDisplayInput, observeChange?: (value: FileChangeClass | null) => void): boolean {
    if (this.disposed || !this.client.cardSource.active) return false;
    let state = this.states.get(owner);
    if (!state) {
      state = { revision: -1, sourceRevision: -1, serviceRevision: -1, version: 0, slots: noSlots, mutation: 0, geometry: 0 };
      this.states.set(owner, state);
    }
    const ticket = this.register(owner, state);
    if (!ticket?.work) return false;
    const entry = displayEntry(state, input);
    if (entry.refresh && !observeChange) return this.refreshUnchangedDisplay(owner, state, ticket, input, entry.refreshInput);
    return this.replaceDisplay(owner, state, ticket, input, entry, observeChange);
  }

  private refreshUnchangedDisplay(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput, replaceInput: boolean): boolean {
    if (replaceInput) state.input = input;
    if (input.kind === 'file') {
      const mutation = state.mutation, funding = this.client.cardSource.geometryFunding(ticket.work);
      if (funding) this.reconcileSelection(state, funding);
      if (!this.owned(owner, state, ticket) || state.mutation !== mutation) return false;
    }
    this.refreshPaint(owner, state);
    return true;
  }

  private replaceDisplay(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput, entry: DisplayEntry,
    observeChange?: (value: FileChangeClass | null) => void): boolean {
    const funding = this.client.cardSource.geometryFunding(ticket.work);
    if (!funding) return this.refuseDisplay(owner, state, ticket, input, entry);
    const reuse = reuseFileDescriptor(state, input, entry);
    const sourceChanged = state.sourceRevision !== input.sourceRevision || entry.previousView !== entry.nextView;
    const completed = input.kind === 'bash' && input.complete && state.input?.kind === 'bash' && !state.input.complete;
    const mutation = ++state.mutation;
    const charge = reuse ? undefined : fund(funding, inputBytes(input));
    if (!charge && !reuse) return this.refuseDisplay(owner, state, ticket, input, entry);
    let change: FileChangeClass | null | undefined;
    const operation = beginDisplayBuild(funding, ticket.id, () => ++state.geometry,
      observeChange ? value => { change = value; } : undefined);
    try {
      const built = operation.build(input, state, entry);
      if (change !== undefined && this.client.cardSource.active && this.owned(owner, state, ticket) && state.mutation === mutation)
        observeChange?.(change);
      if (!built) {
        if (this.owned(owner, state, ticket) && state.mutation === mutation) this.refuseDisplay(owner, state, ticket, input, entry);
        return false;
      }
      if (!this.client.cardSource.active || !this.owned(owner, state, ticket) || state.mutation !== mutation) return false;
      const measured = built.adoptMeasurements(ticket.measured);
      if (!measured) return false;
      ticket.measured = measured;
      if (charge) {
        ticket.descriptorCharge?.release(); ticket.descriptorCharge = charge.retain();
      }
      this.installDisplay(state, input, entry.expanded, built, sourceChanged);
      this.reconcileSelection(state, funding);
      if (!this.owned(owner, state, ticket) || state.mutation !== mutation) return false;
      this.finishDisplayUpdate(owner, state, ticket, input, sourceChanged || completed);
      return true;
    } finally {
      try { operation.dispose(); }
      finally { charge?.release(); }
    }
  }

  private finishDisplayUpdate(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput, changedSource: boolean): void {
    this.refreshPaint(owner, state);
    if (state.useful && !state.paused && !state.frozen && input.kind === 'bash' && input.complete && changedSource) this.enqueue(ticket, true);
    if (this.owned(owner, state, ticket) && state.input === input) this.observePreparation(owner, state, 'updated');
  }

  private refuseDisplay(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput, entry: DisplayEntry): false {
    if (input.kind === 'file' && entry.nextView === 'preview' && entry.previousView === 'full' && state.input?.kind === 'file')
      this.discardFileDisplay(owner, state, ticket, input.revision);
    return false;
  }

  private installDisplay(state: State, input: CardDisplayInput, expanded: boolean, built: BuiltDisplay, sourceChanged: boolean): void {
    state.display = built.display; state.file = built.file; state.input = input; state.expanded = expanded;
    state.sourceEligible = input.kind === 'bash' ? built.bashSourceEligible ?? state.sourceEligible : !!built.file && !input.reader.failed;
    if (sourceChanged) { state.version++; this.updateBashPrefix(state); }
    state.sourceRevision = input.sourceRevision; state.serviceRevision = input.serviceRevision; state.revision = input.revision;
  }
  useful(owner: Owner, revision: number): void {
    const state = this.states.get(owner), ticket = state?.ticket;
    if (!state || !ticket || this.disposed || !this.client.cardSource.active || state.revision !== revision) return;
    if (state.frozen && !state.slots.size) return;
    const resumed = state.paused;
    state.paused = false;
    if (state.frozen) {
      if (!resumed && state.useful && state.input && this.selectionConsidered(state, state.input)) return;
      state.useful = true; this.enqueue(ticket, true); return;
    }
    if (!resumed && state.useful && state.input && state.processed === sourceStamp(state.input) && this.selectionConsidered(state, state.input)) return;
    state.useful = true; this.enqueue(ticket, state.processed !== undefined && (state.processed !== sourceStamp(state.input!)
      || !!state.input && !this.inputConsidered(state, state.input)));
  }
  private reconcileSelection(state: State, funding: GeometryFunding): void {
    const ticket = state.ticket, input = state.input;
    if (!ticket || !input || !this.client.cardSource.active) return;
    const selection = this.paletteSelection, requested = selection.requested;
    const requestedKey = selection.inputKey(requested, input);
    if (state.paletteFallback && state.paletteFallback !== requestedKey) state.paletteFallback = undefined;
    let palette = selection.effective(input, state.paletteFallback), identity = groupKey(palette, input);
    if (!matchesLease(state.paletteInput, palette, input)) {
      const previous = state.paint;
      const retainPrevious = !!previous?.native.size || previous?.origin === 'owned';
      const candidate = this.host.preparePaletteInput?.(requested, input.palette, input.mode, funding, !retainPrevious);
      if (!this.canAdoptPalette(state, ticket, input)) { candidate?.cleanupReceipt().release(); return; }
      if (candidate) {
        if (requested.kind === 'theme' && candidate.paletteId === 'pi') {
          state.paletteFallback = requestedKey;
          palette = followPiPalette(); identity = groupKey(palette, input);
        }
        const old = ticket.paletteCleanup;
        state.paletteInput = candidate; ticket.paletteCleanup = candidate.cleanupReceipt();
        old?.release();
      }
    }
    selection.bind(state.paletteInput, palette, input, identity, funding);
  }

  private canAdoptPalette(state: State, ticket: RecordTicket, input: CardDisplayInput): boolean {
    return !this.disposed && this.client.cardSource.active && state.ticket === ticket && state.input === input && this.records.get(ticket.id) === ticket;
  }

  acceptsSelection(ticket: RecordTicket, palette: string, rules: string): boolean {
    const state = ticket.state.deref();
    if (this.disposed || !state?.input || this.records.get(ticket.id) !== ticket) return false;
    return this.paletteSelection.accepts(palette, rules)
      && palette === groupKey(this.paletteSelection.effective(state.input, state.paletteFallback), state.input);
  }

  requiresCredit(ticket?: RecordTicket): boolean {
    const state = ticket?.state.deref(), palette = this.paletteSelection.effective(state?.input, state?.paletteFallback);
    if (state?.processed !== undefined && state.processed === sourceStamp(state.input!) && ticket?.work
      && state.input && this.client.cardSource.groupPresentation(ticket.work)?.palette === groupKey(palette, state.input)) return false;
    return this.paletteSelection.enabled && this.paletteSelection.providerReady;
  }
  needsRefresh(ticket: RecordTicket, newest: boolean): boolean {
    const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
    if (!owner || !state) { this.release(ticket); return false; }
    if (!this.current(owner, state, ticket) || !state.useful) return false;
    if (state.frozen) return !this.selectionConsidered(state, state.input!);
    if (state.processed !== sourceStamp(state.input!) || !this.selectionConsidered(state, state.input!)) return true;
    for (const slot of state.slots.values()) {
      if (slot.fallback === 'pi' && (newest || slot.outcome === 'waiting') && !this.retainedPi(state, state.input!, slot)
        && resolveSyntax(this.client.sourceWork, this.client.pi, slot).needsPi) return true;
      // Every eligible Pi FILE needs its first native SOURCE; retained semantic
      // SOURCE on compatible recovery must not be reclassified.
      if (state.input?.kind === 'file' && slot.outcome === 'pi' && !this.client.cardSource.borrowSource(slot.key)
        && this.client.cardSource.workStatus(slot.key).fallbackEligible && this.requiresCredit()) return true;
    }
    return false;
  }
  metadataChanged(paletteRevision?: number): void {
    if (this.disposed || !this.paletteSelection.sync(this.client.snapshot(), paletteRevision)) return;
    const enabled = this.paletteSelection.enabled;
    if (paletteRevision !== undefined || !enabled) for (const ticket of this.records.values()) {
      const state = ticket.state.deref();
      if (!state?.input) continue;
      if (paletteRevision !== undefined && state.input.palette !== paletteRevision) {
        state.input = { ...state.input, palette: paletteRevision };
        state.mutation++;
      }
      if (!enabled && state.paint?.native.size) {
        const owner = ticket.owner.deref() as Owner | undefined;
        if (owner && this.owned(owner, state, ticket)) this.withdrawNativePaint(owner, state, ticket);
      }
    }
    this.client.cardSource.refreshPreparations();
  }
  sourceChanged(keys: readonly string[], groups: readonly number[] = []): void {
    if (this.disposed) return;
    const affected = new Set<RecordTicket>();
    for (const key of keys) { const t = this.keys.get(key); if (t) affected.add(t); }
    for (const id of groups) { const t = this.groups.get(id); if (t) affected.add(t); }
    for (const ticket of affected) {
      const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
      if (!owner || !state) { this.release(ticket); continue; }
      if (!this.owned(owner, state, ticket)) continue;
      this.refreshPaint(owner, state);
      if (this.needsPiAfterSourceChange(state)) this.enqueue(ticket, true);
    }
  }

  private needsPiAfterSourceChange(state: State): boolean {
    if (state.paused || state.frozen || !state.useful || !state.input || state.paint?.origin === 'owned') return false;
    for (const slot of state.slots.values()) if (!this.retainedPi(state, state.input, slot)
      && !this.nativeForCurrentFile(state, slot) && resolveSyntax(this.client.sourceWork, this.client.pi, slot).needsPi) return true;
    return false;
  }

  prepare(ticket: RecordTicket): void {
    const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
    if (!owner || !state) { this.release(ticket); return; }
    if (!this.current(owner, state, ticket) || !state.useful || !state.input || !state.display || !ticket.work) return;
    const input = state.input, mutation = state.mutation, funding = this.client.cardSource.geometryFunding(ticket.work);
    if (!funding) return;
    this.reconcileSelection(state, funding);
    if (!this.current(owner, state, ticket) || state.mutation !== mutation) return;
    if (this.refreshWithoutSources(owner, state, ticket, input)) return;
    this.prepareSourceBatch(owner, state, ticket, input, mutation, funding);
  }

  private refreshWithoutSources(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput): boolean {
    // Freeze ends SOURCE authority, not retained-scope STYLE/local binding work.
    if (state.frozen) this.markConsideredSelection(state, input);
    else if (!this.preparedGroupIsCurrent(state, input, ticket.work!)) {
      if (state.sourceEligible || !ticket.keys.size) return false;
      this.pause(owner);
    }
    this.refreshPaint(owner, state);
    return true;
  }

  private preparedGroupIsCurrent(state: State, input: CardDisplayInput, group: SourceWorkGroup): boolean {
    return state.processed === sourceStamp(state.input!) && state.preparedTheme === this.paletteSelection.revision
      && [...state.slots.values()].every(slot => input.kind === 'file' || slot.complete === input.complete)
      && this.inputConsidered(state, input) && !!this.client.cardSource.groupPresentation(group);
  }

  private sourceScratch(state: State, input: CardDisplayInput): number {
    const display = state.display!;
    if (input.kind === 'bash' && display.kind === 'bash') return 1024 + display.command.text.length * 2;
    return 1024 + (state.file?.view.lines.reduce((n, line) => n + (line.kind === 'gap' ? 0 : line.logical.length * 2 + 128), 0) ?? 0);
  }

  private prepareSourceBatch(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput,
    mutation: number, funding: GeometryFunding): void {
    const scratch = fund(funding, this.sourceScratch(state, input));
    if (!scratch) return;
    try {
      const demands = this.sourceDemands(state, input), slots = new Map<string, Slot>();
      const palette = this.paletteSelection.effective(state.input, state.paletteFallback);
      const lease = state.paletteInput;
      const piFallback = input.kind === 'file' && palette.kind === 'pi' && !!state.input && !!lease?.isValid
        && matchesLease(lease, palette, state.input);
      let refused = 0;
      for (let index = 0; index < demands.length; index++) {
        const key = sourceKey(ticket.id, index);
        if (!this.admitKey(ticket, key)) { refused++; continue; }
        const demand = demands[index]!;
        const slot = this.makeSlot(key, input, state, demand.languageHint, piFallback);
        slots.set(key, slot);
        this.requestSlot(owner, state, input, slot, demand.text, piFallback, funding);
        if (!this.current(owner, state, ticket) || state.mutation !== mutation) {
          if (!this.owned(owner, state, ticket)) this.removeAttemptedSlots(slots);
          return;
        }
      }
      this.commitSlots(owner, state, ticket, input, slots, mutation, refused);
    } finally { scratch.release(); }
  }

  private sourceDemands(state: State, input: CardDisplayInput): readonly { text: string; languageHint?: string }[] {
    const display = state.display!;
    if (state.sourceEligible && input.kind === 'bash' && display.kind === 'bash') return [{ text: display.command.text }];
    return state.file && input.kind === 'file' && !input.reader.failed ? fileSources(state.file.view) : [];
  }

  private admitKey(ticket: RecordTicket, key: string): boolean {
    if (ticket.keys.has(key)) return true;
    const bytes = keyBytes(key);
    if (this.bytes + bytes > this.maxBytes) return false;
    ticket.keys.add(key); this.keys.set(key, ticket); this.bytes += bytes; ticket.bytes += bytes;
    return true;
  }

  private makeSlot(key: string, input: CardDisplayInput, state: State, hint: string | undefined, piFallback: boolean): Slot {
    const language = wireHint(input.kind === 'bash' ? input.reader.language() : hint, 128);
    const piLanguage = input.kind === 'file' ? wireHint(input.reader.language(), 128) : undefined;
    return { key, version: state.version, language, piLanguage, complete: input.kind === 'file' || input.complete,
      palette: input.palette, fallback: piFallback ? 'pi' : 'neutral', outcome: 'refused' };
  }

  private requestSlot(owner: Owner, state: State, input: CardDisplayInput, slot: Slot, text: string, piFallback: boolean, funding: GeometryFunding): void {
    const demand = { ...slot, text, path: wireHint(state.file?.path, 4096), neutral: input.kind === 'bash' ? 'title' as const : 'code' as const };
    if (input.kind === 'file' && piFallback && state.paletteInput) state.paletteInput.visit(read => {
      Object.assign(slot, requestSyntax(this.client, { ...demand, fallback: 'pi', piNeutral: read.roles.code }, this.host.classify));
    }, funding.grant);
    else Object.assign(slot, requestSyntax(this.client, { ...demand, fallback: 'neutral' }, this.host.classify));
    const status = this.client.cardSource.workStatus(slot.key);
    this.log(owner, 'Syntax work evaluated outside render', { source: slot.key, version: slot.version, units: text.length,
      language: slot.language ?? 'unknown', palette: slot.palette, outcome: slot.outcome,
      execution: status.execution, fallbackEligible: status.fallbackEligible });
  }

  private removeAttemptedSlots(slots: ReadonlyMap<string, Slot>): void {
    // A reentrant capture may finish after unregister. Never delete keys of a still-live incarnation.
    for (const slot of slots.values()) this.client.cardSource.remove(slot.key);
  }

  private commitSlots(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput,
    slots: Map<string, Slot>, mutation: number, refused: number): void {
    for (const key of ticket.keys) if (!slots.has(key)) {
      ticket.keys.delete(key); this.keys.delete(key); this.client.cardSource.remove(key);
      const bytes = keyBytes(key); ticket.bytes -= bytes; this.bytes -= bytes;
    }
    state.slots = slots;
    state.processed = sourceStamp(input);
    this.markConsideredSelection(state, input);
    this.client.cardSource.updatePreparation(ticket.work!);
    const applied = this.refreshPaint(owner, state);
    this.log(owner, 'Prepared source demand evaluated outside render', { sources: slots.size, version: state.version, revision: state.revision });
    if (this.current(owner, state, ticket) && state.mutation === mutation) this.observePreparation(owner, state, 'prepared', applied, refused);
  }

  private consideredInputKey(state: State, input: CardDisplayInput): string {
    const selection = this.paletteSelection;
    return selection.inputKey(selection.effective(state.input, state.paletteFallback), input);
  }

  private inputConsidered(state: State, input: CardDisplayInput): boolean {
    return state.preparedPalette === this.consideredInputKey(state, input);
  }

  private selectionConsidered(state: State, input: CardDisplayInput): boolean {
    return state.preparedTheme === this.paletteSelection.revision && this.inputConsidered(state, input);
  }

  private markConsideredSelection(state: State, input: CardDisplayInput): void {
    state.preparedTheme = this.paletteSelection.revision;
    state.preparedPalette = this.consideredInputKey(state, input);
  }

  private refreshPaint(owner: Owner, state: State): boolean {
    const ticket = state.ticket, input = state.input;
    if (!ticket?.work || !input || !this.client.cardSource.active) return false;
    const funding = this.client.cardSource.geometryFunding(ticket.work);
    if (!funding) return false;
    const target = this.paintTarget(state, input, ticket.work);
    if (state.paint?.token === target.token) return true;
    const previous = state.paint, mutation = state.mutation;
    if (this.keepPreviousPaint(state, input, previous, target)) return true;
    return this.replacePaint(owner, state, ticket, input, previous, mutation, target, funding);
  }

  private withdrawNativePaint(owner: Owner, state: State, ticket: RecordTicket): void {
    const old = state.paint!;
    const publication = ++this.publication;
    state.paint = { ...old, groupStamp: undefined, groupPaint: undefined, rules: undefined,
      native: new Map(), pi: new Map(), holds: [], table: new Map(), token: '', publication, paintStamp: publication };
    state.bashPrefix = undefined;
    ticket.coverage = undefined;
    for (const charge of old.holds) charge.release();
    if (!state.paused) this.invalidatePrepared(owner);
  }

  private nativeForCurrentFile(state: State, slot: Slot): boolean {
    return state.input?.kind === 'file' && state.paint?.native.get(slot.key)?.version === state.version
      && state.paint.paletteRevision === state.input.palette;
  }

  private updateBashPrefix(state: State): void {
    const text = state.display?.kind === 'bash' && state.paint?.native.values().next().value?.text;
    state.bashPrefix = typeof text === 'string' && state.display?.kind === 'bash'
      ? matchingPrefixBytes(text, state.display.command.text) : undefined;
  }

  private paintTarget(state: State, input: CardDisplayInput, work: SourceWorkGroup): PaintTarget {
    const selected = this.paletteSelection.effective(state.input, state.paletteFallback), identity = groupKey(selected, input);
    const available = this.client.cardSource.groupPresentation(work);
    const group = available?.palette === identity ? available : undefined;
    const isOwned = selected.kind === 'theme', paletteReady = matchesLease(state.paletteInput, selected, input);
    const previous = state.paint;
    const keptNative = this.paletteSelection.enabled && !!previous?.native.size;
    const publication = group?.stamp ?? (keptNative ? previous.groupStamp : undefined) ?? -(input.palette + 1);
    const effects = isOwned || group || keptNative && previous?.pi.size === 0
      ? `${input.mode}:` : this.paintEffects(state, input), eligibility = this.fileEligibility(state, input);
    return { group, identity, isOwned, paletteReady, effects, eligibility, token: `${identity}:${publication}:${effects}:${eligibility}` };
  }

  private retainedPi(state: State, input: CardDisplayInput, slot: Slot): Coverage | undefined {
    const previous = state.paint, coverage = previous?.pi.get(slot.key);
    if (coverage?.version === state.version && previous?.paletteRevision === input.palette) return coverage;
  }

  private paintEffects(state: State, input: CardDisplayInput): string {
    const effects = Array.from(state.slots.values(), slot => {
      if (slot.version !== state.version || slot.palette !== input.palette) return '';
      const projection = this.client.pi.piProjection(slot.key, slot.version, slot.palette);
      return projection ? `${projection.generation}/${projection.revision}/${projection.palette}` : this.retainedPi(state, input, slot)?.effect ?? '';
    });
    return `${input.mode}:${effects.filter(Boolean).join(',')}`;
  }

  private fileEligibility(state: State, input: CardDisplayInput): string {
    if (input.kind !== 'file') return '';
    return `${state.version}:${Array.from(state.slots.values(), slot => `${slot.key}/${slot.version}/${slot.version === state.version ? 1 : 0}`).join(',')}`;
  }

  private keepPreviousPaint(state: State, input: CardDisplayInput, previous: Compiled | undefined, target: PaintTarget): boolean {
    if (!previous) return false;
    const { group, paletteReady, identity } = target;
    if (!this.paletteSelection.enabled && previous.native.size) return false;
    if (state.paused && group && group.stamp !== previous.groupStamp) return true;
    return !group && !paletteReady && (previous.palette !== identity || previous.paletteRevision !== input.palette || previous.mode !== input.mode);
  }

  private replacePaint(owner: Owner, state: State, ticket: RecordTicket, input: CardDisplayInput, previous: Compiled | undefined,
    mutation: number, target: PaintTarget, funding: GeometryFunding): boolean {
    previous?.charge.retain();
    for (const charge of previous?.holds ?? []) charge.retain();
    let scratch: DataCharge | undefined;
    const attempt: PaintAttempt = { holds: [] };
    try {
      scratch = fund(funding, 4096);
      if (!scratch) return false;
      const next = this.buildTerminalPaint(state, input, previous, target, funding, attempt);
      if (!next || !this.client.cardSource.active || !this.owned(owner, state, ticket) || state.mutation !== mutation || state.input !== input || state.paint !== previous) return false;
      ticket.compiledCharge?.release(); ticket.compiledCharge = next.charge;
      for (const charge of ticket.coverage ?? []) charge.release();
      ticket.coverage = next.holds;
      state.paint = next; attempt.charge = undefined; attempt.holds = [];
      if (input.kind === 'bash' && previous?.native.values().next().value?.text !== next.native.values().next().value?.text)
        this.updateBashPrefix(state);
      if (previous && previous.paintStamp !== next.paintStamp && !state.paused) this.invalidatePrepared(owner);
      return true;
    } finally {
      attempt.charge?.release(); scratch?.release(); previous?.charge.release();
      for (const charge of attempt.holds) charge.release();
      for (const charge of previous?.holds ?? []) charge.release();
    }
  }

  private buildTerminalPaint(state: State, input: CardDisplayInput, previous: Compiled | undefined, target: PaintTarget,
    funding: GeometryFunding, attempt: PaintAttempt): Compiled | undefined {
    if (!target.paletteReady) return;
    let result: Compiled | undefined;
    const valid = state.paletteInput?.visit(read => {
      const compile = (member?: (key: string) => GroupDisplayMember | undefined) => {
        result = this.compileTerminalPaint(state, input, previous, target, funding, attempt, read, member);
      };
      if (!target.group) compile();
      else if (!target.group.visit(compile)) result = undefined;
    }, funding.grant);
    if (valid) return result;
  }

  private buildCoverage(state: State, input: CardDisplayInput, previous: Compiled | undefined, target: PaintTarget,
    funding: GeometryFunding, attempt: PaintAttempt, read: PiInputRead, member?: (key: string) => GroupDisplayMember | undefined) {
    const native = new Map<string, NativeCoverage>(), pi = new Map<string, Coverage>();
    const bash = input.kind === 'bash';
    const reuseNative = this.paletteSelection.enabled && previous?.rules && this.paletteSelection.accepts(target.identity, previous.rules);
    for (const slot of state.slots.values()) {
      if (!bash && slot.version !== state.version) continue;
      const published = member?.(slot.key), basis = published && this.client.cardSource.displayBasis(slot.key);
      if (basis && published.generation === basis.generation && published.version === basis.version && published.stamp === basis.stamp
        && basis.language === slot.language && (bash || basis.complete && (basis.version === slot.version || basis.exactVersion === slot.version))) {
        const coverage = captureNative(basis, read, bash, slot.version, funding);
        if (!coverage) return;
        attempt.holds.push(coverage.charge); native.set(slot.key, coverage); continue;
      }
      const oldNative = reuseNative ? previous!.native.get(slot.key) : undefined;
      if (oldNative && (bash || oldNative.version === slot.version)) {
        const rebind = previous!.palette !== target.identity || previous!.paletteRevision !== input.palette;
        const bindingCharge = rebind ? fund(funding, oldNative.expressions.length * 320) : oldNative.bindingCharge?.retain();
        if (bindingCharge) attempt.holds.push(bindingCharge);
        if (rebind && (!bindingCharge || !read.isValid)) return;
        attempt.holds.push(oldNative.charge.retain());
        native.set(slot.key, rebind ? { ...oldNative, bindingCharge, literals: bindCoverage(oldNative.expressions, read, bash) } : oldNative);
        continue;
      }
      if (bash || target.isOwned || slot.palette !== input.palette) continue;
      const projection = this.client.pi.piProjection(slot.key, slot.version, slot.palette);
      const oldPi = this.retainedPi(state, input, slot);
      if (projection && oldPi?.effect !== `${projection.generation}/${projection.revision}/${projection.palette}`) {
        const coverage = capturePi(projection, funding);
        if (!coverage) return;
        attempt.holds.push(coverage.charge); pi.set(slot.key, coverage);
      } else if (oldPi) {
        attempt.holds.push(oldPi.charge.retain()); pi.set(slot.key, oldPi);
      }
    }
    if (read.isValid) return { native, pi };
  }

  private compileTerminalPaint(state: State, input: CardDisplayInput, previous: Compiled | undefined, target: PaintTarget,
    funding: GeometryFunding, attempt: PaintAttempt, read: PiInputRead, member?: (key: string) => GroupDisplayMember | undefined): Compiled | undefined {
    const coverage = this.buildCoverage(state, input, previous, target, funding, attempt, read, member);
    if (!coverage) return;
    const roles = target.group ? groupRoles(target.group) : read.roles;
    if (!roles) return;
    const stage = compileCardStyles(roles, consume => {
      for (const role of CARD_ROLES) consume(roles[role]);
      for (const member of coverage.native.values()) for (const style of member.literals) consume(style, true);
      for (const member of coverage.pi.values()) for (const style of member.literals) consume(style);
      return read.isValid;
    }, input.mode, count => this.fundTerminalPaint(funding, attempt, count, state.slots.size), target.group ? undefined : read.compiledRoles);
    if (!stage) return;
    const signature = CARD_ROLES.map(role => stage.roles[role].open).join('|');
    const publication = ++this.publication;
    const { group, identity, isOwned, token, effects, eligibility } = target;
    const groupStamp = group?.stamp ?? (coverage.native.size ? previous?.groupStamp : undefined);
    const groupPaint = group?.paintStamp ?? (coverage.native.size ? previous?.groupPaint : undefined);
    const same = previous && samePaintEffects(previous, target, signature, groupPaint);
    return { charge: stage.charge, holds: attempt.holds, table: stage.table, roles: Object.freeze(stage.roles), ...coverage,
      groupStamp, groupPaint, rules: group?.rules ?? (coverage.native.size ? previous?.rules : undefined), palette: identity,
      paletteRevision: input.palette, publication, paintStamp: same ? previous.paintStamp : publication,
      origin: isOwned ? 'owned' : 'pi', mode: input.mode, token, effects, eligibility, signature };
  }
  private fundTerminalPaint(funding: GeometryFunding, attempt: PaintAttempt, styles: number, slots: number): DataCharge | undefined {
    const total = 4096 + styles * 2560 + slots * 512;
    const grant = funding.grant(total);
    if (!grant) return;
    try {
      if (grant.budget !== funding.budget) throw new Error('foreign card funding');
      // Off keeps one normal style per role, not the range lookup or its diff variants.
      const roles = 4096 + CARD_ROLES.length * (2560 / 4);
      attempt.charge = grant.consume(roles);
      attempt.holds.push(grant.consume(total - roles));
      return attempt.charge;
    } finally { grant.close(); }
  }

  /** One synchronous provisional borrow; never prepares display or paint. */
  visit(owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void): boolean {
    const state = this.states.get(owner);
    if (this.disposed || !state) return false;
    const mutation = state.mutation, paint = state.paint;
    return visitPreparedCard(state,
      () => !this.disposed && this.states.get(owner) === state && state.mutation === mutation && state.paint === paint, consume);
  }
  filePreparationOutcome(owner: Owner): 'supported' | 'unsupported' | undefined {
    const state = this.states.get(owner);
    if (!state?.ticket?.descriptorCharge || state.input?.kind !== 'file' || state.display?.kind !== 'file') return;
    return state.file ? 'supported' : 'unsupported';
  }
  displayStamp(owner: Owner): number { return this.states.get(owner)?.paint?.paintStamp ?? 0; }
  identities(owner: Owner): SyntaxIdentity[] { const state = this.states.get(owner);
    return state ? Array.from(state.slots.values(), ({ key, version, language, piLanguage, complete, palette, fallback }) => ({ key, version, language, piLanguage, complete, palette, fallback })) : []; }
  freeze(owner: Owner): void { const s = this.states.get(owner); if (!s || s.frozen) return; s.frozen = true;
    for (const slot of s.slots.values()) this.client.cardSource.freeze(slot.key); }
  pause(owner: Owner): void { const s = this.states.get(owner); if (!s) return; s.paused = true; if (s.ticket?.work) this.client.cardSource.pausePreparation(s.ticket.work); }
  /** Release a file's derived display while preserving its ticket and per-key execution authority. */
  discardFile(owner: Owner): void {
    const state = this.states.get(owner), ticket = state?.ticket;
    if (state?.input?.kind === 'file' && ticket) this.discardFileDisplay(owner, state, ticket, state.revision);
  }
  remove(owner: Owner): void { const s = this.states.get(owner); this.states.delete(owner); if (s?.ticket) this.release(s.ticket); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const t of this.records.values()) this.release(t); }
  release(ticket: RecordTicket): void {
    if (!this.records.delete(ticket.id)) return;
    collected.unregister(ticket); if (ticket.work) { this.groups.delete(ticket.work.id); this.client.cardSource.unregisterPreparation(ticket.work); }
    for (const key of ticket.keys) this.keys.delete(key); ticket.keys.clear(); this.bytes -= ticket.bytes;
    releaseCardResources(ticket);
    const s = ticket.state.deref(); if (s) { s.mutation++; s.ticket = undefined; s.display = s.file = s.input = s.paint = s.paletteInput = undefined; s.slots = noSlots; }
  }
  private discardFileDisplay(owner: Owner, state: State, ticket: RecordTicket, revision: number): void {
    if (!this.owned(owner, state, ticket) || state.input?.kind !== 'file') return;
    state.mutation++;
    if (ticket.work) this.client.cardSource.pausePreparation(ticket.work);
    releaseCardResources(ticket);
    state.display = state.file = state.input = state.paint = state.paletteInput = undefined;
    state.sourceEligible = false; state.paused = true; state.useful = false; state.processed = undefined;
    state.preparedTheme = state.preparedPalette = state.paletteFallback = undefined;
    state.expanded = false; state.revision = revision;
    this.invalidatePrepared(owner);
  }
  private owned(owner: Owner, state: State, ticket: RecordTicket): boolean { return !this.disposed && this.states.get(owner) === state && this.records.get(ticket.id) === ticket; }
  private current(owner: Owner, state: State, ticket: RecordTicket): boolean { return this.client.cardSource.active && this.owned(owner, state, ticket) && !state.paused; }
  private enqueue(ticket: RecordTicket, local = false): void { if (ticket.work && this.records.has(ticket.id)) this.client.cardSource.queuePreparation(ticket.work, local); }
  private invalidatePrepared(owner: Owner): void { this.host.invalidate(owner); if (!this.disposed && !this.renderScheduled) { this.renderScheduled = true; queueMicrotask(renderNotice(this.owner)); } }
  renderPrepared(): void { this.renderScheduled = false; if (!this.disposed) this.host.requestRender(); }
  private observePreparation(owner: Owner, state: State, phase: CardPreparation['phase'], applied = false, refused = 0): void {
    if (!this.host.preparation || !state.input || !state.ticket) return;
    const input = state.input, update = `${state.ticket.id}:${state.sourceRevision}:${input.palette}`;
    const sourceEligible = state.sourceEligible === true;
    const receipt: CardPreparation = phase === 'updated' ? { phase, update, revision: input.revision, palette: input.palette, sourceEligible }
      : { phase, update, revision: input.revision, palette: input.palette, sourceEligible, applied, refused, publication: state.paint?.publication ?? 0,
        outcomes: Array.from(state.slots.values(), slot => slot.outcome) };
    try { this.host.preparation(owner, receipt); }
    catch { this.log(owner, 'Card preparation observer failed', {}); }
  }
  private log(owner: Owner, explanation: string, fields: DiagnosticFields): void {
    if (this.host.diagnostic) try { diagnose(this.host.diagnostic, 'DEBUG', 'syntax', explanation, { ...this.host.identify?.(owner), ...fields }); } catch { /* Observers do not own work. */ }
  }
}

function groupRoles(group: GroupDisplayBasis): Readonly<Record<CardRole, ConcreteStyle>> | undefined {
  const roles = {} as Record<CardRole, ConcreteStyle>;
  for (const role of CARD_ROLES) {
    const style = group.role(role); if (!style) return;
    roles[role] = style;
  }
  return roles;
}

function samePaintEffects(previous: Compiled, target: PaintTarget, signature: string, groupPaint: number | undefined): boolean {
  return signature === previous.signature && groupPaint === previous.groupPaint && previous.palette === target.identity
    && (target.isOwned || target.effects === previous.effects) && target.eligibility === previous.eligibility;
}
