import { HIGHLIGHT_LIMITS } from '../../src/occipital/limits.ts';
import type { ProfileDescription } from '../../src/occipital/protocol.ts';

/** Bounded v3 control fixture; callers deliberately mutate the fresh body for negative tests. */
export function semanticDescriptor(ticket: unknown, instance = 'instance', profiles: ProfileDescription[] = [
  { id: 'native', label: 'Native theme', fingerprint: 'a'.repeat(64) },
]) {
  return { v: 3, ticket, instance, assets: 'assets', status: 'ok', body: {
    kind: 'descriptor', protocol_version: 3, contexts_revision: 1, resolver_revision: 2, palette_revision: 1,
    vocabulary: { fingerprint: 'a'.repeat(64), count: 20 }, assets: 'assets', backend_version: '0.1.5', catalogue_revision: 0,
    capability: 'syntax-highlight/v3', service: 'syntax',
    operations: ['describe', 'themes.refresh', 'highlight', 'stream.open', 'stream.append', 'stream.close', 'styles.resolve'],
    modes: ['one_shot', 'growing'], admission: ['try_now', 'bounded_queue'], profiles: profiles.map(profile => ({ ...profile })), diagnostic: null as string | null,
    limits: { request_bytes: HIGHLIGHT_LIMITS.dataWireBytes, reply_bytes: HIGHLIGHT_LIMITS.dataWireBytes, control_request_bytes: 4096, control_reply_bytes: 32768,
      source_bytes: HIGHLIGHT_LIMITS.sourceBytes, line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: 256 << 20,
      leases: 4096, leases_per_route: 1024, runs: 1 << 20, idle_ms: 60000, age_ms: 300000,
      quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
    runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
  } };
}
