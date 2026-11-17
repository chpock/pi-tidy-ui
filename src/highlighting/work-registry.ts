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

export interface WorkContinuation {
  continueWork(): void;
  resumePreparation(): void;
}

function scheduleContinuation(owner: WeakRef<WorkContinuation>) {
  return () => owner.deref()?.continueWork();
}
function preparationTurn(owner: WeakRef<WorkContinuation>) {
  return () => owner.deref()?.resumePreparation();
}

/** Chronological membership, cursor and host-turn quota; execution owns visit policy. */
export class WorkRegistry<State extends { key: string }, Metadata extends object> {
  private readonly owner: WeakRef<WorkContinuation>;
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
  private blockedCredit = false;
  private readonly preparationLimit: number;

  constructor(owner: WeakRef<WorkContinuation>, preparationLimit: number) {
    this.owner = owner; this.preparationLimit = preparationLimit;
  }

  get size(): number { return this.entries.size; }
  get hasWorkTurn(): boolean { return this.scheduled || this.yielding || this.pumping; }
  get currentPass(): number { return this.pass; }
  get hasQuota(): boolean { return this.preparations < this.preparationLimit; }
  get hasLocalPending(): boolean { return this.localPending > 0; }
  get creditBlocked(): boolean { return this.blockedCredit; }
  get exhausted(): boolean { return this.cursor === undefined; }

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
  next(): WorkNode<WorkEntry<State>, Metadata> | undefined {
    const node = this.cursor;
    if (node) { this.cursor = node.older; node.seen = this.pass; }
    return node;
  }
  isNewest(node: WorkNode<WorkEntry<State>, Metadata>): boolean { return node === this.newest; }
  needsRefresh(node: WorkNode<WorkEntry<State>, Metadata>): boolean { return node.epoch !== this.refreshEpoch; }
  current(node: WorkNode<WorkEntry<State>, Metadata>, pass: number): boolean {
    return this.entries.get(node.value) === node && this.pass === pass && !node.pending && node.epoch === this.refreshEpoch;
  }
  restoreCursor(node: WorkNode<WorkEntry<State>, Metadata>, pass: number): void {
    if (this.entries.get(node.value) === node && this.pass === pass) this.cursor = node;
  }
  private setPending(node: WorkNode<WorkEntry<State>, Metadata>, pending: WorkPending): void {
    if (node.pending === 'local') this.localPending--;
    node.pending = pending;
    if (pending === 'local') this.localPending++;
  }
  markPrepared(node: WorkNode<WorkEntry<State>, Metadata>): void {
    this.setPending(node, false); node.epoch = this.refreshEpoch;
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
    const node = this.entries.get(group); if (!node) return;
    node.paused = false; this.setPending(node, local || node.pending === 'local' ? 'local' : 'native'); this.rewind(); this.schedule();
  }
  pause(group: SourceWorkGroup): boolean {
    const node = this.entries.get(group);
    if (!node || node.paused) return false;
    node.paused = true; this.setPending(node, false); node.epoch = this.refreshEpoch;
    return true;
  }
  refresh(): void { this.refreshEpoch++; this.rewind(); this.schedule(); }
  requestRetry(): void { this.retryScan = true; }
  noteCreditBlocked(): void { this.blockedCredit = true; }
  wake(): void {
    this.blockedCredit = false;
    if (this.retryScan) { this.retryScan = false; this.rewind(); }
    this.schedule();
  }
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true; queueMicrotask(scheduleContinuation(this.owner));
  }
  resumePreparation(): void { this.preparations = 0; this.yielding = false; this.scheduled = false; }
  revisit(value: WorkEntry<State>, executionOwed: boolean): void {
    const node = this.entries.get(value);
    if (node?.seen === this.pass && (node.pending || node.epoch !== this.refreshEpoch || executionOwed)) this.rewind();
  }
  enterTurn(active: boolean): boolean {
    if (!active) { this.scheduled = false; return false; }
    if (this.pumping) return false;
    if (!this.yielding) this.scheduled = false;
    this.pumping = true;
    return true;
  }
  notePreparation(): void { this.preparations++; }
  finishTurn(): void {
    this.pumping = false;
    if (this.preparations && !this.yielding) {
      this.yielding = true; this.scheduled = true;
      setImmediate(preparationTurn(this.owner));
    }
  }
}
