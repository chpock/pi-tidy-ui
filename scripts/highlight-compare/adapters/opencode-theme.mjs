import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveColorValue } from '../../themes/opencode-tui.mjs';
import { digest } from '../model.mjs';

const nativeSource = { repository: 'anomalyco/opencode', assetDirectory: 'packages/tui/src/theme/assets' };
const keys = ['backgroundPanel', 'diffContextBg', 'diffAddedBg', 'diffRemovedBg', 'diffAddedLineNumberBg',
  'diffRemovedLineNumberBg', 'diffLineNumber', 'diffHighlightAdded', 'diffHighlightRemoved'];

function ownedFile(root, path) {
  const actual = realpathSync(path), inside = relative(realpathSync(root), actual);
  assert.ok(inside && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside), 'Native theme input escapes its prepared root');
  const stat = statSync(actual);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 65536, 'Native theme input must be a bounded regular file');
  return readFileSync(actual);
}

function metadataFrom(bytes, commit, version) {
  const metadata = JSON.parse(bytes);
  assert.equal(metadata.repository, nativeSource.repository, 'Native theme input repository mismatch');
  assert.equal(metadata.commit, commit, 'Native theme input commit mismatch');
  assert.equal(metadata.tag, 'v' + version, 'Native theme input version mismatch');
  assert.equal(metadata.assetDirectory, nativeSource.assetDirectory, 'Native theme input directory mismatch');
  assert.ok(Array.isArray(metadata.builtinThemeNames), 'Native theme input catalogue is missing');
  return metadata;
}

function selection(metadata, family, variant) {
  assert.ok(typeof family === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(family) && metadata.builtinThemeNames.includes(family), 'Unknown native theme input family');
  assert.ok(['dark', 'light'].includes(variant), 'Native theme input variant must be dark or light');
}

export function prepareOpenCodeTheme({ inputs, output, theme, variant, commit, version }) {
  const source = join(inputs.pi.root, 'tests/fixtures/opencode-tui');
  const metadata = metadataFrom(ownedFile(source, join(source, 'metadata.json')), commit, version);
  selection(metadata, theme, variant);
  const destination = join(output, 'theme-inputs'); mkdirSync(destination, { mode: 0o700 });
  const copy = name => {
    const bytes = ownedFile(source, join(source, name)), path = join(destination, name.replaceAll('/', '-'));
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  };
  return { schema: 1, requested: { family: theme, variant }, source: { ...nativeSource, commit, tag: 'v' + version },
    metadata: copy('metadata.json'), notice: copy('NOTICE'),
    assets: [...new Set([theme, 'opencode'])].map(family => ({ family, ...copy('assets/' + family + '.json') })) };
}

export function loadOpenCodeTheme(prepared, theme, variant, commit, version) {
  const profile = prepared.themeInputs;
  assert.ok(profile?.schema === 1, 'Stale OpenCode preparation: regenerate native theme inputs');
  assert.equal(profile.source?.commit, commit, 'Prepared native theme commit mismatch');
  assert.equal(profile.source?.repository, nativeSource.repository, 'Prepared native theme repository mismatch');
  assert.equal(profile.source?.assetDirectory, nativeSource.assetDirectory, 'Prepared native theme directory mismatch');
  assert.equal(profile.source?.tag, 'v' + version, 'Prepared native theme version mismatch');
  assert.equal(profile.requested?.family, theme, 'Prepared native theme family mismatch');
  const verified = entry => {
    assert.ok(entry && isAbsolute(entry.path ?? '') && Number.isSafeInteger(entry.bytes) && /^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''), 'Invalid prepared native theme asset');
    const bytes = ownedFile(prepared.root, entry.path);
    assert.equal(bytes.length, entry.bytes, 'Prepared native theme asset size mismatch');
    assert.equal(digest(bytes), entry.sha256, 'Prepared native theme asset hash mismatch');
    return bytes;
  };
  const metadata = metadataFrom(verified(profile.metadata), commit, version);
  selection(metadata, theme, variant); selection(metadata, profile.requested.family, profile.requested.variant);
  verified(profile.notice);
  const expected = [...new Set([theme, 'opencode'])].sort();
  assert.ok(Array.isArray(profile.assets) && profile.assets.length === expected.length &&
    JSON.stringify(profile.assets.map(asset => asset.family).sort()) === JSON.stringify(expected), 'Prepared native theme family assets mismatch');
  const assets = Object.fromEntries(profile.assets.map(asset => [asset.family, JSON.parse(verified(asset))]));
  return { family: theme, variant, assets, provenance: profile };
}

function opaque(asset, key, variant) {
  if (!Object.hasOwn(asset.theme, key)) return undefined;
  const color = resolveColorValue(asset, asset.theme[key], variant);
  return color.a === 255 ? color.r * 65536 + color.g * 256 + color.b : undefined;
}

function surfaceKey(sample) {
  if (sample.kind === 'card-background') return 'backgroundPanel';
  if (sample.kind === 'line-number') return 'diffLineNumber';
  if (sample.kind === 'sign') return sample.role === 'added' ? 'diffHighlightAdded' : 'diffHighlightRemoved';
  if (sample.kind === 'gutter-background') return sample.role === 'added' ? 'diffAddedLineNumberBg'
    : sample.role === 'removed' ? 'diffRemovedLineNumberBg' : 'diffContextBg';
  if (sample.kind === 'body-background' || sample.kind === 'padding-background') return sample.role === 'added'
    ? 'diffAddedBg' : sample.role === 'removed' ? 'diffRemovedBg' : 'diffContextBg';
  throw new Error('Unknown normalized native diff surface');
}

export function observeOpenCodeTheme(normalized, profile) {
  const { family, variant, assets } = profile, opposite = variant === 'dark' ? 'light' : 'dark';
  const table = (name, mode) => Object.fromEntries(keys.map(key => [key, opaque(assets[name], key, mode)]));
  const current = table(family, variant), alternatives = [{ family, variant: opposite },
    ...(family === 'opencode' ? [] : [{ family: 'opencode', variant }, { family: 'opencode', variant: opposite }])]
    .map(item => ({ ...item, colors: table(item.family, item.variant) }));
  const observations = normalized.surfaces.map((sample, index) => {
    const key = surfaceKey(sample), channel = ['line-number', 'sign'].includes(sample.kind) ? 'foreground' : 'background';
    const colors = new Map();
    for (const cell of sample.cells) {
      const color = cell.style[channel], id = JSON.stringify(color), entry = colors.get(id) ?? { color, count: 0 };
      entry.count++; colors.set(id, entry);
    }
    const observed = [...colors.values()].map(item => ({ ...item,
      candidateKeys: item.color.mode === 'rgb' ? keys.filter(name => current[name] !== undefined && current[name] === item.color.value) : [] }));
    const expected = current[key], exclusive = expected !== undefined && alternatives.every(item => item.colors[key] !== undefined && item.colors[key] !== expected);
    const matched = exclusive && observed.length === 1 && observed[0].color.mode === 'rgb' && observed[0].color.value === expected;
    return { sample: index, page: sample.page, row: sample.row, kind: sample.kind, role: sample.role,
      side: sample.side, logicalRow: sample.logicalRow, key, channel, expected, exclusive, matched, observed,
      alternatives: alternatives.map(item => ({ family: item.family, variant: item.variant, expected: item.colors[key] })) };
  });
  const witnesses = observations.filter(item => item.matched).map(item => item.sample);
  return { status: witnesses.length ? 'identified' : 'indistinguishable', method: 'mapped-native-structural-rgb-witness',
    family, variant, witnesses, observations, provenance: profile.provenance };
}
