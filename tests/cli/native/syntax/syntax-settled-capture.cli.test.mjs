import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { prepareSyntaxNative, savedThemeSession, themeMarkers, work, finish, inputs } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();

for (const mode of ['fullscreen', 'regular']) test(`settled capture CLI: ${mode} normal replay paints before passive counters and stays exactly warm`,
  { timeout: 120000 }, async () => {
    const saved = await savedThemeSession();
    let terminal;
    try {
      terminal = new PiTerminal(`settled-capture-${mode}`, { mode, session: saved.session,
        extensions: [fixture], extraEnv: descriptor });
      await terminal.ready();
      assert.equal(terminal.snapshotCopies, 0, 'ordinary startup acknowledgements copy no cells');
      const cold = await terminal.captureSettled('passive-cold');
      const baseline = cold.sample;
      assert.equal(baseline.client.provider.availability, 'ready');
      assert.equal(baseline.source.globalUnsettledJobs, 0);
      assert.ok(baseline.counts.sourceRequests > 0);
      assert.ok(baseline.counts.styleRequests > 0);
      assert.ok(baseline.localWork.sourceSegments > 0);
      assert.ok(baseline.localWork.prefixScalarReads > 0, 'first real normal paint has adopted the native Bash prefix');
      assert.ok(themeMarkers.every(marker => cold.screen.some(row => row.includes(marker))), 'saved native cards are physically visible');
      assert.equal(terminal.snapshotCopies, 1);
      const observations = [cold];
      for (let i = 0; i < 3; i++) {
        const warm = await terminal.captureSettled(`passive-warm-${i}`);
        assert.deepEqual(work(warm.sample), work(baseline));
        assert.equal(warm.sample.controller, baseline.controller);
        assert.equal(warm.receipt.generation, cold.receipt.generation);
        assert.ok(warm.receipt.frames >= cold.receipt.frames, 'legitimate normal rendering may advance without new source work');
        assert.deepEqual(warm.screen, cold.screen);
        assert.deepEqual(warm.cells, cold.cells);
        observations.push(warm);
      }
      assert.equal(terminal.snapshotCopies, observations.length, 'each explicit result detaches exactly once');
      const changed = await terminal.captureSettled('passive-theme-action', {
        action: signal => terminal.command('/tidy-ui-theme light', signal),
      });
      assert.deepEqual(work(changed.sample), work(baseline), 'actual theme action reuses native source/style and measured geometry');
      assert.equal(changed.sample.controller, baseline.controller);
      assert.ok(changed.receipt.frames > cold.receipt.frames, 'capture includes the action\'s actual normal frame');
      assert.equal(terminal.snapshotCopies, observations.length + 1);
      assert.deepEqual(readFileSync(saved.session), saved.bytes, 'sampling does not write or replace the saved session');
      assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      console.log(JSON.stringify({ settledCapture: terminal.output, mode,
        observations: [...observations, changed].map(result => ({ receipt: result.receipt, controller: result.sample.controller,
          counts: result.sample.counts, work: work(result.sample) })), snapshotCopies: terminal.snapshotCopies }));
      await terminal.quit('\x04'); await finish(terminal);
    } finally {
      await runCleanupSteps(() => closeTerminals(terminal ? [terminal] : []), () => rm(saved.directory, { recursive: true, force: true }));
    }
  });

for (const mode of ['fullscreen', 'regular']) test(`settled capture CLI: ${mode} empty-history startup needs no stats or diagnostic warmup`,
  { timeout: 60000 }, async () => {
    const terminal = new PiTerminal(`settled-empty-${mode}`, { mode, extensions: [fixture], extraEnv: descriptor });
    try {
      await terminal.ready();
      assert.equal(terminal.snapshotCopies, 0);
      const cold = await terminal.captureSettled('empty-startup', { screen: false });
      const warm = await terminal.captureSettled('empty-warm', { screen: false });
      assert.equal(cold.sample.client.provider.availability, 'ready');
      assert.equal(cold.sample.counts.describeReplies, 1); assert.equal(cold.sample.counts.acquisitions, 1);
      assert.equal(cold.sample.counts.sourceRequests, 0); assert.equal(cold.sample.counts.styleRequests, 0);
      assert.equal(cold.sample.source.sourceRecords, 0); assert.equal(cold.sample.source.globalUnsettledJobs, 0);
      assert.equal(cold.sample.localWork.prefixScalarReads, 0);
      assert.deepEqual(work(warm.sample), work(cold.sample));
      assert.equal(warm.sample.controller, cold.sample.controller);
      assert.equal(warm.receipt.generation, cold.receipt.generation);
      assert.ok(warm.receipt.frames >= cold.receipt.frames);
      assert.equal(terminal.snapshotCopies, 0);
      for (const name of ['empty-startup', 'empty-warm']) {
        assert.equal(existsSync(join(terminal.output, `${name}.screen.json`)), false);
        assert.equal(existsSync(join(terminal.output, `${name}.screen.txt`)), false);
      }
      assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      console.log(JSON.stringify({ emptySettledStartup: terminal.output, mode, node: cold.sample.node, pi: inputs.pi.version,
        receipts: [cold.receipt, warm.receipt], work: work(cold.sample), counts: cold.sample.counts, snapshotCopies: terminal.snapshotCopies }));
      await terminal.quit('\x04'); await finish(terminal);
    } finally { await closeTerminals([terminal]); }
  });
