import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { PiTerminal } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../fixtures/terminal-cleanup.mjs';
import { nativeReady } from '../../fixtures/syntax-observation.mjs';
import { sharedSyntaxHost, themeDefinition, reaped } from '../../fixtures/shared-syntax-host.mjs';
import { prepareSyntaxNative, requiredSharedHost, scenario, stats, traffic, persisted, menuAction, chooseTheme, settledStats, keywordColor, sourceColors, work, peerSource, finish, until, body } from '../../fixtures/syntax-cli-support.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();

test('occipital CLI: shared discovery, public refresh/status/Pi menu, actual loss and owned-to-shared return preserve peer and traffic',
  { timeout: 120000 }, async () => {
    const host = await sharedSyntaxHost(requiredSharedHost(), binary);
    const terminal = new PiTerminal('syntax-shared-transitions', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } });
    let returnedPeer;
    try {
      const initial = await scenario(terminal, true), original = await stats(terminal, 'shared-initial');
      assert.equal(original.client.provider.kind, 'shared'); assert.equal(original.counts.acquisitions, 0);
      const oldPid = original.client.provider.description.runtime.pid;
      assert.equal(oldPid, host.initialPeer.snapshot().provider.description.runtime.pid);
      const initialTraffic = traffic(terminal), initialData = persisted(initial), initialBranch = initial.branch;
      await menuAction(terminal, 'status');
      assert.ok(terminal.screen().some(row => row.includes('Provider: shared')), 'public status reports the actual provider');
      await terminal.closeTidyMenu();
      const custom = original.client.provider.description.profiles.find(profile => profile.label === 'cli-shared'); assert.ok(custom);
      const index = original.client.provider.description.profiles.filter(profile => profile.id !== 'pi').findIndex(profile => profile.id === custom.id) + 1;
      await terminal.resize(42, 12);
      await chooseTheme(terminal, index);
      await terminal.resize(100, 80);
      await settledStats(terminal, 'shared-custom-ready', s => nativeReady(s) && s.client.effective.id === custom.id);
      await keywordColor(terminal, 0x223344, 'shared-custom');
      const selected = JSON.parse(readFileSync(`${terminal.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'));
      assert.deepEqual(selected, { syntaxTheme: { kind: 'occipital', id: custom.id } });
      rmSync(host.themeFile);
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      const missing = await settledStats(terminal, 'shared-missing', s => nativeReady(s) && s.client.effective.id === 'pi');
      assert.equal(missing.client.selected.id, custom.id); assert.equal(missing.counts.refreshReplies, 1);
      const errors = terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error');
      assert.equal(errors.length, 1, 'one bounded UI issue for the unavailable selected theme');
      assert.deepEqual(JSON.parse(readFileSync(`${terminal.agent}/extensions/pi-tidy-ui/config.json`, 'utf8')), selected);
      sourceColors(await terminal.capture('shared-missing-pi'));
      const absentWarm = await stats(terminal, 'missing-before'); await terminal.capture('missing-warm');
      assert.deepEqual(work(await stats(terminal, 'missing-after')), work(absentWarm));
      assert.equal(terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error').length, 1);
      writeFileSync(host.themeFile, themeDefinition('#667788'));
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      await settledStats(terminal, 'shared-restored', s => nativeReady(s) && s.client.effective.id === custom.id);
      await keywordColor(terminal, 0x667788, 'shared-restored');
      rmSync(host.alias); process.kill(oldPid, 'SIGKILL');
      const owned = await settledStats(terminal, 'owned-after-loss', s => nativeReady(s) && s.client.provider.kind === 'owned');
      assert.equal(owned.broker.reconnectAttempts, 2); assert.equal(owned.counts.acquisitions, 1);
      assert.equal(owned.client.provider.initialShared, true); assert.equal(owned.broker.recoveryTimers, 1);
      assert.equal(owned.client.selected.id, custom.id); assert.equal(owned.client.effective.id, 'pi');
      const missingNotices = () => terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error'
        && event.message === `Syntax theme ${JSON.stringify(custom.id)} is unavailable; using Pi palette temporarily.`);
      assert.equal(missingNotices().length, 2, 'restoration resets suppression for the next unavailable episode');
      await reaped(oldPid); await host.initialPeer.dispose();
      returnedPeer = await host.peer(); await peerSource(returnedPeer);
      const newPid = returnedPeer.snapshot().provider.description.runtime.pid, peerBefore = returnedPeer.sources.stats();
      assert.notEqual(newPid, oldPid); assert.notEqual(newPid, owned.transports[0].pid);
      writeFileSync(host.alias, readFileSync(host.connection), { mode: 0o600 });
      await terminal.command('/tidy-ui-syntax-clock 60000');
      const returned = await settledStats(terminal, 'shared-returned', s => nativeReady(s) && s.client.provider.kind === 'shared');
      assert.equal(returned.client.provider.description.runtime.pid, newPid);
      assert.equal(returned.broker.probesStarted, 1); assert.equal(returned.broker.handoffsSucceeded, 1);
      assert.equal(returned.broker.recoveryTimers, 0); assert.equal(returned.counts.acquisitions, 1);
      await reaped(owned.transports[0].pid); await keywordColor(terminal, 0x667788, 'shared-returned');
      await chooseTheme(terminal, 0);
      const pi = await settledStats(terminal, 'shared-pi-selected', s => nativeReady(s) && s.client.effective.id === 'pi');
      assert.equal(pi.client.selected.kind, 'pi'); sourceColors(await terminal.capture('shared-pi-selected'));
      const before = await stats(terminal, 'shared-warm-before');
      for (const width of [40, 100]) { await terminal.resize(width); await terminal.capture(`shared-width-${width}`); }
      const after = await stats(terminal, 'shared-warm-after'); assert.deepEqual(work(after), work(before));
      assert.equal((await returnedPeer.refreshThemes()).ok, true, 'live peer receives an actual control reply after handoff');
      await peerSource(returnedPeer); assert.equal(returnedPeer.sources.stats().dispatches, peerBefore.dispatches);
      assert.equal(missingNotices().length, 2, 'return and warm frames do not repeat an unavailable-theme issue');
      const final = await terminal.capture('shared-final');
      assert.deepEqual(traffic(terminal), initialTraffic); assert.deepEqual(persisted(final), initialData);
      assert.deepEqual(final.branch, initialBranch, 'UI status/errors never become model or session records');
      await finish(terminal); process.kill(newPid, 0);
      assert.equal((await returnedPeer.refreshThemes()).ok, true, 'live peer receives an actual control reply after Pi shutdown');
      await peerSource(returnedPeer); assert.equal(returnedPeer.sources.stats().dispatches, peerBefore.dispatches);
      console.log(JSON.stringify({ sharedCli: terminal.output, node: after.node, calls: 3, results: 3, contexts: 4,
        ownedStarts: 1, reconnectAttempts: returned.broker.reconnectAttempts, returnProbes: 1, handoffs: 1, peerWarmDelta: 0 }));
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
  });

test('occipital CLI: structured RGB and font attributes preserve both file diff sides, frames and warm work',
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
          found.push({ value: match[0], keyword: dump.cells[y].slice(x, x + 5), variable: dump.cells[y][x + 6],
            number: dump.cells[y][x + 8], prefix: dump.cells[y].slice(start, x), suffix: dump.cells[y].slice(x + 10, end) });
        }
      }
      assert.equal(found.length, 3, 'write source plus both old/new edit sides are physically visible');
      assert.equal(found.filter(row => row.value === 'const x=1;').length, 2);
      assert.equal(found.filter(row => row.value === 'const x=2;').length, 1);
      return found;
    };
    try {
      const baseline = await scenario(terminal, true), baselineCells = vectors(baseline);
      await terminal.resize(140); const wideBaseline = await terminal.capture('styles-wide-baseline');
      const wideBaselineCells = vectors(wideBaseline); await terminal.resize(100);
      const initial = await stats(terminal, 'styles-initial');
      assert.equal(initial.node, process.version, 'actual Pi child uses the same asserted parent runtime');
      assert.equal(initial.client.provider.kind, 'shared'); assert.equal(initial.counts.acquisitions, 0);
      const originalTraffic = traffic(terminal), originalData = persisted(baseline), originalBranch = baseline.branch;
      writeFileSync(host.themeFile, `<plist><dict><key>settings</key><array>
        <dict><key>settings</key><dict><key>foreground</key><string>#112233</string></dict></dict>
        <dict><key>scope</key><string>storage, keyword</string><key>settings</key><dict>
          <key>foreground</key><string>#a1b2c3</string><key>fontStyle</key><string>bold italic underline</string></dict></dict>
        <dict><key>scope</key><string>constant.numeric</string><key>settings</key><dict>
          <key>foreground</key><string>#22aa44</string><key>fontStyle</key><string>italic</string></dict></dict>
        </array></dict></plist>`);
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      const refreshed = await stats(terminal, 'styles-refreshed');
      assert.equal(refreshed.counts.refreshReplies, 1);
      const custom = refreshed.client.provider.description.profiles.find(profile => profile.label === 'cli-shared'); assert.ok(custom);
      const index = refreshed.client.provider.description.profiles.filter(profile => profile.id !== 'pi').findIndex(profile => profile.id === custom.id) + 1;
      await chooseTheme(terminal, index);
      await settledStats(terminal, 'styles-selected', s => nativeReady(s) && s.client.effective.id === custom.id);
      let painted, observation = 0;
      await until(async () => {
        painted = await terminal.capture(`styles-colored-${observation++}`);
        return vectors(painted).every(row => row.keyword.every(cell => cell.fg === 0xa1b2c3));
      }, 'all three actual source foregrounds');
      const styledCells = vectors(painted);
      assert.deepEqual(body(painted), body(baseline), 'theme changes source styles, never tool glyphs or geometry');
      const assertVectors = dump => {
        for (const row of vectors(dump)) {
          for (const cell of row.keyword) assert.deepEqual({ fg: cell.fg, rgb: cell.fgMode, bold: !!cell.bold, italic: !!cell.italic, underline: !!cell.underline },
            { fg: 0xa1b2c3, rgb: 50331648, bold: true, italic: true, underline: true });
          assert.deepEqual({ fg: row.number.fg, rgb: row.number.fgMode, bold: !!row.number.bold, italic: !!row.number.italic, underline: !!row.number.underline },
            { fg: 0x22aa44, rgb: 50331648, bold: false, italic: true, underline: false });
          assert.deepEqual({ fg: row.variable.fg, rgb: row.variable.fgMode, bold: !!row.variable.bold, italic: !!row.variable.italic, underline: !!row.variable.underline },
            { fg: 0x112233, rgb: 50331648, bold: false, italic: false, underline: false }, 'keyword attributes cannot leak into the next plain token');
        }
      };
      assertVectors(painted);
      const assertFrame = (current, previousRows) => {
        for (const [index, row] of current.entries()) {
          const previous = previousRows[index];
          assert.deepEqual(row.prefix, previous.prefix, 'line-number/diff/frame prefix keeps every original cell style');
          assert.deepEqual(row.suffix, previous.suffix, 'source attributes cannot leak into row suffix/frame');
          for (const [cell, old] of [...row.keyword.map((cell, i) => [cell, previous.keyword[i]]), [row.variable, previous.variable], [row.number, previous.number]])
            assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: old.bg, bgMode: old.bgMode }, 'syntax theme never replaces semantic diff background');
        }
      };
      assertFrame(styledCells, baselineCells);
      const before = await settledStats(terminal, 'styles-warm-before', s => nativeReady(s) && s.source.globalUnsettledJobs === 0);
      for (const width of [24, 60, 100, 140]) {
        await terminal.resize(width); const dump = await terminal.capture(`styles-width-${width}`); assertVectors(dump);
        if (width === 140) { assertFrame(vectors(dump), wideBaselineCells); assert.deepEqual(body(dump), body(wideBaseline)); }
      }
      for (const theme of ['light', 'dark']) {
        const previousEvents = terminal.events().filter(event => event.type === 'theme').length;
        await terminal.command(`/tidy-ui-theme ${theme}`); await terminal.event('theme', previousEvents + 1);
        const transition = terminal.events().filter(event => event.type === 'theme')[previousEvents];
        assert.equal(transition.name, theme); assert.equal(transition.result.success, true, 'fresh requested Pi theme transition succeeds');
        const dump = await terminal.capture(`styles-${theme}`);
        assertVectors(dump); assert.deepEqual(body(dump), body(wideBaseline), 'Pi theme changes no source glyphs/geometry');
        const themed = await stats(terminal, `styles-${theme}-stats`);
        assert.equal(themed.client.effective.id, custom.id);
        assert.deepEqual(work(themed), work(before), 'fixed native theme remains classified across Pi palette changes');
      }
      const final = await terminal.capture('styles-warm'); const after = await stats(terminal, 'styles-warm-after');
      assert.equal(after.node, process.version);
      assert.deepEqual(work(after), work(before), 'width changes and warm frames do no new source work');
      assert.equal(before.counts.piBridges, 0); assert.equal(after.counts.piBridges, 0);
      assert.equal(after.counts.acquisitions, 0); assert.equal(after.client.provider.description.runtime.pid, initial.client.provider.description.runtime.pid);
      assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(persisted(final), originalData);
      assert.deepEqual(final.branch, originalBranch);
      await finish(terminal); assert.deepEqual(await host.initialPeer.refreshThemes(), { ok: true });
      console.log(JSON.stringify({ physicalStyles: terminal.output, node: after.node, visibleSources: 3,
        structuredRgb: true, bold: true, italic: true, underline: true, semanticBackgrounds: true, widths: [24, 60, 100, 140], piThemes: ['dark', 'light'], warmWorkDelta: 0 }));
      const sharedPid = host.initialPeer.snapshot().provider.description.runtime.pid;
      const disposalFailure = new Error('test-only peer disposal failure');
      const originalDispose = host.initialPeer.dispose;
      host.initialPeer.dispose = async () => { await originalDispose.call(host.initialPeer); throw disposalFailure; };
      try {
        await assert.rejects(host.close(), error => error === disposalFailure);
        assert.equal(existsSync(host.root), false, 'failed peer disposal must not retain the shared host or its workspace');
        await reaped(sharedPid);
      } finally { host.initialPeer.dispose = originalDispose; }
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
  });
