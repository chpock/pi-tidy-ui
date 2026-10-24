import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runFeature } from '../../scripts/test/feature.mjs';
import { execute } from '../../scripts/test/run.mjs';

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function readJsonl(path) { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

test('regular runner report includes measured per-test progress from the actual child process', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readInputs } = await import('../../scripts/test/context.mjs');
  const root = mkdtempSync(join(tmpdir(), 'runner-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = readInputs(), output = join(root, 'report.json');
  const report = await execute({ inputs: inputs.inputsPath, suite: 'unit', files: 'harness/progress-reporter.test.mjs', output });
  assert.equal(report.status, 'passed');
  assert.equal(report.steps.length, 1);
  assert.ok(report.steps[0].elapsedMs > 0);
  assert.equal(report.cases.filter(item => item.kind === 'test').length, 6);
  assert.ok(report.slowestTests.some(item => item.name === 'actual Node test runner writes one progress record when each test starts and completes' && item.durationMs > 0));
  const events = readJsonl(join(root, 'report.tests.jsonl'));
  assert.equal(events.filter(event => event.event === 'test-start' && event.kind === 'test').length, 6);
  assert.equal(events.filter(event => event.event === 'test-complete' && event.kind === 'test').length, 6);
  assert.equal(events.filter(event => event.event === 'test-complete' && event.kind === 'suite').length, 1);
});

test('feature report is atomically current during each stage and retains stage durations/progress links', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readInputs } = await import('../../scripts/test/context.mjs');
  const root = mkdtempSync(join(tmpdir(), 'feature-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputPath = readInputs().inputsPath;
  const output = join(root, 'feature');
  const report = await runFeature({ inputs: inputPath, features: 'footer', output }, async options => {
    const current = readJson(join(output, 'report.json'));
    assert.equal(current.status, 'running');
    assert.equal(current.currentStage, options.suite === 'check' ? 'types' : options.files?.includes('cli/') ? 'cli' : 'node');
    assert.ok(current.stages.at(-1).startedAt);
    assert.equal(current.stages.at(-1).status, 'running');
    return { status: 'passed', counts: { pass: 1, fail: 0, skipped: 0 }, selected: options.files?.split(',') ?? [] };
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.currentStage, null);
  assert.deepEqual(report.stages.map(stage => stage.name), ['types', 'node', 'cli']);
  assert.ok(report.stages.every(stage => stage.status === 'passed' && stage.elapsedMs >= 0));
  assert.equal(report.stages[1].progress.events, 'node.progress.jsonl');
  assert.equal(report.stages[1].progress.tests, 'node.tests.jsonl');
  const events = readJsonl(join(output, 'progress.jsonl'));
  assert.deepEqual(events.filter(event => event.event === 'stage-started').map(event => event.stage), ['types', 'node', 'cli']);
  assert.deepEqual(events.filter(event => event.event === 'stage-complete').map(event => event.status), ['passed', 'passed', 'passed']);
});

test('feature report preserves active stage and writes a durable failure record when a stage runner throws', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readInputs } = await import('../../scripts/test/context.mjs');
  const root = mkdtempSync(join(tmpdir(), 'feature-progress-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputPath = readInputs().inputsPath, output = join(root, 'feature');
  await assert.rejects(runFeature({ inputs: inputPath, features: 'footer', output }, async () => { throw new Error('private runner failure'); }), /private runner failure/);
  const report = readJson(join(output, 'report.json'));
  assert.equal(report.status, 'harness-failed');
  assert.equal(report.currentStage, null);
  assert.equal(report.stages[0].name, 'types');
  assert.equal(report.stages[0].status, 'harness-failed');
  assert.equal(report.stages[0].reason, 'runner-exception');
  assert.doesNotMatch(JSON.stringify(report), /private runner failure/);
  const events = readJsonl(join(output, 'progress.jsonl'));
  assert.deepEqual(events.filter(event => event.event === 'stage-complete').map(event => event.status), ['harness-failed']);
});
