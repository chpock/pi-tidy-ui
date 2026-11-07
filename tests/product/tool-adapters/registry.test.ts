import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureToolCall, createToolReader } from '../../../src/tool-adapters/registry.ts';
import { piFileAdapter } from '../../../src/tool-adapters/pi/file.ts';
import { piBashReader } from '../../../src/tool-adapters/pi/bash.ts';
import { aftBashReader } from '../../../src/tool-adapters/aft/bash.ts';
import type { SavedToolResult } from '../../../src/tool-adapters/contracts.ts';

function call(name: string, args: Record<string, unknown>, result?: SavedToolResult) {
  return captureToolCall({ name, id: 'adapter-contract', args, result, expanded: false,
    partial: false, executionStarted: true, argsComplete: true });
}

test('a different tool name can reuse the read presentation and full-read construction accounting', () => {
  const result = { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] };
  const aliases = [{ ...piFileAdapter('read'), names: ['read_file'] }];
  const reader = createToolReader(call('read_file', { path: 'file.ts' }, result), aliases);
  assert.equal(reader.kind, 'read');
  if (reader.kind !== 'read') return;
  const stock = createToolReader(call('read', { path: 'file.ts' }, result));
  assert.equal(stock.kind, 'read');
  if (stock.kind !== 'read') return;
  assert.equal(reader.estimateBytes({ mode: 'full' }), stock.estimateBytes({ mode: 'full' }));
  assert.deepEqual(reader.prepareFile('full')?.view.lines, stock.prepareFile('full')?.view.lines);
  assert.equal(createToolReader(call('read', { path: 'file.ts' }, result), aliases).kind, 'other');
});

test('full read construction includes the separators between saved text parts without joining for the estimate', () => {
  const args = { path: 'file.ts' };
  const multipart = createToolReader(call('read', args, { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }));
  const joined = createToolReader(call('read', args, { content: [{ type: 'text', text: 'first\nsecond' }] }));
  assert.equal(multipart.kind, 'read'); assert.equal(joined.kind, 'read');
  if (multipart.kind !== 'read' || joined.kind !== 'read') return;
  assert.equal(multipart.estimateBytes({ mode: 'full' }), joined.estimateBytes({ mode: 'full' }));
});

test('binding a collapsed read or estimating a write preview does not inspect result text bodies', () => {
  let reads = 0;
  const result = { content: [{ type: 'text', get text() { reads++; return 'UNRELATED_RESULT'; } }] };
  const read = createToolReader(call('read', { path: 'file.ts' }, result));
  assert.equal(read.kind, 'read');
  if (read.kind !== 'read') return;
  read.source('preview'); read.summaryArgs();
  const write = createToolReader(call('write', { path: 'file.ts', content: 'CODE' }, result));
  assert.equal(write.kind, 'write');
  if (write.kind !== 'write') return;
  write.estimateBytes({ mode: 'preview' });
  assert.equal(reads, 0);
});

test('full read identity observes same-object text changes and ignores invalid AFT metadata changes', () => {
  const args = { path: 'file.ts' }, result = { content: [{ type: 'text', text: 'ORIGINAL' }], details: { start_line: -1 } };
  const before = createToolReader(call('read', args, result));
  assert.equal(before.kind, 'read');
  if (before.kind !== 'read') return;
  const identity = before.source('full');
  result.details.start_line = -2;
  const unchanged = createToolReader(call('read', args, result));
  assert.equal(unchanged.kind, 'read');
  if (unchanged.kind !== 'read') return;
  assert.deepEqual(unchanged.source('full'), identity);
  result.content[0].text = 'REPLACEMENT';
  const changed = createToolReader(call('read', args, result));
  assert.equal(changed.kind, 'read');
  if (changed.kind !== 'read') return;
  assert.notDeepEqual(changed.source('full'), identity);
});


test('binding and command identity do not read the saved command output body', () => {
  let reads = 0;
  const result = { content: [{ type: 'text', get text() { reads++; return 'BODY_CONTROL'; } }] };
  const reader = createToolReader(call('bash', { command: 'echo stable' }, result));
  assert.equal(reader.kind, 'bash');
  if (reader.kind !== 'bash') return;
  reader.source(); reader.summaryArgs(); reader.directory('/project'); reader.hasCommand();
  assert.equal(reads, 0, 'candidate selection must not scan markers in output');
  assert.ok(reader.prepareService(undefined).output.includes('BODY_CONTROL'));
  assert.ok(reads > 0, 'actual service decoding is a positive control for the getter');
});

test('compatible result decoding keeps plain command evidence and construction accounting unchanged', () => {
  for (const isError of [false, true]) for (const partial of [false, true])
    for (const argsComplete of [false, true]) for (const executionStarted of [false, true]) for (const role of [undefined, 'toolResult']) {
      const snapshot = { ...call('bash', { command: 'echo stable' }, { content: [{ type: 'text', text: '\nBODY\r\n' }], isError, role }),
        partial, argsComplete, executionStarted };
      const pi = piBashReader(snapshot), compatible = aftBashReader(snapshot);
      assert.deepEqual(compatible.source(), pi.source());
      assert.deepEqual(compatible.service('/project'), pi.service('/project'));
      assert.equal(compatible.estimateBytes({ directory: '/project', language: 'bash' }), pi.estimateBytes({ directory: '/project', language: 'bash' }));
      assert.equal(compatible.directory('/project'), pi.directory('/project'));
      assert.equal(compatible.failurePhase(), pi.failurePhase());
      for (const live of [false, true]) assert.equal(compatible.isComplete(live), pi.isComplete(live));
      assert.deepEqual(compatible.prepareService('/project'), pi.prepareService('/project'));
    }
});
