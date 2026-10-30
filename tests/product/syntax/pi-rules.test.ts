import '../../fixtures/test-guard.mjs';
import { createSemanticRuleDefinition, SEMANTIC_BINDING_SLOTS, SEMANTIC_REGIONS } from '../../../src/syntax/semantic-rules.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { PI_DIRECT_BINDINGS, PI_MARKER_BINDINGS, PI_REGION_ROLES, PI_RULE_BINDINGS } from '../../../src/syntax/pi-adapter.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';

// Compile against the selected public host graph, without importing it at runtime.
const publicRoles: readonly ThemeColor[] = PI_DIRECT_BINDINGS;

test('semantic rules: one 44-slot classifier is adapted to exact public Pi roles', () => {
  assert.deepEqual(publicRoles, [
    'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType',
    'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation',
    'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'mdListBullet', 'mdHr',
    'mdQuoteBorder', 'mdCodeBlockBorder', 'error', 'warning', 'toolDiffAdded', 'toolDiffRemoved', 'accent',
  ]);
  assert.deepEqual(Object.keys(PI_MARKER_BINDINGS), ['headingMarker', 'stringDelimiter', 'inlineCodeDelimiter', 'linkDelimiter']);
  assert.equal(new Set(publicRoles).size, publicRoles.length);
  assert.ok(Object.isFrozen(PI_RULE_BINDINGS));
  const definition = createSemanticRuleDefinition();
  assert.equal(SEMANTIC_BINDING_SLOTS, 44);
  assert.deepEqual(PI_RULE_BINDINGS, SEMANTIC_REGIONS);
  assert.equal(definition.binding_slots, 44);
  const constantSlot = SEMANTIC_REGIONS.indexOf('syntax-constant');
  assert.ok(definition.rules.some(rule => rule.path.join(' ') === 'constant.other'
    && rule.foreground?.kind === 'binding' && rule.foreground.slot === constantSlot),
  'symbolic constants use the common constant slot');
  assert.ok(definition.rules.some(rule => rule.path.join(' ') === 'constant.other.reference.link'
    && rule.foreground?.kind === 'binding' && rule.foreground.slot === SEMANTIC_REGIONS.indexOf('markdown-link-text')),
  'the narrower Markdown reference rule remains authoritative');
  const parameterSlot = SEMANTIC_REGIONS.indexOf('syntax-parameter');
  const parameterRules = definition.rules.filter(rule => rule.foreground?.kind === 'binding' && rule.foreground.slot === parameterSlot);
  assert.ok(parameterRules.some(rule => rule.context?.owner === 'meta.parameters.ts' && rule.path.join(' ') === 'meta.parameters.ts variable.parameter.ts'));
  assert.ok(parameterRules.some(rule => rule.context?.owner === 'meta.function.parameters'
    && rule.context.boundaries.includes('meta.function-call.arguments')
    && rule.context.boundaries.every(boundary => !boundary.startsWith(`${rule.context!.owner}.`))),
  'the Python call-argument boundary is disjoint from its parameter owner');
  assert.ok(parameterRules.some(rule => rule.context?.owner === 'meta.function.inline.parameters'
    && rule.context.boundaries.includes('meta.function-call.arguments')),
  'the nearer lambda declaration remains eligible outside its nested call arguments');
  for (const owner of ['meta.method.parameters', 'meta.function.anonymous.parameters']) {
    assert.ok(parameterRules.some(rule => rule.context?.owner === owner && rule.context.boundaries.includes('meta.annotation.parameters')),
      `${owner} stops at nested annotation arguments`);
  }
  for (const rule of parameterRules) {
    const names = [rule.context!.owner, ...rule.context!.boundaries];
    assert.ok(names.every((name, index) => names.slice(index + 1).every(other =>
      !name.startsWith(`${other}.`) && !other.startsWith(`${name}.`))), 'parameter owner and boundary prefixes are disjoint');
  }
  assert.ok(parameterRules.every(rule => rule.context !== null), 'parameter leaves are qualified by declaration-bearing owners');
  const parameter = PI_RULE_BINDINGS.indexOf('syntax-parameter'), variable = PI_RULE_BINDINGS.indexOf('syntax-variable');
  assert.ok(parameter >= 0 && variable >= 0 && parameter !== variable, 'parameter and variable keep distinct common classifier slots');
  assert.equal(PI_REGION_ROLES['syntax-parameter'], PI_REGION_ROLES['syntax-variable'], 'the final Pi adapter intentionally uses the same public role/ink');
  assert.ok(PI_DIRECT_BINDINGS.includes(PI_REGION_ROLES['syntax-parameter']));
  assert.deepEqual(definition.default, {
    foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0,
  }, 'unsupported/plain code must follow the caller, not a hardcoded file or Bash color');
  assert.match(fingerprintRules(definition), /^[a-f0-9]{64}$/);
});

test('Pi rules: every nested mutable field belongs to its factory caller', () => {
  const first = createSemanticRuleDefinition(), second = createSemanticRuleDefinition();
  const before = structuredClone(second), fingerprint = fingerprintRules(second);
  const firstWithExclusions = first.rules.find(rule => rule.excludes.length > 0)!;
  const secondWithExclusions = second.rules[first.rules.indexOf(firstWithExclusions)]!;
  const originalNestedExclusion = secondWithExclusions.excludes[0]![0]!;
  firstWithExclusions.excludes[0]![0] = 'comment';
  assert.equal(secondWithExclusions.excludes[0]![0], originalNestedExclusion, 'nested exclusion paths are owned by each factory result');
  const firstWithBoundaries = first.rules.find(rule => rule.context?.boundaries.length)!;
  const secondWithBoundaries = second.rules[first.rules.indexOf(firstWithBoundaries)]!;
  const originalBoundary = secondWithBoundaries.context!.boundaries[0]!;
  firstWithBoundaries.context!.boundaries[0] = 'comment';
  assert.equal(secondWithBoundaries.context!.boundaries[0], originalBoundary, 'context boundary arrays are owned by each factory result');
  Object.assign(first.default.foreground, { kind: 'binding', slot: 1 });
  Object.assign(first.default.background, { kind: 'terminal-default' });
  Object.assign(first.default, { attributes: 8, attribute_mask: 8 });
  first.binding_slots = 1;
  for (const rule of first.rules) {
    rule.path.push('comment');
    rule.excludes.push(['string']);
    if (rule.foreground?.kind === 'binding') Object.assign(rule.foreground, { slot: 0 });
    if (rule.font) { rule.font.attributes = 0; rule.font.attribute_mask = 15; }
    rule.background = { kind: 'terminal-default' };
  }
  first.rules.reverse();
  assert.deepEqual(second, before);
  assert.equal(fingerprintRules(second), fingerprint);
  assert.deepEqual(createSemanticRuleDefinition(), before);
});
