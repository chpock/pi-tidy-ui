import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { highlightCode } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { CardSources, type CardDisplayInput, type PreparedCard, type ReadyCardPaint } from '../../../src/syntax/cards.ts';
import { SourceController, type ControllerOptions } from '../../../src/occipital/controller.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { fingerprintNative, fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { reflow } from '../../../src/syntax/measured-rows.ts';
import { paintFlat, type FlatRangeReader } from '../../../src/syntax/flat-paint.ts';
import { stripVTControlCharacters } from 'node:util';
import { prepareBashService } from '../../../src/bash-card.ts';
import { prepareFileCard } from '../../../src/file-card.ts';
import { RETENTION_LIMITS } from '../../../src/occipital/retention.ts';
import type { SyntaxTheme } from '../../../src/settings.ts';

type Frame = Record<string, any>;
type Owner = { input?: CardDisplayInput };
const profile = { id: 'native', label: 'Native', fingerprint: 'a'.repeat(64) };
const literal = (n: number) => ({ foreground: { kind: 'rgb', r: n, g: 2, b: 3 }, background: { kind: 'rgb', r: 4, g: 5, b: 6 }, attributes: 0 });
const bash = (text: string, complete = false, revision = 1): Extract<CardDisplayInput, { kind: 'bash' }> => ({ kind: 'bash', args: { command: text }, complete,
  revision, sourceRevision: revision, serviceRevision: revision, palette: 1, mode: 'truecolor', language: 'bash' });
const written = (text: string, revision = 1, path = 'a.ts'): Extract<CardDisplayInput, { kind: 'file' }> => ({ kind: 'file', revision, sourceRevision: revision,
  serviceRevision: revision, palette: 1, mode: 'truecolor', language: 'typescript', node: { toolName: 'write', args: { path, content: text }, isPartial: false, result: {} } });
const edited = (diff = '-1 \tx\n+1 \ty\n   ...\n-9 a\n+9 b', revision = 1): Extract<CardDisplayInput, { kind: 'file' }> => ({ ...written('', revision), kind: 'file',
  node: { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { details: { diff } } } });
const fixtures: { cards: CardSources<Owner>; sources: SourceController; runtime: SyntaxRuntime; calls: { reject(error: unknown): void }[] }[] = [];
function fixture(ready = false, options: ControllerOptions = {}, maxBookkeepingBytes?: number) {
  const env = { ready, enabled: true, generation: 1, vocabulary: 'a'.repeat(64), selected: { kind: 'pi' } as SyntaxTheme, profile: { ...profile },
    classifications: [] as string[], invalidated: [] as Owner[], renders: 0, acquisitions: 0, samples: 0, failClassification: false,
    poison: false, beforeClassify: undefined as (() => void) | undefined, notices: [] as { keys: string[]; groups: number[] }[] };
  const calls: { request: Frame; resolve(value: unknown): void; reject(error: unknown): void; done?: boolean }[] = [];
  const description = decodeSemanticDescription(semanticDescriptor('describe', 'daemon'), 'describe');
  const provider = { snapshot: () => ({ generation: env.generation, availability: env.ready ? 'ready' as const : 'initializing' as const,
    reason: env.ready ? 'ready' as const : 'initializing' as const, kind: 'owned' as const, initialShared: false, description: env.ready ? { ...description, vocabulary: { ...description.vocabulary, fingerprint: env.vocabulary } } : undefined }),
    isReady: (g: number) => env.ready && g === env.generation, classificationAccepted: () => true,
    request: (_g: number, request: Frame) => new Promise<unknown>((resolve, reject) => calls.push({ request, resolve, reject })) };
  let cards: CardSources<Owner>;
  const sources = new SourceController(provider, { ...options, onChange: (keys, groups = []) => { env.notices.push({ keys: [...keys], groups: [...groups] }); cards.sourceChanged(keys, groups); } });
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.0.0', settings: { load: async () => ({ ok: true, syntaxTheme: { kind: 'pi' } }), update: async () => ({ ok: true }) },
    provider: { tryShared: async () => undefined, acquireOwned: async () => { throw Error('unexpected provider'); } } });
  let theme = getThemeByName('system')!;
  const sampled = { get colors() { return theme.colors; }, getFgAnsi(role: Parameters<typeof theme.getFgAnsi>[0]) { env.samples++; if (env.poison) throw Error('Pi poison'); return theme.getFgAnsi(role); },
    getBgAnsi(role: Parameters<typeof theme.getBgAnsi>[0]) { env.samples++; if (env.poison) throw Error('Pi poison'); return theme.getBgAnsi(role); } };
  runtime.palette(sampled);
  cards = new CardSources({ sources, snapshot: () => ({ enabled: env.enabled, provider: provider.snapshot(), selected: env.selected,
    effective: env.selected.kind === 'pi' ? { id: 'pi', label: 'Pi', fingerprint: fingerprintRules(createPiRuleDefinition()) } : env.ready ? env.profile : undefined, standaloneVersion: 'test' }) }, {
    preparePiInput: funding => { env.acquisitions++; return runtime.preparePiInput(sampled, 'truecolor', funding); },
    classify: text => { env.classifications.push(text); env.beforeClassify?.(); if (env.failClassification) throw Error('classification failed'); return highlightCode(text, 'typescript'); },
    invalidate: owner => env.invalidated.push(owner), requestRender: () => { env.renders++; } }, { maxBookkeepingBytes });
  const f = { env, calls, sources, cards, runtime, update(owner: Owner, input: CardDisplayInput) { owner.input = input; return cards.updateDisplay(owner, input); },
    use(owner: Owner, input: CardDisplayInput) { assert.equal(this.update(owner, input), true); cards.useful(owner, input.revision); },
    answerSource(i: number, text: string, context = 1, revision = 1, from = 0) {
      const call = calls[i]!, q = call.request, s = q.sources?.[0] ?? q, bytes = Buffer.byteLength(text), complete = q.op === 'highlight' || !!q.final;
      call.done = true; call.resolve({ v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'source', vocabulary: description.vocabulary.fingerprint,
        sources: [{ key: s.key, generation: s.generation, source_version: s.source_version, revision, source_bytes: bytes, replace_from: from,
          committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
          ...(!complete || q.op === 'stream.append' ? { lease: q.lease ?? 'lease:1' } : {}), contexts: bytes === from ? [] : [[0, context]], runs: bytes === from ? [] : [bytes - from, 1],
          counters: { committed_line_calls: 1, committed_line_bytes: bytes, tail_calls: 0, tail_bytes: 0 } }] } });
    },
    answerStyle(i: number, color = 11, bad = false) {
      const call = calls[i]!, q = call.request, native = q.rules.kind === 'native', definition = q.rules.definition;
      call.done = true; call.resolve({ v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'styles', vocabulary: q.vocabulary,
        rules: bad ? 'f'.repeat(64) : native ? fingerprintNative(q.rules.fingerprint, 'rules') : fingerprintRules(definition),
        styles: q.contexts.length || native ? [{ ...(native ? literal(color) : definition.default), attribute_mask: native ? 15 : 0 }] : [], indices: q.contexts.map(() => 1),
        palette: native ? { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } : null } });
    },
    fault(i: number, execution: 'not_started' | 'unknown' = 'not_started') { calls[i]!.done = true; calls[i]!.reject(new RequestFailure('busy', execution)); },
    piTheme(name: string) { theme = getThemeByName(name)!; return runtime.palette(sampled); },
    native(id = 'native', fingerprint = 'a'.repeat(64)) { env.selected = { kind: 'occipital', id }; env.profile = { id, label: id, fingerprint }; cards.metadataChanged(); },
  };
  fixtures.push(f); return f;
}
async function settle() { for (let i = 0; i < 8; i++) await turn(); }
afterEach(async () => { for (const f of fixtures) { f.cards.dispose(); f.sources.dispose(); await f.runtime.dispose(); for (const c of f.calls) c.reject(new RequestFailure('cleanup', 'not_started')); }
  await settle(); for (const f of fixtures) { assert.equal(f.sources.stats().globalUnsettledJobs, 0); assert.equal(f.sources.stats().retention.retainedBytes, 0); } fixtures.length = 0; });
function inspect(f: ReturnType<typeof fixture>, owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void) { assert.equal(f.cards.visit(owner, consume), true); }
function command(f: ReturnType<typeof fixture>, owner: Owner) { let text: string | undefined; inspect(f, owner, d => { assert.equal(d.kind, 'bash'); if (d.kind === 'bash') text = d.command.text; }); return text; }
function style(f: ReturnType<typeof fixture>, owner: Owner) { let color = ''; inspect(f, owner, (_d, p) => { color = p.roles.code.open; }); return color; }
async function nativeReady(f: ReturnType<typeof fixture>, owner: Owner, text = 'x\n') {
  f.native(); f.use(owner, bash(text, true)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) { if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, text); await settle(); }
}

test('cards prepared display exists before useful work', async () => {
  const f = fixture(), owner = {};
  assert.equal(f.update(owner, bash('a\t界\r\nb')), true);
  inspect(f, owner, (d, p) => { assert.equal(d.kind, 'bash'); if (d.kind === 'bash') { assert.equal(d.command.text, 'a\t界\nb'); assert.ok(d.command.measured.glyphCount); }
    assert.deepEqual(Object.keys(p.roles), CARD_ROLES); assert.equal(p.origin, 'pi'); });
  await settle(); assert.equal(f.calls.length, 0); assert.deepEqual(f.env.classifications, []); assert.equal(f.sources.stats().captures, 0);
});

test('cards cache actual Pi system faint fallback once across warm visits and widths', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('const x=1; // faint')); await settle();
  assert.equal(f.env.classifications.length, 1);
  let faint = false;
  for (const width of [24, 60, 100, 24]) inspect(f, owner, (d, p) => {
    assert.equal(d.kind, 'file'); if (d.kind !== 'file') return;
    const row = d.rows[0]!, region = row.region!, key = row.nextSource!.key;
    const ranges = p.ranges(key)!; assert.ok(ranges); ranges((_a, _b, s) => { faint ||= s.open.includes('\x1b[2m'); });
    const funding = f.sources.geometryFunding()!, layout = reflow(region.measured, { mode: 'file', width }, funding.grant)!;
    const painted = paintFlat(region.text, region.measured, layout, ranges, p.roles.code, p.roles.prompt, Number.MAX_SAFE_INTEGER, funding.budget, funding.grant)!;
    assert.ok(painted); const rows: string[] = []; painted.visitRows((_i, text) => rows.push(stripVTControlCharacters(text)));
    assert.equal(rows.join(''), region.text); painted.dispose(); layout.dispose();
  });
  assert.equal(faint, true); assert.equal(f.env.classifications.length, 1); assert.equal(f.calls.length, 0);
});

test('cards output-only updates and equal-text finalization reuse normalized command measurement', async () => {
  const f = fixture(), owner = {}; f.use(owner, bash('a\tb\n')); await settle();
  let measured: object | undefined, stamp = 0; inspect(f, owner, d => { if (d.kind === 'bash') { measured = d.command.measured; stamp = d.geometryStamp; } });
  const input = { ...bash('a\tb\n'), revision: 2, serviceRevision: 2, node: { args: {}, expanded: false, isPartial: true, result: { content: [{ type: 'text', text: 'out' }] } } };
  assert.equal(f.update(owner, input), true); inspect(f, owner, d => { if (d.kind === 'bash') { assert.equal(d.command.measured, measured); assert.equal(d.service.output[0], 'out'); } });
  const final = { ...input, revision: 3, complete: true, sourceRevision: 3 };
  assert.equal(f.update(owner, final), true); inspect(f, owner, d => { if (d.kind === 'bash') assert.equal(d.command.measured, measured); });
  await settle(); assert.equal(f.cards.identities(owner)[0]!.complete, true); assert.equal(f.env.classifications.length, 0); assert.ok(stamp);
});

test('cards spaced Bash updates remain whole-command neutral even for explicit useful demand', async () => {
  const f = fixture(), owner = {}; f.use(owner, bash('a')); await settle();
  for (const [i, text] of ['ab', 'abc', 'abcd'].entries()) { f.update(owner, bash(text, i === 2, i + 2)); assert.equal(command(f, owner), text); }
  await settle(); assert.deepEqual(f.env.classifications, []); assert.equal(f.sources.stats().piSourceRecords, 0);
});

test('cards render cold/warm geometry and gap/side mapping without source work', async () => {
  const f = fixture(), owner = {}; f.use(owner, edited()); await settle();
  assert.deepEqual(f.env.classifications, ['\tx', 'a', '\ty', 'b']);
  inspect(f, owner, d => { assert.equal(d.kind, 'file'); if (d.kind !== 'file') return;
    assert.deepEqual(d.rows.map(r => r.kind), ['-', '+', 'gap', '-', '+']);
    assert.equal(d.rows[0]!.region!.text, '\tx'); assert.equal(d.rows[1]!.region!.text, '\ty');
    assert.equal(d.rows[0]!.oldSource!.byte, 0); assert.notEqual(d.rows[0]!.oldSource!.key, d.rows[3]!.oldSource!.key);
    assert.notEqual(d.rows[0]!.oldSource!.key, d.rows[1]!.nextSource!.key);
  });
  const before = [f.env.samples, f.env.classifications.length, f.sources.stats().dispatches];
  for (let i = 0; i < 100; i++) { f.cards.useful(owner, 1); inspect(f, owner, () => {}); }
  await settle(); assert.deepEqual([f.env.samples, f.env.classifications.length, f.sources.stats().dispatches], before);
});

test('cards file coordinates include omitted context and preserve tabs without measuring omitted rows', () => {
  const f = fixture(), owner = {};
  const diff = ['-1 old', '+1 new', ...Array.from({ length: 20 }, (_x, i) => ` ${i + 2} \t界${i}`), '-22 old', '+22 new'].join('\n');
  f.update(owner, edited(diff));
  inspect(f, owner, d => { if (d.kind !== 'file') assert.fail('file');
    assert.equal(d.rows.filter(r => r.kind === ' ').length, 6); assert.equal(d.rows.filter(r => r.kind === 'gap').length, 1);
    const last = d.rows.find(r => r.old === 22)!; assert.ok(last.oldSource!.byte > 100); assert.ok(last.oldSource!.utf16 > 50);
    assert.equal(d.rows[2]!.region!.text[0], '\t');
  });
  assert.equal(f.calls.length, 0);
});

test('cards Off releases cached Pi payloads without duplicating unresolved native work; cleanup permits fallback', async () => {
  const f = fixture(true), a = {}, b = {}; f.use(a, written('x')); f.use(b, written('y')); await settle();
  const sourceCalls = f.calls.map((c, i) => ({ c, i })).filter(x => x.c.request.op === 'highlight'); assert.equal(sourceCalls.length, 2);
  assert.equal(f.env.classifications.length, 0);
  f.fault(sourceCalls.find(x => x.c.request.sources[0].text === 'x')!.i); await settle(); assert.deepEqual(f.env.classifications, ['x']);
  f.env.enabled = false; f.sources.setEnabled(false);
  assert.equal(f.sources.stats().piSourceRecords, 0, 'Off explicitly releases the previous Pi payload');
  f.cards.metadataChanged(); await settle();
  assert.deepEqual(f.env.classifications, ['x', 'x'], 'only known no-start x can rebuild its released Pi result; held y remains blocked');
  for (const owner of [a, b]) f.cards.useful(owner, 1);
  f.cards.metadataChanged(); await settle(); assert.deepEqual(f.env.classifications, ['x', 'x'], 'warm Off does not repeat fallback');
  f.sources.ownedStopped(1); await settle(); assert.deepEqual(f.env.classifications.sort(), ['x', 'x', 'y']);
});

test('cards typed unknown work never authorizes a duplicate FILE classifier', async () => {
  const f = fixture(true), owner = {}; f.use(owner, written('x')); await settle(); f.fault(f.calls.findIndex(c => c.request.op === 'highlight'), 'unknown'); await settle();
  for (let i = 0; i < 20; i++) { f.cards.useful(owner, 1); f.cards.metadataChanged(); }
  await settle(); assert.deepEqual(f.env.classifications, []); assert.equal(f.sources.workStatus(f.cards.identities(owner)[0]!.key).fallbackEligible, false);
});

test('cards native whole palette and mixed segments publish atomically without Pi syntax poisoning', async () => {
  const f = fixture(true), owner = {}; f.native(); f.use(owner, edited()); await settle();
  assert.equal(f.env.classifications.length, 0); const first = style(f, owner);
  for (let step = 0; step < 12; step++) {
    let answered = false;
    for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) { const q = f.calls[i]!.request;
      if (q.op === 'styles.resolve') f.answerStyle(i, 77);
      else { f.answerSource(i, q.sources[0].text); }
      answered = true; await settle();
    }
    if (!answered) break;
  }
  assert.notEqual(style(f, owner), first);
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'native'); for (const role of CARD_ROLES) assert.ok(p.roles[role].open.includes('77'));
    for (const identity of f.cards.identities(owner)) { let count = 0; assert.equal(p.ranges(identity.key)!((_a, _b, s) => { count++; assert.ok(s.open.includes('77')); }), true); assert.ok(count); } });
  assert.equal(f.env.classifications.length, 0); f.env.poison = true;
  const samples = f.env.samples; f.update(owner, { ...edited(), revision: 2, palette: 2 }); inspect(f, owner, () => {}); assert.equal(f.env.samples, samples);
});

test('cards actual palette-only group notice is targeted and does not fake an empty source', async () => {
  const f = fixture(true), owner = {}, untouched = {}; f.native(); f.update(owner, { ...written(''), node: { toolName: 'edit', args: { path: 'a' }, isPartial: false, result: {} } });
  f.update(untouched, bash('not useful')); f.cards.useful(owner, 1); await settle();
  const index = f.calls.findIndex(c => c.request.op === 'styles.resolve'); assert.ok(index >= 0); assert.deepEqual(f.calls[index]!.request.contexts, []);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, 0); f.env.invalidated.length = 0; f.answerStyle(index, 43); await settle();
  assert.ok(f.env.notices.some(n => n.keys.length === 0 && n.groups.length === 1)); assert.deepEqual(f.env.invalidated, [owner]);
  assert.equal(f.sources.stats().sourceRecords, 0); inspect(f, owner, (_d, p) => assert.equal(p.origin, 'native'));
});

test('cards equal-color metadata refresh replaces readers without geometry or paint churn', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const before = f.cards.displayStamp(owner);
  let measured: object | undefined; inspect(f, owner, d => { if (d.kind === 'bash') measured = d.command.measured; });
  f.env.invalidated.length = 0; f.native('native2', 'b'.repeat(64)); await settle();
  const i = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); assert.ok(i >= 0); f.answerStyle(i, 11); await settle();
  inspect(f, owner, d => { if (d.kind === 'bash') assert.equal(d.command.measured, measured); });
  assert.equal(f.cards.displayStamp(owner), before); assert.deepEqual(f.env.invalidated, []);
});

test('cards theme changes never reparse ready sources and failed selections retain the native frame', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const nativeSources = f.calls.filter(c => c.request.op !== 'styles.resolve').length, original = style(f, owner);
  f.native('native2', 'b'.repeat(64)); await settle(); assert.equal(style(f, owner), original);
  const index = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); f.answerStyle(index, 22, true); await settle();
  assert.equal(style(f, owner), original); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, nativeSources);
  assert.equal(f.env.classifications.length, 0);
});

test('cards live frozen Bash accepts latest prepared display without reopening work', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); f.cards.freeze(owner); const count = f.calls.length;
  f.update(owner, bash('x\nnew\t界', false, 2)); assert.equal(command(f, owner), 'x\nnew\t界'); f.cards.useful(owner, 2); await settle();
  assert.equal(f.calls.length, count); assert.equal(f.env.classifications.length, 0);
});

test('cards pause retains display and physical authority until explicit useful resumption', async () => {
  const f = fixture(true), owner = {}; f.use(owner, bash('held', true)); await settle(); f.cards.pause(owner);
  const key = f.cards.identities(owner)[0]!.key; assert.equal(command(f, owner), 'held'); assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  f.update(owner, bash('latest', true, 2)); f.cards.metadataChanged(); await settle(); assert.equal(command(f, owner), 'latest');
  assert.equal(f.calls.filter(c => c.request.op === 'highlight').length, 1); f.cards.useful(owner, 2); await settle(); assert.equal(f.cards.identities(owner)[0]!.key, key);
});

test('cards removal disposal and reentrant replacement cannot resurrect pending ownership', async () => {
  for (const operation of ['remove', 'dispose', 'pause', 'replace'] as const) {
    const f = fixture(), owner = {}; f.env.beforeClassify = () => {
      f.env.beforeClassify = undefined;
      if (operation === 'remove') f.cards.remove(owner); else if (operation === 'dispose') f.cards.dispose(); else if (operation === 'pause') f.cards.pause(owner); else f.update(owner, written('new', 2));
    };
    f.use(owner, written('old')); await settle();
    if (operation === 'remove' || operation === 'dispose') assert.equal(f.cards.identities(owner).length, 0);
    else if (operation === 'replace') inspect(f, owner, d => { if (d.kind === 'file') assert.equal(d.rows[0]!.region!.text, 'new'); });
    assert.equal(f.env.classifications.length, 1);
  }
});

test('cards visitor invalidates reentrantly, pins data through throw and clears escaped accessors', () => {
  const f = fixture(), owner = {}; f.update(owner, bash('x'.repeat(2048)));
  let escaped: PreparedCard | undefined, paint: ReadyCardPaint | undefined;
  const funding = f.sources.geometryFunding()!;
  assert.throws(() => f.cards.visit(owner, (d, p) => { escaped = d; paint = p; f.cards.remove(owner);
    assert.ok(funding.budget.stats().retainedBytes > 0); assert.throws(() => d.kind, /stale/); throw Error('consumer'); }), /consumer/);
  assert.throws(() => escaped!.kind, /stale/); assert.throws(() => paint!.roles, /stale/); assert.equal(paint!.ranges('missing'), undefined);
});

test('cards first active owner collects and releases descriptors while consumer and peer live', async () => {
  const f = fixture(), peer = {}; f.use(peer, written('peer')); await settle();
  function abandoned() { const first = {}; f.use(first, written('first')); return new WeakRef(first); }
  const weak = abandoned(); await settle(); const before = f.sources.stats().retention.retainedBytes;
  f.env.invalidated.length = 0;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await settle(); if (!weak.deref()) break; }
  assert.equal(weak.deref(), undefined); assert.ok(f.sources.stats().retention.retainedBytes < before); inspect(f, peer, () => {});
  console.log(JSON.stringify({ firstOwnerGC: true, before, after: f.sources.stats().retention.retainedBytes }));
});

test('cards first active pending native owner collects with pending peer and consumer live', async () => {
  const f = fixture(true), peer = {};
  function abandoned() { const owner = {}; f.use(owner, bash('first', true)); return new WeakRef(owner); }
  const first = abandoned(); f.use(peer, bash('peer', true)); await settle();
  f.env.invalidated.length = 0;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await settle(); if (!first.deref()) break; }
  assert.equal(first.deref(), undefined); assert.equal(command(f, peer), 'peer');
});

test('cards eviction refusal and cached failure never cause warm frame retry spin', async () => {
  for (const fail of [true, false]) { const f = fixture(false, fail ? {} : { retention: { maxBytes: 128 * 1024 } }), owner = {};
    f.env.failClassification = fail; f.use(owner, written('x')); await settle(); const calls = f.env.classifications.length;
    for (let i = 0; i < 50; i++) f.cards.useful(owner, 1); await settle(); assert.equal(f.env.classifications.length, calls);
  }
});

test('cards bookkeeping refusal is bounded and memoized without warm retries', async () => {
  const f = fixture(false, {}, RETENTION_LIMITS.entryAllowance), owners = Array.from({ length: 50 }, () => ({}));
  const results = owners.map(owner => f.update(owner, bash('x'))); for (const owner of owners) f.cards.useful(owner, 1); await settle();
  assert.ok(results.some(ok => !ok)); assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0);
});

for (const episode of ['startup', 'connection reset']) test(`cards online wait: all demanded Bash cards resume after ${episode}, coalescing latest text`, async () => {
  const f = fixture(), a = {}, b = {}; if (episode === 'connection reset') f.env.generation = 2;
  f.use(a, bash('a', true)); f.use(b, bash('b', true)); await settle(); f.update(a, bash('latest a', true, 2)); f.update(b, bash('latest b', true, 2)); await settle();
  assert.equal(f.calls.length, 0); f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.deepEqual(f.calls.filter(c => c.request.op === 'highlight').map(c => c.request.sources[0].text).sort(), ['latest a', 'latest b']);
  assert.equal(f.env.classifications.length, 0);
});

test('cards online wait: ready scan skips removed frozen unrequested and paused owners', async () => {
  const f = fixture(), live = {}, removed = {}, frozen = {}, paused = {}, unrequested = {};
  for (const [owner, name] of [[live, 'live'], [removed, 'removed'], [frozen, 'frozen'], [paused, 'paused']] as const) f.use(owner, bash(name, true));
  f.update(unrequested, bash('unrequested', true)); await settle(); f.cards.remove(removed); f.cards.freeze(frozen); f.cards.pause(paused);
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.deepEqual(f.calls.filter(c => c.request.op === 'highlight').map(c => c.request.sources[0].text), ['live']);
  f.cards.useful(paused, 1); await settle(); assert.ok(f.calls.some(c => c.request.sources?.[0]?.text === 'paused'));
});

test('cards LIFO backlog retains newest-first order and yields after two preparations', async () => {
  const f = fixture(), owners = Array.from({ length: 8 }, () => ({}));
  owners.forEach((owner, i) => f.use(owner, written(`x${i}`)));
  await turn(); assert.ok(f.env.classifications.length <= 2); await settle();
  assert.deepEqual(f.env.classifications, ['x7', 'x6', 'x5', 'x4', 'x3', 'x2', 'x1', 'x0']);
});

test('cards Bash service preparation preserves timeout reminder and phase policy', () => {
  const node = { args: { description: 'desc\nline' }, expanded: false, isPartial: false, argsComplete: false,
    result: { isError: true, content: [{ type: 'text', text: 'out\n\n[command timed out]\n[exit code: 124]\n\n<system-reminder>\nreminder\n</system-reminder>' }], details: { exit_code: 124 } } };
  const prepared = prepareBashService(node, 'a\tb'); assert.equal(prepared.footer, '[exit code: 124; error: command timed out]');
  assert.deepEqual(prepared.output.slice(prepared.first, prepared.last), ['out']); assert.equal(prepared.output[prepared.reminder], '<system-reminder>');
  assert.equal(prepared.description, 'desc line'); assert.equal(prepared.heading, '# Running in a b');
  assert.equal(prepareBashService({ ...node, result: { isError: true, content: [] } }).footer, '[error: incomplete tool call]');
});

test('cards successful write and logical file preparation reuse existing saved diff continuity', () => {
  const input = edited(); if (input.kind !== 'file') assert.fail('file'); const normal = prepareFileCard(input.node)!, logical = prepareFileCard(input.node, true)!;
  assert.deepEqual(normal.sources.map(s => s.text), ['\tx', 'a', '\ty', 'b']); assert.deepEqual(logical.sources, []);
  assert.equal(logical.view.lines[0]!.kind === 'gap' ? '' : logical.view.lines[0]!.text, '\tx');
});


test('cards lifecycle cold native preparation has zero SOURCE STYLE and classifier demand', async () => {
  const f = fixture(true), owner = {}; f.native(); f.update(owner, bash('cold', true)); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0); assert.equal(command(f, owner), 'cold');
});

test('cards warm resize readers do zero normalization measurement sampling compilation classifier or RPC', async () => {
  const f = fixture(), owner = {}, marker = 'normalization\tmarker';
  let normalizations = 0, measurements = 0, compilations = 0;
  const replace = String.prototype.replace, segment = Intl.Segmenter.prototype.segment, freeze = Object.freeze;
  String.prototype.replace = function(search: any, replacement: any) { if (String(this) === marker && search instanceof RegExp && search.source === '\\r\\n?') normalizations++; return replace.call(this, search, replacement); };
  Intl.Segmenter.prototype.segment = function(input: string) { if (input === marker) measurements++; return segment.call(this, input); };
  Object.freeze = ((value: any) => { if (typeof value?.open === 'string' && typeof value?.close === 'string') compilations++; return freeze(value); }) as typeof Object.freeze;
  try {
    f.update(owner, bash(marker)); assert.ok(normalizations > 0); assert.ok(measurements > 0); assert.ok(compilations > 0);
    const before = [normalizations, measurements, compilations, f.env.samples, f.env.classifications.length, f.calls.length];
    for (const width of [12, 60, 100, 12]) for (let i = 0; i < 25; i++) inspect(f, owner, (d, p) => {
      if (d.kind !== 'bash') assert.fail('bash');
      const funding = f.sources.geometryFunding()!, layout = reflow(d.command.measured, { mode: 'bash', width }, funding.grant)!;
      const plain: FlatRangeReader = () => true;
      const painted = paintFlat(d.command.text, d.command.measured, layout, plain, p.roles.title, p.roles.prompt, 0, funding.budget, funding.grant)!;
      assert.ok(painted); painted.dispose(); layout.dispose();
    });
    assert.deepEqual([normalizations, measurements, compilations, f.env.samples, f.env.classifications.length, f.calls.length], before);
    const input = { ...bash(marker), revision: 2, serviceRevision: 2, node: { args: {}, expanded: false, isPartial: true, result: { content: [{ type: 'text', text: 'output only' }] } } };
    f.update(owner, input); assert.deepEqual([normalizations, measurements], before.slice(0, 2));
    console.log(JSON.stringify({ warmReader: { frames: 100, newNormalizations: 0, newCommandMeasurements: 0, newCompilations: 0, newSamples: 0, newClassifiers: 0, newRPC: 0 } }));
  } finally { String.prototype.replace = replace; Intl.Segmenter.prototype.segment = segment; Object.freeze = freeze; }
});

test('cards native equal-text completion flushes final append after an in-flight reply', async () => {
  const f = fixture(true), owner = {}; f.use(owner, bash('echo x')); await settle();
  const first = f.calls.findIndex(c => c.request.op === 'stream.open'); assert.ok(first >= 0);
  f.update(owner, bash('echo x', true, 2)); await settle(); assert.equal(f.calls.filter(c => c.request.op === 'stream.append').length, 0);
  f.answerSource(first, 'echo x'); await settle(); const append = f.calls.findIndex(c => c.request.op === 'stream.append');
  assert.ok(append >= 0); assert.equal(f.calls[append]!.request.final, true); assert.equal(f.calls[append]!.request.append, '');
  f.answerSource(append, 'echo x', 1, 2, 0); await settle(); assert.equal(f.env.classifications.length, 0);
});

test('cards equal-text FILE revision aliases exact Pi classification rather than reparsing', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('const x = 1')); await settle();
  f.use(owner, written('const x = 1', 2)); await settle(); assert.deepEqual(f.env.classifications, ['const x = 1']);
  inspect(f, owner, (_d, p) => assert.ok(p.ranges(f.cards.identities(owner)[0]!.key)));
});

test('cards deferred obsolete source reply never paints replacement and only current keys invalidate', async () => {
  const f = fixture(true), owner = {}; f.native(); f.use(owner, bash('old', true)); await settle();
  const first = f.calls.findIndex(c => c.request.op === 'highlight'); f.update(owner, bash('new', true, 2)); f.cards.useful(owner, 2); await settle();
  f.answerSource(first, 'old'); await settle(); assert.equal(command(f, owner), 'new');
  f.cards.remove(owner); f.env.invalidated.length = 0;
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) f.fault(i);
  await settle(); assert.deepEqual(f.env.invalidated, []); assert.deepEqual(f.cards.identities(owner), []);
});

test('cards Bash retains validated native prefix while latest display append is held without Pi fallback', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner, 'x\n'); const before = f.calls.length;
  f.update(owner, bash('x\nnew界', false, 2));
  let basis = '', colored = 0;
  inspect(f, owner, (d, p) => { assert.equal(d.kind, 'bash'); assert.equal(p.origin, 'native');
    const key = f.cards.identities(owner)[0]!.key;
    assert.equal(p.basis(key, (text, ranges) => { basis = text; assert.equal(ranges((_a, b) => { colored = b; }), true); }), true);
  });
  assert.equal(command(f, owner), 'x\nnew界'); assert.equal(basis, 'x\n'); assert.equal(colored, 2);
  assert.equal(f.calls.length, before); assert.equal(f.env.classifications.length, 0);
});

for (const invalid of ['patch', 'content', 'command'] as const) test(`P0 cards invalid ${invalid} preparation preserves held key authority until restored`, async () => {
  const f = fixture(true), owner = {}, input = invalid === 'command' ? bash('held', true) : written('held'); f.use(owner, input); await settle();
  const key = f.cards.identities(owner)[0]!.key;
  const broken = invalid === 'command' ? { ...bash('held', true, 2), args: { command: undefined } } : invalid === 'content'
    ? { ...written('', 2), node: { toolName: 'write', args: { path: 'a' }, isPartial: false, result: {} } }
    : { ...edited('', 2), node: { toolName: 'edit', args: { path: 'a' }, isPartial: false, result: { details: { patch: '@@ -1 +1 @@\n-x' } } } };
  f.update(owner, broken); f.cards.useful(owner, 2); await settle(); assert.equal(f.cards.identities(owner)[0]!.key, key);
  assert.equal(f.sources.workStatus(key).fallbackEligible, false); assert.equal(f.env.classifications.length, 0);
  f.use(owner, invalid === 'command' ? bash('held', true, 3) : written('held', 3)); await settle();
  assert.equal(f.cards.identities(owner)[0]!.key, key); assert.equal(f.env.classifications.length, 0);
});

test('cards LF display paths unsupported wire hints and independent peer preserve full glyphs', async () => {
  const f = fixture(true), a = {}, b = {}; const input = written('\t界 full', 1, 'a\nb.ts'); input.language = 'bad\nhint';
  f.use(a, input); f.use(b, written('peer')); await settle();
  const native = f.calls.find(c => c.request.sources?.[0]?.text === '\t界 full')!.request.sources[0];
  assert.equal(native.path, undefined); assert.equal(native.language, undefined);
  inspect(f, a, d => { if (d.kind !== 'file') assert.fail('file'); assert.equal(d.rows[0]!.region!.text, '\t界 full'); assert.ok(d.heading!.text.includes('a b.ts')); });
  assert.ok(f.calls.some(c => c.request.sources?.[0]?.text === 'peer')); assert.equal(f.env.classifications.length, 0);
});

test('cards actual canonical local refusal enables exactly one FILE Pi fallback without manual retry', async () => {
  const f = fixture(true, { maxTransientBytes: 128 }), owner = {}; f.use(owner, written('x')); await settle();
  assert.equal(f.env.classifications.length, 1); const count = f.calls.length;
  for (let i = 0; i < 100; i++) f.cards.useful(owner, 1); await settle(); assert.equal(f.env.classifications.length, 1); assert.equal(f.calls.length, count);
});

test('cards unavailable metadata does not relabel a processed refusal as new deferred demand', async () => {
  const f = fixture(true, { maxTransientBytes: 128 }), owner = {}; f.use(owner, bash('x', true)); await settle();
  const calls = f.calls.length; f.env.ready = false; f.env.generation++; f.cards.metadataChanged(); await settle(); f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, 0);
});

test('cards ready static Bash and FILE fallback do not reparse on same-profile provider recovery', async () => {
  const f = fixture(true), a = {}; await nativeReady(f, a); const sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.env.ready = false; f.env.generation++; f.cards.metadataChanged(); await settle(); f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
});

test('cards 100 held native profile choices coalesce, retain ready paint and never reparse', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const original = style(f, owner), nativeCount = f.calls.filter(c => c.request.op !== 'styles.resolve').length, initialStyles = f.calls.filter(c => c.request.op === 'styles.resolve').length;
  for (let i = 2; i <= 101; i++) { f.native(`n${i}`, i.toString(16).padStart(64, '0')); await settle(); }
  assert.equal(f.sources.stats().unsettledJobs, 2); assert.equal(style(f, owner), original);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, nativeCount);
  assert.equal(f.calls.filter(c => c.request.op === 'styles.resolve').length, initialStyles + 2);
});

test('cards rollback rejects late preview colors before a preparation turn', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const color = style(f, owner), count = f.calls.length;
  f.native('preview', 'b'.repeat(64)); await settle(); const preview = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve');
  f.native(); f.answerStyle(preview, 99); await settle(); assert.equal(style(f, owner), color);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, f.calls.slice(0, count).filter(c => c.request.op !== 'styles.resolve').length);
});

test('cards palette-only updates preserve logical file geometry and source identities', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('x')); await settle(); let measured: object | undefined;
  inspect(f, owner, d => { if (d.kind === 'file') measured = d.rows[0]!.region!.measured; }); const identity = f.cards.identities(owner)[0]!;
  f.update(owner, { ...written('x'), revision: 2, palette: 2 }); f.cards.useful(owner, 2); await settle();
  inspect(f, owner, d => { if (d.kind === 'file') assert.equal(d.rows[0]!.region!.measured, measured); });
  assert.equal(f.cards.identities(owner)[0]!.version, identity.version); assert.equal(f.cards.identities(owner)[0]!.key, identity.key);
});


for (const count of [1, 2, 4, 8]) test(`cards online wait: ${count} owners obey physical credit and complete once`, async () => {
  const f = fixture(), owners = Array.from({ length: count }, () => ({})); owners.forEach((o, i) => f.use(o, bash(`owner${i}`, true))); await settle();
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  let rounds = 0;
  while (rounds++ < count * 5 + 8) {
    const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    assert.ok(f.sources.stats().unsettledJobs <= 2);
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); }
    await settle();
  }
  assert.equal(f.calls.filter(c => c.request.op === 'highlight').length, count); assert.equal(f.sources.stats().unsettledJobs, 0);
  const n = f.calls.length; for (const o of owners) f.cards.useful(o, 1); f.cards.metadataChanged(); await settle(); assert.equal(f.calls.length, n);
});

for (const reentrant of [false, true]) test(`cards preparation preserves two-owner host yield with reentrant=${reentrant}`, async () => {
  const f = fixture(), owners = Array.from({ length: 8 }, () => ({})), extra = {};
  owners.forEach((o, i) => f.use(o, written(`owner${i}`)));
  if (reentrant) f.env.beforeClassify = () => { f.env.beforeClassify = undefined; f.use(extra, written('extra')); };
  await turn(); assert.ok(f.env.classifications.length <= 2); await settle(); assert.equal(f.env.classifications.length, 8 + Number(reentrant));
});

test('cards actual credit wake local refusal triggers one FILE fallback without polling', async () => {
  const active = fixture(true), a = {}, b = {}; active.use(a, bash('a', true)); active.use(b, bash('b', true)); await settle();
  assert.equal(active.sources.stats().unsettledJobs, 2);
  const f = fixture(true, { maxTransientBytes: 128 }), owner = {}; f.use(owner, written('x')); await settle();
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 0);
  active.fault(active.calls.findIndex(c => c.request.op === 'highlight')); await settle(); assert.deepEqual(f.env.classifications, ['x']);
  const counts = [f.env.classifications.length, f.env.notices.length, f.calls.length]; for (let i = 0; i < 10; i++) await turn();
  assert.deepEqual([f.env.classifications.length, f.env.notices.length, f.calls.length], counts);
});

test('cards held native slots do not delay an unrelated FILE fallback while native is off', async () => {
  const f = fixture(true), a = {}, b = {}, independent = {}; f.use(a, bash('a', true)); f.use(b, bash('b', true)); await settle();
  f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); f.use(independent, written('independent')); await settle();
  assert.deepEqual(f.env.classifications, ['independent']); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
});

test('cards a ready recent result publishes independently while its recent peer remains held', async () => {
  const f = fixture(true), a = {}, b = {}; f.native(); f.use(a, bash('a', true)); f.use(b, bash('b', true)); await settle();
  const bCall = f.calls.findIndex(c => c.request.sources?.[0]?.text === 'b'); f.answerSource(bCall, 'b'); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 33); await settle(); }
  inspect(f, b, (_d, p) => assert.equal(p.origin, 'native')); assert.ok(f.calls.some(c => !c.done && c.request.sources?.[0]?.text === 'a'));
});

test('cards reentrant pause preserves exact Pi fallback evidence without a duplicate classifier', async () => {
  const f = fixture(), owner = {}; f.env.beforeClassify = () => { f.env.beforeClassify = undefined; f.cards.pause(owner); };
  f.use(owner, written('x')); await settle(); f.cards.useful(owner, 1); await settle(); assert.deepEqual(f.env.classifications, ['x']);
});

test('cards source path language changes retain key identity but update canonical demand', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('x')); await settle(); const key = f.cards.identities(owner)[0]!.key;
  const input = written('y', 2, 'next.py'); input.language = 'python'; f.use(owner, input); await settle();
  assert.equal(f.cards.identities(owner)[0]!.key, key); assert.equal(f.cards.identities(owner)[0]!.language, 'python'); assert.deepEqual(f.env.classifications, ['x', 'y']);
});

test('cards thrown or denied descriptor funding preserves old display and refunds new grants', () => {
  for (const mode of ['deny', 'throw']) {
    const f = fixture(), owner = {}; f.update(owner, bash('old')); const original = f.sources.geometryFunding.bind(f.sources), funding = original()!, before = funding.budget.stats().retainedBytes;
    f.sources.geometryFunding = group => { const current = original(group); if (!current) return undefined; return { budget: current.budget, grant: () => { if (mode === 'throw') throw Error('funding failure'); return undefined; } }; };
    if (mode === 'throw') assert.throws(() => f.update(owner, bash('replacement', false, 2)), /funding failure/);
    else assert.equal(f.update(owner, bash('replacement', false, 2)), false);
    f.sources.geometryFunding = original; assert.equal(command(f, owner), 'old'); assert.equal(funding.budget.stats().retainedBytes, before);
  }
});

test('cards yielded backlog cannot retain an unprepared owner or revive a disposed consumer', async () => {
  const f = fixture(true), peers = Array.from({ length: 4 }, () => ({}));
  function abandoned() { const owner = {}; f.use(owner, bash('gone', true)); return new WeakRef(owner); }
  const weak = abandoned(); peers.forEach((o, i) => f.use(o, bash(`peer${i}`, true))); await settle(); f.env.invalidated.length = 0;
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await settle(); if (!weak.deref()) break; }
  assert.equal(weak.deref(), undefined); assert.equal(f.calls.some(c => c.request.sources?.[0]?.text === 'gone'), false);
  const n = f.calls.length; f.cards.dispose(); for (let i = 0; i < f.calls.length; i++) f.fault(i); await settle(); assert.equal(f.calls.length, n);
});


test('cards actual Pi palette replacement classifies once without logical file normalization or geometry rebuild', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('const x = 1; // palette')); await settle();
  let measured: object | undefined; inspect(f, owner, d => { if (d.kind === 'file') measured = d.rows[0]!.region!.measured; });
  const palette = f.piTheme('light'); f.update(owner, { ...written('const x = 1; // palette'), revision: 2, palette });
  f.cards.useful(owner, 2); await settle(); assert.equal(f.env.classifications.length, 2);
  inspect(f, owner, d => { if (d.kind === 'file') assert.equal(d.rows[0]!.region!.measured, measured); });
  for (let i = 0; i < 100; i++) f.cards.useful(owner, 2); await settle(); assert.equal(f.env.classifications.length, 2); assert.equal(f.calls.length, 0);
});

for (const kind of ['bash', 'file'] as const) test(`cards every warm ${kind} owner recolors newest first without SOURCE replay`, async () => {
  const f = fixture(true), owners = [{}, {}, {}]; f.native();
  owners.forEach((o, i) => f.use(o, kind === 'bash' ? bash(`x${i}`, true) : written(`x${i}`))); await settle();
  for (let round = 0; round < 20; round++) { const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); } await settle(); }
  const before = f.calls.filter(c => c.request.op !== 'styles.resolve').length; f.env.invalidated.length = 0;
  f.native('next', 'b'.repeat(64)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 44); await settle(); }
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, before);
  for (const o of owners) assert.ok(style(f, o).includes('44'));
});

test('cards same-ID fingerprint refresh then Follow Pi replaces all roles without SOURCE replay', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const original = style(f, owner), sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.native('native', 'b'.repeat(64)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 66); await settle(); }
  assert.notEqual(style(f, owner), original);
  f.env.selected = { kind: 'pi' }; f.cards.metadataChanged(); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i); await settle(); }
  inspect(f, owner, (_d, p) => assert.equal(p.origin, 'pi')); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources);
});

test('cards offline incompatible selection retains the complete native file palette without Pi classification', async () => {
  const f = fixture(true), owner = {}; f.native(); f.use(owner, written('x')); await settle();
  for (let round = 0; round < 10; round++) { const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i, 55); else f.answerSource(i, c.request.sources[0].text); } await settle(); }
  const before = style(f, owner); f.env.ready = false; f.native('offline', 'b'.repeat(64)); await settle();
  assert.equal(style(f, owner), before); assert.equal(f.env.classifications.length, 0);
});


test('cards unsupported partial malformed and error files are source-less rather than fake empty parsers', async () => {
  const f = fixture(true); f.native();
  const cases: CardDisplayInput[] = [
    { ...written('proposal'), node: { toolName: 'write', args: { path: 'a', content: 'proposal' }, isPartial: true, result: {} } },
    { ...written('failed'), node: { toolName: 'write', args: { path: 'a', content: 'failed' }, isPartial: false, result: { isError: true } } },
    { ...edited(), node: { toolName: 'edit', args: { path: 'a' }, isPartial: false, result: { details: { patch: '@@ -1 +1 @@\n-old' } } } },
  ];
  const owners = cases.map(input => { const o = {}; f.use(o, input); return o; }); await settle();
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, 0); assert.equal(f.env.classifications.length, 0); assert.equal(f.sources.stats().sourceRecords, 0);
  for (const o of owners) assert.deepEqual(f.cards.identities(o), []);
});

test('cards palette acquisition reentrant removal releases the returned funded lease and cannot publish', async () => {
  const f = fixture(), owner = {}, original = f.runtime.preparePiInput.bind(f.runtime);
  f.runtime.preparePiInput = (...args) => { const lease = original(...args); f.cards.remove(owner); return lease; };
  assert.equal(f.update(owner, bash('reentrant')), false); assert.deepEqual(f.cards.identities(owner), []);
  assert.equal(f.cards.visit(owner, () => assert.fail('removed owner')), false);
  f.sources.setStyleSelection(undefined); await settle(); assert.equal(f.sources.stats().retention.retainedBytes, 0);
});


test('cards reentrant disposal during source capture cannot publish payload or revive keys', async () => {
  const f = fixture(), owner = {}, capture = f.sources.capturePiSource.bind(f.sources);
  f.sources.capturePiSource = (...args) => { f.cards.dispose(); return capture(...args); };
  f.use(owner, written('x')); await settle(); assert.deepEqual(f.cards.identities(owner), []);
  assert.equal(f.sources.stats().piSourceRecords, 0); assert.equal(f.cards.visit(owner, () => assert.fail('disposed')), false);
});


test('cards prepared Bash service measurements use explicit roles and original output coordinates', () => {
  const f = fixture(), owner = {}, input = bash('echo x', true);
  input.args.description = 'desc\nline'; input.directory = 'a\tb';
  input.node = { args: {}, expanded: false, isPartial: false, result: { isError: true, details: { exit_code: 124 }, content: [
    { type: 'text', text: 'out\n\n[command timed out]\n[exit code: 124]\n\n<system-reminder>\nnote\n</system-reminder>' }] } };
  f.update(owner, input); inspect(f, owner, d => { if (d.kind !== 'bash') assert.fail('bash');
    assert.equal(d.regions.description!.text, '# desc line'); assert.equal(d.regions.heading!.text, '# Running in a b');
    assert.equal(d.regions.output[0]!.text, 'out'); assert.equal(d.regions.output[2], undefined); assert.equal(d.regions.output[3], undefined);
    assert.equal(d.regions.output[d.service.reminder]!.text, '<system-reminder>'); assert.ok(d.regions.footer!.text.includes('command timed out'));
  });
});


test('cards file service diagnostics and notes are prepared while cwd updates reuse source measurements', () => {
  const f = fixture(), owner = {}, input = written('x');
  input.node.result = { details: { noOp: true, diagnostics: [{ severity: 'error', line: 3, message: 'bad\n\tmessage\x1b[31m' }, { severity: 'warning', message: 'ignored' }] } };
  f.update(owner, input); let measured: object | undefined;
  inspect(f, owner, d => { if (d.kind !== 'file') assert.fail('file'); measured = d.rows[0]!.region!.measured;
    assert.equal(d.note!.text, 'No changes.'); assert.equal(d.diagnostics[0]!.text, 'Error [3]: bad message'); assert.equal(d.diagnostics.length, 1); assert.equal(d.error, false); });
  f.update(owner, { ...input, revision: 2, serviceRevision: 2, cwd: '/different' });
  inspect(f, owner, d => { if (d.kind === 'file') assert.equal(d.rows[0]!.region!.measured, measured); });
  assert.equal(f.calls.length, 0); assert.equal(f.env.classifications.length, 0);
});


test('cards denied replacement lookup retains complete native roles with neutral revoked readers', async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); const before = style(f, owner), key = f.cards.identities(owner)[0]!.key;
  const funding = f.sources.geometryFunding.bind(f.sources), stamp = f.cards.displayStamp(owner);
  f.sources.geometryFunding = group => { const original = funding(group); return original && { budget: original.budget, grant: bytes => bytes > 4096 ? undefined : original.grant(bytes) }; };
  f.native('next', 'b'.repeat(64)); await settle(); const i = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); assert.ok(i >= 0);
  f.answerStyle(i, 22); await settle();
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'native'); assert.equal(p.roles.code.open, before); assert.equal(p.ranges(key), undefined); });
  assert.notEqual(f.cards.displayStamp(owner), stamp); assert.equal(f.env.classifications.length, 0);
  f.sources.geometryFunding = funding; f.update(owner, { ...bash('x\n', true), revision: 2 }); assert.ok(style(f, owner).includes('38;2;22;2;3m'));
});

for (const native of [false, true]) test(`review F1: changed file never borrows previous ranges before preparation, native=${native}`, async () => {
  const f = fixture(native), owner = {}; if (native) f.native();
  f.use(owner, written('const previous = 1')); await settle();
  if (native) for (let round = 0; round < 8; round++) {
    const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); }
    await settle();
  }
  const key = f.cards.identities(owner)[0]!.key;
  inspect(f, owner, (_d, p) => assert.ok(p.ranges(key), 'positive ready old-source control'));
  const calls = f.calls.length, classifications = f.env.classifications.length;
  if (native) {
    f.env.ready = false; f.cards.metadataChanged();
    inspect(f, owner, (_d, p) => assert.ok(p.ranges(key), 'provider loss alone preserves unchanged file colors'));
  }
  assert.equal(f.update(owner, written('x', 2)), true);
  inspect(f, owner, (d, p) => {
    if (d.kind !== 'file') assert.fail('file'); assert.equal(d.rows[0]!.region!.text, 'x');
    assert.equal(p.ranges(d.rows[0]!.nextSource!.key), undefined, 'new text must be neutral before current-source proof');
    assert.equal(p.basis(key, () => assert.fail('previous file is not a historical Bash basis')), false);
    assert.equal(p.origin, native ? 'native' : 'pi'); assert.deepEqual(Object.keys(p.roles), CARD_ROLES);
  });
  assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, classifications);
  f.cards.useful(owner, 2); await settle();
  if (!native) { assert.equal(f.env.classifications.length, classifications + 1); inspect(f, owner, (_d, p) => assert.ok(p.ranges(key))); }
  else {
    assert.equal(f.sources.borrowSource(key)?.version, 1, 'offline preparation does not observe the new SOURCE');
    assert.ok(f.sources.displayBasis(key), 'the canonical historical native display is still owned');
    inspect(f, owner, (d, p) => {
      if (d.kind !== 'file') assert.fail('file'); assert.equal(d.rows[0]!.region!.text, 'x');
      assert.equal(p.origin, 'native'); assert.deepEqual(Object.keys(p.roles), CARD_ROLES);
      assert.equal(p.ranges(key), undefined, 'new demand metadata cannot make the previous FILE ranges compatible');
      assert.equal(p.basis(key, () => assert.fail('deferred offline preparation cannot publish the old file text')), false);
    });
    assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, classifications);
  }
});

for (const otherOwner of [false, true]) test(`review F2: rejected native selection retries at a cold update after real funding recovery, otherOwner=${otherOwner}`, async () => {
  const f = fixture(true), owner = {}; f.update(owner, bash('selection', true));
  const budget = f.sources.geometryFunding()!.budget, select = f.sources.setStyleSelection.bind(f.sources);
  let pressure: ReturnType<typeof budget.reserve>, refuse = true;
  const accepted: boolean[] = [];
  f.sources.setStyleSelection = input => {
    if (input?.kind === 'native') {
      if (refuse && !pressure) { const usage = budget.stats(); pressure = budget.reserve(usage.limit - usage.retainedBytes - usage.outstandingPeakBytes); assert.ok(pressure); }
      const result = select(input); accepted.push(result); return result;
    }
    return select(input);
  };
  try {
    f.native(); f.update(owner, { ...bash('selection', true), revision: 2 });
    assert.deepEqual(accepted, [false], 'actual controller admission must refuse with its existing budget');
    pressure!.close(); pressure = undefined; refuse = false;
    const current = otherOwner ? {} : owner;
    assert.equal(f.update(current, { ...bash('selection', true), revision: 3 }), true);
    assert.deepEqual(accepted, [false, true], 'a refusal cannot be memoized as installed');
    f.cards.useful(current, 3); await settle();
    const source = f.calls.findIndex(c => c.request.op !== 'styles.resolve'); assert.ok(source >= 0); f.answerSource(source, 'selection'); await settle();
    assert.ok(f.calls.some(c => c.request.op === 'styles.resolve' && c.request.rules.kind === 'native'));
  } finally { pressure?.close(); f.sources.setStyleSelection = select; }
});

for (const kind of ['bash', 'file'] as const) test(`review F3: prepared ${kind} containers reject mutation without freezing opaque handles`, () => {
  const f = fixture(), owner = {}, input = kind === 'bash' ? bash('echo x') : edited();
  if (input.kind === 'bash') input.node = { args: {}, expanded: false, isPartial: false, result: { content: [{ type: 'text', text: 'out' }] } };
  f.update(owner, input); let checkAgain: (() => void) | undefined;
  inspect(f, owner, (d, p) => {
    assert.equal(Reflect.set(p.roles, 'code', p.roles.title), false, 'role table is immutable');
    if (d.kind === 'bash') {
      const service = d.service, regions = d.regions;
      checkAgain = () => { assert.throws(() => Array.prototype.pop.call(service.output), TypeError); assert.equal(Reflect.set(service, 'footer', 'forged'), false); };
      checkAgain(); assert.equal(Reflect.set(regions, 'footer', undefined), false);
      assert.throws(() => Array.prototype.pop.call(regions.output), TypeError);
      assert.equal(Reflect.set(d.command, 'text', 'forged'), false);
      assert.ok(d.command.measured.glyphCount > 0, 'opaque geometry handles remain usable');
    } else {
      assert.throws(() => Array.prototype.pop.call(d.rows), TypeError); assert.throws(() => Array.prototype.push.call(d.diagnostics, d.heading), TypeError);
      const row = d.rows.find(r => r.kind === '-')!;
      assert.equal(Reflect.set(row, 'index', -1), false); assert.equal(Reflect.set(row.oldSource!, 'byte', 42), false);
      assert.equal(Reflect.set(row.region!, 'text', 'forged'), false);
    }
  });
  checkAgain?.(); inspect(f, owner, d => { if (d.kind === 'bash') assert.deepEqual(d.service.output.slice(d.service.first, d.service.last), ['out']); else assert.equal(d.rows.length, 5); });
});

for (const noOp of [false, true]) test(`review F4: file service note follows both metadata transitions with reused source geometry, initial=${noOp}`, async () => {
  const f = fixture(), owner = {}, initial = written('const same = 1'); initial.node.result = { details: { noOp } };
  f.use(owner, initial); await settle(); const identity = f.cards.identities(owner), before = [f.env.classifications.length, f.calls.length];
  let measurement: object | undefined;
  inspect(f, owner, d => { if (d.kind !== 'file') assert.fail('file'); measurement = d.rows[0]!.region!.measured; assert.equal(d.note?.text, noOp ? 'No changes.' : undefined); });
  for (const [index, current] of [!noOp, noOp].entries()) {
    const input = { ...initial, revision: index + 2, serviceRevision: index + 2, node: { ...initial.node, result: { details: { noOp: current } } } };
    f.update(owner, input); f.cards.useful(owner, input.revision);
    inspect(f, owner, d => { if (d.kind !== 'file') assert.fail('file'); assert.equal(d.note?.text, current ? 'No changes.' : undefined); assert.equal(d.rows[0]!.region!.measured, measurement); });
    await settle(); assert.deepEqual(f.cards.identities(owner), identity); assert.deepEqual([f.env.classifications.length, f.calls.length], before);
  }
});

test('review final delta: ready native adoption releases its Pi lease and never reacquires it for native-only updates', async () => {
  const f = fixture(true), owner = {}, prepare = f.runtime.preparePiInput.bind(f.runtime);
  const leases: NonNullable<ReturnType<typeof prepare>>[] = [];
  f.runtime.preparePiInput = (...args) => { const lease = prepare(...args); if (lease) leases.push(lease); return lease; };
  await nativeReady(f, owner); assert.ok(leases.length > 0); assert.ok(leases.every(lease => !lease.isValid), 'native adoption releases every superseded Pi lease');
  const before = [f.env.acquisitions, f.env.samples, f.calls.length];
  f.update(owner, { ...bash('x\n', true), revision: 2, palette: f.piTheme('light') });
  inspect(f, owner, (_d, p) => assert.equal(p.origin, 'native')); assert.deepEqual([f.env.acquisitions, f.env.samples, f.calls.length], before);
  f.cards.remove(owner); assert.ok(leases.every(lease => !lease.isValid));
});

test('original 24: off-held Bash completion preserves native uncertainty, latest text and zero Pi until owned cleanup', async () => {
  const f = fixture(true), owner = {}; f.use(owner, bash('x')); await settle(); const key = f.cards.identities(owner)[0]!.key;
  assert.equal(f.calls.length, 1); f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged();
  f.update(owner, bash('latest\t界', true, 2)); await settle();
  assert.equal(f.sources.workStatus(key).execution, 'unsettled'); assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.equal(f.cards.identities(owner)[0]!.complete, true); assert.equal(f.cards.identities(owner)[0]!.fallback, 'neutral');
  assert.equal(command(f, owner), 'latest\t界'); inspect(f, owner, (_d, p) => { assert.equal(p.ranges(key), undefined); assert.equal(p.origin, 'pi'); });
  assert.equal(f.env.classifications.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0); assert.equal(f.calls.length, 1);
  f.sources.ownedStopped(1); await settle(); assert.equal(f.sources.workStatus(key).fallbackEligible, true);
  assert.equal(f.env.classifications.length, 0); assert.equal(f.calls.length, 1);
});

test('original 50: freeing bookkeeping capacity does not retry a refused warm revision', async () => {
  const f = fixture(false, {}, RETENTION_LIMITS.entryAllowance * 3 - 1), active = {}, refused = {};
  f.use(active, bash('active', true)); await settle(); assert.equal(f.cards.identities(active).length, 1);
  assert.equal(f.update(refused, bash('refused', true)), false); f.cards.remove(active);
  const before = [f.env.acquisitions, f.env.samples, f.calls.length];
  for (let i = 0; i < 20; i++) f.cards.useful(refused, 1); await settle();
  assert.equal(f.cards.visit(refused, () => assert.fail('warm denial cannot manufacture display')), false);
  assert.deepEqual([f.env.acquisitions, f.env.samples, f.calls.length], before);
  assert.equal(f.update(refused, bash('refused', true, 2)), true); f.cards.useful(refused, 2); await settle();
  assert.equal(command(f, refused), 'refused'); assert.equal(f.cards.identities(refused).length, 1); assert.equal(f.env.classifications.length, 0);
});

for (const count of [1, 2]) test(`original 38: asynchronous local refusal preserves the host yield with ${count} owners`, async () => {
  const f = fixture(true, { maxTransientBytes: 128 }), owners = Array.from({ length: count }, () => ({}));
  let observations = 0; const observe = f.sources.observe.bind(f.sources);
  f.sources.observe = demand => { observations++; return observe(demand); };
  const hostTurn = turn().then(() => { assert.equal(observations, count, 'initial preparation reaches the real local refusal'); assert.equal(f.env.classifications.length, 0, 'notice-driven fallback waits for the host turn'); });
  owners.forEach((owner, index) => f.use(owner, written(`refused${index}`))); await hostTurn; await settle();
  assert.deepEqual(f.env.classifications.sort(), owners.map((_owner, index) => `refused${index}`)); assert.equal(f.calls.length, 0);
  const before = [observations, f.env.classifications.length, f.env.notices.length]; for (let i = 0; i < 10; i++) await turn();
  assert.deepEqual([observations, f.env.classifications.length, f.env.notices.length], before);
});

test('review F1: canonical equal-text alias keeps native file syntax without another parse', async () => {
  const f = fixture(true), owner = {}, text = 'const unchanged = 1'; f.native();
  f.use(owner, written(text)); await settle();
  for (let round = 0; round < 8; round++) {
    const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); }
    await settle();
  }
  const key = f.cards.identities(owner)[0]!.key, calls = f.calls.length, classifications = f.env.classifications.length;
  inspect(f, owner, (_d, p) => assert.ok(p.ranges(key), 'ready native positive control'));
  f.use(owner, written(text, 2)); await settle();
  assert.equal(f.sources.displayBasis(key)?.exactVersion, f.cards.identities(owner)[0]!.version, 'the canonical display proves the new exact text alias');
  inspect(f, owner, (_d, p) => {
    let count = 0; assert.equal(p.ranges(key)!( (_start, _end) => count++), true); assert.ok(count > 0);
    assert.equal(p.basis(key, source => assert.equal(source, text)), true);
  });
  assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, classifications);
});

test('review F1: an offline generic native group cannot color a different file with historical ranges', async () => {
  const f = fixture(true), owner = {}; f.use(owner, written('const previous = 1')); await settle();
  for (let round = 0; round < 8; round++) {
    const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); }
    await settle();
  }
  const key = f.cards.identities(owner)[0]!.key, calls = f.calls.length;
  assert.ok(f.sources.displayBasis(key)?.complete, 'the original file has a native semantic display');
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'pi'); assert.ok(p.ranges(key)); });
  f.env.ready = false; f.cards.metadataChanged(); f.use(owner, written('x', 2)); await settle();
  inspect(f, owner, (d, p) => {
    if (d.kind !== 'file') assert.fail('file'); assert.equal(d.rows[0]!.region!.text, 'x');
    assert.equal(p.origin, 'pi'); assert.deepEqual(Object.keys(p.roles), CARD_ROLES);
    const read = p.ranges(key); if (read) assert.equal(read((_start, end) => assert.ok(end <= 1, 'only exact new-file Pi ranges may be used')), true);
    assert.equal(p.basis(key, () => assert.fail('the previous generic native text is not the current file')), false);
  });
  assert.equal(f.calls.length, calls);
});


test('card sources: neutral deferred slot registration preserves paint effect while ready Pi coverage changes it', async () => {
  const f = fixture(false), shell = {}, file = {};
  assert.equal(f.cards.updateDisplay(shell, bash('waiting')), true);
  let first = 0;
  inspect(f, shell, (_d, p) => { first = p.paintStamp; });
  f.cards.useful(shell, 1); await settle();
  assert.equal(f.cards.identities(shell).length, 1, 'deferred work identity remains registered');
  inspect(f, shell, (_d, p) => assert.equal(p.paintStamp, first, 'no roles or syntax colors changed'));
  assert.equal(f.cards.updateDisplay(file, written('const n=1;')), true);
  let neutral = 0;
  inspect(f, file, (_d, p) => { neutral = p.paintStamp; });
  f.cards.useful(file, 1); await settle();
  inspect(f, file, (_d, p) => assert.notEqual(p.paintStamp, neutral, 'actual ready Pi coverage must repaint'));
});


test('card sources: only newest exact Pi FILE receives first native SOURCE and compatible recovery never reparses it', async () => {
  const f = fixture(false), first = {}, newest = {};
  f.use(first, written('const older=1;')); f.use(newest, written('const newest=2;')); await settle();
  assert.equal(f.env.classifications.length, 2);
  const firstKey = f.cards.identities(first)[0]!.key, newestKey = f.cards.identities(newest)[0]!.key;
  let paint = 0;
  inspect(f, newest, (_d, p) => { paint = p.paintStamp; });
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  const calls = f.calls.filter(c => c.request.op === 'highlight');
  assert.equal(calls.length, 1); assert.ok(f.sources.borrowSource(newestKey));
  assert.equal(calls[0]!.request.sources[0].text, 'const newest=2;'); assert.equal(f.sources.borrowSource(firstKey), undefined);
  assert.equal(f.env.classifications.length, 2, 'Pi classification is retained, never replayed');
  inspect(f, newest, (_d, p) => assert.equal(p.paintStamp, paint, 'Pi remains the display while native waits'));
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) {
    if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, 'const newest=2;');
    await settle();
  }
  assert.equal(f.sources.status(newestKey)?.exact, true);
  const completed = f.calls.filter(c => c.request.op === 'highlight').length;
  f.env.ready = false; f.env.generation++; f.cards.metadataChanged(); await settle();
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.equal(f.calls.filter(c => c.request.op === 'highlight').length, completed, 'completed semantic source survives compatible recovery');
  assert.equal(f.env.classifications.length, 2);
});


for (const selection of ['native', 'Follow Pi'] as const) test(`C19 frozen cards recolor retained scopes after ${selection} selection without SOURCE or identity advance`, async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner, 'x\n');
  f.cards.freeze(owner);
  f.update(owner, bash('x\nlatest\t界', false, 2));
  const identities = f.cards.identities(owner), sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  const original = style(f, owner), beforeStyles = f.calls.filter(c => c.request.op === 'styles.resolve').length;
  if (selection === 'native') f.native('next', 'b'.repeat(64));
  else { f.env.selected = { kind: 'pi' }; f.cards.metadataChanged(); }
  f.cards.useful(owner, 2); await settle();
  assert.equal(style(f, owner), original, 'pending STYLE retains the last ready paint');
  const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done && x.c.request.op === 'styles.resolve');
  assert.ok(pending.length > 0, 'retained scopes remain eligible for the new STYLE');
  for (const { i } of pending) { f.answerStyle(i, 67); await settle(); }
  assert.notEqual(style(f, owner), original);
  inspect(f, owner, (d, p) => {
    assert.equal(p.origin, selection === 'native' ? 'native' : 'pi');
    assert.equal(d.kind, 'bash'); if (d.kind === 'bash') assert.equal(d.command.text, 'x\nlatest\t界');
    assert.equal(p.basis(identities[0]!.key, (text, ranges) => {
      assert.equal(text, 'x\n'); assert.equal(ranges((_a, b) => assert.ok(b <= 2)), true);
    }), true);
  });
  assert.deepEqual(f.cards.identities(owner), identities, 'frozen source versions are not aliases for latest display');
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
  assert.ok(f.calls.filter(c => c.request.op === 'styles.resolve').length > beforeStyles);
  assert.deepEqual(f.env.classifications, []);
  const palette = f.piTheme('light');
  if (selection === 'Follow Pi') {
    const prior = style(f, owner), calls = f.calls.length;
    f.update(owner, { ...bash('x\nlatest\t界', false, 2), revision: 3, palette }); f.cards.useful(owner, 3); await settle();
    assert.notEqual(style(f, owner), prior, 'Follow Pi bindings recolor locally'); assert.equal(f.calls.length, calls);
  }
});


for (const compatible of [true, false]) test(`C19 frozen cards provider recovery preserves parser freeze and vocabulary authority compatible=${compatible}`, async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); f.cards.freeze(owner);
  const identity = f.cards.identities(owner), sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length, original = style(f, owner);
  f.env.ready = false; f.cards.metadataChanged(); await settle(); f.env.generation++;
  if (!compatible) f.env.vocabulary = 'd'.repeat(64);
  f.env.ready = true; f.native('next', 'b'.repeat(64)); await settle();
  const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done && x.c.request.op === 'styles.resolve');
  assert.equal(pending.length, compatible ? 1 : 0, 'foreign vocabulary cannot resolve retained scope IDs');
  for (const { c, i } of pending) { assert.equal(c.request.vocabulary, 'a'.repeat(64)); f.answerStyle(i, 68); await settle(); }
  assert.equal(style(f, owner) === original, !compatible);
  assert.deepEqual(f.cards.identities(owner), identity); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
  assert.deepEqual(f.env.classifications, []);
});

for (const phase of ['early', 'pending', 'unknown'] as const) test(`C19 frozen cards ${phase} source never opens or gains fallback authority on recolor`, async () => {
  const f = fixture(phase !== 'early'), owner = {}; f.native(); f.use(owner, bash('held')); await settle();
  const key = f.cards.identities(owner)[0]!.key;
  if (phase === 'unknown') { f.fault(f.calls.findIndex(c => c.request.op === 'stream.open'), 'unknown'); await settle(); }
  f.cards.freeze(owner); const sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  const status = f.sources.workStatus(key);
  if (phase !== 'early') assert.equal(status.fallbackEligible, false);
  f.env.ready = true; f.native('next', 'b'.repeat(64)); f.update(owner, bash('held latest', true, 2)); f.cards.useful(owner, 2); await settle();
  assert.equal(command(f, owner), 'held latest'); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources);
  if (phase !== 'early') assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.deepEqual(f.env.classifications, []);
  if (phase === 'pending') {
    f.answerSource(f.calls.findIndex(c => c.request.op === 'stream.open'), 'held'); await settle();
    assert.equal(f.sources.displayBasis(key), undefined, 'late cancelled SOURCE cannot revive a frozen display');
  }
});

for (const stop of ['pause', 'remove', 'off'] as const) test(`C19 frozen cards ${stop} still stops its named work without thawing SOURCE`, async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); f.cards.freeze(owner);
  const sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  if (stop === 'pause') f.cards.pause(owner);
  else if (stop === 'remove') f.cards.remove(owner);
  else { f.env.enabled = false; f.sources.setEnabled(false); }
  const calls = f.calls.length; f.native('next', 'b'.repeat(64)); await settle(); assert.equal(f.calls.length, calls);
  if (stop === 'pause') {
    f.cards.useful(owner, 1); await settle(); const i = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); assert.ok(i >= 0);
    f.answerStyle(i, 69); await settle(); assert.ok(style(f, owner).includes('38;2;69;2;3m'));
  } else if (stop === 'off') {
    f.env.enabled = true; f.sources.setEnabled(true); f.cards.metadataChanged(); f.cards.useful(owner, 1); await settle();
    assert.equal(f.sources.displayBasis(f.cards.identities(owner)[0]!.key), undefined, 'Off discarded scopes, not source freeze');
  } else assert.equal(f.cards.visit(owner, () => assert.fail('removed card')), false);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources); assert.deepEqual(f.env.classifications, []);
});

test('C19 frozen cards first retained owner collects while a recoloring peer remains live', async () => {
  const f = fixture(true), peer = {}; let weak: WeakRef<Owner>;
  async function abandon() { const owner = {}; await nativeReady(f, owner); f.cards.freeze(owner); return new WeakRef(owner); }
  weak = await abandon(); await nativeReady(f, peer, 'peer\n'); f.cards.freeze(peer);
  f.env.invalidated.length = 0; const before = f.sources.stats().retention.retainedBytes;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await settle(); if (!weak.deref()) break; }
  assert.equal(weak.deref(), undefined); assert.ok(f.sources.stats().retention.retainedBytes < before);
  f.native('next', 'b'.repeat(64)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 70); await settle(); }
  assert.ok(style(f, peer).includes('38;2;70;2;3m')); assert.equal(command(f, peer), 'peer\n');
});


for (const stop of ['pause', 'remove', 'off'] as const) test(`C19 frozen cards pending STYLE cannot publish across ${stop}`, async () => {
  const f = fixture(true), owner = {}; await nativeReady(f, owner); f.cards.freeze(owner);
  const original = style(f, owner), sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.native('next', 'b'.repeat(64)); await settle();
  const i = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); assert.ok(i >= 0);
  assert.equal(f.sources.stats().unsettledJobs, 1);
  if (stop === 'pause') f.cards.pause(owner);
  else if (stop === 'remove') f.cards.remove(owner);
  else { f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); }
  f.answerStyle(i, 99); await settle();
  assert.equal(f.sources.stats().unsettledJobs, 0);
  if (stop === 'pause') assert.equal(style(f, owner), original);
  else if (stop === 'remove') assert.equal(f.cards.visit(owner, () => assert.fail('removed STYLE owner')), false);
  else assert.equal(f.sources.displayBasis(f.cards.identities(owner)[0]!.key), undefined);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources); assert.deepEqual(f.env.classifications, []);
});

test('renderer resume reuse: historical Follow Pi paint cannot suppress a source changed while the provider was unavailable', async () => {
  const f = fixture(true), owner = {}, a = 'echo BEFORE\n', b = 'echo AFTER\n';
  f.use(owner, bash(a, true)); await settle();
  for (let i = 0; i < f.calls.length; i++) {
    if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, a);
    await settle();
  }
  const key = f.cards.identities(owner)[0]!.key;
  assert.equal(f.sources.borrowSource(key)?.text, a);
  f.env.ready = false; f.cards.metadataChanged(); await settle();
  f.use(owner, bash(b, true, 2)); await settle();
  assert.equal(command(f, owner), b); assert.equal(f.sources.borrowSource(key)?.text, a);
  const requests = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  const sources = f.calls.filter(c => c.request.op !== 'styles.resolve');
  assert.equal(sources.length, requests + 1, 'recovery must admit the unparsed latest text despite a retained historical presentation');
  assert.equal(sources.at(-1)!.request.sources[0].text, b);
  assert.equal(f.cards.identities(owner)[0]!.key, key, 'the card keeps its source owner across recovery');
  assert.equal(f.cards.identities(owner)[0]!.version, 2);
  f.answerSource(f.calls.indexOf(sources.at(-1)!), b); await settle();
  assert.equal(f.sources.borrowSource(key)?.text, b);
  const completed = f.calls.length;
  for (let i = 0; i < 10; i++) f.cards.useful(owner, 2);
  await settle(); assert.equal(f.calls.length, completed, 'ready recovery remains a warm no-op');
  assert.deepEqual(f.env.classifications, [], 'Bash never borrows the Pi classifier');
});

test('cards bounded Pi source keeps the full write display and paints its suffix neutral', async () => {
  const f = fixture(), owner = {}, prefix = 'x'.repeat(8192), text = prefix + 'TAIL';
  f.use(owner, written(text)); await settle();
  assert.equal(f.env.classifications.length, 1); assert.equal(f.env.classifications[0]!.length, prefix.length);
  inspect(f, owner, (d, p) => {
    if (d.kind !== 'file') assert.fail('file');
    const row = d.rows[0]!, region = row.region!, key = row.nextSource!.key;
    assert.equal(region.text, text);
    let end = 0; const ranges = p.ranges(key)!;
    assert.equal(ranges((_a, b) => { end = b; }), true); assert.equal(end, 8192);
    const funding = f.sources.geometryFunding()!, layout = reflow(region.measured, { mode: 'file', width: 9000 }, funding.grant)!;
    const painted = paintFlat(region.text, region.measured, layout, ranges, p.roles.code, p.roles.prompt, Number.MAX_SAFE_INTEGER, funding.budget, funding.grant)!;
    try { const rows: string[] = []; painted.visitRows((_i, value) => rows.push(value));
      assert.equal(rows.map(stripVTControlCharacters).join(''), text);
      assert.ok(rows.join('').includes(p.roles.code.open + 'TAIL' + p.roles.code.close));
    } finally { painted.dispose(); layout.dispose(); }
  });
  f.use(owner, written(prefix + 'different suffix', 2)); await settle();
  assert.equal(f.env.classifications.length, 1);
  // Palette refresh must rebuild from full display, not mistake the borrowed Pi prefix for it.
  f.piTheme('light'); f.update(owner, { ...written(prefix + 'different suffix', 2), revision: 3, palette: 2 });
  f.cards.useful(owner, 3); await settle(); assert.equal(f.env.classifications.length, 2);
  assert.equal(f.env.classifications[1]!.length, prefix.length);
  f.use(owner, written('y' + prefix.slice(1) + 'different suffix', 4)); await settle();
  assert.equal(f.env.classifications.length, 3);
});

test('cards saturated Bash owns a finite native prefix while full command continues and freezes', async () => {
  const f = fixture(true), owner = {}, prefix = 'é'.repeat(32768); f.native();
  f.use(owner, bash(prefix + 'TAIL')); await settle();
  let index = f.calls.findIndex(c => c.request.op === 'highlight'); assert.ok(index >= 0);
  assert.equal(f.calls[index]!.request.sources[0].text.length, prefix.length);
  f.answerSource(index, prefix); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 77); await settle(); }
  const before = f.sources.stats(), count = f.calls.length;
  assert.equal(before.remoteLeases, 0);
  f.use(owner, bash(prefix + 'more suffix', false, 2)); await settle();
  assert.equal(command(f, owner), prefix + 'more suffix'); assert.equal(f.calls.length, count);
  assert.equal(f.sources.stats().preparedBytes, before.preparedBytes); assert.deepEqual(f.env.classifications, []);
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'native'); let end = 0;
    assert.equal(p.ranges(f.cards.identities(owner)[0]!.key)!((_a, b) => { end = b; }), true); assert.equal(end, 65536);
    assert.ok(p.roles.title.open.includes('77')); });
  f.cards.freeze(owner); f.cards.pause(owner); f.cards.useful(owner, 2); await settle(); assert.equal(f.calls.length, count);
  f.cards.remove(owner); assert.equal(f.sources.stats().sourceRecords, 0);
});

test('cards saturated file pending Off veto, bounded fallback/recovery, freeze and actual owner GC retain a live peer', async () => {
  const f = fixture(true), prefix = 'x'.repeat(65536), full = prefix + 'VISIBLE_SUFFIX', peer = {};
  async function abandon() {
    const owner = {}; f.use(owner, written(full)); await settle();
    const pending = f.calls.findIndex(c => !c.done && c.request.op === 'highlight'); assert.ok(pending >= 0);
    assert.equal(f.calls[pending]!.request.sources[0].text, prefix);
    assert.equal(f.sources.stats().globalUnsettledJobs, 1);
    f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); await settle();
    assert.equal(f.sources.stats().globalUnsettledJobs, 1, 'Off does not invent physical settlement');
    for (let i = 0; i < 3; i++) f.cards.useful(owner, 1);
    await settle(); assert.deepEqual(f.env.classifications, []);
    f.fault(pending, 'not_started'); await settle();
    assert.deepEqual(f.env.classifications, [prefix.slice(0, 8192)]);
    assert.equal(f.sources.stats().globalUnsettledJobs, 0);
    f.env.enabled = true; f.sources.setEnabled(true); f.cards.metadataChanged(); f.cards.useful(owner, 1); await settle();
    const recovery = f.calls.findIndex(c => !c.done && c.request.op === 'highlight'); assert.ok(recovery >= 0);
    assert.equal(f.calls[recovery]!.request.sources[0].text, prefix);
    f.answerSource(recovery, prefix); await settle();
    for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i); await settle(); }
    const key = f.cards.identities(owner)[0]!.key;
    assert.equal(f.sources.borrowSource(key)?.text, prefix); assert.equal(f.sources.status(key)?.exact, true);
    inspect(f, owner, d => { assert.equal(d.kind, 'file'); if (d.kind === 'file') assert.equal(d.rows[0]!.region!.text, full); });
    return new WeakRef(owner);
  }
  const abandoned = await abandon(); f.use(peer, bash(prefix + 'PEER_SUFFIX')); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) {
    if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, prefix); await settle();
  }
  const peerKey = f.cards.identities(peer)[0]!.key;
  assert.equal(f.sources.borrowSource(peerKey)?.text, prefix);
  f.cards.freeze(peer); f.cards.pause(peer); const count = f.calls.length, encoded = f.sources.stats().preparedBytes;
  const frozenText = 'y' + prefix.slice(1) + 'FROZEN_SUFFIX';
  f.use(peer, bash(frozenText, false, 2)); await settle();
  assert.equal(command(f, peer), frozenText); assert.equal(f.calls.length, count);
  assert.equal(f.sources.stats().preparedBytes, encoded, 'frozen useful resume cannot parse even an inside-prefix correction');
  inspect(f, peer, (_d, p) => { assert.equal(p.basis(peerKey, text => assert.equal(text, prefix)), true); });
  f.env.invalidated.length = 0; const before = f.sources.stats().retention.retainedBytes;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await settle(); if (!abandoned.deref()) break; }
  assert.equal(abandoned.deref(), undefined); assert.ok(f.sources.stats().retention.retainedBytes < before);
  assert.equal(f.sources.stats().sourceRecords, 1); inspect(f, peer, () => {});
  assert.ok(f.sources.stats().retention.retainedBytes > 0, 'frozen live peer still owns retained paint');
  f.cards.remove(peer); const removed = f.sources.stats(); assert.equal(removed.sourceRecords, 0);
  assert.equal(removed.globalUnsettledJobs, 0);
  for (const field of ['snapshotBytes', 'rangeBytes', 'bridgeBytes', 'displayBytes', 'displayOnlyRangeBytes'] as const) assert.equal(removed.retention[field], 0);
  // Reusable style/context cache belongs to the still-live controller; afterEach
  // separately requires zero total retention after controller disposal.
  console.log(JSON.stringify({ saturatedLifetime: true, pendingOff: 1, nativePrefixBytes: prefix.length,
    piPrefixBytes: f.env.classifications[0]!.length, recovered: true, collected: true, peerRemoved: true }));
});
