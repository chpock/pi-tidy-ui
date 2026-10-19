import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Theme } from '@earendil-works/pi-coding-agent';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { DataBudget, DataGrant, type DataGrantFactory } from '../../../src/occipital/data-budget.ts';
import type { GeometryFunding } from '../../../src/occipital/controller.ts';
import { CARD_ROLES } from '../../../src/occipital/semantic-codec.ts';
import { samplePiBindings } from '../../../src/syntax/pi-bindings.ts';
import { samplePiCardPalette } from '../../../src/syntax/pi-palette.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import { PI_RULE_BINDINGS } from '../../../src/syntax/pi-rules.ts';

function fixture() {
  let loads = 0, writes = 0, providers = 0;
  const runtime = new SyntaxRuntime({ standaloneVersion: '0.1.0-test',
    settings: { load: async () => { loads++; return { ok: true, syntaxTheme: { kind: 'pi' } }; },
      update: async () => { writes++; return { ok: true }; } },
    provider: { tryShared: async () => { providers++; return undefined; }, acquireOwned: async () => { providers++; throw Error('unexpected provider'); } } });
  const budget = new DataBudget(1_000_000), funding: GeometryFunding = { budget, grant: bytes => budget.reserve(bytes) };
  return { runtime, budget, funding, counters: () => ({ loads, writes, providers }) };
}
function counted(name = 'dark') {
  const native = getThemeByName(name)!; let fg = 0, bg = 0;
  return { colors: native.colors, owner: new WeakRef(native), getFgAnsi(role: Parameters<typeof native.getFgAnsi>[0]) { fg++; return native.getFgAnsi(role); },
    getBgAnsi(role: Parameters<typeof native.getBgAnsi>[0]) { bg++; return native.getBgAnsi(role); }, counters: () => ({ fg, bg }) };
}
type Lease = NonNullable<ReturnType<SyntaxRuntime['preparePiInput']>>;
function inspect(lease: Lease) {
  let result: unknown;
  assert.equal(lease.visit(read => { result = { bindings: read.bindings, roles: read.roles, compiledRoles: read.compiledRoles }; }), true);
  return result;
}

test('Pi input: lazy identity reads allocate nothing; simultaneous owners share after first release', async () => {
  const f = fixture(), theme = counted(); let compilations = 0;
  const freeze = Object.freeze;
  Object.freeze = ((value: any) => { if (value && typeof value.open === 'string' && typeof value.close === 'string') compilations++; return freeze(value); }) as typeof Object.freeze;
  try {
    const revision = f.runtime.palette(theme);
    for (let i = 0; i < 20; i++) { f.runtime.palette(theme); f.runtime.snapshot(); }
    assert.deepEqual(theme.counters(), { fg: 0, bg: 0 }); assert.equal(f.budget.stats().retainedBytes, 0);
    const first = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!; assert.ok(first);
    const sampled = theme.counters(), original = inspect(first), before = f.budget.stats().retainedBytes;
    const second = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!; assert.ok(second);
    assert.equal(second.paletteRevision, revision); assert.deepEqual(theme.counters(), sampled);
    assert.ok(f.budget.stats().retainedBytes > before);
    first.dispose(); first.cleanupReceipt().release();
    for (let width = 1; width <= 20; width++) {
      const next = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
      assert.deepEqual(inspect(next), original); next.dispose();
    }
    assert.deepEqual(theme.counters(), sampled); assert.deepEqual(inspect(second), original);
    assert.equal(compilations, CARD_ROLES.length, 'repeated acquire/read/width inputs never compile again');
    console.log(JSON.stringify({ piInputWarm: { sampled, compilations, repeatAcquisitions: 21, repeatCompilations: 0, repeatSamples: 0 } }));
    second.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
    assert.deepEqual(f.counters(), { loads: 0, writes: 0, providers: 0 });
  } finally { Object.freeze = freeze; await f.runtime.dispose(); }
});

test('Pi input: real SDK dark/light complete roles and bindings compile once per shared store', async () => {
  const f = fixture(); let compilations = 0;
  const freeze = Object.freeze;
  try {
    for (const name of ['dark', 'light']) {
      const native = getThemeByName(name)!, theme = counted(name);
      const bindings = samplePiBindings(native), roles = samplePiCardPalette(native);
      const compiledRoles = Object.fromEntries(CARD_ROLES.map(role => [role, compileStyleAnsi(roles[role], 'truecolor')]));
      Object.freeze = ((value: any) => { if (value && typeof value.open === 'string' && typeof value.close === 'string') compilations++; return freeze(value); }) as typeof Object.freeze;
      const before = compilations, first = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
      const second = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
      Object.freeze = freeze;
      assert.equal(compilations - before, CARD_ROLES.length);
      assert.deepEqual(inspect(first), { bindings, roles, compiledRoles });
      first.visit(read => {
        assert.deepEqual(Object.keys(read.roles), CARD_ROLES); assert.ok(Object.isFrozen(read.roles));
        second.visit(other => { assert.equal(other.bindings, read.bindings); assert.equal(other.roles, read.roles); assert.equal(other.compiledRoles, read.compiledRoles); });
      });
      first.dispose(); second.dispose();
    }
    assert.equal(f.budget.stats().retainedBytes, 0);
  } finally { Object.freeze = freeze; await f.runtime.dispose(); }
});

test('Pi input: scoped reader invalidates immediately but physical pins survive release and throw', async () => {
  for (const throws of [false, true]) {
    const f = fixture(), lease = f.runtime.preparePiInput(counted(), 'truecolor', f.funding)!;
    let escaped: Parameters<Parameters<Lease['visit']>[0]>[0] | undefined;
    const before = f.budget.stats().retainedBytes;
    const run = () => lease.visit(read => {
      escaped = read; assert.ok(read.isValid); assert.equal(Object.keys(read.roles).length, 26);
      const pinned = f.budget.stats().retainedBytes; assert.ok(pinned > before, 'the scoped reader is funded too');
      lease.cleanupReceipt().release(); assert.equal(lease.isValid, false); assert.equal(read.isValid, false);
      assert.equal(f.budget.stats().retainedBytes, pinned);
      assert.throws(() => read.roles, /stale/);
      if (throws) throw Error('visitor failure');
    });
    if (throws) assert.throws(run, /visitor failure/); else assert.equal(run(), false);
    assert.equal(escaped!.isValid, false); assert.throws(() => escaped!.bindings, /stale/);
    assert.equal(f.budget.stats().retainedBytes, 0); await f.runtime.dispose();
  }
});

async function collect(weak: WeakRef<object>) {
  assert.equal(typeof global.gc, 'function');
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!weak.deref()) return; }
  assert.fail('mandatory Pi input GC failed');
}
function sharedProbe() {
  const f = fixture(), theme = counted(), first = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
  const second = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
  let payload!: WeakRef<object>; first.visit(read => { payload = new WeakRef(read.roles); });
  return { f, owners: { first: first as Lease | undefined, second: second as Lease | undefined },
    first: new WeakRef(first), second: new WeakRef(second), theme: new WeakRef(theme), nativeTheme: theme.owner, colors: theme.colors, payload,
    receipts: [first.cleanupReceipt(), second.cleanupReceipt()] };
}
test('Pi input: detached receipts and weak cache do not retain first owner, theme or payload', async () => {
  const held = sharedProbe();
  await turn(); global.gc!(); assert.ok(held.payload.deref(), 'live holders keep actual sampled data');
  await collect(held.theme); await collect(held.nativeTheme);
  held.owners.first = undefined; await collect(held.first); held.receipts[0]!.release();
  assert.ok(held.payload.deref(), 'second owner survives first holder collection'); assert.ok(inspect(held.owners.second!));
  const another = held.f.runtime.preparePiInput({ colors: held.colors,
    getFgAnsi() { return assert.fail('live shared store must not resample after first holder GC'); },
    getBgAnsi() { return assert.fail('live shared store must not resample after first holder GC'); },
  }, 'truecolor', held.f.funding)!;
  assert.ok(another); another.dispose();
  held.owners.second = undefined; await collect(held.second); await collect(held.payload);
  for (const receipt of held.receipts) { receipt.release(); receipt.release(); }
  assert.equal(held.f.budget.stats().retainedBytes, 0); await held.f.runtime.dispose();
});


test('Pi input: mode and public palette replacement build once with old/new overlap, never parse or change selection', async () => {
  const f = fixture(), theme = counted(), changed = counted('light');
  try {
    f.runtime.previewTheme({ kind: 'occipital', id: 'chosen-native' });
    const selected = f.runtime.snapshot().selected, source = f.runtime.sources.stats();
    const old = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!, original = inspect(old), oldBytes = f.budget.stats().retainedBytes;
    const next = f.runtime.preparePiInput(theme, '256color', f.funding)!;
    assert.equal(next.paletteRevision, old.paletteRevision); assert.equal(next.terminalMode, '256color');
    assert.ok(f.budget.stats().retainedBytes > oldBytes, 'physical old/new data remain charged together');
    const modeSamples = theme.counters();
    const modeCopy = f.runtime.preparePiInput(theme, '256color', f.funding)!;
    assert.deepEqual(theme.counters(), modeSamples);
    next.visit(read => { for (const role of CARD_ROLES) assert.ok(!/\x1b\[(?:38|48);2;/.test(read.compiledRoles[role].open)); });
    const light = f.runtime.preparePiInput(changed, '256color', f.funding)!;
    assert.notEqual(light.paletteRevision, old.paletteRevision); const lightSamples = changed.counters();
    const lightCopy = f.runtime.preparePiInput(changed, '256color', f.funding)!; assert.deepEqual(changed.counters(), lightSamples);
    assert.deepEqual(inspect(old), original); assert.deepEqual(f.runtime.snapshot().selected, selected);
    assert.deepEqual(f.runtime.sources.stats(), source); assert.deepEqual(f.counters(), { loads: 0, writes: 0, providers: 0 });
    for (const lease of [old, next, modeCopy, light, lightCopy]) lease.dispose();
    assert.equal(f.budget.stats().retainedBytes, 0);
    console.log(JSON.stringify({ piInputModePalette: { modeSamples, lightSamples, oldNewOverlap: true, sourceChanges: 0, settingsWrites: 0, rpc: 0, finalBytes: 0 } }));
  } finally { await f.runtime.dispose(); }
});

test('Pi input: every allocation denial, throwing factory and invalid grant refunds without damaging a live candidate', async () => {
  const f = fixture(), oldTheme = counted(), old = f.runtime.preparePiInput(oldTheme, 'truecolor', f.funding)!;
  const expected = inspect(old), baseline = f.budget.stats(), foreign = new DataBudget(1_000_000);
  let denials = 0, failures = 0, grantsReturned = 0, grantsClosed = 0;
  const anchors: Lease[] = [];
  try {
    const operations = [
      (grant: DataGrantFactory) => f.runtime.preparePiInput(oldTheme, '256color', { budget: f.budget, grant }),
      (grant: DataGrantFactory) => f.runtime.preparePiInput(oldTheme, 'truecolor', { budget: f.budget, grant }),
      (grant: DataGrantFactory) => old.visit(read => assert.ok(read.isValid), grant),
    ];
    for (const operation of operations) {
      let count = 0;
      const result = operation(bytes => { count++; return f.budget.reserve(bytes); });
      if (result && typeof result === 'object') result.dispose();
      // Restore the warm shared candidate after a successful replacement trial.
      const warm = f.runtime.preparePiInput(oldTheme, 'truecolor', f.funding)!; anchors.push(warm);
      const before = f.budget.stats();
      for (const behavior of ['deny', 'throw', 'foreign', 'small'] as const) for (let target = 1; target <= count; target++) {
        let calls = 0; const grants: DataGrant[] = [], closes = new Map<DataGrant, number>(), close = DataGrant.prototype.close;
        DataGrant.prototype.close = function() { if (grants.includes(this)) closes.set(this, (closes.get(this) ?? 0) + 1); return close.call(this); };
        const grant: DataGrantFactory = bytes => {
          const hit = ++calls === target;
          if (hit && behavior === 'deny') return undefined;
          if (hit && behavior === 'throw') throw Error('funding failure');
          const value = hit && behavior === 'foreign' ? foreign.reserve(bytes + 9) : f.budget.reserve(hit && behavior === 'small' ? bytes - 1 : bytes + 9);
          assert.ok(value); grants.push(value); return value;
        };
        try {
          if (behavior === 'deny') { assert.ok(!operation(grant)); denials++; }
          else { assert.throws(() => operation(grant), behavior === 'throw' ? /funding failure/ : behavior === 'foreign' ? /foreign.*grant/ : /unfunded/); failures++; }
          for (const value of grants) { assert.equal(closes.get(value), 1); assert.throws(() => value.consume(1), /unfunded/); }
          grantsReturned += grants.length; grantsClosed += closes.size;
        } finally { DataGrant.prototype.close = close; }
        assert.deepEqual(f.budget.stats(), before); assert.equal(foreign.stats().retainedBytes, 0); assert.equal(foreign.stats().outstandingPeakBytes, 0);
        assert.deepEqual(inspect(old), expected);
      }
    }
    for (const anchor of anchors) anchor.dispose();
    assert.deepEqual(f.budget.stats(), baseline);
  } finally { for (const anchor of anchors) anchor.dispose(); old.dispose(); await f.runtime.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ piInputFunding: { denials, failures, grantsReturned, grantsClosed, finalBytes: 0 } }));
});

test('Pi input: sampler failures refund all scratch and preserve the last useful shared store', async () => {
  const f = fixture(), theme = counted(), old = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
  const before = f.budget.stats(), expected = inspect(old), sampled = theme.counters();
  try {
    for (const point of ['binding', 'palette', 'background'] as const) {
      const next = counted('light'); let fg = 0;
      assert.throws(() => f.runtime.preparePiInput({ colors: next.colors,
        getFgAnsi(role) { if (++fg === (point === 'binding' ? 1 : PI_RULE_BINDINGS.length + 1) && point !== 'background') throw Error('sample failure'); return next.getFgAnsi(role); },
        getBgAnsi(role) { if (point === 'background') throw Error('sample failure'); return next.getBgAnsi(role); },
      }, 'truecolor', f.funding), /sample failure/);
      assert.deepEqual(f.budget.stats(), before); assert.deepEqual(inspect(old), expected);
    }
    // A failed revision never revokes the independent live old lease. Returning
    // to its identity after palette changes is a new revision, not source proof.
    assert.deepEqual(theme.counters(), sampled);
  } finally { old.dispose(); await f.runtime.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
});

test('Pi input: reentrant funding release pins shared data and refuses resurrection, including throws', async () => {
  let witnesses = 0;
  for (const operation of ['acquire', 'visit'] as const) for (const throws of [false, true]) {
    const f = fixture(), theme = counted(), lease = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
    const sampled = theme.counters(), before = f.budget.stats().retainedBytes;
    const extra = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
    const handleBytes = f.budget.stats().retainedBytes - before; extra.dispose();
    const grant: DataGrantFactory = bytes => {
      lease.cleanupReceipt().release(); assert.equal(lease.isValid, false);
      assert.equal(f.budget.stats().retainedBytes, operation === 'acquire' ? before - handleBytes : before,
        'physical store stays pinned; acquire does not borrow the old lease header');
      assert.equal(f.budget.reserve(f.budget.limit), undefined);
      if (throws) throw Error('reentrant funding throw');
      return f.budget.reserve(bytes);
    };
    const run = () => operation === 'acquire' ? f.runtime.preparePiInput(theme, 'truecolor', { budget: f.budget, grant })
      : lease.visit(() => assert.fail('invalidated reader must not run'), grant);
    if (throws) assert.throws(run, /reentrant funding throw/); else assert.ok(!run());
    assert.deepEqual(theme.counters(), sampled, 'a denied hit must never retry sampling');
    assert.equal(f.budget.stats().retainedBytes, 0); assert.equal(f.budget.stats().outstandingPeakBytes, 0);
    await f.runtime.dispose(); witnesses++;
  }
  console.log(JSON.stringify({ piInputFundingPins: { witnesses, finalBytes: 0 } }));
});

function detachedOwnerProbe() {
  const f = fixture(), theme = counted(), controller = f.runtime.sources;
  const root = { funding: controller.geometryFunding()! }, callback: DataGrantFactory = bytes => root.funding.grant(bytes);
  const lease = f.runtime.preparePiInput(theme, 'truecolor', { budget: root.funding.budget, grant: callback })!;
  let escaped: Parameters<Parameters<Lease['visit']>[0]>[0] | undefined, payload!: WeakRef<object>;
  lease.visit(read => { escaped = read; payload = new WeakRef(read.compiledRoles); });
  return { lease, receipt: lease.cleanupReceipt(), budget: root.funding.budget, escaped: escaped!, payload,
    runtime: new WeakRef(f.runtime), controller: new WeakRef(controller), theme: new WeakRef(theme), nativeTheme: theme.owner, root: new WeakRef(root), callback: new WeakRef(callback) };
}
test('Pi input: active shared store and escaped stale reader retain no runtime, controller, theme or funding owner', async () => {
  const held = detachedOwnerProbe(); await turn(); global.gc!(); assert.ok(held.payload.deref(), 'live lease positive control');
  for (const weak of [held.runtime, held.controller, held.theme, held.nativeTheme, held.root, held.callback]) await collect(weak);
  assert.ok(held.lease.isValid); assert.ok(held.payload.deref(), 'root collection does not release adopted physical data');
  assert.equal(held.budget.stats().closed, true, 'the collected controller closes further operation admission');
  assert.equal(held.lease.visit(() => assert.fail('closed root cannot fund a reader')), false);
  assert.equal(held.escaped.isValid, false); assert.throws(() => held.escaped.compiledRoles, /stale/);
  held.receipt.release(); await collect(held.payload); held.receipt.release();
  assert.equal(held.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ piInputDetachedOwnerGC: { runtime: true, controller: true, theme: true, fundingOwner: true, callback: true, compiledTable: true, finalBytes: 0 } }));
});

test('Pi input: nested leases and visitors keep physical charges until the outermost unwind', async () => {
  for (const throws of [false, true]) {
    const f = fixture(), theme = counted(), first = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
    try {
      const run = () => first.visit(read => {
        const second = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
        first.cleanupReceipt().release(); assert.equal(read.isValid, false);
        const nested = () => second.visit(other => {
          assert.ok(other.isValid); second.cleanupReceipt().release(); assert.equal(other.isValid, false);
          assert.ok(f.budget.stats().retainedBytes > 0); assert.equal(f.budget.reserve(f.budget.limit), undefined);
          if (throws) throw Error('nested visitor failure');
        });
        if (throws) assert.throws(nested, /nested visitor failure/); else assert.equal(nested(), false);
        assert.ok(f.budget.stats().retainedBytes > 0, 'outer read still physically owns data');
        if (throws) throw Error('outer visitor failure');
      });
      if (throws) assert.throws(run, /outer visitor failure/); else assert.equal(run(), false);
      assert.equal(f.budget.stats().retainedBytes, 0);
    } finally { first.dispose(); await f.runtime.dispose(); }
  }
});

test('Pi input: last explicit release permits later resampling, while runtime disposal leaves adopted leases usable', async () => {
  const f = fixture(), theme = counted();
  const first = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!; first.dispose(); const before = theme.counters();
  const second = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!; assert.ok(theme.counters().fg > before.fg);
  await f.runtime.dispose(); assert.ok(inspect(second));
  const sampled = theme.counters(); assert.equal(f.runtime.preparePiInput(theme, 'truecolor', f.funding), undefined); assert.deepEqual(theme.counters(), sampled);
  second.cleanupReceipt().release(); second.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
});


test('Pi input: actual SDK defaults/faint and decorated public bold/italic prefixes survive sampling and compilation', async () => {
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  for (const role of Object.keys(getThemeByName('dark')!.colors)) (backgrounds.has(role) ? bg : fg)[role] = '';
  const native = new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], 'truecolor', { dim: ['syntaxComment', 'muted'] });
  const f = fixture();
  try {
    const plain = f.runtime.preparePiInput(native, 'truecolor', f.funding)!;
    plain.visit(read => {
      assert.deepEqual(read.bindings[0], { ink: { kind: 'terminal-default' }, attributes: 8, attribute_mask: 15 });
      assert.deepEqual(read.roles.reminder, { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 8 });
      assert.equal(read.compiledRoles.reminder.open, '\x1b[39m\x1b[49m\x1b[22;23;24m\x1b[2m');
    });
    plain.dispose();
    const styled = f.runtime.preparePiInput({ colors: native.colors, getBgAnsi: role => native.getBgAnsi(role),
      getFgAnsi: role => native.getFgAnsi(role) + '\x1b[1;3m' }, 'truecolor', f.funding)!;
    styled.visit(read => {
      assert.equal(read.bindings[0]!.attributes, 11); assert.equal(read.roles.reminder.attributes, 11);
      assert.equal(read.compiledRoles.reminder.open, '\x1b[39m\x1b[49m\x1b[22;23;24m\x1b[1m\x1b[3m\x1b[2m');
      assert.equal(read.compiledRoles.code.open, '\x1b[39m\x1b[49m\x1b[22;23;24m\x1b[1m\x1b[3m');
    });
    styled.dispose(); assert.equal(f.budget.stats().retainedBytes, 0);
  } finally { await f.runtime.dispose(); }
});


test('Pi input: final identity-read failure and reentrant runtime disposal refund unadopted leases', async () => {
  const f = fixture(), theme = counted(), old = f.runtime.preparePiInput(theme, 'truecolor', f.funding)!;
  const before = f.budget.stats(), expected = inspect(old);
  try {
    let reads = 0;
    assert.throws(() => f.runtime.preparePiInput({ get colors() { if (++reads === 2) throw Error('identity failure'); return theme.colors; },
      getFgAnsi: role => theme.getFgAnsi(role), getBgAnsi: role => theme.getBgAnsi(role),
    }, 'truecolor', f.funding), /identity failure/);
    assert.deepEqual(f.budget.stats(), before); assert.deepEqual(inspect(old), expected);
    let revoked = false;
    const candidate = f.runtime.preparePiInput(theme, '256color', { budget: f.budget, grant(bytes) {
      if (!revoked) { revoked = true; void f.runtime.dispose(); }
      return f.budget.reserve(bytes);
    } });
    assert.equal(candidate, undefined); assert.deepEqual(f.budget.stats(), before); assert.deepEqual(inspect(old), expected);
  } finally { old.dispose(); await f.runtime.dispose(); }
  assert.equal(f.budget.stats().retainedBytes, 0);
});
