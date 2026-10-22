import { createHash } from 'node:crypto';
import { expressionKey, type Ink, type StyleExpression } from './semantic-codec.ts';

export interface RuleFont { attributes: number; attribute_mask: number }
export interface StyleRule {
  path: string[];
  excludes: string[][];
  foreground: Ink | null;
  background: Ink | null;
  font: RuleFont | null;
}
export interface RuleDefinition {
  revision: 1;
  binding_slots: number;
  default: StyleExpression;
  rules: StyleRule[];
}
const limits = { selectors: 512, paths: 4096, atoms: 4096, nameBytes: 256 * 1024 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const inherit = { kind: 'inherit' } as const;
function reject(): never { throw new Error('occipital invalid_rules'); }
function ruleExpression(rule: StyleRule): StyleExpression {
  return { foreground: rule.foreground ?? inherit, background: rule.background ?? inherit,
    attributes: rule.font === null ? 0 : rule.font.attributes, attribute_mask: rule.font === null ? 0 : rule.font.attribute_mask };
}
function validate(value: unknown): RuleDefinition {
  if (!object(value) || !keys(value, ['revision', 'binding_slots', 'default', 'rules']) || value.revision !== 1
    || typeof value.binding_slots !== 'number' || !Number.isInteger(value.binding_slots) || value.binding_slots < 0 || value.binding_slots > 65536
    || !Array.isArray(value.rules) || value.rules.length > limits.selectors) reject();
  const identity = { mode: 'client', bindingSlots: value.binding_slots } as const;
  expressionKey(value.default, identity);
  let paths = 0, atoms = 0, nameBytes = 0;
  const path = (value: unknown) => {
    if (!Array.isArray(value) || ++paths > limits.paths) reject();
    for (const name of value) {
      if (typeof name !== 'string' || name.length === 0 || name.length > limits.nameBytes || /[\s\p{Cc}\p{Cs}]/u.test(name)) reject();
      nameBytes += Buffer.byteLength(name);
      if (nameBytes > limits.nameBytes || ++atoms > limits.atoms) reject();
      let end = name.length, count = 1;
      while (end > 0 && name.charCodeAt(end - 1) === 46) end--;
      for (let index = 0; index < end; index++) {
        if (name.charCodeAt(index) === 46 && (++count > 8 || ++atoms > limits.atoms)) reject();
      }
    }
  };
  for (const rule of value.rules) {
    if (!object(rule) || !keys(rule, ['path', 'excludes', 'foreground', 'background', 'font']) || !Array.isArray(rule.excludes)) reject();
    path(rule.path);
    for (const excluded of rule.excludes) path(excluded);
    if (rule.foreground === undefined || rule.background === undefined
      || rule.font !== null && (!object(rule.font) || !keys(rule.font, ['attributes', 'attribute_mask']))) reject();
    expressionKey(ruleExpression(rule as unknown as StyleRule), identity);
  }
  // Membership is native dictionary lookup, never an attempt to intern these names in JS.
  return value as unknown as RuleDefinition;
}

/** Hashes rule data, not public Pi colors or source/geometry. Field/path/order and
 * explicit-null/clear distinctions are framed independently of JSON object order. */
export function fingerprintRules(value: unknown): string {
  const definition = validate(value), identity = { mode: 'client', bindingSlots: definition.binding_slots } as const;
  const hash = createHash('sha256').update('occipital-client-rules/2\0'), word = Buffer.allocUnsafe(4);
  const number = (n: number) => { word.writeUInt32BE(n); hash.update(word); };
  const text = (s: string) => { number(Buffer.byteLength(s)); hash.update(s, 'utf8'); };
  const path = (names: readonly string[]) => { number(names.length); for (const name of names) text(name); };
  number(definition.binding_slots);
  text(expressionKey(definition.default, identity));
  number(definition.rules.length);
  for (const rule of definition.rules) {
    path(rule.path);
    number(rule.excludes.length);
    for (const excluded of rule.excludes) path(excluded);
    hash.update(Buffer.from([(rule.foreground !== null ? 1 : 0) | (rule.background !== null ? 2 : 0) | (rule.font !== null ? 4 : 0)]));
    text(expressionKey(ruleExpression(rule), identity));
  }
  return hash.digest('hex');
}

/** Definition content and interpretation revision, never Pi colors or source text. */
export function fingerprintNative(definition: string, kind: 'rules' | 'palette'): string {
  if (!/^[a-f0-9]{64}$/.test(definition) || (kind !== 'rules' && kind !== 'palette')) reject();
  return createHash('sha256').update(`occipital-native-${kind}/2\0`).update(definition, 'ascii').digest('hex');
}
