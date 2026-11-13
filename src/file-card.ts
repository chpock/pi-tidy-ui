import { isAbsolute, relative } from 'node:path';
import { displayPath } from './display-path.ts';
import type { FileView } from './cards/file-model.ts';
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
