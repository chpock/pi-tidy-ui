import { childEnv } from '../../scripts/test/context.mjs';

export function sharedHostEnv(root) {
  return childEnv(root, { SUBC_CGROUP_PLACEMENT: 'disabled', TOKIO_WORKER_THREADS: '2' });
}
