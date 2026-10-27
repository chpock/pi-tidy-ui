import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { readPendingJson, themePhaseReady } from '../fixtures/syntax-observation.mjs';
import * as syntax from '../fixtures/syntax-cli-support.mjs';

test('syntax counter observations tolerate incomplete publication but propagate other I/O errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'syntax-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'observation.json');
  assert.equal(readPendingJson(path), undefined);
  for (const text of ['', '{"counts":']) {
    writeFileSync(path, text);
    assert.equal(readPendingJson(path), undefined);
  }
  writeFileSync(path, '{"counts":{"dispatches":5}}');
  assert.deepEqual(readPendingJson(path), { counts: { dispatches: 5 } });
  assert.throws(() => readPendingJson(root));
});

const markers = ['BASH_ONE', 'BASH_TWO', 'EDIT_OLD', 'EDIT_NEW', 'WRITE_BODY'];
const reply = (phase, marker) => ({ type: 'syntax_theme_reply', phase, payload: { sources: [{ text: `const ${marker} = 1;` }] } });
const snapshot = () => ({ client: { provider: { availability: 'ready' }, effective: { id: 'preview' } }, source: { globalUnsettledJobs: 0 } });

test('zero physical jobs between preparation batches is not a completed theme preview', async () => {
  const current = snapshot(), events = markers.slice(0, 2).map(marker => reply('preview', marker));
  assert.equal(await themePhaseReady(() => current, () => events, 'preview', markers), false);
  events.push(...markers.slice(2).map(marker => reply('previous', marker)));
  assert.equal(await themePhaseReady(() => current, () => events, 'preview', markers), false);
  events.push(...markers.slice(2).map(marker => reply('preview', marker)));
  assert.equal(await themePhaseReady(() => current, () => events, 'preview', markers), current);
  current.source.globalUnsettledJobs = 1;
  assert.equal(await themePhaseReady(() => current, () => events, 'preview', markers), false);
});

test('repeated replies for one logical source cannot stand in for the other preview sources', async () => {
  const events = markers.map(() => reply('preview', markers[0]));
  assert.equal(await themePhaseReady(snapshot, () => events, 'preview', markers), false);
});

for (const phaseMarkers of [markers, markers.slice(0, 2)]) test(`phase replies precede the counter snapshot for ${phaseMarkers.length} logical sources`, async () => {
  const events = [reply('preview', phaseMarkers[0])], order = [];
  let dispatches = 1;
  const publish = () => {
    events.splice(1, events.length, ...phaseMarkers.slice(1).map(marker => reply('preview', marker)));
    dispatches = phaseMarkers.length;
  };
  const observe = async () => {
    order.push('snapshot');
    const current = snapshot();
    current.source.dispatches = dispatches;
    // Remaining child work may finish after writing this snapshot but before the parent reads its file.
    publish();
    return current;
  };
  const readEvents = () => { order.push('events'); return events; };
  assert.equal(await themePhaseReady(observe, readEvents, 'preview', phaseMarkers), false,
    'newer replies must not validate a counter snapshot taken between preparation batches');
  assert.deepEqual(order, ['events'], 'do not request counters before the required source replies exist');
  publish();
  const current = await themePhaseReady(observe, readEvents, 'preview', phaseMarkers);
  assert.equal(current.source.dispatches, phaseMarkers.length);
  assert.deepEqual(order, ['events', 'events', 'snapshot']);
});

test('phase readiness propagates journal and counter failures', async () => {
  const events = markers.map(marker => reply('preview', marker));
  await assert.rejects(themePhaseReady(snapshot, () => { throw new Error('journal failed'); }, 'preview', markers), /journal failed/);
  await assert.rejects(themePhaseReady(() => { throw new Error('snapshot failed'); }, () => events, 'preview', markers), /snapshot failed/);
});

function resultFixture(t, current = snapshot()) {
  const output = mkdtempSync(join(tmpdir(), 'syntax-result-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let commands = 0, captures = 0;
  const terminal = {
    output, health() {},
    send(command) {
      commands++;
      const name = /^\/tidy-ui-syntax-stats ([a-z0-9-]+)\r$/.exec(command)?.[1];
      assert.ok(name);
      writeFileSync(join(output, `syntax-stats-${name}.json`), JSON.stringify(current));
    },
    async captureSettled() { captures++; return { sample: structuredClone(current) }; },
  };
  return { terminal, current, commands: () => commands, captures: () => captures };
}

test('settled syntax results: zero native jobs cannot replace the held producer/delivery completion', async t => {
  const f = resultFixture(t, { ...snapshot(), localWork: { prefixScalarReads: 0 } });
  let release, finished = false, captures = 0;
  const delivery = new Promise(resolve => { release = resolve; });
  f.terminal.captureSettled = async () => { captures++; await delivery; return { sample: structuredClone(f.current) }; };
  const pending = syntax.settledStats(f.terminal, 'held-delivery', current => current.source.globalUnsettledJobs === 0)
    .then(current => { finished = true; return current; });
  try {
    await turn();
    assert.equal(finished, false, 'the actual producer still owes its delivery');
    assert.equal(captures, 1);
    assert.equal(f.commands(), 0, 'sampling must not issue a diagnostic/input command');
  } finally { f.current.localWork.prefixScalarReads = 54; release(); }
  const result = await pending;
  assert.equal(result.localWork.prefixScalarReads, 54, 'the sample follows the held delivery');
});

test('settled syntax results: a wrong completed outcome fails once instead of polling for successful assertions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = resultFixture(t);
  let checks = 0;
  const pending = syntax.settledStats(f.terminal, 'wrong-outcome', () => {
    if (++checks > 1) throw Object.assign(new Error('Final assertion was retried'), { code: 'FINAL_RETRY' });
    return false;
  });
  const rejected = assert.rejects(pending, { code: 'ERR_ASSERTION' });
  await turn(); t.mock.timers.tick(30);
  await rejected;
  assert.equal(checks, 1); assert.equal(f.captures(), 1); assert.equal(f.commands(), 0);
});

test('settled syntax results: producer/capture failure surfaces without counter polling or fallback', async t => {
  const f = resultFixture(t), failure = new Error('controlled producer failure');
  f.terminal.captureSettled = async () => { throw failure; };
  await assert.rejects(syntax.settledStats(f.terminal, 'failed-producer', () => true), error => error === failure);
  assert.equal(f.commands(), 0);
});

test('settled syntax results: natural cold sample precedes explicitly completed component diagnostics', async t => {
  const f = resultFixture(t), order = [];
  const cold = { sample: { localWork: { prefixScalarReads: 54 } }, screen: ['NATURAL'], cells: [[{ text: 'N' }]], receipt: { id: 1, generation: 1, frames: 2 } };
  const diagnostic = { session: 'controlled-session', tools: [{ name: 'bash', lines: ['rendered source'] }], branch: [] };
  let releaseNatural, releaseDiagnostic, finished = false, counter = 54;
  const natural = new Promise(resolve => { releaseNatural = resolve; });
  const rendered = new Promise(resolve => { releaseDiagnostic = resolve; });
  f.terminal.captureSettled = async () => { order.push('natural-start'); await natural; order.push('natural-sample'); return cold; };
  f.terminal.command = async command => {
    assert.equal(command, '/tidy-ui-dump natural-cold');
    order.push('explicit-render'); counter += 54; await rendered;
    writeFileSync(join(f.terminal.output, 'natural-cold.json'), JSON.stringify(diagnostic));
    order.push('diagnostic-complete');
  };
  let pending;
  try {
    pending = syntax.captureThenRenderDiagnostics(f.terminal, 'natural-cold').then(value => { finished = true; return value; });
    await turn(); assert.deepEqual(order, ['natural-start']);
    releaseNatural(); await turn();
    assert.deepEqual(order, ['natural-start', 'natural-sample', 'explicit-render']);
    assert.equal(finished, false, 'the explicit action must actually finish before its metadata is returned');
    releaseDiagnostic();
    const result = await pending;
    assert.equal(result.sample.localWork.prefixScalarReads, 54, 'diagnostic work cannot rewrite the natural cold baseline');
    assert.equal(counter, 108); assert.deepEqual(result.receipt, cold.receipt);
    assert.deepEqual(result.screen, cold.screen); assert.deepEqual(result.cells, cold.cells);
    assert.deepEqual(result.tools, diagnostic.tools); assert.deepEqual(result.branch, diagnostic.branch);
    assert.equal(result.session, diagnostic.session); assert.equal(f.terminal.session, diagnostic.session);
    assert.equal(f.commands(), 0);
  } finally { releaseNatural(); releaseDiagnostic(); if (pending) await pending; }
});

function scenarioFixture(t) {
  const output = mkdtempSync(join(tmpdir(), 'syntax-scenario-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  writeFileSync(join(output, 'syntax-shell-ready'), 'ready');
  const order = [], sample = { client: { provider: { availability: 'unavailable' } }, source: { globalUnsettledJobs: 0 } };
  const metadata = { session: 'controlled-fallback-session', branch: [], tools: [{ name: 'bash', lines: ['source'] }] };
  const events = [
    ...['bash', 'write', 'edit'].map(name => ({ type: 'call', name })),
    ...['bash', 'write', 'edit'].map(name => ({ type: 'result', name })),
    ...Array.from({ length: 4 }, () => ({ type: 'model_context' })),
  ];
  const terminal = {
    output, async ready() {}, async event() {}, async settle() {}, health() {}, events: () => events,
    send(command) { assert.equal(command, 'run syntax-cards\r'); },
    async capture(name) {
      order.push(name);
      if (name === 'syntax-final') return metadata;
      const running = name === 'syntax-running';
      return { tools: [{ name: 'bash', argsComplete: running, executionStarted: running }] };
    },
    async captureSettled(name) {
      assert.equal(name, 'syntax-final'); order.push('passive-final');
      return { sample, screen: ['NATURAL'], cells: [[{ text: 'N' }]], receipt: { id: 1, generation: 1, frames: 2 } };
    },
    async command(command) {
      assert.equal(command, '/tidy-ui-dump syntax-final'); order.push('explicit-final-diagnostic');
      writeFileSync(join(output, 'syntax-final.json'), JSON.stringify(metadata));
    },
  };
  return { terminal, sample, metadata, order };
}

for (const { name, classify, options } of [
  { name: 'stock without an owner', classify: true, options: {} },
  { name: 'explicitly held owned fallback', classify: false, options: { ownedFallback: true } },
]) test(`settled syntax scenarios: ${name} keeps the explicit frame path`, async t => {
  const f = scenarioFixture(t);
  const result = await syntax.scenario(f.terminal, false, classify, options);
  assert.equal(result, f.metadata);
  assert.deepEqual(f.order, [...Array.from({ length: 5 }, (_, phase) => `syntax-prefix-${phase}`), 'syntax-pending', 'syntax-running', 'syntax-final']);
});

test('settled syntax scenarios: explicit owned fallback samples before diagnostics without native-success permission', async t => {
  const f = scenarioFixture(t);
  const result = await syntax.scenario(f.terminal, false, true, { ownedFallback: true });
  assert.deepEqual(f.order, [...Array.from({ length: 5 }, (_, phase) => `syntax-prefix-${phase}`), 'syntax-pending', 'syntax-running',
    'passive-final', 'explicit-final-diagnostic']);
  assert.equal(result.sample, f.sample); assert.equal(result.sample.client.provider.availability, 'unavailable');
  assert.deepEqual(result.tools, f.metadata.tools); assert.deepEqual(result.screen, ['NATURAL']);
});

test('settled syntax scenarios: a failed owned-fallback observation cannot fall back to diagnostic success', async t => {
  const f = scenarioFixture(t), failure = new Error('controlled fallback producer cancellation');
  f.terminal.captureSettled = async () => { throw failure; };
  await assert.rejects(syntax.scenario(f.terminal, false, true, { ownedFallback: true }), error => error === failure);
  assert.equal(f.order.includes('syntax-final'), false); assert.equal(f.order.includes('explicit-final-diagnostic'), false);
});
