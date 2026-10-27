import { diagnose, diagnosticError, reportRuntime, type DiagnosticFields, type DiagnosticSink } from '../diagnostics.ts';
import type { ReplySize } from './data-json.ts';
import { ProtocolError } from './protocol.ts';
import { decodeSemanticDescription as decodeDescription, SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, type SemanticDescription as Description } from './semantic-protocol.ts';
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
  reconnectAttempts: 2, ownedRestarts: 2, recoveryIntervalMs: 60000, recoveryWindowMs: 600000,
  metadataBytes: 32768,
});
export interface ProviderTransport {
  /** Public transport lifetime. endReason is set before ended settles; cleanup
   * cannot rewrite its first origin. Neither signal proves a source did not run. */
  readonly ended: Promise<TransportEnd>;
  readonly endReason: TransportEnd | undefined;
  /** Physical lanes, including metadata whose caller stopped waiting. */
  readonly hasPendingRequests?: boolean;
  request(request: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineMs?: number; waitOnly?: boolean; acceptRetired?: boolean; replySize?: ReplySize }): Promise<unknown>;
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
  /** Coalesced availability/publication notice; no request outcome or replay authority. */
  onChange?: () => void;
  /** Published owned generation only, after actual successful child close/reap.
   * Shared disconnect, endReason, bounded-close failure and availability are not proof. */
  onOwnedStopped?: (generation: number) => void;
}
type Kind = 'shared' | 'owned';
type Availability = 'initializing' | 'ready' | 'transitioning' | 'unavailable' | 'disabled' | 'disposed';
type Reason = 'initializing' | 'ready' | 'proven_loss' | 'handoff' | 'optional_unavailable' | 'unproved_exit' | 'restart_limit' | 'transport_closed' | 'transport_uncertain' | 'transport_denied' | 'suspended' | 'disabled' | 'disposed';
export interface ProviderSnapshot {
  availability: Availability; reason: Reason; generation: number; kind?: Kind;
  initialShared: boolean | undefined; description?: Description;
}
export interface ProviderStats {
  sharedAttempts: number; ownedAttempts: number; reconnectAttempts: number; controls: number;
  ownedRestarts: number; ownedRestartStops: number; successfulClassifications: number;
  candidatesAccepted: number; candidatesRejected: number; activeCandidates: number;
  closesStarted: number; closesCompleted: number; closeFailures: number;
  recoveryEpisodes: number; probesScheduled: number; probesStarted: number; probesCompleted: number;
  activeProbes: number; recoveryTimers: number; liveTimers: number; abortListeners: number;
  handoffsSucceeded: number; handoffsFailed: number; sourceDispatches: number; styleDispatches: number; staleReplies: number;
}
interface Candidate { transport: ProviderTransport; kind: Kind; description: Description }
interface RecoveryTransition { cause: 'loss' | 'handoff'; kind: Kind; recovery: { start: number; end: number }; charged?: boolean }
interface SharedSelection {
  deadline: number; closed: boolean; busy: boolean; seen: WeakSet<ProviderTransport>; signal?: AbortSignal;
  selected?: Candidate; transferred?: WeakRef<ProviderTransport>;
}
function sharedNegotiator(owner: WeakRef<ProviderBroker>, epoch: number, selection: SharedSelection): SharedNegotiator {
  return transport => {
    const broker = owner.deref(), signal = selection.signal;
    if (!broker || selection.closed || !signal || signal.aborted) {
      if (selection.transferred?.deref() !== transport) closeLate(transport);
      return Promise.resolve(false);
    }
    return broker.negotiateShared(transport, epoch, signal, selection);
  };
}
const realClock: ProviderClock = {
  now: () => performance.now(),
  setTimeout(callback, ms) { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer), unref: () => { timer.unref(); } }; },
};
const ignored = () => {};
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
function ownedStopObserver(owner: WeakRef<ProviderBroker>, generation: number) {
  return (success: boolean) => { if (success) owner.deref()?.notifyOwnedStopped(generation); };
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
const controlCancelled = new Error('occipital control cancelled');
/** Separate scope, and shared non-receiver error: a retained raw RPC signal must
 * not retain the active broker through cancellation closures or an error stack. */
function controlAttempt(parent: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(controlCancelled);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  return { signal: controller.signal, dispose() { parent.removeEventListener('abort', abort); abort(); } };
}
function sameProfiles(a: Description, b: Description, labels = false): boolean {
  return a.profiles.length === b.profiles.length && a.profiles.every(profile =>
    b.profiles.some(other => profile.id === other.id && profile.fingerprint === other.fingerprint && (!labels || profile.label === other.label)));
}
/** Created outside publication scopes: a retained transport promise must never
 * retain the first broker/candidate through a V8 lexical receiver context. */
function lifetimeObservers(owner: WeakRef<ProviderBroker>, generation: number) {
  const end = (reason: TransportEnd) => { const broker = owner.deref(); if (broker) void broker.transportEnded(generation, reason).catch(ignored); };
  return { end, rejected: () => end('uncertain') };
}
let nextBroker = 0;

/** Provider lifetime only. No sources, queues, replay, leases, results, palette or
 * render-node callbacks. Only confirmed transport loss enters automatic failover;
 * timeout, uncertain/policy/owner closure and parser state reset grant no such authority.
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
  private resumeKind?: Kind;
  private suspendedRecovery?: { start: number; end: number };
  private transition?: RecoveryTransition;
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
  private consecutiveOwnedRestarts = 0;
  private readonly counters: ProviderStats = {
    sharedAttempts: 0, ownedAttempts: 0, reconnectAttempts: 0, controls: 0,
    ownedRestarts: 0, ownedRestartStops: 0, successfulClassifications: 0,
    candidatesAccepted: 0, candidatesRejected: 0, activeCandidates: 0,
    closesStarted: 0, closesCompleted: 0, closeFailures: 0,
    recoveryEpisodes: 0, probesScheduled: 0, probesStarted: 0, probesCompleted: 0,
    activeProbes: 0, recoveryTimers: 0, liveTimers: 0, abortListeners: 0,
    handoffsSucceeded: 0, handoffsFailed: 0, sourceDispatches: 0, styleDispatches: 0, staleReplies: 0,
  };
  constructor(options: ProviderOptions) {
    if (options.onChange !== undefined && typeof options.onChange !== 'function'
      || options.onOwnedStopped !== undefined && typeof options.onOwnedStopped !== 'function') throw new Error('invalid provider observer');
    this.options = options; this.clock = options.clock ?? realClock;
  }
  snapshot(): ProviderSnapshot {
    return { availability: this.availability, reason: this.reason, generation: this.generation,
      kind: this.active?.kind, initialShared: this.initialShared, description: this.active?.description };
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
  /** Receiver-free observer of the already-running operation, never a startup demand. */
  operationSettled(operation: Promise<void>): void {
    if (this.pendingOperation === operation) this.pendingOperation = undefined;
    this.completeWork();
  }
  start(): Promise<void> {
    if (!this.enabled || this.suspended || this.availability === 'disposed') return Promise.resolve();
    if (this.operation) return this.operation;
    const epoch = this.epoch;
    this.operation = this.trackOperation(this.select(epoch, true)); return this.operation;
  }
  /** Deliberate interruption is separate from timeout/loss and never enables a failed provider. */
  suspend(): number | undefined {
    if (this.suspended || this.availability === 'disposed') return;
    if (this.active?.transport.endReason !== undefined) void this.transportEnded(this.generation, this.active.transport.endReason).catch(ignored);
    const interrupted = this.active && (this.pendingRequests > 0 || this.active.transport.hasPendingRequests === true) ? this.generation : undefined;
    const recovering = this.availability === 'transitioning' && (this.reason === 'proven_loss' || this.reason === 'handoff');
    if (this.availability === 'transitioning' && !recovering) this.unavailable(this.reason);
    this.suspended = true; cancelCompletion(this.completion);
    this.resumeNeeded = this.enabled && (this.availability === 'initializing' || recovering || interrupted !== undefined);
    this.resumeKind = this.active?.kind ?? this.transition?.kind ?? this.resumeKind;
    this.suspendedRecovery = this.transition?.recovery ?? { start: this.recoveryStart, end: this.recoveryEnd };
    ++this.epoch; this.cancelRecovery(); this.cancellation.abort();
    if (this.resumeNeeded) {
      if (this.active) this.candidates.add(this.active.transport);
      this.retire('suspended');
    }
    const pending = [...this.candidates].map(transport => this.close(transport));
    this.operation = this.trackOperation(Promise.all(pending).then(ignored));
    return interrupted;
  }
  resume(): Promise<void> {
    if (!this.suspended || this.availability === 'disposed') return this.operation ?? Promise.resolve();
    this.suspended = false;
    this.cancellation = new AbortController();
    const recovery = this.suspendedRecovery; this.suspendedRecovery = undefined;
    if (recovery) { this.recoveryStart = recovery.start; this.recoveryEnd = recovery.end; }
    const needed = this.resumeNeeded; this.resumeNeeded = false;
    if (!this.enabled) return this.operation ?? Promise.resolve();
    if (!needed) {
      if (this.active?.transport.endReason !== undefined) return this.transportEnded(this.generation, this.active.transport.endReason);
      this.scheduleRecovery(this.epoch); return this.operation ?? Promise.resolve();
    }
    this.availability = 'initializing'; this.reason = 'suspended'; this.changed();
    this.operation = this.trackOperation(this.enable(this.epoch, true)); return this.operation;
  }
  /** Receiver-free request settlement must not debit a replacement generation. */
  requestSettled(generation: number): void { if (generation === this.generation) this.pendingRequests--; this.completeWork(); }

  /** Session-local activation; ordinary start/status never changes this choice. */
  setEnabled(enabled: boolean): Promise<void> {
    if (this.availability === 'disposed') return this.shutdown ?? Promise.resolve();
    if (this.enabled === enabled) return this.operation ?? Promise.resolve();
    cancelCompletion(this.completion);
    this.enabled = enabled; this.resumeNeeded = enabled && this.suspended; this.transition = undefined;
    this.resumeKind = undefined; this.suspendedRecovery = undefined;
    const epoch = ++this.epoch;
    this.cancelRecovery(); this.cancellation.abort();
    if (this.active) this.candidates.add(this.active.transport);
    this.pendingRequests = 0; this.active = undefined; ++this.generation;
    if (!enabled) {
      reportRuntime(this.options.diagnostic, { kind: 'released', scope: this, operation: 'startup' });
      this.availability = 'disabled'; this.reason = 'disabled'; this.changed();
      const pending = [...this.candidates].map(transport => this.close(transport));
      this.operation = this.trackOperation(Promise.all([...pending, ...this.pendingCloses]).then(ignored));
    } else {
      this.cancellation = new AbortController(); this.consecutiveOwnedRestarts = 0;
      this.availability = 'initializing'; this.reason = 'initializing'; this.changed();
      this.operation = this.trackOperation(this.suspended ? Promise.resolve() : this.enable(epoch));
    }
    return this.operation;
  }
  private async enable(epoch: number, resumed = false): Promise<void> {
    // A known child must actually exit before even verified shared source authority
    // can be published. Pending acquisition/spawn cleanup remains factory-owned.
    if (this.owned) {
      let exited = false;
      try { exited = await bounded(closeResource(this.owned), this.clock, PROVIDER_LIMITS.closeMs,
        this.cancellation.signal, new WeakRef(this)); } catch { /* No exit proof. */ }
      if (!this.current(epoch)) return;
      if (!exited) { this.unavailable('unproved_exit'); return; }
      this.owned = undefined;
    }
    if (!this.current(epoch)) return;
    if (resumed && this.transition) await this.continueRecovery(epoch, this.transition);
    else if (resumed && this.resumeKind === 'owned') await this.takeOwned(epoch, false);
    else {
      const reconnect = resumed && this.resumeKind === 'shared';
      await this.select(epoch, !reconnect, reconnect ? PROVIDER_LIMITS.reconnectAttempts : 1, reconnect);
    }
  }
  /** Caller must supply actual channel/process-loss proof for this generation.
   * Rejections/latency/closed stats/remote state resets are not proof. Coalesced;
   * stale events cannot act on replacement ownership.
   */
  provenLoss(generation: number): Promise<void> {
    if (!this.isReady(generation)) return Promise.resolve();
    const previous = this.active!;
    const recovery = { start: this.recoveryStart, end: this.recoveryEnd };
    this.cancelRecovery(); this.cancellation.abort(); this.cancellation = new AbortController();
    const epoch = ++this.epoch; this.retire('proven_loss');
    this.transition = { cause: 'loss', kind: previous.kind, recovery };
    this.operation = this.trackOperation(this.recover(epoch, previous, this.transition)); return this.operation;
  }
  /** Internal public-lifetime delivery, bound to one published generation only.
   * Uncertain/policy/owner closure invalidates availability but grants no replay. */
  transportEnded(generation: number, reason: TransportEnd): Promise<void> {
    if (!this.isReady(generation)) return Promise.resolve();
    if (reason === 'lost') return this.provenLoss(generation);
    const previous = this.active!;
    this.cancelRecovery(); this.cancellation.abort(); this.cancellation = new AbortController();
    const epoch = ++this.epoch, unavailable = `transport_${reason}` as Reason;
    this.retire(unavailable); this.transition = undefined;
    this.operation = this.trackOperation(this.finishEnd(epoch, previous, unavailable)); return this.operation;
  }
  private async finishEnd(epoch: number, previous: Candidate, reason: Reason): Promise<void> {
    const closed = await this.close(previous.transport);
    if (this.current(epoch)) this.unavailable(previous.kind === 'owned' && !closed ? 'unproved_exit' : reason);
  }
  /** Source owner reports a fully validated native classification, not metadata,
   * a raw RPC success, cached colors or a retired generation. This alone resets
   * the operator-selected two-restart crash chain; the broker never decodes sources. */
  classificationAccepted(generation: number): boolean {
    if (!this.isReady(generation)) return false;
    this.consecutiveOwnedRestarts = 0; this.metric('successfulClassifications', 1); return true;
  }
  /** Generation-bound passthrough, no retries/queue/source storage. Caller owns
   * source admission/decoder and unique tickets (reserved broker: prefix excluded).
   * Transport owns source deadlines/cancellation and its existing data allowance.
   */
  request(generation: number, request: Record<string, unknown>, options?: { signal?: AbortSignal; deadlineMs?: number; replySize?: ReplySize;
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
  /** Source-free control on the already selected provider. Catalogue publication
   * changes metadata, not transport/source authority; unrelated streams survive.
   * A timeout is not loss proof and never closes or replaces the provider. */
  async catalogue(generation: number, op: 'describe' | 'themes.refresh'): Promise<Description> {
    if (!this.isReady(generation) || op !== 'describe' && op !== 'themes.refresh')
      throw new RequestFailure('occipital catalogue unavailable', 'not_started');
    const active = this.active!, attempt = controlAttempt(this.cancellation.signal);
    const ticket = `broker:${this.id}:${++this.ticket}`, deadline = this.clock.now() + PROVIDER_LIMITS.controlMs;
    this.metric('abortListeners', 1); this.pendingRequests++;
    try {
      this.metric('controls', 1);
      const raw = await bounded(Promise.resolve().then(() => {
        if (!this.isReady(generation) || attempt.signal.aborted || this.clock.now() >= deadline)
          throw new RequestFailure('occipital catalogue retired', 'not_started');
        return active.transport.request({ v: PROTOCOL_VERSION, ticket, op }, { signal: attempt.signal, deadlineMs: PROVIDER_LIMITS.controlMs, waitOnly: true });
      }), this.clock, PROVIDER_LIMITS.controlMs, attempt.signal, new WeakRef(this));
      if (!this.isReady(generation) || this.active !== active || attempt.signal.aborted || this.clock.now() >= deadline)
        throw new RequestFailure('occipital catalogue retired');
      if (!metadataFits(raw)) throw new ProtocolError('invalid_descriptor');
      const description = decodeDescription(raw, ticket), previous = active.description;
      if (description.instance !== previous.instance || description.assets !== previous.assets
        || description.vocabulary.fingerprint !== previous.vocabulary.fingerprint || description.vocabulary.count !== previous.vocabulary.count)
        throw new ProtocolError('provider_changed');
      if (description.catalogue_revision < previous.catalogue_revision || description.catalogue_revision === previous.catalogue_revision && !sameProfiles(description, previous))
        throw new ProtocolError('invalid_descriptor');
      active.description = description;
      if (description.catalogue_revision !== previous.catalogue_revision || description.diagnostic !== previous.diagnostic || !sameProfiles(description, previous, true)) this.changed();
      return description;
    } finally { attempt.dispose(); this.metric('abortListeners', -1); this.requestSettled(generation); }
  }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    cancelCompletion(this.completion);
    ++this.epoch; this.cancelRecovery(); this.cancellation.abort();
    reportRuntime(this.options.diagnostic, { kind: 'released', scope: this, operation: 'startup' });
    const transports = new Set(this.candidates); if (this.active) transports.add(this.active.transport);
    this.transition = undefined; this.resumeKind = undefined; this.pendingRequests = 0; this.active = undefined; ++this.generation; this.availability = 'disposed'; this.reason = 'disposed';
    const pending = [...transports].map(transport => this.close(transport));
    this.shutdown = Promise.all([...pending, ...this.pendingCloses]).then(ignored);
    return this.shutdown;
  }
  private current(epoch: number): boolean { return this.enabled && !this.suspended && this.epoch === epoch && this.availability !== 'disposed'; }
  private retire(reason: Reason) { this.pendingRequests = 0; this.active = undefined; ++this.generation; this.availability = 'transitioning'; this.reason = reason; this.changed(); }
  private publish(candidate: Candidate): boolean {
    if (candidate.transport.endReason !== undefined) return false;
    this.candidates.delete(candidate.transport); this.counters.activeCandidates = this.candidates.size;
    this.transition = undefined; this.resumeKind = undefined; this.pendingRequests = 0; this.active = candidate; ++this.generation; this.availability = 'ready'; this.reason = 'ready';
    reportRuntime(this.options.diagnostic, { kind: 'recovered', scope: this, operation: 'startup' });
    if (candidate.kind === 'owned') this.ownedGeneration = this.generation;
    const observers = lifetimeObservers(new WeakRef(this), this.generation);
    void candidate.transport.ended.then(observers.end, observers.rejected);
    this.changed(); return true;
  }
  private unavailable(reason: Reason) {
    this.transition = undefined; this.resumeKind = undefined;
    const changed = this.availability !== 'unavailable' || this.reason !== reason;
    this.availability = 'unavailable'; this.reason = reason; if (changed) this.changed();
  }
  private log(explanation: string, fields?: DiagnosticFields): void { if (this.options.diagnostic) diagnose(this.options.diagnostic, 'INFO', 'occipital', explanation,
    { generation: this.generation, kind: this.active?.kind, ...fields }); }
  private changed(): void {
    this.log('Provider publication changed', { availability: this.availability, reason: this.reason, version: this.active?.description.backend_version,
      pid: this.active?.description.runtime.pid });
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
  private close(transport: ProviderTransport): Promise<boolean> {
    this.candidates.delete(transport); this.counters.activeCandidates = this.candidates.size;
    const existing = this.cleanup.get(transport); if (existing) return existing;
    const generation = transport === this.owned ? this.ownedGeneration : undefined;
    const pending = this.awaitClose(transport); this.cleanup.set(transport, pending);
    // Observe the actual cleanup promise, not the bounded wait: a late successful
    // reap remains proof for the OLD generation only, without starting recovery.
    if (generation !== undefined) void closeResource(transport).then(ownedStopObserver(new WeakRef(this), generation));
    this.pendingCloses.add(pending); void pending.then(() => { this.pendingCloses.delete(pending); });
    return pending;
  }
  private async awaitClose(transport: ProviderTransport): Promise<boolean> {
    if (!closings.has(transport)) this.metric('closesStarted', 1);
    try {
      const success = await bounded(closeResource(transport), this.clock, PROVIDER_LIMITS.closeMs, undefined, new WeakRef(this));
      this.metric(success ? 'closesCompleted' : 'closeFailures', 1);
      this.log(success ? 'Provider cleanup completed' : 'Provider cleanup wait expired; not exit proof', { owned: transport === this.owned }); return success;
    } catch (error) { this.metric('closeFailures', 1); this.log('Provider cleanup failed; not exit proof', { code: diagnosticError(error) }); return false; }
  }
  private async candidate(kind: Kind, epoch: number): Promise<Candidate | undefined> {
    this.log('Provider candidate callback started; not proof of discovery or connection', { candidate: kind, stage: 'factory' });
    const signal = this.cancellation.signal;
    const attempt = new AbortController();
    const cancel = () => attempt.abort(); signal.addEventListener('abort', cancel, { once: true }); this.metric('abortListeners', 1);
    let transport: ProviderTransport | undefined;
    const selection: SharedSelection = { deadline: this.clock.now() + PROVIDER_LIMITS.factoryMs, closed: false, busy: false, seen: new WeakSet(), signal: attempt.signal };
    const negotiate = sharedNegotiator(new WeakRef(this), epoch, selection);
    this.metric(kind === 'shared' ? 'sharedAttempts' : 'ownedAttempts', 1);
    try {
      transport = await bounded(Promise.resolve().then(() => {
        if (attempt.signal.aborted) throw new Error('cancelled');
        return kind === 'shared' ? this.options.tryShared(attempt.signal, negotiate) : this.options.acquireOwned(attempt.signal);
      }), this.clock,
        kind === 'shared' ? PROVIDER_LIMITS.factoryMs : PROVIDER_LIMITS.ownedFactoryMs, signal, new WeakRef(this), closeLate);
      if (!transport) return undefined;
      if (!this.current(epoch)) { closeLate(transport); return undefined; }
      if (kind === 'owned') { this.owned = transport; this.ownedGeneration = undefined; }
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
    if (this.clock.now() >= selection.deadline) { if (!selection.seen.has(transport)) closeLate(transport); return false; }
    if (selection.seen.has(transport)) return selection.selected?.transport === transport;
    selection.seen.add(transport);
    if (selection.closed || selection.busy || selection.selected || signal.aborted || !this.current(epoch)) { closeLate(transport); return false; }
    selection.busy = true;
    try {
      const candidate = await this.describeCandidate(transport, 'shared', epoch, signal, Math.floor(Math.min(PROVIDER_LIMITS.controlMs, selection.deadline - this.clock.now())));
      if (selection.closed || signal.aborted || !this.current(epoch) || this.clock.now() >= selection.deadline) throw new Error('retired');
      selection.selected = candidate; return true;
    } catch { this.metric('candidatesRejected', 1); await this.close(transport); return false; }
    finally { selection.busy = false; }
  }
  private async select(epoch: number, initial: boolean, sharedAttempts = 1, beginEpisode = true): Promise<void> {
    for (let i = 0; i < sharedAttempts && this.current(epoch); i++) {
      if (!initial) this.metric('reconnectAttempts', 1);
      const shared = await this.candidate('shared', epoch);
      if (shared) {
        if (!this.current(epoch)) { await this.close(shared.transport); return; }
        if (!this.publish(shared)) { await this.close(shared.transport); continue; }
        if (initial && this.initialShared === undefined) this.initialShared = true;
        return;
      }
    }
    if (!this.current(epoch)) return;
    if (initial && this.initialShared === undefined) this.initialShared = false;
    await this.takeOwned(epoch, beginEpisode);
  }
  private startupFailed(): void {
    diagnose(this.options.diagnostic, 'ERROR', 'occipital', 'Owned helper startup failed; exception payload is not recorded');
    reportRuntime(this.options.diagnostic, { kind: 'failure', scope: this, operation: 'startup', area: 'syntax', code: 'startup_failed' });
  }
  private async takeOwned(epoch: number, beginEpisode = true): Promise<void> {
    const owned = await this.candidate('owned', epoch);
    if (!this.current(epoch)) { if (owned) await this.close(owned.transport); return; }
    if (!owned) { if (this.reason !== 'unproved_exit') this.unavailable('optional_unavailable'); return; }
    if (!this.publish(owned)) {
      const exited = await this.close(owned.transport);
      if (this.current(epoch)) { this.startupFailed(); this.unavailable(exited ? 'optional_unavailable' : 'unproved_exit'); }
      return;
    }
    if (this.initialShared && beginEpisode) this.beginRecovery(epoch);
    else if (!beginEpisode) this.scheduleRecovery(epoch);
  }
  private async recover(epoch: number, previous: Candidate, transition: RecoveryTransition): Promise<void> {
    const closed = await this.close(previous.transport);
    if (!this.current(epoch)) return;
    if (previous.kind === 'owned' && !closed) { this.unavailable('unproved_exit'); return; }
    await this.continueRecovery(epoch, transition);
  }
  private async continueRecovery(epoch: number, transition: RecoveryTransition): Promise<void> {
    const { recovery } = transition;
    this.recoveryStart = recovery.start; this.recoveryEnd = recovery.end;
    if (transition.cause === 'handoff') await this.select(epoch, false, PROVIDER_LIMITS.reconnectAttempts, false);
    else if (transition.kind === 'shared') await this.select(epoch, false, PROVIDER_LIMITS.reconnectAttempts);
    else {
      if (!transition.charged && this.consecutiveOwnedRestarts >= PROVIDER_LIMITS.ownedRestarts) {
        this.log('Owned restart budget exhausted; awaiting deliberate re-enable', { attempts: this.consecutiveOwnedRestarts });
        this.metric('ownedRestartStops', 1); this.unavailable('restart_limit'); return;
      }
      if (!transition.charged) {
        transition.charged = true; this.consecutiveOwnedRestarts++; this.metric('ownedRestarts', 1);
        this.log('Restarting after confirmed owned process loss and cleanup', { attempt: this.consecutiveOwnedRestarts });
      }
      await this.takeOwned(epoch, false);
    }
  }
  private beginRecovery(epoch: number) {
    this.log('Bounded shared-return episode started');
    this.metric('recoveryEpisodes', 1); this.recoveryStart = this.clock.now(); this.recoveryEnd = this.recoveryStart + PROVIDER_LIMITS.recoveryWindowMs;
    this.scheduleRecovery(epoch);
  }
  private cancelRecovery() {
    if (this.recoveryTimer) { this.recoveryTimer.cancel(); this.recoveryTimer = undefined; this.metric('liveTimers', -1); this.metric('recoveryTimers', -1); }
    this.recoveryEnd = 0;
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
      const owned = this.active;
      if (!owned || owned.kind !== 'owned') { await this.close(shared.transport); return; }
      const recovery = { start: this.recoveryStart, end: this.recoveryEnd };
      this.cancelRecovery(); this.retire('handoff');
      this.transition = { cause: 'handoff', kind: 'owned', recovery };
      const exited = await this.close(owned.transport);
      if (!this.current(epoch)) { await this.close(shared.transport); return; }
      if (!exited) {
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
        await this.takeOwned(epoch, false);
        return;
      }
      this.metric('handoffsSucceeded', 1); this.log('Shared return completed after owned helper exit');
    } finally {
      this.metric('activeProbes', -1); this.metric('probesCompleted', 1);
      if (this.current(epoch)) this.scheduleRecovery(epoch);
      this.completeWork();
    }
  }
}
