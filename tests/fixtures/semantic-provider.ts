import { HIGHLIGHT_LIMITS } from '../../src/occipital/limits.ts';

/** Bounded v4 capability fixture; callers deliberately mutate the fresh body for negative tests. */
export function semanticDescriptor(ticket: unknown, instance = 'instance') {
  return { v: 4, ticket, instance, assets: 'assets', status: 'ok', body: {
    kind: 'descriptor', protocol_version: 4, contexts_revision: 1, resolver_revision: 3, source_hint_revision: 2,
    vocabulary: { fingerprint: 'a'.repeat(64), count: 20 }, assets: 'assets', backend_version: '0.2.0',
    capability: 'syntax-highlight/v4', service: 'syntax',
    operations: ['describe', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve'],
    modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'],
    limits: { request_bytes: HIGHLIGHT_LIMITS.dataWireBytes, reply_bytes: HIGHLIGHT_LIMITS.dataWireBytes, control_request_bytes: 4096, control_reply_bytes: 32768,
      source_bytes: HIGHLIGHT_LIMITS.sourceBytes, line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: 256 << 20,
      leases: 4096, leases_per_route: 1024, runs: 1 << 20, idle_ms: 60000, age_ms: 300000,
      quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
    runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
  } };
}
