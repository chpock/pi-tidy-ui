import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPiDiffPaint } from '../../../scripts/highlight-compare/adapters/pi-diff.mjs';

const foreground = 0x778899, panel = 0x101112;
const compiled = (fg, bg) => ({ open: `\x1b[38;2;${fg >> 16};${fg >> 8 & 255};${fg & 255}m\x1b[48;2;${bg >> 16};${bg >> 8 & 255};${bg & 255}m\x1b[22;23;24;29m`, close: '\x1b[0m' });
const cell = (text, fg, bg) => ({ text, width: 1, fg, fgMode: 0x3000000, bg, bgMode: 0x3000000,
  bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false });
function example() {
  const fixture = { kind: 'diff', filename: 'sample.txt', logicalRows: [
    { role: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { role: 'removed', text: 'b', oldLine: 2 },
    { role: 'added', text: 'c', newLine: 2 },
  ] };
  const definitions = { panel: [foreground, panel], padding: [foreground, panel], empty: [foreground, panel],
    contextCode: [foreground, panel], contextGutter: [0x556677, panel],
    removedCode: [foreground, 0x330011], removedGutter: [0x111122, 0x440022], removedSign: [0xff0000, 0x550033],
    addedCode: [foreground, 0x003311], addedGutter: [0x112211, 0x004422], addedSign: [0x00ff00, 0x005533] };
  const roles = Object.fromEntries(Object.entries(definitions).map(([role, colors]) => [role, compiled(...colors)]));
  const cells = [Array.from({ length: 8 }, () => cell(' ', foreground, panel))], surfaces = [];
  surfaces.push({ kind: 'card-background', page: 0, row: 0, start: 0, end: 8 });
  fixture.logicalRows.forEach((entry, index) => {
    const prefix = entry.role === 'context' ? 'context' : entry.role;
    const gutter = definitions[prefix + 'Gutter'], body = definitions[prefix + 'Code'];
    const sign = entry.role === 'context' ? gutter : definitions[prefix + 'Sign'];
    cells.push([cell(' ', ...gutter), cell('' + (entry.newLine ?? entry.oldLine), ...gutter),
      cell(' ', ...sign), cell(entry.role === 'removed' ? '-' : entry.role === 'added' ? '+' : ' ', ...sign),
      cell(' ', ...gutter), cell(entry.text, ...body), cell(' ', ...body), cell(' ', ...body)]);
    const common = { page: 0, row: index + 1, logicalRow: index + 1, side: 'unified' };
    surfaces.push({ ...common, kind: 'body-background', start: 5, end: 8 },
      { ...common, kind: 'gutter-background', start: 0, end: 5 },
      { ...common, kind: 'padding-background', start: 6, end: 8 },
      { ...common, kind: 'line-number', start: 1, end: 2 });
    if (entry.role !== 'context') surfaces.push({ ...common, kind: 'sign', start: 3, end: 4 });
  });
  const view = { kind: 'file', path: fixture.filename, accepted: true, preview: false, omitted: false, error: false,
    displayMode: 'diff', origin: 'owned', publication: 1, paintStamp: 2, roles,
    rows: fixture.logicalRows.map(entry => ({ kind: entry.role === 'added' ? '+' : entry.role === 'removed' ? '-' : ' ',
      oldLine: entry.oldLine, newLine: entry.newLine, text: entry.text })) };
  return { fixture, pages: [{ width: 8, rows: 4, cells }],
    mapping: { viewIdentity: 'unified', surfaces, alignmentPadding: [] },
    readiness: { status: 'ready', sample: { views: [view] } } };
}
const verify = value => verifyPiDiffPaint(value.fixture, value.pages, value.mapping, value.readiness);

test('Pi diff readiness binds structural cell channels to the producer current compiled role styles', async () => {
  const result = await verify(example());
  assert.equal(result.status, 'ready');
  assert.equal(result.diff.viewIdentity, 'unified');
  assert.ok(result.diff.checkedSamples > 30);
  assert.deepEqual(result.diff.roles.removedSign.background, { mode: 'rgb', value: 0x550033 });
});

test('Pi diff readiness refuses stale rows, previews, missing roles and wrong body, gutter, number or sign cells', async () => {
  const edits = [
    value => { value.readiness.sample.views[0].rows[0].newLine = 8; },
    value => { value.readiness.sample.views[0].preview = true; },
    value => { delete value.readiness.sample.views[0].roles.addedGutter; },
    value => { value.pages[0].cells[2][5].bg = 0x123456; },
    value => { value.pages[0].cells[2][0].bg = 0x123456; },
    value => { value.pages[0].cells[2][1].fg = 0x123456; },
    value => { value.pages[0].cells[2][3].fg = 0x123456; },
  ];
  for (const mutate of edits) { const value = example(); mutate(value); await assert.rejects(verify(value), /Pi diff/i); }
});

test('Pi diff paint proof preserves terminal-default and indexed channels without guessing RGB', async () => {
  const value = example(), view = value.readiness.sample.views[0];
  view.roles.panel = { open: '\x1b[39m\x1b[49m', close: '\x1b[0m' };
  for (const entry of value.pages[0].cells[0]) { entry.fg = -1; entry.fgMode = 0; entry.bg = -1; entry.bgMode = 0; }
  view.roles.contextGutter = { open: '\x1b[38;5;2m\x1b[48;2;16;17;18m', close: '\x1b[0m' };
  value.pages[0].cells[1].slice(0, 5).forEach(entry => { entry.fg = 2; entry.fgMode = 0x1000000; });
  const result = await verify(value);
  assert.deepEqual(result.diff.roles.panel.background, { mode: 'default' });
  assert.deepEqual(result.diff.roles.contextGutter.foreground, { mode: 'indexed', value: 2 });
  view.roles.panel.open = '\x1b]2;not-a-role\x07';
  await assert.rejects(verify(value), /Pi diff.*SGR/i);
});
