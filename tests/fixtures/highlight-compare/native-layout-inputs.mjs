const lines = (prefix, count) => Array.from({ length: count }, (_, index) => prefix + (index + 1)).join('\n') + '\n';

export const nativeLayoutInputs = [
  { id: 'empty-pane', filename: 'sample.txt', before: '', after: '\nfirst\nsecond\n',
    roleSamples: [{ role: 'added', newLine: 1, text: '' }, { role: 'added', newLine: 3, text: 'second' }] },
  { id: 'context-only-pane', filename: 'sample.txt', before: 'context\n',
    after: 'context\n' + Array.from({ length: 12 }, (_, index) => 'insert ' + (index + 2)).join('\n') + '\n',
    roleSamples: [{ role: 'context', oldLine: 1, newLine: 1, text: 'context' }, { role: 'added', newLine: 13, text: 'insert 13' }] },
  { id: 'split-digit-boundary', filename: 'sample.txt', before: lines('old ', 9), after: lines('new ', 1),
    roleSamples: [{ role: 'removed', oldLine: 9, text: 'old 9' }, { role: 'added', newLine: 1, text: 'new 1' }] },
  { id: 'unified-digit-boundary', filename: 'sample.txt', before: lines('old ', 9), after: lines('new ', 9),
    roleSamples: [{ role: 'removed', oldLine: 9, text: 'old 9' }, { role: 'added', newLine: 9, text: 'new 9' }] },
];
