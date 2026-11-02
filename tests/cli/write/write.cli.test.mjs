import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, byName, toolLines, assertFits, deferredNativePreparation } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { Terminal, nativeAfterMultiline, leadingBlanks, compactContent, summaryText, summaryExpected, errorSummaryColors, persisted } from '../../fixtures/main-cli-support.mjs';

for (const shape of [false, true]) test(`real CLI: write cards ${shape ? 'representative saved diff shapes' : 'actual stock writes'} and lifecycle/native/replay`,
  { timeout: 180000 }, async () => {
    const terminals = [], captures = [], count = shape ? 11 : 5;
    const scenario = shape ? 'write-shapes' : 'write-stock';
    const extraEnv = { TIDY_UI_TEST_WRITE_CARDS: '1', TIDY_UI_TEST_WRITE_CAPTURE: '1', TIDY_UI_TEST_NATIVE_PREPARATION: '1', ...(shape ? { TIDY_UI_TEST_WRITE_SHAPE: '1' } : {}) };
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(`${scenario}-${name}`, { ...options, extraEnv }); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    const captureReady = async (terminal, name) => {
      await terminal.command(`/tidy-ui-write-ready ${name}`);
      const ready = await terminal.waitForProgress(() => terminal.events().find(event => event.type === 'write_capture_ready' && event.name === name), `prepared write sources: ${name}`);
      const dump = await terminal.capture(name);
      const framed = dump.tools.filter(tool => tool.name === 'write' && tool.lines.some(row => plain(row).startsWith(' ┃')));
      assert.ok(framed.length > 0, 'settled write reference contains actual source cards');
      assert.deepEqual(ready.calls.map(event => event.call).sort(), framed.map(tool => tool.id).sort(), 'readiness covers every current source-card call, not merely a same-path owner');
      assert.ok(ready.calls.every(event => event.status === 'ready'));
      return dump;
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
    const checkPreview = async (dump) => {
      if (shape && (nativeControl.width !== dump.width || nativeControl.backgroundStyles.toolPendingBg !== dump.backgroundStyles.toolPendingBg)) {
        await nativeTerminal.resize(dump.width, dump.width === 24 ? 320 : 240);
        await nativeTerminal.command(`/tidy-ui-theme ${dump.backgroundStyles.toolPendingBg === darkPanel ? 'dark' : 'light'}`);
        nativeControl = await nativeTerminal.capture(`pointer-write-preview-native-matched-${captures.length}`);
      }
      assert.equal(dump.writeShape, shape); assert.equal(dump.tools.length, count);
      for (const [index, label] of labels.entries()) {
        if (!label) continue;
        const tool = dump.tools[index], rows = lines(tool), text = rows.join('\n');
        assert.ok(text.replace(/[┃\s]/gu, '').includes(`←Write${tool.args.path}`),
          `the unexpanded restored preview uses its bounded file heading (width=${dump.width}, path=${JSON.stringify(tool.args.path)}, rows=${JSON.stringify(text)})`);
        assert.doesNotMatch(text, /← (?:Created|Edited|Replaced) /u, 'a restored prefix does not claim full-source classification');
        assert.doesNotMatch(text, /WRITE_TAIL_19|PROPOSED_WRITE/u);
        assert.ok(rows.some(row => row.startsWith(' ┃'))); await assertFits(tool.lines, dump.width);
      }
      if (shape) {
        const unsupportedPreview = lines(dump.tools[7]).join(' ').replace(/\s+/gu, ' ');
        assert.match(unsupportedPreview, /No saved file change details are available; expand for full validation\./u,
          'unsupported metadata in the bounded preview uses an owned limitation, not native full rendering');
        assert.doesNotMatch(unsupportedPreview, /NATIVE_WRITE_RESULT_malformed/u);
        assert.deepEqual(dump.tools[9].lines, [], 'hidden same-name self renderer stays hidden in restored history');
      }
      if (dump.width >= 100) {
        const body = lines(dump.tools[0]), physical = dump.screen.map(plain);
        const start = physical.findIndex((row, y) => row === body[0] && body.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0, 'the bounded preview is physically painted in restored history');
        const neutral = await style(dump, 'toolPendingBg', true);
        assert.equal(dump.cells[start][1].text, '┃');
        for (let x = 2; x < dump.width - 1; x++) {
          assert.deepEqual({ bg: dump.cells[start][x].bg, bgMode: dump.cells[start][x].bgMode }, neutral,
            'the bounded preview retains the native result surface while diff rows keep their own backgrounds');
        }
        const keywordRow = body.findIndex(row => row.includes('const'));
        assert.ok(keywordRow >= 0);
        const cell = dump.cells[start + keywordRow][body[keywordRow].indexOf('const')];
        assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await style(dump, 'syntaxKeyword'), 'restored preview paints the actual Pi keyword binding');
      }
      captures.push({ width: dump.width, sourceLines: 10, labels: 'generic preview' });
    };
    const assertExpandedWriteError = (tool) => {
      const failure = lines(tool).map(plain).join('\n');
      assert.match(failure, /Requested file content:/u);
      assert.match(failure, /FAILED_WRITE_PAYLOAD/u);
      assert.match(failure, /Tool error:/u);
      assert.match(failure, /EISDIR/u);
    };
    let nativeControl, nativeTerminal, darkPanel;
    try {
      const stock = await start('native'); nativeTerminal = stock; await run(stock); nativeControl = await stock.capture('pointer-write-native');
      darkPanel = nativeControl.backgroundStyles.toolPendingBg;
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('pointer-write-native-expanded');
      assert.equal(nativeExpanded.tools[0].expanded, true, 'the independent native control expands through Pi');
      if (shape) assert.match(lines(nativeExpanded.tools[0]).join('\n'), /NATIVE_WRITE/u, 'the third-party native callback remains available to Pi');
      stock.send('\x0f'); await stock.settle();
      const nativeTraffic = events(stock);
      if (!shape) await stock.close();
      const live = await start('tidy-ui', { tidyUi: true, workspace: stock.work });
      const startupProbe = deferredNativePreparation(live);
      assert.ok(startupProbe.probes.length > 0, 'the in-graph deferred-renderer probe is installed before tool construction');
      const liveProbeEpoch = startupProbe.probes.at(-1).epoch;
      assert.deepEqual(startupProbe.attempts.filter(event => event.epoch === liveProbeEpoch), [], 'startup constructs lazy callbacks without preparing stock write renderers');
      const phases = await run(live);
      for (const phase of [phases.pending, phases.running]) {
        const tool = phase.tools[0], text = lines(tool).join('\n');
        assert.match(text, /write write-(created|stock)\.ts/); assert.doesNotMatch(text, /┃|← (?:Created|Edited|Replaced|Wrote)|write comment|ARGS_CREATED|PROPOSED_WRITE|content=/);
        assert.equal(lines(tool).length, 1);
        assert.match(text, tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u : /^ ← write /u, 'only actual execution animates the leading glyph');
        assert.ok(phase.screen.some(row => tool.executionStarted ? /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] write /u.test(row) : /^ ← write /u.test(row)), 'compact lifecycle is physically painted');
      }
      const liveFirst = await captureReady(live, 'pointer-write-wide'); await check(liveFirst);
      assert.deepEqual(deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch), [], 'custom write presentation never prepares stock write renderers');
      assert.deepEqual(events(live), shape ? events(stock) : nativeTraffic); assert.deepEqual(persisted(liveFirst), persisted(nativeControl));
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
      await live.resize(140, 240); await check(await captureReady(live, 'pointer-write-split'));
      await live.resize(24, 320); await check(await captureReady(live, 'pointer-write-narrow'));
      await live.resize(100, 240); const wideAgain = await captureReady(live, 'pointer-write-wide-again'); await check(wideAgain);
      assert.deepEqual(toolLines(wideAgain), toolLines(liveFirst));
      await live.command('/tidy-ui-theme light'); await check(await captureReady(live, 'pointer-write-light'));
      await live.command('/tidy-ui-theme dark'); await check(await captureReady(live, 'pointer-write-dark'));
      const beforeClick = await live.capture('pointer-write-before-click');
      const target = beforeClick.screen.findIndex(row => row.includes(`← ${labels[0]} ${beforeClick.tools[0].args.path}`));
      assert.ok(target >= 0); live.send(`\x1b[<0;3;${target + 1}M\x1b[<0;3;${target + 1}m`); await live.settle();
      const clicked = await live.capture('pointer-write-clicked');
      assert.equal(clicked.tools[0].expanded, false, 'custom card selection does not mutate Pi native expansion state');
      assert.ok(clicked.tools.slice(1).every(tool => !tool.expanded));
      assert.match(lines(clicked.tools[0]).join('\n'), /← Write write-(?:created|stock)\.ts/u, 'clicking an automatic full card selects the bounded preview');
      const previewTitle = clicked.screen.findIndex(row => row.includes('← Write '));
      assert.ok(previewTitle >= 0); live.send(`\x1b[<0;3;${previewTitle + 1}M\x1b[<0;3;${previewTitle + 1}m`); await live.settle();
      const clickedFull = await live.capture('pointer-write-clicked-full');
      assert.equal(clickedFull.tools[0].expanded, false, 'manual full view remains separate from Pi expanded state');
      assert.deepEqual(clickedFull.tools[0].lines, liveFirst.tools[0].lines, 'manual preview expansion restores the complete custom card');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('pointer-write-expanded');
      const expectedExpanded = toolLines(nativeExpanded);
      for (const [index, label] of labels.entries()) if (label) expectedExpanded[index] = toolLines({ tools: [liveFirst.tools[index] ] })[0];
      if (!shape) {
        assertExpandedWriteError(expanded.tools[4]);
        assert.deepEqual(toolLines(expanded).filter((_, index) => index !== 4), expectedExpanded.filter((_, index) => index !== 4),
          'unrelated native tools and successful saved-data cards retain exact Pi/custom expansion');
      } else assert.deepEqual(toolLines(expanded), expectedExpanded, 'global expansion keeps Pi behavior for unrelated/native tools and custom full saved-data cards');
      live.send('\x0f'); await live.settle(); await check(await captureReady(live, 'pointer-write-recollapsed'));
      let exportAttempts = [];
      const beforeExport = deferredNativePreparation(live);
      assert.deepEqual(beforeExport.attempts.filter(event => event.epoch === liveProbeEpoch), [], 'custom saved-file presentation is still stock-preparation free before HTML export');
      if (!shape) {
        const exportPath = join(live.work, 'write-session-export.html');
        await live.command(`/export ${exportPath}`);
        const html = readFileSync(exportPath, 'utf8');
        const sessionPayload = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/u);
        assert.ok(sessionPayload, 'the real HTML export contains its serialized Pi session');
        const exportedSession = JSON.parse(Buffer.from(sessionPayload[1], 'base64').toString('utf8'));
        const exportedEntries = exportedSession.entries.filter(entry => entry.type === 'message').map(entry => entry.message);
        const exportedCall = exportedEntries.flatMap(message => message.content ?? []).find(block =>
          block.type === 'toolCall' && block.name === 'write' && block.arguments?.path === 'write-stock.ts' && block.arguments.content?.includes('WRITE_TAIL_19'));
        assert.ok(exportedCall, 'HTML export retains the complete write call beyond the bounded preview prefix');
        assert.ok(exportedEntries.some(message => message.role === 'toolResult' && message.toolCallId === exportedCall.id &&
          message.content?.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.includes('Successfully wrote to write-stock.ts'))),
        'HTML export retains the native write result for the same saved call');
        exportAttempts = deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch);
        assert.deepEqual(exportAttempts, [], 'Pi renders write/edit cards from saved session data in its HTML template without materializing TUI stock callbacks');
        assert.deepEqual(events(live), nativeTraffic, 'HTML export adds no model, tool-call or result traffic');
        assert.deepEqual(readFileSync(liveFirst.session), bytes, 'HTML export leaves the Pi session bytes unchanged');
      }
      const beforeOff = deferredNativePreparation(live);
      assert.deepEqual(beforeOff.attempts.filter(event => event.epoch === liveProbeEpoch), exportAttempts,
        'after export, custom width/theme/click/error/expansion transitions add no further stock preparation');
      const writeAttemptsBeforeOff = beforeOff.attempts.filter(event => event.epoch === liveProbeEpoch && event.tool === 'write');
      await live.appearance(false); assert.deepEqual(toolLines(await live.capture('pointer-write-off')), toolLines(nativeControl));
      const offPreparation = deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch && event.tool === 'write').slice(writeAttemptsBeforeOff.length);
      if (shape) assert.deepEqual(offPreparation, [], 'the third-party native pair remains outside the stock deferred-renderer probe');
      else assert.ok(offPreparation.length > 0, 'Appearance Off positively observes native stock write callback materialization');
      const offAttemptCount = deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch).length;
      await live.appearance(true); await checkPreview(await captureReady(live, 'pointer-write-on'));
      assert.equal(deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch).length, offAttemptCount, 'native-to-owned recovery adds no stock materialization');
      const starts = live.events().filter(event => event.type === 'start').length;
      const probesBeforeReload = deferredNativePreparation(live).probes.length;
      await live.command('/reload'); await live.event('start', starts + 1); const reloaded = await captureReady(live, 'pointer-write-reloaded'); await checkPreview(reloaded);
      const reloadProbe = deferredNativePreparation(live);
      assert.ok(reloadProbe.probes.length > probesBeforeReload, 'reload installs the observer in the new extension graph');
      const reloadEpoch = reloadProbe.probes.at(-1).epoch;
      assert.deepEqual(reloadProbe.attempts.filter(event => event.epoch === reloadEpoch), [], 'custom reload does not prepare native write renderers during construction or presentation');
      if (!shape) {
        await live.appearance(false);
        assert.deepEqual(toolLines(await live.capture('pointer-write-reloaded-off')), toolLines(nativeControl));
        const reloadedNative = deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch && event.tool === 'write');
        assert.ok(reloadedNative.some(event => event.slot === 'call') && reloadedNative.some(event => event.slot === 'result'), 'the new reload graph counts both stock callbacks on its positive Off control');
        const reloadedOffAttemptCount = deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch).length;
        await live.appearance(true);
        const reloadedOn = await captureReady(live, 'pointer-write-reloaded-on'); await checkPreview(reloadedOn);
        assert.equal(deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch).length, reloadedOffAttemptCount, 'the same reload graph adds no stock materialization after native-to-owned recovery');
      }
      assert.deepEqual(events(live), shape ? events(stock) : nativeTraffic); assert.deepEqual(readFileSync(liveFirst.session), bytes);
      await live.close();
      const sameSessionNative = await start('native-replay', { session: liveFirst.session, workspace: stock.work });
      const nativeReplay = await sameSessionNative.capture('pointer-write-native-replay');
      sameSessionNative.send('\x0f'); await sameSessionNative.settle();
      const sameSessionExpanded = await sameSessionNative.capture('pointer-write-native-replay-expanded');
      await sameSessionNative.close();
      assert.equal(sameSessionNative.closed, true, 'native replay is reaped before independent write variants');
      const replay = await start('replay', { tidyUi: true, session: liveFirst.session, workspace: stock.work });
      const replayProbe = deferredNativePreparation(replay);
      assert.ok(replayProbe.probes.length > 0, 'the independent replay extension graph installs the direct observer');
      const replayEpoch = replayProbe.probes.at(-1).epoch;
      const resumed = await captureReady(replay, 'pointer-write-replayed'); await checkPreview(resumed);
      assert.deepEqual(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch), [], 'restored owned preview stays cold in its independent graph');
      assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(liveFirst));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      const beforeReplayOff = deferredNativePreparation(replay);
      assert.deepEqual(beforeReplayOff.attempts.filter(event => event.epoch === replayEpoch), [], 'replay palette/render work did not materialize the native callback before Off');
      await replay.appearance(false); assert.deepEqual(toolLines(await replay.capture('pointer-write-replay-off')), toolLines(nativeReplay));
      if (!shape) assert.ok(deferredNativePreparation(replay).attempts.some(event => event.epoch === replayEpoch && event.tool === 'write'), 'replay Off is a positive stock callback control');
      const replayOffAttemptCount = deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch).length;
      await replay.appearance(true);
      await checkPreview(await captureReady(replay, 'pointer-write-replay-on'));
      assert.equal(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch).length, replayOffAttemptCount, 'replay returns to the owned view without new stock materialization');
      await replay.close();
      const explicit = await start('native-override', { tidyUi: true, flags: ['--tidy-ui-card', 'write'], session: liveFirst.session, workspace: stock.work });
      const explicitNative = await explicit.capture('pointer-write-explicit-native');
      const explicitProbe = deferredNativePreparation(explicit);
      assert.ok(explicitProbe.probes.length > 0);
      const explicitEpoch = explicitProbe.probes.at(-1).epoch;
      const explicitPreparation = explicitProbe.attempts.filter(event => event.epoch === explicitEpoch && event.tool === 'write');
      if (shape) assert.deepEqual(explicitPreparation, [], 'the explicit foreign write override does not claim stock callback work');
      else assert.ok(explicitPreparation.length > 0, 'explicit native override positively materializes stock write renderers');
      assert.deepEqual(toolLines({ tools: byName(explicitNative, 'write') }), toolLines({ tools: byName(nativeReplay, 'write') }), 'write-only native override preserves every write row');
      if (shape) compactContent(byName(explicitNative, 'read')[0]);
      await explicit.close();
      const compactReplay = await start('compact', { tidyUi: true, flags: ['--tidy-ui-card', 'write', '--tidy-ui-compact', 'write'], session: liveFirst.session, workspace: stock.work });
      const forced = await compactReplay.capture('pointer-write-forced-compact');
      const compactProbe = deferredNativePreparation(compactReplay);
      assert.ok(compactProbe.probes.length > 0);
      const compactEpoch = compactProbe.probes.at(-1).epoch;
      assert.deepEqual(compactProbe.attempts.filter(event => event.epoch === compactEpoch), [], 'explicit compact mode does not prepare stock write renderers');
      for (const tool of byName(forced, 'write')) {
        if (tool.args.fixtureCase === 'hidden') assert.deepEqual(tool.lines, []);
        else { compactContent(tool); assert.equal(summaryText(tool), summaryExpected(`write ${tool.args.path}`)); }
      }
      await compactReplay.close();
      const regular = await start('regular-replay', { tidyUi: true, mode: 'regular', session: liveFirst.session, workspace: stock.work,
        ...(shape ? { agentSettings: { outputPad: 1 } } : {}) });
      const regularProbe = deferredNativePreparation(regular);
      assert.ok(regularProbe.probes.length > 0, 'the independent regular extension graph installs the direct observer');
      const regularEpoch = regularProbe.probes.at(-1).epoch;
      const regularDump = await captureReady(regular, 'pointer-write-regular'); await checkPreview(regularDump);
      assert.deepEqual(deferredNativePreparation(regular).attempts.filter(event => event.epoch === regularEpoch), [], 'regular-mode replay preview stays stock-preparation free');
      assert.deepEqual(toolLines(regularDump), toolLines(reloaded));
      if (shape) {
        await regular.resize(24, 240);
        const narrow = await captureReady(regular, 'pointer-write-regular-narrow'); await checkPreview(narrow);
        for (const tool of narrow.tools) await assertFits(tool.lines, 24);
        const unsupported = byName(narrow, 'write').find(tool => tool.args.fixtureCase === 'malformed');
        assert.ok(unsupported);
        assert.ok(lines(unsupported).map(plain).join('').replace(/[┃\s]/gu, '').includes('Nosavedfilechangedetailsareavailable;expandforfullvalidation.'),
          'the regular renderer keeps the actual unsupported-file service row at width 24 with Output padding 1');
        await regular.resize(100, 240);
        await checkPreview(await captureReady(regular, 'pointer-write-regular-restored'));
        await stock.close();
      }
      regular.send('\x0f'); await regular.settle();
      const regularExpanded = await captureReady(regular, 'pointer-write-regular-expanded');
      const expectedRegularExpanded = toolLines(sameSessionExpanded);
      for (const [index, label] of labels.entries()) if (label) expectedRegularExpanded[index] = toolLines({ tools: [liveFirst.tools[index]] })[0];
      if (!shape) {
        assertExpandedWriteError(regularExpanded.tools[4]);
        assert.deepEqual(toolLines(regularExpanded).filter((_, index) => index !== 4), expectedRegularExpanded.filter((_, index) => index !== 4),
          'regular replay preserves unrelated native output and expands only supported file data');
        assert.deepEqual(deferredNativePreparation(regular).attempts.filter(event => event.epoch === regularEpoch), [], 'regular owned full view is still cold before native opt-out');
        await regular.appearance(false);
        assert.deepEqual(toolLines(await regular.capture('pointer-write-regular-off')), toolLines(sameSessionExpanded), 'regular Off restores exact native write output at the same expansion state');
        assert.ok(deferredNativePreparation(regular).attempts.some(event => event.epoch === regularEpoch && event.tool === 'write'), 'regular Off positively materializes stock write callbacks in the current graph');
        const regularOffAttemptCount = deferredNativePreparation(regular).attempts.filter(event => event.epoch === regularEpoch).length;
        await regular.appearance(true);
        const regularOn = await captureReady(regular, 'pointer-write-regular-on');
        assert.deepEqual(toolLines(regularOn), toolLines(regularExpanded), 'regular native-to-owned recovery preserves the currently expanded full file view');
        assert.equal(deferredNativePreparation(regular).attempts.filter(event => event.epoch === regularEpoch).length, regularOffAttemptCount, 'regular native-to-owned recovery adds no stock callbacks');
      } else assert.deepEqual(toolLines(regularExpanded), expectedRegularExpanded, 'Ctrl+O expands supported file cards without changing unrelated native renderer output');
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


test('real CLI: successful file cards roll across a batch and short turn; replay restores every preview', { timeout: 240000 }, async () => {
  const terminals = [], redraws = [];
  const extraEnv = { TIDY_UI_TEST_WRITE_CARDS: '1', TIDY_UI_TEST_WRITE_CAPTURE: '1', TIDY_UI_TEST_NATIVE_PREPARATION: '1' };
  const start = async (name, options = {}) => {
    const { rows = 240, ...terminalOptions } = options;
    const terminal = new PiTerminal(`write-window-${name}`, { ...terminalOptions, extraEnv }); terminals.push(terminal);
    await terminal.ready(); await terminal.resize(100, rows); return terminal;
  };
  const captureReady = async (terminal, name) => {
    await terminal.command(`/tidy-ui-write-ready ${name}`);
    const ready = await terminal.waitForProgress(() => terminal.events().find(event => event.type === 'write_capture_ready' && event.name === name), `ready file cards: ${name}`);
    const dump = await terminal.capture(name), writes = byName(dump, 'write').filter(tool => tool.lines.some(row => plain(row).startsWith(' ┃')));
    assert.deepEqual(ready.calls.map(event => event.call).sort(), writes.map(tool => tool.id).sort());
    assert.ok(ready.calls.every(event => event.status === 'ready'));
    return dump;
  };
  const previousRedraw = new Map();
  const recordRedraw = (terminal, dump, name, mode = 'fullscreen') => {
    assert.ok(Number.isInteger(dump.fullRedraws) && dump.fullRedraws >= 0, 'the driver records Pi TUI full redraws');
    const scrollbackClearCommands = (Buffer.concat(terminal.raw).toString('utf8').match(/\x1b\[3J/gu) ?? []).length;
    const previous = previousRedraw.get(terminal) ?? { fullRedraws: dump.fullRedraws, scrollbackClearCommands };
    redraws.push({ name, mode, width: terminal.term.cols, height: terminal.term.rows,
      fullRedraws: dump.fullRedraws, fullRedrawDelta: dump.fullRedraws - previous.fullRedraws,
      scrollbackClearCommands, scrollbackClearDelta: scrollbackClearCommands - previous.scrollbackClearCommands,
      terminalBaseY: terminal.term.buffer.active.baseY, terminalViewportY: terminal.term.buffer.active.viewportY });
    previousRedraw.set(terminal, { fullRedraws: dump.fullRedraws, scrollbackClearCommands });
  };
  const source = index => Array.from({ length: 12 }, (_, row) => `const ROLLING_${String(index).padStart(2, '0')}_ROW_${String(row).padStart(2, '0')} = ${row};`).join('\n');
  const state = (tool, index) => {
    const rendered = lines(tool).join('\n'), compact = rendered.replace(/[┃\s]/gu, ''), path = tool.args.path;
    const full = compact.includes(`←Wrote${path}`), preview = compact.includes(`←Write${path}`) && !full;
    const tail = rendered.includes(`ROLLING_${String(index).padStart(2, '0')}_ROW_11`);
    return { path, full, preview, tail, rendered };
  };
  const checkWindow = (dump, expectedFull, name) => {
    const writes = byName(dump, 'write'); assert.equal(writes.length, expectedFull.length, `${name}: exact saved-file count`);
    const physical = dump.screen.map(plain), states = writes.map((tool, index) => {
      const actual = state(tool, index);
      assert.equal(actual.full, expectedFull[index], `${name}: full/preview state for ${actual.path}`);
      assert.equal(actual.preview, !expectedFull[index], `${name}: visible presentation mode for ${actual.path}`);
      assert.equal(actual.tail, expectedFull[index], `${name}: full suffix visibility for ${actual.path}`);
      assert.ok(actual.rendered.includes(`ROLLING_${String(index).padStart(2, '0')}_ROW_00`), `${name}: first source row remains visible`);
      return { path: actual.path, full: actual.full, tail: actual.tail };
    });
    const physicalIndex = expectedFull.length - 1, visible = state(writes[physicalIndex], physicalIndex);
    const title = visible.full ? `← Wrote ${visible.path}` : `← Write ${visible.path}`;
    assert.ok(physical.some(row => row.replace(/[┃\s]/gu, '').includes(title.replace(/[┃\s]/gu, ''))), `${name}: actual terminal viewport contains the newest file heading`);
    assert.equal(physical.some(row => row.includes(`ROLLING_${String(physicalIndex).padStart(2, '0')}_ROW_11`)), expectedFull[physicalIndex], `${name}: actual viewport shows the newest file tail only when full`);
    return states;
  };
  const semanticEvents = terminal => terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
  const sessionData = terminal => persisted(terminal);
  let native, regular, live, replay;
  try {
    native = await start('native');
    await native.run('write-window-batch'); await native.run('write-window-empty'); await native.run('write-window-short');
    const nativeFinal = await native.capture('native-final'); recordRedraw(native, nativeFinal, 'native-final');

    regular = await start('regular', { mode: 'regular', rows: 40, tidyUi: true });
    const regularProbe = deferredNativePreparation(regular); assert.ok(regularProbe.probes.length > 0);
    const regularEpoch = regularProbe.probes.at(-1).epoch;
    const regularInitial = await regular.capture('regular-initial'); recordRedraw(regular, regularInitial, 'regular-initial', 'regular');
    assert.deepEqual(regularProbe.attempts.filter(event => event.epoch === regularEpoch), [], 'regular live startup has not prepared native write callbacks');
    await regular.run('write-window-batch');
    const regularBatch = await captureReady(regular, 'regular-after-batch');
    checkWindow(regularBatch, [...Array(2).fill(false), ...Array(10).fill(true)], 'regular-after-batch');
    recordRedraw(regular, regularBatch, 'regular-after-batch', 'regular');
    await regular.run('write-window-empty');
    const regularEmpty = await captureReady(regular, 'regular-after-empty-turn');
    checkWindow(regularEmpty, [...Array(2).fill(false), ...Array(10).fill(true)], 'regular-after-empty-turn');
    recordRedraw(regular, regularEmpty, 'regular-after-empty-turn', 'regular');
    await regular.run('write-window-short');
    const regularShort = await captureReady(regular, 'regular-after-short-turn');
    const regularShortStates = checkWindow(regularShort, [...Array(3).fill(false), ...Array(10).fill(true)], 'regular-after-short-turn');
    recordRedraw(regular, regularShort, 'regular-after-short-turn', 'regular');
    assert.deepEqual(regularShortStates.map(({ path, full }) => ({ path, full })),
      ['rolling-window-00.ts', 'rolling-window-01.ts', 'rolling-window-02.ts', 'rolling-window-03.ts', 'rolling-window-04.ts',
        'rolling-window-05.ts', 'rolling-window-06.ts', 'rolling-window-07.ts', 'rolling-window-08.ts', 'rolling-window-09.ts',
        'rolling-window-10.ts', 'rolling-window-11.ts', 'rolling-window-late.ts'].map((path, index) => ({ path, full: index >= 3 })),
      'regular short-turn output keeps the manual oldest card and rolls the same latest-ten automatic window');
    assert.deepEqual(regularProbe.attempts.filter(event => event.epoch === regularEpoch), [], 'regular batch/empty/short-turn presentation remains free of native callback materialization');
    assert.equal(regular.events().filter(event => event.type === 'call').length, 13);
    assert.equal(regular.events().filter(event => event.type === 'result').length, 13);
    assert.deepEqual(sessionData(regularShort), sessionData(nativeFinal), 'regular output preserves the exact model/session/tool data');
    assert.deepEqual(semanticEvents(regular), semanticEvents(native), 'regular presentation preserves exact model, tool-call and result traffic');
    for (let index = 0; index < 12; index++) assert.equal(readFileSync(join(regular.work, `rolling-window-${String(index).padStart(2, '0')}.ts`), 'utf8'), source(index));
    assert.equal(readFileSync(join(regular.work, 'rolling-window-late.ts'), 'utf8'), source(12));

    live = await start('live', { tidyUi: true });
    const initialProbe = deferredNativePreparation(live); assert.ok(initialProbe.probes.length > 0);
    const epoch = initialProbe.probes.at(-1).epoch;
    assert.deepEqual(initialProbe.attempts.filter(event => event.epoch === epoch), [], 'new live history starts without stock write materialization');
    const initial = await live.capture('initial'); recordRedraw(live, initial, 'initial');
    await live.run('write-window-batch');
    const batch = await captureReady(live, 'after-batch'), batchStates = checkWindow(batch, [...Array(2).fill(false), ...Array(10).fill(true)], 'after-batch');
    recordRedraw(live, batch, 'after-batch');
    assert.deepEqual(deferredNativePreparation(live).attempts.filter(event => event.epoch === epoch), [], 'the 12 successful custom writes keep stock callbacks lazy');

    const oldestTitle = batch.screen.findIndex(row => row.includes('← Write rolling-window-00.ts'));
    assert.ok(oldestTitle >= 0, 'the oldest automatic card is physically available as a preview');
    live.send(`\x1b[<0;3;${oldestTitle + 1}M\x1b[<0;3;${oldestTitle + 1}m`); await live.settle();
    const manual = await captureReady(live, 'manual-oldest-full');
    checkWindow(manual, [true, false, ...Array(10).fill(true)], 'manual-oldest-full'); recordRedraw(live, manual, 'manual-oldest-full');
    assert.equal(byName(manual, 'write')[0].expanded, false, 'manual file choice does not mutate Pi native expansion state');

    await live.run('write-window-empty');
    const empty = await captureReady(live, 'after-empty-turn');
    checkWindow(empty, [true, false, ...Array(10).fill(true)], 'after-empty-turn'); recordRedraw(live, empty, 'after-empty-turn');

    await live.run('write-window-short');
    const short = await captureReady(live, 'after-short-turn');
    const shortStates = checkWindow(short, [true, false, false, ...Array(10).fill(true)], 'after-short-turn');
    recordRedraw(live, short, 'after-short-turn');
    assert.deepEqual(deferredNativePreparation(live).attempts.filter(event => event.epoch === epoch), [], 'batch, manual choice, empty turn and short-turn rotation remain stock-preparation free');
    assert.equal(byName(short, 'write').length, 13);
    const calls = live.events().filter(event => event.type === 'call'), results = live.events().filter(event => event.type === 'result');
    assert.equal(calls.length, 13); assert.ok(calls.every(event => event.name === 'write'));
    assert.equal(results.length, 13); assert.ok(results.every(event => !event.isError));
    assert.equal(live.events().filter(event => event.type === 'model_context').length, 16, 'the 12-file batch, empty turn and one-file turn all used the offline Pi provider');
    assert.deepEqual(sessionData(short), sessionData(nativeFinal), 'live file-card presentation preserves the exact Pi model/session/tool data from stock execution');
    assert.deepEqual(semanticEvents(live), semanticEvents(native), 'the owned presentation neither changes nor skips model, call or result traffic');
    for (let index = 0; index < 12; index++) assert.equal(readFileSync(join(live.work, `rolling-window-${String(index).padStart(2, '0')}.ts`), 'utf8'), source(index));
    assert.equal(readFileSync(join(live.work, 'rolling-window-late.ts'), 'utf8'), source(12));
    const sessionBytes = readFileSync(short.session);
    await live.close();

    replay = await start('replay', { tidyUi: true, session: short.session, workspace: live.work });
    const replayProbe = deferredNativePreparation(replay); assert.ok(replayProbe.probes.length > 0);
    const replayEpoch = replayProbe.probes.at(-1).epoch;
    const restored = await captureReady(replay, 'restored-all-preview');
    const restoredStates = checkWindow(restored, Array(13).fill(false), 'restored-all-preview'); recordRedraw(replay, restored, 'restored-all-preview');
    assert.deepEqual(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch), [], 'restored history remains custom and cold');
    assert.deepEqual(sessionData(restored), sessionData(short), 'manual display choice is not persisted as Pi tool/session state');
    assert.deepEqual(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)), []);
    assert.deepEqual(readFileSync(short.session), sessionBytes, 'replay reads the saved session without changing its bytes');
    const coverage = { successfulFiles: 13, turns: ['12 successful files', 'empty', '1 successful file'],
      afterBatch: batchStates, afterShortTurn: shortStates, replay: restoredStates, redraws,
      counters: { calls: calls.length, results: results.length, modelContexts: 16 } };
    writeFileSync(join(artifacts, 'write-window-coverage.json'), JSON.stringify(coverage, null, 2));
    console.log(`WRITE_WINDOW_COVERAGE ${JSON.stringify(coverage)}`);
  } finally { await closeTerminals(terminals.reverse()); }
});
