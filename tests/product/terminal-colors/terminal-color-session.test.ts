import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { rgbColor, type Component, type TerminalColors as ReportedColors } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TerminalColorSession, terminalColorDiagnostics } from '../../../src/application/terminal-color-session.ts';
import { Root } from '../../fixtures/sdk-contract-support.ts';

function colorBinding() {
  const directory = mkdtempSync(join(tmpdir(), 'tidy-color-binding-'));
  const a = join(directory, 'a.json'), b = join(directory, 'b.json');
  writeFileSync(a, '{"export":{"pageBg":"#111111"}}');
  writeFileSync(b, '{"export":{"pageBg":"#222222"}}');
  const root = new Root(), packets: string[] = [], renders: boolean[] = [];
  let widget: Component | undefined, afterWrite: (() => void) | undefined;
  let late: ((colors: ReportedColors) => void) | undefined;
  Object.assign(root, { requestRender(force = false) { renders.push(force); },
    queryTerminalColors: (options: { onLateReply: (colors: ReportedColors) => void }) => {
      late = options.onLateReply; return new Promise(() => {});
    } });
  root.terminal.write = packet => { packets.push(packet); afterWrite?.(); };
  const stop = root.terminal.stop, start = root.terminal.start;
  const theme = { name: 'fixed', sourcePath: a, colors: { text: rgbColor(100, 100, 100) }, getFgAnsi: () => '\x1b[39m',
    fg: (_role: string, text: string) => text };
  const ctx = { mode: 'tui', ui: { theme, setWidget(_name: string, factory?: (tui: Root) => Component) {
    widget = factory?.(root);
  } } } as unknown as ExtensionContext;
  const binding = new TerminalColorSession({ context: () => ctx, appearanceEnabled: () => true, terminalColorsEnabled: () => true,
    diagnosticSink: () => undefined, journalSink: () => undefined, themeSetting: () => undefined,
    defaults: () => ({}), terminalLifecycle: () => ({ suspend() {}, resume() {} }) });
  return { root, ctx, binding, theme, b, packets, renders,
    widget: () => widget, afterWrite(callback: () => void) { afterWrite = callback; },
    reply() { late?.({}); }, hooksRestored: () => root.terminal.start === start && root.terminal.stop === stop,
    close() { binding.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

test('retired color widget and queued forced redraw cannot act as a replacement controller', async () => {
  const f = colorBinding();
  let retired: Component | undefined;
  try {
    f.afterWrite(() => {
      if (f.packets.length !== 1) return;
      queueMicrotask(() => {
        retired = f.widget(); f.binding.stop(true);
        f.theme.sourcePath = f.b; f.binding.start(f.ctx);
        retired?.render(80); retired?.invalidate();
      });
    });
    f.binding.start(f.ctx); await turn();
    assert.equal(f.widget() !== retired, true, 'the writer queued a real replacement before the old forced callback');
    assert.deepEqual(f.packets, ['\x1b]11;#111111\x07', '\x1b]11;#222222\x07']);
    assert.equal(f.renders.filter(force => force).length, 1, 'only the replacement is allowed to force a frame');
    assert.equal(f.binding.stats()?.sourceReads, 1); assert.equal(f.binding.status()?.background, '#222222');
    const before = f.binding.stats();
    for (let i = 0; i < 8; i++) { retired?.render(80); retired?.invalidate(); f.widget()?.render(80); }
    await turn();
    assert.deepEqual(f.binding.stats(), before); assert.equal(f.renders.filter(force => force).length, 1);
    f.binding.stop(); assert.equal(f.hooksRestored(), true);
  } finally { f.close(); }
});

test('live color binding and retained unresolved query callback do not retain its removed controller', async () => {
  const f = colorBinding();
  try {
    f.binding.start(f.ctx); await turn();
    assert.equal(f.binding.stats()?.reports, 1, 'positive control: a real unowned-default query is pending');
    assert.equal(terminalColorDiagnostics() !== undefined, true);
    f.binding.stop(true); assert.equal(f.widget(), undefined); assert.equal(f.hooksRestored(), true);
    let collected = false;
    for (let i = 0; i < 100; i++) {
      await turn(); global.gc!(); await turn();
      if (terminalColorDiagnostics() === undefined) { collected = true; break; }
    }
    assert.equal(collected, true, 'observation/query callbacks must reach the outgoing controller only weakly');
    f.reply(); await turn();
    assert.equal(f.binding.status(), undefined); assert.equal(f.renders.filter(force => force).length, 1);
    assert.equal(f.packets.length, 1);
  } finally { f.close(); }
});
