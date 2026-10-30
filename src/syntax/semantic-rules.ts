import type { RuleDefinition, RuleFont, StyleRule } from '../occipital/style-rules.ts';

export const SEMANTIC_REGIONS = Object.freeze([
  'syntax-comment', 'syntax-regexp', 'syntax-string', 'syntax-keyword', 'syntax-primitive', 'syntax-operator',
  'syntax-variable', 'syntax-property', 'syntax-type', 'syntax-constant', 'syntax-punctuation', 'syntax-warning',
  'syntax-critical', 'syntax-diff-add', 'syntax-diff-delete', 'syntax-diff-unknown',
  'markdown-heading', 'markdown-link', 'markdown-link-text', 'markdown-code', 'markdown-block-quote', 'markdown-strong',
  'markdown-horizontal-rule', 'markdown-list-item', 'markdown-list-enumeration', 'markdown-image', 'markdown-image-text',
  'markdown-code-block',
  'syntax-number', 'syntax-language-constant', 'syntax-parameter', 'syntax-function-builtin', 'syntax-command',
  'syntax-escape', 'syntax-string-delimiter', 'syntax-tag', 'syntax-attribute', 'syntax-preprocessor', 'syntax-diff-header',
  'markdown-heading-marker', 'markdown-code-delimiter', 'markdown-link-delimiter', 'markdown-code-fence', 'markdown-quote-border',
] as const);
export type SemanticRegion = typeof SEMANTIC_REGIONS[number];

export const SEMANTIC_BINDING_SLOTS = SEMANTIC_REGIONS.length;

const context = (owner: string, boundaries: string[] = []) => ({ owner, boundaries });

function rule(
  path: string[],
  foreground: SemanticRegion | null,
  font: RuleFont | null = null,
  excludes: string[][] = [],
  qualifier: ReturnType<typeof context> | null = null,
): StyleRule {
  const allExcludes = [
    ...excludes.map(boundary => [...boundary]),
    ...(foreground !== null && !path[0]!.startsWith('invalid.') ? [['invalid.illegal'], ['invalid.deprecated']] : []),
  ];
  return {
    path,
    excludes: allExcludes,
    foreground: foreground === null ? null : { kind: 'binding', slot: SEMANTIC_REGIONS.indexOf(foreground) },
    background: null,
    font,
    context: qualifier,
  };
}

const typeScriptKey = (leaf: string) => rule(
  ['meta.object-literal.key', leaf], 'syntax-property', null, [],
  context('meta.object-literal.key', ['meta.array.literal', 'meta.template.expression']),
);
const jsonKey = (leaf: string) => rule(
  ['meta.mapping.key.json', leaf], 'syntax-property', null, [], context('meta.mapping.key.json'),
);
const parameter = (owner: string, leaf: string, boundaries: string[] = []) => rule(
  [owner, leaf], 'syntax-parameter', null, [], context(owner, boundaries),
);

/** One binding-only semantic classifier shared by every appearance palette. */
export function createSemanticRuleDefinition(): RuleDefinition {
  return {
    revision: 2,
    binding_slots: SEMANTIC_BINDING_SLOTS,
    default: { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 },
    rules: [
      rule(['punctuation.definition.string'], 'syntax-string-delimiter'),
      jsonKey('string'),
      jsonKey('punctuation.definition.string'),
      jsonKey('constant.character.escape'),
      typeScriptKey('string'),
      typeScriptKey('punctuation.definition.string'),
      typeScriptKey('constant.character.escape'),
      typeScriptKey('constant.numeric'),
      rule(['meta.object-literal.key'], 'syntax-property', null, [],
        context('meta.object-literal.key', ['meta.array.literal', 'meta.template.expression'])),
      rule(['variable.function.shell'], 'syntax-command'),
      rule(['punctuation.definition.variable.shell'], 'syntax-variable'),
      rule(['punctuation.definition.parameter.shell'], 'syntax-variable'),
      rule(['punctuation.section.expansion.parameter'], 'syntax-variable'),
      parameter('meta.parameters.ts', 'variable.parameter.ts'),
      parameter('meta.function.parameters', 'variable.parameter', [
        'meta.function.inline.parameters', 'meta.function-call.arguments',
      ]),
      parameter('meta.function.inline.parameters', 'variable.parameter', ['meta.function-call.arguments']),
      parameter('meta.method.parameters', 'variable.parameter', ['meta.annotation.parameters']),
      parameter('meta.function.anonymous.parameters', 'variable.parameter', ['meta.annotation.parameters']),
      rule(['punctuation.definition.comment'], 'syntax-comment'),
      rule(['constant.character.escape'], 'syntax-escape'),
      rule(['string.regexp'], 'syntax-regexp'),
      rule(['keyword.operator'], 'syntax-operator'),
      rule(['storage.type.function'], 'syntax-keyword'),
      rule(['support.function.builtin'], 'syntax-function-builtin'),
      rule(['comment'], 'syntax-comment'),
      rule(['string'], 'syntax-string'),
      rule(['constant.numeric'], 'syntax-number'),
      rule(['constant.language'], 'syntax-language-constant'),
      rule(['constant.character'], 'syntax-constant'),
      rule(['constant.other'], 'syntax-constant'),
      rule(['entity.name.function'], 'syntax-primitive'),
      rule(['support.function'], 'syntax-primitive'),
      rule(['entity.name.type'], 'syntax-type'),
      rule(['entity.name.class'], 'syntax-type'),
      rule(['support.type'], 'syntax-type'),
      rule(['support.class'], 'syntax-type'),
      rule(['storage.type.primitive'], 'syntax-type'),
      rule(['storage.type'], 'syntax-keyword'),
      rule(['variable'], 'syntax-variable'),
      rule(['entity.other.attribute-name'], 'syntax-attribute'),
      rule(['keyword'], 'syntax-keyword'),
      rule(['storage.modifier'], 'syntax-keyword'),
      rule(['entity.name.tag'], 'syntax-tag'),
      rule(['punctuation'], 'syntax-punctuation', null, [
        ['punctuation.definition.strikethrough'], ['punctuation.definition.bold'], ['punctuation.definition.italic'],
      ]),
      rule(['invalid.illegal'], 'syntax-critical'),
      rule(['invalid.deprecated'], 'syntax-warning'),
      rule(['markup.inserted'], 'syntax-diff-add'),
      rule(['markup.inserted', 'punctuation'], 'syntax-diff-add'),
      rule(['markup.deleted'], 'syntax-diff-delete'),
      rule(['markup.deleted', 'punctuation'], 'syntax-diff-delete'),
      rule(['markup.changed'], 'syntax-diff-unknown'),
      rule(['markup.changed', 'punctuation'], 'syntax-diff-unknown'),
      rule(['meta.diff.header'], 'syntax-diff-header'),
      rule(['meta.diff.header', 'punctuation'], 'syntax-diff-header'),
      rule(['meta.diff.range'], 'syntax-diff-header'),
      rule(['meta.diff.range', 'punctuation'], 'syntax-diff-header'),
      rule(['meta.preprocessor'], 'syntax-preprocessor'),
      rule(['meta.annotation'], 'syntax-preprocessor'),
      rule(['markup.heading'], 'markdown-heading', { attributes: 1, attribute_mask: 1 }),
      rule(['punctuation.definition.heading'], 'markdown-heading-marker'),
      rule(['markup.bold.markdown'], 'markdown-strong'),
      rule(['markup.bold'], null, { attributes: 1, attribute_mask: 1 }),
      rule(['markup.italic'], null, { attributes: 2, attribute_mask: 2 }),
      rule(['markup.strikethrough'], null, { attributes: 16, attribute_mask: 16 }),
      rule(['punctuation.definition.strikethrough'], null, { attributes: 0, attribute_mask: 16 }),
      rule(['markup.underline.link.image'], 'markdown-image', { attributes: 4, attribute_mask: 4 }),
      rule(['markup.underline.link'], 'markdown-link', { attributes: 4, attribute_mask: 4 }),
      rule(['string.other.link'], 'markdown-link'),
      rule(['string.other.link.description.title'], 'syntax-string'),
      rule(['meta.link.inline.description.markdown'], 'markdown-link-text', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.link.reference.description.markdown'], 'markdown-link-text', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.link.reference.literal.description.markdown'], 'markdown-link-text', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.image.inline.description.markdown'], 'markdown-image-text'),
      rule(['meta.image.reference.description.markdown'], 'markdown-image-text'),
      rule(['constant.other.reference.link'], 'markdown-link-text'),
      rule(['punctuation.definition.link'], 'markdown-link-delimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['punctuation.definition.image'], 'markdown-link-delimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['meta.link.inline', 'punctuation.definition.metadata'], 'markdown-link-delimiter', { attributes: 0, attribute_mask: 4 }, [], context('meta.link.inline')),
      rule(['meta.image.inline', 'punctuation.definition.metadata'], 'markdown-link-delimiter', { attributes: 0, attribute_mask: 4 }, [], context('meta.image.inline')),
      rule(['meta.link.reference', 'punctuation.definition.constant'], 'markdown-link-delimiter', { attributes: 0, attribute_mask: 4 }, [], context('meta.link.reference')),
      rule(['markup.raw.inline'], 'markdown-code'),
      rule(['markup.raw.block'], 'markdown-code-block'),
      rule(['markup.raw.code-fence'], 'markdown-code-block'),
      rule(['punctuation.definition.raw'], 'markdown-code-delimiter'),
      rule(['punctuation.definition.raw.code-fence'], 'markdown-code-fence'),
      rule(['constant.other.language-name.markdown'], 'syntax-type'),
      rule(['markup.quote'], 'markdown-block-quote'),
      rule(['punctuation.definition.blockquote'], 'markdown-quote-border'),
      rule(['markup.list.unnumbered.bullet'], 'markdown-list-item'),
      rule(['markup.list.numbered.bullet'], 'markdown-list-enumeration'),
      rule(['markup.list.unnumbered', 'punctuation.definition.list_item'], 'markdown-list-item', null, [], context('markup.list.unnumbered')),
      rule(['markup.list.numbered', 'punctuation.definition.list_item'], 'markdown-list-enumeration', null, [], context('markup.list.numbered')),
      rule(['meta.separator.thematic-break'], 'markdown-horizontal-rule'),
      rule(['punctuation.definition.thematic-break'], 'markdown-horizontal-rule'),
    ],
  };
}
