import "./fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CardTheme } from "../src/card-theme.ts";
import { Root, Text, Tool, bashTool, installTidyUi, mouse, plain, setup, type TuiMouseEvent } from "./fixtures/sdk-contract-support.ts";

// Bash cards are a separate presentation, not a specialization of describeArgs.
function bashBody(tool: Tool, width = 80): string[] {
  const rows = tool.render(width).map(plain);
  if (rows[0] === "") rows.shift(); // transcript separator, not card padding
  const origin = width >= 6 ? 3 : [0, 0, 1, 2, 2, 2][width];
  const right = width >= 6 ? 2 : [0, 0, 0, 0, 1, 2][width];
  return rows.slice(1, -1).map((row) => row.slice(origin, right ? -right : undefined).trimEnd());
}

test("bash cards retain whole commands with no continuation alignment", () => {
  const tool = bashTool("python3 - <<'PY'\n  print('hello')\nPY");
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ python3 - <<'PY'", "  print('hello')", "PY"]);
    tool.args.command = "abcdefghijabcdefghij";
    assert.deepEqual(bashBody(tool, 12), ["$ abcde", "fghijab", "cdefghi", "j"]);
    tool.args.command = "a  b\n\n c";
    assert.deepEqual(bashBody(tool), ["$ a  b", "", " c"]);
    tool.args.command = source.command;
    assert.deepEqual(tool.args, source);
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("bash comments are optional, normalized and separated once from the command", () => {
  const tool = bashTool("pwd");
  tool.args.description = "Check\n\tdirectory"; tool.args.workdir = "sub/../elsewhere";
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/elsewhere", "", "$ pwd"]);
    assert.deepEqual(tool.args, source);
    for (const workdir of [".", "/project", "sub/..", ""]) {
      tool.args.workdir = workdir;
      assert.deepEqual(bashBody(tool), ["# Check directory", "", "$ pwd"]);
    }
    delete tool.args.description; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
    tool.args.description = " \n ";
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
  } finally { controller.restore(); }
});

test("bash output trims only blank edges and preserves literal service-looking text", () => {
  const tool = bashTool();
  const { controller } = setup([tool]);
  try {
    for (const text of ["", "\n \t\n", "\x1b[31m\n\x1b[0m"]) {
      tool.result = { content: [{ type: "text", text }] };
      assert.deepEqual(bashBody(tool), ["$ echo hello"]);
    }
    tool.result = { content: [{ type: "text", text: "\n  \nalpha\n\n  beta  \n \n" }] };
    const before = structuredClone(tool.result);
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "alpha", "", "  beta"]);
    assert.deepEqual(tool.result, before);
    tool.result = { content: [{ type: "text", text: "(no output)\nBackground task started: xyz\n[exit code: 7]" }], details: { exit_code: 0, task_id: "xyz" } };
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "(no output)", "Background task started: xyz", "[exit code: 7]"]);
  } finally { controller.restore(); }
});

test("bash preview is the first ten visual rows and expands only available text", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    tool.result = { content: [{ type: "text", text: "X".repeat(190) }] };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19))]);
    tool.result = { content: [{ type: "text", text: "X".repeat(191) }], details: { truncated: true, output_path: "/DO_NOT_READ" } };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "… (Click to expand)"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "X"]);
    assert.equal(tool.result.content[0].text, "X".repeat(191));
  } finally { controller.restore(); }
});

test("bash removes only an exact separated final exit-footer duplicate without rewriting results", () => {
  const tool = bashTool("false"), footer = "[exit code: 7]";
  const { controller } = setup([tool]);
  try {
    const cases: [string, unknown, boolean, boolean, string[]][] = [
      [`BODY\n\n${footer}`, 7, false, false, ["BODY"]],
      [`BODY\n \t\n${footer}\n \n`, 7, false, false, ["BODY"]],
      [`\n${footer}`, 7, false, false, []],
      [`BODY\n\n[exit code: -2; error: execution failed]`, -2, true, false, ["BODY"]],
      [`BODY\n${footer}`, 7, false, false, ["BODY", footer]],
      [`BODY\n\n[exit code: 8]`, 7, false, false, ["BODY", "", "[exit code: 8]"]],
      [`BODY\n\n${footer} `, 7, false, false, ["BODY", "", `${footer} `]],
      [`BODY\n\n ${footer}`, 7, false, false, ["BODY", "", ` ${footer}`]],
      [`BODY\n\n${footer}\nTAIL`, 7, false, false, ["BODY", "", footer, "TAIL"]],
      [`BODY\n\n${footer}`, 7, true, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, "7", false, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, undefined, false, false, ["BODY", "", footer]],
      [`BODY\n\n[exit code: 0]`, 0, false, false, ["BODY", "", "[exit code: 0]"]],
      ["BODY\n\n[error: execution failed]", 0, true, false, ["BODY", "", "[error: execution failed]"]],
      [`BODY\n\n${footer}`, 7, false, true, ["BODY", "", footer]],
      [`BODY\n\n${footer}\n\n${footer}`, 7, false, false, ["BODY", "", footer]],
    ];
    for (const [text, exit_code, isError, partial, displayed] of cases) {
      const result = { content: [{ type: "text", text }], details: { exit_code }, isError };
      tool.updateResult(result, partial);
      const before = structuredClone(result);
      const finalFooter = partial ? "" : typeof exit_code === "number" && exit_code !== 0
        ? `[exit code: ${exit_code}${isError ? "; error: execution failed" : ""}]`
        : isError ? "[error: execution failed]" : "";
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        // This helper discards right padding; row count still detects preserved nonmatching literals.
        assert.deepEqual(bashBody(tool, 100), ["$ false", ...(displayed.length ? ["", ...displayed.map((row) => row.trimEnd())] : []), ...(finalFooter ? ["", finalFooter] : [])], text);
        assert.deepEqual(tool.result, before);
      }
    }
    const result = { content: [{ type: "text", text: "BODY\r\n" }, { type: "text", text: `\u001b[31m${footer}\u001b[0m\r\n` }], details: { exit_code: 7 } };
    const before = structuredClone(result);
    tool.updateResult(result); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ false", "", "BODY", "", footer]);
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test("bash timeout replaces only one exact separated final pair with its own error footer", () => {
  const tool = bashTool("run"), marker = "[command timed out]", exit = "[exit code: 124]";
  const pair = `${marker}\n${exit}`, timeoutFooter = "[exit code: 124; error: command timed out]";
  const { controller } = setup([tool]);
  try {
    const cases: [string, unknown, boolean, boolean, string[], boolean][] = [
      [`BODY\n\n${pair}`, 124, false, false, ["BODY"], true],
      [`BODY\n \t\n${pair}\n \n`, 124, true, false, ["BODY"], true],
      [`\n${pair}`, 124, false, false, [], true],
      [`BODY\n\n${pair}\n\n${pair}`, 124, false, false, ["BODY", "", marker, exit], true],
      [`BODY\n${pair}`, 124, false, false, ["BODY", marker, exit], false],
      [pair, 124, false, false, [marker, exit], false],
      [`BODY\n\n${pair}\nTAIL`, 124, false, false, ["BODY", "", marker, exit, "TAIL"], false],
      [`BODY\n\n ${marker}\n${exit}`, 124, false, false, ["BODY", "", ` ${marker}`, exit], false],
      [`BODY\n\n${marker} \n${exit}`, 124, false, false, ["BODY", "", `${marker} `, exit], false],
      [`BODY\n\n${marker}\n ${exit}`, 124, false, false, ["BODY", "", marker, ` ${exit}`], false],
      [`BODY\n\n${marker}\n${exit} `, 124, false, false, ["BODY", "", marker, `${exit} `], false],
      [`BODY\n\n${marker}\n[exit code: 125]`, 124, false, false, ["BODY", "", marker, "[exit code: 125]"], false],
      [`BODY\n\n${marker}`, 124, false, false, ["BODY", "", marker], false],
      [`BODY\n\n${exit}`, 124, false, false, ["BODY"], false],
      [`BODY\n\n${marker}\n\n${exit}`, 124, false, false, ["BODY", "", marker], false],
      [`BODY\n\n${pair}\n\n${exit}`, 124, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 7, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 0, true, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, "124", false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, undefined, false, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, null, true, false, ["BODY", "", marker, exit], false],
      [`BODY\n\n${pair}`, 124, true, true, ["BODY", "", marker, exit], false],
    ];
    for (const [text, exit_code, isError, partial, displayed, timeout] of cases) {
      const result = { content: [{ type: "text", text }], details: { exit_code }, isError };
      const before = structuredClone(result);
      tool.updateResult(result, partial);
      const footer = partial ? "" : timeout ? timeoutFooter : typeof exit_code === "number" && exit_code !== 0
        ? `[exit code: ${exit_code}${isError ? "; error: execution failed" : ""}]`
        : isError ? "[error: execution failed]" : "";
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        assert.deepEqual(bashBody(tool, 100), ["$ run", ...(displayed.length ? ["", ...displayed.map((line) => line.trimEnd())] : []), ...(footer ? ["", footer] : [])],
          JSON.stringify({ text, exit_code, isError, partial, expanded }));
        assert.deepEqual(tool.result, before, "timeout recognition is presentation-only");
      }
    }
    const result = { content: [{ type: "text", text: "BODY\r\n" },
      { type: "text", text: `\x1b[31m${marker}\x1b[0m\r\n${exit}\r\n` }], details: { exit_code: 124 } };
    const before = structuredClone(result);
    tool.updateResult(result);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", "BODY", "", timeoutFooter], "match sanitized logical rows across content blocks");
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test("bash timeout filtering precedes visual cutoff and preserves partial-to-final snapshots", () => {
  const tool = bashTool("run"), footer = "[exit code: 124; error: command timed out]";
  const rows = Array.from({ length: 9 }, (_, index) => `ROW_${index}`);
  const raw = rows.join("\n") + "\n\n[command timed out]\n[exit code: 124]";
  const result = { content: [{ type: "text", text: raw }], details: { exit_code: 124 }, isError: false };
  const before = structuredClone(result), { controller } = setup([tool]);
  try {
    tool.updateResult(result, true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "… (Click to expand)"], "partial retains raw tail as hidden output, not a completion footer");
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "", "[command timed out]", "[exit code: 124]"], "expanded partial exposes both literals");
    tool.updateResult(result); tool.setExpanded(false);
    for (const width of [100, 24]) {
      const available = width - 5;
      // bashBody discards terminal right padding, including a fragment's trailing space.
      const fragments = Array.from({ length: Math.ceil(footer.length / available) }, (_, index) => footer.slice(index * available, (index + 1) * available).trimEnd());
      assert.deepEqual(bashBody(tool, width), ["$ run", "", ...rows, "", ...fragments]);
      assert.equal(tool.handleMouse(mouse(2, width)), undefined, "nine real output rows do not become expandable from synthetic status rows");
      assert.equal(tool.expanded, false);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, width), ["$ run", "", ...rows, "", ...fragments]);
      tool.setExpanded(false);
    }
    const longer = [...rows, "ROW_9", "HIDDEN_TAIL"].join("\n") + "\n\n[command timed out]\n[exit code: 124]";
    tool.updateResult({ ...result, content: [{ type: "text", text: longer }] });
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "ROW_9", "… (Click to expand)", "", footer]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ run", "", ...rows, "ROW_9", "HIDDEN_TAIL", "", footer]);
    assert.deepEqual(result, before, "all updates leave the original snapshot intact");
  } finally { controller.restore(); }
});

test("bash timeout footer wraps entirely in the error role without recoloring command output", () => {
  const root = new Root(), tool = bashTool("run"); root.addChild(tool);
  tool.updateResult({ content: [{ type: "text", text: "BODY\n\n[command timed out]\n[exit code: 124]" }], details: { exit_code: 124 }, isError: true });
  const fg: [string, string][] = [], bg: string[] = [];
  const controller = installTidyUi(root, () => ({
    fg: (role, text) => { fg.push([role, text]); return text; },
    bg: (role, text) => { bg.push(role); return text; },
  }));
  try {
    for (const width of [100, 24]) {
      fg.length = 0; bg.length = 0;
      const lines = tool.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(fg.filter(([role, text]) => role === "error" && text !== "┃").map(([, text]) => text).join(""),
        "[exit code: 124; error: command timed out]");
      assert.deepEqual(fg.filter(([role]) => role === "toolOutput").map(([, text]) => text), ["BODY"]);
      assert.ok(fg.some(([role, text]) => role === "error" && text === "┃"), "error stripe remains metadata-derived");
      assert.deepEqual([...new Set(bg)], ["toolPendingBg"]);
    }
  } finally { controller.restore(); }
});

test("bash removes trailing preview blanks before hint without backfilling or changing expansion", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    const reported = ["✖ real CLI: cache work (25298.723022ms)", "ℹ tests 1", "ℹ suites 0", "ℹ pass 0", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 25403.258316"];
    const original = [...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"].join("\n");
    tool.updateResult({ content: [{ type: "text", text: original }], details: { exit_code: 1 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "… (Click to expand)", "", "[exit code: 1]"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"]);
    assert.equal(tool.result?.content[0].text, original);
    for (const blank of ["", " \t", "\n\n"]) {
      const rows = Array.from({ length: 9 }, (_, i) => `ROW_${i}`);
      const text = [...rows, blank, "HIDDEN_TAIL"].join("\n");
      tool.updateResult({ content: [{ type: "text", text }] }); tool.setExpanded(false);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, "… (Click to expand)"]);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, ...blank.split("\n").map(() => ""), "HIDDEN_TAIL"]);
      assert.equal(tool.result?.content[0].text, text);
    }
    tool.updateResult({ content: [{ type: "text", text: "A\n\nB\n" + Array(8).fill("C").join("\n") }] }); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", "A", "", "B", ...Array(7).fill("C"), "… (Click to expand)"]);
    // A nonempty logical row can wrap into whitespace-only rows at the preview boundary.
    tool.updateResult({ content: [{ type: "text", text: "A".repeat(19 * 9) + " ".repeat(19 * 2) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(9).fill("A".repeat(19)), "… (Click to expand)"]);
    tool.updateResult({ content: [{ type: "text", text: " ".repeat(19 * 11) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", "… (Click to expand)"]);
    // Removing a matching suffix changes overflow/expandability before the cutoff.
    tool.updateResult({ content: [{ type: "text", text: Array(9).fill("ROW").join("\n") + "\n\n[exit code: 7]" }], details: { exit_code: 7 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...Array(9).fill("ROW"), "", "[exit code: 7]"]);
    assert.equal(tool.handleMouse(mouse(2, 100)), undefined);
    assert.equal(tool.expanded, false);
  } finally { controller.restore(); }
});

test("bash exit/error status uses persisted numeric metadata and flags, never output parsing", () => {
  const tool = bashTool("false");
  const cases: [unknown, boolean, string | undefined][] = [
    [7, false, "[exit code: 7]"], [7, true, "[exit code: 7; error: execution failed]"],
    [0, true, "[error: execution failed]"], [undefined, true, "[error: execution failed]"],
    [0, false, undefined], [undefined, false, undefined], [null, false, undefined],
    ["7", false, undefined], [NaN, false, undefined], [1.5, false, undefined], [-9, false, "[exit code: -9]"],
  ];
  const { controller } = setup([tool]);
  try {
    for (const [exit_code, isError, footer] of cases) {
      tool.result = { content: [], details: { exit_code }, isError, structuredContent: { exit_code: 123 } };
      assert.deepEqual(bashBody(tool), ["$ false", ...(footer ? ["", footer] : [])]);
    }
    tool.result = { content: [{ type: "text", text: "Command exited with code 9" }] };
    assert.deepEqual(bashBody(tool), ["$ false", "", "Command exited with code 9"]);
    tool.isPartial = true;
    tool.result = { content: [], details: { exit_code: 9 }, isError: true };
    assert.deepEqual(bashBody(tool), ["$ false"]);
  } finally { controller.restore(); }
});

test("bash streaming replaces snapshots and keeps custom presentation after Ctrl+O", () => {
  const tool = bashTool("run");
  const { controller } = setup([tool]);
  try {
    tool.updateResult(undefined, true);
    assert.deepEqual(bashBody(tool), ["$ run"]);
    tool.updateResult({ content: [{ type: "text", text: "PARTIAL" }] }, true);
    assert.deepEqual(bashBody(tool), ["$ run", "", "PARTIAL"]);
    tool.setExpanded(true);
    tool.updateResult({ content: [{ type: "text", text: "FINAL" }] });
    assert.deepEqual(bashBody(tool), ["$ run", "", "FINAL"]);
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL|NATIVE/);
    controller.restore();
    assert.match(tool.render(80).join(""), /NATIVE bash/);
  } finally { controller.restore(); }
});

test("bash whole-panel clicks toggle during streaming without capturing wheel or secondary events", () => {
  const tool = bashTool("run"); tool.args.description = "Description"; tool.args.workdir = "sub";
  tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 11 }, (_, i) => `LINE_${i}`).join("\n") }], details: { exit_code: 4 } }, true);
  const { root, controller } = setup([new Text("User", 0, 0), tool]);
  try {
    root.render(80);
    let rows = tool.render(80).map(plain);
    const output = rows.findIndex((row) => row.includes("LINE_0"));
    assert.equal(tool.handleMouse(mouse(0)), undefined);
    for (let y = 1; y < output; y++) {
      assert.ok(tool.handleMouse(mouse(y))?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, true);
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, false);
    rows = tool.render(80).map(plain);
    const hint = rows.findIndex((row) => row.includes("Click to expand"));
    assert.ok(tool.handleMouse(mouse(hint))?.handled);
    assert.equal(tool.expanded, true);
    assert.equal(tool.handleMouse({ ...mouse(output), type: "wheel", wheelDelta: -1 }), undefined);
    assert.equal(tool.handleMouse({ ...mouse(output), button: "right" }), undefined);
    tool.updateResult(tool.result);
    rows = tool.render(80).map(plain);
    const footer = rows.findIndex((row) => row.includes("exit code:"));
    assert.ok(tool.handleMouse(mouse(footer))?.handled);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse(mouse(tool.render(80).length - 1))?.handled);
    assert.equal(tool.expanded, true);
  } finally { controller.restore(); }
});

test("bash foregrounds and neutral panel follow live theme while Unicode geometry stays safe", () => {
  const root = new Root(), tool = bashTool("printf '\t界é👩‍💻'\n\tsecond"); root.addChild(tool);
  tool.args.description = "Describe"; tool.args.workdir = "sub";
  tool.result = { content: [{ type: "text", text: "\x1b]0;BAD\x07\x1b[31mOUTPUT\x1b[0m\r\n  é\u202e" }] };
  const fg: [string, string][] = [], bg: string[] = [];
  let theme = "A";
  const controller = installTidyUi(root, () => ({
    fg: (role, text) => { fg.push([role, text]); return text; },
    bg: (role: string, text: string) => { bg.push(`${theme}:${role}`); return text; },
  }));
  try {
    for (let width = 1; width <= 40; width++) {
      for (const row of tool.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${width}: ${JSON.stringify(row)}`);
        assert.doesNotMatch(row.replace(/^\x1b\[49m/u, ""), /[\x00-\x1f\x7f-\x9f\u202e]/u,
          "only the frame's trusted leading background reset is permitted");
      }
    }
    fg.length = 0; bg.length = 0; tool.render(80);
    assert.ok(fg.some(([role, text]) => role === "dim" && text === "$ "));
    assert.ok(fg.some(([role, text]) => role === "toolTitle" && text.includes("printf")));
    assert.ok(fg.some(([role, text]) => role === "muted" && text.includes("Describe")));
    assert.ok(fg.some(([role, text]) => role === "toolOutput" && text === "OUTPUT"));
    assert.deepEqual([...new Set(bg)], ["A:toolPendingBg"]);
    theme = "B"; tool.isPartial = true; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    tool.isPartial = false; tool.result.details = { exit_code: 3 }; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    assert.ok(fg.some(([role, text]) => role === "error" && text.includes("exit code: 3")));
  } finally { controller.restore(); }
});

test("bash policy preserves explicit native/compact overrides and image safeguards", () => {
  for (const [options, expected] of [[{ cards: ["bash"] }, /NATIVE bash/], [{ cards: ["bash"], compact: ["bash"] }, /⚙ bash/]] as const) {
    const tool = bashTool();
    const { controller } = setup([tool], options);
    try { assert.match(tool.render(80).join(""), expected); } finally { controller.restore(); }
  }
  const image = bashTool(); image.result = { content: [{ type: "image" }] };
  const { controller, original } = setup([image]);
  try { assert.deepEqual(image.render(80), original.call(image, 80)); } finally { controller.restore(); }
});

test("bash exterior margins are not expansion targets and hidden self cards stay hidden", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("LINE").join("\n") }] };
  const { controller } = setup([tool]);
  try {
    const y = tool.render(80).map(plain).findIndex((row) => row.includes("LINE"));
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(y), x }), undefined);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse({ ...mouse(y), x: 2 })?.handled);
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
    tool.expanded = false;
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
  } finally { controller.restore(); }
  class HiddenBash extends Tool {
    getRenderShell() { return "self"; }
    render(_width: number): string[] { return []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new HiddenBash("bash", { command: "echo HIDDEN" });
  const frame = setup([hidden]);
  try { assert.deepEqual(hidden.render(80), []); assert.equal(hidden.handleMouse(mouse(0)), undefined); }
  finally { frame.controller.restore(); }
});

test("bash keeps Unicode joining sequences intact instead of deleting their joining marks", () => {
  const tool = bashTool("echo 👩‍💻");
  tool.result = { content: [{ type: "text", text: "👩‍💻 é" }] };
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ echo 👩‍💻", "", "👩‍💻 é"]);
    assert.ok(bashBody(tool, 9).some((row) => row === "👩‍💻"));
  } finally { controller.restore(); }
});

test("bash removes every Unicode bidi control, including Arabic letter marks, without changing inputs", () => {
  const tool = bashTool("printf '\u061c123'");
  tool.args.description = "Check\u061c directory"; tool.args.workdir = "sub\u061c";
  tool.result = { content: [{ type: "text", text: "\u061c" }] };
  const before = structuredClone({ args: tool.args, result: tool.result });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(80);
    assert.ok(rows.every((row) => !/\p{Bidi_Control}/u.test(row)));
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/sub", "", "$ printf '123'"]);
    assert.deepEqual({ args: tool.args, result: tool.result }, before);
    tool.args.description = "\u061c"; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ printf '123'"]);
  } finally { controller.restore(); }
});

test("OpenCode-style bash shell has external margins and a shared content origin", () => {
  const tool = bashTool("echo ok"); tool.result = { content: [{ type: "text", text: "ok" }] };
  const { controller } = setup([tool]);
  try {
    const row = (content: string) => " ┃ " + content.padEnd(75) + "  ";
    assert.deepEqual(tool.render(80).map(plain), [row(""), row("$ echo ok"), row(""), row("ok"), row("")]);
    for (let width = 0; width <= 80; width++) {
      const rows = tool.render(width);
      if (!width) assert.deepEqual(rows, []);
      else for (const line of rows) assert.equal(visibleWidth(line), width);
    }
  } finally { controller.restore(); }
});

test("the whole expandable panel is clickable but margins, selection and drags are not", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const { root, controller } = setup([new Text("Before", 0, 0), tool]);
  try {
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(1), x }), undefined);
    for (const point of [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 78, y: tool.render(80).length - 1 }]) {
      assert.ok(tool.handleMouse({ ...mouse(point.y), x: point.x })?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    root.selection = true;
    assert.equal(tool.handleMouse(mouse(2)), undefined);
    root.selection = false;
    for (const type of ["press", "release", "drag", "wheel"] as const) assert.equal(tool.handleMouse({ ...mouse(2), type }), undefined);
    assert.equal(tool.expanded, false);
    assert.equal(tool.handleMouse({ ...mouse(2), button: "right" }), undefined);
    assert.equal(tool.handleMouse(mouse(0)), undefined, "transcript separator");
  } finally { controller.restore(); }
});

test("narrow truncated bash hints cannot reset the panel background or dim foreground", async () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const theme: CardTheme = {
    fg: (_role, text) => `\x1b[38;2;180;180;180m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
  };
  const controller = installTidyUi(root, () => theme);
  const terminal = new xterm.Terminal({ cols: 22, rows: 30, allowProposedApi: true });
  try {
    const rows = tool.render(22);
    await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
    for (let y = 0; y < rows.length; y++) {
      if (!plain(rows[y]!).includes("┃")) continue;
      for (let x = 0; x < 22; x++) {
        const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
        if (x <= 1 || x >= 21) assert.equal(cell.getBgColorMode(), 0, "exterior and stripe keep default background");
        else assert.equal(cell.getBgColor(), 0x202020, `painted panel cell (${x},${y})`);
      }
    }
    const hint = rows.findIndex((row) => plain(row).includes("… (Click"));
    assert.ok(hint >= 0);
    for (let x = 3; x < 3 + visibleWidth(plain(rows[hint]!).slice(3, -2).trimEnd()); x++) {
      assert.equal(terminal.buffer.active.getLine(hint)!.getCell(x)!.getFgColor(), 0xb4b4b4, "entire hint retains semantic foreground");
    }
  } finally { controller.restore(); terminal.dispose(); }
});

test("forced compact Bash invalidates all displayed parameters on reused mutable argument updates", () => {
  const args = { command: "echo ok", timeout: 1 }, tool = new Tool("bash", args);
  const { root, controller } = setup([tool], { compact: ["bash"] });
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=1")));
    args.timeout = 2; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=2")));
    assert.equal(controller.cacheStats().builds, 2);
  } finally { controller.restore(); }
});
