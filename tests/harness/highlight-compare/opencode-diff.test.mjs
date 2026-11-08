import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOpenCodeDiff, mapOpenCodeDiff } from '../../../scripts/highlight-compare/adapters/opencode-diff.mjs';
import { normalizeDiff } from '../../../scripts/highlight-compare/diff.mjs';
import { digest } from '../../../scripts/highlight-compare/model.mjs';

const before = 'context\nold\ntail\n', after = 'context\nnew\ntail\n';
const logicalRows = [{ role: 'context', oldLine: 1, newLine: 1, text: 'context' },
  { role: 'removed', oldLine: 2, text: 'old' }, { role: 'added', newLine: 2, text: 'new' },
  { role: 'context', oldLine: 3, newLine: 3, text: 'tail' }];
const fixture = { id: 'native-diff-unit', filename: 'sample.txt', kind: 'diff', before, after,
  sha256: digest(JSON.stringify([digest(before), digest(after)])), logicalRows, roleSamples: logicalRows.slice(0, 3),
  patch: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail\n' };
// Independent small cell vectors exercise the adapter's proof boundary, not actual native collection.
const profile = { family: 'unit-vector', variant: 'dark', provenance: { purpose: 'unit-only' }, assets: {
  'unit-vector': { theme: { backgroundPanel: { dark: '#010409', light: '#eeeeee' } } },
  opencode: { theme: { backgroundPanel: { dark: '#141414', light: '#fafafa' } } },
} };
function page() {
  const screen = ['  ┃', '  ┃  ← Edit sample.txt', '  ┃', '  ┃    1   context', '  ┃    2 - old', '  ┃    2 + new', '  ┃    3   tail', '  ┃'];
  return { frame: 7, rendering: false, width: 60, rows: screen.length, screen,
    cells: screen.map(row => Array.from(row.padEnd(60), text => ({ text, width: 1,
      fgMode: 0x3000000, fg: 0, bgMode: 0x3000000, bg: 0x010409 }))) };
}
function second() { const value = page(); value.frame = 10; return value; }
const proof = (...pages) => observeOpenCodeDiff(fixture, pages, profile);

test('OpenCode structural readiness verifies the complete native hunk and retains the attributed theme witness', () => {
  const result = proof(page(), second());
  assert.equal(result.readiness.status, 'ready');
  assert.equal(result.diffMap.viewIdentity, 'unified');
  assert.deepEqual(result.readiness.frames.map(item => item.frame), [7, 10]);
  assert.equal(result.readiness.frames.every(item => item.witnesses.length > 0), true);
  assert.equal(result.readiness.themeWitness.observations.some(item => !item.matched), true, 'other native paint deviations are retained, not reclassified as unprepared syntax');
  assert.match(result.readiness.syntaxCompletion, /no syntax-parser readiness claim/);
});

test('OpenCode structural readiness rejects zero, unfinished, unmarked and repeated native frames', () => {
  const zero = page(); zero.frame = 0;
  assert.throws(() => proof(zero), /completed native synchronized frames/);
  const partial = second(); partial.rendering = true;
  assert.throws(() => proof(page(), partial), /completed native synchronized frames/);
  const unmarked = page(); delete unmarked.rendering;
  assert.throws(() => proof(unmarked), /completed native synchronized frames/);
  assert.throws(() => proof(page(), page()), /distinct completed/);
});

test('a complete first diff frame cannot supply missing canonical rows in the later native frame', () => {
  const partial = second();
  partial.cells[6].forEach((cell, column) => { if (column >= 6) cell.text = ' '; });
  assert.throws(() => proof(page(), partial), /complete|coverage/i);
});

test('each native diff frame requires a mapped exclusive theme witness, not arbitrary UI RGB', () => {
  const wrong = second(); wrong.cells.flat().forEach(cell => { cell.bg = 0x141414; });
  wrong.cells[1][50].bg = 0x010409;
  assert.throws(() => proof(wrong), /discriminating structural RGB/);
  assert.throws(() => proof(page(), wrong), /Overlapping.*disagree|witness on page 1/);
});

test('observed OpenCode split panes, not nominal terminal width, determine the native view', () => {
  const candidate = page();
  for (let row = 3; row < candidate.cells.length; row++) {
    candidate.cells[row].forEach((cell, column) => { if (column >= 6) cell.text = ' '; });
  }
  const put = (row, column, text) => Array.from(text).forEach((character, index) => { candidate.cells[row][column + index].text = character; });
  put(3, 6, ' 1   context'); put(3, 32, ' 1   context');
  put(4, 6, ' 2 - old'); put(4, 32, ' 2 + new');
  put(5, 6, ' 3   tail'); put(5, 32, ' 3   tail');
  candidate.screen = candidate.cells.map(row => row.map(cell => cell.text).join(''));
  const result = proof(candidate);
  assert.equal(result.diffMap.viewIdentity, 'split');
  assert.equal(result.readiness.viewIdentity, 'split');
  assert.deepEqual([...new Set(result.diffMap.sourceMaps.flat().map(range => range.side))], ['old', 'new']);
});

test('a one-sided deletion compatible with two native layouts remains unresolved instead of choosing the first', () => {
  const before = 'old\n', after = '';
  const deletion = { id: 'ambiguous-deletion', filename: 'sample.txt', kind: 'diff', before, after,
    sha256: digest(JSON.stringify([digest(before), digest(after)])),
    logicalRows: [{ role: 'removed', oldLine: 1, text: 'old' }], roleSamples: [{ role: 'removed', oldLine: 1, text: 'old' }],
    patch: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +0,0 @@\n-old\n' };
  const candidate = page();
  for (let row = 3; row < candidate.cells.length; row++) candidate.cells[row].forEach((cell, column) => { if (column >= 6) cell.text = ' '; });
  Array.from(' 1 - old').forEach((character, index) => { candidate.cells[3][6 + index].text = character; });
  candidate.screen = candidate.cells.map(row => row.map(cell => cell.text).join(''));
  for (const view of ['unified', 'split']) assert.doesNotThrow(() => normalizeDiff(deletion, [candidate], mapOpenCodeDiff(deletion, [candidate], view)));
  assert.throws(() => observeOpenCodeDiff(deletion, [candidate], profile), /one complete unambiguous native view/);
});
