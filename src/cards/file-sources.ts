import type { FileLogicalLine, FileSide, FileSource, SourceFileView } from './file-model.ts';

/** Topology only: all old-side fragments precede all next-side fragments. A gap
 * or unproven line continuity ends a fragment; opposite-side rows do not.
 * Dense zero-based ordinals always contain a positioned row, even empty text,
 * so materialized sources keep the same indices as cold descriptor keys. */
export function visitFileSegments(lines: readonly FileLogicalLine[],
  visit: (side: FileSide, ordinal: number, row: number, line: Exclude<FileLogicalLine, { kind: 'gap' }>) => void): void {
  let ordinal = 0;
  for (const side of ['old', 'next'] as const) {
    let previous: number | undefined, active = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.kind === 'gap') { if (active) ordinal++; previous = undefined; active = false; continue; }
      const position = line[side]; if (position === undefined) continue;
      if (!active || position !== previous! + 1) { if (active) ordinal++; active = true; }
      visit(side, ordinal, index, line); previous = position;
    }
    if (active) ordinal++;
  }
}

/** Join only at the useful source boundary; lifecycle owners retain logical fragments. */
export function fileSources(view: SourceFileView): FileSource[] {
  const sources: FileSource[] = [];
  const first = (side: FileSide) => view.lines.find((line): line is Exclude<FileLogicalLine, { kind: 'gap' }> => line.kind !== 'gap' && line[side] === 1)?.languageHint;
  const oldCandidate = first('old'), nextCandidate = first('next');
  let side: FileSide = 'old', ordinal = -1, rows: number[] = [], parts: string[] = [];
  const flush = () => {
    const candidate = side === 'old' ? oldCandidate ?? nextCandidate : nextCandidate ?? oldCandidate;
    if (rows.length) sources.push({ side, text: parts.join('\n'), rows, ...(candidate ? { languageHint: candidate } : {}) });
  };
  visitFileSegments(view.lines, (nextSide, segment, index, line) => {
    if (segment !== ordinal) {
      if (ordinal !== -1) { flush(); rows = []; parts = []; }
      side = nextSide; ordinal = segment;
    }
    rows.push(index); parts.push(line.logical);
  });
  flush();
  return sources;
}
