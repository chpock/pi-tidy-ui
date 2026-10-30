import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { syntheticSelection } from '../../fixtures/test-style-selection.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { awaitFixture } from '../../fixtures/await-fixture.ts';

const binary = validateNative(readInputs()).path;

test('actual v4 controller: local palette changes preserve parse checkpoints, finalization and lease cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-controller-'));
  const pipe = new StdioTransport({ command: binary, args: ['--stdio'], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root },
    requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const drain = () => awaitFixture((async () => { while (owner.stats().unsettledJobs || owner.stats().pendingCloses) { owner.flush(); await turn(); } })());
  try {
    await awaitFixture(broker.start());
    owner.setStyleSelection(syntheticSelection(1));
    const source = { key: 'bash', version: 1, language: 'bash', text: 'echo α\necho t', complete: false };
    assert.equal(owner.observe(source), true); owner.flush(); await drain();
    assert.equal(owner.status('bash')!.committedBytes, Buffer.byteLength('echo α\n'));
    assert.equal(owner.stats().committedLineCalls, 1); assert.equal(owner.stats().tailCalls, 1);
    const before = broker.stats().sourceDispatches;
    owner.setStyleSelection(syntheticSelection(2));
    const next = { ...source, version: 2, text: source.text + 'ail' };
    owner.observe(next); owner.observe({ ...next, version: 3, text: next.text + '\n' }); owner.flush(); await drain();
    assert.equal(owner.stats().committedLineCalls, 2, 'the first completed line was not parsed again');
    assert.equal(owner.stats().tailCalls, 1, 'the growing tail became a committed line');
    assert.equal(owner.stats().preparedBytes, Buffer.byteLength(source.text) + 4, 'only the four appended bytes crossed the source lane');
    owner.observe({ ...next, version: 3, text: next.text + '\n', complete: true }); owner.flush(); await drain();
    assert.equal(owner.stats().committedLineCalls, 2); assert.equal(owner.stats().tailCalls, 1);
    assert.equal(broker.stats().sourceDispatches, before + 2, 'append and finalization, not theme-induced restart');
    assert.equal(owner.status('bash')!.exact, true); assert.equal(owner.stats().remoteLeases, 0);
    assert.equal(owner.stats().transientBytes, 0);
    const warm = broker.stats().sourceDispatches;
    for (let i = 0; i < 100; i++) { owner.observe({ ...next, version: 3, text: next.text + '\n', complete: true }); owner.flush(); }
    assert.equal(broker.stats().sourceDispatches, warm);
    owner.remove('bash'); owner.flush(); await drain();
    assert.equal(owner.stats().retention.entries, 0);
    assert.equal(owner.stats().retention.styles, 0);
  } finally {
    owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true });
  }
  assert.equal(pipe.stats().childState, 'exited');
  assert.equal(pipe.stats().ownedListeners, 0);
  assert.equal(pipe.stats().retainedBytes, 0);
  assert.equal(owner.stats().unsettledJobs, 0);
  assert.equal(owner.stats().transientBytes, 0);
  assert.equal(owner.stats().retention.retainedBytes, 0);
});
