import assert from 'node:assert/strict';
import xterm from '@xterm/headless';

export async function assertFits(rows, width) {
  rows = Array.from(rows);
  for (const row of rows) assert.ok(!/[\r\n]/.test(row), 'component row cannot contain a line break');
  if (!rows.length) return;
  const terminal = new xterm.Terminal({ cols: width, rows: 4, allowProposedApi: true });
  try {
    await new Promise((resolve, reject) => {
      let pending = rows.length, failure;
      for (const row of rows) terminal.write('\x1bc' + row, () => {
        try { assert.equal(terminal.buffer.active.cursorY, 0, `row must not wrap at ${width} columns`); }
        catch (error) { failure ??= error; }
        if (!--pending) { if (failure) reject(failure); else resolve(); }
      });
    });
  } finally { terminal.dispose(); }
}
