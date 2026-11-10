import type { DataBudget, DataCharge } from '../../resources/data-budget.ts';
import type { AccountedSnapshot } from './semantic-capture.ts';
import type { ConcreteStyle } from '../../appearance/style-materialization.ts';

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

/** Charged, root-branded source snapshot pin; it never retains the root itself. */
export class PiPreparation {
  readonly generation: number;
  readonly version: number;
  readonly palette: number;
  readonly budget: DataBudget;
  readonly #owner: object;
  #snapshot?: AccountedSnapshot;
  #charge?: DataCharge;

  constructor(owner: object, generation: number, palette: number, source: AccountedSnapshot, charge: DataCharge) {
    this.#owner = owner; this.generation = generation; this.version = source.version; this.palette = palette;
    this.budget = charge.budget; this.#snapshot = source; this.#charge = charge; Object.freeze(this);
  }
  get text(): string | undefined { return this.#snapshot?.text; }
  get sourceBytes(): number | undefined { return this.#snapshot?.utf8Bytes; }
  release(): void { this.#snapshot?.release(); this.#snapshot = undefined; this.#charge?.release(); this.#charge = undefined; }
  static read(value: PiPreparation, owner: object): AccountedSnapshot | undefined {
    return value instanceof PiPreparation && #owner in value && value.#owner === owner ? value.#snapshot : undefined;
  }
}

/** Owns one retained projection and the pool-funded bridge charge. A synchronous
 * visit pins that charge until callback unwind even if the entry is retired. */
export class PiProjectionHolder {
  #payload?: PiProjectionPayload;
  #charge?: DataCharge;
  readonly version: number;
  readonly revision: number;
  readonly bytes: number;
  readonly sourceBytes: number;
  readonly rangeCount: number;
  readonly styleCount: number;

  constructor(version: number, revision: number, payload: PiProjectionPayload, charge: DataCharge, bytes: number) {
    this.#payload = payload; this.#charge = charge;
    this.version = version; this.revision = revision; this.bytes = bytes;
    this.sourceBytes = payload.sourceBytes; this.rangeCount = payload.rangeCount; this.styleCount = payload.styleCount;
    Object.freeze(this);
  }
  keepForSnapshots(basisVersion: number, latestVersion?: number): this | undefined {
    if (this.version === basisVersion || this.version === latestVersion) return this;
    this.dispose();
    return undefined;
  }
  visitRanges(consume: (start: number, end: number, style: number) => void): boolean {
    return this.#visit(payload => payload.visitRanges(consume));
  }
  visitStyles(consume: (index: number, style: ConcreteStyle) => void): boolean {
    return this.#visit(payload => payload.visitStyles(consume));
  }
  dispose(): void {
    const payload = this.#payload, charge = this.#charge;
    this.#payload = undefined; this.#charge = undefined;
    payload?.dispose(); charge?.release();
  }
  #visit(visit: (payload: PiProjectionPayload) => boolean): boolean {
    const payload = this.#payload, charge = this.#charge;
    if (!payload || !charge) return false;
    charge.retain();
    try { return visit(payload); } finally { charge.release(); }
  }
}
