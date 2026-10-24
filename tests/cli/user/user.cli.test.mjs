import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { sliceByColumn } from '@earendil-works/pi-tui';
import { PiTerminal, artifacts, plain, byName, assertFits, until } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { bashGeometry, referenceCell, Terminal, allBashCards, compactContent, persisted, sgrAt } from '../../fixtures/main-cli-support.mjs';

test('real CLI: user cards share Bash geometry with customMessageLabel and preserve native Markdown',
  { timeout: 120000 }, async () => {
    const terminals = [], extraEnv = { TIDY_UI_TEST_USER_CARDS: '1' };
    const source = 'run user-card\n\nUSER_CARD_PLAIN\n\n**bold** and `inline`\n\n7. seven\n8. eight\n\n> quote\n\n```ts\nconst userValue = 7;\n```\n\n[link](https://example.org) \\*literal\\* 文字 👩‍💻\n\nUSER_CARD_END';
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv, ...options }); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 180); return terminal;
    };
    const run = async (terminal) => {
      terminal.send('\x1b[200~' + source + '\x1b[201~\r');
      await terminal.event('agent_end'); await terminal.settle();
      assert.ok(terminal.screen().some((row) => row.includes('TERMINAL_DONE_user-card')));
    };
    const observed = (terminal) => {
      const events = terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
      assert.equal(events.filter((event) => event.type === 'call').length, 2);
      assert.equal(events.filter((event) => event.type === 'result').length, 2);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 3);
      assert.ok(events.filter((event) => event.type === 'model_context').every((event) => event.user === source),
        'Markdown transformations and framing never change model-facing user bytes');
      return events;
    };
    const body = (rows, start, width) => rows.slice(1, -1).map((row) => stripVTControlCharacters(sliceByColumn(row, start, width)));
    const check = async (dump, native) => {
      assert.equal(dump.users.length, 1); assert.equal(dump.users[0].text, source);
      const user = dump.users[0], geometry = bashGeometry(dump.width);
      const rows = user.lines.filter((row) => row !== '');
      assert.ok(rows[0].startsWith('\x1b]133;A\x07'));
      assert.ok(rows.at(-1).startsWith('\x1b]133;B\x07\x1b]133;C\x07'));
      assert.deepEqual(body(rows, geometry.origin, geometry.content),
        body(native.users[0].contentControl, native.users[0].outputPad, geometry.content),
        'complete Markdown body matches the actual native renderer at the same content width');
      await assertFits(rows, dump.width);
      const expected = rows.map(plain);
      const y = dump.screen.findIndex((_, index) => expected.every((row, offset) =>
        dump.screen[index + offset] !== undefined && plain(dump.screen[index + offset]) === row));
      assert.ok(y >= 0, 'complete user card is physically painted, including all Markdown rows');
      const border = await referenceCell(dump.frameStyles.userBorder), bg = await referenceCell(dump.backgroundStyles.userMessageBg);
      for (let offset = 0; offset < rows.length; offset++) {
        const cells = dump.cells[y + offset];
        assert.equal(cells[1].text, '┃');
        assert.deepEqual({ fg: cells[1].fg, mode: cells[1].fgMode }, { fg: border.fg, mode: border.fgMode });
        assert.equal(cells[1].bgMode, 0, 'user stripe stays on terminal-default background');
        for (const x of [0, dump.width - 1]) {
          assert.ok(!cells[x].text.trim()); assert.equal(cells[x].bgMode, 0, 'outside margins remain unpainted');
        }
        for (let x = 2; x < dump.width - 1; x++)
          assert.deepEqual({ bg: cells[x].bg, mode: cells[x].bgMode }, { bg: bg.bg, mode: bg.bgMode });
        for (const x of [2, dump.width - 2]) assert.equal(cells[x].text, ' ');
      }
      // Compare actual foreground/attributes of every body glyph with native Markdown,
      // not only its plain text. Match Pi's per-line style reset in the independent screen oracle.
      const controlWidth = geometry.content + 2 * native.users[0].outputPad;
      const oracle = new Terminal({ cols: controlWidth, rows: rows.length + 1, allowProposedApi: true });
      try {
        await new Promise((done) => oracle.write(native.users[0].contentControl
          .map((row) => row + '\x1b[0m\x1b]8;;\x1b\\').join('\r\n'), done));
        for (let offset = 1; offset < rows.length - 1; offset++) for (let x = 0; x < geometry.content; x++) {
          const actual = dump.cells[y + offset][geometry.origin + x];
          if (!actual.text.trim()) continue;
          const expectedCell = oracle.buffer.active.getLine(offset).getCell(native.users[0].outputPad + x);
          assert.deepEqual({ fg: actual.fg, mode: actual.fgMode, dim: actual.dim, bold: actual.bold,
            italic: actual.italic, underline: actual.underline },
          { fg: expectedCell.getFgColor(), mode: expectedCell.getFgColorMode(), dim: expectedCell.isDim(),
            bold: expectedCell.isBold(), italic: expectedCell.isItalic(), underline: expectedCell.isUnderline() },
          'every body glyph retains native Markdown foreground and attributes');
        }
      } finally { oracle.dispose(); }
      const plainY = dump.screen.findIndex((row) => row.includes('USER_CARD_PLAIN'));
      const text = await referenceCell(dump.summaryStyles.userMessageText), cell = dump.cells[plainY][3];
      assert.deepEqual({ fg: cell.fg, mode: cell.fgMode }, { fg: text.fg, mode: text.fgMode });
      for (const offset of [0, rows.length - 1])
        for (let x = 2; x < dump.width - 1; x++) assert.equal(dump.cells[y + offset][x].text, ' ');
      assert.ok(dump.screen.some((row) => row.includes('TRANSFORMED_USER')));
      assert.equal(dump.extensionIssues.length, 0);
      allBashCards(dump); compactContent(byName(dump, 'read')[0]);
      return plainY;
    };
    try {
      const stock = await start('user-stock'); await run(stock);
      let native = await stock.capture('native-user-wide');
      const live = await start('user-live', { tidyUi: true, workspace: stock.work }); await run(live);
      let wide = await live.capture('pointer-user-wide');
      assert.deepEqual(observed(live), observed(stock)); assert.deepEqual(persisted(wide), persisted(native));
      await check(wide, native);
      const sessionBytes = readFileSync(wide.session), activity = observed(live);
      const warm = wide.userWork.transforms;
      for (const name of ['warm-one', 'warm-two']) {
        const same = await live.capture(`pointer-user-${name}`);
        assert.equal(same.userWork.transforms, warm, 'unchanged real frames do no Markdown transform work');
        assert.deepEqual(same.users, wide.users);
      }
      const y = wide.screen.findIndex((row) => row.includes('USER_CARD_PLAIN'));
      await sgrAt(live, 3, y, 0, false); await sgrAt(live, 13, y, 32, false);
      live.send(`\x1b[<0;14;${y + 1}m`); await live.settle();
      const selected = await live.capture('pointer-user-selection');
      assert.equal(selected.selectionActive, true, 'user text remains selectable through native drag handling');
      assert.deepEqual(selected.users, wide.users); assert.ok(selected.tools.every((tool) => !tool.expanded));
      const copies = [...Buffer.concat(live.raw).toString('utf8').matchAll(/\x1b\]52;c;([^\x07]*)(?:\x07)/gu)]
        .map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
      assert.deepEqual(copies, ['USER_CARD_P'], 'native clipboard receives exactly the selected visual user text');
      await sgrAt(live, 0, y);
      // The native copy toast briefly overlays the first padding row; wait for it,
      // never weaken the complete-card or physical-cell assertions around that overlay.
      await until(() => !live.screen().some((row) => row.includes('Copied!')), 'native copy toast dismissed');
      const cleared = await live.capture('pointer-user-selection-cleared');
      assert.equal(cleared.selectionActive, false); await check(cleared, native);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('pointer-user-expanded');
      assert.deepEqual(expanded.users, wide.users, 'native tool expansion never changes user presentation');
      live.send('\x0f'); await live.settle();
      for (const width of [24, 60, 100]) {
        await stock.resize(width, 180); native = await stock.capture(`native-user-width-${width}`);
        await live.resize(width, 180); await check(await live.capture(`pointer-user-width-${width}`), native);
      }
      for (const name of ['light', 'dark']) {
        await stock.command(`/tidy-ui-theme ${name}`); native = await stock.capture(`native-user-${name}`);
        await live.command(`/tidy-ui-theme ${name}`); await check(await live.capture(`pointer-user-${name}`), native);
      }
      await live.appearance(false);
      const disabled = await live.capture('native-user-disabled');
      assert.deepEqual(disabled.users, native.users, 'off restores native user rows and padding byte-for-byte');
      await live.appearance(true); wide = await live.capture('pointer-user-on'); await check(wide, native);
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('pointer-user-reloaded'); await check(reloaded, native);
      assert.deepEqual(reloaded.users, wide.users); assert.deepEqual(observed(live), activity);
      assert.deepEqual(readFileSync(wide.session), sessionBytes, 'all UI probes preserve exact session bytes');
      await stock.close(); await live.close();
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`user-replay-${mode}`, { tidyUi: true, session: wide.session, workspace: live.work, mode });
        const resumed = await replay.capture(`pointer-user-replayed-${mode}`); await check(resumed, native);
        assert.deepEqual(resumed.users, reloaded.users); assert.deepEqual(resumed.branch, reloaded.branch);
        for (const type of ['call', 'result', 'model_context']) assert.equal(replay.events().filter((event) => event.type === type).length, 0);
        await replay.close();
        assert.equal(replay.closed, true, 'completed user replay is reaped before the next mode');
      }
      writeFileSync(join(artifacts, 'user-card-coverage.json'), JSON.stringify({ calls: 2, results: 2, modelContexts: 3,
        actualNativeMarkdown: true, transformsPreserved: true, userSourceBytesUnchanged: true,
        physicalWidths: [24, 60, 100], themes: ['dark', 'light'], modes: ['fullscreen', 'regular'],
        checks: ['full native content-width equality', 'customMessageLabel stripe', 'userMessageBg/userMessageText',
          'OSC 133 zones', 'native selection and Ctrl+O', 'warm transform work', 'off/on/reload', 'same-session replay and bytes'],
      }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });
