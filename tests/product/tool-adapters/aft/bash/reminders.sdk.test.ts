import "../../../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CardTheme } from "../../../../../src/card-theme.ts";
import { bashBody } from "../../../../helpers/bash-body.ts";
import { hasHostInk } from "../../../../fixtures/host-cells.ts";
import { cardInputTheme, Root, bashTool, installTidyUi, mouse, plain, setup } from "../../../../fixtures/sdk-contract-support.ts";

// Shapes follow AFT 0.59.0: raw-Bash repeat trailers and appended Pi tool_result text blocks.
const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;

test('bash reminders: final suffix groups follow the own footer in both AFT content shapes', () => {
  const tool = bashTool('false'), { controller } = setup([tool]);
  const first = reminder('Completed task A'), second = reminder('Still running B'), third = reminder('Pattern matched C');
  try {
    for (const texts of [
      [`BODY\n\n[exit code: 7]\n \t\n${first}`],
      ['BODY\n\n[exit code: 7]', first],
      ['BODY\n\n[exit code: 7]', `${first}\n${second}\n${third}`],
      [`BODY\n\n[exit code: 7]\n\n${first}`, second, third, '\n \t'],
      [`BODY\r\n\r\n[exit code: 7]\r\n\r\n\x1b[31m${first.replace(/\n/g, '\r\n')}\x1b[0m\r\n`],
    ]) {
      const result = { content: texts.map(text => ({ type: 'text', text })), details: { exit_code: 7 } };
      const before = structuredClone(result);
      tool.updateResult(result); tool.setExpanded(true);
      const notices = texts.join('\n').includes(third) ? [first, second, third].join('\n') : first;
      assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'BODY', '', '[exit code: 7]', '', ...notices.split('\n')]);
      tool.setExpanded(false);
      assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'BODY', '', '[exit code: 7]', '', ...notices.split('\n')]);
      assert.deepEqual(tool.result, before);
    }
    tool.updateResult({ content: [{ type: 'text', text: `BODY\n\n[command timed out]\n[exit code: 124]\n\n${first}` }], details: { exit_code: 124 } });
    assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'BODY', '', '[exit code: 124; error: command timed out]', '', ...first.split('\n')]);
  } finally { controller.restore(); }
});

test('bash reminders: malformed, nested, nonterminal and cross-block tags stay ordinary output', () => {
  const root = new Root(), tool = bashTool('false'); root.addChild(tool);
  const fg: [string, string][] = [];
  const controller = installTidyUi(root, () => ({ fg: (role, text) => { fg.push([role, text]); return text; } }));
  const note = reminder('NOTICE');
  try {
    const cases = [
      [`BODY\n\n[exit code: 7]\n\n${note}\nAFTER`],
      [`BODY\n${note}`], // embedded open requires a blank separator
      ['BODY\n\n<system-reminder>\nUNCLOSED'],
      ['BODY\n\nMISSING OPEN\n</system-reminder>'],
      [`BODY\n\n<system-reminder>\n${note}\n</system-reminder>`],
      [`BODY\n\n<system-reminder>\nOUTER\n\n${note}`], // no inner-fragment salvage
      [`BODY\n\n${note}\n<system-reminder>\nUNCLOSED`],
      [`BODY\n\n ${note}`],
      [`BODY\n\n${note} `],
      ['BODY\n\n<system-reminder>\nNOTICE', '</system-reminder>'],
      ['BODY\n\n<system-reminder>', 'NOTICE\n</system-reminder>'],
    ];
    for (const texts of cases) {
      fg.length = 0; tool.setExpanded(true);
      tool.updateResult({ content: texts.map(text => ({ type: 'text', text })), details: { exit_code: 7 } });
      assert.deepEqual(bashBody(tool, 100), ['$ false', '', ...texts.join('\n').split('\n').map(row => row.trimEnd()), '', '[exit code: 7]']);
      assert.ok(!fg.some(([role]) => role === 'muted'), JSON.stringify(texts));
    }
  } finally { controller.restore(); }
});

test('bash reminders: detaching notices does not relax footer guards or interpret other AFT prose', () => {
  const tool = bashTool('run'), { controller } = setup([tool]), note = reminder('OTHER_TASK [exit code: 1]');
  try {
    const cases: [string, unknown, string][] = [
      ['BODY\n[exit code: 7]', 7, '[exit code: 7]'],
      ['BODY\n\n[exit code: 8]', 7, '[exit code: 7]'],
      ['BODY\n\n[exit code: 7]', '7', ''],
      ['BODY\n\n[exit code: 0]', 0, ''],
      ['BODY\n\n[exit code: 7]\nshown 10 of 20 lines (cap)', 7, '[exit code: 7]'],
      ['BODY\n\n[command timed out after 2s]\n[exit code: 124]', 124, '[exit code: 124]'],
      ['BODY\n[command timed out]\n[exit code: 124]', 124, '[exit code: 124]'],
      ['Background task started: xyz\n[truncated output; full output: /DO_NOT_READ]\n[aft: no column data]\nHint: use search', 0, ''],
    ];
    for (const [text, exit_code, footer] of cases) {
      tool.updateResult({ content: [{ type: 'text', text }, { type: 'text', text: note }], details: { exit_code } }); tool.setExpanded(true);
      const output = text.split('\n');
      assert.deepEqual(bashBody(tool, 100), ['$ run', '', ...output, ...(footer ? ['', footer] : []), '', ...note.split('\n')]);
    }
    tool.updateResult({ content: [{ type: 'text', text: `BODY\n\n[exit code: 7]\n\n[exit code: 7]\n\n${note}` }], details: { exit_code: 7 } });
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', 'BODY', '', '[exit code: 7]', '', '[exit code: 7]', '', ...note.split('\n')]);
  } finally { controller.restore(); }
});

test('bash reminders: muted role and other-task errors never determine the command status', async () => {
  const root = new Root(), tool = bashTool('true'); root.addChild(tool);
  const fg: [string, string][] = [], bg: string[] = [];
  const theme: CardTheme = { fg: (role, text) => { fg.push([role, text]); return text; }, bg: (role, text) => { bg.push(role); return text; } };
  const controller = installTidyUi(root, () => theme);
  const note = reminder('Failed background task\n    <system-reminder>\n    [exit code: 9]\n    </system-reminder>');
  try {
    tool.updateResult({ content: [{ type: 'text', text: 'OK' }, { type: 'text', text: note }], details: { exit_code: 0 } });
    assert.deepEqual(bashBody(tool, 100), ['$ true', '', 'OK', '', ...note.split('\n')]);
    for (const line of note.split('\n')) assert.equal(await hasHostInk(tool.render(100), cardInputTheme, 'muted', line), true);
    assert.equal(await hasHostInk(tool.render(100), cardInputTheme, 'error', '┃'), false);
    assert.equal(await hasHostInk(tool.render(100), cardInputTheme, 'borderMuted', '┃'), true);
    assert.deepEqual([fg.length, bg.length], [0, 0]);
    const warm = controller.cacheStats(); fg.length = 0;
    for (let i = 0; i < 100; i++) tool.render(100);
    assert.equal(controller.cacheStats().builds, warm.builds); assert.equal(fg.length, 0, 'warm frames do not parse, wrap or recolor');
    tool.updateResult({ content: [{ type: 'text', text: note }] });
    assert.deepEqual(bashBody(tool, 100), ['$ true', '', ...note.split('\n')], 'identical command-printed suffix follows the same display convention');
  } finally { controller.restore(); }
});

test('bash reminders: independent ten-row previews share expansion, including reminder-only cards', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  const rows = Array.from({ length: 11 }, (_, i) => `NOTICE_${i}`), note = reminder(rows.join('\n'));
  const output = Array.from({ length: 11 }, (_, i) => `OUTPUT_${i}`);
  try {
    for (const body of ['', output.join('\n') + '\n\n[exit code: 7]']) {
      tool.updateResult({ content: [{ type: 'text', text: body }, { type: 'text', text: note }], details: body ? { exit_code: 7 } : undefined });
      tool.setExpanded(false);
      const head = ['$ run', ...(body ? ['', ...output.slice(0, 10), '… (Click to expand)', '', '[exit code: 7]'] : [])];
      assert.deepEqual(bashBody(tool, 100), [...head, '', '<system-reminder>', ...rows.slice(0, 9), '… (Click to expand)']);
      const y = tool.render(100).map(plain).findIndex(row => row.includes('NOTICE_0'));
      assert.ok(tool.handleMouse(mouse(y, 100))?.handled);
      assert.deepEqual(bashBody(tool, 100), ['$ run', ...(body ? ['', ...output, '', '[exit code: 7]'] : []), '', ...note.split('\n')]);
      assert.ok(tool.handleMouse(mouse(y, 100))?.handled); assert.equal(tool.expanded, false);
    }
    for (const count of [8, 9]) {
      tool.updateResult({ content: [{ type: 'text', text: reminder(Array(count).fill('ROW').join('\n')) }] });
      tool.setExpanded(false); bashBody(tool, 100);
      assert.equal(!!tool.handleMouse(mouse(2, 100)), count === 9, 'opening and closing tags count toward visual preview');
    }
    tool.updateResult({ content: [{ type: 'text', text: reminder([...Array(8).fill('ROW'), '', 'HIDDEN'].join('\n')) }] });
    tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', '<system-reminder>', ...Array(8).fill('ROW'), '… (Click to expand)']);
  } finally { controller.restore(); }
});

test('bash reminders: partial snapshots remain ordinary until final and notice updates replace old text', async () => {
  const root = new Root(), tool = bashTool('false'); root.addChild(tool);
  const fg: [string, string][] = [];
  const input = { colors: { ...cardInputTheme.colors, muted: cardInputTheme.colors.error },
    getFgAnsi: (role: Parameters<typeof cardInputTheme.getFgAnsi>[0]) => cardInputTheme.getFgAnsi(role === 'muted' ? 'error' : role),
    getBgAnsi: (role: Parameters<typeof cardInputTheme.getBgAnsi>[0]) => cardInputTheme.getBgAnsi(role) };
  const controller = installTidyUi(root, () => ({ fg: (role, text) => { fg.push([role, text]); return text; } }),
    { piInput: () => ({ theme: input, mode: cardInputTheme.getColorMode() }) });
  const note = reminder('NOTICE'), result = { content: [{ type: 'text', text: `BODY\n\n[exit code: 7]\n\n${note}` }], details: { exit_code: 7 } };
  const before = structuredClone(result);
  try {
    tool.updateResult(result, true); tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ['$ false', '', ...result.content[0]!.text.split('\n')]);
    assert.equal(await hasHostInk(tool.render(100), cardInputTheme, 'error', 'NOTICE'), false);
    fg.length = 0; tool.updateResult(result);
    assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'BODY', '', '[exit code: 7]', '', ...note.split('\n')]);
    assert.equal(await hasHostInk(tool.render(100), cardInputTheme, 'error', 'NOTICE'), true); assert.deepEqual(result, before);
    tool.updateResult({ ...result, content: [{ type: 'text', text: 'NEW BODY' }, { type: 'text', text: reminder('NEW NOTICE') }] });
    assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'NEW BODY', '', '[exit code: 7]', '', ...reminder('NEW NOTICE').split('\n')]);
    tool.updateResult({ content: [{ type: 'text', text: 'NO NOTICE' }] });
    assert.deepEqual(bashBody(tool, 100), ['$ false', '', 'NO NOTICE']);
  } finally { controller.restore(); }
});

test('bash reminders: Unicode, tabs and narrow overflow retain panel geometry and original data', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  const result = { content: [{ type: 'text', text: reminder('👩‍💻é界\tTAIL\r\n\x1b]0;BAD\x07\x1b[31mSAFE\x1b[0m\u202e') }] };
  const before = structuredClone(result);
  try {
    tool.updateResult(result);
    for (let width = 0; width <= 40; width++) for (const expanded of [false, true]) {
      tool.setExpanded(expanded);
      for (const row of tool.render(width)) {
        assert.ok(visibleWidth(row) <= width); assert.doesNotMatch(plain(row), /BAD|\u202e/);
      }
    }
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', '<system-reminder>', '👩‍💻é界   TAIL', 'SAFE', '</system-reminder>']);
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test('bash reminders: joined normalization does not invent a timeout separator at a terminal CR', () => {
  const root = new Root(), tool = bashTool('run'); root.addChild(tool);
  const fg: [string, string][] = [], controller = installTidyUi(root, () => ({ fg: (role, text) => { fg.push([role, text]); return text; } }));
  try {
    for (const prefix of ['BODY\r', 'BODY\r\x1b[31m']) for (const notice of [false, true]) {
      const result = { content: [{ type: 'text', text: prefix }, { type: 'text', text: '[command timed out]\n[exit code: 124]' },
        ...(notice ? [{ type: 'text', text: reminder('NOTICE') }] : [])], details: { exit_code: 124 } };
      const before = structuredClone(result);
      tool.updateResult(result); tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, 100), ['$ run', '', 'BODY', '[command timed out]', '[exit code: 124]', '', '[exit code: 124]',
        ...(notice ? ['', ...reminder('NOTICE').split('\n')] : [])]);
      assert.deepEqual(tool.result, before);
    }
    tool.updateResult({ content: [{ type: 'text', text: 'HEAD\x1b]0;hidden' }, { type: 'text', text: 'more\x07\nVISIBLE' }] });
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', 'HEAD', 'VISIBLE'], 'a cross-part OSC must still be removed as one sequence');
    fg.length = 0;
    tool.updateResult({ content: [{ type: 'text', text: 'HEAD\x1b]0;hidden' }, { type: 'text', text: 'more\x07\nVISIBLE' }, { type: 'text', text: reminder('NOTICE') }] });
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', 'HEAD', 'VISIBLE', ...reminder('NOTICE').split('\n')]);
    assert.ok(!fg.some(([role]) => role === 'muted'), 'ambiguous normalization cannot manufacture trusted part boundaries');
    fg.length = 0;
    tool.updateResult({ content: [{ type: 'text', text: '<system-reminder>\x1b]0;hidden' }, { type: 'text', text: '\x07\nBODY\n</system-reminder>' }] });
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', '<system-reminder>', 'BODY', '</system-reminder>']);
    assert.ok(!fg.some(([role]) => role === 'muted'), 'an erased joining newline must not pair tags across parts even when normalized strings agree');
  } finally { controller.restore(); }
});
