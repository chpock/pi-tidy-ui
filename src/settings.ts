import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import nativeFs, { type BigIntStats, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SyntaxTheme = { kind: "pi" } | { kind: "occipital"; id: string };
export const SWITCH_KEYS = ['terminalColorsEnabled', 'nativeHighlightingEnabled'] as const;
export type SavedSwitches = Record<(typeof SWITCH_KEYS)[number], boolean>;
export type LocalPreferences = { appearanceEnabled: boolean; loggingEnabled: boolean };
export type Switches = SavedSwitches & LocalPreferences;
const localKey = Symbol.for('pi-tidy-ui.process-preferences');
/** Only primitive values outlive module reload; no runtime owners live here. */
export function processPreferences(): LocalPreferences {
  const processState = globalThis as typeof globalThis & { [localKey]?: LocalPreferences };
  return processState[localKey] ??= { appearanceEnabled: true, loggingEnabled: true };
}
export type SettingsPatch = Partial<SavedSwitches & { syntaxTheme: SyntaxTheme }>;
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
  "invalid-switch": "Settings contain a nonboolean switch preference.",
  "too-large": "Settings exceed the file size limit.",
  "read-failed": "Settings could not be read.",
  "invalid-patch": "Settings update contains an invalid preference or field.",
  "write-failed": "Settings could not be saved; the previous file was kept.",
  "cancelled": "Settings update was cancelled; the previous file was kept.",
  "watch-failed": "Settings changes could not be monitored; reload Pi to retry.",
} as const;

export type SettingsIssue = { code: keyof typeof ISSUE_MESSAGES; message: string };
export type SettingsLoadResult = Partial<SavedSwitches> & (
  | { ok: true; syntaxTheme: SyntaxTheme }
  | { ok: false; syntaxTheme: SyntaxTheme; issue: SettingsIssue });
export type SettingsSaveResult = { ok: true } | { ok: false; issue: SettingsIssue };
export type SettingsLocation = { agentDir: string; file?: never } | { file: string; agentDir?: never };

type DocumentResult = ({ ok: true; document: Record<string, unknown> } | { ok: false; issue: SettingsIssue }) & { stamp?: string };
function metadata(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

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
      if (object(error) && error.code === "ENOENT") return { ok: true, document: {}, stamp: 'missing' };
      return { ok: false, issue: issue("read-failed") };
    }
    const stat = await handle.stat({ bigint: true });
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
    if (SWITCH_KEYS.some(key => Object.hasOwn(document, key) && typeof (document as Record<string, unknown>)[key] !== 'boolean'))
      return { ok: false, issue: issue('invalid-switch') };
    return { ok: true, document, stamp: metadata(stat) };
  } catch {
    return { ok: false, issue: issue("read-failed") };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Validated user preferences; live application belongs to the caller, not this store. */
export class ExtensionSettings {
  readonly file: string;
  private writes: Promise<void> = Promise.resolve();
  private writeRevision = 0;
  private lastStamp?: string;

  constructor(location?: SettingsLocation) {
    this.file = location?.file ?? join(location?.agentDir ?? getAgentDir(), "extensions", "pi-tidy-ui", "config.json");
  }

  private async read(): Promise<{ value: SettingsLoadResult; stamp?: string }> {
    const result = await readDocument(this.file);
    if (!result.ok) return { value: { ok: false, syntaxTheme: { kind: 'pi' }, issue: result.issue } };
    const switches = Object.fromEntries(SWITCH_KEYS.filter(key => Object.hasOwn(result.document, key)).map(key => [key, result.document[key]])) as Partial<SavedSwitches>;
    return { stamp: result.stamp, value: { ok: true, ...switches, syntaxTheme: Object.hasOwn(result.document, 'syntaxTheme') ?
      syntaxTheme(result.document.syntaxTheme)! : { kind: 'pi' } } };
  }
  async load(): Promise<SettingsLoadResult> {
    const result = await this.read(); this.lastStamp = result.stamp; return result.value;
  }

  /** Subscribe only while a runtime is active. Renames are observed on the directory,
   * or its nearest existing ancestor until the configuration is first created. */
  watch(changed: (value: SettingsLoadResult) => void): () => void {
    let closed = false, running = false, dirty = false, rearm = true;
    let watcher: FSWatcher | undefined, scheduled: NodeJS.Immediate | undefined;
    let directory = '', stamp = this.lastStamp;
    const publish = (value: SettingsLoadResult) => {
      if (!closed) { try { changed(value); } catch { /* Observers do not own the filesystem subscription. */ } }
    };
    const schedule = () => {
      if (closed) return;
      dirty = true;
      if (!running && !scheduled) { scheduled = setImmediate(check); scheduled.unref(); }
    };
    const subscribe = (target: string) => {
      const child = relative(target, this.file).split(sep)[0]!;
      const next = nativeFs.watch(target, { persistent: false }, (_event, name) => {
        if (name !== null && String(name) !== child && String(name) !== basename(target)) return;
        if (target !== dirname(this.file) || name === null || String(name) === basename(target)) rearm = true;
        schedule();
      });
      next.on('error', () => { rearm = true; schedule(); });
      const previous = watcher; watcher = next; directory = target;
      previous?.close();
    };
    const arm = () => {
      rearm = false;
      let target = dirname(this.file);
      for (;;) {
        try { subscribe(target); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code === 'ENOENT' || code === 'ENOTDIR') && dirname(target) !== target) { target = dirname(target); continue; }
          publish({ ok: false, syntaxTheme: { kind: 'pi' }, issue: issue('watch-failed') }); return;
        }
      }
      // Cover mkdir between the failed child watch and the ancestor subscription.
      while (directory !== dirname(this.file)) {
        const child = join(directory, relative(directory, dirname(this.file)).split(sep)[0]!);
        try { subscribe(child); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return;
          publish({ ok: false, syntaxTheme: { kind: 'pi' }, issue: issue('watch-failed') }); return;
        }
      }
    };
    const check = async () => {
      scheduled = undefined; if (closed) return;
      running = true;
      try {
        do {
          dirty = false;
          if (rearm || !directory) arm();
          const writes = this.writes; await writes;
          if (closed) return;
          if (writes !== this.writes) { dirty = true; continue; }
          const revision = this.writeRevision;
          let next: string;
          try { next = metadata(await fs.stat(this.file, { bigint: true })); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; next = 'missing'; }
          if (closed) return;
          if (revision !== this.writeRevision) { dirty = true; continue; }
          if (next === stamp) continue;
          const loaded = await this.read();
          if (closed) return;
          if (revision !== this.writeRevision) { dirty = true; continue; }
          stamp = loaded.stamp ?? next; this.lastStamp = stamp;
          publish(loaded.value);
        } while (dirty && !closed);
      } catch { publish({ ok: false, syntaxTheme: { kind: 'pi' }, issue: issue('read-failed') }); }
      finally { running = false; if (dirty) schedule(); }
    };
    arm(); schedule();
    return () => { closed = true; if (scheduled) clearImmediate(scheduled); scheduled = undefined; watcher?.close(); watcher = undefined; };
  }

  update(patch: SettingsPatch, options?: { signal?: AbortSignal }): Promise<SettingsSaveResult> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.resolve({ ok: false, issue: issue("cancelled") });
    // Snapshot before queuing so later caller mutations cannot alter the saved choice.
    if (!object(patch) || Object.keys(patch).length === 0) return Promise.resolve({ ok: false, issue: issue('invalid-patch') });
    const copy: SettingsPatch = {};
    for (const key of Object.keys(patch)) {
      const value: unknown = patch[key as keyof SettingsPatch];
      if (key === 'syntaxTheme') {
        const choice = syntaxTheme(value);
        if (!choice) return Promise.resolve({ ok: false, issue: issue('invalid-patch') });
        copy.syntaxTheme = choice;
      } else if ((SWITCH_KEYS as readonly string[]).includes(key) && typeof value === 'boolean') {
        copy[key as keyof SavedSwitches] = value;
      } else return Promise.resolve({ ok: false, issue: issue('invalid-patch') });
    }
    this.writeRevision++;
    const operation = this.writes.then(() => this.save(copy, signal));
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  private async save(patch: SettingsPatch, signal?: AbortSignal): Promise<SettingsSaveResult> {
    if (signal?.aborted) return { ok: false, issue: issue("cancelled") };
    const latest = await readDocument(this.file);
    if (signal?.aborted) return { ok: false, issue: issue("cancelled") };
    if (!latest.ok) return { ok: false, issue: latest.issue };
    let contents: string;
    try {
      // Object spread creates own data properties, including JSON's __proto__ key.
      const document: Record<string, unknown> = { ...latest.document, ...patch };
      delete document.appearanceEnabled; delete document.loggingEnabled;
      contents = JSON.stringify(document) + "\n";
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
