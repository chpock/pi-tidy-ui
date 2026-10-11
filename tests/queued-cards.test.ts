import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { spawnSync } from "node:child_process";
import { Container, Spacer, Text, TruncatedText, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installToolview } from "../src/index.ts";
import { cardGeometry } from "../src/card-frame.ts";
import { prepareQueuedCard } from "../src/queued-card.ts";

initTheme("dark", false);
class Root extends Container {
  terminal = { rows: 60 };
  requests = 0;
  requestRender() { this.requests++; }
}
function fixture(steering: string[], followUp: string[] = [], height = 60) {
  const root = new Root(); root.terminal.rows = height;
  const slots = Array.from({ length: 7 }, () => new Container());
  for (const slot of slots) root.addChild(slot);
  const pending = slots[1]!;
  const session = {
    getSteeringMessages: () => steering, getFollowUpMessages: () => followUp,
    clearQueue: () => { const value = { steering: [...steering], followUp: [...followUp] }; steering.length = 0; followUp.length = 0; return value; },
  };
  let draft = "";
  const host: any = Object.assign(Object.create(InteractiveMode.prototype, { session: { value: session } }), {
    pendingMessagesContainer: pending, compactionQueuedMessages: [],
    getAppKeyDisplay: () => "Alt+Up", ui: root,
    editor: { getText: () => draft, setText: (text: string) => { draft = text; } },
  });
  host.updatePendingMessagesDisplay();
  return { root, slots, pending, host, draft: () => draft };
}
const plain = (rows: string[]) => rows.map(row => stripVTControlCharacters(row).trimEnd());
function content(rows: string[], width = 100, padding = 1): string[] {
  const geometry = cardGeometry(width, padding);
  return plain(rows).filter(row => row.includes("┃")).map(row => row.slice(geometry.contentX));
}
function bodies(rows: string[], width = 100, padding = 1): string[][] {
  const result: string[][] = []; let body: string[] = [];
  for (const row of content(rows, width, padding)) {
    if (row.startsWith("QUEUED · ")) { result.push(body.filter(Boolean)); body = []; }
    else body.push(row);
  }
  return result;
}
const message = (name: string, length: number) => Array.from({ length }, (_, i) => `${name}_${i + 1}`).join("\n");

test("queued cards use actual native queue construction and preserve full text, order and edit-all behavior", () => {
  const steering = ["FIRST\n  indentation\n\n**plain, not Markdown**"], follow = ["SECOND"];
  const { root, pending, host, draft } = fixture(steering, follow, 120);
  host.compactionQueuedMessages = [{ mode: "steer", text: "COMPACTION" }]; host.updatePendingMessagesDisplay();
  const native = pending.render(100), children = [...pending.children];
  const original = Container.prototype.render;
  const controller = installToolview(root, () => theme);
  try {
    const rows = content(pending.render(100));
    assert.deepEqual(rows, ["", "FIRST", "  indentation", "", "**plain, not Markdown**", "", "QUEUED · Steering", "",
      "", "COMPACTION", "", "QUEUED · Steering", "", "", "SECOND", "", "QUEUED · Follow-up (Alt+Up to edit all queued messages)", ""]);
    assert.equal(plain(pending.render(100)).filter(row => row.includes("edit all queued messages")).length, 1);
    assert.ok(!plain(pending.render(100)).some(row => row.includes("↳")));
    assert.deepEqual(pending.children, children, "render never exchanges native queue components");
    assert.deepEqual(host.getAllQueuedMessages(), { steering: [steering[0], "COMPACTION"], followUp: follow });
    assert.equal(host.restoreQueuedMessagesToEditor(), 3);
    assert.equal(draft(), "FIRST\n  indentation\n\n**plain, not Markdown**\n\nCOMPACTION\n\nSECOND");
    assert.deepEqual(pending.render(100), []);
    assert.equal(controller.cacheStats().entries, 0, "native queue clear releases layouts while removed nodes are still held");
    assert.ok(children.every(node => typeof node.render === "function"));
    steering.push("RESTORED"); host.updatePendingMessagesDisplay();
    assert.ok(content(pending.render(100)).includes("RESTORED"));
  } finally { controller.restore(); }
  assert.equal(Container.prototype.render, original);
  assert.ok(!pending.render(100).join("").includes("QUEUED"));
  assert.ok(native.length > 0);
});

test("queued cards allocate max(10,floor(screen/3)) including decoration and stop the sweep as soon as they fit", () => {
  const { root, pending } = fixture([message("A", 8), message("B", 8)], [], 69);
  const controller = installToolview(root, () => theme);
  try {
    // Leading spacer + 4 decoration rows per card + one card separator = 10.
    let rows = pending.render(100);
    assert.equal(rows.length, 23);
    assert.deepEqual(bodies(rows).map(body => body.length), [5, 8]);
    assert.equal(bodies(rows)[0]!.at(-1), "A_5…");
    assert.equal(bodies(rows)[1]!.at(-1), "B_8");
    root.terminal.rows = 68;
    rows = pending.render(100);
    assert.equal(rows.length, 20);
    assert.deepEqual(bodies(rows).map(body => body.length), [5, 5]);
    root.terminal.rows = 36;
    assert.deepEqual(bodies(pending.render(100)).map(body => body.length), [1, 1]);
    assert.equal(pending.render(100).length, 12);
    root.terminal.rows = 12;
    assert.equal(pending.render(100).length, 12, "minimum representations overflow the soft budget rather than dropping a card");
    assert.deepEqual(bodies(pending.render(100)).map(body => body.length), [1, 1]);
    root.terminal.rows = 90;
    assert.deepEqual(bodies(pending.render(100)).map(body => body.length), [8, 8], "resizing restores original complete text");
  } finally { controller.restore(); }
  const single = fixture([message("S", 20)], [], 12);
  const adapter = installToolview(single.root, () => theme);
  try { assert.equal(single.pending.render(100).length, 10); assert.equal(bodies(single.pending.render(100))[0]!.length, 5); }
  finally { adapter.restore(); }
});

test("queued cards reuse prepared bodies across warm and height-only frames and account/release each native owner", () => {
  const source = [message("A", 15), message("B", 15)], { root, pending, host } = fixture(source);
  const controller = installToolview(root, () => theme);
  try {
    pending.render(100); const cold = controller.cacheStats();
    assert.equal(cold.entries, 2);
    assert.equal((cold.byKind as any).queued.entries, 2);
    const requests = root.requests;
    for (let i = 0; i < 40; i++) pending.render(100);
    for (const height of [31, 120, 24, 60]) { root.terminal.rows = height; pending.render(100); }
    assert.equal(controller.cacheStats().builds, cold.builds, "clipping is row selection, not wrapping/painting again");
    assert.equal(root.requests, requests, "queue presentation schedules no frames");
    pending.render(60); assert.equal(controller.cacheStats().builds, cold.builds + 2);
    const first = pending.children[1]!;
    Object.defineProperty(first, "text", { value: theme.fg("dim", "Steering: UPDATED"), configurable: true, writable: true });
    pending.render(60); assert.equal(controller.cacheStats().builds, cold.builds + 3);
    pending.removeChild(first); assert.equal(controller.cacheStats().entries, 1);
    pending.render(60); assert.equal(controller.cacheStats().entries, 1);
    const held = [...pending.children]; pending.clear();
    assert.equal(controller.cacheStats().entries, 0); assert.ok(held.length > 0);
    host.updatePendingMessagesDisplay(); pending.render(100); controller.clearCache();
    assert.equal(controller.cacheStats().entries, 0); pending.render(100); assert.equal(controller.cacheStats().entries, 2);
    root.removeChild(pending); assert.equal(controller.cacheStats().entries, 0);
  } finally { controller.restore(); }
});

test("queued cards wrap metadata without hiding it, follow native remapped keys and leave raw control-bearing text untouched", () => {
  const raw = "AB界é👩‍💻\tX\n\n\x1b[31mRED\x1b[0m\x1b]52;c;Zm9v\x07\r\nLAST";
  const source = [raw], { root, pending, host } = fixture(source, [], 150);
  host.getAppKeyDisplay = () => "Ctrl+Alt+E"; host.updatePendingMessagesDisplay();
  let padding = 1;
  const controller = installToolview(root, () => theme, { outputPad: () => padding });
  try {
    const rows = pending.render(100);
    assert.ok(content(rows).includes("QUEUED · Steering (Ctrl+Alt+E to edit all queued messages)"));
    assert.ok(!rows.join("").includes("\x1b]52"));
    for (const pad of [0, 1]) for (const width of [100, 30, 10, 6, 2, 1, 0]) {
      padding = pad; const rendered = pending.render(width);
      assert.ok(rendered.every(row => visibleWidth(row) <= width), `width ${width}, padding ${pad}`);
      if (!width) { assert.deepEqual(rendered, []); continue; }
      const label = "QUEUED · Steering (Ctrl+Alt+E to edit all queued messages)", geometry = cardGeometry(width, pad);
      const count = Math.ceil(visibleWidth(label) / geometry.contentWidth);
      const text = rendered.slice(-1 - count, -1).map(row => stripVTControlCharacters(row).slice(geometry.contentX, geometry.contentX + geometry.contentWidth)).join("");
      assert.equal(text.slice(0, label.length), label, `complete metadata at width ${width}`);
    }
    assert.deepEqual(source, [raw]);
    assert.equal(host.restoreQueuedMessagesToEditor(), 1);
    assert.equal(host.editor.getText(), raw);
  } finally { controller.restore(); }
});

test("queued-card badge background matches the user stripe and hint follows dim punctuation with muted text", async () => {
  const { root, pending } = fixture(["BODY"]);
  const controller = installToolview(root, () => theme);
  try {
    for (const name of ["dark", "light"] as const) {
      initTheme(name, false);
      const rows = pending.render(100), bare = plain(rows), index = bare.findIndex(row => row.includes("QUEUED · Steering"));
      assert.ok(index >= 0);
      const terminal = new xterm.Terminal({ cols: 100, rows: rows.length + 4, allowProposedApi: true });
      try {
        await new Promise<void>(done => terminal.write(rows.join("\r\n") + "\r\n" + theme.fg("dim", "(") + theme.fg("muted", "X"), done));
        const cell = (y: number, x: number) => terminal.buffer.active.getLine(y)!.getCell(x)!;
        const stripe = cell(index, 1), badge = cell(index, bare[index]!.indexOf("QUEUED"));
        assert.equal(badge.getBgColor(), stripe.getFgColor()); assert.equal(badge.getBgColorMode(), stripe.getFgColorMode());
        const body = cell(bare.findIndex(row => row.includes("BODY")), 3);
        assert.equal(badge.getFgColor(), body.getBgColor()); assert.equal(badge.getFgColorMode(), body.getBgColorMode());
        const opening = bare[index]!.indexOf("("), closing = bare[index]!.lastIndexOf(")");
        for (const column of [opening, closing]) {
          assert.equal(cell(index, column).getFgColor(), cell(rows.length, 0).getFgColor());
          assert.equal(cell(index, column).getBgColor(), body.getBgColor());
        }
        assert.equal(cell(index, opening + 1).getFgColor(), cell(rows.length, 1).getFgColor());
        assert.equal(stripe.isBgDefault(), true);
        assert.equal(cell(index, 0).isBgDefault(), true); assert.equal(cell(index, 99).isBgDefault(), true);
      } finally { terminal.dispose(); }
    }
  } finally { controller.restore(); initTheme("dark", false); }
});

test("queued-card guards retain native unknown shapes, foreign methods and unrelated TruncatedText", () => {
  const { root, slots, pending } = fixture(["EXPECTED"]);
  const other = new TruncatedText("Steering: NOT_A_QUEUE", 1, 0); slots[0]!.addChild(other);
  const native = pending.render(100), unrelated = other.render(100), render = Container.prototype.render;
  const controller = installToolview(root, () => theme);
  try {
    assert.ok(content(pending.render(100)).includes("EXPECTED"));
    assert.deepEqual(other.render(100), unrelated);
    const hint = pending.children.at(-1)!;
    pending.removeChild(hint); assert.deepEqual(pending.render(100), render.call(pending, 100));
    pending.addChild(hint);
    const item = pending.children[1]!;
    const descriptor = Object.getOwnPropertyDescriptor(item, "text")!;
    Object.defineProperty(item, "text", { value: "Unknown: EXPECTED", configurable: true, writable: true });
    assert.deepEqual(pending.render(100), render.call(pending, 100));
    Object.defineProperty(item, "text", descriptor);
    const ownRender = Object.getOwnPropertyDescriptor(item, "render");
    Object.defineProperty(item, "render", { value: () => ["FOREIGN"], configurable: true, writable: true });
    assert.deepEqual(pending.render(100), render.call(pending, 100));
    if (ownRender) Object.defineProperty(item, "render", ownRender); else Reflect.deleteProperty(item, "render");
    const nativeSpacer = pending.children[0]!;
    pending.children[0] = new Spacer(2);
    assert.deepEqual(pending.render(100), render.call(pending, 100)); pending.children[0] = nativeSpacer;
    const later = () => ["LATER_OWNER"];
    pending.render = later; controller.restore(); assert.equal(pending.render, later);
    assert.ok(native.every(row => !row.includes("QUEUED")));
  } finally { controller.restore(); }
});

test("queued cards leave subsequent native pending components untouched and do not budget their output", () => {
  const { root, pending } = fixture(["ONLY_MESSAGE"]);
  let renders = 0;
  const shell = new Text("NATIVE_PENDING_BASH\nsecond", 0, 0);
  const render = shell.render;
  shell.render = width => { renders++; return render.call(shell, width); };
  pending.addChild(shell);
  const controller = installToolview(root, () => theme);
  try {
    renders = 0;
    const rows = pending.render(100);
    assert.ok(content(rows).includes("ONLY_MESSAGE"));
    assert.deepEqual(rows.slice(-2), ["NATIVE_PENDING_BASH".padEnd(100), "second".padEnd(100)]);
    assert.equal(renders, 1);
  } finally { controller.restore(); }
});

test("queued-card layouts collect with the first native owner under an active adapter", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", new URL("./fixtures/queued-gc-probe.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.preInstallNativeOwnerCollected, true);
  assert.equal(proof.firstOwnerCollected, true); assert.equal(proof.firstLayoutCollected, true);
  assert.equal(proof.heldOwnerLayoutReleased, true); assert.equal(proof.stats.entries, 0);
});

test("queued cards preserve native Container mouse bookkeeping and scoped method descriptors", () => {
  const { root, pending } = fixture([message("LONG", 12)], [], 120);
  const events: TuiMouseEvent[] = [];
  const suffix = Object.assign(new Text("NATIVE_SUFFIX\nSECOND", 0, 0), {
    handleMouse: (event: TuiMouseEvent) => { events.push(event); return { handled: true }; },
  });
  pending.addChild(suffix); pending.render(100);
  const nodes = pending.children.slice(0, -1);
  Object.defineProperty(nodes[1], "render", { value: TruncatedText.prototype.render, configurable: true, writable: false, enumerable: true });
  const renderDescriptors = nodes.map(node => Object.getOwnPropertyDescriptor(node, "render"));
  const nativeRender = TruncatedText.prototype.render;
  const controller = installToolview(root, () => theme);
  try {
    const rows = pending.render(100);
    const result = pending.handleMouse({ type: "click", button: "left", x: 1, y: rows.length - 1,
      screenX: 1, screenY: rows.length - 1, width: 100, height: rows.length, shift: false, alt: false, ctrl: false });
    assert.equal(result?.target.component, suffix, "native hit testing follows the projected card height");
    assert.equal(events.length, 1); assert.equal(events[0]!.y, 1); assert.equal(events[0]!.height, 2);
    assert.deepEqual(pending.children.slice(0, -1), nodes, "native children are never exchanged");
    nodes.forEach((node, index) => assert.deepEqual(Object.getOwnPropertyDescriptor(node, "render"), renderDescriptors[index]));
    assert.equal(TruncatedText.prototype.render, nativeRender);
  } finally { controller.restore(); }
});

test("queued clipped rows always use the one-column ellipsis, including full Unicode and tiny rows", () => {
  const cases = [
    { width: 10, text: "ABCDEFG", expected: "ABCDEF…" },
    { width: 10, text: "界界界a", expected: "界界界…" },
    { width: 10, text: "é".repeat(7), expected: "é".repeat(6) + "…" },
    ...[1, 2, 3, 4, 5].map(width => {
      const size = cardGeometry(width, 0).contentWidth;
      return { width, text: "A".repeat(size), expected: "A".repeat(size - 1) + "…" };
    }),
  ];
  for (const { width, text, expected } of cases) {
    const geometry = cardGeometry(width, 0);
    const card = prepareQueuedCard(Array(8).fill(text).join("\n"), "Steering", "", width, theme, 0);
    assert.equal(card.ellipsis.length, 5);
    for (const row of card.ellipsis) {
      assert.equal(stripVTControlCharacters(row).slice(geometry.contentX).trimEnd(), expected, `width ${width}: ${text}`);
      assert.ok(visibleWidth(row) <= width);
    }
  }
});

test("queued projection restores methods on render failure, preserves later owners and leaves immutable items native", () => {
  for (const reason of ["throw", "later-owner", "immutable"] as const) {
    const { root, pending } = fixture(["MESSAGE"]);
    const item = pending.children[1]!, hint = pending.children[2]!;
    const nativeRows = pending.render(100), original = item.render;
    if (reason === "immutable") Object.preventExtensions(item);
    const later = () => ["LATER_OWNER"];
    let once = true;
    if (reason !== "immutable") pending.addChild({ invalidate() {}, render: () => {
      if (once) {
        once = false;
        if (reason === "throw") throw new Error("native suffix failed");
        item.render = later;
      }
      return ["NATIVE_SUFFIX"];
    } });
    const controller = installToolview(root, () => theme);
    try {
      const rows = pending.render(100);
      assert.equal(hint.render, TruncatedText.prototype.render);
      assert.equal(Object.hasOwn(hint, "render"), false);
      if (reason === "immutable") {
        assert.deepEqual(rows, nativeRows); assert.equal(controller.cacheStats().entries, 0); assert.equal(controller.active, true);
      } else if (reason === "throw") {
        assert.equal(controller.active, false); assert.equal(item.render, original); assert.equal(Object.hasOwn(item, "render"), false);
        assert.deepEqual(rows, [...nativeRows, "NATIVE_SUFFIX"]);
      } else { assert.equal(item.render, later); }
    } finally { controller.restore(); }
    if (reason === "later-owner") assert.equal(item.render, later);
  }
});
