import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntaxStockReferences, assertSyntaxStockReference } from '../fixtures/syntax-stock-reference.mjs';

const evidence = (mode = 'fullscreen') => ({
  traffic: [
    { type: 'call', name: 'bash', input: { command: 'echo exact\n' } },
    { type: 'result', name: 'bash', result: { content: [{ type: 'text', text: 'exact\n' }] } },
    { type: 'model_context', messages: [{ role: 'user', content: 'run syntax-cards' }] },
  ],
  persisted: [
    { name: 'bash', arguments: { command: 'echo exact\n' } },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'exact\n' }], details: undefined, isError: false },
  ],
  output: `/artifacts/stock-${mode}`,
});

test('syntax stock reference is lazy and executes one factory per mode for pending and later consumers', async () => {
  const calls = [], release = new Map();
  const reference = createSyntaxStockReferences(mode => {
    calls.push(mode);
    return new Promise(resolve => release.set(mode, () => resolve(evidence(mode))));
  });
  assert.deepEqual(calls, []);
  const fullscreen = reference('fullscreen'), repeated = reference('fullscreen'), regular = reference('regular');
  assert.equal(fullscreen, repeated);
  assert.notEqual(fullscreen, regular);
  await Promise.resolve();
  assert.deepEqual(calls, ['fullscreen', 'regular']);
  release.get('regular')();
  assert.deepEqual(await regular, evidence('regular'), 'a different key does not wait for fullscreen');
  release.get('fullscreen')();
  const saved = await fullscreen;
  assert.deepEqual(saved, evidence());
  assert.equal(await reference('fullscreen'), saved);
  assert.equal(await reference('regular'), await regular);
  assert.deepEqual(calls, ['fullscreen', 'regular']);
});

test('syntax stock reference retains only detached deeply immutable exact evidence and artifact location', async () => {
  const produced = { ...evidence(), terminal: { live: true } };
  const reference = await createSyntaxStockReferences(() => produced)('fullscreen');
  assert.deepEqual(Object.keys(reference), ['traffic', 'persisted', 'output']);
  assert.notEqual(reference.traffic, produced.traffic);
  assert.equal(Object.hasOwn(reference.persisted[1], 'details'), true, 'undefined fields are preserved, not JSON-normalized');
  for (const mutate of [
    () => { reference.output = '/other'; },
    () => reference.traffic.push({ type: 'call' }),
    () => { reference.traffic[0].input.command = 'corrupted'; },
    () => { reference.traffic[1].result.content[0].text = 'corrupted'; },
    () => { reference.traffic[2].messages[0].content = 'corrupted'; },
    () => { reference.persisted[0].arguments.command = 'corrupted'; },
    () => { reference.persisted[1].content[0].text = 'corrupted'; },
  ]) assert.throws(mutate, TypeError);
  produced.traffic[0].input.command = 'producer changed';
  produced.persisted[1].content[0].text = 'producer changed';
  assertSyntaxStockReference(reference, evidence());
});

for (const [field, corrupt] of [
  ['call arguments', actual => { actual.traffic[0].input.command += ' '; }],
  ['result', actual => { actual.traffic[1].result.content[0].text += ' '; }],
  ['model context', actual => { actual.traffic[2].messages[0].content += ' '; }],
  ['persisted arguments', actual => { actual.persisted[0].arguments.command += ' '; }],
  ['persisted result', actual => { actual.persisted[1].content[0].text += ' '; }],
]) test(`syntax stock comparison rejects corrupted ${field} without normalization`, async () => {
  const reference = await createSyntaxStockReferences(() => evidence())('fullscreen'), actual = evidence();
  assertSyntaxStockReference(reference, actual);
  corrupt(actual);
  assert.throws(() => assertSyntaxStockReference(reference, actual), { code: 'ERR_ASSERTION' });
});

test('syntax stock reference can be constructed by a focused consumer with no earlier caller', async () => {
  let executions = 0;
  const reference = createSyntaxStockReferences(mode => { executions++; return evidence(mode); });
  assertSyntaxStockReference(await reference('regular'), evidence('regular'));
  assert.equal(executions, 1);
});
