import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { visibleWidth, parseColor, colorToRgb, rgbColor, colorToOklch } from "@earendil-works/pi-tui";
import { ToolExecutionComponent as NativeToolExecution, createEditToolDefinition, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { cardGeometry } from "../../../src/card-frame.ts";
import { measureFileCard, renderFileCard } from "../../../src/file-card.ts";
import { generateDiffString, generateUnifiedPatch } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import type { CardTheme } from "../../../src/card-theme.ts";
import { initTheme, loadThemeFromPath, setThemeInstance, theme as nativeTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Root, Text, Tool, color, editDiff, installTidyUi, mouse, plain, setup, spinnerFrames, type TuiMouseEvent } from "../../fixtures/sdk-contract-support.ts";

test("edit cards reproduce OpenCode numbered unified/split diff and cache warm frames", () => {
  const edit = new Tool("edit", { path: "src/example.ts", oldText: "PROPOSAL_OLD", newText: "PROPOSAL_NEW" });
  edit.result = { content: [{ type: "text", text: "RESULT_BODY" }], details: { diff: editDiff } };
  const snapshot = structuredClone({ args: edit.args, result: edit.result });
  const { root, controller, original } = setup([edit, new Tool()]);
  try {
    const rows = edit.render(120).map(plain);
    assert.ok(rows.some((row) => row.includes("← Edited src/example.ts")));
    assert.ok(rows.some((row) => /2 - const before = 2;/.test(row)));
    assert.ok(rows.some((row) => /2 \+ const after = 3;/.test(row)));
    assert.ok(rows.some((row) => /4   const tail = 5;/.test(row)), "context uses the new-file number after an insertion");
    assert.doesNotMatch(rows.join(""), /PROPOSAL_|RESULT_BODY/);
    const builds = controller.cacheStats().builds;
    assert.deepEqual(edit.render(120).map(plain), rows);
    assert.equal(controller.cacheStats().builds, builds);
    const split = edit.render(121).map(plain);
    assert.ok(split.some((row) => row.includes("const before = 2;") && row.includes("const after = 3;")), "replacement sides align on one row above 120 columns");
    assert.ok(split.some((row) => /3   const tail = 5;.*4   const tail = 5;/.test(row)), "split keeps old and new context numbers");
    assert.equal(root.render(121).filter((row) => row === "").length, 1, "one separator after a diff card");
    for (let width = 0; width < 30; width++) assert.ok(edit.render(width).every((row) => visibleWidth(row) <= width));
    assert.deepEqual({ args: edit.args, result: edit.result }, snapshot);
    edit.setExpanded(true); assert.deepEqual(edit.render(80), original.call(edit, 80));
  } finally { controller.restore(); }
});

test("one-sided edits use full-width unified rows for numbered and unified metadata", () => {
  const before = 'const marker = "+ -";\nconst tail = 2;\n';
  const inserted = 'const added = "' + 'wide_source '.repeat(7) + '";\n';
  const after = before.replace('const tail', inserted + 'const tail');
  for (const [oldSource, newSource, sign] of [[before, after, "+"], [after, before, "-"]] as const) {
    const diff = generateDiffString(oldSource, newSource).diff;
    const patch = generateUnifiedPatch("one-sided.ts", oldSource, newSource);
    for (const details of [{ diff }, { patch }, { diff: patch }]) for (const width of [120, 121, 140, 141, 200]) {
      const snapshot = structuredClone(details);
      const rows = renderFileCard({ args: { path: "one-sided.ts" }, isPartial: false, result: { details } }, undefined, width, color)!.rows.map(plain);
      assert.equal(rows.join("\n").split('const marker = "+ -";').length - 1, 1, "context is shown once, not in two panes; code punctuation is not a diff sign");
      const source = rows.find(row => row.includes("const added"))!;
      assert.ok(source); assert.ok(source.includes(`2 ${sign} const added`));
      assert.ok(source.indexOf("const added") < width / 2, "both insertions and deletions start in the unified gutter");
      if (width > 120) assert.ok(source.includes(inserted.trim()), "code uses the full width, not a half-pane wrap");
      assert.ok(rows.every(row => visibleWidth(row) <= width));
      assert.deepEqual(details, snapshot);
    }
  }
});

test("one-sided mode is selected globally across hunks and invalidated on metadata updates", () => {
  const tool = new Tool("edit", { path: "one-sided.ts" });
  const onlyAdds = "@@ -1,1 +1,2 @@\n const anchor = 1;\n+const a = 2;\n@@ -10,1 +11,2 @@\n const other = 10;\n+const b = 11;\n";
  const mixed = "@@ -1,1 +1,0 @@\n-const removed = 1;\n@@ -8,0 +8,1 @@\n+const inserted = 8;\n";
  tool.result = { content: [], details: { patch: onlyAdds } };
  const { controller } = setup([tool]);
  try {
    for (const patch of [onlyAdds, mixed, onlyAdds]) {
      tool.updateResult({ content: [], details: { patch } });
      const rows = tool.render(140), inserted = rows.map(plain).find(row => row.includes(patch === mixed ? "const inserted" : "const b"))!;
      assert.equal(inserted.indexOf("const ") > 70, patch === mixed, "different-hunk deletion/insertion is still a mixed split card");
      const builds = controller.cacheStats().builds;
      assert.deepEqual(tool.render(140), rows); assert.equal(controller.cacheStats().builds, builds);
      assert.equal(controller.cacheStats().cards.entries, 1, "latest card only; same retention pool in both modes");
    }
    const noChanges = renderFileCard({ args: tool.args, isPartial: false, result: { details: { diff: ' 1 const unchanged = 1;' } } }, undefined, 140, color)!.rows.map(plain);
    assert.ok(noChanges.some(row => row.includes("← Edited one-sided.ts")));
    assert.doesNotMatch(noChanges.join("\n"), /const unchanged/, "context-only metadata preserves the existing title-only frame projection");
  } finally { controller.restore(); }
});

test("successful edit framed and metadata-free headings share the Bash description origin without extra inset", () => {
  const bash = new Tool("bash", { command: "true", description: "Heading" });
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { controller } = setup([bash, edit]);
  try {
    for (const width of [24, 80, 120, 141]) {
      const bashHeading = bash.render(width).map(plain).find((row) => row.includes("# Heading"))!;
      const editHeading = edit.render(width).map(plain).find((row) => row.includes("← Edited"))!;
      assert.equal(editHeading.indexOf("←"), bashHeading.indexOf("#"), "framed edit title starts at the same content column as Bash comments");
      edit.updateResult({ content: [] });
      assert.equal(edit.render(width).map(plain).find((row) => row.includes("←"))!.indexOf("←"), bashHeading.indexOf("#"), "successful metadata-free heading remains aligned without a stripe");
      edit.updateResult({ content: [], details: { diff: editDiff } });
    }
  } finally { controller.restore(); }
});

test("edit context keeps three available lines around changes and hides only edge omission markers", () => {
  const before = Array.from({ length: 30 }, (_, index) => `source_${index + 1}`).join("\n") + "\n";
  const after = before.replace("source_10\n", "changed_10\ninserted_11\n").replace("source_22\n", "changed_22\n");
  const details = { diff: generateDiffString(before, after).diff, patch: generateUnifiedPatch("example.txt", before, after) };
  const snapshot = structuredClone(details);
  for (const metadata of [{ diff: details.diff }, { patch: details.patch }]) for (const width of [100, 140]) {
    const rows = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details: metadata } }, undefined, width, color)!.rows.map(plain);
    const source = rows.filter((row) => /source_|changed_|inserted_|…/.test(row));
    for (const line of [7, 8, 9, 11, 12, 13, 19, 20, 21, 23, 24, 25]) assert.ok(source.some((row) => new RegExp(`source_${line}(?!\\d)`).test(row)), `nearby context line ${line} is retained`);
    for (const line of [6, 14, 18, 26]) assert.ok(!source.some((row) => new RegExp(`source_${line}(?!\\d)`).test(row)), `fourth context line ${line} is omitted`);
    for (const change of ["source_10", "changed_10", "inserted_11", "source_22", "changed_22"]) assert.ok(source.some((row) => row.includes(change)), "all removed/added source is preserved");
    assert.doesNotMatch(source[0]!, /…/, "no leading omission row");
    assert.doesNotMatch(source.at(-1)!, /…/, "no trailing omission row");
    if ("diff" in metadata) assert.equal(source.filter((row) => row.includes("…")).length, 1, "internal omitted interval still separates changes");
    assert.match(source.join("\n"), /10 - source_10/);
    assert.match(source.join("\n"), /11 \+ inserted_11/);
    assert.match(source.join("\n"), /23 \+ changed_22/, "new-file numbering is never renumbered after context trimming");
  }
  assert.deepEqual(details, snapshot, "context projection is display-only");
  const literal = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details: { diff: ' ...\n-10 literal … before\n+10 literal … after\n ...' } } }, undefined, 100, color)!.rows.map(plain).join("\n");
  assert.match(literal, /literal … before/); assert.match(literal, /literal … after/);
  assert.equal(literal.split("\n").filter((row) => row.includes("…")).length, 2, "literal ellipsis inside code is not stripped");
});

test("edit context merges overlapping windows once and marks omitted interiors", () => {
  for (const length of [0, 2, 6, 7, 8, 12]) {
    const bridge = Array.from({ length }, (_, index) => `bridge_${index}`);
    const before = [...Array.from({ length: 8 }, (_, index) => `lead_${index}`), "OLD_A", ...bridge, "OLD_B", ...Array.from({ length: 8 }, (_, index) => `tail_${index}`)].join("\n") + "\n";
    const after = before.replace("OLD_A", "NEW_A").replace("OLD_B", "NEW_B");
    for (const details of [{ diff: generateDiffString(before, after, 20).diff }, { patch: generateUnifiedPatch("example.txt", before, after, 20) }]) {
      const rows = renderFileCard({ args: { path: "example.txt" }, isPartial: false, result: { details } }, undefined, 100, color)!.rows.map(plain);
      const text = rows.join("\n"), indices = [...text.matchAll(/bridge_(\d+)/g)].map((match) => Number(match[1]));
      assert.deepEqual(indices, bridge.map((_, index) => index).filter((index) => index < 3 || index >= length - 3), "overlapping context is shown once; wide interiors keep only nearest three rows");
      assert.equal(rows.filter((row) => row.includes("…")).length, length > 6 ? 1 : 0, "only an actually omitted interior needs an ellipsis row");
      for (const token of ["OLD_A", "NEW_A", "OLD_B", "NEW_B"]) assert.match(text, new RegExp(token));
    }
  }
});

test("edit context constant controls projection without fetching unavailable source", async () => {
  const url = new URL("../../../src/file-card.ts", import.meta.url), source = readFileSync(url, "utf8");
  const declaration = "const DIFF_CONTEXT_LINES = 3;";
  assert.ok(source.includes(declaration), "context is configured by one source constant, defaulting to three");
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-edit-context-"));
  try {
    const before = Array.from({ length: 20 }, (_, index) => `source_${index + 1}`).join("\n") + "\n", after = before.replace("source_10\n", "changed_10\n");
    for (const count of [0, 1, 6]) {
      const configured = source.replace(declaration, `const DIFF_CONTEXT_LINES = ${count};`)
        .replace(/from "([^"]+)"/gu, (_match, specifier: string) => `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
      const file = join(temporary, `edit-${count}.ts`); writeFileSync(file, configured);
      const alternate = await import(pathToFileURL(file).href);
      for (const available of [2, 8]) {
        const node = { args: { path: "example.txt" }, isPartial: false, result: { details: { diff: generateDiffString(before, after, available).diff } } };
        const text = alternate.renderFileCard(node, undefined, 100, color).rows.map(plain).join("\n");
        assert.equal([...text.matchAll(/source_(\d+)/g)].filter((match) => Number(match[1]) !== 10).length, 2 * Math.min(count, available));
        assert.match(text, /10 - source_10/); assert.match(text, /10 \+ changed_10/);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("edit context projection preserves syntax opened on the omitted fourth context line", async () => {
  initTheme("dark");
  const samples = [
    { before: "/* opening comment\ncontext_a\ncontext_b\ncontext_c\nold_token\ncontext_d\ncontext_e\ncontext_f\n*/\n", role: "syntaxComment" },
    { before: "const value = `opening template\ncontext_a\ncontext_b\ncontext_c\nold_token\ncontext_d\ncontext_e\ncontext_f\nend`;\n", role: "syntaxString" },
  ] as const;
  const terminal = new xterm.Terminal({ cols: 140, rows: 10, allowProposedApi: true });
  try {
    for (const { before, role } of samples) for (const width of [100, 140]) {
      const after = before.replace("old_token", "new_token");
      terminal.reset(); await new Promise<void>((done) => terminal.write(nativeTheme.fg(role, "X"), done));
      const expected = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor();
      if (role === "syntaxString") {
        terminal.reset(); await new Promise<void>((done) => terminal.write(nativeTheme.fg("toolOutput", "X"), done));
        assert.notEqual(expected, terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), "template case proves syntax color, not merely default foreground");
      }
      const rows = renderFileCard({ args: { path: "example.ts" }, isPartial: false,
        result: { details: { patch: generateUnifiedPatch("example.ts", before, after) } } }, undefined, width, nativeTheme,
        (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows;
      assert.ok(!rows.some((row) => plain(row).includes("opening")), "fourth context line is not displayed");
      for (const token of ["old_token", "new_token"]) {
        const row = rows.find((value) => plain(value).includes(token))!;
        terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
        assert.equal(terminal.buffer.active.getLine(0)!.getCell(plain(row).indexOf(token))!.getFgColor(), expected, "highlight full supplied source before projecting context");
      }
    }
  } finally { terminal.dispose(); }
});

test("edit compact pending/error states, metadata updates, native/compact overrides and malformed fallback", () => {
  const edit = new Tool("edit", { path: "example.ts" }); edit.result = undefined; edit.executionStarted = false;
  const { controller, original } = setup([edit]);
  try {
    assert.match(edit.render(80).map(plain).join(""), /← edit example.ts/);
    assert.doesNotMatch(edit.render(80).map(plain).join(""), /┃|← Edited/);
    edit.updateResult({ content: [{ type: "text", text: "FAILURE_BODY" }], isError: true, details: { diff: editDiff } });
    assert.doesNotMatch(edit.render(80).map(plain).join(""), /const before|FAILURE_BODY/);
    assert.equal(edit.handleMouse(mouse(0))?.handled, true);
    assert.equal(edit.expanded, true);
    edit.setExpanded(false);
    edit.updateResult({ content: [], details: { diff: editDiff } });
    assert.match(edit.render(80).map(plain).join(""), /┃/);
    edit.updateResult({ content: [], details: { diff: "UNSUPPORTED_DIFF_FORMAT" } });
    assert.deepEqual(edit.render(80), original.call(edit, 80));
    edit.updateResult({ content: [], details: { diff: "" } });
    assert.match(edit.render(80).map(plain).join(""), /┃.*← Edit/);
  } finally { controller.restore(); }
  for (const options of [{ cards: ["edit"] }, { compact: ["edit"] }]) {
    edit.result = { content: [], details: { diff: editDiff } };
    const context = setup([edit], options);
    try {
      if (options.cards) assert.deepEqual(edit.render(80), context.original.call(edit, 80));
      else assert.match(edit.render(80).map(plain).join(""), /← edit example.ts/);
    } finally { context.controller.restore(); }
  }
});

test("edit syntax colors survive changed-row backgrounds, gutters and wrapped split alignment", async () => {
  const before = 'export const before = 10;\nconst label = "old";\n// old comment\n';
  const after = 'export const after = 20;\nconst label = "new";\n// new comment\n';
  const diff = generateDiffString(before, after).diff;
  const patch = generateUnifiedPatch("example.ts", before, after);
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { diff, patch } } };
  const terminal = new xterm.Terminal({ cols: 140, rows: 60, allowProposedApi: true });
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const painted = renderFileCard(node, undefined, 140, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
      const row = painted.rows.find((value) => plain(value).includes("before = 10;") && plain(value).includes("after = 20;"))!;
      assert.ok(row, "removed/added replacements share the same split visual row");
      terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
      const text = plain(row), codeCell = (value: string) => terminal.buffer.active.getLine(0)!.getCell(text.indexOf(value))!;
      assert.equal(text.indexOf("export"), 8, "shared-frame origin + OpenTUI left-padded number/sign gutter, without an extra diff inset");
      const keyword = codeCell("export"), number = codeCell("10"), newNumber = codeCell("20");
      assert.notEqual(keyword.getFgColor(), number.getFgColor(), "syntax keyword and number retain distinct foreground colors on a deletion");
      assert.equal(number.getFgColor(), newNumber.getFgColor(), "the same syntax category is not recolored red/green by edit kind");
      assert.notEqual(number.getBgColor(), newNumber.getBgColor(), "removed and added rows have different backgrounds");
      assert.equal(number.getBgColorMode(), 0x3000000, "changed code has a concrete tinted background");
      assert.equal(keyword.getBgColor(), number.getBgColor(), "background covers all syntax spans");
      for (const [role, code, sign] of [["toolDiffRemoved", number, "-"], ["toolDiffAdded", newNumber, "+"]] as const) {
        assert.notEqual(code.getBgColor(), codeCell(sign).getBgColor(), `${role}: code and number/sign gutter are independent surfaces`);
        const foreground = colorToRgb(nativeTheme.colors[role]);
        assert.equal(codeCell(sign).getFgColor(), foreground.r << 16 | foreground.g << 8 | foreground.b, 'diff sign retains its theme color');
        assert.equal(codeCell(sign).getBgColorMode(), 0x3000000, "gutter has a concrete tinted background");
        const lineNumber = terminal.buffer.active.getLine(0)!.getCell(text.indexOf(sign) - 2)!;
        assert.equal(lineNumber.getBgColor(), codeCell(sign).getBgColor(), `${role}: line number and sign share one gutter surface`);
      }
      const reference = highlightCode(before, "typescript")[0]!;
      terminal.reset(); await new Promise<void>((done) => terminal.write(reference, done));
      assert.equal(keyword.getFgColor(), terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), "keyword matches the public syntax renderer");
      assert.equal(number.getFgColor(), terminal.buffer.active.getLine(0)!.getCell(before.indexOf("10"))!.getFgColor(), "number matches the public syntax renderer");
    }
    const long = { args: { path: "example.ts" }, isPartial: false, result: { details: { diff: '-1 const short = 1;\n+1 const long = "' + "界é ".repeat(40) + '";\n 2 const next = 2;' } } };
    const rows = renderFileCard(long, undefined, 121, color)!.rows.map(plain);
    const end = rows.findIndex((row) => row.includes("const next = 2;"));
    assert.ok(end > 5, "right pane wraps several rows before the next pair");
    assert.equal(rows[end].match(/const next = 2;/g)?.length, 2, "the next context stays horizontally aligned after unequal wrapping");
    assert.equal(rows.filter((row) => row.includes("const short = 1;")).length, 1, "short counterpart is not repeated");
    assert.ok(rows.every((row) => visibleWidth(row) <= 121));
  } finally { terminal.dispose(); }
});

test("split edit one-to-many HTML replacement fills empty panes and internal right padding", async () => {
  const before = '<meta charset="utf-8">\n<style>\n  :root { --bg: #0b1020; }\n  body { background: radial-gradient(ellipse at 50% 8%, #202b52 0, #10172c 38%, var(--bg) 75%); }\n</style>\n</head>\n<body>\n';
  const after = '<meta charset="utf-8">\n<link rel="stylesheet" href="styles.css">\n<body>\n';
  const terminal = new xterm.Terminal({ cols: 141, rows: 60, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const base = colorToRgb(nativeTheme.colors.toolPendingBg), expected = (base.r << 16) | (base.g << 8) | base.b;
      for (const [oldText, newText] of [[before, after], [after, before]]) {
        const node = { args: { path: "index.html" }, isPartial: false,
          result: { details: { diff: generateDiffString(oldText, newText).diff, patch: generateUnifiedPatch("index.html", oldText, newText) } } };
        for (const width of [121, 140, 141]) {
          const geometry = cardGeometry(width), paneWidth = geometry.contentWidth, rightX = geometry.contentX + Math.floor(paneWidth / 2);
          const rows = renderFileCard(node, undefined, width, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows;
          terminal.resize(width, 60); terminal.reset(); await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
          const link = rows.findIndex((row) => plain(row).includes('<link rel="stylesheet"'));
          const context = rows.findIndex((row) => plain(row).includes("<body>"));
          assert.ok(context > link + 2, "unequal replacement has both wrapped and unmatched rows before context");
          for (let y = 0; y < rows.length; y++) {
            const line = terminal.buffer.active.getLine(y)!;
            assert.equal(visibleWidth(rows[y]!), width);
            assert.equal(line.getCell(width - 2)!.getBgColorMode(), 0x3000000, "last internal padding cell is not page-colored");
            assert.equal(line.getCell(width - 2)!.getBgColor(), expected, "right padding keeps neutral card background even after added code");
            assert.equal(line.getCell(width - 1)!.getBgColorMode(), 0, "exterior margin is not widened or painted");
            for (let x = geometry.contentX; x < width - 1; x++) assert.equal(line.getCell(x)!.getBgColorMode(), 0x3000000, "all panel cells remain painted, including empty counterparts");
            if (y > link && y < context && plain(rows[y]!).slice(rightX, width - 2).trim() === "") {
              for (let x = rightX; x < width - 2; x++) assert.equal(line.getCell(x)!.getBgColor(), expected, "empty right pane resumes neutral panel background");
            }
          }
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("edit diff has exactly one neutral panel padding cell on both sides", async () => {
  const terminal = new xterm.Terminal({ cols: 141, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const base = colorToRgb(nativeTheme.colors.toolPendingBg), neutral = (base.r << 16) | (base.g << 8) | base.b;
      for (const width of [100, 121, 140, 141]) {
        const geometry = cardGeometry(width);
        const rows = renderFileCard({ args: { path: "example.ts" }, isPartial: false, result: { details: { diff: '-1 const before = 10;\n+1 const after = 20;' } } }, undefined, width, nativeTheme)!.rows;
        const row = rows.find((value) => plain(value).includes("const before"))!;
        terminal.resize(width, 10); terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
        const line = terminal.buffer.active.getLine(0)!;
        assert.equal(geometry.paddingLeft, 1); assert.equal(geometry.paddingRight, 1);
        assert.equal(line.getCell(geometry.contentX - 1)!.getBgColor(), neutral, "single neutral cell before the changed gutter");
        assert.notEqual(line.getCell(geometry.contentX)!.getBgColor(), neutral, "diff background starts immediately at content origin, including its own gutter padding");
        assert.notEqual(line.getCell(width - 3)!.getBgColor(), neutral, "changed code fills the final content cell");
        assert.equal(line.getCell(width - 2)!.getBgColor(), neutral, "single neutral cell after the diff");
        assert.equal(line.getCell(width - 1)!.getBgColorMode(), 0, "exterior margin remains outside the panel");
        assert.ok(rows.some((value) => plain(value).includes("← Edited example.ts")), "only presentation label changes to past tense");
      }
    }
  } finally { terminal.dispose(); }
});

test('edit adaptive palette bounds saturated/neutral, black/white and indexed inputs', async () => {
  initTheme('dark');
  for (const [background, semantic, foreground] of [
    ['#000000', '#00ff00', '#ffffff'], ['#ffffff', '#ff00ff', '#000000'],
    ['#08090a', 10, '#dddddd'], [8, 9, '#ffffff'], ['#283840', '#ff00ff', '#ffffff'],
    ['#ff0000', '#00ffff', '#ffffff'], ['#00ff00', '#ff00ff', '#000000'], ['#0000ff', '#ffff00', '#ffffff'],
  ] as const) {
    const colors: NonNullable<CardTheme['colors']> = { toolPendingBg: parseColor(background), toolSuccessBg: parseColor(semantic),
      toolErrorBg: parseColor(semantic), toolOutput: parseColor(foreground), dim: parseColor(foreground),
      toolDiffAdded: parseColor(foreground), toolDiffRemoved: parseColor(foreground) };
    const paint: CardTheme = { colors, fg: (role, text) => nativeTheme.style(text, { fg: colors[role] }), style: nativeTheme.style.bind(nativeTheme),
      bg: (_role, text) => nativeTheme.style(text, { bg: colors.toolPendingBg }) };
    const base = colorToOklch(colors.toolPendingBg!), baseAngle = base.h * Math.PI / 180;
    for (const width of [100, 140]) for (const surface of await paletteCells(paint, width)) {
      const actual = colorToOklch(rgbColor(surface.code.r, surface.code.g, surface.code.b)), angle = actual.h * Math.PI / 180;
      assert.ok(Math.abs(actual.l - base.l) < 0.03, 'code lightness stays near its panel, including gamut edges');
      assert.ok(Math.hypot(actual.c * Math.cos(angle) - base.c * Math.cos(baseAngle), actual.c * Math.sin(angle) - base.c * Math.sin(baseAngle)) < 0.024,
        'strong semantic panels cannot become saturated diff fills');
      const ink = colorToRgb(colors.toolOutput!);
      for (const region of [surface.code, surface.gutter]) assert.ok(paletteContrast(ink, region) >= Math.min(4.5, paletteContrast(ink, colorToRgb(colors.toolPendingBg!))));
    }
  }
});

test("edit metadata formats preserve numbered contexts, multiple hunks and no-newline code", () => {
  const before = "HEAD\n" + Array.from({ length: 30 }, (_, i) => `context ${i}`).join("\n") + "\nTAIL";
  const after = before.replace("HEAD", "NEW_HEAD\nINSERTED").replace("TAIL", "NEW_TAIL");
  const diff = generateDiffString(before, after).diff;
  const patch = generateUnifiedPatch("example.txt", before, after);
  const render = (details: object) => renderFileCard({ args: { path: "/project/example.txt" }, isPartial: false, result: { details } }, "/project", 121, color);
  const numbered = render({ diff })!.rows.map(plain).join("\n");
  assert.match(numbered, /← Edited example.txt/);
  assert.match(numbered, /1 - HEAD.*1 \+ NEW_HEAD/);
  assert.match(numbered, /32 - TAIL.*33 \+ NEW_TAIL/);
  assert.match(numbered, /…/);
  const unified = render({ diff, patch })!.rows.map(plain).join("\n");
  assert.match(unified, /32 - TAIL.*33 \+ NEW_TAIL/);
  assert.doesNotMatch(unified, /@@|---|No newline/);
  assert.equal(render({ patch: "@@ -1,2 +1,1 @@\n-one\n+two\n" }), undefined, "inconsistent hunk counts delegate to native");
  assert.equal(render({ patch: "@@ -0,1 +1,1 @@\n-one\n+two\n" }), undefined, "a real line cannot have number zero");
  assert.equal(render({ diff: "+NaN junk" }), undefined);
  assert.match(render({ diff: '+1 const text = "@@ -not a patch";' })!.rows.map(plain).join(""), /@@ -not a patch/);
  const diagnostics = render({ diff, diagnostics: [{ severity: "error", line: 2, message: "Typed error" }, { severity: "warning", message: "Warning" }] })!.rows.map(plain).join("\n");
  assert.match(diagnostics, /Error \[2\]: Typed error/); assert.doesNotMatch(diagnostics, /Warning/);
});

test("edit presentation sanitizes terminal controls but preserves Unicode, indentation and code whitespace", () => {
  const args = { file_path: "界é.ts\x1b]52;c;evil\x07", newText: "PROPOSAL" };
  const source = "\tconst family = '👨‍👩‍👧‍👦 界é';  \x1b[31m\u202ehidden\u202c";
  const result = { details: { diff: "+1 " + source } };
  const snapshot = structuredClone({ args, result });
  for (let width = 1; width < 125; width++) {
    const rows = renderFileCard({ args, result, isPartial: false }, undefined, width, color)!.rows;
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.doesNotMatch(rows.join(""), /\x1b\]|\u202e|\u202c|PROPOSAL/);
    if (width >= 50) assert.match(rows.map(plain).join(""), /    const family = '👨‍👩‍👧‍👦 界é';  hidden/);
  }
  assert.deepEqual({ args, result }, snapshot);
});

test("edit adapter chooses syntax from the file type for TypeScript, Python, JSON and Rust", async () => {
  initTheme("dark");
  const samples = [
    { path: "module.ts", code: 'export const answer: number = 42;\n// comment', lang: "typescript" },
    { path: "module.py", code: "def greet(name):\n    return 'hello'\n# comment", lang: "python" },
    { path: "config.json", code: '{ "answer": 42, "ok": true }', lang: "json" },
    { path: "module.rs", code: 'fn greet() { let answer = 42; }\n// comment', lang: "rust" },
  ];
  const output = new xterm.Terminal({ cols: 100, rows: 20, allowProposedApi: true });
  const reference = new xterm.Terminal({ cols: 100, rows: 20, allowProposedApi: true });
  let checked = 0;
  try {
    for (const sample of samples) {
      const node = new Tool("edit", { path: sample.path });
      node.result = { content: [], details: { diff: sample.code.split("\n").map((line, index) => `+${index + 1} ${line}`).join("\n") } };
      const root = new Root(); root.addChild(node);
      const controller = installTidyUi(root, () => nativeTheme);
      try {
        const rows = node.render(100), highlighted = highlightCode(sample.code, sample.lang);
        for (const [index, line] of sample.code.split("\n").entries()) {
          const row = rows.find((value) => plain(value).includes(line))!;
          assert.ok(row, `${sample.path} preserves code`);
          output.reset(); reference.reset();
          await new Promise<void>((done) => output.write(row, done));
          await new Promise<void>((done) => reference.write(highlighted[index]!, done));
          const start = plain(row).indexOf(line);
          let colored = 0;
          for (let column = 0; column < line.length; column++) {
            const expected = reference.buffer.active.getLine(0)!.getCell(column)!;
            if (!expected.getChars().trim() || expected.getFgColorMode() === 0) continue;
            const actual = output.buffer.active.getLine(0)!.getCell(start + column)!;
            assert.equal(actual.getFgColor(), expected.getFgColor(), `${sample.path} retains language-specific syntax foreground at ${column}`);
            assert.equal(actual.getFgColorMode(), expected.getFgColorMode());
            colored++; checked++;
          }
          assert.ok(colored > 0, `${sample.path} line has real syntax-colored glyphs inside the diff`);
        }
      } finally { controller.restore(); }
    }
    assert.ok(checked > 60, "checks syntax glyphs, not merely a colored +/- prefix");
  } finally { output.dispose(); reference.dispose(); }
});

test("completed edit cards expand from panel cells but never margins, selection or pending state", () => {
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller, original } = setup([edit]);
  try {
    const width = 80, count = edit.render(width).length;
    const event = (x: number, y: number) => ({ ...mouse(y, width), x });
    assert.equal(edit.handleMouse(event(0, 1)), undefined, "left exterior is not the panel");
    assert.equal(edit.handleMouse(event(width - 1, 1)), undefined, "right exterior is not the panel");
    assert.equal(edit.handleMouse(event(3, count)), undefined, "rows outside the card are not targets");
    root.selection = true;
    assert.equal(edit.handleMouse(event(3, 1)), undefined);
    root.selection = false;
    edit.isPartial = true;
    assert.equal(edit.handleMouse(event(3, 1)), undefined);
    edit.isPartial = false;
    for (const [x, y] of [[1, 0], [3, 1], [width - 2, count - 1]]) {
      assert.equal(edit.handleMouse(event(x!, y!))?.handled, true, "border, content and padding use the shared panel hit bounds");
      assert.equal(edit.expanded, true);
      assert.deepEqual(edit.render(width), original.call(edit, width));
      edit.setExpanded(false);
    }
  } finally { controller.restore(); }
});

test("edit syntax carries multiline string/comment foregrounds across logical and wrapped rows", async () => {
  const templateTail = "continued template " + "template_tag ".repeat(32), commentTail = "continued comment " + "comment_tag ".repeat(32);
  const before = `const value = \`before\n${templateTail}\nend\`;\n/* before comment\n${commentTail}\n*/`;
  const after = `const value = \`after\n${templateTail}\nend\`;\n/* after comment\n${commentTail}\n*/`;
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { patch: generateUnifiedPatch("example.ts", before, after) } } };
  const terminal = new xterm.Terminal({ cols: 1600, rows: 30, allowProposedApi: true });
  try {
    for (const theme of ["dark", "light"]) for (const width of [100, 140]) {
      initTheme(theme);
      const reference = highlightCode(after, "typescript").join("\r\n");
      terminal.reset(); await new Promise<void>((done) => terminal.write(reference, done));
      const expected = [1, 4].map((y) => terminal.buffer.active.getLine(y)!.getCell(0)!.getFgColor());
      const painted = renderFileCard(node, undefined, width, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
      for (const [index, token] of ["template_tag", "comment_tag"].entries()) {
        const rows = painted.rows.filter((value) => plain(value).includes(token));
        assert.ok(rows.length > 1, "continuation source lines are also physically wrapped");
        for (const row of rows) {
          terminal.reset(); await new Promise<void>((done) => terminal.write(row, done));
          for (const match of plain(row).matchAll(new RegExp(token, "g")))
            assert.equal(terminal.buffer.active.getLine(0)!.getCell(match.index)!.getFgColor(), expected[index], `${theme}/${width}: ${token} retains native multiline syntax in every pane/wrapped row`);
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("split edit replacements never pair additions/removals from different patch hunks", () => {
  const patch = "--- example.ts\n+++ example.ts\n@@ -1,1 +1,0 @@\n-const removed = 1;\n@@ -8,0 +8,1 @@\n+const inserted = 8;\n";
  const node = { args: { path: "example.ts" }, isPartial: false, result: { details: { patch } } };
  const rows = renderFileCard(node, undefined, 140, color)!.rows.map(plain);
  const removed = rows.find((row) => row.includes("const removed = 1;"))!;
  const inserted = rows.find((row) => row.includes("const inserted = 8;"))!;
  assert.ok(removed); assert.ok(inserted);
  assert.notEqual(removed, inserted, "unrelated zero-context hunks must occupy separate logical pairs");
  assert.equal(removed.trimEnd().endsWith("const removed = 1;"), true, "deletion has an empty new-file counterpart");
  assert.equal(inserted.includes("const removed = 1;"), false, "insertion has an empty old-file counterpart");
});

// Performance counters assert work/output growth, never machine-dependent timings.
test("edit minified wrapping has linear grapheme work and bounded ANSI output", (t) => {
  initTheme("dark");
  const segment = Intl.Segmenter.prototype.segment;
  let visits = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, text: string) {
    const result = segment.call(this, text);
    return { [Symbol.iterator]: function* () { for (const unit of result) { visits++; yield unit; } } };
  });
  const measurements = [400, 800, 1600, 3200].map((repeat) => {
    const before = "x+=1;".repeat(repeat), after = "x+=2;".repeat(repeat);
    const patch = `@@ -1 +1 @@\n-${before}\n+${after}\n`;
    visits = 0;
    const layout = renderFileCard({ args: { path: "minified.ts" }, isPartial: false, result: { details: { patch } } },
      undefined, 100, nativeTheme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
    const chars = layout.rows.reduce((sum, row) => sum + row.length, 0);
    assert.ok(visits < patch.length * 12, `${repeat}: ${visits} grapheme visits for ${patch.length} input units`);
    assert.ok(chars < patch.length * 14, `${repeat}: ${chars} rendered units for ${patch.length} input units`);
    return { visits, chars };
  });
  for (let index = 1; index < measurements.length; index++) {
    assert.ok(measurements[index]!.visits < measurements[index - 1]!.visits * 2.3, "doubling input must not quadruple scanning");
    assert.ok(measurements[index]!.chars < measurements[index - 1]!.chars * 2.3, "carry only active ANSI state, never its history");
  }
});

test("edit adaptive colors are calculated once per build, not once per fragment", () => {
  const backgrounds = new Set<unknown>();
  const theme: CardTheme = { ...color, colors: { toolPendingBg: parseColor("#303840"),
    toolSuccessBg: parseColor('#304a38'), toolErrorBg: parseColor('#4a3038'), dim: parseColor('#b0b0b0'),
    toolDiffAdded: parseColor("#28c870"), toolDiffRemoved: parseColor("#dc3850") },
    style: (text, options) => { backgrounds.add(options.bg); return text; } };
  const patch = `@@ -1,12 +1,12 @@\n${Array.from({ length: 12 }, () => "-" + "before ".repeat(25)).join("\n")}\n${Array.from({ length: 12 }, () => "+" + "after ".repeat(25)).join("\n")}\n`;
  const layout = renderFileCard({ args: { path: "example.ts" }, isPartial: false, result: { details: { patch } } }, undefined, 100, theme)!;
  assert.ok(layout.rows.length > 50, "exercise both signs and many wrapped fragments");
  assert.equal(backgrounds.size, 4, "one code and one gutter color per added/removed role");
});

test("edit predecessor spacing never builds an unretained diff body", () => {
  const edit = new Tool("edit", { path: "example.ts" }), following = new Tool();
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([edit, following]);
  try {
    following.render(80);
    assert.equal(controller.cacheStats().builds, 1, "spacing alone builds only the following summary");
    controller.clearCache();
    const before = controller.cacheStats().builds;
    const rows = root.render(80);
    assert.equal(controller.cacheStats().builds - before, 2, "one edit body plus one summary after clearing retention");
    assert.equal(controller.cacheStats().entries, 2);
    const warm = controller.cacheStats().builds;
    assert.equal(following.render(80)[0], "", "the framed predecessor still supplies its separator");
    assert.equal(controller.cacheStats().builds, warm);
    assert.ok(rows.some((row) => row.includes("← Edited example.ts")));
  } finally { controller.restore(); }
});

test("ignored edit mouse events do not build an unretained diff", () => {
  const edit = new Tool("edit", { path: "example.ts" });
  edit.result = { content: [], details: { diff: editDiff } };
  const { root, controller } = setup([edit]);
  try {
    const before = controller.cacheStats().builds;
    edit.handleMouse({ ...mouse(1), button: "right" });
    edit.handleMouse({ ...mouse(1), type: "move" });
    root.selection = true; edit.handleMouse(mouse(1)); root.selection = false;
    edit.isPartial = true; edit.handleMouse(mouse(1)); edit.isPartial = false;
    assert.equal(controller.cacheStats().builds, before, "rejected events cannot highlight or frame the diff");
    assert.equal(edit.expanded, false);
  } finally { controller.restore(); }
});

test("failed edits skip stale diff parsing and syntax work", () => {
  const details = { get patch(): string { return assert.fail("failed edit must not read stale patch metadata"); } };
  const node = { args: { path: "example.ts" }, isPartial: false, result: { isError: true, details } };
  const layout = renderFileCard(node, undefined, 80, color, () => { assert.fail("failed edit must not highlight"); })!;
  assert.equal(layout.framed, false);
  assert.match(layout.rows.join(""), /← Edited example.ts/);
});

test("very large edit row counts do not overflow a function argument spread", () => {
  const count = 130_000;
  const diff = Array.from({ length: count }, (_, index) => `+${index + 1} x`).join("\n");
  const node = { args: { path: "x.txt" }, isPartial: false, result: { details: { diff } } };
  const layout = renderFileCard(node, undefined, 5, color)!;
  assert.ok(layout.rows.length >= count, "all changed rows survive without a display cap");
  assert.equal(node.result.details.diff, diff);
});

test("metadata-only edit measurement preserves render classification and separator height", () => {
  const details = [undefined, { diff: "" }, { diff: editDiff }, { patch: "@@ -1 +1 @@\n-old\n+new\n" },
    { patch: "@@ -1 +1 @@\n-old\n" }, { diff: "+1no_space" }, { diff: 4 }, { patch: null },
    { diff: " 1 first\r\n+2 next" }, { diff: "+1 text\n" }];
  for (const value of details) for (const isError of [false, true]) for (const width of [0, 1, 5, 24, 100, 140]) {
    const node = { args: { path: "/project/" + "long-folder/".repeat(8) + "example.ts" }, isPartial: false,
      result: { details: value, isError } };
    const measured = measureFileCard(node, "/project", width), layout = renderFileCard(node, "/project", width, color);
    assert.equal(!!measured, !!layout, "unsupported metadata has exactly the same native fallback");
    if (!measured || !layout) continue;
    assert.equal(measured.framed, layout.framed);
    assert.equal(measured.height > 1, layout.rows.length > 1, "framed spacing needs only the multirow predicate");
    if (!layout.framed) assert.equal(measured.height, layout.rows.length, "inline title height is exact");
  }
});

test("edit spacing and rejected events keep native delegation for malformed metadata", () => {
  const edit = new Tool("edit", { path: "example.ts" }), next = new Tool();
  edit.result = { content: [], details: { patch: "@@ -1 +1 @@\n-old\n" } };
  const { controller, original } = setup([edit, next]);
  try {
    assert.equal(next.render(80)[0], "", "native multirow predecessor still owns separation");
    const builds = controller.cacheStats().builds;
    assert.equal(edit.handleMouse({ ...mouse(1), button: "right" }), undefined);
    assert.equal(controller.cacheStats().builds, builds, "ignored native event needs no custom body either");
    assert.equal(edit.handleMouse(mouse(1))?.handled, true, "native primary click remains delegated");
    assert.equal(edit.expanded, true);
    assert.deepEqual(edit.render(80), original.call(edit, 80));
  } finally { controller.restore(); }
});

test("edit uses ordinary summaries until final success and follows the shared spinner lifecycle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const starts = t.mock.method(globalThis, "setTimeout"), stops = t.mock.method(globalThis, "clearTimeout");
  const edit = new Tool("edit", { path: "example.ts", query: "q".repeat(60), edits: [{ oldText: "old", newText: "new" }] });
  edit.result = undefined; edit.isPartial = true; edit.executionStarted = false;
  const next = new Tool("read", { path: "next.txt" });
  const { root, controller, original } = setup([edit, next]);
  try {
    const pending = edit.render(140).map(plain);
    assert.match(pending.join(""), /← edit example.ts/);
    assert.doesNotMatch(pending.join(""), /┃|← Edited/);
    assert.equal(starts.mock.calls.length, 0, "argument streaming has no animation clock");
    assert.equal(edit.handleMouse(mouse(0, 140)), undefined, "argument streaming cannot expand");
    assert.equal(next.render(24)[0], " → read next.txt", "ignored query/payloads cannot make the short edit summary multiline");
    edit.updateArgs({ ...edit.args, path: "directory/long-file-name/example.ts" });
    assert.equal(next.render(24)[0], "", "a genuinely wrapped path still determines separation");
    edit.updateArgs({ ...edit.args, path: "example.ts" });
    root.render(140); // Warm both components at the width used by the host animation pass.
    edit.markExecutionStarted();
    assert.ok(spinnerFrames.includes(plain(edit.render(140)[0]!).trim()[0]!));
    assert.equal(starts.mock.calls.length, 1);
    const builds = controller.cacheStats().builds;
    t.mock.timers.tick(100); root.render(140);
    assert.equal(controller.cacheStats().builds, builds, "spinner frames reuse summary layout");
    const proposed = { get patch(): string { return assert.fail("partial/failure custom presentation must not inspect proposed diff"); } };
    edit.updateResult({ content: [{ type: "text", text: "PARTIAL_BODY" }], details: proposed, isError: true }, true);
    const partial = edit.render(140).map(plain).join("");
    assert.match(partial, /edit example.ts/); assert.doesNotMatch(partial, /┃|← Edited|PARTIAL_BODY/);
    assert.equal(edit.handleMouse(mouse(0, 140)), undefined, "partial errors cannot expand");
    assert.equal(stops.mock.calls.length, 0, "partial errors remain running, not final failures");
    edit.updateResult({ content: [], details: { diff: editDiff } });
    assert.equal(stops.mock.calls.length, 1, "final success stops the summary spinner before painting its card");
    assert.match(edit.render(140).map(plain).join(""), /┃.*← Edited example.ts/);
    assert.match(edit.render(140).map(plain).join(""), /const after = 3/);
    const idleRequests = root.requests;
    t.mock.timers.tick(300);
    assert.equal(root.requests, idleRequests, "success leaves no idle animation redraws");
    edit.updateResult({ content: [{ type: "text", text: "FAILURE_BODY" }], isError: true, details: proposed });
    const failure = edit.render(140).map(plain).join("");
    assert.match(failure, /← edit example.ts/); assert.doesNotMatch(failure, /┃|← Edited|FAILURE_BODY|const after/);
    assert.equal(starts.mock.calls.length, 2, "the acknowledged fallback has rearmed once, with no clock for final failure");
    const offset = edit.render(140)[0] === "" ? 1 : 0;
    assert.equal(edit.handleMouse(mouse(offset, 140))?.handled, true);
    assert.deepEqual(edit.render(140), original.call(edit, 140), "failed summary opens unchanged native details");
  } finally { controller.restore(); }
});

test("edit final failures color every ordinary-summary segment and preserve state policy guards", () => {
  for (const name of ["dark", "light"] as const) {
    initTheme(name);
    const edit = new Tool("edit", { path: "example.ts", edits: [{ oldText: "old", newText: "new" }] });
    const root = new Root(); root.addChild(edit);
    const roles: string[] = [];
    const controller = installTidyUi(root, () => ({ fg: (role, text) => { roles.push(role); return nativeTheme.fg(role, text); } }));
    try {
      for (const width of [1, 5, 24, 140]) {
        edit.updateResult({ content: [{ type: "text", text: "ERROR_BODY" }], isError: true, details: { diff: editDiff } });
        roles.length = 0;
        const rows = edit.render(width), text = rows.map(plain).join("");
        assert.doesNotMatch(text, /┃|← Edited|ERROR_BODY|const before/);
        assert.ok(roles.length > 0);
        assert.ok(roles.every((role) => role === "error"), `every failed edit summary segment uses error at width ${width}`);
      }
    } finally { controller.restore(); }
  }
  class SelfEdit extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return width < 30 ? ["NATIVE SELF"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  for (const partial of [true, false]) {
    const hidden = new SelfEdit("edit", { path: "example.ts" });
    hidden.result = { content: [], isError: true }; hidden.isPartial = partial;
    const { controller } = setup([hidden]);
    try { assert.deepEqual(hidden.render(80), []); assert.match(hidden.render(24).map(plain).join(""), /edit example.ts/); }
    finally { controller.restore(); }
  }
});

test("edit state policy keeps native safeguards and explicit compact override precedence in every phase", () => {
  const states: { result: Tool["result"]; partial: boolean }[] = [
    { result: undefined, partial: true },
    { result: { content: [], details: { diff: editDiff } }, partial: true },
    { result: { content: [], isError: true, details: { diff: editDiff } }, partial: false },
    { result: { content: [], details: { diff: editDiff } }, partial: false },
  ];
  for (const state of states) {
    for (const guard of ["native", "expanded", "image", "hidden", "compact"] as const) {
      const edit = new Tool("edit", { path: "example.ts" });
      edit.executionStarted = false; edit.result = state.result; edit.isPartial = state.partial;
      if (guard === "expanded") edit.expanded = true;
      if (guard === "hidden") edit.hideComponent = true;
      if (guard === "image") edit.result = { ...state.result, content: [{ type: "image" }] };
      const { controller, original } = setup([edit], guard === "compact" ? { cards: ["edit"], compact: ["edit"] } : guard === "native" ? { cards: ["edit"] } : {});
      try {
        assert.equal(controller.active, true);
        if (guard === "compact") {
          assert.match(edit.render(140).map(plain).join(""), /← edit example.ts/);
          assert.doesNotMatch(edit.render(140).map(plain).join(""), /┃|← Edited/);
        } else assert.deepEqual(edit.render(140), original.call(edit, 140), `${guard} delegates in every edit phase`);
      } finally { controller.restore(); }
    }
  }
});

test("verified stock edit presentation never visits native rows for rendering, spacing or rejected input", (t) => {
  initTheme("dark");
  const root = new Root();
  const definition = createEditToolDefinition("/project");
  const first = new NativeToolExecution("edit", "visibility-first", { path: "example.ts" }, undefined, definition, root as never, "/project");
  const second = new NativeToolExecution("edit", "visibility-second", { path: "other.ts" }, undefined, definition, root as never, "/project");
  const follower = new Tool("read", { path: "a.txt" });
  root.addChild(first); root.addChild(second); root.addChild(follower);
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    const success = { content: [{ type: "text" as const, text: "UNCHANGED_RESULT" }], details: { diff: editDiff }, isError: false };
    for (const phase of ["arguments", "execution", "partial", "failure", "success"] as const) {
      if (phase === "execution") first.markExecutionStarted();
      first.updateResult(phase === "arguments" || phase === "execution" ? undefined as never : { ...success, isError: phase === "failure" }, phase === "arguments" || phase === "execution" || phase === "partial");
      second.updateResult(success);
      const rows = root.render(140).map(plain);
      assert.match(rows.join(""), phase === "success" ? /← Edited example.ts/ : /edit example.ts/);
      const builds = controller.cacheStats().builds;
      const repeated = root.render(140).map(plain);
      assert.deepEqual(repeated, rows);
      assert.equal(controller.cacheStats().builds, builds);
      first.handleMouse({ ...mouse(0, 140), type: "move", button: "none" });
      first.handleMouse({ ...mouse(0, 140), button: "right" });
      assert.equal(native.mock.calls.length, 0, `${phase} performs no native visibility/spacing/event render`);
    }
    for (const width of [1, 24, 120, 121, 140]) {
      root.render(width); root.render(width);
      assert.equal(native.mock.calls.length, 0, `width ${width} retains the native-free custom path`);
    }
    Reflect.set(first, "hideComponent", true);
    assert.deepEqual(first.render(140), []);
    assert.ok(native.mock.calls.length > 0, "hide guard delegates rather than displaying a custom card");
    Reflect.set(first, "hideComponent", false);
    first.setExpanded(true);
    const before = native.mock.calls.length;
    first.render(140);
    assert.ok(native.mock.calls.length > before, "native expansion remains native");
  } finally { controller.restore(); }
});

test("stock edit visibility proof rejects same-name custom renderers and is checked afresh", (t) => {
  initTheme("dark");
  const root = new Root(), definition = createEditToolDefinition("/project");
  const emptyCall = () => new Text("", 0, 0);
  const emptyResult = () => new Text("", 0, 0);
  const custom: typeof definition = { ...definition, renderCall: emptyCall, renderResult: emptyResult };
  const node = new NativeToolExecution("edit", "custom-visibility", { path: "example.ts" }, undefined, custom, root as never, "/project");
  root.addChild(node);
  const native = t.mock.method(NativeToolExecution.prototype, "render");
  const controller = installTidyUi(root, () => nativeTheme, { compact: ["edit"] });
  try {
    node.updateResult({ content: [], details: { diff: editDiff }, isError: false });
    assert.equal(Reflect.get(node, "hideComponent"), false);
    assert.deepEqual(node.render(140), []);
    assert.ok(native.mock.calls.length > 0, "an edit name is not evidence of stock visibility");
    custom.renderCall = definition.renderCall!; custom.renderResult = definition.renderResult!;
    node.updateArgs({ path: "example.ts" });
    const before = native.mock.calls.length;
    assert.match(node.render(140).map(plain).join(""), /← edit example.ts/);
    assert.equal(native.mock.calls.length, before, "the stock pair skips visibility without a retained proof cache");
    custom.renderCall = emptyCall;
    node.updateArgs({ path: "example.ts" });
    node.render(140);
    assert.ok(native.mock.calls.length > before, "replacing just one renderer immediately restores native authority");
    custom.renderCall = definition.renderCall!; custom.renderResult = emptyResult;
    node.updateArgs({ path: "example.ts" });
    const mixed = native.mock.calls.length;
    node.render(140);
    assert.ok(native.mock.calls.length > mixed, "both functions must match, not merely the call renderer");
  } finally { controller.restore(); }
});

function paletteRgb(value: number) { return { r: value >>> 16, g: value >>> 8 & 255, b: value & 255 }; }
function paletteLuminance(rgb: { r: number; g: number; b: number }): number {
  const channels = [rgb.r, rgb.g, rgb.b].map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function paletteContrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const x = paletteLuminance(a), y = paletteLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function paletteCells(paint: CardTheme = nativeTheme, width = 140) {
  const terminal = new xterm.Terminal({ cols: width, rows: 16, allowProposedApi: true });
  try {
    const layout = renderFileCard({ args: { path: 'palette.ts' }, isPartial: false,
      result: { details: { diff: '-1 const old = 1;\n+1 const next = 2;' } } }, undefined, width, paint)!;
    await new Promise<void>(done => terminal.write(layout.rows.join('\r\n'), done));
    return [['old', '-'], ['next', '+']].map(([word, sign]) => {
      const y = layout.rows.findIndex(row => plain(row).includes(`const ${word}`)), row = plain(layout.rows[y]!);
      const line = terminal.buffer.active.getLine(y)!;
      const code = line.getCell(row.indexOf(`const ${word}`))!, gutter = line.getCell(row.indexOf(sign!))!;
      assert.equal(code.getBgColorMode(), 0x3000000); assert.equal(gutter.getBgColorMode(), 0x3000000);
      return { code: paletteRgb(code.getBgColor()), gutter: paletteRgb(gutter.getBgColor()), sign: gutter.getFgColor() };
    });
  } finally { terminal.dispose(); }
}

test('edit adaptive palette: builtin dark/light preserve code and gutter contrast', async () => {
  for (const mode of ['dark', 'light']) {
    initTheme(mode);
    const base = colorToRgb(nativeTheme.colors.toolPendingBg);
    const inks = Object.entries(nativeTheme.colors).filter(([role]) => role === 'toolOutput' || role.startsWith('syntax'));
    const surfaces = await paletteCells();
    for (const [i, surface] of surfaces.entries()) {
      for (const [role, color] of inks) {
        const ink = colorToRgb(color);
        assert.ok(paletteContrast(ink, surface.code) + 1e-9 >= Math.min(4.5, paletteContrast(ink, base)), `${mode} ${role}: code preserves readable or existing contrast`);
      }
      for (const [role, minimum] of [['dim', 3], [i === 0 ? 'toolDiffRemoved' : 'toolDiffAdded', 4.5]] as const) {
        const ink = colorToRgb(nativeTheme.colors[role]);
        assert.ok(paletteContrast(ink, surface.gutter) + 1e-9 >= Math.min(minimum, paletteContrast(ink, base)), `${mode} ${role}: gutter must not degrade low-contrast theme ink`);
      }
      assert.notDeepEqual(surface.code, surface.gutter, `${mode}: number area remains distinct from code`);
    }
  }
});

test('edit adaptive palette: Gruvbox keeps neutral additions and the authored muted deletion hue', async () => {
  setThemeInstance(loadThemeFromPath(new URL('../../fixtures/gruvbox-dark-hard.json', import.meta.url).pathname));
  try {
    const [removed, added] = await paletteCells();
    const lab = (rgb: { r: number; g: number; b: number }) => colorToOklch(rgbColor(rgb.r, rgb.g, rgb.b));
    assert.ok(lab(added!.code).c < 0.006, 'neutral success background does not acquire green/yellow pigment from the bright sign');
    const expectedHue = colorToOklch(nativeTheme.colors.toolErrorBg).h, actualHue = lab(removed!.code).h;
    assert.ok(Math.abs((actualHue - expectedHue + 540) % 360 - 180) < 15, 'deletion follows semantic background, not orange-shifted Multiply');
    assert.ok(lab(removed!.code).c > 0.008, 'the red surface is still meaningfully distinct from neutral context');
    for (const [surface, role] of [[removed!, 'toolDiffRemoved'], [added!, 'toolDiffAdded']] as const) {
      const ink = colorToRgb(nativeTheme.colors[role]);
      assert.equal(surface.sign, ink.r << 16 | ink.g << 8 | ink.b, 'existing sign colors are unchanged');
      assert.ok(paletteLuminance(surface.gutter) < paletteLuminance(surface.code), 'dark Gruvbox number area is subtly deeper');
    }
  } finally { initTheme('dark'); }
});

test('edit adaptive palette: neutral or absent semantic backgrounds do not invent pigment', async () => {
  initTheme('dark');
  for (const missing of [false, true]) {
    const base = parseColor('#303234');
    const colors = { toolPendingBg: base, ...(!missing ? { toolSuccessBg: base, toolErrorBg: base } : {}),
      toolDiffAdded: parseColor('#00ff00'), toolDiffRemoved: parseColor('#ff0000') };
    const paint: CardTheme = { colors, fg: nativeTheme.fg.bind(nativeTheme), style: nativeTheme.style.bind(nativeTheme),
      bg: (_role, text) => nativeTheme.style(text, { bg: base }) };
    for (const surface of await paletteCells(paint)) assert.deepEqual(surface.code, colorToRgb(base));
  }
});
