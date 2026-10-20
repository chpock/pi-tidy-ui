// Test-only private shape checks. No range walk, retained source copy or render hook.
import assert from 'node:assert/strict';

export function preparedCardReady(consumer, owner, profile) {
  const states = Reflect.get(consumer, 'states');
  assert.ok(states instanceof WeakMap, 'benchmark prepared-source observation contract');
  const state = states.get(owner);
  if (!state?.display || !state.paint || state.display.revision !== state.revision
    || state.processed !== state.sourceRevision || state.preparedTheme !== Reflect.get(consumer, 'themeRevision')
    || state.paint.origin === 'pi' && state.preparedPalette !== state.pi?.paletteRevision) return false;
  const client = Reflect.get(consumer, 'client'), sources = client.sources, wanted = new Map();
  for (const [key, slot] of state.slots) {
    const current = sources.status(key), display = sources.displayBasis(key);
    const native = current?.exact && !current.protective && display
      && (display.exactVersion === slot.version || display.version === slot.version) && (!profile || display.profile === profile);
    const pi = (!profile || profile === 'pi') && sources.piProjection(key, slot.version, slot.palette);
    const neutral = slot.fallback === 'neutral' && slot.outcome === 'neutral' && client.snapshot().enabled === false;
    if (!native && !pi && !neutral) return false;
    wanted.set(key, { native: !!native, neutral, text: neutral ? undefined : (native ? sources.borrowSource(key) : sources.borrowPiSource(key))?.text });
  }
  let accepted = false;
  return consumer.visit(owner, (_display, paint) => {
    accepted = !profile || (paint.origin === 'native' ? state.paint.group?.profile === profile : profile === 'pi');
    for (const [key, expected] of wanted) {
      if (expected.neutral) continue;
      if (!expected.native) { if (!paint.ranges(key)) accepted = false; continue; }
      let exact = false;
      if (typeof expected.text !== 'string' || !paint.basis(key, text => { exact = text === expected.text; }) || !exact) accepted = false;
    }
  }) && accepted;
}

export function preparedHistoryReady(consumer, expectedIds, profile) {
  const records = Reflect.get(consumer, 'records');
  assert.ok(records instanceof Map, 'benchmark prepared-source registry contract');
  const found = new Set();
  for (const ticket of records.values()) {
    const owner = ticket.owner.deref();
    if (!owner || !expectedIds.has(owner.toolCallId)) continue;
    if (!preparedCardReady(consumer, owner, profile)) return false;
    found.add(owner.toolCallId);
  }
  return found.size === expectedIds.size;
}

export function explainPreparedHistory(consumer, expectedIds) {
  return [...Reflect.get(consumer, 'records').values()].flatMap(ticket => {
    const owner = ticket.owner.deref(), state = ticket.state.deref();
    if (!owner || !expectedIds.has(owner.toolCallId) || !state) return [];
    return [{ id: owner.toolCallId, paused: state.paused, useful: state.useful, frozen: state.frozen, paint: state.paint?.origin, revision: [state.display?.revision, state.revision],
      source: [state.processed, state.sourceRevision], theme: [state.preparedTheme, Reflect.get(consumer, 'themeRevision')],
      palette: [state.preparedPalette, state.pi?.paletteRevision], slots: [...state.slots.values()].map(slot => slot.outcome) }];
  }).slice(0, 8);
}

/** Let normal source-change invalidations run; do not inject full-history frames on every poll. */
export async function waitForPerformanceReady({ frame, check, pause, now = () => performance.now(), timeoutMs = 30000 }) {
  const deadline = now() + timeoutMs;
  await frame();
  while (now() < deadline) {
    if (check()) {
      await frame();
      if (check()) {
        await frame();
        if (check()) return true;
      }
    }
    await pause(5);
  }
  return false;
}
