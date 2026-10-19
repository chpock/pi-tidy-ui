import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { fileCardFixture, bashCardFixture } from '../../fixtures/prepared-card.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const theme = getThemeByName('dark')!;
const written = (content: string) => ({ toolName: 'write', args: { path: '/tmp/display/a.ts', content }, isPartial: false, result: {} });

test('prepared framed file rows keep the full card width when an oversized grapheme is replaced', () => {
  // Pi measures three U+093E marks as one three-column grapheme; narrow columns replace it.
  for (const width of [7, 8, 9, 10, 11, 12]) {
    const result = fileCardFixture(written('\u093e'.repeat(3)), undefined, width, theme)!;
    assert.equal(result.framed, true);
    const short = result.rows.map(row => visibleWidth(row)).filter(columns => columns !== width);
    assert.deepEqual(short, [], `width ${width}: rows ${JSON.stringify(result.rows.map(plain))}`);
  }
});

test('prepared plain display preserves baseline geometry at zero/narrow/unified/split widths and both margins', () => {
  const node = { toolName: 'edit', args: { path: '/tmp/display/a.ts' }, isPartial: false,
    result: { details: { diff: ' 1 before\n-2 old\n+2 new\n 3 after' } } };
  for (const width of [0, 4, 9, 60, 120, 121, 160]) for (const pad of [0, 1]) {
    const result = fileCardFixture(node, '/tmp/display', width, theme, undefined, pad)!;
    assert.ok(result.rows.every(row => visibleWidth(row) <= width));
    if (!width) assert.deepEqual(result.rows, []);
    if (width >= 60) {
      const rows = result.rows.map(plain);
      assert.ok(rows.some(row => row.includes('← Edited a.ts')));
      assert.equal(rows.some(row => row.includes('old') && row.includes('new')), width > 120);
      assert.ok(rows.some(row => row.startsWith(pad ? ' ┃' : '┃')));
    }
  }
});

test('prepared color rows retain exact glyphs, original indexes and saved omission boundaries', () => {
  const node = { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false,
    result: { details: { diff: '-1 /* old\n+1 /* next\n   ...\n-10 const old = 1;\n+10 const next = 2;' } } };
  const saved = JSON.stringify(node);
  for (const width of [9, 80, 121, 160]) {
    const calls: string[] = [];
    const colored = fileCardFixture(node, undefined, width, theme, text => { calls.push(text); return text.split('\n').map(row => '\x1b[38;5;202m' + row); })!;
    const neutral = fileCardFixture(node, undefined, width, theme)!;
    assert.deepEqual(colored.rows.map(plain), neutral.rows.map(plain));
    assert.deepEqual(calls, ['/* old', 'const old = 1;', '/* next', 'const next = 2;']);
    assert.ok(colored.rows.join('').includes('\x1b[38;5;202m'));
  }
  assert.equal(JSON.stringify(node), saved);
});

test('prepared renderer takes current diagnostic/error policy explicitly, not source/result reads or classification', () => {
  const code = { ...written('x'), result: { details: { diagnostics: [{ severity: 'error', line: 3, message: 'bad\ncode' }] } } };
  const rows = fileCardFixture(code, undefined, 60, theme)!.rows.map(plain).join('\n');
  assert.match(rows, /Error \[3\]: bad code/);
});

test('Bash command-only projected rows preserve existing output/overflow/metadata policy at every width', () => {
  const node = { args: { command: 'echo\t界😀\n\tsecond', description: 'description' }, expanded: false, isPartial: false,
    result: { content: [{ type: 'text', text: 'one\n'.repeat(15) }], details: { exit_code: 3 }, isError: true } };
  for (const width of [7, 12, 24, 60, 100]) for (const pad of [0, 1]) {
    const result = bashCardFixture(node, '/tmp/display', width, theme, pad);
    assert.equal(result.expandable, true); assert.ok(result.rows.every(row => visibleWidth(row) <= width));
    if (width >= 60) {
      const rows = result.rows.map(plain).join('\n');
      assert.match(rows, /description/); assert.match(rows, /Running in \/tmp\/display/);
      assert.match(rows, /exit code: 3/); assert.match(rows, /Click to expand/);
      assert.equal((rows.match(/one/g) ?? []).length, 10);
    }
  }
});
