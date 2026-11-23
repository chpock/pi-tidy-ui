// Test-only private shape checks. No range walk, retained source copy or render hook.
import assert from 'node:assert/strict';

// Old frozen graphs have a numeric Pi revision; later graphs carry the full input identity.
// Keep their private shape adapters separate and fail closed on incomplete mixtures.
function paletteObservation(consumer) {
  const hasCurrentPalette = Reflect.has(consumer, 'currentPalette');
  const hasInputIdentity = Reflect.has(consumer, 'inputIdentity');
  assert.equal(hasCurrentPalette, hasInputIdentity, 'benchmark palette-input methods must be an all-or-none pair');
  if (Reflect.has(consumer, 'paletteSelection')) {
    assert.equal(hasCurrentPalette || Reflect.has(consumer, 'themeRevision'), false, 'mixed benchmark palette-owner shapes');
    const selection = Reflect.get(consumer, 'paletteSelection');
    assert.ok(selection && typeof selection.effective === 'function' && typeof selection.inputKey === 'function'
      && Number.isSafeInteger(selection.revision), 'benchmark selection owner exposes its actual revision and input identity');
    return { theme: selection.revision, inputKey: state => selection.inputKey(selection.effective(state.input, state.paletteFallback), state.input) };
  }
  const theme = Reflect.get(consumer, 'themeRevision');
  if (!hasCurrentPalette) return { theme };
  const current = Reflect.get(consumer, 'currentPalette'), identity = Reflect.get(consumer, 'inputIdentity');
  assert.equal(typeof current, 'function', 'benchmark current-palette observation contract');
  assert.equal(typeof identity, 'function', 'benchmark palette-input identity observation contract');
  return { theme, inputKey: state => Reflect.apply(identity, consumer, [Reflect.apply(current, consumer, [state]), state.input]) };
}

function paletteInputObservation({ inputKey }, state) {
  if (!state.input) return { matches: false };
  if (inputKey) {
    if (state.preparedPalette === undefined) return { matches: false };
    assert.equal(typeof state.preparedPalette, 'string', 'candidate prepared palette must be a string identity');
    const expected = inputKey(state);
    assert.equal(typeof expected, 'string', 'benchmark palette-input identity must be a string');
    return { current: expected, matches: state.preparedPalette === expected };
  }
  const current = state.pi?.paletteRevision;
  if (state.preparedPalette !== undefined) assert.ok(Number.isSafeInteger(state.preparedPalette), 'baseline prepared palette must be a numeric revision');
  const native = state.paint?.origin === 'native';
  if (native || state.preparedPalette === undefined) return { current, matches: native };
  assert.equal(state.paint?.origin, 'pi', 'baseline completed palette must use Pi or native paint');
  return { current, matches: Number.isSafeInteger(current) && state.preparedPalette === current };
}

function sourceMatches({ inputKey }, state) {
  if (!inputKey) return Number.isSafeInteger(state.processed) && state.processed === state.sourceRevision;
  if (typeof state.processed !== 'string') return false;
  const input = state.input;
  if (!input || (input.kind !== 'file' && input.kind !== 'bash')) return false;
  const view = input.kind === 'file' ? input.viewMode ?? 'full' : 'bash';
  return state.processed === `${state.sourceRevision}:${view}`;
}

export function preparedCardReady(consumer, owner, palettePrefix) {
  const states = Reflect.get(consumer, 'states');
  assert.ok(states instanceof WeakMap, 'benchmark prepared-source observation contract');
  const state = states.get(owner);
  if (!state?.display || !state.paint || state.display.revision !== state.revision) return false;
  const palette = paletteObservation(consumer);
  if (!sourceMatches(palette, state) || state.preparedTheme !== palette.theme) return false;
  const mode = state.input?.mode;
  if (mode === undefined || !paletteInputObservation(palette, state).matches) return false;
  const client = Reflect.get(consumer, 'client'), sources = client.sourceWork ?? client.sources;
  const piFallback = client.pi ?? sources, wanted = new Map();
  for (const [key, slot] of state.slots) {
    const current = sources.status(key), display = sources.displayBasis(key);
    const classified = current?.exact && !current.protective && display
      && (display.exactVersion === slot.version || display.version === slot.version)
      && (!palettePrefix || display.palette.startsWith(palettePrefix));
    const projection = (!palettePrefix || palettePrefix === 'pi:') && piFallback.piProjection(key, slot.version, slot.palette);
    const neutral = slot.fallback === 'neutral' && slot.outcome === 'neutral' && client.snapshot().enabled === false;
    if (!classified && !projection && !neutral) return false;
    wanted.set(key, { classified: !!classified, neutral, text: neutral ? undefined : (classified ? sources.borrowSource(key) : piFallback.borrowPiSource(key))?.text });
  }
  let accepted = false;
  return consumer.visit(owner, (_display, paint) => {
    // A failed replacement may leave the previous paint valid to read.
    if (paint.mode !== mode) return;
    accepted = !palettePrefix || (palettePrefix === 'pi:' ? paint.origin === 'pi'
      : paint.origin === 'owned' && state.paint.groupStamp !== undefined && state.paint.palette.startsWith(palettePrefix));
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
  const palette = paletteObservation(consumer);
  return [...Reflect.get(consumer, 'records').values()].flatMap(ticket => {
    const owner = ticket.owner.deref(), state = ticket.state.deref();
    if (!owner || !expectedIds.has(owner.toolCallId) || !state) return [];
    return [{ id: owner.toolCallId, paused: state.paused, useful: state.useful, frozen: state.frozen, paint: state.paint?.origin, revision: [state.display?.revision, state.revision],
      source: [state.processed, state.sourceRevision], theme: [state.preparedTheme, palette.theme],
      palette: [state.preparedPalette, paletteInputObservation(palette, state).current, state.paint?.groupStamp !== undefined ? state.paint.palette : undefined], slots: [...state.slots.values()].map(slot => slot.outcome) }];
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
