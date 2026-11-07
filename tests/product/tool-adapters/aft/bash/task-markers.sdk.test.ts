import "../../../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { bashBody } from "../../../../helpers/bash-body.ts";
import { bashTool, plain, setup } from "../../../../fixtures/sdk-contract-support.ts";

const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const aftTaskId = 'bash-443fe78c4d7f1e35';
const aftTaskLine = `[task ${aftTaskId}]`;

test('bash task markers: remove final own-task annotations before strict footer and reminder handling', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  const cases: [string[], number, string[]][] = [
    [[aftTaskLine], 0, []],
    [[`BODY\n${aftTaskLine}`], 0, ['BODY']],
    [[`BODY\n\n[exit code: 7]\n${aftTaskLine}`], 7, ['BODY', '', '[exit code: 7]']],
    [[`BODY\n\n[command timed out]\n[exit code: 124]\n${aftTaskLine}`], 124, ['BODY', '', '[exit code: 124; error: command timed out]']],
    [[`BODY\n\n[exit code: 7]\n${aftTaskLine}\n\n${reminder('NOTICE')}`], 7, ['BODY', '', '[exit code: 7]', '', ...reminder('NOTICE').split('\n')]],
    [[`BODY\n\n[exit code: 7]\n${aftTaskLine}`, reminder('NOTICE')], 7, ['BODY', '', '[exit code: 7]', '', ...reminder('NOTICE').split('\n')]],
    [[`BODY\r\n\r\n[command timed out]\r\n[exit code: 124]\r\n${aftTaskLine}\r\n`], 124, ['BODY', '', '[exit code: 124; error: command timed out]']],
    [[`BODY\n[task ${aftTaskId} (job 0192a64a-1234-7000-8000-000000000001)]`], 0, ['BODY']],
    [['BODY', aftTaskLine], 0, ['BODY']],
    [['BODY', `${aftTaskLine}\n[command timed out]\n[exit code: 124]`], 124, ['BODY', '[command timed out]', '[exit code: 124]', '', '[exit code: 124]']],
    [[`BODY\n${aftTaskLine}`, '[command timed out]\n[exit code: 124]'], 124, ['BODY', '[command timed out]', '[exit code: 124]', '', '[exit code: 124]']],
    [['BODY\r', `${aftTaskLine}\n[command timed out]\n[exit code: 124]`], 124, ['BODY', '[command timed out]', '[exit code: 124]', '', '[exit code: 124]']],
    [[`BODY\n${aftTaskLine}\n\n[exit code: 7]\n${aftTaskLine}`], 7, ['BODY', aftTaskLine, '', '[exit code: 7]']],
    [[`BODY\n[exit code: 7]\n${aftTaskLine}`], 7, ['BODY', '[exit code: 7]', '', '[exit code: 7]']],
    [[`BODY\n\n[exit code: 8]\n${aftTaskLine}`], 7, ['BODY', '', '[exit code: 8]', '', '[exit code: 7]']],
    [[`BODY\n\n[exit code: 7]\n${aftTaskLine}\nshown 10 of 20 lines (cap)`], 7, ['BODY', '', '[exit code: 7]', 'shown 10 of 20 lines (cap)', '', '[exit code: 7]']],
  ];
  try {
    for (const [parts, exit_code, body] of cases) {
      const result = { content: parts.map(text => ({ type: 'text', text })), details: { exit_code, task_id: aftTaskId } };
      const before = structuredClone(result); tool.updateResult(result);
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        assert.deepEqual(bashBody(tool, 160), ['$ run', ...(body.length ? ['', ...body] : [])], parts.join('\n'));
        assert.deepEqual(tool.result, before, 'display filtering must not rewrite model/session content');
      }
    }
  } finally { controller.restore(); }
});

test('bash task markers: preserve ordinary literals, partial output and unrelated metadata', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  const literals = [
    '[task bash-0000000000000000]', `[task ${aftTaskId} (job )]`, `[task ${aftTaskId} (job two words)]`,
    ` ${aftTaskLine}`, `${aftTaskLine} `, `prefix ${aftTaskLine}`, `${aftTaskLine} suffix`,
    `\x1b[31m${aftTaskLine}\x1b[0m`, '[task bash-short]', '[task bash-443fe78c4d7f1e35',
    `Background task started: ${aftTaskId}`,
  ];
  try {
    for (const text of literals) {
      tool.updateResult({ content: [{ type: 'text', text }], details: { task_id: aftTaskId, exit_code: 0 } });
      assert.deepEqual(bashBody(tool, 160), ['$ run', '', plain(text).trimEnd()], text);
    }
    for (const task_id of [undefined, null, 42, 'unrelated', 'bash-0000000000000000']) {
      tool.updateResult({ content: [{ type: 'text', text: aftTaskLine }], details: { task_id, exit_code: 0 } });
      assert.deepEqual(bashBody(tool, 160), ['$ run', '', aftTaskLine]);
    }
    tool.updateResult({ content: [{ type: 'text', text: aftTaskLine }], details: { task_id: aftTaskId, exit_code: 0 } }, true);
    assert.deepEqual(bashBody(tool, 160), ['$ run', '', aftTaskLine], 'streamed command output is not a terminal AFT annotation');
    tool.updateResult({ content: [{ type: 'text', text: '[task bash-' }, { type: 'text', text: '443fe78c4d7f1e35]' }], details: { task_id: aftTaskId } });
    assert.deepEqual(bashBody(tool, 160), ['$ run', '', '[task bash-', '443fe78c4d7f1e35]']);
  } finally { controller.restore(); }
});

test('bash task markers: filtering does not consume preview rows, add overflow or change native rendering', () => {
  const tool = bashTool('run'), rows = Array.from({ length: 10 }, (_, i) => `ROW_${i + 1}`);
  const result = { content: [{ type: 'text', text: [...rows, aftTaskLine].join('\n') }], details: { task_id: aftTaskId, exit_code: 0 } };
  tool.updateResult(result); const native = tool.render(100), { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', ...rows]);
    tool.setExpanded(true); assert.deepEqual(bashBody(tool, 100), ['$ run', '', ...rows]);
    tool.setExpanded(false);
    tool.updateResult({ ...result, content: [{ type: 'text', text: [...rows, aftTaskLine, 'shown 10 of 20 lines (cap)'].join('\n') }] });
    assert.deepEqual(bashBody(tool, 100), ['$ run', '', ...rows, '… (Click to expand)']);
    tool.setExpanded(true); assert.deepEqual(bashBody(tool, 100), ['$ run', '', ...rows, 'shown 10 of 20 lines (cap)']);
    tool.setExpanded(false); tool.updateResult(result);
    for (const width of [6, 12, 24, 100]) assert.ok(!tool.render(width).map(plain).join('\n').includes('443fe78c4d7f1e35'));
  } finally { controller.restore(); }
  assert.deepEqual(tool.render(100), native, 'Off returns the original raw native presentation');
});
