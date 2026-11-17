export type SourceOutcome = 'not_started' | 'acknowledged' | 'unknown' | 'started' | 'withdrawn' | 'stopped';
export type SourceCause = 'retry' | 'resync' | 'refused' | 'route' | 'other';
export type SourceRefusal = 'metadataFunding' | 'sourceLimit' | 'storage' | 'requestLimit' | 'encoding' | 'adoption';
export type EvictionEntitlement = 'reobserve' | 'dispatch' | 'consumed';

/** Flat event facts. Payloads, captures, progress and display remain in their existing owners. */
export interface SourceFacts {
  /** Parser-route namespace; first admission uses the current broker epoch provisionally. */
  provider: number; generation?: number; version: number;
  /** Earliest proved equal-text/identity version; pool and remote acknowledgement versions stay unchanged. */
  contentVersion: number; complete: boolean; empty: boolean;
  frozen?: boolean; retired?: boolean; sharedUnknown?: boolean; ownedUnknown?: number;
  inputRevision: number; withdrawalProvider?: number;
  /** Undefined: no continuation; string: usable lease; null: correlated loss awaiting reconstruction. */
  continuation?: string | null;
  /** Forward applicability; a retired no-start retains its outcome without this input qualifier. */
  attemptInput?: number; attemptProvider?: number; attemptOutcome?: SourceOutcome; attemptCause?: SourceCause;
  refusalInput?: number; refusalProvider?: number; refusalGeneration?: number; refusalCause?: SourceRefusal;
  evictionEntitlement?: EvictionEntitlement; retryAt?: number;
}
export interface SourceProgress {
  sourceVersion: number | undefined;
  complete: boolean;
  compatible: boolean;
  continuable: boolean;
}
export interface SourceOpportunity {
  active: boolean; enabled: boolean; available: boolean; held: boolean; ready: boolean; satisfied: boolean;
  now: number; resyncAt?: number;
}
export type SourceDecision = { kind: 'idle' | 'held' | 'refused' | 'provider' }
  | { kind: 'delayed'; at: number } | { kind: 'parse'; reconstruction: boolean };
export const SOURCE_RETRY_MS = 60000;

export function admittedSource(source: Readonly<SourceFacts>): boolean {
  return source.inputRevision > 0 && source.refusalCause !== 'metadataFunding';
}
export function matchingSourceVersion(source: Readonly<SourceFacts>, version: number | undefined): boolean {
  return version !== undefined && version >= source.contentVersion && version <= source.version;
}
export function applicableAttempt(source: Readonly<SourceFacts>): boolean {
  return source.attemptInput === source.inputRevision && source.attemptProvider === source.provider;
}
export function sourceRefused(source: Readonly<SourceFacts>): boolean {
  if (!source.refusalCause) return false;
  if (source.refusalCause === 'metadataFunding') return true;
  // Input admission records the evaluating route for cheap reobservation. It is
  // not a parser qualifier; a storage refusal may retain an older input snapshot.
  return source.refusalInput === source.inputRevision
    && (source.refusalProvider === undefined || source.refusalProvider === source.provider
      || source.refusalCause === 'storage' || source.refusalCause === 'sourceLimit' && source.generation === undefined)
    && (source.refusalGeneration === undefined || source.refusalGeneration === source.generation);
}
export function sourceUncertain(source: Readonly<SourceFacts>): boolean {
  return source.attemptProvider === source.provider && (source.attemptOutcome === 'unknown' || source.attemptOutcome === 'started');
}
export function sourceWithdrawn(source: Readonly<SourceFacts>): boolean {
  return applicableAttempt(source) && source.attemptOutcome === 'withdrawn';
}
export function sourceSatisfied(source: Readonly<SourceFacts>, progress: SourceProgress | undefined): boolean {
  if (!admittedSource(source) || source.continuation === null) return false;
  if (source.empty) return true;
  return !!progress && matchingSourceVersion(source, progress.sourceVersion) && source.complete === progress.complete
    && (source.complete ? progress.compatible : progress.continuable);
}
export function sourceExecution(source: Readonly<SourceFacts> | undefined, held: boolean): 'not_started' | 'unsettled' | 'acknowledged' | 'unknown' | 'started' {
  if (held) return 'unsettled';
  if (!source) return 'not_started';
  if (source.sharedUnknown || source.ownedUnknown !== undefined) return source.attemptOutcome === 'started' ? 'started' : 'unknown';
  if (sourceWithdrawn(source)) return 'unsettled';
  if (sourceUncertain(source)) return source.attemptOutcome as 'unknown' | 'started';
  return source.attemptOutcome === 'acknowledged' ? 'acknowledged' : 'not_started';
}

/** No mutation, acquisition or stored-work flag: compare the admitted target with current facts. */
export function nextSource(source: Readonly<SourceFacts>, opportunity: SourceOpportunity): SourceDecision {
  if (!opportunity.active || !opportunity.enabled || source.frozen || source.retired || !admittedSource(source) || !opportunity.available)
    return { kind: 'idle' };
  if (opportunity.held) return { kind: 'held' };
  if (opportunity.satisfied) return { kind: 'idle' };
  const explicit = source.evictionEntitlement === 'dispatch';
  const attempt = applicableAttempt(source);
  const reconstruction = source.continuation === null;
  if (sourceRefused(source) && !explicit) return { kind: 'refused' };
  if (attempt && source.attemptOutcome === 'not_started' && (source.attemptCause === 'refused' || source.attemptCause === 'other') && !explicit)
    return { kind: 'refused' };
  if (!opportunity.ready) return { kind: 'provider' };
  const at = Math.max(source.retryAt ?? 0, reconstruction ? opportunity.resyncAt ?? 0 : 0);
  if (opportunity.now < at) return { kind: 'delayed', at };
  if (attempt && source.attemptCause === 'route') return { kind: 'refused' };
  if (attempt && (source.attemptOutcome === 'unknown' || source.attemptOutcome === 'started') && source.attemptCause !== 'retry')
    return { kind: 'refused' };
  return { kind: 'parse', reconstruction };
}

/** A retry entitlement alone never creates new priority over Pi. */
export function queuedSource(source: Readonly<SourceFacts>, ready: boolean, available: boolean, satisfied: boolean): boolean {
  if (!ready || !available || source.retired || source.frozen || !admittedSource(source) || satisfied) return false;
  if (sourceRefused(source) && source.evictionEntitlement !== 'dispatch') return false;
  if (!applicableAttempt(source)) return true;
  return source.continuation === null || source.evictionEntitlement === 'dispatch';
}

export function sourceFaultCause(code: string, execution: 'not_started' | 'started'): SourceCause {
  if (code === 'worker_gone') return 'route';
  if (code === 'restart_required' && execution === 'not_started') return 'resync';
  if (code === 'busy' || code === 'queue_expired' && execution === 'not_started'
    || code === 'data_limit' || code === 'state_limit' || code === 'session_limit') return 'retry';
  return execution === 'not_started' ? 'refused' : 'other';
}
