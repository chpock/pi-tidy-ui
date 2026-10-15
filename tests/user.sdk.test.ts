import "./fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Spacer, visibleWidth } from "@earendil-works/pi-tui";
import { cardGeometry } from "../src/card-frame.ts";
import { renderUserCard } from "../src/user-card.ts";
import type { CardTheme } from "../src/card-theme.ts";
import { UserMessageComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { initTheme, theme as nativeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { Container, Root, Text, Tool, installTidyUi } from "./fixtures/sdk-contract-support.ts";

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
