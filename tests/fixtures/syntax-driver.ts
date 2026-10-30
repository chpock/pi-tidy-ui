// Copied with the source into a real-version fixture package; only controlled helper bytes are seeded.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createEventRecorder } from './terminal-output.ts';
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
import { ExtensionSettings } from '../../src/settings.ts';
import { matchesKey } from '@earendil-works/pi-tui';
import { observeSyntaxLocalWork, observeSyntaxCards, observePiPaletteWork } from './syntax-local-work.ts';
import { syntaxSuspendProbe } from './syntax-suspend-probe.ts';
import { registerCaptureProducer } from './terminal-capture.mjs';

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
  const record = createEventRecorder(output);
  const suspendProbe = process.env.TIDY_UI_TEST_SUSPEND_PROBE === '1' ? syntaxSuspendProbe(output, record) : undefined;
  const localWork = observeSyntaxLocalWork();
  const paletteWork = process.env.TIDY_UI_TEST_PALETTE_OBSERVE === '1' ? observePiPaletteWork() : undefined;
  const cardObservations = process.env.TIDY_UI_TEST_CARD_OBSERVE === '1' ? observeSyntaxCards(event => record({ ...event,
    phase: existsSync(join(output, 'syntax-theme-phase')) ? readFileSync(join(output, 'syntax-theme-phase'), 'utf8') : 'initial' })) : undefined;
  const transports: StdioTransport[] = [], sharedTransports: SharedTransport[] = [];
  const counts = { constructions: 0, acquisitions: 0, downloads: 0, piCaptures: 0, piBridges: 0, describeReplies: 0, sharedAttempts: 0, heldReplies: 0, deliveredReplies: 0, heldBashReplies: 0, orderDispatches: 0, themeSaves: 0, sourceRequests: 0, styleRequests: 0, closeRequests: 0, heldStyleReplies: 0, deliveredStyleReplies: 0 };
  let pendingHeldReplies = 0, healthFaultPending = process.env.TIDY_UI_TEST_RUNTIME_HEALTH === '1';
  let runtime: WeakRef<SyntaxRuntime> | undefined, client: WeakRef<SyntaxClient> | undefined, controller = 0;
  let captureClient: WeakRef<SyntaxClient> | undefined, stopCapture: (() => void) | undefined;
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
  let stopPreviewProbe: (() => void) | undefined;
  const updateSettings = ExtensionSettings.prototype.update;
  if (process.env.TIDY_UI_TEST_THEME_PREVIEW === '1') {
    ExtensionSettings.prototype.update = function (...args) {
      if (args[0].syntaxTheme) counts.themeSaves++;
      return updateSettings.apply(this, args);
    };
  }
  const attached = SyntaxRuntime.prototype.attach, captured = SourceController.prototype.capturePiSource,
    bridged = SourceController.prototype.adoptPiFlat, fetch = globalThis.fetch;
  const brokerStats = () => client?.deref()?.broker.stats();
  const clientSnapshot = SyntaxClient.prototype.snapshot, clientStart = SyntaxClient.prototype.start;
  SyntaxClient.prototype.snapshot = function () {
    client = new WeakRef(this);
    return clientSnapshot.call(this);
  };
  function startWithCaptureProducer(this: SyntaxClient, ...args: Parameters<SyntaxClient['start']>) {
    const result = clientStart.apply(this, args);
    if (runtime?.deref()?.sources === this.sources && captureClient?.deref() !== this) {
      stopCapture?.(); captureClient = new WeakRef(this); stopCapture = registerCaptureProducer(this, snapshot);
    }
    return result;
  }
  SyntaxClient.prototype.start = startWithCaptureProducer;
  SyntaxRuntime.prototype.attach = function (...args) {
    if (runtime?.deref() !== this) {
      stopCapture?.(); stopCapture = undefined; captureClient = undefined;
      runtime = new WeakRef(this); controller++;
    }
    return attached.apply(this, args);
  };
  SourceController.prototype.capturePiSource = function (...args) {
    counts.piCaptures++;
    const accepted = captured.apply(this, args);
    if (process.env.TIDY_UI_TEST_HIGHLIGHTING_LIMITS === '1') record({ type: 'highlighting_limits_pi_capture', key: args[0], version: args[1], text: args[2], language: args[3], accepted });
    if (process.env.TIDY_UI_TEST_PALETTE_OBSERVE === '1') record({ type: 'follow_pi_capture', key: args[0], version: args[1], text: args[2], language: args[3], accepted });
    return accepted;
  };
  SourceController.prototype.adoptPiFlat = function (...args) { counts.piBridges++; return bridged.apply(this, args); };
  globalThis.fetch = async () => { counts.downloads++; throw new Error('No network in the syntax fixture'); };
  const snapshot = () => {
    const current = runtime?.deref();
    client = undefined;
    const currentClient = current?.snapshot();
    return { node: process.version, controller, suspend: suspendProbe?.snapshot(), counts: { ...counts }, localWork: { ...localWork.snapshot(), ...paletteWork?.snapshot() }, pendingHeldReplies, client: currentClient, broker: brokerStats(),
      source: current?.sources.stats(), transports: transports.map(t => t.stats()), sharedTransports: sharedTransports.map(t => t.stats()) };
  };
  const uiNotices = new Map<ExtensionContext['ui'], ExtensionContext['ui']['notify']>();
  pi.on('session_start', (_event, ctx) => {
    if (process.env.TIDY_UI_TEST_THEME_PREVIEW === '1') {
      ctx.ui.setWidget('syntax-preview-probe', tui => {
        stopPreviewProbe?.();
        stopPreviewProbe = tui.addInputListener(data => {
          if (!matchesKey(data, 'ctrl+alt+p')) return;
          const name = readFileSync(join(output, 'syntax-preview-request'), 'utf8');
          if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid preview capture name');
          writeFileSync(join(output, `syntax-preview-${name}.json`), JSON.stringify(snapshot(), null, 2));
          return { consume: true };
        });
        return { render: () => [], invalidate() {} };
      });
      ctx.ui.setWidget('syntax-preview-probe', undefined);
    }
    if (uiNotices.has(ctx.ui)) return;
    const notify = ctx.ui.notify; uiNotices.set(ctx.ui, notify);
    ctx.ui.notify = (message, level) => {
      if (message.startsWith('Syntax') || (process.env.TIDY_UI_TEST_RUNTIME_HEALTH === '1' || process.env.TIDY_UI_TEST_EMPTY_BASH === '1') && message.startsWith('pi-tidy-ui:')) record({ type: 'syntax_notify', message, level });
      notify.call(ctx.ui, message, level);
    };
  });
  tidyUi(pi, { logging: process.env.TIDY_UI_TEST_RUNTIME_HEALTH === '1' ? false : undefined, syntax(ctx: ExtensionContext) {
    counts.constructions++;
    const options = createSyntaxOptions(ctx, release), acquire = options.provider.acquireOwned;
    return { ...options, provider: { ...(process.env.TIDY_UI_TEST_SYNTAX_SHARED === '1' ? { clock } : {}),
      async tryShared(signal, negotiate) {
        if (process.env.TIDY_UI_TEST_SYNTAX_SHARED !== '1') return undefined;
        counts.sharedAttempts++;
        return options.provider.tryShared(signal, async transport => {
          suspendProbe?.install(transport, 'shared');
          const shared = transport as SharedTransport, request = shared.request.bind(shared);
          shared.request = async (payload, opts) => {
            const kind = process.env.TIDY_UI_TEST_PALETTE_OBSERVE !== '1' ? undefined
              : payload.op === 'highlight' || payload.op === 'stream.open' || payload.op === 'stream.append' ? 'source'
              : payload.op === 'styles.resolve' ? 'style' : payload.op === 'stream.close' ? 'close' : undefined;
            if (kind) {
              if (kind === 'source') counts.sourceRequests++; else if (kind === 'style') counts.styleRequests++; else counts.closeRequests++;
              record({ type: 'syntax_native_dispatch', transport: 'shared', kind, payload, jobs: runtime?.deref()?.sources.stats().globalUnsettledJobs });
            }
            const reply = await request(payload, opts);
            if (kind) record({ type: 'syntax_native_reply', transport: 'shared', kind, payload, reply });
            if (payload.op === 'describe') counts.describeReplies++;
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
        const cache = join(getAgentDir(), 'extensions', 'pi-tidy-ui', 'occipital', release.version, artifact.target);
        await mkdir(cache, { recursive: true }); await copyFile(binary, join(cache, 'occipital'));
        const transport = await acquire(signal) as StdioTransport;
        suspendProbe?.install(transport, 'owned');
        const request = transport.request.bind(transport), close = transport.close.bind(transport);
        transport.close = () => { const settled = close(); closes.push(settled); return settled; };
        transport.request = async (payload, opts) => {
          const ordinal = payload.op === 'highlight' && process.env.TIDY_UI_TEST_SYNTAX_ORDER_GATE === '1' ? ++counts.orderDispatches : 0;
          if (ordinal) record({ type: 'syntax_order_dispatch', ordinal, payload });
          const kind = payload.op === 'highlight' || payload.op === 'stream.open' || payload.op === 'stream.append' ? 'source'
            : payload.op === 'styles.resolve' ? 'style' : payload.op === 'stream.close' ? 'close' : undefined;
          const phase = process.env.TIDY_UI_TEST_THEME_OBSERVE === '1'
            ? (existsSync(join(output, 'syntax-theme-phase')) ? readFileSync(join(output, 'syntax-theme-phase'), 'utf8') : 'initial') : undefined;
          if (kind) {
            if (kind === 'source') counts.sourceRequests++; else if (kind === 'style') counts.styleRequests++; else counts.closeRequests++;
            record({ type: 'syntax_native_dispatch', kind, phase, payload, jobs: runtime?.deref()?.sources.stats().globalUnsettledJobs });
          }
          if (phase && kind === 'source') record({ type: 'syntax_theme_dispatch', phase, payload, jobs: runtime?.deref()?.sources.stats().globalUnsettledJobs });
          let reply = await request(payload, opts);
          if (healthFaultPending && kind === 'source' && Array.isArray(payload.sources)
            && payload.sources.some(source => source.text.includes('THEME_WRITE'))) {
            healthFaultPending = false; reply = {}; record({ type: 'runtime_health_invalid_reply' });
          }
          if (kind) record({ type: 'syntax_native_reply', kind, phase, payload, reply });
          if (phase && kind === 'source') record({ type: 'syntax_theme_reply', phase, payload, reply });
          if (kind === 'style' && phase === 'held-preview' && process.env.TIDY_UI_TEST_THEME_PREVIEW === '1') {
            counts.heldStyleReplies++; pendingHeldReplies++;
            record({ type: 'syntax_preview_reply_held', payload, reply });
            // A fulfilled native result is deliberately delivered after rollback,
            // even if its former controller authority was cancelled meanwhile.
            try {
              while (!existsSync(join(output, 'syntax-preview-go'))) await pause(20);
              counts.deliveredStyleReplies++;
            } finally { pendingHeldReplies--; }
          }
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
      stopCapture?.(); stopCapture = undefined; captureClient = undefined;
      cardObservations?.restore(); localWork.restore(); paletteWork?.restore();
      SyntaxRuntime.prototype.attach = attached; SourceController.prototype.capturePiSource = captured;
      SourceController.prototype.adoptPiFlat = bridged;
      SyntaxClient.prototype.snapshot = clientSnapshot; globalThis.fetch = fetch;
      if (SyntaxClient.prototype.start === startWithCaptureProducer) SyntaxClient.prototype.start = clientStart;
      if (process.env.TIDY_UI_TEST_THEME_PREVIEW === '1') ExtensionSettings.prototype.update = updateSettings;
      stopPreviewProbe?.(); stopPreviewProbe = undefined;
      for (const [ui, notify] of uiNotices) ui.notify = notify; uiNotices.clear();
      for (const timer of timers.keys()) clearTimeout(timer); timers.clear();
    }
  });
}
