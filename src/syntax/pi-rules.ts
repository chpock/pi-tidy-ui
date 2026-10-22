import type { RuleDefinition, RuleFont, StyleRule } from '../occipital/style-rules.ts';

import type { ThemeColor } from '@earendil-works/pi-coding-agent';

export const PI_DIRECT_BINDINGS = Object.freeze([
  'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType',
  'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'mdListBullet', 'mdHr',
  'mdQuoteBorder', 'mdCodeBlockBorder', 'error', 'warning', 'toolDiffAdded', 'toolDiffRemoved',
] as const satisfies readonly ThemeColor[]);
const marker = (ink: ThemeColor, typography: ThemeColor = ink) => Object.freeze({ ink, typography });
export const PI_MARKER_BINDINGS = Object.freeze({
  headingMarker: marker('mdHeading'),
  stringDelimiter: marker('syntaxString'),
  inlineCodeDelimiter: marker('mdCode'),
  linkDelimiter: marker('mdLink'),
});
/** Stable local slots, not daemon role IDs or additional public Pi theme tokens. */
export const PI_RULE_BINDINGS = Object.freeze([...PI_DIRECT_BINDINGS,
  ...Object.keys(PI_MARKER_BINDINGS) as (keyof typeof PI_MARKER_BINDINGS)[]]);
export function piBindingInkRole(binding: typeof PI_RULE_BINDINGS[number]): ThemeColor {
  return binding in PI_MARKER_BINDINGS ? PI_MARKER_BINDINGS[binding as keyof typeof PI_MARKER_BINDINGS].ink
    : binding as typeof PI_DIRECT_BINDINGS[number];
}

/** Fresh declaration data for the common native resolver; never samples a Pi theme.
 * Native specificity wins per property, with the first declaration winning equal scores.
 * Null properties leave ancestor styles intact; font masks change only their named bits. */
export function createPiRuleDefinition(): RuleDefinition {
  const rule = (path: string[], color: typeof PI_RULE_BINDINGS[number] | null,
    font: RuleFont | null = null, excludes: string[][] = []): StyleRule => ({
    path, excludes: color !== null && !path[0]!.startsWith('invalid.')
      ? [...excludes, ['invalid.illegal'], ['invalid.deprecated']] : excludes,
    foreground: color === null ? null : { kind: 'binding', slot: PI_RULE_BINDINGS.indexOf(color) },
    background: null, font,
  });
  return {
    revision: 1,
    binding_slots: PI_RULE_BINDINGS.length,
    // Neutral code inherits the card's code role: toolTitle for Bash, toolOutput for files.
    default: { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 },
    rules: [
      rule(['punctuation.definition.string'], 'stringDelimiter'),
      rule(['meta.mapping.key.json', 'string'], 'syntaxVariable'),
      rule(['meta.mapping.key.json', 'punctuation.definition.string'], 'syntaxVariable'),
      rule(['meta.mapping.key.json', 'constant.character.escape'], 'syntaxVariable'),
      rule(['variable.function.shell'], 'syntaxFunction'),
      rule(['punctuation.definition.variable.shell'], 'syntaxVariable'),
      rule(['punctuation.definition.parameter.shell'], 'syntaxVariable'),
      rule(['punctuation.section.expansion.parameter'], 'syntaxVariable'),
      rule(['punctuation.definition.comment'], 'syntaxComment'),
      rule(['constant.character.escape'], 'syntaxString'),
      rule(['keyword.operator'], 'syntaxOperator'),
      rule(['storage.type.function'], 'syntaxKeyword'),
      rule(['support.function.builtin'], 'syntaxType'),
      rule(['comment'], 'syntaxComment'),
      rule(['string'], 'syntaxString'),
      rule(['constant.numeric'], 'syntaxNumber'),
      rule(['constant.language'], 'syntaxKeyword'),
      rule(['constant.character'], 'syntaxNumber'),
      rule(['entity.name.function'], 'syntaxFunction'),
      rule(['support.function'], 'syntaxFunction'),
      rule(['entity.name.type'], 'syntaxType'),
      rule(['entity.name.class'], 'syntaxType'),
      rule(['support.type'], 'syntaxType'),
      rule(['support.class'], 'syntaxType'),
      rule(['storage.type.primitive'], 'syntaxType'),
      rule(['storage.type'], 'syntaxKeyword'),
      rule(['variable'], 'syntaxVariable'),
      rule(['entity.other.attribute-name'], 'syntaxVariable'),
      rule(['keyword'], 'syntaxKeyword'),
      rule(['storage.modifier'], 'syntaxKeyword'),
      rule(['entity.name.tag'], 'syntaxKeyword'),
      rule(['punctuation'], 'syntaxPunctuation', null, [
        ['punctuation.definition.strikethrough'], ['punctuation.definition.bold'], ['punctuation.definition.italic'],
      ]),
      rule(['invalid.illegal'], 'error'),
      rule(['invalid.deprecated'], 'warning'),
      rule(['markup.inserted'], 'toolDiffAdded'),
      rule(['markup.inserted', 'punctuation'], 'toolDiffAdded'),
      rule(['markup.deleted'], 'toolDiffRemoved'),
      rule(['markup.deleted', 'punctuation'], 'toolDiffRemoved'),
      rule(['markup.changed'], 'warning'),
      rule(['markup.changed', 'punctuation'], 'warning'),
      rule(['meta.diff.header'], 'mdHeading'),
      rule(['meta.diff.header', 'punctuation'], 'mdHeading'),
      rule(['meta.diff.range'], 'mdHeading'),
      rule(['meta.diff.range', 'punctuation'], 'mdHeading'),
      rule(['meta.preprocessor'], 'syntaxKeyword'),
      rule(['meta.annotation'], 'syntaxKeyword'),
      rule(['markup.heading'], 'mdHeading', { attributes: 1, attribute_mask: 1 }),
      rule(['punctuation.definition.heading'], 'headingMarker'),
      rule(['markup.bold'], null, { attributes: 1, attribute_mask: 1 }),
      rule(['markup.italic'], null, { attributes: 2, attribute_mask: 2 }),
      rule(['markup.strikethrough'], null, { attributes: 16, attribute_mask: 16 }),
      rule(['punctuation.definition.strikethrough'], null, { attributes: 0, attribute_mask: 16 }),
      rule(['markup.underline.link'], 'mdLinkUrl', { attributes: 4, attribute_mask: 4 }),
      rule(['string.other.link'], 'mdLinkUrl'),
      rule(['string.other.link.description.title'], 'syntaxString'),
      rule(['meta.link.inline.description.markdown'], 'mdLink', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.link.reference.description.markdown'], 'mdLink', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.link.reference.literal.description.markdown'], 'mdLink', { attributes: 4, attribute_mask: 4 }),
      rule(['meta.image.inline.description.markdown'], 'mdLink'),
      rule(['meta.image.reference.description.markdown'], 'mdLink'),
      rule(['constant.other.reference.link'], 'mdLink'),
      rule(['punctuation.definition.link'], 'linkDelimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['punctuation.definition.image'], 'linkDelimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['meta.link.inline.markdown', 'punctuation.definition.metadata'], 'linkDelimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['meta.image.inline.markdown', 'punctuation.definition.metadata'], 'linkDelimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['meta.link.reference', 'punctuation.definition.constant'], 'linkDelimiter', { attributes: 0, attribute_mask: 4 }),
      rule(['markup.raw'], 'mdCode'),
      rule(['markup.raw.block'], 'mdCodeBlock'),
      rule(['markup.raw.code-fence'], 'mdCodeBlock'),
      rule(['punctuation.definition.raw'], 'inlineCodeDelimiter'),
      rule(['punctuation.definition.raw.code-fence'], 'mdCodeBlockBorder'),
      rule(['constant.other.language-name.markdown'], 'syntaxType'),
      rule(['markup.quote'], 'mdQuote'),
      rule(['punctuation.definition.blockquote'], 'mdQuoteBorder'),
      rule(['markup.list.numbered.bullet'], 'mdListBullet'),
      rule(['markup.list.unnumbered.bullet'], 'mdListBullet'),
      rule(['punctuation.definition.list_item'], 'mdListBullet'),
      rule(['meta.separator'], 'mdHr'),
      rule(['punctuation.definition.thematic-break'], 'mdHr'),
    ],
  };
}
