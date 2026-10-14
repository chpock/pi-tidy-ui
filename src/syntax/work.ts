import type { CardTheme } from '../card-theme.ts';
import type { SyntaxClient } from '../occipital/client.ts';
import type { PiFailure, SourceController, SourceDemand, SourceWorkStatus } from '../occipital/controller.ts';
import { paintBashCommand, paintFileSource, type RangeReader } from './paint.ts';
import { piRangeReader, type PiRowReader } from './pi.ts';

export type SyntaxDemand = Omit<SourceDemand, 'profile' | 'fingerprint'> & { palette: number; fallback?: 'pi' | 'neutral' };
export type SyntaxIdentity = Pick<SyntaxDemand, 'key' | 'version' | 'language' | 'complete' | 'palette' | 'fallback'>;
export type PiClassifier = (text: string, info: { language?: string; path?: string }) => readonly string[];
export type SyntaxWorkResult = { outcome: 'native' | 'pi' | 'neutral' | 'waiting' | 'refused' | 'failed' | 'stale'; failure?: PiFailure; awaitingProvider?: true };
export interface SyntaxResolution extends SyntaxIdentity {
  owner: WeakRef<SourceController>;
  nativeExact: boolean;
  execution: SourceWorkStatus['execution'];
  fallbackEligible: boolean;
  piStyled?: boolean;
  committedBytes?: number;
  needsPi: boolean;
  profileRetryAllowed: boolean;
  nativeGeneration?: number;
  piGeneration?: number;
  native?: RangeReader;
  pi?: RangeReader;
}
type Client = Pick<SyntaxClient, 'sources' | 'snapshot'>;

function nativeCurrent(sources: SourceController, key: string, generation: number, version: number, language?: string) {
  const source = sources.borrowSource(key);
  return source?.generation === generation && source.version === version && source.language === language ? source : undefined;
}
function piCurrent(sources: SourceController, key: string, generation: number, version: number, language?: string) {
  const source = sources.borrowPiSource(key);
  return source?.generation === generation && source.version === version && source.language === language ? source : undefined;
}

// Factories live outside caller/client scopes. Only weak ownership and primitive
// identity survive creation; source text and row/range payloads are visit-local.
function nativeReader(owner: WeakRef<SourceController>, key: string, generation: number, version: number, language?: string): RangeReader {
  return consume => {
    const sources = owner.deref();
    if (!sources || !nativeCurrent(sources, key, generation, version, language)) return false;
    const available = sources.visitRanges(key, consume);
    return available && !!nativeCurrent(sources, key, generation, version, language);
  };
}
function piRows(owner: WeakRef<SourceController>, key: string, generation: number, version: number, palette: number, language?: string): PiRowReader {
  return consume => {
    const sources = owner.deref();
    if (!sources || !piCurrent(sources, key, generation, version, language)) return false;
    const available = sources.visitPiBridge(key, version, palette, consume);
    return available && !!piCurrent(sources, key, generation, version, language);
  };
}
function piReader(owner: WeakRef<SourceController>, key: string, generation: number, version: number,
  palette: number, neutralStyle: number, language?: string): RangeReader {
  const rows = piRows(owner, key, generation, version, palette, language);
  return consume => {
    const sources = owner.deref();
    const source = sources && piCurrent(sources, key, generation, version, language);
    if (!sources || !source) return false;
    const available = piRangeReader(source.text, rows, neutralStyle)(consume);
    return available && !!piCurrent(sources, key, generation, version, language) && sources.hasPiBridge(key, version, palette);
  };
}
function classificationRows(lines: readonly string[]): PiRowReader {
  return consume => {
    if (!Array.isArray(lines)) return false;
    for (let index = 0; index < lines.length; index++) consume(index, lines[index]!);
    return true;
  };
}
const ignoreRange = () => {};

/** Explicit useful/coalesced demand, outside render. Caller prepares text and
 * selects the public Pi language; path is informational, not another cache key.
 * Fallback is a surface choice: a Bash-language file can still use Pi, while a
 * Bash command card selects neutral. No flush/RPC, readiness scan, timer or secondary scheduling is introduced.
 * Storage refusal is an outcome, never a fabricated classifier-failure marker. */
export function requestSyntax(client: Client, demand: SyntaxDemand, classify: PiClassifier): SyntaxWorkResult {
  const sources = client.sources, metadata = client.snapshot();
  const { key, version, text, language, path, complete, palette } = demand;
  if (metadata.enabled && metadata.provider.availability === 'ready' && metadata.effective) {
    const profile = metadata.effective;
    if (!sources.observe({ key, version, text, language, path, complete, profile: profile.id, fingerprint: profile.fingerprint }))
      return { outcome: sources.workStatus(key).fallbackEligible ? 'refused' : 'waiting' };
  }
  const native = sources.borrowSource(key);
  if (native?.version === version && native.language === language && native.text === text && sources.status(key)?.exact)
    return { outcome: 'native' };
  if (demand.fallback === 'neutral') return { outcome: sources.workStatus(key).fallbackEligible ? 'neutral' : 'waiting',
    ...(metadata.enabled && (metadata.provider.availability !== 'ready' || !metadata.effective) ? { awaitingProvider: true as const } : {}) };
  const cached = sources.borrowPiSource(key);
  if (cached?.version === version && cached.language === language) {
    if (sources.hasPiBridge(key, version, palette)) return { outcome: 'pi' };
    const failure = sources.piFailure(key, version, palette);
    if (failure) return { outcome: 'failed', failure };
  }
  if (!sources.workStatus(key).fallbackEligible) return { outcome: 'waiting' };
  // First fallback has a separate fully charged entry in the SAME bounded pool;
  // it reuses the immutable logical string but measures its numeric UTF8 length.
  // Exact warmed results above avoid even capture/measurement and row walking.
  if (!sources.capturePiSource(key, version, native?.version === version && native.language === language ? native.text : text, language))
    return { outcome: 'refused' };
  const source = sources.borrowPiSource(key);
  if (!source || source.version !== version || source.language !== language) return { outcome: 'stale' };
  const failure = sources.piFailure(key, version, palette);
  if (failure) return { outcome: 'failed', failure };
  if (sources.hasPiBridge(key, version, palette)) return { outcome: 'pi' }; // Equal-text finalization alias.
  let lines: readonly string[];
  try {
    lines = source.text.length ? classify(source.text, { language, path }) : [''];
  } catch {
    return sources.recordPiFailure(key, source.generation, version, palette, 'threw')
      ? { outcome: 'failed', failure: 'threw' } : { outcome: 'stale' };
  }
  if (!piCurrent(sources, key, source.generation, version, language)) return { outcome: 'stale' };
  // Validation only: a concrete neutral permits bare fonts/reset without theme
  // inference. Rendering projects those ANSI rows with the caller's real neutral.
  const diagnostic = { styleDirectives: false };
  if (!piRangeReader(source.text, classificationRows(lines), 0x40000000, diagnostic)(ignoreRange))
    return sources.recordPiFailure(key, source.generation, version, palette, 'invalid_rows')
      ? { outcome: 'failed', failure: 'invalid_rows' } : { outcome: 'stale' };
  return { outcome: sources.installPiBridge(key, source.generation, version, source.text, palette, lines, diagnostic.styleDirectives) ? 'pi' : 'refused' };
}

/** Pure keyed completion/display read. needsPi is permission/usefulness, not a
 * resubmission command; caller owns processed/refused demand tickets. Typed
 * profile retry permission is exposed, never consumed by a blind observe here.
 * Readers' callbacks are provisional until their final true result. */
export function resolveSyntax(sources: SourceController, identity: SyntaxIdentity, neutralStyle: number): SyntaxResolution {
  const { key, version, language, complete, palette, fallback } = identity;
  const allowPi = fallback !== 'neutral';
  const work = sources.workStatus(key), native = sources.borrowSource(key), pi = allowPi ? sources.borrowPiSource(key) : undefined;
  const currentNative = native?.version === version && native.language === language ? native : undefined;
  const status = currentNative ? sources.status(key) : undefined;
  const nativeExact = !!status?.exact;
  const matchingPi = pi?.version === version && pi.language === language ? pi : undefined;
  const currentPi = matchingPi && sources.hasPiBridge(key, version, palette) ? matchingPi : undefined;
  const failure = matchingPi && sources.piFailure(key, version, palette);
  const owner = new WeakRef(sources);
  return { key, version, language, complete, palette, fallback, owner, nativeExact,
    execution: work.execution, fallbackEligible: work.fallbackEligible, piStyled: currentPi?.styleDirectives, committedBytes: status?.committedBytes,
    needsPi: allowPi && (work.version === undefined || work.version <= version) && (pi === undefined || pi.version <= version)
      && !nativeExact && !currentPi && work.fallbackEligible && !failure,
    profileRetryAllowed: work.version === version && work.profileRetryAllowed,
    nativeGeneration: currentNative?.generation, piGeneration: currentPi?.generation,
    native: currentNative && (status?.classificationVersion !== undefined || nativeExact)
      ? nativeReader(owner, key, currentNative.generation, version, language) : undefined,
    pi: currentPi ? piReader(owner, key, currentPi.generation, version, palette, neutralStyle, language) : undefined };
}

function paint(sources: SourceController, resolution: SyntaxResolution, theme: CardTheme, width?: number): string[] | undefined {
  if (resolution.owner.deref() !== sources) return undefined;
  const { key, version, language, palette, nativeGeneration, piGeneration } = resolution;
  const project = width === undefined ? paintFileSource : (text: string, theme: CardTheme, reader: RangeReader) => paintBashCommand(text, width, theme, reader);
  if (resolution.nativeExact && resolution.native && nativeGeneration !== undefined) {
    const source = nativeCurrent(sources, key, nativeGeneration, version, language);
    if (!source) return undefined;
    const rows = project(source.text, theme, resolution.native);
    return nativeCurrent(sources, key, nativeGeneration, version, language) ? rows : undefined;
  }
  if (resolution.pi && piGeneration !== undefined) {
    const source = piCurrent(sources, key, piGeneration, version, language);
    if (!source) return undefined;
    const rows = project(source.text, theme, resolution.pi);
    return piCurrent(sources, key, piGeneration, version, language) && sources.hasPiBridge(key, version, palette) ? rows : undefined;
  }
  if (resolution.native && nativeGeneration !== undefined) {
    const source = nativeCurrent(sources, key, nativeGeneration, version, language);
    if (!source) return undefined;
    const rows = project(source.text, theme, resolution.native);
    return nativeCurrent(sources, key, nativeGeneration, version, language) ? rows : undefined;
  }
  return undefined; // Caller paints its full neutral glyphs, even on admission refusal.
}

export function paintFileSyntax(sources: SourceController, resolution: SyntaxResolution, theme: CardTheme): string[] | undefined {
  return paint(sources, resolution, theme);
}
export function paintBashSyntax(sources: SourceController, resolution: SyntaxResolution, width: number, theme: CardTheme): string[] | undefined {
  return paint(sources, resolution, theme, width);
}
