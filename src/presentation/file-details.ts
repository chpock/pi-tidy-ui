import { cleanFileDisplayText } from '../cards/file-display.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import { measure, reflow, SpanKind, type MeasuredText } from '../rendering/measured-rows.ts';
import type { DataCharge, DataCleanupReceipt, GeometryFunding } from '../resources/data-budget.ts';

export interface FileDetailDraft {
  text: string;
  omitted: boolean;
  error: boolean;
  pending: boolean;
  sources?: () => Iterable<{ prefix: string; text: string }>;
}

/** Synchronous render borrow, not a retained payload or release authority. */
export interface FileDetailView {
  readonly denied: boolean;
  readonly omitted: boolean;
  readonly hasText: boolean;
}

interface DetailPorts<Owner extends object> {
  args(owner: Owner): object;
  result(owner: Owner): unknown;
  funding(): GeometryFunding | undefined;
  failed(owner: Owner, error: unknown): void;
}
type CleanupRecord = { owner: WeakRef<object>; receipt: DataCleanupReceipt };
const textHeader = 64;

class RetainedDetail implements FileDetailView {
  text: string;
  omitted: boolean;
  error: boolean;
  pending: boolean;
  args: object;
  result: unknown;
  mode: FilePreviewMode;
  denied = false;
  declare measured?: MeasuredText;
  declare record?: CleanupRecord;
  constructor(text: string, omitted: boolean, error: boolean, pending: boolean, args: object, result: unknown, mode: FilePreviewMode) {
    this.text = text; this.omitted = omitted; this.error = error; this.pending = pending;
    this.args = args; this.result = result; this.mode = mode;
  }
  get hasText(): boolean { return !!this.text; }
}

function textBytes(text: string): number {
  const bytes = text.length * 2;
  return Number.isSafeInteger(bytes) && bytes <= Number.MAX_SAFE_INTEGER - textHeader ? bytes + textHeader : Number.POSITIVE_INFINITY;
}
function constructionPeak(units: number, parts: number): number {
  const maximum = Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(parts) || parts < 0 ||
    units > Math.floor((maximum - 4096 - textHeader) / 8)) return Number.POSITIVE_INFINITY;
  const scratch = 4096 + units * 6;
  const retainedText = textHeader + units * 2;
  if (retainedText > maximum - scratch) return Number.POSITIVE_INFINITY;
  const partOverhead = 64;
  const available = maximum - scratch - retainedText;
  if (parts > Math.floor(available / partOverhead)) return Number.POSITIVE_INFINITY;
  // Three UTF-16-sized construction copies plus the separately charged joined text; no per-line descriptors are built here.
  return scratch + retainedText + parts * partOverhead;
}

// The detached callback's scope contains numeric ownership only, never a detail or producer.
function cleanup(measured: DataCleanupReceipt, text: DataCharge): DataCleanupReceipt {
  let released = false;
  return { release() {
    if (released) return; released = true; measured.release(); text.release();
  } };
}

/** Owns funded detail text and measurement; native eligibility and draft selection stay with the caller. */
export class FileDetails<Owner extends object> {
  #entries = new WeakMap<Owner, RetainedDetail>();
  #records = new Set<CleanupRecord>();
  #finalizer: FinalizationRegistry<CleanupRecord>;
  #ports: DetailPorts<Owner>;
  constructor(ports: DetailPorts<Owner>) {
    this.#ports = ports;
    const records = this.#records;
    this.#finalizer = new FinalizationRegistry(record => { records.delete(record); record.receipt.release(); });
  }
  #retain(owner: Owner, detail: RetainedDetail, charge: DataCharge): void {
    const record = { owner: new WeakRef(owner), receipt: cleanup(detail.measured!.cleanupReceipt(), charge) };
    detail.record = record; this.#records.add(record); this.#finalizer.register(owner, record, record);
  }
  prepare(owner: Owner, mode: FilePreviewMode, build: (owner: Owner, mode: FilePreviewMode) => FileDetailDraft, refreshContent = false): void {
    const cached = this.#entries.get(owner);
    if (!refreshContent && cached && !cached.denied && cached.args === this.#ports.args(owner) && cached.result === this.#ports.result(owner) && cached.mode === mode) return;
    const detail = build(owner, mode);
    if (cached && !cached.denied && !detail.sources && cached.mode === mode && cached.text === detail.text && cached.omitted === detail.omitted &&
      cached.error === detail.error && cached.pending === detail.pending) {
      cached.args = this.#ports.args(owner); cached.result = this.#ports.result(owner); return;
    }
    this.drop(owner);
    const next = new RetainedDetail(detail.text, detail.omitted, detail.error, detail.pending, this.#ports.args(owner), this.#ports.result(owner), mode);
    if (detail.sources) {
      let units = 0, parts = 0;
      for (const source of detail.sources()) {
        const addition = source.prefix.length + source.text.length + (parts ? 1 : 0);
        if (!Number.isSafeInteger(addition) || units > Number.MAX_SAFE_INTEGER - addition || parts === Number.MAX_SAFE_INTEGER) {
          units = Number.POSITIVE_INFINITY; break;
        }
        units += addition; parts++;
      }
      next.omitted = detail.omitted;
      if (parts) {
        const funding = this.#ports.funding();
        const estimate = constructionPeak(units, parts);
        const reservation = funding && Number.isSafeInteger(estimate) ? funding.grant(estimate) : undefined;
        if (!funding || !reservation) next.denied = true;
        else {
          let textCharge: DataCharge | undefined;
          try {
            const parts: string[] = []; let index = 0;
            for (const { prefix, text } of detail.sources()) {
              parts.push(`${index++ ? '\n' : ''}${prefix}${cleanFileDisplayText(text.replace(/\r\n?/gu, '\n'))}`);
            }
            next.omitted = detail.omitted;
            next.text = parts.join('');
            textCharge = reservation.consume(textBytes(next.text));
            parts.length = 0;
            reservation.close();
            next.measured = measure(next.text, funding.budget, funding.grant);
            if (next.measured) this.#retain(owner, next, textCharge);
            else { textCharge.release(); textCharge = undefined; next.text = ''; next.denied = true; }
          } catch (error) {
            textCharge?.release(); next.text = ''; next.denied = true;
            this.#ports.failed(owner, error);
          } finally { reservation.close(); }
        }
      }
    } else if (next.text) {
      const funding = this.#ports.funding(), bytes = textBytes(next.text);
      const reservation = funding && Number.isSafeInteger(bytes) ? funding.grant(bytes) : undefined;
      if (!funding || !reservation) { next.text = ''; next.denied = true; }
      else {
        let textCharge: DataCharge | undefined;
        try {
          textCharge = reservation.consume(bytes); reservation.close();
          next.measured = measure(next.text, funding.budget, funding.grant);
          if (next.measured) this.#retain(owner, next, textCharge);
          else { textCharge.release(); textCharge = undefined; next.text = ''; next.denied = true; }
        } catch (error) {
          textCharge?.release(); next.text = ''; next.denied = true;
          this.#ports.failed(owner, error);
        } finally { reservation.close(); }
      }
    }
    this.#entries.set(owner, next);
  }
  peek(owner: Owner, mode: FilePreviewMode): FileDetailView | undefined {
    const cached = this.#entries.get(owner);
    return cached?.args === this.#ports.args(owner) && cached.result === this.#ports.result(owner) && cached.mode === mode ? cached : undefined;
  }
  rows(view: FileDetailView, width: number): string[] | undefined {
    if (!(view instanceof RetainedDetail)) return;
    if (!view.text) return [];
    const measured = view.measured, funding = this.#ports.funding();
    if (!measured || !measured.isValid || !funding) return;
    const layout = reflow(measured, { mode: 'file', width }, funding.grant);
    if (!layout) return;
    const rows: string[] = []; let span = 0;
    try {
      const valid = layout.withLookup(measured, read => {
        layout.visitRows((_row, _cells, spanCount) => {
          let line = '';
          for (let i = 0; i < spanCount; i++, span++) read.span(span, (kind, first, end, cells) => {
            if (kind === SpanKind.Source && end > first) line += view.text.slice(read.glyphStart(first), read.glyphEnd(end - 1));
            else if (kind === SpanKind.Tab) line += ' '.repeat(cells);
            else if (kind === SpanKind.Replacement) line += '�' + ' '.repeat(Math.max(0, cells - 1));
          });
          rows.push(line);
        });
      });
      return valid ? rows : undefined;
    } finally { layout.dispose(); }
  }
  drop(owner: Owner): void {
    const cached = this.#entries.get(owner); if (!cached) return;
    this.#entries.delete(owner);
    if (cached.record) { this.#finalizer.unregister(cached.record); this.#records.delete(cached.record); cached.record.receipt.release(); }
  }
  clear(): void {
    for (const record of this.#records) { this.#finalizer.unregister(record); record.receipt.release(); }
    this.#records.clear(); this.#entries = new WeakMap();
  }
}
