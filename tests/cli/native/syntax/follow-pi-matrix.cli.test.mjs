import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { colorToRgb, indexedColor, rgbColor, colorToOklch } from '@earendil-works/pi-tui';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { paintProof, publications, delimiterCells, followPiMarkers, spans, publicInk } from '../../../fixtures/follow-pi-physical.mjs';
import { prepareSyntaxNative, settledStats, captureThenRenderDiagnostics, work, traffic, persisted, body, finish, syntaxReady } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const same = (a, b) => a.fg === b.fg && a.fgMode === b.fgMode;
function color(value, background = false) {
  const mode = background ? value.bgMode : value.fgMode, word = background ? value.bg : value.fg;
  if (mode === 3 << 24) return rgbColor(word >>> 16, word >>> 8 & 255, word & 255);
  return mode === 1 << 24 || mode === 2 << 24 ? indexedColor(word) : undefined;
}
function luminance(value) {
  const { r, g, b } = colorToRgb(value), linear = n => n <= 10.31475 ? n / 3294.6 : ((n / 255 + .055) / 1.055) ** 2.4;
  return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
}
function separation(first, second) {
  const a = colorToOklch(first), b = colorToOklch(second), radians = degrees => degrees * Math.PI / 180;
  return Math.hypot(a.l - b.l, a.c * Math.cos(radians(a.h)) - b.c * Math.cos(radians(b.h)),
    a.c * Math.sin(radians(a.h)) - b.c * Math.sin(radians(b.h)));
}
function policyProof(dump, name) {
  const probes = delimiterCells(dump), result = [];
  const parentRoles = { heading: 'mdHeading', inline: 'mdCode', string: 'syntaxString', link: 'mdLink' };
  const floors = { heading: 0.12, inline: 0.07, string: 0, link: 0.07 };
  const panel = color(spans(dump, 'FOLLOW_PI_HEADING')[0].cells[0], true);
  for (const { family, parent, cell } of probes) {
    const role = parentRoles[family], authoredParent = publicInk(dump, role), sameAsParent = same(cell, authoredParent);
    assert.equal(same(parent, authoredParent), true, `${family}: physical check uses the public Pi semantic source`);
    if (family === 'string') assert.equal(sameAsParent, true, 'literal quote remains part of its Pi string color');
    else if (['dark', 'light', 'gruvbox', 'saturated'].includes(name) && !cell.dim)
      assert.equal(sameAsParent, false, `${family}: reference-theme marker has a role-specific derived shade`);
    const background = color(cell, true), fg = color(cell);
    const unknown = name === 'terminal-default' || cell.dim
      || name === 'mixed-foreground' && ['inline', 'string'].includes(family);
    if (unknown || !background || !fg || !panel) {
      result.push({ family, sourceRole: role, evaluated: false, reason: 'symbolic-background-foreground-or-faint', foreground: cell.fg, foregroundMode: cell.fgMode });
      continue;
    }
    const ratio = bg => (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
    const floor = Math.min(4.5, ratio(panel)), emitted = ratio(background);
    assert.ok(emitted + 1e-10 >= (sameAsParent ? floor : 4.5), `${family}: derived ink needs 4.5:1 contrast on this actual surface; exact fallback must not regress (${emitted})`);
    const delta = sameAsParent ? 0 : separation(fg, color(authoredParent));
    if (!sameAsParent) assert.ok(delta >= floors[family], `${family}: final emitted separation ${delta} is below its role-specific floor ${floors[family]}`);
    if (family === 'link' && !sameAsParent) {
      for (const peer of ['mdLinkUrl', 'toolOutput']) {
        const peerInk = color(publicInk(dump, peer));
        if (peerInk) assert.ok(separation(fg, peerInk) >= 0.055, `link delimiter remains distinct from ${peer}`);
      }
    }
    result.push({ family, sourceRole: role, evaluated: true, ratio: emitted, floor, separation: delta, foreground: cell.fg, foregroundMode: cell.fgMode });
  }
  return result;
}

for (const mode of ['fullscreen', 'regular']) for (const output of ['truecolor', '256color']) test(`Follow Pi matrix: actual ${mode}/${output} authored, neutral, low-contrast and unknown palettes`, { timeout: 120000 }, async () => {
  const terminal = new PiTerminal(`follow-pi-matrix-${mode}-${output}`, { mode, tidyUi: false, extensions: [fixture],
    extraEnv: { ...descriptor, PI_TRUE_COLOR: output === 'truecolor' ? '1' : '0', TIDY_UI_TEST_CARD_OBSERVE: '1',
      TIDY_UI_TEST_PALETTE_OBSERVE: '1', TIDY_UI_TEST_PALETTE_THEMES: '1',
      TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }) } });
  try {
    await terminal.ready(); await syntaxReady(terminal); terminal.send('run follow-pi-palette\r'); await terminal.event('agent_end');
    const original = await captureThenRenderDiagnostics(terminal, 'matrix-original'), cold = original.sample;
    assert.ok(await semanticPhaseReady(() => cold, () => terminal.events(), followPiMarkers, 'pi'), 'complete actual source/style matrix');
    const originalTraffic = traffic(terminal), originalData = persisted(original), cases = [];
    for (const name of ['dark', 'light', 'gruvbox', 'saturated', 'monochrome', 'low-contrast', 'terminal-default', 'mixed-foreground', 'faint', 'faint-donor', 'faint-parent']) {
      const prior = publications(terminal); assert.equal(prior.size, 3);
      writeFileSync(join(terminal.output, 'syntax-theme-phase'), name);
      await terminal.command(name === 'dark' || name === 'light' ? `/tidy-ui-theme ${name}` : `/tidy-ui-palette-theme ${name}`);
      const before = await settledStats(terminal, `${name}-before-widths`), cells = [];
      if (name !== 'dark') {
        const current = publications(terminal);
        assert.ok([...prior].every(([id]) => current.get(id)?.phase === name)
          && [...prior].some(([id, old]) => current.get(id).paintStamp !== old.paintStamp), `complete ${name} publication`);
      }
      for (const width of [60, 140]) {
        await terminal.resize(width); const shown = await captureThenRenderDiagnostics(terminal, `matrix-${name}-${width}`);
        paintProof(shown, { distinct: ['dark', 'light', 'gruvbox', 'saturated'].includes(name) });
        cells.push({ width, probes: policyProof(shown, name) });
        if (name === 'faint-donor' || name === 'faint-parent') for (const text of ['FOLLOW_PI_HEADING', 'site']) for (const found of spans(shown, text)) {
          const marker = shown.cells[found.y][text === 'site' ? found.x - 1 : shown.screen[found.y].lastIndexOf('#', found.x)];
          assert.equal(!!marker.dim, name === 'faint-parent', 'only the original typography parent controls marker faint');
        }
        if (name === 'faint') assert.ok(spans(shown, 'after').every(found => found.cells.every(cell => cell.dim)), 'actual public faint typography is preserved');
        if (name === 'mixed-foreground' && output === 'truecolor') {
          const sample = spans(shown, 'after'), backgrounds = new Set(sample.map(found => `${found.cells[0].bgMode}:${found.cells[0].bg}`));
          assert.ok(backgrounds.size >= 3, 'known panel still has ordinary/added/removed tints with unknown foreground constraints');
        }
        const headings = spans(shown, 'FOLLOW_PI_HEADING');
        assert.equal(headings.length, width === 140 ? 3 : 2, 'real unified/split geometry');
        if (output === '256color' && name !== 'terminal-default') assert.ok(headings.every(found => found.cells.every(cell => cell.fgMode === 2 << 24)), 'public capability override actually emits indexed colors');
        assert.deepEqual(persisted(shown), originalData); assert.deepEqual(traffic(terminal), originalTraffic);
      }
      await terminal.observeAnimation(); const warm = await settledStats(terminal, `${name}-warm`);
      assert.deepEqual(work(warm), work(before), 'warm frames and real unified/split reflow add zero palette/parser/style/measurement/scalar work');
      assert.equal(warm.counts.sourceRequests, cold.counts.sourceRequests); assert.equal(warm.counts.styleRequests, cold.counts.styleRequests);
      assert.equal(warm.localWork.sourceSegments, cold.localWork.sourceSegments); assert.equal(warm.localWork.prefixScalarReads, cold.localWork.prefixScalarReads);
      assert.equal(warm.counts.piCaptures, 0); assert.equal(warm.counts.piBridges, 0);
      cases.push({ name, cells, counts: work(warm) });
    }
    writeFileSync(join(terminal.output, 'palette-matrix.json'), JSON.stringify({ mode, output, cases, limitations: 'Indexed numeric checks use the conventional palette model. Unknown/default/authored-indexed inputs are preserved, not certified readable.' }, null, 2));
    await terminal.resize(100);
    assert.deepEqual(body(await captureThenRenderDiagnostics(terminal, 'matrix-final')), body(original), 'all source glyphs, gutters and payload text survive the full palette matrix');
    console.log(JSON.stringify({ followPiMatrix: { mode, output, path: terminal.output, cases: cases.length,
      numericallyEvaluatedAuthoredCells: cases.flatMap(c => c.cells.flatMap(w => w.probes)).filter(p => p.evaluated).length,
      sourceReparseDelta: 0, styleResolveDelta: 0, warmDelta: 0 } }));
    await finish(terminal);
  } finally { await closeTerminals([terminal]); }
});
