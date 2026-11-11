import { Container, Markdown } from '@earendil-works/pi-tui';
import type { NativeUserRender, UserPresentationLayout } from '../../presentation/user-presenter.ts';

interface UserNode extends Container {
  text: string;
  outputPad: number;
  markdownTheme: object;
  markdownTransformers: unknown[];
  rebuild(): void;
  setOutputPad(padding: number): void;
}

export interface UserComponentPorts {
  active(): boolean;
  fail(message: string): void;
  forget(owner: object): void;
  layout(owner: object, width: number, native: NativeUserRender<object>): UserPresentationLayout;
  present(owner: object, width: number, rows: string[]): string[];
  decision(owner: object, width: number, rows: number): void;
}

/** Borrows native Markdown and owns prototype restoration, never presentation rows. */
export class UserComponents {
  private readonly patches = new Map<object, {
    render: PropertyDescriptor; patchedRender: NativeUserRender<object>;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();

  private readonly ports: UserComponentPorts;

  constructor(ports: UserComponentPorts) { this.ports = ports; }

  get patched(): boolean { return this.patches.size > 0; }

  isUser(owner: object): boolean {
    return owner instanceof Container && owner.constructor.name === 'UserMessageComponent';
  }

  private compatible(node: UserNode): boolean {
    return typeof node.text === 'string' && Number.isSafeInteger(node.outputPad) && node.outputPad >= 0 &&
      typeof node.markdownTheme === 'object' && node.markdownTheme !== null && Array.isArray(node.markdownTransformers) &&
      typeof node.rebuild === 'function' && typeof node.setOutputPad === 'function' &&
      node.children.length === 1 && node.children[0] instanceof Markdown;
  }

  install(owner: object): void {
    if (!this.compatible(owner as UserNode)) { this.ports.fail('User-message component contract is incompatible; native rendering retained'); return; }
    this.patchPrototype(Object.getPrototypeOf(owner) as object);
  }

  text(owner: object): string { return (owner as UserNode).text; }
  padding(owner: object): number { return (owner as UserNode).outputPad; }
  markdown(owner: object): object | undefined { return (owner as UserNode).children[0]; }
  markdownTheme(owner: object): object { return (owner as UserNode).markdownTheme; }
  transformers(owner: object): unknown[] { return (owner as UserNode).markdownTransformers; }

  borrowedRows(owner: object, width: number): string[] | undefined {
    const render = this.isUser(owner) ? this.patches.get(Object.getPrototypeOf(owner))?.render.value as NativeUserRender<object> | undefined : undefined;
    return render ? this.ports.layout(owner, width, render).rows : undefined;
  }

  // No installer instance is in the lexical scope retained by these wrappers.
  private patchPrototype(prototype: object): void {
    if (this.patches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, 'render');
    if (!render?.writable || !render.configurable || typeof render.value !== 'function') {
      this.ports.fail('User-message rendering cannot be safely replaced; native rendering retained'); return;
    }
    const owner = this, ports = this.ports;
    const originalRender = render.value as NativeUserRender<object>;
    const patchedRender: NativeUserRender<object> = function (width) {
      if (!ports.active()) return originalRender.call(this, width);
      if (width < 1) return [];
      try {
        if (!owner.compatible(this as UserNode)) throw new Error('User-message component contract changed');
        const rows = ports.layout(this, width, originalRender).rows;
        ports.decision(this, width, rows.length);
        return ports.present(this, width, rows);
      } catch {
        ports.fail('pi-tidy-ui could not render this user message; native rendering restored');
        return originalRender.call(this, width);
      }
    };
    const updates = ['rebuild', 'setOutputPad', 'invalidate'].map(name => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== 'function' || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error('User-message invalidation methods cannot be wrapped');
      const wrapper = function (this: object, ...args: unknown[]) { ports.forget(this); return method.apply(this, args); };
      return { name, original, wrapper };
    });
    this.patches.set(prototype, { render, patchedRender, updates });
    Object.defineProperty(prototype, 'render', { ...render, value: patchedRender });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }

  restore(): void {
    for (const [prototype, patch] of this.patches) {
      if (Object.getOwnPropertyDescriptor(prototype, 'render')?.value === patch.patchedRender)
        Object.defineProperty(prototype, 'render', patch.render);
      for (const update of patch.updates) {
        if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
        if (update.original) Object.defineProperty(prototype, update.name, update.original);
        else Reflect.deleteProperty(prototype, update.name);
      }
    }
    this.patches.clear();
  }
}
