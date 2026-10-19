import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { CONTROLLER_LIMITS } from '../../../src/occipital/controller-limits.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';

const vocabulary = 'a'.repeat(64);

test('style capture admission: two tiny owners fit the unchanged two-job byte authority', () => {
  const root = new SemanticRetentionPool();
  const captures: NonNullable<ReturnType<SemanticRetentionPool['captureDisplays']>['group']>[] = [];
  try {
    for (const key of ['a', 'b']) {
      const admitted = root.admit(key, 1, 'x');
      assert.equal(admitted.accepted, true);
      const generation = admitted.generation!;
      const chunk: SemanticChunk = { key, generation, source_version: 1, revision: 1,
        vocabulary, source_bytes: 1, replace_from: 0, committed_bytes: 1, complete: true,
        contexts: [Uint32Array.of(1)], runs: Uint32Array.of(1, 1),
        counters: { committed_line_calls: 1, committed_line_bytes: 1, tail_calls: 0, tail_bytes: 0 } };
      assert.equal(root.installChunk(generation, chunk).accepted, true);
      const result = root.captureDisplays([generation], () => true);
      assert.equal(result.accepted, true);
      captures.push(result.group!);
    }
    const captureOnlyBytes = captures.reduce((sum, value) => sum + value.reservationBytes, 0);
    // This is a necessary lower bound: it excludes encoded frames, expanded
    // style responses and all other physical-job storage, not a mocked permit.
    assert.ok(captureOnlyBytes <= CONTROLLER_LIMITS.transientBytes,
      `capture-only liability ${captureOnlyBytes} exceeds two-job authority ${CONTROLLER_LIMITS.transientBytes}`);
  } finally {
    for (const capture of captures) capture.release();
    root.dispose();
    assert.equal(root.stats().retainedBytes, 0);
  }
});
