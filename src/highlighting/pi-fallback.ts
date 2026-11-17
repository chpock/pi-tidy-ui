import type { DiagnosticLevel, DiagnosticSink } from '../diagnostics.ts';
import { reportRuntime } from '../diagnostics.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { DataCharge, DataGrant } from '../resources/data-budget.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { sourceFits, sourceIdentifier as identifier } from './controller-limits.ts';
import type { SemanticRelease } from './storage/semantic-retention.ts';
import type { SemanticRetentionPool } from './storage/semantic-retention.ts';
import type { StagedPiProjection } from './storage/pi-projection.ts';
import type { PiPreparation } from './storage/pi-projection.ts';
import type { BorrowedPiSource, PiFailure, PiProjectionReader } from './source-ports.ts';
import { preparePiFlat, type PreparedPiFlat } from './pi-flat.ts';
import { RETENTION_LIMITS } from './storage/retention.ts';

export type PiClassifier = (text: string, info: { language?: string; path?: string }) => readonly string[];
export type PiClassificationResult = { outcome: 'pi' | 'refused' | 'failed' | 'stale'; failure?: PiFailure };
export type PiClassificationRequest = { key: string; version: number; text: string; language?: string; path?: string; palette: number; neutral: ConcreteStyle };

export interface PiFallbackPort {
  readonly size: number;
  capturePiSource(key: string, version: number, text: string, language?: string): boolean;
  borrowPiSource(key: string): BorrowedPiSource | undefined;
  piPreparation(key: string, generation: number, version: number, palette: number): PiPreparation | undefined;
  reservePiData(ticket: PiPreparation, additionalPeak: number): DataGrant | undefined;
  adoptPiFlat(ticket: PiPreparation, text: string, staged: StagedPiProjection, styleDirectives?: boolean): boolean;
  piRefusal(key: string, version: number, palette: number): boolean;
  piFailure(key: string, version: number, palette: number): PiFailure | undefined;
  recordPiFailure(key: string, generation: number, version: number, palette: number, failure: PiFailure): boolean;
  piProjection(key: string, version: number, palette: number): PiProjectionReader | undefined;
  classify(request: PiClassificationRequest, classify: PiClassifier): PiClassificationResult;
  remove(key: string): void;
  clear(): void;
}

interface PiFallbackAuthority {
  isDisposed(): boolean;
  isActive(): boolean;
  charge(delta: number): boolean;
  wireKey(): string;
  receipts(receipts: readonly SemanticRelease[]): void;
  changed(key: string): void;
  log(level: DiagnosticLevel, explanation: string, fields?: { source?: string; version?: number; generation?: number; palette?: number; reason?: string }): void;
  readonly diagnostic?: DiagnosticSink;
}

type PiSource = { key: string; storageKey: string; generation?: number; version: number; contentVersion: number;
  language?: string; palette?: number; readyPalette?: number; failure?: PiFailure; projectionRefused?: boolean; refused?: boolean; styleDirectives?: boolean; bytes: number };

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
function classificationRows(lines: readonly string[], styled: { value: boolean }): (consume: (index: number, line: string) => void) => boolean {
  return consume => {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.includes('\x1b[')) styled.value = true;
      consume(index, line);
    }
    return true;
  };
}
function piRanges(owner: WeakRef<PiFallbackCoordinator>, key: string, version: number, palette: number, revision: number) {
  return (consume: (start: number, end: number, style: number) => void) => owner.deref()?.visitRanges(key, version, palette, revision, consume) ?? false;
}
function piStyles(owner: WeakRef<PiFallbackCoordinator>, key: string, version: number, palette: number, revision: number) {
  return (consume: (index: number, style: ConcreteStyle) => void) => owner.deref()?.visitStyles(key, version, palette, revision, consume) ?? false;
}

/** Pi's local fallback snapshots and projection lifecycle share the native pool, but not native execution authority. */
export class PiFallbackCoordinator implements PiFallbackPort {
  private readonly owner = new WeakRef(this);
  private readonly sources = new Map<string, PiSource>();
  private readonly generations = new Map<number, PiSource>();
  private readonly pool: SemanticRetentionPool;
  private readonly authority: PiFallbackAuthority;

  constructor(pool: SemanticRetentionPool, authority: PiFallbackAuthority) {
    this.pool = pool; this.authority = authority;
  }

  get size(): number { return this.sources.size; }
  has(key: string): boolean { return this.sources.has(key); }

  /** Exact Pi fallback snapshots share the native result pool but do not require an enabled/available daemon. */
  capturePiSource(key: string, version: number, text: string, language?: string): boolean {
    if (!this.authority.isActive()) return false;
    if (!identifier(key) || !Number.isInteger(version) || version < 0 || version > 0xffffffff
      || typeof text !== 'string' || language !== undefined && !identifier(language, 128)) throw new Error('invalid Pi source');
    let state = this.sources.get(key);
    if (state && version < state.version) throw new Error('non-monotonic Pi source');
    if (state?.refused && version === state.version) return false;
    if (state && version === state.version && language === state.language)
      return state.generation !== undefined && !!this.pool.status(state.generation);
    if (!sourceFits(text, HIGHLIGHT_LIMITS.piSourceBytes)) return this.refuseSource(state, version);
    if (!state) {
      const storageKey = this.authority.wireKey(), bytes = RETENTION_LIMITS.entryAllowance + 2*(key.length + storageKey.length + (language?.length ?? 0));
      if (!this.authority.charge(bytes)) return false;
      state = { key, storageKey, version, contentVersion: version, language, bytes };
      this.sources.set(key, state);
    } else {
      const bytes = RETENTION_LIMITS.entryAllowance + 2*(key.length + state.storageKey.length + (language?.length ?? 0));
      if (!this.authority.charge(bytes - state.bytes)) return this.refuseSource(state, version);
      state.bytes = bytes;
      const old = state.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
      if (old?.text === text && state.language === language) {
        const result = this.pool.replaceSnapshot(state.generation!, version, text); this.authority.receipts(result.released);
        state.version = version; return result.accepted && state.generation !== undefined;
      }
    }
    state.version = version; state.contentVersion = version; state.language = language; state.palette = undefined; state.readyPalette = undefined;
    state.failure = undefined; state.projectionRefused = false; state.refused = false;
    if (state.generation !== undefined) this.authority.receipts(this.pool.remove(state.generation));
    const result = this.pool.admit(state.storageKey, version, text); this.authority.receipts(result.released);
    state.generation = result.generation;
    if (result.accepted) this.generations.set(result.generation!, state);
    return result.accepted;
  }

  /** Fresh primitive capture with cached UTF8; never exposes owned row arrays. */
  borrowPiSource(key: string): BorrowedPiSource | undefined {
    const state = this.sources.get(key);
    const source = state?.generation === undefined ? undefined : this.pool.borrowSnapshot(state.generation);
    return source && state ? { ...source, generation: state.generation!, language: state.language, styleDirectives: state.styleDirectives } : undefined;
  }

  /** Storage identity only. The caller must independently check the source-work authority. */
  piPreparation(key: string, generation: number, version: number, palette: number): PiPreparation | undefined {
    if (!Number.isSafeInteger(palette) || palette < 0) throw new Error('invalid Pi palette revision');
    const state = this.sources.get(key);
    if (!this.authority.isActive() || !state || state.generation !== generation || state.version !== version
      || state.palette !== undefined && palette < state.palette || state.palette === palette && (state.failure !== undefined || state.projectionRefused)) return undefined;
    const released: SemanticRelease[] = [];
    let result: ReturnType<SemanticRetentionPool['piPreparation']>;
    try { result = this.pool.piPreparation(generation, version, palette, released); }
    finally { this.authority.receipts(released); }
    if (!result.accepted) { this.recordPiRefusal(state, palette); return undefined; }
    state.palette = palette; state.failure = undefined; state.projectionRefused = false;
    return result.ticket;
  }

  private acceptsPreparation(ticket: PiPreparation): boolean {
    if (!this.authority.isActive() || !this.pool.acceptsPiPreparation(ticket)) return false;
    const state = this.generations.get(ticket.generation);
    return !!state && state.version === ticket.version && state.palette === ticket.palette && !state.failure && !state.projectionRefused;
  }

  reservePiData(ticket: PiPreparation, additionalPeak: number): DataGrant | undefined {
    if (!this.acceptsPreparation(ticket)) return undefined;
    const result = this.pool.reserve(ticket.generation, additionalPeak); this.authority.receipts(result.released);
    if (!result.accepted || !this.acceptsPreparation(ticket)) {
      if (this.acceptsPreparation(ticket)) this.recordPiRefusal(this.generations.get(ticket.generation)!, ticket.palette);
      return undefined;
    }
    const grant = this.pool.budget.reserve(additionalPeak);
    if (!grant) this.recordPiRefusal(this.generations.get(ticket.generation)!, ticket.palette);
    return grant;
  }

  /** Ownership is consumed even for stale/foreign tickets and invalid candidates. */
  adoptPiFlat(ticket: PiPreparation, text: string, staged: StagedPiProjection, styleDirectives?: boolean): boolean {
    if (!this.acceptsPreparation(ticket)) { staged.dispose(); return false; }
    const released: SemanticRelease[] = [];
    let result: ReturnType<SemanticRetentionPool['adoptPiFlat']>;
    try { result = this.pool.adoptPiFlat(ticket, text, staged, released); }
    finally { this.authority.receipts(released); }
    const state = this.generations.get(ticket.generation);
    if (!state || state.version !== ticket.version || state.palette !== ticket.palette) return false;
    if (!result.accepted) { if (result.refused) this.recordPiRefusal(state, ticket.palette); return false; }
    state.readyPalette = ticket.palette; state.failure = undefined; state.projectionRefused = false; state.styleDirectives = styleDirectives;
    reportRuntime(this.authority.diagnostic, { kind: 'recovered', scope: state, operation: 'pi' });
    this.authority.changed(state.key); return true;
  }

  private recordPiRefusal(state: PiSource, palette: number): void {
    state.palette = palette; state.failure = undefined; state.projectionRefused = true;
  }
  piRefusal(key: string, version: number, palette: number): boolean {
    const state = this.sources.get(key);
    return !this.authority.isDisposed() && state?.version === version && state.palette === palette && state.projectionRefused === true;
  }
  piFailure(key: string, version: number, palette: number): PiFailure | undefined {
    const state = this.sources.get(key);
    return !this.authority.isDisposed() && state?.version === version && state.palette === palette ? state.failure : undefined;
  }
  recordPiFailure(key: string, generation: number, version: number, palette: number, failure: PiFailure): boolean {
    if (!Number.isSafeInteger(palette) || palette < 0 || failure !== 'threw' && failure !== 'invalid_rows') throw new Error('invalid Pi failure');
    const state = this.sources.get(key);
    if (!this.authority.isActive() || !state || state.generation !== generation || state.version !== version
      || state.palette !== undefined && palette < state.palette) return false;
    if (state.palette === palette && state.projectionRefused || this.projectionStatus(key, version, palette)) return false;
    const changed = state.palette !== palette || state.failure !== failure;
    state.palette = palette; state.failure = failure; state.projectionRefused = false;
    if (changed) {
      this.authority.log('ERROR', 'Pi fallback classification failed; exact failure cached', { source: key, version, generation, palette, reason: failure });
      reportRuntime(this.authority.diagnostic, { kind: 'failure', scope: state, operation: 'pi', area: 'syntax', code: failure });
    }
    return true;
  }

  piProjection(key: string, version: number, palette: number): PiProjectionReader | undefined {
    const status = this.projectionStatus(key, version, palette); if (!status) return undefined;
    return Object.freeze({ ...status, version, palette,
      visitRanges: piRanges(this.owner, key, version, palette, status.revision),
      visitStyles: piStyles(this.owner, key, version, palette, status.revision) });
  }
  private projectionStatus(key: string, version: number, palette: number) {
    const state = this.sources.get(key), generation = state?.generation;
    if (this.authority.isDisposed() || !state || generation === undefined || state.version !== version || state.readyPalette !== palette) return undefined;
    const status = this.pool.piProjectionStatus(generation);
    return status && status.version >= state.contentVersion && status.version <= version ? { ...status, generation } : undefined;
  }
  visitRanges(key: string, version: number, palette: number, revision: number, consume: (start: number, end: number, style: number) => void): boolean {
    const generation = this.projectionStatus(key, version, palette)?.generation;
    if (generation === undefined || this.projectionStatus(key, version, palette)?.revision !== revision) return false;
    const available = this.pool.visitPiRanges(generation, revision, (start, end, style) => {
      if (this.projectionStatus(key, version, palette)?.revision === revision) consume(start, end, style);
    });
    return available && this.projectionStatus(key, version, palette)?.revision === revision;
  }
  visitStyles(key: string, version: number, palette: number, revision: number, consume: (index: number, style: ConcreteStyle) => void): boolean {
    const generation = this.projectionStatus(key, version, palette)?.generation;
    if (generation === undefined || this.projectionStatus(key, version, palette)?.revision !== revision) return false;
    const available = this.pool.visitPiStyles(generation, revision, (index, style) => {
      if (this.projectionStatus(key, version, palette)?.revision === revision) consume(index, style);
    });
    return available && this.projectionStatus(key, version, palette)?.revision === revision;
  }

  private refuseSource(state: PiSource | undefined, version: number): false {
    if (state) {
      state.version = version; state.contentVersion = version; state.palette = undefined; state.readyPalette = undefined;
      state.failure = undefined; state.projectionRefused = false; state.refused = true;
      if (state.generation !== undefined) this.authority.receipts(this.pool.remove(state.generation));
    }
    return false;
  }
  remove(key: string): void {
    const state = this.sources.get(key); if (!state) return;
    reportRuntime(this.authority.diagnostic, { kind: 'released', scope: state, operation: '*' });
    this.sources.delete(key); this.authority.charge(-state.bytes);
    if (state.generation !== undefined) this.authority.receipts(this.pool.remove(state.generation));
  }
  clear(): void { for (const key of this.sources.keys()) this.remove(key); }
  releaseGeneration(generation: number): boolean {
    const state = this.generations.get(generation); if (!state) return false;
    this.generations.delete(generation);
    state.generation = undefined; state.palette = undefined; state.readyPalette = undefined;
    this.authority.changed(state.key);
    return true;
  }

  classify(request: PiClassificationRequest, classify: PiClassifier): PiClassificationResult {
    const { key, version, text, language, path, palette, neutral } = request;
    if (!this.authority.isActive()) return { outcome: 'stale' };
    if (!this.capturePiSource(key, version, text, language)) return { outcome: 'refused' };
    const source = this.borrowPiSource(key);
    if (!source || source.version !== version || source.language !== language || source.text !== text) return { outcome: 'stale' };
    if (this.piProjection(key, version, palette)) return { outcome: 'pi' };
    const failure = this.piFailure(key, version, palette);
    if (failure) return { outcome: 'failed', failure };
    if (this.piRefusal(key, version, palette)) return { outcome: 'refused' };
    const ticket = this.piPreparation(key, source.generation, version, palette);
    if (!ticket) return { outcome: this.piRefusal(key, version, palette) ? 'refused' : 'stale' };
    let lines: readonly string[] | undefined, ansi: DataCharge | undefined;
    let candidate: PreparedPiFlat | undefined, staged: StagedPiProjection | undefined;
    const failed = (kind: PiFailure): PiClassificationResult => this.recordPiFailure(key, ticket.generation, version, palette, kind)
      ? { outcome: 'failed', failure: kind } : { outcome: 'stale' };
    const denied = (): PiClassificationResult => ({ outcome: this.piRefusal(key, version, palette) ? 'refused' : 'stale' });
    const reserve = (bytes: number) => this.reservePiData(ticket, bytes);
    try {
      try { lines = ticket.text!.length ? classify(ticket.text!, { language, path }) : []; }
      catch { return this.authority.isActive() ? failed('threw') : { outcome: 'stale' }; }
      if (!this.authority.isActive()) return { outcome: 'stale' };
      const bytes = ansiBytes(lines, ticket.budget.limit);
      if (bytes === undefined) return failed('invalid_rows');
      const grant = reserve(bytes);
      if (!grant) return denied();
      try { ansi = grant.consume(bytes); } finally { grant.close(); }
      const styled = { value: false };
      const prepared = preparePiFlat(ticket.text!, classificationRows(lines, styled), neutral, ticket.budget, reserve);
      if (prepared.outcome !== 'ready') return prepared.outcome === 'invalid' ? failed('invalid_rows') : denied();
      candidate = prepared.projection;
      staged = candidate.stage(reserve);
      if (!staged) return denied();
      return this.adoptPiFlat(ticket, ticket.text!, staged, styled.value) ? { outcome: 'pi' } : denied();
    } finally {
      staged?.dispose(); candidate?.dispose(); lines = undefined; ansi?.release(); ticket.release();
    }
  }
}
