import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admittedSource, applicableAttempt, nextSource, queuedSource, sourceExecution, sourceFaultCause,
  sourceRefused, sourceSatisfied, type SourceFacts, type SourceOpportunity, type SourceProgress } from '../../../src/highlighting/source-state.ts';

function facts(changes: Partial<SourceFacts> = {}): SourceFacts {
  return { provider: 1, generation: 10, version: 3, contentVersion: 1, complete: true, empty: false, inputRevision: 1, ...changes };
}
function opportunity(changes: Partial<SourceOpportunity> = {}): SourceOpportunity {
  return { active: true, enabled: true, available: true, held: false, ready: true, satisfied: false, now: 0, ...changes };
}
function progress(changes: Partial<SourceProgress> = {}): SourceProgress {
  return { sourceVersion: 1, complete: true, compatible: true, continuable: false, ...changes };
}

test('SOURCE action table distinguishes current demand, held work, activity and provider readiness', () => {
  const source = facts();
  assert.deepEqual(nextSource(source, opportunity()), { kind: 'parse', reconstruction: false });
  for (const unavailable of [{ active: false }, { enabled: false }, { available: false }])
    assert.deepEqual(nextSource(source, opportunity(unavailable)), { kind: 'idle' });
  for (const withdrawn of [{ frozen: true }, { retired: true }])
    assert.deepEqual(nextSource(facts(withdrawn), opportunity()), { kind: 'idle' });
  assert.deepEqual(nextSource(source, opportunity({ held: true })), { kind: 'held' });
  assert.deepEqual(nextSource(source, opportunity({ ready: false })), { kind: 'provider' });
  assert.deepEqual(nextSource(source, opportunity({ satisfied: true })), { kind: 'idle' });
  assert.equal(queuedSource(source, true, true, false), true);
  assert.equal(queuedSource(source, false, true, false), false);
  assert.equal(queuedSource(source, true, false, false), false);
});

test('SOURCE old acknowledgement, equal aliases and final parser completion have distinct validity', () => {
  const source = facts();
  assert.equal(sourceSatisfied(source, progress()), true);
  assert.equal(sourceSatisfied(facts({ contentVersion: 2 }), progress()), false);
  assert.equal(sourceSatisfied(source, progress({ sourceVersion: 4 })), false);
  assert.equal(sourceSatisfied(source, progress({ complete: false })), false);
  assert.equal(sourceSatisfied(source, progress({ compatible: false })), false);
  assert.equal(sourceSatisfied(facts({ complete: false }), progress({ complete: false, compatible: false, continuable: true })), true);
  assert.equal(sourceSatisfied(facts({ complete: false }), progress({ complete: false, continuable: false })), false);
  assert.equal(sourceSatisfied(facts({ empty: true }), undefined), true);
  assert.equal(sourceSatisfied(facts({ empty: true, refusalCause: 'metadataFunding' }), undefined), false);
  assert.equal(sourceSatisfied(facts({ continuation: null }), progress()), false);
});

test('SOURCE older no-start cannot suppress newer admitted input', () => {
  const source = facts({ inputRevision: 2, attemptInput: 1, attemptProvider: 1, attemptOutcome: 'not_started', attemptCause: 'refused' });
  assert.equal(applicableAttempt(source), false);
  assert.deepEqual(nextSource(source, opportunity()), { kind: 'parse', reconstruction: false });
  assert.equal(queuedSource(source, true, true, false), true);
  assert.equal(sourceExecution(source, true), 'unsettled');
  assert.equal(sourceExecution(source, false), 'not_started');
});

test('SOURCE current temporary no-start delays native retry without creating Pi priority', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'not_started', attemptCause: 'retry', retryAt: 60000 });
  assert.deepEqual(nextSource(source, opportunity({ now: 59999 })), { kind: 'delayed', at: 60000 });
  assert.deepEqual(nextSource(source, opportunity({ now: 60000 })), { kind: 'parse', reconstruction: false });
  assert.equal(queuedSource(source, true, true, false), false);
  assert.equal(sourceExecution(source, false), 'not_started');
  assert.equal(sourceExecution(source, true), 'unsettled');
});

test('SOURCE delay paces data work without postponing useful connection recovery', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'not_started', attemptCause: 'retry', retryAt: 60000 });
  assert.deepEqual(nextSource(source, opportunity({ ready: false, now: 1000 })), { kind: 'provider' });
  assert.deepEqual(nextSource(source, opportunity({ now: 1000 })), { kind: 'delayed', at: 60000 });
  const refused = { ...source, refusalInput: 1, refusalProvider: 1, refusalCause: 'sourceLimit' as const };
  assert.deepEqual(nextSource(refused, opportunity({ ready: false, now: 1000 })), { kind: 'refused' });
  assert.deepEqual(nextSource(source, opportunity({ ready: false, now: 1000, satisfied: true })), { kind: 'idle' });
});

test('SOURCE retry after unknown execution never erases ordinary shared history', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'unknown', attemptCause: 'retry', retryAt: 60000, sharedUnknown: true });
  assert.deepEqual(nextSource(source, opportunity({ now: 60000 })), { kind: 'parse', reconstruction: false });
  assert.equal(sourceExecution(source, false), 'unknown');
  assert.equal(sourceExecution({ ...source, attemptOutcome: 'acknowledged' }, false), 'unknown');
  assert.equal(sourceExecution({ ...source, provider: 2, attemptOutcome: 'stopped' }, false), 'unknown');
});

test('SOURCE refusal scope and old acknowledgement are independent of latest admission failure', () => {
  const source = facts({ refusalInput: 1, refusalProvider: 1, refusalCause: 'adoption', attemptInput: 1, attemptProvider: 1, attemptOutcome: 'acknowledged' });
  assert.equal(sourceRefused(source), true);
  assert.deepEqual(nextSource(source, opportunity()), { kind: 'refused' });
  assert.equal(sourceExecution(source, false), 'acknowledged');
  assert.equal(queuedSource(source, true, true, false), false);
  const unfunded = { ...source, refusalCause: 'metadataFunding' as const, refusalInput: undefined, refusalProvider: undefined };
  assert.equal(admittedSource(unfunded), false);
  assert.deepEqual(nextSource(unfunded, opportunity()), { kind: 'idle' });
  assert.equal(sourceExecution(unfunded, false), 'acknowledged');
  assert.equal(sourceRefused({ ...source, inputRevision: 2 }), false);
  assert.equal(sourceRefused({ ...source, provider: 2 }), false);
});

test('SOURCE withdrawal remains without readiness, but input or qualified ready-namespace reconciliation can supersede it', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'withdrawn' });
  assert.equal(sourceExecution(source, false), 'unsettled');
  assert.deepEqual(nextSource(source, opportunity({ ready: false })), { kind: 'provider' });
  assert.equal(sourceExecution(source, false), 'unsettled');
  const reconciled = { ...source, provider: 2 };
  assert.equal(sourceExecution(reconciled, false), 'not_started');
  assert.deepEqual(nextSource(reconciled, opportunity()), { kind: 'parse', reconstruction: false });
  assert.equal(sourceExecution({ ...source, inputRevision: 2 }, false), 'not_started');
  assert.equal(sourceExecution({ ...source, attemptOutcome: 'stopped' }, false), 'not_started');
  assert.equal(sourceExecution({ ...source, attemptOutcome: 'stopped', ownedUnknown: 4 }, false), 'unknown');
});

test('SOURCE parser reconstruction uses its separate start gate and retains repair priority', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'not_started', attemptCause: 'resync', continuation: null });
  assert.deepEqual(nextSource(source, opportunity()), { kind: 'parse', reconstruction: true });
  assert.deepEqual(nextSource(source, opportunity({ now: 1, resyncAt: 60000 })), { kind: 'delayed', at: 60000 });
  assert.deepEqual(nextSource(source, opportunity({ now: 60000, resyncAt: 60000 })), { kind: 'parse', reconstruction: true });
  assert.equal(queuedSource(source, true, true, false), true);
  assert.equal(sourceExecution(source, false), 'not_started');
  const newer = { ...source, inputRevision: 2 };
  assert.deepEqual(nextSource(newer, opportunity({ now: 1, resyncAt: 60000 })), { kind: 'delayed', at: 60000 });
  assert.deepEqual(nextSource(newer, opportunity({ now: 60000, resyncAt: 60000 })), { kind: 'parse', reconstruction: true });
  assert.deepEqual(nextSource({ ...newer, continuation: undefined }, opportunity({ now: 1, resyncAt: 60000 })), { kind: 'parse', reconstruction: false });
});

test('SOURCE explicit eviction entitlement alone is not native priority', () => {
  const source = facts({ attemptInput: 1, attemptProvider: 1, attemptOutcome: 'acknowledged', refusalInput: 1, refusalCause: 'storage' });
  assert.equal(queuedSource({ ...source, evictionEntitlement: 'reobserve' }, true, true, false), false);
  const readmitted = { ...source, evictionEntitlement: 'dispatch' as const };
  assert.equal(queuedSource(readmitted, true, true, false), true);
  assert.deepEqual(nextSource(readmitted, opportunity()), { kind: 'parse', reconstruction: false });
  assert.equal(sourceExecution(readmitted, false), 'acknowledged');
});

for (const execution of ['not_started', 'started'] as const) test(`SOURCE known fault causes retain received ${execution} evidence`, () => {
  for (const code of ['busy', 'data_limit', 'state_limit', 'session_limit']) assert.equal(sourceFaultCause(code, execution), 'retry');
  assert.equal(sourceFaultCause('worker_gone', execution), 'route');
  assert.equal(sourceFaultCause('restart_required', execution), execution === 'not_started' ? 'resync' : 'other');
  assert.equal(sourceFaultCause('queue_expired', execution), execution === 'not_started' ? 'retry' : 'other');
  assert.equal(sourceFaultCause('unknown-future-code', execution), execution === 'not_started' ? 'refused' : 'other');
});


test('SOURCE local input rejection is distinct from a retained parser-limit refusal and historical execution', () => {
  const rejected = facts({ generation: undefined, inputRevision: 2, refusalInput: 2, refusalProvider: 2, refusalCause: 'sourceLimit',
    attemptInput: 1, attemptProvider: 1, attemptOutcome: 'unknown', sharedUnknown: true });
  assert.equal(sourceRefused(rejected), true, 'a snapshotless current-input refusal does not relabel the older parser namespace');
  assert.equal(sourceExecution(rejected, false), 'unknown');
  assert.equal(sourceRefused({ ...rejected, inputRevision: 3 }), false);
  const retained = facts({ provider: 2, refusalInput: 1, refusalProvider: 1, refusalCause: 'sourceLimit' });
  assert.equal(sourceRefused(retained), false, 'a retained snapshot can be checked against its new ready parser namespace');
  assert.deepEqual(nextSource(retained, opportunity()), { kind: 'parse', reconstruction: false });
  assert.equal(sourceRefused({ ...rejected, refusalCause: 'adoption' }), false, 'parser-specific refusal retains its own provider qualifier');
});

for (const generation of [undefined, 10]) test(`SOURCE storage refusal protects its input independently of retained older generation ${generation}`, () => {
  const source = facts({ generation, refusalInput: 1, refusalProvider: 2, refusalCause: 'storage',
    attemptInput: 1, attemptProvider: 1, attemptOutcome: 'acknowledged' });
  assert.equal(sourceRefused(source), true);
  assert.equal(sourceExecution(source, false), 'acknowledged');
  assert.equal(sourceRefused({ ...source, inputRevision: 2 }), false);
  const permission = { ...source, evictionEntitlement: 'dispatch' as const };
  assert.deepEqual(nextSource(permission, opportunity({ available: false })), { kind: 'idle' }, 'permission cannot manufacture retained current input');
  assert.equal(queuedSource(permission, true, false, false), false);
});

test('SOURCE storage admission scope does not erase parser-specific refusal qualifiers', () => {
  for (const refusalCause of ['requestLimit', 'encoding', 'adoption'] as const) {
    const source = facts({ refusalCause, refusalInput: 1, refusalProvider: 1, refusalGeneration: 10 });
    assert.equal(sourceRefused(source), true);
    assert.equal(sourceRefused({ ...source, provider: 2 }), false);
    assert.equal(sourceRefused({ ...source, generation: 11 }), false);
    assert.equal(sourceRefused({ ...source, inputRevision: 2 }), false);
  }
});
