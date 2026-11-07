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
