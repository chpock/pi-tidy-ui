export type FileCardInput = {
  readonly kind: 'read' | 'write' | 'edit';
  readonly path: string;
  readonly complete: boolean;
  readonly failed: boolean;
  readonly viewMode: 'full' | 'preview';
  readonly content?: unknown;
  readonly saved?: { readonly format: 'numbered' | 'unified'; readonly value: unknown };
  readonly truncated?: boolean;
  readonly noOp?: boolean;
  readonly note?: string;
  readonly readRows?: readonly { readonly text: string; readonly line?: number }[];
};
export type FileSide = 'old' | 'next';
export type FileDisplayLine = { kind: ' ' | '+' | '-'; text: string; old?: number; next?: number; hunk?: number } | { kind: 'gap' };
export type FileLogicalLine = (Exclude<FileDisplayLine, { kind: 'gap' }> & { logical: string; languageHint?: string }) | { kind: 'gap' };
export type FileView = { label: 'Edited' | 'Created' | 'Replaced' | 'Wrote' | 'Edit' | 'Write' | 'Read'; mode: 'inline' | 'diff' | 'code';
  lines: readonly FileDisplayLine[]; note?: string; preview?: boolean; omitted?: boolean };
export type SourceFileView = Omit<FileView, 'lines'> & { lines: FileLogicalLine[] };
export interface FileSource {
  readonly side: FileSide;
  readonly text: string;
  readonly languageHint?: string;
  /** Full prepared-view indices, not visible-context or wrapped row indices. */
  readonly rows: readonly number[];
}
export interface PreparedFileCard {
  readonly path: string;
  readonly view: SourceFileView;
  readonly sources: readonly FileSource[];
}
