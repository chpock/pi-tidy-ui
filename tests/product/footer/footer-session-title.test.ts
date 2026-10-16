import '../../fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { footerFirstMessage } from "../../../src/footer.ts";

const user = (content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[], id: string): SessionEntry => ({
  type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content, timestamp: 1 },
});
const image = { type: "image" as const, data: "", mimeType: "image/png" };

test("footer session title first message matches actual native resume discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tidy-title-native-"));
  const cases: [SessionEntry[], string][] = [
    [[], "(no messages)"],
    [[user([image], "image")], "(no messages)"],
    [[user("", "empty"), user([image], "image"), user("First text", "first"), user("Later text", "later")], "First text"],
    [[user([{ type: "text", text: "First" }, image, { type: "text", text: "second\nline" }], "blocks")], "First second\nline"],
    [[user("   ", "spaces"), user("Later text", "later")], "   "],
    [[user([{ type: "text", text: "" }, { type: "text", text: "" }], "spaces-from-blocks"), user("Later text", "later")], " "],
    [[user("\x1b[31m界é\tname\u202e\x1b[0m", "controls")], "\x1b[31m界é\tname\u202e\x1b[0m"],
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      const [entries, expected] = cases[i]!;
      writeFileSync(join(directory, `${i}.jsonl`), [JSON.stringify({ type: "session", version: 3, id: String(i), timestamp: "2026-01-01T00:00:00.000Z", cwd: directory }), ...entries.map(entry => JSON.stringify(entry))].join("\n") + "\n");
      const native = (await SessionManager.list(directory, directory)).find(info => info.id === String(i))!;
      assert.ok(native, "actual SDK discovers the fixture");
      assert.equal(native.firstMessage, expected);
      assert.equal(footerFirstMessage(entries) ?? "(no messages)", native.firstMessage);
      assert.equal(native.name, undefined, "default resume labels are not explicit names");
    }
    const entries = [user("First raw branch", "first"), user("Current branch", "second")];
    writeFileSync(join(directory, "branch.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "branch", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory }), ...entries.map(entry => JSON.stringify(entry)), JSON.stringify({ type: "session_info", id: "named", parentId: "second", timestamp: "2026-01-01T00:00:00.000Z", name: "Explicit title" }), JSON.stringify({ type: "session_info", id: "cleared", parentId: "named", timestamp: "2026-01-01T00:00:00.000Z", name: "" })].join("\n") + "\n");
    const native = (await SessionManager.list(directory, directory)).find(info => info.id === "branch")!;
    assert.equal(native.name ?? native.firstMessage, footerFirstMessage(entries) ?? "(no messages)", "clearing native name restores first-message display text");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
