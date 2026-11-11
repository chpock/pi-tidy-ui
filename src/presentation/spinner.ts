import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import { SPINNER_INTERVAL_MS } from './tool-view-presenter.ts';
import type { ToolFieldAccessors } from './tool-producers.ts';

interface SpinnerPorts<Owner extends object> {
  active(): boolean;
  quiescing(): boolean;
  executing(owner: Owner): boolean;
  attached(owner: Owner): boolean;
  requestRender(): void;
  fields: Pick<ToolFieldAccessors<Owner>, 'id' | 'name'>;
  diagnostic?: DiagnosticSink;
}

/** One weak participant set and the existing fallback deadline, never a second periodic clock. */
export class PresentationSpinner<Owner extends object> {
  private readonly animated = new Set<WeakRef<Owner>>();
  private references = new WeakMap<Owner, WeakRef<Owner>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started: number | undefined;
  private passTime: number | undefined;
  private generation = 0;
  private pending = false;
  private wakes = 0;
  private requests = 0;

  private readonly ports: SpinnerPorts<Owner>;

  constructor(ports: SpinnerPorts<Owner>) { this.ports = ports; }

  time(): number { return this.passTime ?? performance.now(); }
  epoch(): number | undefined { return this.started; }
  beginPass(): void { this.passTime = performance.now(); }

  endPass(completed: boolean): void {
    this.passTime = undefined;
    if (!completed || !this.ports.active()) return;
    this.prune();
    this.pending = false;
    this.arm();
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
    this.pending = false;
    this.started = undefined;
  }

  reset(): void {
    this.stop();
    this.animated.clear();
    this.references = new WeakMap();
  }

  remove(owner: Owner): void {
    const reference = this.references.get(owner);
    if (reference) {
      this.animated.delete(reference); this.references.delete(owner);
      diagnose(this.ports.diagnostic, 'DEBUG', 'animation', 'Tool stopped participating in the existing spinner',
        { call: this.ports.fields.id(owner), tool: this.ports.fields.name(owner) });
    }
    if (!this.animated.size) this.stop();
  }

  private prune(): void {
    for (const reference of this.animated) {
      const owner = reference.deref();
      if (!owner) this.animated.delete(reference);
      else if (!this.ports.executing(owner) || !this.ports.attached(owner)) this.remove(owner);
    }
    if (!this.animated.size) this.stop();
  }

  private arm(): void {
    if (!this.ports.active() || this.ports.quiescing() || !this.animated.size || this.pending) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const generation = ++this.generation, owner = this;
    // A successful native document visit postpones this one-shot fallback. It is
    // not a terminal-output receipt, and direct tool visits do not acknowledge it.
    this.timer = setTimeout(function tickSpinner() {
      if (!owner.ports.active() || generation !== owner.generation) return;
      owner.timer = undefined;
      owner.wakes++;
      owner.prune();
      if (!owner.animated.size) return;
      owner.pending = true;
      owner.requests++;
      owner.ports.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  animate(owner: Owner): void {
    if (!this.ports.executing(owner) || !this.ports.attached(owner)) { this.remove(owner); return; }
    if (!this.references.has(owner)) {
      const reference = new WeakRef(owner); this.references.set(owner, reference); this.animated.add(reference);
      diagnose(this.ports.diagnostic, 'DEBUG', 'animation', 'Tool participates in the existing spinner; no logging clock added',
        { call: this.ports.fields.id(owner), tool: this.ports.fields.name(owner) });
    }
    this.started ??= this.passTime ?? performance.now();
    if (this.passTime === undefined && this.timer === undefined) this.arm();
  }

  snapshot() {
    return { wakes: this.wakes, requests: this.requests, participants: this.animated.size,
      timer: this.timer !== undefined, pending: this.pending };
  }
}
