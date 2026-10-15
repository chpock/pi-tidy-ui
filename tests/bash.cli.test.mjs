import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, byName, assertFits, until } from './fixtures/terminal-harness.mjs';
import { closeTerminals } from './fixtures/terminal-cleanup.mjs';
import { allBashCards, bashArguments, persisted, bashCard, bashScreenStyle, mouseAt, panelCells, moveAt, panelAt, bashPointerChecks, traffic, compactContent, bashGeometry, actualCommandCells, referenceCell, hardRows } from './fixtures/main-cli-support.mjs';

test('real CLI: built-in bash full commands, preview, resize, theme and same-session controls',
  { timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 150); return terminal;
    };
    try {
      const live = await start('bash-real', { tidyUi: true });
      await live.run('bash-real'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, false, 'real built-in bash was not replaced');
      assert.equal(byName(wide, 'bash').length, 4); allBashCards(wide);
      const args = bashArguments(wide);
       assert.ok(args[0].command.includes("<<'TIDY_UI_EOF'\n  HEREDOC_INDENT\n"));
       assert.deepEqual(persisted(wide).filter(entry => entry.role === 'toolResult' && entry.toolName === 'bash')[0].content,
         [{ type: 'text', text: '  HEREDOC_INDENT\nHEREDOC_END\nAFTER_HEREDOC\n' }],
         'the real shell closes the heredoc, runs printf, and emits no warning or marker');
       for (const tool of wide.tools) for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
         bashCard({ ...tool, lines: tool.tinyLines[width] }, tool.args, { ...wide, width });
         if (width) await assertFits(tool.tinyLines[width], width);
       }
      assert.ok(wide.screen.map(plain).includes(' ┃   HEREDOC_INDENT'), 'supplied two-space heredoc indentation after column-three content origin');
      assert.ok(wide.screen.map(plain).includes(' ┃ HEREDOC_END'));
      assert.equal(lines(byName(wide, 'bash')[2]).filter((row) => /REAL_ROW_\d+/.test(row)).length, 10);
      assert.ok(wide.screen.some((row) => row.includes('… (Click to expand)')));
      assert.ok(!byName(wide, 'bash')[2].lines.some((row) => row.includes('REAL_ROW_11')));
      assert.ok(byName(wide, 'bash')[3].lines.some((row) => row.includes('[error: execution failed]')));
      assert.ok(!byName(wide, 'bash')[3].lines.some((row) => row.includes('[exit code: 7;')), 'built-in transient structuredContent is not a numeric footer source');
      await bashScreenStyle(wide, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, "cat <<'TIDY_UI_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(wide, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(wide, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, '[error: execution failed]', 'error', 'toolPendingBg');
       // Every panel row is interactive for expandable cards; exterior cells are not.
       await mouseAt(live, wide, 'for i in $(seq 1 11)');
       let current = await live.capture('command-click'); assert.equal(current.tools[2].expanded, true);
       await mouseAt(live, current, 'for i in $(seq 1 11)', { offset: 1 });
       current = await live.capture('gap-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01', { button: 2 });
      current = await live.capture('secondary-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '… (Click to expand)');
      current = await live.capture('hint-click'); allBashCards(current);
      assert.deepEqual(current.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [wide.tools[2].id]);
      assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')));
      await mouseAt(live, current, 'REAL_ROW_11');
      current = await live.capture('output-collapse'); allBashCards(current); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01');
      current = await live.capture('output-expand'); allBashCards(current); assert.equal(current.tools[2].expanded, true);
      await mouseAt(live, current, 'REAL_ROW_11'); await live.capture('recollapsed');
      await live.resize(24, 150); const narrow = await live.capture('narrow'); allBashCards(narrow);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      // Wide command has no cap and every soft row starts at content origin.
       assert.ok(narrow.tools[1].lines.length > 20);
       assert.ok(narrow.tools[1].lines.length > wide.tools[1].lines.length, 'W-5 content width causes more actual visual rows after resize');
      await live.resize(100, 150); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded)); allBashCards(expanded);
      assert.ok(expanded.screen.some((row) => row.includes('REAL_ROW_11')));
      live.send('\x0f'); await live.settle();
      await live.command('/tidy-ui-theme light'); const light = await live.capture('light'); allBashCards(light);
      await bashScreenStyle(light, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, "cat <<'TIDY_UI_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(light, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(light, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, '[error: execution failed]', 'error', 'toolPendingBg');
       await panelCells(light, 0, "cat <<'TIDY_UI_EOF'");
       await panelCells(light, 2, 'for i in $(seq 1 11)');
       await panelCells(light, 3, "printf 'REAL_ERROR", { error: true });
       await moveAt(live, 5, panelAt(light, 2, 'for i in $(seq 1 11)').command);
       const lightEnter = await live.capture('pointer-light-enter');
       await panelCells(lightEnter, 2, 'for i in $(seq 1 11)');
       await moveAt(live, 0, panelAt(lightEnter, 2, 'for i in $(seq 1 11)').command);
       const lightLeave = await live.capture('pointer-light-leave'); await panelCells(lightLeave, 2, 'for i in $(seq 1 11)');
       live.send('\x0f'); await live.settle(); const lightExpanded = await live.capture('pointer-light-expanded');
       await moveAt(live, 5, panelAt(lightExpanded, 3, "printf 'REAL_ERROR").command);
       const lightErrorMove = await live.capture('pointer-light-error-move');
       await panelCells(lightErrorMove, 3, "printf 'REAL_ERROR", { error: true });
       live.send('\x0f'); await live.settle();
       await moveAt(live, 0, panelAt(lightErrorMove, 3, "printf 'REAL_ERROR").command);
       await live.capture('pointer-light-end');
       assert.notDeepEqual(light.tools[0].lines, wide.tools[0].lines);
      await live.command('/tidy-ui-theme dark');
      const session = wide.session;
      const stock = await start('bash-real-native', { session, workspace: live.work });
      const native = await stock.capture('native');
      assert.deepEqual(persisted(native), persisted(wide), 'same-session native control receives identical actual tool results and command arguments');
      assert.deepEqual(native.tools.map((tool) => tool.content), wide.tools.map((tool) => tool.content));
      assert.ok(native.tools[0].lines.some((row) => row.includes('$ cat')));
      await live.appearance(false); const off = await live.capture('off');
      assert.ok(off.tools.every((tool) => tool.lines.some((row) => row.includes('Took'))), 'live native timing is displayed but not persisted by Pi');
      assert.deepEqual(off.tools.map((tool) => tool.content), native.tools.map((tool) => tool.content));
      await live.appearance(true); allBashCards(await live.capture('on'));
      await live.appearance(false); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live component native rendering restored exactly');
       await live.appearance(true);
       // Keep existing live-duration/native controls before the pointer matrix's reload:
       // Pi does not persist native execution durations in a reconstructed component.
       await bashPointerChecks(live, wide);
       const starts = live.events().filter((event) => event.type === 'start').length;
       await live.command('/reload'); await live.event('start', starts + 1);
       const reloaded = await live.capture('reloaded'); allBashCards(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = traffic(live, 4); await live.close();
      const replay = await start('bash-real-replay', { tidyUi: true, session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(native));
      await replay.appearance(false); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session native replay restored exactly without unpersisted live duration');
      await replay.appearance(true); allBashCards(await replay.capture('on'));
      const card = await start('bash-real-card', { tidyUi: true, session, workspace: live.work, flags: ['--tidy-ui-card', 'bash'] });
      const nativeCard = await card.capture('card');
      assert.deepEqual(nativeCard.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines));
      const compactOverride = await start('bash-real-compact', { tidyUi: true, session, workspace: live.work,
        flags: ['--tidy-ui-card', 'bash', '--tidy-ui-compact', 'bash'] });
      const compacted = await compactOverride.capture('compact');
      for (const tool of compacted.tools) compactContent(tool);
      compactOverride.send('\x0f'); await compactOverride.settle(); const overrideExpanded = await compactOverride.capture('expanded');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      assert.deepEqual(overrideExpanded.tools.map((tool) => tool.lines), nativeExpanded.tools.map((tool) => tool.lines), 'explicit compact opt-out uses native expanded cards');
      const regular = await start('bash-real-regular', { tidyUi: true, mode: 'regular', session, workspace: live.work });
      allBashCards(await regular.capture('collapsed'));
      await regular.resize(24, 150); allBashCards(await regular.capture('narrow'));
      await regular.resize(100, 150); regular.send('\x0f'); await regular.settle();
      const regularExpanded = await regular.capture('expanded'); allBashCards(regularExpanded); assert.ok(regularExpanded.tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'bash-real-coverage.json'), JSON.stringify({ calls: activity.filter((event) => event.type === 'call').length,
        results: activity.filter((event) => event.type === 'result').length, modelContexts: activity.filter((event) => event.type === 'model_context').length,
         builtIn: true, widths: [100, 24, 100], liveComponentWidths: [0, 1, 2, 3, 4, 5, 6, 7, 8],
         pointerViewport: [100, 35], pointerInputs: live.pointerInputs.length,
         selectionObserved: ['pointer-selection-drag', 'pointer-active-selection-click'],
         commands: args, session, modes: ['fullscreen', 'regular'],
        checked: ['heredoc indentation', 'uncapped hard-wrapped commands', '10-row preview', 'real nonzero exit generic footer', 'whole-panel command/gap/output/hint/border/inside/right-edge/top/bottom/footer clicks', 'exterior/separator/nonexpandable/secondary guards', 'actual SGR selection drag/double-click guard and public selection observation', 'native wheel scrolling', 'no-hover native SGR move/enter/margin/editor/focus leave/transfer with strictly steady neutral paint', 'steady neutral paint across resize/off/on/reload and re-entry', 'native /settings fullscreen→regular→fullscreen renderer replacement with retained traffic and no lifecycle events', 'regular replacement Ctrl+O expand/collapse and complete independent body oracle', 'steady neutral panel cells across native mode switches and fullscreen SGR enter/margin/focus leave', 'Ctrl+O', 'dark/light semantic/steady-neutral-background/normal-and-error-border cells', 'off/on/reload/replay', 'native-card and compact precedence', 'identical actual session args/results'] }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });

test('real CLI: gated actual built-in bash streaming and argument pending',
  { timeout: 60000 }, async () => {
    const live = new PiTerminal('bash-stream', { tidyUi: true });
    try {
      await live.ready(); await live.resize(100, 120);
      live.send('run bash-stream\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending');
      assert.equal(pending.bashShape, false);
      assert.ok(pending.tools[0].lines.some((row) => plain(row).includes('$ for i')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('… (Click')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('[error:')));
      await bashScreenStyle(pending, '$ ', 'dim', 'toolPendingBg');
      writeFileSync(join(live.output, 'provider-go'), 'go');
      await until(() => existsSync(join(live.output, 'shell-ready')), 'actual shell emitted 12 rows and reached gate');
      await until(() => live.events().some((event) => event.type === 'execution_update' && JSON.stringify(event.partialResult).includes('LIVE_ROW_12')), 'real built-in partial update');
      let streaming = await live.capture('partial'); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].content[0].text.includes('LIVE_ROW_12'), true);
      assert.ok(!streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await bashScreenStyle(streaming, 'LIVE_ROW_01', 'toolOutput', 'toolPendingBg');
      await mouseAt(live, streaming, '… (Click to expand)');
      streaming = await live.capture('partial-expanded'); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].expanded, true); assert.ok(streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await live.resize(24, 120); const narrow = await live.capture('partial-narrow'); allBashCards(narrow, { partial: true });
      await live.resize(100, 120); streaming = await live.capture('partial-wide');
      await mouseAt(live, streaming, 'LIVE_ROW_12');
      const collapsed = await live.capture('partial-collapsed'); assert.equal(collapsed.tools[0].expanded, false);
      writeFileSync(join(live.output, 'shell-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final);
      assert.ok(final.tools[0].content[0].text.includes('LIVE_FINAL'));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('final-expanded'); allBashCards(expanded);
      assert.equal(expanded.tools[0].lines.filter((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_ROW_01').length, 1, 'overlapping built-in snapshots were not appended');
      assert.ok(expanded.screen.some((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_FINAL'));
      const observed = traffic(live, 1);
      writeFileSync(join(artifacts, 'bash-stream-coverage.json'), JSON.stringify({ builtIn: true,
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        updates: live.events().filter((event) => event.type === 'execution_update').length,
        gates: ['provider-go', 'shell-ready', 'shell-final'], snapshots: ['arguments pending', '12-row actual partial', 'expanded partial', '24-column partial', 'final'],
        checked: ['pending theme', 'partial output mouse expansion/collapse', 'resize recomputes hit regions', 'final replaces overlapping snapshots', 'Ctrl+O'] }, null, 2));
    } finally { await closeTerminals([live]); }
  });

test('real CLI: isolated opt-in representative bash metadata, comments and output boundaries',
  { timeout: 90000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { tidyUi: true, extraEnv: { TIDY_UI_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    try {
      const live = await start('bash-shapes'); await live.run('bash-shapes'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, true); allBashCards(wide);
      const tools = byName(wide, 'bash'); assert.equal(tools.length, 14);
      assert.ok(tools[0].lines.some((row) => row.includes('# Representative task description')));
      assert.ok(tools[0].lines.some((row) => row.includes('# Running in ' + resolve(wide.cwd, '../other/./dir'))));
      for (const text of ['(no output)', 'Background task started: task-id-123', '[exit code: 99]', 'Command exited with code 77'])
        assert.ok(tools[0].lines.some((row) => row.includes(text)), `returned literal preserved: ${text}`);
      assert.equal(tools[1].lines.filter((row) => stripVTControlCharacters(row).slice(3, -2).trim()).length, 1, 'whitespace-only output and equivalent cwd produce command only');
      assert.ok(!tools[2].lines.some((row) => row.includes('Running in')), 'absolute current cwd equivalent produces no comment');
      assert.ok(!tools[2].lines.some((row) => row.includes('Click to expand')), 'exactly ten visual output rows have no hint');
      assert.ok(tools[3].lines.some((row) => row.includes('Click to expand')), 'eleven visual output rows have hint');
      assert.ok(!tools[4].lines.some((row) => row.includes('Click to expand')), '221 characters wrap into three visual rows at 100');
      for (const index of [10, 11, 12, 13]) assert.ok(!tools[index].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')), 'zero/string/null/transient status has no footer');
      await bashScreenStyle(wide, '# Representative task description', 'muted', 'toolPendingBg');
      await bashScreenStyle(wide, '[exit code: 7]', 'error', 'toolPendingBg');
      await mouseAt(live, wide, '# Representative task description'); let current = await live.capture('comment-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '# Running in', { offset: 1 }); current = await live.capture('comment-gap-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '[exit code: 7]'); current = await live.capture('footer-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await live.resize(24, 240); const narrow = await live.capture('narrow'); allBashCards(narrow);
      assert.ok(narrow.tools[4].lines.some((row) => row.includes('… (Click')), 'more than ten W-5 visual output rows use a ten-row preview; allBashCards independently checks the complete shortened hint');
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      await live.resize(100, 240); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded'); allBashCards(expanded);
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.tools[3].lines.some((row) => row.includes('SHAPE_ROW_11')));
      live.send('\x0f'); await live.settle();
      const native = await start('bash-shapes-native', { tidyUi: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); assert.deepEqual(persisted(control), persisted(wide));
      await live.appearance(false); const off = await live.capture('off');
      assert.deepEqual(off.tools.map((tool) => tool.content), control.tools.map((tool) => tool.content));
      await live.appearance(true); allBashCards(await live.capture('on'));
      await live.appearance(false); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live native fixture rendering restored exactly');
      await live.appearance(true);
      const observed = traffic(live, 14);
      const replay = await start('bash-shapes-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'details footer is stable live/replay; transient structuredContent intentionally ignored');
      assert.deepEqual(persisted(resumed), persisted(wide));
      await replay.appearance(false); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'same-session fixture native replay restored exactly');
      await replay.appearance(true);
      // Independent invocation for partial/final replacement, never an installed AFT execution.
      const stream = await start('bash-shape-stream'); stream.send('run bash-shape-stream\r'); await stream.event('shape_gate');
      let partial = await stream.capture('partial-one'); allBashCards(partial, { partial: true });
      assert.ok(!partial.tools[0].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')));
      await bashScreenStyle(partial, 'OLD_PARTIAL', 'toolOutput', 'toolPendingBg');
       await mouseAt(stream, partial, 'Streaming comment');
       partial = await stream.capture('stream-comment-click'); assert.equal(partial.tools[0].expanded, true);
       await mouseAt(stream, partial, 'Streaming comment', { offset: 1 });
       partial = await stream.capture('stream-comment-gap-collapse'); assert.equal(partial.tools[0].expanded, false);
       await mouseAt(stream, partial, '… (Click to expand)');
      partial = await stream.capture('partial-expanded'); allBashCards(partial, { partial: true }); assert.equal(partial.tools[0].expanded, true);
      writeFileSync(join(stream.output, 'shape-next'), 'go'); await stream.event('shape_gate', 2);
      const replacement = await stream.capture('partial-two'); allBashCards(replacement, { partial: true });
      assert.ok(!replacement.tools[0].lines.some((row) => row.includes('OLD_PARTIAL') || row.includes('SHAPE_ROW_')));
      assert.ok(replacement.tools[0].lines.some((row) => row.includes('REPLACEMENT_PARTIAL')));
      writeFileSync(join(stream.output, 'shape-final'), 'go'); await stream.event('agent_end');
      const final = await stream.capture('final'); allBashCards(final);
      assert.deepEqual(final.tools[0].content, [{ type: 'text', text: 'FINAL_ONLY' }]);
      assert.ok(!final.tools[0].lines.some((row) => row.includes('PARTIAL')));
      await bashScreenStyle(final, '[exit code: 7; error: execution failed]', 'error', 'toolPendingBg');
      traffic(stream, 1);
      writeFileSync(join(artifacts, 'bash-shapes-coverage.json'), JSON.stringify({ installedAFT: false, optIn: 'TIDY_UI_TEST_BASH_SHAPE=1',
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        streamCalls: 1, streamUpdates: stream.events().filter((event) => event.type === 'execution_update').length,
        cases: bashArguments(wide).map((args) => args.fixtureCase), widths: [100, 24, 100],
        checked: ['description/workdir comments', 'equivalent cwd omission', 'whitespace-only and interior blanks', 'literal task/status text', '10/11 visual rows',
          'structured persisted status combinations', 'transient structuredContent ignored', 'nonexpandable comments/gaps/footer ignored; streaming expandable comment/gap toggle', 'stream snapshots replace', 'partial footer suppressed', 'final generic error footer', 'native off/replay data identity'] }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });

test('real CLI: isolated bash presentation exceptions preserve exact traffic',
  { timeout: 150000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { tidyUi: true, extraEnv: { TIDY_UI_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 360); return terminal;
    };
    const row = (count) => Array.from({ length: count }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`);
    // Fresh literal fixture expectations: these checks do not derive expected traffic from the layout oracle.
    const cases = [
      ['suffix-match', 'BODY\n \t\n[exit code: 7]\n\n \t', 7, false],
      ['suffix-mismatch', 'BODY\n\n[exit code: 8]', 7, false],
      ['suffix-no-gap', 'BODY\n[exit code: 7]', 7, false],
      ['suffix-combined', 'BODY\n\n[exit code: -2; error: execution failed]', -2, true],
      ['suffix-error-only', 'BODY\n\n[error: execution failed]', undefined, true],
      ['suffix-error-mismatch', 'BODY\n\n[exit code: 7]', 7, true],
      ['suffix-success', 'BODY\n\n[exit code: 0]', 0, false],
      ['suffix-unknown', 'BODY\n\n[exit code: 7]', undefined, false],
      ['suffix-string', 'BODY\n\n[exit code: 7]', '7', false],
      ['suffix-indent', 'BODY\n\n [exit code: 7]', 7, false],
      ['suffix-spaces', 'BODY\n\n[exit code: 7] ', 7, false],
      ['suffix-fragment', 'BODY\n\nPREFIX [exit code: 7]', 7, false],
      ['suffix-nonterminal', 'BODY\n\n[exit code: 7]\nAFTER_SUFFIX', 7, false],
      ['suffix-double', 'BODY\n\n[exit code: 7]\n\n[exit code: 7]', 7, false],
      ['preview-one-blank', row(9).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-two-blanks', row(9).join('\n') + '\n\n \t\nHIDDEN_TAIL', undefined, false],
      ['preview-interior', row(3).join('\n') + '\n\n' + row(5).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-empty', ' '.repeat(1100) + 'HIDDEN_TAIL', undefined, false],
      ['suffix-deep', row(9).join('\n') + '\n\nEXTRA_CONTENT\nHIDDEN_TAIL\n\n[exit code: 7]', 7, false],
      ['suffix-only', '\n[exit code: 7]', 7, false],
    ];
    const body = (tool) => {
      const rows = tool.lines.map(stripVTControlCharacters);
      const top = rows.findIndex((line) => line.includes('┃'));
      return rows.slice(top + 1, -1).map((line) => line.slice(3, -2));
    };
    const byCase = (dump, name) => {
      const index = cases.findIndex(([fixtureCase]) => fixtureCase === name);
      assert.ok(index >= 0); return byName(dump, 'bash')[index];
    };
    const literalCount = (dump, name, literal, count) => assert.equal(
      body(byCase(dump, name)).filter((line) => line.includes(literal)).length, count, `${name}: exact visible count of ${literal}`);
    const identity = (actual, baseline, sessionBytes) => {
      assert.deepEqual(actual.branch, baseline.branch, 'complete branch remains byte-value exact');
      assert.deepEqual(persisted(actual), persisted(baseline), 'all persisted calls/results remain exact');
      assert.deepEqual(actual.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })),
        baseline.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })), 'live raw tool state remains exact');
      assert.equal(readFileSync(actual.session, 'utf8'), sessionBytes, 'saved session bytes unchanged by presentation');
    };
    const previewChecks = (dump) => {
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(dump, name));
        const hint = rows.findIndex((line) => line.startsWith('… (Click'));
        assert.ok(hint > 0, `${name}: overflow hint remains present`);
        assert.ok(rows[hint - 1].trim(), `${name}: no whitespace-only preview end before hint`);
        const first = rows.findIndex((line) => line.trimEnd() === 'SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5)] : row(9);
        assert.deepEqual(rows.slice(first, hint).map((line) => line.trimEnd()), expected, `${name}: nine rows, interior blanks preserved, no backfill`);
        assert.ok(!rows.some((line) => /HIDDEN_TAIL|EXTRA_CONTENT/.test(line)), `${name}: hidden later rows stay hidden`);
      }
      const empty = body(byCase(dump, 'preview-empty')).map((line) => line.trimEnd());
      const emptyHint = empty.findIndex((line) => line.startsWith('… (Click'));
      const commandRows = Math.ceil('$ shape preview-empty'.length / bashGeometry(dump.width).content);
      assert.equal(emptyHint, commandRows + 1, 'all-whitespace preview retains only the synthetic output section separator before hint');
      assert.equal(empty[emptyHint - 1], '');
      assert.ok(!empty.some((line) => line.includes('HIDDEN_TAIL')), 'empty preview never backfills the hidden nonblank row');
    };
    try {
      const live = await start('bash-shape-exceptions'); await live.run('bash-shape-exceptions');
      const wide = await live.capture('wide'); assert.equal(wide.bashShape, true); allBashCards(wide);
      assert.equal(wide.tools.length, 20);
      const observed = traffic(live, 20), sessionBytes = readFileSync(wide.session, 'utf8');
      const rawResults = cases.map(([, text, code, isError]) => ({ name: 'bash', content: [{ type: 'text', text }],
        ...(code === undefined ? {} : { details: { exit_code: code } }), isError }));
      const resultEvents = observed.filter((event) => event.type === 'result').map(({ type, ...result }) => result);
      assert.deepEqual(resultEvents, rawResults, 'every original output, trailing space, separator and metadata reaches tool_result exactly');
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        cases.map(([fixtureCase]) => ({ command: 'shape ' + fixtureCase, fixtureCase })), 'only harmless unique isolated commands are requested');
      observed.filter((event) => event.type === 'model_context').forEach((event, index) =>
        assert.deepEqual(event.results, rawResults.slice(0, index), `provider context ${index}: exact original cumulative results`));
      assert.deepEqual(persisted(wide).filter((entry) => entry.role === 'toolResult'),
        rawResults.map(({ name, details, ...result }) => ({ role: 'toolResult', toolName: name, ...result, details })), 'saved messages retain original suffixes and blanks');
      for (const name of ['suffix-match', 'suffix-combined']) {
        const footer = name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]';
        literalCount(wide, name, footer, 1);
        assert.deepEqual(body(byCase(wide, name)).map((line) => line.trimEnd()), ['$ shape ' + name, '', 'BODY', '', footer], 'only duplicated terminal block disappears');
      }
      literalCount(wide, 'suffix-only', '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-only')).map((line) => line.trimEnd()),
        ['$ shape suffix-only', '', '[exit code: 7]'], 'suffix-only output becomes an absent output section, not an extra footer');
      for (const name of ['suffix-no-gap', 'suffix-indent', 'suffix-spaces', 'suffix-fragment', 'suffix-nonterminal', 'suffix-double'])
        literalCount(wide, name, '[exit code: 7]', 2);
      literalCount(wide, 'suffix-mismatch', '[exit code: 8]', 1);
      literalCount(wide, 'suffix-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-only', '[error: execution failed]', 2);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7; error: execution failed]', 1);
      literalCount(wide, 'suffix-success', '[exit code: 0]', 1);
      for (const name of ['suffix-unknown', 'suffix-string', 'suffix-deep']) literalCount(wide, name, '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-no-gap')).map((line) => line.trimEnd()),
        ['$ shape suffix-no-gap', '', 'BODY', '[exit code: 7]', '', '[exit code: 7]'], 'missing separator preserves literal');
      previewChecks(wide);
      await bashScreenStyle(wide, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      for (const theme of ['light', 'dark']) {
        await live.command('/tidy-ui-theme ' + theme); const themed = await live.capture('theme-' + theme);
        allBashCards(themed); identity(themed, wide, sessionBytes);
        await bashScreenStyle(themed, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      }
      await live.resize(24, 360); const narrow = await live.capture('narrow'); allBashCards(narrow); previewChecks(narrow);
      identity(narrow, wide, sessionBytes); for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      live.send('\x0f'); await live.settle(); const narrowExpanded = await live.capture('narrow-expanded'); allBashCards(narrowExpanded);
      assert.ok(narrowExpanded.tools.every((tool) => tool.expanded)); identity(narrowExpanded, wide, sessionBytes);
      await live.resize(100, 360); const expanded = await live.capture('expanded'); allBashCards(expanded); identity(expanded, wide, sessionBytes);
      for (const name of ['suffix-match', 'suffix-combined']) literalCount(expanded, name,
        name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]', 1);
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(expanded, name)).map((line) => line.trimEnd());
        const first = rows.indexOf('SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5), '', 'HIDDEN_TAIL'] :
          name === 'suffix-deep' ? [...row(9), '', 'EXTRA_CONTENT', 'HIDDEN_TAIL', '', '[exit code: 7]'] :
          [...row(9), '', ...(name === 'preview-two-blanks' ? [''] : []), 'HIDDEN_TAIL'];
        assert.deepEqual(rows.slice(first), expected, `${name}: expansion retains all internal blank rows and hidden text`);
      }
      const emptyExpanded = body(byCase(expanded, 'preview-empty'));
      assert.equal(emptyExpanded.length, 14, 'expanded whitespace-prefix output retains all twelve visual output rows plus command and separator');
      assert.ok(emptyExpanded.slice(2, -1).every((line) => !line.trim()), 'eleven expanded whitespace-only content rows are not trimmed');
      assert.equal(emptyExpanded.at(-1).trim(), 'HIDDEN_TAIL');
      live.send('\x0f'); await live.settle(); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); identity(back, wide, sessionBytes);
      await live.appearance(false); const off = await live.capture('off'); identity(off, wide, sessionBytes);
      await live.appearance(true); allBashCards(await live.capture('on'));
      await live.appearance(false); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'live native renderer restored without normalization');
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.appearance(true); await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); allBashCards(reloaded); identity(reloaded, wide, sessionBytes);
      assert.deepEqual(reloaded.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'same-session reload preserves exception presentation');
      const native = await start('bash-shape-exceptions-native', { tidyUi: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); identity(control, wide, sessionBytes);
      await live.appearance(false); const reloadedOff = await live.capture('reloaded-off'); identity(reloadedOff, wide, sessionBytes);
      assert.deepEqual(reloadedOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'reloaded native output matches stock history byte-for-byte');
      const replay = await start('bash-shape-exceptions-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); identity(resumed, wide, sessionBytes);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      await replay.appearance(false); const replayOff = await replay.capture('off'); identity(replayOff, wide, sessionBytes);
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'disabled same-session replay restores exact native rendering');
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter((event) => event.type === type).length, 0, `history ${type} count remains zero`);
      assert.deepEqual(traffic(live, 20), observed, 'resize/theme/Ctrl+O/off/on/reload never rerun tool or provider');
      assert.equal(readFileSync(wide.session, 'utf8'), sessionBytes);
      writeFileSync(join(artifacts, 'bash-shape-exceptions-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TIDY_UI_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        historyCalls: [native, replay].reduce((sum, terminal) => sum + terminal.events().filter((event) => event.type === 'call').length, 0),
        cases: cases.map(([name]) => name), widths: [100, 24, 100], themes: ['dark', 'light', 'dark'],
        checked: ['exact metadata-only terminal suffix', 'no-gap/mismatch/error-only/string/unknown/success literals retained',
          'one trailing block only', 'unwrapped footer comparison at narrow width', 'preview end blanks removed without backfill',
          'preview interior blanks and expanded blank rows retained', 'empty preview keeps only synthetic section separator', 'strict raw tool/session/branch/model/calls/context identity',
          'Ctrl+O', 'footer semantic cells', 'off/on/reload/native/history replay'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution', 'production bounded wrapping checked by parent unit tests'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });

test('real CLI: isolated bash presentation exceptions partial-to-final gate',
  { timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { tidyUi: true, extraEnv: { TIDY_UI_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const raw = Array.from({ length: 9 }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`).join('\n') + '\n\n[exit code: 7]';
    const original = { content: [{ type: 'text', text: raw }], details: { exit_code: 7 }, isError: false };
    const rawIdentity = (dump) => assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), [original]);
    const visibleCount = (dump) => dump.tools[0].lines.filter((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd() === '[exit code: 7]').length;
    try {
      const live = await start('bash-shape-exception-stream'); live.send('run bash-shape-exception-stream\r');
      await live.event('shape_exception_gate');
      const partial = await live.capture('partial'); allBashCards(partial, { partial: true }); rawIdentity(partial);
      assert.equal(partial.tools[0].partial, true); assert.equal(partial.tools[0].expanded, false);
      const preview = partial.tools[0].lines.map(plain), hint = preview.findIndex((line) => line.includes('… (Click'));
      assert.ok(hint > 0); assert.ok(preview[hint - 1].includes('SHAPE_ROW_09'), 'partial preview trims blank tenth row without backfill');
      assert.equal(visibleCount(partial), 0, 'partial suffix is hidden by preview, not rendered as a synthesized status');
      await mouseAt(live, partial, '… (Click to expand)');
      const partialExpanded = await live.capture('partial-expanded'); allBashCards(partialExpanded, { partial: true }); rawIdentity(partialExpanded);
      assert.equal(partialExpanded.tools[0].expanded, true); assert.equal(visibleCount(partialExpanded), 1, 'expanded partial retains exact output suffix');
      const partialRows = partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd());
      assert.equal(partialRows[partialRows.indexOf('[exit code: 7]') - 1], '', 'partial retains the output blank separator');
      await bashScreenStyle(partialExpanded, '[exit code: 7]', 'toolOutput', 'toolPendingBg');
      await live.resize(24, 120); const narrow = await live.capture('partial-narrow');
      allBashCards(narrow, { partial: true }); rawIdentity(narrow); assert.equal(narrow.tools[0].expanded, true);
      await live.resize(100, 120);
      writeFileSync(join(live.output, 'shape-exception-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final); rawIdentity(final);
      assert.equal(final.tools[0].partial, false); assert.equal(final.tools[0].expanded, true);
      assert.equal(visibleCount(final), 1, 'final matching status appears exactly once, as metadata footer');
      assert.deepEqual(final.tools[0].lines.map((line) => stripVTControlCharacters(line)),
        partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line)), 'partial literal and final synthesized footer have identical plain rows');
      await bashScreenStyle(final, '[exit code: 7]', 'error', 'toolPendingBg');
      // A local hint click does not change Pi's global Ctrl+O setting (initially collapsed).
      // First synchronize global expansion, then toggle global collapse; assert both actual states.
      live.send('\x0f'); await live.settle(); const globalExpanded = await live.capture('final-global-expanded');
      allBashCards(globalExpanded); rawIdentity(globalExpanded); assert.equal(globalExpanded.tools[0].expanded, true);
      live.send('\x0f'); await live.settle(); const collapsed = await live.capture('final-collapsed'); allBashCards(collapsed); rawIdentity(collapsed);
      assert.equal(collapsed.tools[0].expanded, false); assert.equal(visibleCount(collapsed), 1);
      assert.ok(!collapsed.tools[0].lines.some((line) => line.includes('Click to expand')), 'final dedup leaves nine output rows: no overflow hint');
      await live.resize(24, 120); const narrowFinal = await live.capture('final-narrow'); allBashCards(narrowFinal); rawIdentity(narrowFinal);
      assert.ok(!narrowFinal.tools[0].lines.some((line) => line.includes('… (Click')), 'dedup uses logical unwrapped suffix at 24 columns too');
      await live.resize(100, 120);
      const observed = traffic(live, 1);
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        [{ command: 'shape exception-stream', fixtureCase: 'exception-stream' }]);
      assert.deepEqual(observed.filter((event) => event.type === 'result').map(({ type, name, ...result }) => result), [original]);
      assert.deepEqual(observed.filter((event) => event.type === 'model_context').map((event) => event.results),
        [[], [{ name: 'bash', ...original }]], 'final model context receives exact original suffix and blank');
      const updates = live.events().filter((event) => event.type === 'execution_update');
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].partialResult, original, 'one exact partial snapshot, not concatenated output');
      assert.deepEqual(persisted(final).filter((entry) => entry.role === 'toolResult'), [{ role: 'toolResult', toolName: 'bash', ...original }]);
      const sessionBytes = readFileSync(final.session, 'utf8');
      const replay = await start('bash-shape-exception-stream-replay', { session: final.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); rawIdentity(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), collapsed.tools.map((tool) => tool.lines));
      assert.deepEqual(resumed.branch, final.branch); assert.deepEqual(persisted(resumed), persisted(final));
      assert.equal(readFileSync(final.session, 'utf8'), sessionBytes, 'history did not rewrite original result');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.events().filter((event) => event.type === type).length, 0);
      assert.deepEqual(traffic(live, 1), observed);
      writeFileSync(join(artifacts, 'bash-shape-exception-stream-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TIDY_UI_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        updates: updates.length, replayCalls: replay.events().filter((event) => event.type === 'call').length,
        gates: ['shape-exception-final'], widths: [100, 24, 100],
        checked: ['unchanged partial/final original content', 'partial suffix retained with output color', 'final dedup with error color',
          'blank preview edge trimmed while partial', 'real hint click', 'final nine-row no-overflow preview',
          'narrow unwrapped match', 'Ctrl+O', 'exact model/session/history identity'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });

test('real CLI: actual-screen complete command width regression', { timeout: 120000 }, async () => {
  const terminals = [], captures = [];
  const originalPython = "python3 -c \"from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))\" && node --check /tmp/neon-blocks-check.js";
  const commands = ["printf '" + 'LONGWORD'.repeat(30) + "'", originalPython.replaceAll('/tmp/neon-blocks-check.js', 'neon-blocks-check.js')];
  assert.equal(commands[0].length, 249, 'exact 249 ASCII-char safe built-in longword command');
  const start = async (name, options) => {
    const terminal = new PiTerminal(name, { tidyUi: true, ...options }); terminals.push(terminal);
    await terminal.ready(); await terminal.resize(100, 150); return terminal;
  };
  const observe = async (terminal, phase, settings) => {
    let baseline;
    for (const width of [100, 24, 140, 100]) {
      await terminal.resize(width, 150);
      const dump = await terminal.capture(`width-${phase}-${width}-${captures.length}`);
      assert.equal(dump.bashShape, false, 'native built-in bash is never replaced');
      assert.deepEqual(byName(dump, 'bash').map((tool) => tool.args.command), commands, 'original executed args remain exact');
      assert.deepEqual(bashArguments(dump).map((args) => args.command), commands, 'persisted commands remain exact');
      const observed = await actualCommandCells(dump, commands, settings);
      captures.push({ phase, mode: settings.mode, scrollbar: settings.scrollbar, viewportWidth: width, commands: observed });
      baseline ??= persisted(dump);
      assert.deepEqual(persisted(dump), baseline, 'resize cannot change persisted content');
    }
    return baseline;
  };
  try {
    for (const settings of [{ mode: 'fullscreen', scrollbar: 'auto' }, { mode: 'fullscreen', scrollbar: 'always' },
      { mode: 'regular', scrollbar: 'auto' }]) {
      const options = { mode: settings.mode, agentSettings: { fullscreenScrollbar: settings.scrollbar } };
      const live = await start(`width-${settings.mode}-${settings.scrollbar}-live`, options);
      writeFileSync(join(live.work, 'index.html'), '<html><script>const neonBlocksCheck = 1;\n</script></html>\n');
      await live.run('bash-width');
      const trafficBefore = traffic(live, 2);
      assert.ok(live.events().filter((event) => event.type === 'result').every((event) => !event.isError), 'both real commands succeed');
      assert.deepEqual(live.events().filter((event) => event.type === 'call').map((event) => event.input.command), commands);
      assert.equal(readFileSync(join(live.work, 'neon-blocks-check.js'), 'utf8'), 'const neonBlocksCheck = 1;\n', 'only owned workspace receives Python output');
      const beforeReplay = await observe(live, 'live', settings);
      assert.deepEqual(traffic(live, 2), trafficBefore, 'width transitions do not execute tools or provider again');
      const session = live.session; await live.close();
      const replay = await start(`width-${settings.mode}-${settings.scrollbar}-replay`, { ...options, session, workspace: live.work });
      const afterReplay = await observe(replay, 'replay', settings);
      assert.deepEqual(afterReplay, beforeReplay, 'same-session replay retains exact arguments/results');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `replay ${type} counter stays zero`);
      await replay.close();
    }
    writeFileSync(join(artifacts, 'actual-command-width-coverage.json'), JSON.stringify({
      originalPythonTextOnly: originalPython, executedCommands: commands,
      originalFixedTmpPathExecuted: false, installedAFTExecuted: false,
      liveInvocations: 3, calls: 6, results: 6, modelContexts: 9, replayInvocations: 3, replayCalls: 0,
      captures, checked: ['physical ASCII command cells', 'exact hardwrap reconstruction preserving whitespace',
        'observed allocated width', 'one inner/exterior cell on each side', 'full panel painting', 'same-session replay', 'resize back'],
    }, null, 2));
  } finally { await closeTerminals(terminals.reverse()); }
});

for (const mode of ['regular', 'fullscreen']) test(`real CLI: isolated bash timeout tails preserve exact traffic (${mode})`,
  { timeout: 180000 }, async () => {
    const terminals = [], footer = '[exit code: 124; error: command timed out]';
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal('bash-timeout-' + mode + '-' + name,
        { tidyUi: true, mode, extraEnv: { TIDY_UI_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 260); return terminal;
    };
    const row = (count) => Array.from({ length: count }, (_, index) => `SHAPE_ROW_${String(index + 1).padStart(2, '0')}`);
    // Literal expectations are independent of both the presenter and fixture implementation.
    const cases = [
      ['timeout-match', 'BODY\n \t\n[command timed out]\n[exit code: 124]\n \n', 124, false],
      ['timeout-both', 'BODY\n\n[command timed out]\n[exit code: 124]', 124, true],
      ['timeout-only', '\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-no-gap', 'BODY\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-mismatch', 'BODY\n\n[command timed out]\n[exit code: 125]', 124, false],
      ['timeout-string', 'BODY\n\n[command timed out]\n[exit code: 124]', '124', false],
      ['timeout-unknown', 'BODY\n\n[command timed out]\n[exit code: 124]', undefined, false],
      ['timeout-code-only', 'BODY\n\n[exit code: 124]', 124, false],
      ['timeout-interior', 'BODY\n\n[command timed out]\n[exit code: 124]\nAFTER_TIMEOUT', 124, false],
      ['timeout-preview', row(9).join('\n') + '\n\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-deep', row(11).join('\n') + '\n\n[command timed out]\n[exit code: 124]', 124, false],
      ['timeout-indent', 'BODY\n\n [command timed out]\n[exit code: 124]', 124, false],
    ];
    const matching = ['timeout-match', 'timeout-both', 'timeout-only', 'timeout-preview', 'timeout-deep'];
    const tool = (dump, name) => dump.tools[cases.findIndex(([fixtureCase]) => fixtureCase === name)];
    const body = (value) => {
      const rows = value.lines.map(stripVTControlCharacters), top = rows.findIndex((line) => line.includes('┃'));
      return rows.slice(top + 1, -1).map((line) => line.slice(3, -2).trimEnd());
    };
    const identity = (dump, baseline, bytes) => {
      assert.deepEqual(dump.branch, baseline.branch);
      assert.deepEqual(persisted(dump), persisted(baseline));
      const raw = ({ id, args, content, details, isError }) => ({ id, args, content, details, isError });
      assert.deepEqual(dump.tools.map(raw), baseline.tools.map(raw));
      assert.equal(readFileSync(dump.session, 'utf8'), bytes, 'presentation must not rewrite the saved timeout marker or code');
    };
    const physicalSamples = [];
    const timeoutCells = async (dump, label) => {
      const error = await referenceCell(dump.summaryStyles.error), background = await referenceCell(dump.backgroundStyles.toolPendingBg);
      for (const name of matching) {
        // Keep the full frame width: painted terminal spaces are not necessarily
        // trimmed by xterm. Never compare trimmed component rows to full cells.
        const component = tool(dump, name).lines.map(stripVTControlCharacters);
        if (component[0] === '') component.shift();
        const start = dump.screen.findIndex((_, index) => component.every((line, offset) => dump.screen[index + offset]?.padEnd(dump.width) === line));
        assert.ok(start >= 0, `${name}: entire actual panel is on the physical screen at ${dump.width} columns`);
        const available = dump.width - 5, fragments = hardRows(footer, available);
        const first = component.length - 1 - fragments.length;
        assert.deepEqual(component.slice(first, -1).map((line) => line.slice(3, -2)), fragments.map((line) => line.padEnd(available)), 'complete physical frame rows preserve footer fragments and right padding');
        let checkedCells = 0;
        for (const [offset, fragment] of fragments.entries()) {
          const y = start + first + offset;
          for (let x = 3; x < 3 + fragment.length; x++) {
            const cell = dump.cells[y][x];
            assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
              { fg: error.fg, fgMode: error.fgMode, dim: error.dim }, `${name}: every footer cell uses error, including wrapped rows`);
            assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: background.bg, bgMode: background.bgMode });
            checkedCells++;
          }
          const stripe = dump.cells[y][1];
          assert.deepEqual({ fg: stripe.fg, fgMode: stripe.fgMode, dim: stripe.dim }, { fg: error.fg, fgMode: error.fgMode, dim: error.dim });
          for (const x of [0, 1, dump.width - 1]) assert.equal(dump.cells[y][x].bgMode, 0);
        }
        physicalSamples.push({ label, name, width: dump.width, footerRows: fragments.length, checkedCells });
      }
    };
    const wideChecks = (dump) => {
      for (const name of matching) {
        const rows = body(tool(dump, name));
        assert.equal(rows.filter((line) => line === footer).length, 1, `${name}: exactly one own timeout footer`);
        assert.ok(!rows.includes('[command timed out]') && !rows.includes('[exit code: 124]'), `${name}: both original service rows disappear`);
      }
      assert.deepEqual(body(tool(dump, 'timeout-only')), ['$ shape timeout-only', '', footer], 'timeout-only output leaves no empty output section');
      assert.deepEqual(body(tool(dump, 'timeout-preview')), ['$ shape timeout-preview', '', ...row(9), '', footer], 'timeout tail does not cause a false overflow hint');
      for (const name of ['timeout-no-gap', 'timeout-mismatch', 'timeout-string', 'timeout-unknown', 'timeout-interior', 'timeout-indent']) {
        const rows = body(tool(dump, name));
        assert.ok(rows.some((line) => line.includes('[command timed out]')), `${name}: original marker remains output`);
        assert.ok(!rows.includes(footer), `${name}: no synthesized timeout label`);
      }
      assert.deepEqual(body(tool(dump, 'timeout-code-only')), ['$ shape timeout-code-only', '', 'BODY', '', '[exit code: 124]']);
    };
    try {
      const live = await start('live'); await live.run('bash-shape-timeouts');
      const wide = await live.capture('wide'); allBashCards(wide); wideChecks(wide); await timeoutCells(wide, 'wide');
      const observed = traffic(live, cases.length), bytes = readFileSync(wide.session, 'utf8');
      const rawResults = cases.map(([, text, code, isError]) => ({ name: 'bash', content: [{ type: 'text', text }],
        ...(code === undefined ? {} : { details: { exit_code: code } }), isError }));
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        cases.map(([fixtureCase]) => ({ command: 'shape ' + fixtureCase, fixtureCase })));
      assert.deepEqual(observed.filter((event) => event.type === 'result').map(({ type, ...value }) => value), rawResults);
      observed.filter((event) => event.type === 'model_context').forEach((event, index) =>
        assert.deepEqual(event.results, rawResults.slice(0, index), `model context ${index}: exact original timeout text and metadata`));
      assert.deepEqual(persisted(wide).filter((entry) => entry.role === 'toolResult'),
        rawResults.map(({ name, details, ...value }) => ({ role: 'toolResult', toolName: name, ...value, details })));
      for (const theme of ['light', 'dark']) {
        await live.command('/tidy-ui-theme ' + theme); const dump = await live.capture('theme-' + theme);
        allBashCards(dump); wideChecks(dump); identity(dump, wide, bytes); await timeoutCells(dump, theme);
      }
      await live.resize(24, 360); const narrow = await live.capture('narrow'); allBashCards(narrow); identity(narrow, wide, bytes);
      await timeoutCells(narrow, 'narrow');
      assert.ok(!body(tool(narrow, 'timeout-preview')).some((line) => line.includes('Click')), 'filtering compares logical rows before wrapping');
      for (const value of narrow.tools) await assertFits(value.lines, 24);
      live.send('\x0f'); await live.settle(); const narrowExpanded = await live.capture('narrow-expanded');
      allBashCards(narrowExpanded); identity(narrowExpanded, wide, bytes); await timeoutCells(narrowExpanded, 'narrow-expanded');
      assert.ok(narrowExpanded.tools.every((value) => value.expanded));
      await live.resize(100, 260); const expanded = await live.capture('expanded');
      allBashCards(expanded); identity(expanded, wide, bytes); wideChecks(expanded); await timeoutCells(expanded, 'expanded');
      assert.deepEqual(body(tool(expanded, 'timeout-deep')), ['$ shape timeout-deep', '', ...row(11), '', footer]);
      live.send('\x0f'); await live.settle(); const collapsed = await live.capture('collapsed');
      assert.deepEqual(collapsed.tools.map((value) => value.lines), wide.tools.map((value) => value.lines)); identity(collapsed, wide, bytes);
      await live.appearance(false); const off = await live.capture('off'); identity(off, wide, bytes);
      await live.appearance(true); const on = await live.capture('on');
      allBashCards(on); identity(on, wide, bytes); assert.deepEqual(on.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); allBashCards(reloaded); identity(reloaded, wide, bytes);
      assert.deepEqual(reloaded.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      const native = await start('native', { tidyUi: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); identity(control, wide, bytes);
      await live.appearance(false); const reloadedOff = await live.capture('reloaded-off'); identity(reloadedOff, wide, bytes);
      assert.deepEqual(reloadedOff.tools.map((value) => value.lines), control.tools.map((value) => value.lines), 'off restores exact native history');
      const replay = await start('replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); identity(resumed, wide, bytes); wideChecks(resumed); await timeoutCells(resumed, 'replay');
      assert.deepEqual(resumed.tools.map((value) => value.lines), wide.tools.map((value) => value.lines));
      await replay.appearance(false); const replayOff = await replay.capture('off'); identity(replayOff, wide, bytes);
      assert.deepEqual(replayOff.tools.map((value) => value.lines), control.tools.map((value) => value.lines));
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter((event) => event.type === type).length, 0, `history ${type} remains zero`);
      assert.deepEqual(traffic(live, cases.length), observed);

      const stream = await start('stream'); stream.send('run bash-shape-timeout-stream\r'); await stream.event('shape_timeout_gate');
      const raw = row(9).join('\n') + '\n\n[command timed out]\n[exit code: 124]';
      const original = { content: [{ type: 'text', text: raw }], details: { exit_code: 124 }, isError: false };
      const streamIdentity = (dump) => assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), [original]);
      const partial = await stream.capture('partial'); allBashCards(partial, { partial: true }); streamIdentity(partial);
      assert.equal(partial.tools[0].partial, true); assert.ok(body(partial.tools[0]).includes('… (Click to expand)'));
      assert.ok(!body(partial.tools[0]).includes(footer));
      stream.send('\x0f'); await stream.settle(); const partialExpanded = await stream.capture('partial-expanded');
      allBashCards(partialExpanded, { partial: true }); streamIdentity(partialExpanded);
      assert.deepEqual(body(partialExpanded.tools[0]), ['$ shape timeout-stream', '', ...row(9), '', '[command timed out]', '[exit code: 124]']);
      await bashScreenStyle(partialExpanded, '[command timed out]', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(partialExpanded, '[exit code: 124]', 'toolOutput', 'toolPendingBg');
      writeFileSync(join(stream.output, 'shape-timeout-final'), 'go'); await stream.event('agent_end');
      const final = await stream.capture('final'); allBashCards(final); streamIdentity(final);
      assert.equal(final.tools[0].partial, false); assert.deepEqual(body(final.tools[0]), ['$ shape timeout-stream', '', ...row(9), '', footer]);
      await bashScreenStyle(final, footer, 'error', 'toolPendingBg');
      stream.send('\x0f'); await stream.settle(); const streamCollapsed = await stream.capture('collapsed'); allBashCards(streamCollapsed); streamIdentity(streamCollapsed);
      assert.equal(streamCollapsed.tools[0].expanded, false); assert.ok(!body(streamCollapsed.tools[0]).some((line) => line.includes('Click')));
      const streamTraffic = traffic(stream, 1), updates = stream.events().filter((event) => event.type === 'execution_update');
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'call').map((event) => event.input),
        [{ command: 'shape timeout-stream', fixtureCase: 'timeout-stream' }]);
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'result').map(({ type, name, ...value }) => value), [original]);
      assert.deepEqual(streamTraffic.filter((event) => event.type === 'model_context').map((event) => event.results), [[], [{ name: 'bash', ...original }]]);
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].partialResult, original);
      assert.deepEqual(persisted(final).filter((entry) => entry.role === 'toolResult'), [{ role: 'toolResult', toolName: 'bash', ...original }]);
      writeFileSync(join(artifacts, 'bash-timeout-' + mode + '-coverage.json'), JSON.stringify({ installedAFT: false, mode,
        optIn: 'TIDY_UI_TEST_BASH_SHAPE=1', calls: cases.length, results: cases.length, modelContexts: cases.length + 1,
        streamCalls: 1, streamResults: 1, streamContexts: 2, updates: updates.length, historyCalls: 0,
        cases: cases.map(([name]) => name), widths: [100, 24, 100], themes: ['dark', 'light', 'dark'], physicalSamples,
        checked: ['one exact separated terminal timeout pair', 'code-only/mismatching/string/unknown/interior/indent/no-gap guards',
          'before-preview filtering and real overflow retained', 'all wrapped footer cells error with neutral background',
          'partial literals toolOutput to final own error footer', 'exact raw results/model/session/branch identity',
          'Ctrl+O/off/on/reload/native/replay, no history execution'],
        limitations: ['real CLI with isolated deterministic AFT-shaped results; not installed AFT execution',
          'identical printed terminal pair is an accepted display ambiguity'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });
