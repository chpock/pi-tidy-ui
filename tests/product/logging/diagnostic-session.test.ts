import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SessionDiagnostics, debugLoggingDiagnostics } from '../../../src/application/diagnostic-session.ts';
import { diagnose, reportRuntime, type DiagnosticSink } from '../../../src/diagnostics.ts';
import { SessionLogging } from '../../../src/session-logging.ts';

function context(session = 'diagnostic-session') {
  const notices: { message: string; level: string }[] = [];
  const ctx = { hasUI: true, mode: 'tui', cwd: '/example', sessionManager: {
    getSessionId: () => session, getSessionFile: () => `/example/${session}.jsonl`,
  }, ui: { theme: { name: 'dark' }, notify(message: string, level: string) { notices.push({ message, level }); } } } as unknown as ExtensionContext;
  return { ctx, notices };
}

async function release(binding: SessionDiagnostics) {
  binding.retireHealth();
  try { await binding.closeJournal('quit'); }
  finally { binding.releaseJournal(); binding.release(); }
}

test('diagnostic binding keeps health without journals, reuses same-session sinks and can restart after release', async () => {
  const binding = new SessionDiagnostics(false), first = context(), current = context(), selected: DiagnosticSink[] = [];
  const onSelected = (sink: DiagnosticSink) => { assert.equal(sink === binding.sink, true); selected.push(sink); };
  first.ctx.sessionManager.getSessionFile = () => { throw Error('Disabled journal must not request file metadata'); };
  try {
    binding.begin(first.ctx, 'startup', true, onSelected);
    assert.equal(selected.length, 1);
    const original = binding.sink;
    assert.equal(typeof original?.runtime, 'function'); assert.equal(binding.journal, undefined);
    binding.begin(current.ctx, 'resume', false, onSelected);
    assert.equal(selected.length, 2); assert.equal(selected[1] === original, true);
    assert.equal(binding.sink === original, true);
    const scope = {};
    reportRuntime(original, { kind: 'failure', scope, operation: 'context-refresh', area: 'appearance', code: 'observer_control' });
    await turn();
    assert.equal(first.notices.length, 0); assert.equal(current.notices.length, 1);
    assert.equal(binding.healthSnapshot()!.errors, 1); assert.equal(binding.healthSnapshot()!.active, 1);
    binding.retireHealth(); assert.equal(binding.healthSnapshot()!.active, 0);
    assert.equal(binding.closeJournal('reload'), undefined);
    binding.releaseJournal(); binding.release();
    assert.equal(binding.sink, undefined); assert.equal(binding.healthSnapshot(), undefined);
    reportRuntime(original, { kind: 'failure', scope, operation: 'retired-context', area: 'appearance', code: 'observer_control' });
    await turn(); assert.equal(current.notices.length, 1);
    binding.begin(current.ctx, 'startup', true, onSelected);
    assert.equal(selected.length, 3);
    assert.equal(binding.sink === original, false); assert.equal(binding.healthSnapshot()!.errors, 0);
  } finally { await release(binding); }
});

test('capture off creates a disabled run without filesystem work and same-session begin never replaces or enables it', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-observer-disabled-')), unused = join(root, 'not-created');
  const binding = new SessionDiagnostics({ root: unused }), { ctx } = context(), selectedWithJournal: boolean[] = [];
  const onSelected = (sink: DiagnosticSink) => { assert.equal(sink === binding.sink, true); selectedWithJournal.push(Boolean(binding.journal)); };
  try {
    binding.begin(ctx, 'startup', false, onSelected);
    const journal = binding.journal; assert.equal(Boolean(journal), true); await journal!.ready();
    const original = journal!.status();
    diagnose(binding.sink, 'INFO', 'runtime', 'Disabled capture sentinel'); await journal!.flush();
    binding.begin(ctx, 'resume', true, onSelected);
    assert.deepEqual(selectedWithJournal, [false, true]);
    assert.equal(binding.journal === journal, true); assert.equal(binding.journal!.status().run, original.run);
    const status = journal!.status();
    assert.equal(status.capture, false); assert.equal(status.records, 0); assert.equal(status.writes, 0);
    assert.equal(status.scans, 0); assert.equal(status.timer, false);
    assert.equal(debugLoggingDiagnostics()!.run, original.run);
    await release(binding);
    assert.equal(debugLoggingDiagnostics()!.state, 'closed', 'debug status stays weakly attached to the outgoing run');
    await assert.rejects(fs.stat(unused), { code: 'ENOENT' });
  } finally { await release(binding); await fs.rm(root, { recursive: true, force: true }); }
});

test('journal warning refresh is separate from health context and journal release preserves outgoing records until final release', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-observer-contexts-')), health = context(), warning = context();
  let fail = false, faults = 0, finish!: () => void;
  const io = { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (fail) { fail = false; faults++; throw Object.assign(Error('PRIVATE_OBSERVER_DETAIL'), { code: 'ENOSPC' }); }
      return writev(buffers, position);
    };
    return handle;
  } };
  const binding = new SessionDiagnostics({ root, io }), close = SessionLogging.prototype.close;
  let pending: Promise<void> | undefined;
  try {
    binding.begin(health.ctx, 'startup', true);
    const journal = binding.journal!, sink = binding.sink, scope = {};
    await journal.ready(); binding.refreshJournalContext(warning.ctx);
    reportRuntime(sink, { kind: 'failure', scope, operation: 'separate-contexts', area: 'appearance', code: 'observer_control' });
    await turn();
    assert.deepEqual(health.notices.map(item => item.level), ['error']); assert.equal(warning.notices.length, 0);
    fail = true; diagnose(sink, 'INFO', 'runtime', 'Fault control sentinel'); await journal.flush();
    assert.equal(faults, 1); assert.equal(journal.status().state, 'failed');
    assert.deepEqual(warning.notices.map(item => item.level), ['warning']); assert.equal(health.notices.length, 1);
    await journal.setEnabled(true);
    const held = new Promise<void>(resolve => { finish = resolve; });
    pending = held.then(() => close.call(journal, 'reload'));
    SessionLogging.prototype.close = function (reason) { return this === journal ? pending! : close.call(this, reason); };
    binding.retireHealth();
    assert.equal(binding.closeJournal('reload') === pending, true, 'close returns the existing writer Promise without an extra continuation');
    binding.releaseJournal(); assert.equal(binding.journal, undefined);
    diagnose(sink, 'INFO', 'runtime', 'Outgoing record after journal-reference release'); await journal.flush();
    const records = journal.status().records;
    binding.release();
    diagnose(sink, 'INFO', 'runtime', 'Retired record after final observation release'); await journal.flush();
    assert.equal(journal.status().records, records);
    finish(); await pending;
    const body = await fs.readFile(journal.status().path, 'utf8');
    assert.match(body, /Outgoing record after journal-reference release/u);
    assert.doesNotMatch(body, /Retired record after final observation release|PRIVATE_OBSERVER_DETAIL/u);
  } finally {
    finish?.();
    try { await pending; }
    finally {
      SessionLogging.prototype.close = close;
      try { await release(binding); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  }
});
