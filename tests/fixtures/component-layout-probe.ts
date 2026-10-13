// Actual SDK eager transcript/GC proof. No live Pi, settings, model or tool execution.
import assert from "node:assert/strict";
import { Container, ScrollView } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installTidyUi } from "../../src/index.ts";
import { RenderCache } from "../../src/render-cache.ts";

initTheme("dark", false);
assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
class Root extends Container { requestRender() {} }
const root = new Root(), viewport = new ScrollView(root, { primary: true, follow: "none", scrollbar: "hidden" });
const tools: (ToolExecutionComponent | undefined)[] = Array.from({ length: 3000 }, (_, i) => {
  const node = new ToolExecutionComponent("custom", `owner-${i}`, { path: `file-${i}.txt`, query: "q".repeat(240), value: "v".repeat(240), source: "s".repeat(240) }, undefined, undefined, root as never, "/tmp");
  node.updateResult({ content: [], isError: false }); root.addChild(node); return node;
});
const controller = installTidyUi(root, () => theme);
const draw = () => renderLayoutFrame(viewport, 80, 24, () => {}).lines.length;
async function collect() {
  for (let i = 0; i < 16; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
}
try {
  draw(); const cold = controller.cacheStats();
  assert.equal(cold.entries, 3000); assert.equal(cold.builds, 3000);
  assert.ok(cold.ordinary.retainedBytes > 8 * 1024 * 1024);
  for (let i = 0; i < 3; i++) { viewport.scrollBy(1); assert.equal(draw(), 24); }
  const warmBuilds = controller.cacheStats().builds - cold.builds;
  assert.equal(warmBuilds, 0);
  tools[100]!.updateArgs({ path: "changed.txt" }); draw();
  const updatedBuilds = controller.cacheStats().builds - cold.builds;
  assert.equal(updatedBuilds, 1);
  const remove = () => {
    const owner = tools[0]!, rows = owner.render(80);
    const ownerReference = new WeakRef(owner), rowsReference = new WeakRef(rows);
    root.removeChild(owner); tools[0] = undefined;
    assert.equal(controller.cacheStats().entries, 2999);
    return { ownerReference, rowsReference };
  };
  const removed = remove(); draw(); await collect();
  assert.equal(removed.ownerReference.deref(), undefined);
  assert.equal(removed.rowsReference.deref(), undefined, "neither accounting nor native parent lines retain the rendered array");

  // Also prove GC-only weak accounting cleanup, independently of tree hooks.
  const accounting = new RenderCache();
  const keepRows = ["LIVE"]; const keep = accounting.put({ rows: keepRows }, keepRows, "summary");
  const forget = () => {
    const rows = ["DISPOSABLE"], entry = accounting.put({ rows }, rows, "summary");
    return { entry: new WeakRef(entry), rows: new WeakRef(rows) };
  };
  const forgotten = forget();
  assert.equal(accounting.stats().entries, 2);
  await collect();
  assert.equal(forgotten.entry.deref(), undefined); assert.equal(forgotten.rows.deref(), undefined);
  assert.equal((Reflect.get(accounting, "records") as Set<unknown>).size, 1,
    "finalizers remove dead weak/numeric metadata even if the user never requests statistics");
  assert.equal(accounting.stats().entries, 1); assert.equal(accounting.stats().collected, 1);
  assert.equal(accounting.get(keep)?.rows, keepRows);
  for (let i = 0; i < 1000; i++) forget();
  await collect();
  assert.equal((Reflect.get(accounting, "records") as Set<unknown>).size, 1,
    "repeated GC-only layout generations cannot accumulate accounting tokens");
  for (let i = 0; i < 40; i++) {
    const node = new ToolExecutionComponent("read", `cycle-${i}`, { path: "cycle.txt" }, undefined, undefined, root as never, "/tmp");
    root.addChild(node); node.render(80); root.removeChild(node);
    assert.equal(controller.cacheStats().entries, 2999, "repeated attach/render/remove cannot accumulate saved layouts");
  }
  controller.clearCache(); const afterClear = controller.cacheStats();
  assert.equal(afterClear.entries, 0); assert.equal(afterClear.retainedBytes, 0);
  accounting.clear();
  console.log(JSON.stringify({ cold, warmBuilds, updatedBuilds, detachedOwnerCollected: true, detachedRowsCollected: true, gcAccountingPruned: true, afterClear }));
} finally { controller.restore(); }
