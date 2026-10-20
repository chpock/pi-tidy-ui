import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { preparedCardReady, preparedHistoryReady, waitForPerformanceReady } from '../../fixtures/performance-readiness.mjs';

function fixture() {
  const owner = { toolCallId: 'one' }, status = { exact: true, protective: false };
  const display = { version: 2, profile: 'pi' }, slot = { version: 2, palette: 3, outcome: 'waiting' };
  let native = true, pi = false, text = 'current', visit = true;
  const state = { revision: 4, display: { revision: 4 }, sourceRevision: 2, processed: 2,
    paint: { origin: 'pi', group: { profile: 'pi' } }, preparedTheme: 5, preparedPalette: 3, pi: { paletteRevision: 3 }, slots: new Map([['key', slot]]) };
  const consumer = { states: new WeakMap([[owner, state]]), themeRevision: 5,
    records: new Map([[1, { owner: new WeakRef(owner) }]]),
    client: { snapshot: () => ({ enabled: true }), sources: { status: () => native ? status : undefined, displayBasis: () => native ? display : undefined,
      piProjection: () => pi ? {} : undefined, borrowSource: () => ({ text: 'current' }), borrowPiSource: () => ({ text: 'current' }) } },
    visit(_owner, consume) { if (!visit) return false; consume(state.display, { origin: state.paint.origin,
      ranges() { return () => true; }, basis(_key, callback) { callback(text); return true; } }); return true; } };
  return { owner, state, consumer, status, display, set(value) { ({ native = native, pi = pi, text = text, visit = visit } = value); } };
}

test('performance readiness: actual completed projection beats historical waiting admission label', () => {
  const f = fixture(); assert.equal(f.state.slots.get('key').outcome, 'waiting');
  assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), true);
  assert.equal(preparedHistoryReady(f.consumer, new Set(['one']), 'pi'), true);
  assert.equal(preparedHistoryReady(f.consumer, new Set(['one', 'missing']), 'pi'), false);
});

test('performance readiness: source versions, publication text, styles and final owner visit must all match', () => {
  for (const breakReady of [
    f => { f.state.display.revision--; }, f => { f.state.processed--; }, f => { f.state.preparedPalette--; },
    f => { f.state.preparedTheme--; }, f => { f.status.exact = false; }, f => { f.status.protective = true; },
    f => { f.display.version--; }, f => { f.display.profile = 'other'; },
    f => { f.set({ native: false }); }, f => { f.set({ text: 'older' }); }, f => { f.set({ visit: false }); },
  ]) {
    const f = fixture(); breakReady(f); assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), false);
  }
});

test('performance readiness: completed Pi fallback is legitimate but cannot pass as a native palette', () => {
  const f = fixture(); f.set({ native: false, pi: true }); f.state.slots.get('key').outcome = 'pi';
  assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), true);
  assert.equal(preparedCardReady(f.consumer, f.owner, 'syntect:theme'), false);
  f.set({ pi: false }); assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), false);
});

test('performance readiness: SDK explicit-native-Off neutral Bash is ready, unexpected neutral is not', () => {
  const f = fixture(); f.set({ native: false });
  Object.assign(f.state.slots.get('key'), { fallback: 'neutral', outcome: 'neutral' });
  assert.equal(preparedCardReady(f.consumer, f.owner), false);
  f.consumer.client.snapshot = () => ({ enabled: false });
  assert.equal(preparedCardReady(f.consumer, f.owner), true);
});

test('performance readiness: native palette readiness is independent of a released Pi binding owner', () => {
  const f = fixture(); f.state.paint.origin = 'native'; f.state.pi = undefined;
  assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), true);
  f.display.profile = 'other'; assert.equal(preparedCardReady(f.consumer, f.owner, 'pi'), false);
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
