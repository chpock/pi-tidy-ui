import { CARD_ROLES, type CardRole, type StyleExpression } from './semantic-codec.ts';
import { fingerprintNative, fingerprintRules, type RuleDefinition } from './style-rules.ts';
import { materializeStyle, type ConcreteStyle, type StyleBinding } from '../syntax/style-materialization.ts';
import type { SemanticStyleExpectation } from './semantic-protocol.ts';

/** Trusted presentation adapter input. No Theme, UI owner or sampling callback. */
export type StyleSelection = Readonly<{ kind: 'native'; id: string; fingerprint: string }>
  | Readonly<{ kind: 'client'; definition: RuleDefinition; bindingRevision: number; palette: string;
    bindings: readonly StyleBinding[]; roles: Readonly<Record<CardRole, ConcreteStyle>> }>;
export type StyleRoles = Readonly<Record<CardRole, ConcreteStyle>>;
export type PreparedSelection = ReturnType<typeof prepareSelection>;
const base: ConcreteStyle = Object.freeze({ foreground: Object.freeze({ kind: 'terminal-default' }), background: Object.freeze({ kind: 'terminal-default' }), attributes: 0 });

export function selectionBytes(input: StyleSelection): number {
  if (input.kind === 'native') return 512 + 2 * (input.id.length + input.fingerprint.length);
  let bytes = 1024 + 2 * input.palette.length + (CARD_ROLES.length + input.bindings.length) * 512;
  for (const rule of input.definition.rules) {
    bytes += 512 + 128 * (rule.excludes.length + 1);
    for (const path of [rule.path, ...rule.excludes]) for (const name of path) bytes += 64 + name.length * 2;
  }
  return bytes;
}
export function prepareSelection(input: StyleSelection) {
  if (input.kind === 'native') {
    if (!input.id.length || input.id.length > 64) throw new Error('invalid native selection');
    return Object.freeze({ input: Object.freeze({ kind: 'native' as const, id: input.id, fingerprint: input.fingerprint }), rules: fingerprintNative(input.fingerprint, 'rules'),
      palette: fingerprintNative(input.fingerprint, 'palette'), bindingRevision: 0 });
  }
  const rules = fingerprintRules(input.definition);
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 0 || !input.palette.length
    || input.bindings.length !== input.definition.binding_slots || CARD_ROLES.some(role => !input.roles[role])) throw new Error('incomplete client selection');
  // Copy trusted bounded data, not callbacks or a public Theme object. Ownership is
  // funded before this helper runs and survives separately for a physical request.
  const owned: StyleSelection = Object.freeze({ kind: 'client', definition: freezeCopy(input.definition), bindingRevision: input.bindingRevision,
    palette: input.palette, bindings: Object.freeze(input.bindings.map(binding => Object.freeze({ ink: copyInk(binding.ink), attributes: binding.attributes, attribute_mask: binding.attribute_mask }))),
    roles: Object.freeze(Object.fromEntries(CARD_ROLES.map(role => [role, copyLiteral(input.roles[role])]))) as StyleRoles });
  return Object.freeze({ input: owned, rules, palette: input.palette, bindingRevision: input.bindingRevision });
}
function copyInk<T extends StyleBinding['ink']>(ink: T): T {
  return Object.freeze(ink.kind === 'rgb' ? { kind: 'rgb', r: ink.r, g: ink.g, b: ink.b }
    : ink.kind === 'indexed' ? { kind: 'indexed', index: ink.index } : { kind: ink.kind }) as T;
}
function copyLiteral(style: ConcreteStyle): ConcreteStyle {
  return Object.freeze({ foreground: copyInk(style.foreground), background: copyInk(style.background), attributes: style.attributes });
}
function freezeCopy<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => freezeCopy(item))) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCopy(item)]))) as T;
}
export function expectation(selection: PreparedSelection, vocabulary: string): SemanticStyleExpectation {
  return { vocabulary, rules: selection.rules, mode: selection.input.kind, bindingSlots: selection.input.kind === 'client' ? selection.input.definition.binding_slots : 0,
    paletteFingerprint: selection.input.kind === 'native' ? selection.palette : null };
}
export function nativeRoles(styles: readonly StyleExpression[], slots: Uint32Array): StyleRoles {
  return Object.freeze(Object.fromEntries(CARD_ROLES.map((role, i) => [role, materializeStyle(styles[slots[i]! - 1]!, [], base)]))) as StyleRoles;
}
export function concreteStyle(expression: StyleExpression, selection: PreparedSelection, roles: StyleRoles, neutral: 'title' | 'code'): ConcreteStyle {
  return materializeStyle(expression, selection.input.kind === 'client' ? selection.input.bindings : [],
    selection.input.kind === 'client' ? roles[neutral] : base, roles.code.background);
}
