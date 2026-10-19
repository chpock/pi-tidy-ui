import type { PiProjectionPayload, StagedPiProjection } from './pi-projection.ts';
import { ContextArena, type ContextRef } from './context-arena.ts';
import { SemanticError } from './semantic-codec.ts';
import { SemanticRanges, type SemanticRangeView } from './semantic-ranges.ts';
import type { CardRole } from './semantic-codec.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';
import { completeRoles, copyPresentation, equalPresentation, presentationPeak, type OwnedPresentation, type ReadyPresentation } from './ready-presentation.ts';
export type { ReadyPresentation } from './ready-presentation.ts';
import type { SemanticChunk } from './semantic-source.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';
import { DataBudget, type DataCharge } from './data-budget.ts';
import { AccountedSnapshot, SemanticCapture, SemanticCaptureGroup } from './semantic-capture.ts';
export type { SemanticCapture, SemanticCaptureGroup } from './semantic-capture.ts';

type Snapshot = AccountedSnapshot;
type SnapshotData = Readonly<{ version: number; text: string; utf8Bytes: number }>;
type Bridge = { version: number; revision: number; payload: PiProjectionPayload; bytes: number; charge: DataCharge };

/** Explicit charged source pin. Contains data and a payload-free authority token,
 * never the root/controller. release() is required even after root retirement. */
export class PiPreparation {
  readonly generation: number; readonly version: number; readonly palette: number; readonly budget: DataBudget;
  readonly #owner: object; #snapshot?: Snapshot; #charge?: DataCharge;
  constructor(owner: object, generation: number, palette: number, source: Snapshot, charge: DataCharge) {
    this.#owner = owner; this.generation = generation; this.version = source.version; this.palette = palette;
    this.budget = charge.budget; this.#snapshot = source; this.#charge = charge; Object.freeze(this);
  }
  get text(): string | undefined { return this.#snapshot?.text; }
  get sourceBytes(): number | undefined { return this.#snapshot?.utf8Bytes; }
  release(): void { this.#snapshot?.release(); this.#snapshot = undefined; this.#charge?.release(); this.#charge = undefined; }
  static read(value: PiPreparation, owner: object): Snapshot | undefined {
    return value instanceof PiPreparation && #owner in value && value.#owner === owner ? value.#snapshot : undefined;
  }
}
type Account = { retainedBytes: number; snapshotBytes: number; rangeBytes: number; bridgeBytes: number; displayBytes: number;
  rangeRunBytes: number; displayOnlyRangeBytes: number; rangeStores: number; rangeViews: number; retainedTails: number; rangeBlocks: number; contextIndexBytes: number; currentContexts: number };
type Display = { charge: DataCharge; token: object; view: SemanticRangeView; snapshot: Snapshot; semanticStamp: number; geometryStamp: number; effectStamp: number;
  rules: string; palette: string; bindingRevision: number; colors: OwnedPresentation };
export interface ReadyDisplayCandidate { readonly semanticStamp: number; readonly sourceVersion: number; readonly presentation: ReadyPresentation; readonly capture?: SemanticCapture }
export interface ReadyDisplayUpdate { readonly generation: number; readonly candidate: ReadyDisplayCandidate }
export type CaptureSelection = number | Readonly<{ generation: number; effectStamp: number }>;
type DisplayPlan = { entry: Entry; old?: Display; newView?: SemanticRangeView; next?: Display };
const displayPlanBytes = 512;
const accountFields = ['retainedBytes', 'snapshotBytes', 'rangeBytes', 'bridgeBytes', 'displayBytes', 'rangeRunBytes',
  'displayOnlyRangeBytes', 'rangeStores', 'rangeViews', 'retainedTails', 'rangeBlocks', 'contextIndexBytes', 'currentContexts'] as const;
const zeroAccount = (): Account => ({ retainedBytes: 0, snapshotBytes: 0, rangeBytes: 0, bridgeBytes: 0, displayBytes: 0,
  rangeRunBytes: 0, displayOnlyRangeBytes: 0, rangeStores: 0, rangeViews: 0, retainedTails: 0, rangeBlocks: 0, contextIndexBytes: 0, currentContexts: 0 });
type Entry = { key: string; generation: number; charge: DataCharge; basis: Snapshot | undefined; latest?: Snapshot; ranges?: SemanticRanges;
  bridge?: Bridge; display?: Display; capturePosition?: number; fundingPins?: number; charged: Account; semanticStamp: number; geometryStamp: number; effectStamp: number };
export type SemanticRelease = Account & { attributedBytes: number; key: string; generation: number; reason: 'pressure' | 'replaced' | 'removed' | 'clear' };
export type SemanticAdmission = { accepted: boolean; generation?: number; released: SemanticRelease[] };
const uint32 = 0xffffffff, entryBytes = 1024, stringHeader = 32, bridgeHeader = 128;
const refused = (): SemanticAdmission => ({ accepted: false, released: [] });
const accepted = (): SemanticAdmission => ({ accepted: true, released: [] });
const stringBytes = (text: string) => stringHeader + 2 * text.length;
const metadataBytes = (key: string) => entryBytes + stringBytes(key);
const snapshotsBytes = (basis: Snapshot, latest?: Snapshot, display?: Snapshot) => basis.record.bytes + basis.textCharge.bytes
  + (latest && latest !== basis ? latest.record.bytes : 0)
  + (display && display !== basis && display !== latest ? display.record.bytes : 0)
  + (latest && latest.textCharge !== basis.textCharge ? latest.textCharge.bytes : 0)
  + (display && display.textCharge !== basis.textCharge && display.textCharge !== latest?.textCharge ? display.textCharge.bytes : 0);
const displayMetadataBytes = (rules: string, palette: string) => 256 + stringBytes(rules) + stringBytes(palette);
const displayBytes = (display?: Display) => display ? displayMetadataBytes(display.rules, display.palette) + display.colors.bytes : 0;
const rangeOwnership = (entry: Entry) => SemanticRanges.ownershipStats(entry.ranges, entry.display ? [entry.display.view] : []);

/** One logical-data budget: snapshots, range blocks, shared contexts and their
 * cached styles follow storage lifetime, including detached captures/borrows.
 * Entry totals are attribution, never reusable global credit. Physical reply/job
 * workspace stays caller-funded; reserve only chooses synchronous pressure victims.
 * Unbound construction permits offline text/bridge retention before discovery.
 * Styles and parser execution are independent: this pool grants no work authority. */
export class SemanticRetentionPool {
  readonly arena: ContextArena;
  readonly budget: DataBudget;
  #entries = new Map<number, Entry>();
  #keys = new Map<string, number>();
  #total = zeroAccount();
  #generation = 0;
  readonly #captureOwner = {};
  readonly #piOwner = {};
  #piRevision = 0;
  #closed = false;
  readonly #maxBytes: number;
  readonly #maxGeneration: number;

  constructor(limits: { maxBytes?: number; maxGeneration?: number; budget?: DataBudget } = {}) {
    this.#maxBytes = bounded(limits.maxBytes ?? limits.budget?.limit ?? OCCIPITAL_LIMITS.retainedBytes, OCCIPITAL_LIMITS.retainedBytes);
    this.#maxGeneration = bounded(limits.maxGeneration ?? uint32, uint32);
    this.budget = limits.budget ?? new DataBudget(this.#maxBytes);
    if (this.budget.limit !== this.#maxBytes) throw new Error('inconsistent data limit');
    this.arena = new ContextArena(this.budget);
  }

  admit(key: string, version: number, text: string): SemanticAdmission {
    if (this.#closed || this.#generation === this.#maxGeneration) return refused();
    if (typeof key !== 'string' || !key.length || key.length > 64) throw new Error('invalid retention key');
    const released: SemanticRelease[] = [], previous = this.#keys.get(key), prior = previous === undefined ? undefined : this.#entries.get(previous);
    const shared = prior && sharedText(prior, text), prepared = snapshot(version, text, shared);
    const peak = metadataBytes(key) + (shared ? 32 : stringBytes(text));
    if (prepared.utf8Bytes > OCCIPITAL_LIMITS.sourceBytes || !this.#fund(previous, peak, released)) return { accepted: false, released };
    const grant = this.budget.reserve(peak)!;
    try {
      const basis = new AccountedSnapshot(version, text, prepared.utf8Bytes, grant, shared), charge = grant.consume(metadataBytes(key));
      if (previous !== undefined) released.push(this.#release(this.#entries.get(previous)!, 'replaced'));
      const generation = ++this.#generation;
      const entry: Entry = { key, generation, basis, charge, semanticStamp: 0, geometryStamp: 0, effectStamp: 0, charged: zeroAccount() };
      this.#entries.set(generation, entry); this.#keys.set(key, generation); this.#reaccount(entry);
      return { accepted: true, generation, released };
    } finally { grant.close(); }
  }

  replaceSnapshot(generation: number, version: number, text: string): SemanticAdmission {
    const entry = this.#entries.get(generation);
    if (!entry) return refused();
    const current = entry.latest ?? entry.basis!;
    if (!validSnapshot(version, text) || version < current.version || version === current.version && text !== current.text) return refused();
    if (version === current.version) { this.#touch(entry); return accepted(); }
    const shared = sharedText(entry, text), prepared = snapshot(version, text, shared ?? current), released: SemanticRelease[] = [], peak = shared ? 32 : stringBytes(text);
    if (prepared.utf8Bytes > OCCIPITAL_LIMITS.sourceBytes || !this.#fund(generation, peak, released)) return { accepted: false, released };
    const grant = this.budget.reserve(peak)!;
    try {
      const latest = new AccountedSnapshot(version, text, prepared.utf8Bytes, grant, shared);
      entry.latest?.release(); entry.latest = latest;
      if (entry.bridge && entry.bridge.version !== version && entry.bridge.version !== entry.basis!.version) { entry.bridge.payload.dispose(); entry.bridge.charge.release(); entry.bridge = undefined; }
      this.#reaccount(entry); this.#touch(entry); return { accepted: true, released };
    } finally { grant.close(); }
  }

  /** Parser adoption reserves old/new storage before changing the current basis. */
  installChunk(generation: number, chunk: SemanticChunk, capture?: Readonly<{ version: number; text: string }>, restart = false): SemanticAdmission {
    const entry = this.#entries.get(generation);
    if (!entry || chunk.key !== entry.key || chunk.generation !== generation) return refused();
    let source: SnapshotData | undefined = findSnapshot(entry, chunk.source_version);
    if (capture) {
      if (capture.version !== chunk.source_version || !validSnapshot(capture.version, capture.text)) return refused();
      if (source ? capture.text !== source.text : !entry.latest || capture.version <= entry.basis!.version
        || capture.version >= entry.latest.version || !capture.text.startsWith(entry.basis!.text) || !entry.latest.text.startsWith(capture.text)) return refused();
      source ??= snapshot(capture.version, capture.text, entry.basis!);
    }
    if (!source || source.utf8Bytes !== chunk.source_bytes) return refused();
    const ranges = !restart && entry.ranges ? entry.ranges : new SemanticRanges(this.arena), before = ranges.stats(), released: SemanticRelease[] = [];
    let peak = 0;
    try { ranges.apply(chunk, bytes => { peak = bytes; return false; }); }
    catch (error) { if (ranges !== entry.ranges) ranges.dispose(); if (error instanceof SemanticError && error.code === 'invalid_source') return refused(); throw error; }
    const shared = source instanceof AccountedSnapshot ? source : sharedText(entry, source.text);
    if (!(source instanceof AccountedSnapshot)) peak += shared ? 32 : stringBytes(source.text);
    if (!this.#fund(generation, peak, released)) return { accepted: false, released };
    const grant = this.budget.reserve(peak)!;
    let pending: Snapshot | undefined;
    try {
      pending = source instanceof AccountedSnapshot ? source.retain() : new AccountedSnapshot(source.version, source.text, source.utf8Bytes, grant, shared);
      if (!ranges.apply(chunk, () => true, grant)) return { accepted: false, released };
      const basis = pending;
      if (ranges !== entry.ranges) entry.ranges?.dispose();
      if (ranges !== entry.ranges || ranges.stats().displayRevision !== before.displayRevision) entry.semanticStamp++;
      entry.basis!.release(); entry.basis = basis; pending = undefined;
      if (entry.latest && entry.latest.version <= source.version) { entry.latest.release(); entry.latest = undefined; }
      if (entry.bridge && entry.bridge.version !== source.version && entry.bridge.version !== entry.latest?.version) { entry.bridge.payload.dispose(); entry.bridge.charge.release(); entry.bridge = undefined; }
      entry.ranges = ranges; this.#reaccount(entry); this.#touch(entry); return { accepted: true, released };
    } catch (error) { if (ranges !== entry.ranges) ranges.dispose(); throw error; }
    finally { pending?.release(); grant.close(); }
  }

  /** Only new metadata is job-private; shared payload keeps existing charges.
   * A display selector binds retained paint, never a newer parser basis.
   * A multi-slot group is finite/complete; growing Bash uses one slot. */
  captureDisplays(generations: readonly CaptureSelection[], reserve: (bytes: number) => boolean): SemanticAdmission & {
    group?: SemanticCaptureGroup; reservationBytes: number;
  } {
    const needed = this.#captureCost(generations);
    if (needed === undefined) return { ...refused(), reservationBytes: 0 };
    if (!reserve(needed)) return { ...refused(), reservationBytes: needed };
    const checked = this.#captureCost(generations);
    if (checked === undefined || checked > needed) return { ...refused(), reservationBytes: needed };
    const released: SemanticRelease[] = [];
    if (!this.#fund(generations, needed, released)) return { accepted: false, released, reservationBytes: needed };
    const grant = this.budget.reserve(needed)!, captures: SemanticCapture[] = [], groupCharge = grant.consume(512);
    const members = Object.freeze(generations.map(selection => typeof selection === 'number' ? selection : selection.generation)), group = {}, weak = new WeakRef(this);
    try {
      for (const selection of generations) {
        const generation = typeof selection === 'number' ? selection : selection.generation;
        const entry = this.#entries.get(generation)!, display = typeof selection === 'number' ? undefined : entry.display!;
        const contextCount = display ? display.colors.contextKeys.length : entry.ranges!.stats().currentContexts;
        const charge = grant.consume(512 + 256 + 32 + contextCount * 8), contexts: ContextRef[] = [];
        if (display) for (const ref of display.colors.contextKeys) contexts.push(ref);
        else entry.ranges!.visitContexts(ref => contexts.push(ref));
        const view = display ? display.view.retain(() => true, grant) : entry.ranges!.captureView(() => true, grant);
        if (!view) { charge.release(); for (const capture of captures) capture.release(); groupCharge.release(); return { accepted: false, released, reservationBytes: needed }; }
        const snapshot = (display ? display.snapshot : entry.basis!).retain();
        try {
          captures.push(new SemanticCapture({ key: entry.key, generation, semanticStamp: display ? display.semanticStamp : entry.semanticStamp, sourceVersion: snapshot.version,
            vocabulary: view.vocabulary, sourceBytes: view.sourceBytes, complete: view.complete },
          { owner: this.#captureOwner, members, group, snapshot, view, contexts: Object.freeze(contexts), charge },
          SemanticRetentionPool.#captureRelease(weak, generation)));
        } catch (error) { snapshot.release(); view.release(); charge.release(); throw error; }
        this.#reaccount(entry);
      }
      return { accepted: true, released, reservationBytes: needed, group: new SemanticCaptureGroup(captures, needed, groupCharge) };
    } catch (error) { for (const capture of captures) capture.release(); groupCharge.release(); throw error; }
    finally { grant.close(); }
  }
  #captureCost(generations: readonly CaptureSelection[]): number | undefined {
    if (this.#closed || !generations.length) return undefined;
    // Positions live in already-funded entries. Both passes repeat after reserve,
    // so nested acquisitions cannot leave a validation mark trusted by this call.
    for (let i = 0; i < generations.length; i++) {
      const selection = generations[i]!, entry = this.#entries.get(typeof selection === 'number' ? selection : selection.generation);
      if (!entry) return undefined;
      entry.capturePosition = i;
    }
    // Already-owned text/ranges/arena storage retain their existing charges.
    // Only new group/capture/reference/view metadata belongs to this job peak.
    let needed = 512, vocabulary: string | undefined;
    for (let i = 0; i < generations.length; i++) {
      const selection = generations[i]!, entry = this.#entries.get(typeof selection === 'number' ? selection : selection.generation)!;
      if (entry.capturePosition !== i) return undefined;
      const display = typeof selection === 'number' ? undefined : entry.display;
      if (typeof selection !== 'number' && display?.effectStamp !== selection.effectStamp) return undefined;
      const stats = display ? display.view : entry.ranges?.stats(), snapshot = display ? display.snapshot : entry.basis!;
      if (!stats?.revision || !stats.vocabulary || stats.sourceVersion !== snapshot.version
        || stats.sourceBytes !== snapshot.utf8Bytes || generations.length > 1 && !stats.complete
        || vocabulary !== undefined && vocabulary !== stats.vocabulary) return undefined;
      vocabulary = stats.vocabulary;
      needed += 512 + 256 + 32 + (display ? display.colors.contextKeys.length : entry.ranges!.stats().currentContexts) * 8;
      const cost = (bytes: number) => { needed += bytes; return false; };
      if (display) display.view.retain(cost);
      else entry.ranges!.captureView(cost);
    }
    return Number.isSafeInteger(needed) ? needed : undefined;
  }
  static #captureRelease(weak: WeakRef<SemanticRetentionPool>, generation: number): () => void {
    // Static factory has no instance/Entry lexical environment to retain.
    return () => { const root = weak.deref(); if (root) root.#captureReleased(generation); };
  }
  #captureReleased(generation: number): void {
    const entry = this.#entries.get(generation);
    if (entry) this.#reaccount(entry);
  }

  /** The caller alone selects the desired palette and establishes complete context
   * coverage. A still-owned historical display may recolor without making it a
   * current source result. Parsing and execution permission are never affected. */
  publishDisplay(generation: number, candidate: ReadyDisplayCandidate): SemanticAdmission {
    return this.publishDisplays([{ generation, candidate }]);
  }

  /** One card may contain many disjoint source slots. Input and desired selection
   * are caller-owned; all validation/staging is synchronous, before any commit. */
  publishDisplays(updates: readonly ReadyDisplayUpdate[]): SemanticAdmission {
    if (this.#closed) return refused();
    if (!updates.length) return accepted();
    const selection = updates[0]!.candidate.presentation;
    const captureGroup = updates[0]!.candidate.capture && SemanticCapture.read(updates[0]!.candidate.capture, this.#captureOwner);
    if (updates.some(update => update.candidate.capture)) {
      if (!captureGroup || captureGroup.members.length !== updates.length) return refused();
      for (const update of updates) {
        const data = SemanticCapture.read(update.candidate.capture, this.#captureOwner);
        if (!data || data.group !== captureGroup.group || update.candidate.capture!.generation !== update.generation) return refused();
      }
    }
    let peak = updates.length * displayPlanBytes;
    for (const update of updates) {
      const input = update.candidate.presentation;
      if (input.vocabulary !== selection.vocabulary || input.rules !== selection.rules || input.palette !== selection.palette || input.bindingRevision !== selection.bindingRevision) return refused();
      const extra = this.#displayPeak(update);
      if (extra === undefined) return refused();
      peak += extra;
    }
    const released: SemanticRelease[] = [];
    // Protect the entire input set while funding scratch plans, all captures and
    // all old/new palettes together. No owned table/plan/hold before this grant.
    if (!this.#fund(updates, peak, released)) return { accepted: false, released };
    const grant = this.budget.reserve(peak)!;
    try {
    const generations = new Set<number>();
    for (const update of updates) {
      if (generations.has(update.generation)) return { accepted: false, released };
      generations.add(update.generation);
      const known = new Set<ContextRef>();
      for (const pair of update.candidate.presentation.contexts) {
        if (known.has(pair.context)) return { accepted: false, released };
        known.add(pair.context);
      }
      const capture = update.candidate.capture && SemanticCapture.read(update.candidate.capture, this.#captureOwner);
      if (capture && (known.size !== capture.contexts.length || capture.contexts.some(ref => !known.has(ref)))) return { accepted: false, released };
    }
    const plans: DisplayPlan[] = [];
    const abandon = () => { for (const plan of plans) { plan.newView?.release(); if (plan.next) { plan.next.snapshot.release(); plan.next.colors.charge.release(); plan.next.charge.release(); } } };
    try {
      for (const update of updates) {
        const entry = this.#entries.get(update.generation)!, old = entry.display, candidate = update.candidate, input = candidate.presentation;
        const sameView = !!old && old.semanticStamp === candidate.semanticStamp && old.snapshot.version === candidate.sourceVersion;
        const equal = !!old && equalPresentation(old.colors, input);
        const plan: DisplayPlan = { entry, old }; plans.push(plan);
        if (sameView && equal && old!.rules === input.rules && old!.palette === input.palette && old!.bindingRevision === input.bindingRevision) continue;
        const capture = candidate.capture && SemanticCapture.read(candidate.capture, this.#captureOwner);
        const view = sameView ? old!.view : capture ? capture.view.retain(() => true, grant) : entry.ranges!.captureView(() => true, grant);
        if (!view) { abandon(); return { accepted: false, released }; }
        if (!sameView) plan.newView = view;
        const colors = equal ? old!.colors : copyPresentation(input, grant);
        if (equal) colors.charge.retain();
        plan.next = { charge: grant.consume(displayMetadataBytes(input.rules, input.palette)), token: {}, view,
          snapshot: (sameView ? old!.snapshot : capture ? capture.snapshot : entry.basis!).retain(), semanticStamp: candidate.semanticStamp,
          geometryStamp: entry.geometryStamp + (sameView ? 0 : 1), effectStamp: entry.effectStamp + (sameView && equal ? 0 : 1),
          rules: input.rules, palette: input.palette, bindingRevision: input.bindingRevision, colors };
      }
    } catch (error) { abandon(); throw error; }
    // No user code runs during this commit; every slot is staged and funded.
    for (const plan of plans) {
      if (plan.next) {
        plan.entry.display = plan.next;
        plan.entry.geometryStamp = plan.next.geometryStamp; plan.entry.effectStamp = plan.next.effectStamp;
        if (plan.old) { if (plan.newView) plan.old.view.release(); plan.old.snapshot.release(); plan.old.colors.charge.release(); plan.old.charge.release(); }
        this.#reaccount(plan.entry);
      }
      this.#touch(plan.entry);
    }
    return { accepted: true, released };
    } finally { grant.close(); }
  }

  #displayPeak(update: ReadyDisplayUpdate): number | undefined {
    const entry = this.#entries.get(update.generation);
    if (!entry) return undefined;
    const candidate = update.candidate, old = entry.display, input = candidate.presentation;
    const sameView = !!old && old.semanticStamp === candidate.semanticStamp && old.snapshot.version === candidate.sourceVersion;
    const current = !!entry.ranges && entry.semanticStamp === candidate.semanticStamp && entry.basis!.version === candidate.sourceVersion;
    const capture = candidate.capture && SemanticCapture.read(candidate.capture, this.#captureOwner);
    if (candidate.capture && (!capture || candidate.capture.generation !== update.generation || candidate.capture.key !== entry.key
      || candidate.capture.sourceVersion !== candidate.sourceVersion || candidate.capture.semanticStamp !== candidate.semanticStamp
      || old && (old.semanticStamp > candidate.semanticStamp || old.snapshot.version > candidate.sourceVersion))) return undefined;
    if (!sameView && !current && !capture || !completeRoles(input)) return undefined;
    const vocabulary = capture ? capture.view.vocabulary : sameView ? old!.view.vocabulary : entry.ranges!.stats().vocabulary;
    if (input.vocabulary !== vocabulary) return undefined;
    try {
      // Brand handles only; the mutable arena style result is never borrowed.
      for (const pair of input.contexts) this.arena.style(input.vocabulary, pair.context, input.rules);
    } catch (error) {
      if (error instanceof SemanticError && (error.code === 'invalid_context' || error.code === 'identity_mismatch')) return undefined;
      throw error;
    }
    const equal = !!old && equalPresentation(old.colors, input);
    const unchanged = sameView && equal && old!.rules === input.rules && old!.palette === input.palette && old!.bindingRevision === input.bindingRevision;
    let peak = presentationPeak(input, equal) + (unchanged ? 0 : displayMetadataBytes(input.rules, input.palette));
    // Capture's denial is atomic. Learn its metadata cost without a duplicated
    // range-policy constant or a temporary hold before the aggregate grant.
    if (!sameView) {
      if (capture) {
        capture.view.retain(bytes => { peak += bytes; return false; });
        // Captured store and snapshot owners keep their existing pool charges;
        // publication adds only a new view header and presentation ownership.
      } else entry.ranges!.captureView(bytes => { peak += bytes; return false; });
    }
    return peak;
  }

  /** Detached primitive metadata, not a strong reader/capture or finite proof. */
  displayStatus(generation: number) {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display) return undefined;
    this.#touch(entry);
    return { vocabulary: display.view.vocabulary, semanticStamp: display.semanticStamp, sourceVersion: display.snapshot.version, geometryStamp: display.geometryStamp,
      effectStamp: display.effectStamp, complete: display.view.complete, sourceBytes: display.snapshot.utf8Bytes,
      rules: display.rules, palette: display.palette, bindingRevision: display.bindingRevision };
  }

  borrowDisplay(generation: number, effectStamp: number): SnapshotData | undefined {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry); return Object.freeze({ version: display.snapshot.version, text: display.snapshot.text, utf8Bytes: display.snapshot.utf8Bytes });
  }

  /** Synchronous provisional text borrow; physical snapshot ownership ends at unwind. */
  visitDisplayText(generation: number, effectStamp: number, consume: (source: SnapshotData) => void): boolean {
    const cursor = this.#displayTextCursor(generation, effectStamp);
    if (!cursor) return false;
    try {
      consume(cursor.snapshot);
      return this.#displayMatches(generation, cursor.token);
    } finally { cursor.snapshot.release(); }
  }
  #displayTextCursor(generation: number, effectStamp: number) {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry);
    return { token: display.token, snapshot: display.snapshot.retain() };
  }

  displayRole(generation: number, effectStamp: number, role: CardRole): ConcreteStyle | undefined {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry); return display.colors.roles[role];
  }

  /** Provisional visit: commit a consumer's result only if true is returned. An
   * incomplete caller table throws; no neutral fallback can mask missing styles. */
  visitDisplay(generation: number, effectStamp: number,
    consume: (from: number, to: number, contextID: number, style: ConcreteStyle) => void): boolean {
    const cursor = this.#displayCursor(generation, effectStamp);
    if (!cursor) return false;
    const alive = () => this.#displayMatches(generation, cursor.token);
    try {
      cursor.view.visit((from, to, ref) => {
        if (!alive()) return;
        const style = this.#displayStyle(generation, cursor.token, ref);
        if (style) consume(from, to, ref?.id ?? 0, style);
      });
      return alive();
    } finally { cursor.paint.release(); }
  }

  /** Enumerate adopted literals without reading ranges or current parser state.
   * The caller may deduplicate identical literals before compiling them. */
  visitDisplayStyles(generation: number, effectStamp: number, consume: (style: ConcreteStyle) => void): boolean {
    const cursor = this.#displayPaintCursor(generation, effectStamp);
    if (!cursor) return false;
    try {
      const neutral = this.#displayStyle(generation, cursor.token, undefined)!;
      consume(neutral);
      for (let index = 0; ; index++) {
        if (!this.#displayMatches(generation, cursor.token)) return false;
        const style = this.#displayStyleAt(generation, cursor.token, index);
        if (!style) return true;
        consume(style);
      }
    } finally { cursor.paint.release(); }
  }
  #displayPaintCursor(generation: number, effectStamp: number) {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry);
    return { token: display.token, paint: display.colors.charge.retain() };
  }
  #displayStyleAt(generation: number, token: object, index: number): ConcreteStyle | undefined {
    const display = this.#entries.get(generation)?.display;
    if (!display || display.token !== token) return undefined;
    const ref = display.colors.contextKeys[index];
    return ref ? this.#displayStyle(generation, token, ref) : undefined;
  }

  /** Provisional historical context demand from the adopted table, never ranges.
   * Keep only a publication token; resolve each ref before entering user code. */
  visitDisplayContexts(generation: number, effectStamp: number, consume: (ref: ContextRef) => void): boolean {
    const token = this.#displayToken(generation, effectStamp);
    if (!token) return false;
    for (let i = 0; ; i++) {
      if (!this.#displayMatches(generation, token)) return false;
      const ref = this.#displayContextAt(generation, token, i);
      if (!ref) return true;
      consume(ref);
    }
  }
  #displayToken(generation: number, effectStamp: number): object | undefined {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry); return display.token;
  }
  #displayContextAt(generation: number, token: object, index: number): ContextRef | undefined {
    const display = this.#entries.get(generation)?.display;
    return display?.token === token ? display.colors.contextKeys[index] : undefined;
  }

  // These helper frames return before consume: a suspended callback may retain
  // only a payload-free token, a releasable view and one detached literal, never
  // an Entry/Display whose retired snapshot or palette is no longer charged.
  #displayCursor(generation: number, effectStamp: number) {
    const entry = this.#entries.get(generation), display = entry?.display;
    if (!entry || !display || display.effectStamp !== effectStamp) return undefined;
    this.#touch(entry);
    return { token: display.token, view: display.view, paint: display.colors.charge.retain() };
  }
  #displayMatches(generation: number, token: object): boolean {
    return this.#entries.get(generation)?.display?.token === token;
  }
  #displayStyle(generation: number, token: object, ref: ContextRef | undefined): ConcreteStyle | undefined {
    const display = this.#entries.get(generation)?.display;
    if (!display || display.token !== token) return undefined;
    const style = ref ? display.colors.contexts.get(ref) : display.colors.roles.code;
    if (!style) throw new Error('incomplete ready presentation');
    return style;
  }

  /** Used by context/style adoption and pending job pins too. The consumer must
   * adopt synchronously and keep its own refs pinned if pressure evicts sources. */
  reserve(generation: number | ((generation: number) => boolean) | undefined, additionalPeak: number): SemanticAdmission {
    const released: SemanticRelease[] = [];
    if (this.#closed || !Number.isSafeInteger(additionalPeak) || additionalPeak < 0) return refused();
    return { accepted: this.#fund(generation, additionalPeak, released), released };
  }

  piPreparation(generation: number, version: number, palette: number, released: SemanticRelease[] = []): SemanticAdmission & { ticket?: PiPreparation } {
    if (!this.#piSource(generation, version) || !Number.isSafeInteger(palette) || palette < 0) return refused();
    if (!this.#fund(generation, 128, released)) return { accepted: false, released };
    const grant = this.budget.reserve(128);
    if (!grant) return { accepted: false, released };
    let charge: DataCharge | undefined, source: Snapshot | undefined;
    try {
      source = this.#piSource(generation, version)!.retain(); charge = grant.consume(128);
      const ticket = new PiPreparation(this.#piOwner, generation, palette, source, charge);
      source = undefined; charge = undefined;
      return { accepted: true, released, ticket };
    } finally { source?.release(); charge?.release(); grant.close(); }
  }
  #piSource(generation: number, version: number): Snapshot | undefined {
    if (this.#closed) return undefined;
    const entry = this.#entries.get(generation), source = entry && (entry.latest ?? entry.basis);
    return source?.version === version ? source : undefined;
  }
  acceptsPiPreparation(ticket: PiPreparation): boolean {
    const source = PiPreparation.read(ticket, this.#piOwner);
    return !!source && ticket.budget === this.budget && source === this.#piSource(ticket.generation, ticket.version);
  }
  /** Consumes on every outcome; old and candidate payloads remain funded until commit. */
  adoptPiFlat(ticket: PiPreparation, exactText: string, staged: StagedPiProjection, released: SemanticRelease[] = []): SemanticAdmission & { refused?: true } {
    let payload: PiProjectionPayload | undefined;
    try {
      payload = staged.consume();
      if (!payload || !this.acceptsPiPreparation(ticket) || payload.budget !== this.budget || !payload.isValid
        || ticket.text !== exactText || payload.sourceBytes !== ticket.sourceBytes) return refused();
      if (!this.#fund(ticket.generation, bridgeHeader + 128, released)) return { accepted: false, released, refused: true };
      const grant = this.budget.reserve(bridgeHeader + 128);
      if (!grant) return { accepted: false, released, refused: true };
      let charge: DataCharge | undefined;
      try {
        if (!this.acceptsPiPreparation(ticket)) return { accepted: false, released };
        const entry = this.#entries.get(ticket.generation)!;
        charge = grant.consume(bridgeHeader);
        const next: Bridge = { version: sharedText(entry, exactText)!.version, revision: ++this.#piRevision, payload,
          bytes: bridgeHeader + payload.accountedBytes, charge };
        const old = entry.bridge; entry.bridge = next; payload = undefined; charge = undefined;
        old?.payload.dispose(); old?.charge.release(); this.#reaccount(entry); this.#touch(entry);
        return { accepted: true, released };
      } finally { charge?.release(); grant.close(); }
    } finally { payload?.dispose(); staged.dispose(); }
  }

  borrowSnapshot(generation: number, kind: 'basis' | 'latest' = 'latest'): SnapshotData | undefined {
    const entry = this.#entries.get(generation);
    if (!entry) return undefined;
    this.#touch(entry);
    const source = kind === 'basis' ? entry.basis! : entry.latest ?? entry.basis!;
    return { version: source.version, text: source.text, utf8Bytes: source.utf8Bytes };
  }

  retainBasis(generation: number): void {
    const entry = this.#entries.get(generation);
    if (!entry) return;
    entry.latest?.release(); entry.latest = undefined;
    if (entry.bridge?.version !== entry.basis!.version) { entry.bridge?.payload.dispose(); entry.bridge?.charge.release(); entry.bridge = undefined; }
    this.#reaccount(entry);
  }

  /** Current parser demand only, with no Entry frame suspended across consume. */
  visitContexts(generation: number, consume: (ref: ContextRef) => void): boolean {
    return this.#currentRanges(generation)?.visitContexts(consume) ?? false;
  }
  #currentRanges(generation: number): SemanticRanges | undefined {
    const entry = this.#entries.get(generation);
    if (!entry?.ranges) return undefined;
    this.#touch(entry); return entry.ranges;
  }

  visitRanges(generation: number, consume: (from: number, to: number, context: ContextRef | undefined) => void): boolean {
    const ranges = this.#currentRanges(generation);
    if (!ranges) return false;
    const revision = ranges.stats().revision;
    ranges.visit(consume);
    return this.#entries.get(generation)?.ranges === ranges && ranges.stats().revision === revision;
  }

  #piCursor(generation: number, revision: number) {
    const entry = this.#entries.get(generation), bridge = entry?.bridge;
    if (!entry || !bridge || bridge.revision !== revision) return undefined;
    this.#touch(entry); return { payload: bridge.payload, charge: bridge.charge.retain() };
  }
  visitPiRanges(generation: number, revision: number, consume: (start: number, end: number, style: number) => void): boolean {
    const cursor = this.#piCursor(generation, revision); if (!cursor) return false;
    try { return cursor.payload.visitRanges(consume); } finally { cursor.charge.release(); }
  }
  visitPiStyles(generation: number, revision: number, consume: (index: number, style: ConcreteStyle) => void): boolean {
    const cursor = this.#piCursor(generation, revision); if (!cursor) return false;
    try { return cursor.payload.visitStyles(consume); } finally { cursor.charge.release(); }
  }
  piProjectionStatus(generation: number) {
    const entry = this.#entries.get(generation), bridge = entry?.bridge;
    if (!entry || !bridge) return undefined;
    this.#touch(entry);
    return { version: bridge.version, revision: bridge.revision, sourceBytes: bridge.payload.sourceBytes,
      rangeCount: bridge.payload.rangeCount, styleCount: bridge.payload.styleCount };
  }

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
    return { key: entry.key, generation, basisVersion: entry.basis!.version, latestVersion: entry.latest?.version, ...entry.charged,
      vocabulary: ranges?.vocabulary, semanticStamp: entry.semanticStamp, revision: ranges?.revision ?? 0, displayRevision: ranges?.displayRevision ?? 0,
      sourceVersion: ranges?.sourceVersion, sourceBytes: ranges?.sourceBytes ?? 0, committedBytes: ranges?.committedBytes ?? 0,
      complete: ranges?.complete ?? false, committedChunks: ranges?.committedChunks ?? 0, bridgeVersion: entry.bridge?.version };
  }

  stats() {
    const arena = this.arena.stats();
    return { entries: this.#entries.size, ...this.#total, retainedBytes: this.budget.stats().retainedBytes, outstandingPeakBytes: this.budget.stats().outstandingPeakBytes,
      contexts: arena.contexts, contextBytes: arena.retainedBytes - arena.styleBytes, styles: arena.styles, styleBytes: arena.styleBytes,
      allocatedWordBytes: arena.allocatedWordBytes, prefixCopiedBytes: 0, lastGeneration: this.#generation, maxBytes: this.#maxBytes };
  }

  remove(generation: number): SemanticRelease[] {
    const entry = this.#entries.get(generation);
    return entry ? [this.#release(entry, 'removed')] : [];
  }
  clear(): SemanticRelease[] {
    const released: SemanticRelease[] = [];
    for (const entry of this.#entries.values()) released.push(this.#release(entry, 'clear'));
    return released;
  }
  dispose(): void {
    this.#closed = true; this.budget.close(); this.clear(); this.arena.dispose();
  }

  #touch(entry: Entry): void { this.#entries.delete(entry.generation); this.#entries.set(entry.generation, entry); }
  #fund(protectedGeneration: number | readonly (number | { readonly generation: number })[] | ((generation: number) => boolean) | undefined, extra: number, released: SemanticRelease[]): boolean {
    if (this.budget.stats().closed || !Number.isSafeInteger(extra) || extra < 0 || extra > this.#maxBytes) return false;
    const fits = () => this.budget.stats().retainedBytes + this.budget.stats().outstandingPeakBytes + extra <= this.#maxBytes;
    if (fits()) return true;
    const members = typeof protectedGeneration === 'object' ? protectedGeneration : undefined;
    // Pins live in funded entry metadata, not an extra pressure-time membership set.
    if (members) for (const member of members) {
      const entry = this.#entries.get(typeof member === 'number' ? member : member.generation);
      if (entry) entry.fundingPins = (entry.fundingPins ?? 0) + 1;
    }
    try {
      for (const entry of this.#entries.values()) {
        if (fits()) return true;
        const protectedEntry = !!entry.fundingPins || (typeof protectedGeneration === 'number' ? entry.generation === protectedGeneration
          : typeof protectedGeneration === 'function' && protectedGeneration(entry.generation));
        if (!protectedEntry) released.push(this.#release(entry, 'pressure'));
      }
      return fits();
    } finally {
      if (members) for (const member of members) {
        const entry = this.#entries.get(typeof member === 'number' ? member : member.generation);
        if (entry) entry.fundingPins!--;
      }
    }
  }
  #reaccount(entry: Entry): void {
    const snapshotBytes = snapshotsBytes(entry.basis!, entry.latest, entry.display?.snapshot), ranges = rangeOwnership(entry), current = entry.ranges?.stats();
    const rangeBytes = ranges.retainedBytes, colors = displayBytes(entry.display), bridgeBytes = entry.bridge?.bytes ?? 0;
    const charged: Account = { retainedBytes: metadataBytes(entry.key) + snapshotBytes + rangeBytes + bridgeBytes + colors,
      snapshotBytes, rangeBytes, bridgeBytes, displayBytes: colors, rangeRunBytes: ranges.rangeBytes,
      displayOnlyRangeBytes: ranges.displayOnlyRangeBytes, rangeStores: ranges.stores, rangeViews: ranges.views,
      retainedTails: ranges.retainedTails, rangeBlocks: ranges.committedChunks,
      contextIndexBytes: current?.contextIndexBytes ?? 0, currentContexts: current?.currentContexts ?? 0 };
    for (const field of accountFields) this.#total[field] += charged[field] - entry.charged[field];
    entry.charged = charged;
  }
  #release(entry: Entry, reason: SemanticRelease['reason']): SemanticRelease {
    const before = this.budget.stats().retainedBytes, charged = entry.charged;
    if (entry.display) { entry.display.view.release(); entry.display.snapshot.release(); entry.display.colors.charge.release(); entry.display.charge.release(); entry.display = undefined; }
    entry.ranges?.dispose(); entry.basis!.release(); entry.latest?.release(); entry.bridge?.payload.dispose(); entry.bridge?.charge.release(); entry.charge.release();
    const receipt = { key: entry.key, generation: entry.generation, reason, ...charged, attributedBytes: charged.retainedBytes,
      retainedBytes: before - this.budget.stats().retainedBytes };
    this.#entries.delete(entry.generation); this.#keys.delete(entry.key);
    for (const field of accountFields) this.#total[field] -= charged[field];
    entry.ranges = undefined; entry.bridge = undefined; entry.latest = undefined;
    entry.basis = undefined;
    return receipt;
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('invalid retention limit');
  return value;
}
function validSnapshot(version: number, text: string): boolean {
  return Number.isInteger(version) && version >= 0 && version <= uint32 && typeof text === 'string' && text.length <= OCCIPITAL_LIMITS.sourceBytes;
}
function snapshot(version: number, text: string, previous?: SnapshotData): SnapshotData {
  if (!validSnapshot(version, text)) throw new Error('invalid retention snapshot');
  let utf8Bytes: number;
  if (!previous || !text.startsWith(previous.text)) utf8Bytes = Buffer.byteLength(text);
  else if (text === previous.text) utf8Bytes = previous.utf8Bytes;
  else {
    let from = previous.text.length, bytes = previous.utf8Bytes;
    const last = previous.text.charCodeAt(from - 1), next = text.charCodeAt(from);
    // A split surrogate pair replaces the former U+FFFD byte contribution.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { from--; bytes -= 3; }
    utf8Bytes = bytes + Buffer.byteLength(text.slice(from));
  }
  return { version, text, utf8Bytes };
}
function sharedText(entry: Entry, text: string): Snapshot | undefined {
  return entry.basis!.text === text ? entry.basis : entry.latest?.text === text ? entry.latest
    : entry.display?.snapshot.text === text ? entry.display.snapshot : undefined;
}
function findSnapshot(entry: Entry, version: number): Snapshot | undefined {
  return entry.latest?.version === version ? entry.latest : entry.basis!.version === version ? entry.basis! : undefined;
}
