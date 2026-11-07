import '../../../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PiTerminal } from '../../../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../../../fixtures/terminal-cleanup.mjs';
import { prepareSyntaxNative, captureThenRenderDiagnostics, finish, syntaxReady, traffic, work } from '../../../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const aftReadFixture = resolve('tests/fixtures/tool-adapters/aft/read-driver.ts');
const file = 'aft-saved.md';
const captured = JSON.parse(readFileSync(resolve('tests/fixtures/tool-adapters/aft/read-result.json'), 'utf8'));
const heading = '## SAVED_AFT_HEADING';
const visible = 'Returned source ends here.';
const hidden = 'NOT_RETURNED';
const source = captured.input;
const changed = 'AFT_READ_CHANGED_ON_DISK\n';
const arguments_ = { path: file, startLine: '2', endLine: '8', offset: 4, limit: '7' };
const savedResult = captured.result;

function roleRgb(dump, role) {
  const match = dump.summaryStyles[role].match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/u);
  assert.ok(match, `the public truecolor theme supplies ${role}`);
  return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]);
}

function sourceAndMeasurementWork(sample) {
  const snapshot = work(sample);
  return {
    sourceRequests: snapshot.sourceRequests,
    styleRequests: snapshot.styleRequests,
    sourceSegments: snapshot.localWork.sourceSegments,
    sourceSegmentUnits: snapshot.localWork.sourceSegmentUnits,
  };
}

function assertCompact(dump) {
  const text = dump.screen.join('\n');
  assert.ok(text.includes(file), 'the compact read path remains visible');
  for (const marker of [heading, 'SOURCE_LITERAL', visible, hidden, changed.trim()])
    assert.ok(!text.includes(marker), `the collapsed card does not expose ${marker}`);
  assert.doesNotMatch(text, /unavailable/iu);
}

function assertExpanded(dump) {
  const text = dump.screen.join('\n');
  assert.ok(text.includes(`→ Read ${file}`), 'the owned read card is expanded');
  assert.doesNotMatch(text, /unavailable/iu);
  assert.ok(text.includes(heading), 'the original Markdown heading is visible without its producer prefix');
  assert.ok(text.includes('1: SOURCE_LITERAL'), 'a literal source line-number-like prefix remains unchanged');
  assert.ok(text.includes(visible), 'the last returned source row is visible');
  assert.ok(!text.includes(hidden), 'the row outside the saved range is never reconstructed');
  assert.ok(!text.includes(changed.trim()), 'the renderer does not reread the overwritten file');

  const headingRows = dump.screen.filter(row => row.includes(heading));
  assert.equal(headingRows.length, 1);
  assert.match(headingRows[0], /┃\s+2\s+## SAVED_AFT_HEADING/u, 'the public mdHeading source starts at the saved result coordinate');
  assert.doesNotMatch(headingRows[0], /2:\s+## SAVED_AFT_HEADING/u, 'the producer line prefix is not a second gutter');
  assert.ok(dump.screen.some(row => /┃\s+3\s+/u.test(row)), 'the saved blank source row retains gutter coordinate 3');
  assert.ok(dump.screen.some(row => row.includes(visible) && /┃\s+8\s+Returned source ends here\./u.test(row)),
    'the final returned source row retains gutter coordinate 8');

  const literalRows = dump.screen.filter(row => row.includes('1: SOURCE_LITERAL'));
  assert.equal(literalRows.length, 1);
  assert.match(literalRows[0], /┃\s+4\s+1: SOURCE_LITERAL_AFT/u, 'the literal source prefix follows one gutter at returned line 4');
  assert.doesNotMatch(literalRows[0], /4:\s+1: SOURCE_LITERAL_AFT/u, 'the producer prefix is removed exactly once');

  const headingX = headingRows[0].indexOf('SAVED_AFT_HEADING');
  const headingY = dump.screen.indexOf(headingRows[0]);
  assert.equal(dump.cells[headingY][headingX].fg, roleRgb(dump, 'mdHeading'), 'the physical heading uses the public Pi mdHeading role');
}

function assertCapturedRead(terminal) {
  const calls = terminal.events().filter(event => event.type === 'call');
  assert.deepEqual(calls.map(({ name, input }) => ({ name, input })), [{ name: 'read', input: arguments_ }]);
  const results = terminal.events().filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.deepEqual({ name: results[0].name, content: results[0].content, details: results[0].details, isError: results[0].isError },
    { name: 'read', ...savedResult, isError: false }, 'the saved result is the exact AFT 0.63.5-shaped envelope');
  const diskReads = terminal.events().filter(event => event.type === 'aft_read_fixture_disk_read');
  assert.equal(diskReads.length, 1, 'the fixture performs one disk read in tool execution');
  assert.deepEqual(diskReads[0], { type: 'aft_read_fixture_disk_read', path: file, input: arguments_ });
}

for (const mode of ['fullscreen', 'regular']) test(`captured AFT read: ${mode} saved range, Follow Pi paint, collapse/reopen and replay`,
  { timeout: 180000 }, async () => {
    const terminals = [];
    const create = (name, options = {}) => {
      const terminal = new PiTerminal(`aft-read-cards-${mode}-${name}`, { mode, ...options,
        extensions: [fixture, aftReadFixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_PALETTE_OBSERVE: '1',
          TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }) } });
      terminals.push(terminal);
      return terminal;
    };

    try {
      const live = create('live');
      writeFileSync(join(live.work, file), source);
      writeFileSync(join(live.output, 'highlighting-limits.json'), JSON.stringify({
        calls: [{ name: 'read', arguments: arguments_ }],
      }));
      await live.ready();
      const piTheme = await syntaxReady(live);
      assert.equal(piTheme.client.effective.id, 'pi', 'the real helper uses Follow Pi');
      await live.run('highlighting-limits-read');

      const compact = await captureThenRenderDiagnostics(live, 'aft-read-compact');
      assertCompact(compact);
      assert.equal(compact.sample.counts.sourceRequests, 0, 'collapsed reads dispatch no native SOURCE work');
      assert.equal(compact.sample.counts.styleRequests, 0, 'collapsed reads dispatch no native STYLE work');
      assert.equal(compact.sample.counts.piCaptures, 0, 'collapsed reads do not invoke Pi classification');
      assert.equal(compact.sample.localWork.sourceSegments, 0, 'collapsed reads do not prepare saved source rows');
      assertCapturedRead(live);

      const session = compact.session;
      const savedSession = readFileSync(session);
      const originalTraffic = traffic(live);
      writeFileSync(join(live.work, file), changed);

      live.send('\x0f');
      const expanded = await captureThenRenderDiagnostics(live, 'aft-read-expanded');
      assertExpanded(expanded);
      assert.ok(expanded.sample.localWork.sourceSegments > 0, 'expansion measures the returned Markdown source');
      assert.ok(expanded.sample.counts.sourceRequests > 0, 'expansion sends SOURCE to the prepared real Occipital helper');
      assert.ok(expanded.sample.counts.styleRequests > 0, 'the helper resolves semantic styles for the expanded Markdown');
      assert.equal(expanded.sample.counts.piCaptures, 0, 'Follow Pi uses the actual helper result, not Pi classifier fallback');
      const baseline = sourceAndMeasurementWork(expanded.sample);

      const warm = await live.captureSettled('aft-read-warm');
      assert.deepEqual(sourceAndMeasurementWork(warm.sample), baseline, 'warm expanded rows issue no SOURCE or STYLE request or repeat measurement');
      assertExpanded({ ...expanded, ...warm });

      await live.resize(80);
      const resized = await captureThenRenderDiagnostics(live, 'aft-read-width-80');
      assertExpanded(resized);
      assert.deepEqual(sourceAndMeasurementWork(resized.sample), baseline, 'a width-only change issues no new SOURCE or STYLE request or repeat measurement');

      for (let cycle = 1; cycle <= 2; cycle++) {
        live.send('\x0f');
        const closed = await captureThenRenderDiagnostics(live, `aft-read-closed-${cycle}`);
        assertCompact(closed);
        live.send('\x0f');
        const reopened = await captureThenRenderDiagnostics(live, `aft-read-reopened-${cycle}`);
        assertExpanded(reopened);
      }
      assertCapturedRead(live);
      assert.deepEqual(traffic(live), originalTraffic, 'rendering and repeated expansion add no model/tool traffic');
      assert.deepEqual(readFileSync(session), savedSession, 'card interactions leave the saved session byte-identical');
      assert.equal(readFileSync(join(live.work, file), 'utf8'), changed);
      await finish(live);

      const replay = create('replay', { session, workspace: live.work });
      await replay.ready();
      const replayTheme = await syntaxReady(replay);
      assert.equal(replayTheme.client.effective.id, 'pi', 'same-session replay keeps Follow Pi active');
      const replayCompact = await captureThenRenderDiagnostics(replay, 'aft-read-replay-compact');
      assertCompact(replayCompact);
      replay.send('\x0f');
      const replayExpanded = await captureThenRenderDiagnostics(replay, 'aft-read-replay-expanded');
      assertExpanded(replayExpanded);
      assert.equal(replay.events().filter(event => event.type === 'aft_read_fixture_disk_read').length, 0,
        'same-session replay never invokes the fixture filesystem read');
      assert.equal(traffic(replay).filter(event => event.type === 'call' || event.type === 'result').length, 0,
        'same-session replay executes no tools');

      replay.send('\x0f');
      await replay.appearance(false);
      replay.send('\x0f');
      await replay.settle();
      const stock = await replay.captureCompleteScreen('aft-read-appearance-off', {});
      const stockText = stock.screen.join('\n');
      assert.ok(stockText.includes(`AFT FOREIGN READ ${file}`), 'Appearance Off preserves the foreign public renderCall');
      assert.ok(stockText.includes('2: ## SAVED_AFT_HEADING'), 'Pi presentation retains the producer-decorated raw result');
      assert.ok(stockText.includes('4: 1: SOURCE_LITERAL_AFT'), 'Pi presentation retains literal source text after the producer prefix');
      assert.ok(!stockText.includes(`→ Read ${file}`), 'Appearance Off selects Pi presentation rather than our card');
      assert.doesNotMatch(stockText, /unavailable/iu);
      assert.deepEqual(readFileSync(session), savedSession, 'replay and Appearance Off leave the source session byte-identical');
      assert.equal(readFileSync(join(replay.work, file), 'utf8'), changed);
      await finish(replay);
    } finally {
      await closeTerminals(terminals);
    }
  });
