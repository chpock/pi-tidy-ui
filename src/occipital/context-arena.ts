import { SemanticError, type Ink, type StyleExpression } from './semantic-codec.ts';
import { DataBudget, dataGrant, type DataCharge, type DataGrant } from './data-budget.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';

export interface ContextRef { readonly id: number }
export interface ContextLease {
  readonly batches: readonly (readonly ContextRef[])[];
  release(): void;
}
class Lease implements ContextLease {
  #batches: readonly (readonly ContextRef[])[];
  get batches(): readonly (readonly ContextRef[])[] { return this.#batches; }
  #release: (() => void) | undefined;
  constructor(batches: readonly (readonly ContextRef[])[], release: () => void) {
    this.#batches = batches; this.#release = release;
  }
  release(): void { const release = this.#release; this.#release = undefined; this.#batches = []; release?.(); }
}
type Reserve = (additionalPolicyBytes: number) => boolean;
type Entry = { key: string; vocabulary: string; ref: ContextRef; words: Uint32Array; users: number; bytes: number; keyBytes: number;
  charge: DataCharge; styles?: Map<string, StyleExpression>; styleCharges?: Map<string, DataCharge> };
const rowBytes = 128, wordBytes = 16, leaseBytes = 128, batchBytes = 32, referenceBytes = 8;
// Includes the immutable expression, rule key and association/Map allowance;
// equal expressions may share storage, but every association is funded.
const styleBytes = 512;
const stringBytes = (length: number) => 32 + 2 * length;

/** Worst-case owned namespace/key plus transient canonical-key construction. */
export function contextPeak(vocabulary: string, count: number, words: number): number {
  return bounded(count * (rowBytes + stringBytes(vocabulary.length) + 2 * stringBytes(vocabulary.length + 1))
    + words * (wordBytes + 44));
}
const invalid = (): never => { throw new SemanticError('invalid_context'); };
function bounded(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SemanticError('context_limit');
  return value;
}

/** Unbound client arena, keyed by validated vocabulary and ordered words. Namespace
 * storage lives only with actual entry leases, not a provider/namespace registry.
 * Input paths have already passed whole-reply validation. No source, theme or UI owner is retained.
 * Reservation is additional peak policy storage; callers reconcile actual retained
 * stats after adoption/release. Decoded input and encoded requests remain caller-owned. */
export class ContextArena {
  readonly budget: DataBudget;
  constructor(budget = new DataBudget(OCCIPITAL_LIMITS.retainedBytes)) { this.budget = budget; }
  #entries = new Map<string, Entry>();
  #handles = new WeakMap<ContextRef, Entry>();
  #next = 0;
  #contextsBytes = 0;
  #keyBytes = 0;
  #ownershipBytes = 0;
  #styleBytes = 0;
  #styles = 0;
  #styleInvalidationRevision = 0;
  /** Positive coverage witnesses must be rechecked after actual expression loss. */
  get styleInvalidationRevision(): number { return this.#styleInvalidationRevision; }
  #words = 0;
  #leases = 0;
  #allocatedWordBytes = 0;
  #closed = false;

  adopt(vocabulary: string, batches: readonly (readonly Uint32Array[])[], reserve: Reserve, prepaid?: DataGrant): ContextLease | undefined {
    this.#open();
    let count = 0, words = 0;
    for (const batch of batches) for (const path of batch) {
      count++;
      words = bounded(words + path.length);
    }
    const ownership = this.#leaseBytes(batches.length, count);
    // ID exhaustion is explicit, never an alias of a released context incarnation.
    if (this.#next + count > 0xffffffff) throw new SemanticError('context_limit');
    const grant = dataGrant(this.budget, bounded(contextPeak(vocabulary, count, words) + ownership), reserve, prepaid);
    if (!grant) return undefined;
    const acquired: ContextRef[] = [];
    try {
    this.#open();
    const mapped: ContextRef[][] = [];
    for (const batch of batches) {
      const refs: ContextRef[] = [];
      for (const path of batch) {
        const key = `${vocabulary}:${path.join(',')}`;
        let entry = this.#entries.get(key);
        if (!entry) {
          const keyBytes = stringBytes(vocabulary.length) + stringBytes(key.length), bytes = rowBytes + path.length * wordBytes + keyBytes;
          const charge = grant.consume(bytes);
          let words: Uint32Array, ref: ContextRef;
          try { words = path.slice(); ref = Object.freeze({ id: ++this.#next }); }
          catch (error) { charge.release(); throw error; }
          entry = { key, vocabulary, ref, words, users: 0, bytes, keyBytes, charge };
          this.#entries.set(key, entry);
          this.#handles.set(ref, entry);
          this.#contextsBytes += entry.bytes; this.#keyBytes += entry.keyBytes;
          this.#words += words.length;
          this.#allocatedWordBytes += words.byteLength;
        }
        entry.users++; acquired.push(entry.ref);
        refs.push(entry.ref);
      }
      mapped.push(refs);
    }
    return this.#lease(mapped, ownership, grant);
    } catch (error) { this.#drop(acquired); throw error; }
    finally { if (!prepaid) grant.close(); }
  }

  /** Pins preserve each handle's original namespace, independently of cards or
   * the connected provider. They confer no source-work or serialization authority. */
  retain(refs: readonly ContextRef[], reserve: Reserve): ContextLease | undefined {
    this.#open();
    for (const ref of refs) this.#entry(ref);
    const ownership = this.#leaseBytes(1, refs.length);
    const grant = dataGrant(this.budget, ownership, reserve);
    if (!grant) return undefined;
    const copy: ContextRef[] = [];
    try {
    this.#open(); for (const ref of refs) this.#entry(ref);
    for (const ref of refs) { this.#entry(ref).users++; copy.push(ref); }
    return this.#lease([copy], ownership, grant);
    } catch (error) { this.#drop(copy); throw error; }
    finally { grant.close(); }
  }

  /** Cold requests use their captured vocabulary, never a guessed current provider.
   * Every handle is checked before reserve/output. Paint/reflow never visits words. */
  encode(vocabulary: string, refs: readonly ContextRef[], reserve: Reserve, maxWords = Number.MAX_SAFE_INTEGER): number[][] | undefined {
    this.#open();
    if (!Number.isSafeInteger(maxWords) || maxWords < 0) throw new SemanticError('context_limit');
    let peak = 0, words = 0;
    for (const ref of refs) {
      const entry = this.#entry(ref, vocabulary);
      words += entry.words.length;
      if (words > maxWords) return undefined;
      peak = bounded(peak + rowBytes + (entry.words.length + 1) * wordBytes);
    }
    const grant = dataGrant(this.budget, peak, reserve);
    if (!grant) return undefined;
    try {
    this.#open(); for (const ref of refs) this.#entry(ref, vocabulary);
    const rows: number[][] = [];
    let previous: Uint32Array | undefined;
    for (const ref of refs) {
      const words = this.#entry(ref).words;
      let prefix = 0;
      while (prefix < words.length && previous && prefix < previous.length && words[prefix] === previous[prefix]) prefix++;
      const row = [prefix];
      for (let i = prefix; i < words.length; i++) row.push(words[i]!);
      rows.push(row);
      previous = words;
    }
    return rows;
    } finally { grant.close(); }
  }

  /** Already validated style replies use the same live contexts as source ranges.
   * Rule fingerprints contain neither Pi colors nor source/geometry identity.
   * Every handle must belong to the explicit job vocabulary, before any reserve.
   * References stay independently pinned through adoption; the root funds the
   * additional peak and reconciles retained stats afterward. */
  installStyles(vocabulary: string, rules: string, refs: readonly ContextRef[], expressions: readonly StyleExpression[], indices: Uint32Array,
    reserve: Reserve): boolean {
    this.#open();
    for (const ref of refs) this.#entry(ref, vocabulary);
    if (indices.length !== refs.length) throw new SemanticError('invalid_style');
    let missing = 0;
    for (let i = 0; i < refs.length; i++) {
      const old = this.#entry(refs[i]!).styles?.get(rules);
      if (!old) missing++;
      else if (!sameStyle(old, expressions[indices[i]! - 1]!)) throw new SemanticError('identity_mismatch');
    }
    if (!missing) return true;
    // Pressure cleanup in reserve may remove old hits while job pins preserve
    // descriptors. Bound the whole cold batch, not only its pre-cleanup misses.
    const grant = dataGrant(this.budget, bounded(refs.length * (styleBytes + rowBytes * 2)), reserve);
    if (!grant) return false;
    try {
    this.#open(); for (const ref of refs) this.#entry(ref, vocabulary);
    const pending = new Map<Entry, StyleExpression>(), copies = new Map<number, StyleExpression>();
    for (let i = 0; i < refs.length; i++) {
      const entry = this.#entry(refs[i]!);
      if (entry.styles?.has(rules)) continue;
      const id = indices[i]!, expression = expressions[id - 1]!, old = pending.get(entry);
      if (old && !sameStyle(old, expression)) throw new SemanticError('identity_mismatch');
      if (!old) {
        let copy = copies.get(id);
        if (!copy) { copy = copyStyle(expression); copies.set(id, copy); }
        pending.set(entry, copy);
      }
    }
    for (const [entry, expression] of pending) {
      const charge = grant.consume(styleBytes);
      (entry.styles ??= new Map()).set(rules, expression);
      (entry.styleCharges ??= new Map()).set(rules, charge);
      this.#styles++; this.#styleBytes += styleBytes;
    }
    return true;
    } finally { grant.close(); }
  }

  /** Borrowed immutable value, not a lease on descriptors or their owner. A caller
   * retaining it beyond this synchronous read funds its own presentation copy. */
  style(vocabulary: string, ref: ContextRef, rules: string): StyleExpression | undefined {
    return this.#entry(ref, vocabulary).styles?.get(rules);
  }

  /** Cold pressure/catalogue cleanup, never a render or source-work operation. */
  clearStyles(rules?: string): void {
    let changed = false;
    for (const entry of this.#entries.values()) {
      const styles = entry.styles;
      if (!styles) continue;
      const removed = rules === undefined ? styles.size : Number(styles.delete(rules));
      if (rules === undefined) { for (const charge of entry.styleCharges?.values() ?? []) charge.release(); entry.styleCharges = undefined; }
      else { entry.styleCharges?.get(rules)?.release(); entry.styleCharges?.delete(rules); }
      if (rules === undefined || styles.size === 0) entry.styles = undefined;
      this.#styles -= removed; this.#styleBytes -= removed * styleBytes; changed ||= removed > 0;
    }
    if (changed) this.#styleInvalidationRevision++;
  }

  stats() {
    return { contexts: this.#entries.size, words: this.#words, leases: this.#leases, styles: this.#styles, styleBytes: this.#styleBytes,
      retainedBytes: this.#contextsBytes + this.#ownershipBytes + this.#styleBytes, keyBytes: this.#keyBytes, allocatedWordBytes: this.#allocatedWordBytes };
  }

  dispose(): void {
    this.#closed = true; this.budget.close();
    this.clearStyles();
    // Descriptors and lease payloads remain funded until their actual last owner
    // releases; closing invalidates authority, not physical storage.
  }

  #open(): void { if (this.#closed) invalid(); }
  #entry(ref: ContextRef, vocabulary?: string): Entry {
    this.#open();
    const entry = this.#handles.get(ref) ?? invalid();
    if (vocabulary !== undefined && entry.vocabulary !== vocabulary) throw new SemanticError('identity_mismatch');
    return entry;
  }
  #leaseBytes(batches: number, refs: number): number { return bounded(leaseBytes + batches * batchBytes + refs * referenceBytes); }

  // Separate factory scope: a retained lease cannot capture the decoded input.
  #lease(batches: ContextRef[][], bytes: number, grant: DataGrant): ContextLease {
    for (const batch of batches) Object.freeze(batch);
    const frozen = Object.freeze(batches), charge = grant.consume(bytes);
    let lease: ContextLease;
    try {
      lease = Object.freeze(new Lease(frozen, () => {
        charge.release(); this.#leases--; this.#ownershipBytes -= bytes;
        for (const batch of frozen) this.#drop(batch);
      }));
    } catch (error) { charge.release(); throw error; }
    this.#leases++; this.#ownershipBytes += bytes;
    return lease;
  }
  #drop(refs: readonly ContextRef[]): void {
    for (const ref of refs) {
      const entry = this.#handles.get(ref)!;
      if (--entry.users === 0) {
        entry.charge.release();
        for (const charge of entry.styleCharges?.values() ?? []) charge.release();
        this.#handles.delete(ref); this.#entries.delete(entry.key);
        this.#contextsBytes -= entry.bytes; this.#keyBytes -= entry.keyBytes;
        const styles = entry.styles?.size ?? 0;
        this.#styles -= styles; this.#styleBytes -= styles * styleBytes;
        this.#words -= entry.words.length;
      }
    }
  }
}

function copyStyle(style: StyleExpression): StyleExpression {
  return Object.freeze({ foreground: Object.freeze({ ...style.foreground }), background: Object.freeze({ ...style.background }),
    attributes: style.attributes, attribute_mask: style.attribute_mask });
}
function sameStyle(a: StyleExpression, b: StyleExpression): boolean {
  return a.attributes === b.attributes && a.attribute_mask === b.attribute_mask
    && sameInk(a.foreground, b.foreground) && sameInk(a.background, b.background);
}
function sameInk(a: Ink, b: Ink): boolean {
  switch (a.kind) {
    case 'rgb': return b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b;
    case 'indexed': return b.kind === 'indexed' && a.index === b.index;
    case 'binding': return b.kind === 'binding' && a.slot === b.slot;
    default: return a.kind === b.kind;
  }
}
