import '../../fixtures/test-guard.mjs';

// Compile-only fixtures: uninvoked bodies verify contracts without issuing invalid requests.
import type { ProviderBroker, ProviderTransport } from '../../../src/occipital/provider.ts';
import type { SemanticDataRequest, SemanticTransportRequest } from '../../../src/occipital/semantic-protocol.ts';
import type { SemanticDecodeLimits } from '../../../src/occipital/semantic-codec.ts';
import { decodeContextBatch, decodeStyleResult } from '../../../src/occipital/semantic-codec.ts';
import { decodeSemanticSourceReply, decodeSemanticStyleReply, type SemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { decodeSemanticSources, type SemanticExpectation, type SemanticSourceIdentity } from '../../../src/occipital/semantic-source.ts';
import type { StyleIdentity } from '../../../src/occipital/style-types.ts';
import type { RuleDefinition } from '../../../src/occipital/style-rules.ts';

function assertRequestTypeBoundaries(broker: Pick<ProviderBroker, 'request'>, transport: Pick<ProviderTransport, 'request'>, generation: number) {
  const describe = { v: 4, op: 'describe', ticket: 'describe-ticket' } satisfies SemanticTransportRequest;
  const describedWithInstance = { v: 4, op: 'describe', ticket: 'describe-instance', instance: 'peer' } satisfies SemanticTransportRequest;
  const source = { key: 'source', generation: 1, source_version: 1, hint: {}, text: '' };
  const highlight = { v: 4, op: 'highlight', ticket: 'highlight-ticket', instance: 'peer', admission: 'try_now', sources: [source] } satisfies SemanticDataRequest;
  const streamOpen = { v: 4, op: 'stream.open', ticket: 'open-ticket', instance: 'peer', admission: 'try_now',
    sources: [{ ...source, hint: { language: null, path: null } }] } satisfies SemanticDataRequest;
  const streamAppend = { v: 4, op: 'stream.append', ticket: 'append-ticket', instance: 'peer', admission: 'bounded_queue', queue_wait_ms: 1,
    key: 'source', lease: 'lease', generation: 1, source_version: 2, base_revision: 1, base_bytes: 0, append: '', final: false } satisfies SemanticDataRequest;
  const close = { v: 4, op: 'stream.close', ticket: 'close-ticket', instance: 'peer', key: 'source', lease: 'lease', generation: 1 } satisfies SemanticDataRequest;
  const defaultStyle = { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 } as const;
  const rules: RuleDefinition = { revision: 2, binding_slots: 0, default: defaultStyle, rules: [] };
  const styleRequest = { v: 4, op: 'styles.resolve', ticket: 'style-ticket', instance: 'peer', admission: 'bounded_queue', queue_wait_ms: 1,
    vocabulary: 'a'.repeat(64), contexts: [], rules } satisfies SemanticDataRequest;
  broker.request(generation, highlight);
  broker.request(generation, streamOpen);
  broker.request(generation, streamAppend);
  broker.request(generation, close);
  transport.request(describe);
  transport.request(describedWithInstance);
  transport.request(styleRequest);
  // @ts-expect-error describe belongs to the transport CONTROL lane, not broker DATA.
  broker.request(generation, describe);
  // @ts-expect-error DATA requires an instance identity.
  const missingInstance: SemanticDataRequest = { v: 4, op: 'highlight', ticket: 'missing-instance', admission: 'try_now', sources: [] };
  // @ts-expect-error bounded_queue requires its conditional wait field.
  const missingQueueWait: SemanticDataRequest = { v: 4, op: 'highlight', ticket: 'missing-wait', instance: 'peer', admission: 'bounded_queue', sources: [] };
  // @ts-expect-error try_now forbids a queue wait.
  const queueOnTryNow: SemanticDataRequest = { v: 4, op: 'highlight', ticket: 'unexpected-wait', instance: 'peer', admission: 'try_now', queue_wait_ms: 1, sources: [] };
  // @ts-expect-error close is DATA but has no admission fields.
  const admittedClose: SemanticDataRequest = { v: 4, op: 'stream.close', ticket: 'admitted-close', instance: 'peer', key: 'source', lease: 'lease', generation: 1, admission: 'try_now' };
  // @ts-expect-error each source carries its required hint object.
  const sourceWithoutHint: SemanticDataRequest = { v: 4, op: 'highlight', ticket: 'missing-hint', instance: 'peer', admission: 'try_now', sources: [{ key: 'source', generation: 1, source_version: 1, text: '' }] };
  // @ts-expect-error append requires its exact acknowledged byte basis.
  const appendWithoutBaseBytes: SemanticDataRequest = { v: 4, op: 'stream.append', ticket: 'missing-base', instance: 'peer', admission: 'try_now', key: 'source', lease: 'lease', generation: 1, source_version: 2, base_revision: 1, append: '', final: false };
  void [missingInstance, missingQueueWait, queueOnTryNow, admittedClose, sourceWithoutHint, appendWithoutBaseBytes];
}
void assertRequestTypeBoundaries;

function assertDecoderRequiresExplicitLimits(provider: SemanticDescription, identity: SemanticSourceIdentity,
  expected: readonly SemanticExpectation[], styleIdentity: StyleIdentity) {
  const limits: SemanticDecodeLimits = { sourceBytes: 65_537, contextWords: 65_537, decodedBytes: 3_000_000 };
  const contextLimits: Pick<SemanticDecodeLimits, 'contextWords' | 'decodedBytes'> = limits;
  const styleLimits: Pick<SemanticDecodeLimits, 'decodedBytes'> = limits;
  decodeContextBatch([], { vocabularySize: 1, maxBytes: 1 }, contextLimits);
  decodeStyleResult({}, styleIdentity, 0, 1, styleLimits);
  decodeSemanticSources({}, identity, expected, 1, limits);
  decodeSemanticStyleReply({}, 'ticket', provider, styleIdentity, 0, 1, styleLimits);
  decodeSemanticSourceReply({}, 'ticket', provider, expected, 1, limits);
  // @ts-expect-error context decoding requires a caller-supplied policy.
  decodeContextBatch([], { vocabularySize: 1, maxBytes: 1 });
  // @ts-expect-error STYLE decoding requires a caller-supplied policy.
  decodeStyleResult({}, styleIdentity, 0, 1);
  // @ts-expect-error source decoding requires a caller-supplied policy.
  decodeSemanticSources({}, identity, expected, 1);
  // @ts-expect-error STYLE reply decoding requires a caller-supplied policy.
  decodeSemanticStyleReply({}, 'ticket', provider, styleIdentity, 0, 1);
  // @ts-expect-error SOURCE reply decoding requires a caller-supplied policy.
  decodeSemanticSourceReply({}, 'ticket', provider, expected, 1);
}
void assertDecoderRequiresExplicitLimits;
