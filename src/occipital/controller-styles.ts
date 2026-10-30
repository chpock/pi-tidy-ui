import { CARD_ROLES, type CardRole } from './semantic-codec.ts';
import { fingerprintRules, type RuleDefinition } from './style-rules.ts';
import { materializeStyle, type ConcreteStyle, type StyleBinding } from '../syntax/style-materialization.ts';
import type { SemanticStyleExpectation } from './semantic-protocol.ts';

/** Trusted palette input paired with the one shared semantic classifier. */
export type StyleSelection = Readonly<{
  definition: RuleDefinition;
  bindingRevision: number;
  palette: string;
  bindings: readonly StyleBinding[];
  roles: Readonly<Record<CardRole, ConcreteStyle>>;
}>;
export type StyleRoles = Readonly<Record<CardRole, ConcreteStyle>>;
export type PreparedSelection = ReturnType<typeof prepareSelection>;

export function selectionBytes(input: StyleSelection): number {
  let bytes = 1024 + 2 * input.palette.length + (CARD_ROLES.length + input.bindings.length) * 512;
  for (const rule of input.definition.rules) {
    bytes += 512 + 128 * (rule.excludes.length + 1);
    for (const path of [rule.path, ...rule.excludes]) for (const name of path) bytes += 64 + name.length * 2;
    if (rule.context) bytes += 128 * (1 + rule.context.boundaries.length) + 2 * rule.context.owner.length
      + rule.context.boundaries.reduce((total, name) => total + 2 * name.length, 0);
  }
  return bytes;
}
export function prepareSelection(input: StyleSelection) {
  const rules = fingerprintRules(input.definition);
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 0
    || typeof input.palette !== 'string' || input.palette.length < 1 || input.palette.length > 128
    || input.bindings.length !== input.definition.binding_slots || CARD_ROLES.some(role => !input.roles[role])) {
    throw new Error('incomplete style selection');
  }
  // Copy trusted bounded data, not callbacks or a public theme object. Ownership is
  // funded before this helper runs and survives separately for a physical request.
  const owned: StyleSelection = Object.freeze({
    definition: freezeCopy(input.definition),
    bindingRevision: input.bindingRevision,
    palette: input.palette,
    bindings: Object.freeze(input.bindings.map(binding => Object.freeze({
      ink: copyInk(binding.ink), attributes: binding.attributes, attribute_mask: binding.attribute_mask,
    }))),
    roles: Object.freeze(Object.fromEntries(CARD_ROLES.map(role => [role, copyLiteral(input.roles[role])]))) as StyleRoles,
  });
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
  return { vocabulary, rules: selection.rules, bindingSlots: selection.input.definition.binding_slots };
}
export function concreteStyle(expression: import('./semantic-codec.ts').StyleExpression, selection: PreparedSelection,
  roles: StyleRoles, neutral: 'title' | 'code'): ConcreteStyle {
  return materializeStyle(expression, selection.input.bindings, roles[neutral], roles.code.background);
}
