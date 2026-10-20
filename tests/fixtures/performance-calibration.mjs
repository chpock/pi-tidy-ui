// SDK calibration of the exact observer wrappers on a real regular renderer.
// It is not PTY throughput or a substitute for actual-Pi completed-frame trials.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import { installPerformanceObserver } from './performance-observer.mjs';
import { beginPhase, endPhase, afterGC, capabilities, startAllocationProfile, stopAllocationProfile, summarizeAllocationProfile } from '../../scripts/test/performance/metrics.mjs';
import { workload } from '../../scripts/test/performance/workloads.mjs';

const config = JSON.parse(readFileSync(process.env.TIDY_TEST_PERF_CONFIG, 'utf8'));
const scenario = workload(config.scenario.id, config.scenario.variant, config.scenario.parameters);
assert.equal(scenario.id, 'observer'); assert.equal(scenario.hash, config.scenario.hash);
const p = scenario.parameters, phases = [], profiles = [];
let contentRenders = 0, writes = 0;
const rows = ['prepared observer calibration row'];
const terminal = { columns: p.width, rows: p.height, write() { writes++; }, hideCursor() {}, showCursor() {} };
const root = new TuiMainScreen(terminal, false);
root.addChild({ render() { contentRenders++; return rows; } });
// No terminal startup, timers or process I/O in this SDK-only calibration.
assert.equal(typeof root.doRender, 'function'); root.stopped = false;
class Mode { mountInteractiveTui() {} getUserInput() {} }
const bridge = installPerformanceObserver(Mode); new Mode().mountInteractiveTui(root);
try {
  const operations = p.iterations * 100, order = config.repetition % 2 ? [true, false] : [false, true];
  for (const enabled of order) {
    bridge.instrument(enabled); bridge.observe(true);
    for (let i = 0; i < p.warmup * 100; i++) root.renderNow();
    const before = contentRenders, sampled = config.allocationProfile ? startAllocationProfile() : undefined;
    const start = beginPhase({ gcProfile: config.gcProfile });
    for (let i = 0; i < operations; i++) root.renderNow();
    const result = endPhase(start, { operations });
    if (sampled) {
      const profile = stopAllocationProfile(sampled), path = `${process.env.TIDY_TEST_PERF_PROFILE}-${enabled ? 'on' : 'off'}`;
      writeFileSync(path, JSON.stringify(profile.profile)); profiles.push({ enabled, path, summary: summarizeAllocationProfile(profile.profile) });
    }
    phases.push({ id: enabled ? 'light-observer-on' : 'light-observer-off', ...result,
      counts: { sdkRenderPasses: contentRenders - before } });
    assert.equal(contentRenders - before, operations, 'both calibration arms perform the same native SDK rendering');
  }
  // Keep the saved phase schema stable while preserving the actual arm order separately.
  phases.sort((a, b) => a.id === b.id ? 0 : a.id === 'light-observer-off' ? -1 : 1);
  const retained = await afterGC({ turns: 3 });
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'passed', phases, retained, profiles,
    capabilities: capabilities(), calibration: { kind: 'sdk-observer-wrapper-overhead', preparedRows: 1,
      multiplier: 100, order: order.map(enabled => enabled ? 'on' : 'off'), terminal: 'in-memory', writes, noAutomaticSubtraction: true } }));
} catch (error) {
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'failed', phases,
    failure: { name: error.name, message: String(error.message).slice(0, 1500) } })); process.exitCode = 1;
} finally { root.stopped = true; bridge.instrument(false); delete globalThis[Symbol.for('pi-tidy-ui.performance.observer')]; }
