import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notify } from '../../../src/notifications.ts';

for (const level of ['error', 'warning', 'info'] as const) test(`notifications: ${level} keeps the body, level and native receiver`, () => {
  const messages: { message: string; level?: string }[] = [];
  const ui = { notify(message: string, actualLevel?: 'error' | 'warning' | 'info') {
    assert.equal(this === ui, true, 'Pi notification methods retain their receiver');
    messages.push({ message, level: actualLevel });
  } };
  notify(ui, '  Message 界\nsecond line  ', level);
  assert.deepEqual(messages, [{ message: '[pi-tidy-ui]   Message 界\nsecond line  ', level }]);
});

test('notifications: no UI means no delivery, without adding a timer or fallback output', () => {
  assert.equal(notify(undefined, 'No current context', 'error'), undefined);
});

test('notifications: error handling remains the caller’s responsibility', () => {
  assert.throws(() => notify({ notify() { throw new Error('notification failed'); } }, 'Message', 'warning'), /notification failed/u);
});
