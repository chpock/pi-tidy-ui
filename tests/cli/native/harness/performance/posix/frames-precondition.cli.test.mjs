import '../../../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readInputs } from '../../../../../../scripts/test/context.mjs';
import { history, plan } from '../../../../../../scripts/test/performance/workloads.mjs';
import { runPerformanceCLI } from '../../../../../fixtures/performance-cli.mjs';
import { runCleanupSteps } from '../../../../../fixtures/terminal-cleanup.mjs';

const inputs = readInputs();

test('performance CLI readiness precondition: real enabled frames use Pi-origin paint without collecting phases', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(inputs.runRoot, 'performance-frames-precondition-')), terminals = [];
  t.after(() => runCleanupSteps(...[...terminals.map(terminal => () => terminal.close()),
    ...terminals.map(terminal => () => terminal.dispose()), () => rmSync(directory, { recursive: true, force: true })]));
  const scenarios = plan({ profile: 'quick', cases: ['frames'], selectedVariants: ['on'] });
  assert.equal(scenarios.length, 1);
  const [scenario] = scenarios, mode = 'fullscreen';
  const expectedCards = history(scenario.parameters).tools.filter(tool => tool.name !== 'read').length;
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ scenario, mode, preconditionOnly: true }));
  const result = await runPerformanceCLI(config, { name: 'performance-frames-precondition', created: terminal => terminals.push(terminal) });
  result.workload = { profile: 'quick', id: scenario.id, variant: scenario.variant, hash: scenario.hash,
    parameters: scenario.parameters, mode };

  assert.equal(result.outcome, 'passed', result.failure?.message);
  assert.equal(result.preconditionOnly, true);
  assert.equal(result.phaseSamples, 0);
  assert.deepEqual(result.phases, []);
  assert.equal(result.startupPhase, null);
  assert.equal(result.readiness.palette, 'pi-origin');
  assert.equal(result.readiness.cards, expectedCards);
  assert.equal(result.readiness.paintOriginCount, expectedCards, 'Pi-origin paint covers every expected restored card');
  assert.ok(result.readiness.completedFrames >= 3);
  for (const counter of ['nativeCalls', 'rootRenders', 'layoutPasses', 'dispatches', 'preparedBytes', 'styleDispatches', 'styleEncodes'])
    assert.ok(Number.isSafeInteger(result.readiness.counters[counter] ?? 0), `exact readiness counter ${counter}`);
  assert.equal(Object.hasOwn(result, 'controller'), false, 'correctness-only proof has no controller timing samples');
  assert.equal(result.integrity.session.actionsAndShutdownUnchanged, true);
  assert.equal(result.integrity.viewport.bodyAssertion, 'verified');
  assert.equal(result.target.node, inputs.node.version);
  const evidencePath = join(inputs.preparation, 'runs', `frames-precondition-${inputs.node.version}-pi-${inputs.pi.version}.json`);
  writeFileSync(evidencePath + '.tmp', JSON.stringify(result));
  renameSync(evidencePath + '.tmp', evidencePath);
  assert.deepEqual(JSON.parse(readFileSync(evidencePath, 'utf8')), result, 'proof-only readiness evidence remains available');
});
