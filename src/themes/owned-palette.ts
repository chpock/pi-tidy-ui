import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rgbColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import { CARD_ROLES, type CardRole } from '../occipital/semantic-codec.ts';
import type { StyleBinding } from '../syntax/style-materialization.ts';
import { compileStyleAnsi, type AnsiStyle } from '../syntax/style-ansi.ts';
import { inkColor, outputInk } from '../syntax/pi-color.ts';
import { diffPalette } from '../diff-palette.ts';
import { SEMANTIC_REGIONS } from '../syntax/semantic-rules.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';
import { themeEntry } from './catalogue.ts';

export const OWNED_PALETTE_FILE_BYTES = 32 * 1024;
const MAX_LABEL_BYTES = 64;
const attributeBits = Object.freeze({ bold: 1, italic: 2, underline: 4, faint: 8, strike: 16 });
const cardFields = Object.freeze(['background', 'foreground', 'muted', 'dim', 'title', 'border', 'error', 'warning',
  'added', 'removed', 'addedBackground', 'removedBackground'] as const);
const own = (value: object, key: string) => Object.hasOwn(value, key);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}
function validText(value: unknown, cap: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
    && Buffer.byteLength(value, 'utf8') <= cap && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function hexColor(value: unknown): value is string { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
function parseHexColor(hex: string): Color {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgbColor(value >>> 16, value >>> 8 & 255, value & 255);
}
export class OwnedPaletteDataError extends Error {
  constructor() { super('invalid owned palette data'); this.name = 'OwnedPaletteDataError'; }
}
function invalidPalette(): never { throw new OwnedPaletteDataError(); }
export function parseOwnedPaletteBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength <= 0 || bytes.byteLength > OWNED_PALETTE_FILE_BYTES) invalidPalette();
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch (error) { if (error instanceof OwnedPaletteDataError) throw error; invalidPalette(); }
}
function readPalette(id: string): unknown {
  const entry = themeEntry(id);
  if (!entry) invalidPalette();
  const path = fileURLToPath(new URL(`./palettes/${entry.id}.json`, import.meta.url));
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { invalidPalette(); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > OWNED_PALETTE_FILE_BYTES) invalidPalette();
    const bytes = Buffer.alloc(OWNED_PALETTE_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > OWNED_PALETTE_FILE_BYTES || length !== stat.size) invalidPalette();
    return parseOwnedPaletteBytes(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof OwnedPaletteDataError) throw error;
    invalidPalette();
  } finally { closeSync(fd); }
}
export function validateOwnedPaletteData(value: unknown, id: string) {
  const entry = themeEntry(id);
  if (!entry || !record(value) || !exact(value, ['revision', 'id', 'label', 'source', 'regions', 'card'])
    || value.revision !== 1 || value.id !== entry.id || value.label !== entry.label || !record(value.source)
    || !exact(value.source, ['repository', 'commit', 'path', 'variant'])
    || !validText(value.source.repository, MAX_LABEL_BYTES) || typeof value.source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.source.commit)
    || !validText(value.source.path, 256) || (value.source.variant !== 'light' && value.source.variant !== 'dark')
    || !record(value.regions) || !exact(value.regions, SEMANTIC_REGIONS)
    || !record(value.card) || !exact(value.card, cardFields)) invalidPalette();
  const regions = {} as Record<typeof SEMANTIC_REGIONS[number], { foreground: string; attributes: string[] }>;
  for (const region of SEMANTIC_REGIONS) {
    const style = value.regions[region];
    if (typeof style === 'string') {
      if (!hexColor(style)) invalidPalette();
      regions[region] = { foreground: style, attributes: [] };
      continue;
    }
    if (!record(style) || !exact(style, ['foreground', 'attributes']) || !hexColor(style.foreground)
      || !Array.isArray(style.attributes) || style.attributes.length > 5
      || style.attributes.some(attribute => typeof attribute !== 'string' || !own(attributeBits, attribute))
      || new Set(style.attributes).size !== style.attributes.length) invalidPalette();
    regions[region] = { foreground: style.foreground, attributes: [...style.attributes] as string[] };
  }
  for (const field of cardFields) if (!hexColor(value.card[field])) invalidPalette();
  return { regions, card: value.card as Record<typeof cardFields[number], string> };
}
function ink(hex: string, mode: TerminalColorMode) {
  return outputInk(parseHexColor(hex), mode);
}
function style(foreground: string, background: string, mode: TerminalColorMode, attributes = 0): ConcreteStyle {
  return Object.freeze({ foreground: ink(foreground, mode), background: ink(background, mode), attributes });
}
function surfaceStyle(foreground: string, background: Color, mode: TerminalColorMode): ConcreteStyle {
  return Object.freeze({ foreground: ink(foreground, mode), background: outputInk(background, mode), attributes: 0 });
}

export interface PaletteInputData {
  readonly bindings: readonly StyleBinding[];
  readonly roles: Readonly<Record<CardRole, ConcreteStyle>>;
  readonly compiledRoles: Readonly<Record<CardRole, AnsiStyle>>;
}

/** Validate and detach one owned palette before its funded tables are retained. */
export function parseOwnedPaletteData(value: unknown, id: string, mode: TerminalColorMode): PaletteInputData {
  const palette = validateOwnedPaletteData(value, id);
  const bindings = Object.freeze(SEMANTIC_REGIONS.map(region => {
    const value = palette.regions[region];
    const attributes = value.attributes.reduce((bits, name) => bits | attributeBits[name as keyof typeof attributeBits], 0);
    return Object.freeze({ ink: ink(value.foreground, mode), attributes, attribute_mask: 31 });
  }));
  const card = Object.fromEntries(cardFields.map(field => [field, palette.card[field]])) as Record<typeof cardFields[number], string>;
  const background = card.background, foreground = card.foreground, muted = card.muted, dim = card.dim;
  const roles = {} as Record<CardRole, ConcreteStyle>;
  const base = (role: CardRole, color: string) => { roles[role] = style(color, background, mode); };
  for (const role of ['panel', 'plain', 'code', 'output', 'padding'] as const) base(role, foreground);
  for (const role of ['empty', 'prompt', 'gutter', 'numbers'] as const) base(role, dim);
  for (const role of ['service', 'muted', 'footer', 'reminder', 'overflow'] as const) base(role, muted);
  base('title', card.title); base('frame', card.border); base('error', card.error); base('diagnostic', card.error); base('warning', card.warning);
  roles.errorFrame = style(card.error, background, mode, 1);
  const panelInk = inkColor(roles.panel.background)!;
  const codeInks = [...bindings.map(binding => inkColor(binding.ink)).filter((color): color is Color => color !== undefined), inkColor(roles.code.foreground)!];
  const diff = diffPalette({ panel: panelInk, codeInks, added: inkColor(ink(card.addedBackground, mode)), removed: inkColor(ink(card.removedBackground, mode)),
    numbers: inkColor(ink(dim, mode)), addedSign: inkColor(ink(card.added, mode)), removedSign: inkColor(ink(card.removed, mode)), mode });
  const added = diff.toolDiffAdded!, removed = diff.toolDiffRemoved!;
  roles.addedCode = surfaceStyle(foreground, added.code, mode);
  roles.addedGutter = surfaceStyle(dim, added.gutter, mode);
  roles.addedSign = surfaceStyle(card.added, added.gutter, mode);
  roles.removedCode = surfaceStyle(foreground, removed.code, mode);
  roles.removedGutter = surfaceStyle(dim, removed.gutter, mode);
  roles.removedSign = surfaceStyle(card.removed, removed.gutter, mode);
  const compiledRoles = {} as Record<CardRole, AnsiStyle>;
  for (const role of CARD_ROLES) compiledRoles[role] = compileStyleAnsi(roles[role], mode);
  return Object.freeze({ bindings, roles: Object.freeze(roles), compiledRoles: Object.freeze(compiledRoles) });
}

/** Load one manifest-owned palette without interpreting the ID as a path. */
export function sampleOwnedPalette(id: string, mode: TerminalColorMode): PaletteInputData {
  return parseOwnedPaletteData(readPalette(id), id, mode);
}
