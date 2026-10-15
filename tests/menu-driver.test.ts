import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { OverlayOptions } from '@earendil-works/pi-tui';
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
