import { type DiagnosticFields, type DiagnosticLevel, type DiagnosticSink, diagnose, diagnosticError } from '../diagnostics.ts';
import { decodeClosed, decodeSources, PROTOCOL_VERSION, RemoteFault, type Description, type ExpectedSource } from './protocol.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';
import { RequestFailure } from './request-failure.ts';
import type { ProviderBroker } from './provider.ts';
import { RetentionPool, RETENTION_LIMITS, type ReleaseReceipt } from './retention.ts';

// Separate captured/codec application credit, not V8/SDK/parser heap or RSS.
// UTF16 capture/replacement/request slices:6*S; suffix codec buffer:S;
// encoded request, its UTF16 JSON and reply lanes:4*F; wire numeric pairs plus
// canonical Uint32 pairs:24*R; style/bookkeeping allowances:128*T +33792.
export function sourceReservation(facts: { captureUnits: number; replacementUnits: number; inputUnits: number;
  replacementBytes: number; frameBytes: number; runs: number; styles: number }): number {
  for (const value of Object.values(facts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid source reservation');
  const runs = Math.min(facts.runs, facts.replacementBytes);
  return 2*(facts.captureUnits + facts.replacementUnits + facts.inputUnits) + facts.replacementBytes
    + 4*facts.frameBytes + 24*runs + 128*Math.min(facts.styles, runs) + 32768 + 1024;
}
const fullFamily = sourceReservation({ captureUnits: OCCIPITAL_LIMITS.sourceBytes, replacementUnits: OCCIPITAL_LIMITS.sourceBytes,
  inputUnits: OCCIPITAL_LIMITS.sourceBytes, replacementBytes: OCCIPITAL_LIMITS.sourceBytes,
  frameBytes: OCCIPITAL_LIMITS.wireBytes, runs: OCCIPITAL_LIMITS.runs, styles: OCCIPITAL_LIMITS.styles });
export const CONTROLLER_LIMITS = Object.freeze({ jobs: 2, transientBytes: 2*fullFamily,
  bookkeepingBytes: OCCIPITAL_LIMITS.retainedBytes, restarts: 1 });
export interface SourceDemand {
  key: string; version: number; text: string; language?: string; path?: string; profile: string; fingerprint: string; complete: boolean;
}
/** Payload-free preparation registered before expensive source construction. */
export interface SourcePreparation {
  readonly keys: ReadonlySet<string>;
  prepare(): void;
  /** Optional synchronous guard for a newer desired profile not prepared yet. */
  acceptsProfile?(profile: string, fingerprint: string): boolean;
  /** A global metadata refresh reconsiders usefulness without reading source text. */
  needsRefresh?(newest: boolean): boolean;
  requiresCredit?(): boolean;
}
export type SourceWorkGroup = { readonly preparation: WeakRef<SourcePreparation>; readonly keys: ReadonlySet<string> };
type WorkEntry = SourceWorkGroup | SourceState;
type WorkNode = { value: WorkEntry; pending: false | 'native' | 'local'; epoch: number; seen: number; older?: WorkNode; newer?: WorkNode };
const groupBytes = 128;

export interface ControllerOptions {
  diagnostic?: DiagnosticSink;
  deadlineMs?: number; admission?: 'try_now' | 'bounded_queue'; queueWaitMs?: number;
  maxTransientBytes?: number; maxBookkeepingBytes?: number;
  retention?: ConstructorParameters<typeof RetentionPool>[0];
  /** Coalesced asynchronous notice after accepted colors or terminal source state changes.
   * Keys identify only still-current changed sources; no transcript scan is needed. */
  onChange?: (keys: readonly string[]) => void;
}
type Provider = Pick<ProviderBroker, 'snapshot' | 'isReady' | 'request' | 'classificationAccepted'>;
type Execution = 'not_started' | 'unsettled' | 'acknowledged' | 'unknown' | 'started';
export type PiFailure = 'threw' | 'invalid_rows';
export interface SourceWorkStatus {
  version?: number; execution: Execution; fallbackEligible: boolean; profileRetryAllowed: boolean;
}
export type DisplayRangeReader = (consume: (start: number, end: number, packedStyle: number) => void) => boolean;
export interface SourceDisplayBasis {
  generation: number; version: number; stamp: number; language?: string; profile: string; fingerprint: string; complete: boolean; exactVersion?: number;
  visit(consume: (text: string, read: DisplayRangeReader) => void): boolean;
}
type SourceState = {
  id: number; key: string; group?: SourceWorkGroup; generation?: number; previous?: number; previousCoverage?: boolean; committedUnits: number;
  // Last validated display identity is independent of the currently requested profile.
  // Its bounded protocol strings fit the existing per-entry bookkeeping allowance.
  displayStamp: number; displayProfile?: string; displayFingerprint?: string; displayVersion?: number; frozen?: boolean;
  // Earliest observed version with this same text/identity. This aliases local
  // coverage only; pool/remote acknowledgement versions remain unchanged.
  version: number; contentVersion: number; language?: string; path?: string; profile: string; fingerprint: string; complete: boolean;
  provider: number; dirty: boolean; lease?: string; execution: Execution; blocked: boolean;
  uncertain: boolean; restarts: number; retryUsed: boolean; retryPending: boolean; empty: boolean; bytes: number;
  profileRefusal: number; profileReady: boolean; profileRetryUsed: boolean; retired?: boolean;
  sharedUnknown?: boolean; ownedUnknown?: number;
};
type PiSource = { storageKey: string; generation?: number; version: number; contentVersion: number;
   language?: string; palette?: number; failure?: PiFailure; refused?: boolean; styleDirectives?: boolean; bytes: number };
type Close = { key: string; ownerKey: string; generation: number; lease: string; provider: number; bytes: number };
type Job = { id: number; provider: number; generation: number; key: string; stateId: number; ticket: string;
  abort: AbortController; bytes: number; description: Description; reserved: boolean;
  source?: { capture: Readonly<{ version: number; text: string }>; expected: ExpectedSource; replaceUnits: number; open: boolean };
  close?: Close; sourceWork?: boolean; kind?: 'shared' | 'owned'; stopped?: boolean; lifetimeRef?: WeakRef<Job> };
type Lifetime = { bytes: number; owner: WeakRef<SourceController>; jobs: Set<WeakRef<Job>> };
let nextController = 0;
const ignored = () => {};
// A signal can outlive its owner; a receiver-created abort stack retains it.
const sourceRetired = new Error('occipital source retired');
// Credit survives owner GC and abort, until actual terminal settlement. Module
// incarnation only: parent reload/provider cleanup remains an integration gate.
const flight = { jobs: 0, bytes: 0, bookkeepingBytes: 0 };
const waiters = new Set<WeakRef<SourceController>>();
const lifetimes = new FinalizationRegistry<Lifetime>(lifetime => {
  flight.bookkeepingBytes -= lifetime.bytes; lifetime.bytes = 0; waiters.delete(lifetime.owner);
  // At most the already reserved physical jobs. Dead owners need no reply
  // validation; keep physical credit until settlement, not their source payload.
  for (const reference of lifetime.jobs) { const job = reference.deref(); if (job) { job.source = undefined; job.abort.abort(sourceRetired); } }
  lifetime.jobs.clear();
});
function releaseCredit(job: Job): void {
  if (!job.reserved) return;
  job.reserved = false; flight.jobs--; flight.bytes -= job.bytes;
  const pending = [...waiters]; waiters.clear();
  for (const owner of pending) owner.deref()?.wake();
}
function waitForCredit(owner: WeakRef<SourceController>): void {
  // Membership is prepaid by each owner's128-byte lifetime ticket. There is no
  // independent waiter count ceiling or abandoned live callback at a magic count.
  for (const waiter of waiters) if (!waiter.deref()) waiters.delete(waiter);
  waiters.add(owner);
}
function completion(owner: WeakRef<SourceController>, job: Job) {
  return { reply: (value: unknown) => { try { owner.deref()?.settle(job, value, false); } finally { releaseCredit(job); } },
    failed: (_error: unknown) => { try { owner.deref()?.settle(job, _error, true); } finally { releaseCredit(job); } } };
}
function continuation(owner: WeakRef<SourceController>) { return () => owner.deref()?.flush(); }
function preparationTurn(owner: WeakRef<SourceController>) { return () => owner.deref()?.resumePreparation(); }
function notice(owner: WeakRef<SourceController>, epoch: number) { return () => owner.deref()?.notifyChange(epoch); }
function displayVisit(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (text: string, read: DisplayRangeReader) => void) => owner.deref()?.visitDisplayBasis(key, id, generation, version, stamp, consume) ?? false;
}
function displayRanges(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number): DisplayRangeReader {
  return consume => owner.deref()?.visitDisplayRanges(key, id, generation, version, stamp, consume) ?? false;
}
function identifier(value: unknown, cap = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
    && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function coherent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c >= 0xd800 && c <= 0xdbff) { const n = text.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) return false; }
  }
  return true;
}
function duration(value: number) { if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error('invalid controller duration'); return value; }
function stateBytes(demand: SourceDemand): number {
  return RETENTION_LIMITS.entryAllowance + 2*(demand.key.length + (demand.language?.length ?? 0)
    + (demand.path?.length ?? 0) + demand.profile.length + demand.fingerprint.length);
}

/** One UI-independent active source owner. Caller flushes after render; observe
 * and reads never prepare/encode/dispatch. Strings/ranges are solely pooled or in
 * two charged captures. Tombstones contain primitives and suppress pressure
 * carousels; off keeps physical-work evidence, removal/disposal drops it.
 * Primitive record credit is bounded separately by the same generous retained-family allowance, not a count cap. */
export class SourceController {
  private readonly provider: Provider;
  private readonly pool: RetentionPool;
  private readonly options: ControllerOptions;
  private readonly maxTransientBytes: number;
  private readonly maxBookkeepingBytes: number;
  private readonly id = ++nextController;
  private readonly owner = new WeakRef(this);
  private readonly lifetime: Lifetime = { bytes: 0, owner: this.owner, jobs: new Set() };
  private sequence = 0;
  private wireSequence = 0;
  private stateSequence = 0;
  private displaySequence = 0;
  private enabled = true;
  private disposed = false;
  private scheduled = false;
  private noticeScheduled = false;
  private preparing?: SourceWorkGroup;
  private preparations = 0;
  private yielding = false;
  private pumping = false;
  // One chronological registry selects both lazy groups and standalone sources.
  private readonly work = new Map<WorkEntry, WorkNode>();
  private newest?: WorkNode;
  private cursor?: WorkNode;
  private workPass = 0;
  private refreshEpoch = 0;
  private localPending = 0;
  private workProvider = -1;
  private workReady = false;
  private retryScan = false;
  private creditBlocked = false;
  // Primitive key aliases only, prepaid by each source's existing entry allowance.
  // Explicit removal drops its slot; delivery/off release the pending packet.
  private readonly noticeKeys = new Set<string>();
  private noticeEpoch = 0;
  private leaseProvider = -1;
  private profileSequence = 0;
  private profileNeed?: { generation: number; sequence: number };
  private remoteLeases = 0;
  private transientBytes = 0;
  private states = new Map<string, SourceState>();
  private readonly piSources = new Map<string, PiSource>();
  private readonly piGenerations = new Map<number, PiSource>();
  private jobs = new Map<number, Job>();
  private closes: Close[] = [];
  private counters = { dispatches: 0, preparedBytes: 0, decodedBytes: 0, staleReplies: 0, restarts: 0,
    committedLineCalls: 0, committedLineBytes: 0, tailCalls: 0, tailBytes: 0, cleanupRefusals: 0,
    peakTransientBytes: 0, peakJobs: 0 };

  constructor(provider: Provider, options: ControllerOptions = {}) {
    const deadlineMs = duration(options.deadlineMs ?? OCCIPITAL_LIMITS.dataDeadlineMs);
    if (options.onChange !== undefined && typeof options.onChange !== 'function') throw new Error('invalid controller observer');
    if (options.admission !== undefined && options.admission !== 'try_now' && options.admission !== 'bounded_queue') throw new Error('invalid controller admission');
    if (options.queueWaitMs !== undefined) duration(options.queueWaitMs);
    this.maxTransientBytes = options.maxTransientBytes ?? CONTROLLER_LIMITS.transientBytes;
    this.maxBookkeepingBytes = options.maxBookkeepingBytes ?? CONTROLLER_LIMITS.bookkeepingBytes;
    for (const [value, cap] of [[this.maxTransientBytes, CONTROLLER_LIMITS.transientBytes], [this.maxBookkeepingBytes, CONTROLLER_LIMITS.bookkeepingBytes]]) {
      if (!Number.isSafeInteger(value) || value! < 128 || value! > cap!) throw new Error('invalid controller byte limit');
    }
    this.provider = provider;
    this.options = { deadlineMs, admission: options.admission, queueWaitMs: options.queueWaitMs, onChange: options.onChange, diagnostic: options.diagnostic };
    this.pool = new RetentionPool(options.retention);
    if (!this.charge(128)) throw new Error('controller bookkeeping capacity');
    lifetimes.register(this, this.lifetime, this.lifetime);
  }

  registerPreparation(preparation: SourcePreparation): SourceWorkGroup | undefined {
    if (this.disposed || !this.charge(groupBytes)) return undefined;
    const group = { preparation: new WeakRef(preparation), keys: preparation.keys };
    this.addWork(group); return group;
  }
  queuePreparation(group: SourceWorkGroup, local = false): void {
    const node = this.work.get(group);
    if (!node || this.disposed) return;
    this.setPending(node, local || node.pending === 'local' ? 'local' : 'native'); this.rewind(); this.schedule();
  }
  pausePreparation(group: SourceWorkGroup): void {
    const node = this.work.get(group);
    if (node) { this.setPending(node, false); node.epoch = this.refreshEpoch; }
  }
  unregisterPreparation(group: SourceWorkGroup): void {
    if (!this.removeWork(group)) return;
    this.charge(-groupBytes);
    for (const key of group.keys) this.remove(key);
  }

  /** One revision/cursor reset, not a sweep or a second pending queue. */
  refreshPreparations(): void {
    if (this.disposed) return;
    this.refreshEpoch++; this.rewind(); this.schedule();
  }
  private addWork(value: WorkEntry): void {
    const node: WorkNode = { value, pending: false, epoch: this.refreshEpoch, seen: -1, older: this.newest };
    if (this.newest) this.newest.newer = node;
    this.newest = node; this.work.set(value, node); this.rewind();
  }
  private rewind(): void { this.workPass++; this.cursor = this.newest; }
  private setPending(node: WorkNode, pending: WorkNode['pending']): void {
    if (node.pending === 'local') this.localPending--;
    node.pending = pending;
    if (pending === 'local') this.localPending++;
  }
  private removeWork(value: WorkEntry): boolean {
    const node = this.work.get(value); if (!node) return false;
    this.setPending(node, false);
    if (node.older) node.older.newer = node.newer;
    if (node.newer) node.newer.older = node.older;
    else this.newest = node.older;
    if (this.cursor === node) this.cursor = node.older;
    node.older = undefined; node.newer = undefined;
    return this.work.delete(value);
  }

  observe(demand: SourceDemand): boolean {
    if (!this.enabled || this.disposed) return false;
    const { key, version, text, language, path, profile, fingerprint, complete } = demand;
    if (!identifier(key) || language !== undefined && !identifier(language, 128) || path !== undefined && !identifier(path, 4096)
      || !identifier(profile) || !/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isInteger(version) || version < 0 || version > 0xffffffff
      || typeof text !== 'string' || text.length > RETENTION_LIMITS.maxSourceUnits || typeof complete !== 'boolean') throw new Error('invalid source demand');
    const provider = this.provider.snapshot().generation;
    let state = this.states.get(key);
    if (state?.frozen) return false;
    if (state?.retired) {
      // Held jobs still veto fallback by key; unknown retired work stays
      // protective even when its native payload/lease has been removed.
      // Off/on is still the same source owner. Preserve primitive execution
      // evidence/id; only explicit remove creates a new owner incarnation.
      state.retired = false;
      if (!state.uncertain) state.retryPending = true;
    }
    if (state && version < state.version) throw new Error('non-monotonic source demand');
    // Caller versions identify logical text. Warm visits do not even perform a
    // prefix check or cached-source byte measurement; same-version text mutation
    // violates the caller contract (strings cannot themselves mutate).
    if (state && !state.profileReady && version === state.version && complete === state.complete && language === state.language && path === state.path
      && profile === state.profile && fingerprint === state.fingerprint && provider === state.provider && !state.retryPending) return state.generation !== undefined;
    if (!state) {
      const bytes = stateBytes(demand); if (!this.charge(bytes)) return false;
      state = { id: ++this.stateSequence, key, version, contentVersion: version, language, path, profile, fingerprint, complete, provider,
        dirty: false, committedUnits: 0, displayStamp: 0, execution: 'not_started', blocked: false, uncertain: false,
         restarts: 0, retryUsed: false, retryPending: false, empty: !text.length, bytes,
         profileRefusal: 0, profileReady: false, profileRetryUsed: false };
      if (this.preparing?.keys.has(key)) state.group = this.preparing;
      this.states.set(key, state);
      if (!state.group) this.addWork(state);
      return this.admit(state, text);
    }
    if (!state.group) this.rewind();
    const nextBytes = stateBytes(demand);
    if (!this.charge(nextBytes - state.bytes)) { this.dropData(state); state.blocked = true; state.dirty = false; return false; }
    state.bytes = nextBytes;
    const latest = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    const providerChange = state.provider !== provider;
    const identityChange = language !== state.language || path !== state.path || profile !== state.profile || fingerprint !== state.fingerprint;
    const latestComplete = state.complete;
    const formationChange = state.complete && !complete;
    const rewrite = !!latest && (!text.startsWith(latest.text) || !text.length && latest.text.length > 0
      || state.complete && text !== latest.text);
    const retry = state.retryPending, retryProfile = state.profileReady;
    state.retryPending = false; state.profileReady = false;
    const changed = version !== state.version || complete !== state.complete || identityChange || providerChange;
    const noOp = !retry && !retryProfile && latest?.text === text && state.complete === complete && !identityChange && !providerChange;
    if (state.displayVersion !== undefined) {
      const displayedText = latest ?? (state.previous === undefined ? undefined : this.pool.borrowSnapshot(state.previous, 'basis'));
      state.displayVersion = complete && state.displayVersion === state.version && displayedText?.text === text ? version : undefined;
    }
    if (latest?.text !== text || identityChange || formationChange) state.contentVersion = version;
    state.version = version; state.complete = complete; state.empty = !text.length;
    if (changed) { state.retryUsed = false; state.profileRetryUsed = false; }
    if (identityChange || providerChange || retryProfile) state.profileRefusal = 0;
    if (retryProfile) state.profileRetryUsed = true;
    const profileWait = state.profileRefusal > 0;
    if (identityChange || formationChange || rewrite) {
      const themeOnly = language === state.language && path === state.path && !formationChange && !rewrite;
      if (themeOnly || !identityChange && state.language === 'bash' && state.generation !== undefined) {
        state.profile = profile; state.fingerprint = fingerprint;
        state.blocked = (state.uncertain && !providerChange) || profileWait;
        const profileOnly = themeOnly && !providerChange && latest?.text === text && state.complete === latestComplete;
        this.restart(state, provider, providerChange, { version, text }, !profileOnly);
        return state.generation !== undefined;
      }
      this.dropData(state); state.language = language; state.path = path; state.profile = profile; state.fingerprint = fingerprint;
      state.blocked = (state.uncertain && !providerChange) || profileWait; state.provider = provider;
      if (providerChange) { state.uncertain = false; state.restarts = 0; }
      if (!state.uncertain) state.execution = 'not_started';
      return this.admit(state, text);
    }
    if (!latest) {
      if (providerChange) { state.uncertain = false; state.restarts = 0; }
      state.provider = provider; state.blocked = state.uncertain || profileWait || state.restarts > CONTROLLER_LIMITS.restarts;
      if (!state.uncertain) state.execution = 'not_started';
      return state.uncertain ? false : this.admit(state, text);
    }
    const result = this.pool.replaceSnapshot(state.generation!, version, text); this.receipts(result.released);
    if (!result.accepted || state.generation === undefined) return false;
    if (providerChange || retryProfile) this.restart(state, provider, providerChange);
    else {
      state.blocked = state.uncertain || profileWait || state.restarts > CONTROLLER_LIMITS.restarts;
      state.dirty = (state.dirty || !noOp) && !state.blocked;
      if (!state.uncertain && state.dirty) state.execution = 'not_started';
    }
    return state.generation !== undefined;
  }

  /** Current logical text for terminal projection; it remains owned by the same
   * native pool entry. Borrowing neither acknowledges colors nor retains a copy. */
  borrowSource(key: string) {
    const state = this.states.get(key), generation = state?.generation;
    if (!state || generation === undefined) return undefined;
    const source = this.pool.borrowSnapshot(generation);
    if (!source || source.version !== state.version) return undefined;
    return { ...source, generation, language: state.language, path: state.path,
      profile: state.profile, fingerprint: state.fingerprint, complete: state.complete };
  }

  /** Historical display reads are not current-source proof. Persistent views keep only weak ownership and primitives. */
  displayBasis(key: string): SourceDisplayBasis | undefined {
    const state = this.states.get(key);
    if (this.disposed || !this.enabled || !state || !state.displayStamp) return undefined;
    const generation = this.displayGeneration(state);
    if (generation === undefined) return undefined;
    const version = this.pool.status(generation)?.sourceVersion;
    if (version === undefined) return undefined;
    return { generation, version, stamp: state.displayStamp, language: state.language, profile: state.displayProfile!, fingerprint: state.displayFingerprint!,
      complete: this.pool.status(generation)?.complete ?? false, exactVersion: state.displayVersion,
      visit: displayVisit(this.owner, key, state.id, generation, version, state.displayStamp) };
  }
  displayStamp(key: string, profile?: string, fingerprint?: string, language?: string): number {
    const state = this.states.get(key);
    return !this.disposed && this.enabled && state && (profile === undefined || state.displayProfile === profile && state.displayFingerprint === fingerprint && state.language === language)
      ? state.displayStamp : 0;
  }
  private displayGeneration(state: SourceState): number | undefined {
    return state.generation !== undefined && this.pool.status(state.generation)?.sourceVersion !== undefined ? state.generation : state.previous;
  }
  private currentDisplay(key: string, id: number, generation: number, version: number, stamp: number): boolean {
    const state = this.states.get(key);
    return !this.disposed && this.enabled && state?.id === id && state.displayStamp === stamp
      && this.displayGeneration(state) === generation && this.pool.status(generation)?.sourceVersion === version;
  }
  /** Internal weak-view delivery; source text never escapes as a stored field. */
  visitDisplayBasis(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (text: string, read: DisplayRangeReader) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const basis = this.pool.borrowSnapshot(generation, 'basis');
    if (!basis || basis.version !== version) return false;
    consume(basis.text, displayRanges(this.owner, key, id, generation, version, stamp));
    return this.currentDisplay(key, id, generation, version, stamp);
  }
  visitDisplayRanges(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (start: number, end: number, style: number) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const available = this.pool.visitRanges(generation, (start, end, style) => {
      const state = this.states.get(key);
      if (state?.id === id && state.displayStamp === stamp && (state.generation === generation || state.previous === generation)) consume(start, end, style);
    });
    return available && this.currentDisplay(key, id, generation, version, stamp);
  }

  /** Exact Pi fallback snapshots share the native result pool but do not require
   * an enabled/available daemon. Caller prepares them outside render. */
  capturePiSource(key: string, version: number, text: string, language?: string): boolean {
    if (this.disposed) return false;
    if (!identifier(key) || !Number.isInteger(version) || version < 0 || version > 0xffffffff
      || typeof text !== 'string' || language !== undefined && !identifier(language, 128)) throw new Error('invalid Pi source');
    let state = this.piSources.get(key);
    if (state && version < state.version) throw new Error('non-monotonic Pi source');
    if (state?.refused && version === state.version) return false;
    if (state && version === state.version && language === state.language)
      return state.generation !== undefined && !!this.pool.status(state.generation);
    // UTF8 costs at most3 bytes per UTF16 unit. Only potentially oversized
    // sources need an additional byte scan before touching other retained data.
    if (text.length > OCCIPITAL_LIMITS.sourceBytes || text.length > OCCIPITAL_LIMITS.sourceBytes / 3
      && Buffer.byteLength(text) > OCCIPITAL_LIMITS.sourceBytes) return this.refusePiSource(state, version);
    if (!state) {
      const storageKey = this.wireKey(), bytes = RETENTION_LIMITS.entryAllowance + 2*(key.length + storageKey.length + (language?.length ?? 0));
      if (!this.charge(bytes)) return false;
      state = { storageKey, version, contentVersion: version, language, bytes };
      this.piSources.set(key, state);
    } else {
      const bytes = RETENTION_LIMITS.entryAllowance + 2*(key.length + state.storageKey.length + (language?.length ?? 0));
      if (!this.charge(bytes - state.bytes)) return this.refusePiSource(state, version);
      state.bytes = bytes;
      const old = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
      if (old?.text === text && state.language === language) {
        const result = this.pool.replaceSnapshot(state.generation!, version, text); this.receipts(result.released);
        state.version = version; return result.accepted && state.generation !== undefined;
      }
    }
    state.version = version; state.contentVersion = version; state.language = language; state.palette = undefined; state.failure = undefined; state.refused = false;
    if (state.generation !== undefined) this.receipts(this.pool.remove(state.generation));
    const result = this.pool.admit(state.storageKey, version, text); this.receipts(result.released);
    state.generation = result.generation;
    if (result.accepted) this.piGenerations.set(result.generation!, state);
    return result.accepted;
  }
  /** Fresh primitive capture with cached UTF8; never exposes owned row arrays. */
  borrowPiSource(key: string) {
    const state = this.piSources.get(key);
    const source = state?.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    return source && state ? { ...source, generation: state.generation!, language: state.language, styleDirectives: state.styleDirectives } : undefined;
  }
  installPiBridge(key: string, generation: number, version: number, text: string, palette: number, lines: readonly string[], styleDirectives?: boolean): boolean {
    if (!Number.isSafeInteger(palette) || palette < 0) throw new Error('invalid Pi palette revision');
    const state = this.piSources.get(key);
    if (this.disposed || !state || state.generation !== generation || state.version !== version
      || state.palette !== undefined && palette < state.palette || state.palette === palette && state.failure !== undefined) return false;
    const basis = this.pool.borrowSnapshot(generation, 'basis');
    if (!basis || basis.text !== text) return false;
    // Equal-text versions use the same basis. A newer alias must not invalidate
    // valid Pi rows or trigger another classifier merely for a lifecycle marker.
    const result = this.pool.installBridge(generation, basis.version, text, lines); this.receipts(result.released);
    if (result.accepted && state.generation === generation) {
      const changed = state.palette !== palette || state.failure !== undefined;
      state.palette = palette; state.failure = undefined; state.styleDirectives = styleDirectives;
      if (changed) this.log('DEBUG', styleDirectives === false ? 'Pi returned plain text; exact fallback cached' : 'Pi fallback cached; style directives are not proof of physical colors',
        { source: key, version, generation, palette, styleDirectives, bytes: basis.utf8Bytes });
    }
    return result.accepted && state.generation === generation;
  }
  /** Exact classifier failure, distinct from source/row storage refusal. */
  piFailure(key: string, version: number, palette: number): PiFailure | undefined {
    const state = this.piSources.get(key);
    return !this.disposed && state?.version === version && state.palette === palette ? state.failure : undefined;
  }
  /** Record before bridge installation, using the caller's primitive capture.
   * Reentrant source/version/palette changes cannot publish an obsolete failure. */
  recordPiFailure(key: string, generation: number, version: number, palette: number, failure: PiFailure): boolean {
    if (!Number.isSafeInteger(palette) || palette < 0 || failure !== 'threw' && failure !== 'invalid_rows') throw new Error('invalid Pi failure');
    const state = this.piSources.get(key);
    if (this.disposed || !state || state.generation !== generation || state.version !== version
      || state.palette !== undefined && palette < state.palette) return false;
    if (this.hasPiBridge(key, version, palette)) return false;
    const changed = state.palette !== palette || state.failure !== failure;
    state.palette = palette; state.failure = failure;
    if (changed) this.log('WARN', 'Pi fallback classification failed; exact failure cached', { source: key, version, generation, palette, reason: failure });
    return true;
  }
  hasPiBridge(key: string, version: number, palette: number): boolean {
    const state = this.piSources.get(key), generation = state?.generation;
    if (this.disposed || !state || generation === undefined || state.version !== version || state.palette !== palette || state.failure !== undefined) return false;
    const bridge = this.pool.bridgeVersion(generation);
    return bridge !== undefined && bridge >= state.contentVersion && bridge <= version;
  }
  visitPiBridge(key: string, version: number, palette: number, consume: (index: number, line: string) => void): boolean {
    if (!this.hasPiBridge(key, version, palette)) return false;
    const state = this.piSources.get(key)!, generation = state.generation!;
    const current = () => this.piSources.get(key) === state && state.generation === generation && state.palette === palette && state.version === version;
    const available = this.pool.visitBridge(generation, (index, line) => { if (current()) consume(index, line); });
    return available && current();
  }
  private refusePiSource(state: PiSource | undefined, version: number): false {
    if (state) {
      state.version = version; state.contentVersion = version; state.palette = undefined; state.failure = undefined; state.refused = true;
      if (state.generation !== undefined) this.receipts(this.pool.remove(state.generation));
    }
    return false;
  }
  removePiSource(key: string): void {
    const state = this.piSources.get(key); if (!state) return;
    this.piSources.delete(key); this.charge(-state.bytes);
    if (state.generation !== undefined) this.receipts(this.pool.remove(state.generation));
  }

  flush(): void {
    if (this.pumping) return;
    if (!this.yielding) this.scheduled = false;
    this.pumping = true;
    try {
      const snapshot = this.provider.snapshot();
      if (snapshot.generation !== this.leaseProvider) {
        this.leaseProvider = snapshot.generation; this.remoteLeases = 0;
        this.closes = this.closes.filter(close => { if (close.provider === snapshot.generation) return true; this.charge(-close.bytes); return false; });
      }
      const description = snapshot.availability === 'ready' ? snapshot.description : undefined;
      const ready = !!description && this.enabled;
      if (snapshot.generation !== this.workProvider || ready !== this.workReady) {
        this.workProvider = snapshot.generation; this.workReady = ready; this.rewind();
      }
      const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
      if (description) while (this.closes.length && this.jobs.size < jobLimit) {
        const index = this.closes.findIndex(close => !this.busy(close.ownerKey)); if (index === -1) break;
        const bytes = this.reservation(0, 0, 0, 0, description);
        if (!this.capacity(bytes)) { waitForCredit(this.owner); break; }
        const close = this.closes.splice(index, 1)[0]!; this.charge(-close.bytes);
        const job = this.job(close.ownerKey, close.generation, 0, snapshot.generation, description, bytes); job.close = close;
        this.dispatch(job, { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'stream.close',
          key: close.key, generation: close.generation, lease: close.lease });
      }
      const full = () => this.creditBlocked || this.jobs.size >= jobLimit || flight.jobs >= CONTROLLER_LIMITS.jobs;
      const dispatch = (state: SourceState | undefined): boolean => {
        if (!description || !this.enabled || this.disposed || !state || state.retired || !state.dirty || state.blocked
          || state.uncertain || state.provider !== snapshot.generation || this.busy(state.key)
          || state.group?.preparation.deref()?.acceptsProfile?.(state.profile, state.fingerprint) === false) return false;
        if (full()) { waitForCredit(this.owner); return true; }
        return this.prepare(state, description) === 'credit';
      };
      while (this.cursor && !this.disposed) {
        const node = this.cursor, entry = node.value, pass = this.workPass;
        this.cursor = node.older; node.seen = pass;
        if (!('preparation' in entry)) {
          if (dispatch(entry)) {
            if (this.localPending) { this.retryScan = true; continue; }
            this.cursor = node; break;
          }
          continue;
        }
        const preparation = entry.preparation.deref();
        if (!preparation) { this.unregisterPreparation(entry); continue; }
        const refresh = node.epoch !== this.refreshEpoch;
        if (node.pending || refresh && (preparation.needsRefresh?.(node === this.newest) ?? true)) {
          const native = !!description && this.enabled && node.pending !== 'local' && (preparation.requiresCredit?.() ?? true);
          if (native && full()) {
            waitForCredit(this.owner);
            if (this.localPending) { this.retryScan = true; continue; }
            this.cursor = node; break;
          }
          // A busy source may be skipped while a different owner uses the free slot.
          // Its actual settlement rewinds this visited entry if it still owes work.
          if (native && [...entry.keys].some(key => this.busy(key))) continue;
          if (this.preparations >= CONTROLLER_LIMITS.jobs) { this.cursor = node; break; }
          this.setPending(node, false); node.epoch = this.refreshEpoch; this.preparations++;
          this.preparing = entry;
          try { preparation.prepare(); } finally { this.preparing = undefined; }
        } else node.epoch = this.refreshEpoch;
        if (!this.work.has(entry) || pass !== this.workPass || node.pending || node.epoch !== this.refreshEpoch) continue;
        let waiting = false;
        for (const key of entry.keys) if (dispatch(this.states.get(key))) { waiting = true; break; }
        if (waiting) {
          if (this.localPending) { this.retryScan = true; continue; }
          this.cursor = node; break;
        }
      }
    } finally {
      this.pumping = false;
      if (this.preparations && !this.yielding) {
        this.yielding = true; this.scheduled = true;
        setImmediate(preparationTurn(this.owner));
      }
      this.finishLifetime();
    }
  }
  /** Reset only after a host turn; neither direct flush nor reply microtasks may
   * bypass the two-preparation barrier. An empty continuation stops immediately. */
  resumePreparation(): void {
    this.preparations = 0; this.yielding = false; this.scheduled = false; this.flush();
  }

  /** Physical source authority survives payload retirement/off. Reading never
   * admits storage or dispatches work; absence alone is only fresh-key no-start. */
  workStatus(key: string): SourceWorkStatus {
    const state = this.states.get(key);
    const pending = [...this.jobs.values()].some(job => job.sourceWork && !job.stopped && job.key === key);
    const queued = !!state && this.enabled && !state.retired && state.dirty && !state.blocked && !state.uncertain
      && this.provider.isReady(state.provider);
    const execution = pending ? 'unsettled' : state?.sharedUnknown || state?.ownedUnknown !== undefined
      ? state?.execution === 'started' ? 'started' : 'unknown' : state?.execution ?? 'not_started';
    return { version: state?.version, execution, fallbackEligible: !this.disposed && !state?.frozen && !pending && !queued && !state?.uncertain
        && (execution === 'not_started' || execution === 'acknowledged'),
      profileRetryAllowed: !!state && !state.retired && this.enabled && !this.disposed && state.profileReady
        && this.provider.isReady(state.provider) };
  }
  /** Only the broker's successful owned-child close/reap receipt may call this.
   * Generation matching never releases replacement/peer source authority. */
  ownedStopped(provider: number): void {
    for (const job of this.jobs.values()) if (job.provider === provider && job.sourceWork && job.kind === 'owned') {
      job.stopped = true; job.source = undefined;
      if (this.states.get(job.key)?.id === job.stateId) this.changed(job.key);
    }
    if (this.disposed) return;
    for (const state of this.states.values()) {
      const evidence = state.ownedUnknown === provider;
      if (evidence) state.ownedUnknown = undefined;
      if (state.provider === provider && (state.execution === 'unsettled' || state.uncertain)) {
        state.execution = 'not_started'; state.uncertain = false; state.dirty = false; this.changed(state.key);
      } else if (evidence) this.changed(state.key);
    }
  }
  status(key: string) {
    const state = this.states.get(key); if (!state || state.retired) return undefined;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const result = current?.sourceVersion !== undefined ? current : !state.previousCoverage || state.previous === undefined ? undefined : this.pool.status(state.previous);
    const exact = state.empty || this.matchesContent(state, result?.sourceVersion);
    // Waiting/retired demand is not execution proof: a still-held source job,
    // including a removed/reused key, remains the physical attempt authority.
    const execution = this.workStatus(key).execution;
    const provider = this.provider.snapshot();
    return { generation: state.generation, version: state.version,
      acknowledgedVersion: provider.generation === state.provider && provider.availability === 'ready' ? current?.sourceVersion : undefined,
      classificationVersion: result?.sourceVersion, committedBytes: result?.committedBytes ?? 0, exact,
      execution, availability: this.disposed ? 'disposed' : !this.enabled ? 'disabled' : provider.availability,
      protective: state.blocked || state.uncertain, fallbackEligible: !exact && this.workStatus(key).fallbackEligible, complete: state.complete };
  }
  visitRanges(key: string, consume: (start: number, end: number, packedStyle: number) => void): boolean {
    const state = this.states.get(key); if (!state) return false;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const generation = current?.sourceVersion !== undefined ? state.generation : state.previousCoverage ? state.previous : undefined;
    if (generation === undefined) return state.empty;
    const status = this.pool.status(generation); if (!status) return false;
    const limit = this.matchesContent(state, status.sourceVersion) ? status.sourceBytes : status.committedBytes;
    return this.pool.visitRanges(generation, (start, end, style) => {
      if (this.states.get(key) === state && start < limit) consume(start, Math.min(end, limit), style);
    });
  }
  stats() { return { ...this.counters, unsettledJobs: this.jobs.size, captures: [...this.jobs.values()].filter(job => job.source).length,
    globalUnsettledJobs: flight.jobs, globalTransientBytes: flight.bytes, transientBytes: this.transientBytes, maxTransientBytes: this.maxTransientBytes,
      remoteLeases: this.remoteLeases, pendingCloses: this.closes.length, sourceRecords: this.states.size, piSourceRecords: this.piSources.size,
    guardRecords: [...this.states.values()].filter(state => state.generation === undefined || state.uncertain).length,
    bookkeepingBytes: this.lifetime.bytes, globalBookkeepingBytes: flight.bookkeepingBytes, waitingOwners: waiters.size,
    retention: this.pool.stats() }; }
  /** Typed profile refusal requests only metadata. Reading it does not send work. */
  profileReconciliationNeeded(): Readonly<{ generation: number; sequence: number }> | undefined {
    return this.enabled && !this.disposed && this.profileNeed && this.provider.isReady(this.profileNeed.generation)
      ? { ...this.profileNeed } : undefined;
  }
  /** A validated catalogue permits one fresh generation only on a subsequent
   * current demand. Do not dispatch or sweep/recolor unrelated retained sources.
   * A response to an older notice cannot consume a later profile refusal. */
  acknowledgeProfiles(generation: number, sequence: number): void {
    if (!this.enabled || this.disposed || !this.provider.isReady(generation)) return;
    if (this.profileNeed?.generation === generation && this.profileNeed.sequence <= sequence) this.profileNeed = undefined;
    for (const state of this.states.values()) if (!state.retired && state.provider === generation && state.profileRefusal > 0 && state.profileRefusal <= sequence) {
      if (!state.profileReady) { state.profileReady = true; this.changed(state.key); }
    }
  }
  /** One explicit retry per unchanged demand. Caller must observe its full source
   * after permission, not issue retryEvicted from every render frame. */
  retryEvicted(key: string): boolean {
    const state = this.states.get(key);
    if (!this.enabled || this.disposed || !state || state.retired || state.uncertain || state.retryUsed || state.restarts > CONTROLLER_LIMITS.restarts) return false;
    state.retryUsed = true; state.retryPending = true; return true;
  }
  /** Abandon native work while keeping one charged validated presentation. Only owner removal can admit a fresh incarnation. */
  freeze(key: string): void {
    const state = this.states.get(key);
    if (!state || state.frozen || this.disposed) return;
    const generation = this.displayGeneration(state), current = state.generation, previous = state.previous;
    this.retire(state);
    state.generation = undefined; state.previous = generation; state.previousCoverage = false;
    state.frozen = true; state.retired = true; state.dirty = false; state.profileReady = false; state.profileRefusal = 0;
    if (current !== undefined && current !== generation) this.receipts(this.pool.remove(current));
    if (previous !== undefined && previous !== generation) this.receipts(this.pool.remove(previous));
    if (generation !== undefined) this.pool.retainBasis(generation);
    else state.displayStamp = 0;
    this.changed(key); this.schedule();
  }
  remove(key: string): void {
    this.removePiSource(key);
    this.noticeKeys.delete(key);
    const state = this.states.get(key); if (!state) return;
    this.dropData(state); this.states.delete(key); this.removeWork(state); this.charge(-state.bytes);
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear();
    if (!enabled) { this.profileNeed = undefined; waiters.delete(this.owner);
      for (const [key, state] of this.states) {
        this.dropData(state);
        if (state.frozen || this.busy(key) || state.uncertain || state.sharedUnknown || state.ownedUnknown !== undefined) {
          state.retired = true; state.dirty = false; state.profileReady = false; state.profileRefusal = 0;
        } else { this.states.delete(key); this.removeWork(state); this.charge(-state.bytes); }
      }
      for (const key of this.piSources.keys()) this.removePiSource(key); this.receipts(this.pool.clear()); this.flush(); }
  }
  dispose(): void {
    if (this.disposed) return;
    for (const entry of this.work.keys()) if ('preparation' in entry) this.charge(-groupBytes);
    this.work.clear(); this.newest = undefined; this.cursor = undefined; this.localPending = 0;
    this.setEnabled(false);
    // Pi fallback may have been captured while the native controller was already off.
    for (const key of this.piSources.keys()) this.removePiSource(key);
    this.disposed = true; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear();
    for (const state of this.states.values()) this.charge(-state.bytes);
    this.states.clear();
    // Only an unanswered open needs its existing capture to validate and close
    // a late-created lease. Removed source/color authority never returns.
    for (const job of this.jobs.values()) if (!job.source?.open) job.source = undefined;
    this.finishLifetime();
  }
  private charge(delta: number): boolean {
    if (this.lifetime.bytes + delta > this.maxBookkeepingBytes || flight.bookkeepingBytes + delta > CONTROLLER_LIMITS.bookkeepingBytes) return false;
    this.lifetime.bytes += delta; flight.bookkeepingBytes += delta; return true;
  }
  private finishLifetime(): void {
    if (!this.disposed || this.jobs.size || this.closes.length || !this.lifetime.bytes) return;
    waiters.delete(this.owner); lifetimes.unregister(this.lifetime); this.charge(-this.lifetime.bytes);
  }
  private matchesContent(state: SourceState, version: number | undefined): boolean {
    return version !== undefined && version >= state.contentVersion && version <= state.version;
  }
  private busy(key: string): boolean { return [...this.jobs.values()].some(job => job.key === key); }
  private wireKey(): string { return `source:${this.id}:${++this.wireSequence}`; }
  private log(level: DiagnosticLevel, explanation: string, fields?: DiagnosticFields): void {
    if (this.options.diagnostic) diagnose(this.options.diagnostic, level, 'syntax', explanation, { controller: this.id, ...fields });
  }
  private admit(state: SourceState, text: string): boolean {
    const result = this.pool.admit(this.wireKey(), state.version, text); this.receipts(result.released);
    if (!result.accepted) {
      this.log('WARN', 'Native source storage refused; no source dispatched', { source: state.key, version: state.version, units: text.length });
      state.blocked = true; state.dirty = false; return false;
    }
    this.log('DEBUG', 'Native source admitted', { source: state.key, version: state.version, generation: result.generation, language: state.language, units: text.length });
    state.generation = result.generation; state.committedUnits = 0;
    state.dirty = !state.empty && !state.blocked; return true;
  }
  private restart(state: SourceState, provider: number, providerChange: boolean, target?: Pick<SourceDemand, 'version' | 'text'>, cancel = true): void {
    const oldGeneration = state.generation, previous = state.previous;
    const latest = target ?? (oldGeneration === undefined ? undefined : this.pool.borrowSnapshot(oldGeneration)); if (!latest) return;
    const uncertain = !!target && state.uncertain && !providerChange, execution = state.execution;
    const blocked = !!target && state.blocked;
    const retained = oldGeneration !== undefined && this.pool.status(oldGeneration)?.sourceVersion !== undefined ? oldGeneration : previous;
    const retainedStatus = retained === undefined ? undefined : this.pool.status(retained);
    const reuse = !!target && state.complete && retainedStatus?.complete && state.displayProfile === state.profile
      && state.displayFingerprint === state.fingerprint && this.pool.borrowSnapshot(retained!, 'basis')?.text === latest.text;
    const previousCoverage = !target && (retained === oldGeneration || state.previousCoverage);
    // Superseded profiles keep their physical credit until normal settlement.
    this.retire(state, cancel);
    // Detach the obsolete parser basis before admission receipts. Releasing its
    // empty entry must not also release a compatible independently held result.
    state.generation = undefined; state.previous = retained; state.previousCoverage = previousCoverage; state.provider = provider;
    if (retained !== undefined) this.pool.retainBasis(retained);
    if (oldGeneration !== undefined && oldGeneration !== retained) this.pool.remove(oldGeneration);
    if (previous !== undefined && previous !== retained) this.pool.remove(previous);
    const result = reuse ? this.pool.replaceSnapshot(retained!, latest.version, latest.text)
      : this.pool.admit(this.wireKey(), latest.version, latest.text);
    this.receipts(result.released);
    if (providerChange) state.restarts = 0;
    state.execution = uncertain ? execution : 'not_started'; state.uncertain = uncertain;
    if (!result.accepted) { state.blocked = true; state.dirty = false; return; }
    state.generation = reuse ? retained : result.generation; state.committedUnits = 0; state.blocked = uncertain || blocked;
    if (reuse) {
      state.previous = undefined; state.previousCoverage = false;
      state.contentVersion = retainedStatus!.sourceVersion!; state.displayVersion = state.version; state.dirty = false;
      return;
    }
    // Admission may have evicted that result. Decide reuse only after receipts;
    // otherwise this affected source owes one recovery, not a render retry loop.
    const preserved = state.previous === undefined ? undefined : this.pool.status(state.previous);
    const exactCompleted = providerChange && previousCoverage && state.complete && preserved?.complete
      && state.displayProfile === state.profile && state.displayFingerprint === state.fingerprint && this.matchesContent(state, preserved.sourceVersion);
    state.dirty = !state.empty && !exactCompleted && !state.blocked;
  }
  private retire(state: SourceState, cancel = true): void {
    if (cancel) for (const job of this.jobs.values()) if (job.stateId === state.id) job.abort.abort(sourceRetired);
    if (state.lease && state.generation !== undefined) {
      const key = this.pool.status(state.generation)?.key;
      if (key) this.close({ key, ownerKey: state.key, generation: state.generation, lease: state.lease, provider: state.provider });
    }
    state.lease = undefined;
  }
  private dropData(state: SourceState): void {
    this.retire(state);
    const current = state.generation, previous = state.previous; state.generation = undefined; state.previous = undefined;
    state.previousCoverage = false; state.displayStamp = 0; state.displayProfile = undefined; state.displayFingerprint = undefined; state.displayVersion = undefined;
    if (current !== undefined) this.pool.remove(current);
    if (previous !== undefined) this.pool.remove(previous);
  }
  private close(close: Omit<Close, 'bytes'>): void {
    if (!this.provider.isReady(close.provider) || this.closes.some(item => item.lease === close.lease)
      || [...this.jobs.values()].some(job => job.close?.lease === close.lease)) return;
    const bytes = 256 + 2*(close.key.length + close.ownerKey.length + close.lease.length);
    if (!this.charge(bytes)) { this.counters.cleanupRefusals++; return; }
    this.closes.push({ ...close, bytes });
  }
  private receipts(receipts: readonly ReleaseReceipt[]): void {
    for (const receipt of receipts) {
      const pi = this.piGenerations.get(receipt.generation);
      if (pi) { this.piGenerations.delete(receipt.generation); pi.generation = undefined; pi.palette = undefined; continue; }
      for (const state of this.states.values()) {
        if (state.previous === receipt.generation) {
          state.previous = undefined; state.previousCoverage = false;
          if (state.generation === undefined || this.pool.status(state.generation)?.sourceVersion === undefined) {
            state.displayStamp = 0; this.changed(state.key);
          }
        }
        if (state.generation !== receipt.generation) continue;
        if (state.lease) this.close({ key: receipt.key, ownerKey: state.key, generation: receipt.generation, lease: state.lease, provider: state.provider });
        state.lease = undefined; this.retire(state); state.generation = undefined; state.blocked = true; state.dirty = false;
        state.displayStamp = 0; this.changed(state.key);
        if (state.previous !== undefined) { const previous = state.previous; state.previous = undefined; this.receipts(this.pool.remove(previous)); }
        break;
      }
    }
  }
  private unknown(job: Job, execution: 'unknown' | 'started'): boolean {
    const state = this.states.get(job.key);
    if (!this.disposed && !job.stopped && state?.id === job.stateId) {
      // Terminal unknown has no later successful reply. Shared/unspecified work
      // has no stop receipt; owned work can be released only by its exact reap.
      if (job.kind === 'owned') state.ownedUnknown = job.provider;
      else state.sharedUnknown = true;
      if (state.provider === job.provider) { state.execution = execution; state.uncertain = true; state.dirty = false; }
      return true;
    }
    return false;
  }
  private reservation(captureUnits: number, replacementUnits: number, inputUnits: number, replacementBytes: number, d: Description): number {
    return sourceReservation({ captureUnits, replacementUnits, inputUnits, replacementBytes,
      frameBytes: Math.min(OCCIPITAL_LIMITS.wireBytes, Math.max(d.limits.request_bytes, d.limits.reply_bytes)),
      runs: Math.min(OCCIPITAL_LIMITS.runs, d.limits.runs), styles: Math.min(OCCIPITAL_LIMITS.styles, d.limits.styles) });
  }
  private capacity(bytes: number): boolean {
    return flight.jobs < CONTROLLER_LIMITS.jobs && this.transientBytes + bytes <= this.maxTransientBytes
      && flight.bytes + bytes <= CONTROLLER_LIMITS.transientBytes;
  }
  private prepare(state: SourceState, description: Description): 'credit' | void {
    if (state.generation === undefined) return;
    const snapshot = this.pool.borrowSnapshot(state.generation), basis = this.pool.borrowSnapshot(state.generation, 'basis');
    const status = this.pool.status(state.generation); if (!snapshot || !basis || !status) return;
    if (state.empty) { state.dirty = false; return; }
    if (!description.profiles.some(profile => profile.id === state.profile && profile.fingerprint === state.fingerprint)
      || snapshot.utf8Bytes > Math.min(OCCIPITAL_LIMITS.sourceBytes, description.limits.source_bytes)) {
      state.blocked = true; state.dirty = false; state.execution = 'not_started'; this.changed(state.key); return;
    }
    const append = !!state.lease, open = !append && !state.complete;
    if (open && this.remoteLeases >= description.limits.leases_per_route) { this.retryScan = true; waitForCredit(this.owner); return; }
    const from = append ? state.committedUnits : 0, inputFrom = append ? basis.text.length : 0;
    const inputBytes = snapshot.utf8Bytes - (append ? basis.utf8Bytes : 0);
    const replacementBytes = snapshot.utf8Bytes - (append ? status.committedBytes : 0);
    const bytes = this.reservation(snapshot.text.length, snapshot.text.length - from, snapshot.text.length - inputFrom, replacementBytes, description);
    if (bytes > this.maxTransientBytes) { state.blocked = true; state.dirty = false; state.execution = 'not_started'; this.changed(state.key); return; }
    if (!this.capacity(bytes)) { this.creditBlocked = true; waitForCredit(this.owner); return 'credit'; }
    const job = this.job(state.key, state.generation, state.id, state.provider, description, bytes);
    const replacementText = snapshot.text.slice(from);
    if (!coherent(replacementText)) { this.release(job); state.dirty = false; state.execution = 'not_started'; this.changed(state.key); return; }
    const expected: ExpectedSource = { key: status.key, generation: state.generation, source_version: snapshot.version,
      profile: state.profile, fingerprint: state.fingerprint, revision: status.revision + 1,
      source_bytes: snapshot.utf8Bytes, replace_from: append ? status.committedBytes : 0, complete: state.complete,
      ...(append ? { lease: state.lease! } : {}), replacementText };
    job.sourceWork = true; job.kind = this.provider.snapshot().kind;
    job.source = { capture: { version: snapshot.version, text: snapshot.text }, expected, replaceUnits: from, open };
    const admission = this.options.admission ?? 'bounded_queue';
    const common = { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, admission,
      ...(admission === 'bounded_queue' ? { queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) } : {}) };
    const request = append ? { ...common, op: 'stream.append', key: status.key, generation: state.generation, lease: state.lease,
      base_revision: status.revision, base_bytes: basis.utf8Bytes, source_version: snapshot.version,
      profile: state.profile, fingerprint: state.fingerprint, append: snapshot.text.slice(inputFrom), final: state.complete }
      : { ...common, op: state.complete ? 'highlight' : 'stream.open', sources: [{ key: status.key,
        generation: state.generation, source_version: snapshot.version, profile: state.profile, fingerprint: state.fingerprint,
        hint: { ...(state.language === undefined ? {} : { language: state.language }), ...(state.path === undefined ? {} : { path: state.path }) }, text: snapshot.text }] };
    // The transport/codec alone checks the actual encoded frame size. No JSON
    // serialization or worst-case-size rejection happens at this boundary.
    if (open) this.remoteLeases++;
    this.counters.preparedBytes += inputBytes; state.dirty = false; state.execution = 'unsettled'; this.dispatch(job, request);
  }
  private job(key: string, generation: number, stateId: number, provider: number, description: Description, bytes: number): Job {
    const id = ++this.sequence;
    const job: Job = { id, key, generation, stateId, provider, ticket: `controller:${this.id}:${id}`, description, bytes, abort: new AbortController(), reserved: true };
    job.lifetimeRef = new WeakRef(job); this.lifetime.jobs.add(job.lifetimeRef);
    flight.jobs++; flight.bytes += bytes; this.jobs.set(id, job); this.transientBytes += bytes;
    this.counters.peakTransientBytes = Math.max(this.counters.peakTransientBytes, this.transientBytes);
    this.counters.peakJobs = Math.max(this.counters.peakJobs, this.jobs.size); return job;
  }
  private dispatch(job: Job, request: Record<string, unknown>): void {
    this.counters.dispatches++; const observers = completion(this.owner, job);
    this.log('DEBUG', 'Native job dispatched', { source: job.key, job: job.id, generation: job.generation, provider: job.provider,
      operation: typeof request.op === 'string' ? request.op : 'unknown', version: job.source?.expected.source_version,
      sourceBytes: job.source?.expected.source_bytes, reservedBytes: job.bytes });
    try { void this.provider.request(job.provider, request, { signal: job.abort.signal, deadlineMs: this.options.deadlineMs, acceptRetired: true })
      .then(observers.reply, observers.failed).catch(ignored); } catch (error) { observers.failed(error); }
  }
  private release(job: Job): void {
    if (this.jobs.delete(job.id)) this.transientBytes -= job.bytes;
    if (job.lifetimeRef) this.lifetime.jobs.delete(job.lifetimeRef);
    job.source = undefined; releaseCredit(job);
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true; queueMicrotask(continuation(this.owner));
  }
  wake(): void {
    this.creditBlocked = false;
    if (this.retryScan) { this.retryScan = false; this.rewind(); }
    this.schedule();
  }
  private changed(key: string): void {
    if (!this.options.onChange || this.disposed || !this.states.has(key)) return;
    this.noticeKeys.add(key);
    if (this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(notice(this.owner, this.noticeEpoch));
  }
  /** Weak notification delivery; an obsolete off/on epoch cannot erase a newer notice. */
  notifyChange(epoch: number): void {
    if (epoch !== this.noticeEpoch) return;
    this.noticeScheduled = false;
    if (this.disposed) return;
    const keys = [...this.noticeKeys]; this.noticeKeys.clear();
    if (!keys.length) return;
    try { this.options.onChange?.(keys); } catch { /* Caller presentation must not disrupt source ownership. */ }
  }
  settle(job: Job, raw: unknown, rejected: boolean): void {
    if (!this.jobs.has(job.id)) return;
    const providerCurrent = this.provider.isReady(job.provider), state = this.states.get(job.key);
    const permission = this.workStatus(job.key);
    let changed = false;
    const useful = this.enabled && !this.disposed && !job.stopped && providerCurrent && !job.abort.signal.aborted
      && state?.id === job.stateId && state.generation === job.generation && !!this.pool.status(job.generation);
    try {
      if (rejected) {
        this.log('WARN', 'Native request rejected; cancellation or rejection is not stop proof', { source: job.key, job: job.id, provider: job.provider,
          version: job.source?.expected.source_version, execution: raw instanceof RequestFailure ? raw.execution : 'unknown', code: diagnosticError(raw) });
        if (raw instanceof RequestFailure && raw.execution === 'not_started') {
          if (job.source?.open && providerCurrent && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
          if (!job.stopped && state?.id === job.stateId && state.provider === job.provider && !state.uncertain) {
            state.execution = 'not_started'; changed = true;
          }
          if (useful && !state.uncertain) {
            state.execution = 'not_started';
            state.dirty = !this.matchesContent(state, job.source!.capture.version) || state.complete !== job.source!.expected.complete;
            changed = true;
          }
        } else if (job.source) changed = this.unknown(job, 'unknown');
        return;
      }
      if (job.close) {
        decodeClosed(raw, job.ticket, job.description);
        this.log('DEBUG', 'Native source lease close acknowledged', { source: job.key, job: job.id, provider: job.provider });
        if (providerCurrent && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
        return;
      }
      if (!job.source || job.stopped) return;
      const source = job.source, chunk = decodeSources(raw, job.ticket, job.description, [source.expected])[0]!;
      this.counters.decodedBytes += chunk.source_bytes - chunk.replace_from;
      if (!useful || state?.group?.preparation.deref()?.acceptsProfile?.(source.expected.profile, source.expected.fingerprint) === false) {
        if (state?.id === job.stateId && state.provider === job.provider && !state.uncertain) {
          state.execution = 'acknowledged'; changed = true;
        }
        this.counters.staleReplies++;
        this.log('DEBUG', 'Validated native reply is stale; its colors rejected', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
        if (source.open && chunk.lease && !chunk.complete && providerCurrent) this.close({ key: chunk.key, ownerKey: job.key,
          generation: chunk.generation, lease: chunk.lease, provider: job.provider });
        return;
      }
      // Validation plus current source/provider authority proves useful native
      // work, even if local byte pressure subsequently discards its colors.
      this.provider.classificationAccepted(job.provider);
      const priorDisplay = this.pool.status(job.generation)?.displayRevision ?? 0;
      const result = this.pool.installChunk(job.generation, chunk, source.capture); this.receipts(result.released);
      if (!result.accepted || state.generation !== job.generation) {
        this.log('WARN', 'Validated native colors refused by local storage', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
        if (source.open && chunk.lease && !chunk.complete) this.close({ key: chunk.key, ownerKey: job.key, generation: chunk.generation, lease: chunk.lease, provider: job.provider });
        return;
      }
      state.displayProfile = state.profile; state.displayFingerprint = state.fingerprint;
      state.displayVersion = chunk.complete && state.complete && this.pool.borrowSnapshot(job.generation)?.text === source.capture.text ? state.version : undefined;
      if (!state.displayStamp || priorDisplay !== this.pool.status(job.generation)?.displayRevision) state.displayStamp = ++this.displaySequence;
      if (state.previous !== undefined) { this.pool.remove(state.previous); state.previous = undefined; state.previousCoverage = false; }
      state.committedUnits = chunk.complete ? source.capture.text.length : source.replaceUnits + source.expected.replacementText.lastIndexOf('\n') + 1;
      state.lease = chunk.complete ? undefined : chunk.lease; state.execution = 'acknowledged';
      this.counters.committedLineCalls += chunk.counters.committed_line_calls; this.counters.committedLineBytes += chunk.counters.committed_line_bytes;
      this.counters.tailCalls += chunk.counters.tail_calls; this.counters.tailBytes += chunk.counters.tail_bytes;
      if (chunk.complete && source.expected.lease && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
      changed = true;
      this.log('DEBUG', 'Validated native result accepted', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version,
        sourceBytes: chunk.source_bytes, committedBytes: chunk.committed_bytes, complete: chunk.complete,
        committedLineCalls: chunk.counters.committed_line_calls, tailCalls: chunk.counters.tail_calls });
    } catch (error) {
      const source = job.source;
      this.log('WARN', 'Native reply refused by validation or remote admission', { source: job.key, job: job.id, provider: job.provider,
        version: source?.expected.source_version, execution: error instanceof RemoteFault ? error.execution : 'unknown', code: diagnosticError(error) });
      if (error instanceof RemoteFault && error.execution === 'not_started') {
        if (source?.open && providerCurrent && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
        if (!job.stopped && state?.id === job.stateId && state.provider === job.provider && !state.uncertain) {
           state.execution = 'not_started'; changed = true;
         }
         if (useful) {
           changed = true;
          state.execution = 'not_started';
          if (error.code === 'restart_required') {
            state.restarts++;
             if (state.restarts <= CONTROLLER_LIMITS.restarts) {
               this.log('INFO', 'Parser state lost; bounded source restart selected', { source: state.key, version: state.version, restart: state.restarts });
               this.counters.restarts++; this.restart(state, state.provider, false);
             }
            else { this.retire(state); state.blocked = true; state.dirty = false; }
           } else if (error.code === 'profile_changed' || error.code === 'theme_unavailable') {
             state.execution = 'not_started'; state.blocked = true; state.dirty = false;
             if (!state.profileRetryUsed) {
               state.profileRetryUsed = true; state.profileReady = false;
               state.profileRefusal = ++this.profileSequence;
               this.profileNeed = { generation: job.provider, sequence: state.profileRefusal };
             }
           } else state.dirty = !this.matchesContent(state, source!.capture.version) || state.complete !== source!.expected.complete;
        }
      } else if (job.source) changed = this.unknown(job, error instanceof RemoteFault && error.execution === 'started' ? 'started' : 'unknown');
    } finally {
      this.release(job); this.schedule(); this.finishLifetime();
      const current = this.states.get(job.key), next = this.workStatus(job.key);
      const node = current && this.work.get(current.group ?? current);
      if (node?.seen === this.workPass && (node.pending || node.epoch !== this.refreshEpoch || current?.dirty)) this.rewind();
      if (current?.id === job.stateId && (changed || permission.execution !== next.execution
        || permission.fallbackEligible !== next.fallbackEligible)) {
        if (permission.execution !== next.execution || permission.fallbackEligible !== next.fallbackEligible)
          this.log('DEBUG', next.fallbackEligible ? 'Fallback permission available; not a fallback invocation (no Pi fallback for Bash)' : 'Source authority prohibits duplicate fallback classification',
            { source: job.key, version: current.version, execution: next.execution, fallbackEligible: next.fallbackEligible });
        this.changed(job.key);
      }
    }
  }
}
