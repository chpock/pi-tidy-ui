import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { nativeReady } from '../../../fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, captureThenRenderDiagnostics, chooseTheme, settledStats, persisted, until, finish } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const rgb = hex => Number.parseInt(hex.replace('#', ''), 16);

async function savedCards() {
  const directory = await mkdtemp(resolve('.test-artifacts/tui-palette-'));
  const manager = SessionManager.create(directory, join(directory, 'sessions'));
  manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const cards = [
    { name: 'write', args: { path: 'tui-plain.ts', content: '// TUI_PLAIN\nconst TUI_WRITE=3;' }, details: {} },
    { name: 'edit', args: { path: 'tui-diff.ts', oldText: '// TUI_CONTEXT\nconst TUI_OLD=1;', newText: '// TUI_CONTEXT\nconst TUI_NEW=2;' },
      details: { diff: ' 1 // TUI_CONTEXT\n-2 const TUI_OLD=1;\n+2 const TUI_NEW=2;' } },
    { name: 'bash', args: { command: 'printf "TUI_BASH"; # TUI_COMMENT' }, details: { exit_code: 0 } },
  ];
  for (const [i, card] of cards.entries()) {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `saved TUI palette card ${i}` }], timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `tui-${i}`, name: card.name, arguments: card.args }],
      api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: 'toolUse', timestamp: Date.now() });
    manager.appendMessage({ role: 'toolResult', toolCallId: `tui-${i}`, toolName: card.name, content: [{ type: 'text', text: `saved TUI result ${i}` }], details: card.details, isError: false, timestamp: Date.now() });
  }
  const session = manager.getSessionFile();
  return { directory, session, bytes: readFileSync(session) };
}

// Independently transcribed from pinned TUI assets, not the generated palettes.
const expected = {
  'github-dark': { panel: '#010409', context: '#010409', added: '#033a16', removed: '#67060c', addedGutter: '#033a16', removedGutter: '#67060c',
    numbers: '#8b949e', diffNumbers: '#95999e', addedSign: '#3fb950', removedSign: '#f85149', comment: '#8b949e' },
  'vercel-light': { panel: '#fafafa', context: '#ffffff', added: '#e6f9e9', removed: '#fdeced', addedGutter: '#d6f5d6', removedGutter: '#ffe5e5',
    numbers: '#666666', diffNumbers: '#666666', addedSign: '#46a758', removedSign: '#e5484d', comment: '#888888' },
  'opencode-dark': { panel: '#141414', context: '#141414', added: '#20303b', removed: '#37222c', addedGutter: '#1b2b34', removedGutter: '#2d1f26',
    numbers: '#808080', diffNumbers: '#8f8f8f', addedSign: '#b8db87', removedSign: '#e26a75', comment: '#808080' },
};

function row(dump, marker) {
  const y = dump.screen.findIndex(text => text.includes(marker));
  assert.ok(y >= 0, `physical ${marker} row`);
  return { text: dump.screen[y], cells: dump.cells[y], x: dump.screen[y].indexOf(marker) };
}
function assertColors(dump, id, syntax = true) {
  const e = expected[id], plain = row(dump, '// TUI_PLAIN'), context = row(dump, '// TUI_CONTEXT');
  assert.equal(plain.cells[plain.x].bg, rgb(e.panel), `${id}/ordinary code background`);
  assert.equal(context.cells[context.x].bg, rgb(e.context), `${id}/unchanged diff background`);
  for (const [r, foreground, background] of [[plain, e.numbers, e.panel], [context, e.diffNumbers, e.context]]) {
    const x = r.text.lastIndexOf('1', r.x - 1); assert.ok(x >= 0, 'physical line number');
    assert.equal(r.cells[x].fg, rgb(foreground), `${id}/number foreground`);
    assert.equal(r.cells[x].bg, rgb(background), `${id}/number background`);
  }
  for (const [marker, sign, background, gutter, foreground] of [
    ['const TUI_NEW', '+', e.added, e.addedGutter, e.addedSign],
    ['const TUI_OLD', '-', e.removed, e.removedGutter, e.removedSign],
  ]) {
    const changed = row(dump, marker), x = changed.text.lastIndexOf(sign, changed.x - 1);
    assert.ok(x >= 0, 'physical diff sign');
    assert.equal(changed.cells[changed.x].bg, rgb(background), `${id}/${sign}/code background`);
    assert.equal(changed.cells[x].bg, rgb(gutter), `${id}/${sign}/gutter background`);
    assert.equal(changed.cells[x].fg, rgb(foreground), `${id}/${sign}/sign foreground`);
  }
  if (syntax) for (const r of [plain, context, row(dump, '# TUI_COMMENT')]) {
    assert.equal(r.cells[r.x].fg, rgb(e.comment), `${id}/TUI comment foreground`);
    assert.ok(r.cells[r.x].italic, `${id}/TUI comment italic`);
  }
}
function sourceWork(stats) {
  return { requests: stats.counts.sourceRequests, styles: stats.counts.styleRequests, pi: stats.counts.piBridges,
    dispatches: stats.source.dispatches, lines: stats.source.committedLineCalls, bytes: stats.source.committedLineBytes,
    tails: stats.source.tailCalls, prepared: stats.source.preparedBytes };
}

for (const mode of ['fullscreen', 'regular']) test(`TUI palettes CLI: ${mode} authored code/context/gutters/fonts, source reuse, native Off and saved replay`,
  { timeout: 120000 }, async () => {
    const saved = await savedCards(), terminals = [];
    const create = (label, config) => {
      const terminal = new PiTerminal(`tui-palette-${mode}-${label}`, { mode, session: saved.session, dimensions: { columns: 100, rows: 100 },
        extensions: [fixture], extraEnv: { ...descriptor, TIDY_UI_TEST_CARD_OBSERVE: '1', TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify(config) } });
      terminals.push(terminal); return terminal;
    };
    try {
      const live = create('native', { syntaxTheme: { kind: 'theme', id: 'github' }, syntaxThemeVariant: 'dark' });
      await live.ready();
      await settledStats(live, 'tui-initial', s => nativeReady(s) && s.client.effective.id === 'github-dark');
      const initial = await captureThenRenderDiagnostics(live, 'tui-github'); assertColors(initial, 'github-dark');
      const baseline = sourceWork(initial.sample), original = persisted(initial);
      assert.ok(baseline.dispatches > 0); assert.equal(baseline.pi, 0);
      for (const id of ['vercel-light', 'opencode-dark', 'github-dark']) {
        await chooseTheme(live, id);
        await settledStats(live, `tui-ready-${id}`, s => nativeReady(s) && s.client.effective.id === id);
        const dump = await captureThenRenderDiagnostics(live, `tui-${id}`); assertColors(dump, id);
        assert.deepEqual(sourceWork(dump.sample), baseline, 'changing owned TUI paint reuses exact SOURCE/STYLE work');
        assert.deepEqual(persisted(dump), original);
      }
      await live.resize(60, 100); await captureThenRenderDiagnostics(live, 'tui-narrow'); await live.resize(100, 100);
      const warm = await captureThenRenderDiagnostics(live, 'tui-warm'); assertColors(warm, 'github-dark');
      assert.deepEqual(sourceWork(warm.sample), baseline, 'warm frames and resize dispatch no syntax work');
      assert.equal(live.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      assert.deepEqual(readFileSync(saved.session), saved.bytes, 'replay rendering does not rewrite saved traffic');
      await live.openTidyMenu(); await live.selectTidyItem('Status & troubleshooting'); await live.selectTidyItem('Use Occipital highlighting');
      await until(async () => (await live.completeTidyRows()).some(text => /Use Occipital highlighting\s+Off/u.test(text)), 'native Off');
      await live.closeTidyMenu();
      const disabledCapture = await live.captureSettled('tui-disabled'), disabled = disabledCapture.sample;
      assert.equal(disabled.client.enabled, false);
      await live.waitForProgress(() => ['// TUI_PLAIN', '// TUI_CONTEXT'].every(marker => live.screen().some(line => line.includes(marker))), 'native-Off file publication');
      assertColors(await live.captureSettled('tui-disabled-published'), 'github-dark', false);
      await chooseTheme(live, 'vercel-light');
      const off = await captureThenRenderDiagnostics(live, 'tui-off-owned'); assertColors(off, 'vercel-light', false);
      assert.equal(off.sample.counts.acquisitions, disabled.counts.acquisitions, 'owned palette selection does not restart disabled native');
      assert.deepEqual(sourceWork(off.sample), sourceWork(disabled), 'native-Off recoloring performs no native or Pi classification');
      await finish(live);
      const replay = create('restored', { syntaxTheme: { kind: 'theme', id: 'vercel' }, syntaxThemeVariant: 'light' });
      await replay.ready(); await settledStats(replay, 'tui-replay-ready', s => nativeReady(s) && s.client.effective.id === 'vercel-light');
      const restored = await captureThenRenderDiagnostics(replay, 'tui-restored'); assertColors(restored, 'vercel-light');
      assert.deepEqual(persisted(restored), original);
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      assert.deepEqual(readFileSync(saved.session), saved.bytes);
      console.log(JSON.stringify({ mode, initial: live.output, replay: replay.output, sourceWork: baseline, themeSourceDelta: 0, resizeSourceDelta: 0 }));
      await finish(replay);
    } finally {
      await runCleanupSteps(() => closeTerminals(terminals), () => rm(saved.directory, { recursive: true, force: true }));
    }
  });
