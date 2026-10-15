import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readPendingJson, themePhaseReady } from './fixtures/syntax-observation.mjs';

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
