import { CARD_ROLES } from '../../src/occipital/semantic-codec.ts';
import { createSemanticRuleDefinition, SEMANTIC_REGIONS } from '../../src/syntax/semantic-rules.ts';
import type { ConcreteStyle } from '../../src/syntax/style-materialization.ts';

const ink = (red: number) => ({ kind: 'rgb' as const, r: red & 0xff, g: 120, b: 160 });
const style = (red: number): ConcreteStyle => ({ foreground: ink(red), background: { kind: 'terminal-default' }, attributes: 0 });

export function syntheticSelection(seed = 1, owner = 'owned', ruleSeed = seed) {
  const baseDefinition = createSemanticRuleDefinition();
  const definition = { ...baseDefinition, default: { background: baseDefinition.default.background, attributes: baseDefinition.default.attributes,
    attribute_mask: baseDefinition.default.attribute_mask, foreground: { kind: 'binding' as const, slot: ruleSeed % SEMANTIC_REGIONS.length } } };
  const red = seed & 0xff;
  const bindings = SEMANTIC_REGIONS.map(() => ({ ink: ink(red), attributes: 0, attribute_mask: 31 }));
  const roles = Object.fromEntries(CARD_ROLES.map(role => [role, style(red)])) as Record<(typeof CARD_ROLES)[number], ConcreteStyle>;
  return {
    definition,
    bindingRevision: seed + 1,
    palette: `test:${owner}:${seed}`,
    bindings,
    roles,
  };
}

export function compactSelection(seed = 1, owner = 'compact', ruleMarker?: string) {
  const definition: import('../../src/occipital/style-rules.ts').RuleDefinition = {
    revision: 2,
    binding_slots: 1,
    default: { foreground: { kind: 'binding', slot: 0 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 },
    rules: ruleMarker === undefined ? [] : [{ path: [`test.${ruleMarker}`], excludes: [], foreground: { kind: 'binding', slot: 0 },
      background: null, font: null, context: null }],
  };
  const color = seed & 0xff;
  return {
    definition,
    bindingRevision: seed + 1,
    palette: `test:${owner}:${seed}`,
    bindings: [{ ink: ink(color), attributes: 0, attribute_mask: 31 }],
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, style(color)])) as Record<(typeof CARD_ROLES)[number], ConcreteStyle>,
  };
}
