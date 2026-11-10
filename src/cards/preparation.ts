import type { PreparedRegion } from '../rendering/card-values.ts';

/** Synchronous operation capabilities. The caller records new receipts and append
 * transactions before returning, and alone commits or rolls back their lifetime. */
export interface CardMeasurements {
  region(text: string, wrap?: 'fragments'): PreparedRegion;
  append(previous: PreparedRegion, text: string): PreparedRegion;
}

export const cardSourceKey = (ticket: number, ordinal: number) => `card:${ticket}:${ordinal}`;
