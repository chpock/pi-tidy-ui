import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { CardRole } from '../appearance/card-roles.ts';
import type { AnsiStyle } from '../appearance/style-ansi.ts';
import type { MeasuredText } from './measured-rows.ts';

export interface BashService {
  readonly description: string; readonly heading: string; readonly output: readonly string[];
  readonly first: number; readonly last: number; readonly reminder: number; readonly end: number;
  readonly footer: string; readonly error: boolean;
}
export type BashServiceInput = Omit<BashService, 'description' | 'heading'> & { readonly description?: string };

/** Caller-authorized ordered, disjoint byte ranges with already-compiled styles.
 * Gaps are neutral. False invalidates the complete candidate, never permission. */
export type FlatRangeReader = (consume: (start: number, end: number, style: AnsiStyle) => void) => boolean;

export interface PreparedRegion { readonly text: string; readonly measured: MeasuredText }
export interface PreparedBashRegions {
  readonly description?: PreparedRegion; readonly heading?: PreparedRegion;
  /** Original service.output indices. Collapsed sections prepare only their first
   * eleven logical rows; empty/trimmed/footer-only rows need no measurement. */
  readonly output: readonly (PreparedRegion | undefined)[];
  readonly footer?: PreparedRegion;
}
export interface FileRowDescriptor {
  readonly kind: ' ' | '+' | '-' | 'gap'; readonly index: number;
  readonly old?: number; readonly next?: number; readonly hunk?: number;
  readonly region?: PreparedRegion;
  /** Full continuous source coordinates, not concatenated selected-context coordinates. */
  readonly oldSource?: { readonly key: string; readonly utf16: number; readonly byte: number };
  readonly nextSource?: { readonly key: string; readonly utf16: number; readonly byte: number };
}
export type PreparedCard = { readonly kind: 'bash'; readonly revision: number; readonly geometryStamp: number;
  readonly command: PreparedRegion; readonly service: BashService;
  readonly regions: PreparedBashRegions } |
  { readonly kind: 'file'; readonly revision: number; readonly geometryStamp: number; readonly path?: string;
    readonly label?: string; readonly mode?: string; readonly preview?: boolean; readonly omitted?: boolean; readonly note?: PreparedRegion; readonly heading?: PreparedRegion;
    readonly error: boolean; readonly diagnostics: readonly PreparedRegion[];
    readonly rows: readonly FileRowDescriptor[] };
export interface ReadyCardPaint {
  readonly publication: number; readonly paintStamp: number; readonly mode: TerminalColorMode;
  readonly origin: 'owned' | 'pi'; readonly roles: Readonly<Record<CardRole, AnsiStyle>>;
  /** Matching scalar-prefix bytes for the current Bash display, established during preparation. */
  readonly bashPrefixBytes?: number;
  /** Accessors are valid only within the outer synchronous visit. No compilation occurs here. */
  ranges(key: string, surface?: 'added' | 'removed' | 'context'): FlatRangeReader | undefined;
  /** Historical text is borrowed under canonical ownership, never source authority. */
  basis(key: string, consume: (text: string, ranges: FlatRangeReader) => void): boolean;
}
