import type { FileRowDescriptor, PreparedCard, PreparedRegion } from '../rendering/card-values.ts';
import type { FileView, PreparedFileCard } from './file-model.ts';
import { contextRows, fileDiagnosticText } from './file-display.ts';
import { visitFileSegments } from './file-sources.ts';
import { cardSourceKey, type CardMeasurements } from './preparation.ts';

type FileDisplay = Extract<PreparedCard, { kind: 'file' }>;
interface FileMetadata {
  diagnosticText(): readonly { readonly line?: number; readonly message: string }[];
  note(view: Pick<FileView, 'label' | 'mode'>): string | undefined;
}

export function prepareFileServices(input: {
  readonly file?: PreparedFileCard; readonly previous?: FileDisplay;
  readonly preview: boolean; readonly diagnostics: readonly unknown[] | boolean;
  readonly sameService: boolean; readonly metadata: FileMetadata;
}, measurements: Pick<CardMeasurements, 'region'>): { readonly diagnostics: readonly PreparedRegion[]; readonly note?: PreparedRegion } {
  const { file, previous, metadata } = input;
  const diagnostics = input.preview ? Object.freeze(input.diagnostics === true
    ? [measurements.region('Diagnostics available in the full file view.')] : [])
    : previous && input.sameService ? previous.diagnostics
      : Object.freeze(fileDiagnosticText(metadata.diagnosticText()).map(text => measurements.region(text)));
  const noteText = input.preview ? file?.view.note : file ? metadata.note(file.view) : undefined;
  const note = noteText ? previous?.note?.text === noteText ? previous.note : measurements.region(noteText) : undefined;
  return { diagnostics, note };
}

export function prepareFileRows(file: PreparedFileCard | undefined, ticket: number, measurements: Pick<CardMeasurements, 'region'>): readonly FileRowDescriptor[] {
  const rows: FileRowDescriptor[] = [];
  if (file) {
    const visible = file.view.preview || file.view.mode === 'code' ? file.view.lines : contextRows(file.view.lines);
    const indices = new Map(file.view.lines.map((line, index) => [line, index]));
    const coordinates = new Map<number, { oldSource?: FileRowDescriptor['oldSource']; nextSource?: FileRowDescriptor['nextSource'] }>();
    let previous = -1, utf16 = 0, byte = 0;
    visitFileSegments(file.view.lines, (side, ordinal, index, line) => {
      if (ordinal !== previous) { utf16 = byte = 0; previous = ordinal; }
      const key = cardSourceKey(ticket, ordinal);
      const coordinate = coordinates.get(index) ?? {}; coordinate[side === 'old' ? 'oldSource' : 'nextSource'] = { key, utf16, byte }; coordinates.set(index, coordinate);
      utf16 += line.logical.length + 1; byte += Buffer.byteLength(line.logical) + 1;
    });
    visible.forEach(line => {
      const index = indices.get(line) ?? -1;
      const coordinate = coordinates.get(index);
      if (coordinate?.oldSource) Object.freeze(coordinate.oldSource);
      if (coordinate?.nextSource) Object.freeze(coordinate.nextSource);
      rows.push(Object.freeze(line.kind === 'gap' ? { kind: 'gap', index } : { kind: line.kind, index, old: line.old, next: line.next, hunk: line.hunk,
        region: measurements.region(line.logical), ...coordinate }));
    });
  }
  return Object.freeze(rows);
}
