// Actual-SDK components; a deterministic host models completed document visits, not terminal presentation.
import './fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { Container, type Component } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installTidyUi } from "../src/index.ts";

initTheme("dark", false);
const frames = Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
class Root extends Container { requests = 0; requestRender() { this.requests++; } }
function fixture(t: TestContext, count = 1) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const deadlines = t.mock.method(globalThis, "setTimeout"), intervals = t.mock.method(globalThis, "setInterval");
  const root = new Root(), document = new Container(); root.addChild(document);
  const tools = Array.from({ length: count }, (_, i) => {
    const node = new ToolExecutionComponent("read", `scheduler-${i}`, { path: `a${i}.txt` },
      undefined, undefined, root as never, "/tmp");
    document.addChild(node); return node;
  });
  const controller = installTidyUi(root as never, () => theme);
  t.after(() => controller.restore());
  const render = () => root.render(80).map(plain);
  const glyph = (node = tools[0]!) => node.render(80).map(plain).find(row => row.includes(" read "))![1]!;
  return { root, document, tools, controller, render, glyph, deadlines, intervals };
}

test("host document visits drive time-based spinner frames without any fallback requests", t => {
  const f = fixture(t, 2);
  f.render(); assert.equal(f.deadlines.mock.calls.length, 0, "argument streaming starts no deadline");
  f.tools.forEach(node => node.markExecutionStarted());
  const initial = f.render(), builds = f.controller.cacheStats().builds, requests = f.root.requests;
  assert.equal(f.intervals.mock.calls.length, 0, "pi-tidy-ui owns no periodic interval");
  assert.equal(f.deadlines.mock.calls.length, 1, "parallel calls share one initial deadline");
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(80); const rows = f.render(); seen.add(rows[0]![1]!);
    assert.equal(rows[0]![1], frames[Math.floor(Date.now() / 100) % frames.length]);
    assert.equal(f.glyph(f.tools[1]), rows[0]![1], "parallel prefixes have the same phase");
    assert.deepEqual(rows.map(row => row.slice(3)), initial.map(row => row.slice(3)));
    assert.equal(f.root.requests, requests, "80ms host visits suppress every extra request");
    assert.equal(f.controller.cacheStats().builds, builds, "host-driven animation builds no custom body");
  }
  assert.ok(seen.size >= 8, "prefixes advance even though no fallback ever fires");
  t.mock.timers.tick(99); assert.equal(f.root.requests, requests);
  t.mock.timers.tick(1); assert.equal(f.root.requests, requests + 1, "host silence starts fallback exactly after its last visit");
});

test("a fallback waits for the requested document visit and rearms relative to its completion", t => {
  const f = fixture(t, 2); f.tools.forEach(node => node.markExecutionStarted()); f.render();
  const requests = f.root.requests, builds = f.controller.cacheStats().builds;
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(99); assert.equal(f.root.requests, requests + i);
    t.mock.timers.tick(1); assert.equal(f.root.requests, requests + i + 1, "one request, not one per tool");
    t.mock.timers.tick(25); assert.equal(f.root.requests, requests + i + 1, "no repeated request while the host is pending");
    const rows = f.render();
    assert.equal(rows[0]![1], frames[Math.floor(Date.now() / 100) % frames.length]);
    assert.equal(f.controller.cacheStats().builds, builds);
  }
  t.mock.timers.tick(100); const pending = f.root.requests;
  t.mock.timers.tick(1000); assert.equal(f.root.requests, pending, "a stopped/delayed host cannot cause a request storm");
  f.render(); t.mock.timers.tick(100);
  assert.equal(f.root.requests, pending + 1, "a resumed document visit restores fallback");
});

test("a native request awaiting document completion permits one fallback, then timely host visits suppress it again", t => {
  const f = fixture(t, 2); f.tools.forEach(node => node.markExecutionStarted()); f.render();
  const requests = f.root.requests, builds = f.controller.cacheStats().builds;
  t.mock.timers.tick(80); f.root.requestRender();
  t.mock.timers.tick(19); assert.equal(f.root.requests, requests + 1, "only the native request before the deadline");
  t.mock.timers.tick(1); assert.equal(f.root.requests, requests + 2, "a requested but unfinished native frame does not cancel fallback");
  const allocated = f.deadlines.mock.calls.length;
  t.mock.timers.tick(1000);
  assert.equal(f.root.requests, requests + 2, "exactly one fallback request while document completion is pending");
  assert.equal(f.deadlines.mock.calls.length, allocated, "no new deadline while awaiting completion");
  assert.equal(f.controller.cacheStats().builds, builds);
  f.render();
  assert.equal(f.deadlines.mock.calls.length, allocated + 1, "successful completion rearms one deadline");
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(80); f.root.requestRender(); const rows = f.render(); seen.add(rows[0]![1]!);
    assert.equal(f.root.requests, requests + 3 + i, "timely completed host visits add only the native requests");
    assert.equal(rows[0]![1], rows[1]![1], "parallel compact tools retain one phase");
    assert.equal(f.controller.cacheStats().builds, builds, "delay and recovery reuse the same bodies");
  }
  assert.ok(seen.size >= 8, "native-driven prefix animation resumes without fallback");
});

test("requests, direct tool visits and unrelated containers do not acknowledge the document deadline", t => {
  const f = fixture(t); f.tools[0]!.markExecutionStarted(); f.render();
  const unrelated = new Container(); unrelated.addChild({ render: () => ["unrelated"], invalidate() {} });
  t.mock.timers.tick(90); f.glyph(); unrelated.render(80); f.root.requestRender();
  const requests = f.root.requests;
  t.mock.timers.tick(10); assert.equal(f.root.requests, requests + 1, "only a successful document visit postpones fallback");
  const count = f.deadlines.mock.calls.length;
  t.mock.timers.tick(100); f.glyph(); unrelated.render(80);
  assert.equal(f.deadlines.mock.calls.length, count, "component diagnostics cannot rearm an already requested frame");
  assert.equal(f.root.requests, requests + 1);
});

test("a document pass samples one spinner phase even when its children take over 100ms", t => {
  const f = fixture(t, 2); f.tools.forEach(node => node.markExecutionStarted());
  const slow: Component = { render() { t.mock.timers.setTime(Date.now() + 150); return []; }, invalidate() {} };
  f.document.children.splice(1, 0, slow);
  const rows = f.render();
  assert.equal(rows[0]![1], frames[0]); assert.equal(rows[1]![1], frames[0], "one normal pass cannot split animation phases");
  assert.equal(f.deadlines.mock.calls.length, 1, "arming is deferred until the complete document returns");
  const requests = f.root.requests;
  t.mock.timers.tick(99); assert.equal(f.root.requests, requests);
  t.mock.timers.tick(1); assert.equal(f.root.requests, requests + 1, "deadline starts after, not before, slow layout");
  assert.equal(f.glyph(), frames[Math.floor(Date.now() / 100) % frames.length], "direct rendering uses live time, not a leaked call-local phase");
  assert.notEqual(f.glyph(), frames[0], "the document's initial phase is no longer active");
});

test("failed document visits neither postpone a live deadline nor leave a scoped phase behind", t => {
  const f = fixture(t); f.tools[0]!.markExecutionStarted(); f.render();
  const bad: Component = { render() { throw new Error("document failure"); }, invalidate() {} };
  f.document.addChild(bad);
  t.mock.timers.tick(80); assert.throws(f.render, /document failure/);
  assert.equal(f.deadlines.mock.calls.length, 1, "a failed pass cannot rearm in finally");
  const requests = f.root.requests;
  t.mock.timers.tick(20); assert.equal(f.root.requests, requests + 1);
  assert.equal(f.glyph(), frames[1], "exception cleanup releases the old phase sample");
  f.document.removeChild(bad); f.render(); t.mock.timers.tick(100);
  assert.equal(f.root.requests, requests + 2, "successful recovery rearms after a pending request");
});

test("cancelled or disposed deadline callbacks cannot request frames from a later generation", t => {
  const f = fixture(t); f.tools[0]!.markExecutionStarted(); f.render();
  const cancelled = f.deadlines.mock.calls[0]!.arguments[0] as () => void;
  t.mock.timers.tick(80); f.render();
  const requests = f.root.requests; cancelled(); assert.equal(f.root.requests, requests);
  t.mock.timers.tick(100); assert.equal(f.root.requests, requests + 1, "stale callback cannot consume the replacement deadline");
  f.render(); const disposed = f.deadlines.mock.calls.at(-1)!.arguments[0] as () => void;
  f.controller.restore(); const restored = f.root.requests;
  disposed(); t.mock.timers.tick(10000); assert.equal(f.root.requests, restored);
});

for (const mode of ["final", "expand", "remove", "clear"] as const) {
  test(`last-participant ${mode} stops fallback immediately, including an already pending frame`, t => {
    const f = fixture(t); f.tools[0]!.markExecutionStarted(); f.render();
    const before = f.root.requests; t.mock.timers.tick(100); const requests = f.root.requests;
    assert.equal(requests, before + 1, "lifecycle control has a genuinely pending fallback request");
    if (mode === "final") f.tools[0]!.updateResult({ content: [], isError: false });
    else if (mode === "expand") f.tools[0]!.setExpanded(true);
    else if (mode === "remove") f.document.removeChild(f.tools[0]!);
    else f.document.clear();
    f.render(); const count = f.deadlines.mock.calls.length;
    t.mock.timers.tick(10000); assert.equal(f.root.requests, requests);
    assert.equal(f.deadlines.mock.calls.length, count, "no idle deadline after lifecycle stop");
  });
}

test("ordinary document visits prune silent eligibility changes before they can keep fallback alive", t => {
  const f = fixture(t); f.tools[0]!.markExecutionStarted(); f.render();
  // Direct removal bypasses the owned removeChild wrapper, so document completion must also prune.
  f.document.children.splice(0, 1);
  t.mock.timers.tick(80); f.render();
  const requests = f.root.requests;
  t.mock.timers.tick(10000); assert.equal(f.root.requests, requests);
  assert.equal(f.deadlines.mock.calls.length, 1, "host-driven frames do not perpetuate a dead participant");
});
