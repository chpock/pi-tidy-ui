import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Box, Container, Text } from '@earendil-works/pi-tui';
import { highlightCode, getLanguageFromPath, createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { installToolview, type ToolviewController, type ToolviewOptions } from '../src/index.ts';
import { SourceController } from '../src/occipital/controller.ts';
import type { SyntaxClient } from '../src/occipital/client.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';
import { OCCIPITAL_LIMITS } from '../src/occipital/limits.ts';
import { PROTOCOL_VERSION, type Description } from '../src/occipital/protocol.ts';
import { CardSources } from '../src/syntax/cards.ts';
import { renderBashCard } from '../src/bash-card.ts';
import { renderFileCard } from '../src/file-card.ts';

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
const fixtures: { adapter: ToolviewController; sources: SourceController;
  calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] }[] = [];
function fixture(ready = false, useDefaultClassifier = false, options: Pick<ToolviewOptions, 'cards' | 'compact'> = {}) {
  const ui = new UI();
  const env = { ready, enabled: true, palette: 1, padding: 1, depth: 0, boldPi: false, pi: [] as string[], observes: 0, captures: 0, reads: 0, keys: [] as string[], capturedKeys: [] as string[] };
  const calls: { request: Record<string, unknown>; resolve(value: unknown): void }[] = [];
  const provider = {
    snapshot(): ProviderSnapshot { return { generation: 1, availability: env.ready ? 'ready' : 'initializing',
      reason: env.ready ? 'ready' : 'initializing', initialShared: false, kind: 'owned', description: env.ready ? description : undefined }; },
    isReady(g: number) { return env.ready && g === 1; }, classificationAccepted(g: number) { return this.isReady(g); },
    request(_g: number, request: Record<string, unknown>) {
      assert.equal(env.depth, 0, 'no dispatch in render');
      return new Promise<unknown>(resolve => calls.push({ request, resolve }));
    }
  };
  let adapter: ToolviewController;
  const sources = new SourceController(provider, { onChange: keys => adapter.syntaxSourceChanged(keys) });
  const observe = sources.observe.bind(sources), capture = sources.capturePiSource.bind(sources);
  sources.observe = (...args) => { assert.equal(env.depth, 0, 'no native source preparation in render'); env.observes++; env.keys.push(args[0].key); return observe(...args); };
  sources.capturePiSource = (...args) => { assert.equal(env.depth, 0, 'no Pi source preparation in render'); env.captures++; env.capturedKeys.push(args[0]); return capture(...args); };
  const client: Pick<SyntaxClient, 'sources' | 'snapshot'> = { sources, snapshot: () => {
    assert.equal(env.depth, 0, 'no work metadata read in render'); env.reads++;
    return { enabled: env.enabled, provider: provider.snapshot(), standaloneVersion: 'test', selected: { kind: 'pi' }, effective: env.ready ? profile : undefined };
  } };
  const presentationOptions: ToolviewOptions = { ...options, outputPad: () => env.padding, syntax: { client,
    palette: () => env.palette, classify: useDefaultClassifier ? undefined : (text, info) => {
      assert.equal(env.depth, 0, 'no Pi call in render'); env.pi.push(text);
      const rows = highlightCode(text, info.language);
      return env.boldPi ? rows.map(row => themes.theme.style(row, { bold: true })) : rows;
    } } };
  const install = () => {
    adapter = installToolview(ui, () => themes.theme, presentationOptions);
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
    tool(name: string, args: Record<string, unknown>, definition?: unknown) {
      const tool = new ToolExecutionComponent(name, `host-${name}`, args, undefined, definition, ui, '/tmp');
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
function answer(f: ReturnType<typeof fixture>, index: number, text: string, complete = true) {
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
  const native = installToolview(f.ui, () => themes.theme);
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
  assert.equal(f.sources.stats().sourceRecords, 1, 'only the completed peer source remains');
  if (held) {
    assert.equal(f.calls.length, 2); assert.equal(f.sources.stats().unsettledJobs, 1, 'cancel is not physical completion');
    answer(f, 0, 'x\n', false);
  }
  await settled(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2]!.request.op, 'stream.close');
  const close = f.calls[2]!;
  close.resolve({ v: PROTOCOL_VERSION, ticket: close.request.ticket, instance: 'daemon', assets: 'assets', status: 'ok', body: { kind: 'closed' } });
  await settled();
  assert.equal(f.sources.stats().remoteLeases, 0); assert.equal(f.sources.stats().pendingCloses, 0);
  assert.equal(f.sources.stats().unsettledJobs, 0); assert.equal(f.sources.stats().retention.entries, 1);
  assert.deepEqual(f.render(peer), peerRows); assert.equal(f.adapter.cacheStats().builds, peerBuilds, 'peer layout remains warm');
  const before = counts(f);
  for (const width of [24, 60, 100]) f.render(tool, width);
  f.document(); tool.invalidate(); f.render(tool); await settled();
  assert.deepEqual(counts(f), before, 'aborted source is not reopened by rows or invalidation');
  assert.equal(f.env.pi.length, 0); assert.equal(f.sources.stats().sourceRecords, 1);
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
