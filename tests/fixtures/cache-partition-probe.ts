// Actual SDK mixed transcript: no execution, file edits, model requests or settings changes.
import './test-guard.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Container, ScrollView } from "@earendil-works/pi-tui";
import { ToolExecutionComponent, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { generateDiffString } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installTidyUi } from "../../src/index.ts";

initTheme("dark", false);
class Root extends Container { requestRender() {} }
const root = new Root(), viewport = new ScrollView(root, { primary: true, follow: "none", scrollbar: "hidden" });
for (let i = 0; i < 200; i++) {
  const node = new ToolExecutionComponent("read", `small-${i}`, { path: `file-${i}.ts` }, undefined, undefined, root as never, "/tmp");
  node.updateResult({ content: [], isError: false }); root.addChild(node);
}
for (let i = 0; i < 3; i++) {
  const node = new ToolExecutionComponent("bash", `bash-${i}`, { command: `command_${i}` }, undefined, undefined, root as never, "/tmp");
  node.updateResult({ content: [{ type: "text", text: Array.from({ length: 1000 }, (_, j) => `BASH_${j}_${"x".repeat(50)}`).join("\n") }], isError: false });
  node.setExpanded(true); root.addChild(node);
}
const before = Array.from({ length: 250 }, (_, i) => `export const value_${i} = "old value ${i}"; // comment`);
const after = before.map(row => row.replace("old value", "new value"));
const details = { diff: generateDiffString(before.join("\n"), after.join("\n")).diff,
  patch: `@@ -1,250 +1,250 @@\n${before.map(row => "-" + row).join("\n")}\n${after.map(row => "+" + row).join("\n")}\n` };
const edits: (ToolExecutionComponent | undefined)[] = [];
for (let i = 0; i < 24; i++) {
  const node = new ToolExecutionComponent("edit", `diff-${i}`, { path: `example-${i}.ts` }, undefined, createEditToolDefinition("/tmp"), root as never, "/tmp");
  node.updateResult({ content: [], details, isError: false }); root.addChild(node); edits.push(node);
}
const controller = installTidyUi(root, () => theme), observations: object[] = [];
function frame(stage: string, width = 140, height = 24) {
  const before = controller.cacheStats();
  const visible = renderLayoutFrame(viewport, width, height, () => {}).lines.length;
  const stats = controller.cacheStats();
  const delta = { ordinaryBuilds: stats.ordinary.builds - before.ordinary.builds, cardBuilds: stats.cards.builds - before.cards.builds };
  observations.push({ stage, width, height, visible, ...stats, delta }); return { ...stats, delta };
}
try {
  const cold = frame("cold");
  assert.equal(cold.ordinary.entries, 200); assert.equal(cold.cards.entries, 27);
  assert.ok(cold.cards.retainedBytes > 8 * 1024 * 1024, "the mixed card working set exceeds the old shared budget");
  for (const stage of ["warm-1", "warm-2", "scroll", "height-only"]) {
    if (stage === "scroll") viewport.scrollBy(2);
    assert.deepEqual(frame(stage, 140, stage === "height-only" ? 30 : 24).delta, { ordinaryBuilds: 0, cardBuilds: 0 });
  }
  assert.deepEqual(frame("resize", 141).delta, { ordinaryBuilds: 200, cardBuilds: 27 });
  assert.deepEqual(frame("resize-warm", 141).delta, { ordinaryBuilds: 0, cardBuilds: 0 });
  const beforeReplacement = controller.cacheStats();
  edits[1]!.updateResult({ content: [], details, isError: false });
  assert.equal(controller.cacheStats().cards.entries, 26, "only the changed component releases its old representation");
  const replaced = frame("one-card-update", 141);
  assert.deepEqual(replaced.delta, { ordinaryBuilds: 0, cardBuilds: 1 });
  assert.equal(replaced.cards.entries, 27);
  assert.equal(replaced.ordinary.retainedBytes, beforeReplacement.ordinary.retainedBytes);
  assert.deepEqual(frame("update-warm", 141).delta, { ordinaryBuilds: 0, cardBuilds: 0 });
  const detach = () => {
    const node = edits[0]!, reference = new WeakRef(node); root.removeChild(node); edits[0] = undefined;
    assert.equal(controller.cacheStats().cards.entries, 26); return reference;
  };
  const reference = detach(); frame("detached", 141);
  assert.equal(typeof globalThis.gc, "function");
  for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
  assert.equal(reference.deref(), undefined, "component layouts/accounting must not retain a detached edit or its source/component tree");
  const retained = controller.cacheStats(); assert.ok(retained.cards.entries > 0 && retained.ordinary.entries > 0);
  controller.clearCache(); assert.equal(controller.cacheStats().entries, 0); frame("clear-cold", 141);
  controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  const sourceHashes = Object.fromEntries(["index", "render-cache", "file-card"].map(name => [name,
    createHash("sha256").update(readFileSync(new URL(`../../src/${name}.ts`, import.meta.url))).digest("hex")]));
  console.log(JSON.stringify({ sourceHashes, observations, detachedEditCollected: true, afterRestore: controller.cacheStats() }));
} finally { controller.restore(); }
