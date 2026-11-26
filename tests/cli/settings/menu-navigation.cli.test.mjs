import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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
      await live.resize(100, 5); await step('\x1b[A', 5);
      assert.match(selected(), /^→ Use Occipital highlighting/u);
      assert.ok(!live.tidyRows().some(row => /\(\d+\/\d+\)/u.test(row)), 'compact support clips the position indicator');
      await live.selectTidyItem('Reapply Tidy UI appearance', false);
      assert.match(selected(), /^→ Reapply Tidy UI appearance/u, 'the selector reverses without a visible position indicator');
      assert.deepEqual(readFileSync(config), original, 'bounded navigation and previews save nothing');
      await live.closeTidyMenu();
      assert.equal(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
    } finally { await closeTerminals([live]); }
  });

for (const mode of ['regular', 'fullscreen']) test(`diagnostic pages share a wider, terminal-clamped popup (${mode})`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`menu-diagnostic-width-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'pi' }, nativeHighlightingEnabled: false } });
    const width = () => {
      const bounds = live.tidyFrame();
      assert.ok(bounds, 'diagnostic width is measured from the physical frame');
      assert.equal(bounds.left, Math.floor((live.term.cols - bounds.width) / 2));
      return bounds.width;
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
      let runAndSession;
      for (const page of ['Highlighting service details', 'Diagnostic logs', 'Display cache']) {
        await live.selectTidyItem(page); pages[page] = width();
        if (page === 'Diagnostic logs') runAndSession = live.tidyRows().find(row => row.startsWith('Run: '));
        if (page !== 'Display cache') await backTo(support);
      }
      const diagnosticWidth = pages[support];
      assert.ok(diagnosticWidth > rootWidth, `diagnostics should be wider than the ${rootWidth}-column root: ${JSON.stringify(pages)}`);
      assert.equal(diagnosticWidth, 98, 'a wide terminal leaves the preferred diagnostic width unchanged');
      assert.ok(Object.values(pages).every(columns => columns === diagnosticWidth), 'the same frame width serves every diagnostic page');
      assert.match(runAndSession ?? '', /^Run: [\da-f-]{36}; session: [\da-f-]{36}$/u, 'both diagnostic IDs fit on one physical row');
      const cacheScope = 'Scope: Tidy UI display layouts only; excludes Pi caches, syntax sources and temporary rendering.';
      assert.ok(live.tidyRows().includes(cacheScope), 'the cache scope fits on one physical row');
      await live.resize(72, 40);
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
      await backTo('Tidy UI'); assert.equal(width(), rootWidth);
      await live.closeTidyMenu();
    } finally { await closeTerminals([live]); }
  });
