import type { RuleDefinition, RuleFont, StyleRule } from '../occipital/style-rules.ts';

/** Ordered local binding slots, not daemon role IDs. Colors are supplied by the caller. */
export const PI_RULE_BINDINGS = Object.freeze([
  'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType',
  'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'mdListBullet', 'mdHr',
] as const);

/** Fresh declaration data for the common native resolver; never samples a Pi theme.
 * Native specificity wins per property, with the first declaration winning equal scores.
 * Null properties leave ancestor styles intact; font masks change only their named bits. */
export function createPiRuleDefinition(): RuleDefinition {
  const rule = (path: string[], color: typeof PI_RULE_BINDINGS[number] | null,
    font: RuleFont | null = null, excludes: string[][] = []): StyleRule => ({
    path, excludes, foreground: color === null ? null : { kind: 'binding', slot: PI_RULE_BINDINGS.indexOf(color) },
    background: null, font,
  });
  return {
    revision: 1,
    binding_slots: PI_RULE_BINDINGS.length,
    // Neutral code inherits the card's code role: toolTitle for Bash, toolOutput for files.
    default: { foreground: { kind: 'inherit' }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 },
    rules: [
      rule(['punctuation.definition.string'], 'syntaxString'),
      rule(['punctuation.definition.comment'], 'syntaxComment'),
      rule(['constant.character.escape'], 'syntaxString'),
      rule(['keyword.operator'], 'syntaxOperator'),
      rule(['storage.type.function'], 'syntaxKeyword'),
      rule(['support.function.builtin'], 'syntaxType'),
      rule(['comment'], 'syntaxComment'),
      rule(['string'], 'syntaxString'),
      rule(['constant.numeric'], 'syntaxNumber'),
      rule(['constant.language'], 'syntaxNumber'),
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
      rule(['entity.name.tag'], 'syntaxPunctuation'),
      rule(['punctuation'], 'syntaxPunctuation'),
      rule(['meta.preprocessor'], 'syntaxKeyword'),
      rule(['meta.annotation'], 'syntaxKeyword'),
      rule(['markup.heading'], 'mdHeading', { attributes: 1, attribute_mask: 1 }),
      rule(['markup.bold'], null, { attributes: 1, attribute_mask: 1 }),
      rule(['markup.italic'], null, { attributes: 2, attribute_mask: 2 }),
      rule(['markup.underline.link'], 'mdLinkUrl', { attributes: 4, attribute_mask: 4 }),
      rule(['string.other.link'], 'mdLinkUrl'),
      rule(['meta.link.inline.description.markdown'], 'mdLink', { attributes: 4, attribute_mask: 4 }),
      rule(['markup.raw'], 'mdCode'),
      rule(['markup.raw.block'], 'mdCodeBlock'),
      rule(['markup.raw.code-fence'], 'mdCodeBlock'),
      rule(['markup.quote'], 'mdQuote'),
      rule(['markup.list.numbered.bullet'], 'mdListBullet'),
      rule(['markup.list.unnumbered.bullet'], 'mdListBullet'),
      rule(['punctuation.definition.list_item'], 'mdListBullet'),
      rule(['meta.separator'], 'mdHr'),
      rule(['punctuation.definition.thematic-break'], 'mdHr'),
    ],
  };
}
