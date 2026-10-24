import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, byName, assertFits, until } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { persisted, traffic, allBashCards, compactContent, panelCells, bashScreenStyle, moveAt, panelAt, sgrAt } from '../../fixtures/main-cli-support.mjs';

test('real CLI: component-owned layout work counters and released retained memory',
  { timeout: 120000 }, async () => {
    const terminals = [], snapshots = [];
    const start = async (name, options = {}, resizeTall = true) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); if (resizeTall) await terminal.resize(100, 320); return terminal;
    };
     const observe = async (terminal, name, command = '/tidy-ui cache') => {
       const stats = await terminal.cacheSnapshot(command === '/tidy-ui cache clear');
       const dump = await terminal.capture(`pointer-cache-${name}`);
       assert.ok(stats, 'real popup displayed complete frozen diagnostic JSON');
      const numeric = ['retainedBytes', 'stringBytes', 'overheadBytes', 'rows', 'entries', 'hits', 'misses', 'builds', 'releases', 'collected'];
      const memory = ['retainedBytes', 'stringBytes', 'overheadBytes', 'rows', 'entries'];
      assert.deepEqual(Object.keys(stats).sort(), [...numeric, 'byKind', 'ordinary', 'cards', 'footerLayout',
        'presentationRetainedBytes', 'presentationEntries', 'presentationRows', 'memoryScope', 'processHeapUsedBytes', 'processMemoryScope'].sort());
      for (const key of [...numeric, 'presentationRetainedBytes', 'presentationEntries', 'presentationRows', 'processHeapUsedBytes'])
        assert.ok(Number.isSafeInteger(stats[key]) && stats[key] >= 0, `finite nonnegative diagnostic ${key}`);
      assert.equal(stats.processMemoryScope, 'whole Pi process, not pi-tidy-ui');
      assert.match(stats.memoryScope, /estimated pi-tidy-ui retained/);
      assert.ok(stats.processHeapUsedBytes > 0, 'process heap is sampled, not attributed to pi-tidy-ui');
      assert.equal(stats.retainedBytes, stats.stringBytes + stats.overheadBytes);
      assert.equal(stats.presentationRetainedBytes, stats.retainedBytes + stats.footerLayout.retainedBytes);
      assert.equal(stats.presentationEntries, stats.entries + stats.footerLayout.entries);
      assert.equal(stats.presentationRows, stats.rows + stats.footerLayout.rows);
      assert.deepEqual(Object.keys(stats.byKind).sort(), ['summary', 'bash', 'edit', 'write', 'user', 'queued'].sort());
      for (const key of memory) assert.equal(stats.byKind.queued[key], 0, 'no queued layouts exist in this completed-transcript control');
      for (const group of ['ordinary', 'cards']) {
        assert.deepEqual(Object.keys(stats[group]).sort(), [...numeric, 'byKind'].sort());
        for (const key of numeric) {
          assert.ok(Number.isSafeInteger(stats[group][key]) && stats[group][key] >= 0);
          assert.equal(stats[key], stats.ordinary[key] + stats.cards[key], `aggregate ${key} equals both accounting groups`);
        }
        for (const key of memory)
          assert.equal(stats[group][key], Object.values(stats[group].byKind).reduce((total, item) => total + item[key], 0));
      }
      snapshots.push({ terminal: terminal.output, name, ...stats });
      return { dump, stats };
    };
    const delta = (before, after, builds, label) => {
      assert.equal(after.builds - before.builds, builds, `${label}: exact custom-body builds`);
      assert.equal(after.misses - before.misses, builds, `${label}: each necessary build is one miss`);
      for (const key of ['hits', 'misses', 'builds', 'releases', 'collected'])
        assert.ok(after[key] >= before[key], `${label}: ${key} remains monotonic`);
      assert.ok(after.hits > before.hits, `${label}: unchanged components actually hit the cache`);
    };
    const identity = (actual, original) => {
      assert.deepEqual(persisted(actual), persisted(original), 'UI probes never change stored arguments/results');
      assert.deepEqual(actual.branch, original.branch, 'commands and diagnostics add no session messages or entries');
      assert.deepEqual(actual.tools.map(({ id, content, details, args }) => ({ id, content, details, args })),
        original.tools.map(({ id, content, details, args }) => ({ id, content, details, args })), 'restored live results and args are exact');
    };
    try {
      const live = await start('cache-performance-live', { tidyUi: true,
        flags: ['--tidy-ui-cache-mb', '1'], extraEnv: { TIDY_UI_TEST_CACHE_DIAGNOSTICS: '1' } });
      await live.appearance(false);
      await live.run('cache-performance');
      const nativeLive = await live.capture('pointer-cache-native-live-original');
      await live.appearance(true);
      const wide = await live.capture('pointer-cache-wide');
      assert.equal(wide.bashShape, false, 'eight commands execute actual built-in bash, never shape mocks');
      assert.equal(wide.tools.length, 11);
      assert.equal(byName(wide, 'bash').length, 8);
      const activity = traffic(live, 11);
      assert.deepEqual(activity.filter((event) => event.type === 'call').map((event) => event.name),
        [...Array(8).fill('bash'), 'read', 'read', 'tidy_ui_hidden']);
      assert.ok(activity.filter((event) => event.type === 'result').every((event) => !event.isError));
      allBashCards(wide);
      for (const [index, tool] of byName(wide, 'bash').entries()) {
        const expected = Array.from({ length: 1000 }, (_, row) => `CACHE_OUTPUT_${index}_${String(row + 1).padStart(4, '0')}_ASCII_PAYLOAD`).join('\n') + '\n';
        assert.deepEqual(tool.content, [{ type: 'text', text: expected }], 'all 1000 real output lines remain exact and untruncated');
        assert.equal(tool.lines.filter((row) => plain(row).includes(`CACHE_OUTPUT_${index}_`)).length, 11,
          'command plus first ten output rows only; full-body oracle checks every character');
        assert.ok(!tool.lines.some((row) => row.includes(`CACHE_OUTPUT_${index}_0011_`)), 'eleventh row is hidden, not painted');
      }
      assert.deepEqual(byName(wide, 'tidy_ui_hidden')[0].lines, [], 'actual self-shell empty renderer remains hidden');
      for (const tool of byName(wide, 'read')) compactContent(tool);
      await panelCells(wide, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(wide, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      let { stats: previous } = await observe(live, 'warm');
      assert.equal('limitBytes' in previous, false, 'legacy launch budget does not reintroduce eviction');
      assert.equal(previous.byKind.summary.entries, 2); assert.equal(previous.byKind.user.entries, 1);
      assert.equal(previous.byKind.bash.entries, 8);
      assert.equal(previous.ordinary.entries, 3); assert.equal(previous.cards.entries, 8);
      assert.equal(wide.users.length, 1, 'one actual user message joins the ten custom tool components');
       assert.equal(previous.entries, 11, 'one latest layout per eight bash, two compact tools and one user card; hidden contributes none');
      assert.ok(previous.retainedBytes > 0 && previous.builds >= 11);
      for (const name of ['frame-one', 'frame-two', 'frame-three']) {
        const { dump, stats } = await observe(live, name);
        delta(previous, stats, 0, name);
        assert.equal(stats.entries, 11); assert.equal(stats.retainedBytes, previous.retainedBytes);
        assert.deepEqual(dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
        identity(dump, wide); previous = stats;
      }
      live.send('cache editor scratch'); await live.settle();
       const editorScreen = live.screen(); // Do not append a dump command to nonempty editor input.
       writeFileSync(join(live.output, 'pointer-cache-editor.screen.txt'), editorScreen.join('\n'));
       assert.ok(editorScreen.some((row) => row.includes('cache editor scratch')), 'actual native editor changed');
      live.send('\x15'); await live.settle();
      let measured = await observe(live, 'editor-cleared'); delta(previous, measured.stats, 0, 'native editor frames'); previous = measured.stats;
      await moveAt(live, 5, panelAt(measured.dump, 7, 'CACHE_OUTPUT_7_').command);
      measured = await observe(live, 'pointer-motion'); delta(previous, measured.stats, 0, 'native no-hover motion');
      await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_'); previous = measured.stats;

      // Use a genuinely scrollable host viewport, then establish its own warm baseline.
      await live.resize(100, 35);
      const wheel = await observe(live, 'wheel-base');
       const wheelRow = wheel.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
       assert.ok(wheelRow >= 0, 'actual bash command is visible in the small native transcript viewport');
      await sgrAt(live, 5, wheelRow, 64, false);
      assert.notDeepEqual(live.screen(), wheel.dump.screen, 'actual wheel scrolls before any new capture/notification can alter the screen');
      await live.capture('pointer-cache-wheel-scrolled');
      measured = await observe(live, 'wheel-stats'); delta(wheel.stats, measured.stats, 0, 'native wheel frames');
      assert.ok(measured.dump.tools.every((tool) => !tool.expanded));
      await live.resize(100, 320); measured = await observe(live, 'height-restored'); previous = measured.stats;

      // Update only a native component, not its persisted/model result; then exercise reused-object invalidation.
      const chosen = byName(wide, 'bash')[7];
      for (const [operation, marker] of [['replace', 'CACHE_UPDATE_REPLACED'], ['reuse', 'CACHE_UPDATE_REUSED'], ['restore', 'CACHE_OUTPUT_7_0001_ASCII_PAYLOAD']]) {
        await live.command(`/tidy-ui-cache-update ${chosen.id} ${operation}`);
        measured = await observe(live, `result-${operation}`);
        delta(previous, measured.stats, 1, `single native updateResult ${operation}`);
        const changed = measured.dump.tools.find((tool) => tool.id === chosen.id);
        assert.ok(changed.lines.some((row) => row.includes(marker)), 'actual rendered body follows the native result update');
        assert.deepEqual(measured.dump.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines),
          wide.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines), 'every other component remains byte-identical');
        assert.deepEqual(measured.dump.branch, wide.branch, 'isolated native mutation does not touch stored traffic');
        allBashCards(measured.dump); previous = measured.stats;
      }
      identity(measured.dump, wide);
      const sessionBeforeDetach = readFileSync(wide.session);
      await live.command(`/tidy-ui-cache-detach ${chosen.id} remove`);
      measured = await observe(live, 'detached-live-owner');
      delta(previous, measured.stats, 0, 'removing a retained native owner does not rebuild its neighbors');
      assert.equal(measured.stats.entries, 10); assert.equal(measured.stats.cards.entries, 7);
      assert.equal(measured.stats.releases - previous.releases, 1, 'representation is released even while the driver deliberately retains the removed component');
      assert.ok(!measured.dump.tools.some(tool => tool.id === chosen.id));
      assert.deepEqual(readFileSync(wide.session), sessionBeforeDetach);
      previous = measured.stats;
      await live.command(`/tidy-ui-cache-detach ${chosen.id} restore`);
      measured = await observe(live, 'reattached-live-owner');
      delta(previous, measured.stats, 1, 'reattachment rebuilds only the removed representation');
      assert.equal(measured.stats.entries, 11); identity(measured.dump, wide);
      assert.deepEqual(measured.dump.tools.map(tool => tool.lines), wide.tools.map(tool => tool.lines));
      assert.deepEqual(readFileSync(wide.session), sessionBeforeDetach); previous = measured.stats;
      await live.resize(24, 320); measured = await observe(live, 'narrow');
      delta(previous, measured.stats, 11, 'width resize affects ten tools and one user card once');
      assert.equal(measured.stats.entries, 11, 'width replacement does not retain historical variants');
      allBashCards(measured.dump); for (const tool of measured.dump.tools) await assertFits(tool.lines, 24);
      previous = measured.stats;
      await live.resize(100, 320); measured = await observe(live, 'wide-again');
      delta(previous, measured.stats, 11, 'resize back rebuilds exactly one latest width per component');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;
      await live.command('/tidy-ui-theme light'); measured = await observe(live, 'light');
      delta(previous, measured.stats, 11, 'theme invalidation builds each custom tool/user component once');
      allBashCards(measured.dump); await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(measured.dump, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      assert.notDeepEqual(measured.dump.tools[0].lines, wide.tools[0].lines);
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines.map(plain)), wide.tools.map((tool) => tool.lines.map(plain))); previous = measured.stats;
      await live.command('/tidy-ui-theme dark'); measured = await observe(live, 'dark'); delta(previous, measured.stats, 11, 'theme restored'); previous = measured.stats;
      const commandRow = measured.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
      assert.ok(commandRow >= 0, 'chosen expandable command is on actual screen');
      await sgrAt(live, 3, commandRow); measured = await observe(live, 'expanded-one');
      delta(previous, measured.stats, 1, 'one real normalized bash click expands only one custom component');
      assert.deepEqual(measured.dump.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [chosen.id]);
      allBashCards(measured.dump);
      assert.ok(measured.dump.screen.some((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD')), 'complete expanded tail appears on physical screen');
      assert.ok(measured.stats.retainedBytes > previous.retainedBytes, 'full expanded rendered data is accounted'); previous = measured.stats;
      const tail = measured.dump.screen.findIndex((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD'));
      await sgrAt(live, 3, tail); measured = await observe(live, 'collapsed-one');
      delta(previous, measured.stats, 1, 'whole-panel output click replaces expanded layout with preview');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;

      // Retired controls cannot evict any representation, including an explicit zero.
      for (const command of ['/tidy-ui cache cards limit 0.02', '/tidy-ui cache cards limit 0', '/tidy-ui cache limit 0'])
        await live.command(command);
      measured = await observe(live, 'retired-limits-ignored');
      delta(previous, measured.stats, 0, 'retired limit commands preserve component-owned layouts');
      assert.equal(measured.stats.entries, 11); assert.equal(measured.stats.retainedBytes, previous.retainedBytes);
      allBashCards(measured.dump); identity(measured.dump, wide); previous = measured.stats;
      const clear = await observe(live, 'clear', '/tidy-ui cache clear');
      assert.equal(clear.stats.entries, 0); assert.equal(clear.stats.retainedBytes, 0);
      assert.equal(clear.stats.builds, previous.builds, 'clear releases data before any next-frame builds');
      measured = await observe(live, 'clear-cold'); delta(previous, measured.stats, 11, 'clear causes exactly one on-demand rebuild per custom tool/user component');
      assert.equal(measured.stats.entries, 11); identity(measured.dump, wide);

      const session = wide.session;
      const native = await start('cache-performance-native', { session, workspace: live.work });
      const control = await native.capture('pointer-cache-native');
      assert.deepEqual(control.branch, wide.branch); identity(control, wide);
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(native.events().filter((event) => event.type === type).length, 0, `native replay emits no ${type}`);
      await native.close();
      await live.appearance(false); const off = await observe(live, 'off');
      assert.equal(off.stats.entries, 0); assert.equal(off.stats.retainedBytes, 0);
      const nativeRows = off.dump.tools.map((tool) => tool.lines);
      assert.deepEqual(off.dump.tools.map((tool) => tool.lines), nativeLive.tools.map((tool) => tool.lines),
        'off restores the original same-live native bodies byte-for-byte, including real unpersisted timing');
      await live.appearance(true); const on = await observe(live, 'on-cold');
      assert.equal(on.stats.builds, 11, 'new controller starts cold and builds ten tool bodies plus one user card once');
      assert.equal(on.stats.entries, 11); identity(on.dump, wide);
      assert.deepEqual(on.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      const onWarm = await observe(live, 'on-warm'); delta(on.stats, onWarm.stats, 0, 'reenabled steady frames');
      await live.appearance(false); const offAgain = await live.capture('pointer-cache-off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), nativeRows, 'same live native bodies are restored byte-for-byte');
      // Compare reconstructed native bodies with reconstructed native control; neither has unpersisted live durations.
      const beforeReload = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', beforeReload + 1);
      await until(() => live.screen().some(row => row.includes('Reloaded keybindings, extensions,')), 'cache test native reload completion');
      await live.appearance(false);
      const reloadedNative = await live.capture('pointer-cache-reloaded-native');
      assert.deepEqual(reloadedNative.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines),
        'native history after reload matches same-session stock replay byte-for-byte without normalization');
      identity(reloadedNative, wide);
      await live.appearance(true); const final = await observe(live, 'final'); identity(final.dump, wide);
      assert.deepEqual(traffic(live, 11), activity, 'all editor/pointer/resize/theme/cache commands preserve eleven calls/results and twelve model contexts exactly');
      await live.close();
      const replay = await start('cache-performance-replay', { tidyUi: true, session, workspace: live.work, flags: ['--tidy-ui-cache-mb', '1'] }, false);
      const resumed = await observe(replay, 'replayed'); identity(resumed.dump, wide);
      assert.equal(resumed.stats.entries, 11);
      assert.deepEqual(resumed.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); allBashCards(resumed.dump);
      // Pi asynchronously invalidates its whole tree after startup syntax-grammar loading.
      // Measure an explicit cold epoch instead of attributing all bootstrap work to one frame.
      const replayClear = await observe(replay, 'replay-clear', '/tidy-ui cache clear');
      assert.equal(replayClear.stats.entries, 0); assert.equal(replayClear.stats.retainedBytes, 0);
      const replayCold = await observe(replay, 'replay-cold');
      delta(replayClear.stats, replayCold.stats, 11, 'explicit replay cold epoch builds exactly ten tool bodies plus one user card once');
      assert.equal(replayCold.stats.entries, 11); identity(replayCold.dump, wide);
      const replayWarm = await observe(replay, 'replay-warm'); delta(replayCold.stats, replayWarm.stats, 0, 'actual same-session replay warm frames');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `pi-tidy-ui replay emits no ${type}`);
      await replay.close();
      assert.equal(replay.closed, true, 'fullscreen layout replay is reaped before the independent regular mode');
      const regular = await start('cache-performance-regular-replay', { tidyUi: true, mode: 'regular', session, workspace: live.work });
      const regularBase = await observe(regular, 'regular-base'); identity(regularBase.dump, wide);
      assert.equal(regularBase.stats.entries, 11);
      assert.deepEqual(regularBase.dump.tools.map(tool => tool.lines), wide.tools.map(tool => tool.lines));
      const regularWarm = await observe(regular, 'regular-warm'); delta(regularBase.stats, regularWarm.stats, 0, 'regular replay unchanged frame');
      const regularClear = await observe(regular, 'regular-clear', '/tidy-ui cache clear');
      assert.equal(regularClear.stats.presentationEntries, 0);
      const regularCold = await observe(regular, 'regular-cold'); delta(regularClear.stats, regularCold.stats, 11, 'regular replay clear rebuild');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(regular.events().filter(event => event.type === type).length, 0, `regular replay emits no ${type}`);
      assert.deepEqual(readFileSync(session), sessionBeforeDetach);
      writeFileSync(join(artifacts, 'cache-performance-coverage.json'), JSON.stringify({
        builtInBash: true, installedAFTExecuted: false, calls: 11, results: 11, modelContexts: 12,
        bashCalls: 8, fullOutputLinesPerBash: 1000, customComponents: 11, userCards: 1, hiddenNativeComponents: 1,
        replayCalls: 0, replayResults: 0, replayModelContexts: 0, snapshots,
        checked: ['exact independent body oracle', 'physical panel/theme/output cells', 'native wheel/editor/no-hover frames',
          'single native result replacement/reused-object/restore', 'remove retained live owner/release/reinsert exact child order', 'one latest width', 'theme rebuild counts', 'one native bash click expansion/collapse',
          'regular/fullscreen replay warm and clear counters', 'retired byte/zero limits cannot evict component layouts', 'presentation-kind and footer memory estimates', 'clear cold rebuild', 'off release/on cold', 'native/replay/session/model identity'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });
