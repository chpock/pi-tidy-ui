import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';
import { PiTerminal, plain, byName, toolLines, assertFits, until } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../fixtures/terminal-cleanup.mjs';
import { referenceCell, allBashCards, traffic, sgrAt } from '../../fixtures/main-cli-support.mjs';

test('Output padding settings update summaries and all transcript cards live with native and replay controls', { timeout: 180000 }, async () => {
  const terminals = [], extraEnv = { TIDY_UI_TEST_USER_CARDS: '1' };
  const start = async (name, options) => {
    const terminal = new PiTerminal(name, { extraEnv, agentSettings: { outputPad: 0, editorPaddingX: 2 }, ...options });
    terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 220); return terminal;
  };
  const setPadding = async (terminal, value) => {
    await terminal.command('/settings'); terminal.send('Output padding'); await terminal.settle();
    terminal.send('\r'); await terminal.settle();
    assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ Output padding\\s+${value}\\s*$`, 'u').test(row)));
    terminal.send('\x1b'); await terminal.settle();
    assert.equal(JSON.parse(readFileSync(join(terminal.agent, 'settings.json'), 'utf8')).outputPad, value);
  };
  const check = async (terminal, padding, width, label) => {
    await terminal.resize(width, 220);
    const dump = await terminal.capture(`pointer-output-${label}`);
    assert.equal(dump.outputPad, padding); assert.equal(dump.width, width); assert.equal(dump.users.length, 1);
    assert.equal(dump.users[0].outputPad, padding);
    const cards = [dump.users[0], byName(dump, 'bash')[0], byName(dump, 'write')[0], byName(dump, 'edit')[0]];
    for (const [index, card] of cards.entries()) {
      const rows = card.lines.filter(row => row !== ''), expected = rows.map(plain);
      const y = dump.screen.findIndex((_, start) => expected.every((row, offset) => dump.screen[start + offset] !== undefined && plain(dump.screen[start + offset]) === row));
      assert.ok(y >= 0, `entire ${index} card physically visible: ${label}`);
      const background = await referenceCell(dump.backgroundStyles[index === 0 ? 'userMessageBg' : 'toolPendingBg']);
      const stripe = await referenceCell(dump.frameStyles[index === 0 ? 'userBorder' : 'border']);
      for (let offset = 0; offset < rows.length; offset++) {
        const cells = dump.cells[y + offset];
        assert.equal(cells[padding].text, '┃'); assert.equal(cells[padding].fg, stripe.fg); assert.equal(cells[padding].bgMode, 0);
        for (const x of [padding + 1, width - padding - 1]) {
          assert.equal(cells[x].text, ' '); assert.equal(cells[x].bg, background.bg); assert.equal(cells[x].bgMode, background.bgMode);
        }
        if (padding) for (const x of [0, width - 1]) { assert.equal(cells[x].text, ' '); assert.equal(cells[x].bgMode, 0); }
      }
      await assertFits(rows, width);
    }
    for (const summary of [...byName(dump, 'read'), ...byName(dump, 'tidy_ui_unknown')]) {
      const rows = summary.lines.filter(row => row !== '').map(plain);
      assert.ok(rows[0][padding] === (summary.name === 'read' ? '→' : '⚙'));
      assert.ok(rows.slice(1).every(row => row.startsWith(' '.repeat(padding + 2))));
      await assertFits(rows, width - padding);
      const y = dump.screen.findIndex((_, start) => rows.every((row, offset) => (dump.screen[start + offset] || '').slice(0, row.length) === row));
      assert.ok(y >= 0, 'complete wrapped summary block physically visible');
      if (padding) assert.ok(rows.every((_, offset) => dump.cells[y + offset][width - 1].text === ''));
    }
    allBashCards(dump);
    assert.equal(dump.editor.padding, 2); assert.ok(dump.editor.lines.every(row => plain(row)[2] === '┃'), 'Editor padding remains independent');
    assert.equal(dump.extensionIssues.length, 0);
    return dump;
  };
  const identity = dump => dump.tools.map(({ args, content, details, isError }) => ({ args, content, details, isError }));
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const live = await start(`output-padding-${mode}`, { tidyUi: true, mode });
      await live.run('suite'); const activity = traffic(live, 7), first = await check(live, 0, 100, `${mode}-initial`);
      const bytes = readFileSync(first.session), saved = new Map();
      for (const [cycle, padding] of [0, 1, 0].entries()) {
        if (cycle) await setPadding(live, padding);
        for (const width of [24, 100]) {
          const dump = await check(live, padding, width, `${mode}-${cycle}-${width}`);
          saved.set(`${padding}-${width}`, dump); assert.deepEqual(identity(dump), identity(first));
          const rows = dump.users[0].lines.filter(row => row !== '');
          await live.appearance(false);
          const native = await live.capture(`native-user-output-${mode}-${cycle}-${width}`);
          const contentWidth = width - 2 * padding - 3;
          assert.deepEqual(rows.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding + 2, contentWidth))),
            native.users[0].contentControl.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, padding, contentWidth))), 'native Markdown body at equal content width');
          assert.deepEqual(identity(native), identity(first));
          await live.appearance(true);
          const restored = await check(live, padding, width, `${mode}-${cycle}-${width}-on`);
          assert.deepEqual(restored.tools.map(tool => tool.lines), dump.tools.map(tool => tool.lines));
        }
      }
      await live.resize(100, 220);
      const current = saved.get('0-100');
      await live.command('/reload'); await live.event('start', 2);
      const reloaded = await check(live, 0, 100, `${mode}-reload`);
      assert.deepEqual(reloaded.tools.map(tool => tool.lines), current.tools.map(tool => tool.lines));
      if (mode === 'fullscreen') {
        const edit = byName(reloaded, 'edit')[0], expected = edit.lines.filter(row => row !== '').map(plain);
        const y = reloaded.screen.findIndex((_, start) => expected.every((row, offset) => reloaded.screen[start + offset] !== undefined && plain(reloaded.screen[start + offset]) === row));
        assert.ok(y >= 0, 'complete zero-margin edit panel is on the physical screen');
        await sgrAt(live, 0, y);
        const expanded = await live.capture(`pointer-output-${mode}-click-zero`);
        assert.equal(byName(expanded, 'edit')[0].expanded, true, 'zero-margin stripe is a real panel click target');
        live.send('\x0f'); await live.settle(); // native global toggle from false to true
        live.send('\x0f'); await live.settle(); // restore every tool to collapsed
      }
      assert.deepEqual(traffic(live, 7), activity); assert.deepEqual(readFileSync(first.session), bytes);
      await live.close();
      const replay = await start(`output-padding-replay-${mode}`, { tidyUi: true, mode, session: first.session, workspace: live.work });
      const native = await start(`output-padding-native-${mode}`, { tidyUi: false, mode, session: first.session, workspace: live.work });
      for (const padding of [0, 1]) {
        if (padding) { await setPadding(replay, padding); await setPadding(native, padding); }
        for (const width of [24, 100]) {
          const custom = await check(replay, padding, width, `replay-${mode}-${padding}-${width}`), expected = saved.get(`${padding}-${width}`);
          assert.deepEqual(custom.tools.map(tool => tool.lines), expected.tools.map(tool => tool.lines));
          assert.deepEqual(custom.users.map(user => user.lines), expected.users.map(user => user.lines));
          await replay.appearance(false);
          const off = await replay.capture(`pointer-output-native-${mode}-${padding}-${width}`);
          await native.resize(width, 220);
          const control = await native.capture(`pointer-output-control-${mode}-${padding}-${width}`);
          assert.deepEqual(off.tools.map(tool => tool.lines), control.tools.map(tool => tool.lines), 'complete native same-session tool rows restored without padding changes');
          assert.deepEqual(off.users.map(user => user.lines), control.users.map(user => user.lines));
          await replay.appearance(true);
        }
      }
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter(event => event.type === type).length, 0);
      assert.deepEqual(readFileSync(first.session), bytes);
      await runCleanupSteps(() => native.close(), () => replay.close());
      assert.equal(native.closed && replay.closed, true, 'completed mode peers are reaped before the next mode');
    }
  } finally { await closeTerminals(terminals.reverse()); }
});

test('Output padding project override stays consistent after native user padding changes', { timeout: 60000 }, async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = new PiTerminal(`output-padding-project-${mode}`, {
      tidyUi: true, mode, extraEnv: { TIDY_UI_TEST_USER_CARDS: '1' },
      // Override the harness's -na only for this isolated, test-owned project config.
      flags: ['--approve'], agentSettings: { outputPad: 1 },
      profileFactory: ({ workDir }) => {
        mkdirSync(join(workDir, '.pi'), { recursive: true });
        writeFileSync(join(workDir, '.pi', 'settings.json'), JSON.stringify({ outputPad: 0 }));
      },
    });
    try {
      await live.ready(); await live.resize(100, 220); await live.run('suite');
      const before = await live.capture(`pointer-project-before-${mode}`), activity = traffic(live, 7), bytes = readFileSync(before.session);
      assert.equal(before.outputPad, 0); assert.equal(before.users[0].outputPad, 0);
      await live.command('/settings'); live.send('Output padding'); await live.settle(); live.send('\r'); await live.settle();
      assert.ok(live.screen().some(row => /^\s*→ Output padding\s+1\s*$/u.test(row)));
      live.send('\x1b'); await live.settle();
      const after = await live.capture(`pointer-project-after-${mode}`);
      assert.equal(after.outputPad, 0, 'public effective settings keep the project override');
      assert.equal(after.users[0].outputPad, 1, 'actual Pi callback changes native user-component geometry separately');
      assert.deepEqual(after.tools.map(tool => tool.lines), before.tools.map(tool => tool.lines));
      assert.deepEqual(after.users.map(user => user.lines), before.users.map(user => user.lines), 'all pi-tidy-ui margins continue using effective padding with identical Markdown');
      const body = after.users[0].lines.filter(row => row !== '').slice(1, -1);
      await live.appearance(false);
      const native = await live.capture(`native-user-project-${mode}`);
      assert.equal(native.users[0].outputPad, 1, 'never mutate Pi component geometry to reconcile settings');
      assert.deepEqual(body.map(row => stripVTControlCharacters(sliceByColumn(row, 2, 97))),
        native.users[0].contentControl.slice(1, -1).map(row => stripVTControlCharacters(sliceByColumn(row, 1, 97))));
      assert.deepEqual(traffic(live, 7), activity); assert.deepEqual(readFileSync(before.session), bytes);
      assert.equal(after.extensionIssues.length, 0);
    } finally { await closeTerminals([live]); }
  }
});

for (const mode of ['regular', 'fullscreen']) test(`real CLI: settings popup navigation, shared preferences, local reload and fresh-process replay (${mode})`,
  { timeout: 120000 }, async () => {
    const terminals = [], initialSettings = { terminalColorsEnabled: true, unrelated: { retained: 42 } };
    const dataEvents = terminal => terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
    const live = new PiTerminal(`settings-${mode}`, { tidyUi: true, mode, tidyUiSettings: initialSettings }); terminals.push(live);
    try {
      await live.ready(); await live.run('user-card');
      const original = await live.capture('settings-original'), sessionBytes = readFileSync(original.session), originalEvents = dataEvents(live);
      assert.deepEqual(['call', 'result', 'model_context'].map(type => originalEvents.filter(event => event.type === type).length), [2, 2, 3]);
      const path = join(live.agent, 'extensions/pi-tidy-ui/config.json'), before = readFileSync(path);
      let layoutCapture = 0;
      const checkLayout = heading => {
        const dump = live.captureScreen(`settings-layout-${++layoutCapture}`, {}), bounds = live.tidyFrame();
        assert.ok(bounds, 'the actual terminal paints the full popup frame');
        const { left, width, top, bottom } = bounds, rows = dump.screen.map(row => sliceByColumn(row, left, width));
        assert.equal(left, Math.floor((live.term.cols - width) / 2), 'the actual size is centered, not just its text');
        assert.ok(width <= Math.min(72, live.term.cols));
        const frame = rows.slice(top, bottom + 1), dividers = frame.flatMap((row, index) => /^├─+┤$/u.test(row) ? [index] : []);
        assert.equal(frame[1].slice(1, -1).trim(), heading);
        assert.deepEqual(dividers, [2, frame.length - 3]);
        assert.equal(frame.at(-6).slice(1, -1).trim(), '', 'a physical blank row separates the list and description');
        const help = frame.slice(-5, -3).map(row => row.slice(1, -1).trimEnd());
        assert.equal(help.length, 2); assert.ok(help[0].trim());
        assert.match(frame.at(-2), width >= 70 ? /↑↓ Navigate.*Enter Select.*Esc (?:Close|Back)/u : /↑↓ Navigate/u);
        assert.doesNotMatch(frame.join('\n'), /Choices are saved automatically|Applying|Saving|Applied and saved/u);
        assert.ok(dump.cells[top + 1][left + 1].bold, 'the real heading is bold');
        const border = dump.cells[top][left + 1];
        for (const y of dividers) for (let x = 1; x < width - 1; x++) {
          const cell = dump.cells[top + y][left + x];
          assert.equal(cell.text, '─'); assert.equal(cell.fg, border.fg); assert.equal(cell.fgMode, border.fgMode);
        }
        return help;
      };
      const checkRootColumns = (narrow = false, expectedColumn) => {
        const dump = live.captureScreen(`settings-columns-${++layoutCapture}`, {}), bounds = live.tidyFrame();
        assert.ok(bounds);
        const items = ['Tidy', 'Code color', 'Set', 'Status', 'Close'].map(label => {
          const y = live.tidyRows().findIndex(row => /^(?:→ |  )/u.test(row) && row.slice(2).startsWith(label));
          if (narrow && y < 0) return undefined;
          assert.ok(y >= 0, `root item is painted: ${label}`);
          return { y, text: sliceByColumn(dump.screen[y], bounds.left + 1, bounds.width - 2),
            value: label === 'Code color' ? narrow ? 'Fo…' : 'Follow Pi' : ['Tidy', 'Set'].includes(label) ? 'On' : undefined };
        }).filter(Boolean);
        const anchor = items.find(item => item.value);
        const column = expectedColumn ?? (anchor ? anchor.text.indexOf(anchor.value) : -1);
        assert.ok(column >= 0);
        for (const { y, text, value } of items) {
          if (value) {
            assert.equal(text.indexOf(value), column, 'all visible values keep the common start through selection and scrolling');
            assert.equal(dump.cells[y][bounds.left + 1 + column].text, value[0]);
          }
          const label = text.slice(2).split(/ {2,}/u)[0].trimEnd();
          assert.ok(2 + visibleWidth(label) + 2 <= column, 'every label ends before the shared value column');
          if (!text.includes('›')) continue;
          assert.equal(text.lastIndexOf('›'), bounds.width - 3);
          assert.equal(dump.cells[y][bounds.left + bounds.width - 2].text, '›', 'native physical arrow cell matches the separate column');
        }
        return column;
      };
      await live.resize(100, 30); await live.openTidyMenu();
      checkLayout('Tidy UI'); checkRootColumns();
      const rootWidth = live.tidyFrame().width;
      assert.ok(rootWidth < 72, 'ordinary settings size to their content, not a fixed 72-column window');
      for (const label of ['Tidy UI appearance', 'Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close', 'Code color theme']) {
        await live.selectTidyItem(label, false); checkLayout('Tidy UI'); checkRootColumns();
        assert.equal(live.tidyFrame().width, rootWidth, 'moving selection/changing descriptions never resizes the page');
      }
      await live.resize(140, 30);
      await until(() => live.tidyFrame()?.left === Math.floor((140 - rootWidth) / 2), 'native overlay recenters at its intrinsic width');
      checkLayout('Tidy UI'); assert.equal(live.tidyFrame().width, rootWidth);
      await live.resize(100, 30);
      await until(() => live.tidyFrame()?.left === Math.floor((100 - rootWidth) / 2), 'native overlay returns to the original center');
      live.captureScreen('settings-root', { root: live.tidyRows() });
      assert.ok(live.tidyRows().some(row => row.startsWith('→ Code color theme')), 'initial Enter is navigation, not a toggle');
      assert.ok(!live.tidyRows().some(row => /Occipital|cache|logs/u.test(row)), 'technical controls are nested');
      live.send('\r'); await until(() => live.tidyHeading('Code color theme') && live.tidyRows().some(row => row.includes('Follow Pi theme')), 'first Enter opens theme picker');
      assert.equal(checkLayout('Code color theme')[1], '', 'a short description retains its empty second physical row');
      const themeWidth = live.tidyFrame().width;
      assert.notEqual(themeWidth, rootWidth, 'the same public overlay changes actual bounds for a new page');
      live.send('zz_no_such_theme');
      await until(() => live.tidyRows().some(row => row.includes('Search:') && row.includes('zz_no_such_theme')) && !live.tidyRows().some(row => row.includes('Follow Pi theme')), 'search filters theme choices');
      checkLayout('Code color theme');
      assert.equal(live.tidyFrame().width, themeWidth, 'theme filtering cannot shrink the popup');
      live.captureScreen('settings-theme-filter', {});
      live.send('\x1b'); await until(() => live.tidyHeading('Tidy UI') && live.tidyRows().some(row => row.startsWith('→ Code color theme')), 'Escape returns to the root');
      assert.equal(live.tidyFrame().width, rootWidth, 'Back restores the root intrinsic width');
      await live.resize(24, 12);
      await until(() => live.tidyFrame()?.width === 24 && live.tidyHeading('Tidy UI') && live.tidyRows().some(row => row.startsWith('→ Code color')), 'narrow popup redraw');
      assert.ok(checkLayout('Tidy UI')[1].endsWith('…'), 'the real narrow description ellipsizes its second row');
      const narrowColumn = checkRootColumns(true);
      for (const label of ['Set terminal colors from Pi theme', 'Status & troubleshooting', 'Close', 'Code color theme']) {
        await live.selectTidyItem(label, false); checkRootColumns(true, narrowColumn);
      }
      await live.selectTidyItem('Status & troubleshooting'); await live.selectTidyItem('Display cache');
      assert.ok(live.tidyRows().some(row => /Esc Back.*PgUp\/PgDn/u.test(row)), 'real 24-column detail navigation retains Back and paging keys');
      live.captureScreen('settings-narrow-details', {});
      live.send('\x1b'); await until(() => live.tidyHeading('Status & troubleshooting'), 'Back from narrow details');
      live.send('\x1b'); await until(() => live.tidyHeading('Tidy UI'), 'Back from narrow support');
      await live.selectTidyItem('Code color theme', false);
      await live.resize(100, 30);
      await until(() => live.tidyRows().some(row => row.startsWith('→ Code color theme') && row.includes('Follow Pi')), 'wide popup redraw');
      assert.equal(live.tidyFrame().width, rootWidth, 'widening restores intrinsic size, not terminal width');
      await live.selectTidyItem('Close', false);
      assert.match(checkLayout('Tidy UI').join(' '), /Close this panel without changing anything\./u);
      await live.closeTidyMenu(); assert.deepEqual(readFileSync(path), before, 'opening, searching and cancelling never writes settings');
      await live.tidyPage(['Code color theme', 'Follow Pi theme']);
      if (mode === 'fullscreen') {
        await live.openTidyMenu();
        const bounds = live.tidyFrame(), y = live.tidyRows().findIndex(row => row.includes('Set terminal colors from Pi theme'));
        assert.ok(bounds && y >= 0);
        const click = x => live.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
        const savedBeforePointer = readFileSync(path);
        for (const x of [bounds.left - 1, bounds.left, bounds.left + bounds.width - 1, bounds.left + bounds.width]) click(x);
        live.send('\x1b[B');
        await until(() => live.tidyRows().some(row => row.startsWith('→ Set terminal colors from Pi theme')), 'keyboard acknowledgement after border/outside mouse input');
        assert.deepEqual(readFileSync(path), savedBeforePointer, 'neither frame nor outside columns change persistent settings');
        click(bounds.left + 4);
        await until(() => JSON.parse(readFileSync(path, 'utf8')).terminalColorsEnabled === false, 'normalized mouse toggles exactly the clicked setting');
        assert.ok(live.tidyHeading('Tidy UI')); await live.closeTidyMenu();
      } else await live.terminalColors(false);
      await live.tidyPage(['Status & troubleshooting', 'Use Occipital highlighting']);
      await live.diagnosticLogging(false); await live.appearance(false);
      const saved = { ...initialSettings, syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false,
        nativeHighlightingEnabled: false };
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), saved);
      const off = await live.capture('settings-all-off');
      assert.notDeepEqual(toolLines(off), toolLines(original), 'appearance Off removes the enabled card presentation');
      const nativeReplay = new PiTerminal(`settings-native-replay-${mode}`, { mode, session: original.session, workspace: live.work }); terminals.push(nativeReplay);
      await nativeReplay.ready(); const nativeHistory = await nativeReplay.capture('settings-native-history');
      assert.equal(dataEvents(nativeReplay).length, 0, 'native history reference executes no tools or model requests');
      await nativeReplay.close();
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('settings-restored-off');
      assert.deepEqual(toolLines(reloaded), toolLines(nativeHistory), 'process-local Off survives real reload and restores exact native history rows');
      const rootRows = await live.tidyPage();
      assert.ok(rootRows.some(row => /Tidy UI appearance\s+Off$/u.test(row)));
      assert.ok(rootRows.some(row => /Set terminal colors from Pi theme\s+Off$/u.test(row)));
      const support = await live.tidyPage(['Status & troubleshooting']);
      assert.ok(support.some(row => /Use Occipital highlighting\s+Off$/u.test(row)));
      assert.ok((await live.tidyPage(['Status & troubleshooting', 'Diagnostic logs'])).some(row => row === 'Recording: Off'));
      assert.deepEqual(readFileSync(original.session), sessionBytes); assert.deepEqual(dataEvents(live), originalEvents);
      await live.close();
      assert.equal(nativeReplay.closed && live.closed, true, 'completed references are reaped before fresh-process replay');
      const replay = new PiTerminal(`settings-replay-${mode}`, { tidyUi: true, mode, session: original.session, workspace: live.work, tidyUiSettings: saved,
        extraEnv: { TIDY_UI_TEST_MENU_GEOMETRY: '1' } }); terminals.push(replay);
      await replay.ready(); const restored = await replay.capture('settings-fresh-process');
      assert.deepEqual(toolLines(restored), toolLines(original)); assert.deepEqual(restored.branch, original.branch);
      assert.equal(dataEvents(replay).length, 0, 'saved history executes no tool or model request');
      assert.ok((await replay.tidyPage(['Status & troubleshooting', 'Diagnostic logs'])).some(row => row === 'Recording: On'),
        'new processes start recording independently of the previous process-local Off');
      assert.deepEqual(readFileSync(original.session), sessionBytes);
      const compactEvents = dataEvents(replay), file = join(replay.agent, 'extensions/pi-tidy-ui/config.json');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved, 'fresh replay retains shared preferences and unrelated settings only');
      const compactRoot = await replay.tidyPage();
      assert.ok(compactRoot.some(row => /Tidy UI appearance\s+On$/u.test(row)));
      assert.ok(compactRoot.some(row => /Set terminal colors from Pi theme\s+Off$/u.test(row)));
      assert.ok((await replay.tidyPage(['Status & troubleshooting'])).some(row => /Use Occipital highlighting\s+Off$/u.test(row)));
      assert.ok((await replay.tidyPage(['Status & troubleshooting', 'Diagnostic logs'])).some(row => row === 'Recording: On'));
      const terminal = replay;
      try {
        await terminal.resize(100, 5); await terminal.openTidyMenu();
        assert.equal(terminal.tidyFrame(), undefined, 'short layouts really have no frame/header');
        const root = terminal.menuBounds;
        assert.ok(root && root.width < 72); assert.equal(root.col, Math.floor((100 - root.width) / 2));
        await terminal.selectTidyItem('Code color theme'); await terminal.selectTidyItem('Follow Pi theme');
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).syntaxTheme, { kind: 'pi' });
        assert.equal(terminal.menuBounds.width, root.width, 'theme confirmation returns to the compact root');
        await terminal.selectTidyItem('Set terminal colors from Pi theme');
        await terminal.selectTidyItem('Status & troubleshooting');
        assert.notEqual(terminal.menuBounds.width, root.width, 'compact page transitions resize the same native overlay');
        await terminal.selectTidyItem('Use Occipital highlighting');
        terminal.send('\x1b[27u');
        await until(async () => { await terminal.refreshTidyBounds(); return terminal.tidyRows().some(row => row.startsWith('→ Status & troubleshooting')); }, 'compact Escape returns without losing selection');
        await terminal.selectTidyItem('Set terminal colors from Pi theme', false);
        if (mode === 'fullscreen') {
          const y = terminal.tidyRows().findIndex(row => row.startsWith('→ Set terminal colors from Pi theme')), bounds = terminal.menuBounds;
          terminal.send(`\x1b[<0;${bounds.col + 5};${y + 1}M\x1b[<0;${bounds.col + 5};${y + 1}m`);
          await until(() => JSON.parse(readFileSync(file, 'utf8')).terminalColorsEnabled === false, 'compact pointer hits the actual centered setting');
        } else await terminal.selectTidyItem('Set terminal colors from Pi theme');
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).terminalColorsEnabled, false);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).nativeHighlightingEnabled, true);
        assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
        await terminal.closeTidyMenu();
        assert.deepEqual(dataEvents(replay), compactEvents, 'compact navigation adds no traffic to the fresh replay');
        assert.deepEqual(readFileSync(original.session), sessionBytes, 'compact navigation leaves the saved session bytes unchanged');
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...saved, nativeHighlightingEnabled: true }, 'compact navigation preserves unrelated settings and untouched switches');
      } finally { terminal.captureScreen('compact-final', {}); }
    } finally { await closeTerminals(terminals.reverse()); }
  });

for (const mode of ['regular', 'fullscreen']) test(`settings sync: two real Pi processes share confirmed preferences but keep local flags (${mode})`, { timeout: 90000 }, async () => {
  const terminals = [];
  const live = new PiTerminal(`settings-sync-writer-${mode}`, { tidyUi: true, mode,
    tidyUiSettings: { syntaxTheme: { kind: 'occipital', id: 'saved-A' }, terminalColorsEnabled: true, nativeHighlightingEnabled: false, future: true } });
  terminals.push(live);
  try {
    await live.ready(); await live.run('user-card');
    const initial = await live.capture('settings-sync-initial'), bytes = readFileSync(initial.session), data = traffic(live, 2);
    const file = join(live.agent, 'extensions/pi-tidy-ui/config.json'), original = readFileSync(file);
    const peer = new PiTerminal(`settings-sync-reader-${mode}`, { tidyUi: true, mode,
      profileFactory({ agentDir }) {
        mkdirSync(join(agentDir, 'extensions'), { recursive: true });
        symlinkSync(join(live.agent, 'extensions/pi-tidy-ui'), join(agentDir, 'extensions/pi-tidy-ui'), 'dir');
      } });
    terminals.push(peer); await peer.ready(); await peer.openTidyMenu();
    assert.ok(peer.tidyRows().some(row => /Tidy UI appearance\s+On$/u.test(row)));
    assert.ok(peer.tidyRows().some(row => /Code color theme.*saved-A/u.test(row)));
    await live.appearance(false); await live.diagnosticLogging(false);
    assert.deepEqual(readFileSync(file), original, 'local choices never publish into the shared file');
    const starts = live.events().filter(event => event.type === 'start').length;
    await live.command('/reload'); await live.event('start', starts + 1);
    assert.ok((await live.tidyPage()).some(row => /Tidy UI appearance\s+Off$/u.test(row)));
    assert.ok((await live.tidyPage(['Status & troubleshooting', 'Diagnostic logs'])).some(row => row === 'Recording: Off'));
    assert.ok(peer.tidyRows().some(row => /Tidy UI appearance\s+On$/u.test(row)));
    await live.terminalColors(false);
    await until(() => peer.tidyRows().some(row => /Set terminal colors from Pi theme\s+Off$/u.test(row)), 'peer applies saved terminal preference with no keyboard input');
    await live.tidyPage(['Code color theme', 'Follow Pi theme']);
    await until(() => peer.tidyRows().some(row => /Code color theme.*Follow Pi/u.test(row)), 'peer applies confirmed theme with no keyboard input');
    await live.openTidyMenu(); await live.selectTidyItem('Status & troubleshooting');
    assert.ok(live.tidyRows().some(row => /Use Occipital highlighting\s+Off$/u.test(row)));
    await peer.selectTidyItem('Status & troubleshooting'); await peer.selectTidyItem('Use Occipital highlighting'); await peer.closeTidyMenu();
    await until(() => JSON.parse(readFileSync(file, 'utf8')).nativeHighlightingEnabled === true, 'peer native preference is published');
    await until(async () => {
      await live.refreshTidyBounds(); return live.tidyRows().some(row => /Use Occipital highlighting\s+On$/u.test(row));
    }, 'local appearance Off does not stop shared preference monitoring');
    await live.closeTidyMenu();
    assert.ok((await live.tidyPage()).some(row => /Tidy UI appearance\s+Off$/u.test(row)));
    assert.ok((await peer.tidyPage(['Status & troubleshooting', 'Diagnostic logs'])).some(row => row === 'Recording: On'));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: true, terminalColorsEnabled: false, future: true });
    assert.deepEqual(traffic(live, 2), data); assert.deepEqual(readFileSync(initial.session), bytes);
    assert.equal(peer.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
  } finally { await closeTerminals(terminals.reverse()); }
});
