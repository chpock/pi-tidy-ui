const authority = {};

/** Logical policy bytes, not V8 heap/RSS. This authority contains numbers only;
 * storage owners hold charges and the root alone chooses eviction victims. */
export class DataBudget {
  readonly limit: number;
  #retained = 0;
  #outstanding = 0;
  #closed = false;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid data limit');
    this.limit = limit; Object.freeze(this);
  }
  reserve(bytes: number): DataGrant | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid data peak');
    if (this.#closed || this.#retained + this.#outstanding + bytes > this.limit) return undefined;
    this.#outstanding += bytes; return new DataGrant(this, bytes, authority);
  }
  stats() { return { retainedBytes: this.#retained, outstandingPeakBytes: this.#outstanding, limit: this.limit, closed: this.#closed }; }
  close(): void { this.#closed = true; }
  /** Grant-only reconciliation; no owner references enter this authority. */
  commit(bytes: number, token: object): DataCharge { check(token); this.#outstanding -= bytes; this.#retained += bytes; return new DataCharge(this, bytes, authority); }
  refund(bytes: number, token: object): void { check(token); this.#outstanding -= bytes; }
  free(bytes: number, token: object): void { check(token); this.#retained -= bytes; }
}
export class DataGrant {
  readonly budget: DataBudget;
  #remaining: number;
  constructor(budget: DataBudget, bytes: number, token: object) { check(token); this.budget = budget; this.#remaining = bytes; Object.freeze(this); }
  consume(bytes: number): DataCharge {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining) throw new Error('unfunded data allocation');
    this.#remaining -= bytes; return this.budget.commit(bytes, authority);
  }
  close(): void { const remaining = this.#remaining; this.#remaining = 0; this.budget.refund(remaining, authority); }
}
export class DataCharge {
  readonly bytes: number;
  readonly budget: DataBudget;
  #owners = 1;
  constructor(budget: DataBudget, bytes: number, token: object) { check(token); this.budget = budget; this.bytes = bytes; Object.freeze(this); }
  retain(): this { if (!this.#owners) throw new Error('released data charge'); this.#owners++; return this; }
  release(): void { if (this.#owners && !--this.#owners) this.budget.free(this.bytes, authority); }
}
function check(token: object): void { if (token !== authority) throw new Error('foreign data authority'); }

/** Existing boolean reserve hooks choose pressure victims; the actual allocation
 * subsequently consumes a grant, never a reusable checked-once boolean. */
export function dataGrant(budget: DataBudget, peak: number, reserve: (bytes: number) => boolean, prepaid?: DataGrant): DataGrant | undefined {
  if (prepaid) { if (prepaid.budget !== budget) throw new Error('foreign data grant'); return prepaid; }
  return reserve(peak) ? budget.reserve(peak) : undefined;
}

/** Operation-only admission; owners must never retain the callback. */
export type DataGrantFactory = (bytes: number) => DataGrant | undefined;
/** Detached, idempotent ownership release; contains no data payload. */
export interface DataCleanupReceipt { release(): void }
