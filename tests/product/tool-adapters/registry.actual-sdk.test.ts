import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Text } from '@earendil-works/pi-tui';
import { installTestToolNames } from '../../fixtures/tool-adapters/reader-fixture.ts';
import { plain, resolvePublicFileToolDefinition, setup } from '../../fixtures/sdk-contract-support.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);

test('actual SDK supports differently named adapters without changing foreign callback ownership', async t => {
  const aliases = { lookup_saved_text: 'read', save_supplied_text: 'write', change_saved_text: 'edit', execute_shell_command: 'bash' } as const;
  installTestToolNames(t, aliases);
  for (const [name, kind] of Object.entries(aliases)) {
    const args = { path: 'alias.ts', content: 'const ALIAS_SOURCE = 1;', command: 'echo ALIAS_COMMAND' };
    const saved = { role: 'toolResult', content: [{ type: 'text', text: 'SAVED_ALIAS_RESULT' }],
      ...(kind === 'edit' ? { details: { diff: '-1 const BEFORE = 0;\n+1 const AFTER = 1;' } } : {}) };
    const foreign = { renderCall: () => new Text('FOREIGN_CALL', 0, 0), renderResult: () => new Text('FOREIGN_RESULT', 0, 0) };
    const { root, controller } = setup();
    try {
      const stock = new ToolExecutionComponent(kind, `stock-${kind}`, structuredClone(args), undefined,
        resolvePublicFileToolDefinition(kind, undefined, '/tmp'), root, '/tmp');
      const alias = new ToolExecutionComponent(name, `alias-${kind}`, structuredClone(args), undefined, foreign, root, '/tmp');
      for (const node of [stock, alias]) {
        node.markExecutionStarted(); node.updateResult(structuredClone(saved), false); node.setExpanded(true);
      }
      root.addChild(stock);
      stock.render(80); await turn();
      const expected: string[] = stock.render(80).map(plain);
      root.removeChild(stock); root.addChild(alias);
      alias.render(80); await turn();
      const actual: string[] = alias.render(80).map(plain);
      assert.ok(actual.some(row => row.includes('┃')), `${name} renders a real SDK card`);
      assert.deepEqual(actual, expected);
      assert.equal(alias.getCallRenderer() === foreign.renderCall, true);
      assert.equal(alias.getResultRenderer() === foreign.renderResult, true);
      alias.setExpanded(false);
      const collapsed = alias.render(80).map(plain).join('\n');
      if (kind === 'read') {
        assert.match(collapsed, /lookup_saved_text/);
        assert.doesNotMatch(collapsed, /SAVED_ALIAS_RESULT|┃/);
      } else assert.match(collapsed, /┃/);
      alias.setExpanded(true);
      alias.render(80); await turn();
      assert.deepEqual(alias.render(80).map(plain), expected);
      assert.deepEqual(alias.args, args); assert.deepEqual(alias.result, saved);
    } finally { controller.restore(); }
  }
});

test('an unregistered tool with a saved patch keeps its compact summary and expands to its own Pi renderer', () => {
  const { root, controller } = setup();
  const args = { path: 'external.ts', edits: [] };
  const saved = { content: [{ type: 'text', text: 'EXTERNAL_CONTENT' }], details: { patch: '@@ -1 +1 @@\n-NOT_OUR_OLD\n+NOT_OUR_NEW' } };
  const foreign = { renderCall: () => new Text('EXTERNAL_CALL', 0, 0), renderResult: () => new Text('EXTERNAL_NATIVE_RESULT', 0, 0) };
  try {
    const node = new ToolExecutionComponent('external_patch', 'external-1', args, undefined, foreign, root, '/tmp');
    node.markExecutionStarted(); node.updateResult(saved, false); root.addChild(node);
    const rows = () => node.render(80).map(plain).join('\n');
    assert.match(rows(), /external_patch.*external\.ts/);
    assert.doesNotMatch(rows(), /NOT_OUR_|EXTERNAL_NATIVE_RESULT|┃/);
    node.setExpanded(true);
    assert.match(rows(), /EXTERNAL_NATIVE_RESULT/);
    assert.doesNotMatch(rows(), /NOT_OUR_|┃/);
    assert.equal(node.getResultRenderer() === foreign.renderResult, true);
  } finally { controller.restore(); }
});

test('a malformed argument update uses native rows without disabling other tool presentations', () => {
  const { root, controller } = setup();
  const foreign = { renderCall: () => new Text('NATIVE_CALL', 0, 0), renderResult: () => new Text('NATIVE_RESULT', 0, 0) };
  try {
    for (const name of ['read', 'external_patch']) {
      const node = new ToolExecutionComponent(name, name, { path: 'before.ts' }, undefined, foreign, root, '/tmp');
      node.markExecutionStarted(); node.updateResult({ content: [{ type: 'text', text: 'SAVED_RESULT' }] }, false); root.addChild(node);
      for (const invalid of [null, []]) {
        node.updateArgs(invalid);
        assert.match(node.render(80).map(plain).join('\n'), /NATIVE_RESULT/, name);
        assert.equal(controller.active, true);
      }
      node.updateArgs({ path: 'after.ts' });
      assert.match(node.render(80).map(plain).join('\n'), /after\.ts/, name);
      root.removeChild(node);
    }
  } finally { controller.restore(); }
});
