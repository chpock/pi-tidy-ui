import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, plain, until } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { referenceCell, traffic, persisted } from '../../fixtures/main-cli-support.mjs';

const variantLabel = 'Code color variant';
const selected = terminal => terminal.tidyRows().find(row => row.startsWith('→ ')) ?? '';
const variantRow = terminal => terminal.tidyRows().find(row => row.includes(variantLabel));
const palette = variant => JSON.parse(readFileSync(new URL(`../../../src/themes/palettes/github-${variant}.json`, import.meta.url), 'utf8'));

async function assertOutputPalette(dump, variant) {
  const marker = 'USER_BASH_OUTPUT';
  const y = dump.screen.findIndex(row => plain(row).replace('┃', '').trim() === marker);
  assert.ok(y >= 0, 'the real Bash output is physically visible, independently of its command heading');
  const x = plain(dump.screen[y]).indexOf(marker), cell = dump.cells[y][x], output = palette(variant).roles.output;
  const rgb = await referenceCell('\x1b[38;2;1;2;3;48;2;4;5;6mX');
  assert.notEqual(rgb.fgMode, 0); assert.notEqual(rgb.bgMode, 0);
  assert.equal(cell.fgMode, rgb.fgMode);
  assert.equal(cell.bgMode, rgb.bgMode);
  assert.equal(cell.fg, Number.parseInt(output.foreground.slice(1), 16), `physical ${variant} output foreground`);
  assert.equal(cell.bg, Number.parseInt(output.background.slice(1), 16), `physical ${variant} panel background`);
}

async function assertDisabled(terminal, dim, name, variant) {
  const row = variantRow(terminal);
  assert.ok(row, 'the disabled variant remains visible rather than disappearing');
  assert.match(row, new RegExp(`${variantLabel}\\s+${variant}`, 'u'));
  assert.ok(!row.startsWith('→ '), 'a disabled row is not selected');
  const dump = terminal.captureScreen(name, {}), y = terminal.tidyRows().findIndex(line => line.includes(variantLabel));
  const x = dump.screen[y].indexOf(variantLabel);
  assert.ok(x >= 0, 'the actual popup contains the disabled label');
  for (let offset = 0; offset < variantLabel.length; offset++) if (variantLabel[offset] !== ' ') {
    const cell = dump.cells[y][x + offset];
    assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
      { fg: dim.fg, fgMode: dim.fgMode, dim: dim.dim }, 'disabled text uses Pi’s dim role');
  }
}

for (const mode of ['regular', 'fullscreen']) test(`real CLI: separate theme family/variant, disabled navigation and canonical saved replay (${mode})`,
  { timeout: 120000 }, async () => {
    const terminals = [];
    const live = new PiTerminal(`theme-variant-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'pi' }, syntaxThemeVariant: 'system', nativeHighlightingEnabled: false, future: { retained: true } } });
    terminals.push(live);
    const config = join(live.agent, 'extensions/pi-tidy-ui/config.json');
    const readConfig = () => JSON.parse(readFileSync(config, 'utf8'));
    const currentVariant = value => new RegExp(`${variantLabel}\\s+${value}`, 'u').test(variantRow(live) ?? '');
    try {
      await live.ready(); await live.resize(100, 30); await live.run('user-card');
      const initial = await live.capture('variant-initial'), originalTraffic = traffic(live, 2), session = readFileSync(initial.session);
      const originalConfig = readFileSync(config), dim = await referenceCell(initial.summaryStyles.dim);
      await live.openTidyMenu();
      await assertDisabled(live, dim, 'variant-disabled-dark', 'Dark');
      assert.match(selected(live), /Code color theme/u);
      live.send('\x1b[B'); await until(() => selected(live).includes('Set terminal colors'), 'Down skips the disabled variant');
      live.send('\x1b[A'); await until(() => selected(live).includes('Code color theme'), 'Up skips the disabled variant');
      if (mode === 'fullscreen') {
        const bounds = live.tidyFrame(), themeY = live.tidyRows().findIndex(row => row.includes('Code color theme'));
        live.send(`\x1b[<65;${bounds.left + 5};${themeY + 1}M`);
        await until(() => selected(live).includes('Set terminal colors'), 'wheel skips the disabled variant');
        live.send(`\x1b[<64;${bounds.left + 5};${themeY + 1}M`);
        await until(() => selected(live).includes('Code color theme'), 'reverse wheel skips the disabled variant');
        const y = live.tidyRows().findIndex(row => row.includes(variantLabel));
        live.send(`\x1b[<0;${bounds.left + 5};${y + 1}M\x1b[<0;${bounds.left + 5};${y + 1}m\x1b[B`);
        await until(() => selected(live).includes('Set terminal colors'), 'disabled click does not change the current selection');
        assert.deepEqual(readFileSync(config), originalConfig, 'disabled pointer input saves nothing');
        await live.selectTidyItem('Code color theme', false);
      }
      live.send('\r'); await until(() => live.tidyHeading('Code color theme') && live.tidyRows().some(row => row.includes('Follow Pi theme')), 'family picker');
      assert.ok(live.tidyRows().some(row => row.includes('(1/34)')), 'picker has 32 TUI families, Follow Pi and Back, not 64 palette variants');
      live.send('GitHub'); await until(() => selected(live).includes('GitHub'), 'one GitHub family is highlighted');
      assert.ok(!live.tidyRows().some(row => /GitHub (?:Dark|Light)/u.test(row)), 'variants are not separate family choices');
      assert.deepEqual(readFileSync(config), originalConfig, 'family preview and invalid-variant normalization do not rewrite configuration');
      await live.selectTidyItem('GitHub');
      assert.deepEqual(readConfig(), { syntaxTheme: { kind: 'theme', id: 'github' }, syntaxThemeVariant: 'dark', nativeHighlightingEnabled: false, future: { retained: true } });
      await live.selectTidyItem(variantLabel, false); live.send('\r');
      await until(() => readConfig().syntaxThemeVariant === 'light' && currentVariant('Light'), 'variant toggle confirms and saves Light');
      await live.closeTidyMenu();
      await assertOutputPalette(await live.capture('variant-light'), 'light');

      await live.command('/reload');
      const reloaded = await live.capture('variant-reloaded-light');
      await assertOutputPalette(reloaded, 'light'); assert.deepEqual(persisted(reloaded), persisted(initial));
      await live.tidyPage(['Code color theme', 'Follow Pi theme']);
      assert.deepEqual(readConfig().syntaxTheme, { kind: 'pi' }); assert.equal(readConfig().syntaxThemeVariant, 'light');
      await live.openTidyMenu(); await assertDisabled(live, dim, 'variant-disabled-remembered-light', 'Light');
      const piDark = { ...readConfig(), syntaxThemeVariant: 'dark' }, externalPi = JSON.stringify(piDark);
      writeFileSync(config, externalPi);
      await until(() => currentVariant('Dark'), 'variant-only external change refreshes Follow Pi memory');
      await assertDisabled(live, dim, 'variant-disabled-external-dark', 'Dark');
      assert.equal(readFileSync(config, 'utf8'), externalPi, 'watching applies defaults without writing back');
      await live.selectTidyItem('Code color theme'); live.send('GitHub');
      await until(() => selected(live).includes('GitHub'), 'remembered-dark family');
      await live.selectTidyItem('GitHub'); await live.closeTidyMenu();
      await assertOutputPalette(await live.capture('variant-dark'), 'dark');

      await live.openTidyMenu(); await live.selectTidyItem(variantLabel, false); live.send('\r');
      await until(() => readConfig().syntaxThemeVariant === 'light' && currentVariant('Light'), 'Light is live before the external legacy/default change');
      const externalAlias = JSON.stringify({ ...readConfig(), syntaxTheme: { kind: 'theme', id: 'github-light' }, syntaxThemeVariant: null });
      writeFileSync(config, externalAlias);
      await until(() => currentVariant('Dark') && live.tidyRows().some(row => row.includes('Code color theme') && row.includes('GitHub')), 'legacy family and unsupported variant');
      await live.closeTidyMenu(); await assertOutputPalette(await live.capture('variant-legacy-default-dark'), 'dark');
      assert.equal(readFileSync(config, 'utf8'), externalAlias, 'known legacy light never overrides default dark or triggers a migration write');
      await live.openTidyMenu(); await live.selectTidyItem(variantLabel, false); live.send('\r');
      await until(() => readConfig().syntaxTheme.id === 'github' && readConfig().syntaxThemeVariant === 'light', 'explicit change saves the canonical pair');
      await live.closeTidyMenu();
      const final = await live.capture('variant-final-light'), saved = readConfig();
      await assertOutputPalette(final, 'light');
      assert.deepEqual(persisted(final), persisted(initial)); assert.deepEqual(traffic(live, 2), originalTraffic);
      assert.deepEqual(readFileSync(initial.session), session);
      await live.close();

      const replay = new PiTerminal(`theme-variant-replay-${mode}`, { tidyUi: true, mode, session: initial.session, workspace: live.work, tidyUiSettings: saved });
      terminals.push(replay); await replay.ready(); await replay.resize(100, 30);
      const restored = await replay.capture('variant-restored-light'); await assertOutputPalette(restored, 'light');
      assert.deepEqual(persisted(restored), persisted(initial));
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      assert.deepEqual(readFileSync(initial.session), session);
      assert.equal(restored.extensionIssues.length, 0);
    } finally { await closeTerminals(terminals); }
  });


test('real CLI: an accepted enabled press survives a short-popup recenter onto the disabled variant', { timeout: 60000 }, async () => {
  const live = new PiTerminal('theme-variant-short-press', { tidyUi: true, mode: 'fullscreen',
    tidyUiSettings: { syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false, nativeHighlightingEnabled: false } });
  const config = join(live.agent, 'extensions/pi-tidy-ui/config.json');
  try {
    await live.ready(); await live.resize(100, 12); await live.openTidyMenu();
    await live.selectTidyItem('Status & troubleshooting', false);
    const rows = live.tidyRows(), y = rows.findIndex(row => row.includes('Set terminal colors from Pi theme'));
    assert.ok(y >= 0, 'the enabled terminal-color row is physically visible');
    const x = live.tidyFrame().left + 5;
    live.send(`\x1b[<0;${x};${y + 1}M`);
    await until(() => live.tidyRows()[y]?.includes(variantLabel), 'the accepted press recenters the disabled variant under its original coordinates');
    live.send(`\x1b[<0;${x};${y + 1}m`);
    await until(() => JSON.parse(readFileSync(config, 'utf8')).terminalColorsEnabled === true, 'release confirms the originally pressed enabled row');
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: true, nativeHighlightingEnabled: false });
    await live.closeTidyMenu();
    assert.equal(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
  } finally { await closeTerminals([live]); }
});


test('real CLI: a disabled-origin press stays inert across an external family confirmation', { timeout: 60000 }, async () => {
  const live = new PiTerminal('theme-variant-disabled-origin', { tidyUi: true, mode: 'fullscreen',
    tidyUiSettings: { syntaxTheme: { kind: 'pi' }, terminalColorsEnabled: false, nativeHighlightingEnabled: false } });
  const config = join(live.agent, 'extensions/pi-tidy-ui/config.json');
  try {
    await live.ready(); await live.resize(100, 30); await live.openTidyMenu();
    const y = live.tidyRows().findIndex(row => row.includes(variantLabel)); assert.ok(y >= 0);
    const x = live.tidyFrame().left + 5;
    live.send(`\x1b[<0;${x};${y + 1}M`); await live.settle();
    const external = JSON.stringify({ syntaxTheme: { kind: 'theme', id: 'github' }, syntaxThemeVariant: 'dark', terminalColorsEnabled: false, nativeHighlightingEnabled: false });
    writeFileSync(config, external);
    await until(() => live.tidyRows().some(row => row.includes('Code color theme') && row.includes('GitHub')), 'external confirmation enables the variant while the pointer is held');
    live.send(`\x1b[<0;${x};${y + 1}m`); await live.settle();
    assert.match(variantRow(live), /Code color variant\s+Dark/u, 'release cannot confirm a row that was disabled when pressed');
    assert.equal(readFileSync(config, 'utf8'), external, 'the rejected gesture does not rewrite the external confirmation');
    await live.selectTidyItem(variantLabel);
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).syntaxThemeVariant, 'light', 'a new enabled-origin gesture still works');
    await live.closeTidyMenu();
    assert.equal(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
  } finally { await closeTerminals([live]); }
});
