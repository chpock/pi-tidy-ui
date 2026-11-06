import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, wrapUnits, WrapFlag } from '../../../src/text-wrap.ts';

test('shared wrapping: fitting fragments move whole, oversized fragments fill the current row', () => {
  assert.deepEqual(wrapText('← Edited abcdefghijklmnop', 19), ['← Edited', 'abcdefghijklmnop']);
  assert.deepEqual(wrapText('← Edited abcdefghijklmnopqrstuvwxyz', 19), ['← Edited abcdefghij', 'klmnopqrstuvwxyz']);
  assert.deepEqual(wrapText('← Edited abcdefghijklmnop', 8), ['← Edited', 'abcdefgh', 'ijklmnop']);
  assert.deepEqual(wrapText('← Edited folder name.ts', 19), ['← Edited folder', 'name.ts']);
  assert.deepEqual(wrapText('  x  ', 3), ['x']);
});

test('shared wrapping: preferred separators and Unicode boundaries preserve logical text', () => {
  const text = '→ Read abcdefghij/kl/mnopqrstuvwxyz0123456789';
  const rows = wrapText(text, 19);
  assert.equal(rows[0], '→ Read abcdefghij/');
  assert.equal(rows.join(''), text);
  assert.deepEqual(wrapText('→ Read 界界界界', 9), ['→ Read 界', '界界界']);
  assert.deepEqual(wrapText('é👩‍💻🙂', 2), ['é', '👩‍💻', '🙂']);
  assert.deepEqual(wrapText('界', 1), ['界']);
  assert.deepEqual(wrapText('界', 1, { wide: 'replace' }), ['�']);
  assert.deepEqual(wrapText('', 12), []);
  assert.deepEqual(wrapText('anything', 0), []);
  assert.throws(() => wrapText('x', -1), /invalid text wrap width/);
  assert.throws(() => wrapText('x', 1.5), /invalid text wrap width/);
});

test('shared wrapping: a visitor can stop at a complete row without a retained result vector', () => {
  const observed: number[][] = [];
  wrapUnits({ length: 20, width: () => 1, flags: () => 0 }, 4, (first, end, cells) => {
    observed.push([first, end, cells]); return observed.length < 2;
  });
  assert.deepEqual(observed, [[0, 4, 4], [4, 8, 4]]);
  const blank: number[][] = [];
  wrapUnits({ length: 20, width: () => 1, flags: () => WrapFlag.Whitespace }, 4, (a, b, c) => { blank.push([a, b, c]); });
  assert.deepEqual(blank, []);
});


test('shared wrapping: full-row fit, half-row preference and final suffix boundaries are inclusive', () => {
  assert.deepEqual(wrapText('→ Read abcdefghijklmnopqrs', 19), ['→ Read', 'abcdefghijklmnopqrs']);
  assert.deepEqual(wrapText('← Edited abcd/' + 'x'.repeat(20), 19), ['← Edited abcd/', 'x'.repeat(19), 'x']);
  assert.deepEqual(wrapText('← Edited ' + 'x'.repeat(26) + '.ts', 19), ['← Edited ' + 'x'.repeat(10), 'x'.repeat(16) + '.ts']);
});

test('shared wrapping: preferred cuts report exact cell counts across mixed-width units', () => {
  const observed: number[][] = [];
  // Units describe `← Edited abcd/🙂xyzabcdefghijklmnop` independently of the string adapter.
  wrapUnits({ length: 34, width: i => i === 14 ? 2 : 1,
    flags: i => i === 1 || i === 8 ? WrapFlag.Whitespace : i === 13 ? WrapFlag.Preferred : 0 }, 19,
  (first, end, cells) => { observed.push([first, end, cells]); });
  assert.deepEqual(observed, [[0, 14, 14], [14, 32, 19], [32, 34, 2]]);
});


test('shared wrapping: zero-width graphemes still fill the current source interval', () => {
  assert.deepEqual(wrapText('abc,\u200bdefgh', 4, { parameterStart: 0, parameterLength: 10 }), ['abc,\u200b', 'defg', 'h']);
  const observed: number[][] = [];
  wrapUnits({ length: 10, width: i => i === 4 ? 0 : 1,
    flags: i => i === 3 ? WrapFlag.BreakAfter | WrapFlag.Preferred : 0 }, 4,
  (first, end, cells) => { observed.push([first, end, cells]); });
  assert.deepEqual(observed, [[0, 5, 4], [5, 9, 4], [9, 10, 1]]);
});
