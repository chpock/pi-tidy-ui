import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { SEMANTIC_REGIONS, type SemanticRegion } from './semantic-rules.ts';

/** Public Pi roles sampled by the final adapter; these are not classifier slots. */
export const PI_DIRECT_BINDINGS = Object.freeze([
  'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxType',
  'syntaxFunction', 'syntaxVariable', 'syntaxOperator', 'syntaxPunctuation',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'mdListBullet', 'mdHr',
  'mdQuoteBorder', 'mdCodeBlockBorder', 'error', 'warning', 'toolDiffAdded', 'toolDiffRemoved', 'accent',
] as const satisfies readonly ThemeColor[]);

const marker = (ink: ThemeColor, typography: ThemeColor = ink) => Object.freeze({ ink, typography });
export const PI_MARKER_BINDINGS = Object.freeze({
  headingMarker: marker('mdHeading'),
  stringDelimiter: marker('syntaxString'),
  inlineCodeDelimiter: marker('mdCode'),
  linkDelimiter: marker('mdLink'),
});
export const PI_MARKER_REGIONS = Object.freeze({
  headingMarker: 'markdown-heading-marker',
  stringDelimiter: 'syntax-string-delimiter',
  inlineCodeDelimiter: 'markdown-code-delimiter',
  linkDelimiter: 'markdown-link-delimiter',
} as const satisfies Record<keyof typeof PI_MARKER_BINDINGS, SemanticRegion>);
export type PiMarkerBinding = keyof typeof PI_MARKER_BINDINGS;
export type PiDerivedMarker = Exclude<PiMarkerBinding, 'stringDelimiter'>;

/** The Pi adapter intentionally maps multiple classifier regions to the same public role. */
export const PI_REGION_ROLES = Object.freeze({
  'syntax-comment': 'syntaxComment',
  'syntax-regexp': 'syntaxString',
  'syntax-string': 'syntaxString',
  'syntax-keyword': 'syntaxKeyword',
  'syntax-primitive': 'syntaxFunction',
  'syntax-operator': 'syntaxOperator',
  'syntax-variable': 'syntaxVariable',
  'syntax-property': 'syntaxVariable',
  'syntax-type': 'syntaxType',
  'syntax-constant': 'syntaxNumber',
  'syntax-punctuation': 'syntaxPunctuation',
  'syntax-warning': 'warning',
  'syntax-critical': 'error',
  'syntax-diff-add': 'toolDiffAdded',
  'syntax-diff-delete': 'toolDiffRemoved',
  'syntax-diff-unknown': 'warning',
  'markdown-heading': 'mdHeading',
  'markdown-link': 'mdLinkUrl',
  'markdown-link-text': 'mdLink',
  'markdown-code': 'mdCode',
  'markdown-block-quote': 'mdQuote',
  'markdown-strong': 'accent',
  'markdown-horizontal-rule': 'mdHr',
  'markdown-list-item': 'mdListBullet',
  'markdown-list-enumeration': 'mdListBullet',
  'markdown-image': 'mdLinkUrl',
  'markdown-image-text': 'mdLink',
  'markdown-code-block': 'mdCodeBlock',
  'syntax-number': 'syntaxNumber',
  'syntax-language-constant': 'syntaxKeyword',
  'syntax-parameter': 'syntaxVariable',
  'syntax-function-builtin': 'syntaxType',
  'syntax-command': 'syntaxFunction',
  'syntax-escape': 'syntaxString',
  'syntax-string-delimiter': 'syntaxString',
  'syntax-tag': 'syntaxKeyword',
  'syntax-attribute': 'syntaxVariable',
  'syntax-preprocessor': 'syntaxKeyword',
  'syntax-diff-header': 'mdHeading',
  'markdown-heading-marker': 'mdHeading',
  'markdown-code-delimiter': 'mdCode',
  'markdown-link-delimiter': 'mdLink',
  'markdown-code-fence': 'mdCodeBlockBorder',
  'markdown-quote-border': 'mdQuoteBorder',
} as const satisfies Record<SemanticRegion, ThemeColor>);

export function piBindingInkRole(binding: SemanticRegion): ThemeColor {
  const markerBinding = (Object.keys(PI_MARKER_REGIONS) as PiMarkerBinding[])
    .find(name => PI_MARKER_REGIONS[name] === binding);
  return markerBinding ? PI_MARKER_BINDINGS[markerBinding].ink : PI_REGION_ROLES[binding];
}

export const PI_RULE_BINDINGS = SEMANTIC_REGIONS;
