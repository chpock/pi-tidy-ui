import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities } from '../../../scripts/test/performance/metrics.mjs';
import { validateRun, summarizeRun, compareRuns, renderSummary } from '../../../scripts/test/performance/results.mjs';

const snapshot = heapUsed => ({ heapUsed, heapTotal: 4096, external: 256, arrayBuffers: 128, rss: 8192, maxRssKiB: 64 });
function fixture({ repetitions = 3, allocated = true } = {}) {
  const caps = capabilities();
  caps.allocatedBytes = allocated
    ? { status: 'available', method: 'fixture-exact-isolate-counter' }
    : { status: 'unavailable', method: 'fixture-exact-isolate-counter', reason: 'unsupported runtime' };
  return { schema: 1, environment: { node: 'fixed', piLock: 'fixed', cpu: 'fixed', limits: { memory: 2147483648 } },
    product: { source: { tree: 'before' }, native: null },
    measurement: { contract: 'fixture-v1', workloadHash: 'fixed', collectorHash: 'fixed', gcPolicy: 'none' },
    scenario: { id: 'warm', driver: 'sdk', variant: 'on', parameters: { frames: 4 } }, capabilities: caps,
    repetitions: Array.from({ length: repetitions }, (_, index) => ({ index, outcome: 'passed', phases: [{ id: 'warm', operations: 4, counts: { builds: 0, frames: 4 },
      metrics: { elapsedMs: [8, 10, 12, 14][index % 4], cpuUserMs: 4, cpuSystemMs: 1, allocatedBytes: allocated ? 4096 : null },
      memory: { before: snapshot(1024), after: snapshot(1536) }, gc: null }] })) };
}
const policy = { 'warm.metrics.elapsedMs': { relative: 0.1, absolute: 1 } };
const clone = value => JSON.parse(JSON.stringify(value));

function changed(before, change) {
  const after = clone(before);
  after.product.source.tree = 'after';
  for (const repetition of after.repetitions) change(repetition.phases[0]);
  return after;
}

test('performance results: preserve samples, independent metrics, median/spread and observed denominator', () => {
  const run = fixture(), original = JSON.stringify(run);
  const validated = validateRun(run);
  assert.equal(validated === run, false);
  const summary = summarizeRun(run);
  assert.equal(summary.status, 'passed');
  const elapsed = summary.observations.find(value => value.metric === 'metrics.elapsedMs');
  assert.deepEqual(elapsed.samples, [8, 10, 12]);
  assert.equal(elapsed.median, 10); assert.equal(elapsed.min, 8); assert.equal(elapsed.max, 12); assert.equal(elapsed.spread, 4);
  assert.equal(summary.observations.find(value => value.metric === 'perOperation.elapsedMs').median, 2.5);
  assert.equal(summary.observations.find(value => value.metric === 'memory.delta.heapUsed').median, 512);
  assert.equal(summary.observations.some(value => value.metric === 'memory.delta.maxRssKiB'), false);
  assert.equal(summary.observations.some(value => /totalMemory|inclusive/.test(value.metric)), false);
  assert.equal(JSON.stringify(run), original);
  summary.repetitions[0].phases[0].metrics.elapsedMs = 999;
  assert.equal(run.repetitions[0].phases[0].metrics.elapsedMs, 8);
  assert.match(renderSummary(summarizeRun(run)), /median=10 min=8 max=12 spread=4 n=3/);
});

test('performance results: no default safety promise; explicit relative AND absolute thresholds', () => {
  const before = fixture();
  const after = changed(before, phase => { phase.metrics.elapsedMs += 2; });
  const observed = compareRuns(before, after);
  assert.equal(observed.status, 'observed');
  assert.equal(compareRuns(before, after, { thresholds: policy }).status, 'regression');
  assert.equal(compareRuns(before, after, { thresholds: { 'warm.metrics.elapsedMs': { relative: 0.5, absolute: 1 } } }).status, 'pass');
  assert.equal(compareRuns(before, after, { thresholds: { 'warm.metrics.elapsedMs': { relative: 0.1, absolute: 3 } } }).status, 'pass');
  assert.equal(compareRuns(before, after, { thresholds: { 'warm.metrics.elapsedMs': { relative: 0.1, absolute: 2 } } }).status, 'pass');
  assert.match(renderSummary(observed), /Descriptive deltas only/);
});

test('performance results: injected bounded allocation, retention and work changes stay separate', () => {
  const before = fixture();
  const after = changed(before, phase => {
    phase.metrics.allocatedBytes += 1024;
    phase.memory.after.heapUsed += 256;
    phase.counts.builds += 1;
  });
  const result = compareRuns(before, after, { thresholds: {
    'warm.metrics.allocatedBytes': { relative: 0.1, absolute: 512 },
    'warm.memory.delta.heapUsed': { relative: 0.1, absolute: 128 },
    'warm.counts.builds': { relative: 0, absolute: 0 },
  } });
  assert.equal(result.status, 'regression');
  assert.equal(result.comparisons.find(value => value.key === 'warm.metrics.allocatedBytes').delta, 1024);
  assert.equal(result.comparisons.find(value => value.key === 'warm.memory.delta.heapUsed').delta, 256);
  assert.equal(result.comparisons.find(value => value.key === 'warm.counts.builds').delta, 1);
  assert.equal(result.comparisons.find(value => value.key === 'warm.metrics.elapsedMs').delta, 0);
});

test('performance results: one observation is descriptive, three required for an explicit gate', () => {
  const run = fixture({ repetitions: 1 });
  assert.equal(summarizeRun(run).timingEvidence, 'descriptive-only');
  assert.equal(compareRuns(run, run).status, 'observed');
  assert.equal(compareRuns(run, run, { thresholds: policy }).status, 'inconclusive');
  const repeated = fixture();
  assert.equal(compareRuns(repeated, repeated, { thresholds: { 'warm.metrics.elapsedMs': { relative: 0, absolute: 0, minRepetitions: 4 } } }).status, 'inconclusive');
});

test('performance results: deterministic count policies allow one observation without numeric confidence claims', () => {
  const before = fixture({ repetitions: 1 });
  const after = changed(before, phase => { phase.counts.builds = 1; });
  for (const minRepetitions of [undefined, 1]) {
    const countPolicy = { relative: 0, absolute: 0, ...(minRepetitions === undefined ? {} : { minRepetitions }) };
    const result = compareRuns(before, after, { thresholds: { 'warm.counts.builds': countPolicy } });
    assert.equal(result.status, 'regression');
    assert.deepEqual(result.comparisons.find(value => value.key === 'warm.counts.builds').after.samples, [1]);
  }
  for (const metric of ['metrics.elapsedMs', 'metrics.allocatedBytes', 'memory.delta.heapUsed']) {
    assert.equal(compareRuns(before, after, { thresholds: { [`warm.${metric}`]: { relative: 0, absolute: 0, minRepetitions: 1 } } }).status, 'invalid');
  }
  assert.equal(compareRuns(before, after).status, 'observed');
});

test('performance results: null allocations and zero operations never masquerade as supported zero', () => {
  const run = fixture({ allocated: false });
  const summary = summarizeRun(run);
  const allocations = summary.observations.find(value => value.metric === 'metrics.allocatedBytes');
  assert.equal(allocations.status, 'unavailable'); assert.equal(allocations.median, null);
  assert.deepEqual(allocations.samples, [null, null, null]);
  assert.equal(compareRuns(run, run, { thresholds: { 'warm.metrics.allocatedBytes': { relative: 0, absolute: 0 } } }).status, 'unavailable');
  assert.equal(compareRuns(run, fixture()).status, 'not-comparable');
  for (const repetition of run.repetitions) repetition.phases[0].operations = 0;
  assert.equal(summarizeRun(run).observations.find(value => value.metric === 'perOperation.elapsedMs').status, 'unavailable');
});

test('performance results: zero/negative baselines use finite deltas, not Infinity or reversed tolerance', () => {
  const before = fixture();
  for (const repetition of before.repetitions) { repetition.phases[0].metrics.elapsedMs = 0; repetition.phases[0].memory.after.heapUsed = 512; }
  const after = changed(before, phase => { phase.metrics.elapsedMs = 2; phase.memory.after.heapUsed = 768; });
  const result = compareRuns(before, after, { thresholds: { ...policy, 'warm.memory.delta.heapUsed': { relative: 0.1, absolute: 128 } } });
  assert.equal(result.status, 'regression');
  const elapsed = result.comparisons.find(value => value.key === 'warm.metrics.elapsedMs');
  assert.equal(elapsed.relativeDelta, null); assert.equal(elapsed.zeroBaseline, true);
  const retention = result.comparisons.find(value => value.key === 'warm.memory.delta.heapUsed');
  assert.equal(retention.relativeDelta, 0.5); assert.equal(retention.delta, 256);
  assert.equal(JSON.stringify(result).includes('Infinity'), false);
  const improved = changed(before, phase => { phase.memory.after.heapUsed = 256; });
  assert.equal(compareRuns(before, improved, { thresholds: { 'warm.memory.delta.heapUsed': { relative: 0, absolute: 0 } } }).status, 'pass');
});

test('performance results: product identities may change, environment and measurement must match', () => {
  const before = fixture(), after = clone(before);
  after.product.source.tree = 'after';
  assert.equal(compareRuns(before, after).productChange, 'extension');
  after.product.source.tree = 'before'; after.product.native = { source: 'helper', binary: 'admitted' };
  assert.equal(compareRuns(before, after).productChange, 'helper');
  after.product.source.tree = 'after';
  assert.equal(compareRuns(before, after).productChange, 'both');
  assert.equal(compareRuns(before, after).attribution, 'combined-product-only');
  assert.equal(compareRuns(before, clone(before)).productChange, 'none');
  const mutations = [
    run => { run.environment.node = 'other'; },
    run => { run.environment.limits.memory++; },
    run => { run.measurement.workloadHash = 'other'; },
    run => { run.measurement.collectorHash = 'other'; },
    run => { run.measurement.gcPolicy = 'forced'; },
    run => { run.scenario.variant = 'off'; },
    run => { run.scenario.driver = 'cli'; },
    run => { run.scenario.parameters.frames++; },
    run => { run.capabilities.cpu.method = 'other'; },
  ];
  for (const mutate of mutations) { const different = clone(before); mutate(different); assert.equal(compareRuns(before, different).status, 'not-comparable'); }
  const reordered = { ...before, environment: { limits: before.environment.limits, cpu: 'fixed', piLock: 'fixed', node: 'fixed' } };
  assert.equal(compareRuns(before, reordered).status, 'observed');
});

test('performance results: complete repetition/phase accounting and failure status are mandatory', () => {
  const before = fixture();
  const fewer = fixture({ repetitions: 2 });
  assert.equal(compareRuns(before, fewer).status, 'not-comparable');
  const other = changed(before, phase => { phase.operations++; });
  assert.equal(compareRuns(before, other).status, 'not-comparable');
  const failed = clone(before); failed.repetitions[1] = { index: 1, outcome: 'failed', phases: [], failure: { kind: 'timeout' } };
  assert.equal(summarizeRun(failed).status, 'failed');
  assert.equal(summarizeRun(failed).repetitions.length, 3);
  assert.equal(compareRuns(failed, failed, { thresholds: policy }).status, 'failed');
  assert.equal(compareRuns(before, failed).status, 'failed');
});

test('performance results: JSON boundary rejects invalid, incomplete and conflicting receipts', () => {
  const mutations = [
    run => { run.schema = 2; },
    run => { run.product.native = {}; },
    run => { run.measurement.workloadHash = ''; },
    run => { run.repetitions = []; },
    run => { run.repetitions[1].index = 0; },
    run => { run.repetitions[0].outcome = 'skipped'; },
    run => { run.repetitions[0].failure = { kind: 'unexpected' }; },
    run => { run.repetitions[0].outcome = 'failed'; },
    run => { run.repetitions[0].phases = []; },
    run => { run.repetitions[0].phases[0].metrics.elapsedMs = -1; },
    run => { run.repetitions[0].phases[0].metrics.elapsedMs = Infinity; },
    run => { run.repetitions[0].phases[0].metrics.elapsedMs = NaN; },
    run => { delete run.repetitions[0].phases[0].metrics.cpuUserMs; },
    run => { run.repetitions[0].phases[0].counts.frames = 0.5; },
    run => { run.repetitions[0].phases[0].metrics.allocatedBytes = null; },
    run => { run.capabilities.allocatedBytes.status = 'unavailable'; run.capabilities.allocatedBytes.reason = 'no counter'; },
    run => { run.capabilities.cpu.reason = 'unavailable'; },
    run => { delete run.repetitions[0].phases[0].gc; },
    run => { run.repetitions[0].phases[0].memory.after.maxRssKiB = 0; },
    run => { run.repetitions[1].phases[0].id = 'other'; },
    run => { run.extra = undefined; },
    run => { run.extra = 1n; },
    run => { run.extra = run; },
    run => { run.extra = new Date(); },
    run => { run.extra = Array(2); },
  ];
  for (const mutate of mutations) {
    const invalid = fixture(); mutate(invalid);
    assert.throws(() => validateRun(invalid), TypeError);
    assert.equal(compareRuns(fixture(), invalid).status, 'invalid');
  }
  const valid = fixture();
  for (const thresholds of [{ unknown: { absolute: 0, relative: 0 } }, { 'warm.metrics.elapsedMs': { absolute: -1, relative: 0 } }, { 'warm.metrics.elapsedMs': { absolute: 0 } }, { 'warm.metrics.elapsedMs': { absolute: 0, relative: 0, minRepetitions: 1 } }, { 'warm.counts.builds': { absolute: 0, relative: 0, minRepetitions: 0 } }, { 'warm.metrics.elapsedMs': { absolute: 0, relative: 0, units: 'seconds' } }]) {
    assert.equal(compareRuns(valid, valid, { thresholds }).status, 'invalid');
  }
});

test('performance results: GC totals cannot conflict or fabricate unavailable instrumentation', () => {
  const run = fixture();
  for (const repetition of run.repetitions) repetition.phases[0].gc = { status: 'available', method: run.capabilities.gc.method, count: 1, durationMs: 2, types: { Scavenge: { count: 1, durationMs: 2 } } };
  assert.equal(validateRun(run).repetitions[0].phases[0].gc.count, 1);
  run.repetitions[0].phases[0].gc.count = 2;
  assert.throws(() => validateRun(run), /GC totals/);
});

// Shapes copied from functional-all-cases26/results.json (SDK lifetime) and
// functional-syntax26-final/results.json (CLI retained memory and scope readback).
function retentionFixture() {
  const run = fixture();
  const retained = { heapUsed: 40510128, heapTotal: 72368128, external: 8161155, arrayBuffers: 218563, rss: 180129792, maxRssKiB: 176428 };
  const byKind = () => Object.fromEntries(['summary', 'bash', 'edit', 'write', 'user', 'queued'].map(kind => [kind,
    { retainedBytes: 0, stringBytes: 0, overheadBytes: 0, entries: 0, rows: 0 }]));
  const group = () => ({ retainedBytes: 0, stringBytes: 0, overheadBytes: 0, entries: 0, rows: 0, hits: 0, misses: 0, builds: 0, releases: 0, collected: 0, byKind: byKind() });
  for (const repetition of run.repetitions) {
    repetition.retained = { ...retained };
    repetition.lifecycle = ['owned-ready', 'removed', 'cycled', 'restored'].map(id => ({ id, memory: { ...retained }, accounting: { ordinary: group(), cards: group(), ...group() } }));
    repetition.scope = { schema: 1, outcome: 'passed', peakSemantics: 'whole-scope accounted memory, including launcher and cleanup; not target RSS or phase peak',
      preCleanup: { unavailable: [], memoryPeakBytes: 106733568, memoryEvents: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0, sock_throttled: 0 }, pidsPeak: 11, pidsEvents: { max: 0 } },
      finalLifetime: { unavailable: ['memoryPeakBytes', 'memoryEvents', 'pidsPeak', 'pidsEvents'], memoryPeakBytes: null, memoryEvents: null, pidsPeak: null, pidsEvents: null } };
  }
  return run;
}
const selector = item => `${item.phase}.${item.metric}`;
const observation = (run, key) => summarizeRun(run).observations.find(item => selector(item) === key);

test('performance results: R2 summarizes emitted retained, lifecycle and distinct scope fields', () => {
  const run = retentionFixture(), original = JSON.stringify(run);
  run.repetitions[1].retained.heapUsed += 128;
  run.repetitions[2].retained.heapUsed += 256;
  const retained = observation(run, 'retained.heapUsed');
  assert.equal(typeof retained, 'object');
  assert.deepEqual(retained.samples, [40510128, 40510256, 40510384]);
  assert.equal(retained.median, 40510256); assert.equal(retained.spread, 256);
  assert.equal(retained.unit, 'bytes');
  assert.equal(observation(run, 'retained.maxRssKiB').unit, 'KiB');
  assert.equal(observation(run, 'lifecycle.removed.memory.heapUsed').median, 40510128);
  assert.equal(observation(run, 'lifecycle.removed.accounting.cards.retainedBytes').median, 0);
  assert.equal(observation(run, 'lifecycle.owned-ready.accounting.byKind.bash.entries').unit, 'count');
  assert.equal(observation(run, 'scope.preCleanup.memoryPeakBytes').median, 106733568);
  assert.equal(observation(run, 'scope.preCleanup.pidsPeak').unit, 'count');
  assert.equal(observation(run, 'scope.preCleanup.memoryEvents.oom_kill').median, 0);
  const final = observation(run, 'scope.finalLifetime.memoryPeakBytes');
  assert.equal(final.status, 'unavailable'); assert.equal(final.median, null);
  assert.deepEqual(final.samples, [null, null, null]);
  assert.equal(observation(run, 'scope.finalLifetime.memoryEvents').status, 'unavailable');
  assert.equal(observation(run, 'scope.finalLifetime.pidsEvents').status, 'unavailable');
  assert.equal(observation(run, 'warm.memory.after.heapUsed').median, 1536);
  assert.equal(JSON.stringify(validateRun(retentionFixture())), original);
});

test('performance results: R2 detects injections in actual post-GC/lifecycle/scope fields, not phase heap', () => {
  const before = retentionFixture();
  const changes = [
    ['retained.heapUsed', repetition => { repetition.retained.heapUsed += 4096; }],
    ['lifecycle.removed.memory.heapUsed', repetition => { repetition.lifecycle[1].memory.heapUsed += 4096; }],
    ['lifecycle.restored.accounting.cards.retainedBytes', repetition => { repetition.lifecycle[3].accounting.cards.retainedBytes += 4096; }],
    ['lifecycle.cycled.accounting.ordinary.byKind.bash.entries', repetition => { repetition.lifecycle[2].accounting.ordinary.byKind.bash.entries += 4096; }],
    ['scope.preCleanup.memoryPeakBytes', repetition => { repetition.scope.preCleanup.memoryPeakBytes += 4096; }],
    ['scope.preCleanup.pidsPeak', repetition => { repetition.scope.preCleanup.pidsPeak += 4096; }],
    ['scope.preCleanup.memoryEvents.high', repetition => { repetition.scope.preCleanup.memoryEvents.high += 4096; }],
  ];
  for (const [key, mutate] of changes) {
    const after = clone(before); after.product.source.tree = 'after';
    for (const repetition of after.repetitions) mutate(repetition);
    const result = compareRuns(before, after, { thresholds: { [key]: { absolute: 1, relative: 0 } } });
    assert.equal(result.status, 'regression', key);
    assert.equal(result.comparisons.find(item => item.key === key).delta, 4096);
    assert.equal(result.comparisons.find(item => item.key === 'warm.memory.after.heapUsed').delta, 0);
  }
});

test('performance results: R2 final lifetime peaks are separately supported without peak subtraction', () => {
  const before = retentionFixture();
  for (const repetition of before.repetitions) repetition.scope.finalLifetime = clone(repetition.scope.preCleanup);
  const after = clone(before);
  for (const repetition of after.repetitions) repetition.scope.finalLifetime.memoryPeakBytes += 4096;
  const key = 'scope.finalLifetime.memoryPeakBytes';
  const result = compareRuns(before, after, { thresholds: { [key]: { absolute: 1, relative: 0 } } });
  assert.equal(result.status, 'regression');
  assert.equal(result.comparisons.find(item => item.key === key).delta, 4096);
  assert.equal(result.comparisons.find(item => item.key === 'scope.preCleanup.memoryPeakBytes').delta, 0);
  assert.equal(result.comparisons.some(item => /scope.*delta|retained.*delta|lifecycle.*delta|totalMemory/.test(item.key)), false);
  assert.equal(observation(before, 'retained.external').median, 8161155);
  assert.equal(observation(before, 'retained.arrayBuffers').median, 218563);
});

test('performance results: R2 missing optional fields stay absent; explicit null stays unavailable', () => {
  const absent = fixture();
  assert.equal(Object.hasOwn(validateRun(absent).repetitions[0], 'retained'), false);
  assert.equal(summarizeRun(absent).observations.some(item => ['retained', 'lifecycle', 'scope'].includes(item.phase)), false);
  const run = retentionFixture();
  for (const repetition of run.repetitions) { repetition.retained = null; repetition.lifecycle[1].accounting = null; }
  assert.equal(observation(run, 'retained.rss').status, 'unavailable');
  assert.equal(observation(run, 'lifecycle.removed.accounting').status, 'unavailable');
  for (const key of ['retained.heapUsed', 'lifecycle.removed.accounting', 'scope.finalLifetime.memoryPeakBytes']) {
    assert.equal(compareRuns(run, run, { thresholds: { [key]: { relative: 0, absolute: 0 } } }).status, 'unavailable');
  }
  assert.equal(compareRuns(run, run).status, 'observed');
  assert.match(renderSummary(summarizeRun(run)), /scope.finalLifetime.memoryPeakBytes: unavailable/);
});

test('performance results: R2 mixed availability preserves all samples and cannot produce a green gate', () => {
  const run = retentionFixture();
  run.repetitions[0].scope.finalLifetime = clone(run.repetitions[0].scope.preCleanup);
  const key = 'scope.finalLifetime.memoryPeakBytes';
  const final = observation(run, key);
  assert.deepEqual(final.samples, [106733568, null, null]);
  assert.equal(final.status, 'partial'); assert.equal(final.n, 1); assert.equal(final.median, 106733568);
  assert.equal(compareRuns(run, run, { thresholds: { [key]: { relative: 0, absolute: 0 } } }).status, 'unavailable');
  const available = retentionFixture();
  for (const repetition of available.repetitions) repetition.scope.finalLifetime = clone(repetition.scope.preCleanup);
  assert.equal(compareRuns(available, retentionFixture(), { thresholds: { [key]: { relative: 0, absolute: 0 } } }).status, 'unavailable');
});

test('performance results: R2 optional shape differences are not silently dropped to align comparisons', () => {
  const before = retentionFixture();
  for (const mutate of [
    repetition => { delete repetition.retained; },
    repetition => { delete repetition.lifecycle; },
    repetition => { repetition.lifecycle[0].id = 'another-boundary'; },
    repetition => { delete repetition.lifecycle[0].accounting.cards; },
    repetition => { delete repetition.scope.finalLifetime; },
    repetition => { delete repetition.scope; },
  ]) {
    const after = clone(before); for (const repetition of after.repetitions) mutate(repetition);
    assert.equal(compareRuns(before, after).status, 'not-comparable');
  }
});

test('performance results: R2 validates optional numbers, identities and unavailable readback consistency', () => {
  for (const mutate of [
    run => { run.repetitions[0].retained.heapUsed = -1; },
    run => { delete run.repetitions[0].retained.rss; },
    run => { run.repetitions[0].lifecycle[1].id = 'owned-ready'; },
    run => { run.repetitions[0].lifecycle[1].memory.arrayBuffers = 0.5; },
    run => { run.repetitions[0].lifecycle[1].accounting.cards.entries = -1; },
    run => { run.repetitions[0].lifecycle[1].accounting.cards.hits = 'zero'; },
    run => { run.repetitions[0].scope.preCleanup.memoryPeakBytes = -1; },
    run => { run.repetitions[0].scope.preCleanup.unavailable = ['memoryPeakBytes']; },
    run => { run.repetitions[0].scope.finalLifetime.unavailable = []; },
    run => { run.repetitions[0].scope.preCleanup.memoryEvents.oom = 0.5; },
  ]) {
    const run = retentionFixture(); mutate(run);
    assert.throws(() => validateRun(run), TypeError);
  }
  const inconsistent = retentionFixture(); delete inconsistent.repetitions[1].retained;
  assert.throws(() => validateRun(inconsistent), /structure/);
  const failed = retentionFixture(); failed.repetitions[1].outcome = 'failed'; failed.repetitions[1].failure = { kind: 'timeout' };
  assert.equal(compareRuns(failed, failed).status, 'failed');
});

test('performance results: R2 raw lifecycle counters preserve each sample without weakening driver invariants', () => {
  const run = retentionFixture(); run.repetitions[1].lifecycle[1].accounting.cards.entries = 1;
  const key = 'lifecycle.removed.accounting.cards.entries';
  assert.deepEqual(observation(run, key).samples, [0, 1, 0]);
  assert.equal(compareRuns(run, run, { thresholds: { [key]: { relative: 0, absolute: 0, minRepetitions: 1 } } }).status, 'invalid');
  const one = retentionFixture(); one.repetitions.length = 1;
  assert.equal(compareRuns(one, one, { thresholds: { [key]: { relative: 0, absolute: 0 } } }).status, 'inconclusive');
  for (const repetition of run.repetitions) repetition.lifecycle[1].id = 'counts';
  assert.equal(compareRuns(run, run, { thresholds: { 'lifecycle.counts.accounting.cards.entries': { relative: 0, absolute: 0, minRepetitions: 1 } } }).status, 'invalid');
});

test('performance results: R2 long lifecycle order and partial accounting units survive distributions', () => {
  const run = retentionFixture();
  for (const repetition of run.repetitions) repetition.lifecycle = Array.from({ length: 12 }, (_, index) => ({ ...clone(repetition.lifecycle[0]), id: `boundary-${index}` }));
  run.repetitions[2].lifecycle[0].accounting.cards.retainedBytes = null;
  const retained = observation(run, 'lifecycle.boundary-0.accounting.cards.retainedBytes');
  assert.equal(retained.status, 'partial'); assert.equal(retained.unit, 'bytes');
  assert.deepEqual(retained.samples, [0, 0, null]);
  assert.equal(compareRuns(run, clone(run)).status, 'observed');
});
