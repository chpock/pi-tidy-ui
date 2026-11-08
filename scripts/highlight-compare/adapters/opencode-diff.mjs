import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mapNumberedDiff } from './numbered-diff.mjs';
import { normalizeDiff } from '../diff.mjs';
import { observeOpenCodeTheme } from './opencode-theme.mjs';

const { parsePatch } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('diff');

function splitRowCount(patch) {
  let count = 0;
  for (const hunk of parsePatch(patch)[0].hunks) {
    let removed = 0, added = 0;
    const flush = () => { count += Math.max(removed, added); removed = added = 0; };
    for (const line of hunk.lines) {
      if (line[0] === '-') removed++;
      else if (line[0] === '+') added++;
      else {
        // Native EOF markers separate changed blocks without adding a visible row.
        flush();
        if (line[0] === ' ') count++;
      }
    }
    flush();
  }
  return count;
}

export function mapOpenCodeDiff(fixture, pages, viewIdentity = 'unified') {
  const nativeRows = viewIdentity === 'split' && fixture.patch ? splitRowCount(fixture.patch) : undefined;
  return mapNumberedDiff(fixture, pages, { header: '← Edit ', viewIdentity,
    contentInset: 4, cardRightInset: 2, bodyRightInset: 2, tabSize: 2, tabMode: 'fixed',
    gutter: ({ alignedRows, maxNumber, hasSign }) => ({
      digits: String(Math.max(1, nativeRows ?? alignedRows, maxNumber)).length, after: hasSign ? 2 : 0,
    }) });
}

export function observeOpenCodeDiff(fixture, pages, themeProfile) {
  let previousFrame = 0;
  for (const page of pages) {
    assert.ok(Number.isSafeInteger(page.frame) && page.frame > previousFrame && page.rendering === false,
      'OpenCode diff requires distinct completed native synchronized frames');
    previousFrame = page.frame;
  }
  const candidates = [], failures = [];
  for (const view of ['unified', 'split']) {
    try {
      const diffMap = mapOpenCodeDiff(fixture, pages, view), normalized = normalizeDiff(fixture, pages, diffMap);
      for (const page of pages) normalizeDiff(fixture, [page], mapOpenCodeDiff(fixture, [page], view));
      candidates.push({ diffMap, normalized });
    } catch (error) { failures.push(view + ': ' + error.message); }
  }
  assert.equal(candidates.length, 1, 'OpenCode diff needs one complete unambiguous native view; ' + failures.join('; '));
  const { diffMap, normalized } = candidates[0], themeWitness = observeOpenCodeTheme(normalized, themeProfile);
  const frames = pages.map((page, index) => {
    const witnesses = themeWitness.observations.filter(item => item.page === index && item.matched).map(item => item.sample);
    assert.ok(witnesses.length, 'OpenCode diff has no discriminating structural RGB theme witness on page ' + index);
    return { frame: page.frame, witnesses };
  });
  return { diffMap, readiness: { status: 'ready', method: 'complete-native-plain-text-diff-and-structural-theme',
    viewIdentity: diffMap.viewIdentity, logicalRows: fixture.logicalRows.length, frames, themeWitness,
    syntaxCompletion: 'Structural plain-text diff only; no syntax-parser readiness claim' } };
}
