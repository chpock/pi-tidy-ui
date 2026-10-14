import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Box, Container, Text } from '@earendil-works/pi-tui';
import { VERSION, highlightCode, getLanguageFromPath, createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { installTidyUi, type TidyUiController, type TidyUiOptions } from '../src/index.ts';
import { SourceController } from '../src/occipital/controller.ts';
import { RETENTION_LIMITS } from '../src/occipital/retention.ts';
import type { SyntaxClient } from '../src/occipital/client.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import { PROTOCOL_VERSION, type Description } from '../src/occipital/protocol.ts';
import { CardSources } from '../src/syntax/cards.ts';
import { renderBashCard } from '../src/bash-card.ts';
import { renderFileCard } from '../src/file-card.ts';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextJournal } from '../src/debug-log.ts';
import type { DiagnosticFields, DiagnosticSink } from '../src/diagnostics.ts';

const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/components/tool-execution.js')).href);
const nativeToolRender = ToolExecutionComponent.prototype.render;
const themes = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
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
class UI extends Container { requests = 0; requestRender() { this.requests++; } }
const fixtures: { adapter: TidyUiController; sources: SourceController;
  calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] }[] = [];
function fixture(ready = false, useDefaultClassifier = false, options: Pick<TidyUiOptions, 'cards' | 'compact' | 'diagnostic'> = {}, retention?: { maxBytes: number }) {
  const ui = new UI();
  const liveCalls = new Set<string>();
  const env = { liveCalls, ready, enabled: true, generation: 1, selected: { kind: 'pi' } as ReturnType<SyntaxClient['snapshot']>['selected'], palette: 1, padding: 1, depth: 0, boldPi: false, plainPi: false, pi: [] as string[], observes: 0, captures: 0, reads: 0, keys: [] as string[], capturedKeys: [] as string[], committed: new Map<string, number>() };
  const calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] = [];
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: env.generation, availability: env.ready ? 'ready' : 'initializing',
      reason: env.ready ? 'ready' : 'initializing', initialShared: false, kind: 'owned', description: env.ready ? description : undefined }; },
    isReady(g: number) { return env.ready && g === env.generation; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) {
      assert.equal(env.depth, 0, 'no dispatch in render');
      return new Promise<unknown>(resolve => calls.push({ request, resolve }));
    }
  };
  let adapter: TidyUiController, toolIdentity = 0;
  const sources = new SourceController(provider, { retention, diagnostic: options.diagnostic, onChange: keys => adapter.syntaxSourceChanged(keys) });
  const observe = sources.observe.bind(sources), capture = sources.capturePiSource.bind(sources);
  sources.observe = (...args) => { assert.equal(env.depth, 0, 'no native source preparation in render'); env.observes++; env.keys.push(args[0].key); return observe(...args); };
  sources.capturePiSource = (...args) => { assert.equal(env.depth, 0, 'no Pi source preparation in render'); env.captures++; env.capturedKeys.push(args[0]); return capture(...args); };
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> = { sources, snapshot: () => {
    assert.equal(env.depth, 0, 'no work metadata read in render'); env.reads++;
    return { enabled: env.enabled, provider: provider.snapshot(), standaloneVersion: 'test', selected: env.selected, effective: env.ready ? profile : undefined };
  } };
  const presentationOptions: TidyUiOptions = { ...options, outputPad: () => env.padding, syntax: { client,
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
  const value = { ui, env, calls, sources, get adapter() { return adapter; },
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
async function settled() { await turn(); }
const plain = (rows: string[]) => rows.map(stripVTControlCharacters);
function counts(f: ReturnType<typeof fixture>) { return [f.env.pi.length, f.env.observes, f.env.captures, f.env.reads, f.calls.length]; }
function watchConsumer(f: ReturnType<typeof fixture>) {
  const useful = CardSources.prototype.useful, drain = CardSources.prototype.drain;
  let demands = 0, preparationVisits = 0;
  CardSources.prototype.useful = function (...args) { demands++; return useful.apply(this, args); };
  CardSources.prototype.drain = function () {
    preparationVisits++; assert.equal(f.env.depth, 0, 'no preparation visit in render'); return drain.call(this);
  };
  return { counts: () => [demands, preparationVisits, ...counts(f)],
    restore() { CardSources.prototype.useful = useful; CardSources.prototype.drain = drain; } };
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
    kind: 'source', sources: [{ key: source.key, generation: source.generation, source_version: source.source_version,
      profile: source.profile, fingerprint: source.fingerprint, revision: r.op === 'stream.append' ? (r.base_revision as number) + 1 : 1,
      replace_from: from, source_bytes: bytes, committed_bytes: committedBytes ?? bytes, complete,
      ...(r.op !== 'highlight' ? { lease: 'lease' } : {}), styles: [{ role: 'syntaxKeyword' }], runs: bytes > from ? [bytes - from, 0] : [],
      counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } }]
  } });
}
function fault(f: ReturnType<typeof fixture>, index: number) {
  const call = f.calls[index]!;
  call.resolve({ v: PROTOCOL_VERSION, ticket: call.request.ticket, instance: 'daemon', assets: 'assets', status: 'error', error: { code: 'busy', execution: 'not_started' } });
}
afterEach(async () => {
  for (const f of fixtures) { f.adapter.restore(); f.sources.dispose(); }
  for (let i = 0; i < 5; i++) { for (const f of fixtures) for (const call of f.calls) call.resolve({}); await settled(); }
  for (const f of fixtures) assert.equal(f.sources.stats().globalUnsettledJobs, 0);
  fixtures.length = 0;
});

test('host cold file is exact plain then public Pi colors; warmed render/width/padding/output events do zero work', async () => {
  const f = fixture(), tool = written(f, 'const n = 1;\n\t// comment');
  const result = JSON.stringify(tool.result), args = JSON.stringify(tool.args);
  const cold = f.render(tool);
  assert.deepEqual(cold, renderFileCard(tool, '/tmp', 60, themes.theme)!.rows);
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
  const before = counts(f);
  tool.updateArgs({ ...args }); f.render(tool); f.document();
  args.description = 'second'; args.workdir = '/tmp'; tool.updateArgs(args); f.render(tool);
  tool.updateResult({ content: [{ type: 'text', text: 'stdout' }] }, true); f.render(tool);
  await settled(); assert.deepEqual(counts(f), before);
  const requests = f.ui.requests; assert.equal(tool.setArgsComplete(), undefined);
  assert.equal(f.ui.requests, requests + 1, 'original setter owns sole synchronous redraw');
  assert.equal(tool.getRenderContext().argsComplete, true); assert.equal(tool.isPartial, true);
  assert.equal(tool.executionStarted, false, 'source completion is independent of process execution');
  tool.markExecutionStarted(); f.render(tool);
  await settled(); assert.equal(f.calls.length, 1);
  answer(f, 0, 'x\n', false); await settled();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.append, ''); assert.equal(f.calls[1]!.request.final, true);
  answer(f, 1, 'x\n'); await settled();
  assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', 'x')));
  args.command = 'y'; tool.updateArgs(args); f.render(tool); await settled();
  assert.equal(f.env.pi.length, 0); assert.ok(f.env.observes > before[1]!);
});

test('host Bash fallback stays full-command toolTitle with zero Pi during startup off and no-start', async () => {
  for (const mode of ['startup', 'off', 'no-start'] as const) {
    const f = fixture(mode === 'no-start');
    if (mode === 'off') { f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged(); }
    const tool = f.tool('bash', { command: 'a\tb\nc' }); tool.setArgsComplete();
    const cold = f.render(tool); await settled();
    if (mode === 'no-start') { fault(f, 0); await settled(); }
    assert.deepEqual(f.render(tool), cold);
    assert.deepEqual(cold, renderBashCard(tool, undefined, 60, themes.theme).rows);
    assert.equal(f.env.pi.length, 0); assert.equal(f.sources.stats().piSourceRecords, 0);
    f.adapter.restore();
  }
});

test('host keyed notices retire only affected layout; metadata upgrades only latest useful owner', async () => {
  const f = fixture(), a = written(f, 'a'), b = written(f, 'b');
  f.render(a); f.render(b); await settled(); f.render(a); f.render(b);
  const before = f.adapter.cacheStats();
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.equal(f.calls.length, 1); assert.equal((f.calls[0]!.request.sources as { text: string }[])[0]!.text, 'b');
  f.render(b); const built = f.adapter.cacheStats().builds;
  answer(f, 0, 'b'); await settled();
  assert.equal(f.adapter.cacheStats().entries, before.entries - 1);
  f.render(a); assert.equal(f.adapter.cacheStats().builds, built, 'peer layout remains warm');
  f.render(b); assert.equal(f.adapter.cacheStats().builds, built + 1);
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
    await settled(); assert.deepEqual(watch.counts(), [0, 0, 0, 0, 0, 1, 0]);
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
  assert.ok(rows.join('').includes(themes.theme.style('const', { fg: themes.theme.colors.syntaxKeyword, bold: true })));
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
  assert.deepEqual(plain(warm), plain(cold)); assert.ok(warm.join('').includes(themes.theme.fg('syntaxKeyword', 'const')));
  f.adapter.restore();
  const native = installTidyUi(f.ui, () => themes.theme);
  try {
    assert.equal(native.active, true, native.reason);
    assert.deepEqual(tool.render(60), renderFileCard(tool, '/tmp', 60, themes.theme,
      (code, path) => highlightCode(code, getLanguageFromPath(path)))!.rows);
    native.syntaxMetadataChanged(); native.syntaxSourceChanged([]);
    assert.deepEqual(f.env.pi, []);
  } finally { native.restore(); }
});

test('host palette generations and same-object file metadata mutate only current source, never stdout/diagnostics', async () => {
  const f = fixture(), tool = written(f, 'const x = 1;');
  f.render(tool); await settled(); assert.equal(f.env.pi.length, 1);
  const before = counts(f);
  tool.updateArgs({ ...tool.args }); tool.updateResult({ ...tool.result, isError: undefined, details: { diagnostics: [] } }, false);
  f.render(tool); await settled(); assert.deepEqual(counts(f), before);
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
  assert.ok(rows.join('').includes(themes.theme.fg('syntaxKeyword', 'x')));
  assert.ok(rows.join('').includes(themes.theme.fg('toolTitle', '        y 👩‍💻 é')));
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
    assert.deepEqual(before, [0, 0, 0, 0, 0, 1, 0]);
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
    assert.deepEqual(watch.counts(), [1, 1, 2, 0, 2, 3, 0]);
    await settled(); // Finish the one-shot host-yield barrier before warm measurements.
    assert.deepEqual(watch.counts(), [1, 2, 2, 0, 2, 3, 0]);
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
  assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', 'x')));
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
  assert.equal(f.calls.length, 1); assert.equal(f.env.pi.length, 1, 'Bash starts native, never Pi');
  f.document(); const heldFile = written(f, 'const PRIVATE_HELD_BODY = 18;');
  f.document(); await settled(); assert.equal(f.calls.length, 2);
  const waiting = f.render(heldFile); await journal.flush();
  body = await fs.readFile(journal.status().path, 'utf8');
  assert.match(body, /Native work is queued, unsettled or uncertain; full text shown without duplicate Pi classification/);
  assert.equal(f.env.pi.length, 1); assert.equal(body.includes('PRIVATE_HELD_BODY'), false);
  answer(f, 0, shell, false); answer(f, 1, 'const PRIVATE_HELD_BODY = 18;'); await settled();
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
  assert.ok(rows.join('\n').includes(themes.theme.fg('syntaxKeyword', 'echo a')), 'historical provisional colors survive the append');
  assert.ok(rows.join('\n').includes(themes.theme.fg('toolTitle', 'b')), 'new characters are neutral');
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
  assert.ok(first.join('').includes(themes.theme.fg('syntaxKeyword', base)), 'Colors survive on the first frame before deferred source preparation');
  assert.ok(first.join('').includes(themes.theme.fg('toolTitle', ' new')), 'Latest appended text is visible immediately and initially neutral');
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
  assert.ok(rows.join('').includes(themes.theme.fg('syntaxKeyword', text)), 'Formation failure does not erase retained colors');
  assert.ok(plain(rows).join('\n').includes('[error: incomplete tool call]'));
  assert.equal(plain(rows).join('\n').includes('execution failed'), false);
  assert.equal(JSON.stringify(tool.args), rawArgs); assert.equal(tool.executionStarted, false); assert.equal(tool.argsComplete, false);
  assert.equal(f.calls[1]!.request.op, 'stream.close');
  const r = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: r.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  await settled();
  const before = counts(f), builds = f.adapter.cacheStats().builds;
  for (const width of [60, 0, 60, 24, 100]) {
    if (width === 0) { assert.deepEqual(f.render(tool, width), []); continue; }
    assert.ok(f.render(tool, width).join('').includes(themes.theme.fg('syntaxKeyword', text)));
    await settled();
  }
  assert.deepEqual(counts(f), before); assert.equal(f.sources.stats().remoteLeases, 0);
  f.render(tool, 100); const warmBuilds = f.adapter.cacheStats().builds;
  f.render(tool, 100); assert.equal(f.adapter.cacheStats().builds, warmBuilds);
  assert.ok(warmBuilds > builds, 'Only changed width rebuilt the display');
  f.ui.removeChild(tool); assert.equal(f.sources.stats().sourceRecords, 0); assert.equal(f.sources.stats().retention.retainedBytes, 0);
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

for (const frozen of [false, true]) test(`stream review F1: ${frozen ? 'frozen' : 'active'} Bash keeps compatible colors through metadata absence but rejects off/selection changes`, async () => {
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
  assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)), 'first metadata-loss frame retains styles');
  await settled(); assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  f.env.ready = true; f.adapter.syntaxMetadataChanged(); await settled();
  assert.ok(f.render(tool, 100).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  assert.equal(f.calls.length, before); assert.equal(f.sources.displayStamp(f.env.keys[0]!), stamp); assert.equal(f.env.pi.length, 0);
  f.env.ready = false; f.env.selected = { kind: 'occipital', id: 'different' }; f.adapter.syntaxMetadataChanged();
  assert.equal(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)), false, 'changed preference cannot borrow previous profile');
  f.env.ready = true; f.env.selected = { kind: 'pi' }; f.adapter.syntaxMetadataChanged(); await settled();
  assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  f.env.enabled = false; f.sources.setEnabled(false); f.adapter.syntaxMetadataChanged();
  assert.equal(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)), false);
  assert.equal(f.sources.stats().retention.retainedBytes, 0);
});

test('stream review F2: shell-file correction then provider recovery cannot paint display-only history as current coverage', async () => {
  const f = fixture(true), tool = written(f, 'if', 'a.sh');
  f.render(tool); await settled(); answer(f, 0, 'if', true); await settled(); f.render(tool);
  tool.updateArgs({ path: 'a.sh', content: 'zz' }); f.render(tool); await settled();
  assert.equal(f.calls.length, 2); f.env.generation = 2; f.adapter.syntaxMetadataChanged(); await settled();
  const rows = f.render(tool);
  assert.equal(rows.join('').includes(themes.theme.fg('syntaxKeyword', 'zz')), false);
  assert.equal(f.env.pi.length, 0, 'unsettled native work still forbids duplicate Pi parsing');
  assert.ok(plain(rows).join('\n').includes('zz'), 'the complete latest shell-file text remains visible');
});

test('stream review F3: frozen native display survives zero width without thawing work', async () => {
  const f = fixture(true), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool);
  const request = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  const before = counts(f), stamp = f.sources.displayStamp(f.env.keys[0]!);
  assert.deepEqual(f.render(tool, 0), []);
  assert.ok(f.render(tool, 60).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  await settled(); assert.ok(f.render(tool, 60).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  assert.equal(f.sources.displayStamp(f.env.keys[0]!), stamp); assert.deepEqual(counts(f), before);
  assert.equal(f.sources.stats().remoteLeases, 0);
});

test('stream review F5: restored frozen Bash processes actual display eviction while work remains paused', async () => {
  const maxBytes = 4096, f = fixture(true, false, {}, { maxBytes }), text = 'echo retained', tool = f.tool('bash', { command: text });
  f.render(tool); await settled(); answer(f, 0, text, false, 0); await settled(); f.render(tool);
  const key = f.env.keys[0]!;
  tool.updateResult({ content: [{ type: 'text', text: 'interrupted' }], isError: true }, false); f.render(tool);
  const request = f.calls[1]!.request;
  f.calls[1]!.resolve({ v: PROTOCOL_VERSION, ticket: request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } }); await settled();
  f.render(tool, 0); assert.ok(f.render(tool, 60).join('').includes(themes.theme.fg('syntaxKeyword', text)));
  const requests = f.ui.requests, releases = f.adapter.cacheStats().releases, calls = f.calls.length;
  const peerUnits = Math.floor((maxBytes - RETENTION_LIMITS.entryAllowance - RETENTION_LIMITS.stringAllowance - 2 * RETENTION_LIMITS.maxKeyUnits - 512) / 2);
  assert.equal(f.sources.observe({ key: 'pressure-peer', version: 1, text: 'x'.repeat(peerUnits), language: 'bash', profile: profile.id, fingerprint: profile.fingerprint, complete: true }), true);
  assert.equal(f.sources.displayBasis(key), undefined, 'genuine pool pressure released the frozen basis');
  f.sources.flush(); await settled();
  assert.equal(f.ui.requests, requests + 1, 'display loss requests repaint before a manual render can mask the missed notification');
  assert.equal(f.adapter.cacheStats().releases, releases + 1, 'the frozen owner body is invalidated by the display effect');
  assert.equal(f.calls.length, calls + 1); assert.equal(f.calls.at(-1)!.request.op, 'highlight', 'only the unrelated peer is admitted');
  const rows = f.render(tool, 60); assert.equal(rows.join('').includes(themes.theme.fg('syntaxKeyword', text)), false);
  assert.ok(rows.join('').includes(themes.theme.fg('toolTitle', text)));
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
  assert.ok(f.render(tool).join('').includes(themes.theme.fg('syntaxKeyword', text)));
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
  assert.ok(colored[0]!.join('').includes(themes.theme.fg('syntaxKeyword', firstText)));
  assert.ok(colored[1]!.join('').includes(themes.theme.fg('syntaxKeyword', secondText)));
  const before = counts(f);
  for (const width of [24, 60, 100, 60]) f.document(width);
  for (let i = 0; i < 100; i++) { f.render(first); f.render(second); }
  await settled(); assert.deepEqual(counts(f), before); assert.deepEqual(f.env.pi, []);
  assert.equal(JSON.stringify([first.args, first.result, first.getRenderContext(), second.args, second.result, second.getRenderContext()]), raw);
  assert.equal(first.argsComplete, false); assert.equal(first.executionStarted, false); assert.equal(f.sources.stats().remoteLeases, 0);
});
