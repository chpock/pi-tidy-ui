import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Tool, plain } from '../../fixtures/sdk-contract-support.ts';
import { summaryConsumer } from '../../fixtures/summary-consumer.ts';
import { withCompletionMarkers } from '../../fixtures/source-policy-variant.ts';

test('compact summary consumer preserves shipped status and spinner policy', () => {
  const tool = new Tool(), consumer = summaryConsumer(tool);
  try {
    assert.deepEqual(consumer.render(80), [' → read a.txt']);
    consumer.updateResult({ isError: true, content: [{ type: 'text', text: 'ERROR_BODY_SENTINEL' }] });
    assert.deepEqual(consumer.render(80).map(plain), [' → read a.txt']);
    assert.doesNotMatch(consumer.render(80).join(''), /ERROR_BODY_SENTINEL|✓|✗/u);
    assert.deepEqual(consumer.render(5), [' →']);
    consumer.updateResult(undefined);
    assert.deepEqual(consumer.render(5), [' ⠋']);
    assert.doesNotMatch(consumer.render(80).join(''), /…/u);
    tool.executionStarted = false; consumer.invalidate();
    assert.deepEqual(consumer.render(5), [' →']);
  } finally { consumer.dispose(); }
});

test('a glyph-only summary does not inspect the saved format', () => {
  const tool = new Tool('read', { path: 'current.ts' });
  let formatReads = 0;
  tool.isPartial = true; tool.executionStarted = false;
  tool.result = { content: [], get details() { formatReads++; return {}; } };
  const consumer = summaryConsumer(tool);
  try {
    assert.deepEqual(consumer.render(5).map(plain), [' →']);
    assert.equal(formatReads, 0);
    assert.deepEqual(consumer.render(80).map(plain), [' → read current.ts']);
    assert.ok(formatReads > 0, 'the wider summary obtains arguments from the compatible reader');
  } finally { consumer.dispose(); }
});

test('completion marker constant can restore success and failure symbols without error-body previews', async () => {
  await withCompletionMarkers(({ ToolSummaryPresenter }) => {
    const tool = new Tool(), consumer = summaryConsumer(tool, ToolSummaryPresenter);
    try {
      assert.deepEqual(consumer.render(80), [' → read a.txt ✓']);
      consumer.updateResult({ isError: true, content: [{ type: 'text', text: 'ERROR_BODY_SENTINEL' }] });
      assert.equal(plain(consumer.render(80).at(-1)!), ' → read a.txt ✗');
      assert.doesNotMatch(consumer.render(80).join(''), /ERROR_BODY_SENTINEL/u);
      assert.deepEqual(consumer.render(5), [' ✗']);
      consumer.updateResult({ content: [] }); assert.deepEqual(consumer.render(5), [' ✓']);
      consumer.updateResult(undefined);
      assert.deepEqual(consumer.render(5), [' ⠋']);
      assert.match(plain(consumer.render(80).at(-1)!), /…$/u);
      tool.executionStarted = false; consumer.invalidate(); assert.deepEqual(consumer.render(5), [' …']);
    } finally { consumer.dispose(); }
  });
});
