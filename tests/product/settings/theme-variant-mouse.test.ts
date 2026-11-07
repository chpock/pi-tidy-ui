import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { TidyMenu, type TidyMenuAction, type TidyMenuOwner, type TidyMenuSnapshot } from '../../../src/tidy-menu.ts';

const colors = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

test('disabled variant pointer gestures keep focus and confirmed preferences unchanged', () => {
  const calls: TidyMenuAction[] = [];
  const state: TidyMenuSnapshot = { appearanceEnabled: true, terminalColorsEnabled: false, nativeHighlightingEnabled: false,
    loggingEnabled: true, selected: { kind: 'pi', variant: 'dark' }, appearance: 'Active', terminalColors: 'Off' };
  const owner: TidyMenuOwner = { snapshot: () => state, prepareThemes: async () => {}, previewTheme() {},
    act: async action => { calls.push(action); return { ok: true }; }, cacheDetails: () => [] };
  const menu = new TidyMenu(owner, colors as any, () => {}, () => {}, () => 24);
  const render = () => menu.render(70).map(plain);
  const rows = render(), before = rows.find(row => row.includes('→ Code color theme'));
  assert.ok(before);
  const y = rows.findIndex(row => row.includes('Code color variant')); assert.ok(y >= 0);
  const event = { type: 'press' as const, button: 'left' as const, x: 4, y, screenX: 4, screenY: y,
    width: 70, height: rows.length, shift: false, alt: false, ctrl: false };
  menu.handleMouse(event); render(); menu.handleMouse({ ...event, type: 'click' });
  assert.equal(render().find(row => row.includes('→ ')), before, 'a disabled click does not focus another control');
  assert.equal(calls.length, 0);
  menu.handleInput('\x1b[B');
  assert.ok(render().some(row => row.includes('→ Set terminal colors from Pi theme')), 'the next Down skips the disabled row once');
  assert.equal(calls.length, 0);
  menu.dispose();
});
