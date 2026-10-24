import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export const resourceIntervalMs = 1000;
const peakScope = 'worker-process-lifetime-excluding-descendants';

export function readWorkerResources(directory, selected) {
  const byFile = new Map(), admitted = new Set(selected);
  for (const name of readdirSync(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (record.schema !== 1 || !admitted.has(record.file) || byFile.has(record.file)
          || record.scope !== peakScope || !Number.isFinite(Date.parse(record.startedAt))
          || !Number.isFinite(Date.parse(record.observedAt))
          || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0
          || typeof record.complete !== 'boolean'
          || [record.memoryPeakBytes, record.userCpuMs, record.systemCpuMs].some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
        throw new Error('invalid worker measurements');
      }
    } catch (error) {
      throw new Error('Malformed test resource record: ' + name, { cause: error });
    }
    byFile.set(record.file, record);
  }
  return selected.map(file => {
    const record = byFile.get(file);
    if (!record) return { file, scope: peakScope, complete: false, memoryPeakBytes: null, userCpuMs: null, systemCpuMs: null, unavailable: ['memoryPeakBytes', 'userCpuMs', 'systemCpuMs', 'elapsedMs'], unavailableReason: 'worker-not-observed' };
    return { ...record, ...(!record.complete ? { unavailableReason: 'worker-exit-record-unavailable' } : {}) };
  });
}

export function summarizeWorkerResources(records) {
  const intervals = records.flatMap(record => record.startedAt && (record.finishedAt || record.observedAt) ? [
    { at: Date.parse(record.startedAt), delta: 1 },
    { at: Date.parse(record.finishedAt ?? record.observedAt), delta: -1 },
  ] : []);
  intervals.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, maximum = 0;
  for (const event of intervals) { active += event.delta; maximum = Math.max(maximum, active); }
  return {
    maxObservedFileWorkers: maximum,
    overlapSemantics: 'observed-worker-collector-intervals; incomplete intervals are lower bounds',
    intervalsComplete: records.every(record => record.complete),
    largestWorkers: records.filter(record => record.memoryPeakBytes !== null).sort((a, b) => b.memoryPeakBytes - a.memoryPeakBytes).slice(0, 20),
    slowestFiles: records.filter(record => Number.isFinite(record.elapsedMs)).sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 20),
  };
}

function counter(path, events = false) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (events) {
      return Object.fromEntries(text.split('\n').map(line => {
        const match = /^([\w.-]+) (\d+)$/.exec(line);
        if (!match) throw new Error('Invalid kernel counter');
        return [match[1], Number(match[2])];
      }));
    }
    if (!/^\d+$/.test(text)) throw new Error('Invalid kernel counter');
    return Number(text);
  } catch (error) {
    if (['ENOENT', 'EACCES', 'ENODEV'].includes(error.code)) return null;
    throw error;
  }
}

export function scopeResources() {
  if (process.platform !== 'linux') return { available: false, reason: 'requires-linux-test-scope' };
  try {
    const membership = readFileSync('/proc/self/cgroup', 'utf8').trim();
    const match = /^0::(\/[^\n]+)$/.exec(membership);
    if (!match || !/^tidy-ui-(?:test|perf)-[a-f\d]+\.scope$/.test(basename(match[1])) || match[1].split('/').includes('..')) {
      return { available: false, reason: 'no-dedicated-test-scope' };
    }
    const root = join('/sys/fs/cgroup', match[1]);
    const expected = { 'memory.max': '2147483648', 'memory.high': '1610612736', 'memory.swap.max': '0', 'memory.oom.group': '1', 'pids.max': '128' };
    const limits = Object.fromEntries(Object.keys(expected).map(name => [name, readFileSync(join(root, name), 'utf8').trim()]));
    if (Object.keys(expected).some(name => limits[name] !== expected[name])) return { available: false, reason: 'unverified-test-scope-limits' };
    const status = readFileSync('/proc/self/status', 'utf8');
    const result = {
      available: true,
      method: 'cgroup-v2-kernel-counters',
      scope: 'containment-scope-lifetime-not-exclusive-to-this-run-or-stage',
      cgroup: match[1], limits,
      cpuAffinity: /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1] ?? null,
      observedAt: new Date().toISOString(),
      memoryPeakBytes: counter(join(root, 'memory.peak')),
      memoryEvents: counter(join(root, 'memory.events'), true),
      pidsPeak: counter(join(root, 'pids.peak')),
      pidsEvents: counter(join(root, 'pids.events'), true),
      cpu: counter(join(root, 'cpu.stat'), true),
    };
    result.unavailable = ['memoryPeakBytes', 'memoryEvents', 'pidsPeak', 'pidsEvents', 'cpu'].filter(key => result[key] === null);
    return result;
  } catch (error) {
    return { available: false, reason: 'test-scope-observation-failed', code: typeof error.code === 'string' ? error.code : 'invalid-counter' };
  }
}

export function focusedRerun(node, inputPath, file, { pattern, skip, networkIsolated = false } = {}) {
  return [node, 'scripts/test/run.mjs', '--inputs', inputPath, '--suite', 'groups', '--files', file, '--jobs', '1',
    ...(pattern !== undefined ? ['--pattern', pattern] : []), ...(skip !== undefined ? ['--skip', skip] : []),
    ...(networkIsolated ? ['--network-isolated'] : [])];
}
