import type { CardGeometry } from '../card-frame.ts';
import type { CardRole } from '../appearance/card-roles.ts';
import type { DataCleanupReceipt } from '../resources/data-budget.ts';
import type { PreparedCard } from './card-values.ts';
import type { MeasuredRowLayout, MeasuredText } from './measured-rows.ts';

export type RegionKind = 'command' | 'description' | 'heading' | 'output' | 'footer' | 'note' | 'diagnostic' | 'file';
export type Entry = { kind: RegionKind; index: number; role: CardRole; side?: 'old' | 'next'; measured: WeakRef<MeasuredText>; layout: MeasuredRowLayout; cells: number[]; blank: boolean[] };
export type Cell = { entry: number; row: number; width: number; gutter: number; line: number; side: 'old' | 'next' };
export type SceneRow = { left: Cell; right?: Cell };
export type Scene = { kind: PreparedCard['kind']; stamp: number; geometry: CardGeometry; framed: boolean; inset: number;
  expandable: boolean; digits: number; entries: Entry[]; rows: SceneRow[]; children: DataCleanupReceipt[] };

export interface SceneComposition {
  readonly geometry: Readonly<CardGeometry>;
  readonly framed: boolean;
  digits: number;
  expandable: boolean;
  readonly rows: readonly { readonly left: Readonly<Cell>; readonly right?: Readonly<Cell> }[];
  readonly entries: readonly { readonly layout: { readonly rowCount: number }; readonly blank: readonly boolean[] }[];
}

/** Synchronous construction only. The caller owns the scene, grants and rollback;
 * composition policies receive no cleanup or measurement-owner capabilities. */
export interface SceneConstruction {
  readonly scene: SceneComposition;
  readonly available: number;
  empty(width?: number, entry?: number): Cell;
  append(left: Cell, right?: Cell): void;
  removeLastRow(): void;
  insertEmptyRow(index: number): void;
  entry(kind: RegionKind, index: number, role: CardRole, width: number, mode: 'file' | 'bash', prompt?: boolean, maxRows?: number, side?: 'old' | 'next'): number;
  lines(kind: RegionKind, index: number, role: CardRole, mode?: 'file' | 'bash', prompt?: boolean): void;
}
