import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { PiTerminal, artifacts, plain, assertFits } from '../../fixtures/terminal-harness.mjs';
import { persisted, traffic } from '../../fixtures/main-cli-support.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';

const id = 'bash-443fe78c4d7f1e35';
function body(tool) {
  const rows = tool.lines.map(stripVTControlCharacters);
  if (!rows[0]) rows.shift();
  return rows.slice(1, -1).map(row => row.slice(3, -2).trimEnd());
}
const outputRows = Array.from({ length: 10 }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`);
const expected = expanded => [
  ['$ shape task-empty'],
  ['$ shape task-exit', '', 'FAIL_BODY', '[task bash-0000000000000000]', '', '[exit code: 7]', '', '<system-reminder>', 'NOTICE', '</system-reminder>'],
  ['$ shape task-timeout', '', 'TIMEOUT_BODY', '', '[exit code: 124; error: command timed out]'],
  ['$ shape task-cap', '', ...outputRows, expanded ? 'shown 10 of 20 lines (cap)' : '… (Click to expand)'],
];

for (const mode of ['regular', 'fullscreen']) test(`real CLI: AFT task markers stay hidden without changing status or session data (${mode})`, { timeout: 60000 }, async () => {
  const terminals = [];
  const start = async (name, options = {}) => {
    const terminal = new PiTerminal(`aft-task-${mode}-${name}`, { tidyUi: true, mode, extraEnv: { TIDY_UI_TEST_BASH_SHAPE: '1' }, ...options });
    terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 150); return terminal;
  };
  try {
    const live = await start('live'); await live.run('bash-shape-tasks');
    const initial = await live.capture('initial'), bytes = readFileSync(initial.session, 'utf8');
    const raw = initial.tools.map(({ content, details, isError }) => ({ content, details, isError }));
    assert.equal(raw.length, 4);
    assert.ok(raw.every(result => result.details.task_id === id && result.content.some(part => part.text.includes(id))), 'persisted source retains every actual task annotation');
    const observed = traffic(live, 4);
    assert.deepEqual(observed.filter(event => event.type === 'result').map(({ name, type, ...value }) => value), raw);
    observed.filter(event => event.type === 'model_context').forEach((event, i) => assert.deepEqual(event.results, raw.slice(0, i).map(value => ({ name: 'bash', ...value }))));
    const identity = dump => {
      assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), raw);
      assert.deepEqual(persisted(dump), persisted(initial));
      assert.equal(readFileSync(initial.session, 'utf8'), bytes);
    };
    const check = (dump, expanded = false) => {
      identity(dump); assert.deepEqual(dump.tools.map(body), expected(expanded));
      assert.ok(!dump.screen.some(row => row.includes(id)), 'physical screen hides only the own-task annotation');
      assert.ok(dump.screen.some(row => row.includes('[task bash-0000000000000000]')), 'an unrelated literal stays physically visible');
      assert.ok(dump.screen.some(row => row.includes('[exit code: 124; error: command timed out]')));
    };
    check(initial);
    live.send('\x0f'); await live.settle(); check(await live.capture('expanded'), true);
    live.send('\x0f'); await live.settle();
    await live.resize(24, 150); const narrow = await live.capture('narrow'); identity(narrow);
    for (const tool of narrow.tools) { await assertFits(tool.lines, 24); assert.ok(!tool.lines.map(plain).join('').includes(id)); }
    await live.resize(100, 150); check(await live.capture('wide'));
    await live.appearance(false); const off = await live.capture('off'); identity(off);
    assert.ok(off.tools.some(tool => tool.lines.some(row => row.includes(id))), 'native opt-out keeps the original tool result visible');
    await live.appearance(true); check(await live.capture('on'));
    const starts = live.events().filter(event => event.type === 'start').length;
    await live.command('/reload'); await live.event('start', starts + 1); check(await live.capture('reload'));
    assert.deepEqual(traffic(live, 4), observed, 'presentation changes do not run tools or provider again');
    await live.close();
    const replay = await start('replay', { session: initial.session, workspace: live.work });
    check(await replay.capture('replay'));
    for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.events().filter(event => event.type === type).length, 0, type);
    writeFileSync(join(artifacts, `aft-task-${mode}.json`), JSON.stringify({ installedAFT: false, sourceShape: 'AFT 0.60.0', mode, cases: 4, replayCalls: 0, retainedSessionBytes: bytes.length }));
  } finally { await closeTerminals(terminals.reverse()); }
});
