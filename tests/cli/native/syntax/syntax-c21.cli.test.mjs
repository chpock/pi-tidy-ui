import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { sampleOwnedPalette } from '../../../../src/themes/owned-palette.ts';
import { THEME_CATALOGUE } from '../../../../src/themes/catalogue.ts';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { syntaxToolData as raw } from '../../../fixtures/syntax-tool-data.mjs';
import { nativeReady, semanticStyle, semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, inputs, settledStats, captureThenRenderDiagnostics, syntaxReady, until, work, body, traffic, persisted, finish, chooseTheme, expressionForeground } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const receipt = snapshot => ({ node: snapshot.node, counts: snapshot.counts, work: work(snapshot), leases: snapshot.source.remoteLeases, unsettled: snapshot.source.globalUnsettledJobs });
// Only Pi's independently timed fields differ between otherwise identical abort runs.
const assistants = dump => dump.branch.filter(entry => entry.type === 'message' && entry.message.role === 'assistant')
  .map(({ message: { timestamp, durationMs, ...message } }) => message);
const cellAt = (dump, marker) => {
  const y = dump.screen.findLastIndex(row => row.includes(marker));
  assert.ok(y >= 0, `physical ${marker}`);
  return dump.cells[y][dump.screen[y].indexOf(marker)];
};
const vector = cell => ({ fg: cell.fg, bg: cell.bg, bold: !!cell.bold, italic: !!cell.italic, underline: !!cell.underline, inverse: cell.inverse });
const rgb = ink => { assert.equal(ink.kind, 'rgb'); return ink.r * 65536 + ink.g * 256 + ink.b; };
function commandVector(terminal, dump, palette) {
  const resolved = semanticStyle(terminal.events(), 'STABLE_text'); assert.ok(resolved);
  const cell = cellAt(dump, 'STABLE_text'), expression = resolved.expression;
  const base = palette === 'pi' ? undefined : sampleOwnedPalette(palette, 'truecolor').roles.code;
  const attributes = (base?.attributes ?? 0) & ~expression.attribute_mask | expression.attributes & expression.attribute_mask;
  assert.equal(cell.fg, expressionForeground(expression, dump, palette, 'toolTitle'));
  assert.deepEqual([!!cell.bold, !!cell.italic, !!cell.underline], [!!(attributes & 1), !!(attributes & 2), !!(attributes & 4)]);
  assert.equal(cell.inverse, false);
  if (base) assert.equal(cell.bg, rgb(expression.background.kind === 'inherit' ? base.background : expression.background));
  return vector(cell);
}

for (const mode of ['fullscreen', 'regular']) test(`occipital C21: ${mode} live frozen Bash recolors via local palette and Pi changes without SOURCE thaw`,
  { timeout: 120000 }, async () => {
    const live = new PiTerminal(`c21-frozen-${mode}`, { mode, extensions: [fixture], extraEnv: { ...descriptor,
      TIDY_UI_TEST_THEME_OBSERVE: '1' } });
    const stock = new PiTerminal(`c21-frozen-stock-${mode}`, { mode, extraEnv: descriptor });
    const phase = name => writeFileSync(join(live.output, 'syntax-theme-phase'), name);
    let ordinal = 0;
    const ready = async palette => {
      const current = await settledStats(live, `frozen-ready-${ordinal++}`);
      assert.ok(await semanticPhaseReady(() => current, () => live.events(), ['STABLE_text'], palette), `frozen styles ${palette}`);
      return current;
    };
    try {
      for (const terminal of [live, stock]) {
        await terminal.ready(); await terminal.resize(100, 160);
        if (terminal === live) await syntaxReady(live);
        terminal.send('run bash-prefix-contract\r'); await terminal.event('bash_contract_prefix');
        await terminal.capture('physical-first-prefix');
        if (terminal === live) await ready('pi');
        terminal.send('\x1b'); await terminal.event('agent_end'); await terminal.settle();
      }
      const before = await settledStats(live, 'frozen-closed', s => nativeReady(s) && s.counts.closeRequests === 1 && s.source.remoteLeases === 0);
      assert.equal(before.node, inputs.node.version); assert.equal(before.counts.sourceRequests, 1);
      const baseline = await captureThenRenderDiagnostics(live, 'physical-frozen-pi'), reference = await stock.capture('physical-frozen-stock');
      const bytes = readFileSync(baseline.session), originalTraffic = traffic(live), piVector = commandVector(live, baseline, 'pi');
      assert.deepEqual(originalTraffic, traffic(stock)); assert.deepEqual(persisted(baseline), persisted(reference)); assert.deepEqual(raw(baseline), raw(reference));
      assert.deepEqual(assistants(baseline), assistants(reference)); assert.equal(assistants(baseline)[0].stopReason, 'aborted');
      await stock.close();
      assert.equal(stock.closed, true, 'completed stock abort is reaped before native theme work');
      assert.equal(originalTraffic.filter(e => e.type === 'call' || e.type === 'result').length, 0);
      assert.equal(originalTraffic.filter(e => e.type === 'model_context').length, 1);
      assert.equal(baseline.tools[0].args.command, ": 'STABLE_text e");
      assert.equal(baseline.tools[0].argsComplete, false); assert.equal(baseline.tools[0].executionStarted, false);
      assert.ok(body(baseline)[0].lines.some(row => row.includes('[error: incomplete tool call]')));
      const paletteId = 'catppuccin-dark', palette = THEME_CATALOGUE.find(theme => theme.id === paletteId); assert.ok(palette);
      await chooseTheme(live, paletteId); const selected = await ready(paletteId);
      const themed = await captureThenRenderDiagnostics(live, 'physical-frozen-owned'), ownedVector = commandVector(live, themed, paletteId);
      assert.notDeepEqual(ownedVector, piVector, 'owned palette changes the physical command cells');
      assert.equal(selected.counts.sourceRequests, before.counts.sourceRequests); assert.equal(selected.source.preparedBytes, before.source.preparedBytes);
      assert.equal(selected.counts.styleRequests, before.counts.styleRequests, 'generic STYLE output is shared by every palette');
      const owned = themed.sample;
      phase('cached-pi'); await chooseTheme(live, 'pi'); await ready('pi');
      const returned = await captureThenRenderDiagnostics(live, 'physical-frozen-return-pi'); assert.deepEqual(commandVector(live, returned, 'pi'), piVector);
      const cached = returned.sample; assert.equal(cached.counts.styleRequests, owned.counts.styleRequests, 'all palettes reuse generic STYLE output');
      await live.command('/tidy-ui-theme light'); await ready('pi');
      const light = await captureThenRenderDiagnostics(live, 'physical-frozen-light'), lightVector = commandVector(live, light, 'pi');
      assert.notEqual(lightVector.fg, piVector.fg, 'compatible Follow Pi binding change reaches physical command ink');
      const rebound = light.sample; assert.equal(rebound.counts.styleRequests, cached.counts.styleRequests, 'compatible binding change is local');
      phase('cached-owned'); await chooseTheme(live, paletteId); await ready(paletteId);
      const repeated = await captureThenRenderDiagnostics(live, 'physical-frozen-cached-owned'); assert.deepEqual(commandVector(live, repeated, paletteId), ownedVector);
      const materialized = repeated.sample;
      assert.equal(materialized.counts.styleRequests, rebound.counts.styleRequests, 'owned palette reuses generic STYLE output');
      for (const width of [60, 100, 100]) { await live.resize(width, 160); commandVector(live, await captureThenRenderDiagnostics(live, `physical-frozen-warm-${ordinal++}`), paletteId); }
      const warm = await settledStats(live, 'frozen-warm'); assert.deepEqual(work(warm), work(materialized));
      for (const snapshot of [selected, owned, cached, rebound, materialized, warm]) {
        assert.equal(snapshot.counts.sourceRequests, before.counts.sourceRequests); assert.equal(snapshot.counts.closeRequests, 1);
        assert.equal(snapshot.source.preparedBytes, before.source.preparedBytes); assert.equal(snapshot.counts.acquisitions, 1);
        assert.equal(snapshot.counts.piCaptures, 0); assert.equal(snapshot.counts.piBridges, 0); assert.equal(snapshot.source.remoteLeases, 0);
      }
      assert.equal(warm.source.globalUnsettledJobs, 0);
      const final = await captureThenRenderDiagnostics(live, 'physical-frozen-final'); assert.deepEqual(raw(final), raw(baseline)); assert.deepEqual(body(final), body(baseline));
      assert.deepEqual(traffic(live), originalTraffic); assert.deepEqual(readFileSync(baseline.session), bytes);
      console.log(JSON.stringify({ c21Frozen: live.output, stock: stock.output, mode, node: warm.node, observations: [before, selected, owned, cached, rebound, warm].map(receipt), piVector, ownedVector, lightVector }));
      await live.quit('\x04'); await finish(live);
    } finally { await closeTerminals([live, stock]); }
  });

const output = 'STABLE_text ' + 'o'.repeat(2000), reminder = 'STABLE_text ' + 'r'.repeat(2000);
function longCard(dump, expanded) {
  assert.equal(dump.tools.length, 1); const tool = dump.tools[0]; assert.equal(tool.expanded, expanded);
  const lines = tool.lines.map(plain), contentWidth = dump.width - 2 * dump.outputPad - 3;
  const rows = text => Array.from({ length: Math.ceil(text.length / contentWidth) }, (_, i) => text.slice(i * contentWidth, (i + 1) * contentWidth));
  const sections = [output, '<system-reminder>\n' + reminder + '\n</system-reminder>'];
  for (const text of sections) {
    const expected = text.split('\n').flatMap(rows), visible = expanded ? expected : expected.slice(0, 10);
    const start = lines.findIndex(row => row.slice(dump.outputPad + 2, dump.outputPad + 2 + visible[0].length) === visible[0]);
    assert.ok(start >= 0, 'independent output/reminder preview start');
    assert.deepEqual(lines.slice(start, start + visible.length).map((row, i) => row.slice(dump.outputPad + 2, dump.outputPad + 2 + visible[i].length)), visible);
    if (!expanded) assert.ok(lines[start + 10].includes('Click to expand'), 'each section has its own ten-visual-row overflow');
  }
  assert.equal(lines.filter(row => row.includes('Click to expand')).length, expanded ? 0 : 2);
  assert.ok(dump.tools.every(t => !('tinyLines' in t) && !('narrowLines' in t)));
  const anchor = lines.findIndex(row => row.includes('$ ')), screen = dump.screen.findIndex(row => row.trimEnd() === lines[anchor].trimEnd());
  assert.ok(screen >= anchor, 'complete actual card fits the physical viewport');
  assert.deepEqual(dump.screen.slice(screen - anchor, screen - anchor + lines.length).map(row => row.trimEnd()), lines.map(row => row.trimEnd()), 'every preview/expanded glyph is physically painted');
}
for (const mode of ['fullscreen', 'regular']) test(`occipital C21: ${mode} builtin long single-line output and independent reminder preview expand completely`,
  { timeout: 120000 }, async () => {
    const live = new PiTerminal(`c21-long-${mode}`, { mode, extensions: [fixture], extraEnv: descriptor });
    const stock = new PiTerminal(`c21-long-stock-${mode}`, { mode, extraEnv: descriptor });
    try {
      for (const terminal of [live, stock]) { await terminal.ready(); await terminal.resize(100, 160); if (terminal === live) await syntaxReady(live); await terminal.run('syntax-long-output'); }
      await settledStats(live, 'long-ready', nativeReady);
      const collapsed = await captureThenRenderDiagnostics(live, 'physical-long-collapsed'), reference = await stock.capture('physical-long-stock'); longCard(collapsed, false);
      const bytes = readFileSync(collapsed.session), originalTraffic = traffic(live);
      assert.equal(collapsed.tools[0].content[0].text, output + '\n\n<system-reminder>\n' + reminder + '\n</system-reminder>\n');
      assert.deepEqual(originalTraffic, traffic(stock)); assert.deepEqual(persisted(collapsed), persisted(reference)); assert.deepEqual(raw(collapsed), raw(reference));
      assert.equal(originalTraffic.filter(e => e.type === 'call').length, 1); assert.equal(originalTraffic.filter(e => e.type === 'result').length, 1);
      assert.equal(originalTraffic.filter(e => e.type === 'model_context').length, 2);
      await stock.close();
      const cold = collapsed.sample; assert.equal(cold.node, inputs.node.version); assert.ok(cold.localWork.sourceSegments > 0);
      for (const width of [60, 100]) { await live.resize(width, 160); longCard(await captureThenRenderDiagnostics(live, `physical-long-preview-${width}`), false); }
      assert.deepEqual(work(await settledStats(live, 'long-preview-warm')), work(cold));
      if (mode === 'fullscreen') {
        const shown = await live.capture('physical-long-click-target'), y = shown.screen.findIndex(row => row.includes('Click to expand')); assert.ok(y >= 0);
        const x = shown.screen[y].indexOf('Click to expand'); live.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`); await live.settle();
      } else { live.send('\x0f'); await live.settle(); }
      const expanded = await captureThenRenderDiagnostics(live, 'physical-long-expanded'); longCard(expanded, true);
      for (const marker of ['STABLE_text o', '<system-reminder>', 'STABLE_text r', '</system-reminder>']) {
        const cell = cellAt(expanded, marker), role = marker === 'STABLE_text o' ? 'toolOutput' : 'muted';
        const fg = expanded.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(fg);
        const bg = expanded.backgroundStyles.toolPendingBg.match(/48;2;(\d+);(\d+);(\d+)m/); assert.ok(bg);
        assert.equal(cell.fg, Number(fg[1]) * 65536 + Number(fg[2]) * 256 + Number(fg[3]));
        assert.equal(cell.bg, Number(bg[1]) * 65536 + Number(bg[2]) * 256 + Number(bg[3]));
        assert.deepEqual([!!cell.bold, !!cell.italic, !!cell.underline, cell.inverse], [false, false, false, false]);
      }
      const materialized = expanded.sample;
      for (const width of [60, 100]) { await live.resize(width, 160); longCard(await captureThenRenderDiagnostics(live, `physical-long-expanded-${width}`), true); }
      assert.deepEqual(work(await settledStats(live, 'long-expanded-warm')), work(materialized)); assert.deepEqual(work(materialized), work(cold));
      if (mode === 'fullscreen') {
        // Native double-click selection must not consume the second primary click.
        await new Promise(resolve => setTimeout(resolve, 520));
        const shown = await live.capture('physical-long-collapse-target'), y = shown.screen.findIndex(row => row.includes('$ '));
        assert.ok(y >= 0); live.send(`\x1b[<0;4;${y + 1}M\x1b[<0;4;${y + 1}m`);
      } else live.send('\x0f');
      await live.settle(); const recollapsed = await captureThenRenderDiagnostics(live, 'physical-long-recollapsed'); longCard(recollapsed, false);
      assert.deepEqual(body(recollapsed), body(collapsed)); assert.deepEqual(raw(recollapsed), raw(collapsed));
      assert.deepEqual(readFileSync(collapsed.session), bytes); assert.deepEqual(traffic(live), originalTraffic);
      assert.equal(materialized.counts.piCaptures, 0); assert.equal(materialized.counts.piBridges, 0);
      assert.equal(materialized.source.globalUnsettledJobs, 0); assert.equal(materialized.source.remoteLeases, 0);
      console.log(JSON.stringify({ c21Long: live.output, stock: stock.output, mode, node: cold.node, outputUnits: output.length, reminderUnits: reminder.length,
        expansion: mode === 'fullscreen' ? 'physical-primary-click' : 'native-Ctrl+O', cold: receipt(cold), materialized: receipt(materialized), warmDelta: 0,
        limit: 'Physical correctness and no remeasurement only; bounded hidden reflow/paint is established by the unchanged card-layout kernel numeric controls, not output length.' }));
      await live.quit('\x04'); await finish(live);
    } finally { await closeTerminals([live, stock]); }
  });
