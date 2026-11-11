import type { CardDisplayInput } from '../cards/display-input.ts';
import type { PreparedCard, ReadyCardPaint } from '../rendering/card-values.ts';

/** Per-card consumer of the existing preparation owner, not SOURCE execution. */
export interface CardPreparationPort<Owner extends object> {
  /** Cold lifecycle boundary; never construct a display during render or hit-testing. */
  updateDisplay: (owner: Owner, input: CardDisplayInput) => boolean;
  useful: (owner: Owner, revision: number) => void;
  pause: (owner: Owner) => void;
  freeze: (owner: Owner) => void;
  discardFile: (owner: Owner) => void;
  remove: (owner: Owner) => void;
  /** Provisional synchronous borrow: publish constructed output only on true. */
  visit: (owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void) => boolean;
  identities: (owner: Owner) => readonly { key: string; version: number }[];
  filePreparationOutcome: (owner: Owner) => 'supported' | 'unsupported' | undefined;
}
