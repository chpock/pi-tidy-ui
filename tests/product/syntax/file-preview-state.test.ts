import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { FilePreviewState } from '../../../src/file-preview-state.ts';

type Owner = { call: number };
const owner = (call: number): Owner => ({ call });

test('automatic write/edit presentation is bounded to the last ten successful live owners at turn end', () => {
  const state = new FilePreviewState<Owner>();
  const calls = Array.from({ length: 11 }, (_, index) => ({ owner: owner(index), toolCallId: `write-${index}` }));
  calls.forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const call of calls) { state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true); }
  for (const call of calls) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full');
  assert.equal(state.candidates().length, 11, 'every current-turn successful owner remains reachable until boundary demotions are applied');

  state.finishTurn(state.candidates());
  assert.equal(state.mode(calls[0]!.owner, calls[0]!.toolCallId, false), 'preview');
  for (const call of calls.slice(1)) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full');
  assert.equal(state.mode(owner(0), calls[0]!.toolCallId, false), 'preview', 'reconstructed history does not inherit the call ID choice');
});

test('an active-turn file stays preview until its matching completion is finalized', () => {
  const state = new FilePreviewState<Owner>();
  const pending = owner(1), toolCallId = 'write-pending';
  state.observe(pending, toolCallId);
  state.beginTurn();
  assert.equal(state.mode(pending, toolCallId, false), 'preview', 'starting a turn does not make an observed pending owner successful');
  state.completed(toolCallId);
  assert.equal(state.mode(pending, toolCallId, false), 'preview', 'a completion token alone does not make the owner successful');
  assert.equal(state.finalize(pending, toolCallId), true);
  assert.equal(state.mode(pending, toolCallId, false), 'full', 'only the attached final success enters the current full window');
});

test('parallel completion order does not replace live component order or turn success', () => {
  const state = new FilePreviewState<Owner>();
  const calls = Array.from({ length: 11 }, (_, index) => ({ owner: owner(index), toolCallId: `edit-${index}` }));
  calls.forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const index of [10, 0, 8, 3, 9, 2, 7, 1, 6, 4]) {
    const call = calls[index]!; state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true);
  }
  state.finishTurn(state.candidates());

  assert.equal(state.mode(calls[0]!.owner, calls[0]!.toolCallId, false), 'full', 'the ceiling is applied after the failed owner is excluded, leaving ten successful owners');
  assert.equal(state.mode(calls[1]!.owner, calls[1]!.toolCallId, false), 'full', 'a successful call inside the final ten remains full');
  assert.equal(state.mode(calls[5]!.owner, calls[5]!.toolCallId, false), 'preview', 'an unfinished call is never automatically expanded');
  for (const index of [2, 3, 4, 6, 7, 8, 9, 10]) assert.equal(state.mode(calls[index]!.owner, calls[index]!.toolCallId, false), 'full');
});

test('manual choices survive rolling-window changes, while global expansion temporarily overrides them', () => {
  const state = new FilePreviewState<Owner>();
  const first = owner(1), second = owner(2);
  state.observe(first, 'write-1'); state.observe(second, 'write-2');
  state.beginTurn(); state.completed('write-1'); assert.equal(state.finalize(first, 'write-1'), true);
  state.finishTurn(state.candidates());
  assert.equal(state.toggle(first, 'write-1', false), 'preview');
  assert.equal(state.mode(first, 'write-1', false), 'preview');
  assert.equal(state.toggle(second, 'write-2', false), 'full');
  assert.equal(state.mode(second, 'write-2', true), 'full', 'global expansion temporarily overrides the per-owner choice');
  assert.equal(state.mode(second, 'write-2', false), 'full', 'manual choice is restored when the flag clears');
  assert.equal(state.toggle(second, 'write-2', true), 'preview', 'a click on an effectively full card records the opposite choice');
  assert.equal(state.mode(second, 'write-2', false), 'preview', 'the direct click remains after global expansion clears');

  const third = owner(3); state.observe(third, 'edit-3');
  state.beginTurn(); state.completed('edit-3'); assert.equal(state.finalize(third, 'edit-3'), true);
  state.finishTurn(state.candidates());
  assert.equal(state.mode(first, 'write-1', false), 'preview', 'the owner-specific manual choice survives rolling-window changes');
  assert.equal(state.mode(third, 'edit-3', false), 'full', 'the newly successful live owner joins the window');
  assert.equal(state.mode(second, 'write-2', false), 'preview', 'manual per-owner choice remains');
  assert.equal(state.toggle(second, 'write-2', false), 'full');
  assert.equal(state.mode(second, 'write-2', false), 'full');
});

test('the live automatic window rolls across short, longer, and empty turns', () => {
  const state = new FilePreviewState<Owner>();
  const calls = Array.from({ length: 11 }, (_, index) => ({ owner: owner(index), toolCallId: `write-${index}` }));
  calls.slice(0, 3).forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const call of calls.slice(0, 3)) { state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true); }
  state.finishTurn(state.candidates());
  calls.slice(3, 5).forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const call of calls.slice(3, 5)) { state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true); }
  state.finishTurn(state.candidates());
  for (const call of calls.slice(0, 5)) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full', 'three plus two live calls retain a five-item window');

  state.beginTurn();
  state.finishTurn(state.candidates());
  for (const call of calls.slice(0, 5)) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full', 'an empty/non-file turn preserves the existing window');

  calls.slice(5, 9).forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const call of calls.slice(5, 9)) { state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true); }
  state.finishTurn(state.candidates());
  calls.slice(9, 11).forEach(call => state.observe(call.owner, call.toolCallId));
  state.beginTurn();
  for (const call of calls.slice(9, 11)) { state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true); }
  state.finishTurn(state.candidates());
  assert.equal(state.mode(calls[0]!.owner, calls[0]!.toolCallId, false), 'preview');
  for (const call of calls.slice(1)) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full', 'nine plus two keeps exactly the newest ten live successes');
});

test('a pending tool-call token is consumed by only the first attached final success', () => {
  const state = new FilePreviewState<Owner>();
  const first = owner(1), reconstructed = owner(1);
  state.observe(first, 'same-call'); state.observe(reconstructed, 'same-call');
  state.beginTurn(); state.completed('same-call');
  assert.equal(state.finalize(first, 'same-call'), true);
  assert.equal(state.finalize(reconstructed, 'same-call'), false);
  state.finishTurn(state.candidates());
  assert.equal(state.mode(first, 'same-call', false), 'full');
  assert.equal(state.mode(reconstructed, 'same-call', false), 'preview');
});


test('finalize consumes only a completion for the observed owner and call ID', () => {
  const state = new FilePreviewState<Owner>();
  const first = owner(1), second = owner(2), unknown = owner(3);
  state.observe(first, 'edit-1'); state.observe(second, 'edit-2'); state.beginTurn();
  state.completed('edit-2');
  assert.equal(state.finalize(unknown, 'edit-2'), false, 'an owner without a record cannot claim a completed tool call');
  assert.equal(state.finalize(first, 'edit-2'), false, 'a different owner cannot consume the pending call');
  state.completed('edit-1');
  assert.equal(state.finalize(first, 'edit-1'), true);
  assert.equal(state.isCurrentSuccess(first, 'edit-1'), true);
  assert.equal(state.isCurrentSuccess(first, 'edit-2'), false);
  assert.equal(state.finalize(second, 'edit-2'), true, 'the rejected owner did not consume the pending call');
  state.finishTurn(state.candidates());
});

test('re-observing an owner removes only its replaced automatic and current records', () => {
  const state = new FilePreviewState<Owner>();
  const first = owner(1), second = owner(2);
  state.observe(first, 'write-1'); state.observe(second, 'write-2'); state.beginTurn();
  for (const [candidate, id] of [[first, 'write-1'], [second, 'write-2']] as const) {
    state.completed(id); assert.equal(state.finalize(candidate, id), true);
  }
  state.finishTurn(state.candidates());
  state.observe(first, 'write-1-next');
  assert.equal(state.mode(first, 'write-1', false), 'preview');
  assert.equal(state.mode(second, 'write-2', false), 'full');

  state.beginTurn();
  state.completed('write-1-next'); assert.equal(state.finalize(first, 'write-1-next'), true);
  state.completed('write-2'); assert.equal(state.finalize(second, 'write-2'), true);
  state.observe(first, 'write-1-later');
  assert.deepEqual(state.candidates().map(candidate => candidate.toolCallId), ['write-2']);
  state.finishTurn(state.candidates());
  assert.equal(state.mode(first, 'write-1-later', false), 'preview');
  assert.equal(state.mode(second, 'write-2', false), 'full');

  const current = new FilePreviewState<Owner>();
  const currentFirst = owner(3), currentSecond = owner(4);
  current.observe(currentFirst, 'edit-current-1'); current.observe(currentSecond, 'edit-current-2'); current.beginTurn();
  current.completed('edit-current-1'); assert.equal(current.finalize(currentFirst, 'edit-current-1'), true);
  current.completed('edit-current-2'); assert.equal(current.finalize(currentSecond, 'edit-current-2'), true);
  current.observe(currentFirst, 'edit-current-1-replaced');
  assert.deepEqual(current.candidates().map(candidate => candidate.toolCallId), ['edit-current-2']);
});

test('turn-end keeps only attached successful owners and ignores later completions', () => {
  const state = new FilePreviewState<Owner>();
  const attached = owner(1), removed = owner(2);
  state.observe(attached, 'write-attached'); state.observe(removed, 'write-removed'); state.beginTurn();
  for (const [candidate, id] of [[attached, 'write-attached'], [removed, 'write-removed']] as const) {
    state.completed(id); assert.equal(state.finalize(candidate, id), true);
  }
  state.finishTurn(state.candidates().filter(candidate => candidate.owner === attached));
  assert.equal(state.mode(attached, 'write-attached', false), 'full');
  assert.equal(state.mode(removed, 'write-removed', false), 'preview');

  state.completed('write-attached');
  assert.equal(state.finalize(attached, 'write-attached'), false, 'a completion after the turn boundary is ignored');
  state.reset();
  state.observe(attached, 'write-after-reset'); state.completed('write-after-reset');
  assert.equal(state.finalize(attached, 'write-after-reset'), false, 'reset leaves the turn inactive');
  assert.equal(state.mode(attached, 'write-after-reset', false), 'preview');
});

test('recency follows observed order when successful calls complete in reverse order', () => {
  const state = new FilePreviewState<Owner>();
  const calls = Array.from({ length: 11 }, (_, index) => ({ owner: owner(index), toolCallId: `reverse-${index}` }));
  calls.forEach(call => state.observe(call.owner, call.toolCallId)); state.beginTurn();
  for (const call of calls.toReversed()) {
    state.completed(call.toolCallId); assert.equal(state.finalize(call.owner, call.toolCallId), true);
  }
  assert.deepEqual(state.candidates().map(candidate => candidate.toolCallId), calls.map(call => call.toolCallId));
  state.finishTurn(state.candidates());
  assert.equal(state.mode(calls[0]!.owner, calls[0]!.toolCallId, false), 'preview');
  for (const call of calls.slice(1)) assert.equal(state.mode(call.owner, call.toolCallId, false), 'full');
});

function abandonedAutomaticOwner(): { state: FilePreviewState<Owner>; reference: WeakRef<Owner> } {
  const state = new FilePreviewState<Owner>();
  let target: Owner | undefined = owner(99);
  const reference = new WeakRef(target), toolCallId = 'write-collected';
  state.observe(target, toolCallId); state.beginTurn(); state.completed(toolCallId); state.finalize(target, toolCallId);
  state.finishTurn(state.candidates());
  target = undefined;
  return { state, reference };
}

async function collected(reference: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    await turn(); global.gc!(); await turn();
    if (!reference.deref()) return true;
  }
  return false;
}

test('candidate enumeration prunes owners collected from the automatic window', { skip: !global.gc }, async () => {
  assert.equal(typeof global.gc, 'function');
  const { state, reference } = abandonedAutomaticOwner();
  assert.equal(await collected(reference), true);
  assert.equal(state.candidates().length, 0, 'a weakly collected owner is not returned as an attached candidate');
});
