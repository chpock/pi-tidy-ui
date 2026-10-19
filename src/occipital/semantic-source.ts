import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from './limits.ts';
import { inspectContextBatch, SemanticError } from './semantic-codec.ts';
import type { Counters } from './protocol.ts';

export interface SemanticExpectation {
  key: string;
  generation: number;
  source_version: number;
  revision: number;
  source_bytes: number;
  replace_from: number;
  complete: boolean;
  lease?: string;
  /** Only the changed suffix, not a re-encoding of the committed prefix. */
  replacementText: string;
}
export interface SemanticChunk extends Omit<SemanticExpectation, 'replacementText'> {
  /** Validated body provenance, not another per-source wire field. */
  readonly vocabulary: string;
  committed_bytes: number;
  contexts: Uint32Array[];
  /** Absolute byte endpoints paired with reply-local context IDs; 0 is unclassified. */
  runs: Uint32Array;
  counters: Counters;
}
export interface SemanticSourceIdentity {
  vocabulary: string;
  vocabularySize: number;
  sourceBytes: number;
  runs: number;
  batchSources: number;
}
const uint32 = 0xffffffff, SOURCE_UNITS = 512;
const counterKeys = ['committed_line_calls', 'committed_line_bytes', 'tail_calls', 'tail_bytes'] as const;
const sourceKeys = ['key', 'generation', 'source_version', 'revision', 'source_bytes', 'replace_from', 'committed_bytes', 'complete', 'contexts', 'runs', 'counters'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = uint32): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 64 && !/[\p{Cc}\p{Cs}]/u.test(v);
function fail(): never { throw new SemanticError('invalid_source'); }
function coherent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}
interface Validated {
  metadata: Omit<SemanticChunk, 'runs' | 'contexts' | 'vocabulary'>;
  wireRuns: number[];
  contexts: unknown[];
}
function validate(value: unknown, expected: SemanticExpectation, sourceCap: number, runCap: number): Validated {
  if (!object(value) || !exact(value, Object.hasOwn(value, 'lease') ? [...sourceKeys, 'lease'] : sourceKeys)
    || !identifier(value.key) || !integer(value.generation, 1) || !integer(value.source_version)
    || !integer(value.revision, 1) || !integer(value.source_bytes, 0, sourceCap)
    || !integer(value.replace_from, 0, value.source_bytes) || !integer(value.committed_bytes, value.replace_from, value.source_bytes)
    || typeof value.complete !== 'boolean' || !Array.isArray(value.contexts) || !Array.isArray(value.runs) || value.runs.length % 2 !== 0
    || value.runs.length > runCap * 2 || !object(value.counters) || !exact(value.counters, counterKeys)) fail();
  for (const key of ['key', 'generation', 'source_version', 'revision', 'source_bytes', 'replace_from', 'complete'] as const)
    if (value[key] !== expected[key]) fail();
  if (expected.lease !== undefined ? value.lease !== expected.lease || !identifier(value.lease)
    : value.complete ? Object.hasOwn(value, 'lease') : !identifier(value.lease)) fail();
  const counters = {} as Counters;
  for (const key of counterKeys) {
    const count = value.counters[key];
    if (!integer(count, 0, Number.MAX_SAFE_INTEGER)) fail();
    counters[key] = count;
  }
  const suffixBytes = value.source_bytes - value.replace_from;
  if (expected.replacementText.length > sourceCap || !coherent(expected.replacementText) || Buffer.byteLength(expected.replacementText) !== suffixBytes) fail();
  // Transient suffix UTF8 validation belongs to the caller's held request budget;
  // committed text is neither copied nor re-encoded here.
  const suffix = Buffer.from(expected.replacementText, 'utf8');
  const boundary = (absolute: number) => absolute === value.source_bytes || (suffix[absolute - (value.replace_from as number)]! & 0xc0) !== 0x80;
  const committed = value.complete ? value.source_bytes : value.replace_from + suffix.lastIndexOf(10) + 1;
  if (value.committed_bytes !== committed || !boundary(committed)) fail();
  let end = value.replace_from, previous: number | undefined;
  for (let i = 0; i < value.runs.length; i += 2) {
    const length = value.runs[i], id = value.runs[i + 1];
    if (!integer(length, 1, value.source_bytes - end) || !integer(id, 0, value.contexts.length) || id === previous) fail();
    end += length;
    if (!boundary(end)) fail();
    previous = id;
  }
  if (end !== value.source_bytes) fail();
  return { wireRuns: value.runs as number[], contexts: value.contexts,
    metadata: { key: value.key, generation: value.generation, source_version: value.source_version, revision: value.revision,
      source_bytes: value.source_bytes, replace_from: value.replace_from, committed_bytes: value.committed_bytes,
      complete: value.complete, ...(value.lease !== undefined ? { lease: value.lease as string } : {}), counters } };
}

/** Decodes a source body only AFTER caller-owned v3 header/ticket/assets validation.
 * All identities, ranges and dictionaries pass before any owned vector is created.
 * No parser/theme/current-provider authority is inferred from these display data. */
export function decodeSemanticSources(value: unknown, identity: SemanticSourceIdentity, expected: readonly SemanticExpectation[], availableBytes: number): {
  sources: SemanticChunk[]; policyBytes: number;
} {
  if (!object(value) || !exact(value, ['kind', 'vocabulary', 'sources']) || value.kind !== 'source'
    || !/^[a-f0-9]{64}$/.test(identity.vocabulary) || value.vocabulary !== identity.vocabulary
    || !integer(identity.sourceBytes, 1, OCCIPITAL_LIMITS.sourceBytes) || !integer(identity.runs, 1, OCCIPITAL_LIMITS.runs)
    || !integer(identity.batchSources, 1, OCCIPITAL_LIMITS.batchSources) || !integer(availableBytes, 0, OCCIPITAL_LIMITS.retainedBytes)
    || !Array.isArray(value.sources) || expected.length < 1 || expected.length > identity.batchSources
    || expected.length !== value.sources.length) fail();
  availableBytes = Math.min(availableBytes, HIGHLIGHT_LIMITS.decodedBytes);
  const sourceCap = Math.min(identity.sourceBytes, HIGHLIGHT_LIMITS.sourceBytes);
  const vocabulary = identity.vocabulary;
  const values = new Map<string, unknown>();
  let total = 0;
  for (const source of value.sources) {
    if (!object(source) || !identifier(source.key) || values.has(source.key) || !integer(source.source_bytes, 0, sourceCap)) fail();
    total += source.source_bytes;
    if (total > sourceCap) fail();
    values.set(source.key, source);
  }
  if (new Set(expected.map(source => source.key)).size !== expected.length) fail();
  const validated = expected.map(source => validate(values.get(source.key), source, sourceCap, identity.runs));
  const contextPlan = inspectContextBatch(validated.map(source => source.contexts), { vocabularySize: identity.vocabularySize, maxBytes: availableBytes });
  const policyBytes = validated.reduce((bytes, source) => bytes + SOURCE_UNITS + source.wireRuns.length * 4,
    contextPlan.policyBytes + 32 + 2 * vocabulary.length);
  if (!Number.isSafeInteger(policyBytes) || policyBytes > availableBytes) throw new SemanticError('source_limit');
  const contexts = contextPlan.materialize();
  const sources = validated.map((source, index) => {
    const runs = new Uint32Array(source.wireRuns.length);
    let end = source.metadata.replace_from;
    for (let i = 0; i < runs.length; i += 2) {
      end += source.wireRuns[i]!; runs[i] = end; runs[i + 1] = source.wireRuns[i + 1]!;
    }
    return { ...source.metadata, vocabulary, contexts: contexts[index]!, runs };
  });
  return { sources, policyBytes };
}
