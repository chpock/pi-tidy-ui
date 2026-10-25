import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPreparations, completedPreparations } from '../fixtures/card-preparation.mjs';

const update = (call, key) => ({ type: 'card_preparation', call, tool: 'edit', phase: 'updated', update: key, sourceEligible: true });
const prepared = (call, key, outcomes = ['pi']) => ({ ...update(call, key), phase: 'prepared', applied: true, refused: 0, publication: 4, outcomes });

test('preparation signal: wait for completion of each selected actual input, not earlier successful work', () => {
  const events = [update('a', 'old'), prepared('a', 'old'), update('a', 'new'), update('b', 'b1')];
  const selection = selectPreparations(events, { tool: 'edit', count: 2 });
  assert.equal(completedPreparations(events, selection), undefined);
  events.push(prepared('a', 'new'));
  assert.equal(completedPreparations(events, selection), undefined);
  events.push(prepared('b', 'b1'));
  assert.deepEqual(completedPreparations(events, selection).map(event => event.call), ['a', 'b']);
});

test('preparation signal: a changed input cancels the selected operation instead of following it', () => {
  const events = [update('a', 'a1')], selection = selectPreparations(events, { tool: 'edit', count: 1 });
  events.push(update('a', 'a2'), prepared('a', 'a2'));
  assert.throws(() => completedPreparations(events, selection), /changed during capture/);
});

test('preparation signal: native waiting is not Pi completion and a refusal is a failure', () => {
  const events = [update('a', 'a1')], selection = selectPreparations(events, { tool: 'edit', count: 1 });
  events.push(prepared('a', 'a1', ['waiting']));
  assert.equal(completedPreparations(events, selection), undefined);
  events.push(prepared('a', 'a1', ['refused']));
  assert.throws(() => completedPreparations(events, selection), /refused/);
  events.push({ ...prepared('a', 'a1'), applied: false });
  assert.throws(() => completedPreparations(events, selection), /paint application failed/);
});

test('preparation signal: service-only updates reuse completed work and failed tools are not source targets', () => {
  const events = [update('a', 'a1'), prepared('a', 'a1'), update('a', 'a1'), { ...update('failed', 'f1'), sourceEligible: false }];
  const selection = selectPreparations(events, { tool: 'edit', count: 1 });
  assert.equal(completedPreparations(events, selection).length, 1);
  assert.throws(() => selectPreparations(events, { tool: 'edit', count: 2 }), /Expected 2/);
});

for (const outcomes of [[], ['pi']]) test(`preparation signal rejects skipped source admissions even with admitted outcomes ${JSON.stringify(outcomes)}`, () => {
  const events = [update('a', 'one'), { ...prepared('a', 'one', outcomes), refused: 1 }];
  const selection = selectPreparations(events, { tool: 'edit', count: 1 });
  assert.throws(() => completedPreparations(events, selection), /source admission refused/);
});
