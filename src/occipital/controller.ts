import { concreteStyle, expectation, nativeRoles, prepareSelection, selectionBytes, type PreparedSelection, type StyleRoles, type StyleSelection } from './controller-styles.ts';
import type { StagedPiProjection } from './pi-projection.ts';
import { PiPreparation } from './semantic-retention.ts';
export type { PiPreparation } from './semantic-retention.ts';
import type { DataBudget, DataCharge, DataGrant } from './data-budget.ts';
import type { ContextRef } from './context-arena.ts';
import { CARD_ROLES, type CardRole } from './semantic-codec.ts';
import type { SemanticCaptureGroup } from './semantic-capture.ts';
import { decodeSemanticStyleReply, type SemanticStyleExpectation } from './semantic-protocol.ts';
import type { CaptureSelection, ReadyDisplayUpdate } from './semantic-retention.ts';
export type { StyleSelection } from './controller-styles.ts';
import { type DiagnosticFields, type DiagnosticLevel, type DiagnosticSink, diagnose, diagnosticError, reportRuntime, unexpectedDiagnostic } from '../diagnostics.ts';
import { RemoteFault } from './protocol.ts';
import { decodeSemanticClosed as decodeClosed, decodeSemanticSourceReply, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, type SemanticDescription as Description } from './semantic-protocol.ts';
import type { SemanticExpectation as ExpectedSource } from './semantic-source.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';
import { SemanticRetentionPool, type SemanticRelease as ReleaseReceipt } from './semantic-retention.ts';
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from './limits.ts';
import { dataJsonBytes, type ReplySize } from './data-json.ts';
import { RequestFailure } from './request-failure.ts';
import type { ProviderBroker } from './provider.ts';
import { RETENTION_LIMITS } from './retention.ts';

import { sourceFits, sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
export { sourceReservation, CONTROLLER_LIMITS } from './controller-limits.ts';
export interface SourceDemand {
  key: string; version: number; text: string; language?: string; path?: string; profile: string; fingerprint: string; complete: boolean;
  /** Presentation default only; never part of parser identity. */
  neutral?: 'title' | 'code';
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
export type SourceWorkGroup = { readonly id: number; readonly preparation: WeakRef<SourcePreparation>; readonly keys: ReadonlySet<string> };
export interface GeometryFunding {
  readonly budget: DataBudget;
  grant(bytes: number): DataGrant | undefined;
}
type WorkEntry = SourceWorkGroup | SourceState;
type StyleAttempt = { failed: boolean };
type GroupMember = { key: string; id: number };
type GroupSeal = { members: readonly GroupMember[]; revision: number; charge: DataCharge };
type GroupReadyMember = GroupMember & { generation: number; version: number; stamp: number; geometryStamp: number; paintStamp: number; complete: boolean };
type GroupHold = { charge: DataCharge; pin: DataCharge };
type GroupReady = GroupHold & { members: ReadonlyMap<string, GroupReadyMember>; readers: number; roles: StyleRoles; stamp: number; paintStamp: number;
  rules: string; palette: string; bindingRevision: number; profile: string; fingerprint: string };
type WorkNode = { seal?: GroupSeal; ready?: GroupReady; attempt?: { outcome: StyleAttempt; epoch: number; revision: number; vocabulary: string }; styleRevision: number; failedEpoch?: number; failedRevision?: number; failedVocabulary?: string; failedCacheRevision?: number; value: WorkEntry; pending: false | 'native' | 'local'; epoch: number; seen: number; paused?: boolean; older?: WorkNode; newer?: WorkNode };
// Weak registry/refusal metadata plus one targeted group-ID notice association/packet.
const groupBytes = 1024;

export interface ControllerOptions {
  diagnostic?: DiagnosticSink;
  deadlineMs?: number; admission?: 'try_now' | 'bounded_queue'; queueWaitMs?: number;
  maxTransientBytes?: number; maxBookkeepingBytes?: number;
  retention?: ConstructorParameters<typeof SemanticRetentionPool>[0];
  /** Coalesced asynchronous notice after accepted colors or terminal source state changes.
    * Keys and primitive group IDs target their still-owned presentation records. */
  onChange?: (keys: readonly string[], changedGroups?: readonly number[]) => void;
}
type Provider = Pick<ProviderBroker, 'snapshot' | 'isReady' | 'request' | 'classificationAccepted'>;
type Execution = 'not_started' | 'unsettled' | 'acknowledged' | 'unknown' | 'started';
export type PiFailure = 'threw' | 'invalid_rows';
export interface SourceWorkStatus {
  version?: number; execution: Execution; fallbackEligible: boolean; profileRetryAllowed: boolean;
}
export interface PiProjectionReader {
  readonly generation: number; readonly version: number; readonly palette: number; readonly revision: number;
  readonly sourceBytes: number; readonly rangeCount: number; readonly styleCount: number;
  visitRanges(consume: (start: number, end: number, style: number) => void): boolean;
  visitStyles(consume: (index: number, style: ConcreteStyle) => void): boolean;
}
export type DisplayRangeReader = (consume: (start: number, end: number, style: ConcreteStyle) => void) => boolean;
/** Historical display coordinates only, never parser/fallback/finite-work authority. */
export interface GroupDisplayMember {
  readonly key: string; readonly generation: number; readonly version: number; readonly stamp: number;
  readonly geometryStamp: number; readonly paintStamp: number; readonly complete: boolean;
  readonly read: DisplayRangeReader;
}
export interface GroupDisplayBasis {
  /** Strict reader validity and displayed effects are independent identities. */
  readonly stamp: number; readonly paintStamp: number; readonly profile: string; readonly fingerprint: string;
  readonly rules: string; readonly palette: string; readonly bindingRevision: number;
  role(role: CardRole): ConcreteStyle | undefined;
  /** Complete ready literals (roles and member tables); identities may repeat. */
  visitStyles(consume: (style: ConcreteStyle) => void): boolean;
  /** Provisional synchronous transaction: publish caller output only on true. */
  visit(consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean;
}
export interface SourceDisplayBasis {
  generation: number; version: number; stamp: number; language?: string; profile: string; fingerprint: string; complete: boolean; exactVersion?: number;
  /** Separate cache identities; stamp above is weak-reader validity, not paint. */
  geometryStamp: number; paintStamp: number;
  /** Detached immutable literal. Retained output/copies belong to the caller's budget. */
  role(role: CardRole): ConcreteStyle | undefined;
  /** Adopted neutral and context literals, not a traversal of source ranges. */
  visitStyles(consume: (style: ConcreteStyle) => void): boolean;
  visit(consume: (text: string, read: DisplayRangeReader) => void): boolean;
}
type StyleCoverage = { generation: number; semanticStamp: number; sourceVersion: number; vocabulary: string; invalidation: number; charge: DataCharge };
type SourceState = {
  coverage?: Map<string, StyleCoverage>;
  // Two primitive role receipts fit the existing source entry allowance.
  neutral: NonNullable<SourceDemand['neutral']>; displayNeutral?: NonNullable<SourceDemand['neutral']>;
  id: number; key: string; group?: SourceWorkGroup; generation?: number; previous?: number; previousCoverage?: boolean; committedUnits: number;
  // Last validated display identity is independent of the currently requested profile.
  // Its bounded protocol strings fit the existing per-entry bookkeeping allowance.
  displayStamp: number; displayEffect?: number; displayProfile?: string; displayFingerprint?: string; displayVersion?: number; frozen?: boolean;
  // Earliest observed version with this same text/identity. This aliases local
  // coverage only; pool/remote acknowledgement versions remain unchanged.
  version: number; contentVersion: number; language?: string; path?: string; profile: string; fingerprint: string; complete: boolean;
  provider: number; refusedProvider?: number; parsedAssets?: string; parsedProvider?: number; dirty: boolean; styleDirty: boolean; lease?: string; execution: Execution; blocked: boolean;
  uncertain: boolean; restarts: number; retryUsed: boolean; retryPending: boolean; empty: boolean; bytes: number;
  profileRefusal: number; profileReady: boolean; profileRetryUsed: boolean; retired?: boolean;
  sharedUnknown?: boolean; ownedUnknown?: number; resumeProvider?: number;
};
type PiSource = { key: string; storageKey: string; generation?: number; version: number; contentVersion: number;
   language?: string; palette?: number; readyPalette?: number; failure?: PiFailure; projectionRefused?: boolean; refused?: boolean; styleDirectives?: boolean; bytes: number };
type Close = { key: string; ownerKey: string; generation: number; lease: string; provider: number; bytes: number; health?: WeakRef<SourceState> };
type StyleMember = { key: string; id: number; generation: number };
type StyleJob = { expected: SemanticStyleExpectation; captures?: SemanticCaptureGroup; refs: readonly ContextRef[];
  members: readonly StyleMember[]; group?: WeakRef<SourceWorkGroup>; groupRevision?: number; node: WeakRef<WorkNode>; epoch: number; revision: number; demandRevision: number; outcome: StyleAttempt; decodedBytes: number };
type StyleCache = { revision: number; roles?: StyleRoles; origins?: Uint8Array; charge: DataCharge };
type Job = { id: number; provider: number; generation?: number; key?: string; stateId?: number; ticket: string; pendingRetire?: true;
  abort: AbortController; bytes: number; description: Description; reserved: boolean; replySize: ReplySize;
  source?: { capture: Readonly<{ version: number; text: string }>; expected: ExpectedSource; replaceUnits: number; open: boolean; decodedBytes: number };
  style?: StyleJob; styleCharge?: DataCharge; close?: Close; sourceWork?: boolean; kind?: 'shared' | 'owned'; stopped?: boolean; interrupted?: boolean; lifetimeRef?: WeakRef<Job> };
type WorkCompletion = { promise: Promise<boolean>; resolve(value: boolean): void };
function workCompletion(): WorkCompletion {
  let resolve!: WorkCompletion['resolve'];
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
const workSettled = Promise.resolve(true), workCancelled = Promise.resolve(false);
type Lifetime = { bytes: number; owner: WeakRef<SourceController>; jobs: Set<WeakRef<Job>>; charges: Set<DataCharge>; groups: Set<GroupHold>; data?: SemanticRetentionPool; completion?: WorkCompletion };
let nextController = 0;
const ignored = () => {};
// A signal can outlive its owner; a receiver-created abort stack retains it.
const sourceRetired = new Error('occipital source retired');
// Credit survives owner GC and abort, until actual terminal settlement. Module
// incarnation only: parent reload/provider cleanup remains an integration gate.
const flight = { jobs: 0, bytes: 0, bookkeepingBytes: 0 };
const waiters = new Set<WeakRef<SourceController>>();
const lifetimes = new FinalizationRegistry<Lifetime>(lifetime => {
  lifetime.completion?.resolve(false); lifetime.completion = undefined;
  flight.bookkeepingBytes -= lifetime.bytes; lifetime.bytes = 0; waiters.delete(lifetime.owner);
  // At most the already reserved physical jobs. Dead owners need no reply
  // validation; keep physical credit until settlement, not their source payload.
  for (const reference of lifetime.jobs) { const job = reference.deref(); if (job) { job.source = undefined; releaseStyle(job); job.abort.abort(sourceRetired); } }
  lifetime.jobs.clear();
  for (const hold of lifetime.groups) { hold.pin.release(); hold.charge.release(); } lifetime.groups.clear();
  for (const charge of lifetime.charges) charge.release(); lifetime.charges.clear();
  const data = lifetime.data; lifetime.data = undefined;
  data?.dispose();
});
function releaseStyle(job: Job): void {
  const style = job.style; job.style = undefined; style?.captures?.release();
}
function releaseStyleRequest(job: Job): void {
  releaseStyle(job); job.styleCharge?.release(); job.styleCharge = undefined;
}
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
  return { reply: (value: unknown) => { try { owner.deref()?.settle(job, value, false); } finally { releaseStyleRequest(job); releaseCredit(job); } },
    failed: (_error: unknown) => { try { owner.deref()?.settle(job, _error, true); } finally { releaseStyleRequest(job); releaseCredit(job); } } };
}
function continuation(owner: WeakRef<SourceController>) { return () => owner.deref()?.continueWork(); }
function geometryGrant(owner: WeakRef<SourceController>, group?: WeakRef<SourceWorkGroup>, id?: number) {
  return (bytes: number) => owner.deref()?.grantGeometry(bytes, group?.deref(), id);
}
function preparationTurn(owner: WeakRef<SourceController>) { return () => owner.deref()?.resumePreparation(); }
function notice(owner: WeakRef<SourceController>, epoch: number) { return () => owner.deref()?.notifyChange(epoch); }
function displayVisit(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (text: string, read: DisplayRangeReader) => void) => owner.deref()?.visitDisplayBasis(key, id, generation, version, stamp, consume) ?? false;
}
function displayRanges(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number): DisplayRangeReader {
  return consume => owner.deref()?.visitDisplayRanges(key, id, generation, version, stamp, consume) ?? false;
}
function displayRole(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (role: CardRole) => owner.deref()?.readDisplayRole(key, id, generation, version, stamp, role);
}
function displayStyles(owner: WeakRef<SourceController>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitDisplayStyles(key, id, generation, version, stamp, consume) ?? false;
}
function groupStyles(owner: WeakRef<SourceController>, node: WeakRef<WorkNode>, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitGroupStyles(node, stamp, consume) ?? false;
}
function groupRole(owner: WeakRef<SourceController>, node: WeakRef<WorkNode>, stamp: number) {
  return (role: CardRole) => owner.deref()?.readGroupRole(node, stamp, role);
}
function groupVisit(owner: WeakRef<SourceController>, node: WeakRef<WorkNode>, stamp: number) {
  return (consume: (member: (key: string) => GroupDisplayMember | undefined) => void) => owner.deref()?.visitGroup(node, stamp, consume) ?? false;
}
function groupMember(owner: WeakRef<SourceController>, node: WeakRef<WorkNode>, stamp: number) {
  return (key: string) => owner.deref()?.readGroupMember(node, stamp, key);
}
function groupRanges(owner: WeakRef<SourceController>, node: WeakRef<WorkNode>, stamp: number, key: string): DisplayRangeReader {
  return consume => owner.deref()?.visitGroupRanges(node, stamp, key, consume) ?? false;
}
function piRanges(owner: WeakRef<SourceController>, key: string, version: number, palette: number, revision: number) {
  return (consume: (start: number, end: number, style: number) => void) => owner.deref()?.visitPiRanges(key, version, palette, revision, consume) ?? false;
}
function piStyles(owner: WeakRef<SourceController>, key: string, version: number, palette: number, revision: number) {
  return (consume: (index: number, style: ConcreteStyle) => void) => owner.deref()?.visitPiStyles(key, version, palette, revision, consume) ?? false;
}
function equalInk(a: ConcreteStyle['foreground'], b: ConcreteStyle['foreground']): boolean {
  return a.kind === 'rgb' ? b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b
    : a.kind === 'indexed' ? b.kind === 'indexed' && a.index === b.index : b.kind === 'terminal-default';
}
function equalRoles(a: StyleRoles, b: StyleRoles): boolean {
  return CARD_ROLES.every(role => a[role].attributes === b[role].attributes && equalInk(a[role].foreground, b[role].foreground)
    && equalInk(a[role].background, b[role].background));
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
  private readonly pool: SemanticRetentionPool;
  private readonly options: ControllerOptions;
  private readonly maxTransientBytes: number;
  private readonly maxBookkeepingBytes: number;
  private readonly maxDecodedBytes: number;
  private readonly id = ++nextController;
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
  private scheduled = false;
  private noticeScheduled = false;
  private notifying = false;
  private preparing?: SourceWorkGroup;
  private preparations = 0;
  private groupSequence = 0;
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
  private readonly noticeGroups = new Set<number>();
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
    peakTransientBytes: 0, peakJobs: 0, stylePreparations: 0, styleContextVisits: 0, styleEncodes: 0, styleDispatches: 0, stylePublications: 0, styleRejections: 0 };

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
    this.maxDecodedBytes = Math.min(options.retention?.maxBytes ?? HIGHLIGHT_LIMITS.decodedBytes, HIGHLIGHT_LIMITS.decodedBytes);
    this.provider = provider;
    this.options = { deadlineMs, admission: options.admission, queueWaitMs: options.queueWaitMs, onChange: options.onChange, diagnostic: options.diagnostic };
    this.pool = new SemanticRetentionPool(options.retention);
    this.lifetime.data = this.pool;
    if (!this.charge(128)) throw new Error('controller bookkeeping capacity');
    lifetimes.register(this, this.lifetime, this.lifetime);
  }

  /** Observe admitted queue work and actual notification delivery; never flush or test result correctness. */
  whenSettled(): Promise<boolean> {
    if (this.disposed || this.suspended) return workCancelled;
    if (this.lifetime.completion) return this.lifetime.completion.promise;
    if (!this.workPending()) return workSettled;
    this.lifetime.completion = workCompletion();
    return this.lifetime.completion.promise;
  }
  private workPending(): boolean {
    return this.scheduled || this.yielding || this.pumping || this.notifying || this.noticeScheduled
      || this.jobs.size > 0 || this.closes.length > 0 || waiters.has(this.owner);
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
      this.selection = undefined; this.releaseSelection(); this.styleEpoch++; this.rewind(); this.reconcileWithdrawal(); return true;
    }
    const bytes = selectionBytes(input), reserved = this.pool.reserve(undefined, bytes); this.receipts(reserved.released);
    if (!reserved.accepted) return false;
    const grant = this.pool.budget.reserve(bytes); if (!grant) return false;
    try {
      const next = prepareSelection(input), charge = grant.consume(bytes), previous = this.selection;
      const replaced = previous && (previous.rules !== next.rules || previous.palette !== next.palette || previous.bindingRevision !== next.bindingRevision);
      this.releaseSelection(); this.selectionCharge = charge; this.lifetime.charges.add(charge); this.selection = next;
      this.styleEpoch++; this.rewind(); this.schedule(); if (replaced) this.reconcileWithdrawal(); return true;
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
    return !this.disposed && (id === undefined || !!group && group.id === id && this.work.has(group) && !!group.preparation.deref());
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
    const group = { id: ++this.groupSequence, preparation: new WeakRef(preparation), keys: preparation.keys };
    this.addWork(group); return group;
  }
  /** Cold, idempotent ordered membership seal after logical preparation.
   * Call explicitly after membership edits outside prepare(); registration alone is not useful demand. */
  updatePreparation(group: SourceWorkGroup): boolean {
    const node = this.work.get(group);
    if (!node || !group.preparation.deref() || !this.enabled || this.disposed) return false;
    if (node.seal && this.sealMatches(group, node.seal)) return true;
    this.dropGroup(node, true);
    node.styleRevision = ++this.styleRevision;
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
    const ready = node.ready; node.ready = undefined;
    if (ready) { this.lifetime.groups.delete(ready); ready.pin.release(); ready.charge.release();
      if ('preparation' in node.value) this.changedGroup(node.value.id);
    }
    if (seal && node.seal) { this.lifetime.charges.delete(node.seal.charge); node.seal.charge.release(); node.seal = undefined; }
  }
  groupPresentation(group: SourceWorkGroup): GroupDisplayBasis | undefined {
    const node = this.work.get(group), ready = node?.ready;
    if (!node || !ready || !this.groupCurrent(node, ready.stamp)) return undefined;
    const weak = new WeakRef(node);
    return { stamp: ready.stamp, paintStamp: ready.paintStamp, profile: ready.profile, fingerprint: ready.fingerprint,
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
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return false;
    const ready = node.ready!, pin = ready.pin.retain(), charge = ready.charge.retain();
    ready.readers++;
    try {
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
      return this.groupCurrent(node, stamp, ready.readers === 1);
    } finally { ready.readers--; pin.release(); charge.release(); }
  }
  visitGroup(weak: WeakRef<WorkNode>, stamp: number, consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean {
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return false;
    const ready = node.ready!, pin = ready.pin.retain(), charge = ready.charge.retain();
    ready.readers++;
    try { consume(groupMember(this.owner, weak, stamp)); return this.groupCurrent(node, stamp, ready.readers === 1); }
    finally { ready.readers--; pin.release(); charge.release(); }
  }
  readGroupMember(weak: WeakRef<WorkNode>, stamp: number, key: string): GroupDisplayMember | undefined {
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return undefined;
    const member = node.ready!.members.get(key);
    return member && this.currentDisplay(key, member.id, member.generation, member.version, member.stamp) ? { key, generation: member.generation, version: member.version, stamp: member.stamp,
      geometryStamp: member.geometryStamp, paintStamp: member.paintStamp, complete: member.complete,
      read: groupRanges(this.owner, weak, stamp, key) } : undefined;
  }
  visitGroupRanges(weak: WeakRef<WorkNode>, stamp: number, key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return false;
    const ready = node.ready!, member = ready.members.get(key); if (!member) return false;
    const pin = ready.pin.retain(), charge = ready.charge.retain();
    ready.readers++;
    try {
      const valid = this.visitDisplayRanges(key, member.id, member.generation, member.version, member.stamp, (from, to, style) => {
        if (this.groupCurrent(node, stamp)) consume(from, to, style);
      });
      return valid && this.groupCurrent(node, stamp, ready.readers === 1);
    } finally { ready.readers--; pin.release(); charge.release(); }
  }
  queuePreparation(group: SourceWorkGroup, local = false): void {
    const node = this.work.get(group);
    if (!node || this.disposed) return;
    node.paused = false; this.setPending(node, local || node.pending === 'local' ? 'local' : 'native'); this.rewind(); this.schedule();
  }
  pausePreparation(group: SourceWorkGroup): void {
    const node = this.work.get(group);
    if (node && !node.paused) {
      node.paused = true; this.setPending(node, false); node.epoch = this.refreshEpoch; this.reconcileWithdrawal();
    }
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
    this.reconcileWithdrawal();
  }

  /** One revision/cursor reset, not a sweep or a second pending queue. */
  refreshPreparations(): void {
    if (this.disposed) return;
    this.refreshEpoch++; this.rewind(); this.schedule();
  }
  private addWork(value: WorkEntry): void {
    const node: WorkNode = { styleRevision: 0, value, pending: false, epoch: this.refreshEpoch, seen: -1, older: this.newest };
    if (this.newest) this.newest.newer = node;
    this.newest = node; this.work.set(value, node); this.rewind();
  }
  private rewind(): void { this.workPass++; this.cursor = this.newest; }
  private setPending(node: WorkNode, pending: WorkNode['pending']): void {
    if (node.pending === 'local') this.localPending--;
    node.pending = pending;
    if (pending === 'local') this.localPending++;
  }
  private removeWork(value: WorkEntry, deferred = false): boolean {
    const node = this.work.get(value); if (!node) return false;
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' });
    this.setPending(node, false); this.dropGroup(node, true);
    for (const job of this.jobs.values()) if (job.style?.node.deref() === node) { releaseStyle(job); this.cancelJob(job, deferred); }
    if (node.older) node.older.newer = node.newer;
    if (node.newer) node.newer.older = node.older;
    else this.newest = node.older;
    if (this.cursor === node) this.cursor = node.older;
    node.older = undefined; node.newer = undefined;
    return this.work.delete(value);
  }

  observe(demand: SourceDemand): boolean {
    if (!this.enabled || this.disposed) return false;
    const state = this.states.get(demand.key), queued = state?.dirty, generation = state?.generation;
    const accepted = this.observeDemand(demand);
    if (state && (queued && !state.dirty || generation !== undefined && state.generation !== generation)) this.reconcileWithdrawal();
    return accepted;
  }
  private observeDemand(demand: SourceDemand): boolean {
    const { key, version, text, path, profile, fingerprint, complete, neutral = 'code' } = demand;
    const language = demand.language === '' ? undefined : demand.language;
    if (!identifier(key) || language !== undefined && !identifier(language, 128) || path !== undefined && !identifier(path, 4096)
      || !identifier(profile) || !/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isInteger(version) || version < 0 || version > 0xffffffff
      || typeof text !== 'string' || text.length > RETENTION_LIMITS.maxSourceUnits || typeof complete !== 'boolean'
      || neutral !== 'title' && neutral !== 'code') throw new Error('invalid source demand');
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
    if (state && state.neutral !== neutral) {
      state.neutral = neutral;
      // Only client materialization depends on this role. Native refusal/coverage
      // remains the same demand; a later client selection renews its own epoch.
      if (this.selection?.input.kind === 'client') {
        this.invalidateStyles(state, true); this.rewind(); this.schedule();
      }
    }
    // Caller versions identify logical text. Warm visits do not even perform a
    // prefix check or cached-source byte measurement; same-version text mutation
    // violates the caller contract (strings cannot themselves mutate).
    if (state && !state.profileReady && version === state.version && complete === state.complete && language === state.language && path === state.path
      && profile === state.profile && fingerprint === state.fingerprint && provider === (state.refusedProvider ?? state.provider) && !state.retryPending) return state.generation !== undefined;
    if (state) {
      const bytes = stateBytes(demand);
      if (!this.charge(bytes - state.bytes)) {
        const changed = version !== state.version || complete !== state.complete || state.empty !== !text.length
          || !state.blocked || state.generation !== undefined || state.previous !== undefined;
        if (changed) this.dropData(state);
        state.version = version; state.contentVersion = version; state.complete = complete; state.empty = !text.length;
        state.blocked = true; state.dirty = false; state.styleDirty = false;
        // An unfunded identity cannot be memoized. Retry its small bookkeeping
        // admission before any source scan, without repeatedly retiring old work.
        state.retryPending = true; state.profileReady = false;
        if (changed) this.changed(key);
        return false;
      }
      state.bytes = bytes;
    }
    const description = this.provider.snapshot().description;
    const fits = sourceFits(text, Math.min(HIGHLIGHT_LIMITS.sourceBytes, description?.limits.source_bytes ?? HIGHLIGHT_LIMITS.sourceBytes));
    if (!state) {
      const bytes = stateBytes(demand); if (!this.charge(bytes)) return false;
      state = { id: ++this.stateSequence, key, version, contentVersion: version, language, path, profile, fingerprint, complete, provider, neutral,
        dirty: false, styleDirty: true, committedUnits: 0, displayStamp: 0, execution: 'not_started', blocked: false, uncertain: false,
         restarts: 0, retryUsed: false, retryPending: false, empty: !text.length, bytes,
         profileRefusal: 0, profileReady: false, profileRetryUsed: false };
      if (this.preparing?.keys.has(key)) state.group = this.preparing;
      this.states.set(key, state);
      if (!state.group) this.addWork(state);
      if (!fits) { state.blocked = true; state.styleDirty = false; state.refusedProvider = provider; return false; }
      return this.admit(state, text);
    }
    if (!fits) {
      this.dropData(state);
      state.version = version; state.contentVersion = version; state.complete = complete; state.empty = !text.length;
      state.language = language; state.path = path; state.profile = profile; state.fingerprint = fingerprint;
      // Current refusal identity is separate from the provider that must still
      // settle earlier source work. Its scalar fits the fixed entry allowance.
      state.refusedProvider = provider;
      state.blocked = true; state.dirty = false; state.styleDirty = false;
      state.retryPending = false; state.profileReady = false; state.profileRefusal = 0;
      // Retiring payload is not proof that an earlier physical operation never ran.
      this.changed(key); return false;
    }
    state.refusedProvider = undefined;
    if (!state.group) this.rewind();
    const latest = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    const providerChange = state.provider !== provider;
    const identityChange = language !== state.language || path !== state.path;
    const styleChange = profile !== state.profile || fingerprint !== state.fingerprint;
    state.profile = profile; state.fingerprint = fingerprint; state.styleDirty ||= styleChange;
    const latestComplete = state.complete;
    const formationChange = state.complete && !complete;
    // Local empty paint is not a native checkpoint. Start a fresh semantic
    // generation before real parsing instead of borrowing its local revision.
    const localEmptyCoverage = latest?.text.length === 0 && text.length > 0
      && this.pool.status(state.generation!)?.sourceVersion !== undefined;
    const rewrite = !!latest && (!text.startsWith(latest.text) || !text.length && latest.text.length > 0
      || localEmptyCoverage || state.complete && text !== latest.text);
    const retry = state.retryPending, retryProfile = state.profileReady;
    state.retryPending = false; state.profileReady = false;
    const changed = version !== state.version || complete !== state.complete || identityChange || providerChange;
    const noOp = !retry && latest?.text === text && state.complete === complete && !identityChange && !providerChange;
    state.styleDirty ||= retryProfile;
    if (state.displayVersion !== undefined) {
      const displayedText = latest ?? (state.previous === undefined ? undefined : this.pool.borrowSnapshot(state.previous, 'basis'));
      state.displayVersion = complete && state.displayVersion === state.version && displayedText?.text === text ? version : undefined;
    }
    if (latest?.text !== text || identityChange || formationChange) state.contentVersion = version;
    state.version = version; state.complete = complete; state.empty = !text.length;
    if (changed) { state.retryUsed = false; state.profileRetryUsed = false; }
    if (identityChange || providerChange || retryProfile) state.profileRefusal = 0;
    if (retryProfile) state.profileRetryUsed = true;
    if (identityChange || formationChange || rewrite) {
      const themeOnly = language === state.language && path === state.path && !formationChange && !rewrite;
      if (themeOnly || !identityChange && state.language === 'bash' && state.generation !== undefined) {
        state.profile = profile; state.fingerprint = fingerprint;
        state.blocked = state.uncertain && !providerChange;
        const profileOnly = themeOnly && !providerChange && latest?.text === text && state.complete === latestComplete;
        this.restart(state, provider, providerChange, { version, text }, !profileOnly);
        return state.generation !== undefined;
      }
      this.dropData(state); state.language = language; state.path = path; state.profile = profile; state.fingerprint = fingerprint;
      state.blocked = state.uncertain && !providerChange; state.provider = provider;
      if (providerChange) { state.uncertain = false; state.restarts = 0; }
      if (!state.uncertain) state.execution = 'not_started';
      return this.admit(state, text);
    }
    if (!latest) {
      if (providerChange) { state.uncertain = false; state.restarts = 0; }
      state.provider = provider; state.blocked = state.uncertain || state.restarts > CONTROLLER_LIMITS.restarts;
      if (!state.uncertain) state.execution = 'not_started';
      return state.uncertain ? false : this.admit(state, text);
    }
    const result = this.pool.replaceSnapshot(state.generation!, version, text); this.receipts(result.released);
    if (!result.accepted || state.generation === undefined) return false;
    if (providerChange) this.restart(state, provider, providerChange);
    else {
      state.blocked = state.uncertain || state.restarts > CONTROLLER_LIMITS.restarts;
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
    const display = this.pool.displayStatus(generation);
    if (!display) return undefined;
    const version = display.sourceVersion;
    return { generation, version, stamp: state.displayStamp, language: state.language,
      profile: state.displayProfile!, fingerprint: state.displayFingerprint!,
      complete: display.complete, exactVersion: state.displayVersion, geometryStamp: display.geometryStamp, paintStamp: display.effectStamp,
      role: displayRole(this.owner, key, state.id, generation, version, state.displayStamp),
      visitStyles: displayStyles(this.owner, key, state.id, generation, version, state.displayStamp),
      visit: displayVisit(this.owner, key, state.id, generation, version, state.displayStamp) };
  }
  displayStamp(key: string, profile?: string, fingerprint?: string, language?: string): number {
    const state = this.states.get(key);
    return !this.disposed && this.enabled && state && (profile === undefined || state.displayProfile === profile && state.displayFingerprint === fingerprint && state.language === language)
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
    if (!sourceFits(text, HIGHLIGHT_LIMITS.piSourceBytes)) return this.refusePiSource(state, version);
    if (!state) {
      const storageKey = this.wireKey(), bytes = RETENTION_LIMITS.entryAllowance + 2*(key.length + storageKey.length + (language?.length ?? 0));
      if (!this.charge(bytes)) return false;
      state = { key, storageKey, version, contentVersion: version, language, bytes };
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
    state.version = version; state.contentVersion = version; state.language = language; state.palette = undefined; state.readyPalette = undefined; state.failure = undefined; state.projectionRefused = false; state.refused = false;
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
  /** Storage identity only. The caller must independently check workStatus. */
  piPreparation(key: string, generation: number, version: number, palette: number): PiPreparation | undefined {
    if (!Number.isSafeInteger(palette) || palette < 0) throw new Error('invalid Pi palette revision');
    const state = this.piSources.get(key);
    if (this.disposed || !state || state.generation !== generation || state.version !== version
      || state.palette !== undefined && palette < state.palette || state.palette === palette && (state.failure !== undefined || state.projectionRefused)) return undefined;
    const released: ReleaseReceipt[] = [];
    let result: ReturnType<SemanticRetentionPool['piPreparation']>;
    try { result = this.pool.piPreparation(generation, version, palette, released); }
    finally { this.receipts(released); }
    if (!result.accepted) { this.recordPiRefusal(state, palette); return undefined; }
    state.palette = palette; state.failure = undefined; state.projectionRefused = false;
    return result.ticket;
  }
  private acceptsPiPreparation(ticket: PiPreparation): boolean {
    if (this.disposed || !this.pool.acceptsPiPreparation(ticket)) return false;
    const state = this.piGenerations.get(ticket.generation);
    return !!state && state.version === ticket.version && state.palette === ticket.palette && !state.failure && !state.projectionRefused;
  }
  reservePiData(ticket: PiPreparation, additionalPeak: number): DataGrant | undefined {
    if (!this.acceptsPiPreparation(ticket)) return undefined;
    const result = this.pool.reserve(ticket.generation, additionalPeak); this.receipts(result.released);
    if (!result.accepted || !this.acceptsPiPreparation(ticket)) {
      if (this.acceptsPiPreparation(ticket)) this.recordPiRefusal(this.piGenerations.get(ticket.generation)!, ticket.palette);
      return undefined;
    }
    const grant = this.pool.budget.reserve(additionalPeak);
    if (!grant) this.recordPiRefusal(this.piGenerations.get(ticket.generation)!, ticket.palette);
    return grant;
  }
  /** Ownership is consumed even for stale/foreign tickets and invalid candidates. */
  adoptPiFlat(ticket: PiPreparation, text: string, staged: StagedPiProjection, styleDirectives?: boolean): boolean {
    if (!this.acceptsPiPreparation(ticket)) { staged.dispose(); return false; }
    const released: ReleaseReceipt[] = [];
    let result: ReturnType<SemanticRetentionPool['adoptPiFlat']>;
    try { result = this.pool.adoptPiFlat(ticket, text, staged, released); }
    finally { this.receipts(released); }
    const state = this.piGenerations.get(ticket.generation);
    if (!state || state.version !== ticket.version || state.palette !== ticket.palette) return false;
    if (!result.accepted) { if (result.refused) this.recordPiRefusal(state, ticket.palette); return false; }
    state.readyPalette = ticket.palette; state.failure = undefined; state.projectionRefused = false; state.styleDirectives = styleDirectives;
    reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: state, operation: 'pi' });
    this.changed(state.key); return true;
  }
  private recordPiRefusal(state: PiSource, palette: number): void {
    state.palette = palette; state.failure = undefined; state.projectionRefused = true;
  }
  piRefusal(key: string, version: number, palette: number): boolean {
    const state = this.piSources.get(key);
    return !this.disposed && state?.version === version && state.palette === palette && state.projectionRefused === true;
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
    if (state.palette === palette && state.projectionRefused || this.piProjectionStatus(key, version, palette)) return false;
    const changed = state.palette !== palette || state.failure !== failure;
    state.palette = palette; state.failure = failure; state.projectionRefused = false;
    if (changed) {
      this.log('ERROR', 'Pi fallback classification failed; exact failure cached', { source: key, version, generation, palette, reason: failure });
      reportRuntime(this.options.diagnostic, { kind: 'failure', scope: state, operation: 'pi', area: 'syntax', code: failure });
    }
    return true;
  }
  piProjection(key: string, version: number, palette: number): PiProjectionReader | undefined {
    const status = this.piProjectionStatus(key, version, palette); if (!status) return undefined;
    return Object.freeze({ ...status, version, palette,
      visitRanges: piRanges(this.owner, key, version, palette, status.revision),
      visitStyles: piStyles(this.owner, key, version, palette, status.revision) });
  }
  private piProjectionStatus(key: string, version: number, palette: number) {
    const state = this.piSources.get(key), generation = state?.generation;
    if (this.disposed || !state || generation === undefined || state.version !== version || state.readyPalette !== palette) return undefined;
    const status = this.pool.piProjectionStatus(generation);
    return status && status.version >= state.contentVersion && status.version <= version ? { ...status, generation } : undefined;
  }
  visitPiRanges(key: string, version: number, palette: number, revision: number, consume: (start: number, end: number, style: number) => void): boolean {
    const generation = this.piProjectionStatus(key, version, palette)?.generation;
    if (generation === undefined || this.piProjectionStatus(key, version, palette)?.revision !== revision) return false;
    const available = this.pool.visitPiRanges(generation, revision, (start, end, style) => {
      if (this.piProjectionStatus(key, version, palette)?.revision === revision) consume(start, end, style);
    });
    return available && this.piProjectionStatus(key, version, palette)?.revision === revision;
  }
  visitPiStyles(key: string, version: number, palette: number, revision: number, consume: (index: number, style: ConcreteStyle) => void): boolean {
    const generation = this.piProjectionStatus(key, version, palette)?.generation;
    if (generation === undefined || this.piProjectionStatus(key, version, palette)?.revision !== revision) return false;
    const available = this.pool.visitPiStyles(generation, revision, (index, style) => {
      if (this.piProjectionStatus(key, version, palette)?.revision === revision) consume(index, style);
    });
    return available && this.piProjectionStatus(key, version, palette)?.revision === revision;
  }
  private refusePiSource(state: PiSource | undefined, version: number): false {
    if (state) {
      state.version = version; state.contentVersion = version; state.palette = undefined; state.readyPalette = undefined; state.failure = undefined; state.projectionRefused = false; state.refused = true;
      if (state.generation !== undefined) this.receipts(this.pool.remove(state.generation));
    }
    return false;
  }
  removePiSource(key: string): void {
    const state = this.piSources.get(key); if (!state) return;
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' });
    this.piSources.delete(key); this.charge(-state.bytes);
    if (state.generation !== undefined) this.receipts(this.pool.remove(state.generation));
  }

  suspend(): void { if (!this.disposed) { this.suspended = true; this.completeWork(true); } }
  /** Exact generation deliberately retired by the broker, not a generic abort/timeout. */
  interruptProvider(provider: number): void {
    if (!this.suspended || this.disposed) return;
    for (const job of this.jobs.values()) if (job.provider === provider) {
      job.interrupted = true;
      const state = job.key === undefined ? undefined : this.states.get(job.key);
      if (job.sourceWork && state && state.id === job.stateId && !state.retired && !state.uncertain) state.resumeProvider = provider;
    }
    for (const state of this.states.values()) if (state.provider === provider && state.dirty && !state.blocked && !state.uncertain && !state.retired)
      state.resumeProvider = provider;
  }
  resume(): void {
    if (!this.suspended || this.disposed) return;
    this.suspended = false; this.refreshPreparations(); this.rewind(); this.schedule();
  }

  flush(): void {
    if (this.suspended) { this.scheduled = false; return; }
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
        const withdrewProvider = this.workReady && this.enabled && !description;
        this.workProvider = snapshot.generation; this.workReady = ready; this.rewind();
        if (withdrewProvider) this.reconcileWithdrawal();
      }
      const jobLimit = description ? Math.min(CONTROLLER_LIMITS.jobs, description.limits.data_per_route) : 0;
      if (description) while (this.closes.length && this.jobs.size < jobLimit) {
        const index = this.closes.findIndex(close => !this.sourceBusy(close.ownerKey)); if (index === -1) break;
        const bytes = this.reservation(0, 0, 0, 0, description);
        if (!this.capacity(bytes)) { waitForCredit(this.owner); break; }
        const close = this.closes.splice(index, 1)[0]!; this.charge(-close.bytes);
        const job = this.job(close.ownerKey, close.generation, 0, snapshot.generation, description, bytes); job.close = close;
        this.dispatch(job, { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'stream.close',
          key: close.key, generation: close.generation, lease: close.lease });
      }
      const full = () => this.creditBlocked || this.jobs.size >= jobLimit || flight.jobs >= CONTROLLER_LIMITS.jobs;
      const dispatch = (state: SourceState | undefined): boolean => {
        if (!description || !this.enabled || this.disposed || !state || state.retired || state.uncertain || this.sourceBusy(state.key)) return false;
        if (state.resumeProvider !== undefined && state.resumeProvider !== snapshot.generation) {
          state.resumeProvider = undefined;
          if (state.provider !== snapshot.generation) this.restart(state, snapshot.generation, true);
          else state.dirty = !state.empty;
        }
        if (!state.dirty || state.blocked || state.provider !== snapshot.generation) return false;
        if (state.complete && state.parsedProvider !== state.provider && state.generation !== undefined) {
          const data = this.pool.status(state.generation);
          if (data?.complete && this.matchesContent(state, data.sourceVersion)) {
            if (description.assets === state.parsedAssets && description.vocabulary.fingerprint === data.vocabulary) {
              state.dirty = false; return false;
            }
            this.restart(state, state.provider, true);
          }
        }
        if (full()) { waitForCredit(this.owner); return true; }
        return this.prepare(state, description) === 'credit';
      };
      while (this.cursor && !this.disposed) {
        if (this.preparations >= CONTROLLER_LIMITS.jobs) break;
        const node = this.cursor, entry = node.value, pass = this.workPass;
        // Reuse the registry's host-turn quota even when credits are full: local
        // cache probes may continue, but a preview cannot sweep busy history.
        if (this.selection) this.preparations++;
        this.cursor = node.older; node.seen = pass;
        if (!('preparation' in entry)) {
          this.prepareStyles(node, description, full());
          if (dispatch(entry)) {
            this.retryScan = true; if (this.localPending || this.selection) continue;
            this.cursor = node; break;
          }
          continue;
        }
        const preparation = entry.preparation.deref();
        if (!preparation) { this.releasePreparation(entry, true); continue; }
        if (node.paused) continue;
        this.prepareStyles(node, description, full());
        const refresh = node.epoch !== this.refreshEpoch;
        if (node.pending || refresh && (preparation.needsRefresh?.(node === this.newest) ?? true)) {
          const native = !!description && this.enabled && node.pending !== 'local' && (preparation.requiresCredit?.() ?? true);
          if (native && full()) {
            waitForCredit(this.owner);
            this.retryScan = true; if (this.localPending || this.selection) continue;
            this.cursor = node; break;
          }
          // A busy source may be skipped while a different owner uses the free slot.
          // Its actual settlement rewinds this visited entry if it still owes work.
          if (native && [...entry.keys].some(key => this.sourceBusy(key))) continue;
          if (!this.selection && this.preparations >= CONTROLLER_LIMITS.jobs) { this.cursor = node; break; }
          this.setPending(node, false); node.epoch = this.refreshEpoch; if (!this.selection) this.preparations++;
          this.preparing = entry;
          try { preparation.prepare(); this.updatePreparation(entry); } finally { this.preparing = undefined; }
        } else node.epoch = this.refreshEpoch;
        if (!this.work.has(entry) || pass !== this.workPass || node.pending || node.epoch !== this.refreshEpoch) continue;
        this.prepareStyles(node, description, full());
        let waiting = false;
        for (const key of entry.keys) if (dispatch(this.states.get(key))) { waiting = true; break; }
        if (waiting) {
          this.retryScan = true; if (this.localPending || this.selection) continue;
          this.cursor = node; break;
        }
      }
    } finally {
      this.pumping = false;
      if (this.preparations && !this.yielding) {
        this.yielding = true; this.scheduled = true;
        setImmediate(preparationTurn(this.owner));
      }
      this.finishLifetime(); this.completeWork();
    }
  }
  /** Reset only after a host turn; neither direct flush nor reply microtasks may
   * bypass the two-preparation barrier. An empty continuation stops immediately. */
  resumePreparation(): void {
    this.preparations = 0; this.yielding = false; this.scheduled = false; this.continueWork();
  }

  /** Physical source authority survives payload retirement/off. Reading never
   * admits storage or dispatches work; absence alone is only fresh-key no-start. */
  workStatus(key: string): SourceWorkStatus {
    const state = this.states.get(key);
    const pending = [...this.jobs.values()].some(job => job.sourceWork && !job.stopped && job.key === key);
    const ready = !!state && this.enabled && !state.retired && this.provider.isReady(state.provider);
    const queued = ready && (state.dirty && !state.blocked && !state.uncertain
      || state.styleDirty && !state.profileRefusal && state.generation !== undefined
        && this.pool.status(state.generation)?.sourceVersion !== undefined);
    const execution = pending ? 'unsettled' : state?.sharedUnknown || state?.ownedUnknown !== undefined
      ? state?.execution === 'started' ? 'started' : 'unknown' : state?.execution ?? 'not_started';
    return { version: state?.version, execution, fallbackEligible: !this.disposed && (state?.resumeProvider === undefined || this.provider.snapshot().availability === 'unavailable') && !state?.frozen && !pending && !queued && !state?.uncertain
        && (execution === 'not_started' || execution === 'acknowledged'),
      profileRetryAllowed: !!state && !state.retired && this.enabled && !this.disposed && state.profileReady
        && this.provider.isReady(state.provider) };
  }
  /** Only the broker's successful owned-child close/reap receipt may call this.
   * Generation matching never releases replacement/peer source authority. */
  ownedStopped(provider: number): void {
    for (const job of this.jobs.values()) if (job.provider === provider && job.sourceWork && job.kind === 'owned') {
      job.stopped = true; job.source = undefined;
      if (job.key !== undefined && this.states.get(job.key)?.id === job.stateId) this.changed(job.key);
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
      acknowledgedVersion: provider.generation === state.parsedProvider && provider.availability === 'ready' ? current?.sourceVersion : undefined,
      classificationVersion: state.empty ? undefined : result?.sourceVersion, committedBytes: result?.committedBytes ?? 0, exact,
      execution, availability: this.disposed ? 'disposed' : !this.enabled ? 'disabled' : provider.availability,
      protective: state.blocked || state.uncertain, fallbackEligible: !exact && this.workStatus(key).fallbackEligible, complete: state.complete };
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
  stats() { return { ...this.counters, styleCaptures: [...this.jobs.values()].filter(job => job.style).length, unsettledJobs: this.jobs.size, captures: [...this.jobs.values()].filter(job => job.source).length,
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
    const current = state.generation, previous = state.previous;
    const generation = this.displayGeneration(state) ?? (current !== undefined && this.pool.status(current)?.sourceVersion !== undefined ? current : undefined);
    this.retire(state, true, false);
    state.generation = undefined; state.previous = generation; state.previousCoverage = false;
    state.frozen = true; state.retired = true; state.dirty = false; state.profileReady = false; state.profileRefusal = 0;
    if (current !== undefined && current !== generation) this.receipts(this.pool.remove(current));
    if (previous !== undefined && previous !== generation) this.receipts(this.pool.remove(previous));
    if (generation !== undefined) this.pool.retainBasis(generation);
    else state.displayStamp = 0;
    this.changed(key); this.reconcileWithdrawal(); this.schedule();
  }
  remove(key: string): void {
    const current = this.states.has(key);
    this.drainRetirements(); this.removeSource(key, false);
    if (current) this.reconcileWithdrawal();
  }
  private removeSource(key: string, deferred: boolean): void {
    this.removePiSource(key);
    this.noticeKeys.delete(key);
    const state = this.states.get(key); if (!state) return;
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' });
    this.dropData(state, deferred); this.states.delete(key); this.removeWork(state, deferred); this.charge(-state.bytes);
    if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node, true); }
    if (!this.states.size && ![...this.work.values()].some(node => node.seal)) this.clearStyleCache();
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    if (!enabled) { this.completeWork(true); this.drainRetirements(); }
    this.enabled = enabled; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    if (!enabled) { for (const node of this.work.values()) this.dropGroup(node, true);
      for (const job of this.jobs.values()) if (job.style) { releaseStyle(job); job.abort.abort(sourceRetired); }
      this.clearStyleCache(); this.profileNeed = undefined; waiters.delete(this.owner);
      for (const [key, state] of this.states) {
        state.resumeProvider = undefined; this.dropData(state);
        if (state.frozen || this.busy(key) || state.uncertain || state.sharedUnknown || state.ownedUnknown !== undefined) {
          state.retired = true; state.dirty = false; state.profileReady = false; state.profileRefusal = 0;
        } else { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.states.delete(key); this.removeWork(state); this.charge(-state.bytes); }
      }
      for (const key of this.piSources.keys()) this.removePiSource(key); this.receipts(this.pool.clear()); this.flush(); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.completeWork(true); this.drainRetirements();
    for (const [entry, node] of this.work) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: node, operation: '*' }); if ('preparation' in entry) { this.dropGroup(node, true); this.charge(-groupBytes); } }
    this.work.clear(); this.newest = undefined; this.cursor = undefined; this.localPending = 0;
    this.setEnabled(false);
    // Pi fallback may have been captured while the native controller was already off.
    for (const key of this.piSources.keys()) this.removePiSource(key);
    this.disposed = true; ++this.noticeEpoch; this.noticeScheduled = false; this.noticeKeys.clear(); this.noticeGroups.clear();
    for (const state of this.states.values()) { reportRuntime(this.options.diagnostic, { kind: 'released', scope: state, operation: '*' }); this.charge(-state.bytes); }
    this.states.clear();
    this.lifetime.data = undefined; this.releaseSelection(); this.selection = undefined; this.clearStyleCache(); this.pool.dispose();
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
  private sourceBusy(key: string): boolean { return [...this.jobs.values()].some(job => (job.sourceWork || job.close) && job.key === key); }
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
    state.generation = result.generation; state.committedUnits = 0; this.invalidateStyles(state);
    state.dirty = !state.empty && !state.blocked; return true;
  }
  private restart(state: SourceState, provider: number, providerChange: boolean, target?: Pick<SourceDemand, 'version' | 'text'>, cancel = true): void {
    const oldGeneration = state.generation, previous = state.previous;
    const latest = target ?? (oldGeneration === undefined ? undefined : this.pool.borrowSnapshot(oldGeneration)); if (!latest) return;
    const uncertain = !!target && state.uncertain && !providerChange, execution = state.execution;
    const blocked = !!target && state.blocked;
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
    // Superseded profiles keep their physical credit until normal settlement.
    this.retire(state, cancel);
    // Detach the obsolete parser basis before admission receipts. Releasing its
    // empty entry must not also release a compatible independently held result.
    state.generation = undefined; state.previous = retained; state.previousCoverage = previousCoverage; state.provider = provider;
    if (retained !== undefined) this.pool.retainBasis(retained);
    if (oldGeneration !== undefined && oldGeneration !== retained && (!reuse || oldGeneration !== covered)) this.receipts(this.pool.remove(oldGeneration));
    if (previous !== undefined && previous !== retained && (!reuse || previous !== covered)) this.receipts(this.pool.remove(previous));
    const result = reuse ? this.pool.replaceSnapshot(covered!, latest.version, latest.text)
      : this.pool.admit(this.wireKey(), latest.version, latest.text);
    this.receipts(result.released);
    if (providerChange) state.restarts = 0;
    state.execution = uncertain ? execution : 'not_started'; state.uncertain = uncertain;
    if (!result.accepted) { state.blocked = true; state.dirty = false; return; }
    state.generation = reuse ? covered : result.generation; state.committedUnits = 0; state.blocked = uncertain || blocked;
    if (reuse) {
      if (state.previous === covered) { state.previous = undefined; state.previousCoverage = false; }
      state.contentVersion = coveredStatus!.sourceVersion!;
      const display = this.pool.displayStatus(this.displayGeneration(state)!);
      state.displayVersion = display?.complete && this.matchesContent(state, display.sourceVersion) ? state.version : undefined;
      // Missing metadata defers compatibility, not ownership of valid annotations.
      state.dirty = !compatible;
      return;
    }
    state.dirty = !state.empty && !state.blocked;
  }
  private retire(state: SourceState, cancel = true, styles = true, deferred = false): void {
    // Freeze retains the exact display view; proofs still require its actual
    // generation/stamp/version, rather than converting current data into proof.
    this.invalidateStyles(state, !styles);
    if (cancel) for (const job of this.jobs.values()) {
      const style = styles && job.style?.members.some(member => member.id === state.id);
      if (!style && (job.style || job.stateId !== state.id)) continue;
      this.cancelJob(job, deferred);
      if (style) releaseStyle(job);
    }
    if (state.lease && state.generation !== undefined) {
      const key = this.pool.status(state.generation)?.key;
      if (key) this.close({ key, ownerKey: state.key, generation: state.generation, lease: state.lease, provider: state.provider, health: new WeakRef(state) });
    }
    state.lease = undefined;
  }
  private dropData(state: SourceState, deferred = false): void {
    if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node); }
    this.retire(state, true, true, deferred);
    const current = state.generation, previous = state.previous; state.generation = undefined; state.previous = undefined;
    state.previousCoverage = false; state.displayStamp = 0; state.displayProfile = undefined; state.displayFingerprint = undefined; state.displayVersion = undefined;
    if (current !== undefined) this.pool.remove(current);
    if (previous !== undefined) this.pool.remove(previous);
  }
  private close(close: Omit<Close, 'bytes'>): void {
    if (!this.provider.isReady(close.provider) || this.closes.some(item => item.lease === close.lease)
      || [...this.jobs.values()].some(job => job.close?.lease === close.lease)) return;
    const bytes = 288 + 2*(close.key.length + close.ownerKey.length + close.lease.length);
    if (!this.charge(bytes)) { this.counters.cleanupRefusals++; return; }
    this.closes.push({ ...close, bytes });
  }
  private receipts(receipts: readonly ReleaseReceipt[], deferred = false): void {
    // Cascaded previous releases complete before the withdrawal wake.
    if (this.releaseReceipts(receipts, deferred)) this.reconcileWithdrawal();
  }
  private releaseReceipts(receipts: readonly ReleaseReceipt[], deferred: boolean): boolean {
    let withdrew = false;
    for (const receipt of receipts) {
      const pi = this.piGenerations.get(receipt.generation);
      if (pi) { this.piGenerations.delete(receipt.generation); pi.generation = undefined; pi.palette = undefined; pi.readyPalette = undefined; this.changed(pi.key); continue; }
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
        if (state.lease) this.close({ key: receipt.key, ownerKey: state.key, generation: receipt.generation, lease: state.lease, provider: state.provider, health: new WeakRef(state) });
        state.lease = undefined; this.retire(state, true, true, deferred); state.generation = undefined; state.blocked = true; state.dirty = false;
        state.displayStamp = 0;
        if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node); }
        this.changed(state.key);
        if (state.previous !== undefined) { const previous = state.previous; state.previous = undefined; this.releaseReceipts(this.pool.remove(previous), deferred); }
        break;
      }
    }
    return withdrew;
  }
  private unknown(job: Job, execution: 'unknown' | 'started'): boolean {
    const state = job.key === undefined ? undefined : this.states.get(job.key);
    if (!this.disposed && !job.stopped && state && state.id === job.stateId) {
      // Terminal unknown has no later successful reply. Shared/unspecified work
      // has no stop receipt; owned work can be released only by its exact reap.
      if (job.kind === 'owned') state.ownedUnknown = job.provider;
      else state.sharedUnknown = true;
      if (state.provider === job.provider) { state.execution = execution; state.uncertain = true; state.dirty = false; }
      return true;
    }
    return false;
  }
  private clearCoverage(state: SourceState): void {
    for (const proof of state.coverage?.values() ?? []) { this.lifetime.charges.delete(proof.charge); proof.charge.release(); }
    state.coverage = undefined;
  }
  private invalidateStyles(state: SourceState, preserveView = false): void {
    if (!preserveView) this.clearCoverage(state);
    const node = this.work.get(state.group ?? state);
    if (node) { node.styleRevision = ++this.styleRevision; node.failedEpoch = undefined; node.failedVocabulary = undefined; node.attempt = undefined; }
  }
  private refuseStyles(node: WorkNode, vocabulary: string, epoch: number, revision: number): void {
    if (this.work.get(node.value) !== node || this.styleEpoch !== epoch || node.styleRevision !== revision) return;
    node.failedEpoch = epoch; node.failedRevision = revision; node.failedVocabulary = vocabulary;
    node.failedCacheRevision = this.styleCache.get(this.styleKey(vocabulary, this.selection!.rules))?.revision ?? 0;
  }
  private styleHealthOwner(style: StyleJob, provider: number): WorkNode | undefined {
    const node = style.node.deref();
    return node && this.work.get(node.value) === node && this.styleEpoch === style.epoch
      && node.styleRevision === style.revision && this.provider.isReady(provider) ? node : undefined;
  }
  private refuseStyleJob(style: StyleJob): void {
    style.outcome.failed = true;
    const node = style.node.deref();
    if (node) this.refuseStyles(node, style.expected.vocabulary, style.epoch, style.revision);
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
    if (!selection || !this.enabled || this.disposed) return;
    // No descriptor enumeration/encoding for an uncached choice at full credits.
    const members = this.styleMembers(node); if (!members) return;
    const first = members[0], firstState = first && this.states.get(first.key)!;
    const sourceVocabulary = (first && firstState?.frozen ? this.pool.displayStatus(first.generation)?.vocabulary : undefined)
      ?? (first && this.pool.status(first.generation)?.vocabulary) ?? description?.vocabulary.fingerprint;
    if (!sourceVocabulary && (members.length || selection.input.kind === 'native')) return;
    const vocabulary = sourceVocabulary ?? '';
    const cache = this.styleCache.get(this.styleKey(vocabulary, selection.rules));
    const epoch = this.styleEpoch, revision = node.styleRevision;
    const attempt = node.attempt;
    if (attempt?.outcome.failed && attempt.epoch === epoch && attempt.revision === revision && attempt.vocabulary === vocabulary) {
      this.refuseStyles(node, vocabulary, epoch, revision); node.attempt = undefined;
    }
    const failed = node.failedEpoch === epoch && node.failedRevision === revision && node.failedVocabulary === vocabulary;
    if (failed && node.failedCacheRevision === (cache?.revision ?? 0)) return;
    const refuse = () => this.refuseStyles(node, vocabulary, epoch, revision);
    try {
    if ('preparation' in node.value) {
      const accepts = node.value.preparation.deref()?.acceptsProfile;
      const preparation = node.value.preparation.deref();
      if (accepts && preparation && !accepts.call(preparation, selection.input.kind === 'native' ? selection.input.id : 'pi',
        selection.input.kind === 'native' ? selection.input.fingerprint : selection.rules)) return;
    }
    if (full && !(selection.input.kind === 'client' && members.every(member => this.states.get(member.key)?.frozen
      ? this.pool.displayStatus(member.generation)?.sourceBytes === 0 : (this.pool.status(member.generation)?.currentContexts ?? 0) === 0))
      && !(members.every(member => this.hasCoverage(member, vocabulary, selection.rules)) && (selection.input.kind === 'client' || !!cache?.roles))) {
      if (this.canDispatchStyles(description, vocabulary)) { this.retryScan = true; waitForCredit(this.owner); }
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
        && (selection.input.kind === 'native' || state.displayNeutral === state.neutral)
        && (state.frozen || display.semanticStamp === status.semanticStamp && this.matchesContent(state, display.sourceVersion));
    });
    if (current) { for (const member of members) this.states.get(member.key)!.styleDirty = false; return; }
    this.counters.stylePreparations++;
    const count = members.reduce((n, member) => n + (this.pool.status(member.generation)?.currentContexts ?? 0), 0);
    const historical = members.reduce((n, member) => n + (this.states.get(member.key)?.frozen ? this.pool.status(member.generation)?.displayBytes ?? 0 : 0), 0);
    const scratch = 2048 + members.length * 1024 + count * 1024 + historical * 4;
    if (!this.styleReserve(members[0]?.generation, scratch)) { refuse(); return; }
    const grant = this.pool.budget.reserve(scratch); if (!grant) { refuse(); return; }
    let pendingCapture: SemanticCaptureGroup | undefined;
    try {
      const unique = new Set<ContextRef>(), captureSelections: CaptureSelection[] = [];
      const add = (ref: ContextRef) => { this.counters.styleContextVisits++; unique.add(ref); };
      for (const member of members) {
        const state = this.states.get(member.key), display = this.pool.displayStatus(member.generation);
        if (state?.frozen) {
          if (!display) return;
          captureSelections.push({ generation: member.generation, effectStamp: display.effectStamp });
          if (!this.pool.visitDisplayContexts(member.generation, display.effectStamp, add)) return;
        } else {
          captureSelections.push(member.generation);
          if (!this.pool.visitContexts(member.generation, add)) return;
        }
      }
      const refs = [...unique], missing = refs.filter(ref => !this.pool.arena.style(vocabulary, ref, selection.rules));
      const paletteReady = selection.input.kind === 'client' || !!cache?.roles;
      if (!missing.length && paletteReady) { if (!this.publishStyles(members, selection, undefined, node, vocabulary)) refuse(); return; }
      if (failed) { refuse(); return; }
      if (full) {
        if (this.canDispatchStyles(description, vocabulary)) { this.retryScan = true; waitForCredit(this.owner); }
        return;
      }
      const pending = [...this.jobs.values()].filter(job => job.style?.expected.vocabulary === vocabulary && job.style.expected.rules === selection.rules);
      // Jobs, not subscribers, are the sole in-flight overlap index. The next
      // ordinary credit wake revisits other owners through the same registry.
      const overlap = pending.find(job => missing.some(ref => job.style!.refs.includes(ref)) || !missing.length && !paletteReady);
      if (overlap) {
        // A coalesced attempt carries only a primitive refusal receipt, never a
        // subscriber owner, result payload or another scheduling queue.
        const prior = overlap.style!;
        if (prior.epoch === epoch && revision <= prior.demandRevision)
          node.attempt = { outcome: prior.outcome, epoch, revision, vocabulary };
        this.retryScan = true; return;
      }
      if (!this.canDispatchStyles(description, vocabulary)) return;
      let encodedPeak = 0, capturePeak = 0, encodedFits = false;
      this.pool.arena.encode(vocabulary, missing, bytes => { encodedFits = true; encodedPeak = bytes; return false; }, HIGHLIGHT_LIMITS.contextWords);
      if (!encodedFits) { refuse(); this.counters.styleRejections++; return; }
      if (members.length) this.pool.captureDisplays(captureSelections, bytes => { capturePeak = bytes; return false; });
      if (members.length && !capturePeak) { refuse(); return; }
      const decodedBytes = Math.min(this.maxDecodedBytes, 256 * (missing.length + 26) + 4 * missing.length + 258);
      const frameBytes = Math.min(HIGHLIGHT_LIMITS.dataWireBytes, Math.max(description.limits.request_bytes, description.limits.reply_bytes));
      // Complete-table materialization uses every captured context, not merely
      // the requested missing subset; the reply may arrive after parser advance.
      const bytes = 4 * frameBytes + encodedPeak + capturePeak + decodedBytes + scratch + 32768 + 1024 + members.length * 128 + missing.length * 16;
      if (bytes > this.maxTransientBytes) { refuse(); this.counters.styleRejections++; return; }
      if (!this.capacity(bytes)) { this.creditBlocked = true; this.retryScan = true; waitForCredit(this.owner); return; }
      const captured = members.length ? this.pool.captureDisplays(captureSelections, () => true) : undefined;
      if (captured) this.receipts(captured.released);
      if (captured && (!captured.accepted || !captured.group)) { refuse(); return; }
      const captures = captured?.group; pendingCapture = captures;
      const encoded = this.pool.arena.encode(vocabulary, missing, peak => this.styleReserve(members[0]?.generation, peak), HIGHLIGHT_LIMITS.contextWords);
      if (!encoded) { captures?.release(); refuse(); return; }
      this.counters.styleEncodes++;
      const first = members[0], job = this.job(first?.key, first?.generation, first?.id, this.workProvider, description, bytes);
      job.kind = this.provider.snapshot().kind;
      job.style = { expected: expectation(selection, vocabulary), captures, refs: missing, members,
        group: 'preparation' in node.value ? new WeakRef(node.value) : undefined, groupRevision: node.seal?.revision, node: new WeakRef(node), epoch, revision, demandRevision: this.styleRevision, outcome: { failed: false }, decodedBytes };
      pendingCapture = undefined;
      // The transport may hold the canonical client declaration after logical
      // cancellation/owner GC. Its owner-free charge ends at physical settlement.
      job.styleCharge = this.selectionCharge!.retain();
      this.counters.styleDispatches++;
      const admission = this.options.admission ?? 'bounded_queue';
      this.dispatch(job, { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, op: 'styles.resolve', vocabulary, contexts: encoded,
        rules: selection.input.kind === 'native' ? { kind: 'native', id: selection.input.id, fingerprint: selection.input.fingerprint }
          : { kind: 'client', definition: selection.input.definition }, admission,
        ...(admission === 'bounded_queue' ? { queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) } : {}) });
    } finally { pendingCapture?.release(); grant.close(); }
    } catch (error) {
      refuse(); this.counters.styleRejections++;
      this.log(unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Local style preparation refused; source execution authority is unchanged', { code: diagnosticError(error) });
      if (unexpectedDiagnostic(error)) reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
    }
  }
  private publishStyles(members: readonly StyleMember[], selection: PreparedSelection, captures?: SemanticCaptureGroup, node?: WorkNode, vocabularyHint?: string): boolean {
    if (!this.enabled || this.disposed || this.selection !== selection) return false;
    const vocabulary = captures?.captures[0]?.vocabulary ?? (members[0] && this.pool.status(members[0].generation)?.vocabulary) ?? vocabularyHint;
    if (vocabulary === undefined) return false;
    const roles = selection.input.kind === 'client' ? selection.input.roles : this.styleCache.get(this.styleKey(vocabulary, selection.rules))?.roles;
    if (!roles) return false;
    const grouped = node && 'preparation' in node.value ? node : undefined;
    if (grouped && (!grouped.seal || !('preparation' in grouped.value) || !this.sealMatches(grouped.value, grouped.seal)
      || grouped.seal.members.length !== members.length || members.some((member, i) => member.key !== grouped.seal!.members[i]!.key || member.id !== grouped.seal!.members[i]!.id))) return false;
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
      const fingerprint = selection.input.kind === 'native' ? selection.input.fingerprint : selection.rules;
      if (updates[i]!.bindingChanged || state.displayEffect !== effect || state.displayProfile !== (selection.input.kind === 'native' ? selection.input.id : 'pi') || state.displayFingerprint !== fingerprint) {
        state.displayStamp = ++this.displaySequence; state.displayEffect = effect; this.changed(state.key);
      }
      state.displayNeutral = state.neutral;
      state.displayProfile = selection.input.kind === 'native' ? selection.input.id : 'pi'; state.displayFingerprint = fingerprint;
      state.displayVersion = display.complete && this.matchesContent(state, display.sourceVersion) ? state.version : undefined;
      state.styleDirty = display.semanticStamp !== this.pool.status(member.generation)?.semanticStamp;
    }
    if (grouped && !this.publishGroup(grouped, members, selection, roles, vocabulary, groupGrant!, readyBytes)) return false;
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
    vocabulary: string, grant: DataGrant, bytes: number): boolean {
    const entry = node.value;
    if (!('preparation' in entry) || !node.seal || !this.sealMatches(entry, node.seal) || !entry.preparation.deref()) return false;
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
    const profile = selection.input.kind === 'native' ? selection.input.id : 'pi', fingerprint = selection.input.kind === 'native' ? selection.input.fingerprint : selection.rules;
    const unchanged = equal && sameStamps && prior!.rules === selection.rules && prior!.palette === selection.palette && prior!.bindingRevision === selection.bindingRevision
      && prior!.profile === profile && prior!.fingerprint === fingerprint;
    if (unchanged) return true;
    const pin = selection.input.kind === 'client' ? this.selectionCharge : this.styleCache.get(this.styleKey(vocabulary, selection.rules))?.charge;
    if (!pin) return false;
    const stamp = ++this.displaySequence;
    const ready: GroupReady = { members: readyMembers, readers: 0, roles, rules: selection.rules, palette: selection.palette, bindingRevision: selection.bindingRevision,
      profile, fingerprint, stamp, paintStamp: equal ? prior!.paintStamp : stamp, pin: pin.retain(), charge: grant.consume(bytes) };
    this.dropGroup(node); node.ready = ready; this.lifetime.groups.add(ready); this.changedGroup(entry.id);
    return true;
  }
  private settleStyles(job: Job, raw: unknown, rejected: boolean): void {
    const style = job.style;
    try {
      if (job.interrupted) return;
      if (!style || rejected || job.abort.signal.aborted || this.disposed) {
        if (style && rejected) {
          this.refuseStyleJob(style);
          const node = this.styleHealthOwner(style, job.provider);
          if (node && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(raw)) {
            this.log('ERROR', 'Native style request failed unexpectedly', { source: job.key, job: job.id, code: diagnosticError(raw) });
            reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(raw) });
          }
        }
        return;
      }
      const decoded = decodeSemanticStyleReply(raw, job.ticket, job.description, style.expected, style.refs.length, style.decodedBytes, job.replySize);
      const reserve = (bytes: number) => this.styleReserve(undefined, bytes);
      if (!this.pool.arena.installStyles(style.expected.vocabulary, style.expected.rules, style.refs, decoded.styles, decoded.indices, reserve)) {
        this.refuseStyleJob(style); return;
      }
      const key = this.styleKey(style.expected.vocabulary, style.expected.rules);
      if (!this.styleCache.has(key)) {
        const bytes = 512 + (decoded.palette ? 26 * 512 : 0);
        if (!reserve(bytes)) { this.refuseStyleJob(style); return; }
        const grant = this.pool.budget.reserve(bytes); if (!grant) { this.refuseStyleJob(style); return; }
        try {
          const cache: StyleCache = { revision: 0, charge: grant.consume(bytes), roles: decoded.palette ? nativeRoles(decoded.styles, decoded.palette.slots) : undefined,
            origins: decoded.palette?.origins.slice() };
          this.styleCache.set(key, cache); this.lifetime.charges.add(cache.charge);
        } finally { grant.close(); }
      }
      this.styleCache.get(key)!.revision++;
      const selected = this.selection;
      const group = style.group?.deref(), node = group && this.work.get(group);
      const current = this.provider.snapshot().description, preparation = group?.preparation.deref();
      if (preparation?.acceptsProfile && selected && !preparation.acceptsProfile(selected.input.kind === 'native' ? selected.input.id : 'pi',
        selected.input.kind === 'native' ? selected.input.fingerprint : selected.rules)) return;
      if (!selected || style.group && (style.epoch !== this.styleEpoch || style.groupRevision !== node?.seal?.revision) || selected.rules !== style.expected.rules || selected.palette !== (style.expected.paletteFingerprint ?? selected.palette)
        || current?.vocabulary.fingerprint !== style.expected.vocabulary || style.group && (!node || node.paused || !preparation)) return;
      if (!this.publishStyles(style.members, selected, style.captures, node, style.expected.vocabulary)) this.refuseStyleJob(style);
      else {
        const owner = style.node.deref();
        if (owner) reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: owner, operation: 'styles' });
      }
    } catch (error) {
      this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Native style reply refused; source execution authority is unchanged', { source: job.key, job: job.id, provider: job.provider, code: diagnosticError(error) });
      const node = style && this.styleHealthOwner(style, job.provider);
      if (node && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
      if (error instanceof RemoteFault && (error.code === 'profile_changed' || error.code === 'profile_unavailable') && this.provider.isReady(job.provider)) {
        this.profileNeed = { generation: job.provider, sequence: ++this.profileSequence };
        const group = style?.group?.deref();
        if (style && group) {
          if (this.work.get(group) === style.node.deref()) this.changedGroup(group.id);
        } else if (style && !style.group) {
          for (const member of style.members) if (this.states.get(member.key)?.id === member.id) this.changed(member.key);
        }
      }
      this.counters.styleRejections++;
      if (style) this.refuseStyleJob(style);
    } finally {
      this.release(job); this.rewind(); this.schedule(); this.finishLifetime();
    }
  }
  private reservation(captureUnits: number, replacementUnits: number, inputUnits: number, replacementBytes: number, d: Description): number {
    return sourceReservation({ captureUnits, replacementUnits, inputUnits, replacementBytes,
      frameBytes: Math.min(HIGHLIGHT_LIMITS.dataWireBytes, Math.max(d.limits.request_bytes, d.limits.reply_bytes)),
       decodedBytes: this.maxDecodedBytes });
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
    if (snapshot.utf8Bytes > Math.min(HIGHLIGHT_LIMITS.sourceBytes, description.limits.source_bytes)) {
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
       revision: status.revision + 1,
      source_bytes: snapshot.utf8Bytes, replace_from: append ? status.committedBytes : 0, complete: state.complete,
      ...(append ? { lease: state.lease! } : {}), replacementText };
    job.sourceWork = true; job.kind = this.provider.snapshot().kind;
    job.source = { capture: { version: snapshot.version, text: snapshot.text }, expected, replaceUnits: from, open,
      decodedBytes: this.maxDecodedBytes };
    const admission = this.options.admission ?? 'bounded_queue';
    const common = { v: PROTOCOL_VERSION, ticket: job.ticket, instance: description.instance, admission,
      ...(admission === 'bounded_queue' ? { queue_wait_ms: Math.min(this.options.queueWaitMs ?? description.limits.queue_wait_ms, description.limits.queue_wait_ms) } : {}) };
    const request = append ? { ...common, op: 'stream.append', key: status.key, generation: state.generation, lease: state.lease,
      base_revision: status.revision, base_bytes: basis.utf8Bytes, source_version: snapshot.version,
       append: snapshot.text.slice(inputFrom), final: state.complete }
      : { ...common, op: state.complete ? 'highlight' : 'stream.open', sources: [{ key: status.key,
         generation: state.generation, source_version: snapshot.version,
        hint: { ...(state.language === undefined ? {} : { language: state.language }), ...(state.path === undefined ? {} : { path: state.path }) }, text: snapshot.text }] };
    // The transport/codec alone checks the actual encoded frame size. No JSON
    // serialization or worst-case-size rejection happens at this boundary.
    if (open) this.remoteLeases++;
    this.counters.preparedBytes += inputBytes; state.dirty = false; state.execution = 'unsettled'; this.dispatch(job, request);
  }
  private job(key: string | undefined, generation: number | undefined, stateId: number | undefined, provider: number, description: Description, bytes: number): Job {
    const id = ++this.sequence;
    const job: Job = { id, key, generation, stateId, provider, ticket: `controller:${this.id}:${id}`, description, bytes, abort: new AbortController(), reserved: true, replySize: {} };
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
    try { dataJsonBytes(request, Math.min(HIGHLIGHT_LIMITS.dataWireBytes, job.description.limits.request_bytes)); }
    catch { observers.failed(Object.assign(new RequestFailure('occipital data request byte limit', 'not_started'), { code: 'frame_limit' })); return; }
    try { void this.provider.request(job.provider, request, { signal: job.abort.signal, deadlineMs: this.options.deadlineMs, acceptRetired: true, replySize: job.replySize })
      .then(observers.reply, observers.failed).catch(ignored); } catch (error) { observers.failed(error); }
  }
  private release(job: Job): void {
    if (this.jobs.delete(job.id)) this.transientBytes -= job.bytes;
    if (job.lifetimeRef) this.lifetime.jobs.delete(job.lifetimeRef);
    job.source = undefined; releaseStyleRequest(job); releaseCredit(job);
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
  continueWork(): void { this.drainRetirements(); this.flush(); }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true; queueMicrotask(continuation(this.owner));
  }
  private reconcileWithdrawal(): void {
    // Credit interest is conservative; normal queue traversal reestablishes only the interest still owed.
    if (waiters.delete(this.owner)) this.wake();
  }
  wake(): void {
    this.creditBlocked = false;
    if (this.retryScan) { this.retryScan = false; this.rewind(); }
    this.schedule();
  }
  private changed(key: string): void {
    if (!this.options.onChange || this.disposed || !this.states.has(key) && !this.piSources.has(key)) return;
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
    if (job.style || !job.source && !job.close && !job.sourceWork) { this.settleStyles(job, raw, rejected); return; }
    if (job.key === undefined || job.generation === undefined || job.stateId === undefined) return;
    const providerCurrent = this.provider.isReady(job.provider), state = this.states.get(job.key);
    const closeOwner = job.close?.health?.deref();
    const healthOwner = job.close ? closeOwner && closeOwner === state ? closeOwner : undefined : state?.id === job.stateId ? state : undefined;
    const healthOperation = job.close ? `lease:${job.close.generation}` : 'source';
    const permission = this.workStatus(job.key);
    let changed = false;
    const useful = this.enabled && !this.disposed && !job.stopped && providerCurrent && !job.abort.signal.aborted
      && state?.id === job.stateId && state.generation === job.generation && !!this.pool.status(job.generation);
    try {
      if (job.interrupted) return;
      if (rejected) {
        if (healthOwner && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(raw))
          reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation: healthOperation, area: 'syntax', code: diagnosticError(raw) });
        this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(raw) ? 'ERROR' : 'WARN', 'Native request rejected; cancellation or rejection is not stop proof', { source: job.key, job: job.id, provider: job.provider,
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
        if (healthOwner) reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: healthOwner, operation: healthOperation });
        this.log('DEBUG', 'Native source lease close acknowledged', { source: job.key, job: job.id, provider: job.provider });
        if (providerCurrent && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
        return;
      }
      if (!job.source || job.stopped) return;
      const source = job.source, chunk = decodeSemanticSourceReply(raw, job.ticket, job.description,
        [source.expected], source.decodedBytes, job.replySize).sources[0]!;
      this.counters.decodedBytes += chunk.source_bytes - chunk.replace_from;
      if (!useful) {
        if (state?.id === job.stateId && state.provider === job.provider && !state.uncertain) {
          state.execution = 'acknowledged'; changed = true;
        }
        this.counters.staleReplies++;
        this.log('DEBUG', 'Validated native reply is stale; its colors rejected', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
        if (source.open && chunk.lease && !chunk.complete && providerCurrent) this.close({ key: chunk.key, ownerKey: job.key,
          generation: chunk.generation, lease: chunk.lease, provider: job.provider,
          health: state?.id === job.stateId ? new WeakRef(state) : undefined });
        return;
      }
      // Validation plus current source/provider authority proves useful native
      // work, even if local byte pressure subsequently discards its colors.
      this.provider.classificationAccepted(job.provider);
      state.execution = 'acknowledged';
      this.counters.committedLineCalls += chunk.counters.committed_line_calls; this.counters.committedLineBytes += chunk.counters.committed_line_bytes;
      this.counters.tailCalls += chunk.counters.tail_calls; this.counters.tailBytes += chunk.counters.tail_bytes;
      if (chunk.complete && source.expected.lease && this.leaseProvider === job.provider) this.remoteLeases = Math.max(0, this.remoteLeases - 1);
      const previousSemantic = this.pool.status(job.generation)?.semanticStamp;
      const result = this.pool.installChunk(job.generation, chunk, source.capture); this.receipts(result.released);
      if (!result.accepted || state.generation !== job.generation) {
        this.log('WARN', 'Validated native colors refused by local storage', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version });
        if (chunk.lease && !chunk.complete) this.close({ key: chunk.key, ownerKey: job.key, generation: chunk.generation, lease: chunk.lease, provider: job.provider,
          health: state?.id === job.stateId ? new WeakRef(state) : undefined });
        state.lease = undefined; state.blocked = true; state.dirty = false; state.styleDirty = false;
        changed = true;
        return;
      }
      // Scope acknowledgement is useful independently of the desired theme. Only
      // a complete ready presentation may replace the retained display/effect.
      state.parsedAssets = job.description.assets; state.parsedProvider = job.provider; state.styleDirty = true;
      this.invalidateStyles(state, previousSemantic === this.pool.status(job.generation)?.semanticStamp);
      if (state.previous !== undefined && (!state.group || !this.pool.displayStatus(state.previous))) {
        this.pool.remove(state.previous); state.previous = undefined; state.previousCoverage = false;
      }
      state.committedUnits = chunk.complete ? source.capture.text.length : source.replaceUnits + source.expected.replacementText.lastIndexOf('\n') + 1;
      state.lease = chunk.complete ? undefined : chunk.lease; state.execution = 'acknowledged';
      reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: state, operation: 'source' });
      changed = true;
      this.log('DEBUG', 'Validated native result accepted', { source: job.key, job: job.id, provider: job.provider, version: source.expected.source_version,
        sourceBytes: chunk.source_bytes, committedBytes: chunk.committed_bytes, complete: chunk.complete,
        committedLineCalls: chunk.counters.committed_line_calls, tailCalls: chunk.counters.tail_calls });
    } catch (error) {
      const source = job.source;
      if (healthOwner && !job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error))
        reportRuntime(this.options.diagnostic, { kind: 'failure', scope: healthOwner, operation: healthOperation, area: 'syntax', code: diagnosticError(error) });
      this.log(!job.stopped && !job.abort.signal.aborted && !this.disposed && unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Native reply refused by validation or remote admission', { source: job.key, job: job.id, provider: job.provider,
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
      if (node?.seen === this.workPass && (node.pending || node.epoch !== this.refreshEpoch || current?.dirty || current?.styleDirty)) this.rewind();
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
