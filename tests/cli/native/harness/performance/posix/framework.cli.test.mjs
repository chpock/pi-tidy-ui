import '../../../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readInputs } from '../../../../../../scripts/test/context.mjs';
import { workload } from '../../../../../../scripts/test/performance/workloads.mjs';
import { runPerformanceCLI } from '../../../../../fixtures/performance-cli.mjs';
import { runCleanupSteps } from '../../../../../fixtures/terminal-cleanup.mjs';

const inputs = readInputs();
for (const variant of ['native', 'on']) test(`performance CLI correctness: ${variant} observes real warm frames, not timing thresholds`, { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(inputs.runRoot, 'performance-cli-contract-')), terminals = [];
  t.after(() => runCleanupSteps(...[...terminals.map(terminal => () => terminal.close()),
    ...terminals.map(terminal => () => terminal.dispose()), () => rmSync(directory, { recursive: true, force: true })]));
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ scenario: workload('frames', variant, { cards: 4, iterations: 2, warmup: 2, idleMs: 100 }), mode: 'fullscreen' }));
  const target = await runPerformanceCLI(config, { name: `performance-correctness-${variant}`, created: terminal => terminals.push(terminal) });
   assert.equal(target.outcome, 'passed', target.failure?.message);
  assert.equal(target.integrity.resultFieldsExact, true);
  assert.equal(target.integrity.session.actionsAndShutdownUnchanged, true);
  assert.equal(target.integrity.viewport.bodyAssertion, 'verified');
  const warm = target.phases.find(value => value.id === 'warm-frames');
  assert.equal(warm.operations, 2); assert.equal(warm.counts.nativeCalls, 2); assert.equal(warm.counts.layoutPasses, 2);
  assert.equal(warm.counts.layoutBuilds ?? 0, 0); assert.equal(warm.counts.dispatches ?? 0, 0);
  assert.equal(warm.counts.styleDispatches ?? 0, 0);
  assert.equal(target.allocationProfile, null); assert.equal(target.observer.perFrameReceipts, false);
  assert.equal(target.expectedCards, 4); assert.equal(target.target.node, process.version);
});
