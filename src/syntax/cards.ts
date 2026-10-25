import type { TerminalColorMode } from '@earendil-works/pi-tui';
import { diagnose, type DiagnosticFields, type DiagnosticSink } from '../diagnostics.ts';
import { bashCommandSource, prepareBashService, type BashPresentation } from '../bash-card.ts';
import { contextRows, fileDiagnosticText, fileHeading, fileNote, fileSources, prepareFileCard, type PreparedFileCard } from '../file-card.ts';
import type { SyntaxClient } from '../occipital/client.ts';
import { CONTROLLER_LIMITS, type GeometryFunding, type GroupDisplayBasis, type SourceController, type SourceDisplayBasis, type SourceWorkGroup } from '../occipital/controller.ts';
import { type DataCharge, type DataCleanupReceipt } from '../occipital/data-budget.ts';
import { RETENTION_LIMITS } from '../occipital/retention.ts';
import { CARD_ROLES, type CardRole } from '../occipital/semantic-codec.ts';
import { measure, prepareMeasuredAppend, type MeasuredAppend, type MeasuredText } from './measured-rows.ts';
import type { FlatRangeReader } from './flat-paint.ts';
import type { PiInputLease } from './pi-input.ts';
import { createPiRuleDefinition } from './pi-rules.ts';
import { compileStyleAnsi, type AnsiStyle } from './style-ansi.ts';
import type { ConcreteStyle } from './style-materialization.ts';
import { requestSyntax, resolveSyntax, type PiClassifier, type SyntaxIdentity, type SyntaxWorkResult } from './work.ts';

export type CardSourceInput = { palette: number; language?: string } & (
  { kind: 'file'; node: Parameters<typeof prepareFileCard>[0] } |
  { kind: 'bash'; args: Record<string, unknown>; complete: boolean; node?: BashPresentation }
);
export type CardDisplayInput = CardSourceInput & {
  revision: number; sourceRevision: number; serviceRevision: number; mode: TerminalColorMode;
  cwd?: string; directory?: string;
};
export type CardPreparation = { readonly update: string; readonly revision: number; readonly palette: number; readonly sourceEligible: boolean } & (
  { readonly phase: 'updated' } |
  { readonly phase: 'prepared'; readonly applied: boolean; readonly refused: number; readonly publication: number; readonly outcomes: readonly SyntaxWorkResult['outcome'][] }
);
export interface CardSourceHost<Owner extends object> {
  /** Cold acquisition only. The returned lease becomes this owner's responsibility. */
  preparePiInput(funding: GeometryFunding): PiInputLease | undefined;
  classify: PiClassifier;
  invalidate(owner: Owner): void;
  requestRender(): void;
  diagnostic?: DiagnosticSink;
  identify?(owner: Owner): DiagnosticFields;
  /** Observes accepted inputs and actual preparation completion; never requests work. */
  preparation?(owner: Owner, receipt: CardPreparation): void;
}
export interface PreparedRegion { readonly text: string; readonly measured: MeasuredText }
export interface PreparedBashRegions {
  readonly description?: PreparedRegion; readonly heading?: PreparedRegion;
  /** Original service.output indices. Collapsed sections prepare only their first
   * eleven logical rows; empty/trimmed/footer-only rows need no measurement. */
  readonly output: readonly (PreparedRegion | undefined)[];
  readonly footer?: PreparedRegion;
}
export interface FileRowDescriptor {
  readonly kind: ' ' | '+' | '-' | 'gap'; readonly index: number;
  readonly old?: number; readonly next?: number; readonly hunk?: number;
  readonly region?: PreparedRegion;
  /** Full continuous source coordinates, not concatenated selected-context coordinates. */
  readonly oldSource?: { readonly key: string; readonly utf16: number; readonly byte: number };
  readonly nextSource?: { readonly key: string; readonly utf16: number; readonly byte: number };
}
export type PreparedCard = { readonly kind: 'bash'; readonly revision: number; readonly geometryStamp: number;
  readonly command: PreparedRegion; readonly service: ReturnType<typeof prepareBashService>;
  readonly regions: PreparedBashRegions } |
  { readonly kind: 'file'; readonly revision: number; readonly geometryStamp: number; readonly path?: string;
    readonly label?: string; readonly mode?: string; readonly note?: PreparedRegion; readonly heading?: PreparedRegion;
    readonly error: boolean; readonly diagnostics: readonly PreparedRegion[];
    readonly rows: readonly FileRowDescriptor[] };
export interface ReadyCardPaint {
  readonly publication: number; readonly paintStamp: number; readonly mode: TerminalColorMode;
  readonly origin: 'native' | 'pi'; readonly roles: Readonly<Record<CardRole, AnsiStyle>>;
  /** Accessors are valid only within the outer synchronous visit. No compilation occurs here. */
  ranges(key: string, surface?: 'added' | 'removed'): FlatRangeReader | undefined;
  /** Historical text is borrowed under canonical ownership, never source authority. */
  basis(key: string, consume: (text: string, ranges: FlatRangeReader) => void): boolean;
}
type Slot = SyntaxIdentity & { outcome: SyntaxWorkResult['outcome']; awaitingProvider?: true };
const noSlots: ReadonlyMap<string, Slot> = new Map();
type LiteralPaint = { normal: AnsiStyle; added: AnsiStyle; removed: AnsiStyle };
type Compiled = { charge: DataCharge; table: Map<ConcreteStyle, LiteralPaint>; roles: Record<CardRole, AnsiStyle>;
  literals: Readonly<Record<CardRole, ConcreteStyle>>;
  group?: GroupDisplayBasis; publication: number; paintStamp: number; origin: 'native' | 'pi'; mode: TerminalColorMode;
  piTokens: Map<string, Map<number, ConcreteStyle>> };
type State = { input?: CardDisplayInput; revision: number; sourceRevision: number; serviceRevision: number;
  version: number; slots: ReadonlyMap<string, Slot>; sourceEligible?: boolean; display?: PreparedCard; file?: PreparedFileCard; charge?: DataCharge;
  pi?: PiInputLease; paint?: Compiled; ticket?: RecordTicket; paused?: boolean; frozen?: boolean; expanded?: boolean;
  useful?: boolean; processed?: number; preparedTheme?: number; preparedPalette?: number; mutation: number; geometry: number;
  descriptorReceipt?: DataCleanupReceipt; paintReceipt?: DataCleanupReceipt; paintToken?: string; paintEffects?: string; paintSignature?: string };
type RecordTicket = { id: number; owner: WeakRef<object>; state: WeakRef<State>; keys: Set<string>; bytes: number;
  consumer: WeakRef<CardSources<object>>; prepare(): void; acceptsProfile(profile: string, fingerprint: string): boolean;
  needsRefresh(newest: boolean): boolean; requiresCredit(): boolean; work?: SourceWorkGroup; receipts: Set<DataCleanupReceipt> };
type Release = { consumer: WeakRef<CardSources<object>>; sources: WeakRef<SourceController>; ticket: RecordTicket };
let sequence = 0;
const collected = new FinalizationRegistry<Release>(release => {
  const consumer = release.consumer.deref();
  if (consumer) consumer.release(release.ticket);
  else { if (release.ticket.work) release.sources.deref()?.unregisterPreparation(release.ticket.work); releaseReceipts(release.ticket); }
});
function releaseReceipts(ticket: RecordTicket) { for (const receipt of ticket.receipts) receipt.release(); ticket.receipts.clear(); }
function prepareTicket(this: RecordTicket) { this.consumer.deref()?.prepare(this); }
function acceptsTicket(this: RecordTicket, id: string, fingerprint: string) { return this.consumer.deref()?.acceptsProfile(id, fingerprint) ?? false; }
function refreshTicket(this: RecordTicket, newest: boolean) { return this.consumer.deref()?.needsRefresh(this, newest) ?? false; }
function creditTicket(this: RecordTicket) { return this.consumer.deref()?.requiresCredit(this) ?? false; }
function renderNotice(owner: WeakRef<CardSources<object>>) { return () => owner.deref()?.renderPrepared(); }
const keyBytes = (key: string) => RETENTION_LIMITS.entryAllowance + 2 * key.length;
function wireHint(value: string | undefined, cap: number) {
  return value && value.length <= cap && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value) ? value : undefined;
}
function fund(funding: GeometryFunding, bytes: number): DataCharge | undefined {
  const grant = funding.grant(bytes); if (!grant) return undefined;
  try { if (grant.budget !== funding.budget) throw new Error('foreign card funding'); return grant.consume(bytes); }
  finally { grant.close(); }
}
// Detached numeric receipt: finalizer tickets never retain descriptor/compiled stores.
function chargeReceipt(charge: DataCharge): DataCleanupReceipt { return { release: () => charge.release() }; }
function inputBytes(input: CardDisplayInput) {
  const args = input.kind === 'bash' ? input.args : input.node.args;
  let rows = 1;
  const size = (text: string) => { for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13) rows++; return text.length; };
  let units = (input.cwd?.length ?? 0) + (input.directory?.length ?? 0) + (input.language?.length ?? 0);
  for (const key of ['command', 'description', 'content', 'path', 'file_path', 'filePath']) if (typeof args[key] === 'string') units += size(args[key]);
  const result = input.kind === 'bash' ? input.node?.result : input.node.result;
  if (input.kind === 'bash') for (const part of input.node?.result?.content ?? []) units += size(part.text ?? '');
  const details = result?.details as { diff?: unknown; patch?: unknown; diagnostics?: unknown } | undefined;
  for (const value of [details?.diff, details?.patch]) if (typeof value === 'string') units += size(value);
  if (Array.isArray(details?.diagnostics)) for (const item of details.diagnostics) {
    if (item && typeof item === 'object' && typeof item.message === 'string') { units += size(item.message); rows++; }
  }
  // Fund normalization scratch, logical fragments and row descriptors before construction.
  return 4096 + units * 6 + rows * 1024;
}

/** Local prepared display and one weak controller registry entry per owner.
 * Host lifecycle updates establish first-frame display; useful only schedules. */
export class CardSources<Owner extends object> {
  private readonly owner = new WeakRef(this as unknown as CardSources<object>);
  private readonly states = new WeakMap<Owner, State>();
  private readonly records = new Map<number, RecordTicket>();
  private readonly keys = new Map<string, RecordTicket>();
  private readonly groups = new Map<number, RecordTicket>();
  private bytes = 0;
  private readonly maxBytes: number;
  private disposed = false;
  private metadata = '';
  private selection = '';
  private themeRevision = 0;
  private publication = 0;
  private renderScheduled = false;
  private piSelection = '';
  private readonly client: Pick<SyntaxClient, 'sources' | 'snapshot'>;
  private readonly host: CardSourceHost<Owner>;
  constructor(client: Pick<SyntaxClient, 'sources' | 'snapshot'>, host: CardSourceHost<Owner>,
    options: { maxBookkeepingBytes?: number } = {}) {
    this.client = client; this.host = host;
    this.maxBytes = options.maxBookkeepingBytes ?? CONTROLLER_LIMITS.bookkeepingBytes;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < RETENTION_LIMITS.entryAllowance || this.maxBytes > CONTROLLER_LIMITS.bookkeepingBytes)
      throw new Error('invalid card bookkeeping allowance');
    this.metadataChanged();
  }
  private register(owner: Owner, state: State): RecordTicket | undefined {
    if (state.ticket) return state.ticket;
    if (this.bytes + RETENTION_LIMITS.entryAllowance > this.maxBytes) return undefined;
    const ticket: RecordTicket = { id: ++sequence, owner: new WeakRef(owner), state: new WeakRef(state), keys: new Set(), bytes: RETENTION_LIMITS.entryAllowance,
      consumer: this.owner, prepare: prepareTicket, acceptsProfile: acceptsTicket, needsRefresh: refreshTicket, requiresCredit: creditTicket, receipts: new Set() };
    ticket.work = this.client.sources.registerPreparation(ticket); if (!ticket.work) return undefined;
    state.ticket = ticket; this.records.set(ticket.id, ticket); this.groups.set(ticket.work.id, ticket); this.bytes += ticket.bytes;
    collected.register(owner, { consumer: this.owner, sources: new WeakRef(this.client.sources), ticket }, ticket);
    this.client.sources.pausePreparation(ticket.work);
    this.client.sources.updatePreparation(ticket.work);
    return ticket;
  }
  /** Explicit cold lifecycle boundary. Never call from render. */
  updateDisplay(owner: Owner, input: CardDisplayInput): boolean {
    if (this.disposed) return false;
    let state = this.states.get(owner);
    if (!state) { state = { revision: -1, sourceRevision: -1, serviceRevision: -1, version: 0, slots: noSlots, mutation: 0, geometry: 0 }; this.states.set(owner, state); }
    const ticket = this.register(owner, state); if (!ticket?.work) return false;
    const funding = this.client.sources.geometryFunding(ticket.work); if (!funding) return false;
    const expanded = input.kind === 'bash' && input.node?.expanded === true;
    if (state.revision === input.revision && state.input?.palette === input.palette && state.input.mode === input.mode && state.expanded === expanded) return true;
    const sourceChanged = state.sourceRevision !== input.sourceRevision;
    const completed = input.kind === 'bash' && input.complete && state.input?.kind === 'bash' && !state.input.complete;
    const mutation = ++state.mutation, charge = fund(funding, inputBytes(input)); if (!charge) return false;
    const receipts = new Set<DataCleanupReceipt>(), old = state.display;
    let display: PreparedCard | undefined, file: PreparedFileCard | undefined, adopted = false, append: MeasuredAppend | undefined;
    const region = (text: string): PreparedRegion => {
      const measured = measure(text, funding.budget, funding.grant); if (!measured) throw refused;
      receipts.add(measured.cleanupReceipt()); return Object.freeze({ text, measured });
    };
    try {
      if (input.kind === 'bash') {
        const logical = old?.kind === 'bash' && state.sourceRevision === input.sourceRevision ? old.command.text : bashCommandSource(input.args) ?? '';
        let command: PreparedRegion;
        if (old?.kind === 'bash' && old.command.text === logical) command = old.command;
        else if (old?.kind === 'bash' && logical.startsWith(old.command.text)) {
          append = prepareMeasuredAppend(old.command.measured, logical, funding.grant);
          if (!append) throw refused;
          receipts.add(append.measured.cleanupReceipt()); command = Object.freeze({ text: logical, measured: append.measured });
        } else command = region(logical);
        const sameService = old?.kind === 'bash' && state.serviceRevision === input.serviceRevision;
        const service = sameService ? old.service : prepareBashService(input.node ? { ...input.node, args: input.args }
          : { args: input.args, expanded: false, isPartial: !input.complete }, input.directory);
        const previous = old?.kind === 'bash' ? old.regions : undefined;
        const serviceRegion = (text: string, prior?: PreparedRegion) => prior?.text === text ? prior : region(text);
        // Every logical row contributes at least one visual row. Each collapsed
        // section therefore needs at most eleven logical rows, at every width.
        // Keep complete service text; setExpanded prepares missing rows before render.
        const outputEnd = expanded ? service.last : Math.min(service.last, service.first + 11);
        const reminderEnd = expanded ? service.end : Math.min(service.end, service.reminder + 11);
        const regions = sameService && state.expanded === expanded ? old.regions : Object.freeze({
          description: service.description ? serviceRegion(`# ${service.description}`, previous?.description) : undefined,
          heading: service.heading ? serviceRegion(service.heading, previous?.heading) : undefined,
          output: Object.freeze(service.output.map((text, index) => text && (index >= service.first && index < outputEnd || index >= service.reminder && index < reminderEnd)
            ? serviceRegion(text, previous?.output[index]) : undefined)),
          footer: service.footer ? serviceRegion(service.footer, previous?.footer) : undefined,
        });
        const same = old?.kind === 'bash' && command === old.command && regions === old.regions;
        display = Object.freeze({ kind: 'bash', revision: input.revision, geometryStamp: same ? old.geometryStamp : ++state.geometry, command, service, regions });
      } else {
        file = state.sourceRevision === input.sourceRevision && state.file ? state.file : prepareFileCard(input.node, true);
        const error = !input.node.isPartial && input.node.result?.isError === true;
        const diagnostics = old?.kind === 'file' && state.serviceRevision === input.serviceRevision ? old.diagnostics
          : Object.freeze(fileDiagnosticText((input.node.result?.details as { diagnostics?: unknown } | undefined)?.diagnostics).map(region));
        const noteText = file ? fileNote(input.node, file.view) : undefined;
        const note = noteText ? old?.kind === 'file' && old.note?.text === noteText ? old.note : region(noteText) : undefined;
        if (old?.kind === 'file' && file === state.file) {
          const heading = state.input?.cwd === input.cwd ? old.heading : file ? region(fileHeading(file.path, input.cwd, file.view.label)) : undefined;
          display = Object.freeze({ ...old, revision: input.revision, heading, error, diagnostics, note,
            geometryStamp: heading === old.heading && diagnostics === old.diagnostics && note === old.note ? old.geometryStamp : ++state.geometry });
        }
        else {
          const rows: FileRowDescriptor[] = [];
          if (file) {
            const visible = file.view.mode === 'code' ? file.view.lines : contextRows(file.view.lines);
            const indices = new Map(file.view.lines.map((line, index) => [line, index]));
            const coordinates = new Map<number, { oldSource?: FileRowDescriptor['oldSource']; nextSource?: FileRowDescriptor['nextSource'] }>();
            let segment = 0;
            for (const side of ['old', 'next'] as const) {
              let previous: number | undefined, utf16 = 0, byte = 0, active = false;
              for (let index = 0; index < file.view.lines.length; index++) {
                const line = file.view.lines[index]!;
                if (line.kind === 'gap') { if (active) segment++; previous = undefined; active = false; continue; }
                const position = line[side]; if (position === undefined) continue;
                if (!active || position !== previous! + 1) { if (active) segment++; active = true; utf16 = byte = 0; }
                const key = `card:${ticket.id}:${segment}`;
                const coordinate = coordinates.get(index) ?? {}; coordinate[side === 'old' ? 'oldSource' : 'nextSource'] = { key, utf16, byte }; coordinates.set(index, coordinate);
                utf16 += line.logical.length + 1; byte += Buffer.byteLength(line.logical) + 1; previous = position;
              }
              if (active) segment++;
            }
            visible.forEach(line => {
              const index = indices.get(line) ?? -1;
              const coordinate = coordinates.get(index);
              if (coordinate?.oldSource) Object.freeze(coordinate.oldSource);
              if (coordinate?.nextSource) Object.freeze(coordinate.nextSource);
              rows.push(Object.freeze(line.kind === 'gap' ? { kind: 'gap', index } : { kind: line.kind, index, old: line.old, next: line.next, hunk: line.hunk,
                region: region(line.logical), ...coordinate }));
            });
          }
          display = Object.freeze({ kind: 'file', revision: input.revision, geometryStamp: ++state.geometry, path: file?.path, label: file?.view.label,
            mode: file?.view.mode, note, error, diagnostics, heading: file ? region(fileHeading(file.path, input.cwd, file.view.label)) : undefined, rows: Object.freeze(rows) });
        }
      }
      if (!this.owned(owner, state, ticket) || state.mutation !== mutation) return false;
      if (append && !append.commit()) return false;
      // Reused measurement receipts stay adopted; obsolete measurements release individually.
      const used = new Set<DataCleanupReceipt>();
      if (display.kind === 'bash') { used.add(display.command.measured.cleanupReceipt()); for (const r of [display.regions.description, display.regions.heading, ...display.regions.output, display.regions.footer]) if (r) used.add(r.measured.cleanupReceipt()); }
      else { for (const r of [display.heading, display.note, ...display.diagnostics]) if (r) used.add(r.measured.cleanupReceipt());
        for (const r of display.rows) if (r.region) used.add(r.region.measured.cleanupReceipt()); }
      const keep = new Set<DataCleanupReceipt>([...used, ...(state.pi ? [state.pi.cleanupReceipt()] : [])]);
      // Only measurements and the local descriptor charge change at this boundary.
      for (const r of ticket.receipts) if (!keep.has(r) && r !== state.descriptorReceipt && r !== state.paintReceipt) { r.release(); ticket.receipts.delete(r); }
      state.descriptorReceipt?.release(); if (state.descriptorReceipt) ticket.receipts.delete(state.descriptorReceipt);
      const receipt = chargeReceipt(charge); state.descriptorReceipt = receipt; ticket.receipts.add(receipt);
      for (const r of used) ticket.receipts.add(r);
      adopted = true; charge.retain();
      state.charge = charge; state.display = display; state.file = file; state.input = input; state.expanded = expanded;
      state.sourceEligible = input.kind === 'bash' ? typeof input.args.command === 'string' : !!file && !input.node.result?.isError;
      if (sourceChanged) state.version++;
      state.sourceRevision = input.sourceRevision; state.serviceRevision = input.serviceRevision; state.revision = input.revision;
      this.reconcileSelection(state, funding);
      if (!this.owned(owner, state, ticket) || state.mutation !== mutation) return false;
      this.refreshPaint(owner, state);
      if (state.useful && !state.paused && !state.frozen && input.kind === 'bash' && input.complete && (sourceChanged || completed)) this.enqueue(ticket, true);
      if (this.owned(owner, state, ticket) && state.input === input) this.observePreparation(owner, state, 'updated');
      return true;
    } catch (error) { if (error !== refused) throw error; return false; }
    finally {
      append?.dispose();
      if (adopted) charge.release();
      else { charge.release(); for (const r of receipts) r.release(); }
    }
  }
  useful(owner: Owner, revision: number): void {
    const state = this.states.get(owner), ticket = state?.ticket;
    if (!state || !ticket || this.disposed || state.revision !== revision) return;
    if (state.frozen && !state.slots.size) return;
    const resumed = state.paused;
    state.paused = false;
    if (state.frozen) {
      if (!resumed && state.useful && state.preparedTheme === this.themeRevision && state.preparedPalette === state.pi?.paletteRevision) return;
      state.useful = true; this.enqueue(ticket, true); return;
    }
    if (!resumed && state.useful && state.processed === state.sourceRevision && state.preparedTheme === this.themeRevision
      && (state.paint?.origin === 'native' || state.preparedPalette === state.pi?.paletteRevision)) return;
    state.useful = true; this.enqueue(ticket, state.processed !== undefined && (state.processed !== state.sourceRevision || state.paint?.origin !== 'native' && state.preparedPalette !== state.pi?.paletteRevision));
  }
  private reconcileNativeSelection(snapshot: ReturnType<SyntaxClient['snapshot']>) {
    const native = snapshot.enabled && snapshot.selected.kind === 'occipital' && snapshot.effective?.id !== 'pi' && snapshot.effective;
    if (native) {
      const identity = `native:${native.id}:${native.fingerprint}`;
      if (this.selection !== identity && this.client.sources.setStyleSelection({ kind: 'native', id: native.id, fingerprint: native.fingerprint })) this.selection = identity;
    }
    return native;
  }
  private reconcileSelection(state: State, funding: GeometryFunding) {
    const snapshot = this.client.snapshot(), ticket = state.ticket, input = state.input;
    if (!ticket || !input) return;
    const native = this.reconcileNativeSelection(snapshot);
    const needsPi = snapshot.effective?.id === 'pi' || !(snapshot.enabled && state.paint?.origin === 'native')
      && (!native || !this.client.sources.groupPresentation(ticket.work!));
    if (needsPi && (!state.pi || state.pi.paletteRevision !== input.palette || state.pi.terminalMode !== input.mode)) {
      const lease = this.host.preparePiInput(funding);
      if (this.disposed || state.ticket !== ticket || state.input !== input || this.records.get(ticket.id) !== ticket) { lease?.cleanupReceipt().release(); return; }
      if (lease) { if (state.pi) { const receipt = state.pi.cleanupReceipt(); receipt.release(); state.ticket!.receipts.delete(receipt); }
        state.pi = lease; state.ticket!.receipts.add(lease.cleanupReceipt()); }
    }
    if (snapshot.effective?.id === 'pi' && state.pi) {
      const identity = `pi:${state.pi.paletteRevision}`;
      if (this.selection !== identity) state.pi.visit(read => {
        if (this.client.sources.setStyleSelection({ kind: 'client', definition: createPiRuleDefinition(), bindingRevision: state.pi!.paletteRevision,
          palette: identity, bindings: read.bindings, roles: read.roles })) { this.selection = identity; this.piSelection = identity; }
      }, funding.grant);
    }
  }
  acceptsProfile(id: string, fingerprint: string): boolean {
    const snapshot = this.client.snapshot(); return !this.disposed && snapshot.enabled && snapshot.effective?.id === id && snapshot.effective.fingerprint === fingerprint;
  }
  requiresCredit(ticket?: RecordTicket): boolean {
    const s = this.client.snapshot(), state = ticket?.state.deref();
    // A ready card can restore local Pi bindings/cached styles even while unrelated
    // native calls hold both slots; the controller still admits any missing RPC.
    if (s.effective?.id === 'pi' && state?.processed !== undefined && state.processed === state.sourceRevision
      && ticket?.work && this.client.sources.groupPresentation(ticket.work)) return false;
    return s.enabled && s.provider.availability === 'ready' && !!s.effective;
  }
  needsRefresh(ticket: RecordTicket, newest: boolean): boolean {
    const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
    if (!owner || !state) { this.release(ticket); return false; }
    if (!this.current(owner, state, ticket) || !state.useful) return false;
    if (state.frozen) return state.preparedTheme !== this.themeRevision || state.preparedPalette !== state.pi?.paletteRevision;
    if (state.processed !== state.sourceRevision || state.preparedTheme !== this.themeRevision) return true;
    for (const slot of state.slots.values()) {
      if (slot.awaitingProvider && this.requiresCredit() || slot.fallback === 'pi' &&
        state.paint?.origin !== 'native' && (newest || slot.outcome === 'waiting') && resolveSyntax(this.client.sources, slot, this.client.snapshot().effective ?? null).needsPi) return true;
      // Every eligible Pi FILE needs its first native SOURCE; retained semantic
      // SOURCE on compatible recovery must not be reclassified.
      if (state.input?.kind === 'file' && slot.outcome === 'pi' && !this.client.sources.borrowSource(slot.key)
        && this.client.sources.workStatus(slot.key).fallbackEligible && this.requiresCredit()) return true;
    }
    return false;
  }
  metadataChanged(): void {
    if (this.disposed) return;
    const s = this.client.snapshot(), selection = JSON.stringify([s.enabled, s.selected.kind === 'pi' ? 'pi' : `native:${s.selected.id}:${s.effective?.fingerprint}`]);
    const identity = JSON.stringify([s.enabled, s.provider.availability, s.provider.generation, selection]);
    if (identity === this.metadata) return;
    if (this.metadata && selection !== this.metadataSelection) this.themeRevision++;
    this.metadataSelection = selection; this.metadata = identity;
    // Desired native rules are local state: cached rollback must not wait for DATA credit.
    this.reconcileNativeSelection(s);
    this.client.sources.refreshPreparations();
  }
  private metadataSelection = '';
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
      if (!state.paused && !state.frozen && state.useful && state.paint?.origin !== 'native') {
        for (const slot of state.slots.values()) if (resolveSyntax(this.client.sources, slot, this.client.snapshot().effective ?? null).needsPi) {
          this.enqueue(ticket, true); break;
        }
      }
    }
  }
  prepare(ticket: RecordTicket): void {
    const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
    if (!owner || !state) { this.release(ticket); return; }
    if (!this.current(owner, state, ticket) || !state.useful || !state.input || !state.display || !ticket.work) return;
    const input = state.input, mutation = state.mutation, funding = this.client.sources.geometryFunding(ticket.work); if (!funding) return;
    this.reconcileSelection(state, funding);
    if (!this.current(owner, state, ticket) || state.mutation !== mutation) return;
    // Freeze ends SOURCE authority, not retained-scope STYLE/local binding work.
    // Never rebuild slots or claim the latest display revision was parsed.
    if (state.frozen) {
      state.preparedTheme = this.themeRevision; state.preparedPalette = state.pi?.paletteRevision;
      this.refreshPaint(owner, state); return;
    }
    // A resumed ready group already owns this source demand; do not rebuild its slots.
    if (state.processed === state.sourceRevision && state.preparedTheme === this.themeRevision
      && [...state.slots.values()].every(slot => !slot.awaitingProvider && (input.kind === 'file' || slot.complete === input.complete))
      && (state.paint?.origin === 'native' || state.preparedPalette === state.pi?.paletteRevision)
      && this.client.sources.groupPresentation(ticket.work)) { this.refreshPaint(owner, state); return; }
    if (!state.sourceEligible && ticket.keys.size) { this.pause(owner); this.refreshPaint(owner, state); return; }
    let scratch: DataCharge | undefined;
    try {
      scratch = fund(funding, 1024 + (input.kind === 'bash' && state.display.kind === 'bash' ? state.display.command.text.length * 2
        : state.file?.view.lines.reduce((n, line) => n + (line.kind === 'gap' ? 0 : line.logical.length * 2 + 128), 0) ?? 0));
      if (!scratch) return;
      // Retained classification owns only a prefix, never the full current demand.
      const demands: { text: string; languageHint?: string }[] = state.sourceEligible && input.kind === 'bash' && state.display.kind === 'bash' ? [{ text: state.display.command.text }]
        : state.file && input.kind === 'file' && !input.node.result?.isError ? fileSources(state.file.view) : [];
      const slots = new Map<string, Slot>();
      let refused = 0;
      for (let index = 0; index < demands.length; index++) {
        const key = `card:${ticket.id}:${index}`;
        if (!ticket.keys.has(key)) {
          const bytes = keyBytes(key); if (this.bytes + bytes > this.maxBytes) { refused++; continue; }
          ticket.keys.add(key); this.keys.set(key, ticket); this.bytes += bytes; ticket.bytes += bytes;
        }
        const language = input.kind === 'bash' ? wireHint(input.language, 128) : wireHint(demands[index]!.languageHint, 128);
        const piLanguage = input.kind === 'file' ? wireHint(input.language, 128) : undefined;
        const slot: Slot = { key, version: state.version, language, piLanguage, complete: input.kind === 'file' || input.complete,
          palette: state.pi?.paletteRevision ?? input.palette, fallback: input.kind === 'bash' ? 'neutral' : 'pi', outcome: 'refused' };
        slots.set(key, slot);
        const demand = { ...slot, text: demands[index]!.text, path: wireHint(state.file?.path, 4096), nativeProfile: this.client.snapshot().effective ?? null,
          neutral: input.kind === 'bash' ? 'title' as const : 'code' as const };
        if (input.kind === 'bash') Object.assign(slot, requestSyntax(this.client, { ...demand, fallback: 'neutral' }, this.host.classify));
        else if (state.pi && state.paint?.origin !== 'native') state.pi.visit(read => { Object.assign(slot, requestSyntax(this.client, { ...demand, fallback: 'pi', piNeutral: read.roles.code }, this.host.classify)); }, funding.grant);
        else Object.assign(slot, requestSyntax(this.client, { ...demand, fallback: 'neutral' }, this.host.classify));
        const status = this.client.sources.workStatus(key);
        this.log(owner, 'Syntax work evaluated outside render', { source: key, version: slot.version, units: demand.text.length,
          language: slot.language ?? 'unknown', palette: slot.palette, outcome: slot.outcome, awaitingProvider: !!slot.awaitingProvider,
          execution: status.execution, fallbackEligible: status.fallbackEligible });
        if (!this.current(owner, state, ticket) || state.mutation !== mutation) {
          // A reentrant capture may finish after unregistering this ticket. Remove
          // only retired ownership, never a paused or replaced live incarnation.
          if (!this.owned(owner, state, ticket)) for (const attempted of slots.values()) this.client.sources.remove(attempted.key);
          return;
        }
      }
      for (const key of ticket.keys) if (!slots.has(key)) {
        ticket.keys.delete(key); this.keys.delete(key); this.client.sources.remove(key); const bytes = keyBytes(key); ticket.bytes -= bytes; this.bytes -= bytes;
      }
      state.slots = slots; state.processed = state.sourceRevision; state.preparedTheme = this.themeRevision; state.preparedPalette = state.pi?.paletteRevision;
      this.client.sources.updatePreparation(ticket.work); const applied = this.refreshPaint(owner, state);
      this.log(owner, 'Prepared source demand evaluated outside render', { sources: slots.size, version: state.version, revision: state.revision });
      if (this.current(owner, state, ticket) && state.mutation === mutation) this.observePreparation(owner, state, 'prepared', applied, refused);
    } finally { scratch?.release(); }
  }
  private refreshPaint(owner: Owner, state: State): boolean {
    const ticket = state.ticket, input = state.input; if (!ticket?.work || !input) return false;
    const funding = this.client.sources.geometryFunding(ticket.work); if (!funding) return false;
    const group = this.client.sources.groupPresentation(ticket.work);
    const isNative = group ? group.palette !== this.piSelection : state.paint?.origin === 'native' && this.client.snapshot().enabled;
    const publication = group?.stamp ?? -(state.pi?.paletteRevision ?? 0);
    // Work-only slots carry no visible effect. Ready projections include their
    // revision/palette so changed syntax inks cannot hide behind a source alias.
    const effects = `${input.mode}:${Array.from(state.slots.values(), s => {
      const p = this.client.sources.piProjection(s.key, s.version, s.palette);
      return p ? `${p.generation}/${p.revision}/${p.palette}` : '';
    }).filter(Boolean).join(',')}`;
    const token = `${publication}:${effects}`;
    if (state.paintToken === token) return true;
    const previous = state.paint, mutation = state.mutation;
    previous?.charge.retain();
    let scratch: DataCharge | undefined, charge: DataCharge | undefined;
    let next: Compiled | undefined, signature: string | undefined;
    const compile = (roles: Readonly<Record<CardRole, ConcreteStyle>>, enumerate: (consume: (style: ConcreteStyle) => void) => boolean,
      preparedRoles?: Readonly<Record<CardRole, AnsiStyle>>) => {
      let count = 0; if (!enumerate(() => count++)) return;
      charge = fund(funding, 4096 + count * 2048 + state.slots.size * 512); if (!charge) return;
      const table = new Map<ConcreteStyle, LiteralPaint>(), compiled = {} as Record<CardRole, AnsiStyle>;
      const known = new Map<ConcreteStyle, AnsiStyle>();
      if (preparedRoles) for (const role of CARD_ROLES) known.set(roles[role], preparedRoles[role]);
      const add = (style: ConcreteStyle) => { if (!table.has(style)) table.set(style, {
        normal: known.get(style) ?? compileStyleAnsi(style, input.mode), added: compileStyleAnsi({ ...style, background: roles.addedCode.background }, input.mode),
        removed: compileStyleAnsi({ ...style, background: roles.removedCode.background }, input.mode) }); };
      if (!enumerate(add)) return;
      for (const role of CARD_ROLES) { const style = roles[role]; add(style); compiled[role] = table.get(style)!.normal; }
      const piTokens = new Map<string, Map<number, ConcreteStyle>>();
      if (!isNative) for (const slot of state.slots.values()) {
        const projection = slot.palette === state.pi?.paletteRevision ? this.client.sources.piProjection(slot.key, slot.version, slot.palette) : undefined; if (!projection) continue;
        const entries = new Map<number, ConcreteStyle>();
        if (!projection.visitStyles((i, style) => { add(style); entries.set(i, style); })) return;
        piTokens.set(slot.key, entries);
      }
      signature = CARD_ROLES.map(role => compiled[role].open).join('|');
      const same = previous && signature === state.paintSignature && (group?.paintStamp ?? 0) === (previous.group?.paintStamp ?? 0)
        && (isNative || effects === state.paintEffects);
      next = { charge, table, roles: Object.freeze(compiled), literals: roles, group, publication: ++this.publication, paintStamp: same ? previous.paintStamp : this.publication,
        origin: isNative ? 'native' : 'pi', mode: input.mode, piTokens };
    };
    try {
      scratch = fund(funding, 4096); if (!scratch) return false;
      if (group) {
        const roles = {} as Record<CardRole, ConcreteStyle>;
        for (const role of CARD_ROLES) { const style = group.role(role); if (!style) return false; roles[role] = style; }
        compile(roles, consume => group.visitStyles(consume));
      } else if (isNative && previous) compile(previous.literals, consume => { for (const role of CARD_ROLES) consume(previous.literals[role]); return true; });
      else if (state.pi) state.pi.visit(read => {
        compile(read.roles, consume => { for (const role of CARD_ROLES) consume(read.roles[role]);
          for (const slot of state.slots.values()) { const projection = this.client.sources.piProjection(slot.key, slot.version, slot.palette); if (projection && !projection.visitStyles((_i, style) => consume(style))) return false; } return read.isValid; }, read.compiledRoles);
      }, funding.grant);
      if (!next || !this.owned(owner, state, ticket) || state.mutation !== mutation || state.input !== input || state.paint !== previous) return false;
      const receipt = chargeReceipt(next.charge); state.paintReceipt?.release();
      const oldReceipt = state.paintReceipt; if (oldReceipt) ticket.receipts.delete(oldReceipt);
      state.paintReceipt = receipt; ticket.receipts.add(receipt); state.paint = next; state.paintToken = token; state.paintEffects = effects; state.paintSignature = signature; charge = undefined;
      if (next.origin === 'native' && state.pi) {
        const piReceipt = state.pi.cleanupReceipt(); state.pi = undefined; ticket.receipts.delete(piReceipt); piReceipt.release();
      }
      if (previous && previous.paintStamp !== next.paintStamp && !state.paused) this.invalidatePrepared(owner);
      return true;
    } finally {
      try {
        if (state.paint === previous && this.owned(owner, state, ticket)) this.retireStaleReaders(owner, state);
      } finally { charge?.release(); scratch?.release(); previous?.charge.release(); }
    }
  }
  private retireStaleReaders(owner: Owner, state: State): void {
    const paint = state.paint;
    if (paint?.origin !== 'native' || !this.client.snapshot().enabled || !paint.group || paint.group.visit(() => {})) return;
    // Complete roles remain owned even when replacement lookup funding is denied.
    // Reader loss changes paint, not geometry, and invalidates suspended visits.
    state.mutation++; paint.group = undefined;
    paint.publication = paint.paintStamp = ++this.publication;
    if (!state.paused) this.invalidatePrepared(owner);
  }
  /** One synchronous provisional borrow; never prepares display or paint. */
  visit(owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void): boolean {
    const state = this.states.get(owner), display = state?.display, paint = state?.paint, charge = state?.charge;
    if (this.disposed || !state || !display || !paint || !charge) return false;
    const mutation = state.mutation;
    const scoped = cardVisit(display, paint, state, this.client.sources,
      () => !this.disposed && this.states.get(owner) === state && state.mutation === mutation && state.paint === paint);
    charge.retain(); paint.charge.retain();
    try {
      let invoked = false;
      const invoke = () => { if (scoped.valid()) { invoked = true; consume(scoped.display, scoped.paint); } };
      const accepted = paint.group ? paint.group.visit(invoke) : paint.origin === 'native' ? (invoke(), true) : state.pi?.visit(invoke) ?? false;
      return accepted && invoked && scoped.valid();
    } finally { scoped.clear(); charge.release(); paint.charge.release(); }
  }
  displayStamp(owner: Owner): number { return this.states.get(owner)?.paint?.paintStamp ?? 0; }
  identities(owner: Owner): SyntaxIdentity[] { const state = this.states.get(owner);
    return state ? Array.from(state.slots.values(), ({ key, version, language, piLanguage, complete, palette, fallback }) => ({ key, version, language, piLanguage, complete, palette, fallback })) : []; }
  freeze(owner: Owner): void { const s = this.states.get(owner); if (!s || s.frozen) return; s.frozen = true;
    for (const slot of s.slots.values()) this.client.sources.freeze(slot.key); }
  pause(owner: Owner): void { const s = this.states.get(owner); if (!s) return; s.paused = true; if (s.ticket?.work) this.client.sources.pausePreparation(s.ticket.work); }
  remove(owner: Owner): void { const s = this.states.get(owner); this.states.delete(owner); if (s?.ticket) this.release(s.ticket); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const t of this.records.values()) this.release(t); }
  release(ticket: RecordTicket): void {
    if (!this.records.delete(ticket.id)) return;
    collected.unregister(ticket); if (ticket.work) { this.groups.delete(ticket.work.id); this.client.sources.unregisterPreparation(ticket.work); }
    for (const key of ticket.keys) this.keys.delete(key); ticket.keys.clear(); this.bytes -= ticket.bytes;
    releaseReceipts(ticket);
    const s = ticket.state.deref(); if (s) { s.mutation++; s.ticket = undefined; s.display = s.file = s.input = s.paint = s.pi = s.charge = undefined; s.slots = noSlots; }
  }
  private owned(owner: Owner, state: State, ticket: RecordTicket): boolean { return !this.disposed && this.states.get(owner) === state && this.records.get(ticket.id) === ticket; }
  private current(owner: Owner, state: State, ticket: RecordTicket): boolean { return this.owned(owner, state, ticket) && !state.paused; }
  private enqueue(ticket: RecordTicket, local = false): void { if (ticket.work && this.records.has(ticket.id)) this.client.sources.queuePreparation(ticket.work, local); }
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
const refused = Symbol('card allocation refused');

function matchesFileBasis(basis: SourceDisplayBasis | undefined, slot: Slot): basis is SourceDisplayBasis {
  return !!basis && basis.complete && basis.language === slot.language
    && (basis.version === slot.version || basis.exactVersion === slot.version);
}

// Clear every payload holder on unwind. Escaped accessors retain neither owner nor display data.
function cardVisit(display: PreparedCard | undefined, paint: Compiled | undefined, state: State | undefined,
  sources: SourceController | undefined, current: (() => boolean) | undefined) {
  const valid = () => !!current?.();
  const stale = () => { if (!valid()) throw new Error('stale card visit'); };
  const ranges = (key: string, surface?: 'added' | 'removed'): FlatRangeReader | undefined => {
    if (!valid()) return undefined;
    const slot = state!.slots.get(key);
    if (!slot || display!.kind === 'file' && slot.version !== state!.version) return undefined;
    const wrap = (read: (consume: (a: number, b: number, style: ConcreteStyle) => void) => boolean): FlatRangeReader => cb => {
      if (!valid()) return false;
      let complete = true;
      const result = read((a, b, literal) => { if (!valid()) return; const style = paint!.table.get(literal);
        if (!style) { complete = false; return; } cb(a, b, surface === 'added' ? style.added : surface === 'removed' ? style.removed : style.normal); });
      return result && complete && valid();
    };
    if (paint!.group) {
      let result: FlatRangeReader | undefined;
      paint!.group.visit(member => {
        const m = member(key); if (!m) return;
        if (display!.kind === 'file') {
          // Offline preparation can advance the demand without observing new source text.
          const basis = sources!.displayBasis(key);
          if (!matchesFileBasis(basis, slot) || basis.generation !== m.generation || basis.version !== m.version || basis.stamp !== m.stamp) return;
        }
        result = wrap(m.read);
      });
      if (result || paint!.origin === 'native') return result;
    }
    if (paint!.origin === 'native') return undefined;
    const projection = paint!.piTokens.has(key) ? sources!.piProjection(key, slot.version, slot.palette) : undefined;
    return projection ? wrap(cb => projection.visitRanges((a, b, i) => {
      if (!valid()) return; const style = paint!.piTokens.get(key)?.get(i); if (style) cb(a, b, style);
    })) : undefined;
  };
  // Build the discriminant and getters without using the payload as a proxy target.
  const readDisplay = new Proxy({} as PreparedCard, { get: (_target, key) => { stale(); return Reflect.get(display!, key); },
    set: () => false, defineProperty: () => false, deleteProperty: () => false });
  const readPaint = Object.freeze<ReadyCardPaint>({ publication: paint!.publication, paintStamp: paint!.paintStamp, origin: paint!.origin, mode: paint!.mode,
    get roles() { stale(); return paint!.roles; }, ranges,
    basis: (key, callback) => { if (!valid()) return false; const basis = sources!.displayBasis(key), slot = state!.slots.get(key);
      if (display!.kind === 'file' && (!slot || !matchesFileBasis(basis, slot))) return false;
      const read = ranges(key);
      return !!basis && !!read && basis.visit(text => { if (valid()) callback(text, read); }) && valid(); } });
  return { display: readDisplay, paint: readPaint, valid, clear() { display = paint = state = sources = current = undefined; } };
}
