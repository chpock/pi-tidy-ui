import "./fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { Box, visibleWidth, parseColor, colorToRgb } from "@earendil-works/pi-tui";
import { ToolExecutionComponent as NativeToolExecution, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { cardGeometry, frameRows, insidePanel } from "../src/card-frame.ts";
import { editorGeometry } from "../src/editor-card.ts";
import { measureFileCard } from "../src/file-card.ts";
import type { CardTheme } from "../src/card-theme.ts";
import { LAYOUT_KINDS, RenderCache } from "../src/render-cache.ts";
import { UserMessageComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { initTheme, theme as nativeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { menuPage, setAppearance } from "./helpers/menu-driver.ts";
import { Container, Root, Text, Tool, bashTool, color, editDiff, extensionHarness, installTidyUi, mouse, plain, setup, spinnerFrames } from "./fixtures/sdk-contract-support.ts";

test("shared frame accepts unrelated bodies and paint without host/tool state", () => {
  const g = cardGeometry(12);
  assert.deepEqual([g.marginLeft, g.marginRight, g.borderWidth, g.paddingLeft, g.paddingRight, g.contentX, g.contentWidth], [1, 1, 1, 1, 1, 3, 7]);
  const painted: string[] = [];
  const rows = frameRows(g, ["hello", "user"], { panel: (text) => { painted.push(text); return text; }, border: (text) => text });
  assert.deepEqual(rows.map(plain), [" ┃          ", " ┃ hello    ", " ┃ user     ", " ┃          "]);
  assert.deepEqual(painted, ["         ", " hello   ", " user    ", "         "], "panel painter never receives the stripe");
  assert.throws(() => frameRows(g, ["overflow"], { panel: (text) => text, border: (text) => text }), RangeError);
  assert.deepEqual(frameRows(cardGeometry(0), [], { panel: (text) => text, border: (text) => text }), []);
  assert.ok(insidePanel(g, 4, 1, 0)); assert.ok(insidePanel(g, 4, 10, 3));
  for (const point of [[0, 0], [11, 0], [1, -1], [1, 4]]) assert.equal(insidePanel(g, 4, point[0], point[1]), false);
  const origins = [0, 0, 1, 2, 2, 2, 3, 3];
  for (let width = 1; width < 8; width++) {
    const narrow = cardGeometry(width);
    assert.equal(narrow.contentX, origins[width]); assert.equal(narrow.contentWidth, Math.max(1, width - 5));
    assert.ok(frameRows(narrow, ["x"], { panel: (text) => text, border: (text) => text }).every((row) => visibleWidth(row) === width));
  }
});

test("failed stripe and footer share error foreground, never a background-token color", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  const foregrounds: [string, string][] = [], backgrounds: string[] = [];
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => { foregrounds.push([role, text]); return text; },
    bg: (role, text) => { backgrounds.push(role); return text; },
    style: () => { throw new Error("Stripe must use the same semantic foreground as the footer"); },
  };
  const controller = installTidyUi(root, () => theme);
  try {
    for (const result of [
      { content: [], details: { exit_code: 7 }, isError: false },
      { content: [], details: { exit_code: 0 }, isError: true },
      { content: [], isError: true },
    ]) {
      foregrounds.length = 0; backgrounds.length = 0; tool.result = result; tool.isPartial = false;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text === "┃"));
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text.startsWith("[")));
      assert.deepEqual([...new Set(backgrounds)], ["toolPendingBg"]);
    }
    for (const partial of [false, true]) {
      foregrounds.length = 0;
      tool.result = { content: [], details: { exit_code: partial ? 7 : 0 }, isError: partial }; tool.isPartial = partial;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "borderMuted" && text === "┃"));
      assert.ok(!foregrounds.some(([role]) => role === "error"));
    }
  } finally { controller.restore(); }
});

test("one-column padding reserves both sides without losing long command characters", () => {
  const command = `python3 -c "from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))" && node --check /tmp/neon-blocks-check.js`;
  const tool = bashTool(command); tool.args.description = "Validate game JavaScript syntax";
  const before = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    for (let width = 6; width <= 180; width++) {
      const rows = tool.render(width).map(plain);
      for (const row of rows) {
        assert.equal(visibleWidth(row), width);
        assert.equal(row[0], " "); assert.equal(row[1], "┃"); assert.equal(row[2], " ");
        assert.equal(row[width - 2], " ", "right inside padding is reserved even on full rows");
        assert.equal(row[width - 1], " ", "right exterior stays outside the panel");
      }
      const first = rows.findIndex((row) => row.slice(3, -2).startsWith("$"));
      assert.ok(first > 0);
      assert.equal(rows.slice(first, -1).map((row) => row.slice(3, -2)).join("").trimEnd(), `$ ${command}`,
        `all characters survive hard wrapping at component width ${width}`);
    }
    assert.deepEqual(tool.args, before);
  } finally { controller.restore(); }
});

test("ordinary and error stripes use terminal-default background, not panel or inherited paint", async () => {
  const root = new Root(), tool = bashTool("true"); root.addChild(tool);
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => `\x1b[38;2;${role === "error" ? "200;30;40" : "120;120;120"}m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
    style: (text) => `\x1b[38;2;80;0;0m${text}\x1b[39m`,
  };
  const controller = installTidyUi(root, () => theme);
  try {
    for (const failed of [false, true]) {
      tool.result = { content: [], isError: failed, details: { exit_code: failed ? 7 : 0 } };
      for (const width of [2, 5, 12, 22]) {
        const rows = tool.render(width);
        const terminal = new xterm.Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
        try {
          await new Promise<void>((done) => terminal.write("\x1b[48;2;99;99;99m" + rows.join("\r\n"), done));
          for (let y = 0; y < rows.length; y++) {
            const line = terminal.buffer.active.getLine(y)!;
            let stripe = -1;
            for (let x = 0; x < width; x++) if (line.getCell(x)!.getChars() === "┃") stripe = x;
            assert.ok(stripe >= 0);
            const cell = line.getCell(stripe)!;
            assert.equal(cell.getBgColorMode(), 0, `default stripe background: failed=${failed}, width=${width}, row=${y}`);
            assert.equal(cell.getFgColor(), failed ? 0xc81e28 : 0x787878, "stripe foreground follows footer error role, never toolErrorBg");
            for (let x = stripe + 1; x < width - (width >= 5 ? 1 : 0); x++) {
              assert.equal(line.getCell(x)!.getBgColor(), 0x202020, "body and internal padding retain panel background");
            }
            assert.equal(visibleWidth(rows[y]!), width);
          }
        } finally { terminal.dispose(); }
      }
    }
  } finally { controller.restore(); }
});

test("unchanged UI frames reuse custom layout; one tool update does not rebuild its neighbors", () => {
  const root = new Root();
  const tools = Array.from({ length: 8 }, (_, i) => {
    const tool = bashTool(`command_${i}`);
    tool.result = { content: [{ type: "text", text: Array.from({ length: 1000 }, (_, j) => `PERF_OUTPUT_${j}`).join("\n") }] };
    root.addChild(tool); return tool;
  });
  let segments = 0;
  const original = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = function (input) { if (input.startsWith("PERF_OUTPUT_")) segments++; return original.call(this, input); };
  const controller = installTidyUi(root, () => color);
  try {
    root.render(80);
    assert.equal(segments, 88, "only first eleven output rows are wrapped once per tool");
    assert.equal(controller.cacheStats().builds, 8);
    segments = 0; const a = root.render(80); const b = root.render(80);
    assert.deepEqual(a, b); assert.equal(segments, 0); assert.equal(controller.cacheStats().builds, 8);
    tools[3].updateResult({ content: [{ type: "text", text: "PERF_OUTPUT_NEW" }] });
    root.render(80); assert.equal(segments, 1); assert.equal(controller.cacheStats().builds, 9);
    root.render(81); assert.equal(controller.cacheStats().builds, 17);
    controller.clearCache(); assert.equal(controller.cacheStats().retainedBytes, 0);
    root.render(81); assert.equal(controller.cacheStats().builds, 25);
    root.clear(); assert.equal(controller.cacheStats().entries, 0);
    controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  } finally { controller.restore(); Intl.Segmenter.prototype.segment = original; }
});

test("reused mutable arguments and results invalidate only through native update methods", () => {
  const tool = new Tool("custom", { query: "before" });
  const root = new Root(); root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) =>
    `\x1b[${role === "error" ? 31 : 37}m${text}\x1b[39m` }));
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("before")));
    const args = tool.args; args.query = "after"; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("after")));
    const beforeError = controller.cacheStats().builds;
    tool.result!.isError = true; tool.result!.content[0].text = "new error"; tool.updateResult(tool.result);
    const errorRows = root.render(80);
    assert.ok(errorRows.some((row) => row.includes("\x1b[31m")), "mutating result in place invalidates the previous success colors");
    assert.doesNotMatch(errorRows.map(plain).join(""), /new error|✓|✗/u);
    assert.equal(controller.cacheStats().builds, beforeError + 1);
    const builds = controller.cacheStats().builds;
    tool.invalidate(); root.render(80); assert.equal(controller.cacheStats().builds, builds + 1);
  } finally { controller.restore(); }
});

test("render cache accounts weak component-owned entries and releases values explicitly", () => {
  const cache = new RenderCache();
  const a = cache.put({ rows: ["a"] }, ["a"]), b = cache.put({ rows: ["b"] }, ["b"]);
  assert.equal(cache.stats().entries, 2); cache.get(a);
  const c = cache.put({ rows: ["c"] }, ["c"]);
  assert.ok(b.value); assert.ok(a.value); assert.ok(c.value);
  assert.equal(cache.stats().entries, 3);
  assert.deepEqual(Object.keys(a).sort(), ["bytes", "value"], "entries contain no owner, raw source or closure fields");
  cache.drop(b); assert.equal(b.value, undefined); assert.equal(cache.stats().entries, 2);
  cache.clear(); assert.equal(a.value, undefined); assert.equal(c.value, undefined);
  assert.equal(cache.stats().retainedBytes, 0); assert.equal(cache.stats().entries, 0);
  const rows = ["x".repeat(1000)], big = cache.put({ rows }, rows);
  assert.equal(cache.get(big)?.rows, rows); assert.equal(cache.stats().entries, 1);
  cache.clear(); assert.equal(big.value, undefined);
});

test("cache lifecycle restores inherited/owned invalidation methods and respects later owners", () => {
  const names = ["updateArgs", "updateResult", "setExpanded", "invalidate"];
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(Tool.prototype, name));
  const tool = new Tool(), { root, controller } = setup([tool]);
  try {
    root.render(80); assert.ok(controller.cacheStats().entries > 0);
    const replacement = function () {};
    Object.defineProperty(Tool.prototype, "updateArgs", { configurable: true, writable: true, value: replacement });
    controller.restore();
    assert.equal(controller.cacheStats().entries, 0); assert.equal(Tool.prototype.updateArgs, replacement);
    for (let i = 1; i < names.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(Tool.prototype, names[i]), originals[i]);
  } finally {
    controller.restore();
    names.forEach((name, i) => { if (originals[i]) Object.defineProperty(Tool.prototype, name, originals[i]!); else Reflect.deleteProperty(Tool.prototype, name); });
  }
});

test("new theme and expansion/structure changes do not leave stale cache geometry or separators", () => {
  const a = new Tool("custom", { query: "x".repeat(80) }), b = new Tool();
  const root = new Root(); root.addChild(a); root.addChild(b);
  let theme = { fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[39m` };
  const controller = installTidyUi(root, () => theme);
  try {
    root.render(80); const built = controller.cacheStats().builds;
    theme = { fg: (_role: string, text: string) => `\x1b[32m${text}\x1b[39m` };
    const changed = root.render(80); assert.ok(changed.some((row) => row.includes("\x1b[32m"))); assert.equal(controller.cacheStats().builds, built + 2);
    root.removeChild(a); assert.notEqual(b.render(80)[0], "", "lazy sibling position repair handles removal");
    a.setExpanded(true); root.addChild(a); assert.ok(root.render(80).some((row) => row.includes("NATIVE")));
  } finally { controller.restore(); }
});

test("optional layout diagnostics distinguish retained estimates from whole-process heap and reject retired controls", async () => {
  const h = extensionHarness("tui", { "tidy-ui-cache-mb": "0.01" });
  const command = h.commands.get("tidy-ui")!.handler;
  let cacheText = '';
  const readCache = async () => { cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache']); };
  const stats = () => cacheMenuStats(cacheText);
  try {
    await h.events.get("session_start")!({}, h.ctx); h.root.render(80);
    assert.ok(h.notices.some(text => /tidy-ui-cache-mb is ignored/u.test(text)));
    await readCache();
    const first = stats(); assert.ok(first.entries > 0); assert.ok(first.processHeapUsedBytes > 0);
    assert.equal(first.retainedBytes, first.stringBytes + first.overheadBytes);
    assert.equal(first.presentationRetainedBytes, first.retainedBytes + first.footerLayout.retainedBytes);
    assert.match(cacheText, /Tidy UI display layouts only/u);
    assert.match(cacheText, /Whole Pi process heap:.*not Tidy UI memory/u);
    assert.doesNotMatch(cacheText, /limitBytes/u);
    for (const invalid of ["cache limit 0", "cache limit -1", "cache cards limit 0", "cache wrong", "cache limit 1 extra"] ) {
      await command(invalid, h.ctx); assert.match(h.notices.at(-1)!, /limits have been removed|Usage:/);
    }
    await readCache(); assert.equal(stats().retainedBytes, first.retainedBytes);
    cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache', 'Clear saved layouts']); assert.equal(stats().entries, 0); assert.equal(stats().retainedBytes, 0);
    h.root.render(80); await setAppearance(command, h.ctx, false); await setAppearance(command, h.ctx, true); h.root.render(80);
    await readCache(); assert.equal(stats().entries, first.entries);
    assert.equal(h.notices.filter(text => /tidy-ui-cache-mb is ignored/u.test(text)).length, 1, "legacy warning is runtime-local, not repeated on every frame/on");
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); }
});

test("actual SDK viewport caches work and permits detached tool collection with active adapter", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/cache-probe.ts"], { encoding: "utf8", timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr);
  const records = JSON.parse(probe.stdout);
  assert.equal(records[0].segments, 88); assert.equal(records[1].segments, 0);
  assert.ok(records.some((record: { detachedToolCollected?: boolean }) => record.detachedToolCollected === true));
  assert.ok(records.some((record: { animatedFirstInstallerCollected?: boolean; spinnerCacheBuildsUnchanged?: boolean }) =>
    record.animatedFirstInstallerCollected === true && record.spinnerCacheBuildsUnchanged === true));
  mkdirSync(".test-artifacts/render-cache-proof", { recursive: true });
  writeFileSync(".test-artifacts/render-cache-proof/sdk.json", JSON.stringify(records, null, 2));
});

test("actual SDK last spinner participant is collected with its live callback and leaves no fallback", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/spinner-gc-probe.ts"], { encoding: "utf8", timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr);
  const record = JSON.parse(probe.stdout);
  assert.deepEqual(record, { lastParticipantCollected: true, callbackRetainedDuringGc: true,
    starts: 1, active: 0, requestsAddedAfterGc: 0, entries: 0, retainedBytes: 0 });
  mkdirSync(".test-artifacts/spinner-render", { recursive: true });
  writeFileSync(".test-artifacts/spinner-render/last-participant-gc.json", JSON.stringify(record, null, 2));
});

test("shared frame restores its panel background after nested background and full resets", async () => {
  const terminal = new xterm.Terminal({ cols: 32, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const role of ["toolPendingBg", "userMessageBg"] as const) {
        const base = colorToRgb(nativeTheme.colors[role]), expected = (base.r << 16) | (base.g << 8) | base.b;
        for (const reset of ["\x1b[49m", "\x1b[0m"]) {
          const geometry = cardGeometry(32);
          const body = nativeTheme.style("X", { bg: nativeTheme.colors.toolDiffAdded, fg: "syntaxKeyword" }) + reset + " neutral";
          const rows = frameRows(geometry, [body], { panel: (text) => nativeTheme.bg(role, text), border: (text) => nativeTheme.fg("borderMuted", text) });
          terminal.reset(); await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
          const line = terminal.buffer.active.getLine(1)!;
          for (let x = geometry.contentX + 1; x < geometry.panelX + geometry.panelWidth; x++) {
            assert.equal(line.getCell(x)!.getBgColorMode(), 0x3000000, "nested resets cannot expose the page inside a panel");
            assert.equal(line.getCell(x)!.getBgColor(), expected, "following text and internal right padding resume the chosen panel background");
          }
          const child = colorToRgb(nativeTheme.colors.toolDiffAdded);
          assert.equal(line.getCell(geometry.contentX)!.getBgColor(), (child.r << 16) | (child.g << 8) | child.b, "nested child background is retained");
          assert.equal(line.getCell(geometry.panelX)!.getBgColorMode(), 0, "stripe remains terminal-default");
          assert.equal(line.getCell(31)!.getBgColorMode(), 0, "exterior right margin remains terminal-default");
          assert.equal(visibleWidth(rows[1]!), 32, "reopening paint never changes geometry");
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("completed compact calls return retained rows directly when no separator is needed", () => {
  const tool = new Tool("read", { path: "example.ts" });
  const { controller } = setup([tool]);
  try {
    const first = tool.render(80);
    assert.strictEqual(tool.render(80), first, "a cache hit without spinner/gap need not copy the row array");
    tool.updateResult({ content: [], isError: true });
    const failed = tool.render(80);
    assert.strictEqual(tool.render(80), failed);
  } finally { controller.restore(); }
});

test("stock renderer functions cannot prove visibility of a reused custom call Box", () => {
  initTheme("dark");
  const definition = createEditToolDefinition("/project");
  class InvisibleBox extends Box { render(_width: number): string[] { return []; } }
  for (const customBox of [new InvisibleBox(), Object.assign(new Box(), { render: (_width: number): string[] => [] }),
    Object.assign(new Box(), { addChild: (_child: Container | Text) => {} })]) {
    const custom: typeof definition = { ...definition, renderCall: () => customBox, renderResult: () => new Text("", 0, 0) };
    const root = new Root(), node = new NativeToolExecution("edit", "reused-custom-box", { path: "example.ts" }, undefined, custom, root as never, "/project");
    root.addChild(node);
    const follower = new Tool("read", { path: "next.txt" }); root.addChild(follower);
    const original = NativeToolExecution.prototype.render;
    const controller = installTidyUi(root, () => nativeTheme);
    try {
      node.updateResult({ content: [], details: { diff: editDiff }, isError: false });
      assert.deepEqual(node.render(140), []);
      custom.renderCall = definition.renderCall; custom.renderResult = definition.renderResult;
      node.updateArgs({ path: "example.ts" });
      assert.deepEqual(original.call(node, 140), [], "stock renderers reuse the previous Box, including its custom render method");
      assert.deepEqual(node.render(140), [], "the custom component remains the native visibility authority after renderer replacement");
      assert.notEqual(follower.render(140)[0], "", "the hidden reused Box creates no phantom predecessor spacing");
    } finally { controller.restore(); }
  }
});

test("split caches classify rendered Bash/diff bodies separately from all ordinary views", () => {
  initTheme("dark");
  const read = new Tool(), bash = bashTool("echo card"), pending = new Tool("edit", { path: "pending.ts" });
  pending.result = undefined; pending.executionStarted = false;
  const failed = new Tool("edit", { path: "failed.ts" }); failed.result = { content: [], isError: true, details: { diff: editDiff } };
  const diff = new Tool("edit", { path: "diff.ts" }); diff.result = { content: [], details: { diff: editDiff } };
  const inline = new Tool("edit", { path: "inline.ts" }); inline.result = { content: [] };
  const user = new UserMessageComponent("ordinary user card");
  const root = new Root(); for (const node of [read, bash, pending, failed, diff, inline, user]) root.addChild(node);
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    const empty = controller.cacheStats();
    assert.equal(empty.retainedBytes, 0, "component storage does not preallocate retained bodies");
    assert.equal("limitBytes" in empty, false);
    root.render(100);
    const cold = controller.cacheStats();
    assert.equal(cold.ordinary.entries, 5, "read, pending/error edit, inline heading and user card are ordinary");
    assert.equal(cold.cards.entries, 2, "only Bash and actual diff bodies enter the card cache");
    assert.equal(cold.entries, 7);
    for (const key of ["retainedBytes", "stringBytes", "overheadBytes", "rows", "entries", "hits", "misses", "builds", "releases", "collected"] as const)
      assert.equal(cold[key], cold.ordinary[key] + cold.cards[key], `aggregate ${key} equals both pools`);
    root.render(100); const warm = controller.cacheStats();
    assert.equal(warm.ordinary.builds, cold.ordinary.builds); assert.equal(warm.cards.builds, cold.cards.builds);
    pending.updateResult({ content: [], details: { diff: editDiff } }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 4); assert.equal(controller.cacheStats().cards.entries, 3);
    pending.updateResult({ content: [], isError: true, details: { diff: editDiff } }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 5); assert.equal(controller.cacheStats().cards.entries, 2);
    diff.updateResult({ content: [] }); root.render(100);
    assert.equal(controller.cacheStats().ordinary.entries, 6); assert.equal(controller.cacheStats().cards.entries, 1);
    bash.setExpanded(true); root.render(100); assert.equal(controller.cacheStats().cards.entries, 1);
    root.render(101); assert.equal(controller.cacheStats().entries, 7, "one latest width, not one retained entry per pool/width");
    controller.clearCache(); assert.equal(controller.cacheStats().ordinary.entries, 0); assert.equal(controller.cacheStats().cards.entries, 0);
    root.render(101); controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  } finally { controller.restore(); }
});

test("component storage retains both accounting groups until their owners are removed", () => {
  const summaries = Array.from({ length: 20 }, (_, i) => new Tool("read", { path: `small_${i}.txt` }));
  const cards = Array.from({ length: 3 }, (_, i) => {
    const node = bashTool(`card_${i}`);
    node.result = { content: [{ type: "text", text: Array.from({ length: 30 }, () => "x".repeat(70)).join("\n") }] };
    return node;
  });
  const { root, controller } = setup([...summaries, ...cards]);
  try {
    const rows = summaries.map(node => node.render(80));
    cards[0]!.render(80); const baseline = controller.cacheStats();
    cards[1]!.render(80); cards[2]!.render(80);
    const retained = controller.cacheStats();
    assert.equal(retained.cards.entries, 3);
    assert.equal(retained.ordinary.retainedBytes, baseline.ordinary.retainedBytes);
    for (const [i, node] of summaries.entries()) assert.strictEqual(node.render(80), rows[i]);
    assert.equal(controller.cacheStats().ordinary.builds, baseline.ordinary.builds);
    root.removeChild(summaries[0]!);
    assert.equal(controller.cacheStats().ordinary.entries, 19); assert.equal(controller.cacheStats().cards.entries, 3);
    root.removeChild(cards[0]!);
    assert.equal(controller.cacheStats().cards.entries, 2); assert.equal(controller.cacheStats().ordinary.entries, 19);
    root.clear(); assert.equal(controller.cacheStats().entries, 0);
  } finally { controller.restore(); }
});

test("forced compact Bash/edit stay ordinary and large bodies remain component-owned",  () => {
  const bash = bashTool("echo compact"), edit = new Tool("edit", { path: "compact.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([bash, edit], { compact: ["bash", "edit"] });
  try {
    root.render(100); assert.equal(controller.cacheStats().ordinary.entries, 2); assert.equal(controller.cacheStats().cards.entries, 0);
  } finally { controller.restore(); }
  const large = new RenderCache();
  const rows = ["x".repeat(5 * 1024 * 1024)]; const entry = large.put({ rows }, rows);
  assert.ok(entry.bytes > 8 * 1024 * 1024); assert.ok(large.get(entry));
  large.clear(); assert.equal(entry.value, undefined);
});

test("layout diagnostics preserve group attribution and ignore retired launch budgets across off/on", async () => {
  const h = extensionHarness("tui", { "tidy-ui-cache-mb": "0.1", "tidy-ui-card-cache-mb": "128" });
  h.root.addChild(bashTool("card"));
  const command = h.commands.get("tidy-ui")!.handler;
  let cacheText = '';
  const readCache = async () => { cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache']); };
  const stats = () => cacheMenuStats(cacheText);
  try {
    await h.events.get("session_start")!({}, h.ctx); h.root.render(80); await readCache();
    assert.equal(stats().ordinary.entries, 1); assert.equal(stats().cards.entries, 1);
    assert.equal(stats().byKind.summary.entries, 1); assert.equal(stats().byKind.bash.entries, 1);
    for (const retired of ["cache cards limit 129", "cache cards limit -1", "cache cards limit NaN", "cache cards limit 0"] ) {
      await command(retired, h.ctx); assert.match(h.notices.at(-1)!, /Usage:/);
    }
    await readCache(); assert.equal(stats().entries, 2);
    await setAppearance(command, h.ctx, false); await setAppearance(command, h.ctx, true); h.root.render(80); await readCache();
    assert.equal(stats().entries, 2);
    assert.equal(h.notices.filter(text => /tidy-ui-card-cache-mb is ignored/u.test(text)).length, 1);
    cacheText = await menuPage(command, h.ctx, ['Status & troubleshooting', 'Display cache', 'Clear saved layouts']); assert.equal(stats().entries, 0);
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); }
});

test("actual SDK mixed card working set stays warm and never evicts ordinary layouts", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/cache-partition-probe.ts"], { encoding: "utf8", timeout: 45000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.detachedEditCollected, true);
  assert.equal(result.observations[0].ordinary.entries, 200); assert.equal(result.observations[0].cards.entries, 27);
  mkdirSync(".test-artifacts/split-cache-proof", { recursive: true });
  writeFileSync(".test-artifacts/split-cache-proof/sdk.json", JSON.stringify(result, null, 2));
});

test("Output padding sets transcript frame margins at both native values and keeps tiny bodies", () => {
  for (const padding of [0, 1]) for (const width of [0, 1, 2, 3, 4, 5, 6, 24, 80]) {
    const geometry = cardGeometry(width, padding);
    if (width >= 6) {
      assert.equal(geometry.marginLeft, padding); assert.equal(geometry.marginRight, padding);
      assert.equal(geometry.contentX, padding + 2); assert.equal(geometry.contentWidth, width - 2 * padding - 3);
      assert.equal(geometry.paddingLeft, 1); assert.equal(geometry.paddingRight, 1);
    }
    const rows = frameRows(geometry, width ? ["x"] : [], { panel: text => text, border: text => text });
    assert.ok(rows.every(row => visibleWidth(row) === width));
    if (width) assert.ok(geometry.contentWidth >= 1);
  }
});

test("Output padding updates every tool layout cache, inline measurement and panel clicks live", () => {
  let padding = 1, settingsReads = 0;
  const compact = new Tool("tidy_ui_padding", { query: "PAD_" + "x".repeat(100) });
  const bash = bashTool(); bash.result = { content: [{ type: "text", text: Array(11).fill("BASH_PAD").join("\n") }] };
  const edit = new Tool("edit", { path: "padding.ts" }); edit.result = { content: [], details: { diff: "-1 const before = 1;\n+1 const after = 2;" } };
  const write = new Tool("write", { path: "padding.ts", content: "const written = 3;\n" });
  const inline = new Tool("edit", { path: "inline-" + "x".repeat(90) + ".ts" }); inline.result = { content: [] };
  const { root, controller } = setup([compact, bash, edit, write, inline], { outputPad: () => { settingsReads++; return padding; } });
  try {
    for (const value of [1, 0, 1]) {
      padding = value; settingsReads = 0; root.render(24);
      assert.equal(settingsReads, 1, "one effective-settings snapshot per document pass, not per tool/neighbor");
      const cold = controller.cacheStats().builds;
      for (const node of [compact, bash, edit, write, inline]) {
        const rows = node.render(24).filter(row => row !== "").map(plain);
        assert.ok(rows.every(row => visibleWidth(row) <= 24 - (node === compact ? padding : 0)));
        assert.equal(rows[0]!.search(/\S/u), padding + (node === inline ? 2 : 0));
        if ([bash, edit, write].includes(node)) {
          assert.ok(rows.every(row => row[padding] === "┃"));
          assert.ok(rows.every(row => row[padding + 1] === " " && row[23 - padding] === " "));
        }
      }
      root.render(24); assert.equal(controller.cacheStats().builds, cold, "unchanged padding is a hot cache hit");
      assert.equal(controller.cacheStats().entries, 5, "one latest layout per tool, no padding-history cache");
      assert.equal(measureFileCard(inline, "/project", 24, padding)!.height, inline.render(24).filter(row => row !== "").length);
      for (const node of [bash, edit, write]) {
        if (padding) for (const x of [0, 23]) assert.equal(node.handleMouse({ ...mouse(1, 24), x }), undefined);
        assert.equal(node.handleMouse({ ...mouse(1, 24), x: padding })?.handled, true, "current stripe is clickable");
        node.setExpanded(false);
      }
    }
    assert.equal(controller.active, true);
  } finally { controller.restore(); }
});

test("Output padding user cards use live native padding without altering Markdown or editor geometry", () => {
  initTheme("dark", false);
  const user = new UserMessageComponent("USER_PADDING **bold** 文字\n\n" + "x".repeat(70));
  const root = new Root(); root.addChild(user);
  const render = UserMessageComponent.prototype.render;
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    for (const padding of [1, 0, 1]) {
      user.setOutputPad(padding);
      const geometry = cardGeometry(24, padding), rows = user.render(24);
      assert.ok(rows.every(row => stripVTControlCharacters(row)[padding] === "┃"));
      const native = render.call(user, geometry.contentWidth + 2 * padding).slice(1, -1);
      assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding + 2, geometry.contentWidth))),
        native.map(row => stripVTControlCharacters(sliceByColumn(row, padding, visibleWidth(row) - 2 * padding))));
      const builds = controller.cacheStats().builds; user.render(24); assert.equal(controller.cacheStats().builds, builds);
      assert.equal(controller.cacheStats().entries, 1);
      assert.equal(editorGeometry(24, 3)!.panelX, 3, "Editor padding is separate");
    }
  } finally { controller.restore(); }
});

test("Output padding summary glyphs, animation and wrapped text share the new origin at narrow widths", () => {
  for (const padding of [0, 1]) {
    const node = new Tool("read", { path: "a/" + "x".repeat(90) });
    const { controller } = setup([node], { outputPad: () => padding });
    try {
      for (const width of [1, 2, 3, 4, 5, 6, 24, 80]) {
        const rows = node.render(width).map(plain);
        assert.ok(rows.every(row => visibleWidth(row) <= Math.max(1, width - padding)));
        if (width >= 6) {
          assert.equal(rows[0]![padding], "→");
          assert.ok(rows[0]!.slice(padding + 2).startsWith("read".slice(0, width - 2 * padding - 2)));
          assert.ok(rows.slice(1).every(row => row.startsWith(" ".repeat(padding + 2))));
        }
        node.updateResult(undefined);
        const running = node.render(width).map(plain);
        assert.ok(running.every(row => visibleWidth(row) <= Math.max(1, width - padding)));
        const x = Math.min(padding, Math.max(0, width - 1 - padding));
        assert.ok(spinnerFrames.includes(running[0]![x]!));
        node.updateResult({ content: [] });
      }
    } finally { controller.restore(); }
  }
});

test("Output padding effective settings remain authoritative when native user padding diverges", () => {
  initTheme("dark", false);
  let padding = 0;
  const user = new UserMessageComponent("PROJECT_PADDING **bold** " + "x".repeat(70));
  const compact = new Tool("read", { path: "project.txt" }), root = new Root(); root.addChild(user); root.addChild(compact);
  const render = UserMessageComponent.prototype.render;
  const controller = installTidyUi(root, () => nativeTheme, { outputPad: () => padding });
  try {
    // Pi's onOutputPadChange assigns the selected value to user messages even when
    // a project override leaves public effective settings at zero.
    user.setOutputPad(1);
    for (const value of [0, 1, 0]) {
      padding = value; root.render(24);
      const rows = user.render(24).filter(row => row !== ""), geometry = cardGeometry(24, padding);
      assert.ok(rows.every(row => stripVTControlCharacters(row)[padding] === "┃"));
      const native = render.call(user, geometry.contentWidth + 2).slice(1, -1);
      assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, geometry.contentX, geometry.contentWidth))),
        native.map(row => stripVTControlCharacters(sliceByColumn(row, 1, visibleWidth(row) - 2))));
      assert.equal(plain(compact.render(24).find(row => row !== "")!)[padding], "→");
      const builds = controller.cacheStats().builds; root.render(24); assert.equal(controller.cacheStats().builds, builds);
      assert.equal((user as unknown as { outputPad: number }).outputPad, 1, "do not mutate native padding to reconcile settings");
    }
  } finally { controller.restore(); }
});

function cacheMenuStats(text: string) {
  const byKind = Object.fromEntries(LAYOUT_KINDS.map(kind => {
    const json = text.split('\n').find(row => row.startsWith(`${kind}: `))?.slice(kind.length + 2);
    assert.ok(json, `missing ${kind} visible cache detail`); return [kind, JSON.parse(json)];
  }));
  const footer = JSON.parse(text.split('\n').find(row => row.startsWith('Footer: '))!.slice(8));
  const presentationEntries = Number(/Saved layouts: (\d+)/u.exec(text)![1]);
  const presentationRetainedBytes = Number(/Estimated retained memory: (\d+)/u.exec(text)![1]);
  return { byKind, entries: presentationEntries - footer.entries, retainedBytes: presentationRetainedBytes - footer.retainedBytes,
    stringBytes: Object.values(byKind).reduce((sum, value) => sum + value.stringBytes, 0),
    overheadBytes: Object.values(byKind).reduce((sum, value) => sum + value.overheadBytes, 0),
    presentationRetainedBytes, footerLayout: footer, processHeapUsedBytes: Number(/Whole Pi process heap: (\d+)/u.exec(text)![1]),
    ordinary: { entries: byKind.summary.entries }, cards: { entries: byKind.bash.entries + byKind.edit.entries + byKind.write.entries } };
}
