import assert from 'node:assert/strict';
import { setImmediate as turn, setTimeout as pause } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import type { Component, OverlayOptions } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface MenuDriver {
  text(): string;
  width(): number;
  key(data: string): Promise<void>;
  input(data: string): void;
  select(label: string): Promise<void>;
}
/** SDK harness adapter: actual popup and public input, never its private action owner. */
export async function withMenu(handler: (args: string, ctx: ExtensionContext) => Promise<void>, ctx: ExtensionContext,
  drive: (menu: MenuDriver) => Promise<void> = async () => {}): Promise<string> {
  const descriptor = Object.getOwnPropertyDescriptor(ctx.ui, 'custom');
  let component: Component | undefined, finish: (() => void) | undefined;
  let overlayOptions: OverlayOptions | undefined;
  const theme = { fg: ctx.ui.theme.fg.bind(ctx.ui.theme), bold: ctx.ui.theme.bold?.bind(ctx.ui.theme) ?? ((text: string) => text) };
  Object.defineProperty(ctx.ui, 'custom', { configurable: true, value: (factory: Function, options: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions) }) => {
    assert.equal(options.overlay, true);
    return new Promise<void>(resolve => {
      finish = resolve;
      component = factory({ terminal: { rows: 400 }, requestRender() {} }, theme, {}, resolve);
      overlayOptions = typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions;
    });
  } });
  const opened = handler('', ctx);
  const text = () => {
    assert.ok(component, 'the public command must open one custom popup');
    return component.render(1000).map(stripVTControlCharacters)
      .map(row => row.startsWith('│') ? row.slice(1, -1).trimEnd() : row).join('\n');
  };
  const settle = async () => {
    // A pending filesystem action is not bounded by a count of event-loop turns.
    const deadline = Date.now() + 5000;
    do {
      await turn(); const rendered = text();
      if (!rendered) return;
      // Settings actions are silent; wait for actual completion, not removed UI text.
      const busy = Reflect.get(component!, 'busy');
      assert.equal(typeof busy, 'boolean', 'SDK probe must observe the real pending-action flag');
      if (!busy && !/Loading saved code theme…/u.test(rendered)) return;
      await pause(5);
    } while (Date.now() < deadline);
    assert.fail('Popup action did not settle');
  };
  const key = async (data: string) => { text(); component!.handleInput?.(data); await settle(); text(); };
  try {
    for (let i = 0; i < 100 && !component; i++) await turn();
    await settle();
    await drive({ text, key, width() {
      assert.equal(typeof overlayOptions?.width, 'number');
      return overlayOptions!.width as number;
    }, input(data) { text(); component!.handleInput?.(data); }, async select(label: string) {
      for (let i = 0; i < 100; i++) {
        if (text().split('\n').some(row => row.startsWith('→ ') && row.slice(2).startsWith(label))) { await key('\r'); return; }
        await key('\x1b[B');
      }
      assert.fail(`Missing popup item ${label}: ${text()}`);
    } });
    return text();
  } finally {
    component?.handleInput?.('\x03'); finish?.(); await opened;
    if (descriptor) Object.defineProperty(ctx.ui, 'custom', descriptor); else Reflect.deleteProperty(ctx.ui, 'custom');
  }
}

export async function menuPage(handler: Parameters<typeof withMenu>[0], ctx: ExtensionContext, path: string[] = []): Promise<string> {
  return withMenu(handler, ctx, async menu => { for (const label of path) await menu.select(label); });
}

/** Requested-state controls used by pre-existing ownership regressions. */
export async function setAppearance(handler: Parameters<typeof withMenu>[0], ctx: ExtensionContext, enabled: boolean): Promise<string> {
  return withMenu(handler, ctx, async menu => {
    const value = menu.text().split('\n').find(row => /Tidy UI appearance/u.test(row))!;
    if (value.trimEnd().endsWith(enabled ? 'Off' : 'On')) await menu.select('Tidy UI appearance');
    else if (enabled) { await menu.select('Status & troubleshooting'); await menu.select('Reapply Tidy UI appearance'); }
  });
}

export async function setColors(handler: Parameters<typeof withMenu>[0], ctx: ExtensionContext, enabled: boolean): Promise<string> {
  return withMenu(handler, ctx, async menu => {
    const value = menu.text().split('\n').find(row => /Set terminal colors from Pi theme/u.test(row))!;
    if (value.trimEnd().endsWith(enabled ? 'Off' : 'On')) await menu.select('Set terminal colors from Pi theme');
    else if (enabled) { await menu.select('Status & troubleshooting'); await menu.select('Reapply terminal colors'); }
  });
}

export async function setLogging(handler: Parameters<typeof withMenu>[0], ctx: ExtensionContext, enabled: boolean): Promise<string> {
  return withMenu(handler, ctx, async menu => {
    await menu.select('Status & troubleshooting'); await menu.select('Diagnostic logs');
    const value = menu.text().split('\n').find(row => /Record diagnostic logs/u.test(row))!;
    if (value.trimEnd().endsWith(enabled ? 'Off' : 'On')) await menu.select('Record diagnostic logs');
    else if (enabled && /Retry recording/u.test(menu.text())) await menu.select('Retry recording');
  });
}
