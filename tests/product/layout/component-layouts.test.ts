import '../../fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Container } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { initTheme, theme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { RenderCache } from "../../../src/render-cache.ts";
import { installTidyUi } from "../../../src/index.ts";

initTheme("dark", false);
class Root extends Container { requestRender() {} }
function tool(root: Root, name = "read", id = "owner") {
  const node = new ToolExecutionComponent(name, id, { path: `${id}.txt`, command: "echo owned" }, undefined, undefined, root as never, "/tmp");
  node.updateResult({ content: [{ type: "text", text: "BODY" }], isError: false });
  return node;
}

test("component layout entries survive count and byte pressure without eviction", () => {
  const cache = new RenderCache();
  const entries = Array.from({ length: 3000 }, (_, i) => {
    const rows = [`${i}:` + "x".repeat(1800)];
    return cache.put({ rows }, rows, "summary");
  });
  assert.equal(cache.stats().entries, 3000);
  assert.ok(cache.stats().retainedBytes > 8 * 1024 * 1024);
  for (const entry of entries) assert.equal(cache.get(entry), entry.value);
  assert.equal(cache.stats().builds, 3000);
  assert.equal(cache.stats().misses, 0);
  const rows = ["x".repeat(65 * 1024 * 1024)];
  const huge = cache.put({ rows }, rows, "write");
  assert.ok(huge.bytes > 128 * 1024 * 1024);
  assert.equal(cache.get(huge)?.rows, rows, "even a representation above the former entire card allowance is retained");
  cache.drop(entries[0]);
  assert.equal(entries[0]!.value, undefined);
  assert.equal(cache.stats().entries, 3000);
  cache.clear();
  assert.equal(huge.value, undefined);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().retainedBytes, 0);
});

test("component layout statistics attribute rows and estimated bytes by presentation kind", () => {
  const cache = new RenderCache();
  const summary = cache.put({ rows: ["abc", "def"] }, ["abc", "def"], "summary");
  const user = cache.put({ rows: ["user"] }, ["user"], "user");
  const stats = cache.stats();
  assert.equal(stats.entries, 2); assert.equal(stats.rows, 3);
  assert.equal(stats.stringBytes, 20);
  assert.equal(stats.retainedBytes, stats.stringBytes + stats.overheadBytes);
  assert.equal(stats.byKind.summary.entries, 1); assert.equal(stats.byKind.summary.rows, 2);
  assert.equal(stats.byKind.user.entries, 1); assert.equal(stats.byKind.user.rows, 1);
  for (const key of ["entries", "rows", "retainedBytes", "stringBytes", "overheadBytes"] as const)
    assert.equal(stats[key], Object.values(stats.byKind).reduce((total, item) => total + item[key], 0));
  cache.drop(summary); cache.drop(summary);
  assert.equal(cache.stats().entries, 1, "release is idempotent");
  assert.equal(cache.get(user)?.rows[0], "user");
  cache.clear();
});

test("actual SDK removal and subtree clear immediately release component layouts without waiting for GC", () => {
  const root = new Root(), group = new Container();
  const first = tool(root), bash = tool(root, "bash", "bash"), user = new UserMessageComponent("**USER_BODY**");
  group.addChild(bash); group.addChild(user); root.addChild(first); root.addChild(group);
  const controller = installTidyUi(root, () => theme);
  try {
    root.render(80);
    assert.equal(controller.cacheStats().entries, 3);
    assert.equal(controller.cacheStats().byKind.summary.entries, 1);
    assert.equal(controller.cacheStats().byKind.bash.entries, 1);
    assert.equal(controller.cacheStats().byKind.user.entries, 1);
    root.removeChild(first);
    assert.equal(controller.cacheStats().entries, 2, "a caller still holds first, but its removed representation is released");
    assert.equal(controller.cacheStats().byKind.summary.entries, 0);
    root.removeChild(group);
    assert.equal(controller.cacheStats().entries, 0, "removing a subtree releases all its retained representations");
    root.addChild(group); root.render(80);
    assert.equal(controller.cacheStats().entries, 2);
    group.clear();
    assert.equal(controller.cacheStats().entries, 0);
    root.addChild(first); root.render(80);
    assert.equal(controller.cacheStats().entries, 1);
    first.updateArgs({ path: "changed.txt" });
    assert.equal(controller.cacheStats().entries, 0, "native updates release the previous representation immediately");
    root.render(80); assert.equal(controller.cacheStats().entries, 1);
    controller.restore(); assert.equal(controller.cacheStats().entries, 0);
  } finally { controller.restore(); }
});

test("actual SDK clear/remove hooks restore only owned methods", () => {
  const clear = Container.prototype.clear, remove = Container.prototype.removeChild;
  const root = new Root(); root.addChild(tool(root));
  const controller = installTidyUi(root, () => theme);
  const later = function (this: Container) { clear.call(this); };
  try {
    assert.notEqual(Container.prototype.clear, clear);
    assert.notEqual(Container.prototype.removeChild, remove);
    Container.prototype.clear = later;
    controller.restore();
    assert.equal(Container.prototype.clear, later);
    assert.equal(Container.prototype.removeChild, remove);
  } finally { controller.restore(); Container.prototype.clear = clear; Container.prototype.removeChild = remove; }
});

test("actual SDK long transcript stays warm and releases rendered data and accounting on removal and GC", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/component-layout-probe.ts"], { encoding: "utf8", timeout: 60000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.ok(result.cold.entries > 2048);
  assert.ok(result.cold.ordinary.retainedBytes > 8 * 1024 * 1024);
  assert.equal(result.warmBuilds, 0);
  assert.equal(result.updatedBuilds, 1);
  assert.equal(result.detachedOwnerCollected, true);
  assert.equal(result.detachedRowsCollected, true);
  assert.equal(result.gcAccountingPruned, true);
  assert.equal(result.afterClear.entries, 0);
});
