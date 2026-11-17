import { diagnose, diagnosticError, reportRuntime, type DiagnosticFields, type DiagnosticSink } from '../diagnostics.ts';
import type { ReplySize } from './data-json.ts';
import { decodeSemanticDescription as decodeDescription, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION,
  type SemanticDataRequest, type SemanticDescription as Description, type SemanticTransportRequest } from './semantic-protocol.ts';
import { RequestFailure } from './request-failure.ts';
import type { TransportEnd } from './transport-end.ts';
import { ExpectedOwnedUnavailable } from './owned-startup.ts';

/** Local engineering bounds, not native parser/usefulness deadlines. Factories must
 * bound their underlying import/connect/acquire work and dispose aborted late work.
 * describe uses the transports' independent 4KiB/32KiB metadata lane; 5s matches
 * a finite public request deadline. Acquisition gets 15s; reconnect gets two tries.
 * close success MUST mean actual owned child exit, not merely a sent kill signal.
 */
export const PROVIDER_LIMITS = Object.freeze({
  factoryMs: 5000, ownedFactoryMs: 15000, controlMs: 5000, closeMs: 5000,
  reconnectAttempts: 2, recoveryIntervalMs: 60000, recoveryWindowMs: 600000,
  metadataBytes: 32768,
});
export interface ProviderTransport {
  /** Public transport lifetime. endReason is set before ended settles; cleanup
   * cannot rewrite its first origin. Neither signal proves a source did not run. */
  readonly ended: Promise<TransportEnd>;
  readonly endReason: TransportEnd | undefined;
  /** Physical lanes, including metadata whose caller stopped waiting. */
  readonly hasPendingRequests?: boolean;
  request(request: SemanticTransportRequest, options?: { signal?: AbortSignal; deadlineMs?: number; waitOnly?: boolean; acceptRetired?: boolean; replySize?: ReplySize }): Promise<unknown>;
  /** Shared: only this dedicated route/connection. Owned: resolves after child exit. */
  close(): Promise<void>;
}
export interface ProviderClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): { cancel(): void; unref(): void };
}
/** True transfers only metadata validation for this exact candidate, not publication
 * or source execution authority. False closes the rejected candidate. */
export type SharedNegotiator = (transport: ProviderTransport) => Promise<boolean>;
export type ProviderRetirementOrigin = TransportEnd | 'worker_unavailable' | 'exhausted_route' | 'handoff' | 'suspended' | 'disabled' | 'disposed';
export interface ProviderOptions {
  diagnostic?: DiagnosticSink;
  /** Auth/discovery/catalogue/capability checks are factory-owned. Each successful
   * call transfers a fresh dedicated disposable candidate, never a reused retired
   * transport or someone else's shared client handle.
   * Aborted acquisition must also honor outstanding owned cleanup across owners:
   * disposal/new client is NOT evidence an earlier child exited.
   */
  /** Enumerating factories may negotiate ready candidates sequentially within ONE
   * attempt. Return the accepted transport; single-candidate factories may ignore
   * the callback and leave the one describe to the broker after their return. */
  tryShared(signal: AbortSignal, negotiate: SharedNegotiator): Promise<ProviderTransport | undefined>;
  acquireOwned(signal: AbortSignal): Promise<ProviderTransport>;
  clock?: ProviderClock;
  /** Coalesced availability, cleanup and post-guard-clear opportunity. */
  onChange?: () => void;
  /** Synchronous primitive retirement delivery before cancellation or close. */
  onRetired?: (generation: number, origin: ProviderRetirementOrigin) => void;
  /** Published owned generation only, after actual successful child close/reap.
   * Shared disconnect, endReason, bounded-close failure and availability are not proof. */
  onOwnedStopped?: (generation: number) => void;
}
type Kind = 'shared' | 'owned';
type Availability = 'initializing' | 'ready' | 'transitioning' | 'unavailable' | 'disabled' | 'disposed';
type Reason = 'initializing' | 'ready' | 'proven_loss' | 'handoff' | 'optional_unavailable' | 'unproved_exit' | 'activation_deferred' | 'worker_unavailable' | 'exhausted_route' | 'transport_closed' | 'transport_uncertain' | 'transport_denied' | 'suspended' | 'disabled' | 'disposed';
export interface ProviderSnapshot {
  availability: Availability; reason: Reason; generation: number; kind?: Kind;
  initialShared: boolean | undefined; description?: Description; readonly recoveryAt?: number;
}
export interface ProviderStats {
  sharedAttempts: number; ownedAttempts: number; reconnectAttempts: number; controls: number;
  ownedRestarts: number; successfulClassifications: number;
  candidatesAccepted: number; candidatesRejected: number; activeCandidates: number;
  closesStarted: number; closesCompleted: number; closeFailures: number;
  recoveryEpisodes: number; probesScheduled: number; probesStarted: number; probesCompleted: number;
  activeProbes: number; recoveryTimers: number; liveTimers: number; abortListeners: number;
  handoffsSucceeded: number; handoffsFailed: number; sourceDispatches: number; styleDispatches: number; staleReplies: number;
}
interface Candidate { transport: ProviderTransport; kind: Kind; description: Description }
type SelectionSeed = 'initial' | 'previous_shared' | 'previous_owned' | 'handoff';
type AcquisitionPurpose = 'initial' | 'working_resume' | 'automatic_failure';
type FailureCause = 'proven_loss' | 'handoff' | 'optional_unavailable' | 'worker_unavailable' | 'exhausted_route' | 'transport_closed' | 'transport_uncertain' | 'transport_denied' | 'activation_deferred';
interface AcquisitionIntent { purpose: AcquisitionPurpose; selection: SelectionSeed; cause?: FailureCause }
interface AutomaticCycle { started: boolean; selection: SelectionSeed }
interface SharedSelection {
  deadline: number; closed: boolean; busy: boolean; seen: WeakSet<ProviderTransport>; signal?: AbortSignal;
  selected?: Candidate; transferred?: WeakRef<ProviderTransport>;
}
function sharedNegotiator(owner: WeakRef<ProviderBroker>, epoch: number, selection: SharedSelection): SharedNegotiator {
  return transport => {
    const broker = owner.deref(), signal = selection.signal;
    if (!broker || selection.closed || !signal || signal.aborted) {
      if (selection.transferred?.deref() !== transport) broker ? broker.closeLateCandidate(transport, 'shared') : closeLate(transport);
      return Promise.resolve(false);
    }
    return broker.negotiateShared(transport, epoch, signal, selection);
  };
}
export const DEFAULT_PROVIDER_CLOCK: ProviderClock = {
  now: () => performance.now(),
  setTimeout(callback, ms) { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer), unref: () => { timer.unref(); } }; },
};
const ignored = () => {};
function assertNever(value: never): never { throw new Error(`unexpected provider state: ${String(value)}`); }
const closings = new WeakMap<ProviderTransport, Promise<boolean>>();
function closeResource(transport: ProviderTransport): Promise<boolean> {
  const existing = closings.get(transport); if (existing) return existing;
  let promise: Promise<boolean>;
  try { promise = transport.close().then(() => true, () => false); } catch { promise = Promise.resolve(false); }
  closings.set(transport, promise); return promise;
}
function closeLate(transport: ProviderTransport | undefined) { if (transport) void closeResource(transport); }

/** Finite local waiting, with cancellation listener/timer released on every exit.
 * The raw promise's late handlers have no strong broker reference. Cancellation is
 * not a claim that underlying factory work or shared source parsing stopped.
 */
function bounded<T>(promise: Promise<T>, clock: ProviderClock, ms: number,
  signal: AbortSignal | undefined, owner: WeakRef<ProviderBroker>, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean, value?: T, error?: unknown) => {
      if (done) { if (ok) late?.(value as T); return; }
      done = true; timer.cancel(); owner.deref()?.metric('liveTimers', -1);
      if (signal) { signal.removeEventListener('abort', abort); owner.deref()?.metric('abortListeners', -1); }
      if (ok) resolve(value as T); else reject(error instanceof ExpectedOwnedUnavailable ? new ExpectedOwnedUnavailable() : new Error('occipital control unavailable'));
    };
    const abort = () => finish(false);
    const timer = clock.setTimeout(abort, ms); timer.unref(); owner.deref()?.metric('liveTimers', 1);
    if (signal) { signal.addEventListener('abort', abort, { once: true }); owner.deref()?.metric('abortListeners', 1); }
    promise.then(value => finish(true, value), error => finish(false, undefined, error));
    if (signal?.aborted) abort();
  });
}

/** Preflight plain metadata before decoder ownership. This is a local metadata
 * allowance, not a JS/SDK heap bound; never stringify a raw reply or log faults.
 */
function metadataFits(value: unknown): boolean {
  let bytes = 0, nodes = 0; const seen = new Set<object>();
  function stringBytes(text: string): number {
    if (text.length > PROVIDER_LIMITS.metadataBytes) return PROVIDER_LIMITS.metadataBytes + 1;
    let size = Buffer.byteLength(text) + 2;
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); if (code === 34 || code === 92) size++; else if (code < 32) size += 5; }
    return size;
  }
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 16) return false;
    if (typeof item === 'string') bytes += stringBytes(item);
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item)) bytes += 24;
    else if (typeof item === 'object' && item !== null) {
      if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) return false;
      seen.add(item); bytes += 2;
      for (const key of Object.keys(item)) {
        if (!Array.isArray(item)) bytes += stringBytes(key) + 1;
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (!field || !('value' in field) || !visit(field.value, depth + 1)) return false;
        bytes++; if (bytes > PROVIDER_LIMITS.metadataBytes) return false;
      }
    } else return false;
    return bytes <= PROVIDER_LIMITS.metadataBytes;
  }
  return visit(value, 0);
}
function sourceObservers(owner: WeakRef<ProviderBroker>, generation: number, acceptRetired: boolean, slot: CompletionSlot) {
  const check = () => { const broker = owner.deref(); if (!broker) cancelCompletion(slot); broker?.requestSettled(generation); if (!broker?.isReady(generation)) { broker?.metric('staleReplies', 1); if (!acceptRetired) throw new RequestFailure('occipital provider retired'); } };
  return { accept: (reply: unknown) => { check(); return reply; }, reject: (error: unknown): never => { check(); throw error instanceof RequestFailure ? error : new RequestFailure('occipital request outcome unknown'); } };
}
type ProviderCompletion = { promise: Promise<boolean>; resolve(value: boolean): void };
type CompletionSlot = { current?: ProviderCompletion };
const providerSettled = Promise.resolve(true), providerCancelled = Promise.resolve(false);
function providerCompletion(): ProviderCompletion {
  let resolve!: ProviderCompletion['resolve'];
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
function cancelCompletion(slot: CompletionSlot): void { const pending = slot.current; slot.current = undefined; pending?.resolve(false); }
function availabilityNotice(owner: WeakRef<ProviderBroker>, slot: CompletionSlot) {
  return () => { const broker = owner.deref(); if (broker) broker.notifyChange(); else cancelCompletion(slot); };
}
function operationNotice(owner: WeakRef<ProviderBroker>, operation: Promise<void>, slot: CompletionSlot) {
  return () => { const broker = owner.deref(); if (broker) broker.operationSettled(operation); else cancelCompletion(slot); };
}
/** Created outside publication scopes: a retained transport promise must never
 * retain the first broker/candidate through a V8 lexical receiver context. */
function lifetimeObservers(owner: WeakRef<ProviderBroker>, generation: number) {
  const end = (reason: TransportEnd) => { const broker = owner.deref(); if (broker) void broker.transportEnded(generation, reason).catch(ignored); };
  return { end, rejected: () => end('uncertain') };
}
let nextBroker = 0;

/** Provider lifetime only. No sources, queues, replay, leases, results, palette or
 * render-node callbacks. Useful execution requests paced acquisition after failure;
 * route replacement does not prove prior work stopped or grant fallback permission.
 */
export class ProviderBroker {
  private readonly options: ProviderOptions;
  private readonly clock: ProviderClock;
  private readonly id = ++nextBroker;
  private ticket = 0;
  private epoch = 0;
  private generation = 0;
  private initialShared: boolean | undefined;
  private availability: Availability = 'initializing';
  private reason: Reason = 'initializing';
  private active?: Candidate;
  private enabled = true;
  private suspended = false;
  private resumeNeeded = false;
  private suspendedRecovery?: { start: number; end: number };
  private intent?: AcquisitionIntent;
  private failureNotBefore?: number;
  private pendingRequests = 0;
  /** Last transferred owned child: bounded close failure is not actual exit proof. */
  private owned?: ProviderTransport;
  private ownedGeneration?: number;
  private readonly candidates = new Set<ProviderTransport>();
  private readonly cleanup = new WeakMap<ProviderTransport, Promise<boolean>>();
  private readonly pendingCloses = new Set<Promise<boolean>>();
  private cancellation = new AbortController();
  private operation?: Promise<void>;
  private pendingOperation?: Promise<void>;
  private readonly completion: CompletionSlot = {};
  private shutdown?: Promise<void>;
  private noticeScheduled = false;
  private notifying = false;
  private recoveryTimer?: ReturnType<ProviderClock['setTimeout']>;
  private recoveryEnd = 0;
  private recoveryStart = 0;
  private readonly counters: ProviderStats = {
    sharedAttempts: 0, ownedAttempts: 0, reconnectAttempts: 0, controls: 0,
    ownedRestarts: 0, successfulClassifications: 0,
    candidatesAccepted: 0, candidatesRejected: 0, activeCandidates: 0,
    closesStarted: 0, closesCompleted: 0, closeFailures: 0,
    recoveryEpisodes: 0, probesScheduled: 0, probesStarted: 0, probesCompleted: 0,
    activeProbes: 0, recoveryTimers: 0, liveTimers: 0, abortListeners: 0,
    handoffsSucceeded: 0, handoffsFailed: 0, sourceDispatches: 0, styleDispatches: 0, staleReplies: 0,
  };
  constructor(options: ProviderOptions) {
    if (options.onChange !== undefined && typeof options.onChange !== 'function'
      || options.onRetired !== undefined && typeof options.onRetired !== 'function'
      || options.onOwnedStopped !== undefined && typeof options.onOwnedStopped !== 'function') throw new Error('invalid provider observer');
    this.options = options; this.clock = options.clock ?? DEFAULT_PROVIDER_CLOCK;
  }
  snapshot(): ProviderSnapshot {
    const recoveryAt = this.recoveryAt();
    return { availability: this.availability, reason: this.reason, generation: this.generation,
      kind: this.active?.kind, initialShared: this.initialShared, description: this.active?.description,
      ...(recoveryAt === undefined ? {} : { recoveryAt }) };
  }
  private recoveryAt(): number | undefined {
    if (!this.enabled || this.suspended || this.availability !== 'unavailable' || this.pendingOperation
      || this.counters.activeProbes > 0 || this.active || this.owned || this.reason === 'unproved_exit' || !this.intent) return;
    switch (this.intent.cause) {
      case 'proven_loss': case 'handoff': case 'optional_unavailable': case 'worker_unavailable':
      case 'exhausted_route': case 'transport_closed': case 'transport_uncertain': case 'transport_denied':
      case 'activation_deferred': case undefined: break;
      default: return assertNever(this.intent.cause);
    }
    if (this.intent.purpose === 'working_resume') return this.clock.now();
    return this.failureNotBefore ?? this.clock.now();
  }
  stats(): ProviderStats { return { ...this.counters }; }
  /** Primitive internal accounting, also read through stats() without raw data. */
  metric(key: keyof ProviderStats, amount: number) { this.counters[key] += amount; }
  isReady(generation: number): boolean { return !this.suspended && this.availability === 'ready' && this.generation === generation && !!this.active; }
  /** Observe current operations and delivery, excluding future shared-return timer ticks. */
  whenSettled(): Promise<boolean> {
    if (this.suspended || this.availability === 'disposed') return providerCancelled;
    if (this.completion.current) return this.completion.current.promise;
    if (!this.workPending()) return providerSettled;
    this.completion.current = providerCompletion(); return this.completion.current.promise;
  }
  private workPending(): boolean {
    return !!this.pendingOperation || this.pendingRequests > 0 || this.counters.activeProbes > 0 || this.noticeScheduled || this.notifying;
  }
  private completeWork(): void {
    if (this.workPending()) return;
    const pending = this.completion.current; this.completion.current = undefined; pending?.resolve(true);
  }
  private trackOperation(operation: Promise<void>): Promise<void> {
    this.pendingOperation = operation;
    const done = operationNotice(new WeakRef(this), operation, this.completion);
    void operation.then(done, done); return operation;
  }
  /** Receiver-free observer of the current operation, never a startup demand. */
  operationSettled(operation: Promise<void>): void {
    if (this.pendingOperation !== operation) return;
    this.pendingOperation = undefined;
    if (this.resumeNeeded && this.enabled && !this.suspended && this.availability !== 'disposed') {
      const intent = this.intent ?? { purpose: 'initial' as const, selection: 'initial' as const };
      this.intent = intent; this.resumeNeeded = false;
      if (intent.purpose === 'automatic_failure') this.unavailable(this.intentReason(intent));
      else {
        this.availability = 'initializing'; this.reason = 'suspended'; this.changed();
        this.operation = this.trackOperation(this.enable(this.epoch, intent));
      }
    }
    this.opportunity(); this.completeWork();
  }
  private static resumedOperation(owner: WeakRef<ProviderBroker>, epoch: number): () => Promise<void> | undefined {
    return () => {
      const broker = owner.deref();
      return broker?.current(epoch) ? broker.operation : undefined;
    };
  }
  start(): Promise<void> {
    if (!this.enabled || this.suspended || this.availability === 'disposed') return Promise.resolve();
    if (this.operation) return this.operation;
    this.intent ??= { purpose: 'initial', selection: 'initial' };
    const epoch = this.epoch;
    this.operation = this.trackOperation(this.enable(epoch, this.intent)); return this.operation;
  }
  /** Deliberate interruption is separate from timeout/loss and preserves its origin. */
  suspend(): number | undefined {
    if (this.suspended || this.availability === 'disposed') return;
    if (this.active?.transport.endReason !== undefined) void this.transportEnded(this.generation, this.active.transport.endReason).catch(ignored);
    const previous = this.active;
    const interrupted = previous && (this.pendingRequests > 0 || previous.transport.hasPendingRequests === true) ? this.generation : undefined;
    const wasInitializing = this.availability === 'initializing' || this.availability === 'transitioning';
    this.suspended = true; cancelCompletion(this.completion);
    this.resumeNeeded = this.enabled && (!!previous || (wasInitializing && this.intent !== undefined));
    if (previous) {
      this.intent = { purpose: 'working_resume', selection: previous.kind === 'shared' ? 'previous_shared' : 'previous_owned' };
    } else if (this.intent) this.resumeNeeded ||= this.enabled;
    this.suspendedRecovery = this.recoveryEnd ? { start: this.recoveryStart, end: this.recoveryEnd } : undefined;
    ++this.epoch; this.cancelRecovery(true);
    if (previous) {
      const generation = this.generation;
      this.candidates.add(previous.transport);
      this.retire('suspended');
      this.notifyRetired(generation, previous.transport.endReason ?? 'suspended');
    } else if (this.availability === 'transitioning') this.unavailable(this.reason);
    this.cancellation.abort();
    const pending = [...this.candidates].map(transport => this.close(transport));
    this.operation = this.trackOperation(Promise.all([...pending, ...this.pendingCloses]).then(ignored));
    return interrupted;
  }
  resume(): Promise<void> {
    if (!this.suspended || this.availability === 'disposed') return this.operation ?? Promise.resolve();
    this.suspended = false;
    this.cancellation = new AbortController();
    const recovery = this.suspendedRecovery; this.suspendedRecovery = undefined;
    if (recovery) { this.recoveryStart = recovery.start; this.recoveryEnd = recovery.end; }
    const needed = this.resumeNeeded;
    if (!this.enabled || !needed) {
      this.resumeNeeded = false; this.opportunity(); return this.operation ?? Promise.resolve();
    }
    const intent = this.intent ?? { purpose: 'initial' as const, selection: 'initial' as const };
    this.intent = intent;
    if (intent.purpose === 'automatic_failure') {
      this.resumeNeeded = false; this.unavailable(this.intentReason(intent)); this.opportunity();
      return this.pendingOperation?.then(ProviderBroker.resumedOperation(new WeakRef(this), this.epoch)) ?? Promise.resolve();
    }
    if (this.pendingOperation) return this.pendingOperation.then(ProviderBroker.resumedOperation(new WeakRef(this), this.epoch));
    this.resumeNeeded = false;
    this.availability = 'initializing'; this.reason = 'suspended'; this.changed();
    this.operation = this.trackOperation(this.enable(this.epoch, intent)); return this.operation;
  }
  /** Receiver-free request settlement must not debit a replacement generation. */
  requestSettled(generation: number): void { if (generation === this.generation) this.pendingRequests--; this.completeWork(); }

  /** Session-local activation; ordinary start/status never changes this choice. */
  setEnabled(enabled: boolean): Promise<void> {
    if (this.availability === 'disposed') return this.shutdown ?? Promise.resolve();
    if (this.enabled === enabled) return this.operation ?? Promise.resolve();
    cancelCompletion(this.completion);
    this.enabled = enabled;
    this.resumeNeeded = enabled && this.suspended;
    this.suspendedRecovery = undefined; this.intent = undefined;
    const epoch = ++this.epoch;
    this.cancelRecovery();
    const previous = this.active, retiredGeneration = previous ? this.generation : undefined;
    if (previous) this.candidates.add(previous.transport);
    this.pendingRequests = 0; this.active = undefined; ++this.generation;
    if (!enabled) {
      reportRuntime(this.options.diagnostic, { kind: 'released', scope: this, operation: 'startup' });
      this.availability = 'disabled'; this.reason = 'disabled';
      if (retiredGeneration !== undefined) this.notifyRetired(retiredGeneration, previous!.transport.endReason ?? 'disabled');
      this.changed(); this.cancellation.abort();
      const pending = [...this.candidates].map(transport => this.close(transport));
      this.operation = this.trackOperation(Promise.all([...pending, ...this.pendingCloses]).then(ignored));
    } else {
      this.cancellation.abort(); this.cancellation = new AbortController();
      this.intent = { purpose: 'initial', selection: 'initial' };
      this.availability = 'initializing'; this.reason = 'initializing'; this.changed();
      this.operation = this.trackOperation(this.suspended ? Promise.resolve() : this.enable(epoch, this.intent));
    }
    return this.operation;
  }
  private async enable(epoch: number, intent: AcquisitionIntent): Promise<void> {
    const previous = this.owned;
    if (previous) {
      const exited = await this.close(previous);
      if (!this.current(epoch)) return;
      if (!exited || this.owned === previous) { this.unavailable('unproved_exit'); return; }
    }
    if (!this.current(epoch)) return;
    if (this.pendingCloses.size) {
      await Promise.all([...this.pendingCloses]);
      if (!this.current(epoch)) return;
    }
    if (intent.purpose !== 'working_resume' && this.failureNotBefore !== undefined && this.clock.now() < this.failureNotBefore) {
      this.unavailable(intent.purpose === 'initial' ? 'activation_deferred' : this.intentReason(intent)); return;
    }
    await this.runSelection(epoch, intent);
  }
  /** Actual confirmed channel/process loss retires only this published route. */
  provenLoss(generation: number): Promise<void> {
    if (!this.isReady(generation)) return Promise.resolve();
    const previous = this.active!;
    const first = previous.transport.endReason;
    if (first !== undefined && first !== 'lost') return this.transportEnded(generation, first);
    return this.retireForFailure(generation, previous, 'proven_loss', 'proven_loss', 'lost', true);
  }
  /** Actual transport lifetime, bound to one published generation only. */
  transportEnded(generation: number, reason: TransportEnd): Promise<void> {
    if (!this.isReady(generation)) return Promise.resolve();
    const previous = this.active!;
    const first = previous.transport.endReason ?? reason;
    if (first === 'lost') return this.provenLoss(generation);
    const cause: FailureCause = first === 'closed' ? 'transport_closed' : first === 'uncertain' ? 'transport_uncertain' : 'transport_denied';
    return this.retireForFailure(generation, previous, cause, cause, first, false);
  }
  /** A validated current-generation native worker fault retires only this route. */
  workerUnavailable(generation: number): Promise<void> {
    if (!this.isReady(generation)) return Promise.resolve();
    const previous = this.active!;
    const first = previous.transport.endReason;
    if (first !== undefined) return this.transportEnded(generation, first);
    return this.retireForFailure(generation, previous, 'worker_unavailable', 'worker_unavailable', 'worker_unavailable', true);
  }
  /** Strict exhausted-capacity cleanup is not a fabricated transport failure. */
  exhaustedRoute(generation: number): Promise<void> {
    const previous = this.active;
    if (!this.isReady(generation) || !previous || this.pendingOperation || this.counters.activeProbes > 0
      || this.reason === 'handoff' || this.pendingRequests > 0 || previous.transport.hasPendingRequests === true
      || (previous.kind === 'owned' && (this.owned !== previous.transport || this.ownedGeneration !== generation))
      || (previous.kind === 'shared' && this.owned !== undefined)) return Promise.resolve();
    const first = previous.transport.endReason;
    if (first !== undefined) return this.transportEnded(generation, first);
    return this.retireForFailure(generation, previous, 'exhausted_route', 'exhausted_route', 'exhausted_route', true);
  }
  private retireForFailure(generation: number, previous: Candidate, cause: FailureCause, reason: Reason, origin: ProviderRetirementOrigin, preservePreference: boolean): Promise<void> {
    this.cancelRecovery(preservePreference);
    this.intent = { purpose: 'automatic_failure', selection: previous.kind === 'shared' ? 'previous_shared' : 'previous_owned', cause };
    const epoch = ++this.epoch;
    this.retire(reason); this.notifyRetired(generation, origin);
    this.cancellation.abort(); this.cancellation = new AbortController();
    this.operation = this.trackOperation(this.finishRetirement(epoch, previous, reason)); return this.operation;
  }
  private async finishRetirement(epoch: number, previous: Candidate, reason: Reason): Promise<void> {
    const closed = await this.close(previous.transport);
    if (!this.current(epoch)) return;
    if (previous.kind === 'owned' && !closed) this.unavailable('unproved_exit');
    else this.unavailable(reason);
  }
  /** Notify the execution owner before cancellation can settle retired requests. */
  private notifyRetired(generation: number, origin: ProviderRetirementOrigin): void {
    try { this.options.onRetired?.(generation, origin); } catch { /* Retirement cleanup is mandatory even if an observer fails. */ }
  }
  private intentReason(intent: AcquisitionIntent): Reason {
    if (intent.purpose === 'initial' && this.failureNotBefore !== undefined && this.clock.now() < this.failureNotBefore) return 'activation_deferred';
    switch (intent.cause) {
      case 'proven_loss': case 'handoff': case 'optional_unavailable': case 'worker_unavailable':
      case 'exhausted_route': case 'transport_closed': case 'transport_uncertain': case 'transport_denied':
      case 'activation_deferred': return intent.cause;
      case undefined: return 'optional_unavailable';
      default: return assertNever(intent.cause);
    }
  }
  /** Useful execution calls this guarded entry; transport events never acquire. */
  recover(): Promise<void> {
    if (this.pendingOperation) return this.pendingOperation;
    const intent = this.intent, recoveryAt = this.recoveryAt();
    if (!intent || recoveryAt === undefined || this.clock.now() < recoveryAt || this.suspended || !this.enabled
      || this.availability !== 'unavailable' || this.counters.activeProbes > 0) return Promise.resolve();
    const epoch = ++this.epoch;
    this.cancellation.abort(); this.cancellation = new AbortController();
    this.availability = 'transitioning'; this.reason = this.intentReason(intent); this.changed();
    const operation = this.owned || this.pendingCloses.size > 0
      ? this.finishCleanupOnly(epoch, intent)
      : this.runSelection(epoch, intent);
    this.operation = this.trackOperation(operation); return this.operation;
  }
  private async finishCleanupOnly(epoch: number, intent: AcquisitionIntent): Promise<void> {
    const owned = this.owned;
    if (owned) {
      const exited = await this.close(owned);
      if (!this.current(epoch)) return;
      if (!exited || this.owned === owned) { this.unavailable('unproved_exit'); return; }
    } else if (this.pendingCloses.size) await Promise.all([...this.pendingCloses]);
    if (this.current(epoch)) this.unavailable(this.intentReason(intent));
  }
  /** Source owner reports a fully validated useful current classification only;
   * it is an observation metric and never resets provider recovery pacing. */
  classificationAccepted(generation: number): boolean {
    if (!this.isReady(generation)) return false;
    this.metric('successfulClassifications', 1); return true;
  }
  /** Generation-bound passthrough, no retries/queue/source storage. Caller owns
   * source admission/decoder and unique tickets (reserved broker: prefix excluded).
   * Transport owns source deadlines/cancellation and its existing data allowance.
   * The single DATA promise follows correlated reply or actual local release;
   * caller abort is not settlement. CONTROL waitOnly is transport-only.
   */
  request(generation: number, request: SemanticDataRequest, options?: { signal?: AbortSignal; deadlineMs?: number; replySize?: ReplySize;
    /** Canonical source owner validates retired terminal outcomes for physical
     * permission ONLY, never stale publication or useful classification credit. */
    acceptRetired?: boolean }): Promise<unknown> {
    if (!this.isReady(generation)) return Promise.reject(new RequestFailure('occipital provider retired', 'not_started'));
    if (typeof request.ticket === 'string' && request.ticket.startsWith('broker:')) return Promise.reject(new RequestFailure('occipital reserved ticket', 'not_started'));
    this.metric(request.op === 'styles.resolve' ? 'styleDispatches' : 'sourceDispatches', 1);
    const observers = sourceObservers(new WeakRef(this), generation, options?.acceptRetired === true, this.completion);
    this.pendingRequests++;
    try { return this.active!.transport.request(request, options && { signal: options.signal, deadlineMs: options.deadlineMs, acceptRetired: options.acceptRetired, ...(options.replySize && { replySize: options.replySize }) }).then(observers.accept, observers.reject); }
    catch (error) { this.requestSettled(generation); return Promise.reject(error instanceof RequestFailure ? error : new RequestFailure('occipital request outcome unknown')); }
  }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    cancelCompletion(this.completion);
    const previous = this.active, retiredGeneration = previous ? this.generation : undefined;
    ++this.epoch; this.cancelRecovery();
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: this, operation: 'startup' });
    const transports = new Set(this.candidates); if (previous) transports.add(previous.transport);
    this.intent = undefined; this.resumeNeeded = false; this.suspendedRecovery = undefined;
    this.pendingRequests = 0; this.active = undefined; ++this.generation; this.availability = 'disposed'; this.reason = 'disposed';
    if (retiredGeneration !== undefined) this.notifyRetired(retiredGeneration, previous!.transport.endReason ?? 'disposed');
    this.cancellation.abort();
    const pending = [...transports].map(transport => this.close(transport));
    this.shutdown = Promise.all([...pending, ...this.pendingCloses]).then(ignored);
    return this.shutdown;
  }
  private current(epoch: number): boolean { return this.enabled && !this.suspended && this.epoch === epoch && this.availability !== 'disposed'; }
  private retire(reason: Reason) { this.pendingRequests = 0; this.active = undefined; ++this.generation; this.availability = 'transitioning'; this.reason = reason; this.changed(); }
  private publish(candidate: Candidate): boolean {
    if (candidate.transport.endReason !== undefined || (candidate.kind === 'shared' && this.owned !== undefined)) return false;
    this.candidates.delete(candidate.transport); this.counters.activeCandidates = this.candidates.size;
    if (candidate.kind === 'shared') this.cancelRecovery();
    this.intent = undefined; this.pendingRequests = 0; this.active = candidate; ++this.generation; this.availability = 'ready'; this.reason = 'ready';
    reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: this, operation: 'startup' });
    if (candidate.kind === 'owned') this.ownedGeneration = this.generation;
    const observers = lifetimeObservers(new WeakRef(this), this.generation);
    void candidate.transport.ended.then(observers.end, observers.rejected);
    this.changed(); return true;
  }
  private unavailable(reason: Reason) {
    const changed = this.availability !== 'unavailable' || this.reason !== reason;
    this.availability = 'unavailable'; this.reason = reason; if (changed) this.changed();
  }
  private log(explanation: string, fields?: DiagnosticFields): void { if (this.options.diagnostic) diagnose(this.options.diagnostic, 'INFO', 'occipital', explanation,
    { generation: this.generation, kind: this.active?.kind, ...fields }); }
  private changed(): void {
    this.log('Provider publication changed', { availability: this.availability, reason: this.reason, version: this.active?.description.backend_version,
      pid: this.active?.description.runtime.pid });
    this.opportunity();
  }
  private opportunity(): void {
    if (!this.options.onChange || this.availability === 'disposed' || this.noticeScheduled) return;
    this.noticeScheduled = true; queueMicrotask(availabilityNotice(new WeakRef(this), this.completion));
  }
  /** Internal weak delivery reads the latest publication, not a captured old snapshot. */
  notifyChange(): void {
    this.noticeScheduled = false;
    if (this.availability === 'disposed') return;
    this.notifying = true;
    try { this.options.onChange?.(); } catch { /* Consumer presentation cannot disturb provider ownership. */ }
    finally { this.notifying = false; this.completeWork(); }
  }
  /** Receiver-free close observers deliver evidence, never publication/recovery. */
  notifyOwnedStopped(generation: number): void {
    this.log('Owned helper actually closed/reaped; source authority may use this receipt', { generation });
    try { this.options.onOwnedStopped?.(generation); } catch { /* Evidence delivery cannot disrupt cleanup. */ }
  }
  closeLateCandidate(transport: ProviderTransport, kind: Kind): void {
    if (kind === 'owned') {
      if (this.owned && this.owned !== transport) { closeLate(transport); return; }
      this.owned = transport; this.ownedGeneration = undefined;
    }
    void this.close(transport);
  }
  private static lateCandidateCloser(owner: WeakRef<ProviderBroker>, kind: Kind) {
    return (transport: ProviderTransport | undefined) => {
      if (!transport) return;
      const broker = owner.deref();
      if (broker) broker.closeLateCandidate(transport, kind); else closeLate(transport);
    };
  }
  private static actualCloseObserver(owner: WeakRef<ProviderBroker>, transport: WeakRef<ProviderTransport>, generation: number | undefined) {
    return (success: boolean) => owner.deref()?.actualCloseCompleted(transport.deref(), generation, success);
  }
  private actualCloseCompleted(transport: ProviderTransport | undefined, generation: number | undefined, success: boolean): void {
    if (success && generation !== undefined) this.notifyOwnedStopped(generation);
    let changed = false;
    if (success && transport && this.owned === transport) {
      this.owned = undefined; this.ownedGeneration = undefined;
      if (this.availability === 'unavailable' && this.reason === 'unproved_exit' && this.intent) {
        const reason = this.intentReason(this.intent);
        changed = reason !== this.reason; this.reason = reason;
      }
    }
    if (changed) this.changed(); else this.opportunity();
  }
  private close(transport: ProviderTransport): Promise<boolean> {
    this.candidates.delete(transport); this.counters.activeCandidates = this.candidates.size;
    const existing = this.cleanup.get(transport); if (existing) return existing;
    const generation = transport === this.owned ? this.ownedGeneration : undefined;
    if (!closings.has(transport)) this.metric('closesStarted', 1);
    const actual = closeResource(transport);
    void actual.then(ProviderBroker.actualCloseObserver(new WeakRef(this), new WeakRef(transport), generation));
    const pending = this.awaitClose(transport); this.cleanup.set(transport, pending);
    this.pendingCloses.add(pending); void pending.then(() => { this.pendingCloses.delete(pending); });
    return pending;
  }
  private async awaitClose(transport: ProviderTransport): Promise<boolean> {
    try {
      const success = await bounded(closeResource(transport), this.clock, PROVIDER_LIMITS.closeMs, undefined, new WeakRef(this));
      this.metric(success ? 'closesCompleted' : 'closeFailures', 1);
      this.log(success ? 'Provider cleanup completed' : 'Provider cleanup wait expired; not exit proof', { owned: transport === this.owned }); return success;
    } catch (error) { this.metric('closeFailures', 1); this.log('Provider cleanup failed; not exit proof', { code: diagnosticError(error) }); return false; }
  }
  private async candidate(kind: Kind, epoch: number, cycle?: AutomaticCycle): Promise<Candidate | undefined> {
    this.log('Provider candidate callback started; not proof of discovery or connection', { candidate: kind, stage: 'factory' });
    const signal = this.cancellation.signal;
    const attempt = new AbortController();
    const cancel = () => attempt.abort(); signal.addEventListener('abort', cancel, { once: true }); this.metric('abortListeners', 1);
    let transport: ProviderTransport | undefined;
    const selection: SharedSelection = { deadline: this.clock.now() + PROVIDER_LIMITS.factoryMs, closed: false, busy: false, seen: new WeakSet(), signal: attempt.signal };
    const owner = new WeakRef(this), negotiate = sharedNegotiator(owner, epoch, selection);
    try {
      transport = await bounded(Promise.resolve().then(() => {
        if (attempt.signal.aborted || !this.current(epoch)) throw new Error('cancelled');
        if (cycle && !cycle.started) {
          this.failureNotBefore = this.clock.now() + PROVIDER_LIMITS.recoveryIntervalMs;
          cycle.started = true;
        }
        if (cycle?.selection === 'previous_owned' && kind === 'owned') this.metric('ownedRestarts', 1);
        this.metric(kind === 'shared' ? 'sharedAttempts' : 'ownedAttempts', 1);
        return kind === 'shared' ? this.options.tryShared(attempt.signal, negotiate) : this.options.acquireOwned(attempt.signal);
      }), this.clock,
        kind === 'shared' ? PROVIDER_LIMITS.factoryMs : PROVIDER_LIMITS.ownedFactoryMs, signal, owner,
        ProviderBroker.lateCandidateCloser(owner, kind));
      if (!transport) return undefined;
      if (!this.current(epoch)) { this.closeLateCandidate(transport, kind); return undefined; }
      if (kind === 'owned') {
        if (this.owned && this.owned !== transport) { await this.close(transport); this.unavailable('unproved_exit'); return undefined; }
        this.owned = transport; this.ownedGeneration = undefined;
      }
      if (transport.endReason !== undefined) throw new Error('candidate ended');
      if (kind === 'shared') {
        if (this.clock.now() >= selection.deadline) throw new Error('attempt expired');
        if (selection.selected && selection.selected.transport !== transport) throw new Error('candidate mismatch');
        if (!selection.selected && !await negotiate(transport)) return undefined;
        const selected = selection.selected;
        if (!selected || attempt.signal.aborted || !this.current(epoch) || this.clock.now() >= selection.deadline || transport.endReason !== undefined) throw new Error('retired');
        selection.transferred = new WeakRef(transport); return selected;
      }
      return await this.describeCandidate(transport, kind, epoch, attempt.signal, PROVIDER_LIMITS.controlMs);
    } catch (error) {
      attempt.abort();
      this.metric('candidatesRejected', 1);
      if (transport) {
        const exited = await this.close(transport);
        if (kind === 'owned' && !exited && this.current(epoch)) this.unavailable('unproved_exit');
      }
      if (kind === 'owned' && this.current(epoch) && !(error instanceof ExpectedOwnedUnavailable)) this.startupFailed();
      return undefined;
    } finally {
      // Even an aborted signal can retain a receiver through its reason's V8 stack.
      // Completed callbacks need only weak identity, not the old attempt signal.
      selection.closed = true; selection.signal = undefined;
      attempt.abort(); signal.removeEventListener('abort', cancel); this.metric('abortListeners', -1);
      const unused = selection.selected?.transport; selection.selected = undefined;
      if (unused && selection.transferred?.deref() !== unused) await this.close(unused);
    }
  }
  private async describeCandidate(transport: ProviderTransport, kind: Kind, epoch: number, signal: AbortSignal, ms: number): Promise<Candidate> {
    if (ms <= 0 || signal.aborted || !this.current(epoch) || transport.endReason !== undefined) throw new Error('retired');
    this.candidates.add(transport); this.counters.activeCandidates = this.candidates.size;
    const ticket = `broker:${this.id}:${++this.ticket}`, owner = new WeakRef(this);
    const raw = await bounded(Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('cancelled');
      owner.deref()?.metric('controls', 1);
      return transport.request({ v: PROTOCOL_VERSION, op: 'describe', ticket }, { signal, deadlineMs: ms });
    }), this.clock, ms, signal, owner);
    if (!this.current(epoch) || signal.aborted || transport.endReason !== undefined) throw new Error('retired');
    if (!metadataFits(raw)) throw new Error('metadata allowance');
    const description = decodeDescription(raw, ticket); this.metric('candidatesAccepted', 1);
    return { transport, kind, description };
  }
  /** Internal module-scoped weak factory only; no source or publication authority. */
  async negotiateShared(transport: ProviderTransport, epoch: number, signal: AbortSignal, selection: SharedSelection): Promise<boolean> {
    if (this.clock.now() >= selection.deadline) { if (!selection.seen.has(transport)) this.closeLateCandidate(transport, 'shared'); return false; }
    if (selection.seen.has(transport)) return selection.selected?.transport === transport;
    selection.seen.add(transport);
    if (selection.closed || selection.busy || selection.selected || signal.aborted || !this.current(epoch)) { this.closeLateCandidate(transport, 'shared'); return false; }
    selection.busy = true;
    try {
      const candidate = await this.describeCandidate(transport, 'shared', epoch, signal, Math.floor(Math.min(PROVIDER_LIMITS.controlMs, selection.deadline - this.clock.now())));
      if (selection.closed || signal.aborted || !this.current(epoch) || this.clock.now() >= selection.deadline) throw new Error('retired');
      selection.selected = candidate; return true;
    } catch { this.metric('candidatesRejected', 1); await this.close(transport); return false; }
    finally { selection.busy = false; }
  }
  private async runSelection(epoch: number, intent: AcquisitionIntent): Promise<void> {
    const automatic = intent.purpose === 'automatic_failure';
    const cycle: AutomaticCycle | undefined = automatic ? { started: false, selection: intent.selection } : undefined;
    const initial = intent.purpose === 'initial';
    const sharedAttempts = intent.selection === 'initial' ? 1
      : intent.selection === 'previous_shared' || intent.selection === 'handoff' ? PROVIDER_LIMITS.reconnectAttempts : 0;
    for (let i = 0; i < sharedAttempts && this.current(epoch); i++) {
      if (!initial) this.metric('reconnectAttempts', 1);
      const shared = await this.candidate('shared', epoch, cycle);
      if (!shared) continue;
      if (!this.current(epoch)) { await this.close(shared.transport); return; }
      if (!this.publish(shared)) { await this.close(shared.transport); continue; }
      if (initial && this.initialShared === undefined) this.initialShared = true;
      return;
    }
    if (!this.current(epoch)) return;
    if (initial && this.initialShared === undefined) this.initialShared = false;
    const owned = await this.candidate('owned', epoch, cycle);
    if (!this.current(epoch)) { if (owned) await this.close(owned.transport); return; }
    if (!owned || !this.publish(owned)) {
      if (owned) await this.close(owned.transport);
      if (intent.purpose !== 'automatic_failure') {
        this.intent = { purpose: 'automatic_failure', selection: intent.selection, cause: 'optional_unavailable' };
      }
      if (this.reason !== 'unproved_exit') this.unavailable(this.owned ? 'unproved_exit' : this.intentReason(this.intent ?? intent));
      return;
    }
    if (this.initialShared === true && this.recoveryEnd === 0 && intent.selection === 'previous_shared') this.beginRecovery(epoch);
    else this.scheduleRecovery(epoch);
  }
  private startupFailed(): void {
    diagnose(this.options.diagnostic, 'ERROR', 'occipital', 'Owned helper startup failed; exception payload is not recorded');
    reportRuntime(this.options.diagnostic, { kind: 'failure', scope: this, operation: 'startup', area: 'syntax', code: 'startup_failed' });
  }
  private beginRecovery(epoch: number) {
    this.log('Bounded shared-return episode started');
    this.metric('recoveryEpisodes', 1); this.recoveryStart = this.clock.now(); this.recoveryEnd = this.recoveryStart + PROVIDER_LIMITS.recoveryWindowMs;
    this.scheduleRecovery(epoch);
  }
  private cancelRecovery(preservePreference = false) {
    if (this.recoveryTimer) { this.recoveryTimer.cancel(); this.recoveryTimer = undefined; this.metric('liveTimers', -1); this.metric('recoveryTimers', -1); }
    if (!preservePreference) { this.recoveryStart = 0; this.recoveryEnd = 0; }
  }
  private scheduleRecovery(epoch: number) {
    if (!this.current(epoch) || this.active?.kind !== 'owned' || !this.recoveryEnd || this.recoveryTimer) return;
    const now = this.clock.now();
    const next = this.recoveryStart + (Math.floor((now - this.recoveryStart) / PROVIDER_LIMITS.recoveryIntervalMs) + 1) * PROVIDER_LIMITS.recoveryIntervalMs;
    if (next > this.recoveryEnd) return;
    this.metric('probesScheduled', 1); this.metric('recoveryTimers', 1); this.metric('liveTimers', 1);
    this.recoveryTimer = this.clock.setTimeout(ProviderBroker.recoveryTick(new WeakRef(this), epoch), next - now); this.recoveryTimer.unref();
  }
  private static recoveryTick(owner: WeakRef<ProviderBroker>, epoch: number): () => void {
    return () => { const broker = owner.deref(); if (!broker) return; broker.recoveryTimer = undefined; broker.metric('recoveryTimers', -1); broker.metric('liveTimers', -1);
      if (!broker.current(epoch) || !broker.recoveryEnd || broker.clock.now() > broker.recoveryEnd) return;
      void broker.probe(epoch).catch(ignored);
    };
  }
  private async probe(epoch: number): Promise<void> {
    if (this.counters.activeProbes || this.active?.kind !== 'owned') return;
    this.metric('activeProbes', 1); this.metric('probesStarted', 1);
    try {
      const shared = await this.candidate('shared', epoch);
      if (!shared) return;
      if (!this.current(epoch)) { await this.close(shared.transport); return; }
      const owned = this.active, generation = this.generation;
      if (!owned || owned.kind !== 'owned') { await this.close(shared.transport); return; }
      if (owned.transport.endReason !== undefined) {
        await this.transportEnded(generation, owned.transport.endReason);
        await this.close(shared.transport); return;
      }
      const recovery = { start: this.recoveryStart, end: this.recoveryEnd };
      this.intent = { purpose: 'automatic_failure', selection: 'handoff', cause: 'handoff' };
      this.cancelRecovery(true); this.retire('handoff'); this.notifyRetired(generation, 'handoff');
      const exited = await this.close(owned.transport);
      if (!this.current(epoch)) { await this.close(shared.transport); return; }
      if (!exited || this.owned === owned.transport) {
        this.metric('handoffsFailed', 1);
        await this.close(shared.transport);
        if (this.current(epoch)) this.unavailable('unproved_exit');
        return;
      }
      if (!this.publish(shared)) {
        this.metric('handoffsFailed', 1);
        await this.close(shared.transport);
        if (!this.current(epoch)) return;
        this.recoveryStart = recovery.start; this.recoveryEnd = recovery.end;
        const fallback = await this.candidate('owned', epoch);
        if (!this.current(epoch)) { if (fallback) await this.close(fallback.transport); return; }
        if (!fallback || !this.publish(fallback)) {
          if (fallback) await this.close(fallback.transport);
          this.unavailable(this.owned ? 'unproved_exit' : 'optional_unavailable'); return;
        }
        this.scheduleRecovery(epoch); return;
      }
      this.metric('handoffsSucceeded', 1); this.log('Shared return completed after owned helper exit');
    } finally {
      this.metric('activeProbes', -1); this.metric('probesCompleted', 1);
      if (this.current(epoch)) this.scheduleRecovery(epoch);
      this.opportunity(); this.completeWork();
    }
  }
}
