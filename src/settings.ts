import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SyntaxTheme = { kind: "pi" } | { kind: "occipital"; id: string };
export type SettingsPatch = { syntaxTheme: SyntaxTheme };
export const SETTINGS_FILE_MAX_BYTES = 64 * 1024;
const THEME_ID_MAX_BYTES = 64;
// The supported Node runtime has these APIs; ES2023 project typings do not.
const nativeJSON = JSON as typeof JSON & {
  rawJSON?: (source: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
};
const NUMERIC_PRESERVATION_UNAVAILABLE = Symbol();
const UPDATE_CANCELLED = Symbol();

const ISSUE_MESSAGES = {
  "invalid-json": "Settings contain invalid JSON or UTF-8.",
  "invalid-root": "Settings must contain a JSON object.",
  "numeric-preservation-unavailable": "Settings numbers could not be preserved; the file was kept.",
  "invalid-theme": "Settings contain an invalid syntax theme preference.",
  "too-large": "Settings exceed the file size limit.",
  "read-failed": "Settings could not be read.",
  "invalid-patch": "Settings update contains an invalid preference or field.",
  "write-failed": "Settings could not be saved; the previous file was kept.",
  "cancelled": "Settings update was cancelled; the previous file was kept.",
} as const;

export type SettingsIssue = { code: keyof typeof ISSUE_MESSAGES; message: string };
export type SettingsLoadResult =
  | { ok: true; syntaxTheme: SyntaxTheme }
  | { ok: false; syntaxTheme: SyntaxTheme; issue: SettingsIssue };
export type SettingsSaveResult = { ok: true } | { ok: false; issue: SettingsIssue };
export type SettingsLocation = { agentDir: string; file?: never } | { file: string; agentDir?: never };

type DocumentResult = { ok: true; document: Record<string, unknown> } | { ok: false; issue: SettingsIssue };

function issue(code: SettingsIssue["code"]): SettingsIssue {
  // Never include file contents, caller IDs, paths or platform error strings.
  return { code, message: ISSUE_MESSAGES[code] };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(typeof nativeJSON.isRawJSON === "function" && nativeJSON.isRawJSON(value));
}

function syntaxTheme(value: unknown): SyntaxTheme | undefined {
  if (!object(value) || !Object.hasOwn(value, "kind")) return undefined;
  const keys = Object.keys(value);
  if (value.kind === "pi" && keys.length === 1) return { kind: "pi" };
  if (value.kind === "occipital" && keys.length === 2 && Object.hasOwn(value, "id") &&
    typeof value.id === "string" && value.id.length > 0 && value.id.length <= THEME_ID_MAX_BYTES &&
    Buffer.byteLength(value.id, "utf8") <= THEME_ID_MAX_BYTES && Buffer.from(value.id, "utf8").toString("utf8") === value.id) {
    return { kind: "occipital", id: value.id };
  }
  return undefined;
}

async function readDocument(file: string): Promise<DocumentResult> {
  let handle;
  try {
    try {
      handle = await fs.open(file, "r");
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return { ok: true, document: {} };
      return { ok: false, issue: issue("read-failed") };
    }
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, issue: issue("read-failed") };
    if (stat.size > SETTINGS_FILE_MAX_BYTES) return { ok: false, issue: issue("too-large") };
    // Read at most one byte beyond the limit, even if the file grows after stat.
    const bytes = Buffer.alloc(SETTINGS_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > SETTINGS_FILE_MAX_BYTES) return { ok: false, issue: issue("too-large") };
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)),
        (_key: string, value: unknown, context?: { source?: string }) => {
          if (typeof value !== "number") return value;
          // Keep every numeric token, including overflow, precision and signed zero.
          const source = context?.source;
          if (typeof source !== "string" || typeof nativeJSON.rawJSON !== "function" ||
            typeof nativeJSON.isRawJSON !== "function") throw NUMERIC_PRESERVATION_UNAVAILABLE;
          try {
            const raw = nativeJSON.rawJSON(source);
            if (!nativeJSON.isRawJSON(raw)) throw NUMERIC_PRESERVATION_UNAVAILABLE;
            return raw;
          } catch {
            throw NUMERIC_PRESERVATION_UNAVAILABLE;
          }
        });
    } catch (error) {
      return { ok: false, issue: issue(error === NUMERIC_PRESERVATION_UNAVAILABLE ?
        "numeric-preservation-unavailable" : "invalid-json") };
    }
    if (!object(document)) return { ok: false, issue: issue("invalid-root") };
    if (Object.hasOwn(document, "syntaxTheme") && !syntaxTheme(document.syntaxTheme)) {
      return { ok: false, issue: issue("invalid-theme") };
    }
    return { ok: true, document };
  } catch {
    return { ok: false, issue: issue("read-failed") };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Theme-only settings boundary; live selections belong to the caller, not this store. */
export class ExtensionSettings {
  readonly file: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(location?: SettingsLocation) {
    this.file = location?.file ?? join(location?.agentDir ?? getAgentDir(), "extensions", "pi-tidy-ui", "config.json");
  }

  async load(): Promise<SettingsLoadResult> {
    const result = await readDocument(this.file);
    if (!result.ok) return { ok: false, syntaxTheme: { kind: "pi" }, issue: result.issue };
    return { ok: true, syntaxTheme: Object.hasOwn(result.document, "syntaxTheme") ?
      syntaxTheme(result.document.syntaxTheme)! : { kind: "pi" } };
  }

  update(patch: SettingsPatch, options?: { signal?: AbortSignal }): Promise<SettingsSaveResult> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.resolve({ ok: false, issue: issue("cancelled") });
    // Snapshot before queuing so later caller mutations cannot alter the saved choice.
    const choice = object(patch) && Object.keys(patch).length === 1 && Object.hasOwn(patch, "syntaxTheme") ?
      syntaxTheme(patch.syntaxTheme) : undefined;
    if (!choice) return Promise.resolve({ ok: false, issue: issue("invalid-patch") });
    const operation = this.writes.then(() => this.save(choice, signal));
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  private async save(choice: SyntaxTheme, signal?: AbortSignal): Promise<SettingsSaveResult> {
    if (signal?.aborted) return { ok: false, issue: issue("cancelled") };
    const latest = await readDocument(this.file);
    if (signal?.aborted) return { ok: false, issue: issue("cancelled") };
    if (!latest.ok) return { ok: false, issue: latest.issue };
    let contents: string;
    try {
      // Object spread creates own data properties, including JSON's __proto__ key.
      contents = JSON.stringify({ ...latest.document, syntaxTheme: choice }) + "\n";
    } catch {
      return { ok: false, issue: issue("write-failed") };
    }
    if (Buffer.byteLength(contents, "utf8") > SETTINGS_FILE_MAX_BYTES) {
      return { ok: false, issue: issue("too-large") };
    }
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    let handle;
    let ownsTemporary = false;
    try {
      if (signal?.aborted) throw UPDATE_CANCELLED;
      await fs.mkdir(dirname(this.file), { recursive: true });
      if (signal?.aborted) throw UPDATE_CANCELLED;
      handle = await fs.open(temporary, "wx", 0o600);
      ownsTemporary = true;
      if (signal?.aborted) throw UPDATE_CANCELLED;
      await handle.writeFile(contents, "utf8");
      if (signal?.aborted) throw UPDATE_CANCELLED;
      await handle.close();
      handle = undefined;
      // Requesting rename while still current is the commit boundary. Cancellation
      // before it prevents publication; an already requested rename is not undone.
      if (signal?.aborted) throw UPDATE_CANCELLED;
      await fs.rename(temporary, this.file);
      ownsTemporary = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, issue: issue(error === UPDATE_CANCELLED ? "cancelled" : "write-failed") };
    } finally {
      await handle?.close().catch(() => {});
      if (ownsTemporary) await fs.unlink(temporary).catch(() => {});
    }
  }
}
