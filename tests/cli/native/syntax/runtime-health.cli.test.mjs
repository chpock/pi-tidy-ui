import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, savedThemeSession, settledStats, captureThenRenderDiagnostics, finish, work } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
for (const mode of ['regular', 'fullscreen']) test(`runtime health CLI: ${mode} unexpected SOURCE reply is visible without logging and another card cannot hide it`,
  { timeout: 60000 }, async () => {
    const saved = await savedThemeSession();
    const terminal = new PiTerminal(`runtime-health-${mode}`, { mode, session: saved.session, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_RUNTIME_HEALTH: '1' } });
    try {
      await terminal.ready();
      const frame = await captureThenRenderDiagnostics(terminal, 'health-ready-frame'), ready = frame.sample;
      assert.ok(await semanticPhaseReady(() => ready, () => terminal.events(), ['THEME_BASH_0', 'THEME_BASH_1'], 'pi'),
        'unaffected Bash sources and styles are ready');
      const painted = await settledStats(terminal, 'health-ready-frame');
      assert.deepEqual(work(painted), work(ready), 'diagnostic rendering adds no delayed first adoption');
      assert.equal(terminal.events().filter(event => event.type === 'runtime_health_invalid_reply').length, 1);
      const notices = () => terminal.events().filter(event => event.type === 'syntax_notify' && event.message.startsWith('pi-tidy-ui:'));
      assert.equal(notices().length, 1); assert.equal(notices()[0].level, 'error');
      assert.match(notices()[0].message, /unexpected error.*Details: \/tidy-ui/);
      await terminal.openTidyMenu(); await terminal.selectTidyItem('Status & troubleshooting');
      let rows = (await terminal.completeTidyRows()).join('\n');
      assert.match(rows, /Runtime errors: 1; active: 1/); assert.match(rows, /Last runtime error:/);
      await terminal.selectTidyItem('Diagnostic logs'); rows = (await terminal.completeTidyRows()).join('\n');
      assert.match(rows, /Diagnostic logging is unavailable/); assert.match(rows, /Runtime errors: 1; active: 1/);
      await terminal.closeTidyMenu(); await captureThenRenderDiagnostics(terminal, 'health-warm');
      const warm = await settledStats(terminal, 'health-warm'); assert.deepEqual(work(warm), work(painted)); assert.equal(notices().length, 1);
      await terminal.appearance(false); await terminal.openTidyMenu(); await terminal.selectTidyItem('Status & troubleshooting');
      rows = (await terminal.completeTidyRows()).join('\n');
      assert.match(rows, /Runtime errors: 1; active: 0/); assert.match(rows, /owner\s+removed/);
      await terminal.closeTidyMenu(); const finalNotices = notices().length; await finish(terminal);
      assert.equal(readFileSync(saved.session, 'utf8'), saved.bytes.toString('utf8'), 'health observation never alters saved tool/session data');
      console.log(JSON.stringify({ mode, output: terminal.output, sourceRequests: ready.counts.sourceRequests,
        publications: ready.source.stylePublications, initialWork: work(ready), paintedWork: work(painted), notifications: finalNotices, logging: 'unavailable', warmWork: 0 }));
    } finally { await runCleanupSteps(() => terminal.close(), () => terminal.dispose(), () => rm(saved.directory, { recursive: true, force: true })); }
  });
