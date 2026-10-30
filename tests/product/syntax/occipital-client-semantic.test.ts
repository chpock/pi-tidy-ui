import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderTransport } from '../../../src/occipital/provider.ts';
import type { SettingsLoadResult } from '../../../src/settings.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';

class MetadataPeer implements ProviderTransport {
  readonly calls: string[] = [];
  readonly ended: Promise<TransportEnd>;
  endReason: TransportEnd | undefined;
  private finish!: (reason: TransportEnd) => void;
  constructor() { this.ended = new Promise(resolve => { this.finish = resolve; }); }
  request(request: Record<string, unknown>): Promise<unknown> {
    this.calls.push(String(request.op));
    assert.equal(request.v, 4);
    assert.equal(request.op, 'describe', 'theme selection is local; it must not request a daemon catalogue');
    return Promise.resolve(semanticDescriptor(request.ticket, 'instance'));
  }
  async close() { this.endReason ??= 'closed'; this.finish(this.endReason); }
}

function clientFixture(options: { theme?: { kind: 'pi' } | { kind: 'theme'; id: string }; load?: () => Promise<SettingsLoadResult>; notify?: (message: string) => void } = {}) {
  const peer = new MetadataPeer();
  const saved: unknown[] = [];
  const client = new SyntaxClient({ standaloneVersion: '0.1.5', initialTheme: options.theme,
    settings: { async load() { return options.load ? options.load() : { ok: true, syntaxTheme: { kind: 'pi' } }; },
      async update(patch) { saved.push(patch.syntaxTheme); return { ok: true }; } }, notify: message => options.notify?.(message),
    provider: { async tryShared() { return peer; }, async acquireOwned() { throw new Error('unexpected owned acquisition'); } },
  });
  return { client, peer, saved };
}

const theme = { kind: 'theme' as const, id: 'gruvbox-dark' };

test('v4 provider negotiation does not own the local palette catalogue', async () => {
  const { client, peer } = clientFixture({ theme });
  try {
    await client.start();
    assert.equal(client.snapshot().provider.availability, 'ready');
    assert.equal(client.snapshot().effective?.kind, 'theme');
    assert.equal(client.snapshot().effective?.id, 'gruvbox-dark');
    assert.deepEqual(peer.calls, ['describe']);
    assert.equal(client.broker.stats().sourceDispatches, 0);
    assert.equal(client.broker.stats().styleDispatches, 0);
  } finally { await client.dispose(); }
});

test('owned palette stays effective while native execution is Off and theme selection sends no refresh request', async () => {
  const { client, peer, saved } = clientFixture();
  try {
    await client.start();
    await client.setEnabled(false);
    await client.selectTheme(theme);
    assert.equal(client.snapshot().enabled, false);
    assert.equal(client.snapshot().effective?.id, 'gruvbox-dark');
    assert.deepEqual(saved, [theme]);
    assert.deepEqual(peer.calls, ['describe']);
    assert.equal(client.broker.stats().sourceDispatches, 0);
    assert.equal(client.broker.stats().styleDispatches, 0);
  } finally { await client.dispose(); }
});

test('unknown local palette reports once and uses Pi locally without daemon catalogue recovery', async () => {
  const missing = { kind: 'theme' as const, id: 'not-installed' };
  const notices: string[] = [];
  const { client, peer } = clientFixture({ theme: missing, notify: message => { notices.push(message); } });
  try {
    await client.start();
    assert.deepEqual(client.snapshot().selected, missing);
    assert.equal(client.snapshot().effective?.kind, 'pi');
    assert.equal(notices.length, 1);
    await client.setEnabled(false);
    await client.setEnabled(true);
    assert.equal(notices.length, 2, JSON.stringify(notices));
    assert.match(notices[0]!, /not-installed/);
    assert.match(notices[1]!, /could not be started/);
    assert.deepEqual(peer.calls, ['describe']);
  } finally { await client.dispose(); }
});
