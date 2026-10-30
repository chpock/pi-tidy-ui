import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { RuntimeHealth } from '../../../src/runtime-health.ts';
import { diagnose, reportRuntime, unexpectedDiagnostic } from '../../../src/diagnostics.ts';

function fixture() {
  const notifications: string[] = [], records: string[] = [];
  const health = new RuntimeHealth(message => notifications.push(message), () => 1_000);
  const sink = health.sink((level, area, explanation) => records.push(`${level}:${area}:${explanation}`));
  const fail = (scope: object, operation = 'source', code = 'invalid_source') => reportRuntime(sink, { kind: 'failure', scope, operation, code, area: 'syntax' });
  return { health, sink, fail, notifications, records };
}

test('runtime health: repeated failures coalesce, unrelated success cannot hide the broken card', async () => {
  const f = fixture(), a = {}, b = {};
  f.fail(a); for (let i = 0; i < 1000; i++) f.fail(a);
  f.fail(b); reportRuntime(f.sink, { kind: 'recovered', scope: b, operation: 'source' });
  assert.equal(f.health.snapshot().errors, 2); assert.equal(f.health.snapshot().active, 1);
  await turn(); assert.equal(f.notifications.length, 1); assert.match(f.notifications[0]!, /invalid_source.*\/tidy-ui/u);
  assert.equal(f.health.snapshot().issues[0]!.state, 'active');
  reportRuntime(f.sink, { kind: 'recovered', scope: a, operation: 'source' });
  assert.equal(f.health.snapshot().active, 0);
  f.fail(a); await turn(); assert.equal(f.notifications.length, 2); assert.equal(f.health.snapshot().errors, 3);
});

test('runtime health: SOURCE recovery does not clear STYLE failure on the same owner', () => {
  const f = fixture(), source = {};
  f.fail(source, 'source'); f.fail(source, 'styles', 'invalid_header');
  reportRuntime(f.sink, { kind: 'recovered', scope: source, operation: 'source' });
  assert.equal(f.health.snapshot().active, 1); assert.equal(f.health.snapshot().issues[0]!.operation, 'styles');
  reportRuntime(f.sink, { kind: 'released', scope: source, operation: '*' });
  assert.equal(f.health.snapshot().active, 0); assert.equal(f.health.snapshot().last?.state, 'released');
});

test('runtime health: journal errors or disabled capture do not prevent runtime reporting', async () => {
  let writes = 0;
  const notifications: string[] = [], health = new RuntimeHealth(message => notifications.push(message));
  const sink = health.sink(() => { writes++; throw new Error('logging failed'); }), scope = {};
  diagnose(sink, 'ERROR', 'syntax', 'Bad native reply');
  reportRuntime(sink, { kind: 'failure', area: 'syntax', scope, operation: 'source', code: 'invalid_source' });
  await turn(); assert.equal(writes, 1); assert.equal(health.snapshot().errors, 1); assert.equal(notifications.length, 1);
  const withoutJournal = health.sink(() => {});
  reportRuntime(withoutJournal, { kind: 'failure', area: 'syntax', scope, operation: 'styles', code: 'invalid_header' });
  assert.equal(health.snapshot().active, 2);
});

test('runtime health: expected volume, queue and cancellation refusals are not errors', () => {
  for (const code of ['source_limit', 'result_limit', 'reply_limit', 'scope_limit', 'busy', 'queue_expired', 'cancelled', 'restart_required'])
    assert.equal(unexpectedDiagnostic({ code }), false, code);
  for (const code of ['invalid_source', 'invalid_header', 'parser_error', 'invalid_close', 'owned_palette_unavailable', 'EIO']) assert.equal(unexpectedDiagnostic({ code }), true, code);
  assert.equal(unexpectedDiagnostic({ code: 'unknown_syntax', execution: 'not_started' }), false);
  assert.equal(unexpectedDiagnostic({ code: 'unknown_syntax', execution: 'started' }), true);
  assert.equal(unexpectedDiagnostic({ code: 'unknown_syntax' }), true);
  assert.equal(unexpectedDiagnostic(new TypeError('PRIVATE')), true);
});

test('runtime health: notifications never run inside the failing operation and cannot break it', async () => {
  let depth = 1, called = 0;
  const health = new RuntimeHealth(() => { assert.equal(depth, 0); called++; throw new Error('host unavailable'); });
  health.event({ kind: 'failure', area: 'syntax', operation: 'source', scope: {}, code: 'invalid_source' });
  assert.equal(called, 0); depth = 0; await turn(); assert.equal(called, 1);
});

test('runtime health: disposal cancels pending notices and ignores late callbacks', async () => {
  const f = fixture(), source = {};
  f.fail(source); f.health.dispose(); f.fail(source, 'styles'); await turn();
  assert.equal(f.notifications.length, 0); assert.equal(f.health.snapshot().active, 0); assert.equal(f.health.snapshot().errors, 1);
});

test('runtime health: snapshots are detached and retain historical errors after owner retirement', () => {
  const f = fixture(), source = {};
  f.fail(source); const snapshot = f.health.snapshot(); snapshot.last!.code = 'changed'; snapshot.issues[0]!.code = 'changed';
  assert.equal(f.health.snapshot().last!.code, 'invalid_source');
  reportRuntime(f.sink, { kind: 'released', scope: source, operation: '*' });
  assert.equal(f.health.snapshot().errors, 1); assert.equal(f.health.snapshot().last!.state, 'released');
});

async function abandonedFailure(f: ReturnType<typeof fixture>) {
  const source = {}; f.fail(source); return new WeakRef(source);
}
test('runtime health: active failure and queued notifier do not retain a source owner', async () => {
  assert.ok(global.gc, 'prepared GC context required');
  const f = fixture(), source = await abandonedFailure(f);
  let collected = false;
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!source.deref()) { collected = true; break; } }
  assert.equal(collected, true); assert.equal(f.health.snapshot().active, 0); assert.equal(f.health.snapshot().last?.state, 'released');
});

async function abandonedHealth() {
  const health = new RuntimeHealth(() => {}), source = {};
  const sink = health.sink(() => {}); health.event({ kind: 'failure', area: 'syntax', scope: source, operation: 'source', code: 'invalid_source' });
  return { weak: new WeakRef(health), sink, source };
}
test('runtime health: retained old job sink cannot retain a retired runtime', async () => {
  assert.ok(global.gc, 'prepared GC context required');
  const old = await abandonedHealth(); let collected = false;
  for (let i = 0; i < 40; i++) { await turn(); global.gc!(); await turn(); if (!old.weak.deref()) { collected = true; break; } }
  assert.equal(collected, true); reportRuntime(old.sink, { kind: 'failure', area: 'syntax', scope: old.source, operation: 'source', code: 'invalid_source' });
});

test('runtime health: a different failure category is announced while an older category remains unresolved', async () => {
  const f = fixture(), source = {}, settings = {};
  f.fail(source); await turn(); assert.equal(f.notifications.length, 1);
  reportRuntime(f.sink, { kind: 'failure', area: 'settings', operation: 'read', scope: settings, code: 'settings_read' });
  await turn(); assert.equal(f.notifications.length, 2); assert.equal(f.health.snapshot().active, 2);
  f.fail(source); await turn(); assert.equal(f.notifications.length, 2);
});

test('runtime health: same-turn distinct categories are both delivered without duplicates', async () => {
  const f = fixture(), source = {}, settings = {};
  f.fail(source); f.fail(source);
  reportRuntime(f.sink, { kind: 'failure', area: 'settings', operation: 'save', scope: settings, code: 'settings_save' });
  assert.equal(f.notifications.length, 0); await turn(); assert.equal(f.notifications.length, 2);
  assert.match(f.notifications[0]!, /Syntax highlighting/); assert.match(f.notifications[1]!, /Settings/);
  f.fail(source); await turn(); assert.equal(f.notifications.length, 2);
});

test('runtime health: independent lease generations recover separately but share one notification category', async () => {
  const f = fixture(), a = {}, b = {};
  reportRuntime(f.sink, { kind: 'failure', scope: a, area: 'syntax', operation: 'lease:1', code: 'invalid_close' });
  reportRuntime(f.sink, { kind: 'failure', scope: b, area: 'syntax', operation: 'lease:2', code: 'invalid_close' });
  await turn(); assert.equal(f.notifications.length, 1); assert.equal(f.health.snapshot().active, 2);
  reportRuntime(f.sink, { kind: 'recovered', scope: a, operation: 'lease:1' });
  assert.equal(f.health.snapshot().active, 1);
  reportRuntime(f.sink, { kind: 'recovered', scope: b, operation: 'lease:2' });
  assert.equal(f.health.snapshot().active, 0);
});
