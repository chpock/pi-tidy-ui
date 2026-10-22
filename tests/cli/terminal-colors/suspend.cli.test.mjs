import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { until } from '../../fixtures/terminal-harness.mjs';
import { colorTerminal } from '../../fixtures/main-cli-support.mjs';
import { parseJobGroup } from '../../fixtures/job-control.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function suspend(terminal, name) {
  const file = join(terminal.output, `${name}-stopped`);
  const boundary = terminal.raw.length;
  terminal.send('\x1a');
  await until(() => Buffer.concat(terminal.raw.slice(boundary)).includes('JOB_CONTROL> '), 'job-control shell regains its prompt');
  terminal.send(`jobs -s -p > ${quote(file)}\r`);
  await until(() => existsSync(file) && /^\d+\s*$/.test(readFileSync(file, 'utf8')), 'shell reports exactly one stopped job');
  await terminal.queue;
}
async function resume(terminal) { terminal.send('fg\r'); await terminal.settle(); }

for (const mode of ['regular', 'fullscreen']) test(`terminal colors: actual Ctrl+Z/fg preserves editor/cards and transfers colors (${mode})`, async () => {
  const f = colorTerminal(`suspend-${mode}`, mode, { jobControl: true }), t = f.terminal;
  try {
    await t.ready(); await t.run('suite');
    t.send('DRAFT_BEFORE_SUSPEND'); await t.settle();
    const before = await f.capture('before-suspend');
    const saved = readFileSync(before.session, 'utf8');
    const initial = { ...f.owned }, baseline = before.diagnostic.counters;
    assert.deepEqual(initial, { background: '#123456', foreground: '#eeeeee' });
    const boundary = f.protocol.length;
    await suspend(t, 'first');
    assert.deepEqual(f.owned, {}, 'shell owns profile defaults while Pi is stopped');
    assert.deepEqual(f.protocol.slice(boundary), [{ reset: 'background' }, { reset: 'foreground' }]);
    assert.equal(t.term.modes.mouseTrackingMode, 'none');
    await resume(t);
    const after = await f.capture('after-resume');
    assert.deepEqual(f.owned, initial);
    assert.deepEqual(after.before, before.before, 'draft, expanded paste and cursor survive');
    assert.deepEqual(after.belowRows, before.belowRows);
    assert.deepEqual(after.rows, before.rows, 'all retained cards and editor rows preserve their text and styling');
    assert.equal(after.diagnostic.counters.sourceReads, baseline.sourceReads + 1);
    assert.equal(after.diagnostic.counters.sets, baseline.sets + 2);
    assert.equal(after.diagnostic.counters.releases, baseline.releases + 2);
    assert.equal(t.term.modes.mouseTrackingMode, mode === 'fullscreen' ? 'any' : 'none');
    const warm = await f.capture('warm-after-resume', 'warm');
    assert.deepEqual(warm.diagnostic.counters, after.diagnostic.counters, 'warm frames do no new color work');

    await suspend(t, 'changed-theme');
    f.source.theme.export.pageBg = '#654321';
    f.source.theme.colors.text = '#abcdef';
    writeFileSync(f.source.path, JSON.stringify(f.source.theme));
    t.send("printf '\\033]111\\007\\033]110\\007'\r");
    await resume(t);
    await f.capture('changed-on-resume');
    assert.deepEqual(f.owned, { background: '#654321', foreground: '#abcdef' }, 'resume rereads the current source, not stale desired metadata');

    await f.capture('external-reset', 'foreign-reset');
    assert.deepEqual(f.owned, {});
    t.send('\x15'); await t.openTidyMenu(); await t.selectTidyItem('Status & troubleshooting');
    await t.selectTidyItem('Reapply terminal colors'); await t.closeTidyMenu();
    const reapplied = await f.capture('explicit-reapply');
    assert.deepEqual(f.owned, { background: '#654321', foreground: '#abcdef' });
    assert.equal(reapplied.diagnostic.status.state, 'on');
    t.send('\x1b[200~PASTED_AFTER_RESUME\x1b[201~'); await t.settle();
    assert.equal((await f.capture('paste-after-resume')).before.text, 'PASTED_AFTER_RESUME');
    assert.equal(readFileSync(before.session, 'utf8'), saved, 'UI-only transitions leave saved tool traffic unchanged');

    await f.capture('disable-colors', 'colors off');
    const disabled = f.protocol.length;
    await suspend(t, 'disabled'); await resume(t);
    await f.capture('disabled-resumed');
    assert.deepEqual(f.owned, {});
    assert.equal(f.protocol.slice(disabled).some(packet => packet.set || packet.reset), false, 'local Off remains Off through suspension');

    await f.capture('enable-before-active', 'colors on');
    const ends = t.events().filter(event => event.type === 'agent_end').length;
    t.send('\x15run pending\r'); await t.event('provider_gate'); await t.settle();
    await suspend(t, 'active-long-pause');
    const heldProtocol = f.protocol.length;
    await delay(6000); // Deliberate stopped-process interval, not an output-readiness guess.
    assert.equal(f.protocol.length, heldProtocol, 'no Toolview terminal writes during a sustained stop');
    await resume(t); await t.observeAnimation();
    assert.ok(t.screen().some(row => row.includes('Working')), 'native in-UI activity remains live after resume');
    await f.capture('active-resumed');
    assert.deepEqual(f.owned, { background: '#654321', foreground: '#abcdef' });
    writeFileSync(join(t.output, 'tool-go'), 'go'); writeFileSync(join(t.output, 'provider-go'), 'go');
    await t.event('agent_end', ends + 1); await t.settle();

    t.expectedPiExit = 0; t.send('\x15/quit\r');
    const pid = parseJobGroup(readFileSync(join(t.temp, 'job-group'), 'utf8'));
    await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'owned Pi process exits');
    t.send('exit\r'); await until(() => t.closed, 'Pi and its job-control shell exit');
  } finally { await t.close(); t.dispose(); }
});
