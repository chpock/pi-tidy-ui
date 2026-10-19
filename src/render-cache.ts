import type { DataCleanupReceipt } from './occipital/data-budget.ts';

/** Component state owns rendered data; this module keeps only weak accounting records. */
export const LAYOUT_KINDS = ["summary", "bash", "edit", "write", "user", "queued"] as const;
export type LayoutKind = typeof LAYOUT_KINDS[number];
export interface LayoutMemory {
  retainedBytes: number;
  stringBytes: number;
  overheadBytes: number;
  entries: number;
  rows: number;
}
export interface CacheStats extends LayoutMemory {
  hits: number;
  misses: number;
  builds: number;
  releases: number;
  collected: number;
  byKind: Record<LayoutKind, LayoutMemory>;
}
export interface CacheEntry<T> { value?: T; bytes: number }
interface AccountingRecord extends LayoutMemory {
  reference: WeakRef<CacheEntry<unknown>>;
  kind: LayoutKind;
  cleanup?: DataCleanupReceipt;
}
const emptyMemory = (): LayoutMemory => ({ retainedBytes: 0, stringBytes: 0, overheadBytes: 0, entries: 0, rows: 0 });
export function layoutMemory(rows: readonly string[]): LayoutMemory {
  const stringBytes = rows.reduce((total, row) => total + row.length * 2, 0);
  // Conservative accounting allowance for the entry/weak bookkeeping, rows and array slots.
  const overheadBytes = 512 + rows.length * 64;
  return { retainedBytes: stringBytes + overheadBytes, stringBytes, overheadBytes, entries: 1, rows: rows.length };
}
export const MEMORY_FIELDS = ["retainedBytes", "stringBytes", "overheadBytes", "entries", "rows"] as const;
export class RenderCache {
  private records = new Set<AccountingRecord>();
  private accounting = new WeakMap<CacheEntry<unknown>, AccountingRecord>();
  private memory = emptyMemory();
  private kinds = Object.fromEntries(LAYOUT_KINDS.map(kind => [kind, emptyMemory()])) as Record<LayoutKind, LayoutMemory>;
  private hits = 0;
  private misses = 0;
  private builds = 0;
  private releases = 0;
  private collected = 0;
  // Detached receipts hold weak handles and numeric ownership, never layout data.
  private finalizer = new FinalizationRegistry<AccountingRecord>(record => this.releaseRecord(record, true));

  get<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (entry?.value !== undefined && this.accounting.has(entry)) {
      this.hits++;
      return entry.value;
    }
    this.misses++; return undefined;
  }
  put<T>(value: T, rows: readonly string[], kind: LayoutKind = "summary", cleanup?: DataCleanupReceipt): CacheEntry<T> {
    this.builds++;
    const memory = layoutMemory(rows);
    const entry: CacheEntry<T> = { value, bytes: memory.retainedBytes };
    const record: AccountingRecord = { ...memory, kind, reference: new WeakRef(entry), cleanup };
    this.records.add(record); this.accounting.set(entry, record);
    for (const field of MEMORY_FIELDS) {
      this.memory[field] += memory[field]; this.kinds[kind][field] += memory[field];
    }
    this.finalizer.register(entry, record, record);
    return entry;
  }
  drop(entry: CacheEntry<unknown> | undefined) {
    if (!entry) return;
    const record = this.accounting.get(entry);
    entry.value = undefined;
    this.accounting.delete(entry);
    if (record) this.releaseRecord(record, false);
  }
  private releaseRecord(record: AccountingRecord, collected: boolean) {
    if (!this.records.delete(record)) return;
    this.finalizer.unregister(record);
    const cleanup = record.cleanup; record.cleanup = undefined;
    for (const field of MEMORY_FIELDS) {
      this.memory[field] -= record[field]; this.kinds[record.kind][field] -= record[field];
    }
    this.releases++;
    if (collected) this.collected++;
    cleanup?.release();
  }
  clear() {
    for (const record of this.records) {
      const entry = record.reference.deref();
      if (entry) entry.value = undefined;
      this.releaseRecord(record, !entry);
    }
    this.accounting = new WeakMap();
  }
  stats(): CacheStats {
    // On demand only. Finalizers are eventual; a requested snapshot must exclude
    // entries already collected even if their metadata callback has not run yet.
    for (const record of this.records) if (!record.reference.deref()) this.releaseRecord(record, true);
    return { ...this.memory, hits: this.hits, misses: this.misses, builds: this.builds,
      releases: this.releases, collected: this.collected,
      byKind: Object.fromEntries(LAYOUT_KINDS.map(kind => [kind, { ...this.kinds[kind] }])) as Record<LayoutKind, LayoutMemory> };
  }
}
