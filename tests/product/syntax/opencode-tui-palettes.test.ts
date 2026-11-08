import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { THEME_CATALOGUE, THEME_FAMILIES, themeEntry, themeFamilyId } from '../../../src/themes/catalogue.ts';
import { SEMANTIC_REGIONS } from '../../../src/syntax/semantic-rules.ts';

type SourceColor = { r: number; g: number; b: number; a: number };
type AuthoringModule = {
  generatePalette: (...args: any[]) => any;
  resolveColorValue: (theme: any, value: any, variant: string) => SourceColor;
};
const authoringUrl = new URL('../../../scripts/themes/opencode-tui.mjs', import.meta.url).href;
const { generatePalette, resolveColorValue } = await import(authoringUrl) as AuthoringModule;
const fixtureRoot = fileURLToPath(new URL('../../fixtures/opencode-tui/', import.meta.url));
const sourceRoot = join(fixtureRoot, 'assets');
const metadata = JSON.parse(readFileSync(join(fixtureRoot, 'metadata.json'), 'utf8'));
const ROLE_NAMES = [
  'panel', 'plain', 'code', 'output', 'empty', 'padding', 'service', 'muted', 'footer', 'reminder', 'overflow',
  'diagnostic', 'title', 'prompt', 'frame', 'error', 'errorFrame', 'warning', 'gutter', 'numbers', 'contextCode',
  'contextGutter', 'addedCode', 'removedCode', 'addedGutter', 'removedGutter', 'addedSign', 'removedSign',
];
const REGION_DONORS: Record<string, readonly [string, string[]]> = {
  'syntax-comment': ['syntaxComment', ['italic']],
  'syntax-regexp': ['syntaxKeyword', []],
  'syntax-string': ['syntaxString', []],
  'syntax-keyword': ['syntaxKeyword', ['italic']],
  'syntax-primitive': ['syntaxFunction', []],
  'syntax-operator': ['syntaxOperator', []],
  'syntax-variable': ['syntaxVariable', []],
  'syntax-property': ['syntaxVariable', []],
  'syntax-type': ['syntaxType', []],
  'syntax-constant': ['syntaxNumber', []],
  'syntax-punctuation': ['syntaxPunctuation', []],
  'syntax-warning': ['warning', ['bold']],
  'syntax-critical': ['error', ['bold']],
  'syntax-diff-add': ['diffAdded', []],
  'syntax-diff-delete': ['diffRemoved', []],
  'syntax-diff-unknown': ['diffContext', []],
  'markdown-heading': ['markdownHeading', ['bold']],
  'markdown-link': ['markdownLink', ['underline']],
  'markdown-link-text': ['markdownLinkText', ['underline']],
  'markdown-code': ['markdownCode', []],
  'markdown-block-quote': ['markdownBlockQuote', ['italic']],
  'markdown-strong': ['markdownStrong', ['bold']],
  'markdown-horizontal-rule': ['markdownHorizontalRule', []],
  'markdown-list-item': ['markdownListItem', []],
  'markdown-list-enumeration': ['markdownListItem', []],
  'markdown-image': ['markdownLink', ['underline']],
  'markdown-image-text': ['markdownLinkText', ['underline']],
  'markdown-code-block': ['markdownCode', []],
  'syntax-number': ['syntaxNumber', []],
  'syntax-language-constant': ['syntaxNumber', []],
  'syntax-parameter': ['syntaxVariable', []],
  'syntax-function-builtin': ['error', []],
  'syntax-command': ['syntaxFunction', []],
  'syntax-escape': ['syntaxKeyword', []],
  'syntax-string-delimiter': ['syntaxString', []],
  'syntax-tag': ['error', []],
  'syntax-attribute': ['warning', []],
  'syntax-preprocessor': ['syntaxKeyword', ['italic']],
  'syntax-diff-header': ['diffHunkHeader', []],
  'markdown-heading-marker': ['markdownHeading', ['bold']],
  'markdown-code-delimiter': ['markdownCode', []],
  'markdown-link-delimiter': ['markdownLinkText', ['underline']],
  'markdown-code-fence': ['markdownCode', []],
  'markdown-quote-border': ['markdownBlockQuote', ['italic']],
};
const ROLE_DONORS: Record<string, readonly [string, string, string[]]> = {
  panel: ['text', 'panel', []], plain: ['text', 'panel', []], code: ['text', 'panel', []],
  output: ['text', 'panel', []], empty: ['textMuted', 'panel', []], padding: ['text', 'panel', []],
  service: ['textMuted', 'panel', []], muted: ['textMuted', 'panel', []], footer: ['textMuted', 'panel', []],
  reminder: ['textMuted', 'panel', []], overflow: ['textMuted', 'panel', []], diagnostic: ['error', 'panel', []],
  title: ['text', 'panel', []], prompt: ['textMuted', 'panel', []], frame: ['background', 'panel', []],
  error: ['error', 'panel', []], errorFrame: ['error', 'panel', ['bold']], warning: ['warning', 'panel', []],
  gutter: ['textMuted', 'panel', []], numbers: ['textMuted', 'panel', []], contextCode: ['text', 'context', []],
  contextGutter: ['diffLineNumber', 'context', []], addedCode: ['text', 'addedCode', []],
  removedCode: ['text', 'removedCode', []], addedGutter: ['diffLineNumber', 'addedGutter', []],
  removedGutter: ['diffLineNumber', 'removedGutter', []], addedSign: ['diffHighlightAdded', 'addedGutter', []],
  removedSign: ['diffHighlightRemoved', 'removedGutter', []],
};

function sourceTheme(family: string): any {
  return JSON.parse(readFileSync(join(sourceRoot, `${family}.json`), 'utf8'));
}

function sourceColor(theme: any, value: any, variant: string, chain: string[] = []): SourceColor {
  if (typeof value === 'number') {
    if (value < 16) {
      const ansi = ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
        '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];
      return sourceColor(theme, ansi[value], variant);
    }
    if (value < 232) {
      const index = value - 16, level = (n: number) => n === 0 ? 0 : n * 40 + 55;
      return { r: level(Math.floor(index / 36)), g: level(Math.floor(index / 6) % 6), b: level(index % 6), a: 255 };
    }
    const gray = (value - 232) * 10 + 8;
    return { r: gray, g: gray, b: gray, a: 255 };
  }
  if (typeof value === 'string') {
    if (value === 'transparent' || value === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    if (value.startsWith('#')) {
      const hex = value.slice(1), expanded = hex.length <= 4 ? [...hex].map(ch => ch + ch).join('') : hex;
      const bytes = expanded.match(/../gu)!.map(part => Number.parseInt(part, 16));
      return { r: bytes[0]!, g: bytes[1]!, b: bytes[2]!, a: bytes[3] ?? 255 };
    }
    assert.equal(chain.includes(value), false, `pinned source reference cycle: ${[...chain, value].join(' -> ')}`);
    const target = theme.defs?.[value] ?? theme.theme?.[value];
    assert.notEqual(target, undefined, `pinned source reference exists: ${value}`);
    return sourceColor(theme, target, variant, [...chain, value]);
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'source style has a recognized value');
  assert.notEqual(value[variant], undefined, `source has ${variant} color value`);
  return sourceColor(theme, value[variant], variant, chain);
}

function selectedColor(theme: any, name: string, variant: string): SourceColor {
  const value = theme.theme[name];
  assert.notEqual(value, undefined, `selected TUI input exists: ${name}`);
  const color = sourceColor(theme, value, variant);
  assert.ok(color.a > 0, `selected TUI input is not fully transparent: ${name}`);
  return color;
}

function opaqueColor(theme: any, name: string, variant: string): SourceColor {
  const color = selectedColor(theme, name, variant);
  assert.equal(color.a, 255, `required source surface is opaque: ${name}`);
  return color;
}

function composite(source: SourceColor, base: SourceColor): SourceColor {
  const mix = (channel: 'r' | 'g' | 'b') => Math.floor((source[channel] * source.a + base[channel] * (255 - source.a) + 127) / 255);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 255 };
}

function toHex(color: SourceColor): string {
  return `#${[color.r, color.g, color.b].map(part => part.toString(16).padStart(2, '0')).join('')}`;
}

function expectedPalette(theme: any, variant: string) {
  const panel = opaqueColor(theme, 'backgroundPanel', variant);
  const context = opaqueColor(theme, 'diffContextBg', variant);
  const surface: Record<string, string> = {
    panel: toHex(panel),
    context: toHex(context),
    addedCode: toHex(composite(selectedColor(theme, 'diffAddedBg', variant), panel)),
    removedCode: toHex(composite(selectedColor(theme, 'diffRemovedBg', variant), panel)),
    addedGutter: toHex(composite(selectedColor(theme, 'diffAddedLineNumberBg', variant), context)),
    removedGutter: toHex(composite(selectedColor(theme, 'diffRemovedLineNumberBg', variant), context)),
  };
  const regions = Object.fromEntries(Object.entries(REGION_DONORS).map(([name, [source, attributes]]) => [name, {
    foreground: toHex(composite(selectedColor(theme, source, variant), panel)), attributes,
  }]));
  const roles = Object.fromEntries(Object.entries(ROLE_DONORS).map(([name, [foregroundName, backgroundName, attributes]]) => {
    const background = surface[backgroundName];
    return [name, {
      foreground: toHex(composite(selectedColor(theme, foregroundName, variant), sourceColor({}, background, variant))),
      background,
      attributes,
    }];
  }));
  return { regions, roles };
}

function paletteFile(id: string): any {
  return JSON.parse(readFileSync(new URL(`../../../src/themes/palettes/${id}.json`, import.meta.url), 'utf8'));
}

function upstreamNamesFromIndex() {
  const source = readFileSync(join(fixtureRoot, 'theme-index.ts.txt'), 'utf8');
  const start = source.indexOf('export const DEFAULT_THEMES:');
  assert.notEqual(start, -1, 'the pinned source declares built-in themes');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'the pinned built-in catalogue is delimited');
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*(?:\["([^"]+)"\]\s*:|([A-Za-z][\w-]*)\s*(?::|,))/gmu)].map(match => match[1] ?? match[2] ?? '');
}

test('catalogue is exactly the selected 32 pinned OpenCode TUI families with separate dark/light variants', () => {
  const sourceNames: string[] = metadata.builtinThemeNames;
  assert.equal(metadata.repository, 'anomalyco/opencode');
  assert.equal(metadata.tag, 'v1.19.5');
  assert.equal(metadata.commit, '810c0eba1a7348036f8bdf61e6632d0c36c6876c');
  assert.equal(metadata.themeIndexPath, 'packages/tui/src/theme/index.ts');
  assert.equal(metadata.assetDirectory, 'packages/tui/src/theme/assets');
  assert.deepEqual([...upstreamNamesFromIndex()].sort(), [...sourceNames].sort(), 'fixture metadata follows DEFAULT_THEMES at the pinned source');
  assert.deepEqual(readdirSync(sourceRoot).filter((name: string) => name.endsWith('.json')).sort(), sourceNames.map((name: string) => `${name}.json`).sort());
  assert.deepEqual(metadata.excludedTheme, {
    name: 'lucent-orng',
    reason: 'Both built-in variants use transparent backgrounds for selected required card surfaces; no opaque backdrop is authored for this palette.',
  });
  const excluded = sourceTheme('lucent-orng');
  for (const variant of ['dark', 'light']) {
    assert.equal(sourceColor(excluded, excluded.theme.backgroundPanel, variant).a, 0, `${variant} panel has no authored opaque backdrop`);
    assert.equal(sourceColor(excluded, excluded.theme.diffContextBg, variant).a, 0, `${variant} context surface has no authored opaque backdrop`);
  }

  const selected = sourceNames.filter((name: string) => name !== metadata.excludedTheme.name).sort();
  assert.equal(sourceNames.length, 33);
  assert.equal(selected.length, 32);
  assert.equal(THEME_CATALOGUE.length, 64);
  assert.equal(THEME_FAMILIES.length, 32);
  assert.deepEqual(THEME_FAMILIES.map(theme => theme.id).sort(), selected);
  assert.deepEqual(THEME_CATALOGUE.map(theme => theme.id).sort(), selected.flatMap(family => [`${family}-dark`, `${family}-light`]).sort());
  for (const family of selected) {
    for (const variant of ['dark', 'light']) {
      const id = `${family}-${variant}`;
      assert.ok(themeEntry(id), `${id} resolves as an owned concrete entry`);
      assert.equal(themeFamilyId(id), family);
    }
  }
  for (const removed of ['amoled', 'oc-2', 'onedarkpro', 'shadesofpurple', 'lucent-orng']) {
    assert.equal(themeFamilyId(removed), undefined);
    assert.equal(themeFamilyId(`${removed}-dark`), undefined);
  }
  assert.equal(themeFamilyId('opencode-dark'), 'opencode');
  assert.equal(themeEntry('opencode-dark')?.label, 'OpenCode Dark');
});

test('all 64 generated palettes retain exact provenance, 44 regions and 28 opaque card roles', () => {
  assert.deepEqual(Object.keys(REGION_DONORS).sort(), [...SEMANTIC_REGIONS].sort());
  assert.equal(SEMANTIC_REGIONS.length, 44);
  assert.deepEqual(Object.keys(ROLE_DONORS).sort(), [...ROLE_NAMES].sort());
  for (const entry of THEME_CATALOGUE) {
    const variant = entry.id.endsWith('-dark') ? 'dark' : 'light';
    const family = entry.id.slice(0, -(variant.length + 1));
    const palette = paletteFile(entry.id);
    assert.deepEqual(Object.keys(palette).sort(), ['id', 'label', 'regions', 'revision', 'roles', 'source'].sort(), entry.id);
    assert.equal(palette.revision, 2, entry.id);
    assert.equal(palette.id, entry.id);
    assert.equal(palette.label, entry.label);
    assert.deepEqual(palette.source, {
      repository: metadata.repository,
      commit: metadata.commit,
      path: `${metadata.assetDirectory}/${family}.json`,
      variant,
    }, entry.id);
    assert.deepEqual(Object.keys(palette.regions).sort(), [...SEMANTIC_REGIONS].sort(), entry.id);
    assert.deepEqual(Object.keys(palette.roles).sort(), [...ROLE_NAMES].sort(), entry.id);
    for (const [name, style] of Object.entries(palette.regions) as [string, any][]) {
      assert.deepEqual(Object.keys(style).sort(), ['attributes', 'foreground'], `${entry.id}/${name}`);
      assert.match(style.foreground, /^#[\da-f]{6}$/u, `${entry.id}/${name}`);
      assert.ok(Array.isArray(style.attributes), `${entry.id}/${name}`);
    }
    for (const [name, style] of Object.entries(palette.roles) as [string, any][]) {
      assert.deepEqual(Object.keys(style).sort(), ['attributes', 'background', 'foreground'], `${entry.id}/${name}`);
      assert.match(style.foreground, /^#[\da-f]{6}$/u, `${entry.id}/${name}/foreground`);
      assert.match(style.background, /^#[\da-f]{6}$/u, `${entry.id}/${name}/background`);
      assert.ok(Array.isArray(style.attributes), `${entry.id}/${name}`);
      assert.deepEqual(style.attributes, name === 'errorFrame' ? ['bold'] : [], `${entry.id}/${name}`);
    }
    const expected = expectedPalette(sourceTheme(family), variant);
    assert.deepEqual(palette.regions, expected.regions, `${entry.id} region color/font mapping follows primary source`);
    assert.deepEqual(palette.roles, expected.roles, `${entry.id} role colors and surfaces follow primary source`);
  }
});

test('GitHub Dark and Gruvbox Dark keep literal TUI role, syntax and authored diff vectors', () => {
  const github = paletteFile('github-dark');
  assert.deepEqual(github.roles.panel, { foreground: '#c9d1d9', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.frame, { foreground: '#0d1117', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.error, { foreground: '#f85149', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.warning, { foreground: '#e3b341', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.contextCode, { foreground: '#c9d1d9', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.contextGutter, { foreground: '#95999e', background: '#010409', attributes: [] });
  assert.deepEqual(github.roles.addedCode, { foreground: '#c9d1d9', background: '#033a16', attributes: [] });
  assert.deepEqual(github.roles.removedCode, { foreground: '#c9d1d9', background: '#67060c', attributes: [] });
  assert.deepEqual(github.roles.addedGutter, { foreground: '#95999e', background: '#033a16', attributes: [] });
  assert.deepEqual(github.roles.removedGutter, { foreground: '#95999e', background: '#67060c', attributes: [] });
  assert.deepEqual(github.roles.addedSign, { foreground: '#3fb950', background: '#033a16', attributes: [] });
  assert.deepEqual(github.roles.removedSign, { foreground: '#f85149', background: '#67060c', attributes: [] });
  assert.deepEqual(github.regions['syntax-comment'], { foreground: '#8b949e', attributes: ['italic'] });
  assert.deepEqual(github.regions['syntax-keyword'], { foreground: '#ff7b72', attributes: ['italic'] });
  assert.deepEqual(github.regions['syntax-function-builtin'], { foreground: '#f85149', attributes: [] });
  assert.deepEqual(github.regions['syntax-critical'], { foreground: '#f85149', attributes: ['bold'] });

  const gruvbox = paletteFile('gruvbox-dark');
  assert.deepEqual(gruvbox.roles.panel, { foreground: '#ebdbb2', background: '#3c3836', attributes: [] });
  assert.deepEqual(gruvbox.roles.contextCode, { foreground: '#ebdbb2', background: '#3c3836', attributes: [] });
  assert.deepEqual(gruvbox.roles.contextGutter, { foreground: '#a8a29e', background: '#3c3836', attributes: [] });
  assert.deepEqual(gruvbox.roles.addedCode, { foreground: '#ebdbb2', background: '#32302f', attributes: [] });
  assert.deepEqual(gruvbox.roles.removedCode, { foreground: '#ebdbb2', background: '#322929', attributes: [] });
  assert.deepEqual(gruvbox.roles.addedGutter, { foreground: '#a8a29e', background: '#2a2827', attributes: [] });
  assert.deepEqual(gruvbox.roles.removedGutter, { foreground: '#a8a29e', background: '#2a2222', attributes: [] });
  assert.deepEqual(gruvbox.roles.addedSign, { foreground: '#b8bb26', background: '#2a2827', attributes: [] });
  assert.deepEqual(gruvbox.roles.removedSign, { foreground: '#fb4934', background: '#2a2222', attributes: [] });
  assert.deepEqual(gruvbox.regions['syntax-comment'], { foreground: '#928374', attributes: ['italic'] });
  assert.deepEqual(gruvbox.regions['syntax-keyword'], { foreground: '#fb4934', attributes: ['italic'] });
});

test('nonopaque source backgrounds and role foregrounds use the specified single integer composite', () => {
  const cursor = paletteFile('cursor-dark');
  assert.deepEqual(cursor.roles.addedCode, { foreground: '#e4e4e4', background: '#1d3024', attributes: [] });
  assert.deepEqual(cursor.roles.addedGutter, { foreground: '#8c958f', background: '#1d3024', attributes: [] });
  assert.deepEqual(cursor.roles.contextGutter, { foreground: '#878787', background: '#141414', attributes: [] });

  const source = sourceTheme('cursor');
  assert.equal(sourceColor(source, source.theme.diffAddedBg, 'dark').a, 0x33);
  assert.equal(sourceColor(source, source.theme.diffLineNumber, 'dark').a, 0x87);
  assert.equal(sourceColor(source, source.theme.backgroundPanel, 'dark').a, 255);
  assert.equal(sourceColor(source, source.theme.diffContextBg, 'dark').a, 255);
});

test('TUI color parser selects modes, follows defs before theme references, and rejects invalid references', () => {
  const theme = { defs: { alias: 'base', base: '#123456' }, theme: { base: '#abcdef' } };
  assert.deepEqual(resolveColorValue(theme, 'alias', 'dark'), { r: 18, g: 52, b: 86, a: 255 });
  assert.deepEqual(resolveColorValue({ defs: {}, theme: { base: '#abcdef' } }, 'base', 'dark'), { r: 171, g: 205, b: 239, a: 255 });
  assert.deepEqual(resolveColorValue(theme, { dark: '#abc', light: '#abcd' }, 'dark'), { r: 170, g: 187, b: 204, a: 255 });
  assert.deepEqual(resolveColorValue(theme, { dark: '#abc', light: '#abcd' }, 'light'), { r: 170, g: 187, b: 204, a: 221 });
  assert.deepEqual(resolveColorValue(theme, '#112233', 'dark'), { r: 17, g: 34, b: 51, a: 255 });
  assert.deepEqual(resolveColorValue(theme, '#11223344', 'dark'), { r: 17, g: 34, b: 51, a: 68 });
  assert.throws(() => resolveColorValue({ defs: {}, theme: {} }, 'absent', 'dark'), /not found/u);
  assert.throws(() => resolveColorValue({ defs: { a: 'b', b: 'a' }, theme: {} }, 'a', 'dark'), /Circular/u);
  assert.throws(() => resolveColorValue(theme, { dark: '#fff' }, 'light'), /variant/u);
  assert.equal(resolveColorValue(theme, 'transparent', 'dark').a, 0, 'the source resolver preserves transparency for the authoring boundary to reject');
  assert.throws(() => generatePalette('example', 'Example', 'dark', { theme: {} }), /missing/u);
  assert.throws(() => generatePalette('example', 'Example', 'dark', { theme: { backgroundPanel: 'transparent' } }), /transparent/u);
  assert.throws(() => generatePalette('example', 'Example', 'dark', { theme: { backgroundPanel: '#ffffff80' } }), /not opaque/u);
  assert.throws(() => generatePalette('example', 'Example', 'dark', {
    defs: { first: 'second', second: 'first' }, theme: { backgroundPanel: 'first' },
  }), /Circular/u);
});
