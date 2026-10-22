import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController } from '../../../src/occipital/controller.ts';
import type { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderSnapshot } from '../../../src/occipital/provider.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { preparePiFlat } from '../../../src/syntax/pi-flat.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { fingerprintNative } from '../../../src/occipital/style-rules.ts';
import { neutral, fileRows, bashRows, piSpans } from '../../fixtures/source-work-flat.ts';
import { requestSyntax, resolveSyntax, type SyntaxDemand } from '../../../src/syntax/work.ts';

const fingerprint = 'a'.repeat(64);
const profile = { id: 'native', label: 'Native', fingerprint };
const rgbProfile = { id: 'rgb', label: 'RGB', fingerprint };
const description = decodeSemanticDescription(semanticDescriptor('describe', 'daemon', [profile, rgbProfile]), 'describe');
type Call = { request: Record<string, unknown>; resolve(value: unknown): void; reject(error: unknown): void };
class Host {
  ready = false;
  kind: 'owned' | 'shared' = 'owned';
  calls: Call[] = [];
  styles: Call[] = [];
  snapshot(): ProviderSnapshot {
    return { generation: 1, availability: this.ready ? 'ready' : 'initializing', reason: this.ready ? 'ready' : 'initializing',
      initialShared: this.kind === 'shared', kind: this.kind, description: this.ready ? description : undefined };
  }
  isReady(generation: number) { return this.ready && generation === 1; }
  classificationAccepted(generation: number) { return this.isReady(generation); }
  request(_generation: number, request: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => (request.op === 'styles.resolve' ? this.styles : this.calls).push({ request, resolve, reject }));
  }
  fault(index: number, code = 'busy', style = false) {
    const call = (style ? this.styles : this.calls)[index]!;
    call.resolve({ v: 3, ticket: call.request.ticket, instance: description.instance, assets: description.assets,
      status: 'error', error: { code, execution: 'not_started' } });
  }
  source(index: number, text: string, complete = true) {
    const call = this.calls[index]!, r = call.request;
    if (r.op === 'stream.close') {
      call.resolve({ v: 3, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok', body: { kind: 'closed' } }); return;
    }
    const source = r.op !== 'stream.append' ? (r.sources as Record<string, unknown>[])[0]! : r;
    const bytes = Buffer.byteLength(text), committed = complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1));
    const from = r.op === 'stream.append' ? Number(r.base_bytes) : 0;
    call.resolve({ v: 3, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok',
      body: { kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: source.key, generation: source.generation,
        source_version: source.source_version, revision: r.op === 'stream.append' ? Number(r.base_revision) + 1 : 1, replace_from: from, source_bytes: bytes, committed_bytes: committed, complete,
        ...(r.op !== 'highlight' ? { lease: 'lease' } : {}), contexts: bytes > from ? [[0, 1]] : [], runs: bytes > from ? [bytes - from, 1] : [],
        counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }] } });
  }
  style(index: number, literal: ConcreteStyle = { foreground: { kind: 'indexed', index: 5 }, background: neutral.background, attributes: 0 }) {
    const call = this.styles[index]!, r = call.request;
    const rules = r.rules as { fingerprint: string };
    call.resolve({ v: 3, ticket: r.ticket, instance: description.instance, assets: description.assets, status: 'ok',
      body: { kind: 'styles', vocabulary: r.vocabulary, rules: fingerprintNative(rules.fingerprint, 'rules'),
        styles: [{ ...literal, attribute_mask: 31 }], indices: (r.contexts as unknown[]).map(() => 1),
        palette: { revision: 1, fingerprint: fingerprintNative(rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } } });
  }
  async answer(index: number, text: string, complete = true, literal?: ConcreteStyle) {
    this.source(index, text, complete); await settled();
    for (let i = 0; i < this.styles.length; i++) this.style(i, literal);
    await settled();
  }
}
const fixtures: { host: Host; sources: SourceController }[] = [];
function fixture(ready = false, options: ConstructorParameters<typeof SourceController>[1] = {}) {
  const host = new Host(); host.ready = ready;
  const sources = new SourceController(host, options);
  sources.setStyleSelection({ kind: 'native', id: profile.id, fingerprint });
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> & { enabled: boolean } = {
    sources, enabled: true,
    snapshot() { return { enabled: this.enabled, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'pi' }, effective: host.ready ? profile : undefined }; }
  };
  fixtures.push({ host, sources });
  return { host, sources, client };
}
function demand(text = 'x', version = 1, complete = true, key = 'source'): SyntaxDemand {
  return { key, text, version, complete, language: 'bash', path: 'file.sh', palette: 1, fallback: 'pi', piNeutral: neutral };
}
const highlight = (text: string) => text.split('\n').map(line => `\x1b[31m${line}\x1b[39m`);
async function settled() { for (let i = 0; i < 5; i++) await turn(); }
afterEach(async () => {
  for (const { sources } of fixtures) sources.dispose();
  for (let index = 0; index < 5; index++) {
    for (const { host } of fixtures) for (const call of [...host.calls, ...host.styles]) call.resolve({});
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
    const originalCapture = sources.capturePiSource.bind(sources), originalVisit = sources.visitPiRanges.bind(sources);
    sources.capturePiSource = (...args) => { captures++; return originalCapture(...args); };
    sources.visitPiRanges = (...args) => { visits++; return originalVisit(...args); };
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
  assert.equal(resolveSyntax(sources, d).needsPi, false); // before flush is already queued
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
  assert.equal(calls, 1); assert.equal(resolveSyntax(sources, demand()).needsPi, false);
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
  for (let index = 0; index < 3; index++) assert.equal(resolveSyntax(sources, d).needsPi, true);
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
    assert.equal(resolveSyntax(sources, initial).needsPi, true);
    assert.equal(requestSyntax(client, initial, classify).outcome, 'pi');
    assert.equal(requestSyntax(client, initial, classify).outcome, 'pi');
    assert.equal(resolveSyntax(sources, initial).needsPi, false);
    assert.equal(calls, 1);
    // Caller has coalesced intermediate changes; only its useful latest is submitted.
    const latest = demand('a\tb\n', 3, false);
    assert.equal(resolveSyntax(sources, latest).needsPi, true);
    assert.equal(requestSyntax(client, latest, classify).outcome, 'pi');
    const old = resolveSyntax(sources, latest);
    const generation = sources.borrowPiSource(latest.key)?.generation;
    assert.equal(calls, 2);
    const complete = { ...latest, version: 4, complete: true };
    assert.equal(requestSyntax(client, complete, classify).outcome, 'pi');
    assert.equal(requestSyntax(client, complete, classify).outcome, 'pi');
    assert.equal(calls, 2);
    assert.equal(sources.borrowPiSource(latest.key)?.generation, generation);
    assert.equal(sources.borrowPiSource(latest.key)?.utf8Bytes, 4);
    assert.equal(fileRows(sources, old), undefined);
    assert.deepEqual(fileRows(sources, resolveSyntax(sources, complete)), ['a   b', '']);
    assert.equal(host.calls.length, 0);
  });
}

test('syntax work source, selected language and palette transitions invalidate exact Pi', () => {
  const { client, sources } = fixture(); let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  const original = demand('x'); requestSyntax(client, original, classify);
  const old = resolveSyntax(sources, original);
  const rewritten = demand('y', 2); requestSyntax(client, rewritten, classify);
  assert.equal(fileRows(sources, old), undefined);
  const language = { ...rewritten, language: 'python' }; requestSyntax(client, language, classify);
  assert.equal(fileRows(sources, resolveSyntax(sources, rewritten)), undefined);
  const palette = { ...language, palette: 2 }; requestSyntax(client, palette, classify);
  assert.equal(fileRows(sources, resolveSyntax(sources, language)), undefined);
  requestSyntax(client, palette, classify); assert.equal(calls, 4);
  assert.deepEqual(fileRows(sources, resolveSyntax(sources, palette)), ['y']);
});

test('syntax work accepts faint Pi rows and reuses the exact result', () => {
  const { client, sources } = fixture(); let calls = 0;
  const classify = () => { calls++; return ['\x1b[2mx']; };
  const d = demand();
  assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'pi' });
  assert.deepEqual(requestSyntax(client, d, classify), { outcome: 'pi' });
  assert.equal(calls, 1);
  assert.equal(sources.piFailure(d.key, d.version, d.palette), undefined);
  assert.equal(resolveSyntax(sources, d).needsPi, false);
  assert.deepEqual(piSpans(resolveSyntax(sources, d).pi)?.[0]?.style, { ...neutral, attributes: 8 });
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
    assert.equal(resolveSyntax(sources, d).needsPi, false);
    requestSyntax(client, { ...d, palette: 2 }, classify); assert.equal(calls, 2);
  });
}

for (const failure of ['threw', 'invalid_rows'] as const) {
  test(`syntax work ${failure} from another language never vetoes current fallback`, () => {
    const { client, sources, host } = fixture(); let calls = 0;
    const initial = demand();
    const bad = () => { calls++; if (failure === 'threw') throw new Error('fixture'); return ['\x1b[8mx']; };
    assert.deepEqual(requestSyntax(client, initial, bad), { outcome: 'failed', failure });
    assert.equal(resolveSyntax(sources, initial).needsPi, false);
    const changed = { ...initial, language: 'python' };
    const before = sources.stats();
    assert.equal(resolveSyntax(sources, changed).needsPi, true);
    assert.deepEqual(sources.stats(), before);
    assert.equal(calls, 1);
    assert.equal(sources.piFailure(initial.key, initial.version, initial.palette), failure);
    assert.equal(requestSyntax(client, changed, text => { calls++; return highlight(text); }).outcome, 'pi');
    assert.equal(requestSyntax(client, changed, text => { calls++; return highlight(text); }).outcome, 'pi');
    assert.equal(calls, 2);
    assert.equal(resolveSyntax(sources, changed).needsPi, false);
    assert.deepEqual(fileRows(sources, resolveSyntax(sources, changed)), ['x']);
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

test('syntax work inspected ANSI storage refusal is not classifier failure and cannot carousel', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 5000 } }); let calls = 0;
  const classify = (text: string) => { calls++; return ['\x1b[31m'.repeat(800) + text + '\x1b[39m']; };
  const d = demand();
  assert.equal(requestSyntax(client, d, classify).outcome, 'refused');
  const before = sources.stats();
  for (let i = 0; i < 30; i++) {
    assert.equal(requestSyntax(client, d, classify).outcome, 'refused');
    assert.equal(resolveSyntax(sources, d).needsPi, false);
  }
  assert.equal(calls, 1); assert.equal(sources.piFailure(d.key, d.version, d.palette), undefined);
  assert.equal(sources.piRefusal(d.key, d.version, d.palette), true);
  assert.deepEqual(sources.stats(), before);
  requestSyntax(client, demand('y', 2), text => { calls++; return [text]; });
  assert.equal(calls, 2);
});

test('syntax work warmed resolution and test-only common painting does not classify, observe, capture or dispatch', () => {
  const { client, sources, host } = fixture(); let calls = 0;
  const d = demand('a\t😀\nz'); requestSyntax(client, d, text => { calls++; return highlight(text); });
  const before = sources.stats();
  sources.observe = () => { throw new Error('render observe'); };
  sources.capturePiSource = () => { throw new Error('render capture'); };
  for (const width of [8, 12, 8]) {
    const resolved = resolveSyntax(sources, d);
    assert.deepEqual(fileRows(sources, resolved), ['a   😀', 'z']);
    assert.ok(bashRows(sources, resolved, width));
  }
  assert.equal(calls, 1); assert.equal(host.calls.length, 0); assert.deepEqual(sources.stats(), before);
});

test('syntax work stored native exact is preferred offline and reader validates retirement during paint', async () => {
  const { client, sources, host } = fixture(true);
  const d = demand('x\t'); let calls = 0;
  requestSyntax(client, d, () => { calls++; return ['x\t']; }); sources.flush(); await host.answer(0, d.text); await settled();
  host.ready = false;
  const resolved = resolveSyntax(sources, d);
  assert.equal(resolved.nativeExact, true); assert.equal(resolved.needsPi, false);
  assert.deepEqual(fileRows(sources, resolved), ['x   ']);
  assert.equal(calls, 0);
  assert.equal(resolved.native?.(() => { sources.remove(d.key); }), false);
  assert.equal(fileRows(sources, resolved), undefined);
});

test('syntax work native proven prefix never borrows changed tail colors; exact Pi wins over prefix', async () => {
  const { client, sources, host } = fixture(true);
  const initial = demand('a\nb', 1, false);
  requestSyntax(client, initial, highlight); sources.flush(); await host.answer(0, initial.text, false); await settled();
  const latest = demand('a\nbc', 2);
  requestSyntax(client, latest, highlight);
  let resolved = resolveSyntax(sources, latest);
  assert.equal(resolved.nativeExact, false);
  assert.deepEqual(fileRows(sources, resolved), ['a', 'bc']);
  const prefix: { start: number; end: number; style: ConcreteStyle }[] = [];
  assert.equal(resolved.native?.((start, end, style) => prefix.push({ start, end, style })), true);
  assert.deepEqual(prefix, [{ start: 0, end: 2, style: { foreground: { kind: 'indexed', index: 5 }, background: neutral.background, attributes: 0 } }]);
  sources.flush(); host.fault(1); await settled();
  requestSyntax(client, latest, highlight); resolved = resolveSyntax(sources, latest);
  assert.ok(resolved.pi);
  assert.deepEqual(piSpans(resolved.pi)?.map(span => span.style.foreground), [{ kind: 'indexed', index: 1 }, neutral.foreground, { kind: 'indexed', index: 1 }]);
  assert.deepEqual(fileRows(sources, resolved), ['a', 'bc']);
});

test('syntax work native RGB reader passes concrete styles without classification', async () => {
  const { client, sources, host } = fixture(true); const d = demand('x');
  client.snapshot = () => ({ enabled: true, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'occipital', id: 'rgb' }, effective: rgbProfile });
  requestSyntax(client, d, highlight); sources.flush();
  await host.answer(0, d.text, true, { foreground: { kind: 'rgb', r: 1, g: 2, b: 3 }, background: neutral.background, attributes: 5 }); await settled();
  const resolved = resolveSyntax(sources, d), spans: { start: number; end: number; style: ConcreteStyle }[] = [];
  assert.equal(resolved.native?.((a, b, style) => spans.push({ start: a, end: b, style })), true);
  assert.deepEqual(spans, [{ start: 0, end: 1, style: { foreground: { kind: 'rgb', r: 1, g: 2, b: 3 }, background: neutral.background, attributes: 5 } }]);
  assert.deepEqual(fileRows(sources, resolved), ['x']);
});

test('syntax work STYLE metadata reconciliation is pure and never grants parser retry', async () => {
  const { client, sources, host } = fixture(true), d = demand(); let calls = 0;
  const classify = () => { calls++; return ['x']; };
  requestSyntax(client, d, classify); sources.flush(); host.source(0, d.text); await settled();
  assert.equal(host.styles.length, 1); host.fault(0, 'profile_changed', true); await settled();
  const need = sources.profileReconciliationNeeded(); assert.ok(need);
  const before = sources.stats(), observe = sources.observe;
  sources.observe = () => { throw new Error('completion observation'); };
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(resolveSyntax(sources, d).profileRetryAllowed, false);
      assert.equal(resolveSyntax(sources, d).needsPi, false);
    }
  } finally { sources.observe = observe; }
  assert.deepEqual(sources.stats(), before);
  sources.acknowledgeProfiles(need.generation, need.sequence);
  assert.equal(sources.profileReconciliationNeeded(), undefined);
  assert.equal(resolveSyntax(sources, d).profileRetryAllowed, false);
  assert.equal(requestSyntax(client, d, classify).outcome, 'waiting'); sources.flush(); await settled();
  assert.equal(host.calls.length, 1); assert.equal(host.styles.length, 1); assert.equal(calls, 0);
  const next = { ...rgbProfile, fingerprint: 'b'.repeat(64) };
  sources.setStyleSelection({ kind: 'native', id: next.id, fingerprint: next.fingerprint });
  client.snapshot = () => ({ enabled: true, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'occipital', id: next.id }, effective: next });
  requestSyntax(client, d, classify); sources.flush(); await settled();
  assert.equal(host.calls.length, 1); assert.equal(host.styles.length, 2);
  host.style(1); await settled();
  assert.ok(resolveSyntax(sources, d).display); assert.equal(calls, 0);
});

test('syntax work stale Pi reader generation/version rejects removed, replaced and reentrant owner', () => {
  const { client, sources } = fixture(); const d = demand(); requestSyntax(client, d, highlight);
  const old = resolveSyntax(sources, d); assert.ok(old.pi);
  sources.removePiSource(d.key); requestSyntax(client, d, highlight);
  assert.equal(old.pi.visitRanges(() => {}), false); assert.equal(fileRows(sources, old), undefined);
  const next = resolveSyntax(sources, d);
  assert.equal(next.pi?.visitRanges(() => { sources.removePiSource(d.key); }), false);
});

test('syntax work stale classifier publication cannot install or mark a replacement failure', () => {
  const { client, sources } = fixture(); const d = demand();
  const result = requestSyntax(client, d, () => {
    sources.removePiSource(d.key); sources.capturePiSource(d.key, 2, 'y', 'bash'); return ['bad'];
  });
  assert.equal(result.outcome, 'stale'); assert.equal(sources.piFailure(d.key, 2, d.palette), undefined);
  assert.equal(sources.piProjection(d.key, 2, d.palette), undefined);
});

function collectibleReader() {
  const host = new Host(), sources = new SourceController(host);
  const client = { sources, snapshot: () => ({ enabled: false, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'pi' as const } }) };
  requestSyntax(client, demand('x', 1, true, 'first'), () => ['\x1b[1mx\x1b[22m']);
  const reader = resolveSyntax(sources, demand('x', 1, true, 'first')).pi!;
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
  assert.equal(collected, true); assert.equal(first.reader.visitRanges(() => {}), false);
  assert.deepEqual(fileRows(peer.sources, resolveSyntax(peer.sources, demand('y', 1, true, 'peer'))), ['y']);
});

test('syntax work retained exact Pi stays visible during explicit native upgrade then yields to native exact', async () => {
  const { client, sources, host } = fixture(); const d = demand(); let calls = 0;
  const classify = (text: string) => { calls++; return highlight(text); };
  requestSyntax(client, d, classify); host.ready = true;
  requestSyntax(client, d, classify); sources.flush();
  assert.deepEqual(fileRows(sources, resolveSyntax(sources, d)), ['x']);
  assert.deepEqual(piSpans(resolveSyntax(sources, d).pi)?.[0]?.style.foreground, { kind: 'indexed', index: 1 });
  await host.answer(0, d.text); await settled();
  assert.deepEqual(fileRows(sources, resolveSyntax(sources, d)), ['x']);
  const foregrounds: unknown[] = [];
  assert.equal(resolveSyntax(sources, d).native?.((_a, _b, style) => foregrounds.push(style.foreground)), true);
  assert.deepEqual(foregrounds, [{ kind: 'indexed', index: 5 }]);
  assert.equal(calls, 1); assert.equal(host.calls.length, 1);
});

test('syntax work pool eviction makes retained Pi reader and neutral display resolution stale', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 4000 } });
  const d = demand(); assert.equal(requestSyntax(client, d, highlight).outcome, 'pi');
  const resolved = resolveSyntax(sources, d); assert.ok(resolved.pi);
  assert.ok(sources.stats().retention.retainedBytes > 0);
  assert.equal(requestSyntax(client, demand('y', 1, true, 'peer'), highlight).outcome, 'pi');
  assert.ok(resolveSyntax(sources, demand('y', 1, true, 'peer')).pi);
  assert.equal(resolved.pi.visitRanges(() => {}), false);
  assert.equal(fileRows(sources, resolved), undefined);
  assert.equal(fileRows(sources, resolveSyntax(sources, d)), undefined);
});

test('syntax work Pi reset restores concrete neutral fonts and glyph mismatch rejects entire projection', () => {
  const { client, sources } = fixture(); const d = demand('ab');
  requestSyntax(client, d, () => ['\x1b[1ma\x1b[0mb']);
  const resolved = resolveSyntax(sources, d);
  assert.deepEqual(piSpans(resolved.pi), [{ start: 0, end: 1, style: { ...neutral, attributes: 1 } }, { start: 1, end: 2, style: neutral }]);
  assert.deepEqual(fileRows(sources, resolved), ['ab']);
  assert.equal(requestSyntax(client, demand('c', 2), () => ['d']).outcome, 'failed');
  assert.equal(sources.piFailure('source', 2, 1), 'invalid_rows');
  assert.equal(fileRows(sources, resolveSyntax(sources, demand('c', 2))), undefined);
});

async function collectibleNativeReader() {
  const host = new Host(); host.ready = true;
  const sources = new SourceController(host);
  sources.setStyleSelection({ kind: 'native', id: profile.id, fingerprint });
  sources.observe({ key: 'first', version: 1, text: 'x', complete: true, language: 'bash', profile: profile.id, fingerprint });
  sources.flush(); await host.answer(0, 'x'); await settled();
  const reader = resolveSyntax(sources, demand('x', 1, true, 'first')).native!;
  assert.ok(reader);
  return { owner: new WeakRef(sources), reader };
}
test('syntax work first active native owner collects while its reader and a peer remain live', { skip: !global.gc }, async () => {
  assert.equal(typeof global.gc, 'function', 'run exact test with --expose-gc');
  const first = await collectibleNativeReader(), peer = fixture(true);
  const d = demand('y', 1, true, 'peer'); requestSyntax(peer.client, d, highlight);
  peer.sources.flush(); await peer.host.answer(0, 'y'); await settled();
  let collected = false;
  for (let index = 0; index < 40; index++) {
    await settled(); global.gc!(); await settled();
    if (!first.owner.deref()) { collected = true; break; }
  }
  assert.equal(collected, true); assert.equal(first.reader(() => {}), false);
  assert.deepEqual(fileRows(peer.sources, resolveSyntax(peer.sources, d)), ['y']);
});

test('syntax work stale completion identities cannot request Pi for a newer native or Pi version', () => {
  const native = fixture(true), old = demand();
  requestSyntax(native.client, demand('y', 2), highlight);
  native.host.ready = false;
  assert.equal(resolveSyntax(native.sources, old).needsPi, false);
  const pi = fixture(); requestSyntax(pi.client, demand('y', 2), highlight);
  assert.equal(resolveSyntax(pi.sources, old).needsPi, false);
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
  assert.deepEqual(fileRows(sources, resolveSyntax(sources, d)), ['']);
  assert.deepEqual(bashRows(sources, resolveSyntax(sources, d), 8), ['$ ']);
});

test('syntax work paint rejects another controller even when key and pool generations coincide', () => {
  const first = fixture(), second = fixture(); const d = demand();
  requestSyntax(first.client, d, highlight);
  requestSyntax(second.client, demand('y'), highlight);
  const resolved = resolveSyntax(first.sources, d);
  assert.equal(first.sources.borrowPiSource(d.key)?.generation, second.sources.borrowPiSource(d.key)?.generation);
  assert.equal(fileRows(second.sources, resolved), undefined);
  assert.equal(bashRows(second.sources, resolved, 8), undefined);
  assert.deepEqual(fileRows(first.sources, resolved), ['x']);
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
    const resolution = resolveSyntax(sources, identity);
    assert.equal(resolution.needsPi, false); assert.equal(resolution.pi, undefined);
    assert.equal(bashRows(sources, resolution, 12), undefined);
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
  assert.equal(resolveSyntax(sources, identity).pi, undefined);
  assert.equal(pi, 1);
  host.ready = true;
  assert.equal(requestSyntax(client, identity, classify).outcome, 'waiting');
  sources.flush(); assert.equal(host.calls.length, 1);
  await host.answer(0, 'x'); for (let i = 0; i < 5; i++) await turn();
  assert.equal(requestSyntax(client, identity, classify).outcome, 'native');
  const resolution = resolveSyntax(sources, identity);
  assert.equal(resolution.nativeExact, true); assert.equal(resolution.pi, undefined);
  assert.ok(bashRows(sources, resolution, 12));
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
  const resolution = resolveSyntax(sources, identity);
  assert.equal(resolution.needsPi, false); assert.equal(resolution.pi, undefined);
  assert.equal(bashRows(sources, resolution, 12), undefined);
  assert.equal(sources.workStatus('source').fallbackEligible, false);
  await host.answer(0, 'x'); await settled();
  assert.equal(sources.workStatus('source').fallbackEligible, true);
  assert.equal(requestSyntax(client, identity, classify).outcome, 'neutral');
  assert.equal(pi, 0); assert.equal(host.calls.length, 1); assert.equal(sources.borrowPiSource('source'), undefined);
});


test('syntax diagnostics keep cached plain Pi silent and distinguish native dispatch without logging source content', async () => {
  const events: string[] = [];
  const diagnostic = (_level: unknown, _area: unknown, explanation: string, fields?: object) => events.push(`${explanation} ${JSON.stringify(fields)}`);
  const { client, sources, host } = fixture(false, { diagnostic });
  let calls = 0;
  const d = demand('PRIVATE_SOURCE_CONTENT', 1, false);
  requestSyntax(client, d, text => { calls++; return text.split('\n'); });
  assert.equal(resolveSyntax(sources, d).piStyled, false);
  assert.ok(resolveSyntax(sources, d).pi);
  const before = events.length;
  for (let index = 0; index < 20; index++) {
    requestSyntax(client, d, () => { throw new Error('must reuse Pi'); });
    resolveSyntax(sources, d);
    fileRows(sources, resolveSyntax(sources, d));
  }
  assert.equal(events.length, before);
  assert.equal(calls, 1);
  host.ready = true;
  assert.equal(requestSyntax(client, d, highlight).outcome, 'pi'); // Retained fallback remains usable while native is queued.
  sources.flush();
  assert.ok(events.some(row => /dispatched/u.test(row)), events.join('\n'));
  assert.equal(host.calls.length, 1);
  await host.answer(0, d.text, false); await settled();
  assert.ok(events.some(row => /accepted/u.test(row)), events.join('\n'));
  assert.ok(events.every(row => !row.includes('PRIVATE_SOURCE_CONTENT')), events.join('\n'));
});

test('syntax diagnostics are observational even if their sink throws', async () => {
  const { client, sources, host } = fixture(true, { diagnostic: () => { throw new Error('unavailable logger'); } });
  let calls = 0;
  const d = demand('x', 1, false);
  assert.equal(requestSyntax(client, d, text => { calls++; return highlight(text); }).outcome, 'waiting');
  sources.flush(); assert.equal(host.calls.length, 1);
  await host.answer(0, d.text, false); await settled();
  assert.equal(resolveSyntax(sources, d).nativeExact, true);
  assert.equal(calls, 0);
  assert.equal(sources.stats().globalUnsettledJobs, 0);
});


for (const code of ['busy', 'profile_changed', 'theme_unavailable', 'invalid_header', 'PRIVATE_NATIVE_CODE'])
  test(`logging review P2: native rejection preserves safe ${code} without exposing arbitrary code/message`, async () => {
    const records: { explanation: string; fields?: import('../../../src/diagnostics.ts').DiagnosticFields }[] = [];
    const f = fixture(true, { diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
    const d = demand('PRIVATE_SOURCE_TEXT'); requestSyntax(f.client, d, highlight); f.sources.flush();
    assert.equal(f.host.calls.length, 1);
    const styleFault = code === 'profile_changed' || code === 'theme_unavailable';
    if (styleFault) { f.host.source(0, d.text); await settled(); f.host.fault(0, code, true); }
    else if (code === 'invalid_header') f.host.calls[0]!.resolve({ malformed: 'PRIVATE_REPLY_TEXT' });
    else f.host.fault(0, code);
    await settled();
    const rejection = records.find(record => record.explanation.startsWith(styleFault ? 'Native style reply refused' : 'Native reply refused'));
    assert.equal(rejection?.fields?.code, code === 'PRIVATE_NATIVE_CODE' ? 'unknown' : code);
    assert.equal(f.host.calls.length, 1); assert.equal(f.sources.stats().unsettledJobs, 0);
    const text = JSON.stringify(records); assert.equal(text.includes('PRIVATE_NATIVE_CODE'), false);
    assert.equal(text.includes('PRIVATE_SOURCE_TEXT'), false); assert.equal(text.includes('PRIVATE_REPLY_TEXT'), false);
  });


test('syntax work SOURCE complete and styles pending or failed never authorizes Pi', async () => {
  const { client, sources, host } = fixture(true), d = demand(); let calls = 0;
  const classify = () => { calls++; return ['x']; };
  requestSyntax(client, d, classify); sources.flush(); host.source(0, 'x'); await settled();
  assert.equal(host.styles.length, 1);
  const pending = resolveSyntax(sources, d);
  assert.equal(pending.nativeExact, true); assert.equal(pending.native, undefined); assert.equal(pending.display, undefined);
  assert.equal(pending.needsPi, false); assert.equal(requestSyntax(client, d, classify).outcome, 'waiting');
  host.fault(0, 'busy', true); await settled();
  host.ready = false;
  for (let i = 0; i < 10; i++) {
    assert.equal(requestSyntax(client, d, classify).outcome, 'waiting');
    assert.equal(resolveSyntax(sources, d).needsPi, false);
  }
  assert.equal(resolveSyntax(sources, d, null).nativeExact, true);
  assert.equal(resolveSyntax(sources, d, null).needsPi, false);
  assert.equal(requestSyntax(client, { ...d, nativeProfile: null }, classify).outcome, 'waiting');
  assert.equal(calls, 0); assert.equal(host.calls.length, 1);
});

test('syntax work forwards explicit neutral origin and theme-only selection never reparses', async () => {
  const { client, sources, host } = fixture(true), d = { ...demand(), neutral: 'title' as const };
  const observe = sources.observe.bind(sources); const origins: unknown[] = [];
  sources.observe = input => { origins.push(input.neutral); return observe(input); };
  requestSyntax(client, d, highlight); sources.flush(); await host.answer(0, 'x');
  sources.setStyleSelection({ kind: 'native', id: rgbProfile.id, fingerprint: 'b'.repeat(64) });
  client.snapshot = () => ({ enabled: true, provider: host.snapshot(), standaloneVersion: 'test', selected: { kind: 'occipital', id: 'rgb' }, effective: rgbProfile });
  requestSyntax(client, d, highlight); sources.flush(); await settled();
  assert.deepEqual(origins, ['title', 'title']); assert.equal(host.calls.length, 1);
  assert.equal(host.styles.length, 2); host.style(1); await settled();
});

test('syntax work warm requests and pure resolution never scan source, ranges, styles or reserve', () => {
  const { client, sources } = fixture(), d = demand('é\t😀\nx');
  requestSyntax(client, d, highlight);
  const before = sources.stats(), char = String.prototype.charCodeAt;
  const forbidden = () => { throw new Error('warm traversal or allocation'); };
  sources.capturePiSource = forbidden; sources.piPreparation = forbidden; sources.reservePiData = forbidden;
  sources.visitPiRanges = forbidden; sources.visitPiStyles = forbidden; sources.visitRanges = forbidden;
  String.prototype.charCodeAt = forbidden;
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(requestSyntax(client, d, forbidden).outcome, 'pi');
      assert.equal(resolveSyntax(sources, d).needsPi, false);
    }
  } finally { String.prototype.charCodeAt = char; }
  assert.deepEqual(sources.stats(), before);
});

test('syntax work Pi neutral preserves real default/index/RGB fonts, resets and surface', () => {
  const { client, sources } = fixture();
  for (const foreground of [{ kind: 'terminal-default' as const }, { kind: 'indexed' as const, index: 7 }, { kind: 'rgb' as const, r: 12, g: 34, b: 56 }]) {
    const piNeutral: ConcreteStyle = { foreground, background: { kind: 'indexed', index: 8 }, attributes: 15 };
    const d = { ...demand('abc', 1, true, foreground.kind), piNeutral };
    assert.equal(requestSyntax(client, d, () => ['a\x1b[22;23;24;38;5;2;48;5;9mb\x1b[0mc']).outcome, 'pi');
    assert.deepEqual(piSpans(resolveSyntax(sources, d).pi), [
      { start: 0, end: 1, style: piNeutral },
      { start: 1, end: 2, style: { foreground: { kind: 'indexed', index: 2 }, background: piNeutral.background, attributes: 0 } },
      { start: 2, end: 3, style: piNeutral },
    ]);
  }
});

test('syntax work preparation pins exact text through classifier removal and releases on unwind', () => {
  const { client, sources } = fixture(), d = demand('old');
  const emptyBytes = sources.stats().retention.retainedBytes; let pinnedBytes = 0, pinnedText: string | undefined;
  const prepare = sources.piPreparation.bind(sources);
  let held: ReturnType<typeof sources.piPreparation>;
  sources.piPreparation = (...args) => held = prepare(...args);
  assert.equal(requestSyntax(client, d, text => {
    assert.equal(held?.text, text); assert.ok(held);
    sources.removePiSource(d.key);
    pinnedText = held.text; pinnedBytes = held.budget.stats().retainedBytes;
    assert.equal(held.budget.reserve(held.budget.limit), undefined);
    return ['old'];
  }).outcome, 'stale');
  assert.equal(pinnedText, 'old'); assert.equal(pinnedBytes - emptyBytes, 166);
  assert.equal(held?.text, undefined); assert.equal(held?.budget.stats().retainedBytes, emptyBytes);
  assert.equal(held?.budget.stats().outstandingPeakBytes, 0);
});

test('syntax work palette reentrancy cannot publish old converted data or mark a replacement failure', () => {
  const { client, sources } = fixture(), d = demand();
  assert.equal(requestSyntax(client, d, () => {
    assert.equal(requestSyntax(client, { ...d, palette: 2 }, () => ['\x1b[34mx']).outcome, 'pi');
    return ['\x1b[31mx'];
  }).outcome, 'stale');
  assert.equal(sources.piProjection(d.key, 1, 1), undefined);
  assert.deepEqual(piSpans(sources.piProjection(d.key, 1, 2))?.[0]?.style.foreground, { kind: 'indexed', index: 4 });
  assert.equal(sources.piFailure(d.key, 1, 2), undefined);
  assert.equal(sources.stats().retention.outstandingPeakBytes, 0);
});

test('syntax work inspected ANSI is funded throughout conversion and staging receives the same hook', () => {
  const { client, sources } = fixture(), d = demand();
  const prepare = sources.piPreparation.bind(sources), reserve = sources.reservePiData.bind(sources);
  let held: ReturnType<typeof sources.piPreparation>, baseline = 0, fundedReads = 0, stages = 0;
  const line = '\x1b[31mx', ansiBytes = 64 + 40 + line.length * 2;
  sources.piPreparation = (...args) => { held = prepare(...args); baseline = held!.budget.stats().retainedBytes; return held; };
  const peaks: number[] = [];
  sources.reservePiData = (ticket, bytes) => {
    assert.equal(ticket, held); peaks.push(bytes);
    if (peaks.length > 1) assert.ok(ticket.budget.stats().retainedBytes >= baseline + ansiBytes);
    return reserve(ticket, bytes);
  };
  const budget = new DataBudget(10000), probe = preparePiFlat('', () => true, neutral, budget);
  assert.equal(probe.outcome, 'ready'); if (probe.outcome !== 'ready') return;
  const prototype = Object.getPrototypeOf(probe.projection), stage = prototype.stage;
  prototype.stage = function(hook: unknown) { stages++; assert.equal(typeof hook, 'function'); return stage.call(this, hook); };
  try {
    const rows = new Proxy([line], { get(target, property, receiver) {
      if (property === '0' && peaks.length) { fundedReads++; assert.ok(held!.budget.stats().retainedBytes >= baseline + ansiBytes); }
      return Reflect.get(target, property, receiver);
    } });
    assert.equal(requestSyntax(client, d, () => rows).outcome, 'pi');
  } finally { prototype.stage = stage; probe.projection.dispose(); }
  assert.equal(stages, 1); assert.ok(fundedReads > 0); assert.equal(peaks[0], ansiBytes);
  assert.ok(peaks.length > 3); assert.equal(held?.text, undefined);
  assert.equal(budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ sourceWorkFunding: { ansiBytes, peaks, fundedReads, stages } }));
});

for (const point of ['conversion', 'staging', 'adoption'] as const) {
  test(`syntax work ${point} exception releases ticket, transient ANSI and every abandoned candidate`, () => {
    const { client, sources } = fixture(), d = demand();
    const emptyBytes = sources.stats().retention.retainedBytes;
    const prepare = sources.piPreparation.bind(sources), reserve = sources.reservePiData.bind(sources);
    let held: ReturnType<typeof sources.piPreparation>, baseline = 0, reservations = 0;
    sources.piPreparation = (...args) => { held = prepare(...args); baseline = held!.budget.stats().retainedBytes; return held; };
    sources.reservePiData = (ticket, bytes) => {
      if (point === 'conversion' && ++reservations === 2) throw new Error('conversion');
      return reserve(ticket, bytes);
    };
    const budget = new DataBudget(10000), probe = preparePiFlat('', () => true, neutral, budget);
    assert.equal(probe.outcome, 'ready'); if (probe.outcome !== 'ready') return;
    const prototype = Object.getPrototypeOf(probe.projection), stage = prototype.stage;
    let abandoned: typeof probe.projection | undefined;
    if (point === 'staging') prototype.stage = function() { abandoned = this; throw new Error('staging'); };
    if (point === 'adoption') sources.adoptPiFlat = () => { throw new Error('adoption'); };
    try { assert.throws(() => requestSyntax(client, d, highlight), new RegExp(point)); }
    finally { prototype.stage = stage; probe.projection.dispose(); }
    assert.equal(abandoned?.isValid, point === 'staging' ? false : undefined);
    assert.equal(held?.text, undefined);
    assert.equal(held?.budget.stats().outstandingPeakBytes, 0);
    assert.equal(held?.budget.stats().retainedBytes, baseline - 128);
    sources.removePiSource(d.key);
    assert.equal(held?.budget.stats().retainedBytes, emptyBytes);
  });
}


test('syntax work inspected ANSI refusal preserves an older ready palette without warm retries', () => {
  const { client, sources } = fixture(false, { retention: { maxBytes: 5000 } }), d = demand();
  assert.equal(requestSyntax(client, d, highlight).outcome, 'pi');
  const old = resolveSyntax(sources, d).pi; assert.ok(old);
  const reserve = sources.reservePiData.bind(sources); const peaks: number[] = []; let calls = 0;
  sources.reservePiData = (ticket, bytes) => { peaks.push(bytes); return reserve(ticket, bytes); };
  const next = { ...d, palette: 2 };
  const oversized = () => { calls++; return ['\x1b[31m'.repeat(800) + 'x']; };
  assert.equal(requestSyntax(client, next, oversized).outcome, 'refused');
  assert.equal(peaks.length, 1); assert.ok(peaks[0]! > 5000);
  const before = sources.stats();
  for (let i = 0; i < 30; i++) assert.equal(requestSyntax(client, next, oversized).outcome, 'refused');
  assert.deepEqual(sources.stats(), before); assert.equal(calls, 1); assert.equal(peaks.length, 1);
  assert.deepEqual(piSpans(old)?.[0]?.style.foreground, { kind: 'indexed', index: 1 });
  assert.equal(requestSyntax(client, d, oversized).outcome, 'pi'); assert.equal(calls, 1);
});

test('syntax work source retirement during a conversion reservation abandons all charged data', () => {
  const { client, sources } = fixture(), d = demand();
  const emptyBytes = sources.stats().retention.retainedBytes;
  const reserve = sources.reservePiData.bind(sources), prepare = sources.piPreparation.bind(sources);
  let held: ReturnType<typeof sources.piPreparation>, calls = 0, pinnedBytes = 0;
  sources.piPreparation = (...args) => held = prepare(...args);
  sources.reservePiData = (ticket, bytes) => {
    if (++calls === 2) { sources.removePiSource(d.key); pinnedBytes = ticket.budget.stats().retainedBytes; }
    return reserve(ticket, bytes);
  };
  assert.equal(requestSyntax(client, d, highlight).outcome, 'stale');
  assert.equal(calls, 2); assert.ok(pinnedBytes > emptyBytes + 164, 'source ticket and inspected ANSI coexist during callback');
  assert.equal(held?.text, undefined); assert.equal(held?.budget.stats().retainedBytes, emptyBytes);
  assert.equal(held?.budget.stats().outstandingPeakBytes, 0); assert.equal(resolveSyntax(sources, d).pi, undefined);
});


test('syntax work legal SOURCE restart_required recovers parser independently of STYLE permission', async () => {
  const { client, sources, host } = fixture(true); let calls = 0;
  const classify = () => { calls++; return ['unused']; };
  const first = demand('a\n', 1, false);
  requestSyntax(client, first, classify); sources.flush(); await host.answer(0, first.text, false);
  assert.equal(requestSyntax(client, first, classify).outcome, 'native');
  const next = demand('a\nb', 2, false);
  requestSyntax(client, next, classify); sources.flush();
  assert.equal(host.calls[1]?.request.op, 'stream.append');
  host.fault(1, 'restart_required'); await settled();
  assert.equal(host.calls[2]?.request.op, 'stream.close');
  await host.answer(2, '');
  assert.equal(host.calls.length, 4); assert.equal(host.calls[3]?.request.op, 'stream.open');
  assert.equal(sources.stats().restarts, 1);
  assert.equal(resolveSyntax(sources, next).needsPi, false);
  await host.answer(3, next.text, false);
  assert.equal(resolveSyntax(sources, next).nativeExact, true);
  assert.equal(calls, 0); assert.equal(host.calls.length, 4);
});

test('syntax work bounds native finite source and aliases suffix-only growth without work', async t => {
  const { client, sources, host } = fixture(true);
  const prefix = 'x'.repeat(64 * 1024), classify = () => { assert.fail('Bash must stay neutral'); };
  const first = { ...demand(prefix + 'tail', 1, false), fallback: 'neutral' as const };
  requestSyntax(client, first, classify); sources.flush();
  assert.equal(host.calls[0]!.request.op, 'highlight');
  assert.equal((host.calls[0]!.request.sources as { text: string }[])[0]!.text, prefix);
  await host.answer(0, prefix);
  const before = sources.stats(), styles = host.styles.length;
  let encodes = 0;
  t.mock.method(Buffer, 'from', new Proxy(Buffer.from, { apply(target, receiver, args) {
    if (typeof args[0] === 'string' && args[0].length >= prefix.length) encodes++;
    return Reflect.apply(target, receiver, args);
  } }));
  assert.equal(requestSyntax(client, { ...first, text: prefix + 'longer tail', version: 2 }, classify).outcome, 'native');
  sources.flush(); await settled();
  assert.equal(host.calls.length, 1); assert.equal(host.styles.length, styles); assert.equal(encodes, 0);
  assert.equal(sources.stats().preparedBytes, before.preparedBytes);
  assert.equal(sources.stats().styleEncodes, before.styleEncodes);
  assert.equal(sources.borrowSource(first.key)?.version, 2);
  assert.equal(sources.borrowSource(first.key)?.text, prefix);
  requestSyntax(client, { ...first, text: 'y' + prefix.slice(1) + 'tail', version: 3 }, classify); sources.flush();
  assert.equal(host.calls.length, 2);
 });

test('syntax work Pi classifies only its scalar-safe prefix and aliases the unclassified suffix', () => {
  const { client, sources } = fixture(); const seen: string[] = [];
  const classify = (text: string) => { seen.push(text); return highlight(text); };
  const prefix = 'x'.repeat(8190) + 'é', first = demand(prefix + '😀tail');
  assert.equal(requestSyntax(client, first, classify).outcome, 'pi');
  assert.deepEqual(seen, [prefix]);
  const before = sources.stats();
  assert.equal(requestSyntax(client, { ...first, version: 2, text: prefix + 'other tail' }, classify).outcome, 'pi');
  assert.deepEqual(seen, [prefix]); assert.equal(sources.stats().preparedBytes, before.preparedBytes);
  assert.equal(sources.borrowPiSource(first.key)?.text, prefix);
  assert.equal(sources.piProjection(first.key, 2, 1)?.sourceBytes, 8192);
  requestSyntax(client, { ...first, version: 3, text: 'y' + first.text.slice(1) }, classify);
  assert.equal(seen.length, 2);
 });

test('syntax work saturation finalizes an existing native stream without claiming its visible suffix', async () => {
  const { client, sources, host } = fixture(true);
  const first = { ...demand('x\n', 1, false), fallback: 'neutral' as const };
  requestSyntax(client, first, () => assert.fail('Bash classifier')); sources.flush();
  assert.equal(host.calls[0]!.request.op, 'stream.open'); await host.answer(0, 'x\n', false);
  assert.equal(sources.stats().remoteLeases, 1);
  const prefix = 'x\n' + 'a'.repeat(65534), latest = { ...first, version: 2, text: prefix + 'not parsed' };
  requestSyntax(client, latest, () => assert.fail('Bash classifier')); sources.flush();
  assert.equal(host.calls[1]!.request.op, 'stream.append'); assert.equal(host.calls[1]!.request.final, true);
  assert.equal(host.calls[1]!.request.append, prefix.slice(2));
  await host.answer(1, prefix);
  for (let i = 2; i < host.calls.length; i++) if (host.calls[i]!.request.op === 'stream.close') host.source(i, '');
  await settled();
  assert.equal(sources.stats().remoteLeases, 0);
  assert.equal(sources.borrowSource(first.key)?.text, prefix);
  assert.equal(sources.status(first.key)?.committedBytes, 65536);
  assert.equal(resolveSyntax(sources, latest).nativeExact, true); // Exact submitted source only.
});
