import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { SEMANTIC_REGIONS } from '../../../src/syntax/semantic-rules.ts';
import { parseOwnedPaletteData, validateOwnedPaletteData } from '../../../src/themes/owned-palette.ts';
import { outputInk } from '../../../src/syntax/pi-color.ts';
import { rgbColor } from '@earendil-works/pi-tui';
import { samplePiPalette } from '../../../src/syntax/pi-palette.ts';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

const roleNames = ['panel', 'plain', 'code', 'output', 'empty', 'padding', 'service', 'muted', 'footer', 'reminder',
  'overflow', 'diagnostic', 'title', 'prompt', 'frame', 'error', 'errorFrame', 'warning', 'gutter', 'numbers',
  'addedCode', 'addedGutter', 'addedSign', 'removedCode', 'removedGutter', 'removedSign', 'contextCode', 'contextGutter'];
const style = (foreground: string, background: string, attributes: string[] = []) => ({ foreground, background, attributes });
function input(): any {
  return { revision: 2, id: 'github-dark', label: 'GitHub Dark',
    source: { repository: 'anomalyco/opencode', commit: '810c0eba1a7348036f8bdf61e6632d0c36c6876c',
      path: 'packages/tui/src/theme/assets/github.json', variant: 'dark' },
    regions: Object.fromEntries(SEMANTIC_REGIONS.map(region => [region, { foreground: '#c9d1d9', attributes: [] }])),
    roles: Object.fromEntries(roleNames.map(role => [role, style('#c9d1d9', '#010409', role === 'errorFrame' ? ['bold'] : [])])) };
}
function ink(hex: string, mode: 'truecolor' | '256color') {
  const n = Number.parseInt(hex.slice(1), 16);
  return outputInk(rgbColor(n >>> 16, n >>> 8 & 255, n & 255), mode);
}

test('TUI role materialization preserves independent context, code, gutter and sign colors without contrast correction', () => {
  const value = input();
  value.roles.numbers = style('#8b949e', '#010409');
  value.roles.contextCode = style('#c9d1d9', '#161b22');
  value.roles.contextGutter = style('#95999e', '#161b22');
  value.roles.addedCode = style('#c9d1d9', '#033a16');
  value.roles.addedGutter = style('#95999e', '#033a16');
  value.roles.addedSign = style('#3fb950', '#033a16');
  value.roles.removedCode = style('#c9d1d9', '#67060c');
  value.roles.removedGutter = style('#95999e', '#67060c');
  value.roles.removedSign = style('#f85149', '#67060c');
  assert.deepEqual([...CARD_ROLES].sort(), [...roleNames].sort());
  for (const mode of ['truecolor', '256color'] as const) {
    const parsed = parseOwnedPaletteData(value, value.id, mode);
    for (const role of roleNames) {
      const expected = value.roles[role], actual = parsed.roles[role as keyof typeof parsed.roles];
      assert.deepEqual(actual.foreground, ink(expected.foreground, mode), `${mode}/${role}/foreground`);
      assert.deepEqual(actual.background, ink(expected.background, mode), `${mode}/${role}/background`);
      assert.equal(actual.attributes, role === 'errorFrame' ? 1 : 0);
      assert.ok(Object.isFrozen(actual));
    }
    value.roles.contextCode.background = '#ffffff';
    assert.deepEqual(parsed.roles.contextCode.background, ink('#161b22', mode), 'compiled roles detach from parsed file data');
    value.roles.contextCode.background = '#161b22';
  }
});

test('TUI role schema rejects old GUI provenance and incomplete, extra or malformed role data', () => {
  const bad: any[] = [];
  const old = input(); old.revision = 1; bad.push(old);
  const gui = input(); gui.source.path = 'packages/ui/src/theme/themes/github.json'; bad.push(gui);
  const variant = input(); variant.source.variant = 'light'; bad.push(variant);
  const donor = input(); donor.source.path = 'packages/tui/src/theme/assets/gruvbox.json'; bad.push(donor);
  const missing = input(); delete missing.roles.contextCode; bad.push(missing);
  const extra = input(); extra.roles.unused = style('#ffffff', '#000000'); bad.push(extra);
  const alpha = input(); alpha.roles.addedCode.background = '#00ff0080'; bad.push(alpha);
  const extraStyle = input(); extraStyle.roles.addedCode.extra = true; bad.push(extraStyle);
  const type = input(); type.roles.numbers.attributes = ['italic']; bad.push(type);
  const bold = input(); bold.roles.errorFrame.attributes = []; bad.push(bold);
  for (const value of bad) assert.throws(() => validateOwnedPaletteData(value, value.id), /invalid owned palette data/);
});

test('Follow Pi context roles are exact existing code and number styles in both output modes', () => {
  for (const name of ['dark', 'light']) for (const mode of ['truecolor', '256color'] as const) {
    const palette = samplePiPalette(getThemeByName(name)!, mode);
    assert.deepEqual(palette.roles.contextCode, palette.roles.code, `${name}/${mode}/code`);
    assert.deepEqual(palette.roles.contextGutter, palette.roles.numbers, `${name}/${mode}/numbers`);
  }
});
