import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { createPiRuleDefinition, PI_DIRECT_BINDINGS, PI_RULE_BINDINGS, PI_MARKER_BINDINGS } from '../../../src/syntax/pi-rules.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';

// Compile against the selected public host graph, without importing it at runtime.
const publicRoles: readonly ThemeColor[] = PI_DIRECT_BINDINGS;

test('Pi rules: local slots cover public syntax and Markdown colors without a plain-code color', () => {
  assert.deepEqual(publicRoles, [
    'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType',
    'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation',
    'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'mdListBullet', 'mdHr',
    'mdQuoteBorder', 'mdCodeBlockBorder', 'error', 'warning', 'toolDiffAdded', 'toolDiffRemoved',
  ]);
  assert.deepEqual(Object.keys(PI_MARKER_BINDINGS), ['headingMarker', 'stringDelimiter', 'inlineCodeDelimiter', 'linkDelimiter']);
  assert.equal(new Set(publicRoles).size, publicRoles.length);
  assert.ok(Object.isFrozen(PI_RULE_BINDINGS));
  const definition = createPiRuleDefinition();
  assert.equal(definition.binding_slots, publicRoles.length + Object.keys(PI_MARKER_BINDINGS).length);
  assert.deepEqual(definition.default, {
    foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0,
  }, 'unsupported/plain code must follow the caller, not a hardcoded file or Bash color');
  assert.match(fingerprintRules(definition), /^[a-f0-9]{64}$/);
});

test('Pi rules: every nested mutable field belongs to its factory caller', () => {
  const first = createPiRuleDefinition(), second = createPiRuleDefinition();
  const before = structuredClone(second), fingerprint = fingerprintRules(second);
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
  assert.deepEqual(createPiRuleDefinition(), before);
});
