import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { describeArgs } from '../../../src/index.ts';
import { toolAdapters } from '../../../src/tool-adapters/registry.ts';
import { piFileAdapter } from '../../../src/tool-adapters/pi/file.ts';
import { piBashAdapter } from '../../../src/tool-adapters/pi/bash.ts';
import { Tool, plain, setup } from '../../fixtures/sdk-contract-support.ts';

test('a static adapter entry connects a new name to shared cards, summaries, spacing and expansion', async () => {
  const initial = toolAdapters.length;
  const aliases = [
    { ...piFileAdapter('read'), names: ['lookup_text'] },
    { ...piFileAdapter('write'), names: ['save_text'] },
    { ...piFileAdapter('edit'), names: ['change_text'] },
    { ...piBashAdapter, names: ['run_command'] },
  ];
  Reflect.apply(Array.prototype.push, toolAdapters, aliases);
  try {
    for (const [index, kind] of ['read', 'write', 'edit', 'bash'].entries()) {
      const name = aliases[index]!.names[0]!;
      const args = { path: 'alias.ts', content: 'const SAVED_SOURCE = 1;', command: 'echo ALIAS_COMMAND' };
      const result = { content: [{ type: 'text', text: '1: LITERAL_SAVED_OUTPUT' }],
        ...(kind === 'edit' ? { details: { diff: '-1 const old = 1;\n+1 const next = 2;' } } : {}) };
      const stock = new Tool(kind, structuredClone(args)), alias = new Tool(name, structuredClone(args));
      stock.toolCallId = `stock-${kind}`; alias.toolCallId = `alias-${kind}`;
      stock.updateResult(structuredClone(result)); alias.updateResult(structuredClone(result));
      stock.setExpanded(true); alias.setExpanded(true);
      const prefix = new Tool('unadapted_neighbor', { query: 'NEIGHBOR' });
      const { root, controller } = setup([prefix, stock]);
      try {
        root.render(80); await turn();
        const expectedDocument = root.render(80).map(plain), expected = stock.render(80).map(plain);
        root.removeChild(stock); root.addChild(alias);
        root.render(80); await turn();
        const actualDocument = root.render(80).map(plain), actual = alias.render(80).map(plain);
        assert.ok(actual.some(row => row.includes('┃')), `${name} has an actual panel, not only a decoded source: ${actual.join('\n')}`);
        assert.deepEqual(actual, expected, `${name} uses the same shared geometry and saved text`);
        assert.deepEqual(actualDocument, expectedDocument, `${name} preserves its neighbor spacing`);
        if (kind === 'write' || kind === 'edit') assert.equal(describeArgs(name, args), 'alias.ts');
        if (kind === 'read') {
          alias.setExpanded(false);
          const compact = alias.render(80).map(plain).join('\n');
          assert.match(compact, /lookup_text/);
          assert.doesNotMatch(compact, /LITERAL_SAVED_OUTPUT|┃/);
          alias.setExpanded(true);
          assert.match(alias.render(80).map(plain).join('\n'), /LITERAL_SAVED_OUTPUT/);
        }
        assert.deepEqual(alias.args, args); assert.deepEqual(alias.result, result);
      } finally { controller.restore(); }
    }
  } finally { Reflect.apply(Array.prototype.splice, toolAdapters, [initial]); }
});
