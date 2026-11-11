import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { DataBudget, type GeometryFunding } from '../../../src/resources/data-budget.ts';
import { FileDetails, type FileDetailDraft, type FileDetailView } from '../../../src/presentation/file-details.ts';

type Owner = { args: object; result?: object };
const plain = (text: string, pending = true): FileDetailDraft => ({ text, omitted: false, error: !pending, pending });
function fixture(beforeGrant?: (bytes: number, budget: DataBudget) => void) {
  const budget = new DataBudget(100_000), grants: number[] = [], errors: string[] = [];
  const control = { deny: false, fundingCalls: 0 };
  const details = new FileDetails<Owner>({
    args: owner => owner.args, result: owner => owner.result,
    funding(): GeometryFunding {
      control.fundingCalls++;
      return { budget, grant(bytes) {
        grants.push(bytes); beforeGrant?.(bytes, budget);
        return control.deny ? undefined : budget.reserve(bytes);
      } };
    },
    failed: (_owner, error) => errors.push(error instanceof Error ? error.name : 'UnknownError'),
  });
  return { details, budget, grants, errors, control };
}
const owner = (): Owner => ({ args: {}, result: {} });
const zero = (budget: DataBudget) => {
  assert.equal(budget.stats().retainedBytes, 0);
  assert.equal(budget.stats().outstandingPeakBytes, 0);
};

test('file details: prepare alone reads drafts; warm borrows and width-only projection reuse measured data', () => {
  const f = fixture(), node = owner(); let drafts = 0;
  const build = () => { drafts++; return plain('A界e\u0301Z\nx\tY'); };
  f.details.prepare(node, 'full', build);
  const view = f.details.peek(node, 'full')!;
  assert.equal(view.hasText, true); assert.equal(view.denied, false); assert.equal(view.omitted, false);
  const charged = f.budget.stats().retainedBytes, grants = f.grants.length;
  assert.ok(charged > 0);
  for (let i = 0; i < 5; i++) {
    f.details.prepare(node, 'full', build);
    assert.equal(f.details.peek(node, 'full') === view, true);
  }
  assert.equal(f.grants.length, grants); assert.equal(drafts, 1);
  assert.deepEqual(f.details.rows(view, 3)?.slice(0, 2), ['A界', 'e\u0301Z']);
  assert.deepEqual(f.details.rows(view, 1)?.slice(0, 4), ['A', '�', 'e\u0301', 'Z']);
  for (const width of [1, 8, 20, 2, 80]) {
    const rows = f.details.rows(view, width)!;
    assert.ok(rows.length > 0); assert.equal(rows.some(row => row.includes('\t')), false);
    assert.equal(f.budget.stats().retainedBytes, charged);
    assert.equal(f.budget.stats().outstandingPeakBytes, 0);
  }
  assert.equal(drafts, 1);
  f.control.deny = true;
  assert.equal(f.details.rows(view, 80), undefined);
  assert.equal(f.budget.stats().retainedBytes, charged);
  assert.equal(f.budget.stats().outstandingPeakBytes, 0);
  f.control.deny = false;
  assert.ok(f.details.rows(view, 80)!.length > 0);
  f.details.drop(node); f.details.drop(node); f.details.clear(); zero(f.budget);
});

test('file details: real refresh adopts equal bounded content but visible/phase changes replace it', () => {
  const f = fixture(), node = owner(); let draft = plain('bounded'), builds = 0;
  const build = () => { builds++; return draft; };
  f.details.prepare(node, 'full', build);
  const first = f.details.peek(node, 'full')!, grants = f.grants.length;
  node.args = {}; node.result = {};
  assert.equal(f.details.peek(node, 'full'), undefined);
  f.details.prepare(node, 'full', build, true);
  assert.equal(f.details.peek(node, 'full') === first, true);
  assert.equal(f.grants.length, grants); assert.equal(builds, 2);
  draft = plain('changed'); f.details.prepare(node, 'full', build, true);
  const second = f.details.peek(node, 'full')!;
  assert.equal(second === first, false); assert.deepEqual(f.details.rows(second, 80), ['changed']);
  draft = plain('changed', false); f.details.prepare(node, 'full', build, true);
  assert.equal(f.details.peek(node, 'full') === second, false);
  draft = { ...draft, omitted: true }; f.details.prepare(node, 'full', build, true);
  assert.equal(f.details.peek(node, 'full')!.omitted, true);
  assert.equal(f.details.peek(node, 'preview'), undefined);
  f.details.clear(); zero(f.budget);
});

test('file details: complete sources count raw units before funding and materialize inside the construction grant', () => {
  const parts = [{ prefix: '1 ', text: 'A界e\u0301\r\nB' }, { prefix: '2 ', text: '\u001b[31mC\u001b[0m' }];
  let passes = 0;
  const observations: { passes: number; outstanding: number }[] = [];
  const f = fixture((_bytes, budget) => observations.push({ passes, outstanding: budget.stats().outstandingPeakBytes }));
  const node = owner(), draft: FileDetailDraft = { ...plain('', false), sources: () => { passes++; return parts; } };
  f.details.prepare(node, 'full', () => draft);
  const units = parts.reduce((sum, part, index) => sum + part.prefix.length + part.text.length + (index ? 1 : 0), 0);
  assert.equal(f.grants[0], 4096 + 8 * units + 64 + 64 * parts.length);
  assert.deepEqual(observations[0], { passes: 1, outstanding: 0 });
  assert.ok(observations.length > 1);
  assert.equal(observations[1].passes, 2); assert.equal(observations[1].outstanding, 0);
  const view = f.details.peek(node, 'full')!;
  assert.deepEqual(f.details.rows(view, 80), ['1 A界e\u0301', 'B', '2 C']);
  const before = passes;
  f.details.prepare(node, 'full', () => draft);
  assert.equal(passes, before);
  f.details.prepare(node, 'full', () => draft, true);
  assert.equal(passes, before + 2, 'saved-error refresh does not introduce a new full-source equality algorithm');
  f.details.clear(); zero(f.budget);
});

test('file details: denied results remain visible, retry preparation, and disappear on explicit drop or clear', () => {
  const f = fixture(), node = owner(); let builds = 0;
  const build = () => { builds++; return plain('retry'); };
  f.control.deny = true; f.details.prepare(node, 'full', build);
  const denied = f.details.peek(node, 'full')!;
  assert.equal(denied.denied, true); assert.equal(denied.hasText, false); zero(f.budget);
  f.details.prepare(node, 'full', build); assert.equal(builds, 2);
  f.details.drop(node); assert.equal(f.details.peek(node, 'full'), undefined);
  f.details.prepare(node, 'full', build); f.details.clear();
  assert.equal(f.details.peek(node, 'full'), undefined);
  f.control.deny = false; f.details.prepare(node, 'full', build);
  assert.equal(f.details.peek(node, 'full')!.denied, false);
  assert.deepEqual(f.details.rows(f.details.peek(node, 'full')!, 80), ['retry']);
  f.details.clear(); zero(f.budget);
});

test('file details: empty source sets need no funding and preserve empty versus unavailable rows', () => {
  const f = fixture(), node = owner();
  f.details.prepare(node, 'full', () => ({ ...plain('', false), sources: () => [] }));
  const view = f.details.peek(node, 'full')!;
  assert.equal(view.hasText, false); assert.equal(view.denied, false);
  assert.deepEqual(f.details.rows(view, 80), []);
  assert.equal(f.control.fundingCalls, 0); assert.equal(f.grants.length, 0);
  f.details.clear(); zero(f.budget);
});

for (const stage of ['construction', 'measurement'] as const) test(`file details: ${stage} faults refund staged text and geometry`, () => {
  const f = fixture(), node = owner();
  f.details.prepare(node, 'full', () => plain('previous'));
  const failure = new RangeError('injected construction failure'); let passes = 0;
  const build = (): FileDetailDraft => ({ ...plain('', false), sources: function* () {
    passes++; yield { prefix: '', text: 'candidate' };
    if (stage === 'construction' && passes === 2) throw failure;
  } });
  const Original = globalThis.Uint32Array;
  if (stage === 'measurement') globalThis.Uint32Array = new Proxy(Original, { construct() { throw failure; } });
  try { f.details.prepare(node, 'full', build, true); }
  finally { globalThis.Uint32Array = Original; }
  assert.equal(f.details.peek(node, 'full')!.denied, true);
  assert.deepEqual(f.errors, ['RangeError']); zero(f.budget);
  f.details.drop(node); f.details.clear(); zero(f.budget);
});

function abandon(details: FileDetails<Owner>) {
  const node = owner(), draft = plain('collectable detail'), build = () => draft;
  details.prepare(node, 'full', build);
  return [node, node.args, node.result!, draft, build, details.peek(node, 'full')!].map(value => new WeakRef(value));
}

test('file details: retained cleanup records keep only numeric ownership through delayed finalization', async () => {
  const Original = globalThis.FinalizationRegistry, pending: (() => void)[] = [];
  class DelayedRegistry<T> extends Original<T> {
    constructor(callback: (held: T) => void) { super(held => pending.push(() => callback(held))); }
  }
  let f: ReturnType<typeof fixture>;
  globalThis.FinalizationRegistry = DelayedRegistry;
  try { f = fixture(); } finally { globalThis.FinalizationRegistry = Original; }
  const weak = abandon(f!.details);
  for (let pass = 0; pass < 40; pass++) {
    await turn(); global.gc!(); await turn();
    if (weak.every(value => !value.deref())) break;
  }
  assert.equal(weak.every(value => !value.deref()), true, 'manager and delayed receipts retain no component, inputs, draft, producer or view');
  assert.ok(pending.length > 0); assert.ok(f!.budget.stats().retainedBytes > 0);
  f!.details.clear(); zero(f!.budget);
  for (const dispatch of pending) dispatch();
  f!.details.clear(); zero(f!.budget);
});

function consumerContract(view: FileDetailView) {
  const flags: readonly boolean[] = [view.denied, view.omitted, view.hasText];
  // @ts-expect-error A render borrow does not expose retained text.
  void view.text;
  // @ts-expect-error A render borrow does not expose numeric measurement.
  void view.measured;
  // @ts-expect-error A render borrow is not release authority.
  void view.record;
  // @ts-expect-error A render borrow cannot supply grants.
  void view.grant;
  // @ts-expect-error Input identity stays inside the owner.
  void view.args;
  // @ts-expect-error Render flags are readonly.
  view.denied = true;
  return flags;
}
void consumerContract;
