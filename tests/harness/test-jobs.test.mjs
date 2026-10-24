import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputs } from '../../scripts/test/context.mjs';
import { fileJobs } from '../../scripts/test/run.mjs';
import { runFeature } from '../../scripts/test/feature.mjs';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-jobs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('file jobs admit only explicit positive safe integers and reject fixed-suite pretence', () => {
  for (const jobs of ['1', '2', '4', 3]) assert.equal(fileJobs(jobs, 'unit', ['node']), Number(jobs));
  for (const jobs of ['', '0', '-1', '1.5', '2e1', ' 2', '+2', '02', 'Infinity', '9007199254740992', 0, NaN, true]) {
    assert.throws(() => fileJobs(jobs, 'unit', ['node']), /positive safe integer/);
  }
  for (const suite of ['check', 'rust', 'rust-check', 'rust-allocator', 'consumer', 'published-consumer', 'rust-harness']) {
    assert.throws(() => fileJobs('2', suite, []), /file jobs/);
    assert.equal(fileJobs(undefined, suite, []), null);
  }
  assert.equal(fileJobs(undefined, 'unit', ['node']), 2);
  assert.equal(fileJobs(undefined, 'cli', ['cli']), 2);
  assert.equal(fileJobs(undefined, 'groups', ['cli', 'node']), 2);
});

test('feature jobs reach each ordinary file stage but never type checking or concurrent stage pools', async t => {
  const calls = [], output = temporary(t);
  let active = 0;
  const report = await runFeature({ inputs: readInputs().inputsPath, features: 'footer', jobs: '3', output }, async options => {
    assert.equal(++active, 1, 'only one stage may own a file pool');
    calls.push(options);
    await Promise.resolve();
    active--;
    return { status: 'passed', counts: { pass: 1, skipped: 0 }, selected: options.files?.split(',') ?? [], jobs: options.jobs ? Number(options.jobs) : null };
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(calls.map(item => [item.suite, item.jobs]), [['check', undefined], ['groups', '3'], ['groups', '3']]);
  assert.deepEqual(report.stages.map(item => item.jobs), [null, 3, 3]);
  assert.equal(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')).selection.jobs, '3');
});

test('invalid feature jobs fail before any stage or preparation refresh executes', async t => {
  let invoked = false;
  const output = temporary(t);
  await assert.rejects(runFeature({ inputs: readInputs().inputsPath, features: 'footer', jobs: '0', refresh: true, output }, async () => {
    invoked = true;
  }), /positive safe integer/);
  assert.equal(invoked, false);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'setup-failed');
  assert.equal(report.stages.length, 0);
});
