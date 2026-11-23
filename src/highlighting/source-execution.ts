import { type StyleSelection } from './controller-styles.ts';
import { WorkRegistry, type SourcePreparation, type SourceWorkGroup, type WorkContinuation } from './work-registry.ts';
import { releaseGroupHold, type GroupHold } from './card-publication.ts';
import { PiFallbackCoordinator } from './pi-fallback.ts';

import type { DataCharge, DataGrant, GeometryFunding } from '../resources/data-budget.ts';
import type { ContextRef } from './storage/context-arena.ts';
import { StylePublication, displayGeneration } from './style-publication.ts';
import type { Close, CloseJob, CloseOperation, Job, PresentationRecord, PublicationNode, SourceJob, SourceOperation, SourceSnapshot, SourceState, StyleDispatch, StyleMember, StyleOperation, StyleRequest, WorkEntry, WorkMetadata, WorkNode, StyleOverlapView, StyleReplyView } from './execution-records.ts';
import { type CardRole } from '../appearance/card-roles.ts';



export type { StyleSelection } from './controller-styles.ts';
import { type DiagnosticFields, type DiagnosticLevel, type DiagnosticSink, diagnose, diagnosticError, reportRuntime, unexpectedDiagnostic } from '../diagnostics.ts';
import { RemoteFault } from '../occipital/protocol.ts';
import { decodeSemanticClosed as decodeClosed, decodeSemanticSourceReply, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, type SemanticDescription as Description, type SemanticDataRequest } from '../occipital/semantic-protocol.ts';
import type { SemanticExpectation as ExpectedSource, SemanticChunk } from '../occipital/semantic-source.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { BorrowedSource, CardSourcePort, DisplayRangeReader, GroupDisplayBasis, GroupDisplayMember, SourceDemand, SourceDisplayBasis, SourceExecutionStats, SourceLifecyclePort, SourcePumpPort, SourceRecordStatus, SourceStatisticsPort, SourceWorkStatus } from './source-ports.ts';
export type { BorrowedPiSource, BorrowedSource, DisplayRangeReader, GroupDisplayBasis, PiFailure, PiProjectionReader, SourceDemand, SourceDisplayBasis, SourceExecutionState, SourceRecordStatus, SourceWorkStatus } from './source-ports.ts';
import { SemanticRetentionPool, type SemanticRelease as ReleaseReceipt } from './storage/semantic-retention.ts';
import { OCCIPITAL_LIMITS } from '../occipital/limits.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { dataJsonBytes } from '../occipital/data-json.ts';
import { RequestFailure } from '../occipital/request-failure.ts';
import { DEFAULT_PROVIDER_CLOCK, type ProviderBroker, type ProviderClock, type ProviderRetirementOrigin } from '../occipital/provider.ts';
import { admittedSource, classifySourceInput, matchingSourceVersion, nextSource, queuedSource, sourceExecution, sourceFaultCause, sourceRefused, sourceSatisfied, sourceUncertain, SOURCE_RETRY_MS, type SourceCause, type SourceDecision, type SourceOutcome, type SourceRefusal } from './source-state.ts';
import { RETENTION_LIMITS } from './storage/retention.ts';
import { type StyleAttempt } from './style-state.ts';

import { sourceFits, sourceIdentifier as identifier, sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
export { sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
function workMetadata(): WorkMetadata { return { styleRevision: 0 }; }
// Weak registry/refusal metadata plus one targeted group-ID notice association/packet.
const groupBytes = 1024;
export type { SourcePreparation, SourceWorkGroup } from './work-registry.ts';

export interface SourceExecutionOptions {
  diagnostic?: DiagnosticSink;
  clock?: ProviderClock;
  deadlineMs?: number; admission?: 'try_now' | 'bounded_queue'; queueWaitMs?: number;
  maxTransientBytes?: number; maxBookkeepingBytes?: number;
  retention?: ConstructorParameters<typeof SemanticRetentionPool>[0];
  /** Coalesced asynchronous notice after accepted colors or terminal source state changes.
    * Keys and primitive group IDs target their still-owned presentation records. */
  onChange?: (keys: readonly string[], changedGroups?: readonly number[]) => void;
}
type RetainedSource = NonNullable<ReturnType<SemanticRetentionPool['inspectSource']>>;
type Provider = Pick<ProviderBroker, 'snapshot' | 'isReady' | 'request' | 'classificationAccepted' | 'recover' | 'workerUnavailable' | 'exhaustedRoute'>;
type WorkCompletion = { promise: Promise<boolean>; resolve(value: boolean): void };
function workCompletion(): WorkCompletion {
  let resolve!: WorkCompletion['resolve'];
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
const workSettled = Promise.resolve(true), workCancelled = Promise.resolve(false);
type Lifetime = { bytes: number; owner: WeakRef<SourceExecution>; jobs: Set<WeakRef<Job>>; charges: Set<DataCharge>; groups: Set<GroupHold>; data?: SemanticRetentionPool; completion?: WorkCompletion; wake?: ReturnType<ProviderClock['setTimeout']> };
let nextExecution = 0;
const ignored = () => { };
// A signal can outlive its owner; a receiver-created abort stack retains it.
const sourceRetired = new Error('occipital source retired');
// Credit survives owner GC and abort, until actual terminal settlement. Module
// incarnation only: parent reload/provider cleanup remains an integration gate.
const flight = { jobs: 0, bytes: 0, bookkeepingBytes: 0 };
const waiters = new Set<WeakRef<SourceExecution>>();
const lifetimes = new FinalizationRegistry<Lifetime>(lifetime => {
  lifetime.wake?.cancel(); lifetime.wake = undefined;
  lifetime.completion?.resolve(false); lifetime.completion = undefined;
  flight.bookkeepingBytes -= lifetime.bytes; lifetime.bytes = 0; waiters.delete(lifetime.owner);
  // At most the already reserved physical jobs. Dead owners need no reply
  // validation; keep physical credit until settlement, not their source payload.
  for (const reference of lifetime.jobs) { const job = reference.deref(); if (job) { if (job.operation === 'source') job.source = undefined; releaseStyle(job); job.abort.abort(sourceRetired); } }
  lifetime.jobs.clear();
  for (const hold of lifetime.groups) releaseGroupHold(hold); lifetime.groups.clear();
  for (const charge of lifetime.charges) charge.release(); lifetime.charges.clear();
  const data = lifetime.data; lifetime.data = undefined;
  data?.dispose();
});
function releaseStyle(job: Job): void {
  if (job.operation !== 'style') return;
  const style = job.style; job.style = undefined; style?.captures?.release();
}


function waitForCredit(owner: WeakRef<SourceExecution>): void {
  // Membership is prepaid by each owner's128-byte lifetime ticket. There is no
  // independent waiter count ceiling or abandoned live callback at a magic count.
  for (const waiter of waiters) if (!waiter.deref()) waiters.delete(waiter);
  waiters.add(owner);
}
function releaseRequest(job: Job): void {
  if (job.operation === 'source') job.source = undefined;
  if (job.operation === 'style') {
    releaseStyle(job); job.styleCharge?.release(); job.styleCharge = undefined;
  }
  if (!job.reserved) return;
  job.reserved = false; flight.jobs--; flight.bytes -= job.bytes;
  const pending = [...waiters]; waiters.clear();
  for (const owner of pending) owner.deref()?.wake();
}
function terminalReply(owner: WeakRef<SourceExecution>, job: Job, value: unknown, rejected: boolean): void {
  const execution = owner.deref();
  try { execution?.settle(job, value, rejected); }
  finally { if (execution) execution.physicalSettled(job); else releaseRequest(job); }
}
function completion(owner: WeakRef<SourceExecution>, job: Job) {
  return {
    reply: (value: unknown) => terminalReply(owner, job, value, false),
    failed: (error: unknown) => terminalReply(owner, job, error, true)
  };
}
function executionActive(owner: WeakRef<SourceExecution>) {
  return () => owner.deref()?.active === true;
}
function retryWake(owner: WeakRef<SourceExecution>, token: object) {
  return () => owner.deref()?.wakeDue(token);
}
function geometryGrant(owner: WeakRef<SourceExecution>, group?: WeakRef<SourceWorkGroup>, id?: number) {
  return (bytes: number) => owner.deref()?.grantGeometry(bytes, group?.deref(), id);
}
function notice(owner: WeakRef<SourceExecution>, epoch: number) { return () => owner.deref()?.notifyChange(epoch); }
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
  return RETENTION_LIMITS.entryAllowance + 2 * (demand.key.length + (demand.language?.length ?? 0) + (demand.path?.length ?? 0));
}
type NormalizedSourceDemand = SourceDemand & { neutral: NonNullable<SourceDemand['neutral']> };
function normalizeSourceDemand(demand: SourceDemand): NormalizedSourceDemand {
  const { key, version, text, path, complete } = demand;
  const language = demand.language === '' ? undefined : demand.language, neutral = demand.neutral === undefined ? 'code' : demand.neutral;
  if (!identifier(key) || language !== undefined && !identifier(language, 128) || path !== undefined && !identifier(path, 4096)
    || !Number.isInteger(version) || version < 0 || version > 0xffffffff
    || typeof text !== 'string' || text.length > RETENTION_LIMITS.maxSourceUnits || typeof complete !== 'boolean'
    || neutral !== 'title' && neutral !== 'code') throw new Error('invalid source demand');
  return { key, version, text, ...(language === undefined ? {} : { language }), ...(path === undefined ? {} : { path }), complete, neutral };
}

/** One UI-independent active source owner. Caller flushes after render; observe
 * and reads never prepare/encode/dispatch. Strings/ranges are solely pooled or in
 * two charged captures. Tombstones contain primitives and suppress pressure
 * carousels; off keeps physical-work evidence, removal/disposal drops it.
 * Primitive record credit is bounded separately by the same generous retained-family allowance, not a count cap.
 * Public coordination methods support the private StylePublication's narrowed
 * type-only view of this root; they are not another card-facing API. Cards use
 * the capabilities in source-ports.ts, retaining this same execution identity. */
export class SourceExecution implements WorkContinuation, CardSourcePort, SourceLifecyclePort, SourcePumpPort, SourceStatisticsPort {
  private readonly provider: Provider;
  private readonly pool: SemanticRetentionPool;
  private readonly publication: StylePublication;
  private readonly options: SourceExecutionOptions;
  private readonly clock: ProviderClock;
  private wakeAt?: number;
  private wakeToken?: object;
  private wakePass = -1;
  private wakeMinimum = Number.POSITIVE_INFINITY;
  private readonly maxTransientBytes: number;
  private readonly maxBookkeepingBytes: number;
  private readonly maxDecodedBytes: number;
  private readonly id = ++nextExecution;
  private readonly owner = new WeakRef(this);
  private readonly lifetime: Lifetime = { bytes: 0, owner: this.owner, jobs: new Set(), charges: new Set(), groups: new Set() };
  private sequence = 0;
  private wireSequence = 0;
  private stateSequence = 0;
  private enabled = true;
  private suspended = false;
  private disposed = false;
  private noticeScheduled = false;
  private notifying = false;
  private preparing?: SourceWorkGroup;
  // One chronological registry selects both lazy groups and standalone sources.
  private readonly work: WorkRegistry<SourceState, WorkMetadata>;
  private workProvider = -1;
  private workReady = false;
  // Primitive key aliases only, prepaid by each source's existing entry allowance.
  // Explicit removal drops its slot; delivery/off release the pending packet.
  private readonly noticeKeys = new Set<string>();
  private readonly noticeGroups = new Set<number>();
  private noticeEpoch = 0;
  private leaseProvider = -1;
  private remoteLeases = 0;
  private transientBytes = 0;
  private states = new Map<string, SourceState>();
  readonly pi: PiFallbackCoordinator;
  private jobs = new Map<number, Job>();
  private closes: Close[] = [];
  private counters = {
    dispatches: 0, preparedBytes: 0, decodedBytes: 0, staleReplies: 0, restarts: 0,
    committedLineCalls: 0, committedLineBytes: 0, tailCalls: 0, tailBytes: 0, cleanupRefusals: 0,
    peakTransientBytes: 0, peakJobs: 0, stylePreparations: 0, styleContextVisits: 0, styleEncodes: 0, styleDispatches: 0, stylePublications: 0, styleRejections: 0
  };

  constructor(provider: Provider, options: SourceExecutionOptions = {}) {
    const deadlineMs = duration(options.deadlineMs ?? OCCIPITAL_LIMITS.dataDeadlineMs);
    if (options.onChange !== undefined && typeof options.onChange !== 'function') throw new Error('invalid controller observer');
    if (options.admission !== undefined && options.admission !== 'try_now' && options.admission !== 'bounded_queue') throw new Error('invalid controller admission');
    if (options.queueWaitMs !== undefined) duration(options.queueWaitMs);
    this.maxTransientBytes = options.maxTransientBytes ?? CONTROLLER_LIMITS.transientBytes;
    this.maxBookkeepingBytes = options.maxBookkeepingBytes ?? CONTROLLER_LIMITS.bookkeepingBytes;
    for (const [value, cap] of [[this.maxTransientBytes, CONTROLLER_LIMITS.transientBytes], [this.maxBookkeepingBytes, CONTROLLER_LIMITS.bookkeepingBytes]]) {
      if (!Number.isSafeInteger(value) || value! < 128 || value! > cap!) throw new Error('invalid controller byte limit');
    }
    this.maxDecodedBytes = Math.min(options.retention?.maxBytes ?? HIGHLIGHT_LIMITS.decodedBytes, HIGHLIGHT_LIMITS.decodedBytes);
    this.provider = provider; this.clock = options.clock ?? DEFAULT_PROVIDER_CLOCK;
    this.options = { deadlineMs, admission: options.admission, queueWaitMs: options.queueWaitMs, onChange: options.onChange, diagnostic: options.diagnostic };
    this.work = new WorkRegistry(this.owner, CONTROLLER_LIMITS.jobs);
    this.pool = new SemanticRetentionPool(options.retention);
    this.publication = new StylePublication(this.owner, this.pool, this.provider, this.work, this.clock, this.options.diagnostic, this.counters, this.lifetime);
    this.pi = new PiFallbackCoordinator(this.pool, {
      isDisposed: () => this.disposed, isActive: executionActive(this.owner), charge: delta => this.charge(delta), wireKey: () => this.wireKey(),
      receipts: receipts => this.receipts(receipts), changed: key => this.changed(key),
      log: (level, explanation, fields) => this.log(level, explanation, fields), diagnostic: options.diagnostic,
    });
    this.lifetime.data = this.pool;
    if (!this.charge(128)) throw new Error('controller bookkeeping capacity');
    lifetimes.register(this, this.lifetime, this.lifetime);
  }

  get active(): boolean { return !this.suspended && !this.disposed; }
  get publicationEnabled(): boolean { return this.enabled; }
  get publicationDisposed(): boolean { return this.disposed; }
  get publicationPreparing(): SourceWorkGroup | undefined { return this.preparing; }
  get publicationWorkProvider(): number { return this.workProvider; }
  get publicationMaxTransientBytes(): number { return this.maxTransientBytes; }
  get publicationMaxDecodedBytes(): number { return this.maxDecodedBytes; }

  source(key: string): PresentationRecord | undefined { return this.states.get(key); }
  sources(): IterableIterator<PresentationRecord> { return this.states.values(); }

  waitForCredit(): void { waitForCredit(this.owner); }

  /** Observe admitted queue work and actual notification delivery; never flush or test result correctness. */
  whenSettled(): Promise<boolean> {
    if (this.disposed || this.suspended) return workCancelled;
    if (this.lifetime.completion) return this.lifetime.completion.promise;
    if (!this.workPending()) return workSettled;
    this.lifetime.completion = workCompletion();
    return this.lifetime.completion.promise;
  }
  private workPending(): boolean {
    return this.work.hasWorkTurn || this.notifying || this.noticeScheduled
      || this.jobs.size > 0 || this.transientBytes > 0 || this.closes.length > 0 || waiters.has(this.owner);
  }
  private completeWork(cancelled = false): void {
    const completion = this.lifetime.completion;
    if (!completion || !cancelled && this.workPending()) return;
    this.lifetime.completion = undefined; completion.resolve(!cancelled);
  }

  /** One desired trusted rule/binding generation; source/parser identity is unchanged. */
  setStyleSelection(input: StyleSelection | undefined): boolean { return this.publication.setStyleSelection(input); }
  /** Operation-scoped funding only; not source work, fallback permission or an owner of geometry. */
  geometryFunding(group?: SourceWorkGroup): GeometryFunding | undefined {
    if (!this.geometryCurrent(group, group?.id)) return undefined;
    return { budget: this.pool.budget, grant: geometryGrant(this.owner, group ? new WeakRef(group) : undefined, group?.id) };
  }
  private geometryCurrent(group?: SourceWorkGroup, id?: number): boolean {
    return this.active && (id === undefined || !!group && group.id === id && this.work.has(group) && !!group.preparation.deref());
  }
  grantGeometry(bytes: number, group?: SourceWorkGroup, id?: number): DataGrant | undefined {
    if (!this.geometryCurrent(group, id)) return undefined;
    const direct = this.pool.budget.reserve(bytes); if (direct) return direct;
    const protect = group ? (generation: number) => {
      for (const key of group.keys) {
        const state = this.states.get(key);
        if (state?.group === group && (state.generation === generation || state.previous === generation)) return true;
      }
      return false;
    } : undefined;
    const result = this.pool.reserve(protect, bytes); this.receipts(result.released, true);
    return result.accepted && this.geometryCurrent(group, id) ? this.pool.budget.reserve(bytes) : undefined;
  }
  registerPreparation(preparation: SourcePreparation): SourceWorkGroup | undefined {
    if (this.disposed || !this.charge(groupBytes)) return undefined;
    const group = { id: this.work.nextGroupId(), preparation: new WeakRef(preparation), keys: preparation.keys };
    this.work.register(group, workMetadata()); return group;
  }
  /** Cold, idempotent ordered membership seal after logical preparation.
   * Call explicitly after membership edits outside prepare(); registration alone is not useful demand. */
  updatePreparation(group: SourceWorkGroup): boolean { return this.publication.updatePreparation(group); }
  groupPresentation(group: SourceWorkGroup): GroupDisplayBasis | undefined { return this.publication.groupPresentation(group); }
  readGroupRole(weak: WeakRef<PublicationNode>, stamp: number, role: CardRole): ConcreteStyle | undefined { return this.publication.readGroupRole(weak, stamp, role); }
  visitGroupStyles(weak: WeakRef<PublicationNode>, stamp: number, consume: (style: ConcreteStyle) => void): boolean { return this.publication.visitGroupStyles(weak, stamp, consume); }
  visitGroup(weak: WeakRef<PublicationNode>, stamp: number, consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean { return this.publication.visitGroup(weak, stamp, consume); }
  readGroupMember(weak: WeakRef<PublicationNode>, stamp: number, key: string): GroupDisplayMember | undefined { return this.publication.readGroupMember(weak, stamp, key); }
  visitGroupRanges(weak: WeakRef<PublicationNode>, stamp: number, key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean { return this.publication.visitGroupRanges(weak, stamp, key, consume); }
  queuePreparation(group: SourceWorkGroup, local = false): void { if (!this.disposed) this.work.queue(group, local); }
  pausePreparation(group: SourceWorkGroup): void {
    if (!this.work.pause(group)) return;
    this.reconcileCreditInterest();
    if (this.lifetime.wake || Number.isFinite(this.wakeMinimum)) { this.work.rewind(); this.work.schedule(); }
  }
  unregisterPreparation(group: SourceWorkGroup): void {
    this.drainRetirements(); this.releasePreparation(group, false);
  }
  private releasePreparation(group: SourceWorkGroup, deferred: boolean): void {
    if (!this.removeWork(group, deferred)) return;
    this.noticeGroups.delete(group.id);
    this.charge(-groupBytes);
    for (const key of group.keys) this.removeSource(key, deferred);
    if (!this.work.size && !this.states.size) this.publication.clearCache();
    this.reconcileCreditInterest();
  }

  /** One revision/cursor reset, not a sweep or a second pending queue. */
  refreshPreparations(): void { if (!this.disposed) this.work.refresh(); }
  private removeWork(value: WorkEntry, deferred = false): boolean {
    const removed = this.work.remove(value, node => reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' }), node => {
      this.publication.dropGroup(node, true);
      for (const job of this.jobs.values()) if (job.operation === 'style' && job.style?.node.deref() === node) { releaseStyle(job); this.cancelJob(job, deferred); }
    });
    if (removed && (this.lifetime.wake || Number.isFinite(this.wakeMinimum))) {
      if (!this.work.size) this.cancelWake();
      else { this.work.rewind(); this.work.schedule(); }
    }
    return removed;
  }

  observe(demand: SourceDemand): boolean {
    if (!this.enabled || !this.active) return false;
    const state = this.states.get(demand.key), queued = state && this.sourceQueued(state, this.inspectSource(state)), generation = state?.generation;
    const accepted = this.observeDemand(demand);
    if (state && (queued && !(this.enabled && this.sourceQueued(state, this.inspectSource(state))) || generation !== undefined && state.generation !== generation)) this.reconcileCreditInterest();
    return accepted;
  }
  private refuseSource(state: SourceState, cause: SourceRefusal, provider = state.provider): void {
    if (state.refusalCause === 'metadataFunding') return;
    state.refusalCause = cause; state.refusalInput = state.inputRevision; state.refusalProvider = provider;
    state.refusalGeneration = cause === 'requestLimit' || cause === 'encoding' ? state.generation : undefined;
  }
  private sourceAvailable(state: SourceState): state is SourceState & { generation: number } {
    return state.generation !== undefined && matchingSourceVersion(state, this.pool.snapshotVersion(state.generation));
  }
  private inspectSource(state: SourceState) {
    return state.generation === undefined ? undefined : this.pool.inspectSource(state.generation);
  }
  private sourceSatisfied(state: SourceState, data: RetainedSource['parsed']): boolean {
    const route = this.provider.snapshot(), description = route.availability === 'ready' ? route.description : undefined;
    return sourceSatisfied(state, data && {
      sourceVersion: data.sourceVersion, complete: data.complete,
      compatible: !description || description.assets === state.parsedAssets && description.vocabulary.fingerprint === data.vocabulary,
      continuable: state.parsedProvider === state.provider && this.provider.isReady(state.provider) && !!state.continuation
    });
  }
  private sourceQueued(state: SourceState, facts: RetainedSource | undefined, ready = this.provider.snapshot().availability === 'ready'): boolean {
    return queuedSource(state, ready, matchingSourceVersion(state, facts?.textVersion), this.sourceSatisfied(state, facts?.parsed));
  }
  private sourceDecision(state: SourceState, held = this.keyOccupied(state.key, 'native')): SourceDecision {
    const facts = this.inspectSource(state);
    if (!matchingSourceVersion(state, facts?.textVersion)) return { kind: 'idle' };
    const node = this.work.get(state.group ?? state);
    return nextSource(state, {
      active: this.active, enabled: this.enabled, held, available: true, ready: this.provider.isReady(state.provider),
      satisfied: this.sourceSatisfied(state, facts?.parsed), now: this.clock.now(), resyncAt: node?.resyncAt
    });
  }
  private sourceOwed(state: SourceState): boolean {
    const decision = this.sourceDecision(state);
    return decision.kind !== 'idle' && decision.kind !== 'refused';
  }
  private inspectDemand(state: SourceState | undefined, input: NormalizedSourceDemand,
    route: ReturnType<Provider['snapshot']>): boolean | undefined {
    if (!state) return undefined;
    if (state.frozen) return false;
    const retired = state.retired === true;
    state.retired = false;
    if (input.version < state.version) throw new Error('non-monotonic source demand');
    if (state.neutral !== input.neutral) {
      state.neutral = input.neutral;
      // Inherited ink changes neither the generic subject nor its recorded cache miss.
      if (this.publication.selectionPresent) { this.work.rewind(); this.work.schedule(); }
    }
    const sameIdentity = input.language === state.language && input.path === state.path;
    const sameObservation = input.version === state.version && input.complete === state.complete && sameIdentity;
    const reobserve = state.evictionEntitlement === 'reobserve';
    if (sameObservation && !retired && !reobserve && state.refusalCause !== 'metadataFunding'
      && (state.refusalProvider === undefined || state.refusalProvider === route.generation)) return this.sourceAvailable(state);
    return undefined;
  }
  private refuseMetadataFunding(state: SourceState | undefined, input: NormalizedSourceDemand): false {
    if (!state) return false;
    const changed = input.version !== state.version || input.complete !== state.complete || state.empty !== !input.text.length
      || state.refusalCause !== 'metadataFunding' || state.generation !== undefined || state.previous !== undefined;
    if (changed) this.dropData(state);
    state.version = input.version; state.contentVersion = input.version; state.complete = input.complete; state.empty = !input.text.length;
    state.refusalCause = 'metadataFunding'; state.refusalInput = undefined; state.refusalProvider = undefined; state.refusalGeneration = undefined;
    this.publication.sourceUnavailable(state);
    if (changed) { this.work.rewind(); this.changed(input.key); }
    return false;
  }
  private admitInitialDemand(input: NormalizedSourceDemand, route: ReturnType<Provider['snapshot']>, bytes: number): boolean {
    const state: SourceState = {
      id: ++this.stateSequence, key: input.key, version: input.version, contentVersion: input.version,
      language: input.language, path: input.path, complete: input.complete, neutral: input.neutral,
      provider: route.generation, inputRevision: 1, styleDirty: true, committedUnits: 0, displayStamp: 0,
      empty: !input.text.length, bytes
    };
    if (this.preparing?.keys.has(input.key)) state.group = this.preparing;
    this.states.set(input.key, state);
    if (!state.group) this.work.register(state, workMetadata());
    if (!sourceFits(input.text, Math.min(HIGHLIGHT_LIMITS.sourceBytes, route.description?.limits.source_bytes ?? HIGHLIGHT_LIMITS.sourceBytes))) {
      this.refuseSource(state, 'sourceLimit', route.generation); this.publication.sourceUnavailable(state); this.changed(input.key); return false;
    }
    return this.admit(state, input.text, route.generation);
  }
  private updateDemand(state: SourceState, input: NormalizedSourceDemand, route: ReturnType<Provider['snapshot']>, bytes: number): boolean {
    state.bytes = bytes;
    const latest = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    const sameIdentity = input.language === state.language && input.path === state.path;
    const sameObservation = input.version === state.version && input.complete === state.complete && sameIdentity;
    const reobserve = state.evictionEntitlement === 'reobserve';
    const localEmptyCoverage = latest?.text.length === 0 && input.text.length > 0
      && this.pool.status(state.generation!)?.sourceVersion !== undefined;
    const change = classifySourceInput(state, {
      sameIdentity, sameObservation, complete: input.complete,
      text: input.text, latestText: latest?.text, localEmptyCoverage
    });
    if (!change.equal) state.inputRevision++;
    if (change.proved) { state.retryAt = undefined; state.evictionEntitlement = undefined; }
    if (reobserve) state.evictionEntitlement = 'dispatch';
    state.refusalCause = undefined; state.refusalInput = undefined; state.refusalProvider = undefined; state.refusalGeneration = undefined;
    this.publication.aliasInputDisplay(state, state.version, input.version, latest?.text, input.text, input.complete);
    if (latest?.text !== input.text || change.identityChanged || change.formationChanged) state.contentVersion = input.version;
    // A refused target may have advanced beyond this still-owned matching text.
    else state.contentVersion = Math.min(state.contentVersion, latest!.version);
    state.version = input.version; state.complete = input.complete; state.empty = !input.text.length;
    if (!sourceFits(input.text, Math.min(HIGHLIGHT_LIMITS.sourceBytes, route.description?.limits.source_bytes ?? HIGHLIGHT_LIMITS.sourceBytes))) {
      const reconstruction = state.continuation === null && !change.identityChanged && !change.formationChanged && !change.rewrite;
      this.dropData(state); state.language = input.language; state.path = input.path;
      if (reconstruction) state.continuation = null;
      this.refuseSource(state, 'sourceLimit', route.generation); this.publication.sourceUnavailable(state); this.changed(input.key); return false;
    }
    return this.replaceDemand(state, input, route.generation, change, latest);
  }
  private replaceDemand(state: SourceState, input: NormalizedSourceDemand, provider: number,
    change: ReturnType<typeof classifySourceInput>, latest: SourceSnapshot | undefined): boolean {
    if (!state.group) this.work.rewind();
    if (change.identityChanged || change.formationChanged || change.rewrite) {
      if (!change.identityChanged && state.language === 'bash' && state.generation !== undefined) {
        this.restart(state, state.provider, { version: input.version, text: input.text, evaluatedProvider: provider });
        return this.sourceAvailable(state);
      }
      this.dropData(state); state.language = input.language; state.path = input.path;
      return this.admit(state, input.text, provider);
    }
    if (!latest) return this.admit(state, input.text, provider);
    const result = this.pool.replaceSnapshot(state.generation!, input.version, input.text); this.receipts(result.released);
    if (!result.accepted) this.refuseSource(state, 'storage', provider);
    return result.accepted && state.generation !== undefined;
  }
  private observeDemand(demand: SourceDemand): boolean {
    const input = normalizeSourceDemand(demand), route = this.provider.snapshot();
    const state = this.states.get(input.key);
    const existing = this.inspectDemand(state, input, route);
    if (existing !== undefined) return existing;
    const bytes = stateBytes(input);
    if (!this.charge(bytes - (state?.bytes ?? 0))) return this.refuseMetadataFunding(state, input);
    if (!state) return this.admitInitialDemand(input, route, bytes);
    return this.updateDemand(state, input, route, bytes);
  }

  /** Current logical text for terminal projection; it remains owned by the same
   * native pool entry. Borrowing neither acknowledges colors nor retains a copy. */
  borrowSource(key: string): BorrowedSource | undefined {
    const state = this.states.get(key), generation = state?.generation;
    if (!state || generation === undefined) return undefined;
    const source = this.pool.borrowSnapshot(generation);
    if (!source || source.version !== state.version) return undefined;
    return { ...source, generation, language: state.language, path: state.path, complete: state.complete };
  }

  /** Historical display reads are not current-source proof. Persistent views keep only weak ownership and primitives. */
  displayBasis(key: string): SourceDisplayBasis | undefined { return this.publication.displayBasis(key); }
  displayStamp(key: string, palette?: string, rules?: string, language?: string): number { return this.publication.displayStamp(key, palette, rules, language); }
  readDisplayRole(key: string, id: number, generation: number, version: number, stamp: number, role: CardRole): ConcreteStyle | undefined { return this.publication.readDisplayRole(key, id, generation, version, stamp, role); }
  /** Internal weak-view delivery; source text never escapes as a stored field. */
  visitDisplayBasis(key: string, id: number, generation: number, version: number, stamp: number, consume: (text: string, read: DisplayRangeReader) => void): boolean { return this.publication.visitDisplayBasis(key, id, generation, version, stamp, consume); }
  visitExpressionBasis(...args: Parameters<StylePublication['visitExpressionBasis']>): boolean { return this.publication.visitExpressionBasis(...args); }
  visitExpressionRanges(...args: Parameters<StylePublication['visitExpressionRanges']>): boolean { return this.publication.visitExpressionRanges(...args); }
  visitDisplayStyles(key: string, id: number, generation: number, version: number, stamp: number, consume: (style: ConcreteStyle) => void): boolean { return this.publication.visitDisplayStyles(key, id, generation, version, stamp, consume); }
  visitDisplayRanges(key: string, id: number, generation: number, version: number, stamp: number, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean { return this.publication.visitDisplayRanges(key, id, generation, version, stamp, consume); }


  suspend(): void { if (!this.disposed) { this.suspended = true; this.cancelWake(); this.completeWork(true); } }
  /** First-origin delivery precedes cancellation; only actual inactivation creates re-entry priority. */
  retireProvider(provider: number, origin: ProviderRetirementOrigin): void {
    if (this.disposed) return;
    for (const job of this.jobs.values()) if (job.provider === provider && job.origin === undefined) {
      job.origin = origin;
      const state = job.key === undefined ? undefined : this.states.get(job.key);
      if (origin === 'suspended' && job.operation === 'source' && !job.stopped && state?.id === job.stateId && !state.retired)
        state.withdrawalProvider = provider;
    }
    if (origin === 'suspended') for (const state of this.states.values()) {
      if (state.provider === provider && !sourceUncertain(state)
        && this.sourceQueued(state, this.inspectSource(state), true)) state.withdrawalProvider = provider;
    }
    this.work.rewind(); this.work.schedule();
  }
  resume(): void {
    if (!this.suspended || this.disposed) return;
    this.suspended = false; this.refreshPreparations(); this.work.rewind(); this.work.schedule();
  }
  private cancelWake(): void {
    this.lifetime.wake?.cancel(); this.lifetime.wake = undefined;
    this.wakeAt = undefined; this.wakeToken = undefined;
  }
  /** An expired weak handle requests an ordinary pass; it never performs a work turn. */
  wakeDue(token: object): void {
    if (this.wakeToken !== token) return;
    this.lifetime.wake = undefined; this.wakeAt = undefined; this.wakeToken = undefined;
    if (!this.active || !this.enabled) return;
    this.work.rewind(); this.work.schedule();
  }
  noteWake(at: number): void {
    if (at <= this.clock.now()) return;
    this.wakeMinimum = Math.min(this.wakeMinimum, at);
    if (this.wakeAt === undefined || at < this.wakeAt) this.armWake(at);
  }
  private armWake(at: number): void {
    if (this.wakeAt === at && this.lifetime.wake) return;
    this.cancelWake(); const token = {}; this.wakeToken = token; this.wakeAt = at;
    this.lifetime.wake = this.clock.setTimeout(retryWake(this.owner, token), at - this.clock.now());
    this.lifetime.wake.unref();
  }
  private finishWakePass(pass: number): void {
    if (pass !== this.work.currentPass || pass !== this.wakePass) return;
    const at = this.wakeMinimum;
    if (!this.active || !this.enabled || !Number.isFinite(at)) { this.cancelWake(); return; }
    // A positive visit already armed this deadline; a pause must not cancel its pending delivery.
    if (at > this.clock.now()) this.armWake(at);
  }
  requestProviderOpportunity(): void {
    const snapshot = this.provider.snapshot();
    if (!this.active || !this.enabled || snapshot.availability !== 'unavailable' || snapshot.recoveryAt === undefined) return;
    if (snapshot.recoveryAt > this.clock.now()) this.noteWake(snapshot.recoveryAt);
    else void this.provider.recover().catch(ignored);
  }
  resumePreparation(): void { this.work.resumePreparation(); this.continueWork(); }

  flush(): void { this.runWorkTurn(); }

  private runWorkTurn(): void {
    if (!this.work.enterTurn(!this.suspended)) return;
    try {
      const description = this.beginWorkTurn(), full = () => this.nativeBlock(description) !== undefined;
      while (!this.disposed && !this.suspended && this.work.hasQuota) {
        const currentPass = this.work.currentPass;
        if (this.wakePass !== currentPass) { this.wakePass = currentPass; this.wakeMinimum = Number.POSITIVE_INFINITY; }
        const node = this.work.next();
        if (!node) break;
        const pass = this.work.currentPass;
        if (this.publication.selectionPresent) this.work.notePreparation();
        const result = 'preparation' in node.value
          ? this.visitPreparation(node, description, full, pass)
          : this.visitStandalone(node, description, full, pass);
        if (result === 'credit-stop') break;
      }
      if (this.work.exhausted) this.finishWakePass(this.work.currentPass);
    } finally {
      this.work.finishTurn();
      this.finishLifetime(); this.completeWork();
    }
  }
  private visitStandalone(node: WorkNode, description: Description | undefined, full: () => boolean, pass: number): 'continue' | 'credit-stop' {
    this.publication.prepare(node, description, full());
    if (!this.dispatchSource(node.value as SourceState, description)) return 'continue';
    return this.deferForCredit(node, pass);
  }
  private deferForCredit(node: WorkNode, pass: number): 'continue' | 'credit-stop' {
    this.work.requestRetry();
    if (this.work.hasLocalPending || this.publication.selectionPresent) return 'continue';
    this.work.restoreCursor(node, pass);
    return 'credit-stop';
  }
  private prepareCard(node: WorkNode, entry: SourceWorkGroup,
    preparation: SourcePreparation, description: Description | undefined, full: () => boolean, pass: number): 'prepared' | 'continue' | 'credit-stop' {
    const refresh = this.work.needsRefresh(node);
    if (!node.pending && !(refresh && (preparation.needsRefresh?.(this.work.isNewest(node)) ?? true))) {
      this.work.markPrepared(node); return 'prepared';
    }
    const native = !!description && this.enabled && node.pending !== 'local' && (preparation.requiresCredit?.() ?? true);
    if (native && full()) {
      waitForCredit(this.owner);
      return this.deferForCredit(node, pass);
    }
    if (native && [...entry.keys].some(key => this.keyOccupied(key, 'native'))) return 'continue';
    if (this.suspended || this.disposed) return 'continue';
    if (!this.publication.selectionPresent && !this.work.hasQuota) { this.work.restoreCursor(node, pass); return 'credit-stop'; }
    this.work.markPrepared(node);
    if (!this.publication.selectionPresent) this.work.notePreparation();
    this.preparing = entry;
    try { preparation.prepare(); if (!this.suspended && !this.disposed) this.updatePreparation(entry); }
    finally { this.preparing = undefined; }
    return 'prepared';
  }
  private visitPreparation(node: WorkNode, description: Description | undefined, full: () => boolean, pass: number): 'continue' | 'credit-stop' {
    const entry = node.value as SourceWorkGroup, preparation = entry.preparation.deref();
    if (!preparation) { this.releasePreparation(entry, true); return 'continue'; }
    if (node.paused) return 'continue';
    this.publication.prepare(node, description, full());
    if (this.suspended || this.disposed) return 'continue';
    const result = this.prepareCard(node, entry, preparation, description, full, pass);
    if (result !== 'prepared') return result;
    if (!this.work.current(node, pass) || this.suspended || this.disposed) return 'continue';
    this.publication.prepare(node, description, full());
    for (const key of entry.keys) {
      if (!this.dispatchSource(this.states.get(key), description)) continue;
      return this.deferForCredit(node, pass);
    }
    return 'continue';
  }

  private beginWorkTurn(): Description | undefined {
    const snapshot = this.provider.snapshot();
    if (snapshot.generation !== this.leaseProvider) {
      this.leaseProvider = snapshot.generation; this.remoteLeases = 0;
      this.closes = this.closes.filter(close => { if (close.provider === snapshot.generation) return true; this.charge(-close.bytes); return false; });
    }
    const description = snapshot.availability === 'ready' ? snapshot.description : undefined;
    const ready = !!description && this.enabled;
    if (snapshot.generation !== this.workProvider || ready !== this.workReady) {
      const withdrewProvider = this.workReady && this.enabled && !description;
      this.workProvider = snapshot.generation; this.workReady = ready; this.work.rewind();
      if (withdrewProvider) this.reconcileCreditInterest();
    }
    const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
    if (description) while (this.closes.length && this.jobs.size < jobLimit) {
      const index = this.closes.findIndex(close => !this.keyOccupied(close.ownerKey, 'native')); if (index === -1) break;
      const bytes = this.reservation(0, 0, 0, 0, description);
      if (!this.capacity(bytes)) { waitForCredit(this.owner); break; }
      const close = this.closes.splice(index, 1)[0]!; this.charge(-close.bytes);
      const job = this.job({ operation: 'close', key: close.ownerKey, generation: close.generation, close }, snapshot.generation, description, bytes);
      this.dispatch(job, {
        v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'stream.close',
        key: close.key, generation: close.generation, lease: close.lease
      });
    }
    return description;
  }
  private nativeBlock(description: Description | undefined): 'slots' | 'bytes' | undefined {
    const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
    if (this.jobs.size >= jobLimit || flight.jobs >= CONTROLLER_LIMITS.jobs) return 'slots';
    return this.work.creditBlocked ? 'bytes' : undefined;
  }
  private dispatchSource(state: SourceState | undefined, description: Description | undefined): boolean {
    if (!state || !this.enabled || !this.active || state.retired || state.frozen) return false;
    const decision = this.dispatchDecision(state, description);
    if (!decision) return false;
    if (decision.kind === 'delayed') { this.noteWake(decision.at); return false; }
    if (decision.kind === 'provider') { this.requestProviderOpportunity(); return false; }
    if (decision.kind !== 'parse' || !description) return false;
    const blocked = this.nativeBlock(description);
    if (blocked) {
      // A known byte denial blocks the queue, not necessarily this particular text.
      if (blocked === 'slots' && state.generation !== undefined && state.waitedGeneration !== state.generation) {
        this.pool.noteSourceUse(state.generation); state.waitedGeneration = state.generation;
      }
      waitForCredit(this.owner); return true;
    }
    if (decision.reconstruction && state.generation !== undefined && (this.pool.status(state.generation)?.revision ?? 0) > 0) {
      this.restart(state, state.provider);
      if (this.closes.some(close => close.ownerKey === state.key)) { this.work.schedule(); return false; }
    }
    return this.prepare(state, description, decision.reconstruction) === 'credit';
  }
  private dispatchDecision(state: SourceState, description: Description | undefined): SourceDecision | undefined {
    if (description && !this.provider.isReady(this.workProvider)) return;
    if (this.keyOccupied(state.key, 'native') || this.closes.some(close => close.ownerKey === state.key)) return;
    if (!description) return this.sourceDecision(state, false);
    if (state.withdrawalProvider !== undefined && state.withdrawalProvider !== this.workProvider) state.withdrawalProvider = undefined;
    if (!admittedSource(state)) return;
    if (state.provider === this.workProvider) return this.sourceDecision(state, false);
    const facts = this.inspectSource(state);
    if (!matchingSourceVersion(state, facts?.textVersion)) return;
    if (!this.sourceSatisfied(state, facts?.parsed)) {
      if (!facts?.parsed && !state.continuation) {
        state.provider = this.workProvider; state.continuation = undefined;
      } else this.restart(state, this.workProvider);
    }
    // Reconciliation can retire jobs and replace or lose the source generation.
    return this.sourceDecision(state);
  }

  workStatus(key: string): SourceWorkStatus {
    const state = this.states.get(key);
    const pending = this.keyOccupied(key, 'fallback');
    const ready = !!state && this.enabled && !state.retired && this.provider.snapshot().availability === 'ready';
    const facts = ready ? this.inspectSource(state) : undefined;
    const queued = !!state && ready && (this.sourceQueued(state, facts, ready) || state.styleDirty && facts?.parsed !== undefined);
    const execution = sourceExecution(state, pending);
    return {
      version: state?.version, execution, fallbackEligible: !this.disposed
        && (state?.withdrawalProvider === undefined || this.provider.snapshot().availability === 'unavailable')
        && !state?.frozen && !pending && !queued && (!state || !sourceUncertain(state))
        && (execution === 'not_started' || execution === 'acknowledged')
    };
  }
  ownedStopped(provider: number): void {
    for (const reference of this.lifetime.jobs) {
      const job = reference.deref();
      if (job?.reserved && job.provider === provider && job.operation === 'source' && job.kind === 'owned') {
        job.stopped = true; job.source = undefined;
        if (this.states.get(job.key)?.id === job.stateId) this.changed(job.key);
      }
    }
    if (this.disposed) return;
    for (const state of this.states.values()) {
      const evidence = state.ownedUnknown === provider;
      if (evidence) state.ownedUnknown = undefined;
      if (state.attemptProvider === provider && (state.attemptOutcome === 'unknown' || state.attemptOutcome === 'started' || state.attemptOutcome === 'withdrawn')) {
        state.attemptOutcome = 'stopped'; this.changed(state.key);
      } else if (evidence) this.changed(state.key);
    }
    this.work.rewind(); this.work.schedule();
  }
  status(key: string): SourceRecordStatus | undefined {
    const state = this.states.get(key); if (!state || state.retired) return undefined;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const result = current?.sourceVersion !== undefined ? current : !state.previousCoverage || state.previous === undefined ? undefined : this.pool.status(state.previous);
    const exact = admittedSource(state) && (state.empty || matchingSourceVersion(state, result?.sourceVersion));
    // Waiting/retired demand is not execution proof: a still-held source job,
    // including a removed/reused key, remains the physical attempt authority.
    const execution = this.workStatus(key).execution;
    const provider = this.provider.snapshot();
    // Publication may install zero-byte ranges for local empty paint without a parser reply.
    const acknowledgedVersion = current && current.sourceBytes > 0 && provider.generation === state.parsedProvider && provider.availability === 'ready'
      ? current.sourceVersion : undefined;
    return {
      generation: state.generation, version: state.version, acknowledgedVersion,
      classificationVersion: state.empty ? undefined : result?.sourceVersion, committedBytes: result?.committedBytes ?? 0, exact,
      execution, availability: this.disposed ? 'disposed' : !this.enabled ? 'disabled' : provider.availability,
      protective: sourceRefused(state) || sourceUncertain(state), fallbackEligible: !exact && this.workStatus(key).fallbackEligible, complete: state.complete
    };
  }
  visitRanges(key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean { return this.publication.visitRanges(key, consume); }
  stats(): SourceExecutionStats {
    return {
      ...this.counters, styleCaptures: [...this.jobs.values()].filter(job => job.operation === 'style' && job.style).length, unsettledJobs: this.jobs.size, captures: [...this.jobs.values()].filter(job => job.operation === 'source' && job.source).length,
      globalUnsettledJobs: flight.jobs, globalTransientBytes: flight.bytes, transientBytes: this.transientBytes, maxTransientBytes: this.maxTransientBytes,
      remoteLeases: this.remoteLeases, pendingCloses: this.closes.length, sourceRecords: this.states.size, piSourceRecords: this.pi.size,
      guardRecords: [...this.states.values()].filter(state => state.generation === undefined || sourceUncertain(state)).length,
      bookkeepingBytes: this.lifetime.bytes, globalBookkeepingBytes: flight.bookkeepingBytes, waitingOwners: waiters.size,
      retention: this.pool.stats()
    };
  }
  /** One explicit retry per unchanged demand. Caller must observe its full source
   * after permission, not issue retryEvicted from every render frame. */
  retryEvicted(key: string): boolean {
    const state = this.states.get(key);
    if (!this.enabled || !this.active || !state || state.retired || state.evictionEntitlement !== undefined) return false;
    state.evictionEntitlement = 'reobserve'; return true;
  }
  /** Abandon native work while keeping one charged validated presentation. Only owner removal can admit a fresh incarnation. */
  freeze(key: string): void {
    const state = this.states.get(key);
    if (!state || state.frozen || this.disposed) return;
    const current = state.generation, previous = state.previous;
    const generation = displayGeneration(state, this.pool) ?? (current !== undefined && this.pool.status(current)?.sourceVersion !== undefined ? current : undefined);
    this.retire(state, true, false);
    state.generation = undefined; state.previous = generation; state.previousCoverage = false;
    state.frozen = true; state.retired = true;
    if (current !== undefined && current !== generation) this.receipts(this.pool.remove(current));
    if (previous !== undefined && previous !== generation) this.receipts(this.pool.remove(previous));
    if (generation !== undefined) this.pool.retainBasis(generation);
    this.publication.freezeDisplay(state, generation);
    this.changed(key); this.reconcileCreditInterest(); this.work.schedule();
  }
  remove(key: string): void {
    const current = this.states.has(key);
    this.drainRetirements(); this.removeSource(key, false);
    if (current) this.reconcileCreditInterest();
  }
  private removeSource(key: string, deferred: boolean): void {
    this.pi.remove(key);
    this.noticeKeys.delete(key);
    const state = this.states.get(key); if (!state) return;
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' });
    this.dropData(state, deferred); this.states.delete(key); this.removeWork(state, deferred); this.charge(-state.bytes);
    if (state.group) { const node = this.work.get(state.group); if (node) this.publication.dropGroup(node, true); }
    if (!this.states.size && ![...this.work.values()].some(node => node.seal)) this.publication.clearCache();
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    if (!enabled) { this.cancelWake(); this.completeWork(true); this.drainRetirements(); }
    this.enabled = enabled; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    if (!enabled) {
      for (const node of this.work.values()) this.publication.dropGroup(node, true);
      for (const job of this.jobs.values()) if (job.operation === 'style') { releaseStyle(job); job.abort.abort(sourceRetired); }
      this.publication.clearCache(); waiters.delete(this.owner);
      for (const [key, state] of this.states) {
        state.withdrawalProvider = undefined; state.retryAt = undefined;
        // Retained history must not carry a no-start veto into fresh native interest.
        if (state.attemptOutcome === 'not_started') state.attemptInput = undefined;
        this.dropData(state);
        if (state.frozen || this.keyOccupied(key, 'any') || sourceUncertain(state) || state.sharedUnknown || state.ownedUnknown !== undefined) {
          state.retired = true;
        } else { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.states.delete(key); this.removeWork(state); this.charge(-state.bytes); }
      }
      this.pi.clear(); this.receipts(this.pool.clear()); this.flush();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelWake(); this.completeWork(true); this.drainRetirements();
    for (const [entry, node] of this.work) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' }); if ('preparation' in entry) { this.publication.dropGroup(node, true); this.charge(-groupBytes); } }
    this.work.clear();
    this.setEnabled(false);
    // Pi fallback may have been captured while the native controller was already off.
    this.pi.clear();
    this.disposed = true; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    for (const state of this.states.values()) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.charge(-state.bytes); }
    this.states.clear();
    this.lifetime.data = undefined; this.publication.disposeSelectionAndCache(); this.pool.dispose();
    // Only an unanswered open needs its existing capture to validate and close
    // a late-created lease. Removed source/color authority never returns.
    for (const job of this.jobs.values()) if (job.operation === 'source' && !job.source?.open) job.source = undefined;
    this.finishLifetime();
  }
  private charge(delta: number): boolean {
    if (this.lifetime.bytes + delta > this.maxBookkeepingBytes || flight.bookkeepingBytes + delta > CONTROLLER_LIMITS.bookkeepingBytes) return false;
    this.lifetime.bytes += delta; flight.bookkeepingBytes += delta; return true;
  }
  private finishLifetime(): void {
    if (!this.disposed || this.jobs.size || this.transientBytes || this.closes.length || !this.lifetime.bytes) return;
    waiters.delete(this.owner); lifetimes.unregister(this.lifetime); this.charge(-this.lifetime.bytes);
  }
  private keyOccupied(key: string, purpose: 'fallback' | 'native' | 'any'): boolean {
    for (const reference of this.lifetime.jobs) {
      const job = reference.deref();
      if (!job?.reserved || job.key !== key) continue;
      if (purpose === 'any' || job.operation === 'source' && (purpose !== 'fallback' || !job.stopped)
        || purpose === 'native' && job.operation === 'close') return true;
    }
    return false;
  }
  private wireKey(): string { return `source:${this.id}:${++this.wireSequence}`; }
  log(level: DiagnosticLevel, explanation: string, fields?: DiagnosticFields): void {
    if (this.options.diagnostic) diagnose(this.options.diagnostic, level, 'syntax', explanation, { controller: this.id, ...fields });
  }
  private admit(state: SourceState, text: string, evaluatedProvider: number): boolean {
    const result = this.pool.admit(this.wireKey(), state.version, text); this.receipts(result.released);
    if (!result.accepted) {
      this.log('WARN', 'Native source storage refused; no source dispatched', { source: state.key, version: state.version, units: text.length });
      this.refuseSource(state, 'storage', evaluatedProvider); return false;
    }
    this.log('DEBUG', 'Native source admitted', { source: state.key, version: state.version, generation: result.generation, language: state.language, units: text.length });
    state.generation = result.generation; state.committedUnits = 0; this.publication.invalidateSource(state);
    return true;
  }
  private restart(state: SourceState, provider: number, target?: Pick<SourceDemand, 'version' | 'text'> & { evaluatedProvider: number }, cancel = true): void {
    const oldGeneration = state.generation, previous = state.previous;
    const reconstruction = state.continuation === null && provider === state.provider && target === undefined;
    const latest = target ?? (oldGeneration === undefined ? undefined : this.pool.borrowSnapshot(oldGeneration)); if (!latest) return;
    const covered = oldGeneration !== undefined && this.pool.status(oldGeneration)?.sourceVersion !== undefined ? oldGeneration : previous;
    const coveredStatus = covered === undefined ? undefined : this.pool.status(covered);
    // Parser progress cannot replace an independently owned ready display.
    const retained = displayGeneration(state, this.pool) ?? covered;
    const reuse = this.reusableSourceBasis(state, covered, coveredStatus, latest.text);
    const previousCoverage = !target && (retained === oldGeneration || state.previousCoverage);
    // Superseded selections keep their physical credit until normal settlement.
    this.retire(state, cancel);
    if (reconstruction) state.continuation = null;
    // Detach the obsolete parser basis before admission receipts. Releasing its
    // empty entry must not also release a compatible independently held result.
    state.generation = undefined; state.previous = retained; state.previousCoverage = previousCoverage; state.provider = provider;
    if (retained !== undefined) this.pool.retainBasis(retained);
    this.releaseRestartBasis(oldGeneration, retained, covered, reuse);
    this.releaseRestartBasis(previous, retained, covered, reuse);
    const result = reuse ? this.pool.replaceSnapshot(covered!, latest.version, latest.text)
      : this.pool.admit(this.wireKey(), latest.version, latest.text);
    this.receipts(result.released);
    if (!result.accepted) { this.refuseSource(state, 'storage', target?.evaluatedProvider ?? provider); return; }
    state.generation = reuse ? covered : result.generation; state.committedUnits = 0;
    if (reuse) {
      if (state.previous === covered) { state.previous = undefined; state.previousCoverage = false; }
      state.contentVersion = coveredStatus!.sourceVersion!;
      this.publication.sourceReused(state);
      // Missing metadata defers compatibility, not ownership of valid annotations.
    }
  }
  private releaseRestartBasis(generation: number | undefined, retained: number | undefined, covered: number | undefined, reuse: boolean): void {
    if (generation !== undefined && generation !== retained && (!reuse || generation !== covered)) this.receipts(this.pool.remove(generation));
  }
  private reusableSourceBasis(state: SourceState, covered: number | undefined,
    status: ReturnType<SemanticRetentionPool['status']>, text: string): boolean {
    const snapshot = this.provider.snapshot(), description = snapshot.availability === 'ready' ? snapshot.description : undefined;
    const compatible = !!description && description.assets === state.parsedAssets
      && description.vocabulary.fingerprint === status?.vocabulary;
    return !!(state.complete && status?.complete && (!description || compatible)
      && this.pool.borrowSnapshot(covered!, 'basis')?.text === text);
  }
  private retire(state: SourceState, cancel = true, styles = true, deferred = false): void {
    // Freeze retains the exact display view; proofs still require its actual
    // generation/stamp/version, rather than converting current data into proof.
    this.publication.invalidateSource(state, !styles);
    if (cancel) this.retireSourceJobs(state, styles, deferred);
    if (state.continuation && state.generation !== undefined) {
      const key = this.pool.status(state.generation)?.key;
      if (key) this.close({ key, ownerKey: state.key, generation: state.generation, lease: state.continuation, provider: state.provider, health: new WeakRef(state) });
    }
    state.continuation = undefined;
  }
  private retireSourceJobs(state: SourceState, styles: boolean, deferred: boolean): void {
    for (const job of this.jobs.values()) {
      const style = styles && job.operation === 'style' && job.style?.members.some(member => member.id === state.id);
      if (job.operation === 'style' ? !style : job.operation !== 'source' || job.stateId !== state.id) continue;
      this.cancelJob(job, deferred);
      if (style) releaseStyle(job);
    }
  }
  private dropData(state: SourceState, deferred = false): void {
    if (state.group) { const node = this.work.get(state.group); if (node) this.publication.dropGroup(node); }
    this.retire(state, true, true, deferred);
    const current = state.generation, previous = state.previous; state.generation = undefined; state.previous = undefined;
    state.previousCoverage = false; this.publication.clearDisplayReceipt(state);
    if (current !== undefined) this.pool.remove(current);
    if (previous !== undefined) this.pool.remove(previous);
  }
  private close(close: Omit<Close, 'bytes'>): void {
    if (!this.provider.isReady(close.provider) || this.closes.some(item => item.lease === close.lease)
      || [...this.jobs.values()].some(job => job.operation === 'close' && job.close.lease === close.lease)) return;
    const bytes = 288 + 2 * (close.key.length + close.ownerKey.length + close.lease.length);
    if (!this.charge(bytes)) { this.counters.cleanupRefusals++; return; }
    this.closes.push({ ...close, bytes });
  }
  receipts(receipts: readonly ReleaseReceipt[], deferred = false): void {
    // Cascaded previous releases complete before the withdrawal wake.
    if (this.releaseReceipts(receipts, deferred)) {
      this.reconcileCreditInterest();
      if (this.lifetime.wake || Number.isFinite(this.wakeMinimum)) { this.work.rewind(); this.work.schedule(); }
    }
  }
  private releaseReceipts(receipts: readonly ReleaseReceipt[], deferred: boolean): boolean {
    let withdrew = false;
    for (const receipt of receipts) {
      if (this.pi.releaseGeneration(receipt.generation)) continue;
      for (const state of this.states.values()) {
        if (state.previous === receipt.generation) { withdrew = true; this.releasePriorReceipt(state, receipt.generation); }
        if (state.generation !== receipt.generation) continue;
        withdrew = true; this.releaseCurrentReceipt(state, receipt, deferred);
        break;
      }
    }
    return withdrew;
  }
  private releasePriorReceipt(state: SourceState, generation: number): void {
    this.publication.withdrawDisplay(state, generation, 'prior-group');
    this.publication.invalidateSource(state);
    state.previous = undefined; state.previousCoverage = false;
    this.publication.withdrawDisplay(state, generation, 'prior-notice');
  }
  private releaseCurrentReceipt(state: SourceState, receipt: ReleaseReceipt, deferred: boolean): void {
    const reconstruction = state.continuation === null;
    if (state.continuation) this.close({ key: receipt.key, ownerKey: state.key, generation: receipt.generation, lease: state.continuation, provider: state.provider, health: new WeakRef(state) });
    state.continuation = undefined; this.retire(state, true, true, deferred); state.generation = undefined;
    if (reconstruction) state.continuation = null;
    this.refuseSource(state, 'storage');
    this.publication.withdrawDisplay(state, receipt.generation, 'current');
    if (state.previous !== undefined) { const previous = state.previous; state.previous = undefined; this.releaseReceipts(this.pool.remove(previous), deferred); }
  }
  private recordSourceOutcome(job: SourceJob, outcome: SourceOutcome, cause?: SourceCause): boolean {
    const state = this.states.get(job.key);
    if (this.disposed || job.stopped || !state || state.id !== job.stateId) return false;
    if (outcome === 'unknown' || outcome === 'started') {
      if (job.kind === 'owned') state.ownedUnknown = job.provider;
      else state.sharedUnknown = true;
    }
    // A retired no-start settles history without suppressing newly admitted work.
    state.attemptInput = outcome === 'not_started' && !this.currentSourceAttempt(state, job) ? undefined : job.inputRevision;
    state.attemptProvider = job.provider; state.attemptOutcome = outcome; state.attemptCause = cause;
    return true;
  }
  private currentSourceAttempt(state: SourceState | undefined, job: SourceJob): state is SourceState {
    return this.active && this.enabled && !!state && state.id === job.stateId && !state.retired && !state.frozen
      && admittedSource(state) && state.inputRevision === job.inputRevision && state.provider === job.provider
      && this.provider.isReady(job.provider) && state.generation === job.generation && !!this.pool.status(job.generation)
      && !job.stopped && !job.pendingRetire && !job.abort.signal.aborted && job.origin === undefined;
  }
  styleOverlap(vocabulary: string, rules: string, refs: readonly ContextRef[]): StyleOverlapView | undefined {
    for (const job of this.jobs.values()) {
      if (job.operation === 'style' && job.style?.expected.vocabulary === vocabulary && job.style.expected.rules === rules
        && refs.some(ref => job.style!.refs.includes(ref))) return job;
    }
    return undefined;
  }
  submitStyle(dispatch: StyleDispatch, attached: (outcome: StyleAttempt) => void): void {
    const first = dispatch.style.members[0], { description } = dispatch;
    const job = this.job({
      operation: 'style', key: first?.key, generation: first?.generation,
      outcome: { provider: dispatch.provider }, style: dispatch.style
    }, dispatch.provider, description, dispatch.bytes);
    job.kind = this.provider.snapshot().kind;
    attached(job.outcome);
    job.styleCharge = dispatch.charge.retain();
    this.counters.styleDispatches++;
    const admission = this.options.admission ?? 'bounded_queue';
    const common = {
      v: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'styles.resolve' as const,
      vocabulary: dispatch.style.expected.vocabulary, contexts: dispatch.contexts, rules: dispatch.definition
    };
    const request = admission === 'bounded_queue'
      ? { ...common, admission, queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) }
      : { ...common, admission };
    this.dispatch(job, request);
  }
  releaseSupersededBasis(member: StyleMember): void {
    const state = this.states.get(member.key)!;
    if (state.previous !== undefined && state.previous !== member.generation) {
      const previous = state.previous; state.previous = undefined; state.previousCoverage = false;
      this.receipts(this.pool.remove(previous));
    }
  }
  finishStyleReply(job: StyleReplyView, workerUnavailable: boolean): void {
    this.release(this.jobs.get(job.id)!);
    try { if (workerUnavailable && this.active) void this.provider.workerUnavailable(job.provider).catch(ignored); }
    finally { this.work.rewind(); this.work.schedule(); this.finishLifetime(); }
  }
  private reservation(captureUnits: number, replacementUnits: number, inputUnits: number, replacementBytes: number, d: Description): number {
    return sourceReservation({
      captureUnits, replacementUnits, inputUnits, replacementBytes,
      frameBytes: Math.min(OCCIPITAL_LIMITS.dataWireBytes, Math.max(d.limits.request_bytes, d.limits.reply_bytes)),
      decodedBytes: this.maxDecodedBytes
    });
  }
  capacity(bytes: number): boolean {
    return flight.jobs < CONTROLLER_LIMITS.jobs && this.transientBytes + bytes <= this.maxTransientBytes
      && flight.bytes + bytes <= CONTROLLER_LIMITS.transientBytes;
  }
  private prepare(state: SourceState, description: Description, reconstruction: boolean): 'credit' | void {
    if (state.generation === undefined) return;
    const snapshot = this.pool.borrowSnapshot(state.generation), basis = this.pool.borrowSnapshot(state.generation, 'basis');
    const status = this.pool.status(state.generation); if (!snapshot || !basis || !status) return;
    if (state.empty) return;
    if (snapshot.utf8Bytes > Math.min(HIGHLIGHT_LIMITS.sourceBytes, description.limits.source_bytes)) {
      this.refuseSource(state, 'sourceLimit'); this.changed(state.key); return;
    }
    const lease = state.continuation ?? undefined, append = lease !== undefined, open = !append && !state.complete;
    if (open && !this.sourceLeaseAvailable(state, description)) return;
    const from = append ? state.committedUnits : 0, inputFrom = append ? basis.text.length : 0;
    const inputBytes = snapshot.utf8Bytes - (append ? basis.utf8Bytes : 0);
    const replacementBytes = snapshot.utf8Bytes - (append ? status.committedBytes : 0);
    const bytes = this.reservation(snapshot.text.length, snapshot.text.length - from, snapshot.text.length - inputFrom, replacementBytes, description);
    if (bytes > this.maxTransientBytes) { this.refuseSource(state, 'requestLimit'); this.changed(state.key); return; }
    if (!this.capacity(bytes)) {
      // Sizing already borrowed this text; later slot waits are not another use.
      state.waitedGeneration = state.generation;
      this.work.noteCreditBlocked(); waitForCredit(this.owner); return 'credit';
    }
    const job = this.job({ operation: 'source', key: state.key, generation: state.generation, stateId: state.id, inputRevision: state.inputRevision, source: undefined }, state.provider, description, bytes);
    if (!this.captureSourceRequest(job, state, snapshot, status, from, open)) return;
    const request = this.sourceRequest(job, state, basis);
    // The transport/codec alone checks the actual encoded frame size. No JSON
    // serialization or worst-case-size rejection happens at this boundary.
    if (open) this.remoteLeases++;
    if (reconstruction) {
      const node = this.work.get(state.group ?? state);
      if (node) node.resyncAt = this.clock.now() + SOURCE_RETRY_MS;
      this.counters.restarts++;
    }
    if (state.evictionEntitlement === 'dispatch') state.evictionEntitlement = 'consumed';
    this.counters.preparedBytes += inputBytes; this.dispatch(job, request);
  }
  private captureSourceRequest(job: SourceJob, state: SourceState, snapshot: SourceSnapshot,
    status: NonNullable<ReturnType<SemanticRetentionPool['status']>>, from: number, open: boolean): boolean {
    const replacementText = snapshot.text.slice(from), lease = state.continuation ?? undefined;
    if (!coherent(replacementText)) { this.physicalSettled(job); this.refuseSource(state, 'encoding'); this.changed(state.key); return false; }
    if (!this.active || !this.enabled) { this.physicalSettled(job); return false; }
    const expected: ExpectedSource = {
      key: status.key, generation: state.generation!, source_version: snapshot.version,
      revision: status.revision + 1, source_bytes: snapshot.utf8Bytes, replace_from: lease === undefined ? 0 : status.committedBytes, complete: state.complete,
      ...(lease === undefined ? {} : { lease }), replacementText
    };
    job.kind = this.provider.snapshot().kind;
    job.source = { capture: { version: snapshot.version, text: snapshot.text }, expected, replaceUnits: from, open, decodedBytes: this.maxDecodedBytes };
    return true;
  }
  private sourceLeaseAvailable(state: SourceState, description: Description): boolean {
    if (this.remoteLeases < description.limits.leases_per_route) return true;
    const known = this.closes.some(close => close.provider === state.provider)
      || [...this.states.values()].some(source => source.provider === state.provider && typeof source.continuation === 'string');
    if (!known && this.jobs.size === 0) void this.provider.exhaustedRoute(state.provider).catch(ignored);
    else { this.work.requestRetry(); waitForCredit(this.owner); }
    return false;
  }
  private sourceRequest(job: SourceJob, state: SourceState, basis: SourceSnapshot): SemanticDataRequest {
    const { expected, capture } = job.source!, { description } = job;
    const admission = this.options.admission ?? 'bounded_queue';
    const common = { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance } as const;
    const admissionFields = admission === 'bounded_queue'
      ? { admission, queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) }
      : { admission };
    return expected.lease !== undefined
      ? {
        ...common, ...admissionFields, op: 'stream.append', key: expected.key, generation: state.generation!, lease: expected.lease,
        base_revision: expected.revision - 1, base_bytes: basis.utf8Bytes, source_version: capture.version,
        append: capture.text.slice(basis.text.length), final: state.complete
      }
      : {
        ...common, ...admissionFields, op: state.complete ? 'highlight' : 'stream.open', sources: [{
          key: expected.key,
          generation: state.generation!, source_version: capture.version,
          hint: { ...(state.language === undefined ? {} : { language: state.language }), ...(state.path === undefined ? {} : { path: state.path }) }, text: capture.text
        }]
      };
  }
  private job(operation: SourceOperation, provider: number, description: Description, bytes: number): SourceJob;
  private job(operation: StyleOperation, provider: number, description: Description, bytes: number): StyleRequest;
  private job(operation: CloseOperation, provider: number, description: Description, bytes: number): CloseJob;
  private job(operation: SourceOperation | StyleOperation | CloseOperation, provider: number, description: Description, bytes: number): Job {
    const id = ++this.sequence;
    const job: Job = { ...operation, id, provider, ticket: `controller:${this.id}:${id}`, description, bytes, abort: new AbortController(), reserved: true, replySize: {} };
    job.lifetimeRef = new WeakRef(job); this.lifetime.jobs.add(job.lifetimeRef);
    flight.jobs++; flight.bytes += bytes; this.jobs.set(id, job); this.transientBytes += bytes;
    this.counters.peakTransientBytes = Math.max(this.counters.peakTransientBytes, this.transientBytes);
    this.counters.peakJobs = Math.max(this.counters.peakJobs, this.jobs.size); return job;
  }
  private dispatch(job: Job, request: SemanticDataRequest): void {
    this.counters.dispatches++; const observers = completion(this.owner, job);
    this.log('DEBUG', 'Native job dispatched', {
      source: job.key, job: job.id, generation: job.generation, provider: job.provider,
      operation: typeof request.op === 'string' ? request.op : 'unknown', version: job.operation === 'source' ? job.source?.expected.source_version : undefined,
      sourceBytes: job.operation === 'source' ? job.source?.expected.source_bytes : undefined, reservedBytes: job.bytes
    });
    try { dataJsonBytes(request, Math.min(OCCIPITAL_LIMITS.dataWireBytes, job.description.limits.request_bytes)); }
    catch { observers.failed(Object.assign(new RequestFailure('occipital data request byte limit', 'not_started'), { code: 'frame_limit' })); return; }
    try {
      void this.provider.request(job.provider, request, { signal: job.abort.signal, deadlineMs: this.options.deadlineMs, acceptRetired: true, replySize: job.replySize })
        .then(observers.reply, observers.failed).catch(ignored);
    } catch (error) { observers.failed(error); }
  }
  private release(job: Job): void {
    this.jobs.delete(job.id);
    if (job.operation === 'source') job.source = undefined;
    releaseStyle(job);
  }
  physicalSettled(job: Job): void {
    try {
      let permission: SourceWorkStatus | undefined;
      try { if (job.operation === 'source') permission = this.workStatus(job.key); }
      finally {
        this.release(job);
        if (job.reserved) this.transientBytes -= job.bytes;
        releaseRequest(job);
        if (job.lifetimeRef) this.lifetime.jobs.delete(job.lifetimeRef);
      }
      if (job.operation === 'source' && permission && !this.disposed) this.notifySettledPermission(job, permission);
    } finally { this.finishLifetime(); this.completeWork(); }
  }
  private notifySettledPermission(job: SourceJob, permission: SourceWorkStatus): void {
    const next = this.workStatus(job.key), current = this.states.get(job.key);
    if (permission.execution === next.execution && permission.fallbackEligible === next.fallbackEligible) return;
    if (current) this.log('DEBUG', next.fallbackEligible ? 'Fallback permission available; not a fallback invocation (no Pi fallback for Bash)' : 'Source authority prohibits duplicate fallback classification',
      { source: job.key, version: current.version, execution: next.execution, fallbackEligible: next.fallbackEligible });
    this.changed(job.key);
  }
  private cancelJob(job: Job, deferred: boolean): void {
    if (deferred) { job.pendingRetire = true; this.work.schedule(); }
    else { job.pendingRetire = undefined; job.abort.abort(sourceRetired); }
  }
  private drainRetirements(): void {
    for (const job of this.jobs.values()) if (job.pendingRetire) {
      job.pendingRetire = undefined; job.abort.abort(sourceRetired);
    }
  }
  /** Only the scheduled continuation drains render-pressure effects. A direct flush must stay inert. */
  continueWork(): void { this.drainRetirements(); this.runWorkTurn(); }
  reconcileCreditInterest(): void {
    // Credit interest is conservative; normal queue traversal reestablishes only the interest still owed.
    if (waiters.delete(this.owner)) this.wake();
  }
  wake(): void { this.work.wake(); }
  changed(key: string): void {
    if (!this.options.onChange || this.disposed || !this.states.has(key) && !this.pi.has(key)) return;
    this.noticeKeys.add(key);
    if (this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(notice(this.owner, this.noticeEpoch));
  }
  /** Weak notification delivery; an obsolete off/on epoch cannot erase a newer notice. */
  changedGroup(id: number): void {
    if (!this.options.onChange || this.disposed || !this.enabled) return;
    this.noticeGroups.add(id);
    if (this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(notice(this.owner, this.noticeEpoch));
  }
  notifyChange(epoch: number): void {
    if (epoch !== this.noticeEpoch) return;
    this.noticeScheduled = false;
    if (this.disposed) return;
    const keys = [...this.noticeKeys], groups = [...this.noticeGroups]; this.noticeKeys.clear(); this.noticeGroups.clear();
    this.notifying = true;
    try { if (keys.length || groups.length) this.options.onChange?.(keys, groups.length ? groups : undefined); } catch { /* Caller presentation must not disrupt source ownership. */ }
    finally { this.notifying = false; this.completeWork(); }
  }
  settle(job: Job, raw: unknown, rejected: boolean): void {
    if (!this.jobs.has(job.id)) return;
    if (job.operation === 'style') this.publication.settle(job, raw, rejected);
    else if (job.operation === 'close') this.settleClose(job, raw, rejected);
    else this.settleSource(job, raw, rejected);
  }
  private settleClose(job: CloseJob, raw: unknown, rejected: boolean): void {
    const owner = job.close.health?.deref(), healthOwner = owner && this.states.get(job.key) === owner ? owner : undefined;
    const operation = `lease:${job.generation}`;
    let workerUnavailable = false;
    try {
      if ((job.origin === 'suspended')) return;
      if (rejected) throw raw;
      try { decodeClosed(raw, job.ticket, job.description); }
      catch (error) { workerUnavailable = error instanceof RemoteFault && error.code === 'worker_gone'; throw error; }
      if (healthOwner) reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: healthOwner, operation });
      this.log('DEBUG', 'Native source lease close acknowledged', { source: job.key, job: job.id, provider: job.provider });
      if (this.provider.isReady(job.provider) && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
    } catch (error) {
      if (healthOwner && this.unexpectedJobFailure(job, error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation, area: 'syntax', code: diagnosticError(error) });
      this.log(this.unexpectedJobFailure(job, error) ? 'ERROR' : 'WARN',
        'Native lease close failed; its liability remains unproven', { source: job.key, job: job.id, provider: job.provider, code: diagnosticError(error) });
    } finally { this.finishKeyReply(job, workerUnavailable); }
  }
  private settleSource(job: SourceJob, raw: unknown, rejected: boolean): void {
    const providerCurrent = this.provider.isReady(job.provider), state = this.states.get(job.key);
    const healthOwner = state?.id === job.stateId ? state : undefined;
    const useful = this.usefulSourceReply(state, job, providerCurrent);
    let changed = false, acknowledged = false, workerUnavailable = false;
    try {
      if (job.origin === 'suspended') { changed = this.recordSourceOutcome(job, 'withdrawn'); return; }
      if (rejected) { changed = this.rejectSourceRequest(job, raw, providerCurrent, healthOwner); return; }
      if (!job.source || job.stopped) return;
      const source = job.source, chunk = decodeSemanticSourceReply(raw, job.ticket, job.description,
        [source.expected], source.decodedBytes, HIGHLIGHT_LIMITS, job.replySize).sources[0]!;
      this.counters.decodedBytes += chunk.source_bytes - chunk.replace_from;
      acknowledged = true; changed = this.recordSourceOutcome(job, 'acknowledged');
      if (this.currentSourceAttempt(state, job)) state.retryAt = undefined;
      if (!useful || !this.active) { this.staleSourceReply(job, source, chunk, providerCurrent, healthOwner); return; }
      this.adoptSourceReply(state!, job, source, chunk, healthOwner);
    } catch (error) {
      this.reportSourceFailure(job, healthOwner, error);
      if (acknowledged) {
        if (state?.id === job.stateId) this.refuseSource(state, 'adoption');
        throw error;
      }
      const { outcome, cause } = this.classifySourceFailure(job, error, providerCurrent);
      if (outcome === 'not_started' && job.source?.open && providerCurrent && this.leaseProvider === job.provider)
        this.remoteLeases = Math.max(0, this.remoteLeases - 1);
      changed = this.recordSourceOutcome(job, outcome, cause);
      if (cause === 'resync') this.loseSourceContinuation(state, job);
      if (cause === 'retry' && this.currentSourceAttempt(state, job)) state.retryAt = this.clock.now() + SOURCE_RETRY_MS;
      workerUnavailable = error instanceof RemoteFault && error.code === 'worker_gone';
    } finally { this.finishKeyReply(job, workerUnavailable, changed); }
  }
  private finishKeyReply(job: SourceJob | CloseJob, workerUnavailable: boolean, changed = false): void {
    this.release(job);
    try { if (workerUnavailable && this.active) void this.provider.workerUnavailable(job.provider).catch(ignored); }
    finally {
      this.work.schedule(); this.finishLifetime();
      const current = this.states.get(job.key);
      if (current) this.work.revisit(current.group ?? current, this.sourceOwed(current) || current.styleDirty);
      if (changed && job.operation === 'source' && current?.id === job.stateId) this.changed(job.key);
    }
  }
  private usefulSourceReply(state: SourceState | undefined, job: SourceJob, providerCurrent: boolean): boolean {
    return !!(this.active && this.enabled && !job.stopped && !job.pendingRetire && providerCurrent && !job.abort.signal.aborted
      && state?.id === job.stateId && admittedSource(state) && state.generation === job.generation && this.pool.status(job.generation));
  }
  private unexpectedJobFailure(job: Job, error: unknown): boolean {
    return !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error);
  }
  private reportSourceFailure(job: SourceJob, owner: SourceState | undefined, error: unknown): void {
    if (owner && this.unexpectedJobFailure(job, error))
      reportRuntime(this.options.diagnostic, { kind: 'failure', scope: owner, operation: 'source', area: 'syntax', code: diagnosticError(error) });
  }
  private rejectSourceRequest(job: SourceJob, raw: unknown, providerCurrent: boolean, owner?: SourceState): boolean {
    this.reportSourceFailure(job, owner, raw);
    const outcome = raw instanceof RequestFailure && raw.execution === 'not_started' ? 'not_started' : 'unknown';
    this.log(this.unexpectedJobFailure(job, raw) ? 'ERROR' : 'WARN', 'Native request rejected; cancellation or rejection is not stop proof',
      { source: job.key, job: job.id, provider: job.provider, version: job.source?.expected.source_version, execution: outcome, code: diagnosticError(raw) });
    if (outcome === 'not_started' && job.source?.open && providerCurrent && this.leaseProvider === job.provider)
      this.remoteLeases = Math.max(0, this.remoteLeases - 1);
    return this.recordSourceOutcome(job, outcome, outcome === 'not_started' ? 'refused' : job.origin === undefined && providerCurrent ? 'other' : 'route');
  }
  private staleSourceReply(job: SourceJob, source: NonNullable<SourceJob['source']>, chunk: SemanticChunk,
    providerCurrent: boolean, owner?: SourceState): void {
    this.counters.staleReplies++;
    this.log('DEBUG', 'Validated native reply is stale; its colors rejected', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
    if (source.open && chunk.lease && !chunk.complete && providerCurrent) this.close({
      key: chunk.key, ownerKey: job.key,
      generation: chunk.generation, lease: chunk.lease, provider: job.provider, health: owner && new WeakRef(owner)
    });
  }
  private adoptSourceReply(state: SourceState, job: SourceJob, source: NonNullable<SourceJob['source']>, chunk: SemanticChunk, owner?: SourceState): void {
    const node = this.work.get(state.group ?? state);
    if (!node?.paused && (!state.group || state.group.preparation.deref())) this.provider.classificationAccepted(job.provider);
    if (!this.active || !this.enabled || state.generation !== job.generation || !admittedSource(state)) return;
    this.counters.committedLineCalls += chunk.counters.committed_line_calls; this.counters.committedLineBytes += chunk.counters.committed_line_bytes;
    this.counters.tailCalls += chunk.counters.tail_calls; this.counters.tailBytes += chunk.counters.tail_bytes;
    if (chunk.complete && source.expected.lease && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
    const previousSemantic = this.pool.status(job.generation)?.semanticStamp;
    const result = this.pool.installChunk(job.generation, chunk, source.capture); this.receipts(result.released);
    if (!result.accepted || state.generation !== job.generation) {
      this.log('WARN', 'Validated native colors refused by local storage', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
      if (chunk.lease && !chunk.complete) this.close({
        key: chunk.key, ownerKey: job.key, generation: chunk.generation, lease: chunk.lease, provider: job.provider,
        health: owner && new WeakRef(owner)
      });
      state.continuation = undefined; this.refuseSource(state, 'adoption'); this.publication.sourceUnavailable(state);
      return;
    }
    state.parsedAssets = job.description.assets; state.parsedProvider = job.provider;
    const sameSemantic = previousSemantic === this.pool.status(job.generation)?.semanticStamp;
    this.publication.sourceAdopted(state, sameSemantic);
    if (state.previous !== undefined && (!state.group || !this.pool.displayStatus(state.previous))) {
      this.pool.remove(state.previous); state.previous = undefined; state.previousCoverage = false;
    }
    state.committedUnits = chunk.complete ? source.capture.text.length : source.replaceUnits + source.expected.replacementText.lastIndexOf('\n') + 1;
    state.continuation = chunk.complete ? undefined : chunk.lease;
    reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: state, operation: 'source' });
    this.log('DEBUG', 'Validated native result accepted', {
      source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version,
      sourceBytes: chunk.source_bytes, committedBytes: chunk.committed_bytes, complete: chunk.complete,
      committedLineCalls: chunk.counters.committed_line_calls, tailCalls: chunk.counters.tail_calls
    });
  }
  private classifySourceFailure(job: SourceJob, error: unknown, providerCurrent: boolean): { outcome: SourceOutcome; cause: SourceCause } {
    const fault = error instanceof RemoteFault ? error : undefined;
    const outcome = fault?.execution === 'not_started' ? 'not_started' : fault?.execution === 'started' ? 'started' : 'unknown';
    const cause = fault ? sourceFaultCause(fault.code, fault.execution) : job.origin === undefined && providerCurrent ? 'retry' : 'route';
    this.log(this.unexpectedJobFailure(job, error) ? 'ERROR' : 'WARN', 'Native reply refused by validation or remote admission',
      { source: job.key, job: job.id, provider: job.provider, version: job.source?.expected.source_version, execution: outcome, code: diagnosticError(error) });
    return { outcome, cause };
  }
  private loseSourceContinuation(state: SourceState | undefined, job: SourceJob): void {
    if (state?.id !== job.stateId || state.generation !== job.generation || state.provider !== job.provider
      || !this.active || !this.enabled || job.stopped || job.pendingRetire || job.abort.signal.aborted || !this.provider.isReady(job.provider)) return;
    const lease = state.continuation; state.continuation = null;
    const key = this.pool.status(job.generation)?.key;
    if (typeof lease === 'string' && key) this.close({
      key, ownerKey: state.key, generation: job.generation,
      lease, provider: job.provider, health: new WeakRef(state)
    });
  }
}
