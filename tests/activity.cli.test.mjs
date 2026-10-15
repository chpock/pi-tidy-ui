import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, extension, artifacts, plain, lines, byName, toolLines } from './fixtures/terminal-harness.mjs';
import { closeTerminals } from './fixtures/terminal-cleanup.mjs';
import { referenceCell, persisted } from './fixtures/main-cli-support.mjs';

for (const mode of ['regular', 'fullscreen']) test(`real CLI: spinner shares Working frames with a document-inactivity fallback (${mode})`,
  { timeout: 180000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(`${name}-${mode}`, { ...options, mode, extraEnv: { TIDY_UI_TEST_SPINNER_DIAGNOSTICS: '1' } });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    const busyCapture = (terminal, name) => terminal.capture(name, { sampleAnimation: true });
    const normalTraffic = (terminal) => terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    const runningRow = terminal => terminal.screen().find(row => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tidy_ui_stream \[query="gated"\]$/u.test(row));
    const physicalFrames = async (terminal, animatedWorking = true) => {
      const distinct = new Set(), working = new Set();
      for (let i = 0; i < 5; i++) {
        await terminal.observeAnimation(); const row = runningRow(terminal);
        assert.ok(row, 'a real PTY frame, without any diagnostic render, contains the running glyph');
        distinct.add(row[1]);
        const native = terminal.screen().map(row => row.match(/^\s*([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]) Working\s*$/u)).find(Boolean);
        assert.ok(native, 'the physical screen retains native Working'); working.add(native[1]);
      }
      assert.ok(distinct.size >= 2, 'physical first cell really animates');
      if (animatedWorking) assert.ok(working.size >= 2, 'native Working itself physically animates, including after restoration');
      else assert.deepEqual([...working], ['●'], 'public static Working configuration stops only native animation');
      return { tool: [...distinct], working: [...working] };
    };
    const assertBusy = async (dump) => {
      const tool = byName(dump, 'tidy_ui_stream')[0];
      assert.equal(tool.executionStarted, true); assert.equal(tool.partial, true);
      const rows = lines(tool);
      assert.equal(rows.length, 1);
      assert.match(rows[0], /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tidy_ui_stream \[query="gated"\]$/u);
      const y = dump.screen.findIndex((row) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tidy_ui_stream \[query="gated"\]$/u.test(row));
      assert.ok(y >= 0, 'actual physical screen has the running glyph; only animation phase may differ from the tree snapshot');
      assert.equal(dump.cells[y][1].width, 1); assert.equal(dump.cells[y][3].text, 't');
      const expected = await referenceCell(dump.summaryStyles.dim);
      assert.deepEqual({ fg: dump.cells[y][1].fg, fgMode: dump.cells[y][1].fgMode, dim: dump.cells[y][1].dim },
        { fg: expected.fg, fgMode: expected.fgMode, dim: expected.dim });
      assert.ok(['', ' '].includes(dump.cells[y][dump.width - 1].text));
      assert.ok(!dump.screen.some((row) => row.includes('STREAM_PARTIAL')));
      const stats = dump.spinnerStats;
      assert.equal(stats.maxActive, 1); assert.ok(stats.active <= 1, 'one deadline, or a pending host request');
      assert.equal(stats.starts - stats.cancels - stats.ticks, stats.active, 'all allocated deadlines are cancelled, fired or still pending');
      assert.equal(stats.unrefs, stats.starts, 'every shared deadline is unreferenced');
      assert.ok(stats.delays.every(delay => delay === 100));
      return dump.cells[y][1].text;
    };
    try {
      const stock = await start('spinner-stock');
      stock.send('run pending\r'); await stock.event('provider_gate');
      writeFileSync(join(stock.output, 'provider-go'), 'go'); await stock.event('tool_gate');
      const nativePartial = await busyCapture(stock, 'partial');
      writeFileSync(join(stock.output, 'tool-go'), 'go'); await stock.event('agent_end');
      const native = await stock.capture('complete');
      assert.equal(native.spinnerStats.starts, 0, 'observer ignores native Pi animation timers');
      const live = await start('spinner-tidyUi', { tidyUi: true, workspace: stock.work });
      const idle = await live.capture('idle'); assert.equal(idle.spinnerStats.starts, 0);
      live.send('run pending\r'); await live.event('provider_gate');
      const argumentsOnly = await busyCapture(live, 'arguments');
      assert.equal(argumentsOnly.spinnerStats.starts, 0); assert.equal(argumentsOnly.spinnerStats.ticks, 0);
      assert.equal(lines(argumentsOnly.tools[0])[0], ' → read a.txt');
       writeFileSync(join(live.output, 'provider-go'), 'go'); await live.event('tool_gate');
       // Cache notifications precede repaint; warm the cold owners before sampling.
       const clearStats = await live.cacheSnapshot(true);
       const prepared = await busyCapture(live, 'working-prepare'); await assertBusy(prepared);
       assert.equal(clearStats.entries, 0, 'the clear packet precedes cold layout materialization');
       const warmStats = await live.cacheSnapshot();
       const warm = await busyCapture(live, 'working-warm'); await assertBusy(warm);
       assert.equal(warmStats.byKind.summary.entries, warm.tools.length, 'all tool summaries are warm before the baseline packet');
       assert.equal(warmStats.byKind.user.entries, warm.users.length, 'all user layouts are warm before the baseline packet');
       const builds = warmStats.builds, bytesRunning = readFileSync(warm.session);
      const hostFrames = await physicalFrames(live);
      const hotStats = await live.cacheSnapshot();
      const hot = await busyCapture(live, 'working-hot'); await assertBusy(hot);
       assert.equal(hot.spinnerStats.requests, hot.spinnerStats.ticks,
         'any expired document-inactivity deadline requests exactly one frame, even with native Working enabled');
      assert.ok(hot.spinnerStats.starts > warm.spinnerStats.starts, 'real host document visits rearm the one-shot deadline');
      assert.equal(hotStats.builds, builds, 'host-driven animation builds no custom body');
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      // A one-frame public Working configuration stops only Pi's native animation.
      // The still-running real tool must continue moving via pi-tidy-ui's fallback.
      live.send('/tidy-ui-spinner-working static\r'); await live.event('spinner_working');
      await live.event('spinner_tick_checkpoint');
      const fallbackWarmStats = await live.cacheSnapshot();
      const fallbackWarm = await busyCapture(live, 'fallback-warm'); await assertBusy(fallbackWarm);
       const fallbackFrames = await physicalFrames(live, false);
      await live.event('spinner_tick_checkpoint', 2);
      const fallbackHotStats = await live.cacheSnapshot();
      const fallbackHot = await busyCapture(live, 'fallback-hot'); await assertBusy(fallbackHot);
      assert.ok(fallbackHot.spinnerStats.ticks > fallbackWarm.spinnerStats.ticks);
      assert.equal(fallbackHot.spinnerStats.requests - fallbackWarm.spinnerStats.requests,
        fallbackHot.spinnerStats.ticks - fallbackWarm.spinnerStats.ticks, 'each eligible fallback wake requests exactly one frame');
      assert.equal(fallbackHotStats.builds, builds, 'fallback-driven animation builds no custom body');
      assert.ok(Object.keys(fallbackHot.spinnerWork.widths).every(key => key.endsWith(':100')), 'clock diagnostics never render alternate widths');
      assert.equal(fallbackHot.spinnerWork.invalidations, hot.spinnerWork.invalidations, 'fallback requests no native tool invalidation');
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      live.send('/tidy-ui-spinner-working animated\r'); await live.event('spinner_working', 2); await live.observeAnimation();
       const sharedAgainStats = await live.cacheSnapshot();
       const sharedAgain = await busyCapture(live, 'working-restored'); await assertBusy(sharedAgain);
       const restoredFrames = await physicalFrames(live);
       const sharedHotStats = await live.cacheSnapshot();
       const sharedHot = await busyCapture(live, 'working-restored-hot'); await assertBusy(sharedHot);
       assert.ok(sharedHot.spinnerStats.starts > sharedAgain.spinnerStats.starts, 'resumed host document visits rearm the deadline');
       assert.equal(sharedHot.spinnerStats.requests - sharedAgain.spinnerStats.requests,
         sharedHot.spinnerStats.ticks - sharedAgain.spinnerStats.ticks, 'Working restoration still permits one request per expired deadline');
       assert.equal(sharedHotStats.builds, sharedAgainStats.builds, 'restored native animation and any fallback rebuild no custom body');
       assert.equal(sharedHot.spinnerWork.invalidations, sharedAgain.spinnerWork.invalidations, 'restored animation adds no tool invalidation');
      assert.deepEqual(readFileSync(warm.session), bytesRunning);
      await live.appearance(false);
      const off = await busyCapture(live, 'off'); assert.equal(off.spinnerStats.active, 0);
      assert.equal(off.spinnerStats.starts - off.spinnerStats.cancels - off.spinnerStats.ticks, 0);
      assert.deepEqual(toolLines(off), toolLines(nativePartial), 'off delegates actual partial information exactly to native');
      const offAgain = await busyCapture(live, 'off-again'); assert.deepEqual(offAgain.spinnerStats, off.spinnerStats, 'zero pi-tidy-ui ticks/redraws while off despite active native animation');
      await live.appearance(true);
      const on = await busyCapture(live, 'on'); await assertBusy(on); assert.ok(on.spinnerStats.starts > off.spinnerStats.starts);
      writeFileSync(join(live.output, 'tool-go'), 'go'); await live.event('agent_end');
      const complete = await live.capture('complete'); assert.equal(complete.spinnerStats.active, 0);
      assert.equal(complete.spinnerStats.starts - complete.spinnerStats.cancels - complete.spinnerStats.ticks, 0);
      assert.equal(lines(byName(complete, 'tidy_ui_stream')[0])[0], ' ⚙ tidy_ui_stream [query="gated"]');
      const idleAgain = await live.capture('idle-again'); assert.deepEqual(idleAgain.spinnerStats, complete.spinnerStats, 'zero ticks and zero spinner render requests after completion');
      const traffic = normalTraffic(live); assert.deepEqual(traffic, normalTraffic(stock));
      assert.equal(traffic.filter(event => event.type === 'call').length, 2);
      assert.equal(traffic.filter(event => event.type === 'result').length, 2);
      assert.equal(traffic.filter(event => event.type === 'model_context').length, 3);
      assert.deepEqual(persisted(complete), persisted(native));
      const bytes = readFileSync(complete.session), starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); assert.equal(reloaded.spinnerStats.starts, 0);
       assert.ok(!complete.tools[1].before.some(entry => entry.kind === 'ThemedText' && entry.lines.some(row => row.includes('pi-tidy-ui: on'))),
         'settings feedback stays inside the popup and does not add transcript notifications');
       assert.ok(complete.tools[1].before.some(entry => entry.kind === 'ThemedText' && entry.lines.some(row => row.trim() === 'TERMINAL_CAPTURE off-again')),
         'the test observation notification, not a popup action, precedes the live tool');
       assert.deepEqual(complete.tools[1].lines.map(plain), ['', ' ⚙ tidy_ui_stream [query="gated"]'],
         'the known test-only notification creates exactly one leading gap');
      assert.ok(reloaded.tools[1].before.some(entry => entry.name === 'read'));
      assert.deepEqual(reloaded.tools[0].lines, complete.tools[0].lines);
       assert.deepEqual(reloaded.tools[1].lines, complete.tools[1].lines.slice(1),
         'history has no test-only notification; only its proven single leading gap disappears');
      assert.deepEqual(readFileSync(complete.session), bytes);
      const replay = await start('spinner-replay', { tidyUi: true, session: complete.session, workspace: stock.work });
      const resumed = await replay.capture('replay'); assert.equal(resumed.spinnerStats.starts, 0); assert.equal(resumed.spinnerStats.ticks, 0);
      assert.deepEqual(toolLines(resumed), toolLines(reloaded)); assert.deepEqual(persisted(resumed), persisted(native));
      assert.deepEqual(readFileSync(complete.session), bytes);
      for (const terminal of [stock, live]) {
        rmSync(join(terminal.output, 'provider-go')); rmSync(join(terminal.output, 'tool-go'));
        terminal.send('run pending-abort\r'); await terminal.event('provider_gate', 2);
        writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate', 2);
        await terminal.observeAnimation();
        terminal.send('\x1b'); await terminal.event('agent_end', 2);
      }
      const aborted = await live.capture('aborted'), abortedNative = await stock.capture('aborted');
      assert.equal(aborted.spinnerStats.active, 0);
      assert.equal(byName(aborted, 'tidy_ui_stream').at(-1).isError, true);
      assert.deepEqual(normalTraffic(live), normalTraffic(stock), 'cancellation also preserves exact real tool/model traffic');
      assert.deepEqual(persisted(aborted), persisted(abortedNative));
      const afterAbort = await live.capture('after-abort'); assert.deepEqual(afterAbort.spinnerStats, aborted.spinnerStats);
      writeFileSync(join(artifacts, `spinner-coverage-${mode}.json`), JSON.stringify({
        mode, normalCalls: 2, normalResults: 2, normalModelContexts: 3, buildsBefore: builds, buildsAfter: fallbackHotStats.builds,
        sharedClock: hot.spinnerStats, fallbackClock: fallbackHot.spinnerStats, sharedAgain: sharedHot.spinnerStats,
        stoppedClock: complete.spinnerStats, abortedClock: aborted.spinnerStats,
        hostPhysicalFrames: hostFrames.tool, fallbackPhysicalFrames: fallbackFrames.tool,
        nativeWorkingFrames: hostFrames.working, staticWorkingFrames: fallbackFrames.working, restoredWorkingFrames: restoredFrames.working,
        idleRequestsAdded: 0, idleTicksAdded: 0,
        controls: ['native partial/complete', 'pre-execution zero clocks', 'native Working movement with one request per expired deadline', 'static Working fallback',
          'restored native Working movement', 'hot cached animation', 'off/on while running', 'completion idle', 'reload', 'same-session replay', 'native cancellation traffic'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });

test('real CLI: gated pending/streaming, image/hidden fallback and exact-name flags',
  { timeout: 120000 }, async (t) => {
    assert.ok(existsSync(extension), 'src/index.ts is required for the implementation gate');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    try {
      const live = await start('pending', { tidyUi: true });
      live.send('run pending\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending');
      assert.equal(lines(byName(pending, 'read')[0]).length, 1);
      assert.equal(lines(byName(pending, 'read')[0])[0], ' → read a.txt');
      assert.equal(byName(pending, 'read')[0].executionStarted, false);
      assert.ok(pending.screen.some((line) => line === ' → read a.txt'), 'argument streaming retains the static glyph and has no trailing ellipsis');
      writeFileSync(join(live.output, 'provider-go'), 'go'); await live.event('tool_gate');
      const streaming = await live.capture('tool-pending');
      assert.equal(lines(byName(streaming, 'tidy_ui_stream')[0]).length, 1);
      assert.match(lines(byName(streaming, 'tidy_ui_stream')[0])[0], /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tidy_ui_stream \[query="gated"\]$/u);
      assert.equal(byName(streaming, 'tidy_ui_stream')[0].executionStarted, true);
      assert.ok(streaming.screen.some((line) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] tidy_ui_stream \[query="gated"\]$/u.test(line)), 'actual screen shows a spinner in column one and no trailing marker');
      assert.ok(!streaming.screen.some((line) => line.includes('STREAM_PARTIAL')));
      writeFileSync(join(live.output, 'tool-go'), 'go'); await live.event('agent_end');
      const complete = await live.capture('complete');
      assert.equal(lines(byName(complete, 'tidy_ui_stream')[0])[0], ' ⚙ tidy_ui_stream [query="gated"]');
      await live.run('future');
      await live.run('fallback'); const fallback = await live.capture('fallback');
      assert.ok(byName(fallback, 'read').at(-1).content.some((c) => c.type === 'image'), 'real image read produced an image result');
      const native = await start('fallback-stock-replay', { session: fallback.session });
      const stock = await native.capture('fallback');
      await t.test('image fallback matches same-session stock replay', () => {
        assert.deepEqual(byName(fallback, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image rendering stays native');
        assert.ok(fallback.screen.some((line) => line.includes('pixel.png')));
      });
      await t.test('intentionally hidden renderer remains hidden live', () => {
        assert.deepEqual(byName(fallback, 'tidy_ui_hidden').map((tool) => tool.lines), byName(stock, 'tidy_ui_hidden').map((tool) => tool.lines));
        assert.equal(lines(byName(fallback, 'tidy_ui_hidden')[0]).length, 0);
        assert.ok(!fallback.screen.some((line) => line.includes('tidy_ui_hidden')));
      });
      const card = await start('flag-card', { tidyUi: true,
        flags: ['--tidy-ui-card', 'tidy_ui_unknown,tidy_ui_stream'], session: fallback.session });
      const cards = await card.capture('cards');
      for (const name of ['tidy_ui_unknown', 'tidy_ui_stream'])
        assert.deepEqual(byName(cards, name)[0].lines, byName(stock, name)[0].lines, `comma-separated card flag: ${name}`);
      const override = await start('flag-override', { tidyUi: true,
        flags: ['--tidy-ui-card', 'tidy_ui_stream,tidy_ui_hidden,read', '--tidy-ui-compact', 'tidy_ui_stream,tidy_ui_hidden,read'], session: fallback.session });
      const overrides = await override.capture('override');
      assert.equal(lines(byName(overrides, 'tidy_ui_stream')[0]).length, 1, 'compact override wins');
      await t.test('hidden safeguard wins over flags on replay', () => {
        assert.equal(lines(byName(overrides, 'tidy_ui_hidden')[0]).length, 0, 'hidden safeguard wins over flags');
      });
      assert.deepEqual(byName(overrides, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image safeguard wins over flags');
      const exact = await start('flag-exact', { tidyUi: true,
        flags: ['--tidy-ui-card', 'tidy_ui_strea,READ'], session: fallback.session });
      const exactDump = await exact.capture('exact');
      assert.equal(lines(byName(exactDump, 'tidy_ui_stream')[0]).length, 1, 'names are not prefixes');
      assert.equal(lines(byName(exactDump, 'read')[0]).length, 1, 'names are case-sensitive');
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });
