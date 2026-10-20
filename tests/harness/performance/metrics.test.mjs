import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as v8 from 'node:v8';
import { capabilities, beginPhase, endPhase, afterGC, startAllocationProfile, stopAllocationProfile, summarizeAllocationProfile } from '../../../scripts/test/performance/metrics.mjs';

const memoryKeys = ['arrayBuffers', 'external', 'heapTotal', 'heapUsed', 'maxRssKiB', 'rss'];

test('performance metrics: capabilities describe exact allocation and direct sampling honestly', () => {
  const value = capabilities();
  assert.equal(JSON.parse(JSON.stringify(value)).runtime.node, process.version);
  assert.equal(value.allocatedBytes.status, Number.isSafeInteger(v8.getHeapStatistics().total_allocated_bytes) ? 'available' : 'unavailable');
  assert.equal(value.allocationProfile.status, typeof v8.startHeapProfile === 'function' ? 'available' : 'unavailable');
  if (value.allocatedBytes.status === 'unavailable') assert.equal(typeof value.allocatedBytes.reason, 'string');
  if (value.allocationProfile.status === 'unavailable') assert.throws(() => startAllocationProfile(), /unavailable/);
});

test('performance metrics: phase work, independent memory fields, timing and single-use tokens', () => {
  const token = beginPhase();
  assert.throws(() => beginPhase(), /already active/);
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum += i;
  const result = endPhase(token, { operations: 10000, counts: { z: 1, a: 2 } });
  assert.equal(sum, 49995000);
  assert.equal(result.operations, 10000);
  assert.deepEqual(Object.keys(result.counts), ['a', 'z']);
  assert.deepEqual(Object.keys(result.memory.before).sort(), memoryKeys);
  assert.deepEqual(Object.keys(result.memory.after).sort(), memoryKeys);
  assert.equal(result.gc, null);
  for (const [key, value] of Object.entries(result.metrics)) {
    if (key === 'allocatedBytes' && capabilities().allocatedBytes.status === 'unavailable') assert.equal(value, null);
    else assert.equal(Number.isFinite(value) && value >= 0, true, key);
  }
  assert.throws(() => endPhase(token, { operations: 1 }), /already ended/);
  assert.throws(() => endPhase({}, { operations: 1 }), /Unknown/);
});

test('performance metrics: invalid work receipts close phases and never become successful zeros', () => {
  for (const options of [{ operations: -1 }, { operations: Infinity }, { operations: 1, counts: { work: -1 } }, { operations: 1, counts: { work: 0.5 } }]) {
    const token = beginPhase({ gcProfile: true });
    assert.throws(() => endPhase(token, options), /nonnegative/);
  }
  assert.equal(endPhase(beginPhase(), { operations: 0 }).operations, 0);
});

test('performance metrics: ordinary phases never force GC; missing requested GC fails explicitly', async () => {
  const original = globalThis.gc;
  let calls = 0;
  try {
    globalThis.gc = () => { calls++; };
    endPhase(beginPhase(), { operations: 0 });
    assert.equal(calls, 0);
    globalThis.gc = undefined;
    assert.equal(capabilities().afterGC.status, 'unavailable');
    await assert.rejects(afterGC(), /Required GC unavailable/);
  } finally { globalThis.gc = original; }
});

test('performance metrics: explicit retention GC is outside timing and exposes small held buffers', async () => {
  const token = beginPhase();
  await assert.rejects(afterGC(), /inside a timed phase/);
  endPhase(token, { operations: 0 });
  await assert.rejects(afterGC({ turns: 0 }), /turns/);
  const before = await afterGC();
  let held = new ArrayBuffer(128 * 1024);
  const after = await afterGC();
  assert.equal(after.arrayBuffers >= before.arrayBuffers + held.byteLength, true);
  held = null;
  const released = await afterGC();
  assert.equal(after.arrayBuffers - released.arrayBuffers >= 128 * 1024, true);
});

test('performance metrics: GC collection is explicit, typed and naturally unforced by phases', () => {
  const token = beginPhase({ gcProfile: true });
  // Deliberate GC here exercises instrumentation, not the ordinary throughput policy.
  globalThis.gc();
  const phase = endPhase(token, { operations: 1 });
  assert.equal(phase.gc.status, 'available');
  assert.equal(phase.gc.count > 0, true);
  assert.equal(Object.values(phase.gc.types).reduce((sum, value) => sum + value.count, 0), phase.gc.count);
  assert.equal(phase.gc.durationMs >= 0, true);
});

test('performance metrics: exact allocator sees a bounded known object workload when available', () => {
  const token = beginPhase();
  const held = Array.from({ length: 4096 }, (_, value) => ({ value, next: value + 1 }));
  const phase = endPhase(token, { operations: held.length });
  assert.equal(held[4095].next, 4096);
  if (capabilities().allocatedBytes.status === 'available') assert.equal(phase.metrics.allocatedBytes >= 4096 * 16, true);
  else assert.equal(phase.metrics.allocatedBytes, null);
});

test('performance metrics: direct sample profile includes collected objects and remains an estimate', () => {
  if (capabilities().allocationProfile.status === 'unavailable') {
    assert.throws(() => startAllocationProfile(), /unavailable/);
    return;
  }
  const token = startAllocationProfile({ sampleInterval: 1024, stackDepth: 8 });
  assert.throws(() => startAllocationProfile(), /already active/);
  const held = Array.from({ length: 4096 }, (_, i) => ({ i }));
  globalThis.gc();
  const result = stopAllocationProfile(token);
  assert.equal(held.length, 4096);
  assert.equal(result.estimate, true);
  assert.equal(result.options.forceGC, false);
  assert.equal(result.options.includeObjectsCollectedByMajorGC, true);
  assert.equal(result.options.includeObjectsCollectedByMinorGC, true);
  const summary = summarizeAllocationProfile(result.profile);
  assert.equal(summary.selfBytes > 0, true);
  assert.equal(summary.sampleBytes > 0, true);
  assert.throws(() => stopAllocationProfile(token), /already stopped/);
});

test('performance metrics: sampling sums self weights once, not inclusive weights or inferred calls', () => {
  const frame = name => ({ functionName: name, scriptId: 1, url: 'fixture.mjs', lineNumber: 0, columnNumber: 0 });
  const profile = { head: { callFrame: frame('parent'), selfSize: 8, children: [
    { callFrame: frame('child'), selfSize: 16, children: [] },
    { callFrame: frame('child'), selfSize: 24, children: [] },
  ] }, samples: [{ size: 8 }, { size: 40 }] };
  const summary = summarizeAllocationProfile(profile);
  assert.equal(summary.selfBytes, 48);
  assert.equal(summary.sampleBytes, 48);
  assert.equal(summary.frames.length, 2);
  assert.equal(summary.frames.find(value => value.frame.functionName === 'child').selfBytes, 40);
  assert.equal(Object.hasOwn(summary, 'calls'), false);
  assert.equal(Object.hasOwn(summary, 'inclusiveBytes'), false);
  profile.head.selfSize = -1;
  assert.throws(() => summarizeAllocationProfile(profile), /nonnegative/);
});
