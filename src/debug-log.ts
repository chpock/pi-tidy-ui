import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { diagnosticError, type DiagnosticFields, type DiagnosticLevel, type DiagnosticSink } from "./diagnostics.ts";

const MiB = 1024 * 1024;
const defaults = { fileBytes: 4 * MiB, commonBytes: MiB, recordBytes: 16 * 1024, bufferBytes: 128 * 1024,
  batchBytes: 32 * 1024, flushDelayMs: 500, keep: 16, ageMs: 7 * 86400_000, cleanupIntervalMs: 6 * 3600_000, closeWaitMs: 2000 };
type Limits = typeof defaults;
export interface JournalIdentity {
  session: string; name?: string; sessionFile?: string; cwd: string; reason: string; run?: string;
  extension: string; pi: string; mode?: string; provider?: string; theme?: string;
}
export interface JournalOptions {
  root?: string;
  /** A saved Off must not create files or run retention before explicit enable. */
  enabled?: boolean;
  /** Small limits and controlled I/O are for isolated functional tests. */
  limits?: Partial<Limits>; io?: typeof fs; now?: () => number; alive?: (pid: number) => boolean;
  warn?: (message: string) => void;
}

export function debugLogRoot(): string {
  const user = process.getuid ? String(process.getuid()) : (process.env.USERNAME ?? "user").replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
  return join(tmpdir(), `pi-tidy-ui-${user}`);
}
export function readableDiagnosticText(value: string, limit = 1024): string {
  const shortened = value.length > limit;
  return value.slice(0, limit).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, character => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return character.charCodeAt(0) < 256 ? `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u${character.charCodeAt(0).toString(16)}`;
  }) + (shortened ? "…[shortened]" : "");
}
const shortened = Buffer.from("…[shortened]\n");
function encoded(value: string, limit: number): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return bytes;
  let end = limit - shortened.length;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return Buffer.concat([bytes.subarray(0, end), shortened]);
}
function fields(values: DiagnosticFields = {}): string {
  const parts: string[] = [];
  for (const key of Object.keys(values).slice(0, 32)) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
      parts.push(`${readableDiagnosticText(key, 64)}=[omitted]`); continue;
    }
    parts.push(`${readableDiagnosticText(key, 64)}=${typeof value === "string" ? readableDiagnosticText(value) : String(value)}`);
  }
  return parts.length ? `; ${parts.join(" ")}` : "";
}
function coded(code: string): Error { return Object.assign(new Error(code), { code }); }
function missing(error: unknown): boolean { return diagnosticError(error) === "ENOENT"; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return diagnosticError(error) !== "ESRCH"; }
}
const journalName = /^(\d{8}T\d{9}Z-[a-zA-Z0-9_-]{1,24}-(\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\.closed)?\.log(\.1)?$/u;

/** Inactivity is filesystem last-write time, not journal contents or session age. */
export async function cleanupJournals(root: string, options: { now?: number; keep?: number; ageMs?: number;
  alive?: (pid: number) => boolean; current?: string; io?: typeof fs } = {}): Promise<void> {
  const io = options.io ?? fs, now = options.now ?? Date.now();
  const groups = new Map<string, { files: string[]; modified: number; skip: boolean; pid: number; closed: boolean }>();
  for (const entry of await io.readdir(root, { withFileTypes: true })) {
    const match = journalName.exec(entry.name);
    if (!match) continue;
    const base = `${match[1]}${match[3] ?? ""}.log`, path = join(root, entry.name);
    const group = groups.get(base) ?? { files: [], modified: 0, skip: base === options.current, pid: Number(match[2]), closed: !!match[3] };
    groups.set(base, group);
    if (!entry.isFile() || entry.isSymbolicLink()) { group.skip = true; continue; }
    try {
      const stat = await io.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) { group.skip = true; continue; }
      group.modified = Math.max(group.modified, stat.mtimeMs); group.files.push(path);
    } catch (error) { if (!missing(error)) throw error; }
  }
  const candidates = [...groups.values()].filter(group => !group.skip && group.files.length &&
    (group.closed || !(options.alive ?? alive)(group.pid))).sort((a, b) => b.modified - a.modified);
  for (const [index, group] of candidates.entries()) if (index >= (options.keep ?? defaults.keep) || group.modified < now - (options.ageMs ?? defaults.ageMs)) {
    for (const path of group.files) try { await io.unlink(path); } catch (error) { if (!missing(error)) throw error; }
  }
}

export class TextJournal {
  ready: Promise<void>;
  readonly sink: DiagnosticSink;
  readonly run: string;
  private readonly fileId = randomUUID();
  private readonly identity: JournalIdentity;
  private readonly io: typeof fs;
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly options: JournalOptions;
  private root: string;
  private path: string;
  private readonly header: Buffer;
  private handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  private queue: Buffer[] = [];
  private pendingBytes = 0;
  private inFlightBytes = 0;
  private bytes = 0;
  private dropped = 0;
  private omitted = 0;
  private records = 0;
  private writes = 0;
  private writeErrors = 0;
  private rotations = 0;
  private scans = 0;
  private commonFailed = false;
  private state: "off" | "starting" | "active" | "failed" | "closed" = "starting";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pump: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private failedClose: Promise<void> | undefined;
  private accepting = true;
  private enabled = true;
  private created = false;
  private privateRoot = false;
  private nextCleanup: number;
  private failure: string | undefined;

  constructor(identity: JournalIdentity, options: JournalOptions = {}) {
    this.identity = { ...identity }; this.options = options; this.io = options.io ?? fs;
    this.run = identity.run ?? randomUUID();
    this.limits = { ...defaults, ...options.limits }; this.now = options.now ?? Date.now;
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < (name === "keep" ? 0 : 1)) throw new RangeError(`Invalid journal limit: ${name}`);
    const time = new Date(this.now()).toISOString();
    this.root = options.root ?? debugLogRoot();
    const label = identity.session.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 24) || "unknown";
    this.path = join(this.root, `${time.replace(/[-:.]/gu, "")}-${label}-${process.pid}-${this.fileId}.log`);
    this.header = encoded(`${time} INFO  Session started: session=${readableDiagnosticText(identity.session)} run=${readableDiagnosticText(this.run, 128)} pid=${process.pid} reason=${readableDiagnosticText(identity.reason)}\n` +
      `    Name: ${readableDiagnosticText(identity.name ?? "unknown")}\n    Pi session: ${readableDiagnosticText(identity.sessionFile ?? "in memory / unknown")}\n` +
      `    Workspace: ${readableDiagnosticText(identity.cwd)}\n    Extension: pi-tidy-ui ${readableDiagnosticText(identity.extension)}; Pi ${readableDiagnosticText(identity.pi)}; Node ${process.versions.node}\n` +
      `    Platform: ${process.platform}/${process.arch}; mode=${readableDiagnosticText(identity.mode ?? "unknown")}; provider=${readableDiagnosticText(identity.provider ?? "unknown")}; theme=${readableDiagnosticText(identity.theme ?? "unknown")}\n`, Math.min(16 * 1024, this.limits.fileBytes));
    this.nextCleanup = this.now() + this.limits.cleanupIntervalMs;
    this.sink = (level, area, explanation, details) => this.record(level, area, explanation, details);
    this.enabled = options.enabled ?? true;
    if (!this.enabled) this.state = 'off';
    this.ready = this.enabled ? this.initialize() : Promise.resolve();
  }

  private async initialize(): Promise<void> {
    try {
      if (!isAbsolute(this.root)) throw coded("EINVAL");
      const rootLength = parse(this.root).root.length;
      let end = this.root.length;
      const separator = process.platform === "win32" ? /[\\/]/u : /\//u;
      while (end > rootLength && separator.test(this.root[end - 1]!)) end--;
      this.root = this.root.slice(0, end);
      if (this.header.length + 64 > this.limits.fileBytes || this.header.length + 64 > this.limits.bufferBytes || this.limits.recordBytes < 64) throw coded("EINVAL");
      await this.io.mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = await this.io.lstat(this.root);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw coded("ELOOP");
      if (process.getuid && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0)) throw coded("EACCES");
      this.root = await this.io.realpath(this.root); this.path = join(this.root, this.path.split(/[\\/]/u).at(-1)!);
      this.privateRoot = true;
      await this.cleanup();
      this.handle = await this.io.open(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      this.created = true;
      await this.write([this.header]);
      this.state = "active";
      await this.common("started", this.identity.reason);
      if (this.queue.length) this.schedule();
    } catch (error) { this.fail("start journal", error); }
  }
  private notice(message: string): void { try { this.options.warn?.(message); } catch { /* Do not fail the extension's operation. */ } }
  private fail(operation: string, error: unknown): void {
    if (this.state === "failed") return;
    this.writeErrors++; this.failure = `${operation}: ${diagnosticError(error)}`; this.state = "failed"; this.accepting = false; this.enabled = false;
    this.queue = []; this.pendingBytes = 0; this.omitted = 0; this.cancelTimer();
    const handle = this.handle; this.handle = undefined;
    this.failedClose = handle?.close().catch(() => undefined);
    this.notice(`[pi-tidy-ui] Debug logging stopped (${this.failure}). Open /tidy-ui → Status & troubleshooting → Diagnostic logs for details or to retry.`);
  }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    if (this.state !== "active" || !this.accepting || this.pump || !this.queue.length) return;
    if (this.pendingBytes >= this.limits.batchBytes) { void this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.limits.flushDelayMs);
    this.timer.unref();
  }
  record(level: DiagnosticLevel, area: string, explanation: string, details?: DiagnosticFields): void {
    if (!this.enabled || !this.accepting || this.state === "failed" || this.state === "closed") return;
    const maximum = Math.min(this.limits.recordBytes, this.limits.fileBytes - this.header.length, this.limits.bufferBytes - this.header.length);
    const row = encoded(`${new Date(this.now()).toISOString()} ${level.padEnd(5)} [${readableDiagnosticText(area, 64)}] ${readableDiagnosticText(explanation, 2048)}${fields(details)}\n`, maximum);
    if (this.pendingBytes + this.inFlightBytes + row.length > this.limits.bufferBytes - this.header.length) { this.dropped++; this.omitted++; return; }
    this.queue.push(row); this.pendingBytes += row.length; this.records++; this.schedule();
  }
  private omission(): void {
    if (!this.omitted) return;
    const row = encoded(`${new Date(this.now()).toISOString()} WARN  [logging] ${this.omitted} diagnostic records omitted because the pending buffer was full.\n`, Math.min(this.limits.recordBytes, this.limits.fileBytes - this.header.length, this.limits.bufferBytes - this.header.length));
    if (row.length + this.pendingBytes + this.inFlightBytes > this.limits.bufferBytes - this.header.length) return;
    this.queue.push(row); this.pendingBytes += row.length; this.omitted = 0; this.records++;
  }
  private async write(buffers: Buffer[]): Promise<void> {
    let remaining = buffers;
    this.inFlightBytes = buffers.reduce((sum, part) => sum + part.length, 0);
    try {
      while (remaining.length) {
        this.writes++;
        const { bytesWritten } = await this.handle!.writev(remaining);
        if (!bytesWritten) throw coded("EIO");
        this.bytes += bytesWritten;
        let consumed = bytesWritten, index = 0;
        while (index < remaining.length && consumed >= remaining[index]!.length) consumed -= remaining[index++]!.length;
        remaining = remaining.slice(index);
        if (consumed) remaining[0] = remaining[0]!.subarray(consumed);
      }
    } finally { this.inFlightBytes = 0; }
  }
  private async cleanup(): Promise<void> {
    this.nextCleanup = this.now() + this.limits.cleanupIntervalMs; this.scans++;
    await cleanupJournals(this.root, { io: this.io, now: this.now(), keep: this.limits.keep, ageMs: this.limits.ageMs,
      alive: this.options.alive, current: this.path.split(/[\\/]/u).at(-1)! });
  }
  private async rotate(): Promise<void> {
    await this.handle!.close(); this.handle = undefined;
    try { await this.io.unlink(`${this.path}.1`); } catch (error) { if (!missing(error)) throw error; }
    await this.io.rename(this.path, `${this.path}.1`);
    this.handle = await this.io.open(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.bytes = 0; this.rotations++;
    await this.write([this.header]);
  }
  async flush(): Promise<void> {
    this.cancelTimer();
    await this.ready;
    this.cancelTimer();
    if (this.state !== "active") return;
    do {
      if (!this.pump) this.pump = this.drain().finally(() => {
        this.pump = undefined;
        this.schedule();
      });
      await this.pump;
      this.cancelTimer();
    } while (this.state === "active" && (this.queue.length || this.omitted));
  }
  private async drain(): Promise<void> {
    try {
      if ((this.queue.length || this.omitted) && this.now() >= this.nextCleanup) await this.cleanup();
      while (this.queue.length || this.omitted) {
        this.omission();
        if (!this.queue.length) break;
        if (this.queue[0]!.length > this.limits.fileBytes - this.bytes) await this.rotate();
        let size = 0, count = 0;
        for (const row of this.queue) {
          if (size + row.length > this.limits.fileBytes - this.bytes || (count > 0 && size + row.length > this.limits.batchBytes)) break;
          size += row.length; count++;
        }
        const batch = this.queue.splice(0, count); this.pendingBytes -= size;
        await this.write(batch);
      }
    } catch (error) { this.fail("write journal", error); }
  }
  private async common(phase: "started" | "ended", reason: string): Promise<void> {
    if (this.commonFailed || !this.privateRoot) return;
    const path = join(this.root, "sessions.log");
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      try {
        const stat = await this.io.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw coded("ELOOP");
        if (stat.size >= this.limits.commonBytes) {
          try { await this.io.unlink(`${path}.1`); } catch (error) { if (!missing(error)) throw error; }
          try { await this.io.rename(path, `${path}.1`); } catch (error) { if (!missing(error)) throw error; }
        }
      } catch (error) { if (!missing(error)) throw error; }
      const row = encoded(`${new Date(this.now()).toISOString()} INFO  Session ${phase}: session=${readableDiagnosticText(this.identity.session)} run=${readableDiagnosticText(this.run, 128)} pid=${process.pid} reason=${readableDiagnosticText(reason)} journal=${readableDiagnosticText(this.path)}\n`, Math.min(this.limits.recordBytes, this.limits.commonBytes));
      handle = await this.io.open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(row);
    } catch (error) {
      this.commonFailed = true; this.writeErrors++;
      this.notice(`[pi-tidy-ui] Common session journal unavailable (${diagnosticError(error)}); detailed logging is independent. Open /tidy-ui → Status & troubleshooting → Diagnostic logs for its path.`);
    } finally { await handle?.close().catch(() => undefined); }
  }
  close(reason: string): Promise<void> {
    if (this.closing) return this.closing;
    this.record("INFO", "runtime", "Session run ended", { reason, records: this.records, dropped: this.dropped });
    this.accepting = false; this.cancelTimer();
    const finish = this.finishClose(reason);
    this.closing = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, this.limits.closeWaitMs);
      finish.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
    return this.closing;
  }
  private async finishClose(reason: string): Promise<void> {
    await this.flush();
    await this.failedClose;
    try {
      await this.handle?.close(); this.handle = undefined;
      if (this.created) {
        const closed = this.path.replace(/\.log$/u, ".closed.log");
        try { await this.io.rename(`${this.path}.1`, `${closed}.1`); } catch (error) { if (!missing(error)) throw error; }
        await this.io.rename(this.path, closed); this.path = closed;
      }
    } catch (error) { this.fail("close journal", error); }
    await this.common("ended", reason);
    if (this.state !== "failed") this.state = "closed";
  }
  setEnabled(enabled: boolean): void {
    if (!this.accepting || this.enabled === enabled) return;
    if (enabled) {
      this.enabled = true;
      if (this.state === 'off') { this.state = 'starting'; this.ready = this.initialize(); }
    }
    this.record("INFO", "logging", enabled ? "Diagnostic capture resumed" : "Diagnostic capture disabled");
    this.enabled = enabled;
    if (!enabled) void this.flush();
  }
  status() {
    return { state: this.state, enabled: this.enabled, session: this.identity.session, run: this.run, pid: process.pid, path: this.path,
      commonPath: join(this.root, "sessions.log"), pendingBytes: this.pendingBytes, inFlightBytes: this.inFlightBytes,
      bytes: this.bytes, records: this.records, writes: this.writes, rotations: this.rotations, scans: this.scans,
      dropped: this.dropped, writeErrors: this.writeErrors, commonFailed: this.commonFailed, failure: this.failure, timer: !!this.timer };
  }
}
