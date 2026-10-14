// Copied with the source into a real-version fixture package; only controlled helper bytes are seeded.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import tidyUi from '../../src/index.ts';
import { createSyntaxOptions } from '../../src/occipital/bootstrap.ts';
import { SourceController } from '../../src/occipital/controller.ts';
import type { StdioTransport } from '../../src/occipital/stdio.ts';
import type { SharedTransport } from '../../src/occipital/shared.ts';
import type { ProviderClock } from '../../src/occipital/provider.ts';
import { SyntaxClient } from '../../src/occipital/client.ts';
import { SyntaxRuntime } from '../../src/syntax/runtime.ts';

export default function syntaxDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!, binary = process.env.TIDY_UI_TEST_OCCIPITAL_BIN!;
  if (!binary || !process.env.TIDY_UI_TEST_OCCIPITAL_SHA) throw new Error('An explicit local test artifact is required');
  const artifact = { target: 'linux-x64-gnu' as const, sha256: process.env.TIDY_UI_TEST_OCCIPITAL_SHA,
    maxBytes: Number(process.env.TIDY_UI_TEST_OCCIPITAL_BYTES), url: 'https://example.invalid/not-a-production-release' };
  const version = process.env.TIDY_UI_TEST_OCCIPITAL_VERSION;
  if (!version) throw new Error('The explicit local artifact version is required');
  const release = { version, artifacts: [artifact] };
  if (process.env.TIDY_UI_TEST_SYNTAX_CONFIG !== undefined) {
    const preferences = join(getAgentDir(), 'extensions', 'pi-tidy-ui');
    mkdirSync(preferences, { recursive: true }); writeFileSync(join(preferences, 'config.json'), process.env.TIDY_UI_TEST_SYNTAX_CONFIG);
  }
  const transports: StdioTransport[] = [], sharedTransports: SharedTransport[] = [];
  const counts = { constructions: 0, acquisitions: 0, downloads: 0, piCaptures: 0, piBridges: 0, describeReplies: 0, refreshReplies: 0, sharedAttempts: 0, heldReplies: 0, deliveredReplies: 0, heldBashReplies: 0, orderDispatches: 0 };
  let pendingHeldReplies = 0;
  let runtime: WeakRef<SyntaxRuntime> | undefined, client: WeakRef<SyntaxClient> | undefined, controller = 0;
  let offset = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback(): void }>();
  const clock: ProviderClock = {
    now: () => performance.now() + offset,
    setTimeout(callback, ms) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.set(timer, { at: clock.now() + ms, callback });
      return { cancel() { clearTimeout(timer); timers.delete(timer); }, unref() { timer.unref(); } };
    },
  };
  const closes: Promise<void>[] = [];
  const attached = SyntaxRuntime.prototype.attach, captured = SourceController.prototype.capturePiSource,
    bridged = SourceController.prototype.installPiBridge, fetch = globalThis.fetch;
  const brokerStats = () => client?.deref()?.broker.stats();
  const clientSnapshot = SyntaxClient.prototype.snapshot;
  SyntaxClient.prototype.snapshot = function () { client = new WeakRef(this); return clientSnapshot.call(this); };
  SyntaxRuntime.prototype.attach = function (...args) {
    if (runtime?.deref() !== this) { runtime = new WeakRef(this); controller++; }
    return attached.apply(this, args);
  };
  SourceController.prototype.capturePiSource = function (...args) { counts.piCaptures++; return captured.apply(this, args); };
  SourceController.prototype.installPiBridge = function (...args) { counts.piBridges++; return bridged.apply(this, args); };
  globalThis.fetch = async () => { counts.downloads++; throw new Error('No network in the syntax fixture'); };
  const snapshot = () => {
    const current = runtime?.deref();
    client = undefined;
    const currentClient = current?.snapshot();
    return { node: process.version, controller, counts: { ...counts }, pendingHeldReplies, client: currentClient, broker: brokerStats(),
      source: current?.sources.stats(), transports: transports.map(t => t.stats()), sharedTransports: sharedTransports.map(t => t.stats()) };
  };
  const record = (event: object) => appendFileSync(join(output, 'events.jsonl'), JSON.stringify(event) + '\n');
  const uiNotices = new Map<ExtensionContext['ui'], ExtensionContext['ui']['notify']>();
  pi.on('session_start', (_event, ctx) => {
    if (uiNotices.has(ctx.ui)) return;
    const notify = ctx.ui.notify; uiNotices.set(ctx.ui, notify);
    ctx.ui.notify = (message, level) => {
      if (message.startsWith('Syntax')) record({ type: 'syntax_notify', message, level });
      notify.call(ctx.ui, message, level);
    };
  });
  tidyUi(pi, { syntax(ctx: ExtensionContext) {
    counts.constructions++;
    const options = createSyntaxOptions(ctx, release), acquire = options.provider.acquireOwned;
    return { ...options, provider: { ...(process.env.TIDY_UI_TEST_SYNTAX_SHARED === '1' ? { clock } : {}),
      async tryShared(signal, negotiate) {
        if (process.env.TIDY_UI_TEST_SYNTAX_SHARED !== '1') return undefined;
        counts.sharedAttempts++;
        return options.provider.tryShared(signal, async transport => {
          const shared = transport as SharedTransport, request = shared.request.bind(shared);
          shared.request = async (payload, opts) => {
            const reply = await request(payload, opts);
            if (payload.op === 'describe') counts.describeReplies++;
            if (payload.op === 'themes.refresh') counts.refreshReplies++;
            return reply;
          };
          sharedTransports.push(shared); return negotiate(shared);
        });
      },
      async acquireOwned(signal: AbortSignal) {
        counts.acquisitions++;
        if (process.env.TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE === '1') {
          record({ type: 'syntax_acquire_gate' });
          while (!existsSync(join(output, 'syntax-acquire-go'))) await pause(20, undefined, { signal });
        }
        // Only test-controlled bytes are seeded; the real bootstrap then verifies them.
        const cache = join(getAgentDir(), 'cache', 'occipital', release.version, artifact.target);
        await mkdir(cache, { recursive: true }); await copyFile(binary, join(cache, 'occipital'));
        const transport = await acquire(signal) as StdioTransport;
        const request = transport.request.bind(transport), close = transport.close.bind(transport);
        transport.close = () => { const settled = close(); closes.push(settled); return settled; };
        transport.request = async (payload, opts) => {
          const ordinal = payload.op === 'highlight' && process.env.TIDY_UI_TEST_SYNTAX_ORDER_GATE === '1' ? ++counts.orderDispatches : 0;
          if (ordinal) record({ type: 'syntax_order_dispatch', ordinal, payload });
          const reply = await request(payload, opts);
          if (ordinal) {
            pendingHeldReplies++; record({ type: 'syntax_order_reply_held', ordinal });
            try {
              while (!existsSync(join(output, `syntax-order-go-${ordinal}`))) await pause(20, undefined, { signal: opts?.signal });
            } finally { pendingHeldReplies--; }
          }
          if (payload.op === 'describe') counts.describeReplies++;
          if (payload.op === 'stream.append' && process.env.TIDY_UI_TEST_BASH_REPLY_GATE === '1') {
            const ordinal = ++counts.heldBashReplies; pendingHeldReplies++;
            record({ type: 'bash_contract_reply_held', ordinal, payload, reply });
            try {
              while (!existsSync(join(output, `bash-reply-go-${ordinal}`))) await pause(20, undefined, { signal: opts?.signal });
            } finally { pendingHeldReplies--; }
          }
          if (payload.op === 'highlight' && process.env.TIDY_UI_TEST_SYNTAX_REPLY_GATE === '1') {
            counts.heldReplies++; pendingHeldReplies++;
            record({ type: 'syntax_reply_held', payload, reply });
            try {
              while (!existsSync(join(output, 'syntax-reply-go'))) await pause(20, undefined, { signal: opts?.signal });
              counts.deliveredReplies++;
            } finally { pendingHeldReplies--; }
          }
          return reply;
        };
        transports.push(transport); record({ type: 'syntax_acquired', pid: transport.stats().pid }); return transport;
      } } };
  } });
  pi.registerCommand('tidy-ui-syntax-stats', { description: 'Capture actual client/helper work counters', handler: async (name, ctx) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid capture name');
    writeFileSync(join(output, `syntax-stats-${name}.json`), JSON.stringify(snapshot(), null, 2));
    ctx.ui.notify(`SYNTAX_COUNTERS_${name}`, 'info');
  } });
  pi.registerCommand('tidy-ui-syntax-clock', { description: 'Advance only the injected broker cadence', handler: async (value, ctx) => {
    if (!/^\d+$/.test(value) || Number(value) > 600000) throw new Error('Invalid clock advance');
    offset += Number(value);
    for (const [timer, pending] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (pending.at <= clock.now() && timers.delete(timer)) { clearTimeout(timer); pending.callback(); }
    }
    record({ type: 'syntax_clock', ms: Number(value) }); ctx.ui.notify('SYNTAX_CLOCK_ADVANCED', 'info');
  } });
  pi.on('session_shutdown', async () => {
    try {
      await Promise.all([...transports, ...sharedTransports].map(t => t.ended));
      await Promise.all(closes);
      writeFileSync(join(output, 'syntax-shutdown.json'), JSON.stringify(snapshot(), null, 2));
    } finally {
      SyntaxRuntime.prototype.attach = attached; SourceController.prototype.capturePiSource = captured;
      SourceController.prototype.installPiBridge = bridged;
      SyntaxClient.prototype.snapshot = clientSnapshot; globalThis.fetch = fetch;
      for (const [ui, notify] of uiNotices) ui.notify = notify; uiNotices.clear();
      for (const timer of timers.keys()) clearTimeout(timer); timers.clear();
    }
  });
}
