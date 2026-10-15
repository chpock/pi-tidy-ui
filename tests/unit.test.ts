import './fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { Box, Container, Editor, CURSOR_MARKER, Spacer, Text, visibleWidth, truncateToWidth, parseColor, colorToRgb, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CustomEditor, ToolExecutionComponent as NativeToolExecution, createEditToolDefinition, createWriteToolDefinition, createWriteTool, highlightCode, getLanguageFromPath, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import tidyUi, { installTidyUi, describeArgs, sanitize, terminalAppearanceTracking, type TidyUiOptions } from "../src/index.ts";
import type { SyntaxRuntimeOptions } from "../src/syntax/runtime.ts";
import { cardGeometry, frameRows, insidePanel } from "../src/card-frame.ts";
import { renderUserCard } from "../src/user-card.ts";
import { editorGeometry } from "../src/editor-card.ts";
import { measureFileCard, renderFileCard } from "../src/file-card.ts";
import { generateDiffString, generateUnifiedPatch } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import type { CardTheme } from "../src/card-theme.ts";
import { LAYOUT_KINDS, RenderCache } from "../src/render-cache.ts";
import { awaitFixture } from "./fixtures/await-fixture.ts";
import { editorPaint, editorPlain } from "./fixtures/editor-paint.ts";
import { renderEditorStatus, directoryStatus } from "../src/editor-status.ts";
import { IdleStatus, StatusIndicator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { PRIORITY_FIELDS, VALUE_TEXT_LIMIT, SUMMARY_TEXT_LIMIT } from "../src/summary-args.ts";
import { UserMessageComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { initTheme, theme as nativeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { colorToHex, rgbColor } from "@earendil-works/pi-tui";
import { resolveTerminalDefaults, parseThemeDefaults, TerminalColors } from "../src/terminal-colors.ts";
import { menuPage, setAppearance, setColors, withMenu } from "./helpers/menu-driver.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
class Root extends Container {
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
class Tool extends Container {
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
const spinnerFrames = Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
const color = { colors: {}, fg: (_name: string, text: string) => text };
function setup(children: (Container | Text | Tool)[] = [], options: TidyUiOptions = {}) {
  const root = new Root();
  for (const child of children) root.addChild(child);
  const original = Tool.prototype.render;
  const addChild = Container.prototype.addChild;
  const controller = installTidyUi(root, () => color, options);
  return { root, controller, original, addChild };
}
function mouse(y: number, width = 80): TuiMouseEvent {
  return { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width, height: 20, shift: false, alt: false, ctrl: false };
}

test("adjacent summaries skip empty siblings but separate visible text and cards", () => {
  const first = new Tool(), second = new Tool("grep", { pattern: "needle", path: "src" });
  const bash = new Tool("bash"), third = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, new Text("", 0, 0), second, bash, third]);
  try {
    assert.equal(controller.active, true);
    const rows = root.render(80).map(plain);
    const index = rows.findIndex((line) => line.includes("read a.txt"));
    assert.match(rows[index + 1], /grep.*needle.*src/);
    assert.equal(rows[index - 1], "");
    assert.equal(third.render(80)[0], "");
    assert.deepEqual(bash.render(80), ["", "NATIVE bash", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("summaries at transcript start need no leading gap; new attached subtrees are visited", () => {
  const { root, controller } = setup();
  try {
    const branch = new Container(), first = new Tool(), second = new Tool("custom", { query: "item" });
    branch.addChild(first); branch.addChild(second); root.addChild(branch);
    assert.equal(first.render(80).length, 1);
    assert.equal(second.render(80).length, 1);
    assert.match(root.render(80)[1], /custom.*item/);
  } finally { controller.restore(); }
});

test("native rich overrides, image, hidden and expanded tools delegate exactly", () => {
  const tools = ["bash", "powershell", "write", "edit"].map((name) => new Tool(name));
  const image = new Tool(); image.result = { content: [{ type: "image" }] };
  const expanded = new Tool(); expanded.expanded = true;
  const hidden = new Tool(); hidden.hideComponent = true;
  const { controller, original } = setup([...tools, image, expanded, hidden], { cards: ["edit"] });
  try {
    for (const tool of [...tools, image, expanded, hidden]) assert.deepEqual(tool.render(80), original.call(tool, 80));
  } finally { controller.restore(); }
});

test("completed summaries hide result text and markers; failures color every visible segment", () => {
  for (const name of ["read", "custom"]) {
    const tool = new Tool(name, { pattern: "needle", path: "文件/" + "p".repeat(40), query: "a,b,c", limit: 0 });
    const root = new Root(); root.addChild(tool);
    const paints: { role: string; text: string }[] = [];
    const controller = installTidyUi(root, () => ({ fg: (role, text) => {
      paints.push({ role, text });
      return `\x1b[${role === "error" ? 31 : 37}m${text}\x1b[39m`;
    } }));
    try {
      const args = structuredClone(tool.args);
      tool.updateResult({ isError: true, content: [{ type: "text", text: "ERROR_BODY_SENTINEL\nSTACK_SENTINEL" }], details: { raw: "UNCHANGED" } });
      const result = structuredClone(tool.result);
      assert.doesNotMatch(tool.render(80).map(plain).join(""), /ERROR_BODY_SENTINEL|STACK_SENTINEL/u, "error preview is never part of a collapsed call");
      for (let width = 1; width <= 100; width++) {
        controller.clearCache(); paints.length = 0;
        const rows = tool.render(width);
        assert.ok(rows.length > 0, "completed failed tool stays visible, including tiny widths");
        assert.ok(paints.length > 0 && paints.every(({ role }) => role === "error"), `all segments use error at width ${width}`);
        assert.ok(rows.every((row) => visibleWidth(row) <= Math.max(1, width - 1)));
        assert.doesNotMatch(rows.map(plain).join(""), /ERROR_BODY_SENTINEL|STACK_SENTINEL|✓|✗| — /u);
        if (width >= 6) {
          assert.equal(rows.map(plain).map((row) => row.slice(3)).join("").replace(/ /g, ""),
            `${name} ${describeArgs(name, tool.args)}`.replace(/ /g, ""));
          assert.ok(rows.map(plain).every((row) => !row.endsWith(" ")), "hidden marker leaves no dangling separator space");
        }
      }
      const failed = tool.render(30).map(plain);
      assert.ok(tool.handleMouse(mouse(failed.length - 1, 30))?.handled, "last failed continuation opens native information");
      assert.deepEqual(tool.render(30), ["", `NATIVE ${name}`, "FULL_OUTPUT"]);
      tool.setExpanded(false);
      tool.updateResult({ content: [{ type: "text", text: "SUCCESS_BODY_SENTINEL" }] });
      controller.clearCache(); paints.length = 0;
      const success = tool.render(30).map(plain);
      assert.deepEqual(success, failed, "error state changes colors, not logical call text or height");
      assert.ok(paints.some(({ role }) => role === "dim") && paints.every(({ role }) => role !== "error"));
      assert.doesNotMatch(success.join(""), /SUCCESS_BODY_SENTINEL|✓|✗/u);
      assert.deepEqual(tool.args, args);
      tool.updateResult(result, true);
      paints.length = 0;
      assert.ok(spinnerFrames.includes(plain(tool.render(30)[0]!)[1]!));
      assert.doesNotMatch(tool.render(30).join(""), /…/u);
      assert.ok(paints.every(({ role }) => role !== "error"), "partial isError does not mark the call failed");
      tool.updateResult(result);
      assert.deepEqual(tool.result, result);
      assert.deepEqual(tool.render(30).map(plain), failed);
    } finally { controller.restore(); }
  }
});

test("hiding completion badges never removes literal status glyphs from supplied arguments", () => {
  const tool = new Tool("custom", { query: "✓,✗", pattern: "✓" });
  const { controller } = setup([tool]);
  try {
    assert.equal(tool.render(80).at(-1), ' ⚙ custom "✓" [query="✓,✗"]');
    tool.updateResult({ isError: true, content: [{ type: "text", text: "HIDDEN_ERROR" }] });
    assert.equal(tool.render(80).at(-1), ' ⚙ custom "✓" [query="✓,✗"]');
  } finally { controller.restore(); }
});

test("completion marker constant can restore success and failure symbols without error-body previews", async () => {
  const sourceUrl = new URL("../src/index.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const switchLine = "const SHOW_COMPLETION_MARKERS = false;";
  assert.ok(source.includes(switchLine), "one source constant controls final markers and defaults to false");
  const enabled = source.replace(switchLine, "const SHOW_COMPLETION_MARKERS = true;")
    .replace(/from (["'])([^"']+)\1/gu, (_match, _quote: string, specifier: string) =>
      `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-completion-markers-"));
  let controller: ReturnType<typeof installTidyUi> | undefined;
  try {
    mkdirSync(join(temporary, "src"));
    writeFileSync(join(temporary, "package.json"), readFileSync(new URL("../package.json", sourceUrl)));
    const file = join(temporary, "src/index.ts"); writeFileSync(file, enabled);
    const alternate = await import(pathToFileURL(file).href);
    const root = new Root(), tool = new Tool(); root.addChild(tool);
    controller = alternate.installTidyUi(root, () => color);
    assert.equal(tool.render(80).at(-1), " → read a.txt ✓");
    tool.updateResult({ isError: true, content: [{ type: "text", text: "ERROR_BODY_SENTINEL" }] });
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt ✗");
    assert.doesNotMatch(tool.render(80).join(""), /ERROR_BODY_SENTINEL/u);
    assert.deepEqual(tool.render(5), [" ✗"]);
    tool.updateResult({ content: [] }); assert.deepEqual(tool.render(5), [" ✓"]);
    tool.updateResult(undefined); assert.match(plain(tool.render(80).at(-1)!), /…$/u);
    assert.deepEqual(tool.render(5), [" ⠋"]);
    tool.executionStarted = false; assert.deepEqual(tool.render(5), [" …"]);
  } finally { controller?.restore(); rmSync(temporary, { recursive: true, force: true }); }
});

test("one execution-only spinner clock changes prefixes without rebuilding cached summaries and stops immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const intervals = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  const first = new Tool("read", { path: "a.txt", query: "x".repeat(90) }), second = new Tool("custom", { drop: "1,2,3,4" });
  first.result = second.result = undefined; first.executionStarted = second.executionStarted = false;
  const records: { area: string; explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
  const { root, controller } = setup([first, second], { diagnostic: (_level, area, explanation, fields) => records.push({ area, explanation, fields }) });
  try {
    assert.ok(root.render(30).every((row) => !row.includes("…")));
    assert.equal(intervals.mock.calls.length, 0, "argument streaming alone starts no animation clock");
    const idle = root.requests; t.mock.timers.tick(10000); assert.equal(root.requests, idle);
    first.markExecutionStarted();
    const beforeStart = controller.cacheStats().builds;
    const initial = first.render(30).map(plain);
    assert.equal(initial[0]!.slice(0, 3), " ⠋ ");
    assert.equal(controller.cacheStats().builds, beforeStart, "execution start changes only the uncached glyph");
    second.markExecutionStarted(); second.render(30);
    assert.equal(intervals.mock.calls.length, 1, "parallel tools share one clock");
    assert.equal(intervals.mock.calls[0]!.arguments[1], 100, "bounded ten-frame-per-second cadence");
    const builds = controller.cacheStats().builds, requests = root.requests;
    const seen = new Set<string>();
    for (let frame = 0; frame < 4; frame++) {
      t.mock.timers.tick(100);
      assert.equal(root.requests, requests + frame + 1, "one ordinary render request per clock tick, not per tool");
      root.render(30); // Acknowledge the requested host visit and rearm its fallback.
      const rows = first.render(30).map(plain); seen.add(rows[0]![1]!);
      assert.deepEqual(rows.map((row) => row.slice(3)), initial.map((row) => row.slice(3)), "every argument/continuation is unchanged");
      assert.equal(controller.cacheStats().builds, builds, "ticks cause no custom layout rebuilds or global invalidation");
    }
    assert.equal(seen.size, 4);
    controller.logSnapshot();
    const aggregate = records.find(record => record.area === 'animation' && record.explanation.startsWith('Snapshot'));
    assert.equal(aggregate?.fields?.wakes, 4); assert.equal(aggregate?.fields?.requests, 4);
    assert.equal(aggregate?.fields?.participants, 2);
    assert.equal(records.some(record => record.explanation.includes('tick')), false, 'no per-tick records');
    const armed = intervals.mock.calls.length;
    first.updateResult({ isError: true, content: [{ type: "text", text: "PARTIAL" }] }, true);
    first.render(30); assert.equal(intervals.mock.calls.length, armed, "partial failure keeps the existing deadline");
    first.updateResult({ content: [] }); assert.equal(clears.mock.calls.length, 0, "other running tool keeps the clock alive");
    assert.ok(first.render(30).map(plain)[0]!.startsWith(" → read"));
    second.updateResult({ isError: true, content: [{ type: "text", text: "FULL_ERROR" }] });
    assert.equal(clears.mock.calls.length, 1, "final result stops the last clock before another render");
    const finalRequests = root.requests; t.mock.timers.tick(100000); assert.equal(root.requests, finalRequests, "zero redraws during idle");
    assert.equal(second.render(80).at(-1), ' ⚙ custom [drop="1,2,3,4"]');
    second.updateResult(undefined); second.render(80); assert.equal(intervals.mock.calls.length, armed + 1);
    controller.restore(); assert.equal(clears.mock.calls.length, 2);
    const restored = root.requests; t.mock.timers.tick(100000); assert.equal(root.requests, restored, "restore cancels animation, not just its output");
  } finally { controller.restore(); }
});

test("spinner clock ignores native/hidden/image/expanded/zero-width tools and drops detached subtrees", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const intervals = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  const tool = new Tool("custom"), branch = new Container(); branch.addChild(tool);
  tool.result = undefined;
  const { root, controller } = setup([branch]);
  try {
    tool.expanded = true; tool.render(80);
    tool.expanded = false; tool.hideComponent = true; tool.render(80);
    tool.hideComponent = false; tool.result = { content: [{ type: "image" }] }; tool.isPartial = true; tool.render(80);
    tool.result = undefined; tool.isPartial = false; tool.render(0);
    assert.equal(intervals.mock.calls.length, 0);
    tool.render(80); assert.equal(intervals.mock.calls.length, 1);
    tool.setExpanded(true); assert.equal(clears.mock.calls.length, 1, "expansion stops immediately");
    tool.setExpanded(false); tool.render(80); assert.equal(intervals.mock.calls.length, 2);
    tool.hideComponent = true; const hidden = root.requests; t.mock.timers.tick(100);
    assert.equal(clears.mock.calls.length, 1, "the expired timeout is no longer a pending handle");
    assert.equal(root.requests, hidden, "hidden call gets no spinner redraw");
    tool.hideComponent = false; tool.render(80);
    tool.updateResult({ content: [{ type: "image" }] }, true); assert.equal(clears.mock.calls.length, 2);
    tool.updateResult(undefined); tool.render(80); tool.render(0); assert.equal(clears.mock.calls.length, 3);
    tool.render(80); root.removeChild(branch);
    const detached = root.requests; t.mock.timers.tick(100);
    assert.equal(clears.mock.calls.length, 4); assert.equal(root.requests, detached, "detached subtree cannot keep a clock running");
    root.addChild(branch); tool.render(80); assert.equal(intervals.mock.calls.length, 6);
    controller.restore(); assert.equal(clears.mock.calls.length, 5);
    const inactive = root.requests; t.mock.timers.tick(100000); assert.equal(root.requests, inactive);
  } finally { controller.restore(); }
  const native = new Tool("bash", { command: "sleep 1" }); native.result = undefined;
  const second = setup([native]);
  try { native.render(80); assert.equal(intervals.mock.calls.length, 6, "default Bash card owns no compact spinner"); }
  finally { second.controller.restore(); }
});

test("spinner clock stops on native zero-row visibility and render failure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const intervals = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  class SelfTool extends Tool {
    visible = true;
    getRenderShell() { return "self"; }
    render(width: number) { return this.visible ? super.render(width) : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const tool = new SelfTool("custom"); tool.result = undefined;
  const root = new Root(); root.addChild(tool);
  let bad = false;
  const controller = installTidyUi(root, () => { if (bad) throw new Error("paint failure"); return color; });
  try {
    tool.visible = false; assert.deepEqual(tool.render(80), []); assert.equal(intervals.mock.calls.length, 0);
    tool.visible = true; tool.render(80); assert.equal(intervals.mock.calls.length, 1);
    tool.visible = false; assert.deepEqual(tool.render(80), []); assert.equal(clears.mock.calls.length, 1);
    tool.visible = true; tool.render(80); bad = true; tool.render(80);
    assert.equal(controller.active, false); assert.equal(clears.mock.calls.length, 2);
    const requests = root.requests; t.mock.timers.tick(10000); assert.equal(root.requests, requests);
  } finally { controller.restore(); }
});

test("spinner attachment follows stable TUI renderer replacement without probes, writes or orphan redraws", (t) => {
  // Explicit one-shot handles isolate stable-proxy lifecycle from host scheduling.
  const callbacks = new Map<NodeJS.Timeout, () => void>();
  let now = 0; t.mock.method(performance, "now", () => now);
  const intervals = t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
    assert.equal(milliseconds, 100);
    const handle = { unref() { return this; } } as NodeJS.Timeout;
    callbacks.set(handle, callback); return handle;
  });
  const clears = t.mock.method(globalThis, "clearTimeout", (handle: NodeJS.Timeout) => { callbacks.delete(handle); });
  const tick = () => {
    now += 100;
    for (const [handle, callback] of [...callbacks]) if (callbacks.delete(handle)) callback();
  };
  const noop = () => {};
  const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false, start: noop, stop: noop,
    drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
    clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
  const roots = [new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false)], requests = [0, 0];
  const documents = roots.map(() => new Container()); roots[0]!.addChild(documents[0]!);
  roots.forEach((root, index) => { root.requestRender = () => { requests[index]!++; }; });
  let current = roots[0]!;
  const reference = new Proxy({}, {
    get: (_target, property) => {
      assert.notEqual(property, "handleViewportInput");
      const value = Reflect.get(current, property, current);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, current, args) : value;
    },
    set: () => { throw new Error("No renderer writes"); },
    defineProperty: () => { throw new Error("No receiver probe"); },
    getPrototypeOf: () => Reflect.getPrototypeOf(current),
  }) as TuiAltScreen;
  const first = new Tool("read"); first.result = undefined; documents[0]!.addChild(first);
  const controller = installTidyUi(reference, () => color);
  try {
    first.render(80); tick(); assert.equal(intervals.mock.calls.length, 1);
    current = roots[1]!; current.addChild(documents[1]!); const before = [...requests];
    documents[1]!.render(80); tick();
    assert.equal(callbacks.size, 0); assert.deepEqual(requests, before, "old root cannot keep redrawing a replacement renderer");
    const second = new Tool("custom"); second.result = undefined; documents[1]!.addChild(second);
    assert.ok(second.render(80).at(-1)!.startsWith(" ⠋ "));
    tick(); assert.equal(intervals.mock.calls.length, 2);
    assert.equal(requests[1], before[1]! + 1); assert.equal(requests[0], before[0]);
    documents[1]!.render(80); // The new renderer acknowledges its pending request.
    second.updateResult({ content: [] }); assert.equal(clears.mock.calls.length, 1);
    assert.equal(callbacks.size, 0);
  } finally { controller.restore(); }
});

test("extension off and shutdown cancel active clocks; non-TUI loading starts none", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const intervals = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  // Broker startup deadlines share global timers, but are not the 100ms animation clock.
  const animations = () => intervals.mock.calls.filter(call => call.arguments[1] === 100);
  const animationStops = () => {
    const handles = new Set<unknown>(animations().map(call => call.result));
    return clears.mock.calls.filter(call => handles.has(call.arguments[0])).length;
  };
  const h = extensionHarness("tui"), tool = new Tool(); tool.result = undefined; h.root.addChild(tool);
  try {
    await h.events.get("session_start")!({}, h.ctx); h.root.render(80); assert.equal(animations().length, 1);
    await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, false); assert.equal(animationStops(), 1);
    const off = h.root.requests; t.mock.timers.tick(10000); assert.equal(h.root.requests, off);
    await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, true); h.root.render(80); assert.equal(animations().length, 2);
    h.events.get("session_shutdown")!({}, h.ctx); assert.equal(animationStops(), 2);
    const closed = h.root.requests; t.mock.timers.tick(10000); assert.equal(h.root.requests, closed);
    for (const mode of ["print", "json", "rpc"] as const) {
      const starts = intervals.mock.calls.length;
      const other = extensionHarness(mode); other.root.addChild(tool);
      await other.events.get("session_start")!({}, other.ctx); other.root.render(80); other.events.get("session_shutdown")!({}, other.ctx);
      assert.equal(intervals.mock.calls.length, starts, `${mode} installs no timers`);
    }
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
});

test("pending, partial, success and errors are distinguishable without full output", () => {
  const tool = new Tool();
  const { controller } = setup([tool]);
  try {
    tool.result = undefined; tool.isPartial = true;
    assert.ok(spinnerFrames.includes(plain(tool.render(80)[0]!)[1]!));
    assert.doesNotMatch(tool.render(80).join(""), /…/u);
    tool.result = { content: [{ type: "text", text: "PARTIAL_OUTPUT" }] };
    assert.ok(spinnerFrames.includes(plain(tool.render(80)[0]!)[1]!));
    assert.doesNotMatch(tool.render(80).join(""), /…/u);
    tool.isPartial = false;
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt");
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL_OUTPUT/);
    tool.result = { isError: true, content: [{ type: "text", text: "ENOENT: missing file\nstack details" }] };
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt");
    assert.doesNotMatch(tool.render(80).join(""), /ENOENT|stack details|✓|✗/u);
  } finally { controller.restore(); }
});

test("summary content survives wrapping and Unicode at every usable width", () => {
  const tool = new Tool("read", { path: "文件/🦀/é".repeat(20) });
  const { controller } = setup([tool]);
  try {
    for (let width = 1; width < 81; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${visibleWidth(row)}`);
      assert.ok(plain(line).trim(), "completed summary remains visible without a completion badge");
      assert.doesNotMatch(rows.map(plain).join(""), /✓|✗/u);
    }
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("terminal controls, multiline text and bidi formatting cannot escape the summary", () => {
  assert.equal(sanitize("a\n\r\tb\x1b[31mRED\x1b[0m\x07\u202e"), "a bRED");
  const tool = new Tool("custom\nname", { query: "hello\x1b]0;bad\x07\nworld\x9b2J" });
  const { controller } = setup([tool]);
  try {
    assert.equal(tool.render(80).length, 1);
    assert.doesNotMatch(tool.render(80)[0], /[\x00-\x1f\x7f-\x9f\u202e]/);
  } finally { controller.restore(); }
});

test("generic descriptions retain useful fields and bound bulky payload previews", () => {
  assert.match(describeArgs("read", { path: "file", offset: 5, limit: 10 }), /file.*5.*10/);
  assert.match(describeArgs("grep", { pattern: "abc", path: "src" }), /abc.*src/);
  assert.match(describeArgs("aft_zoom", { path: "a.ts", symbols: ["first", "second"] }), /a.ts.*first.*second/);
  assert.match(describeArgs("strange", { mode: "fast", kind: "thing" }), /mode.*fast/);
  assert.ok(describeArgs("strange", { content: "PAYLOAD".repeat(1000) }).length < 300);
  assert.equal(describeArgs("read", {}), "");
});

test("policy overrides are exact names and compact wins", () => {
  const tools = [new Tool("read"), new Tool("custom"), new Tool("bash"), new Tool("custom_extra")];
  const { controller } = setup(tools, { cards: ["custom", "bash"], compact: ["bash"] });
  try {
    assert.equal(tools[0].render(80).length, 1);
    assert.match(tools[1].render(80)[1], /NATIVE/);
    assert.match(tools[2].render(80).at(-1)!, /^ ⚙ bash /);
    assert.match(tools[3].render(80).at(-1)!, /^ ⚙ custom_extra /);
  } finally { controller.restore(); }
});

test("mouse dispatch uses rendered summary heights and ignores gaps, pending calls and wheel", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, second]);
  try {
    root.render(80);
    assert.equal(root.handleMouse(mouse(1)), undefined); // separating row
    assert.equal(first.expanded, false);
    assert.ok(root.handleMouse(mouse(3))?.handled);
    assert.equal(first.expanded, false); assert.equal(second.expanded, true);
    assert.match(second.render(80)[1], /NATIVE/);
    second.handleMouse(mouse(1)); assert.equal(second.expanded, false);
    first.isPartial = true;
    assert.equal(first.handleMouse(mouse(1)), undefined);
    assert.equal(first.handleMouse({ ...mouse(1), type: "wheel", wheelDelta: -1 }), undefined);
  } finally { controller.restore(); }
});

test("theme is read during rendering instead of captured at installation", () => {
  const root = new Root(), tool = new Tool(); root.addChild(tool);
  let prefix = "A";
  const controller = installTidyUi(root, () => ({ fg: (_color, text) => `${prefix}${text}` }));
  try {
    const before = tool.render(80).join(""); prefix = "B";
    const after = tool.render(80).join("");
    assert.notEqual(before, after); assert.match(after, /B/);
  } finally { controller.restore(); }
});

test("restoration is idempotent; re-enabling covers existing and future tools", () => {
  const tool = new Tool();
  const { root, controller, original, addChild } = setup([tool]);
  controller.restore(); controller.restore();
  assert.equal(controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  const second = installTidyUi(root, () => color);
  try {
    const future = new Tool(); root.addChild(future);
    assert.equal(future.render(80).at(-1), " → read a.txt");
  } finally { second.restore(); }
});

test("restoration does not overwrite methods subsequently replaced by another extension", () => {
  const { controller, original, addChild } = setup([new Tool()]);
  const patched = Tool.prototype.render;
  const replacement = function () { return ["OTHER"]; };
  Tool.prototype.render = replacement;
  try {
    controller.restore();
    assert.equal(Tool.prototype.render, replacement);
    assert.equal(Container.prototype.addChild, addChild);
  } finally {
    assert.notEqual(patched, original);
    Tool.prototype.render = original;
  }
});

test("incompatible existing or future tool contract restores all owned hooks and warns", () => {
  const warnings: string[] = [], diagnostics: string[] = [];
  const diagnostic = (_level: unknown, _area: unknown, explanation: string) => diagnostics.push(explanation);
  const bad = new Tool(); Object.defineProperty(bad, "expanded", { value: "not-a-boolean" });
  const { controller, original, addChild } = setup([bad], { warn: (reason) => warnings.push(reason), diagnostic });
  assert.equal(controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  assert.equal(warnings.length, 1);
  const live = setup([new Tool()], { warn: (reason) => warnings.push(reason), diagnostic });
  live.root.addChild(bad);
  assert.equal(live.controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  assert.equal(warnings.length, 2);
  assert.equal(diagnostics.filter(text => text === "Tool component contract is incompatible; native rendering retained").length, 2);
  live.controller.restore(); live.root.addChild(bad);
  assert.equal(diagnostics.filter(text => text === "Tool component contract is incompatible; native rendering retained").length, 2, "known failure is recorded once per adapter");
});

test("foreign TUI instance is left untouched with a compatibility warning", () => {
  const warnings: string[] = [];
  const controller = installTidyUi({} as Root, () => color, { warn: (reason) => warnings.push(reason) });
  assert.equal(controller.active, false);
  assert.equal(warnings.length, 1);
});

test("frozen tool prototypes fail safely without partially installing hooks", () => {
  class Frozen extends Tool { render(width: number) { return super.render(width); } handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); } }
  Object.freeze(Frozen.prototype);
  const warnings: string[] = [];
  const before = Container.prototype.addChild;
  const root = new Root(); root.addChild(new Tool()); root.addChild(new Frozen());
  const original = Tool.prototype.render;
  const controller = installTidyUi(root, () => color, { warn: (reason) => warnings.push(reason) });
  assert.equal(controller.active, false);
  assert.equal(Container.prototype.addChild, before);
  assert.equal(Tool.prototype.render, original);
  assert.equal(warnings.length, 1);
});

function fixtureSyntaxOptions(): SyntaxRuntimeOptions {
  return { standaloneVersion: "fixture", settings: {
    async load() { return { ok: true, syntaxTheme: { kind: "pi" } }; }, async update() { return { ok: true }; },
  }, provider: { async tryShared() { return undefined; }, async acquireOwned() { throw new Error("fixture unavailable"); } } };
}

function extensionHarness(mode: "tui" | "print" | "json" | "rpc" = "tui", flagValues: Record<string, string> = {}) {
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

test("extension lifecycle removes the temporary widget, restores on shutdown, and does not stack", async () => {
  const h = extensionHarness();
  const before = Container.prototype.addChild;
  try {
    await h.events.get("session_start")!({}, h.ctx);
    const installed = Container.prototype.addChild;
    assert.notEqual(installed, before);
    await h.events.get("session_start")!({}, h.ctx);
    assert.equal(Container.prototype.addChild, installed);
    assert.deepEqual(h.widgets, ["pi-tidy-ui-terminal-colors", "pi-tidy-ui-capture", "pi-tidy-ui-capture", "pi-tidy-ui-editor-status"]);
    assert.deepEqual(h.widgetPlacements.get("pi-tidy-ui-terminal-colors"), { placement: "belowEditor" });
    assert.deepEqual(h.widgetComponents.get("pi-tidy-ui-terminal-colors")!.render(80), [], "colors observation adds no layout rows");
    assert.deepEqual(h.widgetPlacements.get("pi-tidy-ui-editor-status"), { placement: "belowEditor" });
    assert.deepEqual([...h.flags.keys()], ["tidy-ui-card", "tidy-ui-compact", "tidy-ui-cache-mb", "tidy-ui-card-cache-mb"]);
    await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, false);
    assert.equal(Container.prototype.addChild, before);
    assert.equal(h.widgetComponents.size, 0, "off removes the persistent status widget");
    await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, true);
    assert.notEqual(Container.prototype.addChild, before);
    assert.match(h.root.render(80).at(-1)!, /read a\.txt/);
    await h.commands.get("tidy-ui")!.handler("invalid", h.ctx);
    assert.match(h.notices.at(-1)!, /Usage:/);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(Container.prototype.addChild, before);
});

test("off persists across session replacements but a reload creates a fresh enabled runtime", async () => {
  const h = extensionHarness(); const before = Container.prototype.addChild;
  await h.events.get("session_start")!({}, h.ctx);
  await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, false);
  h.events.get("session_shutdown")!({}, h.ctx);
  await h.events.get("session_start")!({}, h.ctx);
  assert.equal(Container.prototype.addChild, before);
  const fresh = extensionHarness();
  try {
    await fresh.events.get("session_start")!({}, fresh.ctx);
    assert.notEqual(Container.prototype.addChild, before);
  } finally { fresh.events.get("session_shutdown")!({}, fresh.ctx); }
});

test("print, JSON and RPC modes install no UI hooks or widgets", async () => {
  const before = Container.prototype.addChild;
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = extensionHarness(mode);
    await h.events.get("session_start")!({}, h.ctx);
    await h.commands.get('tidy-ui')!.handler('', h.ctx);
    assert.equal(h.widgets.length, 0);
    assert.equal(Container.prototype.addChild, before);
    assert.match(h.notices.at(-1)!, /available only in terminal mode/);
    h.events.get("session_shutdown")!({}, h.ctx);
  }
});

test("empty self-rendered tools remain hidden even when hideComponent is false and compact is forced", () => {
  class SelfTool extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return this.expanded || width < 30 ? ["NATIVE SELF"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new SelfTool("self_hidden"), next = new Tool();
  const { root, controller } = setup([new Text("User", 0, 0), hidden, next], { compact: ["self_hidden"] });
  try {
    assert.equal(hidden.hideComponent, false); // native visibility is not represented by this field
    assert.deepEqual(hidden.render(80), []);
    assert.equal(root.render(80).some((line) => line.includes("self_hidden")), false);
    assert.equal(next.render(80)[0], ""); // separation still follows the preceding visible user text
    assert.match(hidden.render(24).at(-1)!, /^ ⚙ self_hidden /); // visibility can depend on width
    hidden.expanded = true;
    assert.deepEqual(hidden.render(80), ["NATIVE SELF"]);
  } finally { controller.restore(); }
});

test("exact read/edit/write summaries use directional arrows; other compact tools keep the one-column gear", async () => {
  const names = ["read", "Read", "grep", "aft_inspect", "ctx_reduce", "TaskList", "custom", "write", "edit", "Write", "Edit", "write_custom", "edit_custom", "bash"];
  const tools = names.map((name) => new Tool(name, { path: "a.txt", query: "x".repeat(50) }));
  const root = new Root(); tools.forEach((tool) => root.addChild(tool));
  const controller = installTidyUi(root, () => ({ fg: (role, text) =>
    `\x1b[${role === "dim" ? 90 : 37}m${text}\x1b[39m` }), { compact: names });
  const terminal = new xterm.Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  try {
    assert.equal(visibleWidth(" ⚙ "), 3, "literal gear has no emoji variation selector or extra column");
    for (const tool of tools) {
      const glyph = tool.toolName === "read" ? "→" : tool.toolName === "edit" || tool.toolName === "write" ? "←" : "⚙";
      const args = structuredClone(tool.args);
      for (const state of ["pending", "partial", "success", "error"]) {
        tool.isPartial = state === "partial";
        tool.updateResult(state === "pending" ? undefined : {
          isError: state === "error", content: [{ type: "text", text: "ERROR_TEXT" }],
        }, state === "partial");
        const rows = tool.render(30).filter((row) => plain(row).trim());
        const leading = state === "pending" || state === "partial" ? "⠋" : glyph;
        assert.ok(rows[0]!.startsWith(`\x1b[${state === "error" ? 37 : 90}m ${leading} \x1b[39m`), `${tool.toolName}: ${state === "error" ? "error" : "dim"} ${glyph}`);
        assert.ok(rows.slice(1).every((row) => plain(row).startsWith("   ")));
        assert.ok(rows.every((row) => visibleWidth(row) <= 29));
        assert.deepEqual(tool.args, args);
        for (let width = 1; width <= 5; width++)
          assert.deepEqual(tool.render(width).map(plain).filter((row) => row.trim()), [(width >= 3 ? " " : "") + leading], "tiny viewports retain pending state or tool glyph and the margins that fit");
      }
      terminal.reset();
      const row = tool.render(80).find((line) => plain(line).trim())!;
      await new Promise<void>((done) => terminal.write(row, done));
      const screen = terminal.buffer.active.getLine(0)!;
      assert.equal(screen.getCell(1)!.getChars(), glyph);
      assert.equal(screen.getCell(1)!.getWidth(), 1);
      assert.equal(screen.getCell(3)!.getChars(), tool.toolName[0]);
      assert.equal(terminal.buffer.active.cursorY, 0);
      tool.setExpanded(true);
      assert.deepEqual(tool.render(80), ["", `NATIVE ${tool.toolName}`, "FULL_OUTPUT"]);
    }
  } finally { terminal.dispose(); controller.restore(); }
});

test("read summaries use distinct semantic roles and bracket only non-path parameters", () => {
  const root = new Root(), tool = new Tool("read", { path: "a.txt", offset: 5, limit: 10 });
  root.addChild(tool);
  const parts: { color: string; text: string }[] = [];
  const controller = installTidyUi(root, () => ({ fg: (color, text) => { parts.push({ color, text }); return text; } }));
  try {
    assert.equal(tool.render(120).at(-1), " → read a.txt [offset=5, limit=10]");
    assert.deepEqual(parts, [
      { color: "dim", text: " → " },
      { color: "toolTitle", text: "read" },
      { color: "muted", text: " a.txt" },
      { color: "dim", text: " [offset=5, limit=10]" },
    ]);
  } finally { controller.restore(); }
});

test("read without parameters has no empty brackets; patterns are primary descriptions", () => {
  const read = new Tool(), grep = new Tool("grep", { pattern: "needle", path: "src" });
  const { controller } = setup([read, grep]);
  try {
    assert.equal(read.render(120).at(-1), " → read a.txt");
    assert.equal(grep.render(120).at(-1), ' ⚙ grep "needle" in src');
  } finally { controller.restore(); }
});

test("colored completed summary wrapping preserves content and terminal-width bounds", () => {
  const root = new Root(), tool = new Tool("read", { path: "文件/🦀/é".repeat(20), offset: 5, limit: 100 });
  root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    const color = colors[role] ?? 31;
    return `\x1b[${color}m${text}\x1b[39m`;
  } }));
  try {
    for (let width = 1; width <= 80; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width);
      assert.ok(plain(line).trim(), "completed summary remains visible without a completion badge");
      assert.doesNotMatch(rows.map(plain).join(""), /✓|✗/u);
    }
  } finally { controller.restore(); }
});

test("shared summaries cover active tool argument shapes and the exact edit-path rule", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["read", { limit: 10, path: "src/app.ts", offset: 5 }, 'src/app.ts [offset=5, limit=10]'],
    ["grep", { include: "*.ts", path: "src", pattern: "needle" }, '"needle" in src [include="*.ts"]'],
    ["custom", { pattern: "", path: "", target: "other", query: "why" }, '"" [query="why", path="", target="other"]'],
    ["aft_search", { includeTests: false, query: "where is auth", path: "/repo" }, '/repo [query="where is auth", includeTests=false]'],
    ["aft_outline", { target: ["src", "tests"], files: true }, '[target=["src","tests"], files=true]'],
    ["aft_inspect", { sections: "diagnostics", scope: ["src", "tests"] }, '[scope=["src","tests"], sections="diagnostics"]'],
    ["aft_zoom", { path: "a.ts", symbols: ["render", "update"], callgraph: true }, 'a.ts [symbols=["render","update"], callgraph=true]'],
    ["aft_callgraph", { depth: 2, symbol: "render", path: "a.ts", op: "callers" }, 'a.ts [op="callers", symbol="render", depth=2]'],
    ["ast_grep_search", { paths: ["src"], lang: "typescript", pattern: "$X($$$)" }, '"$X($$$)" [paths=["src"], lang="typescript"]'],
    ["ast_grep_replace", { rewrite: "BULKY", pattern: "foo()", lang: "typescript" }, '"foo()" [lang="typescript", rewrite="BULKY"]'],
    ["TaskCreate", { description: "Investigate", subject: "Rendering" }, '[subject="Rendering", description="Investigate"]'],
    ["TaskUpdate", { status: "completed", taskId: "1" }, '[taskId="1", status="completed"]'],
    ["Agent", { prompt: "BULKY", subagent_type: "reviewer", description: "Review" }, '[description="Review", subagent_type="reviewer", prompt="BULKY"]'],
    ["ctx_memory", { content: "BULKY", category: "CONSTRAINTS", action: "write" }, '[action="write", category="CONSTRAINTS", content="BULKY"]'],
    ["web_search", { numResults: 5, queries: ["one", "two"] }, '[queries=["one","two"], numResults=5]'],
    ["fetch_content", { url: "https://example.com", prompt: "BULKY", mode: "answer" }, 'https://example.com [mode="answer", prompt="BULKY"]'],
    ["aft_safety", { name: "snap", op: "checkpoint", files: ["src/a.ts"] }, '[op="checkpoint", files=["src/a.ts"], name="snap"]'],
    ["custom", { pattern: null, path: { id: 1 }, target: "valid", zero: 0, flag: false, empty: "", nullable: null }, 'valid [path={"id":1}, pattern=null, empty="", flag=false, nullable=null, zero=0]'],
    ["custom", { url: "https://example.com", target: "target", path: "first" }, 'first [target="target", url="https://example.com"]'],
    ["custom", { path: "my file.ts", "odd key": [false, 0, null] }, '"my file.ts" ["odd key"=[false,0,null]]'],
    ["TaskList", {}, ''],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(describeArgs(name, args), expected, name);
    assert.equal(describeArgs("entirely_unknown", args), expected, "same rules for any tool name");
  }
});

test("payload previews and exact top-level masking preserve remaining structure and source data", () => {
  const args = { content: "PAYLOAD", edits: [], code: "PAYLOAD", input: "PAYLOAD", messages: [],
    prompt: "PAYLOAD", newString: "PAYLOAD", oldString: "PAYLOAD", appendContent: "PAYLOAD",
    rewrite: "PAYLOAD", oldText: "PAYLOAD", newText: "PAYLOAD", api_key: "SECRET", password: "SECRET",
    Authorization: "SECRET", apiKey: "SECRET", token: "SECRET", maxTokens: 0,
    nested: { content: "visible", text: "a\nb" }, query: "a\nb", omitted: undefined };
  const before = structuredClone(args);
  const output = describeArgs("custom", args);
  assert.doesNotMatch(output, /SECRET|omitted/);
  for (const key of ["content", "code", "input", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText"])
    assert.ok(output.includes(`${key}="PAYLOAD"`));
  assert.ok(output.includes("edits=[]") && output.includes("messages=[]"));
  assert.match(output, /api_key="<redacted>"/);
  assert.match(output, /Authorization="<redacted>"/);
  assert.match(output, /maxTokens=0/);
  assert.match(output, /nested=\{"content":"visible","text":"a b"\}/);
  assert.match(output, /^\[query="a b"/);
  assert.deepEqual(args, before);
});

test("multiline summaries retain all parameters, align to tool name and recompute separator height", () => {
  const short = new Tool(), long = new Tool("custom", { z: "last", query: "x".repeat(220), enabled: false, limit: 0 });
  const hidden = new Tool(); hidden.hideComponent = true;
  const next = new Tool("read", { path: "b.txt" }), last = new Tool("read", { path: "c.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), short, long, hidden, new Text("", 0, 0), next, last]);
  try {
    assert.equal(short.render(40)[0], "");
    const rows = long.render(40).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows[0].startsWith(" ⚙ custom"));
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " "));
    for (const row of rows) assert.ok(visibleWidth(row) <= 40);
    const joined = rows.map((row) => row.slice(3)).join("");
    assert.match(joined, /x{220}/); // no previous 180-column argument cap
    for (const key of ['query=', 'limit=0', 'enabled=false', 'z="last"']) assert.ok(joined.includes(key), key);
    assert.match(joined, /\]$/);
    assert.equal(next.render(40)[0], "");
    assert.equal(last.render(40).length, 1); // next's leading separator is not content
    assert.notEqual(root.render(40).at(-1), "");
    assert.equal(long.render(1000).length, 1);
    assert.equal(next.render(1000).length, 1);
    assert.equal(next.render(40)[0], "");
  } finally { controller.restore(); }
});

test("clicks on continuation rows expand only that call; adaptive separator rows are not clickable", () => {
  const first = new Tool(), long = new Tool("custom", { query: "x".repeat(80) }), next = new Tool();
  const { root, controller } = setup([first, long, next]);
  try {
    root.render(24);
    const height = long.render(24).length;
    assert.ok(height > 1);
    assert.equal(root.handleMouse(mouse(1 + height, 24)), undefined); // next's leading gap
    assert.equal(long.expanded, false); assert.equal(next.expanded, false);
    assert.ok(root.handleMouse(mouse(2, 24))?.handled); // long's second content row
    assert.equal(first.expanded, false); assert.equal(long.expanded, true); assert.equal(next.expanded, false);
  } finally { controller.restore(); }
});

test("native self cards get only a missing separator after multiline calls and adjusted mouse coordinates", () => {
  class NativeSelf extends Tool {
    received: number | undefined;
    getRenderShell() { return "self"; }
    render(_width: number) { return ["SELF CARD"]; }
    handleMouse(event: TuiMouseEvent) {
      this.received = event.y;
      return { handled: true as const, target: { component: this, originX: event.screenX - event.x,
        originY: event.screenY - event.y, width: event.width, height: event.height } };
    }
  }
  const long = new Tool("custom", { query: "x".repeat(80) }), card = new NativeSelf("native_self");
  const bash = new Tool("bash");
  const { controller } = setup([long, card, bash], { cards: ["native_self"] });
  try {
    assert.deepEqual(card.render(24), ["", "SELF CARD"]);
    assert.equal(card.handleMouse(mouse(0, 24)), undefined);
    assert.ok(card.handleMouse(mouse(1, 24))?.handled);
    assert.equal(card.received, 0);
    assert.deepEqual(bash.render(24), ["", "NATIVE bash", "FULL_OUTPUT"]);
    assert.deepEqual(card.render(200), ["SELF CARD"]);
  } finally { controller.restore(); }
});

test("quoting preserves edge spaces, escapes punctuation and handles non-JSON values visibly", () => {
  assert.equal(describeArgs("custom", { path: " file " }), '" file "');
  assert.equal(describeArgs("custom", { path: 'a"b\\c', query: 'a"b\\c' }), '"a\\"b\\\\c" [query="a\\"b\\\\c"]');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(describeArgs("custom", { query: cyclic }), '[query="[unavailable]"]');
  assert.equal(describeArgs("custom", { target: [], pattern: 0 }), '[target=[], pattern=0]');
  assert.equal(describeArgs("custom", { scope: "src", paths: ["tests"], url: null }), 'src [paths=["tests"], url=null]');
});

test("primary locations require a nonempty string and otherwise lead named parameters", () => {
  for (const key of ["path", "target", "url", "scope"]) {
    assert.equal(describeArgs("custom", { [key]: "src", query: "q" }), 'src [query="q"]');
    assert.equal(describeArgs("custom", { [key]: " src " }), '" src "');
    assert.equal(describeArgs("custom", { [key]: " " }), '" "'); // no implicit trimming
    for (const value of ["", [], ["src"], { root: "src" }, null, 0, false]) {
      const args = { query: "q", [key]: value, paths: ["first"] };
      const before = structuredClone(args);
      const expected = `[query="q", paths=["first"], ${key}=${JSON.stringify(value)}]`;
      assert.equal(describeArgs("custom", args), expected);
      assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
      assert.deepEqual(args, before);
    }
  }
  assert.equal(describeArgs("custom", { pattern: "x", path: "", target: "other", query: "q" }), '"x" [query="q", path="", target="other"]');
  assert.equal(describeArgs("custom", { pattern: "", path: "a" }), '"" in a');
  assert.equal(describeArgs("custom", { path: [], target: "", url: "https://example.com", scope: "src", query: "q" }), 'https://example.com [query="q", path=[], target="", scope="src"]');
  const all = { query: "q", scope: null, url: "", target: [], path: "", paths: [], alpha: true };
  assert.equal(describeArgs("custom", all), '[query="q", paths=[], path="", target=[], url="", scope=null, alpha=true]');
  assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(all).reverse())), '[query="q", paths=[], path="", target=[], url="", scope=null, alpha=true]');
});

test("paths remains named after action/query fields and before locations/unknown parameters", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ paths: ["src"] }, '[paths=["src"]]'],
    [{ query: "q", paths: [] }, '[query="q", paths=[]]'],
    [{ query: "q", paths: "src", path: "a", op: "search", z: 0 }, 'a [op="search", query="q", paths="src", z=0]'],
    [{ paths: null, pattern: "x", path: ["a"], limit: 0 }, '"x" [paths=null, path=["a"], limit=0]'],
    [{ scope: [], paths: ["src"], query: "q" }, '[query="q", paths=["src"], scope=[]]'],
    [{ query: "q", paths: { root: "src" } }, '[query="q", paths={"root":"src"}]'],
    [{ Paths: ["src"], query: "q" }, '[query="q", Paths=["src"]]'],
  ];
  for (const [args, expected] of cases) {
    const before = structuredClone(args);
    assert.equal(describeArgs("custom", args), expected);
    assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
    assert.deepEqual(args, before);
  }
});

test("important fields precede locale-independent alphabetical keys regardless of input order", () => {
  const first = { zebra: 1, startLine: 2, query: "q", endLine: 3, alpha: 4, Alpha: 5, symbol: "s", paths: ["src"] };
  const second = Object.fromEntries(Object.entries(first).reverse());
  const expected = '[query="q", paths=["src"], symbol="s", startLine=2, endLine=3, Alpha=5, alpha=4, zebra=1]';
  assert.equal(describeArgs("custom", first), expected);
  assert.equal(describeArgs("custom", second), expected);
  for (const key of ["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"]) {
    assert.equal(describeArgs("custom", { [key]: "SECRET" }), `[${key}="<redacted>"]`);
  }
  assert.equal(describeArgs("custom", { TOKEN: "ordinary", tokenLimit: 0 }), '[TOKEN="ordinary", tokenLimit=0]');
});

test("colored word-boundary wraps never add padding or blank clickable content rows", () => {
  const root = new Root(), tool = new Tool("read", { path: "abcdefghijklm", limit: 1 });
  root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    return `\x1b[${colors[role] ?? 31}m${text}\x1b[39m`;
  } }));
  try {
    assert.deepEqual(tool.render(21).map(plain), [' → read', '   abcdefghijklm', '   [limit=1]']);
    // The original colored-boundary geometry now occurs one column wider.
    assert.deepEqual(tool.render(22).map(plain), [' → read abcdefghijklm', '   [limit=1]']);
    tool.args = { path: "abcdefghijklm", query: "x".repeat(40) };
    const rows = tool.render(21).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " " && row.trim()));
    assert.ok(rows.every((row) => visibleWidth(row) <= 21));
    assert.match(rows.map((row) => row.slice(3)).join(""), /x{40}/);
  } finally { controller.restore(); }
});

test("array summaries wrap between members instead of splitting paths that fit", () => {
  const paths = [
    "experiments/gruvbox-dark-hard/semantic-implementation-review.md",
    "experiments/gruvbox-dark-hard/semantic-implementation.md",
    "experiments/gruvbox-dark-hard/semantic-analysis.md",
  ];
  const tool = new Tool("aft_inspect", { scope: paths });
  const { controller } = setup([tool]);
  try {
    const before = structuredClone(tool.args);
    const rows = tool.render(110).map(plain);
    assert.equal(rows.length, 3);
    assert.equal(rows[0], ` ⚙ aft_inspect [scope=[${JSON.stringify(paths[0])},`);
    assert.equal(rows[1], `   ${JSON.stringify(paths[1])},`);
    assert.equal(rows[2], `   ${JSON.stringify(paths[2])}]]`);
    assert.deepEqual(tool.args, before);
    assert.equal(rows.map((row) => row.slice(3)).join(""), `aft_inspect ${describeArgs(tool.toolName, tool.args)}`);
    assert.deepEqual(tool.render(110).map(plain), rows);
  } finally { controller.restore(); }
});

test("comma-separated string values can start on the tool-name row and wrap after commas", () => {
  const tool = new Tool("ctx_reduce", { drop: "3,4,5,8,9,10,12,15,18,21" });
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(tool.render(36).map(plain), [
      ' ⚙ ctx_reduce [drop="3,4,5,8,9,10,',
      '   12,15,18,21"]',
    ]);
    // Even a list that fits on its own must use the remaining first-row space.
    tool.updateArgs({ drop: "3,4,5,8,9,10,12" });
    assert.deepEqual(tool.render(30).map(plain), [
      ' ⚙ ctx_reduce [drop="3,4,5,8,',
      '   9,10,12"]',
    ]);
    assert.equal(describeArgs(tool.toolName, tool.args), '[drop="3,4,5,8,9,10,12"]');
  } finally { controller.restore(); }
});

test("comma-aware wrapping preserves nested JSON, quotes, colors, graphemes and width bounds", () => {
  const tool = new Tool("custom", { target: ["a,b", ["文件/🦀/é", "comma,\u0301suffix"], { quoted: 'a,"b\\c' }], drop: "1-3,5,8-10" });
  const root = new Root(); root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    return `\x1b[${colors[role] ?? 31}m${text}\x1b[39m`;
  } }));
  try {
    const expected = `custom ${describeArgs(tool.toolName, tool.args)}`;
    for (let width = 6; width <= 100; width++) {
      const colored = tool.render(width);
      const rows = colored.map(plain);
      assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
      assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row.trim()));
      assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""), expected.replace(/ /g, ""));
      assert.ok(rows.every((row) => !row.slice(3).startsWith("\u0301")), "comma plus combining mark remains one grapheme");
      assert.match(colored.at(-1)!, /\x1b\[90m/u, "wrapped parameters preserve their dim role");
      assert.doesNotMatch(rows.join(""), /✓|✗/u);
    }
  } finally { controller.restore(); }
});

test("comma wrap points preserve native CJK breaks in primary descriptions and parameters on failures", () => {
  const tool = new Tool("custom", { path: "甲乙丙丁", drop: "1,2" });
  const { controller } = setup([tool]);
  try {
    assert.equal(plain(tool.render(16)[0]!), " ⚙ custom 甲乙");
    assert.equal(plain(tool.render(18)[0]!), " ⚙ custom 甲乙丙");
    tool.updateArgs({ drop: "1,2" });
    tool.updateResult({ isError: true, content: [{ type: "text", text: "甲乙丙丁" }] });
    assert.deepEqual(tool.render(28).map(plain), [' ⚙ custom [drop="1,2"]']);
    tool.updateArgs({ target: ["甲乙丙丁", "한글かなカナ"] });
    for (let width = 6; width <= 40; width++) {
      const rows = tool.render(width).map(plain);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""),
        `custom ${describeArgs(tool.toolName, tool.args)}`.replace(/ /g, ""));
    }
  } finally { controller.restore(); }
});

test("comma wrapping still hard-wraps oversized array members and expands continuation clicks", () => {
  const tool = new Tool("custom", { paths: ["x".repeat(90), "tail"] });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(30).map(plain);
    assert.ok(rows.length > 3);
    assert.ok(rows.every((row) => visibleWidth(row) <= 30));
    assert.match(rows.map((row) => row.slice(3)).join(""), /x{90}/);
    assert.match(rows.at(-1)!, /"tail"\]\]$/);
    assert.equal(tool.handleMouse(mouse(2, 30))?.handled, true);
    assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(30), ["", "NATIVE custom", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("summary long-word fills remaining space with and without parameter commas", () => {
  const path = "abcdefghijklmnopqrstuvwxyz";
  const tool = new Tool("read", { path });
  const { controller } = setup([tool]);
  try {
    for (const extras of [{}, { offset: 1, limit: 1 }]) {
      tool.updateArgs({ path, ...extras });
      const rows = tool.render(24).map(plain);
      assert.equal(rows[0], " → read abcdefghijklmno");
      assert.ok(rows[1]!.startsWith("   pqrstuvwxyz"));
      assert.equal(rows.map(row => row.slice(3)).join("").replace(/ /g, ""),
        (`read ${describeArgs("read", tool.args)}`).replace(/ /g, ""));
    }
    tool.updateArgs({ query: "x".repeat(50) });
    assert.ok(plain(tool.render(24)[0]!).startsWith(' → read [query="'), "oversized named tokens also use the first row");
  } finally { controller.restore(); }
});

test("summary long-word chooses the nearest separator after it without splitting fitting words", () => {
  const tool = new Tool("read", { path: "abcdefghij/kl/mnopqrstuvwxyz0123456789" });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(24).map(plain);
    assert.equal(rows[0], " → read abcdefghij/kl/");
    assert.ok(rows[1]!.startsWith("   mnop"));
    assert.equal(rows.map(row => row.slice(3)).join(""), `read ${tool.args.path}`);
    tool.updateArgs({ path: "abcdefghijklmnoqrs" });
    assert.deepEqual(tool.render(24).map(plain), [" → read", "   abcdefghijklmnoqrs"], "a word fitting a full row remains intact");
  } finally { controller.restore(); }
});

test("summary long-word limits punctuation retreat to twenty graphemes and half the remaining columns", () => {
  const tool = new Tool("read");
  const { controller } = setup([tool]);
  try {
    tool.updateArgs({ path: "/" + "x".repeat(50) });
    assert.equal(plain(tool.render(24)[0]!), " → read /" + "x".repeat(14), "a leading slash must not waste fourteen free columns");
    for (const distance of [20, 21, 30]) {
      const path = "x".repeat(74 - distance) + "/" + "y".repeat(60);
      tool.updateArgs({ path });
      const first = plain(tool.render(84)[0]!);
      assert.equal(first, " → read " + path.slice(0, distance === 20 ? 55 : 75), `retreat distance ${distance}`);
    }
  } finally { controller.restore(); }
});

test("summary long-word excludes quotes and brackets and respects preferred JSON escape boundaries", () => {
  const tool = new Tool("read");
  const { controller } = setup([tool]);
  try {
    const quoted = "x".repeat(8) + '"' + "y".repeat(30);
    tool.updateArgs({ path: quoted });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(quoted).slice(0, 15), "escaped quote's backslash is not a preferred cut");
    const attachedQuote = "\u0301" + quoted;
    tool.updateArgs({ path: attachedQuote });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(attachedQuote).slice(0, 16), "quote with an attached combining mark still opens JSON escape tracking");
    const windows = "x".repeat(8) + "\\" + "y".repeat(30);
    tool.updateArgs({ path: windows });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(windows).slice(0, 11), "cut after both serialized backslashes");
    for (const extras of [{}, { offset: 1, limit: 1 }]) {
      tool.updateArgs({ query: "\u0301" + "x".repeat(3) + '"' + "y".repeat(30), ...extras });
      assert.equal(plain(tool.render(24)[0]!).slice(3), (`read ${describeArgs("read", tool.args)}`).slice(0, 21), "quoted parameter with an attached mark retains escape tracking, with or without commas");
    }
    tool.updateArgs({ query: "x\uD800" + "y".repeat(30) });
    assert.equal(plain(tool.render(24)[0]!), ' → read [query="x\\ud800', "backslash within a Unicode escape is not preferred");
    tool.updateArgs({ query: "a\u0600", content: "x".repeat(8) + '"' + "y".repeat(40) });
    assert.equal(plain(tool.render(44)[0]!), ' → read [query="a\u0600", content="xxxxxxxx\\"yyyy', "a Prepend character must not hide the earlier closing quote and leak escape state into another value");
    for (const mark of ['"', "(", ")", "[", "]", "{", "}"]) {
      tool.updateArgs({ query: "x".repeat(3) + mark + "y".repeat(30) });
      const expected = `read ${describeArgs("read", tool.args)}`;
      assert.equal(plain(tool.render(24)[0]!).slice(3), expected.slice(0, 20), `no preferred split at ${mark}`);
    }
  } finally { controller.restore(); }
});

test("summary long-word preserves Unicode graphemes, all text, failure styles, clicks and warm cache hits", () => {
  const path = ("ab/é👩‍👩‍👧‍👦_cdefghijklmno.").repeat(6);
  const tool = new Tool("read", { path, offset: 1, limit: 1 });
  tool.result!.isError = true;
  const root = new Root(); root.addChild(tool);
  const palette = { fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[39m` };
  const controller = installTidyUi(root, () => palette);
  try {
    const expected = `read ${describeArgs("read", tool.args)}`.replace(/ /g, "");
    for (let width = 6; width <= 100; width++) {
      const colored = tool.render(width), rows = colored.map(plain);
      assert.equal(rows.map(row => row.slice(3)).join("").replace(/ /g, ""), expected, `text at width ${width}`);
      assert.ok(rows.every(row => visibleWidth(row) <= width - 1), `one-column margin at ${width}`);
      assert.ok(rows.every(row => !/^[\u0301\u200d]/u.test(row.slice(3))), "no orphan combining or joining mark");
      for (const row of rows) assert.equal(row.split("👩‍👩‍👧‍👦").join("").includes("👩"), false, "no partial family grapheme");
      assert.ok(colored.every(row => row.includes("\x1b[31m")), "all failed rows retain error styling");
      const builds = controller.cacheStats().builds;
      assert.strictEqual(tool.render(width), colored);
      assert.equal(controller.cacheStats().builds, builds);
    }
    const last = tool.render(40).length - 1;
    assert.equal(tool.handleMouse(mouse(last, 40))?.handled, true);
    assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(40), ["", "NATIVE read", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("compact summaries reserve one right column before wrapping at every usable width", (t) => {
  // Geometry/cache equality is independent of elapsed animation; keep the whole-row comparison strict.
  t.mock.method(performance, "now", () => 0);
  const tool = new Tool("custom", { path: "文件/🦀/é".repeat(8), drop: "1,2,3,5,8,13,21", query: "x".repeat(60) });
  const next = new Tool("read", { path: "b.txt" });
  const { controller } = setup([tool, next]);
  try {
    const args = structuredClone(tool.args);
    for (const state of ["pending", "partial", "success", "error"]) {
      tool.isPartial = state === "partial";
      tool.result = state === "pending" ? undefined : {
        isError: state === "error", content: [{ type: "text", text: state === "error" ? "Failure 文件" : "RAW_RESULT" }],
      };
      const glyph = state === "pending" || state === "partial" ? "⠋" : "⚙";
      const result = structuredClone(tool.result);
      for (let width = 0; width <= 90; width++) {
        const rows = tool.render(width).map(plain);
        if (!width) { assert.deepEqual(rows, []); continue; }
        assert.ok(rows.every((row) => visibleWidth(row) <= Math.max(1, width - 1)), `right margin: ${state}, width ${width}`);
        assert.doesNotMatch(rows.join(""), /…|✓|✗/u);
        if (width <= 5) assert.deepEqual(rows, [(width >= 3 ? " " : "") + glyph], "tiny viewports preserve pending state or tool glyph and the margins that fit");
        else {
          assert.equal(rows[0]!.slice(0, 3), ` ${glyph} `);
          assert.ok(rows.slice(1).every((row) => /^ {3}\S/u.test(row)));
          const expected = `custom ${describeArgs(tool.toolName, tool.args)}`;
          assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""), expected.replace(/ /g, ""));
        }
        assert.deepEqual(tool.render(width).map(plain), rows, "cached layout retains right margin");
      }
      assert.deepEqual(tool.args, args);
      assert.deepEqual(tool.result, result);
    }
    tool.isPartial = false; tool.result = { content: [] };
    assert.equal(next.render(30)[0], "", "a narrowed multiline predecessor still owns one following separator");
    assert.equal(next.render(1000).length, 1, "resize back removes the adaptive separator");
  } finally { controller.restore(); }
});

test("zero-width compact rendering cannot retain an adaptive separator", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { controller } = setup([first, second]);
  try {
    assert.deepEqual(first.render(0), []);
    assert.deepEqual(second.render(0), []);
  } finally { controller.restore(); }
});

// Bash cards are a separate presentation, not a specialization of describeArgs.
function bashBody(tool: Tool, width = 80): string[] {
  const rows = tool.render(width).map(plain);
  if (rows[0] === "") rows.shift(); // transcript separator, not card padding
  const origin = width >= 6 ? 3 : [0, 0, 1, 2, 2, 2][width];
  const right = width >= 6 ? 2 : [0, 0, 0, 0, 1, 2][width];
  return rows.slice(1, -1).map((row) => row.slice(origin, right ? -right : undefined).trimEnd());
}
function bashTool(command = "echo hello") {
  const tool = new Tool("bash", { command });
  tool.result = { content: [] };
  return tool;
}

test("bash cards retain whole commands with no continuation alignment", () => {
  const tool = bashTool("python3 - <<'PY'\n  print('hello')\nPY");
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ python3 - <<'PY'", "  print('hello')", "PY"]);
    tool.args.command = "abcdefghijabcdefghij";
    assert.deepEqual(bashBody(tool, 12), ["$ abcde", "fghijab", "cdefghi", "j"]);
    tool.args.command = "a  b\n\n c";
    assert.deepEqual(bashBody(tool), ["$ a  b", "", " c"]);
    tool.args.command = source.command;
    assert.deepEqual(tool.args, source);
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("bash comments are optional, normalized and separated once from the command", () => {
  const tool = bashTool("pwd");
  tool.args.description = "Check\n\tdirectory"; tool.args.workdir = "sub/../elsewhere";
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/elsewhere", "", "$ pwd"]);
    assert.deepEqual(tool.args, source);
    for (const workdir of [".", "/project", "sub/..", ""]) {
      tool.args.workdir = workdir;
      assert.deepEqual(bashBody(tool), ["# Check directory", "", "$ pwd"]);
    }
    delete tool.args.description; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
    tool.args.description = " \n ";
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
  } finally { controller.restore(); }
});

test("bash output trims only blank edges and preserves literal service-looking text", () => {
  const tool = bashTool();
  const { controller } = setup([tool]);
  try {
    for (const text of ["", "\n \t\n", "\x1b[31m\n\x1b[0m"]) {
      tool.result = { content: [{ type: "text", text }] };
      assert.deepEqual(bashBody(tool), ["$ echo hello"]);
    }
    tool.result = { content: [{ type: "text", text: "\n  \nalpha\n\n  beta  \n \n" }] };
    const before = structuredClone(tool.result);
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "alpha", "", "  beta"]);
    assert.deepEqual(tool.result, before);
    tool.result = { content: [{ type: "text", text: "(no output)\nBackground task started: xyz\n[exit code: 7]" }], details: { exit_code: 0, task_id: "xyz" } };
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "(no output)", "Background task started: xyz", "[exit code: 7]"]);
  } finally { controller.restore(); }
});

test("bash preview is the first ten visual rows and expands only available text", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    tool.result = { content: [{ type: "text", text: "X".repeat(190) }] };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19))]);
    tool.result = { content: [{ type: "text", text: "X".repeat(191) }], details: { truncated: true, output_path: "/DO_NOT_READ" } };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "… (Click to expand)"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "X"]);
    assert.equal(tool.result.content[0].text, "X".repeat(191));
  } finally { controller.restore(); }
});

test("bash removes only an exact separated final exit-footer duplicate without rewriting results", () => {
  const tool = bashTool("false"), footer = "[exit code: 7]";
  const { controller } = setup([tool]);
  try {
    const cases: [string, unknown, boolean, boolean, string[]][] = [
      [`BODY\n\n${footer}`, 7, false, false, ["BODY"]],
      [`BODY\n \t\n${footer}\n \n`, 7, false, false, ["BODY"]],
      [`\n${footer}`, 7, false, false, []],
      [`BODY\n\n[exit code: -2; error: execution failed]`, -2, true, false, ["BODY"]],
      [`BODY\n${footer}`, 7, false, false, ["BODY", footer]],
      [`BODY\n\n[exit code: 8]`, 7, false, false, ["BODY", "", "[exit code: 8]"]],
      [`BODY\n\n${footer} `, 7, false, false, ["BODY", "", `${footer} `]],
      [`BODY\n\n ${footer}`, 7, false, false, ["BODY", "", ` ${footer}`]],
      [`BODY\n\n${footer}\nTAIL`, 7, false, false, ["BODY", "", footer, "TAIL"]],
      [`BODY\n\n${footer}`, 7, true, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, "7", false, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, undefined, false, false, ["BODY", "", footer]],
      [`BODY\n\n[exit code: 0]`, 0, false, false, ["BODY", "", "[exit code: 0]"]],
      ["BODY\n\n[error: execution failed]", 0, true, false, ["BODY", "", "[error: execution failed]"]],
      [`BODY\n\n${footer}`, 7, false, true, ["BODY", "", footer]],
      [`BODY\n\n${footer}\n\n${footer}`, 7, false, false, ["BODY", "", footer]],
    ];
    for (const [text, exit_code, isError, partial, displayed] of cases) {
      const result = { content: [{ type: "text", text }], details: { exit_code }, isError };
      tool.updateResult(result, partial);
      const before = structuredClone(result);
      const finalFooter = partial ? "" : typeof exit_code === "number" && exit_code !== 0
        ? `[exit code: ${exit_code}${isError ? "; error: execution failed" : ""}]`
        : isError ? "[error: execution failed]" : "";
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        // This helper discards right padding; row count still detects preserved nonmatching literals.
        assert.deepEqual(bashBody(tool, 100), ["$ false", ...(displayed.length ? ["", ...displayed.map((row) => row.trimEnd())] : []), ...(finalFooter ? ["", finalFooter] : [])], text);
        assert.deepEqual(tool.result, before);
      }
    }
    const result = { content: [{ type: "text", text: "BODY\r\n" }, { type: "text", text: `\u001b[31m${footer}\u001b[0m\r\n` }], details: { exit_code: 7 } };
    const before = structuredClone(result);
    tool.updateResult(result); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ false", "", "BODY", "", footer]);
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test("bash timeout replaces only one exact separated final pair with its own error footer", () => {
  const tool = bashTool("run"), marker = "[command timed out]", exit = "[exit code: 124]";
  const pair = `${marker}\n${exit}`, timeoutFooter = "[exit code: 124; error: command timed out]";
  const { controller } = setup([tool]);
  try {
    const cases: [string, unknown, boolean, boolean, string[], boolean][] = [
      [`BODY\n\n${pair}`, 124, false, false, ["BODY"], true],
      [`BODY\n \t\n${pair}\n \n`, 124, true, false, ["BODY"], true],
      [`\n${pair}`, 124, false, false, [], true],
      [`BODY\n\n${pair}\n\n${pair}`, 124, false, false, ["BODY", "", marker, exit], true],
      [`BODY\n${pair}`, 124, false, false, ["BODY", marker, exit], false],
      [pair, 124, false, false, [marker, exit], false],
      [`BODY\n\n${pair}\nTAIL`, 124, false, false, ["BODY", "", marker, exit, "TAIL"], false],
      [`BODY\n\n ${marker}\n${exit}`, 124, false, false, ["BODY", "", ` ${marker}`, exit], false],
      [`BODY\n\n${marker} \n${exit}`, 124, false, false, ["BODY", "", `${marker} `, exit], false],
      [`BODY\n\n${marker}\n ${exit}`, 124, false, false, ["BODY", "", marker, ` ${exit}`], false],
      [`BODY\n\n${marker}\n${exit} `, 124, false, false, ["BODY", "", marker, `${exit} `], false],
      [`BODY\n\n${marker}\n[exit code: 125]`, 124, false, false, ["BODY", "", marker, "[exit code: 125]"], false],
      [`BODY\n\n${marker}`, 124, false, false, ["BODY", "", marker], false],
      [`BODY\n\n${exit}`, 124, false, false, ["BODY"], false],
      [`BODY\n\n${marker}\n\n${exit}`, 124, false, false, ["BODY", "", marker], false],
      [`BODY\n\n${pair}\n\n${exit}`, 124, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 7, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 0, true, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, "124", false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, undefined, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, null, true, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 124, true, true, ["BODY", "", marker, exit], false],
    ];
    for (const [text, exit_code, isError, partial, displayed, timeout] of cases) {
      const result = { content: [{ type: "text", text }], details: { exit_code }, isError };
      const before = structuredClone(result);
      tool.updateResult(result, partial);
      const footer = partial ? "" : timeout ? timeoutFooter : typeof exit_code === "number" && exit_code !== 0
        ? `[exit code: ${exit_code}${isError ? "; error: execution failed" : ""}]`
        : isError ? "[error: execution failed]" : "";
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        assert.deepEqual(bashBody(tool, 100), ["$ run", ...(displayed.length ? ["", ...displayed.map((line) => line.trimEnd())] : []), ...(footer ? ["", footer] : [])],
          JSON.stringify({ text, exit_code, isError, partial, expanded }));
        assert.deepEqual(tool.result, before, "timeout recognition is presentation-only");
      }
    }
    const result = { content: [{ type: "text", text: "BODY\r\n" },
      { type: "text", text: `\x1b[31m${marker}\x1b[0m\r\n${exit}\r\n` }], details: { exit_code: 124 } };
    const before = structuredClone(result);
    tool.updateResult(result);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", "BODY", "", timeoutFooter], "match sanitized logical rows across content blocks");
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test("bash timeout filtering precedes visual cutoff and preserves partial-to-final snapshots", () => {
  const tool = bashTool("run"), footer = "[exit code: 124; error: command timed out]";
  const rows = Array.from({ length: 9 }, (_, index) => `ROW_${index}`);
  const raw = rows.join("\n") + "\n\n[command timed out]\n[exit code: 124]";
  const result = { content: [{ type: "text", text: raw }], details: { exit_code: 124 }, isError: false };
  const before = structuredClone(result), { controller } = setup([tool]);
  try {
    tool.updateResult(result, true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "… (Click to expand)"], "partial retains raw tail as hidden output, not a completion footer");
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "", "[command timed out]", "[exit code: 124]"], "expanded partial exposes both literals");
    tool.updateResult(result); tool.setExpanded(false);
    for (const width of [100, 24]) {
      const available = width - 5;
      // bashBody discards terminal right padding, including a fragment's trailing space.
      const fragments = Array.from({ length: Math.ceil(footer.length / available) }, (_, index) => footer.slice(index * available, (index + 1) * available).trimEnd());
      assert.deepEqual(bashBody(tool, width), ["$ run", "", ...rows, "", ...fragments]);
      assert.equal(tool.handleMouse(mouse(2, width)), undefined, "nine real output rows do not become expandable from synthetic status rows");
      assert.equal(tool.expanded, false);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, width), ["$ run", "", ...rows, "", ...fragments]);
      tool.setExpanded(false);
    }
    const longer = [...rows, "ROW_9", "HIDDEN_TAIL"].join("\n") + "\n\n[command timed out]\n[exit code: 124]";
    tool.updateResult({ ...result, content: [{ type: "text", text: longer }] });
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "ROW_9", "… (Click to expand)", "", footer]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "ROW_9", "HIDDEN_TAIL", "", footer]);
    assert.deepEqual(result, before, "all updates leave the original snapshot intact");
  } finally { controller.restore(); }
});

test("bash timeout footer wraps entirely in the error role without recoloring command output", () => {
  const root = new Root(), tool = bashTool("run"); root.addChild(tool);
  tool.updateResult({ content: [{ type: "text", text: "BODY\n\n[command timed out]\n[exit code: 124]" }], details: { exit_code: 124 }, isError: true });
  const fg: [string, string][] = [], bg: string[] = [];
  const controller = installTidyUi(root, () => ({
    fg: (role, text) => { fg.push([role, text]); return text; },
    bg: (role, text) => { bg.push(role); return text; },
  }));
  try {
    for (const width of [100, 24]) {
      fg.length = 0; bg.length = 0;
      const lines = tool.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(fg.filter(([role, text]) => role === "error" && text !== "┃").map(([, text]) => text).join(""),
        "[exit code: 124; error: command timed out]");
      assert.deepEqual(fg.filter(([role]) => role === "toolOutput").map(([, text]) => text), ["BODY"]);
      assert.ok(fg.some(([role, text]) => role === "error" && text === "┃"), "error stripe remains metadata-derived");
      assert.deepEqual([...new Set(bg)], ["toolPendingBg"]);
    }
  } finally { controller.restore(); }
});

test("bash removes trailing preview blanks before hint without backfilling or changing expansion", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    const reported = ["✖ real CLI: cache work (25298.723022ms)", "ℹ tests 1", "ℹ suites 0", "ℹ pass 0", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 25403.258316"];
    const original = [...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"].join("\n");
    tool.updateResult({ content: [{ type: "text", text: original }], details: { exit_code: 1 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "… (Click to expand)", "", "[exit code: 1]"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"]);
    assert.equal(tool.result?.content[0].text, original);
    for (const blank of ["", " \t", "\n\n"]) {
      const rows = Array.from({ length: 9 }, (_, i) => `ROW_${i}`);
      const text = [...rows, blank, "HIDDEN_TAIL"].join("\n");
      tool.updateResult({ content: [{ type: "text", text }] }); tool.setExpanded(false);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, "… (Click to expand)"]);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, ...blank.split("\n").map(() => ""), "HIDDEN_TAIL"]);
      assert.equal(tool.result?.content[0].text, text);
    }
    tool.updateResult({ content: [{ type: "text", text: "A\n\nB\n" + Array(8).fill("C").join("\n") }] }); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", "A", "", "B", ...Array(7).fill("C"), "… (Click to expand)"]);
    // A nonempty logical row can wrap into whitespace-only rows at the preview boundary.
    tool.updateResult({ content: [{ type: "text", text: "A".repeat(19 * 9) + " ".repeat(19 * 2) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(9).fill("A".repeat(19)), "… (Click to expand)"]);
    tool.updateResult({ content: [{ type: "text", text: " ".repeat(19 * 11) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", "… (Click to expand)"]);
    // Removing a matching suffix changes overflow/expandability before the cutoff.
    tool.updateResult({ content: [{ type: "text", text: Array(9).fill("ROW").join("\n") + "\n\n[exit code: 7]" }], details: { exit_code: 7 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...Array(9).fill("ROW"), "", "[exit code: 7]"]);
    assert.equal(tool.handleMouse(mouse(2, 100)), undefined);
    assert.equal(tool.expanded, false);
  } finally { controller.restore(); }
});

test("bash exit/error status uses persisted numeric metadata and flags, never output parsing", () => {
  const tool = bashTool("false");
  const cases: [unknown, boolean, string | undefined][] = [
    [7, false, "[exit code: 7]"], [7, true, "[exit code: 7; error: execution failed]"],
    [0, true, "[error: execution failed]"], [undefined, true, "[error: execution failed]"],
    [0, false, undefined], [undefined, false, undefined], [null, false, undefined],
    ["7", false, undefined], [NaN, false, undefined], [1.5, false, undefined], [-9, false, "[exit code: -9]"],
  ];
  const { controller } = setup([tool]);
  try {
    for (const [exit_code, isError, footer] of cases) {
      tool.result = { content: [], details: { exit_code }, isError, structuredContent: { exit_code: 123 } };
      assert.deepEqual(bashBody(tool), ["$ false", ...(footer ? ["", footer] : [])]);
    }
    tool.result = { content: [{ type: "text", text: "Command exited with code 9" }] };
    assert.deepEqual(bashBody(tool), ["$ false", "", "Command exited with code 9"]);
    tool.isPartial = true;
    tool.result = { content: [], details: { exit_code: 9 }, isError: true };
    assert.deepEqual(bashBody(tool), ["$ false"]);
  } finally { controller.restore(); }
});

test("bash streaming replaces snapshots and keeps custom presentation after Ctrl+O", () => {
  const tool = bashTool("run");
  const { controller } = setup([tool]);
  try {
    tool.updateResult(undefined, true);
    assert.deepEqual(bashBody(tool), ["$ run"]);
    tool.updateResult({ content: [{ type: "text", text: "PARTIAL" }] }, true);
    assert.deepEqual(bashBody(tool), ["$ run", "", "PARTIAL"]);
    tool.setExpanded(true);
    tool.updateResult({ content: [{ type: "text", text: "FINAL" }] });
    assert.deepEqual(bashBody(tool), ["$ run", "", "FINAL"]);
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL|NATIVE/);
    controller.restore();
    assert.match(tool.render(80).join(""), /NATIVE bash/);
  } finally { controller.restore(); }
});

test("bash whole-panel clicks toggle during streaming without capturing wheel or secondary events", () => {
  const tool = bashTool("run"); tool.args.description = "Description"; tool.args.workdir = "sub";
  tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 11 }, (_, i) => `LINE_${i}`).join("\n") }], details: { exit_code: 4 } }, true);
  const { root, controller } = setup([new Text("User", 0, 0), tool]);
  try {
    root.render(80);
    let rows = tool.render(80).map(plain);
    const output = rows.findIndex((row) => row.includes("LINE_0"));
    assert.equal(tool.handleMouse(mouse(0)), undefined);
    for (let y = 1; y < output; y++) {
      assert.ok(tool.handleMouse(mouse(y))?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, true);
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, false);
    rows = tool.render(80).map(plain);
    const hint = rows.findIndex((row) => row.includes("Click to expand"));
    assert.ok(tool.handleMouse(mouse(hint))?.handled);
    assert.equal(tool.expanded, true);
    assert.equal(tool.handleMouse({ ...mouse(output), type: "wheel", wheelDelta: -1 }), undefined);
    assert.equal(tool.handleMouse({ ...mouse(output), button: "right" }), undefined);
    tool.updateResult(tool.result);
    rows = tool.render(80).map(plain);
    const footer = rows.findIndex((row) => row.includes("exit code:"));
    assert.ok(tool.handleMouse(mouse(footer))?.handled);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse(mouse(tool.render(80).length - 1))?.handled);
    assert.equal(tool.expanded, true);
  } finally { controller.restore(); }
});

test("bash foregrounds and neutral panel follow live theme while Unicode geometry stays safe", () => {
  const root = new Root(), tool = bashTool("printf '\t界é👩‍💻'\n\tsecond"); root.addChild(tool);
  tool.args.description = "Describe"; tool.args.workdir = "sub";
  tool.result = { content: [{ type: "text", text: "\x1b]0;BAD\x07\x1b[31mOUTPUT\x1b[0m\r\n  é\u202e" }] };
  const fg: [string, string][] = [], bg: string[] = [];
  let theme = "A";
  const controller = installTidyUi(root, () => ({
    fg: (role, text) => { fg.push([role, text]); return text; },
    bg: (role: string, text: string) => { bg.push(`${theme}:${role}`); return text; },
  }));
  try {
    for (let width = 1; width <= 40; width++) {
      for (const row of tool.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${width}: ${JSON.stringify(row)}`);
        assert.doesNotMatch(row.replace(/^\x1b\[49m/u, ""), /[\x00-\x1f\x7f-\x9f\u202e]/u,
          "only the frame's trusted leading background reset is permitted");
      }
    }
    fg.length = 0; bg.length = 0; tool.render(80);
    assert.ok(fg.some(([role, text]) => role === "dim" && text === "$ "));
    assert.ok(fg.some(([role, text]) => role === "toolTitle" && text.includes("printf")));
    assert.ok(fg.some(([role, text]) => role === "muted" && text.includes("Describe")));
    assert.ok(fg.some(([role, text]) => role === "toolOutput" && text === "OUTPUT"));
    assert.deepEqual([...new Set(bg)], ["A:toolPendingBg"]);
    theme = "B"; tool.isPartial = true; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    tool.isPartial = false; tool.result.details = { exit_code: 3 }; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    assert.ok(fg.some(([role, text]) => role === "error" && text.includes("exit code: 3")));
  } finally { controller.restore(); }
});

test("bash policy preserves explicit native/compact overrides and image safeguards", () => {
  for (const [options, expected] of [[{ cards: ["bash"] }, /NATIVE bash/], [{ cards: ["bash"], compact: ["bash"] }, /⚙ bash/]] as const) {
    const tool = bashTool();
    const { controller } = setup([tool], options);
    try { assert.match(tool.render(80).join(""), expected); } finally { controller.restore(); }
  }
  const image = bashTool(); image.result = { content: [{ type: "image" }] };
  const { controller, original } = setup([image]);
  try { assert.deepEqual(image.render(80), original.call(image, 80)); } finally { controller.restore(); }
});

test("bash exterior margins are not expansion targets and hidden self cards stay hidden", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("LINE").join("\n") }] };
  const { controller } = setup([tool]);
  try {
    const y = tool.render(80).map(plain).findIndex((row) => row.includes("LINE"));
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(y), x }), undefined);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse({ ...mouse(y), x: 2 })?.handled);
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
    tool.expanded = false;
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
  } finally { controller.restore(); }
  class HiddenBash extends Tool {
    getRenderShell() { return "self"; }
    render(_width: number): string[] { return []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new HiddenBash("bash", { command: "echo HIDDEN" });
  const frame = setup([hidden]);
  try { assert.deepEqual(hidden.render(80), []); assert.equal(hidden.handleMouse(mouse(0)), undefined); }
  finally { frame.controller.restore(); }
});

test("bash keeps Unicode joining sequences intact instead of deleting their joining marks", () => {
  const tool = bashTool("echo 👩‍💻");
  tool.result = { content: [{ type: "text", text: "👩‍💻 é" }] };
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ echo 👩‍💻", "", "👩‍💻 é"]);
    assert.ok(bashBody(tool, 9).some((row) => row === "👩‍💻"));
  } finally { controller.restore(); }
});

test("bash removes every Unicode bidi control, including Arabic letter marks, without changing inputs", () => {
  const tool = bashTool("printf '\u061c123'");
  tool.args.description = "Check\u061c directory"; tool.args.workdir = "sub\u061c";
  tool.result = { content: [{ type: "text", text: "\u061c" }] };
  const before = structuredClone({ args: tool.args, result: tool.result });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(80);
    assert.ok(rows.every((row) => !/\p{Bidi_Control}/u.test(row)));
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/sub", "", "$ printf '123'"]);
    assert.deepEqual({ args: tool.args, result: tool.result }, before);
    tool.args.description = "\u061c"; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ printf '123'"]);
  } finally { controller.restore(); }
});


test("OpenCode-style bash shell has external margins and a shared content origin", () => {
  const tool = bashTool("echo ok"); tool.result = { content: [{ type: "text", text: "ok" }] };
  const { controller } = setup([tool]);
  try {
    const row = (content: string) => " ┃ " + content.padEnd(75) + "  ";
    assert.deepEqual(tool.render(80).map(plain), [row(""), row("$ echo ok"), row(""), row("ok"), row("")]);
    for (let width = 0; width <= 80; width++) {
      const rows = tool.render(width);
      if (!width) assert.deepEqual(rows, []);
      else for (const line of rows) assert.equal(visibleWidth(line), width);
    }
  } finally { controller.restore(); }
});

test("the whole expandable panel is clickable but margins, selection and drags are not", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const { root, controller } = setup([new Text("Before", 0, 0), tool]);
  try {
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(1), x }), undefined);
    for (const point of [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 78, y: tool.render(80).length - 1 }]) {
      assert.ok(tool.handleMouse({ ...mouse(point.y), x: point.x })?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    root.selection = true;
    assert.equal(tool.handleMouse(mouse(2)), undefined);
    root.selection = false;
    for (const type of ["press", "release", "drag", "wheel"] as const) assert.equal(tool.handleMouse({ ...mouse(2), type }), undefined);
    assert.equal(tool.expanded, false);
    assert.equal(tool.handleMouse({ ...mouse(2), button: "right" }), undefined);
    assert.equal(tool.handleMouse(mouse(0)), undefined, "transcript separator");
  } finally { controller.restore(); }
});


test("shared frame accepts unrelated bodies and paint without host/tool state", () => {
  const g = cardGeometry(12);
  assert.deepEqual([g.marginLeft, g.marginRight, g.borderWidth, g.paddingLeft, g.paddingRight, g.contentX, g.contentWidth], [1, 1, 1, 1, 1, 3, 7]);
  const painted: string[] = [];
  const rows = frameRows(g, ["hello", "user"], { panel: (text) => { painted.push(text); return text; }, border: (text) => text });
  assert.deepEqual(rows.map(plain), [" ┃          ", " ┃ hello    ", " ┃ user     ", " ┃          "]);
  assert.deepEqual(painted, ["         ", " hello   ", " user    ", "         "], "panel painter never receives the stripe");
  assert.throws(() => frameRows(g, ["overflow"], { panel: (text) => text, border: (text) => text }), RangeError);
  assert.deepEqual(frameRows(cardGeometry(0), [], { panel: (text) => text, border: (text) => text }), []);
  assert.ok(insidePanel(g, 4, 1, 0)); assert.ok(insidePanel(g, 4, 10, 3));
  for (const point of [[0, 0], [11, 0], [1, -1], [1, 4]]) assert.equal(insidePanel(g, 4, point[0], point[1]), false);
  const origins = [0, 0, 1, 2, 2, 2, 3, 3];
  for (let width = 1; width < 8; width++) {
    const narrow = cardGeometry(width);
    assert.equal(narrow.contentX, origins[width]); assert.equal(narrow.contentWidth, Math.max(1, width - 5));
    assert.ok(frameRows(narrow, ["x"], { panel: (text) => text, border: (text) => text }).every((row) => visibleWidth(row) === width));
  }
});

test("failed stripe and footer share error foreground, never a background-token color", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  const foregrounds: [string, string][] = [], backgrounds: string[] = [];
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => { foregrounds.push([role, text]); return text; },
    bg: (role, text) => { backgrounds.push(role); return text; },
    style: () => { throw new Error("Stripe must use the same semantic foreground as the footer"); },
  };
  const controller = installTidyUi(root, () => theme);
  try {
    for (const result of [
      { content: [], details: { exit_code: 7 }, isError: false },
      { content: [], details: { exit_code: 0 }, isError: true },
      { content: [], isError: true },
    ]) {
      foregrounds.length = 0; backgrounds.length = 0; tool.result = result; tool.isPartial = false;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text === "┃"));
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text.startsWith("[")));
      assert.deepEqual([...new Set(backgrounds)], ["toolPendingBg"]);
    }
    for (const partial of [false, true]) {
      foregrounds.length = 0;
      tool.result = { content: [], details: { exit_code: partial ? 7 : 0 }, isError: partial }; tool.isPartial = partial;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "borderMuted" && text === "┃"));
      assert.ok(!foregrounds.some(([role]) => role === "error"));
    }
  } finally { controller.restore(); }
});

test("card motion and focus keep neutral paint without replacing native input or requesting render", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const native = root.handleViewportInput, descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
  const listeners = [...root.listeners], symbols = Object.getOwnPropertySymbols(root);
  const styles: Parameters<NonNullable<CardTheme["style"]>>[1][] = [];
  const backgrounds: string[] = [];
  const theme: CardTheme = { colors: { toolPendingBg: parseColor("#202020"), text: parseColor("#eeeeee") },
    fg: (_role, text) => text, bg: (role, text) => { backgrounds.push(role); return text; },
    style: (text, options) => { styles.push(options); return text; } };
  let paletteReads = 0;
  const controller = installTidyUi(root, () => { paletteReads++; return theme; });
  try {
    assert.equal(controller.active, true);
    assert.equal(root.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
    assert.deepEqual([...root.listeners], listeners); assert.deepEqual(Object.getOwnPropertySymbols(root), symbols);
    const expected = tool.render(80), requests = root.requests;
    for (const data of ["\x1b[<35;6;3M", "\x1b[<35;1;1M", "\x1b[O", "\x1b[I"]) assert.deepEqual(root.input(data), [undefined]);
    for (const type of ["move", "press", "release", "drag", "wheel"] as const) {
      const before = paletteReads;
      assert.equal(tool.handleMouse({ ...mouse(2), type, button: type === "move" ? "none" : "left" }), undefined);
      assert.equal(paletteReads, before, "ignored mouse events do not render the card body");
      assert.deepEqual(tool.render(80), expected);
    }
    assert.equal(root.requests, requests, "pointer events do not request pi-tidy-ui redraws");
    assert.equal(tool.expanded, false); assert.deepEqual(styles, []);
    assert.deepEqual([...new Set(backgrounds)], ["toolPendingBg"]);
    controller.restore();
    assert.equal(root.handleViewportInput, native); assert.deepEqual([...root.listeners], listeners);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
  } finally { controller.restore(); }
});

test("absent, immutable and throwing private input methods are not a pi-tidy-ui dependency", () => {
  for (const shape of ["missing", "immutable", "throwing"]) {
    const root = new Root(), tool = bashTool(); root.addChild(tool);
    const warnings: string[] = []; let reads = 0;
    if (shape === "missing") Object.defineProperty(root, "handleViewportInput", { value: undefined, configurable: true });
    else if (shape === "immutable") Object.defineProperty(root, "handleViewportInput", { value: Root.prototype.handleViewportInput, configurable: false, writable: false });
    else Object.defineProperty(root, "handleViewportInput", { get() { reads++; throw new Error("Private input must not be read"); }, configurable: false });
    const descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
    const controller = installTidyUi(root, () => color, { warn: (text) => warnings.push(text) });
    try {
      assert.equal(controller.active, true); assert.deepEqual(warnings, []);
      assert.ok(tool.render(80).some((row) => plain(row).startsWith(" ┃ $ ")));
      assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
      assert.equal(reads, 0);
    } finally { controller.restore(); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor); assert.equal(reads, 0);
  }
});

test("actual fullscreen keeps native input identity and consumption throughout pi-tidy-ui lifecycle", () => {
  const noop = () => {};
  const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false,
    start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop,
    showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
  const root = new TuiAltScreen(terminal, false); root.requestRender = noop;
  const input = root as unknown as { handleTerminalInput(data: string): void; handleViewportInput(data: string): unknown };
  const native = input.handleViewportInput, descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
  const tool = bashTool(); root.addChild(tool);
  let lateObservations = 0;
  const unsubscribe = root.addInputListener(() => { lateObservations++; return undefined; });
  const controller = installTidyUi(root, () => color);
  try {
    assert.equal(controller.active, true); assert.equal(input.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
    for (const data of ["\x1b[<35;1;1M", "\x1b[O", "\x1b[<64;1;1M"]) input.handleTerminalInput(data);
    assert.equal(lateObservations, 0, "native SDK still consumes mouse and focus before appended listeners");
    controller.restore(); assert.equal(input.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
  } finally { controller.restore(); unsubscribe(); }
});

test("stable TUI reference needs no receiver probe, writes or private input access", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  const symbols = Object.getOwnPropertySymbols(root), native = root.handleViewportInput;
  const reference = new Proxy({}, {
    get: (_target, property) => {
      assert.notEqual(property, "handleViewportInput", "no private input lookup");
      const value = Reflect.get(root, property, root);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, root, args) : value;
    },
    set: () => { throw new Error("No renderer writes allowed"); },
    defineProperty: () => { throw new Error("No proxy target writes allowed"); },
    getPrototypeOf: () => Reflect.getPrototypeOf(root),
  }) as Root;
  const controller = installTidyUi(reference, () => color);
  try {
    assert.equal(controller.active, true);
    assert.ok(tool.render(80).some((row) => plain(row).startsWith(" ┃ $ ")));
    assert.deepEqual(Object.getOwnPropertySymbols(root), symbols); assert.equal(root.handleViewportInput, native);
  } finally { controller.restore(); }
});


test("narrow truncated bash hints cannot reset the panel background or dim foreground", async () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const theme: CardTheme = {
    fg: (_role, text) => `\x1b[38;2;180;180;180m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
  };
  const controller = installTidyUi(root, () => theme);
  const terminal = new xterm.Terminal({ cols: 22, rows: 30, allowProposedApi: true });
  try {
    const rows = tool.render(22);
    await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
    for (let y = 0; y < rows.length; y++) {
      if (!plain(rows[y]!).includes("┃")) continue;
      for (let x = 0; x < 22; x++) {
        const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
        if (x <= 1 || x >= 21) assert.equal(cell.getBgColorMode(), 0, "exterior and stripe keep default background");
        else assert.equal(cell.getBgColor(), 0x202020, `painted panel cell (${x},${y})`);
      }
    }
    const hint = rows.findIndex((row) => plain(row).includes("… (Click"));
    assert.ok(hint >= 0);
    for (let x = 3; x < 3 + visibleWidth(plain(rows[hint]!).slice(3, -2).trimEnd()); x++) {
      assert.equal(terminal.buffer.active.getLine(hint)!.getCell(x)!.getFgColor(), 0xb4b4b4, "entire hint retains semantic foreground");
    }
  } finally { controller.restore(); terminal.dispose(); }
});


test("renderer replacement preserves cards and clicks without touching any native input method", () => {
  for (const fullscreenFirst of [true, false]) {
    const noop = () => {};
    const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false,
      start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop,
      showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
    const roots = fullscreenFirst ? [new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false)]
      : [new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false)];
    for (const root of roots) root.requestRender = noop;
    let current = roots[0]!;
    const reference = new Proxy({}, {
      get: (_target, property) => {
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, current, args) : value;
      },
      set: () => { throw new Error("No receiver capture/migration writes allowed"); },
      getPrototypeOf: () => Reflect.getPrototypeOf(current),
    }) as TuiAltScreen;
    const inputs = roots.map((root) => Reflect.get(root, "handleViewportInput"));
    const descriptors = roots.map((root) => Object.getOwnPropertyDescriptor(root, "handleViewportInput"));
    const symbols = roots.map((root) => Object.getOwnPropertySymbols(root));
    const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
    current.addChild(tool);
    const controller = installTidyUi(reference, () => color);
    try {
      const expected = tool.render(80);
      for (let index = 0; index < roots.length; index++) {
        if (index) { current.clear(); current = roots[index]!; current.addChild(tool); }
        assert.equal(controller.active, true); assert.deepEqual(tool.render(80), expected);
        assert.equal(tool.handleMouse({ ...mouse(2), type: "move", button: "none" }), undefined);
        assert.deepEqual(tool.render(80), expected);
        assert.ok(tool.handleMouse(mouse(2))?.handled); assert.equal(tool.expanded, true);
        assert.ok(tool.handleMouse(mouse(2))?.handled); assert.equal(tool.expanded, false);
        for (let other = 0; other < roots.length; other++) {
          assert.equal(Reflect.get(roots[other]!, "handleViewportInput"), inputs[other]);
          assert.deepEqual(Object.getOwnPropertyDescriptor(roots[other]!, "handleViewportInput"), descriptors[other]);
          assert.deepEqual(Object.getOwnPropertySymbols(roots[other]!), symbols[other]);
        }
      }
    } finally { controller.restore(); }
    for (let index = 0; index < roots.length; index++) assert.equal(Reflect.get(roots[index]!, "handleViewportInput"), inputs[index]);
  }
});


test("one-column padding reserves both sides without losing long command characters", () => {
  const command = `python3 -c "from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))" && node --check /tmp/neon-blocks-check.js`;
  const tool = bashTool(command); tool.args.description = "Validate game JavaScript syntax";
  const before = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    for (let width = 6; width <= 180; width++) {
      const rows = tool.render(width).map(plain);
      for (const row of rows) {
        assert.equal(visibleWidth(row), width);
        assert.equal(row[0], " "); assert.equal(row[1], "┃"); assert.equal(row[2], " ");
        assert.equal(row[width - 2], " ", "right inside padding is reserved even on full rows");
        assert.equal(row[width - 1], " ", "right exterior stays outside the panel");
      }
      const first = rows.findIndex((row) => row.slice(3, -2).startsWith("$"));
      assert.ok(first > 0);
      assert.equal(rows.slice(first, -1).map((row) => row.slice(3, -2)).join("").trimEnd(), `$ ${command}`,
        `all characters survive hard wrapping at component width ${width}`);
    }
    assert.deepEqual(tool.args, before);
  } finally { controller.restore(); }
});


test("ordinary and error stripes use terminal-default background, not panel or inherited paint", async () => {
  const root = new Root(), tool = bashTool("true"); root.addChild(tool);
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => `\x1b[38;2;${role === "error" ? "200;30;40" : "120;120;120"}m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
    style: (text) => `\x1b[38;2;80;0;0m${text}\x1b[39m`,
  };
  const controller = installTidyUi(root, () => theme);
  try {
    for (const failed of [false, true]) {
      tool.result = { content: [], isError: failed, details: { exit_code: failed ? 7 : 0 } };
      for (const width of [2, 5, 12, 22]) {
        const rows = tool.render(width);
        const terminal = new xterm.Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
        try {
          await new Promise<void>((done) => terminal.write("\x1b[48;2;99;99;99m" + rows.join("\r\n"), done));
          for (let y = 0; y < rows.length; y++) {
            const line = terminal.buffer.active.getLine(y)!;
            let stripe = -1;
            for (let x = 0; x < width; x++) if (line.getCell(x)!.getChars() === "┃") stripe = x;
            assert.ok(stripe >= 0);
            const cell = line.getCell(stripe)!;
            assert.equal(cell.getBgColorMode(), 0, `default stripe background: failed=${failed}, width=${width}, row=${y}`);
            assert.equal(cell.getFgColor(), failed ? 0xc81e28 : 0x787878, "stripe foreground follows footer error role, never toolErrorBg");
            for (let x = stripe + 1; x < width - (width >= 5 ? 1 : 0); x++) {
              assert.equal(line.getCell(x)!.getBgColor(), 0x202020, "body and internal padding retain panel background");
            }
            assert.equal(visibleWidth(rows[y]!), width);
          }
        } finally { terminal.dispose(); }
      }
    }
  } finally { controller.restore(); }
});


test("unchanged UI frames reuse custom layout; one tool update does not rebuild its neighbors", () => {
  const root = new Root();
  const tools = Array.from({ length: 8 }, (_, i) => {
    const tool = bashTool(`command_${i}`);
    tool.result = { content: [{ type: "text", text: Array.from({ length: 1000 }, (_, j) => `PERF_OUTPUT_${j}`).join("\n") }] };
    root.addChild(tool); return tool;
  });
  let segments = 0;
  const original = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = function (input) { if (input.startsWith("PERF_OUTPUT_")) segments++; return original.call(this, input); };
  const controller = installTidyUi(root, () => color);
  try {
    root.render(80);
    assert.equal(segments, 88, "only first eleven output rows are wrapped once per tool");
    assert.equal(controller.cacheStats().builds, 8);
    segments = 0; const a = root.render(80); const b = root.render(80);
    assert.deepEqual(a, b); assert.equal(segments, 0); assert.equal(controller.cacheStats().builds, 8);
    tools[3].updateResult({ content: [{ type: "text", text: "PERF_OUTPUT_NEW" }] });
    root.render(80); assert.equal(segments, 1); assert.equal(controller.cacheStats().builds, 9);
    root.render(81); assert.equal(controller.cacheStats().builds, 17);
    controller.clearCache(); assert.equal(controller.cacheStats().retainedBytes, 0);
    root.render(81); assert.equal(controller.cacheStats().builds, 25);
    root.clear(); assert.equal(controller.cacheStats().entries, 0);
    controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  } finally { controller.restore(); Intl.Segmenter.prototype.segment = original; }
});

test("reused mutable arguments and results invalidate only through native update methods", () => {
  const tool = new Tool("custom", { query: "before" });
  const root = new Root(); root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) =>
    `\x1b[${role === "error" ? 31 : 37}m${text}\x1b[39m` }));
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("before")));
    const args = tool.args; args.query = "after"; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("after")));
    const beforeError = controller.cacheStats().builds;
    tool.result!.isError = true; tool.result!.content[0].text = "new error"; tool.updateResult(tool.result);
    const errorRows = root.render(80);
    assert.ok(errorRows.some((row) => row.includes("\x1b[31m")), "mutating result in place invalidates the previous success colors");
    assert.doesNotMatch(errorRows.map(plain).join(""), /new error|✓|✗/u);
    assert.equal(controller.cacheStats().builds, beforeError + 1);
    const builds = controller.cacheStats().builds;
    tool.invalidate(); root.render(80); assert.equal(controller.cacheStats().builds, builds + 1);
  } finally { controller.restore(); }
});


test("render cache accounts weak component-owned entries and releases values explicitly", () => {
  const cache = new RenderCache();
  const a = cache.put({ rows: ["a"] }, ["a"]), b = cache.put({ rows: ["b"] }, ["b"]);
  assert.equal(cache.stats().entries, 2); cache.get(a);
  const c = cache.put({ rows: ["c"] }, ["c"]);
  assert.ok(b.value); assert.ok(a.value); assert.ok(c.value);
  assert.equal(cache.stats().entries, 3);
  assert.deepEqual(Object.keys(a).sort(), ["bytes", "value"], "entries contain no owner, raw source or closure fields");
  cache.drop(b); assert.equal(b.value, undefined); assert.equal(cache.stats().entries, 2);
  cache.clear(); assert.equal(a.value, undefined); assert.equal(c.value, undefined);
  assert.equal(cache.stats().retainedBytes, 0); assert.equal(cache.stats().entries, 0);
  const rows = ["x".repeat(1000)], big = cache.put({ rows }, rows);
  assert.equal(cache.get(big)?.rows, rows); assert.equal(cache.stats().entries, 1);
  cache.clear(); assert.equal(big.value, undefined);
});

test("cache lifecycle restores inherited/owned invalidation methods and respects later owners", () => {
  const names = ["updateArgs", "updateResult", "setExpanded", "invalidate"];
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(Tool.prototype, name));
  const tool = new Tool(), { root, controller } = setup([tool]);
  try {
    root.render(80); assert.ok(controller.cacheStats().entries > 0);
    const replacement = function () {};
    Object.defineProperty(Tool.prototype, "updateArgs", { configurable: true, writable: true, value: replacement });
    controller.restore();
    assert.equal(controller.cacheStats().entries, 0); assert.equal(Tool.prototype.updateArgs, replacement);
    for (let i = 1; i < names.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(Tool.prototype, names[i]), originals[i]);
  } finally {
    controller.restore();
    names.forEach((name, i) => { if (originals[i]) Object.defineProperty(Tool.prototype, name, originals[i]!); else Reflect.deleteProperty(Tool.prototype, name); });
  }
});

test("new theme and expansion/structure changes do not leave stale cache geometry or separators", () => {
  const a = new Tool("custom", { query: "x".repeat(80) }), b = new Tool();
  const root = new Root(); root.addChild(a); root.addChild(b);
  let theme = { fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[39m` };
  const controller = installTidyUi(root, () => theme);
  try {
    root.render(80); const built = controller.cacheStats().builds;
    theme = { fg: (_role: string, text: string) => `\x1b[32m${text}\x1b[39m` };
    const changed = root.render(80); assert.ok(changed.some((row) => row.includes("\x1b[32m"))); assert.equal(controller.cacheStats().builds, built + 2);
    root.removeChild(a); assert.notEqual(b.render(80)[0], "", "lazy sibling position repair handles removal");
    a.setExpanded(true); root.addChild(a); assert.ok(root.render(80).some((row) => row.includes("NATIVE")));
  } finally { controller.restore(); }
});


test("optional layout diagnostics distinguish retained estimates from whole-process heap and reject retired controls", async () => {
  const h = extensionHarness("tui", { "tidy-ui-cache-mb": "0.01" });
  const command = h.commands.get("tidy-ui")!.handler;
  let cacheText = '';
  const readCache = async () => { cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache']); };
  const stats = () => cacheMenuStats(cacheText);
  try {
    await h.events.get("session_start")!({}, h.ctx); h.root.render(80);
    assert.ok(h.notices.some(text => /tidy-ui-cache-mb is ignored/u.test(text)));
    await readCache();
    const first = stats(); assert.ok(first.entries > 0); assert.ok(first.processHeapUsedBytes > 0);
    assert.equal(first.retainedBytes, first.stringBytes + first.overheadBytes);
    assert.equal(first.presentationRetainedBytes, first.retainedBytes + first.footerLayout.retainedBytes);
    assert.match(cacheText, /Tidy UI display layouts only/u);
    assert.match(cacheText, /Whole Pi process heap:.*not Tidy UI memory/u);
    assert.doesNotMatch(cacheText, /limitBytes/u);
    for (const invalid of ["cache limit 0", "cache limit -1", "cache cards limit 0", "cache wrong", "cache limit 1 extra"] ) {
      await command(invalid, h.ctx); assert.match(h.notices.at(-1)!, /limits have been removed|Usage:/);
    }
    await readCache(); assert.equal(stats().retainedBytes, first.retainedBytes);
    cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache', 'Clear saved layouts']); assert.equal(stats().entries, 0); assert.equal(stats().retainedBytes, 0);
    h.root.render(80); await setAppearance(command, h.ctx, false); await setAppearance(command, h.ctx, true); h.root.render(80);
    await readCache(); assert.equal(stats().entries, first.entries);
    assert.equal(h.notices.filter(text => /tidy-ui-cache-mb is ignored/u.test(text)).length, 1, "legacy warning is runtime-local, not repeated on every frame/on");
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
});


test("actual SDK viewport caches work and permits detached tool collection with active adapter", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/cache-probe.ts"], { encoding: "utf8", timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr);
  const records = JSON.parse(probe.stdout);
  assert.equal(records[0].segments, 88); assert.equal(records[1].segments, 0);
  assert.ok(records.some((record: { detachedToolCollected?: boolean }) => record.detachedToolCollected === true));
  assert.ok(records.some((record: { animatedFirstInstallerCollected?: boolean; spinnerCacheBuildsUnchanged?: boolean }) =>
    record.animatedFirstInstallerCollected === true && record.spinnerCacheBuildsUnchanged === true));
  mkdirSync(".test-artifacts/render-cache-proof", { recursive: true });
  writeFileSync(".test-artifacts/render-cache-proof/sdk.json", JSON.stringify(records, null, 2));
});


test("actual SDK last spinner participant is collected with its live callback and leaves no fallback", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/spinner-gc-probe.ts"], { encoding: "utf8", timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr);
  const record = JSON.parse(probe.stdout);
  assert.deepEqual(record, { lastParticipantCollected: true, callbackRetainedDuringGc: true,
    starts: 1, active: 0, requestsAddedAfterGc: 0, entries: 0, retainedBytes: 0 });
  mkdirSync(".test-artifacts/spinner-render", { recursive: true });
  writeFileSync(".test-artifacts/spinner-render/last-participant-gc.json", JSON.stringify(record, null, 2));
});

test("forced compact Bash invalidates all displayed parameters on reused mutable argument updates", () => {
  const args = { command: "echo ok", timeout: 1 }, tool = new Tool("bash", args);
  const { root, controller } = setup([tool], { compact: ["bash"] });
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=1")));
    args.timeout = 2; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=2")));
    assert.equal(controller.cacheStats().builds, 2);
  } finally { controller.restore(); }
});

// Actual SDK user-message controls: native Markdown/transformers and terminal zones stay authoritative.
const zoneStart = "\x1b]133;A\x07", zoneEnd = "\x1b]133;B\x07\x1b]133;C\x07";
test("user messages reuse Bash frame geometry, their own palette and native Markdown", () => {
  initTheme("dark", false);
  const source = "USER_CARD_PLAIN\n\n**bold** and `code` and [link](https://example.org)\n\n7. seven\n8. eight\n\n> quote\n\n```ts\nconst value = 7;\n```\n\n\\*literal\\* 文字 emoji 👩‍💻";
  const user = new UserMessageComponent(source), root = new Root(); root.addChild(user);
  const originalRender = UserMessageComponent.prototype.render;
  const expected = new Map<number, string[]>();
  for (const width of [24, 40, 80]) {
    const contentWidth = cardGeometry(width).contentWidth;
    expected.set(width, originalRender.call(user, contentWidth + 2).slice(1, -1)
      .map((row) => stripVTControlCharacters(sliceByColumn(row, 1, visibleWidth(row) - 2))));
  }
  const calls: string[] = [];
  const palette: CardTheme = {
    fg(role, text) { calls.push(`fg:${role}`); return nativeTheme.fg(role, text); },
    bg(role, text) { calls.push(`bg:${role}`); return nativeTheme.bg(role, text); },
  };
  const controller = installTidyUi(root, () => palette);
  try {
    for (const width of [24, 40, 80]) {
      const rows = user.render(width), geometry = cardGeometry(width);
      assert.ok(rows[0]!.startsWith(zoneStart), "preserve OSC 133 prompt-start zone");
      assert.ok(rows.at(-1)!.startsWith(zoneEnd), "preserve OSC 133 prompt-end/final zones");
      assert.deepEqual(rows.slice(1, -1).map((row) => stripVTControlCharacters(
        sliceByColumn(row, geometry.contentX, geometry.contentWidth))), expected.get(width));
      for (const row of rows) {
        assert.equal(visibleWidth(row), width);
        assert.ok(stripVTControlCharacters(row).startsWith(" ┃ "));
        assert.ok(stripVTControlCharacters(row).endsWith("  "));
        assert.ok(row.includes(nativeTheme.fg("customMessageLabel", "┃")));
      }
    }
    assert.ok(calls.includes("fg:customMessageLabel")); assert.ok(calls.includes("bg:userMessageBg"));
    assert.ok(!calls.some((role) => /toolPendingBg|borderMuted|accent/.test(role)));
    assert.equal((user as unknown as { text: string }).text, source);
    assert.equal(user.handleMouse, Container.prototype.handleMouse, "user cards own no click handler");
  } finally { controller.restore(); }
  assert.equal(UserMessageComponent.prototype.render, originalRender);
});

test("user-card cache performs no native Markdown work on unchanged frames and covers rebuild/invalidate", () => {
  initTheme("dark", false);
  const widths: number[] = [];
  const transform = (text: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => {
    assert.equal(context.messageType, "user"); assert.equal(context.isStreaming, false);
    widths.push(context.availableWidth); return text + "\n\nTRANSFORMED_USER";
  };
  const user = new UserMessageComponent("USER_CACHE", undefined, 1, [transform]);
  const root = new Root(); root.addChild(user);
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    user.render(80); const cold = controller.cacheStats(), work = widths.length;
    assert.equal(cold.builds, 1); assert.equal(cold.entries, 1); assert.deepEqual(widths, [75]);
    for (let i = 0; i < 5; i++) user.render(80);
    assert.equal(widths.length, work); assert.equal(controller.cacheStats().builds, 1);
    user.setOutputPad(3); user.render(80);
    assert.equal(controller.cacheStats().builds, 2); assert.equal(widths.at(-1), 75);
    user.invalidate(); user.render(80); assert.equal(controller.cacheStats().builds, 3);
    user.render(24); assert.equal(controller.cacheStats().builds, 4); assert.equal(widths.at(-1), 19);
    assert.equal(controller.cacheStats().entries, 1, "only the latest width is retained");
    controller.clearCache(); user.render(24); assert.equal(controller.cacheStats().builds, 5);
    assert.equal(controller.cacheStats().entries, 1);
    root.removeChild(user); assert.equal(controller.cacheStats().entries, 0);
    root.addChild(user); user.render(24); user.render(24);
    assert.equal(controller.cacheStats().builds, 6); assert.equal(controller.cacheStats().entries, 1);
  } finally { controller.restore(); }
});

test("user cards cover tiny widths, empty messages, new subtrees and visible predecessor separation", () => {
  initTheme("dark", false);
  const root = new Root(), empty = new UserMessageComponent(" \n "), first = new UserMessageComponent("ABCDEFGHI");
  root.addChild(empty); root.addChild(first);
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    assert.deepEqual(empty.render(80), []); assert.deepEqual(first.render(0), []);
    for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 24, 80]) {
      const rows = first.render(width), geometry = cardGeometry(width);
      assert.ok(rows[0]!.startsWith(zoneStart));
      assert.equal(rows.length, Math.ceil(9 / geometry.contentWidth) + 2);
      for (const row of rows) assert.equal(visibleWidth(row), width);
      assert.equal(rows.slice(1, -1).map((row) => stripVTControlCharacters(
        sliceByColumn(row, geometry.contentX, geometry.contentWidth)).trimEnd()).join(""), "ABCDEFGHI");
    }
    const branch = new Container(), second = new UserMessageComponent("SECOND_USER"); branch.addChild(second); root.addChild(branch);
    assert.ok(second.render(80)[0]!.startsWith(zoneStart), "first in its own container has no separator");
    const third = new UserMessageComponent("THIRD_USER"); root.addChild(third);
    assert.equal(third.render(80)[0], "", "one outside separator after a visible previous sibling");
    assert.deepEqual(third.render(0), [], "zero width has no separator");
    const padded = new Container(), spacer = new Spacer(1), fourth = new UserMessageComponent("FOURTH_USER");
    padded.addChild(spacer); padded.addChild(fourth); root.addChild(padded);
    assert.ok(fourth.render(80)[0]!.startsWith(zoneStart), "reuse an existing native blank separator instead of adding another");
  } finally { controller.restore(); }
});

test("user-card hooks restore native methods without changing input/selection or overwriting later owners", () => {
  initTheme("dark", false);
  const root = new Root(), user = new UserMessageComponent("USER_RESTORE"); root.addChild(user);
  const prototype = UserMessageComponent.prototype, render = prototype.render,
    rebuild = (prototype as unknown as { rebuild(): void }).rebuild,
    invalidate = prototype.invalidate, setOutputPad = prototype.setOutputPad;
  const native = user.render(80), input = root.handleViewportInput, listeners = root.listeners.size;
  let controller = installTidyUi(root, () => nativeTheme);
  assert.notDeepEqual(user.render(80), native);
  assert.equal(root.handleViewportInput, input); assert.equal(root.listeners.size, listeners);
  controller.restore();
  assert.equal(prototype.render, render); assert.equal((prototype as unknown as { rebuild(): void }).rebuild, rebuild);
  assert.equal(prototype.invalidate, invalidate); assert.equal(prototype.setOutputPad, setOutputPad);
  assert.deepEqual(user.render(80), native);
  controller = installTidyUi(root, () => nativeTheme);
  const later = () => ["LATER_USER_RENDERER"];
  try { prototype.render = later; controller.restore(); assert.equal(prototype.render, later); }
  finally { prototype.render = render; controller.restore(); }
});

test("user cards delegate terminal images and impossible narrow native glyph rows without clipping", () => {
  initTheme("dark", false);
  const media = [zoneStart + "       ", "\x1b_Gi=1;IMAGE_PAYLOAD\x1b\\", zoneEnd + "       "];
  const widths: number[] = [];
  const rendered = renderUserCard(24, 1, nativeTheme, (width) => { widths.push(width); return media; });
  assert.deepEqual(widths, [21, 24]); assert.equal(rendered.rows, media, "native protocol rows stay byte-identical");
  const native = new UserMessageComponent("文字"), root = new Root(); root.addChild(native);
  const original = native.render(6), controller = installTidyUi(root, () => nativeTheme);
  try {
    assert.deepEqual(native.render(6), original, "delegate when W-5 cannot fit a native wide grapheme");
    assert.equal(controller.active, true, "native delegation does not disable other pi-tidy-ui presentations");
  } finally { controller.restore(); }
});

test("changed user-component contracts restore all owned hooks and retain exact native rendering", () => {
  initTheme("dark", false);
  const user = new UserMessageComponent("USER_CONTRACT"), tool = new Tool(), root = new Root();
  root.addChild(user); root.addChild(tool);
  const userRender = UserMessageComponent.prototype.render, toolRender = Tool.prototype.render, warnings: string[] = [];
  const controller = installTidyUi(root, () => nativeTheme, { warn: (reason) => warnings.push(reason) });
  try {
    user.children.push(new Text("ADDITIONAL_NATIVE_CHILD", 0, 0));
    assert.deepEqual(user.render(80), userRender.call(user, 80));
    assert.equal(controller.active, false); assert.equal(warnings.length, 1);
    assert.equal(UserMessageComponent.prototype.render, userRender); assert.equal(Tool.prototype.render, toolRender);
    assert.equal(controller.cacheStats().entries, 0);
  } finally { controller.restore(); }
});

// Edit presentation consumes persisted metadata, never proposal arguments or current file bytes.
const editDiff = " 1 const first = 1;\n-2 const before = 2;\n+2 const after = 3;\n+3 const inserted = 4;\n 3 const tail = 5;";
test("edit cards reproduce OpenCode numbered unified/split diff and cache warm frames", () => {
  const edit = new Tool("edit", { path: "src/example.ts", oldText: "PROPOSAL_OLD", newText: "PROPOSAL_NEW" });
  edit.result = { content: [{ type: "text", text: "RESULT_BODY" }], details: { diff: editDiff } };
  const snapshot = structuredClone({ args: edit.args, result: edit.result });
  const { root, controller, original } = setup([edit, new Tool()]);
  try {
    const rows = edit.render(120).map(plain);
    assert.ok(rows.some((row) => row.includes("← Edited src/example.ts")));
    assert.ok(rows.some((row) => /2 - const before = 2;/.test(row)));
    assert.ok(rows.some((row) => /2 \+ const after = 3;/.test(row)));
    assert.ok(rows.some((row) => /4   const tail = 5;/.test(row)), "context uses the new-file number after an insertion");
    assert.doesNotMatch(rows.join(""), /PROPOSAL_|RESULT_BODY/);
    const builds = controller.cacheStats().builds;
    assert.deepEqual(edit.render(120).map(plain), rows);
    assert.equal(controller.cacheStats().builds, builds);
    const split = edit.render(121).map(plain);
    assert.ok(split.some((row) => row.includes("const before = 2;") && row.includes("const after = 3;")), "replacement sides align on one row above 120 columns");
    assert.ok(split.some((row) => /3   const tail = 5;.*4   const tail = 5;/.test(row)), "split keeps old and new context numbers");
    assert.equal(root.render(121).filter((row) => row === "").length, 1, "one separator after a diff card");
    for (let width = 0; width < 30; width++) assert.ok(edit.render(width).every((row) => visibleWidth(row) <= width));
    assert.deepEqual({ args: edit.args, result: edit.result }, snapshot);
    edit.setExpanded(true); assert.deepEqual(edit.render(80), original.call(edit, 80));
  } finally { controller.restore(); }
});

test("one-sided edits use full-width unified rows for numbered and unified metadata", () => {
  const before = 'const marker = "+ -";\nconst tail = 2;\n';
  const inserted = 'const added = "' + 'wide_source '.repeat(7) + '";\n';
  const after = before.replace('const tail', inserted + 'const tail');
  for (const [oldSource, newSource, sign] of [[before, after, "+"], [after, before, "-"]] as const) {
    const diff = generateDiffString(oldSource, newSource).diff;
    const patch = generateUnifiedPatch("one-sided.ts", oldSource, newSource);
    for (const details of [{ diff }, { patch }, { diff: patch }]) for (const width of [120, 121, 140, 141, 200]) {
      const snapshot = structuredClone(details);
      const rows = renderFileCard({ args: { path: "one-sided.ts" }, isPartial: false, result: { details } }, undefined, width, color)!.rows.map(plain);
      assert.equal(rows.join("\n").split('const marker = "+ -";').length - 1, 1, "context is shown once, not in two panes; code punctuation is not a diff sign");
      const source = rows.find(row => row.includes("const added"))!;
      assert.ok(source); assert.ok(source.includes(`2 ${sign} const added`));
      assert.ok(source.indexOf("const added") < width / 2, "both insertions and deletions start in the unified gutter");
      if (width > 120) assert.ok(source.includes(inserted.trim()), "code uses the full width, not a half-pane wrap");
      assert.ok(rows.every(row => visibleWidth(row) <= width));
      assert.deepEqual(details, snapshot);
    }
  }
});

test("one-sided mode is selected globally across hunks and invalidated on metadata updates", () => {
  const tool = new Tool("edit", { path: "one-sided.ts" });
  const onlyAdds = "@@ -1,1 +1,2 @@\n const anchor = 1;\n+const a = 2;\n@@ -10,1 +11,2 @@\n const other = 10;\n+const b = 11;\n";
  const mixed = "@@ -1,1 +1,0 @@\n-const removed = 1;\n@@ -8,0 +8,1 @@\n+const inserted = 8;\n";
  tool.result = { content: [], details: { patch: onlyAdds } };
  const { controller } = setup([tool]);
  try {
    for (const patch of [onlyAdds, mixed, onlyAdds]) {
      tool.updateResult({ content: [], details: { patch } });
      const rows = tool.render(140), inserted = rows.map(plain).find(row => row.includes(patch === mixed ? "const inserted" : "const b"))!;
      assert.equal(inserted.indexOf("const ") > 70, patch === mixed, "different-hunk deletion/insertion is still a mixed split card");
      const builds = controller.cacheStats().builds;
      assert.deepEqual(tool.render(140), rows); assert.equal(controller.cacheStats().builds, builds);
      assert.equal(controller.cacheStats().cards.entries, 1, "latest card only; same retention pool in both modes");
    }
    const noChanges = renderFileCard({ args: tool.args, isPartial: false, result: { details: { diff: ' 1 const unchanged = 1;' } } }, undefined, 140, color)!.rows.map(plain);
    assert.ok(noChanges.some(row => row.includes("← Edited one-sided.ts")));
    assert.doesNotMatch(noChanges.join("\n"), /const unchanged/, "context-only metadata preserves the existing title-only frame projection");
  } finally { controller.restore(); }
});

test("successful edit framed and metadata-free headings share the Bash description origin without extra inset", () => {
  const bash = new Tool("bash", { command: "true", description: "Heading" });
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { controller } = setup([bash, edit]);
  try {
    for (const width of [24, 80, 120, 141]) {
      const bashHeading = bash.render(width).map(plain).find((row) => row.includes("# Heading"))!;
      const editHeading = edit.render(width).map(plain).find((row) => row.includes("← Edited"))!;
      assert.equal(editHeading.indexOf("←"), bashHeading.indexOf("#"), "framed edit title starts at the same content column as Bash comments");
      edit.updateResult({ content: [] });
      assert.equal(edit.render(width).map(plain).find((row) => row.includes("←"))!.indexOf("←"), bashHeading.indexOf("#"), "successful metadata-free heading remains aligned without a stripe");
      edit.updateResult({ content: [], details: { diff: editDiff } });
    }
  } finally { controller.restore(); }
});

test("edit context keeps three available lines around changes and hides only edge omission markers", () => {
  const before = Array.from({ length: 30 }, (_, index) => `source_${index + 1}`).join("\n") + "\n";
  const after = before.replace("source_10\n", "changed_10\ninserted_11\n").replace("source_22\n", "changed_22\n");
  const details = { diff: generateDiffString(before, after).diff, patch: generateUnifiedPatch("example.txt", before, after) };
  const snapshot = structuredClone(details);
  for (const metadata of [{ diff: details.diff }, { patch: details.patch }]) for (const width of [100, 140]) {
    const rows = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details: metadata } }, undefined, width, color)!.rows.map(plain);
    const source = rows.filter((row) => /source_|changed_|inserted_|…/.test(row));
    for (const line of [7, 8, 9, 11, 12, 13, 19, 20, 21, 23, 24, 25]) assert.ok(source.some((row) => new RegExp(`source_${line}(?!\\d)`).test(row)), `nearby context line ${line} is retained`);
    for (const line of [6, 14, 18, 26]) assert.ok(!source.some((row) => new RegExp(`source_${line}(?!\\d)`).test(row)), `fourth context line ${line} is omitted`);
    for (const change of ["source_10", "changed_10", "inserted_11", "source_22", "changed_22"]) assert.ok(source.some((row) => row.includes(change)), "all removed/added source is preserved");
    assert.doesNotMatch(source[0]!, /…/, "no leading omission row");
    assert.doesNotMatch(source.at(-1)!, /…/, "no trailing omission row");
    if ("diff" in metadata) assert.equal(source.filter((row) => row.includes("…")).length, 1, "internal omitted interval still separates changes");
    assert.match(source.join("\n"), /10 - source_10/);
    assert.match(source.join("\n"), /11 \+ inserted_11/);
    assert.match(source.join("\n"), /23 \+ changed_22/, "new-file numbering is never renumbered after context trimming");
  }
  assert.deepEqual(details, snapshot, "context projection is display-only");
  const literal = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details: { diff: ' ...\n-10 literal … before\n+10 literal … after\n ...' } } }, undefined, 100, color)!.rows.map(plain).join("\n");
  assert.match(literal, /literal … before/); assert.match(literal, /literal … after/);
  assert.equal(literal.split("\n").filter((row) => row.includes("…")).length, 2, "literal ellipsis inside code is not stripped");
});

test("edit context merges overlapping windows once and marks omitted interiors", () => {
  for (const length of [0, 2, 6, 7, 8, 12]) {
    const bridge = Array.from({ length }, (_, index) => `bridge_${index}`);
    const before = [...Array.from({ length: 8 }, (_, index) => `lead_${index}`), "OLD_A", ...bridge, "OLD_B", ...Array.from({ length: 8 }, (_, index) => `tail_${index}`)].join("\n") + "\n";
    const after = before.replace("OLD_A", "NEW_A").replace("OLD_B", "NEW_B");
    for (const details of [{ diff: generateDiffString(before, after, 20).diff }, { patch: generateUnifiedPatch("example.txt", before, after, 20) }]) {
      const rows = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details } }, undefined, 100, color)!.rows.map(plain);
      const text = rows.join("\n"), indices = [...text.matchAll(/bridge_(\d+)/g)].map((match) => Number(match[1]));
      assert.deepEqual(indices, bridge.map((_, index) => index).filter((index) => index < 3 || index >= length - 3), "overlapping context is shown once; wide interiors keep only nearest three rows");
      assert.equal(rows.filter((row) => row.includes("…")).length, length > 6 ? 1 : 0, "only an actually omitted interior needs an ellipsis row");
      for (const token of ["OLD_A", "NEW_A", "OLD_B", "NEW_B"]) assert.match(text, new RegExp(token));
    }
  }
});

test("edit context constant controls projection without fetching unavailable source", async () => {
  const url = new URL("../src/file-card.ts", import.meta.url), source = readFileSync(url, "utf8");
  const declaration = "const DIFF_CONTEXT_LINES = 3;";
  assert.ok(source.includes(declaration), "context is configured by one source constant, defaulting to three");
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-edit-context-"));
  try {
    const before = Array.from({ length: 20 }, (_, index) => `source_${index + 1}`).join("\n") + "\n", after = before.replace("source_10\n", "changed_10\n");
    for (const count of [0, 1, 6]) {
      const configured = source.replace(declaration, `const DIFF_CONTEXT_LINES = ${count};`)
        .replace(/from "([^"]+)"/gu, (_match, specifier: string) => `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
      const file = join(temporary, `edit-${count}.ts`); writeFileSync(file, configured);
      const alternate = await import(pathToFileURL(file).href);
      for (const available of [2, 8]) {
        const node = { args: { path: "example.txt" }, isPartial: false, result: { details: { diff: generateDiffString(before, after, available).diff } } };
        const text = alternate.renderFileCard(node, undefined, 100, color).rows.map(plain).join("\n");
        assert.equal([...text.matchAll(/source_(\d+)/g)].filter((match) => Number(match[1]) !== 10).length, 2 * Math.min(count, available));
        assert.match(text, /10 - source_10/); assert.match(text, /10 \+ changed_10/);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("edit context projection preserves syntax opened on the omitted fourth context line", async () => {
  initTheme("dark");
  const samples = [
    { before: "/* opening comment\ncontext_a\ncontext_b\ncontext_c\nold_token\ncontext_d\ncontext_e\ncontext_f\n*/\n", role: "syntaxComment" },
    { before: "const value = `opening template\ncontext_a\ncontext_b\ncontext_c\nold_token\ncontext_d\ncontext_e\ncontext_f\nend`;\n", role: "syntaxString" },
  ] as const;
  const terminal = new xterm.Terminal({ cols: 140, rows: 10, allowProposedApi: true });
  try {
    for (const { before, role } of samples) for (const width of [100, 140]) {
      const after = before.replace("old_token", "new_token");
      terminal.reset(); await new Promise<void>((done) => terminal.write(nativeTheme.fg(role, "X"), done));
      const expected = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor();
      if (role === "syntaxString") {
        terminal.reset(); await new Promise<void>((done) => terminal.write(nativeTheme.fg("toolOutput", "X"), done));
        assert.notEqual(expected, terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), "template case proves syntax color, not merely default foreground");
      }
      const rows = renderFileCard({ args: { path: "example.ts" }, isPartial: false,
        result: { details: { patch: generateUnifiedPatch("example.ts", before, after) } } }, undefined, width, nativeTheme,
        (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows;
      assert.ok(!rows.some((row) => plain(row).includes("opening")), "fourth context line is not displayed");
      for (const token of ["old_token", "new_token"]) {
        const row = rows.find((value) => plain(value).includes(token))!;
        terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
        assert.equal(terminal.buffer.active.getLine(0)!.getCell(plain(row).indexOf(token))!.getFgColor(), expected, "highlight full supplied source before projecting context");
      }
    }
  } finally { terminal.dispose(); }
});

test("edit compact pending/error states, metadata updates, native/compact overrides and malformed fallback", () => {
  const edit = new Tool("edit", { path: "example.ts" }); edit.result = undefined; edit.executionStarted = false;
  const { controller, original } = setup([edit]);
  try {
    assert.match(edit.render(80).map(plain).join(""), /← edit example.ts/);
    assert.doesNotMatch(edit.render(80).map(plain).join(""), /┃|← Edited/);
    edit.updateResult({ content: [{ type: "text", text: "FAILURE_BODY" }], isError: true, details: { diff: editDiff } });
    assert.doesNotMatch(edit.render(80).map(plain).join(""), /const before|FAILURE_BODY/);
    assert.equal(edit.handleMouse(mouse(0))?.handled, true);
    assert.equal(edit.expanded, true);
    edit.setExpanded(false);
    edit.updateResult({ content: [], details: { diff: editDiff } });
    assert.match(edit.render(80).map(plain).join(""), /┃/);
    edit.updateResult({ content: [], details: { diff: "UNSUPPORTED_DIFF_FORMAT" } });
    assert.deepEqual(edit.render(80), original.call(edit, 80));
    edit.updateResult({ content: [], details: { diff: "" } });
    assert.match(edit.render(80).map(plain).join(""), /┃.*← Edit/);
  } finally { controller.restore(); }
  for (const options of [{ cards: ["edit"] }, { compact: ["edit"] }]) {
    edit.result = { content: [], details: { diff: editDiff } };
    const context = setup([edit], options);
    try {
      if (options.cards) assert.deepEqual(edit.render(80), context.original.call(edit, 80));
      else assert.match(edit.render(80).map(plain).join(""), /← edit example.ts/);
    } finally { context.controller.restore(); }
  }
});

test("edit syntax colors survive changed-row backgrounds, gutters and wrapped split alignment", async () => {
  const before = 'export const before = 10;\nconst label = "old";\n// old comment\n';
  const after = 'export const after = 20;\nconst label = "new";\n// new comment\n';
  const diff = generateDiffString(before, after).diff;
  const patch = generateUnifiedPatch("example.ts", before, after);
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { diff, patch } } };
  const terminal = new xterm.Terminal({ cols: 140, rows: 60, allowProposedApi: true });
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const painted = renderFileCard(node, undefined, 140, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
      const row = painted.rows.find((value) => plain(value).includes("before = 10;") && plain(value).includes("after = 20;"))!;
      assert.ok(row, "removed/added replacements share the same split visual row");
      terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
      const text = plain(row), codeCell = (value: string) => terminal.buffer.active.getLine(0)!.getCell(text.indexOf(value))!;
      assert.equal(text.indexOf("export"), 8, "shared-frame origin + OpenTUI left-padded number/sign gutter, without an extra diff inset");
      const keyword = codeCell("export"), number = codeCell("10"), newNumber = codeCell("20");
      assert.notEqual(keyword.getFgColor(), number.getFgColor(), "syntax keyword and number retain distinct foreground colors on a deletion");
      assert.equal(number.getFgColor(), newNumber.getFgColor(), "the same syntax category is not recolored red/green by edit kind");
      assert.notEqual(number.getBgColor(), newNumber.getBgColor(), "removed and added rows have different backgrounds");
      assert.equal(number.getBgColorMode(), 0x3000000, "changed code has a concrete tinted background");
      assert.equal(keyword.getBgColor(), number.getBgColor(), "background covers all syntax spans");
      const base = colorToRgb(nativeTheme.colors.toolPendingBg);
      const expectedBackground = (role: "toolDiffRemoved" | "toolDiffAdded", alpha: number) => {
        const overlay = colorToRgb(nativeTheme.colors[role]);
        const channels = (["r", "g", "b"] as const).map((channel) => Math.round(base[channel] * (1 - alpha + alpha * overlay[channel] / 255)));
        for (const [index, channel] of (["r", "g", "b"] as const).entries()) {
          assert.ok(channels[index]! <= base[channel], `${role}: Multiply never brightens the ${channel} channel`);
        }
        return (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
      };
      for (const [role, code, sign] of [["toolDiffRemoved", number, "-"], ["toolDiffAdded", newNumber, "+"]] as const) {
        assert.equal(code.getBgColor(), expectedBackground(role, 0.16), `${role}: code uses 16% sRGB Multiply`);
        assert.equal(codeCell(sign).getBgColor(), expectedBackground(role, 0.26), `${role}: number/sign gutter uses 26% sRGB Multiply`);
        assert.equal(codeCell(sign).getBgColorMode(), 0x3000000, "gutter has a concrete tinted background");
        const lineNumber = terminal.buffer.active.getLine(0)!.getCell(text.indexOf(sign) - 2)!;
        assert.equal(lineNumber.getBgColor(), expectedBackground(role, 0.26), `${role}: line number uses the same 26% Multiply as its sign`);
      }
      const reference = highlightCode(before, "typescript")[0]!;
      terminal.reset(); await new Promise<void>((done) => terminal.write(reference, done));
      assert.equal(keyword.getFgColor(), terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), "keyword matches the public syntax renderer");
      assert.equal(number.getFgColor(), terminal.buffer.active.getLine(0)!.getCell(before.indexOf("10"))!.getFgColor(), "number matches the public syntax renderer");
    }
    const long = { args: { path: "example.ts" }, isPartial: false, result: { details: { diff: '-1 const short = 1;\n+1 const long = "' + "界é ".repeat(40) + '";\n 2 const next = 2;' } } };
    const rows = renderFileCard(long, undefined, 121, color)!.rows.map(plain);
    const end = rows.findIndex((row) => row.includes("const next = 2;"));
    assert.ok(end > 5, "right pane wraps several rows before the next pair");
    assert.equal(rows[end].match(/const next = 2;/g)?.length, 2, "the next context stays horizontally aligned after unequal wrapping");
    assert.equal(rows.filter((row) => row.includes("const short = 1;")).length, 1, "short counterpart is not repeated");
    assert.ok(rows.every((row) => visibleWidth(row) <= 121));
  } finally { terminal.dispose(); }
});

test("shared frame restores its panel background after nested background and full resets", async () => {
  const terminal = new xterm.Terminal({ cols: 32, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const role of ["toolPendingBg", "userMessageBg"] as const) {
        const base = colorToRgb(nativeTheme.colors[role]), expected = (base.r << 16) | (base.g << 8) | base.b;
        for (const reset of ["\x1b[49m", "\x1b[0m"]) {
          const geometry = cardGeometry(32);
          const body = nativeTheme.style("X", { bg: nativeTheme.colors.toolDiffAdded, fg: "syntaxKeyword" }) + reset + " neutral";
          const rows = frameRows(geometry, [body], { panel: (text) => nativeTheme.bg(role, text), border: (text) => nativeTheme.fg("borderMuted", text) });
          terminal.reset(); await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
          const line = terminal.buffer.active.getLine(1)!;
          for (let x = geometry.contentX + 1; x < geometry.panelX + geometry.panelWidth; x++) {
            assert.equal(line.getCell(x)!.getBgColorMode(), 0x3000000, "nested resets cannot expose the page inside a panel");
            assert.equal(line.getCell(x)!.getBgColor(), expected, "following text and internal right padding resume the chosen panel background");
          }
          const child = colorToRgb(nativeTheme.colors.toolDiffAdded);
          assert.equal(line.getCell(geometry.contentX)!.getBgColor(), (child.r << 16) | (child.g << 8) | child.b, "nested child background is retained");
          assert.equal(line.getCell(geometry.panelX)!.getBgColorMode(), 0, "stripe remains terminal-default");
          assert.equal(line.getCell(31)!.getBgColorMode(), 0, "exterior right margin remains terminal-default");
          assert.equal(visibleWidth(rows[1]!), 32, "reopening paint never changes geometry");
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("split edit one-to-many HTML replacement fills empty panes and internal right padding", async () => {
  const before = '<meta charset="utf-8">\n<style>\n  :root { --bg: #0b1020; }\n  body { background: radial-gradient(ellipse at 50% 8%, #202b52 0, #10172c 38%, var(--bg) 75%); }\n</style>\n</head>\n<body>\n';
  const after = '<meta charset="utf-8">\n<link rel="stylesheet" href="styles.css">\n<body>\n';
  const terminal = new xterm.Terminal({ cols: 141, rows: 60, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const base = colorToRgb(nativeTheme.colors.toolPendingBg), expected = (base.r << 16) | (base.g << 8) | base.b;
      for (const [oldText, newText] of [[before, after], [after, before]]) {
        const node = { args: { path: "index.html" }, isPartial: false,
          result: { details: { diff: generateDiffString(oldText, newText).diff, patch: generateUnifiedPatch("index.html", oldText, newText) } } };
        for (const width of [121, 140, 141]) {
          const geometry = cardGeometry(width), paneWidth = geometry.contentWidth, rightX = geometry.contentX + Math.floor(paneWidth / 2);
          const rows = renderFileCard(node, undefined, width, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows;
          terminal.resize(width, 60); terminal.reset(); await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
          const link = rows.findIndex((row) => plain(row).includes('<link rel="stylesheet"'));
          const context = rows.findIndex((row) => plain(row).includes("<body>"));
          assert.ok(context > link + 2, "unequal replacement has both wrapped and unmatched rows before context");
          for (let y = 0; y < rows.length; y++) {
            const line = terminal.buffer.active.getLine(y)!;
            assert.equal(visibleWidth(rows[y]!), width);
            assert.equal(line.getCell(width - 2)!.getBgColorMode(), 0x3000000, "last internal padding cell is not page-colored");
            assert.equal(line.getCell(width - 2)!.getBgColor(), expected, "right padding keeps neutral card background even after added code");
            assert.equal(line.getCell(width - 1)!.getBgColorMode(), 0, "exterior margin is not widened or painted");
            for (let x = geometry.contentX; x < width - 1; x++) assert.equal(line.getCell(x)!.getBgColorMode(), 0x3000000, "all panel cells remain painted, including empty counterparts");
            if (y > link && y < context && plain(rows[y]!).slice(rightX, width - 2).trim() === "") {
              for (let x = rightX; x < width - 2; x++) assert.equal(line.getCell(x)!.getBgColor(), expected, "empty right pane resumes neutral panel background");
            }
          }
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("edit diff has exactly one neutral panel padding cell on both sides", async () => {
  const terminal = new xterm.Terminal({ cols: 141, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const base = colorToRgb(nativeTheme.colors.toolPendingBg), neutral = (base.r << 16) | (base.g << 8) | base.b;
      for (const width of [100, 121, 140, 141]) {
        const geometry = cardGeometry(width);
        const rows = renderFileCard({ args: { path: "example.ts" }, isPartial: false, result: { details: { diff: '-1 const before = 10;\n+1 const after = 20;' } } }, undefined, width, nativeTheme)!.rows;
        const row = rows.find((value) => plain(value).includes("const before"))!;
        terminal.resize(width, 10); terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
        const line = terminal.buffer.active.getLine(0)!;
        assert.equal(geometry.paddingLeft, 1); assert.equal(geometry.paddingRight, 1);
        assert.equal(line.getCell(geometry.contentX - 1)!.getBgColor(), neutral, "single neutral cell before the changed gutter");
        assert.notEqual(line.getCell(geometry.contentX)!.getBgColor(), neutral, "diff background starts immediately at content origin, including its own gutter padding");
        assert.notEqual(line.getCell(width - 3)!.getBgColor(), neutral, "changed code fills the final content cell");
        assert.equal(line.getCell(width - 2)!.getBgColor(), neutral, "single neutral cell after the diff");
        assert.equal(line.getCell(width - 1)!.getBgColorMode(), 0, "exterior margin remains outside the panel");
        assert.ok(rows.some((value) => plain(value).includes("← Edited example.ts")), "only presentation label changes to past tense");
      }
    }
  } finally { terminal.dispose(); }
});

test("edit Multiply preserves black/white limits and never brightens RGB or indexed colors", async () => {
  initTheme("dark");
  const node = { args: { path: "example.ts" }, isPartial: false,
    result: { details: { diff: '-1 const old = 1;\n+1 const next = 2;' } } };
  const terminal = new xterm.Terminal({ cols: 140, rows: 30, allowProposedApi: true });
  try {
    for (const [background, added, removed] of [["#000000", "#00ff00", "#ff0000"], ["#ffffff", "#ffffff", 0], ["#08090a", 10, 9]] as const) {
      const colors = { toolPendingBg: parseColor(background), toolDiffAdded: parseColor(added), toolDiffRemoved: parseColor(removed) };
      const paint: CardTheme = { colors, fg: nativeTheme.fg.bind(nativeTheme), style: nativeTheme.style.bind(nativeTheme),
        bg: (_role, text) => nativeTheme.style(text, { bg: colors.toolPendingBg }) };
      const base = colorToRgb(colors.toolPendingBg);
      for (const width of [100, 140]) {
        const rows = renderFileCard(node, undefined, width, paint)!.rows;
        for (const [word, sign, role] of [["old", "-", "toolDiffRemoved"], ["next", "+", "toolDiffAdded"]] as const) {
          const row = rows.find((value) => plain(value).includes(`const ${word} =`))!;
          terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
          const text = plain(row), overlay = colorToRgb(colors[role]);
          for (const [column, alpha] of [[text.indexOf(`const ${word}`), 0.16], [text.indexOf(sign), 0.26]] as const) {
            const cell = terminal.buffer.active.getLine(0)!.getCell(column)!;
            assert.equal(cell.getBgColorMode(), 0x3000000);
            const channels = [cell.getBgColor() >>> 16, (cell.getBgColor() >>> 8) & 255, cell.getBgColor() & 255];
            for (const [index, channel] of (["r", "g", "b"] as const).entries()) {
              assert.equal(channels[index], Math.round(base[channel] * (1 - alpha + alpha * overlay[channel] / 255)));
              assert.ok(channels[index]! <= base[channel], "Multiply cannot brighten any channel, including black/white limits");
            }
          }
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("edit metadata formats preserve numbered contexts, multiple hunks and no-newline code", () => {
  const before = "HEAD\n" + Array.from({ length: 30 }, (_, i) => `context ${i}`).join("\n") + "\nTAIL";
  const after = before.replace("HEAD", "NEW_HEAD\nINSERTED").replace("TAIL", "NEW_TAIL");
  const diff = generateDiffString(before, after).diff;
  const patch = generateUnifiedPatch("example.txt", before, after);
  const render = (details: object) => renderFileCard({ args: { path: "/project/example.txt" }, isPartial: false, result: { details } }, "/project", 121, color);
  const numbered = render({ diff })!.rows.map(plain).join("\n");
  assert.match(numbered, /← Edited example.txt/);
  assert.match(numbered, /1 - HEAD.*1 \+ NEW_HEAD/);
  assert.match(numbered, /32 - TAIL.*33 \+ NEW_TAIL/);
  assert.match(numbered, /…/);
  const unified = render({ diff, patch })!.rows.map(plain).join("\n");
  assert.match(unified, /32 - TAIL.*33 \+ NEW_TAIL/);
  assert.doesNotMatch(unified, /@@|---|No newline/);
  assert.equal(render({ patch: "@@ -1,2 +1,1 @@\n-one\n+two\n" }), undefined, "inconsistent hunk counts delegate to native");
  assert.equal(render({ patch: "@@ -0,1 +1,1 @@\n-one\n+two\n" }), undefined, "a real line cannot have number zero");
  assert.equal(render({ diff: "+NaN junk" }), undefined);
  assert.match(render({ diff: '+1 const text = "@@ -not a patch";' })!.rows.map(plain).join(""), /@@ -not a patch/);
  const diagnostics = render({ diff, diagnostics: [{ severity: "error", line: 2, message: "Typed error" }, { severity: "warning", message: "Warning" }] })!.rows.map(plain).join("\n");
  assert.match(diagnostics, /Error \[2\]: Typed error/); assert.doesNotMatch(diagnostics, /Warning/);
});

test("edit presentation sanitizes terminal controls but preserves Unicode, indentation and code whitespace", () => {
  const args = { file_path: "界é.ts\x1b]52;c;evil\x07", newText: "PROPOSAL" };
  const source = "\tconst family = '👨‍👩‍👧‍👦 界é';  \x1b[31m\u202ehidden\u202c";
  const result = { details: { diff: "+1 " + source } };
  const snapshot = structuredClone({ args, result });
  for (let width = 1; width < 125; width++) {
    const rows = renderFileCard({ args, result, isPartial: false }, undefined, width, color)!.rows;
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.doesNotMatch(rows.join(""), /\x1b\]|\u202e|\u202c|PROPOSAL/);
    if (width >= 50) assert.match(rows.map(plain).join(""), /    const family = '👨‍👩‍👧‍👦 界é';  hidden/);
  }
  assert.deepEqual({ args, result }, snapshot);
});

test("edit adapter chooses syntax from the file type for TypeScript, Python, JSON and Rust", async () => {
  initTheme("dark");
  const samples = [
    { path: "module.ts", code: 'export const answer: number = 42;\n// comment', lang: "typescript" },
    { path: "module.py", code: "def greet(name):\n    return 'hello'\n# comment", lang: "python" },
    { path: "config.json", code: '{ "answer": 42, "ok": true }', lang: "json" },
    { path: "module.rs", code: 'fn greet() { let answer = 42; }\n// comment', lang: "rust" },
  ];
  const output = new xterm.Terminal({ cols: 100, rows: 20, allowProposedApi: true });
  const reference = new xterm.Terminal({ cols: 100, rows: 20, allowProposedApi: true });
  let checked = 0;
  try {
    for (const sample of samples) {
      const node = new Tool("edit", { path: sample.path });
      node.result = { content: [], details: { diff: sample.code.split("\n").map((line, index) => `+${index + 1} ${line}`).join("\n") } };
      const root = new Root(); root.addChild(node);
      const controller = installTidyUi(root, () => nativeTheme);
      try {
        const rows = node.render(100), highlighted = highlightCode(sample.code, sample.lang);
        for (const [index, line] of sample.code.split("\n").entries()) {
          const row = rows.find((value) => plain(value).includes(line))!;
          assert.ok(row, `${sample.path} preserves code`);
          output.reset(); reference.reset();
          await new Promise<void>((done) => output.write(row, done));
          await new Promise<void>((done) => reference.write(highlighted[index]!, done));
          const start = plain(row).indexOf(line);
          let colored = 0;
          for (let column = 0; column < line.length; column++) {
            const expected = reference.buffer.active.getLine(0)!.getCell(column)!;
            if (!expected.getChars().trim() || expected.getFgColorMode() === 0) continue;
            const actual = output.buffer.active.getLine(0)!.getCell(start + column)!;
            assert.equal(actual.getFgColor(), expected.getFgColor(), `${sample.path} retains language-specific syntax foreground at ${column}`);
            assert.equal(actual.getFgColorMode(), expected.getFgColorMode());
            colored++; checked++;
          }
          assert.ok(colored > 0, `${sample.path} line has real syntax-colored glyphs inside the diff`);
        }
      } finally { controller.restore(); }
    }
    assert.ok(checked > 60, "checks syntax glyphs, not merely a colored +/- prefix");
  } finally { output.dispose(); reference.dispose(); }
});

test("completed edit cards expand from panel cells but never margins, selection or pending state", () => {
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller, original } = setup([edit]);
  try {
    const width = 80, count = edit.render(width).length;
    const event = (x: number, y: number) => ({ ...mouse(y, width), x });
    assert.equal(edit.handleMouse(event(0, 1)), undefined, "left exterior is not the panel");
    assert.equal(edit.handleMouse(event(width - 1, 1)), undefined, "right exterior is not the panel");
    assert.equal(edit.handleMouse(event(3, count)), undefined, "rows outside the card are not targets");
    root.selection = true;
    assert.equal(edit.handleMouse(event(3, 1)), undefined);
    root.selection = false;
    edit.isPartial = true;
    assert.equal(edit.handleMouse(event(3, 1)), undefined);
    edit.isPartial = false;
    for (const [x, y] of [[1, 0], [3, 1], [width - 2, count - 1]]) {
      assert.equal(edit.handleMouse(event(x!, y!))?.handled, true, "border, content and padding use the shared panel hit bounds");
      assert.equal(edit.expanded, true);
      assert.deepEqual(edit.render(width), original.call(edit, width));
      edit.setExpanded(false);
    }
  } finally { controller.restore(); }
});

test("edit syntax carries multiline string/comment foregrounds across logical and wrapped rows", async () => {
  const templateTail = "continued template " + "template_tag ".repeat(32), commentTail = "continued comment " + "comment_tag ".repeat(32);
  const before = `const value = \`before\n${templateTail}\nend\`;\n/* before comment\n${commentTail}\n*/`;
  const after = `const value = \`after\n${templateTail}\nend\`;\n/* after comment\n${commentTail}\n*/`;
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { patch: generateUnifiedPatch("example.ts", before, after) } } };
  const terminal = new xterm.Terminal({ cols: 1600, rows: 30, allowProposedApi: true });
  try {
    for (const theme of ["dark", "light"]) for (const width of [100, 140]) {
      initTheme(theme);
      const reference = highlightCode(after, "typescript").join("\r\n");
      terminal.reset(); await new Promise<void>((done) => terminal.write(reference, done));
      const expected = [1, 4].map((y) => terminal.buffer.active.getLine(y)!.getCell(0)!.getFgColor());
      const painted = renderFileCard(node, undefined, width, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
      for (const [index, token] of ["template_tag", "comment_tag"].entries()) {
        const rows = painted.rows.filter((value) => plain(value).includes(token));
        assert.ok(rows.length > 1, "continuation source lines are also physically wrapped");
        for (const row of rows) {
          terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
          for (const match of plain(row).matchAll(new RegExp(token, "g")))
            assert.equal(terminal.buffer.active.getLine(0)!.getCell(match.index)!.getFgColor(), expected[index], `${theme}/${width}: ${token} retains native multiline syntax in every pane/wrapped row`);
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("split edit replacements never pair additions/removals from different patch hunks", () => {
  const patch = "--- example.ts\n+++ example.ts\n@@ -1,1 +1,0 @@\n-const removed = 1;\n@@ -8,0 +8,1 @@\n+const inserted = 8;\n";
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { patch } } };
  const rows = renderFileCard(node, undefined, 140, color)!.rows.map(plain);
  const removed = rows.find((row) => row.includes("const removed = 1;"))!;
  const inserted = rows.find((row) => row.includes("const inserted = 8;"))!;
  assert.ok(removed); assert.ok(inserted);
  assert.notEqual(removed, inserted, "unrelated zero-context hunks must occupy separate logical pairs");
  assert.equal(removed.trimEnd().endsWith("const removed = 1;"), true, "deletion has an empty new-file counterpart");
  assert.equal(inserted.includes("const removed = 1;"), false, "insertion has an empty old-file counterpart");
});

// Performance counters assert work/output growth, never machine-dependent timings.
test("edit minified wrapping has linear grapheme work and bounded ANSI output", (t) => {
  initTheme("dark");
  const segment = Intl.Segmenter.prototype.segment;
  let visits = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, text: string) {
    const result = segment.call(this, text);
    return { [Symbol.iterator]: function* () { for (const unit of result) { visits++; yield unit; } } };
  });
  const measurements = [400, 800, 1600, 3200].map((repeat) => {
    const before = "x+=1;".repeat(repeat), after = "x+=2;".repeat(repeat);
    const patch = `@@ -1 +1 @@\n-${before}\n+${after}\n`;
    visits = 0;
    const layout = renderFileCard({ args: { path: "minified.ts" }, isPartial: false, result: { details: { patch } } },
      undefined, 100, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
    const chars = layout.rows.reduce((sum, row) => sum + row.length, 0);
    assert.ok(visits < patch.length * 12, `${repeat}: ${visits} grapheme visits for ${patch.length} input units`);
    assert.ok(chars < patch.length * 14, `${repeat}: ${chars} rendered units for ${patch.length} input units`);
    return { visits, chars };
  });
  for (let index = 1; index < measurements.length; index++) {
    assert.ok(measurements[index]!.visits < measurements[index - 1]!.visits * 2.3, "doubling input must not quadruple scanning");
    assert.ok(measurements[index]!.chars < measurements[index - 1]!.chars * 2.3, "carry only active ANSI state, never its history");
  }
});

test("edit Multiply colors are calculated once per render, not once per fragment", () => {
  const backgrounds = new Set<unknown>();
  const theme: CardTheme = { ...color, colors: { toolPendingBg: parseColor("#303840"),
    toolDiffAdded: parseColor("#28c870"), toolDiffRemoved: parseColor("#dc3850") },
    style: (text, options) => { backgrounds.add(options.bg); return text; } };
  const patch = `@@ -1,12 +1,12 @@\n${Array.from({ length: 12 }, () => "-" + "before ".repeat(25)).join("\n")}\n${Array.from({ length: 12 }, () => "+" + "after ".repeat(25)).join("\n")}\n`;
  const layout = renderFileCard({ args: { path: "example.ts" }, isPartial: false, result: { details: { patch } } }, undefined, 100, theme)!;
  assert.ok(layout.rows.length > 50, "exercise both signs and many wrapped fragments");
  assert.equal(backgrounds.size, 4, "one code and one gutter color per added/removed role");
});

test("edit predecessor spacing never builds an unretained diff body", () => {
  const edit = new Tool("edit", { path: "example.ts" }), following = new Tool();
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([edit, following]);
  try {
    following.render(80);
    assert.equal(controller.cacheStats().builds, 1, "spacing alone builds only the following summary");
    controller.clearCache();
    const before = controller.cacheStats().builds;
    const rows = root.render(80);
    assert.equal(controller.cacheStats().builds - before, 2, "one edit body plus one summary after clearing retention");
    assert.equal(controller.cacheStats().entries, 2);
    const warm = controller.cacheStats().builds;
    assert.equal(following.render(80)[0], "", "the framed predecessor still supplies its separator");
    assert.equal(controller.cacheStats().builds, warm);
    assert.ok(rows.some((row) => row.includes("← Edited example.ts")));
  } finally { controller.restore(); }
});

test("ignored edit mouse events do not build an unretained diff", () => {
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([edit]);
  try {
    const before = controller.cacheStats().builds;
    edit.handleMouse({ ...mouse(1), button: "right" });
    edit.handleMouse({ ...mouse(1), type: "move" });
    root.selection = true; edit.handleMouse(mouse(1)); root.selection = false;
    edit.isPartial = true; edit.handleMouse(mouse(1)); edit.isPartial = false;
    assert.equal(controller.cacheStats().builds, before, "rejected events cannot highlight or frame the diff");
    assert.equal(edit.expanded, false);
  } finally { controller.restore(); }
});

test("failed edits skip stale diff parsing and syntax work", () => {
  const details = { get patch(): string { return assert.fail("failed edit must not read stale patch metadata"); } };
  const node = { args: { path: "example.ts" }, isPartial: false, result: { isError: true, details } };
  const layout = renderFileCard(node, undefined, 80, color, () => { assert.fail("failed edit must not highlight"); })!;
  assert.equal(layout.framed, false);
  assert.match(layout.rows.join(""), /← Edited example.ts/);
});

test("very large edit row counts do not overflow a function argument spread", () => {
  const count = 130_000;
  const diff = Array.from({ length: count }, (_, index) => `+${index + 1} x`).join("\n");
  const node = { args: { path: "x.txt" }, isPartial: false, result: { details: { diff } } };
  const layout = renderFileCard(node, undefined, 5, color)!;
  assert.ok(layout.rows.length >= count, "all changed rows survive without a display cap");
  assert.equal(node.result.details.diff, diff);
});


test("metadata-only edit measurement preserves render classification and separator height", () => {
  const details = [undefined, { diff: "" }, { diff: editDiff }, { patch: "@@ -1 +1 @@\n-old\n+new\n" },
    { patch: "@@ -1 +1 @@\n-old\n" }, { diff: "+1no_space" }, { diff: 4 }, { patch: null },
    { diff: " 1 first\r\n+2 next" }, { diff: "+1 text\n" }];
  for (const value of details) for (const isError of [false, true]) for (const width of [0, 1, 5, 24, 100, 140]) {
    const node = { args: { path: "/project/" + "long-folder/".repeat(8) + "example.ts" }, isPartial: false,
      result: { details: value, isError } };
    const measured = measureFileCard(node, "/project", width), layout = renderFileCard(node, "/project", width, color);
    assert.equal(!!measured, !!layout, "unsupported metadata has exactly the same native fallback");
    if (!measured || !layout) continue;
    assert.equal(measured.framed, layout.framed);
    assert.equal(measured.height > 1, layout.rows.length > 1, "framed spacing needs only the multirow predicate");
    if (!layout.framed) assert.equal(measured.height, layout.rows.length, "inline title height is exact");
  }
});

test("edit spacing and rejected events keep native delegation for malformed metadata", () => {
  const edit = new Tool("edit", { path: "example.ts" }), next = new Tool();
  edit.result = { content: [], details: { patch: "@@ -1 +1 @@\n-old\n" } };
  const { controller, original } = setup([edit, next]);
  try {
    assert.equal(next.render(80)[0], "", "native multirow predecessor still owns separation");
    const builds = controller.cacheStats().builds;
    assert.equal(edit.handleMouse({ ...mouse(1), button: "right" }), undefined);
    assert.equal(controller.cacheStats().builds, builds, "ignored native event needs no custom body either");
    assert.equal(edit.handleMouse(mouse(1))?.handled, true, "native primary click remains delegated");
    assert.equal(edit.expanded, true);
    assert.deepEqual(edit.render(80), original.call(edit, 80));
  } finally { controller.restore(); }
});


test("edit uses ordinary summaries until final success and follows the shared spinner lifecycle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const starts = t.mock.method(globalThis, "setTimeout"), stops = t.mock.method(globalThis, "clearTimeout");
  const edit = new Tool("edit", { path: "example.ts", query: "q".repeat(60), edits: [{ oldText: "old", newText: "new" }] });
  edit.result = undefined; edit.isPartial = true; edit.executionStarted = false;
  const next = new Tool("read", { path: "next.txt" });
  const { root, controller, original } = setup([edit, next]);
  try {
    const pending = edit.render(140).map(plain);
    assert.match(pending.join(""), /← edit example.ts/);
    assert.doesNotMatch(pending.join(""), /┃|← Edited/);
    assert.equal(starts.mock.calls.length, 0, "argument streaming has no animation clock");
    assert.equal(edit.handleMouse(mouse(0, 140)), undefined, "argument streaming cannot expand");
    assert.equal(next.render(24)[0], " → read next.txt", "ignored query/payloads cannot make the short edit summary multiline");
    edit.updateArgs({ ...edit.args, path: "directory/long-file-name/example.ts" });
    assert.equal(next.render(24)[0], "", "a genuinely wrapped path still determines separation");
    edit.updateArgs({ ...edit.args, path: "example.ts" });
    root.render(140); // Warm both components at the width used by the host animation pass.
    edit.markExecutionStarted();
    assert.ok(spinnerFrames.includes(plain(edit.render(140)[0]!).trim()[0]!));
    assert.equal(starts.mock.calls.length, 1);
    const builds = controller.cacheStats().builds;
    t.mock.timers.tick(100); root.render(140);
    assert.equal(controller.cacheStats().builds, builds, "spinner frames reuse summary layout");
    const proposed = { get patch(): string { return assert.fail("partial/failure custom presentation must not inspect proposed diff"); } };
    edit.updateResult({ content: [{ type: "text", text: "PARTIAL_BODY" }], details: proposed, isError: true }, true);
    const partial = edit.render(140).map(plain).join("");
    assert.match(partial, /edit example.ts/); assert.doesNotMatch(partial, /┃|← Edited|PARTIAL_BODY/);
    assert.equal(edit.handleMouse(mouse(0, 140)), undefined, "partial errors cannot expand");
    assert.equal(stops.mock.calls.length, 0, "partial errors remain running, not final failures");
    edit.updateResult({ content: [], details: { diff: editDiff } });
    assert.equal(stops.mock.calls.length, 1, "final success stops the summary spinner before painting its card");
    assert.match(edit.render(140).map(plain).join(""), /┃.*← Edited example.ts/);
    assert.match(edit.render(140).map(plain).join(""), /const after = 3/);
    const idleRequests = root.requests;
    t.mock.timers.tick(300);
    assert.equal(root.requests, idleRequests, "success leaves no idle animation redraws");
    edit.updateResult({ content: [{ type: "text", text: "FAILURE_BODY" }], isError: true, details: proposed });
    const failure = edit.render(140).map(plain).join("");
    assert.match(failure, /← edit example.ts/); assert.doesNotMatch(failure, /┃|← Edited|FAILURE_BODY|const after/);
    assert.equal(starts.mock.calls.length, 2, "the acknowledged fallback has rearmed once, with no clock for final failure");
    const offset = edit.render(140)[0] === "" ? 1 : 0;
    assert.equal(edit.handleMouse(mouse(offset, 140))?.handled, true);
    assert.deepEqual(edit.render(140), original.call(edit, 140), "failed summary opens unchanged native details");
  } finally { controller.restore(); }
});

test("edit final failures color every ordinary-summary segment and preserve state policy guards", () => {
  for (const name of ["dark", "light"] as const) {
    initTheme(name);
    const edit = new Tool("edit", { path: "example.ts", edits: [{ oldText: "old", newText: "new" }] });
    const root = new Root(); root.addChild(edit);
    const roles: string[] = [];
    const controller = installTidyUi(root, () => ({ fg: (role, text) => { roles.push(role); return nativeTheme.fg(role, text); } }));
    try {
      for (const width of [1, 5, 24, 140]) {
        edit.updateResult({ content: [{ type: "text", text: "ERROR_BODY" }], isError: true, details: { diff: editDiff } });
        roles.length = 0;
        const rows = edit.render(width), text = rows.map(plain).join("");
        assert.doesNotMatch(text, /┃|← Edited|ERROR_BODY|const before/);
        assert.ok(roles.length > 0);
        assert.ok(roles.every((role) => role === "error"), `every failed edit summary segment uses error at width ${width}`);
      }
    } finally { controller.restore(); }
  }
  class SelfEdit extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return width < 30 ? ["NATIVE SELF"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  for (const partial of [true, false]) {
    const hidden = new SelfEdit("edit", { path: "example.ts" });
    hidden.result = { content: [], isError: true }; hidden.isPartial = partial;
    const { controller } = setup([hidden]);
    try { assert.deepEqual(hidden.render(80), []); assert.match(hidden.render(24).map(plain).join(""), /edit example.ts/); }
    finally { controller.restore(); }
  }
});


test("edit state policy keeps native safeguards and explicit compact override precedence in every phase", () => {
  const states: { result: Tool["result"]; partial: boolean }[] = [
    { result: undefined, partial: true },
    { result: { content: [], details: { diff: editDiff } }, partial: true },
    { result: { content: [], isError: true, details: { diff: editDiff } }, partial: false },
    { result: { content: [], details: { diff: editDiff } }, partial: false },
  ];
  for (const state of states) {
    for (const guard of ["native", "expanded", "image", "hidden", "compact"] as const) {
      const edit = new Tool("edit", { path: "example.ts" });
      edit.executionStarted = false; edit.result = state.result; edit.isPartial = state.partial;
      if (guard === "expanded") edit.expanded = true;
      if (guard === "hidden") edit.hideComponent = true;
      if (guard === "image") edit.result = { ...state.result, content: [{ type: "image" }] };
      const { controller, original } = setup([edit], guard === "compact" ? { cards: ["edit"], compact: ["edit"] } : guard === "native" ? { cards: ["edit"] } : {});
      try {
        assert.equal(controller.active, true);
        if (guard === "compact") {
          assert.match(edit.render(140).map(plain).join(""), /← edit example.ts/);
          assert.doesNotMatch(edit.render(140).map(plain).join(""), /┃|← Edited/);
        } else assert.deepEqual(edit.render(140), original.call(edit, 140), `${guard} delegates in every edit phase`);
      } finally { controller.restore(); }
    }
  }
});


test("verified stock edit presentation never visits native rows for rendering, spacing or rejected input", (t) => {
  initTheme("dark");
  const root = new Root();
  const definition = createEditToolDefinition("/project");
  const first = new NativeToolExecution("edit", "visibility-first", { path: "example.ts" }, undefined, definition, root as never, "/project");
  const second = new NativeToolExecution("edit", "visibility-second", { path: "other.ts" }, undefined, definition, root as never, "/project");
  const follower = new Tool("read", { path: "a.txt" });
  root.addChild(first); root.addChild(second); root.addChild(follower);
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    const success = { content: [{ type: "text" as const, text: "UNCHANGED_RESULT" }], details: { diff: editDiff }, isError: false };
    for (const phase of ["arguments", "execution", "partial", "failure", "success"] as const) {
      if (phase === "execution") first.markExecutionStarted();
      first.updateResult(phase === "arguments" || phase === "execution" ? undefined as never : { ...success, isError: phase === "failure" }, phase === "arguments" || phase === "execution" || phase === "partial");
      second.updateResult(success);
      const rows = root.render(140).map(plain);
      assert.match(rows.join(""), phase === "success" ? /← Edited example.ts/ : /edit example.ts/);
      const builds = controller.cacheStats().builds;
      const repeated = root.render(140).map(plain);
      assert.deepEqual(repeated, rows);
      assert.equal(controller.cacheStats().builds, builds);
      first.handleMouse({ ...mouse(0, 140), type: "move", button: "none" });
      first.handleMouse({ ...mouse(0, 140), button: "right" });
      assert.equal(native.mock.calls.length, 0, `${phase} performs no native visibility/spacing/event render`);
    }
    for (const width of [1, 24, 120, 121, 140]) {
      root.render(width); root.render(width);
      assert.equal(native.mock.calls.length, 0, `width ${width} retains the native-free custom path`);
    }
    Reflect.set(first, "hideComponent", true);
    assert.deepEqual(first.render(140), []);
    assert.ok(native.mock.calls.length > 0, "hide guard delegates rather than displaying a custom card");
    Reflect.set(first, "hideComponent", false);
    first.setExpanded(true);
    const before = native.mock.calls.length;
    first.render(140);
    assert.ok(native.mock.calls.length > before, "native expansion remains native");
  } finally { controller.restore(); }
});

test("stock edit visibility proof rejects same-name custom renderers and is checked afresh", (t) => {
  initTheme("dark");
  const root = new Root(), definition = createEditToolDefinition("/project");
  const emptyCall = () => new Text("", 0, 0);
  const emptyResult = () => new Text("", 0, 0);
  const custom: typeof definition = { ...definition, renderCall: emptyCall, renderResult: emptyResult };
  const node = new NativeToolExecution("edit", "custom-visibility", { path: "example.ts" }, undefined, custom, root as never, "/project");
  root.addChild(node);
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme, { compact: ["edit"] });
  try {
    node.updateResult({ content: [], details: { diff: editDiff }, isError: false });
    assert.equal(Reflect.get(node, "hideComponent"), false);
    assert.deepEqual(node.render(140), []);
    assert.ok(native.mock.calls.length > 0, "an edit name is not evidence of stock visibility");
    custom.renderCall = definition.renderCall!; custom.renderResult = definition.renderResult!;
    node.updateArgs({ path: "example.ts" });
    const before = native.mock.calls.length;
    assert.match(node.render(140).map(plain).join(""), /← edit example.ts/);
    assert.equal(native.mock.calls.length, before, "the stock pair skips visibility without a retained proof cache");
    custom.renderCall = emptyCall;
    node.updateArgs({ path: "example.ts" });
    node.render(140);
    assert.ok(native.mock.calls.length > before, "replacing just one renderer immediately restores native authority");
    custom.renderCall = definition.renderCall!; custom.renderResult = emptyResult;
    node.updateArgs({ path: "example.ts" });
    const mixed = native.mock.calls.length;
    node.render(140);
    assert.ok(native.mock.calls.length > mixed, "both functions must match, not merely the call renderer");
  } finally { controller.restore(); }
});

test("completed compact calls return retained rows directly when no separator is needed", () => {
  const tool = new Tool("read", { path: "example.ts" });
  const { controller } = setup([tool]);
  try {
    const first = tool.render(80);
    assert.strictEqual(tool.render(80), first, "a cache hit without spinner/gap need not copy the row array");
    tool.updateResult({ content: [], isError: true });
    const failed = tool.render(80);
    assert.strictEqual(tool.render(80), failed);
  } finally { controller.restore(); }
});


test("stock renderer functions cannot prove visibility of a reused custom call Box", () => {
  initTheme("dark");
  const definition = createEditToolDefinition("/project");
  class InvisibleBox extends Box { render(_width: number): string[] { return []; } }
  for (const customBox of [new InvisibleBox(), Object.assign(new Box(), { render: (_width: number): string[] => [] }),
    Object.assign(new Box(), { addChild: (_child: Container | Text) => {} })]) {
    const custom: typeof definition = { ...definition, renderCall: () => customBox, renderResult: () => new Text("", 0, 0) };
    const root = new Root(), node = new NativeToolExecution("edit", "reused-custom-box", { path: "example.ts" }, undefined, custom, root as never, "/project");
    root.addChild(node);
    const follower = new Tool("read", { path: "next.txt" }); root.addChild(follower);
    const original = NativeToolExecution.prototype.render;
    const controller = installTidyUi(root, () => nativeTheme);
    try {
      node.updateResult({ content: [], details: { diff: editDiff }, isError: false });
      assert.deepEqual(node.render(140), []);
      custom.renderCall = definition.renderCall; custom.renderResult = definition.renderResult;
      node.updateArgs({ path: "example.ts" });
      assert.deepEqual(original.call(node, 140), [], "stock renderers reuse the previous Box, including its custom render method");
      assert.deepEqual(node.render(140), [], "the custom component remains the native visibility authority after renderer replacement");
      assert.notEqual(follower.render(140)[0], "", "the hidden reused Box creates no phantom predecessor spacing");
    } finally { controller.restore(); }
  }
});


test("split caches classify rendered Bash/diff bodies separately from all ordinary views", () => {
  initTheme("dark");
  const read = new Tool(), bash = bashTool("echo card"), pending = new Tool("edit", { path: "pending.ts" });
  pending.result = undefined; pending.executionStarted = false;
  const failed = new Tool("edit", { path: "failed.ts" }); failed.result = { content: [], isError: true, details: { diff: editDiff } };
  const diff = new Tool("edit", { path: "diff.ts" }); diff.result = { content: [], details: { diff: editDiff } };
  const inline = new Tool("edit", { path: "inline.ts" }); inline.result = { content: [] };
  const user = new UserMessageComponent("ordinary user card");
  const root = new Root(); for (const node of [read, bash, pending, failed, diff, inline, user]) root.addChild(node);
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    const empty = controller.cacheStats();
    assert.equal(empty.retainedBytes, 0, "component storage does not preallocate retained bodies");
    assert.equal("limitBytes" in empty, false);
    root.render(100);
    const cold = controller.cacheStats();
    assert.equal(cold.ordinary.entries, 5, "read, pending/error edit, inline heading and user card are ordinary");
    assert.equal(cold.cards.entries, 2, "only Bash and actual diff bodies enter the card cache");
    assert.equal(cold.entries, 7);
    for (const key of ["retainedBytes", "stringBytes", "overheadBytes", "rows", "entries", "hits", "misses", "builds", "releases", "collected"] as const)
      assert.equal(cold[key], cold.ordinary[key] + cold.cards[key], `aggregate ${key} equals both pools`);
    root.render(100); const warm = controller.cacheStats();
    assert.equal(warm.ordinary.builds, cold.ordinary.builds); assert.equal(warm.cards.builds, cold.cards.builds);
    pending.updateResult({ content: [], details: { diff: editDiff } }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 4); assert.equal(controller.cacheStats().cards.entries, 3);
    pending.updateResult({ content: [], isError: true, details: { diff: editDiff } }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 5); assert.equal(controller.cacheStats().cards.entries, 2);
    diff.updateResult({ content: [] }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 6); assert.equal(controller.cacheStats().cards.entries, 1);
    bash.setExpanded(true); root.render(100); assert.equal(controller.cacheStats().cards.entries, 1);
    root.render(101); assert.equal(controller.cacheStats().entries, 7, "one latest width, not one retained entry per pool/width");
    controller.clearCache(); assert.equal(controller.cacheStats().ordinary.entries, 0); assert.equal(controller.cacheStats().cards.entries, 0);
    root.render(101); controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  } finally { controller.restore(); }
});

test("component storage retains both accounting groups until their owners are removed", () => {
  const summaries = Array.from({ length: 20 }, (_, i) => new Tool("read", { path: `small_${i}.txt` }));
  const cards = Array.from({ length: 3 }, (_, i) => {
    const node = bashTool(`card_${i}`);
    node.result = { content: [{ type: "text", text: Array.from({ length: 30 }, () => "x".repeat(70)).join("\n") }] };
    return node;
  });
  const { root, controller } = setup([...summaries, ...cards]);
  try {
    const rows = summaries.map(node => node.render(80));
    cards[0]!.render(80); const baseline = controller.cacheStats();
    cards[1]!.render(80); cards[2]!.render(80);
    const retained = controller.cacheStats();
    assert.equal(retained.cards.entries, 3);
    assert.equal(retained.ordinary.retainedBytes, baseline.ordinary.retainedBytes);
    for (const [i, node] of summaries.entries()) assert.strictEqual(node.render(80), rows[i]);
    assert.equal(controller.cacheStats().ordinary.builds, baseline.ordinary.builds);
    root.removeChild(summaries[0]!);
    assert.equal(controller.cacheStats().ordinary.entries, 19); assert.equal(controller.cacheStats().cards.entries, 3);
    root.removeChild(cards[0]!);
    assert.equal(controller.cacheStats().cards.entries, 2); assert.equal(controller.cacheStats().ordinary.entries, 19);
    root.clear(); assert.equal(controller.cacheStats().entries, 0);
  } finally { controller.restore(); }
});

test("forced compact Bash/edit stay ordinary and large bodies remain component-owned",  () => {
  const bash = bashTool("echo compact"), edit = new Tool("edit", { path: "compact.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([bash, edit], { compact: ["bash", "edit"] });
  try {
    root.render(100); assert.equal(controller.cacheStats().ordinary.entries, 2); assert.equal(controller.cacheStats().cards.entries, 0);
  } finally { controller.restore(); }
  const large = new RenderCache();
  const rows = ["x".repeat(5 * 1024 * 1024)]; const entry = large.put({ rows }, rows);
  assert.ok(entry.bytes > 8 * 1024 * 1024); assert.ok(large.get(entry));
  large.clear(); assert.equal(entry.value, undefined);
});

test("layout diagnostics preserve group attribution and ignore retired launch budgets across off/on", async () => {
  const h = extensionHarness("tui", { "tidy-ui-cache-mb": "0.1", "tidy-ui-card-cache-mb": "128" });
  h.root.addChild(bashTool("card"));
  const command = h.commands.get("tidy-ui")!.handler;
  let cacheText = '';
  const readCache = async () => { cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache']); };
  const stats = () => cacheMenuStats(cacheText);
  try {
    await h.events.get("session_start")!({}, h.ctx); h.root.render(80); await readCache();
    assert.equal(stats().ordinary.entries, 1); assert.equal(stats().cards.entries, 1);
    assert.equal(stats().byKind.summary.entries, 1); assert.equal(stats().byKind.bash.entries, 1);
    for (const retired of ["cache cards limit 129", "cache cards limit -1", "cache cards limit NaN", "cache cards limit 0"] ) {
      await command(retired, h.ctx); assert.match(h.notices.at(-1)!, /Usage:/);
    }
    await readCache(); assert.equal(stats().entries, 2);
    await setAppearance(command, h.ctx, false); await setAppearance(command, h.ctx, true); h.root.render(80); await readCache();
    assert.equal(stats().entries, 2);
    assert.equal(h.notices.filter(text => /tidy-ui-card-cache-mb is ignored/u.test(text)).length, 1);
    cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache', 'Clear saved layouts']); assert.equal(stats().entries, 0);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
});


test("actual SDK mixed card working set stays warm and never evicts ordinary layouts", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/cache-partition-probe.ts"], { encoding: "utf8", timeout: 45000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.detachedEditCollected, true);
  assert.equal(result.observations[0].ordinary.entries, 200); assert.equal(result.observations[0].cards.entries, 27);
  mkdirSync(".test-artifacts/split-cache-proof", { recursive: true });
  writeFileSync(".test-artifacts/split-cache-proof/sdk.json", JSON.stringify(result, null, 2));
});

// Bounded compact argument formatting is independent of result bodies/card content.
const summarySegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const summaryLength = (text: string) => [...summarySegments.segment(text)].length;

test("bounded compact edit path bypasses every other argument and preserves lifecycle/native safeguards", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const args = { path: "src/my file.ts", pattern: "not the title", get edits(): never { return assert.fail("path-only edit must not inspect payloads"); },
    get query(): never { return assert.fail("path-only edit must not inspect ordinary fields"); } };
  assert.equal(describeArgs("edit", args), '"src/my file.ts"');
  const tool = new Tool("edit", args); tool.result = undefined; tool.executionStarted = false;
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(tool.render(80), [' ← edit "src/my file.ts"']);
    tool.markExecutionStarted();
    assert.equal(plain(tool.render(80)[0]!), ' ⠋ edit "src/my file.ts"');
    t.mock.timers.tick(100);
    assert.equal(plain(tool.render(80)[0]!), ' ⠙ edit "src/my file.ts"');
    tool.updateResult({ isError: true, content: [{ type: "text", text: "NATIVE_ERROR" }] });
    assert.deepEqual(tool.render(80), [' ← edit "src/my file.ts"']);
    tool.setExpanded(true);
    assert.deepEqual(tool.render(80), ["", "NATIVE edit", "FULL_OUTPUT"]);
    tool.setExpanded(false); tool.updateArgs({ path: "example.ts", query: "ignored", edits: [] });
    tool.updateResult({ content: [], details: { diff: editDiff } });
    assert.ok(tool.render(80).some(row => plain(row).includes("← Edited example.ts")), "success still uses the existing diff card");
  } finally { controller.restore(); }
  for (const path of [undefined, "", null, false, 0, [], { file: "a" }]) {
    const fallback = { ...(path === undefined ? {} : { path }), query: "fallback", newText: "visible" };
    assert.equal(describeArgs("edit", fallback), describeArgs("custom", fallback));
  }
});

test("bounded compact priorities expose former payloads after unknown fields and retain exact secret masking", () => {
  const payloads = ["content", "edits", "code", "input", "messages", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText"];
  for (const key of payloads) assert.equal(describeArgs("custom", { [key]: "VISIBLE" }), `[${key}="VISIBLE"]`);
  const args = { newText: "new", extra: "unknown", background: true, limit: 2, paths: ["src"], description: "why", query: "q", command: "run", action: "write", op: "apply" };
  const expected = '[op="apply", action="write", command="run", query="q", description="why", paths=["src"], limit=2, background=true, extra="unknown", newText="new"]';
  assert.equal(describeArgs("custom", args), expected);
  assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
  for (const key of ["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"])
    assert.equal(describeArgs("custom", { [key]: "SECRET".repeat(1000) }), `[${key}="<redacted>"]`);
});

test("bounded compact values cap serialized strings, arrays and objects at 256 graphemes without splitting Unicode", () => {
  assert.equal(describeArgs("custom", { content: "x".repeat(254) }), `[content="${"x".repeat(254)}"]`);
  assert.equal(describeArgs("custom", { content: "x".repeat(255) }), `[content="${"x".repeat(253)}…"]`);
  const glyph = "👩‍👩‍👧‍👦é";
  for (const value of [glyph.repeat(300), ["x".repeat(500), "TAIL"], { first: { body: "x".repeat(500) }, tail: "TAIL" }, Array(300).fill("item")]) {
    const before = structuredClone(value);
    const rendered = describeArgs("custom", { query: value }).slice("[query=".length, -1);
    assert.ok(summaryLength(rendered) <= 256, `${summaryLength(rendered)} graphemes`);
    assert.ok(rendered.includes("…"));
    assert.deepEqual(value, before);
    assert.ok(!rendered.endsWith("\\"), "do not cut an escape sequence");
  }
  const unicode = describeArgs("custom", { query: glyph.repeat(300) });
  assert.ok(!unicode.includes("�"));
  assert.ok(unicode.includes("👩‍👩‍👧‍👦é"), "keep joining marks and combining clusters intact");
  assert.ok(unicode.endsWith('…"]'));
  assert.equal(describeArgs("custom", { token: undefined }), "", "undefined secret fields are not supplied values");
  const path = "p".repeat(256);
  assert.equal(describeArgs("edit", { path }), path);
  assert.equal(describeArgs("edit", { path: path + "p" }), "p".repeat(255) + "…");
});

test("bounded compact total text caps name plus description at 1024 graphemes before wrapping and keeps failure colors", () => {
  const args = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${String(i).padStart(2, "0")}`, "v".repeat(180)]));
  const before = structuredClone(args);
  const tool = new Tool("custom", args), root = new Root(); root.addChild(tool);
  const paints: string[] = [];
  const theme = { fg: (role: string, text: string) => { paints.push(role); return text; } };
  const controller = installTidyUi(root, () => theme);
  try {
    const rows = tool.render(5000);
    assert.equal(rows.length, 1);
    assert.ok(summaryLength(rows[0]!.slice(3)) <= 1024);
    assert.ok(rows[0]!.includes("…"));
    assert.match(rows[0]!, /\]$/u, "parameter previews remain bracketed");
    assert.equal(rows[0]!.slice(3), `custom ${describeArgs("custom", args)}`);
    const builds = controller.cacheStats().builds;
    assert.strictEqual(tool.render(5000), rows, "warm completed no-gap frames reuse retained rows");
    assert.equal(controller.cacheStats().builds, builds);
    const narrow = tool.render(24);
    assert.ok(narrow.every(row => visibleWidth(row) <= 23));
    assert.equal(narrow.map(row => row.slice(3)).join("").replace(/ /gu, ""), rows[0]!.slice(3).replace(/ /gu, ""));
    tool.updateResult({ isError: true, content: [{ type: "text", text: "DO_NOT_SHOW" }] });
    paints.length = 0; tool.render(24);
    assert.ok(paints.length > 0 && paints.every(role => role === "error"));
    assert.deepEqual(tool.args, before);
  } finally { controller.restore(); }
});

test("bounded compact formatting never serializes full large strings or reads omitted structured values", (t) => {
  const huge = "x".repeat(1_000_000);
  const stringify = t.mock.method(JSON, "stringify");
  const preview = describeArgs("custom", { query: huge });
  assert.ok(preview.includes("…"));
  assert.ok(stringify.mock.calls.every(call => typeof call.arguments[0] !== "string" || call.arguments[0].length < 600), "only bounded string prefixes may enter JSON serialization");
  assert.equal(stringify.mock.callCount(), 1, "serialize the bounded prefix once, not once per grapheme");
  assert.equal((stringify.mock.calls[0]!.arguments[0] as string).length, 256);
  let visited = 0;
  const values = Array.from({ length: 2000 }, (_, i) => i);
  for (let i = 0; i < values.length; i++) Object.defineProperty(values, i, { get() { visited++; return "value"; }, enumerable: true });
  const output = describeArgs("custom", { query: values });
  assert.ok(output.includes("…"));
  assert.equal(visited, 32, "read 31 complete elements and one abbreviated element, never the other 1968");
  let rootReads = 0;
  const deferred: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) Object.defineProperty(deferred, `field${String(i).padStart(2, "0")}`, {
    enumerable: true, get() { rootReads++; return huge; },
  });
  Object.defineProperty(deferred, "zzTail", { enumerable: true, get() { return assert.fail("overall budget must stop before omitted parameter values"); } });
  assert.ok(describeArgs("custom", deferred).includes("…"));
  assert.equal(rootReads, 4, "three complete fields plus one overflow candidate; no later field values fetched");
});


test("bounded compact object previews mark both an omitted value and subsequent members", () => {
  const value = { a: "x".repeat(239), b: 123456, c: 0 };
  assert.equal(describeArgs("custom", { query: value }), `[query={"a":"${"x".repeat(239)}","b":…,…}]`);
});

test("bounded compact budgets hold across escaped strings, deep containers and priority inventory", () => {
  assert.equal(VALUE_TEXT_LIMIT, 256); assert.equal(SUMMARY_TEXT_LIMIT, 1024);
  assert.equal(new Set(PRIORITY_FIELDS).size, PRIORITY_FIELDS.length, "one unique rank per known parameter name");
  const literal = ['"', "\\", "\\u", "界", "é", "👩‍👩‍👧‍👦", "\ud800", "lone", "\udfff"].join("");
  assert.equal(JSON.parse(describeArgs("custom", { query: literal }).slice("[query=".length, -1)), literal, "escaped wire offsets retain paired/unpaired UTF-16 and literal backslashes");
  const text = literal + "\n\x1b[31mred\x1b[0m";
  let deep: unknown = "leaf";
  for (let i = 0; i < 200; i++) deep = { nested: [deep] };
  const values = [text.repeat(400), deep, { ["key".repeat(200)]: "value" }, Array.from({ length: 100 }, (_, i) => ({ item: text.repeat(i + 1), index: i }))];
  for (const value of values) {
    const output = describeArgs("custom", { query: value });
    const preview = output.slice("[query=".length, -1);
    assert.ok(summaryLength(preview) <= 256);
    assert.ok(preview.includes("…"));
    assert.doesNotMatch(preview, /\x1b|\u202e/u);
  }
  const title = "tool".repeat(300), args = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, text.repeat(40)]));
  const tool = new Tool(title, args), { controller } = setup([tool]);
  try {
    const logical = tool.render(5000)[0]!.slice(3);
    assert.ok(summaryLength(logical) <= 1024);
    assert.ok(logical.startsWith("tool".repeat(63) + "too…"));
  } finally { controller.restore(); }
});


// Write classification is presentation-only: Created also includes an existing empty file.
test("write success selects Created/Edited/Replaced/Wrote from saved source, not provider identity", () => {
  const content = 'const proposal = "NOT_RESULT";\n';
  const cases: [object | undefined, string, string][] = [
    [undefined, "Wrote", "const proposal"],
    [{ diff: "+1 const written = 1;\n+2 const next = 2;" }, "Created", "const written"],
    [{ diff: " 1 const retained = 1;\n+2 const appended = 2;" }, "Edited", "const appended"],
    [{ diff: "-1 const removed = 1;\n+1 const replaced = 2;" }, "Replaced", "const replaced"],
    [{ diff: "-1 const cleared = 1;" }, "Replaced", "const cleared"],
    [{ diff: "", noOp: true }, "Wrote", "const proposal"],
    [{ diff: " 1 unchanged", noOp: true }, "Wrote", "const proposal"],
    [{ diff: "+1 INCOMPLETE", truncated: true }, "Wrote", "const proposal"],
  ];
  for (const [details, label, source] of cases) {
    const tool = new Tool("write", { path: "example.ts", content });
    tool.result = { content: [{ type: "text", text: "RESULT_SENTINEL" }], details };
    const snapshot = structuredClone({ args: tool.args, result: tool.result });
    const { controller } = setup([tool]);
    try {
      for (const width of [80, 120, 140]) {
        const rows = tool.render(width).map(plain), text = rows.join("\n");
        assert.ok(text.includes(`← ${label} example.ts`), label);
        assert.ok(text.includes(source)); assert.ok(rows.some(row => row.startsWith(" ┃")));
        assert.doesNotMatch(text, /RESULT_SENTINEL|INCOMPLETE/);
        if (label === "Created" || label === "Wrote") assert.doesNotMatch(text, /\d+ [+-] /);
        else assert.match(text, /\d+ [+-] /);
        if (label === "Replaced" && source === "const replaced")
          assert.equal(rows.some(row => row.includes("const removed") && row.includes("const replaced")), width > 120);
        if ((details as { noOp?: boolean })?.noOp) assert.match(text, /No changes/);
        if ((details as { truncated?: boolean })?.truncated) assert.match(text, /Diff truncated by tool/);
        assert.ok(rows.every(row => visibleWidth(row) <= width));
        const builds = controller.cacheStats().builds;
        assert.deepEqual(tool.render(width).map(plain), rows); assert.equal(controller.cacheStats().builds, builds);
        assert.equal(controller.cacheStats().cards.entries, 1);
      }
      assert.deepEqual({ args: tool.args, result: tool.result }, snapshot);
    } finally { controller.restore(); }
  }
});

test("write lifecycle is path-only compact until final success, including proposed partial/error metadata", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const tool = new Tool("write", { path: "example.ts", content: "PAYLOAD_NEVER_IN_SUMMARY" });
  tool.result = undefined; tool.executionStarted = false;
  const { root, controller, original } = setup([tool]);
  try {
    assert.deepEqual(tool.render(80), [" ← write example.ts"]);
    assert.equal(controller.cacheStats().ordinary.entries, 1); assert.equal(controller.cacheStats().cards.entries, 0);
    tool.markExecutionStarted(); assert.match(tool.render(80)[0]!, /⠋ write example.ts/);
    const partial = { content: [], isError: true, details: { diff: "+1 PROPOSED_DIFF" } };
    tool.updateResult(partial, true); assert.doesNotMatch(root.render(80).join(""), /PROPOSED|PAYLOAD|┃|Created/);
    tool.updateResult(partial); assert.deepEqual(tool.render(80), [" ← write example.ts"]);
    assert.equal(controller.cacheStats().cards.entries, 0);
    tool.updateResult({ content: [], details: { diff: "+1 const written = 1;" } });
    assert.match(tool.render(80).join(""), /← Created example.ts/);
    assert.equal(controller.cacheStats().ordinary.entries, 0); assert.equal(controller.cacheStats().cards.entries, 1);
    const height = tool.render(80).length;
    assert.ok(tool.handleMouse(mouse(height - 1))?.handled); assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(80), original.call(tool, 80));
    tool.setExpanded(false); tool.updateArgs({ path: "new.ts", content: "NEW_CONTENT" }); tool.updateResult({ content: [] });
    assert.match(tool.render(80).join(""), /← Wrote new.ts/); assert.match(tool.render(80).join(""), /NEW_CONTENT/);
  } finally { controller.restore(); }
});

test("write path-only formatting ignores payload access and uses generic fallback without a valid path", () => {
  const args = new Proxy({ path: "example.ts", content: "ignored" }, {
    ownKeys() { assert.fail("path-only write must not enumerate arguments"); },
    get(target, key, receiver) { if (key === "content") assert.fail("path-only write must not read content"); return Reflect.get(target, key, receiver); },
  });
  assert.equal(describeArgs("write", args), "example.ts");
  for (const path of [undefined, "", null, [], 123]) {
    const args = { path, content: "VISIBLE_GENERIC" };
    assert.equal(describeArgs("write", args), describeArgs("ordinary", args));
    assert.match(describeArgs("write", args), /VISIBLE_GENERIC/);
  }
});


test("write validates both metadata formats and classifies globally before context projection", async () => {
  const pairs = [
    ["", "const fresh = 1;\n", "Created"],
    ["const retained = 1;\n", "const retained = 1;\nconst extra = 2;\n", "Edited"],
    ["const old = 1;\n", "const next = 2;\n", "Replaced"],
    ["const erased = 1;\n", "", "Replaced"],
    ["const identical = 1;\n", "const identical = 1;\n", "Wrote"],
  ];
  for (const [before, after, label] of pairs) {
    const numbered = generateDiffString(before!, after!).diff, patch = generateUnifiedPatch("example.ts", before!, after!);
    // A no-op unified patch can contain headers without hunks: unsupported metadata stays native.
    const metadata = before === after ? [{ diff: numbered }] : [{ diff: numbered }, { patch }, { diff: patch }];
    for (const details of metadata) {
      const node = { toolName: "write", args: { path: "example.ts", content: after }, result: { details }, isPartial: false };
      const rendered = renderFileCard(node, undefined, 140, color)!;
      assert.match(rendered.rows.map(plain).join("\n"), new RegExp(`← ${label} example.ts`));
      assert.equal(measureFileCard(node, undefined, 140)!.framed, true);
    }
  }
  const multi = "@@ -1,1 +1,2 @@\n const retained = 1;\n+const first = 2;\n@@ -10,1 +11,0 @@\n-const erased = 10;\n";
  const node = { toolName: "write", args: { path: "example.ts" }, result: { details: { patch: multi } }, isPartial: false };
  assert.match(renderFileCard(node, undefined, 140, color)!.rows.join(""), /← Replaced/);
  const url = new URL("../src/file-card.ts", import.meta.url), source = readFileSync(url, "utf8");
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-write-context-"));
  try {
    const alternateSource = source.replace("const DIFF_CONTEXT_LINES = 3;", "const DIFF_CONTEXT_LINES = 0;")
      .replace(/from "([^"]+)"/gu, (_match, specifier: string) =>
        `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
    const file = join(temporary, "file-card.ts"); writeFileSync(file, alternateSource);
    const alternate = await import(pathToFileURL(file).href);
    const rows = alternate.renderFileCard({ ...node, result: { details: { diff: " 1 OLD_CONTEXT\n+2 ADDED" } } }, undefined, 140, color).rows.map(plain).join("\n");
    assert.match(rows, /← Edited/); assert.match(rows, /2 \+ ADDED/); assert.doesNotMatch(rows, /OLD_CONTEXT|Created/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("write plain source preserves all rows, whitespace, Unicode and filename syntax without diff paint", async () => {
  const source = '/* open\ncontinued comment */\nconst family = "👩‍💻 界 é";  \n\n' + 'const v = "' + 'x'.repeat(1600) + '";\n\nTAIL_LAST';
  for (const themeName of ["dark", "light"] as const) {
    initTheme(themeName);
    for (const details of [undefined, { diff: source.split("\n").map((line, index) => `+${index + 1} ${line}`).join("\n") }]) {
      const paints: string[] = [], highlights: string[] = [];
      const paint: CardTheme = { ...nativeTheme,
        fg(role, text) { paints.push(role); return nativeTheme.fg(role, text); },
        bg(role, text) { return nativeTheme.bg(role, text); },
        style() { return assert.fail("plain write must not compute/apply Multiply diff paint"); } };
      const node = { toolName: "write", args: { path: "example.ts", content: source }, result: { details }, isPartial: false };
      for (const width of [24, 80, 140]) {
        const layout = renderFileCard(node, undefined, width, paint, (code, path) => {
          assert.equal(path, "example.ts"); highlights.push(code); return highlightCode(code, getLanguageFromPath(path));
        })!;
        assert.equal(highlights.at(-1), source, "one full resulting source stream is highlighted before wrapping");
        assert.ok(layout.rows.every(row => visibleWidth(row) === width));
        const rows = layout.rows.map(plain), start = rows.findIndex(row => /1 \/\* open/.test(row));
        const gutter = String(source.split("\n").length).length + 2, geometry = cardGeometry(width);
        const fragments = rows.slice(start, -1).map(row => row.slice(geometry.contentX + gutter, geometry.contentX + geometry.contentWidth));
        assert.equal(fragments.join("").replace(/ /g, "").includes('x'.repeat(1600)), true, "long code remains complete, far beyond compact/Bash budgets");
        assert.ok(rows.some(row => row.includes("TAIL_LAST")));
        assert.ok(rows.some(row => /┃ +4 +$/.test(row)), "blank source line keeps its number");
        assert.ok(!paints.some(role => role === "toolDiffAdded" || role === "toolDiffRemoved"));
        assert.ok(rows.join("").includes("👩‍💻")); assert.ok(rows.join("").includes("é"));
        const terminal = new xterm.Terminal({ cols: width, rows: 1, allowProposedApi: true });
        const write = (text: string) => new Promise<void>(resolve => terminal.write("\x1b[0m\r\x1b[2K" + text, resolve));
        try {
          await write(nativeTheme.fg("syntaxComment", "X"));
          const expected = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor();
          const row = layout.rows.find(row => plain(row).includes("continued"))!;
          await write(row);
          assert.equal(terminal.buffer.active.getLine(0)!.getCell(plain(row).indexOf("continued"))!.getFgColor(), expected,
            "native multiline comment color survives plain-source wrapping");
        } finally { terminal.dispose(); }
      }
    }
  }
});

test("write metadata/native/compact/image/hidden guards remain authoritative in every lifecycle phase", () => {
  const states: [Tool["result"], boolean][] = [[undefined, true], [{ content: [], details: { diff: "+1 PROPOSED" } }, true],
    [{ content: [], isError: true, details: { diff: "+1 STALE" } }, false], [{ content: [], details: { diff: "+1 FINAL" } }, false]];
  for (const [result, partial] of states) for (const guard of ["native", "expanded", "image", "hidden", "compact"]) {
    const tool = new Tool("write", { path: "example.ts", content: "CONTENT" }); tool.result = result; tool.isPartial = partial; tool.executionStarted = false;
    if (guard === "expanded") tool.expanded = true;
    if (guard === "hidden") tool.hideComponent = true;
    if (guard === "image") tool.result = { ...result, content: [{ type: "image" }] };
    const { controller, original } = setup([tool], guard === "compact" ? { cards: ["write"], compact: ["write"] } : guard === "native" ? { cards: ["write"] } : {});
    try {
      if (guard === "compact") assert.deepEqual(tool.render(140), [" ← write example.ts"]);
      else assert.deepEqual(tool.render(140), original.call(tool, 140));
    } finally { controller.restore(); }
  }
  for (const details of [{ patch: "@@ -1 +1 @@\n-before\n", diff: "+1 VALID_BUT_LOWER_PRIORITY" }, { diff: 1 }, { patch: null, diff: "+1 IGNORED" }, { diff: "+1missing_space" }]) {
    const tool = new Tool("write", { path: "example.ts", content: "INPUT" }); tool.result = { content: [], details };
    const { controller, original } = setup([tool]);
    try { assert.deepEqual(tool.render(80), original.call(tool, 80)); assert.equal(controller.cacheStats().cards.entries, 0); }
    finally { controller.restore(); }
  }
  class HiddenWrite extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return width < 30 ? ["NATIVE_VISIBLE"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new HiddenWrite("write", { path: "example.ts", content: "HIDDEN" }), follower = new Tool();
  const { controller } = setup([hidden, follower]);
  try {
    assert.deepEqual(hidden.render(80), []); assert.equal(follower.render(80)[0], " → read a.txt");
    assert.match(hidden.render(24).join(""), /← Wrote/); assert.equal(follower.render(24)[0], "");
  } finally { controller.restore(); }
});

test("write failure skips metadata/payload, uses only error paint and tears down its shared clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const starts = t.mock.method(globalThis, "setTimeout"), stops = t.mock.method(globalThis, "clearTimeout");
  const tool = new Tool("write", { path: "example.ts", get content(): string { return assert.fail("failure must not read payload"); } });
  tool.result = undefined;
  const root = new Root(); root.addChild(tool); const roles: string[] = [];
  const controller = installTidyUi(root, () => ({ fg(role, text) { roles.push(role); return text; } }));
  try {
    tool.render(80); assert.equal(starts.mock.calls.length, 1);
    const details = { get patch(): string { return assert.fail("partial/failure must not parse metadata"); } };
    tool.updateResult({ content: [], details, isError: true }, true); tool.render(80); assert.equal(stops.mock.calls.length, 0);
    tool.updateResult({ content: [{ type: "text", text: "ERROR_BODY" }], details, isError: true });
    assert.equal(stops.mock.calls.length, 1); roles.length = 0;
    assert.deepEqual(tool.render(80), [" ← write example.ts"]); assert.ok(roles.every(role => role === "error"));
    const before = root.requests; t.mock.timers.tick(500); assert.equal(root.requests, before);
  } finally { controller.restore(); }
});

test("write measurement and rejected clicks never build source and repeated body renders stay warm",  (t) => {
  const tool = new Tool("write", { path: "example.ts", content: "LONG_SOURCE_" + "x".repeat(1000) }), follower = new Tool();
  const { root, controller } = setup([tool, follower]);
  const segments = t.mock.method(Intl.Segmenter.prototype, "segment");
  try {
    follower.render(80); const builds = controller.cacheStats().builds;
    assert.ok(!segments.mock.calls.some(call => String(call.arguments[0]).startsWith("LONG_SOURCE_")));
    segments.mock.resetCalls();
    for (const event of [{ ...mouse(1), button: "right" as const }, { ...mouse(1), type: "move" as const }, { ...mouse(1), type: "wheel" as const }]) tool.handleMouse(event);
    assert.ok(!segments.mock.calls.some(call => String(call.arguments[0]).startsWith("LONG_SOURCE_")));
    assert.equal(controller.cacheStats().builds, builds);
    const ordinary = controller.cacheStats().ordinary.builds;
    tool.render(80); const bodyBuilds = controller.cacheStats().builds;
    tool.render(80); assert.equal(controller.cacheStats().cards.entries, 1); assert.equal(controller.cacheStats().builds, bodyBuilds);
    assert.equal(controller.cacheStats().ordinary.builds, ordinary);
    root.render(80);
    const warm = controller.cacheStats(); segments.mock.resetCalls(); root.render(80);
    assert.equal(controller.cacheStats().builds, warm.builds); assert.equal(segments.mock.calls.length, 0);
    assert.equal(warm.cards.entries, 1); assert.equal(warm.ordinary.entries, 1);
    assert.equal(tool.handleMouse({ ...mouse(1), x: 0 }), undefined); root.selection = true;
    assert.equal(tool.handleMouse(mouse(1)), undefined); root.selection = false;
    assert.ok(tool.handleMouse(mouse(1))?.handled);
  } finally { controller.restore(); }
});


test("actual SDK write stays provider-neutral for new, empty, replaced and cleared files and delegates expansion", async (t) => {
  initTheme("dark");
  const directory = mkdtempSync(join(tmpdir(), "tidy-ui-stock-write-")), root = new Root();
  const tool = createWriteTool(directory), definition = createWriteToolDefinition(directory);
  const source = Array.from({ length: 22 }, (_, i) => `const stock_${i + 1} = ${i + 1};`).join("\n");
  writeFileSync(join(directory, "empty.ts"), ""); writeFileSync(join(directory, "existing.ts"), "OLD_CONTENT");
  const nodes: NativeToolExecution[] = [];
  const originalRender = NativeToolExecution.prototype.render;
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    for (const [index, args] of [{ path: "new.ts", content: source }, { path: "empty.ts", content: source },
      { path: "existing.ts", content: source }, { path: "existing.ts", content: "" }].entries()) {
      const result = await tool.execute(`write-${index}`, args);
      assert.equal(result.details, undefined, "stock write provides no diff/creation metadata in any case");
      assert.equal(readFileSync(join(directory, args.path), "utf8"), args.content);
      const node = new NativeToolExecution("write", `stock-${index}`, args, undefined, definition, root as never, directory);
      root.addChild(node); nodes.push(node); node.updateResult({ ...result, isError: false });
      const rows = node.render(140).map(plain);
      assert.match(rows.join(""), /← Wrote/); assert.doesNotMatch(rows.join(""), /← Created|← Replaced/);
      if (args.content) assert.match(rows.join("\n"), /22 const stock_22 = 22;/);
    }
    assert.equal(native.mock.calls.length, 0, "stock content-shell writes need no discarded native rendering");
    root.render(140); const builds = controller.cacheStats().builds;
    root.render(140); assert.equal(controller.cacheStats().builds, builds); assert.equal(controller.cacheStats().cards.entries, 4);
    nodes[0]!.setExpanded(true); const actual = nodes[0]!.render(140), original = originalRender.call(nodes[0]!, 140);
    assert.deepEqual(actual, original); assert.ok(native.mock.calls.length > 0);
    nodes[0]!.setExpanded(false); assert.match(nodes[0]!.render(140).map(plain).join(""), /← Wrote/);
    const before = controller.cacheStats().builds;
    nodes[1]!.updateArgs({ path: "empty.ts", content: "const updated = 99;" });
    root.render(140); assert.equal(controller.cacheStats().builds, before + 1, "only changed write source is rebuilt");
    assert.match(nodes[1]!.render(140).map(plain).join(""), /const updated = 99;/);
  } finally { controller.restore(); rmSync(directory, { recursive: true, force: true }); }
});

test("path-only file summaries never read unrelated signature fields", () => {
  for (const name of ["edit", "write"]) {
    const args = { path: "example.ts" };
    for (const field of ["command", "description", "workdir", "content", "pattern", "edits"]) Object.defineProperty(args, field, {
      enumerable: true, get() { return assert.fail(`ignored ${name} ${field} must not be accessed`); },
    });
    const node = new Tool(name, args); node.result = { content: [], isError: true, details: {
      get exit_code() { return assert.fail("non-Bash signatures must not inspect Bash-only metadata"); },
    } };
    const { controller } = setup([node]);
    try { assert.deepEqual(node.render(80), [` ← ${name} example.ts`]); assert.equal(controller.active, true); }
    finally { controller.restore(); }
  }
});

// Use the real stock editor: presentation changes must not exchange its private editing state.
function editorSetup(paddingX = 0) {
  const root = Object.assign(new Root(), { terminal: { rows: 24 } });
  const theme = { borderColor: (text: string) => text,
    selectList: { selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
      description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text } };
  const keybindings = { matches: (_data: string, _action: string) => false };
  const editor = new CustomEditor(root as never, theme, keybindings as never, { paddingX, embedWorkingStatus: true });
  editor.focused = true; root.addChild(editor);
  return { root, editor, theme, keybindings };
}

test("editor card uses configured exterior geometry without exchanging native state or caching input", () => {
  const nativeRender = Editor.prototype.render;
  for (const padding of [0, 1, 2, 3, 6]) {
    const { root, editor } = editorSetup(padding), originalInput = editor.handleInput;
    editor.setText("EDITOR_LINE\n  indented\n> literal");
    const before = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
    const controller = installTidyUi(root, () => color);
    try {
      for (const width of [100, 24, 12, 8, 7]) {
        const rows = editor.render(width), geometry = editorGeometry(width, padding);
        assert.ok(rows.every(row => visibleWidth(row) <= width), `editor fits width ${width}, native padding ${padding}`);
        if (geometry.contentWidth < 2) {
          assert.deepEqual(rows, nativeRender.call(editor, width), "impossible margins delegate to native actual width");
          continue;
        }
        assert.ok(rows.every(row => editorPlain(row)[geometry.panelX] === "┃"), "top/bottom padding and every text row share the stripe");
        assert.doesNotMatch(rows.map(editorPlain).join(""), /─/u);
        assert.equal(rows.filter(row => row.includes(CURSOR_MARKER)).length, 1);
        assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, before);
      }
      assert.equal(editor.handleInput, originalInput, "input implementation is never wrapped");
      assert.equal(controller.cacheStats().entries, 0, "draft rows never enter either transcript pool");
      assert.equal(controller.cacheStats().builds, 0);
    } finally { controller.restore(); }
    assert.match(editor.render(100).map(editorPlain).join(""), /─/u);
  }
});

test("editor card retains full-width hardware cursor in right internal padding", () => {
  for (const padding of [0, 1, 2, 3]) {
    const { root, editor } = editorSetup(padding);
    const controller = installTidyUi(root, () => color);
    try {
      const width = 24, geometry = editorGeometry(width, padding);
      editor.setText("x".repeat(geometry.contentWidth));
      const rows = editor.render(width), cursorRow = rows.find(row => row.includes(CURSOR_MARKER))!;
      assert.ok(cursorRow, "focused end cursor survives framing");
      assert.equal(visibleWidth(cursorRow.slice(0, cursorRow.indexOf(CURSOR_MARKER))), width - padding - 1);
      assert.equal(editorPlain(cursorRow).slice(geometry.contentX, width - padding - 1), editor.getText());
      assert.equal(visibleWidth(cursorRow), width);
      if (padding) assert.equal(editorPlain(cursorRow).slice(-padding), " ".repeat(padding), "cursor never consumes exterior margin");
    } finally { controller.restore(); }
  }
});

test("editor card keeps paste maps undo history shortcuts and nested text insertion on the same engine", () => {
  const { root, editor } = editorSetup(2), input = editor.handleInput;
  const paste = "PASTE_界é_".repeat(200);
  editor.handleInput("\x1b[200~" + paste + "\x1b[201~");
  editor.handleInput("\x1b[D");
  const text = editor.getText(), cursor = editor.getCursor();
  let controller = installTidyUi(root, () => color);
  try {
    editor.render(60); assert.equal(editor.getExpandedText(), paste);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(editor.handleInput, input);
    controller.restore(); editor.render(60);
    assert.equal(editor.getExpandedText(), paste); assert.deepEqual(editor.getCursor(), cursor);
    controller = installTidyUi(root, () => color); editor.render(24);
    assert.equal(editor.getExpandedText(), paste); assert.equal(editor.getText(), text);
    editor.insertTextAtCursor("PROGRAMMATIC_TEXT_INSERTION");
    editor.handleInput("\x1f");
    assert.equal(editor.getExpandedText(), paste, "native undo restores expanded paste, not marker text");
    editor.addToHistory("NATIVE_HISTORY"); editor.setText(""); editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "NATIVE_HISTORY");
  } finally { controller.restore(); }
});

test("editor card maps normalized clicks to native CJK combining and wrapped cursor positions", () => {
  const originalRender = Editor.prototype.render, originalMouse = Editor.prototype.handleMouse;
  for (const padding of [0, 1, 2, 3]) {
    const { root, editor, theme, keybindings } = editorSetup(padding);
    const control = new CustomEditor(root as never, theme, keybindings as never, { paddingX: padding });
    const value = "word 界é ".repeat(8);
    editor.setText(value); control.setText(value);
    const controller = installTidyUi(root, () => color);
    try {
      for (const width of [24, 60]) {
        const geometry = editorGeometry(width, padding), nativeWidth = geometry.contentWidth + (padding ? 2 * padding : 1);
        const actualRows = editor.render(width); originalRender.call(control, nativeWidth);
        for (const [x, y] of [[geometry.contentX, 1], [geometry.contentX + 7, 2], [width - padding - 1, actualRows.length - 2]]) {
          editor.handleMouse({ ...mouse(y!, width), x: x!, screenX: x!, height: actualRows.length });
          originalMouse.call(control, { ...mouse(y!, nativeWidth), x: x! - geometry.contentX + padding, height: actualRows.length });
          assert.deepEqual(editor.getCursor(), control.getCursor(), `cursor mapping padding ${padding} width ${width}`);
          assert.equal(editor.getText(), value);
        }
        for (const type of ["press", "drag", "release", "wheel"] as const)
          assert.equal(editor.handleMouse({ ...mouse(1, width), type }), undefined, "native selection/wheel authority is unchanged");
      }
    } finally { controller.restore(); }
  }
});

test("editor card preserves native status literals scroll indicators and border-color ownership", () => {
  const { root, editor } = editorSetup();
  const border = Object.getOwnPropertyDescriptor(editor, "borderColor");
  editor.setWorkingStatusIndicator({ renderInBorder: () => "RUN─STATUS", renderSpinnerInBorder: () => "S" } as never);
  editor.setText(Array.from({ length: 20 }, (_, i) => `EDITOR_SCROLL_${i}`).join("\n"));
  const controller = installTidyUi(root, () => color);
  try {
    const rows = editor.render(60).map(editorPlain);
    assert.ok(rows[0]!.includes("RUN─STATUS"), "native status is not an optional model information row");
    assert.match(rows[0]!, /↑ \d+ more/u);
    assert.equal(rows[0]!.replace("RUN─STATUS", "").includes("─"), false, "only known horizontal decoration is removed");
    assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "borderColor"), border);
    editor.handleInput("\x01"); for (let i = 0; i < 25; i++) editor.handleInput("\x1b[A");
    assert.match(editor.render(60).map(editorPlain).at(-1)!, /↓ \d+ more/u);
  } finally { controller.restore(); }
});

test("editor card leaves custom editors and later presentation owners native", () => {
  const { root, editor, theme, keybindings } = editorSetup();
  class AlternateEditor extends CustomEditor {}
  const alternate = new AlternateEditor(root as never, theme, keybindings as never);
  root.addChild(alternate);
  const native = alternate.render(60);
  const original = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "render");
  const controller = installTidyUi(root, () => color);
  try {
    assert.deepEqual(alternate.render(60), native, "inherited wrappers do not style a subclass");
    assert.match(editor.render(60).map(editorPlain).join(""), /┃/u);
    const later = () => ["LATER_EDITOR_OWNER"];
    Object.defineProperty(CustomEditor.prototype, "render", { configurable: true, writable: true, value: later });
    controller.restore(); assert.equal(CustomEditor.prototype.render, later);
  } finally {
    controller.restore();
    if (original) Object.defineProperty(CustomEditor.prototype, "render", original);
    else Reflect.deleteProperty(CustomEditor.prototype, "render");
  }
});


test("editor card keeps native autocomplete outside frame and routes its normalized click", async () => {
  const { root, editor } = editorSetup(2);
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({ items: [{ value: "/editor-result", label: "/editor-result", description: "NATIVE_MENU" }], prefix: "/ed" }),
    applyCompletion: () => ({ lines: ["/editor-result "], cursorLine: 0, cursorCol: 15 }),
  });
  const controller = installTidyUi(root, () => color);
  try {
    editor.handleInput("/ed"); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(editor.isShowingAutocomplete(), true);
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("NATIVE_MENU"));
    assert.ok(menu > 0);
    assert.equal(editorPlain(rows[menu]!).includes("┃"), false);
    assert.equal(editorPlain(rows[menu - 1]!)[2], "┃", "menu begins below bottom panel padding");
    assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
    assert.equal(editor.getText(), "/editor-result ");
    assert.equal(editor.isShowingAutocomplete(), false);
  } finally { controller.restore(); }
});

test("editor card skips unknown factory instance overrides and preexisting renderer owners", () => {
  for (const method of ["renderTopBorder", "renderBottomBorder", "handleMouse", "getPaddingX"] as const) {
    const { root, editor } = editorSetup();
    const original = (editor as unknown as Record<string, Function>)[method]!;
    Object.defineProperty(editor, method, { configurable: true, writable: true, value: function (this: CustomEditor, ...args: unknown[]) { return original.apply(this, args); } });
    const controller = installTidyUi(root, () => color);
    try { assert.doesNotMatch(editor.render(60).map(editorPlain).join(""), /┃/u, `instance ${method} override is not stock proof`); }
    finally { controller.restore(); }
  }
  const { root, editor } = editorSetup();
  const controller = installTidyUi(root, () => color, { nativeEditor: () => false });
  try { assert.doesNotMatch(editor.render(60).map(editorPlain).join(""), /┃/u, "a registered editor factory retains authority"); }
  finally { controller.restore(); }
  const previous = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "render");
  const other = () => ["OTHER_EDITOR_RENDERER"];
  Object.defineProperty(CustomEditor.prototype, "render", { configurable: true, writable: true, value: other });
  const guarded = installTidyUi(root, () => color);
  try { assert.deepEqual(editor.render(60), ["OTHER_EDITOR_RENDERER"]); assert.equal(CustomEditor.prototype.render, other); }
  finally {
    guarded.restore();
    if (previous) Object.defineProperty(CustomEditor.prototype, "render", previous); else Reflect.deleteProperty(CustomEditor.prototype, "render");
  }
});

test("editor card restores exact paint descriptor on failures and zero/tiny widths remain native", () => {
  const { root, editor } = editorSetup();
  editor.setText("界");
  const original = Editor.prototype.render;
  const descriptor = Object.getOwnPropertyDescriptor(editor, "borderColor");
  const controller = installTidyUi(root, () => color);
  try {
    assert.deepEqual(editor.render(0), []);
    for (const width of [1, 2]) {
      assert.throws(() => original.call(editor, width), RangeError, "stock Pi wide-glyph recursion is not repaired here");
      assert.throws(() => editor.render(width), RangeError);
      assert.equal(controller.active, true, "native tiny-width failures are not custom projection failures");
    }
    for (const width of [3, 4, 5, 6])
      assert.deepEqual(editor.render(width), original.call(editor, width), `native authority for impossible width ${width}`);
    editor.setWorkingStatusIndicator({ renderInBorder: () => { throw new Error("STATUS_FAILURE"); } } as never);
    assert.throws(() => editor.render(60), /STATUS_FAILURE/u);
    assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "borderColor"), descriptor);
    assert.equal(controller.active, false, "projection failure restores owned hooks");
  } finally { controller.restore(); }
});

test("editor card foreground and padding retain user paint after the native inverse-cursor reset", async () => {
  const terminal = new xterm.Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const { root, editor } = editorSetup(2); editor.setText("BEFORE AFTER");
      for (let i = 0; i < 6; i++) editor.handleInput("\x1b[D");
      const controller = installTidyUi(root, () => nativeTheme);
      try {
        const rows = editor.render(24);
        terminal.reset(); await new Promise<void>(resolve => terminal.write(editorPaint(rows).join("\r\n"), resolve));
        const bg = colorToRgb(nativeTheme.colors.userMessageBg), fg = colorToRgb(nativeTheme.colors.userMessageText);
        const line = terminal.buffer.active.getLine(1)!;
        for (let x = 3; x < 22; x++) {
          assert.equal(line.getCell(x)!.getBgColor(), (bg.r << 16) | (bg.g << 8) | bg.b);
          assert.equal(line.getCell(x)!.getFgColor(), (fg.r << 16) | (fg.g << 8) | fg.b);
        }
        assert.equal(line.getCell(0)!.getBgColorMode(), 0); assert.equal(line.getCell(23)!.getBgColorMode(), 0);
        assert.equal(line.getCell(1)!.getBgColorMode(), 0); assert.equal(line.getCell(22)!.getBgColorMode(), 0);
        assert.equal(line.getCell(2)!.getBgColorMode(), 0, "stripe retains page background");
        assert.ok(line.getCell(10)!.isInverse(), "native fake cursor style survives");
      } finally { controller.restore(); }
    }
  } finally { terminal.dispose(); }
});


test("editor card keeps excessive native padding bounded by actual-width delegation", (t) => {
  const { root, editor } = editorSetup(1_000_000); editor.setText("x");
  const native = Editor.prototype.render, widths: number[] = [];
  const probe = t.mock.method(Editor.prototype, "render", function (this: Editor, width: number) {
    widths.push(width); return native.call(this, width);
  });
  const controller = installTidyUi(root, () => color);
  try {
    const rows = editor.render(60);
    assert.deepEqual(widths, [60], "do not materialize million-column native padding for a small input frame");
    assert.deepEqual(rows, native.call(editor, 60));
    assert.equal(controller.active, true);
  } finally { controller.restore(); probe.mock.restore(); }
});


test("editor full-line cursor inverse never paints exterior margins or subsequent padding", async () => {
  initTheme("dark");
  const terminal = new xterm.Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  const { root, editor } = editorSetup(1); editor.setText("x".repeat(editorGeometry(24, 1).contentWidth));
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    await new Promise<void>(resolve => terminal.write(editorPaint(editor.render(24)).join("\r\n"), resolve));
    const line = terminal.buffer.active.getLine(1)!;
    assert.ok(line.getCell(22)!.isInverse(), "end cursor occupies internal right padding");
    assert.equal(line.getCell(23)!.isInverse(), 0, "exterior right margin must not inherit inverse cursor");
    for (let x = 0; x < 24; x++) assert.equal(terminal.buffer.active.getLine(2)!.getCell(x)!.isInverse(), 0);
  } finally { controller.restore(); terminal.dispose(); }
});

function nativeStatusEditorSetup() {
  const value = editorWidgetSetup();
  const { root, editor, host, input } = value;
  Object.assign(root, { setFocus: (node: Component | null) => { editor.focused = node === editor; }, getClearOnShrink: () => true });
  Object.assign(host, { defaultEditor: editor, editor, editorContainer: input, statusContainer: root.children[2],
    idleStatus: new IdleStatus(), options: { tuiMode: "regular" } });
  const options = { editorStatus: true, nativeEditor: () => host.editorComponentFactory === undefined,
    rerouteEditorStatus: () => host.setCustomEditorComponent(undefined) } as TidyUiOptions;
  return { ...value, options };
}

// Exercise the actual SDK switch/clear logic, not a reconstructed status state machine.
test("native status container preserves active unknown indicator and same-editor draft across on/off", () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, options, frame } = nativeStatusEditorSetup();
    host.options.tuiMode = mode;
    editor.handleInput("\x1b[200~" + "PASTE_".repeat(300) + "\x1b[201~");
    editor.handleInput("x"); editor.handleInput("\x1b[D");
    const snapshot = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor(),
      pastes: [...(editor as any).pastes.entries()], undo: structuredClone((editor as any).undoStack), history: structuredClone((editor as any).history) });
    const before = snapshot(), descriptor = Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus");
    assert.ok(descriptor?.writable && descriptor.configurable, "SDK placement field must remain interceptable");
    let disposed = 0, borderCalls = 0;
    const indicator = { kind: "unknown-future-kind", render: () => ["", "FUTURE A─B ───"], invalidate() {},
      renderInBorder: () => { borderCalls++; return "FUTURE A─B ───"; }, renderSpinnerInBorder: () => "S", dispose: () => disposed++ };
    host.showStatusIndicator(indicator); assert.equal(host.activeWorkingIndicatorEmbedded, true);
    const controller = installTidyUi(root, () => color, options);
    try {
      assert.equal(editor.embedWorkingStatus, false, "native SDK must select its own separate container");
      assert.equal(host.editor, editor); assert.equal(host.editorComponentFactory, undefined);
      assert.equal(host.activeStatusIndicator, indicator); assert.equal(host.activeWorkingIndicatorEmbedded, false);
      assert.equal(host.statusContainer.children[0], indicator); assert.equal(disposed, 0);
      assert.deepEqual(snapshot(), before, "native self-transfer must not alter paste/cursor/undo/history");
      borderCalls = 0; frame(mode);
      assert.doesNotMatch(editor.render(100).map(editorPlain).join("\n"), /FUTURE/u);
      assert.equal(borderCalls, 0, "no discarded native border/status extraction");
      // Capture at the same width as the preceding editor and native status group frame.
      frame(mode, 100);
      const metadata = controller.renderEditorStatus(100, { model: "MODEL", provider: "raw-id", thinking: "high", idle: true });
      assert.equal(metadata.length, 2); assert.doesNotMatch(metadata.map(editorPlain).join("\n"), /FUTURE|Idle/u);
      controller.restore();
      assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus"), descriptor);
      assert.equal(host.activeStatusIndicator, indicator); assert.equal(host.activeWorkingIndicatorEmbedded, true);
      assert.equal(host.statusContainer.children.length, 0); assert.equal(disposed, 0); assert.deepEqual(snapshot(), before);
      assert.match(editor.render(100).map(editorPlain).join("\n"), /FUTURE/u);
      host.clearStatusIndicator(); assert.equal(disposed, 1, "only native lifecycle disposes the indicator");
    } finally { controller.restore(); }
  }
});

// Below-editor rows display Idle only; Pi owns all active status rendering.
test("editor status never extracts native operation text and retains fixed editor geometry", () => {
  const { root, editor, host, options, frame } = nativeStatusEditorSetup();
  const controller = installTidyUi(root, () => color, options);
  const info = { model: "GPT-6 Astra", provider: "openai-codex", thinking: "high", idle: true };
  try {
    for (const value of ["Working", "A─B ───", "── beginning", "界é", "\u0301leading", "ending\u0600"]) {
      const raw = "\x1b[33m" + value + "\x1b[39m";
      const indicator = { kind: "future-kind", render: () => [raw], invalidate() {}, dispose() {},
        renderInBorder: () => assert.fail("no border extraction"), renderSpinnerInBorder: () => assert.fail("no border extraction") };
      host.showStatusIndicator(indicator); frame("regular", 100);
      assert.deepEqual(host.statusContainer.render(100), [raw], "native output and all semantic ANSI remain unchanged");
      const rows = editor.render(100), footer = controller.renderEditorStatus(100, info);
      assert.equal(footer.length, 2); assert.match(editorPlain(footer[0]!), /GPT-6 Astra \(openai-codex\) • high/u);
      assert.doesNotMatch(editorPlain(footer[0]!), /Idle/u); assert.match(editorPlain(footer[1]!), /^ ╹▀+ $/u);
      assert.equal(rows.filter(row => row.includes(CURSOR_MARKER)).length, 1); assert.equal(controller.cacheStats().entries, 0);
    }
    host.clearStatusIndicator(); frame("regular", 100);
    assert.match(editorPlain(controller.renderEditorStatus(100, info)[0]!), / • Idle/u);
  } finally { controller.restore(); }
});

test("editor status distinguishes native status, idle and busy-hidden and updates metadata without a draft", () => {
  const { root, editor } = editorSetup();
  const controller = installTidyUi(root, () => color, { editorStatus: true } as TidyUiOptions);
  const info = { model: "GPT-6 Astra", provider: "openai-codex", thinking: "off", idle: true };
  try {
    editor.render(100);
    const render = () => (controller as any).renderEditorStatus(100, info).map(editorPlain);
    assert.match(render()[0], /GPT-6 Astra \(openai-codex\) • off • Idle/u);
    info.idle = false; assert.doesNotMatch(render()[0], /Idle/u);
    info.model = "New Model"; info.provider = "custom-id"; info.thinking = "max";
    assert.match(render()[0], /New Model \(custom-id\) • max/u);
    editor.setWorkingStatusIndicator({ renderInBorder: () => "ACTIVE", renderSpinnerInBorder: () => "S" } as never);
    editor.render(100); assert.doesNotMatch(render()[0], /ACTIVE/u, "operation text never enters metadata");
    editor.setWorkingStatusIndicator(undefined); editor.render(100);
    assert.doesNotMatch(render()[0], /ACTIVE|Idle/u);
    info.idle = true; assert.match(render()[0], / • Idle/u);
  } finally { controller.restore(); }
});

test("editor status preserves native overflow and menu clicks with no added editor-local rows", async () => {
  const { root, editor } = editorSetup(2);
  const controller = installTidyUi(root, () => color, { editorStatus: true } as TidyUiOptions);
  try {
    editor.setWorkingStatusIndicator({ renderInBorder: () => "ACTIVE", renderSpinnerInBorder: () => "S" } as never);
    editor.setText(Array.from({ length: 30 }, (_, i) => `ROW_${i}`).join("\n"));
    assert.match(editorPlain(editor.render(60)[0]!), /↑ \d+ more/u);
    for (let i = 0; i < 35; i++) editor.handleInput("\x1b[A");
    assert.match(editorPlain(editor.render(60).at(-1)!), /↓ \d+ more/u);
    editor.setText("");
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ items: [{ value: "/result", label: "/result", description: "STATUS_MENU" }], prefix: "/r" }),
      applyCompletion: () => ({ lines: ["/result "], cursorLine: 0, cursorCol: 8 }),
    });
    editor.handleInput("/r"); await new Promise<void>(resolve => setImmediate(resolve));
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("STATUS_MENU"));
    assert.equal(menu, 3, "native top/input/bottom positions stay unchanged");
    assert.deepEqual((controller as any).renderEditorStatus(60, { model: "M", provider: "P", thinking: "high", idle: false }), []);
    assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
    assert.equal(editor.getText(), "/result ");
  } finally { controller.restore(); }
});

test("editor status delegates tiny widths and foreign ownership without reading operation headers", () => {
  const { root, editor } = editorSetup();
  let stock = true, restored = 0;
  const controller = installTidyUi(root, () => color, { editorStatus: true, nativeEditor: () => stock, editorStatusRestored: () => restored++ } as TidyUiOptions);
  const info = { model: "M", provider: "P", thinking: "high", idle: true };
  try {
    for (const width of [0, 3, 6]) { editor.render(width); assert.deepEqual((controller as any).renderEditorStatus(width, info), []); }
    editor.render(24); assert.equal((controller as any).renderEditorStatus(24, info).length, 2);
    stock = false; assert.deepEqual((controller as any).renderEditorStatus(24, info), []);
    assert.doesNotMatch(editor.render(24).map(editorPlain).join(""), /┃/u);
    stock = true;
    editor.setWorkingStatusIndicator({ renderInBorder: () => "X".repeat(100), renderSpinnerInBorder: () => "S" } as never);
    editor.render(24);
    assert.equal(controller.active, true, "opaque operation header is no longer inspected");
    assert.equal(restored, 0);
  } finally { controller.restore(); }
});


test("editor status renders exact half-block palette and default background in dark and light", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const width of [7, 24, 60, 100]) {
        const rows = renderEditorStatus(width, nativeTheme, { model: "GPT-6 Astra", provider: "openai-codex", thinking: "high", idle: true });
        assert.equal(rows.length, 2); assert.ok(rows.every(row => visibleWidth(row) === width));
        assert.match(editorPlain(rows[1]!), /^ ╹▀+ $/u);
        assert.ok(editorPlain(rows[0]!).includes(width >= 9 ? "Idle" : "I…"));
        terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
        const rgb = colorToRgb(nativeTheme.colors.userMessageBg), panel = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
        for (let x = 2; x < width - 1; x++) {
          assert.equal(terminal.buffer.active.getLine(0)!.getCell(x)!.getBgColor(), panel);
          const cell = terminal.buffer.active.getLine(1)!.getCell(x)!;
          assert.equal(cell.getChars(), "▀"); assert.equal(cell.getFgColor(), panel);
          assert.equal(cell.getBgColorMode(), 0, "lower half is terminal-default background");
        }
        assert.equal(terminal.buffer.active.getLine(1)!.getCell(1)!.getChars(), "╹");
        for (const y of [0, 1]) for (const x of [0, 1, width - 1])
          assert.equal(terminal.buffer.active.getLine(y)!.getCell(x)!.getBgColorMode(), 0);
      }
    }
  } finally { terminal.dispose(); }
});

test("editor status unsupported immutable placement preserves native editor and omits metadata", () => {
  const { root, editor } = editorSetup();
  Object.defineProperty(editor, "embedWorkingStatus", { value: true, writable: false, configurable: false });
  const native = editor.render(100);
  const controller = installTidyUi(root, () => color, { editorStatus: true });
  try {
    assert.deepEqual(editor.render(100), native);
    assert.deepEqual(controller.renderEditorStatus(100, { model: "M", provider: "P", thinking: "high", idle: true }), []);
    assert.equal(controller.active, true, "other pi-tidy-ui features need not fail with the editor feature");
    assert.deepEqual(renderEditorStatus(0, color, {} as never), []);
    assert.deepEqual(renderEditorStatus(6, color, {} as never), []);
  } finally { controller.restore(); }
});

test("editor status native clock stays in its container across animation off/on and native clearing", async t => {
  const intervals = t.mock.method(globalThis, "setInterval"), clears = t.mock.method(globalThis, "clearInterval");
  const { root, editor, host, options, frame } = nativeStatusEditorSetup();
  const indicator = new StatusIndicator("unknown-future-kind" as never, root as never, text => text, text => text, "Future operation ───");
  host.showStatusIndicator(indicator);
  let controller = installTidyUi(root, () => color, options);
  const info = { model: "M", provider: "P", thinking: "high", idle: true };
  try {
    frame("regular", 100); const before = editor.render(100), first = host.statusContainer.render(100);
    assert.equal(intervals.mock.calls.length, 1); assert.doesNotMatch(controller.renderEditorStatus(100, info).map(editorPlain).join("\n"), /Idle|Future operation/u);
    await new Promise<void>(resolve => setTimeout(resolve, 100)); frame("regular", 100);
    assert.notDeepEqual(host.statusContainer.render(100), first, "native container frames advance");
    assert.equal(editor.render(100).length, before.length); assert.equal(intervals.mock.calls.length, 1);
    controller.restore(); assert.equal(clears.mock.calls.length, 0, "rerouting never disposes the indicator");
    assert.match(editor.render(100).map(editorPlain).join("\n"), /Future operation ───/u);
    controller = installTidyUi(root, () => color, options); frame("regular", 100);
    assert.equal(host.statusContainer.children[0], indicator); assert.equal(intervals.mock.calls.length, 1);
    host.clearStatusIndicator(); frame("regular", 100);
    assert.match(controller.renderEditorStatus(100, info).map(editorPlain).join("\n"), / • Idle/u);
    assert.equal(clears.mock.calls.length, 1);
  } finally { controller.restore(); }
});

test("editor status public widget reads fresh session metadata and is removed on shutdown", async () => {
  const h = extensionHarness(), { editor } = editorSetup();
  Object.assign(h.root, { terminal: { rows: 24 }, setFocus() {}, getClearOnShrink: () => true });
  const slots = Array.from({ length: 7 }, () => new Container()); slots[4]!.addChild(editor);
  for (const child of h.root.children) slots[0]!.addChild(child);
  h.root.clear(); for (const slot of slots) h.root.addChild(slot);
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: h.root, editor, defaultEditor: editor,
    editorContainer: slots[4], statusContainer: slots[2], idleStatus: new IdleStatus(), options: { tuiMode: "regular" } });
  Object.assign(h.ctx.ui, { setEditorComponent: (factory: unknown) => host.setCustomEditorComponent(factory),
    getEditorComponent: () => host.editorComponentFactory });
  const first = Object.assign(h.ctx, { model: { name: "First Name", provider: "literal-provider-id" }, thinkingLevel: "high" });
  try {
    await h.events.get("session_start")!({}, first); editor.render(100);
    const widget = h.widgetComponents.get("pi-tidy-ui-editor-status")!;
    assert.match(widget.render(100).map(editorPlain).join("\n"), /First Name \(literal-provider-id\) • high • Idle/u);
    const next = { ...first, model: { name: "Second Name", provider: "other-id" }, thinkingLevel: "off" } as unknown as ExtensionContext;
    await h.events.get("session_start")!({}, next); editor.render(100);
    assert.equal(h.widgetComponents.get("pi-tidy-ui-editor-status"), widget, "no stacked widget on session events");
    assert.match(widget.render(100).map(editorPlain).join("\n"), /Second Name \(other-id\) • off • Idle/u);
    await setAppearance(h.commands.get('tidy-ui')!.handler, next, false); assert.equal(h.widgetComponents.size, 0);
    await setAppearance(h.commands.get('tidy-ui')!.handler, next, true); editor.render(100);
    assert.match(h.widgetComponents.get("pi-tidy-ui-editor-status")!.render(100).map(editorPlain).join("\n"), /Second Name/u);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(h.widgetComponents.size, 0);
});


test("editor status semantic colors use heading parenthesized provider and thinking roles without activity", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 4, allowProposedApi: true });
  const rgb = (role: keyof typeof nativeTheme.colors) => {
    const value = colorToRgb(nativeTheme.colors[role]); return (value.r << 16) | (value.g << 8) | value.b;
  };
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "future"]) {
        const rows = renderEditorStatus(100, nativeTheme, { model: "MODEL", provider: "raw-id", thinking: level, idle: false });
        const text = editorPlain(rows[0]!);
        assert.match(text, new RegExp(`MODEL \\(raw-id\\) • ${level}`, "u"));
        assert.doesNotMatch(text, /Working|Idle/u);
        terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
        const line = terminal.buffer.active.getLine(0)!;
        const check = (value: string, role: keyof typeof nativeTheme.colors) => {
          const start = text.indexOf(value); assert.ok(start >= 0, value);
          for (let x = start; x < start + value.length; x++) assert.equal(line.getCell(x)!.getFgColor(), rgb(role), `${mode}/${level}/${value}`);
        };
        check("MODEL", "mdHeading"); check("raw-id", "muted"); check("(", "dim"); check(")", "dim");
        for (let x = 0; x < text.length; x++) if (text[x] === "•") assert.equal(line.getCell(x)!.getFgColor(), rgb("dim"));
        const roles = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" } as const;
        const role = Object.hasOwn(roles, level) ? roles[level as keyof typeof roles] : "thinkingOff";
        check(level, role);
        for (const width of [7, 24, 40, 60]) {
          const compact = renderEditorStatus(width, nativeTheme, { model: "界MODEL".repeat(30), provider: "RAW".repeat(50), thinking: level, idle: true });
          assert.ok(compact.every(row => visibleWidth(row) === width));
          const plain = editorPlain(compact[0]!); assert.equal(plain.includes("("), plain.includes(")"), "provider parentheses remain balanced after fitting");
        }
      }
    }
  } finally { terminal.dispose(); }
});


test("editor status Idle uses muted while its preceding bullet remains dim", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 4, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const rows = renderEditorStatus(100, nativeTheme, { model: "MODEL", provider: "provider-id", thinking: "high", idle: true });
      const text = editorPlain(rows[0]!), idle = text.indexOf("Idle"), bullet = text.lastIndexOf("•");
      assert.ok(idle > bullet && bullet >= 0);
      terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
      const line = terminal.buffer.active.getLine(0)!;
      const rgb = (role: "muted" | "dim") => { const c = colorToRgb(nativeTheme.colors[role]); return (c.r << 16) | (c.g << 8) | c.b; };
      for (let x = idle; x < idle + 4; x++) assert.equal(line.getCell(x)!.getFgColor(), rgb("muted"), `${mode}: Idle muted`);
      assert.equal(line.getCell(bullet)!.getFgColor(), rgb("dim"), `${mode}: separator dim`);
    }
  } finally { terminal.dispose(); }
});


test("editor status hides both metadata rows for autocomplete but native activity stays in its container", async t => {
  const intervals = t.mock.method(globalThis, "setInterval"), clears = t.mock.method(globalThis, "clearInterval");
  const { root, editor, host, options } = nativeStatusEditorSetup();
  let resolve!: (value: any) => void;
  editor.setAutocompleteProvider({
    getSuggestions: () => new Promise(done => { resolve = done; }),
    applyCompletion: () => ({ lines: ["/result "], cursorLine: 0, cursorCol: 8 }),
  });
  const indicator = new StatusIndicator("unknown-future-kind" as never, root as never, text => text, text => text, "ACTIVE");
  host.showStatusIndicator(indicator);
  const controller = installTidyUi(root, () => color, options);
  const info = { model: "M", provider: "P", thinking: "high", idle: false };
  const status = () => controller.renderEditorStatus(60, info);
  try {
    editor.render(60); assert.equal(status().length, 2);
    editor.handleInput("/r"); await new Promise<void>(done => setImmediate(done));
    assert.equal(editor.isShowingAutocomplete(), false, "pending provider request is not an open menu");
    editor.render(60); assert.equal(status().length, 2, "do not hide during pending-only lookup");
    resolve({ items: [{ value: "/result", label: "/result", description: "AUTOCOMPLETE_HIDE" }], prefix: "/r" });
    await new Promise<void>(done => setImmediate(done));
    assert.equal(editor.isShowingAutocomplete(), true);
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("AUTOCOMPLETE_HIDE"));
    assert.equal(menu, 3, "native editor/menu y coordinates remain unchanged");
    assert.deepEqual(status(), [], "both metadata rows disappear");
    assert.match(host.statusContainer.render(60).map(editorPlain).join("\n"), /ACTIVE/u, "native activity is independent of autocomplete");
    assert.deepEqual(status(), [], "unchanged menu has no widget output");
    assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
    controller.restore(); assert.match(editor.render(60).map(editorPlain).join("\n"), /ACTIVE/u);
    const again = installTidyUi(root, () => color, options);
    try {
      editor.render(60); assert.deepEqual(again.renderEditorStatus(60, info), [], "on while menu open still hides widget");
      assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
      assert.equal(editor.getText(), "/result "); assert.equal(editor.isShowingAutocomplete(), false);
      editor.render(60);
      assert.doesNotMatch(again.renderEditorStatus(60, info).map(editorPlain).join("\n"), /ACTIVE|Idle/u);
      assert.equal(host.statusContainer.children[0], indicator, "completion retains the same native indicator");
      assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
      editor.setText(""); editor.handleInput("/r"); await new Promise<void>(done => setImmediate(done));
      resolve({ items: [{ value: "/result", label: "/result" }], prefix: "/r" });
      await new Promise<void>(done => setImmediate(done)); editor.render(60);
      assert.deepEqual(again.renderEditorStatus(60, info), []);
      const draft = editor.getText(); editor.handleInput("\x1b");
      assert.equal(editor.isShowingAutocomplete(), false); assert.equal(editor.getText(), draft);
      editor.render(60); assert.equal(again.renderEditorStatus(60, info).length, 2, "Escape restores both rows");
      editor.setText(""); editor.handleInput("/none"); await new Promise<void>(done => setImmediate(done));
      resolve({ items: [], prefix: "/none" }); await new Promise<void>(done => setImmediate(done));
      assert.equal(editor.isShowingAutocomplete(), false); editor.render(60);
      assert.equal(again.renderEditorStatus(60, info).length, 2, "empty suggestions do not hide the widget");
      assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
    } finally { again.restore(); }
  } finally { controller.restore(); host.clearStatusIndicator(); }
});


test("editor padding moves the whole input and status panel live while inner spacing stays one", () => {
  const { root, editor } = editorSetup(1);
  const controller = installTidyUi(root, () => color, { editorStatus: true });
  const info = { model: "MODEL", provider: "raw-id", thinking: "high", idle: false };
  const budgets: number[] = [];
  editor.setWorkingStatusIndicator({ renderInBorder: (width: number) => { budgets.push(width); return truncateToWidth("ACTIVE", width, ""); }, renderSpinnerInBorder: () => "S" } as never);
  editor.setText("TEXT 界é");
  const before = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
  try {
    for (const width of [100, 24]) for (const padding of [0, 3, 2, 1, 0]) {
      editor.setPaddingX(padding);
      const rows = editor.render(width), status = controller.renderEditorStatus(width, info), contentX = padding + 2;
      assert.equal(status.length, 2);
      for (const row of [...rows, ...status.slice(0, 1)]) {
        const plain = editorPlain(row);
        assert.equal(visibleWidth(row), width);
        assert.equal(plain[padding], "┃", `padding ${padding}: entire panel stripe moves`);
        assert.equal(plain[padding + 1], " ", "fixed inner left gap separates text and stripe");
        assert.equal(plain[width - padding - 1], " ", "fixed inner right gap");
        assert.equal(plain.slice(0, padding), " ".repeat(padding));
        if (padding) assert.equal(plain.slice(-padding), " ".repeat(padding));
      }
      assert.equal(editorPlain(rows[1]!).slice(contentX, contentX + 4), "TEXT");
      assert.equal(editorPlain(status[1]!), " ".repeat(padding) + "╹" + "▀".repeat(width - 2 * padding - 1) + " ".repeat(padding));
      assert.deepEqual(budgets, [], "metadata and geometry never format native operation text");
      assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, before);
    }
    controller.restore();
    const native = editor.render(100); assert.ok(editorPlain(native[1]!).startsWith("TEXT"), "off restores selected native zero padding");
  } finally { controller.restore(); }
});

// Native widget methods and fullscreen composition are deliberate SDK contract probes.
// Do not replace these with a mock registry when upgrading the development host.
function editorWidgetSetup() {
  const { root, editor } = editorSetup(1); root.clear();
  const document = new Container(), pendingMessages = new Container(), status = new Container();
  const above = new Container(), input = new Container(), below = new Container(), footer = new Container();
  input.addChild(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: root, widgetContainerAbove: above, widgetContainerBelow: below,
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
  });
  host.renderWidgets();
  host.mountInteractiveTui(root, [document, pendingMessages, status, above, input, below, footer]);
  const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove: above,
    editor: input, widgetsBelow: below, footer });
  const frame = (mode: string, width = 80) => mode === "fullscreen"
    ? renderLayoutFrame(viewport.root, width, 40, () => {}).lines : root.render(width);
  return { root, editor, host, above, input, below, viewport, frame };
}

test("editor widget gap SDK compatibility: stock spacer dock ordering and current-pass render contract", () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, above, input, below, viewport, frame } = editorWidgetSetup();
    assert.equal(root.children.length, 7, "host mounting retains seven managed slots");
    assert.equal(root.children[3], above); assert.equal(root.children[4], input); assert.equal(root.children[5], below);
    assert.equal(above.children.length, 1, "native empty group supplies exactly one spacer");
    assert.equal(Object.getPrototypeOf(above.children[0]!), Spacer.prototype);
    assert.deepEqual(above.render(80), [""], "native empty spacer is one unpainted row");
    assert.ok(viewport.root instanceof Container);
    const dock = viewport.root.children[1] as Container;
    assert.equal(dock.children.length, 6, "actual fullscreen dock keeps the known six slots");
    assert.equal(dock.children[2], above); assert.equal(dock.children[3], input); assert.equal(dock.children[4], below);
    const events: string[] = [], order: string[] = [];
    host.setExtensionWidget("compat-upper", () => ({ render() { events.push("upper"); order.push("upper"); return ["SDK_WIDGET"]; }, invalidate() {} }));
    frame(mode);
    const nativeCalls = events.length;
    assert.equal(nativeCalls, mode === "regular" ? 1 : 2, "actual SDK frame has an explicit native render-count control");
    events.length = 0; order.length = 0;
    const controller = installTidyUi(root, () => { order.push("editor"); return color; });
    try {
      const rows = frame(mode);
      assert.deepEqual(order, Array.from({ length: nativeCalls }, () => ["upper", "editor"]).flat(), "SDK must render the upper group before every editor projection in the current pass");
      const painted = editor.render(80).map(editorPlain);
      assert.deepEqual(events, Array(nativeCalls).fill("upper"), "spacing adds no widget renders beyond the same native frame");
      assert.equal(painted[0], "", "compatible native layout must activate the separator, not silently fall back");
      assert.equal(painted[1]![1], "┃");
      const widgetY = rows.findIndex(row => editorPlain(row).includes("SDK_WIDGET"));
      assert.ok(widgetY >= 0); assert.equal(editorPlain(rows[widgetY + 1]!), "");
      assert.equal(editorPlain(rows[widgetY + 2]!)[1], "┃", "separator follows the native upper group immediately");
      host.setExtensionWidget("compat-upper", () => ({ render() { events.push("empty"); order.push("empty"); return []; }, invalidate() {} }));
      assert.equal(above.children.length, 2, "native registered zero-height widgets retain the leading spacer");
      order.length = 0; frame(mode);
      assert.deepEqual(order, Array.from({ length: nativeCalls }, () => ["empty", "editor"]).flat(), "height-zero observation must precede the editor, not arrive a frame late");
      assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "zero-row current pass must replace the positive observation");
      assert.deepEqual(events, [...Array(nativeCalls).fill("upper"), ...Array(nativeCalls).fill("empty")]);
    } finally { controller.restore(); }
  }
});

test("editor widget gap excludes absent zero-height and below-only widgets and follows live height", t => {
  const clock = t.mock.method(globalThis, "setInterval");
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, frame } = editorWidgetSetup();
    editor.setText("GAP_INPUT_界é");
    const records: { explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
    const controller = installTidyUi(root, () => color, { editorStatus: true,
      diagnostic: (_level, area, explanation, fields) => { if (area === 'editor') records.push({ explanation, fields }); } });
    let content: string[] = [], calls = 0;
    const nativeCalls = mode === "regular" ? 1 : 2;
    try {
      const draw = () => { frame(mode); return editor.render(80); };
      const baseline = draw();
      assert.equal(editorPlain(baseline[0]!)[1], "┃", "native empty-group spacer does not add an editor row");
      host.setExtensionWidget("lower-only", () => ({ render: () => ["LOWER_WIDGET"], invalidate() {} }), { placement: "belowEditor" });
      assert.deepEqual(draw(), baseline, "lower widgets cannot trigger an upper separator");
      host.setExtensionWidget("live-height", () => ({ render() { calls++; return content; }, invalidate() {} }));
      assert.deepEqual(draw(), baseline, "registered zero-row component reserves no additional editor height");
      assert.equal(calls, nativeCalls);
      content = ["UPPER_ONE", "UPPER_TWO"];
      const shown = draw(); assert.deepEqual(shown, ["", ...baseline]); assert.equal(calls, 2 * nativeCalls);
      assert.equal(records.at(-1)?.fields?.offsetY, 1, "same-size editor must report its newly computed separator mapping");
      assert.equal(records.length, 2, "zero-height observations deduplicate; positive mapping emits once");
      assert.equal(shown.findIndex(row => row.includes(CURSOR_MARKER)), baseline.findIndex(row => row.includes(CURSOR_MARKER)) + 1);
      host.setExtensionWidget("later-registration", () => ({ render: () => ["LAST_UPPER"], invalidate() {} }));
      assert.deepEqual(draw(), shown, "new widget registration cannot cross the editor-owned gap"); assert.equal(calls, 3 * nativeCalls);
      assert.equal(records.length, 2, "unchanged positive mapping emits no repeated record");
      content = []; host.setExtensionWidget("later-registration", undefined);
      assert.deepEqual(draw(), baseline, "same registered component becoming zero-height removes the gap"); assert.equal(calls, 4 * nativeCalls);
      assert.equal(records.at(-1)?.fields?.offsetY, 0); assert.equal(records.length, 3);
      host.setExtensionWidget("live-height", undefined);
      assert.deepEqual(draw(), baseline, "removing the last upper widget removes the gap"); assert.equal(calls, 4 * nativeCalls);
      assert.equal(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }).length, 2);
      assert.equal(clock.mock.calls.length, 0, "widget spacing introduces no animation or polling clock");
    } finally { controller.restore(); }
  }
});

test("editor widget gap maps native text menu clicks and leaves the empty row noninteractive", async () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, frame } = editorWidgetSetup();
    host.setExtensionWidget("upper", ["CLICK_WIDGET"]);
    const controller = installTidyUi(root, () => color, { editorStatus: true });
    try {
      editor.setText("abc界éXYZ"); frame(mode);
      const rows = editor.render(80); assert.equal(rows[0], "");
      const cursor = editor.getCursor();
      assert.equal(editor.handleMouse({ ...mouse(0), height: rows.length }), undefined);
      assert.deepEqual(editor.getCursor(), cursor, "separator cannot move the cursor");
      assert.equal(editor.handleMouse({ ...mouse(2), x: 3, height: rows.length })?.handled, true);
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, "painted text y maps back to native y");
      editor.setText("");
      editor.setAutocompleteProvider({
        getSuggestions: async () => ({ items: [{ value: "/gap-result", label: "/gap-result", description: "GAP_MENU" }], prefix: "/g" }),
        applyCompletion: () => ({ lines: ["/gap-result "], cursorLine: 0, cursorCol: 12 }),
      });
      editor.handleInput("/g"); await new Promise<void>(resolve => setImmediate(resolve)); frame(mode);
      const menuRows = editor.render(80), menu = menuRows.findIndex(row => editorPlain(row).includes("GAP_MENU"));
      assert.equal(menu, 4, "only the one external row shifts native autocomplete");
      assert.deepEqual(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }), []);
      assert.equal(editor.handleMouse({ ...mouse(menu), x: 3, height: menuRows.length })?.handled, true);
      assert.equal(editor.getText(), "/gap-result ");
      frame(mode); assert.equal(editor.render(80)[0], "", "completion retains gap while upper widgets exist");
      assert.equal(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }).length, 2);
    } finally { controller.restore(); }
  }
});

test("editor widget gap rejects changed managed layout spacer and later container-render owners", () => {
  const { root, editor, host, above, frame } = editorWidgetSetup();
  host.setExtensionWidget("upper", ["GUARD_WIDGET"]);
  const original = Object.getOwnPropertyDescriptor(Container.prototype, "render")!;
  const controller = installTidyUi(root, () => color);
  try {
    frame("regular"); const valid = editor.render(80); assert.equal(valid[0], "");
    root.addChild(new Container()); frame("regular");
    assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "unknown managed slots omit optional gap rather than guessing");
    root.removeChild(root.children.at(-1)!);
    (above.children[0] as Spacer).setLines(2); frame("regular");
    assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "unknown stock spacer shape fails closed");
    host.renderWidgets(); frame("regular"); assert.equal(editor.render(80)[0], "");
    above.render = () => ["FOREIGN_GROUP"];
    frame("regular"); assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "foreign group renderer is not interpreted");
    Reflect.deleteProperty(above, "render"); frame("regular"); assert.equal(editor.render(80)[0], "");
    const later = function (this: Container, width: number) { return original.value.call(this, width); };
    Container.prototype.render = later;
    frame("regular"); assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "later prototype owner invalidates measurements");
    controller.restore(); assert.equal(Container.prototype.render, later, "restoration respects later owner");
  } finally { controller.restore(); Object.defineProperty(Container.prototype, "render", original); }
});


test("editor widget gap ignores stale-width observations and restores both public render descriptors", () => {
  const { root, editor, host, above, frame } = editorWidgetSetup();
  host.setExtensionWidget("upper", ["WIDTH_WIDGET"]);
  const container = Object.getOwnPropertyDescriptor(Container.prototype, "render")!;
  const spacer = Object.getOwnPropertyDescriptor(Spacer.prototype, "render")!;
  const controller = installTidyUi(root, () => color);
  try {
    frame("regular", 80); assert.equal(editor.render(80)[0], "");
    assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "another width cannot use the retained group height");
    frame("fullscreen", 60); assert.equal(editor.render(60)[0], "");
    host.renderWidgets();
    assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "replaced native spacer invalidates a previous group observation");
    frame("regular", 60); assert.equal(editor.render(60)[0], "");
    (above.children[0] as Spacer).render = () => [""];
    frame("regular", 60); assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "an instance spacer owner invalidates the proof");
    controller.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(Container.prototype, "render"), container);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Spacer.prototype, "render"), spacer);
    assert.notEqual(editor.render(80)[0], "", "off restores native rows rather than a lingering prefix");
  } finally { controller.restore(); }
});


test("editor directory abbreviates the native home only at a path boundary before fitting", () => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(tmpdir(), "tidy-ui-home-界"), theme = { fg: (_role: string, value: string) => value };
  const setHome = (value: string) => { process.env.HOME = value; process.env.USERPROFILE = value; };
  const render = (cwd: string, width = 120) => renderEditorStatus(width, theme,
    { model: "M", provider: "P", thinking: "off", idle: false, cwd, branch: "main" });
  try {
    setHome(home);
    for (const [cwd, expected] of [[home, "~"], [home + sep, "~"], [join(home, "project"), "~" + sep + "project"],
      [join(home, "parent", "界é"), "~" + sep + "parent" + sep + "界é"],
      [home + "-other" + sep + "project", home + "-other" + sep + "project"], [home + "2", home + "2"]]) {
      const row = plain(render(cwd!)[0]!);
      assert.ok(row.endsWith(expected + ":main  "), JSON.stringify({ cwd, expected, row }));
      assert.equal(visibleWidth(row), 120);
      for (const width of [7, 24, 60]) assert.ok(render(cwd!, width).every(line => visibleWidth(line) === width));
      assert.equal(plain(render(cwd!)[0]!), row, "resize starts from the original directory");
    }
    const calls: [string, string][] = [], info = { model: "M", provider: "P", thinking: "off", idle: false,
      cwd: join(home, "project"), branch: "main" }, before = structuredClone(info);
    renderEditorStatus(120, { fg: (role, value) => { calls.push([role, value]); return value; } }, info);
    for (const expected of [["dim", "~" + sep], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]])
      assert.ok(calls.some(call => call[0] === expected[0] && call[1] === expected[1]), JSON.stringify(expected));
    assert.deepEqual(info, before, "real cwd and branch remain unchanged");
    setHome(home + sep);
    assert.ok(plain(render(home)[0]!).endsWith("~:main  "), "non-root trailing home separators are ignored");
    setHome(home + "-other");
    assert.ok(plain(render(home)[0]!).endsWith(home + ":main  "), "home is read live, not retained as presentation state");
    const root = parse(home).root; setHome(root);
    assert.ok(plain(render(root)[0]!).endsWith("~:main  "), "home may be the filesystem root");
    assert.ok(plain(render(join(root, "project"))[0]!).endsWith("~" + sep + "project:main  "));
    assert.doesNotMatch(plain(render("")[0]!), /:main/u, "missing cwd stays absent even with a root home");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("editor directory is right-aligned with one shared inner padding cell", () => {
  const info = { model: "M", provider: "raw-id", thinking: "off", idle: false,
    cwd: "/tidy-ui-directory/work/project", branch: "feature/input-status" };
  const row = plain(renderEditorStatus(100, { fg: (_role, text) => text }, info)[0]!);
  assert.equal(visibleWidth(row), 100);
  assert.ok(row.endsWith(info.cwd + ":" + info.branch + "  "), "one painted padding plus one exterior margin");
  assert.ok(row.startsWith(" ┃ M (raw-id) • off"));
  assert.match(row, /off {2,}\/tidy-ui-directory\//u);
});

test("editor directory colors keep last path element distinct from parents and branch", () => {
  const calls: [string, string][] = [];
  const info = { model: "M", provider: "P", thinking: "high", idle: true, cwd: "/tidy-ui-directory/project", branch: "main" };
  renderEditorStatus(100, { fg: (role, value) => { calls.push([role, value]); return value; } }, info);
  for (const expected of [["dim", "/tidy-ui-directory/"], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]])
    assert.ok(calls.some(call => call[0] === expected[0] && call[1] === expected[1]), JSON.stringify(expected));
});

test("editor directory retains its last name before a long branch and recovers on resize", () => {
  const info = { model: "long model name", provider: "raw-provider", thinking: "high", idle: false,
    cwd: "/home/kot/work/important", branch: "feature/something-extremely-long" };
  const theme = { fg: (_role: string, value: string) => value };
  const wide = plain(renderEditorStatus(120, theme, info)[0]!);
  const narrow = plain(renderEditorStatus(32, theme, info)[0]!);
  assert.ok(narrow.includes("important"), "whole last directory outranks branch and parent path");
  assert.ok(!narrow.includes(info.branch)); assert.ok(narrow.includes("…"));
  assert.equal(plain(renderEditorStatus(120, theme, info)[0]!), wide);
});


test("Git branch source validates real repository kinds without environment redirection", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const base = mkdtempSync(join(tmpdir(), "tidy-ui-git-"));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const sources: InstanceType<typeof GitBranchSource>[] = [];
  try {
    const plainDir = join(base, "plain"), fake = join(base, "fake"), repo = join(base, "repo"), bare = join(base, "bare");
    for (const cwd of [plainDir, fake, repo, bare]) mkdirSync(cwd);
    mkdirSync(join(fake, ".git"));
    git(repo, "init", "-b", "unborn"); git(bare, "init", "--bare", "-b", "bare-main");
    const nested = join(repo, "nested"); mkdirSync(nested);
    for (const [cwd, expected] of [[plainDir, undefined], [fake, undefined], [repo, "unborn"], [nested, "unborn"], [bare, "bare-main"]] as const) {
      const source = new GitBranchSource(() => {}); sources.push(source);
      source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), expected);
    }
    const poisoned = new GitBranchSource(() => {}, { env: { ...process.env, GIT_DIR: join(bare, "."), GIT_WORK_TREE: bare } });
    sources.push(poisoned); poisoned.setDirectory(plainDir); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(plainDir), undefined);
    poisoned.setDirectory(repo); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(repo), "unborn");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
    git(repo, "checkout", "--detach"); poisoned.refresh(true); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(repo), undefined);
    const worktree = join(base, "linked"); git(repo, "worktree", "add", "-b", "linked-name", worktree);
    poisoned.setDirectory(worktree); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(worktree), "linked-name");
  } finally { for (const source of sources) source.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("Git branch source observes atomic HEAD changes with zero warm-frame queries", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-watch-"));
  let resolve: (() => void) | undefined;
  const source = new GitBranchSource(() => resolve?.());
  try {
    assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "first"]).status, 0);
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "first");
    const before = gitDiagnostics();
    for (let n = 0; n < 100; n++) { source.setDirectory(cwd); source.branch(cwd); }
    await awaitFixture(source.settled()); assert.equal(gitDiagnostics().queries, before.queries);
    const changed = new Promise<void>(done => { resolve = done; });
    assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/second"]).status, 0);
    await awaitFixture(changed);
    await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "second");
    assert.ok(gitDiagnostics().queries > before.queries);
    source.dispose(); assert.equal(source.branch(cwd), undefined);
  } finally { source.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});


test("directory reduction stages are ordered and column/grapheme safe", () => {
  const theme = { fg: (_role: string, value: string) => value };
  const path = "/home/kot/work/project", branch = "feature/input-status";
  for (const [width, expected] of [[43, path + ":" + branch], [40, "/home/ko…rk/project:" + branch],
    [36, "/home/…/project:" + branch], [21, "/home/…/project:fe…us"], [20, "…/project:fe…us"],
    [14, "…/project:fe…s"], [12, "…/project:f…"], [11, "…/project"], [8, "project"], [6, "proje…"], [2, "p…"], [1, ""]] as const)
    assert.equal(directoryStatus(path, branch, width, theme), expected, `stage width ${width}`);
  for (const cwd of ["/", "C:\\", "\\\\server\\share\\", "C:\\Users\\kot\\project", "/project", "project",
    "/home/界界/é👨‍👩‍👧‍👦界", "/home/kot/trailing/", "/tmp/\x1b[31mname\n"]) {
    for (let width = 0; width < 100; width++) {
      const text = directoryStatus(cwd, "alpha界界界", width, theme);
      assert.ok(visibleWidth(text) <= width, JSON.stringify({ cwd, width, text }));
      assert.notEqual(text, "…"); assert.ok(!text.endsWith(":")); assert.ok(!text.includes("……"));
      assert.ok(!text.includes("\x1b") && !text.includes("\n"));
    }
  }
  assert.equal(directoryStatus("/home/kot/trailing/", undefined, 100, theme), "/home/kot/trailing");
  assert.equal(directoryStatus("/", "main", 100, theme), "/:main");
  assert.equal(directoryStatus("C:\\", undefined, 100, theme), "C:\\");
  assert.equal(directoryStatus("~\\", undefined, 100, theme), "~");
  const calls: [string, string][] = [];
  assert.equal(directoryStatus("~\\parent\\project", "main", 100, { fg: (role, value) => { calls.push([role, value]); return value; } }), "~\\parent\\project:main");
  assert.deepEqual(calls, [["dim", "~\\parent\\"], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]]);
  assert.equal(directoryStatus("\\\\server\\share\\", undefined, 100, theme), "\\\\server\\share\\");
});

test("directory column quotas preserve Idle and release missing-block allocation", () => {
  const theme = { fg: (_role: string, value: string) => value };
  const info = { model: "m".repeat(80), provider: "p".repeat(80), thinking: "high", idle: true,
    cwd: "/home/kot/work/important", branch: "b".repeat(80) };
  for (let width = 7; width < 130; width++) {
    const row = plain(renderEditorStatus(width, theme, info)[0]!);
    assert.equal(visibleWidth(row), width);
    if (width >= 9) assert.ok(row.includes("Idle"));
    assert.equal(plain(renderEditorStatus(width, theme, info)[0]!), row, "deterministic resize fitting");
  }
  const plainInfo = { ...info, cwd: "/x", branch: undefined, idle: false };
  const row = plain(renderEditorStatus(100, theme, plainInfo)[0]!);
  assert.ok(row.includes("m".repeat(80)), "short right block releases quota back to left");
});

test("Git branch source ignores late cancelled replies and releases jobs/watches", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  let release: ((value: { ok: boolean; output: string }) => void) | undefined;
  let started: (() => void) | undefined;
  const waiting = new Promise<void>(done => { started = done; });
  const before = gitDiagnostics();
  const source = new GitBranchSource(() => {}, { execute: async (cwd, args) => {
    if (args[1] === "--local-env-vars") return { ok: true, output: "GIT_DIR\n" };
    if (args[0] !== "symbolic-ref") return { ok: false, output: "" };
    if (cwd === "/tidy-ui-old-not-present") { started?.(); return new Promise(done => { release = done; }); }
    return { ok: true, output: "refs/heads/fresh\n" };
  } });
  source.setDirectory("/tidy-ui-old-not-present"); await waiting;
  source.setDirectory("/tidy-ui-new-not-present");
  release!({ ok: true, output: "refs/heads/stale\n" }); await awaitFixture(source.settled());
  assert.equal(source.branch("/tidy-ui-old-not-present"), undefined);
  assert.equal(source.branch("/tidy-ui-new-not-present"), "fresh");
  source.dispose(); await awaitFixture(source.settled());
  assert.equal(gitDiagnostics().activeJobs, before.activeJobs); assert.equal(gitDiagnostics().watchers, before.watchers);
});

test("Git branch source recovers repository creation and supports available reftable watches", async t => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-new-"));
  let listener: (() => void) | undefined;
  const source = new GitBranchSource(() => listener?.());
  const change = async (action: () => void) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = new Promise<void>((resolve, reject) => {
      listener = resolve; timer = setTimeout(() => reject(new Error("repository watch did not refresh")), 3000);
    });
    try { action(); await done; await awaitFixture(source.settled()); } finally { clearTimeout(timer!); listener = undefined; }
  };
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), undefined);
    await change(() => { assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "created"]).status, 0); });
    assert.equal(source.branch(cwd), "created");
    source.dispose(); await awaitFixture(source.settled()); rmSync(join(cwd, ".git"), { recursive: true });
    const reftable = spawnSync("git", ["-C", cwd, "init", "--ref-format=reftable", "-b", "table-first"]);
    if (reftable.status !== 0) { t.diagnostic("Git reftable is unavailable; repository creation control passed"); return; }
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "table-first");
    await change(() => { assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/table-next"]).status, 0); });
    assert.equal(source.branch(cwd), "table-next");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
});


test("Git rediscovery rearms watches after same-path metadata directory replacement", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const base = mkdtempSync(join(tmpdir(), "tidy-ui-git-replaced-")), cwd = join(base, "current"), other = join(base, "other");
  mkdirSync(cwd); mkdirSync(other);
  const git = (path: string, ...args: string[]) => assert.equal(spawnSync("git", ["-C", path, ...args]).status, 0);
  let listener: (() => void) | undefined;
  const source = new GitBranchSource(() => listener?.());
  const change = async (expected: string, action: () => void) => {
    let timer: ReturnType<typeof setTimeout>;
    const changed = new Promise<void>((done, fail) => {
      listener = () => { if (source.branch(cwd) === expected) done(); };
      timer = setTimeout(() => fail(new Error(`watch did not publish ${expected}; actual ${source.branch(cwd)}`)), 1500);
    });
    try { action(); await changed; await awaitFixture(source.settled()); } finally { clearTimeout(timer!); listener = undefined; }
  };
  try {
    git(cwd, "init", "-b", "first"); git(other, "init", "-b", "second");
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "first");
    await change("second", () => {
      renameSync(join(cwd, ".git"), join(base, "moved-away")); renameSync(join(other, ".git"), join(cwd, ".git"));
    });
    await change("third", () => git(cwd, "symbolic-ref", "HEAD", "refs/heads/third"));
    assert.equal(source.branch(cwd), "third");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(base, { recursive: true, force: true }); }
});


test("native activity same-editor routing restores another focused component", () => {
  const { root, editor, host, options } = nativeStatusEditorSetup();
  const other = new Text("focus-owner", 0, 0); (root.children[0] as Container).addChild(other);
  let focused: Component | null = other;
  Object.assign(root, { getFocusedComponent: () => focused,
    setFocus: (node: Component | null) => { focused = node; editor.focused = node === editor; } });
  const text = "PRESERVED_DRAFT"; editor.setText(text);
  const before = editor.getCursor(); const controller = installTidyUi(root, () => color, options);
  try {
    assert.equal(focused, other); assert.equal(editor.focused, false); assert.equal(host.editor, editor);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), before);
    controller.restore(); assert.equal(focused, other); assert.equal(editor.focused, false);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), before);
  } finally { controller.restore(); }
});


test("Git failures omit branch without blocking cwd or retaining resources", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-error-"));
  const records: { explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
  const before = gitDiagnostics(), source = new GitBranchSource(() => {}, { env: { ...process.env, PATH: "/git-not-present" },
    diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), undefined);
    const current = gitDiagnostics(); assert.equal(current.spawned, before.spawned, "missing binary started zero processes");
    assert.equal(records.find(record => record.explanation.startsWith('Git query did not succeed'))?.fields?.code, 'ENOENT');
    for (let n = 0; n < 50; n++) source.setDirectory(cwd);
    await awaitFixture(source.settled()); assert.equal(gitDiagnostics().queries, current.queries, "no retry polling on errors");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
  assert.equal(gitDiagnostics().watchers, before.watchers); assert.equal(gitDiagnostics().activeJobs, before.activeJobs);
});


test("Git rediscovery reads HEAD after installing current metadata watches", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-rearm-race-"));
  assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "before-rearm"]).status, 0);
  let armed = false, mutations = 0;
  const source = new GitBranchSource(() => {}, { execute: async (path, args, env) => {
    const result = spawnSync("git", ["-C", path, ...args], { env, encoding: "utf8" });
    if (armed && args.includes("--git-common-dir")) {
      armed = false; mutations++;
      assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/changed-during-rearm"]).status, 0);
    }
    return { ok: result.status === 0, output: result.stdout, code: result.status ?? undefined };
  } });
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "before-rearm");
    armed = true; source.refresh(true); await awaitFixture(source.settled());
    assert.equal(mutations, 1, "one controlled HEAD mutation before metadata-query completion");
    assert.equal(source.branch(cwd), "changed-during-rearm", "publish post-installation HEAD, not stale pre-rearm snapshot");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
});


test("Git repository environment isolation removes case-variant redirect keys", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const source = new GitBranchSource(() => {}, { env: { Path: "/git", git_dir: "elsewhere", Git_Work_Tree: "wrong" },
    execute: async (_cwd, args, env) => {
      if (args.includes("--local-env-vars")) return { ok: true, output: "GIT_DIR\nGIT_WORK_TREE\n" };
      assert.ok(!Object.keys(env).some(key => ["GIT_DIR", "GIT_WORK_TREE"].includes(key.toUpperCase())), "Windows environment keys are case-insensitive");
      return { ok: args[0] === "symbolic-ref", output: args[0] === "symbolic-ref" ? "refs/heads/isolated\n" : "" };
    } });
  try {
    source.setDirectory("/tidy-ui-env-not-present"); await awaitFixture(source.settled());
    assert.equal(source.branch("/tidy-ui-env-not-present"), "isolated");
  } finally { source.dispose(); await awaitFixture(source.settled()); }
});


// Footer integration starts with real SDK mounting/public UI and real session records.
// The deterministic context/auth fixtures never emulate the native footer renderer.
const footerForeignEditor: NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> =
  (value, theme, keys) => new CustomEditor(value, theme, keys);
async function footerSetup(foreignEditor = false, selectorAtStartup = false) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { FooterComponent } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js");
  initTheme("dark");
  const manager = SessionManager.inMemory("/footer-probe");
  const model = { id: "FOOTER_MODEL", name: "Footer Model", provider: "footer-provider", contextWindow: 272000 };
  let context: { tokens: number | null; percent: number | null; contextWindow: number } | undefined = { tokens: 104500, percent: 104500 / 272000 * 100, contextWindow: 272000 };
  let scans = 0, contextReads = 0, nameReads = 0, authReads = 0, auto = true, subscription = true;
  const getName = manager.getSessionName.bind(manager);
  manager.getSessionName = () => { nameReads++; return getName(); };
  const entries = manager.getEntries.bind(manager);
  manager.getEntries = () => { scans++; return entries(); };
  const statuses = new Map<string, string>([["magic-context", "mc: 104.5K (51%) · idle"]]);
  const data = { getGitBranch: () => "FOOTER_BRANCH", getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses, onBranchChange: () => () => {} };
  const { root, editor, keybindings } = editorSetup(); root.clear();
  Object.assign(root, { setFocus() {} });
  const input = new Container(); input.addChild(editor);
  const readContext = () => { contextReads++; return context; };
  const session = { sessionManager: manager, model, state: { model, thinkingLevel: "off" },
    modelRuntime: { isUsingSubscription: () => subscription }, getContextUsage: readContext };
  const native = new FooterComponent(session as never, data);
  const footer = new Container(); footer.addChild(native);
  const above = new Container(), below = new Container();
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: root, footerContainer: footer,
    footer: native, footerDataProvider: data, customFooter: undefined,
    defaultEditor: editor, editor, editorContainer: input, statusContainer: new Container(), keybindings,
    widgetContainerAbove: above, widgetContainerBelow: below,
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map() });
  for (const child of [new Container(), new Container(), host.statusContainer, above, input, below, footer]) root.addChild(child);
  const handlers = new Map<string, Function[]>();
  let command: Function;
  const pi = { on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    registerFlag() {}, getFlag() {}, getThinkingLevel: () => "off", getSettings: () => ({ compaction: { enabled: auto } }),
    registerCommand(name: string, options: { handler: Function }) { if (name === "tidy-ui") command = options.handler; } };
  const ctx = { mode: "tui", hasUI: true, cwd: "/footer-probe", ui: { ...host.createExtensionUIContext(), notify() {} }, model, sessionManager: manager,
    modelRegistry: { isUsingOAuth: () => { authReads++; return subscription; }, getProvider: () => { authReads++; return { auth: { oauth: { isSubscription: true } } }; } },
    getContextUsage: readContext, isIdle: () => true };
  const emit = (name: string, event: unknown = {}) => Promise.all((handlers.get(name) ?? []).map(fn => fn(event, ctx)));
  const append = (input = 11000000, output = 1500000, cacheRead = 243000000, cacheWrite = 0, cost = 61.761) => manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "FOOTER_USAGE" }], api: "openai-responses", provider: model.provider,
    model: model.id, timestamp: 1, stopReason: "stop", usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } });
  if (foreignEditor) ctx.ui.setEditorComponent(footerForeignEditor);
  if (selectorAtStartup) { input.clear(); input.addChild(new Text("NATIVE_RELOAD_BOX", 0, 0)); }
  append(); tidyUi(pi as unknown as ExtensionAPI, { logging: false, settings: fixtureSyntaxOptions().settings, syntax: fixtureSyntaxOptions }); await emit('session_start');
  return { root, host, footer, native, ctx, manager, statuses, append, emit, editor, input,
    render: (width = 140) => footer.children[0]!.render(width), counts: () => ({ scans, contextReads }), authReads: () => authReads,
    nameReads: () => nameReads,
    context(value: typeof context) { context = value; }, auto(value: boolean) { auto = value; }, subscription(value: boolean) { subscription = value; },
    control: (action: string) => setAppearance(command! as any, ctx as unknown as ExtensionContext, action === 'on'), close: () => emit("session_shutdown") };
}

test("footer uses structured native usage with requested ordering and no cwd/model", async () => {
  const f = await footerSetup();
  try {
    const rows = f.render().map(stripVTControlCharacters);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!, /^\[·········▁\] CH95\.7% • 105k\/272k \(38\.4%\)/u);
    assert.doesNotMatch(rows[0]!, /↑|↓|R243|W\d|\$|\(sub\)|\(auto\)/u);
    assert.equal(f.authReads(), 0, "hidden cost never reads authentication");
    assert.ok(rows[0]!.endsWith("mc: 104.5K (51%) · idle"));
    assert.ok(!rows.join("\n").includes("FOOTER_MODEL")); assert.ok(!rows.join("\n").includes("FOOTER_BRANCH"));
    assert.ok(!rows.join("\n").includes("/footer-probe"));
  } finally { f.close(); }
});

test("footer moves whole statuses before truncation and right-aligns overflow", async () => {
  const f = await footerSetup();
  try {
    f.statuses.clear(); f.statuses.set("b", "SECOND_STATUS"); f.statuses.set("a", "FIRST_STATUS");
    const rows = f.render(60).map(stripVTControlCharacters);
    assert.ok(rows[0]!.trimEnd().endsWith("FIRST_STATUS"));
    assert.equal(rows[1], " ".repeat(60 - 13) + "SECOND_STATUS");
    for (const row of rows) assert.doesNotMatch(row, /^\s*•|•\s*$/u, "no dangling separator at a status row break");
    f.statuses.clear(); f.statuses.set("x", "LONG_STATUS_" + "界é".repeat(40));
    const narrow = f.render(24).map(stripVTControlCharacters);
    const status = narrow.find(row => row.includes("LONG_STATUS_"))!;
    assert.ok(status.endsWith("…")); assert.ok(visibleWidth(status) <= 24);
    assert.equal(narrow.filter(row => row.includes("LONG_STATUS_")).length, 1);
    assert.equal(narrow.length, 2, "one truncated statistics row plus one whole producer status row");
    assert.ok(narrow[0]!.startsWith("[·········▁] CH95.7%") && narrow[0]!.endsWith("…"));
    assert.ok(!narrow[0]!.includes("105k"), "tail clipping preserves cache information before context");
  } finally { f.close(); }
});

test("footer refreshes nullable context window flags and native cache writes", async () => {
  const f = await footerSetup();
  try {
    f.context({ tokens: 1500000, contextWindow: 2000000, percent: 75 }); f.emit("model_select");
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("1.50M/2.00M (75.0%)"));
    f.context({ tokens: null, contextWindow: 272000, percent: null }); f.emit("session_compact");
    f.auto(false); f.subscription(false); f.append(5, 6, 0, 12, 0);
    const rows = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(rows.includes("?/272k")); assert.ok(!rows.includes("(0.0%)")); assert.ok(!rows.includes("(auto)")); assert.ok(!rows.includes("(sub)"));
    assert.ok(rows.includes("(auto off)")); assert.ok(rows.includes("CH0.0%")); assert.ok(!rows.includes("W12"));
  } finally { f.close(); }
});

test("footer warm frames avoid session scans and context reads across status width theme invalidations", async () => {
  const f = await footerSetup();
  try {
    const first = f.render(); const before = f.counts();
    for (let i = 0; i < 32; i++) assert.equal(f.render(), first, "latest unchanged layout rows are reused");
    f.statuses.set("extra", "EXTRA"); f.render(60); f.host.customFooter.invalidate(); f.render(60);
    assert.deepEqual(f.counts(), before);
    f.append(1, 2, 3, 4, 0); f.render(60);
    assert.deepEqual(f.counts(), { scans: before.scans + 1, contextReads: before.contextReads + 1 });
    const leaf = f.manager.getLeafId()!; f.append(1, 2, 3, 4, 0); f.manager.branch(leaf); f.emit("session_tree");
    const rows = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(rows.includes("[·······▁▅▅] CH37.5%"), "branch-back retains reports from abandoned raw history");
  } finally { f.close(); }
});

test("footer session title follows native resume fallback through first message rename clear and raw branches", async () => {
  const { footerDiagnostics } = await import("../src/footer.ts");
  const f = await footerSetup();
  try {
    f.statuses.clear();
    const title = () => f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(title().endsWith(" • (no messages)"));
    f.manager.appendMessage({ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 1 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • (no messages)"));
    f.manager.appendMessage({ role: "user", content: [{ type: "text", text: "First" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "session message" }], timestamp: 2 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • First session message"));
    const first = f.manager.getLeafId()!, found = footerDiagnostics();
    f.manager.appendMessage({ role: "user", content: "A later message is not the title", timestamp: 3 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • First session message"));
    assert.equal(footerDiagnostics().titleLookups, found.titleLookups, "first raw text is stable under later appends");
    assert.equal(footerDiagnostics().titleEntries, found.titleEntries);
    const before = f.counts(), names = f.nameReads();
    f.manager.appendSessionInfo("Explicit title"); await f.emit("session_info_changed", { name: "Explicit title" });
    assert.ok(title().endsWith(" • Explicit title"));
    f.manager.appendSessionInfo(""); await f.emit("session_info_changed", { name: undefined });
    assert.ok(title().endsWith(" • First session message"));
    assert.deepEqual(f.counts(), before, "rename/clear uses cached fallback without rereading history/context");
    assert.equal(f.nameReads(), names + 2);
    const row = f.render(); for (let i = 0; i < 20; i++) assert.equal(f.render(), row);
    f.render(80); f.statuses.set("extra", "EXTRA"); f.render(140); f.statuses.clear();
    assert.deepEqual(f.counts(), before); assert.equal(f.nameReads(), names + 2);
    assert.equal(footerDiagnostics().titleLookups, found.titleLookups);
    assert.equal(footerDiagnostics().titleEntries, found.titleEntries);
    f.manager.resetLeaf(); await f.emit("session_tree");
    assert.ok(title().endsWith(" • First session message"), "resume uses first raw user text even outside current branch");
    f.manager.createBranchedSession(first); await f.emit("session_start", { reason: "fork" });
    assert.ok(title().endsWith(" • First session message"), "fork uses its retained file entries");
    await f.control("off"); await f.control("on"); assert.ok(title().endsWith(" • First session message"));
    await f.emit("session_start", { reason: "reload" }); assert.ok(title().endsWith(" • First session message"));
    f.manager.newSession(); await f.emit("session_start", { reason: "new" }); assert.ok(title().endsWith(" • (no messages)"));
  } finally { f.close(); }
});

test("footer session names refresh independently of usage and retain warm layouts", async () => {
  const { footerDiagnostics } = await import("../src/footer.ts");
  const f = await footerSetup();
  try {
    const baseline = f.render(), before = f.counts();
    for (const name of ["SESSION_TITLE", "X", "", "Another session"]) {
      const nameReads = f.nameReads();
      f.manager.appendSessionInfo(name); f.emit("session_info_changed", { name: name || undefined });
      const updated = f.render();
      assert.equal(f.nameReads(), nameReads + 1, "one saved-name lookup at a metadata boundary");
      if (name) assert.ok(updated.map(stripVTControlCharacters).join(" ").includes(" • " + name));
      else assert.deepEqual(updated.map(stripVTControlCharacters), baseline.map(stripVTControlCharacters));
      assert.deepEqual(f.counts(), before, "rename/clear is not a usage or context invalidation");
      const warm = footerDiagnostics();
      for (let i = 0; i < 20; i++) assert.equal(f.render(), updated);
      f.statuses.set("extra", "EXTRA"); f.render(100); f.render(140); f.statuses.delete("extra");
      assert.equal(footerDiagnostics().aggregations, warm.aggregations);
      assert.equal(f.nameReads(), nameReads + 1, "warm/resize/status changes never search the name again");
    }
    f.manager.appendSessionInfo("Pending title one"); f.emit("session_info_changed", { name: "Pending title one" });
    f.manager.appendSessionInfo("Pending title two"); f.emit("session_info_changed", { name: "Pending title two" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Pending title two"));
    assert.deepEqual(f.counts(), before, "consecutive metadata-only appends do not rescan history");
    f.append(1, 2, 3, 4, 0); f.manager.appendSessionInfo("After real usage"); f.emit("session_info_changed", { name: "After real usage" });
    f.render(); assert.deepEqual(f.counts(), { scans: before.scans + 1, contextReads: before.contextReads + 1 }, "name must not hide an intervening usage append");
    f.manager.appendSessionInfo(""); f.emit("session_info_changed", { name: undefined });
    f.render(); f.statuses.delete("extra");
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("After real usage"));
    assert.notEqual(f.render(), baseline);
  } finally { f.close(); }
});

test("footer session name late older events cannot overwrite the current saved name", async () => {
  const f = await footerSetup();
  try {
    f.render(); const before = f.counts();
    f.manager.appendSessionInfo("Older title"); f.manager.appendSessionInfo("Current title");
    f.emit("session_info_changed", { name: "Current title" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Current title"));
    f.emit("session_info_changed", { name: "Older title" });
    const row = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(row.includes("Current title"), "concurrent async dispatch may deliver an older notification last");
    assert.ok(!row.includes("Older title")); assert.deepEqual(f.counts(), before);
    await f.control("off"); f.manager.newSession(); await f.emit("session_start", { reason: "new" });
    f.emit("session_info_changed", { name: "Older title" }); await f.control("on");
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("Older title"), "delayed notification must not rename a replacement session");
  } finally { f.close(); }
});

test("footer session name requests a fresh owned frame after delayed event delivery", async () => {
  const f = await footerSetup();
  try {
    const baseline = f.render(), before = f.counts();
    f.manager.appendSessionInfo("Delayed title");
    assert.equal(f.render(), baseline, "native repaint can run before an earlier async event handler releases");
    const requests = f.root.requests;
    f.emit("session_info_changed", { name: "Delayed title" });
    assert.equal(f.root.requests, requests + 1, "name delivery requests its own frame even after native repaint");
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Delayed title"));
    assert.deepEqual(f.counts(), before);
    const updated = f.render();
    f.emit("session_info_changed", { name: "Delayed title" });
    assert.equal(f.render(), updated, "duplicate metadata notice preserves the unchanged layout");
    await f.control("off"); const off = f.root.requests;
    f.manager.appendSessionInfo("Off title"); f.emit("session_info_changed", { name: "Off title" });
    assert.equal(f.root.requests, off, "released footer does not request a frame");
  } finally { f.close(); }
});

test("footer session name restores through off-on reload and new-session boundaries", async () => {
  const f = await footerSetup();
  try {
    f.manager.appendSessionInfo("Saved session title"); f.emit("session_info_changed", { name: "Saved session title" });
    const named = f.render().map(stripVTControlCharacters);
    await f.control("off"); await f.emit("session_start", { reason: "reload" });
    assert.equal(f.footer.children[0], f.native, "reload preserves the saved appearance-off preference");
    await f.control("on"); assert.deepEqual(f.render().map(stripVTControlCharacters), named);
    await f.emit("session_start", { reason: "reload" }); assert.deepEqual(f.render().map(stripVTControlCharacters), named);
    f.manager.newSession(); await f.emit("session_start", { reason: "new" });
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("Saved session title"));
    f.manager.appendSessionInfo("Restored session title"); await f.emit("session_start", { reason: "resume" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Restored session title"));
    const forkLeaf = f.manager.getLeafId()!;
    f.manager.appendSessionInfo("Later parent title"); f.emit("session_info_changed", { name: "Later parent title" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Later parent title"));
    f.manager.createBranchedSession(forkLeaf); await f.emit("session_start", { reason: "fork" });
    const forked = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(forked.includes("Restored session title")); assert.ok(!forked.includes("Later parent title"));
  } finally { f.close(); }
});

test("footer owns public slot until disposed and never erases a later foreign footer", async () => {
  const f = await footerSetup();
  try {
    assert.notEqual(f.footer.children[0], f.native);
    await f.control("off"); assert.equal(f.footer.children[0], f.native);
    await f.control("on"); assert.notEqual(f.footer.children[0], f.native);
    const foreign = { render: () => ["FOREIGN_FOOTER"], invalidate() {} };
    f.ctx.ui.setFooter(() => foreign); await f.control("off");
    assert.equal(f.footer.children[0], foreign); f.close(); assert.equal(f.footer.children[0], foreign);
  } finally { f.close(); }
});


test("footer context precision normalizes k and M carries with magnitude-dependent trailing zeros", async () => {
  const { contextTokens } = await import("../src/footer.ts");
  for (const [count, expected] of [[0, "0k"], [104500, "105k"], [999499, "999k"], [999500, "1.00M"],
    [1000000, "1.00M"], [1200000, "1.20M"], [1500000, "1.50M"], [9996000, "10.0M"],
    [10000000, "10.0M"], [12400000, "12.4M"], [99960000, "100M"], [100000000, "100M"], [123000000, "123M"], [1234000000, "1234M"]] as const) {
    assert.equal(contextTokens(count), expected, String(count));
  }
});

test("footer cumulative accounting matches actual native SDK including side tool summaries and abandoned history", async () => {
  const f = await footerSetup();
  const { footerUsage } = await import("../src/footer.ts");
  try {
    const usage = { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, totalTokens: 34,
      cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    f.manager.appendUsage("cache_warm", "probe", "probe", usage);
    f.manager.appendMessage({ role: "toolResult", toolCallId: "side", toolName: "side", content: [{ type: "text", text: "SIDE" }], isError: false, timestamp: 1, usage });
    f.manager.appendCompaction("summary", f.manager.getLeafId(), 100, undefined, true, usage);
    f.manager.branchWithSummary(null, "abandoned branch", undefined, true, usage);
    const total = footerUsage(f.manager.getEntries());
    const native = (f.native as any).getSessionStats(); // Actual SDK private accounting oracle, test-only.
    assert.deepEqual({ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, cost: total.cost }, native.usageTotals);
    assert.equal(total.cacheHitRate, native.latestCacheHitRate);
  } finally { f.close(); }
});

test("footer physical glyph colors CH displayed thresholds and raw native context warning thresholds", async () => {
  const { renderFooter } = await import("../src/footer.ts");
  const terminal = new xterm.Terminal({ cols: 180, rows: 4, allowProposedApi: true });
  const write = async (row: string) => { terminal.reset(); await new Promise<void>(resolve => terminal.write(row, resolve)); };
  const fg = (x: number) => { const c = terminal.buffer.active.getLine(0)!.getCell(x)!; return [c.getFgColorMode(), c.getFgColor()]; };
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const refs: Record<string, number[]> = {};
      for (const role of ["text", "muted", "dim", "success", "warning", "error"] as const) { await write(nativeTheme.fg(role, "X")); refs[role] = fg(0); }
      for (const [rate, chColor] of [[79.94, "error"], [79.96, "warning"], [80, "warning"], [94.94, "warning"], [94.96, "success"], [95, "success"], [100, "success"], [0, "error"]] as const) {
        for (const [percent, percentColor] of [[70, "muted"], [70.01, "warning"], [90, "warning"], [90.01, "error"], [105, "error"]] as const) {
          const data = { usage: { input: 11e6, output: 1.5e6, cacheRead: 243e6, cacheWrite: 12, cost: 61.761, cacheHitRate: rate, cacheHitHistory: [rate] },
            context: { tokens: 104500, contextWindow: 272000, percent }, auto: true, subscription: true };
          const row = renderFooter(180, data, [], nativeTheme)[0]!;
          const text = stripVTControlCharacters(row); await write(row);
          const expect = (value: string, role: string) => { const start = text.indexOf(value); assert.ok(start >= 0, value); for (let i = start; i < start + value.length; i++) assert.deepEqual(fg(i), refs[role], `${theme} ${value} ${i}`); };
          expect("105k", "text"); expect("272k", "muted"); expect("·".repeat(9), "muted");
          for (const value of ["/", "(", ")", "[", "]", " • "]) expect(value, "dim");
          const glyph = [..."▁▂▃▄▅▆▇█"][Math.round(7 * (1 - Number(rate.toFixed(1)) / 100))]!;
          expect(glyph, chColor);
          const ch = text.indexOf("CH"); for (let i = ch; i < ch + ("CH" + rate.toFixed(1) + "%").length; i++) assert.deepEqual(fg(i), refs[chColor]);
          const p = text.indexOf("(" + percent.toFixed(1) + "%)");
          for (let i = p + 1; i < p + 1 + (percent.toFixed(1) + "%").length; i++) assert.deepEqual(fg(i), refs[percentColor]);
        }
      }
    }
  } finally { terminal.dispose(); initTheme("dark"); }
});

test("footer preserves producer ANSI isolates attributes and links and never splits whole statuses", async () => {
  const { renderFooter } = await import("../src/footer.ts"); initTheme("dark");
  const data = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitHistory: [] }, auto: false, subscription: false };
  const terminal = new xterm.Terminal({ cols: 80, rows: 3, allowProposedApi: true });
  try {
    const producer = "\x1b[1;3;4;7;41;32mFIRST";
    const rows = renderFooter(80, data, [["a", producer], ["b", "NEXT"]], nativeTheme);
    assert.ok(rows[0]!.includes(producer));
    await new Promise<void>(resolve => terminal.write(rows[0]!, resolve));
    const text = stripVTControlCharacters(rows[0]!); const y = terminal.buffer.active.getLine(0)!;
    const first = text.indexOf("FIRST"), separator = text.indexOf("•", first + "FIRST".length);
    assert.equal(y.getCell(first)!.getBgColor(), 1);
    assert.ok(separator > first, "test the producer separator, not the earlier statistics bullet");
    await new Promise<void>(resolve => terminal.write("\r\n" + nativeTheme.fg("dim", "•"), resolve));
    const reference = terminal.buffer.active.getLine(1)!.getCell(0)!;
    const cell = y.getCell(separator)!;
    assert.equal(cell.getFgColorMode(), reference.getFgColorMode()); assert.equal(cell.getFgColor(), reference.getFgColor());
    for (const x of [separator, text.indexOf("NEXT", separator)]) {
      const cell = y.getCell(x)!; assert.ok(cell.isBgDefault());
      assert.ok(!cell.isBold() && !cell.isItalic() && !cell.isUnderline() && !cell.isInverse(), "producer attributes do not escape its boundary");
    }
    const status = "LINK\x1b]8;;https://example.test\x1b\\label";
    const links = renderFooter(80, data, [["a", status], ["b", "NEXT"]], nativeTheme);
    assert.ok(links[0]!.includes(status + "\x1b]8;;\x1b\\\x1b[0m"));
    const clean = renderFooter(80, data, [["a", "  \x1b[31m\x1b[0m  "], ["b", "LINE\nWITH\tTAB"], ["c", "LAST"]], nativeTheme);
    assert.ok(stripVTControlCharacters(clean[0]!).endsWith("LINE WITH TAB • LAST"));
    for (const width of [0, 1, 2, 3, 4, 5, 6, 24, 60, 100]) for (const row of renderFooter(width, data, [["a", "界é".repeat(60)]], nativeTheme)) assert.ok(visibleWidth(row) <= width);
  } finally { terminal.dispose(); }
});


test("footer missing context and unknown reports retain dots instead of invented zero", async () => {
  const f = await footerSetup();
  try {
    f.context(undefined); f.emit("session_compact");
    f.ctx.modelRegistry.getProvider = () => ({ auth: { oauth: { isSubscription: false } } });
    f.append(0, 0, 0, 0, 0);
    let text = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(!text.includes("272k")); assert.ok(!text.includes("(auto)"));
    assert.ok(text.includes("[········▁·] CH—")); assert.ok(!text.includes("(sub)"));
    f.append(10, 0, 0, 0, 0); text = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(text.includes("[·······▁·█] CH0.0%"), "real zero is a full error bar even without cache-read totals");
  } finally { f.close(); }
});


test("footer cache history retains ten distinct model reports even at the same percentage", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const manager = SessionManager.inMemory("/footer-history");
  const usage = { input: 900, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 1005,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 20; i++) manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "SAME_CH_" + i }],
    api: "openai-responses", provider: "probe", model: "probe", timestamp: i, stopReason: "toolUse", usage });
  const result = footerUsage(manager.getEntries());
  assert.deepEqual(result.cacheHitHistory, Array(10).fill(10));
  assert.equal(result.cacheHitRate, 10);
  const data = { usage: result, auto: true, subscription: false };
  assert.equal(stripVTControlCharacters(renderFooter(100, data, [], nativeTheme)[0]!), "[▇▇▇▇▇▇▇▇▇▇] CH10.0%");
  assert.equal(manager.getEntries().filter(e => e.type === "message").length, 20);
  for (let i = 0; i < 8; i++) assert.deepEqual(footerUsage(manager.getEntries()).cacheHitHistory, result.cacheHitHistory);
});

test("footer history orders evicts validates and counts reported errors without mixing side usage", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { footerUsage } = await import("../src/footer.ts");
  const manager = SessionManager.inMemory("/footer-history");
  const usage = (rate: number) => ({ input: 100 - rate, output: 0, cacheRead: rate, cacheWrite: 0, totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  for (let i = 0; i < 12; i++) manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe",
    model: "probe", timestamp: i, stopReason: i === 11 ? "error" : "stop", usage: usage(i * 5) });
  let reports = footerUsage(manager.getEntries()); assert.deepEqual(reports.cacheHitHistory, [10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(rate => rate / 100 * 100));
  manager.appendUsage("cache_warm", "probe", "probe", usage(100));
  manager.appendMessage({ role: "toolResult", toolCallId: "side", toolName: "side", content: [], timestamp: 15, isError: false, usage: usage(100) });
  manager.appendCompaction("summary", manager.getLeafId(), 100, undefined, true, usage(100));
  assert.deepEqual(footerUsage(manager.getEntries()).cacheHitHistory, reports.cacheHitHistory);
  for (const invalid of [usage(NaN), usage(-1), { ...usage(0), input: 0 }, { ...usage(0), input: Infinity }]) {
    manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe", model: "probe",
      timestamp: 16, stopReason: "aborted", usage: invalid });
    reports = footerUsage(manager.getEntries()); assert.equal(reports.cacheHitHistory.at(-1), undefined); assert.equal(reports.cacheHitRate, undefined);
  }
  manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe", model: "probe", timestamp: 17,
    stopReason: "stop", usage: { ...usage(50), input: 25, cacheWrite: 25 } });
  assert.equal(footerUsage(manager.getEntries()).cacheHitRate, 50, "cache writes belong to the prompt denominator");
  assert.equal(footerUsage(manager.getEntries()).cacheHitHistory.length, 10);
});

test("footer fields are source flags defaulting false with retained independent native formatting", async () => {
  const { FOOTER_FIELDS, renderFooter } = await import("../src/footer.ts");
  assert.deepEqual(FOOTER_FIELDS, { tokenTotals: false, cacheTotals: false, cost: false });
  const data = { usage: { input: 11e6, output: 1.5e6, cacheRead: 243e6, cacheWrite: 12, cost: 61.761,
    cacheHitRate: 95, cacheHitHistory: [95] }, auto: true, subscription: true };
  for (const tokenTotals of [false, true]) for (const cacheTotals of [false, true]) for (const cost of [false, true]) {
    const row = stripVTControlCharacters(renderFooter(200, data, [], nativeTheme, { tokenTotals, cacheTotals, cost })[0]!);
    assert.equal(row.includes("↑11M ↓1.5M"), tokenTotals);
    assert.equal(row.includes("R243M W12"), cacheTotals);
    assert.equal(row.includes("$61.761 (sub)"), cost);
    assert.ok(row.includes("[·········▁] CH95.0%"), "CH never depends on cumulative field flags");
  }
});

test("footer cost flag retains native OAuth subscription rules without hidden auth reads", async () => {
  const { FOOTER_FIELDS } = await import("../src/footer.ts");
  FOOTER_FIELDS.cost = true;
  let f: Awaited<ReturnType<typeof footerSetup>> | undefined;
  try {
    f = await footerSetup(); assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("$61.761 (sub)")); assert.ok(f.authReads() > 0);
    f.ctx.modelRegistry.getProvider = () => ({ auth: { oauth: { isSubscription: false } } });
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("(sub)"), "OAuth alone is not subscription");
    f.ctx.model.provider = "kimi-coding"; f.subscription(false);
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("(sub)"), "native Kimi exception remains available behind flag");
  } finally { f?.close(); FOOTER_FIELDS.cost = false; }
});

test("footer empty cold unknown and auto-off states are distinct and fit exactly one statistics row", async () => {
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const empty = { usage: footerUsage([]), context: { tokens: 104000, contextWindow: 272000, percent: 38.1 }, auto: true, subscription: false };
  const text = stripVTControlCharacters(renderFooter(100, empty, [], nativeTheme)[0]!);
  assert.equal(text, "[··········] CH— • 104k/272k (38.1%)");
  const disabled = { ...empty, auto: false };
  assert.equal(stripVTControlCharacters(renderFooter(100, disabled, [], nativeTheme)[0]!), "[··········] CH— • 104k/272k (38.1%) (auto off)");
  const unknown = { ...disabled, context: { tokens: null, contextWindow: 272000, percent: null } };
  assert.equal(stripVTControlCharacters(renderFooter(100, unknown, [], nativeTheme)[0]!), "[··········] CH— • ?/272k (auto off)");
  assert.equal(stripVTControlCharacters(renderFooter(100, { ...empty, context: undefined }, [], nativeTheme)[0]!), "[··········] CH—");
  assert.equal(stripVTControlCharacters(renderFooter(100, { ...disabled, context: undefined }, [], nativeTheme)[0]!), "[··········] CH— • (auto off)");
  const sample = { ...empty, context: { tokens: 130000, contextWindow: 272000, percent: 47.9 },
    usage: { ...empty.usage, cacheHitRate: 98.2, cacheHitHistory: Array(10).fill(98.2) } };
  assert.equal(stripVTControlCharacters(renderFooter(100, sample, [], nativeTheme)[0]!), "[▁▁▁▁▁▁▁▁▁▁] CH98.2% • 130k/272k (47.9%)");
  for (const width of [0, 1, 2, 3, 6, 11, 12, 20, 24, visibleWidth(text) - 1, visibleWidth(text), 100]) {
    const rows = renderFooter(width, empty, [], nativeTheme);
    assert.equal(rows.length, width ? 1 : 0, "statistics never wrap internally");
    if (!width) continue;
    assert.ok(visibleWidth(rows[0]!) <= width);
    assert.equal(stripVTControlCharacters(rows[0]!).endsWith("…"), width < visibleWidth(text));
    assert.deepEqual(empty.usage.cacheHitHistory, [], "clipping must not change saved numeric reports");
  }
});

test("footer auto-off annotation unknown marks and bracket colors remain semantic in both themes", async () => {
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const terminal = new xterm.Terminal({ cols: 120, rows: 2, allowProposedApi: true });
  const write = async (row: string) => { terminal.reset(); await new Promise<void>(resolve => terminal.write(row, resolve)); };
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const refs: Record<string, number> = {};
      for (const role of ["dim", "muted", "warning"] as const) { await write(nativeTheme.fg(role, "X")); refs[role] = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(); }
      const row = renderFooter(120, { usage: footerUsage([]), auto: false, subscription: false }, [], nativeTheme)[0]!;
      await write(row); const text = stripVTControlCharacters(row);
      for (const [value, role] of [["(", "dim"], [")", "dim"], ["auto off", "warning"], ["[", "dim"], ["]", "dim"], ["·".repeat(10), "muted"], ["CH—", "muted"], [" • ", "dim"]]) {
        const x = text.indexOf(value!); assert.ok(x >= 0);
        for (let i = x; i < x + value!.length; i++) assert.equal(terminal.buffer.active.getLine(0)!.getCell(i)!.getFgColor(), refs[role!]);
      }
    }
  } finally { terminal.dispose(); initTheme("dark"); }
});

test("footer report updates reconstruct across off-on without counting streaming or warm renders", async () => {
  const f = await footerSetup();
  try {
    const first = f.render(), leaf = f.manager.getLeafEntry();
    assert.ok(leaf?.type === 'message' && leaf.message.role === 'assistant');
    const message = leaf.message;
    f.emit("message_update", { type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'FOOTER_USAGE', partial: message } });
    assert.equal(f.render(), first);
    const before = f.counts();
    for (let i = 0; i < 20; i++) { f.append(900, 10, 100, 0, 0); f.emit("message_end"); f.render(); }
    let row = f.render().map(stripVTControlCharacters).join(" "); assert.ok(row.includes("[▇▇▇▇▇▇▇▇▇▇] CH10.0%"));
    assert.deepEqual(f.counts(), { scans: before.scans + 20, contextReads: before.contextReads + 20 });
    const hot = f.counts(); for (let i = 0; i < 20; i++) f.render(); assert.deepEqual(f.counts(), hot);
    await f.control("off"); await f.control("on");
    assert.equal(f.render().map(stripVTControlCharacters).join(" "), row, "history is derived from saved reports, not render timing");
  } finally { f.close(); }
});

test("footer stays native when the editor is foreign from startup including explicit on", async () => {
  const f = await footerSetup(true);
  try {
    assert.equal(f.footer.children[0], f.native);
    f.root.render(100); await Promise.resolve();
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
    await f.control("off"); assert.equal(f.footer.children[0], f.native);
  } finally { f.close(); }
});

test("footer restores native after late editor takeover and on only installs with eligible editor", async () => {
  const f = await footerSetup();
  try {
    const first = f.footer.children[0]; assert.notEqual(first, f.native);
    f.ctx.ui.setEditorComponent(footerForeignEditor);
    f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "same-name public factory disables our footer too");
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
    f.ctx.ui.setEditorComponent(undefined); f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "returning input never automatically reclaims a possibly foreign footer");
    await f.control("on");
    assert.notEqual(f.footer.children[0], f.native); assert.notEqual(f.footer.children[0], first);
    f.input.clear(); f.input.addChild({ render: () => ["NATIVE_SELECTOR"], invalidate() {} });
    f.root.render(100); await Promise.resolve();
    assert.notEqual(f.footer.children[0], f.native, "temporary native selector is not editor-feature disablement");
    f.input.clear(); f.input.addChild(f.editor);
  } finally { f.close(); }
});

test("footer editor loss preserves later foreign footer and overridden stock editor guard", async () => {
  const f = await footerSetup();
  try {
    const foreign = { render: () => ["FOREIGN_FOOTER"], invalidate() {} };
    f.ctx.ui.setFooter(() => foreign);
    f.ctx.ui.setEditorComponent(footerForeignEditor);
    f.root.render(100); await Promise.resolve();
    await f.control("on"); assert.equal(f.footer.children[0], foreign, "disabled input cannot reclaim a foreign footer");
    f.ctx.ui.setEditorComponent(undefined); await f.control("on");
    assert.notEqual(f.footer.children[0], foreign);
    Object.defineProperty(f.editor, "render", { configurable: true, value: () => ["FOREIGN_INSTANCE_RENDER"] });
    f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "method ownership guard and footer share eligibility");
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
  } finally { Reflect.deleteProperty(f.editor, "render"); f.close(); }
});


test("footer deferred startup handles native reload box without stealing a later footer", async () => {
  for (const replacement of [false, true]) {
    const f = await footerSetup(false, true);
    try {
      assert.equal(f.footer.children[0], f.native);
      const foreign = { render: () => ["LATER_STARTUP_FOOTER"], invalidate() {} };
      if (replacement) f.ctx.ui.setFooter(() => foreign);
      f.input.clear(); f.input.addChild(f.editor);
      f.root.render(100); await Promise.resolve();
      if (replacement) assert.equal(f.footer.children[0], foreign, "delayed initial install verifies the exact previous footer owner");
      else assert.notEqual(f.footer.children[0], f.native, "default input returning after session_start finishes initial installation");
    } finally { f.close(); }
  }
});


test("Output padding sets transcript frame margins at both native values and keeps tiny bodies", () => {
  for (const padding of [0, 1]) for (const width of [0, 1, 2, 3, 4, 5, 6, 24, 80]) {
    const geometry = cardGeometry(width, padding);
    if (width >= 6) {
      assert.equal(geometry.marginLeft, padding); assert.equal(geometry.marginRight, padding);
      assert.equal(geometry.contentX, padding + 2); assert.equal(geometry.contentWidth, width - 2 * padding - 3);
      assert.equal(geometry.paddingLeft, 1); assert.equal(geometry.paddingRight, 1);
    }
    const rows = frameRows(geometry, width ? ["x"] : [], { panel: text => text, border: text => text });
    assert.ok(rows.every(row => visibleWidth(row) === width));
    if (width) assert.ok(geometry.contentWidth >= 1);
  }
});

test("Output padding updates every tool layout cache, inline measurement and panel clicks live", () => {
  let padding = 1, settingsReads = 0;
  const compact = new Tool("tidy_ui_padding", { query: "PAD_" + "x".repeat(100) });
  const bash = bashTool(); bash.result = { content: [{ type: "text", text: Array(11).fill("BASH_PAD").join("\n") }] };
  const edit = new Tool("edit", { path: "padding.ts" }); edit.result = { content: [], details: { diff: "-1 const before = 1;\n+1 const after = 2;" } };
  const write = new Tool("write", { path: "padding.ts", content: "const written = 3;\n" });
  const inline = new Tool("edit", { path: "inline-" + "x".repeat(90) + ".ts" }); inline.result = { content: [] };
  const { root, controller } = setup([compact, bash, edit, write, inline], { outputPad: () => { settingsReads++; return padding; } });
  try {
    for (const value of [1, 0, 1]) {
      padding = value; settingsReads = 0; root.render(24);
      assert.equal(settingsReads, 1, "one effective-settings snapshot per document pass, not per tool/neighbor");
      const cold = controller.cacheStats().builds;
      for (const node of [compact, bash, edit, write, inline]) {
        const rows = node.render(24).filter(row => row !== "").map(plain);
        assert.ok(rows.every(row => visibleWidth(row) <= 24 - (node === compact ? padding : 0)));
        assert.equal(rows[0]!.search(/\S/u), padding + (node === inline ? 2 : 0));
        if ([bash, edit, write].includes(node)) {
          assert.ok(rows.every(row => row[padding] === "┃"));
          assert.ok(rows.every(row => row[padding + 1] === " " && row[23 - padding] === " "));
        }
      }
      root.render(24); assert.equal(controller.cacheStats().builds, cold, "unchanged padding is a hot cache hit");
      assert.equal(controller.cacheStats().entries, 5, "one latest layout per tool, no padding-history cache");
      assert.equal(measureFileCard(inline, "/project", 24, padding)!.height, inline.render(24).filter(row => row !== "").length);
      for (const node of [bash, edit, write]) {
        if (padding) for (const x of [0, 23]) assert.equal(node.handleMouse({ ...mouse(1, 24), x }), undefined);
        assert.equal(node.handleMouse({ ...mouse(1, 24), x: padding })?.handled, true, "current stripe is clickable");
        node.setExpanded(false);
      }
    }
    assert.equal(controller.active, true);
  } finally { controller.restore(); }
});

test("Output padding user cards use live native padding without altering Markdown or editor geometry", () => {
  initTheme("dark", false);
  const user = new UserMessageComponent("USER_PADDING **bold** 文字\n\n" + "x".repeat(70));
  const root = new Root(); root.addChild(user);
  const render = UserMessageComponent.prototype.render;
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    for (const padding of [1, 0, 1]) {
      user.setOutputPad(padding);
      const geometry = cardGeometry(24, padding), rows = user.render(24);
      assert.ok(rows.every(row => stripVTControlCharacters(row)[padding] === "┃"));
      const native = render.call(user, geometry.contentWidth + 2 * padding).slice(1, -1);
      assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding + 2, geometry.contentWidth))),
        native.map(row => stripVTControlCharacters(sliceByColumn(row, padding, visibleWidth(row) - 2 * padding))));
      const builds = controller.cacheStats().builds; user.render(24); assert.equal(controller.cacheStats().builds, builds);
      assert.equal(controller.cacheStats().entries, 1);
      assert.equal(editorGeometry(24, 3)!.panelX, 3, "Editor padding is separate");
    }
  } finally { controller.restore(); }
});

test("Output padding summary glyphs, animation and wrapped text share the new origin at narrow widths", () => {
  for (const padding of [0, 1]) {
    const node = new Tool("read", { path: "a/" + "x".repeat(90) });
    const { controller } = setup([node], { outputPad: () => padding });
    try {
      for (const width of [1, 2, 3, 4, 5, 6, 24, 80]) {
        const rows = node.render(width).map(plain);
        assert.ok(rows.every(row => visibleWidth(row) <= Math.max(1, width - padding)));
        if (width >= 6) {
          assert.equal(rows[0]![padding], "→");
          assert.ok(rows[0]!.slice(padding + 2).startsWith("read".slice(0, width - 2 * padding - 2)));
          assert.ok(rows.slice(1).every(row => row.startsWith(" ".repeat(padding + 2))));
        }
        node.updateResult(undefined);
        const running = node.render(width).map(plain);
        assert.ok(running.every(row => visibleWidth(row) <= Math.max(1, width - padding)));
        const x = Math.min(padding, Math.max(0, width - 1 - padding));
        assert.ok(spinnerFrames.includes(running[0]![x]!));
        node.updateResult({ content: [] });
      }
    } finally { controller.restore(); }
  }
});


test("Output padding effective settings remain authoritative when native user padding diverges", () => {
  initTheme("dark", false);
  let padding = 0;
  const user = new UserMessageComponent("PROJECT_PADDING **bold** " + "x".repeat(70));
  const compact = new Tool("read", { path: "project.txt" }), root = new Root(); root.addChild(user); root.addChild(compact);
  const render = UserMessageComponent.prototype.render;
  const controller = installTidyUi(root, () => nativeTheme, { outputPad: () => padding });
  try {
    // Pi's onOutputPadChange assigns the selected value to user messages even when
    // a project override leaves public effective settings at zero.
    user.setOutputPad(1);
    for (const value of [0, 1, 0]) {
      padding = value; root.render(24);
      const rows = user.render(24).filter(row => row !== ""), geometry = cardGeometry(24, padding);
      assert.ok(rows.every(row => stripVTControlCharacters(row)[padding] === "┃"));
      const native = render.call(user, geometry.contentWidth + 2).slice(1, -1);
      assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, geometry.contentX, geometry.contentWidth))),
        native.map(row => stripVTControlCharacters(sliceByColumn(row, 1, visibleWidth(row) - 2))));
      assert.equal(plain(compact.render(24).find(row => row !== "")!)[padding], "→");
      const builds = controller.cacheStats().builds; root.render(24); assert.equal(controller.cacheStats().builds, builds);
      assert.equal((user as unknown as { outputPad: number }).outputPad, 1, "do not mutate native padding to reconcile settings");
    }
  } finally { controller.restore(); }
});


test("terminal defaults resolve independent explicit values, own vars, zero, BOM and SDK color forms", () => {
  assert.deepEqual(resolveTerminalDefaults({ colors: { text: "ink" }, export: { pageBg: "surface" }, vars: { ink: "#abc", surface: "next", next: 0 } }),
    { foreground: "#aabbcc", background: colorToHex(parseColor(0)) });
  for (const value of ["#0af", "#00aaff", "oklch(62% 0.1 200)", "okhsl(250 60% 55%)", 255])
    assert.deepEqual(resolveTerminalDefaults({ colors: { text: value }, export: { pageBg: value } }),
      { foreground: colorToHex(parseColor(value)), background: colorToHex(parseColor(value)) });
  assert.deepEqual(parseThemeDefaults('\uFEFF{"colors":{"text":""},"export":{"pageBg":""}}'), { foreground: undefined, background: undefined });
  assert.deepEqual(resolveTerminalDefaults({ colors: {} }), { foreground: undefined, background: undefined });
  for (const vars of [{ a: "a" }, { a: "b", b: "a" }, Object.create({ a: "#fff" })])
    assert.throws(() => resolveTerminalDefaults({ vars, colors: { text: "a" } }));
  for (const value of [-1, 256, 1.5, null, {}, "#ggg", "unknown", "\x1b]11;#fff\x07"])
    assert.throws(() => resolveTerminalDefaults({ colors: { text: value } }));
  assert.throws(() => parseThemeDefaults("broken"));
});

function terminalColorFixture(query?: ConstructorParameters<typeof TerminalColors>[0]["query"]) {
  const theme = {
    name: "fixture", sourcePath: "/fixture.json", fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text, style: (text: string) => text,
    colors: { toolPendingBg: rgbColor(10, 11, 12), userMessageBg: rgbColor(10, 11, 12), toolDiffAdded: rgbColor(0, 255, 0), text: rgbColor(229, 229, 231) },
    getFgAnsi: (role: string): string => role === "text" ? "\x1b[39m" : "\x1b[38;2;0;255;0m",
    getBgAnsi: (_role: string): string => "\x1b[49m",
  };
  const snapshot = { enabled: true, automatic: false as boolean | undefined, configured: "fixture" as string | undefined, theme };
  let content = '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}';
  const packets: string[] = [], warnings: string[] = [];
  let reads = 0, changes = 0;
  const view = new TerminalColors({ snapshot: () => snapshot, source: () => undefined, query,
    read(path) { assert.equal(path, "/fixture.json"); reads++; return content; },
    write: data => { packets.push(data); }, warn: message => { warnings.push(message); }, changed: () => { changes++; } });
  return { view, snapshot, packets, warnings, get reads() { return reads; }, get changes() { return changes; }, setContent(value: string) { content = value; } };
}
const terminalMicrotasks = async () => { await new Promise<void>(done => setImmediate(done)); };

test("terminal defaults controller applies once, preserves native theme, and performs zero warm work", async () => {
  const fixture = terminalColorFixture(), original = fixture.snapshot.theme.colors;
  fixture.view.observe(); await terminalMicrotasks();
  assert.deepEqual(fixture.packets, ["\x1b]11;#123456\x07\x1b]10;#eeeeee\x07"]);
  assert.equal(fixture.reads, 1);
  const palette = fixture.view.palette(fixture.snapshot.theme);
  assert.equal(colorToHex(palette.colors!.toolPendingBg!), "#123456");
  assert.equal(colorToHex(palette.colors!.userMessageBg!), "#123456");
  assert.equal(colorToHex(palette.colors!.text!), "#eeeeee");
  assert.equal(palette.colors!.toolDiffAdded, original.toolDiffAdded);
  assert.equal(fixture.snapshot.theme.colors, original); assert.equal(colorToHex(original.toolPendingBg), "#0a0b0c");
  const counters = fixture.view.stats();
  for (let i = 0; i < 80; i++) { fixture.view.observe(); assert.equal(fixture.view.palette(fixture.snapshot.theme), palette); }
  await terminalMicrotasks(); assert.deepEqual(fixture.view.stats(), counters); assert.equal(fixture.reads, 1);
  fixture.view.dispose(); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
  fixture.view.dispose(); assert.equal(fixture.packets.length, 2);
});

test("terminal defaults auto/unknown guard releases synchronously and rejects queued work", async () => {
  for (const mode of [true, undefined]) {
    const fixture = terminalColorFixture(); fixture.view.observe(); await terminalMicrotasks();
    fixture.snapshot.automatic = mode; fixture.view.observe();
    assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07", "release must happen before the caller's native query");
    assert.equal(fixture.view.palette(fixture.snapshot.theme), fixture.snapshot.theme);
    await terminalMicrotasks(); assert.equal(fixture.reads, 1); assert.equal(fixture.packets.length, 2);
    fixture.view.dispose();
    const pending = terminalColorFixture(); pending.view.observe(); pending.snapshot.automatic = mode; pending.view.observe();
    await terminalMicrotasks(); assert.equal(pending.reads, 0); assert.deepEqual(pending.packets, []); pending.view.dispose();
  }
  const configured = terminalColorFixture(); configured.snapshot.configured = " light / dark "; configured.view.observe();
  await terminalMicrotasks(); assert.equal(configured.reads, 0); assert.deepEqual(configured.packets, []); configured.view.dispose();
});

test("terminal defaults missing channels release only owned channels; source errors keep the whole last-good snapshot", async () => {
  const fixture = terminalColorFixture(); fixture.view.observe(); await terminalMicrotasks();
  fixture.setContent('{"colors":{"text":"missing-var"},"export":{"pageBg":"#ffffff"}}');
  fixture.view.observe(true); await terminalMicrotasks();
  assert.equal(fixture.packets.length, 1, "partially valid metadata cannot partially publish");
  assert.equal(fixture.warnings.length, 1);
  fixture.view.observe(true); await terminalMicrotasks(); assert.equal(fixture.warnings.length, 1);
  assert.equal(colorToHex(fixture.view.palette(fixture.snapshot.theme).colors!.toolPendingBg!), "#123456");
  fixture.setContent('{"colors":{"text":""},"export":{"pageBg":"#123456"}}');
  fixture.view.observe(true); await terminalMicrotasks(); assert.equal(fixture.packets.at(-1), "\x1b]110\x07");
  fixture.setContent('{"colors":{"text":""}}'); fixture.view.observe(true); await terminalMicrotasks();
  assert.equal(fixture.packets.at(-1), "\x1b]111\x07");
  fixture.view.dispose(); assert.equal(fixture.packets.length, 3);
  const empty = terminalColorFixture(); empty.setContent('{"colors":{"text":""}}'); empty.view.observe(); await terminalMicrotasks(); empty.view.dispose();
  assert.deepEqual(empty.packets, []);
});

test("terminal defaults disabled/no-source/programmatic states have no guessed metadata or writes", async () => {
  const fixture = terminalColorFixture(); fixture.snapshot.enabled = false; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.reads, 0); assert.deepEqual(fixture.packets, []);
  fixture.snapshot.enabled = true; fixture.snapshot.theme.sourcePath = ""; fixture.snapshot.theme.name = "";
  fixture.view.observe(); await terminalMicrotasks(); assert.equal(fixture.reads, 0); assert.deepEqual(fixture.packets, []); fixture.view.dispose();
});

test("terminal defaults stale unowned-default reports cannot repaint after auto, disable or disposal", async () => {
  for (const transition of ["auto", "disable", "dispose"]) {
    const fixture = terminalColorFixture(); fixture.setContent('{"colors":{"text":""},"export":{"pageBg":"#123456"}}');
    let complete!: (value: { foreground: { r: number; g: number; b: number } }) => void;
    const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => undefined,
      read: () => '{"colors":{"text":""},"export":{"pageBg":"#123456"}}', write: data => { fixture.packets.push(data); },
      query: () => new Promise(resolve => { complete = resolve; }) });
    view.observe(); await terminalMicrotasks(); assert.equal(typeof complete, "function");
    if (transition === "auto") fixture.snapshot.automatic = true;
    else if (transition === "disable") fixture.snapshot.enabled = false;
    else view.dispose();
    view.observe(); const packets = [...fixture.packets];
    complete({ foreground: { r: 255, g: 0, b: 0 } }); await terminalMicrotasks();
    assert.deepEqual(fixture.packets, packets); assert.equal(view.palette(fixture.snapshot.theme), fixture.snapshot.theme); view.dispose(); fixture.view.dispose();
  }
});


test("terminal appearance SDK contract preserves native methods and flags, follows a live renderer proxy, and rejects drift", () => {
  const noop = () => {};
  const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false, start: noop, stop: noop,
    drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
    clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
  const roots = [new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false)];
  let current = roots[0]!;
  const reference = new Proxy({}, { get: (_target, key) => Reflect.get(current, key, current),
    set() { throw new Error("Appearance observation is read-only"); }, defineProperty() { throw new Error("No receiver probe"); } });
  for (const root of roots) {
    current = root;
    const notify = root.setTerminalColorSchemeNotifications, query = root.queryTerminalColors;
    assert.equal(terminalAppearanceTracking(reference), false, "supported SDK has an initialized boolean, not an absent/falsy guess");
    root.setTerminalColorSchemeNotifications(true); assert.equal(terminalAppearanceTracking(reference), true);
    root.setTerminalColorSchemeNotifications(false); assert.equal(terminalAppearanceTracking(reference), false);
    assert.equal(root.setTerminalColorSchemeNotifications, notify); assert.equal(root.queryTerminalColors, query);
  }
  for (const value of [undefined, null, 0, 1, "false", "true", {}, () => false])
    assert.equal(terminalAppearanceTracking({ terminalColorSchemeNotificationsEnabled: value }), undefined);
  assert.equal(terminalAppearanceTracking(new Proxy({}, { get() { throw new Error("future host"); } })), undefined);
});

test("terminal defaults menu honors local/master lifetime without stacking exit listeners", async () => {
  const h = extensionHarness(), fixture = terminalColorFixture();
  const directory = mkdtempSync(join(tmpdir(), "tidy-ui-colors-")), path = join(directory, "theme.json");
  writeFileSync(path, '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
  fixture.snapshot.theme.sourcePath = path;
  Object.assign(h.ctx.ui, { theme: fixture.snapshot.theme });
  Object.assign(h.root, { terminal: { write(data: string) { fixture.packets.push(data); } } });
  const listeners = process.listenerCount("exit"), nativeToolRender = Tool.prototype.render;
  try {
    await h.events.get("session_start")!({}, h.ctx); await terminalMicrotasks();
    assert.equal(fixture.packets.length, 1); assert.equal(process.listenerCount("exit"), listeners + 1);
    await h.events.get("session_start")!({}, h.ctx); await terminalMicrotasks();
    assert.equal(fixture.packets.length, 1); assert.equal(process.listenerCount("exit"), listeners + 1);
    const command = h.commands.get('tidy-ui')!.handler;
    const control = (operation: string) => operation === 'colors on' || operation === 'colors off'
      ? setColors(command, h.ctx, operation === 'colors on') : operation === 'on' || operation === 'off'
      ? setAppearance(command, h.ctx, operation === 'on') : command(operation, h.ctx);
    await control("colors off"); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
    assert.equal(process.listenerCount("exit"), listeners); assert.notEqual(Tool.prototype.render, nativeToolRender);
    await control("off"); await control("on"); await terminalMicrotasks(); assert.equal(fixture.packets.length, 2, "master on preserves the local off choice");
    await control("colors on"); await terminalMicrotasks(); assert.equal(fixture.packets.length, 3);
    h.root.terminalColorSchemeNotificationsEnabled = true;
    const observer = h.widgetComponents.get("pi-tidy-ui-terminal-colors")!;
    observer.render(80); assert.equal(fixture.packets.length, 4); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
    assert.match(await menuPage(command, h.ctx, ['Status & troubleshooting']), /automatic/u);
    await control("colors invalid"); assert.match(h.notices.at(-1)!, /Usage/u);
    assert.deepEqual(observer.render(80), []);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); fixture.view.dispose(); rmSync(directory, { recursive: true, force: true }); }
  assert.equal(process.listenerCount("exit"), listeners);
});


test("terminal defaults partial late reports preserve previously reported channels within the same generation", async () => {
  const fixture = terminalColorFixture();
  let late!: (colors: { background?: { r: number; g: number; b: number } }) => void;
  const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => undefined,
    read: () => '{"colors":{"text":""}}', write: data => fixture.packets.push(data),
    query: async callback => { late = callback; return { foreground: { r: 17, g: 17, b: 17 } }; } });
  try {
    view.observe(); await terminalMicrotasks();
    assert.equal(colorToHex(view.palette(fixture.snapshot.theme).colors!.text!), "#111111");
    late({ background: { r: 34, g: 34, b: 34 } });
    const palette = view.palette(fixture.snapshot.theme);
    assert.equal(colorToHex(palette.colors!.text!), "#111111");
    assert.equal(colorToHex(palette.colors!.userMessageBg!), "#222222");
    assert.deepEqual(fixture.packets, []);
  } finally { view.dispose(); fixture.view.dispose(); }
});

test("terminal defaults SGR classification ignores 39/49/2 inside RGB and indexed colors", async () => {
  const fixture = terminalColorFixture();
  fixture.snapshot.theme.getFgAnsi = () => "\x1b[38;5;39m";
  fixture.snapshot.theme.getBgAnsi = () => "\x1b[48;2;2;39;49m";
  fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.palette(fixture.snapshot.theme), fixture.snapshot.theme);
  assert.deepEqual(fixture.view.stats().reports, 0); fixture.view.dispose();
  assert.deepEqual(resolveTerminalDefaults({ vars: { "#abc": "#000" }, colors: { text: "#abc" } }), { foreground: "#aabbcc", background: undefined });
});


test("terminal defaults retain known source identity on same-revision registry disappearance and diagnose read failure", async () => {
  const fixture = terminalColorFixture(); fixture.snapshot.theme.sourcePath = "";
  let listed = true, missing = false, reads = 0;
  const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => listed ? "/fixture.json" : undefined,
    read() { reads++; if (missing) throw new Error("ENOENT fixture.json"); return '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}'; },
    write: data => fixture.packets.push(data), warn: message => fixture.warnings.push(message) });
  try {
    view.observe(); await terminalMicrotasks(); listed = false; missing = true;
    view.observe(true); await terminalMicrotasks();
    assert.equal(reads, 2); assert.equal(fixture.packets.length, 1); assert.equal(fixture.warnings.length, 1);
    fixture.snapshot.theme.name = "new-generated-source"; view.observe(); await terminalMicrotasks();
    assert.equal(reads, 2); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
  } finally { view.dispose(); fixture.view.dispose(); }
});


test("terminal defaults local off keeps presentation RGB fresh without applying targets or reading metadata", async () => {
  const fixture = terminalColorFixture(async () => ({ background: { r: 17, g: 34, b: 51 } }));
  fixture.snapshot.theme.colors = { ...fixture.snapshot.theme.colors, userMessageBg: rgbColor(18, 52, 86) };
  Object.assign(fixture.snapshot, { presenting: true });
  fixture.view.observe(); await terminalMicrotasks();
  fixture.snapshot.enabled = false; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.status().state, "off"); assert.equal(fixture.view.stats().sourceReads, 1);
  const palette = fixture.view.palette(fixture.snapshot.theme);
  assert.equal(colorToHex(palette.colors!.userMessageBg!), "#112233");
  const after = fixture.view.stats();
  for (let frame = 0; frame < 50; frame++) { fixture.view.observe(); fixture.view.palette(fixture.snapshot.theme); }
  assert.deepEqual(fixture.view.stats(), after); assert.equal(after.reports, 1);
  fixture.snapshot.enabled = true; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.status().state, "on"); assert.equal(fixture.view.stats().sourceReads, 2);
  fixture.view.dispose();
});

test('Git diagnostics: expected absent reftable is quiet while refresh and watch rebinding remain intact', async () => {
  const { GitBranchSource, gitDiagnostics } = await import('../src/git-branch.ts');
  const before = gitDiagnostics();
  const cwd = mkdtempSync(join(tmpdir(), 'tidy-ui-git-diagnostics-')), records: { explanation: string; fields: unknown }[] = [];
  const source = new GitBranchSource(() => {}, { diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
  try {
    assert.equal(spawnSync('git', ['-C', cwd, 'init', '-b', 'first']).status, 0);
    source.setDirectory(cwd); await awaitFixture(source.settled());
    for (let i = 0; i < 3; i++) { source.refresh(true); await awaitFixture(source.settled()); }
    assert.equal(records.filter(record => record.explanation.includes('watch unavailable')).length, 0);
    assert.equal(records.filter(record => record.explanation === 'Asynchronous Git refresh started').length, 4);
    assert.equal(gitDiagnostics().discoveries, before.discoveries + 4);
    assert.equal(gitDiagnostics().watchers, before.watchers + 2); assert.equal(source.branch(cwd), 'first');
  } finally { source.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

function cacheMenuStats(text: string) {
  const byKind = Object.fromEntries(LAYOUT_KINDS.map(kind => {
    const json = text.split('\n').find(row => row.startsWith(`${kind}: `))?.slice(kind.length + 2);
    assert.ok(json, `missing ${kind} visible cache detail`); return [kind, JSON.parse(json)];
  }));
  const footer = JSON.parse(text.split('\n').find(row => row.startsWith('Footer: '))!.slice(8));
  const presentationEntries = Number(/Saved layouts: (\d+)/u.exec(text)![1]);
  const presentationRetainedBytes = Number(/Estimated retained memory: (\d+)/u.exec(text)![1]);
  return { byKind, entries: presentationEntries - footer.entries, retainedBytes: presentationRetainedBytes - footer.retainedBytes,
    stringBytes: Object.values(byKind).reduce((sum, value) => sum + value.stringBytes, 0),
    overheadBytes: Object.values(byKind).reduce((sum, value) => sum + value.overheadBytes, 0),
    presentationRetainedBytes, footerLayout: footer, processHeapUsedBytes: Number(/Whole Pi process heap: (\d+)/u.exec(text)![1]),
    ordinary: { entries: byKind.summary.entries }, cards: { entries: byKind.bash.entries + byKind.edit.entries + byKind.write.entries } };
}
