import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, artifacts, plain, lines, toolLines, assertFits, deferredNativePreparation } from '../../fixtures/terminal-harness.mjs';
import { replayBlockStart, compareEditReplayColors } from '../../fixtures/edit-replay-comparator.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { Terminal, compactContent, persisted, referenceCell } from '../../fixtures/main-cli-support.mjs';
import { cardGeometry } from '../../../src/card-frame.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';

const rgb = value => [value >>> 16, value >>> 8 & 255, value & 255];
const hex = value => '#' + value.toString(16).padStart(6, '0');
const luminance = value => rgb(value).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
function paletteSwatch(name, rows, cells) {
  const escape = text => text.replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character]);
  const width = cells[0].length * 10, height = rows.length * 24;
  const fragments = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  for (const [y, line] of cells.entries()) for (const [x, cell] of line.entries()) {
    if (cell.bgMode) fragments.push(`<rect x="${x * 10}" y="${y * 24}" width="10" height="24" fill="${hex(cell.bg)}"/>`);
    if (cell.text.trim()) fragments.push(`<text x="${x * 10}" y="${y * 24 + 18}" fill="${hex(cell.fg)}" font-family="DejaVu Sans Mono,monospace" font-size="16">${escape(cell.text)}</text>`);
  }
  fragments.push('</svg>'); writeFileSync(join(artifacts, `diff-palette-${name}.svg`), fragments.join(''));
}

test('real CLI: OpenCode-style edit syntax, numbered unified/split format, errors and exact replay',
  { timeout: 180000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv: { TIDY_UI_TEST_EDIT_CARDS: '1', TIDY_UI_TEST_NATIVE_PREPARATION: '1', TIDY_UI_TEST_SYNTAX_CARDS: '1' }, ...options });
      terminals.push(terminal);
      mkdirSync(join(terminal.agent, 'themes'), { recursive: true });
      writeFileSync(join(terminal.agent, 'themes/gruvbox-dark-hard.json'), readFileSync(new URL('../../fixtures/gruvbox-dark-hard.json', import.meta.url)));
      await terminal.ready(); await terminal.resize(100, 160); return terminal;
    };
    const preparedCapture = (terminal, name) => terminal.capture(name, { prepared: { tool: 'edit', count: 5 } });
    const run = async (terminal) => {
      const turn = terminal.events().filter((event) => event.type === 'agent_end').length;
      terminal.send('run edit-cards\r'); await terminal.event('provider_gate');
      const pending = await terminal.capture('pending');
      assert.equal(pending.tools.length, 1);
      assert.equal(pending.tools[0].executionStarted, false);
      writeFileSync(join(terminal.output, 'provider-go'), 'go');
      await terminal.event('edit_execution_gate');
      const running = await terminal.capture('edit-running');
      assert.equal(running.tools[0].executionStarted, true);
      assert.equal(running.tools[0].partial, true);
      assert.equal(terminal.events().filter((event) => event.type === 'call').length, 1);
      assert.equal(terminal.events().filter((event) => event.type === 'result').length, 0);
      writeFileSync(join(terminal.output, 'edit-execution-go'), 'go');
      await terminal.event('agent_end', turn + 1); await terminal.settle(); return { pending, running };
    };
    const traffic = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((event) => event.type === 'call').length, 7);
      assert.equal(events.filter((event) => event.type === 'result').length, 7);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 8);
      assert.deepEqual(events.filter((event) => event.type === 'result').map((event) => !!event.isError), [false, false, true, true, false, false, false]);
      return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    let checkedSyntaxCells = 0, checkedPanelCells = 0;
    const reference = new Terminal({ cols: 100, rows: 4, allowProposedApi: true });
    const fg = async (dump, role) => {
      reference.reset(); await new Promise((done) => reference.write(dump.summaryStyles[role], done));
      const cell = reference.buffer.active.getLine(0).getCell(0);
      return { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim() };
    };
    const replayColors = async (actual, expected, expandedErrors = false) =>
      compareEditReplayColors(actual, expected, await fg(actual, 'mdCodeBlock'), expandedErrors ? [2, 3] : []);
    const checkPreview = async (dump, evidence) => {
      const rows = lines(dump.tools[0]), text = rows.join('\n');
      assert.match(text, /← Edit edit-example\.ts/);
      assert.doesNotMatch(text, /← Edited edit-example\.ts|const context17 =/);
      assert.match(text, /const before = 10/);
      assert.match(text, /const after = 20/);
      assert.match(text, /Click to expand/);
      const physical = dump.screen.map(plain);
      const start = physical.findIndex((row, y) => row === rows[0] && rows.every((value, offset) => physical[y + offset] === value));
      assert.ok(start >= 0, 'the bounded restored edit preview is present on the physical screen');
      const sourceRow = rows.findIndex(row => row.includes('const before = 10'));
      const column = rows[sourceRow].indexOf('export');
      assert.ok(column >= 0);
      const cell = dump.cells[start + sourceRow][column];
      assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await fg(dump, 'syntaxKeyword'),
        'the visible bounded edit row keeps its physical keyword color');
      if (evidence) writeFileSync(join(artifacts, `edit-preview-${evidence}.json`), JSON.stringify({ rows, keyword: cell.fg }, null, 2));
    };
    const check = async (dump, split, evidence, fullErrors = false) => {
      assert.equal(dump.tools.length, 7);
      const first = dump.tools[0], second = dump.tools[1];
      const rows = lines(first);
      assert.ok(rows.some((row) => row.includes('← Edited edit-example.ts')));
      assert.doesNotMatch(rows.join('\n'), /@@|---|No newline|Click to expand/);
      for (const index of [0, 1, 2, 8, 9, 10, 15, 16, 17]) assert.ok(rows.some((row) => row.includes(`const context${index} =`)), 'three following/preceding logical context rows remain visible');
      for (const index of [3, 11, 14]) assert.ok(!rows.some((row) => row.includes(`const context${index} =`)), 'fourth context row on each side is omitted');
      assert.equal(rows.filter((row) => /^…(?:\s+…)?$/.test(row.slice(3).trim())).length, 1, 'interior omitted interval remains visible between distant TypeScript changes');
      const physical = dump.screen.map(plain);
      const matched = physical.findIndex((row, y) => row === rows[0] && rows.every((value, offset) => physical[y + offset] === value));
      assert.ok(matched >= 0, 'the full numbered diff card exists on the physical screen, not only a manual render');
      const oldRow = rows.findIndex((row) => row.includes('export const before = 10;'));
      const newRow = rows.findIndex((row) => row.includes('export const after = 20;'));
      assert.equal(oldRow === newRow, split, 'real screen switches from stacked to horizontally paired old/new lines');
      assert.match(rows[oldRow], /1 - export const before/);
      assert.match(rows[newRow], /1 \+ export const after/);
      const syntax = async (rowIndex, text, role) => {
        const column = rows[rowIndex].indexOf(text); assert.ok(column >= 0, `${text} exists`);
        const actual = dump.cells[matched + rowIndex][column];
        assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim }, await fg(dump, role), `${text} retains ${role} inside edit source`);
        checkedSyntaxCells++; return actual;
      };
      const keyword = await syntax(oldRow, 'export', 'syntaxKeyword');
      const oldNumber = await syntax(oldRow, '10', 'syntaxNumber');
      const newNumber = await syntax(newRow, '20', 'syntaxNumber');
      assert.notEqual(keyword.fg, oldNumber.fg, 'code is syntax-highlighted, not uniformly red');
      assert.equal(keyword.bg, oldNumber.bg);
      assert.notEqual(oldNumber.bg, newNumber.bg, 'red/green backgrounds are independent of syntax foreground');
      assert.notEqual(oldNumber.bgMode, 0); assert.notEqual(newNumber.bgMode, 0);
      const oldLabel = rows.findIndex((row) => row.includes('const label = "old";'));
      const newLabel = rows.findIndex((row) => row.includes('const label = "new";'));
      await syntax(oldLabel, '"old"', 'syntaxString'); await syntax(newLabel, '"new"', 'syntaxString');
      const functionRow = rows.findIndex((row) => row.includes('function greet'));
      await syntax(functionRow, 'greet', 'syntaxFunction'); await syntax(functionRow, 'string', 'syntaxType');
      await syntax(rows.findIndex((row) => row.includes('continued comment')), 'continued comment', 'syntaxComment');
      await syntax(rows.findIndex((row) => row.includes('continued template')), 'continued template', 'syntaxString');
      const oldSign = await syntax(oldRow, '-', 'toolDiffRemoved'), newSign = await syntax(newRow, '+', 'toolDiffAdded');
      const titleRow = rows.findIndex((row) => row.includes('← Edited edit-example.ts'));
      const panel = dump.cells[matched + titleRow][2];
      assert.equal(panel.bgMode, 0x3000000, 'physical panel supplies a concrete neutral base');
      assert.equal(dump.cells[matched + oldRow][2].bg, panel.bg, 'one neutral left padding cell before diff');
      assert.equal(dump.cells[matched + oldRow][3].bg, oldSign.bg, 'changed gutter begins at content origin without an extra diff inset');
      assert.notEqual(oldSign.bg, panel.bg);
      assert.notEqual(dump.cells[matched + oldRow][dump.width - 3].bg, panel.bg, 'changed diff fills the last content cell');
      assert.equal(dump.cells[matched + oldRow][dump.width - 2].bg, panel.bg, 'one neutral right padding cell after diff');
      const dim = await fg(dump, 'dim'), metrics = [];
      for (const [code, sign] of [[oldNumber, oldSign], [newNumber, newSign]]) {
        assert.equal(sign.fgMode, 0x3000000, 'sign keeps its original concrete foreground');
        assert.equal(code.bgMode, 0x3000000); assert.equal(sign.bgMode, 0x3000000);
        assert.notEqual(code.bg, sign.bg, 'code and number/sign area are separate backgrounds');
        for (const role of ['toolOutput', 'syntaxKeyword', 'syntaxNumber', 'syntaxString', 'syntaxComment', 'syntaxFunction', 'syntaxType']) {
          const ink = await fg(dump, role);
          assert.ok(contrast(ink.fg, code.bg) + 1e-9 >= Math.min(4.5, contrast(ink.fg, panel.bg)), `${role}: physical code contrast is readable or no worse than its theme`);
        }
        assert.ok(contrast(dim.fg, sign.bg) + 1e-9 >= Math.min(3, contrast(dim.fg, panel.bg)), 'number contrast is preserved');
        assert.ok(contrast(sign.fg, sign.bg) + 1e-9 >= Math.min(4.5, contrast(sign.fg, panel.bg)), 'sign contrast is preserved');
        metrics.push({ code: hex(code.bg), gutter: hex(sign.bg), sign: hex(sign.fg), number: hex(dim.fg),
          numberContrast: contrast(dim.fg, sign.bg), signContrast: contrast(sign.fg, sign.bg), syntaxNumberContrast: contrast(code.fg, code.bg) });
      }
      if (evidence) {
        writeFileSync(join(artifacts, `diff-palette-${evidence}.json`), JSON.stringify({ panel: hex(panel.bg), surfaces: metrics }, null, 2));
        const context = rows.findIndex(row => row.includes('const context0 ='));
        const selected = [...new Set([oldRow, newRow, context])];
        paletteSwatch(evidence, selected, selected.map(row => dump.cells[matched + row].slice(3, dump.width - 2)));
      }
      for (const tool of [first, second, ...dump.tools.slice(4)]) {
        await assertFits(tool.lines, dump.width);
        const block = lines(tool);
        const heading = block.findIndex((row) => row.includes('← Edited'));
        assert.equal(block[heading].indexOf('←'), 3, 'edit title shares the physical Bash-description content origin');
        const sourceRows = block.slice(heading + 2, -1).map((row) => row.slice(3).trim()).filter(Boolean);
        assert.ok(sourceRows.length);
        assert.doesNotMatch(sourceRows[0], /^…(?:\s+…)?$/, 'no leading omission marker');
        assert.doesNotMatch(sourceRows.at(-1), /^…(?:\s+…)?$/, 'no trailing omission marker');
        const start = physical.findIndex((row, y) => row === block[0] && block.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0, 'each complete diff card is present on the physical screen');
        for (let y = 0; y < block.length; y++) {
          if (block[y][1] !== '┃') continue; // Exclude native adaptive separators.
          const cells = dump.cells[start + y];
          for (let x = 2; x < dump.width - 1; x++) {
            assert.equal(cells[x].bgMode, 0x3000000, 'nested diff resets cannot expose page background inside any panel cell');
            checkedPanelCells++;
          }
          assert.equal(cells[dump.width - 2].bg, panel.bg, 'last internal right padding cell keeps the neutral card background');
          assert.equal(cells[dump.width - 1].bgMode, 0, 'exterior right margin stays page-colored');
        }
      }
      for (const [index, sign, code] of [[5, '+', 'const addOnly = 4;'], [6, '-', 'const removeOnly = 2;']]) {
        const tool = dump.tools[index], block = lines(tool);
        assert.equal(block.join('\n').split('const retained = 1;').length - 1, 1, 'one-sided context is unified even at wide widths');
        const sourceIndex = block.findIndex(row => row.includes(code)), source = block[sourceIndex];
        assert.ok(source); assert.ok(source.includes(`${index === 5 ? 2 : 3} ${sign} ${code}`), 'original changed line numbers/signs are preserved');
        assert.ok(source.indexOf(code) < dump.width / 2, 'addition/removal both use the left unified gutter');
        assert.ok(tool.details.diff.split('\n').some(row => row.startsWith(sign)));
        assert.ok(!tool.details.diff.split('\n').some(row => row.startsWith(sign === '+' ? '-' : '+')), 'actual persisted diff is one-sided');
        const start = physical.findIndex((row, y) => row === block[0] && block.every((value, offset) => physical[y + offset] === value));
        assert.ok(start >= 0);
        const keyword = dump.cells[start + sourceIndex][source.indexOf('const')];
        assert.deepEqual({ fg: keyword.fg, fgMode: keyword.fgMode, dim: keyword.dim }, await fg(dump, 'syntaxKeyword'));
        checkedSyntaxCells++;
        assert.equal(dump.cells[start + sourceIndex][dump.width - 3].bg, keyword.bg, 'changed unified background fills the whole content width, with no empty half-pane');
      }
      const html = lines(dump.tools[4]);
      assert.ok(!html.some((row) => row.includes('charset="utf-8"')), 'HTML fourth preceding context line is omitted');
      assert.ok(!html.some((row) => row.includes('</html>')), 'HTML fourth following context line is omitted');
      const htmlStart = physical.findIndex((row, y) => row === html[0] && html.every((value, offset) => physical[y + offset] === value));
      const link = html.findIndex((row) => row.includes('<link rel="stylesheet"'));
      const body = html.findIndex((row) => row.includes('<body>'));
      assert.ok(link >= 0 && body > link);
      if (split) {
        assert.ok(body > link + 2, 'the HTML replacement has unmatched removed rows before the next context');
        const rightX = 3 + Math.floor((dump.width - 5) / 2);
        let emptyRows = 0;
        for (let y = link + 1; y < body; y++) {
          if (html[y].slice(rightX, dump.width - 2).trim()) continue;
          emptyRows++;
          for (let x = rightX; x < dump.width - 2; x++) assert.equal(dump.cells[htmlStart + y][x].bg, panel.bg, 'empty added-side counterparts use card background, never page background');
        }
        assert.ok(emptyRows > 0, 'actual HTML output exercises blank right-hand counterparts');
      }
      const tail = lines(second).filter((row) => row.includes('const tail = 40;'));
      assert.equal(tail.length, 1, 'wrapped replacement does not duplicate the next context row');
      if (split) assert.equal(tail[0].match(/const tail = 40;/g)?.length, 2, 'unequal wrapped panes realign the following context');
      for (const failed of [dump.tools[2], dump.tools[3]]) {
        if (fullErrors) {
          const detail = lines(failed).join('\n');
          assert.match(detail, /Could not find|ENOENT/);
          assert.doesNotMatch(detail, /Original file content:|Requested replacement:|Tool error:|NONEXISTENT_EDIT|FAILURE_PROPOSAL/u,
            'failed edit output retains the saved error without either proposed edit side');
          continue;
        }
        compactContent(failed);
        assert.doesNotMatch(lines(failed).join(''), /┃|← Edited|Could not find|ENOENT/);
        const failureRows = lines(failed);
        const y = physical.findIndex((row, index) => row === failureRows[0] && failureRows.every((value, offset) => physical[index + offset] === value));
        assert.ok(y >= 0, 'the complete failed edit summary exists on the physical screen');
        for (let offset = 0; offset < failureRows.length; offset++) for (const cell of dump.cells[y + offset]) {
          if (!cell.text.trim()) continue;
          assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, await fg(dump, 'error'));
        }
      }
    };
    try {
      const stock = await start('edit-stock'); await run(stock); const native = await stock.capture('native');
      assert.ok(native.nativeRenderCalls.edit > 0, 'stock control proves the native counter is active');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      const live = await start('edit-tidyUi', { tidyUi: true, workspace: stock.work });
      const startupProbe = deferredNativePreparation(live);
      assert.ok(startupProbe.probes.length > 0, 'the in-graph deferred-renderer probe is installed before tool construction');
      const liveProbeEpoch = startupProbe.probes.at(-1).epoch;
      assert.deepEqual(startupProbe.attempts.filter(event => event.epoch === liveProbeEpoch), [], 'startup constructs lazy callbacks without preparing stock edit renderers');
      // Recreate only the four owned fixture inputs; no runtime package or project file is modified.
      const { pending, running } = await run(live);
      for (const dump of [pending, running]) assert.equal(dump.nativeRenderCalls.edit ?? 0, 0, 'stock edit streaming/execution performs no native visibility render');
      compactContent(pending.tools[0]);
      assert.match(lines(pending.tools[0]).join(''), /← edit edit-example.ts/);
      assert.doesNotMatch(lines(pending.tools[0]).join(''), /┃|← Edited/);
      assert.match(lines(running.tools[0]).join(''), /^[\s]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] edit edit-example.ts/);
      assert.doesNotMatch(lines(running.tools[0]).join(''), /┃|← Edited/);
      const wide = await preparedCapture(live, 'unified'); await check(wide, false, 'dark-fullscreen');
      assert.equal(wide.nativeRenderCalls.edit ?? 0, 0, 'five cards and two failed summaries never build discarded native rows');
      assert.deepEqual(deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch), [], 'custom edit and failed-summary presentation never prepares stock edit renderers');
      const nativeTraffic = traffic(stock);
      assert.ok(nativeExpanded.nativeRenderCalls.edit > 0, 'stock Ctrl+O control visits the actual native renderer');
      assert.deepEqual(traffic(live), nativeTraffic, '7 actual calls/results and 8 provider contexts are identical');
      // Captures and traffic are detached; only the shared workspace must survive for replay.
      await stock.close();
      assert.deepEqual(persisted(wide), persisted(native), 'the renderer never changes persisted diff/proposal/error bytes');
      const sessionBytes = readFileSync(wide.session);
      await live.resize(140, 160); const split = await preparedCapture(live, 'split'); await check(split, true);
      await live.resize(141, 160); await check(await preparedCapture(live, 'split-odd'), true);
      await live.command('/tidy-ui-theme light'); await check(await preparedCapture(live, 'split-light'), true, 'light-fullscreen');
      await live.command('/tidy-ui-theme gruvbox-dark-hard'); await check(await preparedCapture(live, 'split-gruvbox'), true, 'gruvbox-fullscreen');
      await live.resize(24, 160); const narrow = await preparedCapture(live, 'narrow');
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      await live.resize(100, 160); await live.command('/tidy-ui-theme dark');
      const unified = await preparedCapture(live, 'unified-again'); await check(unified, false);
      assert.equal(unified.nativeRenderCalls.edit ?? 0, 0, 'resize/theme changes do not reinstate native visibility work');
      assert.deepEqual(toolLines(unified), toolLines(wide), 'resize/theme round trip retains complete code and styling');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      for (const index of [0, 1, 4, 5, 6]) assert.deepEqual(expanded.tools[index].lines, wide.tools[index].lines,
        'Ctrl+O keeps each successful owned full card unchanged');
      for (const index of [2, 3]) {
        const details = lines(expanded.tools[index]).join('\n');
        assert.match(details, /Could not find|ENOENT/);
        assert.doesNotMatch(details, /Original file content:|Requested replacement:|Tool error:|NONEXISTENT_EDIT|FAILURE_PROPOSAL/u,
          'failed edit output retains the saved error without either proposed edit side');
      }
      assert.equal(expanded.nativeRenderCalls.edit ?? 0, 0, 'owned Ctrl+O expansion does not invoke the stock renderer');
      live.send('\x0f'); await live.settle();
      const successful = await preparedCapture(live, 'before-successful-click');
      const successY = successful.screen.findIndex((row) => row.includes('← Edited edit-example.ts') && row.includes('┃'));
      assert.ok(successY >= 0);
      live.send(`\x1b[<0;8;${successY + 1}M\x1b[<0;8;${successY + 1}m`); await live.settle();
      const successClicked = await live.capture('successful-click');
      assert.equal(successClicked.tools[0].expanded, false, 'a completed owned-card click changes only its file view, not Pi expansion state');
      assert.equal(successClicked.tools[1].expanded, false);
      assert.match(lines(successClicked.tools[0]).join('\n'), /← Edit edit-example\.ts/);
      assert.doesNotMatch(lines(successClicked.tools[0]).join('\n'), /← Edited edit-example\.ts|const context17 =/);
      const previewY = successClicked.screen.findIndex(row => row.includes('← Edit edit-example.ts') && row.includes('┃'));
      assert.ok(previewY >= 0, 'the collapsed preview remains a real panel click target');
      live.send(`\x1b[<0;8;${previewY + 1}M\x1b[<0;8;${previewY + 1}m`); await live.settle();
      const successFull = await preparedCapture(live, 'successful-click-full');
      assert.equal(successFull.tools[0].expanded, false);
      assert.deepEqual(successFull.tools[0].lines, wide.tools[0].lines, 'the same card can return to its complete owned presentation');
      assert.equal(successFull.nativeRenderCalls.edit ?? 0, 0, 'both click directions remain on the owned renderer');
      live.send('\x0f'); await live.settle(); live.send('\x0f'); await live.settle();
      const failed = await preparedCapture(live, 'before-failed-click');
      const failedRows = lines(failed.tools[2]);
      const y = failed.screen.map(plain).findIndex((row, index) => row === failedRows[0] && failedRows.every((value, offset) => plain(failed.screen[index + offset] ?? '') === value));
      assert.ok(y >= 0);
      live.send(`\x1b[<0;8;${y + 1}M\x1b[<0;8;${y + 1}m`); await live.settle();
      const clicked = await live.capture('failed-click'); assert.equal(clicked.tools[2].expanded, false);
      assert.match(lines(clicked.tools[2]).join('\n'), /Could not find|ENOENT/,
        'the owned full detail shows the saved error after a deliberate click');
      assert.equal(clicked.nativeRenderCalls.edit ?? 0, 0, 'opening a failed owned detail does not materialize native renderers');
      // Ctrl+O is still the host's global expansion toggle.
      live.send('\x0f'); await live.settle(); live.send('\x0f'); await live.settle();
      const beforeOff = deferredNativePreparation(live);
      assert.deepEqual(beforeOff.attempts.filter(event => event.epoch === liveProbeEpoch), [], 'all resize, palette, click, failed-detail and expansion transitions remain stock-preparation free immediately before Off');
      await live.appearance(false); assert.deepEqual(toolLines(await live.capture('off')), toolLines(native));
      const offPreparations = deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch && event.tool === 'edit');
      assert.ok(offPreparations.some(event => event.slot === 'call') && offPreparations.some(event => event.slot === 'result'), 'Appearance Off positively observes stock edit call and result materialization');
      const offAttemptCount = deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch).length;
      await live.appearance(true); await checkPreview(await preparedCapture(live, 'on'), 'on');
      assert.equal(deferredNativePreparation(live).attempts.filter(event => event.epoch === liveProbeEpoch).length, offAttemptCount, 'native-to-owned recovery adds no stock edit materialization');
      const starts = live.events().filter((event) => event.type === 'start').length;
      const probesBeforeReload = deferredNativePreparation(live).probes.length;
      await live.command('/reload'); await live.event('start', starts + 1); const reloaded = await preparedCapture(live, 'reload'); await checkPreview(reloaded, 'reload');
      const reloadProbe = deferredNativePreparation(live);
      assert.ok(reloadProbe.probes.length > probesBeforeReload, 'reload installs the observer in the new extension graph');
      const reloadEpoch = reloadProbe.probes.at(-1).epoch;
      assert.deepEqual(reloadProbe.attempts.filter(event => event.epoch === reloadEpoch), [], 'custom edit reload does not prepare stock callbacks during construction or presentation');
      await live.appearance(false);
      const reloadOff = await live.capture('reload-off');
      const reloadOffPreparations = deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch && event.tool === 'edit');
      assert.ok(reloadOffPreparations.some(event => event.slot === 'call') && reloadOffPreparations.some(event => event.slot === 'result'), 'reloaded extension graph positively observes both native stock edit callbacks');
      const nativeReloadTerminal = await start('reload-native-control', { tidyUi: false, session: wide.session, workspace: live.work });
      const nativeReload = await nativeReloadTerminal.capture('native-reload-control');
      await nativeReloadTerminal.close();
      assert.deepEqual(reloadOff.tools.map(tool => tool.expanded), nativeReload.tools.map(tool => tool.expanded), 'reload Off and stock replay have the same Pi expansion state');
      const failedEdits = reloadOff.tools.map((tool, index) => tool.name === 'edit' && tool.isError ? index : -1).filter(index => index >= 0);
      assert.ok(failedEdits.length > 0);
      assert.ok(failedEdits.every(index => reloadOff.tools[index].argsComplete === false && nativeReload.tools[index].argsComplete === false),
        'both restored-history controls retain Pi argsComplete=false, so stock edit preflight is not forced');
      assert.ok(native.tools.filter(tool => tool.name === 'edit' && tool.isError).every(tool => tool.argsComplete === true),
        'the live error control has Pi argsComplete=true, distinguishing its native preflight phase');
      assert.deepEqual(toolLines(reloadOff), toolLines(nativeReload), 'the reloaded Off graph preserves exact native edit rows and ANSI colors for identical saved history');
      const reloadOffAttemptCount = deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch).length;
      await live.appearance(true);
      const reloadOn = await preparedCapture(live, 'reload-on'); await checkPreview(reloadOn, 'reload-on');
      assert.equal(deferredNativePreparation(live).attempts.filter(event => event.epoch === reloadEpoch).length, reloadOffAttemptCount, 'reloaded graph returns to the custom view without new stock callbacks');
       const warmStats = await live.cacheSnapshot(); const warm = await preparedCapture(live, 'warm');
       const warmAgainStats = await live.cacheSnapshot(); const warmAgain = await preparedCapture(live, 'warm-again');
       assert.equal(warmAgainStats.builds, warmStats.builds, 'warm CLI frames do not rebuild/re-highlight edit layouts');
       for (const frame of [warm, warmAgain]) assert.equal(frame.nativeRenderCalls.edit ?? 0, reloadOn.nativeRenderCalls.edit ?? 0,
         'both warm observations add exactly zero host tool-component renders after same-epoch native-to-owned recovery');
      assert.deepEqual(traffic(live), nativeTraffic); assert.deepEqual(readFileSync(wide.session), sessionBytes);
      await live.close();
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`edit-replay-${mode}`, { tidyUi: true, session: wide.session, workspace: stock.work, mode });
        const replayProbe = deferredNativePreparation(replay);
        assert.ok(replayProbe.probes.length > 0, `${mode} replay installs the same-graph native observer`);
        const replayEpoch = replayProbe.probes.at(-1).epoch;
        const preview = await preparedCapture(replay, 'replayed-preview'); await checkPreview(preview, `dark-${mode}`);
        assert.deepEqual(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch), [], `${mode} restored preview stays cold`);
        replay.send('\x0f'); await replay.settle();
        const resumed = await preparedCapture(replay, 'replayed-full'); await check(resumed, false, `dark-${mode}`, true);
        await replayColors(resumed, wide, true); assert.deepEqual(persisted(resumed), persisted(wide));
        const htmlBlock = resumed.tools[4].lines.map(plain), htmlStart = replayBlockStart(resumed, htmlBlock);
        const codeRow = htmlBlock.findIndex(line => /^\s*┃\s+\d+ [ +\-] /.test(line));
        const from = /^\s*┃\s+\d+ [ +\-] /.exec(htmlBlock[codeRow])[0].length;
        const codeColumn = from + htmlBlock[codeRow].slice(from).search(/\S/);
        assert.ok(codeColumn >= from && resumed.cells[htmlStart + codeRow][codeColumn].text.trim(), 'negative code controls mutate an actual visible source glyph');
        for (const [column, field] of [[codeColumn, 'fg'], [codeColumn, 'bg'], [1, 'fg']]) {
          const damaged = { ...resumed, cells: resumed.cells.slice() }, y = htmlStart + codeRow;
          damaged.cells[y] = resumed.cells[y].slice();
          damaged.cells[y][column] = { ...resumed.cells[y][column], [field]: resumed.cells[y][column][field] ^ 1 };
          await assert.rejects(() => replayColors(damaged, wide, true), `comparison detects ${field} corruption at column ${column}`);
        }
        assert.equal(resumed.nativeRenderCalls.edit ?? 0, 0, `${mode} replay uses the native-free custom path`);
        assert.deepEqual(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch), [], `${mode} restored full cards remain stock-preparation free`);
        assert.deepEqual(toolLines(await preparedCapture(replay, 'replayed-warm')), toolLines(resumed), 'warm replay does not replace the accepted exact fallback');
        let finalPaletteCapture;
        for (const theme of ['light', 'gruvbox-dark-hard']) {
          await replay.command(`/tidy-ui-theme ${theme}`);
          const changed = await preparedCapture(replay, `palette-${theme}`);
          await check(changed, false, `${theme === 'light' ? 'light' : 'gruvbox'}-${mode}`, true);
          assert.deepEqual(persisted(changed), persisted(wide), 'palette changes leave source/session data intact');
          finalPaletteCapture = changed;
        }
        const stockReplay = await start(`edit-stock-replay-${mode}`, { tidyUi: false, session: wide.session, workspace: stock.work, mode });
        await stockReplay.command('/tidy-ui-theme gruvbox-dark-hard');
        stockReplay.send('\x0f'); await stockReplay.settle();
        const stockReplayFull = await stockReplay.capture('replayed-native-full');
        await stockReplay.close();
        const beforeReplayOff = deferredNativePreparation(replay);
        assert.deepEqual(beforeReplayOff.attempts.filter(event => event.epoch === replayEpoch), [], `${mode} replay color/layout updates remain stock-preparation free before Off`);
        await replay.appearance(false);
        const replayOff = await replay.capture('replayed-off');
        assert.deepEqual(replayOff.tools.map(tool => tool.expanded), stockReplayFull.tools.map(tool => tool.expanded),
          `${mode} replay Off and pure Pi replay have the same expansion state`);
        assert.deepEqual(toolLines(replayOff), toolLines(stockReplayFull),
          `${mode} replay Off preserves exact styled native rows against the same-session, same-theme pure Pi replay`);
        const replayOffPreparations = deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch && event.tool === 'edit');
        assert.ok(replayOffPreparations.some(event => event.slot === 'call') && replayOffPreparations.some(event => event.slot === 'result'), `${mode} replay Off positively materializes both stock edit callbacks`);
        const replayOffAttemptCount = deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch).length;
        await replay.appearance(true);
        const replayOn = await preparedCapture(replay, 'replayed-on'); await check(replayOn, false, `gruvbox-${mode}`, true);
        assert.deepEqual(toolLines(replayOn), toolLines(finalPaletteCapture), `${mode} replay returns to the same expanded full card after native Off`);
        assert.equal(deferredNativePreparation(replay).attempts.filter(event => event.epoch === replayEpoch).length, replayOffAttemptCount, `${mode} replay returns to owned mode without new stock callbacks`);
        await replay.close();
        assert.equal(replay.closed, true, 'the completed replay bridge is reaped before the next independent mode');
      }
      // Native live calls have an async preview; native replay does not recompute it.
      // Compare the explicit override with unpatched Pi replaying the identical session.
      const stockReplay = await start('edit-stock-replay', { session: wide.session, workspace: stock.work });
      const nativeReplayed = await stockReplay.capture('native-replay');
      await stockReplay.close();
      const optedOut = await start('edit-native-override', { tidyUi: true, session: wide.session, workspace: stock.work, flags: ['--tidy-ui-card', 'edit'] });
      assert.deepEqual(toolLines(await optedOut.capture('native-override')), toolLines(nativeReplayed));
      await optedOut.close();
      const compactEdit = await start('edit-compact-override', { tidyUi: true, session: wide.session, workspace: stock.work, flags: ['--tidy-ui-compact', 'edit'] });
      for (const tool of (await compactEdit.capture('compact-override')).tools) compactContent(tool);
      writeFileSync(join(artifacts, 'edit-coverage.json'), JSON.stringify({ calls: 7, results: 7, modelContexts: 8,
        oneSidedUnified: ['addition-only', 'removal-only'],
        checkedSyntaxCells, checkedPanelCells, widths: [24, 100, 140, 141], modes: ['fullscreen', 'regular'], themes: ['dark', 'light', 'gruvbox-dark-hard'],
        format: 'Ordinary compact edit while arguments stream/execute; wholly error-colored failed summaries; final successes use Bash-aligned Edited diff cards with context3 and symmetric padding',
        identity: 'exact traffic, persisted metadata and unchanged session bytes',
        cache: 'zero extra warm-frame builds; no alternate-width diagnostic probes',
        nativeWork: 'zero native edit renders while custom (pending/running/failure/success/resize/theme/replay); stock/expanded controls are positive',
        reloadNativeWork: { baseline: reloadOn.nativeRenderCalls.edit ?? 0, warm: warm.nativeRenderCalls.edit ?? 0,
          warmAgain: warmAgain.nativeRenderCalls.edit ?? 0, added: (warmAgain.nativeRenderCalls.edit ?? 0) - (reloadOn.nativeRenderCalls.edit ?? 0) },
        acceptedFallback: 'cold HTML may retain exact Pi mdCodeBlock foreground before lazy grammar readiness; only source foreground differs, no glyph/background/font/gutter/session/model deviation',
        scope: 'actual built-in edit; no installed AFT execution or pixel-perfect OpenCode screenshot claim' }, null, 2));
    } finally {
      reference.dispose();
      await closeTerminals(terminals.reverse());
    }
  });

test('real CLI: minified edit keeps linear ANSI size, warm work, exact traffic and replay',
  { timeout: 180000 }, async () => {
    const before = 'x+=1;'.repeat(3200), after = 'x+=1;'.repeat(3199) + 'x+=2;';
    const terminals = [], snapshots = [];
    // Each source glyph or geometric padding cell can carry one complete style,
    // independently of how many SGR fragments the renderer actually emits.
    const completePair = compileStyleAnsi({ foreground: { kind: 'rgb', r: 255, g: 255, b: 255 },
      background: { kind: 'rgb', r: 255, g: 255, b: 255 }, attributes: 15 }, 'truecolor');
    const maxPair = completePair.open.length + completePair.close.length;
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { extraEnv: { TIDY_UI_TEST_EDIT_PERFORMANCE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const traffic = (terminal) => {
      const events = terminal.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type));
      for (const [type, count] of [['call', 2], ['result', 2], ['model_context', 3]])
        assert.equal(events.filter((event) => event.type === type).length, count);
      assert.deepEqual(events.find(event => event.type === 'call' && event.name === 'edit').input.edits,
        [{ oldText: before, newText: after }], 'real edit changes only the final digit of the full 16000-character line');
      return events;
    };
    const check = (dump, stacked = true) => {
      assert.equal(dump.tools.length, 2); assert.equal(dump.extensionIssues.length, 0);
      const edit = dump.tools[0], rows = lines(edit);
      assert.ok(rows.some((row) => row.includes('← Edited edit-minified.ts')));
      const sourceUnits = edit.details.patch.length;
      const chars = edit.lines.reduce((sum, row) => sum + row.length, 0);
      const geometry = cardGeometry(dump.width), gutter = 5;
      const pane = stacked ? geometry.contentWidth : Math.floor((geometry.contentWidth - 3) / 2);
      const rowBound = 4 + Math.ceil(before.length / (pane - gutter)) + Math.ceil(after.length / (pane - gutter));
      const envelope = (before.length + after.length + rowBound * dump.width) * (maxPair + 1);
      assert.ok(chars <= envelope, `${chars} rendered units exceed independently funded glyph/style envelope ${envelope}`);
      if (stacked) {
        const old = rows.findIndex((row) => /1 - x/.test(row)), next = rows.findIndex((row) => /1 \+ x/.test(row));
        assert.ok(old >= 0 && next > old);
        // `lines()` already removes right padding; skip only stripe/padding and the numbered gutter.
        const code = (section) => section.map((row) => row.slice(8)).join('');
        assert.equal(code(rows.slice(old, next)), before, 'every removed source character remains');
        assert.equal(code(rows.slice(next, -1)), after, 'every added source character remains');
      }
      assert.ok(dump.screen.some((row) => row.includes('x+=2;')), 'real terminal viewport contains the long diff');
      snapshots.push({ width: dump.width, sourceUnits, renderedUnits: chars, rows: rows.length, envelope });
      return chars;
    };
    const observe = async (terminal, name) => {
      const stats = await terminal.cacheSnapshot();
      const dump = await terminal.capture(`pointer-minified-${name}`);
      assert.ok(stats);
      assert.equal('limitBytes' in stats, false, 'component-owned diffs have no admission or byte limit');
      assert.equal(stats.byKind.edit.entries, 1, 'memory is attributed to the rendered edit representation');
      assert.equal(stats.cards.entries, 1, 'the actual minified diff is retained in the card pool');
      return { dump, stats };
    };
    try {
      const stock = await start('minified-stock'); await stock.run('edit-performance');
      const native = await stock.capture('native-minified');
      const live = await start('minified-live', { tidyUi: true, workspace: stock.work }); await live.run('edit-performance');
      const wide = await live.capture('pointer-minified-wide'); check(wide);
      const nativeTraffic = traffic(stock);
      assert.deepEqual(traffic(live), nativeTraffic); assert.deepEqual(persisted(wide), persisted(native));
      await stock.close();
      const bytes = readFileSync(wide.session);
      const warm = await observe(live, 'warm'); check(warm.dump);
      const again = await observe(live, 'again'); check(again.dump);
      assert.equal(again.stats.builds, warm.stats.builds, 'unchanged real frames do no custom rebuilds');
      assert.equal(again.stats.cards.entries, 1); assert.equal(again.stats.cards.retainedBytes, warm.stats.cards.retainedBytes,
        'unchanged minified body remains retained with no admission-limit exception');
      for (const width of [140, 100]) {
        await live.resize(width); check(await live.capture(`pointer-minified-width-${width}`), width <= 120);
      }
      await live.command('/tidy-ui-theme light'); check(await live.capture('pointer-minified-light'));
      await live.command('/tidy-ui-theme dark'); const dark = await live.capture('pointer-minified-dark'); check(dark);
      const expected = await referenceCell(dark.summaryStyles.syntaxNumber);
      const neutral = await referenceCell(dark.summaryStyles.toolOutput);
      // This offline presentation fixture uses Pi's bounded fallback, not native syntax.
      const prefix = dark.tools[0].lines.find(row => plain(row).includes('1 - x+=1;'));
      assert.ok(prefix, 'the actual removed-source prefix is present');
      const prefixNumber = plain(prefix).indexOf('x+=1;') + 3;
      const reference = new Terminal({ cols: dark.width, rows: 2, allowProposedApi: true });
      try {
        await new Promise((done) => reference.write(prefix, done));
        const cell = reference.buffer.active.getLine(0).getCell(prefixNumber);
        assert.equal(cell.getChars(), '1');
        assert.equal(cell.getFgColor(), expected.fg, 'the actual card prefix retains Pi syntax foreground');
        assert.equal(cell.getFgColorMode(), expected.fgMode);
      } finally { reference.dispose(); }
      const suffixRow = dark.tools[0].lines.findLast(row => plain(row).includes('x+=2;'));
      assert.ok(suffixRow, 'the edit retains its complete changed suffix');
      const suffixY = dark.screen.findIndex(row => plain(row).trimEnd() === plain(suffixRow).trimEnd());
      assert.ok(suffixY >= 0, 'the edit card suffix itself is physically visible, not just the following read result');
      const suffixX = dark.screen[suffixY].indexOf('x+=2;') + 3, suffix = dark.cells[suffixY][suffixX];
      assert.equal(suffix.text, '2');
      assert.equal(suffix.fg, neutral.fg, 'text beyond the 8 KiB Pi prefix remains visible in neutral foreground');
      assert.equal(suffix.fgMode, neutral.fgMode);
      assert.deepEqual(traffic(live), nativeTraffic); assert.deepEqual(readFileSync(wide.session), bytes);
      await live.close();
      for (const mode of ['fullscreen', 'regular']) {
        const replay = await start(`minified-replay-${mode}`, { tidyUi: true, session: wide.session, workspace: stock.work, mode });
        const preview = await replay.capture('pointer-minified-preview');
        assert.match(lines(preview.tools[0]).join('\n'), /← Edit edit-minified\.ts/);
        assert.doesNotMatch(lines(preview.tools[0]).join('\n'), /← Edited edit-minified\.ts/);
        replay.send('\x0f'); await replay.settle();
        await replay.settle();
        const resumed = await replay.capture('pointer-minified-replayed'); check(resumed);
        assert.deepEqual(resumed.tools[0].lines, wide.tools[0].lines, 'global expansion restores the exact complete minified edit card');
        assert.deepEqual(persisted(resumed), persisted(wide));
        assert.equal(replay.events().filter((event) => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
        await replay.close();
        assert.equal(replay.closed, true, 'the completed replay bridge is reaped before the next independent mode');
      }
      writeFileSync(join(artifacts, 'edit-performance-coverage.json'), JSON.stringify({ calls: 2, results: 2, modelContexts: 3,
        componentOwnedRetention: true, warmBuildsBefore: warm.stats.builds, warmBuildsAfter: again.stats.builds,
        snapshots, workload: 'one changed digit; complete 16000-character old and new lines',
        identity: 'exact traffic, persisted metadata, session bytes and regular/fullscreen replay',
        scope: 'actual built-in edit/read; no cache policy change, truncation or timing threshold' }, null, 2));
    } finally { await closeTerminals(terminals.reverse()); }
  });
