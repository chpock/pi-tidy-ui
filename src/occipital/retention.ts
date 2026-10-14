import type { SourceChunk } from './protocol.ts';
import { RangeAccumulator } from './ranges.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';

// UTF16 and bookkeeping allowances are conservative policy units, not V8/RSS measurements.
export const RETENTION_LIMITS = Object.freeze({ maxBytes: OCCIPITAL_LIMITS.retainedBytes,
  entryAllowance: 1024, stringAllowance: 32, bridgeAllowance: 128, lineAllowance: 32,
  maxKeyUnits: 64, maxSourceUnits: OCCIPITAL_LIMITS.sourceBytes, maxGeneration: 0xffffffff });
const MAX_GENERATION = 0xffffffff;
type Snapshot = { version: number; text: string; utf8Bytes: number };
type Bridge = { version: number; bytes: number; lines: string[] };
type Entry = { key: string; generation: number; basis: Snapshot; latest?: Snapshot;
  ranges?: RangeAccumulator; bridge?: Bridge; chargedBytes: number };
export type ReleaseReceipt = { key: string; generation: number; reason: 'pressure' | 'replaced' | 'removed' | 'clear';
  retainedBytes: number; snapshotBytes: number; rangeBytes: number; bridgeBytes: number };
export type RetentionResult = { accepted: boolean; generation?: number; released: ReleaseReceipt[] };

/** One isolated logical-data pool. Generations are pool-issued protocol uint32s;
 * clear never rewinds them. Exhaustion requires a new pool/provider incarnation.
 * Returned records and visits contain only primitives, never owned arrays/state.
 * Caller-decoded chunks and all source scheduling/transport lifecycles stay outside. */
export class RetentionPool {
  #entries = new Map<number, Entry>();
  #keys = new Map<string, number>();
  #retainedBytes = 0;
  #maxBytes: number;
  #maxGeneration: number;
  #generation = 0;
  #rangeAllocatedBytes = 0;
  #bridgeLinesCopied = 0;

  constructor(limits: { maxBytes?: number; maxGeneration?: number } = {}) {
    this.#maxBytes = bounded(limits.maxBytes ?? RETENTION_LIMITS.maxBytes, RETENTION_LIMITS.maxBytes);
    this.#maxGeneration = bounded(limits.maxGeneration ?? MAX_GENERATION, MAX_GENERATION);
  }

  admit(key: string, sourceVersion: number, text: string): RetentionResult {
    if (typeof key !== 'string' || !key.length || key.length > RETENTION_LIMITS.maxKeyUnits) throw new Error('invalid retention key');
    validateSnapshot(sourceVersion, text);
    const required = metadataBytes(key) + stringBytes(text);
    if (required > this.#maxBytes || this.#generation === this.#maxGeneration) return refused();
    const released: ReleaseReceipt[] = [];
    const previousGeneration = this.#keys.get(key);
    if (previousGeneration !== undefined) released.push(this.#release(this.#entries.get(previousGeneration)!, 'replaced'));
    this.#makeRoom(undefined, required, released);
    const generation = ++this.#generation;
    // Primitive metadata allocation only after admission. No request/owner is retained.
    this.#entries.set(generation, { key, generation, basis: snapshot(sourceVersion, text), chargedBytes: required });
    this.#keys.set(key, generation);
    this.#retainedBytes += required;
    return { accepted: true, generation, released };
  }

  replaceSnapshot(generation: number, sourceVersion: number, text: string): RetentionResult {
    const entry = this.#entries.get(generation);
    if (!entry) return refused();
    validateSnapshot(sourceVersion, text);
    const current = entry.latest ?? entry.basis;
    if (sourceVersion < current.version || sourceVersion === current.version && text !== current.text) return refused();
    if (sourceVersion === current.version) { this.#touch(entry); return accepted(); }
    const snapshotBytes = snapshotsBytes(entry.basis.text, text);
    const bridge = entry.bridge && (entry.bridge.version === entry.basis.version || entry.bridge.version === sourceVersion)
      ? entry.bridge : undefined;
    const required = metadataBytes(entry.key) + snapshotBytes + (entry.ranges?.stats().retainedBytes ?? 0) + (bridge?.bytes ?? 0);
    const released: ReleaseReceipt[] = [];
    if (!this.#makeRoom(entry, required, released)) return { accepted: false, released };
    entry.latest = snapshot(sourceVersion, text, current);
    entry.bridge = bridge;
    this.#reaccount(entry);
    this.#touch(entry);
    return { accepted: true, released };
  }

  /** An absent dispatched version may transfer its caller-owned capture only
   * between the basis and newer waiting snapshot of this growing generation.
   * Prefix/size checks establish consistency, not authentication of decoded text.
   * The capture object and its transient reservation remain caller-owned. */
  installChunk(generation: number, chunk: SourceChunk, capture?: Readonly<{ version: number; text: string }>): RetentionResult {
    const entry = this.#entries.get(generation);
    if (!entry || chunk.key !== entry.key || chunk.generation !== generation) return refused();
    const source = findSnapshot(entry, chunk.source_version);
    let text: string;
    if (capture !== undefined) {
      const { version, text: capturedText } = capture;
      if (version !== chunk.source_version || !validSnapshot(version, capturedText)) return refused();
      if (source ? capturedText !== source.text
        : !entry.latest || version <= entry.basis.version || version >= entry.latest.version
          || !capturedText.startsWith(entry.basis.text) || !entry.latest.text.startsWith(capturedText)) return refused();
      text = capturedText;
    } else {
      if (!source) return refused();
      text = source.text;
    }
    // A new empty accumulator is transient planning state, not admitted result data.
    // requiredBytes performs the actual accumulator validation without copying ranges.
    const ranges = entry.ranges ?? new RangeAccumulator();
    let requiredRanges: number;
    try { requiredRanges = ranges.requiredBytes(chunk); }
    catch (error) {
      if (error instanceof Error && error.message === 'classification state mismatch') return refused();
      throw error;
    }
    const sourceBytes = source?.utf8Bytes ?? utf8Bytes(text, entry.basis);
    if (chunk.source_bytes !== sourceBytes) return refused();
    const latest = entry.latest && entry.latest.version > chunk.source_version ? entry.latest : undefined;
    const snapshotBytes = snapshotsBytes(text, latest?.text);
    const bridge = entry.bridge && (entry.bridge.version === chunk.source_version || entry.bridge.version === latest?.version)
      ? entry.bridge : undefined;
    const nonRanges = metadataBytes(entry.key) + snapshotBytes + (bridge?.bytes ?? 0);
    const released: ReleaseReceipt[] = [];
    if (!this.#makeRoom(entry, nonRanges + requiredRanges, released)) return { accepted: false, released };
    const otherBytes = this.#retainedBytes - entry.chargedBytes;
    const before = ranges.stats();
    if (!ranges.apply(chunk, this.#maxBytes - otherBytes - nonRanges)) {
      released.push(this.#release(entry, 'pressure'));
      return { accepted: false, released };
    }
    this.#rangeAllocatedBytes = Math.min(Number.MAX_SAFE_INTEGER,
      this.#rangeAllocatedBytes + ranges.stats().rangeBytes - (before.rangeBytes - before.tailBytes));
    entry.ranges = ranges;
    entry.basis = source ?? { version: chunk.source_version, text, utf8Bytes: sourceBytes };
    entry.latest = latest;
    entry.bridge = bridge;
    this.#reaccount(entry);
    this.#touch(entry);
    return { accepted: true, released };
  }

  installBridge(generation: number, sourceVersion: number, exactText: string, lines: readonly string[]): RetentionResult {
    const entry = this.#entries.get(generation);
    const source = entry && findSnapshot(entry, sourceVersion);
    if (!entry || !source || source.text !== exactText) return refused();
    if (!Array.isArray(lines)) throw new Error('invalid retention bridge');
    const otherBytes = metadataBytes(entry.key) + snapshotsBytes(entry.basis.text, entry.latest?.text)
      + (entry.ranges?.stats().retainedBytes ?? 0);
    const released: ReleaseReceipt[] = [];
    let bytes = RETENTION_LIMITS.bridgeAllowance + lines.length * (RETENTION_LIMITS.lineAllowance + RETENTION_LIMITS.stringAllowance);
    if (otherBytes + bytes > this.#maxBytes) {
      this.#makeRoom(entry, otherBytes + bytes, released);
      return { accepted: false, released };
    }
    for (const line of lines) {
      if (typeof line !== 'string') throw new Error('invalid retention bridge');
      bytes += line.length * 2;
      if (otherBytes + bytes > this.#maxBytes) {
        this.#makeRoom(entry, otherBytes + bytes, released);
        return { accepted: false, released };
      }
    }
    if (!this.#makeRoom(entry, otherBytes + bytes, released)) return { accepted: false, released };
    entry.bridge = { version: sourceVersion, bytes, lines: lines.slice() };
    this.#reaccount(entry);
    this.#bridgeLinesCopied = Math.min(Number.MAX_SAFE_INTEGER, this.#bridgeLinesCopied + lines.length);
    this.#touch(entry);
    return { accepted: true, released };
  }

  /** Fresh primitive view with the pool's cached byte length. The caller must
   * account any string capture it keeps beyond this synchronous visit. */
  borrowSnapshot(generation: number, kind: 'basis' | 'latest' = 'latest'): Readonly<Snapshot> | undefined {
    const entry = this.#entries.get(generation);
    if (!entry) return undefined;
    this.#touch(entry);
    const source = kind === 'basis' ? entry.basis : entry.latest ?? entry.basis;
    return { version: source.version, text: source.text, utf8Bytes: source.utf8Bytes };
  }

  /** Work retirement releases a waiting target but leaves its already charged basis. */
  retainBasis(generation: number): void {
    const entry = this.#entries.get(generation);
    if (!entry) return;
    entry.latest = undefined;
    if (entry.bridge?.version !== entry.basis.version) entry.bridge = undefined;
    this.#reaccount(entry);
  }

  visitSnapshots(generation: number, consume: (kind: 'basis' | 'latest', version: number, text: string) => void): boolean {
    const entry = this.#entries.get(generation);
    if (!entry) return false;
    this.#touch(entry);
    consume('basis', entry.basis.version, entry.basis.text);
    if (this.#entries.get(generation) === entry && entry.latest) consume('latest', entry.latest.version, entry.latest.text);
    return true;
  }

  visitRanges(generation: number, consume: (start: number, end: number, packedStyle: number) => void): boolean {
    const entry = this.#entries.get(generation);
    if (!entry?.ranges) return false;
    this.#touch(entry);
    entry.ranges.visit((start, end, style) => {
      if (this.#entries.get(generation) === entry) consume(start, end, style);
    });
    return true;
  }

  visitBridge(generation: number, consume: (index: number, line: string) => void): boolean {
    const entry = this.#entries.get(generation);
    if (!entry?.bridge) return false;
    this.#touch(entry);
    for (let i = 0; this.#entries.get(generation) === entry && entry.bridge && i < entry.bridge.lines.length; i++) {
      consume(i, entry.bridge.lines[i]!);
    }
    return true;
  }

  /** Primitive readiness only: no accounting, source comparison or row walk.
   * A useful lookup still touches the same real pool LRU. */
  bridgeVersion(generation: number): number | undefined {
    const entry = this.#entries.get(generation);
    if (!entry) return undefined;
    this.#touch(entry); return entry.bridge?.version;
  }

  status(generation: number) {
    const entry = this.#entries.get(generation);
    if (!entry) return undefined;
    this.#touch(entry);
    const ranges = entry.ranges?.stats();
    return { key: entry.key, generation, ...account(entry), basisVersion: entry.basis.version,
       latestVersion: entry.latest?.version, revision: ranges?.revision ?? 0, displayRevision: ranges?.displayRevision ?? 0,
      sourceVersion: ranges?.sourceVersion, sourceBytes: ranges?.sourceBytes ?? 0,
      committedBytes: ranges?.committedBytes ?? 0, complete: ranges?.complete ?? false,
      committedChunks: ranges?.committedChunks ?? 0, bridgeVersion: entry.bridge?.version };
  }

  stats() {
    let snapshotBytes = 0, rangeBytes = 0, bridgeBytes = 0, prefixCopiedBytes = 0;
    for (const entry of this.#entries.values()) {
      const bytes = account(entry);
      snapshotBytes += bytes.snapshotBytes;
      rangeBytes += bytes.rangeBytes; bridgeBytes += bytes.bridgeBytes;
      prefixCopiedBytes += entry.ranges?.stats().prefixCopiedBytes ?? 0;
    }
    return { entries: this.#entries.size, retainedBytes: this.#retainedBytes, snapshotBytes, rangeBytes, bridgeBytes, prefixCopiedBytes,
      rangeAllocatedBytes: this.#rangeAllocatedBytes, bridgeLinesCopied: this.#bridgeLinesCopied,
      lastGeneration: this.#generation, maxBytes: this.#maxBytes };
  }

  remove(generation: number): ReleaseReceipt[] {
    const entry = this.#entries.get(generation);
    return entry ? [this.#release(entry, 'removed')] : [];
  }

  clear(): ReleaseReceipt[] {
    const released: ReleaseReceipt[] = [];
    for (const entry of this.#entries.values()) released.push(this.#release(entry, 'clear'));
    return released;
  }

  #touch(entry: Entry): void {
    this.#entries.delete(entry.generation);
    this.#entries.set(entry.generation, entry);
  }

  #reaccount(entry: Entry): void {
    const bytes = account(entry).retainedBytes;
    this.#retainedBytes += bytes - entry.chargedBytes;
    entry.chargedBytes = bytes;
  }

  #makeRoom(entry: Entry | undefined, required: number, released: ReleaseReceipt[]): boolean {
    if (required > this.#maxBytes) {
      if (entry) released.push(this.#release(entry, 'pressure'));
      return false;
    }
    let used = this.#retainedBytes - (entry?.chargedBytes ?? 0);
    if (used + required <= this.#maxBytes) return true;
    for (const other of this.#entries.values()) {
      if (used + required <= this.#maxBytes) break;
      if (other === entry) continue;
      const receipt = this.#release(other, 'pressure');
      used -= receipt.retainedBytes;
      released.push(receipt);
    }
    return true;
  }

  #release(entry: Entry, reason: ReleaseReceipt['reason']): ReleaseReceipt {
    const receipt = { key: entry.key, generation: entry.generation, reason, ...account(entry) };
    entry.ranges?.invalidate();
    entry.ranges = undefined; entry.bridge = undefined; entry.latest = undefined;
    entry.basis = { version: 0, text: '', utf8Bytes: 0 };
    this.#entries.delete(entry.generation);
    this.#keys.delete(entry.key);
    this.#retainedBytes -= entry.chargedBytes;
    return receipt;
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('invalid retention limit');
  return value;
}
function validSnapshot(version: number, text: string): boolean {
  return Number.isInteger(version) && version >= 0 && version <= MAX_GENERATION && typeof text === 'string'
    && text.length <= RETENTION_LIMITS.maxSourceUnits;
}
function validateSnapshot(version: number, text: string): void {
  if (!validSnapshot(version, text)) throw new Error('invalid retention snapshot');
}
function snapshot(version: number, text: string, previous?: Snapshot): Snapshot {
  return { version, text, utf8Bytes: utf8Bytes(text, previous) };
}
function utf8Bytes(text: string, previous?: Snapshot): number {
  if (!previous || !text.startsWith(previous.text)) return Buffer.byteLength(text);
  if (text === previous.text) return previous.utf8Bytes;
  let from = previous.text.length, bytes = previous.utf8Bytes;
  const last = previous.text.charCodeAt(from - 1), next = text.charCodeAt(from);
  // A former lone high surrogate was counted as U+FFFD (3 bytes). Re-measure
  // only that boundary unit plus its new low surrogate, not the whole prefix.
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { from--; bytes -= 3; }
  return bytes + Buffer.byteLength(text.slice(from));
}
function stringBytes(text: string): number { return RETENTION_LIMITS.stringAllowance + text.length * 2; }
function metadataBytes(key: string): number { return RETENTION_LIMITS.entryAllowance + stringBytes(key); }
function snapshotsBytes(basis: string, latest?: string): number {
  return stringBytes(basis) + (latest !== undefined && latest !== basis ? stringBytes(latest) : 0);
}
function findSnapshot(entry: Entry, version: number): Snapshot | undefined {
  return entry.latest?.version === version ? entry.latest : entry.basis.version === version ? entry.basis : undefined;
}
function account(entry: Entry) {
  const snapshotBytes = snapshotsBytes(entry.basis.text, entry.latest?.text);
  const rangeBytes = entry.ranges?.stats().retainedBytes ?? 0, bridgeBytes = entry.bridge?.bytes ?? 0;
  return { retainedBytes: metadataBytes(entry.key) + snapshotBytes + rangeBytes + bridgeBytes, snapshotBytes, rangeBytes, bridgeBytes };
}
function accepted(): RetentionResult { return { accepted: true, released: [] }; }
function refused(): RetentionResult { return { accepted: false, released: [] }; }
