import { stripVTControlCharacters } from 'node:util';
import { CURSOR_MARKER, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';

export function editorPaint(rows: string[]): string[] {
  // Newer Pi resolves fake cursor metadata during composition, not Editor.render.
  const noop = () => {};
  const terminal: Terminal = { columns: 100, rows: 24, kittyProtocolActive: false, start: noop, stop: noop,
    drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
    clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
  const native = new TuiAltScreen(terminal, false);
  const resolve = (native as unknown as { resolveFakeCursors?: (rows: string[]) => string[] }).resolveFakeCursors;
  return (resolve ? resolve.call(native, rows) : rows).map(row => row.replaceAll(CURSOR_MARKER, ''));
}

export const editorPlain = (row: string): string => stripVTControlCharacters(editorPaint([row])[0]!);
