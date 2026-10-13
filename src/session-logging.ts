import { randomUUID } from 'node:crypto';
import { TextJournal, type JournalIdentity, type JournalOptions } from './debug-log.ts';
import type { DiagnosticSink } from './diagnostics.ts';

/** Run-bound observer: an explicit writer retry is not a new Pi session. */
export class SessionLogging {
  private readonly identity: JournalIdentity;
  private readonly options: JournalOptions;
  private journal: TextJournal;
  private enabled = true;
  private closed = false;
  private retrying?: Promise<void>;
  readonly sink: DiagnosticSink = (level, area, explanation, fields) => {
    if (!this.closed && this.enabled) this.journal.record(level, area, explanation, fields);
  };

  constructor(identity: JournalIdentity, options: JournalOptions = {}) {
    this.identity = { ...identity, run: identity.run ?? randomUUID() }; this.options = options;
    this.journal = new TextJournal(this.identity, options);
  }
  ready() { return this.journal.ready; }
  flush() { return this.journal.flush(); }
  status() { return { ...this.journal.status(), session: this.identity.session, name: this.identity.name,
    sessionFile: this.identity.sessionFile, capture: this.enabled && !this.closed }; }
  nameChanged(name?: string): void {
    if (this.closed || this.identity.name === name) return;
    this.identity.name = name;
    this.sink('INFO', 'runtime', 'Pi session name changed', { name: name ?? 'cleared' });
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.enabled = enabled;
    if (!enabled) { this.journal.setEnabled(false); return this.journal.flush(); }
    if (this.retrying) return this.retrying;
    if (this.journal.status().state !== 'failed') { this.journal.setEnabled(true); return Promise.resolve(); }
    this.retrying = this.retry().finally(() => { this.retrying = undefined; });
    return this.retrying;
  }
  private async retry(): Promise<void> {
    await this.journal.close('logging retry');
    if (this.closed) return;
    this.journal = new TextJournal({ ...this.identity, reason: `logging retry after ${this.identity.reason}` }, this.options);
    await this.journal.ready;
    if (!this.closed) { this.journal.setEnabled(this.enabled); if (!this.enabled) await this.journal.flush(); }
  }
  close(reason: string): Promise<void> {
    this.closed = true;
    return this.journal.close(reason);
  }
}
