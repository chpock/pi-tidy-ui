import type { FileChangeClass } from '../cards/file-model.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import type { ToolCallSnapshot, ToolReader, ToolCardKind } from '../tool-adapters/contracts.ts';

export interface FilePreviewCandidate<Owner extends object> {
  owner: Owner;
  toolCallId: string;
  order: number;
}

export type ToolCallState = {
  input?: { name: string; args: ToolCallSnapshot['args']; valid: boolean; kind?: ToolCardKind };
  snapshot?: ToolCallSnapshot;
  reader?: ToolReader | null;
  hasImage?: boolean;
  fileChange?: { key: readonly unknown[]; value: FileChangeClass | null };
  manualView?: FilePreviewMode;
  currentTurn?: object;
  nativeUpdateDepth?: number;
  nativeInputsDirty?: boolean;
};

type OwnerRecord<Owner extends object> = {
  reference: WeakRef<Owner>;
  toolCallId: string;
  order: number;
};
type RecordEntry<Owner extends object> = { membership: OwnerRecord<Owner>; state: ToolCallState };

export class ToolCallStates<Owner extends object> {
  private records = new WeakMap<Owner, RecordEntry<Owner>>();
  // The rolling window tracks owners, never their observations or resources.
  private automatic: OwnerRecord<Owner>[] = [];
  private current: OwnerRecord<Owner>[] = [];
  private pending = new Set<string>();
  private turn: object | undefined;
  private nextOrder = 0;

  observe(owner: Owner, toolCallId: string): ToolCallState {
    const existing = this.records.get(owner);
    if (existing?.membership.toolCallId === toolCallId) return existing.state;
    if (existing) this.detach(owner);
    const membership = { reference: new WeakRef(owner), toolCallId, order: this.nextOrder++ };
    const state: ToolCallState = {};
    this.records.set(owner, { membership, state });
    return state;
  }

  peek(owner: Owner): ToolCallState | undefined { return this.records.get(owner)?.state; }

  beginTurn(): void {
    this.clearCurrentTurn();
    this.turn = {};
  }

  completed(toolCallId: string): void {
    if (this.turn) this.pending.add(toolCallId);
  }

  finalize(owner: Owner, toolCallId: string): boolean {
    const record = this.records.get(owner);
    if (!this.turn || !record || record.membership.toolCallId !== toolCallId || !this.pending.delete(toolCallId)) return false;
    record.state.currentTurn = this.turn;
    this.current.push(record.membership);
    return true;
  }

  isCurrentSuccess(owner: Owner, toolCallId: string): boolean {
    const record = this.records.get(owner);
    return !!this.turn && record?.membership.toolCallId === toolCallId && record.state.currentTurn === this.turn;
  }

  mode(owner: Owner, toolCallId: string, globallyExpanded: boolean): FilePreviewMode {
    if (globallyExpanded) return 'full';
    const record = this.records.get(owner);
    if (!record || record.membership.toolCallId !== toolCallId) return 'preview';
    return record.state.manualView ?? (this.isCurrentSuccess(owner, toolCallId) || this.automatic.includes(record.membership) ? 'full' : 'preview');
  }

  toggle(owner: Owner, toolCallId: string, globallyExpanded: boolean): FilePreviewMode {
    const next = this.mode(owner, toolCallId, globallyExpanded) === 'full' ? 'preview' : 'full';
    this.observe(owner, toolCallId).manualView = next;
    return next;
  }

  candidates(): FilePreviewCandidate<Owner>[] {
    const entries = new Map<Owner, OwnerRecord<Owner>>();
    for (const record of [...this.automatic, ...this.current]) {
      const owner = record.reference.deref();
      if (owner && this.records.get(owner)?.membership === record) entries.set(owner, record);
    }
    return [...entries].map(([owner, record]) => ({ owner, toolCallId: record.toolCallId, order: record.order }))
      .sort((a, b) => a.order - b.order);
  }

  finishTurn(attached: readonly FilePreviewCandidate<Owner>[]): void {
    if (!this.turn) return;
    const allowed = new Map(attached.map(({ owner, toolCallId }) => [owner, toolCallId]));
    const entries = new Map<Owner, OwnerRecord<Owner>>();
    for (const record of [...this.automatic, ...this.current]) {
      const owner = record.reference.deref();
      if (owner && this.records.get(owner)?.membership === record && allowed.get(owner) === record.toolCallId) entries.set(owner, record);
    }
    this.automatic = [...entries.values()].sort((a, b) => a.order - b.order).slice(-10);
    this.clearCurrentTurn();
    this.turn = undefined;
  }

  detach(owner: Owner): void {
    const record = this.records.get(owner)?.membership;
    if (!record) return;
    this.automatic = this.automatic.filter(entry => entry !== record);
    this.current = this.current.filter(entry => entry !== record);
    this.records.delete(owner);
  }

  reset(): void {
    this.automatic = [];
    this.current = [];
    this.records = new WeakMap();
    this.clearCurrentTurn();
    this.turn = undefined;
    this.nextOrder = 0;
  }

  private clearCurrentTurn(): void {
    this.current = [];
    this.pending.clear();
  }
}
