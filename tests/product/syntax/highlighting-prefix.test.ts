import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightingPrefix } from '../../../src/syntax/highlighting-prefix.ts';
import { HIGHLIGHT_LIMITS } from '../../../src/occipital/limits.ts';

for (const [text, cap, end, bytes] of [
  ['', 4, 0, 0], ['abcd', 4, 4, 4], ['abcé', 4, 3, 3], ['abéz', 4, 3, 4],
  ['a😀z', 4, 1, 1], ['😀z', 4, 2, 4], ['界x', 3, 1, 3],
  ['\ud800x', 3, 1, 3], ['\udc00x', 3, 1, 3], ['\ud800x', 2, 0, 0],
] as const) test(`highlighting prefix scalar endpoint ${JSON.stringify(text)} cap ${cap}`, () => {
  const result = highlightingPrefix(text, cap);
  assert.equal(result.end, end); assert.equal(result.bytes, bytes);
  assert.equal(Buffer.byteLength(text.slice(0, result.end)), bytes);
});

test('highlighting prefix logical lines count terminal LF and blank lines without a phantom tail', () => {
  for (const [text, lines] of [['', 0], ['a', 1], ['a\n', 1], ['\n', 1], ['\n\n', 2], ['a\nb', 2]] as const)
    assert.equal(highlightingPrefix(text, HIGHLIGHT_LIMITS.sourceBytes).lines, lines);
  const prefix = '\n'.repeat(HIGHLIGHT_LIMITS.sourceLines);
  assert.deepEqual(highlightingPrefix(prefix + 'tail', HIGHLIGHT_LIMITS.sourceBytes),
    { end: prefix.length, bytes: prefix.length, lines: HIGHLIGHT_LIMITS.sourceLines, saturated: true });
  const last = '\n'.repeat(HIGHLIGHT_LIMITS.sourceLines - 1) + 'last\n';
  assert.equal(highlightingPrefix(last + 'tail', HIGHLIGHT_LIMITS.sourceBytes).end, last.length);
  assert.equal(highlightingPrefix(last.slice(0, -1), HIGHLIGHT_LIMITS.sourceBytes).lines, HIGHLIGHT_LIMITS.sourceLines);
});

test('highlighting prefix visits no visible suffix beyond the bounded scalar endpoint', t => {
  let visits = 0; const original = String.prototype.charCodeAt;
  t.mock.method(String.prototype, 'charCodeAt', function (this: string, index: number) { visits++; return original.call(this, index); });
  const text = 'x'.repeat(HIGHLIGHT_LIMITS.sourceBytes) + 'suffix'.repeat(100_000);
  assert.equal(highlightingPrefix(text, HIGHLIGHT_LIMITS.sourceBytes).end, HIGHLIGHT_LIMITS.sourceBytes);
  assert.equal(visits, HIGHLIGHT_LIMITS.sourceBytes);
  visits = 0;
  assert.equal(highlightingPrefix(text, HIGHLIGHT_LIMITS.piSourceBytes).end, HIGHLIGHT_LIMITS.piSourceBytes);
  assert.equal(visits, HIGHLIGHT_LIMITS.piSourceBytes);
  visits = 0;
  highlightingPrefix('\n'.repeat(HIGHLIGHT_LIMITS.sourceLines) + text, HIGHLIGHT_LIMITS.sourceBytes);
  assert.equal(visits, HIGHLIGHT_LIMITS.sourceLines);
});
