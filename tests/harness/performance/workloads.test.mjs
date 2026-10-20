import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT, definitions, parameters, plan, trialOrder, history, sessionText } from '../../../scripts/test/performance/workloads.mjs';

test('performance workloads: finite declared profiles, strict selectors and bounded parameters', () => {
  for (const profile of ['quick', 'standard', 'extended']) {
    const selected = plan({ profile }); assert.ok(selected.length > 0);
    assert.equal(new Set(selected.map(value => value.hash)).size, selected.length);
    for (const value of selected) {
      assert.equal(CONTRACT, 'pi-tidy-ui-performance/v1'); assert.match(value.hash, /^[a-f\d]{64}$/);
      assert.ok(['sdk', 'cli'].includes(value.driver)); assert.ok(['native', 'off', 'on'].includes(value.variant));
      assert.ok(value.parameters.cards <= 3000);
    }
  }
  assert.throws(() => plan({ profile: 'fast-ish' }), /profile/);
  assert.throws(() => plan({ cases: ['missing'] }), /case/);
  assert.throws(() => plan({ cases: ['frames', 'frames'] }), /cases/);
  assert.throws(() => plan({ selectedVariants: ['enabled'] }), /variant/);
  assert.throws(() => parameters({ iterations: 0 }), /iterations/);
  assert.throws(() => parameters({ cards: 3001 }), /cards/);
  assert.throws(() => parameters({ seed: NaN }), /seed/);
  assert.throws(() => parameters({ width: Infinity }), /width/);
  assert.throws(() => parameters({ hiddenOption: 1 }), /parameters/);
  assert.throws(() => trialOrder(plan({ cases: ['render'] }), 0), /repetitions/);
});

test('performance workloads: explicit size replaces profile sizes without duplicate scenarios', () => {
  const selected = plan({ profile: 'standard', cases: ['frames'], overrides: { cards: 42 } });
  assert.equal(selected.length, 3); assert.ok(selected.every(value => value.parameters.cards === 42));
  const normal = plan({ profile: 'standard', cases: ['frames'] });
  assert.equal(normal.length, 9); assert.deepEqual([...new Set(normal.map(value => value.parameters.cards))], [10, 100, 1000]);
  const rows = plan({ profile: 'extended', cases: ['frames'], selectedVariants: ['on'] });
  assert.deepEqual(rows.map(value => value.parameters.cards), [10, 100, 1000, 3000]);
});

test('performance workloads: deterministic content identities and balanced serial trial order', () => {
  const selected = plan({ cases: ['frames'], selectedVariants: ['native', 'off', 'on'] });
  assert.deepEqual(plan({ cases: ['frames'], selectedVariants: ['native', 'off', 'on'] }), selected);
  const order = trialOrder(selected, 3);
  assert.equal(order.length, selected.length * 3);
  assert.deepEqual(order.filter(value => value.repetition === 0).map(value => value.scenario.variant), ['native', 'off', 'on']);
  assert.deepEqual(order.filter(value => value.repetition === 1).map(value => value.scenario.variant), ['on', 'off', 'native']);
  assert.deepEqual(order.filter(value => value.repetition === 2).map(value => value.scenario.variant), ['native', 'off', 'on']);
  assert.notEqual(plan({ cases: ['frames'], overrides: { seed: 18 } })[0].hash, selected[0].hash);
  assert.equal(new Set(definitions.map(value => value.id)).size, definitions.length);
  assert.ok(definitions.some(value => value.id === 'lifetime'));
  assert.ok(definitions.some(value => value.id === 'syntax'));
});

test('performance workloads: synthetic mixed messages are deterministic, complete and Unicode-capable', () => {
  const p = parameters({ cards: 8, seed: 17, unicode: true });
  const first = history(p), second = history(p);
  assert.deepEqual(first, second); assert.equal(first.messages.length, 24);
  const assistant = first.messages.filter(value => value.role === 'assistant');
  const results = first.messages.filter(value => value.role === 'toolResult');
  const ids = assistant.flatMap(value => value.content.filter(item => item.type === 'toolCall').map(item => item.id));
  assert.equal(ids.length, 8); assert.deepEqual(results.map(value => value.toolCallId), ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(results.every(value => value.isError === false));
  assert.ok(JSON.stringify(first).includes('界'));
  assert.deepEqual([...new Set(results.map(value => value.toolName))].sort(), ['bash', 'edit', 'read', 'write']);
  assert.throws(() => history({ ...p, cards: 0 }), /cards/);
  assert.notDeepEqual(history({ ...p, seed: 18 }), first);
});

test('performance workloads: saved sessions preserve the exact parent chain, messages and fixed metadata', () => {
  const p = parameters({ cards: 3 }), { messages } = history(p), lines = sessionText(p, '/synthetic-performance-workload').trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'session'); assert.equal(lines[0].version, 3);
  assert.equal(lines[0].cwd, '/synthetic-performance-workload');
  assert.equal(lines.length, messages.length + 1);
  assert.deepEqual(lines.slice(1).map(value => value.message), messages);
  assert.equal(lines[1].parentId, null);
  for (let index = 2; index < lines.length; index++) assert.equal(lines[index].parentId, lines[index - 1].id);
  assert.throws(() => sessionText(p, 'relative-workspace'), /absolute workspace/);
  assert.equal(sessionText(p, '/synthetic-performance-workload'), sessionText(p, '/synthetic-performance-workload'));
});
