import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SavedToolResult } from '../../../src/tool-adapters/contracts.ts';
import type { CardDisplayInput } from '../../../src/cards/display-input.ts';
import type { CardSources } from '../../../src/syntax/cards.ts';
import type { CardPreparationPort } from '../../../src/presentation/card-preparation.ts';
import { ToolPresentationPolicy } from '../../../src/presentation/tool-policy.ts';
import { ToolRoutingPresenter } from '../../../src/presentation/tool-routing-presenter.ts';
import { ToolPresentationSessions } from '../../../src/presentation/tool-sessions.ts';
import { ToolProducerPresenter } from '../../../src/presentation/tool-producers.ts';
import { selectToolPresentationIntent } from '../../../src/presentation/tool-intents.ts';

type Owner = {
  name: string;
  id: string;
  args: Record<string, unknown>;
  result?: SavedToolResult;
  partial: boolean;
  expanded: boolean;
  executionStarted: boolean;
  argsComplete: boolean;
  hidden: boolean;
  attached: boolean;
  stockRead: boolean;
  stockFile: boolean;
};

function owner(name: string, args: Record<string, unknown>, changes: Partial<Owner> = {}): Owner {
  return {
    name, id: `${name}-1`, args, result: undefined, partial: false, expanded: false,
    executionStarted: false, argsComplete: true, hidden: false, attached: true,
    stockRead: false, stockFile: false, ...changes,
  };
}

function routingHarness() {
  let active = true;
  let nativeVisible = true;
  let selfShell = true;
  const visibleWidths: number[] = [];
  let argumentReads = 0;
  const compact = new Set<string>();
  const native = new Set<string>();
  const producer = new ToolProducerPresenter<Owner>({
    name: node => node.name,
    id: node => node.id,
    args: node => { argumentReads++; return node.args; },
    result: node => node.result,
    partial: node => node.partial,
    expanded: node => node.expanded,
    executionStarted: node => node.executionStarted,
    argsComplete: node => node.argsComplete,
  });
  const sessions = new ToolPresentationSessions<Owner>({
    args: node => node.args,
    result: node => node.result,
    funding: () => undefined,
    failed: () => {},
  });
  const policy = new ToolPresentationPolicy(producer, sessions, {
    active: () => active,
    name: node => node.name,
    toolCallId: node => node.id,
    expanded: node => node.expanded,
    hidden: node => node.hidden,
    attached: node => node.attached,
  }, {
    cards: new Set(['bash', 'read', 'edit', 'write']),
    compact,
    native,
  });
  const routing = new ToolRoutingPresenter(policy, {
    selfShell: () => selfShell,
    deferredFilePair: () => false,
    stockEditShell: () => false,
    visible: (_node, width) => { visibleWidths.push(width); return nativeVisible; },
    readRenderer: node => node.stockRead,
    fileRenderer: node => node.stockFile,
  });
  return {
    routing,
    policy,
    compact,
    native,
    argumentReads: () => argumentReads,
    visibleWidths,
    active(value: boolean) { active = value; },
    nativeVisible(value: boolean) { nativeVisible = value; },
    selfShell(value: boolean) { selfShell = value; },
  };
}

test('tool presentation intents preserve route priority and zero-width behavior', () => {
  assert.equal(selectToolPresentationIntent(80, true, true, true), 'file');
  assert.equal(selectToolPresentationIntent(80, false, true, true), 'bash');
  assert.equal(selectToolPresentationIntent(80, false, false, true), 'compact');
  assert.equal(selectToolPresentationIntent(80, false, false, false), 'native');
  assert.equal(selectToolPresentationIntent(0, true, false, false), 'suppressed');
  assert.equal(selectToolPresentationIntent(0, false, false, true), 'suppressed');
  assert.equal(selectToolPresentationIntent(0, false, true, false), 'bash');
});

test('non-self shell routing borrows shell identity without invoking the original renderer', () => {
  const harness = routingHarness();
  harness.selfShell(false); harness.nativeVisible(false);
  assert.equal(harness.routing.bash(owner('bash', { command: 'echo visible' }), 80), true);
  assert.equal(harness.routing.compact(owner('external', {}), 80), true);
  assert.equal(harness.routing.fileVisible(owner('write', { path: '/tmp/visible.ts', content: 'const n = 1;' }), 80), true);
  assert.deepEqual(harness.visibleWidths, [], 'an ordinary native shell needs no body visibility probe');
});

test('tool routing checks native visibility only for routes that need a host renderer', () => {
  const harness = routingHarness();
  const custom = owner('external', {});
  assert.equal(harness.routing.summaryIntent(custom, 80), 'compact');
  assert.deepEqual(harness.visibleWidths, [80]);
  assert.equal(harness.routing.summaryIntent(custom, 0), 'suppressed');
  assert.deepEqual(harness.visibleWidths, [80]);

  harness.nativeVisible(false);
  assert.equal(harness.routing.summaryIntent(custom, 80), 'suppressed');
  assert.deepEqual(harness.visibleWidths, [80, 80]);

  const stockRead = owner('read', { path: '/tmp/source.ts' }, { stockRead: true });
  harness.selfShell(false);
  assert.equal(harness.routing.summaryIntent(stockRead, 80), 'compact');
  assert.equal(harness.routing.compact(stockRead, 0), true);
  assert.equal(harness.routing.fileVisible(stockRead, 80), true);
  assert.equal(harness.routing.readSyntaxVisible(stockRead, 80, false), true);
  assert.deepEqual(harness.visibleWidths, [80, 80]);
  assert.equal(harness.routing.fileSuppressed(stockRead, 0), false);

  stockRead.expanded = true;
  assert.equal(harness.routing.fileIntent(stockRead, 0), 'suppressed');
  assert.equal(harness.routing.fileSuppressed(stockRead, 0), true);
  assert.equal(harness.routing.file(stockRead, 80), true);

  const foreignRead = owner('read', { path: '/tmp/foreign.ts' });
  harness.selfShell(true);
  assert.equal(harness.routing.fileVisible(foreignRead, 80), false);
  assert.equal(harness.routing.readSyntaxVisible(foreignRead, 80), false);
  assert.equal(harness.routing.summaryIntent(foreignRead, 80), 'suppressed');
  assert.deepEqual(harness.visibleWidths, [80, 80, 80, 80, 80]);

  const write = owner('write', { path: '/tmp/result.ts', content: 'const value = 1;' }, { stockFile: true });
  assert.equal(harness.routing.fileRenderer(write), true);
  assert.equal(harness.routing.fileSuppressed(write, 0), true);
  assert.equal(harness.routing.fileRenderer(custom), false);

  harness.active(false);
  assert.equal(harness.routing.summaryIntent(custom, 80), 'native');
  assert.equal(harness.routing.fileSuppressed(write, 0), false);
  assert.deepEqual(harness.visibleWidths, [80, 80, 80, 80, 80]);
});


test('a deferred stock read pair does not replace current self-shell render visibility', () => {
  const harness = routingHarness();
  const read = owner('read', { path: '/tmp/source.ts' }, { stockRead: true });
  harness.nativeVisible(false);
  assert.equal(harness.routing.summaryIntent(read, 80), 'suppressed');
  assert.deepEqual(harness.visibleWidths, [80]);
  assert.equal(harness.routing.fileVisible(read, 80), true, 'file projection retains its separate stock-read bypass');
  assert.equal(harness.routing.readSyntaxVisible(read, 80, false), true, 'read preparation retains its separate stock-read bypass');
  assert.deepEqual(harness.visibleWidths, [80]);
  harness.nativeVisible(true);
  assert.equal(harness.routing.summaryIntent(read, 100), 'compact');
  assert.deepEqual(harness.visibleWidths, [80, 100], 'render visibility is borrowed again at the current width');
});

test('an individual file-view decision observes the saved arguments and validates a successful path only once', () => {
  const harness = routingHarness();
  const { policy } = harness;
  let pathReads = 0;
  const args = { get path() { pathReads++; return '/tmp/current.ts'; } };
  const changes = { result: { content: [{ type: 'text', text: 'saved result' }] }, expanded: true };
  const edit = owner('edit', args, changes);
  const write = owner('write', args, changes);
  const read = owner('read', args, changes);
  const check = (label: string, decide: () => boolean | string | undefined, expected: boolean | string | undefined) => {
    const before = harness.argumentReads();
    pathReads = 0;
    assert.equal(decide(), expected, label);
    assert.deepEqual([harness.argumentReads() - before, pathReads], [1, 1], label);
  };
  check('file eligibility', () => policy.filePresentationEligible(write), true);
  check('edit preview decision', () => policy.filePreviewMode(edit), 'full');
  check('write mode', () => policy.fileMode(write), 'full');
  check('expanded read', () => policy.readPresentationMode(read), 'full');
  check('read mode', () => policy.fileMode(read), 'full');
  check('read routing', () => harness.routing.fileIntent(read, 80), 'file');
  check('edit routing at zero width', () => harness.routing.fileIntent(edit, 0), 'suppressed');
});

test('the next file-view decision uses the current result and keeps the existing native overrides', () => {
  const { policy, compact, native, routing } = routingHarness();
  const result = { content: [{ type: 'text', text: 'saved result' }] };
  const edit = owner('edit', {}, { result, partial: true });
  assert.equal(policy.filePreviewMode(edit), 'preview', 'a partial result may lack a path');
  edit.partial = false;
  assert.equal(policy.filePreviewMode(edit), undefined, 'success requires a saved path');
  edit.result = { ...result, isError: true };
  assert.equal(policy.filePreviewMode(edit), 'preview', 'errors may lack a path');
  edit.result = result;
  edit.args.path = '/tmp/current.ts';
  assert.equal(policy.filePreviewMode(edit), 'preview');
  edit.result = { content: [{ type: 'image' }] };
  assert.equal(policy.filePreviewMode(edit), undefined, 'image results stay native');
  edit.result = result;
  native.add('edit');
  assert.equal(policy.filePreviewMode(edit), undefined, 'native override still wins for edit');
  native.delete('edit');
  edit.hidden = true;
  assert.equal(policy.filePreviewMode(edit), undefined);
  edit.hidden = false;
  assert.equal(policy.filePreviewMode(edit), 'preview');

  const read = owner('read', { path: '/tmp/current.ts' }, { result });
  native.add('read');
  read.expanded = true;
  assert.equal(routing.fileIntent(read, 80), 'native');
  compact.add('read');
  assert.equal(routing.fileIntent(read, 80), 'file', 'compact override still takes precedence for read');
  read.expanded = false;
  assert.equal(routing.fileIntent(read, 80), 'native', 'collapsed read does not take the file route');
  assert.equal(policy.filePreviewMode(read), undefined, 'read is not an edit/write preview');
});

function preparationConsumerTypes(source: CardSources<Owner>, value: Owner, input: CardDisplayInput,
  missingSourceRevision: Omit<Extract<CardDisplayInput, { kind: 'file' }>, 'sourceRevision'>) {
  const port: CardPreparationPort<Owner> = source;
  port.updateDisplay(value, input);
  // @ts-expect-error A prepared request must retain its source revision.
  port.updateDisplay(value, missingSourceRevision);
  // @ts-expect-error Presentation has no physical source admission authority.
  port.observe({ key: 'source', version: 1, text: '', complete: true });
  // @ts-expect-error Per-card consumers do not dispose the shared owner.
  port.dispose();
}
void preparationConsumerTypes;
