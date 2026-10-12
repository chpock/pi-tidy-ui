import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const run = promisify(execFile);
const errno = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EINTEGRITY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOBUFS']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT']);
const stages = new Set(['npm', 'idealTree', 'reify', 'build', 'command', 'install', 'pack']);

type CacheStatus = 'hit' | 'miss' | 'revalidated' | 'updated' | 'skip';
type Event = { line: number; event: string; status?: number; elapsedMs?: number; cache?: CacheStatus; resource?: 'tarball' | 'document' | 'unknown' };
const phaseNames = new Set(['npm', 'npm:load', 'idealTree', 'idealTree:init', 'idealTree:userRequests',
  'idealTree:buildDeps', 'idealTree:fixDepFlags', 'idealTree:inflate', 'idealTree:prune',
  'reify', 'reify:loadTrees', 'reify:diffTrees', 'reify:retireShallow', 'reify:createSparse',
  'reify:loadBundles', 'reify:unpack', 'reify:unretire', 'reify:build', 'reify:trash', 'reify:save',
  'build', 'build:deps', 'build:queue', 'build:link', 'command:install', 'command:pack']);

export function summarizeTemporaryDrive(path: string): string | null {
  const root = win32.parse(path).root;
  return /^[A-Za-z]:[\\/]$/.test(root) ? root[0]!.toUpperCase() : null;
}

function resource(url: string): Event['resource'] {
  try { return new URL(url).pathname.endsWith('.tgz') ? 'tarball' : 'document'; }
  catch { return 'unknown'; }
}

export function summarizeNpmTimings(value: unknown) {
  const phases: Record<string, number> = {};
  const reifyNodes = { count: 0, totalMs: 0, maxMs: 0 };
  const timers = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).timers : undefined;
  if (timers && typeof timers === 'object' && !Array.isArray(timers)) {
    for (const [name, elapsed] of Object.entries(timers)) {
      if (typeof elapsed !== 'number' || !Number.isSafeInteger(elapsed) || elapsed < 0) continue;
      if (phaseNames.has(name)) phases[name] = elapsed;
      else if (name.startsWith('reifyNode:')) {
        reifyNodes.count++; reifyNodes.totalMs += elapsed; reifyNodes.maxMs = Math.max(reifyNodes.maxMs, elapsed);
      }
    }
  }
  return { phases, reifyNodes };
}

// Project only known numeric/enum fields: npm's own secret redaction is not a guarantee.
export function summarizeNpmLog(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (?:silly|verbose|info|http|timing|warn|error) (.*)$/.exec(line);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) continue;
    const body = match[2]!;
    const http = /^fetch (?:GET|POST|PUT|DELETE|HEAD) (\d{3}) (\S+) (\d+)ms(?: |$)/.exec(body);
    const hit = /^cache (\S+) (\d+)ms(?: attempt #\d+)? \(cache hit\)$/.exec(body);
    const cache = / \(cache (hit|miss|revalidated|updated|skip)\)$/.exec(body)?.[1] as CacheStatus | undefined;
    const timing = /^(\S+) Completed in (\d+)ms$/.exec(body);
    if (http && Number(http[1]) >= 100 && Number(http[1]) <= 599 && Number.isSafeInteger(Number(http[3]))) {
      events.push({ line: sequence, event: 'http', status: Number(http[1]), elapsedMs: Number(http[3]),
        ...(cache ? { cache } : {}), resource: resource(http[2]!) });
    } else if (hit && Number.isSafeInteger(Number(hit[2]))) {
      events.push({ line: sequence, event: 'cache', elapsedMs: Number(hit[2]), cache: 'hit', resource: resource(hit[1]!) });
    } else if (timing && stages.has(timing[1]!.split(':')[0]!) && Number.isSafeInteger(Number(timing[2]))) {
      events.push({ line: sequence, event: timing[1]!.split(':')[0]!, elapsedMs: Number(timing[2]) });
    } else {
      const event = /^fetch manifest /.test(body) ? 'fetchManifest'
        : /^tarball /.test(body) ? 'tarball'
        : /^placeDep /.test(body) ? 'placeDependency'
        : /^idealTree(?: |:|$)/.test(body) ? 'idealTree'
        : /^reify(?: |:|$)/.test(body) ? 'reify'
        : /^config load:/.test(body) ? 'configuration'
        : /^code /.test(body) && errno.has(body.slice(5)) ? body.slice(5) : undefined;
      if (event) events.push({ line: sequence, event });
    }
  }
  return events;
}

export async function runNpmPreparation(args: string[], options: {
  cwd: string; npmPath: string; logsRoot: string; reportsRoot: string;
}) {
  await mkdir(options.logsRoot, { recursive: true });
  const logs = await mkdtemp(join(options.logsRoot, 'command-'));
  const started = performance.now();
  const configuredThreads = Number(process.env.UV_THREADPOOL_SIZE);
  const configuredThreadpoolSize = Number.isSafeInteger(configuredThreads) && configuredThreads > 0 ? configuredThreads : null;
  async function save(failed?: { code?: unknown; killed?: boolean; signal?: unknown }) {
    const elapsedMs = Math.round(performance.now() - started);
    const summaries: Event[][] = [], timings: ReturnType<typeof summarizeNpmTimings>[] = [];
    let invalidTimings = 0;
    for (const file of await readdir(logs, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (/-debug-\d+\.log$/.test(file.name)) summaries.push(summarizeNpmLog(await readFile(join(logs, file.name), 'utf8')));
      else if (/-timing\.json$/.test(file.name)) {
        const text = await readFile(join(logs, file.name), 'utf8');
        try { timings.push(summarizeNpmTimings(JSON.parse(text))); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; invalidTimings++; }
      }
    }
    await mkdir(options.reportsRoot, { recursive: true });
    const report = await mkdtemp(join(options.reportsRoot, 'installed-preparation-'));
    await writeFile(join(report, 'npm.json'), JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch,
      operation: args[0] === 'pack' ? 'pack' : 'install', elapsedMs, configuredThreadpoolSize,
      temporaryDrive: summarizeTemporaryDrive(logs),
      exitCode: failed ? typeof failed.code === 'number' ? failed.code : null : 0,
      errno: typeof failed?.code === 'string' && errno.has(failed.code) ? failed.code : null,
      signal: typeof failed?.signal === 'string' && signals.has(failed.signal) ? failed.signal : null,
      killed: failed?.killed === true, debugLogs: summaries, timings, invalidTimings,
    }, null, 2) + '\n');
  }
  let result;
  try {
    result = await run(process.execPath, [options.npmPath, ...args, '--timing', `--logs-dir=${logs}`], {
      cwd: options.cwd, timeout: 300000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    try { await save(error as { code?: unknown; killed?: boolean; signal?: unknown }); }
    catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], 'npm preparation failed and diagnostics could not be saved');
    }
    throw error;
  }
  await save();
  return result;
}
