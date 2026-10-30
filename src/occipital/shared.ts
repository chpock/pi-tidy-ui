import { SEMANTIC_CAPABILITY, SEMANTIC_PROTOCOL_VERSION, SEMANTIC_OPERATIONS } from './semantic-protocol.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { dataJsonBytes, type ReplySize } from './data-json.ts';
import { RequestFailure } from './request-failure.ts';
import type { TransportEnd } from './transport-end.ts';

const DATA_BYTES = HIGHLIGHT_LIMITS.dataWireBytes;
export const SHARED_LIMITS = Object.freeze({
  dataCalls: 2, controlCalls: 1,
  requestBytes: DATA_BYTES, replyBytes: DATA_BYTES,
  controlRequestBytes: 4096, controlReplyBytes: 32768,
  dataReservationBytes: 4 * DATA_BYTES, controlReservationBytes: 65536,
});

/** Structural public SDK0.21.1 seam. Keep the returned complete handle, never reconstruct it. */
export interface SharedRouteHandle { readonly channel: number; readonly epoch: number }
export interface SharedClient {
  resolveProvider(capability: string): Promise<string>;
  routeOpen(target: { kind: 'internal_service'; module_id: string; service_id: string }, identity: SharedIdentity, options: { consumerIdentity: null }): Promise<SharedRouteHandle>;
  request(handle: SharedRouteHandle, body: Uint8Array, options: { binary: false; timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  closeRoute(handle: SharedRouteHandle): Promise<void>;
  close(): void;
}
type SdkErrorClass = new (...args: never[]) => Error;
export interface SharedSdk {
  /** Public SDK classes, not message/code guesses. Optional for structural fixtures. */
  SubcError?: SdkErrorClass;
  StaleRouteHandleError?: SdkErrorClass;
  SocketClosedError?: SdkErrorClass;
  isEstablishedRouteDead?(flags: number, code: string | undefined): boolean;
  SubcClient: { connect(options: { connectionFile: string; handshakeTimeoutMs: number; onControlPush: (push: { op: string; body: Record<string, unknown> }) => void }): Promise<SharedClient> };
}
export interface SharedIdentity { project_root: string; harness: string; session: string }
export interface SharedOptions {
  /** Explicit supported connection file only; SDK owns file validation/authentication. */
  connectionFile: string;
  identity: SharedIdentity;
  initDeadlineMs: number;
  requestDeadlineMs: number;
  loadSdk?: () => Promise<SharedSdk>;
  /** Optional narrower transport allowance; never expands the production family. */
  dataBytes?: number;
}
export interface SharedRequestOptions {
  signal?: AbortSignal; deadlineMs?: number;
  /** Call-local receipt, populated only for the correlated, admitted reply. */
  replySize?: ReplySize;
  /** Deliver terminal evidence to its canonical owner even after local cancellation. */
  acceptRetired?: boolean;
  /** Published-provider metadata only: expire the waiter, not the connection. */
  waitOnly?: boolean;
}
export interface SharedStats {
  state: 'initializing' | 'ready' | 'closed';
  unsettledData: number;
  unsettledControl: number;
  /** Application allowances, NOT JS heap, SDK writer credit, or process RSS. */
  dataReservedBytes: number;
  controlReservedBytes: number;
  /** Encoded bodies handed to SDK requests still owned until settlement/connection close. */
  encodedRequestBytes: number;
  serializedRequests: number;
  serializedBytes: number;
  liveTimers: number;
  /** Component listeners only; SDK's CANCEL listener is separately SDK-owned. */
  abortListeners: number;
}
interface Connection { client: SharedClient; closed: boolean }
interface Pending {
  replySize?: ReplySize;
  control: boolean;
  waitOnly: boolean;
  acceptRetired: boolean;
  waitExpired: boolean;
  bytes: number;
  credit: number;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  aborted: boolean;
  resolve: (reply: unknown) => void;
  reject: (error: Error) => void;
}
class SharedError extends RequestFailure {}
const operations: ReadonlySet<string> = new Set(SEMANTIC_OPERATIONS);
const ignoreRejection = () => {};
const uncertainEnd = (): TransportEnd => 'uncertain';
function routeEnd(reason: unknown): TransportEnd {
  if (reason === 'connection_lost' || reason === 'reload' || reason === 'restart' || reason === 'crash') return 'lost';
  if (reason === 'closed_by_caller') return 'closed';
  return 'denied';
}
/** Factory contains SDK authority only, never an owner or request/source. */
function failureEnd(sdk: SharedSdk): (error: unknown) => TransportEnd {
  return error => {
    try {
      if (sdk.StaleRouteHandleError && error instanceof sdk.StaleRouteHandleError
        || sdk.SocketClosedError && error instanceof sdk.SocketClosedError) return 'lost';
      if (sdk.SubcError && error instanceof sdk.SubcError) {
        const reason = Object.getOwnPropertyDescriptor(error, 'closeReason');
        if (reason && 'value' in reason && reason.value !== undefined) {
          // SDK fail() erases the read-loop cause for pending route requests:
          // local SocketTimeoutError and real EOF both become connection_lost.
          return reason.value === 'connection_lost' ? 'uncertain' : routeEnd(reason.value);
        }
        const code = Object.getOwnPropertyDescriptor(error, 'code');
        // SDK0.21.1's public helper ignores its origin-flags argument.
        if (code && 'value' in code && typeof code.value === 'string'
          && sdk.isEstablishedRouteDead?.(0, code.value)) return 'lost';
      }
    } catch { /* An unusable classifier is not loss proof. */ }
    return 'uncertain';
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown, cap = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
    && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function duration(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw new SharedError('shared invalid options deadline');
  return value;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** Count plain JSON before stringify, including escapes, without a source-sized temporary. */
function encodeRequest(request: Record<string, unknown>, cap: number): Uint8Array {
  let count: number;
  try { count = dataJsonBytes(request, cap, true); }
  catch (error) {
    throw new SharedError(error instanceof Error && error.message === 'data JSON byte limit'
      ? 'shared request byte limit' : 'shared invalid request JSON');
  }
  const json = JSON.stringify(request);
  if (Buffer.byteLength(json) !== count) throw new SharedError('shared invalid request JSON');
  return Buffer.from(json, 'utf8');
}
async function defaultLoader(): Promise<SharedSdk> {
  // Variable specifier deliberately avoids a mandatory install/type dependency.
  const specifier = '@cortexkit/subc-client';
  return await import(specifier) as SharedSdk;
}
function closeConnection(connection: Connection) {
  if (connection.closed) return;
  connection.closed = true;
  try { connection.client.close(); } catch { /* Public close is synchronous and best effort. */ }
}
function closeRoute(connection: Connection, handle: SharedRouteHandle) {
  try { void connection.client.closeRoute(handle).catch(ignoreRejection); } catch { /* Connection may already be closed. */ }
}

/**
 * Dedicated consumer only; no discovery, managed calls, restart, or daemon ownership.
 * Caller tickets MUST be unique for this provider incarnation (no lifetime history).
 * SDK request bytes use public Uint8Array + binary:false, bypassing its stringify.
 * SDK encodeFrame copies the body; its write callback may outlive the reply. SDK
 * ingress copies and JSON decode occur BEFORE validation here; native response caps
 * are authoritative. These transients/decoded heap are separate from local credit.
 */
export class SharedTransport {
  readonly ended: Promise<TransportEnd>;
  private resolveEnded!: (reason: TransportEnd) => void;
  private ending?: TransportEnd;
  get endReason(): TransportEnd | undefined { return this.ending; }
  private classifyFailure: (error: unknown) => TransportEnd = uncertainEnd;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private state: SharedStats['state'] = 'initializing';
  private connection?: Connection;
  private route?: SharedRouteHandle;
  private module?: string;
  private pending = new Map<string, Pending>();
  private initTimer?: NodeJS.Timeout;
  private deadlineMs: number;
  private serializations = 0;
  private serializedBytes = 0;
  private closed = Promise.resolve();

  private readonly dataBytes: number;
  private readonly dataReservation: number;

  constructor(options: SharedOptions) {
    this.dataBytes = options.dataBytes ?? DATA_BYTES;
    if (!Number.isSafeInteger(this.dataBytes) || this.dataBytes < 1 || this.dataBytes > DATA_BYTES) throw new SharedError('shared invalid data allowance');
    this.dataReservation = 4 * this.dataBytes;
    if (!identifier(options.connectionFile, 4096) || !record(options.identity)
      || !identifier(options.identity.project_root, 4096) || !identifier(options.identity.harness, 256)
      || !identifier(options.identity.session, 256)) throw new SharedError('shared invalid options');
    const initMs = duration(options.initDeadlineMs);
    this.deadlineMs = duration(options.requestDeadlineMs);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ended = new Promise(resolve => { this.resolveEnded = resolve; });
    // A consumer may inspect stats or close without awaiting initialization.
    void this.ready.catch(ignoreRejection);
    const owner = new WeakRef(this);
    this.initTimer = SharedTransport.initializationTimer(owner, initMs);
    this.initTimer.unref();
    const identity = { project_root: options.identity.project_root, harness: options.identity.harness, session: options.identity.session };
    void SharedTransport.initialize(owner, options.loadSdk ?? defaultLoader, options.connectionFile, identity, initMs);
  }

  request(request: Record<string, unknown>, options: SharedRequestOptions = {}): Promise<unknown> {
    try {
      if (this.state !== 'ready' || !this.connection || !this.route) throw new SharedError('shared not ready');
      const deadlineMs = duration(options.deadlineMs ?? this.deadlineMs);
      const ticket = record(request) ? field(request, 'ticket') : undefined;
      const op = record(request) ? field(request, 'op') : undefined;
      if (!record(request) || field(request, 'v') !== SEMANTIC_PROTOCOL_VERSION || !identifier(ticket)
        || typeof op !== 'string' || !operations.has(op) || Object.hasOwn(request, 'cancel')) throw new SharedError('shared invalid request header');
      if (this.pending.has(ticket)) throw new SharedError('shared active duplicate ticket');
      if (options.signal?.aborted) throw new SharedError('shared aborted before dispatch');
      const control = op === 'describe', stats = this.stats();
      if (options.waitOnly && !control) throw new SharedError('shared wait-only requires control');
      if (control ? stats.unsettledControl >= 1 : stats.unsettledData >= 2) throw new SharedError('shared request capacity');
      const bytes = encodeRequest(request, control ? SHARED_LIMITS.controlRequestBytes : this.dataBytes);
      const credit = control ? SHARED_LIMITS.controlReservationBytes : bytes.byteLength + this.dataBytes;
      if (!control && stats.dataReservedBytes + credit > this.dataReservation) throw new SharedError('shared byte capacity');
      this.serializations = Math.min(Number.MAX_SAFE_INTEGER, this.serializations + 1);
      this.serializedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.serializedBytes + bytes.byteLength);
      return SharedTransport.dispatch(new WeakRef(this), this.connection.client, this.route, ticket, bytes, control, credit, deadlineMs, options.signal, options.waitOnly === true, options.acceptRetired === true, options.replySize);
    } catch (error) {
      const message=error instanceof SharedError?error.message:'shared invalid request JSON';
      return Promise.reject(new SharedError(message,'not_started'));
    }
  }

  close(): Promise<void> { this.retire(new SharedError('shared closed'), 'closed'); return this.closed; }

  get hasPendingRequests(): boolean { return this.pending.size > 0; }

  stats(): SharedStats {
    let data = 0, control = 0, dataBytes = 0, controlBytes = 0, encoded = 0, timers = this.initTimer ? 1 : 0, listeners = 0;
    for (const call of this.pending.values()) {
      if (call.control) { control++; controlBytes += call.credit; } else { data++; dataBytes += call.credit; }
      encoded += call.bytes; if (call.timer) timers++; if (call.onAbort) listeners++;
    }
    return { state: this.state, unsettledData: data, unsettledControl: control, dataReservedBytes: dataBytes,
      controlReservedBytes: controlBytes, encodedRequestBytes: encoded, serializedRequests: this.serializations,
      serializedBytes: this.serializedBytes, liveTimers: timers, abortListeners: listeners };
  }

  private static initializationTimer(owner: WeakRef<SharedTransport>, ms: number) {
    return setTimeout(() => owner.deref()?.retire(new SharedError('shared initialization deadline')), ms);
  }

  private static controlObserver(owner: WeakRef<SharedTransport>) {
    return (push: { op: string; body: Record<string, unknown> }) => owner.deref()?.observe(push);
  }

  private static requestTimer(owner: WeakRef<SharedTransport>, ticket: string, ms: number) {
    return setTimeout(() => owner.deref()?.expire(ticket), ms);
  }
  private expire(ticket: string) {
    const call = this.pending.get(ticket);
    if (!call || this.state !== 'ready') return;
    if (!call.waitOnly) { this.retire(new SharedError('shared request deadline; outcome uncertain')); return; }
    call.timer = undefined; call.waitExpired = true; call.aborted = true; detachAbort(call);
    call.reject(new SharedError('shared control wait deadline'));
    // SDK settlement still owns the control lane/encoded bytes, not this waiter.
    call.resolve = ignoreRejection; call.reject = ignoreRejection;
  }
  private static requestObservers(owner: WeakRef<SharedTransport>, ticket: string) {
    return {
      reply: (value: unknown) => owner.deref()?.settle(ticket, value),
      failed: (error: unknown) => owner.deref()?.requestFailed(ticket, error),
    };
  }

  // Factory scope contains no caller request/source; drop the temporary byte alias
  // after the public SDK has taken it. SDK-owned copies remain outside our counters.
  private static dispatch(owner: WeakRef<SharedTransport>, client: SharedClient, route: SharedRouteHandle, ticket: string,
    bytes: Uint8Array | undefined, control: boolean, credit: number, deadlineMs: number, signal?: AbortSignal, waitOnly = false, acceptRetired = false, replySize?: ReplySize): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const call: Pending = { replySize, control, waitOnly, acceptRetired, waitExpired: false, bytes: bytes!.byteLength, credit, aborted: false, resolve, reject, signal };
      call.timer = SharedTransport.requestTimer(owner, ticket, deadlineMs);
      call.timer.unref(); owner.deref()!.pending.set(ticket, call);
      if (signal) {
        call.onAbort = abortObserver(call);
        signal.addEventListener('abort', call.onAbort, { once: true });
      }
      try {
        // The public SDK signal sends CANCEL but does not settle the promise.
        const result = client.request(route, bytes!, { binary: false, timeoutMs: deadlineMs, signal });
        bytes = undefined;
        const observers = SharedTransport.requestObservers(owner, ticket);
        void result.then(observers.reply, observers.failed).catch(ignoreRejection);
      } catch (error) { bytes = undefined; owner.deref()?.requestFailed(ticket, error); }
    });
  }

  private requestFailed(ticket: string, error: unknown) {
    if (this.state === 'closed') return;
    const call = this.pending.get(ticket); if (!call) return;
    const ending = this.classifyFailure(error);
    if (call.waitExpired && ending === 'uncertain') {
      // This metadata waiter already timed out. The actual SDK promise has now
      // settled; release only its local ownership. No message/code timeout guess,
      // and explicit route/socket loss or denial still retires normally below.
      this.pending.delete(ticket); release(call); return;
    }
    this.retire(new SharedError('shared request failed; outcome uncertain'), ending);
  }

  /** Internal lifecycle seams used only by the weak initialization factory. */
  private acceptSdk(sdk: SharedSdk): boolean {
    if (this.state !== 'initializing') return false;
    this.classifyFailure = failureEnd(sdk); return true;
  }
  private acceptConnection(connection: Connection): boolean {
    if (this.state !== 'initializing') { closeConnection(connection); return false; }
    this.connection = connection; return true;
  }
  private acceptRoute(connection: Connection, route: SharedRouteHandle, module: string) {
    if (this.state !== 'initializing' || connection.closed) { closeRoute(connection, route); closeConnection(connection); return; }
    if (!Number.isInteger(route.channel) || route.channel <= 0 || route.channel > 65535
      || !Number.isInteger(route.epoch) || route.epoch <= 0 || route.epoch > 4294967295) {
      closeRoute(connection, route); this.retire(new SharedError('shared invalid route handle')); return;
    }
    this.route = route; this.module = module; this.state = 'ready';
    if (this.initTimer) clearTimeout(this.initTimer); this.initTimer = undefined;
    this.resolveReady();
  }
  private observe(push: { op: string; body: Record<string, unknown> }) {
    if (this.state !== 'ready' || !this.route || !record(push.body) || (push.op !== 'route.closed' && push.op !== 'route.closing')) return;
    const channels = push.body.channels;
    if (Array.isArray(channels) ? channels.includes(this.route.channel) : push.body.module_id === this.module) {
      this.retire(new SharedError('shared route lost; outcome uncertain'), routeEnd(push.body.reason));
    }
  }
  private retire(reason: Error, ending: TransportEnd = 'uncertain') {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.ending = ending; this.resolveEnded(ending); this.classifyFailure = uncertainEnd;
    if (this.initTimer) clearTimeout(this.initTimer); this.initTimer = undefined;
    // Connection close, not best-effort route cancellation, is the local boundary.
    if (this.connection) {
      if (this.route) closeRoute(this.connection, this.route);
      closeConnection(this.connection);
    }
    this.connection = undefined; this.route = undefined; this.module = undefined;
    for (const call of this.pending.values()) { release(call); call.reject(reason); }
    this.pending.clear(); this.rejectReady(reason);
  }
  private settle(ticket: string, reply: unknown) {
    if (this.state !== 'ready') return;
    const call = this.pending.get(ticket);
    let bytes = 0;
    if (call) {
      try { bytes = dataJsonBytes(reply, call.control ? SHARED_LIMITS.controlReplyBytes : this.dataBytes); }
      catch { this.retire(new SharedError('shared reply byte limit or invalid JSON')); return; }
    }
    if (!call || !record(reply) || reply.v !== SEMANTIC_PROTOCOL_VERSION || reply.ticket !== ticket || !identifier(reply.ticket)
      || !identifier(reply.instance) || !identifier(reply.assets, 256) || (reply.status !== 'ok' && reply.status !== 'error')
      || (reply.status === 'ok' ? !Object.hasOwn(reply, 'body') || Object.hasOwn(reply, 'error')
        : Object.hasOwn(reply, 'body') || !record(reply.error) || !identifier(reply.error.code)
          || (reply.error.execution !== 'not_started' && reply.error.execution !== 'started'))) {
      this.retire(new SharedError('shared invalid reply correlation/header/outcome')); return;
    }
    if (call.replySize) { call.replySize.ticket = ticket; call.replySize.bytes = bytes; }
    this.pending.delete(ticket); release(call);
    if (call.aborted && !call.acceptRetired) call.reject(new SharedError('shared aborted after settlement')); else call.resolve(reply);
  }
  private static async initialize(owner: WeakRef<SharedTransport>, loader: () => Promise<SharedSdk>, connectionFile: string, identity: SharedIdentity, timeout: number) {
    let connection: Connection | undefined;
    try {
      const sdk = await loader();
      if (!owner.deref()?.acceptSdk(sdk)) return;
      const client = await sdk.SubcClient.connect({ connectionFile, handshakeTimeoutMs: timeout, onControlPush: SharedTransport.controlObserver(owner) });
      connection = { client, closed: false };
      if (!owner.deref()?.acceptConnection(connection)) { closeConnection(connection); return; }
      const module = await client.resolveProvider(SEMANTIC_CAPABILITY);
      if (owner.deref()?.state !== 'initializing') { closeConnection(connection); return; }
      if (!identifier(module, 256)) throw new SharedError('shared invalid provider');
      const route = await client.routeOpen({ kind: 'internal_service', module_id: module, service_id: 'syntax' }, identity, { consumerIdentity: null });
      const current = owner.deref();
      if (current) current.acceptRoute(connection, route, module);
      else { closeRoute(connection, route); closeConnection(connection); }
    } catch {
      owner.deref()?.retire(new SharedError('shared initialization failed'));
      if (connection) closeConnection(connection);
    }
  }

}
function abortObserver(call: Pending) {
  return () => { call.aborted = true; detachAbort(call); };
}
function detachAbort(call: Pending) {
  if (call.signal && call.onAbort) call.signal.removeEventListener('abort', call.onAbort);
  call.signal = undefined; call.onAbort = undefined;
}
function release(call: Pending) {
  if (call.timer) clearTimeout(call.timer); call.timer = undefined; detachAbort(call);
}
