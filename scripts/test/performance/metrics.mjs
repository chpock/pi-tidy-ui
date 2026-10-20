import * as v8 from 'node:v8';
import { setImmediate as yieldTurn } from 'node:timers/promises';

const phases = new WeakMap();
const profiles = new WeakMap();
let activePhase = false;
let activeProfile = false;
const available = method => ({ status: 'available', method });
const unavailable = (method, reason) => ({ status: 'unavailable', method, reason });

export function capabilities() {
  return {
    runtime: { node: process.version, v8: process.versions.v8 },
    elapsed: available('process.hrtime.bigint'),
    cpu: available('process.cpuUsage'),
    memory: available('process.memoryUsage/process.resourceUsage'),
    allocatedBytes: Number.isSafeInteger(v8.getHeapStatistics().total_allocated_bytes)
      ? available('v8.getHeapStatistics.total_allocated_bytes:main-isolate-cumulative')
      : unavailable('v8.getHeapStatistics.total_allocated_bytes:main-isolate-cumulative', 'Runtime does not expose an exact allocation counter'),
    gc: typeof v8.GCProfiler === 'function' ? available('v8.GCProfiler') : unavailable('v8.GCProfiler', 'Runtime has no GCProfiler'),
    afterGC: typeof globalThis.gc === 'function' ? available('global.gc') : unavailable('global.gc', 'Requires --expose-gc'),
    allocationProfile: typeof v8.startHeapProfile === 'function' ? available('v8.startHeapProfile:sampled') : unavailable('v8.startHeapProfile:sampled', 'Runtime has no direct heap sampling API'),
  };
}

function nonnegative(value, name, integer = false) {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new TypeError(`${name} must be a nonnegative ${integer ? 'safe integer' : 'finite number'}`);
  return value;
}

function memorySnapshot() {
  const { heapUsed, heapTotal, external, arrayBuffers, rss } = process.memoryUsage();
  return { heapUsed, heapTotal, external, arrayBuffers, rss, maxRssKiB: process.resourceUsage().maxRSS };
}

function allocationCounter() {
  const value = v8.getHeapStatistics().total_allocated_bytes;
  return Number.isSafeInteger(value) ? value : null;
}

export function beginPhase({ gcProfile = false } = {}) {
  if (typeof gcProfile !== 'boolean') throw new TypeError('gcProfile must be boolean');
  if (activePhase) throw new Error('A phase is already active; overlapping phase attribution is unsupported');
  if (gcProfile && typeof v8.GCProfiler !== 'function') throw new Error('GC profiling unavailable');
  const profiler = gcProfile ? new v8.GCProfiler() : null;
  const before = memorySnapshot();
  profiler?.start();
  const token = Object.freeze({});
  const allocated = allocationCounter();
  const cpu = process.cpuUsage();
  const start = process.hrtime.bigint();
  phases.set(token, { before, profiler, allocated, cpu, start });
  activePhase = true;
  return token;
}

export function endPhase(token, { operations, counts = {} } = {}) {
  const state = phases.get(token);
  if (!state) throw new Error('Unknown or already ended phase token');
  const end = process.hrtime.bigint();
  const cpu = process.cpuUsage(state.cpu);
  const allocated = allocationCounter();
  phases.delete(token);
  activePhase = false;
  // Stop instrumentation even if the caller supplied an invalid work receipt.
  const rawGC = state.profiler?.stop();
  const after = memorySnapshot();
  nonnegative(operations, 'operations', true);
  if (!counts || Object.getPrototypeOf(counts) !== Object.prototype || Object.getOwnPropertySymbols(counts).length) throw new TypeError('counts must be a plain numeric record');
  const copiedCounts = Object.fromEntries(Object.keys(counts).sort().map(key => [key, nonnegative(counts[key], `counts.${key}`, true)]));
  let gc = null;
  if (rawGC) {
    const types = {};
    let durationMs = 0;
    for (const entry of rawGC.statistics) {
      const costMs = nonnegative(entry.cost / 1000, 'GC durationMs');
      const type = types[entry.gcType] ?? { count: 0, durationMs: 0 };
      type.count++; type.durationMs += costMs;
      Object.defineProperty(types, entry.gcType, { value: type, enumerable: true, configurable: true, writable: true });
      durationMs += costMs;
    }
    gc = { status: 'available', method: 'v8.GCProfiler', count: rawGC.statistics.length, durationMs,
      types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => a.localeCompare(b))) };
  }
  return { operations, counts: copiedCounts, metrics: {
    elapsedMs: nonnegative(Number(end - state.start) / 1e6, 'elapsedMs'),
    cpuUserMs: nonnegative(cpu.user / 1000, 'cpuUserMs'),
    cpuSystemMs: nonnegative(cpu.system / 1000, 'cpuSystemMs'),
    allocatedBytes: state.allocated === null || allocated === null ? null : nonnegative(allocated - state.allocated, 'allocatedBytes'),
  }, memory: { before: state.before, after }, gc };
}

export async function afterGC({ turns = 3 } = {}) {
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 100) throw new TypeError('turns must be an integer from 1 to 100');
  if (activePhase) throw new Error('Forced GC is not allowed inside a timed phase');
  if (typeof globalThis.gc !== 'function') throw new Error('Required GC unavailable; launch with --expose-gc');
  for (let i = 0; i < turns; i++) {
    await yieldTurn();
    if (activePhase) throw new Error('A timed phase began during afterGC');
    globalThis.gc();
  }
  await yieldTurn();
  return memorySnapshot();
}

export function startAllocationProfile({ sampleInterval = 524288, stackDepth = 16 } = {}) {
  if (typeof v8.startHeapProfile !== 'function') throw new Error('Required allocation sampling unavailable on this runtime');
  if (activeProfile) throw new Error('An allocation profile is already active');
  if (activePhase) throw new Error('Start allocation profiling outside timed phases');
  nonnegative(sampleInterval, 'sampleInterval', true);
  nonnegative(stackDepth, 'stackDepth', true);
  if (!sampleInterval || !stackDepth) throw new TypeError('sampleInterval and stackDepth must be positive');
  const options = { sampleInterval, stackDepth, forceGC: false, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
  const handle = v8.startHeapProfile(options);
  const token = Object.freeze({});
  profiles.set(token, { handle, options });
  activeProfile = true;
  return token;
}

export function stopAllocationProfile(token) {
  const state = profiles.get(token);
  if (!state) throw new Error('Unknown or already stopped allocation profile token');
  if (activePhase) throw new Error('Stop allocation profiling outside timed phases');
  profiles.delete(token);
  activeProfile = false;
  const profile = JSON.parse(state.handle.stop());
  return { status: 'available', method: 'v8.startHeapProfile:sampled', estimate: true, options: { ...state.options }, profile };
}

// Sum self sizes only. Inclusive parent weights and sample counts are not allocations/calls/frames.
export function summarizeAllocationProfile(profile) {
  if (!profile || !profile.head || !Array.isArray(profile.samples)) throw new TypeError('Invalid sampled allocation profile');
  const frames = new Map();
  let selfBytes = 0, sampleBytes = 0;
  const visit = node => {
    nonnegative(node.selfSize, 'profile.selfSize');
    if (!node.callFrame || !Array.isArray(node.children)) throw new TypeError('Invalid sampled allocation node');
    const { functionName, scriptId, url, lineNumber, columnNumber } = node.callFrame;
    if (![functionName, url].every(value => typeof value === 'string') || !(typeof scriptId === 'string' || Number.isSafeInteger(scriptId)) || ![lineNumber, columnNumber].every(Number.isInteger)) throw new TypeError('Invalid sampled allocation frame');
    const frame = { functionName, scriptId: String(scriptId), url, lineNumber, columnNumber };
    const key = JSON.stringify(frame);
    const existing = frames.get(key) ?? { frame, selfBytes: 0 };
    existing.selfBytes += node.selfSize;
    frames.set(key, existing);
    selfBytes += node.selfSize;
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  for (const sample of profile.samples) sampleBytes += nonnegative(sample.size, 'profile.sample.size');
  nonnegative(selfBytes, 'profile self total'); nonnegative(sampleBytes, 'profile sample total');
  return { estimate: true, selfBytes, sampleBytes, frames: [...frames.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, frame]) => frame) };
}
