import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController } from '../src/occipital/controller.ts';
import type { SyntaxClient } from '../src/occipital/client.ts';
import { PROTOCOL_VERSION, type Description } from '../src/occipital/protocol.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';
import { RequestFailure } from '../src/occipital/request-failure.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import type { CardTheme } from '../src/card-theme.ts';
import { requestSyntax, resolveSyntax, paintFileSyntax, paintBashSyntax, type SyntaxDemand } from '../src/syntax/work.ts';

const fingerprint = 'a'.repeat(64);
const profile = { id: 'pi', label: 'Pi', fingerprint };
const rgbProfile = { id: 'rgb', label: 'RGB', fingerprint };
const description: Description = {
  instance: 'daemon', assets: 'assets', backend_version: 'test', catalogue_revision: 0, profiles: [profile, rgbProfile], diagnostic: null,
  limits: { request_bytes: OCCIPITAL_LIMITS.wireBytes, reply_bytes: OCCIPITAL_LIMITS.wireBytes,
    control_request_bytes: 4096, control_reply_bytes: 32768, source_bytes: OCCIPITAL_LIMITS.sourceBytes,
    line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: OCCIPITAL_LIMITS.retainedBytes,
    leases: 4096, leases_per_route: 512, runs: OCCIPITAL_LIMITS.runs, styles: OCCIPITAL_LIMITS.styles,
    idle_ms: 300000, age_ms: 3600000, quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
  runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 }
};
type Call = { request: Record<string, unknown>; resolve(value: unknown): void; reject(error: unknown): void };
class Host {
  ready = false;
  kind: 'owned' | 'shared' = 'owned';
  calls: Call[] = [];
  snapshot(): ProviderSnapshot {
    return { generation: 1, availability: this.ready ? 'ready' : 'initializing', reason: this.ready ? 'ready' : 'initializing',
      initialShared: this.kind === 'shared', kind: this.kind, description: this.ready ? description : undefined };
  }
  isReady(generation: number) { return this.ready && generation === 1; }
  classificationAccepted(generation: number) { return this.isReady(generation); }
  request(_generation: number, request: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => this.calls.push({ request, resolve, reject }));
  }
  fault(index: number, code = 'busy') {
    const call = this.calls[index]!;
    call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: description.instance, assets: description.assets,
      status: 'error', error: { code, execution: 'not_started' } });
  }
  answer(index: number, text: string, complete = true, styles: unknown[] = [{ role: 'syntaxKeyword' }]) {
    const call = this.calls[index]!, r = call.request;
    if (r.op === 'stream.close') {
      call.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok', body: { kind: 'closed' } });
      return;
    }
    const source = r.op !== 'stream.append' ? (r.sources as Record<string, unknown>[])[0]! : r;
    const bytes = Buffer.byteLength(text), committed = complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1));
    const result = { key: source.key, generation: source.generation, source_version: source.source_version,
      profile: source.profile, fingerprint: source.fingerprint, revision: 1, replace_from: 0,
      source_bytes: bytes, committed_bytes: committed, complete, ...(r.op !== 'highlight' ? { lease: 'lease' } : {}),
      styles, runs: bytes ? [bytes, 0] : [],
      counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
    call.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: description.instance, assets: description.assets,
      status: 'ok', body: { kind: 'source', sources: [result] } });
  }
}
const fixtures: { host: Host; sources: SourceController }[] = [];
function fixture(ready = false, options: ConstructorParameters<typeof SourceController>[1] = {}) {
  const host = new Host(); host.ready = ready;
  const sources = new SourceController(host, options);
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> & { enabled: boolean } = {
    sources, enabled: true,
    snapshot() { return { enabled: this.enabled, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'pi' }, effective: host.ready ? profile : undefined }; }
  };
  fixtures.push({ host, sources });
  return { host, sources, client };
}
function demand(text = 'x', version = 1, complete = true, key = 'source'): SyntaxDemand {
  return { key, text, version, complete, language: 'bash', path: 'file.sh', palette: 1 };
}
const plainTheme: CardTheme = { fg: (_role, text) => text, style: text => text };
const markedTheme: CardTheme = { fg: (role, text) => `<${role}>${text}</${role}>`, style: text => `<rgb>${text}</rgb>` };
const neutral = 0x40010203;
const highlight = (text: string) => text.split('\n').map(line => `\x1b[31m${line}\x1b[39m`);
async function settled() { await turn(); }
afterEach(async () => {
  for (const { sources } of fixtures) sources.dispose();
  for (let index = 0; index < 5; index++) {
    for (const { host } of fixtures) for (const call of host.calls) call.resolve({});
    await settled();
  }
  for (const { sources } of fixtures) {
    assert.equal(sources.stats().globalUnsettledJobs, 0);
    assert.equal(sources.stats().bookkeepingBytes, 0);
  }
  fixtures.length = 0;
});

for (const mode of ['startup', 'off', 'unavailable'] as const) {
  test(`syntax work ${mode} reuses exact Pi without capture, rows lookup or another classifier`, () => {
    const { client, sources, host } = fixture();
    if (mode === 'off') { client.enabled = false; sources.setEnabled(false); }
    if (mode === 'unavailable') client.snapshot = () => ({ enabled: true, provider: { ...host.snapshot(), availability: 'unavailable', reason: 'transport_closed' }, standaloneVersion: 'test', selected: { kind: 'pi' } });
    let calls = 0, captures = 0, visits = 0;
    const originalCapture = sources.capturePiSource.bind(sources), originalVisit = sources.visitPiBridge.bind(sources);
    sources.capturePiSource = (...args) => { captures++; return originalCapture(...args); };
    sources.visitPiBridge = (...args) => { visits++; return originalVisit(...args); };
    const classify = (text: string, info: { language?: string; path?: string }) => {
      calls++; assert.equal(text, 'é\t😀\n'); assert.deepEqual(info, { language: 'bash', path: 'file.sh' }); return highlight(text);
    };
    const d = demand('é\t😀\n');
    assert.equal(requestSyntax(client, d, classify).outcome, 'pi');
    for (let index = 0; index < 3; index++) assert.equal(requestSyntax(client, d, classify).outcome, 'pi');
    assert.equal(calls, 1); assert.equal(captures, 1); assert.equal(visits, 0); assert.equal(host.calls.length, 0);
    assert.equal(sources.borrowPiSource(d.key)?.utf8Bytes, 8);
  });
}

test('syntax work queued, pending and off held authority never permits Pi', async () => {
  const { client, sources, host } = fixture(true);
  let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  const d = demand('x', 1, false);
  assert.equal(requestSyntax(client, d, classify).outcome, 'waiting');
  assert.equal(resolveSyntax(sources, d, neutral).needsPi, false); // before flush is already queued
  sources.flush(); assert.equal(host.calls.length, 1);
  assert.equal(requestSyntax(client, d, classify).outcome, 'waiting');
  client.enabled = false; sources.setEnabled(false);
  assert.equal(requestSyntax(client, d, classify).outcome, 'waiting');
  assert.equal(calls, 0);
  sources.ownedStopped(1);
  assert.equal(requestSyntax(client, d, classify).outcome, 'pi');
  assert.equal(calls, 1); assert.equal(sources.stats().globalUnsettledJobs, 1);
  host.fault(0); await settled();
});

test('syntax work terminal shared unknown suppresses only its source', async () => {
  const { client, sources, host } = fixture(true); host.kind = 'shared';
  let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  requestSyntax(client, demand(), classify); sources.flush();
  host.calls[0]!.reject(new RequestFailure('transport_failure', 'unknown')); await settled();
  host.ready = false;
  assert.equal(requestSyntax(client, demand(), classify).outcome, 'waiting');
  assert.equal(requestSyntax(client, demand('y', 1, true, 'peer'), classify).outcome, 'pi');
  assert.equal(calls, 1); assert.equal(resolveSyntax(sources, demand(), neutral).needsPi, false);
  sources.setEnabled(false); host.ready = true; sources.setEnabled(true);
  assert.equal(requestSyntax(client, demand(), classify).outcome, 'waiting');
  assert.equal(calls, 1); // Off/on is not a new source owner or stop proof.
});

test('syntax work typed no-start exposes pure needsPi and classifies only explicit demand', async () => {
  const { client, sources, host } = fixture(true);
  let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  const d = demand('é', 1, false);
  requestSyntax(client, d, classify); sources.flush(); host.fault(0); await settled();
  const before = sources.stats();
  for (let index = 0; index < 3; index++) assert.equal(resolveSyntax(sources, d, neutral).needsPi, true);
  assert.equal(calls, 0); assert.deepEqual(sources.stats(), before); assert.equal(host.calls.length, 1);
  assert.equal(requestSyntax(client, d, classify).outcome, 'pi');
  assert.notEqual(sources.borrowSource(d.key)?.generation, sources.borrowPiSource(d.key)?.generation);
  assert.equal(requestSyntax(client, d, classify).outcome, 'pi'); assert.equal(calls, 1); assert.equal(host.calls.length, 1);
});

for (const mode of ['startup', 'off', 'unavailable'] as const) {
  test(`syntax work ${mode} admits useful incomplete demand, reuses exact colors and finalizes latest`, () => {
    const { client, sources, host } = fixture(); let calls = 0;
    if (mode === 'off') { client.enabled = false; sources.setEnabled(false); }
    if (mode === 'unavailable') client.snapshot = () => ({ enabled: true, provider: { ...host.snapshot(), availability: 'unavailable', reason: 'transport_closed' }, standaloneVersion: 'test', selected: { kind: 'pi' } });
    const classify = (text: string) => { calls++; return highlight(text); };
    const initial = demand('a', 1, false);
    assert.equal(resolveSyntax(sources, initial, neutral).needsPi, true);
    assert.equal(requestSyntax(client, initial, classify).outcome, 'pi');
    assert.equal(requestSyntax(client, initial, classify).outcome, 'pi');
    assert.equal(resolveSyntax(sources, initial, neutral).needsPi, false);
    assert.equal(calls, 1);
    // Caller has coalesced intermediate changes; only its useful latest is submitted.
    const latest = demand('a\tb\n', 3, false);
    assert.equal(resolveSyntax(sources, latest, neutral).needsPi, true);
    assert.equal(requestSyntax(client, latest, classify).outcome, 'pi');
    const old = resolveSyntax(sources, latest, neutral);
    const generation = sources.borrowPiSource(latest.key)?.generation;
    assert.equal(calls, 2);
    const complete = { ...latest, version: 4, complete: true };
    assert.equal(requestSyntax(client, complete, classify).outcome, 'pi');
    assert.equal(requestSyntax(client, complete, classify).outcome, 'pi');
    assert.equal(calls, 2);
    assert.equal(sources.borrowPiSource(latest.key)?.generation, generation);
    assert.equal(sources.borrowPiSource(latest.key)?.utf8Bytes, 4);
    assert.equal(paintFileSyntax(sources, old, plainTheme), undefined);
    assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, complete, neutral), plainTheme), ['a   b', '']);
    assert.equal(host.calls.length, 0);
  });
}

test('syntax work source, selected language and palette transitions invalidate exact Pi', () => {
  const { client, sources } = fixture(); let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  const original = demand('x'); requestSyntax(client, original, classify);
  const old = resolveSyntax(sources, original, neutral);
  const rewritten = demand('y', 2); requestSyntax(client, rewritten, classify);
  assert.equal(paintFileSyntax(sources, old, plainTheme), undefined);
  const language = { ...rewritten, language: 'python' }; requestSyntax(client, language, classify);
  assert.equal(paintFileSyntax(sources, resolveSyntax(sources, rewritten, neutral), plainTheme), undefined);
  const palette = { ...language, palette: 2 }; requestSyntax(client, palette, classify);
  assert.equal(paintFileSyntax(sources, resolveSyntax(sources, language, neutral), plainTheme), undefined);
  requestSyntax(client, palette, classify); assert.equal(calls, 4);
  assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, palette, neutral), plainTheme), ['y']);
});

test('syntax work accepts faint Pi rows and reuses the exact result', () => {
  const { client, sources } = fixture(); let calls = 0;
  const classify = () => { calls++; return ['\x1b[2mx']; };
  const d = demand();
  assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'pi' });
  assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'pi' });
  assert.equal(calls, 1);
  assert.equal(sources.piFailure(d.key, d.version, d.palette), undefined);
  assert.equal(resolveSyntax(sources, d, neutral).needsPi, false);
});

for (const kind of ['threw', 'invalid_rows'] as const) {
  test(`syntax work exact ${kind} failure is cached and new palette permits one attempt`, () => {
    const { client, sources } = fixture(); let calls = 0, captures = 0;
    const capture = sources.capturePiSource.bind(sources);
    sources.capturePiSource = (...args) => { captures++; return capture(...args); };
    const classify = () => { calls++; if (kind === 'threw') throw new Error('fixture'); return ['\x1b[8mx']; };
    const d = demand();
    assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'failed', failure: kind });
    assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'failed', failure: kind });
    assert.equal(calls, 1); assert.equal(captures, 1); assert.equal(sources.piFailure(d.key, d.version, d.palette), kind);
    assert.equal(resolveSyntax(sources, d, neutral).needsPi, false);
    requestSyntax(client, { ...d, palette: 2 }, classify); assert.equal(calls, 2);
  });
}

for (const failure of ['threw', 'invalid_rows'] as const) {
  test(`syntax work ${failure} from another language never vetoes current fallback`, () => {
    const { client, sources, host } = fixture(); let calls = 0;
    const initial = demand();
    const bad = () => { calls++; if (failure === 'threw') throw new Error('fixture'); return ['\x1b[8mx']; };
    assert.deepEqual(requestSyntax(client, initial, bad), { outcome: 'failed', failure });
    assert.equal(resolveSyntax(sources, initial, neutral).needsPi, false);
    const changed = { ...initial, language: 'python' };
    const before = sources.stats();
    assert.equal(resolveSyntax(sources, changed, neutral).needsPi, true);
    assert.deepEqual(sources.stats(), before);
    assert.equal(calls, 1);
    assert.equal(sources.piFailure(initial.key, initial.version, initial.palette), failure);
    assert.equal(requestSyntax(client, changed, text => { calls++; return highlight(text); }).outcome, 'pi');
    assert.equal(requestSyntax(client, changed, text => { calls++; return highlight(text); }).outcome, 'pi');
    assert.equal(calls, 2);
    assert.equal(resolveSyntax(sources, changed, neutral).needsPi, false);
    assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, changed, neutral), plainTheme), ['x']);
    assert.equal(host.calls.length, 0);
  });
}

test('syntax work source admission refusal skips classification', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 1 } }); let calls = 0;
  const classify = () => { calls++; return ['x']; };
  assert.equal(requestSyntax(client, demand(), classify).outcome, 'refused');
  assert.equal(requestSyntax(client, demand(), classify).outcome, 'refused');
  assert.equal(calls, 0); assert.equal(sources.borrowPiSource('source'), undefined);
});

test('syntax work ANSI bridge storage refusal is not classifier failure and cannot carousel', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 1500 } }); let calls = 0;
  const classify = (text: string) => { calls++; return ['\x1b[31m'.repeat(80) + text + '\x1b[39m']; };
  const d = demand();
  assert.equal(requestSyntax(client, d, classify).outcome, 'refused');
  const before = sources.stats();
  assert.equal(requestSyntax(client, d, classify).outcome, 'refused');
  assert.equal(calls, 1); assert.equal(sources.piFailure(d.key, d.version, d.palette), undefined);
  assert.deepEqual(sources.stats(), before);
  requestSyntax(client, demand('y', 2), text => { calls++; return [text]; });
  assert.equal(calls, 2);
});

test('syntax work warmed resolution/painting does not classify, observe, capture or dispatch', () => {
  const { client, sources, host } = fixture(); let calls = 0;
  const d = demand('a\t😀\nz'); requestSyntax(client, d, text => { calls++; return highlight(text); });
  const before = sources.stats();
  sources.observe = () => { throw new Error('render observe'); };
  sources.capturePiSource = () => { throw new Error('render capture'); };
  for (const width of [8, 12, 8]) {
    const resolved = resolveSyntax(sources, d, neutral);
    assert.deepEqual(paintFileSyntax(sources, resolved, plainTheme), ['a   😀', 'z']);
    assert.ok(paintBashSyntax(sources, resolved, width, plainTheme));
  }
  assert.equal(calls, 1); assert.equal(host.calls.length, 0); assert.deepEqual(sources.stats(), before);
});

test('syntax work stored native exact is preferred offline and reader validates retirement during paint', async () => {
  const { client, sources, host } = fixture(true);
  const d = demand('x\t'); let calls = 0;
  requestSyntax(client, d, () => { calls++; return ['x\t']; }); sources.flush(); host.answer(0, d.text); await settled();
  host.ready = false;
  const resolved = resolveSyntax(sources, d, neutral);
  assert.equal(resolved.nativeExact, true); assert.equal(resolved.needsPi, false);
  assert.deepEqual(paintFileSyntax(sources, resolved, markedTheme), ['<syntaxKeyword>x   </syntaxKeyword>']);
  assert.equal(calls, 0);
  const reentrant: CardTheme = { fg: (_role, text) => { sources.remove(d.key); return text; } };
  assert.equal(paintFileSyntax(sources, resolved, reentrant), undefined);
});

test('syntax work native proven prefix never borrows changed tail colors; exact Pi wins over prefix', async () => {
  const { client, sources, host } = fixture(true);
  const initial = demand('a\nb', 1, false);
  requestSyntax(client, initial, highlight); sources.flush(); host.answer(0, initial.text, false); await settled();
  const latest = demand('a\nbc', 2);
  requestSyntax(client, latest, highlight);
  let resolved = resolveSyntax(sources, latest, neutral);
  assert.equal(resolved.nativeExact, false);
  assert.deepEqual(paintFileSyntax(sources, resolved, markedTheme), ['<syntaxKeyword>a</syntaxKeyword>', '<toolOutput>bc</toolOutput>']);
  sources.flush(); host.fault(1); await settled();
  requestSyntax(client, latest, highlight); resolved = resolveSyntax(sources, latest, neutral);
  assert.ok(resolved.pi);
  assert.deepEqual(paintFileSyntax(sources, resolved, markedTheme), ['<rgb>a</rgb>', '<rgb>bc</rgb>']);
});

test('syntax work native RGB reader passes packed styles without classification', async () => {
  const { client, sources, host } = fixture(true); const d = demand('x');
  client.snapshot = () => ({ enabled: true, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'occipital', id: 'rgb' }, effective: rgbProfile });
  requestSyntax(client, d, highlight); sources.flush();
  host.answer(0, d.text, true, [{ rgb: [1, 2, 3], attributes: 5 }]); await settled();
  const resolved = resolveSyntax(sources, d, neutral), spans: number[][] = [];
  assert.equal(resolved.native?.((a, b, style) => spans.push([a, b, style])), true);
  assert.deepEqual(spans, [[0, 1, 0x45010203]]);
  assert.deepEqual(paintFileSyntax(sources, resolved, markedTheme), ['<rgb>x</rgb>']);
});

test('syntax work plain completion notices never observe; only typed profile retry exposes permission', async () => {
  const { client, sources, host } = fixture(true); const d = demand();
  requestSyntax(client, d, highlight); sources.flush(); host.fault(0, 'profile_changed'); await settled();
  assert.equal(resolveSyntax(sources, d, neutral).profileRetryAllowed, false);
  const need = sources.profileReconciliationNeeded(); assert.ok(need);
  sources.acknowledgeProfiles(need.generation, need.sequence);
  const before = sources.stats();
  assert.equal(resolveSyntax(sources, d, neutral).profileRetryAllowed, true);
  assert.deepEqual(sources.stats(), before); assert.equal(host.calls.length, 1);
  requestSyntax(client, d, highlight); sources.flush(); assert.equal(host.calls.length, 2);
  host.answer(1, d.text); await settled();
  assert.equal(resolveSyntax(sources, d, neutral).profileRetryAllowed, false);
  assert.equal(resolveSyntax(sources, d, neutral).nativeExact, true); assert.equal(host.calls.length, 2);
});

test('syntax work stale Pi reader generation/version rejects removed, replaced and reentrant owner', () => {
  const { client, sources } = fixture(); const d = demand(); requestSyntax(client, d, highlight);
  const old = resolveSyntax(sources, d, neutral); assert.ok(old.pi);
  sources.removePiSource(d.key); requestSyntax(client, d, highlight);
  assert.equal(old.pi(() => {}), false); assert.equal(paintFileSyntax(sources, old, plainTheme), undefined);
  const next = resolveSyntax(sources, d, neutral);
  assert.equal(next.pi?.(() => { sources.removePiSource(d.key); }), false);
});

test('syntax work stale classifier publication cannot install or mark a replacement failure', () => {
  const { client, sources } = fixture(); const d = demand();
  const result = requestSyntax(client, d, () => {
    sources.removePiSource(d.key); sources.capturePiSource(d.key, 2, 'y', 'bash'); return ['bad'];
  });
  assert.equal(result.outcome, 'stale'); assert.equal(sources.piFailure(d.key, 2, d.palette), undefined);
  assert.equal(sources.hasPiBridge(d.key, 2, d.palette), false);
});

function collectibleReader() {
  const host = new Host(), sources = new SourceController(host);
  sources.capturePiSource('first', 1, 'x', 'bash');
  const source = sources.borrowPiSource('first')!;
  sources.installPiBridge('first', source.generation, 1, 'x', 1, ['\x1b[1mx\x1b[22m']);
  const reader = resolveSyntax(sources, demand('x', 1, true, 'first'), neutral).pi!;
  return { owner: new WeakRef(sources), reader };
}
test('syntax work first active owner collects with retained reader and another active owner', { skip: !global.gc }, async () => {
  assert.equal(typeof global.gc, 'function', 'run exact test with --expose-gc');
  const first = collectibleReader(), peer = fixture();
  requestSyntax(peer.client, demand('y', 1, true, 'peer'), highlight);
  let collected = false;
  for (let index = 0; index < 40; index++) {
    await settled(); global.gc!(); await settled();
    if (!first.owner.deref()) { collected = true; break; }
  }
  assert.equal(collected, true); assert.equal(first.reader(() => {}), false);
  assert.deepEqual(paintFileSyntax(peer.sources, resolveSyntax(peer.sources, demand('y', 1, true, 'peer'), neutral), plainTheme), ['y']);
});

test('syntax work retained exact Pi stays visible during explicit native upgrade then yields to native exact', async () => {
  const { client, sources, host } = fixture(); const d = demand(); let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  requestSyntax(client, d, classify); host.ready = true;
  requestSyntax(client, d, classify); sources.flush();
  assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, d, neutral), markedTheme), ['<rgb>x</rgb>']);
  host.answer(0, d.text); await settled();
  assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, d, neutral), markedTheme), ['<syntaxKeyword>x</syntaxKeyword>']);
  assert.equal(calls, 1); assert.equal(host.calls.length, 1);
});

test('syntax work pool eviction makes retained Pi reader and neutral display resolution stale', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 1500 } });
  const d = demand(); requestSyntax(client, d, highlight);
  const resolved = resolveSyntax(sources, d, neutral); assert.ok(resolved.pi);
  requestSyntax(client, demand('y', 1, true, 'peer'), highlight);
  assert.equal(resolved.pi(() => {}), false);
  assert.equal(paintFileSyntax(sources, resolved, plainTheme), undefined);
  assert.equal(paintFileSyntax(sources, resolveSyntax(sources, d, neutral), plainTheme), undefined);
});

test('syntax work Pi reset restores concrete neutral fonts and glyph mismatch rejects entire projection', () => {
  const { client, sources } = fixture(); const d = demand('ab');
  requestSyntax(client, d, () => ['\x1b[1ma\x1b[0mb']);
  const spans: number[][] = [];
  const resolved = resolveSyntax(sources, d, neutral);
  assert.equal(resolved.pi?.((a, b, style) => spans.push([a, b, style])), true);
  assert.deepEqual(spans, [[0, 1, 0x41010203], [1, 2, neutral]]);
  assert.deepEqual(paintFileSyntax(sources, resolved, plainTheme), ['ab']);
  assert.equal(requestSyntax(client, demand('c', 2), () => ['d']).outcome, 'failed');
  assert.equal(sources.piFailure('source', 2, 1), 'invalid_rows');
  assert.equal(paintFileSyntax(sources, resolveSyntax(sources, demand('c', 2), neutral), plainTheme), undefined);
});

async function collectibleNativeReader() {
  const host = new Host(); host.ready = true;
  const sources = new SourceController(host);
  sources.observe({ key: 'first', version: 1, text: 'x', complete: true, language: 'bash', profile: profile.id, fingerprint });
  sources.flush(); host.answer(0, 'x'); await settled();
  const reader = resolveSyntax(sources, demand('x', 1, true, 'first'), neutral).native!;
  assert.ok(reader);
  return { owner: new WeakRef(sources), reader };
}
test('syntax work first active native owner collects while its reader and a peer remain live', { skip: !global.gc }, async () => {
  assert.equal(typeof global.gc, 'function', 'run exact test with --expose-gc');
  const first = await collectibleNativeReader(), peer = fixture(true);
  const d = demand('y', 1, true, 'peer'); requestSyntax(peer.client, d, highlight);
  peer.sources.flush(); peer.host.answer(0, 'y'); await settled();
  let collected = false;
  for (let index = 0; index < 40; index++) {
    await settled(); global.gc!(); await settled();
    if (!first.owner.deref()) { collected = true; break; }
  }
  assert.equal(collected, true); assert.equal(first.reader(() => {}), false);
  assert.deepEqual(paintFileSyntax(peer.sources, resolveSyntax(peer.sources, d, neutral), plainTheme), ['y']);
});

test('syntax work stale completion identities cannot request Pi for a newer native or Pi version', () => {
  const native = fixture(true), old = demand();
  requestSyntax(native.client, demand('y', 2), highlight);
  native.host.ready = false;
  assert.equal(resolveSyntax(native.sources, old, neutral).needsPi, false);
  const pi = fixture(); requestSyntax(pi.client, demand('y', 2), highlight);
  assert.equal(resolveSyntax(pi.sources, old, neutral).needsPi, false);
});

test('syntax work equal-text finalization and warmed Pi never remeasure UTF8', () => {
  const { client } = fixture(); const d = demand('é\t😀');
  let calls = 0, measurements = 0;
  const byteLength = Buffer.byteLength;
  // Controller also validates primitive key/language lengths on finalization;
  // count only the exact logical source, not those unrelated identifier checks.
  Buffer.byteLength = (...args: Parameters<typeof Buffer.byteLength>) => {
    if (args[0] === d.text) measurements++;
    return byteLength(...args);
  };
  try {
    const classify = (text: string) => { calls++; return highlight(text); };
    requestSyntax(client, d, classify);
    const first = measurements; assert.equal(first, 1);
    requestSyntax(client, d, classify);
    requestSyntax(client, { ...d, version: 2 }, classify);
    assert.equal(measurements, first); assert.equal(calls, 1);
  } finally { Buffer.byteLength = byteLength; }
});

test('syntax work empty logical source has exact immediate rows without invoking a classifier', () => {
  const { client, sources } = fixture(); const d = demand(''); let calls = 0;
  const classify = () => { calls++; return ['']; };
  assert.equal(requestSyntax(client, d, classify).outcome, 'pi');
  assert.equal(calls, 0);
  assert.deepEqual(paintFileSyntax(sources, resolveSyntax(sources, d, neutral), plainTheme), ['']);
  assert.deepEqual(paintBashSyntax(sources, resolveSyntax(sources, d, neutral), 8, plainTheme), ['$ ']);
});

test('syntax work paint rejects another controller even when key and pool generations coincide', () => {
  const first = fixture(), second = fixture(); const d = demand();
  requestSyntax(first.client, d, highlight);
  requestSyntax(second.client, demand('y'), highlight);
  const resolved = resolveSyntax(first.sources, d, neutral);
  assert.equal(first.sources.borrowPiSource(d.key)?.generation, second.sources.borrowPiSource(d.key)?.generation);
  assert.equal(paintFileSyntax(second.sources, resolved, plainTheme), undefined);
  assert.equal(paintBashSyntax(second.sources, resolved, 8, plainTheme), undefined);
  assert.deepEqual(paintFileSyntax(first.sources, resolved, plainTheme), ['x']);
});

for (const mode of ['initializing', 'unavailable', 'off'] as const) {
  test(`syntax work neutral fallback ${mode} never calls or exposes Pi`, () => {
    const { client, sources, host } = fixture();
    if (mode === 'off') { client.enabled = false; sources.setEnabled(false); }
    if (mode === 'unavailable') {
      const snapshot = client.snapshot.bind(client);
      client.snapshot = () => { const current = snapshot(); return { ...current, provider: { ...current.provider, availability: 'unavailable' } }; };
    }
    let pi = 0;
    const identity = { ...demand('x'), fallback: 'neutral' as const };
    const result = requestSyntax(client, identity, () => { pi++; return ['x']; });
    assert.equal(result.outcome, 'neutral'); assert.equal(result.awaitingProvider, mode === 'off' ? undefined : true);
    const resolution = resolveSyntax(sources, identity, 0x40000000);
    assert.equal(resolution.needsPi, false); assert.equal(resolution.pi, undefined);
    assert.equal(paintBashSyntax(sources, resolution, 12, markedTheme), undefined);
    assert.equal(pi, 0); assert.equal(host.calls.length, 0); assert.equal(sources.borrowPiSource('source'), undefined);
    assert.equal(sources.stats().retention.entries, 0);
  });
}
test('syntax work neutral fallback ignores Pi retained by another surface and still uses native exact', async () => {
  const { client, sources, host } = fixture(); let pi = 0;
  const classify = () => { pi++; return ['x']; };
  assert.equal(requestSyntax(client, demand('x'), classify).outcome, 'pi');
  const identity = { ...demand('x'), fallback: 'neutral' as const };
  assert.equal(requestSyntax(client, identity, classify).outcome, 'neutral');
  assert.equal(resolveSyntax(sources, identity, 0x40000000).pi, undefined);
  assert.equal(pi, 1);
  host.ready = true;
  assert.equal(requestSyntax(client, identity, classify).outcome, 'waiting');
  sources.flush(); assert.equal(host.calls.length, 1);
  host.answer(0, 'x'); await turn();
  assert.equal(requestSyntax(client, identity, classify).outcome, 'native');
  const resolution = resolveSyntax(sources, identity, 0x40000000);
  assert.equal(resolution.nativeExact, true); assert.equal(resolution.pi, undefined);
  assert.ok(paintBashSyntax(sources, resolution, 12, markedTheme));
  assert.equal(pi, 1); assert.equal(host.calls.length, 1);
});

test('syntax work neutral fallback keeps held native authority through off without a Pi reader or classifier', async () => {
  const { client, sources, host } = fixture(true); let pi = 0;
  const identity = { ...demand('x'), fallback: 'neutral' as const };
  const classify = () => { pi++; return ['x']; };
  assert.equal(requestSyntax(client, identity, classify).outcome, 'waiting');
  sources.flush(); assert.equal(host.calls.length, 1);
  client.enabled = false; sources.setEnabled(false);
  assert.equal(requestSyntax(client, identity, classify).outcome, 'waiting');
  const resolution = resolveSyntax(sources, identity, neutral);
  assert.equal(resolution.needsPi, false); assert.equal(resolution.pi, undefined);
  assert.equal(paintBashSyntax(sources, resolution, 12, markedTheme), undefined);
  assert.equal(sources.workStatus('source').fallbackEligible, false);
  host.answer(0, 'x'); await settled();
  assert.equal(sources.workStatus('source').fallbackEligible, true);
  assert.equal(requestSyntax(client, identity, classify).outcome, 'neutral');
  assert.equal(pi, 0); assert.equal(host.calls.length, 1); assert.equal(sources.borrowPiSource('source'), undefined);
});


test('syntax diagnostics distinguish a cached plain Pi result from native work without logging source content', async () => {
  const events: string[] = [];
  const diagnostic = (_level: unknown, _area: unknown, explanation: string, fields?: object) => events.push(`${explanation} ${JSON.stringify(fields)}`);
  const { client, sources, host } = fixture(false, { diagnostic });
  let calls = 0;
  const d = demand('PRIVATE_SOURCE_CONTENT', 1, false);
  requestSyntax(client, d, text => { calls++; return text.split('\n'); });
  assert.ok(events.some(row => /plain.*Pi|Pi.*plain/u.test(row)), events.join('\n'));
  const before = events.length;
  for (let index = 0; index < 20; index++) {
    requestSyntax(client, d, () => { throw new Error('must reuse Pi'); });
    resolveSyntax(sources, d, neutral);
    paintFileSyntax(sources, resolveSyntax(sources, d, neutral), plainTheme);
  }
  assert.equal(events.length, before);
  assert.equal(calls, 1);
  host.ready = true;
  assert.equal(requestSyntax(client, d, highlight).outcome, 'pi'); // Retained fallback remains usable while native is queued.
  sources.flush();
  assert.ok(events.some(row => /dispatched/u.test(row)), events.join('\n'));
  assert.equal(host.calls.length, 1);
  host.answer(0, d.text, false); await settled();
  assert.ok(events.some(row => /accepted/u.test(row)), events.join('\n'));
  assert.ok(events.every(row => !row.includes('PRIVATE_SOURCE_CONTENT')), events.join('\n'));
});

test('syntax diagnostics are observational even if their sink throws', async () => {
  const { client, sources, host } = fixture(true, { diagnostic: () => { throw new Error('unavailable logger'); } });
  let calls = 0;
  const d = demand('x', 1, false);
  assert.equal(requestSyntax(client, d, text => { calls++; return highlight(text); }).outcome, 'waiting');
  sources.flush(); assert.equal(host.calls.length, 1);
  host.answer(0, d.text, false); await settled();
  assert.equal(resolveSyntax(sources, d, neutral).nativeExact, true);
  assert.equal(calls, 0);
  assert.equal(sources.stats().globalUnsettledJobs, 0);
});


for (const code of ['busy', 'profile_changed', 'theme_unavailable', 'invalid_header', 'PRIVATE_NATIVE_CODE'])
  test(`logging review P2: native rejection preserves safe ${code} without exposing arbitrary code/message`, async () => {
    const records: { explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
    const f = fixture(true, { diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
    const d = demand('PRIVATE_SOURCE_TEXT'); requestSyntax(f.client, d, highlight); f.sources.flush();
    assert.equal(f.host.calls.length, 1);
    if (code === 'invalid_header') f.host.calls[0]!.resolve({ malformed: 'PRIVATE_REPLY_TEXT' });
    else f.host.fault(0, code);
    await settled();
    const rejection = records.find(record => record.explanation.startsWith('Native reply refused'));
    assert.equal(rejection?.fields?.code, code === 'PRIVATE_NATIVE_CODE' ? 'unknown' : code);
    assert.equal(f.host.calls.length, 1); assert.equal(f.sources.stats().unsettledJobs, 0);
    const text = JSON.stringify(records); assert.equal(text.includes('PRIVATE_NATIVE_CODE'), false);
    assert.equal(text.includes('PRIVATE_SOURCE_TEXT'), false); assert.equal(text.includes('PRIVATE_REPLY_TEXT'), false);
  });
