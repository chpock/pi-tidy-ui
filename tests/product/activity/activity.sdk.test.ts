import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { setAppearance } from "../../helpers/menu-driver.ts";
import { Container, Root, Tool, color, extensionHarness, installTidyUi, plain, setup, type TuiMouseEvent } from "../../fixtures/sdk-contract-support.ts";

test("one execution-only spinner clock changes prefixes without rebuilding cached summaries and stops immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const intervals = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  const first = new Tool("read", { path: "a.txt", query: "x".repeat(90) }), second = new Tool("custom", { drop: "1,2,3,4" });
  first.result = second.result = undefined; first.executionStarted = second.executionStarted = false;
  const records: { area: string; explanation: string; fields?: import('../../../src/diagnostics.ts').DiagnosticFields }[] = [];
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
    await h.events.get("session_shutdown")!({}, h.ctx); assert.equal(animationStops(), 2);
    const closed = h.root.requests; t.mock.timers.tick(10000); assert.equal(h.root.requests, closed);
    for (const mode of ["print", "json", "rpc"] as const) {
      const starts = intervals.mock.calls.length;
      const other = extensionHarness(mode); other.root.addChild(tool);
      await other.events.get("session_start")!({}, other.ctx); other.root.render(80); await other.events.get("session_shutdown")!({}, other.ctx);
      assert.equal(intervals.mock.calls.length, starts, `${mode} installs no timers`);
    }
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); }
});
