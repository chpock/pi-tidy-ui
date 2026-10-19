import assert from 'node:assert/strict';
import { SourceController } from '../../src/occipital/controller.ts';
import { CardSources, type CardDisplayInput } from '../../src/syntax/cards.ts';
import { layoutCard } from '../../src/syntax/card-layout.ts';
import { preparePiInput, type PiInputTheme } from '../../src/syntax/pi-input.ts';
import { prepareFileCard } from '../../src/file-card.ts';
import type { CardGeometry } from '../../src/card-frame.ts';
import type { BashPresentation } from '../../src/bash-card.ts';

// Test composition only: exercise the shipping preparer/layout/painter with actual
// public Pi input. This is not a differential oracle or a replacement renderer.
export function preparedCard(input: CardDisplayInput, width: number, theme: PiInputTheme, outputPad = 1,
  classify?: (text: string, path: string) => string[], expanded = false) {
  const provider = { snapshot: () => ({ generation: 1, availability: 'initializing' as const, reason: 'initializing' as const, initialShared: false }),
    isReady: () => false, classificationAccepted: () => false, request: async () => assert.fail('fixture must not dispatch native work') };
  const sources = new SourceController(provider), owner = {};
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: true, provider: provider.snapshot(), selected: { kind: 'pi' as const }, standaloneVersion: 'test' }) },
    { preparePiInput: funding => preparePiInput(theme, 1, 'truecolor', funding), classify: (text, info) => classify!(text, info.path!), invalidate() {}, requestRender() {} });
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
export function fileCardFixture(node: Parameters<typeof prepareFileCard>[0], cwd: string | undefined, width: number,
  theme: PiInputTheme, classify?: (text: string, path: string) => string[], outputPad = 1) {
  node = { toolName: 'edit', ...node };
  if (!prepareFileCard(node, true)) return undefined;
  return preparedCard({ kind: 'file', node, cwd, revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor' }, width, theme, outputPad, classify);
}
export function bashCardFixture(node: BashPresentation, directory: string | undefined, width: number, theme: PiInputTheme, outputPad = 1) {
  return preparedCard({ kind: 'bash', node, args: node.args, complete: !node.isPartial, directory, revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor' }, width, theme, outputPad, undefined, node.expanded);
}
