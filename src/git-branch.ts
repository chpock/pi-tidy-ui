import { diagnose, diagnosticError, type DiagnosticSink } from './diagnostics.ts';
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";

interface GitResult { ok: boolean; output: string; code?: number; error?: string }
export interface GitSourceOptions {
  diagnostic?: DiagnosticSink;
  env?: NodeJS.ProcessEnv;
  /** Test seam for cancellation/error controls; production always uses execFile. */
  execute?: (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<GitResult>;
}
const counters = { queries: 0, spawned: 0, branchReads: 0, discoveries: 0, watchers: 0, activeJobs: 0 };
/** Data-only counters: no source, component, process or callback references. */
export const gitDiagnostics = () => ({ ...counters });

function execute(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<GitResult> {
  return new Promise(done => {
    const child = execFile("git", ["-C", cwd, ...args], { env, signal, timeout: 2000, maxBuffer: 65536, encoding: "utf8" },
      (error, output) => done({ ok: !error, output, code: typeof error?.code === "number" ? error.code : undefined,
        error: error ? diagnosticError(error) : undefined }));
    child.once("spawn", () => { counters.spawned++; });
  });
}
function line(value: string): string {
  // Git appends LF; do not trim genuine whitespace/newlines from filesystem paths.
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

/** One generation-checked asynchronous snapshot; rendering only reads/schedules it. */
export class GitBranchSource {
  private cwd: string | undefined;
  private value: string | undefined;
  private generation = 0;
  private running: AbortController | undefined;
  private queued = false;
  private pending = false;
  private discover = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watched = new Map<string, FSWatcher>();
  private localNames: { key: string; names: string[] } | undefined;
  private waiters = new Set<() => void>();
  private notify: () => void;
  private options: GitSourceOptions;

  constructor(notify: () => void, options: GitSourceOptions = {}) { this.notify = notify; this.options = options; }
  branch(cwd: string): string | undefined { return cwd === this.cwd ? this.value : undefined; }
  setDirectory(cwd: string | undefined): void {
    if (cwd === this.cwd) return;
    diagnose(this.options.diagnostic, 'DEBUG', 'git', 'Directory identity changed; previous Git job/watchers are retired', { cwd: cwd ?? 'none', generation: this.generation + 1, cancelled: !!this.running });
    this.generation++; this.running?.abort(); this.closeWatches();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.cwd = cwd; this.value = undefined; this.pending = false; this.discover = false;
    if (cwd) this.refresh(true); else this.flush();
  }
  refresh(discover = false): void {
    if (!this.cwd) return;
    this.pending = true; this.discover ||= discover;
    if (this.running || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.cwd && this.pending) void this.run(); else this.flush();
    });
  }
  dispose(): void { this.setDirectory(undefined); }
  settled(): Promise<void> {
    if (!this.running && !this.queued && !this.pending && !this.timer) return Promise.resolve();
    return new Promise(done => { this.waiters.add(done); });
  }
  private flush(): void {
    if (this.running || this.queued || this.pending || this.timer) return;
    for (const done of this.waiters) done(); this.waiters.clear();
  }
  private closeWatches(): void {
    for (const watcher of this.watched.values()) { watcher.close(); counters.watchers--; }
    this.watched.clear();
  }
  private filesystem(discover: boolean): void {
    this.discover ||= discover;
    if (this.timer || !this.cwd) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(this.discover); }, 75);
    this.timer.unref();
  }
  private syncWatches(cwd: string, paths: string[]): void {
    // Rediscovery is also a watch-identity boundary: a directory can be replaced
    // at the same pathname. Reattach to current inodes, never trust path equality.
    this.closeWatches();
    const roles = new Map<string, "cwd" | "metadata" | "reftable">([[cwd, "cwd"]]);
    for (const path of paths) { roles.set(path, "metadata"); roles.set(join(path, "reftable"), "reftable"); }
    for (const [path, role] of roles) {
      const generation = this.generation;
      try {
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          if (generation !== this.generation || this.watched.get(path) !== watcher) return;
          const name = filename?.toString();
          if (role === "cwd" && name && name !== ".git") return;
          if (role === "metadata" && name && !["HEAD", "commondir", "config", "packed-refs", "refs", "reftable", basename(path)].includes(name)) return;
          this.filesystem(role !== "metadata" || name !== "HEAD");
        });
        watcher.on("error", (error: unknown) => {
          if (this.watched.get(path) !== watcher) return;
          diagnose(this.options.diagnostic, 'WARN', 'git', 'Git metadata watcher failed; rediscovery requested', { path, code: diagnosticError(error) });
          watcher.close(); this.watched.delete(path); counters.watchers--; this.filesystem(true);
        });
        this.watched.set(path, watcher); counters.watchers++;
      } catch (error) { diagnose(this.options.diagnostic, 'DEBUG', 'git', 'Git metadata watch unavailable; completed-operation refresh remains', { path, code: diagnosticError(error) }); }

    }
  }
  private async run(): Promise<void> {
    const cwd = this.cwd!, generation = this.generation, discover = this.discover;
    const abort = new AbortController(); this.running = abort; this.pending = false; this.discover = false;
    counters.activeJobs++;
    diagnose(this.options.diagnostic, 'DEBUG', 'git', 'Asynchronous Git refresh started', { cwd, generation, discover });
    const current = () => generation === this.generation && !abort.signal.aborted;
    const query = async (args: readonly string[], env: NodeJS.ProcessEnv): Promise<GitResult> => {
      counters.queries++; if (args[0] === "symbolic-ref") counters.branchReads++;
      const result = await (this.options.execute ?? execute)(cwd, args, env, abort.signal);
      if (!result.ok && current()) diagnose(this.options.diagnostic, 'DEBUG', 'git', 'Git query did not succeed; output is not logged', { operation: args[0], exit: result.code, code: result.error, generation });
      return result;
    };
    try {
      const env = { ...(this.options.env ?? process.env) };
      const setting = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
      const key = setting("PATH") + "\0" + setting("GIT_EXEC_PATH");
      if (this.localNames?.key !== key) {
        const names = await query(["rev-parse", "--local-env-vars"], env);
        if (!current()) return;
        if (!names.ok) { this.syncWatches(cwd, []); this.publish(undefined); return; }
        this.localNames = { key, names: names.output.split(/\r?\n/u).filter(name => /^GIT_[A-Z0-9_]+$/u.test(name)) };
      }
      const local = new Set(this.localNames.names);
      // Windows environment keys are case-insensitive; copied objects are not.
      for (const name of Object.keys(env)) if (local.has(name.toUpperCase())) delete env[name];
      if (discover) {
        counters.discoveries++;
        const paths: string[] = [];
        for (const args of [["rev-parse", "--absolute-git-dir"], ["rev-parse", "--path-format=absolute", "--git-common-dir"]]) {
          const result = await query(args, env);
          if (!current()) return;
          if (!result.ok || !result.output) break;
          paths.push(resolve(cwd, line(result.output)));
        }
        this.syncWatches(cwd, [...new Set(paths)]);
      }
      // Read after watch installation: events queued for a replaced/closed watcher
      // must not be our only route to correcting a pre-discovery HEAD snapshot.
      const head = await query(["symbolic-ref", "--quiet", "HEAD"], env);
      if (!current()) return;
      const ref = line(head.output);
      const branch = head.ok && ref.startsWith("refs/heads/") && ref.length > 11 && !/[\r\n\x00-\x1f\x7f]/u.test(ref) ? ref.slice(11) : undefined;
      this.publish(branch);
    } catch (error) {
      diagnose(this.options.diagnostic, 'WARN', 'git', 'Git refresh failed or was cancelled; output is not logged', { generation, cancelled: abort.signal.aborted, code: diagnosticError(error) });
      if (current()) { this.syncWatches(cwd, []); this.publish(undefined); }
    } finally {
      diagnose(this.options.diagnostic, 'DEBUG', 'git', 'Asynchronous Git refresh finished', { generation, current: current(), cancelled: abort.signal.aborted, watchers: this.watched.size });
      counters.activeJobs--; if (this.running === abort) this.running = undefined;
      if (this.cwd && this.pending) this.refresh(this.discover); else this.flush();
    }
  }
  private publish(value: string | undefined): void {
    if (value === this.value) return;
    this.value = value;
    diagnose(this.options.diagnostic, 'INFO', 'git', 'Displayed Git branch snapshot changed', { cwd: this.cwd, branch: value ?? 'unavailable or detached', generation: this.generation });
    this.notify();
  }
}
