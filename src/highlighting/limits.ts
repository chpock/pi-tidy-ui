import { OCCIPITAL_LIMITS } from '../occipital/limits.ts';

// Extension workload policy; keep the Rust defaults and shared fixture in sync.
export const HIGHLIGHT_LIMITS = Object.freeze({
  sourceBytes: 64 * 1024,
  sourceLines: 8192,
  piSourceBytes: 8 * 1024,
  dataWireBytes: OCCIPITAL_LIMITS.dataWireBytes,
  contextWords: 65536,
  decodedBytes: 2 * 1024 * 1024,
});
