import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { ReplySize } from './data-json.ts';
import { SEMANTIC_PROTOCOL_VERSION, SEMANTIC_OPERATIONS } from './semantic-protocol.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { RequestFailure } from './request-failure.ts';
import type { TransportEnd } from './transport-end.ts';

const DATA_BYTES = HIGHLIGHT_LIMITS.dataWireBytes;
const CONTROL_REQUEST_BYTES = 4096;
const CONTROL_REPLY_BYTES = 32 * 1024;
const CANCEL_BYTES = 4096;
export const STDIO_LIMITS = Object.freeze({
  dataCalls: 2, controlCalls: 1,
  requestBytes: DATA_BYTES, replyBytes: DATA_BYTES,
  controlRequestBytes: CONTROL_REQUEST_BYTES, controlReplyBytes: CONTROL_REPLY_BYTES,
  cancelBytes: CANCEL_BYTES, queuedFrames: 7,
  // Credit includes request/reply/cancel bodies and both outgoing frame headers.
  retainedBytes: 2 * (2 * DATA_BYTES + CANCEL_BYTES + 8)
    + CONTROL_REQUEST_BYTES + CONTROL_REPLY_BYTES + CANCEL_BYTES + 8,
});

export interface StdioOptions {
  /** Trusted executable; no shell, discovery, acquisition or automatic restart. */
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestDeadlineMs: number;
  terminateGraceMs: number;
  /** Optional narrower transport allowance; never expands the production family. */
  dataBytes?: number;
}
export interface StdioRequestOptions {
  signal?: AbortSignal; deadlineMs?: number;
  /** Call-local receipt, populated only for the correlated, admitted reply. */
  replySize?: ReplySize;
  /** Deliver terminal evidence to its canonical owner even after local cancellation. */
  acceptRetired?: boolean;
  /** Published-provider metadata only: expire the waiter, not the process. */
  waitOnly?: boolean;
}
export interface StdioStats {
  childState: 'running' | 'retiring' | 'exited';
  pid: number | undefined;
  spawnCount: number;
  unsettledData: number;
  unsettledControl: number;
  /** Request/reply/cancel credit plus any settled writer; not JS heap/RSS. */
  retainedBytes: number;
  queuedFrames: number;
  backpressureEvents: number;
  stderrBytes: number;
  liveTimers: number;
  abortListeners: number;
  ownedListeners: number;
}
interface Pending {
  replySize?: ReplySize;
  control: boolean;
  waitOnly: boolean;
  acceptRetired: boolean;
  credit: number;
  aborted: boolean;
  handedToWrite: boolean;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface Outgoing { ticket: string; cancel: boolean; bytes: Buffer | undefined }
class StdioError extends RequestFailure {}
const ignoreSettlement = () => {};
const operations: ReadonlySet<string> = new Set(SEMANTIC_OPERATIONS);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown, cap = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
    && Buffer.byteLength(value) <= cap && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function finiteDuration(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw new StdioError(`stdio ${label} must be finite positive milliseconds`);
  return value;
}

/** Preflight plain JSON before stringify: no arbitrarily large escaped-string allocation. */
function encode(value: Record<string, unknown>, cap: number): Buffer {
  let count = 0;
  const path = new Set<object>();
  function add(bytes: number) {
    count += bytes;
    if (count > cap) throw new StdioError('stdio request byte limit');
  }
  function string(text: string) {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32) add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
      else if (code === 34 || code === 92) add(2);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(item: unknown, depth: number) {
    if (depth > 64) throw new StdioError('stdio invalid request JSON depth');
    if (item === null || item === undefined) { add(4); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number') { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item !== 'object' || path.has(item)) throw new StdioError('stdio invalid request JSON');
    const array = Array.isArray(item);
    // JSON input is data, not a hook that can allocate an unbounded replacement
    // between the preflight and stringify passes.
    if (Object.hasOwn(item, 'toJSON')) throw new StdioError('stdio invalid request JSON hook');
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) throw new StdioError('stdio invalid request JSON object');
    path.add(item); add(2);
    let entries = 0;
    if (array) {
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor && !('value' in descriptor)) throw new StdioError('stdio invalid request JSON accessor');
        if (entries++) add(1);
        visit(descriptor?.value, depth + 1);
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new StdioError('stdio invalid request JSON accessor');
        if (descriptor.value === undefined) continue;
        if (entries++) add(1);
        string(key); add(1); visit(descriptor.value, depth + 1);
      }
    }
    path.delete(item);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  const size = Buffer.byteLength(json);
  if (!size || size !== count || size > cap) throw new StdioError('stdio invalid request JSON or byte limit');
  const frame = Buffer.allocUnsafe(size + 4);
  frame.writeUInt32BE(size); frame.write(json, 4, size, 'utf8');
  return frame;
}

/**
 * One owned persistent pipe helper. Caller tickets MUST NOT be reused within this
 * helper incarnation; the higher RPC owner supplies unique tickets/generations.
 * Abort makes a reply unusable, NOT settled. Ordinary deadlines retire the whole
 * process; waitOnly metadata rejects just its waiter. Neither releases pending
 * credit on assumed cancellation, timeout or a kill signal.
 */
export class StdioTransport {
  /** Observational only; close() still waits for actual child cleanup. */
  readonly ended: Promise<TransportEnd>;
  private resolveEnded!: (reason: TransportEnd) => void;
  private ending?: TransportEnd;
  get endReason(): TransportEnd | undefined { return this.ending; }
  private child: ChildProcessWithoutNullStreams | undefined;
  private state: StdioStats['childState'] = 'running';
  private pending = new Map<string, Pending>();
  private outgoing: Outgoing[] = [];
  private writing: Outgoing | undefined;
  private removers: (() => void)[] = [];
  private reason = new StdioError('stdio closed');
  private killTimer: NodeJS.Timeout | undefined;
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private incoming: Buffer | undefined;
  private incomingUsed = 0;
  private backpressure = 0;
  private stderrCount = 0;
  private closed: Promise<void>;
  private resolveClosed!: () => void;
  private deadlineMs: number;
  private graceMs: number;
  private pid: number | undefined;
  private spawns = 0;

  private readonly dataBytes: number;
  private readonly retainedLimit: number;

  constructor(options: StdioOptions) {
    this.dataBytes = options.dataBytes ?? DATA_BYTES;
    if (!Number.isSafeInteger(this.dataBytes) || this.dataBytes < 1 || this.dataBytes > DATA_BYTES) throw new StdioError('stdio invalid data allowance');
    this.retainedLimit = 2 * (2 * this.dataBytes + CANCEL_BYTES + 8)
      + CONTROL_REQUEST_BYTES + CONTROL_REPLY_BYTES + CANCEL_BYTES + 8;
    this.deadlineMs = finiteDuration(options.requestDeadlineMs, 'deadline');
    this.graceMs = finiteDuration(options.terminateGraceMs, 'terminate grace');
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.ended = new Promise(resolve => { this.resolveEnded = resolve; });
    try {
      this.child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
      this.spawns = 1;
      this.pid = this.child.pid;
      this.listen(this.child, 'error', () => this.retire(new StdioError('stdio spawn/process failure'), 'lost'));
      this.listen(this.child, 'spawn', () => {
        // close may precede the asynchronous spawn notification.
        if (this.state === 'retiring') this.child?.kill('SIGTERM');
      });
      this.listen(this.child, 'exit', () => this.exited());
      this.listen(this.child, 'close', () => this.cleanup());
      this.listen(this.child.stdin, 'error', () => this.retire(new StdioError('stdio input pipe failure'), 'lost'));
      this.listen(this.child.stdout, 'error', () => this.retire(new StdioError('stdio output pipe failure'), 'lost'));
      this.listen(this.child.stderr, 'error', () => this.retire(new StdioError('stdio stderr pipe failure'), 'lost'));
      this.listen(this.child.stdout, 'end', () => this.retire(new StdioError('stdio EOF or truncated frame'), 'lost'));
      this.listen(this.child.stdout, 'data', (chunk: Buffer) => this.read(chunk));
      this.listen(this.child.stderr, 'data', (chunk: Buffer) => {
        // Drain, never save or emit raw diagnostics. Counter itself is bounded.
        this.stderrCount = Math.min(Number.MAX_SAFE_INTEGER, this.stderrCount + chunk.length);
      });
    } catch {
      this.reason = new StdioError('stdio spawn failure');
      this.end('lost');
      this.cleanup();
    }
  }

  request(request: Record<string, unknown>, options: StdioRequestOptions = {}): Promise<unknown> {
    try {
      if (this.state !== 'running') throw new StdioError('stdio retired');
      const deadline = finiteDuration(options.deadlineMs ?? this.deadlineMs, 'deadline');
      if (!record(request) || request.v !== SEMANTIC_PROTOCOL_VERSION || !identifier(request.ticket)
        || typeof request.op !== 'string' || !operations.has(request.op) || Object.hasOwn(request, 'cancel')) throw new StdioError('stdio invalid request header');
      const ticket = request.ticket;
      if (this.pending.has(ticket)) throw new StdioError('stdio active duplicate ticket');
      if (options.signal?.aborted) throw new StdioError('stdio aborted before dispatch');
      const control = request.op === 'describe' || request.op === 'themes.refresh';
      if (options.waitOnly && !control) throw new StdioError('stdio wait-only requires control');
      const counts = this.stats();
      if (control ? counts.unsettledControl >= 1 : counts.unsettledData >= 2) throw new StdioError('stdio request capacity');
      // A settled reply can precede its write callback. That writer still owns
      // bytes; admission cannot reuse its byte allowance or queue position yet.
      const bytes = encode(request, control ? CONTROL_REQUEST_BYTES : this.dataBytes);
      const credit = bytes.length + (control ? CONTROL_REPLY_BYTES : this.dataBytes) + CANCEL_BYTES + 4;
      if (counts.retainedBytes + credit > this.retainedLimit) throw new StdioError('stdio byte capacity');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.expire(ticket), deadline);
        timer.unref();
        const call: Pending = { replySize: options.replySize, control, waitOnly: options.waitOnly === true, acceptRetired: options.acceptRetired === true, credit, timer, aborted: false, handedToWrite: false, resolve, reject, signal: options.signal };
        this.pending.set(ticket, call);
        if (options.signal) {
          call.onAbort = () => this.cancel(ticket, call);
          options.signal.addEventListener('abort', call.onAbort, { once: true });
        }
        this.enqueue(bytes, ticket, false);
      });
    } catch (error) {
      // Do not forward serialization/OS errors that can contain source/path data.
      const message = error instanceof StdioError ? error.message : 'stdio invalid request JSON';
      return Promise.reject(new StdioError(message, 'not_started'));
    }
  }

  private expire(ticket: string) {
    const call = this.pending.get(ticket);
    if (!call || this.state !== 'running') return;
    if (!call.waitOnly) { this.retire(new StdioError('stdio request deadline')); return; }
    call.timer = undefined;
    this.cancel(ticket, call);
    call.reject(new StdioError('stdio control wait deadline'));
    // The correlated frame/credit stays owned, not the completed caller promise.
    call.resolve = ignoreSettlement; call.reject = ignoreSettlement;
  }

  private cancel(ticket: string, call: Pending) {
    if (call.aborted || !this.pending.has(ticket) || this.state !== 'running') return;
    call.aborted = true; this.detachAbort(call);
    // One frame per active call, no application op and no response slot.
    this.enqueue(encode({ v: SEMANTIC_PROTOCOL_VERSION, cancel: ticket }, CANCEL_BYTES), ticket, true);
  }

  close(): Promise<void> {
    this.retire(new StdioError('stdio closed'), 'closed');
    return this.closed;
  }

  get hasPendingRequests(): boolean { return this.pending.size > 0; }

  stats(): StdioStats {
    let data = 0, control = 0, bytes = 0, aborts = 0, timers = 0;
    for (const call of this.pending.values()) {
      if (call.control) control++; else data++;
      bytes += call.credit;
      if (call.signal && call.onAbort) aborts++;
      if (call.timer) timers++;
    }
    if (this.writing?.bytes && !this.pending.has(this.writing.ticket)) bytes += this.writing.bytes.length;
    return {
      childState: this.state, pid: this.pid, spawnCount: this.spawns,
      unsettledData: data, unsettledControl: control, retainedBytes: bytes,
      queuedFrames: this.outgoing.length + (this.writing ? 1 : 0),
      backpressureEvents: this.backpressure, stderrBytes: this.stderrCount,
      liveTimers: timers + (this.killTimer ? 1 : 0),
      abortListeners: aborts, ownedListeners: this.removers.length,
    };
  }

  private listen(emitter: EventEmitter, event: string, listener: (...args: any[]) => void) {
    emitter.on(event, listener);
    this.removers.push(() => emitter.removeListener(event, listener));
  }

  private enqueue(bytes: Buffer, ticket: string, cancel: boolean) {
    if (this.state !== 'running') return;
    // At most 3 request/cancel pairs plus one settled writer awaiting drain.
    // Unsent settled cancels are removed on response, so this queue cannot grow
    // with historical calls even when the native peer outruns write callbacks.
    this.outgoing.push({ bytes, ticket, cancel });
    this.writeNext();
  }

  private writeNext() {
    if (this.state !== 'running' || this.writing || !this.child) return;
    const frame = this.outgoing.shift();
    if (!frame) return;
    this.writing = frame;
    let flushed = false, drained = false;
    const done = () => {
      if (!flushed || !drained || this.writing !== frame) return;
      this.writing = undefined;
      this.writeNext();
    };
    try {
      // Admission/queue membership is not dispatch. Correlate only after the
      // application frame is handed to write, without waiting for callback/drain.
      if (!frame.cancel) this.pending.get(frame.ticket)!.handedToWrite = true;
      const writable = this.child.stdin.write(frame.bytes!, error => {
        frame.bytes = undefined;
        if (error) { this.retire(new StdioError('stdio input pipe failure'), 'lost'); return; }
        flushed = true; done();
      });
      drained = writable;
      if (!writable) {
        this.backpressure++;
        const input = this.child.stdin;
        const onDrain = () => { remove(); drained = true; done(); };
        const remove = () => {
          input.removeListener('drain', onDrain);
          const index = this.removers.indexOf(remove);
          if (index !== -1) this.removers.splice(index, 1);
        };
        input.once('drain', onDrain); this.removers.push(remove);
      }
      done();
    } catch { this.retire(new StdioError('stdio input pipe failure'), 'lost'); }
  }

  private read(chunk: Buffer) {
    if (this.state !== 'running') return;
    let offset = 0;
    while (offset < chunk.length && this.state === 'running') {
      if (!this.incoming) {
        const size = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + size);
        this.headerUsed += size; offset += size;
        if (this.headerUsed < 4) return;
        const length = this.header.readUInt32BE();
        this.headerUsed = 0;
        // Correlation is still inside the body: either pending lane may reply.
        // Its own allowance is enforced again after resolving the ticket.
        let cap=0;
        for(const call of this.pending.values()) cap=Math.max(cap,call.control?CONTROL_REPLY_BYTES:this.dataBytes);
        if (!this.pending.size || !length || length > cap) { this.retire(new StdioError('stdio frame length/correlation')); return; }
        this.incoming = Buffer.allocUnsafe(length); this.incomingUsed = 0;
      }
      const size = Math.min(this.incoming.length - this.incomingUsed, chunk.length - offset);
      chunk.copy(this.incoming, this.incomingUsed, offset, offset + size);
      this.incomingUsed += size; offset += size;
      if (this.incomingUsed === this.incoming.length) {
        const bytes = this.incoming;
        this.incoming = undefined; this.incomingUsed = 0;
        this.reply(bytes);
      }
    }
  }

  private reply(bytes: Buffer) {
    let reply: unknown;
    try { reply = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { this.retire(new StdioError('stdio invalid UTF8/JSON reply')); return; }
    if (!record(reply) || reply.v !== SEMANTIC_PROTOCOL_VERSION || !identifier(reply.ticket) || !identifier(reply.instance)
      || !identifier(reply.assets, 256) || (reply.status !== 'ok' && reply.status !== 'error')) {
      this.retire(new StdioError('stdio invalid reply header')); return;
    }
    const call = this.pending.get(reply.ticket);
    if (!call || !call.handedToWrite) { this.retire(new StdioError('stdio reply correlation')); return; }
    if (bytes.length > (call.control ? CONTROL_REPLY_BYTES : this.dataBytes)) {
      this.retire(new StdioError(call.control ? 'stdio control reply byte limit' : 'stdio data reply byte limit')); return;
    }
    if (reply.status === 'ok' ? !Object.hasOwn(reply, 'body') || Object.hasOwn(reply, 'error')
      : Object.hasOwn(reply, 'body') || !record(reply.error) || !identifier(reply.error.code)
        || (reply.error.execution !== 'not_started' && reply.error.execution !== 'started')) {
      this.retire(new StdioError('stdio invalid reply outcome')); return;
    }
    if (call.replySize) { call.replySize.ticket = reply.ticket; call.replySize.bytes = bytes.length; }
    this.pending.delete(reply.ticket); this.release(call);
    // A late response makes an unsent cancellation unnecessary. Do not leave
    // settled-call frames queued outside the active-call credit reservation.
    this.outgoing = this.outgoing.filter(frame => !(frame.cancel && frame.ticket === reply.ticket));
    if (call.aborted && !call.acceptRetired) call.reject(new StdioError('stdio aborted after settlement'));
    else call.resolve(reply);
  }

  private detachAbort(call: Pending) {
    if (call.signal && call.onAbort) call.signal.removeEventListener('abort', call.onAbort);
    call.signal = undefined; call.onAbort = undefined;
  }

  private release(call: Pending) {
    if (call.timer) clearTimeout(call.timer);
    call.timer = undefined;
    this.detachAbort(call);
  }

  private end(reason: TransportEnd) {
    if (this.ending !== undefined) return;
    this.ending = reason; this.resolveEnded(reason);
  }

  private retire(reason: RequestFailure, ending: TransportEnd = 'uncertain') {
    if (this.state !== 'running') return;
    this.state = 'retiring'; this.reason = reason; this.end(ending);
    this.outgoing = []; this.incoming = undefined;
    // Still counted until exit; only the shutdown timer remains useful now.
    for (const call of this.pending.values()) this.release(call);
    if (!this.child) { this.cleanup(); return; }
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.state === 'retiring') this.child?.kill('SIGKILL');
    }, this.graceMs);
    this.killTimer.unref();
  }

  private exited() {
    if (this.state === 'exited') return;
    if (this.state === 'running') { this.reason = new StdioError('stdio child exited'); this.end('lost'); }
    this.state = 'exited';
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = undefined; }
    for (const call of this.pending.values()) { this.release(call); call.reject(this.reason); }
    this.pending.clear(); this.outgoing = []; this.writing = undefined;
    this.incoming = undefined; this.incomingUsed = 0; this.headerUsed = 0;
  }

  private cleanup() {
    // Spawn failure has close without exit. Real children have already exited.
    this.exited();
    for (const remove of [...this.removers]) remove();
    this.removers = [];
    this.child = undefined;
    this.resolveClosed();
  }
}
