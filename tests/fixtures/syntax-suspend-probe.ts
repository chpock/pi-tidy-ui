import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderTransport } from '../../src/occipital/provider.ts';

// Observe real pending transport deadlines; the test controls only its own helper process.
export function syntaxSuspendProbe(output: string, record: (event: Record<string, unknown>) => void) {
  let used = false, ticket: string | undefined, started = 0;
  let outcome = 'unarmed', deadlineMs = 0, expirations = 0;
  const configured = process.env.TIDY_UI_TEST_SUSPEND_DEADLINE_MS;
  const selectedOp = process.env.TIDY_UI_TEST_SUSPEND_OP;
  async function beforeDispatch() {
    if (!selectedOp) return;
    record({ type: 'suspend_transport_selected', op: selectedOp });
    const end = performance.now() + 10000;
    while (!existsSync(join(output, 'suspend-dispatch'))) {
      assert.ok(performance.now() < end, 'test helper stop handshake completed before actual transport dispatch');
      await delay(5);
    }
  }
  return {
    install(transport: ProviderTransport, kind: 'owned' | 'shared') {
      const request = transport.request.bind(transport), expire = Reflect.get(transport, 'expire');
      assert.equal(typeof expire, 'function', 'known real transport deadline boundary');
      Reflect.set(transport, 'expire', function (id: string) {
        if (id === ticket) { expirations++; record({ type: 'suspend_transport_deadline', kind, ticket, elapsed: performance.now() - started }); }
        return expire.call(transport, id);
      });
      transport.request = async (payload, options) => {
        const source = selectedOp ? payload.op === selectedOp : ['highlight', 'stream.open', 'stream.append'].includes(String(payload.op));
        if (used || !source || !existsSync(join(output, 'suspend-arm'))) return request(payload, options);
        used = true;
        await beforeDispatch();
        ticket = String(payload.ticket); started = performance.now(); outcome = 'pending';
        deadlineMs = configured === undefined ? options!.deadlineMs! : Number(configured);
        assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0);
        const promise = request(payload, { ...options, deadlineMs });
        record({ type: 'suspend_transport_pending', kind, ticket, deadlineMs, originalDeadlineMs: options?.deadlineMs, payload });
        return promise.then(reply => { outcome = 'resolved'; record({ type: 'suspend_transport_resolved', kind, ticket }); return reply; }, error => {
          outcome = 'rejected'; record({ type: 'suspend_transport_rejected', kind, ticket, message: error.message }); throw error;
        });
      };
    },
    snapshot() { return { outcome, ticket, deadlineMs, expirations,
      elapsed: started ? performance.now() - started : 0 }; },
  };
}
