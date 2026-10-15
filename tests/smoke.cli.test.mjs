import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, extension, plain, lines, byName, toolLines, assertFits, until } from './fixtures/terminal-harness.mjs';
import { closeTerminals } from './fixtures/terminal-cleanup.mjs';
import { compact, semanticColors, simpleBashCards, execution, persisted, compactContent, summaryText } from './fixtures/main-cli-support.mjs';

test('real CLI: isolated offline stock control and terminal transport', { timeout: 60000 }, async () => {
  const stock = new PiTerminal('stock-control');
  try {
    await stock.ready(); await stock.run();
    const dump = await stock.capture('collapsed');
    assert.equal(dump.tools.length, 7);
    assert.deepEqual(stock.events().filter((e) => e.type === 'call').map((e) => e.name),
      ['read', 'read', 'bash', 'write', 'edit', 'tidy_ui_unknown', 'read']);
    assert.equal(stock.events().filter((e) => e.type === 'result').at(-1).isError, true);
    assert.ok(byName(dump, 'read')[0].lines.length > 2, 'stock read has card padding');
    const stockRow = dump.screen.findIndex((line) => line.includes('read a.txt'));
    assert.ok(stockRow >= 0);
    assert.notEqual(dump.cells[stockRow][dump.screen[stockRow].indexOf('read')].bgMode, 0);
    for (const text of ['BASH_RESULT', 'UNKNOWN_RESULT'])
      assert.ok(dump.screen.some((line) => line.includes(text)), `stock screen shows ${text}`);
    assert.equal(readFileSync(join(stock.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
    stock.send('\x0f'); await stock.settle();
    const expanded = await stock.capture('expanded');
    assert.ok(expanded.tools.every((tool) => tool.expanded), 'real Ctrl+O reaches Pi');
    for (const text of ['READ_A_CONTENT', 'READ_B_CONTENT'])
      assert.ok(expanded.screen.some((line) => line.includes(text)), `expanded stock shows ${text}`);
    stock.send('\x0f'); await stock.settle();
    await stock.resize(24);
    const narrow = await stock.capture('narrow');
    assert.equal(narrow.width, 24);
    await stock.resize(100);
    await stock.command('/tidy-ui-theme light');
    assert.equal(stock.events().findLast((e) => e.type === 'theme').result.success, true);
    await stock.capture('light');
    copyFileSync(dump.session, join(stock.output, 'session.jsonl'));
  } finally { await closeTerminals([stock]); }
});

test('real CLI: pi-tidy-ui policy, input, lifecycle and same-session stock replay',
  { timeout: 180000 }, async () => {
    assert.ok(existsSync(extension), 'Required presentation-driver fixture is missing');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); return terminal;
    };
    try {
      const stock = await start('comparison-stock', {});
      await stock.run(); const control = await stock.capture('collapsed');
      stock.send('\x0f'); await stock.settle(); const controlExpanded = await stock.capture('expanded');
      const live = await start('tidy-ui-fullscreen', { tidyUi: true, workspace: stock.work });
      await live.run(); const collapsed = await live.capture('collapsed'); compact(collapsed);
      await semanticColors(collapsed);
      simpleBashCards(collapsed);
      assert.deepEqual(execution(live), execution(stock), 'real calls, results, and provider-visible results stay unchanged');
      assert.deepEqual(persisted(collapsed), persisted(control), 'persisted tool messages stay unchanged');
      assert.equal(readFileSync(join(live.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
      // Only cross-run live bash runtime text is normalized; same-process and replay checks below are exact.
      assert.match(byName(collapsed, 'write')[0].lines.map(plain).join('\n'), /← Wrote written\.txt[\s\S]*1 WRITE_BEFORE/u);
      assert.doesNotMatch(byName(collapsed, 'write')[0].lines.map(plain).join('\n'), /1 \+ WRITE_BEFORE/u);
      assert.ok(byName(collapsed, 'edit')[0].lines.some((row) => plain(row).includes('← Edited written.txt')), 'edit now uses the custom numbered diff card');
      assert.ok(byName(collapsed, 'edit')[0].lines.some((row) => /1 \+ WRITE_AFTER/.test(plain(row))));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      simpleBashCards(expanded);
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: controlExpanded.tools.filter((tool) => tool.name !== 'bash') }));
      assert.ok(expanded.screen.some((line) => line.includes('READ_A_CONTENT')));
      live.send('\x0f'); await live.settle(); const recollapsed = await live.capture('recollapsed');
      assert.deepEqual(toolLines(recollapsed), toolLines(collapsed)); compact(recollapsed);
      const row = recollapsed.screen.findIndex((line) => /\bread\b.*b\.txt/.test(line));
      const column = recollapsed.screen[row].indexOf('read') + 1;
      live.send(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await live.settle(); const clicked = await live.capture('clicked');
      assert.equal(byName(clicked, 'read')[0].expanded, false);
      assert.equal(byName(clicked, 'read')[1].expanded, true, 'SGR click expands precisely the chosen compact row');
      assert.ok(clicked.screen.some((line) => line.includes('READ_B_CONTENT')));
      // Collapse with stock mouse handling on the expanded title, not direct method invocation.
      const titleRow = clicked.screen.findIndex((line) => line.includes('b.txt'));
      assert.ok(titleRow >= 0);
      live.send(`\x1b[<0;${column};${titleRow + 1}M\x1b[<0;${column};${titleRow + 1}m`);
      await live.settle(); compact(await live.capture('mouse-collapsed'));
      await live.tidyPage(['Status & troubleshooting']);
      await live.appearance(false); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.ok(off.screen.some((line) => line.includes('read a.txt')));
      const offRow = off.screen.findIndex((line) => line.includes('read a.txt'));
      assert.notEqual(off.cells[offRow][off.screen[offRow].indexOf('read')].bgMode, 0, 'disabled read is a stock card on screen');
      await live.appearance(true); compact(await live.capture('enabled'));
      await live.appearance(true); compact(await live.capture('enabled-twice'));
      const starts = live.events().filter((e) => e.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      await until(() => live.screen().some(row => row.includes('Reloaded keybindings, extensions,')), 'native reload completion before command capture');
      compact(await live.capture('reloaded'));
      await live.run('future');
      const future = await live.capture('future-after-reload');
      assert.equal(byName(future, 'tidy_ui_unknown').length, 2);
      assert.equal(lines(byName(future, 'tidy_ui_unknown')[1]).length, 1, 'future attachment is compact after reload');
      assert.match(lines(byName(future, 'tidy_ui_unknown')[1])[0], /^ ⚙ tidy_ui_unknown \[query="future after reload"\]$/u);
      compact(future);
      await live.resize(24); const narrow = await live.capture('narrow');
      assert.equal(narrow.width, 24);
      for (const tool of narrow.tools.filter((t) => ['read', 'tidy_ui_unknown'].includes(t.name))) {
        compactContent(tool);
        const wideTool = future.tools.find((candidate) => candidate.id === tool.id);
        assert.equal(summaryText(tool), summaryText(wideTool), 'narrow wrapping retains complete summary');
        await assertFits(tool.lines, 24);
      }
      const narrowReads = narrow.screen.filter((line) => /\bread\b/.test(line));
      assert.equal(narrowReads.length, 3, 'each narrow read has exactly one first row');
      assert.ok(narrow.screen.some((line) => /⚙ tidy_ui_unknown/.test(line)));
      assert.ok(narrow.screen.some((line) => line.includes('→ read missing.txt')), 'failed compact call remains visible without an error preview or failure badge');
      for (const tool of narrow.tools.filter((tool) => ['read', 'tidy_ui_unknown'].includes(tool.name))) assert.doesNotMatch(tool.lines.map(plain).join(''), /✓|✗/u);
      await live.resize(100);
      const dark = await live.capture('dark');
      await live.command('/tidy-ui-theme light'); const light = await live.capture('light'); compact(light);
      await semanticColors(light);
      assert.equal(live.events().findLast((e) => e.type === 'theme').result.success, true);
      assert.deepEqual(light.tools.map((t) => t.lines.map(plain)), dark.tools.map((t) => t.lines.map(plain)));
      assert.notDeepEqual(byName(light, 'read')[0].lines, byName(dark, 'read')[0].lines, 'theme colors are refreshed');
      await live.command('/tidy-ui-theme dark');
      const beforeReplay = await live.capture('before-replay');
      const session = beforeReplay.session;
      copyFileSync(session, join(live.output, 'session.jsonl'));
      await live.close();
      const replay = await start('tidy-ui-replay', { tidyUi: true, session, workspace: stock.work });
      const resumed = await replay.capture('collapsed'); compact(resumed); simpleBashCards(resumed);
      const nativeReplay = await start('stock-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('collapsed');
      assert.deepEqual(byName(resumed, 'write')[0].lines, byName(beforeReplay, 'write')[0].lines, 'same-session Wrote replay retains the exact input-source card');
      assert.deepEqual(resumed.tools.map(({ name, content }) => ({ name, content })), beforeReplay.tools.map(({ name, content }) => ({ name, content })));
      await replay.appearance(false); const disabledReplay = await replay.capture('disabled');
      assert.deepEqual(disabledReplay.tools.map((t) => t.lines), native.tools.map((t) => t.lines), 'disable restores exact same-session stock rendering');
      const regular = await start('tidy-ui-regular', { tidyUi: true, mode: 'regular' });
      await regular.run(); compact(await regular.capture('collapsed'));
      regular.send('\x0f'); await regular.settle(); const regularExpanded = await regular.capture('expanded');
      assert.ok(regularExpanded.tools.every((t) => t.expanded));
      assert.ok(regularExpanded.screen.some((line) => line.includes('READ_B_CONTENT')));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });
