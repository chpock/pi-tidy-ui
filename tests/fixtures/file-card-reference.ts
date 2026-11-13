import './test-guard.mjs';
import { cardGeometry } from '../../src/card-frame.ts';
import { wrapText } from '../../src/text-wrap.ts';
import type { FileCardInput } from '../../src/cards/file-model.ts';
import { filePresentation } from '../../src/cards/file-input.ts';
import { fileHeading } from '../../src/file-card.ts';

/** Metadata-only height reference; the live adapter consumes an already prepared display. */
export function measureFileCard(input: FileCardInput, cwd: string | undefined, width: number, outputPad = 1) {
  if (!input.path) return undefined;
  if (!width) return { framed: false, height: 0 };
  const view = filePresentation(input, false);
  if (!view) return undefined;
  if (view.mode !== 'inline') return { framed: true, height: 3 };
  const geometry = cardGeometry(width, outputPad);
  const inset = Math.min(geometry.contentX, Math.max(0, width - geometry.marginRight - 1));
  return { framed: false, height: wrapText(fileHeading(input.path, cwd, view.label), width - inset - geometry.marginRight, { wide: 'replace' }).length };
}
