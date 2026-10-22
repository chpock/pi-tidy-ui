// Offline real-CLI fixture: built-ins stay real unless the isolated bash-shape opt-in is set.
import { CustomEditor, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type ToolCall } from "@earendil-works/pi-ai";
import { Container, Text, matchesKey, type TUI, type OverlayHandle } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { followPiText } from "./follow-pi-source.ts";
import { createEventRecorder } from './terminal-output.ts';
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

// Counter-only native wrapper; unwrap the prior fixture on reload instead of stacking observers.
const nativeProbeKey = Symbol.for("tidy-ui-test:native-render-original");
function observeNativeRenders(counts: Record<string, number>) {
  const current = ToolExecutionComponent.prototype.render as typeof ToolExecutionComponent.prototype.render & {
    [nativeProbeKey]?: typeof ToolExecutionComponent.prototype.render;
  };
  const original = current[nativeProbeKey] ?? current;
  function observed(this: ToolExecutionComponent, width: number) {
    const name = Reflect.get(this, "toolName");
    if (typeof name === "string") counts[name] = (counts[name] ?? 0) + 1;
    return original.call(this, width);
  }
  Object.defineProperty(observed, nativeProbeKey, { value: original });
  ToolExecutionComponent.prototype.render = observed;
}

// Opt-in geometry probe: use the host rectangle even when the popup has no border.
function observeMenuGeometry(tui: TUI, record: (event: object) => void): () => void {
  let handle: OverlayHandle | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(tui, 'showOverlay'), original = tui.showOverlay;
  function show(this: TUI, ...args: Parameters<TUI['showOverlay']>) { return handle = original.apply(this, args); }
  tui.showOverlay = show;
  const remove = tui.addInputListener(data => {
    if (!matchesKey(data, 'ctrl+alt+g')) return;
    record({ type: 'menu_bounds', bounds: handle?.getBounds() ?? null });
    return { consume: true };
  });
  return () => {
    remove(); handle = undefined;
    if (tui.showOverlay !== show) return;
    if (descriptor) Object.defineProperty(tui, 'showOverlay', descriptor); else Reflect.deleteProperty(tui, 'showOverlay');
  };
}

export default function terminalDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let tui: any;
  const record = createEventRecorder(output);
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Observe host geometry only: no draft access, command injection or render request.
  const observeTerminalSize = () => record({ type: "terminal_size", width: process.stdout.columns, height: process.stdout.rows });
  let stopMenuGeometry: (() => void) | undefined;
  pi.on("session_shutdown", () => { process.stdout.off("resize", observeTerminalSize); stopMenuGeometry?.(); stopMenuGeometry = undefined; });
  // Opt-in UI-clock observations only: real timers/render requests, no model/session mutation.
  const editPerformance = process.env.TIDY_UI_TEST_EDIT_PERFORMANCE === "1";
  const editDiagnostics = process.env.TIDY_UI_TEST_EDIT_CARDS === "1" || editPerformance;
  const nativeRenderCalls: Record<string, number> = {};
  if (editDiagnostics) observeNativeRenders(nativeRenderCalls);
  const userDiagnostics = process.env.TIDY_UI_TEST_USER_CARDS === "1";
  const queuedDiagnostics = process.env.TIDY_UI_TEST_QUEUED_CARDS === "1";
  let queuedRequests = 0;
  const userWork = { transforms: 0, widths: [] as number[] };
  if (userDiagnostics) pi.registerMarkdownTransformer((text, context) => {
    if (context.messageType !== "user") return text;
    userWork.transforms++; userWork.widths.push(context.availableWidth);
    return text + "\n\nTRANSFORMED_USER";
  });
  const spinnerDiagnostics = process.env.TIDY_UI_TEST_SPINNER_DIAGNOSTICS === "1";
  const spinnerStats = { starts: 0, cancels: 0, active: 0, maxActive: 0, ticks: 0, requests: 0, unrefs: 0, delays: [] as number[] };
  let insideSpinnerTick = false;
  const spinnerWork = { widths: {} as Record<string, number>, invalidations: 0 };
  const observedSpinnerNodes = new WeakSet<object>();
  function observedToolRender(this: any, width: number) {
    const key = `${this.toolName}:${width}`; spinnerWork.widths[key] = (spinnerWork.widths[key] ?? 0) + 1;
    return Object.getPrototypeOf(this).render.call(this, width);
  }
  function observedToolInvalidate(this: any) {
    spinnerWork.invalidations++;
    return Object.getPrototypeOf(this).invalidate.call(this);
  }
  const spinnerHandles = new Set<ReturnType<typeof setTimeout>>();
  const nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  let nativeRequest: (() => void) | undefined;
  if (spinnerDiagnostics) {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (callback.name !== "tickSpinner") return nativeTimeout(callback, delay, ...args);
      const handle = nativeTimeout(function (this: unknown, ...values: unknown[]) {
        spinnerHandles.delete(handle); spinnerStats.active = spinnerHandles.size;
        spinnerStats.ticks++; insideSpinnerTick = true;
        try { callback.apply(this, values); }
        finally { insideSpinnerTick = false; }
        if ([4, 20].includes(spinnerStats.ticks)) record({ type: "spinner_tick_checkpoint", ticks: spinnerStats.ticks });
      }, delay, ...args);
      const unref = handle.unref;
      handle.unref = function () { spinnerStats.unrefs++; return unref.call(this); };
      spinnerHandles.add(handle); spinnerStats.starts++; spinnerStats.active = spinnerHandles.size;
      spinnerStats.maxActive = Math.max(spinnerStats.maxActive, spinnerStats.active); spinnerStats.delays.push(delay ?? 0);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if (spinnerHandles.delete(handle)) { spinnerStats.cancels++; spinnerStats.active = spinnerHandles.size; }
      nativeClear(handle);
    }) as typeof clearTimeout;
    pi.on("session_shutdown", () => {
      globalThis.setTimeout = nativeTimeout; globalThis.clearTimeout = nativeClear;
      if (nativeRequest && tui) tui.requestRender = nativeRequest;
    });
    pi.registerCommand("tidy-ui-spinner-working", {
      description: "Control native Working animation through its public API for fallback coverage",
      handler: async (mode, ctx) => {
        if (mode === "static") ctx.ui.setWorkingIndicator({ frames: ["●"] });
        else if (mode === "animated") ctx.ui.setWorkingIndicator(undefined);
        else throw new Error("Expected static or animated");
        record({ type: "spinner_working", mode });
        ctx.ui.notify(`SPINNER_WORKING_${mode}`, "info");
      },
    });
  }
  async function gate(name: string, signal?: AbortSignal, timeout = 15000) {
    const end = Date.now() + timeout;
    while (!existsSync(join(output, name))) {
      if (signal?.aborted || Date.now() > end) throw new Error(`Fixture gate expired: ${name}`);
      await wait(25);
    }
  }
  // Representative AFT-shaped results only; this never loads or executes installed AFT.
  // It must be enabled in a separate invocation, never in the built-in scenarios.
  const bashShape = process.env.TIDY_UI_TEST_BASH_SHAPE === "1";
  const writeShape = process.env.TIDY_UI_TEST_WRITE_SHAPE === "1";
  const writeDiagnostics = process.env.TIDY_UI_TEST_WRITE_CARDS === "1";
  const writeSource = '/* write comment\ncontinued write comment */\nexport const value = "界é";\n' +
    Array.from({ length: 15 }, (_, i) => `const line${i + 4} = ${i + 4};`).join("\n") + '\nconst WRITE_TAIL_19 = 19;';
  const writeStockSuite: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "write", arguments: { path: "write-stock.ts", content: writeSource } },
    { name: "write", arguments: { path: "write-stock.ts", content: "const overwritten = 20;\n" } },
    { name: "write", arguments: { path: "write-empty.ts", content: "const filled = 21;\n" } },
    { name: "write", arguments: { path: "write-cleared.ts", content: "" } },
    { name: "write", arguments: { path: "write-directory", content: "FAILED_WRITE_PAYLOAD" } },
  ];
  const writeShapeCases = ["created", "edited", "replaced", "cleared", "noop", "context-only", "truncated", "malformed", "plain", "hidden"];
  const writeShapeSuite: Pick<ToolCall, "name" | "arguments">[] = [
    ...writeShapeCases.map(fixtureCase => ({ name: "write", arguments: { path: `write-${fixtureCase}.ts`,
      content: fixtureCase === "created" ? "ARGS_CREATED_MUST_NOT_REPLACE_RESULT" : fixtureCase === "cleared" ? "" : `const supplied_${fixtureCase.replace(/-/g, "_")} = 42;`, fixtureCase } })),
    { name: "read", arguments: { path: "a.txt", limit: 1 } },
  ];
  if (writeShape) pi.registerTool({
    name: "write", label: "Representative write fixture", description: "Isolated saved-metadata write fixture; never executes AFT or changes files",
    parameters: Type.Object({ path: Type.String(), content: Type.String(), fixtureCase: Type.String() }),
    renderShell: "self",
    renderCall(args, theme) { return new Text(args.fixtureCase === "hidden" ? "" : theme.fg("toolTitle", `NATIVE_WRITE ${args.path}`), 0, 0); },
    renderResult(result) { return new Text((result.details as { hidden?: boolean })?.hidden ? "" : result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0); },
    async execute(_id, args, signal, onUpdate) {
      if (args.fixtureCase === "created" && writeDiagnostics) {
        onUpdate?.({ content: [{ type: "text", text: "PROPOSED_WRITE_BODY" }], details: { diff: "+1 PROPOSED_WRITE_DIFF" } });
        record({ type: "write_execution_gate" }); await gate("write-execution-go", signal);
      }
      const diff = (value: string) => ({ diff: value });
      const details = args.fixtureCase === "created" ? diff(writeSource.split("\n").map((line, i) => `+${i + 1} ${line}`).join("\n")) :
        args.fixtureCase === "edited" ? diff(" 1 const old1 = 1;\n 2 const old2 = 2;\n 3 const old3 = 3;\n 4 const old4 = 4;\n+5 const ADDED_WRITE = 5;\n 5 const tail = 6;") :
        args.fixtureCase === "replaced" ? { patch: "@@ -1,2 +1,2 @@\n-const BEFORE_WRITE = 1;\n-const OLD_WRITE = 2;\n+const AFTER_WRITE = 3;\n+const NEXT_WRITE = 4;\n" } :
        args.fixtureCase === "cleared" ? diff("-1 const ERASED_WRITE = 1;") :
        args.fixtureCase === "noop" ? { diff: "", noOp: true } : args.fixtureCase === "context-only" ? diff(" 1 const unchanged = 1;") :
        args.fixtureCase === "truncated" ? { diff: "+1 INCOMPLETE_DIFF", truncated: true } :
        args.fixtureCase === "malformed" ? { patch: "@@ -1 +1 @@\n-UNFINISHED\n", diff: "+1 LOWER_PRIORITY" } :
        args.fixtureCase === "hidden" ? { diff: "+1 HIDDEN_WRITE", hidden: true } : undefined;
      return { content: [{ type: "text", text: `NATIVE_WRITE_RESULT_${args.fixtureCase}` }], details };
    },
  });
  if (bashShape) pi.registerTool({
    name: "bash", label: "Representative bash fixture", description: "Isolated deterministic bash-shaped result fixture",
    parameters: Type.Object({ command: Type.String(), description: Type.Optional(Type.String()),
      workdir: Type.Optional(Type.String()), fixtureCase: Type.String() }),
    async execute(_id, args, signal, onUpdate) {
      const text = (value: string) => [{ type: "text" as const, text: value }];
      const row = (count: number) => Array.from({ length: count }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, "0")}`).join("\n");
      const result = (value: string, code?: unknown, isError = false) => ({ content: text(value),
        details: code === undefined ? undefined : { exit_code: code }, isError });
      const task = (value: string, code = 0) => ({ ...result(value, code), details: { exit_code: code, task_id: 'bash-443fe78c4d7f1e35' } });
      switch (args.fixtureCase) {
        // Exact AFT 0.60 final-result shapes, not installed AFT execution.
        case 'task-empty': return task('[task bash-443fe78c4d7f1e35]');
        case 'task-exit': return task('FAIL_BODY\n[task bash-0000000000000000]\n\n[exit code: 7]\n[task bash-443fe78c4d7f1e35]\n\n<system-reminder>\nNOTICE\n</system-reminder>', 7);
        case 'task-timeout': return task('TIMEOUT_BODY\n\n[command timed out]\n[exit code: 124]\n[task bash-443fe78c4d7f1e35 (job 0192a64a-1234-7000-8000-000000000001)]', 124);
        case 'task-cap': return task(row(10) + '\n[task bash-443fe78c4d7f1e35]\nshown 10 of 20 lines (cap)');
        case "literal": return { content: [...text("(no output)\nBackground task started: task-id-123"),
          ...text("[exit code: 99]\nCommand exited with code 77")], details: undefined };
        case "whitespace": return result(" \t\n\r\n  ");
        case "ten": return result(row(10));
        case "eleven": return result(row(11));
        case "soft": return result("S".repeat(221));
        case "edges": return result(" \n\n  INDENT  \n\nTAIL  \n \t");
        case "exit": return result("SHAPE_DIAGNOSTIC", 7);
        case "both": return result("SHAPE_DIAGNOSTIC", -2, true);
        case "zero-error": return result("SHAPE_DIAGNOSTIC", 0, true);
        case "unknown-error": return result("SHAPE_DIAGNOSTIC", undefined, true);
        case "zero": return result("SHAPE_OK", 0);
        case "string": return result("SHAPE_OK", "9");
        case "null": return result("SHAPE_OK", null);
        case "transient": return { ...result("SHAPE_OK"), structuredContent: { exit_code: 9 } };
        // Presentation-exception scenarios are separate from the original fourteen shape cases.
        case "suffix-match": return result("BODY\n \t\n[exit code: 7]\n\n \t", 7);
        case "suffix-only": return result("\n[exit code: 7]", 7);
        case "suffix-mismatch": return result("BODY\n\n[exit code: 8]", 7);
        case "suffix-no-gap": return result("BODY\n[exit code: 7]", 7);
        case "suffix-combined": return result("BODY\n\n[exit code: -2; error: execution failed]", -2, true);
        case "suffix-error-only": return result("BODY\n\n[error: execution failed]", undefined, true);
        case "suffix-error-mismatch": return result("BODY\n\n[exit code: 7]", 7, true);
        case "suffix-success": return result("BODY\n\n[exit code: 0]", 0);
        case "suffix-unknown": return result("BODY\n\n[exit code: 7]");
        case "suffix-string": return result("BODY\n\n[exit code: 7]", "7");
        case "suffix-indent": return result("BODY\n\n [exit code: 7]", 7);
        case "suffix-spaces": return result("BODY\n\n[exit code: 7] ", 7);
        case "suffix-fragment": return result("BODY\n\nPREFIX [exit code: 7]", 7);
        case "suffix-nonterminal": return result("BODY\n\n[exit code: 7]\nAFTER_SUFFIX", 7);
        case "suffix-double": return result("BODY\n\n[exit code: 7]\n\n[exit code: 7]", 7);
        case "preview-one-blank": return result(row(9) + "\n\nHIDDEN_TAIL");
        case "preview-two-blanks": return result(row(9) + "\n\n \t\nHIDDEN_TAIL");
        case "preview-interior": return result(row(3) + "\n\n" + row(5) + "\n\nHIDDEN_TAIL");
        case "preview-empty": return result(" ".repeat(1100) + "HIDDEN_TAIL");
        case "suffix-deep": return result(row(9) + "\n\nEXTRA_CONTENT\nHIDDEN_TAIL\n\n[exit code: 7]", 7);
        // Exact timeout-tail cases are opt-in presentation data, not AFT execution.
        case "timeout-match": return result("BODY\n \t\n[command timed out]\n[exit code: 124]\n \n", 124);
        case "timeout-both": return result("BODY\n\n[command timed out]\n[exit code: 124]", 124, true);
        case "timeout-only": return result("\n[command timed out]\n[exit code: 124]", 124);
        case "timeout-no-gap": return result("BODY\n[command timed out]\n[exit code: 124]", 124);
        case "timeout-mismatch": return result("BODY\n\n[command timed out]\n[exit code: 125]", 124);
        case "timeout-string": return result("BODY\n\n[command timed out]\n[exit code: 124]", "124");
        case "timeout-unknown": return result("BODY\n\n[command timed out]\n[exit code: 124]");
        case "timeout-code-only": return result("BODY\n\n[exit code: 124]", 124);
        case "timeout-interior": return result("BODY\n\n[command timed out]\n[exit code: 124]\nAFTER_TIMEOUT", 124);
        case "timeout-preview": return result(row(9) + "\n\n[command timed out]\n[exit code: 124]", 124);
        case "timeout-deep": return result(row(11) + "\n\n[command timed out]\n[exit code: 124]", 124);
        case "timeout-indent": return result("BODY\n\n [command timed out]\n[exit code: 124]", 124);
        // AFT-shaped reminders exercise presentation only, never the installed AFT runtime.
        case "reminder-inline": return result("INLINE_BODY\n\n[exit code: 7]\n\n<system-reminder>\nRepeated call notice\n</system-reminder>", 7);
        case "reminder-timeout": return { content: [...text("TIMEOUT_BODY\n\n[command timed out]\n[exit code: 124]"),
          ...text("<system-reminder>\nCompleted task\n</system-reminder>\n<system-reminder>\nStill running task\n</system-reminder>\n<system-reminder>\nPattern matched\n</system-reminder>")], details: { exit_code: 124 } };
        case "reminder-long": return result("<system-reminder>\n" + Array.from({ length: 11 }, (_, i) => `NOTICE_ROW_${String(i + 1).padStart(2, '0')}`).join('\n') + "\n</system-reminder>", 0);
        case "reminder-cap": return result("CAPPED_BODY\n\n[exit code: 7]\nshown 10 of 20 lines (cap)\n\n<system-reminder>\nOther task failed\n</system-reminder>", 7);
        case "timeout-stream": {
          const value = row(9) + "\n\n[command timed out]\n[exit code: 124]";
          onUpdate?.(result(value, 124));
          record({ type: "shape_timeout_gate" });
          await gate("shape-timeout-final", signal);
          return result(value, 124);
        }
        case "exception-stream": {
          const value = row(9) + "\n\n[exit code: 7]";
          onUpdate?.(result(value, 7));
          record({ type: "shape_exception_gate", stage: 1 });
          await gate("shape-exception-final", signal);
          return result(value, 7);
        }
        case "stream":
          onUpdate?.(result("OLD_PARTIAL\n" + row(11), 7, true));
          record({ type: "shape_gate", stage: 1 });
          await gate("shape-next", signal);
          onUpdate?.(result("REPLACEMENT_PARTIAL", -2, true));
          record({ type: "shape_gate", stage: 2 });
          await gate("shape-final", signal);
          return result("FINAL_ONLY", 7, true);
        default: return result("SHAPE_OK");
      }
    },
  });
  const bashReal: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "bash", arguments: { command: "cat <<'TIDY_UI_EOF'\n  HEREDOC_INDENT\nHEREDOC_END\nTIDY_UI_EOF\nprintf 'AFTER_HEREDOC\\n'" } },
    { name: "bash", arguments: { command: "printf '%s\\n' '" + "LONG_WORD".repeat(30) + "'" } },
    { name: "bash", arguments: { command: "for i in $(seq 1 11); do printf 'REAL_ROW_%02d\\n' \"$i\"; done" } },
    { name: "bash", arguments: { command: "printf 'REAL_ERROR\\n'; exit 7" } },
  ];
  // Real built-in execution. Python input/output are relative to the owned test workspace.
  const bashWidth: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "bash", arguments: { command: "printf '" + "LONGWORD".repeat(30) + "'" } },
    { name: "bash", arguments: { command: "python3 -c \"from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('neon-blocks-check.js').write_text(m.group(1))\" && node --check neon-blocks-check.js" } },
  ];
  // Explicit cache-only provider scenario; every shell call still uses the real built-in tool.
  const cacheSuite: Pick<ToolCall, "name" | "arguments">[] = [
    ...Array.from({ length: 8 }, (_, index) => ({ name: "bash", arguments: {
      command: `for i in $(seq 1 1000); do printf 'CACHE_OUTPUT_${index}_%04d_ASCII_PAYLOAD\\n' "$i"; done`,
    } })),
    { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "tidy_ui_hidden", arguments: {} },
  ];
  const shapeCases = ["literal", "whitespace", "ten", "eleven", "soft", "edges", "exit", "both", "zero-error", "unknown-error", "zero", "string", "null", "transient"];
  const bashShapes: Pick<ToolCall, "name" | "arguments">[] = shapeCases.map((fixtureCase, index) => ({
    name: "bash", arguments: { command: "shape " + fixtureCase, fixtureCase,
      ...(index === 0 ? { description: "Representative task description", workdir: "../other/./dir" } : {}),
      ...(index === 1 ? { workdir: "." } : {}),
      ...(index === 2 ? { workdir: process.cwd() } : {}),
    },
  }));
  const exceptionCases = ["suffix-match", "suffix-mismatch", "suffix-no-gap", "suffix-combined", "suffix-error-only",
    "suffix-error-mismatch", "suffix-success", "suffix-unknown", "suffix-string", "suffix-indent", "suffix-spaces",
    "suffix-fragment", "suffix-nonterminal", "suffix-double", "preview-one-blank", "preview-two-blanks", "preview-interior", "preview-empty", "suffix-deep", "suffix-only"];
  const bashExceptions: Pick<ToolCall, "name" | "arguments">[] = exceptionCases.map((fixtureCase) => ({
    name: "bash", arguments: { command: "shape " + fixtureCase, fixtureCase },
  }));
  const timeoutCases = ["timeout-match", "timeout-both", "timeout-only", "timeout-no-gap", "timeout-mismatch",
    "timeout-string", "timeout-unknown", "timeout-code-only", "timeout-interior", "timeout-preview", "timeout-deep", "timeout-indent"];
  const bashTimeouts: Pick<ToolCall, "name" | "arguments">[] = timeoutCases.map((fixtureCase) => ({
    name: "bash", arguments: { command: "shape " + fixtureCase, fixtureCase },
  }));
  pi.registerTool({
    name: "tidy_ui_unknown", label: "Unknown fixture label", description: "Offline unknown text-only tool",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: `UNKNOWN_RESULT ${args.query}` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "tidy_ui_stream", label: "Streaming fixture", description: "Offline gated streaming tool",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, _args, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "STREAM_PARTIAL" }], details: undefined });
      record({ type: "tool_gate" });
      await gate("tool-go", signal);
      return { content: [{ type: "text", text: "STREAM_COMPLETE" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "tidy_ui_hidden", label: "Hidden fixture", description: "Intentionally empty native renderer",
    parameters: Type.Object({}), renderShell: "self",
    renderCall: () => new Text("", 0, 0), renderResult: () => new Text("", 0, 0),
    async execute() {
      return { content: [{ type: "text", text: "HIDDEN_RESULT" }], details: undefined };
    },
  });
  // All credentials and payloads below are synthetic sentinels, not host data.
  const longReadPath = "long-directory/" + "r".repeat(180) + ".txt";
  pi.registerTool({
    name: "tidy_ui_summary", label: "Summary fixture", description: "Offline arbitrary JSON summary fixture",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(_id, args) {
      if ("fixtureError" in args && args.fixtureError === true) throw new Error("ERROR_BODY_SENTINEL first line\nERROR_STACK_SENTINEL second line");
      return { content: [{ type: "text", text: "SUMMARY_RESULT " + JSON.stringify(args) }],
        details: { supplied: args } };
    },
  });
  pi.registerTool({
    name: "tidy_ui_noargs", label: "No arguments fixture", description: "Offline no-arguments tool",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "NOARGS_RESULT" }], details: undefined }; },
  });
  pi.registerTool({
    name: "tidy_ui_card", label: "Self-shell card fixture", description: "Native self-shell renderer without padding",
    parameters: Type.Object({}), renderShell: "self",
    renderCall: (_args, theme) => new Text(theme.bg("toolSuccessBg", "NATIVE_CARD_CALL"), 0, 0),
    renderResult: (_result, _options, theme) => new Text(theme.bg("toolSuccessBg", "NATIVE_CARD_RESULT"), 0, 0),
    async execute() { return { content: [{ type: "text", text: "NATIVE_CARD_RESULT" }], details: undefined }; },
  });
  const multiline: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "a.txt" } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "read", arguments: { path: longReadPath, offset: 1, limit: 1 } },
    { name: "tidy_ui_hidden", arguments: {} },
    { name: "tidy_ui_noargs", arguments: {} },
    { name: "tidy_ui_noargs", arguments: {} },
    { name: "tidy_ui_summary", arguments: {
      zLast: "LAST_FIELD_VISIBLE", "odd key": "QUOTED_KEY", enabled: false, count: 0,
      empty: "", nothing: null, nested: { input: "NESTED_PAYLOAD_VISIBLE", token: "NESTED_TOKEN_VISIBLE", values: [false, 0, "nested quoted value"], clean: "clean\n \t nested\u202evalue" },
      sanitized: "white\n \tspace \u001b[31mred\u001b[0m\u202eend",
      token: "TOP_TOKEN_HIDDEN", password: "TOP_PASSWORD_HIDDEN", passwd: "TOP_PASSWD_HIDDEN", api_key: "TOP_API_KEY_HIDDEN",
      apiKey: "TOP_APIKEY_HIDDEN", authorization: "TOP_AUTHORIZATION_HIDDEN", Authorization: "TOP_AUTH_HIDDEN",
      access_token: "TOP_ACCESS_HIDDEN", refresh_token: "TOP_REFRESH_HIDDEN", secret: "TOP_SECRET_HIDDEN",
      content: "PAYLOAD_CONTENT_HIDDEN", edits: ["PAYLOAD_EDITS_HIDDEN"], code: "PAYLOAD_CODE_HIDDEN", input: "PAYLOAD_INPUT_HIDDEN",
      messages: ["PAYLOAD_MESSAGES_HIDDEN"], prompt: "PAYLOAD_PROMPT_HIDDEN", newString: "PAYLOAD_NEWSTRING_HIDDEN", oldString: "PAYLOAD_OLDSTRING_HIDDEN",
      appendContent: "PAYLOAD_APPEND_HIDDEN", rewrite: "PAYLOAD_REWRITE_HIDDEN", oldText: "PAYLOAD_OLDTEXT_HIDDEN", newText: "PAYLOAD_NEWTEXT_HIDDEN",
      maxTokens: 0, Content: "CASE_SENSITIVE_PAYLOAD_VISIBLE", Token: "CASE_SENSITIVE_TOKEN_VISIBLE",
      endLine: 0, startLine: 0, limit: 0, offset: 0, subject: "subject", command: "command", symbols: ["one", "two"], symbol: "symbol",
      action: "inspect", op: "trace", queries: ["first", "second"],
      query: "quoted \"query\"\\value 界 é " + "UNBREAKABLE".repeat(30) + " END_QUERY_VISIBLE",
      AFirst: "FIRST_ALPHA_VISIBLE",
    } },
    { name: "tidy_ui_hidden", arguments: {} },
    { name: "tidy_ui_card", arguments: {} },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "tidy_ui_summary", arguments: {
      paths: ["ordinary-path"], scope: "ordinary-scope", url: "https://example.invalid/ordinary", target: "ordinary-target",
      pattern: "needle \"quoted\"", path: ["src dir", "tests"], query: "always named", enabled: true,
    } },
    { name: "bash", arguments: { command: "printf 'MULTILINE_NATIVE_BASH\\n'" } },
    { name: "tidy_ui_summary", arguments: { pattern: 0, path: null, target: "chosen target", url: "ordinary-url", scope: "ordinary-scope", paths: ["ordinary-path"], query: "named" } },
    { name: "tidy_ui_summary", arguments: { path: "chosen-path", target: "ordinary-target", url: "ordinary-url", scope: "ordinary-scope", paths: ["ordinary-path"] } },
    { name: "tidy_ui_summary", arguments: { url: "https://example.invalid/chosen", scope: "ordinary-scope", paths: [], pattern: false } },
    { name: "tidy_ui_summary", arguments: { scope: [], paths: ["ordinary-path"] } },
    { name: "tidy_ui_summary", arguments: { paths: [] } },
    { name: "tidy_ui_summary", arguments: { pattern: "", path: [], query: "" } },
    { name: "tidy_ui_noargs", arguments: {} },
  ];
  const commaWrap: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "tidy_ui_summary", arguments: { scope: [
      "experiments/gruvbox-dark-hard/semantic-implementation-review.md",
      "experiments/gruvbox-dark-hard/semantic-implementation.md",
      "experiments/gruvbox-dark-hard/semantic-analysis.md",
    ] } },
    { name: "tidy_ui_summary", arguments: { target: [
      "agent/npm/node_modules/pi-subagents/src/runs/shared/single-output.js",
      "agent/npm/node_modules/pi-subagents/src/shared/artifacts.js",
      "agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js",
    ] } },
    { name: "tidy_ui_summary", arguments: { drop: Array.from({ length: 60 }, (_, i) => i + 1).join(",") } },
  ];
  const longWordWrap: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: longReadPath } },
    { name: "read", arguments: { path: longReadPath, offset: 1, limit: 1 } },
    { name: "tidy_ui_summary", arguments: { url: "https://example.invalid/" + "segment.with-dashes_".repeat(6) + "?key=" + "v".repeat(24), fixtureError: true } },
    { name: "tidy_ui_summary", arguments: { query: "\u0301" + "q".repeat(12) + '"' + "r".repeat(75), target: "é界/".repeat(12), offset: 1, limit: 1 } },
  ];
  const boundedSummaries: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "tidy_ui_summary", arguments: { op: "inspect", action: "preview", command: "echo", query: "STRING_BEGIN_" + "x".repeat(1000),
      paths: ["src"], symbol: "render", limit: 0, wait: false, mystery: "UNKNOWN", api_key: "COMPACT_SECRET_NEVER_VISIBLE",
      content: "CONTENT_VISIBLE", edits: [{ oldText: "OLD_VISIBLE", newText: "NEW_VISIBLE" }] } },
    { name: "tidy_ui_summary", arguments: { content: "界é".repeat(300), newText: "ONE_REPLACEMENT" } },
    { name: "tidy_ui_summary", arguments: { query: Array(100).fill("ARRAY_ENTRY") } },
    { name: "tidy_ui_summary", arguments: { query: { list: Array(100).fill("OBJECT_ENTRY"), tail: "OBJECT_TAIL" }, unknownTail: "DISPLAY_TAIL" } },
    { name: "tidy_ui_summary", arguments: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${String(i).padStart(2, "0")}`, "v".repeat(180)])) },
    { name: "edit", arguments: { path: "missing-bounded.ts", pattern: "EDIT_PATTERN_IGNORED", query: "EDIT_QUERY_IGNORED",
      oldText: "OLD_PROPOSAL_IGNORED".repeat(100), newText: "NEW_PROPOSAL_IGNORED".repeat(100) } },
    { name: "write", arguments: { path: "bounded-write.txt", content: "WRITE_BODY_" + "w".repeat(1000) } },
  ];
  const compactErrors: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "missing/" + "r".repeat(90) + ".txt", offset: 3, limit: 7 } },
    { name: "tidy_ui_summary", arguments: { pattern: "needle", path: "src/文件/" + "p".repeat(40), query: "a,b,c,".repeat(8), fixtureError: true } },
    { name: "tidy_ui_summary", arguments: { target: ["src/" + "t".repeat(50), "tests/文件/" + "u".repeat(40)], query: "named", fixtureError: true } },
    { name: "tidy_ui_summary", arguments: { query: "SUCCESS_CALL" } },
  ];
  const editSuite: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "edit", arguments: { path: "edit-example.ts", edits: [
      { oldText: "export const before = 10;", newText: "export const after = 20;\nconst inserted = 30;" },
      { oldText: 'const context7 = 7;', newText: 'const rewritten = 70;' },
      { oldText: 'const label = "old";', newText: 'const label = "new";' },
      { oldText: 'const multiline = `first', newText: 'const multiline = `changed' },
    ] } },
    { name: "edit", arguments: { path: "edit-long.ts", oldText: 'const before = "' + "before 界é ".repeat(14) + '";',
      newText: 'const after = "' + "after 界é ".repeat(22) + '";' } },
    { name: "edit", arguments: { path: "edit-example.ts", oldText: "NONEXISTENT_EDIT", newText: "FAILURE_PROPOSAL" } },
    { name: "edit", arguments: { path: "missing-edit.ts", oldText: "before", newText: "after" } },
    { name: "edit", arguments: { path: "index.html",
      oldText: '  <style>\n    :root { --bg: #0b1020; }\n    body { background: radial-gradient(ellipse at 50% 8%, #202b52 0, #10172c 38%, var(--bg) 75%); }\n    .app { width: min(100%, 760px); }\n  </style>\n</head>',
       newText: '  <link rel="stylesheet" href="styles.css">' } },
    { name: "edit", arguments: { path: "edit-direction.ts", oldText: "const retained = 1;\n", newText: "const retained = 1;\nconst addOnly = 4;\n" } },
    { name: "edit", arguments: { path: "edit-direction.ts", oldText: "const removeOnly = 2;\n", newText: "" } },
  ];
  // Keep full long-line rendering coverage without stress-testing Pi's word-diff algorithm.
  const editPerformanceSuite: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "edit", arguments: { path: "edit-minified.ts", oldText: "x+=1;".repeat(3200), newText: "x+=1;".repeat(3199) + "x+=2;" } },
    { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } },
  ];
  const suite: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "bash", arguments: { command: "printf 'BASH_RESULT\\n'" } },
    { name: "write", arguments: { path: "written.txt", content: "WRITE_BEFORE\n" } },
    { name: "edit", arguments: { path: "written.txt", oldText: "WRITE_BEFORE", newText: "WRITE_AFTER" } },
    { name: "tidy_ui_unknown", arguments: { query: "wide 界 é query" } },
    { name: "read", arguments: { path: "missing.txt" } },
  ];
  pi.registerProvider("tidy-ui-offline", {
    api: "tidy-ui-offline", baseUrl: "http://127.0.0.1/unused", apiKey: "offline-fixture",
    models: [{ id: "scripted", name: "Offline terminal fixture", reasoning: false,
      // The opt-in eight-output cache scenario must not trigger unrelated automatic compaction.
      input: ["text", "image"], contextWindow: process.env.TIDY_UI_TEST_FOOTER === "1" ? 272000 : process.env.TIDY_UI_TEST_CACHE_DIAGNOSTICS === "1" ? 512000 : 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: process.env.TIDY_UI_TEST_FOOTER === "1" ? { input: 1000, output: 100, cacheRead: 9500, cacheWrite: 500, totalTokens: 11100,
          cost: { input: 0.123, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 } } :
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        if (queuedDiagnostics) {
          const request = ++queuedRequests;
          record({ type: "queued_context", request, messages: context.messages });
          stream.push({ type: "start", partial: message });
          if (request === 1) { record({ type: "queued_gate" }); await gate("queued-release", options?.signal, 180000); }
          const text = `QUEUED_RESPONSE_${request}`;
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          stream.push({ type: "done", reason: "stop", message }); stream.end(); return;
        }
        const last = context.messages.findLastIndex((m) => m.role === "user");
        const user: any = context.messages[last];
        const prompt = typeof user?.content === "string" ? user.content :
          user?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const scenario = prompt === 'run follow-pi-palette' ? 'follow-pi-palette' : prompt === 'run bash-empty-stream' ? 'bash-empty-stream' : /^run highlighting-limits-(bash|write|edit)$/.test(prompt ?? "") ? prompt.slice(4) : prompt === "run syntax-long-output" ? "syntax-long-output" : prompt === "run bash-prefix-contract" ? "bash-prefix-contract" : prompt === "run syntax-cards" ? "syntax-cards" : prompt?.includes("run write-stock") ? "write-stock" : prompt?.includes("run write-shapes") ? "write-shapes" : prompt?.includes("run edit-performance") ? "edit-performance" : prompt?.includes("run edit-cards") ? "edit-cards" : prompt?.includes("run user-card") ? "user-card" : prompt === "run cache-performance" ? "cache-performance" : prompt?.includes("bash-width") ? "bash-width" : prompt?.includes("bash-stream") ? "bash-stream" : prompt?.includes("bash-real") ? "bash-real" :
          prompt?.includes("bash-shape-timeout-stream") ? "bash-shape-timeout-stream" : prompt?.includes("bash-shape-timeouts") ? "bash-shape-timeouts" :
          prompt?.includes("bash-shape-exception-stream") ? "bash-shape-exception-stream" : prompt?.includes("bash-shape-exceptions") ? "bash-shape-exceptions" :
          prompt?.includes('bash-shape-tasks') ? 'bash-shape-tasks' : prompt?.includes("bash-shape-reminders") ? "bash-shape-reminders" : prompt?.includes("bash-shape-stream") ? "bash-shape-stream" : prompt?.includes("bash-shapes") ? "bash-shapes" :
          prompt?.includes("long-word-wrap") ? "long-word-wrap" : prompt?.includes("bounded-summaries") ? "bounded-summaries" : prompt?.includes("compact-errors") ? "compact-errors" : prompt?.includes("comma-wrap") ? "comma-wrap" : prompt?.includes("boundary") ? "boundary" : prompt?.includes("multiline") ? "multiline" : prompt?.includes("integration") ? "integration" :
          prompt?.includes("pending") ? "pending" : prompt?.includes("fallback") ? "fallback" :
          prompt === "run footer-cold" ? "footer-cold" : prompt === "run footer-history" ? "footer-history" : prompt === "run footer-varied" ? "footer-varied" :
          prompt?.includes("future") ? "future" : "suite";
        const results = context.messages.slice(last + 1).filter((m) => m.role === "toolResult");
        record({ type: "model_context", ...(userDiagnostics ? { user: prompt } : {}), results: results.map((m: any) => ({
          name: m.toolName, content: m.content, isError: m.isError, details: m.details,
        })) });
        if (scenario.startsWith("bash-shape") && !bashShape) throw new Error("bash-shape scenario requires explicit isolated opt-in");
        if (["cache-performance", "bash-width", "bash-real", "bash-stream", "suite", "multiline"].includes(scenario) && bashShape) throw new Error("Built-in scenario cannot run with bash-shape opt-in");
        if (scenario === "write-shapes" && !writeShape) throw new Error("write-shapes requires explicit isolated opt-in");
        if (writeShape && scenario !== "write-shapes") throw new Error("write-shape opt-in is isolated from all other scenarios");
        if (scenario.startsWith("footer-") && process.env.TIDY_UI_TEST_FOOTER_HISTORY !== "1") throw new Error("footer-history requests require explicit isolated opt-in");
        const volume = scenario.startsWith("highlighting-limits-") ? JSON.parse(readFileSync(join(output, 'highlighting-limits.json'), 'utf8')) as { calls: Pick<ToolCall, "name" | "arguments">[]; prefixes?: string[] } : undefined;
        const calls: Pick<ToolCall, "name" | "arguments">[] = volume ? volume.calls : scenario === 'follow-pi-palette' ? [
          { name: 'bash', arguments: { command: "printf '%s\\n' 'FOLLOW_PI_BASH'" } },
          { name: 'write', arguments: { path: 'follow-pi.md', content: followPiText } },
          { name: 'edit', arguments: { path: 'follow-pi.md', oldText: followPiText, newText: followPiText.replace('gone', 'fixed') } },
        ] : scenario === "syntax-long-output" ? [
          { name: "bash", arguments: { command: "printf 'STABLE_text '; printf 'o%.0s' {1..2000}; printf '\\n\\n<system-reminder>\\nSTABLE_text '; printf 'r%.0s' {1..2000}; printf '\\n</system-reminder>\\n'" } },
        ] : scenario === "bash-prefix-contract" ? [
          { name: "bash", arguments: { command: ": 'STABLE_text é界 tail'" } },
        ] : scenario === "syntax-cards" ? [
          { name: "bash", arguments: { command: "printf 'SYNTAX_OUTPUT\\n'\ntouch \"$TIDY_UI_TEST_OUTPUT/syntax-shell-ready\"\nwhile [ ! -f \"$TIDY_UI_TEST_OUTPUT/syntax-shell-final\" ]; do sleep 0.025; done" } },
          { name: "write", arguments: { path: "syntax.ts", content: "const x=1;\n" } },
          { name: "edit", arguments: { path: "syntax.ts", oldText: "const x=1;", newText: "const x=2;" } },
        ] : scenario === "footer-cold" ? [] : scenario === "footer-history" || scenario === "footer-varied" ?
          Array.from({ length: scenario === "footer-history" ? 19 : 11 }, () => ({ name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } })) : scenario === "write-stock" ? writeStockSuite : scenario === "write-shapes" ? writeShapeSuite : scenario === "edit-performance" ? editPerformanceSuite : scenario === "edit-cards" ? editSuite : scenario === "user-card" ? [
          { name: "bash", arguments: { command: "printf 'USER_BASH_OUTPUT\\n'" } },
          { name: "read", arguments: { path: "a.txt" } },
        ] : scenario === "cache-performance" ? cacheSuite : scenario === "bash-width" ? bashWidth : scenario === "bash-real" ? bashReal : scenario === "bash-shapes" ? bashShapes :
          scenario === 'bash-shape-tasks' ? ['task-empty', 'task-exit', 'task-timeout', 'task-cap'].map(fixtureCase => ({ name: 'bash', arguments: { command: 'shape ' + fixtureCase, fixtureCase } })) :
          scenario === "bash-shape-reminders" ? ['reminder-inline', 'reminder-timeout', 'reminder-long', 'reminder-cap'].map(fixtureCase => ({ name: 'bash', arguments: { command: 'shape ' + fixtureCase, fixtureCase } })) :
          scenario === "bash-shape-timeouts" ? bashTimeouts :
          scenario === "bash-shape-timeout-stream" ? [{ name: "bash", arguments: { command: "shape timeout-stream", fixtureCase: "timeout-stream" } }] :
          scenario === "bash-shape-exceptions" ? bashExceptions :
          scenario === "bash-shape-exception-stream" ? [{ name: "bash", arguments: { command: "shape exception-stream", fixtureCase: "exception-stream" } }] :
          scenario === "bash-shape-stream" ? [{ name: "bash", arguments: { command: "shape stream", description: "Streaming comment", fixtureCase: "stream" } }] :
          scenario === 'bash-empty-stream' ? [{ name: 'bash', arguments: { command: "printf 'EMPTY_BASH_READY\\n'" } }] :
          scenario === "bash-stream" ? [{ name: "bash", arguments: { command:
            "for i in $(seq 1 12); do printf 'LIVE_ROW_%02d\\n' \"$i\"; done\n" +
            "touch \"$TIDY_UI_TEST_OUTPUT/shell-ready\"\n" +
            "while [ ! -f \"$TIDY_UI_TEST_OUTPUT/shell-final\" ]; do sleep 0.025; done\n" +
            "printf 'LIVE_FINAL\\n'" } }] : scenario === "boundary" ? [
          { name: "read", arguments: { path: "abcdefghijklm", limit: 1 } },
          { name: "tidy_ui_summary", arguments: { path: "abcdefghijklm", query: "x".repeat(40) } },
        ] : scenario === "long-word-wrap" ? longWordWrap : scenario === "bounded-summaries" ? boundedSummaries : scenario === "compact-errors" ? compactErrors : scenario === "comma-wrap" ? commaWrap : scenario === "multiline" ? multiline : scenario === "integration" ? [
          { name: "TaskCreate", arguments: { subject: "TERMINAL_LOCAL_TASK", description: "Offline installed renderer smoke; do not execute." } },
          { name: "TaskList", arguments: {} },
        ] : scenario === "pending" ? [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "tidy_ui_stream", arguments: { query: "gated" } },
        ] : scenario === "fallback" ? [
          { name: "read", arguments: { path: "pixel.png" } },
          { name: "tidy_ui_hidden", arguments: {} },
        ] : scenario === "future" ? [
          { name: "tidy_ui_unknown", arguments: { query: "future after reload" } },
        ] : suite;
        const step = results.length;
        if (scenario === "syntax-cards" && step === 2 && process.env.TIDY_UI_TEST_SYNTAX_REPLY_GATE === "1") {
          record({ type: "syntax_reply_tool_gate" }); await gate("syntax-reply-tool-go", options?.signal);
        }
        if (scenario.startsWith("footer-")) {
          const rate = scenario === "footer-cold" ? 0 : scenario === "footer-history" ? 10 :
            [100, 85.7, 71.4, 57.1, 42.9, 28.6, 14.3, 0, 79.96, 94.96, 100, undefined][step];
          const cacheRead = rate === undefined ? 0 : Math.round(rate * 100);
          const input = rate === undefined ? 0 : 10000 - cacheRead;
          message.usage = { input, output: 100, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        }
        stream.push({ type: "start", partial: message });
        if (step < calls.length) {
          const call = { type: "toolCall" as const, id: `terminal-${last}-${step}`, ...calls[step] };
          message.content.push({ ...call, arguments: {} });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          await wait(60);
          if (scenario === 'bash-empty-stream' && step === 0) {
            for (const [phase, prefix] of ['', 'printf', String(call.arguments.command)].entries()) {
              message.content[0] = { ...call, arguments: { command: prefix } };
              stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify({ command: prefix }), partial: message });
              record({ type: 'bash_empty_prefix', phase, bytes: Buffer.byteLength(prefix) });
              await gate(`bash-empty-go-${phase}`, options?.signal);
            }
          } else if (volume?.prefixes && step === 0) {
            for (const [phase, prefix] of volume.prefixes.entries()) {
              message.content[0] = { ...call, arguments: { command: prefix } };
              stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ command: prefix }), partial: message });
              record({ type: "highlighting_limits_prefix", phase, bytes: Buffer.byteLength(prefix) });
              await gate(`highlighting-limits-go-${phase}`, options?.signal, 120000);
            }
          } else if (scenario === "bash-prefix-contract" && step === 0) {
            const prefixes = [": 'STABLE_text e", ": 'STABLE_text é界", String(call.arguments.command)];
            for (const [phase, prefix] of prefixes.entries()) {
              message.content[0] = { ...call, arguments: { command: prefix } };
              stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ command: prefix }), partial: message });
              record({ type: "bash_contract_prefix", phase, bytes: Buffer.byteLength(prefix) });
              await gate(`bash-contract-go-${phase}`, options?.signal);
            }
          } else if (scenario === "syntax-cards" && step === 0) {
            const command = String(call.arguments.command), first = command.indexOf("\n") + 1, second = command.indexOf("\n", first) + 1;
            const prefixes = [command.slice(0, 1), command.slice(0, first), command.slice(0, first + 1),
              command.slice(0, second) + "wihle [", command.slice(0, second) + "while ["];
            for (const [phase, prefix] of prefixes.entries()) {
              message.content[0] = { ...call, arguments: { command: prefix } };
              stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ command: prefix }), partial: message });
              record({ type: "syntax_prefix", phase, bytes: Buffer.byteLength(prefix) });
              await gate(`syntax-prefix-go-${phase}`, options?.signal);
            }
          }
          message.content[0] = call;
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          if ((scenario === "pending" || scenario === "bash-stream" || scenario === "syntax-cards" || scenario === "edit-cards" || (writeDiagnostics && scenario.startsWith("write-"))) && step === 0) {
            record({ type: "provider_gate" });
            await gate("provider-go", options?.signal);
          }
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          const text = `TERMINAL_DONE_${scenario}`;
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      })().catch((error) => {
        record({ type: "provider_error", error: String(error) });
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = String(error);
        stream.push({ type: "error", reason: message.stopReason, error: message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    process.stdout.off("resize", observeTerminalSize);
    process.stdout.on("resize", observeTerminalSize);
    observeTerminalSize();
    ctx.ui.setWidget("terminal-driver", (liveTui) => {
      tui = liveTui;
      if (process.env.TIDY_UI_TEST_MENU_GEOMETRY === '1') { stopMenuGeometry?.(); stopMenuGeometry = observeMenuGeometry(liveTui, record); }
      if (spinnerDiagnostics) {
        nativeRequest = tui.requestRender;
        tui.requestRender = () => { if (insideSpinnerTick) spinnerStats.requests++; nativeRequest!(); };
      }
      record({ type: "start", sharedContainer: liveTui instanceof Container });
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("terminal-driver", undefined);
  });
  let editExecutionGated = false, writeExecutionGated = false;
  pi.on("tool_call", async (event) => {
    record({ type: "call", name: event.toolName, input: event.input });
    // Await after native execution-start, without replacing the actual built-in edit implementation.
    if (!editExecutionGated && process.env.TIDY_UI_TEST_EDIT_CARDS === "1" && event.toolName === "edit" &&
      event.input.path === "edit-example.ts" && Array.isArray(event.input.edits)) {
      editExecutionGated = true;
      record({ type: "edit_execution_gate" });
      await gate("edit-execution-go");
    }
    if (!writeExecutionGated && writeDiagnostics && !writeShape && event.toolName === "write" && event.input.path === "write-stock.ts") {
      writeExecutionGated = true; record({ type: "write_execution_gate" }); await gate("write-execution-go");
    }
    // Installed-profile requests are restricted to the two audited, real local task tools.
    if (process.env.TIDY_UI_TEST_PROFILE === "installed" && !["TaskCreate", "TaskList"].includes(event.toolName)) {
      record({ type: "unsafe_call_blocked", name: event.toolName });
      return { block: true, reason: "Installed-profile fixture only executes local TaskCreate/TaskList" };
    }
  });
  pi.on("tool_result", (event) => record({ type: "result", name: event.toolName,
    content: event.content, details: event.details, isError: event.isError }));
  pi.on("tool_execution_update", (event) => record({ type: "execution_update", name: event.toolName, partialResult: event.partialResult }));
  pi.on("agent_end", () => record({ type: "agent_end" }));
  pi.registerCommand("tidy-ui-theme", {
    description: "Set a built-in theme for this isolated terminal",
    handler: async (name, ctx) => {
      const result = ctx.ui.setTheme(name);
      record({ type: "theme", name, result });
      ctx.ui.notify(`TERMINAL_THEME ${name}`, "info");
    },
  });
  if (process.env.TIDY_UI_TEST_PALETTE_THEMES === '1') pi.registerCommand('tidy-ui-palette-theme', {
    description: 'Apply an explicit authored theme only in the isolated palette test',
    handler: async (name, ctx) => {
      const { followPiTheme } = await import('./follow-pi-themes.ts');
      const { getTerminalColorMode } = await import('@earendil-works/pi-tui');
      const result = ctx.ui.setTheme(followPiTheme(name, getTerminalColorMode(), ctx.ui.theme));
      record({ type: 'palette_theme', name, mode: getTerminalColorMode(), result });
      ctx.ui.notify(`TERMINAL_PALETTE_THEME ${name}`, 'info');
    },
  });
  // Native component update probe is opt-in, UI-only and never mutates model/session objects.
  if (process.env.TIDY_UI_TEST_CACHE_DIAGNOSTICS === "1") {
    const replacements = new Map<string, { node: any; original: any; replacement: any }>();
    let detached: { parent: Container; node: ToolExecutionComponent; index: number } | undefined;
    function restoreDetached() {
      if (!detached) return;
      const { parent, node, index } = detached;
      parent.addChild(node);
      // Public child order is restored exactly; the adapter repairs its recorded index on normal render.
      parent.children.splice(parent.children.indexOf(node), 1); parent.children.splice(index, 0, node);
      detached = undefined;
    }
    pi.registerCommand("tidy-ui-cache-detach", {
      description: "Isolated ownership regression: remove/restore a real native tool while retaining the removed owner",
      handler: async (args, ctx) => {
        const [id, operation, extra] = args.trim().split(/\s+/u);
        if (!id || extra || !["remove", "restore"].includes(operation)) throw new Error("Invalid cache detach probe");
        if (operation === "remove") {
          if (detached) throw new Error("Restore the removed component first");
          function find(parent: Container): typeof detached {
            for (const [index, child] of parent.children.entries()) {
              if (child instanceof ToolExecutionComponent && Reflect.get(child, "toolCallId") === id)
                return { parent, node: child, index };
              if (child instanceof Container) { const found = find(child); if (found) return found; }
            }
          }
          detached = find(tui);
          if (!detached) throw new Error("Detach probe requires a real attached tool");
          detached.parent.removeChild(detached.node);
        } else {
          if (!detached || Reflect.get(detached.node, "toolCallId") !== id) throw new Error("No matching removed component");
          restoreDetached();
        }
        tui.requestRender(); ctx.ui.notify(`TERMINAL_CACHE_DETACH ${id} ${operation}`, "info");
      },
    });
    pi.registerCommand("tidy-ui-cache-update", {
      description: "Isolated cache regression: update one native result, reuse it, or restore it",
      handler: async (args, ctx) => {
        const [id, operation, extra] = args.trim().split(/\s+/u);
        if (!id || extra || !["replace", "reuse", "restore"].includes(operation)) throw new Error("Invalid cache update probe");
        if (operation === "replace") {
          if (replacements.has(id)) throw new Error("Restore the previous cache probe first");
          const nodes: any[] = [];
          const visit = (node: any) => {
            if (!node || nodes.includes(node)) return;
            nodes.push(node);
            for (const child of node.children ?? []) visit(child);
          };
          visit(tui);
          const node = nodes.find((item) => item.toolCallId === id && item.toolName === "bash" && typeof item.updateResult === "function");
          if (!node?.result || node.isPartial) throw new Error("Cache probe requires a completed real bash component");
          const replacement = structuredClone(node.result);
          replacement.content = [{ type: "text", text: "CACHE_UPDATE_REPLACED\n" }];
          replacements.set(id, { node, original: node.result, replacement });
          node.updateResult(replacement, false);
        } else {
          const saved = replacements.get(id);
          if (!saved) throw new Error("No cache probe to reuse/restore");
          if (operation === "reuse") {
            saved.replacement.content[0].text = "CACHE_UPDATE_REUSED\n";
            saved.node.updateResult(saved.replacement, false);
          } else {
            saved.node.updateResult(saved.original, false);
            replacements.delete(id);
          }
        }
        tui.requestRender();
        ctx.ui.notify(`TERMINAL_CACHE_UPDATE ${id} ${operation}`, "info");
      },
    });
    pi.on("session_shutdown", () => {
      for (const { node, original } of replacements.values()) node.updateResult(original, false);
      replacements.clear(); restoreDetached();
    });
  }
  pi.registerCommand("tidy-ui-dump", {
    description: "Inspect the actual live component tree (does not invoke mouse handlers)",
    handler: async (name, ctx) => {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid capture name");
      const nodes: any[] = [];
      const parents = new Map<any, any>();
      function visit(node: any) {
        if (!node || nodes.includes(node)) return;
        nodes.push(node);
        for (const child of node.children ?? []) { parents.set(child, node); visit(child); }
      }
      visit(tui);
      const tools = nodes.filter((node) => typeof node.toolCallId === "string" && typeof node.updateResult === "function");
      const width = process.stdout.columns || 100, outputPad = pi.getSettings().outputPad === 0 ? 0 : 1;
      if (spinnerDiagnostics) for (const node of tools) {
        if (observedSpinnerNodes.has(node)) continue;
        observedSpinnerNodes.add(node); node.render = observedToolRender; node.invalidate = observedToolInvalidate;
      }
      writeFileSync(join(output, `${name}.json`), JSON.stringify({
        session: ctx.sessionManager.getSessionFile(), width, cwd: ctx.cwd, bashShape, writeShape, outputPad,
        editor: nodes.filter(node => Object.getPrototypeOf(node) === CustomEditor.prototype).map(node =>
          ({ width, text: node.getText(), padding: node.getPaddingX(), lines: node.render(width) }))[0],
        ...(spinnerDiagnostics ? { spinnerStats, spinnerWork } : {}),
        ...(editDiagnostics ? { nativeRenderCalls } : {}),
        selectionActive: typeof tui.hasActiveSelection === "function" ? tui.hasActiveSelection() : false,
        frameStyles: {
          border: ctx.ui.theme.fg("borderMuted", "┃"),
          errorBorder: ctx.ui.theme.fg("error", "┃"),
          userBorder: ctx.ui.theme.fg("customMessageLabel", "┃"),
        },
        registrations: pi.getAllTools().map((tool) => tool.name),
        commands: pi.getCommands().map((command) => command.name),
        errorStyle: ctx.ui.theme.fg("error", "TERMINAL_ERROR"),
        summaryStyles: Object.fromEntries((["accent", "dim", "toolTitle", "muted", "toolOutput", "mdCodeBlock", "error", "userMessageText", "syntaxKeyword", "syntaxNumber", "syntaxString", "syntaxComment", "syntaxFunction", "syntaxType", "syntaxVariable", "syntaxOperator", "syntaxPunctuation", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdQuoteBorder", "mdCodeBlockBorder", "mdListBullet", "mdHr", "toolDiffAdded", "toolDiffRemoved"] as const)
          .map((role) => [role, ctx.ui.theme.fg(role, "X")])),
        backgroundStyles: Object.fromEntries((["toolPendingBg", "toolSuccessBg", "toolErrorBg", "userMessageBg"] as const)
          .map((role) => [role, ctx.ui.theme.bg(role, "X")])),
        // Read actual command notifications, not production globals, private hooks or test events.
        cacheDiagnostics: nodes.flatMap((node) => {
          if (typeof node.text !== "string") return [];
          const text = stripVTControlCharacters(node.text);
          const prefix = "pi-tidy-ui cache: ";
          const start = text.indexOf(prefix + "{");
          return start < 0 ? [] : [JSON.parse(text.slice(start + prefix.length))];
        }),
        extensionIssues: nodes.filter((node) => node.constructor.name === "ThemedText")
          .map((node) => node.render(width)).filter((rows: string[]) => rows.some((row) => row.includes("[Extension issues]"))),
        ...(userDiagnostics ? { userWork: { ...userWork, widths: [...userWork.widths] } } : {}),
        users: nodes.filter((node) => node.constructor.name === "UserMessageComponent").map((node) => ({
          text: node.text, outputPad: node.outputPad, lines: node.render(width),
          ...(userDiagnostics && name.startsWith("native-user") ? {
            contentControl: node.render(Math.max(1, width - 2 * outputPad - 3) + 2 * node.outputPad),
          } : {}),
        })),
        tools: tools.map((node) => ({ name: node.toolName, id: node.toolCallId,
          expanded: node.expanded, executionStarted: node.executionStarted, isError: node.result?.isError,
          content: node.result?.content, details: node.result?.details, structuredContent: node.result?.structuredContent,
          args: node.args, partial: node.isPartial, lines: node.render(width),
          ...(process.env.TIDY_UI_TEST_SYNTAX_CARDS === "1" ? { argsComplete: node.getRenderContext().argsComplete } : {}),
          ...(spinnerDiagnostics ? { before: parents.get(node)?.children.slice(Math.max(0, parents.get(node).children.indexOf(node) - 3), parents.get(node).children.indexOf(node))
            .map((previous: any) => ({ kind: previous.constructor.name, name: previous.toolName, lines: previous.render(width).map(stripVTControlCharacters) })) } : {}),
          // Physical/clock-work captures stay at the actual width; zero-width probes can pause and resume source preparation.
          ...(process.env.TIDY_UI_TEST_SYNTAX_CARDS === "1" || name.startsWith("physical-") || name.startsWith("pointer-") || spinnerDiagnostics || editDiagnostics || writeDiagnostics ? {} : { narrowLines: node.render(24),
            tinyLines: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8].map((size) => [size, node.render(size)])) }) })),
        document: parents.get(tools[0])?.render(width),
        branch: ctx.sessionManager.getBranch(),
      }, null, 2));
      ctx.ui.notify(`TERMINAL_CAPTURE ${name}`, "info");
    },
  });
}
