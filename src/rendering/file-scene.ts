import type { PreparedCard } from './card-values.ts';
import type { Cell, SceneConstruction } from './scene-model.ts';

export function buildFileScene(display: Extract<PreparedCard, { kind: 'file' }>, build: SceneConstruction): void {
  const current = build.scene, available = build.available;
  if (!current.framed) {
    if (display.heading) build.lines('heading', 0, display.error ? 'error' : 'muted');
    return;
  }
  if (display.heading) build.lines('heading', 0, 'muted');
  current.digits = String(display.rows.reduce((max, r) => Math.max(max, r.old ?? 0, r.next ?? 0), 1)).length;
  const plain = display.mode === 'code';
  const split = !display.preview && !plain && current.geometry.width > 120 && display.rows.some(r => r.kind === '+') && display.rows.some(r => r.kind === '-');
  const codeLimit = display.preview ? 10 : Number.POSITIVE_INFINITY;
  let codeRows = 0, visualOverflow = display.preview === true && display.omitted === true;
  const cell = (index: number, side: 'old' | 'next', width: number, maxRows?: number): Cell => {
    if (index < 0) return build.empty(width);
    const r = display.rows[index]!;
    if (r.kind === 'gap') return build.empty(width, -3);
    const size = current.digits + (plain ? 2 : 4), gutter = size < width ? size : 0;
    const role = plain ? 'code' : r.kind === ' ' ? 'contextCode' : r.kind === '+' ? 'addedCode' : 'removedCode';
    const id = build.entry('file', index, role, width - gutter, 'file', false, maxRows, side);
    return { entry: id, row: 0, width, gutter, line: index, side };
  };
  const pair = (leftIndex: number, rightIndex: number) => {
    const remaining = codeLimit - codeRows;
    if (remaining <= 0) {
      for (let i = Math.max(0, leftIndex, rightIndex); i < display.rows.length; i++) if (display.rows[i]!.kind !== 'gap') { visualOverflow = true; break; }
      return;
    }
    const maxRows = Number.isFinite(remaining) ? remaining + 1 : undefined;
    const leftWidth = Math.floor(available / 2), rightWidth = available - leftWidth;
    const a = cell(leftIndex, split || display.rows[leftIndex]?.kind === '-' ? 'old' : 'next', split ? leftWidth : available, maxRows),
      b = split ? cell(rightIndex, 'next', rightWidth, maxRows) : undefined;
    const count = Math.max(a.entry < 0 ? 1 : current.entries[a.entry]!.layout.rowCount, b && b.entry >= 0 ? current.entries[b.entry]!.layout.rowCount : 1);
    const shown = Math.min(count, remaining);
    for (let row = 0; row < shown; row++) build.append({ ...a, row }, b ? { ...b, row } : undefined);
    codeRows += shown;
    if (count > remaining) visualOverflow = true;
  };
  if (display.rows.length) build.append(build.empty());
  for (let i = 0; i < display.rows.length;) {
    const r = display.rows[i]!;
    if (!split || r.kind === ' ' || r.kind === 'gap') { pair(i, i); i++; continue; }
    const start = i;
    while (i < display.rows.length) {
      const next = display.rows[i]!; if (next.kind === ' ' || next.kind === 'gap' || next.hunk !== r.hunk) break;
      i++;
    }
    let before = start, after = start;
    while (before < i || after < i) {
      while (before < i && display.rows[before]!.kind !== '-') before++;
      while (after < i && display.rows[after]!.kind !== '+') after++;
      if (before < i || after < i) pair(before < i ? before++ : -1, after < i ? after++ : -1);
    }
  }
  if (display.note) { build.append(build.empty()); build.lines('note', 0, 'muted'); }
  if (visualOverflow) build.append(build.empty(available, -2));
  current.expandable = visualOverflow;
  if (display.diagnostics.length) build.append(build.empty());
  for (let i = 0; i < display.diagnostics.length; i++) build.lines('diagnostic', i, 'diagnostic');
}
