import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readInputs, childEnv } from '../../../scripts/test/context.mjs';
import { workload } from '../../../scripts/test/performance/workloads.mjs';

for (const variant of ['native', 'off', 'on']) test(`performance SDK driver: tiny ${variant} workload establishes actual readiness and bounded work`, () => {
  const inputs = readInputs(), directory = mkdtempSync(join(inputs.runRoot, 'performance-sdk-contract-'));
  const output = join(directory, 'target.json'), config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ scenario: workload('render', variant, { cards: 4, iterations: 2, warmup: 1 }) }));
  try {
    const child = spawnSync(inputs.node.path, ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
      join(inputs.pi.root, 'tests/fixtures/performance-sdk.mjs')], { cwd: inputs.pi.root,
      env: childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_PERF_CONFIG: config, TIDY_TEST_PERF_RESULT: output }, inputs),
      encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).failure?.message : child.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(result.phases.map(value => value.id), ['cold-build-layout', 'prepare-to-ready', 'warmup', 'noop-envelope', 'warm-layout']);
    const warm = result.phases.find(value => value.id === 'warm-layout');
    assert.equal(warm.operations, 2); assert.equal(warm.counts.draws, 2); assert.equal(warm.counts.builds ?? 0, 0);
    assert.equal(result.phases.find(value => value.id === 'noop-envelope').counts.draws, 0);
    assert.equal(result.capabilities.afterGC.status, 'available');
    assert.equal(result.allocationProfile, null);
    assert.equal(result.target.node, process.version);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [id, variant, iterations = 2] of [['stream', 'native', 110], ['stream', 'off', 110], ['lifetime', 'native'], ['lifetime', 'off'], ['lifetime', 'on'], ['arguments', 'on'], ['layout', 'on'], ['activity', 'native'], ['queued', 'on'], ['observer', 'native']])
  test(`performance SDK actions: ${id}/${variant} preserve their declared variant and complete real work`, () => {
    const inputs = readInputs(), directory = mkdtempSync(join(inputs.runRoot, 'performance-action-contract-'));
    const output = join(directory, 'target.json'), config = join(directory, 'config.json'), scenario = workload(id, variant, { cards: 4, iterations, warmup: 1, idleMs: 100 });
    writeFileSync(config, JSON.stringify({ scenario, repetition: id === 'observer' ? 1 : 0 }));
    try {
      const child = spawnSync(inputs.node.path, ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
        join(inputs.pi.root, `tests/fixtures/performance-${scenario.entry ?? scenario.driver}.mjs`)], { cwd: inputs.pi.root,
        env: childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_PERF_CONFIG: config, TIDY_TEST_PERF_RESULT: output }, inputs),
        encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });
      assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).failure?.message : child.stderr);
      const result = JSON.parse(readFileSync(output, 'utf8')); assert.equal(result.outcome, 'passed', result.failure?.message);
      if (id === 'lifetime') {
        const cycle = result.phases.find(phase => phase.id === 'adapter-reset-cycles');
        assert.equal(cycle.operations, variant === 'native' ? 0 : 2);
        assert.equal(cycle.counts.adapterActivePaints, variant === 'on' ? 2 : 0);
        assert.equal(cycle.counts.adapterDisabledPaints, variant === 'off' ? 2 : 0);
      }
      if (id === 'observer') {
        assert.equal(result.phases.length, 2);
        assert.deepEqual(result.calibration.order, ['on', 'off'], 'actual calibration order alternates, but phase identity stays stable');
        assert.deepEqual(result.phases.map(phase => phase.id), ['light-observer-off', 'light-observer-on']);
        for (const phase of result.phases) assert.equal(phase.counts.sdkRenderPasses, 200);
      } else assert.equal(result.integrity.resultFieldsExact, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

for (const corruption of ['args', 'details']) test(`performance SDK corruption detector: in-place ${corruption} mutation after handoff must fail`, () => {
  const inputs = readInputs(), directory = mkdtempSync(join(inputs.runRoot, 'performance-handoff-contract-'));
  const output = join(directory, 'target.json'), config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ scenario: workload('render', 'native', { cards: 4, iterations: 2, warmup: 1 }) }));
  const component = pathToFileURL(join(inputs.pi.root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js')).href;
  const shim = `const {ToolExecutionComponent: C} = await import(${JSON.stringify(component)}); const original=C.prototype.render;
    C.prototype.render=function(...args){ if(this.toolCallId?.endsWith('-0')) {
      const target=${JSON.stringify(corruption)}==='args'?this.args:this.result?.details;
      if(target) target.__benchmark_corruption__=1;
    } return Reflect.apply(original,this,args); };`;
  try {
    const child = spawnSync(inputs.node.path, ['--expose-gc', '--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
      '--import', `data:text/javascript,${encodeURIComponent(shim)}`, join(inputs.pi.root, 'tests/fixtures/performance-sdk.mjs')], { cwd: inputs.pi.root,
      env: childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1', TIDY_TEST_PERF_CONFIG: config, TIDY_TEST_PERF_RESULT: output }, inputs),
      encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 1, 'corrupted workload must fail even when all rendering markers survive');
    const result = JSON.parse(readFileSync(output, 'utf8')); assert.equal(result.outcome, 'failed');
    assert.match(result.failure.message, corruption === 'args' ? /arguments preserved exactly/ : /details preserved exactly/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
