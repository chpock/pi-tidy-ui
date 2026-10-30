import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { workload } from '../../../../scripts/test/performance/workloads.mjs';

test('performance source-stream: actual helper publishes STYLE before readiness', { timeout: 50_000 }, () => {
  const inputs = readInputs();
  validateNative(inputs);
  const directory = mkdtempSync(join(inputs.runRoot, 'performance-source-stream-contract-'));
  const output = join(directory, 'target.json'), config = join(directory, 'config.json');
  const scenario = workload('source-stream', 'on', { cards: 4, iterations: 2, warmup: 1, unicode: false });
  writeFileSync(config, JSON.stringify({ scenario }));
  try {
    const child = spawnSync(inputs.node.path, ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
      join(inputs.pi.root, 'tests/fixtures/performance-source.mjs')], { cwd: inputs.pi.root,
      env: childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_PERF_CONFIG: config, TIDY_TEST_PERF_RESULT: output }, inputs),
      encoding: 'utf8', timeout: 40_000, maxBuffer: 128 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).failure?.message : child.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.outcome, 'passed');
    assert.equal(result.workloadCapabilities.nativeSourceStreaming, 'actual-owned-helper');
    assert.deepEqual(result.phases.map(phase => phase.id), ['owned-startup-and-history', 'source-append', 'equal-text-finalize', 'unchanged-source']);
    const initial = result.phases[0];
    assert.equal(initial.operations, scenario.parameters.cards);
    assert.ok(initial.counts.dispatches >= scenario.parameters.cards, 'each source reaches the native helper');
    assert.ok(initial.counts.styleDispatches > 0, 'readiness includes actual STYLE work');
    assert.ok(initial.counts.styleEncodes > 0, 'generic rules are encoded for the native STYLE request');
    assert.equal(result.phases.find(phase => phase.id === 'source-append').counts.committedLineCalls, scenario.parameters.iterations);
    assert.equal(result.phases.find(phase => phase.id === 'equal-text-finalize').counts.committedLineCalls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
