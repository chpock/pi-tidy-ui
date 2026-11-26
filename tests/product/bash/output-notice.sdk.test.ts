import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bashBody } from '../../helpers/bash-body.ts';
import { bashTool, setup } from '../../fixtures/sdk-contract-support.ts';

const pathStatus = 'Full output: /tmp/pi-bash-output.log';
const errorStatus = 'Could not save the full output: fixture write failed';
const trailer = (message: string) => `[Showing lines 401-2400 of 2400. ${message}]`;

test('Bash shows saved full-output status outside the preview without counting it as output or changing the result', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  const output = Array.from({ length: 11 }, (_, index) => `body-${index}`);
  try {
    for (const [details, message] of [
      [{ fullOutputPath: '/tmp/pi-bash-output.log' }, pathStatus],
      [{ fullOutputError: 'fixture write failed' }, errorStatus],
    ] as const) {
      for (const rows of [output, ['short output']]) {
        const result = { content: [{ type: 'text', text: `${rows.join('\n')}\n\n${trailer(message)}` }],
          details: { truncation: { truncated: true }, ...details }, isError: false };
        const original = structuredClone(result);
        tool.updateResult(result, false);
        tool.setExpanded(false);
        assert.deepEqual(bashBody(tool, 120), ['$ run', '', ...rows.slice(0, 10), ...(rows.length > 10 ? ['… (Click to expand)'] : []), '', trailer(message)]);
        tool.setExpanded(true);
        assert.deepEqual(bashBody(tool, 120), ['$ run', '', ...rows, '', trailer(message)]);
        assert.deepEqual(result, original);
      }
    }
  } finally { controller.restore(); }
});

test('Bash keeps literal status text and does not promote it without typed final truncation details', () => {
  const tool = bashTool('run'), { controller } = setup([tool]);
  try {
    const text = `output\n\n${trailer(errorStatus)}\n\n${trailer(errorStatus)}\n\nCommand exited with code 7`;
    const content = [{ type: 'text', text }];
    const valid = { truncation: { truncated: true }, fullOutputError: 'fixture write failed' };
    for (const [details, partial] of [[undefined, false], [{ ...valid, truncation: { truncated: 'true' } }, false], [valid, true]] as const) {
      tool.updateResult({ content, details }, partial);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, 120), ['$ run', '', 'output', '', trailer(errorStatus), '', trailer(errorStatus), '', 'Command exited with code 7']);
    }
    tool.updateResult({ content, details: valid, isError: true }, false);
    assert.deepEqual(bashBody(tool, 120), ['$ run', '', 'output', '', trailer(errorStatus), '', 'Command exited with code 7', '', trailer(errorStatus), '', '[error: execution failed]']);
    for (const heading of ['Showing lines 401-2400 of 2400 (50.0KB limit)', 'Showing last 50.0KB of line 3 (line is 52.0KB)']) {
      const notice = `[${heading}. ${errorStatus}]`;
      tool.updateResult({ content: [{ type: 'text', text: `body\n\n${notice}` }], details: valid }, false);
      tool.setExpanded(false);
      assert.deepEqual(bashBody(tool, 120), ['$ run', '', 'body', '', notice]);
    }
    tool.updateResult({ content: [{ type: 'text', text: 'replacement' }], details: { ...valid, fullOutputError: 'different write failure' } }, false);
    assert.ok(bashBody(tool, 120).includes('[Could not save the full output: different write failure]'));
    tool.updateResult({ content: [{ type: 'text', text: 'replacement' }] }, false);
    assert.deepEqual(bashBody(tool, 120), ['$ run', '', 'replacement']);
  } finally { controller.restore(); }
});
