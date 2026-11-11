import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { BashToolReader, FileToolReader, ToolDiagnosticsIdentity } from '../tool-adapters/contracts.ts';

export type CardSourceInput = { palette: number } & (
  { kind: 'file'; reader: FileToolReader; diagnostics: ToolDiagnosticsIdentity; viewMode?: 'preview' | 'full' } |
  { kind: 'bash'; reader: BashToolReader; complete: boolean }
);
export type CardDisplayInput = CardSourceInput & {
  revision: number; sourceRevision: number; serviceRevision: number; mode: TerminalColorMode;
  cwd?: string; directory?: string;
};
