import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Text } from '@earendil-works/pi-tui';
import { toolAdapters } from '../../../src/tool-adapters/registry.ts';
import { piFileAdapter } from '../../../src/tool-adapters/pi/file.ts';
import { piBashAdapter } from '../../../src/tool-adapters/pi/bash.ts';
import { plain, resolvePublicFileToolDefinition, setup } from '../../fixtures/sdk-contract-support.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);

test('actual SDK supports differently named adapters without changing foreign callback ownership', async () => {
  const initial = toolAdapters.length;
  const aliases = [
    { ...piFileAdapter('read'), names: ['lookup_saved_text'] },
    { ...piFileAdapter('write'), names: ['save_supplied_text'] },
    { ...piFileAdapter('edit'), names: ['change_saved_text'] },
    { ...piBashAdapter, names: ['execute_shell_command'] },
  ];
  Reflect.apply(Array.prototype.push, toolAdapters, aliases);
  try {
    for (const [index, kind] of ['read', 'write', 'edit', 'bash'].entries()) {
      const name = aliases[index]!.names[0]!;
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
  } finally { Reflect.apply(Array.prototype.splice, toolAdapters, [initial]); }
});
