import type { SourceController, DisplayRangeReader, PiProjectionReader } from '../../src/occipital/controller.ts';
import type { SyntaxResolution } from '../../src/syntax/work.ts';
import { DataBudget } from '../../src/occipital/data-budget.ts';
import { measure, reflow } from '../../src/syntax/measured-rows.ts';
import { paintFlat, type FlatRangeReader } from '../../src/syntax/flat-paint.ts';
import { compileStyleAnsi, type AnsiStyle } from '../../src/syntax/style-ansi.ts';
import type { ConcreteStyle } from '../../src/syntax/style-materialization.ts';

export const neutral: ConcreteStyle = { foreground: { kind: 'rgb', r: 1, g: 2, b: 3 }, background: { kind: 'terminal-default' }, attributes: 0 };
export function piSpans(projection: PiProjectionReader | undefined) {
  if (!projection) return undefined;
  const styles: ConcreteStyle[] = [], spans: { start: number; end: number; style: ConcreteStyle }[] = [];
  if (!projection.visitStyles((index, style) => { styles[index] = style; })) return undefined;
  if (!projection.visitRanges((start, end, index) => { spans.push({ start, end, style: styles[index]! }); })) return undefined;
  return spans;
}

// Test-only composition of the accepted measurement/compiler/painter. Production
// consumers must port separately; work.ts deliberately exports no painter.
function project(sources: SourceController, resolution: SyntaxResolution, width: number | undefined): string[] | undefined {
  if (resolution.owner.deref() !== sources) return undefined;
  const budget = new DataBudget(4_000_000);
  const paint = (text: string, read: FlatRangeReader) => {
    const measured = measure(text, budget)!;
    const layout = reflow(measured, { mode: width === undefined ? 'file' : 'bash', width: width ?? 100000 })!;
    const literal = compileStyleAnsi(neutral, 'truecolor');
    const result = paintFlat(text, measured, layout, read, literal, literal, Buffer.byteLength(text), budget);
    try {
      if (!result) return undefined;
      const rows: string[] = [];
      return result.visitRows((_index, row) => { rows.push(row.replace(/\x1b\[[\d;]*m/g, '')); }) ? rows : undefined;
    } finally { result?.dispose(); layout.dispose(); measured.dispose(); }
  };
  const native = (read: DisplayRangeReader): FlatRangeReader => consume => read((start, end, style) => consume(start, end, compileStyleAnsi(style, 'truecolor')));
  if (resolution.display) {
    let rows: string[] | undefined;
    if (resolution.display.visit((text, read) => { rows = paint(text, native(read)); })) return rows;
    return undefined;
  }
  if (resolution.pi) {
    const source = sources.borrowPiSource(resolution.key), projection = resolution.pi;
    if (source?.generation !== projection.generation || source.version !== resolution.version) return undefined;
    const styles: AnsiStyle[] = [];
    if (!projection.visitStyles((index, style) => { styles[index] = compileStyleAnsi(style, 'truecolor'); })) return undefined;
    return paint(source.text, consume => projection.visitRanges((start, end, index) => consume(start, end, styles[index]!)));
  }
  if (resolution.native) {
    const source = sources.borrowSource(resolution.key);
    if (!source || source.generation !== resolution.nativeGeneration || source.version !== resolution.version) return undefined;
    return paint(source.text, native(resolution.native));
  }
  return undefined;
}
export const fileRows = (sources: SourceController, resolution: SyntaxResolution) => project(sources, resolution, undefined);
export const bashRows = (sources: SourceController, resolution: SyntaxResolution, width: number) => project(sources, resolution, width);
