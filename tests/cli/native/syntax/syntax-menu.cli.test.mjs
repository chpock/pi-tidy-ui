import "../../../fixtures/test-guard.mjs";
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from "../../../fixtures/terminal-harness.mjs";
import { closeTerminals, runCleanupSteps } from "../../../fixtures/terminal-cleanup.mjs";
import { readPendingJson, nativeReady, themePhaseReady, semanticPhaseReady } from "../../../fixtures/syntax-observation.mjs";
import { prepareSyntaxNative, inputs, scenario, chooseTheme, settledStats, body, stats, work, finish, persisted, savedThemeSession, until, themeMarkers, themeForegrounds, syntaxReady, retainedNativeThemeStats, expectedThemeColors, traffic } from "../../../fixtures/syntax-cli-support.mjs";

const { binary, fixture, descriptor } = await prepareSyntaxNative();

test('occipital CLI: real theme picker, explicit RGB, persisted selection and fresh default enablement',
  { timeout: 90000 }, async () => {
    const native = new PiTerminal('syntax-theme-native', { mode: 'fullscreen', extraEnv: descriptor, extensions: [fixture] });
    let replay;
    try {
      const initial = await scenario(native, true);
      await chooseTheme(native, 1);
      const prefs = readFileSync(`${native.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'), saved = JSON.parse(prefs);
      assert.deepEqual(Object.keys(saved), ['syntaxTheme']); assert.equal(saved.syntaxTheme.kind, 'occipital'); assert.equal(typeof saved.syntaxTheme.id, 'string');
      await settledStats(native, 'theme-settled', s => nativeReady(s) && s.client.effective.id === saved.syntaxTheme.id);
      const themed = await native.capture('syntax-explicit-theme'); assert.deepEqual(body(themed), body(initial));
      const y = themed.screen.findIndex(row => row.includes('const x=2;')), x = themed.screen[y].indexOf('const x=2;');
      assert.notEqual(themed.cells[y][x].fg, initial.cells[initial.screen.findIndex(row => row.includes('const x=2;'))][x].fg,
        'explicit daemon theme RGB reaches physical source cells, not Pi keyword color');
      const before = await stats(native, 'theme-before'); await native.capture('syntax-theme-warm');
      const after = await stats(native, 'theme-after'); assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, before.counts.piBridges);
      const session = initial.session, workspace = native.work; await finish(native);
      replay = new PiTerminal('syntax-theme-restored', { mode: 'fullscreen', session, workspace, extensions: [fixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_CONFIG: prefs } });
      await replay.ready(); await settledStats(replay, 'theme-restored-settled', s => nativeReady(s)
        && s.source.dispatches > 0 && s.client.effective.id === saved.syntaxTheme.id);
      const restored = await replay.capture('syntax-theme-restored');
      assert.deepEqual(body(restored), body(themed)); assert.deepEqual(persisted(restored), persisted(initial));
      const ry = restored.screen.findIndex(row => row.includes('const x=2;')), rx = restored.screen[ry].indexOf('const x=2;');
      assert.equal(restored.cells[ry][rx].fg, themed.cells[y][x].fg, 'fresh client restores saved explicit theme');
      const restoredStats = await stats(replay, 'theme-restored'); assert.equal(restoredStats.counts.acquisitions, 1); assert.equal(restoredStats.counts.downloads, 0);
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      await finish(replay);
      console.log(JSON.stringify({ theme: saved.syntaxTheme, actual: native.output, restored: replay.output, warmDelta: 0 }));
    } finally { await runCleanupSteps(() => native.close(), () => replay?.close(), () => replay?.dispose(), () => native.dispose()); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} theme preview is visible before confirmation and rollback rejects late colors`,
  { timeout: 120000 }, async () => {
    const { directory, session, bytes } = await savedThemeSession();
    const originalConfig = '{"syntaxTheme":{"kind":"pi"},"unknown":{"untouched":true}}\n';
    const terminal = new PiTerminal(`theme-preview-${mode}`, { mode, session, extensions: [fixture], extraEnv: {
      ...descriptor, TIDY_UI_TEST_THEME_OBSERVE: '1', TIDY_UI_TEST_THEME_PREVIEW: '1', TIDY_UI_TEST_SYNTAX_CONFIG: originalConfig } });
    const config = join(terminal.agent, 'extensions/pi-tidy-ui/config.json');
    const phase = name => writeFileSync(join(terminal.output, 'syntax-theme-phase'), name);
    const observe = async name => {
      writeFileSync(join(terminal.output, 'syntax-preview-request'), name); terminal.send('\x1b\x10');
      return until(() => {
        terminal.health();
        return readPendingJson(join(terminal.output, `syntax-preview-${name}.json`));
      }, `draft-safe preview counters ${name}`);
    };
    let observation = 0;
    const ready = async (name, id, completedPhase) => until(async () => {
      const current = await semanticPhaseReady(() => observe(`${name}-${observation++}`), () => {
        terminal.health(); return terminal.events();
      }, themeMarkers, id);
      return current && current.client.effective.id === id ? current : false;
    }, `settled preview ${name}`);
    const search = async label => {
      terminal.send(label);
      await terminal.waitForScreen(() => terminal.tidyRows().some(row => row.startsWith('→ ') && row.includes(label)), `preview highlighted ${label}`);
    };
    let baseline;
    const colors = async (name, wanted) => until(async () => {
      const painted = await terminal.captureCompleteScreen(name, baseline);
      return themeForegrounds(painted).every((color, i) => color === wanted(painted)[i]) ? painted : false;
    }, `physical preview colors ${name}`);
    const raw = dump => dump.tools.map(({ name, args, content, details, isError, argsComplete, executionStarted, partial }) =>
      ({ name, args, content, details, isError, argsComplete, executionStarted, partial }));
    try {
      await terminal.ready(); await terminal.resize(100, 180);
      await syntaxReady(terminal);
      const initial = await retainedNativeThemeStats(terminal, 'preview-initial', observe);
      baseline = await terminal.capture('physical-preview-baseline'); themeForegrounds(baseline);
      assert.ok(baseline.tools.every(tool => !('tinyLines' in tool)));
      const profiles = initial.client.provider.description.profiles;
      const mocha = profiles.find(profile => profile.label === 'Catppuccin Mocha'), latte = profiles.find(profile => profile.label === 'Catppuccin Latte');
      assert.ok(mocha && latte); assert.equal(initial.counts.themeSaves, 0);
      assert.ok(initial.localWork.sourceSegments > 0); assert.ok(initial.localWork.prefixScalarReads > 0);
      const beforeMocha = await observe('before-cached-mocha');
      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('preview-mocha'); await search(mocha.label);
      const preview = await ready('mocha', mocha.id, 'preview-mocha');
      assert.equal(preview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      assert.equal(preview.counts.sourceRequests, initial.counts.sourceRequests, 'retained native semantics need no SOURCE for preview');
      assert.equal(preview.source.preparedBytes, initial.source.preparedBytes);
      const painted = await colors('preview-before-enter', dump => expectedThemeColors(terminal, 'preview-mocha', dump, mocha.id));
      assert.notDeepEqual(themeForegrounds(painted), themeForegrounds(baseline), 'colors actually change while the unconfirmed list remains open');
      assert.ok(terminal.tidyHeading('Code color theme'));
      const cachedMocha = await observe('cached-mocha-painted');
      assert.equal(cachedMocha.counts.styleRequests, beforeMocha.counts.styleRequests, 'cached Mocha selection through actual colors does no STYLE work');
      for (const width of [100, 90, 100]) { await terminal.resize(width, 180); await observe(`preview-warm-${width}-${observation++}`); }
      const warm = await observe('preview-warm-final'); assert.deepEqual(work(warm), work(cachedMocha));
      assert.equal(warm.counts.themeSaves, 0); assert.equal(warm.counts.piBridges, initial.counts.piBridges);
      const beforeCancel = await observe('before-cached-cancel');
      phase('cancel-pi'); terminal.send('\x1b');
      await until(() => terminal.tidyHeading('Tidy UI'), 'Escape restores the root page');
      const cancelled = await ready('cancel-pi', 'pi', 'cancel-pi');
      assert.equal(cancelled.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      await colors('preview-cancelled', () => themeForegrounds(baseline));
      const afterCancellation = await observe('cached-cancel-painted');
      assert.equal(afterCancellation.counts.styleRequests, beforeCancel.counts.styleRequests, 'cancel to cached Follow Pi through actual colors does no STYLE work');
      await terminal.closeTidyMenu();
      const afterCancel = await terminal.capture('physical-preview-after-cancel');
      assert.deepEqual(raw(afterCancel), raw(baseline)); assert.deepEqual(body(afterCancel), body(baseline));

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeLatte = await observe('before-uncached-latte');
      phase('preview-latte'); await search(latte.label);
      const lattePreview = await ready('latte', latte.id, 'preview-latte');
      assert.equal(lattePreview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      const lattePaint = await colors('preview-latte-before-enter', dump => expectedThemeColors(terminal, 'preview-latte', dump, latte.id));
      const latteMaterialized = await observe('uncached-latte-painted');
      assert.ok(latteMaterialized.counts.styleRequests > beforeLatte.counts.styleRequests, 'first Latte selection resolves actual uncached STYLE');
      await terminal.selectTidyItem(latte.label);
      const confirmed = await ready('confirmed', latte.id, 'preview-latte'); assert.equal(confirmed.counts.themeSaves, 1);
      assert.deepEqual(work(confirmed), work(latteMaterialized), 'confirming the settled preview does not parse it again');
      const confirmedConfig = readFileSync(config, 'utf8');
      assert.deepEqual(JSON.parse(confirmedConfig), { syntaxTheme: { kind: 'occipital', id: latte.id }, unknown: { untouched: true } });
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeSecondMocha = await observe('before-second-cached-mocha');
      phase('second-preview'); await search(mocha.label); await ready('second-preview', mocha.id, 'second-preview');
      await colors('second-mocha-painted', dump => expectedThemeColors(terminal, 'second-preview', dump, mocha.id));
      const secondMocha = await observe('second-cached-mocha-painted');
      assert.equal(secondMocha.counts.styleRequests, beforeSecondMocha.counts.styleRequests, 'second cached Mocha selection does no STYLE work');
      phase('back-to-latte'); await terminal.selectTidyItem('Back');
      const back = await ready('back', latte.id, 'back-to-latte');
      assert.equal(back.counts.themeSaves, 1); assert.equal(readFileSync(config, 'utf8'), confirmedConfig);
      await colors('preview-back-to-confirmed', () => themeForegrounds(lattePaint));
      const backPainted = await observe('cached-back-painted');
      assert.equal(backPainted.counts.styleRequests, secondMocha.counts.styleRequests, 'Back to cached Latte through actual colors does no STYLE work');
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeHeld = await observe('before-uncached-hold');
      const uncached = profiles.find(profile => profile.id !== 'pi' && profile.id !== mocha.id && profile.id !== latte.id); assert.ok(uncached);
      phase('held-preview'); await search(uncached.label); await terminal.event('syntax_preview_reply_held');
      const held = await observe('held');
      assert.ok(held.source.globalUnsettledJobs >= 1 && held.source.globalUnsettledJobs <= 2);
      assert.equal(held.counts.sourceRequests, confirmed.counts.sourceRequests, 'STYLE holds never reparse retained SOURCE');
      assert.ok(held.counts.styleRequests > beforeHeld.counts.styleRequests, 'uncached held selection performs genuine STYLE work');
      assert.ok(held.counts.heldStyleReplies >= 1 && held.counts.heldStyleReplies <= 2);
      await colors('preview-held-keeps-last-colors', () => themeForegrounds(lattePaint));
      phase('late-rollback'); await terminal.closeTidyMenu();
      await colors('preview-rollback-owned', () => themeForegrounds(lattePaint));
      const rollback = await observe('late-rollback');
      assert.equal(rollback.client.effective.id, latte.id); assert.equal(rollback.counts.themeSaves, 1);
      writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go');
      const late = await until(async () => {
        const snapshot = await observe(`after-late-${observation++}`);
        return snapshot.client.effective.id === latte.id && snapshot.source.globalUnsettledJobs === 0
          && snapshot.counts.deliveredStyleReplies === held.counts.heldStyleReplies ? snapshot : false;
      }, 'held replies retire without replacing the cached rollback');
      assert.equal(late.source.dispatches, held.source.dispatches, 'rollback to the retained Latte result sends no replacement classifications');
      assert.equal(late.source.preparedBytes, held.source.preparedBytes, 'rollback encodes no duplicate source');
      assert.equal(late.source.stylePublications, rollback.source.stylePublications, 'late STYLE replies cannot publish over the retained rollback');
      assert.equal(late.counts.sourceRequests, initial.counts.sourceRequests, 'all preview/confirm/cancel/rollback phases reuse retained SOURCE');
      assert.equal(late.source.preparedBytes, initial.source.preparedBytes);
      assert.equal(late.counts.styleRequests, held.counts.styleRequests, 'cached rollback needs no replacement STYLE matching');
      await colors('preview-after-late-replies', () => themeForegrounds(lattePaint));
      const final = await terminal.capture('physical-preview-final');
      assert.deepEqual(raw(final), raw(baseline)); assert.deepEqual(body(final), body(baseline));
      assert.deepEqual(readFileSync(session), bytes); assert.equal(traffic(terminal).length, 0);
      assert.equal(readFileSync(config, 'utf8'), confirmedConfig); assert.equal(late.counts.themeSaves, 1);
      const finalWork = work(await observe('final-materialized'));
      for (const [i, width] of [100, 90, 100].entries()) { await terminal.resize(width, 180); await terminal.capture(`physical-preview-final-warm-${i}`); }
      const last = await observe('final-warm'); assert.deepEqual(work(last), finalWork);
      assert.ok(terminal.events().filter(event => event.type === 'syntax_native_dispatch').every(event => event.jobs <= 2));
      console.log(JSON.stringify({ observation: 'pre-quit', themePreview: terminal.output, mode, node: last.node, pi: inputs.pi.version,
        previewSaves: preview.counts.themeSaves, confirmedSaves: last.counts.themeSaves, heldReplies: held.counts.heldStyleReplies, sourceRequests: last.counts.sourceRequests, styleRequests: last.counts.styleRequests, localWork: last.localWork,
        cachedStylePairs: [[beforeMocha.counts.styleRequests, cachedMocha.counts.styleRequests], [beforeCancel.counts.styleRequests, afterCancellation.counts.styleRequests],
          [beforeSecondMocha.counts.styleRequests, secondMocha.counts.styleRequests], [secondMocha.counts.styleRequests, backPainted.counts.styleRequests]], warmDelta: 0 }));
      phase('process-exit');
      await terminal.quit('\x04');
      await finish(terminal);
    } finally {
      await runCleanupSteps(() => writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go'),
        () => closeTerminals([terminal]), () => rm(directory, { recursive: true, force: true }));
    }
  });
