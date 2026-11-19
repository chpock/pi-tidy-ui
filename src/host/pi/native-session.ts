import { Container, TruncatedText, type Component } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { ToolComponents, toolFields, type ToolComponentPorts } from './tool-components.ts';
import { UserComponents, type UserComponentPorts } from './user-components.ts';
import { NativeEditor, type NativeEditorOptions, type NativeTui } from './native-editor.ts';
import type { QueuedMessage, QueuedProjection } from '../../presentation/queued-presenter.ts';
import type { DiagnosticFields } from '../../diagnostics.ts';
import type { EditorStatusInfo } from '../../editor-status.ts';
import type { CardTheme } from '../../card-theme.ts';

interface SessionPorts {
  tool: Omit<ToolComponentPorts, 'fail'> & {
    restorePreview(owner: object): void;
    remove(owner: object): void;
    pause(owner: object): void;
  };
  user: Omit<UserComponentPorts, 'active' | 'fail' | 'decision'>;
  queued: {
    forget(owner: object): void;
    project(messages: readonly QueuedMessage<object>[], width: number, height: number,
      hint: string, projected: QueuedProjection<object>[]): number;
  };
  document: { running(): boolean; begin(): void; end(completed: boolean): void };
  theme(): CardTheme;
  decision(owner: object, area: string, choice: string, width: number, rows: number, fields?: DiagnosticFields, geometry?: string): void;
  failure(message: string): void;
  release(full: boolean): void;
}

interface SessionOptions extends NativeEditorOptions {
  warn?: (message: string) => void;
  editorStatusRestored?: () => void;
}

type ToolFacts = Pick<ToolComponents, 'isTool' | 'nativeRows' | 'imageRows' | 'hidden' | 'context' | 'setExpanded'
  | 'selfShell' | 'fileRenderer' | 'readRenderer' | 'deferredFilePair' | 'stockEditShell' | 'releaseFileRenderer' | 'syncRendererArgs'>;

function rendererRetirement(owner: WeakRef<NativeSession>) {
  return () => owner.deref()?.retireRendererClears();
}

/** One native installation and rollback authority; private families never close independently. */
export class NativeSession {
  private live = false;
  private failureReason: string | undefined;
  private readonly tui: NativeTui;
  private readonly parents = new WeakMap<object, { parent: Container; index: number }>();
  private clears: WeakRef<Component>[] = [];
  private clearPending = false;
  private readonly tools: ToolComponents;
  private readonly users: UserComponents;
  private readonly editor: NativeEditor;
  readonly fields = toolFields;
  readonly tool: ToolFacts;
  readonly user: Pick<UserComponents, 'text' | 'padding' | 'markdown' | 'markdownTheme' | 'transformers'>;
  private readonly originalAdd = Container.prototype.addChild;
  private readonly originalRender = Object.getOwnPropertyDescriptor(Container.prototype, 'render')!;
  private readonly originalClear = Container.prototype.clear;
  private readonly originalRemove = Container.prototype.removeChild;
  private readonly truncatedRender = TruncatedText.prototype.render;
  private readonly truncatedInvalidate = TruncatedText.prototype.invalidate;
  private readonly add: Container['addChild'];
  private readonly clear: Container['clear'];
  private readonly remove: Container['removeChild'];
  private readonly render: Container['render'];

  private readonly ports: SessionPorts;
  private readonly options: SessionOptions;

  constructor(root: object, ports: SessionPorts, options: SessionOptions = {}) {
    this.ports = ports; this.options = options;
    this.tui = root as NativeTui;
    this.tools = new ToolComponents({ ...ports.tool, fail: message => this.fail(message) });
    this.tool = this.tools;
    this.users = new UserComponents({ ...ports.user, active: () => this.live, fail: message => this.fail(message),
      decision: (owner, width, rows) => ports.decision(owner, 'user', 'Native Markdown rows projected by user-card policy; inner fallback cause is unknown', width, rows) });
    this.user = this.users;
    const owner = this;
    this.add = function (this: Container, child: Component) {
      owner.originalAdd.call(this, child);
      try { owner.visit(child, this, this.children.length - 1); }
      catch (error) {
        // A second fail() would hide an exception from restoration or warning.
        if (owner.reason !== undefined) throw error;
        owner.fail('pi-tidy-ui could not install its UI hooks; native rendering restored');
      }
    };
    this.remove = function (this: Container, child: Component) {
      owner.originalRemove.call(this, child);
      if (!this.children.includes(child) && !owner.attached(child)) owner.releaseTree(child);
    };
    this.clear = function (this: Container) { owner.clearContainer(this); };
    this.render = function (this: Container, width: number) { return owner.renderDocument(this, width); };
    this.editor = new NativeEditor(this.tui, options, {
      active: () => this.live, attached: node => this.attached(node), parent: node => this.parents.get(node)?.parent,
      theme: ports.theme, fail: message => this.fail(message), decision: ports.decision,
    }, { render: this.render, clear: this.clear, addChild: this.add });
  }

  get active(): boolean { return this.live; }
  get reason(): string | undefined { return this.failureReason; }
  get editorActive(): boolean { return this.editor.active; }
  get editorStatusActive(): boolean { return this.editor.statusActive; }
  renderEditorStatus(width: number, info: EditorStatusInfo): string[] { return this.editor.renderStatus(width, info); }
  selection(): boolean { return this.tui.hasActiveSelection?.() ?? false; }
  refresh(): void { this.tui.invalidate(); this.tui.requestRender(); }

  attached(owner: object): boolean {
    let current = owner;
    while (current !== this.tui) {
      if (current instanceof Container && this.tui instanceof Container && current.children === this.tui.children) return true;
      const position = this.parents.get(current);
      if (!position) return false;
      const children = position.parent.children;
      if (children[position.index] !== current) position.index = children.indexOf(current as Component);
      if (position.index < 0) return false;
      current = position.parent;
    }
    return true;
  }
  siblings(owner: object): readonly object[] { return this.parents.get(owner)?.parent.children ?? []; }
  index(owner: object, siblings: readonly object[]): number {
    const position = this.parents.get(owner); let current = position?.index ?? -1;
    if (siblings[current] !== owner) { current = siblings.indexOf(owner); if (position) position.index = current; }
    return current;
  }
  otherRows(owner: object, width: number): string[] {
    return this.users.borrowedRows(owner, width) ?? this.tools.nativeRows(owner, width);
  }

  private fail(message: string): void {
    if (this.failureReason) return;
    this.failureReason = message;
    this.ports.failure(message);
    this.restore();
    this.options.warn?.(message);
  }

  install(): void {
    if (!(this.tui instanceof Container) || typeof this.tui.requestRender !== 'function') {
      this.fail('The live Pi TUI does not share the host Container; native rendering retained'); return;
    }
    try {
      this.live = true;
      this.visit(this.tui);
      if (this.live) {
        Container.prototype.addChild = this.add;
        Container.prototype.clear = this.clear;
        Container.prototype.removeChild = this.remove;
        Object.defineProperty(Container.prototype, 'render', { ...this.originalRender, value: this.render });
        this.editor.publishSpacer();
        this.editor.finishInstallation();
        this.refresh();
      }
    } catch { this.fail('pi-tidy-ui could not install its UI hooks; native rendering restored'); }
  }

  restore({ repaint = true } = {}): void {
    if (!this.live && !this.tools.patched && !this.users.patched && !this.editor.patched) {
      this.ports.release(false); return;
    }
    this.live = false;
    this.clears = []; this.clearPending = false;
    this.ports.release(true);
    if (Container.prototype.addChild === this.add) Container.prototype.addChild = this.originalAdd;
    if (Container.prototype.clear === this.clear) Container.prototype.clear = this.originalClear;
    if (Container.prototype.removeChild === this.remove) Container.prototype.removeChild = this.originalRemove;
    if (Container.prototype.render === this.render) Object.defineProperty(Container.prototype, 'render', this.originalRender);
    this.editor.restoreObservations();
    this.tools.restore();
    this.users.restore();
    this.editor.restore();
    this.options.editorStatusRestored?.();
    if (repaint) this.refresh();
  }

  private visit(node: Component, parent?: Container, index = -1): void {
    if (!this.live) return;
    if (parent) this.parents.set(node, { parent, index });
    if (this.tools.isTool(node)) {
      this.ports.tool.restorePreview(node);
      this.tools.install(node);
    } else if (this.users.isUser(node)) this.users.install(node);
    else if (this.editor.isEditor(node)) this.editor.install(node);
    if (node instanceof Container) node.children.forEach((child, index) => this.visit(child, node, index));
  }
  private releaseTree(node: Component): void {
    this.ports.queued.forget(node);
    if (this.tools.isTool(node)) this.ports.tool.remove(node);
    else if (this.users.isUser(node)) this.ports.user.forget(node);
    this.parents.delete(node);
    if (node instanceof Container) for (const child of node.children) if (!this.attached(child)) this.releaseTree(child);
  }
  private pauseRendererTree(node: Component): void {
    if (this.tools.isTool(node)) this.ports.tool.pause(node);
    if (node instanceof Container) for (const child of node.children) this.pauseRendererTree(child);
  }
  private clearContainer(group: Container): void {
    const children = group.children;
    // The real renderer clears before synchronously moving the same tree through
    // Pi's stable TUI reference. Ordinary detach instead releases immediately.
    const renderer = this.tui instanceof Container && group !== this.tui && children === this.tui.children;
    this.originalClear.call(group);
    for (const child of children) if (!group.children.includes(child) && !this.attached(child)) {
      if (!renderer) this.releaseTree(child);
      else { this.pauseRendererTree(child); this.clears.push(new WeakRef(child)); }
    }
    if (this.clears.length && !this.clearPending) {
      this.clearPending = true;
      queueMicrotask(rendererRetirement(new WeakRef(this)));
    }
  }
  retireRendererClears(): void {
    const detached = this.clears; this.clears = []; this.clearPending = false;
    if (this.live) for (const reference of detached) {
      const node = reference.deref(); if (node && !this.attached(node)) this.releaseTree(node);
    }
  }

  private renderDocument(group: Container, width: number): string[] {
    const document = this.tui instanceof Container && (group === this.tui ||
      (group === this.tui.children[0] && Object.getPrototypeOf(group) === Container.prototype));
    if (!this.live || !document || this.ports.document.running()) return this.renderContainer(group, width);
    try { this.ports.document.begin(); }
    catch { this.fail('Pi Output padding could not be read; native rendering restored'); return this.originalRender.value.call(group, width) as string[]; }
    let completed = false;
    try {
      const rows = this.renderContainer(group, width);
      completed = true; return rows;
    } finally { this.ports.document.end(completed); }
  }
  private renderContainer(group: Container, width: number): string[] {
    if (this.live) {
      try { const rows = this.queuedRows(group, width); if (rows) return rows; }
      catch { this.fail('pi-tidy-ui could not render queued messages; native rendering restored'); }
    }
    return this.editor.renderContainer(group, width, this.originalRender.value as Container['render']);
  }

  private renderQueued(group: Container, width: number, projections: readonly { node: Component; rows: string[] }[]): string[] {
    const restores: { node: Component; own?: PropertyDescriptor; render: Component['render'] }[] = [];
    try {
      for (const { node, rows } of projections) {
        const own = Object.getOwnPropertyDescriptor(node, 'render'), original = node.render;
        const render = function (this: Component, requestedWidth: number) {
          return requestedWidth === width ? rows : original.call(this, requestedWidth);
        };
        Object.defineProperty(node, 'render', { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: render });
        restores.push({ node, own, render });
      }
      // Native Container.render refreshes its hit geometry and strong traversal
      // references; returning a fabricated aggregate would leave both stale.
      return this.originalRender.value.call(group, width) as string[];
    } finally {
      for (const { node, own, render } of restores) if (Object.getOwnPropertyDescriptor(node, 'render')?.value === render) {
        if (own) Object.defineProperty(node, 'render', own); else Reflect.deleteProperty(node, 'render');
      }
    }
  }
  private queueHooksOwned(group: Container): boolean {
    return group.render === this.render && group.addChild === this.add && group.clear === this.clear && group.removeChild === this.remove;
  }
  private queueText(node: Component): string | undefined {
    if (Object.getPrototypeOf(node) !== TruncatedText.prototype || node.render !== this.truncatedRender || node.invalidate !== this.truncatedInvalidate) return undefined;
    const value: unknown = Object.getOwnPropertyDescriptor(node, 'text')?.value;
    return typeof value === 'string' ? value : undefined;
  }
  private queuedRows(group: Container, width: number): string[] | undefined {
    if (!(this.tui instanceof Container) || this.tui.children[1] !== group) return undefined;
    const fallback = () => {
      for (const child of group.children) this.ports.queued.forget(child);
      this.ports.decision(group, 'queued', 'Queued-message projection delegated; no supported native prefix', width, 0); return undefined;
    };
    const height = this.tui.terminal?.rows, slots = this.tui.children, children = group.children, spacer = children[0];
    if (slots.length !== 7 || !slots.every(node => Object.getPrototypeOf(node) === Container.prototype) || !this.queueHooksOwned(group) ||
      typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1 ||
      !spacer || !this.editor.isObservedSpacer(spacer)) return fallback();
    const messages: QueuedMessage<object>[] = [];
    let index = 1, hint = '';
    for (; index < children.length; index++) {
      const node = children[index]!, raw = this.queueText(node);
      if (raw === undefined) return fallback();
      const match = /^(?:\x1b\[[0-9;:]*m)*(Steering|Follow-up): /u.exec(raw);
      if (match) { messages.push({ node, raw, mode: match[1] as 'Steering' | 'Follow-up', prefix: match[0].length }); continue; }
      const label = /^↳ (.+ to edit all queued messages)$/u.exec(stripVTControlCharacters(raw));
      if (!label) return fallback();
      hint = label[1]!; break;
    }
    if (!messages.length || !hint) return fallback();
    const prefix = children.slice(0, index + 1);
    if (!prefix.every(node => {
      const own = Object.getOwnPropertyDescriptor(node, 'render');
      return own ? 'value' in own && own.configurable : Object.isExtensible(node);
    })) return fallback();
    if (width < 1) return this.renderQueued(group, width, prefix.map(node => ({ node, rows: [] })));
    const spacerRows = spacer.render(width);
    if (spacerRows.length !== 1 || spacerRows[0] !== '') {
      fallback(); return this.renderQueued(group, width, [{ node: spacer, rows: spacerRows }]);
    }
    const projected: QueuedProjection<object>[] = [];
    const rowCount = spacerRows.length + this.ports.queued.project(messages, width, height, hint, projected);
    this.ports.decision(group, 'queued', 'Verified queued-message prefix projected; Pi still owns editing and dock clipping', width, rowCount,
      { height, messages: messages.length });
    return this.renderQueued(group, width, [{ node: spacer, rows: spacerRows },
      ...projected as { node: Component; rows: string[] }[], { node: children[index]!, rows: [] }]);
  }
}
