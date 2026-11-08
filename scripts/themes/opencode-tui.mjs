#!/usr/bin/env node
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const INPUT_DIR = join(ROOT, 'tests/fixtures/opencode-tui/assets');
const OUTPUT_DIR = join(ROOT, 'src/themes/palettes');
const COMMIT = '810c0eba1a7348036f8bdf61e6632d0c36c6876c';
const REPOSITORY = 'anomalyco/opencode';
const REGION_ORDER = [
  'syntax-comment', 'syntax-regexp', 'syntax-string', 'syntax-keyword', 'syntax-primitive', 'syntax-operator',
  'syntax-variable', 'syntax-property', 'syntax-type', 'syntax-constant', 'syntax-punctuation', 'syntax-warning',
  'syntax-critical', 'syntax-diff-add', 'syntax-diff-delete', 'syntax-diff-unknown',
  'markdown-heading', 'markdown-link', 'markdown-link-text', 'markdown-code', 'markdown-block-quote', 'markdown-strong',
  'markdown-horizontal-rule', 'markdown-list-item', 'markdown-list-enumeration', 'markdown-image', 'markdown-image-text',
  'markdown-code-block', 'syntax-number', 'syntax-language-constant', 'syntax-parameter', 'syntax-function-builtin',
  'syntax-command', 'syntax-escape', 'syntax-string-delimiter', 'syntax-tag', 'syntax-attribute', 'syntax-preprocessor',
  'syntax-diff-header', 'markdown-heading-marker', 'markdown-code-delimiter', 'markdown-link-delimiter',
  'markdown-code-fence', 'markdown-quote-border',
];

const FAMILIES = [
  ['aura', 'Aura'], ['ayu', 'Ayu'], ['carbonfox', 'Carbonfox'], ['catppuccin', 'Catppuccin'],
  ['catppuccin-frappe', 'Catppuccin Frappe'], ['catppuccin-macchiato', 'Catppuccin Macchiato'],
  ['cobalt2', 'Cobalt2'], ['cursor', 'Cursor'], ['dracula', 'Dracula'], ['everforest', 'Everforest'],
  ['flexoki', 'Flexoki'], ['github', 'GitHub'], ['gruvbox', 'Gruvbox'], ['kanagawa', 'Kanagawa'],
  ['lucent-orng', 'Lucent Orng'], ['material', 'Material'], ['matrix', 'Matrix'], ['mercury', 'Mercury'],
  ['monokai', 'Monokai'], ['nightowl', 'Night Owl'], ['nord', 'Nord'], ['one-dark', 'One Dark'],
  ['opencode', 'OpenCode'], ['orng', 'Orng'], ['osaka-jade', 'Osaka Jade'], ['palenight', 'Palenight'],
  ['rosepine', 'Rose Pine'], ['solarized', 'Solarized'], ['synthwave84', "Synthwave '84"],
  ['tokyonight', 'Tokyonight'], ['vercel', 'Vercel'], ['vesper', 'Vesper'], ['zenburn', 'Zenburn'],
].filter(([id]) => id !== 'lucent-orng');

const REGION_DONORS = {
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

const ANSI = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
];

export function parseHexColor(value) {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value)) {
    throw new Error(`Invalid TUI theme color: ${String(value)}`);
  }
  const digits = value.slice(1).toLowerCase();
  const expanded = digits.length <= 4 ? [...digits].map(part => part + part).join('') : digits;
  const hasAlpha = expanded.length === 8;
  const channels = expanded.match(/../gu).map(pair => Number.parseInt(pair, 16));
  return { r: channels[0], g: channels[1], b: channels[2], a: hasAlpha ? channels[3] : 255 };
}

function ansiColor(code) {
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error(`Invalid TUI ANSI color: ${code}`);
  if (code < 16) return parseHexColor(ANSI[code]);
  if (code < 232) {
    const index = code - 16;
    const channel = value => value === 0 ? 0 : value * 40 + 55;
    return { r: channel(Math.floor(index / 36)), g: channel(Math.floor(index / 6) % 6), b: channel(index % 6), a: 255 };
  }
  const gray = (code - 232) * 10 + 8;
  return { r: gray, g: gray, b: gray, a: 255 };
}

export function resolveColorValue(theme, value, variant, chain = []) {
  if (typeof value === 'number') return ansiColor(value);
  if (typeof value === 'string') {
    if (value === 'transparent' || value === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    if (value.startsWith('#')) return parseHexColor(value);
    if (chain.includes(value)) throw new Error(`Circular color reference: ${[...chain, value].join(' -> ')}`);
    const target = theme.defs?.[value] ?? theme.theme?.[value];
    if (target === undefined) throw new Error(`Color reference "${value}" not found in defs or theme`);
    return resolveColorValue(theme, target, variant, [...chain, value]);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value[variant] === undefined) throw new Error(`Color variant "${variant}" missing`);
    return resolveColorValue(theme, value[variant], variant, chain);
  }
  throw new Error(`Unsupported TUI theme color value: ${String(value)}`);
}

function composite(source, base) {
  const alpha = source.a;
  const channel = key => Math.floor((source[key] * alpha + base[key] * (255 - alpha) + 127) / 255);
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: 255 };
}

function hexColor(color) {
  return `#${[color.r, color.g, color.b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function sourcePath(family) {
  return `packages/tui/src/theme/assets/${family}.json`;
}

function themeColors(theme, variant) {
  const cache = new Map();
  return name => {
    if (!cache.has(name)) {
      const value = theme.theme[name];
      if (value === undefined) throw new Error(`Required TUI theme input "${name}" is missing`);
      const color = resolveColorValue(theme, value, variant);
      if (color.a === 0) throw new Error(`Required TUI theme input "${name}" is transparent`);
      cache.set(name, color);
    }
    return cache.get(name);
  };
}

function requireOpaque(color, name) {
  if (color.a !== 255) throw new Error(`Required TUI background "${name}" is not opaque`);
  return color;
}

function flatten(color, background) {
  return color.a === 255 ? color : composite(color, background);
}

function roleStyle(colors, foregroundName, background, attributes) {
  const foreground = colors(foregroundName);
  return {
    foreground: hexColor(flatten(foreground, parseHexColor(background))),
    background,
    attributes,
  };
}

export function generatePalette(family, label, variant, sourceTheme) {
  const colors = themeColors(sourceTheme, variant);
  const panelBase = requireOpaque(colors('backgroundPanel'), 'backgroundPanel');
  const contextBase = requireOpaque(colors('diffContextBg'), 'diffContextBg');
  const panel = hexColor(panelBase);
  const context = hexColor(contextBase);
  const background = (name, base) => hexColor(flatten(colors(name), base));
  const addedBackground = background('diffAddedBg', panelBase);
  const removedBackground = background('diffRemovedBg', panelBase);
  const addedGutterBackground = background('diffAddedLineNumberBg', contextBase);
  const removedGutterBackground = background('diffRemovedLineNumberBg', contextBase);
  const regions = {};
  for (const name of REGION_ORDER) {
    const [source, attributes] = REGION_DONORS[name];
    regions[name] = {
      foreground: hexColor(flatten(colors(source), panelBase)),
      attributes,
    };
  }
  const roles = {
    panel: roleStyle(colors, 'text', panel, []),
    plain: roleStyle(colors, 'text', panel, []),
    code: roleStyle(colors, 'text', panel, []),
    output: roleStyle(colors, 'text', panel, []),
    empty: roleStyle(colors, 'textMuted', panel, []),
    padding: roleStyle(colors, 'text', panel, []),
    service: roleStyle(colors, 'textMuted', panel, []),
    muted: roleStyle(colors, 'textMuted', panel, []),
    footer: roleStyle(colors, 'textMuted', panel, []),
    reminder: roleStyle(colors, 'textMuted', panel, []),
    overflow: roleStyle(colors, 'textMuted', panel, []),
    diagnostic: roleStyle(colors, 'error', panel, []),
    title: roleStyle(colors, 'text', panel, []),
    prompt: roleStyle(colors, 'textMuted', panel, []),
    frame: roleStyle(colors, 'background', panel, []),
    error: roleStyle(colors, 'error', panel, []),
    errorFrame: roleStyle(colors, 'error', panel, ['bold']),
    warning: roleStyle(colors, 'warning', panel, []),
    gutter: roleStyle(colors, 'textMuted', panel, []),
    numbers: roleStyle(colors, 'textMuted', panel, []),
    contextCode: roleStyle(colors, 'text', context, []),
    contextGutter: roleStyle(colors, 'diffLineNumber', context, []),
    addedCode: roleStyle(colors, 'text', addedBackground, []),
    removedCode: roleStyle(colors, 'text', removedBackground, []),
    addedGutter: roleStyle(colors, 'diffLineNumber', addedGutterBackground, []),
    removedGutter: roleStyle(colors, 'diffLineNumber', removedGutterBackground, []),
    addedSign: roleStyle(colors, 'diffHighlightAdded', addedGutterBackground, []),
    removedSign: roleStyle(colors, 'diffHighlightRemoved', removedGutterBackground, []),
  };
  return {
    revision: 2,
    id: `${family}-${variant}`,
    label: `${label} ${variant === 'dark' ? 'Dark' : 'Light'}`,
    source: { repository: REPOSITORY, commit: COMMIT, path: sourcePath(family), variant },
    regions,
    roles,
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function catalogueBlockText() {
  const lines = ['export const THEME_CATALOGUE: readonly ThemeCatalogueEntry[] = Object.freeze(['];
  for (const [family, label] of FAMILIES) {
    lines.push(`  { id: '${family}-dark', label: '${`${label} Dark`.replace(/'/gu, "\\'")}' }, { id: '${family}-light', label: '${`${label} Light`.replace(/'/gu, "\\'")}' },`);
  }
  lines.push(']);');
  return lines.join('\n');
}

function replaceCatalogueBlock(source, replacement) {
  const starts = [...source.matchAll(/^export const THEME_CATALOGUE: readonly ThemeCatalogueEntry\[\] = Object\.freeze\(\[$/gmu)];
  const ends = [...source.matchAll(/^\]\);$/gmu)];
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index) {
    throw new Error('Expected exactly one bounded THEME_CATALOGUE block in src/themes/catalogue.ts');
  }
  const start = starts[0].index;
  const end = ends[0].index + ends[0][0].length;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function expectedFiles() {
  const files = new Map();
  for (const [family, label] of FAMILIES) {
    const path = join(INPUT_DIR, `${family}.json`);
    let source;
    try { source = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`Cannot read pinned TUI source ${family}.json: ${error.message}`); }
    for (const variant of ['dark', 'light']) {
      const id = `${family}-${variant}`;
      files.set(`src/themes/palettes/${id}.json`, jsonText(generatePalette(family, label, variant, source)));
    }
  }
  return files;
}

function apply(mode) {
  const expected = expectedFiles();
  const cataloguePath = join(ROOT, 'src/themes/catalogue.ts');
  const currentCatalogue = readFileSync(cataloguePath, 'utf8');
  const generatedCatalogue = catalogueBlockText();
  const updatedCatalogue = replaceCatalogueBlock(currentCatalogue, generatedCatalogue);
  const failures = [];
  if (mode === '--write') {
    writeFileSync(cataloguePath, updatedCatalogue);
    for (const [path, content] of expected) writeFileSync(join(ROOT, path), content);
    const expectedAssets = new Set([...expected.keys()].filter(path => path.startsWith('src/themes/palettes/')).map(path => path.slice('src/themes/palettes/'.length)));
    for (const name of readdirSync(OUTPUT_DIR)) {
      if (name.endsWith('.json') && !expectedAssets.has(name)) rmSync(join(OUTPUT_DIR, name));
    }
    return;
  }

  if (updatedCatalogue !== currentCatalogue) failures.push('generated catalogue entries differ: src/themes/catalogue.ts');
  const actualAssets = new Set(readdirSync(OUTPUT_DIR).filter(name => name.endsWith('.json')));
  const expectedAssets = new Set([...expected.keys()].filter(path => path.startsWith('src/themes/palettes/')).map(path => path.slice('src/themes/palettes/'.length)));
  for (const name of actualAssets) if (!expectedAssets.has(name)) failures.push(`unexpected palette asset: src/themes/palettes/${name}`);
  for (const name of expectedAssets) if (!actualAssets.has(name)) failures.push(`missing palette asset: src/themes/palettes/${name}`);
  for (const [path, content] of expected) {
    let actual;
    try { actual = readFileSync(join(ROOT, path), 'utf8'); }
    catch { failures.push(`missing generated file: ${path}`); continue; }
    if (actual !== content) failures.push(`generated file differs: ${path}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  if (!['--check', '--write'].includes(mode)) {
    console.error('Usage: node scripts/themes/opencode-tui.mjs --check|--write');
    process.exitCode = 2;
  } else {
    try { apply(mode); }
    catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
  }
}
