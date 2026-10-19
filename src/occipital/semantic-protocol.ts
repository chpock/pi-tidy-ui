import { ProtocolError, RemoteFault, type Limits, type ProfileDescription, type Description } from './protocol.ts';
import { decodeStyleResult, SemanticError, type StyleIdentity } from './semantic-codec.ts';
import { decodeSemanticSources, type SemanticExpectation } from './semantic-source.ts';
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from './limits.ts';
import { replyJsonBytes, type ReplySize } from './data-json.ts';

export const SEMANTIC_PROTOCOL_VERSION = 3;
export const SEMANTIC_CAPABILITY = 'syntax-highlight/v3';
export const SEMANTIC_OPERATIONS = Object.freeze(['describe', 'themes.refresh', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve']);
export interface SemanticDescription {
  readonly instance: string;
  readonly assets: string;
  readonly vocabulary: Readonly<{ fingerprint: string; count: number }>;
  readonly backend_version: string;
  readonly catalogue_revision: number;
  readonly profiles: readonly ProfileDescription[];
  readonly diagnostic: string | null;
  readonly limits: Limits;
  readonly runtime: Description['runtime'];
}
export interface SemanticStyleExpectation extends StyleIdentity {
  readonly paletteFingerprint: string | null;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = 0xffffffff): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown, cap = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= cap && Buffer.byteLength(v) <= cap && !/[\p{Cc}\p{Cs}]/u.test(v);
const fingerprint = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function list(value: unknown, required: readonly string[], cap: number): boolean {
  return Array.isArray(value) && value.length <= cap && value.every(item => text(item))
    && new Set(value).size === value.length && required.every(item => value.includes(item));
}

/** Header only; no context/style materialization before correlation and provider checks. */
export function decodeSemanticEnvelope(value: unknown, ticket: string, identity?: Pick<SemanticDescription, 'instance' | 'assets'>): {
  instance: string; assets: string; body: unknown;
} {
  if (!object(value) || value.v !== SEMANTIC_PROTOCOL_VERSION || value.ticket !== ticket || !text(value.ticket)
    || !text(value.instance) || !text(value.assets, 256) || (value.status !== 'ok' && value.status !== 'error')) throw new ProtocolError('invalid_header');
  if (identity && (identity.instance !== value.instance || identity.assets !== value.assets)) throw new ProtocolError('provider_changed');
  if (value.status === 'error') {
    if (!exact(value, ['v', 'ticket', 'instance', 'assets', 'status', 'error']) || !object(value.error)
      || !exact(value.error, ['code', 'execution']) || !text(value.error.code)
      || (value.error.execution !== 'not_started' && value.error.execution !== 'started')) throw new ProtocolError('invalid_header');
    throw new RemoteFault(value.error.code, value.error.execution);
  }
  if (!exact(value, ['v', 'ticket', 'instance', 'assets', 'status', 'body'])) throw new ProtocolError('invalid_header');
  return { instance: value.instance, assets: value.assets, body: value.body };
}

const descriptorKeys = ['kind', 'protocol_version', 'contexts_revision', 'resolver_revision', 'palette_revision', 'vocabulary', 'assets',
  'backend_version', 'catalogue_revision', 'capability', 'service', 'operations', 'modes', 'admission', 'profiles', 'diagnostic', 'limits', 'runtime'];
const limitKeys = ['request_bytes', 'reply_bytes', 'control_request_bytes', 'control_reply_bytes', 'source_bytes', 'line_bytes', 'batch_sources',
  'queue_wait_ms', 'state_pool_bytes', 'leases', 'leases_per_route', 'runs', 'idle_ms', 'age_ms', 'quantum_ms', 'data_per_route', 'control_per_route', 'routes', 'workers'] as const;
const runtimeKeys = ['pid', 'routes', 'leases', 'data_bytes', 'data_jobs', 'queued', 'control_bytes', 'control_jobs'] as const;
export function decodeSemanticDescription(value: unknown, ticket: string): SemanticDescription {
  const envelope = decodeSemanticEnvelope(value, ticket), body = envelope.body;
  const fail = (): never => { throw new ProtocolError('invalid_descriptor'); };
  if (!object(body) || !exact(body, descriptorKeys) || body.kind !== 'descriptor' || body.protocol_version !== SEMANTIC_PROTOCOL_VERSION
    || body.contexts_revision !== 1 || body.resolver_revision !== 1 || body.palette_revision !== 1 || body.assets !== envelope.assets
    || body.capability !== SEMANTIC_CAPABILITY || body.service !== 'syntax' || !text(body.backend_version, 128) || !integer(body.catalogue_revision, 0, Number.MAX_SAFE_INTEGER)
    || !object(body.vocabulary) || !exact(body.vocabulary, ['fingerprint', 'count']) || !fingerprint(body.vocabulary.fingerprint) || !integer(body.vocabulary.count, 1)
    || !list(body.operations, SEMANTIC_OPERATIONS, 16) || !list(body.modes, ['one_shot', 'growing'], 4) || !list(body.admission, ['try_now', 'bounded_queue'], 4)
    || !Array.isArray(body.profiles) || body.profiles.length > 48 || body.diagnostic !== null && !text(body.diagnostic, 256)
    || !object(body.limits) || !exact(body.limits, limitKeys) || !object(body.runtime) || !exact(body.runtime, runtimeKeys)) return fail();
  const seen = new Set<string>(), profiles: ProfileDescription[] = [];
  for (const profile of body.profiles) {
    if (!object(profile) || !exact(profile, ['id', 'label', 'fingerprint']) || !text(profile.id) || profile.id === 'pi'
      || !text(profile.label, 128) || !fingerprint(profile.fingerprint) || seen.has(profile.id)) return fail();
    seen.add(profile.id); profiles.push({ id: profile.id, label: profile.label, fingerprint: profile.fingerprint });
  }
  const limits = {} as Omit<Limits, 'styles'>;
  for (const key of limitKeys) {
    const number = body.limits[key]; if (!integer(number, 1)) return fail(); limits[key] = number;
  }
  // Shared SDK parses replies before our boundary. An honest provider must
  // enforce the DATA cap itself; postparse clamping cannot make an older service safe.
  if (limits.reply_bytes > HIGHLIGHT_LIMITS.dataWireBytes) return fail();
  const runtime = {} as Description['runtime'];
  for (const key of runtimeKeys) {
    const count = body.runtime[key]; if (!integer(count, key === 'pid' ? 1 : 0, Number.MAX_SAFE_INTEGER)) return fail();
    (runtime as Record<string, number>)[key] = count;
  }
  return { instance: envelope.instance, assets: envelope.assets,
    vocabulary: { fingerprint: body.vocabulary.fingerprint, count: body.vocabulary.count },
    backend_version: body.backend_version, catalogue_revision: body.catalogue_revision, profiles, diagnostic: body.diagnostic as string | null, limits, runtime };
}

export function decodeSemanticStyleReply(value: unknown, ticket: string, provider: Pick<SemanticDescription, 'instance' | 'assets' | 'vocabulary'> & Partial<Pick<SemanticDescription, 'limits'>>,
  expected: SemanticStyleExpectation, contextCount: number, availableBytes: number, measured?: Readonly<ReplySize>): ReturnType<typeof decodeStyleResult> {
  replyJsonBytes(value, ticket, Math.min(HIGHLIGHT_LIMITS.dataWireBytes, provider.limits?.reply_bytes ?? HIGHLIGHT_LIMITS.dataWireBytes), measured);
  const body = decodeSemanticEnvelope(value, ticket, provider).body;
  if (expected.vocabulary !== provider.vocabulary.fingerprint) throw new SemanticError('identity_mismatch');
  // Definition identity is additional to expression/schema validity. Do not first
  // adopt a whole palette from a different immutable theme and reject it later.
  if (expected.mode === 'native') {
    if (!fingerprint(expected.paletteFingerprint) || !object(body) || !object(body.palette)
      || body.palette.fingerprint !== expected.paletteFingerprint) throw new SemanticError('identity_mismatch');
  } else if (expected.paletteFingerprint !== null) throw new SemanticError('identity_mismatch');
  return decodeStyleResult(body, expected, contextCount, availableBytes);
}

export function decodeSemanticSourceReply(value: unknown, ticket: string, provider: SemanticDescription,
  expected: readonly SemanticExpectation[], availableBytes: number, measured?: Readonly<ReplySize>): ReturnType<typeof decodeSemanticSources> {
  replyJsonBytes(value, ticket, Math.min(HIGHLIGHT_LIMITS.dataWireBytes, provider.limits.reply_bytes), measured);
  const body = decodeSemanticEnvelope(value, ticket, provider).body;
  return decodeSemanticSources(body, { vocabulary: provider.vocabulary.fingerprint, vocabularySize: provider.vocabulary.count,
    sourceBytes: Math.min(provider.limits.source_bytes, HIGHLIGHT_LIMITS.sourceBytes),
    runs: Math.min(provider.limits.runs, OCCIPITAL_LIMITS.runs),
    batchSources: Math.min(provider.limits.batch_sources, OCCIPITAL_LIMITS.batchSources) }, expected, availableBytes);
}

export function decodeSemanticClosed(value: unknown, ticket: string, provider: Pick<SemanticDescription, 'instance' | 'assets'>): void {
  const body = decodeSemanticEnvelope(value, ticket, provider).body;
  if (!object(body) || !exact(body, ['kind']) || body.kind !== 'closed') throw new ProtocolError('invalid_header');
}
