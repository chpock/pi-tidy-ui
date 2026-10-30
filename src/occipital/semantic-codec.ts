// Flat context/style primitives for the active v4 application contract.
import { HIGHLIGHT_LIMITS, OCCIPITAL_LIMITS } from './limits.ts';

export type LiteralInk = Readonly<{ kind: 'rgb'; r: number; g: number; b: number }>
  | Readonly<{ kind: 'indexed'; index: number }> | Readonly<{ kind: 'terminal-default' }>;
export type Ink = LiteralInk | Readonly<{ kind: 'binding'; slot: number }> | Readonly<{ kind: 'inherit' }>;
export interface StyleExpression {
  readonly foreground: Ink;
  readonly background: Ink;
  readonly attributes: number;
  readonly attribute_mask: number;
}
export const CARD_ROLES = Object.freeze([
  'panel', 'plain', 'code', 'output', 'empty', 'padding', 'service', 'muted', 'footer', 'reminder',
  'overflow', 'diagnostic', 'title', 'prompt', 'frame', 'error', 'errorFrame', 'warning', 'gutter',
  'numbers', 'addedCode', 'addedGutter', 'addedSign', 'removedCode', 'removedGutter', 'removedSign',
] as const);
export type CardRole = typeof CARD_ROLES[number];
export interface StyleIdentity {
  readonly vocabulary: string;
  readonly rules: string;
  readonly bindingSlots: number;
}
export interface ContextBounds { readonly vocabularySize: number; readonly maxBytes: number }
export type SemanticErrorCode = 'invalid_context' | 'unknown_scope' | 'context_limit'
  | 'invalid_style' | 'style_limit' | 'identity_mismatch' | 'invalid_source' | 'source_limit';
export class SemanticError extends Error {
  readonly code: SemanticErrorCode;
  constructor(code: SemanticErrorCode) { super(`occipital ${code}`); this.code = code; }
}

// Accounted policy units, including empty records; not a JS/native allocator or RSS claim.
const ROW_UNITS = 128, WORD_UNITS = 16, STYLE_UNITS = 256;
const uint32 = 0xffffffff;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = uint32): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code: SemanticErrorCode): never { throw new SemanticError(code); }
function charge(value: number, maximum: number, code: SemanticErrorCode): number {
  if (!Number.isSafeInteger(value) || value > maximum) fail(code);
  return value;
}

/** Checks all dictionaries and expanded costs before allocating any expanded word vectors.
 * Repeated equivalent rows are legal and may subsequently share a client-arena entry.
 * Array position + 1 is a reply-local context ID; zero is unclassified, never parsed-empty. */
export function inspectContextBatch(value: unknown, bounds: ContextBounds): {
  words: number; policyBytes: number; materialize: () => Uint32Array[][];
} {
  if (!Array.isArray(value) || value.length > OCCIPITAL_LIMITS.batchSources
    || !integer(bounds.vocabularySize, 1) || !integer(bounds.maxBytes, 0, OCCIPITAL_LIMITS.retainedBytes)) fail('invalid_context');
  const maximum = Math.min(bounds.maxBytes, HIGHLIGHT_LIMITS.decodedBytes);
  let words = 0, policyBytes = 0;
  for (const rows of value) {
    if (!Array.isArray(rows)) fail('invalid_context');
    policyBytes = charge(policyBytes + rows.length * ROW_UNITS, maximum, 'context_limit');
    let previousDepth = 0;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0 || !integer(row[0], 0, previousDepth)) fail('invalid_context');
      const depth = row[0] + row.length - 1;
      policyBytes = charge(policyBytes + depth * WORD_UNITS, maximum, 'context_limit');
      for (let i = 1; i < row.length; i++) if (!integer(row[i], 1, bounds.vocabularySize)) fail('unknown_scope');
      words = charge(words + depth, HIGHLIGHT_LIMITS.contextWords, 'context_limit');
      previousDepth = depth;
    }
  }
  // Borrowed raw input is internal and synchronous: consume before yielding or
  // handing the raw response back to an external owner.
  const materialize = () => (value as number[][][]).map(rows => {
    const paths: Uint32Array[] = [];
    for (const row of rows) {
      const prefix = row[0]!, path = new Uint32Array(prefix + row.length - 1);
      if (prefix) path.set(paths[paths.length - 1]!.subarray(0, prefix));
      for (let i = 1; i < row.length; i++) path[prefix + i - 1] = row[i]!;
      paths.push(path);
    }
    return paths;
  });
  return { materialize, words, policyBytes };
}
export function decodeContextBatch(value: unknown, bounds: ContextBounds): {
  batches: Uint32Array[][]; words: number; policyBytes: number;
} {
  const plan = inspectContextBatch(value, bounds);
  return { batches: plan.materialize(), words: plan.words, policyBytes: plan.policyBytes };
}

function inkKey(value: unknown, identity: Pick<StyleIdentity, 'bindingSlots'>): string {
  if (!object(value)) return fail('invalid_style');
  if (value.kind === 'rgb' && keys(value, ['kind', 'r', 'g', 'b'])
    && [value.r, value.g, value.b].every(part => integer(part, 0, 255))) return `r${value.r},${value.g},${value.b}`;
  if (value.kind === 'indexed' && keys(value, ['kind', 'index']) && integer(value.index, 0, 255)) return `i${value.index}`;
  if (value.kind === 'terminal-default' && keys(value, ['kind'])) return 'd';
  if (value.kind === 'binding' && keys(value, ['kind', 'slot']) && integer(value.slot, 0, Math.min(0xffff, identity.bindingSlots - 1))) return `b${value.slot}`;
  if (value.kind === 'inherit' && keys(value, ['kind'])) return 'h';
  return fail('invalid_style');
}
export function expressionKey(value: unknown, identity: Pick<StyleIdentity, 'bindingSlots'>): string {
  if (!object(value) || !keys(value, ['foreground', 'background', 'attributes', 'attribute_mask'])
    || !integer(value.attributes, 0, 31) || !integer(value.attribute_mask, 0, 31)
    || (value.attributes & ~value.attribute_mask) !== 0) fail('invalid_style');
  return `${inkKey(value.foreground, identity)}/${inkKey(value.background, identity)}/${value.attributes}/${value.attribute_mask}`;
}
function copyInk(value: Ink): Ink { return { ...value }; }

export function decodeStyleResult(value: unknown, identity: StyleIdentity, contextCount: number, maxBytes: number): {
  styles: StyleExpression[]; indices: Uint32Array; policyBytes: number;
} {
  if (!object(value) || !keys(value, ['kind', 'vocabulary', 'rules', 'styles', 'indices']) || value.kind !== 'styles') fail('invalid_style');
  if (!fingerprint(value.vocabulary) || !fingerprint(value.rules)
    || value.vocabulary !== identity.vocabulary || value.rules !== identity.rules) fail('identity_mismatch');
  if (!integer(contextCount) || !integer(maxBytes, 0, OCCIPITAL_LIMITS.retainedBytes)
    || !Array.isArray(value.styles) || !Array.isArray(value.indices) || value.indices.length !== contextCount) fail('invalid_style');
  maxBytes = Math.min(maxBytes, HIGHLIGHT_LIMITS.decodedBytes);
  const policyBytes = charge(value.styles.length * STYLE_UNITS + contextCount * 4, maxBytes, 'style_limit');
  const seen = new Set<string>();
  for (const style of value.styles) {
    const key = expressionKey(style, identity);
    if (seen.has(key)) fail('invalid_style');
    seen.add(key);
  }
  const referenced = new Set<number>();
  for (const id of value.indices) {
    if (!integer(id, 1, value.styles.length)) fail('invalid_style');
    referenced.add(id);
  }
  if (referenced.size !== value.styles.length) fail('invalid_style');
  const styles = (value.styles as unknown as StyleExpression[]).map(style => ({
    foreground: copyInk(style.foreground), background: copyInk(style.background),
    attributes: style.attributes, attribute_mask: style.attribute_mask,
  }));
  return { styles, indices: new Uint32Array(value.indices as number[]), policyBytes };
}
