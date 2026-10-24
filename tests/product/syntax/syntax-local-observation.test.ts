import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSyntaxLocalWork, observeSyntaxCards, observePiPaletteWork, createWriteCaptureGate, type WriteCaptureObservation, type SyntaxCardObservation } from '../../fixtures/syntax-local-work.ts';
import { Container } from '@earendil-works/pi-tui';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installTidyUi } from '../../../src/index.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { measure, reflow } from '../../../src/syntax/measured-rows.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { SyntaxClient } from '../../../src/occipital/client.ts';
import { preparePiInput } from '../../../src/syntax/pi-input.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { hostCells } from '../../fixtures/host-cells.ts';
import { samplePiPalette } from '../../../src/syntax/pi-palette.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';

test('syntax local observations count actual source measurement, not unrelated segmentation or scalar reads', () => {
  const source = 'OBSERVED_SOURCE αβ\nsecond row', budget = new DataBudget(8 * 1024 * 1024), observer = observeSyntaxLocalWork(text => text === source);
  let measured: ReturnType<typeof measure>;
  try {
    [...new Intl.Segmenter().segment(source)]; source.codePointAt(0);
    Reflect.apply(Intl.Segmenter.prototype.segment, new Intl.Segmenter(), []);
    assert.deepEqual(observer.snapshot(), { sourceSegments: 0, sourceSegmentUnits: 0, shebangFileSegments: 0, prefixScalarReads: 0 });
    measured = measure(source, budget); assert.ok(measured);
    const cold = observer.snapshot(); assert.deepEqual(cold, { sourceSegments: 1, sourceSegmentUnits: source.length, shebangFileSegments: 0, prefixScalarReads: 0 });
    for (const width of [24, 100, 60]) { const rows = reflow(measured, { mode: 'file', width }); assert.ok(rows); rows.dispose(); }
    assert.deepEqual(observer.snapshot(), cold, 'real warm reflow needs no new source measurement');
    const duplicate = measure(source, budget); assert.ok(duplicate); duplicate.dispose();
    assert.equal(observer.snapshot().sourceSegments, cold.sourceSegments + 1, 'a real redundant measurement is observable');
  } finally { measured?.dispose(); observer.restore(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('syntax local observers restore only their still-owned operations', () => {
  const segment = Intl.Segmenter.prototype.segment, scalar = String.prototype.codePointAt, visit = CardSources.prototype.visit, update = CardSources.prototype.updateDisplay;
  const observer = observeSyntaxLocalWork();
  const observed = String.prototype.codePointAt;
  const later = function(this: string, index: number) { return observed.call(this, index); };
  const observedUpdate = CardSources.prototype.updateDisplay;
  const laterUpdate: typeof update = function(this: CardSources<object>, ...args) { return observedUpdate.apply(this, args); };
  try {
    String.prototype.codePointAt = later; CardSources.prototype.updateDisplay = laterUpdate;
    observer.restore();
    assert.equal(Intl.Segmenter.prototype.segment, segment); assert.equal(CardSources.prototype.visit, visit);
    assert.equal(String.prototype.codePointAt, later, 'do not erase a later owner');
    assert.equal(CardSources.prototype.updateDisplay, laterUpdate);
  } finally {
    if (String.prototype.codePointAt === later) String.prototype.codePointAt = scalar;
    if (CardSources.prototype.updateDisplay === laterUpdate) CardSources.prototype.updateDisplay = update;
    observer.restore();
  }
});

test('syntax card observations follow actual preparation and only outer-accepted SDK visits', async t => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  class UI extends Container { requestRender() {} }
  const ui = new UI(), provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
  let adapter: ReturnType<typeof installTidyUi> | undefined;
  const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false,
    request: () => { throw Error('disabled'); } }, { onChange: (keys, groups) => adapter?.syntaxSourceChanged(keys, groups) });
  sources.setEnabled(false);
  const original = CardSources.prototype.visit, prepare = CardSources.prototype.prepare, events: SyntaxCardObservation[] = [], failure = new Error('outer visit failure');
  let ticketRef: WeakRef<Parameters<typeof prepare>[0]> | undefined;
  t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, ticket: Parameters<typeof prepare>[0]) {
    ticketRef = new WeakRef(ticket); return prepare.call(this, ticket);
  });
  let outcome = 'accept', owner: WeakRef<object> | undefined, cards: WeakRef<CardSources<object>> | undefined;
  t.mock.method(CardSources.prototype, 'visit', function(this: CardSources<object>, ...args: Parameters<typeof original>) {
    owner = new WeakRef(args[0]); cards = new WeakRef(this);
    const accepted = original.apply(this, args); if (outcome === 'throw') throw failure; return outcome === 'refuse' ? false : accepted;
  });
  const observer = observeSyntaxCards(event => events.push(event));
  try {
    adapter = installTidyUi(ui, () => themes.theme, { syntax: { client: { sources, snapshot: () => ({ enabled: false,
      selected: { kind: 'pi' }, standaloneVersion: 'test', provider }) }, palette: () => 1, classify: text => [text] } });
    const node = new ToolExecutionComponent('write', 'observed', { path: 'observer.ts', content: 'const observed=1;' }, undefined, undefined, ui, '/tmp');
    ui.addChild(node); node.updateResult({ content: [], isError: false }, false);
    node.render(60); for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(events.some(e => e.type === 'syntax_card_prepare' && e.kind === 'write' && e.path === 'observer.ts'));
    assert.ok(events.some(e => e.type === 'syntax_card_prepared' && e.kind === 'write'));
    const visit = CardSources.prototype.visit;
    const acceptedBefore = events.filter(e => e.type === 'syntax_card_publication').length;
    node.render(24); assert.ok(events.filter(e => e.type === 'syntax_card_publication').length > acceptedBefore);
    const edit = new ToolExecutionComponent('edit', 'same-path-edit', { path: 'observer.ts', oldText: 'const observed=1;', newText: 'const observed=2;' }, undefined, undefined, ui, '/tmp');
    ui.addChild(edit); edit.updateResult({ content: [], details: { diff: '-1 const observed=1;\n+1 const observed=2;' }, isError: false }, false);
    edit.render(60);
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
    node.render(24); edit.render(24);
    const written = events.findLast(e => e.type === 'syntax_card_prepared' && e.kind === 'write')!;
    const edited = events.findLast(e => e.type === 'syntax_card_prepared' && e.kind === 'edit')!;
    assert.notEqual(written.id, edited.id); assert.equal(written.path, edited.path);
    for (const prepared of [written, edited]) assert.ok(events.some(e => e.type === 'syntax_card_publication' && e.id === prepared.id && e.kind === prepared.kind && e.path === prepared.path),
      'same-path write/edit publications preserve authoritative distinct ticket identities');
    const selectedOwner = owner!.deref()!, selectedCards = cards!.deref()!;
    const preparedBefore = events.filter(e => e.type === 'syntax_card_prepared').length;
    selectedCards.prepare(ticketRef!.deref()!);
    assert.equal(events.at(-1)?.type, 'syntax_card_prepare');
    assert.equal(events.filter(e => e.type === 'syntax_card_prepared').length, preparedBefore, 'a repeated epoch bookkeeping call is not new preparation progress');
    outcome = 'refuse'; const before = events.length;
    assert.equal(selectedCards.visit(selectedOwner, () => {}), false);
    assert.equal(events.length, before, 'a callback followed by outer refusal is not publication');
    outcome = 'throw'; assert.throws(() => selectedCards.visit(selectedOwner, () => {}), error => error === failure);
    assert.equal(events.length, before, 'a callback followed by throw is not publication');
    assert.equal(CardSources.prototype.visit, visit);
    outcome = 'accept';
    assert.equal(selectedCards.visit(selectedOwner, () => observer.restore()), true);
    assert.equal(events.length, before, 'shutdown discards the provisional record and releases identity correlation');
  } finally { observer.restore(); adapter?.restore(); sources.dispose(); }
});

test('syntax local observations cover actual restored, newly demanded and backlog source measurements', () => {
  const budget = new DataBudget(8 * 1024 * 1024), observer = observeSyntaxLocalWork();
  try {
    for (const [i, source] of [": 'ONLINE_WAIT_FIRST", "printf 'USER_BASH_OUTPUT\\n'", "printf 'ORDER_CARD_7\\n'"].entries()) {
      const measured = measure(source, budget); assert.ok(measured);
      try {
        assert.equal(observer.snapshot().sourceSegments, i + 1, 'the actual new scenario source is watched');
        const before = observer.snapshot();
        const rows = reflow(measured, { mode: 'bash', width: 24 }); assert.ok(rows); rows.dispose();
        assert.deepEqual(observer.snapshot(), before);
      } finally { measured.dispose(); }
    }
  } finally { observer.restore(); }
  assert.equal(budget.stats().retainedBytes, 0);
});

test('syntax card observers preserve later preparation and visit owners', () => {
  const prepare = CardSources.prototype.prepare, visit = CardSources.prototype.visit, observer = observeSyntaxCards(() => {});
  const observedPrepare = CardSources.prototype.prepare, observedVisit = CardSources.prototype.visit;
  const laterPrepare: typeof prepare = function(this: CardSources<object>, ticket) { return observedPrepare.call(this, ticket); };
  const laterVisit: typeof visit = function(this: CardSources<object>, owner, consume) { return observedVisit.call(this, owner, consume); };
  try {
    CardSources.prototype.prepare = laterPrepare; CardSources.prototype.visit = laterVisit;
    observer.restore(); assert.equal(CardSources.prototype.prepare, laterPrepare); assert.equal(CardSources.prototype.visit, laterVisit);
  } finally {
    if (CardSources.prototype.prepare === laterPrepare) CardSources.prototype.prepare = prepare;
    if (CardSources.prototype.visit === laterVisit) CardSources.prototype.visit = visit;
    observer.restore();
  }
});

// C25C investigation probe: the dump's synchronous render and the later physical
// frame are different observations. No readiness timeout or render request is added.
test('C25C saved write cold dump precedes bounded Pi preparation and its render notice', async t => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  const created = ['/* write comment', 'continued write comment */', 'export const value = "界é";',
    ...Array.from({ length: 15 }, (_, i) => `const line${i + 4} = ${i + 4};`), 'const WRITE_TAIL_19 = 19;'];
  const fixtures = [
    { path: 'write-created.ts', content: 'ARGS_CREATED_MUST_NOT_REPLACE_RESULT', fixtureCase: 'created', details: { diff: created.map((line, i) => `+${i + 1} ${line}`).join('\n') } },
    { path: 'write-edited.ts', content: 'const supplied_edited = 42;', fixtureCase: 'edited', details: { diff: ' 1 const old1 = 1;\n 2 const old2 = 2;\n 3 const old3 = 3;\n 4 const old4 = 4;\n+5 const ADDED_WRITE = 5;\n 5 const tail = 6;' } },
    { path: 'write-replaced.ts', content: 'const supplied_replaced = 42;', fixtureCase: 'replaced', details: { patch: '@@ -1,2 +1,2 @@\n-const BEFORE_WRITE = 1;\n-const OLD_WRITE = 2;\n+const AFTER_WRITE = 3;\n+const NEXT_WRITE = 4;\n' } },
    { path: 'write-cleared.ts', content: '', fixtureCase: 'cleared', details: { diff: '-1 const ERASED_WRITE = 1;' } },
    { path: 'write-noop.ts', content: 'const supplied_noop = 42;', fixtureCase: 'noop', details: { diff: '', noOp: true } },
    { path: 'write-context-only.ts', content: 'const supplied_context_only = 42;', fixtureCase: 'context-only', details: { diff: ' 1 const unchanged = 1;' } },
    { path: 'write-truncated.ts', content: 'const supplied_truncated = 42;', fixtureCase: 'truncated', details: { diff: '+1 INCOMPLETE_DIFF', truncated: true } },
    { path: 'write-plain.ts', content: 'const supplied_plain = 42;', fixtureCase: 'plain', details: undefined },
  ];
  const timeline: unknown[] = [], calls: { text: string; info: { language?: string; path?: string }; styled: boolean }[] = [];
  let prepared = 0, renders = 0, complete!: () => void;
  const published = new Promise<void>(resolve => { complete = resolve; });
  class UI extends Container { requestRender() { renders++; timeline.push({ event: 'requestRender', prepared, classifications: calls.length }); if (prepared === fixtures.length) complete(); } }
  const ui = new UI();
  let adapter: ReturnType<typeof installTidyUi> | undefined;
  const client = new SyntaxClient({ standaloneVersion: '0.1.0-test', initialTheme: { kind: 'pi' }, provider: {
    tryShared: async () => undefined, acquireOwned: async () => { throw Error('offline presentation control'); },
  }, onSourceChange: (keys, groups) => {
    timeline.push({ event: 'sourceNotice', keys, groups }); adapter?.syntaxSourceChanged(keys, groups);
  }, onChange: () => adapter?.syntaxMetadataChanged() });
  await client.start();
  const sources = client.sources;
  const sourceChanged = client.acceptSourceChange;
  t.mock.method(client, 'acceptSourceChange', function(this: SyntaxClient, keys: readonly string[] = [], groups?: readonly number[]) {
    timeline.push({ event: 'controllerNotice', keys, groups }); return sourceChanged.call(this, keys, groups);
  });
  const original = CardSources.prototype.prepare;
  t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, ticket: Parameters<typeof original>[0]) {
    original.call(this, ticket); prepared++; const owner = ticket.owner.deref();
    timeline.push({ event: 'prepared', prepared, identities: owner ? this.identities(owner) : [] });
  });
  try {
    adapter = installTidyUi(ui, () => themes.theme, { syntax: { client, palette: () => 1, classify: (text, info) => {
      const rows = themes.highlightCode(text, info.language); calls.push({ text, info, styled: rows.some((row: string) => row.includes('\x1b[')) });
      timeline.push({ event: 'classify', path: info.path, language: info.language, units: text.length }); return rows;
    } } });
    const nodes = fixtures.map(({ details, ...args }, i) => {
      const node = new ToolExecutionComponent('write', `terminal-1-${i === 7 ? 8 : i}`, args, undefined, undefined, ui, '/tmp');
      ui.addChild(node); node.updateResult({ content: [], isError: false, details }, false); return node;
    });
    const before = JSON.stringify(fixtures);
    const cold = nodes.map(node => node.render(100));
    timeline.push({ event: 'synchronousDump', prepared, classifications: calls.length, renders });
    assert.equal(calls.length, 0, 'cold dump does not synchronously invoke the classifier');
    assert.equal(prepared, 0);
    await published;
    assert.equal(prepared, fixtures.length);
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.styled));
    const first = calls.find(call => call.info.path === 'write-created.ts')!;
    assert.equal(first.text, created.join('\n')); assert.equal(first.info.language, 'typescript');
    const warm = nodes.map(node => node.render(100));
    const classified = calls.length;
    assert.notDeepEqual(warm[0], cold[0]);
    for (const node of nodes) node.render(100);
    assert.equal(calls.length, classified, 'settled warm render never retries a cached projection');
    assert.equal(JSON.stringify(fixtures), before);
    console.log('C25C_PROBE_BASE64 ' + Buffer.from(JSON.stringify({ timeline, calls, classifications: calls.length, prepared, renders, sourceStats: sources.stats() })).toString('base64'));
  } finally { adapter?.restore(); await client.dispose(); }
});

test('write capture readiness distinguishes neutral, valid plain, stale source/palette and rejected outer visits', async t => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  const events: WriteCaptureObservation[] = [], published: WriteCaptureObservation[] = [];
  const gate = createWriteCaptureGate(event => published.push(event));
  const originalVisit = CardSources.prototype.visit, originalPrepare = CardSources.prototype.prepare;
  let outcome = 'accept', ticket: WeakRef<Parameters<typeof originalPrepare>[0]> | undefined;
  t.mock.method(CardSources.prototype, 'visit', function(this: CardSources<object>, ...args: Parameters<typeof originalVisit>) {
    const accepted = originalVisit.apply(this, args);
    if (outcome === 'throw') throw new Error('rejected outer visit');
    return outcome === 'reject' ? false : accepted;
  });
  t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, value: Parameters<typeof originalPrepare>[0]) {
    ticket = new WeakRef(value); return originalPrepare.call(this, value);
  });
  const observer = observeSyntaxCards(() => {}, { writeCapture: event => { events.push(event); gate.observe(event); } });
  const provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
  const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false, request: () => assert.fail('no native work') });
  sources.setEnabled(false);
  let palette = 1, classifications = 0, onInvalidation: (() => void) | undefined;
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: false, selected: { kind: 'pi' as const }, standaloneVersion: 'test', provider }) }, {
    preparePiInput: funding => preparePiInput(themes.theme, palette, 'truecolor', funding),
    classify: text => { classifications++; return text.split('\n'); }, invalidate() { onInvalidation?.(); }, requestRender() {},
  });
  const owner = { toolName: 'write', toolCallId: 'plain-call' };
  const input = (revision: number, content = 'plain source') => ({ kind: 'file' as const, node: { toolName: 'write', args: { path: 'same.ts', content }, isPartial: false, result: {} },
    revision, sourceRevision: revision, serviceRevision: revision, palette, mode: 'truecolor' as const });
  try {
    assert.equal(cards.updateDisplay(owner, input(1)), true);
    cards.visit(owner, () => {}); assert.equal(events.at(-1)?.status, 'pending', 'neutral shell is not a classified plain projection');
    let done = false; const waiting = gate.wait().then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    cards.useful(owner, 1); sources.flush();
    const beforeVisit = events.length; outcome = 'reject';
    assert.equal(cards.visit(owner, () => {}), false); assert.equal(events.length, beforeVisit);
    outcome = 'throw'; assert.throws(() => cards.visit(owner, () => {}), /rejected outer visit/); assert.equal(events.length, beforeVisit);
    outcome = 'accept'; cards.visit(owner, () => {}); await waiting;
    assert.equal(events.at(-1)?.status, 'ready'); assert.equal(classifications, 1, 'successful plain is accepted without retrying for colors');
    const initial = events.at(-1)!;
    cards.visit(owner, () => {}); assert.equal(classifications, 1); assert.equal(published.length, 2, 'identical warm observations add no journal chatter');
    onInvalidation = () => { cards.visit(owner, () => {}); };
    assert.equal(cards.updateDisplay(owner, input(2, 'changed source')), true);
    cards.visit(owner, () => {}); assert.equal(events.at(-1)?.status, 'stale');
    cards.prepare(ticket!.deref()!);
    assert.equal(events.at(-1)?.status, 'ready', 'accepted paint inside preparation is sufficient without requiring an extra later visit');
    cards.visit(owner, () => {});
    assert.notEqual(events.at(-1)?.version, initial.version);
    palette = 2; const changedPalette = { ...input(3, 'changed source'), sourceRevision: 2 };
    assert.equal(cards.updateDisplay(owner, changedPalette), true);
    cards.visit(owner, () => {}); assert.equal(events.at(-1)?.status, 'stale');
    cards.prepare(ticket!.deref()!); cards.visit(owner, () => {});
    assert.equal(events.at(-1)?.status, 'ready'); assert.equal(events.at(-1)?.palette, 2);
    const other = { toolName: 'write', toolCallId: 'same-path-other-call' };
    cards.updateDisplay(other, input(1)); cards.visit(other, () => {});
    let bothDone = false; const both = gate.wait().then(() => { bothDone = true; });
    await Promise.resolve(); assert.equal(bothDone, false, 'a same-path ready call cannot satisfy another owner');
    cards.useful(other, 1); sources.resumePreparation(); cards.visit(other, () => {}); await both;
    assert.notEqual(events.findLast(e => e.call === owner.toolCallId)?.id, events.findLast(e => e.call === other.toolCallId)?.id);
    const empty = { toolName: 'write', toolCallId: 'empty-call' };
    cards.updateDisplay(empty, input(1, '')); cards.visit(empty, () => {});
    cards.useful(empty, 1); sources.resumePreparation(); cards.visit(empty, () => {});
    assert.equal(events.at(-1)?.status, 'ready'); assert.equal(events.at(-1)?.sources, 0);
    palette = 3; cards.updateDisplay(empty, { ...input(2, ''), sourceRevision: 1 }); cards.visit(empty, () => {});
    assert.equal(events.at(-1)?.status, 'stale');
    cards.prepare(ticket!.deref()!); cards.visit(empty, () => {});
    assert.equal(events.at(-1)?.status, 'ready', 'empty source needs no new token map after its role palette is already compiled');
    assert.equal(events.at(-1)?.palette, 3);
    const edit = { toolName: 'edit', toolCallId: 'same-path-edit' }, count = events.length;
    cards.updateDisplay(edit, { ...input(1), node: { ...input(1).node, toolName: 'edit', result: { details: { diff: '-1 plain source\n+1 changed source' } } } }); cards.visit(edit, () => {});
    assert.equal(events.length, count, 'other tool kinds cannot enter the write-only gate');
    const laterVisit = CardSources.prototype.visit, wrapper: typeof laterVisit = function(this: CardSources<object>, ...args) { return laterVisit.apply(this, args); };
    CardSources.prototype.visit = wrapper;
    observer.restore(); assert.equal(CardSources.prototype.visit, wrapper, 'restore preserves a later wrapper');
    const stopped = events.length; cards.visit(owner, () => {}); assert.equal(events.length, stopped);
    CardSources.prototype.visit = originalVisit;
  } finally { observer.restore(); gate.close(); cards.dispose(); sources.dispose(); }
});

for (const failure of ['failed', 'refused'] as const) test(`write capture gate surfaces actual ${failure} preparation and closes pending waits`, async t => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  const events: WriteCaptureObservation[] = [], gate = createWriteCaptureGate(event => events.push(event));
  const observer = observeSyntaxCards(() => {}, { writeCapture: event => gate.observe(event) });
  const provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
  const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false, request: () => assert.fail('no native work') }); sources.setEnabled(false);
  if (failure === 'refused') t.mock.method(sources, 'capturePiSource', () => false);
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: false, selected: { kind: 'pi' as const }, standaloneVersion: 'test', provider }) }, {
    preparePiInput: funding => preparePiInput(themes.theme, 1, 'truecolor', funding), classify: () => { throw Error('classifier failure'); }, invalidate() {}, requestRender() {},
  });
  const owner = { toolName: 'write', toolCallId: 'failed-call' };
  try {
    await assert.rejects(gate.wait(), /no observed source-card/);
    cards.updateDisplay(owner, { kind: 'file', node: { toolName: 'write', args: { path: 'failed.ts', content: 'source' }, isPartial: false, result: {} },
      revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor' });
    cards.visit(owner, () => {});
    const initial = events.at(-1)!;
    const pending = assert.rejects(gate.wait(), new RegExp(failure));
    cards.useful(owner, 1); sources.flush(); cards.visit(owner, () => {}); await pending;
    assert.equal(events.at(-1)?.status, failure);
    const closedEvents: WriteCaptureObservation[] = [], closed = createWriteCaptureGate(event => closedEvents.push(event));
    closed.observe(initial); const closing = assert.rejects(closed.wait(), /closed during wait/); closed.close(); await closing;
    closed.observe(events.at(-1)!); assert.equal(closedEvents.length, 1, 'late work cannot revive a closed gate');
    await assert.rejects(closed.wait(), /closed/);
  } finally { observer.restore(); gate.close(); cards.dispose(); sources.dispose(); }
});

test('write capture review F1: empty dark roles cannot certify refused light replacement, but actual light adoption can', async t => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  const events: WriteCaptureObservation[] = [], gate = createWriteCaptureGate(event => events.push(event));
  const originalPrepare = CardSources.prototype.prepare;
  let ticket: WeakRef<Parameters<typeof originalPrepare>[0]> | undefined;
  t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, value: Parameters<typeof originalPrepare>[0]) {
    ticket = new WeakRef(value); return originalPrepare.call(this, value);
  });
  const observer = observeSyntaxCards(() => {}, { writeCapture: event => gate.observe(event) });
  const provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
  const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false, request: () => assert.fail('no native work') }); sources.setEnabled(false);
  let palette = 1, deny = false, refused = 0;
  const funding = sources.geometryFunding.bind(sources);
  t.mock.method(sources, 'geometryFunding', (...args: Parameters<typeof funding>) => {
    const current = funding(...args); if (!current) return current;
    return { ...current, grant(bytes: number) {
      // The existing role-table funding seam, not an invented product limit.
      if (deny && bytes === 4096 + CARD_ROLES.length * 2048) { refused++; return undefined; }
      return current.grant(bytes);
    } };
  });
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: false, selected: { kind: 'pi' as const }, standaloneVersion: 'test', provider }) }, {
    preparePiInput: funding => preparePiInput(themes.theme, palette, 'truecolor', funding), classify: text => text.split('\n'), invalidate() {}, requestRender() {},
  });
  const owner = { toolName: 'write', toolCallId: 'empty-role-replacement' };
  const input = (revision: number) => ({ kind: 'file' as const, node: { toolName: 'write', args: { path: 'empty.ts', content: '' }, isPartial: false, result: {} },
    revision, sourceRevision: 1, serviceRevision: revision, palette, mode: 'truecolor' as const });
  const roles = () => { const rows: string[] = []; assert.equal(cards.visit(owner, (_display, paint) => {
    for (const role of ['code', 'frame'] as const) rows.push(paint.roles[role].open + 'X' + paint.roles[role].close);
  }), true); return rows; };
  let waiting: Promise<unknown> | undefined;
  try {
    cards.updateDisplay(owner, input(1)); cards.useful(owner, 1); sources.flush();
    const dark = await hostCells(roles()); assert.equal(events.at(-1)?.status, 'ready'); await gate.wait();
    themes.initTheme('light', false); palette = 2; deny = true;
    assert.equal(cards.updateDisplay(owner, input(2)), true); cards.prepare(ticket!.deref()!);
    const retained = await hostCells(roles()), state = ticket!.deref()!.state.deref()!;
    assert.ok(refused > 0, 'real compiled-role replacement funding was denied');
    assert.equal(state.preparedPalette, 2); assert.equal(state.pi?.paletteRevision, 2);
    assert.deepEqual(retained, dark, 'actual old dark compiled roles remain, despite the current light lease/preparation');
    const rejectedPaint = { preparedPalette: state.preparedPalette, lease: state.pi?.paletteRevision, token: state.paintToken, publication: state.paint?.publication };
    let resolved = false; waiting = gate.wait().then(() => { resolved = true; }); waiting.catch(() => {});
    await Promise.resolve(); assert.equal(resolved, false, 'old compiled roles cannot make the current light capture ready');
    assert.notEqual(events.at(-1)?.status, 'ready');
    deny = false; cards.prepare(ticket!.deref()!);
    const light = await hostCells(roles()); await waiting;
    const expected = await hostCells(['toolOutput', 'borderMuted'].map(role => themes.theme.bg('toolPendingBg', themes.theme.fg(role, 'X'))));
    assert.deepEqual(light, expected, 'adopted code/frame roles match real current public light Pi bindings');
    assert.notDeepEqual(light, dark); assert.equal(events.at(-1)?.status, 'ready');
    console.log('C25C3_F1_BASE64 ' + Buffer.from(JSON.stringify({ refused, rejectedPaint, adoptedPaint: { token: state.paintToken, publication: state.paint?.publication },
      dark: dark.map(row => row[0]), light: light.map(row => row[0]), events })).toString('base64'));
  } finally { observer.restore(); gate.close(); await waiting?.catch(() => {}); cards.dispose(); sources.dispose(); themes.initTheme('dark', false); }
});

for (const change of ['source', 'palette'] as const) for (const rejection of ['reject-before', 'reject-after', 'throw-before', 'throw-after'] as const)
  test(`write capture review F2: ready A is revoked for changed ${change} B with ${rejection}`, async t => {
    const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
    const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
    const events: WriteCaptureObservation[] = [], gate = createWriteCaptureGate(event => events.push(event));
    const originalVisit = CardSources.prototype.visit, originalPrepare = CardSources.prototype.prepare;
    let mode = 'accept', callbacks = 0, ticket: WeakRef<Parameters<typeof originalPrepare>[0]> | undefined;
    t.mock.method(CardSources.prototype, 'visit', function(this: CardSources<object>, owner: object, consume: Parameters<typeof originalVisit>[1]) {
      if (mode === 'reject-before') return false;
      if (mode === 'throw-before') throw Error('outer rejected B');
      const accepted = originalVisit.call(this, owner, (display, paint) => { callbacks++; consume(display, paint); });
      if (mode === 'throw-after') throw Error('outer rejected B');
      return mode === 'reject-after' ? false : accepted;
    });
    t.mock.method(CardSources.prototype, 'prepare', function(this: CardSources<object>, value: Parameters<typeof originalPrepare>[0]) {
      ticket = new WeakRef(value); return originalPrepare.call(this, value);
    });
    const observer = observeSyntaxCards(() => {}, { writeCapture: event => gate.observe(event) });
    const provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
    const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false, request: () => assert.fail('no native work') }); sources.setEnabled(false);
    let palette = 1;
    const cards = new CardSources({ sources, snapshot: () => ({ enabled: false, selected: { kind: 'pi' as const }, standaloneVersion: 'test', provider }) }, {
      preparePiInput: funding => preparePiInput(themes.theme, palette, 'truecolor', funding), classify: text => text.split('\n'), invalidate() {}, requestRender() {},
    });
    const owner = { toolName: 'write', toolCallId: 'transition-call' };
    const input = (revision: number) => ({ kind: 'file' as const, node: { toolName: 'write', args: { path: 'transition.ts', content: change === 'source' && revision === 2 ? 'source B' : 'source A' }, isPartial: false, result: {} },
      revision, sourceRevision: change === 'source' ? revision : 1, serviceRevision: revision, palette, mode: 'truecolor' as const });
    let waiting: Promise<unknown> | undefined;
    try {
      cards.updateDisplay(owner, input(1)); cards.useful(owner, 1); sources.flush(); cards.visit(owner, () => {});
      const a = (await gate.wait())[0]!; assert.equal(a.status, 'ready');
      if (change === 'palette') { themes.initTheme('light', false); palette = 2; }
      mode = rejection; cards.updateDisplay(owner, input(2)); cards.prepare(ticket!.deref()!);
      const beforeCallbacks = callbacks, beforeReady = events.filter(event => event.status === 'ready').length;
      if (rejection.startsWith('throw')) assert.throws(() => cards.visit(owner, () => {}), /outer rejected B/);
      else assert.equal(cards.visit(owner, () => {}), false);
      assert.equal(callbacks - beforeCallbacks, rejection.endsWith('before') ? 0 : 1);
      assert.equal(events.filter(event => event.status === 'ready').length, beforeReady, 'rejected B cannot publish success');
      let resolved = false; waiting = gate.wait().then(() => { resolved = true; }); waiting.catch(() => {});
      await Promise.resolve(); assert.equal(resolved, false, 'gate.wait after rejection cannot resolve from ready A');
      assert.notEqual(events.at(-1)?.status, 'ready');
      mode = 'accept'; assert.equal(cards.visit(owner, () => {}), true); await waiting;
      const b = (await gate.wait())[0]!; assert.equal(b.status, 'ready'); assert.equal(b.revision, 2);
      assert.equal(b.version, change === 'source' ? 2 : 1); assert.equal(b.palette, palette);
      assert.notEqual(change === 'source' ? b.version : b.palette, change === 'source' ? a.version : a.palette);
      // Even unchanged B must lose readiness when its current outer visit fails.
      mode = rejection;
      const successful = events.filter(event => event.status === 'ready').length;
      if (rejection.startsWith('throw')) assert.throws(() => cards.visit(owner, () => {}), /outer rejected B/);
      else assert.equal(cards.visit(owner, () => {}), false);
      resolved = false; waiting = gate.wait().then(() => { resolved = true; }); waiting.catch(() => {});
      await Promise.resolve(); assert.equal(resolved, false);
      assert.equal(events.filter(event => event.status === 'ready').length, successful);
      mode = 'accept'; cards.visit(owner, () => {}); await waiting;
      console.log('C25C3_F2_BASE64 ' + Buffer.from(JSON.stringify({ change, rejection, events })).toString('base64'));
    } finally { observer.restore(); gate.close(); await waiting?.catch(() => {}); cards.dispose(); sources.dispose(); themes.initTheme('dark', false); }
  });

test('syntax local observations count an actual watched Bash suffix without repeating its full marker', async () => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href); themes.initTheme('dark', false);
  const provider = { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false };
  const sources = new SourceController({ snapshot: () => provider, isReady: () => false, classificationAccepted: () => false, request: () => assert.fail('no native work') }); sources.setEnabled(false);
  const cards = new CardSources({ sources, snapshot: () => ({ enabled: false, selected: { kind: 'pi' as const }, standaloneVersion: 'test', provider }) }, {
    preparePiInput: funding => preparePiInput(themes.theme, 1, 'truecolor', funding), classify: () => assert.fail('no Bash Pi classification'), invalidate() {}, requestRender() {},
  });
  const observer = observeSyntaxLocalWork(), owner = {}, command = ": 'STABLE_text e", input = { kind: 'bash' as const, args: { command }, complete: false,
    revision: 1, sourceRevision: 1, serviceRevision: 1, palette: 1, mode: 'truecolor' as const, language: 'bash' };
  try {
    assert.equal(cards.updateDisplay(owner, input), true); const cold = observer.snapshot(); assert.ok(cold.sourceSegments > 0);
    const next = { ...input, args: { command: command + '\u0301界' }, revision: 2, sourceRevision: 2 };
    assert.equal(cards.updateDisplay(owner, next), true); const appended = observer.snapshot();
    assert.ok(appended.sourceSegments > cold.sourceSegments, 'actual suffix measurement is observable without its full source marker');
    assert.ok(appended.sourceSegmentUnits - cold.sourceSegmentUnits < command.length, 'the stable prefix was not measured');
    new Intl.Segmenter().segment('e\u0301界');
    assert.equal(cards.updateDisplay(owner, next), true);
    assert.deepEqual(observer.snapshot(), appended, 'unrelated segmentation and warm unchanged display do not count');
  } finally { observer.restore(); cards.dispose(); sources.dispose(); }
  assert.equal(sources.stats().retention.retainedBytes, 0);
});

test('palette observations distinguish actual preparation from public color reads and warm compilation', async () => {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
  const theme = themes.getThemeByName('dark'), observer = observePiPaletteWork();
  try {
    theme.getBgAnsi('toolPendingBg'); Math.hypot(1, 2, 3);
    assert.deepEqual(observer.snapshot(), { paletteSamples: 0 });
    const prepared = samplePiPalette(theme, 'truecolor'), cold = observer.snapshot();
    assert.equal(cold.paletteSamples, 1);
    for (let i = 0; i < 10; i++) compileStyleAnsi(prepared.roles.code, 'truecolor');
    assert.deepEqual(observer.snapshot(), cold);
    samplePiPalette(theme, 'truecolor');
    assert.equal(observer.snapshot().paletteSamples, 2);
  } finally { observer.restore(); }
});
