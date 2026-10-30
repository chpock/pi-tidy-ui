import "../../../fixtures/test-guard.mjs";
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from "../../../fixtures/terminal-harness.mjs";
import { THEME_CATALOGUE } from '../../../../src/themes/catalogue.ts';
import { closeTerminals, runCleanupSteps } from "../../../fixtures/terminal-cleanup.mjs";
import { nativeReady, semanticStyle, semanticPhaseReady } from "../../../fixtures/syntax-observation.mjs";
import { prepareSyntaxNative, inputs, scenario, chooseTheme, settledStats, body, work, finish, persisted, savedThemeSession, until, themeMarkers, themeForegrounds, syntaxReady, retainedNativeThemeStats, expectedThemeColors, traffic, captureThenRenderDiagnostics, expressionForeground } from "../../../fixtures/syntax-cli-support.mjs";

const { binary, fixture, descriptor } = await prepareSyntaxNative();

test('occipital CLI: local palette picker, persisted selection and fresh default enablement',
  { timeout: 90000 }, async () => {
    const native = new PiTerminal('syntax-theme-native', { mode: 'fullscreen', extraEnv: descriptor, extensions: [fixture] });
    let replay;
    try {
      const initial = await scenario(native, true);
      const paletteId = 'amoled-dark';
      await chooseTheme(native, paletteId);
      const prefs = readFileSync(`${native.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'), saved = JSON.parse(prefs);
      assert.deepEqual(Object.keys(saved), ['syntaxTheme']); assert.equal(saved.syntaxTheme.kind, 'theme'); assert.equal(saved.syntaxTheme.id, paletteId);
      await settledStats(native, 'theme-settled', s => nativeReady(s) && s.client.effective.id === saved.syntaxTheme.id);
      const themed = await captureThenRenderDiagnostics(native, 'syntax-explicit-theme'); assert.deepEqual(body(themed), body(initial));
      const y = themed.screen.findIndex(row => row.includes('const x=2;')), x = themed.screen[y].indexOf('const x=2;');
      const resolved = semanticStyle(native.events(), 'const x=2;'); assert.ok(resolved, 'actual generic semantic style remains available');
      assert.equal(themed.cells[y][x].fg, expressionForeground(resolved.expression, themed, paletteId), 'local palette reaches the physical keyword cell');
      assert.notEqual(themed.cells[y][x].fg, initial.cells[initial.screen.findIndex(row => row.includes('const x=2;'))][x].fg,
        'palette selection changes physical ink without a second classifier');
      const before = themed.sample; await captureThenRenderDiagnostics(native, 'syntax-theme-warm');
      const after = await settledStats(native, 'theme-after'); assert.deepEqual(work(after), work(before));
      assert.equal(after.counts.styleRequests, before.counts.styleRequests, 'palette selection reuses generic styles'); assert.equal(after.counts.piBridges, before.counts.piBridges);
      const session = initial.session, workspace = native.work; await finish(native);
      replay = new PiTerminal('syntax-theme-restored', { mode: 'fullscreen', session, workspace, extensions: [fixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_CONFIG: prefs } });
      await replay.ready(); await settledStats(replay, 'theme-restored-settled', s => nativeReady(s)
        && s.source.dispatches > 0 && s.client.effective.id === saved.syntaxTheme.id);
      const restored = await captureThenRenderDiagnostics(replay, 'syntax-theme-restored');
      assert.deepEqual(body(restored), body(themed)); assert.deepEqual(persisted(restored), persisted(initial));
      const ry = restored.screen.findIndex(row => row.includes('const x=2;')), rx = restored.screen[ry].indexOf('const x=2;');
      assert.equal(restored.cells[ry][rx].fg, themed.cells[y][x].fg, 'fresh client restores saved explicit theme');
      const restoredStats = restored.sample; assert.equal(restoredStats.counts.acquisitions, 1); assert.equal(restoredStats.counts.downloads, 0);
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      await finish(replay);
      console.log(JSON.stringify({ theme: saved.syntaxTheme, actual: native.output, restored: replay.output, warmDelta: 0 }));
    } finally { await runCleanupSteps(() => native.close(), () => replay?.close(), () => replay?.dispose(), () => native.dispose()); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} palette preview is visible before confirmation and rollback preserves the prior selection`,
  { timeout: 120000 }, async () => {
    const { directory, session, bytes } = await savedThemeSession();
    const originalConfig = '{"syntaxTheme":{"kind":"pi"},"unknown":{"untouched":true}}\n';
    const terminal = new PiTerminal(`theme-preview-${mode}`, { mode, session, extensions: [fixture], extraEnv: {
      ...descriptor, TIDY_UI_TEST_THEME_OBSERVE: '1', TIDY_UI_TEST_THEME_PREVIEW: '1', TIDY_UI_TEST_SYNTAX_CONFIG: originalConfig } });
    const config = join(terminal.agent, 'extensions/pi-tidy-ui/config.json');
    const phase = name => writeFileSync(join(terminal.output, 'syntax-theme-phase'), name);
    const observe = name => settledStats(terminal, name);
    let observation = 0;
    const ready = async (name, id) => {
      const current = await observe(name);
      assert.ok(await semanticPhaseReady(() => current, () => terminal.events(), themeMarkers, id), `settled preview ${name}`);
      assert.equal(current.client.effective.id, id);
      return current;
    };
    const search = async label => {
      terminal.send(label);
      await terminal.waitForScreen(() => terminal.tidyRows().some(row => row.startsWith('→ ') && row.includes(label)), `preview highlighted ${label}`);
    };
    let baseline;
    const assertColors = (painted, wanted) => {
      assert.deepEqual(themeForegrounds(painted), wanted(painted), 'physical preview colors');
      return painted;
    };
    const colors = async (name, wanted) => assertColors({ ...baseline, ...await terminal.captureSettled(name) }, wanted);
    const raw = dump => dump.tools.map(({ name, args, content, details, isError, argsComplete, executionStarted, partial }) =>
      ({ name, args, content, details, isError, argsComplete, executionStarted, partial }));
    try {
      await terminal.ready(); await terminal.resize(100, 180);
      await syntaxReady(terminal);
      const initial = await retainedNativeThemeStats(terminal, 'preview-initial');
      baseline = await captureThenRenderDiagnostics(terminal, 'physical-preview-baseline'); themeForegrounds(baseline);
      assert.ok(baseline.tools.every(tool => !('tinyLines' in tool)));
      const mocha = THEME_CATALOGUE.find(theme => theme.id === 'catppuccin-dark'), latte = THEME_CATALOGUE.find(theme => theme.id === 'catppuccin-light');
      assert.ok(mocha && latte); assert.equal(initial.counts.themeSaves, 0);
      assert.ok(initial.localWork.sourceSegments > 0); assert.ok(initial.localWork.prefixScalarReads > 0);
      const beforeMocha = await observe('before-cached-mocha');
      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('preview-mocha'); await search(mocha.label);
      const preview = await ready('mocha', mocha.id);
      assert.equal(preview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      assert.equal(preview.counts.sourceRequests, initial.counts.sourceRequests, 'retained source semantics need no SOURCE for preview');
      assert.equal(preview.source.preparedBytes, initial.source.preparedBytes);
      const painted = await colors('preview-before-enter', dump => expectedThemeColors(terminal, 'preview-mocha', dump, mocha.id));
      assert.notDeepEqual(themeForegrounds(painted), themeForegrounds(baseline), 'colors actually change while the unconfirmed list remains open');
      assert.ok(terminal.tidyHeading('Code color theme'));
      const cachedMocha = await observe('cached-mocha-painted');
      assert.equal(cachedMocha.counts.styleRequests, beforeMocha.counts.styleRequests, 'palette preview reuses the common generic STYLE output');
      for (const width of [100, 90, 100]) { await terminal.resize(width, 180); await observe(`preview-warm-${width}-${observation++}`); }
      const warm = await observe('preview-warm-final'); assert.deepEqual(work(warm), work(cachedMocha));
      assert.equal(warm.counts.themeSaves, 0); assert.equal(warm.counts.piBridges, initial.counts.piBridges);
      const beforeCancel = await observe('before-cached-cancel');
      phase('cancel-pi'); terminal.send('\x1b');
      await until(() => terminal.tidyHeading('Tidy UI'), 'Escape restores the root page');
      const cancelled = await ready('cancel-pi', 'pi');
      assert.equal(cancelled.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      await colors('preview-cancelled', () => themeForegrounds(baseline));
      const afterCancellation = await observe('cached-cancel-painted');
      assert.equal(afterCancellation.counts.styleRequests, beforeCancel.counts.styleRequests, 'cancel to Follow Pi reuses the generic STYLE output');
      await terminal.closeTidyMenu();
      const afterCancel = await terminal.capture('physical-preview-after-cancel');
      assert.deepEqual(raw(afterCancel), raw(baseline)); assert.deepEqual(body(afterCancel), body(baseline));

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeLatte = await observe('before-uncached-latte');
      phase('preview-latte'); await search(latte.label);
      const lattePreview = await ready('latte', latte.id);
      assert.equal(lattePreview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      const lattePaint = await colors('preview-latte-before-enter', dump => expectedThemeColors(terminal, 'preview-latte', dump, latte.id));
      const latteMaterialized = await observe('uncached-latte-painted');
      assert.equal(latteMaterialized.counts.styleRequests, beforeLatte.counts.styleRequests, 'all palettes share the same rules and resolved STYLE');
      await terminal.selectTidyItem(latte.label);
      const confirmed = await ready('confirmed', latte.id); assert.equal(confirmed.counts.themeSaves, 1);
      assert.deepEqual(work(confirmed), work(latteMaterialized), 'confirming the settled preview does not parse it again');
      const confirmedConfig = readFileSync(config, 'utf8');
      assert.deepEqual(JSON.parse(confirmedConfig), { syntaxTheme: { kind: 'theme', id: latte.id }, unknown: { untouched: true } });
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeSecondMocha = await observe('before-second-cached-mocha');
      phase('second-preview'); await search(mocha.label); await ready('second-preview', mocha.id);
      await colors('second-mocha-painted', dump => expectedThemeColors(terminal, 'second-preview', dump, mocha.id));
      const secondMocha = await observe('second-cached-mocha-painted');
      assert.equal(secondMocha.counts.styleRequests, beforeSecondMocha.counts.styleRequests, 'cached palette preview does no additional STYLE work');
      phase('back-to-latte'); await terminal.selectTidyItem('Back');
      const back = await ready('back', latte.id);
      assert.equal(back.counts.themeSaves, 1); assert.equal(readFileSync(config, 'utf8'), confirmedConfig);
      await colors('preview-back-to-confirmed', () => themeForegrounds(lattePaint));
      const backPainted = await observe('cached-back-painted');
      assert.equal(backPainted.counts.styleRequests, secondMocha.counts.styleRequests, 'Back to the saved palette reuses generic STYLE output');
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      const beforeThird = await observe('before-third-palette');
       const thirdPalette = THEME_CATALOGUE.find(theme => theme.id === 'nord-dark'); assert.ok(thirdPalette);
      phase('third-palette-preview'); await search(thirdPalette.label);
      const third = await ready('third-preview', thirdPalette.id);
      assert.equal(third.counts.sourceRequests, confirmed.counts.sourceRequests, 'palette preview does not reparse retained SOURCE');
      assert.equal(third.counts.styleRequests, beforeThird.counts.styleRequests, 'palette preview does not enqueue palette-specific STYLE');
      const thirdPaint = await colors('preview-third-palette', dump => expectedThemeColors(terminal, 'third-preview', dump, thirdPalette.id));
      assert.notDeepEqual(themeForegrounds(thirdPaint), themeForegrounds(lattePaint), 'third palette has independently visible physical colors');
      phase('rollback'); await terminal.closeTidyMenu();
      await colors('preview-rollback-owned', () => themeForegrounds(lattePaint));
      const late = await observe('after-preview-rollback');
      assert.equal(late.client.effective.id, latte.id); assert.equal(late.counts.themeSaves, 1);
      assert.equal(late.source.globalUnsettledJobs, 0);
      assert.equal(late.source.dispatches, confirmed.source.dispatches, 'rollback returns to retained semantic results');
      assert.equal(late.source.preparedBytes, confirmed.source.preparedBytes, 'palette preview encodes no duplicate source');
      assert.equal(late.counts.sourceRequests, initial.counts.sourceRequests, 'all preview, confirm and rollback phases reuse retained SOURCE');
      assert.equal(late.source.preparedBytes, initial.source.preparedBytes);
       assert.equal(late.counts.styleRequests, initial.counts.styleRequests, 'all local palettes reuse the common resolved STYLE expressions without another STYLE request');
      await colors('preview-after-rollback', () => themeForegrounds(lattePaint));
      const final = await captureThenRenderDiagnostics(terminal, 'physical-preview-final');
      assert.deepEqual(raw(final), raw(baseline)); assert.deepEqual(body(final), body(baseline));
      assert.deepEqual(readFileSync(session), bytes); assert.equal(traffic(terminal).length, 0);
      assert.equal(readFileSync(config, 'utf8'), confirmedConfig); assert.equal(late.counts.themeSaves, 1);
      const finalWork = work(await observe('final-materialized'));
      for (const [i, width] of [100, 90, 100].entries()) { await terminal.resize(width, 180); await captureThenRenderDiagnostics(terminal, `physical-preview-final-warm-${i}`); }
      const last = await observe('final-warm'); assert.deepEqual(work(last), finalWork);
      assert.ok(terminal.events().filter(event => event.type === 'syntax_native_dispatch').every(event => event.jobs <= 2));
      console.log(JSON.stringify({ observation: 'pre-quit', themePreview: terminal.output, mode, node: last.node, pi: inputs.pi.version,
        previewSaves: preview.counts.themeSaves, confirmedSaves: last.counts.themeSaves, sourceRequests: last.counts.sourceRequests, styleRequests: last.counts.styleRequests, localWork: last.localWork,
        cachedStylePairs: [[beforeMocha.counts.styleRequests, cachedMocha.counts.styleRequests], [beforeCancel.counts.styleRequests, afterCancellation.counts.styleRequests],
          [beforeSecondMocha.counts.styleRequests, secondMocha.counts.styleRequests], [secondMocha.counts.styleRequests, backPainted.counts.styleRequests]], warmDelta: 0 }));
      phase('process-exit');
      await terminal.quit('\x04');
      await finish(terminal);
    } finally {
       await runCleanupSteps(() => closeTerminals([terminal]), () => rm(directory, { recursive: true, force: true }));
    }
  });
