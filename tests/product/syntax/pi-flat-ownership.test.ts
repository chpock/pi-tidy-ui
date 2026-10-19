import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataBudget } from '../../../src/occipital/data-budget.ts';
import { preparePiFlat } from '../../../src/syntax/pi-flat.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import type { ProviderSnapshot } from '../../../src/occipital/provider.ts';
const neutral: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
const provider = { snapshot(): ProviderSnapshot { return { generation: 1, availability: 'unavailable', reason: 'optional_unavailable', initialShared: false }; }, isReady: () => false, classificationAccepted: () => false, request: () => Promise.reject(new Error('unexpected RPC')) };
function prepared(budget: DataBudget, text = 'ab') {
  const result = preparePiFlat(text, consume => { consume(0, text[0] + '\x1b[31m' + text.slice(1)); return true; }, neutral, budget);
  assert.equal(result.outcome, 'ready'); if (result.outcome !== 'ready') throw Error('not ready'); return result.projection;
}

test('Pi ownership: exclusive stage moves once, rejects siblings and active visitors, emptied stages cannot dispose payload', () => {
  const budget = new DataBudget(100_000), projection = prepared(budget), sibling = projection.retain()!;
  assert.equal(projection.stage(), undefined); assert.equal(projection.isValid, true); sibling.dispose();
  projection.visitRanges(() => { assert.equal(projection.stage(), undefined); });
  projection.visitStyles(() => { assert.equal(projection.stage(), undefined); });
  const stage = projection.stage()!; assert.ok(stage); assert.equal(projection.isValid, false);
  assert.equal(stage.sourceBytes, 2); assert.equal(stage.rangeCount, 2); assert.equal(stage.styleCount, 2);
  assert.equal('retain' in stage, false); assert.equal('visitRanges' in stage, false);
  const payload = stage.consume()!; assert.ok(payload); assert.equal('retain' in payload, false);
  assert.equal(stage.consume(), undefined); stage.dispose(); projection.dispose();
  assert.equal(payload.visitRanges(() => {}), true); assert.ok(budget.stats().retainedBytes > 0);
  payload.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi ownership: denied or throwing stage header preserves original exclusive handle', () => {
  const budget = new DataBudget(100_000), projection = prepared(budget), before = budget.stats(), reserve = DataBudget.prototype.reserve;
  for (const throws of [false, true]) {
    DataBudget.prototype.reserve = function(bytes) { if (this === budget) { if (throws) throw Error('allocation'); return undefined; } return reserve.call(this, bytes); };
    try { if (throws) assert.throws(() => projection.stage(), /allocation/); else assert.equal(projection.stage(), undefined); }
    finally { DataBudget.prototype.reserve = reserve; }
    assert.equal(projection.isValid, true); assert.deepEqual(budget.stats(), before);
  }
  projection.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi ownership: tickets pin snapshot through removal without granting work authority and consume rejected candidates', () => {
  const source = new SourceController(provider); source.capturePiSource('a', 1, 'ab');
  const before = source.workStatus('a'), capture = source.borrowPiSource('a')!, ticket = source.piPreparation('a', capture.generation, 1, 1)!;
  assert.ok(ticket); assert.deepEqual(source.workStatus('a'), before);
  const stage = prepared(ticket.budget).stage()!; source.removePiSource('a');
  assert.ok(source.stats().retention.retainedBytes > 0);
  assert.equal(source.adoptPiFlat(ticket, 'ab', stage), false); assert.equal(stage.consume(), undefined);
  ticket.release(); assert.equal(source.stats().retention.retainedBytes, 0); source.dispose();
});

test('Pi ownership: root/budget/version guards, equal alias, same-palette replacement and refusal preserve old ready', () => {
  const source = new SourceController(provider), foreign = new SourceController(provider); source.capturePiSource('a', 1, 'ab'); foreign.capturePiSource('a', 1, 'ab');
  const capture = source.borrowPiSource('a')!, ticket = source.piPreparation('a', capture.generation, 1, 1)!;
  assert.equal(foreign.adoptPiFlat(ticket, 'ab', prepared(ticket.budget).stage()!), false);
  const wrong = new DataBudget(100_000); assert.equal(source.adoptPiFlat(ticket, 'ab', prepared(wrong).stage()!), false); assert.equal(wrong.stats().retainedBytes, 0);
  assert.equal(source.adoptPiFlat(ticket, 'ab', prepared(ticket.budget).stage()!), true);
  const reader = source.piProjection('a', 1, 1)!; assert.ok(reader);
  const stale = source.piPreparation('a', capture.generation, 1, 2)!;
  source.capturePiSource('a', 2, 'ab'); assert.equal(source.piProjection('a', 2, 1)!.revision, reader.revision);
  assert.equal(reader.visitRanges(() => {}), false);
  assert.equal(source.adoptPiFlat(stale, 'ab', prepared(ticket.budget).stage()!), false); stale.release();
  const next = source.piPreparation('a', capture.generation, 2, 2)!;
  assert.equal(source.reservePiData(next, ticket.budget.limit), undefined); assert.equal(source.piRefusal('a', 2, 2), true);
  assert.equal(source.piPreparation('a', capture.generation, 2, 2), undefined);
  assert.ok(source.piProjection('a', 2, 1)); assert.equal(source.piFailure('a', 2, 2), undefined);
  next.release(); ticket.release(); source.dispose(); foreign.dispose(); assert.equal(ticket.budget.stats().retainedBytes, 0);
});


test('Pi ownership: old ready plus candidate plus metadata peak refuses atomically and every warm attempt stays cached', () => {
  const source = new SourceController(provider, { retention: { maxBytes: 8000 } }); source.capturePiSource('a', 1, 'ab');
  const generation = source.borrowPiSource('a')!.generation, old = source.piPreparation('a', generation, 1, 1)!;
  assert.ok(source.adoptPiFlat(old, 'ab', prepared(old.budget).stage()!)); old.release();
  const reader = source.piProjection('a', 1, 1)!, ticket = source.piPreparation('a', generation, 1, 2)!;
  const candidate = prepared(ticket.budget), stage = candidate.stage()!, pins = [];
  // Actual externally held preparation headers, not string-padding or artificial credit.
  while (ticket.budget.limit - ticket.budget.stats().retainedBytes >= 128) {
    const pin = source.piPreparation('a', generation, 1, 2); assert.ok(pin); pins.push(pin);
  }
  const live = ticket.budget.stats(); assert.ok(reader.visitRanges(() => {})); assert.ok(stage.accountedBytes > 0);
  assert.equal(source.adoptPiFlat(ticket, 'ab', stage), false); assert.equal(stage.consume(), undefined);
  assert.ok(reader.visitRanges(() => {})); assert.equal(source.piRefusal('a', 1, 2), true);
  const refused = source.stats();
  for (let i = 0; i < 30; i++) assert.equal(source.piPreparation('a', generation, 1, 2), undefined);
  assert.deepEqual(source.stats(), refused); assert.equal(source.piFailure('a', 1, 2), undefined);
  pins.forEach(pin => pin.release()); ticket.release(); source.dispose();
  assert.equal(ticket.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ piAdoptionPeak: { live, candidateBytes: stage.accountedBytes, heldTickets: pins.length, final: ticket.budget.stats() } }));
});

test('Pi ownership: preparation removal/replacement/throw keeps exact snapshot data physically charged through conversion unwind', () => {
  for (const throwing of [false, true]) {
    const source = new SourceController(provider); source.capturePiSource('a', 1, 'ab');
    const generation = source.borrowPiSource('a')!.generation, ticket = source.piPreparation('a', generation, 1, 1)!;
    const work = source.workStatus('a'), stop = new Error('classifier callback');
    const convert = () => preparePiFlat(ticket.text!, consume => {
      source.removePiSource('a'); source.capturePiSource('a', 1, 'replacement'); source.removePiSource('a');
      assert.ok(ticket.budget.stats().retainedBytes >= 128 + 32 + 4);
      assert.equal(ticket.budget.reserve(ticket.budget.limit), undefined);
      if (throwing) throw stop; consume(0, 'ab'); return true;
    }, neutral, ticket.budget, bytes => source.reservePiData(ticket, bytes));
    if (throwing) assert.throws(convert, error => error === stop);
    else assert.equal(convert().outcome, 'refused');
    assert.deepEqual(source.workStatus('a'), work);
    assert.equal(ticket.budget.stats().retainedBytes, 128 + 32 + 4);
    ticket.release(); assert.equal(ticket.budget.stats().retainedBytes, 0); source.dispose();
  }
});

test('Pi ownership: same-palette replacement invalidates ranges/styles immediately and exceptions retain borrowed data until unwind', () => {
  for (const styles of [false, true]) for (const throwing of [false, true]) {
    const source = new SourceController(provider); source.capturePiSource('a', 1, 'ab');
    const generation = source.borrowPiSource('a')!.generation, ticket = source.piPreparation('a', generation, 1, 1)!;
    assert.ok(source.adoptPiFlat(ticket, 'ab', prepared(ticket.budget).stage()!)); ticket.release();
    const reader = source.piProjection('a', 1, 1)!, stop = new Error('visitor'); let calls = 0;
    const read = () => {
      const consume = () => {
        calls++; const next = source.piPreparation('a', generation, 1, 1)!;
        assert.ok(source.adoptPiFlat(next, 'ab', prepared(next.budget).stage()!)); next.release();
        assert.notEqual(source.piProjection('a', 1, 1)!.revision, reader.revision);
        source.removePiSource('a'); assert.ok(ticket.budget.stats().retainedBytes > 0);
        assert.equal(ticket.budget.reserve(ticket.budget.limit), undefined);
        if (throwing) throw stop;
      };
      return styles ? reader.visitStyles(consume) : reader.visitRanges(consume);
    };
    if (throwing) assert.throws(read, error => error === stop); else assert.equal(read(), false);
    assert.equal(calls, 1); assert.equal(ticket.budget.stats().retainedBytes, 0); source.dispose();
  }
});

function detachedOwner() {
  const source = new SourceController(provider); source.capturePiSource('a', 1, 'ab');
  const ticket = source.piPreparation('a', source.borrowPiSource('a')!.generation, 1, 1)!;
  const projection = prepared(ticket.budget), stage = projection.stage()!;
  assert.ok(source.adoptPiFlat(ticket, 'ab', stage));
  return { owner: new WeakRef(source), root: new WeakRef(Reflect.get(source, 'pool') as object), ticket, reader: source.piProjection('a', 1, 1)!, stage, projection };
}
test('Pi ownership: held detached ticket, weak reader, emptied stage and invalid original do not pin controller/root', async () => {
  const held = detachedOwner();
  for (let i = 0; i < 60; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc!(); await new Promise<void>(resolve => setImmediate(resolve)); if (!held.owner.deref() && !held.root.deref()) break; }
  assert.equal(held.owner.deref(), undefined); assert.equal(held.root.deref(), undefined);
  assert.equal(held.reader.visitRanges(() => assert.fail('retired')), false);
  assert.equal(held.stage.consume(), undefined); held.stage.dispose(); held.projection.dispose();
  assert.equal(held.ticket.budget.stats().retainedBytes, 128 + 32 + 4);
  held.ticket.release(); assert.equal(held.ticket.budget.stats().retainedBytes, 0);
  console.log(JSON.stringify({ piOwnershipGC: { ownerCollected: !held.owner.deref(), rootCollected: !held.root.deref(), finalBytes: held.ticket.budget.stats().retainedBytes } }));
});


test('Pi ownership: root identity is stronger than shared budget and retired roots revoke still-pinned tickets', () => {
  const budget = new DataBudget(100_000), first = new SemanticRetentionPool({ budget }), second = new SemanticRetentionPool({ budget });
  const a = first.admit('a', 1, 'ab').generation!, b = second.admit('a', 1, 'ab').generation!;
  assert.equal(a, b); const ticket = first.piPreparation(a, 1, 1).ticket!;
  const stage = prepared(budget).stage()!;
  assert.equal(second.adoptPiFlat(ticket, 'ab', stage).accepted, false); assert.equal(stage.consume(), undefined);
  first.dispose(); assert.equal(first.acceptsPiPreparation(ticket), false); assert.ok(budget.stats().retainedBytes > 0);
  second.dispose(); ticket.release(); assert.equal(budget.stats().retainedBytes, 0);
});

test('Pi ownership: allocation exceptions dispose consumed candidate without replacing old ready or leaking grants', () => {
  const source = new SourceController(provider); source.capturePiSource('a', 1, 'ab');
  const generation = source.borrowPiSource('a')!.generation, ticket = source.piPreparation('a', generation, 1, 1)!;
  assert.ok(source.adoptPiFlat(ticket, 'ab', prepared(ticket.budget).stage()!));
  const old = source.piProjection('a', 1, 1)!, before = ticket.budget.stats(), stage = prepared(ticket.budget).stage()!;
  const reserve = DataBudget.prototype.reserve;
  DataBudget.prototype.reserve = function(bytes) { if (this === ticket.budget) throw Error('adoption allocation'); return reserve.call(this, bytes); };
  try { assert.throws(() => source.adoptPiFlat(ticket, 'ab', stage), /adoption allocation/); }
  finally { DataBudget.prototype.reserve = reserve; }
  assert.equal(stage.consume(), undefined); assert.deepEqual(ticket.budget.stats(), before); assert.ok(old.visitStyles(() => {}));
  ticket.release(); source.dispose(); assert.equal(ticket.budget.stats().retainedBytes, 0);
});

test('Pi ownership: reservation processes every Pi pressure receipt before issuing actual additional credit', () => {
  const source = new SourceController(provider, { retention: { maxBytes: 10000 } });
  source.capturePiSource('target', 1, 'ab'); source.capturePiSource('peer1', 1, 'p'.repeat(1000)); source.capturePiSource('peer2', 1, 'q'.repeat(1000));
  const generation = source.borrowPiSource('target')!.generation, ticket = source.piPreparation('target', generation, 1, 1)!;
  assert.equal(source.stats().retention.entries, 3); const work = source.workStatus('target');
  const grant = source.reservePiData(ticket, 6000); assert.ok(grant); assert.equal(grant.budget, ticket.budget);
  assert.equal(source.borrowPiSource('peer1'), undefined); assert.equal(source.borrowPiSource('peer2'), undefined);
  assert.equal(source.stats().retention.entries, 1); assert.deepEqual(source.workStatus('target'), work);
  assert.equal(ticket.budget.stats().outstandingPeakBytes, 6000); grant.close();
  ticket.release(); source.dispose(); assert.equal(ticket.budget.stats().retainedBytes, 0);
});

test('Pi ownership: payload constructor exception empties stage and releases all transferred data', () => {
  const budget = new DataBudget(100_000), projection = prepared(budget), stage = projection.stage()!, freeze = Object.freeze;
  Object.freeze = () => { throw Error('payload header'); };
  try { assert.throws(() => stage.consume(), /payload header/); } finally { Object.freeze = freeze; }
  assert.equal(stage.consume(), undefined); stage.dispose(); projection.dispose(); assert.equal(budget.stats().retainedBytes, 0);
});


test('Pi ownership: adoption exception still delivers pressure receipts for evicted peers', async () => {
  const notices: string[] = [], source = new SourceController(provider, { retention: { maxBytes: 8000 }, onChange: keys => notices.push(...keys) });
  source.capturePiSource('a', 1, 'ab'); const ticket = source.piPreparation('a', source.borrowPiSource('a')!.generation, 1, 1)!;
  assert.ok(source.adoptPiFlat(ticket, 'ab', prepared(ticket.budget).stage()!));
  const stage = prepared(ticket.budget).stage()!, baseline = ticket.budget.stats().retainedBytes;
  source.capturePiSource('peer', 1, 'p'); const fixed = ticket.budget.stats().retainedBytes - baseline - 2;
  const text = 'p'.repeat(Math.floor((8000 - baseline - fixed) / 2));
  assert.ok(source.capturePiSource('peer', 2, text)); assert.ok(source.borrowPiSource('peer')); assert.ok(source.piProjection('a', 1, 1));
  assert.ok(8000 - ticket.budget.stats().retainedBytes < 128);
  await new Promise<void>(resolve => setImmediate(resolve)); notices.length = 0;
  const reserve = DataBudget.prototype.reserve;
  DataBudget.prototype.reserve = function(bytes) { if (this === ticket.budget) throw Error('after pressure'); return reserve.call(this, bytes); };
  try { assert.throws(() => source.adoptPiFlat(ticket, 'ab', stage), /after pressure/); } finally { DataBudget.prototype.reserve = reserve; }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(notices.includes('peer')); assert.equal(source.borrowPiSource('peer'), undefined);
  assert.equal(stage.consume(), undefined); assert.ok(source.piProjection('a', 1, 1));
  ticket.release(); source.dispose(); assert.equal(ticket.budget.stats().retainedBytes, 0);
});
