import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputs } from '../../../scripts/test/context.mjs';
import { digest } from '../../../scripts/highlight-compare/model.mjs';
import { loadOpenCodeTheme, observeOpenCodeTheme, prepareOpenCodeTheme } from '../../../scripts/highlight-compare/adapters/opencode-theme.mjs';

const native = { commit: '810c0eba1a7348036f8bdf61e6632d0c36c6876c', version: '1.19.5' };
function preparedTheme(run, theme = 'github') {
  const root = mkdtempSync(join(tmpdir(), 'highlight-native-theme-'));
  try {
    const themeInputs = prepareOpenCodeTheme({ inputs: readInputs(), output: root, theme, variant: 'dark', ...native });
    return run({ root, themeInputs });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const load = (prepared, family = 'github', variant = 'dark') => loadOpenCodeTheme(prepared, family, variant, native.commit, native.version);
const color = (value, mode = 'rgb') => mode === 'default' ? { mode } : { mode, value };
function surface(kind, role, foreground, background, mode = 'rgb') {
  return { kind, role, page: 0, row: 1, cells: [{ column: 1, text: ' ', width: 1,
    style: { foreground: color(foreground, mode), background: color(background, mode), attributes: [] } }] };
}
const observe = (profile, ...surfaces) => observeOpenCodeTheme({ surfaces }, profile);

// These are neutral resolver vectors, not reference screenshots or replacement application paints.
function vector(value = 0) {
  const names = ['backgroundPanel', 'diffContextBg', 'diffAddedBg', 'diffRemovedBg', 'diffAddedLineNumberBg',
    'diffRemovedLineNumberBg', 'diffLineNumber', 'diffHighlightAdded', 'diffHighlightRemoved'];
  const asset = (dark, light) => ({ theme: Object.fromEntries(names.map(key => [key, { dark, light }])) });
  return { family: 'unit-vector', variant: 'dark', provenance: { purpose: 'unit-only' },
    assets: { 'unit-vector': asset(value, '#010101'), opencode: asset('#222222', '#333333') } };
}

test('OpenCode preparation binds raw native assets and MIT notice, not generated product palettes', () => {
  preparedTheme(prepared => {
    assert.deepEqual(prepared.themeInputs.requested, { family: 'github', variant: 'dark' });
    assert.equal(prepared.themeInputs.source.commit, native.commit);
    assert.equal(prepared.themeInputs.assets.length, 2);
    const inputs = readInputs();
    for (const entry of prepared.themeInputs.assets) {
      const original = readFileSync(join(inputs.pi.root, 'tests/fixtures/opencode-tui/assets', entry.family + '.json'));
      assert.equal(digest(original), entry.sha256);
      assert.equal(entry.bytes, original.length);
      assert.equal(readFileSync(entry.path).equals(original), true);
      assert.equal(JSON.parse(original).regions, undefined);
    }
    assert.match(readFileSync(prepared.themeInputs.notice.path, 'utf8'), /MIT/);
    const profile = load(prepared, 'github', 'light');
    const proof = observe(profile, surface('line-number', 'context', 0x57606a, 0));
    assert.equal(proof.status, 'identified', 'one raw family asset supports collection of either variant');
    assert.equal(proof.observations[0].expected, 0x57606a, 'the native light diffLineNumber resolves its theme alias and mode');
  });
});

test('OpenCode collection uses prepared raw copies after the source input directory changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'highlight-native-copy-'));
  try {
    const inputRoot = join(root, 'source'), raw = join(inputRoot, 'tests/fixtures/opencode-tui');
    mkdirSync(join(raw, 'assets'), { recursive: true });
    const original = join(readInputs().pi.root, 'tests/fixtures/opencode-tui');
    for (const name of ['metadata.json', 'NOTICE', 'assets/github.json', 'assets/opencode.json']) copyFileSync(join(original, name), join(raw, name));
    const output = join(root, 'prepared'); mkdirSync(output);
    const themeInputs = prepareOpenCodeTheme({ inputs: { pi: { root: inputRoot } }, output, theme: 'github', variant: 'dark', ...native });
    writeFileSync(join(raw, 'assets/github.json'), '{}'); writeFileSync(join(raw, 'metadata.json'), '{}');
    assert.equal(observe(load({ root: output, themeInputs }), surface('card-background', undefined, 0, 0x010409)).status, 'identified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode rejects stale, foreign-family and wrong-commit prepared theme descriptors', () => {
  preparedTheme(prepared => {
    assert.throws(() => load({ root: prepared.root }), /Stale OpenCode preparation/);
    assert.throws(() => load(prepared, 'one-dark'), /family mismatch/);
    assert.throws(() => load(prepared, 'github', 'auto'), /variant/);
    assert.throws(() => loadOpenCodeTheme(prepared, 'github', 'dark', 'wrong-commit', native.version), /commit mismatch/);
    const duplicate = structuredClone(prepared); duplicate.themeInputs.assets[1].family = 'github';
    assert.throws(() => load(duplicate), /family assets mismatch/);
  });
});

for (const name of ['metadata', 'notice', 'asset']) test(`OpenCode verifies prepared ${name} bytes before using them`, () => {
  preparedTheme(prepared => {
    const entry = name === 'asset' ? prepared.themeInputs.assets[0] : prepared.themeInputs[name];
    const bytes = readFileSync(entry.path); bytes[0] ^= 1;
    writeFileSync(entry.path, bytes);
    assert.throws(() => load(prepared), /hash mismatch/);
  });
});

test('OpenCode rejects a valid hashed raw asset outside its prepared root', () => {
  preparedTheme(prepared => {
    const entry = prepared.themeInputs.assets[0];
    entry.path = join(readInputs().pi.root, 'tests/fixtures/opencode-tui/assets/github.json');
    assert.throws(() => load(prepared), /escapes/);
  });
});

test('OpenCode card witness uses backgroundPanel and retains all compatible structural keys', () => {
  preparedTheme(prepared => {
    const profile = load(prepared), proof = observe(profile, surface('card-background', undefined, 0, 0x010409));
    assert.equal(proof.status, 'identified');
    assert.equal(proof.observations[0].key, 'backgroundPanel');
    assert.deepEqual(proof.observations[0].observed[0].candidateKeys, ['backgroundPanel', 'diffContextBg']);
    assert.equal(observe(profile, surface('card-background', undefined, 0, 0x161b22)).status, 'indistinguishable', 'backgroundElement cannot certify a card-background surface');
    for (const rgb of [0x141414, 0xf6f8fa, 0xffffff]) {
      assert.equal(observe(profile, surface('card-background', undefined, 0, rgb)).status, 'indistinguishable');
    }
  });
});

test('native opencode itself can be identified and signs use diffHighlightAdded, not diffAdded', () => {
  preparedTheme(prepared => {
    const profile = load(prepared, 'opencode');
    assert.equal(observe(profile, surface('sign', 'added', 0xb8db87, 0)).status, 'identified');
    assert.equal(observe(profile, surface('sign', 'added', 0x4fd6be, 0)).status, 'indistinguishable');
    assert.equal(prepared.themeInputs.assets.length, 1, 'the requested fallback family is copied and checked only once');
  }, 'opencode');
});

test('authored native ANSI numbers resolve to RGB, but actual indexed and default cells cannot witness identity', () => {
  const profile = vector(0);
  assert.equal(observe(profile, surface('card-background', undefined, 0, 0)).status, 'identified');
  assert.equal(observe(profile, surface('card-background', undefined, 0, 0, 'indexed')).status, 'indistinguishable');
  assert.equal(observe(profile, surface('card-background', undefined, 0, 0, 'default')).status, 'indistinguishable');
});

test('a color shared with a fallback or opposite mode supplies no discriminating theme proof', () => {
  const fallback = vector('#ffffff'); fallback.assets.opencode.theme.backgroundPanel.dark = '#ffffff';
  assert.equal(observe(fallback, surface('card-background', undefined, 0, 0xffffff)).status, 'indistinguishable');
  const opposite = vector('#ffffff'); opposite.assets['unit-vector'].theme.backgroundPanel.light = '#ffffff';
  assert.equal(observe(opposite, surface('card-background', undefined, 0, 0xffffff)).status, 'indistinguishable');
});

test('one correctly attributed opaque surface witnesses identity without masking other native paint deviations', () => {
  const profile = vector('transparent'); profile.assets['unit-vector'].theme.diffAddedBg.dark = '#123456';
  const proof = observe(profile, surface('card-background', undefined, 0, 0), surface('body-background', 'added', 0, 0x123456));
  assert.equal(proof.status, 'identified');
  assert.deepEqual(proof.witnesses, [1]);
  assert.equal(proof.observations[0].exclusive, false, 'no alpha composition is invented for the transparent card');
  assert.equal(proof.observations[0].observed[0].color.value, 0, 'the native deviation remains in evidence');
  const nonuniform = surface('body-background', 'added', 0, 0x123456);
  nonuniform.cells.push({ ...nonuniform.cells[0], column: 2, style: { ...nonuniform.cells[0].style, background: color(0xabcdef) } });
  assert.equal(observe(profile, nonuniform).status, 'indistinguishable');
});
