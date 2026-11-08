import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDiff, compareDiffCaptures } from '../../../scripts/highlight-compare/diff.mjs';
import { digest, styleSignature } from '../../../scripts/highlight-compare/model.mjs';
import { diffRows } from '../../../scripts/highlight-compare/fixtures.mjs';

function pair(beforeLines, afterLines, logicalRows) {
  const before = beforeLines.length ? beforeLines.join('\n') + '\n' : '';
  const after = afterLines.length ? afterLines.join('\n') + '\n' : '';
  const patch = `@@ -${beforeLines.length ? 1 : 0},${beforeLines.length} +${afterLines.length ? 1 : 0},${afterLines.length} @@\n` +
    logicalRows.map(row => (row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' ') + row.text + '\n').join('');
  return { id: 'independent-diff-evidence', kind: 'diff', before, after,
    patch, logicalRows, roleSamples: logicalRows,
    sha256: digest(JSON.stringify([digest(before), digest(after)])) };
}

const single = () => pair([], ['aaa'], [{ role: 'added', newLine: 1, text: 'aaa' }]);
const balanced = () => pair(['context', 'old'], ['context', 'new'], [
  { role: 'context', oldLine: 1, newLine: 1, text: 'context' },
  { role: 'removed', oldLine: 2, text: 'old' }, { role: 'added', newLine: 2, text: 'new' },
]);
const asymmetric = () => pair(['context', 'old', ''], ['context', 'new'], [
  { role: 'context', oldLine: 1, newLine: 1, text: 'context' },
  { role: 'removed', oldLine: 2, text: 'old' }, { role: 'removed', oldLine: 3, text: '' },
  { role: 'added', newLine: 2, text: 'new' },
]);
const cell = (text = ' ', fg = 0x778899, bg = 0x101112) => ({ text, width: 1,
  fg, fgMode: 0x3000000, bg, bgMode: 0x3000000 });

// Physical row/side assignments are explicit test inputs, independent of native gutter parsers.
function grid(fixture, layout = fixture.logicalRows.map((_, i) => ({ unified: i + 1 })), pageCount = 1) {
  const split = Object.hasOwn(layout[0], 'old'), width = split ? 41 : 20;
  const panes = split ? [{ side: 'old', left: 0, right: 20, digits: 2 },
    { side: 'new', left: 21, right: 41, digits: 2 }] : [{ side: 'unified', left: 0, right: 20, digits: 2 }];
  const cells = [Array.from({ length: width }, () => cell())], maps = [], surfaces = [], alignment = [];
  for (const assignments of layout) {
    const y = cells.length, physical = Array.from({ length: width }, () => cell());
    for (const pane of panes) {
      const logicalRow = assignments[pane.side], body = pane.left + 5;
      if (logicalRow === undefined) {
        const opposite = pane.side === 'old' ? 'new' : 'old';
        alignment.push({ page: 0, row: y, side: pane.side, alignedRow: assignments[opposite],
          gutterStart: pane.left, bodyStart: body, end: pane.right });
        continue;
      }
      const entry = fixture.logicalRows[logicalRow - 1], background = entry.role === 'added' ? 0x113311 :
        entry.role === 'removed' ? 0x331111 : 0x222222;
      for (let x = pane.left; x < pane.right; x++) physical[x] = cell(' ', 0x778899, background);
      const number = String(pane.side === 'old' ? entry.oldLine : entry.newLine ?? entry.oldLine);
      for (let i = 0; i < number.length; i++) physical[pane.left + 1 + i].text = number[i];
      if (entry.role !== 'context') physical[pane.left + 3].text = entry.role === 'added' ? '+' : '-';
      for (let i = 0; i < entry.text.length; i++) physical[body + i] = cell(entry.text[i], 0x123456 + i, background);
      const end = body + Math.max(1, entry.text.length), common = { page: 0, row: y, side: pane.side, logicalRow };
      maps.push({ row: y, line: logicalRow, side: pane.side, column: body, start: 0, end: entry.text.length });
      surfaces.push({ ...common, kind: 'gutter-background', start: pane.left, end: body },
        { ...common, kind: 'body-background', start: body, end },
        { ...common, kind: 'padding-background', start: end, end: pane.right },
        { ...common, kind: 'line-number', start: pane.left + 1, end: pane.left + 1 + number.length });
      if (entry.role !== 'context') surfaces.push({ ...common, kind: 'sign', start: pane.left + 3, end: pane.left + 4 });
    }
    cells.push(physical);
  }
  surfaces.push({ kind: 'card-background', page: 0, row: 0, start: 0, end: width });
  return { fixture, pages: Array.from({ length: pageCount }, () => ({ cells: structuredClone(cells) })), mapping: {
    viewIdentity: split ? 'split' : 'unified', tabSize: 4, tabMode: 'stops',
    sourceMaps: Array.from({ length: pageCount }, () => structuredClone(maps)),
    surfaces: Array.from({ length: pageCount }, (_, page) => surfaces.map(sample => ({ ...sample, page }))).flat(),
    alignmentPadding: Array.from({ length: pageCount }, (_, page) => alignment.map(sample => ({ ...sample, page }))).flat(),
    geometry: Array.from({ length: pageCount }, (_, page) => ({ page, heading: 0, bar: 0, cardRight: width, panes: structuredClone(panes) })),
  } };
}
const normalize = native => normalizeDiff(native.fixture, native.pages, native.mapping);
const ready = normalized => ({ ...normalized, status: 'ready', readiness: { status: 'ready' },
  theme: { family: 'github', variant: 'dark' }, application: 'independent-physical-grid', identity: {} });
const splitBalanced = () => grid(balanced(), [{ old: 1, new: 1 }, { old: 2, new: 3 }]);
const splitAsymmetric = () => grid(asymmetric(), [{ old: 1, new: 1 }, { old: 2, new: 4 }, { old: 3 }]);
function sliceRange(range, start, end) {
  const cells = range.cells.filter(value => value.column >= start && value.column < end);
  return { start, end, cells, text: cells.map(value => value.text).join('') };
}

test('independent full row and split-pane observations supply valid normalization controls', () => {
  for (const native of [grid(single()), splitBalanced(), splitAsymmetric()]) {
    const capture = ready(normalize(native));
    assert.equal(compareDiffCaptures(capture, capture).differences.length, 0);
  }
});

test('raw alignment evidence cannot discard the owning pane outside two sampled cells', () => {
  const native = splitAsymmetric(), padding = native.mapping.alignmentPadding[0];
  native.pages[0].cells[padding.row][padding.gutterStart].bg = 0xabcdef;
  padding.gutterStart = 39; padding.bodyStart = 40;
  assert.throws(() => normalize(native), /alignment.*(pane|coverage|geometry)/i);
});

for (const gap of [false, true]) test(`stored alignment evidence rejects ${gap ? 'a gap between gutter and content' : 'truncated owning-pane coverage'}`, () => {
  const capture = ready(normalize(splitAsymmetric())), altered = structuredClone(capture), padding = altered.alignmentPadding[0];
  if (gap) padding.gutter = sliceRange(padding.gutter, 21, 24);
  else {
    padding.gutter = sliceRange(padding.content, 39, 40);
    padding.content = sliceRange(padding.content, 40, 41);
  }
  assert.throws(() => compareDiffCaptures(altered, capture), /alignment.*(pane|coverage|geometry)/i);
});

for (const column of [0, 2]) {
  test(`raw decimal label rejects an unreported adjacent digit at column ${column}`, () => {
    const native = grid(single());
    native.pages[0].cells[1][column].text = '7';
    assert.throws(() => normalize(native), /(complete|whole|decimal|line number)/i);
  });
  test(`stored decimal label rejects an unreported adjacent digit at column ${column}`, () => {
    const capture = ready(normalize(grid(single()))), altered = structuredClone(capture);
    const gutter = altered.surfaces.find(sample => sample.kind === 'gutter-background');
    gutter.cells.find(value => value.column === column).text = '7';
    gutter.text = gutter.cells.map(value => value.text).join('');
    assert.throws(() => compareDiffCaptures(altered, capture), /(complete|whole|decimal|line number)/i);
  });
}

test('partial maps cannot assign repeated characters styles from the beginning of full physical rows', () => {
  const native = grid(single(), undefined, 2);
  native.mapping.sourceMaps[0][0].end = 1;
  native.mapping.sourceMaps[1][0].start = 1;
  assert.throws(() => normalize(native), /(source|body).*(range|cover|projection)/i);
});

test('stored full-body evidence rejects partial source maps even when glyph coverage appears complete', () => {
  const capture = ready(normalize(grid(single(), undefined, 2))), altered = structuredClone(capture);
  altered.sourceMaps[0][0].end = 1;
  altered.sourceMaps[1][0].start = 1;
  assert.throws(() => compareDiffCaptures(altered, capture), /(source|body).*(range|cover|projection)/i);
});

test('split geometry cannot map both context sides onto the same physical pane', () => {
  const native = splitBalanced(), addedRow = native.pages[0].cells.length;
  const moved = Array.from({ length: 41 }, () => cell());
  for (let x = 0; x < 20; x++) moved[x] = structuredClone(native.pages[0].cells[2][21 + x]);
  native.pages[0].cells.push(moved);
  for (const row of native.pages[0].cells.slice(1, addedRow)) for (let x = 21; x < 41; x++) row[x] = cell();
  for (const range of native.mapping.sourceMaps[0].filter(value => value.side === 'new')) {
    range.column -= 21; if (range.line === 3) range.row = addedRow;
  }
  for (const sample of native.mapping.surfaces.filter(value => value.side === 'new')) {
    sample.start -= 21; sample.end -= 21; if (sample.logicalRow === 3) sample.row = addedRow;
  }
  Object.assign(native.mapping.geometry[0].panes[1], { left: 0, right: 20 });
  assert.throws(() => normalize(native), /split.*(pane|overlap)|pane.*overlap/i);
});

test('stored split context retains two disjoint physical pane footprints, not only different side tags', () => {
  const capture = ready(normalize(splitBalanced())), altered = structuredClone(capture);
  const screen = altered.screenGeometry[0], addedRow = screen.height++;
  screen.rowWidths.push(screen.width);
  Object.assign(altered.geometry[0].panes[1], { left: 0, right: 20 });
  for (const range of altered.sourceMaps[0].filter(value => value.side === 'new')) {
    range.column -= 21; if (range.line === 3) range.row = addedRow;
  }
  for (const span of altered.sources.new.spans) for (const observation of span.observations) {
    observation.column -= 21; if (span.logicalRow === 3) observation.row = addedRow;
  }
  for (const sample of altered.surfaces.filter(value => value.side === 'new')) {
    sample.start -= 21; sample.end -= 21; if (sample.logicalRow === 3) sample.row = addedRow;
    for (const observed of sample.cells) observed.column -= 21;
  }
  assert.throws(() => compareDiffCaptures(altered, capture), /split.*(pane|overlap)|pane.*overlap/i);
});

for (const stored of [false, true]) {
  test(`${stored ? 'stored' : 'raw'} structural evidence covers every page with a visible source row`, () => {
    const native = grid(single(), undefined, 2);
    const capture = stored ? ready(normalize(native)) : undefined;
    const surfaces = stored ? capture.surfaces : native.mapping.surfaces;
    const retained = surfaces.filter(sample => sample.page !== 1 || sample.kind === 'card-background');
    if (stored) {
      capture.surfaces = retained;
      assert.throws(() => compareDiffCaptures(capture, capture), /(page|surface|evidence).*(missing|cover|omit)|missing.*(evidence|background)/i);
    } else {
      native.pages[1].cells[1][0].bg = 0xabcdef;
      native.mapping.surfaces = retained;
      assert.throws(() => normalize(native), /(page|surface|evidence).*(missing|cover|omit)|missing.*(evidence|background)/i);
    }
  });

  test(`${stored ? 'stored' : 'raw'} changed rows retain a sign on each observed body page`, () => {
    const native = grid(single(), undefined, 2);
    const capture = stored ? ready(normalize(native)) : undefined;
    const retained = (stored ? capture.surfaces : native.mapping.surfaces)
      .filter(sample => sample.page !== 1 || sample.kind !== 'sign');
    if (stored) {
      capture.surfaces = retained;
      assert.throws(() => compareDiffCaptures(capture, capture), /sign|evidence/i);
    } else {
      native.mapping.surfaces = retained;
      assert.throws(() => normalize(native), /sign|evidence/i);
    }
  });

  test(`${stored ? 'stored' : 'raw'} split alignment evidence covers every page with the unmatched row`, () => {
    const native = grid(asymmetric(), [{ old: 1, new: 1 }, { old: 2, new: 4 }, { old: 3 }], 2);
    const capture = stored ? ready(normalize(native)) : undefined;
    if (stored) {
      capture.alignmentPadding = capture.alignmentPadding.filter(sample => sample.page !== 1);
      assert.throws(() => compareDiffCaptures(capture, capture), /alignment.*(page|missing|cover)|missing.*alignment/i);
    } else {
      native.pages[1].cells[3][21].bg = 0xabcdef;
      native.mapping.alignmentPadding = native.mapping.alignmentPadding.filter(sample => sample.page !== 1);
      assert.throws(() => normalize(native), /alignment.*(page|missing|cover)|missing.*alignment/i);
    }
  });
}

function canonicalPair() {
  const fixture = pair(['context one', 'context two', 'old'], ['context one', 'context two', 'new'], [
    { role: 'context', oldLine: 1, newLine: 1, text: 'context one' },
    { role: 'context', oldLine: 2, newLine: 2, text: 'context two' },
    { role: 'removed', oldLine: 3, text: 'old' }, { role: 'added', newLine: 3, text: 'new' },
  ]);
  fixture.roleSamples = [fixture.logicalRows[0], fixture.logicalRows[2], fixture.logicalRows[3]];
  return fixture;
}

test('canonical patch rows cannot disappear merely because they have no independent role witness', () => {
  const fixture = canonicalPair();
  assert.deepEqual(diffRows(fixture.patch, fixture.before, fixture.after), fixture.logicalRows);
  const valid = ready(normalize(grid(fixture)));
  assert.equal(compareDiffCaptures(valid, valid).differences.length, 0);
  fixture.logicalRows.splice(1, 1);
  assert.throws(() => normalize(grid(fixture)), /patch|hunk|canonical/i);
});

test('stored logical rows must agree with the retained reconstructing patch, not only each other', () => {
  const capture = ready(normalize(grid(canonicalPair())));
  capture.patch = '@@ -3,1 +3,1 @@\n-old\n+new\n';
  assert.throws(() => compareDiffCaptures(capture, capture), /patch|hunk|canonical/i);
});

test('a patch that cannot reconstruct the declared pair is not canonical evidence', () => {
  const fixture = canonicalPair();
  fixture.patch = fixture.patch.replace('-old\n', '-different old\n');
  assert.throws(() => normalize(grid(fixture)), /patch|hunk|canonical/i);
});

for (const stored of [false, true]) {
  test(`${stored ? 'stored' : 'raw'} card-background evidence covers every observed page`, () => {
    const native = grid(single(), undefined, 2);
    const valid = ready(normalize(native));
    assert.equal(compareDiffCaptures(valid, valid).differences.length, 0);
    if (stored) {
      valid.surfaces = valid.surfaces.filter(sample => sample.page !== 1 || sample.kind !== 'card-background');
      assert.throws(() => compareDiffCaptures(valid, valid), /card.*page|missing.*card/i);
    } else {
      native.pages[1].cells[0][0].bg = 0xabcdef;
      native.mapping.surfaces = native.mapping.surfaces
        .filter(sample => sample.page !== 1 || sample.kind !== 'card-background');
      assert.throws(() => normalize(native), /card.*page|missing.*card/i);
    }
  });
}

for (const kind of ['line-number', 'sign']) for (const changed of ['text', 'width', 'style']) {
  test(`stored ${kind} must agree with its overlapping gutter ${changed}`, () => {
    const capture = ready(normalize(grid(single())));
    assert.equal(compareDiffCaptures(capture, capture).differences.length, 0);
    const label = capture.surfaces.find(sample => sample.kind === kind);
    const gutter = capture.surfaces.find(sample => sample.kind === 'gutter-background');
    const duplicate = gutter.cells.find(value => value.column === label.start);
    if (changed === 'text') duplicate.text = kind === 'line-number' ? '9' : '-';
    else if (changed === 'width') duplicate.width = 2;
    else {
      duplicate.style.foreground.value = 0xabcdef;
      duplicate.signature = styleSignature(duplicate.style);
    }
    gutter.text = gutter.cells.map(value => value.text).join('');
    assert.throws(() => compareDiffCaptures(capture, capture), /overlap|contradict|inconsistent|same.*cell/i);
  });
}

for (const stored of [false, true]) {
  test(`${stored ? 'stored' : 'raw'} uniform card anchors tolerate different sampled widths across pages`, () => {
    const native = grid(single(), undefined, 2), baseline = ready(normalize(native));
    let actual;
    if (stored) {
      actual = structuredClone(baseline);
      const index = actual.surfaces.findIndex(sample => sample.page === 1 && sample.kind === 'card-background');
      actual.surfaces[index] = { ...actual.surfaces[index], ...sliceRange(actual.surfaces[index], 0, 19) };
    } else {
      native.mapping.surfaces.find(sample => sample.page === 1 && sample.kind === 'card-background').end--;
      actual = ready(normalize(native));
    }
    assert.equal(compareDiffCaptures(actual, baseline).differences.length, 0);
  });

  test(`${stored ? 'stored' : 'raw'} unequal card anchors still reject a real background change`, () => {
    const native = grid(single(), undefined, 2);
    if (stored) {
      const capture = ready(normalize(native));
      const index = capture.surfaces.findIndex(sample => sample.page === 1 && sample.kind === 'card-background');
      const anchor = { ...capture.surfaces[index], ...sliceRange(capture.surfaces[index], 0, 19) };
      anchor.cells[0].style.background.value = 0xabcdef;
      anchor.cells[0].signature = styleSignature(anchor.cells[0].style);
      capture.surfaces[index] = anchor;
      assert.throws(() => compareDiffCaptures(capture, capture), /card.*disagree/i);
    } else {
      native.mapping.surfaces.find(sample => sample.page === 1 && sample.kind === 'card-background').end--;
      native.pages[1].cells[0][0].bg = 0xabcdef;
      assert.throws(() => normalize(native), /card.*disagree/i);
    }
  });

  test(`${stored ? 'stored' : 'raw'} card-background anchors cannot sample outside the declared card`, () => {
    const native = grid(single());
    for (const row of native.pages[0].cells) row.push(cell(' ', 0x778899, 0xabcdef), cell(' ', 0x778899, 0xabcdef));
    const valid = ready(normalize(native));
    assert.equal(compareDiffCaptures(valid, valid).differences.length, 0);
    if (stored) {
      const anchor = valid.surfaces.find(sample => sample.kind === 'card-background');
      anchor.start = 20; anchor.end = 22;
      anchor.cells = anchor.cells.slice(0, 2).map((value, index) => {
        value.column = 20 + index; value.style.background.value = 0xabcdef;
        value.signature = styleSignature(value.style);
        return value;
      });
      anchor.text = anchor.cells.map(value => value.text).join('');
      assert.throws(() => compareDiffCaptures(valid, valid), /card.*(bound|geometry|outside|anchor)/i);
    } else {
      const anchor = native.mapping.surfaces.find(sample => sample.kind === 'card-background');
      anchor.start = 20; anchor.end = 22;
      assert.throws(() => normalize(native), /card.*(bound|geometry|outside|anchor)/i);
    }
  });
}
