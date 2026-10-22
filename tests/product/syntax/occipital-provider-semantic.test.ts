import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderBroker, type ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';

const fingerprint = 'a'.repeat(64);
function descriptor(ticket: unknown) { return semanticDescriptor(ticket, 'peer', []); }
class Transport implements ProviderTransport {
  #end!: (reason: TransportEnd) => void;
  readonly ended = new Promise<TransportEnd>(resolve => { this.#end = resolve; });
  endReason: TransportEnd | undefined;
  closes = 0;
  calls: { request: Record<string, unknown>; waitOnly?: boolean }[] = [];
  reply: (request: Record<string, unknown>) => Promise<unknown> = async request => descriptor(request.ticket);
  request(request: Record<string, unknown>, options?: Parameters<ProviderTransport['request']>[1]) {
    this.calls.push({ request, waitOnly: options?.waitOnly });
    return this.reply(request);
  }
  async close() { this.closes++; this.endReason ??= 'closed'; this.#end(this.endReason); }
}
function broker(transport: Transport) {
  return new ProviderBroker({ tryShared: async () => transport, acquireOwned: async () => { throw new Error('unexpected owned acquisition'); } });
}

test('semantic provider: an empty native catalogue stays usable for local Follow Pi without a daemon Pi pseudoprofile', async t => {
  const transport = new Transport(), provider = broker(transport); t.after(() => provider.dispose());
  await provider.start();
  const snapshot = provider.snapshot();
  assert.equal(snapshot.availability, 'ready');
  assert.equal(snapshot.kind, 'shared');
  assert.deepEqual(snapshot.description?.profiles, []);
  assert.deepEqual(transport.calls.map(call => call.request), [{ v: 3, op: 'describe', ticket: transport.calls[0]!.request.ticket }]);
  assert.equal(provider.stats().sourceDispatches, 0);
  assert.equal(provider.stats().successfulClassifications, 0);
});

test('semantic provider: native catalogue refresh is wait-only and preserves an outstanding style request and provider generation', async t => {
  const transport = new Transport(), provider = broker(transport); t.after(() => provider.dispose());
  await provider.start(); assert.equal(provider.snapshot().availability, 'ready');
  const generation = provider.snapshot().generation;
  let finish!: (value: unknown) => void;
  transport.reply = request => request.op === 'styles.resolve' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({
    ...descriptor(request.ticket), body: { ...descriptor(request.ticket).body, catalogue_revision: 1,
      profiles: [{ id: 'native', label: 'Native theme', fingerprint }] },
  });
  const pending = provider.request(generation, { v: 3, ticket: 'style:1', op: 'styles.resolve' });
  assert.equal(provider.stats().sourceDispatches, 0);
  assert.equal(provider.stats().styleDispatches, 1);
  assert.equal(typeof finish, 'function');
  const metadata = await provider.catalogue(generation, 'themes.refresh');
  assert.equal(metadata.profiles[0]!.id, 'native');
  assert.equal(provider.snapshot().generation, generation);
  assert.equal(transport.closes, 0);
  assert.equal(transport.calls.at(-1)!.waitOnly, true);
  assert.equal(provider.stats().successfulClassifications, 0, 'style dispatch and metadata never reset a source-success crash chain');
  finish({ terminal: true }); assert.deepEqual(await pending, { terminal: true });
  assert.equal(provider.stats().successfulClassifications, 0, 'a raw style success is still not a validated source result');
});

for (const field of ['fingerprint', 'count'] as const) test(`semantic provider: immutable vocabulary ${field} change cannot silently replace source identity on catalogue refresh`, async t => {
  const transport = new Transport(), provider = broker(transport); t.after(() => provider.dispose());
  await provider.start(); assert.equal(provider.snapshot().availability, 'ready');
  const generation = provider.snapshot().generation, previous = provider.snapshot().description;
  transport.reply = async request => {
    const raw = descriptor(request.ticket); raw.body.catalogue_revision++;
    if (field === 'count') raw.body.vocabulary.count++;
    else raw.body.vocabulary.fingerprint = 'b'.repeat(64);
    return raw;
  };
  await assert.rejects(provider.catalogue(generation, 'themes.refresh'), /provider_changed/);
  assert.equal(provider.snapshot().generation, generation);
  assert.deepEqual(provider.snapshot().description, previous);
  assert.equal(transport.closes, 0, 'invalid metadata is not proven loss of independent source work');
});

test('semantic provider: reject a v2 candidate before selecting a compatible owned v3 provider', async t => {
  const shared = new Transport(), owned = new Transport();
  shared.reply = async request => ({ ...descriptor(request.ticket), v: 2 });
  const provider = new ProviderBroker({ tryShared: async () => shared, acquireOwned: async () => owned });
  t.after(() => provider.dispose()); await provider.start();
  assert.equal(shared.closes, 1);
  assert.equal(provider.snapshot().availability, 'ready'); assert.equal(provider.snapshot().kind, 'owned');
  assert.equal(provider.stats().sourceDispatches, 0);
});

for (const replyBytes of [524288, 524289, 64 << 20]) test(`semantic provider volume limits: advertised reply allowance ${replyBytes} gates readiness before DATA`, async t => {
  const shared = new Transport(), owned = new Transport();
  shared.reply = async request => {
    const raw = descriptor(request.ticket); raw.body.limits.reply_bytes = replyBytes;
    return raw;
  };
  owned.reply = async request => {
    const raw = descriptor(request.ticket); raw.body.limits.reply_bytes = 524288;
    return raw;
  };
  const provider = new ProviderBroker({ tryShared: async () => shared, acquireOwned: async () => owned });
  t.after(() => provider.dispose()); await provider.start();
  assert.equal(provider.snapshot().availability, 'ready');
  assert.equal(provider.snapshot().kind, replyBytes <= 524288 ? 'shared' : 'owned');
  assert.equal(shared.closes, replyBytes <= 524288 ? 0 : 1);
  assert.equal(provider.stats().sourceDispatches, 0); assert.equal(provider.stats().styleDispatches, 0);
  assert.ok([...shared.calls, ...owned.calls].every(call => call.request.op === 'describe'));
  assert.equal(provider.snapshot().description!.limits.reply_bytes, 524288);
});

test('semantic provider: forwards the call-local measured reply size without retaining payloads', async t => {
  const transport = new Transport(), provider = broker(transport); t.after(() => provider.dispose());
  const original = transport.request.bind(transport), measured: { ticket?: string; bytes?: number } = {};
  transport.request = (request, options) => {
    if (request.ticket === 'measured') {
      assert.equal(options?.replySize === measured, true);
      options!.replySize!.ticket = 'measured'; options!.replySize!.bytes = 123;
    }
    return original(request, options);
  };
  await provider.start();
  await provider.request(provider.snapshot().generation, { v: 3, op: 'highlight', ticket: 'measured' }, { replySize: measured });
  assert.deepEqual(measured, { ticket: 'measured', bytes: 123 });
});

for (const revision of [1, 3]) for (const carrier of ['shared', 'owned'] as const) {
  test(`semantic provider: ${carrier} resolver revision ${revision} rejects before STYLE admission`, async t => {
    const transport = new Transport();
    transport.reply = async request => {
      const raw = descriptor(request.ticket); raw.body.resolver_revision = revision; return raw;
    };
    const provider = new ProviderBroker({
      tryShared: async () => carrier === 'shared' ? transport : undefined,
      acquireOwned: async () => { if (carrier === 'owned') return transport; throw new Error('no owned candidate'); },
    });
    t.after(() => provider.dispose()); await provider.start();
    assert.notEqual(provider.snapshot().availability, 'ready');
    assert.equal(provider.stats().styleDispatches, 0); assert.equal(provider.stats().sourceDispatches, 0);
    assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0]!.request.op, 'describe');
    assert.equal(transport.closes, 1);
  });
}
