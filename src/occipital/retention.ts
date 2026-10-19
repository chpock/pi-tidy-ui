import { OCCIPITAL_LIMITS } from './limits.ts';

// Shared source-owner bookkeeping, not an additional data quota.
export const RETENTION_LIMITS = Object.freeze({ entryAllowance: 1024, maxSourceUnits: OCCIPITAL_LIMITS.sourceBytes });
