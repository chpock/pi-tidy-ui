import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolExecutionComponent as NativeToolExecution, createWriteToolDefinition, createWriteTool, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { describeArgs } from "../../../src/index.ts";
import { cardGeometry } from "../../../src/card-frame.ts";
import { measureFileCard, renderFileCard } from "../../../src/file-card.ts";
import { generateDiffString, generateUnifiedPatch } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import type { CardTheme } from "../../../src/card-theme.ts";
import { initTheme, theme as nativeTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Root, Tool, color, installTidyUi, mouse, plain, setup, type TuiMouseEvent } from "../../fixtures/sdk-contract-support.ts";

// Write classification is presentation-only: Created also includes an existing empty file.
test("write success selects Created/Edited/Replaced/Wrote from saved source, not provider identity", () => {
  const content = 'const proposal = "NOT_RESULT";\n';
  const cases: [object | undefined, string, string][] = [
    [undefined, "Wrote", "const proposal"],
    [{ diff: "+1 const written = 1;\n+2 const next = 2;" }, "Created", "const written"],
    [{ diff: " 1 const retained = 1;\n+2 const appended = 2;" }, "Edited", "const appended"],
    [{ diff: "-1 const removed = 1;\n+1 const replaced = 2;" }, "Replaced", "const replaced"],
    [{ diff: "-1 const cleared = 1;" }, "Replaced", "const cleared"],
    [{ diff: "", noOp: true }, "Wrote", "const proposal"],
    [{ diff: " 1 unchanged", noOp: true }, "Wrote", "const proposal"],
    [{ diff: "+1 INCOMPLETE", truncated: true }, "Wrote", "const proposal"],
  ];
  for (const [details, label, source] of cases) {
    const tool = new Tool("write", { path: "example.ts", content });
    tool.result = { content: [{ type: "text", text: "RESULT_SENTINEL" }], details };
    const snapshot = structuredClone({ args: tool.args, result: tool.result });
    const { controller } = setup([tool]);
    try {
      for (const width of [80, 120, 140]) {
        const rows = tool.render(width).map(plain), text = rows.join("\n");
        assert.ok(text.includes(`← ${label} example.ts`), label);
        assert.ok(text.includes(source)); assert.ok(rows.some(row => row.startsWith(" ┃")));
        assert.doesNotMatch(text, /RESULT_SENTINEL|INCOMPLETE/);
        if (label === "Created" || label === "Wrote") assert.doesNotMatch(text, /\d+ [+-] /);
        else assert.match(text, /\d+ [+-] /);
        if (label === "Replaced" && source === "const replaced")
          assert.equal(rows.some(row => row.includes("const removed") && row.includes("const replaced")), width > 120);
        if ((details as { noOp?: boolean })?.noOp) assert.match(text, /No changes/);
        if ((details as { truncated?: boolean })?.truncated) assert.match(text, /Diff truncated by tool/);
        assert.ok(rows.every(row => visibleWidth(row) <= width));
        const builds = controller.cacheStats().builds;
        assert.deepEqual(tool.render(width).map(plain), rows); assert.equal(controller.cacheStats().builds, builds);
        assert.equal(controller.cacheStats().cards.entries, 1);
      }
      assert.deepEqual({ args: tool.args, result: tool.result }, snapshot);
    } finally { controller.restore(); }
  }
});

test("write lifecycle is path-only compact until final success, including proposed partial/error metadata", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const tool = new Tool("write", { path: "example.ts", content: "PAYLOAD_NEVER_IN_SUMMARY" });
  tool.result = undefined; tool.executionStarted = false;
  const { root, controller, original } = setup([tool]);
  try {
    assert.deepEqual(tool.render(80), [" ← write example.ts"]);
    assert.equal(controller.cacheStats().ordinary.entries, 1); assert.equal(controller.cacheStats().cards.entries, 0);
    tool.markExecutionStarted(); assert.match(tool.render(80)[0]!, /⠋ write example.ts/);
    const partial = { content: [], isError: true, details: { diff: "+1 PROPOSED_DIFF" } };
    tool.updateResult(partial, true); assert.doesNotMatch(root.render(80).join(""), /PROPOSED|PAYLOAD|┃|Created/);
    tool.updateResult(partial); assert.deepEqual(tool.render(80), [" ← write example.ts"]);
    assert.equal(controller.cacheStats().cards.entries, 0);
    tool.updateResult({ content: [], details: { diff: "+1 const written = 1;" } });
    assert.match(tool.render(80).join(""), /← Created example.ts/);
    assert.equal(controller.cacheStats().ordinary.entries, 0); assert.equal(controller.cacheStats().cards.entries, 1);
    const height = tool.render(80).length;
    assert.ok(tool.handleMouse(mouse(height - 1))?.handled); assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(80), original.call(tool, 80));
    tool.setExpanded(false); tool.updateArgs({ path: "new.ts", content: "NEW_CONTENT" }); tool.updateResult({ content: [] });
    assert.match(tool.render(80).join(""), /← Wrote new.ts/); assert.match(tool.render(80).join(""), /NEW_CONTENT/);
  } finally { controller.restore(); }
});

test("write path-only formatting ignores payload access and uses generic fallback without a valid path", () => {
  const args = new Proxy({ path: "example.ts", content: "ignored" }, {
    ownKeys() { assert.fail("path-only write must not enumerate arguments"); },
    get(target, key, receiver) { if (key === "content") assert.fail("path-only write must not read content"); return Reflect.get(target, key, receiver); },
  });
  assert.equal(describeArgs("write", args), "example.ts");
  for (const path of [undefined, "", null, [], 123]) {
    const args = { path, content: "VISIBLE_GENERIC" };
    assert.equal(describeArgs("write", args), describeArgs("ordinary", args));
    assert.match(describeArgs("write", args), /VISIBLE_GENERIC/);
  }
});

test("write validates both metadata formats and classifies globally before context projection", async () => {
  const pairs = [
    ["", "const fresh = 1;\n", "Created"],
    ["const retained = 1;\n", "const retained = 1;\nconst extra = 2;\n", "Edited"],
    ["const old = 1;\n", "const next = 2;\n", "Replaced"],
    ["const erased = 1;\n", "", "Replaced"],
    ["const identical = 1;\n", "const identical = 1;\n", "Wrote"],
  ];
  for (const [before, after, label] of pairs) {
    const numbered = generateDiffString(before!, after!).diff, patch = generateUnifiedPatch("example.ts", before!, after!);
    // A no-op unified patch can contain headers without hunks: unsupported metadata stays native.
    const metadata = before === after ? [{ diff: numbered }] : [{ diff: numbered }, { patch }, { diff: patch }];
    for (const details of metadata) {
      const node = { toolName: "write", args: { path: "example.ts", content: after }, result: { details }, isPartial: false };
      const rendered = renderFileCard(node, undefined, 140, color)!;
      assert.match(rendered.rows.map(plain).join("\n"), new RegExp(`← ${label} example.ts`));
      assert.equal(measureFileCard(node, undefined, 140)!.framed, true);
    }
  }
  const multi = "@@ -1,1 +1,2 @@\n const retained = 1;\n+const first = 2;\n@@ -10,1 +11,0 @@\n-const erased = 10;\n";
  const node = { toolName: "write", args: { path: "example.ts" }, result: { details: { patch: multi } }, isPartial: false };
  assert.match(renderFileCard(node, undefined, 140, color)!.rows.join(""), /← Replaced/);
  const url = new URL("../../../src/file-card.ts", import.meta.url), source = readFileSync(url, "utf8");
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-write-context-"));
  try {
    const alternateSource = source.replace("const DIFF_CONTEXT_LINES = 3;", "const DIFF_CONTEXT_LINES = 0;")
      .replace(/from "([^"]+)"/gu, (_match, specifier: string) =>
        `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
    const file = join(temporary, "file-card.ts"); writeFileSync(file, alternateSource);
    const alternate = await import(pathToFileURL(file).href);
    const rows = alternate.renderFileCard({ ...node, result: { details: { diff: " 1 OLD_CONTEXT\n+2 ADDED" } } }, undefined, 140, color).rows.map(plain).join("\n");
    assert.match(rows, /← Edited/); assert.match(rows, /2 \+ ADDED/); assert.doesNotMatch(rows, /OLD_CONTEXT|Created/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("write plain source preserves all rows, whitespace, Unicode and filename syntax without diff paint", async () => {
  const source = '/* open\ncontinued comment */\nconst family = "👩‍💻 界 é";  \n\n' + 'const v = "' + 'x'.repeat(1600) + '";\n\nTAIL_LAST';
  for (const themeName of ["dark", "light"] as const) {
    initTheme(themeName);
    for (const details of [undefined, { diff: source.split("\n").map((line, index) => `+${index + 1} ${line}`).join("\n") }]) {
      const paints: string[] = [], highlights: string[] = [];
      const paint: CardTheme = { ...nativeTheme,
        fg(role, text) { paints.push(role); return nativeTheme.fg(role, text); },
        bg(role, text) { return nativeTheme.bg(role, text); },
        style() { return assert.fail("plain write must not compute/apply Multiply diff paint"); } };
      const node = { toolName: "write", args: { path: "example.ts", content: source }, result: { details }, isPartial: false };
      for (const width of [24, 80, 140]) {
        const layout = renderFileCard(node, undefined, width, paint, (code, path) => {
          assert.equal(path, "example.ts"); highlights.push(code); return highlightCode(code, getLanguageFromPath(path));
        })!;
        assert.equal(highlights.at(-1), source, "one full resulting source stream is highlighted before wrapping");
        assert.ok(layout.rows.every(row => visibleWidth(row) === width));
        const rows = layout.rows.map(plain), start = rows.findIndex(row => /1 \/\* open/.test(row));
        const gutter = String(source.split("\n").length).length + 2, geometry = cardGeometry(width);
        const fragments = rows.slice(start, -1).map(row => row.slice(geometry.contentX + gutter, geometry.contentX + geometry.contentWidth));
        assert.equal(fragments.join("").replace(/ /g, "").includes('x'.repeat(1600)), true, "long code remains complete, far beyond compact/Bash budgets");
        assert.ok(rows.some(row => row.includes("TAIL_LAST")));
        assert.ok(rows.some(row => /┃ +4 +$/.test(row)), "blank source line keeps its number");
        assert.ok(!paints.some(role => role === "toolDiffAdded" || role === "toolDiffRemoved"));
        assert.ok(rows.join("").includes("👩‍💻")); assert.ok(rows.join("").includes("é"));
        const terminal = new xterm.Terminal({ cols: width, rows: 1, allowProposedApi: true });
        const write = (text: string) => new Promise<void>(resolve => terminal.write("\x1b[0m\r\x1b[2K" + text, resolve));
        try {
          await write(nativeTheme.fg("syntaxComment", "X"));
          const expected = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor();
          const row = layout.rows.find(row => plain(row).includes("continued"))!;
          await write(row);
          assert.equal(terminal.buffer.active.getLine(0)!.getCell(plain(row).indexOf("continued"))!.getFgColor(), expected,
            "native multiline comment color survives plain-source wrapping");
        } finally { terminal.dispose(); }
      }
    }
  }
});

test("write metadata/native/compact/image/hidden guards remain authoritative in every lifecycle phase", () => {
  const states: [Tool["result"], boolean][] = [[undefined, true], [{ content: [], details: { diff: "+1 PROPOSED" } }, true],
    [{ content: [], isError: true, details: { diff: "+1 STALE" } }, false], [{ content: [], details: { diff: "+1 FINAL" } }, false]];
  for (const [result, partial] of states) for (const guard of ["native", "expanded", "image", "hidden", "compact"]) {
    const tool = new Tool("write", { path: "example.ts", content: "CONTENT" }); tool.result = result; tool.isPartial = partial; tool.executionStarted = false;
    if (guard === "expanded") tool.expanded = true;
    if (guard === "hidden") tool.hideComponent = true;
    if (guard === "image") tool.result = { ...result, content: [{ type: "image" }] };
    const { controller, original } = setup([tool], guard === "compact" ? { cards: ["write"], compact: ["write"] } : guard === "native" ? { cards: ["write"] } : {});
    try {
      if (guard === "compact") assert.deepEqual(tool.render(140), [" ← write example.ts"]);
      else assert.deepEqual(tool.render(140), original.call(tool, 140));
    } finally { controller.restore(); }
  }
  for (const details of [{ patch: "@@ -1 +1 @@\n-before\n", diff: "+1 VALID_BUT_LOWER_PRIORITY" }, { diff: 1 }, { patch: null, diff: "+1 IGNORED" }, { diff: "+1missing_space" }]) {
    const tool = new Tool("write", { path: "example.ts", content: "INPUT" }); tool.result = { content: [], details };
    const { controller, original } = setup([tool]);
    try { assert.deepEqual(tool.render(80), original.call(tool, 80)); assert.equal(controller.cacheStats().cards.entries, 0); }
    finally { controller.restore(); }
  }
  class HiddenWrite extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return width < 30 ? ["NATIVE_VISIBLE"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new HiddenWrite("write", { path: "example.ts", content: "HIDDEN" }), follower = new Tool();
  const { controller } = setup([hidden, follower]);
  try {
    assert.deepEqual(hidden.render(80), []); assert.equal(follower.render(80)[0], " → read a.txt");
    assert.match(hidden.render(24).join(""), /← Wrote/); assert.equal(follower.render(24)[0], "");
  } finally { controller.restore(); }
});

test("write failure skips metadata/payload, uses only error paint and tears down its shared clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const starts = t.mock.method(globalThis, "setTimeout"), stops = t.mock.method(globalThis, "clearTimeout");
  const tool = new Tool("write", { path: "example.ts", get content(): string { return assert.fail("failure must not read payload"); } });
  tool.result = undefined;
  const root = new Root(); root.addChild(tool); const roles: string[] = [];
  const controller = installTidyUi(root, () => ({ fg(role, text) { roles.push(role); return text; } }));
  try {
    tool.render(80); assert.equal(starts.mock.calls.length, 1);
    const details = { get patch(): string { return assert.fail("partial/failure must not parse metadata"); } };
    tool.updateResult({ content: [], details, isError: true }, true); tool.render(80); assert.equal(stops.mock.calls.length, 0);
    tool.updateResult({ content: [{ type: "text", text: "ERROR_BODY" }], details, isError: true });
    assert.equal(stops.mock.calls.length, 1); roles.length = 0;
    assert.deepEqual(tool.render(80), [" ← write example.ts"]); assert.ok(roles.every(role => role === "error"));
    const before = root.requests; t.mock.timers.tick(500); assert.equal(root.requests, before);
  } finally { controller.restore(); }
});

test("write measurement and rejected clicks never build source and repeated body renders stay warm",  (t) => {
  const tool = new Tool("write", { path: "example.ts", content: "LONG_SOURCE_" + "x".repeat(1000) }), follower = new Tool();
  const { root, controller } = setup([tool, follower]);
  const segments = t.mock.method(Intl.Segmenter.prototype, "segment");
  try {
    follower.render(80); const builds = controller.cacheStats().builds;
    assert.ok(!segments.mock.calls.some(call => String(call.arguments[0]).startsWith("LONG_SOURCE_")));
    segments.mock.resetCalls();
    for (const event of [{ ...mouse(1), button: "right" as const }, { ...mouse(1), type: "move" as const }, { ...mouse(1), type: "wheel" as const }]) tool.handleMouse(event);
    assert.ok(!segments.mock.calls.some(call => String(call.arguments[0]).startsWith("LONG_SOURCE_")));
    assert.equal(controller.cacheStats().builds, builds);
    const ordinary = controller.cacheStats().ordinary.builds;
    tool.render(80); const bodyBuilds = controller.cacheStats().builds;
    tool.render(80); assert.equal(controller.cacheStats().cards.entries, 1); assert.equal(controller.cacheStats().builds, bodyBuilds);
    assert.equal(controller.cacheStats().ordinary.builds, ordinary);
    root.render(80);
    const warm = controller.cacheStats(); segments.mock.resetCalls(); root.render(80);
    assert.equal(controller.cacheStats().builds, warm.builds); assert.equal(segments.mock.calls.length, 0);
    assert.equal(warm.cards.entries, 1); assert.equal(warm.ordinary.entries, 1);
    assert.equal(tool.handleMouse({ ...mouse(1), x: 0 }), undefined); root.selection = true;
    assert.equal(tool.handleMouse(mouse(1)), undefined); root.selection = false;
    assert.ok(tool.handleMouse(mouse(1))?.handled);
  } finally { controller.restore(); }
});

test("actual SDK write stays provider-neutral for new, empty, replaced and cleared files and delegates expansion", async (t) => {
  initTheme("dark");
  const directory = mkdtempSync(join(tmpdir(), "tidy-ui-stock-write-")), root = new Root();
  const tool = createWriteTool(directory), definition = createWriteToolDefinition(directory);
  const source = Array.from({ length: 22 }, (_, i) => `const stock_${i + 1} = ${i + 1};`).join("\n");
  writeFileSync(join(directory, "empty.ts"), ""); writeFileSync(join(directory, "existing.ts"), "OLD_CONTENT");
  const nodes: NativeToolExecution[] = [];
  const originalRender = NativeToolExecution.prototype.render;
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    for (const [index, args] of [{ path: "new.ts", content: source }, { path: "empty.ts", content: source },
      { path: "existing.ts", content: source }, { path: "existing.ts", content: "" }].entries()) {
      const result = await tool.execute(`write-${index}`, args);
      assert.equal(result.details, undefined, "stock write provides no diff/creation metadata in any case");
      assert.equal(readFileSync(join(directory, args.path), "utf8"), args.content);
      const node = new NativeToolExecution("write", `stock-${index}`, args, undefined, definition, root as never, directory);
      root.addChild(node); nodes.push(node); node.updateResult({ ...result, isError: false });
      const rows = node.render(140).map(plain);
      assert.match(rows.join(""), /← Wrote/); assert.doesNotMatch(rows.join(""), /← Created|← Replaced/);
      if (args.content) assert.match(rows.join("\n"), /22 const stock_22 = 22;/);
    }
    assert.equal(native.mock.calls.length, 0, "stock content-shell writes need no discarded native rendering");
    root.render(140); const builds = controller.cacheStats().builds;
    root.render(140); assert.equal(controller.cacheStats().builds, builds); assert.equal(controller.cacheStats().cards.entries, 4);
    nodes[0]!.setExpanded(true); const actual = nodes[0]!.render(140), original = originalRender.call(nodes[0]!, 140);
    assert.deepEqual(actual, original); assert.ok(native.mock.calls.length > 0);
    nodes[0]!.setExpanded(false); assert.match(nodes[0]!.render(140).map(plain).join(""), /← Wrote/);
    const before = controller.cacheStats().builds;
    nodes[1]!.updateArgs({ path: "empty.ts", content: "const updated = 99;" });
    root.render(140); assert.equal(controller.cacheStats().builds, before + 1, "only changed write source is rebuilt");
    assert.match(nodes[1]!.render(140).map(plain).join(""), /const updated = 99;/);
  } finally { controller.restore(); rmSync(directory, { recursive: true, force: true }); }
});
