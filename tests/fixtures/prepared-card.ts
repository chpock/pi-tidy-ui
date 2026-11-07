import assert from 'node:assert/strict';
import { SourceController } from '../../src/occipital/controller.ts';
import { CardSources, type CardDisplayInput } from '../../src/syntax/cards.ts';
import { layoutCard } from '../../src/syntax/card-layout.ts';
import { preparePaletteInput, type PiInputTheme } from '../../src/syntax/pi-input.ts';
import { bashToolReaderFixture, fileToolReaderFixture, type ToolCallFixture } from './tool-adapters/reader-fixture.ts';
import { resolveTheme } from '../../src/themes/selection.ts';
import type { CardGeometry } from '../../src/card-frame.ts';

// Test composition only: exercise the shipping preparer/layout/painter with actual
// public Pi input. This is not a differential oracle or a replacement renderer.
export function preparedCard(input: CardDisplayInput, width: number, theme: PiInputTheme, outputPad = 1,
  classify?: (text: string, path: string) => string[], expanded = false) {
  const provider = { snapshot: () => ({ generation: 1, availability: 'initializing' as const, reason: 'initializing' as const, initialShared: false }),
    isReady: () => false, classificationAccepted: () => false, request: async () => assert.fail('fixture must not dispatch native work') };
  const sources = new SourceController(provider), owner = {};
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: true, provider: provider.snapshot(), selected: { kind: 'pi' as const, variant: 'dark' as const }, effective: resolveTheme({ kind: 'pi', variant: 'dark' }).effective, standaloneVersion: 'test' }) },
    { preparePaletteInput: (palette, revision, mode, funding) => preparePaletteInput(theme, palette.id, revision, mode, funding), classify: (text, info) => classify!(text, info.path!), invalidate() {}, requestRender() {} });
  const funding = sources.geometryFunding()!;
  try {
    assert.equal(cards.updateDisplay(owner, input), true);
    if (classify) { cards.useful(owner, 1); sources.flush(); }
    let result: { rows: string[]; framed: boolean; expandable: boolean; geometry: Readonly<CardGeometry> } | undefined;
    assert.equal(cards.visit(owner, (display, paint) => {
      const layout = layoutCard(display, { width, outputPad, expanded }, funding)!;
      const output = layout.paint(display, paint, funding)!;
      try {
        const rows: string[] = []; assert.equal(output.visitRows((_index, row) => rows.push(row)), true);
        result = { rows, framed: layout.framed, expandable: layout.expandable, geometry: layout.geometry };
      } finally { output.dispose(); layout.dispose(); }
    }), true);
    return result!;
  } finally { cards.dispose(); sources.dispose(); assert.equal(funding.budget.stats().retainedBytes, 0); }
}
export function fileCardFixture(input: ToolCallFixture, cwd: string | undefined, width: number,
  theme: PiInputTheme, classify?: (text: string, path: string) => string[], outputPad = 1) {
  const reader = fileToolReaderFixture(input);
  if (!reader.prepareFile('full', true)) return undefined;
  return preparedCard({ kind: 'file', reader, diagnostics: reader.diagnostics('full'), cwd, revision: 1, sourceRevision: 1,
    serviceRevision: 1, palette: 1, mode: 'truecolor' }, width, theme, outputPad, classify);
}
export function bashCardFixture(input: ToolCallFixture, directory: string | undefined, width: number, theme: PiInputTheme, outputPad = 1) {
  const reader = bashToolReaderFixture(input);
  return preparedCard({ kind: 'bash', reader, complete: !reader.call.partial, directory, revision: 1, sourceRevision: 1,
    serviceRevision: 1, palette: 1, mode: 'truecolor' }, width, theme, outputPad, undefined, reader.call.expanded);
}
