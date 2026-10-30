// Synthetic benchmark extension; never loaded by normal Pi or ordinary CLI tests.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { beginPhase, endPhase, capabilities, afterGC, startAllocationProfile, stopAllocationProfile, summarizeAllocationProfile } from '../../scripts/test/performance/metrics.mjs';
import { verifyPerformanceTools } from './performance-integrity.mjs';
import { performanceBridge } from './performance-observer.mjs';
import { waitForPerformanceReady } from './performance-readiness.mjs';
import { workload, history } from '../../scripts/test/performance/workloads.mjs';

const noSourceWork = ['dispatches', 'preparedBytes'];
const noRPC = [...noSourceWork, 'styleDispatches', 'styleEncodes'];
const warmWork = [...noRPC, 'layoutBuilds'];
const monotonic = new Set(['nativeRequests', 'forcedRequests', 'nativeCalls', 'rootRenders', 'layoutPasses', 'terminalWrites', 'terminalBytes', 'dispatches', 'preparedBytes', 'decodedBytes', 'staleReplies', 'restarts', 'committedLineCalls', 'committedLineBytes', 'tailCalls', 'tailBytes', 'cleanupRefusals', 'stylePreparations', 'styleContextVisits', 'styleEncodes', 'styleDispatches', 'stylePublications', 'styleRejections', 'layoutBuilds', 'layoutHits', 'layoutMisses', 'layoutReleases']);
function delta(before, after) {
  return Object.fromEntries(Object.keys(after).filter(key => monotonic.has(key) && typeof after[key] === 'number' && typeof before[key] === 'number')
    .map(key => [key, after[key] - before[key]]));
}

export default async function performanceDriver(pi) { return registerPerformanceDriver(pi); }

export async function registerPerformanceDriver(pi, adapter) {
  const config = JSON.parse(readFileSync(process.env.TIDY_TEST_PERF_CONFIG, 'utf8'));
  const scenario = workload(config.scenario.id, config.scenario.variant, config.scenario.parameters);
  if (scenario.hash !== config.scenario.hash || scenario.driver !== 'cli') throw new Error('Invalid native performance workload');
  if (config.preconditionOnly !== undefined && typeof config.preconditionOnly !== 'boolean') throw new Error('Invalid performance precondition mode');
  const preconditionOnly = config.preconditionOnly === true;
  if (preconditionOnly && (scenario.id !== 'frames' || scenario.variant !== 'on')) throw new Error('Readiness precondition is limited to enabled real-Pi frames');
  if (scenario.variant !== 'native' && !adapter || scenario.variant === 'native' && adapter) throw new Error('Wrong performance extension-loader entry for the selected variant');
  const installed = adapter?.(pi, scenario);
  const runtime = () => installed?.runtime(), controller = () => installed?.controller();
  const expectedIds = new Set(history(scenario.parameters).tools.filter(tool => tool.name !== 'read').map(tool => tool.id));
  pi.on('session_shutdown', () => installed?.restore());
  let running = false;
  pi.registerCommand('tidy-perf-run', { description: 'Execute one fixed synthetic performance trial', handler: async (_args, ctx) => {
    if (running) throw new Error('Performance trial already executed');
    running = true;
    const output = join(process.env.TIDY_UI_TEST_OUTPUT, preconditionOnly ? 'precondition.json' : 'performance.json');
    const phases = [], bridge = performanceBridge(); let allocationProfile = null;
    const sourceCounters = () => runtime()?.sources.stats() ?? {};
    const snapshot = () => {
      const presentation = controller(), getStats = presentation && Reflect.get(presentation, 'cacheStats');
      if (presentation) assert.equal(typeof getStats, 'function', 'benchmark presentation cache observation contract');
      const cache = getStats && Reflect.apply(getStats, presentation, []);
      if (cache) for (const key of ['builds', 'hits', 'misses', 'releases']) assert.ok(Number.isSafeInteger(cache[key]), `benchmark layout ${key} counter`);
      return { ...bridge.counts(), ...sourceCounters(), ...(cache ? { layoutBuilds: cache.builds, layoutHits: cache.hits, layoutMisses: cache.misses, layoutReleases: cache.releases } : {}) };
    };
    async function ready(palettePrefix) {
      const settled = await waitForPerformanceReady({ frame: () => bridge.frame(), pause, now: preconditionOnly ? Date.now : () => performance.now(), check: () => {
        if (scenario.variant !== 'on') return true;
        const current = runtime(), stats = current?.sources.stats();
        return current?.snapshot().provider.availability === 'ready' && installed.ready(expectedIds, palettePrefix)
          && stats.unsettledJobs === 0 && stats.pendingCloses === 0;
      } });
      if (settled) return;
      const current = runtime(), states = current && Reflect.get(current.sources, 'states');
      const counters = current?.sources.stats();
      throw new Error(`Benchmark did not reach complete current-source/style readiness: ${JSON.stringify({ runtimeObserved: !!current,
        provider: current?.snapshot().provider.availability ?? null,
        source: counters ? { records: counters.sourceRecords, dispatches: counters.dispatches, styleDispatches: counters.styleDispatches,
          jobs: counters.unsettledJobs, closes: counters.pendingCloses, bookkeepingBytes: counters.bookkeepingBytes,
          retainedBytes: counters.retention.retainedBytes, entries: counters.retention.entries } : null,
        preparation: installed?.diagnostics(expectedIds),
        states: states instanceof Map ? [...states.keys()].slice(0, 8).map(key => ({ key, exact: current.sources.status(key)?.exact, protective: current.sources.status(key)?.protective, basis: !!current.sources.displayBasis(key) })) : null })}`);
    }
    function inspectTools() {
      const nodes = [], pending = [bridge.current.renderer.deref()], seen = new Set();
      while (pending.length) {
        const node = pending.pop(); if (!node || seen.has(node)) continue; seen.add(node);
        if (typeof node.toolCallId === 'string' && typeof node.updateResult === 'function') nodes.push(node);
        if (Array.isArray(node.children)) pending.push(...node.children);
      }
      return verifyPerformanceTools(nodes, history(scenario.parameters).tools, scenario.parameters.width, scenario.variant, 'cli');
    }
    async function measure(id, operations, action, forbidden = []) {
      const before = snapshot(); bridge.observe(true);
      const token = beginPhase({ gcProfile: config.gcProfile === true });
      let ended = false;
      try {
        await action(); ended = true;
        const value = endPhase(token, { operations }); bridge.observe(false);
        value.counts = delta(before, snapshot());
        phases.push({ id, ...value });
        for (const field of forbidden)
          assert.equal(value.counts[field] ?? 0, 0, `${id}: no repeated ${field}`);
        if (id === 'warm-frames') {
          assert.equal(value.counts.nativeCalls, operations, 'one native doRender per requested warm frame');
          assert.ok(value.counts.rootRenders + value.counts.layoutPasses >= operations, 'each warm frame must perform real root rendering or layout, not an early doRender return');
        }
      } catch (error) { if (!ended) endPhase(token, { operations: 0 }); bridge.observe(false); throw error; }
    }
    try {
      if (preconditionOnly) {
        assert.equal(bridge.startupPhase, undefined, 'proof-only preload must not collect a startup phase');
        assert.equal(globalThis[Symbol.for('pi-tidy-ui.performance.startup')], undefined, 'proof-only preload must not start a phase');
        const before = snapshot();
        await ready();
        const after = snapshot(), counters = delta(before, after);
        assert.equal(typeof installed?.paintOriginCount, 'function', 'full-history Pi paint observation contract');
        const paintOriginCount = installed.paintOriginCount(expectedIds, 'pi');
        assert.equal(paintOriginCount, expectedIds.size, 'every expected restored card must use Pi-origin paint');
        assert.ok((counters.nativeCalls ?? 0) >= 3, 'readiness survives three completed native frames');
        assert.ok((counters.rootRenders ?? 0) + (counters.layoutPasses ?? 0) > 0, 'readiness observes actual root/layout work');
        const integrity = inspectTools();
        const result = { outcome: 'passed', preconditionOnly: true, phaseSamples: 0, phases: [], startupPhase: null,
          readiness: { palette: 'pi-origin', cards: expectedIds.size, paintOriginCount, completedFrames: counters.nativeCalls,
            counters }, integrity, source: sourceCounters(), observer: { perFrameReceipts: false, statsInsideTarget: true },
          target: { pid: process.pid, node: process.version, v8: process.versions.v8 }, expectedCards: scenario.parameters.cards };
        writeFileSync(output + '.tmp', JSON.stringify(result)); renameSync(output + '.tmp', output);
        return;
      }
      if (bridge.startupPhase) phases.push(bridge.startupPhase);
      await measure('prepare-to-ready', 1, () => ready());
      const integrity = inspectTools();
      await measure('warmup', scenario.parameters.warmup, () => bridge.frames(scenario.parameters.warmup));
      await measure('noop-envelope', scenario.parameters.iterations, async () => {
        for (let i = 0; i < scenario.parameters.iterations; i++) await new Promise(resolve => setImmediate(resolve));
      }, warmWork);
      await measure('idle-window', 1, () => pause(scenario.parameters.idleMs), warmWork);
      const sampling = config.allocationProfile ? startAllocationProfile() : undefined;
      try { await measure('warm-frames', scenario.parameters.iterations, () => bridge.frames(scenario.parameters.iterations), warmWork); }
      finally { if (sampling) {
        const sampled = stopAllocationProfile(sampling); allocationProfile = { method: sampled.method, estimate: true, options: sampled.options, summary: summarizeAllocationProfile(sampled.profile) };
        writeFileSync(process.env.TIDY_TEST_PERF_PROFILE, JSON.stringify(sampled.profile));
      } }
      assert.ok(phases.find(value => value.id === 'warm-frames').counts.nativeCalls >= scenario.parameters.iterations, 'fixed actions actually completed new native renders');
      if (scenario.id === 'syntax') {
        const current = runtime(); assert.ok(current);
        await measure('new-owned-palette', 1, async () => {
          current.previewTheme({ kind: 'theme', id: 'gruvbox-dark' });
          const selected = current.snapshot().effective; assert.ok(selected);
          await ready(`theme:${selected.id}:${selected.fingerprint}:`);
        });
        await measure('same-source-pi-palette', 1, async () => { current.previewTheme({ kind: 'pi' }); await ready('pi:'); }, noSourceWork);
        await measure('cached-owned-palette-rollback', 1, async () => {
          current.previewTheme({ kind: 'theme', id: 'gruvbox-dark' });
          const selected = current.snapshot().effective; assert.ok(selected);
          await ready(`theme:${selected.id}:${selected.fingerprint}:`);
        }, noRPC);
        await measure('cached-pi-rollback', 1, async () => { current.previewTheme({ kind: 'pi' }); await ready('pi:'); }, noRPC);
        await measure('reselected-pi-palette', 1, async () => { current.previewTheme({ kind: 'pi' }); await bridge.frame(); }, warmWork);
      }
      if (scenario.id === 'status') {
        assert.equal(typeof ctx.ui.setStatus, 'function', 'selected host public extension status contract');
        try {
          await measure('status-only-updates', scenario.parameters.iterations, async () => {
            for (let i = 0; i < scenario.parameters.iterations; i++) { ctx.ui.setStatus('performance-status', `PERF_STATUS_${i}`); await bridge.frame(); }
          }, warmWork);
          assert.ok(phases.at(-1).counts.nativeRequests >= scenario.parameters.iterations, 'status actions reach actual native request observation');
        } finally { ctx.ui.setStatus('performance-status', undefined); await bridge.frame(); }
      }
      integrity.afterActions = inspectTools();
      const retained = await afterGC({ turns: 3 });
      const result = { outcome: 'passed', phases, integrity, capabilities: capabilities(), retained, allocationProfile, source: sourceCounters(),
        observer: { outputHistory: 'bounded-controller', perFrameReceipts: false, statsInsideTarget: true },
        target: { pid: process.pid, node: process.version, v8: process.versions.v8 }, expectedCards: scenario.parameters.cards };
      writeFileSync(output + '.tmp', JSON.stringify(result)); renameSync(output + '.tmp', output);
    } catch (error) {
      writeFileSync(output, JSON.stringify({ outcome: 'failed', phases, failure: { name: error.name, message: String(error.message).slice(0, 1500) } }));
    }
  } });
}
