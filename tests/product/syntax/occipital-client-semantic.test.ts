import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderTransport } from '../../../src/occipital/provider.ts';
import type { SettingsLoadResult } from '../../../src/settings.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';

const pi = { id: 'pi', label: 'Pi palette', fingerprint: fingerprintRules(createPiRuleDefinition()) };
const restored: SettingsLoadResult = { ok: true, syntaxTheme: { kind: 'pi' } };
class MetadataPeer implements ProviderTransport {
  calls: string[] = [];
  ended: Promise<TransportEnd>;
  endReason: TransportEnd | undefined;
  private finish!: (reason: TransportEnd) => void;
  constructor() { this.ended = new Promise(resolve => { this.finish = resolve; }); }
  request(request: Record<string, unknown>): Promise<unknown> {
    this.calls.push(String(request.op));
    assert.ok(request.op === 'describe' || request.op === 'themes.refresh', `unexpected data request: ${request.op}`);
    assert.equal(request.v, 3);
    return Promise.resolve(semanticDescriptor(request.ticket, 'instance', []));
  }
  async close() { this.endReason = 'closed'; this.finish(this.endReason); }
}
function fixture(load: () => Promise<SettingsLoadResult> = async () => restored) {
  const peers: MetadataPeer[] = [];
  let writes = 0;
  const client = new SyntaxClient({ standaloneVersion: '0.1.5',
    settings: { load, async update() { writes++; return { ok: true }; } },
    provider: {
      async tryShared() { const peer = new MetadataPeer(); peers.push(peer); return peer; },
      async acquireOwned() { throw new Error('unexpected owned acquisition'); },
    },
  });
  return { client, peers, writes: () => writes };
}

test('SyntaxClient v3: native-only empty catalogue permits local Pi selection without source work', async () => {
  const { client, peers, writes } = fixture();
  try {
    await client.start();
    assert.equal(client.snapshot().provider.availability, 'ready');
    assert.deepEqual(client.snapshot().provider.description!.profiles, []);
    assert.deepEqual(client.snapshot().effective, pi);
    assert.equal(client.broker.stats().sourceDispatches, 0);
    assert.equal(client.broker.stats().styleDispatches, 0);
    assert.equal(writes(), 0);
    assert.deepEqual(peers[0]!.calls, ['describe']);
  } finally { await client.dispose(); }
});

test('SyntaxClient v3: restored local Pi rules are unavailable to presentation while disabled', async () => {
  const { client, writes } = fixture();
  try {
    await client.start();
    await client.setEnabled(false);
    client.applySavedTheme({ kind: 'pi' });
    assert.equal(client.snapshot().enabled, false);
    assert.equal(client.snapshot().effective, undefined);
    await client.setEnabled(true);
    assert.deepEqual(client.snapshot().effective, pi);
    assert.equal(client.broker.stats().sourceDispatches, 0);
    assert.equal(client.broker.stats().styleDispatches, 0);
    assert.equal(writes(), 0);
  } finally { await client.dispose(); }
});

test('SyntaxClient v3: ready metadata does not activate default local rules before settings restoration', async () => {
  let resolve!: (settings: SettingsLoadResult) => void;
  const loaded = new Promise<SettingsLoadResult>(yes => { resolve = yes; });
  const { client, writes } = fixture(() => loaded);
  const start = client.start();
  try {
    await client.broker.start(); await turn();
    assert.equal(client.snapshot().provider.availability, 'ready');
    assert.equal(client.snapshot().effective, undefined);
    resolve(restored); await start;
    assert.deepEqual(client.snapshot().effective, pi);
    assert.equal(client.broker.stats().sourceDispatches, 0);
    assert.equal(client.broker.stats().styleDispatches, 0);
    assert.equal(writes(), 0);
  } finally { resolve(restored); await start; await client.dispose(); }
});

test('SyntaxClient v3: missing palette-only definition automatically refreshes metadata without source replay', async () => {
  const removed = { id: 'custom:removed', label: 'Removed theme', fingerprint: 'b'.repeat(64) };
  class RemovedThemePeer extends MetadataPeer {
    missing = false;
    override request(request: Record<string, unknown>) {
      this.calls.push(String(request.op));
      if (request.op === 'styles.resolve') {
        this.missing = true;
        return Promise.resolve({ v: 3, ticket: request.ticket, instance: 'instance', assets: 'assets', status: 'error',
          error: { code: 'profile_unavailable', execution: 'not_started' } });
      }
      assert.equal(request.op, 'describe');
      const descriptor = semanticDescriptor(request.ticket, 'instance', this.missing ? [] : [removed]);
      descriptor.body.catalogue_revision = this.missing ? 1 : 0;
      return Promise.resolve(descriptor);
    }
  }
  const peer = new RemovedThemePeer();
  const client = new SyntaxClient({ standaloneVersion: '0.1.5',
    settings: { async load() { return { ok: true, syntaxTheme: { kind: 'occipital', id: removed.id } }; }, async update() { assert.fail('metadata reconciliation must not persist a preference'); } },
    provider: { async tryShared() { return peer; }, async acquireOwned() { assert.fail('unexpected owned acquisition'); } } });
  const preparation = { keys: new Set<string>(), prepare() {}, needsRefresh() { return false; }, requiresCredit() { return false; } };
  try {
    await client.start(); assert.equal(client.snapshot().effective?.id, removed.id);
    const group = client.sources.registerPreparation(preparation)!;
    client.sources.setStyleSelection({ kind: 'native', id: removed.id, fingerprint: removed.fingerprint });
    client.sources.queuePreparation(group, true); client.sources.flush();
    for (let i = 0; i < 8; i++) await turn();
    assert.deepEqual(peer.calls, ['describe', 'styles.resolve', 'describe'], 'targeted group notice must drive the real client metadata observer');
    assert.equal(client.snapshot().effective?.id, 'pi'); assert.deepEqual(client.snapshot().selected, { kind: 'occipital', id: removed.id });
    assert.equal(client.sources.profileReconciliationNeeded(), undefined);
    for (let i = 0; i < 100; i++) client.sources.flush(); for (let i = 0; i < 4; i++) await turn();
    assert.deepEqual(peer.calls, ['describe', 'styles.resolve', 'describe']);
    assert.equal(client.broker.stats().sourceDispatches, 0); assert.equal(client.broker.stats().styleDispatches, 1);
    assert.equal(client.broker.stats().successfulClassifications, 0); assert.equal(client.sources.stats().sourceRecords, 0);
  } finally { void preparation; await client.dispose(); }
  assert.equal(client.sources.stats().retention.retainedBytes, 0); assert.equal(client.sources.stats().globalTransientBytes, 0);
});


test('completion boundary: source delivery starts held catalogue recovery and includes its presentation continuation', { timeout: 12000 }, async t => {
  const removed = { id: 'custom:removed', label: 'Removed theme', fingerprint: 'b'.repeat(64) };
  let catalogueStarted!: () => void, presentationHeld!: () => void;
  const reading = new Promise<void>(resolve => { catalogueStarted = resolve; });
  const delivering = new Promise<void>(resolve => { presentationHeld = resolve; });
  let releaseCatalogue: (() => void) | undefined;
  class RecoveryPeer extends MetadataPeer {
    recovered = false;
    override request(request: Record<string, unknown>): Promise<unknown> {
      this.calls.push(String(request.op));
      if (request.op === 'styles.resolve') return Promise.resolve({ v: 3, ticket: request.ticket, instance: 'instance', assets: 'assets', status: 'error',
        error: { code: 'profile_unavailable', execution: 'not_started' } });
      assert.equal(request.op, 'describe');
      if (this.calls.length === 1) return Promise.resolve(semanticDescriptor(request.ticket, 'instance', [removed]));
      return new Promise(resolve => {
        releaseCatalogue = () => {
          this.recovered = true;
          const descriptor = semanticDescriptor(request.ticket, 'instance', []); descriptor.body.catalogue_revision = 1;
          resolve(descriptor);
        };
        catalogueStarted();
      });
    }
  }
  const peer = new RecoveryPeer();
  let prepared = 0, metadataDelivered = 0;
  const continuation = { keys: new Set<string>(), prepare() { prepared++; }, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const client = new SyntaxClient({ standaloneVersion: '0.2.0', initialTheme: { kind: 'occipital', id: removed.id },
    settings: { async load() { return restored; }, async update() { assert.fail('completion observation must not persist preferences'); } },
    provider: { async tryShared() { return peer; }, async acquireOwned() { assert.fail('unexpected owned acquisition'); } },
    onChange() {
      if (peer.recovered && metadataDelivered++ === 0) {
        client.sources.setStyleSelection(undefined);
        const group = client.sources.registerPreparation(continuation)!; client.sources.queuePreparation(group, true);
      }
    },
  });
  const preparation = { keys: new Set<string>(), prepare() {}, needsRefresh() { return false; }, requiresCredit() { return false; } };
  let releasePresentation: (() => void) | undefined;
  const deliver = client.deliverChange;
  t.mock.method(client, 'deliverChange', function(this: SyntaxClient) {
    if (peer.recovered && !releasePresentation) { releasePresentation = () => deliver.call(this); presentationHeld(); return; }
    return deliver.call(this);
  });
  try {
    await client.start();
    const group = client.sources.registerPreparation(preparation)!;
    client.sources.setStyleSelection({ kind: 'native', id: removed.id, fingerprint: removed.fingerprint });
    client.sources.queuePreparation(group, true);
    await awaitFixture(reading);
    assert.equal(client.sources.stats().unsettledJobs, 0, 'real source notification already launched catalogue work');
    assert.deepEqual(peer.calls, ['describe', 'styles.resolve', 'describe']);
    let completed = false;
    const completion = client.whenSettled();
    assert.equal(client.whenSettled() === completion, true, 'one shared composed wait, not one graph per caller');
    void completion.then(() => { completed = true; });
    await turn(); assert.equal(completed, false, 'catalogue is held beyond DATA settlement');
    assert.ok(releaseCatalogue); const catalogue = releaseCatalogue; releaseCatalogue = undefined; catalogue();
    await awaitFixture(delivering); await turn();
    assert.equal(client.snapshot().effective?.id, 'pi');
    assert.equal(completed, false, 'catalogue reply alone does not acknowledge presentation delivery');
    assert.equal(prepared, 0);
    assert.ok(releasePresentation); const presentation = releasePresentation; presentation();
    assert.equal(await awaitFixture(completion), true);
    assert.equal(prepared, 1, 'work queued by actual delivered metadata is part of completion');
    assert.equal(metadataDelivered, 1);
    assert.equal(client.sources.profileReconciliationNeeded(), undefined);
    assert.deepEqual(peer.calls, ['describe', 'styles.resolve', 'describe']);
  } finally { releaseCatalogue?.(); releasePresentation?.(); await client.dispose(); }
});
