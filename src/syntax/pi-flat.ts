import type { PiProjectionPayload, StagedPiProjection } from '../occipital/pi-projection.ts';
import { DataBudget, type DataCharge, type DataGrant } from '../occipital/data-budget.ts';
import { OCCIPITAL_LIMITS } from '../occipital/limits.ts';
import type { LiteralInk } from '../occipital/semantic-codec.ts';
import type { ConcreteStyle } from './style-materialization.ts';
/** Exact synchronous public highlightCode rows, excluding LF and preserving tabs. */
export type PiRowReader = (consume: (index: number, line: string) => void) => boolean;

const refused = Symbol('Pi projection allocation refused');
const handleBytes = 128, headerBytes = 256, operationBytes = 512, styleBytes = 512, keyBytes = 256;
type Charges = { value: DataCharge; next?: Charges };
type Store = { words: Uint32Array; vector: DataCharge; styles: ConcreteStyle[]; charges?: Charges;
  header: DataCharge; holders: number; count: number; sourceBytes: number };
type ReservePiData = (bytes: number) => DataGrant | undefined;
function fund(budget: DataBudget, bytes: number, reserve?: ReservePiData): DataCharge {
  const grant = reserve ? reserve(bytes) : budget.reserve(bytes);
  if (!grant) throw refused;
  try {
    if (grant.budget !== budget) throw new Error('foreign Pi data grant');
    return grant.consume(bytes);
  } finally { grant.close(); }
}
function releaseCharges(link: Charges | undefined): void {
  while (link) { const next = link.next; link.next = undefined; link.value.release(); link = next; }
}
function release(store: Store): void {
  if (--store.holders) return;
  store.words = new Uint32Array(); store.styles = [];
  releaseCharges(store.charges); store.charges = undefined;
  store.vector.release(); store.header.release();
}

/** One accounted, detached conversion of public Pi ANSI output. Style indices
 * belong only to this table; they are neither scope IDs nor source-work proof.
 * Visitors borrow synchronously. Retained copies/compiled tables are caller-funded. */
class PiFlatPayload implements PiProjectionPayload {
  #store?: Store;
  #header?: DataCharge;
  readonly sourceBytes: number;
  readonly styleCount: number;
  readonly rangeCount: number;
  constructor(store: Store, header: DataCharge) {
    this.#store = store; this.#header = header; this.#budget = header.budget;
    this.sourceBytes = store.sourceBytes; this.styleCount = store.styles.length; this.rangeCount = store.count;
    Object.freeze(this);
  }
  get isValid(): boolean { return this.#store !== undefined; }
  get budget(): DataBudget { return this.#header?.budget ?? this.#budget; }
  readonly #budget: DataBudget;
  get accountedBytes(): number {
    const store = this.#store; if (!store) return 0;
    let bytes = this.#header!.bytes + store.header.bytes + store.vector.bytes;
    for (let link = store.charges; link; link = link.next) bytes += link.value.bytes;
    return bytes;
  }
  static retainProjection(value: PiFlatPayload): PiFlatProjection | undefined {
    const store = value.#store, owner = value.#header;
    if (!store || !owner) return undefined;
    let header: DataCharge;
    try { header = fund(owner.budget, handleBytes); } catch (error) { if (error === refused) return undefined; throw error; }
    if (value.#store !== store) { header.release(); return undefined; }
    try { const result = new PiFlatProjection(store, header); store.holders++; return result; }
    catch (error) { header.release(); throw error; }
  }
  static stageProjection(value: PiFlatPayload, reserve?: ReservePiData): StagedPiProjection | undefined {
    const store = value.#store, header = value.#header;
    if (!store || !header || store.holders !== 1) return undefined;
    let stageHeader: DataCharge;
    try { stageHeader = fund(header.budget, handleBytes, reserve); } catch (error) { if (error === refused) return undefined; throw error; }
    if (value.#store !== store || store.holders !== 1) { stageHeader.release(); return undefined; }
    try {
      const stage = new PiFlatStage(store, header, stageHeader, value.accountedBytes);
      value.#store = value.#header = undefined;
      return stage;
    } catch (error) { stageHeader.release(); throw error; }
  }
  visitRanges(consume: (start: number, end: number, style: number) => void): boolean {
    const store = this.#store, header = this.#header;
    if (!store || !header) return false;
    store.holders++; header.retain();
    try {
      let start = 0;
      for (let index = 0; index < store.count; index++) {
        if (this.#store !== store) return false;
        const end = store.words[index * 2]!;
        consume(start, end, store.words[index * 2 + 1]!); start = end;
      }
      return this.#store === store;
    } finally { release(store); header.release(); }
  }
  visitStyles(consume: (index: number, style: ConcreteStyle) => void): boolean {
    const store = this.#store, header = this.#header;
    if (!store || !header) return false;
    store.holders++; header.retain();
    try {
      for (let index = 0; index < store.styles.length; index++) {
        if (this.#store !== store) return false;
        consume(index, store.styles[index]!);
      }
      return this.#store === store;
    } finally { release(store); header.release(); }
  }
  dispose(): void {
    const store = this.#store, header = this.#header;
    this.#store = this.#header = undefined;
    if (store) release(store); header?.release();
  }
}
class PiFlatProjection extends PiFlatPayload {
  retain(): PiFlatProjection | undefined { return PiFlatPayload.retainProjection(this); }
  stage(reserve?: ReservePiData): StagedPiProjection | undefined { return PiFlatPayload.stageProjection(this, reserve); }
}
class PiFlatStage implements StagedPiProjection {
  #store?: Store; #payloadHeader?: DataCharge; #header?: DataCharge;
  readonly budget: DataBudget; readonly sourceBytes: number; readonly accountedBytes: number;
  readonly styleCount: number; readonly rangeCount: number;
  constructor(store: Store, payloadHeader: DataCharge, header: DataCharge, bytes: number) {
    this.#store = store; this.#payloadHeader = payloadHeader; this.#header = header;
    this.budget = header.budget; this.sourceBytes = store.sourceBytes; this.accountedBytes = bytes + header.bytes;
    this.styleCount = store.styles.length; this.rangeCount = store.count;
    Object.freeze(this);
  }
  consume(): PiProjectionPayload | undefined {
    const store = this.#store, header = this.#payloadHeader;
    this.#store = undefined; this.#payloadHeader = undefined; this.#header?.release(); this.#header = undefined;
    if (!store || !header) return undefined;
    try { return new PiFlatPayload(store, header); }
    catch (error) { release(store); header.release(); throw error; }
  }
  dispose(): void {
    const store = this.#store; this.#store = undefined;
    if (store) release(store);
    this.#payloadHeader?.release(); this.#payloadHeader = undefined; this.#header?.release(); this.#header = undefined;
  }
}
export type PreparedPiFlat = PiFlatProjection;
export type PiFlatPreparation = Readonly<{ outcome: 'ready'; projection: PreparedPiFlat }> | Readonly<{ outcome: 'invalid' | 'refused' }>;

function logicalSource(text: string): { rows: number; bytes: number } | undefined {
  let rows = 1, bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) rows++;
    else if ((code < 32 && code !== 9) || (code >= 127 && code <= 159)) return undefined;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined;
      bytes += 4; continue;
    } else if (code >= 0xdc00 && code <= 0xdfff) return undefined;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
  }
  return bytes <= OCCIPITAL_LIMITS.sourceBytes ? { rows, bytes } : undefined;
}

class Parse {
  source = 0; byte = 0; rowIndex = 0; invalid = false;
  #foreground: LiteralInk; #attributes: number; #dirty = true; #style = 0;
  #indices = new Map<string, number>(); #keys?: Charges;
  readonly text: string; readonly expectedRows: number; readonly neutral: ConcreteStyle; readonly budget: DataBudget; readonly store: Store; readonly reserve?: ReservePiData;
  constructor(text: string, expectedRows: number, neutral: ConcreteStyle, budget: DataBudget, store: Store, reserve?: ReservePiData) {
    this.reserve = reserve;
    this.text = text; this.expectedRows = expectedRows; this.neutral = neutral; this.budget = budget; this.store = store;
    this.#foreground = neutral.foreground; this.#attributes = neutral.attributes;
  }
  #reset(): void { this.#foreground = this.neutral.foreground; this.#attributes = this.neutral.attributes; this.#dirty = true; }
  #styleIndex(): number {
    if (!this.#dirty) return this.#style;
    const keyCharge = fund(this.budget, keyBytes, this.reserve);
    try {
      const ink = this.#foreground;
      const key = `${ink.kind}/${ink.kind === 'rgb' ? `${ink.r}/${ink.g}/${ink.b}` : ink.kind === 'indexed' ? ink.index : ''}/${this.#attributes}`;
      const previous = this.#indices.get(key);
      if (previous !== undefined) { this.#style = previous; return previous; }
      const charge = fund(this.budget, styleBytes, this.reserve);
      this.store.charges = { value: charge, next: this.store.charges };
      const value: ConcreteStyle = Object.freeze({ foreground: Object.freeze({ ...ink }), background: Object.freeze({ ...this.neutral.background }), attributes: this.#attributes });
      const index = this.store.styles.length;
      this.store.styles.push(value); this.#indices.set(key, index);
      this.#keys = { value: keyCharge.retain(), next: this.#keys };
      this.#style = index; return index;
    } finally { keyCharge.release(); this.#dirty = false; }
  }
  #append(bytes: number): void {
    const style = this.#styleIndex(), store = this.store;
    this.byte += bytes;
    if (store.count && store.words[(store.count - 1) * 2 + 1] === style) { store.words[(store.count - 1) * 2] = this.byte; return; }
    if (store.count * 2 === store.words.length) {
      const capacity = Math.max(32, store.words.length * 2), charge = fund(this.budget, 64 + capacity * 4, this.reserve);
      try {
        const words = new Uint32Array(capacity); words.set(store.words);
        const old = store.vector; store.words = words; store.vector = charge; old.release();
      } catch (error) { charge.release(); throw error; }
    }
    store.words[store.count * 2] = this.byte; store.words[store.count * 2 + 1] = style; store.count++;
  }
  #sgr(line: string, start: number): number {
    if (line[start + 1] !== '[') return -1;
    let at = start + 2, finished = false;
    if (line[at] === 'm') { this.#reset(); return at + 1; }
    const parameter = (): number | undefined => {
      if (finished || !(line.charCodeAt(at) >= 48 && line.charCodeAt(at) <= 57)) return undefined;
      let value = 0;
      while (line.charCodeAt(at) >= 48 && line.charCodeAt(at) <= 57) {
        value = value * 10 + line.charCodeAt(at++) - 48;
        if (value > 255) return undefined;
      }
      if (line[at] === 'm') finished = true;
      else if (line[at] !== ';') return undefined;
      at++; return value;
    };
    while (!finished) {
      const code = parameter(); if (code === undefined) return -1;
      if (code === 0) this.#reset();
      else if (code === 1 || code === 2 || code === 3 || code === 4) this.#attributes |= code === 1 ? 1 : code === 2 ? 8 : code === 3 ? 2 : 4;
      else if (code === 9) this.#attributes |= 16;
      else if (code === 29) this.#attributes &= ~16;
      else if (code === 22) this.#attributes &= ~(1 | 8);
      else if (code === 23) this.#attributes &= ~2;
      else if (code === 24) this.#attributes &= ~4;
      else if (code === 39) this.#foreground = this.neutral.foreground;
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) this.#foreground = { kind: 'indexed', index: code >= 90 ? code - 90 + 8 : code - 30 };
      else if (code === 38 || code === 48) {
        const mode = parameter(); let ink: LiteralInk;
        if (mode === 5) { const index = parameter(); if (index === undefined) return -1; ink = { kind: 'indexed', index }; }
        else if (mode === 2) {
          const r = parameter(), g = parameter(), b = parameter();
          if (r === undefined || g === undefined || b === undefined) return -1;
          ink = { kind: 'rgb', r, g, b };
        } else return -1;
        if (code === 38) this.#foreground = ink;
      } else if (!(code === 49 || code >= 40 && code <= 47 || code >= 100 && code <= 107)) return -1;
      this.#dirty = true;
    }
    return at;
  }
  row(index: number, line: string): void {
    if (this.invalid) return;
    if (index !== this.rowIndex || index >= this.expectedRows || typeof line !== 'string') { this.invalid = true; return; }
    for (let at = 0; at < line.length;) {
      const code = line.codePointAt(at)!;
      if (code === 27) { at = this.#sgr(line, at); if (at < 0) { this.invalid = true; return; } continue; }
      if ((code < 32 && code !== 9) || code >= 127 && code <= 159 || code >= 0xd800 && code <= 0xdfff || code !== this.text.codePointAt(this.source)) { this.invalid = true; return; }
      this.#append(code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4);
      const units = code > 65535 ? 2 : 1; at += units; this.source += units;
    }
    if (this.rowIndex < this.expectedRows - 1) {
      if (this.text.charCodeAt(this.source) !== 10) { this.invalid = true; return; }
      this.#append(1); this.source++;
    } else if (this.source !== this.text.length) { this.invalid = true; return; }
    this.rowIndex++;
  }
  dispose(): void { this.#indices.clear(); releaseCharges(this.#keys); this.#keys = undefined; }
}

// A producer can retain its callback, but not the parse/source through it.
function rowVisitor(owner: { current?: Parse }): (index: number, line: string) => void {
  return (index, line) => owner.current?.row(index, line);
}

/** Convert exactly once outside render, after the caller has obtained permission
 * for Pi classification. This function never classifies, normalizes or chooses
 * a fallback/theme. RGB/index/default and all five fonts become literal data;
 * token backgrounds are discarded in favor of the supplied card surface. */
export function preparePiFlat(text: string, rows: PiRowReader, neutral: ConcreteStyle, budget: DataBudget, reserve?: ReservePiData): PiFlatPreparation {
  let operation: DataCharge | undefined, header: DataCharge | undefined, vector: DataCharge | undefined;
  let store: Store | undefined, parser: Parse | undefined;
  const owner: { current?: Parse } = {};
  try {
    operation = fund(budget, operationBytes, reserve);
    const logical = logicalSource(text); if (!logical) return { outcome: 'invalid' };
    header = fund(budget, headerBytes, reserve); vector = fund(budget, 64, reserve);
    store = { words: new Uint32Array(), vector, styles: [], header, holders: 1, count: 0, sourceBytes: logical.bytes };
    header = vector = undefined;
    if (text.length) {
      parser = new Parse(text, logical.rows, neutral, budget, store, reserve); owner.current = parser;
      let available: boolean;
      try { available = rows(rowVisitor(owner)); } finally { owner.current = undefined; }
      if (available !== true || parser.invalid || parser.rowIndex !== logical.rows || parser.source !== text.length) return { outcome: 'invalid' };
    }
    const handle = fund(budget, handleBytes, reserve);
    try { const projection = new PiFlatProjection(store, handle); store = undefined; return { outcome: 'ready', projection }; }
    catch (error) { handle.release(); throw error; }
  } catch (error) {
    if (error === refused) return { outcome: 'refused' };
    throw error;
  } finally { owner.current = undefined; parser?.dispose(); if (store) release(store); header?.release(); vector?.release(); operation?.release(); }
}
