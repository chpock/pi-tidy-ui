import { visibleWidth } from '@earendil-works/pi-tui';
import { DataBudget, type DataCharge, type DataGrantFactory, type DataCleanupReceipt } from '../occipital/data-budget.ts';

export const GlyphFlag = Object.freeze({ Whitespace: 1, Tab: 2, Newline: 4 } as const);
export const SpanKind = Object.freeze({ Source: 0, Tab: 1, Replacement: 2, Prompt: 3 } as const);
export type GeometrySpanKind = typeof SpanKind[keyof typeof SpanKind];
export type GeometryPolicy = Readonly<{
  mode: 'file' | 'bash'; width: number;
  /** Output/service rows share Bash wrapping but have no synthetic command prefix. */
  prompt?: boolean;
  /** Optional visual-row prefix, including any overflow-proof row. Stops the
   * existing kernel at that row boundary without changing source coordinates;
   * omitted means complete reflow. Zero admits no rows. */
  maxRows?: number;
}>;
export type GlyphVisitor = (index: number, utf16Start: number, utf16End: number, utf8Start: number, utf8End: number, width: number, flags: number) => void;
export type SpanVisitor = (kind: GeometrySpanKind, firstGlyph: number, endGlyph: number, cells: number, promptOffset: number) => void;
/** Synchronous numeric lookup only; invalidated and cleared after withLookup. */
export interface GeometryRead {
  readonly isValid: boolean;
  rowEnd(row: number): number;
  rowColumns(row: number): number;
  span(index: number, visit: SpanVisitor): void;
  glyphStart(index: number): number;
  glyphEnd(index: number): number;
  glyphByte(index: number): number;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const denied = Symbol('geometry allocation denied');
// Header charges are logical policy bytes, as in the existing DataBudget owners;
// bufferBytes below reports exact ArrayBuffer bytes separately from these headers.
// Each retained header includes 128 policy bytes for its detached token/receipt.
const measuredHeader = 256, layoutHeader = 256, builderHeader = 64, blockHeader = 64, vectorHeader = 32;
const widthMemoHeader = 128, widthEntryHeader = 128;
// Conservative per-UTF16 policy units cover transient character strings, pointer
// arrays/copies and fixed call/iterator records in public Pi width measurement;
// not an RSS estimate. Pi's shared cache keys are host-owned and excluded.
const widthScratchHeader = 256, widthScratchUnit = 64;
type WidthEntry = { width: number; charge: DataCharge; next?: WidthEntry };
type Packed = { words: Uint32Array; charge: DataCharge };
type Block = { words: Uint32Array; used: number; charge: DataCharge; next?: Block };
function fund(budget: DataBudget, bytes: number, funding?: DataGrantFactory): DataCharge {
  const grant = funding ? funding(bytes) : budget.reserve(bytes);
  if (!grant) throw denied;
  try {
    if (grant.budget !== budget) throw new Error('foreign geometry data grant');
    return grant.consume(bytes);
  } finally { grant.close(); }
}
function vector(budget: DataBudget, words: number, funding?: DataGrantFactory): Packed {
  const charge = fund(budget, vectorHeader + words * 4, funding);
  try { return { words: new Uint32Array(words), charge }; }
  catch (error) { charge.release(); throw error; }
}

/** Append-only blocks avoid repeated prefix copying during reflow. Final exact
 * compaction is funded in addition to every live block and any old layout. */
class Words {
  #budget: DataBudget;
  #header: DataCharge;
  #funding?: DataGrantFactory;
  #first?: Block;
  #last?: Block;
  #capacity = 16;
  length = 0;
  constructor(budget: DataBudget, header: DataCharge, funding?: DataGrantFactory) { this.#budget = budget; this.#header = header; this.#funding = funding; }
  push(value: number): void {
    let block = this.#last;
    if (!block || block.used === block.words.length) {
      const charge = fund(this.#budget, blockHeader + this.#capacity * 4, this.#funding);
      try { block = { words: new Uint32Array(this.#capacity), used: 0, charge }; }
      catch (error) { charge.release(); throw error; }
      if (this.#last) this.#last.next = block; else this.#first = block;
      this.#last = block; this.#capacity = Math.min(4096, this.#capacity * 2);
    }
    block.words[block.used++] = value; this.length++;
  }
  finish(): Packed {
    const packed = vector(this.#budget, this.length, this.#funding);
    try {
      let offset = 0;
      for (let block = this.#first; block; block = block.next) {
        // No subarray wrappers or uncharged temporary copy vectors.
        for (let i = 0; i < block.used; i++) packed.words[offset++] = block.words[i]!;
      }
      return packed;
    } catch (error) { packed.charge.release(); throw error; }
  }
  dispose(): void {
    let block = this.#first;
    this.#first = this.#last = undefined; this.#funding = undefined;
    while (block) { const next = block.next; block.next = undefined; block.charge.release(); block = next; }
    this.#header.release();
  }
}
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3; // Display-only replacement scalar; classifier admission remains strict.
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
    else bytes += 3;
  }
  return bytes;
}

// Detached tokens own charges, never vectors; the receipt factory's scope has
// only a weak handle and those tokens, not a constructor's payload arguments.
type GeometryOwnership = { header?: DataCharge; first?: DataCharge; second?: DataCharge };
function releaseGeometry(ownership: GeometryOwnership): void {
  const { header, first, second } = ownership;
  ownership.header = ownership.first = ownership.second = undefined;
  first?.release(); second?.release(); header?.release();
}
function geometryReceipt(owner: WeakRef<{ dispose(): void }>, ownership: GeometryOwnership): DataCleanupReceipt {
  return { release() { const handle = owner.deref(); if (handle) handle.dispose(); else releaseGeometry(ownership); } };
}

/** Numeric original-source endpoints only. Never retains text, semantic ranges,
 * theme, card, or a caller callback. Explicit disposal invalidates weak layouts. */
class Measurement {
  #data?: Packed;
  #header?: DataCharge;
  #budget: DataBudget;
  #ownership: GeometryOwnership;
  #receipt: DataCleanupReceipt;
  readonly glyphCount: number;
  readonly bufferBytes: number;
  readonly allocationBytes: number;
  private constructor(budget: DataBudget, data: Packed, header: DataCharge, glyphCount = data.words.length / 4) {
    this.#budget = budget; this.#data = data; this.#header = header;
    this.#ownership = { header, first: data.charge };
    this.#receipt = geometryReceipt(new WeakRef(this), this.#ownership);
    this.glyphCount = glyphCount; this.bufferBytes = data.words.byteLength;
    this.allocationBytes = header.bytes + data.charge.bytes;
  }
  static create(text: string, budget: DataBudget, funding?: DataGrantFactory): Measurement | undefined {
    let header: DataCharge | undefined, builder: Words | undefined, data: Packed | undefined;
    let memoHeader: DataCharge | undefined, memo: Map<string, WidthEntry> | undefined, entries: WidthEntry | undefined;
    try {
      header = fund(budget, measuredHeader, funding); builder = new Words(budget, fund(budget, builderHeader, funding), funding);
      memoHeader = fund(budget, widthMemoHeader, funding); memo = new Map();
      let bytes = 0;
      for (const { segment, index } of segmenter.segment(text)) {
        bytes += utf8Length(segment);
        if (bytes > 0xffffffff) throw new Error('geometry source exceeds numeric endpoints');
        const tab = segment === '\t', newline = segment === '\n';
        let width = 0;
        if (!tab && !newline) {
          let entry = memo.get(segment);
          if (!entry) {
            const charge = fund(budget, widthEntryHeader + 2 * segment.length, funding);
            entry = { width: 0, charge, next: entries }; entries = entry;
            const scratch = fund(budget, widthScratchHeader + widthScratchUnit * segment.length, funding);
            try { entry.width = visibleWidth(segment); } finally { scratch.release(); }
            memo.set(segment, entry);
          }
          width = entry.width;
        }
        if (!Number.isInteger(width) || width < 0 || width > 0xffffffff) throw new Error('invalid geometry glyph width');
        builder.push(index + segment.length); builder.push(bytes); builder.push(width);
        builder.push((/\s/u.test(segment) ? GlyphFlag.Whitespace : 0) | (tab ? GlyphFlag.Tab : 0) | (newline ? GlyphFlag.Newline : 0));
      }
      data = builder.finish();
      return new Measurement(budget, data, header);
    } catch (error) {
      data?.charge.release(); header?.release();
      if (error === denied) return undefined;
      throw error;
    } finally {
      // Only this measurement owns the memo. Drop all key holders before
      // returning their charges; no text or memo survives in Measurement.
      memo?.clear();
      while (entries) { const next = entries.next; entries.next = undefined; entries.charge.release(); entries = next; }
      memoHeader?.release(); builder?.dispose();
    }
  }
  /** Prepare only the possibly extended final grapheme and new suffix. No old
   * numeric storage is mutated before the caller accepts its display transaction.
   * Adoption transfers the old capacity; geometric growth amortizes prefix copies. */
  static prepareAppend(previous: Measurement, text: string, funding?: DataGrantFactory): MeasuredAppend | undefined {
    const old = previous.#data, owner = previous.#header;
    if (!old || !owner) return undefined;
    old.charge.retain(); owner.retain();
    let suffix: Measurement | undefined, target: Packed | undefined, header: DataCharge | undefined, scratch: DataCharge | undefined;
    try {
      let stable = Math.max(0, previous.glyphCount - 1);
      const oldEnd = previous.glyphCount ? old.words[(previous.glyphCount - 1) * 4]! : 0;
      const high = text.charCodeAt(oldEnd - 1), low = text.charCodeAt(oldEnd);
      // Completing an isolated high surrogate can join its new scalar to the
      // preceding grapheme (modifier, regional indicator or ZWJ continuation).
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) stable = Math.max(0, stable - 1);
      const start = stable ? old.words[(stable - 1) * 4]! : 0;
      const byte = stable ? old.words[(stable - 1) * 4 + 1]! : 0;
      scratch = fund(previous.#budget, 256 + (text.length - start) * 2, funding);
      suffix = Measurement.create(text.slice(start), previous.#budget, funding);
      if (!suffix || previous.#data !== old) return undefined;
      const count = stable + suffix.glyphCount, words = count * 4;
      if (words <= old.words.length) { old.charge.retain(); target = old; }
      else {
        target = vector(previous.#budget, Math.max(words, old.words.length * 2), funding);
        if (previous.#data !== old) return undefined;
        for (let i = 0; i < stable * 4; i++) target.words[i] = old.words[i]!;
      }
      header = fund(previous.#budget, measuredHeader, funding);
      if (previous.#data !== old) return undefined;
      const measured = new Measurement(previous.#budget, target, header, count), tail = suffix;
      // The numeric endpoints are checked before adoption, while failure can
      // still refund the whole candidate and preserve the previous measurement.
      if (tail.glyphCount && byte + tail.#data!.words[(tail.glyphCount - 1) * 4 + 1]! > 0xffffffff) {
        measured.dispose(); target = undefined; header = undefined;
        throw new Error('geometry source exceeds numeric endpoints');
      }
      target = undefined; header = undefined; suffix = undefined;
      const operation = scratch; scratch = undefined;
      let pending = true;
      return {
        measured,
        commit() {
          if (!pending || previous.#data !== old || !measured.#data || !tail.#data) return false;
          const output = measured.#data.words, input = tail.#data.words;
          for (let i = 0; i < tail.glyphCount; i++) {
            const at = (stable + i) * 4;
            output[at] = start + input[i * 4]!; output[at + 1] = byte + input[i * 4 + 1]!;
            output[at + 2] = input[i * 4 + 2]!; output[at + 3] = input[i * 4 + 3]!;
          }
          previous.dispose(); tail.dispose(); pending = false; operation.release(); return true;
        },
        dispose() { if (pending) { pending = false; tail.dispose(); measured.dispose(); operation.release(); } },
      };
    } catch (error) { if (error === denied) return undefined; throw error; }
    finally { scratch?.release(); suffix?.dispose(); target?.charge.release(); header?.release(); old.charge.release(); owner.release(); }
  }
  cleanupReceipt(): DataCleanupReceipt { return this.#receipt; }
  get isValid(): boolean { return this.#data !== undefined; }
  visitGlyphs(first: number, end: number, visitor: GlyphVisitor): boolean {
    const data = this.#data, header = this.#header;
    if (!data || !header) return false;
    if (!Number.isInteger(first) || !Number.isInteger(end) || first < 0 || end < first || end > this.glyphCount) throw new Error('invalid geometry glyph interval');
    // One operation-level borrow: reentrant disposal invalidates immediately,
    // but actual suspended arrays cannot be funded again until this frame exits.
    data.charge.retain(); header.retain();
    try {
      const words = data.words;
      for (let i = first; i < end; i++) {
        if (this.#data !== data) return false;
        visitor(i, i ? words[(i - 1) * 4]! : 0, words[i * 4]!, i ? words[(i - 1) * 4 + 1]! : 0, words[i * 4 + 1]!, words[i * 4 + 2]!, words[i * 4 + 3]!);
      }
      return this.#data === data;
    } finally { data.charge.release(); header.release(); }
  }
  static reflow(measured: Measurement, policy: GeometryPolicy, funding?: DataGrantFactory): RowLayout | undefined {
    const { width, mode, maxRows } = policy;
    if (!Number.isSafeInteger(width) || width < 0 || width > 0xffffffff || (mode !== 'file' && mode !== 'bash')
      || maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0)) throw new Error('invalid geometry policy');
    const data = measured.#data, measuredCharge = measured.#header;
    if (!data || !measuredCharge) return undefined;
    data.charge.retain(); measuredCharge.retain();
    let header: DataCharge | undefined, spans: Words | undefined, rows: Words | undefined, packedSpans: Packed | undefined, packedRows: Packed | undefined;
    try {
      header = fund(measured.#budget, layoutHeader, funding); spans = new Words(measured.#budget, fund(measured.#budget, builderHeader, funding), funding); rows = new Words(measured.#budget, fund(measured.#budget, builderHeader, funding), funding);
      buildRows(data.words, measured.glyphCount, mode, width, spans, rows, policy.prompt !== false, maxRows ?? Infinity);
      if (measured.#data !== data) return undefined;
      packedSpans = spans.finish(); packedRows = rows.finish();
      const result = new RowLayout(measured, header, packedSpans, packedRows);
      if (measured.#data !== data) return undefined;
      header = undefined; packedSpans = packedRows = undefined;
      return result;
    } catch (error) { if (error === denied) return undefined; throw error; }
    finally {
      packedSpans?.charge.release(); packedRows?.charge.release(); header?.release(); spans?.dispose(); rows?.dispose();
      data.charge.release(); measuredCharge.release();
    }
  }
  static borrow(measured: Measurement, rows: Packed, spans: Packed, layout: RowLayout, consume: (read: GeometryRead) => void, funding?: DataGrantFactory): boolean {
    const data = measured.#data, header = measured.#header;
    if (!data || !header) return false;
    data.charge.retain(); header.retain();
    let scratch: DataCharge | undefined, lookup: ReturnType<typeof geometryLookup> | undefined;
    try {
      scratch = fund(measured.#budget, 256, funding);
      if (measured.#data !== data || !layout.isValid) return false;
      lookup = geometryLookup(data.words, measured.glyphCount, rows.words, spans.words, new WeakRef(measured), new WeakRef(layout));
      if (!lookup.read.isValid) return false;
      consume(lookup.read); return lookup.read.isValid;
    } catch (error) { if (error === denied) return false; throw error; }
    finally { lookup?.clear(); data.charge.release(); header.release(); scratch?.release(); }
  }
  dispose(): void {
    this.#data = this.#header = undefined; releaseGeometry(this.#ownership);
  }
}

/** A layout owns its spans/row index, but only weakly depends on measurement.
 * Keep the measurement live while using it; disposal/collection rejects reads.
 * No mutable or borrowed array escapes either public numeric visitor. */
class RowLayout {
  #basis: WeakRef<Measurement>;
  #header?: DataCharge;
  #spans?: Packed;
  #rows?: Packed;
  #ownership: GeometryOwnership;
  #receipt: DataCleanupReceipt;
  readonly rowCount: number;
  readonly spanCount: number;
  readonly bufferBytes: number;
  readonly allocationBytes: number;
  constructor(basis: Measurement, header: DataCharge, spans: Packed, rows: Packed) {
    this.#basis = new WeakRef(basis); this.#header = header; this.#spans = spans; this.#rows = rows;
    this.#ownership = { header, first: spans.charge, second: rows.charge };
    this.#receipt = geometryReceipt(new WeakRef(this), this.#ownership);
    this.rowCount = rows.words.length / 2; this.spanCount = spans.words.length / 5;
    this.bufferBytes = rows.words.byteLength + spans.words.byteLength;
    this.allocationBytes = header.bytes + rows.charge.bytes + spans.charge.bytes;
  }
  cleanupReceipt(): DataCleanupReceipt { return this.#receipt; }
  get isValid(): boolean { return !!this.#rows && !!this.#basis.deref()?.isValid; }
  visitRows(visitor: (row: number, cells: number, spanCount: number) => void): boolean {
    const rows = this.#rows, header = this.#header;
    if (!rows || !header || !this.isValid) return false;
    rows.charge.retain(); header.retain();
    try {
      for (let row = 0; row < this.rowCount; row++) {
        if (!this.isValid) return false;
        const start = row ? rows.words[(row - 1) * 2]! : 0;
        visitor(row, rows.words[row * 2 + 1]!, rows.words[row * 2]! - start);
      }
      return this.isValid;
    } finally { rows.charge.release(); header.release(); }
  }
  visitSpans(row: number, visitor: SpanVisitor): boolean {
    const spans = this.#spans, rows = this.#rows, header = this.#header;
    if (!spans || !rows || !header || !this.isValid) return false;
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount) throw new Error('invalid geometry row');
    // Both vectors remain on this operation's stack across user callbacks.
    spans.charge.retain(); rows.charge.retain(); header.retain();
    try {
      const first = row ? rows.words[(row - 1) * 2]! : 0, end = rows.words[row * 2]!;
      for (let i = first; i < end; i++) {
        if (!this.isValid) return false;
        const at = i * 5;
        visitor(spans.words[at]! as GeometrySpanKind, spans.words[at + 1]!, spans.words[at + 2]!, spans.words[at + 3]!, spans.words[at + 4]!);
      }
      return this.isValid;
    } finally { spans.charge.release(); rows.charge.release(); header.release(); }
  }
  /** One operation borrow across random numeric access. No array escapes, and
   * keeping the cleared lookup does not retain geometry or its owner. */
  withLookup(measured: MeasuredText, consume: (read: GeometryRead) => void, funding?: DataGrantFactory): boolean {
    const spans = this.#spans, rows = this.#rows, header = this.#header;
    if (!spans || !rows || !header || this.#basis.deref() !== measured || !this.isValid) return false;
    spans.charge.retain(); rows.charge.retain(); header.retain();
    try { return Measurement.borrow(measured, rows, spans, this, consume, funding); }
    finally { spans.charge.release(); rows.charge.release(); header.release(); }
  }
  dispose(): void {
    this.#spans = this.#rows = this.#header = undefined; releaseGeometry(this.#ownership);
  }
}

// Separate factory scope: an escaped, cleared lookup holds neither the first
// owner nor its vectors through a shared method/installer closure context.
function geometryLookup(glyphs: Uint32Array | undefined, glyphCount: number, rows: Uint32Array | undefined, spans: Uint32Array | undefined,
  basis: WeakRef<Measurement> | undefined, layout: WeakRef<RowLayout> | undefined) {
  const rowCount = rows!.length / 2, spanCount = spans!.length / 5;
  const valid = () => !!glyphs && !!rows && !!spans && !!basis?.deref()?.isValid && !!layout?.deref()?.isValid;
  const check = (index: number, count: number) => {
    if (!valid()) throw new Error('stale geometry lookup');
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('invalid geometry lookup index');
  };
  const read: GeometryRead = {
    get isValid() { return valid(); },
    rowEnd(row) { check(row, rowCount); return rows![row * 2]!; },
    rowColumns(row) { check(row, rowCount); return rows![row * 2 + 1]!; },
    span(index, visit) {
      check(index, spanCount); const at = index * 5;
      visit(spans![at]! as GeometrySpanKind, spans![at + 1]!, spans![at + 2]!, spans![at + 3]!, spans![at + 4]!);
    },
    glyphStart(index) { check(index, glyphCount); return index ? glyphs![(index - 1) * 4]! : 0; },
    glyphEnd(index) { check(index, glyphCount); return glyphs![index * 4]!; },
    glyphByte(index) { check(index, glyphCount); return index ? glyphs![(index - 1) * 4 + 1]! : 0; },
  };
  return { read, clear() { glyphs = rows = spans = undefined; basis = layout = undefined; } };
}

function buildRows(glyphs: Uint32Array, count: number, mode: 'file' | 'bash', width: number, spans: Words, rows: Words, prompt: boolean, maxRows: number): void {
  if (!width || !maxRows) return;
  let columns = 0, spanCount = 0, pendingKind = -1, pendingFirst = 0, pendingEnd = 0, pendingCells = 0, pendingOffset = 0;
  const flush = () => {
    if (pendingKind < 0) return;
    spans.push(pendingKind); spans.push(pendingFirst); spans.push(pendingEnd); spans.push(pendingCells); spans.push(pendingOffset);
    spanCount++; pendingKind = -1;
  };
  const append = (kind: number, first: number, end: number, cells: number, offset = 0) => {
    const merge = pendingKind === kind && (kind === SpanKind.Source ? pendingEnd === first
      : kind === SpanKind.Tab ? pendingFirst === first : kind === SpanKind.Prompt && pendingOffset + pendingCells === offset);
    if (!merge) { flush(); pendingKind = kind; pendingFirst = first; pendingOffset = offset; pendingCells = 0; }
    pendingEnd = end; pendingCells += cells; columns += cells;
  };
  const row = () => { flush(); rows.push(spanCount); rows.push(columns); columns = 0; return rows.length / 2 >= maxRows; };
  if (mode === 'bash') {
    if (prompt) for (let offset = 0; offset < 2; offset++) { if (columns === width && row()) return; append(SpanKind.Prompt, 0, 0, 1, offset); }
    for (let i = 0; i < count; i++) {
      const flags = glyphs[i * 4 + 3]!, size = glyphs[i * 4 + 2]!;
      if (flags & GlyphFlag.Newline) { if (row()) return; }
      else if (flags & GlyphFlag.Tab) {
        // Calculate once at encounter, including a still-full preceding row.
        let remaining = 8 - columns % 8;
        while (remaining) {
          if (columns === width && row()) return;
          const cells = Math.min(remaining, width - columns);
          append(SpanKind.Tab, i, i + 1, cells); remaining -= cells;
        }
      } else {
        const replacement = size > width, cells = replacement ? 1 : size;
        if (columns + cells > width && row()) return;
        append(replacement ? SpanKind.Replacement : SpanKind.Source, i, i + 1, cells);
      }
    }
    row(); return;
  }
  // File tabs use logical-line columns, not soft-wrap columns. Cursors may
  // stop inside one original tab; no expanded source string/vector is built.
  let glyph = 0, tabUsed = 0, logical = 0;
  do {
    let end = glyph, used = tabUsed, lineColumn = logical, cells = 0, units = 0;
    let boundary = -1, boundaryUsed = 0, boundaryColumn = 0, boundaryCells = 0;
    while (end < count && !(glyphs[end * 4 + 3]! & GlyphFlag.Newline)) {
      const flags = glyphs[end * 4 + 3]!, tab = !!(flags & GlyphFlag.Tab), size = glyphs[end * 4 + 2]!;
      const amount = tab ? 1 : Math.min(size, width);
      if (cells + amount > width) break;
      cells += amount; units++;
      if (tab) {
        const total = 4 - (lineColumn - used) % 4;
        used++; lineColumn++;
        if (used === total) { end++; used = 0; }
      } else { end++; used = 0; lineColumn += size; }
      if ((flags & GlyphFlag.Whitespace) && units > 1) {
        boundary = end; boundaryUsed = used; boundaryColumn = lineColumn; boundaryCells = cells;
      }
    }
    if (end < count && !(glyphs[end * 4 + 3]! & GlyphFlag.Newline) && boundary >= 0 && boundaryCells > 0) {
      end = boundary; used = boundaryUsed; lineColumn = boundaryColumn;
    }
    while (glyph < end || glyph === end && tabUsed < used) {
      const flags = glyphs[glyph * 4 + 3]!, size = glyphs[glyph * 4 + 2]!;
      if (flags & GlyphFlag.Tab) {
        const total = 4 - (logical - tabUsed) % 4;
        const amount = glyph === end ? used - tabUsed : total - tabUsed;
        append(SpanKind.Tab, glyph, glyph + 1, amount); logical += amount; tabUsed += amount;
        if (tabUsed === total) { glyph++; tabUsed = 0; }
      } else {
        const replacement = size > width;
        append(replacement ? SpanKind.Replacement : SpanKind.Source, glyph, glyph + 1, Math.min(size, width));
        logical += size; glyph++;
      }
    }
    logical = lineColumn; if (row()) return;
    if (glyph < count && (glyphs[glyph * 4 + 3]! & GlyphFlag.Newline)) {
      glyph++; tabUsed = 0; logical = 0;
      if (glyph === count) row();
    }
  } while (glyph < count);
}

export interface MeasuredAppend { readonly measured: MeasuredText; commit(): boolean; dispose(): void }
export type MeasuredText = Measurement;
/** Caller verifies append-only source identity, then commits after its final
 * ownership check; do not read the candidate before commit succeeds. Disposal
 * before commit leaves all previous geometry intact. */
export function prepareMeasuredAppend(previous: MeasuredText, text: string, funding?: DataGrantFactory): MeasuredAppend | undefined {
  return Measurement.prepareAppend(previous, text, funding);
}
export type MeasuredRowLayout = RowLayout;
/** Caller supplies the existing ledger. Denial returns undefined; malformed
 * input/allocation exceptions propagate after refunding the entire candidate. */
export function measure(logicalText: string, budget: DataBudget, funding?: DataGrantFactory): MeasuredText | undefined { return Measurement.create(logicalText, budget, funding); }
export function reflow(measured: MeasuredText, policy: GeometryPolicy, funding?: DataGrantFactory): MeasuredRowLayout | undefined { return Measurement.reflow(measured, policy, funding); }
