import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from './fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from './fixtures/terminal-cleanup.mjs';
import { readPendingJson, nativeReady, themePhaseReady } from './fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, inputs, scenario, chooseTheme, settledStats, body, stats, work, finish, persisted, savedThemeSession, until, themeMarkers, themeForegrounds, syntaxReady, initialThemeStats, expectedThemeColors, traffic } from './fixtures/syntax-cli-support.mjs';

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
      const current = await themePhaseReady(() => observe(`${name}-${observation++}`), () => {
        terminal.health(); return terminal.events();
      }, completedPhase, themeMarkers);
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
      const initial = await initialThemeStats(terminal, 'preview-initial');
      baseline = await terminal.capture('physical-preview-baseline'); themeForegrounds(baseline);
      assert.ok(baseline.tools.every(tool => !('tinyLines' in tool)));
      const profiles = initial.client.provider.description.profiles;
      const mocha = profiles.find(profile => profile.label === 'Catppuccin Mocha'), latte = profiles.find(profile => profile.label === 'Catppuccin Latte');
      assert.ok(mocha && latte); assert.equal(initial.counts.themeSaves, 0);
      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('preview-mocha'); await search(mocha.label);
      const preview = await ready('mocha', mocha.id, 'preview-mocha');
      assert.equal(preview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      assert.equal(preview.source.dispatches, initial.source.dispatches + 5);
      const painted = await colors('preview-before-enter', dump => expectedThemeColors(terminal, 'preview-mocha', dump));
      assert.notDeepEqual(themeForegrounds(painted), themeForegrounds(baseline), 'colors actually change while the unconfirmed list remains open');
      assert.ok(terminal.tidyHeading('Code color theme'));
      for (const width of [100, 90, 100]) { await terminal.resize(width, 180); await observe(`preview-warm-${width}-${observation++}`); }
      const warm = await observe('preview-warm-final'); assert.deepEqual(work(warm), work(preview));
      assert.equal(warm.counts.themeSaves, 0); assert.equal(warm.counts.piBridges, initial.counts.piBridges);
      phase('cancel-pi'); terminal.send('\x1b');
      await until(() => terminal.tidyHeading('Tidy UI'), 'Escape restores the root page');
      const cancelled = await ready('cancel-pi', 'pi', 'cancel-pi');
      assert.equal(cancelled.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      await colors('preview-cancelled', () => themeForegrounds(baseline));
      await terminal.closeTidyMenu();
      const afterCancel = await terminal.capture('physical-preview-after-cancel');
      assert.deepEqual(raw(afterCancel), raw(baseline)); assert.deepEqual(body(afterCancel), body(baseline));

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('preview-latte'); await search(latte.label);
      const lattePreview = await ready('latte', latte.id, 'preview-latte');
      assert.equal(lattePreview.counts.themeSaves, 0); assert.equal(readFileSync(config, 'utf8'), originalConfig);
      const lattePaint = await colors('preview-latte-before-enter', dump => expectedThemeColors(terminal, 'preview-latte', dump));
      await terminal.selectTidyItem(latte.label);
      const confirmed = await ready('confirmed', latte.id, 'preview-latte'); assert.equal(confirmed.counts.themeSaves, 1);
      assert.deepEqual(work(confirmed), work(lattePreview), 'confirming the settled preview does not parse it again');
      const confirmedConfig = readFileSync(config, 'utf8');
      assert.deepEqual(JSON.parse(confirmedConfig), { syntaxTheme: { kind: 'occipital', id: latte.id }, unknown: { untouched: true } });
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('second-preview'); await search(mocha.label); await ready('second-preview', mocha.id, 'second-preview');
      phase('back-to-latte'); await terminal.selectTidyItem('Back');
      const back = await ready('back', latte.id, 'back-to-latte');
      assert.equal(back.counts.themeSaves, 1); assert.equal(readFileSync(config, 'utf8'), confirmedConfig);
      await colors('preview-back-to-confirmed', () => themeForegrounds(lattePaint));
      await terminal.closeTidyMenu();

      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      phase('held-preview'); await search(mocha.label); await terminal.event('syntax_preview_reply_held', 2);
      const held = await observe('held'); assert.equal(held.source.globalUnsettledJobs, 2);
      await colors('preview-held-keeps-last-colors', () => themeForegrounds(lattePaint));
      phase('late-rollback'); await terminal.closeTidyMenu();
      const rollback = await observe('late-rollback');
      assert.equal(rollback.client.effective.id, latte.id); assert.equal(rollback.counts.themeSaves, 1);
      writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go');
      const late = await until(async () => {
        const snapshot = await observe(`after-late-${observation++}`);
        return snapshot.client.effective.id === latte.id && snapshot.source.globalUnsettledJobs === 0
          && snapshot.source.staleReplies === rollback.source.staleReplies + 2 ? snapshot : false;
      }, 'held replies retire without replacing the cached rollback');
      assert.equal(late.source.dispatches, held.source.dispatches, 'rollback to the retained Latte result sends no replacement classifications');
      assert.equal(late.source.preparedBytes, held.source.preparedBytes, 'rollback encodes no duplicate source');
      assert.equal(late.source.staleReplies, rollback.source.staleReplies + 2, 'both held replies are retired after rollback');
      await colors('preview-after-late-replies', () => themeForegrounds(lattePaint));
      const final = await terminal.capture('physical-preview-final');
      assert.deepEqual(raw(final), raw(baseline)); assert.deepEqual(body(final), body(baseline));
      assert.deepEqual(readFileSync(session), bytes); assert.equal(traffic(terminal).length, 0);
      assert.equal(readFileSync(config, 'utf8'), confirmedConfig); assert.equal(late.counts.themeSaves, 1);
      const finalWork = work(late);
      for (const [i, width] of [100, 90, 100].entries()) { await terminal.resize(width, 180); await terminal.capture(`physical-preview-final-warm-${i}`); }
      const last = await observe('final-warm'); assert.deepEqual(work(last), finalWork);
      assert.ok(terminal.events().filter(event => event.type === 'syntax_theme_dispatch').every(event => event.jobs <= 2));
      console.log(JSON.stringify({ themePreview: terminal.output, mode, node: last.node, pi: inputs.pi.version,
        previewSaves: preview.counts.themeSaves, confirmedSaves: last.counts.themeSaves, heldReplies: 2, warmDelta: 0 }));
      await terminal.quit('\x04');
      await finish(terminal);
    } finally {
      await runCleanupSteps(() => writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go'),
        () => closeTerminals([terminal]), () => rm(directory, { recursive: true, force: true }));
    }
  });
