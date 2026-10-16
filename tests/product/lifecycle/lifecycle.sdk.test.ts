import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { parseColor, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { CardTheme } from "../../../src/card-theme.ts";
import { setAppearance } from "../../helpers/menu-driver.ts";
import { Container, Root, Text, Tool, bashTool, color, extensionHarness, installTidyUi, mouse, plain, setup, type TuiMouseEvent } from "../../fixtures/sdk-contract-support.ts";

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
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(Container.prototype.addChild, before);
});

test("off persists across session replacements but a fresh process-memory owner starts enabled", async () => {
  const h = extensionHarness(); const before = Container.prototype.addChild;
  await h.events.get("session_start")!({}, h.ctx);
  await setAppearance(h.commands.get('tidy-ui')!.handler, h.ctx, false);
  await h.events.get("session_shutdown")!({}, h.ctx);
  await h.events.get("session_start")!({}, h.ctx);
  assert.equal(Container.prototype.addChild, before);
  const fresh = extensionHarness();
  try {
    await fresh.events.get("session_start")!({}, fresh.ctx);
    assert.notEqual(Container.prototype.addChild, before);
  } finally { await fresh.events.get("session_shutdown")!({}, fresh.ctx); }
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
    await h.events.get("session_shutdown")!({}, h.ctx);
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

test('shutdown cleanup preserves later mouse delegation after restoring native ownership', () => {
  const tool = new Tool(), native = Tool.prototype.handleMouse;
  const h = setup([tool]), saved = Tool.prototype.handleMouse;
  const later = function (this: Tool, event: TuiMouseEvent) { return saved.call(this, event); };
  Tool.prototype.handleMouse = later;
  try {
    h.controller.quiesce(); h.controller.restore();
    assert.equal(Tool.prototype.handleMouse, later);
    assert.equal(tool.handleMouse(mouse(2))?.handled, true);
    assert.equal(tool.expanded, true);
  } finally { h.controller.restore(); Tool.prototype.handleMouse = native; }
});

test('shutdown cleanup keeps unknown native self-shell visibility authoritative', () => {
  class SelfTool extends Tool {
    visible = true;
    getRenderShell() { return 'self'; }
    render(width: number) { return this.visible ? super.render(width) : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const tool = new SelfTool('custom'), h = setup([tool]);
  try {
    assert.ok(tool.render(80).length > 0); h.controller.quiesce();
    tool.visible = false;
    assert.deepEqual(tool.render(80), []);
  } finally { h.controller.restore(); }
});
