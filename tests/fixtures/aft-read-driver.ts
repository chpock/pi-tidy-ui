import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventRecorder } from "./terminal-output.ts";

const captured = JSON.parse(readFileSync(new URL("./aft-read-result.json", import.meta.url), "utf8"));
const range = Type.Optional(Type.Union([Type.Number(), Type.String()]));
const readParameters = Type.Object({
  path: Type.String(),
  startLine: range,
  endLine: range,
  offset: range,
  limit: range,
});

function lineNumber(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label}`);
  return parsed;
}

export default function aftReadDriver(pi: ExtensionAPI): void {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  const record = createEventRecorder(output);

  pi.registerTool({
    name: "read",
    label: "AFT-shaped read fixture",
    description: "Replays a captured AFT 0.63.5 read result; does not load or execute AFT",
    parameters: readParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `AFT FOREIGN READ ${args.path}`), 0, 0);
    },
    async execute(_id, args) {
      if (args.path !== "aft-saved.md") throw new Error("The AFT read fixture only accepts aft-saved.md");

      // This single fixture-owned filesystem read happens at execution, never in either renderer.
      const source = readFileSync(join(process.cwd(), args.path), "utf8");
      record({ type: "aft_read_fixture_disk_read", path: args.path, input: args });
      const sourceLines = source.split("\n");
      const startLine = lineNumber(args.startLine ?? args.offset, 1, "startLine");
      const defaultEnd = Math.min(sourceLines.length, startLine + lineNumber(args.limit, sourceLines.length, "limit") - 1);
      const endLine = lineNumber(args.endLine, defaultEnd, "endLine");
      if (startLine > sourceLines.length || endLine > sourceLines.length || endLine < startLine)
        throw new Error("The AFT read fixture received an out-of-file line range");

      if (source !== captured.input || startLine !== captured.result.details.start_line || endLine !== captured.result.details.end_line)
        throw new Error("The AFT fixture requires the captured source and range");
      return structuredClone(captured.result);
    },
  });
}
