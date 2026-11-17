import type { DisplayRangeReader, PiFailure, PiProjectionReader, SourceDemand, SourceDisplayBasis, SourceWorkPort, SourceWorkStatus } from '../highlighting/source-ports.ts';
import type { PiFallbackPort, PiClassifier } from '../highlighting/pi-fallback.ts';
import type { ThemeDescription } from '../themes/selection.ts';
import type { ProviderSnapshot } from '../occipital/provider.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import { HIGHLIGHT_LIMITS } from '../highlighting/limits.ts';
import { highlightingPrefix } from './highlighting-prefix.ts';
export type SyntaxDemand = SourceDemand & {
  /** Pi's local classifier hint; kept separate from the explicit Occipital SOURCE language selector. */
  piLanguage?: string;
  palette: number;
} & ({ fallback: 'pi'; piNeutral: ConcreteStyle } | { fallback: 'neutral' });
export type SyntaxIdentity = Pick<SyntaxDemand, 'key' | 'version' | 'language' | 'piLanguage' | 'complete' | 'palette' | 'fallback'>;
export type { PiClassifier } from '../highlighting/pi-fallback.ts';
export type SyntaxWorkResult = { outcome: 'native' | 'pi' | 'neutral' | 'waiting' | 'refused' | 'failed' | 'stale'; failure?: PiFailure };
export interface SyntaxResolution extends SyntaxIdentity {
  owner: WeakRef<SourceWorkPort>;
  /** Exactness of the submitted prefix, not the full display or paint readiness. */
  nativeExact: boolean;
  execution: SourceWorkStatus['execution'];
  fallbackEligible: boolean;
  piStyled?: boolean;
  committedBytes?: number;
  needsPi: boolean;
  nativeGeneration?: number;
  piGeneration?: number;
  native?: DisplayRangeReader;
  display?: SourceDisplayBasis;
  pi?: PiProjectionReader;
}
export interface SyntaxSourceSnapshot {
  readonly enabled: boolean;
  readonly effective?: ThemeDescription;
  readonly provider: Pick<ProviderSnapshot, 'availability' | 'generation'>;
}
export interface SyntaxSourceClient {
  readonly sourceWork: SourceWorkPort;
  readonly pi: PiFallbackPort;
  snapshot(): SyntaxSourceSnapshot;
}
// Factory scope retains only weak ownership and primitive validity receipts.
function nativeReader(owner: WeakRef<SourceWorkPort>, key: string, generation: number, version: number,
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

/** Useful/coalesced demand only, outside render. Native source execution and
 * palette readiness are independent; only workStatus authorizes a Pi attempt. */
export function requestSyntax(client: SyntaxSourceClient, demand: SyntaxDemand, classify: PiClassifier): SyntaxWorkResult {
  const sources = client.sourceWork;
  if (!sources.active) return { outcome: 'waiting' };
  const metadata = client.snapshot();
  const { key, version, language, path, piLanguage, palette, neutral } = demand;
  const retained = sources.borrowSource(key);
  const observe = metadata.enabled;
  const prefix = (observe || retained) && !(retained?.text === demand.text && demand.complete
    && retained.utf8Bytes <= HIGHLIGHT_LIMITS.sourceBytes && demand.text.length <= HIGHLIGHT_LIMITS.sourceLines)
    ? highlightingPrefix(demand.text, HIGHLIGHT_LIMITS.sourceBytes) : undefined;
  const nativeText = prefix ? demand.text.slice(0, prefix.end) : demand.text;
  const complete = demand.complete || !!prefix?.saturated;
  const admitted = !observe || sources.observe({ key, version, text: nativeText, language, path, complete, neutral });
  if (!admitted && metadata.provider.availability === 'ready')
    return { outcome: sources.workStatus(key).fallbackEligible ? 'refused' : 'waiting' };
  const native = sources.borrowSource(key);
  const nativeExact = admitted && native?.version === version && native.language === language
    && native.text === nativeText && sources.status(key)?.exact;
  const display = sources.displayBasis(key);
  const exactDisplay = admitted && !!display && display.language === language
    && (display.exactVersion === version || display.version === version);
  if (nativeExact && exactDisplay)
    return { outcome: 'native' };
  if (demand.fallback === 'neutral') return { outcome: !nativeExact && sources.workStatus(key).fallbackEligible ? 'neutral' : 'waiting' };
  const pi = client.pi;
  const cached = pi.borrowPiSource(key);
  const text = cached?.text === demand.text && cached.utf8Bytes <= HIGHLIGHT_LIMITS.piSourceBytes ? demand.text
    : demand.text.slice(0, highlightingPrefix(demand.text, HIGHLIGHT_LIMITS.piSourceBytes).end);
  if (cached?.version === version && cached.language === piLanguage && cached.text === text) {
    if (pi.piProjection(key, version, palette)) return { outcome: 'pi' };
    const failure = pi.piFailure(key, version, palette);
    if (failure) return { outcome: 'failed', failure };
    if (pi.piRefusal(key, version, palette)) return { outcome: 'refused' };
  }
  if (nativeExact && nativeText.length > 0 || exactDisplay || !sources.workStatus(key).fallbackEligible) return { outcome: 'waiting' };
  if (cached && (cached.version > version || cached.version === version && cached.language === piLanguage && cached.text !== text)) return { outcome: 'stale' };
  return pi.classify({ key, version, text, language: piLanguage, path, palette, neutral: demand.piNeutral }, classify);
}

/** Pure keyed metadata read: no classification, observation, allocation grants,
 * source traversal, range/style visits or dispatch. Visitor output is provisional
 * until its final true result, and must be discarded otherwise. */
export function resolveSyntax(sources: SourceWorkPort, piFallback: PiFallbackPort, identity: SyntaxIdentity): SyntaxResolution {
  const { key, version, language, piLanguage, complete, palette, fallback } = identity;
  const allowPi = fallback === 'pi';
  const work = sources.workStatus(key), native = sources.borrowSource(key), pi = allowPi ? piFallback.borrowPiSource(key) : undefined;
  const matchingNative = native?.version === version && native.language === language ? native : undefined;
  const currentNative = matchingNative;
  const status = matchingNative ? sources.status(key) : undefined;
  const nativeExact = !!status?.exact;
  const basis = sources.displayBasis(key);
  const display = complete && basis?.complete && basis.exactVersion === version && basis.language === language ? basis : undefined;
  const matchingPi = pi?.version === version && pi.language === piLanguage ? pi : undefined;
  const projection = matchingPi ? piFallback.piProjection(key, version, palette) : undefined;
  const failure = matchingPi && piFallback.piFailure(key, version, palette);
  const refusal = matchingPi && piFallback.piRefusal(key, version, palette);
  const owner = new WeakRef(sources);
  return { key, version, language, piLanguage, complete, palette, fallback, owner, nativeExact,
    execution: work.execution, fallbackEligible: work.fallbackEligible, piStyled: projection ? matchingPi?.styleDirectives : undefined, committedBytes: status?.committedBytes,
    needsPi: allowPi && (work.version === undefined || work.version <= version) && (pi === undefined || pi.version <= version)
      && !nativeExact && !display && !projection && work.fallbackEligible && !failure && !refusal,
    nativeGeneration: currentNative?.generation, piGeneration: projection?.generation, display,
    native: currentNative && basis && (status?.classificationVersion !== undefined || nativeExact)
      ? nativeReader(owner, key, currentNative.generation, version, basis.stamp, language) : undefined,
    pi: projection };
}
