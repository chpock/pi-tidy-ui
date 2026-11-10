/** Payload-free presentation preparation registered in chronological work order. */
export interface SourcePreparation {
  readonly keys: ReadonlySet<string>;
  prepare(): void;
  acceptsSelection?(palette: string, rules: string): boolean;
  needsRefresh?(newest: boolean): boolean;
  requiresCredit?(): boolean;
}

/** Opaque handle; only the execution owner and registry associate source incarnations. */
export type SourceWorkGroup = { readonly id: number; readonly preparation: WeakRef<SourcePreparation>; readonly keys: ReadonlySet<string> };
export type WorkEntry<State> = SourceWorkGroup | State;
export type WorkPending = false | 'native' | 'local';

/** Registry scheduling fields are added to the execution-supplied metadata object itself. */
export type WorkNode<Entry, Metadata extends object> = Metadata & {
  value: Entry; pending: WorkPending; epoch: number; seen: number;
  paused?: boolean; older?: WorkNode<Entry, Metadata>; newer?: WorkNode<Entry, Metadata>;
};

export interface WorkTurnExecution<State extends { key: string }, Description, Metadata extends object> {
  registrySuspended(): boolean;
  registryDisposed(): boolean;
  registryEnabled(): boolean;
  registryHasSelection(): boolean;
  registryBeginTurn(): Description | undefined;
  registryIsFull(description: Description | undefined, creditBlocked: boolean): boolean;
  registryPrepareStyles(node: WorkNode<WorkEntry<State>, Metadata>, description: Description | undefined, full: boolean): void;
  registryDispatch(state: State | undefined, description: Description | undefined, full: () => boolean): boolean;
  registrySource(key: string): State | undefined;
  registrySourceBusy(key: string): boolean;
  registryPrepareGroup(group: SourceWorkGroup, preparation: SourcePreparation): void;
  registryWaitForCredit(): void;
  registryReconcileWithdrawal(): void;
  registryFinishTurn(): void;
  registryContinue(): void;
  registryResumePreparation(): void;
  registryRemoveCollected(group: SourceWorkGroup): void;
}

function isGroup<State>(entry: WorkEntry<State>): entry is SourceWorkGroup {
  return typeof entry === 'object' && entry !== null && 'preparation' in entry;
}

function scheduleContinuation<State extends { key: string }, Description, Metadata extends object>(owner: WeakRef<WorkTurnExecution<State, Description, Metadata>>) {
  return () => owner.deref()?.registryContinue();
}
function preparationTurn<State extends { key: string }, Description, Metadata extends object>(owner: WeakRef<WorkTurnExecution<State, Description, Metadata>>) {
  return () => owner.deref()?.registryResumePreparation();
}

/** Private chronological registry. It owns the sole synchronous pass and host-turn quota. */
export class WorkRegistry<State extends { key: string }, Description, Metadata extends object> {
  private readonly owner: WeakRef<WorkTurnExecution<State, Description, Metadata>>;
  private readonly entries = new Map<WorkEntry<State>, WorkNode<WorkEntry<State>, Metadata>>();
  private newest?: WorkNode<WorkEntry<State>, Metadata>;
  private cursor?: WorkNode<WorkEntry<State>, Metadata>;
  private pass = 0;
  private refreshEpoch = 0;
  private localPending = 0;
  private scheduled = false;
  private yielding = false;
  private pumping = false;
  private preparations = 0;
  private groupSequence = 0;
  private retryScan = false;
  private creditBlocked = false;
  private readonly preparationLimit: number;

  constructor(owner: WeakRef<WorkTurnExecution<State, Description, Metadata>>, preparationLimit: number) {
    this.owner = owner; this.preparationLimit = preparationLimit;
  }

  get size(): number { return this.entries.size; }
  get hasWorkTurn(): boolean { return this.scheduled || this.yielding || this.pumping; }

  get(value: WorkEntry<State>): WorkNode<WorkEntry<State>, Metadata> | undefined { return this.entries.get(value); }
  has(value: WorkEntry<State>): boolean { return this.entries.has(value); }
  values(): IterableIterator<WorkNode<WorkEntry<State>, Metadata>> { return this.entries.values(); }
  [Symbol.iterator](): IterableIterator<[WorkEntry<State>, WorkNode<WorkEntry<State>, Metadata>]> { return this.entries[Symbol.iterator](); }
  clear(): void { this.entries.clear(); this.newest = undefined; this.cursor = undefined; this.localPending = 0; }

  register(value: WorkEntry<State>, metadata: Metadata): void {
    const node = Object.assign(metadata, { value, pending: false as const, epoch: this.refreshEpoch, seen: -1, older: this.newest }) as WorkNode<WorkEntry<State>, Metadata>;
    if (this.newest) this.newest.newer = node;
    this.newest = node; this.entries.set(value, node); this.rewind();
  }
  nextGroupId(): number { return ++this.groupSequence; }
  rewind(): void { this.pass++; this.cursor = this.newest; }
  private setPending(node: WorkNode<WorkEntry<State>, Metadata>, pending: WorkPending): void {
    if (node.pending === 'local') this.localPending--;
    node.pending = pending;
    if (pending === 'local') this.localPending++;
  }
  remove(value: WorkEntry<State>, report: (node: WorkNode<WorkEntry<State>, Metadata>) => void,
    release: (node: WorkNode<WorkEntry<State>, Metadata>) => void): boolean {
    const node = this.entries.get(value); if (!node) return false;
    report(node);
    this.setPending(node, false);
    release(node);
    if (node.older) node.older.newer = node.newer;
    if (node.newer) node.newer.older = node.older;
    else this.newest = node.older;
    if (this.cursor === node) this.cursor = node.older;
    node.older = undefined; node.newer = undefined;
    return this.entries.delete(value);
  }
  queue(group: SourceWorkGroup, local = false): void {
    const node = this.entries.get(group); if (!node || this.owner.deref()?.registryDisposed()) return;
    node.paused = false; this.setPending(node, local || node.pending === 'local' ? 'local' : 'native'); this.rewind(); this.schedule();
  }
  pause(group: SourceWorkGroup): void {
    const node = this.entries.get(group);
    if (node && !node.paused) {
      node.paused = true; this.setPending(node, false); node.epoch = this.refreshEpoch;
      this.owner.deref()?.registryReconcileWithdrawal();
    }
  }
  refresh(): void {
    if (this.owner.deref()?.registryDisposed()) return;
    this.refreshEpoch++; this.rewind(); this.schedule();
  }
  requestRetry(): void { this.retryScan = true; }
  noteCreditBlocked(): void { this.creditBlocked = true; }
  wake(): void {
    this.creditBlocked = false;
    if (this.retryScan) { this.retryScan = false; this.rewind(); }
    this.schedule();
  }
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true; queueMicrotask(scheduleContinuation(this.owner));
  }
  resumePreparation(): void {
    this.preparations = 0; this.yielding = false; this.scheduled = false;
    this.owner.deref()?.registryContinue();
  }
  revisit(value: WorkEntry<State>, executionOwed: boolean): void {
    const node = this.entries.get(value);
    if (node?.seen === this.pass && (node.pending || node.epoch !== this.refreshEpoch || executionOwed)) this.rewind();
  }

  runTurn(): void {
    const owner = this.owner.deref(); if (!owner) return;
    if (owner.registrySuspended()) { this.scheduled = false; return; }
    if (this.pumping) return;
    if (!this.yielding) this.scheduled = false;
    this.pumping = true;
    try {
      const description = owner.registryBeginTurn();
      const full = () => owner.registryIsFull(description, this.creditBlocked);
      const dispatch = (state: State | undefined) => owner.registryDispatch(state, description, full);
      while (this.cursor && !owner.registryDisposed()) {
        if (this.preparations >= this.preparationLimit) break;
        const node = this.cursor, entry = node.value, pass = this.pass;
        if (owner.registryHasSelection()) this.preparations++;
        this.cursor = node.older; node.seen = pass;
        if (!isGroup(entry)) {
          owner.registryPrepareStyles(node, description, full());
          if (dispatch(entry)) {
            this.retryScan = true; if (this.localPending || owner.registryHasSelection()) continue;
            this.cursor = node; break;
          }
          continue;
        }
        const preparation = entry.preparation.deref();
        if (!preparation) { owner.registryRemoveCollected(entry); continue; }
        if (node.paused) continue;
        owner.registryPrepareStyles(node, description, full());
        const refresh = node.epoch !== this.refreshEpoch;
        if (node.pending || refresh && (preparation.needsRefresh?.(node === this.newest) ?? true)) {
          const native = !!description && owner.registryEnabled() && node.pending !== 'local' && (preparation.requiresCredit?.() ?? true);
          if (native && full()) {
            owner.registryWaitForCredit(); this.retryScan = true;
            if (this.localPending || owner.registryHasSelection()) continue;
            this.cursor = node; break;
          }
          if (native && [...entry.keys].some(key => owner.registrySourceBusy(key))) continue;
          if (!owner.registryHasSelection() && this.preparations >= this.preparationLimit) { this.cursor = node; break; }
          this.setPending(node, false); node.epoch = this.refreshEpoch;
          if (!owner.registryHasSelection()) this.preparations++;
          owner.registryPrepareGroup(entry, preparation);
        } else node.epoch = this.refreshEpoch;
        if (!this.entries.has(entry) || pass !== this.pass || node.pending || node.epoch !== this.refreshEpoch) continue;
        owner.registryPrepareStyles(node, description, full());
        let waiting = false;
        for (const key of entry.keys) if (dispatch(owner.registrySource(key))) { waiting = true; break; }
        if (waiting) {
          this.retryScan = true; if (this.localPending || owner.registryHasSelection()) continue;
          this.cursor = node; break;
        }
      }
    } finally {
      this.pumping = false;
      if (this.preparations && !this.yielding) {
        this.yielding = true; this.scheduled = true;
        setImmediate(preparationTurn(this.owner));
      }
      owner.registryFinishTurn();
    }
  }
}
