import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Container } from '@earendil-works/pi-tui';
import { installTidyUi } from '../../../src/index.ts';
import { CardLayout } from '../../../src/syntax/card-layout.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { measure, type MeasuredText, type MeasuredRowLayout, type GeometryPolicy } from '../../../src/syntax/measured-rows.ts';
import { observeSyntaxLocalWork } from '../../fixtures/syntax-local-work.ts';
import { stripVTControlCharacters } from 'node:util';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { DataBudget, DataCharge } from '../../../src/occipital/data-budget.ts';
import { inspectContextBatch } from '../../../src/occipital/semantic-codec.ts';
import { OCCIPITAL_LIMITS } from '../../../src/occipital/limits.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
import { preparePiInput } from '../../../src/syntax/pi-input.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import { materializeStyle, type ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { decodeSemanticDescription, decodeSemanticSourceReply, decodeSemanticStyleReply, SEMANTIC_PROTOCOL_VERSION } from '../../../src/occipital/semantic-protocol.ts';
import { fingerprintNative } from '../../../src/occipital/style-rules.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';

const inputs = readInputs(), binary = validateNative(inputs);
const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('current consumer costs: actual owned SOURCE STYLE incremental contexts and lifetime ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'consumer-costs-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  let phase = 'setup', holdStyle = false, release = () => {}, arrived = () => {};
  const requests: { phase: string; op: string; requestJsonBytes: number; responseJsonBytes: number; contexts: number; transportToParsedReplyMs: number; transportCreditAtDispatch: number; sourceRuns: number; decodedRangeCapacityBytes: number; decodedContextCapacityBytes: number }[] = [];
  const provider = { snapshot: () => broker.snapshot(), isReady: (generation: number) => broker.isReady(generation),
    classificationAccepted: (generation: number) => broker.classificationAccepted(generation),
    request(generation: number, request: Record<string, unknown>, options?: Parameters<ProviderBroker['request']>[2]) {
      const record = { phase, op: String(request.op), requestJsonBytes: Buffer.byteLength(JSON.stringify(request)), responseJsonBytes: 0,
        contexts: Array.isArray(request.contexts) ? request.contexts.length : 0, transportToParsedReplyMs: 0, transportCreditAtDispatch: 0, sourceRuns: 0, decodedRangeCapacityBytes: 0, decodedContextCapacityBytes: 0 };
      requests.push(record); const start = performance.now();
      const response = broker.request(generation, request, options); record.transportCreditAtDispatch = pipe.stats().retainedBytes;
      return response.then(async raw => {
        record.transportToParsedReplyMs = performance.now() - start;
        // Re-serialization is an observable JSON-size equivalent, not a socket byte tap.
        record.responseJsonBytes = Buffer.byteLength(JSON.stringify(raw));
        const body = (raw as { body?: { sources?: { runs: number[]; contexts: number[][] }[] } }).body;
        for (const source of body?.sources ?? []) {
          record.sourceRuns += source.runs.length / 2;
          record.decodedRangeCapacityBytes += source.runs.length * 4;
          record.decodedContextCapacityBytes += inspectContextBatch([source.contexts], {
            vocabularySize: broker.snapshot().description!.vocabulary.count, maxBytes: OCCIPITAL_LIMITS.retainedBytes }).words * 4;
        }
        if (request.op === 'styles.resolve' && holdStyle) { holdStyle = false; arrived(); await new Promise<void>(resolve => { release = resolve; }); }
        return raw;
      });
    } };
  const owner = new SourceController(provider, { deadlineMs: 5000 }), budget = owner.geometryFunding()!.budget;
  let peaks = { retainedPolicyBytes: 0, outstandingReservationBytes: 0, combinedPolicyBytes: 0, largestReservationBytes: 0, commits: 0, committedPolicyBytes: 0 };
  const sample = () => { const s = budget.stats(); peaks.retainedPolicyBytes = Math.max(peaks.retainedPolicyBytes, s.retainedBytes);
    peaks.outstandingReservationBytes = Math.max(peaks.outstandingReservationBytes, s.outstandingPeakBytes);
    peaks.combinedPolicyBytes = Math.max(peaks.combinedPolicyBytes, s.retainedBytes + s.outstandingPeakBytes); };
  const reserve = DataBudget.prototype.reserve, commit = DataBudget.prototype.commit;
  t.mock.method(DataBudget.prototype, 'reserve', function(this: DataBudget, bytes: number) { const grant = reserve.call(this, bytes);
    if (this === budget && grant) { peaks.largestReservationBytes = Math.max(peaks.largestReservationBytes, bytes); sample(); } return grant; });
  t.mock.method(DataBudget.prototype, 'commit', function(this: DataBudget, ...args: Parameters<typeof commit>) { const result = commit.apply(this, args);
    if (this === budget) { peaks.commits++; peaks.committedPolicyBytes += args[0]; sample(); } return result; });
  const drain = () => awaitFixture((async () => { for (let i = 0; i < 4 || owner.stats().unsettledJobs || owner.stats().pendingCloses; i++) { owner.flush(); await turn(); } })());
  const rows: Record<string, unknown>[] = [];
  async function run(name: string, action: () => void | Promise<void>) {
    phase = name; peaks = { retainedPolicyBytes: 0, outstandingReservationBytes: 0, combinedPolicyBytes: 0, largestReservationBytes: 0, commits: 0, committedPolicyBytes: 0 }; sample();
    const before = owner.stats(), start = performance.now(); let eventLoopTurnMs = 0;
    const tick = performance.now(), event = turn().then(() => { eventLoopTurnMs = performance.now() - tick; });
    await action(); await drain(); await event;
    const after = owner.stats(); rows.push({ phase, readyMs: performance.now() - start, eventLoopTurnMs, peaks: { ...peaks }, after,
      delta: { committedLineCalls: after.committedLineCalls - before.committedLineCalls, committedLineBytes: after.committedLineBytes - before.committedLineBytes,
        tailCalls: after.tailCalls - before.tailCalls, tailBytes: after.tailBytes - before.tailBytes, preparedBytes: after.preparedBytes - before.preparedBytes,
        decodedBytes: after.decodedBytes - before.decodedBytes, sourceRequests: requests.filter(r => r.phase === phase && r.op !== 'styles.resolve').length,
        styleRequests: requests.filter(r => r.phase === phase && r.op === 'styles.resolve').length } });
  }
  const styles = (key: string) => { const result: ConcreteStyle[] = []; assert.equal(owner.displayBasis(key)?.visit((_text, ranges) => ranges((_from, _to, style) => result.push(style))), true); return result; };
  try {
    await awaitFixture(broker.start()); const [a, b] = broker.snapshot().description!.profiles; assert.ok(a && b);
    owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint });
    const first = 'echo α\n', known = 'echo β\n', novel = '# C22 new context\n';
    const source = { key: 'bash', version: 1, language: 'bash', profile: a.id, fingerprint: a.fingerprint, text: first, complete: false };
    await run('cold-bash', () => { owner.observe(source); owner.flush(); });
    assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().styleDispatches, 1); assert.ok(styles('bash').length);
    const committed = owner.stats().committedLineBytes;
    await run('known-context-append', () => { owner.observe({ ...source, version: 2, text: first + known }); owner.flush(); });
    assert.equal(broker.stats().sourceDispatches, 2); assert.equal(broker.stats().styleDispatches, 1, 'already resolved contexts require no STYLE');
    assert.equal(owner.stats().committedLineBytes - committed, Buffer.byteLength(known), 'no committed-prefix replay');
    const old = owner.displayBasis('bash')!, oldStyles = styles('bash');
    let reached!: () => void; const held = new Promise<void>(resolve => { reached = resolve; }); arrived = reached; holdStyle = true;
    await run('new-context-append', async () => {
      owner.observe({ ...source, version: 3, text: first + known + novel }); owner.flush(); await awaitFixture(held);
      assert.equal(owner.displayBasis('bash')?.version, old.version); assert.deepEqual(styles('bash'), oldStyles);
      rows.push({ phase: 'held-new-style-old-display', owner: owner.stats(), budget: budget.stats(), transport: pipe.stats() }); release();
    });
    assert.equal(broker.stats().sourceDispatches, 3); assert.equal(broker.stats().styleDispatches, 2);
    assert.ok(requests.find(r => r.phase === 'new-context-append' && r.op === 'styles.resolve')!.contexts > 0);
    const initial = styles('bash'), parsed = owner.stats().committedLineBytes;
    await run('uncached-native-theme', () => { owner.setStyleSelection({ kind: 'native', id: b.id, fingerprint: b.fingerprint }); });
    await run('cached-native-rollback', () => { owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint }); });
    assert.deepEqual(styles('bash'), initial); assert.equal(broker.stats().styleDispatches, 3); assert.equal(broker.stats().sourceDispatches, 3);
    const selectPi = (revision: number) => { const start = performance.now(), lease = preparePiInput(themes.theme, revision, 'truecolor', owner.geometryFunding()!)!;
      const inputPrepareMs = performance.now() - start, bindingStart = performance.now();
      assert.ok(lease); try { assert.equal(lease.visit(read => { owner.setStyleSelection({ kind: 'client', definition: createPiRuleDefinition(), bindingRevision: revision,
        palette: `pi:${revision}`, bindings: read.bindings, roles: read.roles }); }), true); }
      finally { lease.dispose(); rows.push({ phase: `${phase}-local-input`, inputPrepareMs, selectionAndLeaseVisitMs: performance.now() - bindingStart }); } };
    await run('pi-rules-cold', () => { selectPi(1); });
    const piStyles = styles('bash'), calls = broker.stats().styleDispatches;
    await run('pi-unchanged-rule-rebinding', () => { themes.initTheme('light', false); selectPi(2); });
    assert.notDeepEqual(styles('bash'), piStyles, 'real light Pi bindings replace dark colors without new matching'); assert.equal(broker.stats().styleDispatches, calls); assert.equal(broker.stats().sourceDispatches, 3);
    assert.equal(owner.stats().committedLineBytes, parsed);
    await run('finalize-bash', () => { owner.observe({ ...source, version: 4, text: first + known + novel, complete: true }); owner.flush(); });
    assert.equal(owner.stats().remoteLeases, 0);
    const finite = 'export const finite = { value: 42, text: "α" };\n';
    await run('cold-finite-file', () => { owner.observe({ ...source, key: 'file', version: 1, language: 'typescript', text: finite, complete: true }); owner.flush(); });
    assert.ok(styles('file').length); assert.equal(requests.filter(r => r.phase === 'cold-finite-file' && r.op === 'highlight').length, 1);
    const dense = Array.from({ length: 256 }, (_, i) => `export const v${i}={n:${i},s:"α",a:[true,null],f:(x:number)=>x+1}; // dense\n`).join('');
    await run('dense-finite', () => { owner.observe({ ...source, key: 'dense', version: 1, language: 'typescript', text: dense, complete: true }); owner.flush(); });
    assert.ok(rows.some(row => row.phase === 'dense-finite' && (row.peaks as typeof peaks).commits > 0), 'ledger observer sees actual funded ownership');
    assert.ok(styles('dense').length > 256); assert.equal(requests.filter(r => r.phase === 'dense-finite' && r.op === 'highlight').length, 1);
    const before = broker.stats(); await run('warm', () => { for (let i = 0; i < 10; i++) { styles('dense'); owner.flush(); } });
    assert.deepEqual(broker.stats(), before);
    await run('remove', () => { owner.remove('bash'); owner.remove('file'); owner.remove('dense'); });
    assert.equal(owner.stats().retention.entries, 0); assert.equal(owner.stats().retention.styles, 0);
    console.log(JSON.stringify({ currentConsumerCosts: { node: process.version, pi: inputs.pi.version, source: inputs.source, native: binary,
      description: broker.snapshot().description, workloads: [{ name: 'bash', bytes: Buffer.byteLength(first + known + novel), sha256: hash(first + known + novel) },
        { name: 'file', bytes: Buffer.byteLength(finite), sha256: hash(finite) }, { name: 'dense', bytes: Buffer.byteLength(dense), units: dense.length, sha256: hash(dense) }],
      rows, requests, measurement: 'instrumented; latency supplemental; JSON reserialization sizes exclude 4-byte framing; policy charges are not allocator/RSS; parsed reply boundary includes transport and JSON parsing, not independently parser/decoder/materialization timings' } }));
  } finally { release(); owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  assert.equal(owner.stats().globalTransientBytes, 0); assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().ownedListeners, 0);
  console.log(JSON.stringify({ currentConsumerCleanup: { owner: owner.stats(), budget: budget.stats(), transport: pipe.stats() } }));
});

// This second composition uses the shipping SDK adapter/cache, not a fixture cache.
test('current consumer geometry: actual CardSources SDK preparation warm theme width and dense finite paint', async t => {
  const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'consumer-geometry-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  class UI extends Container { requestRender() {} }
  let adapter: ReturnType<typeof installTidyUi> | undefined;
  const owner = new SourceController(broker, { deadlineMs: 5000, onChange: (keys, groups) => adapter?.syntaxSourceChanged(keys, groups) });
  const budget = owner.geometryFunding()!.budget;
  const observer = observeSyntaxLocalWork(text => text.includes('C22_'));
  let phase = 'setup', revision = 1, measurements = 0, reflows = 0, glyphs = 0, measurementBufferBytes = 0, layoutBufferBytes = 0, layoutRows = 0, layoutSpans = 0, paints = 0, paintMs = 0, measureMs = 0, reflowMs = 0, prepareMs = 0;
  const seed = measure('', budget)!;
  // Reach the existing static operation through a real instance; do not add a production telemetry API.
  assert.equal(typeof Reflect.get(seed.constructor, 'create'), 'function'); assert.equal(typeof Reflect.get(seed.constructor, 'reflow'), 'function');
  const measurement = seed.constructor as unknown as { create: typeof measure; reflow: (m: MeasuredText, p: GeometryPolicy, f?: Parameters<typeof measure>[2]) => MeasuredRowLayout | undefined };
  seed.dispose();
  const create = measurement.create, reflow = measurement.reflow, prepare = CardSources.prototype.prepare;
  t.mock.method(measurement, 'create', function(...args: Parameters<typeof measure>) {
    const start = performance.now(), result = create(...args); measureMs += performance.now() - start;
    if (result) { measurements++; glyphs += result.glyphCount; measurementBufferBytes += result.bufferBytes; } return result;
  });
  t.mock.method(measurement, 'reflow', function(...args: Parameters<typeof reflow>) { const start = performance.now();
    const result = reflow(...args); reflows++; if (result) { layoutBufferBytes += result.bufferBytes; layoutRows += result.rowCount; layoutSpans += result.spanCount; }
    reflowMs += performance.now() - start; return result; });
  t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, ...args: Parameters<typeof prepare>) {
    const start = performance.now(); try { return prepare.apply(this, args); } finally { prepareMs += performance.now() - start; }
  });
  const paint = CardLayout.prototype.paint;
  t.mock.method(CardLayout.prototype, 'paint', function(this: CardLayout, ...args: Parameters<typeof paint>) { const start = performance.now();
    try { paints++; return paint.apply(this, args); } finally { paintMs += performance.now() - start; } });
  const counts = () => ({ measurements, reflows, glyphs, measurementBufferBytes, layoutBufferBytes, layoutRows, layoutSpans, paints, paintMs, measureMs, reflowMs, prepareMs, ...observer.snapshot() });
  const drain = () => awaitFixture((async () => { for (let i = 0; i < 8 || owner.stats().unsettledJobs || owner.stats().pendingCloses; i++) { owner.flush(); await turn(); } })());
  const reports: Record<string, unknown>[] = [];
  let retainedPolicyPeak = 0, outstandingReservationPeak = 0, combinedPolicyPeak = 0;
  const sample = () => { const s = budget.stats(); retainedPolicyPeak = Math.max(retainedPolicyPeak, s.retainedBytes);
    outstandingReservationPeak = Math.max(outstandingReservationPeak, s.outstandingPeakBytes); combinedPolicyPeak = Math.max(combinedPolicyPeak, s.retainedBytes + s.outstandingPeakBytes); };
  const reserve = DataBudget.prototype.reserve, commit = DataBudget.prototype.commit;
  t.mock.method(DataBudget.prototype, 'reserve', function(this: DataBudget, bytes: number) { const result = reserve.call(this, bytes); if (this === budget) sample(); return result; });
  const charges = new WeakMap<DataCharge, string>(), liveByAllocationSite: Record<string, number> = {};
  t.mock.method(DataBudget.prototype, 'commit', function(this: DataBudget, ...args: Parameters<typeof commit>) {
    const result = commit.apply(this, args); if (this === budget) {
      // Numeric policy attribution, not allocation telemetry: the first source file
      // after the budget frames owns this charge. Keep no source/charge strongly.
      const stack = new Error().stack ?? '', site = stack.split('\n').map(line => line.match(/src\/(?:syntax|occipital)\/([\w-]+\.ts)/)?.[1]).find(site => site && site !== 'data-budget.ts') ?? 'other';
      charges.set(result, site); liveByAllocationSite[site] = (liveByAllocationSite[site] ?? 0) + result.bytes; sample();
    } return result;
  });
  const releaseCharge = DataCharge.prototype.release;
  t.mock.method(DataCharge.prototype, 'release', function(this: DataCharge) {
    const before = this.budget === budget ? budget.stats().retainedBytes : 0; releaseCharge.call(this);
    if (this.budget === budget) { const freed = before - budget.stats().retainedBytes, site = charges.get(this); if (freed && site) liveByAllocationSite[site] -= freed; }
  });
  try {
    await awaitFixture(broker.start()); const [a, b] = broker.snapshot().description!.profiles; assert.ok(a && b); let selected = a;
    const ui = new UI(); themes.initTheme('dark', false);
    adapter = installTidyUi(ui, () => themes.theme, { syntax: { client: { sources: owner, snapshot: () => ({ enabled: true,
      selected: { kind: 'occipital', id: selected.id }, effective: selected, standaloneVersion: 'test', provider: broker.snapshot() }) },
      palette: () => revision, classify: () => assert.fail('ready native sources must not use Pi classifier') } });
    assert.equal(adapter.active, true, adapter.reason);
    let bash: InstanceType<typeof ToolExecutionComponent>, file: InstanceType<typeof ToolExecutionComponent>;
    const render = (node: InstanceType<typeof ToolExecutionComponent>, width: number) => node.render(width).map(stripVTControlCharacters).join('\n');
    const capture = async (name: string, action: () => void | Promise<void>) => { phase = name; const start = performance.now(), before = counts(), beforeWork = owner.stats();
      retainedPolicyPeak = outstandingReservationPeak = combinedPolicyPeak = 0; sample();
      await action(); await drain(); reports.push({ phase, wallMs: performance.now() - start, before, after: counts(), beforeWork, afterWork: owner.stats(), budget: budget.stats(),
        peaks: { retainedPolicyPeak, outstandingReservationPeak, combinedPolicyPeak }, liveByAllocationSite: { ...liveByAllocationSite }, cache: adapter!.cacheStats(), broker: broker.stats() });
      assert.equal(Object.values(liveByAllocationSite).reduce((a, b) => a + b, 0), budget.stats().retainedBytes, 'live attribution reconciles to the one controlled budget'); };
    await capture('sdk-cold-bash', async () => {
      bash = new ToolExecutionComponent('bash', 'c22-bash', { command: 'echo C22_BASH α\necho C22_SECOND' }, undefined, undefined, ui, root);
      ui.addChild(bash); bash.updateResult({ content: [] }, false); assert.match(render(bash, 60), /C22_BASH/); await drain(); assert.match(render(bash, 60), /C22_BASH/);
    });
    assert.ok(measurements > 0); assert.ok(reflows > 0); assert.ok(observer.snapshot().sourceSegments > 0);
    const baseline = counts(), work = broker.stats();
    await capture('sdk-warm', () => { for (let i = 0; i < 10; i++) assert.match(render(bash, 60), /C22_BASH/); });
    assert.deepEqual(counts(), baseline); assert.deepEqual(broker.stats(), work);
    await capture('sdk-width-24', () => { assert.match(render(bash, 24), /C22_BASH/); });
    assert.equal(measurements, baseline.measurements); assert.ok(reflows > baseline.reflows, 'width-change really reflows retained numeric glyph data');
    assert.equal(observer.snapshot().sourceSegments, baseline.sourceSegments); assert.deepEqual(broker.stats(), work);
    const width = counts(), widthSourceWork = observer.snapshot();
    await capture('sdk-uncached-theme', async () => { selected = b; adapter!.syntaxMetadataChanged(); await drain(); render(bash, 24); });
    assert.equal(measurements, width.measurements); assert.equal(reflows, width.reflows); assert.equal(owner.stats().committedLineBytes, (reports[0]!.afterWork as ReturnType<typeof owner.stats>).committedLineBytes);
    const themed = broker.stats(); assert.equal(themed.sourceDispatches, work.sourceDispatches); assert.ok(themed.styleDispatches > work.styleDispatches);
    await capture('sdk-cached-rollback', async () => { selected = a; adapter!.syntaxMetadataChanged(); await drain(); render(bash, 24); });
    assert.deepEqual(broker.stats(), themed); assert.equal(measurements, width.measurements); assert.equal(reflows, width.reflows);
    assert.deepEqual(observer.snapshot(), widthSourceWork, 'theme and rollback never remeasure or reread the source prefix');
    const dense = Array.from({ length: 256 }, (_, i) => `export const C22_v${i}={n:${i},s:"α",a:[true,null],f:(x:number)=>x+1}; // dense`).join('\n');
    await capture('sdk-dense-finite-write', async () => {
      file = new ToolExecutionComponent('write', 'c22-write', { path: 'C22_dense.ts', content: dense }, undefined, undefined, ui, root);
      ui.addChild(file); file.updateResult({ content: [] }, false); render(file, 60); await drain(); assert.match(render(file, 60), /C22_v0/);
    });
    const beforeDense = reports.find(row => row.phase === 'sdk-dense-finite-write')!.beforeWork as ReturnType<typeof owner.stats>;
    assert.equal(owner.stats().committedLineCalls - beforeDense.committedLineCalls, 255, '255 newline-terminated file lines');
    assert.equal(owner.stats().tailCalls - beforeDense.tailCalls, 1, 'last finite line is a provisional tail, not a committed-line call');
    assert.ok(measurements > width.measurements);
    const denseCounts = counts(), denseWork = broker.stats();
    await capture('sdk-dense-width-and-warm', () => { render(file, 24); const atWidth = reflows; render(file, 24); assert.equal(reflows, atWidth); });
    assert.equal(measurements, denseCounts.measurements); assert.ok(reflows > denseCounts.reflows); assert.deepEqual(broker.stats(), denseWork);
    assert.equal(observer.snapshot().sourceSegments, denseCounts.sourceSegments);
    console.log(JSON.stringify({ currentConsumerGeometry: { node: process.version, pi: inputs.pi.version, source: inputs.source, native: binary,
      dense: { bytes: Buffer.byteLength(dense), units: dense.length, sha256: hash(dense) }, reports,
      measurement: 'instrumented SDK; create/reflow/prepare synchronous elapsed times are nested, not additive; bufferBytes are returned measurement Uint32 capacity; bufferBytes/glyphs cumulative created, not simultaneous retained; no whole-process memory or timing threshold' } }));
  } finally { observer.restore(); adapter?.restore(); owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().ownedListeners, 0);
  console.log(JSON.stringify({ currentGeometryCleanup: { owner: owner.stats(), budget: budget.stats(), transport: pipe.stats() } }));
});

test('current consumer latency control: uninstrumented small owned sequence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consumer-latency-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const timings: { phase: string; readyMs: number; eventLoopTurnMs: number; sourceDelta: number; styleDelta: number }[] = [];
  try {
    await awaitFixture(broker.start()); const theme = broker.snapshot().description!.profiles[0]!;
    owner.setStyleSelection({ kind: 'native', id: theme.id, fingerprint: theme.fingerprint });
    const source = { key: 'bash', version: 0, language: 'bash', profile: theme.id, fingerprint: theme.fingerprint, text: '', complete: false };
    for (const [phase, text] of [['cold', 'echo α\n'], ['known-append', 'echo α\necho β\n'], ['new-context-append', 'echo α\necho β\n# C22 new context\n']] as const) {
      const before = broker.stats(), start = performance.now(); let eventLoopTurnMs = 0;
      const event = turn().then(() => { eventLoopTurnMs = performance.now() - start; });
      owner.observe({ ...source, version: ++source.version, text }); owner.flush();
      await awaitFixture((async () => { while (owner.stats().unsettledJobs || owner.displayBasis('bash')?.version !== source.version) { owner.flush(); await turn(); } })());
      await event; const after = broker.stats(); timings.push({ phase, readyMs: performance.now() - start, eventLoopTurnMs,
        sourceDelta: after.sourceDispatches - before.sourceDispatches, styleDelta: after.styleDispatches - before.styleDispatches });
    }
    assert.deepEqual(timings.map(({ sourceDelta, styleDelta }) => [sourceDelta, styleDelta]), [[1, 1], [1, 0], [1, 1]]);
    console.log(JSON.stringify({ currentConsumerUninstrumented: { node: process.version, source: inputs.source, native: binary, timings,
      measurement: 'fresh helper already described; no test spies/request serialization; actual event-loop turn delay, not histogram p99; three observations, no latency guarantee' } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0); assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().retainedBytes, 0);
});

test('current consumer matching reference: uninstrumented cold finite 640-byte Rust Mocha', async () => {
  // Inline the archived workload, not the ignored prototype or its parser.
  const line = 'fn compute(x: i32) -> i32 { let next = x + 42; println!("value={next}"); next }\n';
  const text = line.repeat(8), workloadSha256 = hash(text);
  assert.equal(Buffer.byteLength(line), 80); assert.equal(Buffer.byteLength(text), 640); assert.equal(text.length, 640);
  assert.equal(text.split('\n').length - 1, 8);
  assert.equal(workloadSha256, '76c47f6795c368f91b9956e7de60297f563ef5629d1d2af58b9789ae71e3180e');
  const root = await mkdtemp(join(tmpdir(), 'consumer-matching-reference-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  try {
    await awaitFixture(broker.start());
    const theme = broker.snapshot().description!.profiles.find(profile => profile.id === 'syntect:Catppuccin Mocha'); assert.ok(theme);
    owner.setStyleSelection({ kind: 'native', id: theme.id, fingerprint: theme.fingerprint });
    assert.equal(broker.stats().sourceDispatches, 0); assert.equal(broker.stats().styleDispatches, 0);
    assert.equal(owner.stats().sourceRecords, 0);
    const start = performance.now(); let eventLoopTurnMs = 0;
    const event = turn().then(() => { eventLoopTurnMs = performance.now() - start; });
    owner.observe({ key: 'matching-rust', version: 1, language: 'Rust', profile: theme.id, fingerprint: theme.fingerprint, text, complete: true }); owner.flush();
    await awaitFixture((async () => { while (owner.stats().unsettledJobs || owner.displayBasis('matching-rust')?.version !== 1) { owner.flush(); await turn(); } })());
    const readyMs = performance.now() - start; await event;
    // All inspection/serialization below happens after the timed ready boundary.
    const basis = owner.displayBasis('matching-rust')!, stats = owner.stats(), concrete = new Set<string>();
    let rangeCount = 0, rangeEnd = 0, concreteTableEntries = 0;
    assert.equal(basis.complete, true); assert.equal(basis.language, 'Rust'); assert.equal(basis.profile, theme.id);
    assert.equal(basis.visit((source, ranges) => {
      assert.equal(source, text); assert.equal(ranges((from, to, style) => {
        assert.equal(from, rangeEnd); assert.ok(to > from); rangeEnd = to; rangeCount++;
        assert.equal(style.foreground.kind, 'rgb'); assert.equal(style.background.kind, 'rgb'); concrete.add(JSON.stringify(style));
      }), true);
    }), true);
    assert.equal(basis.visitStyles(() => { concreteTableEntries++; }), true);
    assert.ok(rangeCount > 0); assert.equal(rangeEnd, 640); assert.ok(concreteTableEntries > 0); assert.ok(concrete.size > 1);
    assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().styleDispatches, 1);
    assert.equal(stats.committedLineCalls, 8); assert.equal(stats.committedLineBytes, 640); assert.equal(stats.tailCalls, 0); assert.equal(stats.tailBytes, 0);
    assert.equal(stats.preparedBytes, 640); assert.equal(stats.decodedBytes, 640); assert.equal(stats.remoteLeases, 0);
    console.log(JSON.stringify({ currentMatchingSmallReference: { node: process.version, pi: inputs.pi.version, source: inputs.source, native: binary,
      workload: { language: 'Rust', theme, bytes: 640, utf16Units: text.length, lines: 8, lineBytes: 80, sha256: workloadSha256 }, readyMs, eventLoopTurnMs,
      sourceRequests: broker.stats().sourceDispatches, styleRequests: broker.stats().styleDispatches, rangeCount, coveredBytes: rangeEnd,
      concreteTableEntries, distinctConcreteRangeStyles: concrete.size, controller: stats,
      archivalContext: { oldNativeReadyMs: { node22: 7.051399, node26: 4.450675 }, oldNativeRuns: 272, prototypeRuns: 288,
        comparison: 'same text, Rust and Catppuccin Mocha only; old hardware/preparation/boundary equivalence unestablished; richer current broker SOURCE plus STYLE/palette and ready presentation; no ratio or like-for-like speed claim' },
      measurement: 'fresh actual owned helper already described and native selection set before start; no test spies; finite one-shot; ready clock stops before range/style/counter inspection; event-loop first-turn observation, not p99; no raw-wire/allocator/subphase timing claim' } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().retention.outstandingPeakBytes, 0);
  assert.equal(owner.stats().globalTransientBytes, 0); assert.equal(owner.stats().unsettledJobs, 0); assert.equal(owner.stats().remoteLeases, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().ownedListeners, 0); assert.equal(pipe.stats().liveTimers, 0);
  console.log(JSON.stringify({ currentMatchingSmallCleanup: { owner: owner.stats(), transport: pipe.stats() } }));
});


test('current consumer phase boundaries: palette-only RPC, reply decode, funded adoption and local bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consumer-phase-boundaries-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const pool = new SemanticRetentionPool(), budget = pool.budget;
  const timed = <T,>(work: () => T) => { const start = performance.now(); const value = work(); return { value, ms: performance.now() - start }; };
  let sequence = 0, sourceRequests = 0, styleRequests = 0;
  const call = async (request: Record<string, unknown>) => {
    const ticket = `phase-${++sequence}`, start = performance.now();
    if (request.op === 'highlight') sourceRequests++;
    if (request.op === 'styles.resolve') styleRequests++;
    const value = await pipe.request({ ...request, v: SEMANTIC_PROTOCOL_VERSION, ticket });
    return { value, ticket, requestMs: performance.now() - start };
  };
  const caller: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
  const rows: Record<string, unknown>[] = [];
  try {
    const descriptionReply = await call({ op: 'describe' }), description = decodeSemanticDescription(descriptionReply.value, descriptionReply.ticket);
    const theme = description.profiles.find(profile => profile.id === 'syntect:Catppuccin Mocha'); assert.ok(theme);
    const expectation = { vocabulary: description.vocabulary.fingerprint, rules: fingerprintNative(theme.fingerprint, 'rules'), mode: 'native' as const,
      bindingSlots: 0, paletteFingerprint: fingerprintNative(theme.fingerprint, 'palette') };
    const styleRequest = (contexts: number[][]) => ({ op: 'styles.resolve', instance: description.instance, vocabulary: description.vocabulary.fingerprint,
      rules: { kind: 'native', id: theme.id, fingerprint: theme.fingerprint }, admission: 'bounded_queue', queue_wait_ms: 1000, contexts });
    const nativeStyles = async (phase: string, contexts: number[][]) => {
      const reply = await call(styleRequest(contexts));
      // Re-encoding is outside each clock. This isolates JSON.parse and the actual
      // consumer decoder, not the original transport's socket/framing overhead.
      const json = JSON.stringify(reply.value), parsed = timed(() => JSON.parse(json) as unknown);
      const decoded = timed(() => decodeSemanticStyleReply(parsed.value, reply.ticket, description, expectation, contexts.length, OCCIPITAL_LIMITS.retainedBytes));
      const concrete = timed(() => decoded.value.styles.map(style => materializeStyle(style, [], caller)));
      assert.ok(decoded.value.palette); assert.equal(decoded.value.indices.length, contexts.length);
      assert.equal(decoded.value.palette.slots.length, CARD_ROLES.length);
      assert.ok(concrete.value.length > 0); assert.ok(concrete.value.every(style => Object.isFrozen(style)));
      assert.ok(decoded.value.styles.every(style => style.foreground.kind !== 'binding' && style.background.kind !== 'binding'), 'native materialization does not read Pi bindings');
      rows.push({ phase, contexts: contexts.length, requestMs: reply.requestMs, jsonBytesEquivalent: Buffer.byteLength(json), jsonParseMs: parsed.ms,
        validationAndTypedDecodeMs: decoded.ms, concreteMaterializationMs: concrete.ms, expressions: decoded.value.styles.length,
        typedIndexBytes: decoded.value.indices.byteLength, paletteRoles: decoded.value.palette.slots.length, decodedPolicyBytes: decoded.value.policyBytes });
      return decoded.value;
    };
    const cold = await nativeStyles('native-palette-only-cold', []), warm = await nativeStyles('native-palette-only-cached', []);
    assert.equal(sourceRequests, 0, 'palette-only operations cannot parse source');
    assert.deepEqual(warm, cold, 'same immutable native palette is reused without syntax contexts');
    const text = 'fn compute(x: i32) -> i32 { let next = x + 42; println!("value={next}"); next }\n'.repeat(8);
    assert.equal(Buffer.byteLength(text), 640); assert.equal(hash(text), '76c47f6795c368f91b9956e7de60297f563ef5629d1d2af58b9789ae71e3180e');
    const workloads = [{ name: 'reference-640', language: 'Rust', text }, { name: 'dense-256', language: 'typescript',
      text: Array.from({ length: 256 }, (_, i) => `export const v${i}={n:${i},s:"α",a:[true,null],f:(x:number)=>x+1}; // dense\n`).join('') }];
    for (const workload of workloads) {
      assert.ok(Buffer.byteLength(workload.text) < 32768, 'only previously bounded small workloads');
      const admission = pool.admit(workload.name, 1, workload.text); assert.equal(admission.accepted, true);
      if (!admission.accepted) assert.fail('bounded source admission');
      const generation = admission.generation; assert.ok(generation);
      const reply = await call({ op: 'highlight', instance: description.instance, admission: 'bounded_queue', queue_wait_ms: 1000,
        sources: [{ key: workload.name, generation, source_version: 1, hint: { language: workload.language }, text: workload.text }] });
      const json = JSON.stringify(reply.value), parsed = timed(() => JSON.parse(json) as unknown);
      const expected = [{ key: workload.name, generation, source_version: 1, revision: 1,
        source_bytes: Buffer.byteLength(workload.text), replace_from: 0, complete: true, replacementText: workload.text }];
      const decoded = timed(() => decodeSemanticSourceReply(parsed.value, reply.ticket, description, expected, OCCIPITAL_LIMITS.retainedBytes));
      assert.equal(decoded.value.sources.length, 1); const chunk = decoded.value.sources[0]!;
      const before = budget.stats().retainedBytes, adopted = timed(() => pool.installChunk(generation, chunk));
      assert.equal(adopted.value.accepted, true); assert.equal(chunk.runs.at(-2), Buffer.byteLength(workload.text));
      assert.equal(chunk.counters.committed_line_bytes, Buffer.byteLength(workload.text)); assert.equal(chunk.counters.tail_calls, 0);
      rows.push({ phase: `${workload.name}-source`, sourceBytes: Buffer.byteLength(workload.text), sha256: hash(workload.text), requestMs: reply.requestMs,
        jsonBytesEquivalent: Buffer.byteLength(json), jsonParseMs: parsed.ms, validationAndTypedDecodeMs: decoded.ms, contextRangeAdoptionMs: adopted.ms,
        decodedPolicyBytes: decoded.value.policyBytes, typedRunBytes: chunk.runs.byteLength, typedContextBytes: chunk.contexts.reduce((n, c) => n + c.byteLength, 0),
        runs: chunk.runs.length / 2, contexts: chunk.contexts.length, retainedPolicyDelta: budget.stats().retainedBytes - before });
      await nativeStyles(`${workload.name}-styles`, chunk.contexts.map(context => [0, ...context]));
      pool.remove(generation);
      assert.equal(budget.stats().retainedBytes, 0, 'phase input and ranges released before next workload');
    }
    themes.initTheme('dark', false);
    const pi = timed(() => preparePiInput(themes.theme, 1, 'truecolor', { budget, grant: bytes => budget.reserve(bytes) }));
    assert.ok(pi.value); const lease = pi.value;
    try {
      let roles = 0, bindings = 0;
      assert.equal(lease.visit(read => { roles = Object.keys(read.roles).length; bindings = read.bindings.length; }), true);
      assert.equal(roles, CARD_ROLES.length); assert.ok(bindings > 0);
      rows.push({ phase: 'local-pi-input', inputPrepareMs: pi.ms, roles, bindings, retainedPolicyBytes: budget.stats().retainedBytes });
    } finally { lease.dispose(); }
    assert.equal(sourceRequests, 2); assert.equal(styleRequests, 4); assert.equal(budget.stats().retainedBytes, 0);
    console.log(JSON.stringify({ currentConsumerPhaseBoundaries: { node: process.version, pi: inputs.pi.version, source: inputs.source, native: binary,
      rows, sourceRequests, styleRequests, measurement: 'one bounded observation per phase; palette-only RPC includes transport, definition compilation and native palette cache/preparation, NOT isolated Rust CPU; JSON reserialization before clocks excludes socket/framing; validation includes typed-vector allocation; adoption includes actual funded context/range interning; local Pi sampling separate; no geometry, allocator/RSS/peak claim, speed ratio or latency guarantee' } }));
  } finally { pool.dispose(); await awaitFixture(pipe.close()); await rm(root, { recursive: true, force: true }); }
  assert.equal(budget.stats().retainedBytes, 0); assert.equal(budget.stats().outstandingPeakBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().retainedBytes, 0); assert.equal(pipe.stats().ownedListeners, 0);
});
