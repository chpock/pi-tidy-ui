import xterm from '@xterm/headless';
import { detachTerminalScreen } from '../../../tests/fixtures/terminal-harness.mjs';
import { cellStyle } from '../model.mjs';
import { mapNumberedDiff } from './numbered-diff.mjs';

export function mapPiDiff(fixture, pages, viewIdentity = 'unified') {
  return mapNumberedDiff(fixture, pages, { header: '← Edited ', viewIdentity,
    contentInset: 2, cardRightInset: 1, bodyRightInset: 2, sharedDigits: true, tabSize: 4, tabMode: 'stops' });
}

const fail = message => { throw new Error('Pi diff ' + message); };
const rolePrefix = row => row.role === 'added' ? 'added' : row.role === 'removed' ? 'removed' : 'context';

async function compiledRoles(roles, names) {
  const terminal = new xterm.Terminal({ cols: names.length + 1, rows: 1, allowProposedApi: true });
  try {
    const prefixes = names.map(name => {
      const prefix = roles?.[name]?.open;
      if (typeof prefix !== 'string' || prefix.length > 4096 || !/^(?:\x1b\[[0-9;]*m)+$/u.test(prefix)) fail('missing or non-SGR compiled role: ' + name);
      return '\x1b[0m' + prefix + 'x';
    });
    await new Promise(done => terminal.write(prefixes.join(''), done));
    const cells = detachTerminalScreen(terminal).cells[0];
    return Object.fromEntries(names.map((name, index) => [name, cellStyle(cells[index])]));
  } finally { terminal.dispose(); }
}

/** Bind structural colors to the current producer paint, independently of text alignment. */
export async function verifyPiDiffPaint(fixture, pages, mapping, readiness) {
  const views = readiness.sample?.views?.filter(view => view.kind === 'file' && view.path === fixture.filename) ?? [];
  const view = views[0];
  if (readiness.status !== 'ready' || views.length !== 1 || !view.accepted || view.preview || view.omitted || view.error ||
    view.displayMode !== 'diff' || view.origin !== 'owned' || !Number.isSafeInteger(view.publication) || view.publication < 1 ||
    !Number.isSafeInteger(view.paintStamp) || view.paintStamp < 1) fail('current full owned diff card is unavailable');
  const expectedRows = fixture.logicalRows.map(row => [row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' ', row.oldLine ?? null, row.newLine ?? null, row.text]);
  const actualRows = view.rows?.map(row => [row.kind, row.oldLine ?? null, row.newLine ?? null, row.text]);
  if (JSON.stringify(expectedRows) !== JSON.stringify(actualRows)) fail('producer rows differ from the canonical fixture hunk');
  const observations = [];
  const observe = (surface, role, channel, start = surface.start, end = surface.end) => {
    const page = pages[surface.page], row = page?.cells[surface.row];
    if (!row || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > page.width) fail('invalid structural sample range');
    for (let column = start; column < end; column++) observations.push({ role, channel, page: surface.page, row: surface.row, column, style: cellStyle(row[column]) });
  };
  for (const surface of mapping.surfaces) {
    if (surface.kind === 'card-background') { observe(surface, 'panel', 'background'); continue; }
    const row = fixture.logicalRows[surface.logicalRow - 1];
    if (!row) fail('structural sample has no canonical row');
    const prefix = rolePrefix(row);
    const code = prefix === 'context' && !view.roles?.contextCode ? 'code' : prefix + 'Code';
    const gutter = prefix === 'context' && !view.roles?.contextGutter ? 'gutter' : prefix + 'Gutter';
    if (surface.kind === 'body-background' || surface.kind === 'padding-background') observe(surface, code, 'background');
    else if (surface.kind === 'line-number') observe(surface, gutter, 'foreground');
    else if (surface.kind === 'sign') observe(surface, prefix + 'Sign', 'foreground');
    else if (surface.kind === 'gutter-background') {
      const sign = mapping.surfaces.find(item => item.kind === 'sign' && item.page === surface.page && item.row === surface.row &&
        item.logicalRow === surface.logicalRow && item.side === surface.side);
      for (let column = surface.start; column < surface.end; column++) {
        // The native sign style also owns its immediately preceding space.
        const role = sign && column >= sign.start - 1 && column < sign.end ? prefix + 'Sign' : gutter;
        observe(surface, role, 'background', column, column + 1);
      }
    } else fail('unsupported structural sample kind: ' + surface.kind);
  }
  for (const padding of mapping.alignmentPadding ?? []) observe(padding, 'empty', 'background', padding.gutterStart, padding.end);
  if (!observations.length) fail('no structural samples');
  const roles = await compiledRoles(view.roles, [...new Set(observations.map(item => item.role))]);
  for (const item of observations) if (JSON.stringify(item.style[item.channel]) !== JSON.stringify(roles[item.role][item.channel])) {
    fail(`screen ${item.channel} differs from current ${item.role} at page ${item.page}, row ${item.row}, column ${item.column}`);
  }
  return { ...readiness, diff: { viewIdentity: mapping.viewIdentity, rows: expectedRows.length, roles,
    checkedSamples: observations.length, proof: 'current producer compiled ANSI roles decoded with the capture xterm implementation' } };
}

export function mapPiDiffView(fixture, pages) {
  const mixed = fixture.logicalRows.some(row => row.role === 'added') && fixture.logicalRows.some(row => row.role === 'removed');
  const mappings = [], failures = [];
  for (const view of mixed ? ['unified', 'split'] : ['unified']) {
    try {
      const mapping = mapPiDiff(fixture, pages, view), seen = new Set(mapping.sourceMaps.flat().map(row => row.side + ':' + row.line));
      const expected = fixture.logicalRows.flatMap((row, index) => (view === 'unified' ? ['unified'] :
        row.role === 'added' ? ['new'] : row.role === 'removed' ? ['old'] : ['old', 'new']).map(side => side + ':' + (index + 1)));
      if (seen.size !== expected.length || expected.some(key => !seen.has(key))) throw new Error('Incomplete native diff row/side population');
      mappings.push(mapping);
    } catch (error) { failures.push(view + ': ' + error.message); }
  }
  if (mappings.length !== 1) fail('observed view is missing or ambiguous: ' + failures.join('; '));
  return mappings[0];
}
