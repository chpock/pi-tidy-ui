import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyntaxTheme } from '../../../src/settings.ts';
import type { ProfileDescription } from '../../../src/occipital/protocol.ts';
import { resolveTheme } from '../../../src/occipital/profiles.ts';

const pi = { id: 'pi', label: 'Pi palette', fingerprint: 'a'.repeat(64) };
const native = { id: 'custom:opaque-17', label: 'Independent theme', fingerprint: 'b'.repeat(64) };

test('resolveTheme: default Pi selection uses the exact pi profile, not catalogue order or label', () => {
  const impostor = { id: 'bundled:Pi', label: 'Pi palette', fingerprint: 'c'.repeat(64) };
  assert.deepEqual(resolveTheme({ kind: 'pi' }, [impostor, native, pi]), {
    selected: { kind: 'pi' }, effective: pi, missing: false,
  });
});

test('resolveTheme: present independent selection uses its exact ID and current fingerprint', () => {
  const selected: SyntaxTheme = { kind: 'occipital', id: native.id };
  assert.deepEqual(resolveTheme(selected, [pi, native]), { selected, effective: native, missing: false });
});

test('resolveTheme: absent independent selection falls back to pi without resetting the preference', () => {
  const selected: SyntaxTheme = { kind: 'occipital', id: native.id };
  assert.deepEqual(resolveTheme(selected, [pi]), { selected, effective: pi, missing: true });
  assert.deepEqual(selected, { kind: 'occipital', id: native.id });
});

for (const selected of [{ kind: 'pi' }, { kind: 'occipital', id: native.id }] as const) {
  test(`resolveTheme: unready provider preserves ${selected.kind} selection without reporting a missing theme`, () => {
    const result = resolveTheme(selected, undefined);
    assert.deepEqual(result.selected, selected);
    assert.equal(result.effective, undefined);
    assert.equal(result.missing, false);
  });
}

test('resolveTheme: opaque IDs are exact; labels, prefixes and case do not identify a theme', () => {
  const arbitrary = { id: 'x/Theme:%2F#17', label: 'pi', fingerprint: 'c'.repeat(64) };
  const profiles: readonly ProfileDescription[] = [arbitrary, { ...native, label: arbitrary.id }, pi];
  const selected: SyntaxTheme = { kind: 'occipital', id: arbitrary.id };
  assert.deepEqual(resolveTheme(selected, profiles), { selected, effective: arbitrary, missing: false });
  for (const id of ['PI', 'x/theme:%2F#17', 'x/Theme:', native.label, 'Pi palette']) {
    assert.deepEqual(resolveTheme({ kind: 'occipital', id }, profiles), {
      selected: { kind: 'occipital', id }, effective: pi, missing: true,
    });
  }
});

test('resolveTheme: later catalogue availability restores the saved independent selection', () => {
  const selected: SyntaxTheme = { kind: 'occipital', id: native.id };
  const unready = resolveTheme(selected, undefined);
  const missing = resolveTheme(selected, [pi]);
  const available = resolveTheme(missing.selected, [pi, native]);
  assert.deepEqual(unready.selected, selected);
  assert.deepEqual(missing, { selected, effective: pi, missing: true });
  assert.deepEqual(available, { selected, effective: native, missing: false });
});

test('resolveTheme: same-ID fingerprint replacement takes effect without changing the preference or old result', () => {
  const selected: SyntaxTheme = { kind: 'occipital', id: native.id };
  const before = resolveTheme(selected, [pi, native]);
  const replacement = { ...native, fingerprint: 'd'.repeat(64) };
  const after = resolveTheme(selected, [pi, replacement]);
  assert.deepEqual(before, { selected, effective: native, missing: false });
  assert.deepEqual(after, { selected, effective: replacement, missing: false });
  assert.notEqual(after.effective!.fingerprint, before.effective!.fingerprint);
});

test('resolveTheme: unchanged or unrelated refresh preserves effective identity for both selections', () => {
  const unrelated = { id: 'bundled:other', label: native.label, fingerprint: 'c'.repeat(64) };
  for (const selected of [{ kind: 'pi' }, { kind: 'occipital', id: native.id }] as const) {
    const before = resolveTheme(selected, [pi, native, unrelated]);
    assert.deepEqual(resolveTheme(selected, [pi, native, unrelated]), before);
    assert.deepEqual(resolveTheme(selected, [{ ...unrelated, fingerprint: 'e'.repeat(64) }, native, pi]), before);
  }
});

test('resolveTheme: frozen caller inputs are read-only and snapshots contain only contract primitives', () => {
  const selected = Object.freeze({ kind: 'occipital', id: native.id, extra: { caller: true } } as const);
  const profile = Object.freeze({ ...native, extra: { caller: true } });
  const profiles = Object.freeze([Object.freeze({ ...pi }), profile]);
  const result = resolveTheme(selected, profiles);
  assert.deepEqual(result, { selected: { kind: 'occipital', id: native.id }, effective: native, missing: false });
  assert.notStrictEqual(result.selected, selected);
  assert.notStrictEqual(result.effective, profile);
});

test('resolveTheme: mutations cannot cross ownership boundaries in either direction, including fallback and unready', () => {
  for (const mode of ['native', 'fallback', 'unready', 'pi'] as const) {
    const selected: SyntaxTheme = mode === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: native.id };
    const profile = { ...(mode === 'native' ? native : pi) };
    const profiles = mode === 'unready' ? undefined : [profile];
    const result = resolveTheme(selected, profiles);
    const expected = {
      selected: mode === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: native.id },
      effective: mode === 'unready' ? undefined : { ...profile },
      missing: mode === 'fallback',
    };
    selected.kind = 'pi';
    profile.id = 'caller-changed';
    profile.label = 'caller-changed';
    profile.fingerprint = 'f'.repeat(64);
    profiles?.splice(0);
    assert.deepEqual(result.selected, expected.selected);
    assert.deepEqual(result.effective, expected.effective);
    assert.equal(result.missing, expected.missing);

    // Deliberately bypass readonly typing: isolation does not depend on freezing.
    if (result.selected.kind === 'occipital') result.selected.id = 'result-changed';
    if (result.effective) Object.assign(result.effective, { id: 'result-changed', label: 'result-changed', fingerprint: '0'.repeat(64) });
    assert.equal(selected.kind, 'pi');
    if ('id' in selected) assert.equal(selected.id, native.id);
    assert.deepEqual(profile, { id: 'caller-changed', label: 'caller-changed', fingerprint: 'f'.repeat(64) });
    const again = resolveTheme({ kind: 'occipital', id: native.id }, [pi, native]);
    assert.deepEqual(again, { selected: { kind: 'occipital', id: native.id }, effective: native, missing: false });
  }
});
