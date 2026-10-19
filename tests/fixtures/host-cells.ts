import { createRequire } from 'node:module';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
const { Terminal } = createRequire(import.meta.url)('@xterm/headless');
/** Independent terminal parser for the host's public string transfer boundary. */
export async function hostCells(rows: readonly string[]) {
  const width = Math.max(2, ...rows.map(visibleWidth)), terminal = new Terminal({ cols: width + 1, rows: rows.length + 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(rows.join('\r\n'), resolve));
    return rows.map((_row, y) => Array.from({ length: width }, (_, x) => {
      const cell = terminal.buffer.active.getLine(y).getCell(x), text = cell.getChars() || ' ';
      return { text, fg: text.trim() ? cell.getFgColor() : undefined, bg: cell.getBgColor(),
        bold: text.trim() ? !!cell.isBold() : false, italic: text.trim() ? !!cell.isItalic() : false, underline: text.trim() ? !!cell.isUnderline() : false };
    }));
  } finally { terminal.dispose(); }
}
export async function hasHostInk(rows: readonly string[], theme: { fg(role: ThemeColor, text: string): string }, role: ThemeColor, text: string, bold = false) {
  const expected = (await hostCells([theme.fg(role, text)]))[0]!.filter(cell => cell.text.trim());
  const actual = (await hostCells(rows)).flat().filter(cell => cell.text.trim() && (text.includes('┃') || cell.text !== '┃'));
  return actual.some((_cell, start) => expected.every((cell, i) => cell.text === actual[start + i]?.text && cell.fg === actual[start + i]?.fg && (!bold || actual[start + i]?.bold)));
}
