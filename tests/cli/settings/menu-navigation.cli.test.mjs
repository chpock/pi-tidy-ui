import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sliceByColumn } from '@earendil-works/pi-tui';
import { PiTerminal } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';

for (const mode of ['regular', 'fullscreen']) test(`menu keyboard bounds: real first/last, filtering and short popup (${mode})`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`menu-keyboard-bounds-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: false },
      extraEnv: { TIDY_UI_TEST_MENU_GEOMETRY: '1' } });
    const selected = () => live.tidyRows().find(row => row.startsWith('→ ')) ?? '';
    const step = async (key, count = 1) => { live.send(key.repeat(count)); await live.settle(); await live.refreshTidyBounds(); };
    try {
      await live.ready(); await live.resize(100, 12); await live.openTidyMenu();
      const config = join(live.agent, 'extensions/pi-tidy-ui/config.json'), original = readFileSync(config);
      await step('\x1b[A'); assert.match(selected(), /^→ Tidy UI appearance/u);
      await step('\x1b[A', 3); assert.match(selected(), /^→ Tidy UI appearance/u, 'Up does not wrap to Close');
      await step('\x1b[B', 20); assert.match(selected(), /^→ Close/u);
      await step('\x1b[B', 3); assert.match(selected(), /^→ Close/u, 'Down does not wrap to appearance');
      await step('\x1b[A'); assert.match(selected(), /^→ Status/u, 'inward movement remains available');
      await step('\x1b[A', 20); await step('\x1b[B');
      assert.match(selected(), /^→ Code color theme/u);
      await live.selectTidyItem('Code color theme');
      await step('\x1b[A', 3); assert.match(selected(), /^→ Follow Pi theme/u);
      await step('\x1b[B', 45); assert.match(selected(), /^→ Back/u, 'scroll to the end of the complete family list');
      await step('\x1b[B', 3); assert.match(selected(), /^→ Back/u);
      await step('\x1b[A'); assert.ok(!selected().startsWith('→ Back'), 'Up leaves the final action row');
      await step('\x1b[A', 45); assert.match(selected(), /^→ Follow Pi theme/u);
      await step('GitHub'); assert.match(selected(), /^→ GitHub/u);
      await step('\x1b[A', 3); assert.match(selected(), /^→ GitHub/u, 'the filtered first row is its own boundary');
      await step('\x1b[B', 3); assert.match(selected(), /^→ Back/u);
      await step('\x1b[A'); assert.match(selected(), /^→ GitHub/u);
      await step('\x1b');
      await live.resize(100, 30);
      await live.selectTidyItem('Status & troubleshooting');
      await step('\x1b[A', 3); assert.match(selected(), /^→ Reapply Tidy UI appearance/u);
      await step('\x1b[B', 20); assert.match(selected(), /^→ Back/u);
      await step('\x1b[B', 3); assert.match(selected(), /^→ Back/u);
      await live.resize(100, 4); await step('\x1b[A', 5);
      assert.match(selected(), /^→ Use Occipital highlighting/u);
      assert.ok(!live.tidyRows().some(row => /\(\d+\/\d+\)/u.test(row)), 'compact support clips the position indicator');
      await live.selectTidyItem('Reapply Tidy UI appearance', false);
      assert.match(selected(), /^→ Reapply Tidy UI appearance/u, 'the selector reverses without a visible position indicator');
      assert.deepEqual(readFileSync(config), original, 'bounded navigation and previews save nothing');
      await live.closeTidyMenu();
      assert.equal(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
    } finally { await closeTerminals([live]); }
  });

for (const mode of ['regular', 'fullscreen']) test(`theme picker separates the search, modes, families and Back (${mode})`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`menu-theme-groups-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: false } });
    const step = async data => { live.send(data); await live.settle(); };
    const line = /^ {2}─+$/u;
    const assertInsetDivider = y => {
      const { left, width } = live.tidyFrame();
      assert.match(sliceByColumn(live.screen()[y], left, width), /^│  ─+  │$/u, 'both edges leave two cells inside the frame');
    };
    const click = async y => {
      const x = live.tidyFrame().left + 4;
      await step(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    };
    try {
      await live.ready(); await live.resize(100, 30); await live.openTidyMenu();
      const config = join(live.agent, 'extensions/pi-tidy-ui/config.json'), original = readFileSync(config);
      await live.selectTidyItem('Code color theme');
      const top = live.tidyRows();
      const search = top.findIndex(row => row.startsWith('Search:'));
      assert.ok(search >= 0);
      assert.equal(top[search + 1], '', 'the search field ends with one empty row');
      assert.match(top[search + 2], /^→ Follow Pi theme/u);
      assert.match(top[search + 3], line, 'a divider separates Follow Pi from the first family');
      assertInsetDivider(search + 3);
      assert.match(top[search + 4], /^ {2}\S/u);
      if (mode === 'fullscreen') {
        const counter = top.findIndex(row => /^\s*\(1\/34\)$/u.test(row));
        assert.ok(counter >= 0, 'only the real choices count as list items');
        await click(search + 1); await click(search + 3); await click(counter);
        assert.ok(live.tidyRows().some(row => row.startsWith('→ Follow Pi theme')), 'decoration and the scroll indicator do not select or confirm');
      }
      await live.resize(100, 46);
      const full = live.tidyRows();
      assert.ok(full.includes('  Back'), 'the last item fits when there is room for all choices and both lines');
      assert.equal(full.filter(row => line.test(row)).length, 2);
      assert.notEqual(full[full.indexOf('  Back') + 1], '', 'the blank does not displace choices or lines at exact fit');
      await live.resize(100, 47);
      const spaced = live.tidyRows(), fullBack = spaced.indexOf('  Back');
      assert.ok(fullBack >= 0 && !spaced.some(row => /\(\d+\/34\)/u.test(row)));
      assert.equal(spaced[fullBack + 1], '', 'one free row adds the blank below Back');
      assert.match(spaced[fullBack + 2], /^─+$/u, 'the next row is the footer divider');
      await live.resize(100, 30);
      await step('\x1b[B');
      assert.equal(live.tidyRows().find(row => row.startsWith('→ '))?.slice(2).split(/ {2,}/u)[0], top[search + 4].trim(), 'Down goes directly to the first family');
      await step('\x1b[B'.repeat(40));
      const bottom = live.tidyRows(), back = bottom.findIndex(row => row === '→ Back');
      assert.ok(back >= 0);
      assert.match(bottom[back - 1], line, 'a divider separates Back from the last family');
      assertInsetDivider(back - 1);
      assert.equal(bottom[back + 1], '', 'the blank stays directly under Back when scrolled');
      assert.match(bottom[back + 2], /^\s*\(34\/34\)$/u);
      assert.ok(bottom.includes('Selected: Follow Pi'), 'Back restores the confirmed theme while staying in the picker');
      if (mode === 'fullscreen') {
        await click(back - 1); await click(back + 1);
        assert.ok(live.tidyRows().includes('→ Back'), 'clicking either decoration next to Back does not navigate');
      }
      await step('GitHub');
      let filter = live.tidyRows(), filteredBack = filter.findIndex(row => /^  Back$/u.test(row));
      assert.ok(filteredBack >= 0);
      assert.match(filter[filteredBack - 1], line, 'a matching family and Back remain separated');
      assert.equal(filter[filteredBack + 1], '', 'the filtered Back row has the same gap');
      assert.ok(filter.includes('Selected: GitHub'), 'search previews a matching family');
      await step('zz_no_such_theme');
      filter = live.tidyRows(); filteredBack = filter.findIndex(row => row === '→ Back');
      assert.ok(filteredBack >= 0);
      const filteredSearch = filter.findIndex(row => row.startsWith('Search:'));
      assert.equal(filteredBack, filteredSearch + 2, 'Back alone has no group separator');
      assert.equal(filter[filteredBack + 1], '', 'the gap remains when Back is the only row');
      assert.ok(filter.includes('Selected: Follow Pi'), 'a Back-only filter clears the previous preview');
      assert.deepEqual(readFileSync(config), original, 'decoration, navigation and previews do not save settings');
      await step('\r');
      assert.ok(live.tidyHeading('Tidy UI'), 'Back remains an action');
      await live.closeTidyMenu();
    } finally { await closeTerminals([live]); }
  });

for (const mode of ['regular', 'fullscreen']) test(`diagnostic pages share a wider, terminal-clamped popup (${mode})`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`menu-diagnostic-width-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: false, terminalColorsEnabled: false } });
    const width = () => {
      const bounds = live.tidyFrame();
      assert.ok(bounds, 'diagnostic width is measured from the physical frame');
      assert.equal(bounds.left, Math.floor((live.term.cols - bounds.width) / 2));
      return bounds.width;
    };
    const checkSections = (lastDetail, firstChoice) => {
      const rows = live.tidyRows(), footer = live.tidyFrame().bottom - 2;
      const detail = rows.findIndex(row => row.startsWith(lastDetail));
      assert.ok(detail >= 0, lastDetail);
      assert.equal(rows[detail + 1], '', 'the information block is followed by one blank row');
      assert.match(rows[detail + 2], firstChoice);
      assert.match(rows[footer - 3], /^(?:→ | {2})\S/u, 'the last choice is two rows above the footer divider');
      assert.equal(rows[footer - 2], '', 'one blank separates the choices from the hint');
      assert.match(rows[footer - 1], /\S/u, 'one hint row sits just above the footer divider');
    };
    const checkSupportArrows = () => {
      const { left, width } = live.tidyFrame();
      const labels = ['Highlighting service details', 'Diagnostic logs', 'Display cache'];
      const list = live.tidyRows(), screen = live.screen();
      for (const label of labels) {
        const y = list.findIndex(row => /^(?:→ | {2})/u.test(row) && row.slice(2).startsWith(label));
        assert.ok(y >= 0, `${label} is visible`);
        assert.match(sliceByColumn(screen[y], left, width), /› {2}│$/u, `${label} leaves two cells before the border`);
      }
    };
    const backTo = async title => {
      live.send('\x1b'); await live.settle();
      assert.ok(live.tidyHeading(title), `Escape returns to ${title}`);
    };
    try {
      await live.ready(); await live.resize(120, 40); await live.openTidyMenu();
      const rootWidth = width(), support = 'Status & troubleshooting';
      await live.selectTidyItem(support);
      const pages = { [support]: width() };
      checkSections('Code colors:', /^Appearance$/u);
      checkSupportArrows();
      const groupEnds = [
        [/^  Reapply terminal colors$/u, 'Code highlighting'],
        [/^  Highlighting service details\s+›$/u, 'Diagnostics'],
        [/^  Refresh status$/u, '  Back'],
      ];
      const groupGaps = spaced => {
        const rows = live.tidyRows();
        return groupEnds.map(([lastChoice, following]) => {
          const end = rows.findIndex(row => lastChoice.test(row));
          assert.ok(end >= 0, `${lastChoice} stays visible`);
          if (spaced) assert.equal(rows[end + 1], '', `${lastChoice} is followed by an empty row`);
          assert.equal(rows[end + (spaced ? 2 : 1)], following);
          return end + 1;
        });
      };
      const gaps = groupGaps(true);
      if (mode === 'fullscreen') {
        const x = live.tidyFrame().left + 4;
        const config = join(live.agent, 'extensions/pi-tidy-ui/config.json'), original = readFileSync(config);
        for (const y of gaps) {
          live.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
          await live.settle();
          assert.ok(live.tidyHeading(support));
          assert.equal(live.tidyRows().find(row => row.startsWith('→ ')), '→ Reapply Tidy UI appearance');
        }
        assert.deepEqual(readFileSync(config), original, 'clicking the gaps does not change settings');
      }
      const { top, bottom } = live.tidyFrame();
      await live.resize(120, bottom - top + 1 - gaps.length);
      groupGaps(false);
      checkSections('Code colors:', /^Appearance$/u);
      await live.resize(120, 40);
      groupGaps(true);
      await live.selectTidyItem('Reapply terminal colors', false);
      live.send('\x1b[B'); await live.settle();
      assert.match(live.tidyRows().find(row => row.startsWith('→ ')) ?? '', /^→ Use Occipital highlighting/u);
      await live.selectTidyItem('Refresh status', false);
      live.send('\x1b[B'); await live.settle();
      assert.ok(live.tidyRows().includes('→ Back'), 'Down skips the last gap and lands on Back');
      const bottomLine = () => live.tidyRows()[live.tidyFrame().bottom - 3];
      await live.selectTidyItem('Refresh status', false);
      const before = live.tidyFrame(), hint = bottomLine();
      await live.selectTidyItem('Refresh status');
      assert.equal(bottomLine(), 'Status refreshed.');
      assert.deepEqual(live.tidyFrame(), before, 'success leaves the physical bounds unchanged');
      await live.selectTidyItem('Back', false);
      assert.notEqual(bottomLine(), hint);
      assert.equal(bottomLine(), 'Return to the previous page.');
      await live.selectTidyItem('Reapply terminal colors', false);
      const beforeFailure = live.tidyFrame();
      live.send('\r'); await live.settle();
      assert.match(bottomLine(), /turn on appearance and terminal color matching/i);
      assert.deepEqual(live.tidyFrame(), beforeFailure, 'failure leaves the physical bounds unchanged');
      let runAndSession;
      for (const page of ['Highlighting service details', 'Diagnostic logs', 'Display cache']) {
        await live.selectTidyItem(page); pages[page] = width();
        if (page === 'Highlighting service details') checkSections('Last issue:', /^→ Back$/u);
        if (page === 'Diagnostic logs') {
          runAndSession = live.tidyRows().find(row => row.startsWith('Run: '));
          checkSections('Dropped records:', /^→ Record diagnostic logs/u);
          const journalPath = () => {
            const rows = live.tidyRows(), first = rows.findIndex(row => row.startsWith('Journal:'));
            const next = rows.findIndex(row => row.startsWith('Session index:'));
            assert.ok(first >= 0 && next > first + 1, 'the actual journal path spans multiple rows');
            assert.match(rows[first], /^Journal: \/\S/u, 'the long path starts on the same row as Journal:');
            return rows[first].slice('Journal: '.length) + rows.slice(first + 1, next).join('');
          };
          const journal = journalPath();
          assert.ok(existsSync(journal), 'the displayed path is the complete path of an actual journal');
          await live.resize(72, 40);
          assert.equal(journalPath(), journal, 'resizing rewraps the same path without dropping characters');
          await live.resize(120, 40);
        }
        if (page === 'Display cache') {
          for (let i = 0; i < 8 && !live.tidyRows().includes('End diagnostic JSON'); i++) {
            live.send('\x1b[6~'); await live.settle();
          }
          checkSections('End diagnostic JSON', /^→ Refresh statistics$/u);
          live.send('\x1b[5~'.repeat(8)); await live.settle();
          assert.ok(live.tidyRows().some(row => row.startsWith('Saved layouts:')), 'cache details return to the top');
        }
        if (page !== 'Display cache') await backTo(support);
      }
      const diagnosticWidth = pages[support];
      assert.ok(diagnosticWidth > rootWidth, `diagnostics should be wider than the ${rootWidth}-column root: ${JSON.stringify(pages)}`);
      assert.equal(diagnosticWidth, 98, 'a wide terminal leaves the preferred diagnostic width unchanged');
      assert.ok(Object.values(pages).every(columns => columns === diagnosticWidth), 'the same frame width serves every diagnostic page');
      assert.match(runAndSession ?? '', /^Run: [\da-f-]{36}; session: [\da-f-]{36}$/u, 'both diagnostic IDs fit on one physical row');
      const cacheScope = 'Scope: Tidy UI display layouts only; excludes Pi caches, syntax sources and temporary rendering.';
      assert.ok(live.tidyRows().includes(cacheScope), 'the cache scope fits on one physical row');
      await live.resize(72, 60);
      assert.equal(width(), 72, 'narrow terminal clamps the diagnostic frame');
      const scopeIndex = () => live.tidyRows().findIndex(row => row.startsWith('Scope: '));
      if (scopeIndex() < 0) { live.send('\x1b[6~'); await live.settle(); }
      const scopeStart = scopeIndex();
      assert.ok(scopeStart >= 0, 'cache paging reveals the wrapped scope');
      assert.equal(live.tidyRows().slice(scopeStart, scopeStart + 2).map(row => row.trim()).join(' '), cacheScope,
        'the same cache scope wraps across two physical rows');
      assert.equal(width(), 72, 'paging does not resize the clamped frame');
      live.send('\x1b[5~'); await live.settle();
      await live.resize(100, 40);
      assert.equal(width(), diagnosticWidth, 'the wider frame recenters and restores its width');
      assert.ok(live.tidyRows().includes(cacheScope));
      await backTo(support); assert.equal(width(), diagnosticWidth);
      await live.resize(72, 40); assert.equal(width(), 72); checkSupportArrows();
      await backTo('Tidy UI'); assert.equal(width(), rootWidth);
      await live.closeTidyMenu();
    } finally { await closeTerminals([live]); }
  });

test('Diagnostic logs shows the current Pi name after /reload with recording off', { timeout: 60000 }, async () => {
  const live = new PiTerminal('menu-session-name', { tidyUi: true,
    tidyUiSettings: { nativeHighlightingEnabled: false, terminalColorsEnabled: false } });
  const title = 'Diagnostic session title';
  const status = () => live.tidyPage(['Status & troubleshooting', 'Diagnostic logs']);
  try {
    await live.ready(); await live.resize(120, 40);
    assert.ok((await status()).includes('Session name: unknown'));
    await live.command(`/name ${title}`);
    assert.ok((await status()).includes(`Session name: ${title}`), 'a built-in rename appears in the menu');
    await live.diagnosticLogging(false);
    const starts = live.events().filter(event => event.type === 'start').length;
    await live.command('/reload'); await live.event('start', starts + 1);
    await live.command('/name');
    await live.waitForScreen(rows => rows.some(row => row.trim() === `Session name: ${title}`), 'Pi still knows the saved title');
    const rows = await status();
    assert.ok(rows.includes('Recording: Off'), 'reload preserves the local capture switch');
    assert.ok(rows.includes(`Session name: ${title}`), 'a new journal run is not the authority for the title');
  } finally { await closeTerminals([live]); }
});
