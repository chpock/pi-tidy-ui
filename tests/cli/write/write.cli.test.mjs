import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, byName, toolLines, assertFits } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { Terminal, nativeAfterMultiline, leadingBlanks, compactContent, summaryText, summaryExpected, errorSummaryColors, persisted } from '../../fixtures/main-cli-support.mjs';

for (const shape of [false, true]) test(`real CLI: write cards ${shape ? 'representative saved diff shapes' : 'actual stock writes'} and lifecycle/native/replay`,
  { timeout: 180000 }, async () => {
    const terminals = [], captures = [], count = shape ? 11 : 5;
    const scenario = shape ? 'write-shapes' : 'write-stock';
    const extraEnv = { TIDY_UI_TEST_WRITE_CARDS: '1', ...(shape ? { TIDY_UI_TEST_WRITE_SHAPE: '1' } : {}) };
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(`${scenario}-${name}`, { ...options, extraEnv }); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    const run = async (terminal) => {
      terminal.send(`run ${scenario}\r`); await terminal.event('provider_gate');
      const pending = await terminal.capture('pointer-write-arguments');
      assert.equal(pending.tools.length, 1); assert.equal(pending.tools[0].executionStarted, false);
      assert.equal(terminal.events().filter(event => event.type === 'call').length, 0);
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('write_execution_gate');
      const running = await terminal.capture('pointer-write-running');
      assert.equal(running.tools[0].executionStarted, true);
      assert.equal(terminal.events().filter(event => event.type === 'call').length, 1);
      assert.equal(terminal.events().filter(event => event.type === 'result').length, 0);
      writeFileSync(join(terminal.output, 'write-execution-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      return { pending, running };
    };
    const events = terminal => {
      const events = terminal.events();
      assert.equal(events.filter(event => event.type === 'call').length, count);
      assert.equal(events.filter(event => event.type === 'result').length, count);
      assert.equal(events.filter(event => event.type === 'model_context').length, count + 1);
      assert.equal(events.filter(event => event.type === 'provider_error').length, 0);
      return events.filter(event => ['call', 'result', 'model_context'].includes(event.type));
    };
    const reference = new Terminal({ cols: 100, rows: 1, allowProposedApi: true });
    const style = async (dump, role, background = false) => {
      reference.reset(); await new Promise(done => reference.write((background ? dump.backgroundStyles : dump.summaryStyles)[role], done));
      const cell = reference.buffer.active.getLine(0).getCell(0);
      return background ? { bg: cell.getBgColor(), bgMode: cell.getBgColorMode() } : { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim() };
    };
    let panelCells = 0, syntaxCells = 0, errorCells = 0;
    const labels = shape ? ['Created', 'Edited', 'Replaced', 'Replaced', 'Wrote', 'Wrote', 'Wrote', null, 'Wrote', null] : ['Wrote', 'Wrote', 'Wrote', 'Wrote', null];
    const check = async (dump) => {
      if (shape && (nativeControl.width !== dump.width || nativeControl.backgroundStyles.toolPendingBg !== dump.backgroundStyles.toolPendingBg)) {
        await nativeTerminal.resize(dump.width, dump.width === 24 ? 320 : 240);
        await nativeTerminal.command(`/tidy-ui-theme ${dump.backgroundStyles.toolPendingBg === darkPanel ? 'dark' : 'light'}`);
        nativeControl = await nativeTerminal.capture(`pointer-write-native-matched-${captures.length}`);
      }
      assert.equal(dump.writeShape, shape); assert.equal(dump.tools.length, count);
      for (const [index, label] of labels.entries()) {
        const tool = dump.tools[index], rows = lines(tool), text = rows.join('\n');
        if (!label) continue;
        assert.ok(text.replace(/[┃\s]/gu, '').includes(`←${label}${tool.args.path}`), 'wrapped title retains its complete label/path');
        assert.ok(rows.some(row => row.startsWith(' ┃')));
        assert.doesNotMatch(text, /Click to expand|PROPOSED_WRITE/);
        await assertFits(tool.lines, dump.width);
      }
      if (shape) {
        assert.match(lines(dump.tools[0]).join('\n'), /WRITE_TAIL_19/); assert.doesNotMatch(lines(dump.tools[0]).join('\n'), /ARGS_CREATED_MUST_NOT_REPLACE_RESULT/);
        assert.ok(lines(dump.tools[1]).join('').replace(/[┃\s]/gu, '').includes('5+constADDED_WRITE=5;')); assert.doesNotMatch(lines(dump.tools[1]).join('\n'), /old1/);
        assert.ok(lines(dump.tools[2]).join('').replace(/[┃\s]/gu, '').includes('1-constBEFORE_WRITE=1;'));
        assert.ok(lines(dump.tools[2]).join('').replace(/[┃\s]/gu, '').includes('1+constAFTER_WRITE=3;'));
        assert.ok(lines(dump.tools[3]).join('').replace(/[┃\s]/gu, '').includes('1-constERASED_WRITE=1;'));
        assert.match(lines(dump.tools[4]).join('\n'), /No changes\./);
        assert.ok(lines(dump.tools[6]).join('').replace(/[┃\s]/gu, '').includes('Difftruncatedbytool;showingsuppliedcontent.'));
        assert.doesNotMatch(lines(dump.tools[6]).join('\n'), /INCOMPLETE_DIFF/);
        assert.ok(lines(dump.tools[7]).join('').replace(/\s/gu, '').includes('NATIVE_WRITE_RESULT_malformed'));
        nativeAfterMultiline(dump.tools[7], nativeControl.tools[7]);
        assert.deepEqual(dump.tools[9].lines, [], 'hidden same-name self renderer stays hidden, even with successful added source');
        assert.ok(leadingBlanks(dump.tools[10]) === 1, 'hidden write is skipped when locating the visible multiline predecessor');
      } else {
        assert.ok(dump.tools.slice(0, 4).every(tool => tool.details === undefined), 'actual stock writes have no diff/creation metadata');
        assert.match(lines(dump.tools[0]).join('\n'), /WRITE_TAIL_19/);
        compactContent(dump.tools[4]); assert.equal(summaryText(dump.tools[4]), summaryExpected('write write-directory'));
        errorCells += await errorSummaryColors(dump, dump.tools[4]);
      }
      const plainIndexes = shape ? [0, 4, 5, 6, 8] : [0, 1, 2, 3];
      for (const index of plainIndexes) assert.doesNotMatch(lines(dump.tools[index]).join('\n'), /┃ +\d+ [+-] /, 'plain source has no sign column');
      if (dump.width >= 100) {
        const body = lines(dump.tools[0]), physical = dump.screen.map(plain);
        const start = physical.findIndex((row, y) => row === body[0] && body.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0, 'the complete >10-line plain source card is physically painted');
        const neutral = await style(dump, 'toolPendingBg', true);
        for (let y = start; y < start + body.length; y++) {
          assert.equal(dump.cells[y][1].text, '┃'); assert.equal(dump.cells[y][0].bgMode, 0);
          assert.equal(dump.cells[y][dump.width - 1].bgMode, 0);
          for (let x = 2; x < dump.width - 1; x++) {
            assert.deepEqual({ bg: dump.cells[y][x].bg, bgMode: dump.cells[y][x].bgMode }, neutral, 'plain write has only neutral panel paint, including padding'); panelCells++;
          }
        }
        for (const [token, role] of [['continued', 'syntaxComment'], ['export', 'syntaxKeyword'], ['"界', 'syntaxString']]) {
          const row = body.findIndex(row => row.includes(token)); assert.ok(row >= 0);
          const cell = dump.cells[start + row][body[row].indexOf(token)];
          assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await style(dump, role)); syntaxCells++;
        }
        assert.match(body.join('\n'), /19 const WRITE_TAIL_19 = 19;/);
        if (shape) {
          const changed = lines(dump.tools[2]);
          assert.equal(changed.findIndex(row => row.includes('BEFORE_WRITE')) === changed.findIndex(row => row.includes('AFTER_WRITE')), dump.width > 120, 'mixed write changes split only above 120 columns');
        }
      }
      captures.push({ width: dump.width, sourceLines: 19, labels });
    };
    let nativeControl, nativeTerminal, darkPanel;
    try {
      const stock = await start('native'); nativeTerminal = stock; await run(stock); nativeControl = await stock.capture('pointer-write-native');
      darkPanel = nativeControl.backgroundStyles.toolPendingBg;
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('pointer-write-native-expanded');
      stock.send('\x0f'); await stock.settle();
      const live = await start('tidy-ui', { tidyUi: true, workspace: stock.work }); const phases = await run(live);
      for (const phase of [phases.pending, phases.running]) {
        const tool = phase.tools[0], text = lines(tool).join('\n');
        assert.match(text, /write write-(created|stock)\.ts/); assert.doesNotMatch(text, /┃|← (?:Created|Edited|Replaced|Wrote)|write comment|ARGS_CREATED|PROPOSED_WRITE|content=/);
        assert.equal(lines(tool).length, 1);
        assert.match(text, tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u : /^ ← write /u, 'only actual execution animates the leading glyph');
        assert.ok(phase.screen.some(row => tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u.test(row) : /^ ← write /u.test(row)), 'compact lifecycle is physically painted');
      }
      const liveFirst = await live.capture('pointer-write-wide'); await check(liveFirst);
      assert.deepEqual(events(live), events(stock)); assert.deepEqual(persisted(liveFirst), persisted(nativeControl));
      if (!shape) {
        assert.equal(readFileSync(join(live.work, 'write-stock.ts'), 'utf8'), 'const overwritten = 20;\n');
        assert.equal(readFileSync(join(live.work, 'write-empty.ts'), 'utf8'), 'const filled = 21;\n');
        assert.equal(readFileSync(join(live.work, 'write-cleared.ts'), 'utf8'), '');
      }
      const bytes = readFileSync(liveFirst.session);
       await live.cacheSnapshot(true); await live.capture('pointer-write-cold');
       const cold = await live.cacheSnapshot(); await live.capture('pointer-write-cache-cold');
       const warm = await live.cacheSnapshot(); await live.capture('pointer-write-cache-warm');
      assert.equal(warm.builds, cold.builds, 'unchanged frames rebuild no write body');
      assert.equal(warm.cards.builds, cold.cards.builds); assert.ok(warm.cards.hits > cold.cards.hits);
      assert.equal(warm.cards.entries, shape ? 8 : 4, 'successful write frames share the existing card pool; malformed/hidden/error stay outside');
      await live.resize(140, 240); await check(await live.capture('pointer-write-split'));
      await live.resize(24, 320); await check(await live.capture('pointer-write-narrow'));
      await live.resize(100, 240); const wideAgain = await live.capture('pointer-write-wide-again'); await check(wideAgain);
      assert.deepEqual(toolLines(wideAgain), toolLines(liveFirst));
      await live.command('/tidy-ui-theme light'); await check(await live.capture('pointer-write-light'));
      await live.command('/tidy-ui-theme dark'); await check(await live.capture('pointer-write-dark'));
      const beforeClick = await live.capture('pointer-write-before-click');
      const target = beforeClick.screen.findIndex(row => row.includes(`← ${labels[0]} ${beforeClick.tools[0].args.path}`));
      assert.ok(target >= 0); live.send(`\x1b[<0;3;${target + 1}M\x1b[<0;3;${target + 1}m`); await live.settle();
      const clicked = await live.capture('pointer-write-clicked');
      assert.equal(clicked.tools[0].expanded, true); assert.ok(clicked.tools.slice(1).every(tool => !tool.expanded));
      assert.deepEqual(clicked.tools[0].lines, nativeExpanded.tools[0].lines, 'panel click reveals the original native write');
      const nativeTitle = clicked.screen.findIndex(row => row.includes(shape ? 'NATIVE_WRITE write-created.ts' : 'write write-stock.ts'));
      assert.ok(nativeTitle >= 0); live.send(`\x1b[<0;5;${nativeTitle + 1}M\x1b[<0;5;${nativeTitle + 1}m`); await live.settle();
      assert.equal((await live.capture('pointer-write-click-recollapsed')).tools[0].expanded, false);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('pointer-write-expanded');
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded));
      live.send('\x0f'); await live.settle(); await check(await live.capture('pointer-write-recollapsed'));
      await live.appearance(false); assert.deepEqual(toolLines(await live.capture('pointer-write-off')), toolLines(nativeControl));
      await live.appearance(true); await check(await live.capture('pointer-write-on'));
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1); const reloaded = await live.capture('pointer-write-reloaded'); await check(reloaded);
      assert.deepEqual(events(live), events(stock)); assert.deepEqual(readFileSync(liveFirst.session), bytes);
      await live.close();
      const replay = await start('replay', { tidyUi: true, session: liveFirst.session, workspace: stock.work });
      const resumed = await replay.capture('pointer-write-replayed'); await check(resumed);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(liveFirst));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      const sameSessionNative = await start('native-replay', { session: liveFirst.session, workspace: stock.work });
      const nativeReplay = await sameSessionNative.capture('pointer-write-native-replay');
      await replay.appearance(false); assert.deepEqual(toolLines(await replay.capture('pointer-write-replay-off')), toolLines(nativeReplay));
      const explicit = await start('native-override', { tidyUi: true, flags: ['--tidy-ui-card', 'write'], session: liveFirst.session, workspace: stock.work });
      const explicitNative = await explicit.capture('pointer-write-explicit-native');
      assert.deepEqual(toolLines({ tools: byName(explicitNative, 'write') }), toolLines({ tools: byName(nativeReplay, 'write') }), 'write-only native override preserves every write row');
      if (shape) compactContent(byName(explicitNative, 'read')[0]);
      const compactReplay = await start('compact', { tidyUi: true, flags: ['--tidy-ui-card', 'write', '--tidy-ui-compact', 'write'], session: liveFirst.session, workspace: stock.work });
      const forced = await compactReplay.capture('pointer-write-forced-compact');
      for (const tool of byName(forced, 'write')) {
        if (tool.args.fixtureCase === 'hidden') assert.deepEqual(tool.lines, []);
        else { compactContent(tool); assert.equal(summaryText(tool), summaryExpected(`write ${tool.args.path}`)); }
      }
      const regular = await start('regular-replay', { tidyUi: true, mode: 'regular', session: liveFirst.session, workspace: stock.work });
      const regularDump = await regular.capture('pointer-write-regular');
      assert.deepEqual(toolLines(regularDump), toolLines(reloaded));
      sameSessionNative.send('\x0f'); await sameSessionNative.settle();
      const sameSessionExpanded = await sameSessionNative.capture('pointer-write-native-replay-expanded');
      regular.send('\x0f'); await regular.settle();
      assert.deepEqual(toolLines(await regular.capture('pointer-write-regular-expanded')), toolLines(sameSessionExpanded));
      assert.deepEqual(readFileSync(liveFirst.session), bytes);
      writeFileSync(join(artifacts, `${scenario}-coverage.json`), JSON.stringify({
        actualStockExecuted: !shape, installedAFTExecuted: false, calls: count, results: count, modelContexts: count + 1,
        panelCells, syntaxCells, errorCells, captures, cardEntries: warm.cards.entries, warmBuildsDelta: warm.builds - cold.builds,
        checks: ['pre-execution/execution gates', 'saved-source classification/full 19-line source', 'no diff signs/tint for plain', 'physical syntax/panel cells',
          'native click/Ctrl+O', 'native and compact overrides', 'width/theme/lifecycle', 'fullscreen/regular replay', 'exact traffic/session bytes'],
      }, null, 2));
    } finally {
      reference.dispose(); await closeTerminals(terminals.reverse());
    }
  });
