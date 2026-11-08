import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_CATALOGUE, themeEntry, themeFamilyId } from '../../../src/themes/catalogue.ts';
import { themePreferenceFromSettings } from '../../../src/settings.ts';
import { resolveTheme } from '../../../src/themes/selection.ts';

const families = [...new Set(THEME_CATALOGUE.map(({ id }) => id.replace(/-(?:dark|light)$/u, '')))];

test('every family and variant resolves to its existing concrete palette asset', () => {
  assert.equal(families.length, 32);
  assert.equal(THEME_CATALOGUE.length, 64);
  for (const id of families) for (const variant of ['dark', 'light'] as const) {
    const concreteId = `${id}-${variant}`;
    const entry = themeEntry(concreteId);
    assert.ok(entry, `existing concrete asset ${concreteId}`);
    const resolved = resolveTheme({ kind: 'theme', id, variant });
    assert.deepEqual(resolved, {
      effective: { kind: 'theme', id: concreteId, label: entry.label, fingerprint: `owned-palette-v2:${concreteId}` },
      missing: false,
    }, `${id}/${variant} keeps the concrete palette identity ${concreteId}`);
  }
});


test('removed GUI and transparent families remain missing selections rather than aliases for a TUI theme', () => {
  for (const id of ['amoled', 'oc-2', 'onedarkpro', 'shadesofpurple', 'lucent-orng']) {
    assert.equal(themeFamilyId(id), undefined, id);
    for (const variant of ['dark', 'light'] as const) {
      assert.equal(themeEntry(`${id}-${variant}`), undefined);
      assert.equal(themeFamilyId(`${id}-${variant}`), undefined);
      const selected = themePreferenceFromSettings({ kind: 'theme', id }, variant);
      assert.deepEqual(selected, { kind: 'theme', id, variant }, 'selection is preserved for the existing missing-theme notice');
      assert.equal(resolveTheme(selected).missing, true);
      assert.equal(resolveTheme(selected).effective.kind, 'pi');
    }
  }
  assert.equal(resolveTheme({ kind: 'theme', id: 'opencode', variant: 'dark' }).effective.id, 'opencode-dark');
});
