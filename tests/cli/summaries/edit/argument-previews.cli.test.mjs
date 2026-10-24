import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, byName, toolLines, assertFits } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { multilineLayout, persisted, nativeAfterMultiline, simpleBashCards, Terminal, compactContent, summaryText, summaryExpected, errorSummaryColors, leadingBlanks, fixtureBoundedSummary, fixtureQuotedPreview, summarySize } from '../../../fixtures/main-cli-support.mjs';

test('real CLI: bounded argument previews, path-only edits and visible payloads preserve native data and replay',
  { timeout: 180000 }, async () => {
    const terminals = [], flags = ['--tidy-ui-compact', 'write'];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 180); return terminal;
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter(event => event.type === 'call').length, 7);
      assert.equal(events.filter(event => event.type === 'result').length, 7);
      assert.equal(events.filter(event => event.type === 'model_context').length, 8);
      return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
    };
    const expected = [
      fixtureBoundedSummary('tidy_ui_summary', '', [
        'op="inspect"', 'action="preview"', 'command="echo"', `query=${fixtureQuotedPreview('STRING_BEGIN_' + 'x'.repeat(1000))}`,
        'paths=["src"]', 'symbol="render"', 'limit=0', 'wait=false', 'api_key="<redacted>"', 'mystery="UNKNOWN"',
        'content="CONTENT_VISIBLE"', 'edits=[{"oldText":"OLD_VISIBLE","newText":"NEW_VISIBLE"}]',
      ]),
      `tidy_ui_summary [content=${fixtureQuotedPreview('界é'.repeat(300))}, newText="ONE_REPLACEMENT"]`,
      `tidy_ui_summary [query=[${Array(18).fill('"ARRAY_ENTRY"').join(',')},…]]`,
      `tidy_ui_summary [query={"list":[${Array(16).fill('"OBJECT_ENTRY"').join(',')},…],…}, unknownTail="DISPLAY_TAIL"]`,
      fixtureBoundedSummary('tidy_ui_summary', '', Array.from({ length: 30 }, (_, i) => `field${String(i).padStart(2, '0')}="${'v'.repeat(180)}"`)),
      'edit missing-bounded.ts',
      'write bounded-write.txt',
    ];
    let checkedErrorCells = 0;
    const check = async (dump) => {
      assert.equal(dump.tools.length, 7);
      for (const [index, tool] of dump.tools.entries()) {
        compactContent(tool);
        assert.equal(summaryText(tool), summaryExpected(expected[index]), `bounded preview ${index}`);
        assert.ok(summarySize(expected[index]) <= 1024);
        const rows = lines(tool), start = dump.screen.findIndex((row, y) => row === rows[0] && rows.every((line, offset) => dump.screen[y + offset] === line));
        assert.ok(start >= 0, `complete physical row block ${index} at ${dump.width}`);
        for (let y = start; y < start + rows.length; y++) assert.ok(['', ' '].includes(dump.cells[y][dump.width - 1].text), 'one blank right column');
        await assertFits(tool.lines, dump.width - 1);
      }
      assert.doesNotMatch(dump.tools.map(tool => tool.lines.join('')).join(''), /COMPACT_SECRET_NEVER_VISIBLE|EDIT_PATTERN_IGNORED|EDIT_QUERY_IGNORED|PROPOSAL_IGNORED/u);
      assert.ok(dump.tools[5].isError, 'actual built-in edit failed');
      checkedErrorCells += await errorSummaryColors(dump, dump.tools[5]);
    };
    try {
      const stock = await start('bounded-stock');
      await stock.run('bounded-summaries'); const native = await stock.capture('native');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const nativeTraffic = activity(stock); await stock.close();
      const live = await start('bounded-tidyUi', { tidyUi: true, flags, workspace: stock.work });
      await live.run('bounded-summaries'); const wide = await live.capture('wide'); await check(wide);
      assert.deepEqual(activity(live), nativeTraffic, '7 actual calls/results and 8 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(native));
      assert.equal(readFileSync(join(live.work, 'bounded-write.txt'), 'utf8'), 'WRITE_BODY_' + 'w'.repeat(1000));
      assert.equal(wide.tools[0].args.query.length, 1013, 'original unabridged string remains in component arguments');
      assert.equal(wide.tools[2].args.query.length, 100, 'original array remains complete');
      const bytes = readFileSync(wide.session);
      await live.resize(24, 180); await check(await live.capture('narrow'));
      await live.resize(100, 180); const back = await live.capture('wide-again'); await check(back);
      assert.deepEqual(toolLines(back), toolLines(wide));
      await live.command('/tidy-ui-theme light'); await check(await live.capture('light'));
      await live.command('/tidy-ui-theme dark'); await check(await live.capture('dark'));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every(tool => tool.expanded));
      assert.deepEqual(toolLines({ tools: expanded.tools.filter(tool => tool.name !== 'edit') }),
        toolLines({ tools: nativeExpanded.tools.filter(tool => tool.name !== 'edit') }), 'full generic/write native details are unchanged');
      assert.match(expanded.tools[5].lines.map(plain).join('\n'), /missing-bounded.ts/u);
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'));
      await live.appearance(false); const off = await live.capture('off');
      assert.deepEqual(toolLines({ tools: off.tools.filter(tool => tool.name !== 'edit') }),
        toolLines({ tools: native.tools.filter(tool => tool.name !== 'edit') }));
      await live.appearance(true); await check(await live.capture('on'));
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded);
      assert.deepEqual(activity(live), nativeTraffic);
      assert.deepEqual(readFileSync(wide.session), bytes, 'UI operations leave session bytes untouched');
      await live.close();
      const replay = await start('bounded-replay', { tidyUi: true, flags, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      const nativeReplay = await start('bounded-native-replay', { session: wide.session, workspace: stock.work });
      const sameSessionNative = await nativeReplay.capture('replayed');
      await nativeReplay.close();
      await replay.appearance(false);
      assert.deepEqual(toolLines(await replay.capture('off')), toolLines(sameSessionNative), 'same-session native control includes unchanged edit details');
      await replay.close();
      assert.equal(replay.closed, true, 'bounded-summary replay is reaped with borrowed session files retained');
      assert.deepEqual(readFileSync(wide.session), bytes);
      writeFileSync(join(artifacts, 'bounded-summary-coverage.json'), JSON.stringify({
        calls: 7, results: 7, modelContexts: 8, widths: [24, 100], valueLimit: 256, summaryLimit: 1024, checkedErrorCells,
        checks: ['action/target/control/unknown/content ordering', 'visible payloads', 'quoted Unicode/string and container caps', 'total text budget',
          'path-only actual edit failure', 'physical complete row blocks', 'dark/light error cells', 'native expansion', 'off/on/reload', 'same-session replay'],
        identity: 'Exact raw args/results/model contexts and unchanged session bytes; no tools re-executed during replay',
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });
