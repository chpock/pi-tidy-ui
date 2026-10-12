import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const errno = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EINTEGRITY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOBUFS']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT']);
const stages = new Set(['npm', 'idealTree', 'reify', 'build', 'command', 'install', 'pack']);

type Event = { line: number; event: string; status?: number; elapsedMs?: number };

// Project only known numeric/enum fields: npm's own secret redaction is not a guarantee.
export function summarizeNpmLog(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (?:silly|verbose|info|http|timing|warn|error) (.*)$/.exec(line);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) continue;
    const body = match[2]!;
    const http = /^fetch (?:GET|POST|PUT|DELETE|HEAD) (\d{3}) \S+ (\d+)ms(?: |$)/.exec(body);
    const timing = /^(\S+) Completed in (\d+)ms$/.exec(body);
    if (http && Number(http[1]) >= 100 && Number(http[1]) <= 599 && Number.isSafeInteger(Number(http[2]))) {
      events.push({ line: sequence, event: 'http', status: Number(http[1]), elapsedMs: Number(http[2]) });
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
  try {
    return await run(process.execPath, [options.npmPath, ...args, `--logs-dir=${logs}`], {
      cwd: options.cwd, timeout: 120000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const failed = error as { code?: unknown; killed?: boolean; signal?: unknown };
    try {
      const summaries = [];
      for (const file of await readdir(logs, { withFileTypes: true })) {
        if (!file.isFile() || !/-debug-\d+\.log$/.test(file.name)) continue;
        summaries.push(summarizeNpmLog(await readFile(join(logs, file.name), 'utf8')));
      }
      await mkdir(options.reportsRoot, { recursive: true });
      const report = await mkdtemp(join(options.reportsRoot, 'installed-preparation-'));
      await writeFile(join(report, 'npm.json'), JSON.stringify({
        node: process.version, platform: process.platform, arch: process.arch,
        operation: args[0] === 'pack' ? 'pack' : 'install',
        exitCode: typeof failed.code === 'number' ? failed.code : null,
        errno: typeof failed.code === 'string' && errno.has(failed.code) ? failed.code : null,
        signal: typeof failed.signal === 'string' && signals.has(failed.signal) ? failed.signal : null,
        killed: failed.killed === true, debugLogs: summaries,
      }, null, 2) + '\n');
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], 'npm preparation failed and diagnostics could not be saved');
    }
    throw error;
  }
}
