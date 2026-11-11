import { Text, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolRendererResolver,
  type ToolRenderers,
} from '@earendil-works/pi-coding-agent';

type CallRenderer = NonNullable<ToolRenderers['renderCall']>;
type ResultRenderer = NonNullable<ToolRenderers['renderResult']>;
type CallContext = Parameters<CallRenderer>[2];
type ResultContext = Parameters<ResultRenderer>[3];
type RenderContext = CallContext | ResultContext;
type Slot = 'call' | 'result';
type NativeFileTool = 'read' | 'write' | 'edit';
export type NativeRendererFailureOutcome = 'failure' | 'recovered' | 'released';
type RendererFailureOutcome = NativeRendererFailureOutcome;
export type NativeRendererFailureReporter = (owner: object, tool: NativeFileTool, slot: Slot, outcome: NativeRendererFailureOutcome) => void;
type RendererFailureReporterProvider = () => NativeRendererFailureReporter | undefined;

const stockRead = createReadToolDefinition('.');
const stockWrite = createWriteToolDefinition('.');
const stockEdit = createEditToolDefinition('.');
export const stockReadCall = stockRead.renderCall;
export const stockReadResult = stockRead.renderResult;
export const stockWriteCall = stockWrite.renderCall;
export const stockWriteResult = stockWrite.renderResult;
export const stockEditCall = stockEdit.renderCall;
export const stockEditResult = stockEdit.renderResult;

interface RendererOwner {
  readonly id: string;
  readonly tool: NativeFileTool;
  readonly rendererState: Record<string, unknown>;
  call?: DeferredRenderer;
  result?: DeferredRenderer;
  callInner?: Component;
  resultInner?: Component;
  report(slot: Slot, outcome: RendererFailureOutcome): void;
  evict(): void;
  dispose(): void;
  clearSlot(slot: Slot): void;
  setWrapper(slot: Slot, component: DeferredRenderer): void;
  setInner(slot: Slot, component: Component): void;
  inner(slot: Slot): Component | undefined;
  prepareNative(): void;
}

const owners = new WeakMap<object, Owner>();
const deferredFilePairs = new WeakMap<Function, Function>();
const deferredReadPairs = new WeakMap<Function, Function>();
const deferredEditComponents = new WeakSet<object>();

function shadowState(): Record<string, unknown> { return {}; }

function clearState(state: Record<string, unknown>): void {
  for (const key of Reflect.ownKeys(state)) Reflect.deleteProperty(state, key);
}

class Owner implements RendererOwner {
  readonly rendererState = shadowState();
  call?: DeferredRenderer;
  result?: DeferredRenderer;
  callInner?: Component;
  resultInner?: Component;
  readonly id: string;
  readonly tool: NativeFileTool;
  private readonly reporter: RendererFailureReporterProvider;
  private readonly failures = new Set<Slot>();
  private preparedCall?: DeferredRenderer;
  private preparedResult?: DeferredRenderer;
  private preparing = false;
  args: CallContext['args'];

  constructor(id: string, tool: NativeFileTool, reporter: RendererFailureReporterProvider, args: CallContext['args']) {
    this.id = id; this.tool = tool; this.reporter = reporter; this.args = args;
  }

  inner(slot: Slot): Component | undefined { return slot === 'call' ? this.callInner : this.resultInner; }
  setInner(slot: Slot, component: Component): void {
    if (slot === 'call') this.callInner = component;
    else this.resultInner = component;
  }

  setWrapper(slot: Slot, component: DeferredRenderer): void {
    const previous = slot === 'call' ? this.call : this.result;
    if (previous && previous !== component) previous.retire();
    this.preparedCall = undefined; this.preparedResult = undefined;
    if (slot === 'call') this.call = component;
    else this.result = component;
  }

  prepareNative(): void {
    const call = this.call, result = this.result;
    if (this.preparing || (this.preparedCall === call && this.preparedResult === result)) return;
    this.preparing = true;
    try { call?.materialize(); result?.materialize(); }
    finally { this.preparing = false; this.preparedCall = call; this.preparedResult = result; }
  }

  report(slot: Slot, outcome: RendererFailureOutcome): void {
    const active = this.failures.has(slot);
    if (outcome === 'failure') {
      if (active) return;
      this.failures.add(slot);
    } else {
      if (!active) return;
      this.failures.delete(slot);
    }
    try { this.reporter()?.(this, this.tool, slot, outcome); } catch { /* Diagnostics must not affect host rendering. */ }
  }

  clearSlot(slot: Slot): void {
    if (slot === 'call') {
      this.callInner = undefined;
      clearState(this.rendererState);
    } else this.resultInner = undefined;
  }

  evict(): void {
    for (const slot of this.failures) this.report(slot, 'released');
    this.preparedCall = undefined; this.preparedResult = undefined;
    this.call?.evict(); this.result?.evict();
    this.callInner = undefined; this.resultInner = undefined;
    clearState(this.rendererState);
  }

  dispose(): void {
    for (const slot of this.failures) this.report(slot, 'released');
    this.preparedCall = undefined; this.preparedResult = undefined;
    this.call?.dispose(); this.result?.dispose();
    this.call = undefined; this.result = undefined;
    this.callInner = undefined; this.resultInner = undefined;
    this.args = undefined;
    clearState(this.rendererState);
  }
}

export class DeferredRenderer implements Component {
  private component?: Component;
  private owner?: RendererOwner;
  private readonly slot: Slot;
  private invoke?: () => Component;
  private fallback?: () => Component;
  private failed = false;
  private disposed = false;

  constructor(owner: RendererOwner, slot: Slot, invoke: () => Component, fallback: () => Component) {
    this.owner = owner; this.slot = slot; this.invoke = invoke; this.fallback = fallback;
  }

  get wantsKeyRelease(): boolean { return this.component?.wantsKeyRelease ?? false; }

  evict(): void {
    this.owner?.clearSlot(this.slot);
    this.component = undefined;
  }

  retire(): void {
    this.disposed = true;
    this.component = undefined; this.owner = undefined;
    this.invoke = undefined; this.fallback = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.owner?.clearSlot(this.slot);
    this.component = undefined; this.owner = undefined;
    this.invoke = undefined; this.fallback = undefined;
  }

  materialize(): void {
    if (this.disposed || this.component) return;
    const invoke = this.invoke;
    try {
      if (!invoke) throw new Error('Native renderer invocation is no longer available');
      this.component = invoke();
      this.owner?.report(this.slot, 'recovered');
      this.failed = false;
    } catch {
      this.failed = true;
      this.owner?.report(this.slot, 'failure');
      this.owner?.clearSlot(this.slot);
      this.component = this.createFallback();
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    this.owner?.prepareNative();
    this.materialize();
    let component = this.component;
    if (!component) return [];
    try {
      return component.render(width);
    } catch {
      this.failed = true;
      this.owner?.report(this.slot, 'failure');
      this.owner?.clearSlot(this.slot);
      component = this.createFallback();
      this.component = component;
      return component.render(width);
    }
  }

  handleInput(data: string): void { this.component?.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.component?.handleMouse?.(event); }
  invalidate(): void { this.component?.invalidate(); }

  private createFallback(): Component {
    const make = this.fallback; this.fallback = undefined;
    return make?.() ?? new Text('[Native file preview unavailable]', 0, 0);
  }
}

function ownerFor(context: RenderContext, tool: NativeFileTool, reporter: RendererFailureReporterProvider, args: CallContext['args']): Owner {
  const state = context.state;
  if (state === null || (typeof state !== 'object' && typeof state !== 'function'))
    throw new TypeError('Pi tool renderer state must be an object');
  const key = state as object;
  let owner = owners.get(key);
  if (owner?.id === context.toolCallId && owner.tool === tool) { owner.args = args; return owner; }
  owner?.dispose();
  owner = new Owner(context.toolCallId, tool, reporter, args);
  owners.set(key, owner);
  return owner;
}

function callFailure(toolName: NativeFileTool): Component {
  return new Text(`[Native ${toolName} preview unavailable]`, 0, 0);
}

function resultFailure(): Component {
  return new Text('[Native file result unavailable]', 0, 0);
}

function nativeContextFields(context: RenderContext, owner: Owner): Omit<RenderContext, 'args' | 'lastComponent'> {
  // Pi may batch argument updates without replacing these leaves; only the owner borrows arguments.
  const { args: _args, lastComponent: _lastComponent, ...fields } = context;
  return { ...fields, state: owner.rendererState };
}

function deferredCall(
  owner: Owner,
  toolName: NativeFileTool,
  renderer: CallRenderer,
  theme: Parameters<CallRenderer>[1],
  context: CallContext,
): DeferredRenderer {
  const safeContext = nativeContextFields(context, owner);
  const component = new DeferredRenderer(owner, 'call', () => {
    const next = renderer(owner.args, theme, { ...safeContext, args: owner.args, lastComponent: owner.inner('call') });
    owner.setInner('call', next);
    return next;
  }, () => callFailure(toolName));
  owner.setWrapper('call', component);
  return component;
}

function deferredResult(
  owner: Owner,
  renderer: ResultRenderer,
  result: Parameters<ResultRenderer>[0],
  options: Parameters<ResultRenderer>[1],
  theme: Parameters<ResultRenderer>[2],
  context: ResultContext,
): DeferredRenderer {
  const safeContext = nativeContextFields(context, owner);
  const component = new DeferredRenderer(owner, 'result', () => {
    const next = renderer(result, options, theme, { ...safeContext, args: owner.args, lastComponent: owner.inner('result') });
    owner.setInner('result', next);
    return next;
  }, resultFailure);
  owner.setWrapper('result', component);
  return component;
}

export function createLazyNativeRendererResolver(reporter: RendererFailureReporterProvider = () => undefined): ToolRendererResolver {
  return (toolName, next) => {
    if (toolName !== 'read' && toolName !== 'write' && toolName !== 'edit') return next();
    const base = next();
    const stock = toolName === 'read' ? stockRead : toolName === 'write' ? stockWrite : stockEdit;
    if (!base || !stock.renderCall || !stock.renderResult ||
      base.renderCall !== stock.renderCall || base.renderResult !== stock.renderResult) return base;

    const callRenderer = stock.renderCall as unknown as CallRenderer;
    const resultRenderer = stock.renderResult as unknown as ResultRenderer;
    const renderCall: CallRenderer = (args, theme, context) => {
      const owner = ownerFor(context, toolName, reporter, args);
      const component = deferredCall(owner, toolName, callRenderer, theme, context);
      if (toolName === 'edit') deferredEditComponents.add(component);
      return component;
    };
    const renderResult: ResultRenderer = (result, options, theme, context) => {
      const owner = ownerFor(context, toolName, reporter, context.args);
      return deferredResult(owner, resultRenderer, result, options, theme, context);
    };
    deferredFilePairs.set(renderCall, renderResult);
    if (toolName === 'read') deferredReadPairs.set(renderCall, renderResult);
    return { ...base, renderCall, renderResult };
  };
}

export function updateNativeRendererArgs(state: unknown, tool: string, id: string, args: CallContext['args']): void {
  if (state === null || (typeof state !== 'object' && typeof state !== 'function')) return;
  const owner = owners.get(state as object);
  if (owner?.tool === tool && owner.id === id) owner.args = args;
}

export function releaseNativeRendererCache(state: unknown): void {
  if (state === null || (typeof state !== 'object' && typeof state !== 'function')) return;
  owners.get(state as object)?.evict();
}

export function isDeferredStockReadPair(call: unknown, result: unknown): boolean {
  return typeof call === 'function' && typeof result === 'function' && deferredReadPairs.get(call) === result;
}

export function isDeferredStockFilePair(call: unknown, result: unknown): boolean {
  return typeof call === 'function' && typeof result === 'function' && deferredFilePairs.get(call) === result;
}

export function isDeferredStockEditPair(call: unknown, result: unknown): boolean {
  return isDeferredStockFilePair(call, result);
}

export function isDeferredStockEditComponent(component: unknown): boolean {
  return typeof component === 'object' && component !== null && deferredEditComponents.has(component);
}

export function isDeferredStockFileCall(call: unknown): boolean {
  return typeof call === 'function' && deferredFilePairs.has(call);
}
