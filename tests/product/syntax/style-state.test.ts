import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStyle, styleFaultCause, type StyleAttempt } from '../../../src/highlighting/style-state.ts';

test('STYLE opportunity separates deterministic denial, temporary failure and actual route replacement', () => {
  for (const cause of ['local', 'refused'] as const) {
    const attempt = { provider: 1, cause };
    assert.deepEqual(nextStyle(attempt, true, 2, 180000), { kind: 'refused' });
    assert.deepEqual(nextStyle(attempt, false, 2, 180000), { kind: 'refused' });
  }
  const route: StyleAttempt = { provider: 1, cause: 'route' };
  assert.deepEqual(nextStyle(route, true, 1, 0), { kind: 'refused' });
  assert.deepEqual(nextStyle(route, false, 2, 0), { kind: 'provider' });
  assert.deepEqual(nextStyle(route, true, 2, 0), { kind: 'resolve' });
  assert.deepEqual(nextStyle({ provider: 1, cause: 'withdrawn' }, true, 1, 0), { kind: 'resolve' });
});

test('STYLE generic delay is absolute across provider change and never delays useful service recovery', () => {
  const attempt: StyleAttempt = { provider: 1, cause: 'retry', retryAt: 65000 };
  assert.deepEqual(nextStyle(attempt, true, 1, 64999), { kind: 'delayed', at: 65000 });
  assert.deepEqual(nextStyle(attempt, true, 2, 64999), { kind: 'delayed', at: 65000 });
  assert.deepEqual(nextStyle(attempt, false, 2, 35000), { kind: 'provider' });
  assert.deepEqual(nextStyle(attempt, true, 2, 65000), { kind: 'resolve' });
  assert.equal(attempt.retryAt, 65000);
});

test('STYLE unclassified failure implies neither a timer nor a permanent input refusal', () => {
  const attempt: StyleAttempt = { provider: 1, cause: 'other' };
  assert.deepEqual(nextStyle(attempt, true, 1, 180000), { kind: 'refused' });
  assert.deepEqual(nextStyle(attempt, false, 2, 180000), { kind: 'refused' });
  assert.deepEqual(nextStyle(attempt, true, 2, 180000), { kind: 'resolve' });
  assert.deepEqual(nextStyle(undefined, false, 1, 0), { kind: 'provider' });
  assert.deepEqual(nextStyle(undefined, true, 1, 0), { kind: 'resolve' });
});

test('STYLE native causes use producer dispositions, not code suffixes or diagnostic severity', () => {
  for (const code of ['busy', 'queue_expired']) {
    assert.equal(styleFaultCause(code, 'not_started'), 'retry');
    assert.equal(styleFaultCause(code, 'started'), 'other');
  }
  assert.equal(styleFaultCause('data_limit', 'not_started'), 'refused');
  assert.equal(styleFaultCause('data_limit', 'started'), 'retry');
  for (const execution of ['not_started', 'started'] as const) {
    assert.equal(styleFaultCause('worker_gone', execution), 'route');
    assert.equal(styleFaultCause('invalid_rules', execution), 'refused');
    assert.equal(styleFaultCause('context_limit', execution), 'refused');
    assert.equal(styleFaultCause('style_limit', execution), 'refused');
    assert.equal(styleFaultCause('future_limit', execution), 'other');
  }
});
