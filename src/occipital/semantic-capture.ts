import type { ContextRef } from './context-arena.ts';
import type { DataCharge, DataGrant } from './data-budget.ts';
import type { SemanticRangeView } from './semantic-ranges.ts';

export class AccountedSnapshot {
  readonly version: number; readonly text: string; readonly utf8Bytes: number;
  readonly textCharge: DataCharge; readonly record: DataCharge;
  #holders = 1;
  constructor(version: number, text: string, utf8Bytes: number, grant: DataGrant, previous?: AccountedSnapshot) {
    this.version = version; this.text = previous?.text === text ? previous.text : text; this.utf8Bytes = utf8Bytes;
    this.record = grant.consume(32);
    this.textCharge = previous?.text === text ? previous.textCharge.retain() : grant.consume(2 * text.length);
    try { Object.freeze(this); } catch (error) { this.record.release(); this.textCharge.release(); throw error; }
  }
  retain(): this { if (!this.#holders) throw new Error('released snapshot'); this.#holders++; return this; }
  release(): void { if (this.#holders && !--this.#holders) { this.record.release(); this.textCharge.release(); } }
}
export type CaptureSnapshot = AccountedSnapshot;
export type CaptureData = { owner: object; members: readonly number[]; group: object; snapshot: CaptureSnapshot;
  view: SemanticRangeView; contexts: readonly ContextRef[]; charge: DataCharge };
export type CaptureIdentity = Readonly<{ key: string; generation: number; semanticStamp: number; sourceVersion: number;
  vocabulary: string; sourceBytes: number; complete: boolean }>;

/** Physical style-job data only, never a renderer handle or source-work proof.
 * Internal factories/readers below require the root's unexported owner token. */
export class SemanticCapture {
  readonly key: string;
  readonly generation: number;
  readonly semanticStamp: number;
  readonly sourceVersion: number;
  readonly vocabulary: string;
  readonly sourceBytes: number;
  readonly complete: boolean;
  #data: CaptureData | undefined;
  #released: (() => void) | undefined;
  constructor(identity: CaptureIdentity, data: CaptureData, released: () => void) {
    this.key = identity.key; this.generation = identity.generation; this.semanticStamp = identity.semanticStamp;
    this.sourceVersion = identity.sourceVersion; this.vocabulary = identity.vocabulary;
    this.sourceBytes = identity.sourceBytes; this.complete = identity.complete;
    this.#data = data; this.#released = released; Object.freeze(this);
  }
  visitContexts(consume: (ref: ContextRef) => void): boolean {
    for (let i = 0; ; i++) {
      if (!this.#data) return false;
      const ref = this.#contextAt(i);
      if (!ref) return true;
      consume(ref);
    }
  }
  #contextAt(index: number): ContextRef | undefined { return this.#data?.contexts[index]; }
  release(): void {
    const data = this.#data, released = this.#released;
    this.#data = undefined; this.#released = undefined;
    if (!data) return;
    data.view.release(); data.snapshot.release(); data.charge.release(); released?.();
  }
  static read(value: unknown, owner: object): CaptureData | undefined {
    if (!(value instanceof SemanticCapture) || !(#data in value)) return undefined;
    return value.#data?.owner === owner ? value.#data : undefined;
  }
}

/** The caller holds reservationBytes until actual job settlement. release() only
 * releases storage: it neither owns nor returns scheduler credits. */
export class SemanticCaptureGroup {
  readonly captures: readonly SemanticCapture[];
  readonly reservationBytes: number;
  #charge: DataCharge | undefined;
  constructor(captures: SemanticCapture[], reservationBytes: number, charge: DataCharge) {
    this.#charge = charge;
    this.captures = Object.freeze(captures); this.reservationBytes = reservationBytes; Object.freeze(this);
  }
  release(): void { this.#charge?.release(); this.#charge = undefined; for (const capture of this.captures) capture.release(); }
}
