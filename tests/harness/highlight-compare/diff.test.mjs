import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDiffCaptures, normalizeDiff } from '../../../scripts/highlight-compare/diff.mjs';
import { digest, projectLine } from '../../../scripts/highlight-compare/model.mjs';
import { diffRows, loadFixtures, prepareDiff } from '../../../scripts/highlight-compare/fixtures.mjs';
import { toolPath } from '../../../scripts/test/context.mjs';

const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
const themes = { family: 'github', variant: 'dark' };
const neutralDirectory = fileURLToPath(new URL('../../fixtures/highlight-compare/', import.meta.url));
const neutral = loadFixtures(neutralDirectory).fixtures.find(fixture => fixture.id === 'empty-old-side-with-blank-addition');

function tinyFixture() {
  const beforeLines = ['start\tcontext', 'same', 'same', 'context 04', 'context 05', 'context 06', 'context 07',
    'repeat', 'repeat', 'context 10', 'old alpha', '', 'old omega', 'after'];
  const afterLines = ['start\tcontext', 'same', 'same', 'context 04', 'context 05', 'context 06', 'context 07',
    'repeat', 'repeat', 'context 10', '', 'new beta', 'after'];
  const before = beforeLines.join('\n'), after = afterLines.join('\n');
  const logicalRows = [];
  for (let index = 0; index < 10; index++) logicalRows.push({ role: 'context', oldLine: index + 1, newLine: index + 1, text: beforeLines[index] });
  logicalRows.push({ role: 'removed', oldLine: 11, text: 'old alpha' },
    { role: 'removed', oldLine: 12, text: '' }, { role: 'removed', oldLine: 13, text: 'old omega' },
    { role: 'added', newLine: 11, text: '' }, { role: 'added', newLine: 12, text: 'new beta' },
    { role: 'context', oldLine: 14, newLine: 13, text: 'after' });
  const roleSamples = [logicalRows[1], logicalRows[10], logicalRows[11], logicalRows[13]].map(row => ({ ...row }));
  const patch = `@@ -1,14 +1,13 @@\n${logicalRows.map(row => `${row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' '}${row.text}\n`).join('')}\\ No newline at end of file\n`;
  return { id: 'worker-asymmetric-split', kind: 'diff', before, after, patch,
    sha256: digest(JSON.stringify([digest(Buffer.from(before)), digest(Buffer.from(after))])), logicalRows, roleSamples };
}

function cell(text, foreground, background, width = 1) {
  return { text, width, fgMode: 0x3000000, fg: foreground, bgMode: 0x3000000, bg: background,
    bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
}

function blank(background) { return cell(' ', rgb(0xc0, 0xc0, 0xc0), background); }
function roleBackground(role) { return role === 'context' ? rgb(0x20, 0x21, 0x22) : role === 'added' ? rgb(0x21, 0x52, 0x2c) : rgb(0x65, 0x25, 0x25); }
function gutterBackground(role) { return role === 'context' ? rgb(0x31, 0x32, 0x33) : role === 'added' ? rgb(0x32, 0x64, 0x3a) : rgb(0x75, 0x35, 0x35); }
const paddingBackground = rgb(0x12, 0x13, 0x14);
const cardBackground = rgb(0x08, 0x09, 0x0a);
const numberForeground = rgb(0xaa, 0xaa, 0xaa);
const addedForeground = rgb(0x55, 0xdd, 0x77);
const removedForeground = rgb(0xff, 0x66, 0x66);
const bodyForeground = rgb(0xdd, 0xdd, 0xdd);

function expandedCells(text, tabSize, tabMode, foreground, background) {
  const projection = projectLine(text, tabSize, tabMode);
  return Array.from(projection.text, character => cell(character, foreground, background));
}

function physicalRows(fixture, viewIdentity) {
  if (viewIdentity === 'unified') return fixture.logicalRows.map((row, index) => ({
    unified: { logicalRow: index + 1, row },
  }));
  const result = [];
  for (let index = 0; index < fixture.logicalRows.length;) {
    if (fixture.logicalRows[index].role === 'context') {
      result.push({ old: { logicalRow: index + 1, row: fixture.logicalRows[index] },
        new: { logicalRow: index + 1, row: fixture.logicalRows[index] } });
      index++; continue;
    }
    const removed = [], added = [];
    while (index < fixture.logicalRows.length && fixture.logicalRows[index].role !== 'context') {
      const row = fixture.logicalRows[index], entry = { logicalRow: index + 1, row };
      (row.role === 'removed' ? removed : added).push(entry); index++;
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      result.push({ ...(removed[offset] ? { old: removed[offset] } : {}), ...(added[offset] ? { new: added[offset] } : {}) });
    }
  }
  return result;
}

function makeNativeFixture(fixture, { viewIdentity = 'unified', paneWidth = 34, pageCount = 1, reverseCellKeys = false } = {}) {
  const tabSize = 3, tabMode = 'fixed', rows = physicalRows(fixture, viewIdentity);
  const panes = viewIdentity === 'unified'
    ? [{ side: 'unified', left: 0, right: paneWidth, digits: 2 }]
    : [{ side: 'old', left: 0, right: paneWidth, digits: 2 }, { side: 'new', left: paneWidth + 1, right: paneWidth * 2 + 1, digits: 2 }];
  const width = viewIdentity === 'unified' ? paneWidth : paneWidth * 2 + 1;
  const header = Array.from({ length: width }, () => blank(cardBackground));
  const sourceMaps = [], surfaces = [], alignmentPadding = [], pages = [], geometry = [];
  const physical = [];
  const gutterWidth = 6;
  for (const sideRows of rows) {
    const line = Array.from({ length: width }, () => blank(cardBackground));
    const lineSources = [];
    for (const pane of panes) {
      const entry = sideRows[pane.side];
      const bodyStart = pane.left + gutterWidth, bodyEnd = pane.right;
      if (!entry) {
        line.fill(blank(cardBackground), pane.left, pane.right);
        continue;
      }
      const { logicalRow, row } = entry, gutterBg = gutterBackground(row.role), bodyBg = roleBackground(row.role);
      for (let column = pane.left; column < bodyStart; column++) line[column] = blank(gutterBg);
      const number = viewIdentity === 'unified' ? row.newLine ?? row.oldLine : pane.side === 'old' ? row.oldLine : row.newLine;
      const numberText = String(number), numberStart = pane.left + 1 + pane.digits - numberText.length;
      for (let index = 0; index < numberText.length; index++) line[numberStart + index] = cell(numberText[index], numberForeground, gutterBg);
      const sign = row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' ';
      const signStart = pane.left + pane.digits + 2;
      line[signStart] = cell(sign, row.role === 'added' ? addedForeground : row.role === 'removed' ? removedForeground : numberForeground, gutterBg);
      const projection = projectLine(row.text, tabSize, tabMode), bodyWidth = Math.max(projection.columns, 1);
      if (bodyStart + bodyWidth >= pane.right) throw new Error('Test grid does not leave trailing padding');
      const shown = row.text === '' ? [blank(bodyBg)] : expandedCells(row.text, tabSize, tabMode, bodyForeground, bodyBg);
      for (let index = 0; index < shown.length; index++) line[bodyStart + index] = shown[index];
      for (let column = bodyStart + bodyWidth; column < pane.right; column++) line[column] = blank(paddingBackground);
      const mapRange = { row: physical.length + 1, line: logicalRow, side: pane.side, column: bodyStart, start: 0, end: row.text.length };
      lineSources.push(mapRange);
      const common = { page: 0, row: physical.length + 1, logicalRow, side: pane.side };
      surfaces.push({ ...common, kind: 'gutter-background', start: pane.left, end: bodyStart },
        { ...common, kind: 'body-background', start: bodyStart, end: bodyStart + bodyWidth },
        { ...common, kind: 'padding-background', start: bodyStart + bodyWidth, end: pane.right },
        { ...common, kind: 'line-number', start: numberStart, end: numberStart + numberText.length });
      if (row.role !== 'context') surfaces.push({ ...common, kind: 'sign', start: signStart, end: signStart + 1 });
    }
    if (viewIdentity === 'split') for (let paneIndex = 0; paneIndex < panes.length; paneIndex++) {
      const pane = panes[paneIndex], opposite = panes[1 - paneIndex], entry = sideRows[opposite.side];
      if (sideRows[pane.side] || !entry) continue;
      const bodyStart = pane.left + gutterWidth;
      alignmentPadding.push({ page: 0, row: physical.length + 1, side: pane.side, alignedRow: entry.logicalRow,
        gutterStart: pane.left, bodyStart, end: pane.right });
      for (let column = pane.left; column < pane.right; column++) line[column] = blank(paddingBackground);
    }
    physical.push(line); sourceMaps.push(lineSources);
  }
  const anchorRow = physical.length + 1;
  const anchor = Array.from({ length: width }, () => blank(cardBackground));
  const surfacesForPage = surfaces.filter(item => item.page === 0).concat({ kind: 'card-background', page: 0, row: anchorRow, start: 0, end: width });
  const pageCells = [header, ...physical, anchor];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const cells = pageCells.map(row => row.map(value => reverseCellKeys ? Object.fromEntries(Object.entries(value).reverse()) : { ...value }));
    pages.push({ cells });
  }
  // Every page is an overlapping copy of the same full logical grid.
  const repeatedMaps = pages.map(() => sourceMaps.flat());
  const repeatedSurfaces = pages.flatMap((_, pageIndex) => surfacesForPage.map(item => ({ ...item, page: pageIndex })));
  const repeatedPadding = pages.flatMap((_, pageIndex) => alignmentPadding.map(item => ({ ...item, page: pageIndex })));
  const panesGeometry = panes.map(pane => ({ ...pane }));
  for (let page = 0; page < pageCount; page++) geometry.push({ page, heading: 0, bar: 0, cardRight: width, panes: panesGeometry });
  return { fixture, pages, mapping: { viewIdentity, sourceMaps: repeatedMaps, surfaces: repeatedSurfaces,
    alignmentPadding: repeatedPadding, geometry, tabSize, tabMode } };
}

function capture(fixture, options) {
  const native = makeNativeFixture(fixture, options), normalized = normalizeDiff(native.fixture, native.pages, native.mapping);
  return { ...normalized, status: 'ready', application: 'independent-test-grid', identity: { revision: 'hand-authored' },
    theme: themes, readiness: { status: 'ready', evidence: 'independently-authored native-cell grid' } };
}

function fixtureWithRows() { return tinyFixture(); }

function cellFor(mapping, pages, { side = 'unified', logicalRow, kind = 'body-background', offset = 0 }) {
  const sample = mapping.surfaces.find(item => item.kind === kind && item.side === side && item.logicalRow === logicalRow);
  assert.ok(sample, `surface ${kind}/${side}/${logicalRow} exists`);
  return pages[sample.page].cells[sample.row][sample.start + offset];
}

function reverseProperties(value) {
  if (Array.isArray(value)) return value.map(reverseProperties);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseProperties(nested)]));
}

function normalizedWithEdit(fixture, options, edit) {
  const native = makeNativeFixture(fixture, options);
  edit?.(native);
  const normalized = normalizeDiff(native.fixture, native.pages, native.mapping);
  return { ...normalized, status: 'ready', application: 'independent-test-grid', identity: { revision: 'hand-authored' },
    theme: themes, readiness: { status: 'ready' } };
}

test('prepared diff output with whole-file reconstruction normalizes as structural evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-diff-normalize-'));
  try {
    const fixture = prepareDiff(neutral, join(directory, neutral.id), toolPath('git'), process.env);
    assert.equal(fixture.before, neutral.before);
    assert.equal(fixture.after, neutral.after);
    assert.deepEqual(diffRows(fixture.patch, fixture.before, fixture.after), fixture.logicalRows);
    const normalized = capture(fixture, { viewIdentity: 'unified', paneWidth: 34 });
    assert.equal(normalized.logicalRows.length, 3);
    assert.deepEqual(normalized.roles.map(row => row.role), ['added', 'added', 'added']);
    assert.equal(normalized.roles[0].text, '');
    assert.equal(normalized.roles[0].newLine, 1);
    assert.equal(normalized.sources.unified.tabSize, 3);
    assert.equal(normalized.sources.unified.tabMode, 'fixed');
    assert.ok(normalized.surfaces.some(sample => sample.kind === 'sign' && sample.text === '+' && sample.newLine === 1));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('split normalization duplicates context by side and preserves original old/new coordinates', () => {
  const fixture = fixtureWithRows(), normalized = capture(fixture, { viewIdentity: 'split' });
  const oldContext = normalized.roles.find(row => row.side === 'old' && row.logicalRow === 2);
  const newContext = normalized.roles.find(row => row.side === 'new' && row.logicalRow === 2);
  assert.equal(oldContext.oldLine, 2);
  assert.equal(newContext.newLine, 2);
  assert.notEqual(normalized.sources.old.spans.find(span => span.logicalRow === 2).side,
    normalized.sources.new.spans.find(span => span.logicalRow === 2).side);
  assert.equal(normalized.sources.old.tabSize, 3);
  assert.equal(normalized.sources.new.tabMode, 'fixed');
  assert.ok(normalized.surfaces.some(sample => sample.kind === 'line-number' && sample.side === 'old' && sample.text === '11'));
  assert.ok(normalized.surfaces.some(sample => sample.kind === 'line-number' && sample.side === 'new' && sample.text === '12'));
  assert.ok(normalized.surfaces.some(sample => sample.kind === 'sign' && sample.side === 'old' && sample.text === '-'));
  assert.ok(normalized.surfaces.some(sample => sample.kind === 'sign' && sample.side === 'new' && sample.text === '+'));
  assert.deepEqual(normalized.alignmentPadding.map(item => [item.side, item.alignedRow]), [['new', 13]]);
  assert.equal(normalized.alignmentRoles[0].side, 'new');
});

test('unified and split captures compare only equal views and separate native geometry', () => {
  const fixture = fixtureWithRows();
  const left = capture(fixture, { viewIdentity: 'unified', paneWidth: 34 });
  const right = capture(fixture, { viewIdentity: 'unified', paneWidth: 40 });
  const report = compareDiffCaptures(left, right);
  assert.equal(report.differences.length, 0);
  assert.notDeepEqual(report.geometryDifferences.left, report.geometryDifferences.right);
  assert.ok(report.geometryDifferences.leftScreen[0].width < report.geometryDifferences.rightScreen[0].width);
  assert.throws(() => compareDiffCaptures(left, capture(fixture, { viewIdentity: 'split' })), /view identity/);
});

test('source-body foreground and font are excluded while ordered structural backgrounds are compared', () => {
  const fixture = fixtureWithRows(), options = { viewIdentity: 'unified' };
  const baseline = normalizedWithEdit(fixture, options);
  const fgOnly = normalizedWithEdit(fixture, options, native => {
    const surface = native.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15);
    native.pages[0].cells[surface.row][surface.start].fg = rgb(0xff, 0x00, 0xff);
    native.pages[0].cells[surface.row][surface.start].bold = true;
  });
  assert.deepEqual(compareDiffCaptures(baseline, fgOnly).differences, []);

  const reordered = normalizedWithEdit(fixture, options, native => {
    const surface = native.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15);
    native.pages[0].cells[surface.row][surface.start].bg = rgb(0x00, 0xff, 0x00);
  });
  const report = compareDiffCaptures(baseline, reordered);
  assert.ok(report.differences.some(item => item.side === 'unified' && item.logicalRow === 15 && item.channel === 'bodyBackground'));

  const firstTint = normalizedWithEdit(fixture, options, native => {
    const surface = native.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15);
    native.pages[0].cells[surface.row][surface.start].bg = rgb(0x00, 0xff, 0x00);
  });
  const secondTint = normalizedWithEdit(fixture, options, native => {
    const surface = native.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15);
    native.pages[0].cells[surface.row][surface.start + 1].bg = rgb(0x00, 0xff, 0x00);
  });
  const ordered = compareDiffCaptures(firstTint, secondTint);
  assert.ok(ordered.differences.some(item => item.logicalRow === 15 && item.channel === 'bodyBackground'));
});

test('each structural diff cell channel changes its independent comparison result', () => {
  const fixture = fixtureWithRows(), options = { viewIdentity: 'split' };
  const baseline = capture(fixture, options);
  const assertOnly = (channel, edit) => {
    const changed = normalizedWithEdit(fixture, options, edit);
    assert.deepEqual(compareDiffCaptures(baseline, changed).differences.map(item => item.channel), [channel]);
  };
  const editSurface = (native, kind, side, logicalRow, property, value) => {
    const target = cellFor(native.mapping, native.pages, { kind, side, logicalRow });
    target[property] = value;
  };

  assertOnly('cardBackground', native => {
    const anchor = native.mapping.surfaces.find(sample => sample.kind === 'card-background');
    native.pages[anchor.page].cells[anchor.row][anchor.start].bg = rgb(0xff, 0x00, 0xff);
  });
  assertOnly('gutterBackground', native => editSurface(native, 'gutter-background', 'old', 11, 'bg', rgb(0x00, 0xff, 0xff)));
  assertOnly('paddingBackground', native => editSurface(native, 'padding-background', 'new', 15, 'bg', rgb(0xff, 0xff, 0x00)));
  assertOnly('lineNumberForeground', native => editSurface(native, 'line-number', 'new', 16, 'fg', rgb(0x00, 0x00, 0xff)));
  assertOnly('signForeground', native => editSurface(native, 'sign', 'new', 14, 'fg', rgb(0xff, 0x00, 0x00)));
  assertOnly('alignmentGutterBackground', native => {
    const padding = native.mapping.alignmentPadding.find(item => item.side === 'new' && item.alignedRow === 13);
    native.pages[padding.page].cells[padding.row][padding.gutterStart].bg = rgb(0x00, 0xff, 0x00);
  });
  assertOnly('alignmentContentBackground', native => {
    const padding = native.mapping.alignmentPadding.find(item => item.side === 'new' && item.alignedRow === 13);
    native.pages[padding.page].cells[padding.row][padding.bodyStart].bg = rgb(0xff, 0x80, 0x00);
  });
});

test('duplicate context text is disambiguated by explicit logical coordinates, not first text match', () => {
  const fixture = fixtureWithRows(), native = makeNativeFixture(fixture, { viewIdentity: 'split' });
  const repeats = native.mapping.sourceMaps[0].filter(range => range.side === 'old' && (range.line === 2 || range.line === 3));
  assert.equal(repeats.length, 2);
  assert.deepEqual(repeats.map(range => range.line), [2, 3]);
  assert.notEqual(repeats[0].row, repeats[1].row);
  const normalized = normalizeDiff(fixture, native.pages, native.mapping);
  for (const side of ['old', 'new']) {
    const matched = normalized.sources[side].spans.filter(span => span.logicalRow === 2 || span.logicalRow === 3);
    assert.deepEqual([...new Set(matched.map(span => span.logicalRow))], [2, 3]);
  }
});

test('swapped split-side line numbers and signs fail exact role validation', () => {
  const fixture = fixtureWithRows(), options = { viewIdentity: 'split' };
  const badNumber = makeNativeFixture(fixture, options);
  const number = badNumber.mapping.surfaces.find(item => item.kind === 'line-number' && item.side === 'new' && item.logicalRow === 16);
  badNumber.pages[0].cells[number.row][number.start + 1].text = '4';
  assert.throws(() => normalizeDiff(fixture, badNumber.pages, badNumber.mapping), /line number mismatch/);

  const badSign = makeNativeFixture(fixture, options);
  const sign = badSign.mapping.surfaces.find(item => item.kind === 'sign' && item.side === 'new' && item.logicalRow === 14);
  badSign.pages[0].cells[sign.row][sign.start].text = '-';
  assert.throws(() => normalizeDiff(fixture, badSign.pages, badSign.mapping), /sign mismatch/);
});

test('missing role evidence, bad coordinates, and source/body text mismatches fail closed', () => {
  const fixture = fixtureWithRows(), options = { viewIdentity: 'unified' };
  const missing = makeNativeFixture(fixture, options);
  missing.mapping.surfaces = missing.mapping.surfaces.filter(item => !(item.kind === 'gutter-background' && item.logicalRow === 10));
  assert.throws(() => normalizeDiff(fixture, missing.pages, missing.mapping), /Missing gutter-background/);

  const badRange = makeNativeFixture(fixture, options);
  badRange.mapping.sourceMaps[0][0].row = 999;
  assert.throws(() => normalizeDiff(fixture, badRange.pages, badRange.mapping), /Invalid diff source range/);

  const textMismatch = makeNativeFixture(fixture, options);
  const body = textMismatch.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15);
  textMismatch.pages[0].cells[body.row][body.start].text = 'X';
  assert.throws(() => normalizeDiff(fixture, textMismatch.pages, textMismatch.mapping), /Source text mismatch/);
});

test('blank changed content, trailing padding, and asymmetric split alignment remain distinct', () => {
  const fixture = fixtureWithRows(), split = capture(fixture, { viewIdentity: 'split' });
  const removedBlank = split.surfaces.find(sample => sample.kind === 'body-background' && sample.side === 'old' && sample.logicalRow === 12);
  const removedPadding = split.surfaces.find(sample => sample.kind === 'padding-background' && sample.side === 'old' && sample.logicalRow === 12);
  assert.equal(removedBlank.end - removedBlank.start, 1);
  assert.ok(removedPadding.start > removedBlank.start);
  assert.equal(removedBlank.text, ' ');
  const noAlignment = makeNativeFixture(fixture, { viewIdentity: 'split' });
  noAlignment.mapping.alignmentPadding = [];
  assert.throws(() => normalizeDiff(fixture, noAlignment.pages, noAlignment.mapping), /Missing alignment padding/);
});

test('overlapping pages must agree on every observed style and text cell', () => {
  const fixture = fixtureWithRows(), native = makeNativeFixture(fixture, { viewIdentity: 'unified', pageCount: 2 });
  const body = native.mapping.surfaces.find(item => item.kind === 'body-background' && item.logicalRow === 15 && item.page === 1);
  native.pages[1].cells[body.row][body.start].bg = rgb(0xff, 0x00, 0x00);
  assert.throws(() => normalizeDiff(fixture, native.pages, native.mapping), /Overlapping/);
});

test('JSON and style-field ordering do not affect normalized results or comparison', () => {
  const fixture = fixtureWithRows(), native = makeNativeFixture(fixture, { viewIdentity: 'unified', reverseCellKeys: true });
  const normal = normalizeDiff(fixture, native.pages, native.mapping);
  const reversedInput = normalizeDiff(reverseProperties(fixture), reverseProperties(native.pages), reverseProperties(native.mapping));
  assert.deepEqual(reversedInput, normal);
  const ready = { ...normal, status: 'ready', application: 'grid', identity: {}, theme: themes, readiness: { status: 'ready' } };
  assert.deepEqual(compareDiffCaptures(reverseProperties(ready), ready).differences, []);
});

test('malformed color styles, non-ready captures, and invalid digest identities are rejected', () => {
  const fixture = fixtureWithRows(), native = makeNativeFixture(fixture, { viewIdentity: 'unified' });
  native.pages[0].cells[1][0].fgMode = 0x4000000;
  assert.throws(() => normalizeDiff(fixture, native.pages, native.mapping), /Unsupported terminal color/);

  const ready = capture(fixture, { viewIdentity: 'unified' });
  assert.throws(() => compareDiffCaptures({ ...ready, status: 'pending' }, ready), /ready captures/);
  assert.throws(() => compareDiffCaptures({ ...ready, readiness: { status: 'pending' } }, ready), /ready captures/);
  assert.throws(() => compareDiffCaptures({ ...ready, fixture: { ...ready.fixture, sha256: '0'.repeat(64) } }, ready), /digest mismatch/);
  assert.throws(() => compareDiffCaptures({ ...ready, theme: { ...themes, variant: 'unknown' } }, ready), /Invalid diff theme/);

  const malformed = JSON.parse(JSON.stringify(ready));
  malformed.surfaces[0].cells[0].style.background = { mode: 'rgb', value: -1 };
  assert.throws(() => compareDiffCaptures(malformed, ready), /Invalid captured color/);
});
