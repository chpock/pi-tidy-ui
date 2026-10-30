import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { preparedCardReady, preparedHistoryPaintOriginCount, preparedHistoryReady, waitForPerformanceReady } from '../../fixtures/performance-readiness.mjs';
import { createWriteCaptureGate } from '../../fixtures/syntax-local-work.ts';

function fixture() {
  const owner = { toolCallId: 'one' }, status = { exact: true, protective: false };
  const piPalette = { kind: 'pi' }, palette = 'pi:3:truecolor', input = { palette: 3, mode: 'truecolor' };
  const display = { version: 2, palette }, slot = { version: 2, palette: 3, outcome: 'waiting' };
  let native = true, pi = false, text = 'current', visit = true;
  const state = { revision: 4, display: { revision: 4 }, sourceRevision: 2, processed: 2, input,
    paint: { origin: 'pi', group: { palette } }, preparedTheme: 5, preparedPalette: palette, slots: new Map([['key', slot]]) };
  const consumer = { states: new WeakMap([[owner, state]]), themeRevision: 5, selectedPalette: piPalette,
    currentPalette(current) {
      const requested = this.selectedPalette;
      return current?.input && current.paletteFallback === this.inputIdentity(requested, current.input) ? piPalette : requested;
    },
    inputIdentity(selected, currentInput) { return `${selected.kind === 'pi' ? 'pi' : selected.id}:${currentInput.palette}:${currentInput.mode}`; },
    records: new Map([[1, { owner: new WeakRef(owner) }]]),
    client: { snapshot: () => ({ enabled: true }), sources: { status: () => native ? status : undefined, displayBasis: () => native ? display : undefined,
      piProjection: () => pi ? {} : undefined, borrowSource: () => ({ text: 'current' }), borrowPiSource: () => ({ text: 'current' }) } },
    visit(_owner, consume) { if (!visit) return false; consume(state.display, { origin: state.paint.origin,
      ranges() { return () => true; }, basis(_key, callback) { callback(text); return true; } }); return true; } };
  return { owner, state, consumer, status, display, set(value) { ({ native = native, pi = pi, text = text, visit = visit } = value); } };
}

test('write capture gate: hidden observations stay out and old owner retirement cannot erase a replacement', async () => {
  const observed = [], gate = createWriteCaptureGate(event => observed.push(event));
  const hidden = {}, oldOwner = {}, replacement = {};
  const hiddenEvent = { call: 'same-call', id: 0, path: 'hidden.ts', revision: 1, publication: 1, status: 'pending', sources: 0 };
  const oldEvent = { call: 'same-call', id: 1, path: 'old.ts', revision: 2, publication: 2, status: 'pending', sources: 1 };
  const replacementEvent = { call: 'same-call', id: 2, path: 'current.ts', revision: 3, publication: 3, status: 'ready', sources: 1 };
  try {
    gate.observe(hiddenEvent, hidden);
    gate.activate('same-call', oldOwner);
    gate.observe(oldEvent, oldOwner);
    gate.activate('same-call', replacement);
    gate.observe(replacementEvent, replacement);
    gate.observe({ ...oldEvent, status: 'failed' }, oldOwner);
    gate.retire('same-call', oldOwner);
    assert.deepEqual(await gate.wait(), [replacementEvent]);
    assert.deepEqual(observed, [oldEvent, replacementEvent]);
  } finally { gate.close(); }
});

test('write capture gate: pausing the current owner removes its pending participant', async () => {
  const gate = createWriteCaptureGate(() => {}), owner = {};
  gate.activate('visible-call', owner);
  const waiting = gate.wait();
  gate.retire('visible-call', owner);
  try { await assert.rejects(waiting, /no observed source-card owners/); }
  finally { gate.close(); }
});

function baselineFixture() {
  const f = fixture();
  delete f.consumer.currentPalette;
  delete f.consumer.inputIdentity;
  f.display.profile = 'baseline-profile';
  f.display.fingerprint = 'baseline-fingerprint';
  delete f.display.palette;
  f.state.input = { palette: 3, mode: 'truecolor' };
  f.state.pi = { paletteRevision: 3 };
  f.state.preparedPalette = 3;
  return f;
}

test('performance readiness: candidate input identity and baseline Pi revision use their own shapes', () => {
  const candidate = fixture();
  assert.equal(candidate.state.input.palette, 3);
  assert.equal(candidate.state.preparedPalette, 'pi:3:truecolor');
  assert.equal(preparedCardReady(candidate.consumer, candidate.owner, 'pi:'), true);
  assert.equal(preparedHistoryPaintOriginCount(candidate.consumer, new Set(['one']), 'pi'), 1);
  candidate.state.preparedPalette = 'pi:2:truecolor';
  assert.equal(preparedCardReady(candidate.consumer, candidate.owner, 'pi:'), false);
  candidate.state.preparedPalette = 'pi:3:truecolor';
  candidate.state.input = undefined;
  assert.equal(preparedCardReady(candidate.consumer, candidate.owner, 'pi:'), false);

  const baseline = baselineFixture();
  assert.equal(Object.hasOwn(baseline.display, 'palette'), false);
  assert.notEqual(baseline.state.input, baseline.state.pi);
  assert.equal(preparedCardReady(baseline.consumer, baseline.owner), true);
  assert.equal(preparedHistoryPaintOriginCount(baseline.consumer, new Set(['one']), 'pi'), 1);
  baseline.state.pi.paletteRevision = 4;
  assert.equal(preparedCardReady(baseline.consumer, baseline.owner), false);
  baseline.state.pi.paletteRevision = 3;
  baseline.state.input = undefined;
  assert.equal(preparedCardReady(baseline.consumer, baseline.owner), false);
});

test('performance readiness: ordinary unprepared states stay unready and mixed collector shapes fail closed', () => {
  const candidate = fixture(); candidate.state.preparedPalette = undefined;
  assert.equal(preparedCardReady(candidate.consumer, candidate.owner, 'pi:'), false);
  const baseline = baselineFixture(); baseline.state.preparedPalette = undefined; baseline.state.pi = undefined;
  assert.equal(preparedCardReady(baseline.consumer, baseline.owner), false);

  const partial = fixture(); delete partial.consumer.inputIdentity;
  assert.throws(() => preparedCardReady(partial.consumer, partial.owner, 'pi:'), /all-or-none pair/);
  const mixedCandidate = fixture(); mixedCandidate.state.preparedPalette = 3;
  assert.throws(() => preparedCardReady(mixedCandidate.consumer, mixedCandidate.owner, 'pi:'), /candidate prepared palette/);
  const mixedBaseline = baselineFixture(); mixedBaseline.state.preparedPalette = 'pi:3:truecolor';
  assert.throws(() => preparedCardReady(mixedBaseline.consumer, mixedBaseline.owner), /numeric revision/);
  const unknown = baselineFixture(); unknown.state.preparedPalette = 3.5;
  assert.throws(() => preparedCardReady(unknown.consumer, unknown.owner), /numeric revision/);
});

test('performance readiness: baseline native-origin readiness cannot satisfy a Pi-origin frame proof', () => {
  const f = baselineFixture(); f.state.paint.origin = 'native'; f.state.preparedPalette = undefined;
  assert.equal(preparedCardReady(f.consumer, f.owner), true);
  assert.equal(preparedHistoryPaintOriginCount(f.consumer, new Set(['one']), 'pi'), 0);
});

test('performance readiness: Pi-origin proof counts every expected history owner', () => {
  const owners = Array.from({ length: 10 }, (_, index) => ({ toolCallId: `tool-${index}` }));
  const states = new WeakMap(), records = new Map();
  owners.forEach((owner, index) => {
    states.set(owner, { paint: { origin: index < 8 ? 'pi' : 'native' } });
    records.set(index, { owner: new WeakRef(owner) });
  });
  const consumer = { states, records }, expectedIds = new Set(owners.map(owner => owner.toolCallId));
  assert.equal(preparedHistoryPaintOriginCount(consumer, expectedIds, 'pi'), 8);
  states.set(owners[8], { paint: { origin: 'pi' } });
  states.set(owners[9], { paint: { origin: 'pi' } });
  assert.equal(preparedHistoryPaintOriginCount(consumer, expectedIds, 'pi'), 10);
});

test('performance readiness: actual completed projection beats historical waiting admission label', () => {
  const f = fixture(); assert.equal(f.state.slots.get('key').outcome, 'waiting');
  assert.equal(preparedCardReady(f.consumer, f.owner, 'pi:'), true);
  assert.equal(preparedHistoryReady(f.consumer, new Set(['one']), 'pi:'), true);
  assert.equal(preparedHistoryReady(f.consumer, new Set(['one', 'missing']), 'pi:'), false);
});

test('performance readiness: source versions, publication text, styles and final owner visit must all match', () => {
  for (const breakReady of [
    f => { f.state.display.revision--; }, f => { f.state.processed--; }, f => { f.state.preparedPalette = 'pi:2'; },
    f => { f.state.preparedTheme--; }, f => { f.status.exact = false; }, f => { f.status.protective = true; },
    f => { f.display.version--; }, f => { f.display.palette = 'theme:other'; },
    f => { f.set({ native: false }); }, f => { f.set({ text: 'older' }); }, f => { f.set({ visit: false }); },
  ]) {
    const f = fixture(); breakReady(f); assert.equal(preparedCardReady(f.consumer, f.owner, 'pi:'), false);
  }
});

test('performance readiness: completed Pi fallback is legitimate but cannot pass as an owned palette', () => {
  const f = fixture(); f.set({ native: false, pi: true }); f.state.slots.get('key').outcome = 'pi';
  assert.equal(preparedCardReady(f.consumer, f.owner, 'pi:'), true);
  assert.equal(preparedCardReady(f.consumer, f.owner, 'theme:other:'), false);
  f.set({ pi: false }); assert.equal(preparedCardReady(f.consumer, f.owner, 'pi:'), false);
});

test('performance readiness: SDK explicit-native-Off neutral Bash is ready, unexpected neutral is not', () => {
  const f = fixture(); f.set({ native: false });
  Object.assign(f.state.slots.get('key'), { fallback: 'neutral', outcome: 'neutral' });
  assert.equal(preparedCardReady(f.consumer, f.owner), false);
  f.consumer.client.snapshot = () => ({ enabled: false });
  assert.equal(preparedCardReady(f.consumer, f.owner), true);
});

test('performance readiness: owned palette readiness is independent of Pi bindings', () => {
  const f = fixture(), palette = 'theme:gruvbox-dark:owned-palette-v1:truecolor';
  f.consumer.selectedPalette = { kind: 'theme', id: 'gruvbox-dark', fingerprint: 'owned-palette-v1' };
  f.state.paint.origin = 'owned'; f.state.paint.group.palette = palette;
  f.state.preparedPalette = 'gruvbox-dark:3:truecolor'; f.display.palette = palette;
  assert.equal(preparedCardReady(f.consumer, f.owner, 'theme:gruvbox-dark:'), true);
  f.display.palette = 'theme:other:owned-palette-v1:truecolor';
  assert.equal(preparedCardReady(f.consumer, f.owner, 'theme:gruvbox-dark:'), false);
});

test('performance readiness waiting: unready polls do not inject full-history render work', async () => {
  let clock = 0, frames = 0, unreadyFrames = 0;
  const result = await waitForPerformanceReady({ now: () => clock, timeoutMs: 30,
    check: () => clock >= 10, frame: async () => { frames++; if (clock < 10) unreadyFrames++; }, pause: async ms => { clock += ms; } });
  assert.equal(result, true); assert.equal(unreadyFrames, 1); assert.equal(frames, 3);
});
test('performance readiness waiting: timeout stays a failure and ready must survive both final frames', async () => {
  let clock = 0, frames = 0;
  assert.equal(await waitForPerformanceReady({ now: () => clock, timeoutMs: 20, check: () => false,
    frame: async () => { frames++; }, pause: async ms => { clock += ms; } }), false);
  assert.equal(frames, 1); assert.equal(clock, 20);
  let checks = 0; clock = 0; frames = 0;
  assert.equal(await waitForPerformanceReady({ now: () => clock, timeoutMs: 20, check: () => ++checks !== 2,
    frame: async () => { frames++; }, pause: async ms => { clock += ms; } }), true);
  assert.equal(frames, 4); assert.ok(checks >= 5);
});
