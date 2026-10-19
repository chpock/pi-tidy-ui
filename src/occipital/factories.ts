import { diagnose, diagnosticError, type DiagnosticSink } from '../diagnostics.ts';
import { acquireNative, type NativeRelease } from './native.ts';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PROVIDER_LIMITS, type ProviderOptions } from './provider.ts';
import { StdioTransport } from './stdio.ts';
import { SharedTransport, type SharedOptions } from './shared.ts';
import { connectionCandidates } from './discovery.ts';
import { ExpectedOwnedUnavailable } from './owned-startup.ts';

export interface OwnedFactoryOptions {
  diagnostic?: DiagnosticSink;
  /** Trusted daemon release, independent of the extension version. */
  release: NativeRelease;
  cacheDir: string;
  /** Explicit trusted installed payload only; otherwise exact cache/download. */
  installedPath?: string;
  fetcher?: typeof fetch;
  /** May narrow, never extend, the existing owned acquisition budget. */
  attemptDeadlineMs?: number;
  requestDeadlineMs: number;
  terminateGraceMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}
type OwnedLaunchOptions = Pick<OwnedFactoryOptions, 'diagnostic' | 'attemptDeadlineMs' | 'requestDeadlineMs' | 'terminateGraceMs' | 'env' | 'cwd'>;
export interface LocalOwnedFactoryOptions extends OwnedLaunchOptions {
  command: string;
  onMissing?(): void;
}
interface OwnedSlot { settled: Promise<void>; release(): void }
let ownedSlot: OwnedSlot | undefined;
const ignored = () => {};
const unavailable = () => new Error('occipital owned factory unavailable');

function duration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw unavailable();
  return value;
}

/** One call-local absolute budget, also covering waits for an earlier owner. */
function attempt(caller: AbortSignal, ms: number) {
  const deadline = performance.now() + ms, controller = new AbortController();
  const abort = () => controller.abort();
  caller.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms); timer.unref();
  if (caller.aborted) abort();
  return {
    signal: controller.signal,
    check() {
      if (performance.now() >= deadline) abort();
      if (controller.signal.aborted) throw unavailable();
    },
    remaining() {
      this.check();
      const left = Math.floor(deadline - performance.now());
      if (left < 1) throw unavailable();
      return left;
    },
    dispose() { clearTimeout(timer); caller.removeEventListener('abort', abort); },
  };
}

/** Cancel only this wait, never the earlier helper's exit authority. Late handlers
 * release their caller cells on cancellation; they retain no factory/transport. */
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let yes: ((value: T) => void) | undefined = resolve;
    let no: ((error: Error) => void) | undefined = reject;
    const detach = () => signal.removeEventListener('abort', abort);
    const abort = (error?: unknown) => { const failed = no; yes = undefined; no = undefined; detach();
      failed?.(error instanceof ExpectedOwnedUnavailable ? new ExpectedOwnedUnavailable() : unavailable()); };
    promise.then(value => { const accepted = yes; yes = undefined; no = undefined; detach(); accepted?.(value); }, abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function currentOwned(): OwnedSlot | undefined { return ownedSlot; }

function reserve(): OwnedSlot {
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const slot = { settled, release() { if (ownedSlot === slot) ownedSlot = undefined; settle(); } };
  ownedSlot = slot;
  return slot;
}

/** Separate factory scope: the module guard must not retain an installed owner. */
function exitObserver(owner: WeakRef<StdioTransport>, slot: OwnedSlot) {
  return () => {
    const transport = owner.deref();
    if (!transport) return; // No public close settlement, therefore no exit proof.
    try { void transport.close().then(slot.release, ignored); } catch { /* Keep the guard on unproved exit. */ }
  };
}
function trackOwned(transport: StdioTransport, slot: OwnedSlot) {
  void transport.ended.then(exitObserver(new WeakRef(transport), slot)).catch(ignored);
}

/** Owned half of the ProviderOptions seam. It sends no metadata or source; the
 * broker remains the compatibility authority. The module slot spans factory and
 * broker owners and is released ONLY by actual public StdioTransport.close().
 * Shared discovery composition is separate and broker-negotiated. */
export function createOwnedFactory(input: OwnedFactoryOptions): ProviderOptions['acquireOwned'] {
  const options = { ...input, release: { ...input.release } };
  return ownedFactory(options, async signal => {
    const acquired = await acquireNative({ cacheDir: options.cacheDir, release: options.release,
      installedPath: options.installedPath, fetcher: options.fetcher, signal });
    diagnose(options.diagnostic, 'INFO', 'occipital', 'Exact native artifact acquired and validated',
      { version: options.release.version, target: options.release.target, downloaded: acquired.downloaded, installed: acquired.path === options.installedPath });
    return acquired.path;
  });
}

/** Development uses only the explicitly colocated file, never release/cache/PATH discovery. */
export function createLocalOwnedFactory(input: LocalOwnedFactoryOptions): ProviderOptions['acquireOwned'] {
  const options = { ...input };
  return ownedFactory(options, async signal => {
    if (!isAbsolute(options.command)) throw unavailable();
    let file;
    try { file = await stat(options.command); }
    catch (error) {
      diagnose(options.diagnostic, 'WARN', 'occipital', 'Colocated development binary unavailable; using existing fallback policy', { code: diagnosticError(error) });
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        if (!signal.aborted) options.onMissing?.();
        throw new ExpectedOwnedUnavailable();
      }
      throw error;
    }
    if (!file.isFile()) throw unavailable();
    await access(options.command, constants.X_OK);
    return options.command;
  });
}

function ownedFactory(options: OwnedLaunchOptions, acquire: (signal: AbortSignal) => Promise<string>): ProviderOptions['acquireOwned'] {
  const ms = Math.min(duration(options.attemptDeadlineMs ?? PROVIDER_LIMITS.ownedFactoryMs), PROVIDER_LIMITS.ownedFactoryMs);
  duration(options.requestDeadlineMs); duration(options.terminateGraceMs);
  return async caller => {
    const budget = attempt(caller, ms);
    try {
      budget.check();
      let previous: OwnedSlot | undefined;
      while ((previous = currentOwned())) { await wait(previous.settled, budget.signal); budget.check(); }
      const command = await wait(acquire(budget.signal), budget.signal);
      budget.check();
      // Another owner can have acquired while this one was awaiting delivery.
      while ((previous = currentOwned())) { await wait(previous.settled, budget.signal); budget.check(); }
      budget.check();
      const slot = reserve();
      let transport: StdioTransport;
      try {
        transport = new StdioTransport({ command, args: ['--stdio'],
          requestDeadlineMs: options.requestDeadlineMs, terminateGraceMs: options.terminateGraceMs,
          env: options.env, cwd: options.cwd });
      } catch (error) { slot.release(); throw error; }
      trackOwned(transport, slot);
      // Constructor is synchronous; transfer drops the acquisition abort listener.
      diagnose(options.diagnostic, 'INFO', 'occipital', 'Owned stdio transport created; broker compatibility check still pending');
      return transport;
    } catch (error) { diagnose(options.diagnostic, 'WARN', 'occipital', 'Owned acquisition or launch attempt did not complete', { cancelled: budget.signal.aborted, code: diagnosticError(error) }); throw error instanceof ExpectedOwnedUnavailable ? new ExpectedOwnedUnavailable() : unavailable(); }
    finally { budget.dispose(); }
  };
}

export interface SharedFactoryOptions extends Omit<SharedOptions, 'connectionFile' | 'initDeadlineMs'> {
  diagnostic?: DiagnosticSink;
  /** Existing public discovery priorities and explicit/env exclusivity. */
  discovery?: Parameters<typeof connectionCandidates>[0];
  /** May narrow, never extend, the existing shared attempt budget. */
  attemptDeadlineMs?: number;
}

/** Abort callbacks retain no candidate or factory owner after transfer. */
function sharedAbortObserver(owner: WeakRef<SharedTransport>) {
  return () => { void owner.deref()?.close().catch(ignored); };
}

/** Ready routes are not compatible providers: only the broker negotiates metadata.
 * One absolute budget covers discovery, SDK initialization, negotiation and cleanup. */
export function createSharedFactory(input: SharedFactoryOptions): ProviderOptions['tryShared'] {
  const options = { ...input, identity: { ...input.identity } };
  const ms = Math.min(duration(options.attemptDeadlineMs ?? PROVIDER_LIMITS.factoryMs), PROVIDER_LIMITS.factoryMs);
  duration(options.requestDeadlineMs);
  return async (caller, negotiate) => {
    const budget = attempt(caller, ms);
    try {
      budget.check();
      for (const connectionFile of connectionCandidates(options.discovery)) {
        budget.check();
        diagnose(options.diagnostic, 'DEBUG', 'occipital', 'Shared connection candidate considered', { connectionFile });
        try {
          const candidate = new SharedTransport({ connectionFile, identity: options.identity,
            initDeadlineMs: budget.remaining(), requestDeadlineMs: options.requestDeadlineMs,
            loadSdk: options.loadSdk, dataBytes: options.dataBytes });
          const abort = sharedAbortObserver(new WeakRef(candidate));
          budget.signal.addEventListener('abort', abort, { once: true });
          if (budget.signal.aborted) abort();
          let transferred = false;
          try {
            budget.check();
            await wait(candidate.ready, budget.signal); budget.check();
            const accepted = await wait(negotiate(candidate), budget.signal); budget.check();
            if (accepted) { transferred = true; return candidate; }
          } finally {
            budget.signal.removeEventListener('abort', abort);
            if (!transferred) { await wait(candidate.close(), budget.signal); budget.check(); }
          }
        } catch (error) { diagnose(options.diagnostic, 'DEBUG', 'occipital', 'Shared connection candidate did not complete', { code: diagnosticError(error) });
          budget.check(); /* Optional failed candidate; continue in the same attempt. */ }
      }
    } catch { /* Optional service unavailable; the broker alone decides owned selection. */ }
    finally { budget.dispose(); }
    return undefined;
  };
}
