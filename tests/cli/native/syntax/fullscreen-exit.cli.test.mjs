import '../../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, savedThemeSession, syntaxReady, chooseTheme, settledStats, captureThenRenderDiagnostics,
  themeMarkers, themeForegrounds, expectedThemeColors, work, traffic, finish } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const cellStyle = cell => ({ text: cell.text, width: cell.width, fg: cell.fg, fgMode: cell.fgMode,
  bg: cell.bg, bgMode: cell.bgMode, bold: cell.bold, dim: cell.dim, italic: cell.italic,
  underline: cell.underline, inverse: cell.inverse });
function sourceCells(dump, sources) {
  return sources.map(text => {
    const y = dump.screen.findLastIndex(row => row.includes(text)); assert.ok(y >= 0, `complete physical source ${text}`);
    const x = dump.screen[y].indexOf(text);
    return { text, cells: dump.cells[y].slice(x, x + text.length).map(cellStyle) };
  });
}

for (const exitOutput of ['transcript', 'resume-hint']) test(`fullscreen exit: ${exitOutput} preserves ready syntax without new work`,
  { timeout: 90000 }, async () => {
    const saved = await savedThemeSession();
    const sources = [saved.cards[0].arguments.command, saved.cards[1].arguments.command,
      saved.cards[2].arguments.oldText, saved.cards[2].arguments.newText, saved.cards[3].arguments.content];
    const terminal = new PiTerminal(`syntax-exit-${exitOutput}`, { mode: 'fullscreen', session: saved.session,
      ...(exitOutput === 'resume-hint' ? { agentSettings: { fullscreenExitOutput: exitOutput } } : {}),
      extensions: [fixture], extraEnv: { ...descriptor, TIDY_UI_TEST_THEME_OBSERVE: '1' } });
    try {
      await terminal.ready(); await terminal.resize(100, 180); await syntaxReady(terminal); await chooseTheme(terminal, 1);
      const selection = await settledStats(terminal, 'exit-selected');
      const painted = await captureThenRenderDiagnostics(terminal, 'exit-ready-native'), beforeCells = sourceCells(painted, sources);
      assert.ok(await semanticPhaseReady(() => painted.sample, () => terminal.events(), themeMarkers, selection.client.effective.id),
        'every saved source and native style is ready');
      assert.deepEqual(themeForegrounds(painted), expectedThemeColors(terminal, 'initial', painted, selection.client.effective.id));
      assert.equal(painted.tools.length, 4); assert.deepEqual(traffic(terminal), [], 'restoring must execute no model or tool traffic');
      const session = readFileSync(saved.session); assert.deepEqual(session, saved.bytes);
      await terminal.observeAnimation(); const before = await settledStats(terminal, 'exit-warm');
      assert.deepEqual(work(before), work(painted.sample), 'explicit diagnostics do not complete additional natural-frame adoption');
      assert.equal(before.source.globalUnsettledJobs, 0); assert.equal(before.source.remoteLeases, 0);
      writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'process-exit');
      await terminal.quit('\x04');
      const final = terminal.captureScreen('exit-final', {});
      await finish(terminal);
      const after = JSON.parse(readFileSync(join(terminal.output, 'syntax-shutdown.json'), 'utf8'));
      assert.deepEqual(work(after), work(before), 'final output must reuse measured text, parsed scopes and resolved styles');
      const journal = readFileSync(join(terminal.output, 'events.jsonl'), 'utf8'); assert.ok(journal.endsWith('\n'));
      const events = journal.split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
      assert.equal(events.filter(event => event.type === 'syntax_native_dispatch' && event.phase === 'process-exit').length, 0);
      assert.deepEqual(events.filter(event => ['call', 'result', 'model_context'].includes(event.type)), []);
      assert.deepEqual(readFileSync(saved.session), session);
      if (exitOutput === 'transcript') assert.deepEqual(sourceCells(final, sources), beforeCells,
        'the actual final normal-screen transcript keeps all five source rows and their literal colors/attributes');
      console.log(JSON.stringify({ fullscreenExit: exitOutput, artifacts: terminal.output, node: before.node,
        before: work(before), after: work(after), sourceRows: exitOutput === 'transcript' ? beforeCells.map(({ text }) => text) : [] }));
    } finally { await closeTerminals([terminal]); rmSync(saved.directory, { recursive: true, force: true }); }
  });
