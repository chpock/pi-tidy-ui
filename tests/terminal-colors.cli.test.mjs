import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixtures, artifacts, byName, until } from './fixtures/terminal-harness.mjs';
import { closeTerminals, closeTerminalsInParallel } from './fixtures/terminal-cleanup.mjs';
import { colorTerminal, colorTraffic, persisted, selectDarkDark } from './fixtures/main-cli-support.mjs';

test('terminal colors: independent channels, hot reload, source errors, RGB projection, native traffic and replay in both modes', async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = colorTerminal(`colors-live-${mode}`, mode), native = colorTerminal(`colors-native-${mode}`, mode, { native: true, workspace: live.terminal.work });
    let replay;
    try {
      await Promise.all([live.terminal.ready(), native.terminal.ready()]);
      await until(() => live.owned.background === '#123456' && live.owned.foreground === '#eeeeee', 'initial explicit terminal colors');
      const initial = await live.capture('initial'), control = await native.capture('initial');
      assert.equal(initial.diagnostic.status.state, 'on'); assert.equal(initial.automatic, false);
      assert.equal(initial.nativeBackground, '#0a0b0c', 'Pi concrete defaults stay native/stale, not mutated');
      assert.equal(control.nativeBackground, '#0a0b0c'); assert.equal(initial.publicPrototypesUnchanged, true);
      assert.deepEqual(native.owned, {}); assert.equal(initial.belowRows.length, 2);
      const edgeRow = initial.cells.find(row => row.some(cell => cell?.text === '╹'));
      assert.ok(edgeRow); assert.ok(edgeRow.some(cell => cell?.text === '▀' && cell.fg === 0x123456 && cell.fgMode === 0x3000000), 'input edge uses requested default RGB');
      const warm = await live.capture('warm', 'warm');
      assert.deepEqual(warm.diagnostic.counters, initial.diagnostic.counters, '50 real renders do zero file/query/projection/output work');
      assert.deepEqual(warm.before, warm.after); assert.deepEqual(warm.editorRows, initial.editorRows);
      const foreign = await live.capture('foreign', 'foreign-query');
      assert.deepEqual(foreign.report.foreground, { r: 238, g: 238, b: 238 }); assert.deepEqual(foreign.report.background, { r: 18, g: 52, b: 86 });
      assert.deepEqual(foreign.diagnostic.counters, warm.diagnostic.counters); assert.equal(foreign.publicPrototypesUnchanged, true);
      live.source.theme.vars.surface = '#654321'; writeFileSync(live.source.path, '\uFEFF' + JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#654321', 'BOM/export-only same-name native hot reload');
      const hot = await live.capture('hot');
      assert.equal(hot.theme, initial.theme); assert.equal(hot.diagnostic.counters.sourceReads, initial.diagnostic.counters.sourceReads + 1);
      assert.equal(hot.diagnostic.counters.sets, initial.diagnostic.counters.sets + 1); assert.deepEqual(hot.before, hot.after);
      live.source.theme.colors.text = '#abcdef'; live.source.theme.export.pageBg = 'missing-terminal-var';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      let errorIndex = 0;
      const failure = await until(async () => { const snap = await live.capture(`error-${++errorIndex}`); return snap.diagnostic.status.state === 'source error' && snap; }, 'accepted source failure');
      assert.deepEqual(live.owned, { background: '#654321', foreground: '#eeeeee' }, 'whole prior valid snapshot, no partial foreground publication');
      assert.equal(failure.diagnostic.counters.warnings, 1);
      await live.capture('retry', 'colors on');
      const retried = await live.capture('retried'); assert.equal(retried.diagnostic.counters.warnings, 1);
      assert.equal(retried.diagnostic.counters.sourceReads, failure.diagnostic.counters.sourceReads + 1);
      live.source.theme.colors.text = ''; live.source.theme.export.pageBg = '';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => Object.keys(live.owned).length === 0, 'valid empty values release both owned channels');
      const empty = await live.capture('empty'); assert.equal(empty.diagnostic.status.state, 'on');
      assert.equal(empty.diagnostic.counters.releases, retried.diagnostic.counters.releases + 2);
      live.source.theme.colors.text = 'ink'; live.source.theme.vars.ink = 0;
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.foreground === '#000000', 'numeric zero is explicit foreground, not empty'); assert.equal(live.owned.background, undefined);
      live.source.theme.colors.text = '#eeeeee'; live.source.theme.export.pageBg = 'surfaceAlias'; live.source.theme.vars.surface = '#123456';
      writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#123456' && live.owned.foreground === '#eeeeee', 'restore baseline theme');
      const enabled = await live.capture('enabled'); await live.capture('local-off', 'colors off');
      assert.deepEqual(live.owned, {});
      const localOff = await live.capture('local-off-stable');
      assert.deepEqual(localOff.editorRows, enabled.editorRows, 'colors off leaves the editor geometry/styling installed');
      await live.capture('master-off', 'off'); await live.capture('master-on', 'on'); assert.deepEqual(live.owned, {}, 'master on preserves local off');
      await live.capture('local-on', 'colors on'); await until(() => live.owned.background === '#123456', 'local on');
      await live.terminal.command('/reload'); await live.terminal.event('start', 2);
      await until(() => live.terminal.screen().some(row => row.includes('Reloaded keybindings, extensions,')), 'native reload completion before color shortcut capture');
      const reloaded = await live.capture('reloaded'); assert.equal(reloaded.diagnostic.status.state, 'on'); assert.equal(reloaded.publicPrototypesUnchanged, true);
      await live.capture('post-reload-off', 'colors off');
      const released = await live.capture('post-reload-off-stable');
      assert.ok(released.cells.some(row => row.some(cell => cell?.text === '▀' && cell.fg === 0x0a0b0c)), 'local off repairs the input edge after native reload cached our former default');
      await live.capture('post-reload-on', 'colors on'); await until(() => live.owned.background === '#123456', 'reapply after release projection check');
      // Same cwd keeps genuine ENOENT payloads equal; sequential writers avoid sharing an execution race.
      await native.terminal.run('suite'); await live.terminal.run('suite');
      const result = await live.terminal.capture('traffic'), nativeResult = await native.terminal.capture('traffic');
      assert.deepEqual(colorTraffic(live.terminal), colorTraffic(native.terminal));
      assert.deepEqual(persisted(result), persisted(nativeResult));
      const edit = byName(result, 'edit')[0]; assert.ok(edit.lines.some(row => row.includes('\x1b[48;2;15;52;72m') && row.includes('WRITE_AFTER')), 'diff Multiply code tint uses actual requested background');
      assert.ok(result.cells.some(row => row.some(cell => cell?.text === 'W' && cell.bg === 0x0f3448)), 'the controlled physical screen contains the new tint');
      live.source.theme.export.pageBg = ''; writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === undefined, 'unowned background on existing diff');
      await live.capture('unowned-warm', 'warm');
      live.profile.background = '#f0f0f0'; await live.capture('unowned-refresh', 'colors on');
      await until(() => live.terminal.captureScreen('unowned-physical', {}).cells.some(row => row.some(cell => cell?.text === 'W' && cell.bg === 0xcaf0ca)), 'late reported defaults repaint existing physical diff without a native theme change');
      live.source.theme.export.pageBg = 'surfaceAlias'; writeFileSync(live.source.path, JSON.stringify(live.source.theme));
      await until(() => live.owned.background === '#123456', 'restore requested replay background');
      const bytes = readFileSync(result.session, 'utf8');
      replay = colorTerminal(`colors-replay-${mode}`, mode, { session: result.session, workspace: live.terminal.work });
      await replay.terminal.ready(); await until(() => replay.owned.background === '#123456', 'replay applies fixed theme');
      const restored = await replay.terminal.capture('replay');
      assert.deepEqual(persisted(restored), persisted(result)); assert.equal(readFileSync(result.session, 'utf8'), bytes, 'presentation and replay do not rewrite session bytes');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.terminal.events().filter(event => event.type === type).length, 0);
      assert.ok(byName(restored, 'edit')[0].lines.some(row => row.includes('\x1b[48;2;15;52;72m') && row.includes('WRITE_AFTER')));
      writeFileSync(join(live.terminal.output, 'color-evidence.json'), JSON.stringify({ initial, hot, failure, empty, protocol: live.protocol }, null, 2));
      await live.terminal.quit();
      assert.deepEqual(live.owned, {}, 'normal shutdown restores only our applied defaults');
    } finally {
      await closeTerminalsInParallel([live.terminal, native.terminal, ...(replay ? [replay.terminal] : [])]);
    }
  }
});

test('terminal colors: trusted project override, native fixed-to-auto ordering, reload and renderer switch stay inactive', async () => {
  for (const mode of ['fullscreen', 'regular']) {
    const live = colorTerminal(`colors-auto-${mode}`, mode, { project: true });
    try {
      await live.terminal.ready();
      const before = await live.capture('before'); assert.equal(before.diagnostic.status.state, 'on');
      assert.ok(Object.keys(live.owned).length > 0, 'positive fixed-theme activation');
      live.protocol.length = 0; await selectDarkDark(live.terminal);
      const after = await live.capture('auto'); assert.equal(after.configured, 'dark'); assert.equal(after.theme, 'dark'); assert.equal(after.automatic, true);
      assert.equal(after.diagnostic.status.state, 'automatic theme'); assert.deepEqual(live.owned, {});
      const firstQuery = live.protocol.findIndex(event => event.query);
      assert.ok(firstQuery >= 0); assert.ok(live.protocol.findIndex(event => event.reset === 'background') < firstQuery);
      assert.ok(live.protocol.filter(event => event.query).every(event => event.value === live.profile[event.query]), 'Pi only sees profile defaults');
      const stable = await live.capture('auto-warm', 'warm'); assert.deepEqual(stable.diagnostic.counters, after.diagnostic.counters);
      const scopeStart = live.protocol.length;
      await live.terminal.command('/reload'); await live.terminal.event('start', 2); await live.terminal.settle();
      const reloaded = await live.capture('auto-reloaded');
      assert.equal(reloaded.automatic, true); assert.equal(reloaded.diagnostic.counters.sourceReads, 0);
      assert.equal(reloaded.diagnostic.counters.sets, 0); assert.equal(reloaded.diagnostic.counters.releases, 0); assert.equal(reloaded.diagnostic.counters.reports, 0);
      await live.terminal.command('/settings'); live.terminal.send('TUI mode'); await live.terminal.settle(); live.terminal.send('\r'); await live.terminal.settle(); live.terminal.send('\x1b'); await live.terminal.settle();
      const swapped = await live.capture('auto-swapped'); assert.equal(swapped.automatic, true);
      assert.equal(swapped.diagnostic.counters.sourceReads, 0); assert.equal(swapped.diagnostic.counters.sets, 0);
      assert.equal(swapped.diagnostic.counters.releases, 0); assert.equal(swapped.diagnostic.counters.reports, 0);
      assert.ok(live.protocol.slice(scopeStart).every(event => !event.set && !event.reset), 'no transient activation during reload or renderer replacement');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(live.terminal.events().filter(event => event.type === type).length, 0);
    } finally { await closeTerminals([live.terminal]); }
  }
});

test('terminal colors: initially automatic and first production late load stay inactive without prior observation', async () => {
  const inactive = async (live, label) => {
    const packet = await live.capture(label);
    assert.equal(packet.automatic, true, 'real native automatic tracking is positively active');
    assert.equal(packet.diagnostic.status.state, 'automatic theme');
    for (const field of ['sourceReads', 'reports', 'sets', 'releases', 'packets', 'warnings', 'projections', 'staleReplies']) assert.equal(packet.diagnostic.counters[field], 0, `${label} ${field}`);
    assert.deepEqual(live.protocol.filter(event => event.set || event.reset), [], 'no transient applications or resets');
    assert.equal(live.terminal.events().filter(event => ['call', 'result', 'model_context', 'provider_error'].includes(event.type)).length, 0);
    const before = packet.diagnostic.counters, warm = await live.capture(`${label}-warm`, 'warm');
    assert.deepEqual(warm.diagnostic.counters, before, 'warm native frames add no feature work');
    return packet;
  };
  for (const mode of ['fullscreen', 'regular']) {
    const cold = colorTerminal(`colors-cold-auto-${mode}`, mode, { automatic: true });
    try { await cold.terminal.ready(); await inactive(cold, 'cold-auto'); }
    finally { await closeTerminals([cold.terminal]); }
    for (const project of [false, true]) {
      const loader = join(artifacts, `colors-first-late-${mode}-${project}.ts`);
      const importDriver = `import driver from ${JSON.stringify(join(fixtures, 'terminal-colors-driver.ts'))};\n`;
      writeFileSync(loader, importDriver + 'export default async function(pi) { process.env.TIDY_UI_TEST_COLORS_NATIVE = "1"; await driver(pi); }\n');
      const late = colorTerminal(`colors-first-late-${mode}-${project}`, mode, { automatic: !project, project, driver: loader });
      try {
        await late.terminal.ready();
        const noFeature = await late.capture('before-first-load'); assert.equal(noFeature.diagnostic, undefined);
        assert.deepEqual(late.protocol.filter(event => event.set || event.reset), []);
        if (project) await selectDarkDark(late.terminal);
        const nativeAuto = await late.capture('native-auto-before-load');
        assert.equal(nativeAuto.automatic, true); assert.equal(nativeAuto.configured, project ? 'dark' : 'dark/dark');
        // Introduce the production import/factory for the first time, not a re-enabled warm observer.
        writeFileSync(loader, importDriver + 'export default async function(pi) { delete process.env.TIDY_UI_TEST_COLORS_NATIVE; await driver(pi); }\n');
        await late.terminal.command('/reload'); await late.terminal.event('start', 2);
        const first = await inactive(late, 'first-production-load');
        assert.equal(first.configured, project ? 'dark' : 'dark/dark', 'hidden project divergence remains real');
      } finally { await closeTerminals([late.terminal]); }
    }
  }
});

for (const mode of ['fullscreen', 'regular']) {
  test(`session transitions: terminal defaults survive new, resume, fork and reload without reset/reapply (${mode})`, async () => {
    const live = colorTerminal(`colors-transitions-${mode}`, mode);
    try {
      await live.terminal.ready(); await live.terminal.run('suite');
      const initial = await live.terminal.capture('original-session'), bytes = readFileSync(initial.session);
      const calls = colorTraffic(live.terminal), expected = { background: '#123456', foreground: '#eeeeee' };
      assert.deepEqual(live.owned, expected);
      const boundary = live.protocol.length;
      const move = async (kind, data) => {
        await live.terminal.clearDraft();
        const count = live.terminal.events().filter(e => e.type === 'start').length;
        writeFileSync(join(live.terminal.output, 'transition-request.json'), JSON.stringify(data ?? {}));
        await live.terminal.command(kind === 'new' ? '/new' : kind === 'reload' ? '/reload' : `/tidy-ui-transition ${kind}`);
        await live.terminal.event('start', count + 1);
        const packet = await live.capture(`after-${kind}-${count}`);
        assert.equal(packet.diagnostic.status.state, 'on'); assert.deepEqual(live.owned, expected);
        assert.deepEqual(live.protocol.slice(boundary).filter(e => e.set || e.reset), [], `${kind}: no color flash or duplicate OSC set`);
      };
      await move('new'); await move('resume', { session: initial.session });
      const restored = await live.terminal.capture('resumed-session');
      assert.deepEqual(persisted(restored), persisted(initial));
      const user = initial.branch.find(e => e.type === 'message' && e.message.role === 'user'); assert.ok(user);
      await move('fork', { entry: user.id });
      await move('reload');
      assert.deepEqual(colorTraffic(live.terminal), calls, 'session transitions never execute saved tools/model requests');
      assert.deepEqual(readFileSync(initial.session), bytes, 'original saved history is not rewritten');
      await live.terminal.quit(); assert.deepEqual(live.owned, {}, 'quit releases both channels');
    } finally { await closeTerminals([live.terminal]); }
  });

  test(`session transitions: a reload into automatic mode releases inherited colors before native queries (${mode})`, async () => {
    const live = colorTerminal(`colors-transition-auto-${mode}`, mode);
    try {
      await live.terminal.ready(); await live.capture('fixed-before-handoff');
      assert.deepEqual(live.owned, { background: '#123456', foreground: '#eeeeee' });
      const boundary = live.protocol.length, settingsFile = join(live.terminal.agent, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')); settings.theme = 'dark/dark';
      writeFileSync(settingsFile, JSON.stringify(settings));
      await live.terminal.command('/reload');
      const automatic = await live.capture('automatic-after-handoff');
      assert.equal(automatic.automatic, true); assert.deepEqual(live.owned, {});
      const protocol = live.protocol.slice(boundary), query = protocol.findIndex(e => e.query);
      assert.ok(query >= 0); assert.ok(protocol.findIndex(e => e.reset === 'background') < query);
      assert.ok(protocol.filter(e => e.query).every(e => e.value === live.profile[e.query]), 'auto selection sees profile defaults, not outgoing overrides');
      await live.terminal.quit(); assert.deepEqual(live.owned, {});
    } finally { await closeTerminals([live.terminal]); }
  });

  test(`session transitions: disabling the extension on reload leaves native UI and process-exit color cleanup (${mode})`, async () => {
    const loader = join(artifacts, `colors-unload-${mode}.ts`), imported = `import driver from ${JSON.stringify(join(fixtures, 'terminal-colors-driver.ts'))};\n`;
    writeFileSync(loader, imported + 'export default async function(pi) { await driver(pi); }\n');
    const live = colorTerminal(`colors-unload-${mode}`, mode, { driver: loader });
    try {
      await live.terminal.ready(); await live.terminal.run('suite');
      const before = await live.terminal.capture('before-unload'), boundary = live.protocol.length;
      assert.ok(byName(before, 'read').some(t => t.lines.some(row => row.includes('→'))));
      writeFileSync(loader, imported + 'export default async function(pi) { process.env.TIDY_UI_TEST_COLORS_NATIVE = "1"; await driver(pi); }\n');
      await live.terminal.command('/reload'); await live.terminal.event('start', 2);
      live.terminal.send('\x0f'); await live.terminal.settle();
      const after = await live.terminal.capture('after-unload'), color = await live.capture('unloaded-colors');
      assert.equal(color.diagnostic, undefined, 'no successor tidy-ui is loaded');
      assert.ok(byName(after, 'read').some(t => t.lines.join('\n').includes('READ_A_CONTENT')), 'stock Pi can render its original tools');
      assert.deepEqual(persisted(after), persisted(before));
      assert.deepEqual(live.protocol.slice(boundary).filter(e => e.set || e.reset), []);
      assert.deepEqual(live.owned, { background: '#123456', foreground: '#eeeeee' });
      await live.terminal.quit(); assert.deepEqual(live.owned, {}, 'owner-free exit cleanup runs without a successor');
    } finally { await closeTerminals([live.terminal]); }
  });
}

for (const mode of ['fullscreen', 'regular']) test(`terminal repaint: on/off redraws unchanged visible rows (${mode})`, async () => {
  const live = colorTerminal(`colors-repaint-${mode}`, mode);
  const marker = 'UNCHANGED_TERMINAL_BACKGROUND_PROBE';
  try {
    await live.terminal.ready();
    await live.capture('probe', 'repaint-probe');
    const initial = await live.capture('baseline');
    assert.ok(live.terminal.screen().some(row => row.includes(marker)));
    let previous = initial;
    for (const enabled of [false, true]) {
      await live.terminal.openTidyMenu();
      const boundary = live.terminal.raw.length;
      await live.terminal.selectTidyItem('Set terminal colors from Pi theme');
      await live.terminal.settle();
      const output = Buffer.concat(live.terminal.raw.slice(boundary)).toString('utf8');
      assert.ok(output.includes(marker), 'unchanged visible row is physically rewritten without waiting for unrelated updates');
      await live.terminal.closeTidyMenu();
      const current = await live.capture(enabled ? 'on' : 'off');
      assert.ok(current.fullRedraws > previous.fullRedraws, 'native TUI performed a full redraw');
      assert.deepEqual(live.owned, enabled ? { background: '#123456', foreground: '#eeeeee' } : {});
      assert.deepEqual(current.before, current.after);
      previous = current;
    }
    const warm = await live.capture('warm', 'warm');
    assert.equal(warm.fullRedraws, previous.fullRedraws, 'unchanged frames do not force new redraws');
    assert.deepEqual(warm.diagnostic.counters, previous.diagnostic.counters);
    assert.equal(live.terminal.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
  } finally { await closeTerminals([live.terminal]); }
});

test('terminal repaint: regular render-time suspension keeps physical rows in place', async () => {
  const live = colorTerminal('colors-repaint-reentrant', 'regular');
  try {
    await live.terminal.ready(); await live.capture('probe', 'repaint-probe');
    const before = live.terminal.screen();
    await live.capture('foreign-render', 'foreign-render-enable');
    assert.deepEqual(live.owned, {}, 'cooperating native appearance tracking releases applied defaults');
    assert.deepEqual(live.terminal.screen(), before, 'render-time suspension does not append, duplicate or shift the UI');
  } finally { await closeTerminals([live.terminal]); }
});
