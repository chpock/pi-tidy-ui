export const CARD_ROLES = Object.freeze([
  'panel', 'plain', 'code', 'output', 'empty', 'padding', 'service', 'muted', 'footer', 'reminder',
  'overflow', 'diagnostic', 'title', 'prompt', 'frame', 'error', 'errorFrame', 'warning', 'gutter',
  'numbers', 'addedCode', 'addedGutter', 'addedSign', 'removedCode', 'removedGutter', 'removedSign', 'contextCode', 'contextGutter',
] as const);
export type CardRole = typeof CARD_ROLES[number];
