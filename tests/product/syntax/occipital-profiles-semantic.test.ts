import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTheme } from '../../../src/occipital/profiles.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';

const native = { id: 'bundled:example', label: 'Independent theme', fingerprint: 'b'.repeat(64) };
const pi = { id: 'pi', label: 'Pi palette', fingerprint: fingerprintRules(createPiRuleDefinition()) };

test('resolveTheme v3: Follow Pi comes from local generic declarations with an empty native catalogue', () => {
  assert.deepEqual(resolveTheme({ kind: 'pi' }, []), { selected: { kind: 'pi' }, effective: pi, missing: false });
});

test('resolveTheme v3: Follow Pi can rebind retained styles before discovery without claiming provider readiness', () => {
  assert.deepEqual(resolveTheme({ kind: 'pi' }, undefined), { selected: { kind: 'pi' }, effective: pi, missing: false });
  assert.deepEqual(resolveTheme({ kind: 'occipital', id: native.id }, undefined), {
    selected: { kind: 'occipital', id: native.id }, effective: undefined, missing: false,
  });
});

test('resolveTheme v3: missing independent theme falls back to local declarations without changing saved choice', () => {
  const selected = Object.freeze({ kind: 'occipital', id: native.id } as const);
  assert.deepEqual(resolveTheme(selected, []), { selected, effective: pi, missing: true });
  assert.deepEqual(resolveTheme(selected, [native]), { selected, effective: native, missing: false });
  assert.deepEqual(selected, { kind: 'occipital', id: native.id });
});

test('resolveTheme v3: catalogue labels cannot redefine the local Pi rule identity', () => {
  const impostor = { ...native, label: 'Pi palette' };
  const result = resolveTheme({ kind: 'pi' }, [impostor]);
  assert.deepEqual(result.effective, pi);
  assert.equal(result.missing, false);
  assert.notEqual(result.effective!.fingerprint, impostor.fingerprint);
});

test('resolveTheme v3: local rule identity is independent of unrelated native replacement and caller mutation', () => {
  const first = resolveTheme({ kind: 'pi' }, [native]);
  Object.assign(first.effective!, { id: 'modified', fingerprint: '0'.repeat(64) });
  assert.deepEqual(resolveTheme({ kind: 'pi' }, [{ ...native, fingerprint: 'c'.repeat(64) }]).effective, pi);
  assert.deepEqual(resolveTheme({ kind: 'pi' }, undefined).effective, pi);
});

test('resolveTheme v3: independent fingerprint replacement remains exact and detached', () => {
  const selected = { kind: 'occipital', id: native.id } as const;
  const profile = { ...native };
  const before = resolveTheme(selected, [profile]);
  profile.fingerprint = 'd'.repeat(64);
  const after = resolveTheme(selected, [profile]);
  assert.equal(before.effective!.fingerprint, native.fingerprint);
  assert.equal(after.effective!.fingerprint, profile.fingerprint);
  assert.notStrictEqual(after.effective, profile);
});
