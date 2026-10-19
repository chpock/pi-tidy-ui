import type { DataBudget } from './data-budget.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';

/** Exclusive immutable data, not parser or classification authority. */
export interface PiProjectionPayload {
  readonly budget: DataBudget;
  readonly accountedBytes: number;
  readonly sourceBytes: number;
  readonly styleCount: number;
  readonly rangeCount: number;
  readonly isValid: boolean;
  visitRanges(consume: (start: number, end: number, style: number) => void): boolean;
  visitStyles(consume: (index: number, style: ConcreteStyle) => void): boolean;
  dispose(): void;
}
export interface StagedPiProjection {
  readonly budget: DataBudget;
  readonly accountedBytes: number;
  readonly sourceBytes: number;
  readonly styleCount: number;
  readonly rangeCount: number;
  consume(): PiProjectionPayload | undefined;
  dispose(): void;
}
