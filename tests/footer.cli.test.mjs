import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PiTerminal, fixtures, artifacts, plain, assertFits, until } from './fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from './fixtures/terminal-cleanup.mjs';
import { childEnv, toolPath } from '../scripts/test/context.mjs';
import { referenceCell, traffic, footerObserve, footerPhysical, persisted } from './fixtures/main-cli-support.mjs';

test('right-aligned cwd and live Git branch preserve colors padding and zero hot-frame queries', {}, async () => {
  const terminals = [], base = mkdtempSync(join(tmpdir(), 'tidy-ui-cwd-cli-'));
  const branchPublished = (terminal, branch) => terminal.waitForScreen(
    rows => rows.some(row => row.trimEnd().endsWith(':' + branch)), 'published Git branch after installation');
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action })); terminal.send('\x1b\x04');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `directory ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before); return terminal.captureScreen(name, dump);
  };
  const check = async (dump, { full = false, branch, name, displayedCwd = dump.cwd } = {}) => {
    assert.equal(dump.statusRows.length, 2); await assertFits(dump.statusRows, dump.width);
    const edge = dump.screen.findIndex(row => row.includes('╹▀')), y = edge - 1;
    assert.ok(y >= 0); const text = dump.screen[y].trimEnd(), cells = dump.cells[y];
    assert.equal(text, plain(dump.statusRows[0]), 'actual physical metadata row equals current component output');
    assert.equal(cells[dump.width - 2].text, ' ', 'exactly one painted right-padding cell');
    assert.equal(cells[dump.width - 1].bgMode, 0, 'exterior Editor padding remains unpainted');
    const bg = await referenceCell(dump.styles.background);
    assert.equal(cells[dump.width - 2].bg, bg.bg);
    assert.equal(cells[dump.width - 2].bgMode, bg.bgMode);
    const fg = async (start, count, style) => {
      const reference = await referenceCell(style);
      for (let x = start; x < start + count; x++) { assert.equal(cells[x].fg, reference.fg); assert.equal(cells[x].fgMode, reference.fgMode); }
    };
    if (full) {
      const right = displayedCwd + (branch ? ':' + branch : '');
      assert.ok(text.endsWith(right), 'display-only cwd and actual named branch are right-aligned');
      const start = dump.width - 2 - visibleWidth(right), nameX = start + visibleWidth(displayedCwd.slice(0, -name.length));
      assert.equal(cells[dump.width - 3].text, [...(branch || name)].at(-1) === '\u0301' ? 'é' : [...(branch || name)].at(-1));
      await fg(start, nameX - start, dump.styles.parent);
      await fg(nameX, visibleWidth(name), dump.styles.directory);
      if (branch) { const colon = nameX + visibleWidth(name); await fg(colon, 1, dump.styles.colon); await fg(colon + 1, visibleWidth(branch), dump.styles.branch); }
      assert.ok(text.slice(0, start).endsWith('  '), 'at least two spaces separate left and right');
    } else if (dump.width >= 60) assert.ok(text.includes(name), 'complete last directory outranks branch at medium width');
    assert.ok(!text.includes('Working'), 'activity is never budgeted into metadata');
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const repo = join(base, mode), name = 'important-界é', workspace = join(repo, 'parent', name);
      mkdirSync(workspace, { recursive: true });
      const git = (...args) => { const result = spawnSync(toolPath('git'), ['-C', repo, ...args], { encoding: 'utf8', env: childEnv(base) }); assert.equal(result.status, 0, result.stderr); };
      let branch = 'feature/input-status'; git('init', '-b', branch);
      const terminal = new PiTerminal(`cwd-${mode}`, { mode, workspace, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(220);
      await branchPublished(terminal, branch);
      let dump = await observe(terminal, 'full'); await check(dump, { full: true, branch, name });
      assert.equal(dump.cwd, workspace); assert.ok(dump.git.watchers >= 2);
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await check(dump, { full: true, branch, name }); }
      const baseline = dump.git;
      for (let i = 0; i < 3; i++) { dump = await observe(terminal, `hot-${i}`); assert.equal(dump.git.queries, baseline.queries); assert.equal(dump.git.spawned, baseline.spawned); }
      for (const width of [100, 60, 24, 220]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await check(dump, { full: width === 220, branch, name }); }
      branch = 'external-next'; git('symbolic-ref', 'HEAD', 'refs/heads/' + branch); await terminal.settle();
      let external = 0;
      dump = await until(async () => {
        const value = await observe(terminal, `external-branch-${external++}`);
        return value.git.activeJobs === 0 && plain(value.statusRows[0] || '').includes(':' + branch) ? value : false;
      }, 'Git watch publishes external branch before physical capture');
      await check(dump, { full: true, branch, name });
      assert.ok(dump.git.branchReads > baseline.branchReads, 'external atomic HEAD mutation refreshes Git snapshot');
      terminal.send('/tidy-ui-d'); await terminal.settle(); dump = await observe(terminal, 'menu'); assert.deepEqual(dump.statusRows, []);
      await terminal.clearDraft();
      terminal.send('run pending\r'); await terminal.event('provider_gate');
      dump = await observe(terminal, 'busy'); const busy = dump.git;
      for (let i = 0; i < 3; i++) {
        await terminal.observeAnimation();
        dump = await observe(terminal, `busy-hot-${i}`); await check(dump, { full: true, branch, name });
        assert.equal(dump.git.queries, busy.queries); assert.equal(dump.git.spawned, busy.spawned);
        assert.ok(!dump.screen.some(row => row.includes(' • Idle'))); assert.ok(dump.screen.some(row => row.includes('Working')));
      }
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end');
      const complete = await terminal.capture('directory-traffic'); assert.equal(complete.tools.length, 2);
      dump = await observe(terminal, 'idle-after-operations'); await check(dump, { full: true, branch, name });
      assert.ok(dump.screen.some(row => row.includes(' • Idle')));
      const off = await observe(terminal, 'off', 'off'); assert.deepEqual(off.statusRows, []);
      assert.equal(off.git.watchers, 0); assert.equal(off.git.activeJobs, 0);
      dump = await observe(terminal, 'on', 'on'); await branchPublished(terminal, branch); dump = await observe(terminal, 'on-ready'); await check(dump, { full: true, branch, name });
      await terminal.command('/reload'); await terminal.event('start', 2); await branchPublished(terminal, branch); dump = await observe(terminal, 'reload'); await check(dump, { full: true, branch, name });
      const native = new PiTerminal(`cwd-native-${mode}`, { mode, workspace }); terminals.push(native); await native.ready();
      native.send('run pending\r'); await native.event('provider_gate'); writeFileSync(join(native.output, 'provider-go'), 'go'); await native.event('tool_gate');
      writeFileSync(join(native.output, 'tool-go'), 'go'); await native.event('agent_end');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'cwd/status presentation leaves model traffic unchanged');
      const replay = new PiTerminal(`cwd-replay-${mode}`, { mode, workspace, session: terminal.session,
        agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready(); await replay.resize(220);
      await branchPublished(replay, branch);
      const replayDump = await observe(replay, 'replay'); await check(replayDump, { full: true, branch, name });
      const persisted = await replay.capture('replay-traffic'); assert.deepEqual(persisted.branch, complete.branch);
      rmSync(join(repo, '.git'), { recursive: true }); await terminal.settle();
      let removed = 0;
      dump = await until(async () => {
        const value = await observe(terminal, `no-repository-${removed++}`);
        return value.git.activeJobs === 0 && plain(value.statusRows[0] || '').endsWith(value.cwd) ? value : false;
      }, 'repository removal clears branch before physical capture');
      await check(dump, { full: true, name });
      assert.ok(!dump.screen.some(row => row.endsWith(':' + branch)), 'no stale branch after repository removal');
      writeFileSync(join(terminal.output, 'git-counters.json'), JSON.stringify({ warm: baseline, busy: busy, final: dump.git }, null, 2));

      const homeTerminal = new PiTerminal(`cwd-home-${mode}`, { mode, agentSettings: { editorPaddingX: 1 },
        extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(homeTerminal);
      assert.equal(spawnSync(toolPath('git'), ['-C', homeTerminal.work, 'init', '-b', 'home-main'], { env: childEnv(homeTerminal.temp) }).status, 0);
      await homeTerminal.ready(); await homeTerminal.resize(220);
      await branchPublished(homeTerminal, 'home-main');
      const homeCheck = async (name, action = 'snapshot', full = true) => {
        const value = await observe(homeTerminal, name, action);
        assert.equal(value.home, homeTerminal.temp, 'formatter reads the actual isolated process HOME');
        assert.equal(value.cwd, homeTerminal.work, 'context and Git retain the real absolute directory');
        await check(value, { full, branch: 'home-main', name: 'work', displayedCwd: '~/work' });
        return value;
      };
      const homeBaseline = (await homeCheck('home-full')).git;
      for (const action of ['light', 'dark']) await homeCheck('home-' + action, action);
      for (const width of [100, 60, 24, 220]) {
        await homeTerminal.resize(width); await homeCheck('home-width-' + width, 'snapshot', width === 220);
      }
      for (let i = 0; i < 3; i++) {
        const value = await homeCheck('home-hot-' + i);
        assert.equal(value.git.queries, homeBaseline.queries); assert.equal(value.git.spawned, homeBaseline.spawned);
      }
      const homeOff = await observe(homeTerminal, 'home-off', 'off'); assert.deepEqual(homeOff.statusRows, []);
      await observe(homeTerminal, 'home-on', 'on'); await branchPublished(homeTerminal, 'home-main'); await homeCheck('home-on-ready');
      await homeTerminal.command('/reload'); await homeTerminal.event('start', 2); await branchPublished(homeTerminal, 'home-main'); await homeCheck('home-reload');
      assert.equal(homeTerminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      writeFileSync(join(homeTerminal.output, 'home-cwd-coverage.json'), JSON.stringify({ cwd: homeTerminal.work, home: homeTerminal.temp,
        displayedCwd: '~/work', warm: homeBaseline, final: (await homeCheck('home-final')).git, traffic: 0 }, null, 2));
    }
  } finally { await runCleanupSteps(() => closeTerminals(terminals), () => rmSync(base, { recursive: true, force: true })); }
});

test('footer whole-status fitting colors native data warm counters ownership and replay in both modes', {}, async () => {
  const terminals = [], observations = [];
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const options = { mode, extraEnv: { TIDY_UI_TEST_FOOTER: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] };
      const native = new PiTerminal(`footer-native-${mode}`, options); terminals.push(native); await native.ready();
      await native.run('future'); const nativeTraffic = await native.capture('traffic');
      const control = await footerObserve(native, 'accounting', 'accounting'); assert.equal(control.owner, 'FooterComponent');
      const live = new PiTerminal(`footer-live-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, workspace: native.work }); terminals.push(live); await live.ready();
      await live.run('future'); const liveTraffic = await live.capture('traffic');
      const packet = await footerObserve(live, 'accounting', 'accounting');
      assert.equal(packet.owner, 'FooterView'); footerPhysical(packet);
      const usage = dump => dump.entries.flatMap(e => e.type === 'usage' ? [e.usage] : e.type === 'message' && e.message.role === 'assistant' ? [e.message.usage] : []);
      assert.deepEqual(usage(packet), usage(control), 'identical actual persisted usage for native and pi-tidy-ui');
      assert.deepEqual(packet.context, control.context, 'same native current context estimate');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      assert.deepEqual(live.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)), native.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)));
      assert.equal(live.events().filter(e => e.type === 'call').length, 1); assert.equal(live.events().filter(e => e.type === 'result').length, 1);
      const bytes = readFileSync(packet.session);
      let dump = await footerObserve(live, 'statuses', 'statuses'); footerPhysical(dump);
      for (const width of [24, 60, 100, 140]) {
        await live.resize(width); dump = await footerObserve(live, `width-${width}`); const y = footerPhysical(dump);
        const text = dump.rows.map(plain).join('\n');
        for (const [, value] of dump.statuses) assert.ok(text.includes(plain(value)), 'ordinary status is never broken or truncated merely for leftover space');
        for (const row of dump.rows.map(plain)) assert.ok(!/^\s*•|•\s*$/u.test(row), 'no separator at row break');
        if (width === 140) {
          assert.equal(dump.rows.length, 1); const row = dump.screen[y];
          assert.ok(row.endsWith('OTHER_STATUS'), 'right edge is fully aligned');
          const refs = Object.fromEntries(await Promise.all(Object.entries(dump.styles).map(async ([role, style]) => [role, await referenceCell(style)])));
          const check = (value, role, offset = 0, count = value.length - offset) => {
            const x = row.indexOf(value); assert.ok(x >= 0, value);
            for (let i = x + offset; i < x + offset + count; i++) { const cell = dump.cells[y][i]; assert.equal(cell.fgMode, refs[role].fgMode, value); assert.equal(cell.fg, refs[role].fg, value); }
          };
          assert.doesNotMatch(row, /↑|↓|R243|W\d|\$|\(sub\)|\(auto\)/u);
          check('272k', 'muted'); check('········', 'muted'); check('▂▂', 'warning'); check('[', 'dim'); check(']', 'dim');
          const context = /^\[[^\]]{10}\] CH86\.4% • (\d+k\/272k) \(/u.exec(row); assert.ok(context); check(context[1], 'text', 0, context[1].indexOf('/'));
          check('/', 'dim'); check('(', 'dim'); check(')', 'dim'); check('CH86.4%', 'warning'); check(' • ', 'dim');
          const producer = 'mc: 104.5K (51%) · idle'; check(producer, 'success');
          const separator = row.indexOf(' • ', row.indexOf(producer) + producer.length);
          assert.ok(separator > row.indexOf(producer), 'check the producer separator independently of the statistics bullet');
          for (let i = separator; i < separator + 3; i++) {
            const cell = dump.cells[y][i]; assert.equal(cell.fgMode, refs.dim.fgMode); assert.equal(cell.fg, refs.dim.fg);
            assert.equal(cell.bgMode, 0); assert.ok(!cell.bold && !cell.italic && !cell.underline && !cell.inverse);
          }
          const other = row.indexOf('OTHER_STATUS'); assert.ok(dump.cells[y][other].bold, 'producer attributes remain unchanged');
        }
      }
      for (const action of ['light', 'dark']) { dump = await footerObserve(live, action, action); footerPhysical(dump); }
      dump = await footerObserve(live, 'long', 'long'); await live.resize(24); dump = await footerObserve(live, 'long-narrow'); footerPhysical(dump);
      const long = dump.rows.map(plain).filter(row => row.includes('LONG_STATUS_')); assert.equal(long.length, 1); assert.ok(long[0].endsWith('…'));
      dump = await footerObserve(live, 'delete', 'delete'); assert.ok(!dump.rows.map(plain).join('\n').includes('OTHER_STATUS'));
      dump = await footerObserve(live, 'clear', 'clear'); assert.ok(!dump.rows.map(plain).join('\n').includes('LONG_STATUS_'));
      await live.resize(100);
      for (const enabled of [false, true]) {
        const before = await footerObserve(live, `auto-before-${enabled}`);
        await live.command('/settings'); live.send('Auto-compact'); await live.settle();
        assert.ok(live.screen().some(row => row.includes('Auto-compact')), 'actual native settings row is selected');
        live.send('\r\x1b'); await live.settle();
        const changed = await footerObserve(live, `auto-${enabled}`); footerPhysical(changed);
        assert.equal(changed.rows.map(plain).join('\n').includes('(auto off)'), !enabled, 'native auto setting changes footer warning without reload');
        assert.ok(!changed.rows.map(plain).join('\n').includes('(auto)'), 'enabled auto no longer adds noise');
        if (!enabled) {
          const y = footerPhysical(changed), x = changed.screen[y].indexOf('(auto off)'); assert.ok(x >= 0);
          const warning = await referenceCell(changed.styles.warning), dim = await referenceCell(changed.styles.dim);
          for (let i = 0; i < '(auto off)'.length; i++) { const ref = i === 0 || i === 9 ? dim : warning; assert.equal(changed.cells[y][x + i].fg, ref.fg); }
        }
        for (const key of ['scans', 'contextReads', 'aggregations', 'entries']) assert.equal(changed.counters[key], before.counters[key], 'auto is presentation-only, not a history/context invalidation');
      }
      assert.deepEqual(readFileSync(packet.session), bytes, 'status/theme/resize/settings actions do not rewrite saved usage or session data');
      await live.appearance(false); dump = await footerObserve(live, 'off'); assert.equal(dump.owner, 'FooterComponent');
      assert.ok(dump.rows.some(row => plain(row).includes(live.work)), 'off restores native cwd');
      await live.appearance(true); dump = await footerObserve(live, 'on'); assert.equal(dump.owner, 'FooterView'); footerPhysical(dump);
      dump = await footerObserve(live, 'foreign', 'foreign'); await live.appearance(false); dump = await footerObserve(live, 'foreign-off');
      assert.deepEqual(dump.rows, ['FOREIGN_FOOTER']); assert.equal(dump.foreignDisposals, 0, 'off never removes a later owner'); footerPhysical(dump);
      await live.appearance(true); dump = await footerObserve(live, 'reclaimed'); assert.equal(dump.owner, 'FooterView'); assert.equal(dump.foreignDisposals, 1);
      await live.command('/reload'); dump = await footerObserve(live, 'reloaded', 'accounting'); assert.equal(dump.owner, 'FooterView');
      assert.deepEqual(usage(dump), usage(packet), 'reload never duplicates fixture side usage'); footerPhysical(dump);
      const warm = await footerObserve(live, 'warm');
      for (let i = 0; i < 8; i++) { const next = await footerObserve(live, `warm-${i}`); assert.deepEqual(next.counters, warm.counters, 'warm frames reuse stats/context/layout with zero scans'); }
      const replay = new PiTerminal(`footer-replay-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, session: packet.session, workspace: live.work }); terminals.push(replay); await replay.ready();
      const resumed = await footerObserve(replay, 'accounting', 'accounting'); footerPhysical(resumed);
      assert.deepEqual(usage(resumed), usage(packet)); assert.deepEqual(resumed.rows, dump.rows, 'same usage/context presentation in live reload and saved replay');
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0, 'replay executes no tools or provider requests');
      observations.push({ mode, warm: warm.counters, nativeContext: control.context, replayContext: resumed.context });
    }
    writeFileSync(join(artifacts, 'footer-counters.json'), JSON.stringify(observations, null, 2));
  } finally { await closeTerminals(terminals); }
});

test('footer session name fills spare columns without repacking statuses and restores saved metadata', {}, async () => {
  const terminals = [], observations = [];
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const options = { mode, extraEnv: { TIDY_UI_TEST_FOOTER: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] };
      const native = new PiTerminal(`footer-name-native-${mode}`, options); terminals.push(native); await native.ready();
      await native.run('future'); const nativeTraffic = await native.capture('traffic');
      const nativeName = await footerObserve(native, 'named', { action: 'name', sessionName: 'SESSION' });
      const live = new PiTerminal(`footer-name-live-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, workspace: native.work });
      terminals.push(live); await live.ready(); await live.run('future');
      const traffic = await live.capture('traffic');
      assert.deepEqual(persisted(traffic), persisted(nativeTraffic));
      const trafficKinds = ['call', 'result', 'model_context'];
      assert.deepEqual(live.events().filter(e => trafficKinds.includes(e.type)), native.events().filter(e => trafficKinds.includes(e.type)));
      assert.equal(live.events().filter(e => e.type === 'call').length, 1);
      assert.equal(live.events().filter(e => e.type === 'result').length, 1);
      await live.command('/resume');
      await live.waitForScreen(rows => rows.some(row => /› .*run future/u.test(row)), 'loaded native resume picker');
      assert.ok(live.screen().some(row => /› .*run future/u.test(row)), 'actual native resume picker uses the first user message without an explicit name');
      live.captureScreen('native-resume-first-message', {});
      live.send('\x1b'); await live.settle();
      let empty = await footerObserve(live, 'empty'); footerPhysical(empty);
      const fallback = ' • run future';
      assert.ok(plain(empty.rows[0]).endsWith(fallback), 'default footer label matches the real native resume picker');
      const stats = plain(empty.rows[0]).slice(0, -fallback.length), statsWidth = visibleWidth(stats);
      const changed = await footerObserve(live, 'named', { action: 'name', sessionName: 'SESSION' });
      assert.equal(plain(changed.rows[0]), stats + ' • SESSION'); footerPhysical(changed);
      for (const key of ['scans', 'contextReads', 'aggregations', 'entries']) assert.equal(changed.counters[key], empty.counters[key], 'rename updates no usage/context work');
      assert.equal(changed.nameActionReads, nativeName.nameActionReads, 'same synchronous name reads as the actual native rename control');
      assert.equal(changed.counters.nameReads, empty.counters.nameReads + nativeName.nameActionReads + 1, 'one saved-name lookup at the metadata boundary beyond measured native rename work');
      let statuses = await footerObserve(live, 'statuses', 'statuses');
      const firstStatus = plain(statuses.statuses.find(([key]) => key === 'a-probe')[1]);
      const allRight = firstStatus + ' • OTHER_STATUS';
      for (const [gap, expected] of [[15, ' • SESSION     '], [13, ' • SESSION • '], [12, ' • SESSI… • '], [11, ' '.repeat(11)]]) {
        await live.resize(statsWidth + visibleWidth(allRight) + gap);
        const named = await footerObserve(live, `gap-${gap}`); footerPhysical(named);
        assert.deepEqual(named.rows.map(plain), [stats + expected + allRight]);
        const cleared = await footerObserve(live, `gap-${gap}-clear`, { action: 'name', sessionName: '' });
        assert.equal(cleared.rows.length, named.rows.length);
        assert.equal(plain(cleared.rows[0]).indexOf(firstStatus), plain(named.rows[0]).indexOf(firstStatus), 'name never changes producer x');
        assert.deepEqual(cleared.rows.slice(1), named.rows.slice(1));
        await footerObserve(live, `gap-${gap}-restore`, { action: 'name', sessionName: 'SESSION' });
      }
      await live.resize(statsWidth + 10);
      const overflow = await footerObserve(live, 'overflow'); footerPhysical(overflow);
      assert.equal(plain(overflow.rows[0]), stats + ' • SESSION', 'statuses on later rows do not add a trailing separator');
      const noName = await footerObserve(live, 'overflow-clear-name', { action: 'name', sessionName: '' });
      assert.deepEqual(noName.rows.slice(1), overflow.rows.slice(1));
      await footerObserve(live, 'clear-statuses', 'clear');
      await live.resize(statsWidth + 9);
      let unicode = await footerObserve(live, 'unicode-hidden', { action: 'name', sessionName: '界界界界' });
      assert.deepEqual(unicode.rows.map(plain), [stats], 'five available prefix columns retaining four CJK columns are hidden');
      await live.resize(statsWidth + 10); unicode = await footerObserve(live, 'unicode-shown');
      assert.equal(plain(unicode.rows[0]), stats + ' • 界界界…'); footerPhysical(unicode);
      await live.resize(statsWidth + 4);
      const short = await footerObserve(live, 'short', { action: 'name', sessionName: 'X' });
      assert.equal(plain(short.rows[0]), stats + ' • X'); footerPhysical(short);
      await live.resize(100);
      await footerObserve(live, 'color-statuses', 'statuses');
      await footerObserve(live, 'color-name', { action: 'name', sessionName: 'A long readable session title with more text than fits beside statuses' });
      for (const action of ['light', 'dark']) {
        const styled = await footerObserve(live, `name-${action}`, action), y = footerPhysical(styled), row = plain(styled.rows[0]);
        const x = row.indexOf('A long'), end = row.indexOf('…', x);
        assert.ok(x >= 0 && end > x, 'actual shortened title is visible');
        const mutedRef = await referenceCell(styled.styles.muted), dimRef = await referenceCell(styled.styles.dim);
        for (let i = x; i <= end; i++) { assert.equal(styled.cells[y][i].fg, mutedRef.fg); assert.equal(styled.cells[y][i].fgMode, mutedRef.fgMode); }
        for (const begin of [x - 3, end + 1]) for (let i = begin; i < begin + 3; i++) {
          assert.equal(styled.cells[y][i].fg, dimRef.fg); assert.equal(styled.cells[y][i].fgMode, dimRef.fgMode);
        }
      }
      await footerObserve(live, 'delayed-clear-statuses', 'clear');
      const delayed = await footerObserve(live, 'delayed-pending', { action: 'delayed-name', sessionName: 'Delayed session title' });
      assert.ok(!delayed.rows.map(plain).join(' ').includes('Delayed session title'), 'earlier async extension holds public name event past the native repaint');
      footerPhysical(delayed);
      writeFileSync(join(live.output, 'footer-name-release'), 'release');
      const frame = await until(() => {
        try { const value = JSON.parse(readFileSync(join(live.output, 'delayed-name-frame.json'), 'utf8')); return value.rows.map(plain).join(' ').includes('Delayed session title') && value; }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
      }, 'fresh footer frame after delayed event, without any further terminal input');
      await live.settle(); footerPhysical(live.captureScreen('delayed-fresh-frame', frame));
      assert.equal(plain(frame.rows[0]), stats + ' • Delayed session title');
      for (const key of ['scans', 'contextReads', 'aggregations', 'entries']) assert.equal(frame.counters[key], delayed.counters[key], 'delayed name delivery only rebuilds presentation');
      assert.equal(frame.counters.nameReads, delayed.counters.nameReads + 1, 'delayed delivery rereads the current saved name exactly once');
      await footerObserve(live, 'saved-name', { action: 'name', sessionName: 'Saved session title' });
      await footerObserve(live, 'saved-clear-statuses', 'clear');
      const saved = await footerObserve(live, 'saved'), bytes = readFileSync(saved.session);
      let starts = live.events().filter(event => event.type === 'start').length;
      await live.appearance(false); await live.command('/reload'); await live.event('start', starts + 1); await live.settle();
      assert.equal((await footerObserve(live, 'saved-off-reload')).owner, 'FooterComponent', 'reload preserves saved appearance Off');
      starts = live.events().filter(event => event.type === 'start').length;
      await live.appearance(true); await live.command('/reload'); await live.event('start', starts + 1); await live.settle();
      const reloaded = await footerObserve(live, 'reloaded'); footerPhysical(reloaded);
      assert.deepEqual(reloaded.rows, saved.rows);
      const warm = await footerObserve(live, 'warm');
      for (let i = 0; i < 8; i++) assert.deepEqual((await footerObserve(live, `warm-${i}`)).counters, warm.counters);
      assert.deepEqual(readFileSync(saved.session), bytes, 'presentation lifecycle leaves saved name/session bytes unchanged');
      const replay = new PiTerminal(`footer-name-replay-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, session: saved.session, workspace: live.work });
      terminals.push(replay); await replay.ready();
      const resumed = await footerObserve(replay, 'restored'); footerPhysical(resumed);
      assert.deepEqual(resumed.rows, saved.rows);
      assert.deepEqual(readFileSync(saved.session), bytes);
      assert.equal(replay.events().filter(e => trafficKinds.includes(e.type)).length, 0, 'replay executes zero tools/results/model requests');
      const beforeClear = await footerObserve(live, 'before-fallback-clear');
      const fallbackSaved = await footerObserve(live, 'fallback-clear', { action: 'name', sessionName: '' });
      assert.equal(plain(fallbackSaved.rows[0]), stats + fallback); footerPhysical(fallbackSaved);
      for (const key of ['scans', 'contextReads', 'aggregations', 'entries', 'titleLookups', 'titleEntries']) assert.equal(fallbackSaved.counters[key], beforeClear.counters[key], 'clearing uses cached first-message title, not another history/context scan');
      const fallbackBytes = readFileSync(fallbackSaved.session);
      starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1); await live.settle();
      const fallbackReloaded = await footerObserve(live, 'fallback-reloaded'); footerPhysical(fallbackReloaded);
      assert.deepEqual(fallbackReloaded.rows, fallbackSaved.rows);
      assert.deepEqual(readFileSync(fallbackSaved.session), fallbackBytes);
      const fallbackReplay = new PiTerminal(`footer-fallback-replay-${mode}`, { ...options, extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, session: fallbackSaved.session, workspace: live.work });
      terminals.push(fallbackReplay); await fallbackReplay.ready();
      const fallbackResumed = await footerObserve(fallbackReplay, 'restored-fallback'); footerPhysical(fallbackResumed);
      assert.deepEqual(fallbackResumed.rows, fallbackSaved.rows);
      const fallbackWarm = await footerObserve(fallbackReplay, 'fallback-warm');
      for (let i = 0; i < 4; i++) assert.deepEqual((await footerObserve(fallbackReplay, `fallback-warm-${i}`)).counters, fallbackWarm.counters);
      assert.deepEqual(readFileSync(fallbackSaved.session), fallbackBytes);
      assert.equal(fallbackReplay.events().filter(e => trafficKinds.includes(e.type)).length, 0, 'default-title replay executes no tools/results/model requests');
      observations.push({ mode, renameBefore: empty.counters, renameAfter: changed.counters, warm: warm.counters, replay: resumed.counters, clearBefore: beforeClear.counters, fallback: fallbackSaved.counters, fallbackReplay: fallbackResumed.counters, fallbackWarm: fallbackWarm.counters });
    }
    writeFileSync(join(artifacts, 'footer-name-counters.json'), JSON.stringify(observations, null, 2));
  } finally { await closeTerminals(terminals); }
});

test('footer cache history tracks every real request including equal CH, cold zero, unknown, colors and replay', { timeout: 180000 }, async () => {
  const terminals = [];
  const options = { extraEnv: { TIDY_UI_TEST_FOOTER: '1', TIDY_UI_TEST_FOOTER_HISTORY: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] };
  const reports = dump => dump.entries.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => {
    const u = e.message.usage, prompt = u.input + u.cacheRead + u.cacheWrite;
    return prompt > 0 ? u.cacheRead / prompt * 100 : undefined;
  });
  const expected = history => {
    const last = history.slice(-10), chars = [];
    for (let i = 0; i < 10 - last.length; i++) chars.push({ glyph: '·', role: 'muted' });
    for (const raw of last) {
      const rate = raw === undefined ? undefined : Number(raw.toFixed(1));
      chars.push(rate === undefined ? { glyph: '·', role: 'muted' } : {
        glyph: [...'▁▂▃▄▅▆▇█'][Math.round(7 * (1 - rate / 100))], role: rate >= 95 ? 'success' : rate < 80 ? 'error' : 'warning' });
    }
    const rate = history.at(-1), ch = rate === undefined ? 'CH—' : 'CH' + rate.toFixed(1) + '%';
    return { chars, text: '[' + chars.map(x => x.glyph).join('') + '] ' + ch };
  };
  const check = async dump => {
    const y = footerPhysical(dump), text = dump.rows.map(plain)[0], value = expected(reports(dump));
    assert.ok(text.startsWith(value.text), 'ten saved reports and latest CH precede current context');
    const suffix = text.slice(value.text.length);
    if (dump.context) assert.match(suffix, /^ • (?:\d+(?:\.\d+)?[kM]|\?)\/\d+(?:\.\d+)?[kM]/u, 'context follows the cache block');
    else assert.equal(suffix, ' • (no messages)', 'native no-message title is the only suffix before first traffic without context');
    assert.equal(dump.rows.length, 1, 'statistics is one status, never internally wrapped');
    const x = text.indexOf('['), refs = Object.fromEntries(await Promise.all(Object.entries(dump.styles).map(async ([role, style]) => [role, await referenceCell(style)])));
    for (let i = 0; i < 10; i++) {
      assert.equal(dump.cells[y][x + 1 + i].text, value.chars[i].glyph);
      assert.equal(dump.cells[y][x + 1 + i].fg, refs[value.chars[i].role].fg);
      assert.equal(dump.cells[y][x + 1 + i].fgMode, refs[value.chars[i].role].fgMode);
    }
    for (const i of [x, x + 11]) assert.equal(dump.cells[y][i].fg, refs.dim.fg);
    return value.text;
  };
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const native = new PiTerminal(`footer-history-native-${mode}`, { ...options, mode }); terminals.push(native); await native.ready();
      const live = new PiTerminal(`footer-history-live-${mode}`, { ...options, mode, workspace: native.work,
        extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' } }); terminals.push(live); await live.ready();
      let dump = await footerObserve(live, 'empty', 'accounting'); assert.equal(await check(dump), '[··········] CH—');
      for (const terminal of [native, live]) await terminal.run('footer-cold');
      dump = await footerObserve(live, 'cold', 'accounting'); assert.equal(await check(dump), '[·········█] CH0.0%');
      for (const terminal of [native, live]) await terminal.run('footer-history');
      dump = await footerObserve(live, 'twenty', 'accounting'); assert.equal(reports(dump).length, 21);
      assert.deepEqual(reports(dump).slice(-20), Array(20).fill(10)); assert.equal(await check(dump), '[▇▇▇▇▇▇▇▇▇▇] CH10.0%');
      for (const terminal of [native, live]) await terminal.run('footer-varied');
      dump = await footerObserve(live, 'varied', 'accounting'); assert.equal(reports(dump).length, 33); await check(dump);
      for (const action of ['light', 'dark']) {
        await footerObserve(live, action, action); dump = await footerObserve(live, `${action}-colors`, 'accounting'); await check(dump);
      }
      const initialRows = dump.rows, file = dump.session, bytes = readFileSync(file), context = dump.context;
      const warm = await footerObserve(live, 'history-warm');
      for (let i = 0; i < 4; i++) {
        const next = await footerObserve(live, `history-hot-${i}`);
        assert.deepEqual(next.rows, warm.rows); assert.deepEqual(next.counters, warm.counters, 'renders append no cache samples and perform zero history/context/layout work');
      }
      const cachePrefix = expected(reports(dump)).text;
      for (const width of [24, 60, 100]) {
        await live.resize(width); const narrow = await footerObserve(live, `history-width-${width}`); footerPhysical(narrow);
        assert.equal(narrow.rows.length, 1, 'our complete status is never internally wrapped');
        const text = plain(narrow.rows[0]);
        if (width === 24) assert.ok(text.endsWith('…'), 'statistics tail is clipped at narrow width');
        else assert.match(text, / • \d+(?:\.\d+)?[kM]\/\d+(?:\.\d+)?[kM] \([\d.]+%\)/u, 'statistics context remains complete even when the optional title is clipped');
        assert.ok(text.startsWith(cachePrefix), 'narrow clipping keeps the full cache block from the preceding saved-report snapshot before the context tail');
      }
      await live.appearance(false); await live.appearance(true); dump = await footerObserve(live, 'history-on', 'accounting');
      assert.deepEqual(dump.rows, initialRows); await check(dump);
      await live.command('/reload'); dump = await footerObserve(live, 'history-reload', 'accounting');
      assert.deepEqual(dump.rows, initialRows); assert.deepEqual(dump.context, context); await check(dump);
      assert.deepEqual(readFileSync(file), bytes, 'presentation and restoration never rewrite saved report bytes');
      const liveTraffic = await live.capture('history-traffic'), nativeTraffic = await native.capture('history-traffic');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      const requests = terminal => terminal.events().filter(e => ['call', 'result', 'model_context'].includes(e.type));
      assert.deepEqual(requests(live), requests(native), 'strict real request/tool/result/native context equality');
      assert.equal(requests(live).filter(e => e.type === 'model_context').length, 33);
      assert.equal(requests(live).filter(e => e.type === 'call').length, 30);
      assert.equal(requests(live).filter(e => e.type === 'result').length, 30);
      const nativeData = await footerObserve(native, 'history-native-usage', 'accounting');
      assert.deepEqual(reports(dump), reports(nativeData));
      const replay = new PiTerminal(`footer-history-replay-${mode}`, { ...options, mode, session: file, workspace: live.work,
        extraEnv: { ...options.extraEnv, TIDY_UI_TEST_FOOTER_PRESENTATION: '1' } }); terminals.push(replay); await replay.ready();
      const resumed = await footerObserve(replay, 'history-resumed', 'accounting'); assert.deepEqual(resumed.rows, initialRows);
      assert.deepEqual(reports(resumed), reports(dump)); await check(resumed); assert.equal(requests(replay).length, 0);
    }
  } finally { await closeTerminals(terminals); }
});

test('footer animated Working and short-height clipping do not rescan session or replace native activity', {}, async () => {
  const terminals = [];
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const terminal = new PiTerminal(`footer-working-${mode}`, { mode, extraEnv: { TIDY_UI_TEST_FOOTER: '1', TIDY_UI_TEST_FOOTER_PRESENTATION: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] });
      terminals.push(terminal); await terminal.ready(); terminal.send('run pending\r'); await terminal.event('provider_gate');
      const baseline = await footerObserve(terminal, 'busy', 'statuses', true); footerPhysical(baseline);
      assert.ok(baseline.screen.some(row => row.includes('Working')));
      for (let i = 0; i < 8; i++) { const next = await footerObserve(terminal, `busy-${i}`, 'snapshot', true); assert.deepEqual(next.counters, baseline.counters, 'native activity ticks cause no stats or footer body rebuilds'); }
      if (mode === 'fullscreen') {
        await terminal.resize(100, 4, true); const clipped = await footerObserve(terminal, 'clipped', 'snapshot', true);
        assert.equal(clipped.owner, 'FooterView'); assert.ok(clipped.rows.length > 0);
        assert.equal(clipped.statusIdentity, baseline.statusIdentity, 'height clipping cannot replace or stop the native indicator');
        assert.ok(clipped.nativeStatusRows.some(row => plain(row).includes('Working')), 'native container still renders its active object despite dock clipping');
        const control = new PiTerminal('footer-height-native-separate', { mode, extraEnv: { TIDY_UI_TEST_FOOTER: '1' }, extensions: [join(fixtures, 'footer-driver.ts')] });
        terminals.push(control); await control.ready(); control.send('run pending\r'); await control.event('provider_gate');
        const before = await footerObserve(control, 'native-busy', 'snapshot', true);
        const separated = await footerObserve(control, 'native-separate', 'native-separate', true);
        assert.equal(separated.statusIdentity, before.statusIdentity, 'public native relocation keeps the same indicator');
        await control.resize(100, 4, true); const nativeClip = await footerObserve(control, 'native-clipped', 'snapshot', true);
        assert.equal(nativeClip.statusIdentity, before.statusIdentity); assert.ok(nativeClip.nativeStatusRows.some(row => plain(row).includes('Working')));
        assert.equal(clipped.screen.some(row => row.includes('Working')), nativeClip.screen.some(row => row.includes('Working')), 'low-height visibility matches Pi own separate-status dock allocation');
        await terminal.resize(100, 80, true); const restored = await footerObserve(terminal, 'height-restored', 'snapshot', true); footerPhysical(restored);
        assert.equal(restored.statusIdentity, baseline.statusIdentity); assert.ok(restored.screen.some(row => row.includes('Working')));
      }
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      const done = await footerObserve(terminal, 'done', 'accounting'); assert.equal(done.idle, true); footerPhysical(done);
      assert.ok(done.rows.map(plain).join('\n').includes('CH86.4%')); assert.ok(done.counters.aggregations > baseline.counters.aggregations);
    }
  } finally { await closeTerminals(terminals); }
});
