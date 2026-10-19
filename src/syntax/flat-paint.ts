import { DataBudget, type DataCharge, type DataGrantFactory, type DataCleanupReceipt } from '../occipital/data-budget.ts';
import { SpanKind, type MeasuredText, type MeasuredRowLayout } from './measured-rows.ts';
import type { AnsiStyle } from './style-ansi.ts';

/** Caller-authorized ordered, disjoint byte ranges with already-compiled styles.
 * Gaps are neutral. False invalidates the complete candidate, never permission. */
export type FlatRangeReader = (consume: (start: number, end: number, style: AnsiStyle) => void) => boolean;
/** Exact normalized UTF16 slices in the measurement's coordinates. A transient
 * fragment reader avoids retaining another joined display/source snapshot. */
export type FlatText = string | ((start: number, end: number) => string);
const denied = Symbol('paint allocation denied'), invalid = Symbol('paint invalidated');
// Added 128-byte allowances fund each detached handle token/receipt and the
// shared numeric holder ledger, separately from row strings and pointer arrays.
const handleBytes = 256, storeBytes = 256, operationBytes = 512, pieceBytes = 128, stringBytes = 32, arrayBytes = 64, rowChargeBytes = 32;
type RowCharge = { charge: DataCharge; next?: RowCharge };
type StoreOwnership = { header: DataCharge; charges?: RowCharge; holders: number; bytes: number; units: number };
type Store = { rows: string[] | undefined; ownership: StoreOwnership };
type PaintOwnership = { header?: DataCharge; store?: StoreOwnership };
type Piece = { text: string; style: AnsiStyle; charge: DataCharge; next?: Piece };
function fund(budget: DataBudget, bytes: number, funding?: DataGrantFactory): DataCharge {
  const grant = funding ? funding(bytes) : budget.reserve(bytes);
  if (!grant) throw denied;
  try {
    if (grant.budget !== budget) throw new Error('foreign paint data grant');
    return grant.consume(bytes);
  } finally { grant.close(); }
}
function releaseShared(ownership: StoreOwnership): void {
  if (--ownership.holders) return;
  let row = ownership.charges; ownership.charges = undefined;
  while (row) { const next = row.next; row.next = undefined; row.charge.release(); row = next; }
  ownership.header.release();
}
function release(store: Store): void {
  if (store.ownership.holders === 1) store.rows = undefined;
  releaseShared(store.ownership);
}
function releasePaint(ownership: PaintOwnership): void {
  const { header, store } = ownership;
  ownership.header = ownership.store = undefined;
  if (store) releaseShared(store); header?.release();
}
// This scope never receives the string store or the constructor's arguments.
function paintReceipt(owner: WeakRef<PaintedRows>, ownership: PaintOwnership): DataCleanupReceipt {
  return { release() { const handle = owner.deref(); if (handle) handle.dispose(); else releasePaint(ownership); } };
}

function releasePieces(piece: Piece | undefined): void {
  while (piece) { const next = piece.next; piece.next = undefined; piece.charge.release(); piece = next; }
}

/** Detached funded ANSI rows. Adopt this handle, or retain another funded handle;
 * visitRows strings are synchronous borrows, not an uncharged ownership transfer.
 * Neither handle nor store keeps source text, geometry, styles, or input reader. */
class PaintedRows {
  #store?: Store;
  #header?: DataCharge;
  #ownership: PaintOwnership;
  #receipt: DataCleanupReceipt;
  readonly rowCount: number;
  readonly stringUnits: number;
  readonly allocationBytes: number;
  constructor(store: Store, header: DataCharge) {
    this.#store = store; this.#header = header;
    this.#ownership = { header, store: store.ownership };
    this.#receipt = paintReceipt(new WeakRef(this), this.#ownership);
    this.rowCount = store.rows!.length; this.stringUnits = store.ownership.units;
    this.allocationBytes = store.ownership.bytes + header.bytes;
  }
  cleanupReceipt(): DataCleanupReceipt { return this.#receipt; }
  get isValid(): boolean { return this.#store !== undefined; }
  retain(funding?: DataGrantFactory): PaintedRows | undefined {
    const store = this.#store, owner = this.#header;
    if (!store || !owner) return undefined;
    store.ownership.holders++; owner.retain();
    let header: DataCharge | undefined;
    try {
      header = fund(owner.budget, handleBytes, funding);
      if (this.#store !== store) return undefined;
      const result = new PaintedRows(store, header); store.ownership.holders++; header = undefined; return result;
    } catch (error) { if (error === denied) return undefined; throw error; }
    finally { header?.release(); release(store); owner.release(); }
  }
  visitRows(consume: (index: number, row: string) => void): boolean {
    const store = this.#store, header = this.#header;
    if (!store || !header) return false;
    store.ownership.holders++; header.retain();
    try {
      const rows = store.rows!;
      for (let i = 0; i < rows.length; i++) {
        if (this.#store !== store) return false;
        consume(i, rows[i]!);
      }
      return this.#store === store;
    } finally { release(store); header.release(); }
  }
  dispose(): void {
    const store = this.#store;
    this.#store = this.#header = undefined;
    if (store?.ownership.holders === 1) store.rows = undefined;
    releasePaint(this.#ownership);
  }
}
export type FlatPaintRows = PaintedRows;

/** One common painter. Matching proof, source authorization, style compilation,
 * descriptor selection and normalization belong to the caller. Eligibility uses
 * the original glyph start, not its end: a matching first scalar owns the whole
 * current grapheme even when the historical prefix ends within it. */
export function paintFlat(text: FlatText, measured: MeasuredText, layout: MeasuredRowLayout, ranges: FlatRangeReader,
  neutral: AnsiStyle, prompt: AnsiStyle, eligibleBytes: number, budget: DataBudget, funding?: DataGrantFactory): FlatPaintRows | undefined {
  if (!Number.isSafeInteger(eligibleBytes) || eligibleBytes < 0) throw new Error('invalid paint eligibility');
  let operation: DataCharge | undefined, storeHeader: DataCharge | undefined, store: Store | undefined;
  let first: Piece | undefined, last: Piece | undefined, pieceCount = 0, rowUnits = 0;
  try {
    operation = fund(budget, operationBytes, funding);
    const clearPieces = () => {
      const piece = first; first = last = undefined; pieceCount = rowUnits = 0; releasePieces(piece);
    };
    const available = layout.withLookup(measured, read => {
      storeHeader = fund(budget, storeBytes + arrayBytes + layout.rowCount * 8, funding);
      if (!read.isValid) throw invalid;
      store = { rows: new Array<string>(layout.rowCount), ownership: { header: storeHeader, holders: 1, bytes: storeHeader.bytes, units: 0 } };
      storeHeader = undefined;
      let row = 0, span = 0, rowEnd = layout.rowCount ? read.rowEnd(0) : 0;
      let loaded = false, kind = 0, glyph = 0, endGlyph = 0, cells = 0, offset = 0;
      let pending: AnsiStyle | undefined, rawStart = 0, rawEnd = 0;
      const check = () => { if (!read.isValid) throw invalid; };
      const add = (style: AnsiStyle, size: number, sourceStart?: number, sourceEnd?: number, literal?: string) => {
        const charge = fund(budget, pieceBytes + stringBytes + size * 2, funding);
        try {
          check();
          const raw = sourceStart !== undefined ? typeof text === 'string' ? text.slice(sourceStart, sourceEnd) : text(sourceStart, sourceStart + size)
            : literal !== undefined ? literal + ' '.repeat(size - literal.length) : ' '.repeat(size);
          const piece: Piece = { text: raw, style, charge };
          if (last) last.next = piece; else first = piece;
          last = piece; pieceCount++; rowUnits += style.open.length + size + style.close.length;
        } catch (error) { charge.release(); throw error; }
      };
      const flushRaw = () => {
        if (pending) { add(pending, rawEnd - rawStart, rawStart, rawEnd); pending = undefined; }
      };
      const finishRow = () => {
        flushRaw(); check();
        let workspace: DataCharge | undefined, rowCharge: DataCharge | undefined, parts: string[] | undefined;
        try {
          workspace = fund(budget, arrayBytes + pieceCount * 3 * 8, funding);
          rowCharge = fund(budget, rowChargeBytes + stringBytes + rowUnits * 2, funding);
          parts = new Array<string>(pieceCount * 3);
          let index = 0;
          for (let piece = first; piece; piece = piece.next) {
            parts[index++] = piece.style.open; parts[index++] = piece.text; parts[index++] = piece.style.close;
          }
          const owned = { charge: rowCharge, next: store!.ownership.charges };
          store!.rows![row] = parts.join('');
          store!.ownership.charges = owned;
          store!.ownership.bytes += rowCharge.bytes; store!.ownership.units += rowUnits; rowCharge = undefined; check();
        } finally { parts = undefined; workspace?.release(); rowCharge?.release(); clearPieces(); }
      };
      const setSpan = (k: number, firstGlyph: number, end: number, count: number, promptOffset: number) => {
        kind = k; glyph = firstGlyph; endGlyph = end; cells = count; offset = promptOffset;
      };
      const ready = (): boolean => {
        while (row < layout.rowCount) {
          check();
          if (span === rowEnd) {
            finishRow(); row++; loaded = false;
            if (row < layout.rowCount) rowEnd = read.rowEnd(row);
            continue;
          }
          if (!loaded) { read.span(span, setSpan); loaded = true; }
          if (kind === SpanKind.Prompt) {
            flushRaw(); add(prompt, cells, undefined, undefined, offset === 0 ? cells === 2 ? '$ ' : '$' : ' '); span++; loaded = false; continue;
          }
          if (kind === SpanKind.Source && glyph === endGlyph) { span++; loaded = false; continue; }
          return true;
        }
        return false;
      };
      const until = (limit: number, style: AnsiStyle) => {
        while (ready()) {
          const byte = read.glyphByte(glyph);
          if (byte >= limit) break;
          const selected = byte < eligibleBytes ? style : neutral;
          if (kind === SpanKind.Source) {
            const start = read.glyphStart(glyph), end = read.glyphEnd(glyph);
            if (pending !== selected || rawEnd !== start) { flushRaw(); pending = selected; rawStart = start; }
            rawEnd = end; glyph++;
          } else {
            flushRaw();
            if (kind === SpanKind.Tab) add(selected, cells);
            else add(selected, cells, undefined, undefined, '�');
            span++; loaded = false;
          }
        }
      };
      const valid = ranges((start, end, style) => { check(); until(start, neutral); until(end, style); });
      if (!valid) throw invalid;
      until(Infinity, neutral); check();
    }, funding);
    if (!available || !store) return undefined;
    const header = fund(budget, handleBytes, funding);
    try {
      if (!layout.isValid || !measured.isValid) { header.release(); return undefined; }
      const result = new PaintedRows(store, header); store = undefined; return result;
    } catch (error) { header.release(); throw error; }
  } catch (error) {
    if (error === denied || error === invalid) return undefined;
    throw error;
  } finally { releasePieces(first); if (store) release(store); storeHeader?.release(); operation?.release(); }
}
