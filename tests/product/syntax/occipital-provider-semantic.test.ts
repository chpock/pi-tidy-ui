import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderBroker, type ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';

const fingerprint = 'a'.repeat(64);
function descriptor(ticket: unknown) { return semanticDescriptor(ticket, 'peer'); }
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


test('semantic provider: reject a v3 candidate before selecting a compatible owned v4 provider', async t => {
  const shared = new Transport(), owned = new Transport();
  shared.reply = async request => ({ ...descriptor(request.ticket), v: 3 });
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
  await provider.request(provider.snapshot().generation, { v: 4, op: 'highlight', ticket: 'measured' }, { replySize: measured });
  assert.deepEqual(measured, { ticket: 'measured', bytes: 123 });
});

for (const revision of [1, 2]) for (const carrier of ['shared', 'owned'] as const) {
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

for (const carrier of ['shared', 'owned'] as const) {
  test(`semantic provider: ${carrier} rejects the pre-language-selection v3 descriptor before SOURCE admission`, async t => {
    const transport = new Transport();
    transport.reply = async request => {
      const raw: Record<string, any> = descriptor(request.ticket); delete raw.body.source_hint_revision; return raw;
    };
    const provider = new ProviderBroker({
      tryShared: async () => carrier === 'shared' ? transport : undefined,
      acquireOwned: async () => { if (carrier === 'owned') return transport; throw new Error('no owned candidate'); },
    });
    t.after(() => provider.dispose()); await provider.start();
    assert.notEqual(provider.snapshot().availability, 'ready');
    assert.equal(provider.stats().sourceDispatches, 0); assert.equal(provider.stats().styleDispatches, 0);
    assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0]!.request.op, 'describe');
    assert.equal(transport.closes, 1);
  });
}

for (const revision of [0, 1, 3]) for (const carrier of ['shared', 'owned'] as const) {
  test(`semantic provider: ${carrier} source-hint revision ${revision} rejects before SOURCE admission`, async t => {
    const transport = new Transport();
    transport.reply = async request => {
      const raw = descriptor(request.ticket); raw.body.source_hint_revision = revision; return raw;
    };
    const provider = new ProviderBroker({
      tryShared: async () => carrier === 'shared' ? transport : undefined,
      acquireOwned: async () => { if (carrier === 'owned') return transport; throw new Error('no owned candidate'); },
    });
    t.after(() => provider.dispose()); await provider.start();
    assert.notEqual(provider.snapshot().availability, 'ready');
    assert.equal(provider.stats().sourceDispatches, 0); assert.equal(provider.stats().styleDispatches, 0);
    assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0]!.request.op, 'describe');
    assert.equal(transport.closes, 1);
  });
}
