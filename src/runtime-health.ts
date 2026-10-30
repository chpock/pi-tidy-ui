import type { DiagnosticSink, RuntimeArea, RuntimeEvent } from './diagnostics.ts';

export interface RuntimeIssue {
  area: RuntimeArea; operation: string; code: string; time: string;
  state: 'active' | 'recovered' | 'released';
}
export interface RuntimeHealthSnapshot {
  errors: number; active: number; last?: RuntimeIssue; issues: RuntimeIssue[];
}
interface OwnedIssue { owner: WeakRef<object>; issue: RuntimeIssue; group: string }
const labels: Record<RuntimeArea, string> = { syntax: 'Syntax highlighting', appearance: 'Interface styling',
  'terminal-colors': 'Terminal colors', settings: 'Settings', git: 'Git metadata' };
function notification(owner: WeakRef<RuntimeHealth>) { return () => owner.deref()?.deliver(); }

/** Session-local health, not a log reader or an owner of cards, sources or errors. */
export class RuntimeHealth {
  private readonly owners = new WeakMap<object, Map<string, OwnedIssue>>();
  private readonly active = new Set<OwnedIssue>();
  private readonly groups = new Map<string, number>();
  private errors = 0;
  private last?: RuntimeIssue;
  private disposed = false;
  private scheduled = false;
  private pending = new Map<string, RuntimeIssue>();
  private readonly owner = new WeakRef(this);
  private readonly notify: (message: string) => void;
  private readonly now: () => number;
  constructor(notify: (message: string) => void, now: () => number = Date.now) { this.notify = notify; this.now = now; }

  /** The sink holds a weak health reference; a retained job cannot keep the UI alive. */
  sink(journal: DiagnosticSink): DiagnosticSink {
    const owner = this.owner;
    const sink: DiagnosticSink = (level, area, explanation, fields) => journal(level, area, explanation, fields);
    sink.runtime = event => owner.deref()?.event(event);
    return sink;
  }
  event(event: RuntimeEvent): void {
    if (this.disposed) return;
    const operations = this.owners.get(event.scope), previous = operations?.get(event.operation);
    if (event.kind === 'released' && event.operation === '*') {
      if (operations) for (const record of operations.values()) this.retire(record, 'released');
      operations?.clear(); return;
    }
    if (event.kind !== 'failure') {
      if (previous) { this.retire(previous, event.kind); operations!.delete(event.operation); }
      return;
    }
    if (previous && previous.issue.code === event.code && previous.issue.area === event.area) return;
    if (previous) this.retire(previous, 'released');
    // Lease generations distinguish recovery ownership, not notification categories.
    const operation = event.operation.startsWith('lease:') ? 'lease' : event.operation;
    const group = `${event.area}:${operation}:${event.code}`;
    const notify = !this.groups.has(group);
    const issue: RuntimeIssue = { area: event.area, operation: event.operation, code: event.code,
      time: new Date(this.now()).toISOString(), state: 'active' };
    const record = { owner: new WeakRef(event.scope), issue, group };
    this.groups.set(group, (this.groups.get(group) ?? 0) + 1);
    const entries = operations ?? new Map<string, OwnedIssue>();
    if (!operations) this.owners.set(event.scope, entries);
    entries.set(event.operation, record); this.active.add(record); this.last = issue; this.errors++;
    if (notify) {
      this.pending.set(group, issue);
      if (!this.scheduled) { this.scheduled = true; queueMicrotask(notification(this.owner)); }
    }
  }
  private retire(record: OwnedIssue, state: 'recovered' | 'released'): void {
    record.issue.state = state; this.active.delete(record);
    const remaining = this.groups.get(record.group)! - 1;
    if (remaining) this.groups.set(record.group, remaining); else this.groups.delete(record.group);
  }
  private sweep(): void {
    for (const record of this.active) if (!record.owner.deref()) this.retire(record, 'released');
  }
  snapshot(): RuntimeHealthSnapshot {
    this.sweep();
    // One current example per subsystem, not an unbounded UI list of failed cards.
    const areas = new Map<RuntimeArea, RuntimeIssue>();
    for (const record of this.active) areas.set(record.issue.area, { ...record.issue });
    return { errors: this.errors, active: this.active.size, last: this.last && { ...this.last }, issues: [...areas.values()] };
  }
  deliver(): void {
    this.scheduled = false;
    const pending = this.pending; this.pending = new Map();
    for (const issue of pending.values()) {
      if (this.disposed) return;
      try { this.notify(issue.code === 'owned_palette_unavailable'
        ? 'pi-tidy-ui: A selected built-in color palette could not be loaded. Existing card colors are retained; cards without a prior palette may use Pi colors. Details: /tidy-ui → Status & troubleshooting.'
        : `pi-tidy-ui: ${labels[issue.area]} encountered an unexpected error (${issue.code}). Some features may use fallback presentation. Details: /tidy-ui → Status & troubleshooting.`); }
      catch { /* A failed host notification cannot affect presentation or work. */ }
    }
  }
  dispose(): void {
    this.disposed = true; this.pending.clear();
    for (const record of this.active) this.retire(record, 'released');
  }
}
