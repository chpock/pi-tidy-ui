import '../../fixtures/test-guard.mjs';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters as plain } from 'node:util';
import { Container, Text } from '@earendil-works/pi-tui';
import { createEditToolDefinition, highlightCode } from '@earendil-works/pi-coding-agent';
import { SourceExecution } from '../../../src/highlighting/source-execution.ts';
import { installTidyUi } from '../../../src/index.ts';
import { CardSources } from '../../../src/syntax/cards.ts';
import { DataCharge } from '../../../src/resources/data-budget.ts';
import { toolCards } from '../../../src/tool-adapters/registry.ts';
import { resolvePublicFileToolDefinition } from '../../fixtures/sdk-contract-support.ts';
const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(dist, 'modes/interactive/components/tool-execution.js')).href);
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requestRender() {} }
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function reviewFixture(t: TestContext) {
  const ui = new UI(), snapshot = { enabled: false, selected: { kind: 'pi', variant: 'dark' } as const, standaloneVersion: 'test',
    provider: { availability: 'disabled' as const, reason: 'disabled' as const, generation: 0, initialShared: false } };
  let adapter: ReturnType<typeof installTidyUi>, classifications = 0, depth = 0, preparations = 0, sequence = 0;
  const sources = new SourceExecution({ snapshot: () => snapshot.provider, isReady: () => false,
    recover: async () => assert.fail('disabled provider must not be acquired'),
    workerUnavailable: async () => assert.fail('disabled provider has no worker'),
    exhaustedRoute: async () => assert.fail('disabled provider has no route'),
    classificationAccepted: () => false, request: () => { throw new Error('disabled provider must stay unused'); } },
    { onChange: (keys, groups) => adapter?.syntaxSourceChanged(keys, groups) });
  sources.setEnabled(false);
  const update = CardSources.prototype.updateDisplay;
  t.mock.method(CardSources.prototype, 'updateDisplay', function(this: CardSources<object>, ...args: Parameters<typeof update>) {
    assert.equal(depth, 0, 'display preparation never occurs in render or passive mouse handling'); preparations++;
    return update.apply(this, args);
  });
  adapter = installTidyUi(ui, () => themes.theme, { syntax: { client: { cardSource: sources, sourceWork: sources, pi: sources.pi, sourcePump: sources, sourceStatistics: sources, snapshot: () => snapshot }, palette: () => 1,
    classify: (text, info) => { assert.equal(depth, 0); classifications++; return highlightCode(text, info.language); } } });
  const tool = (name: string, args: Record<string, unknown>, definition?: unknown) => {
    const resolvedDefinition = resolvePublicFileToolDefinition(name, definition, '/tmp');
    const node = new ToolExecutionComponent(name, `review-${++sequence}`, args, undefined, resolvedDefinition, ui, '/tmp');
    ui.addChild(node); return node;
  };
  t.after(() => { adapter.restore(); sources.dispose(); });
  return { ui, sources, adapter, tool, counts: () => [preparations, classifications],
    render(node: InstanceType<typeof ToolExecutionComponent>, width = 60) { depth++; try { return node.render(width); } finally { depth--; } },
    mouse(node: InstanceType<typeof ToolExecutionComponent>, event: Record<string, unknown>) { if (event.type === 'click') return node.handleMouse(event); depth++; try { return node.handleMouse(event); } finally { depth--; } } };
}
const textRows = (rows: string[]) => rows.map(plain).join('\n');
const move = { type: 'move', button: 'none', width: 60, height: 12, x: 2, y: 2, screenX: 2, screenY: 2 };

test('a supported live write shares observed call facts across warm render, spacing and input', async t => {
  const f = reviewFixture(t);
  let pathReads = 0, argsReads = 0, nativeContextReads = 0, categoryLookups = 0;
  const lookup = toolCards.get.bind(toolCards);
  t.mock.method(toolCards, 'get', (name: string) => {
    if (name === 'write') categoryLookups++;
    return lookup(name);
  });
  const args = { get path() { pathReads++; return 'observed.ts'; }, content: 'SAVED_BODY' };
  const write = f.tool('write', args), next = f.tool('ordinary', { value: 'NEXT_TOOL' });
  write.updateResult({ content: [] }, false);
  assert.match(textRows(f.render(write)), /SAVED_BODY/);
  await tick();
  const descriptor = Object.getOwnPropertyDescriptor(write, 'args')!;
  assert.ok(descriptor && 'value' in descriptor);
  Object.defineProperty(write, 'args', { configurable: true, get() { argsReads++; return descriptor.value; } });
  t.after(() => { Object.defineProperty(write, 'args', descriptor); });
  const nativeContext = write.getRenderContext;
  t.mock.method(write, 'getRenderContext', function(this: typeof write, ...contextArgs: Parameters<typeof nativeContext>) {
    const before = argsReads;
    try { return nativeContext.apply(this, contextArgs); }
    finally { nativeContextReads += argsReads - before; }
  });
  assert.ok(categoryLookups > 0, 'cold setup resolves the write producer');
  pathReads = 0;
  categoryLookups = 0;
  for (const width of [60, 60, 50, 50]) {
    assert.match(textRows(f.render(write, width)), /SAVED_BODY/);
    assert.match(textRows(f.render(next, width)), /NEXT_TOOL/);
    f.mouse(write, { ...move, width });
  }
  assert.deepEqual({ argsReads: argsReads - nativeContextReads, pathReads, categoryLookups }, { argsReads: 0, pathReads: 0, categoryLookups: 0 },
    'warm presentation consumers reuse observations and producer selection; borrowing the native renderer state can still read host arguments');
  write.setExpanded(true);
  write.setExpanded(false);
  assert.equal(categoryLookups, 0, 'changes to view alone do not recompute the selected producer');
});

test('completed writes retain their validated class across views and reject a stale class after a hidden diff change', async t => {
  const f = reviewFixture(t), write = f.tool('write', { path: 'change-class.ts', content: '' });
  const additions = '@@ -0,0 +1,12 @@\n' + Array.from({ length: 12 }, (_, i) => `+SAVED_ROW_${i}\n`).join('');
  const details = { patch: additions };
  write.updateResult({ content: [], details }, false);
  const view = () => textRows(f.render(write));
  assert.match(view(), /← Created change-class\.ts/u, 'the first prepared preview shows the exact class without expanding');
  assert.doesNotMatch(view(), /SAVED_ROW_11/u);
  write.setExpanded(true);
  assert.match(view(), /← Created change-class\.ts/u);
  assert.match(view(), /SAVED_ROW_11/u);
  write.setExpanded(false);
  assert.match(view(), /← Created change-class\.ts/u, 'the known class survives release of the full view');
  assert.doesNotMatch(view(), /SAVED_ROW_11/u);
  details.patch += '@@ -3 +15,0 @@\n-REMOVED_SUFFIX\n';
  write.invalidate();
  assert.match(view(), /← Replaced change-class\.ts/u, 'a same-object hidden change updates the exact heading without expanding');
  assert.doesNotMatch(view(), /REMOVED_SUFFIX/u);
  write.setExpanded(true);
  assert.match(view(), /← Replaced change-class\.ts/u);
  assert.match(view(), /REMOVED_SUFFIX/u);
  write.setExpanded(false);
  assert.match(view(), /← Replaced change-class\.ts/u);
  await tick();
  const warm = f.counts();
  write.invalidate();
  assert.match(view(), /← Replaced change-class\.ts/u);
  await tick();
  assert.deepEqual(f.counts(), warm, 'an unchanged invalidate does not recalculate the class or rebuild the preview');
  details.patch += '@@ -1 +1,2 @@\n-OLD\n+ONE_MISSING\n';
  write.invalidate();
  assert.match(view(), /← Write change-class\.ts/u, 'an earlier removal does not certify a malformed hidden hunk');
  assert.doesNotMatch(view(), /ONE_MISSING/u);
});
test('AFT file observations refresh same-object path and diff format independently', t => {
  const f = reviewFixture(t), args = { path: 'before.ts', content: '' }, details = { diff: '+1 NUMBERED_SOURCE' };
  const node = f.tool('write', args);
  node.updateResult({ content: [], details }, false);
  node.setExpanded(true);
  const view = () => textRows(f.render(node));
  assert.match(view(), /← Created before\.ts/u);
  assert.match(view(), /NUMBERED_SOURCE/u);
  args.path = 'after.ts'; node.invalidate();
  assert.match(view(), /← Created after\.ts/u);
  assert.doesNotMatch(view(), /before\.ts/u);
  details.diff = '@@ -1 +1 @@\n-ORIGINAL_SOURCE\n+UNIFIED_SOURCE\n'; node.invalidate();
  assert.match(view(), /← Replaced after\.ts/u);
  assert.match(view(), /UNIFIED_SOURCE/u);
  assert.doesNotMatch(view(), /NUMBERED_SOURCE/u);
  details.diff = '+1 NUMBERED_AGAIN'; node.invalidate();
  assert.match(view(), /← Created after\.ts/u);
  assert.match(view(), /NUMBERED_AGAIN/u);
  assert.doesNotMatch(view(), /UNIFIED_SOURCE/u);
});

test('a reentrant result update supersedes a file class validated before measurement', t => {
  const f = reviewFixture(t), node = f.tool('write', { path: 'reentered.ts', content: '' });
  const funding = f.sources.geometryFunding.bind(f.sources);
  let grants = 0;
  t.mock.method(f.sources, 'geometryFunding', (...args: Parameters<typeof funding>) => {
    const current = funding(...args);
    return current && { ...current, grant: (bytes: number) => {
      if (++grants !== 2) return current.grant(bytes);
      node.updateResult({ content: [], details: { patch: '@@ -1 +1 @@\n-FIRST_CLASS\n+LATEST_CLASS\n' } }, false);
      return undefined;
    } };
  });
  node.updateResult({ content: [], details: { patch: '@@ -0,0 +1 @@\n+FIRST_CLASS\n' } }, false);
  assert.ok(grants > 2, 'the new result was admitted inside the old measurement');
  assert.match(textRows(f.render(node)), /← Replaced reentered\.ts/u);
  node.setExpanded(false);
  const preview = textRows(f.render(node));
  assert.match(preview, /← Replaced reentered\.ts/u);
  assert.match(preview, /LATEST_CLASS/u);
});

test('a validated file class survives a later measurement refusal', t => {
  const f = reviewFixture(t), node = f.tool('write', { path: 'measured.ts', content: '' });
  const funding = f.sources.geometryFunding.bind(f.sources);
  let grants = 0;
  const denial = t.mock.method(f.sources, 'geometryFunding', (...args: Parameters<typeof funding>) => {
    const current = funding(...args);
    return current && { ...current, grant: (bytes: number) => ++grants === 1 ? current.grant(bytes) : undefined };
  });
  node.updateResult({ content: [], details: { patch: '@@ -0,0 +1 @@\n+VALID_SOURCE\n' } }, false);
  assert.ok(grants > 1, 'the descriptor was admitted before a measurement grant was refused');
  const refused = textRows(f.render(node));
  assert.match(refused, /← Created measured\.ts/u, 'successful validation does not depend on measurement');
  assert.doesNotMatch(refused, /VALID_SOURCE/u);
  denial.mock.restore();
  node.setExpanded(true);
  node.setExpanded(false);
  const preview = textRows(f.render(node));
  assert.match(preview, /← Created measured\.ts/u);
  assert.match(preview, /VALID_SOURCE/u);
});

test('replacing a call identity on the same native owner retires the old file facts', t => {
  const f = reviewFixture(t), node = f.tool('write', { path: 'new-call.ts', content: '' });
  const heads: string[] = [];
  const update = CardSources.prototype.updateDisplay;
  t.mock.method(CardSources.prototype, 'updateDisplay', function(this: CardSources<object>, owner, input, report) {
    return update.call(this, owner, input, report && (value => {
      heads.push(input.reader.call.id);
      report(value);
    }));
  } as typeof update);
  node.updateResult({ content: [], details: { patch: '@@ -0,0 +1 @@\n+ONE\n' } }, false);
  node.setExpanded(true);
  assert.match(textRows(f.render(node)), /← Created new-call\.ts/u);
  node.setExpanded(false);
  const before = heads.length;
  Object.defineProperty(node, 'toolCallId', { value: 'new-id' });
  node.setExpanded(false);
  assert.match(textRows(f.render(node)), /← Created new-call\.ts/u);
  assert.deepEqual(heads.slice(before), ['new-id'], 'only the new call can publish preparation, even with the same argument/result objects');
});

test('prepared host: syntax-less SDK first frame consumes common display prepared before rendering', () => {
  const ui = new UI();
  const tool = new ToolExecutionComponent('bash', 'prepared-first', { command: 'first\n\t界 é' }, undefined, undefined, ui, '/tmp');
  ui.addChild(tool);
  const update = CardSources.prototype.updateDisplay;
  let depth = 0, preparations = 0;
  CardSources.prototype.updateDisplay = function(...args) { assert.equal(depth, 0); preparations++; return update.apply(this, args); };
  const adapter = installTidyUi(ui, () => themes.theme);
  try {
    assert.equal(adapter.active, true, adapter.reason);
    assert.equal(preparations, 1, 'initial tree attachment prepares the common display');
    depth++;
    const rows = tool.render(60).map(plain).join('\n');
    depth--;
    assert.match(rows, /first/); assert.match(rows, /界 é/);
    assert.equal(preparations, 1);
  } finally { adapter.restore(); CardSources.prototype.updateDisplay = update; }
});


test('review F1: actual SDK funding refusal shows current native text and same callback recovers accepted display', async t => {
  const f = reviewFixture(t), tool = f.tool('bash', { command: 'ACCEPTED_A' });
  assert.match(textRows(f.render(tool)), /ACCEPTED_A/); await tick();
  const useful = CardSources.prototype.useful; let demands = 0;
  t.mock.method(CardSources.prototype, 'useful', function(this: CardSources<object>, ...args: Parameters<typeof useful>) { demands++; return useful.apply(this, args); });
  const budget = f.sources.geometryFunding()!.budget, stats = budget.stats();
  const bytes = stats.limit - stats.retainedBytes - stats.outstandingPeakBytes;
  const grant = budget.reserve(bytes)!; assert.ok(grant); const held = grant.consume(bytes); grant.close();
  try {
    tool.updateArgs({ command: 'CURRENT_B' });
    const before = f.counts();
    for (let frame = 0; frame < 3; frame++) {
      const rows = textRows(f.render(tool)); assert.match(rows, /CURRENT_B/); assert.doesNotMatch(rows, /ACCEPTED_A/);
    }
    assert.deepEqual(f.counts(), before, 'render does not retry refused display'); assert.equal(demands, 0, 'unapplied revision cannot authorize useful work');
  } finally { held.release(); }
  assert.match(textRows(f.render(tool)), /CURRENT_B/, 'releasing pressure alone cannot revive old accepted A');
  tool.updateArgs(tool.args);
  const recovered = textRows(f.render(tool)); assert.match(recovered, /\$ CURRENT_B/); assert.doesNotMatch(recovered, /ACCEPTED_A/);
  assert.equal(f.adapter.active, true); assert.ok(demands > 0);
  await tick(); const warm = f.counts(); f.render(tool); tool.invalidate(); f.render(tool);
  assert.deepEqual(f.counts(), warm, 'accepted identical update/invalidate is a no-op');
});

test('review F2: actual SDK invalidate observes reused Bash source and service without render preparation', async t => {
  const f = reviewFixture(t), args = { command: 'SOURCE_BEFORE' }, tool = f.tool('bash', args);
  const result = { content: [{ type: 'text', text: 'OUTPUT_BEFORE' }] };
  tool.updateResult(result, false); f.render(tool); await tick();
  args.command = 'SOURCE_AFTER'; result.content[0]!.text = 'OUTPUT_AFTER'; tool.invalidate();
  const rows = textRows(f.render(tool)); assert.match(rows, /SOURCE_AFTER/); assert.match(rows, /OUTPUT_AFTER/);
  assert.doesNotMatch(rows, /SOURCE_BEFORE|OUTPUT_BEFORE/);
  await tick(); const warm = f.counts();
  for (let i = 0; i < 4; i++) { f.ui.invalidate(); tool.invalidate(); f.render(tool, 24 + i); }
  assert.deepEqual(f.counts(), warm, 'nested/global unchanged invalidations do not prepare or classify');
});

test('review F2: actual SDK invalidate observes authoritative patch and same-object diagnostic mutations', async t => {
  const f = reviewFixture(t), tool = f.tool('edit', { path: 'review.ts' }, createEditToolDefinition('/tmp'));
  tool.setExpanded(true);
  const details = { patch: '@@ -1 +1 @@\n-OLD_SOURCE\n+FIRST_SOURCE\n', diagnostics: [{ severity: 'error', message: 'FIRST_DIAGNOSTIC' }] };
  const result = { content: [], details }; tool.updateResult(result, false); f.render(tool); await tick();
  details.patch = '@@ -1 +1 @@\n-OLD_SOURCE\n+REPLACED_SOURCE\n'; details.diagnostics[0]!.message = 'REPLACED_DIAGNOSTIC'; tool.invalidate();
  const rows = textRows(f.render(tool)); assert.match(rows, /REPLACED_SOURCE/); assert.match(rows, /REPLACED_DIAGNOSTIC/);
  assert.doesNotMatch(rows, /FIRST_SOURCE|FIRST_DIAGNOSTIC/);
  await tick(); const warm = f.counts(); tool.invalidate(); f.render(tool);
  await tick(); assert.deepEqual(f.counts(), warm);
});

test('review F2: actual SDK preview refreshes same-object patch on invalidate and stays warm when unchanged', async t => {
  const f = reviewFixture(t), edit = f.tool('edit', { path: 'preview.ts' }, createEditToolDefinition('/tmp'));
  const details = { patch: '@@ -1 +1 @@\n-OLD_PREVIEW\n+FIRST_PREVIEW\n', diagnostics: [{ severity: 'error', message: 'HIDDEN_DIAGNOSTIC' }] };
  edit.updateResult({ content: [], details }, false);
  assert.match(textRows(f.render(edit)), /FIRST_PREVIEW/); await tick();
  const initial = f.counts();
  details.patch = '@@ -1 +1 @@\n-OLD_PREVIEW\n+REPLACED_PREVIEW\n'; edit.invalidate();
  const replaced = textRows(f.render(edit));
  assert.match(replaced, /REPLACED_PREVIEW/); assert.doesNotMatch(replaced, /FIRST_PREVIEW|HIDDEN_DIAGNOSTIC/);
  assert.match(replaced, /Diagnostics available in the full file view/);
  await tick(); const updated = f.counts(); assert.ok(updated[0]! > initial[0] && updated[1]! > initial[1]);
  edit.invalidate(); assert.equal(textRows(f.render(edit)), replaced); await tick();
  assert.deepEqual(f.counts(), updated, 'unchanged same-object invalidation does not prepare or classify the source again');
});

for (const name of ['bash', 'write']) test(`review F3: actual SDK ${name} quiesce replays accepted separator without source borrowing`, async t => {
  const f = reviewFixture(t); f.ui.addChild(new Text('PREDECESSOR', 0, 0));
  const tool = f.tool(name, name === 'bash' ? { command: 'quiesce command' } : { path: 'quiesce.ts', content: 'const replay=1;' });
  tool.updateResult({ content: [] }, false); const rows = f.render(tool); assert.equal(rows[0], ''); await tick();
  const accepted = f.render(tool), counts = f.counts(); f.adapter.quiesce();
  t.mock.method(CardSources.prototype, 'visit', () => { throw new Error('quiesce must not borrow source'); });
  assert.deepEqual(f.render(tool), accepted); assert.deepEqual(f.counts(), counts);
});

test('review F3: actual SDK prepared unknown self-shell stays native-visible during quiesce', t => {
  const f = reviewFixture(t); let visible = true;
  const component = { render: () => visible ? ['NATIVE_VISIBLE'] : [], invalidate() {} };
  const tool = f.tool('bash', { command: 'custom prepared body' }, { renderShell: 'self', renderCall: () => component });
  assert.equal(tool.getRenderShell(), 'self'); assert.match(textRows(f.render(tool)), /custom prepared body/);
  f.adapter.quiesce(); visible = false;
  t.mock.method(CardSources.prototype, 'visit', () => { throw new Error('quiesce must not borrow source'); });
  assert.deepEqual(f.render(tool), []);
});

test('review F4: actual SDK predecessor measurement follows current inline heading before edit rerender', t => {
  const f = reviewFixture(t), edit = f.tool('edit', { path: 'a.ts' }, createEditToolDefinition('/tmp'));
  edit.setExpanded(true);
  edit.updateResult({ content: [], details: { patch: '@@ -1 +1 @@\n-before\n+after\n' } }, false);
  const summary = f.tool('read', { path: 'next.ts' }); summary.updateResult({ content: [] }, false);
  f.render(edit); assert.equal(f.render(summary)[0], '');
  edit.updateResult({ content: [] }, false);
  assert.notEqual(f.render(summary)[0], '', 'current one-row inline predecessor has no separator');
  const inline = f.render(edit); assert.equal(inline.length, 1);
  assert.notEqual(f.render(summary)[0], '');
  edit.updateArgs({ path: 'long-heading-'.repeat(12) + '.ts' });
  const budget = f.sources.geometryFunding()!.budget, before = budget.stats();
  assert.equal(f.render(summary, 24)[0], '', 'current wrapped inline heading needs a separator without rendering its body');
  assert.equal(budget.stats().retainedBytes, before.retainedBytes, 'temporary heading reflow releases all charges');
  assert.ok(f.render(edit, 24).length > 1);
  edit.updateArgs({ path: 'a.ts' });
  assert.notEqual(f.render(summary, 24)[0], '', 'same-width old heading geometry cannot authorize current spacing');
});

test('review F4: actual SDK malformed replacement delegates rejected mouse rather than stale custom classification', t => {
  const native = ToolExecutionComponent.prototype.handleMouse; let delegates = 0;
  t.mock.method(ToolExecutionComponent.prototype, 'handleMouse', function(this: InstanceType<typeof ToolExecutionComponent>, ...args: unknown[]) { delegates++; return Reflect.apply(native, this, args); });
  const f = reviewFixture(t), edit = f.tool('edit', { path: 'a.ts' }, createEditToolDefinition('/tmp'));
  edit.setExpanded(true);
  edit.updateResult({ content: [], details: { patch: '@@ -1 +1 @@\n-before\n+after\n' } }, false); f.render(edit);
  edit.updateResult({ content: [], details: { patch: 'UNSUPPORTED_METADATA' } }, false);
  f.mouse(edit, move); assert.equal(delegates, 1);
});

test('review F4: unsupported preview stays owned until click, then full native input delegates', t => {
  const native = ToolExecutionComponent.prototype.handleMouse; let delegates = 0;
  t.mock.method(ToolExecutionComponent.prototype, 'handleMouse', function(this: InstanceType<typeof ToolExecutionComponent>, ...args: unknown[]) { delegates++; return Reflect.apply(native, this, args); });
  const f = reviewFixture(t), edit = f.tool('edit', { path: 'a.ts' }, createEditToolDefinition('/tmp'));
  edit.updateResult({ content: [], details: { patch: 'UNSUPPORTED_METADATA' } }, false);
  const preview = textRows(f.render(edit));
  assert.match(preview, /No saved file change details are available/);
  assert.doesNotMatch(preview, /geometry budget/);
  f.mouse(edit, move); assert.equal(delegates, 0, 'unsupported preview must not materialize native callbacks');
  const clicked = f.mouse(edit, { ...move, type: 'click', button: 'left', y: 0 }) as { handled?: boolean } | undefined;
  assert.equal(clicked?.handled, true);
  f.mouse(edit, move); assert.equal(delegates, 1, 'expanded unsupported full edit preserves native mouse handling');
});

test('review F4: actual SDK cold predecessor and rejected mouse do no raw diff normalization or preparation', t => {
  const f = reviewFixture(t), edit = f.tool('edit', { path: 'cold.ts' }, createEditToolDefinition('/tmp'));
  const patch = '@@ -1 +1 @@\r\n-COLD_BEFORE\r\n+COLD_AFTER\r\n';
  edit.updateResult({ content: [], details: { patch } }, false);
  const summary = f.tool('read', { path: 'next.ts' }); summary.updateResult({ content: [] }, false);
  const replace = String.prototype.replace; let normalizations = 0;
  t.mock.method(String.prototype, 'replace', function(this: string, pattern: unknown, replacement: unknown) {
    if (String(this) === patch && pattern instanceof RegExp && pattern.source === '\\r\\n?') normalizations++;
    return Reflect.apply(replace, this, [pattern, replacement]);
  });
  const counts = f.counts(); f.render(summary); f.mouse(edit, move); f.render(summary);
  assert.equal(normalizations, 0, 'prepared metadata is not reparsed at render/rejected-input boundaries'); assert.deepEqual(f.counts(), counts);
});


test('review F1: actual SDK reentrant funded update cannot apply an older attempt over the newest source', t => {
  const f = reviewFixture(t), tool = f.tool('bash', { command: 'ORIGINAL_A' }); f.render(tool);
  const update = CardSources.prototype.updateDisplay; let owner: CardSources<object> | undefined, rejected = 0;
  t.mock.method(CardSources.prototype, 'updateDisplay', function(this: CardSources<object>, ...args: Parameters<typeof update>) {
    owner = this; const accepted = update.apply(this, args); if (!accepted) rejected++; return accepted;
  });
  const funding = f.sources.geometryFunding.bind(f.sources); let armed = true, reentered = false;
  let outerCharge: DataCharge | undefined, pinnedWhileSuspended = false;
  const descriptor = () => (Reflect.get(owner!, 'states') as WeakMap<object, { ticket?: { descriptorCharge?: DataCharge } }>).get(tool)?.ticket?.descriptorCharge;
  t.mock.method(f.sources, 'geometryFunding', (...args: Parameters<typeof funding>) => {
    const current = funding(...args); if (!current) return current;
    return { ...current, grant(bytes: number) {
      if (armed && owner) {
        armed = false; let applyingB = false;
        owner.visit(tool, display => { applyingB = display.kind === 'bash' && display.command.text === 'OUTER_B'; });
        if (applyingB) {
          reentered = true; outerCharge = descriptor();
          assert.ok(outerCharge instanceof DataCharge && outerCharge.bytes > 0);
          tool.updateArgs({ command: 'NEWEST_C' });
          assert.notEqual(descriptor() === outerCharge, true);
          outerCharge.retain().release(); pinnedWhileSuspended = true;
        } else armed = true;
      }
      return current.grant(bytes);
    } };
  });
  themes.initTheme('light', false);
  try {
    tool.updateArgs({ command: 'OUTER_B' }); assert.equal(reentered, true, 'real palette funding reentered after descriptor adoption');
    assert.equal(pinnedWhileSuspended, true, 'outer descriptor stays paid after the nested winner, without any visitor hold');
    assert.throws(() => outerCharge!.retain(), /released data charge/u, 'outer descriptor is released on unwind');
    const rows = textRows(f.render(tool)); assert.match(rows, /\$ NEWEST_C/); assert.doesNotMatch(rows, /OUTER_B|ORIGINAL_A/);
    assert.ok(rejected > 0, 'the superseded outer update unwinds with false');
    tool.invalidate(); assert.match(textRows(f.render(tool)), /\$ NEWEST_C/);
  } finally { themes.initTheme('dark', false); }
});
