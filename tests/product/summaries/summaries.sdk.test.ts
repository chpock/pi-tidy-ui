import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describeArgs, sanitize } from "../../../src/index.ts";
import { PRIORITY_FIELDS, VALUE_TEXT_LIMIT, SUMMARY_TEXT_LIMIT } from "../../../src/summary-args.ts";
import { Container, Root, Text, Tool, color, editDiff, installTidyUi, mouse, plain, setup, spinnerFrames, type TuiMouseEvent } from "../../fixtures/sdk-contract-support.ts";

test("adjacent summaries skip empty siblings but separate visible text and cards", () => {
  const first = new Tool(), second = new Tool("grep", { pattern: "needle", path: "src" });
  const bash = new Tool("bash"), third = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, new Text("", 0, 0), second, bash, third]);
  try {
    assert.equal(controller.active, true);
    const rows = root.render(80).map(plain);
    const index = rows.findIndex((line) => line.includes("read a.txt"));
    assert.match(rows[index + 1], /grep.*needle.*src/);
    assert.equal(rows[index - 1], "");
    assert.equal(third.render(80)[0], "");
    assert.deepEqual(bash.render(80), ["", "NATIVE bash", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("summaries at transcript start need no leading gap; new attached subtrees are visited", () => {
  const { root, controller } = setup();
  try {
    const branch = new Container(), first = new Tool(), second = new Tool("custom", { query: "item" });
    branch.addChild(first); branch.addChild(second); root.addChild(branch);
    assert.equal(first.render(80).length, 1);
    assert.equal(second.render(80).length, 1);
    assert.match(root.render(80)[1], /custom.*item/);
  } finally { controller.restore(); }
});

test("completed summaries hide result text and markers; failures color every visible segment", () => {
  for (const name of ["read", "custom"]) {
    const tool = new Tool(name, { pattern: "needle", path: "文件/" + "p".repeat(40), query: "a,b,c", limit: 0 });
    const root = new Root(); root.addChild(tool);
    const paints: { role: string; text: string }[] = [];
    const controller = installTidyUi(root, () => ({ fg: (role, text) => {
      paints.push({ role, text });
      return `\x1b[${role === "error" ? 31 : 37}m${text}\x1b[39m`;
    } }));
    try {
      const args = structuredClone(tool.args);
      tool.updateResult({ isError: true, content: [{ type: "text", text: "ERROR_BODY_SENTINEL\nSTACK_SENTINEL" }], details: { raw: "UNCHANGED" } });
      const result = structuredClone(tool.result);
      assert.doesNotMatch(tool.render(80).map(plain).join(""), /ERROR_BODY_SENTINEL|STACK_SENTINEL/u, "error preview is never part of a collapsed call");
      for (let width = 1; width <= 100; width++) {
        controller.clearCache(); paints.length = 0;
        const rows = tool.render(width);
        assert.ok(rows.length > 0, "completed failed tool stays visible, including tiny widths");
        assert.ok(paints.length > 0 && paints.every(({ role }) => role === "error"), `all segments use error at width ${width}`);
        assert.ok(rows.every((row) => visibleWidth(row) <= Math.max(1, width - 1)));
        assert.doesNotMatch(rows.map(plain).join(""), /ERROR_BODY_SENTINEL|STACK_SENTINEL|✓|✗| — /u);
        if (width >= 6) {
          assert.equal(rows.map(plain).map((row) => row.slice(3)).join("").replace(/ /g, ""),
            `${name} ${describeArgs(name, tool.args)}`.replace(/ /g, ""));
          assert.ok(rows.map(plain).every((row) => !row.endsWith(" ")), "hidden marker leaves no dangling separator space");
        }
      }
      const failed = tool.render(30).map(plain);
      assert.ok(tool.handleMouse(mouse(failed.length - 1, 30))?.handled, "last failed continuation opens native information");
      assert.deepEqual(tool.render(30), ["", `NATIVE ${name}`, "FULL_OUTPUT"]);
      tool.setExpanded(false);
      tool.updateResult({ content: [{ type: "text", text: "SUCCESS_BODY_SENTINEL" }] });
      controller.clearCache(); paints.length = 0;
      const success = tool.render(30).map(plain);
      assert.deepEqual(success, failed, "error state changes colors, not logical call text or height");
      assert.ok(paints.some(({ role }) => role === "dim") && paints.every(({ role }) => role !== "error"));
      assert.doesNotMatch(success.join(""), /SUCCESS_BODY_SENTINEL|✓|✗/u);
      assert.deepEqual(tool.args, args);
      tool.updateResult(result, true);
      paints.length = 0;
      assert.ok(spinnerFrames.includes(plain(tool.render(30)[0]!)[1]!));
      assert.doesNotMatch(tool.render(30).join(""), /…/u);
      assert.ok(paints.every(({ role }) => role !== "error"), "partial isError does not mark the call failed");
      tool.updateResult(result);
      assert.deepEqual(tool.result, result);
      assert.deepEqual(tool.render(30).map(plain), failed);
    } finally { controller.restore(); }
  }
});

test("hiding completion badges never removes literal status glyphs from supplied arguments", () => {
  const tool = new Tool("custom", { query: "✓,✗", pattern: "✓" });
  const { controller } = setup([tool]);
  try {
    assert.equal(tool.render(80).at(-1), ' ⚙ custom "✓" [query="✓,✗"]');
    tool.updateResult({ isError: true, content: [{ type: "text", text: "HIDDEN_ERROR" }] });
    assert.equal(tool.render(80).at(-1), ' ⚙ custom "✓" [query="✓,✗"]');
  } finally { controller.restore(); }
});

test("completion marker constant can restore success and failure symbols without error-body previews", async () => {
  const sourceUrl = new URL("../../../src/index.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const switchLine = "const SHOW_COMPLETION_MARKERS = false;";
  assert.ok(source.includes(switchLine), "one source constant controls final markers and defaults to false");
  const enabled = source.replace(switchLine, "const SHOW_COMPLETION_MARKERS = true;")
    .replace(/from (["'])([^"']+)\1/gu, (_match, _quote: string, specifier: string) =>
      `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const temporary = mkdtempSync(join(tmpdir(), "tidy-ui-completion-markers-"));
  let controller: ReturnType<typeof installTidyUi> | undefined;
  try {
    mkdirSync(join(temporary, "src"));
    writeFileSync(join(temporary, "package.json"), readFileSync(new URL("../package.json", sourceUrl)));
    const file = join(temporary, "src/index.ts"); writeFileSync(file, enabled);
    const alternate = await import(pathToFileURL(file).href);
    const root = new Root(), tool = new Tool(); root.addChild(tool);
    controller = alternate.installTidyUi(root, () => color);
    assert.equal(tool.render(80).at(-1), " → read a.txt ✓");
    tool.updateResult({ isError: true, content: [{ type: "text", text: "ERROR_BODY_SENTINEL" }] });
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt ✗");
    assert.doesNotMatch(tool.render(80).join(""), /ERROR_BODY_SENTINEL/u);
    assert.deepEqual(tool.render(5), [" ✗"]);
    tool.updateResult({ content: [] }); assert.deepEqual(tool.render(5), [" ✓"]);
    tool.updateResult(undefined); assert.match(plain(tool.render(80).at(-1)!), /…$/u);
    assert.deepEqual(tool.render(5), [" ⠋"]);
    tool.executionStarted = false; assert.deepEqual(tool.render(5), [" …"]);
  } finally { controller?.restore(); rmSync(temporary, { recursive: true, force: true }); }
});

test("pending, partial, success and errors are distinguishable without full output", () => {
  const tool = new Tool();
  const { controller } = setup([tool]);
  try {
    tool.result = undefined; tool.isPartial = true;
    assert.ok(spinnerFrames.includes(plain(tool.render(80)[0]!)[1]!));
    assert.doesNotMatch(tool.render(80).join(""), /…/u);
    tool.result = { content: [{ type: "text", text: "PARTIAL_OUTPUT" }] };
    assert.ok(spinnerFrames.includes(plain(tool.render(80)[0]!)[1]!));
    assert.doesNotMatch(tool.render(80).join(""), /…/u);
    tool.isPartial = false;
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt");
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL_OUTPUT/);
    tool.result = { isError: true, content: [{ type: "text", text: "ENOENT: missing file\nstack details" }] };
    assert.equal(plain(tool.render(80).at(-1)!), " → read a.txt");
    assert.doesNotMatch(tool.render(80).join(""), /ENOENT|stack details|✓|✗/u);
  } finally { controller.restore(); }
});

test("summary content survives wrapping and Unicode at every usable width", () => {
  const tool = new Tool("read", { path: "文件/🦀/é".repeat(20) });
  const { controller } = setup([tool]);
  try {
    for (let width = 1; width < 81; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${visibleWidth(row)}`);
      assert.ok(plain(line).trim(), "completed summary remains visible without a completion badge");
      assert.doesNotMatch(rows.map(plain).join(""), /✓|✗/u);
    }
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("terminal controls, multiline text and bidi formatting cannot escape the summary", () => {
  assert.equal(sanitize("a\n\r\tb\x1b[31mRED\x1b[0m\x07\u202e"), "a bRED");
  const tool = new Tool("custom\nname", { query: "hello\x1b]0;bad\x07\nworld\x9b2J" });
  const { controller } = setup([tool]);
  try {
    assert.equal(tool.render(80).length, 1);
    assert.doesNotMatch(tool.render(80)[0], /[\x00-\x1f\x7f-\x9f\u202e]/);
  } finally { controller.restore(); }
});

test("generic descriptions retain useful fields and bound bulky payload previews", () => {
  assert.match(describeArgs("read", { path: "file", offset: 5, limit: 10 }), /file.*5.*10/);
  assert.match(describeArgs("grep", { pattern: "abc", path: "src" }), /abc.*src/);
  assert.match(describeArgs("aft_zoom", { path: "a.ts", symbols: ["first", "second"] }), /a.ts.*first.*second/);
  assert.match(describeArgs("strange", { mode: "fast", kind: "thing" }), /mode.*fast/);
  assert.ok(describeArgs("strange", { content: "PAYLOAD".repeat(1000) }).length < 300);
  assert.equal(describeArgs("read", {}), "");
});

test("policy overrides are exact names and compact wins", () => {
  const tools = [new Tool("read"), new Tool("custom"), new Tool("bash"), new Tool("custom_extra")];
  const { controller } = setup(tools, { cards: ["custom", "bash"], compact: ["bash"] });
  try {
    assert.equal(tools[0].render(80).length, 1);
    assert.match(tools[1].render(80)[1], /NATIVE/);
    assert.match(tools[2].render(80).at(-1)!, /^ ⚙ bash /);
    assert.match(tools[3].render(80).at(-1)!, /^ ⚙ custom_extra /);
  } finally { controller.restore(); }
});

test("mouse dispatch uses rendered summary heights and ignores gaps, pending calls and wheel", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, second]);
  try {
    root.render(80);
    assert.equal(root.handleMouse(mouse(1)), undefined); // separating row
    assert.equal(first.expanded, false);
    assert.ok(root.handleMouse(mouse(3))?.handled);
    assert.equal(first.expanded, false); assert.equal(second.expanded, true);
    assert.match(second.render(80)[1], /NATIVE/);
    second.handleMouse(mouse(1)); assert.equal(second.expanded, false);
    first.isPartial = true;
    assert.equal(first.handleMouse(mouse(1)), undefined);
    assert.equal(first.handleMouse({ ...mouse(1), type: "wheel", wheelDelta: -1 }), undefined);
  } finally { controller.restore(); }
});

test("theme is read during rendering instead of captured at installation", () => {
  const root = new Root(), tool = new Tool(); root.addChild(tool);
  let prefix = "A";
  const controller = installTidyUi(root, () => ({ fg: (_color, text) => `${prefix}${text}` }));
  try {
    const before = tool.render(80).join(""); prefix = "B";
    const after = tool.render(80).join("");
    assert.notEqual(before, after); assert.match(after, /B/);
  } finally { controller.restore(); }
});

test("exact read/edit/write summaries use directional arrows; other compact tools keep the one-column gear", async () => {
  const names = ["read", "Read", "grep", "aft_inspect", "ctx_reduce", "TaskList", "custom", "write", "edit", "Write", "Edit", "write_custom", "edit_custom", "bash"];
  const tools = names.map((name) => new Tool(name, { path: "a.txt", query: "x".repeat(50) }));
  const root = new Root(); tools.forEach((tool) => root.addChild(tool));
  const controller = installTidyUi(root, () => ({ fg: (role, text) =>
    `\x1b[${role === "dim" ? 90 : 37}m${text}\x1b[39m` }), { compact: names });
  const terminal = new xterm.Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  try {
    assert.equal(visibleWidth(" ⚙ "), 3, "literal gear has no emoji variation selector or extra column");
    for (const tool of tools) {
      const glyph = tool.toolName === "read" ? "→" : tool.toolName === "edit" || tool.toolName === "write" ? "←" : "⚙";
      const args = structuredClone(tool.args);
      for (const state of ["pending", "partial", "success", "error"]) {
        tool.isPartial = state === "partial";
        tool.updateResult(state === "pending" ? undefined : {
          isError: state === "error", content: [{ type: "text", text: "ERROR_TEXT" }],
        }, state === "partial");
        const rows = tool.render(30).filter((row) => plain(row).trim());
        const leading = state === "pending" || state === "partial" ? "⠋" : glyph;
        assert.ok(rows[0]!.startsWith(`\x1b[${state === "error" ? 37 : 90}m ${leading} \x1b[39m`), `${tool.toolName}: ${state === "error" ? "error" : "dim"} ${glyph}`);
        assert.ok(rows.slice(1).every((row) => plain(row).startsWith("   ")));
        assert.ok(rows.every((row) => visibleWidth(row) <= 29));
        assert.deepEqual(tool.args, args);
        for (let width = 1; width <= 5; width++)
          assert.deepEqual(tool.render(width).map(plain).filter((row) => row.trim()), [(width >= 3 ? " " : "") + leading], "tiny viewports retain pending state or tool glyph and the margins that fit");
      }
      terminal.reset();
      const row = tool.render(80).find((line) => plain(line).trim())!;
      await new Promise<void>((done) => terminal.write(row, done));
      const screen = terminal.buffer.active.getLine(0)!;
      assert.equal(screen.getCell(1)!.getChars(), glyph);
      assert.equal(screen.getCell(1)!.getWidth(), 1);
      assert.equal(screen.getCell(3)!.getChars(), tool.toolName[0]);
      assert.equal(terminal.buffer.active.cursorY, 0);
      tool.setExpanded(true);
      assert.deepEqual(tool.render(80), ["", `NATIVE ${tool.toolName}`, "FULL_OUTPUT"]);
    }
  } finally { terminal.dispose(); controller.restore(); }
});

test("read summaries use distinct semantic roles and bracket only non-path parameters", () => {
  const root = new Root(), tool = new Tool("read", { path: "a.txt", offset: 5, limit: 10 });
  root.addChild(tool);
  const parts: { color: string; text: string }[] = [];
  const controller = installTidyUi(root, () => ({ fg: (color, text) => { parts.push({ color, text }); return text; } }));
  try {
    assert.equal(tool.render(120).at(-1), " → read a.txt [offset=5, limit=10]");
    assert.deepEqual(parts, [
      { color: "dim", text: " → " },
      { color: "toolTitle", text: "read" },
      { color: "muted", text: " a.txt" },
      { color: "dim", text: " [offset=5, limit=10]" },
    ]);
  } finally { controller.restore(); }
});

test("read without parameters has no empty brackets; patterns are primary descriptions", () => {
  const read = new Tool(), grep = new Tool("grep", { pattern: "needle", path: "src" });
  const { controller } = setup([read, grep]);
  try {
    assert.equal(read.render(120).at(-1), " → read a.txt");
    assert.equal(grep.render(120).at(-1), ' ⚙ grep "needle" in src');
  } finally { controller.restore(); }
});

test("colored completed summary wrapping preserves content and terminal-width bounds", () => {
  const root = new Root(), tool = new Tool("read", { path: "文件/🦀/é".repeat(20), offset: 5, limit: 100 });
  root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    const color = colors[role] ?? 31;
    return `\x1b[${color}m${text}\x1b[39m`;
  } }));
  try {
    for (let width = 1; width <= 80; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width);
      assert.ok(plain(line).trim(), "completed summary remains visible without a completion badge");
      assert.doesNotMatch(rows.map(plain).join(""), /✓|✗/u);
    }
  } finally { controller.restore(); }
});

test("shared summaries cover active tool argument shapes and the exact edit-path rule", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["read", { limit: 10, path: "src/app.ts", offset: 5 }, 'src/app.ts [offset=5, limit=10]'],
    ["grep", { include: "*.ts", path: "src", pattern: "needle" }, '"needle" in src [include="*.ts"]'],
    ["custom", { pattern: "", path: "", target: "other", query: "why" }, '"" [query="why", path="", target="other"]'],
    ["aft_search", { includeTests: false, query: "where is auth", path: "/repo" }, '/repo [query="where is auth", includeTests=false]'],
    ["aft_outline", { target: ["src", "tests"], files: true }, '[target=["src","tests"], files=true]'],
    ["aft_inspect", { sections: "diagnostics", scope: ["src", "tests"] }, '[scope=["src","tests"], sections="diagnostics"]'],
    ["aft_zoom", { path: "a.ts", symbols: ["render", "update"], callgraph: true }, 'a.ts [symbols=["render","update"], callgraph=true]'],
    ["aft_callgraph", { depth: 2, symbol: "render", path: "a.ts", op: "callers" }, 'a.ts [op="callers", symbol="render", depth=2]'],
    ["ast_grep_search", { paths: ["src"], lang: "typescript", pattern: "$X($$$)" }, '"$X($$$)" [paths=["src"], lang="typescript"]'],
    ["ast_grep_replace", { rewrite: "BULKY", pattern: "foo()", lang: "typescript" }, '"foo()" [lang="typescript", rewrite="BULKY"]'],
    ["TaskCreate", { description: "Investigate", subject: "Rendering" }, '[subject="Rendering", description="Investigate"]'],
    ["TaskUpdate", { status: "completed", taskId: "1" }, '[taskId="1", status="completed"]'],
    ["Agent", { prompt: "BULKY", subagent_type: "reviewer", description: "Review" }, '[description="Review", subagent_type="reviewer", prompt="BULKY"]'],
    ["ctx_memory", { content: "BULKY", category: "CONSTRAINTS", action: "write" }, '[action="write", category="CONSTRAINTS", content="BULKY"]'],
    ["web_search", { numResults: 5, queries: ["one", "two"] }, '[queries=["one","two"], numResults=5]'],
    ["fetch_content", { url: "https://example.com", prompt: "BULKY", mode: "answer" }, 'https://example.com [mode="answer", prompt="BULKY"]'],
    ["aft_safety", { name: "snap", op: "checkpoint", files: ["src/a.ts"] }, '[op="checkpoint", files=["src/a.ts"], name="snap"]'],
    ["custom", { pattern: null, path: { id: 1 }, target: "valid", zero: 0, flag: false, empty: "", nullable: null }, 'valid [path={"id":1}, pattern=null, empty="", flag=false, nullable=null, zero=0]'],
    ["custom", { url: "https://example.com", target: "target", path: "first" }, 'first [target="target", url="https://example.com"]'],
    ["custom", { path: "my file.ts", "odd key": [false, 0, null] }, '"my file.ts" ["odd key"=[false,0,null]]'],
    ["TaskList", {}, ''],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(describeArgs(name, args), expected, name);
    assert.equal(describeArgs("entirely_unknown", args), expected, "same rules for any tool name");
  }
});

test("payload previews and exact top-level masking preserve remaining structure and source data", () => {
  const args = { content: "PAYLOAD", edits: [], code: "PAYLOAD", input: "PAYLOAD", messages: [],
    prompt: "PAYLOAD", newString: "PAYLOAD", oldString: "PAYLOAD", appendContent: "PAYLOAD",
    rewrite: "PAYLOAD", oldText: "PAYLOAD", newText: "PAYLOAD", api_key: "SECRET", password: "SECRET",
    Authorization: "SECRET", apiKey: "SECRET", token: "SECRET", maxTokens: 0,
    nested: { content: "visible", text: "a\nb" }, query: "a\nb", omitted: undefined };
  const before = structuredClone(args);
  const output = describeArgs("custom", args);
  assert.doesNotMatch(output, /SECRET|omitted/);
  for (const key of ["content", "code", "input", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText"])
    assert.ok(output.includes(`${key}="PAYLOAD"`));
  assert.ok(output.includes("edits=[]") && output.includes("messages=[]"));
  assert.match(output, /api_key="<redacted>"/);
  assert.match(output, /Authorization="<redacted>"/);
  assert.match(output, /maxTokens=0/);
  assert.match(output, /nested=\{"content":"visible","text":"a b"\}/);
  assert.match(output, /^\[query="a b"/);
  assert.deepEqual(args, before);
});

test("multiline summaries retain all parameters, align to tool name and recompute separator height", () => {
  const short = new Tool(), long = new Tool("custom", { z: "last", query: "x".repeat(220), enabled: false, limit: 0 });
  const hidden = new Tool(); hidden.hideComponent = true;
  const next = new Tool("read", { path: "b.txt" }), last = new Tool("read", { path: "c.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), short, long, hidden, new Text("", 0, 0), next, last]);
  try {
    assert.equal(short.render(40)[0], "");
    const rows = long.render(40).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows[0].startsWith(" ⚙ custom"));
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " "));
    for (const row of rows) assert.ok(visibleWidth(row) <= 40);
    const joined = rows.map((row) => row.slice(3)).join("");
    assert.match(joined, /x{220}/); // no previous 180-column argument cap
    for (const key of ['query=', 'limit=0', 'enabled=false', 'z="last"']) assert.ok(joined.includes(key), key);
    assert.match(joined, /\]$/);
    assert.equal(next.render(40)[0], "");
    assert.equal(last.render(40).length, 1); // next's leading separator is not content
    assert.notEqual(root.render(40).at(-1), "");
    assert.equal(long.render(1000).length, 1);
    assert.equal(next.render(1000).length, 1);
    assert.equal(next.render(40)[0], "");
  } finally { controller.restore(); }
});

test("clicks on continuation rows expand only that call; adaptive separator rows are not clickable", () => {
  const first = new Tool(), long = new Tool("custom", { query: "x".repeat(80) }), next = new Tool();
  const { root, controller } = setup([first, long, next]);
  try {
    root.render(24);
    const height = long.render(24).length;
    assert.ok(height > 1);
    assert.equal(root.handleMouse(mouse(1 + height, 24)), undefined); // next's leading gap
    assert.equal(long.expanded, false); assert.equal(next.expanded, false);
    assert.ok(root.handleMouse(mouse(2, 24))?.handled); // long's second content row
    assert.equal(first.expanded, false); assert.equal(long.expanded, true); assert.equal(next.expanded, false);
  } finally { controller.restore(); }
});

test("native self cards get only a missing separator after multiline calls and adjusted mouse coordinates", () => {
  class NativeSelf extends Tool {
    received: number | undefined;
    getRenderShell() { return "self"; }
    render(_width: number) { return ["SELF CARD"]; }
    handleMouse(event: TuiMouseEvent) {
      this.received = event.y;
      return { handled: true as const, target: { component: this, originX: event.screenX - event.x,
        originY: event.screenY - event.y, width: event.width, height: event.height } };
    }
  }
  const long = new Tool("custom", { query: "x".repeat(80) }), card = new NativeSelf("native_self");
  const bash = new Tool("bash");
  const { controller } = setup([long, card, bash], { cards: ["native_self"] });
  try {
    assert.deepEqual(card.render(24), ["", "SELF CARD"]);
    assert.equal(card.handleMouse(mouse(0, 24)), undefined);
    assert.ok(card.handleMouse(mouse(1, 24))?.handled);
    assert.equal(card.received, 0);
    assert.deepEqual(bash.render(24), ["", "NATIVE bash", "FULL_OUTPUT"]);
    assert.deepEqual(card.render(200), ["SELF CARD"]);
  } finally { controller.restore(); }
});

test("quoting preserves edge spaces, escapes punctuation and handles non-JSON values visibly", () => {
  assert.equal(describeArgs("custom", { path: " file " }), '" file "');
  assert.equal(describeArgs("custom", { path: 'a"b\\c', query: 'a"b\\c' }), '"a\\"b\\\\c" [query="a\\"b\\\\c"]');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(describeArgs("custom", { query: cyclic }), '[query="[unavailable]"]');
  assert.equal(describeArgs("custom", { target: [], pattern: 0 }), '[target=[], pattern=0]');
  assert.equal(describeArgs("custom", { scope: "src", paths: ["tests"], url: null }), 'src [paths=["tests"], url=null]');
});

test("primary locations require a nonempty string and otherwise lead named parameters", () => {
  for (const key of ["path", "target", "url", "scope"]) {
    assert.equal(describeArgs("custom", { [key]: "src", query: "q" }), 'src [query="q"]');
    assert.equal(describeArgs("custom", { [key]: " src " }), '" src "');
    assert.equal(describeArgs("custom", { [key]: " " }), '" "'); // no implicit trimming
    for (const value of ["", [], ["src"], { root: "src" }, null, 0, false]) {
      const args = { query: "q", [key]: value, paths: ["first"] };
      const before = structuredClone(args);
      const expected = `[query="q", paths=["first"], ${key}=${JSON.stringify(value)}]`;
      assert.equal(describeArgs("custom", args), expected);
      assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
      assert.deepEqual(args, before);
    }
  }
  assert.equal(describeArgs("custom", { pattern: "x", path: "", target: "other", query: "q" }), '"x" [query="q", path="", target="other"]');
  assert.equal(describeArgs("custom", { pattern: "", path: "a" }), '"" in a');
  assert.equal(describeArgs("custom", { path: [], target: "", url: "https://example.com", scope: "src", query: "q" }), 'https://example.com [query="q", path=[], target="", scope="src"]');
  const all = { query: "q", scope: null, url: "", target: [], path: "", paths: [], alpha: true };
  assert.equal(describeArgs("custom", all), '[query="q", paths=[], path="", target=[], url="", scope=null, alpha=true]');
  assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(all).reverse())), '[query="q", paths=[], path="", target=[], url="", scope=null, alpha=true]');
});

test("paths remains named after action/query fields and before locations/unknown parameters", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ paths: ["src"] }, '[paths=["src"]]'],
    [{ query: "q", paths: [] }, '[query="q", paths=[]]'],
    [{ query: "q", paths: "src", path: "a", op: "search", z: 0 }, 'a [op="search", query="q", paths="src", z=0]'],
    [{ paths: null, pattern: "x", path: ["a"], limit: 0 }, '"x" [paths=null, path=["a"], limit=0]'],
    [{ scope: [], paths: ["src"], query: "q" }, '[query="q", paths=["src"], scope=[]]'],
    [{ query: "q", paths: { root: "src" } }, '[query="q", paths={"root":"src"}]'],
    [{ Paths: ["src"], query: "q" }, '[query="q", Paths=["src"]]'],
  ];
  for (const [args, expected] of cases) {
    const before = structuredClone(args);
    assert.equal(describeArgs("custom", args), expected);
    assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
    assert.deepEqual(args, before);
  }
});

test("important fields precede locale-independent alphabetical keys regardless of input order", () => {
  const first = { zebra: 1, startLine: 2, query: "q", endLine: 3, alpha: 4, Alpha: 5, symbol: "s", paths: ["src"] };
  const second = Object.fromEntries(Object.entries(first).reverse());
  const expected = '[query="q", paths=["src"], symbol="s", startLine=2, endLine=3, Alpha=5, alpha=4, zebra=1]';
  assert.equal(describeArgs("custom", first), expected);
  assert.equal(describeArgs("custom", second), expected);
  for (const key of ["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"]) {
    assert.equal(describeArgs("custom", { [key]: "SECRET" }), `[${key}="<redacted>"]`);
  }
  assert.equal(describeArgs("custom", { TOKEN: "ordinary", tokenLimit: 0 }), '[TOKEN="ordinary", tokenLimit=0]');
});

test("colored word-boundary wraps never add padding or blank clickable content rows", () => {
  const root = new Root(), tool = new Tool("read", { path: "abcdefghijklm", limit: 1 });
  root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    return `\x1b[${colors[role] ?? 31}m${text}\x1b[39m`;
  } }));
  try {
    assert.deepEqual(tool.render(21).map(plain), [' → read', '   abcdefghijklm', '   [limit=1]']);
    // The original colored-boundary geometry now occurs one column wider.
    assert.deepEqual(tool.render(22).map(plain), [' → read abcdefghijklm', '   [limit=1]']);
    tool.args = { path: "abcdefghijklm", query: "x".repeat(40) };
    const rows = tool.render(21).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " " && row.trim()));
    assert.ok(rows.every((row) => visibleWidth(row) <= 21));
    assert.match(rows.map((row) => row.slice(3)).join(""), /x{40}/);
  } finally { controller.restore(); }
});

test("array summaries wrap between members instead of splitting paths that fit", () => {
  const paths = [
    "experiments/gruvbox-dark-hard/semantic-implementation-review.md",
    "experiments/gruvbox-dark-hard/semantic-implementation.md",
    "experiments/gruvbox-dark-hard/semantic-analysis.md",
  ];
  const tool = new Tool("aft_inspect", { scope: paths });
  const { controller } = setup([tool]);
  try {
    const before = structuredClone(tool.args);
    const rows = tool.render(110).map(plain);
    assert.equal(rows.length, 3);
    assert.equal(rows[0], ` ⚙ aft_inspect [scope=[${JSON.stringify(paths[0])},`);
    assert.equal(rows[1], `   ${JSON.stringify(paths[1])},`);
    assert.equal(rows[2], `   ${JSON.stringify(paths[2])}]]`);
    assert.deepEqual(tool.args, before);
    assert.equal(rows.map((row) => row.slice(3)).join(""), `aft_inspect ${describeArgs(tool.toolName, tool.args)}`);
    assert.deepEqual(tool.render(110).map(plain), rows);
  } finally { controller.restore(); }
});

test("comma-separated string values can start on the tool-name row and wrap after commas", () => {
  const tool = new Tool("ctx_reduce", { drop: "3,4,5,8,9,10,12,15,18,21" });
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(tool.render(36).map(plain), [
      ' ⚙ ctx_reduce [drop="3,4,5,8,9,10,',
      '   12,15,18,21"]',
    ]);
    // Even a list that fits on its own must use the remaining first-row space.
    tool.updateArgs({ drop: "3,4,5,8,9,10,12" });
    assert.deepEqual(tool.render(30).map(plain), [
      ' ⚙ ctx_reduce [drop="3,4,5,8,',
      '   9,10,12"]',
    ]);
    assert.equal(describeArgs(tool.toolName, tool.args), '[drop="3,4,5,8,9,10,12"]');
  } finally { controller.restore(); }
});

test("comma-aware wrapping preserves nested JSON, quotes, colors, graphemes and width bounds", () => {
  const tool = new Tool("custom", { target: ["a,b", ["文件/🦀/é", "comma,\u0301suffix"], { quoted: 'a,"b\\c' }], drop: "1-3,5,8-10" });
  const root = new Root(); root.addChild(tool);
  const controller = installTidyUi(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    return `\x1b[${colors[role] ?? 31}m${text}\x1b[39m`;
  } }));
  try {
    const expected = `custom ${describeArgs(tool.toolName, tool.args)}`;
    for (let width = 6; width <= 100; width++) {
      const colored = tool.render(width);
      const rows = colored.map(plain);
      assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
      assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row.trim()));
      assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""), expected.replace(/ /g, ""));
      assert.ok(rows.every((row) => !row.slice(3).startsWith("\u0301")), "comma plus combining mark remains one grapheme");
      assert.match(colored.at(-1)!, /\x1b\[90m/u, "wrapped parameters preserve their dim role");
      assert.doesNotMatch(rows.join(""), /✓|✗/u);
    }
  } finally { controller.restore(); }
});

test("comma wrap points preserve native CJK breaks in primary descriptions and parameters on failures", () => {
  const tool = new Tool("custom", { path: "甲乙丙丁", drop: "1,2" });
  const { controller } = setup([tool]);
  try {
    assert.equal(plain(tool.render(16)[0]!), " ⚙ custom 甲乙");
    assert.equal(plain(tool.render(18)[0]!), " ⚙ custom 甲乙丙");
    tool.updateArgs({ drop: "1,2" });
    tool.updateResult({ isError: true, content: [{ type: "text", text: "甲乙丙丁" }] });
    assert.deepEqual(tool.render(28).map(plain), [' ⚙ custom [drop="1,2"]']);
    tool.updateArgs({ target: ["甲乙丙丁", "한글かなカナ"] });
    for (let width = 6; width <= 40; width++) {
      const rows = tool.render(width).map(plain);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""),
        `custom ${describeArgs(tool.toolName, tool.args)}`.replace(/ /g, ""));
    }
  } finally { controller.restore(); }
});

test("comma wrapping still hard-wraps oversized array members and expands continuation clicks", () => {
  const tool = new Tool("custom", { paths: ["x".repeat(90), "tail"] });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(30).map(plain);
    assert.ok(rows.length > 3);
    assert.ok(rows.every((row) => visibleWidth(row) <= 30));
    assert.match(rows.map((row) => row.slice(3)).join(""), /x{90}/);
    assert.match(rows.at(-1)!, /"tail"\]\]$/);
    assert.equal(tool.handleMouse(mouse(2, 30))?.handled, true);
    assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(30), ["", "NATIVE custom", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("summary long-word fills remaining space with and without parameter commas", () => {
  const path = "abcdefghijklmnopqrstuvwxyz";
  const tool = new Tool("read", { path });
  const { controller } = setup([tool]);
  try {
    for (const extras of [{}, { offset: 1, limit: 1 }]) {
      tool.updateArgs({ path, ...extras });
      const rows = tool.render(24).map(plain);
      assert.equal(rows[0], " → read abcdefghijklmno");
      assert.ok(rows[1]!.startsWith("   pqrstuvwxyz"));
      assert.equal(rows.map(row => row.slice(3)).join("").replace(/ /g, ""),
        (`read ${describeArgs("read", tool.args)}`).replace(/ /g, ""));
    }
    tool.updateArgs({ query: "x".repeat(50) });
    assert.ok(plain(tool.render(24)[0]!).startsWith(' → read [query="'), "oversized named tokens also use the first row");
  } finally { controller.restore(); }
});

test("summary long-word chooses the nearest separator after it without splitting fitting words", () => {
  const tool = new Tool("read", { path: "abcdefghij/kl/mnopqrstuvwxyz0123456789" });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(24).map(plain);
    assert.equal(rows[0], " → read abcdefghij/kl/");
    assert.ok(rows[1]!.startsWith("   mnop"));
    assert.equal(rows.map(row => row.slice(3)).join(""), `read ${tool.args.path}`);
    tool.updateArgs({ path: "abcdefghijklmnoqrs" });
    assert.deepEqual(tool.render(24).map(plain), [" → read", "   abcdefghijklmnoqrs"], "a word fitting a full row remains intact");
  } finally { controller.restore(); }
});

test("summary long-word limits punctuation retreat to twenty graphemes and half the remaining columns", () => {
  const tool = new Tool("read");
  const { controller } = setup([tool]);
  try {
    tool.updateArgs({ path: "/" + "x".repeat(50) });
    assert.equal(plain(tool.render(24)[0]!), " → read /" + "x".repeat(14), "a leading slash must not waste fourteen free columns");
    for (const distance of [20, 21, 30]) {
      const path = "x".repeat(74 - distance) + "/" + "y".repeat(60);
      tool.updateArgs({ path });
      const first = plain(tool.render(84)[0]!);
      assert.equal(first, " → read " + path.slice(0, distance === 20 ? 55 : 75), `retreat distance ${distance}`);
    }
  } finally { controller.restore(); }
});

test("summary long-word excludes quotes and brackets and respects preferred JSON escape boundaries", () => {
  const tool = new Tool("read");
  const { controller } = setup([tool]);
  try {
    const quoted = "x".repeat(8) + '"' + "y".repeat(30);
    tool.updateArgs({ path: quoted });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(quoted).slice(0, 15), "escaped quote's backslash is not a preferred cut");
    const attachedQuote = "\u0301" + quoted;
    tool.updateArgs({ path: attachedQuote });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(attachedQuote).slice(0, 16), "quote with an attached combining mark still opens JSON escape tracking");
    const windows = "x".repeat(8) + "\\" + "y".repeat(30);
    tool.updateArgs({ path: windows });
    assert.equal(plain(tool.render(24)[0]!), " → read " + JSON.stringify(windows).slice(0, 11), "cut after both serialized backslashes");
    for (const extras of [{}, { offset: 1, limit: 1 }]) {
      tool.updateArgs({ query: "\u0301" + "x".repeat(3) + '"' + "y".repeat(30), ...extras });
      assert.equal(plain(tool.render(24)[0]!).slice(3), (`read ${describeArgs("read", tool.args)}`).slice(0, 21), "quoted parameter with an attached mark retains escape tracking, with or without commas");
    }
    tool.updateArgs({ query: "x\uD800" + "y".repeat(30) });
    assert.equal(plain(tool.render(24)[0]!), ' → read [query="x\\ud800', "backslash within a Unicode escape is not preferred");
    tool.updateArgs({ query: "a\u0600", content: "x".repeat(8) + '"' + "y".repeat(40) });
    assert.equal(plain(tool.render(44)[0]!), ' → read [query="a\u0600", content="xxxxxxxx\\"yyyy', "a Prepend character must not hide the earlier closing quote and leak escape state into another value");
    for (const mark of ['"', "(", ")", "[", "]", "{", "}"]) {
      tool.updateArgs({ query: "x".repeat(3) + mark + "y".repeat(30) });
      const expected = `read ${describeArgs("read", tool.args)}`;
      assert.equal(plain(tool.render(24)[0]!).slice(3), expected.slice(0, 20), `no preferred split at ${mark}`);
    }
  } finally { controller.restore(); }
});

test("summary long-word preserves Unicode graphemes, all text, failure styles, clicks and warm cache hits", () => {
  const path = ("ab/é👩‍👩‍👧‍👦_cdefghijklmno.").repeat(6);
  const tool = new Tool("read", { path, offset: 1, limit: 1 });
  tool.result!.isError = true;
  const root = new Root(); root.addChild(tool);
  const palette = { fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[39m` };
  const controller = installTidyUi(root, () => palette);
  try {
    const expected = `read ${describeArgs("read", tool.args)}`.replace(/ /g, "");
    for (let width = 6; width <= 100; width++) {
      const colored = tool.render(width), rows = colored.map(plain);
      assert.equal(rows.map(row => row.slice(3)).join("").replace(/ /g, ""), expected, `text at width ${width}`);
      assert.ok(rows.every(row => visibleWidth(row) <= width - 1), `one-column margin at ${width}`);
      assert.ok(rows.every(row => !/^[\u0301\u200d]/u.test(row.slice(3))), "no orphan combining or joining mark");
      for (const row of rows) assert.equal(row.split("👩‍👩‍👧‍👦").join("").includes("👩"), false, "no partial family grapheme");
      assert.ok(colored.every(row => row.includes("\x1b[31m")), "all failed rows retain error styling");
      const builds = controller.cacheStats().builds;
      assert.strictEqual(tool.render(width), colored);
      assert.equal(controller.cacheStats().builds, builds);
    }
    const last = tool.render(40).length - 1;
    assert.equal(tool.handleMouse(mouse(last, 40))?.handled, true);
    assert.equal(tool.expanded, true);
    assert.deepEqual(tool.render(40), ["", "NATIVE read", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("compact summaries reserve one right column before wrapping at every usable width", (t) => {
  // Geometry/cache equality is independent of elapsed animation; keep the whole-row comparison strict.
  t.mock.method(performance, "now", () => 0);
  const tool = new Tool("custom", { path: "文件/🦀/é".repeat(8), drop: "1,2,3,5,8,13,21", query: "x".repeat(60) });
  const next = new Tool("read", { path: "b.txt" });
  const { controller } = setup([tool, next]);
  try {
    const args = structuredClone(tool.args);
    for (const state of ["pending", "partial", "success", "error"]) {
      tool.isPartial = state === "partial";
      tool.result = state === "pending" ? undefined : {
        isError: state === "error", content: [{ type: "text", text: state === "error" ? "Failure 文件" : "RAW_RESULT" }],
      };
      const glyph = state === "pending" || state === "partial" ? "⠋" : "⚙";
      const result = structuredClone(tool.result);
      for (let width = 0; width <= 90; width++) {
        const rows = tool.render(width).map(plain);
        if (!width) { assert.deepEqual(rows, []); continue; }
        assert.ok(rows.every((row) => visibleWidth(row) <= Math.max(1, width - 1)), `right margin: ${state}, width ${width}`);
        assert.doesNotMatch(rows.join(""), /…|✓|✗/u);
        if (width <= 5) assert.deepEqual(rows, [(width >= 3 ? " " : "") + glyph], "tiny viewports preserve pending state or tool glyph and the margins that fit");
        else {
          assert.equal(rows[0]!.slice(0, 3), ` ${glyph} `);
          assert.ok(rows.slice(1).every((row) => /^ {3}\S/u.test(row)));
          const expected = `custom ${describeArgs(tool.toolName, tool.args)}`;
          assert.equal(rows.map((row) => row.slice(3)).join("").replace(/ /g, ""), expected.replace(/ /g, ""));
        }
        assert.deepEqual(tool.render(width).map(plain), rows, "cached layout retains right margin");
      }
      assert.deepEqual(tool.args, args);
      assert.deepEqual(tool.result, result);
    }
    tool.isPartial = false; tool.result = { content: [] };
    assert.equal(next.render(30)[0], "", "a narrowed multiline predecessor still owns one following separator");
    assert.equal(next.render(1000).length, 1, "resize back removes the adaptive separator");
  } finally { controller.restore(); }
});

test("zero-width compact rendering cannot retain an adaptive separator", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { controller } = setup([first, second]);
  try {
    assert.deepEqual(first.render(0), []);
    assert.deepEqual(second.render(0), []);
  } finally { controller.restore(); }
});

// Bounded compact argument formatting is independent of result bodies/card content.
const summarySegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const summaryLength = (text: string) => [...summarySegments.segment(text)].length;

test("bounded compact edit path bypasses every other argument and preserves lifecycle/native safeguards", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const args = { path: "src/my file.ts", pattern: "not the title", get edits(): never { return assert.fail("path-only edit must not inspect payloads"); },
    get query(): never { return assert.fail("path-only edit must not inspect ordinary fields"); } };
  assert.equal(describeArgs("edit", args), '"src/my file.ts"');
  const tool = new Tool("edit", args); tool.result = undefined; tool.executionStarted = false;
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(tool.render(80), [' ← edit "src/my file.ts"']);
    tool.markExecutionStarted();
    assert.equal(plain(tool.render(80)[0]!), ' ⠋ edit "src/my file.ts"');
    t.mock.timers.tick(100);
    assert.equal(plain(tool.render(80)[0]!), ' ⠙ edit "src/my file.ts"');
    tool.updateResult({ isError: true, content: [{ type: "text", text: "NATIVE_ERROR" }] });
    assert.deepEqual(tool.render(80), [' ← edit "src/my file.ts"']);
    tool.setExpanded(true);
    assert.deepEqual(tool.render(80), ["", "NATIVE edit", "FULL_OUTPUT"]);
    tool.setExpanded(false); tool.updateArgs({ path: "example.ts", query: "ignored", edits: [] });
    tool.updateResult({ content: [], details: { diff: editDiff } });
    assert.ok(tool.render(80).some(row => plain(row).includes("← Edited example.ts")), "success still uses the existing diff card");
  } finally { controller.restore(); }
  for (const path of [undefined, "", null, false, 0, [], { file: "a" }]) {
    const fallback = { ...(path === undefined ? {} : { path }), query: "fallback", newText: "visible" };
    assert.equal(describeArgs("edit", fallback), describeArgs("custom", fallback));
  }
});

test("bounded compact priorities expose former payloads after unknown fields and retain exact secret masking", () => {
  const payloads = ["content", "edits", "code", "input", "messages", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText"];
  for (const key of payloads) assert.equal(describeArgs("custom", { [key]: "VISIBLE" }), `[${key}="VISIBLE"]`);
  const args = { newText: "new", extra: "unknown", background: true, limit: 2, paths: ["src"], description: "why", query: "q", command: "run", action: "write", op: "apply" };
  const expected = '[op="apply", action="write", command="run", query="q", description="why", paths=["src"], limit=2, background=true, extra="unknown", newText="new"]';
  assert.equal(describeArgs("custom", args), expected);
  assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
  for (const key of ["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"])
    assert.equal(describeArgs("custom", { [key]: "SECRET".repeat(1000) }), `[${key}="<redacted>"]`);
});

test("bounded compact values cap serialized strings, arrays and objects at 256 graphemes without splitting Unicode", () => {
  assert.equal(describeArgs("custom", { content: "x".repeat(254) }), `[content="${"x".repeat(254)}"]`);
  assert.equal(describeArgs("custom", { content: "x".repeat(255) }), `[content="${"x".repeat(253)}…"]`);
  const glyph = "👩‍👩‍👧‍👦é";
  for (const value of [glyph.repeat(300), ["x".repeat(500), "TAIL"], { first: { body: "x".repeat(500) }, tail: "TAIL" }, Array(300).fill("item")]) {
    const before = structuredClone(value);
    const rendered = describeArgs("custom", { query: value }).slice("[query=".length, -1);
    assert.ok(summaryLength(rendered) <= 256, `${summaryLength(rendered)} graphemes`);
    assert.ok(rendered.includes("…"));
    assert.deepEqual(value, before);
    assert.ok(!rendered.endsWith("\\"), "do not cut an escape sequence");
  }
  const unicode = describeArgs("custom", { query: glyph.repeat(300) });
  assert.ok(!unicode.includes("�"));
  assert.ok(unicode.includes("👩‍👩‍👧‍👦é"), "keep joining marks and combining clusters intact");
  assert.ok(unicode.endsWith('…"]'));
  assert.equal(describeArgs("custom", { token: undefined }), "", "undefined secret fields are not supplied values");
  const path = "p".repeat(256);
  assert.equal(describeArgs("edit", { path }), path);
  assert.equal(describeArgs("edit", { path: path + "p" }), "p".repeat(255) + "…");
});

test("bounded compact total text caps name plus description at 1024 graphemes before wrapping and keeps failure colors", () => {
  const args = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${String(i).padStart(2, "0")}`, "v".repeat(180)]));
  const before = structuredClone(args);
  const tool = new Tool("custom", args), root = new Root(); root.addChild(tool);
  const paints: string[] = [];
  const theme = { fg: (role: string, text: string) => { paints.push(role); return text; } };
  const controller = installTidyUi(root, () => theme);
  try {
    const rows = tool.render(5000);
    assert.equal(rows.length, 1);
    assert.ok(summaryLength(rows[0]!.slice(3)) <= 1024);
    assert.ok(rows[0]!.includes("…"));
    assert.match(rows[0]!, /\]$/u, "parameter previews remain bracketed");
    assert.equal(rows[0]!.slice(3), `custom ${describeArgs("custom", args)}`);
    const builds = controller.cacheStats().builds;
    assert.strictEqual(tool.render(5000), rows, "warm completed no-gap frames reuse retained rows");
    assert.equal(controller.cacheStats().builds, builds);
    const narrow = tool.render(24);
    assert.ok(narrow.every(row => visibleWidth(row) <= 23));
    assert.equal(narrow.map(row => row.slice(3)).join("").replace(/ /gu, ""), rows[0]!.slice(3).replace(/ /gu, ""));
    tool.updateResult({ isError: true, content: [{ type: "text", text: "DO_NOT_SHOW" }] });
    paints.length = 0; tool.render(24);
    assert.ok(paints.length > 0 && paints.every(role => role === "error"));
    assert.deepEqual(tool.args, before);
  } finally { controller.restore(); }
});

test("bounded compact formatting never serializes full large strings or reads omitted structured values", (t) => {
  const huge = "x".repeat(1_000_000);
  const stringify = t.mock.method(JSON, "stringify");
  const preview = describeArgs("custom", { query: huge });
  assert.ok(preview.includes("…"));
  assert.ok(stringify.mock.calls.every(call => typeof call.arguments[0] !== "string" || call.arguments[0].length < 600), "only bounded string prefixes may enter JSON serialization");
  assert.equal(stringify.mock.callCount(), 1, "serialize the bounded prefix once, not once per grapheme");
  assert.equal((stringify.mock.calls[0]!.arguments[0] as string).length, 256);
  let visited = 0;
  const values = Array.from({ length: 2000 }, (_, i) => i);
  for (let i = 0; i < values.length; i++) Object.defineProperty(values, i, { get() { visited++; return "value"; }, enumerable: true });
  const output = describeArgs("custom", { query: values });
  assert.ok(output.includes("…"));
  assert.equal(visited, 32, "read 31 complete elements and one abbreviated element, never the other 1968");
  let rootReads = 0;
  const deferred: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) Object.defineProperty(deferred, `field${String(i).padStart(2, "0")}`, {
    enumerable: true, get() { rootReads++; return huge; },
  });
  Object.defineProperty(deferred, "zzTail", { enumerable: true, get() { return assert.fail("overall budget must stop before omitted parameter values"); } });
  assert.ok(describeArgs("custom", deferred).includes("…"));
  assert.equal(rootReads, 4, "three complete fields plus one overflow candidate; no later field values fetched");
});

test("bounded compact object previews mark both an omitted value and subsequent members", () => {
  const value = { a: "x".repeat(239), b: 123456, c: 0 };
  assert.equal(describeArgs("custom", { query: value }), `[query={"a":"${"x".repeat(239)}","b":…,…}]`);
});

test("bounded compact budgets hold across escaped strings, deep containers and priority inventory", () => {
  assert.equal(VALUE_TEXT_LIMIT, 256); assert.equal(SUMMARY_TEXT_LIMIT, 1024);
  assert.equal(new Set(PRIORITY_FIELDS).size, PRIORITY_FIELDS.length, "one unique rank per known parameter name");
  const literal = ['"', "\\", "\\u", "界", "é", "👩‍👩‍👧‍👦", "\ud800", "lone", "\udfff"].join("");
  assert.equal(JSON.parse(describeArgs("custom", { query: literal }).slice("[query=".length, -1)), literal, "escaped wire offsets retain paired/unpaired UTF-16 and literal backslashes");
  const text = literal + "\n\x1b[31mred\x1b[0m";
  let deep: unknown = "leaf";
  for (let i = 0; i < 200; i++) deep = { nested: [deep] };
  const values = [text.repeat(400), deep, { ["key".repeat(200)]: "value" }, Array.from({ length: 100 }, (_, i) => ({ item: text.repeat(i + 1), index: i }))];
  for (const value of values) {
    const output = describeArgs("custom", { query: value });
    const preview = output.slice("[query=".length, -1);
    assert.ok(summaryLength(preview) <= 256);
    assert.ok(preview.includes("…"));
    assert.doesNotMatch(preview, /\x1b|\u202e/u);
  }
  const title = "tool".repeat(300), args = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, text.repeat(40)]));
  const tool = new Tool(title, args), { controller } = setup([tool]);
  try {
    const logical = tool.render(5000)[0]!.slice(3);
    assert.ok(summaryLength(logical) <= 1024);
    assert.ok(logical.startsWith("tool".repeat(63) + "too…"));
  } finally { controller.restore(); }
});

test("path-only file summaries never read unrelated signature fields", () => {
  for (const name of ["edit", "write"]) {
    const args = { path: "example.ts" };
    for (const field of ["command", "description", "workdir", "content", "pattern", "edits"]) Object.defineProperty(args, field, {
      enumerable: true, get() { return assert.fail(`ignored ${name} ${field} must not be accessed`); },
    });
    const node = new Tool(name, args); node.result = { content: [], isError: true, details: {
      get exit_code() { return assert.fail("non-Bash signatures must not inspect Bash-only metadata"); },
    } };
    const { controller } = setup([node]);
    try { assert.deepEqual(node.render(80), [` ← ${name} example.ts`]); assert.equal(controller.active, true); }
    finally { controller.restore(); }
  }
});
