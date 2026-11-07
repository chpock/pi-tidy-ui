import '../../fixtures/test-guard.mjs';
import { isDeferredStockEditComponent, isDeferredStockFileCall, isDeferredStockFilePair } from '../../../src/syntax/lazy-native-renderers.ts';
import { hostCells, hasHostInk } from '../../fixtures/host-cells.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Box, Container, Text } from '@earendil-works/pi-tui';
import { VERSION, highlightCode, getLanguageFromPath, createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { installTidyUi, type TidyUiController, type TidyUiOptions } from '../../../src/index.ts';
import { resolvePublicFileToolDefinition } from '../../fixtures/sdk-contract-support.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import type { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderSnapshot } from '../../../src/occipital/provider.ts';
import { SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { resolveTheme } from '../../../src/themes/selection.ts';
import { palettePreference } from '../../fixtures/palette-preference.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { DeferredRenderer } from '../../../src/syntax/lazy-native-renderers.ts';
import { sampleOwnedPalette } from '../../../src/themes/owned-palette.ts';
import { PaletteInputOwner } from '../../../src/syntax/pi-input-owner.ts';
import { observeSyntaxLocalWork } from '../../fixtures/syntax-local-work.ts';
import { CardLayout } from '../../../src/syntax/card-layout.ts';
import { DataCharge } from '../../../src/occipital/data-budget.ts';
import { bashCardFixture as renderBashCard } from '../../fixtures/prepared-card.ts';
import { fileCardFixture as renderFileCard } from '../../fixtures/prepared-card.ts';
import * as fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextJournal } from '../../../src/debug-log.ts';
import type { DiagnosticFields, DiagnosticSink } from '../../../src/diagnostics.ts';

const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/components/tool-execution.js')).href);
const nativeToolRender = ToolExecutionComponent.prototype.render;
const themes = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
const description = decodeSemanticDescription(semanticDescriptor('describe', 'daemon'), 'describe');
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const fixtures: { adapter: TidyUiController; sources: SourceController;
  calls: { request: Record<string, unknown>; resolve(value: unknown): void }[]; styleCalls: { resolve(value: unknown): void }[] }[] = [];
function fixture(ready = false, useDefaultClassifier = false, options: Pick<TidyUiOptions, 'cards' | 'compact' | 'diagnostic'> = {}, retention?: { maxBytes: number }, switchable = false, externalOwner = false) {
  let root = new UI();
  const ui = switchable ? new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(root, property, root);
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, root, args) : value;
    },
    getPrototypeOf: () => Object.getPrototypeOf(root),
    set: () => { throw new Error('No renderer writes through the public TUI reference'); },
  }) as UI : root;
  const liveCalls = new Set<string>();
  const env = { liveCalls, ready, enabled: true, generation: 1, selected: { kind: 'pi', variant: 'dark' } as ReturnType<SyntaxClient['snapshot']>['selected'], palette: 1, padding: 1, depth: 0, boldPi: false, plainPi: false, pi: [] as string[], observes: 0, captures: 0, reads: 0, holdStyles: false, styleRequests: [] as Record<string, any>[], poisonPi: false, keys: [] as string[], capturedKeys: [] as string[], committed: new Map<string, number>() };
  const calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] = [];
  const styleCalls: { request: Record<string, any>; resolve(value: unknown): void }[] = [];
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: env.generation, availability: env.ready ? 'ready' : 'initializing',
      reason: env.ready ? 'ready' : 'initializing', initialShared: false, kind: 'owned', description: env.ready ? description : undefined }; },
    isReady(g: number) { return env.ready && g === env.generation; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) {
      assert.equal(env.depth, 0, 'no dispatch in render');
      if (request.op === 'styles.resolve') {
        const q = request as Record<string, any>;
        env.styleRequests.push(q);
        if (env.holdStyles) return new Promise<unknown>(resolve => styleCalls.push({ request: q, resolve }));
        return Promise.resolve({ v: PROTOCOL_VERSION, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
          kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintRules(q.rules),
          styles: [{ foreground: { kind: 'binding', slot: 3 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }],
           indices: q.contexts.map(() => 1) } });
      }
      return new Promise<unknown>(resolve => calls.push({ request, resolve }));
    }
  };
  let adapter: TidyUiController, toolIdentity = 0;
  const sources = new SourceController(provider, { retention, diagnostic: options.diagnostic, onChange: (keys, groups) => adapter.syntaxSourceChanged(keys, groups) });
  const observe = sources.observe.bind(sources), capture = sources.capturePiSource.bind(sources);
  sources.observe = (...args) => { assert.equal(env.depth, 0, 'no native source preparation in render'); env.observes++; env.keys.push(args[0].key); return observe(...args); };
  sources.capturePiSource = (...args) => { assert.equal(env.depth, 0, 'no Pi source preparation in render'); env.captures++; env.capturedKeys.push(args[0]); return capture(...args); };
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> = { sources, snapshot: () => {
    assert.equal(env.depth, 0, 'no work metadata read in render'); env.reads++;
    return { enabled: env.enabled, provider: provider.snapshot(), standaloneVersion: 'test', selected: env.selected, effective: resolveTheme(env.selected).effective };
  } };
  let paletteRevision = 0, paletteColors = themes.theme.colors;
  const currentPiColors = () => {
    if (paletteRevision !== env.palette) { paletteRevision = env.palette; paletteColors = { ...themes.theme.colors }; }
    return paletteColors;
  };
  const publicPiInput = () => {
    assert.equal(env.poisonPi, false, 'fixed owned card must not acquire unrelated Pi input');
    return { theme: { colors: currentPiColors(), getFgAnsi: (role: Parameters<typeof themes.theme.getFgAnsi>[0]) => themes.theme.getFgAnsi(role),
      getBgAnsi: (role: Parameters<typeof themes.theme.getBgAnsi>[0]) => themes.theme.getBgAnsi(role) }, mode: themes.theme.getColorMode() };
  };
  const externalInput = externalOwner ? new PaletteInputOwner(options.diagnostic) : undefined;
  const presentationOptions: TidyUiOptions = { ...options, outputPad: () => env.padding,
    piInput: publicPiInput, syntax: { client,
    isLiveCall: id => liveCalls.has(id),
    palette: () => externalInput ? externalInput.palette({ colors: currentPiColors() }, resolveTheme(env.selected).effective) : env.palette,
    classify: useDefaultClassifier ? undefined : (text, info) => {
      assert.equal(env.depth, 0, 'no Pi call in render'); env.pi.push(text);
      const rows = env.plainPi ? text.split('\n') : highlightCode(text, info.language);
      return env.boldPi ? rows.map(row => themes.theme.style(row, { bold: true })) : rows;
    } },
    ...(externalInput ? { preparePaletteInput: (palette, theme, revision, mode, funding, usePiFallback, fallbackTheme) =>
      externalInput.prepare(theme, palette, revision, mode, funding, usePiFallback, fallbackTheme) } : {}) };
  const install = () => {
    adapter = installTidyUi(ui, () => themes.theme, presentationOptions);
    assert.equal(adapter.active, true, adapter.reason);
  };
  install();
  const value = { ui, env, calls, styleCalls, sources, get adapter() { return adapter; },
    replaceRenderer() {
      assert.equal(switchable, true);
      const children = root.children;
      root.clear(); root = new UI();
      for (const child of children) root.addChild(child);
      root.invalidate();
    },
    reinstall() { adapter.restore(); install(); },
    render(tool: InstanceType<typeof ToolExecutionComponent>, width = 60): string[] {
      env.depth++; try { return tool.render(width); } finally { env.depth--; }
    },
    document(width = 60): string[] {
      env.depth++; try { return ui.render(width); } finally { env.depth--; }
    },
    currentPiColors,
    weakCurrentPiColors() { return new WeakRef(paletteColors); },
    tool(name: string, args: Record<string, unknown>, definition?: unknown, restored = false) {
      const id = `host-${name}-${++toolIdentity}`;
      if (!restored) liveCalls.add(id);
      const resolvedDefinition = resolvePublicFileToolDefinition(name, definition, '/tmp') as ToolDefinition | undefined;
      const tool = new ToolExecutionComponent(name, id, args, undefined, resolvedDefinition, ui, '/tmp');
      ui.addChild(tool); return tool;
    } };
  fixtures.push(value); return value;
}
async function settled() { for (let i = 0; i < 8; i++) await turn(); }
const plain = (rows: string[]) => rows.map(stripVTControlCharacters);
function counts(f: ReturnType<typeof fixture>) { return [f.env.pi.length, f.env.observes, f.env.captures, f.env.reads, f.calls.length]; }
function sourceCounts(f: ReturnType<typeof fixture>) { return counts(f).filter((_value, index) => index !== 3); }
function watchConsumer(f: ReturnType<typeof fixture>) {
  const useful = CardSources.prototype.useful, prepare = CardSources.prototype.prepare;
  let demands = 0, preparationVisits = 0;
  CardSources.prototype.useful = function (...args) { demands++; return useful.apply(this, args); };
  CardSources.prototype.prepare = function (ticket) {
    preparationVisits++; assert.equal(f.env.depth, 0, 'no preparation visit in render'); return prepare.call(this, ticket);
  };
  return { counts: () => [demands, preparationVisits, ...counts(f)],
    restore() { CardSources.prototype.useful = useful; CardSources.prototype.prepare = prepare; } };
}
function written(f: ReturnType<typeof fixture>, content: string, path = 'a.ts') {
  const tool = f.tool('write', { path, content });
  tool.updateResult({ content: [{ type: 'text', text: 'saved' }], isError: false }, false); return tool;
}
function observeLazyFileCallbacks(tool: object) {
  const calls = { call: 0, result: 0 };
  for (const [slot, field] of [['call', 'callRendererComponent'], ['result', 'resultRendererComponent']] as const) {
    const component = Reflect.get(tool, field);
    assert.ok(component instanceof DeferredRenderer, `current Pi ${slot} slot is the owned deferred stock wrapper`);
    assert.equal(typeof Reflect.get(component, 'invoke'), 'function', `current Pi ${slot} wrapper has a live stock callback`);
  }
  const materialize = DeferredRenderer.prototype.materialize;
  const observed = function(this: DeferredRenderer) {
    const slot = this === Reflect.get(tool, 'callRendererComponent') ? 'call'
      : this === Reflect.get(tool, 'resultRendererComponent') ? 'result' : undefined;
    if (slot && !Reflect.get(this, 'disposed') && !Reflect.get(this, 'component') && typeof Reflect.get(this, 'invoke') === 'function') calls[slot]++;
    return materialize.call(this);
  };
  DeferredRenderer.prototype.materialize = observed;
  return { calls, restore() { if (DeferredRenderer.prototype.materialize === observed) DeferredRenderer.prototype.materialize = materialize; } };
}
function paintFundingProbe(f: ReturnType<typeof fixture>, refusal: 'palette' | 'paint' = 'paint') {
  const originalFunding = f.sources.geometryFunding;
  const boundFunding = originalFunding.bind(f.sources);
  const originalRefresh = Reflect.get(CardSources.prototype, 'refreshPaint');
  const originalReconcile = Reflect.get(CardSources.prototype, 'reconcileSelection');
  assert.equal(typeof originalRefresh, 'function'); assert.equal(typeof originalReconcile, 'function');
  let paintDepth = 0, paletteDepth = 0, displayDepth = 0, stage: 'refused' | 'palette-only' | 'recovery' | 'allowed' = 'refused';
  let deniedPreparationBytes = 0, deniedLogicalBytes = 0;
  const originalUpdate = CardSources.prototype.updateDisplay;
  const observedUpdate = function(this: CardSources<object>, ...args: Parameters<typeof originalUpdate>) {
    displayDepth++; try { return originalUpdate.apply(this, args); } finally { displayDepth--; }
  };
  CardSources.prototype.updateDisplay = observedUpdate;
  f.sources.geometryFunding = group => {
    const available = boundFunding(group);
    if (!available) return undefined;
    return { budget: available.budget, grant(bytes: number) {
      if ((stage === 'recovery' || stage === 'palette-only') && displayDepth > 0 && paintDepth === 0 && paletteDepth === 0) { deniedLogicalBytes += bytes; return undefined; }
      if (stage === 'palette-only' && paintDepth > 0 && bytes > 16 * 1024
        || stage === 'refused' && (refusal === 'palette' ? paletteDepth > 0 : paintDepth > 0 && bytes > 16 * 1024)) {
        deniedPreparationBytes += bytes; return undefined;
      }
      return available.grant(bytes);
    } };
  };
  const observedRefresh = function(this: CardSources<object>, ...args: unknown[]) {
    paintDepth++;
    try { return Reflect.apply(originalRefresh, this, args); } finally { paintDepth--; }
  };
  const observedReconcile = function(this: CardSources<object>, ...args: unknown[]) {
    paletteDepth++;
    try { return Reflect.apply(originalReconcile, this, args); } finally { paletteDepth--; }
  };
  Reflect.set(CardSources.prototype, 'refreshPaint', observedRefresh);
  Reflect.set(CardSources.prototype, 'reconcileSelection', observedReconcile);
  return {
    paletteOnly() { stage = 'palette-only'; }, recover() { stage = 'recovery'; }, allow() { stage = 'allowed'; },
    snapshot() { return { deniedPreparationBytes, deniedLogicalBytes }; },
    restore() {
      if (Reflect.get(CardSources.prototype, 'refreshPaint') === observedRefresh) Reflect.set(CardSources.prototype, 'refreshPaint', originalRefresh);
      if (Reflect.get(CardSources.prototype, 'reconcileSelection') === observedReconcile) Reflect.set(CardSources.prototype, 'reconcileSelection', originalReconcile);
      if (CardSources.prototype.updateDisplay === observedUpdate) CardSources.prototype.updateDisplay = originalUpdate;
      f.sources.geometryFunding = originalFunding;
    },
  };
}
function answer(f: ReturnType<typeof fixture>, index: number, text: string, complete = true, committedBytes?: number) {
  const call = f.calls[index]!, r = call.request;
  const source = r.op === 'stream.append' ? r : (r.sources as Record<string, unknown>[])[0]!;
  const bytes = Buffer.byteLength(text), from = r.op === 'stream.append' ? f.env.committed.get(source.key as string)! : 0;
  f.env.committed.set(source.key as string, committedBytes ?? bytes);
  call.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: source.key, generation: source.generation, source_version: source.source_version,
      revision: r.op === 'stream.append' ? (r.base_revision as number) + 1 : 1,
      replace_from: from, source_bytes: bytes, committed_bytes: committedBytes ?? bytes, complete,
      ...(r.op !== 'highlight' ? { lease: 'lease' } : {}), contexts: bytes > from ? [[0, 1]] : [], runs: bytes > from ? [bytes - from, 1] : [],
      counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }]
  } });
}
function fileCardOracle<T extends object>(tool: T, ...args: Parameters<typeof renderFileCard> extends [unknown, ...infer Rest] ? Rest : never) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
  return renderFileCard(copy, ...args);
}
function fault(f: ReturnType<typeof fixture>, index: number) {
  const call = f.calls[index]!;
  call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: 'daemon', assets: 'assets', status: 'error', error: { code: 'busy', execution: 'not_started' } });
}
afterEach(async () => {
  for (const f of fixtures) { f.adapter.restore(); f.sources.dispose(); }
  for (let i = 0; i < 5; i++) { for (const f of fixtures) for (const call of [...f.calls, ...f.styleCalls]) call.resolve({}); await settled(); }
  for (const f of fixtures) assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  fixtures.length = 0;
});

test('host cold file is exact plain then public Pi colors; warmed render/width/padding/output events do zero work', async () => {
  const f = fixture(), tool = written(f, 'const n = 1;\n\t// comment');
  tool.setExpanded(true);
  const result = JSON.stringify(tool.result), args = JSON.stringify(tool.args);
  const cold = f.render(tool);
  const expectedCold = fileCardOracle(tool, '/tmp', 60, themes.theme)!;
  assert.deepEqual(plain(cold), plain(expectedCold.rows));
  assert.deepEqual(f.env.pi, []); await settled();
  assert.deepEqual(f.env.pi, ['const n = 1;\n\t// comment']);
  const warm = f.render(tool);
  assert.deepEqual(plain(warm), plain(cold)); assert.notDeepEqual(warm, cold);
  const before = counts(f);
  for (const width of [60, 121, 24]) { f.env.padding = width === 24 ? 0 : 1; f.render(tool, width); }
  f.document(); f.document();
  tool.invalidate(); f.render(tool, 60); tool.updateResult({ ...tool.result, content: [{ type: 'text', text: 'stdout-only' }] }, false); f.render(tool);
  await settled(); assert.deepEqual(counts(f), before);
  assert.equal(JSON.stringify(tool.args), args); assert.equal(result, JSON.stringify({ content: [{ type: 'text', text: 'saved' }], isError: false }));
});

test('host Bash duplicate and same-object source events coalesce; argsComplete finalizes without execution or duplicate redraw', async () => {
  const f = fixture(true), args = { command: 'x', description: 'first', workdir: '.' }, tool = f.tool('bash', args);
  args.command = 'pre'; tool.updateArgs(args); args.command = 'x\n'; tool.updateArgs(args);
  await settled(); assert.equal(f.calls.length, 0, 'pre-first-demand events do not start work');
  f.render(tool); await settled(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.request.op, 'stream.open');
  const before = sourceCounts(f);
  tool.updateArgs({ ...args }); f.render(tool); f.document();
  args.description = 'second'; args.workdir = '/tmp'; tool.updateArgs(args); f.render(tool);
  tool.updateResult({ content: [{ type: 'text', text: 'stdout' }] }, true); f.render(tool);
  await settled(); assert.deepEqual(sourceCounts(f), before);
  const requests = f.ui.requests; assert.equal(tool.setArgsComplete(), undefined);
  assert.equal(f.ui.requests, requests + 1, 'original setter owns sole synchronous redraw');
  assert.equal(tool.getRenderContext().argsComplete, true); assert.equal(tool.isPartial, true);
  assert.equal(tool.executionStarted, false, 'source completion is independent of process execution');
  tool.markExecutionStarted(); f.render(tool);
  await settled(); assert.equal(f.calls.length, 1);
  answer(f, 0, 'x\n', false); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.append, ''); assert.equal(f.calls[1]!.request.final, true);
  answer(f, 1, 'x\n'); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'x'));
  args.command = 'y'; tool.updateArgs(args); f.render(tool); await settled();
  assert.equal(f.env.pi.length, 0); assert.ok(f.env.observes > before[1]!);
});

test('a refused Bash replacement shows current compact arguments, not stale prepared rows', async () => {
  const f = fixture(true), previous = "printf 'BASH_OLD_COMMAND'", latest = "printf 'BASH_NEW_COMMAND'";
  const tool = f.tool('bash', { command: previous }, createBashToolDefinition('/tmp'));
  tool.setArgsComplete();
  tool.updateResult({ content: [{ type: 'text', text: 'BASH_OLD_OUTPUT' }], isError: false }, false);
  f.render(tool); await settled();
  assert.equal(f.calls.length, 1, 'the initial command is admitted once'); answer(f, 0, previous); await settled();
  const originalVisit = CardSources.prototype.visit; let acceptedPriorDisplays = 0;
  CardSources.prototype.visit = function (owner, consume) {
    return originalVisit.call(this, owner, (display, paint) => { if (display.kind === 'bash') acceptedPriorDisplays++; consume(display, paint); });
  };
  let warm: string[];
  try { warm = f.render(tool); } finally { CardSources.prototype.visit = originalVisit; }
  assert.ok(acceptedPriorDisplays > 0, 'the prior prepared display has a ready paint accepted by CardSources.visit before replacement');
  assert.ok(plain(warm).join('\n').includes(previous) && plain(warm).join('\n').includes('BASH_OLD_OUTPUT'), `the admitted display contains its old current command and result: ${plain(warm).join(' | ')}`);
  const funding = f.sources.geometryFunding;
  let denied = 0;
  f.sources.geometryFunding = () => { denied++; return undefined; };
  try {
    tool.updateArgs({ command: latest });
    tool.updateResult({ content: [{ type: 'text', text: 'BASH_NEW_OUTPUT' }], isError: false }, false);
  } finally { f.sources.geometryFunding = funding; }
  assert.ok(denied > 0, 'the replacement attempt reaches the real geometry-funding boundary and is refused');
  assert.ok(f.sources.geometryFunding(), 'the old retained display would remain fundable to a stale borrower');
  const current = plain(f.render(tool)).join('\n');
  assert.match(current, /⚙ bash/u);
  assert.ok(current.includes('BASH_NEW_COMMAND'), `compact fallback shows latest Bash arguments: ${current}`);
  assert.ok(!current.includes('BASH_OLD_COMMAND') && !current.includes('BASH_OLD_OUTPUT'), `stale prepared rows must not replace current output: ${current}`);
  assert.equal(tool.result.content[0].text, 'BASH_NEW_OUTPUT', 'compact presentation preserves the full current saved result');
  tool.updateArgs({ ...tool.args });
  const recovered = plain(f.render(tool)).join('\n');
  assert.ok(recovered.includes('┃') && recovered.includes('BASH_NEW_COMMAND') && recovered.includes('BASH_NEW_OUTPUT'), 'ordinary input preparation restores the complete latest card');
});

for (const refusal of ['palette', 'paint'] as const) test(`accepted read source with refused first ${refusal} stays bounded and recovers without stock callbacks`, async () => {
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.enabled = false; await f.sources.setEnabled(false);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  const marker = 'F2_PAINT_REFUSAL_READ_SOURCE', resultText = `const ${marker} = 1;`;
  const work = observeSyntaxLocalWork(text => text.includes(marker)), probe = paintFundingProbe(f, refusal);
  const updateDisplay = CardSources.prototype.updateDisplay;
  let acceptedFullInputs = 0, denyLayout = false, target: object | undefined;
  let basis: { revision: number; display: unknown; charge: unknown } | undefined;
  const geometryFunding = f.sources.geometryFunding;
  f.sources.geometryFunding = group => {
    const funding = geometryFunding.call(f.sources, group);
    return funding && { budget: funding.budget, grant: bytes => denyLayout && f.env.depth > 0 ? undefined : funding.grant(bytes) };
  };
  CardSources.prototype.updateDisplay = function (owner, input) {
    const accepted = updateDisplay.call(this, owner, input);
    if (accepted && owner === target && input.kind === 'file' && input.viewMode === 'full') {
      acceptedFullInputs++;
      const current = (Reflect.get(this, 'states') as WeakMap<object, { display: unknown; charge: unknown }>).get(owner)!;
      if (!basis) basis = { revision: input.revision, display: current.display, charge: current.charge };
      else {
        assert.equal(input.revision, basis.revision, 'paint retry keeps its accepted input revision');
        assert.equal(current.display === basis.display, true, 'paint retry retains the exact logical display');
        assert.equal(current.charge === basis.charge, true, 'paint retry retains the logical charge');
      }
    }
    return accepted;
  };
  let native: ReturnType<typeof observeLazyFileCallbacks> | undefined;
  try {
    const tool = f.tool('read', { path: 'paint-retry.txt' }, createReadToolDefinition('/tmp')); target = tool;
    tool.updateResult({ content: [{ type: 'text', text: resultText }], isError: false }, false);
    const beforeRefusalRequests = f.ui.requests;
    tool.setExpanded(true); await settled();
    native = observeLazyFileCallbacks(tool);
    const refused = plain(f.render(tool, 60)).join('\n'); await settled();
    const stableRequests = f.ui.requests;
    const sourceWork = () => ({ ...work.snapshot(), requests: f.calls.length, pi: f.env.pi.length, observes: f.env.observes, styles: f.env.styleRequests.length });
    const stableWork = sourceWork();
    assert.equal(f.ui.requests, beforeRefusalRequests + 1, 'the first actual refusal requests one status frame');
    assert.ok(acceptedFullInputs > 0, 'the logical saved read was accepted despite refusal');
    assert.ok(probe.snapshot().deniedPreparationBytes > 0, `the actual ${refusal} grant was denied`);
    assert.match(refused, /unavailable within the current\s+preparation\s+or\s+paint\s+budget/u);
    assert.ok(!refused.includes(marker), 'unpainted text is not exposed through a plain fallback');
    assert.deepEqual(native.calls, { call: 0, result: 0 });
    for (let i = 0; i < 3; i++) { f.render(tool, 60); await settled(); }
    assert.equal(f.ui.requests, stableRequests, 'unchanged refusal cannot create a frame loop');
    assert.deepEqual(sourceWork(), stableWork, 'repeated refusal does no source or measurement work');

    if (refusal === 'palette') {
      probe.paletteOnly(); f.render(tool, 60); await settled();
      assert.match(plain(f.render(tool, 60)).join('\n'), /unavailable within the current\s+preparation\s+or\s+paint\s+budget/u);
      assert.equal(f.ui.requests, stableRequests, 'palette-only recovery does not announce usable paint');
      assert.deepEqual(sourceWork(), stableWork, 'partially recovered paint preserves source work');
    }
    probe.recover(); denyLayout = true;
    f.render(tool, 60); await settled();
    assert.equal(f.ui.requests, stableRequests + 1, 'first usable paint requests one recovery frame');
    const geometryRefused = plain(f.render(tool, 60)).join('\n'); await settled();
    assert.match(geometryRefused, /unavailable within the current\s+preparation or geometry budget/u);
    for (let i = 0; i < 3; i++) { f.render(tool, 60); await settled(); }
    assert.equal(f.ui.requests, stableRequests + 1, 'continued geometry refusal does not rearm the refusal notification');
    denyLayout = false;
    const recovered = plain(f.render(tool, 60)).join('\n'); await settled();
    assert.ok(recovered.includes(resultText), `same expanded read recovers from saved data: ${recovered}`);
    assert.equal(probe.snapshot().deniedLogicalBytes, 0, 'recovery requests no duplicate logical construction grant');
    assert.deepEqual(sourceWork(), stableWork, 'recovery does not remeasure or request source/style work');
    assert.deepEqual(native.calls, { call: 0, result: 0 });

    const stock = fixture(false, false, { cards: ['read'] });
    const stockTool = stock.tool('read', { path: 'paint-retry.txt' }, createReadToolDefinition('/tmp'));
    stockTool.updateResult({ content: [{ type: 'text', text: resultText }], isError: false }, false); stockTool.setExpanded(true); await settled();
    const positive = observeLazyFileCallbacks(stockTool);
    try {
      stock.render(stockTool, 60);
      assert.ok(positive.calls.call > 0 && positive.calls.result > 0, 'native control invokes both current stock callbacks');
    } finally { positive.restore(); stock.adapter.restore(); }
  } finally {
    denyLayout = false; probe.allow();
    CardSources.prototype.updateDisplay = updateDisplay;
    probe.restore(); native?.restore(); work.restore();
  }
});

test('a read replacement during paint refusal recovers the latest saved result', async () => {
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.enabled = false; await f.sources.setEnabled(false);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  const previous = 'const READ_BEFORE_PAINT_REFUSAL = 1;', latest = 'const READ_REPLACED_DURING_REFUSAL = 2;';
  const probe = paintFundingProbe(f, 'paint'), updateDisplay = CardSources.prototype.updateDisplay;
  let target: object | undefined, acceptedInputs = 0;
  CardSources.prototype.updateDisplay = function (owner, input) {
    const accepted = updateDisplay.call(this, owner, input);
    if (accepted && owner === target && input.kind === 'file') acceptedInputs++;
    return accepted;
  };
  let native: ReturnType<typeof observeLazyFileCallbacks> | undefined;
  try {
    const tool = f.tool('read', { path: 'paint-replacement.txt' }, createReadToolDefinition('/tmp')); target = tool;
    tool.updateResult({ content: [{ type: 'text', text: previous }], isError: false }, false);
    tool.setExpanded(true); await settled();
    native = observeLazyFileCallbacks(tool);
    const refused = plain(f.render(tool, 60)).join('\n'); await settled();
    assert.ok(acceptedInputs > 0, 'the first saved input was logically accepted');
    assert.ok(probe.snapshot().deniedPreparationBytes > 0, 'actual compiled paint funding was refused');
    assert.match(refused, /unavailable within the current\s+preparation\s+or\s+paint\s+budget/u);
    const beforeReplacement = acceptedInputs;
    const replacement = { content: [{ type: 'text' as const, text: latest }], isError: false };
    tool.updateResult(replacement, false);
    const savedReplacement = tool.result;
    f.render(tool, 60); await settled();
    assert.ok(acceptedInputs > beforeReplacement, 'the replacement reaches real logical admission while paint is refused');
    assert.match(plain(f.render(tool, 60)).join('\n'), /unavailable within the current\s+preparation\s+or\s+paint\s+budget/u);
    probe.recover(); f.render(tool, 60); await settled();
    const recovered = plain(f.render(tool, 60)).join('\n');
    assert.ok(recovered.includes(latest), `recovery must show the current saved result: ${recovered}`);
    assert.ok(!recovered.includes(previous), 'the obsolete accepted input must not reappear');
    assert.equal(tool.expanded, true, 'replacement and recovery do not toggle expansion');
    assert.equal(tool.result === savedReplacement, true, 'recovery does not replace the host result');
    assert.deepEqual(tool.result?.content, replacement.content, 'the saved replacement text remains exact');
    assert.equal(probe.snapshot().deniedLogicalBytes, 0, 'paint recovery does not construct the accepted replacement again');
    assert.deepEqual(native.calls, { call: 0, result: 0 });
    probe.allow();
    const stockRows = plain(nativeToolRender.call(tool, 60)).join('\n');
    assert.ok(stockRows.includes(latest), 'the same current generation has a real native saved-result positive');
    assert.ok(native.calls.call > 0 && native.calls.result > 0, 'both replacement-generation stock callbacks are observable');
  } finally {
    probe.allow(); CardSources.prototype.updateDisplay = updateDisplay;
    probe.restore(); native?.restore();
  }
});

test('host completed Follow Pi Bash card keeps its custom presentation after native Off', async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'x' }); tool.setArgsComplete();
  f.render(tool); await settled(); assert.equal(f.calls.length, 1);
  answer(f, 0, 'x'); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'x'), 'native classification was displayed');
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  const rows = f.render(tool);
  assert.deepEqual(plain(rows), plain(renderBashCard(tool, undefined, 60, themes.theme).rows), 'Off removes classification, not the custom Bash card');
  assert.equal(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'x'), false);
  assert.equal(f.env.pi.length, 0);
});

for (const extra of [true, false]) test(`host frozen Bash recolors its retained display ${extra ? 'when a newer parsed context never published' : '(control: no newer context)'}`, async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'echo a' });
  f.render(tool); await settled(); answer(f, 0, 'echo a', false, 0); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'echo a'), 'V1 ready display');
  const key = f.env.keys[0]!;
  // V2 parses one additional context whose STYLE remains unpublished.
  f.env.holdStyles = true;
  tool.updateArgs({ command: 'echo a b' }); f.render(tool); await settled();
  const append = f.calls[1]!, r = append.request; assert.equal(r.op, 'stream.append');
  append.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: r.key, generation: r.generation, source_version: r.source_version,
      revision: (r.base_revision as number) + 1, replace_from: 0, source_bytes: 8, committed_bytes: 0, complete: false, lease: 'lease',
      contexts: extra ? [[0, 1], [0, 2]] : [[0, 1]], runs: extra ? [6, 1, 2, 2] : [8, 1], counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 8 } }] } });
  await settled(); assert.equal(f.styleCalls.length, extra ? 1 : 0, 'only a new V2 context needs held STYLE');
  // Live interruption freezes the retained V1 display.
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool); await settled();
  for (const call of f.calls.slice(2)) if (call.request.op === 'stream.close')
    call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  await settled();
  const sources = f.calls.length, styleRequests = f.env.styleRequests.length;
  f.env.holdStyles = false;
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.calls.length, sources, 'recoloring frozen scopes needs no SOURCE');
  assert.equal(f.env.styleRequests.length, styleRequests, 'palette changes do not dispatch another generic STYLE request');
  assert.equal(f.sources.displayBasis(key)?.palette, 'theme:gruvbox-dark:owned-palette-v1:gruvbox-dark:truecolor', 'frozen display publishes the selected palette identity');
});

for (const occupied of [true, false]) test(`host rollback to a cached owned palette ${occupied ? 'does not wait for both occupied DATA credits' : '(control: free credits)'}`, async () => {
  const f = fixture(true), first = { id: 'gruvbox-dark' }, second = { id: 'nord-dark' };
  const select = async (theme: typeof first) => { f.env.selected = palettePreference(theme.id); f.adapter.syntaxMetadataChanged(); await settled(); };
  await select(first);
  const tool = written(f, 'const rollback = 1;'); f.render(tool); await settled();
  answer(f, 0, 'const rollback = 1;'); await settled(); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  assert.equal(f.sources.displayBasis(key)?.palette, `theme:${first.id}:owned-palette-v1:${first.id}:truecolor`);
  await select(second); f.render(tool); await settled();
  f.render(tool); await settled();
  assert.equal(f.sources.displayBasis(key)?.palette, `theme:${second.id}:owned-palette-v1:${second.id}:truecolor`);
  if (occupied) {
    for (const command of ['echo held-one', 'echo held-two']) { const held = f.tool('bash', { command }); held.setArgsComplete(); f.render(held); }
    await settled(); assert.equal(f.calls.length, 3, 'both physical DATA credits are held by unrelated source work');
  }
  const styles = f.env.styleRequests.length, sources = f.calls.length;
  await select(first); f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.env.styleRequests.length, styles, 'the revisited theme is fully cached');
  assert.equal(f.calls.length, sources);
  assert.equal(f.sources.displayBasis(key)?.palette, `theme:${first.id}:owned-palette-v1:${first.id}:truecolor`, 'cached rollback publishes before unrelated work settles');
});

test('host Bash fallback stays full-command toolTitle with zero Pi during startup off and no-start', async () => {
  for (const mode of ['startup', 'off', 'no-start'] as const) {
    const f = fixture(mode === 'no-start');
    if (mode === 'off') { f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); }
    const tool = f.tool('bash', { command: 'a\tb\nc' }); tool.setArgsComplete();
    const cold = f.render(tool); await settled();
    if (mode === 'no-start') { fault(f, 0); await settled(); }
    assert.deepEqual(f.render(tool), cold);
    assert.deepEqual(plain(cold), plain(renderBashCard(tool, undefined, 60, themes.theme).rows));
    assert.equal(f.env.pi.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0);
    f.adapter.restore();
  }
});

test('host keyed notices retire only affected layout while metadata upgrades every useful file owner', async () => {
  const f = fixture(), a = written(f, 'a'), b = written(f, 'b');
  f.render(a); f.render(b); await settled(); f.render(a); f.render(b);
  const before = f.adapter.cacheStats();
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => (call.request.sources as { text: string }[])[0]!.text), ['b', 'a']);
  f.render(b); const built = f.adapter.cacheStats().builds;
  answer(f, 0, 'b'); await settled();
  assert.equal(f.adapter.cacheStats().entries, before.entries, 'atomic repaint retains the accepted detached entry until replacement');
  f.render(a); assert.equal(f.adapter.cacheStats().builds, built, 'peer layout remains warm');
  f.render(b); assert.equal(f.adapter.cacheStats().builds, built + 1);
  answer(f, 1, 'a'); await settled();
  f.render(b); assert.equal(f.adapter.cacheStats().builds, built + 1, 'the already completed peer remains warm');
  f.render(a); assert.equal(f.adapter.cacheStats().builds, built + 2, 'the older file publishes its own semantic result');
  assert.equal(f.calls.length, 2, 'each file receives SOURCE once');
  assert.equal(f.env.pi.length, 2);
});

test('same-object image invalidation relinquishes a previously owned file card to the native renderer', () => {
  const f = fixture(), tool = written(f, 'IMAGE_GUARD_SOURCE');
  const owned = plain(f.render(tool)); assert.ok(owned.some(row => row.includes('← Write')));
  const native = plain(nativeToolRender.call(tool, 60));
  tool.result!.content.push({ type: 'image' }); tool.invalidate();
  assert.deepEqual(plain(f.render(tool)), native);
});

test('host hidden/self-empty/image/compact/native/expanded files never authorize work; stock edit probe exemption remains', async () => {
  const f = fixture(false, false, { cards: ['write'] }), watch = watchConsumer(f);
  try {
    const hidden = written(f, 'h'); hidden.hideComponent = true;
    const expanded = written(f, 'e'); expanded.setExpanded(true);
    const image = written(f, 'i'); image.result.content.push({ type: 'image' });
    const malformed = written(f, 'm'); malformed.updateResult({ content: [], details: { diff: 'bad' } }, false);
    const partial = f.tool('write', { path: 'a.ts', content: 'partial' });
    const empty = f.tool('bash', { command: 'empty' }, { name: 'bash', renderShell: 'self', renderCall: () => new Text('', 0, 0), renderResult: () => new Text('', 0, 0) });
    for (const tool of [hidden, expanded, image, malformed, partial, empty]) f.render(tool);
    await settled(); assert.deepEqual(watch.counts().filter((_v, i) => i !== 5), [0, 0, 0, 0, 0, 0]);
    const stock = f.tool('edit', { path: 'a.ts', oldText: 'x', newText: 'y' }, createEditToolDefinition('/tmp'));
    stock.updateResult({ content: [], details: { diff: '-1 x\n+1 y' } }, false);
    f.render(stock); await settled(); assert.deepEqual(f.env.pi, ['x', 'y']);
  } finally { watch.restore(); }
});

test('host pause preserves held-work veto; remove/clear/restore release source ownership and queued work', async () => {
  const f = fixture(true), tool = written(f, 'x'); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  tool.hideComponent = true; f.render(tool);
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.sources.workStatus(key).fallbackEligible, false); assert.equal(f.env.pi.length, 0);
  f.sources.ownedStopped(1); await settled(); assert.equal(f.env.pi.length, 0);
  tool.hideComponent = false; f.render(tool); await settled(); assert.deepEqual(f.env.pi, ['x']);
  f.ui.removeChild(tool); assert.equal(f.sources.borrowPiSource(key), undefined);
  const pending = written(f, 'pending'); f.render(pending); f.ui.clear(); await settled(); assert.deepEqual(f.env.pi, ['x']);
  const live = written(f, 'live'); f.render(live); await settled(); assert.equal(f.sources.stats().piSourceRecords, 1);
  f.adapter.restore(); assert.equal(f.sources.stats().piSourceRecords, 0);
  const before = counts(f); f.adapter.syntaxSourceChanged([key]); f.adapter.syntaxMetadataChanged(); await settled(); assert.deepEqual(counts(f), before);
});

test('host reentrant classification removal cannot publish source or resurrect a node', async () => {
  const f = fixture(), tool = written(f, 'x');
  const capture = f.sources.capturePiSource.bind(f.sources);
  f.sources.capturePiSource = (...args) => { f.ui.removeChild(tool); return capture(...args); };
  f.render(tool); await settled(); assert.equal(f.sources.stats().piSourceRecords, 0);
  assert.equal(f.adapter.cacheStats().entries, 0);
});

async function firstOwner(f: ReturnType<typeof fixture>) {
  const group = new Container(), tool = written(f, 'first');
  // Deliberate public-tree disappearance without patched removal: weak ownership must still collect.
  f.ui.children.splice(f.ui.children.indexOf(tool), 1); group.addChild(tool); f.ui.addChild(group);
  f.render(tool); await settled();
  const key = f.env.keys[0]!;
  f.ui.children.splice(f.ui.children.indexOf(group), 1);
  return { weak: new WeakRef(tool), group: new WeakRef(group), key };
}
test('host first active native source installer collects with adapter/controller/pending peer live', { skip: !global.gc }, async () => {
  const f = fixture(true), first = await firstOwner(f), peer = written(f, 'peer'); f.render(peer); await settled();
  assert.equal(f.calls.length, 2); assert.ok(f.sources.borrowSource(first.key));
  let collected = false;
  for (let i = 0; i < 40; i++) { await settled(); global.gc!(); await settled(); if (!first.weak.deref() && !first.group.deref()) { collected = true; break; } }
  assert.equal(collected, true); await settled(); assert.equal(f.sources.borrowSource(first.key), undefined);
  assert.equal(f.sources.stats().sourceRecords, 1); assert.equal(f.env.pi.length, 0);
});

test('host real public Pi colors plus bare Pi font styles survive exact toolOutput neutral projection', async () => {
  const f = fixture(); f.env.boldPi = true;
  const tool = written(f, 'unclassified + 1;\nconst x = "s";');
  tool.setExpanded(true);
  f.render(tool); await settled();
  const expected = fileCardOracle(tool, '/tmp', 60, themes.theme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
  const rows = f.render(tool);
  assert.deepEqual(plain(rows), plain(expected.rows));
  assert.ok(rows.join('').includes('\x1b[1m'), 'bare public Pi bold is not discarded when foreground is neutral');
  assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'const', true));
});


test('host useful tickets count owned full/preview renders, not measurement, mouse or native visits', async () => {
  const f = fixture(), file = written(f, 'x'), shell = f.tool('bash', { command: 'x' });
  const useful = CardSources.prototype.useful;
  let demands = 0;
  CardSources.prototype.useful = function (...args) { demands++; assert.equal(f.env.depth, 1); return useful.apply(this, args); };
  try {
    file.setExpanded(true); f.render(file); assert.equal(demands, 1, 'the owned full file is a rendered presentation');
    file.setExpanded(false); f.render(file); assert.equal(demands, 2, 'the bounded preview is also a rendered presentation');
    f.render(shell); assert.equal(demands, 3);
    file.handleMouse({ type: 'move', width: 60, height: 8, x: 0, y: 0 });
    assert.equal(demands, 3, 'mouse movement is not a useful render');
    nativeToolRender.call(file, 60); assert.equal(demands, 3, 'direct native rendering is not a card demand');
    f.render(shell, 0); assert.equal(demands, 3);
    file.hideComponent = true; f.render(file); assert.equal(demands, 3);
  } finally { CardSources.prototype.useful = useful; }
  await settled(); assert.equal(f.env.pi.length, 0, 'paused owners cancel pending preparation');
});

test('host default classifier uses explicit public file language outside render and no-client adapter is unchanged', async () => {
  const f = fixture(false, true), tool = written(f, 'const value = 1;');
  tool.setExpanded(true);
  const cold = f.render(tool); await settled();
  assert.equal(f.env.captures, 1); const warm = f.render(tool);
  assert.deepEqual(plain(warm), plain(cold)); assert.ok(await hasHostInk(warm, themes.theme, 'syntaxKeyword', 'const'));
  f.adapter.restore();
  const native = installTidyUi(f.ui, () => themes.theme);
  try {
    assert.equal(native.active, true, native.reason);
    tool.render(60); await settled();
    assert.deepEqual(plain(tool.render(60)), plain(fileCardOracle(tool, '/tmp', 60, themes.theme,
      (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows));
    assert.equal(await hasHostInk(tool.render(60), themes.theme, 'syntaxKeyword', 'const'), true);
    assert.equal(await hasHostInk(tool.render(60), themes.theme, 'toolOutput', 'value'), true, 'literal neutral code uses the prepared card role, not Pi ANSI default reset');
    native.syntaxMetadataChanged(); native.syntaxSourceChanged([]);
    assert.deepEqual(f.env.pi, []);
  } finally { native.restore(); }
});

test('host palette generations and same-object file metadata mutate only current source, never stdout/diagnostics', async () => {
  const f = fixture(), tool = written(f, 'const x = 1;');
  f.render(tool); await settled(); assert.equal(f.env.pi.length, 1);
  const before = sourceCounts(f);
  tool.updateArgs({ ...tool.args }); tool.updateResult({ ...tool.result, isError: undefined, details: { diagnostics: [] } }, false);
  f.render(tool); await settled(); assert.deepEqual(sourceCounts(f), before);
  f.env.palette++; f.render(tool); await settled(); assert.equal(f.env.pi.length, 2);
  tool.args.content = 'const y = 2;'; tool.updateArgs(tool.args); f.render(tool); await settled();
  assert.deepEqual(f.env.pi, ['const x = 1;', 'const x = 1;', 'const y = 2;']);
  tool.result.details = { diff: '+1 const z = 3;' }; tool.updateResult(tool.result, false); f.render(tool); await settled();
  assert.equal(f.env.pi.at(-1), 'const z = 3;');
});

test('host native complete-line prefix remains colored while appended tail waits; exact geometry/model bytes stay unchanged', async () => {
  const f = fixture(true), args = { command: 'x\r\n' }, tool = f.tool('bash', args);
  f.render(tool); await settled(); answer(f, 0, 'x\n', false); await settled();
  args.command = 'x\r\n\ty 👩‍💻 é'; tool.updateArgs(args); const immediate = f.render(tool); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.op, 'stream.append');
  const rows = f.render(tool);
  assert.deepEqual(plain(rows), plain(immediate));
  assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'x'));
  assert.ok(await hasHostInk(rows, themes.theme, 'toolTitle', '        y 👩‍💻 é'));
  assert.deepEqual(plain(rows), plain(renderBashCard(tool, undefined, 60, themes.theme).rows));
  const before = counts(f);
  for (const width of [24, 60, 121]) f.render(tool, width);
  await settled(); assert.deepEqual(counts(f), before);
  assert.equal(tool.args, args); assert.equal(tool.args.command, 'x\r\n\ty 👩‍💻 é'); assert.equal(f.env.pi.length, 0);
});


test('host explicit compact/native overrides never admit file or Bash source work', async () => {
  for (const options of [{ compact: ['write', 'bash'] }, { cards: ['write', 'bash'] }]) {
    const f = fixture(true, false, options), file = written(f, 'x'), shell = f.tool('bash', { command: 'x' });
    f.render(file); f.render(shell); await settled();
    assert.deepEqual(counts(f).slice(0, 3), [0, 0, 0]); assert.equal(f.calls.length, 0);
    f.adapter.restore();
  }
});


test('P0 host unsupported temporary diff without intervening render preserves same-key veto until actual ownedStopped', async () => {
  const f = fixture(true), tool = written(f, 'x');
  f.render(tool); await settled();
  const key = f.env.keys[0]!;
  assert.equal(f.calls.length, 1); assert.equal(f.sources.stats().globalUnsettledJobs, 1);
  assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  // Completion queues deferred preparation, but no frame probes the unsupported diff.
  tool.updateResult({ content: [], isError: false, details: { diff: 'bad' } }, false);
  await settled();
  assert.equal(f.sources.workStatus(key).fallbackEligible, false, 'old job evidence survives unsupported presentation');
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  tool.updateResult({ content: [], isError: false }, false); f.render(tool); await settled();
  assert.equal(f.env.pi.length, 0, 'no duplicate Pi BEFORE ownedStopped authority');
  assert.deepEqual(f.env.capturedKeys, []);
  assert.equal(f.calls.length, 1); assert.equal(f.sources.stats().globalUnsettledJobs, 1);
  assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  f.sources.ownedStopped(1); await settled(); f.render(tool); await settled();
  assert.deepEqual(f.env.pi, ['x']); assert.deepEqual(f.env.capturedKeys, [key]);
  const before = counts(f); f.render(tool); await settled(); assert.deepEqual(counts(f), before);
});

test('P0 host supplied source becomes invalid at deferred boundary without render and keeps original held key', async () => {
  const f = fixture(true), tool = written(f, 'x'); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  tool.updateArgs({ path: 'a.ts', content: 'y' });
  tool.args.content = undefined; // The queued visit must read this current native argument, not a retained packet.
  await settled();
  assert.equal(f.calls.length, 1); assert.equal(f.sources.workStatus(key).fallbackEligible, false);
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  tool.updateArgs({ path: 'a.ts', content: 'x' }); f.render(tool); await settled();
  assert.equal(f.env.pi.length, 0, 'deferred-invalid input must not manufacture a new fallback key');
  assert.equal(f.sources.stats().globalUnsettledJobs, 1); assert.deepEqual(f.env.capturedKeys, []);
  f.sources.ownedStopped(1); await settled();
  assert.deepEqual(f.env.pi, ['x']); assert.deepEqual(f.env.capturedKeys, [key]);
});

test('P1 host fixture installs actual self-empty renderer identities and denies every useful/preparation event', async () => {
  const f = fixture(true), watch = watchConsumer(f);
  try {
    const definition = { name: 'bash', renderShell: 'self', renderCall: () => new Text('', 0, 0), renderResult: () => new Text('', 0, 0) };
    const tool = f.tool('bash', { command: 'x' }, definition);
    assert.equal(tool.getCallRenderer(), definition.renderCall);
    assert.equal(tool.getResultRenderer(), definition.renderResult);
    assert.equal(tool.getRenderShell(), 'self'); assert.equal(tool.hideComponent, false);
    assert.deepEqual(nativeToolRender.call(tool, 60), [], 'actual native rows are empty, not just hideComponent');
    const before = watch.counts();
    assert.deepEqual(f.render(tool), []); f.document(); await settled();
    assert.deepEqual(watch.counts(), before);
    assert.deepEqual(before.filter((_v, i) => i !== 5), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(f.env.keys, []); assert.deepEqual(f.env.capturedKeys, []);
  } finally { watch.restore(); }
});

test('P1 injected stock edit is the actual stock self-shell Box and skips all native visibility probes', async t => {
  const native = t.mock.method(ToolExecutionComponent.prototype, 'render');
  const nativeBoxRender = t.mock.method(Box.prototype, 'render');
  const f = fixture(), watch = watchConsumer(f);
  try {
    const definition = createEditToolDefinition('/tmp');
    const resolved = resolvePublicFileToolDefinition('edit', definition, '/tmp') as typeof definition;
    const tool = f.tool('edit', { path: 'a.ts', oldText: 'x', newText: 'y' }, definition);
    assert.equal(isDeferredStockFileCall(tool.getCallRenderer()), true);
    assert.equal(isDeferredStockFilePair(tool.getCallRenderer(), tool.getResultRenderer()), true);
    assert.equal(isDeferredStockFilePair(resolved.renderCall, resolved.renderResult), true);
    assert.equal(tool.getRenderShell(), 'self'); assert.equal(tool.hideComponent, false);
    assert.ok(isDeferredStockEditComponent(tool.callRendererComponent), 'the host stores a lazy edit delegate, not an eager native Box');
    assert.ok(nativeToolRender.call(tool, 60).length > 0, 'native invocation materializes visible stock output');
    assert.ok(nativeBoxRender.mock.calls.some(call => call.this instanceof Box), 'deferred stock rendering invokes the actual native Box');
    tool.updateResult({ content: [], details: { diff: '-1 x\n+1 y' } }, false);
    f.render(tool); await settled();
    assert.deepEqual(f.env.pi, ['x', 'y']);
    assert.deepEqual(watch.counts().filter((_v, i) => i !== 5), [1, 1, 2, 0, 2, 0]);
    const prepared = watch.counts();
    await settled(); // Finish the one-shot host-yield barrier before warm measurements.
    assert.deepEqual(watch.counts(), prepared, 'an empty controller continuation does not revisit card preparation');
    const before = watch.counts().slice(1);
    for (const width of [24, 60, 121]) f.render(tool, width);
    tool.handleMouse({ type: 'move', width: 60, height: 8, x: 0, y: 0 });
    await settled(); assert.deepEqual(watch.counts().slice(1), before);
    assert.equal(native.mock.calls.length, 0, 'injected stock Box exception does not discard native renders');
  } finally { watch.restore(); f.adapter.restore(); }
});

// Full presentation reinstallation deliberately ends its source-owner incarnation.
// A rare repeat is accepted; ordinary warm frames and same-adapter off remain strict.
test('a non-owning outer host wrapper delegates mouse without rendering the inner owner', async t => {
  const first = fixture(), tool = written(first, 'const MOUSE_OWNER = 1;');
  tool.setExpanded(true); first.render(tool); await settled();
  const firstMouse = ToolExecutionComponent.prototype.handleMouse;
  const previousRender = t.mock.method(ToolExecutionComponent.prototype, 'render');
  const useful = CardSources.prototype.useful; let usefulCalls = 0;
  CardSources.prototype.useful = function (...args) { usefulCalls++; return useful.apply(this, args); };
  const second = fixture(); second.tool('read', { path: 'outer-root-trigger.ts' });
  try {
    assert.notEqual(ToolExecutionComponent.prototype.handleMouse, firstMouse, 'the second adapter adds the outer mouse wrapper');
    previousRender.mock.resetCalls();
    assert.equal(tool.handleMouse({ type: 'move', width: 60, height: 8, x: 0, y: 0 }), undefined);
    await settled();
    assert.equal(previousRender.mock.calls.length, 0, 'the outer non-owner does not render through the inner adapter');
    assert.equal(usefulCalls, 0, 'delegated mouse movement does not create file preparation demand');
  } finally {
    second.adapter.restore(); previousRender.mock.restore();
    CardSources.prototype.useful = useful; first.adapter.restore();
  }
});

test('host full reinstall may repeat file highlighting with an old native request unsettled, then remains warm and rejects its late colors', async () => {
  const f = fixture(true), tool = written(f, 'x');
  const args = JSON.stringify(tool.args), result = JSON.stringify(tool.result);
  f.render(tool); await settled();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.env.pi, []);
  const oldKey = f.env.keys[0]!;
  f.env.enabled = false; f.sources.setEnabled(false);
  f.reinstall();
  const cold = f.render(tool);
  assert.deepEqual(f.env.pi, [], 'reinstall does not classify inside render');
  await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 1);
  assert.equal(f.sources.workStatus(oldKey).fallbackEligible, false, 'old work is not fabricated as stopped');
  assert.deepEqual(f.env.pi, ['x'], 'one repeated classification is allowed for the new adapter');
  assert.equal(f.calls.length, 1, 'reinstallation did not send another native request while disabled');
  const newKey = f.env.capturedKeys[0]!;
  assert.notEqual(newKey, oldKey);
  const warm = f.render(tool), before = counts(f);
  assert.deepEqual(plain(warm), plain(cold));
  for (const width of [24, 60, 121, 60]) f.render(tool, width);
  f.document(); await settled(); assert.deepEqual(counts(f), before);
  answer(f, 0, 'x'); await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  assert.equal(f.sources.status(oldKey), undefined);
  assert.deepEqual(f.render(tool), warm, 'old-owner native colors cannot replace the current Pi result');
  await settled(); assert.deepEqual(counts(f), before);
  assert.equal(JSON.stringify(tool.args), args); assert.equal(JSON.stringify(tool.result), result);
});

test('host full reinstall keeps Bash fallback toolTitle without any Pi classification', async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'x' });
  f.render(tool); await settled(); assert.equal(f.calls.length, 1);
  f.env.enabled = false; f.sources.setEnabled(false); f.reinstall();
  const cold = f.render(tool); await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 1);
  assert.deepEqual(f.env.pi, []); assert.equal(f.env.captures, 0);
  const warm = f.render(tool), before = counts(f);
  assert.deepEqual(warm, cold);
  answer(f, 0, 'x', false); await settled();
  assert.deepEqual(f.render(tool), warm);
  await settled(); assert.deepEqual(counts(f), before);
  assert.deepEqual(f.env.pi, []); assert.equal(f.env.captures, 0);
});

for (const held of [false, true]) test(`host incomplete Bash terminal error retires ${held ? 'pending' : 'settled'} source and does not readmit on warm frames`, async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'x\n' });
  f.render(tool); await settled(); assert.equal(f.calls.length, 1);
  if (!held) { answer(f, 0, 'x\n', false); await settled(); assert.equal(f.sources.stats().remoteLeases, 1); }
  const peer = written(f, 'y'); f.render(peer); await settled();
  assert.equal(f.calls[1]!.request.op, 'highlight'); answer(f, 1, 'y'); await settled();
  const peerRows = f.render(peer), peerBuilds = f.adapter.cacheStats().builds;
  tool.updateResult({ content: [{ type: 'text', text: 'Operation aborted' }], isError: true }, false);
  assert.equal(tool.getRenderContext().argsComplete, false, 'abort does not simulate argument finalization');
  assert.equal(tool.executionStarted, false);
  assert.equal(f.sources.stats().sourceRecords, 2, 'the retired source keeps one budgeted display/work-authority record beside the peer');
  if (held) {
    assert.equal(f.calls.length, 2); assert.equal(f.sources.stats().unsettledJobs, 1, 'cancel is not physical completion');
    answer(f, 0, 'x\n', false);
  }
  await settled(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2]!.request.op, 'stream.close');
  const close = f.calls[2]!;
  close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  await settled();
  assert.equal(f.sources.stats().remoteLeases, 0); assert.equal(f.sources.stats().pendingCloses, 0);
  assert.equal(f.sources.stats().unsettledJobs, 0); assert.equal(f.sources.stats().retention.entries, held ? 1 : 2,
    'settled colors remain charged; an aborted pending result cannot publish late colors');
  assert.deepEqual(f.render(peer), peerRows); assert.equal(f.adapter.cacheStats().builds, peerBuilds, 'peer layout remains warm');
  const before = counts(f);
  for (const width of [24, 60, 100]) f.render(tool, width);
  f.document(); tool.invalidate(); f.render(tool); await settled();
  assert.deepEqual(counts(f), before, 'aborted source is not reopened by rows or invalidation');
  assert.equal(f.env.pi.length, 0); assert.equal(f.sources.stats().sourceRecords, 2);
});

test('host partial Bash errors do not retire forming args and completed argument errors preserve cached syntax', async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'x\n' });
  f.render(tool); await settled(); answer(f, 0, 'x\n', false); await settled();
  tool.updateResult({ content: [{ type: 'text', text: 'partial error' }], isError: true }, true);
  f.render(tool); await settled();
  assert.equal(f.sources.stats().sourceRecords, 1); assert.equal(f.sources.stats().remoteLeases, 1);
  assert.equal(f.calls.length, 1, `partial result is not terminal argument abandonment: ${JSON.stringify(f.calls.map(call => ({ op: call.request.op, final: call.request.final })))}`);
  tool.setArgsComplete(); await settled(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.request.op, 'stream.append'); assert.equal(f.calls[1]!.request.final, true);
  answer(f, 1, 'x\n'); await settled(); assert.equal(f.sources.stats().remoteLeases, 0);
  tool.updateResult({ content: [{ type: 'text', text: 'execution error' }], isError: true }, false);
  f.render(tool); await settled();
  assert.equal(f.sources.stats().sourceRecords, 1); assert.equal(f.sources.stats().retention.entries, 1);
  assert.equal(f.calls.length, 2, 'completed args retain syntax on execution failure');
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'x'));
  assert.equal(f.env.pi.length, 0);
});


test('logging actual SDK final paint separates cached plain Pi, waiting file, native result and neutral Bash without extra warm work or I/O', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-logging-host-'));
  const journal = new TextJournal({ session: 'actual-sdk', cwd: root, reason: 'startup', extension: '0.0.0', pi: VERSION }, { root });
  t.after(async () => { await journal.close('test'); await fs.rm(root, { recursive: true, force: true }); });
  await journal.ready;
  const f = fixture(false, false, { diagnostic: journal.sink });
  f.env.plainPi = true;
  const text = 'const PRIVATE_FILE_BODY = 17;', shell = 'printf PRIVATE_SHELL_BODY\n';
  const file = written(f, text, 'probe.unknown'), bash = f.tool('bash', { command: shell });
  const args = JSON.stringify(file.args), result = JSON.stringify(file.result);
  f.document(); await settled(); const initial = f.document(); await journal.flush();
  const before = { counts: counts(f), builds: f.adapter.cacheStats().builds, logger: journal.status() };
  assert.equal(before.counts[0], 1); assert.equal(before.counts[4], 0);
  assert.ok(before.logger.records > 0); assert.ok(before.logger.writes > 0);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.document(), initial);
  await settled(); await journal.flush();
  assert.deepEqual(counts(f), before.counts); assert.equal(f.adapter.cacheStats().builds, before.builds);
  for (const key of ['records', 'writes', 'scans', 'rotations', 'pendingBytes', 'inFlightBytes', 'timer'] as const)
    assert.equal(journal.status()[key], before.logger[key], key);
  let body = await fs.readFile(journal.status().path, 'utf8');
  assert.match(body, /call=host-write.*selected=plain-pi/); assert.match(body, /Pi returned plain text/);
  assert.match(body, /call=host-bash.*selected=toolTitle/);
  assert.equal(body.includes(text), false); assert.equal(body.includes(shell), false); assert.equal(body.includes('text=saved'), false);
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.env.pi.length, 1, 'Bash and the cached file start native without another Pi classification');
  const cachedFile = f.calls.findIndex(call => call.request.op === 'highlight'); assert.ok(cachedFile >= 0);
  answer(f, cachedFile, text); await settled();
  f.document(); const heldFile = written(f, 'const PRIVATE_HELD_BODY = 18;');
  f.document(); await settled(); assert.equal(f.calls.length, 3);
  const waiting = f.render(heldFile); await journal.flush();
  body = await fs.readFile(journal.status().path, 'utf8');
  assert.match(body, /Native work is queued, unsettled or uncertain; full text shown without duplicate Pi classification/);
  assert.equal(f.env.pi.length, 1); assert.equal(body.includes('PRIVATE_HELD_BODY'), false);
  const shellCall = f.calls.findIndex(call => call.request.op === 'stream.open'); assert.ok(shellCall >= 0);
  answer(f, shellCall, shell, false); answer(f, 2, 'const PRIVATE_HELD_BODY = 18;'); await settled();
  const native = f.render(heldFile); assert.deepEqual(plain(native), plain(waiting)); assert.notDeepEqual(native, waiting);
  f.document(); await journal.flush(); body = await fs.readFile(journal.status().path, 'utf8');
  assert.match(body, /call=host-write.*selected=exact-native/); assert.match(body, /call=host-bash.*selected=historical-native-prefix/);
  const workBeforeWidth = counts(f);
  for (const width of [60, 60, 100, 100, 60]) f.document(width);
  await settled(); await journal.flush(); assert.deepEqual(counts(f), workBeforeWidth);
  const widthBaseline = journal.status(); const builds = f.adapter.cacheStats().builds;
  for (let i = 0; i < 100; i++) f.document(60);
  await settled(); await journal.flush(); assert.equal(f.adapter.cacheStats().builds, builds);
  assert.equal(journal.status().records, widthBaseline.records); assert.equal(journal.status().writes, widthBaseline.writes);
  assert.equal(JSON.stringify(file.args), args); assert.equal(JSON.stringify(file.result), result);
  assert.deepEqual(bash.args, { command: shell });
});

test('logging observer failure cannot change SDK rendering, fallback or native dispatch', async () => {
  const f = fixture(false, false, { diagnostic: () => { throw Error('untrusted diagnostic observer'); } });
  const tool = written(f, 'const x=1;'); const cold = f.render(tool); await settled();
  const fallback = f.render(tool); assert.deepEqual(plain(cold), plain(fallback)); assert.equal(f.env.pi.length, 1);
  const before = counts(f); for (let i = 0; i < 50; i++) f.document(); await settled(); assert.deepEqual(counts(f), before);
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled(); assert.equal(f.calls.length, 1);
  answer(f, 0, 'const x=1;'); await settled(); assert.deepEqual(plain(f.render(tool)), plain(fallback));
  assert.equal(f.env.pi.length, 1); assert.equal(f.sources.status(f.env.keys.at(-1)!)?.exact, true);
});

function firstDiagnosticOwner(f: ReturnType<typeof fixture>) {
  const node = written(f, 'const first=1;'); f.render(node); return new WeakRef(node);
}
test('logging keeps primitive decisions only; active first SDK installer still collects with peer and logger alive', { skip: !global.gc }, async () => {
  assert.equal(typeof global.gc, 'function', 'ownership control requires --expose-gc');
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-first-owner-'));
  const journal = new TextJournal({ session: 'actual-sdk-gc', cwd: '/tmp', reason: 'test', extension: '0.0.0', pi: VERSION }, { root });
  try {
    await journal.ready;
    const packets: { area: string; explanation: string; fields?: DiagnosticFields }[] = [];
    const diagnostic: DiagnosticSink = (level, area, explanation, fields) => {
      for (const value of Object.values(fields ?? {})) assert.ok(value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value));
      packets.push({ area, explanation, fields }); journal.sink(level, area, explanation, fields);
    };
    const f = fixture(false, false, { diagnostic }), first = firstDiagnosticOwner(f);
    await settled(); f.render(written(f, 'const peer=2;')); await settled(); f.ui.clear(); f.render(written(f, 'const live=3;')); await settled();
    await journal.flush(); assert.ok(packets.some(packet => packet.area === 'syntax')); assert.ok(journal.status().writes > 0);
    for (let i = 0; i < 40; i++) { await settled(); global.gc!(); await settled(); }
    assert.equal(first.deref(), undefined); assert.equal(f.adapter.active, true); assert.ok(packets.length > 0);
    assert.equal(journal.status().state, 'active');
  } finally { await journal.close('quit'); await fs.rm(root, { recursive: true, force: true }); }
});


test('logging stream contract: held no-newline Bash retains historical provisional colors without claiming current-source proof', async () => {
  const records: { explanation: string; fields?: DiagnosticFields }[] = [];
  const f = fixture(true, false, { diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
  const bash = f.tool('bash', { command: 'echo a' }); f.render(bash); await settled();
  assert.equal(f.calls.length, 1); answer(f, 0, 'echo a', false, 0); await settled(); f.render(bash);
  bash.updateArgs({ command: 'echo ab' }); f.render(bash); await settled(); const rows = f.render(bash);
  assert.equal(f.calls.length, 2); assert.equal(f.sources.status(f.env.keys.at(-1)!)?.committedBytes, 0);
  assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'echo a'), 'historical provisional colors survive the append');
  assert.ok(await hasHostInk(rows, themes.theme, 'toolTitle', 'b'), 'new characters are neutral');
  assert.equal(f.env.pi.length, 0);
  const painted = records.findLast(record => record.fields?.selected === 'historical-native-prefix');
  assert.ok(painted, 'historical provisional colors are distinct from current-source proof');
  assert.match(painted.explanation, /historical-prefix.*not parser authority/);
  const before = counts(f), builds = f.adapter.cacheStats().builds, length = records.length;
  for (let i = 0; i < 100; i++) assert.deepEqual(f.render(bash), rows);
  assert.deepEqual(counts(f), before); assert.equal(f.adapter.cacheStats().builds, builds); assert.equal(records.length, length);
  assert.equal(records.some(record => record.explanation.includes('prepared native coloring')), false);
});

test('stream contract: first changed frame keeps the provisional prefix and preparation/wait adds no identical rebuild', async () => {
  const f = fixture(true), base = 'echo "old', current = `${base} new`;
  const tool = f.tool('bash', { command: base });
  f.render(tool); const coldBuilds = f.adapter.cacheStats().builds, coldRequests = f.ui.requests;
  await settled();
  f.render(tool);
  assert.equal(f.adapter.cacheStats().builds, coldBuilds, 'Waiting preparation does not rebuild its identical neutral command');
  assert.equal(f.ui.requests, coldRequests, 'Waiting preparation adds no adapter request');
  answer(f, 0, base, false, 0); await settled(); f.render(tool);
  tool.updateArgs({ command: current });
  const first = f.render(tool);
  assert.ok(await hasHostInk(first, themes.theme, 'syntaxKeyword', base), 'Colors survive on the first frame before deferred source preparation');
  assert.ok(await hasHostInk(first, themes.theme, 'toolTitle', ' new'), 'Latest appended text is visible immediately and initially neutral');
  const builds = f.adapter.cacheStats().builds, requests = f.ui.requests;
  await settled();
  assert.deepEqual(f.render(tool), first);
  assert.equal(f.adapter.cacheStats().builds, builds, 'Held native reply/preparation cannot rebuild unchanged painted rows');
  assert.equal(f.ui.requests, requests);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.op, 'stream.append');
  const before = counts(f);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.render(tool), first);
  await settled(); assert.deepEqual(counts(f), before); assert.equal(f.adapter.cacheStats().builds, builds);
  assert.equal(f.env.pi.length, 0);
});

test('stream contract: equal-text finalization completes native authority without a body rebuild or adapter redraw', async () => {
  const diagnostics: unknown[] = [];
  const f = fixture(true, false, { diagnostic: (...event) => diagnostics.push(event) }), text = 'echo done', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled();
  const painted = f.render(tool), builds = f.adapter.cacheStats().builds;
  const originalRequests = f.ui.requests; tool.setArgsComplete();
  assert.equal(f.ui.requests, originalRequests + 1, 'Original public completion setter still owns its redraw');
  assert.deepEqual(f.render(tool), painted);
  await settled(); assert.equal(f.calls[1]!.request.append, ''); assert.equal(f.calls[1]!.request.final, true);
  const requests = f.ui.requests; answer(f, 1, text, true); await settled();
  assert.deepEqual(f.render(tool), painted);
  assert.equal(f.adapter.cacheStats().builds, builds, 'Lifecycle completion without display effect retains the body');
  assert.equal(f.ui.requests, requests, 'Native completion notice without display effect adds no adapter redraw');
  assert.equal(f.sources.stats().unsettledJobs, 0); assert.equal(f.sources.stats().remoteLeases, 0, JSON.stringify(diagnostics));
  assert.equal(f.env.pi.length, 0);
});

test('stream contract: aborted still-displayed command retains colors without reopening native work', async () => {
  const f = fixture(true), text = 'echo "unfinished', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  const rawArgs = JSON.stringify(tool.args);
  tool.updateResult({ content: [{ type: 'text', text: 'WebSocket closed 1000' }], isError: true }, false);
  const rows = f.render(tool);
  assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', text), 'Formation failure does not erase retained colors');
  assert.ok(plain(rows).join('\n').includes('[error: incomplete tool call]'));
  assert.equal(plain(rows).join('\n').includes('execution failed'), false);
  assert.equal(JSON.stringify(tool.args), rawArgs); assert.equal(tool.executionStarted, false); assert.equal(tool.argsComplete, false);
  assert.equal(f.calls[1]!.request.op, 'stream.close');
  const r = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  await settled();
  const before = counts(f), builds = f.adapter.cacheStats().builds, styles = f.env.styleRequests.length;
  assert.ok(await hasHostInk(f.render(tool, 60), themes.theme, 'syntaxKeyword', text));
  assert.deepEqual(f.render(tool, 0), []); await settled(); assert.deepEqual(counts(f), before);
  assert.deepEqual(f.render(tool, 60), rows);
  const resumedBuilds = f.adapter.cacheStats().builds, requests = f.ui.requests;
  await settled();
  // A real pause resumes through the current source identity, not classifier work.
  assert.deepEqual(sourceCounts(f), before.filter((_v, index) => index !== 3));
  const resumeReads = counts(f)[3]! - before[3]!;
  assert.ok(resumeReads >= 0 && resumeReads <= 3, 'one useful resume has at most the existing three in-memory freshness checks');
  assert.equal(f.env.styleRequests.length, styles); assert.equal(f.adapter.cacheStats().builds, resumedBuilds); assert.equal(f.ui.requests, requests);
  const resumed = counts(f);
  for (const width of [24, 100]) {
    assert.ok(await hasHostInk(f.render(tool, width), themes.theme, 'syntaxKeyword', text)); await settled();
  }
  assert.deepEqual(counts(f), resumed); assert.equal(f.sources.stats().remoteLeases, 0);
  f.render(tool, 100); const warmBuilds = f.adapter.cacheStats().builds;
  for (let i = 0; i < 100; i++) f.render(tool, 100);
  await settled(); assert.deepEqual(counts(f), resumed); assert.equal(f.adapter.cacheStats().builds, warmBuilds);
  assert.ok(warmBuilds > builds, 'Only changed width rebuilt the display');
  f.ui.removeChild(tool); assert.equal(f.sources.stats().sourceRecords, 0); assert.equal(f.adapter.cacheStats().entries, 0);
  f.sources.dispose(); assert.equal(f.sources.stats().retention.retainedBytes, 0, 'root-owned Pi bindings release with the caller-owned root');
});

test('stream contract: formation, live execution, persisted execution and unknown failure labels use phase evidence', () => {
  const error = { content: [{ type: 'text', text: 'unchanged producer diagnostic' }], isError: true };
  const f = fixture(), forming = f.tool('bash', { command: 'echo unfinished' });
  forming.updateResult(error, false);
  assert.ok(plain(f.render(forming)).join('\n').includes('[error: incomplete tool call]'));
  const executing = f.tool('bash', { command: 'echo failed' }); executing.markExecutionStarted(); executing.updateResult(error, false);
  assert.ok(plain(f.render(executing)).join('\n').includes('[error: execution failed]'), 'positive execution evidence takes precedence over a default incomplete flag');
  const replay = f.tool('bash', { command: 'echo failed' }); replay.updateResult({ ...error, role: 'toolResult' }, false);
  assert.ok(plain(f.render(replay)).join('\n').includes('[error: execution failed]'), 'reconstructed SDK flags cannot overwrite a persisted execution result');
  const unknown = renderBashCard({ args: { command: 'echo unknown' }, expanded: false, isPartial: false, result: error }, undefined, 100, themes.theme);
  assert.ok(plain(unknown.rows).join('\n').includes('[error: tool call failed]'));
  assert.equal(JSON.stringify(forming.result), JSON.stringify(error)); assert.equal(JSON.stringify(executing.result), JSON.stringify(error));
});

test('stream contract: identical lifecycle callbacks are counted but not logged per callback', async () => {
  const records: { area: string; explanation: string; fields?: DiagnosticFields }[] = [];
  const f = fixture(false, false, { diagnostic: (_level, area, explanation, fields) => records.push({ area, explanation, fields }) });
  const tool = f.tool('bash', { command: 'echo same' }); tool.updateArgs({ command: 'echo same' }); f.render(tool); await settled();
  const length = records.length, before = counts(f), builds = f.adapter.cacheStats().builds;
  for (let i = 0; i < 100; i++) { tool.updateArgs({ command: 'echo same' }); f.render(tool); }
  await settled();
  assert.equal(records.length, length, 'unchanged source and phase add no lifecycle or decision records');
  assert.deepEqual(counts(f), before); assert.equal(f.adapter.cacheStats().builds, builds);
  f.adapter.logSnapshot();
  const summary = records.findLast(record => record.explanation.includes('Native lifecycle callback counters'));
  assert.ok(summary); assert.equal(summary.fields?.callbacks, 101); assert.equal(summary.fields?.phaseChanges, 1);
  tool.markExecutionStarted();
  assert.equal(records.filter(record => record.explanation.includes('Native tool phase changed')).length, 2);
});

test('stream contract: persisted execution error is a finite replay source, not abandoned argument formation', async () => {
  const f = fixture(true), text = 'echo saved failure', tool = f.tool('bash', { command: text });
  tool.updateResult({ role: 'toolResult', content: [{ type: 'text', text: 'saved diagnostic' }], isError: true }, false);
  f.render(tool); await settled();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.request.op, 'highlight');
  answer(f, 0, text, true); await settled();
  assert.equal(f.sources.stats().remoteLeases, 0); assert.equal(f.sources.stats().unsettledJobs, 0);
  assert.equal(f.sources.status(f.env.keys[0]!)?.exact, true);
  assert.ok(plain(f.render(tool)).join('\n').includes('[error: execution failed]'));
});

for (const frozen of [false, true]) test(`stream review F1: ${frozen ? 'frozen' : 'active'} Bash keeps ready colors through metadata loss and theme previews but releases on off`, async () => {
  const f = fixture(true), text = 'echo prefix', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  if (frozen) {
    tool.updateResult({ content: [{ type: 'text', text: 'upstream interrupted' }], isError: true }, false);
    f.render(tool); await settled(); const request = f.calls[1]!.request;
    f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
    await settled();
  }
  const before = f.calls.length, stamp = f.sources.displayStamp(f.env.keys[0]!);
  f.env.ready = false; f.adapter.syntaxMetadataChanged();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), 'first metadata-loss frame retains styles');
  await settled(); assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.ok(await hasHostInk(f.render(tool, 100), themes.theme, 'syntaxKeyword', text));
  assert.equal(f.calls.length, before); assert.equal(f.sources.displayStamp(f.env.keys[0]!), stamp); assert.equal(f.env.pi.length, 0);
  f.env.ready = false; f.env.selected = { kind: 'theme', id: 'different', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  assert.equal(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), true, 'pending preference does not erase the last ready display');
  f.env.ready = true; f.env.selected = { kind: 'pi', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), false);
  assert.equal(f.sources.displayBasis(f.env.keys[0]!), undefined, 'semantic source display is released; funded card geometry is separate');
});

test('stream review F2: shell-file correction then provider recovery cannot paint display-only history as current coverage', async () => {
  const f = fixture(true), tool = written(f, 'if', 'a.sh');
  f.render(tool); await settled(); answer(f, 0, 'if', true); await settled(); f.render(tool);
  tool.updateArgs({ path: 'a.sh', content: 'zz' }); f.render(tool); await settled();
  assert.equal(f.calls.length, 2); f.env.generation = 2; f.adapter.syntaxMetadataChanged(); await settled();
  const rows = f.render(tool);
  assert.equal(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'zz'), false);
  assert.equal(f.env.pi.length, 0, 'unsettled native work still forbids duplicate Pi parsing');
  assert.ok(plain(rows).join('\n').includes('zz'), 'the complete latest shell-file text remains visible');
});

test('stream review F3: frozen semantic display survives zero width without thawing work', async () => {
  const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool);
  const request = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  const before = counts(f), stamp = f.sources.displayStamp(f.env.keys[0]!), styles = f.env.styleRequests.length;
  const raw = JSON.stringify([tool.args, tool.result, tool.getRenderContext()]);
  assert.deepEqual(f.render(tool, 0), []); await settled(); assert.deepEqual(counts(f), before);
  assert.ok(await hasHostInk(f.render(tool, 60), themes.theme, 'syntaxKeyword', text));
  const builds = f.adapter.cacheStats().builds, requests = f.ui.requests;
  await settled();
  assert.deepEqual(sourceCounts(f), before.filter((_v, index) => index !== 3));
  const resumeReads = counts(f)[3]! - before[3]!;
  assert.ok(resumeReads >= 0 && resumeReads <= 3, 'one useful resume has at most the existing three in-memory freshness checks');
  assert.equal(f.env.styleRequests.length, styles); assert.equal(f.adapter.cacheStats().builds, builds); assert.equal(f.ui.requests, requests);
  const resumed = counts(f);
  for (const width of [24, 60, 100, 60]) assert.ok(await hasHostInk(f.render(tool, width), themes.theme, 'syntaxKeyword', text));
  for (let i = 0; i < 100; i++) f.render(tool, 60);
  await settled(); assert.deepEqual(counts(f), resumed);
  assert.equal(f.sources.displayStamp(f.env.keys[0]!), stamp); assert.equal(JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), raw);
  assert.equal(f.sources.stats().remoteLeases, 0);
});

test('stream review F5: restored frozen Bash processes actual display eviction while work remains paused', async () => {
  const maxBytes = 1 << 20, f = fixture(true, false, {}, { maxBytes }), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  const key = f.env.keys[0]!;
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool);
  const request = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  f.render(tool, 0); assert.ok(await hasHostInk(f.render(tool, 60), themes.theme, 'syntaxKeyword', text));
  const requests = f.ui.requests, releases = f.adapter.cacheStats().releases, calls = f.calls.length;
  const free = maxBytes - f.sources.stats().retention.retainedBytes;
  const grant = f.sources.geometryFunding()!.grant(free)!;
  const unrelated = grant.consume(free); grant.close();
  try {
    assert.equal(f.sources.observe({ key: 'pressure-peer', version: 1, text: 'x', language: 'bash', complete: true }), true);
  } finally { unrelated.release(); }
  assert.equal(f.sources.displayBasis(key), undefined, 'genuine pool pressure released the frozen basis');
  f.sources.flush(); await settled();
  assert.equal(f.ui.requests, requests + 1, 'display loss requests repaint before a manual render can mask the missed notification');
  assert.equal(f.adapter.cacheStats().releases, releases, 'atomic replacement retains accepted output until the next outer visit commits');
  assert.equal(f.calls.length, calls + 1); assert.equal(f.calls.at(-1)!.request.op, 'highlight', 'only the unrelated peer is admitted');
  const rows = f.render(tool, 60); assert.equal(await hasHostInk(rows, themes.theme, 'syntaxKeyword', text), false);
  assert.equal(f.adapter.cacheStats().releases, releases + 1, 'the stale painted output releases on accepted replacement');
  assert.ok(await hasHostInk(rows, themes.theme, 'toolTitle', text));
  await settled(); assert.equal(f.calls.length, calls + 1); assert.equal(f.env.pi.length, 0); assert.equal(f.sources.stats().remoteLeases, 0);
});

for (const beforeAttach of [false, true]) test(`host restored interrupted Bash classifies once without execution (${beforeAttach ? 'prebuilt' : 'attached then finalized'})`, async () => {
  const f = fixture(true), text = ": 'saved unfinished", args = { command: text };
  let tool: InstanceType<typeof ToolExecutionComponent>;
  if (beforeAttach) {
    tool = new ToolExecutionComponent('bash', 'restored-bash', args, undefined, undefined, f.ui, '/tmp');
    tool.updateResult({ content: [{ type: 'text', text: 'WebSocket closed 1000' }], isError: true }, false);
    f.ui.addChild(tool);
  } else {
    tool = f.tool('bash', args, undefined, true);
    tool.updateResult({ content: [{ type: 'text', text: 'WebSocket closed 1000' }], isError: true }, false);
  }
  const raw = JSON.stringify([tool.args, tool.result, tool.getRenderContext()]);
  const cold = f.render(tool); assert.ok(plain(cold).some(row => row.includes('[error: incomplete tool call]')));
  await settled(); assert.equal(f.calls.length, 1, 'one new-owner static coloring request, not resurrected live work');
  assert.equal(f.calls[0]!.request.op, 'highlight', 'the saved snapshot is finite, not complete Bash arguments');
  const submitted = (f.calls[0]!.request.sources as Record<string, unknown>[])[0]!;
  assert.equal(submitted.text, text);
  answer(f, 0, text); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  assert.equal(f.sources.stats().remoteLeases, 0);
  const before = counts(f);
  for (const width of [24, 60, 100, 60]) { f.render(tool, width); f.document(width); }
  for (let i = 0; i < 100; i++) f.render(tool);
  await settled(); assert.deepEqual(counts(f), before); assert.deepEqual(f.env.pi, []);
  assert.equal(JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), raw);
  assert.equal(tool.argsComplete, false); assert.equal(tool.executionStarted, false);
});

test('host live formation abort before its first frame admits no static recoloring', async () => {
  const f = fixture(true), tool = f.tool('bash', { command: ": 'still live" });
  tool.updateResult({ content: [{ type: 'text', text: 'Operation aborted' }], isError: true }, false);
  f.render(tool); await settled(); assert.equal(f.calls.length, 0); assert.equal(f.env.observes, 0);
  for (const width of [60, 24, 100]) f.render(tool, width);
  await settled(); assert.equal(f.calls.length, 0); assert.deepEqual(f.env.pi, []);
});

test('host restored interrupted Bash waits for provider readiness once, never invokes Pi', async () => {
  const f = fixture(false), text = ": 'saved", tool = f.tool('bash', { command: text }, undefined, true);
  tool.updateResult({ content: [{ type: 'text', text: 'Operation aborted' }], isError: true }, false);
  const cold = f.render(tool); await settled(); assert.equal(f.calls.length, 0); assert.equal(f.env.pi.length, 0);
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.request.op, 'highlight'); answer(f, 0, text); await settled();
  const warm = f.render(tool); assert.deepEqual(plain(warm), plain(cold)); assert.notDeepEqual(warm, cold);
  assert.equal(f.sources.stats().remoteLeases, 0); const before = counts(f);
  for (let i = 0; i < 100; i++) f.render(tool);
  await settled(); assert.deepEqual(counts(f), before); assert.deepEqual(f.env.pi, []);
});


for (const episode of ['startup', 'reconnection'] as const) test(`host online wait: both restored Bash cards color after late ${episode}`, async () => {
  const f = fixture(false); if (episode === 'reconnection') f.env.generation++;
  const firstText = ": 'saved unfinished", secondText = 'echo saved success';
  const first = f.tool('bash', { command: firstText }, undefined, true);
  first.updateResult({ content: [{ type: 'text', text: 'WebSocket closed 1000' }], isError: true }, false);
  const second = f.tool('bash', { command: secondText }, undefined, true);
  second.setArgsComplete(); second.updateResult({ content: [{ type: 'text', text: 'saved success' }], isError: false }, false);
  const raw = JSON.stringify([first.args, first.result, first.getRenderContext(), second.args, second.result, second.getRenderContext()]);
  const cold = [f.render(first), f.render(second)]; await settled();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.env.pi, []);
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.calls.length, 2, 'non-last restored demand is not forgotten');
  for (let i = 0; i < 2; i++) {
    assert.equal(f.calls[i]!.request.op, 'highlight');
    answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text);
  }
  await settled();
  const colored = [f.render(first), f.render(second)];
  assert.deepEqual(colored.map(plain), cold.map(plain));
  assert.ok(await hasHostInk(colored[0]!, themes.theme, 'syntaxKeyword', firstText));
  assert.ok(await hasHostInk(colored[1]!, themes.theme, 'syntaxKeyword', secondText));
  const before = counts(f);
  for (const width of [24, 60, 100, 60]) f.document(width);
  for (let i = 0; i < 100; i++) { f.render(first); f.render(second); }
  await settled(); assert.deepEqual(counts(f), before); assert.deepEqual(f.env.pi, []);
  assert.equal(JSON.stringify([first.args, first.result, first.getRenderContext(), second.args, second.result, second.getRenderContext()]), raw);
  assert.equal(first.argsComplete, false); assert.equal(first.executionStarted, false); assert.equal(f.sources.stats().remoteLeases, 0);
});


for (const kind of ['write', 'edit'] as const) test(`host ${kind} palette switch rematerializes retained semantic rows locally at unchanged width`, async () => {
  const f = fixture(true);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  const tools = Array.from({ length: 4 }, (_, i) => {
    if (kind === 'write') return written(f, `const host${i}=1;`);
    const tool = f.tool('edit', { path: `host${i}.ts`, oldText: `const old${i}=1;`, newText: `const next${i}=2;` });
    tool.updateResult({ content: [{ type: 'text', text: 'edited' }], details: { diff: `-1 const old${i}=1;\n+1 const next${i}=2;` }, isError: false }, false);
    return tool;
  });
  f.document(); await settled();
  for (let i = 0; i < tools.length * (kind === 'edit' ? 2 : 1); i++) {
    const call = f.calls[i]; assert.ok(call);
    answer(f, i, (call.request.sources as { text: string }[])[0]!.text); await settled();
  }
  const first = tools[0]!, before = f.render(first), firstKey = f.env.keys[0]!;
  const oldPalette = f.sources.displayBasis(firstKey)?.palette;
  f.env.holdStyles = true;
   f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'light' }; f.adapter.syntaxMetadataChanged();
   await settled(); // Palette bytes and cached expressions are prepared outside render.
   const countsBefore = counts(f), styleRequests = f.env.styleRequests.length, sourceCalls = f.calls.length;
  const immediate = f.render(first);
  assert.notDeepEqual(immediate, before, 'a funded local palette change rematerializes ready semantic rows immediately');
  assert.notEqual(f.sources.displayBasis(firstKey)?.palette, oldPalette);
  assert.deepEqual(counts(f), countsBefore, 'palette-only rematerialization does no work in render');
  assert.equal(f.env.styleRequests.length, styleRequests, 'generic STYLE data is independent of palette identity');
  assert.equal(f.calls.length, sourceCalls, 'retained source is not parsed again for a local palette switch');
  await settled(); await settled();
  assert.deepEqual(f.render(first), immediate, 'the locally ready palette remains stable on the next frame');
  assert.equal(f.env.pi.length, 0);
});

for (const kind of ['write', 'edit'] as const) test(`theme burst: ${kind} preview→full→preview preserves cached Pi colors`, async t => {
  const f = fixture();
  const tool = kind === 'write' ? written(f, 'const n = 1') : f.tool('edit', { path: 'a.ts', oldText: 'const n = 1', newText: 'const n = 2' });
  if (kind === 'edit') tool.updateResult({ content: [{ type: 'text', text: 'saved' }], details: { diff: '-1 const n = 1\n+1 const n = 2' }, isError: false }, false);
  f.render(tool); await settled();
  const before = f.render(tool), classifications = f.env.pi.length, sourceCalls = f.calls.length;
  assert.ok(await hasHostInk(before, themes.theme, 'syntaxKeyword', 'const'), 'the starting preview has Pi paint');
  tool.setExpanded(true); f.render(tool); await settled();
  const full = f.render(tool);
  assert.ok(await hasHostInk(full, themes.theme, 'syntaxKeyword', 'const'), 'full owned view keeps prepared Pi paint');
  assert.match(plain(full).join('\n'), /const n = 1/);
  tool.setExpanded(false); f.render(tool); await settled();
  assert.deepEqual(f.render(tool), before, 'the preview returns to its exact cached ANSI rows');
  assert.equal(f.env.pi.length, classifications, 'the mode round trip cannot repeat Pi classification');
  assert.equal(f.calls.length, sourceCalls, 'the mode round trip cannot dispatch source work');
});

for (const kind of ['write', 'edit'] as const) test(`theme burst: ${kind} preview→full→preview keeps cached paint while unrelated jobs remain held`, async t => {
  const f = fixture(true);
  const tool = kind === 'write' ? written(f, 'const n = 1') : f.tool('edit', { path: 'a.ts', oldText: 'const n = 1', newText: 'const n = 2' });
  if (kind === 'edit') tool.updateResult({ content: [{ type: 'text', text: 'saved' }], details: { diff: '-1 const n = 1\n+1 const n = 2' }, isError: false }, false);
  f.render(tool); await settled();
  for (let i = 0; i < f.calls.length; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
  await settled(); const before = f.render(tool);
  f.render(f.tool('bash', { command: 'echo held B' })); f.render(f.tool('bash', { command: 'echo held C' })); await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 2); const dispatched = f.calls.length, pi = f.env.pi.length;
  assert.ok(await hasHostInk(before, themes.theme, 'syntaxKeyword', 'const'), 'the starting preview has prepared paint');
  tool.setExpanded(true); f.render(tool); await settled();
  const full = f.render(tool);
  assert.ok(await hasHostInk(full, themes.theme, 'syntaxKeyword', 'const'), 'full view uses retained local paint while jobs are held');
  assert.match(plain(full).join('\n'), kind === 'write' ? /const n = 1/ : /const n = 1[\s\S]*const n = 2/);
  tool.setExpanded(false); f.render(tool); await settled(); await settled();
  assert.deepEqual(f.render(tool), before, 'the preview returns to exact paint without waiting for unrelated native credit');
  assert.equal(f.calls.length, dispatched); assert.equal(f.env.pi.length, pi); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
});


for (const kind of ['write', 'edit'] as const) test(`theme burst: ${kind} owned palette preview→full→preview keeps binding paint while unrelated jobs remain held`, async () => {
  const f = fixture(true);
  f.env.selected = { kind: 'theme', id: 'catppuccin', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  const tool = kind === 'write' ? written(f, 'const n = 1') : f.tool('edit', { path: 'a.ts', oldText: 'const n = 1', newText: 'const n = 2' });
  if (kind === 'edit') tool.updateResult({ content: [{ type: 'text', text: 'saved' }], details: { diff: '-1 const n = 1\n+1 const n = 2' }, isError: false }, false);
  f.render(tool); await settled();
  for (let i = 0; i < f.calls.length; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
  await settled(); const before = f.render(tool);
  assert.match(plain(before).join('\n'), /const n = 1/);
  const selected = sampleOwnedPalette('catppuccin-dark', 'truecolor');
  const binding = selected.bindings[3]!.ink, plainCode = selected.roles.code.foreground;
  if (binding.kind !== 'rgb' || plainCode.kind !== 'rgb') throw new Error('expected owned RGB inputs');
  const bindingFg = (binding.r << 16) | (binding.g << 8) | binding.b;
  const plainCodeFg = (plainCode.r << 16) | (plainCode.g << 8) | plainCode.b;
  const hasKeywordInk = async (rows: string[]) => (await hostCells(rows)).some(row => row.some(cell => cell.text === 'c' && cell.fg === bindingFg));
  assert.notEqual(bindingFg, plainCodeFg, 'the selected keyword binding is distinct from neutral code foreground');
  assert.ok(await hasKeywordInk(before), 'the owned palette baseline uses the exact selected keyword binding RGB, not neutral code ink');
  f.render(f.tool('bash', { command: 'echo held B' })); f.render(f.tool('bash', { command: 'echo held C' })); await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 2);
  const dispatched = f.calls.length, pi = f.env.pi.length, styleRequests = f.env.styleRequests.length;
  tool.setExpanded(true); f.render(tool); await settled();
  const full = f.render(tool);
  assert.match(plain(full).join('\n'), kind === 'write' ? /const n = 1/ : /const n = 1[\s\S]*const n = 2/);
  assert.ok(await hasKeywordInk(full), 'the full owned card keeps the exact selected keyword binding RGB, not neutral code ink');
  tool.setExpanded(false); f.render(tool); await settled(); await settled();
  assert.deepEqual(f.render(tool), before, 'the preview returns to exact owned-palette ANSI rows');
  assert.equal(f.calls.length, dispatched, 'mode round trip dispatches no additional SOURCE');
  assert.equal(f.env.pi.length, pi, 'owned mode round trip does not invoke Pi classification');
  assert.equal(f.env.styleRequests.length, styleRequests, 'mode round trip adds no STYLE work');
  assert.equal(f.sources.stats().globalUnsettledJobs, 2, 'unrelated source jobs remain held through the round trip');
});

test('external owner establishes a Pi fallback baseline after owned-asset failure and refreshes it once on color change', async t => {
  const openSync = nodeFs.openSync.bind(nodeFs);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); themes.setTheme('dark', false); });
  themes.setTheme('dark', false);
  t.mock.method(nodeFs, 'openSync', (...args: Parameters<typeof nodeFs.openSync>) => {
    const [path] = args;
    if (String(path).endsWith('/gruvbox-dark.json')) throw new Error('controlled known-palette read failure');
    return openSync(...args);
  });
  syncBuiltinESMExports();
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  const tool = written(f, 'const externalPaletteFallback = 1;');
  const controller = f.adapter as TidyUiController & { refreshPreparedPalette(node: object, token: object): void };
  const refresh = controller.refreshPreparedPalette; let refreshVisits = 0;
  controller.refreshPreparedPalette = (node, token) => { refreshVisits++; refresh.call(controller, node, token); };
  try {
    f.render(tool); await settled(); const initial = f.render(tool); await settled();
    assert.equal(f.sources.displayBasis(f.env.keys[0]!), undefined, 'failed local input leaves no semantic group');
    assert.equal(f.env.pi.length, 1, 'the no-group card uses one local Pi classification');
    assert.ok(await hasHostInk(initial, themes.theme, 'syntaxKeyword', 'const'), 'the no-group fallback uses Pi code ink');
    const before = counts(f), styleRequests = f.env.styleRequests.length, prepared = refreshVisits;
    for (let i = 0; i < 100; i++) f.render(tool);
    await settled(); assert.equal(refreshVisits, prepared, 'a warm Pi fallback has a recorded public-color identity and schedules no deferred refresh');
    assert.deepEqual(counts(f), before, 'warm Pi fallback performs no source work');
    assert.equal(f.env.styleRequests.length, styleRequests, 'warm Pi fallback performs no STYLE work');
    themes.setTheme('light', false); f.env.palette++; f.adapter.syntaxMetadataChanged();
    f.render(tool); await settled(); const recolored = f.render(tool); await settled();
    assert.notDeepEqual(recolored, initial, 'Pi-origin fallback adopts the changed public palette');
    assert.ok(await hasHostInk(recolored, themes.theme, 'syntaxKeyword', 'const'));
    const afterRefresh = refreshVisits;
    assert.equal(afterRefresh, prepared + 1, 'one current-color refresh is deferred outside the cold owner render');
    assert.equal(f.env.pi.length, before[0]! + 1, 'one Pi classification is regenerated for the new public colors');
    assert.equal(f.env.captures, before[2]! + 1, 'the same source text is recaptured once into the local Pi projection');
    assert.equal(f.calls.length, before[4], 'a palette refresh sends no Occipital SOURCE');
    assert.equal(f.env.styleRequests.length, styleRequests, 'a palette refresh sends no generic STYLE');
    for (let i = 0; i < 100; i++) f.render(tool);
    await settled(); assert.equal(refreshVisits, afterRefresh, 'warm frames do not repeat deferred refresh');
    assert.equal(f.env.pi.length, before[0]! + 1, 'warm frames do not reclassify the cached fallback text');
    assert.equal(f.env.captures, before[2]! + 1, 'warm frames do not recapture the fallback source');
    assert.equal(f.calls.length, before[4], 'warm frames send no Occipital SOURCE');
    assert.equal(f.env.styleRequests.length, styleRequests, 'warm frames send no generic STYLE');
  } finally { controller.refreshPreparedPalette = refresh; }
});

test('collected prior Pi colors still trigger retained-card recolor without new SOURCE', async () => {
  const f = fixture(true), tool = written(f, 'const COLLECTED_PI_COLORS = true;');
  const original = CardSources.prototype.updateDisplay;
  let updates = 0, inRender = false, updatesInRender = 0;
  CardSources.prototype.updateDisplay = function(node, input) {
    if (node === tool) { updates++; if (inRender) updatesInRender++; }
    return original.call(this, node, input);
  };
  try {
    f.render(tool); await settled();
    for (let i = 0; i < f.calls.length; i++) {
      if (f.calls[i]!.request.op === 'highlight') answer(f, i, 'const COLLECTED_PI_COLORS = true;');
    }
    await settled();
    const ready = f.render(tool); await settled();
    const previousTheme = themes.getThemeByName('dark');
    assert.ok(previousTheme && await hasHostInk(ready, previousTheme, 'syntaxKeyword', 'const'));
    const beforeSources = f.calls.length, beforeStyles = f.env.styleRequests.length;
    const priorColors = f.weakCurrentPiColors();
    const replacement = themes.getThemeByName('light');
    assert.ok(replacement, 'the SDK provides a real replacement Theme instance');
    themes.setThemeInstance(replacement);
    f.env.palette++; f.currentPiColors();
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    assert.equal(typeof gc, 'function', 'this harness exposes bounded explicit GC');
    let colorsCollected = false;
    for (let i = 0; i < 12 && !colorsCollected; i++) {
      await turn(); gc!(); await turn();
      colorsCollected = priorColors.deref() === undefined;
    }
    assert.equal(colorsCollected, true, 'the replaced public color map is actually collected while its tool owner remains live');
    const beforeDeferred = updates;
    inRender = true; try { f.render(tool); } finally { inRender = false; }
    assert.equal(updatesInRender, 0, 'collected weak color identity does not rebuild presentation on render');
    await settled();
    const recolored = f.render(tool);
    assert.ok(await hasHostInk(recolored, replacement, 'syntaxKeyword', 'const'), 'retained semantic rows adopt current public colors');
    assert.equal(updates, beforeDeferred + 1, 'one outside-render refresh repairs the dead weak baseline');
    assert.equal(f.calls.length, beforeSources, 'color-map replacement dispatches no new SOURCE');
    assert.equal(f.env.styleRequests.length, beforeStyles, 'color-map replacement dispatches no generic STYLE');
  } finally { CardSources.prototype.updateDisplay = original; themes.initTheme('dark', false); }
});

test('prepared host owned palette paints every card surface without Pi on warm repaint resize and output updates', async () => {
  const f = fixture(true);
  f.env.selected = { kind: 'theme', id: 'catppuccin', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  const tool = f.tool('bash', { command: 'echo native', description: 'description', workdir: '/tmp' });
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'stdout\n<system-reminder>\nreminder\n</system-reminder>' }], isError: false }, false);
  const first = f.render(tool); await settled();
  for (let i = 0; i < f.calls.length; i++) { const q = f.calls[i]!.request; if (q.op === 'highlight') answer(f, i, 'echo native'); }
  await settled();
  const ready = f.render(tool), baseline = counts(f), builds = f.adapter.cacheStats().builds;
  assert.deepEqual(plain(first), plain(ready));
  f.env.poisonPi = true;
  for (let i = 0; i < 100; i++) assert.deepEqual(f.render(tool), ready);
  assert.deepEqual(counts(f), baseline); assert.equal(f.adapter.cacheStats().builds, builds);
  for (const width of [24, 121, 60]) f.render(tool, width);
  tool.updateResult({ content: [{ type: 'text', text: 'new stdout' }], isError: false }, false);
  const changed = f.render(tool); assert.match(plain(changed).join('\n'), /new stdout/);
  const cells = await hostCells(changed), selected = sampleOwnedPalette('catppuccin-dark', 'truecolor');
  const background = selected.roles.panel.background, binding = selected.bindings[3]!.ink;
  if (background.kind !== 'rgb' || binding.kind !== 'rgb') throw new Error('expected owned RGB inputs');
  const expectedBg = (background.r << 16) | (background.g << 8) | background.b;
  const expectedFg = (binding.r << 16) | (binding.g << 8) | binding.b;
  for (const row of cells) for (let x = 0; x < row.length; x++) {
    const cell = row[x]!;
    if (x === 0 || x === row.length - 1 || x === 1) assert.equal(cell.bg, -1, 'exterior and stripe retain terminal default');
    else assert.equal(cell.bg, expectedBg, 'all card regions use the selected owned surface');
  }
  assert.ok(cells.some(row => row.some(cell => cell.text === 'e' && cell.fg === expectedFg)), 'semantic binding uses the selected owned palette');
   assert.equal(f.env.pi.length, 0);
});

test('prepared host outer refusal and throw release provisional candidates without publishing or leaking funded rows', async () => {
  const f = fixture(), tool = written(f, 'const retained=1;');
  f.render(tool); await settled(); const accepted = f.render(tool);
  const visit = CardSources.prototype.visit;
  let refuse = true;
  CardSources.prototype.visit = function(owner, consume) {
    const result = visit.call(this, owner, consume);
    if (refuse) return false;
    return result;
  };
  try {
    const before = f.sources.stats().retention.retainedBytes;
    const acceptedStats = f.adapter.cacheStats(), cardBuilds = acceptedStats.cards.builds, ordinaryBuilds = acceptedStats.ordinary.builds;
    for (let i = 0; i < 4; i++) f.render(tool, 24);
    const deniedStats = f.adapter.cacheStats();
    assert.equal(f.sources.stats().retention.retainedBytes, before);
    assert.equal(deniedStats.cards.builds, cardBuilds, 'denial does not adopt a provisional prepared card');
    assert.equal(deniedStats.ordinary.builds, ordinaryBuilds + 1, 'one bounded ordinary fallback is built for the denied width');
    for (let i = 0; i < 4; i++) f.render(tool, 24);
    assert.equal(f.adapter.cacheStats().ordinary.builds, deniedStats.ordinary.builds, 'warm denied-width fallback is reused');
    refuse = false; assert.deepEqual(f.render(tool, 60), accepted, 'outer refusal preserves the accepted detached cache without publishing wrong-width rows');
    assert.notDeepEqual(f.render(tool, 24), accepted);
  } finally { CardSources.prototype.visit = visit; }
  CardSources.prototype.visit = function(owner, consume) { visit.call(this, owner, consume); throw new Error('controlled outer throw'); };
  try {
    f.render(tool, 40);
    assert.equal(f.adapter.active, false, 'unexpected errors retain the existing fail-and-restore lifecycle');
    assert.equal(f.adapter.cacheStats().entries, 0);
  } finally { CardSources.prototype.visit = visit; }
});


for (const [base, current, grapheme] of [['e', 'é tail', 'é'], ['👩', '👩‍💻 tail', '👩‍💻']]) test(`prepared host first-scalar historical prefix owns the whole ${grapheme} grapheme before append usefulness`, async () => {
  const f = fixture(true), tool = f.tool('bash', { command: base });
  f.render(tool); await settled(); answer(f, 0, base!, false, 0); await settled(); f.render(tool);
  tool.updateArgs({ command: current });
  const first = f.render(tool);
  assert.equal(await hasHostInk(first, themes.theme, 'syntaxKeyword', grapheme!), true);
  assert.equal(await hasHostInk(first, themes.theme, 'toolTitle', 'tail'), true);
  assert.match(plain(first).join('\n'), new RegExp(grapheme!));
  await settled(); const before = counts(f);
  for (const width of [24, 100, 60]) f.render(tool, width);
  assert.deepEqual(counts(f), before);
  tool.updateArgs({ command: `x${current!.slice(base!.length)}` });
  const corrected = f.render(tool);
  assert.equal(await hasHostInk(corrected, themes.theme, 'syntaxKeyword', 'x'), false, 'different first scalar invalidates historical coverage');
  assert.equal(f.env.pi.length, 0);
});

test('prepared host output-only and identical-output callbacks never remeasure unchanged command and resize reuses measurements', async () => {
  const f = fixture(), tool = f.tool('bash', { command: 'UNIQUE_COMMAND_MEASUREMENT αβ' });
  f.render(tool); await settled();
  const segment = Intl.Segmenter.prototype.segment; let command = 0, output = 0;
  Intl.Segmenter.prototype.segment = function(text) { if (text.startsWith('UNIQUE_COMMAND_MEASUREMENT')) command++; if (text.startsWith('NEW_OUTPUT')) output++; return segment.call(this, text); };
  try {
    tool.updateResult({ content: [{ type: 'text', text: 'NEW_OUTPUT' }] }, true);
    assert.equal(output, 1, 'service measurement happens in the update hook, not render');
    for (const width of [24, 100, 60]) f.render(tool, width);
    assert.equal(command, 0); assert.equal(output, 1);
    tool.updateResult({ content: [{ type: 'text', text: 'NEW_OUTPUT' }] }, true); f.render(tool);
    assert.equal(command, 0); assert.equal(output, 1, 'identical output is not a display revision');
  } finally { Intl.Segmenter.prototype.segment = segment; }
});

test('prepared host streamed Bash argument ending in a high surrogate does not throw from the native update', async () => {
  const f = fixture(), tool = f.tool('bash', { command: 'echo ' });
  f.render(tool); await settled();
  assert.doesNotThrow(() => tool.updateArgs({ command: 'echo \ud83d' }), 'a transient incomplete pair is ordinary streaming input');
  assert.equal(f.adapter.active, true);
  tool.updateArgs({ command: 'echo \ud83d\ude00' });
  assert.match(plain(f.render(tool)).join('\n'), /echo 😀/u);
});

test('prepared host warm framed file frames return the retained body rows directly', async () => {
  const f = fixture(), tool = written(f, 'const warmRows = 1;\n');
  f.render(tool); await settled();
  const first = f.render(tool), second = f.render(tool);
  assert.ok(first.length > 0 && first[0] !== '', 'first transcript card needs no outside separator');
  assert.equal(second === first, true, 'unchanged frames reuse the retained body rows instead of copying them');
});

test('prepared host collapsed Bash output measures only its displayed preview rows and expands the complete output', async () => {
  const f = fixture(), tool = f.tool('bash', { command: 'seq 200' });
  f.render(tool); await settled();
  const segment = Intl.Segmenter.prototype.segment; let measured = 0;
  Intl.Segmenter.prototype.segment = function(text) { if (text.startsWith('OUTPUT_ROW_')) measured++; return segment.call(this, text); };
  try {
    const text = Array.from({ length: 200 }, (_, i) => `OUTPUT_ROW_${i}`).join('\n');
    tool.updateResult({ content: [{ type: 'text', text }] }, true);
    const rows = plain(f.render(tool));
    assert.equal(tool.expanded, false);
    assert.ok(rows.filter(row => row.includes('OUTPUT_ROW_')).length <= 11, 'collapsed preview displays at most eleven output rows');
    assert.ok(rows.some(row => row.includes('OUTPUT_ROW_0')) && !rows.some(row => row.includes('OUTPUT_ROW_199')));
    assert.ok(rows.some(row => row.includes('Click to expand')));
    assert.ok(measured <= 11, `measured ${measured} output rows for a collapsed preview of at most eleven`);
    tool.setExpanded(true);
    const expanded = plain(f.render(tool));
    assert.equal(expanded.filter(row => row.includes('OUTPUT_ROW_')).length, 200);
    assert.ok(expanded.some(row => row.includes('OUTPUT_ROW_199')));
    const prepared = measured;
    for (const width of [24, 100, 60]) f.render(tool, width);
    assert.equal(measured, prepared, 'expanded warm and width changes reuse measurements');
  } finally { Intl.Segmenter.prototype.segment = segment; }
});

test('prepared host streamed Bash argument appends never remeasure the unchanged command prefix', async () => {
  const marker = 'UNIQUE_APPEND_MEASUREMENT ', f = fixture(), tool = f.tool('bash', { command: marker });
  f.render(tool); await settled();
  const segment = Intl.Segmenter.prototype.segment; let units = 0, calls = 0;
  // Count every actual input during these synchronous lifecycle callbacks: a
  // suffix-only implementation intentionally never receives the full marker.
  Intl.Segmenter.prototype.segment = function(text) { calls++; units += text.length; return segment.call(this, text); };
  let command = marker;
  try {
    // Ordinary streamed generation: 64 complete-line appends, no intervening render.
    for (let i = 0; i < 64; i++) { command += `echo chunk_${String(i).padStart(3, '0')} >> /tmp/out.log\n`; tool.updateArgs({ command }); }
  } finally { Intl.Segmenter.prototype.segment = segment; }
  const appended = command.length - marker.length;
  assert.ok(calls > 0, 'appends reach lifecycle display preparation');
  // Appended text plus a bounded re-segmented boundary per append; a whole-prefix
  // remeasurement grows quadratically with the number of appends.
  assert.ok(units <= 2 * appended + 64 * 16, `segmented ${units} UTF-16 units for ${appended} appended units in ${calls} measurements`);
  console.log(JSON.stringify({ streamedAppendSegmentation: { appended, units, calls } }));
  const correction = 'CORRECTED_APPEND ' + command.slice(marker.length);
  tool.updateArgs({ command: correction });
  const corrected = plain(f.render(tool)).join('\n');
  assert.ok(corrected.includes('CORRECTED_APPEND') && corrected.includes('chunk_063'));
  assert.equal(tool.args.command, correction, 'display optimization never rewrites tool input');
  assert.equal(f.env.pi.length, 0, 'Bash never falls through to Pi classification');
});


test('prepared host full-mode same-object diagnostic mutation changes service rows without reparsing file source', async () => {
  const f = fixture(), text = 'const diagnosticSource=1;', tool = written(f, text);
  tool.setExpanded(true);
  const diagnostics = [{ severity: 'error', message: 'first diagnostic', line: 1 }];
  tool.updateResult({ ...tool.result, details: { diagnostics } }, false);
  f.render(tool); await settled(); assert.match(plain(f.render(tool)).join('\n'), /first diagnostic/);
  const before = f.env.pi.length;
  diagnostics[0]!.message = 'replacement diagnostic';
  tool.updateResult(tool.result, false);
  const rows = plain(f.render(tool)).join('\n');
  assert.match(rows, /replacement diagnostic/); assert.doesNotMatch(rows, /first diagnostic/);
  await settled(); assert.equal(f.env.pi.length, before);
});


test('prepared host palette refresh is weakly guarded after restore and the external source root remains caller owned', async () => {
  const f = fixture(), tool = written(f, 'const callerOwned=1;');
  f.render(tool); await settled(); f.render(tool);
  const dispose = f.sources.dispose.bind(f.sources); let disposals = 0;
  f.sources.dispose = () => { disposals++; dispose(); };
  f.env.palette++; f.render(tool);
  f.adapter.restore(); f.env.poisonPi = true;
  await settled();
  assert.equal(disposals, 0, 'adapter restoration never disposes its supplied client root');
  assert.equal(f.sources.capturePiSource('caller-after-restore', 1, 'const usable=2;', 'typescript'), true);
  assert.equal(f.adapter.active, false);
});


test('review F1: actual SDK refused FILE revision admits no native work until identical callback is accepted', async () => {
  const f = fixture(true), tool = written(f, 'SOURCE_A');
  f.render(tool); await settled(); answer(f, 0, 'SOURCE_A'); await settled(); f.render(tool);
  const budget = f.sources.geometryFunding()!.budget, stats = budget.stats(), bytes = stats.limit - stats.retainedBytes - stats.outstandingPeakBytes;
  const grant = budget.reserve(bytes)!; assert.ok(grant); const held = grant.consume(bytes); grant.close();
  const before = sourceCounts(f);
  try {
    tool.updateArgs({ path: 'a.ts', content: 'SOURCE_B' }); f.render(tool); await settled();
    assert.deepEqual(sourceCounts(f), before, 'unaccepted display may not observe, capture, classify or dispatch source work');
  } finally { held.release(); }
  assert.doesNotMatch(plain(f.render(tool)).join('\n'), /SOURCE_A/, 'released credit cannot revive the previous custom body');
  tool.updateArgs(tool.args); assert.match(plain(f.render(tool)).join('\n'), /SOURCE_B/); await settled();
  assert.equal(f.calls.length, 2); assert.equal((f.calls[1]!.request.sources as { text: string }[])[0]!.text, 'SOURCE_B');
  assert.equal(f.env.pi.length, 0, 'refusal/recovery never grants a duplicate Pi classifier');
  answer(f, 1, 'SOURCE_B'); await settled(); const warm = sourceCounts(f);
  tool.invalidate(); f.render(tool); await settled(); assert.deepEqual(sourceCounts(f), warm);
  f.ui.removeChild(tool); assert.equal(f.adapter.cacheStats().entries, 0);
  tool.invalidate(); assert.equal(f.adapter.cacheStats().entries, 0, 'detached callbacks cannot restore ownership');
});


for (const selection of ['owned palette', 'Follow Pi'] as const) test(`C19 SDK host recolors live interrupted Bash for ${selection} without reopening SOURCE`, async t => {
  t.after(() => themes.setTheme('dark'));
  const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  tool.updateArgs({ command: `${text} NEW` });
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false);
  f.render(tool); await settled();
  const close = f.calls.find(c => c.request.op === 'stream.close')!; assert.ok(close);
  close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  const before = sourceCounts(f), raw = JSON.stringify([tool.args, tool.result, tool.getRenderContext()]);
  const styleRequests = f.env.styleRequests.length;
  if (selection === 'owned palette') {
    f.env.selected = { kind: 'theme', id: 'tokyonight', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  } else { themes.setTheme('light'); f.env.palette++; f.render(tool); }
  await settled();
  assert.equal(f.env.styleRequests.length, styleRequests, 'palette changes rebind retained common expressions locally');
  const rows = f.render(tool);
  if (selection === 'Follow Pi') assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', text), 'retained scopes adopt current Pi ink');
  else {
    const owned = sampleOwnedPalette('tokyonight-dark', themes.theme.getColorMode());
    assert.ok(Object.values(owned.compiledRoles).some(role => role.open.length > 0 && rows.some(row => row.includes(role.open))),
      'the real installer renders with the selected locally owned palette without an external prep callback');
  }
  assert.match(plain(rows).join('\n'), /echo retained NEW/); assert.match(plain(rows).join('\n'), /incomplete tool call/);
  if (selection === 'Follow Pi') assert.ok(await hasHostInk(rows, themes.theme, 'toolTitle', 'NEW'), 'unparsed suffix is not historical scope coverage');
  assert.deepEqual(sourceCounts(f), before); assert.equal(JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), raw);
  assert.equal(f.sources.stats().remoteLeases, 0); assert.deepEqual(f.env.pi, []);
  if (selection === 'Follow Pi') {
    tool.updateArgs({ command: 'different NEW' }); const corrected = f.render(tool); await settled();
    assert.ok(await hasHostInk(corrected, themes.theme, 'toolTitle', 'different NEW'), 'only the current matching prefix may borrow retained scopes');
    assert.deepEqual(sourceCounts(f), before);
  }
});


function answerPausedHostStyle(f: ReturnType<typeof fixture>) {
  const held = f.styleCalls.at(-1)!; assert.ok(held);
  const q = held.request;
  held.resolve({ v: PROTOCOL_VERSION, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintRules(q.rules),
    styles: [{ foreground: { kind: 'binding', slot: 1 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }],
    indices: q.contexts.map(() => 1) } });
}

for (const pause of ['zero-width', 'hidden'] as const)
  test(`C19 pause fix SDK host ${pause} prevents a pending common STYLE result from publishing until useful resumption`, async () => {
    const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
    f.env.holdStyles = true;
    f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled();
    const key = f.env.keys[0]!, before = sourceCounts(f), beforeStamp = f.sources.displayStamp(key), beforeLeases = f.sources.stats().remoteLeases;
    assert.equal(f.styleCalls.length, 1); assert.equal(f.sources.stats().unsettledJobs, 1);
    if (pause === 'hidden') tool.hideComponent = true;
    assert.deepEqual(f.render(tool, pause === 'zero-width' ? 0 : 60), []);
    answerPausedHostStyle(f); await settled();
    assert.equal(f.sources.displayStamp(key), beforeStamp, 'STYLE settling while paused cannot publish a partial semantic replacement');
    assert.equal(f.sources.stats().unsettledJobs, 0);
    assert.equal(f.env.styleRequests.length, 1);
    tool.hideComponent = false; f.env.holdStyles = false;
    assert.ok(f.render(tool).length > 0, 'first useful frame admits the retained semantic result');
    await settled();
    assert.equal(f.env.styleRequests.length, 1, 'resumption reuses settled common STYLE');
    assert.ok(f.sources.displayBasis(key));
    assert.deepEqual(sourceCounts(f), before);
    assert.equal(f.sources.stats().remoteLeases, beforeLeases, 'visibility pause and resumption preserve the active Pi-owned lease');
    assert.equal(f.sources.stats().pendingCloses, 0);
  });

for (const kind of ['bash', 'write', 'edit'] as const) test(`host renderer transfer: ready ${kind} retains native paint and measured text without SOURCE or STYLE`, async () => {
  const f = fixture(true, false, {}, undefined, true);
   f.env.selected = { kind: 'theme', id: 'monokai', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  const tool = kind === 'write' ? written(f, 'const TRANSFER_MARK = 1;')
    : f.tool(kind, kind === 'bash' ? { command: 'echo TRANSFER_MARK' }
      : { path: 'transfer.ts', oldText: 'const TRANSFER_OLD = 1;', newText: 'const TRANSFER_NEW = 2;' });
  if (kind === 'bash') tool.setArgsComplete();
  if (kind !== 'write') tool.updateResult({ content: [{ type: 'text', text: 'done' }], isError: false,
    ...(kind === 'edit' ? { details: { diff: '-1 const TRANSFER_OLD = 1;\n+1 const TRANSFER_NEW = 2;' } } : {}) }, false);
  f.document(); await settled();
  const segments = kind === 'edit' ? 2 : 1;
  for (let i = 0; i < segments; i++) {
    assert.ok(f.calls[i]); answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text); await settled();
  }
  const expected = f.document(), before = sourceCounts(f), styles = f.env.styleRequests.length;
  const marker = kind === 'edit' ? 'TRANSFER_NEW' : 'TRANSFER_MARK';
  assert.ok(plain(expected).join('\n').includes(marker), 'owned palette card content is ready before moving');
  const counters = watchConsumer(f);
  try {
    for (let i = 0; i < 3; i++) {
      f.replaceRenderer();
      assert.deepEqual(f.document(), expected, 'the synchronous first transcript frame preserves exact ANSI');
      await settled();
      assert.deepEqual(f.document(), expected);
      assert.deepEqual(sourceCounts(f), before, 'moving unchanged owners must not observe or capture new sources');
      assert.equal(f.env.styleRequests.length, styles, 'the already-ready palette and styles survive the move');
    }
    const warm = counters.counts().slice(1); f.document(); f.document(); await settled();
    assert.deepEqual(counters.counts().slice(1), warm, 'subsequent warm frames do no further preparation');
  } finally { counters.restore(); }
});

test('host renderer transfer: a genuinely cleared root blocks already-queued work and releases held owners', async () => {
  const f = fixture(true, false, {}, undefined, true);
  const tool = written(f, 'const TRANSFER_CLEAR = 1;');
  f.render(tool); f.ui.clear(); await settled();
  assert.equal(f.calls.length, 0, 'the earlier queued pump cannot dispatch a detached source');
  assert.equal(f.env.styleRequests.length, 0);
  assert.equal(f.sources.stats().sourceRecords, 0); assert.equal(f.adapter.cacheStats().entries, 0);
  assert.equal(f.sources.stats().retention.entries, 0);
  tool.invalidate(); f.render(tool); await settled();
  assert.equal(f.sources.stats().sourceRecords, 0, 'detached invalidation must not recreate source records');
  assert.equal(f.adapter.cacheStats().entries, 0, 'rendering a detached owner must not memoize a new card layout');
});

test('host renderer transfer: restore before deferred root retirement releases everything and never resurrects it', async () => {
  const f = fixture(false, false, {}, undefined, true), tool = written(f, 'const TRANSFER_RESTORE = 1;');
  f.render(tool); await settled(); assert.equal(f.env.pi.length, 1);
  f.ui.clear(); f.adapter.restore();
  assert.equal(f.adapter.cacheStats().entries, 0); assert.equal(f.sources.stats().piSourceRecords, 0);
  const before = counts(f); await settled();
  assert.deepEqual(counts(f), before); assert.equal(f.sources.stats().retention.entries, 0);
  f.sources.dispose(); assert.equal(f.sources.stats().retention.retainedBytes, 0);
});

test('host renderer transfer: changed text is prepared instead of reusing the old semantic source demand', async () => {
  const f = fixture(true, false, {}, undefined, true), tool = written(f, 'const TRANSFER_BEFORE = 1;');
   f.env.selected = { kind: 'theme', id: 'nord', variant: 'light' }; f.adapter.syntaxMetadataChanged();
  f.document(); await settled(); answer(f, 0, 'const TRANSFER_BEFORE = 1;'); await settled(); f.document();
  f.ui.clear(); tool.updateArgs({ path: 'a.ts', content: 'const TRANSFER_AFTER = 2;' }); f.ui.addChild(tool);
  const pending = plain(f.document()).join('\n');
  assert.match(pending, /Preparing file preview/u, 'reattachment first shows the honest pending state');
  await settled();
  const current = plain(f.document()).join('\n');
  assert.ok(current.includes('TRANSFER_AFTER'), `reattached card must show changed source, got:\n${current}`);
  assert.equal(current.includes('TRANSFER_BEFORE'), false, `reattached card must not retain stale source, got:\n${current}`);
  await settled(); assert.equal(f.calls.length, 2);
  assert.equal((f.calls[1]!.request.sources as { text: string }[])[0]!.text, 'const TRANSFER_AFTER = 2;');
});

test('host renderer transfer: retiring an old subtree preserves a descendant already moved to the live root', async () => {
  const f = fixture(false, false, {}, undefined, true), a = written(f, 'const TRANSFER_A = 1;'), b = written(f, 'const TRANSFER_B = 2;');
  const branch = new Container(); f.ui.clear(); branch.addChild(a); branch.addChild(b); f.ui.addChild(branch);
  f.document(); await settled(); const before = f.render(a), key = f.env.capturedKeys[f.env.pi.indexOf('const TRANSFER_A = 1;')]!, calls = f.env.pi.length;
  f.ui.clear(); f.ui.addChild(a); await settled();
  assert.deepEqual(f.render(a), before); assert.equal(f.sources.stats().piSourceRecords, 1);
  assert.ok(f.sources.borrowPiSource(key)); assert.equal(f.env.pi.length, calls);
  branch.removeChild(a); assert.deepEqual(f.render(a), before);
  f.ui.removeChild(a); assert.equal(f.sources.stats().piSourceRecords, 0, 'ordinary removal remains synchronous');
});

async function weakRendererClear(f: ReturnType<typeof fixture>) {
  const tool = written(f, 'const TRANSFER_GC = 1;'); f.render(tool); await settled();
  const original = globalThis.queueMicrotask, pending: (() => void)[] = [];
  globalThis.queueMicrotask = callback => pending.push(callback);
  try { f.ui.clear(); } finally { globalThis.queueMicrotask = original; }
  assert.equal(pending.length, 1, 'one pending retirement callback for the renderer clear');
  return { weak: new WeakRef(tool), pending };
}
test('host renderer transfer: pending retirement does not retain the removed first owner', async () => {
  assert.ok(global.gc, 'prepared GC execution is required');
  const f = fixture(false, false, {}, undefined, true), old = await weakRendererClear(f);
  let collected = false;
  for (let i = 0; i < 40; i++) { await settled(); global.gc!(); await settled(); if (!old.weak.deref()) { collected = true; break; } }
  assert.equal(collected, true, 'a live retirement callback must not keep source/card/owner data alive');
  for (const callback of old.pending) callback();
  await settled(); assert.equal(f.sources.stats().piSourceRecords, 0); assert.equal(f.adapter.cacheStats().entries, 0);
});

test('host bounded file classification retains full visible suffix and exact tool data', async () => {
  const f = fixture(), prefix = 'x'.repeat(8191) + '\n', text = prefix + 'UNCLASSIFIED_TAIL';
  const tool = written(f, text), saved = JSON.stringify({ args: tool.args, result: tool.result });
  tool.setExpanded(true);
  f.render(tool, 8300); await settled();
  assert.equal(f.env.pi.length, 1); assert.equal(f.env.pi[0]!.length, prefix.length);
  const rows = plain(f.render(tool, 8300));
  assert.ok(rows.some(row => row.includes('UNCLASSIFIED_TAIL')));
  assert.equal(JSON.stringify({ args: tool.args, result: tool.result }), saved);
  tool.updateArgs({ path: 'a.ts', content: prefix + 'CHANGED_TAIL' }); f.render(tool, 8300); await settled();
  assert.equal(f.env.pi.length, 1); assert.ok(plain(f.render(tool, 8300)).some(row => row.includes('CHANGED_TAIL')));
});


test('prepared host unchanged file frames do no geometry dependency reads or per-row charge borrows', async () => {
  const f = fixture(), tool = written(f, Array.from({ length: 80 }, (_, i) => `const item${i} = ${i};`).join('\n'));
  f.render(tool); await settled();
  const first = f.render(tool), valid = Object.getOwnPropertyDescriptor(CardLayout.prototype, 'isValid')!;
  const retain = DataCharge.prototype.retain, release = DataCharge.prototype.release;
  let dependencies = 0, retains = 0, releases = 0;
  Object.defineProperty(CardLayout.prototype, 'isValid', { ...valid, get() { dependencies++; return valid.get!.call(this); } });
  DataCharge.prototype.retain = function() { retains++; return retain.call(this); };
  DataCharge.prototype.release = function() { releases++; return release.call(this); };
  let same = true;
  try { for (let i = 0; i < 10; i++) same = (f.render(tool) === first) && same; }
  finally { Object.defineProperty(CardLayout.prototype, 'isValid', valid); DataCharge.prototype.retain = retain; DataCharge.prototype.release = release; }
  assert.equal(dependencies, 0, 'unchanged geometry identity requires no dependency walk');
  assert.ok(retains < 300 && releases < 300, 'row-charge work must not scale with the retained body');
  assert.equal(same, true);
  console.log(JSON.stringify({ warmPreparedRows: { rows: first.length, frames: 10, dependencies, retains, releases, same } }));
});


test('prepared host rapid collapsed output updates bound both logical sections before full expansion without source work', async () => {
  const f = fixture(), args = { command: 'UNIQUE_COLLAPSED_COMMAND' }, tool = f.tool('bash', args);
  const terminal = { rows: 24 }; Object.assign(f.ui, { terminal });
  tool.setArgsComplete(); f.render(tool); await settled();
  const segment = Intl.Segmenter.prototype.segment;
  let output = 0, reminder = 0, command = 0;
  Intl.Segmenter.prototype.segment = function(text) {
    if (text.startsWith('OUTPUT_ROW_')) output++;
    if (text.startsWith('REMINDER_ROW_')) reminder++;
    if (text.startsWith(args.command)) command++;
    return segment.call(this, text);
  };
  const before = sourceCounts(f), originalArgs = JSON.stringify(tool.args);
  let saved = '';
  try {
    for (let update = 0; update < 6; update++) {
      saved = [...Array.from({ length: 200 }, (_, i) => `OUTPUT_ROW_${i}_${update}`), '', '<system-reminder>',
        ...Array.from({ length: 200 }, (_, i) => `REMINDER_ROW_${i}_${update}`), '</system-reminder>'].join('\n');
      const a = output, b = reminder;
      tool.updateResult({ content: [{ type: 'text', text: saved }] }, false);
      assert.ok(output - a <= 11 && reminder - b <= 11, `update ${update}: measured ${output - a} output/${reminder - b} reminder rows`);
      const rows = plain(f.render(tool));
      assert.ok(rows.some(row => row.includes(`OUTPUT_ROW_0_${update}`)) && rows.some(row => row.includes(`REMINDER_ROW_0_${update}`)));
      assert.equal(rows.filter(row => row.includes('Click to expand')).length, 2);
      assert.ok(!rows.some(row => row.includes('ROW_199_')));
      assert.equal(tool.result.content[0].text, saved, 'service preparation must not rewrite the original result');
    }
    const collapsed = [output, reminder];
    for (const width of [24, 100, 60]) f.render(tool, width);
    for (const height of [12, 40, 24]) { terminal.rows = height; f.document(); }
    assert.deepEqual([output, reminder], collapsed, 'warm, width and height-only document frames prepare no new service measurements');
    tool.setExpanded(true);
    const expanded = plain(f.render(tool));
    assert.ok(expanded.some(row => row.includes('OUTPUT_ROW_199_5')) && expanded.some(row => row.includes('REMINDER_ROW_199_5')));
    assert.equal(expanded.filter(row => row.includes('OUTPUT_ROW_')).length, 200);
    assert.equal(expanded.filter(row => row.includes('REMINDER_ROW_')).length, 200);
    const full = [output, reminder];
    tool.setExpanded(false); f.render(tool); tool.setExpanded(false); f.render(tool);
    assert.deepEqual([output, reminder], full, 'collapse reuses retained preview measurements');
    tool.setExpanded(true); f.render(tool);
    assert.equal(command, 0); assert.equal(JSON.stringify(tool.args), originalArgs);
    assert.equal(tool.result.content[0].text, saved);
    console.log(JSON.stringify({ collapsedServicePreparation: { updates: 6, collapsed, expanded: full, command } }));
  } finally { Intl.Segmenter.prototype.segment = segment; }
  await settled(); assert.deepEqual(sourceCounts(f), before);
});


for (const [label, initial, completed] of [
  ['modifier', '👍\ud83c', '👍🏽'], ['regional indicator', '🇦\ud83c', '🇦🇧'], ['ZWJ', '👩\u200d\ud83d', '👩‍💻'],
] as const) test(`review R1: actual host surrogate-completed ${label} renders like one complete command`, async () => {
  const f = fixture(), streamed = f.tool('bash', { command: initial });
  f.render(streamed, 9); await settled();
  streamed.updateArgs({ command: completed });
  const actual = plain(f.render(streamed, 9)).filter(row => row !== '');
  const reference = f.tool('bash', { command: completed });
  const expected = plain(f.render(reference, 9)).filter(row => row !== '');
  assert.deepEqual(actual, expected, 'streaming must not wrap or paint within the completed grapheme');
  assert.equal(streamed.args.command, completed); assert.equal(f.env.pi.length, 0);
});

function roundTwoStyleReply(q: Record<string, any>) {
  return { v: PROTOCOL_VERSION, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintRules(q.rules),
    styles: [{ foreground: { kind: 'rgb', r: 17, g: 34, b: 51 }, background: { kind: 'inherit' }, attributes: 0, attribute_mask: 0 }],
    indices: q.contexts.map(() => 1) } };
}

for (const occupied of [true, false]) test(`syntax host: cached Follow Pi rollback from native ${occupied ? 'with both DATA credits occupied' : '(control: free credits)'}`, async () => {
   const f = fixture(true), owned = 'gruvbox-dark';
  const tool = written(f, 'const rollback = 1;'); f.render(tool); await settled();
  answer(f, 0, 'const rollback = 1;'); await settled(); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  assert.equal(f.sources.displayBasis(key)?.palette, 'pi:1:truecolor', 'initial Follow Pi display');
  const initialRows = f.render(tool);
   f.env.selected = palettePreference(owned); f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
   assert.equal(f.sources.displayBasis(key)?.palette, `theme:${owned}:owned-palette-v1:${owned}:truecolor`, 'owned palette display');
  if (occupied) {
    for (const command of ['echo held-one', 'echo held-two']) { const held = f.tool('bash', { command }); held.setArgsComplete(); f.render(held); }
    await settled(); assert.equal(f.calls.length, 3, 'both physical DATA credits held by unrelated SOURCE');
  }
  const styles = f.env.styleRequests.length, sources = f.calls.length;
  f.env.selected = { kind: 'pi', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.env.styleRequests.length, styles, 'Follow Pi styles are cached');
  assert.equal(f.calls.length, sources);
   assert.match(f.sources.displayBasis(key)?.palette ?? '', /^pi:/, 'cached Follow Pi rollback publishes before unrelated work settles');
  assert.deepEqual(f.render(tool), initialRows, 'actual card restores exact Follow Pi text, colors and attributes');
  const warm = counts(f); for (let i = 0; i < 10; i++) f.render(tool); await settled();
  assert.deepEqual(counts(f), warm, 'cached rollback does not repeat source or classifier work on warm frames');
});

for (const interrupt of [true, false]) test(`syntax host: previously requested STYLE success after live interruption ${interrupt ? 'applies valid v4 colors' : '(control: live card publishes v4)'}`, async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'echo a' });
  f.render(tool); await settled(); answer(f, 0, 'echo a', false, 0); await settled();
  const initialRows = f.render(tool), initialCells = await hostCells(initialRows);
  const initialE = initialCells.flat().find(cell => cell.text === 'e')?.fg;
  assert.notEqual(initialE, undefined); assert.ok(await hasHostInk(initialRows, themes.theme, 'syntaxKeyword', 'echo a'), 'V1 ready display');
  const key = f.env.keys[0]!, v1 = f.sources.displayBasis(key)!;
  f.env.holdStyles = true;
  tool.updateArgs({ command: 'echo a b' }); f.render(tool); await settled();
  const append = f.calls[1]!, r = append.request; assert.equal(r.op, 'stream.append');
  append.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'source', vocabulary: description.vocabulary.fingerprint, sources: [{ key: r.key, generation: r.generation, source_version: r.source_version,
      revision: (r.base_revision as number) + 1, replace_from: 0, source_bytes: 8, committed_bytes: 0, complete: false, lease: 'lease',
      contexts: [[0, 1], [0, 2]], runs: [6, 1, 2, 2], counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 1, tail_bytes: 8 } }] } });
  await settled(); assert.equal(f.styleCalls.length, 1, 'V2 STYLE dispatched and held');
  if (interrupt) {
    tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool); await settled();
    for (const call of f.calls.slice(2)) if (call.request.op === 'stream.close')
      call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
    await settled();
  }
  f.env.holdStyles = false;
  const held = f.styleCalls[0]!; held.resolve(roundTwoStyleReply(held.request)); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  const after = f.sources.displayBasis(key);
  assert.ok(after && after.version > v1.version, 'valid V2 colors publish both before and after interruption');
  let shown = ''; after.visit(text => { shown = text; }); assert.equal(shown, 'echo a b');
  const finalRows = f.render(tool), finalCells = await hostCells(finalRows);
  assert.ok(plain(finalRows).join('\n').includes('echo a b'));
  assert.ok(finalCells.some(row => row.some(cell => cell.text === 'e' && cell.fg === initialE)), 'the unchanged V1 expression keeps its prior published style');
  assert.ok(finalCells.some(row => row.some(cell => cell.text === 'b' && cell.fg === ((17 << 16) | (34 << 8) | 51))),
    'the new V2 expression receives its completed literal STYLE ink, including after interruption');
  if (interrupt) { const requests = f.calls.length; for (let i = 0; i < 5; i++) f.render(tool); await settled(); assert.equal(f.calls.length, requests, 'interruption never resumes SOURCE or lease work'); }
});


test('host native completion precedes delayed Bash prefix adoption; only adopted frames are warm', { timeout: 12000 }, async t => {
  let requested!: () => void, delivered!: () => void;
  const sourceRequested = new Promise<void>(resolve => { requested = resolve; });
  const notificationHeld = new Promise<void>(resolve => { delivered = resolve; });
  const f = fixture(true, false, { diagnostic: (_level, _area, explanation, fields) => {
    if (explanation === 'Native job dispatched' && fields?.operation === 'highlight') requested();
  } });
  const command = "printf 'USER_BASH_OUTPUT\\n'", tool = f.tool('bash', { command }, undefined, true);
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'USER_BASH_OUTPUT' }], isError: false }, false);
  const observer = observeSyntaxLocalWork(), notify = f.sources.notifyChange;
  let release: (() => void) | undefined, held = false;
  t.mock.method(f.sources, 'notifyChange', function(this: SourceController, epoch: number) {
    // Retain one real presentation notification after native SOURCE/STYLE settle.
    if (!held && f.env.styleRequests.length > 0 && this.stats().globalUnsettledJobs === 0) {
      held = true; release = () => notify.call(this, epoch); delivered(); return;
    }
    return notify.call(this, epoch);
  });
  try {
    f.render(tool); await sourceRequested;
    assert.equal(f.calls.length, 1); answer(f, 0, command);
    await notificationHeld;
    assert.equal(f.sources.stats().globalUnsettledJobs, 0, 'the old backend-only readiness condition has completed');
    const early = observer.snapshot(), source = sourceCounts(f);
    assert.equal(early.prefixScalarReads, 0, 'the real local completion is still held');
    assert.ok(release); const resume = release; release = undefined; resume();
    const adopted = observer.snapshot();
    assert.equal(adopted.prefixScalarReads - early.prefixScalarReads, 2 * command.length,
      'one first proof reads both identical ASCII strings once, explaining a possible +54 after an early baseline');
    assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', command));
    for (const width of [60, 100, 100]) f.document(width);
    assert.deepEqual(observer.snapshot(), adopted, 'actual width-only frames repeat no adopted prefix proof');
    assert.deepEqual(sourceCounts(f), source, 'adoption and warm frames admit no new source or Pi work');
    console.log(JSON.stringify({ delayedPrefixAdoption: { early, adopted, nativeJobs: 0, proofCalls: 1 } }));
  } finally { release?.(); observer.restore(); }
});


test('completion boundary: held native notification includes actual Bash prefix adoption', { timeout: 12000 }, async t => {
  let requested!: () => void, held!: () => void;
  const sourceRequested = new Promise<void>(resolve => { requested = resolve; });
  const notificationHeld = new Promise<void>(resolve => { held = resolve; });
  const f = fixture(true, false, { diagnostic: (_level, _area, explanation, fields) => {
    if (explanation === 'Native job dispatched' && fields?.operation === 'highlight') requested();
  } });
  const command = "printf 'SETTLED_BASH_OUTPUT\\n'", tool = f.tool('bash', { command }, undefined, true);
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'SETTLED_BASH_OUTPUT' }], isError: false }, false);
  const observer = observeSyntaxLocalWork(text => text.includes('SETTLED_BASH_OUTPUT')), notify = f.sources.notifyChange;
  let release: (() => void) | undefined, retained = false, completed = false;
  t.mock.method(f.sources, 'notifyChange', function(this: SourceController, epoch: number) {
    if (!retained && f.env.styleRequests.length > 0 && this.stats().globalUnsettledJobs === 0) {
      retained = true; release = () => notify.call(this, epoch); held(); return;
    }
    return notify.call(this, epoch);
  });
  try {
    f.render(tool); await sourceRequested;
    const completion = f.sources.whenSettled();
    assert.equal(f.sources.whenSettled() === completion, true, 'one shared pending completion per owner');
    void completion.then(() => { completed = true; });
    answer(f, 0, command); await notificationHeld; await turn();
    assert.equal(f.sources.stats().globalUnsettledJobs, 0);
    assert.equal(observer.snapshot().prefixScalarReads, 0, 'application remains held after native settlement');
    assert.equal(completed, false, 'zero native jobs cannot acknowledge pending delivery');
    assert.ok(release); const resume = release; release = undefined; resume();
    assert.equal(await completion, true);
    assert.equal(observer.snapshot().prefixScalarReads, 2 * command.length, 'completion follows the actual first prefix proof');
    assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', command));
    const warm = observer.snapshot(); f.document(100); f.document(60);
    assert.deepEqual(observer.snapshot(), warm);
  } finally { release?.(); observer.restore(); }
});


test('compatible third-party file renderers keep file cards while self-shell visibility stays native-owned', () => {
  const f = fixture(true);
  const args = { path: '/tmp/foreign-write.ts', content: 'const foreign = 1;\n' };
  const result = { content: [{ type: 'text' as const, text: 'FOREIGN_RESULT' }], isError: false };
  let selfCall = 0, selfResult = 0, mixedResult = 0;
  const selfDefinition = {
    ...createWriteToolDefinition('/tmp'),
    renderShell: 'self' as const,
    renderCall: (_args: unknown, _theme: unknown) => { selfCall++; return new Text('FOREIGN_CALL', 0, 0); },
    renderResult: (_result: unknown) => { selfResult++; return new Text('FOREIGN_RESULT', 0, 0); },
  } as ToolDefinition;
  const self = f.tool('write', args, selfDefinition);
  self.updateResult(result, false);
  self.setExpanded(true);
  const selfRows = plain(f.render(self, 80)).join('\n');
  assert.match(selfRows, /← Wrote foreign-write\.ts/u);
  assert.match(selfRows, /foreign/iu);
  assert.equal(self.getCallRenderer(), selfDefinition.renderCall, 'foreign call callback stays installed');
  assert.equal(self.getResultRenderer(), selfDefinition.renderResult, 'foreign result callback stays installed');
  assert.ok(selfCall > 0 && selfResult > 0, 'actual-width self visibility uses the foreign renderer callbacks');

  const lazy = resolvePublicFileToolDefinition('write', createWriteToolDefinition('/tmp')) as ToolDefinition;
  const foreignResult = (_result: unknown) => { mixedResult++; return new Text('MIXED_FOREIGN_RESULT', 0, 0); };
  const mixedDefinition = { ...lazy, renderResult: foreignResult } as ToolDefinition;
  const mixed = f.tool('write', { path: '/tmp/mixed-write.ts', content: 'const mixed = 1;\n' }, mixedDefinition);
  mixed.updateResult(result, false);
  const deferredCall = mixed.callRendererComponent as unknown as { render(width: number): string[]; component?: { render(width: number): string[] } };
  deferredCall.render(80);
  const nativeCall = deferredCall.component;
  assert.ok(nativeCall, 'the mixed pair can retain its already materialized stock call component');
  let nativeCallRenders = 0;
  const renderNativeCall = nativeCall.render.bind(nativeCall);
  nativeCall.render = (width) => { nativeCallRenders++; return renderNativeCall(width); };
  const mixedCallsBeforePresentation = mixedResult;
  const mixedRows = plain(f.render(mixed, 80)).join('\n');
  assert.match(mixedRows, /← Write mixed-write\.ts/u, 'a mixed stock/third-party pair retains the compatible preview');
  assert.match(mixedRows, /1 const mixed = 1;/u, 'the bounded source rows remain visible');
  assert.equal(mixed.getResultRenderer(), foreignResult, 'mixed-pair callback is not wrapped or removed');
  assert.equal(mixedResult, mixedCallsBeforePresentation, 'the custom file card does not add foreign result-render work');
  deferredCall.render(80);
  assert.equal(nativeCallRenders, 1, 'presenting a mixed pair does not evict its already materialized stock half');

  let boxCall = 0, boxResult = 0;
  const boxDefinition = {
    ...createWriteToolDefinition('/tmp'),
    renderCall: (_args: unknown, _theme: unknown) => { boxCall++; const box = new Box(); box.addChild(new Text('BOX_CALL', 0, 0)); return box; },
    renderResult: (_result: unknown) => { boxResult++; const box = new Box(); box.addChild(new Text('BOX_RESULT', 0, 0)); return box; },
  } as ToolDefinition;
  const box = f.tool('write', { path: '/tmp/box-write.ts', content: 'const boxed = 2;\n' }, boxDefinition);
  box.updateResult(result, false); box.setExpanded(true);
  const callbacksBeforePresentation = [boxCall, boxResult];
  const boxRows = plain(f.render(box, 80)).join('\n');
  assert.match(boxRows, /← Wrote box-write\.ts/u, 'a third-party Box renderer keeps the compatible full file card');
  assert.match(boxRows, /boxed/u);
  assert.equal(box.getCallRenderer(), boxDefinition.renderCall);
  assert.equal(box.getResultRenderer(), boxDefinition.renderResult);
  assert.deepEqual([boxCall, boxResult], callbacksBeforePresentation, 'custom Box presentation adds no foreign renderer work');

  const hiddenDefinition = {
    ...createWriteToolDefinition('/tmp'),
    renderShell: 'self' as const,
    renderCall: (_args: unknown, _theme: unknown) => new Text('', 0, 0),
    renderResult: (_result: unknown) => new Text('', 0, 0),
  } as ToolDefinition;
  const hidden = f.tool('write', { path: '/tmp/hidden-foreign.ts', content: 'const hidden = 1;\n' }, hiddenDefinition);
  hidden.updateResult(result, false);
  hidden.setExpanded(true);
  assert.deepEqual(f.render(hidden, 80), [], 'an empty self renderer remains hidden rather than being replaced by a custom card');
});


test('native and hidden file successes consume rolling recency without changing their presentation', async () => {
  const f = fixture(false, false, { cards: ['edit'] });
  try {
    f.adapter.beginFileTurn();
    const entries: ReturnType<typeof f.tool>[] = [];
    const stringField = (tool: ReturnType<typeof f.tool>, name: string) => {
      const value = Reflect.get(tool, name);
      if (typeof value !== 'string') throw new TypeError(`Expected ${name} to be a string`);
      return value;
    };
    for (let i = 0; i < 9; i++) entries.push(f.tool('write', { path: `window-${i}.ts`, content: `const window_${i} = ${i};` }));
    const native = f.tool('edit', { path: 'window-native.ts', edits: [{ oldText: 'before', newText: 'after' }] });
    entries.push(native);
    for (const tool of entries) f.render(tool, 80);
    for (const tool of [...entries].reverse()) f.adapter.completeFileCall(stringField(tool, 'toolCallId'));
    for (const tool of [...entries].reverse()) {
      const result = stringField(tool, 'toolName') === 'write'
        ? { content: [{ type: 'text' as const, text: 'saved' }], isError: false }
        : { content: [{ type: 'text' as const, text: 'saved' }], isError: false, details: { diff: '-1 before\n+1 after' } };
      tool.updateResult(result, false);
    }
    const nativeBefore = f.render(native, 80);

    const hidden = f.tool('write', { path: 'window-hidden.ts', content: 'const hidden = true;' });
    f.render(hidden, 80);
    hidden.updateResult({ content: [{ type: 'text', text: 'saved' }], isError: false }, false);
    hidden.hideComponent = true;
    f.ui.removeChild(hidden);
    f.adapter.completeFileCall(stringField(hidden, 'toolCallId'));
    f.ui.addChild(hidden);
    const hiddenBefore = f.render(hidden, 80);

    const newest = f.tool('write', { path: 'window-newest.ts', content: 'const newest = true;' });
    f.render(newest, 80);
    f.adapter.completeFileCall(stringField(newest, 'toolCallId'));
    newest.updateResult({ content: [{ type: 'text', text: 'saved' }], isError: false }, false);
    f.adapter.finishFileTurn();

    assert.deepEqual(f.render(native, 80), nativeBefore, 'native override output remains native across window accounting');
    assert.deepEqual(f.render(hidden, 80), hiddenBefore, 'hidden file output remains hidden across window accounting');
    hidden.hideComponent = false;
    const nextTurn = f.tool('write', { path: 'window-next-turn.ts', content: 'const next_turn = true;' });
    f.adapter.beginFileTurn(); f.render(nextTurn, 80); f.adapter.completeFileCall(nextTurn.toolCallId);
    nextTurn.updateResult({ content: [{ type: 'text', text: 'saved' }], isError: false }, false); f.adapter.finishFileTurn();
    const automatic = [...entries.slice(0, 9), hidden, newest, nextTurn];
    automatic.forEach(tool => f.render(tool, 80));
    await settled();
    const views = automatic.map(tool => plain(f.render(tool, 80)).join('\n'));
    for (const index of [0, 1, 2]) {
      assert.match(views[index]!, new RegExp(`Write window-${index}\\.ts`), `older successful write ${index} must be demoted by all later calls`);
      assert.doesNotMatch(views[index]!, new RegExp(`Wrote window-${index}\\.ts`));
    }
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10, 11]) assert.match(views[index]!, /Wrote window-/,
      `the ten most recent successes, including native and hidden calls across turns, remain in the automatic full window: ${index}`);
  } finally { f.adapter.restore(); }
});


test('target refusal leaves the warm sibling presentation cache built on its own visit', async () => {
  const f = fixture(true);
  const originalUpdate = CardSources.prototype.updateDisplay;
  let sibling: ReturnType<typeof f.tool> | undefined, target: ReturnType<typeof f.tool> | undefined;
  let denyTarget = false, siblingUpdates = 0;
  CardSources.prototype.updateDisplay = function(owner, input) {
    if (owner === sibling) siblingUpdates++;
    if (owner === target && denyTarget) return false;
    return originalUpdate.call(this, owner, input);
  };
  const result = { content: [{ type: 'text' as const, text: 'saved' }], isError: false };
  try {
    sibling = f.tool('write', { path: '/tmp/warm-sibling.ts', content: Array.from({ length: 14 }, (_, index) => `const warm_sibling_row_${index} = ${index};`).join('\n') }, createWriteToolDefinition('/tmp'));
    sibling.updateResult(result, false); sibling.setExpanded(true);
    f.render(sibling, 80); await settled();
    const warmRows = plain(f.render(sibling, 80)).join('\n');
    assert.match(warmRows, /warm_sibling_row_13/u, 'the unrelated sibling has an admitted full tail before target refusal');
    const warmedBuilds = f.adapter.cacheStats().builds;

    target = f.tool('write', { path: '/tmp/refused-target.ts', content: 'const refused_target = 2;\n' }, createWriteToolDefinition('/tmp'));
    denyTarget = true;
    target.updateResult(result, false); target.setExpanded(true); await settled();
    const refusalRows = plain(f.render(target, 80)).join('\n');
    assert.match(refusalRows, /budget/u, 'the target receives a controlled normal construction refusal');

    const buildsBeforeSiblingVisit = f.adapter.cacheStats().builds;
    assert.ok(buildsBeforeSiblingVisit >= warmedBuilds, 'target refusal may build or release only its own presentation');
    siblingUpdates = 0;
    const before = f.adapter.cacheStats().builds;
    const siblingAfter = plain(f.render(sibling, 80)).join('\n');
    const after = f.adapter.cacheStats().builds;
    assert.match(siblingAfter, /warm_sibling/u, 'the sibling retains its full rows after target refusal');
    assert.equal(siblingUpdates, 0, 'the sibling-only render does not re-admit its saved source');
    assert.equal(after, before, 'the sibling-only render does not rebuild its warm layout after target notification');
  } finally {
    CardSources.prototype.updateDisplay = originalUpdate;
    f.adapter.restore();
  }
});


for (const kind of ['write', 'edit'] as const) for (const refusal of ['palette', 'paint'] as const)
test(`supported collapsed ${kind} preview reports refused ${refusal} and recovers without expansion`, async () => {
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.enabled = false; await f.sources.setEnabled(false);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  const marker = `F2_PAINT_REFUSAL_${kind}_PREVIEW`, content = `const ${marker} = 1;`;
  const work = observeSyntaxLocalWork(text => text.includes(marker)), probe = paintFundingProbe(f, refusal);
  const geometryFunding = f.sources.geometryFunding; let denyLayout = false;
  f.sources.geometryFunding = group => {
    const funding = geometryFunding.call(f.sources, group);
    return funding && { budget: funding.budget, grant: bytes => denyLayout && f.env.depth > 0 ? undefined : funding.grant(bytes) };
  };
  const updateDisplay = CardSources.prototype.updateDisplay; let acceptedPreviewInputs = 0;
  CardSources.prototype.updateDisplay = function (owner, input) {
    const accepted = updateDisplay.call(this, owner, input);
    if (accepted && input.kind === 'file' && input.viewMode === 'preview') acceptedPreviewInputs++;
    return accepted;
  };
  try {
    const tool = f.tool(kind, kind === 'write' ? { path: 'preview-retry.ts', content }
      : { path: 'preview-retry.ts', oldText: 'old', newText: content },
      kind === 'write' ? createWriteToolDefinition('/tmp') : createEditToolDefinition('/tmp'), true);
    tool.updateResult({ content: [{ type: 'text', text: 'saved' }], isError: false,
      ...(kind === 'edit' ? { details: { diff: `@@ -1 +1 @@\n-old\n+${content}` } } : {}) }, false); await settled();
    const refused = plain(f.render(tool, 60)).join('\n');
    assert.ok(acceptedPreviewInputs > 0, 'CardSources accepted the supported collapsed preview');
    assert.ok(probe.snapshot().deniedPreparationBytes > 0, `the actual preview ${refusal} grant was refused`);
    assert.match(refused, /unavailable within the current\s+preparation\s+or\s+paint\s+budget/u);
    assert.ok(!refused.includes(marker), 'unpainted preview source is not exposed through a fallback');
    const before = { ...work.snapshot(), requests: f.calls.length, styles: f.env.styleRequests.length };
    const requests = f.ui.requests;
    for (let i = 0; i < 3; i++) { f.render(tool, 60); await settled(); }
    assert.equal(f.ui.requests, requests, 'refused previews do not create a frame loop');
    probe.recover(); denyLayout = true; f.render(tool, 60); await settled();
    assert.equal(f.ui.requests, requests + 1, 'preview paint recovery requests one frame');
    assert.match(plain(f.render(tool, 60)).join('\n'), /unavailable within the current\s+geometry\s+budget/u);
    for (let i = 0; i < 3; i++) { f.render(tool, 60); await settled(); }
    assert.equal(f.ui.requests, requests + 1, 'continued preview geometry refusal does not rearm status frames');
    denyLayout = false;
    const recovered = plain(f.render(tool, 60)).join('\n'); await settled();
    assert.ok(recovered.includes(marker), `same collapsed preview recovers without expansion: ${recovered}`);
    assert.equal(probe.snapshot().deniedLogicalBytes, 0, 'preview recovery requests no duplicate logical grant');
    assert.deepEqual({ ...work.snapshot(), requests: f.calls.length, styles: f.env.styleRequests.length }, before,
      'preview paint recovery does not remeasure or request SOURCE/STYLE');
  } finally {
    denyLayout = false; probe.allow(); CardSources.prototype.updateDisplay = updateDisplay;
    probe.restore(); work.restore();
  }
});

test('same-source palette updates reuse the charged file descriptor under construction pressure', async () => {
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.enabled = false; await f.sources.setEnabled(false);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged(); await settled();
  const marker = 'RETAINED_DESCRIPTOR_PALETTE', text = `const ${marker} = 1;`;
  const tool = f.tool('read', { path: 'retained-descriptor.txt' }, createReadToolDefinition('/tmp'));
  tool.updateResult({ content: [{ type: 'text', text }], isError: false }, false); tool.setExpanded(true);
  f.render(tool); await settled();
  assert.ok(plain(f.render(tool)).join('\n').includes(text), 'a full display is already funded');
  const work = observeSyntaxLocalWork(source => source.includes(marker)), probe = paintFundingProbe(f);
  const updateDisplay = CardSources.prototype.updateDisplay; let updates = 0;
  CardSources.prototype.updateDisplay = function (owner, input) { updates++; return updateDisplay.call(this, owner, input); };
  try {
    probe.recover();
    f.env.selected = { kind: 'theme', id: 'nord', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
    tool.invalidate(); await settled();
    f.render(tool); await settled();
    const rows = plain(f.render(tool)).join('\n');
    assert.ok(updates > 0, 'the palette change reaches the actual update boundary');
    assert.ok(rows.includes(text), `the accepted body survives with no duplicate descriptor funds: ${rows}`);
    assert.equal(probe.snapshot().deniedLogicalBytes, 0, 'same-source palette update reuses its descriptor charge');
    assert.equal(work.snapshot().sourceSegments, 0, 'palette replacement retains source row measurements');
  } finally {
    CardSources.prototype.updateDisplay = updateDisplay; probe.allow(); probe.restore(); work.restore();
  }
});


test('a retained detached Bash renders natively without disabling the live adapter', async () => {
  const f = fixture();
  const detached = f.tool('bash', { command: 'printf DETACHED_BASH_COMMAND' }, createBashToolDefinition('/tmp'));
  detached.setArgsComplete();
  detached.updateResult({ content: [{ type: 'text', text: 'DETACHED_BASH_RESULT' }], isError: false }, false);
  f.render(detached); await settled();
  const attachedRows = plain(f.render(detached)).join('\n');
  assert.equal(detached.hideComponent, false, 'the real completed Bash is visible');
  assert.ok(attachedRows.includes('DETACHED_BASH_COMMAND') && attachedRows.includes('┃'), 'the removed card is owned before removal');
  const sibling = written(f, 'const LIVE_SIBLING_AFTER_DETACH = 1;');
  sibling.setExpanded(true); f.render(sibling); await settled();
  assert.ok(plain(f.render(sibling)).some(row => row.startsWith(' ┃')), 'the sibling starts in owned presentation');
  const native = plain(nativeToolRender.call(detached, 60));
  f.ui.removeChild(detached); await settled();
  assert.equal(f.ui.children.includes(detached), false, 'the public Container removal detached this owner');
  const requests = f.ui.requests;
  assert.deepEqual(plain(f.render(detached)), native, 'the retained former component keeps its complete native rows');
  assert.equal(f.ui.requests, requests, 'a detached render requests no recovery or failure frame');
  assert.equal(f.adapter.reason, undefined, 'the cleanup boundary is not a compatibility failure');
  assert.equal(f.adapter.active, true, 'a legitimate detached render must not disable the adapter');
  const live = plain(f.render(sibling)).join('\n');
  assert.ok(live.includes('LIVE_SIBLING_AFTER_DETACH') && live.includes('┃'), 'the mounted sibling remains owned');
});


for (const refusal of ['palette', 'paint'] as const) test(`bash transition: refused first ${refusal} keeps compact arguments until ordinary recovery`, async () => {
  const f = fixture(false, false, {}, undefined, false, true);
  f.env.selected = { kind: 'theme', id: 'gruvbox', variant: 'dark' }; f.adapter.syntaxMetadataChanged();
  const probe = paintFundingProbe(f, refusal);
  try {
    const tool = f.tool('bash', { command: 'echo BASH_PAINT_TRANSITION' }, createBashToolDefinition('/tmp'));
    tool.setExpanded(true);
    assert.ok(probe.snapshot().deniedPreparationBytes > 0, 'a real card palette/paint reservation is refused');
    const fallback = plain(f.render(tool)).join('\n');
    assert.match(fallback, /⚙ bash/u); assert.match(fallback, /BASH_PAINT_TRANSITION/u);
    assert.doesNotMatch(fallback, /┃/u);
    const work = counts(f), requests = f.ui.requests;
    for (let index = 0; index < 4; index++) f.render(tool);
    assert.deepEqual(counts(f), work, 'compact frames do not retry source preparation');
    assert.equal(f.ui.requests, requests, 'compact refusal does not create a repaint loop');
    probe.allow(); tool.updateArgs({ ...tool.args, description: 'RECOVERED_PAINT' });
    const recovered = plain(f.render(tool)).join('\n');
    assert.match(recovered, /┃/u); assert.match(recovered, /BASH_PAINT_TRANSITION/u);
    assert.match(recovered, /RECOVERED_PAINT/u);
    assert.equal(f.env.pi.length, 0, 'Bash does not use the Pi classifier while switching presentation');
  } finally { probe.allow(); probe.restore(); }
});

test('bash transition: refused geometry uses compact spacing and recovers without source work', async () => {
  const f = fixture(), tool = f.tool('bash', { command: 'echo GEOMETRY_TRANSITION' }, createBashToolDefinition('/tmp'));
  const next = f.tool('grep', { pattern: 'AFTER_BASH' });
  const funding = f.sources.geometryFunding;
  let denied = 0, blocked = true;
  f.sources.geometryFunding = group => {
    const available = funding.call(f.sources, group);
    return available && { budget: available.budget, grant(bytes) {
      if (blocked && f.env.depth > 0) { denied++; return undefined; }
      return available.grant(bytes);
    } };
  };
  try {
    assert.match(plain(f.render(tool)).join('\n'), /⚙ bash/u);
    assert.ok(denied > 0, 'the frame actually fails geometry admission');
    assert.notEqual(f.render(next)[0], '', 'the rendered compact predecessor contributes no framed gap');
    const before = sourceCounts(f);
    blocked = false;
    const recovered = plain(f.render(tool)).join('\n');
    assert.match(recovered, /┃/u); assert.match(recovered, /GEOMETRY_TRANSITION/u);
    assert.equal(f.render(next)[0], '', 'the recovered frame contributes the ordinary separator');
    assert.deepEqual(sourceCounts(f), before, 'layout recovery does not prepare or classify source again');
  } finally { f.sources.geometryFunding = funding; }
});


for (const expanded of [false, true]) test(`bash transition: executing compact refusal shares the spinner and retires on frame takeover (${expanded})`, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const f = fixture(false), tool = f.tool('bash', { command: 'echo SPINNER_TRANSITION' }, createBashToolDefinition('/tmp'));
  tool.markExecutionStarted(); tool.setExpanded(expanded);
  const funding = f.sources.geometryFunding;
  let blocked = true;
  f.sources.geometryFunding = group => {
    const available = funding.call(f.sources, group);
    return available && { budget: available.budget, grant(bytes: number) {
      return blocked && f.env.depth > 0 ? undefined : available.grant(bytes);
    } };
  };
  try {
    const glyph = () => plain(f.document()).find(row => row.includes(' bash '))?.[1];
    assert.match(glyph() ?? '', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, 'executing compact Bash uses the existing spinner, not a static gear');
    const builds = f.adapter.cacheStats().builds, requests = f.ui.requests, work = sourceCounts(f), seen = new Set<string>();
    for (let index = 0; index < 6; index++) {
      t.mock.timers.tick(80); seen.add(glyph() ?? '');
    }
    assert.ok(seen.size > 2, 'native document visits advance the shared spinner phase');
    assert.equal(f.adapter.cacheStats().builds, builds, 'warm spinner frames reuse the summary body');
    assert.equal(f.ui.requests, requests, 'regular document visits suppress extra fallback requests');
    assert.deepEqual(sourceCounts(f), work, 'spinner frames repeat no source preparation');
    blocked = false;
    assert.match(plain(f.document()).join('\n'), /┃.*SPINNER_TRANSITION/u);
    assert.equal(f.adapter.cacheStats().byKind.summary.entries, 0, 'the full frame releases its interim summary');
    const after = f.ui.requests;
    t.mock.timers.tick(1000);
    assert.equal(f.ui.requests, after, 'a running full Bash frame leaves no compact spinner deadline');
  } finally { f.sources.geometryFunding = funding; f.adapter.restore(); }
});
