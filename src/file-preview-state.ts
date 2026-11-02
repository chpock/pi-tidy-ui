export type FilePreviewMode = 'preview' | 'full';

export interface FilePreviewCandidate<Owner extends object> {
  owner: Owner;
  toolCallId: string;
  order: number;
}

type OwnerRecord<Owner extends object> = {
  reference: WeakRef<Owner>;
  toolCallId: string;
  order: number;
};

export class FilePreviewState<Owner extends object> {
  private manual = new WeakMap<Owner, FilePreviewMode>();
  private automatic: OwnerRecord<Owner>[] = [];
  private current: OwnerRecord<Owner>[] = [];
  private records = new WeakMap<Owner, OwnerRecord<Owner>>();
  private currentSuccess = new WeakMap<Owner, string>();
  private pending = new Set<string>();
  private turnActive = false;
  private nextOrder = 0;

  observe(owner: Owner, toolCallId: string): void {
    const existing = this.records.get(owner);
    if (existing?.toolCallId === toolCallId) return;
    if (existing) this.removeRecord(owner, existing);
    this.manual.delete(owner);
    this.currentSuccess.delete(owner);
    const record: OwnerRecord<Owner> = { reference: new WeakRef(owner), toolCallId, order: this.nextOrder++ };
    this.records.set(owner, record);
  }

  beginTurn(): void {
    this.turnActive = true;
    this.clearCurrentTurn();
  }

  completed(toolCallId: string): void {
    if (this.turnActive) this.pending.add(toolCallId);
  }

  finalize(owner: Owner, toolCallId: string): boolean {
    const record = this.records.get(owner);
    if (!this.turnActive || !record || record.toolCallId !== toolCallId || !this.pending.delete(toolCallId)) return false;
    this.currentSuccess.set(owner, toolCallId);
    this.current.push(record);
    return true;
  }

  isCurrentSuccess(owner: Owner, toolCallId: string): boolean {
    return this.turnActive && this.currentSuccess.get(owner) === toolCallId;
  }

  mode(owner: Owner, toolCallId: string, globallyExpanded: boolean): FilePreviewMode {
    if (globallyExpanded) return 'full';
    const manual = this.manual.get(owner);
    if (manual) return manual;
    const current = this.turnActive && this.currentSuccess.get(owner) === toolCallId;
    const automatic = this.automatic.some(record => record.toolCallId === toolCallId && record.reference.deref() === owner);
    return current || automatic ? 'full' : 'preview';
  }

  toggle(owner: Owner, toolCallId: string, globallyExpanded: boolean): FilePreviewMode {
    const next = this.mode(owner, toolCallId, globallyExpanded) === 'full' ? 'preview' : 'full';
    this.manual.set(owner, next);
    return next;
  }

  candidates(): FilePreviewCandidate<Owner>[] {
    const entries = new Map<Owner, OwnerRecord<Owner>>();
    for (const record of [...this.automatic, ...this.current]) {
      const owner = record.reference.deref();
      if (owner && this.records.get(owner) === record) entries.set(owner, record);
    }
    return [...entries].map(([owner, record]) => ({ owner, toolCallId: record.toolCallId, order: record.order }))
      .sort((a, b) => a.order - b.order);
  }

  finishTurn(attached: readonly FilePreviewCandidate<Owner>[]): void {
    if (!this.turnActive) return;
    const allowed = new Map(attached.map(({ owner, toolCallId }) => [owner, toolCallId]));
    const entries = new Map<Owner, OwnerRecord<Owner>>();
    for (const record of [...this.automatic, ...this.current]) {
      const owner = record.reference.deref();
      if (owner && this.records.get(owner) === record && allowed.get(owner) === record.toolCallId) entries.set(owner, record);
    }
    this.automatic = [...entries.values()].sort((a, b) => a.order - b.order).slice(-10);
    this.clearCurrentTurn();
    this.turnActive = false;
  }

  detach(owner: Owner): void {
    const record = this.records.get(owner);
    if (record) this.removeRecord(owner, record);
    this.records.delete(owner);
    this.manual.delete(owner);
    this.currentSuccess.delete(owner);
  }

  reset(): void {
    this.manual = new WeakMap();
    this.automatic = [];
    this.current = [];
    this.records = new WeakMap();
    this.clearCurrentTurn();
    this.turnActive = false;
    this.nextOrder = 0;
  }

  private clearCurrentTurn(): void {
    this.current = [];
    this.currentSuccess = new WeakMap();
    this.pending.clear();
  }

  private removeRecord(owner: Owner, record: OwnerRecord<Owner>): void {
    this.automatic = this.automatic.filter(entry => entry !== record);
    this.current = this.current.filter(entry => entry !== record);
    this.records.delete(owner);
  }
}
