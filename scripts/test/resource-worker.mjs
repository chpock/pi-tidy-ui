import { isAbsolute, join, relative, sep } from 'node:path';
import { writeReport } from './progress.mjs';
import { resourceIntervalMs } from './resources.mjs';

if (process.env.NODE_TEST_CONTEXT === 'child-v8' && process.env.TIDY_TEST_RESOURCE_DIR) {
  const directory = process.env.TIDY_TEST_RESOURCE_DIR;
  const selected = JSON.parse(process.env.TIDY_TEST_RESOURCE_FILES);
  const file = relative(join(process.cwd(), 'tests'), process.argv[1] ?? '').split(sep).join('/');
  if (!isAbsolute(directory) || !Array.isArray(selected)) throw new Error('Invalid test resource context');
  if (selected.includes(file)) {
    const destination = join(directory, `${process.pid}.json`);
    const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    const snapshot = (complete = false, exitCode = null) => {
      const usage = process.resourceUsage();
      writeReport(destination, {
        schema: 1, file, pid: process.pid,
        scope: 'worker-process-lifetime-excluding-descendants',
        memoryMethod: 'node-resourceUsage-maxRSS',
        cpuMethod: 'node-resourceUsage-microseconds-converted-to-ms',
        collectionIntervalMs: resourceIntervalMs,
        startedAt, observedAt: new Date().toISOString(),
        finishedAt: complete ? new Date().toISOString() : null,
        elapsedMs: process.uptime() * 1000,
        memoryPeakBytes: usage.maxRSS > 0 ? usage.maxRSS * 1024 : null,
        unavailable: usage.maxRSS > 0 ? [] : ['memoryPeakBytes'],
        userCpuMs: usage.userCPUTime / 1000,
        systemCpuMs: usage.systemCPUTime / 1000,
        complete, exitCode,
      });
    };
    snapshot();
    const timer = setInterval(snapshot, resourceIntervalMs);
    timer.unref();
    process.once('exit', code => { clearInterval(timer); snapshot(true, code); });
  }
}
