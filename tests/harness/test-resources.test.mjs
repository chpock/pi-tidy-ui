import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { focusedRerun, readWorkerResources, scopeResources, summarizeWorkerResources } from '../../scripts/test/resources.mjs';
import { readProgressEvents, summarizeTestEvents } from '../../scripts/test/progress.mjs';

const hook = fileURLToPath(new URL('../../scripts/test/resource-worker.mjs', import.meta.url));
const reporter = fileURLToPath(new URL('../../scripts/test/progress-reporter.mjs', import.meta.url));

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-resources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, { jobs = 2, count = 4, fail = false, kill = false } = {}) {
  const root = temporary(t), directory = join(root, 'resources'), gates = join(root, 'gates');
  mkdirSync(directory); mkdirSync(gates);
  mkdirSync(join(root, 'tests/product'), { recursive: true });
  const selected = Array.from({ length: count }, (_, index) => `product/worker-${index}.test.mjs`);
  for (const [index, file] of selected.entries()) {
    writeFileSync(join(root, 'tests', file), `
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
test('worker ${index}', {timeout: 10000}, async () => {
  writeFileSync(${JSON.stringify(join(gates, `started-${index}`))}, 'started');
  while (!existsSync(${JSON.stringify(join(gates, 'release'))})) await delay(10);
  const bytes = Buffer.alloc(${index === count - 1 ? '32 * 1024 * 1024' : '1024'}, 127);
  assert.equal(bytes[0], 127);
  ${index === count - 1 ? 'await delay(150);' : ''}
  ${kill && index === 0 ? "process.kill(process.pid, 'SIGKILL');" : ''}
  ${fail && index === 0 ? "assert.equal(1, 2, 'controlled primitive failure');" : ''}
});
`);
  }
  const env = { ...process.env, TIDY_TEST_RESOURCE_DIR: directory, TIDY_TEST_RESOURCE_FILES: JSON.stringify(selected) };
  delete env.NODE_TEST_CONTEXT;
  const progress = join(root, 'tests.jsonl');
  const child = spawn(process.execPath, ['--import', hook, '--test', `--test-concurrency=${jobs}`,
    '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, `--test-reporter-destination=${progress}`,
    ...selected.map(file => join(root, 'tests', file))], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let stdout = '', stderr = '', closed = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const completion = once(child, 'close');
  child.once('close', () => { closed = true; });
  t.after(async () => {
    if (!closed) {
      if (process.platform === 'win32') child.kill();
      else try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await completion;
    }
  });
  const deadline = Date.now() + 15_000;
  const admitted = Math.min(jobs, count);
  while (readdirSync(gates).length < admitted) {
    assert.equal(closed, false, stderr.slice(-1000));
    assert.ok(Date.now() < deadline, 'bounded workers must reach their independent start gates');
    await delay(10);
  }
  assert.equal(readdirSync(gates).length, admitted, 'the scheduler may start no more than jobs blocked files');
  writeFileSync(join(gates, 'release'), 'release');
  const [code] = await completion;
  const records = readWorkerResources(directory, selected);
  return { code, records, summary: summarizeWorkerResources(records), tests: summarizeTestEvents(readProgressEvents(progress).events), selected, stdout, stderr, directory };
}

test('actual Node file jobs overlap bounded workers and retain every attributed memory/CPU result', async t => {
  const result = await fixture(t);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.records.length, 4);
  assert.equal(result.summary.maxObservedFileWorkers, 2);
  assert.equal(new Set(result.records.map(item => item.file)).size, 4);
  assert.ok(result.records.every(item => item.complete && item.elapsedMs > 0 && item.memoryPeakBytes > 0));
  assert.ok(result.records.every(item => item.userCpuMs >= 0 && item.systemCpuMs >= 0));
  assert.ok(result.records.some(item => item.userCpuMs > 0), 'actual worker CPU cannot be replaced with all-zero measurements');
  const large = result.records.find(item => item.file === 'product/worker-3.test.mjs');
  const otherPeak = Math.max(...result.records.filter(item => item !== large).map(item => item.memoryPeakBytes));
  assert.ok(large.memoryPeakBytes > otherPeak + 16 * 1024 * 1024, 'the touched allocation must change attributed RAM, not merely exceed ordinary startup RSS');
  assert.equal(result.summary.largestWorkers[0].file, large.file);
  assert.equal(result.tests.slowestTests[0].name, 'worker 3');
  assert.ok(result.tests.slowestTests[0].durationMs >= 100, 'the deliberate slow case must be identifiable in actual timing results');
  assert.equal(large.scope, 'worker-process-lifetime-excluding-descendants');
  assert.equal(large.memoryMethod, 'node-resourceUsage-maxRSS');
  assert.ok(result.summary.largestWorkers.some(item => item.file === large.file));
});

test('jobs=1 gives genuinely serial file lifetimes without losing files', async t => {
  const result = await fixture(t, { jobs: 1, count: 3 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.summary.maxObservedFileWorkers, 1);
  assert.equal(result.records.filter(item => item.complete).length, 3);
});

test('a failed worker does not hide parallel successful workers or their metrics', async t => {
  const result = await fixture(t, { fail: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.records.length, 4);
  assert.ok(result.records.every(item => item.complete));
  assert.equal(result.records.filter(item => item.exitCode !== 0).length, 1);
  assert.equal(result.records.find(item => item.exitCode !== 0).file, 'product/worker-0.test.mjs');
});

test('an abruptly killed worker retains a partial observation, never a fabricated final peak', { skip: process.platform === 'win32' }, async t => {
  const result = await fixture(t, { kill: true });
  assert.notEqual(result.code, 0);
  const killed = result.records.find(item => item.file === 'product/worker-0.test.mjs');
  assert.equal(killed.complete, false);
  assert.equal(killed.unavailableReason, 'worker-exit-record-unavailable');
  assert.ok(killed.observedAt);
  assert.equal(result.records.filter(item => item.complete).length, 3);
});

test('missing workers are unavailable rather than zero, and malformed records fail reporting', t => {
  const root = temporary(t);
  const records = readWorkerResources(root, ['product/missing.test.mjs']);
  assert.equal(records.length, 1);
  assert.equal(records[0].memoryPeakBytes, null);
  assert.equal(records[0].unavailableReason, 'worker-not-observed');
  writeFileSync(join(root, '123.json'), '{broken');
  assert.throws(() => readWorkerResources(root, ['product/missing.test.mjs']), /resource record/);
});

test('summary never sums lifetime peaks and distinguishes incomplete worker intervals', () => {
  const records = [
    { file: 'a.test.mjs', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:02.000Z', complete: true, memoryPeakBytes: 40, elapsedMs: 2000 },
    { file: 'b.test.mjs', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:03.000Z', complete: true, memoryPeakBytes: 50, elapsedMs: 2000 },
  ];
  const summary = summarizeWorkerResources(records);
  assert.equal(summary.maxObservedFileWorkers, 2);
  assert.equal(summary.largestWorkers[0].file, 'b.test.mjs');
  assert.equal(summary.intervalsComplete, true);
  assert.equal('aggregateMemoryPeakBytes' in summary, false, 'independent lifetime peaks do not establish a tree peak');
});

test('diagnostic rerun keeps prepared runtime and explicit filters but uses one file worker', () => {
  assert.deepEqual(focusedRerun('/node', '/inputs.json', 'product/a.test.mjs', { pattern: '^chosen$', skip: 'excluded', networkIsolated: true }),
    ['/node', 'scripts/test/run.mjs', '--inputs', '/inputs.json', '--suite', 'groups', '--files', 'product/a.test.mjs', '--jobs', '1', '--pattern', '^chosen$', '--skip', 'excluded', '--network-isolated']);
});

test('actual dedicated Linux scope reports kernel CPU counters without rejecting field extensions', () => {
  const observed = scopeResources();
  if (process.platform !== 'linux') {
    assert.equal(observed.available, false);
    assert.equal(observed.reason, 'requires-linux-test-scope');
    return;
  }
  const membership = readFileSync('/proc/self/cgroup', 'utf8').trim();
  if (!/tidy-ui-(?:test|perf)-[a-f\d]+\.scope$/.test(membership)) {
    assert.equal(observed.available, false);
    assert.equal(observed.reason, 'no-dedicated-test-scope');
    return;
  }
  assert.equal(observed.available, true, 'the verified current test scope must not become unavailable because of a kernel counter name');
  assert.equal(observed.memoryPeakBytes > 0, true);
  assert.equal(Number.isFinite(observed.cpu.usage_usec), true);
  assert.equal(observed.cpu.usage_usec > 0, true);
  assert.equal(observed.scope, 'containment-scope-lifetime-not-exclusive-to-this-run-or-stage');
});
