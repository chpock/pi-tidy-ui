import "./test-guard.mjs";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import tidyUi, { installTidyUi, type TidyUiOptions } from "../../src/index.ts";
import type { SyntaxRuntimeOptions } from "../../src/syntax/runtime.ts";

export const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

export class Root extends Container {
  // Synthetic host mirrors the explicitly guarded native appearance flag.
  terminalColorSchemeNotificationsEnabled = false;
  requests = 0;
  selection = false;
  listeners = new Set<(data: string) => unknown>();
  constructor() { super(); this.addInputListener((data) => this.handleViewportInput(data)); }
  handleViewportInput(_data: string): unknown { return undefined; }
  requestRender() { this.requests++; }
  hasActiveSelection() { return this.selection; }
  addInputListener(listener: (data: string) => unknown) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  input(data: string) {
    const results: unknown[] = [];
    for (const listener of this.listeners) {
      const result = listener(data); results.push(result);
      if ((result as { consume?: boolean } | undefined)?.consume) break;
    }
    return results;
  }
}

export class Tool extends Container {
  toolCallId = "test-id";
  toolName: string;
  args: Record<string, unknown>;
  expanded = false;
  hideComponent = false;
  isPartial = false;
  executionStarted = true;
  argsComplete = true;
  result: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown; structuredContent?: unknown } | undefined =
    { content: [{ type: "text", text: "FULL_OUTPUT" }] };
  constructor(name = "read", args: Record<string, unknown> = { path: "a.txt" }) {
    super(); this.toolName = name; this.args = args;
  }
  markExecutionStarted() { this.executionStarted = true; }
  updateResult(result: Tool["result"], partial = false) { this.result = result; this.isPartial = partial; }
  updateArgs(args: Record<string, unknown>) { this.args = args; }
  setExpanded(value: boolean) { this.expanded = value; }
  getRenderContext() { return { cwd: "/project" }; }
  getRenderShell() { return "default"; }
  render(_width: number): string[] { return this.hideComponent ? [] : ["", `NATIVE ${this.toolName}`, "FULL_OUTPUT"]; }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "click" && event.button === "left" && event.y > 0) {
      this.setExpanded(!this.expanded); return { handled: true as const, target: {
        component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
        width: event.width, height: event.height,
      } };
    }
    return undefined;
  }
}

export const spinnerFrames = Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");

export const color = { colors: {}, fg: (_name: string, text: string) => text };

export function setup(children: (Container | Text | Tool)[] = [], options: TidyUiOptions = {}) {
  const root = new Root();
  for (const child of children) root.addChild(child);
  const original = Tool.prototype.render;
  const addChild = Container.prototype.addChild;
  const controller = installTidyUi(root, () => color, options);
  return { root, controller, original, addChild };
}

export function mouse(y: number, width = 80): TuiMouseEvent {
  return { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width, height: 20, shift: false, alt: false, ctrl: false };
}

export function fixtureSyntaxOptions(): SyntaxRuntimeOptions {
  return { standaloneVersion: "fixture", settings: {
    async load() { return { ok: true, syntaxTheme: { kind: "pi" } }; }, async update() { return { ok: true }; },
  }, provider: { async tryShared() { return undefined; }, async acquireOwned() { throw new Error("fixture unavailable"); } } };
}

export function extensionHarness(mode: "tui" | "print" | "json" | "rpc" = "tui", flagValues: Record<string, string> = {}) {
  const root = new Root(); root.addChild(new Tool());
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const flags = new Map<string, unknown>();
  const widgets: string[] = [], notices: string[] = [];
  const widgetComponents = new Map<string, { render(width: number): string[] }>();
  const widgetPlacements = new Map<string, unknown>();
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => events.set(name, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: (name: string) => flagValues[name],
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = { mode, hasUI: mode === 'tui', isIdle: () => true, ui: {
    theme: color,
    notify: (text: string) => notices.push(text),
    getEditorComponent: () => undefined,
    setWidget: (name: string, factory?: (tui: Root) => { render(width: number): string[] }, options?: unknown) => {
      widgets.push(name);
      if (factory) { widgetComponents.set(name, factory(root)); widgetPlacements.set(name, options); }
      else { widgetComponents.delete(name); widgetPlacements.delete(name); }
    },
  } } as unknown as ExtensionContext;
  tidyUi(api, { logging: false, settings: fixtureSyntaxOptions().settings, syntax: fixtureSyntaxOptions });
  return { root, ctx, events, commands, flags, widgets, notices, widgetComponents, widgetPlacements };
}

export function bashTool(command = "echo hello") {
  const tool = new Tool("bash", { command });
  tool.result = { content: [] };
  return tool;
}

// Edit presentation consumes persisted metadata, never proposal arguments or current file bytes.
export const editDiff = " 1 const first = 1;\n-2 const before = 2;\n+2 const after = 3;\n+3 const inserted = 4;\n 3 const tail = 5;";

// Use the real stock editor: presentation changes must not exchange its private editing state.
export function editorSetup(paddingX = 0) {
  const root = Object.assign(new Root(), { terminal: { rows: 24 } });
  const theme = { borderColor: (text: string) => text,
    selectList: { selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
      description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text } };
  const keybindings = { matches: (_data: string, _action: string) => false };
  const editor = new CustomEditor(root as never, theme, keybindings as never, { paddingX, embedWorkingStatus: true });
  editor.focused = true; root.addChild(editor);
  return { root, editor, theme, keybindings };
}

export { Container, CustomEditor, Text, installTidyUi, tidyUi };
export type { ExtensionAPI, ExtensionContext, TidyUiOptions, TuiMouseEvent };
