import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import progressReporter from '../../scripts/test/progress-reporter.mjs';
import { readProgressEvents, summarizeTestEvents, workspaceRelativeTestFile } from '../../scripts/test/progress.mjs';

const reporterPath = fileURLToPath(new URL('../../scripts/test/progress-reporter.mjs', import.meta.url));

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function* from(items) { yield* items; }

async function collect(iterable) {
  const events = [];
  for await (const line of iterable) events.push(JSON.parse(line));
  return events;
}

test('Node reporter records test start/completion and measured duration without leaking external paths or error text', async () => {
  const file = `${process.cwd()}/tests/unit/example.test.mjs`;
  const events = await collect(progressReporter(from([
    { type: 'test:dequeue', data: { file, name: 'known slow test', line: 12, column: 3, nesting: 0, testNumber: 4, testId: 'stable-id', type: 'test' } },
    { type: 'test:complete', data: { file, name: 'known slow test', line: 12, column: 3, nesting: 0, testNumber: 4, testId: 'stable-id', type: 'test', details: { duration_ms: 12.5, error: new Error('private test message') } } },
    { type: 'test:complete', data: { file: '/outside/private.test.mjs', name: `skipped\n${'x'.repeat(300)}`, type: 'test', skip: 'not applicable', details: { duration_ms: 0 } } },
  ])));
  assert.deepEqual(events.map(event => event.event), ['test-start', 'test-complete', 'test-complete']);
  assert.equal(events[0].file, 'tests/unit/example.test.mjs');
  assert.equal(events[0].line, 12);
  assert.equal(events[1].durationMs, 12.5);
  assert.equal(events[1].status, 'failed');
  assert.equal(events[2].file, 'external/private.test.mjs');
  assert.equal(events[2].status, 'skipped');
  assert.ok(events[2].name.length <= 240);
  assert.doesNotMatch(events[2].name, /[\r\n]/);
  assert.doesNotMatch(JSON.stringify(events), /private test message|\/outside\/private/);
});

test('summary separates slow tests, suites and unfinished cases after interruption', () => {
  const events = [
    { event: 'test-start', key: 'active', name: 'still running', file: 'tests/a.test.mjs', kind: 'test', at: new Date(1_000).toISOString() },
    { event: 'test-start', key: 'slow-suite', name: 'suite', file: 'tests/b.test.mjs', kind: 'suite', at: new Date(1_010).toISOString() },
    { event: 'test-complete', key: 'slow-suite', name: 'suite', file: 'tests/b.test.mjs', kind: 'suite', at: new Date(2_010).toISOString(), status: 'passed', durationMs: 900 },
    { event: 'test-start', key: 'fast', name: 'fast', file: 'tests/a.test.mjs', kind: 'test', at: new Date(2_000).toISOString() },
    { event: 'test-complete', key: 'fast', name: 'fast', file: 'tests/a.test.mjs', kind: 'test', at: new Date(2_020).toISOString(), status: 'passed', durationMs: 20 },
  ];
  const summary = summarizeTestEvents(events, { now: 3_000 });
  assert.deepEqual(summary.slowestTests.map(item => item.name), ['fast']);
  assert.deepEqual(summary.slowestSuites.map(item => item.name), ['suite']);
  assert.deepEqual(summary.activeTests.map(item => [item.name, item.elapsedMs]), [['still running', 2_000]]);
});

test('progress reader preserves complete events and marks a trailing interrupted JSON record', t => {
  const root = temporary(t), path = join(root, 'progress.jsonl');
  writeFileSync(path, '{"event":"stage-start"}\n{"event":"test-start"}\n{"event":"test-complete"');
  const result = readProgressEvents(path);
  assert.deepEqual(result.events.map(event => event.event), ['stage-start', 'test-start']);
  assert.equal(result.truncatedLines, 1);
  writeFileSync(path, '{"event":}\n');
  assert.throws(() => readProgressEvents(path), /Malformed progress record/);
});

test('path normalization keeps project-relative names and bounds outside paths', () => {
  assert.equal(workspaceRelativeTestFile(`${process.cwd()}/tests/a.test.mjs`), 'tests/a.test.mjs');
  assert.equal(workspaceRelativeTestFile('/outside/secret.test.mjs'), 'external/secret.test.mjs');
});

test('actual Node test runner writes one progress record when each test starts and completes', t => {
  const root = temporary(t), testFile = join(root, 'sample.test.mjs'), progress = join(root, 'sample.tests.jsonl');
  writeFileSync(testFile, `import test from 'node:test';\nimport {setTimeout as delay} from 'node:timers/promises';\ntest('fast physical case', () => {});\ntest('measured asynchronous case', async () => { await delay(15); });\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${reporterPath}`, `--test-reporter-destination=${progress}`,
    testFile,
  ], { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# tests 2/);
  const lines = readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.filter(event => event.kind === 'test').map(event => event.event), ['test-start', 'test-complete', 'test-start', 'test-complete']);
  assert.equal(lines.filter(event => event.kind === 'suite').length, 2, 'file-level suites have distinct, privacy-safe records');
  assert.deepEqual(lines.filter(event => event.kind === 'suite').map(event => event.name), ['external/sample.test.mjs', 'external/sample.test.mjs']);
  assert.doesNotMatch(JSON.stringify(lines), /test-progress-.*sample\.test\.mjs/);
  const summary = summarizeTestEvents(lines);
  assert.equal(summary.cases.filter(item => item.kind === 'test').length, 2);
  assert.ok(summary.cases.find(item => item.kind === 'test' && item.name === 'measured asynchronous case').durationMs >= 10);
  assert.equal(summary.activeTests.length, 0);
});


test('forced process termination preserves a started test event for the unfinished case', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t), testFile = join(root, 'held.test.mjs'), progress = join(root, 'held.tests.jsonl');
  writeFileSync(testFile, `import test from 'node:test';\ntest('held process case', async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${reporterPath}`, `--test-reporter-destination=${progress}`, testFile,
  ], { stdio: 'ignore', env, detached: true });
  const killTree = () => {
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let exited = false;
  child.once('exit', () => { exited = true; });
  t.after(async () => {
    killTree();
    if (!exited) await once(child, 'exit');
  });

  const deadline = Date.now() + 10_000;
  let started;
  while (Date.now() < deadline) {
    if (existsSync(progress)) {
      const events = readProgressEvents(progress).events;
      started = events.find(event => event.event === 'test-start' && event.kind === 'test' && event.name === 'held process case');
      if (started) break;
    }
    assert.equal(exited, false, 'child must remain alive until its in-progress test is terminated');
    await delay(10);
  }
  assert.ok(started, 'the reporter should persist the test-start event before the process is killed');
  killTree();
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');

  const events = readProgressEvents(progress).events;
  assert.equal(events.filter(event => event.event === 'test-start' && event.kind === 'test' && event.name === 'held process case').length, 1);
  assert.equal(events.filter(event => event.event === 'test-complete' && event.kind === 'test' && event.name === 'held process case').length, 0);
  assert.deepEqual(summarizeTestEvents(events).activeTests.filter(event => event.kind === 'test').map(event => event.name), ['held process case']);
});
