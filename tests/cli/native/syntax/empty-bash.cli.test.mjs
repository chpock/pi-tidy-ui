import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { prepareSyntaxNative, settledStats, captureThenRenderDiagnostics, work, finish } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const rgb = (dump, role) => {
  const color = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(color);
  return +color[1] * 65536 + +color[2] * 256 + +color[3];
};
for (const mode of ['regular', 'fullscreen']) test(`empty Bash CLI: ${mode} delayed empty paint grows into valid colored parser data`, { timeout: 45000 }, async () => {
  const terminal = new PiTerminal(`empty-bash-${mode}`, { mode, extensions: [fixture], extraEnv: { ...descriptor, TIDY_UI_TEST_EMPTY_BASH: '1' } });
  try {
    await terminal.ready(); terminal.send('run bash-empty-stream\r');
    await terminal.event('bash_empty_prefix', 1);
    const empty = await settledStats(terminal, 'empty', value => value.source?.sourceRecords === 1
      && value.source.stylePublications > 0 && value.source.globalUnsettledJobs === 0);
    assert.equal(empty.counts.sourceRequests, 0, 'empty paint was prepared before any real SOURCE request');
    for (const phase of [0, 1, 2]) {
      if (phase > 0) await settledStats(terminal, `prefix-${phase}`, value => value.broker?.successfulClassifications >= phase
        && value.source.globalUnsettledJobs === 0);
      writeFileSync(join(terminal.output, `bash-empty-go-${phase}`), 'go');
      if (phase < 2) await terminal.event('bash_empty_prefix', phase + 2);
    }
    await terminal.event('agent_end');
    const shown = await captureThenRenderDiagnostics(terminal, 'empty-bash-colored'), ready = shown.sample;
    assert.equal(ready.source.globalUnsettledJobs, 0); assert.equal(ready.source.remoteLeases, 0);
    assert.equal(ready.broker.successfulClassifications, 3);
    assert.ok(ready.source.stylePublications >= empty.source.stylePublications + 2, 'exact completed source and styles after empty-to-growing transition');
    const y = shown.screen.findIndex(row => row.includes("printf 'EMPTY_BASH_READY")); assert.ok(y >= 0);
    const x = shown.screen[y].indexOf('EMPTY_BASH_READY');
    assert.equal(shown.cells[y][x].fg, rgb(shown, 'syntaxString')); assert.notEqual(shown.cells[y][x].fg, rgb(shown, 'toolTitle'));
    assert.deepEqual(shown.tools.filter(tool => tool.name === 'bash').map(tool => tool.args.command), ["printf 'EMPTY_BASH_READY\\n'"]);
    assert.equal(terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error').length, 0);
    await terminal.openTidyMenu(); await terminal.selectTidyItem('Status & troubleshooting');
    assert.match((await terminal.completeTidyRows()).join('\n'), /Runtime errors: 0; active: 0/); await terminal.closeTidyMenu();
    await terminal.capture('empty-bash-warm'); const warm = await settledStats(terminal, 'empty-bash-warm'); assert.deepEqual(work(warm), work(ready));
    console.log(JSON.stringify({ emptyBash: { mode, output: terminal.output, initialSources: empty.counts.sourceRequests,
      acceptedSources: ready.broker.successfulClassifications, finalLeases: ready.source.remoteLeases, color: shown.cells[y][x].fg, warmWork: 0 } }));
    await finish(terminal);
  } finally { await runCleanupSteps(() => terminal.close(), () => terminal.dispose()); }
});
