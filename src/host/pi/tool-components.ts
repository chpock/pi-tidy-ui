import { Box, Container, Image, Spacer, type Component } from '@earendil-works/pi-tui';
import type { NativeToolRender, NativeToolMouse, NativeToolUpdate, ToolUpdateName } from '../../presentation/tool-view-presenter.ts';
import type { ToolFieldAccessors } from '../../presentation/tool-producers.ts';
import { isDeferredStockEditComponent, isDeferredStockEditPair, isDeferredStockFileCall, isDeferredStockFilePair,
  isDeferredStockReadPair, releaseNativeRendererCache, updateNativeRendererArgs, stockEditCall, stockEditResult } from './lazy-native-renderers.ts';

/** The inspected native contract; never import a second internal ToolExecutionComponent class. */
interface ToolNode extends Component {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expanded: boolean;
  hideComponent: boolean;
  isPartial: boolean;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown; role?: unknown };
  markExecutionStarted(): void;
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  setExpanded(expanded: boolean): void;
  getRenderContext(): unknown;
  getRenderShell(): string;
  callRendererComponent?: Component;
  getCallRenderer?(): unknown;
  getResultRenderer?(): unknown;
}

export const toolFields: ToolFieldAccessors<object> = {
  name: owner => (owner as ToolNode).toolName, id: owner => (owner as ToolNode).toolCallId,
  args: owner => (owner as ToolNode).args, result: owner => (owner as ToolNode).result,
  partial: owner => (owner as ToolNode).isPartial, expanded: owner => (owner as ToolNode).expanded,
  executionStarted: owner => (owner as ToolNode).executionStarted, argsComplete: owner => (owner as ToolNode).argsComplete,
};

export interface ToolComponentPorts {
  fail(message: string): void;
  attach(owner: object): void;
  render(owner: object, width: number, native: NativeToolRender<object>): string[];
  mouse(owner: object, event: Parameters<NativeToolMouse<object>>[0], render: NativeToolRender<object>, native: NativeToolMouse<object>): ReturnType<NativeToolMouse<object>>;
  update(owner: object, name: ToolUpdateName, args: unknown[], native: NativeToolUpdate<object>): unknown;
}

type Patch = {
  render: PropertyDescriptor; mouse: PropertyDescriptor;
  patchedRender: NativeToolRender<object>; patchedMouse: NativeToolMouse<object>;
  updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
};

/** Prototype ownership and native borrows only; card policy belongs to the caller. */
export class ToolComponents {
  private readonly patches = new Map<object, Patch>();

  private readonly ports: ToolComponentPorts;

  constructor(ports: ToolComponentPorts) { this.ports = ports; }

  get patched(): boolean { return this.patches.size > 0; }

  isTool(owner: object): boolean {
    const node = owner as Partial<ToolNode>;
    return typeof node.toolCallId === 'string' && typeof node.toolName === 'string';
  }

  private compatible(node: ToolNode): boolean {
    return node instanceof Container && typeof node.expanded === 'boolean' &&
      typeof node.hideComponent === 'boolean' && typeof node.isPartial === 'boolean' &&
      typeof node.executionStarted === 'boolean' && typeof node.argsComplete === 'boolean' &&
      !!node.args && typeof node.args === 'object' && !Array.isArray(node.args) &&
      typeof node.markExecutionStarted === 'function' && typeof node.updateArgs === 'function' && typeof node.updateResult === 'function' &&
      typeof node.setExpanded === 'function' && typeof node.getRenderContext === 'function' &&
      typeof node.getRenderShell === 'function' &&
      typeof node.render === 'function' && typeof node.handleMouse === 'function';
  }

  install(owner: object): void {
    if (!this.compatible(owner as ToolNode)) { this.ports.fail('Tool component contract is incompatible; native rendering retained'); return; }
    this.patchPrototype(Object.getPrototypeOf(owner) as object);
    this.ports.attach(owner);
  }

  // Persistent wrappers are created without an installer-node parameter.
  private patchPrototype(prototype: object): void {
    if (this.patches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, 'render');
    const mouse = Object.getOwnPropertyDescriptor(prototype, 'handleMouse');
    if (!render?.writable || !mouse?.writable || typeof render.value !== 'function' || typeof mouse.value !== 'function') {
      this.ports.fail('Tool rendering methods cannot be safely replaced; native rendering retained'); return;
    }
    const ports = this.ports;
    const originalRender = render.value as NativeToolRender<object>;
    const originalMouse = mouse.value as NativeToolMouse<object>;
    const patchedRender: NativeToolRender<object> = function (width) {
      try { return ports.render(this, width, originalRender); }
      catch { ports.fail('pi-tidy-ui could not render this component; native rendering restored'); return originalRender.call(this, width); }
    };
    const patchedMouse: NativeToolMouse<object> = function (event) {
      return ports.mouse(this, event, originalRender, originalMouse);
    };
    const updateNames: ToolUpdateName[] = ['updateArgs', 'updateResult', 'setExpanded', 'invalidate', 'markExecutionStarted'];
    for (const name of ['setShowImages', 'setImageWidthCells'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value === 'function' && descriptor.writable && descriptor.configurable) updateNames.push(name);
    }
    const argsCompleteDescriptor = Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete');
    if (typeof argsCompleteDescriptor?.value === 'function' && argsCompleteDescriptor.writable && argsCompleteDescriptor.configurable)
      updateNames.push('setArgsComplete');
    const updates = updateNames.map(name => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== 'function' || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error('Tool cache invalidation methods cannot be wrapped');
      const wrapper = function (this: object, ...args: unknown[]) {
        return ports.update(this, name, args, method as NativeToolUpdate<object>);
      };
      return { name, original, wrapper };
    });
    this.patches.set(prototype, { render, mouse, patchedRender, patchedMouse, updates });
    Object.defineProperty(prototype, 'render', { ...render, value: patchedRender });
    Object.defineProperty(prototype, 'handleMouse', { ...mouse, value: patchedMouse });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }

  restore(): void {
    for (const [prototype, patch] of this.patches) {
      if (Object.getOwnPropertyDescriptor(prototype, 'render')?.value === patch.patchedRender)
        Object.defineProperty(prototype, 'render', patch.render);
      if (Object.getOwnPropertyDescriptor(prototype, 'handleMouse')?.value === patch.patchedMouse)
        Object.defineProperty(prototype, 'handleMouse', patch.mouse);
      for (const update of patch.updates) {
        if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
        if (update.original) Object.defineProperty(prototype, update.name, update.original);
        else Reflect.deleteProperty(prototype, update.name);
      }
    }
    this.patches.clear();
  }

  nativeRows(owner: object, width: number): string[] {
    const render = this.isTool(owner) ? this.patches.get(Object.getPrototypeOf(owner))?.render.value as NativeToolRender<object> | undefined : undefined;
    return render ? render.call(owner, width) : (owner as Component).render(width);
  }

  imageRows(owner: object, width: number): string[] {
    const rendered: string[] = [], children = (owner as Container).children;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (!(child instanceof Image)) continue;
      const spacer = children[index - 1];
      if (spacer instanceof Spacer) rendered.push(...spacer.render(width));
      rendered.push(...child.render(width));
    }
    return rendered;
  }

  hidden(owner: object): boolean { return (owner as ToolNode).hideComponent; }
  context(owner: object): unknown { return (owner as ToolNode).getRenderContext(); }
  setExpanded(owner: object, expanded: boolean): void { (owner as ToolNode).setExpanded(expanded); }
  selfShell(owner: object): boolean { return (owner as ToolNode).getRenderShell() === 'self'; }
  fileRenderer(owner: object): boolean {
    const node = owner as ToolNode, call = node.getCallRenderer?.(), result = node.getResultRenderer?.();
    return isDeferredStockFileCall(call) && (result === undefined || isDeferredStockFilePair(call, result));
  }
  readRenderer(owner: object): boolean {
    const node = owner as ToolNode;
    return isDeferredStockReadPair(node.getCallRenderer?.(), node.getResultRenderer?.());
  }
  deferredFilePair(owner: object): boolean {
    const node = owner as ToolNode;
    return isDeferredStockFilePair(node.getCallRenderer?.(), node.getResultRenderer?.());
  }
  stockEditShell(owner: object): boolean {
    const node = owner as ToolNode, callRenderer = node.getCallRenderer?.(), resultRenderer = node.getResultRenderer?.();
    // A stock factory may reuse a previous custom Box; both identities and the current leaf must qualify.
    const stockEdit = callRenderer === stockEditCall && resultRenderer === stockEditResult &&
      node.callRendererComponent instanceof Box && Object.getPrototypeOf(node.callRendererComponent) === Box.prototype &&
      node.callRendererComponent.render === Box.prototype.render && node.callRendererComponent.clear === Box.prototype.clear &&
      node.callRendererComponent.addChild === Box.prototype.addChild;
    const deferredEdit = isDeferredStockEditPair(callRenderer, resultRenderer) && isDeferredStockEditComponent(node.callRendererComponent);
    return node.constructor.name === 'ToolExecutionComponent' && node.toolName === 'edit' && typeof node.getCallRenderer === 'function' &&
      typeof node.getResultRenderer === 'function' && (stockEdit || deferredEdit);
  }
  releaseFileRenderer(owner: object): void {
    const context = this.context(owner) as { state?: unknown } | null | undefined;
    releaseNativeRendererCache(context?.state);
  }
  syncRendererArgs(owner: object, kind: 'file' | 'read'): void {
    const node = owner as ToolNode;
    const pair = kind === 'file' ? isDeferredStockFilePair(node.getCallRenderer?.(), node.getResultRenderer?.())
      : isDeferredStockReadPair(node.getCallRenderer?.(), node.getResultRenderer?.());
    if (!pair) return;
    const context = this.context(owner) as { state?: unknown } | null | undefined;
    updateNativeRendererArgs(context?.state, node.toolName, node.toolCallId, node.args);
  }
}
