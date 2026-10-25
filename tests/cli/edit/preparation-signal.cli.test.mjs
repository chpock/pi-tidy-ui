import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, plain } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { referenceCell } from '../../fixtures/main-cli-support.mjs';

for (const mode of ['regular', 'fullscreen']) test(`real CLI: capture waits for real applied edit preparation (${mode})`, { timeout: 45000 }, async () => {
  const terminal = new PiTerminal(`edit-preparation-${mode}`, { mode,
    extensions: [fileURLToPath(new URL('../../fixtures/edit-preparation-control.ts', import.meta.url))],
    extraEnv: { TIDY_UI_TEST_EDIT_CARDS: '1' } });
  let outcome, onStage;
  try {
    writeFileSync(join(terminal.output, 'provider-go'), 'go');
    writeFileSync(join(terminal.output, 'edit-execution-go'), 'go');
    await terminal.ready(); await terminal.resize(100, 160);
    terminal.send('run edit-cards\r'); await terminal.event('agent_end');
    const prepared = { tool: 'edit', count: 5 }, baseline = await terminal.capture('baseline', { prepared });
    const session = readFileSync(baseline.session), traffic = terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
    await terminal.command('/hold-preparation');
    await terminal.command('/tidy-ui-theme light');
    await terminal.waitForProgress(() => terminal.events().find(event => event.type === 'preparation_control' && event.phase === 'held'), 'actual held continuation');
    const copies = terminal.snapshotCopies;
    let finished = false, admitted;
    const admission = new Promise(resolve => { admitted = resolve; });
    onStage = stage => {
      if (stage === 'preparation-event') admitted();
      if (stage === 'component-dump') assert.ok(terminal.events().some(event => event.type === 'preparation_control' && event.phase === 'released' && event.count > 0),
        'neither component data nor physical capture can be selected before real work is released');
    };
    terminal.nativeProgress.on('capture-stage', onStage);
    outcome = terminal.capture('after-release', { prepared }).then(dump => { finished = true; return { dump }; }, error => { finished = true; return { error }; });
    await Promise.race([admission, outcome.then(result => { throw result.error ?? new Error('Capture completed before preparation admission'); })]);
    assert.equal(finished, false);
    assert.equal(terminal.snapshotCopies, copies, 'no physical capture while real preparation is held');
    assert.equal(existsSync(join(terminal.output, 'after-release.json')), false, 'no manually rendered dump while real preparation is held');
    await terminal.command('/release-preparation');
    const result = await outcome;
    assert.ifError(result.error);
    const dump = result.dump, rows = dump.tools[0].lines.map(plain).filter(row => row.trim()), screen = dump.screen.map(plain);
    const start = screen.findIndex((row, index) => row === rows[0] && rows.every((value, offset) => screen[index + offset] === value));
    assert.ok(start >= 0, 'the complete actual edit component is on the selected physical screen');
    const source = rows.findIndex(row => row.includes('export const before = 10;'));
    assert.ok(source >= 0, 'the selected source line exists in the complete panel');
    const column = rows[source].indexOf('export');
    assert.ok(column >= 0);
    const expected = await referenceCell(dump.summaryStyles.syntaxKeyword), actual = dump.cells[start + source][column];
    assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim }, { fg: expected.fg, fgMode: expected.fgMode, dim: expected.dim });
    assert.equal(terminal.snapshotCopies - copies, 1, 'one selected capture, not a search for a passing frame');
    const control = terminal.events().filter(event => event.type === 'preparation_control');
    assert.equal(control.filter(event => event.phase === 'released' && event.count > 0).length, 1);
    assert.equal(control.find(event => event.phase === 'released' && event.count > 0).count, control.filter(event => event.phase === 'held').length);
    assert.deepEqual(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)), traffic);
    assert.deepEqual(readFileSync(baseline.session), session);
  } finally {
    if (onStage) terminal.nativeProgress.off('capture-stage', onStage);
    try { await closeTerminals([terminal]); }
    finally { if (outcome) await outcome; }
  }
});
