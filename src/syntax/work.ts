import type { SyntaxClient } from '../occipital/client.ts';
import type { DisplayRangeReader, PiFailure, PiProjectionReader, SourceController, SourceDemand, SourceDisplayBasis, SourceWorkStatus } from '../occipital/controller.ts';
import type { DataCharge } from '../occipital/data-budget.ts';
import { preparePiFlat, type PiRowReader, type PreparedPiFlat } from './pi-flat.ts';
import type { StagedPiProjection } from '../occipital/pi-projection.ts';
import type { ConcreteStyle } from './style-materialization.ts';
import { HIGHLIGHT_LIMITS } from '../occipital/limits.ts';
import { highlightingPrefix } from './highlighting-prefix.ts';

type NativeProfile = { id: string; fingerprint: string };
export type SyntaxDemand = Omit<SourceDemand, 'profile' | 'fingerprint'> & {
  palette: number;
  // Selected presentation identity, never parser/fallback authority.
  nativeProfile?: NativeProfile | null;
} & ({ fallback: 'pi'; piNeutral: ConcreteStyle } | { fallback: 'neutral' });
export type SyntaxIdentity = Pick<SyntaxDemand, 'key' | 'version' | 'language' | 'complete' | 'palette' | 'fallback'>;
export type PiClassifier = (text: string, info: { language?: string; path?: string }) => readonly string[];
export type SyntaxWorkResult = { outcome: 'native' | 'pi' | 'neutral' | 'waiting' | 'refused' | 'failed' | 'stale'; failure?: PiFailure; awaitingProvider?: true };
export interface SyntaxResolution extends SyntaxIdentity {
  owner: WeakRef<SourceController>;
  /** Exactness of the submitted prefix, not the full display or paint readiness. */
  nativeExact: boolean;
  execution: SourceWorkStatus['execution'];
  fallbackEligible: boolean;
  piStyled?: boolean;
  committedBytes?: number;
  needsPi: boolean;
  profileRetryAllowed: boolean;
  nativeGeneration?: number;
  piGeneration?: number;
  native?: DisplayRangeReader;
  display?: SourceDisplayBasis;
  pi?: PiProjectionReader;
}
type Client = Pick<SyntaxClient, 'sources' | 'snapshot'>;
const compatibleProfile = (source: { profile: string; fingerprint: string }, profile?: NativeProfile | null) =>
  profile === undefined || profile !== null && source.profile === profile.id && source.fingerprint === profile.fingerprint;

// Factory scope retains only weak ownership and primitive validity receipts.
function nativeReader(owner: WeakRef<SourceController>, key: string, generation: number, version: number,
  stamp: number, language?: string): DisplayRangeReader {
  return consume => {
    const sources = owner.deref();
    const current = () => {
      const source = sources?.borrowSource(key);
      return source?.generation === generation && source.version === version && source.language === language
        && sources?.displayStamp(key) === stamp;
    };
    if (!sources || !current()) return false;
    return sources.visitRanges(key, consume) && current();
  };
}

// Inspect only shape/length before funding the returned external allocation. The
// budget itself bounds inspection; no unrelated row/count ceiling is introduced.
function ansiBytes(lines: readonly string[], limit: number): number | undefined {
  if (!Array.isArray(lines)) return undefined;
  let bytes = 64 + lines.length * 40;
  if (bytes > limit) return bytes;
  for (let index = 0; index < lines.length; index++) {
    if (typeof lines[index] !== 'string') return undefined;
    bytes += lines[index]!.length * 2;
    if (bytes > limit) return bytes;
  }
  return bytes;
}
function classificationRows(lines: readonly string[], styled: { value: boolean }): PiRowReader {
  return consume => {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.includes('\x1b[')) styled.value = true;
      consume(index, line);
    }
    return true;
  };
}

/** Useful/coalesced demand only, outside render. Native source execution and
 * palette readiness are independent; only workStatus authorizes a Pi attempt. */
export function requestSyntax(client: Client, demand: SyntaxDemand, classify: PiClassifier): SyntaxWorkResult {
  const sources = client.sources, metadata = client.snapshot();
  const { key, version, language, path, palette, neutral } = demand;
  const retained = sources.borrowSource(key);
  const observe = metadata.enabled && metadata.provider.availability === 'ready' && metadata.effective;
  const prefix = (observe || retained) && !(retained?.text === demand.text && demand.complete
    && retained.utf8Bytes <= HIGHLIGHT_LIMITS.sourceBytes && demand.text.length <= HIGHLIGHT_LIMITS.sourceLines)
    ? highlightingPrefix(demand.text, HIGHLIGHT_LIMITS.sourceBytes) : undefined;
  const nativeText = prefix ? demand.text.slice(0, prefix.end) : demand.text;
  const complete = demand.complete || !!prefix?.saturated;
  if (observe) {
    const profile = observe;
    if (!sources.observe({ key, version, text: nativeText, language, path, complete, neutral, profile: profile.id, fingerprint: profile.fingerprint }))
      return { outcome: sources.workStatus(key).fallbackEligible ? 'refused' : 'waiting' };
  }
  const native = sources.borrowSource(key);
  const nativeExact = native?.version === version && native.language === language && native.text === nativeText && sources.status(key)?.exact;
  const display = sources.displayBasis(key);
  const exactDisplay = display?.language === language && (display?.exactVersion === version || display?.version === version);
  if (nativeExact && exactDisplay && compatibleProfile(native!, demand.nativeProfile === undefined ? metadata.effective : demand.nativeProfile))
    return { outcome: 'native' };
  if (demand.fallback === 'neutral') return { outcome: !nativeExact && sources.workStatus(key).fallbackEligible ? 'neutral' : 'waiting',
    ...(metadata.enabled && (metadata.provider.availability !== 'ready' || !metadata.effective) ? { awaitingProvider: true as const } : {}) };
  const cached = sources.borrowPiSource(key);
  const text = cached?.text === demand.text && cached.utf8Bytes <= HIGHLIGHT_LIMITS.piSourceBytes ? demand.text
    : demand.text.slice(0, highlightingPrefix(demand.text, HIGHLIGHT_LIMITS.piSourceBytes).end);
  if (cached?.version === version && cached.language === language && cached.text === text) {
    if (sources.piProjection(key, version, palette)) return { outcome: 'pi' };
    const failure = sources.piFailure(key, version, palette);
    if (failure) return { outcome: 'failed', failure };
    if (sources.piRefusal(key, version, palette)) return { outcome: 'refused' };
  }
  if (nativeExact || exactDisplay || !sources.workStatus(key).fallbackEligible) return { outcome: 'waiting' };
  if (cached && (cached.version > version || cached.version === version && cached.language === language && cached.text !== text)) return { outcome: 'stale' };
  if (!sources.capturePiSource(key, version, text, language)) return { outcome: 'refused' };
  const source = sources.borrowPiSource(key);
  if (!source || source.version !== version || source.language !== language || source.text !== text) return { outcome: 'stale' };
  if (sources.piProjection(key, version, palette)) return { outcome: 'pi' }; // Finite equal-text alias.
  const failure = sources.piFailure(key, version, palette);
  if (failure) return { outcome: 'failed', failure };
  if (sources.piRefusal(key, version, palette)) return { outcome: 'refused' };
  const ticket = sources.piPreparation(key, source.generation, version, palette);
  if (!ticket) return { outcome: sources.piRefusal(key, version, palette) ? 'refused' : 'stale' };
  let lines: readonly string[] | undefined, ansi: DataCharge | undefined;
  let candidate: PreparedPiFlat | undefined, staged: StagedPiProjection | undefined;
  const failed = (kind: PiFailure): SyntaxWorkResult => sources.recordPiFailure(key, ticket.generation, version, palette, kind)
    ? { outcome: 'failed', failure: kind } : { outcome: 'stale' };
  const denied = (): SyntaxWorkResult => ({ outcome: sources.piRefusal(key, version, palette) ? 'refused' : 'stale' });
  const reserve = (bytes: number) => sources.reservePiData(ticket, bytes);
  try {
    try { lines = ticket.text!.length ? classify(ticket.text!, { language, path }) : []; }
    catch { return failed('threw'); }
    const bytes = ansiBytes(lines, ticket.budget.limit);
    if (bytes === undefined) return failed('invalid_rows');
    const grant = reserve(bytes);
    if (!grant) return denied();
    try { ansi = grant.consume(bytes); } finally { grant.close(); }
    const styled = { value: false };
    const prepared = preparePiFlat(ticket.text!, classificationRows(lines, styled), demand.piNeutral, ticket.budget, reserve);
    if (prepared.outcome !== 'ready') return prepared.outcome === 'invalid' ? failed('invalid_rows') : denied();
    candidate = prepared.projection;
    staged = candidate.stage(reserve);
    if (!staged) return denied();
    return sources.adoptPiFlat(ticket, ticket.text!, staged, styled.value) ? { outcome: 'pi' } : denied();
  } finally {
    staged?.dispose(); candidate?.dispose(); lines = undefined; ansi?.release(); ticket.release();
  }
}

/** Pure keyed metadata read: no classification, observation, allocation grants,
 * source traversal, range/style visits or dispatch. Visitor output is provisional
 * until its final true result, and must be discarded otherwise. */
export function resolveSyntax(sources: SourceController, identity: SyntaxIdentity,
  profile?: NativeProfile | null): SyntaxResolution {
  const { key, version, language, complete, palette, fallback } = identity;
  const allowPi = fallback === 'pi';
  const work = sources.workStatus(key), native = sources.borrowSource(key), pi = allowPi ? sources.borrowPiSource(key) : undefined;
  const matchingNative = native?.version === version && native.language === language ? native : undefined;
  const currentNative = matchingNative && compatibleProfile(matchingNative, profile) ? matchingNative : undefined;
  const status = matchingNative ? sources.status(key) : undefined;
  const nativeExact = !!status?.exact;
  const basis = sources.displayBasis(key);
  const display = complete && basis?.complete && basis.exactVersion === version && basis.language === language ? basis : undefined;
  const matchingPi = pi?.version === version && pi.language === language ? pi : undefined;
  const projection = matchingPi ? sources.piProjection(key, version, palette) : undefined;
  const failure = matchingPi && sources.piFailure(key, version, palette);
  const refusal = matchingPi && sources.piRefusal(key, version, palette);
  const owner = new WeakRef(sources);
  return { key, version, language, complete, palette, fallback, owner, nativeExact,
    execution: work.execution, fallbackEligible: work.fallbackEligible, piStyled: projection ? matchingPi?.styleDirectives : undefined, committedBytes: status?.committedBytes,
    needsPi: allowPi && (work.version === undefined || work.version <= version) && (pi === undefined || pi.version <= version)
      && !nativeExact && !display && !projection && work.fallbackEligible && !failure && !refusal,
    profileRetryAllowed: work.version === version && work.profileRetryAllowed,
    nativeGeneration: currentNative?.generation, piGeneration: projection?.generation, display,
    native: currentNative && basis && (status?.classificationVersion !== undefined || nativeExact)
      ? nativeReader(owner, key, currentNative.generation, version, basis.stamp, language) : undefined,
    pi: projection };
}
