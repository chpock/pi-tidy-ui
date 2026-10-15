import { diagnose, type DiagnosticFields, type DiagnosticSink } from '../diagnostics.ts';
import { bashCommandSource } from '../bash-card.ts';
import type { CardTheme } from '../card-theme.ts';
import { displayFileCard, prepareFileCard, type FileDisplayCard } from '../file-card.ts';
import type { SyntaxClient } from '../occipital/client.ts';
import { CONTROLLER_LIMITS, type SourceController } from '../occipital/controller.ts';
import { RETENTION_LIMITS } from '../occipital/retention.ts';
import { paintHistoricalBashCommand, type HistoricalBashCoverage } from './paint.ts';
import { paintFileSyntax, requestSyntax, resolveSyntax,
  type PiClassifier, type SyntaxIdentity, type SyntaxResolution, type SyntaxWorkResult } from './work.ts';

export type CardSourceInput = { palette: number; language?: string } & (
  { kind: 'file'; node: Parameters<typeof prepareFileCard>[0] } |
  { kind: 'bash'; args: Record<string, unknown>; complete: boolean }
);
export interface CardSourceHost<Owner extends object> {
  /** Fresh already-authorized source metadata, read only outside render. Undefined
   * means ownership/eligibility ended; files must be successful final results.
   * Host revision changes for text/path/language/completion/palette, not output. */
  read(owner: Owner): CardSourceInput | undefined;
  classify: PiClassifier;
  /** Target the owner's layout only. Never pass a renderContext.invalidate closure. */
  invalidate(owner: Owner): void;
  requestRender(): void;
  diagnostic?: DiagnosticSink;
  /** Primitive call identity, never source/argument/result bodies. */
  identify?(owner: Owner): DiagnosticFields;
}
type Slot = SyntaxIdentity & { rows?: readonly number[]; side?: 'old' | 'next'; outcome: SyntaxWorkResult['outcome']; awaitingProvider?: true; paintDecision?: string };
type State = { revision: number; requested?: number; processed?: number; requestedTheme?: number; preparedTheme?: number; awaitingTheme?: true; version: number; slots: Slot[];
  display?: FileDisplayCard; kind?: 'file' | 'bash'; record?: RecordTicket; paused?: boolean; frozen?: boolean; paintedStamp?: number };
type RecordTicket = { id: number; owner: WeakRef<object>; state: WeakRef<State>; keys: Set<string>; bytes: number; queued?: true };
type Release = { consumer: WeakRef<CardSources<object>>; sources: WeakRef<SourceController>; ticket: RecordTicket };
let sequence = 0;
const collected = new FinalizationRegistry<Release>(release => {
  const consumer = release.consumer.deref();
  if (consumer) consumer.release(release.ticket);
  else for (const key of release.ticket.keys) release.sources.deref()?.remove(key);
});
// These factories cannot capture a component, host read packet, or first installer.
function continuation(owner: WeakRef<CardSources<object>>) { return () => owner.deref()?.drain(); }
const keyBytes = (key: string) => RETENTION_LIMITS.entryAllowance + 2 * key.length;
// Optional wire hints follow SourceController's identifier rules, not display
// filename rules. Omit unsupported hints; never rewrite the actual filename.
function wireHint(value: string | undefined, cap: number): string | undefined {
  return value && value.length <= cap && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value) ? value : undefined;
}

/** Weak card presentation plus bounded primitive demand tickets. Logical strings,
 * classifications and reader-owned arrays never survive a visit outside the
 * canonical SourceController pool. No native visibility policy lives here. */
export class CardSources<Owner extends object> {
  private readonly client: Pick<SyntaxClient, 'sources' | 'snapshot'>;
  private readonly host: CardSourceHost<Owner>;
  private readonly owner = new WeakRef(this as unknown as CardSources<object>);
  private readonly states = new WeakMap<Owner, State>();
  private readonly records = new Map<number, RecordTicket>();
  private readonly keys = new Map<string, RecordTicket>();
  private readonly pending: RecordTicket[] = [];
  private latest?: { ticket: RecordTicket; revision: number };
  private bytes = 0;
  private readonly maxBytes: number;
  private scheduled = false;
  private disposed = false;
  private metadata: string;
  private selection?: string;
  private effectiveTheme?: string;
  private themeRevision = 0;
  private displayProfile?: { id: string; fingerprint: string; selection: string };

  constructor(client: Pick<SyntaxClient, 'sources' | 'snapshot'>, host: CardSourceHost<Owner>,
    options: { maxBookkeepingBytes?: number } = {}) {
    this.client = client; this.host = host;
    this.maxBytes = options.maxBookkeepingBytes ?? CONTROLLER_LIMITS.bookkeepingBytes;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < RETENTION_LIMITS.entryAllowance
      || this.maxBytes > CONTROLLER_LIMITS.bookkeepingBytes) throw new Error('invalid card bookkeeping allowance');
    this.metadata = this.metadataIdentity();
  }

  /** Cheap lifecycle recording, NOT a new useful fallback demand. It replaces
   * already pending work; completion always queues a previously authorized source. */
  record(owner: Owner, revision: number, complete: boolean): void {
    if (this.disposed) return;
    const state = this.states.get(owner);
    if (!state) { this.states.set(owner, { revision, version: 0, slots: [] }); return; }
    if (state.frozen || state.revision === revision) return;
    state.revision = revision;
    if (this.latest && this.latest.ticket === state.record) this.latest.revision = revision;
    if (complete && state.record && !state.paused) this.enqueue(state.record);
  }

  /** Explicit genuinely useful intermediate/final demand. Equal text/theme
   * revisions already processed or pending are warm visits: no source work.
   * Bash fallback always remains the legacy whole-command toolTitle style. */
  useful(owner: Owner, revision: number): void {
    if (this.disposed) return;
    let state = this.states.get(owner);
    if (state?.frozen) return;
    if (!state?.paused && state?.revision === revision && (state.processed === revision && state.preparedTheme === this.themeRevision
      || state.requested === revision && state.requestedTheme === this.themeRevision)) return;
    if (!state) { state = { revision, version: 0, slots: [] }; this.states.set(owner, state); }
    else state.revision = revision;
    state.paused = false;
    state.requested = revision; state.requestedTheme = this.themeRevision;
    if (!state.record) {
      if (this.bytes + RETENTION_LIMITS.entryAllowance > this.maxBytes) return;
      const ticket: RecordTicket = { id: ++sequence, owner: new WeakRef(owner), state: new WeakRef(state), keys: new Set(), bytes: RETENTION_LIMITS.entryAllowance };
      state.record = ticket; this.records.set(ticket.id, ticket); this.bytes += ticket.bytes;
      collected.register(owner, { consumer: this.owner, sources: new WeakRef(this.client.sources), ticket }, ticket);
    }
    this.latest = { ticket: state.record, revision };
    this.enqueue(state.record);
  }

  /** Wire to SyntaxClient.onChange. Theme edits renew retained useful demand;
   * readiness alone resumes only deferred work, through existing weak tickets. */
  metadataChanged(): void {
    if (this.disposed) return;
    const previousTheme = this.themeRevision;
    const snapshot = this.client.snapshot(), identity = this.metadataIdentity(snapshot);
    const themeChanged = previousTheme !== this.themeRevision;
    if (identity === this.metadata) return;
    this.metadata = identity;
    const available = snapshot.enabled && snapshot.provider.availability === 'ready' && !!snapshot.effective;
    const latest = this.latest, state = latest?.ticket.state.deref();
    // Availability loss is not new demand for an already processed Bash revision.
    if (latest && !state?.paused && !state?.frozen && state?.revision === latest.revision
      && (available || state.kind !== 'bash' || state.processed !== state.revision)) this.enqueue(latest.ticket);
    if (available || themeChanged) for (const ticket of this.records.values()) {
      const state = ticket.state.deref();
      if (!state || !ticket.owner.deref()) { this.release(ticket); continue; }
      if (themeChanged && !state.frozen) state.awaitingTheme = true;
      if (available && !state.paused && !state.frozen && (state.awaitingTheme
        || state.kind === 'bash' && state.slots.some(slot => slot.awaitingProvider))) this.enqueue(ticket);
    }
  }

  /** Wire to onSourceChange. Notices invalidate only keyed owners. Canonical
   * permission permits one waiting fallback or typed profile retry; refused/failed
   * or evicted display entries do not turn notices/frames into admission loops. */
  sourceChanged(keys: readonly string[]): void {
    if (this.disposed) return;
    const affected = new Set<RecordTicket>();
    for (const key of keys) { const ticket = this.keys.get(key); if (ticket) affected.add(ticket); }
    let changed = false;
    for (const ticket of affected) {
      const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
      if (!owner || !state) { this.release(ticket); continue; }
      if (state.kind === 'bash') {
        if (this.bashStamp(state) !== (state.paintedStamp ?? 0)) { this.host.invalidate(owner); changed = true; }
        if (state.paused || state.frozen || state.processed !== state.revision) continue;
      } else if (state.paused || state.processed !== state.revision) continue;
      const needsWork = state.slots.some(slot => {
        const work = this.client.sources.workStatus(slot.key);
        return work.profileRetryAllowed || slot.outcome === 'waiting' &&
          resolveSyntax(this.client.sources, slot, 0x40000000, this.displayProfile ?? null).needsPi;
      });
      if (needsWork) this.enqueue(ticket);
      else if (state.kind !== 'bash') { this.host.invalidate(owner); changed = true; }
    }
    if (changed && !this.disposed) this.host.requestRender();
  }

  /** Render-only projections. Returned glyph maps/rows are visit-local; caller may
   * retain its finished layout, but never range readers or classification arrays. */
  file(owner: Owner, theme: CardTheme, neutralStyle: number): { display: FileDisplayCard; styledRows: Map<number, string> } | undefined {
    const state = this.states.get(owner);
    if (this.disposed || state?.paused || state?.processed !== state?.revision || !state?.display) return undefined;
    const styledRows = new Map<number, string>();
    for (const slot of state.slots) {
      const resolution = resolveSyntax(this.client.sources, slot, neutralStyle, this.displayProfile ?? null);
      const rows = paintFileSyntax(this.client.sources, resolution, theme);
      this.paintDecision(owner, slot, resolution, rows !== undefined);
      if (!rows) continue;
      slot.rows?.forEach((index, row) => {
        if (slot.side === 'next' || state.display!.lines[index]?.kind === '-') styledRows.set(index, rows[row]!);
      });
    }
    return { display: state.display, styledRows };
  }
  bash(owner: Owner, width: number, theme: CardTheme, _neutralStyle: number, text?: string): string[] | undefined {
    const state = this.states.get(owner), slot = state?.slots[0];
    if (state) state.paintedStamp = 0;
    if (this.disposed || state?.kind !== 'bash' || !slot) return undefined;
    const basis = this.client.sources.displayBasis(slot.key), profile = this.displayProfile;
    if (!basis || basis.language !== 'bash' || basis.profile !== profile?.id || basis.fingerprint !== profile.fingerprint) return undefined;
    const current = text ?? (state.processed === state.revision ? this.client.sources.borrowSource(slot.key)?.text : undefined);
    if (current === undefined) return undefined;
    let rows: string[] | undefined;
    const coverage = this.host.diagnostic ? { matchedBytes: 0, styledBytes: 0 } : undefined;
    const available = basis.visit((previous, read) => { rows = paintHistoricalBashCommand(current, previous, width, theme, read, coverage); });
    if (!available) return undefined;
    if (rows) state.paintedStamp = basis.stamp;
    this.logBashPaint(owner, state, slot, rows !== undefined, basis.version, coverage);
    return rows;
  }
  private bashStamp(state: State): number {
    const key = state.slots[0]?.key;
    if (!key || !this.displayProfile) return 0;
    return this.client.sources.displayStamp(key, this.displayProfile.id, this.displayProfile.fingerprint, 'bash');
  }
  displayStamp(owner: Owner): number {
    const state = this.states.get(owner);
    return state?.kind === 'bash' ? this.bashStamp(state) : state?.kind === 'file' ? this.themeRevision : 0;
  }
  freeze(owner: Owner): void {
    const state = this.states.get(owner);
    if (!state || state.frozen || this.disposed) return;
    state.frozen = true; state.paused = false;
    if (state.record) this.unqueue(state.record);
    if (this.latest?.ticket === state.record) this.latest = undefined;
    for (const slot of state.slots) this.client.sources.freeze(slot.key);
    this.log(owner, 'Argument formation interrupted; native work retired while validated presentation remains charged', { revision: state.revision });
  }
  /** Primitive diagnostic/cache-key copy; no pool payload or reader escapes. */
  identities(owner: Owner): SyntaxIdentity[] {
    return this.states.get(owner)?.slots.map(({ key, version, language, complete, palette, fallback }) =>
      ({ key, version, language, complete, palette, fallback })) ?? [];
  }

  /** Temporary presentation loss is not owner loss or proof that physical work stopped. */
  pause(owner: Owner): void {
    const state = this.states.get(owner);
    if (!state) return;
    if (!state.paused) this.log(owner, 'Source presentation paused; this does not prove native work stopped', { revision: state.revision });
    state.paused = true;
    if (state.record) this.unqueue(state.record);
  }
  remove(owner: Owner): void {
    const state = this.states.get(owner); this.states.delete(owner);
    if (state?.record) this.release(state.record);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.latest = undefined;
    for (const ticket of this.pending) ticket.queued = undefined;
    this.pending.length = 0;
    for (const ticket of this.records.values()) this.release(ticket);
  }
  /** Internal weak finalizer delivery, also used by explicit removal. */
  release(ticket: RecordTicket): void {
    if (!this.records.delete(ticket.id)) return;
    this.log(ticket.owner.deref() as Owner | undefined, 'Source owner released', { ticket: ticket.id, sources: ticket.keys.size });
    collected.unregister(ticket); this.unqueue(ticket);
    if (this.latest?.ticket === ticket) this.latest = undefined;
    for (const key of ticket.keys) { this.keys.delete(key); this.client.sources.remove(key); }
    this.bytes -= ticket.bytes; ticket.keys.clear();
    const state = ticket.state.deref();
    if (state) { state.slots = []; state.display = undefined; state.record = undefined; }
  }
  /** Internal scheduled entry: source preparation and work are outside render. */
  drain(): void {
    if (this.disposed) { this.scheduled = false; return; }
    // Keep reentrant enqueue from scheduling a microtask that skips the host yield.
    this.scheduled = true;
    const pending: RecordTicket[] = [];
    while (this.pending.length && pending.length < CONTROLLER_LIMITS.jobs) {
      const ticket = this.pending.pop()!;
      ticket.queued = undefined; pending.push(ticket);
    }
    if (!pending.length) { this.scheduled = false; return; }
    let changed = false;
    for (const ticket of pending) {
      const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
      if (!owner || !state) { this.release(ticket); continue; }
      if (!this.current(owner, state, ticket)) continue;
      const revision = state.revision, themeRevision = this.themeRevision, input = this.host.read(owner);
      if (!this.current(owner, state, ticket) || state.revision !== revision || this.themeRevision !== themeRevision) continue;
      if (!input) { this.remove(owner); this.host.invalidate(owner); changed = true; continue; }
      const prepared = input.kind === 'file' && !input.node.result?.isError ? prepareFileCard(input.node) : undefined;
      const command = input.kind === 'bash' ? bashCommandSource(input.args) : undefined;
      if (input.kind === 'file' && !prepared || input.kind === 'bash' && command === undefined) {
        // Unsupported preparation is temporary presentation loss, not physical owner loss.
        this.pause(owner); this.host.invalidate(owner); changed = true; continue;
      }
      // A revision represents a host source event; ready/profile retry reuses it.
      const newVersion = state.processed !== revision;
      if (newVersion) state.version++;
      const demands = prepared ? prepared.sources.map(source => ({ text: source.text, rows: source.rows, side: source.side }))
        : [{ text: command!, rows: undefined, side: undefined }];
      const language = wireHint(input.language, 128), path = wireHint(prepared?.path, 4096);
      if (newVersion) this.log(owner, 'Logical source prepared outside render', { ticket: ticket.id, kind: input.kind, revision,
        version: state.version, language: language ?? 'unknown', segments: demands.length, complete: input.kind === 'file' || input.complete });
      const slots: Slot[] = [];
      for (let index = 0; index < demands.length; index++) {
        const key = `card:${ticket.id}:${index}`, demand = demands[index]!;
        const slot: Slot = { key, version: state.version, language, complete: input.kind === 'file' || input.complete,
          palette: input.palette, fallback: input.kind === 'bash' ? 'neutral' : 'pi', rows: demand.rows, side: demand.side, outcome: 'refused' };
        slots.push(slot);
        if (demand.text.length > RETENTION_LIMITS.maxSourceUnits) {
          // No strict submission and no key removal: older physical work still
          // owns the canonical held-work veto, regardless of this plain display.
          slot.outcome = this.client.sources.workStatus(key).fallbackEligible ? 'refused' : 'waiting';
          continue;
        }
        if (!ticket.keys.has(key)) {
          const bytes = keyBytes(key);
          if (this.bytes + bytes > this.maxBytes) continue;
          ticket.keys.add(key); this.keys.set(key, ticket); ticket.bytes += bytes; this.bytes += bytes;
        }
        const work = requestSyntax(this.client, { ...slot, text: demand.text, path, nativeProfile: this.displayProfile ?? null }, this.host.classify);
        slot.outcome = work.outcome; slot.awaitingProvider = work.awaitingProvider;
        this.log(owner, 'Syntax work evaluated', { source: key, version: slot.version, units: demand.text.length,
          language: language ?? 'unknown', palette: slot.palette, outcome: slot.outcome, awaitingProvider: !!slot.awaitingProvider });
        if (!this.current(owner, state, ticket) || state.revision !== revision || this.themeRevision !== themeRevision) break;
      }
      if (!this.current(owner, state, ticket)) {
        // A classifier/host may synchronously remove its owner before publication.
        if (!state.paused || this.states.get(owner) !== state || this.records.get(ticket.id) !== ticket)
          for (const slot of slots) this.client.sources.remove(slot.key);
        continue;
      }
      if (state.revision !== revision || this.themeRevision !== themeRevision) continue;
      for (const key of ticket.keys) if (!slots.some(slot => slot.key === key)) {
        ticket.keys.delete(key); this.keys.delete(key); this.client.sources.remove(key);
        const bytes = keyBytes(key); ticket.bytes -= bytes; this.bytes -= bytes;
      }
      state.slots = slots; state.display = prepared ? displayFileCard(prepared) : undefined;
      state.kind = input.kind; state.processed = revision; state.preparedTheme = themeRevision;
      if (state.awaitingTheme) {
        const metadata = this.client.snapshot();
        if (metadata.enabled && metadata.provider.availability === 'ready' && metadata.effective) state.awaitingTheme = undefined;
      }
      // A prepared neutral Bash fallback is identical to its already painted command.
      if (input.kind !== 'bash' || this.bashStamp(state) !== (state.paintedStamp ?? 0)) {
        this.host.invalidate(owner); changed = true;
      }
    }
    if (changed && !this.disposed) this.host.requestRender();
    // Existing controller dispatcher/credit/retry machinery remains the sole owner.
    if (!this.disposed) this.client.sources.flush();
    // Flush can queue notifications before pending is populated again. Keep the
    // barrier through a host turn; an empty continuation stops immediately.
    this.scheduled = !this.disposed;
    if (this.scheduled) setImmediate(continuation(this.owner));
  }

  private log(owner: Owner | undefined, explanation: string, fields: DiagnosticFields): void {
    if (!this.host.diagnostic) return;
    try { diagnose(this.host.diagnostic, 'DEBUG', 'syntax', explanation,
      { ...(owner ? this.host.identify?.(owner) : undefined), ...fields }); } catch { /* Identity observers do not own source work. */ }
  }
  private paintDecision(owner: Owner, slot: Slot, resolution: SyntaxResolution, applied: boolean): void {
    if (!this.host.diagnostic) return;
    const selected = applied ? resolution.nativeExact ? 'exact-native' : resolution.pi ? resolution.piStyled === false ? 'plain-pi' : resolution.piStyled === true ? 'styled-pi' : 'pi-unknown' : resolution.committedBytes === 0 ? 'neutral-retained' : 'retained-native'
      : slot.fallback === 'neutral' ? 'toolTitle' : 'plain';
    const marker = `${selected}:${resolution.execution}:${resolution.fallbackEligible}:${resolution.nativeGeneration}:${resolution.piGeneration}:${slot.palette}`;
    if (slot.paintDecision === marker) return;
    slot.paintDecision = marker;
    const explanations = {
      'exact-native': 'Occipital classification applied; unclassified glyphs keep their neutral color',
      'retained-native': 'Retained native ranges selected for the committed prefix; remaining text keeps its neutral color',
      'neutral-retained': 'Retained native projection has no committed prefix; whole source is neutral',
      'plain-pi': 'Cached Pi fallback applied; Pi returned plain text',
      'styled-pi': 'Cached Pi fallback applied; style directives are not proof of physical colors',
      'pi-unknown': 'Cached Pi fallback applied; style information was not supplied',
      toolTitle: resolution.fallbackEligible ? 'Whole Bash command uses toolTitle; Pi classification is intentionally disabled'
        : 'Native work is queued, unsettled or uncertain; Bash keeps toolTitle without Pi classification',
      plain: resolution.fallbackEligible ? 'Full text shown without prepared coloring; see source preparation/refusal/failure records'
        : 'Native work is queued, unsettled or uncertain; full text shown without duplicate Pi classification',
    };
    this.log(owner, explanations[selected], { source: slot.key, version: slot.version, palette: slot.palette, selected,
      execution: resolution.execution, fallbackEligible: resolution.fallbackEligible, committedBytes: resolution.committedBytes, demandOutcome: slot.outcome });
  }
  private logBashPaint(owner: Owner, state: State, slot: Slot, applied: boolean, basisVersion: number, coverage?: HistoricalBashCoverage): void {
    if (!this.host.diagnostic) return;
    const selected = applied ? coverage?.styledBytes ? state.frozen ? 'frozen-native-prefix' : 'historical-native-prefix' : 'neutral-retained' : 'toolTitle';
    const marker = `${selected}:${state.paintedStamp}:${slot.palette}:${coverage?.matchedBytes}:${coverage?.styledBytes}`;
    if (slot.paintDecision === marker) return;
    slot.paintDecision = marker;
    this.log(owner, coverage?.styledBytes ? 'Bash displays current text with compatible historical-prefix styles; these are not parser authority'
      : 'Compatible Bash display basis supplies no inherited glyph styles; current text uses toolTitle', {
      source: slot.key, revision: state.revision, version: slot.version, basisVersion, palette: slot.palette, selected,
      displayStamp: state.paintedStamp, matchedBytes: coverage?.matchedBytes ?? 0, styledBytes: coverage?.styledBytes ?? 0, demandOutcome: slot.outcome });
  }
  private current(owner: Owner, state: State, ticket: RecordTicket): boolean {
    return !this.disposed && !state.paused && !state.frozen && this.states.get(owner) === state && this.records.get(ticket.id) === ticket;
  }
  // Stable card order, not retry order. New tickets append; batches pop newest first.
  private pendingIndex(id: number): number {
    let left = 0, right = this.pending.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (this.pending[middle]!.id < id) left = middle + 1;
      else right = middle;
    }
    return left;
  }
  private unqueue(ticket: RecordTicket): void {
    if (!ticket.queued) return;
    this.pending.splice(this.pendingIndex(ticket.id), 1); ticket.queued = undefined;
  }
  private enqueue(ticket: RecordTicket): void {
    if (!this.records.has(ticket.id)) return;
    const state = ticket.state.deref();
    if (state) state.requestedTheme = this.themeRevision;
    if (!ticket.queued) {
      this.pending.splice(this.pendingIndex(ticket.id), 0, ticket); ticket.queued = true;
    }
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(continuation(this.owner)); }
  }
  private metadataIdentity(snapshot = this.client.snapshot()): string {
    const selection = snapshot.selected.kind === 'pi' ? 'pi' : `occipital:${snapshot.selected.id}`;
    if (this.selection !== undefined && this.selection !== selection) { this.themeRevision++; this.effectiveTheme = undefined; }
    this.selection = selection;
    if (snapshot.enabled && snapshot.effective) {
      const effective = JSON.stringify([snapshot.effective.id, snapshot.effective.fingerprint]);
      // First publication is availability, not a user theme change. Preserve the
      // last identity across outages/off so recovery of the same theme is warm.
      if (this.effectiveTheme !== undefined && this.effectiveTheme !== effective) this.themeRevision++;
      this.effectiveTheme = effective;
    }
    if (!snapshot.enabled || this.displayProfile?.selection !== selection || snapshot.provider.availability === 'ready') this.displayProfile = undefined;
    if (snapshot.enabled && snapshot.effective) this.displayProfile = { id: snapshot.effective.id, fingerprint: snapshot.effective.fingerprint, selection };
    return JSON.stringify([snapshot.enabled, snapshot.provider.availability, snapshot.provider.generation, selection,
      snapshot.effective?.id, snapshot.effective?.fingerprint]);
  }
}
