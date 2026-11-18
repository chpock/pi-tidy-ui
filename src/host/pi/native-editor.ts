import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { Container, Editor, Spacer, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { EDITOR_TOP, EDITOR_BOTTOM, renderEditorCard, type EditorLayout } from '../../editor-card.ts';
import { renderEditorStatus, type EditorStatusInfo } from '../../editor-status.ts';
import type { CardTheme } from '../../card-theme.ts';
import type { DiagnosticFields } from '../../diagnostics.ts';

export type NativeTui = Component & {
  requestRender(): void;
  terminal?: { readonly rows: number };
  hasActiveSelection?(): boolean;
  getFocusedComponent?(): Component | null;
  setFocus?(component: Component | null): void;
};

export interface NativeEditorOptions {
  nativeEditor?: () => boolean;
  editorStatus?: boolean;
  rerouteEditorStatus?: () => void;
}

interface EditorPorts {
  active(): boolean;
  attached(owner: object): boolean;
  parent(owner: object): Container | undefined;
  theme(): CardTheme;
  fail(message: string): void;
  decision(owner: object, area: string, choice: string, width: number, rows: number, fields?: DiagnosticFields, geometry?: string): void;
}

interface ContainerHooks {
  render: Container['render'];
  clear: Container['clear'];
  addChild: Container['addChild'];
}

type EditorHook = { name: string; original: PropertyDescriptor | undefined; wrapper: Function };

/** Joint owner of stock-editor geometry, placement and native widget/status observations. */
export class NativeEditor {
  private readonly patches = new Map<object, EditorHook[]>();
  private current: WeakRef<CustomEditor> | undefined;
  private states = new WeakMap<CustomEditor, Omit<EditorLayout, 'rows'> & { width: number; offsetY: number }>();
  private readonly flags = new WeakMap<CustomEditor, PropertyDescriptor>();
  private readonly flagRefs = new Set<WeakRef<CustomEditor>>();
  private readonly pendingRoutes = new WeakSet<CustomEditor>();
  private readonly selfTransfers = new WeakMap<CustomEditor, Function>();
  private installing = true;
  private queuedRoute = false;
  private statusRows = new WeakMap<Container, { width: number; visible: boolean }>();
  private upperRows = new WeakMap<Container, { width: number; rows: number; spacer: WeakRef<Spacer> }>();
  private spacerPass: { spacer: Spacer; width: number; rows?: number; blank?: boolean } | undefined;
  private passes = new WeakMap<CustomEditor, { width: number; top: string; bottom: string }>();
  private readonly nativeRender = Editor.prototype.render;
  private readonly nativeExpandedText = Object.getOwnPropertyDescriptor(Editor.prototype, 'getExpandedText')?.value as Editor['getExpandedText'] | undefined;
  private readonly nativeMouse = Editor.prototype.handleMouse;
  private readonly prototype = CustomEditor.prototype as unknown as Record<string, Function>;
  private readonly nativeTop = this.prototype.renderTopBorder!;
  private readonly nativeBottom = this.prototype.renderBottomBorder!;
  private readonly nativeSpacer = Object.getOwnPropertyDescriptor(Spacer.prototype, 'render')!;
  readonly observeSpacer: Spacer['render'];
  private readonly statusEmbedding: (this: CustomEditor) => boolean;

  private readonly tui: NativeTui;
  private readonly options: NativeEditorOptions;
  private readonly ports: EditorPorts;
  private readonly hooks: ContainerHooks;

  constructor(tui: NativeTui, options: NativeEditorOptions, ports: EditorPorts, hooks: ContainerHooks) {
    this.tui = tui; this.options = options; this.ports = ports; this.hooks = hooks;
    const owner = this;
    this.statusEmbedding = function () {
      return ports.active() && owner.plainStock(this) ? false : owner.flags.get(this)?.value as boolean;
    };
    this.observeSpacer = function (this: Spacer, width: number) {
      const rows = owner.nativeSpacer.value.call(this, width) as string[];
      if (owner.spacerPass?.spacer === this && owner.spacerPass.width === width) {
        owner.spacerPass.rows = rows.length;
        owner.spacerPass.blank = rows[0] === '';
      }
      return rows;
    };
  }

  get patched(): boolean { return this.patches.size > 0; }
  get active(): boolean {
    const editor = this.current?.deref();
    return !!(this.ports.active() && editor && this.managedStock(editor));
  }
  get statusActive(): boolean {
    const editor = this.current?.deref();
    return !!(this.ports.active() && this.options.editorStatus && editor && this.stock(editor));
  }
  isEditor(owner: object): boolean { return Object.getPrototypeOf(owner) === CustomEditor.prototype; }
  isObservedSpacer(owner: object): boolean {
    return Object.getPrototypeOf(owner) === Spacer.prototype && (owner as Spacer).render === this.observeSpacer;
  }

  private plainStock(node: CustomEditor): boolean {
    const hooks = this.patches.get(CustomEditor.prototype);
    return Object.getPrototypeOf(node) === CustomEditor.prototype && Object.getPrototypeOf(CustomEditor.prototype) === Editor.prototype &&
      ['render', 'handleMouse', 'renderTopBorder', 'renderBottomBorder'].every(name =>
        (node as unknown as Record<string, unknown>)[name] === hooks?.find(hook => hook.name === name)?.wrapper) &&
      node.getPaddingX === Editor.prototype.getPaddingX && node.getText === Editor.prototype.getText &&
      (node.setText === Editor.prototype.setText || node.setText === this.selfTransfers.get(node)) &&
      typeof node.borderColor === 'function' && !!Object.getOwnPropertyDescriptor(node, 'borderColor')?.writable &&
      (this.options.nativeEditor?.() ?? true);
  }
  private managedStock(node: CustomEditor): boolean {
    return this.plainStock(node) && (!this.options.editorStatus ||
      Object.getOwnPropertyDescriptor(node, 'embedWorkingStatus')?.get === this.statusEmbedding);
  }
  private stock(node: CustomEditor): boolean { return this.managedStock(node) && this.ports.attached(node); }

  install(owner: object): void {
    const editor = owner as CustomEditor;
    this.patchPrototype(CustomEditor.prototype);
    this.patchPlacement(editor);
    if (!this.stock(editor)) return;
    this.current = new WeakRef(editor);
    if (!this.installing && !this.queuedRoute && this.pendingRoutes.has(editor) && this.managedSlots(editor)) this.deferRoute();
  }

  publishSpacer(): void {
    Object.defineProperty(Spacer.prototype, 'render', { ...this.nativeSpacer, value: this.observeSpacer });
  }
  finishInstallation(): void { this.reroute(); this.installing = false; }

  private patchPlacement(editor: CustomEditor): void {
    if (!this.options.editorStatus || this.flags.has(editor) || !this.plainStock(editor) ||
      (this.options.rerouteEditorStatus && !this.managedSlots(editor))) return;
    const flag = Object.getOwnPropertyDescriptor(editor, 'embedWorkingStatus');
    const setter = Object.getOwnPropertyDescriptor(editor, 'setText');
    if (!flag?.configurable || !flag.writable || typeof flag.value !== 'boolean' ||
      (setter ? !setter.writable : !Object.isExtensible(editor))) return;
    this.flags.set(editor, flag); this.flagRefs.add(new WeakRef(editor));
    Object.defineProperty(editor, 'embedWorkingStatus', { configurable: true, enumerable: flag.enumerable, get: this.statusEmbedding });
    if (this.options.rerouteEditorStatus) this.pendingRoutes.add(editor);
  }

  private deferRoute(): void {
    this.queuedRoute = true;
    // Rebinding itself reattaches the editor. Keep the attempt coalesced until it returns.
    queueMicrotask(() => {
      try { if (this.ports.active()) this.reroute(); }
      catch { this.ports.fail('pi-tidy-ui could not route native editor activity; native rendering restored'); }
      finally { this.queuedRoute = false; }
    });
  }

  private reroute(restored?: WeakSet<CustomEditor>): void {
    if (!this.options.rerouteEditorStatus) return;
    for (const reference of this.flagRefs) {
      const editor = reference.deref();
      if (!editor || !this.plainStock(editor) || !this.managedSlots(editor) || !this.ports.attached(editor) ||
        (restored ? !restored.has(editor) : !this.pendingRoutes.has(editor) ||
          Object.getOwnPropertyDescriptor(editor, 'embedWorkingStatus')?.get !== this.statusEmbedding)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(editor, 'setText');
      if (descriptor ? !descriptor.writable : !Object.isExtensible(editor)) continue;
      const text = editor.getText(), transfers: string[] = [], focus = this.tui.getFocusedComponent?.();
      // Suppress only the native API's synchronous redundant self-transfer. Its
      // ordinary setText clears paste bookkeeping and changes cursor/undo state.
      const setter = function (this: CustomEditor, value: string) {
        if (this === editor) transfers.push(value); else Editor.prototype.setText.call(this, value);
      };
      this.selfTransfers.set(editor, setter);
      Object.defineProperty(editor, 'setText', { configurable: true, writable: true, ...descriptor, value: setter });
      try {
        this.options.rerouteEditorStatus();
        if (transfers.length !== 1 || !this.ports.attached(editor) ||
          (transfers[0] !== text && !this.matchesExpandedTransfer(editor, transfers[0]!)))
          throw new Error('Native same-editor status routing contract changed');
      } finally {
        this.selfTransfers.delete(editor);
        if (Object.getOwnPropertyDescriptor(editor, 'setText')?.value === setter) {
          if (descriptor) Object.defineProperty(editor, 'setText', descriptor); else Reflect.deleteProperty(editor, 'setText');
        }
        if (focus !== undefined && focus !== editor) this.tui.setFocus?.(focus);
      }
      this.pendingRoutes.delete(editor);
      return;
    }
  }

  private matchesExpandedTransfer(editor: CustomEditor, text: string): boolean {
    // Descriptor lookup must not execute a foreign expanded-text accessor.
    const method = Object.getOwnPropertyDescriptor(editor, 'getExpandedText')
      ?? Object.getOwnPropertyDescriptor(CustomEditor.prototype, 'getExpandedText')
      ?? Object.getOwnPropertyDescriptor(Editor.prototype, 'getExpandedText');
    return typeof this.nativeExpandedText === 'function' && method?.value === this.nativeExpandedText &&
      text === this.nativeExpandedText.call(editor);
  }

  private managedSlots(editor: CustomEditor): Component[] | undefined {
    const input = this.ports.parent(editor);
    if (!input || Object.getPrototypeOf(input) !== Container.prototype || input.children.length !== 1 || input.children[0] !== editor)
      return undefined;
    const slots = this.ports.parent(input)?.children;
    if (!(this.tui instanceof Container) || !slots || slots !== this.tui.children || slots.length !== 7 || slots[4] !== input ||
      !slots.every(node => Object.getPrototypeOf(node) === Container.prototype)) return undefined;
    return slots;
  }
  private upperGroup(editor: CustomEditor): Container | undefined {
    const slots = this.managedSlots(editor);
    if (!slots) return undefined;
    const group = slots[3] as Container, spacer = group.children[0];
    if (group.render !== this.hooks.render || group.clear !== this.hooks.clear || group.addChild !== this.hooks.addChild ||
      !spacer || Object.getPrototypeOf(spacer) !== Spacer.prototype || spacer.render !== this.observeSpacer) return undefined;
    return group;
  }

  renderContainer(group: Container, width: number, native: Container['render']): string[] {
    const parent = this.ports.active() && this.ports.parent(group);
    const input = this.tui instanceof Container && parent && parent.children === this.tui.children &&
      (parent.children[3] === group || parent.children[2] === group) && parent.children[4];
    const editor = input instanceof Container && input.children[0];
    if (!(editor instanceof CustomEditor) || !this.stock(editor)) return native.call(group, width);
    if (this.managedSlots(editor)?.[2] === group) {
      const rows = native.call(group, width);
      this.statusRows.set(group, { width, visible: rows.some(row => stripVTControlCharacters(row).trim().length > 0) });
      return rows;
    }
    if (this.upperGroup(editor) !== group) return native.call(group, width);
    const previous = this.spacerPass;
    const pass = { spacer: group.children[0] as Spacer, width } as NonNullable<typeof this.spacerPass>;
    this.spacerPass = pass;
    try {
      const rows = native.call(group, width);
      if (pass.rows === 1 && pass.blank && rows.length >= 1 && rows[0] === '' && this.upperGroup(editor) === group)
        this.upperRows.set(group, { width, rows: rows.length - 1, spacer: new WeakRef(pass.spacer) });
      else this.upperRows.delete(group);
      return rows;
    } finally { this.spacerPass = previous; }
  }

  private gap(editor: CustomEditor, width: number): number {
    const group = this.upperGroup(editor), measured = group && this.upperRows.get(group);
    return group && group.children.length > 1 && measured?.width === width && measured.rows > 0 &&
      measured.spacer.deref() === group.children[0] ? 1 : 0;
  }

  private patchPrototype(prototype: object): void {
    if (this.patches.has(prototype)) return;
    if (this.prototype.render !== this.nativeRender || this.prototype.handleMouse !== this.nativeMouse ||
      this.prototype.renderBottomBorder !== this.nativeBottom) return;
    const owner = this, ports = this.ports;
    const patchedRender = function (this: CustomEditor, width: number): string[] {
      if (!ports.active() || !owner.stock(this) || (width > 0 && width < 7)) {
        owner.states.delete(this); const rows = owner.nativeRender.call(this, width);
        ports.decision(this, 'editor', 'Native editor delegated; ownership or narrow-width guard rejected', width, rows.length); return rows;
      }
      try {
        const layout = renderEditorCard(width, this.getPaddingX(), ports.theme(), (size, borderWidth) => {
          if (borderWidth === undefined) return { rows: owner.nativeRender.call(this, size), top: '', bottom: '' };
          const pass = { width: borderWidth, top: '', bottom: '' };
          owner.passes.set(this, pass);
          try { return { rows: owner.nativeRender.call(this, size), top: pass.top, bottom: pass.bottom }; }
          finally { owner.passes.delete(this); }
        });
        const { rows, ...mapping } = layout;
        const offsetY = mapping.framed ? owner.gap(this, width) : 0;
        owner.states.set(this, { ...mapping, width, offsetY });
        ports.decision(this, 'editor', mapping.framed ? 'Stock editor presentation projected; native input engine retained' : 'Native editor projection fallback; inner geometry/content guard rejected', width, rows.length,
          { nativeWidth: mapping.nativeWidth, offsetX: mapping.offsetX, offsetY }, `${mapping.nativeWidth}:${mapping.offsetX}:${offsetY}`);
        if (mapping.framed && owner.options.editorStatus) owner.current = new WeakRef(this);
        return offsetY ? ['', ...rows] : rows;
      } catch {
        ports.fail('pi-tidy-ui could not render this editor; native rendering restored');
        return owner.nativeRender.call(this, width);
      }
    };
    const patchedMouse = function (this: CustomEditor, event: TuiMouseEvent) {
      const state = owner.states.get(this);
      if (!ports.active() || !owner.stock(this) || !state?.framed || state.width !== event.width)
        return owner.nativeMouse.call(this, event);
      if (event.y < state.offsetY) return undefined;
      return owner.nativeMouse.call(this, { ...event, x: event.x - state.offsetX, y: event.y - state.offsetY,
        width: state.nativeWidth, height: Math.max(0, event.height - state.offsetY) });
    };
    const border = (name: 'top' | 'bottom', original: Function) => function (this: CustomEditor, width: number, hidden: number): string {
      const pass = owner.passes.get(this);
      if (!pass) return original.call(this, width, hidden) as string;
      const descriptor = Object.getOwnPropertyDescriptor(this, 'borderColor')!, color = this.borderColor;
      // Only decoration fragments use this callback; native indicators own their independent styles.
      Object.defineProperty(this, 'borderColor', { ...descriptor, value: (text: string) => color.call(this, text.replaceAll('─', ' ')) });
      try { pass[name] = original.call(this, pass.width, hidden) as string; }
      finally { Object.defineProperty(this, 'borderColor', descriptor); }
      return name === 'top' ? EDITOR_TOP : EDITOR_BOTTOM;
    };
    const replacements = { render: patchedRender, handleMouse: patchedMouse,
      renderTopBorder: border('top', this.nativeTop), renderBottomBorder: border('bottom', this.nativeBottom) };
    const hooks = Object.entries(replacements).map(([name, wrapper]) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      if (original && (!original.writable || !original.configurable)) throw new Error('Native editor presentation hooks cannot be restored');
      return { name, original, wrapper };
    });
    this.patches.set(prototype, hooks);
    for (const hook of hooks) Object.defineProperty(prototype, hook.name,
      { configurable: true, writable: true, ...hook.original, value: hook.wrapper });
  }

  renderStatus(width: number, info: EditorStatusInfo): string[] {
    const editor = this.current?.deref(), state = editor && this.states.get(editor);
    if (!this.ports.active() || !this.options.editorStatus || !editor || !this.stock(editor) || !state?.framed || state.width !== width) {
      this.ports.decision(this.tui, 'editor-status', 'Below-editor metadata withheld; owned stock geometry is unavailable', width, 0); return [];
    }
    try {
      if (editor.isShowingAutocomplete()) {
        this.ports.decision(this.tui, 'editor-status', 'Below-editor metadata suppressed by public autocomplete state', width, 0); return [];
      }
      const group = this.managedSlots(editor)?.[2] as Container | undefined;
      const activity = group?.render === this.hooks.render ? this.statusRows.get(group) : undefined;
      const idle = info.idle && !(activity?.width === width && activity.visible);
      const rows = renderEditorStatus(width, this.ports.theme(), { ...info, idle }, state.geometry);
      this.ports.decision(this.tui, 'editor-status', idle ? 'Below-editor metadata projected with Idle' : 'Below-editor metadata projected; native activity stays in Pi-owned status container', width, rows.length);
      return rows;
    } catch { this.ports.fail('pi-tidy-ui could not render editor status; native rendering restored'); return []; }
  }

  restoreObservations(): void {
    if (Spacer.prototype.render === this.observeSpacer) Object.defineProperty(Spacer.prototype, 'render', this.nativeSpacer);
    this.upperRows = new WeakMap(); this.statusRows = new WeakMap(); this.spacerPass = undefined;
  }

  restore(): void {
    const restored = new WeakSet<CustomEditor>();
    for (const reference of this.flagRefs) {
      const editor = reference.deref(), flag = editor && this.flags.get(editor);
      const descriptor = editor && Object.getOwnPropertyDescriptor(editor, 'embedWorkingStatus');
      if (editor && flag && descriptor?.get === this.statusEmbedding && descriptor.configurable) {
        Object.defineProperty(editor, 'embedWorkingStatus', flag); restored.add(editor);
      }
    }
    // Placement must be native before same-editor rebinding, and editor hooks
    // remain owned until the rebind has preserved its draft/cursor/paste state.
    try { this.reroute(restored); } catch { /* Retain native ownership on an unsupported host. */ }
    this.flagRefs.clear();
    for (const [prototype, hooks] of this.patches) for (const hook of hooks) {
      if (Object.getOwnPropertyDescriptor(prototype, hook.name)?.value !== hook.wrapper) continue;
      if (hook.original) Object.defineProperty(prototype, hook.name, hook.original);
      else Reflect.deleteProperty(prototype, hook.name);
    }
    this.patches.clear(); this.states = new WeakMap(); this.passes = new WeakMap(); this.current = undefined;
  }
}
