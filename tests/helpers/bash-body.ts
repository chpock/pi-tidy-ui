import { plain, type Tool } from "../fixtures/sdk-contract-support.ts";

// Bash cards are a separate presentation, not a specialization of describeArgs.
export function bashBody(tool: Tool, width = 80): string[] {
  const rows = tool.render(width).map(plain);
  if (rows[0] === "") rows.shift(); // transcript separator, not card padding
  const origin = width >= 6 ? 3 : [0, 0, 1, 2, 2, 2][width];
  const right = width >= 6 ? 2 : [0, 0, 0, 0, 1, 2][width];
  return rows.slice(1, -1).map((row) => row.slice(origin, right ? -right : undefined).trimEnd());
}
