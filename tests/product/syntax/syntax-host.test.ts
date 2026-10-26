import '../../fixtures/test-guard.mjs';
import { hostCells, hasHostInk } from '../../fixtures/host-cells.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Box, Container, Text } from '@earendil-works/pi-tui';
import { VERSION, highlightCode, getLanguageFromPath, createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { installTidyUi, type TidyUiController, type TidyUiOptions } from '../../../src/index.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { RETENTION_LIMITS } from '../../../src/occipital/retention.ts';
import type { SyntaxClient } from '../../../src/occipital/client.ts';
import type { ProviderSnapshot } from '../../../src/occipital/provider.ts';
import { OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import { SEMANTIC_PROTOCOL_VERSION as PROTOCOL_VERSION, decodeSemanticDescription } from '../../../src/occipital/semantic-protocol.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { fingerprintNative, fingerprintRules } from '../../../src/occipital/style-rules.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { observeSyntaxLocalWork } from '../../fixtures/syntax-local-work.ts';
import { CardLayout } from '../../../src/syntax/card-layout.ts';
import { DataCharge } from '../../../src/occipital/data-budget.ts';
import { bashCardFixture as renderBashCard } from '../../fixtures/prepared-card.ts';
import { fileCardFixture as renderFileCard } from '../../fixtures/prepared-card.ts';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextJournal } from '../../../src/debug-log.ts';
import type { DiagnosticFields, DiagnosticSink } from '../../../src/diagnostics.ts';

const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/components/tool-execution.js')).href);
const nativeToolRender = ToolExecutionComponent.prototype.render;
const themes = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
const profile = { id: 'pi', label: 'Pi', fingerprint: fingerprintRules(createPiRuleDefinition()) };
const description = decodeSemanticDescription(semanticDescriptor('describe', 'daemon', []), 'describe');
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const fixtures: { adapter: TidyUiController; sources: SourceController;
  calls: { request: Record<string, unknown>; resolve(value: unknown): void }[]; styleCalls: { resolve(value: unknown): void }[] }[] = [];
function fixture(ready = false, useDefaultClassifier = false, options: Pick<TidyUiOptions, 'cards' | 'compact' | 'diagnostic'> = {}, retention?: { maxBytes: number }, switchable = false) {
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
  const env = { liveCalls, ready, enabled: true, generation: 1, profile: { ...profile }, selected: { kind: 'pi' } as ReturnType<SyntaxClient['snapshot']>['selected'], palette: 1, padding: 1, depth: 0, boldPi: false, plainPi: false, pi: [] as string[], observes: 0, captures: 0, reads: 0, holdStyles: false, styleRequests: [] as Record<string, any>[], poisonPi: false, keys: [] as string[], capturedKeys: [] as string[], committed: new Map<string, number>() };
  const calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] = [];
  const styleCalls: { request: Record<string, any>; resolve(value: unknown): void }[] = [];
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: env.generation, availability: env.ready ? 'ready' : 'initializing',
      reason: env.ready ? 'ready' : 'initializing', initialShared: false, kind: 'owned', description: env.ready ? { ...description, profiles: env.profile.id === 'pi' ? [] : [env.profile] } : undefined }; },
    isReady(g: number) { return env.ready && g === env.generation; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) {
      assert.equal(env.depth, 0, 'no dispatch in render');
      if (request.op === 'styles.resolve') {
        const q = request as Record<string, any>, native = q.rules.kind === 'native';
        env.styleRequests.push(q);
        if (env.holdStyles) return new Promise<unknown>(resolve => styleCalls.push({ request: q, resolve }));
        return Promise.resolve({ v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
          kind: 'styles', vocabulary: q.vocabulary, rules: native ? fingerprintNative(q.rules.fingerprint, 'rules') : fingerprintRules(q.rules.definition),
          styles: [{ foreground: native ? { kind: 'rgb', r: 17, g: 34, b: 51 } : { kind: 'binding', slot: 1 },
            background: native ? { kind: 'rgb', r: 40, g: 41, b: 42 } : { kind: 'inherit' }, attributes: 0, attribute_mask: native ? 31 : 0 }], indices: q.contexts.map(() => 1),
          palette: native ? { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } : null } });
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
    return { enabled: env.enabled, provider: provider.snapshot(), standaloneVersion: 'test', selected: env.selected, effective: env.selected.kind === 'pi' ? profile : env.ready ? env.profile : undefined };
  } };
  let paletteRevision = 0, paletteColors = themes.theme.colors;
  const presentationOptions: TidyUiOptions = { ...options, outputPad: () => env.padding,
    piInput: () => {
      assert.equal(env.poisonPi, false, 'fixed native card must not acquire unrelated Pi input');
      if (paletteRevision !== env.palette) { paletteRevision = env.palette; paletteColors = { ...themes.theme.colors }; }
      return { theme: { colors: paletteColors, getFgAnsi: role => themes.theme.getFgAnsi(role), getBgAnsi: role => themes.theme.getBgAnsi(role) }, mode: themes.theme.getColorMode() };
    }, syntax: { client,
    isLiveCall: id => liveCalls.has(id),
    palette: () => env.palette, classify: useDefaultClassifier ? undefined : (text, info) => {
      assert.equal(env.depth, 0, 'no Pi call in render'); env.pi.push(text);
      const rows = env.plainPi ? text.split('\n') : highlightCode(text, info.language);
      return env.boldPi ? rows.map(row => themes.theme.style(row, { bold: true })) : rows;
    } } };
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
    tool(name: string, args: Record<string, unknown>, definition?: unknown, restored = false) {
      const id = `host-${name}-${++toolIdentity}`;
      if (!restored) liveCalls.add(id);
      const tool = new ToolExecutionComponent(name, id, args, undefined, definition, ui, '/tmp');
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
  const result = JSON.stringify(tool.result), args = JSON.stringify(tool.args);
  const cold = f.render(tool);
  assert.deepEqual(plain(cold), plain(renderFileCard(tool, '/tmp', 60, themes.theme)!.rows));
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
  const sources = f.calls.length;
  f.env.holdStyles = false;
  f.env.profile = { id: 'syntect:frozen', label: 'Frozen', fingerprint: 'b'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.calls.length, sources, 'recoloring frozen scopes needs no SOURCE');
  assert.ok(f.env.styleRequests.some(q => q.rules.kind === 'native'), 'the new theme resolved retained display contexts');
  assert.equal(f.sources.displayBasis(key)?.profile, 'syntect:frozen', 'frozen display publishes the selected native theme');
});

for (const occupied of [true, false]) test(`host rollback to a cached native theme ${occupied ? 'does not wait for both occupied DATA credits' : '(control: free credits)'}`, async () => {
  const f = fixture(true), first = { id: 'syntect:first', label: 'First', fingerprint: 'a'.repeat(64) }, second = { id: 'syntect:second', label: 'Second', fingerprint: 'b'.repeat(64) };
  const select = async (profile: typeof first) => { f.env.profile = profile; f.env.selected = { kind: 'occipital', id: profile.id }; f.adapter.syntaxMetadataChanged(); await settled(); };
  await select(first);
  const tool = written(f, 'const rollback = 1;'); f.render(tool); await settled();
  answer(f, 0, 'const rollback = 1;'); await settled(); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  assert.equal(f.sources.displayBasis(key)?.profile, first.id);
  await select(second); f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.sources.displayBasis(key)?.profile, second.id);
  if (occupied) {
    for (const command of ['echo held-one', 'echo held-two']) { const held = f.tool('bash', { command }); held.setArgsComplete(); f.render(held); }
    await settled(); assert.equal(f.calls.length, 3, 'both physical DATA credits are held by unrelated source work');
  }
  const styles = f.env.styleRequests.length, sources = f.calls.length;
  await select(first); f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.env.styleRequests.length, styles, 'the revisited theme is fully cached');
  assert.equal(f.calls.length, sources);
  assert.equal(f.sources.displayBasis(key)?.profile, first.id, 'cached rollback publishes before unrelated work settles');
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

test('host hidden/self-empty/image/compact/native/expanded files never authorize work; stock edit probe exemption remains', async () => {
  const f = fixture(), watch = watchConsumer(f);
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
  tool.setExpanded(true); f.render(tool);
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.sources.workStatus(key).fallbackEligible, false); assert.equal(f.env.pi.length, 0);
  f.sources.ownedStopped(1); await settled(); assert.equal(f.env.pi.length, 0);
  tool.setExpanded(false); f.render(tool); await settled(); assert.deepEqual(f.env.pi, ['x']);
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
  f.render(tool); await settled();
  const expected = renderFileCard(tool, '/tmp', 60, themes.theme, (code, path) => highlightCode(code, getLanguageFromPath(path)))!;
  const rows = f.render(tool);
  assert.deepEqual(plain(rows), plain(expected.rows));
  assert.ok(rows.join('').includes('\x1b[1m'), 'bare public Pi bold is not discarded when foreground is neutral');
  assert.ok(await hasHostInk(rows, themes.theme, 'syntaxKeyword', 'const', true));
});


test('host useful tickets are single actual-render demands, not measurement, mouse or native visits', async () => {
  const f = fixture(), file = written(f, 'x'), shell = f.tool('bash', { command: 'x' });
  const useful = CardSources.prototype.useful;
  let demands = 0;
  CardSources.prototype.useful = function (...args) { demands++; assert.equal(f.env.depth, 1); return useful.apply(this, args); };
  try {
    file.setExpanded(true); f.render(file); assert.equal(demands, 0);
    file.setExpanded(false); f.render(file); assert.equal(demands, 1);
    f.render(shell); assert.equal(demands, 2);
    file.handleMouse({ type: 'move', width: 60, height: 8, x: 0, y: 0 });
    assert.equal(demands, 2);
    f.render(shell, 0); assert.equal(demands, 2);
    file.hideComponent = true; f.render(file); assert.equal(demands, 2);
  } finally { CardSources.prototype.useful = useful; }
  await settled(); assert.equal(f.env.pi.length, 0, 'paused owners cancel pending preparation');
});

test('host default classifier uses explicit public file language outside render and no-client adapter is unchanged', async () => {
  const f = fixture(false, true), tool = written(f, 'const value = 1;');
  const cold = f.render(tool); await settled();
  assert.equal(f.env.captures, 1); const warm = f.render(tool);
  assert.deepEqual(plain(warm), plain(cold)); assert.ok(await hasHostInk(warm, themes.theme, 'syntaxKeyword', 'const'));
  f.adapter.restore();
  const native = installTidyUi(f.ui, () => themes.theme);
  try {
    assert.equal(native.active, true, native.reason);
    tool.render(60); await settled();
    assert.deepEqual(plain(tool.render(60)), plain(renderFileCard(tool, '/tmp', 60, themes.theme,
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
  const f = fixture(), watch = watchConsumer(f);
  try {
    const definition = createEditToolDefinition('/tmp');
    const tool = f.tool('edit', { path: 'a.ts', oldText: 'x', newText: 'y' }, definition);
    assert.equal(tool.getCallRenderer(), definition.renderCall); assert.equal(tool.getResultRenderer(), definition.renderResult);
    assert.equal(tool.getRenderShell(), 'self'); assert.equal(tool.hideComponent, false);
    assert.ok(tool.callRendererComponent instanceof Box);
    assert.equal(Object.getPrototypeOf(tool.callRendererComponent), Box.prototype);
    for (const method of ['render', 'clear', 'addChild'] as const) assert.equal(tool.callRendererComponent[method], Box.prototype[method]);
    assert.ok(nativeToolRender.call(tool, 60).length > 0, 'stock native heading really exists');
    tool.updateResult({ content: [], details: { diff: '-1 x\n+1 y' } }, false);
    f.render(tool); await settled();
    assert.deepEqual(f.env.pi, ['x', 'y']);
    assert.deepEqual(watch.counts().filter((_v, i) => i !== 5), [1, 1, 2, 0, 2, 0]);
    await settled(); // Finish the one-shot host-yield barrier before warm measurements.
    assert.deepEqual(watch.counts().filter((_v, i) => i !== 5), [1, 1, 2, 0, 2, 0], 'an empty controller continuation does not revisit card preparation');
    const before = watch.counts().slice(1);
    for (const width of [24, 60, 121]) f.render(tool, width);
    tool.handleMouse({ type: 'move', width: 60, height: 8, x: 0, y: 0 });
    await settled(); assert.deepEqual(watch.counts().slice(1), before);
    assert.equal(native.mock.calls.length, 0, 'injected stock Box exception does not discard native renders');
  } finally { watch.restore(); f.adapter.restore(); }
});

// Full presentation reinstallation deliberately ends its source-owner incarnation.
// A rare repeat is accepted; ordinary warm frames and same-adapter off remain strict.
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
  assert.equal(f.calls.length, 1, 'partial result is not terminal argument abandonment');
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
  // A real pause resumes through current-profile guards, not source/classifier work.
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
  f.env.ready = false; f.env.selected = { kind: 'occipital', id: 'different' }; f.adapter.syntaxMetadataChanged();
  assert.equal(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), true, 'pending preference does not erase the last ready display');
  f.env.ready = true; f.env.selected = { kind: 'pi' }; f.adapter.syntaxMetadataChanged(); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), false);
  assert.equal(f.sources.displayBasis(f.env.keys[0]!), undefined, 'native source display is released; funded card geometry is separate');
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

test('stream review F3: frozen native display survives zero width without thawing work', async () => {
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
    assert.equal(f.sources.observe({ key: 'pressure-peer', version: 1, text: 'x', language: 'bash', profile: profile.id, fingerprint: profile.fingerprint, complete: true }), true);
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


for (const kind of ['write', 'edit'] as const) test(`host ${kind} theme switch retains ready native rows before and during deferred preparation at unchanged width`, async () => {
  const f = fixture(true);
  f.env.profile = { id: 'syntect:first', label: 'First', fingerprint: 'a'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
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
  const first = tools[0]!, before = f.render(first);
  f.env.holdStyles = true;
  f.env.profile = { id: 'syntect:host', label: 'Host', fingerprint: 'b'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
  const countsBefore = counts(f), immediate = f.render(first);
  assert.deepEqual(plain(immediate), plain(before));
  assert.deepEqual(immediate, before, 'the first same-width frame keeps its last ready colors');
  assert.deepEqual(counts(f), countsBefore, 'cache invalidation itself does no metadata/native/Pi work in render');
  const afterFrame = f.adapter.cacheStats().builds;
  f.render(first); assert.equal(f.adapter.cacheStats().builds, afterFrame, 'ready display stays cached while new native work waits');
  await settled(); await settled();
  assert.deepEqual(f.render(first), before, 'deferred admission cannot replace ready colors with a neutral frame');
  assert.equal(f.env.pi.length, 0);
});

for (const kind of ['write', 'edit'] as const) test(`theme burst: ${kind} restores cached Pi colors after native expansion`, async () => {
  const f = fixture();
  const tool = kind === 'write' ? written(f, 'const n = 1') : f.tool('edit', { path: 'a.ts', oldText: 'const n = 1', newText: 'const n = 2' });
  if (kind === 'edit') tool.updateResult({ content: [{ type: 'text', text: 'saved' }], details: { diff: '-1 const n = 1\n+1 const n = 2' }, isError: false }, false);
  f.render(tool); await settled();
  const before = f.render(tool), classifications = f.env.pi.length;
  tool.setExpanded(true); f.render(tool); tool.setExpanded(false); f.render(tool); await settled();
  assert.deepEqual(f.render(tool), before, 'a resumed file must replace a temporarily plain cached layout even when the stored colors are unchanged');
  assert.equal(f.env.pi.length, classifications, 'restoring a layout cannot repeat Pi classification');
});

for (const kind of ['write', 'edit'] as const) test(`theme burst: ${kind} restores retained native colors while both unrelated jobs remain held`, async () => {
  const f = fixture(true);
  const tool = kind === 'write' ? written(f, 'const n = 1') : f.tool('edit', { path: 'a.ts', oldText: 'const n = 1', newText: 'const n = 2' });
  if (kind === 'edit') tool.updateResult({ content: [{ type: 'text', text: 'saved' }], details: { diff: '-1 const n = 1\n+1 const n = 2' }, isError: false }, false);
  f.render(tool); await settled();
  for (let i = 0; i < f.calls.length; i++) answer(f, i, (f.calls[i]!.request.sources as { text: string }[])[0]!.text, true);
  await settled(); const before = f.render(tool);
  f.render(f.tool('bash', { command: 'echo held B' })); f.render(f.tool('bash', { command: 'echo held C' })); await settled();
  assert.equal(f.sources.stats().globalUnsettledJobs, 2); const dispatched = f.calls.length, pi = f.env.pi.length;
  tool.setExpanded(true); f.render(tool); tool.setExpanded(false); f.render(tool); await settled(); await settled();
  assert.deepEqual(f.render(tool), before, 'local restoration cannot wait for unrelated native credit');
  assert.equal(f.calls.length, dispatched); assert.equal(f.env.pi.length, pi); assert.equal(f.sources.stats().globalUnsettledJobs, 2);
});


test('prepared host native complete palette paints every cell without Pi on warm repaint resize and output updates', async () => {
  const f = fixture(true);
  f.env.profile = { id: 'native:host', label: 'Host', fingerprint: 'c'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
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
  const cells = await hostCells(changed);
  for (const row of cells) for (let x = 0; x < row.length; x++) {
    const cell = row[x]!;
    if (x === 0 || x === row.length - 1 || x === 1) assert.equal(cell.bg, -1, 'exterior and stripe retain terminal default');
    else assert.equal(cell.bg, (40 << 16) | (41 << 8) | 42, 'all card regions use the native surface');
    if (cell.text.trim()) assert.equal(cell.fg, (17 << 16) | (34 << 8) | 51);
  }
  assert.equal(f.env.pi.length, 0);
});

test('prepared host outer refusal and throw release provisional candidates without publishing or leaking funded rows', async () => {
  const f = fixture(), tool = written(f, 'const retained=1;');
  f.render(tool); await settled(); const accepted = f.render(tool), builds = f.adapter.cacheStats().builds;
  const visit = CardSources.prototype.visit;
  let refuse = true;
  CardSources.prototype.visit = function(owner, consume) {
    const result = visit.call(this, owner, consume);
    if (refuse) return false;
    return result;
  };
  try {
    const before = f.sources.stats().retention.retainedBytes;
    for (let i = 0; i < 4; i++) f.render(tool, 24);
    assert.equal(f.sources.stats().retention.retainedBytes, before); assert.equal(f.adapter.cacheStats().builds, builds);
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


test('prepared host same-object diagnostic mutation changes service rows without reparsing unchanged file source', async () => {
  const f = fixture(), text = 'const diagnosticSource=1;', tool = written(f, text);
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


for (const selection of ['native', 'Follow Pi'] as const) test(`C19 SDK host recolors live interrupted Bash for ${selection} without reopening SOURCE`, async t => {
  t.after(() => themes.setTheme('dark'));
  const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
  tool.updateArgs({ command: `${text} NEW` });
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false);
  const interrupted = f.render(tool); await settled();
  const close = f.calls.find(c => c.request.op === 'stream.close')!; assert.ok(close);
  close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  const before = sourceCounts(f), raw = JSON.stringify([tool.args, tool.result, tool.getRenderContext()]);
  f.env.holdStyles = true;
  if (selection === 'native') {
    f.env.profile = { id: 'next', label: 'Next', fingerprint: 'b'.repeat(64) }; f.env.selected = { kind: 'occipital', id: 'next' };
    f.adapter.syntaxMetadataChanged();
  } else { themes.setTheme('light'); f.env.palette++; f.render(tool); }
  await settled();
  assert.equal(f.env.styleRequests.length, selection === 'native' ? 2 : 1, 'native selection resolves new STYLE; Follow Pi rebinds cached expressions locally');
  if (selection === 'native') {
    assert.deepEqual(f.render(tool), interrupted, 'pending recolor retains last-ready output');
    const held = f.styleCalls.at(-1)!; assert.ok(held);
    const q = held.request;
    held.resolve({ v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
      kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintNative(q.rules.fingerprint, 'rules'),
      styles: [{ foreground: { kind: 'rgb', r: 71, g: 72, b: 73 }, background: { kind: 'rgb', r: 40, g: 41, b: 42 }, attributes: 0, attribute_mask: 31 }],
      indices: q.contexts.map(() => 1), palette: { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } } });
    await settled();
    const cells = (await hostCells(f.render(tool))).flat().filter(c => c.text.trim());
    assert.ok(cells.some(c => c.text === 'e' && c.fg === (71 << 16 | 72 << 8 | 73)), 'actual SDK paint adopts new native ink');
  } else assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text), 'retained scopes adopt current Pi ink');
  const rows = f.render(tool);
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
  held.resolve({ v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'styles', vocabulary: q.vocabulary, rules: fingerprintNative(q.rules.fingerprint, 'rules'),
    styles: [{ foreground: { kind: 'rgb', r: 71, g: 72, b: 73 }, background: { kind: 'rgb', r: 40, g: 41, b: 42 }, attributes: 0, attribute_mask: 31 }],
    indices: q.contexts.map(() => 1), palette: { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } } });
}

for (const pause of ['zero-width', 'hidden'] as const) for (const pending of [false, true])
  test(`C19 pause fix SDK host ${pause} frozen card blocks ${pending ? 'held STYLE publication' : 'theme STYLE admission'} until useful resumption`, async () => {
    const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
    f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled();
    assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', text));
    tool.updateArgs({ command: `${text} NEW` });
    tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false);
    const ready = f.render(tool); await settled();
    const close = f.calls.find(c => c.request.op === 'stream.close')!; assert.ok(close);
    close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
    const key = f.env.keys[0]!, before = sourceCounts(f), restarts = f.sources.stats().restarts;
    const authority = f.sources.workStatus(key), stamp = f.sources.displayStamp(key), geometry = f.sources.displayBasis(key)!.geometryStamp;
    const raw = JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), styles = f.env.styleRequests.length;
    assert.equal(authority.fallbackEligible, false, 'canonical source freeze remains authoritative');
    assert.equal(f.sources.stats().remoteLeases, 0);
    f.env.holdStyles = true;
    const select = () => {
      f.env.profile = { id: 'paused-next', label: 'Paused next', fingerprint: 'b'.repeat(64) };
      f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
    };
    if (pending) { select(); await settled(); assert.equal(f.styleCalls.length, 1); assert.equal(f.sources.stats().unsettledJobs, 1); }
    if (pause === 'hidden') tool.hideComponent = true;
    assert.deepEqual(f.render(tool, pause === 'zero-width' ? 0 : 60), []);
    if (!pending) select();
    await settled();
    if (pending) { answerPausedHostStyle(f); await settled(); assert.equal(f.sources.stats().unsettledJobs, 0); }
    else assert.equal(f.env.styleRequests.length, styles, 'host pause must block new STYLE without a visible useful visit');
    assert.equal(f.sources.displayStamp(key), stamp, 'a held STYLE cannot publish across the actual host pause');
    assert.equal(f.sources.displayBasis(key)!.geometryStamp, geometry);
    assert.deepEqual(f.sources.workStatus(key), authority); assert.deepEqual(sourceCounts(f), before);
    assert.equal(JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), raw);
    f.adapter.syntaxMetadataChanged(); await settled();
    assert.equal(f.sources.displayStamp(key), stamp, 'metadata alone is not useful resumption');
    tool.hideComponent = false;
    assert.deepEqual(f.render(tool), ready, 'first useful frame retains the old ready paint until local publication');
    await settled();
    if (!pending) { assert.equal(f.styleCalls.length, 1); answerPausedHostStyle(f); await settled(); }
    assert.equal(f.env.styleRequests.length, styles + 1, 'settled paused STYLE is reused, not re-requested');
    const rows = f.render(tool), cells = (await hostCells(rows)).flat();
    assert.ok(cells.some(c => c.text === 'e' && c.fg === (71 << 16 | 72 << 8 | 73)), 'fresh useful demand adopts new native ink');
    assert.match(plain(rows).join('\n'), /echo retained NEW/); assert.match(plain(rows).join('\n'), /incomplete tool call/);
    for (const width of [24, 60, 100]) f.render(tool, width);
    await settled();
    assert.deepEqual(sourceCounts(f), before); assert.deepEqual(f.sources.workStatus(key), authority);
    assert.equal(f.sources.stats().restarts, restarts); assert.equal(f.sources.stats().remoteLeases, 0); assert.equal(f.sources.stats().pendingCloses, 0);
    assert.equal(JSON.stringify([tool.args, tool.result, tool.getRenderContext()]), raw); assert.deepEqual(f.env.pi, []);
    console.log(JSON.stringify({ frozenHostPause: pause, pending, sourceOps: f.calls.map(c => c.request.op), newStyles: f.env.styleRequests.length - styles,
      newSourceObservations: f.env.observes - before[1]!, newRestarts: f.sources.stats().restarts - restarts, leases: f.sources.stats().remoteLeases }));
  });

for (const kind of ['bash', 'write', 'edit'] as const) test(`host renderer transfer: ready ${kind} retains native paint and measured text without SOURCE or STYLE`, async () => {
  const f = fixture(true, false, {}, undefined, true);
  f.env.profile = { id: 'syntect:transfer', label: 'Transfer', fingerprint: 'd'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
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
  assert.ok(expected.some(row => row.includes('\x1b[38;2;17;34;51m')), 'native source colors are ready before moving');
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
  assert.equal(f.sources.stats().sourceRecords, 0); assert.equal(f.adapter.cacheStats().entries, 0);
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

test('host renderer transfer: changed text is prepared instead of reusing the old native source demand', async () => {
  const f = fixture(true, false, {}, undefined, true), tool = written(f, 'const TRANSFER_BEFORE = 1;');
  f.env.profile = { id: 'syntect:changed', label: 'Changed', fingerprint: 'e'.repeat(64) };
  f.env.selected = { kind: 'occipital', id: f.env.profile.id }; f.adapter.syntaxMetadataChanged();
  f.document(); await settled(); answer(f, 0, 'const TRANSFER_BEFORE = 1;'); await settled(); f.document();
  f.ui.clear(); tool.updateArgs({ path: 'a.ts', content: 'const TRANSFER_AFTER = 2;' }); f.ui.addChild(tool);
  const current = plain(f.document()).join('\n'); assert.ok(current.includes('TRANSFER_AFTER')); assert.equal(current.includes('TRANSFER_BEFORE'), false);
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
  const native = q.rules.kind === 'native';
  return { v: 3, ticket: q.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: {
    kind: 'styles', vocabulary: q.vocabulary, rules: native ? fingerprintNative(q.rules.fingerprint, 'rules') : fingerprintRules(q.rules.definition),
    styles: [{ foreground: native ? { kind: 'rgb', r: 17, g: 34, b: 51 } : { kind: 'binding', slot: 1 },
      background: native ? { kind: 'rgb', r: 40, g: 41, b: 42 } : { kind: 'inherit' }, attributes: 0, attribute_mask: native ? 31 : 0 }], indices: q.contexts.map(() => 1),
    palette: native ? { revision: 1, fingerprint: fingerprintNative(q.rules.fingerprint, 'palette'), slots: CARD_ROLES.map(() => 1), origins: CARD_ROLES.map(() => 0) } : null } };
}

for (const occupied of [true, false]) test(`syntax host: cached Follow Pi rollback from native ${occupied ? 'with both DATA credits occupied' : '(control: free credits)'}`, async () => {
  const f = fixture(true), native = { id: 'syntect:native', label: 'Native', fingerprint: 'a'.repeat(64) };
  const tool = written(f, 'const rollback = 1;'); f.render(tool); await settled();
  answer(f, 0, 'const rollback = 1;'); await settled(); f.render(tool); await settled();
  const key = f.env.keys[0]!;
  assert.equal(f.sources.displayBasis(key)?.profile, 'pi', 'initial Follow Pi display');
  const initialRows = f.render(tool);
  f.env.profile = native; f.env.selected = { kind: 'occipital', id: native.id }; f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.sources.displayBasis(key)?.profile, native.id, 'native display');
  if (occupied) {
    for (const command of ['echo held-one', 'echo held-two']) { const held = f.tool('bash', { command }); held.setArgsComplete(); f.render(held); }
    await settled(); assert.equal(f.calls.length, 3, 'both physical DATA credits held by unrelated SOURCE');
  }
  const styles = f.env.styleRequests.length, sources = f.calls.length;
  f.env.selected = { kind: 'pi' }; f.adapter.syntaxMetadataChanged(); await settled();
  f.render(tool); await settled(); f.render(tool); await settled();
  assert.equal(f.env.styleRequests.length, styles, 'Follow Pi styles are cached');
  assert.equal(f.calls.length, sources);
  assert.equal(f.sources.displayBasis(key)?.profile, 'pi', 'cached Follow Pi rollback publishes before unrelated work settles');
  assert.deepEqual(f.render(tool), initialRows, 'actual card restores exact Follow Pi text, colors and attributes');
  const warm = counts(f); for (let i = 0; i < 10; i++) f.render(tool); await settled();
  assert.deepEqual(counts(f), warm, 'cached rollback does not repeat source or classifier work on warm frames');
});

for (const interrupt of [true, false]) test(`syntax host: previously requested STYLE success after live interruption ${interrupt ? 'applies valid V2 colors' : '(control: live card publishes V2)'}`, async () => {
  const f = fixture(true), tool = f.tool('bash', { command: 'echo a' });
  f.render(tool); await settled(); answer(f, 0, 'echo a', false, 0); await settled();
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'echo a'), 'V1 ready display');
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
  assert.ok(await hasHostInk(f.render(tool), themes.theme, 'syntaxKeyword', 'echo a b'), 'the actual card paints the newly completed result, including after interruption');
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
