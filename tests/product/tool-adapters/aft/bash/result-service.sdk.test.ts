import "../../../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bashBody } from "../../../../helpers/bash-body.ts";
import { hasHostInk } from "../../../../fixtures/host-cells.ts";
import { cardInputTheme, Root, bashTool, installTidyUi, mouse, setup } from "../../../../fixtures/sdk-contract-support.ts";

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

test("bash timeout footer wraps entirely in the error role without recoloring command output", async () => {
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
      assert.equal(await hasHostInk(lines, cardInputTheme, 'error', '[exit code: 124; error: command timed out]'), true);
      assert.equal(await hasHostInk(lines, cardInputTheme, 'toolOutput', 'BODY'), true);
      assert.equal(await hasHostInk(lines, cardInputTheme, 'error', '┃'), true, 'error stripe remains metadata-derived');
      assert.deepEqual([fg.length, bg.length], [0, 0], 'literal custom-card paint never calls legacy formatters');
    }
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
      tool.updateResult({ content: [], details: { exit_code }, isError, structuredContent: { exit_code: 123 } }, tool.isPartial);
      assert.deepEqual(bashBody(tool), ["$ false", ...(footer ? ["", footer] : [])]);
    }
    tool.updateResult({ content: [{ type: "text", text: "Command exited with code 9" }] }, tool.isPartial);
    assert.deepEqual(bashBody(tool), ["$ false", "", "Command exited with code 9"]);
    tool.updateResult(tool.result, true);
    tool.updateResult({ content: [], details: { exit_code: 9 }, isError: true }, tool.isPartial);
    assert.deepEqual(bashBody(tool), ["$ false"]);
  } finally { controller.restore(); }
});
