import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { PiTerminal } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../fixtures/terminal-cleanup.mjs';
import { semanticSourceContext, semanticStyle, semanticPhaseReady } from '../../fixtures/syntax-observation.mjs';
import { sampleOwnedPalette } from '../../../src/themes/owned-palette.ts';
import { sharedSyntaxHost, reaped } from '../../fixtures/shared-syntax-host.mjs';
import { prepareSyntaxNative, requiredSharedHost, scenario, traffic, persisted, menuAction, chooseTheme, settledStats, captureThenRenderDiagnostics, work, peerSource, finish, body, shebangScenario, shebangContextColors, shebangStringColors, expressionForeground, expressionAttributes, expectedThemeColors, themeForegrounds, themeMarkers } from '../../fixtures/syntax-cli-support.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();

test('occipital CLI: shared shebang source hints retain side-specific split paint and new-side unified paint',
  { timeout: 90000 }, async () => {
    const host = await sharedSyntaxHost(requiredSharedHost(), binary);
    const terminal = new PiTerminal('syntax-shared-shebang-sides', { mode: 'fullscreen', dimensions: { columns: 140, rows: 120 }, extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1',
        TIDY_UI_TEST_EMPTY_BASH: '1', TIDY_UI_TEST_PALETTE_OBSERVE: '1' } });
    try {
      const split = await shebangScenario(terminal), splitColors = shebangContextColors(split);
      assert.equal(splitColors.length, 3);
      assert.equal(splitColors[0], splitColors[1]);
      assert.notEqual(splitColors[1], splitColors[2]);
      const events = terminal.events();
      const bashSource = events.filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
        .flatMap(event => event.payload.sources ?? []).find(source => source.text.includes('BASH_NO_SHEBANG_HINT'));
      assert.ok(bashSource);
      assert.equal(bashSource.hint.language, 'bash');
      assert.equal(Object.hasOwn(bashSource.hint, 'shebang_language'), false, 'the generic language selector has no shebang-specific companion');
      const pythonContext = semanticSourceContext(events, 'same', 'python'), bashContext = semanticSourceContext(events, 'same', 'bash');
      assert.ok(pythonContext); assert.ok(bashContext); assert.notDeepEqual(pythonContext, bashContext);
       assert.ok(Array.isArray(pythonContext) && pythonContext.length > 0, 'Python string scopes have a nonempty protocol context path');
       assert.ok(Array.isArray(bashContext) && bashContext.length > 0, 'Bash string scopes have a nonempty protocol context path');
      const stringPaint = shebangStringColors(split);
      assert.equal(stringPaint.colors.length, 3);
      const pythonStyle = semanticStyle(events, 'same', 'pi', 'python'), bashStyle = semanticStyle(events, 'same', 'pi', 'bash');
      assert.ok(pythonStyle); assert.ok(bashStyle);
      assert.equal(stringPaint.colors[0], expressionForeground(pythonStyle.expression, split, 'pi'));
      assert.equal(stringPaint.colors[1], expressionForeground(pythonStyle.expression, split, 'pi'));
      assert.equal(stringPaint.colors[2], expressionForeground(bashStyle.expression, split, 'pi'));
      assert.equal(expressionForeground(pythonStyle.expression, split, 'pi'), stringPaint.expected);
      assert.equal(expressionForeground(bashStyle.expression, split, 'pi'), stringPaint.expected);
      const unknownReply = events.find(event => event.type === 'syntax_native_reply' && event.kind === 'source'
        && event.reply.status === 'error' && event.reply.error?.code === 'unknown_syntax' && event.reply.error?.execution === 'not_started'
        && event.payload.sources?.some(source => source.text.includes('NO_SHEBANG_CONTROL')));
      assert.ok(unknownReply, 'shared no-shebang control reaches expected pre-parse fallback');
      assert.ok(split.screen.some(row => row.includes('NO_SHEBANG_CONTROL')));
      assert.equal(events.filter(event => event.type === 'syntax_notify' && event.message.includes('unexpected error (unknown_syntax)')).length, 0);
      const before = split.sample;
       assert.ok(before.localWork.shebangFileSegments > 0, 'cold measurement includes the unique shared shebang-file marker');
      assert.equal(before.client.provider.kind, 'shared');
      await terminal.resize(100, 120);
      const unified = await captureThenRenderDiagnostics(terminal, 'shared-shebang-unified'), unifiedColors = shebangContextColors(unified);
      assert.equal(unifiedColors.length, 2);
      assert.equal(unifiedColors[0], splitColors[0]); assert.equal(unifiedColors[1], splitColors[2]);
      const after = await settledStats(terminal, 'shared-shebang-after-resize');
      assert.deepEqual(work(after), work(before));
       assert.equal(after.localWork.shebangFileSegments, before.localWork.shebangFileSegments, 'shared resize repeats no shebang-file measurement');
       assert.deepEqual(after.localWork, before.localWork, 'shared resize repeats no other file measurement or source-scalar reads');
      console.log(JSON.stringify({ sharedShebangSplit: splitColors, sharedShebangUnified: unifiedColors, warmResizeDelta: 0 }));
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
  });
test('occipital CLI: shared discovery, local palette selection, provider loss and shared return preserve peer and traffic',
  { timeout: 120000 }, async () => {
    const host = await sharedSyntaxHost(requiredSharedHost(), binary);
    const terminal = new PiTerminal('syntax-shared-transitions', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } });
    let returnedPeer;
    try {
      const initial = await scenario(terminal, true), original = initial.sample;
      assert.equal(original.client.provider.kind, 'shared'); assert.equal(original.counts.acquisitions, 0);
      const oldPid = original.client.provider.description.runtime.pid;
      assert.equal(oldPid, host.initialPeer.snapshot().provider.description.runtime.pid);
      const initialTraffic = traffic(terminal), initialData = persisted(initial), initialBranch = initial.branch;
      await menuAction(terminal, 'status');
      assert.ok(terminal.screen().some(row => row.includes('Provider: shared')), 'public status reports the actual provider');
      await terminal.closeTidyMenu();

      const paletteId = 'catppuccin-dark';
      await terminal.resize(42, 12); await chooseTheme(terminal, paletteId); await terminal.resize(100, 80);
      const ready = await settledStats(terminal, 'shared-owned-palette-ready', s => s.client.effective.id === paletteId);
      assert.ok(await semanticPhaseReady(() => ready, () => terminal.events(), themeMarkers, paletteId));
      const selected = JSON.parse(readFileSync(`${terminal.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'));
      assert.deepEqual(selected, { syntaxTheme: { kind: 'theme', id: paletteId } });
      const selectedPaint = await captureThenRenderDiagnostics(terminal, 'shared-owned-palette');
      assert.deepEqual(themeForegrounds(selectedPaint), expectedThemeColors(terminal, 'shared-owned-palette', selectedPaint, paletteId));

      rmSync(host.alias); process.kill(oldPid, 'SIGKILL'); await terminal.event('syntax_acquired');
      const owned = await settledStats(terminal, 'owned-after-loss', s => s.client.provider.kind === 'owned' && s.client.effective.id === paletteId);
      assert.equal(owned.broker.reconnectAttempts, 2); assert.equal(owned.counts.acquisitions, 1);
      assert.equal(owned.client.provider.initialShared, true); assert.equal(owned.broker.recoveryTimers, 1);
      assert.equal(owned.client.selected.id, paletteId);
      const offlinePaint = await captureThenRenderDiagnostics(terminal, 'owned-palette-after-loss');
      assert.deepEqual(themeForegrounds(offlinePaint), expectedThemeColors(terminal, 'owned-palette-after-loss', offlinePaint, paletteId),
        'the locally owned palette remains available while its SOURCE/STYLE provider is unavailable');
      await reaped(oldPid); await host.initialPeer.dispose();

      returnedPeer = await host.peer(); await peerSource(returnedPeer);
      const newPid = returnedPeer.snapshot().provider.description.runtime.pid, peerBefore = returnedPeer.sources.stats();
      assert.notEqual(newPid, oldPid); assert.notEqual(newPid, owned.transports[0].pid);
      writeFileSync(host.alias, readFileSync(host.connection), { mode: 0o600 });
      await terminal.command('/tidy-ui-syntax-clock 60000');
      const returned = await settledStats(terminal, 'shared-returned', s => s.client.provider.kind === 'shared' && s.client.effective.id === paletteId);
      assert.equal(returned.client.provider.description.runtime.pid, newPid);
      assert.equal(returned.broker.probesStarted, 1); assert.equal(returned.broker.handoffsSucceeded, 1);
      assert.equal(returned.broker.recoveryTimers, 0); assert.equal(returned.counts.acquisitions, 1);
      await reaped(owned.transports[0].pid);
      const returnedPaint = await captureThenRenderDiagnostics(terminal, 'shared-owned-palette-returned');
      assert.deepEqual(themeForegrounds(returnedPaint), expectedThemeColors(terminal, 'shared-owned-palette-returned', returnedPaint, paletteId));

      await chooseTheme(terminal, 'pi');
      const pi = await settledStats(terminal, 'shared-pi-selected', s => s.client.effective.id === 'pi');
      assert.equal(pi.client.selected.kind, 'pi'); sourceColors(await captureThenRenderDiagnostics(terminal, 'shared-pi-selected'));
      const before = await settledStats(terminal, 'shared-warm-before');
      for (const width of [40, 100]) { await terminal.resize(width); await terminal.capture(`shared-width-${width}`); }
      const after = await settledStats(terminal, 'shared-warm-after'); assert.deepEqual(work(after), work(before));
      assert.equal(returnedPeer.sources.stats().dispatches, peerBefore.dispatches, 'extension theme changes do not create unrelated peer work');
      const final = await captureThenRenderDiagnostics(terminal, 'shared-final');
      assert.deepEqual(traffic(terminal), initialTraffic); assert.deepEqual(persisted(final), initialData);
      assert.deepEqual(final.branch, initialBranch, 'UI status and local palette changes never become model/session records');
      await finish(terminal); await peerSource(returnedPeer); process.kill(newPid, 0);
      console.log(JSON.stringify({ sharedCli: terminal.output, node: after.node, calls: 3, results: 3,
        providerLossRecovery: true, returnedSharedPid: newPid, warmWorkDelta: 0 }));
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
  });

test('occipital CLI: owned palette renders both diff sides, mapped semantic ink and warm frames',
  { timeout: 120000 }, async () => {
    const host = await sharedSyntaxHost(requiredSharedHost(), binary);
    const terminal = new PiTerminal('syntax-physical-styles', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } });
    const vectors = dump => {
      const found = [];
      for (const [y, row] of dump.screen.entries()) {
        const matches = [...row.matchAll(/const x=[12];/g)];
        for (const [index, match] of matches.entries()) {
          const x = match.index, start = index === 0 ? 0 : matches[index - 1].index + 10;
          const end = index + 1 === matches.length ? dump.cells[y].length : matches[index + 1].index;
          found.push({ y, x, start, end, value: match[0], keyword: dump.cells[y].slice(x, x + 5), variable: dump.cells[y][x + 6],
            operator: dump.cells[y][x + 7], number: dump.cells[y][x + 8], prefix: dump.cells[y].slice(start, x), suffix: dump.cells[y].slice(x + 10, end) });
        }
      }
      assert.equal(found.length, 3, 'write source plus both old/new edit sides are physically visible');
      assert.equal(found.filter(row => row.value === 'const x=1;').length, 2);
      assert.equal(found.filter(row => row.value === 'const x=2;').length, 1);
      return found;
    };
    const rgb = ink => { assert.equal(ink.kind, 'rgb'); return ink.r * 65536 + ink.g * 256 + ink.b; };
    const cellStyle = cell => ({ fg: cell.fg, fgMode: cell.fgMode, bg: cell.bg, bgMode: cell.bgMode,
      bold: !!cell.bold, italic: !!cell.italic, underline: !!cell.underline, dim: !!cell.dim, inverse: !!cell.inverse });
    const ratio = (a, b) => {
      const luminance = value => {
        const channel = shift => { const component = ((value >> shift) & 255) / 255; return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
      };
      const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    try {
      const baseline = await scenario(terminal, true); vectors(baseline);
      const initial = await settledStats(terminal, 'styles-initial');
      assert.equal(initial.client.provider.kind, 'shared'); assert.equal(initial.counts.acquisitions, 0);
      const originalTraffic = traffic(terminal), originalData = persisted(baseline), originalBranch = baseline.branch;
      const baselines = new Map([[100, baseline]]);
      for (const width of [24, 60, 140]) {
        await terminal.resize(width); const dump = await terminal.capture(`styles-baseline-${width}`);
        vectors(dump); baselines.set(width, dump);
      }
      const wideBaseline = baselines.get(140); await terminal.resize(100);

      const paletteId = 'catppuccin-dark', owned = sampleOwnedPalette(paletteId, 'truecolor'), palette = owned.roles;
      await chooseTheme(terminal, paletteId);
      const selected = await settledStats(terminal, 'styles-selected', s => s.client.effective.id === paletteId);
      assert.ok(await semanticPhaseReady(() => selected, () => terminal.events(), themeMarkers, paletteId), 'all generic semantic styles use the selected owned palette');
      const painted = await captureThenRenderDiagnostics(terminal, 'styles-colored');
      assert.deepEqual(body(painted), body(baseline), 'local palette changes source styles only, never tool glyphs or geometry');
      assert.notDeepEqual(palette.addedCode.background, palette.removedCode.background, 'authored semantic inputs retain distinct add/delete surfaces');
      for (const role of ['addedGutter', 'removedGutter']) assert.notDeepEqual(palette[role].background, palette.numbers.background);
      for (const role of ['code', 'addedCode', 'removedCode', 'output'])
        assert.ok(ratio(rgb(palette[role].foreground), rgb(palette[role].background)) >= 4.5, `${role} source colors meet text contrast`);

      const events = terminal.events();
      const expression = marker => {
        const result = semanticStyle(events, marker, paletteId, 'typescript'); assert.ok(result, `actual generic STYLE for ${marker}`);
        return result.expression;
      };
      const token = marker => {
        const value = expression(marker), attrs = expressionAttributes(value, painted, paletteId);
        return { fg: expressionForeground(value, painted, paletteId), bold: !!(attrs & 1), italic: !!(attrs & 2),
          underline: !!(attrs & 4), dim: !!(attrs & 8), inverse: !!(attrs & 16) };
      };
      const keyword = token('const x=1;'), operator = token('='), variable = token('x=1'), number = token('1;');
      const assertVectors = dump => {
        for (const row of vectors(dump)) {
          for (const cell of row.keyword) assert.deepEqual({ fg: cell.fg, rgb: cell.fgMode, bold: !!cell.bold, italic: !!cell.italic, underline: !!cell.underline },
            { fg: keyword.fg, rgb: 50331648, bold: keyword.bold, italic: keyword.italic, underline: keyword.underline });
          assert.deepEqual({ fg: row.operator.fg, rgb: row.operator.fgMode, bold: !!row.operator.bold, italic: !!row.operator.italic, underline: !!row.operator.underline },
            { fg: operator.fg, rgb: 50331648, bold: operator.bold, italic: operator.italic, underline: operator.underline });
          assert.deepEqual({ fg: row.variable.fg, rgb: row.variable.fgMode, bold: !!row.variable.bold, italic: !!row.variable.italic, underline: !!row.variable.underline },
            { fg: variable.fg, rgb: 50331648, bold: variable.bold, italic: variable.italic, underline: variable.underline }, 'keyword attributes cannot leak into the next variable');
          assert.deepEqual({ fg: row.number.fg, rgb: row.number.fgMode, bold: !!row.number.bold, italic: !!row.number.italic, underline: !!row.number.underline },
            { fg: number.fg, rgb: 50331648, bold: number.bold, italic: number.italic, underline: number.underline });
          for (const cell of [...row.keyword, row.variable, row.operator, row.number])
            assert.ok(ratio(cell.fg, cell.bg) >= 4.5, 'final terminal ink has accessible contrast against the rendered code surface');
        }
      };
      assertVectors(painted);

      const expectedStyle = role => ({ fg: rgb(palette[role].foreground), fgMode: 50331648,
        bg: rgb(palette[role].background), bgMode: 50331648, bold: !!(palette[role].attributes & 1),
        italic: !!(palette[role].attributes & 2), underline: !!(palette[role].attributes & 4),
        dim: !!(palette[role].attributes & 8), inverse: false });
      const exterior = { fg: -1, fgMode: 0, bg: -1, bgMode: 0, bold: false, italic: false, underline: false, dim: false, inverse: false };
      const assertFrame = dump => {
        const rows = vectors(dump), previousRows = vectors(baselines.get(dump.width));
        for (const [index, row] of rows.entries()) {
          const previous = previousRows[index];
          for (const part of ['prefix', 'suffix', 'keyword']) assert.deepEqual(row[part].map(({ text, width }) => ({ text, width })),
            previous[part].map(({ text, width }) => ({ text, width })), `${part} glyphs and cell geometry stay exact`);
          const cells = dump.cells[row.y], expected = cells.map(() => expectedStyle('padding'));
          expected[0] = exterior; expected[cells.length - 1] = exterior;
          expected[1] = { ...expectedStyle('frame'), bg: -1, bgMode: 0 };
          for (const [n, segment] of rows.entries()) {
            if (segment.y !== row.y) continue;
            const plain = n === 0, role = plain ? 'code' : n === 1 ? 'removedCode' : 'addedCode';
            const gutter = plain ? 'numbers' : n === 1 ? 'removedGutter' : 'addedGutter';
            const sign = n === 1 ? 'removedSign' : 'addedSign', start = segment.x - (plain ? 3 : 5);
            const next = rows[n + 1], end = next?.y === row.y ? next.x - 5 : cells.length - 2;
            assert.equal(dump.screen[row.y].slice(start, segment.x), plain ? ' 1 ' : n === 1 ? ' 1 - ' : ' 1 + ');
            for (let x = start; x < segment.x; x++) expected[x] = expectedStyle(!plain && (x === start + 2 || x === start + 3) ? sign : gutter);
            for (let x = segment.x; x < end; x++) expected[x] = expectedStyle(role);
            for (const offset of [0, 1, 2, 3, 4]) expected[segment.x + offset] = { ...expected[segment.x + offset], ...keyword };
            expected[segment.x + 6] = { ...expected[segment.x + 6], ...variable };
            expected[segment.x + 7] = { ...expected[segment.x + 7], ...operator };
            expected[segment.x + 8] = { ...expected[segment.x + 8], ...number };
          }
          assert.deepEqual(row.prefix.map(cellStyle), expected.slice(row.start, row.x), 'owned frame, number/sign gutters and prefix isolation');
          assert.deepEqual(row.suffix.map(cellStyle), expected.slice(row.x + 10, row.end), 'semantic padding and suffix attribute/background isolation');
          assert.deepEqual(cells.map(cellStyle), expected, 'complete source row includes owned backgrounds and terminal-default exterior');
        }
        for (const label of ['← Wrote syntax.ts', '← Edited syntax.ts']) {
          const heading = dump.screen.findIndex(row => row.includes(label)); assert.ok(heading >= 0);
          let end = heading + 1; while (dump.screen[end]?.[1] === '┃') end++;
          for (let y = heading - 1; y < end; y++) {
            const cells = dump.cells[y]; assert.equal(cells[1].text, '┃');
            assert.deepEqual(cellStyle(cells[0]), exterior); assert.deepEqual(cellStyle(cells.at(-1)), exterior);
            assert.deepEqual(cellStyle(cells[1]), { ...expectedStyle('frame'), bg: -1, bgMode: 0 });
            if (rows.some(row => row.y === y)) continue;
            const emptySource = label === '← Wrote syntax.ts' && y === rows[0].y + 1;
            if (emptySource) assert.equal(dump.screen[y].slice(3, 6), ' 2 ', 'trailing source newline retains its numbered empty row');
            for (let x = 2; x < cells.length - 1; x++) {
              const role = emptySource && x >= 3 && x < 6 ? 'numbers' :
                y === heading && x >= 3 && x < cells.length - 2 ? 'muted' : 'padding';
              assert.deepEqual(cellStyle(cells[x]), expectedStyle(role), 'owned header, empty source/panel and outer padding reset');
            }
          }
        }
      };
      assertFrame(painted);
      const negativeControls = [
        ['wrong-card-foreground', d => { d.cells[vectors(d)[0].y][1].fg = 0xff00ff; }],
        ['lost-diff-background', d => { const row = vectors(d)[1]; row.keyword[0].bg = rgb(palette.panel.background); }],
        ['suffix-font-leak', d => { vectors(d)[0].suffix[0].italic = 1; }],
        ['painted-exterior', d => { d.cells[vectors(d)[0].y].at(-1).bg = 0xf8f8f8; }],
      ];
      for (const [name, corrupt] of negativeControls) {
        const invalid = structuredClone(painted); corrupt(invalid);
        assert.throws(() => assertFrame(invalid), { code: 'ERR_ASSERTION' }, name);
      }
      console.log(JSON.stringify({ ownedPalette: paletteId, palette, negativeControls: negativeControls.map(([name]) => name) }));
      const before = await settledStats(terminal, 'styles-warm-before', s => s.client.provider.availability === 'ready' && s.source.globalUnsettledJobs === 0);
      for (const width of [24, 60, 100, 140]) {
        await terminal.resize(width); const dump = await terminal.capture(`styles-width-${width}`); assertVectors(dump);
        assertFrame(dump); assert.deepEqual(body(dump), body(baselines.get(width)), 'widths keep exact pre-palette glyphs and geometry');
      }
      for (const theme of ['light', 'dark']) {
        const previousEvents = terminal.events().filter(event => event.type === 'theme').length;
        await terminal.command(`/tidy-ui-theme ${theme}`); await terminal.event('theme', previousEvents + 1);
        const transition = terminal.events().filter(event => event.type === 'theme')[previousEvents];
        assert.equal(transition.name, theme); assert.equal(transition.result.success, true, 'requested public Pi theme transition succeeds');
        const dump = await captureThenRenderDiagnostics(terminal, `styles-${theme}`);
        assertVectors(dump); assertFrame(dump); assert.deepEqual(body(dump), body(wideBaseline), 'Pi theme changes no source glyphs or geometry');
        assert.equal(dump.sample.client.effective.id, paletteId);
        assert.deepEqual(work(dump.sample), work(before), 'owned palette remains fixed and generic semantic work is reused across Pi color changes');
      }
      const final = await captureThenRenderDiagnostics(terminal, 'styles-warm'), after = final.sample;
      assert.equal(after.node, process.version); assert.deepEqual(work(after), work(before));
      assert.equal(before.counts.piBridges, 0); assert.equal(after.counts.piBridges, 0);
      assert.equal(after.counts.acquisitions, 0); assert.equal(after.client.provider.description.runtime.pid, initial.client.provider.description.runtime.pid);
      assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(persisted(final), originalData); assert.deepEqual(final.branch, originalBranch);
      await finish(terminal);
      const sharedPid = host.initialPeer.snapshot().provider.description.runtime.pid;
      const disposalFailure = new Error('test-only peer disposal failure'), originalDispose = host.initialPeer.dispose;
      host.initialPeer.dispose = async () => { await originalDispose.call(host.initialPeer); throw disposalFailure; };
      try {
        await assert.rejects(host.close(), error => error === disposalFailure);
        assert.equal(existsSync(host.root), false, 'failed peer disposal must not retain the shared host or workspace');
        await reaped(sharedPid);
      } finally { host.initialPeer.dispose = originalDispose; }
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
  });
