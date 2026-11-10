import { cardGeometry, frameMeasuredRow, type CardGeometry } from '../card-frame.ts';
import { buildBashScene } from './bash-scene.ts';
import { buildFileScene } from './file-scene.ts';
import type { Cell, Entry, RegionKind, Scene, SceneConstruction } from './scene-model.ts';
import type { DataBudget, DataCharge, DataCleanupReceipt, DataGrantFactory } from '../resources/data-budget.ts';
import type { CardRole } from '../appearance/card-roles.ts';
import type { PreparedCard, PreparedRegion, ReadyCardPaint, FileRowDescriptor, FlatRangeReader } from './card-values.ts';
import { paintFlat, type FlatPaintRows } from './flat-paint.ts';
import { reflow, SpanKind } from './measured-rows.ts';
import type { AnsiStyle } from '../appearance/style-ansi.ts';

export interface CardLayoutOptions { width: number; outputPad?: number; expanded?: boolean }
/** Proof preparation and caching belong to the host, not this consumer. The byte
 * limit may end inside a current grapheme: its first scalar owns all its cells. */
export interface BashPaintProof { readonly eligibleBytes: number; readonly ranges: FlatRangeReader }
export interface CardFunding { readonly budget: DataBudget; readonly grant: DataGrantFactory }
const refused = Symbol('card layout refused');
type ChargeNode = { charge: DataCharge; next?: ChargeNode };
// Policy bytes cover the holder/list nodes as well as the named allocation.
class Ledger {
  first?: ChargeNode;
  #borrows = 0;
  #released = false;
  add(f: CardFunding, bytes: number): void {
    const grant = f.grant(bytes + 64); if (!grant) throw refused;
    try {
      if (grant.budget !== f.budget) throw new Error('foreign card layout grant');
      const charge = grant.consume(bytes + 64);
      this.first = { charge, next: this.first };
    } finally { grant.close(); }
  }
  borrow(): void { this.#borrows++; }
  unborrow(): void { if (!--this.#borrows && this.#released) this.release(); }
  release(): void {
    this.#released = true;
    if (this.#borrows) return;
    const first = this.first; this.first = undefined; releaseNodes(first);
  }
}
function releaseNodes(node: ChargeNode | undefined) { for (; node; node = node.next) node.charge.release(); }
function borrowNodes(node: ChargeNode | undefined) { for (let n = node; n; n = n.next) n.charge.retain(); return node; }
function receipt(owner: WeakRef<{ dispose(): void }>, ledger: Ledger, children?: DataCleanupReceipt[]): DataCleanupReceipt {
  return { release() { const handle = owner.deref(); if (handle) handle.dispose(); else { for (const child of children ?? []) child.release(); ledger.release(); } } };
}
function region(display: PreparedCard, entry: Pick<Entry, 'kind' | 'index'>): PreparedRegion | undefined {
  if (display.kind === 'bash') {
    switch (entry.kind) {
      case 'command': return display.command;
      case 'description': return display.regions.description;
      case 'heading': return display.regions.heading;
      case 'output': return display.regions.output[entry.index];
      case 'footer': return display.regions.footer;
    }
  } else {
    switch (entry.kind) {
      case 'heading': return display.heading;
      case 'note': return display.note;
      case 'diagnostic': return display.diagnostics[entry.index];
      case 'file': return display.rows[entry.index]?.region;
    }
  }
}

class SceneBuilder implements SceneConstruction {
  readonly scene: Scene;
  readonly available: number;
  #display: PreparedCard;
  #ledger: Ledger;
  #funding: CardFunding;
  constructor(display: PreparedCard, scene: Scene, available: number, ledger: Ledger, funding: CardFunding) {
    this.#display = display; this.scene = scene; this.available = available;
    this.#ledger = ledger; this.#funding = funding;
  }
  empty(width = this.available, entry = -1): Cell { return { entry, row: 0, width, gutter: 0, line: -1, side: 'next' }; }
  append(left: Cell, right?: Cell): void { this.#ledger.add(this.#funding, 256); this.scene.rows.push({ left, right }); }
  removeLastRow(): void { this.scene.rows.pop(); }
  insertEmptyRow(index: number): void { this.#ledger.add(this.#funding, 256); this.scene.rows.splice(index, 0, { left: this.empty() }); }
  entry(kind: RegionKind, index: number, role: CardRole, width: number, mode: 'file' | 'bash', prompt = false, maxRows?: number, side?: 'old' | 'next'): number {
    const current = this.scene, funding = this.#funding;
    const locator = { kind, index }, r = region(this.#display, locator); if (!r) throw refused;
    this.#ledger.add(funding, 256);
    const layout = reflow(r.measured, { mode, width, prompt, maxRows,
      wrap: kind === 'heading' && mode === 'file' ? 'fragments' : undefined }, funding.grant); if (!layout) throw refused;
    current.children.push(layout.cleanupReceipt());
    this.#ledger.add(funding, 128 + layout.rowCount * 16);
    const cells: number[] = [], blank: boolean[] = [];
    if (!layout.visitRows((_i, count) => { cells.push(count); blank.push(true); })) throw refused;
    // Preview trimming is a row predicate, not normalization or a new measurement.
    if (kind === 'output' && !layout.withLookup(r.measured, read => {
      let span = 0;
      for (let row = 0; row < layout.rowCount; row++) for (; span < read.rowEnd(row); span++) read.span(span, (k, first, end) => {
        if (k === SpanKind.Replacement || k === SpanKind.Prompt) blank[row] = false;
        else if (k === SpanKind.Source) {
          const temporary = new Ledger();
          try {
            const start = read.glyphStart(first), endIndex = read.glyphEnd(end - 1);
            temporary.add(funding, 64 + (endIndex - start) * 2);
            if (/\S/u.test(r.text.slice(start, endIndex))) blank[row] = false;
          } finally { temporary.release(); }
        }
      });
    }, funding.grant)) throw refused;
    const id = current.entries.length;
    current.entries.push({ ...locator, role, side, measured: new WeakRef(r.measured), layout, cells, blank }); return id;
  }
  lines(kind: RegionKind, index: number, role: CardRole, mode: 'file' | 'bash' = 'file', prompt = false): void {
    const id = this.entry(kind, index, role, this.available, mode, prompt), e = this.scene.entries[id]!;
    for (let row = 0; row < e.layout.rowCount; row++) this.append({ ...this.empty(), entry: id, row });
  }
}

/** Color-free, caller-owned scene. Holds only numeric layout and weak measured
 * identities; neither the provisional display nor its strings are retained. */
export class CardLayout {
  #scene?: Scene;
  #ledger: Ledger;
  #receipt: DataCleanupReceipt;
  readonly expandable: boolean;
  readonly framed: boolean;
  readonly rowCount: number;
  readonly geometry: Readonly<CardGeometry>;
  constructor(scene: Scene, ledger: Ledger) {
    this.#scene = scene; this.#ledger = ledger;
    this.#receipt = receipt(new WeakRef(this), ledger, scene.children);
    this.expandable = scene.expandable; this.framed = scene.framed; this.geometry = Object.freeze(scene.geometry);
    this.rowCount = scene.rows.length + (scene.framed && scene.rows.length ? 2 : 0);
  }
  /** Host warm hits additionally compare the accepted display's geometry stamp.
   * Full dependency validation is reserved for layout/paint transactions. */
  get isRetained() { return !!this.#scene; }
  get isValid() { return !!this.#scene && this.#scene.entries.every(e => e.layout.isValid && !!e.measured.deref()?.isValid); }
  cleanupReceipt() { return this.#receipt; }
  /** Operation-only borrow; never expose scene data to the host. */
  paint(display: PreparedCard, paint: ReadyCardPaint, funding: CardFunding, proof?: BashPaintProof): CardRows | undefined {
    const scene = this.#scene;
    if (!scene || !this.isValid || display.kind !== scene.kind || display.geometryStamp !== scene.stamp) return undefined;
    const held = borrowNodes(this.#ledger.first);
    try {
      // Per-range/row checks are O(1); each flat borrow validates its own geometry.
      // Validate the complete scene once at each operation boundary, not per range.
      const candidate = paintScene(scene, display, paint, funding, proof, () => this.#scene === scene);
      if (candidate && !this.isValid) { candidate.dispose(); return undefined; }
      return candidate;
    } finally { releaseNodes(held); }
  }
  dispose(): void {
    const scene = this.#scene; this.#scene = undefined;
    if (scene) for (const child of scene.children) child.release();
    this.#ledger.release();
  }
}

/** Provisional scene: publish only after the outer prepared-card visit succeeds.
 * Rejection releases the candidate while the prior accepted layout stays owned. */
export function layoutCard(display: PreparedCard, options: CardLayoutOptions, funding: CardFunding): CardLayout | undefined {
  const ledger = new Ledger(); let scene: Scene | undefined, adopted = false;
  try {
    ledger.add(funding, 768);
    const geometry = cardGeometry(options.width, options.outputPad ?? 1);
    const inline = display.kind === 'file' && display.mode === 'inline';
    const inset = inline ? Math.min(geometry.contentX, Math.max(0, geometry.width - geometry.marginRight - 1)) : 0;
    const available = inline ? geometry.width - inset - geometry.marginRight : geometry.contentWidth;
    scene = { kind: display.kind, stamp: display.geometryStamp, geometry, framed: !inline, inset,
      expandable: false, digits: 1, entries: [], rows: [], children: [] };
    const current = scene;
    if (geometry.width && available) {
      const build = new SceneBuilder(display, current, available, ledger, funding);
      if (display.kind === 'bash') buildBashScene(display, options.expanded, build);
      else buildFileScene(display, build);
    }
    if (current.entries.some(e => !e.layout.isValid)) return undefined;
    const result = new CardLayout(current, ledger); adopted = true; return result;
  } catch (error) { if (error === refused) return undefined; throw error; }
  finally { if (!adopted) { for (const child of scene?.children ?? []) child.release(); ledger.release(); } }
}

/** Detached funded final rows. Row strings are synchronous borrows. A caller may
 * keep this handle, never an uncharged copied row array. */
export class CardRows {
  #rows?: string[];
  #ledger: Ledger;
  #receipt: DataCleanupReceipt;
  readonly rowCount: number;
  constructor(rows: string[], ledger: Ledger) { this.#rows = rows; this.#ledger = ledger; this.rowCount = rows.length; this.#receipt = receipt(new WeakRef(this), ledger); }
  get isValid() { return !!this.#rows; }
  cleanupReceipt() { return this.#receipt; }
  /** Operation-level borrow protects every charged row without traversing the
   * charge ledger. Consumers must not mutate or independently own the array. */
  withRows(consume: (rows: string[]) => void): boolean {
    const rows = this.#rows; if (!rows) return false;
    this.#ledger.borrow();
    try { consume(rows); return this.#rows === rows; }
    finally { this.#ledger.unborrow(); }
  }
  visitRows(consume: (index: number, row: string) => void): boolean {
    return this.withRows(rows => {
      for (let i = 0; i < rows.length; i++) { if (this.#rows !== rows) return; consume(i, rows[i]!); }
    });
  }
  dispose() { this.#rows = undefined; this.#ledger.release(); }
}
type Projected = { start: number; end: number; style: AnsiStyle };
type Projection = { index: number; start: number; end: number; ranges: Projected[] };
function coordinate(row: FileRowDescriptor, side: 'old' | 'next') {
  if (row.kind === '-') return row.oldSource;
  if (row.kind === '+') return row.nextSource;
  return side === 'old' ? row.oldSource : row.nextSource;
}
const neutralReader: FlatRangeReader = () => true;
function styled(style: AnsiStyle, text: string) { return style.open + text + style.close; }

function paintScene(scene: Scene, display: PreparedCard, paint: ReadyCardPaint, funding: CardFunding, proof: BashPaintProof | undefined,
  valid: () => boolean): CardRows | undefined {
  const scratch = new Ledger(), output = new Ledger();
  let adopted = false;
  const flats: FlatPaintRows[] = [];
  try {
    scratch.add(funding, 1024 + scene.entries.length * 128); output.add(funding, 512 + (scene.rows.length + 2) * 8);
    const roles = paint.roles, projections = new Map<string, Projection[]>(), projected = new Map<number, Projected[]>();
    if (display.kind === 'file') {
      // Each key/surface is read once. Sparse rows retain full-source byte starts;
      // a moving cursor skips omitted context without rescanning a source per row.
      for (let i = 0; i < scene.entries.length; i++) {
        const e = scene.entries[i]!; if (e.kind !== 'file') continue;
        const row = display.rows[e.index]!, c = coordinate(row, e.side ?? 'next'); if (!c) continue;
        const surface = display.mode === 'code' ? '' : row.kind === '+' ? 'added' : row.kind === '-' ? 'removed' : 'context';
        scratch.add(funding, 256 + (c.key.length + 1 + surface.length) * 2);
        const key = c.key + '\0' + surface;
        let group = projections.get(key); if (!group) { group = []; projections.set(key, group); }
        const measured = row.region!.measured;
        let bytes = 0;
        if (!measured.visitGlyphs(Math.max(0, measured.glyphCount - 1), measured.glyphCount, (_i, _a, _b, _c, end) => { bytes = end; })) throw refused;
        const ranges: Projected[] = []; group.push({ index: i, start: c.byte, end: c.byte + bytes, ranges }); projected.set(i, ranges);
      }
      for (const [key, group] of projections) {
        const zero = key.indexOf('\0'), source = key.slice(0, zero), surface = key.slice(zero + 1) as '' | 'added' | 'removed' | 'context';
        const reader = paint.ranges(source, surface || undefined); if (!reader) continue;
        let first = 0;
        if (!reader((a, b, style) => {
          if (!valid()) throw refused;
          while (first < group.length) {
            const p = group[first]!;
            if (p.end > a) break;
            first++;
          }
          for (let j = first; j < group.length && group[j]!.start < b; j++) {
            const p = group[j]!; if (p.end <= a) continue; scratch.add(funding, 96);
            p.ranges.push({ start: Math.max(0, a - p.start), end: b - p.start, style });
          }
        })) throw refused;
      }
    }
    const painted: string[][] = [];
    for (let i = 0; i < scene.entries.length; i++) {
      const e = scene.entries[i]!, r = region(display, e);
      if (!r || e.measured.deref() !== r.measured || !valid()) throw refused;
      const ranges = projected.get(i);
      const reader: FlatRangeReader = e.kind === 'command' ? proof?.ranges ?? neutralReader : cb => { for (const range of ranges ?? []) cb(range.start, range.end, range.style); return valid(); };
      const flat = paintFlat(r.text, r.measured, e.layout, reader, roles[e.role], roles.prompt,
        e.kind === 'command' ? proof?.eligibleBytes ?? 0 : Number.MAX_SAFE_INTEGER, funding.budget, funding.grant);
      if (!flat) throw refused; flats.push(flat);
      scratch.add(funding, 64 + flat.rowCount * 8);
      const rows: string[] = []; if (!flat.visitRows((_n, text) => rows.push(text))) throw refused; painted.push(rows);
    }
    const body: string[] = [];
    const cell = (c: Cell): string => {
      if (c.entry < 0) {
        if (c.entry === -2) {
          const label = '… (Click to expand)', text = c.width >= label.length ? label : c.width <= 3 ? '.'.repeat(c.width) : label.slice(0, c.width - 3) + '...';
          return styled(roles.overflow, text) + styled(roles.empty, ' '.repeat(c.width - text.length));
        }
        if (c.entry === -3) return styled(roles.gutter, '…') + styled(roles.empty, ' '.repeat(Math.max(0, c.width - 1)));
        return styled(roles.empty, ' '.repeat(c.width));
      }
      const e = scene.entries[c.entry]!, text = painted[c.entry]?.[c.row];
      if (text === undefined) return styled(roles.empty, ' '.repeat(c.width));
      let gutter = '';
      if (c.gutter && display.kind === 'file') {
        const r = display.rows[c.line]!, plain = display.mode === 'code';
        const number = c.row === 0 ? String(r[c.side] ?? '').padStart(scene.digits) : ' '.repeat(scene.digits);
        const g = plain ? roles.numbers : r.kind === '+' ? roles.addedGutter : r.kind === '-' ? roles.removedGutter : roles.contextGutter;
        const sign = r.kind === '+' ? roles.addedSign : roles.removedSign;
        gutter = styled(g, ' ' + number) + (plain ? '' : c.row === 0 && (r.kind === '+' || r.kind === '-') ? styled(sign, ' ' + r.kind) : styled(g, '  ')) + styled(g, ' ');
      }
      return gutter + text + (scene.framed ? styled(roles[e.role], ' '.repeat(c.width - c.gutter - e.cells[c.row]!)) : '');
    };
    const shellPaint = { panel: (s: string) => styled(roles.padding, s), border: (s: string) => {
      const role = display.kind === 'bash' && display.service.error ? roles.errorFrame : roles.frame;
      // The stripe is outside the panel regardless of the complete role's surface.
      return role.open + '\x1b[49m' + s + role.close;
    } };
    const emit = (make: () => string, units: number) => {
      const temporary = new Ledger();
      try {
        temporary.add(funding, 256 + units * 8); output.add(funding, 64 + units * 2);
        const text = make(); if (text.length > units) throw new Error('card row funding bound exceeded'); body.push(text);
      } finally { temporary.release(); }
    };
    // Complete prepared styles make length bounds exact upper bounds without ANSI scans.
    const maxRole = Math.max(...Object.values(roles).map(s => s.open.length + s.close.length));
    const shellBound = scene.geometry.width + maxRole * 8 + 16;
    if (scene.framed && scene.rows.length) emit(() => frameMeasuredRow(scene.geometry, '', 0, { ...shellPaint, panel: s => styled(roles.panel, s) }), shellBound);
    for (const row of scene.rows) {
      if (!valid()) throw refused;
      const bound = (c: Cell) => (c.entry < 0 ? c.width + maxRole * 2 : (painted[c.entry]?.[c.row]?.length ?? 0) + c.width + maxRole * 6);
      emit(() => {
        const text = cell(row.left) + (row.right ? cell(row.right) : '');
        return scene.framed ? frameMeasuredRow(scene.geometry, text, row.left.width + (row.right?.width ?? 0), shellPaint) : ' '.repeat(scene.inset) + text;
      }, bound(row.left) + (row.right ? bound(row.right) : 0) + shellBound);
    }
    if (scene.framed && scene.rows.length) emit(() => frameMeasuredRow(scene.geometry, '', 0, { ...shellPaint, panel: s => styled(roles.panel, s) }), shellBound);
    if (!valid()) throw refused;
    const result = new CardRows(body, output); adopted = true; return result;
  } catch (error) { if (error === refused) return undefined; throw error; }
  finally { for (const flat of flats) flat.dispose(); scratch.release(); if (!adopted) output.release(); }
}
