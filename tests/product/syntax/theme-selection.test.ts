import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_CATALOGUE, themeEntry } from '../../../src/themes/catalogue.ts';
import { resolveTheme } from '../../../src/themes/selection.ts';

const families = [...new Set(THEME_CATALOGUE.map(({ id }) => id.replace(/-(?:dark|light)$/u, '')))];

test('every family and variant resolves to its existing concrete palette asset', () => {
  assert.equal(families.length, 36);
  assert.equal(THEME_CATALOGUE.length, 72);
  for (const id of families) for (const variant of ['dark', 'light'] as const) {
    const concreteId = `${id}-${variant}`;
    const entry = themeEntry(concreteId);
    assert.ok(entry, `existing concrete asset ${concreteId}`);
    const resolved = resolveTheme({ kind: 'theme', id, variant });
    assert.deepEqual(resolved, {
      effective: { kind: 'theme', id: concreteId, label: entry.label, fingerprint: `owned-palette-v1:${concreteId}` },
      missing: false,
    }, `${id}/${variant} keeps the concrete palette identity ${concreteId}`);
  }
});
