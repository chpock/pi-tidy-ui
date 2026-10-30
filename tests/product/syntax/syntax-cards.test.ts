import '../../fixtures/test-guard.mjs';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { highlightCode } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { CardSources, type CardDisplayInput, type CardPreparation, type PreparedCard, type ReadyCardPaint } from '../../../src/syntax/cards.ts';
import { SourceController, type ControllerOptions } from '../../../src/occipital/controller.ts';
import { decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { RequestFailure } from '../../../src/occipital/request-failure.ts';
import { resolveTheme } from '../../../src/themes/selection.ts';
import { sampleOwnedPalette } from '../../../src/themes/owned-palette.ts';
import { samplePiPalette } from '../../../src/syntax/pi-palette.ts';
import { samplePiPrefix } from '../../../src/syntax/pi-bindings.ts';
import { OwnedPaletteDataError } from '../../../src/themes/owned-palette.ts';
import { THEME_CATALOGUE } from '../../../src/themes/catalogue.ts';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { PaletteInputOwner } from '../../../src/syntax/pi-input-owner.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { reflow } from '../../../src/syntax/measured-rows.ts';
import { paintFlat, type FlatRangeReader } from '../../../src/syntax/flat-paint.ts';
import { stripVTControlCharacters } from 'node:util';
import { prepareBashService } from '../../../src/bash-card.ts';
import { prepareFileCard } from '../../../src/file-card.ts';
import { RETENTION_LIMITS } from '../../../src/occipital/retention.ts';
import type { SyntaxTheme } from '../../../src/settings.ts';
import { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderTransport } from '../../../src/occipital/provider.ts';
import type { TransportEnd } from '../../../src/occipital/transport-end.ts';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
import { observePaletteInput } from '../../fixtures/palette-input-observer.mjs';

type Frame = Record<string, any>;
type Owner = { input?: CardDisplayInput };
const bash = (text: string, complete = false, revision = 1): Extract<CardDisplayInput, { kind: 'bash' }> => ({ kind: 'bash', args: { command: text }, complete,
  revision, sourceRevision: revision, serviceRevision: revision, palette: 1, mode: 'truecolor', language: 'bash' });
const written = (text: string, revision = 1, path = 'a.ts'): Extract<CardDisplayInput, { kind: 'file' }> => ({ kind: 'file', revision, sourceRevision: revision,
  serviceRevision: revision, palette: 1, mode: 'truecolor', language: 'typescript', node: { toolName: 'write', args: { path, content: text }, isPartial: false, result: {} } });
const edited = (diff = '-1 \tx\n+1 \ty\n   ...\n-9 a\n+9 b', revision = 1): Extract<CardDisplayInput, { kind: 'file' }> => ({ ...written('', revision), kind: 'file',
  node: { toolName: 'edit', args: { path: 'a.ts' }, isPartial: false, result: { details: { diff } } } });
const fixtures: { cards: CardSources<Owner>; sources: SourceController; runtime: SyntaxRuntime; paletteInputs: PaletteInputOwner; calls: { reject(error: unknown): void }[] }[] = [];
function fixture(ready = false, options: ControllerOptions = {}, maxBookkeepingBytes?: number) {
  const env = { ready, enabled: true, generation: 1, vocabulary: 'a'.repeat(64), selected: { kind: 'pi' } as SyntaxTheme,
    classifications: [] as string[], invalidated: [] as Owner[], renders: 0, acquisitions: 0, paletteInputBytes: [] as number[], deniedPaletteInputs: 0, samples: 0, denyPaletteInput: false, failClassification: false,
    poison: false, beforeClassify: undefined as (() => void) | undefined, notices: [] as { keys: string[]; groups: number[] }[],
    preparations: [] as CardPreparation[], prepared: undefined as ((owner: Owner, receipt: Extract<CardPreparation, { phase: 'prepared' }>) => void) | undefined };
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
  const paletteInputs = new PaletteInputOwner();
  let theme = getThemeByName('system')!;
  const sampled = { get colors() { return theme.colors; }, getFgAnsi(role: Parameters<typeof theme.getFgAnsi>[0]) { env.samples++; if (env.poison) throw Error('Pi poison'); return theme.getFgAnsi(role); },
    getBgAnsi(role: Parameters<typeof theme.getBgAnsi>[0]) { env.samples++; if (env.poison) throw Error('Pi poison'); return theme.getBgAnsi(role); } };
  runtime.palette(sampled);
  let paletteRevision = paletteInputs.palette(sampled, resolveTheme(env.selected).effective);
  const owners = new Set<WeakRef<Owner>>();
  const trackOwner = (owner: Owner) => {
    for (const reference of owners) if (reference.deref() === owner) return;
    owners.add(new WeakRef(owner));
  };
  cards = new CardSources({ sources, snapshot: () => ({ enabled: env.enabled, provider: provider.snapshot(), selected: env.selected,
    effective: resolveTheme(env.selected).effective, standaloneVersion: 'test' }) }, {
    preparePaletteInput: (palette, revision, mode, funding, usePiFallback) => {
      env.acquisitions++; if (env.denyPaletteInput) { env.deniedPaletteInputs++; return undefined; }
      const lease = paletteInputs.prepare(sampled, palette, revision, mode, funding, usePiFallback);
      if (lease) env.paletteInputBytes.push(lease.allocationBytes);
      return lease;
    },
    classify: text => { env.classifications.push(text); env.beforeClassify?.(); if (env.failClassification) throw Error('classification failed'); return highlightCode(text, 'typescript'); },
    invalidate: owner => env.invalidated.push(owner), requestRender: () => { env.renders++; },
    preparation: (owner, receipt) => { env.preparations.push(receipt); if (receipt.phase === 'prepared') env.prepared?.(owner, receipt); } }, { maxBookkeepingBytes });
  const f = { env, calls, sources, cards, runtime, paletteInputs, sampled, update(owner: Owner, input: CardDisplayInput) { trackOwner(owner); const current = { ...input, palette: paletteRevision }; owner.input = current; return cards.updateDisplay(owner, current); },
    forget(owner: Owner) { for (const reference of owners) if (reference.deref() === owner) owners.delete(reference); },
    use(owner: Owner, input: CardDisplayInput) { assert.equal(this.update(owner, input), true); cards.useful(owner, input.revision); },
    answerSource(i: number, text: string, context = 1, revision = 1, from = 0) {
      const call = calls[i]!, q = call.request, s = q.sources?.[0] ?? q, bytes = Buffer.byteLength(text), complete = q.op === 'highlight' || !!q.final;
      call.done = true; call.resolve({ v: 4, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'source', vocabulary: description.vocabulary.fingerprint,
        sources: [{ key: s.key, generation: s.generation, source_version: s.source_version, revision, source_bytes: bytes, replace_from: from,
          committed_bytes: complete ? bytes : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)), complete,
          ...(!complete || q.op === 'stream.append' ? { lease: q.lease ?? 'lease:1' } : {}), contexts: bytes === from ? [] : [[0, context]], runs: bytes === from ? [] : [bytes - from, 1],
          counters: { committed_line_calls: 1, committed_line_bytes: bytes, tail_calls: 0, tail_bytes: 0 } }] } });
    },
    answerStyle(i: number, color = 11, bad = false) {
      const call = calls[i]!, q = call.request;
      call.done = true; call.resolve({ v: 4, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'styles', vocabulary: q.vocabulary,
        rules: bad ? 'f'.repeat(64) : fingerprintRules(q.rules),
        styles: q.contexts.map(() => ({ foreground: { kind: 'rgb', r: color, g: 2, b: 3 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 })),
        indices: q.contexts.map(() => 1) } });
    },
    fault(i: number, execution: 'not_started' | 'unknown' = 'not_started') { calls[i]!.done = true; calls[i]!.reject(new RequestFailure('busy', execution)); },
    piTheme(name: string) { theme = getThemeByName(name)!; runtime.palette(sampled); paletteRevision = paletteInputs.palette(sampled, resolveTheme(env.selected).effective); cards.metadataChanged(paletteRevision); return paletteRevision; },
    followPi() { env.selected = { kind: 'pi' }; paletteRevision = paletteInputs.palette(sampled, resolveTheme(env.selected).effective); cards.metadataChanged(paletteRevision); return paletteRevision; },
    theme(id = 'gruvbox-dark') {
      env.selected = { kind: 'theme', id };
      paletteRevision = paletteInputs.palette(sampled, resolveTheme(env.selected).effective); cards.metadataChanged(paletteRevision);
    },

  };
  fixtures.push(f); return f;
}
async function settle() { for (let i = 0; i < 8; i++) await turn(); }
afterEach(async () => { for (const f of fixtures) { f.cards.dispose(); f.sources.dispose(); f.paletteInputs.dispose(); await f.runtime.dispose(); for (const c of f.calls) c.reject(new RequestFailure('cleanup', 'not_started')); }
  await settle(); for (const f of fixtures) { assert.equal(f.sources.stats().globalUnsettledJobs, 0); assert.equal(f.sources.stats().retention.retainedBytes, 0); } fixtures.length = 0; });
function inspect(f: ReturnType<typeof fixture>, owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void) { assert.equal(f.cards.visit(owner, consume), true); }
function command(f: ReturnType<typeof fixture>, owner: Owner) { let text: string | undefined; inspect(f, owner, d => { assert.equal(d.kind, 'bash'); if (d.kind === 'bash') text = d.command.text; }); return text; }
function style(f: ReturnType<typeof fixture>, owner: Owner) { let color = ''; inspect(f, owner, (_d, p) => { color = p.roles.code.open; }); return color; }
async function themeReady(f: ReturnType<typeof fixture>, owner: Owner, text = 'x\n') {
  f.theme(); f.use(owner, bash(text, true)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) { if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, text); await settle(); }
}

test('cards prepared display exists before useful work', async () => {
  const f = fixture(), owner = {};
  assert.equal(f.update(owner, bash('a\t界\r\nb')), true);
  inspect(f, owner, (d, p) => { assert.equal(d.kind, 'bash'); if (d.kind === 'bash') { assert.equal(d.command.text, 'a\t界\nb'); assert.ok(d.command.measured.glyphCount); }
    assert.deepEqual(Object.keys(p.roles), CARD_ROLES); assert.equal(p.origin, 'pi'); });
  await settle(); assert.equal(f.calls.length, 0); assert.deepEqual(f.env.classifications, []); assert.equal(f.sources.stats().captures, 0);
});

test('cards keep selected owned colors fixed across public Pi theme changes', async () => {
  const f = fixture(false), owner: Owner = {}; f.theme('gruvbox-dark'); f.use(owner, written('const value = 1;')); await settle();
  const expected = style(f, owner), acquisitions = f.env.acquisitions, samples = f.env.samples;
  const classifications = [...f.env.classifications], calls = f.calls.length;
  f.piTheme('light'); await settle();
  inspect(f, owner, (_display, paint) => { assert.equal(paint.origin, 'owned'); assert.equal(paint.roles.code.open, expected); });
  assert.equal(f.env.acquisitions, acquisitions); assert.equal(f.env.samples, samples);
  assert.deepEqual(f.env.classifications, classifications); assert.equal(f.calls.length, calls);
});

test('cards show the selected owned palette for a neutral FILE while Native is Off and no helper is ready', async () => {
  const f = fixture(false), owner = {}; f.env.enabled = false; f.sources.setEnabled(false); f.theme('gruvbox-dark');
  f.use(owner, written('const value = 1;')); await settle();
  inspect(f, owner, (display, paint) => {
    assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'owned');
    assert.equal(paint.roles.code.open, sampleOwnedPalette('gruvbox-dark', 'truecolor').compiledRoles.code.open);
    assert.equal(paint.ranges(f.cards.identities(owner)[0]!.key), undefined, 'no semantic source proof is fabricated');
  });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.env.classifications, []); assert.equal(f.sources.stats().dispatches, 0);
});

test('cards retain a complete owned-neutral paint when a selected catalogue asset is corrupt', async () => {
  const f = fixture(false), owner = {}; f.theme('gruvbox-dark'); f.use(owner, written('const value = 1;')); await settle();
  inspect(f, owner, (_display, paint) => assert.equal(paint.origin, 'owned', 'precondition: the prior complete paint uses a valid owned palette'));
  const source = f.cards.identities(owner)![0]!, oldColor = style(f, owner), target = fileURLToPath(new URL('../../../src/themes/palettes/gruvbox-light.json', import.meta.url));
  const directory = fs.mkdtempSync(join(tmpdir(), 'toolview-card-palette-')), corrupt = join(directory, 'replacement.json');
  fs.writeFileSync(corrupt, '{');
  const originalOpen = fs.openSync; let opens = 0;
  const intercepted = ((file: string | URL, flags: string | number, mode?: number) => {
    if (String(file) === target) { opens++; return originalOpen(corrupt, flags, mode); }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync;
  Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: intercepted }); syncBuiltinESMExports();
  try {
    f.theme('gruvbox-light'); await settle();
    assert.equal(opens, 1, 'the known catalogue asset reached its file read and failed validation');
    inspect(f, owner, (display, paint) => {
      assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'owned');
      assert.equal(paint.roles.code.open, oldColor, 'the last complete owned-neutral presentation remains visible');
       assert.equal(paint.ranges(f.cards.identities(owner)[0]!.key), undefined, 'no stale or fabricated semantic group is published');
       assert.equal(f.cards.identities(owner)![0]!.key, source.key);
       assert.equal(f.cards.identities(owner)![0]!.version, source.version, 'asset failure retains the exact SOURCE version');
    });
    assert.deepEqual(f.env.classifications, [], 'retaining owned colors does not invoke Pi classification');
  } finally {
    Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen }); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  f.theme('dracula-dark'); await settle();
  inspect(f, owner, (_display, paint) => {
    assert.equal(paint.origin, 'owned'); assert.equal(paint.roles.code.open, sampleOwnedPalette('dracula-dark', 'truecolor').compiledRoles.code.open);
  });
});

test('cards use current Pi colors only when a failed owned palette has no prior complete paint', async () => {
  const f = fixture(false), owner: Owner = {}, target = fileURLToPath(new URL('../../../src/themes/palettes/gruvbox-light.json', import.meta.url));
  const directory = fs.mkdtempSync(join(tmpdir(), 'toolview-card-palette-')), corrupt = join(directory, 'replacement.json'); fs.writeFileSync(corrupt, '{');
  const originalOpen = fs.openSync; let opens = 0;
  const intercepted = ((file: string | URL, flags: string | number, mode?: number) => {
    if (String(file) === target) { opens++; return originalOpen(corrupt, flags, mode); }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync;
  Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: intercepted }); syncBuiltinESMExports();
  try {
    f.theme('gruvbox-light'); f.use(owner, written('const value = 1;')); await settle();
    assert.equal(opens, 1); assert.deepEqual(f.env.classifications, ['const value = 1;']);
    inspect(f, owner, (_display, paint) => assert.equal(paint.origin, 'pi'));
    const [source] = f.cards.identities(owner)!;
    assert.equal(f.env.classifications.length, 1);
    f.piTheme('light'); await settle(); assert.equal(opens, 1, 'a public Pi theme change does not reread the known failed asset');
    assert.equal(f.cards.identities(owner)![0]!.key, source!.key, 'Pi input refresh retains the same logical SOURCE key');
    assert.equal(f.cards.identities(owner)![0]!.version, source!.version, 'Pi input refresh retains the same logical SOURCE version');
    assert.deepEqual(f.env.classifications, ['const value = 1;', 'const value = 1;'], 'the unchanged source is classified once for each distinct fallback palette');
    assert.equal(f.calls.length, 0, 'with no ready semantic group, fallback recoloring stays local and does not call Occipital');
    const expected = compileStyleAnsi(samplePiPalette(f.sampled, 'truecolor').roles.code, 'truecolor').open;
    inspect(f, owner, (_display, paint) => {
      assert.equal(paint.origin, 'pi'); assert.equal(paint.roles.code.open, expected);
      assert.ok(paint.ranges(f.cards.identities(owner)![0]!.key), 'the local Pi fallback exposes its current source projection without an Occipital group');
    });
    const warmSamples = f.env.samples, classifications = [...f.env.classifications];
    for (let i = 0; i < 20; i++) f.cards.useful(owner, owner.input!.revision);
    await settle(); assert.equal(f.env.samples, warmSamples); assert.deepEqual(f.env.classifications, classifications); assert.equal(opens, 1);
  } finally {
    Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen }); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cards retain a funded no-group palette while a known replacement asset is corrupt, then recover', async () => {
  const f = fixture(false), owner: Owner = {}, target = fileURLToPath(new URL('../../../src/themes/palettes/gruvbox-light.json', import.meta.url));
  f.theme('catppuccin-dark'); f.use(owner, written('const value = 1;')); await settle();
  const previous = style(f, owner), sourceRevision = owner.input!.sourceRevision, sourceVersion = f.cards.identities(owner)[0]!.version;
  inspect(f, owner, (_display, paint) => { assert.equal(paint.origin, 'owned'); assert.equal(paint.ranges(f.cards.identities(owner)![0]!.key), undefined); });
  const directory = fs.mkdtempSync(join(tmpdir(), 'toolview-card-palette-')), corrupt = join(directory, 'replacement.json'); fs.writeFileSync(corrupt, '{');
  const originalOpen = fs.openSync; let opens = 0;
  const intercepted = ((file: string | URL, flags: string | number, mode?: number) => {
    if (String(file) === target) { opens++; return originalOpen(corrupt, flags, mode); }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync;
  Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: intercepted }); syncBuiltinESMExports();
  try {
    f.theme('gruvbox-light'); await settle();
    assert.equal(opens, 1, 'one known-catalogue replacement read fails');
    assert.equal(style(f, owner), previous, 'the last complete owned neutral paint remains visible');
    assert.equal(owner.input!.sourceRevision, sourceRevision); assert.equal(f.cards.identities(owner)[0]!.version, sourceVersion);
    inspect(f, owner, (_display, paint) => { assert.equal(paint.origin, 'owned'); assert.equal(paint.ranges(f.cards.identities(owner)![0]!.key), undefined); });
    const attempts = f.env.acquisitions;
    for (let i = 0; i < 20; i++) f.cards.useful(owner, owner.input!.revision);
    await settle(); assert.equal(f.env.acquisitions, attempts, 'a memoized failed palette is not retried on warm visits');
    assert.equal(opens, 1);
    f.theme('catppuccin-light'); await settle();
    assert.equal(style(f, owner), sampleOwnedPalette('catppuccin-light', 'truecolor').compiledRoles.code.open);
  } finally {
    Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen }); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  f.theme('gruvbox-light'); await settle();
  assert.equal(opens, 1);
  assert.equal(style(f, owner), sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open, 'a later explicit selection can recover the known asset');
  assert.equal(owner.input!.sourceRevision, sourceRevision); assert.equal(f.cards.identities(owner)[0]!.version, sourceVersion);
});

test('cards never seeds Follow Pi projections from a retained owned lease when Pi input replacement is denied', async () => {
  const f = fixture(false), owner: Owner = {}; f.theme('gruvbox-dark'); f.use(owner, written('const value = 1;')); await settle();
  const ownedColor = style(f, owner), classifications = [...f.env.classifications], acquisitions = f.env.acquisitions;
  const sourceRevision = owner.input!.sourceRevision, sourceVersion = f.cards.identities(owner)[0]!.version;
  const denials = f.env.deniedPaletteInputs;
  f.env.denyPaletteInput = true; f.followPi(); await settle();
  assert.equal(f.env.acquisitions, acquisitions + 1, 'Follow Pi input acquisition was attempted');
  assert.equal(f.env.deniedPaletteInputs, denials + 1, 'the matching Pi input lease was actually denied');
  const deniedRevisionAcquisitions = f.env.acquisitions;
  for (let i = 0; i < 20; i++) f.cards.useful(owner, owner.input!.revision);
  await settle(); assert.equal(f.env.acquisitions, deniedRevisionAcquisitions, 'denied input is not retried on warm visits');
  inspect(f, owner, (_display, paint) => { assert.equal(paint.origin, 'owned'); assert.equal(paint.roles.code.open, ownedColor); });
  assert.deepEqual(f.env.classifications, classifications, 'no Pi projection is created without a matching Pi neutral input');
  f.piTheme('dark'); await settle();
  inspect(f, owner, (_display, paint) => { assert.equal(paint.origin, 'owned'); assert.equal(paint.roles.code.open, ownedColor); });
  assert.deepEqual(f.env.classifications, classifications, 'Pi theme changes cannot reuse a fallback lease from another public color object');
  f.env.denyPaletteInput = false; f.use(owner, { ...owner.input!, revision: owner.input!.revision + 1, sourceRevision }); await settle();
  assert.equal(owner.input!.sourceRevision, sourceRevision, 'retry uses the exact original source version');
  assert.equal(f.cards.identities(owner)[0]!.version, sourceVersion, 'palette recovery does not create a new SOURCE generation');
  assert.deepEqual(f.env.classifications, ['const value = 1;']);
  const foreground = samplePiPrefix(f.sampled.getFgAnsi('toolOutput'));
  const background = samplePiPrefix(f.sampled.getBgAnsi('toolPendingBg'), 'background');
  const expected = compileStyleAnsi({ foreground: foreground.ink, background: background.ink, attributes: foreground.attributes }, 'truecolor');
  let key = '', plainToken: unknown;
  inspect(f, owner, (_display, paint) => {
    assert.equal(paint.origin, 'pi'); assert.equal(paint.roles.code.open, expected.open);
    key = f.cards.identities(owner)[0]!.key;
    assert.equal(paint.ranges(key)!((start, end, token) => { if (start <= 5 && end > 5) plainToken = token; }), true);
  });
  assert.ok(key); assert.deepEqual(plainToken, expected, 'the post-recovery unstyled token uses public Pi default FG/BG/attributes');
});

test('cards keep a valid owned palette for a no-group Native Off card across public Pi theme changes', async () => {
  const f = fixture(false), owner: Owner = {};
  f.theme('gruvbox-dark'); f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged();
  f.use(owner, written('const value = 1;')); await settle();
  const expected = sampleOwnedPalette('gruvbox-dark', 'truecolor').compiledRoles.code.open;
  assert.equal(style(f, owner), expected);
  inspect(f, owner, (display, paint) => {
    assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'owned');
    assert.equal(paint.ranges(f.cards.identities(owner)[0]!.key), undefined, 'Native Off does not invent a semantic group');
  });
  const before = [f.env.acquisitions, f.env.samples, f.env.classifications.length, f.calls.length];
  f.piTheme('light'); await settle(); f.cards.useful(owner, owner.input!.revision); await settle();
  assert.equal(style(f, owner), expected, 'a valid owned palette is independent of public Pi theme changes');
  assert.deepEqual([f.env.acquisitions, f.env.samples, f.env.classifications.length, f.calls.length], before);
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

test('cards owned palette and mixed semantic segments publish atomically without Pi syntax poisoning', async () => {
  const f = fixture(true), owner = {}; f.theme(); f.use(owner, edited()); await settle();
  assert.equal(f.env.classifications.length, 0);
  for (let step = 0; step < 12; step++) {
    let answered = false;
    for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) { const q = f.calls[i]!.request;
      if (q.op === 'styles.resolve') f.answerStyle(i, 77);
      else { f.answerSource(i, q.sources[0].text); }
      answered = true; await settle();
    }
    if (!answered) break;
  }
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'owned'); for (const role of CARD_ROLES) assert.ok(p.roles[role].open.length > 0);
    for (const identity of f.cards.identities(owner)) { let count = 0; assert.equal(p.ranges(identity.key)!((_a, _b, s) => { count++; assert.ok(s.open.includes('77')); }), true); assert.ok(count); } });
  assert.equal(f.env.classifications.length, 0); f.env.poison = true;
  const samples = f.env.samples; f.update(owner, { ...edited(), revision: 2, palette: 2 }); inspect(f, owner, () => {}); assert.equal(f.env.samples, samples);
});

test('cards actual palette-only group notice is targeted and does not fake an empty source', async () => {
  const f = fixture(true), owner = {}, untouched = {}; f.theme(); f.update(owner, { ...written(''), node: { toolName: 'edit', args: { path: 'a' }, isPartial: false, result: {} } });
  f.update(untouched, bash('not useful')); f.cards.useful(owner, 1); await settle();
  assert.deepEqual(f.calls, [], 'an empty file has neither SOURCE text nor semantic contexts to resolve');
  f.env.invalidated.length = 0; await settle();
  assert.deepEqual(f.env.invalidated, []);
  assert.equal(f.sources.stats().sourceRecords, 0); inspect(f, owner, (_d, p) => assert.equal(p.origin, 'owned'));
});

test('cards provider metadata refresh preserves locally owned palette and ready geometry', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const before = f.cards.displayStamp(owner), count = f.calls.length;
  let measured: object | undefined; inspect(f, owner, d => { if (d.kind === 'bash') measured = d.command.measured; });
  f.env.invalidated.length = 0; f.env.generation++; f.cards.metadataChanged(); await settle();
  inspect(f, owner, d => { if (d.kind === 'bash') assert.equal(d.command.measured, measured); });
  assert.equal(f.cards.displayStamp(owner), before); assert.equal(f.calls.length, count); assert.deepEqual(f.env.invalidated, []);
});

test('cards owned palette replacement reuses ready semantic styles without replaying SOURCE', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const key = f.cards.identities(owner)[0]!,
    sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length, styleCalls = f.calls.filter(c => c.request.op === 'styles.resolve').length,
    original = style(f, owner);
  inspect(f, owner, (_d, p) => assert.ok(p.ranges(key.key), 'prior source styles are ready'));
  f.theme('monokai-dark'); await settle();
  inspect(f, owner, (_d, p) => { assert.notEqual(p.roles.code.open, original, 'owned card roles switch to the selected local palette'); assert.ok(p.ranges(key.key)); });
  assert.equal(f.calls.filter(c => c.request.op === 'styles.resolve').length, styleCalls, 'palette rebinding reuses cached semantic styles');
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls, 'palette changes never reparse SOURCE');
  assert.equal(f.env.classifications.length, 0);
});

test('cards live frozen Bash accepts latest prepared display without reopening work', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); f.cards.freeze(owner); const count = f.calls.length;
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

for (const kind of ['bash', 'file'] as const) test(`cards online wait: ready scan skips removed frozen unrequested and paused ${kind} owners`, async () => {
  const f = fixture(), live = {}, removed = {}, frozen = {}, paused = {}, unrequested = {};
  const input = (text: string) => kind === 'bash' ? bash(text, true) : written(text);
  for (const [owner, name] of [[live, 'live'], [removed, 'removed'], [frozen, 'frozen'], [paused, 'paused']] as const) f.use(owner, input(name));
  f.update(unrequested, input('unrequested')); await settle(); f.cards.remove(removed); f.cards.freeze(frozen); f.cards.pause(paused);
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
  const f = fixture(true), owner = {}; f.theme(); f.update(owner, bash('cold', true)); await settle();
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
  const f = fixture(true), owner = {}; f.theme(); f.use(owner, bash('old', true)); await settle();
  const first = f.calls.findIndex(c => c.request.op === 'highlight'); f.update(owner, bash('new', true, 2)); f.cards.useful(owner, 2); await settle();
  f.answerSource(first, 'old'); await settle(); assert.equal(command(f, owner), 'new');
  f.cards.remove(owner); f.env.invalidated.length = 0;
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) f.fault(i);
  await settle(); assert.deepEqual(f.env.invalidated, []); assert.deepEqual(f.cards.identities(owner), []);
});

test('cards Bash retains validated native prefix while latest display append is held without Pi fallback', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner, 'x\n'); const before = f.calls.length;
  f.update(owner, bash('x\nnew界', false, 2));
  let basis = '', colored = 0;
  inspect(f, owner, (d, p) => { assert.equal(d.kind, 'bash'); assert.equal(p.origin, 'owned');
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

test('cards ready static Bash and FILE fallback do not reparse on provider recovery', async () => {
  const f = fixture(true), a = {}; await themeReady(f, a); const sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.env.ready = false; f.env.generation++; f.cards.metadataChanged(); await settle(); f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
});

test('cards 100 owned-palette choices publish locally without helper work or historical store accumulation', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const initialCalls = f.calls.length;
  const baselineStats = f.sources.stats().retention, baselineRetainedBytes = baselineStats.retainedBytes;
  assert.equal(f.env.paletteInputBytes.length, 1, 'the starting presentation owns one palette-input lease');
  const initialPaletteInputBytes = f.env.paletteInputBytes[0]!;
  const nonPaletteBaselineBytes = baselineRetainedBytes - initialPaletteInputBytes, baselineEntries = baselineStats.entries;
  const selectionIdentity = (id: string) => { const palette = resolveTheme({ kind: 'theme', id }).effective;
    return `theme:${palette.id}:${palette.fingerprint}:truecolor`; };
  const initialSelection = selectionIdentity('gruvbox-dark');
  let maxPaletteInputBytes = initialPaletteInputBytes, peakSettledBytes = baselineRetainedBytes;
  assert.ok(nonPaletteBaselineBytes >= 0 && maxPaletteInputBytes > 0, 'the live owner holds exactly one selected palette input');
  let selected = 'gruvbox-dark';
  for (let i = 2; i <= 101; i++) {
    selected = THEME_CATALOGUE[(i - 2) % THEME_CATALOGUE.length]!.id; f.theme(selected); await settle();
    const stats = f.sources.stats(); assert.equal(stats.unsettledJobs, 0);
    assert.equal(stats.retention.entries, baselineEntries, 'replacing one selection does not accumulate historical semantic entries');
    maxPaletteInputBytes = Math.max(maxPaletteInputBytes, ...f.env.paletteInputBytes);
    peakSettledBytes = Math.max(peakSettledBytes, stats.retention.retainedBytes);
    const currentPaletteInputBytes = f.env.paletteInputBytes.at(-1)!;
    const selection = selectionIdentity(selected), identityDelta = selection.length - initialSelection.length;
    const selectionBytesDelta = 2 * identityDelta, displayIdentityBytesDelta = 2 * baselineEntries * identityDelta;
    const allowedBytes = nonPaletteBaselineBytes + currentPaletteInputBytes + selectionBytesDelta + displayIdentityBytesDelta;
    assert.ok(stats.retention.retainedBytes <= allowedBytes,
      `settled palette ${i - 1}: retained=${stats.retention.retainedBytes}, allowed=${allowedBytes}, input=${currentPaletteInputBytes}, selectionDelta=${selectionBytesDelta}, displayDelta=${displayIdentityBytesDelta}`);
  }
  assert.equal(style(f, owner), sampleOwnedPalette(selected, 'truecolor').compiledRoles.code.open);
  assert.equal(f.calls.length, initialCalls, 'local palette changes do not use the helper');
  console.log(JSON.stringify({ ownedPaletteChurn: { choices: 100, liveOwners: 1, nonPaletteBaselineBytes,
    peakSettledBytes, initialPaletteInputBytes, maxPaletteInputBytes } }));
});

test('cards warm owned-palette reads reuse one selected asset and render without further preparation', async () => {
  const f = fixture(true), first = {}, second = {}, observed = observePaletteInput('gruvbox-dark');
  try {
    await themeReady(f, first);
    inspect(f, first, (_display, paint) => assert.equal(paint.origin, 'owned'));
    const cold = observed.snapshot();
    assert.equal(cold.opens, 1); assert.ok(cold.reads > 0); assert.equal(cold.ownerLookups, 1);

    f.use(second, bash('second owner\n', true)); await settle();
    for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) {
      if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i);
      else f.answerSource(i, f.calls[i]!.request.sources?.[0]?.text ?? 'second owner\n');
      await settle();
    }
    inspect(f, second, (_display, paint) => assert.equal(paint.origin, 'owned'));
    const shared = observed.snapshot();
    assert.equal(shared.opens, cold.opens); assert.equal(shared.reads, cold.reads);
    assert.equal(shared.ownerLookups, cold.ownerLookups + 1, 'the second live owner acquires the same cached palette store');
    assert.equal(f.sources.stats().unsettledJobs, 0);

    const ownerLookups = shared.ownerLookups, acquisitions = f.env.acquisitions, calls = f.calls.length;
    const dispatches = f.sources.stats().dispatches, paletteInputBytes = [...f.env.paletteInputBytes];
    const preparations = [...f.env.preparations], unsettled = f.sources.stats().unsettledJobs;
    const renderOwnedCard = (owner: Owner) => { inspect(f, owner, () => {}); f.cards.useful(owner, owner.input!.revision); };
    for (let i = 0; i < 20; i++) { renderOwnedCard(first); renderOwnedCard(second); }
    await settle();
    assert.deepEqual(observed.snapshot(), shared, 'warm visit/useful renders do not reopen, reread or prepare the owned asset');
    assert.equal(observed.snapshot().ownerLookups, ownerLookups);
    assert.equal(f.env.acquisitions, acquisitions); assert.deepEqual(f.env.paletteInputBytes, paletteInputBytes);
    assert.equal(f.calls.length, calls); assert.equal(f.sources.stats().dispatches, dispatches);
    assert.deepEqual(f.env.preparations, preparations, 'warm renders do not add card-preparation receipts');
    assert.equal(f.sources.stats().unsettledJobs, unsettled);
  } finally { observed.restore(); }
});

test('cards local palette selection does not create preview requests or replay SOURCE', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const before = f.calls.length, identity = f.cards.identities(owner)[0]!;
  f.theme('monokai-dark'); await settle();
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'owned'); assert.equal(p.roles.code.open, sampleOwnedPalette('monokai-dark', 'truecolor').compiledRoles.code.open); });
  assert.equal(f.calls.length, before); const next = f.cards.identities(owner)[0]!;
  assert.deepEqual({ key: next.key, version: next.version, language: next.language, complete: next.complete },
    { key: identity.key, version: identity.version, language: identity.language, complete: identity.complete });
  assert.notEqual(next.palette, identity.palette, 'palette selection advances only local presentation identity');
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
  const f = fixture(true), a = {}, b = {}; f.theme(); f.use(a, bash('a', true)); f.use(b, bash('b', true)); await settle();
  const bCall = f.calls.findIndex(c => c.request.sources?.[0]?.text === 'b'); f.answerSource(bCall, 'b'); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 33); await settle(); }
  inspect(f, b, (_d, p) => assert.equal(p.origin, 'owned')); assert.ok(f.calls.some(c => !c.done && c.request.sources?.[0]?.text === 'a'));
});

test('cards reentrant pause preserves exact Pi fallback evidence without a duplicate classifier', async () => {
  const f = fixture(), owner = {}; f.env.beforeClassify = () => { f.env.beforeClassify = undefined; f.cards.pause(owner); };
  f.use(owner, written('x')); await settle(); f.cards.useful(owner, 1); await settle(); assert.deepEqual(f.env.classifications, ['x']);
});

test('cards explicit Pi language changes retain key identity but update the classifier demand', async () => {
  const f = fixture(), owner = {}; f.use(owner, written('x')); await settle(); const key = f.cards.identities(owner)[0]!.key;
  const input = written('y', 2, 'next.rb'); input.language = 'python'; f.use(owner, input); await settle();
  assert.equal(f.cards.identities(owner)[0]!.key, key); assert.equal(f.cards.identities(owner)[0]!.language, undefined);
  assert.equal(f.cards.identities(owner)[0]!.piLanguage, 'python'); assert.deepEqual(f.env.classifications, ['x', 'y']);
});

test('cards send a shebang-selected Occipital language without replacing path-derived Pi classification', async () => {
  const f = fixture(true), owner = {}; f.theme();
  const input = written('#!/usr/bin/env python3\necho "same"', 1, 'script.rb'); input.language = 'ruby'; f.use(owner, input); await settle();
  const call = f.calls.find(entry => entry.request.sources?.[0]?.text.includes('echo "same"'));
  assert.ok(call, 'native SOURCE is admitted for the numbered file source');
  assert.equal(call.request.sources[0].hint.language, 'python');
  assert.equal(call.request.sources[0].hint.path, 'script.rb');
  assert.equal(f.cards.identities(owner)[0]!.piLanguage, 'ruby', 'the path-derived Pi classifier remains independent');
  assert.deepEqual(f.env.classifications, [], 'a ready native palette does not run the Pi classifier');
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
  const f = fixture(true), owners = [{}, {}, {}]; f.theme();
  owners.forEach((o, i) => f.use(o, kind === 'bash' ? bash(`x${i}`, true) : written(`x${i}`))); await settle();
  for (let round = 0; round < 20; round++) { const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, c.request.sources[0].text); } await settle(); }
  const before = f.calls.filter(c => c.request.op !== 'styles.resolve').length; f.env.invalidated.length = 0;
  f.theme('gruvbox-light'); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done && f.calls[i]!.request.op === 'styles.resolve') { f.answerStyle(i, 44); await settle(); }
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, before);
  for (const o of owners) assert.ok(style(f, o).includes('44'));
});

test('cards owned palette change then Follow Pi replaces roles locally without SOURCE replay', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length, before = f.calls.length;
  f.theme('gruvbox-light'); await settle(); const owned = style(f, owner);
  f.env.selected = { kind: 'pi' }; f.piTheme('system'); await settle();
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'pi'); assert.notEqual(p.roles.code.open, owned); });
  assert.equal(f.calls.length, before); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources);
});

test('cards helper loss preserves the selected owned palette and cached source without Pi classification', async () => {
  const f = fixture(true), owner = {}; f.theme(); f.use(owner, written('x')); await settle();
  for (let round = 0; round < 10; round++) { const pending = f.calls.map((c, i) => ({ c, i })).filter(x => !x.c.done); if (!pending.length) break;
    for (const { c, i } of pending) { if (c.request.op === 'styles.resolve') f.answerStyle(i, 55); else f.answerSource(i, c.request.sources[0].text); } await settle(); }
  const before = style(f, owner); f.env.ready = false; f.theme('gruvbox-light'); await settle();
  assert.notEqual(style(f, owner), before, 'local palette selection remains effective without the helper');
  assert.equal(f.env.classifications.length, 0);
});


test('cards unsupported partial malformed and error files are source-less rather than fake empty parsers', async () => {
  const f = fixture(true); f.theme();
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
  const f = fixture(), owner = {}, original = f.paletteInputs.prepare.bind(f.paletteInputs);
  f.paletteInputs.prepare = (...args) => { const lease = original(...args); f.cards.remove(owner); return lease; };
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


test('cards denied replacement palette input retains the prior complete paint until funding recovers', async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); const before = style(f, owner), key = f.cards.identities(owner)[0]!.key;
  const funding = f.sources.geometryFunding.bind(f.sources), stamp = f.cards.displayStamp(owner);
  f.sources.geometryFunding = group => { const original = funding(group); return original && { budget: original.budget, grant: bytes => bytes > 4096 ? undefined : original.grant(bytes) }; };
  f.theme('gruvbox-light'); await settle();
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'owned'); assert.equal(p.roles.code.open, before); assert.ok(p.ranges(key), 'old semantic ranges stay paired with the retained palette'); });
  assert.equal(f.cards.displayStamp(owner), stamp); assert.equal(f.env.classifications.length, 0);
  f.sources.geometryFunding = funding; f.update(owner, { ...bash('x\n', true), revision: 3 }); f.cards.useful(owner, 3); await settle();
  inspect(f, owner, (_d, p) => assert.equal(p.roles.code.open, sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open));
});

for (const native of [false, true]) test(`review F1: changed file never borrows previous ranges before preparation, ownedPalette=${native}`, async () => {
  const f = fixture(native), owner = {}; if (native) f.theme();
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
    assert.equal(p.origin, native ? 'owned' : 'pi'); assert.deepEqual(Object.keys(p.roles), CARD_ROLES);
  });
  assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, classifications);
  f.cards.useful(owner, 2); await settle();
  if (!native) { assert.equal(f.env.classifications.length, classifications + 1); inspect(f, owner, (_d, p) => assert.ok(p.ranges(key))); }
  else {
    assert.equal(f.sources.borrowSource(key)?.version, 1, 'offline preparation does not observe the new SOURCE');
    assert.ok(f.sources.displayBasis(key), 'the canonical historical native display is still owned');
    inspect(f, owner, (d, p) => {
      if (d.kind !== 'file') assert.fail('file'); assert.equal(d.rows[0]!.region!.text, 'x');
      assert.equal(p.origin, 'owned'); assert.deepEqual(Object.keys(p.roles), CARD_ROLES);
      assert.equal(p.ranges(key), undefined, 'new demand metadata cannot make the previous FILE ranges compatible');
      assert.equal(p.basis(key, () => assert.fail('deferred offline preparation cannot publish the old file text')), false);
    });
    assert.equal(f.calls.length, calls); assert.equal(f.env.classifications.length, classifications);
  }
});

for (const otherOwner of [false, true]) test(`review F2: rejected owned-palette selection retries at a cold update after real funding recovery, otherOwner=${otherOwner}`, async () => {
  const f = fixture(true), owner = {};
  f.update(owner, bash('selection', true));
  const budget = f.sources.geometryFunding()!.budget, select = f.sources.setStyleSelection.bind(f.sources);
  let pressure: ReturnType<typeof budget.reserve>, refuse = true;
  const accepted: boolean[] = [];
  f.sources.setStyleSelection = input => {
    if (input?.palette.startsWith('theme:')) {
      if (refuse && !pressure) { const usage = budget.stats(); pressure = budget.reserve(usage.limit - usage.retainedBytes - usage.outstandingPeakBytes); assert.ok(pressure); }
      const result = select(input); accepted.push(result); return result;
    }
    return select(input);
  };
  try {
    f.theme(); f.update(owner, { ...bash('selection', true), revision: 2 });
    assert.deepEqual(accepted, [false], 'actual controller admission must refuse with its existing budget');
    pressure!.close(); pressure = undefined; refuse = false;
    const current = otherOwner ? {} : owner;
    assert.equal(f.update(current, { ...bash('selection', true), revision: 3 }), true);
    assert.deepEqual(accepted, [false, true], 'a refusal cannot be memoized as installed');
    f.cards.useful(current, 3); await settle();
    const source = f.calls.findIndex(c => c.request.op !== 'styles.resolve'); assert.ok(source >= 0); f.answerSource(source, 'selection'); await settle();
    const styleRequest = f.calls.find(c => c.request.op === 'styles.resolve')?.request;
    assert.ok(styleRequest); assert.equal(styleRequest.rules.revision, 2);
    assert.ok(styleRequest.rules.rules.every((rule: { context: unknown }) => rule.context !== undefined));
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

test('review final delta: ready owned-palette adoption releases its Pi lease and never reacquires it', async () => {
  const f = fixture(true), owner = {}, prepare = f.paletteInputs.prepare.bind(f.paletteInputs);
  const leases: NonNullable<ReturnType<typeof prepare>>[] = [];
  f.paletteInputs.prepare = (...args) => { const lease = prepare(...args); if (lease) leases.push(lease); return lease; };
  f.use(owner, bash('x\n', true)); await settle();
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) { if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i); else f.answerSource(i, 'x\n'); await settle(); }
  const piLeases = leases.filter(lease => lease.paletteId === 'pi'); assert.ok(piLeases.length > 0 && piLeases.some(lease => lease.isValid));
  const before = [f.env.acquisitions, f.env.samples, f.calls.length];
  f.theme('gruvbox-dark'); await settle();
  assert.ok(piLeases.every(lease => !lease.isValid), 'owned-palette adoption releases every superseded Pi lease');
  const stable = [f.env.acquisitions, f.env.samples, f.calls.length];
  f.piTheme('light'); await settle();
  inspect(f, owner, (_d, p) => assert.equal(p.origin, 'owned')); assert.deepEqual([f.env.acquisitions, f.env.samples, f.calls.length], stable);
  assert.ok(stable[0] > before[0]); f.cards.remove(owner); assert.ok(piLeases.every(lease => !lease.isValid));
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
  const f = fixture(true), owner = {}, text = 'const unchanged = 1'; f.theme();
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


for (const tail of ['file', 'bash'] as const) test(`restored files: every Pi fallback receives first native SOURCE with newest ${tail}, then reuses it`, async () => {
  const f = fixture(false), first = {}, change = {}, newest = {};
  const inputs = [written('const older=1;'), edited('-1 const old=1;\n+1 const next=2;'),
    tail === 'file' ? written('const newest=3;') : bash('echo tail', true)];
  const owners = [first, change, newest];
  owners.forEach((owner, index) => f.use(owner, inputs[index]!)); await settle();
  const captures = tail === 'file' ? 4 : 3;
  assert.equal(f.env.classifications.length, captures);
  assert.equal(f.calls.length, 0, 'all file fragments first use Pi while the provider is unavailable');
  const keys = owners.flatMap(owner => f.cards.identities(owner).map(identity => identity.key));
  const stamps = owners.map(owner => { let stamp = 0; inspect(f, owner, (_d, p) => { stamp = p.paintStamp; }); return stamp; });
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  const initial = f.calls.filter(c => c.request.op === 'highlight');
  assert.equal(initial[0]!.request.sources[0].text, tail === 'file' ? 'const newest=3;' : 'echo tail', 'existing newest-first order is preserved');
  owners.forEach((owner, index) => inspect(f, owner, (_d, p) => assert.equal(p.paintStamp, stamps[index], 'Pi remains visible until semantic replies are complete')));
  const expected = new Set(['const older=1;', 'const old=1;', 'const next=2;', tail === 'file' ? 'const newest=3;' : 'echo tail']);
  for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) {
    assert.ok(f.calls.filter(call => !call.done).length <= 2, 'all restored owners share the existing physical job limit');
    if (f.calls[i]!.request.op === 'styles.resolve') f.answerStyle(i);
    else { const text = f.calls[i]!.request.sources[0].text; assert.ok(expected.has(text)); f.answerSource(i, text); }
    await settle();
  }
  const completed = f.calls.filter(c => c.request.op === 'highlight');
  assert.equal(completed.length, expected.size, 'every restored file fragment, not just the newest card, is parsed exactly once');
  assert.deepEqual(new Set(completed.map(c => c.request.sources[0].text)), expected);
  for (const key of keys) assert.equal(f.sources.status(key)?.exact, true, 'all current source owners have validated semantic coverage');
  assert.equal(f.env.classifications.length, captures, 'native admission does not repeat Pi classification');
  const count = f.calls.length;
  for (let visit = 0; visit < 20; visit++) owners.forEach((owner, index) => f.cards.useful(owner, inputs[index]!.revision));
  f.sources.refreshPreparations(); await settle();
  assert.equal(f.calls.length, count, 'warm frames and an explicit queue refresh do not parse or restyle again');
  f.env.ready = false; f.env.generation++; f.cards.metadataChanged(); await settle();
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  assert.equal(f.calls.filter(c => c.request.op === 'highlight').length, expected.size, 'compatible recovery reuses completed semantic SOURCE for every card');
  assert.equal(f.env.classifications.length, captures);
});


test('restored files: a held edit fragment keeps Pi paint until atomic semantic publication', async () => {
  const f = fixture(false), change = {}, newest = {};
  f.use(change, edited('-1 const old=1;\n+1 const next=2;')); f.use(newest, bash('echo tail', true)); await settle();
  const keys = f.cards.identities(change).map(identity => identity.key);
  assert.equal(keys.length, 2); assert.equal(f.env.classifications.length, 2);
  let before = 0; inspect(f, change, (_d, p) => { before = p.paintStamp; });
  f.env.ready = true; f.cards.metadataChanged(); await settle();
  const answer = async () => {
    for (let i = 0; i < f.calls.length; i++) if (!f.calls[i]!.done) {
      const q = f.calls[i]!.request;
      if (q.op === 'styles.resolve') f.answerStyle(i);
      else if (q.sources[0].text !== 'const next=2;') f.answerSource(i, q.sources[0].text);
      await settle();
    }
  };
  await answer();
  const held = f.calls.findIndex(call => !call.done && call.request.op === 'highlight' && call.request.sources[0].text === 'const next=2;');
  assert.ok(held >= 0, 'the second edit fragment is admitted without clicks');
  assert.equal(f.sources.status(keys[0]!)?.exact, true, 'the other edit fragment has completed real SOURCE');
  inspect(f, change, (_d, p) => assert.equal(p.paintStamp, before, 'a partially ready group does not replace the fallback'));
  const count = f.calls.length;
  f.sources.refreshPreparations(); f.cards.metadataChanged(); f.cards.useful(change, 1); await settle();
  assert.equal(f.calls.length, count, 'refresh does not duplicate the completed or held segment');
  assert.equal(f.env.classifications.length, 2, 'retained fallback is not recomputed');
  f.answerSource(held, 'const next=2;'); await settle(); await answer();
  for (const key of keys) assert.equal(f.sources.status(key)?.exact, true);
  inspect(f, change, (_d, p) => assert.notEqual(p.paintStamp, before, 'the complete semantic group replaces Pi paint'));
});

for (const selection of ['owned palette', 'Follow Pi'] as const) test(`C19 frozen cards recolor locally after ${selection} selection without SOURCE or version advance`, async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner, 'x\n');
  f.cards.freeze(owner);
  f.update(owner, bash('x\nlatest\t界', false, 2));
  const identities = f.cards.identities(owner), sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  const sourceIdentity = identities.map(({ key, version, language, complete }) => ({ key, version, language, complete }));
  const originalRoles = style(f, owner), originalRanges = (() => { let value = ''; inspect(f, owner, (_d, p) => p.ranges(identities[0]!.key)?.((_a, _b, s) => { value = s.open; })); return value; })(), beforeCalls = f.calls.length;
  if (selection === 'owned palette') f.theme('gruvbox-light');
  else { f.env.selected = { kind: 'pi' }; f.piTheme('system'); }
  f.cards.useful(owner, 3); await settle();
  assert.notEqual(style(f, owner), originalRoles, 'selected local roles are immediately visible');
  assert.equal(f.calls.length, beforeCalls, 'palette rebinding has no remote STYLE/profile request');
  const rangesAfter = (() => { let value = ''; inspect(f, owner, (_d, p) => p.ranges(identities[0]!.key)?.((_a, _b, s) => { value = s.open; })); return value; })();
  const explicitForeground = (open: string) => open.match(/^\x1b\[38;2;\d+;\d+;\d+m/)?.[0];
  assert.equal(explicitForeground(rangesAfter), explicitForeground(originalRanges), 'cached explicit STYLE ink survives palette rebinding');
  inspect(f, owner, (d, p) => {
    assert.equal(p.origin, selection === 'owned palette' ? 'owned' : 'pi');
    assert.equal(d.kind, 'bash'); if (d.kind === 'bash') assert.equal(d.command.text, 'x\nlatest\t界');
    assert.equal(p.basis(identities[0]!.key, (text, ranges) => {
      assert.equal(text, 'x\n'); assert.equal(ranges((_a, b) => assert.ok(b <= 2)), true);
    }), true);
  });
  assert.deepEqual(f.cards.identities(owner).map(({ key, version, language, complete }) => ({ key, version, language, complete })),
    sourceIdentity, 'frozen source versions are not aliases for latest display');
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
  assert.deepEqual(f.env.classifications, []);
  const calls = f.calls.length, selectedColor = style(f, owner); f.piTheme('light'); await settle();
  if (selection === 'Follow Pi') assert.notEqual(style(f, owner), selectedColor, 'Follow Pi palette changes recolor locally');
  else assert.equal(style(f, owner), selectedColor, 'Pi theme changes do not recolor an owned palette');
  assert.equal(f.calls.length, calls);
});


for (const compatible of [true, false]) test(`C19 frozen cards provider recovery preserves local palette and cached display compatible=${compatible}`, async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner); f.cards.freeze(owner);
  const identity = f.cards.identities(owner), sourceCalls = f.calls.filter(c => c.request.op !== 'styles.resolve').length, callCount = f.calls.length;
  f.env.ready = false; f.cards.metadataChanged(); await settle(); f.env.generation++;
  if (!compatible) f.env.vocabulary = 'd'.repeat(64);
  f.env.ready = true; f.theme('gruvbox-light'); await settle();
  assert.equal(f.calls.length, callCount, 'local palette restore does not request provider profile or SOURCE data');
  inspect(f, owner, (_d, p) => { assert.equal(p.roles.code.open, sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open); });
  assert.deepEqual(f.cards.identities(owner), identity); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sourceCalls);
  assert.deepEqual(f.env.classifications, []);
});

for (const phase of ['early', 'pending', 'unknown'] as const) test(`C19 frozen cards ${phase} source never opens or gains fallback authority on recolor`, async () => {
  const f = fixture(phase !== 'early'), owner = {}; f.theme(); f.use(owner, bash('held')); await settle();
  const key = f.cards.identities(owner)[0]!.key;
  if (phase === 'unknown') { f.fault(f.calls.findIndex(c => c.request.op === 'stream.open'), 'unknown'); await settle(); }
  f.cards.freeze(owner); const sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  const status = f.sources.workStatus(key);
  if (phase !== 'early') assert.equal(status.fallbackEligible, false);
  f.env.ready = true; f.theme('gruvbox-light'); f.update(owner, bash('held latest', true, 3)); f.cards.useful(owner, 3); await settle();
  assert.equal(command(f, owner), 'held latest'); assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources);
  if (phase !== 'early') assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  assert.deepEqual(f.env.classifications, []);
  if (phase === 'pending') {
    f.answerSource(f.calls.findIndex(c => c.request.op === 'stream.open'), 'held'); await settle();
    assert.equal(f.sources.displayBasis(key), undefined, 'late cancelled SOURCE cannot revive a frozen display');
  }
});

for (const stop of ['pause', 'remove', 'off'] as const) test(`C19 frozen cards ${stop} preserves SOURCE lifecycle while palette rebinding stays local`, async () => {
  const f = fixture(true), owner: Owner = {}; await themeReady(f, owner); f.cards.freeze(owner);
  const sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  if (stop === 'pause') f.cards.pause(owner);
  else if (stop === 'remove') { f.cards.remove(owner); f.forget(owner); }
  else { f.env.enabled = false; f.sources.setEnabled(false); }
  const calls = f.calls.length; f.theme('gruvbox-light'); await settle(); assert.equal(f.calls.length, calls);
  if (stop === 'pause') {
    f.cards.useful(owner, owner.input!.revision); await settle();
     inspect(f, owner, (_d, p) => assert.equal(p.roles.code.open, sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open));
  } else if (stop === 'off') {
    inspect(f, owner, (_d, p) => assert.equal(p.roles.code.open, sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open));
    f.env.enabled = true; f.sources.setEnabled(true); f.cards.metadataChanged(); f.cards.useful(owner, owner.input!.revision); await settle();
    assert.equal(f.sources.displayBasis(f.cards.identities(owner)[0]!.key), undefined, 'Off discarded scopes, not source freeze');
  } else assert.equal(f.cards.visit(owner, () => assert.fail('removed card')), false);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources); assert.deepEqual(f.env.classifications, []);
});

test('C19 frozen cards first retained owner collects while local palette rebinding keeps a peer live', async () => {
  const f = fixture(true), peer = {}; let weak: WeakRef<Owner>;
  async function abandon() { const owner = {}; await themeReady(f, owner); f.cards.freeze(owner); return new WeakRef(owner); }
  weak = await abandon(); await themeReady(f, peer, 'peer\n'); f.cards.freeze(peer);
  f.env.invalidated.length = 0; const before = f.sources.stats().retention.retainedBytes, calls = f.calls.length;
  for (let i = 0; i < 60; i++) { await turn(); global.gc!(); await settle(); if (!weak.deref()) break; }
  assert.equal(weak.deref(), undefined); assert.ok(f.sources.stats().retention.retainedBytes < before);
  f.theme('gruvbox-light'); await settle();
  assert.equal(f.calls.length, calls, 'local recoloring needs no helper request');
  inspect(f, peer, (_d, p) => { assert.equal(p.roles.code.open, sampleOwnedPalette('gruvbox-light', 'truecolor').compiledRoles.code.open); assert.ok(p.ranges(f.cards.identities(peer)[0]!.key)); });
  assert.equal(command(f, peer), 'peer\n');
});


for (const stop of ['pause', 'remove', 'off'] as const) test(`C19 in-flight STYLE cannot publish across ${stop}`, async () => {
  const f = fixture(true), owner = {}; await themeReady(f, owner);
  const original = style(f, owner), sources = f.calls.filter(c => c.request.op !== 'styles.resolve').length;
  f.update(owner, bash('new context', true, 2)); f.cards.useful(owner, 2); await settle();
  const source = f.calls.findIndex(c => !c.done && c.request.op !== 'styles.resolve'); assert.ok(source >= 0);
  f.answerSource(source, 'new context', 2); await settle();
  const i = f.calls.findIndex(c => !c.done && c.request.op === 'styles.resolve'); assert.ok(i >= 0);
  assert.equal(f.sources.stats().unsettledJobs, 1); f.cards.freeze(owner);
  if (stop === 'pause') f.cards.pause(owner);
  else if (stop === 'remove') f.cards.remove(owner);
  else { f.env.enabled = false; f.sources.setEnabled(false); f.cards.metadataChanged(); }
  f.answerStyle(i, 99); await settle();
  assert.equal(f.sources.stats().unsettledJobs, 0);
  if (stop === 'pause') assert.equal(style(f, owner), original);
  else if (stop === 'remove') assert.equal(f.cards.visit(owner, () => assert.fail('removed STYLE owner')), false);
  else assert.equal(f.sources.displayBasis(f.cards.identities(owner)[0]!.key), undefined);
  assert.equal(f.calls.filter(c => c.request.op !== 'styles.resolve').length, sources + 1); assert.deepEqual(f.env.classifications, []);
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

test('cards saturated Bash owns a finite Occipital prefix while full command continues and freezes', async () => {
  const f = fixture(true), owner = {}, prefix = 'é'.repeat(32768); f.theme();
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
  inspect(f, owner, (_d, p) => { assert.equal(p.origin, 'owned'); let end = 0, color = '';
    assert.equal(p.ranges(f.cards.identities(owner)[0]!.key)!((_a, b, s) => { end = b; color = s.open; }), true); assert.equal(end, 65536);
    assert.ok(color.includes('77')); });
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

test('card preparation completion follows actual classification and applied paint', { timeout: 2000 }, async () => {
  const f = fixture(), owner = {}, input = written('const completion = 7;');
  let signals = 0, watchdog: ReturnType<typeof setTimeout>;
  const completed = new Promise<void>((resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Card preparation completion was not emitted')), 1000);
    f.env.beforeClassify = () => assert.equal(signals, 0, 'no completion signal while classification is running');
    f.env.prepared = (actual, receipt) => {
      try {
        signals++;
        assert.equal(actual === owner, true);
        assert.equal(receipt.revision, input.revision);
        assert.equal(receipt.palette, input.palette);
        assert.deepEqual(receipt.outcomes, ['pi']);
        assert.equal(receipt.applied, true);
        assert.equal(f.env.classifications.length, 1);
        inspect(f, owner, (display, paint) => {
          assert.equal(display.revision, input.revision);
          assert.equal(paint.publication, receipt.publication);
          assert.ok(paint.publication > 0);
          assert.equal(display.kind, 'file');
          if (display.kind === 'file') assert.equal(typeof paint.ranges(display.rows[0]!.nextSource!.key), 'function');
        });
        resolve();
      } catch (error) { reject(error); }
    };
  });
  try {
    f.use(owner, input);
    await completed;
    assert.equal(signals, 1);
    assert.deepEqual(f.env.preparations.map(receipt => receipt.phase), ['updated', 'prepared']);
    assert.equal(f.env.preparations[0]!.update, f.env.preparations[1]!.update);
    const service = { ...input, revision: 2, serviceRevision: 2 };
    assert.equal(f.update(owner, service), true);
    assert.equal(f.env.preparations.at(-1)!.update, f.env.preparations[0]!.update, 'service-only changes reuse completed source work');
  } finally { clearTimeout(watchdog!); }
});

test('replaced preparation does not report completion for the obsolete update', { timeout: 2000 }, async () => {
  const f = fixture(), owner = {}, first = written('const before = 1;'), next = written('const after = 2;', 2);
  const revisions: number[] = [];
  let watchdog: ReturnType<typeof setTimeout>;
  const completed = new Promise<void>((resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Replacement preparation completion was not emitted')), 1000);
    f.env.prepared = (actual, receipt) => {
      try {
        assert.equal(actual === owner, true);
        revisions.push(receipt.revision);
        if (receipt.revision === next.revision) resolve();
      } catch (error) { reject(error); }
    };
  });
  try {
    f.env.beforeClassify = () => { f.env.beforeClassify = undefined; f.use(owner, next); };
    f.use(owner, first);
    await completed;
    assert.deepEqual(revisions, [next.revision]);
  } finally { clearTimeout(watchdog!); }
});

test('preparation completion distinguishes classification from failed paint application', { timeout: 2000 }, async () => {
  const f = fixture(), owner = {}, input = written('const denied = 3;');
  const funding = f.sources.geometryFunding.bind(f.sources);
  let deny = false, watchdog: ReturnType<typeof setTimeout>;
  f.sources.geometryFunding = (...args) => deny ? undefined : funding(...args);
  f.env.beforeClassify = () => { deny = true; };
  const completed = new Promise<Extract<CardPreparation, { phase: 'prepared' }>>((resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Denied paint preparation was not reported')), 1000);
    f.env.prepared = (_owner, receipt) => resolve(receipt);
  });
  try {
    f.use(owner, input);
    const receipt = await completed;
    assert.equal(f.env.classifications.length, 1);
    assert.deepEqual(receipt.outcomes, ['pi']);
    assert.ok(receipt.publication > 0, 'retained neutral paint is not proof of applying the new classification');
    assert.equal(receipt.applied, false, 'a classified source alone must not acknowledge applied paint');
  } finally { clearTimeout(watchdog!); }
});

for (const partial of [false, true]) test(`preparation reports refused source admissions (partial=${partial})`, { timeout: 2000 }, async () => {
  const allowance = RETENTION_LIMITS.entryAllowance;
  const f = fixture(false, {}, partial ? allowance * 2 + 64 : allowance), owner = {};
  const input = partial ? edited('-1 const before = 1;\n+1 const after = 2;') : written('const omitted = 1;');
  let watchdog: ReturnType<typeof setTimeout>;
  const completed = new Promise<Extract<CardPreparation, { phase: 'prepared' }>>((resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Refused preparation was not reported')), 1000);
    f.env.prepared = (_owner, receipt) => resolve(receipt);
  });
  try {
    f.use(owner, input);
    const receipt = await completed;
    assert.equal(f.cards.identities(owner).length, partial ? 1 : 0);
    assert.equal(f.env.classifications.length, partial ? 1 : 0);
    assert.ok(receipt.publication > 0, 'retained neutral/partial paint is allowed, but cannot prove all demanded source work');
    assert.equal(receipt.refused, 1);
  } finally { clearTimeout(watchdog!); }
});


for (const remaining of ['none', 'held-local', 'palette-change', 'retained-style', 'recoverable'] as const) test(`completion boundary: ${remaining === 'recoverable' ? 'recoverable' : 'terminal'} provider loss drains real card metadata (${remaining})`, { timeout: 12000 }, async t => {
  let bothBusy!: () => void, requested!: () => void, initiallyYielded!: () => void, terminalDelivered!: () => void, locallyYielded!: () => void, fallbackPrepared!: () => void, recovering!: () => void;
  const busy = new Promise<void>(resolve => { bothBusy = resolve; }), sourceRequest = new Promise<void>(resolve => { requested = resolve; });
  const initialYield = new Promise<void>(resolve => { initiallyYielded = resolve; }), terminal = new Promise<void>(resolve => { terminalDelivered = resolve; });
  const localYield = new Promise<void>(resolve => { locallyYielded = resolve; });
  const fallback = new Promise<void>(resolve => { fallbackPrepared = resolve; });
  const recovery = new Promise<void>(resolve => { recovering = resolve; });
  let releaseRecovery: (() => void) | undefined, sharedAttempts = 0, dispatched = 0;
  const a = fixture(true, { diagnostic: (_level, _area, explanation, fields) => {
    if (explanation === 'Native job dispatched' && fields?.operation === 'highlight' && ++dispatched === 2) bothBusy();
  } });
  class LifetimePeer implements ProviderTransport {
    private finish!: (reason: TransportEnd) => void;
    ended = new Promise<TransportEnd>(resolve => { this.finish = resolve; });
    endReason: TransportEnd | undefined;
    calls: { request: Frame; resolve(value: unknown): void }[] = [];
    request(request: Frame): Promise<unknown> {
      return new Promise(resolve => {
        this.calls.push({ request, resolve });
        if (request.op === 'describe') resolve(semanticDescriptor(request.ticket, 'terminal'));
        if (request.op === 'highlight') requested();
      });
    }
    end(reason: TransportEnd) { this.endReason = reason; this.finish(reason); }
    async close() { this.endReason ??= 'closed'; this.finish(this.endReason); for (const call of this.calls) call.resolve({}); }
    source() {
      const call = this.calls.find(call => call.request.op === 'highlight')!, q = call.request, s = q.sources[0], bytes = Buffer.byteLength(s.text);
      call.resolve({ v: 4, ticket: q.ticket, instance: 'terminal', assets: 'assets', status: 'ok', body: {
        kind: 'source', vocabulary: 'a'.repeat(64), sources: [{ key: s.key, generation: s.generation, source_version: s.source_version,
          revision: 1, source_bytes: bytes, replace_from: 0, committed_bytes: bytes, complete: true, contexts: [[0, 1]], runs: [bytes, 1],
          counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: bytes } }] } });
    }
  }
  const peer = new LifetimePeer(), replacement = new LifetimePeer(); let theme = getThemeByName('system')!;
  let cards: CardSources<Owner>, metadata = 0, classifications = 0, outcomes: readonly string[] = [];
  const client = new SyntaxClient({ standaloneVersion: '0.2.0', initialTheme: { kind: 'pi' },
    provider: { tryShared: async () => {
      if (++sharedAttempts === 1) return peer;
      assert.equal(remaining, 'recoverable', 'terminal denial must not recover');
      return new Promise<ProviderTransport>(resolve => { releaseRecovery = () => resolve(replacement); recovering(); });
    }, acquireOwned: async () => { assert.fail('controlled shared recovery must not acquire owned'); } },
    onChange() { metadata++; cards?.metadataChanged(); if (client.snapshot().provider.availability === 'unavailable') terminalDelivered(); },
    onSourceChange(keys, groups) { cards?.sourceChanged(keys, groups); } });
  cards = new CardSources(client, { preparePiInput: funding => a.runtime.preparePaletteInput(
    resolveTheme({ kind: 'pi' }).effective, theme, a.runtime.palette(theme), 'truecolor', funding),
    classify: text => { classifications++; return highlightCode(text, 'typescript'); }, invalidate() {}, requestRender() {},
    preparation(_owner, receipt) {
      if (receipt.phase !== 'prepared' || receipt.revision !== 2 || client.snapshot().provider.availability === 'ready') return;
      outcomes = [...receipt.outcomes];
      if (remaining === 'held-local' && phase === 'open') {
        phase = 'local';
        for (const preparation of local) client.sources.queuePreparation(client.sources.registerPreparation(preparation)!, true);
      }
      fallbackPrepared();
    } });
  const resume = client.sources.resumePreparation;
  let phase = 'initial', stage = 'startup', withdrawalWakes = 0, releaseInitial: (() => void) | undefined, releaseLocal: (() => void) | undefined;
  t.mock.method(client.sources, 'resumePreparation', function(this: SourceController) {
    if (phase === 'initial') { phase = 'initial-held'; releaseInitial = () => resume.call(this); initiallyYielded(); return; }
    if (phase === 'local' && visits.length > 0) { phase = 'local-held'; releaseLocal = () => resume.call(this); locallyYielded(); return; }
    return resume.call(this);
  });
  const owner = {}, visits: number[] = [];
  const local = Array.from({ length: 3 }, (_, i) => ({ keys: new Set<string>(), needsRefresh() { return false; }, requiresCredit() { return false; }, prepare() { visits.push(i); } }));
  try {
    await client.start(); assert.equal(await awaitFixture(client.whenSettled()), true);
    const input = { ...written('const terminal = 1;'), palette: a.runtime.palette(theme) };
    cards.updateDisplay(owner, input); cards.useful(owner, input.revision);
    await awaitFixture(sourceRequest); await awaitFixture(initialYield);
    const p = client.snapshot().effective!;
    for (const key of ['a', 'b']) a.sources.observe({ key, text: key, version: 1, complete: true });
    a.sources.flush(); peer.source(); await awaitFixture(busy);
    assert.equal(a.sources.stats().globalUnsettledJobs, 2); assert.equal(client.sources.stats().unsettledJobs, 0);
    assert.ok(releaseInitial); phase = 'open'; releaseInitial(); await settle();
    assert.equal(client.sources.stats().waitingOwners, 1, 'B owns real credit interest after its actual SOURCE reply and preparation continuation');
    assert.equal(peer.calls.length, 2, 'only metadata and SOURCE were dispatched; STYLE waits on foreign credit');
    const key = cards.identities(owner)[0]!.key;
    const retained = remaining === 'retained-style';
    const latest = retained ? input : { ...written('const terminal = 2;', 2), palette: input.palette };
    if (!retained) { cards.updateDisplay(owner, latest); cards.useful(owner, latest.revision); await settle(); }
    assert.equal(client.sources.status(key)!.version, retained ? 1 : 2, 'source ownership remains while native dispatch is credit-blocked');
    assert.equal(client.sources.stats().waitingOwners, 1);
    const generation = client.sources.status(key)!.generation;
    let completion = client.whenSettled(), completed = false; void completion.then(() => { completed = true; });
    const beforeMetadata = metadata, bytes = a.sources.stats().globalTransientBytes;
    const recoverable = remaining === 'recoverable';
    peer.end(recoverable ? 'lost' : 'denied'); await awaitFixture(recoverable ? recovery : terminal);
    stage = 'provider-fallback'; if (!retained) await awaitFixture(fallback);
    if (!recoverable) assert.equal(await awaitFixture(client.broker.whenSettled()), true);
    await settle();
    assert.equal(client.snapshot().provider.reason, recoverable ? 'proven_loss' : 'transport_denied');
    assert.equal(client.snapshot().provider.availability, recoverable ? 'transitioning' : 'unavailable');
    assert.equal(client.broker.stats().recoveryTimers, 0); assert.equal(client.broker.stats().activeProbes, 0);
    assert.equal(client.snapshot().effective?.id, 'pi'); assert.ok(metadata > beforeMetadata);
    assert.equal(client.sources.status(key)!.generation, generation, 'metadata fallback retains the source rather than invoking a removal hook');
    assert.equal(peer.calls.length, 2); assert.equal(classifications, retained ? 0 : 1, 'only an unparsed FILE needs a real Pi classifier fallback');
    assert.deepEqual(outcomes, retained ? [] : ['pi']);
    assert.equal(cards.visit(owner, (display, paint) => { assert.equal(display.kind, 'file'); assert.equal(paint.origin, 'pi'); if (display.kind === 'file') assert.equal(display.rows.find(row => row.region)?.region?.text, retained ? 'const terminal = 1;' : 'const terminal = 2;'); }), true);
    if (remaining === 'held-local') {
      stage = 'local-continuation'; await awaitFixture(localYield);
      assert.ok(visits.length > 0 && visits.length < 3); assert.equal(completed, false, 'reentrant local work is owed by the original observation');
      cards.remove(owner); assert.equal(completed, false, 'withdrawing native interest cannot release a held local continuation');
      assert.equal(client.sources.stats().unsettledJobs, 0); assert.ok(releaseLocal); phase = 'open'; releaseLocal();
    }
    if (remaining === 'palette-change' || retained) {
      const wake = client.sources.wake;
      t.mock.method(client.sources, 'wake', function(this: SourceController) { withdrawalWakes++; return wake.call(this); });
      theme = getThemeByName('dark')!;
      const next = { ...latest, revision: 3, palette: a.runtime.palette(theme) };
      cards.updateDisplay(owner, next); cards.useful(owner, next.revision); await settle();
      assert.ok(withdrawalWakes <= 1, 'a single actual palette replacement cannot add repeated withdrawal wakes');
      completion = client.whenSettled();
    }
    if (recoverable) {
      assert.equal(await awaitFixture(client.sources.whenSettled()), true, 'source work can drain while the broker owes recovery');
      const brokerCompletion = client.broker.whenSettled(); let brokerCompleted = false; void brokerCompletion.then(() => { brokerCompleted = true; });
      await settle(); assert.equal(completed, false); assert.equal(brokerCompleted, false);
      assert.equal(sharedAttempts, 2); assert.equal(client.sources.stats().waitingOwners, 0);
      assert.equal(a.sources.stats().globalUnsettledJobs, 2); assert.equal(a.sources.stats().globalTransientBytes, bytes);
      assert.ok(releaseRecovery); releaseRecovery(); assert.equal(await awaitFixture(brokerCompletion), true);
    }
    stage = 'completion'; assert.equal(await awaitFixture(completion), true);
    if (recoverable) { assert.equal(client.snapshot().provider.availability, 'ready'); assert.deepEqual(replacement.calls.map(call => call.request.op), ['describe']); }
    if (remaining === 'held-local') assert.deepEqual(visits, [2, 1, 0]);
    assert.equal(a.sources.stats().globalUnsettledJobs, 2); assert.equal(a.sources.stats().globalTransientBytes, bytes);
  } catch (error) {
    const state = client.sources.stats();
    console.log(JSON.stringify({ terminalProviderProbe: { remaining, stage, availability: client.snapshot().provider.availability,
      classifications, outcomes, withdrawalWakes, waitingOwners: state.waitingOwners, jobs: state.unsettledJobs, globalJobs: state.globalUnsettledJobs,
      closes: state.pendingCloses, recoveryTimers: client.broker.stats().recoveryTimers } }));
    throw error;
  } finally {
    phase = 'open'; releaseInitial?.(); releaseLocal?.(); releaseRecovery?.(); cards.dispose(); await client.dispose();
    a.sources.dispose(); for (const call of a.calls) call.reject(new RequestFailure('cleanup', 'not_started')); await settle();
  }
});
