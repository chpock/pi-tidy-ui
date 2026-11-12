import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationScope } from '../../../src/application/scope.ts';

test('application scope starts live at generation zero and keeps equality distinct from action admission', () => {
  const owner = new ApplicationScope(), first = owner.scope(0), signal = first.signal;
  assert.equal(owner.generation, 0); assert.equal(owner.isGeneration(0), true);
  assert.equal(first.current(), true); assert.equal(signal.aborted, false);
  owner.retire();
  assert.equal(owner.generation, 1); assert.equal(signal.aborted, true); assert.equal(first.current(), false);
  const retired = owner.scope(owner.generation);
  assert.equal(owner.isGeneration(owner.generation), true); assert.equal(retired.current(), false);
  assert.equal(retired.signal === signal, true, 'retirement leaves the existing aborted signal, not an active successor');
  owner.retire(); assert.equal(owner.generation, 2); assert.equal(owner.scope(2).signal === signal, true);
});

test('application begin advances before abort notification and allocates the successor afterward', () => {
  const owner = new ApplicationScope(), initial = owner.scope(0), outgoing = initial.signal;
  let observedGeneration = -1, sameSignalDuringAbort = false, calls = 0;
  outgoing.addEventListener('abort', () => {
    calls++; observedGeneration = owner.generation;
    sameSignalDuringAbort = owner.scope(observedGeneration).signal === outgoing;
  }, { once: true });
  const captured = owner.beginSession(), current = owner.scope(captured);
  assert.equal(calls, 1); assert.equal(observedGeneration, 1); assert.equal(sameSignalDuringAbort, true);
  assert.equal(captured, 1); assert.equal(current.current(), true); assert.equal(outgoing.aborted, true);
  assert.equal(current.signal === outgoing, false); assert.equal(current.signal.aborted, false);
  assert.equal(initial.current(), false, 'old scope predicates cannot be revived by an active successor signal');
  assert.equal(initial.signal === current.signal, true, 'the live signal reader does not replace the captured-generation predicate');
  owner.retire(); assert.equal(current.current(), false);
});

test('application begin returns its captured generation even if a synchronous abort listener retires it', () => {
  const owner = new ApplicationScope(); owner.beginSession();
  const outgoing = owner.scope(owner.generation).signal;
  outgoing.addEventListener('abort', () => owner.retire(), { once: true });
  const captured = owner.beginSession();
  assert.equal(captured, 2); assert.equal(owner.generation, 3); assert.equal(owner.isGeneration(captured), false);
  assert.equal(owner.scope(captured).current(), false);
});
