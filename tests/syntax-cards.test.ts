import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { CardSources, type CardSourceInput } from '../src/syntax/cards.ts';
import { SourceController, type ControllerOptions } from '../src/occipital/controller.ts';
import type { SyntaxClient } from '../src/occipital/client.ts';
import type { SyntaxTheme } from '../src/settings.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import { PROTOCOL_VERSION, type Description } from '../src/occipital/protocol.ts';
import { highlightCode, initTheme } from '@earendil-works/pi-coding-agent';
import { theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { renderFileCard, renderPreparedFileCard } from '../src/file-card.ts';
import { renderBashCard } from '../src/bash-card.ts';
import { stripVTControlCharacters } from 'node:util';

initTheme('dark', false);
const profile = { id: 'pi', label: 'Pi', fingerprint: 'a'.repeat(64) };
const description: Description = {
  instance: 'daemon', assets: 'assets', backend_version: 'test', catalogue_revision: 0, profiles: [profile], diagnostic: null,
  limits: { request_bytes: OCCIPITAL_LIMITS.wireBytes, reply_bytes: OCCIPITAL_LIMITS.wireBytes,
    control_request_bytes: 4096, control_reply_bytes: 32768, source_bytes: OCCIPITAL_LIMITS.sourceBytes,
    line_bytes: 65536, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: OCCIPITAL_LIMITS.retainedBytes,
    leases: 4096, leases_per_route: 512, runs: OCCIPITAL_LIMITS.runs, styles: OCCIPITAL_LIMITS.styles,
    idle_ms: 300000, age_ms: 3600000, quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 },
  runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 }
};
type Owner = { input?: CardSourceInput };
const bash = (command: string, complete = false, palette = 1): CardSourceInput =>
  ({ kind: 'bash', args: { command, description: 'not source' }, complete, palette, language: 'bash' });
const file = (path = 'a.ts'): CardSourceInput => ({ kind: 'file', palette: 1, language: 'typescript', node: {
  toolName: 'edit', args: { path }, isPartial: false, result: { details: { diff: '-1 \tx\n+1 \ty\n   ...\n-9 a\n+9 b' } }
} });
const written = (content: string, path = 'a.ts', language = 'typescript'): CardSourceInput =>
  ({ kind: 'file', palette: 1, language, node: { toolName: 'write', args: { path, content }, isPartial: false, result: {} } });
const fixtures: { cards: CardSources<Owner>; sources: SourceController; calls: { resolve(value: unknown): void }[] }[] = [];
function fixture(ready = false, retention?: { maxBytes: number }, maxBookkeepingBytes?: number, controllerOptions: ControllerOptions = {},
  classify?: (text: string, hints: { language?: string; path?: string }) => readonly string[]) {
  const calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] = [];
  const env = { ready, generation: 1, enabled: true, selected: { kind: 'pi' } as SyntaxTheme, profile: { ...profile }, reads: 0, classifications: [] as { text: string; language?: string; path?: string }[],
    invalidated: [] as Owner[], redraws: 0, failClassification: false, notices: [] as string[][] };
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: env.generation, availability: env.ready ? 'ready' : env.generation === 1 ? 'initializing' : 'unavailable',
      reason: env.ready ? 'ready' : env.generation === 1 ? 'initializing' : 'transport_closed', initialShared: false, kind: 'owned', description: env.ready ? { ...description, profiles: env.profile.id === 'pi' ? [env.profile] : [profile, env.profile] } : undefined }; },
    isReady(g: number) { return env.ready && g === env.generation; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) { return new Promise<unknown>(resolve => calls.push({ request, resolve })); }
  };
  let cards: CardSources<Owner>;
  const sources = new SourceController(provider, { ...controllerOptions, retention, onChange: keys => { env.notices.push([...keys]); cards.sourceChanged(keys); } });
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> = { sources, snapshot: () => ({ enabled: env.enabled,
    provider: provider.snapshot(), standaloneVersion: 'test', selected: env.selected, effective: env.ready ? env.profile : undefined }) };
  cards = new CardSources(client, { read: owner => { env.reads++; return owner.input; },
    classify: (text, info) => { env.classifications.push({ text, ...info }); if (env.failClassification) throw new Error('classifier failed'); return classify ? classify(text, info) : text.split('\n'); },
    invalidate: owner => env.invalidated.push(owner), requestRender: () => { env.redraws++; } }, { maxBookkeepingBytes });
  const value = { env, calls, sources, cards };
  fixtures.push(value); return value;
}
async function settled() { await turn(); }
function fault(f: ReturnType<typeof fixture>, index: number, code = 'busy') {
  const call = f.calls[index]!;
  call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: 'daemon', assets: 'assets', status: 'error', error: { code, execution: 'not_started' } });
}
afterEach(async () => {
  for (const f of fixtures) { f.cards.dispose(); f.sources.dispose(); }
  for (let i = 0; i < 5; i++) { for (const f of fixtures) for (const call of f.calls) call.resolve({}); await settled(); }
  for (const f of fixtures) assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  fixtures.length = 0;
});

test('cards cache actual Pi system faint fallback once across warm visits and widths', async () => {
  initTheme('system', false);
  try {
    const source = 'const x=1; // x';
    const f = fixture(false, undefined, undefined, {}, (text, info) => highlightCode(text, info.language));
    const owner: Owner = { input: written(source) };
    f.cards.useful(owner, 1); await settled();
    assert.equal(f.env.classifications.length, 1);
    assert.equal(f.sources.stats().piSourceRecords, 1);
    for (const width of [24, 60, 100, 24]) {
      f.cards.useful(owner, 1);
      const projection = f.cards.file(owner, theme, 0x40dddddd)!;
      assert.ok(projection.styledRows.get(0)!.includes('\x1b[2m'), 'cached actual faint rows survive the full consumer');
      const layout = renderPreparedFileCard(projection.display, undefined, width, theme, { styledRows: projection.styledRows });
      assert.ok(layout.rows.join('').includes('const'));
      await settled();
    }
    assert.equal(f.env.classifications.length, 1, 'warm consumer preparation does not repeat Pi classification');
    assert.equal(f.calls.length, 0, 'no native request/helper in this fallback control');
  } finally { initTheme('dark', false); }
});

test('cards coalesce useful incomplete source and finalize equal text independently of execution', async () => {
  const f = fixture(), owner: Owner = { input: bash('a') };
  f.cards.useful(owner, 1); owner.input = bash('a\tb\n'); f.cards.useful(owner, 2);
  assert.equal(f.env.reads, 0); assert.equal(f.env.classifications.length, 0);
  await settled(); assert.equal(f.env.reads, 1);
  assert.equal(f.env.classifications.length, 0);
  owner.input = bash('a\tb\n', true); f.cards.record(owner, 3, true); await settled();
  assert.equal(f.env.classifications.length, 0);
  assert.equal(f.cards.identities(owner)[0]!.version, 2);
  assert.equal(f.cards.identities(owner)[0]!.fallback, 'neutral');
  assert.equal(f.sources.stats().piSourceRecords, 0);
  assert.equal(f.cards.identities(owner)[0]!.complete, true);
});

test('cards spaced Bash updates remain whole-command neutral even for explicit useful demand', async () => {
  const f = fixture(), owner: Owner = { input: bash('a') };
  f.cards.record(owner, 1, false); await settled(); assert.equal(f.env.reads, 0);
  f.cards.useful(owner, 1); await settled(); assert.equal(f.env.classifications.length, 0);
  owner.input = bash('ab'); f.cards.record(owner, 2, false); await settled();
  owner.input = bash('abc'); f.cards.record(owner, 3, false); await settled();
  assert.equal(f.env.classifications.length, 0); assert.equal(f.env.reads, 1);
  f.cards.useful(owner, 3); await settled(); assert.equal(f.env.classifications.length, 0);
  owner.input = bash('abcd', true); f.cards.record(owner, 4, true); await settled();
  assert.equal(f.env.classifications.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0);
  const before = f.env.reads; f.cards.useful(owner, 4); await settled(); assert.equal(f.env.reads, before);
});

test('cards neutral Bash preparation preserves the painted layout during startup and off', async () => {
  for (const enabled of [true, false]) {
    const f = fixture(); f.env.enabled = enabled;
    if (!enabled) f.sources.setEnabled(false);
    const owner: Owner = { input: bash('x', true) };
    assert.equal(f.cards.bash(owner, 20, theme, 0), undefined);
    f.cards.useful(owner, 1); await settled();
    assert.equal(f.env.reads, 1); assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0);
    assert.equal(f.cards.identities(owner)[0]!.complete, true);
    assert.equal(f.cards.bash(owner, 20, theme, 0), undefined);
    assert.deepEqual(f.env.invalidated, [], 'preparing the same neutral command does not evict its painted layout');
    assert.equal(f.env.redraws, 0, 'neutral preparation adds no duplicate host frame');
  }
});

test('cards render cold/warm geometry and gap/side mapping without source work', async () => {
  const f = fixture(), owner: Owner = { input: file() };
  assert.equal(f.cards.file(owner, theme, 0x40000000), undefined);
  f.cards.useful(owner, 1); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['\tx', 'a', '\ty', 'b']);
  let observes = 0, captures = 0;
  const observe = f.sources.observe.bind(f.sources), capture = f.sources.capturePiSource.bind(f.sources);
  f.sources.observe = (...args) => { observes++; return observe(...args); };
  f.sources.capturePiSource = (...args) => { captures++; return capture(...args); };
  const counts = [f.env.reads, f.env.classifications.length, f.sources.stats().dispatches, observes, captures];
  for (const width of [9, 60, 121]) {
    f.cards.useful(owner, 1);
    const projection = f.cards.file(owner, theme, 0x40000000)!;
    const actual = renderPreparedFileCard(projection.display, undefined, width, theme, { styledRows: projection.styledRows });
    const expected = renderFileCard((owner.input as Extract<CardSourceInput, { kind: 'file' }>).node, undefined, width, theme)!;
    assert.deepEqual(actual.rows.map(stripVTControlCharacters), expected.rows.map(stripVTControlCharacters));
    assert.equal(stripVTControlCharacters(projection.styledRows.get(0)!).trim(), 'x'); assert.equal(stripVTControlCharacters(projection.styledRows.get(1)!).trim(), 'y');
  }
  await settled(); assert.deepEqual([f.env.reads, f.env.classifications.length, f.sources.stats().dispatches, observes, captures], counts);
  const shell: Owner = { input: bash('a\tb\nc', true) }; f.cards.useful(shell, 1); await settled();
  for (const width of [12, 60]) for (const expanded of [false, true]) {
    const node = { args: { command: 'a\tb\nc' }, expanded, isPartial: true };
    const expected = renderBashCard(node, undefined, width, theme);
    const actual = renderBashCard(node, undefined, width, theme, 1, f.cards.bash(shell, expected.geometry.contentWidth, theme, 0x40000000));
    assert.deepEqual(actual.rows.map(stripVTControlCharacters), expected.rows.map(stripVTControlCharacters));
  }
});

test('cards queued and off-held work veto duplicate Pi; keyed no-start notice permits useful fallback', async () => {
  const f = fixture(true), owner: Owner = { input: written('x') }, peer: Owner = { input: written('y') };
  f.cards.useful(owner, 1); f.cards.useful(peer, 1); await settled();
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 2);
  f.env.invalidated.length = 0;
  const refused = f.calls.findIndex(call => (call.request.sources as { text: string }[])[0]!.text === 'x');
  fault(f, refused); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  assert.deepEqual(f.env.invalidated, [owner]);
  f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); await settled();
  assert.equal(f.env.classifications.length, 1);
  f.sources.ownedStopped(1); await settled(); assert.deepEqual(f.env.classifications.map(x => x.text), ['x', 'y']);
});

test('cards metadata upgrade touches only latest still-current useful demand and typed profile retry is keyed', async () => {
  const f = fixture(), first: Owner = { input: written('a') }, last: Owner = { input: written('b') };
  f.cards.useful(first, 1); f.cards.useful(last, 1); await settled();
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.equal(f.calls.length, 1); assert.equal((f.calls[0]!.request.sources as { text: string }[])[0]!.text, 'b');
  f.cards.metadataChanged(); await settled(); assert.equal(f.calls.length, 1);
  fault(f, 0, 'profile_changed'); await settled();
  const need = f.sources.profileReconciliationNeeded()!; assert.ok(need);
  f.sources.acknowledgeProfiles(need.generation, need.sequence); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.env.classifications.length, 2);
});

test('cards source path language and palette revisions keep exact identities current', async () => {
  const f = fixture(), owner: Owner = { input: file() };
  f.cards.useful(owner, 1); await settled(); const initial = f.cards.identities(owner);
  owner.input = { ...file('b.js'), language: 'javascript', palette: 2 }; f.cards.useful(owner, 2); await settled();
  assert.equal(f.cards.identities(owner)[0]!.key, initial[0]!.key);
  assert.equal(f.cards.identities(owner)[0]!.version, 2);
  assert.deepEqual(f.env.classifications.slice(4).map(x => [x.path, x.language]), Array(4).fill(['b.js', 'javascript']));
});

test('cards eviction/refusal and cached failure never cause warm frame retry spin', async () => {
  const f = fixture(false, { maxBytes: 128 }), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); await settled(); assert.equal(f.env.classifications.length, 0);
  for (let i = 0; i < 5; i++) { f.cards.useful(owner, 1); f.cards.file(owner, theme, 0x40000000); f.cards.sourceChanged(f.cards.identities(owner).map(x => x.key)); }
  await settled(); assert.equal(f.env.reads, 1); assert.equal(f.env.classifications.length, 0);
  const e = fixture(false, { maxBytes: 1400 }), a: Owner = { input: written('x') }, b: Owner = { input: written('y') };
  e.cards.useful(a, 1); await settled(); e.cards.useful(b, 1); await settled();
  assert.equal(e.sources.borrowPiSource(e.cards.identities(a)[0]!.key), undefined, 'peer admission evicts prior snapshot');
  const before = e.env.reads;
  for (let i = 0; i < 5; i++) e.cards.useful(a, 1);
  await settled(); assert.equal(e.env.reads, before);
  const failed = fixture(); failed.env.failClassification = true;
  const bad: Owner = { input: written('x') }; failed.cards.useful(bad, 1); await settled();
  for (let i = 0; i < 5; i++) { failed.cards.useful(bad, 1); failed.cards.sourceChanged(failed.cards.identities(bad).map(x => x.key)); }
  await settled(); assert.equal(failed.env.classifications.length, 1);
  assert.equal(failed.sources.piFailure(failed.cards.identities(bad)[0]!.key, 1, 1), 'threw');
});

test('cards removal disposal and reentrant replacement cannot resurrect pending ownership', async () => {
  const f = fixture(), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); f.cards.remove(owner); await settled(); assert.equal(f.env.reads, 0);
  f.cards.useful(owner, 2); await settled(); const key = f.cards.identities(owner)[0]!.key;
  f.cards.remove(owner); assert.equal(f.sources.borrowPiSource(key), undefined);
  f.cards.useful(owner, 3); f.cards.dispose(); await settled(); assert.equal(f.env.reads, 1);
  const r = fixture(), o: Owner = { input: written('a') };
  const capture = r.sources.capturePiSource.bind(r.sources);
  r.sources.capturePiSource = (...args) => { r.cards.remove(o); return capture(...args); };
  r.cards.useful(o, 1); await settled(); assert.deepEqual(r.cards.identities(o), []);
  assert.equal(r.sources.stats().piSourceRecords, 0);
});

async function firstOwner(f: ReturnType<typeof fixture>, input = written('x')) {
  const owner: Owner = { input }; f.cards.useful(owner, 1); await settled();
  return { weak: new WeakRef(owner), key: f.cards.identities(owner)[0]!.key };
}
test('cards first active owner collects and releases keys with consumer and peer live', { skip: !global.gc }, async () => {
  const f = fixture(), first = await firstOwner(f), peer: Owner = { input: written('y') };
  // Presentation callbacks in this test deliberately store owners; clear that test-only retention.
  f.env.invalidated.length = 0; f.cards.useful(peer, 1); await settled(); f.env.invalidated.length = 0;
  assert.ok(f.sources.borrowPiSource(first.key)); assert.equal(f.sources.stats().piSourceRecords, 2);
  let collected = false;
  for (let i = 0; i < 40; i++) { await settled(); global.gc!(); await settled(); if (!first.weak.deref()) { collected = true; break; } }
  assert.equal(collected, true); await settled(); assert.equal(f.sources.borrowPiSource(first.key), undefined);
  assert.equal(f.sources.stats().piSourceRecords, 1);
  assert.equal(f.cards.file(peer, theme, 0x40000000)!.styledRows.size, 1);
});

function answer(f: ReturnType<typeof fixture>, index: number, text: string, complete: boolean) {
  const call = f.calls[index]!, r = call.request;
  const source = r.op === 'stream.append' ? r : (r.sources as Record<string, unknown>[])[0]!;
  const bytes = Buffer.byteLength(text), from = r.op === 'stream.append' ? r.base_bytes as number : 0;
  call.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'source', sources: [{ key: source.key, generation: source.generation, source_version: source.source_version,
      profile: source.profile, fingerprint: source.fingerprint, revision: r.op === 'stream.append' ? (r.base_revision as number) + 1 : 1,
      replace_from: from, source_bytes: bytes, committed_bytes: bytes, complete,
      ...(r.op !== 'highlight' ? { lease: 'lease' } : {}), styles: source.profile === 'pi' ? [{ role: 'syntaxKeyword' }] : [{ rgb: [17, 34, 51], attributes: 0 }], runs: bytes > from ? [bytes - from, 0] : [],
      counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }]
  } });
}

test('cards native equal-text completion flushes final append after an in-flight reply', async () => {
  const f = fixture(true), owner: Owner = { input: bash('x\n') };
  f.cards.useful(owner, 1); await settled(); assert.equal(f.calls[0]!.request.op, 'stream.open');
  owner.input = bash('x\n', true); f.cards.record(owner, 2, true); await settled();
  assert.equal(f.calls.length, 1); assert.equal(f.env.classifications.length, 0);
  answer(f, 0, 'x\n', false); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.op, 'stream.append');
  assert.equal(f.calls[1]!.request.append, ''); assert.equal(f.calls[1]!.request.final, true);
  const before = f.env.redraws;
  answer(f, 1, 'x\n', true); await settled();
  assert.equal(f.env.redraws, before + 1); assert.equal(f.env.classifications.length, 0);
  const rows = f.cards.bash(owner, 10, theme, 0x40000000)!;
  assert.deepEqual(rows.map(stripVTControlCharacters), ['$ x', '']); assert.ok(rows.join('').includes(theme.fg('syntaxKeyword', 'x')));
  owner.input = bash('x\n', true, 2); f.cards.useful(owner, 3); await settled();
  assert.equal(f.calls.length, 2, 'Pi palette change never requests native parsing');
  assert.equal(f.env.classifications.length, 0);
});

test('cards deferred obsolete source reply never paints replacement and only current keys invalidate', async () => {
  const f = fixture(true), owner: Owner = { input: bash('x\n') }, peer: Owner = { input: bash('p', true) };
  f.cards.useful(owner, 1); f.cards.useful(peer, 1); await settled();
  owner.input = bash('y', true); f.cards.useful(owner, 2); await settled();
  f.env.invalidated.length = 0;
  const obsolete = f.calls.findIndex(call => call.request.op === 'stream.open');
  answer(f, obsolete, 'x\n', false); await settled();
  assert.equal(f.cards.bash(owner, 10, theme, 0x40000000), undefined);
  assert.equal(f.env.classifications.length, 0);
  const close = f.calls.find(call => call.request.op === 'stream.close');
  if (close) { close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled(); }
  const replacement = f.calls.findIndex((call, i) => i > 1 && call.request.op === 'highlight');
  assert.ok(replacement >= 0); answer(f, replacement, 'y', true); await settled();
  assert.deepEqual(f.cards.bash(owner, 10, theme, 0x40000000)!.map(stripVTControlCharacters), ['$ y']);
  assert.ok(f.env.invalidated.length > 0); assert.ok(f.env.invalidated.every(x => x === owner));
});

test('cards pending primitive ticket/source-key admission uses existing allowance and refuses without warm retries', async () => {
  const f = fixture(false, undefined, 1024), owner: Owner = { input: bash('x') }, peer: Owner = { input: bash('y') };
  f.cards.useful(owner, 1); f.cards.useful(peer, 1); await settled();
  assert.equal(f.env.reads, 1); assert.equal(f.env.classifications.length, 0);
  for (let i = 0; i < 5; i++) { f.cards.useful(owner, 1); f.cards.useful(peer, 1); }
  await settled(); assert.equal(f.env.reads, 1);
  f.cards.remove(owner); f.cards.useful(peer, 2); await settled(); assert.equal(f.env.reads, 2);
});

test('cards metadata upgrade follows recorded latest revision but rejects a retired owner at flush', async () => {
  const f = fixture(), owner: Owner = { input: bash('a') };
  f.cards.useful(owner, 1); await settled();
  owner.input = bash('ab'); f.cards.record(owner, 2, false); await settled();
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.equal((f.calls[0]!.request.sources as { text: string }[])[0]!.text, 'ab');
  f.env.ready = false; owner.input = undefined; f.cards.record(owner, 3, true); f.cards.metadataChanged(); await settled();
  assert.deepEqual(f.cards.identities(owner), []);
  f.env.ready = true; f.cards.metadataChanged(); await settled(); assert.equal(f.calls.length, 1);
});

test('cards first active pending native owner collects with a pending peer and consumer live', { skip: !global.gc }, async () => {
  const f = fixture(true), first = await firstOwner(f, bash('x')), peer: Owner = { input: bash('y') };
  f.env.invalidated.length = 0; f.cards.useful(peer, 1); await settled(); f.env.invalidated.length = 0;
  assert.equal(f.calls.length, 2);
  let collected = false;
  for (let i = 0; i < 40; i++) { await settled(); global.gc!(); await settled(); if (!first.weak.deref()) { collected = true; break; } }
  assert.equal(collected, true); await settled(); assert.equal(f.sources.borrowSource(first.key), undefined);
  assert.ok(f.sources.borrowSource(f.cards.identities(peer)[0]!.key));
});

test('cards successful final write source uses existing display; failed partial malformed and host-ineligible files do no work', async () => {
  const f = fixture();
  const write: Owner = { input: { kind: 'file', language: 'typescript', palette: 1, node: {
    toolName: 'write', args: { path: 'a.ts', content: '\tx' }, isPartial: false, result: {}
  } } };
  f.cards.useful(write, 1); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['\tx']);
  assert.equal(f.cards.file(write, theme, 0x40000000)!.display.label, 'Wrote');
  for (const node of [
    { toolName: 'write', args: { path: 'a.ts', content: 'x' }, isPartial: true, result: {} },
    { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { isError: true, details: { diff: '+1 x' } } },
    { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { details: { diff: 'bad' } } }
  ]) {
    const owner: Owner = { input: { kind: 'file', palette: 1, node } }; f.cards.useful(owner, 1); await settled();
    assert.equal(f.cards.file(owner, theme, 0x40000000), undefined);
  }
  const native: Owner = {}; f.cards.useful(native, 1); await settled();
  assert.equal(f.env.classifications.length, 1);
});

test('cards LF display path and unsupported wire hints preserve full file glyphs and peer progress', async () => {
  const f = fixture(true), path = 'a\n.ts';
  const owner: Owner = { input: written('x', path, 'type\nscript') }, peer: Owner = { input: written('y', 'p.ts') };
  f.cards.useful(owner, 1); f.cards.useful(peer, 1); await settled();
  assert.equal(f.env.reads, 2); assert.equal(f.calls.length, 2); assert.equal(f.env.classifications.length, 0);
  const ownerCall = f.calls.findIndex(call => (call.request.sources as { text: string }[])[0]!.text === 'x');
  const peerCall = f.calls.findIndex(call => (call.request.sources as { text: string }[])[0]!.text === 'y');
  const submitted = (f.calls[ownerCall]!.request.sources as { hint: Record<string, string>; text: string }[])[0]!;
  assert.deepEqual(submitted.hint, {}); assert.equal(submitted.text, 'x');
  const other = (f.calls[peerCall]!.request.sources as { hint: Record<string, string>; text: string }[])[0]!;
  assert.deepEqual(other.hint, { language: 'typescript', path: 'p.ts' }); assert.equal(other.text, 'y');
  const projection = f.cards.file(owner, theme, 0x40000000)!;
  assert.equal(projection.display.path, path); assert.equal(projection.display.lines[0]!.kind, ' ');
  assert.ok('text' in projection.display.lines[0]! && projection.display.lines[0].text === 'x');
  const baseline = renderFileCard((owner.input as Extract<CardSourceInput, { kind: 'file' }>).node, undefined, 60, theme)!;
  assert.deepEqual(renderPreparedFileCard(projection.display, undefined, 60, theme).rows, baseline.rows);
  answer(f, ownerCall, 'x', true); answer(f, peerCall, 'y', true); await settled();
  assert.equal(stripVTControlCharacters(f.cards.file(owner, theme, 0x40000000)!.styledRows.get(0)!), 'x');
  assert.equal(stripVTControlCharacters(f.cards.file(peer, theme, 0x40000000)!.styledRows.get(0)!), 'y');
});

test('cards actual canonical local refusal notice enables exactly one FILE Pi fallback without manual retry', async () => {
  const f = fixture(true, undefined, undefined, { maxTransientBytes: 128 }), owner: Owner = { input: written('x', 'a.sh', 'bash') };
  f.cards.useful(owner, 1); await settled();
  assert.equal(f.env.classifications.length, 0, 'the asynchronous fallback respects the host-turn barrier');
  await settled();
  const key = f.cards.identities(owner)[0]!.key;
  assert.deepEqual(f.env.notices, [[key]]); assert.equal(f.calls.length, 0);
  assert.equal(f.sources.workStatus(key).fallbackEligible, true);
  assert.deepEqual(f.env.classifications.map(x => [x.text, x.language]), [['x', 'bash']]);
  assert.equal(f.sources.stats().piSourceRecords, 1);
  assert.equal(f.cards.file(owner, theme, 0x40000000)!.styledRows.size, 1);
  const counts = [f.env.reads, f.env.classifications.length, f.env.notices.length, f.sources.stats().dispatches];
  for (const width of [9, 60, 121]) {
    f.cards.useful(owner, 1); const p = f.cards.file(owner, theme, 0x40000000)!;
    renderPreparedFileCard(p.display, undefined, width, theme, { styledRows: p.styledRows });
  }
  await settled(); assert.deepEqual([f.env.reads, f.env.classifications.length, f.env.notices.length, f.sources.stats().dispatches], counts);
});

test('cards Bash neutral fallback keeps legacy full-command styling across startup off and no-start', async () => {
  const command = 'a\tb\nc';
  for (const state of ['startup', 'off', 'no-start', 'local-refusal'] as const) {
    const f = fixture(state === 'no-start' || state === 'local-refusal', undefined, undefined,
      state === 'local-refusal' ? { maxTransientBytes: 128 } : {});
    if (state === 'off') { f.env.enabled = false; f.sources.setEnabled(false); }
    const owner: Owner = { input: bash('a') };
    f.cards.useful(owner, 1); await settled();
    owner.input = bash('a\tb'); f.cards.useful(owner, 2); await settled();
    owner.input = bash(command); f.cards.useful(owner, 3); await settled();
    owner.input = bash(command, true); f.cards.record(owner, 4, true); await settled();
    if (state === 'no-start') { fault(f, 0); await settled(); if (f.calls[1]) { fault(f, 1); await settled(); } }
    assert.equal(f.env.classifications.length, 0, state); assert.equal(f.sources.stats().piSourceRecords, 0, state);
    assert.equal(f.cards.identities(owner)[0]!.fallback, 'neutral');
    assert.equal(f.cards.identities(owner)[0]!.complete, true);
    for (const width of [7, 12, 60]) for (const expanded of [false, true]) for (const outputPad of [0, 1]) {
      const node = { args: { command, description: 'description' }, expanded, isPartial: true,
        result: { content: [{ type: 'text', text: 'output' }] } };
      const expected = renderBashCard(node, undefined, width, theme, outputPad);
      const projected = f.cards.bash(owner, expected.geometry.contentWidth, theme, 0x40000000);
      assert.equal(projected, undefined, state);
      assert.deepEqual(renderBashCard(node, undefined, width, theme, outputPad, projected), expected, state);
    }
    const before = [f.env.reads, f.calls.length, f.env.classifications.length];
    f.cards.useful(owner, 4); f.cards.bash(owner, 10, theme, 0x40000000); await settled();
    assert.deepEqual([f.env.reads, f.calls.length, f.env.classifications.length], before);
  }
});

test('cards unsupported hints keep canonical held authority and neutral file display without blocking an unrelated file', async () => {
  const f = fixture(true), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); await settled(); const key = f.cards.identities(owner)[0]!.key;
  f.env.ready = false; owner.input = written('y', 'a\n.ts', 'bad\u0000hint'); f.cards.useful(owner, 2); await settled();
  assert.equal(f.sources.workStatus(key).execution, 'unsettled'); assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 1);
  const projection = f.cards.file(owner, theme, 0x40000000)!;
  assert.equal(projection.display.path, 'a\n.ts'); assert.equal(projection.styledRows.size, 0);
  assert.ok('text' in projection.display.lines[0]! && projection.display.lines[0].text === 'y');
  const peer: Owner = { input: written('z') }; f.cards.useful(peer, 1); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['z']);
  f.sources.ownedStopped(1); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['z', 'y']);
  assert.equal(f.sources.borrowPiSource(key)?.version, 2);
  assert.equal(f.cards.file(owner, theme, 0x40000000)!.display.path, 'a\n.ts');
});

test('cards actual credit wake local refusal notice triggers one FILE fallback, not polling or RPC', async () => {
  const active = fixture(true), first: Owner = { input: written('a') }, second: Owner = { input: written('b') };
  active.cards.useful(first, 1); active.cards.useful(second, 1); await settled(); assert.equal(active.calls.length, 2);
  const f = fixture(true, undefined, undefined, { maxTransientBytes: 128 }), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); await settled();
  assert.equal(f.env.notices.length, 0); assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 0);
  fault(active, 0); await settled();
  const key = f.cards.identities(owner)[0]!.key;
  assert.deepEqual(f.env.notices, [[key]]);
  await settled(); // First admission began only after global credit; its fallback is a yielded second pass.
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  assert.equal(f.calls.length, 0); assert.equal(f.sources.stats().piSourceRecords, 1);
  assert.equal(f.cards.file(owner, theme, 0x40000000)!.styledRows.size, 1);
});

test('cards reentrant consumer disposal after capture cannot publish payload or revive keys', async () => {
  const f = fixture(), owner: Owner = { input: written('x') };
  const capture = f.sources.capturePiSource.bind(f.sources);
  f.sources.capturePiSource = (...args) => { f.cards.dispose(); return capture(...args); };
  f.cards.useful(owner, 1); await settled();
  assert.deepEqual(f.cards.identities(owner), []); assert.equal(f.sources.stats().piSourceRecords, 0);
  assert.equal(f.cards.file(owner, theme, 0x40000000), undefined);
});

test('cards Bash retains validated native prefix while latest append is held without Pi fallback', async () => {
  const f = fixture(true), owner: Owner = { input: bash('x\n') };
  f.cards.useful(owner, 1); await settled(); answer(f, 0, 'x\n', false); await settled();
  owner.input = bash('x\ny'); f.cards.useful(owner, 2); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.op, 'stream.append'); assert.equal(f.calls[1]!.request.final, false);
  const rows = f.cards.bash(owner, 12, theme, 0x40000000)!;
  assert.deepEqual(rows.map(stripVTControlCharacters), ['$ x', 'y']);
  assert.ok(rows[0]!.includes(theme.fg('syntaxKeyword', 'x')));
  assert.equal(f.env.classifications.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0);
  assert.equal(f.cards.identities(owner)[0]!.fallback, 'neutral');
});

test('cards Bash off-held completion preserves canonical veto and full command style with zero Pi', async () => {
  const f = fixture(true), owner: Owner = { input: bash('x') };
  f.cards.useful(owner, 1); await settled(); const key = f.cards.identities(owner)[0]!.key;
  f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged();
  owner.input = bash('y', true); f.cards.record(owner, 2, true); await settled();
  assert.equal(f.sources.workStatus(key).execution, 'unsettled'); assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.equal(f.cards.identities(owner)[0]!.complete, true); assert.equal(f.cards.identities(owner)[0]!.fallback, 'neutral');
  assert.equal(f.cards.bash(owner, 10, theme, 0x40000000), undefined);
  assert.equal(f.env.classifications.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0); assert.equal(f.calls.length, 1);
  f.sources.ownedStopped(1); await settled();
  assert.equal(f.sources.workStatus(key).fallbackEligible, true);
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 1);
});

test('cards equal-text FILE revision aliases exact Pi classification rather than reparsing', async () => {
  const f = fixture(), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); await settled();
  owner.input = written('x'); f.cards.record(owner, 2, true); await settled();
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  assert.equal(f.sources.borrowPiSource(f.cards.identities(owner)[0]!.key)?.version, 2);
  assert.equal(f.cards.file(owner, theme, 0x40000000)!.styledRows.size, 1);
});


test('cards presentation pause holds physical work evidence and suppresses notices until useful resumption', async () => {
  const f = fixture(true), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); await settled();
  const key = f.cards.identities(owner)[0]!.key;
  f.env.invalidated.length = 0;
  f.cards.pause(owner);
  assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.equal(f.cards.file(owner, theme, 0), undefined);
  f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged();
  f.cards.record(owner, 2, true); await settled();
  assert.equal(f.env.reads, 1); assert.equal(f.env.classifications.length, 0);
  assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  f.sources.ownedStopped(1); await settled();
  assert.equal(f.env.reads, 1); assert.equal(f.env.invalidated.length, 0);
  f.cards.useful(owner, 2); await settled();
  assert.equal(f.cards.identities(owner)[0]!.key, key);
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  assert.equal(f.env.reads, 2);
  f.cards.useful(owner, 2); await settled(); assert.equal(f.env.reads, 2);
});

test('cards pause cancels a pending visit without removal and resumption uses current metadata', async () => {
  const f = fixture(), owner: Owner = { input: written('x') };
  f.cards.useful(owner, 1); f.cards.pause(owner); await settled();
  assert.equal(f.env.reads, 0);
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.equal(f.env.reads, 0);
  f.cards.useful(owner, 1); await settled();
  assert.equal(f.calls.length, 1); assert.equal(f.env.classifications.length, 0);
});


test('cards reentrant pause retains newly captured key and exact Pi bridge without granting duplicate classification', async () => {
  const f = fixture(), owner: Owner = { input: written('x') };
  const capture = f.sources.capturePiSource.bind(f.sources);
  let key = '';
  f.sources.capturePiSource = (...args) => { key = args[0]; f.cards.pause(owner); return capture(...args); };
  f.cards.useful(owner, 1); await settled();
  assert.ok(f.sources.borrowPiSource(key)); assert.equal(f.cards.file(owner, theme, 0), undefined);
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  f.sources.capturePiSource = capture;
  f.cards.useful(owner, 1); await settled();
  assert.equal(f.cards.identities(owner)[0]!.key, key);
  assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
  assert.equal(f.cards.file(owner, theme, 0x40000000)!.styledRows.size, 1);
});


for (const invalid of ['patch', 'content', 'command'] as const) {
  test(`P0 cards deferred-invalid ${invalid} preparation pauses original key instead of removing held authority`, async () => {
    const f = fixture(true), input = invalid === 'command' ? bash('x', true) : written('x');
    const owner: Owner = { input };
    const captured: string[] = [], capture = f.sources.capturePiSource.bind(f.sources);
    f.sources.capturePiSource = (...args) => { captured.push(args[0]); return capture(...args); };
    f.cards.useful(owner, 1); await settled();
    const key = f.cards.identities(owner)[0]!.key;
    assert.equal(f.calls.length, 1); assert.equal(f.sources.stats().globalUnsettledJobs, 1);
    f.cards.record(owner, 2, true);
    // Invalidate only after queuing: deferred preparation must use the latest native input.
    if (input.kind === 'file') {
      if (invalid === 'patch') input.node.result = { details: { patch: '@@ -1 +1 @@\n-x' } };
      else input.node.args.content = undefined;
    } else input.args.command = undefined;
    await settled();
    assert.equal(f.cards.identities(owner)[0]?.key, key, 'temporary failed preparation retains the same ticket/keys');
    assert.equal(f.sources.workStatus(key).fallbackEligible, false);
    assert.equal(f.calls.length, 1); assert.equal(f.env.classifications.length, 0);
    const reads = f.env.reads;
    f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); await settled();
    assert.equal(f.env.reads, reads, 'paused metadata/notice delivery does not prepare unsupported source again');
    owner.input = invalid === 'command' ? bash('x', true) : written('x');
    f.cards.useful(owner, 3); await settled();
    assert.equal(f.cards.identities(owner)[0]!.key, key);
    assert.equal(f.sources.workStatus(key).fallbackEligible, false);
    assert.equal(f.env.classifications.length, 0); assert.deepEqual(captured, []);
    assert.equal(f.sources.stats().globalUnsettledJobs, 1);
    f.sources.ownedStopped(1); await settled();
    assert.deepEqual(f.env.classifications.map(row => row.text), invalid === 'command' ? [] : ['x']);
    assert.deepEqual(captured, invalid === 'command' ? [] : [key]);
    assert.equal(f.cards.identities(owner)[0]!.key, key);
    const warm = [f.env.reads, f.calls.length, f.env.classifications.length];
    f.cards.useful(owner, 3); await settled();
    assert.deepEqual([f.env.reads, f.calls.length, f.env.classifications.length], warm);
  });
}


for (const episode of ['startup', 'connection reset'] as const) {
  test(`cards online wait: all demanded Bash cards resume after ${episode}, coalescing latest text`, async () => {
    const f = fixture(); if (episode === 'connection reset') f.env.generation = 2;
    const first: Owner = { input: bash('echo first', true) }, second: Owner = { input: bash('echo second', true) };
    f.cards.useful(first, 1); f.cards.useful(second, 1); await settled();
    first.input = bash('echo changed', true); f.cards.record(first, 2, true); await settled();
    second.input = bash('echo last', true); f.cards.record(second, 2, true); await settled();
    assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0);
    f.env.ready = true; f.cards.metadataChanged(); await settled();
    assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text).sort(), ['echo changed', 'echo last']);
    assert.ok(f.calls.every(c => c.request.op === 'highlight'));
    for (let i = 0; i < f.calls.length; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
    await settled();
    assert.ok(f.cards.bash(first, 30, theme, 0x40000000)); assert.ok(f.cards.bash(second, 30, theme, 0x40000000));
    const warm = [f.env.reads, f.calls.length, f.env.redraws];
    for (let i = 0; i < 10; i++) { f.cards.metadataChanged(); f.cards.useful(first, 2); f.cards.useful(second, 2); }
    await settled(); assert.deepEqual([f.env.reads, f.calls.length, f.env.redraws], warm);
  });
}

test('cards online wait: reset admits new Bash demand without repeating completed coloring or FILE fallback', async () => {
  const f = fixture(true), ready: Owner = { input: bash('echo ready', true) };
  f.cards.useful(ready, 1); await settled(); answer(f, 0, 'echo ready', true); await settled();
  f.env.generation++; f.env.ready = false; f.cards.metadataChanged(); await settled();
  const first: Owner = { input: bash('echo pending one', true) }, second: Owner = { input: bash('echo pending two', true) };
  const fallback: Owner = { input: written('const x = 1') };
  f.cards.useful(first, 1); f.cards.useful(second, 1); f.cards.useful(fallback, 1);
  await settled(); await settled(); // Three owners require two preparation turns.
  assert.equal(f.calls.length, 1); assert.equal(f.env.classifications.length, 1);
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  // The existing latest-file native upgrade remains bounded; Pi is still cached.
  for (let i = 1; i < 4; i++) {
    assert.ok(f.calls[i], 'all pending Bash demand and the existing latest file upgrade get credit');
    const text = (f.calls[i]!.request.sources as { text: string }[])[0]!.text;
    answer(f, i, text, true); await settled();
  }
  assert.deepEqual(f.calls.slice(1).map(c => (c.request.sources as { text: string }[])[0]!.text).sort(), ['const x = 1', 'echo pending one', 'echo pending two']);
  assert.equal(f.env.classifications.length, 1); assert.equal(f.calls.length, 4);
  f.cards.useful(ready, 1); await settled(); assert.equal(f.calls.length, 4);
});

test('cards online wait: ready scan skips removed, frozen, unrequested and paused owners; pause can resume', async () => {
  const f = fixture(), removed: Owner = { input: bash('removed', true) }, frozen: Owner = { input: bash('frozen') };
  const unseen: Owner = { input: bash('unseen', true) }, paused: Owner = { input: bash('paused', true) }, live: Owner = { input: bash('live', true) };
  for (const owner of [removed, frozen, paused, live]) f.cards.useful(owner, 1);
  f.cards.record(unseen, 1, false); await settled();
  f.cards.remove(removed); f.cards.freeze(frozen); f.cards.pause(paused);
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text), ['live']);
  answer(f, 0, 'live', true); await settled();
  f.cards.useful(paused, 1); await settled();
  assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text), ['live', 'paused']);
  assert.equal(f.env.classifications.length, 0);
});

test('cards online wait: retained wait flag cannot keep a collected first owner alive', { skip: typeof global.gc !== 'function' }, async () => {
  const f = fixture();
  function make() { const owner: Owner = { input: bash('echo collected', true) }; f.cards.useful(owner, 1); return new WeakRef(owner); }
  const weak = make(); await settled();
  const peer: Owner = { input: bash('echo peer', true) }; f.cards.useful(peer, 1); await settled();
  for (let i = 0; i < 100; i++) { global.gc!(); await settled(); if (!weak.deref()) break; await settled(); }
  assert.equal(weak.deref(), undefined, 'waiting state and registry have no strong first-owner reference');
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text), ['echo peer']);
  assert.equal(f.sources.stats().sourceRecords, 1, 'only the live peer has a native source');
});

test('cards online wait: readiness keeps bookkeeping refusal instead of creating an unbounded queue', async () => {
  const f = fixture(false, undefined, 4096), admitted: Owner = { input: bash('admitted', true) }, refused: Owner = { input: bash('refused', true) };
  f.cards.useful(admitted, 1); await settled(); f.cards.useful(refused, 1); await settled();
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text), ['admitted']);
  answer(f, 0, 'admitted', true); await settled();
  const reads = f.env.reads;
  for (let i = 0; i < 10; i++) { f.cards.metadataChanged(); f.cards.useful(admitted, 1); f.cards.useful(refused, 1); }
  await settled(); assert.equal(f.calls.length, 1); assert.equal(f.env.reads, reads);
});


for (const count of [1, 4, 8]) test(`cards online wait: ${count} awaiting owners use existing two-job credit and finish once`, async () => {
  const f = fixture(), owners = Array.from({ length: count }, (_, index): Owner => ({ input: bash(`echo pending ${index}`, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  await settled(); assert.equal(f.calls.length, 0);
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  assert.equal(f.calls.length, Math.min(count, 2), 'readiness does not bypass per-route credit');
  for (let index = 0; index < count; index++) {
    assert.ok(f.calls[index], 'controller credit wake reaches every admitted waiting source');
    const text = (f.calls[index]!.request.sources as { text: string }[])[0]!.text;
    answer(f, index, text, true); await settled();
    assert.ok(f.sources.stats().unsettledJobs <= 2);
  }
  assert.equal(f.calls.length, count); assert.equal(f.sources.stats().unsettledJobs, 0);
  const warm = [f.env.reads, f.calls.length];
  for (const owner of owners) { assert.ok(f.cards.bash(owner, 40, theme, 0)); f.cards.useful(owner, 1); }
  f.cards.metadataChanged(); await settled(); assert.deepEqual([f.env.reads, f.calls.length], warm);
});


for (const reentrant of [false, true]) test(`cards online wait: preparation yields after two owners${reentrant ? ' even with reentrant demand' : ''}`, async () => {
  const f = fixture(), owners = Array.from({ length: 8 }, (_, i): Owner => ({ input: bash(`echo batch ${i}`, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  for (let i = 0; i < 8; i++) await settled();
  assert.equal(f.env.reads, 8); const before = f.env.reads;
  const extra: Owner = { input: bash('echo reentrant', true) };
  const observe = f.sources.observe.bind(f.sources); let added = false;
  if (reentrant) f.sources.observe = demand => {
    if (!added) { added = true; f.cards.useful(extra, 1); }
    return observe(demand);
  };
  f.env.ready = true; f.cards.metadataChanged();
  await settled();
  assert.equal(f.env.reads - before, 2, 'a pre-existing event-loop callback runs before any third preparation');
  assert.equal(f.calls.length, 2); assert.equal(f.sources.stats().unsettledJobs, 2);
    await settled(); assert.equal(f.env.reads - before, 2, 'native backpressure leaves all remaining owner preparation lazy');
  assert.equal(f.calls.length, 2, 'held jobs still own both RPC credits');
  const count = 8 + Number(reentrant);
  for (let i = 0; i < count; i++) {
    assert.ok(f.calls[i]); answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true); await settled();
  }
  assert.equal(f.calls.length, count); assert.equal(f.sources.stats().unsettledJobs, 0);
});


test('cards online wait: yielded backlog cannot retain an unprepared owner or revive a disposed consumer', { skip: !global.gc }, async () => {
  const f = fixture(), first: Owner = { input: bash('first', true) }, second: Owner = { input: bash('second', true) }, peer: Owner = { input: bash('peer', true) };
  function make() { const owner: Owner = { input: bash('unprepared collected', true) }; f.cards.useful(owner, 1); return new WeakRef(owner); }
  const weak = make(); f.cards.useful(first, 1); f.cards.useful(second, 1); f.cards.useful(peer, 1);
  await settled(); assert.equal(f.env.reads, 2);
  global.gc!(); await settled(); assert.equal(weak.deref(), undefined, 'yield callback and pending tickets do not own the oldest waiting card');
  assert.equal(f.env.reads, 3, 'the collected card is never prepared');
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  for (let i = 0; i < 3; i++) { assert.ok(f.calls[i]); answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true); await settled(); }
  assert.deepEqual(f.calls.map(c => (c.request.sources as { text: string }[])[0]!.text).sort(), ['first', 'peer', 'second']);
  const stopped = fixture(), owners = Array.from({ length: 6 }, (_, i): Owner => ({ input: bash(`disposed ${i}`, true) }));
  for (const owner of owners) stopped.cards.useful(owner, 1);
  await settled(); assert.equal(stopped.env.reads, 2); stopped.cards.dispose();
  stopped.env.ready = true; stopped.cards.metadataChanged();
  for (let i = 0; i < 3; i++) await settled();
  assert.equal(stopped.env.reads, 2); assert.equal(stopped.calls.length, 0);
});


for (const count of [1, 2]) test(`cards online wait: asynchronous local-refusal notices cannot bypass the host yield (${count} owners)`, async () => {
  const f = fixture(true, undefined, undefined, { maxTransientBytes: 128 });
  const owners: Owner[] = [{ input: written('x', 'a.sh', 'bash') }, { input: written('y', 'b.sh', 'bash') }].slice(0, count);
  for (const owner of owners) f.cards.useful(owner, 1);
  await settled();
  assert.equal(f.env.reads, count, 'the host callback precedes the fallback batch queued by actual controller notices');
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 0);
  await settled();
  assert.equal(f.env.reads, count * 2); assert.deepEqual(f.env.classifications.map(c => c.text).sort(), ['x', 'y'].slice(0, count));
  assert.equal(f.sources.stats().piSourceRecords, count);
  const counts = [f.env.reads, f.env.classifications.length, f.env.notices.length];
  for (let i = 0; i < 10; i++) await settled();
  assert.deepEqual([f.env.reads, f.env.classifications.length, f.env.notices.length], counts, 'an empty continuation stops; no polling');
});

test('cards online wait: metadata loss never relabels an unchanged local refusal as deferred demand', async () => {
  const f = fixture(true, undefined, undefined, { maxTransientBytes: 128 });
  const observations = new Map<string, number>(), observe = f.sources.observe.bind(f.sources);
  f.sources.observe = demand => { observations.set(demand.key, (observations.get(demand.key) ?? 0) + 1); return observe(demand); };
  const refused: Owner = { input: bash('echo refused', true) };
  f.cards.useful(refused, 1); await settled(); await settled();
  const key = f.cards.identities(refused)[0]!.key;
  assert.equal(observations.get(key), 1); assert.equal(f.sources.workStatus(key).execution, 'not_started');
  assert.equal(f.sources.status(key)!.protective, true); assert.equal(f.calls.length, 0);
  f.env.generation++; f.env.ready = false; f.cards.metadataChanged(); await settled(); await settled();
  const deferred: Owner = { input: bash('echo deferred', true) }; f.cards.useful(deferred, 1); await settled();
  const deferredKey = f.cards.identities(deferred)[0]!.key;
  f.env.ready = true; f.cards.metadataChanged(); await settled(); await settled();
  assert.equal(observations.get(key), 1, 'an unchanged refused revision is not part of the readiness scan');
  assert.equal(observations.get(deferredKey), 1, 'the genuinely availability-deferred revision is admitted');
  f.env.generation++; f.env.ready = false; f.cards.metadataChanged(); await settled();
  refused.input = bash('echo changed', true); f.cards.record(refused, 2, true); await settled();
  const peer: Owner = { input: bash('echo peer', true) }; f.cards.useful(peer, 1); await settled();
  f.env.ready = true; f.cards.metadataChanged(); await settled(); await settled();
  assert.equal(observations.get(key), 2, 'a changed refused source is new demand and is not forgotten');
  assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0);
});


test('cards online wait: recovery without new demand does not reparse the last current static Bash source', async () => {
  const f = fixture(true), owner: Owner = { input: bash('echo current', true) };
  f.cards.metadataChanged(); f.cards.useful(owner, 1); await settled();
  answer(f, 0, 'echo current', true); await settled(); await settled();
  assert.ok(f.cards.bash(owner, 30, theme, 0));
  const before = [f.calls.length, f.sources.stats().dispatches, f.sources.stats().preparedBytes];
  f.env.generation++; f.env.ready = false; f.cards.metadataChanged(); await settled(); await settled();
  f.env.ready = true; f.cards.metadataChanged(); await settled(); await settled();
  assert.deepEqual([f.calls.length, f.sources.stats().dispatches, f.sources.stats().preparedBytes], before,
    'provider readiness alone is not a new parser demand for validated compatible current text');
  assert.ok(f.cards.bash(owner, 30, theme, 0));
  owner.input = bash('echo changed', true); f.cards.record(owner, 2, true); await settled();
  assert.equal(f.calls.length, 2, 'real source change still resynchronizes to the replacement provider');
  assert.equal(f.calls[1]!.request.op, 'highlight');
  answer(f, 1, 'echo changed', true); await settled();
  assert.ok(f.cards.bash(owner, 30, theme, 0)); assert.equal(f.env.classifications.length, 0);
});


for (const episode of ['ready provider', 'startup', 'connection reset'] as const) {
  test(`cards backlog order: newest cards dispatch first during ${episode}`, async () => {
    const f = fixture(episode === 'ready provider');
    if (episode === 'connection reset') f.env.generation = 2;
    const owners = Array.from({ length: 8 }, (_, i): Owner => ({ input: bash(`echo order ${i}`, true) }));
    for (const owner of owners) f.cards.useful(owner, 1);
    if (!f.env.ready) {
      for (let i = 0; i < 8; i++) await settled();
      assert.equal(f.calls.length, 0);
      // A revision/visit of the oldest card is not a move to the end of history.
      owners[0]!.input = bash('echo oldest changed', true);
      f.cards.record(owners[0]!, 2, true); f.cards.useful(owners[0]!, 2); await settled();
      f.env.ready = true; f.cards.metadataChanged();
    }
    await settled();
    const expected = owners.map(owner => (owner.input as Extract<CardSourceInput, { kind: 'bash' }>).args.command as string).reverse();
    for (let i = 0; i < owners.length; i++) {
      assert.ok(f.calls[i], 'every waiting card reaches the existing dispatcher');
      assert.equal((f.calls[i]!.request.sources as { text: string }[])[0]!.text, expected[i], 'native dispatch follows reverse card order, not retry insertion order');
      assert.ok(f.sources.stats().unsettledJobs <= 2);
      answer(f, i, expected[i]!, true); await settled();
    }
    assert.equal(f.calls.length, owners.length);
    const counts = [f.env.reads, f.calls.length, f.sources.stats().preparedBytes];
    for (const owner of owners) f.cards.useful(owner, owner === owners[0] && episode !== 'ready provider' ? 2 : 1);
    f.cards.metadataChanged(); await settled();
    assert.deepEqual([f.env.reads, f.calls.length, f.sources.stats().preparedBytes], counts);
  });
}

test('cards backlog order: old retries and removal between yielded batches preserve newest-first preparation', async () => {
  const f = fixture(), owners = Array.from({ length: 8 }, (_, i): Owner => ({ input: bash(`echo queued ${i}`, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  await settled();
  assert.equal(f.cards.identities(owners[7]!)[0]?.version, 1);
  assert.equal(f.cards.identities(owners[6]!)[0]?.version, 1);
  assert.deepEqual(f.cards.identities(owners[0]!), [], 'the oldest card waits after the first batch');
  f.cards.remove(owners[4]!);
  owners[0]!.input = bash('echo queued oldest changed', true); f.cards.record(owners[0]!, 2, true);
  await settled();
  assert.equal(f.cards.identities(owners[5]!)[0]?.version, 1);
  assert.equal(f.cards.identities(owners[3]!)[0]?.version, 1);
  assert.deepEqual(f.cards.identities(owners[0]!), []);
  for (let i = 0; i < 4; i++) await settled();
  assert.equal(f.env.reads, 7); assert.equal(f.calls.length, 0);
  f.env.ready = true; f.cards.metadataChanged(); await settled();
  const expected = ['echo queued 7', 'echo queued 6', 'echo queued 5', 'echo queued 3', 'echo queued 2', 'echo queued 1', 'echo queued oldest changed'];
  for (let i = 0; i < expected.length; i++) {
    assert.equal((f.calls[i]!.request.sources as { text: string }[])[0]!.text, expected[i]);
    answer(f, i, expected[i]!, true); await settled();
  }
  assert.equal(f.calls.length, expected.length);
});


const nextProfile = { id: 'syntect:test', label: 'Test theme', fingerprint: 'b'.repeat(64) };
function selectProfile(f: ReturnType<typeof fixture>, target = nextProfile) {
  f.env.profile = { ...target }; f.env.selected = target.id === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: target.id };
  f.cards.metadataChanged();
}
async function answerPending(f: ReturnType<typeof fixture>, from: number, count: number) {
  for (let i = from; i < from + count; i++) {
    for (let turns = 0; !f.calls[i] && turns < 30; turns++) await settled();
    assert.ok(f.calls[i], `native job ${i} must be submitted`);
    const request = f.calls[i]!.request;
    assert.equal(request.op, 'highlight');
    answer(f, i, (request.sources as { text: string }[])[0]!.text, true); await settled();
    assert.ok(f.sources.stats().globalUnsettledJobs <= 2);
  }
}

for (const kind of ['bash', 'write', 'edit', 'mixed'] as const) {
  test(`cards theme change: every warm ${kind} owner adopts the new effective profile newest first`, async () => {
    const f = fixture(true);
    const edit = (i: number): CardSourceInput => ({ kind: 'file', palette: 1, language: 'typescript', node: {
      toolName: 'edit', args: { path: `edit${i}.ts` }, isPartial: false,
      result: { details: { diff: `-1 const old${i}=1;\n+1 const next${i}=2;` } }
    } });
    const kinds = kind === 'mixed' ? ['bash', 'write', 'edit', 'bash', 'write'] : Array(4).fill(kind);
    const owners = kinds.map((k, i): Owner => ({ input: k === 'bash' ? bash(`echo ${i}`, true) : k === 'write' ? written(`const x${i}=1;`) : edit(i) }));
    const jobs = kinds.reduce((n, k) => n + (k === 'edit' ? 2 : 1), 0);
    for (const owner of owners) f.cards.useful(owner, 1);
    await answerPending(f, 0, jobs);
    const versions = owners.map(owner => f.cards.identities(owner).map(slot => slot.version));
    const reads = f.env.reads;
    const retainedRows = owners.map((owner, i) => kinds[i] === 'bash' ? undefined : [...f.cards.file(owner, theme, 0x40000000)!.styledRows]);
    selectProfile(f);
    for (const [i, owner] of owners.entries()) if (kinds[i] !== 'bash')
      assert.deepEqual([...f.cards.file(owner, theme, 0x40000000)!.styledRows], retainedRows[i], 'last ready display remains until new colors arrive');
    await answerPending(f, jobs, jobs);
    assert.equal(f.calls.length, 2 * jobs); assert.equal(f.env.classifications.length, 0);
    for (const owner of owners) for (const slot of f.cards.identities(owner)) assert.equal(f.sources.status(slot.key)?.exact, true);
    const dispatched = f.calls.slice(jobs).map(call => (call.request.sources as { text: string; profile: string; fingerprint: string }[])[0]!);
    const expected = owners.toReversed().flatMap(owner => { const i = owners.indexOf(owner); return kinds[i] === 'bash' ? [`echo ${i}`]
      : kinds[i] === 'write' ? [`const x${i}=1;`] : [`const old${i}=1;`, `const next${i}=2;`]; });
    assert.deepEqual(dispatched.map(source => source.text), expected);
    assert.ok(dispatched.every(source => source.profile === nextProfile.id && source.fingerprint === nextProfile.fingerprint));
    assert.deepEqual(owners.map(owner => f.cards.identities(owner).map(slot => slot.version)), versions, 'theme does not fabricate text revisions');
    assert.equal(f.env.reads - reads, owners.length, 'each already demanded owner is prepared once for the new theme');
    const counts = [f.env.reads, f.calls.length, f.env.classifications.length];
    for (let i = 0; i < 10; i++) { for (const owner of owners) f.cards.useful(owner, 1); f.cards.metadataChanged(); }
    await settled(); assert.deepEqual([f.env.reads, f.calls.length, f.env.classifications.length], counts);
  });
}

test('cards theme change: same ID fingerprint refresh and return to Pi update all demanded owners once', async () => {
  const f = fixture(true), owners: Owner[] = [{ input: bash('one', true) }, { input: written('two') }, { input: bash('three', true) }];
  for (const owner of owners) f.cards.useful(owner, 1);
  await answerPending(f, 0, 3); selectProfile(f); await answerPending(f, 3, 3);
  selectProfile(f, { ...nextProfile, fingerprint: 'c'.repeat(64) }); await answerPending(f, 6, 3);
  assert.ok(f.calls.slice(6).every(call => (call.request.sources as { fingerprint: string }[])[0]!.fingerprint === 'c'.repeat(64)));
  selectProfile(f, profile); await answerPending(f, 9, 3);
  assert.ok(f.calls.slice(9).every(call => (call.request.sources as { profile: string }[])[0]!.profile === 'pi'));
  assert.equal(f.env.classifications.length, 0);
});

test('cards theme change: selection while unavailable survives until ready without repeating FILE Pi fallback', async () => {
  const f = fixture(), owners: Owner[] = [{ input: bash('one', true) }, { input: written('two') }, { input: written('three') }];
  for (const owner of owners) f.cards.useful(owner, 1);
  for (let i = 0; i < 4; i++) await settled();
  assert.equal(f.env.classifications.length, 2);
  selectProfile(f);
  for (let i = 0; i < 4; i++) { for (const owner of owners) f.cards.useful(owner, 1); await settled(); }
  assert.equal(f.env.classifications.length, 2); assert.equal(f.calls.length, 0);
  f.env.ready = true; f.cards.metadataChanged(); await answerPending(f, 0, 3);
  assert.ok(f.calls.every(call => (call.request.sources as { profile: string }[])[0]!.profile === nextProfile.id));
  assert.equal(f.env.classifications.length, 2);
});

test('cards theme change: paused demand resumes on use, removed and frozen live owners never restart', async () => {
  const f = fixture(true), owners: Owner[] = ['removed', 'frozen', 'paused', 'active'].map(text => ({ input: bash(text, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  await answerPending(f, 0, 4);
  f.cards.remove(owners[0]!); f.cards.freeze(owners[1]!); f.cards.pause(owners[2]!);
  selectProfile(f); await answerPending(f, 4, 1);
  assert.equal((f.calls[4]!.request.sources as { text: string }[])[0]!.text, 'active');
  for (let i = 0; i < 4; i++) await settled(); assert.equal(f.calls.length, 5);
  f.cards.useful(owners[2]!, 1); await answerPending(f, 5, 1);
  assert.equal((f.calls[5]!.request.sources as { text: string }[])[0]!.text, 'paused');
  f.cards.useful(owners[1]!, 1); await settled(); assert.equal(f.calls.length, 6);
});


test('cards theme change: accumulated profile work preserves two-owner host yields and coalesces rapid choices', async () => {
  const f = fixture(true), owners = Array.from({ length: 8 }, (_, i): Owner => ({ input: bash(`echo theme ${i}`, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  await answerPending(f, 0, 8);
  const reads = f.env.reads;
  selectProfile(f); selectProfile(f, { ...nextProfile, fingerprint: 'c'.repeat(64) });
  for (const owner of owners) f.cards.useful(owner, 1);
  await settled(); assert.equal(f.env.reads - reads, 2, 'only two owners are prepared before the host turn');
  assert.equal(f.calls.length, 10); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
  await answerPending(f, 8, 8);
  assert.equal(f.env.reads - reads, owners.length);
  assert.ok(f.calls.slice(8).every(call => (call.request.sources as { fingerprint: string }[])[0]!.fingerprint === 'c'.repeat(64)));
});

test('cards theme change: waiting profile demand cannot retain a collected first owner', { skip: !global.gc }, async () => {
  const f = fixture(true), first = await firstOwner(f, bash('gone', true));
  answer(f, 0, 'gone', true); await settled();
  const peer: Owner = { input: bash('peer', true) }; f.cards.useful(peer, 1); await answerPending(f, 1, 1);
  f.env.invalidated.length = 0;
  f.env.ready = false; selectProfile(f);
  for (let i = 0; i < 60; i++) { await settled(); global.gc!(); await settled(); if (!first.weak.deref()) break; }
  assert.equal(first.weak.deref(), undefined); assert.equal(f.sources.borrowSource(first.key), undefined);
  f.env.ready = true; f.cards.metadataChanged(); await answerPending(f, 2, 1);
  assert.equal((f.calls[2]!.request.sources as { text: string }[])[0]!.text, 'peer'); assert.equal(f.calls.length, 3);
});


test('cards theme revision: offline incompatible selection preserves ready file colors without useless Pi fallback', async () => {
  const f = fixture(true), owner: Owner = { input: written('const x=1;') };
  f.cards.useful(owner, 1); await settled(); answer(f, 0, 'const x=1;', true); await settled();
  assert.equal(f.env.classifications.length, 0);
  f.env.ready = false; f.cards.metadataChanged(); f.cards.useful(owner, 1); await settled();
  assert.equal(f.env.classifications.length, 0, 'same-profile outage preserves compatible retained native coloring');
  f.env.profile = { id: 'syntect:offline', label: 'Offline', fingerprint: 'c'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.cards.metadataChanged();
  f.cards.useful(owner, 1); await settled();
  assert.equal(f.env.classifications.length, 0, 'old display is useful without claiming the offline requested profile was classified');
  const key = f.cards.identities(owner)[0]!.key;
  assert.equal(f.sources.hasPiBridge(key, 1, 1), false);
  assert.ok(f.cards.file(owner, theme, 0x40000000)!.styledRows.size);
  for (let i = 0; i < 5; i++) f.cards.useful(owner, 1);
  await settled(); assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 1);
});

test('cards requested theme: ticket refusal remains memoized after capacity frees on the same text revision', async () => {
  const f = fixture(false, undefined, 1024), owner: Owner = { input: bash('first', true) }, refused: Owner = { input: bash('refused', true) };
  f.cards.useful(owner, 1); f.cards.useful(refused, 1); f.cards.remove(owner);
  f.cards.useful(refused, 1); await settled();
  assert.equal(f.env.reads, 0, 'a warm visit is not permission to retry refused bookkeeping');
  f.cards.useful(refused, 2); await settled(); assert.equal(f.env.reads, 1, 'new source revision permits fresh demand');
});

for (const rapid of [false, true]) test(`cards LIFO: sequential live history keeps recent work first${rapid ? ' across held obsolete theme replies' : ''}`, async () => {
  const f = fixture(true), owners = Array.from({ length: 8 }, (_, i): Owner => ({ input: bash(`echo live ${i}`, true) }));
  // A live conversation creates and settles each source before the next card arrives.
  for (let i = 0; i < owners.length; i++) { f.cards.useful(owners[i]!, 1); await answerPending(f, i, 1); }
  const first = f.calls.length;
  selectProfile(f);
  for (let i = 0; i < 12; i++) await settled();
  assert.equal(f.calls.length, first + 2, 'only the two physical slots may start');
  let start = first;
  if (rapid) {
    selectProfile(f, { ...nextProfile, fingerprint: 'c'.repeat(64) });
    for (let i = 0; i < 12; i++) await settled();
    assert.equal(f.calls.length, first + 2, 'local replacement cannot release unsettled physical jobs');
    for (let i = first; i < first + 2; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
    start += 2;
  }
  await answerPending(f, start, owners.length);
  const requests = f.calls.slice(start).map(c => (c.request.sources as { text: string; fingerprint: string }[])[0]!);
  assert.deepEqual(requests.map(s => s.text), owners.toReversed().map(o => (o.input as Extract<CardSourceInput, { kind: 'bash' }>).args.command),
    'selection follows the current LIFO backlog, not the lifetime insertion order of native states');
  assert.ok(requests.every(s => s.fingerprint === (rapid ? 'c' : 'b').repeat(64)));
  assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  const counts = [f.env.reads, f.calls.length, f.sources.stats().preparedBytes];
  for (const owner of owners) f.cards.useful(owner, 1);
  f.cards.metadataChanged(); await settled();
  assert.deepEqual([f.env.reads, f.calls.length, f.sources.stats().preparedBytes], counts);
});

test('cards LIFO: a ready recent result is published while the other recent source remains held', async () => {
  const f = fixture(true), owners = Array.from({ length: 4 }, (_, i): Owner => ({ input: bash(`echo independent ${i}`, true) }));
  for (let i = 0; i < owners.length; i++) { f.cards.useful(owners[i]!, 1); await answerPending(f, i, 1); }
  selectProfile(f); await settled();
  const recent = f.calls.slice(4).findIndex(c => (c.request.sources as { text: string }[])[0]!.text === 'echo independent 3') + 4;
  assert.ok(recent >= 4 && f.calls[recent]);
  answer(f, recent, 'echo independent 3', true); await settled();
  assert.ok(f.cards.bash(owners[3]!, 40, theme, 0), 'accepted colors do not wait for another card to finish');
  assert.equal(f.calls.length, 7, 'the released slot admits more work while the other request is still held');
  for (let i = 4; i < 8; i++) if (i !== recent) {
    for (let turns = 0; !f.calls[i] && turns < 30; turns++) await settled();
    answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true); await settled();
  }
});

test('cards LIFO: sequential multi-source edit keeps its native segments together ahead of older cards', async () => {
  const f = fixture(true), owners: Owner[] = [{ input: bash('older', true) }, { input: written('const middle=1;') },
    { input: { kind: 'file', palette: 1, language: 'typescript', node: { toolName: 'edit', args: { path: 'latest.ts' }, isPartial: false,
      result: { details: { diff: '-1 const before=1;\n+1 const after=2;' } } } } }];
  for (const owner of owners) { const from = f.calls.length; f.cards.useful(owner, 1); await answerPending(f, from, owner === owners[2] ? 2 : 1); }
  selectProfile(f); await settled();
  assert.deepEqual(f.calls.slice(4).map(c => (c.request.sources as { text: string }[])[0]!.text), ['const before=1;', 'const after=2;']);
  f.cards.remove(owners[1]!);
  await answerPending(f, 4, 3);
  assert.equal((f.calls[6]!.request.sources as { text: string }[])[0]!.text, 'older');
  assert.equal(f.calls.length, 7);
});

test('cards LIFO: held native slots do not delay an unrelated file Pi fallback while native is off', async () => {
  const f = fixture(true), held: Owner[] = [{ input: bash('held one', true) }, { input: bash('held two', true) }];
  for (const owner of held) f.cards.useful(owner, 1);
  await settled(); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
  f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged();
  const fileOwner: Owner = { input: written('const offline=1;') };
  f.cards.useful(fileOwner, 1); await settled();
  assert.deepEqual(f.env.classifications.map(c => c.text), ['const offline=1;']);
  assert.equal(f.sources.stats().globalUnsettledJobs, 2, 'preparation never guesses that cancelled native jobs stopped');
});

for (const kind of ['bash', 'write', 'edit'] as const) {
  const input = (): CardSourceInput => kind === 'bash' ? bash('echo colors', true) : kind === 'write' ? written('const colors=1;') : {
    kind: 'file', palette: 1, language: 'typescript', node: { toolName: 'edit', args: { path: 'colors.ts' }, isPartial: false,
      result: { details: { diff: '-1 const before=1;\n+1 const after=2;' } } } };
  test(`cards theme display: ${kind} keeps ready colors before and after new-profile preparation`, async () => {
    const f = fixture(true), owner: Owner = { input: input() }, count = kind === 'edit' ? 2 : 1;
    const draw = () => kind === 'bash' ? f.cards.bash(owner, 60, theme, 0)?.join('\n') : [...(f.cards.file(owner, theme, 0)?.styledRows.values() ?? [])].join('\n');
    f.cards.useful(owner, 1); await answerPending(f, 0, count);
    const before = draw(); assert.ok(before);
    selectProfile(f);
    assert.equal(draw(), before, 'selection alone cannot erase the last ready display');
    await settled(); assert.equal(draw(), before, 'old colors remain while the new result is held');
    assert.equal(f.env.classifications.length, 0);
    for (const slot of f.cards.identities(owner)) assert.equal(f.sources.status(slot.key)?.exact, false, 'old display is not current-profile classification');
    await answerPending(f, count, count);
    assert.notEqual(draw(), before, 'accepted new colors replace the old display');
    const counts = [f.calls.length, f.env.classifications.length, f.sources.stats().preparedBytes];
    for (let i = 0; i < 10; i++) { f.cards.useful(owner, 1); draw(); }
    await settled(); assert.deepEqual([f.calls.length, f.env.classifications.length, f.sources.stats().preparedBytes], counts);
  });
  test(`cards theme display: ${kind} rollback reuses its ready profile and rejects late preview colors`, async () => {
    const f = fixture(true), owner: Owner = { input: input() }, count = kind === 'edit' ? 2 : 1;
    const draw = () => kind === 'bash' ? f.cards.bash(owner, 60, theme, 0)?.join('\n') : [...(f.cards.file(owner, theme, 0)?.styledRows.values() ?? [])].join('\n');
    f.cards.useful(owner, 1); await answerPending(f, 0, count);
    const before = draw(); assert.ok(before);
    selectProfile(f); await settled();
    const dispatched = f.calls.length; assert.equal(dispatched, count * 2);
    selectProfile(f, profile); await settled();
    assert.equal(draw(), before); assert.equal(f.calls.length, dispatched, 'no replacement parse of the retained original profile');
    await answerPending(f, count, count);
    assert.equal(draw(), before); assert.equal(f.calls.length, dispatched, 'stale preview cannot invalidate a ready rollback');
    assert.equal(f.env.classifications.length, 0);
    for (const slot of f.cards.identities(owner)) assert.equal(f.sources.status(slot.key)?.exact, true);
  });
}

test('cards theme display: a failed or offline selection keeps ready native file colors without Pi reclassification', async () => {
  const f = fixture(true), owner: Owner = { input: written('const retained=1;') };
  f.cards.useful(owner, 1); await answerPending(f, 0, 1);
  const before = [...f.cards.file(owner, theme, 0)!.styledRows];
  selectProfile(f); await settled(); fault(f, 1); await settled();
  assert.deepEqual([...f.cards.file(owner, theme, 0)!.styledRows], before); assert.equal(f.env.classifications.length, 0);
  f.env.ready = false; selectProfile(f, { ...nextProfile, id: 'syntect:offline' });
  f.cards.useful(owner, 1); await settled();
  assert.deepEqual([...f.cards.file(owner, theme, 0)!.styledRows], before); assert.equal(f.env.classifications.length, 0);
});

for (const kind of ['write', 'edit'] as const) for (const offline of [false, true]) test(`cards theme display alias: ${kind} retains equal-text colors across ${offline ? 'offline' : 'held'} theme change`, async () => {
  const f = fixture(true), input: CardSourceInput = kind === 'write' ? written('const alias=1;') : {
    kind: 'file', palette: 1, language: 'typescript', node: { toolName: 'edit', args: { path: 'alias.ts' }, isPartial: false,
      result: { details: { diff: '-1 const oldAlias=1;\n+1 const newAlias=2;' } } } };
  const owner: Owner = { input }, count = kind === 'edit' ? 2 : 1;
  f.cards.useful(owner, 1); await answerPending(f, 0, count);
  const before = [...f.cards.file(owner, theme, 0)!.styledRows];
  owner.input = { ...input, palette: 2 }; f.cards.useful(owner, 2); await settled();
  assert.equal(f.cards.identities(owner)[0]!.version, 2); assert.equal(f.calls.length, count);
  if (offline) f.env.ready = false;
  selectProfile(f);
  assert.deepEqual([...f.cards.file(owner, theme, 0)!.styledRows], before, 'classification version aliases preserve display too');
  await settled();
  assert.deepEqual([...f.cards.file(owner, theme, 0)!.styledRows], before);
  assert.equal(f.env.classifications.length, 0);
});

for (const kind of ['bash', 'write', 'edit'] as const) test(`cards theme display race: ${kind} rejects an obsolete reply before rollback preparation yields`, async () => {
  const f = fixture(true), count = kind === 'edit' ? 2 : 1, owner: Owner = { input: kind === 'bash' ? bash('echo raced', true)
    : kind === 'write' ? written('const raced=1;') : { kind: 'file', palette: 1, language: 'typescript', node: {
      toolName: 'edit', args: { path: 'race.ts' }, isPartial: false, result: { details: { diff: '-1 const oldRace=1;\n+1 const newRace=2;' } } } } };
  const draw = () => kind === 'bash' ? f.cards.bash(owner, 60, theme, 0)?.join('\n') : [...f.cards.file(owner, theme, 0)!.styledRows];
  f.cards.useful(owner, 1); await answerPending(f, 0, count); const before = draw();
  selectProfile(f); await Promise.resolve(); assert.equal(f.calls.length, count * 2);
  selectProfile(f, profile);
  for (let i = count; i < count * 2; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(draw(), before, 'reply cannot publish between selection rollback and deferred preparation');
  await settled(); assert.deepEqual(draw(), before); assert.equal(f.calls.length, count * 2);
});

test('theme burst: full native credit leaves source preparation lazy across 100 desired profiles', async () => {
  const f = fixture(true), owners = Array.from({ length: 20 }, (_, i): Owner => ({ input: bash(`echo ${i}`, true) }));
  for (const owner of owners) f.cards.useful(owner, 1);
  for (let i = 0; i < 12; i++) await settled();
  assert.equal(f.calls.length, 2);
  assert.equal(f.env.reads, 2, 'native backpressure must stop heavy source construction, not only RPC');
  for (let i = 0; i < 100; i++) {
    f.env.selected = { kind: 'occipital', id: `theme-${i}` };
    f.env.profile = { id: `theme-${i}`, label: `Theme ${i}`, fingerprint: (i % 2 ? 'b' : 'c').repeat(64) };
    f.cards.metadataChanged(); await settled();
  }
  assert.equal(f.env.reads, 2, 'intermediate profiles replace metadata without rereading any busy or waiting source');
  assert.equal(f.calls.length, 2); assert.equal(f.env.classifications.length, 0);
  for (let i = 0; i < owners.length + 2; i++) {
    assert.ok(f.calls[i], 'every latest-profile demand eventually receives credit');
    const source = (f.calls[i]!.request.sources as { text: string; profile: string }[])[0]!;
    if (i >= 2) assert.equal(source.profile, 'theme-99', 'no obsolete intermediate profile is dispatched');
    answer(f, i, source.text, true); await settled();
  }
  assert.equal(f.env.reads, owners.length + 2);
  assert.equal(f.calls.length, owners.length + 2); assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  for (const owner of owners) {
    const key = f.cards.identities(owner)[0]!.key;
    assert.equal(f.sources.displayBasis(key)?.profile, 'theme-99'); assert.equal(f.sources.status(key)?.protective, false);
  }
});

test('theme burst: unchanged retained file colors do not invalidate layouts while another profile is pending', async () => {
  const f = fixture(true), owner: Owner = { input: written('const x=1') };
  f.cards.useful(owner, 1); await settled(); answer(f, 0, 'const x=1', true); await settled();
  const before = [f.cards.displayStamp(owner), f.env.invalidated.length, f.env.redraws];
  f.env.selected = { kind: 'occipital', id: 'B' }; f.env.profile = { id: 'B', label: 'B', fingerprint: 'b'.repeat(64) };
  f.cards.metadataChanged(); await settled();
  assert.equal(f.calls.length, 2);
  assert.deepEqual([f.cards.displayStamp(owner), f.env.invalidated.length, f.env.redraws], before,
    'desired-theme/preparation changes alone must not repaint the same retained file colors');
  answer(f, 1, 'const x=1', true); await settled();
  assert.notEqual(f.cards.displayStamp(owner), before[0], 'actual replacement colors invalidate their file layout');
});


test('theme burst: a blocked newer theme cannot delay an older local palette revision', async () => {
  const f = fixture(true), older: Owner = { input: written('const a=1') }, newer: Owner = { input: written('const b=2') };
  f.cards.useful(older, 1); f.cards.useful(newer, 1); await settled();
  for (let i = 0; i < 2; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
  await settled();
  f.env.selected = { kind: 'occipital', id: 'B' }; f.env.profile = { id: 'B', label: 'B', fingerprint: 'b'.repeat(64) };
  f.cards.metadataChanged(); await settled(); assert.equal(f.calls.length, 4);
  f.env.selected = { kind: 'occipital', id: 'C' }; f.env.profile = { id: 'C', label: 'C', fingerprint: 'c'.repeat(64) };
  f.cards.metadataChanged(); await settled();
  const reads = f.env.reads;
  older.input = { ...older.input!, palette: 2 }; f.cards.useful(older, 2);
  await settled(); await settled();
  assert.equal(f.env.reads, reads + 1, 'credit-free current display preparation progresses past newer blocked work');
  assert.equal(f.calls.length, 4); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
  assert.ok(f.cards.file(older, theme, 0x40000000)?.styledRows.size, 'retained exact display remains usable for the equal-text revision');
});
