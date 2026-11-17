import { concreteStyle, expectation, prepareSelection, selectionBytes, type PreparedSelection, type StyleRoles, type StyleSelection } from './controller-styles.ts';
import { WorkRegistry, type SourcePreparation, type SourceWorkGroup, type WorkEntry as WorkEntryType, type WorkNode as WorkNodeType, type WorkContinuation } from './work-registry.ts';
import { createCardPublicationMetadata, dropCardPublication, publishGroupReady, releaseGroupHold, visitGroupReady, type CardPublicationMetadata, type GroupHold, type GroupMember, type GroupReady, type GroupReadyMember, type GroupSeal } from './card-publication.ts';
import { PiFallbackCoordinator } from './pi-fallback.ts';
import { collectStyleContexts, estimateStyleRepresentation } from './style-preparation.ts';
import type { DataCharge, DataGrant, GeometryFunding } from '../resources/data-budget.ts';
import type { ContextRef } from './storage/context-arena.ts';
import { CARD_ROLES, type CardRole } from '../appearance/card-roles.ts';
import type { SemanticCaptureGroup } from './storage/semantic-capture.ts';
import { decodeSemanticStyleReply, type SemanticDataRequest, type SemanticStyleExpectation } from '../occipital/semantic-protocol.ts';
import type { CaptureSelection, ReadyDisplayUpdate } from './storage/ready-display-publication.ts';
export type { StyleSelection } from './controller-styles.ts';
import { type DiagnosticFields, type DiagnosticLevel, type DiagnosticSink, diagnose, diagnosticError, reportRuntime, unexpectedDiagnostic } from '../diagnostics.ts';
import { RemoteFault } from '../occipital/protocol.ts';
import { decodeSemanticClosed as decodeClosed, decodeSemanticSourceReply, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, type SemanticDescription as Description } from '../occipital/semantic-protocol.ts';
import type { SemanticExpectation as ExpectedSource } from '../occipital/semantic-source.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { BorrowedSource, CardSourcePort, DisplayRangeReader, GroupDisplayBasis, GroupDisplayMember, SourceDemand, SourceDisplayBasis, SourceExecutionStats, SourceLifecyclePort, SourcePumpPort, SourceRecordStatus, SourceStatisticsPort, SourceWorkStatus } from './source-ports.ts';
export type { BorrowedPiSource, BorrowedSource, DisplayRangeReader, GroupDisplayBasis, PiFailure, PiProjectionReader, SourceDemand, SourceDisplayBasis, SourceExecutionState, SourceRecordStatus, SourceWorkStatus } from './source-ports.ts';
import { SemanticRetentionPool, type SemanticRelease as ReleaseReceipt } from './storage/semantic-retention.ts';
import { OCCIPITAL_LIMITS } from '../occipital/limits.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { dataJsonBytes, type ReplySize } from '../occipital/data-json.ts';
import { RequestFailure } from '../occipital/request-failure.ts';
import { DEFAULT_PROVIDER_CLOCK, type ProviderBroker, type ProviderClock, type ProviderRetirementOrigin } from '../occipital/provider.ts';
import { admittedSource, matchingSourceVersion, nextSource, queuedSource, sourceExecution, sourceFaultCause, sourceRefused, sourceSatisfied, sourceUncertain, SOURCE_RETRY_MS, type SourceCause, type SourceDecision, type SourceFacts, type SourceOutcome, type SourceRefusal } from './source-state.ts';
import { RETENTION_LIMITS } from './storage/retention.ts';
import { nextStyle, styleFaultCause, type StyleAttempt, type StyleCause } from './style-state.ts';

import { sourceFits, sourceIdentifier as identifier, sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
export { sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
type WorkEntry = WorkEntryType<SourceState>;
type WorkMetadata = CardPublicationMetadata & { resyncAt?: number; styleRevision: number; attempt?: { outcome: StyleAttempt; epoch: number; revision: number; vocabulary: string }; failedEpoch?: number; failedRevision?: number; failedVocabulary?: string; failedCacheRevision?: number; failedPalette?: string; failedBindingRevision?: number };
type WorkNode = WorkNodeType<WorkEntry, WorkMetadata>;
function workMetadata(): WorkMetadata { return Object.assign(createCardPublicationMetadata(), { styleRevision: 0 }); }
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
type Provider = Pick<ProviderBroker, 'snapshot' | 'isReady' | 'request' | 'classificationAccepted' | 'recover' | 'workerUnavailable' | 'exhaustedRoute'>;
type StyleCoverage = { generation: number; semanticStamp: number; sourceVersion: number; vocabulary: string; invalidation: number; charge: DataCharge };
type SourceState = SourceFacts & {
  coverage?: Map<string, StyleCoverage>;
  // Two primitive role receipts fit the existing source entry allowance.
  neutral: NonNullable<SourceDemand['neutral']>; displayNeutral?: NonNullable<SourceDemand['neutral']>;
  id: number; key: string; group?: SourceWorkGroup; generation?: number; previous?: number; previousCoverage?: boolean; committedUnits: number;
  // Last validated palette/rules display identity is independent of source identity.
  // Its bounded protocol strings fit the existing per-entry bookkeeping allowance.
  displayStamp: number; displayEffect?: number; displayPalette?: string; displayRules?: string; displayVersion?: number; frozen?: boolean;
  language?: string; path?: string;
  parsedAssets?: string; parsedProvider?: number; styleDirty: boolean; bytes: number;
};
type Close = { key: string; ownerKey: string; generation: number; lease: string; provider: number; bytes: number; health?: WeakRef<SourceState> };
type StyleMember = { key: string; id: number; generation: number };
type StyleJob = { expected: SemanticStyleExpectation; captures?: SemanticCaptureGroup; refs: readonly ContextRef[];
  members: readonly StyleMember[]; group?: WeakRef<SourceWorkGroup>; groupRevision?: number; node: WeakRef<WorkNode>; epoch: number; revision: number; demandRevision: number; decodedBytes: number };
type StyleCache = { revision: number; charge: DataCharge };
type JobBase = { id: number; provider: number; generation?: number; key?: string; ticket: string; pendingRetire?: true;
  abort: AbortController; bytes: number; description: Description; reserved: boolean; replySize: ReplySize;
  kind?: 'shared' | 'owned'; stopped?: boolean; origin?: ProviderRetirementOrigin; lifetimeRef?: WeakRef<Job> };
type SourceOperation = { operation: 'source'; key: string; generation: number; stateId: number; inputRevision: number;
  source: { capture: Readonly<{ version: number; text: string }>; expected: ExpectedSource; replaceUnits: number; open: boolean; decodedBytes: number } | undefined };
type StyleOperation = { operation: 'style'; key?: string; generation?: number; outcome: StyleAttempt; style: StyleJob | undefined; styleCharge?: DataCharge };
type CloseOperation = { operation: 'close'; key: string; generation: number; close: Close };
type SourceJob = JobBase & SourceOperation;
type StyleRequest = JobBase & StyleOperation;
type CloseJob = JobBase & CloseOperation;
type Job = SourceJob | StyleRequest | CloseJob;
type WorkCompletion = { promise: Promise<boolean>; resolve(value: boolean): void };
function workCompletion(): WorkCompletion {
  let resolve!: WorkCompletion['resolve'];
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
const workSettled = Promise.resolve(true), workCancelled = Promise.resolve(false);
type Lifetime = { bytes: number; owner: WeakRef<SourceExecution>; jobs: Set<WeakRef<Job>>; charges: Set<DataCharge>; groups: Set<GroupHold>; data?: SemanticRetentionPool; completion?: WorkCompletion; wake?: ReturnType<ProviderClock['setTimeout']> };
let nextExecution = 0;
const ignored = () => {};
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
function releaseStyleRequest(job: Job): void {
  if (job.operation !== 'style') return;
  releaseStyle(job); job.styleCharge?.release(); job.styleCharge = undefined;
}
function releaseCredit(job: Job): void {
  if (!job.reserved) return;
  job.reserved = false; flight.jobs--; flight.bytes -= job.bytes;
  const pending = [...waiters]; waiters.clear();
  for (const owner of pending) owner.deref()?.wake();
}
function waitForCredit(owner: WeakRef<SourceExecution>): void {
  // Membership is prepaid by each owner's128-byte lifetime ticket. There is no
  // independent waiter count ceiling or abandoned live callback at a magic count.
  for (const waiter of waiters) if (!waiter.deref()) waiters.delete(waiter);
  waiters.add(owner);
}
function releaseRequest(job: Job): void {
  if (job.operation === 'source') job.source = undefined;
  releaseStyleRequest(job); releaseCredit(job);
}
function terminalReply(owner: WeakRef<SourceExecution>, job: Job, value: unknown, rejected: boolean): void {
  const execution = owner.deref();
  try { execution?.settle(job, value, rejected); }
  finally { if (execution) execution.physicalSettled(job); else releaseRequest(job); }
}
function completion(owner: WeakRef<SourceExecution>, job: Job) {
  return { reply: (value: unknown) => terminalReply(owner, job, value, false),
    failed: (error: unknown) => terminalReply(owner, job, error, true) };
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
function displayVisit(owner: WeakRef<SourceExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (text: string, read: DisplayRangeReader) => void) => owner.deref()?.visitDisplayBasis(key, id, generation, version, stamp, consume) ?? false;
}
function displayRanges(owner: WeakRef<SourceExecution>, key: string, id: number, generation: number, version: number, stamp: number): DisplayRangeReader {
  return consume => owner.deref()?.visitDisplayRanges(key, id, generation, version, stamp, consume) ?? false;
}
function displayRole(owner: WeakRef<SourceExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (role: CardRole) => owner.deref()?.readDisplayRole(key, id, generation, version, stamp, role);
}
function displayStyles(owner: WeakRef<SourceExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitDisplayStyles(key, id, generation, version, stamp, consume) ?? false;
}
function groupStyles(owner: WeakRef<SourceExecution>, node: WeakRef<WorkNode>, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitGroupStyles(node, stamp, consume) ?? false;
}
function groupRole(owner: WeakRef<SourceExecution>, node: WeakRef<WorkNode>, stamp: number) {
  return (role: CardRole) => owner.deref()?.readGroupRole(node, stamp, role);
}
function groupVisit(owner: WeakRef<SourceExecution>, node: WeakRef<WorkNode>, stamp: number) {
  return (consume: (member: (key: string) => GroupDisplayMember | undefined) => void) => owner.deref()?.visitGroup(node, stamp, consume) ?? false;
}
function groupMember(owner: WeakRef<SourceExecution>, node: WeakRef<WorkNode>, stamp: number) {
  return (key: string) => owner.deref()?.readGroupMember(node, stamp, key);
}
function groupRanges(owner: WeakRef<SourceExecution>, node: WeakRef<WorkNode>, stamp: number, key: string): DisplayRangeReader {
  return consume => owner.deref()?.visitGroupRanges(node, stamp, key, consume) ?? false;
}
function equalInk(a: ConcreteStyle['foreground'], b: ConcreteStyle['foreground']): boolean {
  return a.kind === 'rgb' ? b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b
    : a.kind === 'indexed' ? b.kind === 'indexed' && a.index === b.index : b.kind === 'terminal-default';
}
function equalRoles(a: StyleRoles, b: StyleRoles): boolean {
  return CARD_ROLES.every(role => a[role].attributes === b[role].attributes && equalInk(a[role].foreground, b[role].foreground)
    && equalInk(a[role].background, b[role].background));
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
  return RETENTION_LIMITS.entryAllowance + 2*(demand.key.length + (demand.language?.length ?? 0) + (demand.path?.length ?? 0));
}

/** One UI-independent active source owner. Caller flushes after render; observe
 * and reads never prepare/encode/dispatch. Strings/ranges are solely pooled or in
 * two charged captures. Tombstones contain primitives and suppress pressure
 * carousels; off keeps physical-work evidence, removal/disposal drops it.
 * Primitive record credit is bounded separately by the same generous retained-family allowance, not a count cap. */
export class SourceExecution implements WorkContinuation, CardSourcePort, SourceLifecyclePort, SourcePumpPort, SourceStatisticsPort {
  private readonly provider: Provider;
  private readonly pool: SemanticRetentionPool;
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
  private selection?: PreparedSelection;
  private selectionCharge?: DataCharge;
  private styleEpoch = 0;
  private styleRevision = 0;
  private readonly styleCache = new Map<string, StyleCache>();
  private sequence = 0;
  private wireSequence = 0;
  private stateSequence = 0;
  private displaySequence = 0;
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
  private counters = { dispatches: 0, preparedBytes: 0, decodedBytes: 0, staleReplies: 0, restarts: 0,
    committedLineCalls: 0, committedLineBytes: 0, tailCalls: 0, tailBytes: 0, cleanupRefusals: 0,
    peakTransientBytes: 0, peakJobs: 0, stylePreparations: 0, styleContextVisits: 0, styleEncodes: 0, styleDispatches: 0, stylePublications: 0, styleRejections: 0 };

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
  setStyleSelection(input: StyleSelection | undefined): boolean {
    if (this.disposed) return false;
    if (!input) {
      if (!this.selection) return true;
      this.selection = undefined; this.releaseSelection(); this.styleEpoch++; this.rewind(); this.reconcileCreditInterest(); return true;
    }
    const bytes = selectionBytes(input), reserved = this.pool.reserve(undefined, bytes); this.receipts(reserved.released);
    if (!reserved.accepted) return false;
    const grant = this.pool.budget.reserve(bytes); if (!grant) return false;
    try {
      const next = prepareSelection(input), charge = grant.consume(bytes), previous = this.selection;
      const rulesChanged = !previous || previous.rules !== next.rules;
      this.releaseSelection(); this.selectionCharge = charge; this.lifetime.charges.add(charge); this.selection = next;
      if (rulesChanged) {
        for (const state of this.states.values()) state.styleDirty = true;
        this.styleEpoch++;
      }
      this.rewind(); this.schedule(); if (rulesChanged) this.reconcileCreditInterest(); return true;
    } finally { grant.close(); }
  }
  private releaseSelection(): void {
    if (this.selectionCharge) { this.lifetime.charges.delete(this.selectionCharge); this.selectionCharge.release(); this.selectionCharge = undefined; }
  }
  private clearStyleCache(): void {
    for (const [key, cache] of this.styleCache) {
      // Pressure cannot reclaim a useful group's pin. Keep that same funded
      // cache association discoverable instead of requesting its roles again.
      let pinned = false;
      for (const hold of this.lifetime.groups) if (hold.pin === cache.charge) { pinned = true; break; }
      if (pinned) continue;
      this.styleCache.delete(key); this.lifetime.charges.delete(cache.charge); cache.charge.release();
    }
    for (const state of this.states.values()) this.clearCoverage(state);
  }
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
  updatePreparation(group: SourceWorkGroup): boolean {
    const node = this.work.get(group);
    if (!node || !group.preparation.deref() || !this.enabled || this.disposed) return false;
    if (node.seal && this.sealMatches(group, node.seal)) return true;
    this.dropGroup(node, true);
    node.styleRevision = ++this.styleRevision; node.attempt = undefined; this.clearStyleRefusal(node);
    let bytes = 256;
    for (const key of group.keys) {
      if (this.states.get(key)?.group !== group || !identifier(key)) return false;
      bytes += 256 + 2 * key.length;
    }
    const grant = this.pool.budget.reserve(bytes); if (!grant) return false;
    try {
      const members: GroupMember[] = [];
      for (const key of group.keys) members.push({ key, id: this.states.get(key)!.id });
      const seal = { members, revision: node.styleRevision, charge: grant.consume(bytes) };
      node.seal = seal; this.lifetime.charges.add(seal.charge);
      if (this.preparing !== group) { this.rewind(); this.schedule(); } return true;
    } finally { grant.close(); }
  }
  private sealMatches(group: SourceWorkGroup, seal: GroupSeal): boolean {
    if (group.keys.size !== seal.members.length) return false;
    let i = 0;
    for (const key of group.keys) {
      const member = seal.members[i++]!;
      if (member.key !== key || this.states.get(key)?.id !== member.id) return false;
    }
    return true;
  }
  private dropGroup(node: WorkNode, seal = false): void {
    if (dropCardPublication(node, this.lifetime.groups, this.lifetime.charges, seal) && 'preparation' in node.value)
      this.changedGroup(node.value.id);
  }
  groupPresentation(group: SourceWorkGroup): GroupDisplayBasis | undefined {
    const node = this.work.get(group), ready = node?.ready;
    if (!node || !ready || !this.groupCurrent(node, ready.stamp)) return undefined;
    const weak = new WeakRef(node);
    return { stamp: ready.stamp, paintStamp: ready.paintStamp,
      rules: ready.rules, palette: ready.palette, bindingRevision: ready.bindingRevision,
      role: groupRole(this.owner, weak, ready.stamp), visitStyles: groupStyles(this.owner, weak, ready.stamp),
      visit: groupVisit(this.owner, weak, ready.stamp) };
  }
  private groupCurrent(node: WorkNode, stamp: number, boundary = false): boolean {
    const entry = node.value, ready = node.ready;
    if (this.disposed || !this.enabled || !ready || ready.stamp !== stamp || !('preparation' in entry)
      || this.work.get(entry) !== node || !entry.preparation.deref() || !node.seal || entry.keys.size !== node.seal.members.length) return false;
    // Trust only this exact publication during a synchronous validated borrow.
    // Cold mutations revoke node.ready; the outer boundary still checks every source and ordered key.
    if (ready.readers && !boundary) return true;
    if (!this.sealMatches(entry, node.seal)) return false;
    for (const member of ready.members.values()) {
      if (!this.currentDisplay(member.key, member.id, member.generation, member.version, member.stamp)) return false;
    }
    return true;
  }
  readGroupRole(weak: WeakRef<WorkNode>, stamp: number, role: CardRole): ConcreteStyle | undefined {
    const node = weak.deref();
    // Membership/source mutations invalidate the node on their cold update path.
    return !this.disposed && this.enabled && node?.ready?.stamp === stamp && 'preparation' in node.value
      && !!node.value.preparation.deref() && this.work.get(node.value) === node ? node.ready.roles[role] : undefined;
  }
  visitGroupStyles(weak: WeakRef<WorkNode>, stamp: number, consume: (style: ConcreteStyle) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), (_node, ready) => {
      for (const role of CARD_ROLES) {
        if (!this.readGroupRole(weak, stamp, role)) return false;
        consume(ready.roles[role]);
      }
      for (const member of ready.members.values()) {
        if (!this.readGroupRole(weak, stamp, 'code')) return false;
        const valid = this.visitDisplayStyles(member.key, member.id, member.generation, member.version, member.stamp, style => {
          if (this.readGroupRole(weak, stamp, 'code')) consume(style);
        });
        if (!valid) return false;
      }
      return true;
    });
  }
  visitGroup(weak: WeakRef<WorkNode>, stamp: number, consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), () => {
      consume(groupMember(this.owner, weak, stamp)); return true;
    });
  }
  readGroupMember(weak: WeakRef<WorkNode>, stamp: number, key: string): GroupDisplayMember | undefined {
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return undefined;
    const member = node.ready!.members.get(key);
    return member && this.currentDisplay(key, member.id, member.generation, member.version, member.stamp) ? { key, generation: member.generation, version: member.version, stamp: member.stamp,
      geometryStamp: member.geometryStamp, paintStamp: member.paintStamp, complete: member.complete,
      read: groupRanges(this.owner, weak, stamp, key) } : undefined;
  }
  visitGroupRanges(weak: WeakRef<WorkNode>, stamp: number, key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), (node, ready) => {
      const member = ready.members.get(key); if (!member) return false;
      const valid = this.visitDisplayRanges(key, member.id, member.generation, member.version, member.stamp, (from, to, style) => {
        if (this.groupCurrent(node, stamp)) consume(from, to, style);
      });
      return valid;
    });
  }
  queuePreparation(group: SourceWorkGroup, local = false): void { if (!this.disposed) this.work.queue(group, local); }
  pausePreparation(group: SourceWorkGroup): void {
    if (!this.work.pause(group)) return;
    this.reconcileCreditInterest();
    if (this.lifetime.wake || Number.isFinite(this.wakeMinimum)) { this.rewind(); this.schedule(); }
  }
  unregisterPreparation(group: SourceWorkGroup): void {
    this.drainRetirements(); this.releasePreparation(group, false);
  }
  private releasePreparation(group: SourceWorkGroup, deferred: boolean): void {
    if (!this.removeWork(group, deferred)) return;
    this.noticeGroups.delete(group.id);
    this.charge(-groupBytes);
    for (const key of group.keys) this.removeSource(key, deferred);
    if (!this.work.size && !this.states.size) this.clearStyleCache();
    this.reconcileCreditInterest();
  }

  /** One revision/cursor reset, not a sweep or a second pending queue. */
  refreshPreparations(): void { if (!this.disposed) this.work.refresh(); }
  private rewind(): void { this.work.rewind(); }
  private removeWork(value: WorkEntry, deferred = false): boolean {
    const removed = this.work.remove(value, node => reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' }), node => {
      this.dropGroup(node, true);
      for (const job of this.jobs.values()) if (job.operation === 'style' && job.style?.node.deref() === node) { releaseStyle(job); this.cancelJob(job, deferred); }
    });
    if (removed && (this.lifetime.wake || Number.isFinite(this.wakeMinimum))) {
      if (!this.work.size) this.cancelWake();
      else { this.rewind(); this.schedule(); }
    }
    return removed;
  }

  observe(demand: SourceDemand): boolean {
    if (!this.enabled || !this.active) return false;
    const state = this.states.get(demand.key), queued = state && this.sourceQueued(state), generation = state?.generation;
    const accepted = this.observeDemand(demand);
    if (state && (queued && !this.sourceQueued(state) || generation !== undefined && state.generation !== generation)) this.reconcileCreditInterest();
    return accepted;
  }
  private refuseSource(state: SourceState, cause: SourceRefusal, provider = state.provider): void {
    if (state.refusalCause === 'metadataFunding') return;
    state.refusalCause = cause; state.refusalInput = state.inputRevision; state.refusalProvider = provider;
    state.refusalGeneration = cause === 'requestLimit' || cause === 'encoding' ? state.generation : undefined;
  }
  private sourceAvailable(state: SourceState): state is SourceState & { generation: number } {
    const data = state.generation === undefined ? undefined : this.pool.status(state.generation);
    return this.matchesContent(state, data?.latestVersion ?? data?.basisVersion);
  }
  private sourceSatisfied(state: SourceState): boolean {
    const data = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const route = this.provider.snapshot(), description = route.availability === 'ready' ? route.description : undefined;
    return sourceSatisfied(state, data && { sourceVersion: data.sourceVersion, complete: data.complete,
      compatible: !description || description.assets === state.parsedAssets && description.vocabulary.fingerprint === data.vocabulary,
      continuable: state.parsedProvider === state.provider && this.provider.isReady(state.provider) && !!state.continuation });
  }
  private sourceQueued(state: SourceState, ready = this.provider.snapshot().availability === 'ready'): boolean {
    return this.enabled && queuedSource(state, ready, this.sourceAvailable(state), this.sourceSatisfied(state));
  }
  private sourceDecision(state: SourceState): SourceDecision {
    const node = this.work.get(state.group ?? state);
    return nextSource(state, { active: this.active, enabled: this.enabled, held: this.sourceBusy(state.key),
      available: this.sourceAvailable(state), ready: this.provider.isReady(state.provider),
      satisfied: this.sourceSatisfied(state), now: this.clock.now(), resyncAt: node?.resyncAt });
  }
  private sourceOwed(state: SourceState): boolean {
    const decision = this.sourceDecision(state);
    return decision.kind !== 'idle' && decision.kind !== 'refused';
  }
    private observeDemand(demand: SourceDemand): boolean {
    const { key, version, text, path, complete, neutral = 'code' } = demand;
    const language = demand.language === '' ? undefined : demand.language;
    if (!identifier(key) || language !== undefined && !identifier(language, 128) || path !== undefined && !identifier(path, 4096)
      || !Number.isInteger(version) || version < 0 || version > 0xffffffff
      || typeof text !== 'string' || text.length > RETENTION_LIMITS.maxSourceUnits || typeof complete !== 'boolean'
      || neutral !== 'title' && neutral !== 'code') throw new Error('invalid source demand');
    const route = this.provider.snapshot();
    let state = this.states.get(key);
    if (state?.frozen) return false;
    const retired = state?.retired === true;
    if (state) state.retired = false;
    if (state && version < state.version) throw new Error('non-monotonic source demand');
    if (state && state.neutral !== neutral) {
      state.neutral = neutral;
      // Inherited ink changes neither the generic subject nor its recorded cache miss.
      if (this.selection) { this.rewind(); this.schedule(); }
    }
    const sameIdentity = !!state && language === state.language && path === state.path;
    const sameObservation = !!state && version === state.version && complete === state.complete && sameIdentity;
    const reobserve = state?.evictionEntitlement === 'reobserve';
    if (state && sameObservation && !retired && !reobserve && state.refusalCause !== 'metadataFunding'
      && (state.refusalProvider === undefined || state.refusalProvider === route.generation)) return this.sourceAvailable(state);

    const bytes = stateBytes(demand);
    if (!this.charge(bytes - (state?.bytes ?? 0))) {
      if (!state) return false;
      const changed = version !== state.version || complete !== state.complete || state.empty !== !text.length
        || state.refusalCause !== 'metadataFunding' || state.generation !== undefined || state.previous !== undefined;
      if (changed) this.dropData(state);
      state.version = version; state.contentVersion = version; state.complete = complete; state.empty = !text.length;
      state.refusalCause = 'metadataFunding'; state.refusalInput = undefined; state.refusalProvider = undefined; state.refusalGeneration = undefined;
      state.styleDirty = false;
      if (changed) { this.rewind(); this.changed(key); }
      return false;
    }
    if (!state) {
      state = { id: ++this.stateSequence, key, version, contentVersion: version, language, path, complete, neutral,
        provider: route.generation, inputRevision: 1,
        styleDirty: true, committedUnits: 0, displayStamp: 0, empty: !text.length, bytes };
      if (this.preparing?.keys.has(key)) state.group = this.preparing;
      this.states.set(key, state);
      if (!state.group) this.work.register(state, workMetadata());
      if (!sourceFits(text, Math.min(HIGHLIGHT_LIMITS.sourceBytes, route.description?.limits.source_bytes ?? HIGHLIGHT_LIMITS.sourceBytes))) {
        this.refuseSource(state, 'sourceLimit', route.generation); state.styleDirty = false; this.changed(key); return false;
      }
      return this.admit(state, text, route.generation);
    }
    state.bytes = bytes;
    const latest = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    const oldAdmitted = admittedSource(state), identityChange = !sameIdentity, formationChange = state.complete && !complete;
    const equal = oldAdmitted && sameIdentity && state.complete === complete && (sameObservation || latest?.text === text);
    const provedChange = !sameIdentity || oldAdmitted && (state.complete !== complete || !!latest && latest.text !== text);
    if (!equal) state.inputRevision++;
    if (provedChange) { state.retryAt = undefined; state.evictionEntitlement = undefined; }
    if (reobserve) state.evictionEntitlement = 'dispatch';
    state.refusalCause = undefined; state.refusalInput = undefined; state.refusalProvider = undefined; state.refusalGeneration = undefined;
    if (state.displayVersion !== undefined) {
      const displayed = latest ?? (state.previous === undefined ? undefined : this.pool.borrowSnapshot(state.previous, 'basis'));
      state.displayVersion = complete && state.displayVersion === state.version && displayed?.text === text ? version : undefined;
    }
    if (latest?.text !== text || identityChange || formationChange) state.contentVersion = version;
    // A refused target may have advanced beyond this still-owned matching text.
    else state.contentVersion = Math.min(state.contentVersion, latest.version);
    const localEmptyCoverage = latest?.text.length === 0 && text.length > 0 && this.pool.status(state.generation!)?.sourceVersion !== undefined;
    const rewrite = !!latest && (!text.startsWith(latest.text) || localEmptyCoverage || state.complete && text !== latest.text);
    state.version = version; state.complete = complete; state.empty = !text.length;
    if (!sourceFits(text, Math.min(HIGHLIGHT_LIMITS.sourceBytes, route.description?.limits.source_bytes ?? HIGHLIGHT_LIMITS.sourceBytes))) {
      const reconstruction = state.continuation === null && !identityChange && !formationChange && !rewrite;
      this.dropData(state); state.language = language; state.path = path;
      if (reconstruction) state.continuation = null;
      this.refuseSource(state, 'sourceLimit', route.generation); state.styleDirty = false; this.changed(key); return false;
    }
    if (!state.group) this.rewind();
    if (identityChange || formationChange || rewrite) {
      if (!identityChange && state.language === 'bash' && state.generation !== undefined) {
        this.restart(state, state.provider, { version, text, evaluatedProvider: route.generation }); return this.sourceAvailable(state);
      }
      this.dropData(state); state.language = language; state.path = path;
      return this.admit(state, text, route.generation);
    }
    if (!latest) return this.admit(state, text, route.generation);
    const result = this.pool.replaceSnapshot(state.generation!, version, text); this.receipts(result.released);
    if (!result.accepted) this.refuseSource(state, 'storage', route.generation);
    return result.accepted && state.generation !== undefined;
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
  displayBasis(key: string): SourceDisplayBasis | undefined {
    const state = this.states.get(key);
    if (this.disposed || !this.enabled || !state || !state.displayStamp) return undefined;
    const generation = this.displayGeneration(state);
    if (generation === undefined) return undefined;
    const display = this.pool.displayStatus(generation);
    if (!display) return undefined;
    const version = display.sourceVersion;
    return { generation, version, stamp: state.displayStamp, language: state.language,
      palette: display.palette, rules: display.rules, bindingRevision: display.bindingRevision,
      complete: display.complete, exactVersion: state.displayVersion, geometryStamp: display.geometryStamp, paintStamp: display.effectStamp,
      role: displayRole(this.owner, key, state.id, generation, version, state.displayStamp),
      visitStyles: displayStyles(this.owner, key, state.id, generation, version, state.displayStamp),
      visit: displayVisit(this.owner, key, state.id, generation, version, state.displayStamp) };
  }
  displayStamp(key: string, palette?: string, rules?: string, language?: string): number {
    const state = this.states.get(key);
    const display = state && this.displayGeneration(state) !== undefined ? this.pool.displayStatus(this.displayGeneration(state)!) : undefined;
    return !this.disposed && this.enabled && state && (palette === undefined || display?.palette === palette && display.rules === rules && state.language === language)
      ? state.displayStamp : 0;
  }
  private displayGeneration(state: SourceState): number | undefined {
    return state.generation !== undefined && this.pool.displayStatus(state.generation) !== undefined ? state.generation : state.previous;
  }
  private currentDisplay(key: string, id: number, generation: number, version: number, stamp: number): boolean {
    const state = this.states.get(key);
    return !this.disposed && this.enabled && state?.id === id && state.displayStamp === stamp
      && this.displayGeneration(state) === generation && this.pool.displayStatus(generation)?.sourceVersion === version;
  }
  readDisplayRole(key: string, id: number, generation: number, version: number, stamp: number, role: CardRole): ConcreteStyle | undefined {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return undefined;
    return this.pool.displayRole(generation, this.pool.displayStatus(generation)!.effectStamp, role);
  }
  /** Internal weak-view delivery; source text never escapes as a stored field. */
  visitDisplayBasis(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (text: string, read: DisplayRangeReader) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const display = this.pool.displayStatus(generation)!;
    const valid = this.pool.visitDisplayText(generation, display.effectStamp, basis => {
      if (basis.version === version) consume(basis.text, displayRanges(this.owner, key, id, generation, version, stamp));
    });
    return valid && this.currentDisplay(key, id, generation, version, stamp);
  }
  visitDisplayStyles(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (style: ConcreteStyle) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const effect = this.pool.displayStatus(generation)!.effectStamp;
    const valid = this.pool.visitDisplayStyles(generation, effect, style => {
      if (this.currentDisplay(key, id, generation, version, stamp)) consume(style);
    });
    return valid && this.currentDisplay(key, id, generation, version, stamp);
  }
  visitDisplayRanges(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const effect = this.pool.displayStatus(generation)!.effectStamp;
    const available = this.pool.visitDisplay(generation, effect, (start, end, _context, style) => {
      const state = this.states.get(key);
      if (state?.id === id && state.displayStamp === stamp && (state.generation === generation || state.previous === generation)) consume(start, end, style);
    });
    return available && this.currentDisplay(key, id, generation, version, stamp);
  }


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
        && queuedSource(state, true, this.sourceAvailable(state), this.sourceSatisfied(state))) state.withdrawalProvider = provider;
    }
    this.rewind(); this.schedule();
  }
  resume(): void {
    if (!this.suspended || this.disposed) return;
    this.suspended = false; this.refreshPreparations(); this.rewind(); this.schedule();
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
    this.rewind(); this.schedule();
  }
  private noteWake(at: number): void {
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
  private requestProviderOpportunity(): void {
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
      const description = this.beginWorkTurn();
      const full = () => this.nativeFull(description);
      while (!this.disposed && !this.suspended && this.work.hasQuota) {
        const currentPass = this.work.currentPass;
        if (this.wakePass !== currentPass) { this.wakePass = currentPass; this.wakeMinimum = Number.POSITIVE_INFINITY; }
        const node = this.work.next();
        if (!node) break;
        const entry = node.value, pass = this.work.currentPass;
        if (this.selection) this.work.notePreparation();
        if (!('preparation' in entry)) {
          this.prepareStyles(node, description, full());
          if (this.dispatchSource(entry, description, full)) {
            this.work.requestRetry();
            if (this.work.hasLocalPending || this.selection) continue;
            this.work.restoreCursor(node, pass); break;
          }
          continue;
        }
        const preparation = entry.preparation.deref();
        if (!preparation) { this.releasePreparation(entry, true); continue; }
        if (node.paused) continue;
        this.prepareStyles(node, description, full());
        if (this.suspended || this.disposed) continue;
        const refresh = this.work.needsRefresh(node);
        if (node.pending || refresh && (preparation.needsRefresh?.(this.work.isNewest(node)) ?? true)) {
          const native = !!description && this.enabled && node.pending !== 'local' && (preparation.requiresCredit?.() ?? true);
          if (native && full()) {
            waitForCredit(this.owner); this.work.requestRetry();
            if (this.work.hasLocalPending || this.selection) continue;
            this.work.restoreCursor(node, pass); break;
          }
          if (native && [...entry.keys].some(key => this.sourceBusy(key))) continue;
          if (this.suspended || this.disposed) continue;
          if (!this.selection && !this.work.hasQuota) { this.work.restoreCursor(node, pass); break; }
          this.work.markPrepared(node);
          if (!this.selection) this.work.notePreparation();
          this.preparing = entry;
          try { preparation.prepare(); if (!this.suspended && !this.disposed) this.updatePreparation(entry); }
          finally { this.preparing = undefined; }
        } else this.work.markPrepared(node);
        if (!this.work.current(node, pass) || this.suspended || this.disposed) continue;
        this.prepareStyles(node, description, full());
        let waiting = false;
        for (const key of entry.keys) if (this.dispatchSource(this.states.get(key), description, full)) { waiting = true; break; }
        if (waiting) {
          this.work.requestRetry();
          if (this.work.hasLocalPending || this.selection) continue;
          this.work.restoreCursor(node, pass); break;
        }
      }
      if (this.work.exhausted) this.finishWakePass(this.work.currentPass);
    } finally {
      this.work.finishTurn();
      this.finishLifetime(); this.completeWork();
    }
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
      this.workProvider = snapshot.generation; this.workReady = ready; this.rewind();
      if (withdrewProvider) this.reconcileCreditInterest();
    }
    const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
    if (description) while (this.closes.length && this.jobs.size < jobLimit) {
      const index = this.closes.findIndex(close => !this.sourceBusy(close.ownerKey)); if (index === -1) break;
      const bytes = this.reservation(0, 0, 0, 0, description);
      if (!this.capacity(bytes)) { waitForCredit(this.owner); break; }
      const close = this.closes.splice(index, 1)[0]!; this.charge(-close.bytes);
      const job = this.job({ operation: 'close', key: close.ownerKey, generation: close.generation, close }, snapshot.generation, description, bytes);
      this.dispatch(job, { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'stream.close',
        key: close.key, generation: close.generation, lease: close.lease });
    }
    return description;
  }
  private nativeFull(description: Description | undefined): boolean {
    const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
    return this.work.creditBlocked || this.jobs.size >= jobLimit || flight.jobs >= CONTROLLER_LIMITS.jobs;
  }
    private dispatchSource(state: SourceState | undefined, description: Description | undefined, full: () => boolean): boolean {
    if (!state || !this.enabled || !this.active || state.retired || state.frozen || this.sourceBusy(state.key)
      || this.closes.some(close => close.ownerKey === state.key)) return false;
    if (description) {
      if (!this.provider.isReady(this.workProvider)) return false;
      if (state.withdrawalProvider !== undefined && state.withdrawalProvider !== this.workProvider) state.withdrawalProvider = undefined;
      if (!admittedSource(state) || !this.sourceAvailable(state)) return false;
      if (state.provider !== this.workProvider && !this.sourceSatisfied(state)) {
        if (this.pool.status(state.generation)?.sourceVersion === undefined && !state.continuation) {
          state.provider = this.workProvider; state.continuation = undefined;
        } else this.restart(state, this.workProvider);
      }
    }
    const decision = this.sourceDecision(state);
    if (decision.kind === 'delayed') { this.noteWake(decision.at); return false; }
    if (decision.kind === 'provider') { this.requestProviderOpportunity(); return false; }
    if (decision.kind !== 'parse' || !description) return false;
    if (full()) { waitForCredit(this.owner); return true; }
    if (decision.reconstruction && state.generation !== undefined && (this.pool.status(state.generation)?.revision ?? 0) > 0) {
      this.restart(state, state.provider);
      if (this.closes.some(close => close.ownerKey === state.key)) { this.schedule(); return false; }
    }
    return this.prepare(state, description, decision.reconstruction) === 'credit';
  }


    workStatus(key: string): SourceWorkStatus {
    const state = this.states.get(key);
    const pending = this.sourceHeld(key);
    const ready = !!state && this.enabled && !state.retired && this.provider.snapshot().availability === 'ready';
    const queued = !!state && ready && (this.sourceQueued(state, ready)
      || state.styleDirty && state.generation !== undefined && this.pool.status(state.generation)?.sourceVersion !== undefined);
    const execution = sourceExecution(state, pending);
    return { version: state?.version, execution, fallbackEligible: !this.disposed
      && (state?.withdrawalProvider === undefined || this.provider.snapshot().availability === 'unavailable')
      && !state?.frozen && !pending && !queued && (!state || !sourceUncertain(state))
      && (execution === 'not_started' || execution === 'acknowledged') };
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
    this.rewind(); this.schedule();
  }
  status(key: string): SourceRecordStatus | undefined {
    const state = this.states.get(key); if (!state || state.retired) return undefined;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const result = current?.sourceVersion !== undefined ? current : !state.previousCoverage || state.previous === undefined ? undefined : this.pool.status(state.previous);
    const exact = admittedSource(state) && (state.empty || this.matchesContent(state, result?.sourceVersion));
    // Waiting/retired demand is not execution proof: a still-held source job,
    // including a removed/reused key, remains the physical attempt authority.
    const execution = this.workStatus(key).execution;
    const provider = this.provider.snapshot();
    return { generation: state.generation, version: state.version,
      acknowledgedVersion: provider.generation === state.parsedProvider && provider.availability === 'ready' ? current?.sourceVersion : undefined,
      classificationVersion: state.empty ? undefined : result?.sourceVersion, committedBytes: result?.committedBytes ?? 0, exact,
      execution, availability: this.disposed ? 'disposed' : !this.enabled ? 'disabled' : provider.availability,
      protective: sourceRefused(state) || sourceUncertain(state), fallbackEligible: !exact && this.workStatus(key).fallbackEligible, complete: state.complete };
  }
  visitRanges(key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    const state = this.states.get(key); if (!state) return false;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const generation = current?.sourceVersion !== undefined ? state.generation : state.previousCoverage ? state.previous : undefined;
    if (generation === undefined) return state.empty;
    const status = this.pool.status(generation); if (!status) return false;
    const limit = this.matchesContent(state, status.sourceVersion) ? status.sourceBytes : status.committedBytes;
    const display = this.pool.displayStatus(generation);
    return !!display && this.pool.visitDisplay(generation, display.effectStamp, (start, end, _context, style) => {
      if (this.states.get(key) === state && start < limit) consume(start, Math.min(end, limit), style);
    });
  }
  stats(): SourceExecutionStats { return { ...this.counters, styleCaptures: [...this.jobs.values()].filter(job => job.operation === 'style' && job.style).length, unsettledJobs: this.jobs.size, captures: [...this.jobs.values()].filter(job => job.operation === 'source' && job.source).length,
    globalUnsettledJobs: flight.jobs, globalTransientBytes: flight.bytes, transientBytes: this.transientBytes, maxTransientBytes: this.maxTransientBytes,
      remoteLeases: this.remoteLeases, pendingCloses: this.closes.length, sourceRecords: this.states.size, piSourceRecords: this.pi.size,
    guardRecords: [...this.states.values()].filter(state => state.generation === undefined || sourceUncertain(state)).length,
    bookkeepingBytes: this.lifetime.bytes, globalBookkeepingBytes: flight.bookkeepingBytes, waitingOwners: waiters.size,
    retention: this.pool.stats() }; }
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
    const generation = this.displayGeneration(state) ?? (current !== undefined && this.pool.status(current)?.sourceVersion !== undefined ? current : undefined);
    this.retire(state, true, false);
    state.generation = undefined; state.previous = generation; state.previousCoverage = false;
    state.frozen = true; state.retired = true;
    if (current !== undefined && current !== generation) this.receipts(this.pool.remove(current));
    if (previous !== undefined && previous !== generation) this.receipts(this.pool.remove(previous));
    if (generation !== undefined) this.pool.retainBasis(generation);
    else state.displayStamp = 0;
    this.changed(key); this.reconcileCreditInterest(); this.schedule();
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
    if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node, true); }
    if (!this.states.size && ![...this.work.values()].some(node => node.seal)) this.clearStyleCache();
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    if (!enabled) { this.cancelWake(); this.completeWork(true); this.drainRetirements(); }
    this.enabled = enabled; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    if (!enabled) { for (const node of this.work.values()) this.dropGroup(node, true);
      for (const job of this.jobs.values()) if (job.operation === 'style') { releaseStyle(job); job.abort.abort(sourceRetired); }
      this.clearStyleCache(); waiters.delete(this.owner);
      for (const [key, state] of this.states) {
        state.withdrawalProvider = undefined; state.retryAt = undefined;
        // Retained history must not carry a no-start veto into fresh native interest.
        if (state.attemptOutcome === 'not_started') state.attemptInput = undefined;
        this.dropData(state);
        if (state.frozen || this.busy(key) || sourceUncertain(state) || state.sharedUnknown || state.ownedUnknown !== undefined) {
           state.retired = true;
        } else { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.states.delete(key); this.removeWork(state); this.charge(-state.bytes); }
      }
      this.pi.clear(); this.receipts(this.pool.clear()); this.flush(); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelWake(); this.completeWork(true); this.drainRetirements();
    for (const [entry, node] of this.work) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' }); if ('preparation' in entry) { this.dropGroup(node, true); this.charge(-groupBytes); } }
    this.work.clear();
    this.setEnabled(false);
    // Pi fallback may have been captured while the native controller was already off.
    this.pi.clear();
    this.disposed = true; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    for (const state of this.states.values()) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.charge(-state.bytes); }
    this.states.clear();
    this.lifetime.data = undefined; this.releaseSelection(); this.selection = undefined; this.clearStyleCache(); this.pool.dispose();
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
  private matchesContent(state: SourceState, version: number | undefined): boolean {
    return matchingSourceVersion(state, version);
  }
  private sourceHeld(key: string): boolean {
    for (const reference of this.lifetime.jobs) {
      const job = reference.deref();
      if (job?.reserved && job.operation === 'source' && !job.stopped && job.key === key) return true;
    }
    return false;
  }
  private sourceBusy(key: string): boolean {
    for (const reference of this.lifetime.jobs) {
      const job = reference.deref();
      if (job?.reserved && (job.operation === 'source' || job.operation === 'close') && job.key === key) return true;
    }
    return false;
  }
  private busy(key: string): boolean {
    for (const reference of this.lifetime.jobs) {
      const job = reference.deref();
      if (job?.reserved && job.key === key) return true;
    }
    return false;
  }
  private wireKey(): string { return `source:${this.id}:${++this.wireSequence}`; }
  private log(level: DiagnosticLevel, explanation: string, fields?: DiagnosticFields): void {
    if (this.options.diagnostic) diagnose(this.options.diagnostic, level, 'syntax', explanation, { controller: this.id, ...fields });
  }
    private admit(state: SourceState, text: string, evaluatedProvider: number): boolean {
    const result = this.pool.admit(this.wireKey(), state.version, text); this.receipts(result.released);
    if (!result.accepted) {
      this.log('WARN', 'Native source storage refused; no source dispatched', { source: state.key, version: state.version, units: text.length });
      this.refuseSource(state, 'storage', evaluatedProvider); return false;
    }
    this.log('DEBUG', 'Native source admitted', { source: state.key, version: state.version, generation: result.generation, language: state.language, units: text.length });
    state.generation = result.generation; state.committedUnits = 0; this.invalidateStyles(state);
    return true;
  }
  private restart(state: SourceState, provider: number, target?: Pick<SourceDemand, 'version' | 'text'> & { evaluatedProvider: number }, cancel = true): void {
    const oldGeneration = state.generation, previous = state.previous;
    const reconstruction = state.continuation === null && provider === state.provider && target === undefined;
    const latest = target ?? (oldGeneration === undefined ? undefined : this.pool.borrowSnapshot(oldGeneration)); if (!latest) return;
    const covered = oldGeneration !== undefined && this.pool.status(oldGeneration)?.sourceVersion !== undefined ? oldGeneration : previous;
    const coveredStatus = covered === undefined ? undefined : this.pool.status(covered);
    // Parser progress cannot replace an independently owned ready display.
    const retained = this.displayGeneration(state) ?? covered;
    const snapshot = this.provider.snapshot(), description = snapshot.availability === 'ready' ? snapshot.description : undefined;
    const compatible = !!description && description.assets === state.parsedAssets
      && description.vocabulary.fingerprint === coveredStatus?.vocabulary;
    const reuse = state.complete && coveredStatus?.complete && (!description || compatible)
      && this.pool.borrowSnapshot(covered!, 'basis')?.text === latest.text;
    const previousCoverage = !target && (retained === oldGeneration || state.previousCoverage);
    // Superseded selections keep their physical credit until normal settlement.
    this.retire(state, cancel);
    if (reconstruction) state.continuation = null;
    // Detach the obsolete parser basis before admission receipts. Releasing its
    // empty entry must not also release a compatible independently held result.
    state.generation = undefined; state.previous = retained; state.previousCoverage = previousCoverage; state.provider = provider;
    if (retained !== undefined) this.pool.retainBasis(retained);
    if (oldGeneration !== undefined && oldGeneration !== retained && (!reuse || oldGeneration !== covered)) this.receipts(this.pool.remove(oldGeneration));
    if (previous !== undefined && previous !== retained && (!reuse || previous !== covered)) this.receipts(this.pool.remove(previous));
    const result = reuse ? this.pool.replaceSnapshot(covered!, latest.version, latest.text)
      : this.pool.admit(this.wireKey(), latest.version, latest.text);
    this.receipts(result.released);
    if (!result.accepted) { this.refuseSource(state, 'storage', target?.evaluatedProvider ?? provider); return; }
    state.generation = reuse ? covered : result.generation; state.committedUnits = 0;
    if (reuse) {
      if (state.previous === covered) { state.previous = undefined; state.previousCoverage = false; }
      state.contentVersion = coveredStatus!.sourceVersion!;
      const display = this.pool.displayStatus(this.displayGeneration(state)!);
      state.displayVersion = display?.complete && this.matchesContent(state, display.sourceVersion) ? state.version : undefined;
      // Missing metadata defers compatibility, not ownership of valid annotations.
    }
  }
  private retire(state: SourceState, cancel = true, styles = true, deferred = false): void {
    // Freeze retains the exact display view; proofs still require its actual
    // generation/stamp/version, rather than converting current data into proof.
    this.invalidateStyles(state, !styles);
    if (cancel) for (const job of this.jobs.values()) {
      const style = styles && job.operation === 'style' && job.style?.members.some(member => member.id === state.id);
      if (job.operation === 'style' ? !style : job.operation !== 'source' || job.stateId !== state.id) continue;
      this.cancelJob(job, deferred);
      if (style) releaseStyle(job);
    }
    if (state.continuation && state.generation !== undefined) {
      const key = this.pool.status(state.generation)?.key;
      if (key) this.close({ key, ownerKey: state.key, generation: state.generation, lease: state.continuation, provider: state.provider, health: new WeakRef(state) });
    }
    state.continuation = undefined;
  }
  private dropData(state: SourceState, deferred = false): void {
    if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node); }
    this.retire(state, true, true, deferred);
    const current = state.generation, previous = state.previous; state.generation = undefined; state.previous = undefined;
    state.previousCoverage = false; state.displayStamp = 0; state.displayPalette = undefined; state.displayRules = undefined; state.displayVersion = undefined;
    if (current !== undefined) this.pool.remove(current);
    if (previous !== undefined) this.pool.remove(previous);
  }
  private close(close: Omit<Close, 'bytes'>): void {
    if (!this.provider.isReady(close.provider) || this.closes.some(item => item.lease === close.lease)
      || [...this.jobs.values()].some(job => job.operation === 'close' && job.close.lease === close.lease)) return;
    const bytes = 288 + 2*(close.key.length + close.ownerKey.length + close.lease.length);
    if (!this.charge(bytes)) { this.counters.cleanupRefusals++; return; }
    this.closes.push({ ...close, bytes });
  }
  private receipts(receipts: readonly ReleaseReceipt[], deferred = false): void {
    // Cascaded previous releases complete before the withdrawal wake.
    if (this.releaseReceipts(receipts, deferred)) {
      this.reconcileCreditInterest();
      if (this.lifetime.wake || Number.isFinite(this.wakeMinimum)) { this.rewind(); this.schedule(); }
    }
  }
  private releaseReceipts(receipts: readonly ReleaseReceipt[], deferred: boolean): boolean {
    let withdrew = false;
    for (const receipt of receipts) {
      if (this.pi.releaseGeneration(receipt.generation)) continue;
      for (const state of this.states.values()) {
        if (state.previous === receipt.generation) {
          withdrew = true;
          const node = state.group && this.work.get(state.group);
          const member = node?.ready?.members.get(state.key);
          if (node && member?.id === state.id && member.generation === receipt.generation) this.dropGroup(node);
          this.invalidateStyles(state);
          state.previous = undefined; state.previousCoverage = false;
          if (state.generation === undefined || this.pool.status(state.generation)?.sourceVersion === undefined) {
            state.displayStamp = 0; this.changed(state.key);
          }
        }
        if (state.generation !== receipt.generation) continue;
        withdrew = true;
        const reconstruction = state.continuation === null;
        if (state.continuation) this.close({ key: receipt.key, ownerKey: state.key, generation: receipt.generation, lease: state.continuation, provider: state.provider, health: new WeakRef(state) });
        state.continuation = undefined; this.retire(state, true, true, deferred); state.generation = undefined;
        if (reconstruction) state.continuation = null;
        this.refuseSource(state, 'storage');
        state.displayStamp = 0;
        if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node); }
        this.changed(state.key);
        if (state.previous !== undefined) { const previous = state.previous; state.previous = undefined; this.releaseReceipts(this.pool.remove(previous), deferred); }
        break;
      }
    }
    return withdrew;
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
  private clearCoverage(state: SourceState): void {
    for (const proof of state.coverage?.values() ?? []) { this.lifetime.charges.delete(proof.charge); proof.charge.release(); }
    state.coverage = undefined;
  }
  private invalidateStyles(state: SourceState, preserveView = false, newSubject = false): void {
    if (!preserveView) this.clearCoverage(state);
    const node = this.work.get(state.group ?? state);
    if (node) {
      this.clearStyleRefusal(node);
      if (newSubject) { node.styleRevision = ++this.styleRevision; node.attempt = undefined; }
    }
  }
  private clearStyleRefusal(node: WorkNode): void {
    node.failedEpoch = undefined; node.failedRevision = undefined; node.failedVocabulary = undefined;
    node.failedCacheRevision = undefined; node.failedPalette = undefined; node.failedBindingRevision = undefined;
  }
  private refuseStyles(node: WorkNode, vocabulary: string, epoch: number, revision: number): void {
    const selection = this.selection;
    if (this.work.get(node.value) !== node || this.styleEpoch !== epoch || node.styleRevision !== revision || !selection) return;
    node.failedEpoch = epoch; node.failedRevision = revision; node.failedVocabulary = vocabulary;
    node.failedCacheRevision = this.styleCache.get(this.styleKey(vocabulary, selection.rules))?.revision ?? 0;
    node.failedPalette = selection.palette; node.failedBindingRevision = selection.bindingRevision;
  }
  private styleHealthOwner(style: StyleJob, provider: number): WorkNode | undefined {
    const node = style.node.deref();
    return node && this.work.get(node.value) === node && this.styleEpoch === style.epoch
      && node.styleRevision === style.revision && this.provider.isReady(provider) ? node : undefined;
  }
  // After the generic expressions are installed, publication funding belongs to this owner only.
  private refuseStyleOwner(style: StyleJob): void {
    const node = style.node.deref();
    if (node) this.refuseStyles(node, style.expected.vocabulary, style.epoch, style.revision);
  }
  private refuseStyleJob(job: StyleRequest, cause: StyleCause): void {
    const at = cause === 'retry' ? this.clock.now() + 60000 : undefined;
    job.outcome.cause = cause; job.outcome.retryAt = at;
    if (job.style && cause !== 'withdrawn') this.refuseStyleOwner(job.style);
  }
  private hasCoverage(member: StyleMember, vocabulary: string, rules: string): boolean {
    const state = this.states.get(member.key);
    if (!state || state.id !== member.id) return false;
    const proof = state.coverage?.get(rules);
    if (!proof) return false;
    if (proof.invalidation !== this.pool.arena.styleInvalidationRevision) { this.clearCoverage(state); return false; }
    const data = state.frozen ? this.pool.displayStatus(member.generation) : this.pool.status(member.generation);
    return proof.generation === member.generation && data?.vocabulary === vocabulary && proof.vocabulary === vocabulary
      && proof.semanticStamp === data.semanticStamp && (proof.sourceVersion === data.sourceVersion
        || !state.frozen && this.matchesContent(state, proof.sourceVersion));
  }
  private rememberCoverage(member: StyleMember, vocabulary: string, rules: string, invalidation: number): void {
    if (this.pool.arena.styleInvalidationRevision !== invalidation) return;
    const state = this.states.get(member.key), display = this.pool.displayStatus(member.generation);
    if (!state || state.id !== member.id || !display || this.hasCoverage(member, vocabulary, rules)) return;
    const data = state.frozen ? display : this.pool.status(member.generation);
    if (!data || data.vocabulary !== vocabulary || data.semanticStamp !== display.semanticStamp
      || data.sourceVersion !== display.sourceVersion && (state.frozen || !this.matchesContent(state, display.sourceVersion))) return;
    const old = state.coverage?.get(rules);
    if (old) { this.lifetime.charges.delete(old.charge); old.charge.release(); state.coverage!.delete(rules); }
    // Optional evidence never evicts source data just to accelerate a later probe.
    // Each map association, immutable namespace/rule key and scalar identity is paid.
    const bytes = 512 + 2 * (vocabulary.length + rules.length), grant = this.pool.budget.reserve(bytes);
    if (!grant) return;
    try {
      const charge = grant.consume(bytes); this.lifetime.charges.add(charge);
      (state.coverage ??= new Map()).set(rules, { generation: member.generation, semanticStamp: display.semanticStamp,
        sourceVersion: display.sourceVersion, vocabulary, invalidation, charge });
    } finally { grant.close(); }
  }
  private styleMembers(node: WorkNode): StyleMember[] | undefined {
    const entry = node.value, members: StyleMember[] = [];
    if (node.paused) return undefined;
    if ('preparation' in entry && (!entry.preparation.deref() || !node.seal || !this.sealMatches(entry, node.seal))) return undefined;
    for (const key of 'preparation' in entry ? entry.keys : [entry.key]) {
      const state = this.states.get(key), generation = state?.frozen ? state.previous : state?.generation;
      if (!state || state.retired && !state.frozen || generation === undefined) return undefined;
      members.push({ key, id: state.id, generation });
    }
    return members.length || 'preparation' in entry ? members : undefined;
  }
  private styleReserve(generation: number | undefined, bytes: number): boolean {
    const result = this.pool.reserve(generation, bytes); this.receipts(result.released);
    if (result.accepted) return true;
    this.clearStyleCache();
    const retry = this.pool.reserve(generation, bytes); this.receipts(retry.released); return retry.accepted;
  }
  private styleKey(vocabulary: string, rules: string): string { return `${vocabulary}/${rules}`; }
  private canDispatchStyles(description: Description | undefined, vocabulary: string): description is Description {
    return !!description && description.vocabulary.fingerprint === vocabulary && this.provider.isReady(this.workProvider);
  }
  private prepareStyles(node: WorkNode, description: Description | undefined, full: boolean): void {
    const selection = this.selection;
    if (!selection || !this.enabled || !this.active) return;
    // No descriptor enumeration/encoding for an uncached choice at full credits.
    const members = this.styleMembers(node); if (!members) return;
    const first = members[0], firstState = first && this.states.get(first.key)!;
    const sourceVocabulary = (first && firstState?.frozen ? this.pool.displayStatus(first.generation)?.vocabulary : undefined)
      ?? (first && this.pool.status(first.generation)?.vocabulary) ?? description?.vocabulary.fingerprint;
    if (!sourceVocabulary && members.length) return;
    const vocabulary = sourceVocabulary ?? '';
    const cache = this.styleCache.get(this.styleKey(vocabulary, selection.rules));
    const epoch = this.styleEpoch, revision = node.styleRevision;
    const attempt = node.attempt;
    const matching = attempt?.epoch === epoch && attempt.revision === revision && attempt.vocabulary === vocabulary;
    if (attempt && !matching) node.attempt = undefined;
    const outcome = matching ? attempt.outcome : undefined;
    const genericFailure = outcome?.cause !== undefined && outcome.cause !== 'installed' && outcome.cause !== 'withdrawn';
    const observedFailure = node.failedEpoch === epoch && node.failedRevision === revision && node.failedVocabulary === vocabulary;
    const firstFailureVisit = genericFailure && !observedFailure;
    if (firstFailureVisit) this.refuseStyles(node, vocabulary, epoch, revision);
    const failed = observedFailure || firstFailureVisit;
    const opportunity = nextStyle(outcome, this.canDispatchStyles(description, vocabulary), this.workProvider, this.clock.now());
    const failedLocalInput = node.failedPalette === selection.palette && node.failedBindingRevision === selection.bindingRevision;
    if (failed && !firstFailureVisit && failedLocalInput && node.failedCacheRevision === (cache?.revision ?? 0)) {
      if (!genericFailure) return;
      if (opportunity.kind === 'delayed') { this.noteWake(opportunity.at); return; }
      if (opportunity.kind === 'provider') { if (vocabulary) this.requestProviderOpportunity(); return; }
      if (opportunity.kind === 'refused') return;
    }
    const refuse = () => this.refuseStyles(node, vocabulary, epoch, revision);
    try {
    if ('preparation' in node.value) {
      const accepts = node.value.preparation.deref()?.acceptsSelection;
      const preparation = node.value.preparation.deref();
      if (accepts && preparation && !accepts.call(preparation, selection.palette, selection.rules)) return;
    }
    if (!this.active || this.selection !== selection) return;
    if (full && this.canDispatchStyles(description, vocabulary) && !members.every(member => this.states.get(member.key)?.frozen
      ? this.pool.displayStatus(member.generation)?.sourceBytes === 0 : (this.pool.status(member.generation)?.currentContexts ?? 0) === 0)
      && !members.every(member => this.hasCoverage(member, vocabulary, selection.rules))) {
      if (this.canDispatchStyles(description, vocabulary)) { this.work.requestRetry(); waitForCredit(this.owner); }
      return;
    }
    for (const member of members) {
      const state = this.states.get(member.key)!;
      let status = this.pool.status(member.generation);
      if (!status) return;
      if (state.empty && status.sourceVersion === undefined) {
        // Empty coverage is local and carries no parser acknowledgement/lease.
        const result = this.pool.installChunk(member.generation, { key: status.key, generation: member.generation,
          source_version: state.version, revision: 1, source_bytes: 0, replace_from: 0, committed_bytes: 0, complete: true,
          vocabulary, contexts: [], runs: new Uint32Array(), counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } });
        this.receipts(result.released); if (!result.accepted) { refuse(); return; }
        status = this.pool.status(member.generation)!;
      }
      if (status.sourceVersion === undefined || (state.frozen ? this.pool.displayStatus(member.generation)?.vocabulary ?? status.vocabulary : status.vocabulary) !== vocabulary) return;
    }
    const current = (!('preparation' in node.value) || !!node.ready && node.ready.rules === selection.rules
       && node.ready.palette === selection.palette && node.ready.bindingRevision === selection.bindingRevision
       && this.groupCurrent(node, node.ready.stamp)) && members.every(member => {
       const state = this.states.get(member.key)!, display = this.pool.displayStatus(member.generation), status = this.pool.status(member.generation)!;
       return display?.rules === selection.rules && display.palette === selection.palette && display.bindingRevision === selection.bindingRevision
         && state.displayNeutral === state.neutral
         && (state.frozen || display.semanticStamp === status.semanticStamp && this.matchesContent(state, display.sourceVersion));
     });
     if (current) { this.clearStyleRefusal(node); node.attempt = undefined; for (const member of members) this.states.get(member.key)!.styleDirty = false; return; }
    this.counters.stylePreparations++;
    const count = members.reduce((n, member) => n + (this.pool.status(member.generation)?.currentContexts ?? 0), 0);
    const historical = members.reduce((n, member) => n + (this.states.get(member.key)?.frozen ? this.pool.status(member.generation)?.displayBytes ?? 0 : 0), 0);
    const scratch = 2048 + members.length * 1024 + count * 1024 + historical * 4;
    if (!this.styleReserve(members[0]?.generation, scratch)) { refuse(); return; }
    const grant = this.pool.budget.reserve(scratch); if (!grant) { refuse(); return; }
    let pendingCapture: SemanticCaptureGroup | undefined;
    try {
      const captureSelections: CaptureSelection[] = [];
      const plan = collectStyleContexts(members, (member, add) => {
        const state = this.states.get(member.key), display = this.pool.displayStatus(member.generation);
        if (state?.frozen) {
          if (!display) return false;
          captureSelections.push({ generation: member.generation, effectStamp: display.effectStamp });
          return this.pool.visitDisplayContexts(member.generation, display.effectStamp, add);
        }
        captureSelections.push(member.generation);
        return this.pool.visitContexts(member.generation, add);
      }, ref => !!this.pool.arena.style(vocabulary, ref, selection.rules), () => { this.counters.styleContextVisits++; });
      if (!plan) return;
      const { missing } = plan;
       if (!missing.length) {
         if (!this.publishStyles(members, selection, undefined, node, vocabulary)) refuse();
         else { this.clearStyleRefusal(node); node.attempt = undefined; }
         return;
       }
      if (failed && !genericFailure) { refuse(); return; }
      // A deferred native retry must still remember this cache revision's missing expressions.
      if (genericFailure && opportunity.kind !== 'resolve') refuse();
      if (opportunity.kind === 'delayed') { this.noteWake(opportunity.at); return; }
      if (opportunity.kind === 'provider') { if (vocabulary) this.requestProviderOpportunity(); return; }
      if (opportunity.kind === 'refused') return;
      if (full) {
        if (this.canDispatchStyles(description, vocabulary)) { this.work.requestRetry(); waitForCredit(this.owner); }
        return;
      }
      const pending = [...this.jobs.values()].filter((job): job is StyleRequest => job.operation === 'style' && job.style?.expected.vocabulary === vocabulary && job.style.expected.rules === selection.rules);
      // Jobs, not subscribers, are the sole in-flight overlap index. The next
      // ordinary credit wake revisits other owners through the same registry.
      const overlap = pending.find(job => missing.some(ref => job.style!.refs.includes(ref)));
      if (overlap) {
        // A coalesced attempt carries only a primitive refusal receipt, never a
        // subscriber owner, result payload or another scheduling queue.
        const prior = overlap.style!;
        if (prior.epoch === epoch && revision <= prior.demandRevision)
          node.attempt = { outcome: overlap.outcome, epoch, revision, vocabulary };
        this.work.requestRetry(); return;
      }
      if (!this.canDispatchStyles(description, vocabulary)) return;
      const estimate = estimateStyleRepresentation(this.pool.arena, this.pool, vocabulary, missing, captureSelections, HIGHLIGHT_LIMITS.contextWords);
      const { encodedPeak, capturePeak } = estimate;
      if (!estimate.fits) { refuse(); this.counters.styleRejections++; return; }
      if (members.length && !capturePeak) { refuse(); return; }
      const decodedBytes = Math.min(this.maxDecodedBytes, 256 * (missing.length + 26) + 4 * missing.length + 258);
      const frameBytes = Math.min(OCCIPITAL_LIMITS.dataWireBytes, Math.max(description.limits.request_bytes, description.limits.reply_bytes));
      // Complete-table materialization uses every captured context, not merely
      // the requested missing subset; the reply may arrive after parser advance.
      const bytes = 4 * frameBytes + encodedPeak + capturePeak + decodedBytes + scratch + 32768 + 1024 + members.length * 128 + missing.length * 16;
      if (bytes > this.maxTransientBytes) { refuse(); this.counters.styleRejections++; return; }
      if (!this.capacity(bytes)) { this.work.noteCreditBlocked(); this.work.requestRetry(); waitForCredit(this.owner); return; }
      const captured = members.length ? this.pool.captureDisplays(captureSelections, () => true) : undefined;
      if (captured) this.receipts(captured.released);
      if (captured && (!captured.accepted || !captured.group)) { refuse(); return; }
      const captures = captured?.group; pendingCapture = captures;
      const encoded = this.pool.arena.encode(vocabulary, missing, peak => this.styleReserve(members[0]?.generation, peak), HIGHLIGHT_LIMITS.contextWords);
      if (!encoded) { captures?.release(); refuse(); return; }
      this.counters.styleEncodes++;
      const first = members[0], job = this.job({ operation: 'style', key: first?.key, generation: first?.generation, outcome: { provider: this.workProvider },
        style: { expected: expectation(selection, vocabulary), captures, refs: missing, members,
          group: 'preparation' in node.value ? new WeakRef(node.value) : undefined, groupRevision: node.seal?.revision, node: new WeakRef(node), epoch, revision, demandRevision: this.styleRevision, decodedBytes } }, this.workProvider, description, bytes);
      job.kind = this.provider.snapshot().kind;
      this.clearStyleRefusal(node);
      node.attempt = { outcome: job.outcome, epoch, revision, vocabulary };
      pendingCapture = undefined;
      // The transport may hold the canonical client declaration after logical
      // cancellation/owner GC. Its owner-free charge ends at physical settlement.
      job.styleCharge = this.selectionCharge!.retain();
      this.counters.styleDispatches++;
      const admission = this.options.admission ?? 'bounded_queue';
      const common = { v: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'styles.resolve' as const,
        vocabulary, contexts: encoded, rules: selection.input.definition };
      const request = admission === 'bounded_queue'
        ? { ...common, admission, queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) }
        : { ...common, admission };
      this.dispatch(job, request);
    } finally { pendingCapture?.release(); grant.close(); }
    } catch (error) {
      refuse(); this.counters.styleRejections++;
      this.log(unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Local style preparation refused; source execution authority is unchanged', { code: diagnosticError(error) });
      if (unexpectedDiagnostic(error)) reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
    }
  }
  private publishStyles(members: readonly StyleMember[], selection: PreparedSelection, captures?: SemanticCaptureGroup, node?: WorkNode, vocabularyHint?: string): boolean {
    if (!this.enabled || !this.active || this.selection !== selection) return false;
    const vocabulary = captures?.captures[0]?.vocabulary ?? (members[0] && this.pool.status(members[0].generation)?.vocabulary) ?? vocabularyHint;
    if (vocabulary === undefined) return false;
    const roles = selection.input.roles;
    const grouped = node && 'preparation' in node.value ? node : undefined;
    if (grouped && (!grouped.seal || !('preparation' in grouped.value) || !this.sealMatches(grouped.value, grouped.seal)
      || grouped.seal.members.length !== members.length || members.some((member, i) => member.key !== grouped.seal!.members[i]!.key || member.id !== grouped.seal!.members[i]!.id))) return false;
    if (!this.active || this.selection !== selection) return false;
    const readyBytes = 1024 + members.reduce((bytes, member) => bytes + 512 + 2 * member.key.length, 0);
    const groupGrant = grouped ? this.pool.budget.reserve(readyBytes) : undefined;
    if (grouped && !groupGrant) return false;
    try {
    const invalidation = this.pool.arena.styleInvalidationRevision;
    const updates: (ReadyDisplayUpdate & { bindingChanged: boolean })[] = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!, state = this.states.get(member.key), capture = captures?.captures[i];
      if (state?.id !== member.id || (state.frozen ? state.previous : state.generation) !== member.generation || state.retired && !state.frozen) return false;
      const status = this.pool.status(member.generation), display = this.pool.displayStatus(member.generation);
      if (!status) return false;
      if (captures && members.length > 1 && (status.semanticStamp !== capture!.semanticStamp || status.sourceVersion !== capture!.sourceVersion)) return false;
      const contexts: { context: ContextRef; style: ConcreteStyle }[] = [];
      let complete = true;
      const add = (context: ContextRef) => {
        const expression = this.pool.arena.style(vocabulary, context, selection.rules);
        if (!expression) complete = false;
        else contexts.push({ context, style: concreteStyle(expression, selection, roles, state.neutral) });
      };
      if (capture) { if (!capture.visitContexts(add)) return false; }
      else if (state.frozen && display) { if (!this.pool.visitDisplayContexts(member.generation, display.effectStamp, add)) return false; }
      else if (!this.pool.visitContexts(member.generation, add)) return false;
      if (!complete) return false;
      // A version-only acknowledgement does not change the owned display text
      // or scopes. Reuse that view without promoting its completion metadata.
      const retained = display && (state.frozen || display.semanticStamp === status.semanticStamp
        && this.matchesContent(state, display.sourceVersion));
      updates.push({ generation: member.generation,
        bindingChanged: !display || display.palette !== selection.palette || display.bindingRevision !== selection.bindingRevision,
        candidate: { ...(capture ? { capture } : {}),
        semanticStamp: capture?.semanticStamp ?? (retained ? display.semanticStamp : status.semanticStamp),
        sourceVersion: capture?.sourceVersion ?? (retained ? display.sourceVersion : status.sourceVersion!),
        presentation: { vocabulary, rules: selection.rules, palette: selection.palette, bindingRevision: selection.bindingRevision, roles, contexts } } });
    }
    const result = updates.length ? this.pool.publishDisplays(updates) : { accepted: true, released: [] }; this.receipts(result.released);
    if (!result.accepted) return false;
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!, state = this.states.get(member.key), display = this.pool.displayStatus(member.generation);
      if (!state || !display) continue;
      this.rememberCoverage(member, vocabulary, selection.rules, invalidation);
      const effect = display.effectStamp;
      if (updates[i]!.bindingChanged || state.displayEffect !== effect || state.displayPalette !== selection.palette || state.displayRules !== selection.rules) {
        state.displayStamp = ++this.displaySequence; state.displayEffect = effect; this.changed(state.key);
      }
      state.displayNeutral = state.neutral;
      state.displayPalette = selection.palette; state.displayRules = selection.rules;
      state.displayVersion = display.complete && this.matchesContent(state, display.sourceVersion) ? state.version : undefined;
      state.styleDirty = display.semanticStamp !== this.pool.status(member.generation)?.semanticStamp;
    }
    if (grouped && !this.publishGroup(grouped, members, selection, roles, groupGrant!, readyBytes)) return false;
    if (grouped) for (const member of members) {
      const state = this.states.get(member.key)!;
      if (state.previous !== undefined && state.previous !== member.generation) {
        const previous = state.previous; state.previous = undefined; state.previousCoverage = false;
        this.receipts(this.pool.remove(previous));
      }
    }
    if (node) reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: node, operation: 'styles' });
    this.counters.stylePublications++; return true;
    } finally { groupGrant?.close(); }
  }
  private publishGroup(node: WorkNode, members: readonly StyleMember[], selection: PreparedSelection, roles: StyleRoles,
    grant: DataGrant, bytes: number): boolean {
    const entry = node.value;
    if (!('preparation' in entry) || !node.seal || !this.sealMatches(entry, node.seal) || !entry.preparation.deref() || !this.active) return false;
    // The existing 512-byte/member allowance funds one ordered map association and scalar receipt.
    // Its grant is reserved by publishStyles before this controlled collection allocation.
    const readyMembers = new Map<string, GroupReadyMember>();
    for (const member of members) {
      const state = this.states.get(member.key), display = this.pool.displayStatus(member.generation);
      if (!state || !display || state.id !== member.id || display.rules !== selection.rules || display.palette !== selection.palette
        || display.bindingRevision !== selection.bindingRevision) return false;
      readyMembers.set(member.key, { ...member, version: display.sourceVersion, stamp: state.displayStamp,
        geometryStamp: display.geometryStamp, paintStamp: display.effectStamp, complete: display.complete });
    }
    const prior = node.ready;
    let equal = !!prior && equalRoles(prior.roles, roles) && prior.members.size === readyMembers.size;
    let sameStamps = equal;
    if (equal) {
      const previous = prior!.members.values();
      for (const member of readyMembers.values()) {
        const old = previous.next().value!;
        if (old.key !== member.key || old.id !== member.id || old.generation !== member.generation
          || old.geometryStamp !== member.geometryStamp || old.paintStamp !== member.paintStamp) { equal = false; break; }
        if (old.stamp !== member.stamp) sameStamps = false;
      }
    }
    const unchanged = equal && sameStamps && prior!.rules === selection.rules && prior!.palette === selection.palette && prior!.bindingRevision === selection.bindingRevision;
    if (unchanged) return true;
    const pin = this.selectionCharge;
    if (!pin) return false;
    const stamp = ++this.displaySequence;
    const ready: GroupReady = { members: readyMembers, readers: 0, roles, rules: selection.rules, palette: selection.palette, bindingRevision: selection.bindingRevision,
      stamp, paintStamp: equal ? prior!.paintStamp : stamp, pin: pin.retain(), charge: grant.consume(bytes) };
    publishGroupReady(node, ready, this.lifetime.groups); this.changedGroup(entry.id);
    return true;
  }
    private settleStyles(job: StyleRequest, raw: unknown, rejected: boolean): void {
    const style = job.style;
    let expressionsInstalled = false, workerUnavailable = false;
    let failureCause: StyleCause = 'retry';
    try {
      if (!style || this.disposed || !this.enabled || !this.active || job.stopped || job.pendingRetire || job.abort.signal.aborted) {
        const intentional = job.origin === 'suspended' || job.origin === 'disabled' || job.origin === 'disposed' || job.origin === 'handoff';
        this.refuseStyleJob(job, job.origin && !intentional ? 'route' : 'withdrawn'); return;
      }
      if (rejected) {
        this.refuseStyleJob(job, this.provider.isReady(job.provider) ? 'other' : 'route');
        const node = this.styleHealthOwner(style, job.provider);
        if (node && unexpectedDiagnostic(raw)) {
          this.log('ERROR', 'Native style request failed unexpectedly', { source: job.key, job: job.id, code: diagnosticError(raw) });
          reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(raw) });
        }
        return;
      }
      let decoded: ReturnType<typeof decodeSemanticStyleReply>;
      try { decoded = decodeSemanticStyleReply(raw, job.ticket, job.description, style.expected, style.refs.length, style.decodedBytes, HIGHLIGHT_LIMITS, job.replySize); }
      catch (error) {
        if (error instanceof RemoteFault) { failureCause = styleFaultCause(error.code, error.execution); workerUnavailable = error.code === 'worker_gone'; }
        throw error;
      }
      failureCause = 'local';
      const reserve = (bytes: number) => this.styleReserve(undefined, bytes);
      if (!this.pool.arena.installStyles(style.expected.vocabulary, style.expected.rules, style.refs, decoded.styles, decoded.indices, reserve)) {
        this.refuseStyleJob(job, 'local'); return;
      }
      expressionsInstalled = true; job.outcome.cause = 'installed'; job.outcome.retryAt = undefined;
      const key = this.styleKey(style.expected.vocabulary, style.expected.rules);
      if (!this.styleCache.has(key)) {
        const bytes = 512;
        if (!reserve(bytes)) { this.refuseStyleOwner(style); return; }
        const grant = this.pool.budget.reserve(bytes); if (!grant) { this.refuseStyleOwner(style); return; }
        try {
          const cache: StyleCache = { revision: 0, charge: grant.consume(bytes) };
          this.styleCache.set(key, cache); this.lifetime.charges.add(cache.charge);
        } finally { grant.close(); }
      }
      this.styleCache.get(key)!.revision++;
      const selected = this.selection;
      const group = style.group?.deref(), node = group && this.work.get(group);
      const current = this.provider.snapshot().description, preparation = group?.preparation.deref();
      if (preparation?.acceptsSelection && selected && !preparation.acceptsSelection(selected.palette, selected.rules)) return;
      // Supplied predicates may stop work or replace selection without a funding failure.
      if (!this.active || this.selection !== selected || !selected || style.group && (style.epoch !== this.styleEpoch || style.groupRevision !== node?.seal?.revision) || selected.rules !== style.expected.rules
        || current?.vocabulary.fingerprint !== style.expected.vocabulary || style.group && (!node || node.paused || !preparation)) return;
      if (!this.publishStyles(style.members, selected, style.captures, node, style.expected.vocabulary)) this.refuseStyleOwner(style);
      else {
        const owner = style.node.deref();
        if (owner) reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: owner, operation: 'styles' });
      }
    } catch (error) {
      this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Native style reply refused; source execution authority is unchanged', { source: job.key, job: job.id, provider: job.provider, code: diagnosticError(error) });
      const node = style && this.styleHealthOwner(style, job.provider);
      if (node && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
      this.counters.styleRejections++;
      if (style) {
        if (expressionsInstalled) this.refuseStyleOwner(style);
        else this.refuseStyleJob(job, failureCause);
      }
    } finally {
      this.release(job);
      try { if (workerUnavailable && this.active) void this.provider.workerUnavailable(job.provider).catch(ignored); }
      finally { this.rewind(); this.schedule(); this.finishLifetime(); }
    }
  }
  private reservation(captureUnits: number, replacementUnits: number, inputUnits: number, replacementBytes: number, d: Description): number {
    return sourceReservation({ captureUnits, replacementUnits, inputUnits, replacementBytes,
      frameBytes: Math.min(OCCIPITAL_LIMITS.dataWireBytes, Math.max(d.limits.request_bytes, d.limits.reply_bytes)),
       decodedBytes: this.maxDecodedBytes });
  }
  private capacity(bytes: number): boolean {
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
    if (open && this.remoteLeases >= description.limits.leases_per_route) {
      const known = this.closes.some(close => close.provider === state.provider)
        || [...this.states.values()].some(source => source.provider === state.provider && typeof source.continuation === 'string');
      if (!known && this.jobs.size === 0) void this.provider.exhaustedRoute(state.provider).catch(ignored);
      else { this.work.requestRetry(); waitForCredit(this.owner); }
      return;
    }
    const from = append ? state.committedUnits : 0, inputFrom = append ? basis.text.length : 0;
    const inputBytes = snapshot.utf8Bytes - (append ? basis.utf8Bytes : 0);
    const replacementBytes = snapshot.utf8Bytes - (append ? status.committedBytes : 0);
    const bytes = this.reservation(snapshot.text.length, snapshot.text.length - from, snapshot.text.length - inputFrom, replacementBytes, description);
    if (bytes > this.maxTransientBytes) { this.refuseSource(state, 'requestLimit'); this.changed(state.key); return; }
    if (!this.capacity(bytes)) { this.work.noteCreditBlocked(); waitForCredit(this.owner); return 'credit'; }
    const job = this.job({ operation: 'source', key: state.key, generation: state.generation, stateId: state.id, inputRevision: state.inputRevision, source: undefined }, state.provider, description, bytes);
    const replacementText = snapshot.text.slice(from);
    if (!coherent(replacementText)) { this.physicalSettled(job); this.refuseSource(state, 'encoding'); this.changed(state.key); return; }
    if (!this.active || !this.enabled) { this.physicalSettled(job); return; }
    const expected: ExpectedSource = { key: status.key, generation: state.generation, source_version: snapshot.version,
       revision: status.revision + 1,
      source_bytes: snapshot.utf8Bytes, replace_from: append ? status.committedBytes : 0, complete: state.complete,
      ...(append ? { lease: lease! } : {}), replacementText };
    job.kind = this.provider.snapshot().kind;
    job.source = { capture: { version: snapshot.version, text: snapshot.text }, expected, replaceUnits: from, open,
      decodedBytes: this.maxDecodedBytes };
    const admission = this.options.admission ?? 'bounded_queue';
    const common = { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance } as const;
    const admissionFields = admission === 'bounded_queue'
      ? { admission, queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) }
      : { admission };
    const request: SemanticDataRequest = append
      ? { ...common, ...admissionFields, op: 'stream.append', key: status.key, generation: state.generation, lease: lease!,
        base_revision: status.revision, base_bytes: basis.utf8Bytes, source_version: snapshot.version,
        append: snapshot.text.slice(inputFrom), final: state.complete }
      : { ...common, ...admissionFields, op: state.complete ? 'highlight' : 'stream.open', sources: [{ key: status.key,
        generation: state.generation, source_version: snapshot.version,
        hint: { ...(state.language === undefined ? {} : { language: state.language }), ...(state.path === undefined ? {} : { path: state.path }) }, text: snapshot.text }] };
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
    this.log('DEBUG', 'Native job dispatched', { source: job.key, job: job.id, generation: job.generation, provider: job.provider,
      operation: typeof request.op === 'string' ? request.op : 'unknown', version: job.operation === 'source' ? job.source?.expected.source_version : undefined,
      sourceBytes: job.operation === 'source' ? job.source?.expected.source_bytes : undefined, reservedBytes: job.bytes });
    try { dataJsonBytes(request, Math.min(OCCIPITAL_LIMITS.dataWireBytes, job.description.limits.request_bytes)); }
    catch { observers.failed(Object.assign(new RequestFailure('occipital data request byte limit', 'not_started'), { code: 'frame_limit' })); return; }
    try { void this.provider.request(job.provider, request, { signal: job.abort.signal, deadlineMs: this.options.deadlineMs, acceptRetired: true, replySize: job.replySize })
      .then(observers.reply, observers.failed).catch(ignored); } catch (error) { observers.failed(error); }
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
      if (job.operation === 'source' && permission && !this.disposed) {
        const next = this.workStatus(job.key), current = this.states.get(job.key);
        if (permission.execution !== next.execution || permission.fallbackEligible !== next.fallbackEligible) {
          if (current) this.log('DEBUG', next.fallbackEligible ? 'Fallback permission available; not a fallback invocation (no Pi fallback for Bash)' : 'Source authority prohibits duplicate fallback classification',
            { source: job.key, version: current.version, execution: next.execution, fallbackEligible: next.fallbackEligible });
          this.changed(job.key);
        }
      }
    } finally { this.finishLifetime(); this.completeWork(); }
  }
  private cancelJob(job: Job, deferred: boolean): void {
    if (deferred) { job.pendingRetire = true; this.schedule(); }
    else { job.pendingRetire = undefined; job.abort.abort(sourceRetired); }
  }
  private drainRetirements(): void {
    for (const job of this.jobs.values()) if (job.pendingRetire) {
      job.pendingRetire = undefined; job.abort.abort(sourceRetired);
    }
  }
  /** Only the scheduled continuation drains render-pressure effects. A direct flush must stay inert. */
  continueWork(): void { this.drainRetirements(); this.runWorkTurn(); }
  private schedule(): void { this.work.schedule(); }
  private reconcileCreditInterest(): void {
    // Credit interest is conservative; normal queue traversal reestablishes only the interest still owed.
    if (waiters.delete(this.owner)) this.wake();
  }
  wake(): void { this.work.wake(); }
  private changed(key: string): void {
    if (!this.options.onChange || this.disposed || !this.states.has(key) && !this.pi.has(key)) return;
    this.noticeKeys.add(key);
    if (this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(notice(this.owner, this.noticeEpoch));
  }
  /** Weak notification delivery; an obsolete off/on epoch cannot erase a newer notice. */
  private changedGroup(id: number): void {
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
    if (job.operation === 'style') this.settleStyles(job, raw, rejected);
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
      if (healthOwner && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation, area: 'syntax', code: diagnosticError(error) });
      this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error) ? 'ERROR' : 'WARN',
        'Native lease close failed; its liability remains unproven', { source: job.key, job: job.id, provider: job.provider, code: diagnosticError(error) });
    } finally {
      this.release(job);
      try { if (workerUnavailable && this.active) void this.provider.workerUnavailable(job.provider).catch(ignored); }
      finally {
        this.schedule(); this.finishLifetime();
        const current = this.states.get(job.key);
        if (current) this.work.revisit(current.group ?? current, this.sourceOwed(current) || current.styleDirty);
      }
    }
  }
    private settleSource(job: SourceJob, raw: unknown, rejected: boolean): void {
    const providerCurrent = this.provider.isReady(job.provider), state = this.states.get(job.key);
    const healthOwner = state?.id === job.stateId ? state : undefined;
    const useful = this.active && this.enabled && !job.stopped && !job.pendingRetire && providerCurrent && !job.abort.signal.aborted
      && state?.id === job.stateId && admittedSource(state) && state.generation === job.generation && !!this.pool.status(job.generation);
    let changed = false, acknowledged = false, workerUnavailable = false;
    try {
      if (job.origin === 'suspended') { changed = this.recordSourceOutcome(job, 'withdrawn'); return; }
      if (rejected) {
        if (healthOwner && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(raw))
          reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation: 'source', area: 'syntax', code: diagnosticError(raw) });
        const outcome = raw instanceof RequestFailure && raw.execution === 'not_started' ? 'not_started' : 'unknown';
        this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(raw) ? 'ERROR' : 'WARN', 'Native request rejected; cancellation or rejection is not stop proof',
          { source: job.key, job: job.id, provider: job.provider, version: job.source?.expected.source_version, execution: outcome, code: diagnosticError(raw) });
        if (outcome === 'not_started' && job.source?.open && providerCurrent && this.leaseProvider === job.provider)
          this.remoteLeases = Math.max(0, this.remoteLeases - 1);
        changed = this.recordSourceOutcome(job, outcome, outcome === 'not_started' ? 'refused' : job.origin === undefined && providerCurrent ? 'other' : 'route');
        return;
      }
      if (!job.source || job.stopped) return;
      const source = job.source, chunk = decodeSemanticSourceReply(raw, job.ticket, job.description,
        [source.expected], source.decodedBytes, HIGHLIGHT_LIMITS, job.replySize).sources[0]!;
      this.counters.decodedBytes += chunk.source_bytes - chunk.replace_from;
      acknowledged = true; changed = this.recordSourceOutcome(job, 'acknowledged');
      if (this.currentSourceAttempt(state, job)) state.retryAt = undefined;
      if (!useful || !this.active) {
        this.counters.staleReplies++;
        this.log('DEBUG', 'Validated native reply is stale; its colors rejected', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
        if (source.open && chunk.lease && !chunk.complete && providerCurrent) this.close({ key: chunk.key, ownerKey: job.key,
          generation: chunk.generation, lease: chunk.lease, provider: job.provider, health: healthOwner && new WeakRef(healthOwner) });
        return;
      }
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
        if (chunk.lease && !chunk.complete) this.close({ key: chunk.key, ownerKey: job.key, generation: chunk.generation, lease: chunk.lease, provider: job.provider,
          health: healthOwner && new WeakRef(healthOwner) });
        state.continuation = undefined; this.refuseSource(state, 'adoption'); state.styleDirty = false;
        return;
      }
      state.parsedAssets = job.description.assets; state.parsedProvider = job.provider; state.styleDirty = true;
      const sameSemantic = previousSemantic === this.pool.status(job.generation)?.semanticStamp;
      this.invalidateStyles(state, sameSemantic, !sameSemantic);
      if (state.previous !== undefined && (!state.group || !this.pool.displayStatus(state.previous))) {
        this.pool.remove(state.previous); state.previous = undefined; state.previousCoverage = false;
      }
      state.committedUnits = chunk.complete ? source.capture.text.length : source.replaceUnits + source.expected.replacementText.lastIndexOf('\n') + 1;
      state.continuation = chunk.complete ? undefined : chunk.lease;
      reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: state, operation: 'source' });
      this.log('DEBUG', 'Validated native result accepted', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version,
        sourceBytes: chunk.source_bytes, committedBytes: chunk.committed_bytes, complete: chunk.complete,
        committedLineCalls: chunk.counters.committed_line_calls, tailCalls: chunk.counters.tail_calls });
    } catch (error) {
      if (healthOwner && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation: 'source', area: 'syntax', code: diagnosticError(error) });
      if (acknowledged) {
        if (state?.id === job.stateId) this.refuseSource(state, 'adoption');
        throw error;
      }
      const fault = error instanceof RemoteFault ? error : undefined;
      const outcome = fault?.execution === 'not_started' ? 'not_started' : fault?.execution === 'started' ? 'started' : 'unknown';
      const cause = fault ? sourceFaultCause(fault.code, fault.execution) : job.origin === undefined && providerCurrent ? 'retry' : 'route';
      this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Native reply refused by validation or remote admission',
        { source: job.key, job: job.id, provider: job.provider, version: job.source?.expected.source_version, execution: outcome, code: diagnosticError(error) });
      if (outcome === 'not_started' && job.source?.open && providerCurrent && this.leaseProvider === job.provider)
        this.remoteLeases = Math.max(0, this.remoteLeases - 1);
      changed = this.recordSourceOutcome(job, outcome, cause);
      if (cause === 'resync' && state?.id === job.stateId && state.generation === job.generation && state.provider === job.provider
        && this.active && this.enabled && !job.stopped && !job.pendingRetire && !job.abort.signal.aborted && this.provider.isReady(job.provider)) {
        const lease = state.continuation; state.continuation = null;
        const key = this.pool.status(job.generation)?.key;
        if (typeof lease === 'string' && key) this.close({ key, ownerKey: state.key, generation: job.generation,
          lease, provider: job.provider, health: new WeakRef(state) });
      }
      if (cause === 'retry' && this.currentSourceAttempt(state, job)) state.retryAt = this.clock.now() + SOURCE_RETRY_MS;
      workerUnavailable = fault?.code === 'worker_gone';
    } finally {
      this.release(job);
      try { if (workerUnavailable && this.active) void this.provider.workerUnavailable(job.provider).catch(ignored); }
      finally {
        this.schedule(); this.finishLifetime();
        const current = this.states.get(job.key);
        if (current) this.work.revisit(current.group ?? current, this.sourceOwed(current) || current.styleDirty);
        if (current?.id === job.stateId && changed) this.changed(job.key);
      }
    }
  }
}
