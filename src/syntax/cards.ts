import { bashCommandSource } from '../bash-card.ts';
import type { CardTheme } from '../card-theme.ts';
import { displayFileCard, prepareFileCard, type FileDisplayCard } from '../file-card.ts';
import type { SyntaxClient } from '../occipital/client.ts';
import { CONTROLLER_LIMITS, type SourceController } from '../occipital/controller.ts';
import { RETENTION_LIMITS } from '../occipital/retention.ts';
import { paintBashSyntax, paintFileSyntax, requestSyntax, resolveSyntax,
  type PiClassifier, type SyntaxIdentity, type SyntaxWorkResult } from './work.ts';

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
}
type Slot = SyntaxIdentity & { rows?: readonly number[]; side?: 'old' | 'next'; outcome: SyntaxWorkResult['outcome'] };
type State = { revision: number; requested?: number; processed?: number; version: number; slots: Slot[];
  display?: FileDisplayCard; kind?: 'file' | 'bash'; record?: RecordTicket; paused?: boolean };
type RecordTicket = { id: number; owner: WeakRef<object>; state: WeakRef<State>; keys: Set<string>; bytes: number };
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
  private readonly pending = new Set<RecordTicket>();
  private latest?: { ticket: RecordTicket; revision: number };
  private bytes = 0;
  private readonly maxBytes: number;
  private scheduled = false;
  private disposed = false;
  private metadata: string;

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
    if (state.revision === revision) return;
    state.revision = revision;
    if (this.latest && this.latest.ticket === state.record) this.latest.revision = revision;
    if (complete && state.record && !state.paused) this.enqueue(state.record);
  }

  /** Explicit genuinely useful intermediate/final demand. Equal processed or
   * pending revisions are warm visits: no source work or request scheduling.
   * Bash fallback always remains the legacy whole-command toolTitle style. */
  useful(owner: Owner, revision: number): void {
    if (this.disposed) return;
    let state = this.states.get(owner);
    if (!state?.paused && state?.revision === revision && (state.processed === revision || state.requested === revision)) return;
    if (!state) { state = { revision, version: 0, slots: [] }; this.states.set(owner, state); }
    else state.revision = revision;
    state.paused = false;
    state.requested = revision;
    if (!state.record) {
      if (this.bytes + RETENTION_LIMITS.entryAllowance > this.maxBytes) return;
      const ticket: RecordTicket = { id: ++sequence, owner: new WeakRef(owner), state: new WeakRef(state), keys: new Set(), bytes: RETENTION_LIMITS.entryAllowance };
      state.record = ticket; this.records.set(ticket.id, ticket); this.bytes += ticket.bytes;
      collected.register(owner, { consumer: this.owner, sources: new WeakRef(this.client.sources), ticket }, ticket);
    }
    this.latest = { ticket: state.record, revision };
    this.enqueue(state.record);
  }

  /** Wire to SyntaxClient.onChange. A real metadata transition upgrades at most
   * the latest still-current useful demand, never all prepared transcript cards. */
  metadataChanged(): void {
    if (this.disposed) return;
    const identity = this.metadataIdentity();
    if (identity === this.metadata) return;
    this.metadata = identity;
    const latest = this.latest, state = latest?.ticket.state.deref();
    if (latest && !state?.paused && state?.revision === latest.revision) this.enqueue(latest.ticket);
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
      if (state.paused || state.processed !== state.revision) continue;
      const needsWork = state.slots.some(slot => {
        const work = this.client.sources.workStatus(slot.key);
        return work.profileRetryAllowed || slot.outcome === 'waiting' &&
          resolveSyntax(this.client.sources, slot, 0x40000000).needsPi;
      });
      if (needsWork) this.enqueue(ticket);
      else { this.host.invalidate(owner); changed = true; }
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
      const rows = paintFileSyntax(this.client.sources, resolveSyntax(this.client.sources, slot, neutralStyle), theme);
      if (!rows) continue;
      slot.rows?.forEach((index, row) => {
        if (slot.side === 'next' || state.display!.lines[index]?.kind === '-') styledRows.set(index, rows[row]!);
      });
    }
    return { display: state.display, styledRows };
  }
  bash(owner: Owner, width: number, theme: CardTheme, neutralStyle: number): string[] | undefined {
    const state = this.states.get(owner), slot = state?.slots[0];
    if (this.disposed || state?.paused || state?.processed !== state?.revision || state?.kind !== 'bash' || !slot) return undefined;
    return paintBashSyntax(this.client.sources, resolveSyntax(this.client.sources, slot, neutralStyle), width, theme);
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
    state.paused = true;
    if (state.record) this.pending.delete(state.record);
  }
  remove(owner: Owner): void {
    const state = this.states.get(owner); this.states.delete(owner);
    if (state?.record) this.release(state.record);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.latest = undefined;
    for (const ticket of this.records.values()) this.release(ticket);
    this.pending.clear();
  }
  /** Internal weak finalizer delivery, also used by explicit removal. */
  release(ticket: RecordTicket): void {
    if (!this.records.delete(ticket.id)) return;
    collected.unregister(ticket); this.pending.delete(ticket);
    if (this.latest?.ticket === ticket) this.latest = undefined;
    for (const key of ticket.keys) { this.keys.delete(key); this.client.sources.remove(key); }
    this.bytes -= ticket.bytes; ticket.keys.clear();
    const state = ticket.state.deref();
    if (state) { state.slots = []; state.display = undefined; state.record = undefined; }
  }
  /** Internal microtask entry: source preparation and work are outside render. */
  drain(): void {
    this.scheduled = false;
    if (this.disposed) return;
    const pending = [...this.pending]; this.pending.clear();
    let changed = false;
    for (const ticket of pending) {
      const owner = ticket.owner.deref() as Owner | undefined, state = ticket.state.deref();
      if (!owner || !state) { this.release(ticket); continue; }
      if (!this.current(owner, state, ticket)) continue;
      const revision = state.revision, input = this.host.read(owner);
      if (!this.current(owner, state, ticket) || state.revision !== revision) continue;
      if (!input) { this.remove(owner); this.host.invalidate(owner); changed = true; continue; }
      const prepared = input.kind === 'file' && !input.node.result?.isError ? prepareFileCard(input.node) : undefined;
      const command = input.kind === 'bash' ? bashCommandSource(input.args) : undefined;
      if (input.kind === 'file' && !prepared || input.kind === 'bash' && command === undefined) {
        // Unsupported preparation is temporary presentation loss, not physical owner loss.
        this.pause(owner); this.host.invalidate(owner); changed = true; continue;
      }
      // A revision represents a host source event; ready/profile retry reuses it.
      if (state.processed !== revision) state.version++;
      const demands = prepared ? prepared.sources.map(source => ({ text: source.text, rows: source.rows, side: source.side }))
        : [{ text: command!, rows: undefined, side: undefined }];
      const language = wireHint(input.language, 128), path = wireHint(prepared?.path, 4096);
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
        slot.outcome = requestSyntax(this.client, { ...slot, text: demand.text, path }, this.host.classify).outcome;
        if (!this.current(owner, state, ticket) || state.revision !== revision) break;
      }
      if (!this.current(owner, state, ticket)) {
        // A classifier/host may synchronously remove its owner before publication.
        if (!state.paused || this.states.get(owner) !== state || this.records.get(ticket.id) !== ticket)
          for (const slot of slots) this.client.sources.remove(slot.key);
        continue;
      }
      if (state.revision !== revision) continue;
      for (const key of ticket.keys) if (!slots.some(slot => slot.key === key)) {
        ticket.keys.delete(key); this.keys.delete(key); this.client.sources.remove(key);
        const bytes = keyBytes(key); ticket.bytes -= bytes; this.bytes -= bytes;
      }
      state.slots = slots; state.display = prepared ? displayFileCard(prepared) : undefined;
      state.kind = input.kind; state.processed = revision;
      // A prepared neutral Bash fallback is identical to its already painted command.
      if (input.kind !== 'bash' || slots.some(slot => slot.outcome !== 'neutral')) {
        this.host.invalidate(owner); changed = true;
      }
    }
    if (changed && !this.disposed) this.host.requestRender();
    // Existing controller dispatcher/credit/retry machinery remains the sole owner.
    if (!this.disposed) this.client.sources.flush();
  }

  private current(owner: Owner, state: State, ticket: RecordTicket): boolean {
    return !this.disposed && !state.paused && this.states.get(owner) === state && this.records.get(ticket.id) === ticket;
  }
  private enqueue(ticket: RecordTicket): void {
    if (!this.records.has(ticket.id)) return;
    this.pending.add(ticket);
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(continuation(this.owner)); }
  }
  private metadataIdentity(): string {
    const snapshot = this.client.snapshot();
    return JSON.stringify([snapshot.enabled, snapshot.provider.availability, snapshot.provider.generation,
      snapshot.effective?.id, snapshot.effective?.fingerprint]);
  }
}
