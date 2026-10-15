import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component, OverlayOptions } from '@earendil-works/pi-tui';
import { withMenu } from './helpers/menu-driver.ts';

for (const dynamic of [false, true]) test(`menu driver resolves options once and retains ${dynamic ? 'live property' : 'callback snapshot'} sizing`, async () => {
  let width = 39, calls = 0;
  const ctx = { ui: { theme: { fg: (_: string, text: string) => text, bold: (text: string) => text } } } as unknown as ExtensionContext;
  const options = () => { calls++; return dynamic ? { get width() { return width; } } : { width }; };
  await withMenu(async (_args, context) => {
    await context.ui.custom<void>((_tui, _theme, _keys, done) => ({
      busy: false,
      render: () => ['Probe'],
      invalidate() {},
      handleInput(data: string) { if (data === '\x03') done(undefined); },
    }), { overlay: true, overlayOptions: options as () => OverlayOptions });
  }, ctx, async menu => {
    assert.equal(menu.width(), 39);
    width = 58;
    assert.equal(menu.width(), dynamic ? 58 : 39);
    assert.equal(calls, 1, 'actual Pi resolves callback-form options once, after the factory');
  });
});

test('SDK menu driver waits for actual action completion rather than a fixed number of event-loop turns', async () => {
  let completed = false;
  let action: Promise<void> | undefined;
  const ctx = { ui: { theme: { fg: (_role: string, text: string) => text }, custom() { throw new Error('Driver must supply the popup host'); } } } as unknown as ExtensionContext;
  const handler = async (_args: string, context: ExtensionContext) => {
    await context.ui.custom<void>((_tui, _theme, _keys, done) => {
      const component: Component & { busy: boolean } = {
        busy: false,
        render: () => ['Action'], invalidate() {},
        handleInput(data) {
          if (data === '\x03') { done(); return; }
          if (data !== '\r' || component.busy) return;
          component.busy = true;
          action = (async () => {
            for (let i = 0; i < 150; ++i) await turn();
            completed = true; component.busy = false;
          })();
        },
      };
      return component;
    }, { overlay: true, overlayOptions: { width: 40 } });
  };
  try {
    await withMenu(handler, ctx, async menu => { await menu.key('\r'); assert.equal(completed, true); });
  } finally { await action; }
});
