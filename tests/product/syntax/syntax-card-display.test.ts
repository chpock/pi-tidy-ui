import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
// Actual public ctx.ui.theme fixture; no private Pi imports in product code.
import { theme } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { prepareFileCard, renderFileCard } from '../../../src/file-card.ts';
import { renderBashCard, bashCommandSource } from '../../../src/bash-card.ts';
import { paintBashCommand, paintFileSource } from '../../../src/syntax/paint.ts';

initTheme('dark', false);
const api = () => import('../../../src/file-card.ts');
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters);
const indexStyle = (2 << 30 | 202) >>> 0;
const read = (text: string) => (consume: (start: number, end: number, style: number) => void) => {
  if (text.length) consume(0, Buffer.byteLength(text), indexStyle);
  return true;
};
const written = (content: string) => ({ toolName: 'write', args: { path: '/tmp/display/a.ts', content }, isPartial: false, result: {} });

test('display model holds glyphs/positions only, not joined logical classifier snapshots', async () => {
  const { displayFileCard } = await api();
  const prepared = prepareFileCard(written('\tconst 界 = "😀";\n'))!;
  Object.defineProperty(prepared.view.lines[0], 'logical', { get() { throw new Error('display visited classifier input'); } });
  const display = displayFileCard(prepared);
  assert.equal(display.path, prepared.path);
  assert.equal(display.label, 'Wrote');
  assert.equal(display.lines[0]!.kind, ' ');
  assert.ok('text' in display.lines[0]! && display.lines[0].text.startsWith('    const'));
  assert.ok(!('sources' in display));
  for (const line of display.lines) assert.ok(!('logical' in line));
  assert.ok(prepared.sources[0]!.text.startsWith('\t'), 'source preparation keeps real tabs separately');
});

test('prepared plain display preserves baseline geometry at zero/narrow/unified/split widths and both margins', async () => {
  const { displayFileCard, renderPreparedFileCard } = await api();
  const nodes = [written('\tconst 界 = "😀";\n'), {
    toolName: 'edit', args: { path: '/tmp/display/a.ts' }, isPartial: false,
    result: { details: { diff: ' 1 before\n-2 old\n+2 new\n 3 after' } },
  }];
  for (const node of nodes) {
    const display = displayFileCard(prepareFileCard(node)!);
    for (const width of [0, 4, 9, 60, 120, 121, 160]) for (const outputPad of [0, 1]) {
      const expected = renderFileCard(node, '/tmp/display', width, theme, undefined, outputPad)!;
      const actual = renderPreparedFileCard(display, '/tmp/display', width, theme, { outputPad });
      assert.deepEqual(actual, expected, `width=${width}, pad=${outputPad}`);
    }
  }
});

test('prepared color rows retain exact glyphs, original indexes and saved omission boundaries', async () => {
  const { displayFileCard, renderPreparedFileCard } = await api();
  const node = { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false,
    result: { details: { diff: '-1 /* old\n+1 /* next\n   ...\n-10 const old = 1;\n+10 const next = 2;' } } };
  const prepared = prepareFileCard(node)!, display = displayFileCard(prepared);
  const styles = new Map<number, string>();
  for (const source of prepared.sources) {
    const rows = paintFileSource(source.text, theme, read(source.text))!;
    source.rows.forEach((index, row) => { if (source.side === 'next' || prepared.view.lines[index]!.kind === '-') styles.set(index, rows[row]!); });
  }
  const before = JSON.stringify(display);
  for (const width of [9, 80, 121, 160]) {
    const actual = renderPreparedFileCard(display, undefined, width, theme, { styledRows: styles });
    const neutral = renderPreparedFileCard(display, undefined, width, theme);
    assert.deepEqual(plain(actual.rows), plain(neutral.rows));
    assert.ok(actual.rows.join('').includes('\x1b[38;5;202m'));
  }
  assert.equal(JSON.stringify(display), before, 'renderer never mutates the shared display model');
});

test('prepared renderer takes current diagnostic/error policy explicitly, not source/result reads or classification', async () => {
  const { displayFileCard, renderPreparedFileCard } = await api();
  const node = { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false,
    result: { isError: true, details: { diff: '-1 old\n+1 new' } } };
  const display = displayFileCard(prepareFileCard(node)!);
  assert.deepEqual(renderPreparedFileCard(display, undefined, 80, theme, { error: true }), renderFileCard(node, undefined, 80, theme));
  const code = written('x');
  const diagnostics = [{ severity: 'error', line: 3, message: 'bad\ncode' }];
  const withDiagnostics = { ...code, result: { details: { diagnostics } } };
  assert.deepEqual(renderPreparedFileCard(displayFileCard(prepareFileCard(code)!), undefined, 60, theme, { diagnostics }), renderFileCard(withDiagnostics, undefined, 60, theme));
});

test('Bash command-only projected rows preserve existing output/overflow/metadata policy at every width', () => {
  const node = { args: { command: 'echo\t界😀\n\tsecond', description: 'description' }, expanded: false, isPartial: false,
    result: { content: [{ type: 'text', text: 'one\n'.repeat(15) }], details: { exit_code: 3 }, isError: true } };
  const source = bashCommandSource(node.args)!;
  for (const width of [7, 12, 24, 60, 100]) for (const outputPad of [0, 1]) {
    const baseline = renderBashCard(node, '/tmp/display', width, theme, outputPad);
    const commandRows = paintBashCommand(source, baseline.geometry.contentWidth, theme, read(source))!;
    const actual = renderBashCard(node, '/tmp/display', width, theme, outputPad, commandRows);
    assert.deepEqual(plain(actual.rows), plain(baseline.rows));
    assert.equal(actual.expandable, baseline.expandable);
    assert.deepEqual(actual.geometry, baseline.geometry);
    assert.ok(actual.rows.join('').includes('\x1b[38;5;202m'));
  }
});
