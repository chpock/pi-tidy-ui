import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rgbColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import { CARD_ROLES, type CardRole } from '../occipital/semantic-codec.ts';
import type { StyleBinding } from '../syntax/style-materialization.ts';
import { compileStyleAnsi, type AnsiStyle } from '../syntax/style-ansi.ts';
import { outputInk } from '../syntax/pi-color.ts';
import { SEMANTIC_REGIONS } from '../syntax/semantic-rules.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';
import { themeEntry } from './catalogue.ts';

export const OWNED_PALETTE_FILE_BYTES = 32 * 1024;
const attributeBits = Object.freeze({ bold: 1, italic: 2, underline: 4, faint: 8, strike: 16 });
const own = (value: object, key: string) => Object.hasOwn(value, key);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => own(value, key));
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
function regionStyle(value: unknown): { foreground: string; attributes: string[] } {
  if (typeof value === 'string') {
    if (!hexColor(value)) invalidPalette();
    return { foreground: value, attributes: [] };
  }
  if (!record(value) || !exact(value, ['foreground', 'attributes']) || !hexColor(value.foreground)
    || !Array.isArray(value.attributes) || value.attributes.length > 5
    || value.attributes.some(attribute => typeof attribute !== 'string' || !own(attributeBits, attribute))
    || new Set(value.attributes).size !== value.attributes.length) invalidPalette();
  return { foreground: value.foreground, attributes: [...value.attributes] as string[] };
}
export function validateOwnedPaletteData(value: unknown, id: string) {
  const entry = themeEntry(id);
  if (!entry || !record(value) || !exact(value, ['revision', 'id', 'label', 'source', 'regions', 'roles'])
    || value.revision !== 2 || value.id !== entry.id || value.label !== entry.label || !record(value.source)
    || !exact(value.source, ['repository', 'commit', 'path', 'variant'])
    || value.source.repository !== 'anomalyco/opencode' || typeof value.source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.source.commit)
    || value.source.path !== `packages/tui/src/theme/assets/${id.replace(/-(?:dark|light)$/u, '')}.json`
    || (value.source.variant !== 'light' && value.source.variant !== 'dark') || !id.endsWith(`-${value.source.variant}`)
    || !record(value.regions) || !exact(value.regions, SEMANTIC_REGIONS)
    || !record(value.roles) || !exact(value.roles, CARD_ROLES)) invalidPalette();
  const regions = {} as Record<typeof SEMANTIC_REGIONS[number], { foreground: string; attributes: string[] }>;
  for (const region of SEMANTIC_REGIONS) regions[region] = regionStyle(value.regions[region]);
  const roles = {} as Record<CardRole, { foreground: string; background: string; attributes: string[] }>;
  for (const role of CARD_ROLES) {
    const input = value.roles[role];
    if (!record(input) || !exact(input, ['foreground', 'background', 'attributes']) || !hexColor(input.background)) invalidPalette();
    const normalized = regionStyle({ foreground: input.foreground, attributes: input.attributes });
    if (role === 'errorFrame' ? normalized.attributes.length !== 1 || normalized.attributes[0] !== 'bold' : normalized.attributes.length !== 0) invalidPalette();
    roles[role] = { ...normalized, background: input.background };
  }
  return { regions, roles };
}
function ink(hex: string, mode: TerminalColorMode) {
  return outputInk(parseHexColor(hex), mode);
}
function style(foreground: string, background: string, mode: TerminalColorMode, attributes = 0): ConcreteStyle {
  return Object.freeze({ foreground: ink(foreground, mode), background: ink(background, mode), attributes });
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
  const roles = {} as Record<CardRole, ConcreteStyle>;
  for (const role of CARD_ROLES) {
    const input = palette.roles[role];
    const attributes = input.attributes.reduce((bits, name) => bits | attributeBits[name as keyof typeof attributeBits], 0);
    roles[role] = style(input.foreground, input.background, mode, attributes);
  }
  const compiledRoles = {} as Record<CardRole, AnsiStyle>;
  for (const role of CARD_ROLES) compiledRoles[role] = compileStyleAnsi(roles[role], mode);
  return Object.freeze({ bindings, roles: Object.freeze(roles), compiledRoles: Object.freeze(compiledRoles) });
}

/** Load one manifest-owned palette without interpreting the ID as a path. */
export function sampleOwnedPalette(id: string, mode: TerminalColorMode): PaletteInputData {
  return parseOwnedPaletteData(readPalette(id), id, mode);
}
