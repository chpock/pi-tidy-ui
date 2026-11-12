import type { PreferenceScope } from './preferences.ts';

/** Currentness for application continuations and unpublished switch saves, not teardown. */
export class ApplicationScope {
  private epoch = 0;
  private abort = new AbortController();

  get generation(): number { return this.epoch; }
  isGeneration(captured: number): boolean { return this.epoch === captured; }
  beginSession(): number {
    const captured = ++this.epoch;
    this.abort.abort();
    this.abort = new AbortController();
    return captured;
  }
  retire(): void { ++this.epoch; this.abort.abort(); }
  scope(captured: number): PreferenceScope {
    const owner = this;
    return {
      get signal() { return owner.abort.signal; },
      current: () => owner.isGeneration(captured) && !owner.abort.signal.aborted,
    };
  }
}
