import { ContextArena, contextPeak, type ContextLease, type ContextRef } from './context-arena.ts';
import { SemanticError } from './semantic-codec.ts';
import type { SemanticChunk } from './semantic-source.ts';
import { dataGrant, type DataCharge, type DataGrant } from './data-budget.ts';

type Reserve = (additionalPeakPolicyBytes: number) => boolean;
type Identity = Pick<SemanticChunk, 'key' | 'generation' | 'lease' | 'vocabulary'>;
type Block = { start: number; runs: Uint32Array; refs: readonly ContextRef[]; lease: ContextLease | undefined;
  prefixBytes: number; holders: number; charge: DataCharge };
type ContextIndex = { header: DataCharge; usage: Map<ContextRef, { count: number; position: number; charge: DataCharge }>; keys: ContextRef[] };
type PrefixStore = { contexts: ContextIndex | undefined; vocabulary: string; blocks: Block[]; prefixBytes: number; tailBytes: number; tails: number;
  tail: Block | undefined; active: boolean; views: Set<RangeView>; charge: DataCharge; readers: number; deferred: Block[] };
const recordBytes = 512, blockBytes = 256, storeBytes = 256, viewBytes = 256;
const indexHeaderBytes = 160, indexEntryBytes = 128, dictionarySetBytes = 128, dictionaryRefBytes = 64;
const indexBytes = (index?: ContextIndex) => index ? indexHeaderBytes + index.usage.size * indexEntryBytes : 0;
const vocabularyBytes = (vocabulary: string) => 32 + 2 * vocabulary.length;
const prepaid = () => true;
const emptyRefs: readonly ContextRef[] = Object.freeze([]);
const invalid = (): never => { throw new SemanticError('invalid_source'); };

/** Root-owned capture with vocabulary provenance even for neutral/empty coverage;
 * never a strong UI reader or parser-work authority. */
export type SemanticRangeView = RangeView;

/** Owns semantic ranges, never colors, parser state, text or a UI owner. The root
 * retention pool funds the additional old/new peak, then reconciles range stats
 * and the shared arena separately. Failed adoption preserves the historical basis;
 * skipping a confirmed revision never permits continuing from a later suffix. */
export class SemanticRanges {
  #arena: ContextArena | undefined;
  #record: DataCharge | undefined;
  #identity: Identity | undefined;
  #store: PrefixStore | undefined;
  #version = 0;
  #revision = 0;
  #displayRevision = 0;
  #sourceBytes = 0;
  #committedBytes = 0;
  #complete = false;
  #closed = false;

  constructor(arena: ContextArena) { this.#arena = arena; }

  apply(chunk: SemanticChunk, reserve: Reserve, prepaidGrant?: DataGrant): boolean {
    const identity = this.#identity;
    if (this.#closed || this.#complete || chunk.revision !== this.#revision + 1 || chunk.source_version < this.#version
      || chunk.source_bytes < this.#sourceBytes || chunk.replace_from !== this.#committedBytes
      || identity && (identity.key !== chunk.key || identity.generation !== chunk.generation || identity.lease !== chunk.lease || identity.vocabulary !== chunk.vocabulary)) invalid();
    const from = chunk.replace_from, to = chunk.committed_bytes, end = chunk.source_bytes;
    const committedLength = clippedLength(chunk.runs, from, to), tailLength = clippedLength(chunk.runs, to, end);
    let words = 0;
    for (const context of chunk.contexts) words += context.length;
    const committedRefs = Math.min(committedLength / 2, chunk.contexts.length), tailRefs = Math.min(tailLength / 2, chunk.contexts.length);
    const oldTailRefs = this.#store?.tail?.refs.length ?? 0;
    const indexPeak = (identity ? 0 : indexHeaderBytes) + (committedRefs + tailRefs) * indexEntryBytes
      + dictionaryPeak(committedRefs) + dictionaryPeak(tailRefs) + dictionaryPeak(oldTailRefs);
    const peak = indexPeak + (identity ? 0 : recordBytes + storeBytes + vocabularyBytes(chunk.vocabulary))
      + windowPeak(committedLength, chunk.contexts.length, words, chunk.vocabulary) + windowPeak(tailLength, chunk.contexts.length, words, chunk.vocabulary);
    if (!Number.isSafeInteger(peak)) throw new SemanticError('context_limit');
    // This peak is additional to every still-owned display block, including old tails.
    const arena = this.#arena!, grant = dataGrant(arena.budget, peak, reserve, prepaidGrant);
    if (!grant) return false;
    try {
    if (this.#closed || this.#identity !== identity || chunk.revision !== this.#revision + 1) invalid();
    let committed: Block | undefined, tail: Block | undefined;
    try {
      committed = this.#build(chunk, from, to, committedLength, grant);
      tail = this.#build(chunk, to, end, tailLength, grant);
    } catch (error) {
      if (committed) releaseBlock(committed);
      if (tail) releaseBlock(tail);
      throw error;
    }
    if (!this.#store) this.#record = grant.consume(recordBytes);
    const store: PrefixStore = this.#store ??= { contexts: { usage: new Map(), keys: [], header: grant.consume(indexHeaderBytes) },
      vocabulary: chunk.vocabulary, blocks: [], prefixBytes: 0, tailBytes: 0, tails: 0,
      tail: undefined, active: true, views: new Set(), charge: grant.consume(storeBytes + vocabularyBytes(chunk.vocabulary)), readers: 0, deferred: [] };
    const changed = !identity || end !== this.#sourceBytes || !sameSuffix(store.tail, committed, tail, from, end);
    // Add first so a context moving out of the old tail keeps its index slot.
    if (committed) changeContexts(store.contexts!, committed.refs, 1, grant);
    if (tail) changeContexts(store.contexts!, tail.refs, 1, grant);
    if (store.tail) { changeContexts(store.contexts!, store.tail.refs, -1); releaseTail(store, store.tail); }
    if (committed) {
      store.prefixBytes += committed.runs.byteLength;
      committed.prefixBytes = store.prefixBytes;
      store.blocks.push(committed);
    }
    store.tail = tail;
    if (tail) { store.tailBytes += tail.runs.byteLength; store.tails++; }
    this.#identity ??= { key: chunk.key, generation: chunk.generation, lease: chunk.lease, vocabulary: chunk.vocabulary };
    this.#version = chunk.source_version;
    this.#revision = chunk.revision;
    this.#sourceBytes = end;
    this.#committedBytes = to;
    this.#complete = chunk.complete;
    if (changed) this.#displayRevision++;
    return true;
    } finally { if (!prepaidGrant) grant.close(); }
  }

  /** Root-ready or transient physical style-job capture. The caller separately
   * funds text, metadata and full post-removal liability, not just this view header. */
  captureView(reserve: Reserve, prepaid?: DataGrant): SemanticRangeView | undefined {
    const store = this.#store, arena = this.#arena;
    if (!store || !arena) return undefined;
    const grant = dataGrant(arena.budget, viewBytes, reserve, prepaid);
    if (!grant) return undefined;
    try {
      if (this.#store !== store) return undefined;
      return new RangeView(store, this.#revision, this.#displayRevision, this.#version,
        this.#sourceBytes, this.#committedBytes, this.#complete, grant.consume(viewBytes));
    } finally { if (!prepaid) grant.close(); }
  }

  /** Visits primitive offsets and opaque context handles, not scope descriptors. */
  visit(consume: (start: number, end: number, ref: ContextRef | undefined) => void): void {
    const store = this.#store, revision = this.#revision;
    if (!store) return;
    const alive = () => this.#store === store && this.#revision === revision;
    store.readers++;
    try {
      for (let i = 0; alive() && i < store.blocks.length; i++) visitBlock(store.blocks[i]!, consume, alive);
      if (alive() && store.tail) visitBlock(store.tail, consume, alive);
    } finally { endRead(store); }
  }

  /** Provisional unique CURRENT positive demand, with no ordering contract. A
   * helper returns one detached handle before consume; no index/iterator is held. */
  visitContexts(consume: (ref: ContextRef) => void): boolean {
    const revision = this.#revision;
    if (!revision || !this.#store) return false;
    for (let i = 0; ; i++) {
      if (this.#revision !== revision || !this.#store) return false;
      const ref = this.#contextAt(i);
      if (!ref) return true;
      consume(ref);
    }
  }
  #contextAt(index: number): ContextRef | undefined { return this.#store?.contexts?.keys[index]; }

  /** Source-progress accounting only; captured display ownership is counted below. */
  stats() {
    const store = this.#store, tailBytes = store?.tail?.runs.byteLength ?? 0, prefixBytes = store?.prefixBytes ?? 0;
    return { retainedBytes: store ? recordBytes + storeBytes + vocabularyBytes(store.vocabulary) + indexBytes(store.contexts) + (store.blocks.length + (store.tail ? 1 : 0)) * blockBytes + prefixBytes + tailBytes : 0,
      contextIndexBytes: indexBytes(store?.contexts), currentContexts: store?.contexts?.usage.size ?? 0,
      rangeBytes: prefixBytes + tailBytes, committedChunks: store?.blocks.length ?? 0, tailBytes, prefixCopiedBytes: 0,
      vocabulary: this.#identity?.vocabulary, revision: this.#revision, displayRevision: this.#displayRevision, sourceVersion: this.#version,
      sourceBytes: this.#sourceBytes, committedBytes: this.#committedBytes, complete: this.#complete };
  }

  /** Physical union of the current store and root-owned views, including retired
   * incarnations. Shared blocks/tails are counted once; context leases remain in
   * arena accounting. Cost depends on supplied views/stores, never prefix length. */
  static ownershipStats(current?: SemanticRanges, views: readonly SemanticRangeView[] = []) {
    return RangeView.ownership(current ? current.#store : undefined, views);
  }

  dispose(): void {
    const store = this.#store;
    this.#store = undefined;
    if (store) {
      store.active = false;
      for (const entry of store.contexts?.usage.values() ?? []) entry.charge.release();
      store.contexts?.header.release();
      store.contexts?.usage.clear();
      if (store.contexts) store.contexts.keys.length = 0;
      store.contexts = undefined;
      if (store.tail) releaseTail(store, store.tail);
      store.tail = undefined;
      trimPrefix(store);
    }
    this.#record?.release(); this.#record = undefined;
    this.#identity = undefined;
    this.#version = this.#revision = this.#displayRevision = this.#sourceBytes = this.#committedBytes = 0;
    this.#complete = false; this.#closed = true; this.#arena = undefined;
  }

  #build(chunk: SemanticChunk, from: number, to: number, length: number, grant: DataGrant): Block | undefined {
    if (!length) return undefined;
    const runs = new Uint32Array(length), contexts: Uint32Array[] = [], indices = new Map<number, number>();
    let start = chunk.replace_from, next = 0;
    for (let i = 0; i < chunk.runs.length; i += 2) {
      const end = chunk.runs[i]!, sourceID = chunk.runs[i + 1]!;
      if (end > from && start < to) {
        let index = 0;
        if (sourceID !== 0) {
          index = indices.get(sourceID) ?? 0;
          if (!index) {
            contexts.push(chunk.contexts[sourceID - 1]!);
            index = contexts.length; indices.set(sourceID, index);
          }
        }
        runs[next++] = Math.min(end, to); runs[next++] = index;
      }
      start = end;
      if (end >= to) break;
    }
    // The outer peak funds this window's temporary plan, owned range, context
    // vectors and independent lease before either window is published.
    const arena = this.#arena!;
    const lease = contexts.length ? arena.adopt(chunk.vocabulary, [contexts], prepaid, grant)! : undefined;
    return { start: from, runs, refs: lease?.batches[0] ?? emptyRefs, lease, prefixBytes: 0, holders: 1,
      charge: grant.consume(blockBytes + runs.byteLength) };
  }
}

class RangeView {
  #store: PrefixStore | undefined;
  #tail: Block | undefined;
  #charge: DataCharge | undefined;
  readonly vocabulary: string;
  readonly committedChunks: number;
  readonly revision: number;
  readonly displayRevision: number;
  readonly sourceVersion: number;
  readonly sourceBytes: number;
  readonly committedBytes: number;
  readonly complete: boolean;

  constructor(store: PrefixStore, revision: number, displayRevision: number, sourceVersion: number,
    sourceBytes: number, committedBytes: number, complete: boolean, charge: DataCharge, basis?: RangeView) {
    this.#charge = charge;
    this.#store = store; this.#tail = basis ? basis.#tail : store.tail;
    this.vocabulary = store.vocabulary; this.committedChunks = basis ? basis.committedChunks : store.blocks.length;
    this.revision = revision; this.displayRevision = displayRevision; this.sourceVersion = sourceVersion;
    this.sourceBytes = sourceBytes; this.committedBytes = committedBytes; this.complete = complete;
    store.views.add(this);
    if (this.#tail) this.#tail.holders++;
    Object.freeze(this);
  }

  visit(consume: (start: number, end: number, ref: ContextRef | undefined) => void): void {
    const store = this.#store;
    if (!store) return;
    const alive = () => this.#store === store;
    store.readers++;
    try {
      for (let i = 0; alive() && i < this.committedChunks; i++) visitBlock(store.blocks[i]!, consume, alive);
      if (alive() && this.#tail) visitBlock(this.#tail, consume, alive);
    } finally { endRead(store); }
  }

  /** Duplicate this exact frozen coverage, never the store's later prefix/tail.
   * Only header ownership changes; no range/dictionary traversal or copying. */
  retain(reserve: Reserve, prepaid?: DataGrant): SemanticRangeView | undefined {
    const store = this.#store, charge = this.#charge;
    if (!store || !charge) return undefined;
    const grant = dataGrant(charge.budget, viewBytes, reserve, prepaid);
    if (!grant) return undefined;
    try {
      if (this.#store !== store) return undefined;
      return new RangeView(store, this.revision, this.displayRevision, this.sourceVersion,
        this.sourceBytes, this.committedBytes, this.complete, grant.consume(viewBytes), this);
    } finally { if (!prepaid) grant.close(); }
  }

  release(): void {
    const store = this.#store, tail = this.#tail;
    this.#store = undefined; this.#tail = undefined;
    this.#charge?.release(); this.#charge = undefined;
    if (!store) return;
    store.views.delete(this);
    if (tail) releaseTail(store, tail);
    if (!store.active) trimPrefix(store);
  }

  static ownership(current: PrefixStore | undefined, views: readonly SemanticRangeView[]) {
    const stores = new Set<PrefixStore>();
    if (current) stores.add(current);
    for (const view of views) if (view.#store) stores.add(view.#store);
    let retainedBytes = 0, rangeBytes = 0, displayOnlyRangeBytes = 0, prefixBytes = 0, committedChunks = 0, viewCount = 0, retainedTails = 0;
    for (const store of stores) {
      const bytes = store.prefixBytes + store.tailBytes;
      rangeBytes += bytes; prefixBytes += store.prefixBytes;
      committedChunks += store.blocks.length; viewCount += store.views.size; retainedTails += store.tails;
      displayOnlyRangeBytes += (store.active ? 0 : store.prefixBytes) + store.tailBytes - (store.tail?.runs.byteLength ?? 0);
      retainedBytes += indexBytes(store.contexts) + storeBytes + vocabularyBytes(store.vocabulary) + (store.active ? recordBytes : 0) + (store.blocks.length + store.tails) * blockBytes + bytes + store.views.size * viewBytes;
    }
    return { retainedBytes, rangeBytes, displayOnlyRangeBytes, prefixBytes, committedChunks,
      stores: stores.size, views: viewCount, retainedTails, prefixCopiedBytes: 0 };
  }
}

function dictionaryPeak(refs: number): number { return refs ? dictionarySetBytes + refs * dictionaryRefBytes : 0; }
function changeContexts(index: ContextIndex, refs: readonly ContextRef[], delta: 1 | -1, grant?: DataGrant): void {
  if (!refs.length) return;
  // Reply-local IDs may alias the same opaque context. Count each block once.
  const unique = new Set(refs);
  for (const ref of unique) {
    const entry = index.usage.get(ref);
    if (delta === 1) {
      if (entry) entry.count++;
      else { index.usage.set(ref, { count: 1, position: index.keys.length, charge: grant!.consume(indexEntryBytes) }); index.keys.push(ref); }
    } else if (--entry!.count === 0) {
      // Demand order is not chronological display order; keep deletion O(1).
      const last = index.keys.pop()!;
      if (last !== ref) { index.keys[entry!.position] = last; index.usage.get(last)!.position = entry!.position; }
      index.usage.delete(ref); entry!.charge.release();
    }
  }
}

function releaseBlock(block: Block): void {
  block.lease?.release(); block.lease = undefined; block.refs = emptyRefs; block.charge.release();
}
function releaseTail(store: PrefixStore, tail: Block): void {
  if (--tail.holders) return;
  if (store.readers) { store.deferred.push(tail); return; }
  store.tailBytes -= tail.runs.byteLength; store.tails--;
  releaseBlock(tail);
}
function trimPrefix(store: PrefixStore): void {
  if (store.readers) return;
  let count = 0;
  for (const view of store.views) count = Math.max(count, view.committedChunks);
  for (let i = count; i < store.blocks.length; i++) releaseBlock(store.blocks[i]!);
  store.blocks.length = count;
  store.prefixBytes = count ? store.blocks[count - 1]!.prefixBytes : 0;
  if (!store.active && !store.views.size && !store.tails) store.charge.release();
}
function endRead(store: PrefixStore): void {
  if (--store.readers) return;
  for (const tail of store.deferred) {
    store.tailBytes -= tail.runs.byteLength; store.tails--; releaseBlock(tail);
  }
  store.deferred.length = 0;
  if (!store.active) trimPrefix(store);
}
function windowPeak(length: number, contexts: number, words: number, vocabulary: string): number {
  if (!length) return 0;
  const refs = Math.min(length / 2, contexts);
  // Includes transient mapping/path metadata, the arena's worst-case context
  // copies/canonical keys, and its independent lease. Shared words cost no extra
  // retained bytes; the caller releases unused peak after reconciliation.
  return blockBytes + length * 4 + refs * 64 + contextPeak(vocabulary, contexts, words) + 160 + refs * 8;
}
function clippedLength(runs: Uint32Array, from: number, to: number): number {
  if (from === to) return 0;
  let start = from, count = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const end = runs[i]!;
    if (end > from && start < to) count += 2;
    start = end;
    if (end >= to) break;
  }
  return count;
}
function visitBlock(block: Block, consume: (start: number, end: number, ref: ContextRef | undefined) => void, alive: () => boolean): void {
  let start = block.start;
  for (let i = 0; alive() && i < block.runs.length; i += 2) {
    const end = block.runs[i]!, id = block.runs[i + 1]!;
    consume(start, end, id === 0 ? undefined : block.refs[id - 1]);
    start = end;
  }
}
// Compare only the acknowledged provisional suffix. No committed block is visited.
function sameSuffix(old: Block | undefined, committed: Block | undefined, tail: Block | undefined, from: number, to: number): boolean {
  let oldIndex = 0, nextIndex = 0, position = from, next = committed ?? tail;
  while (position < to) {
    if (!old || !next) return false;
    const left = old.runs[oldIndex + 1]!, right = next.runs[nextIndex + 1]!;
    if ((left === 0 ? undefined : old.refs[left - 1]) !== (right === 0 ? undefined : next.refs[right - 1])) return false;
    const end = Math.min(old.runs[oldIndex]!, next.runs[nextIndex]!);
    if (end <= position || !Number.isFinite(end)) return false;
    position = end;
    if (old.runs[oldIndex] === end) oldIndex += 2;
    if (next.runs[nextIndex] === end) nextIndex += 2;
    if (nextIndex === next.runs.length) { next = next === committed ? tail : undefined; nextIndex = 0; }
  }
  return true;
}
