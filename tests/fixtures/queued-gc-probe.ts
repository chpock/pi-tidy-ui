import assert from "node:assert/strict";
import { Container, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installTidyUi } from "../../src/index.ts";
import { RenderCache } from "../../src/render-cache.ts";

initTheme("dark", false);
assert.equal(typeof globalThis.gc, "function");
class Root extends Container { terminal = { rows: 60 }; requestRender() {} }
const root = new Root();
for (let i = 0; i < 7; i++) root.addChild(new Container());
const pending = root.children[1] as Container;
function add() {
  const first = new TruncatedText(theme.fg("dim", "Steering: FIRST\n" + "body ".repeat(100)), 1, 0);
  const second = new TruncatedText(theme.fg("dim", "Follow-up: SECOND"), 1, 0);
  pending.addChild(new Spacer(1)); pending.addChild(first); pending.addChild(second);
  pending.addChild(new TruncatedText(theme.fg("dim", "↳ Alt+Up to edit all queued messages"), 1, 0));
  return { first: new WeakRef(first), second };
}
const original = add();
pending.render(100); // Native rendering before enabling pi-tidy-ui owns a mouse-layout snapshot.
const values: WeakRef<object>[] = [];
const put = RenderCache.prototype.put;
RenderCache.prototype.put = function (this: RenderCache, ...args: Parameters<typeof put>) {
  const entry = put.apply(this, args);
  if (args[2] === "queued") values.push(new WeakRef(entry.value as object));
  return entry;
} as typeof put;
const controller = installTidyUi(root, () => theme);
async function collect() {
  for (let i = 0; i < 16; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
}
try {
  pending.render(100); assert.equal(controller.cacheStats().entries, 2);
  pending.clear();
  const { first, second } = add();
  pending.render(100);
  await collect();
  assert.equal(original.first.deref(), undefined, "a pre-install native mouse layout must not retain an earlier queue generation");
  assert.equal(values[0]!.deref(), undefined, "the first generation's pi-tidy-ui preparation was released");
  assert.equal(original.second.render(100).length, 1, "temporarily projected native methods are restored");
  // Bypass removal hooks deliberately: actual collection, not explicit drop, must work.
  pending.children.splice(1, 1);
  pending.render(100); // Refresh native Container ownership, just as the host's next frame does.
  await collect();
  assert.equal(first.deref(), undefined, "the first queue owner is not held by a hook closure");
  assert.equal(values[2]!.deref(), undefined, "its prepared full/clipped rows collect while another card stays active");
  assert.equal(controller.cacheStats().entries, 1);
  assert.equal(controller.cacheStats().collected, 1);
  pending.removeChild(second);
  assert.equal(controller.cacheStats().entries, 0);
  await collect();
  assert.equal(values[3]!.deref(), undefined, "native removal releases rows even while the owner itself is held");
  assert.equal(second.render(100).length, 1);
  assert.equal(controller.active, true);
  console.log(JSON.stringify({ preInstallNativeOwnerCollected: true, firstOwnerCollected: true, firstLayoutCollected: true, heldOwnerLayoutReleased: true, stats: controller.cacheStats() }));
} finally { controller.restore(); RenderCache.prototype.put = put; }
