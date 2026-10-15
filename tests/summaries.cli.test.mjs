import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, byName, toolLines, assertFits } from './fixtures/terminal-harness.mjs';
import { closeTerminals } from './fixtures/terminal-cleanup.mjs';
import { multilineLayout, persisted, nativeAfterMultiline, simpleBashCards, Terminal, compactContent, summaryText, summaryExpected, errorSummaryColors, leadingBlanks, fixtureBoundedSummary, fixtureQuotedPreview, summarySize } from './fixtures/main-cli-support.mjs';

test('real CLI: complete multiline summaries, adaptive separation, continuation clicks and replay',
  { timeout: 180000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const events = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 19);
      assert.equal(observed.filter((event) => event.type === 'result').length, 19);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 20);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    const flags = ['--tidy-ui-card', 'tidy_ui_card'];
    try {
      const stock = await start('multiline-stock');
      await stock.run('multiline'); const control = await stock.capture('collapsed');
      const live = await start('multiline-tidyUi', { tidyUi: true, flags, workspace: stock.work });
      await live.run('multiline'); const wide = await live.capture('wide');
      multilineLayout(wide);
      assert.deepEqual(events(live), events(stock), '19 real calls/results and 20 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(control), 'full payloads and synthetic secrets remain native session data');
      assert.ok(persisted(wide).some((entry) => entry.arguments?.token === 'TOP_TOKEN_HIDDEN'));
      assert.ok(byName(wide, 'tidy_ui_summary')[0].content[0].text.includes('PAYLOAD_CONTENT_HIDDEN'));
      for (const tool of wide.tools) await assertFits(tool.lines, 100);
      nativeAfterMultiline(byName(wide, 'tidy_ui_card')[0], byName(control, 'tidy_ui_card')[0]);
      simpleBashCards(wide, 'MULTILINE_NATIVE_BASH');
      const reads = byName(wide, 'read');
      const readRow = wide.screen.findIndex((row) => row === lines(reads[2])[0]);
      assert.ok(readRow >= 0, 'real multiline read is on screen');
      assert.deepEqual(wide.screen.slice(readRow, readRow + lines(reads[2]).length), lines(reads[2]), 'every read continuation is real screen content');
      const afterRead = readRow + lines(reads[2]).length;
      assert.equal(wide.screen[afterRead], '', 'one screen gap before following no-args call');
      assert.match(wide.screen[afterRead + 1], /⚙ tidy_ui_noargs$/u);
      assert.match(wide.screen[afterRead + 2], /⚙ tidy_ui_noargs$/u, 'single with leading gap is not counted as multiline');
      assert.match(wide.screen[afterRead + 3], /⚙ tidy_ui_summary/u, 'multiline after single stays adjacent');
      const summary = byName(wide, 'tidy_ui_summary')[0];
      const summaryRow = wide.screen.findIndex((row) => row === lines(summary)[0]);
      assert.ok(summaryRow >= 0);
      assert.deepEqual(wide.screen.slice(summaryRow, summaryRow + lines(summary).length), lines(summary), 'all bounded preview rows appear on the actual wide screen');
      const styleReference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
      try {
        await new Promise((done) => styleReference.write(wide.summaryStyles.dim, done));
        const expectedStyle = styleReference.buffer.active.getLine(0).getCell(0);
        for (let y = summaryRow; y < summaryRow + lines(summary).length; y++) {
          const x = wide.screen[y].search(/\S/u);
          const cell = wide.cells[y][x];
          assert.equal(cell.bgMode, 0, 'continuations have no native-card background');
          if (y > summaryRow) assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
            { fg: expectedStyle.getFgColor(), fgMode: expectedStyle.getFgColorMode(), dim: expectedStyle.isDim() },
            'wrapped parameter rows retain theme dim foreground');
        }
      } finally { styleReference.dispose(); }
      // Real fullscreen SGR on the extension-added gap must not expand either neighbor.
      live.send(`\x1b[<0;4;${afterRead + 1}M\x1b[<0;4;${afterRead + 1}m`);
      await live.settle(); const gap = await live.capture('gap-click');
      assert.ok(gap.tools.every((tool) => !tool.expanded), 'gap ignores primary clicks');
      // Click the last content row (not just the title) of the long built-in read.
      const continuation = gap.screen.findIndex((row) => row === lines(reads[2]).at(-1));
      assert.ok(continuation >= 0);
      live.send(`\x1b[<0;4;${continuation + 1}M\x1b[<0;4;${continuation + 1}m`);
      await live.settle(); const clicked = await live.capture('continuation-click');
      assert.deepEqual(clicked.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [reads[2].id], 'continuation expands precisely the completed built-in read');
      assert.ok(clicked.screen.some((row) => row.includes('LONG_READ_CONTENT')));
      // Collapse via the native title after the expanded long filename wraps.
      const pathRow = clicked.screen.findIndex((row) => row.includes('long-directory/'));
      assert.ok(pathRow > 0);
      const title = pathRow - 1; // Native read wraps a long filename below its title.
      assert.match(clicked.screen[title], /\bread\b/u);
      const titleColumn = clicked.screen[title].indexOf('read') + 1;
      assert.ok(titleColumn > 0);
      live.send(`\x1b[<0;${titleColumn};${title + 1}M\x1b[<0;${titleColumn};${title + 1}m`);
      await live.settle(); multilineLayout(await live.capture('native-collapsed'));
      // The next no-args call owns a leading separator; expand then native-collapse it.
      const withGap = await live.capture('with-gap');
      const emptyRow = withGap.screen.findIndex((row, index) => index > readRow && row.includes('⚙ tidy_ui_noargs'));
      assert.ok(emptyRow >= 0, 'separator-owner compact call is on screen');
      live.send(`\x1b[<0;4;${emptyRow + 1}M\x1b[<0;4;${emptyRow + 1}m`);
      await live.settle(); const emptyExpanded = await live.capture('separator-owner-expanded');
      assert.equal(byName(emptyExpanded, 'tidy_ui_noargs')[0].expanded, true);
      const emptyTitle = emptyExpanded.screen.findIndex((row) => row.includes('tidy_ui_noargs'));
      assert.ok(emptyTitle >= 0);
      const emptyColumn = emptyExpanded.screen[emptyTitle].indexOf('tidy_ui_noargs') + 1;
      live.send(`\x1b[<0;${emptyColumn};${emptyTitle + 1}M\x1b[<0;${emptyColumn};${emptyTitle + 1}m`);
      await live.settle(); multilineLayout(await live.capture('separator-owner-collapsed'));
      await live.resize(24, 120); const narrow = await live.capture('narrow');
      multilineLayout(narrow, wide);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      const compactTools = narrow.tools.filter((tool) => ['read', 'tidy_ui_summary', 'tidy_ui_noargs'].includes(tool.name));
      await t.test('live component render at width zero has no rows', () => {
        for (const tool of compactTools) assert.deepEqual(tool.tinyLines['0'], [], `width zero has no rows: ${tool.id}`);
      });
      await t.test('live component render at widths 1–5 preserves a tool glyph without completion badges', async () => {
        for (const tool of compactTools) {
          for (const width of [1, 2, 3, 4, 5]) {
            assert.deepEqual(tool.tinyLines[width].map(plain).filter((row) => row.trim()), [(width >= 3 ? ' ' : '') + (tool.name === 'read' ? '→' : ['edit', 'write'].includes(tool.name) ? '←' : '⚙')], `width ${width} retains the tool glyph with the margins that fit`);
            await assertFits(tool.tinyLines[width], Math.max(1, width - 1));
          }
        }
      });
      await live.resize(100, 120); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'wide→narrow→wide recalculates content and gaps without drift');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      simpleBashCards(expanded, 'MULTILINE_NATIVE_BASH');
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: nativeExpanded.tools.filter((tool) => tool.name !== 'bash') }), 'Ctrl+O returns exact native cards/results except custom bash');
      assert.deepEqual(persisted(expanded), persisted(wide));
      live.send('\x0f'); await live.settle(); multilineLayout(await live.capture('recollapsed'));
      await live.appearance(false); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.deepEqual(persisted(off), persisted(wide));
      await live.appearance(true); multilineLayout(await live.capture('enabled'));
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); multilineLayout(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = events(live);
      assert.deepEqual(activity, events(stock), 'UI transitions do not re-execute or rewrite model context');
      const session = reloaded.session; await live.close();
      const replay = await start('multiline-replay', { tidyUi: true, flags, session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); multilineLayout(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(wide));
      const nativeReplay = await start('multiline-native-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('replayed');
      await replay.appearance(false); const replayOff = await replay.capture('disabled');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session off restores native rendering exactly');
      const regular = await start('multiline-regular', { tidyUi: true, flags, mode: 'regular' });
      await regular.run('multiline'); const regularWide = await regular.capture('wide'); multilineLayout(regularWide);
      await regular.resize(24, 120); const regularNarrow = await regular.capture('narrow');
      multilineLayout(regularNarrow, regularWide);
      for (const tool of regularNarrow.tools) await assertFits(tool.lines, 24);
      await regular.resize(100, 120); const regularBack = await regular.capture('wide-again');
      assert.deepEqual(regularBack.tools.map((tool) => tool.lines), regularWide.tools.map((tool) => tool.lines));
      regular.send('\x0f'); await regular.settle(); assert.ok((await regular.capture('expanded')).tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'multiline-coverage.json'), JSON.stringify({
        calls: 19, results: 19, modelContexts: 20, widths: [0, 1, 2, 3, 4, 5, 24, 100],
        executed: [...new Set(activity.filter((event) => event.type === 'call').map((event) => event.name))],
        input: ['fullscreen SGR separator ignored', 'fullscreen SGR last continuation expands exact read', 'native mouse collapse', 'separator-owner native coordinate forwarding', 'Ctrl+O fullscreen/regular'],
        lifecycle: ['wide→narrow→wide fullscreen/regular', 'off/on', 'reload', 'same-session stock replay'],
        installedTools: 'Separate installed-profile smoke only; no installed tool execution added by multiline fixture',
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });

test('real CLI: comma wrap points preserve array members and index lists in live and replay output',
  { timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(110, 80); return terminal;
    };
    const activity = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 3);
      assert.equal(observed.filter((event) => event.type === 'result').length, 3);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 4);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    const check = async (dump, width, wholeMembers) => {
      assert.equal(dump.tools.length, 3);
      const args = persisted(dump).filter((entry) => entry.arguments).map((entry) => entry.arguments);
      for (const [index, tool] of dump.tools.entries()) {
        const rows = compactContent(tool);
        const key = ['scope', 'target', 'drop'][index];
        const expected = `tidy_ui_summary [${key}=${JSON.stringify(args[index][key])}]`;
        assert.equal(summaryText(tool), summaryExpected(expected));
        await assertFits(tool.lines, width - 1);
        // Narrow summaries share the same title row; locate the complete call, not its first matching title.
        const y = dump.screen.findIndex((row, index) => row === rows[0] &&
          rows.every((expected, offset) => dump.screen[index + offset] === expected));
        assert.ok(y >= 0, 'complete compact call is present on the real terminal screen');
        assert.deepEqual(dump.screen.slice(y, y + rows.length), rows);
        for (let offset = 0; offset < rows.length; offset++) {
          const x = width - 1;
          assert.ok(['', ' '].includes(dump.cells[y + offset][x].text), 'the rightmost screen cell remains blank');
          assert.equal(dump.cells[y + offset][x].bgMode, 0, 'the reserved column keeps the terminal-default background');
        }
        if (!wholeMembers) continue;
        assert.match(rows[0], /^ ⚙ tidy_ui_summary \[/, 'parameters start on the first row');
        if (Array.isArray(args[index][key])) {
          assert.equal(rows.length, 3);
          for (const member of args[index][key]) {
            assert.equal(rows.filter((row) => row.includes(JSON.stringify(member))).length, 1,
              'each fitting array member remains whole on one row');
          }
        } else {
          assert.match(rows[0], /\[drop="1,2,3,/);
          assert.ok(rows.length >= 2);
          assert.ok(rows.slice(0, -1).every((row) => row.endsWith(',')), 'index list breaks after a comma');
        }
      }
    };
    try {
      const stock = await start('comma-wrap-stock');
      await stock.run('comma-wrap'); const native = await stock.capture('native');
      const live = await start('comma-wrap-tidyUi', { tidyUi: true, workspace: stock.work });
      await live.run('comma-wrap'); const wide = await live.capture('wide');
      await check(wide, 110, true);
      assert.deepEqual(activity(live), activity(stock), '3 calls/results and 4 model contexts are identical');
      assert.deepEqual(persisted(wide), persisted(native), 'raw arguments and complete results remain identical');
      const sessionBytes = readFileSync(wide.session);
      await live.resize(36, 80); const narrow = await live.capture('narrow');
      await check(narrow, 36, false);
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.resize(110, 80); const back = await live.capture('wide-again');
      assert.deepEqual(toolLines(back), toolLines(wide));
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'), 110, true);
      await live.appearance(false); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      await live.appearance(true); await check(await live.capture('on'), 110, true);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded, 110, true);
      assert.deepEqual(activity(live), activity(stock), 'UI-only changes do not execute tools or modify model context');
      assert.deepEqual(readFileSync(wide.session), sessionBytes, 'UI-only changes do not rewrite the session');
      await live.close();
      const replay = await start('comma-wrap-replay', { tidyUi: true, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed, 110, true);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      writeFileSync(join(artifacts, 'comma-wrap-coverage.json'), JSON.stringify({
        calls: 3, results: 3, modelContexts: 4, widths: [36, 110], rightMargin: 1,
        tools: 'Executed generic tidy_ui_summary fixture with user-provided array shapes and 60 comma-separated indices; no installed AFT/Magic Context execution',
        lifecycle: ['live native control', 'resize round trip', 'Ctrl+O native equality', 'off/on', 'reload', 'same-session replay'],
        identity: 'Exact calls/results/model contexts, persisted arguments/results, and unchanged session bytes',
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });

test('real CLI: long-word summaries fill preceding space and prefer bounded punctuation cuts',
  { timeout: 240000 }, async (t) => {
    for (const mode of ['fullscreen', 'regular']) await t.test(mode, async () => {
      const terminals = [];
      const start = async (name, options = {}) => {
        const terminal = new PiTerminal(`long-word-${mode}-${name}`, { mode, ...options }); terminals.push(terminal);
        // Five more columns preserve the URL budgets after the fixture tool name grew.
        await terminal.ready(); await terminal.resize(105, 80); return terminal;
      };
      const activity = terminal => {
        const events = terminal.events();
        assert.equal(events.filter(event => event.type === 'call').length, 4);
        assert.equal(events.filter(event => event.type === 'result').length, 4);
        assert.equal(events.filter(event => event.type === 'model_context').length, 5);
        return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
      };
      const check = async (dump, width) => {
        assert.equal(dump.tools.length, 4);
        const args = persisted(dump).filter(entry => entry.arguments).map(entry => entry.arguments);
        const expected = [
          `read ${args[0].path}`,
          `read ${args[1].path} [offset=1, limit=1]`,
          `tidy_ui_summary ${args[2].url} [fixtureError=true]`,
          `tidy_ui_summary ${args[3].target} [query=${JSON.stringify(args[3].query)}, offset=1, limit=1]`,
        ];
        let checkedRows = 0;
        for (const [index, tool] of dump.tools.entries()) {
          const rows = compactContent(tool);
          assert.equal(summaryText(tool), summaryExpected(expected[index]), 'all source characters survive wrapping');
          await assertFits(tool.lines, width - 1);
          if (index < 2) assert.ok(rows[0].startsWith(' → read long-directory/'), 'oversized path starts after the tool name with and without commas');
          if (index === 2) assert.ok(rows[0].endsWith({ 29: '/', 41: '.', 105: '_' }[width]), 'the nearest eligible URL separator determines the physical first-row cut');
          const y = dump.screen.findIndex((row, at) => row === rows[0] && rows.every((value, offset) => dump.screen[at + offset] === value));
          assert.ok(y >= 0, `complete tool ${index} is present on the physical ${mode} screen`);
          for (let offset = 0; offset < rows.length; offset++) {
            assert.ok(['', ' '].includes(dump.cells[y + offset][width - 1].text));
            assert.equal(dump.cells[y + offset][width - 1].bgMode, 0);
            if (offset) assert.equal(rows[offset].slice(0, 3), '   ');
            checkedRows++;
          }
        }
        await errorSummaryColors(dump, dump.tools[2]);
        return checkedRows;
      };
      try {
        const stock = await start('stock'); await stock.run('long-word-wrap'); const native = await stock.capture('native');
        const live = await start('tidy-ui', { tidyUi: true, workspace: stock.work });
        await live.run('long-word-wrap'); const wide = await live.capture('wide');
        let checkedRows = await check(wide, 105);
        assert.deepEqual(activity(live), activity(stock)); assert.deepEqual(persisted(wide), persisted(native));
        const sessionBytes = readFileSync(wide.session);
        for (const width of [41, 29]) {
          await live.resize(width, 80); const dump = await live.capture(`width-${width}`);
          checkedRows += await check(dump, width); assert.deepEqual(persisted(dump), persisted(wide));
        }
        await live.resize(105, 80); const back = await live.capture('wide-again');
        assert.deepEqual(toolLines(back), toolLines(wide));
        await live.command('/tidy-ui-theme light'); const light = await live.capture('light'); checkedRows += await check(light, 105);
        await live.command('/tidy-ui-theme dark');
        stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
        live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
        assert.ok(expanded.tools.every(tool => tool.expanded)); assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
        live.send('\x0f'); await live.settle(); await check(await live.capture('collapsed'), 105);
        await live.appearance(false); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
        await live.appearance(true); await check(await live.capture('on'), 105);
        const starts = live.events().filter(event => event.type === 'start').length;
        await live.command('/reload'); await live.event('start', starts + 1);
        const reloaded = await live.capture('reloaded'); await check(reloaded, 105);
        assert.deepEqual(activity(live), activity(stock)); assert.deepEqual(readFileSync(wide.session), sessionBytes);
        await live.close();
        const replay = await start('replay', { tidyUi: true, session: wide.session, workspace: stock.work });
        const resumed = await replay.capture('resumed'); await check(resumed, 105);
        assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(wide));
        assert.deepEqual(readFileSync(wide.session), sessionBytes);
        assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
        writeFileSync(join(artifacts, `long-word-${mode}-coverage.json`), JSON.stringify({
          mode, calls: 4, results: 4, modelContexts: 5, widths: [29, 41, 105], checkedRows,
          colors: ['dark', 'light', 'all error rows'], controls: ['native', 'expansion', 'off/on', 'reload', 'zero-execution replay'],
          scope: 'Built-in read in the owned workspace and explicit generic URL/quoted Unicode fixtures; no installed package execution',
        }, null, 2));
      } finally { await closeTerminals(terminals.reverse()); }
    });
  });

test('real CLI: failed summaries are wholly error-colored, hide bodies and final badges, and expose native errors on click',
  { timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(80, 120); return terminal;
    };
    const activity = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 4);
      assert.equal(observed.filter((event) => event.type === 'result').length, 4);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 5);
      assert.deepEqual(observed.filter((event) => event.type === 'result').map((event) => event.isError), [true, true, true, false]);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    let checkedErrorCells = 0;
    const check = async (dump, width) => {
      assert.equal(dump.tools.length, 4);
      const args = persisted(dump).filter((entry) => entry.arguments).map((entry) => entry.arguments);
      const expected = [
        `read ${args[0].path} [offset=3, limit=7]`,
        `tidy_ui_summary "needle" in ${args[1].path} [query=${JSON.stringify(args[1].query)}, fixtureError=true]`,
        `tidy_ui_summary [query="named", target=${JSON.stringify(args[2].target)}, fixtureError=true]`,
        'tidy_ui_summary [query="SUCCESS_CALL"]',
      ];
      assert.deepEqual(dump.tools.map((tool) => tool.isError === true), [true, true, true, false]);
      for (const [index, tool] of dump.tools.entries()) {
        compactContent(tool);
        assert.equal(summaryText(tool), summaryExpected(expected[index]), 'collapsed call contains its full arguments and no result preview');
        assert.doesNotMatch(tool.lines.map(plain).join(''), /ERROR_BODY_SENTINEL|ERROR_STACK_SENTINEL|ENOENT|✓|✗/u);
        await assertFits(tool.lines, width - 1);
        if (index < 3) checkedErrorCells += await errorSummaryColors(dump, tool);
      }
      assert.ok(!dump.screen.some((row) => /ERROR_BODY_SENTINEL|ERROR_STACK_SENTINEL|ENOENT/u.test(row)), 'raw error bodies are absent from the real collapsed screen');
    };
    try {
      const stock = await start('compact-errors-stock');
      await stock.run('compact-errors'); const native = await stock.capture('native');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const live = await start('compact-errors-tidyUi', { tidyUi: true, workspace: stock.work });
      await live.run('compact-errors'); const wide = await live.capture('wide'); await check(wide, 80);
      assert.deepEqual(activity(live), activity(stock), '4 calls/results and 5 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(native), 'all raw error messages and supplied arguments remain native session data');
      assert.match(byName(wide, 'tidy_ui_summary')[0].content[0].text, /ERROR_BODY_SENTINEL.*\nERROR_STACK_SENTINEL/u);
      const sessionBytes = readFileSync(wide.session);
      await live.resize(21, 120); const narrow = await live.capture('narrow'); await check(narrow, 21);
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.resize(80, 120); const back = await live.capture('wide-again');
      assert.deepEqual(toolLines(back), toolLines(wide));
      await live.command('/tidy-ui-theme light'); await check(await live.capture('light'), 80);
      await live.command('/tidy-ui-theme dark'); const dark = await live.capture('dark'); await check(dark, 80);
      const target = dark.tools[1], rows = lines(target);
      const y = dark.screen.findIndex((row, index) => row === rows[0] && rows.every((expected, offset) => dark.screen[index + offset] === expected));
      assert.ok(y >= 0);
      const last = y + rows.length - 1;
      live.send(`\x1b[<0;4;${last + 1}M\x1b[<0;4;${last + 1}m`);
      await live.settle(); const clicked = await live.capture('failed-continuation-click');
      assert.deepEqual(clicked.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [target.id]);
      assert.deepEqual(clicked.tools[1].lines, nativeExpanded.tools[1].lines, 'failed continuation click delegates exactly to native full information');
      assert.ok(clicked.screen.some((row) => row.includes('ERROR_BODY_SENTINEL')));
      assert.ok(clicked.screen.some((row) => row.includes('ERROR_STACK_SENTINEL')), 'full available second error line is visible after expansion');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('recollapsed'), 80);
      await live.appearance(false); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      await live.appearance(true); await check(await live.capture('on'), 80);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); await check(reloaded, 80);
      assert.deepEqual(activity(live), activity(stock), 'presentation/lifecycle changes do not modify execution or model context');
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      await live.close();
      const replay = await start('compact-errors-replay', { tidyUi: true, session: wide.session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); await check(resumed, 80);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded));
      assert.deepEqual(persisted(resumed), persisted(wide));
      assert.deepEqual(readFileSync(wide.session), sessionBytes);
      writeFileSync(join(artifacts, 'compact-errors-coverage.json'), JSON.stringify({
        calls: 4, results: 4, modelContexts: 5, failedCalls: 3, checkedErrorCells, widths: [21, 80],
        tools: 'Real built-in failing read plus two generic throwing summaries and one generic success; no installed third-party execution',
        lifecycle: ['real failed-continuation SGR click', 'exact native expansion', 'dark/light', 'resize round trip', 'off/on', 'reload', 'same-session replay'],
        identity: 'Exact raw arguments/results/model contexts and unchanged session bytes',
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });

test('real CLI: width-21 colored-segment boundary preserves content and exact indentation',
  { timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((event) => event.type === 'call').length, 2);
      assert.equal(events.filter((event) => event.type === 'result').length, 2);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 3);
      assert.ok(events.filter((event) => event.type === 'result').every((event) => !event.isError));
      return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    try {
      const stock = await start('boundary-stock');
      await stock.run('boundary'); const control = await stock.capture('wide');
      const live = await start('boundary-tidyUi', { tidyUi: true, workspace: stock.work });
      await live.run('boundary'); const wide = await live.capture('wide');
      assert.deepEqual(activity(live), activity(stock), 'boundary execution/model context remain exact');
      assert.deepEqual(persisted(wide), persisted(control));
      await stock.resize(21); const native = await stock.capture('boundary');
      await live.resize(21); const narrow = await live.capture('boundary');
      assert.equal(narrow.width, 21, 'real PTY boundary viewport');
      assert.equal(narrow.tools.length, 2);
      const expected = ['read abcdefghijklm [limit=1]', `tidy_ui_summary abcdefghijklm [query="${'x'.repeat(40)}"]`];
      for (const [index, tool] of narrow.tools.entries()) {
        const rows = compactContent(tool);
        const allContentRows = tool.lines.map(plain).slice(leadingBlanks(tool));
        assert.ok(allContentRows.every((row) => row.trim()), 'no blank content row from colored inter-segment spaces');
        assert.deepEqual(allContentRows, rows, 'only an optional leading separator may be empty');
        assert.ok(rows.length > 1, 'both boundary calls wrap');
        assert.equal(summaryText(tool), summaryExpected(expected[index]), 'all content, quotes and status survive segment boundary');
        assert.equal(summaryText(tool), summaryText(wide.tools[index]), 'wide and boundary logical content are identical');
        await assertFits(tool.lines, 20);
        const y = narrow.screen.findIndex((row) => row === rows[0]);
        assert.ok(y >= 0, 'boundary compact call appears on actual ANSI-parsed screen');
        assert.deepEqual(narrow.screen.slice(y, y + rows.length), rows, 'every boundary content row appears on actual screen without extra blank rows');
        for (const row of narrow.screen.slice(y + 1, y + rows.length)) assert.match(row, /^ {3}\S/u, 'parsed continuation has exactly three spaces, never four');
        for (let offset = 0; offset < rows.length; offset++) {
          const x = rows[offset].search(/\S/u);
          assert.equal(narrow.cells[y + offset][x].bgMode, 0, 'boundary summary retains default background');
          assert.ok(['', ' '].includes(narrow.cells[y + offset][20].text), 'the rightmost column is blank on the actual boundary screen');
        }
      }
      assert.deepEqual(lines(narrow.tools[0]), [' → read', '   abcdefghijklm', '   [limit=1]'], 'right margin is reserved before wrapping; continuation starts at column three');
      await live.resize(22); const boundaryWithMargin = await live.capture('boundary-with-margin');
      assert.deepEqual(lines(boundaryWithMargin.tools[0]), [' → read abcdefghijklm', '   [limit=1]'], 'original colored segment boundary still works with one right column reserved');
      for (const tool of boundaryWithMargin.tools) await assertFits(tool.lines, 21);
      await live.resize(21); assert.deepEqual(toolLines(await live.capture('boundary-again')), toolLines(narrow));
      assert.equal(leadingBlanks(narrow.tools[1]), 1, 'following multiline call receives exactly one separator');
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.appearance(false); const off = await live.capture('disabled');
      assert.deepEqual(off.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'boundary disable restores exact stock native renderer');
      await live.appearance(true); const enabled = await live.capture('enabled');
      assert.deepEqual(enabled.tools.map((tool) => tool.lines), narrow.tools.map((tool) => tool.lines));
      await live.resize(100); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'boundary resize restores exact wide rendering');
      assert.deepEqual(activity(live), activity(stock), 'boundary UI changes do not execute tools again');
      writeFileSync(join(artifacts, 'boundary-coverage.json'), JSON.stringify({
        calls: 2, results: 2, modelContexts: 3, widths: [100, 21, 22, 21, 100], rightMargin: 1,
        arguments: [{ name: 'read', path: 'abcdefghijklm', limit: 1 }, { name: 'tidy_ui_summary', path: 'abcdefghijklm', query: 'x'.repeat(40) }],
        checked: ['actual ANSI-parsed content rows', 'exactly three-space continuation', 'no blank content rows', 'one blank rightmost screen cell', 'original colored-boundary geometry at width22', 'complete argument text', 'row widths', 'native off control', 'resize back'],
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });
