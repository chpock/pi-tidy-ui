import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { PiTerminal, artifacts, plain, lines, assertFits, toolLines } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { compactContent, errorSummaryColors, mouseAt, persisted, referenceCell } from '../../fixtures/main-cli-support.mjs';

const failures = [
  { name: 'read', args: { path: 'missing.txt' }, title: '→ Read missing.txt', marker: 'ENOENT', forbidden: [] },
  { name: 'write', args: { path: 'write-directory', content: 'FILE_ERROR_WRITE_PROPOSAL' },
    title: '← Write write-directory', marker: 'EISDIR', forbidden: ['FILE_ERROR_WRITE_PROPOSAL'] },
  { name: 'edit', args: { path: 'missing-edit.ts', edits: [{ oldText: 'FILE_ERROR_OLD_TEXT', newText: 'FILE_ERROR_NEW_TEXT' }] },
    title: '← Edit missing-edit.ts', marker: 'ENOENT', forbidden: ['FILE_ERROR_OLD_TEXT', 'FILE_ERROR_NEW_TEXT'] },
];
const errorFooter = '[error: tool call failed]';
const normalize = value => value.replace(/\s/gu, '');
const textContent = tool => tool.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const visibleContent = (rows, width) => rows.map(row => row.slice(3, width - 2)).join('');

function assertTextRole(glyphs, text, expected, label) {
  const target = normalize(text), flattened = glyphs.map(glyph => glyph.text).join('');
  const start = normalize(flattened).indexOf(target);
  assert.ok(start >= 0, `${label} is present in the physical panel content`);
  for (let index = 0; index < target.length; index++) {
    const actual = glyphs[start + index];
    assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim },
      { fg: expected.fg, fgMode: expected.fgMode, dim: expected.dim },
      `${label} glyph ${index} uses its public theme role`);
  }
}

async function assertErrorPanel(dump, tool, failure) {
  assert.equal(tool.isError, true);
  assert.deepEqual(tool.args, failure.args, `${failure.name} retains exact original arguments`);
  const rows = lines(tool).map(plain), error = textContent(tool), content = visibleContent(rows, dump.width);
  assert.ok(error.length > 0, `${failure.name} has a saved text error`);
  assert.ok(normalize(content).includes(normalize(error)), `${failure.name} displays the complete saved error text`);
  assert.ok(normalize(content).includes(normalize(failure.title)), `${failure.name} uses the expected file title and path`);
  assert.ok(normalize(content).includes(normalize(errorFooter)), `${failure.name} has the separate failed-call status`);
  assert.ok(normalize(content).includes(failure.marker), `${failure.name} error detail remains visible`);
  assert.doesNotMatch(rows.join('\n'), /Tool error:|Requested file content:|Original file content:|Requested replacement:/u,
    'failed details do not expose proposed content or either edit side');
  for (const secret of failure.forbidden) assert.ok(!rows.join('').includes(secret), `${failure.name} hides ${secret}`);
  await assertFits(tool.lines, dump.width);

  const physical = dump.screen.map(plain);
  const start = physical.findIndex((row, y) => row === rows[0] && rows.every((expected, offset) => physical[y + offset] === expected));
  assert.ok(start >= 0, `${failure.name} full panel is present on the physical screen at width ${dump.width}`);
  const top = rows.findIndex(row => row[1] === '┃'), bottom = rows.findLastIndex(row => row[1] === '┃');
  assert.ok(top >= 0 && bottom > top, `${failure.name} has a complete bordered panel`);
  const panel = [], border = await referenceCell(dump.frameStyles.errorBorder), background = await referenceCell(dump.backgroundStyles.toolPendingBg);
  assert.notEqual(border.fgMode, 0, 'error-border reference is a visible foreground color');
  for (let offset = top; offset <= bottom; offset++) {
    const y = start + offset;
    for (let x = 0; x < dump.width; x++) {
      const cell = dump.cells[y][x];
      if (x === 1) {
        assert.equal(cell.text, '┃');
        assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
          { fg: border.fg, fgMode: border.fgMode, dim: border.dim }, 'left stripe uses the public error-border role');
        assert.equal(cell.bgMode, 0);
      } else if (x === 0 || x === dump.width - 1) {
        assert.ok(cell.text === '' || cell.text === ' ', `exterior column ${x} is blank`);
        assert.equal(cell.bgMode, 0, 'exterior columns stay outside the neutral panel');
      } else {
        assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode },
          { bg: background.bg, bgMode: background.bgMode }, 'panel interior uses the shared neutral background');
        if (x === 2 || x === dump.width - 2) assert.equal(cell.text, ' ', 'one inside padding cell remains on each side');
        if (offset === top || offset === bottom) assert.equal(cell.text, ' ', 'panel top/bottom retain full-width padding');
      }
    }
    for (let x = 3; x < dump.width - 2; x++) {
      const cell = dump.cells[y][x];
      if (cell.text.trim()) panel.push({ text: cell.text, fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim });
    }
  }
  assert.equal(physical[start + top - 1], '', 'one transcript separator precedes the panel');

  const output = await referenceCell(dump.summaryStyles.toolOutput);
  const muted = await referenceCell(dump.summaryStyles.muted);
  const errorRole = await referenceCell(dump.summaryStyles.error);
  assert.notEqual(errorRole.fgMode, 0, 'failed-call status uses a visible error foreground');
  assertTextRole(panel, failure.title, muted, 'muted file heading/path');
  assertTextRole(panel, error, output, 'saved error body');
  assertTextRole(panel, errorFooter, errorRole, 'failed-call footer');
}

function observedEvents(terminal) {
  return terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
}

function failedTools(dump) {
  return failures.map(failure => {
    const tool = dump.tools.find(item => item.name === failure.name && item.args.path === failure.args.path);
    assert.ok(tool, `saved ${failure.name} failure is present`);
    return tool;
  });
}

async function assertCollapsed(dump) {
  const tools = failedTools(dump);
  assert.ok(tools.every(tool => tool.expanded === false), 'collapsed failures use Pi compact state');
  for (const tool of tools) {
    compactContent(tool);
    await errorSummaryColors(dump, tool);
    assert.ok(!normalize(lines(tool).map(plain).join('')).includes('[error:toolcallfailed]'),
      'collapsed failures remain ordinary compact summaries without the expanded footer');
  }
  assert.doesNotMatch(dump.screen.join('\n'), /ENOENT|EISDIR|FILE_ERROR_WRITE_PROPOSAL|FILE_ERROR_OLD_TEXT|FILE_ERROR_NEW_TEXT/u,
    'collapsed failures hide saved error bodies and proposed arguments');
  return tools;
}

test('real CLI: expanded final read/write/edit errors use neutral physical panels without exposing proposals', { timeout: 180000 }, async () => {
  const terminals = [];
  const start = async (name, options = {}) => {
    const terminal = new PiTerminal(`file-errors-${name}`, { tidyUi: true, ...options });
    terminals.push(terminal); await terminal.ready(); await terminal.resize(80, 180); return terminal;
  };
  try {
    const live = await start('fullscreen-live');
    await live.run('file-errors');
    const compact = await live.capture('compact'), originalEvents = observedEvents(live);
    assert.equal(originalEvents.filter(event => event.type === 'call').length, 3);
    assert.equal(originalEvents.filter(event => event.type === 'result').length, 3);
    assert.equal(originalEvents.filter(event => event.type === 'model_context').length, 4);
    assert.deepEqual(originalEvents.filter(event => event.type === 'call').map(event => ({ name: event.name, input: event.input })),
      failures.map(({ name, args }) => ({ name, input: args })), 'the real provider invoked the exact failing built-in calls');
    assert.deepEqual(originalEvents.filter(event => event.type === 'result').map(event => event.isError), [true, true, true]);
    await assertCollapsed(compact);
    const saved = persisted(compact), sessionBytes = readFileSync(compact.session);

    live.send('\x0f'); await live.settle();
    let expanded = await live.capture('expanded');
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    assert.deepEqual(persisted(expanded), saved, 'expansion changes only rendering, not saved arguments/results');

    await live.resize(24, 180);
    const narrow = await live.capture('expanded-24');
    for (const [index, tool] of failedTools(narrow).entries()) await assertErrorPanel(narrow, tool, failures[index]);
    assert.deepEqual(persisted(narrow), saved);
    await live.resize(80, 180);

    for (const failure of failures) {
      const current = await live.capture(`before-click-${failure.name}`);
      const tool = current.tools.find(item => item.name === failure.name && item.args.path === failure.args.path);
      assert.ok(tool);
      await mouseAt(live, current, failure.title);
      const clicked = await live.capture(`click-collapse-${failure.name}`);
      const collapsedTool = clicked.tools.find(item => item.name === failure.name && item.args.path === failure.args.path);
      assert.equal(collapsedTool.expanded, false, `${failure.name} panel click collapses the selected native tool result`);
      compactContent(collapsedTool);
      expanded = clicked;
    }
    await assertCollapsed(expanded);
    // Per-component clicks leave Pi's global expanded flag unchanged.
    live.send('\x0f'); await live.settle();
    await assertCollapsed(await live.capture('global-collapse-after-clicks'));
    live.send('\x0f'); await live.settle();
    expanded = await live.capture('click-reopened');
    assert.ok(failedTools(expanded).every(tool => tool.expanded === true));
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    live.send('\x0f'); await live.settle();
    await assertCollapsed(await live.capture('recollapsed'));
    live.send('\x0f'); await live.settle();
    expanded = await live.capture('reopened');
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    assert.deepEqual(persisted(expanded), saved);
    assert.deepEqual(observedEvents(live), originalEvents, 'expansion, collapse and reopen perform no further tool or model work');
    assert.deepEqual(readFileSync(compact.session), sessionBytes, 'UI-only transitions do not rewrite the session');
    const session = compact.session, workspace = live.work;
    await live.close();

    const native = await start('regular-native', { mode: 'regular', session, workspace, tidyUi: false });
    native.send('\x0f'); await native.settle();
    const nativeExpanded = await native.capture('native-expanded');
    assert.ok(failedTools(nativeExpanded).every(tool => tool.expanded === true), 'Pi native control captures expanded failures');
    await native.close();

    const replay = await start('regular-replay', { mode: 'regular', session, workspace });
    const replayCompact = await replay.capture('regular-compact');
    await assertCollapsed(replayCompact);
    assert.deepEqual(persisted(replayCompact), saved);
    replay.send('\x0f'); await replay.settle();
    expanded = await replay.capture('regular-expanded');
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    await replay.resize(24, 180);
    const regularNarrow = await replay.capture('regular-expanded-24');
    for (const [index, tool] of failedTools(regularNarrow).entries()) await assertErrorPanel(regularNarrow, tool, failures[index]);
    replay.send('\x0f'); await replay.settle(); await assertCollapsed(await replay.capture('regular-recollapsed'));
    replay.send('\x0f'); await replay.settle();
    expanded = await replay.capture('regular-reopened');
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    assert.deepEqual(persisted(expanded), saved);
    await replay.resize(80, 180);
    assert.deepEqual(observedEvents(replay), [], 'same-session replay and error expansion execute no tools or model requests');

    await replay.appearance(false);
    const off = await replay.capture('regular-off');
    assert.deepEqual(toolLines(off), toolLines(nativeExpanded), 'Appearance Off matches Pi native rendering for the same saved failures');
    await replay.appearance(true);
    expanded = await replay.capture('regular-on-again');
    for (const [index, tool] of failedTools(expanded).entries()) await assertErrorPanel(expanded, tool, failures[index]);
    assert.deepEqual(persisted(expanded), saved);
    assert.deepEqual(readFileSync(session), sessionBytes, 'replay leaves the saved session byte-for-byte unchanged');

    await replay.close();
    assert.equal(replay.closed, true);
    writeFileSync(join(artifacts, 'file-errors-coverage.json'), JSON.stringify({
      calls: 3, results: 3, modelContexts: 4, failures: failures.map(({ name }) => name), widths: [24, 80],
      modes: ['fullscreen execution', 'regular native control and zero-execution replay'],
      lifecycle: ['compact', 'Ctrl+O expand/collapse/reopen', 'fullscreen panel click', 'Appearance Off native parity'],

      identity: 'exact arguments/results, unchanged saved session bytes, no replayed tools or provider requests',
    }, null, 2));
  } finally { await closeTerminals(terminals.reverse()); }
});
