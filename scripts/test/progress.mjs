import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function progressPaths(reportPath) {
  const file = basename(reportPath);
  const stem = file.endsWith('.json') ? file.slice(0, -5) : file;
  const directory = dirname(reportPath);
  return {
    events: join(directory, `${stem}.progress.jsonl`),
    tests: join(directory, `${stem}.tests.jsonl`),
  };
}

export function resetProgressFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function appendProgress(path, event) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readProgressEvents(path) {
  if (!existsSync(path)) return { events: [], truncatedLines: 0 };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const terminated = text.endsWith('\n');
  if (terminated) lines.pop();
  const tail = terminated ? undefined : lines.pop();
  let truncatedLines = 0;
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Malformed progress record in ${basename(path)}`, { cause: error });
    }
  }
  if (tail) {
    try { events.push(JSON.parse(tail)); }
    catch { truncatedLines = 1; }
  }
  return { events, truncatedLines };
}

export function summarizeTestEvents(events, { now = Date.now(), limit = 20 } = {}) {
  const active = new Map();
  const cases = [];
  for (const event of events) {
    if (event.event === 'test-start') {
      active.set(event.key, event);
      continue;
    }
    if (event.event !== 'test-complete') continue;
    active.delete(event.key);
    cases.push({
      name: event.name,
      file: event.file,
      ...(event.line === undefined ? {} : { line: event.line }),
      ...(event.column === undefined ? {} : { column: event.column }),
      ...(event.nesting === undefined ? {} : { nesting: event.nesting }),
      ...(event.testNumber === undefined ? {} : { testNumber: event.testNumber }),
      kind: event.kind,
      status: event.status,
      durationMs: event.durationMs,
      completedAt: event.at,
    });
  }
  const activeTests = [...active.values()].map(event => ({
    name: event.name,
    file: event.file,
    ...(event.line === undefined ? {} : { line: event.line }),
    ...(event.column === undefined ? {} : { column: event.column }),
    ...(event.nesting === undefined ? {} : { nesting: event.nesting }),
    ...(event.testNumber === undefined ? {} : { testNumber: event.testNumber }),
    kind: event.kind,
    startedAt: event.at,
    elapsedMs: Math.max(0, now - Date.parse(event.at)),
  })).sort((a, b) => b.elapsedMs - a.elapsedMs);
  const byDuration = (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)
    || String(a.file).localeCompare(String(b.file))
    || (a.line ?? 0) - (b.line ?? 0)
    || a.name.localeCompare(b.name);
  const slowestTests = cases.filter(item => item.kind === 'test').sort(byDuration).slice(0, limit);
  const slowestSuites = cases.filter(item => item.kind === 'suite').sort(byDuration).slice(0, limit);
  return { cases, activeTests, slowestTests, slowestSuites };
}

export function testEventKey(data) {
  return JSON.stringify([
    data.testId ?? null, data.file ?? null, data.line ?? null, data.column ?? null,
    data.nesting ?? null, data.name ?? null,
  ]);
}

export function workspaceRelativeTestFile(file, cwd = process.cwd()) {
  if (typeof file !== 'string' || !file) return null;
  let absolute;
  try { absolute = resolve(cwd, file.startsWith('file:') ? fileURLToPath(file) : file); }
  catch { return `external/${basename(file)}`; }
  const relativePath = relative(cwd, absolute);
  if (relativePath === '') return '.';
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return `external/${basename(absolute)}`;
  }
  return relativePath.split(sep).join('/');
}
