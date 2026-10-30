// Test-only private shape checks. No range walk, retained source copy or render hook.
import assert from 'node:assert/strict';

// B's frozen baseline stores a numeric Pi palette revision; the candidate stores
// the full input identity. This adapter is test-only and rejects mixed shapes.
function paletteInputObservation(consumer, state) {
  const hasCurrentPalette = Reflect.has(consumer, 'currentPalette');
  const hasInputIdentity = Reflect.has(consumer, 'inputIdentity');
  assert.equal(hasCurrentPalette, hasInputIdentity, 'benchmark palette-input methods must be an all-or-none pair');
  if (!state.input) return { kind: hasCurrentPalette ? 'identity' : 'revision', current: undefined, matches: false };

  if (hasCurrentPalette) {
    const currentPalette = Reflect.get(consumer, 'currentPalette'), inputIdentity = Reflect.get(consumer, 'inputIdentity');
    assert.equal(typeof currentPalette, 'function', 'benchmark current-palette observation contract');
    assert.equal(typeof inputIdentity, 'function', 'benchmark palette-input identity observation contract');
    if (state.preparedPalette === undefined) return { kind: 'identity', current: undefined, matches: false };
    assert.equal(typeof state.preparedPalette, 'string', 'candidate prepared palette must be a string identity');
    const expected = Reflect.apply(inputIdentity, consumer, [Reflect.apply(currentPalette, consumer, [state]), state.input]);
    assert.equal(typeof expected, 'string', 'benchmark palette-input identity must be a string');
    return { kind: 'identity', current: expected, matches: state.preparedPalette === expected };
  }

  if (state.preparedPalette === undefined) {
    return { kind: 'revision', current: state.pi?.paletteRevision, matches: state.paint?.origin === 'native' };
  }
  assert.ok(Number.isSafeInteger(state.preparedPalette), 'baseline prepared palette must be a numeric revision');
  if (state.paint?.origin === 'native') return { kind: 'revision', current: state.pi?.paletteRevision, matches: true };
  assert.equal(state.paint?.origin, 'pi', 'baseline completed palette must use Pi or native paint');
  const current = state.pi?.paletteRevision;
  return { kind: 'revision', current, matches: Number.isSafeInteger(current) && state.preparedPalette === current };
}

export function preparedCardReady(consumer, owner, palettePrefix) {
  const states = Reflect.get(consumer, 'states');
  assert.ok(states instanceof WeakMap, 'benchmark prepared-source observation contract');
  const state = states.get(owner);
  if (!state?.display || !state.paint || state.display.revision !== state.revision
    || state.processed !== state.sourceRevision || state.preparedTheme !== Reflect.get(consumer, 'themeRevision')) return false;
  if (!paletteInputObservation(consumer, state).matches) return false;
  const client = Reflect.get(consumer, 'client'), sources = client.sources, wanted = new Map();
  for (const [key, slot] of state.slots) {
    const current = sources.status(key), display = sources.displayBasis(key);
    const classified = current?.exact && !current.protective && display
      && (display.exactVersion === slot.version || display.version === slot.version)
      && (!palettePrefix || display.palette.startsWith(palettePrefix));
    const pi = (!palettePrefix || palettePrefix === 'pi:') && sources.piProjection(key, slot.version, slot.palette);
    const neutral = slot.fallback === 'neutral' && slot.outcome === 'neutral' && client.snapshot().enabled === false;
    if (!classified && !pi && !neutral) return false;
    wanted.set(key, { classified: !!classified, neutral, text: neutral ? undefined : (classified ? sources.borrowSource(key) : sources.borrowPiSource(key))?.text });
  }
  let accepted = false;
  return consumer.visit(owner, (_display, paint) => {
    accepted = !palettePrefix || (palettePrefix === 'pi:' ? paint.origin === 'pi'
      : paint.origin === 'owned' && state.paint.group?.palette.startsWith(palettePrefix));
    for (const [key, expected] of wanted) {
      if (expected.neutral) continue;
      if (!expected.classified) { if (!paint.ranges(key)) accepted = false; continue; }
      let exact = false;
      if (typeof expected.text !== 'string' || !paint.basis(key, text => { exact = text === expected.text; }) || !exact) accepted = false;
    }
  }) && accepted;
}

export function preparedHistoryReady(consumer, expectedIds, palettePrefix) {
  const records = Reflect.get(consumer, 'records');
  assert.ok(records instanceof Map, 'benchmark prepared-source registry contract');
  const found = new Set();
  for (const ticket of records.values()) {
    const owner = ticket.owner.deref();
    if (!owner || !expectedIds.has(owner.toolCallId)) continue;
    if (!preparedCardReady(consumer, owner, palettePrefix)) return false;
    found.add(owner.toolCallId);
  }
  return found.size === expectedIds.size;
}

export function preparedHistoryPaintOriginCount(consumer, expectedIds, origin) {
  const states = Reflect.get(consumer, 'states'), records = Reflect.get(consumer, 'records');
  assert.ok(states instanceof WeakMap, 'benchmark prepared-source observation contract');
  assert.ok(records instanceof Map, 'benchmark prepared-source registry contract');
  const observed = new Map();
  for (const ticket of records.values()) {
    const owner = ticket.owner.deref();
    if (!owner || !expectedIds.has(owner.toolCallId)) continue;
    observed.set(owner.toolCallId, states.get(owner)?.paint?.origin);
  }
  let count = 0;
  for (const id of expectedIds) if (observed.get(id) === origin) count++;
  return count;
}

export function explainPreparedHistory(consumer, expectedIds) {
  return [...Reflect.get(consumer, 'records').values()].flatMap(ticket => {
    const owner = ticket.owner.deref(), state = ticket.state.deref();
    if (!owner || !expectedIds.has(owner.toolCallId) || !state) return [];
    return [{ id: owner.toolCallId, paused: state.paused, useful: state.useful, frozen: state.frozen, paint: state.paint?.origin, revision: [state.display?.revision, state.revision],
      source: [state.processed, state.sourceRevision], theme: [state.preparedTheme, Reflect.get(consumer, 'themeRevision')],
      palette: [state.preparedPalette, state.input ? paletteInputObservation(consumer, state).current : undefined, state.paint?.group?.palette], slots: [...state.slots.values()].map(slot => slot.outcome) }];
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
