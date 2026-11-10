import { isAbsolute, relative } from 'node:path';
import { cardGeometry } from './card-frame.ts';
import { displayPath } from './display-path.ts';
import { wrapText } from './text-wrap.ts';
import type { FileCardInput, FileView } from './cards/file-model.ts';
import { filePresentation } from './cards/file-input.ts';
import { cleanFileDisplayText as clean } from './cards/file-display.ts';

function headingPath(path: string, cwd: string | undefined): string {
  const local = cwd && isAbsolute(cwd) && isAbsolute(path) ? relative(cwd, path) : path;
  return clean(displayPath(local || path, cwd)).replace(/\s+/gu, ' ').trim();
}
export function fileHeading(path: string, cwd: string | undefined, label: FileView['label']): string {
  return `← ${label} ${headingPath(path, cwd)}`;
}

export function readHeading(path: string, cwd: string | undefined): string {
  return `→ Read ${headingPath(path, cwd)}`;
}

/** Class/height needed for spacing or rejected clicks, not a rendered layout or a second cache. */
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
