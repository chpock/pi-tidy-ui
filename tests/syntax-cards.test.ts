import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { CardSources, type CardSourceInput } from '../src/syntax/cards.ts';
import { SourceController, type ControllerOptions } from '../src/occipital/controller.ts';
import type { SyntaxClient } from '../src/occipital/client.ts';
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
  const env = { ready, enabled: true, reads: 0, classifications: [] as { text: string; language?: string; path?: string }[],
    invalidated: [] as Owner[], redraws: 0, failClassification: false, notices: [] as string[][] };
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: 1, availability: env.ready ? 'ready' : 'initializing',
      reason: env.ready ? 'ready' : 'initializing', initialShared: false, kind: 'owned', description: env.ready ? description : undefined }; },
    isReady(g: number) { return env.ready && g === 1; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) { return new Promise<unknown>(resolve => calls.push({ request, resolve })); }
  };
  let cards: CardSources<Owner>;
  const sources = new SourceController(provider, { ...controllerOptions, retention, onChange: keys => { env.notices.push([...keys]); cards.sourceChanged(keys); } });
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> = { sources, snapshot: () => ({ enabled: env.enabled,
    provider: provider.snapshot(), standaloneVersion: 'test', selected: { kind: 'pi' }, effective: env.ready ? profile : undefined }) };
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
  f.env.invalidated.length = 0; fault(f, 0); await settled();
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
      ...(r.op !== 'highlight' ? { lease: 'lease' } : {}), styles: [{ role: 'syntaxKeyword' }], runs: bytes > from ? [bytes - from, 0] : [],
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
  answer(f, 0, 'x\n', false); await settled();
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
  f.env.ready = false; owner.input = undefined; f.cards.metadataChanged(); await settled();
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
  const submitted = (f.calls[0]!.request.sources as { hint: Record<string, string>; text: string }[])[0]!;
  assert.deepEqual(submitted.hint, {}); assert.equal(submitted.text, 'x');
  const other = (f.calls[1]!.request.sources as { hint: Record<string, string>; text: string }[])[0]!;
  assert.deepEqual(other.hint, { language: 'typescript', path: 'p.ts' }); assert.equal(other.text, 'y');
  const projection = f.cards.file(owner, theme, 0x40000000)!;
  assert.equal(projection.display.path, path); assert.equal(projection.display.lines[0]!.kind, ' ');
  assert.ok('text' in projection.display.lines[0]! && projection.display.lines[0].text === 'x');
  const baseline = renderFileCard((owner.input as Extract<CardSourceInput, { kind: 'file' }>).node, undefined, 60, theme)!;
  assert.deepEqual(renderPreparedFileCard(projection.display, undefined, 60, theme).rows, baseline.rows);
  answer(f, 0, 'x', true); answer(f, 1, 'y', true); await settled();
  assert.equal(stripVTControlCharacters(f.cards.file(owner, theme, 0x40000000)!.styledRows.get(0)!), 'x');
  assert.equal(stripVTControlCharacters(f.cards.file(peer, theme, 0x40000000)!.styledRows.get(0)!), 'y');
});

test('cards actual canonical local refusal notice enables exactly one FILE Pi fallback without manual retry', async () => {
  const f = fixture(true, undefined, undefined, { maxTransientBytes: 128 }), owner: Owner = { input: written('x', 'a.sh', 'bash') };
  f.cards.useful(owner, 1); await settled();
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
  assert.deepEqual(f.env.notices, [[key]]); assert.deepEqual(f.env.classifications.map(x => x.text), ['x']);
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
