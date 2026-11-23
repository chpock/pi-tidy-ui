export type StyleCause = 'installed' | 'local' | 'refused' | 'retry' | 'route' | 'withdrawn' | 'other';
export interface StyleAttempt { provider: number; cause?: StyleCause; retryAt?: number }
export type StyleDecision = { kind: 'resolve' | 'refused' | 'provider' } | { kind: 'delayed'; at: number };

/** Request policy for missing expressions or an unchanged, previously failed demand. */
export function nextStyle(attempt: Readonly<StyleAttempt> | undefined, ready: boolean, provider: number, now: number): StyleDecision {
  if (attempt?.cause === 'refused' || attempt?.cause === 'local') return { kind: 'refused' };
  if (attempt?.cause === 'other' && (!ready || attempt.provider === provider)) return { kind: 'refused' };
  if (!ready) return { kind: 'provider' };
  if (attempt?.cause === 'route' && attempt.provider === provider) return { kind: 'refused' };
  if (attempt?.retryAt !== undefined && now < attempt.retryAt) return { kind: 'delayed', at: attempt.retryAt };
  return { kind: 'resolve' };
}

export function styleFaultCause(code: string, execution: 'not_started' | 'started'): StyleCause {
  switch (code) {
    case 'worker_gone': return 'route';
    case 'busy': case 'queue_expired': return execution === 'not_started' ? 'retry' : 'other';
    case 'data_limit': return execution === 'started' ? 'retry' : 'refused';
    case 'frame_limit': case 'protocol_mismatch': case 'invalid_request': case 'vocabulary_changed':
    case 'invalid_rules': case 'invalid_context': case 'unknown_scope': case 'context_limit': case 'style_limit': case 'reply_limit':
      return 'refused';
    default: return 'other';
  }
}
