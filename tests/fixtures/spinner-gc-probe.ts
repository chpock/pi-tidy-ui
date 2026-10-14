// Isolated actual-SDK ownership control. Only deadline dispatch is held for GC.
import './test-guard.mjs';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextJournal } from "../../src/debug-log.ts";
import { Container } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installTidyUi } from "../../src/index.ts";

initTheme("dark", false);
class Root extends Container { requests = 0; requestRender() { this.requests++; } }
const root = new Root();
const nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
let starts = 0;
// Keep the real Node handle and the actual production callback alive until GC.
// An ordinary expiry could otherwise release an accidentally captured owner and
// produce a false-positive ownership pass. This fixture controls dispatch only.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (callback.name !== "tickSpinner") return nativeTimeout(callback, delay, ...args);
  assert.equal(delay, 100);
  const handle = nativeTimeout(() => {}, 60_000);
  deadlines.set(handle, () => { deadlines.delete(handle); nativeClear(handle); callback(...args); });
  starts++;
  return handle;
}) as typeof setTimeout;
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
  deadlines.delete(handle); nativeClear(handle);
}) as typeof clearTimeout;
let node: ToolExecutionComponent | undefined = new ToolExecutionComponent("read", "last-spinner-owner", { path: "a.txt" },
  undefined, undefined, root as never, "/tmp");
root.addChild(node);
const logDirectory = mkdtempSync(join(tmpdir(), "tidy-ui-spinner-gc-"));
const journal = new TextJournal({ session: "spinner-gc", cwd: "/tmp", reason: "test", extension: "0.0.0", pi: "sdk" }, { root: logDirectory });
await journal.ready;
const controller = installTidyUi(root as never, () => theme, { diagnostic: journal.sink });
try {
  node.markExecutionStarted(); node.render(80);
  assert.equal(controller.cacheStats().entries, 1);
  assert.equal(starts, 1); assert.equal(deadlines.size, 1);
  assert.equal([...deadlines.keys()][0]!.hasRef(), false, "the live real Node deadline is unreferenced");
  await journal.flush(); assert.ok(journal.status().writes > 0); assert.equal(journal.status().state, "active");
  const reference = new WeakRef(node);
  // Bypass the owned remove/clear hooks so only weak-owner GC can release it.
  // No viewport/mouse-layout registry was created by the direct component visit.
  root.children.length = 0; node = undefined;
  assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!();
  }
  assert.equal(reference.deref(), undefined, "a still-held fallback callback must not own the last SDK participant");
  assert.equal(deadlines.size, 1, "GC happened while the production callback was still retained");
  const requests = root.requests;
  [...deadlines.values()][0]!();
  assert.equal(deadlines.size, 0); assert.equal(starts, 1, "last-owner expiry must not rearm");
  assert.equal(root.requests, requests, "an expired deadline with no live participant requests no frame");
  const stats = controller.cacheStats();
  assert.equal(stats.entries, 0); assert.equal(stats.retainedBytes, 0);
  assert.equal(controller.active, true, "cleanup occurs while the adapter remains installed");
  root.render(80);
  assert.equal(deadlines.size, 0); assert.equal(starts, 1); assert.equal(root.requests, requests);
  console.log(JSON.stringify({ lastParticipantCollected: true, callbackRetainedDuringGc: true,
    starts, active: deadlines.size, requestsAddedAfterGc: root.requests - requests, entries: stats.entries, retainedBytes: stats.retainedBytes }));
} finally {
  controller.restore();
  for (const handle of deadlines.keys()) nativeClear(handle);
  globalThis.setTimeout = nativeTimeout; globalThis.clearTimeout = nativeClear;
  await journal.close("quit"); rmSync(logDirectory, { recursive: true, force: true });
}
