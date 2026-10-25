import assert from 'node:assert/strict';

function currentInputs(events) {
  const inputs = new Map();
  for (const event of events) if (event.type === 'card_preparation' && event.phase === 'updated') inputs.set(event.call, event);
  return inputs;
}

export function selectPreparations(events, { tool, count }) {
  const selected = [...currentInputs(events).values()].filter(event => event.tool === tool && event.sourceEligible);
  assert.equal(selected.length, count, `Expected ${count} actual ${tool} source updates`);
  return selected.map(({ call, update }) => ({ call, update }));
}

export function completedPreparations(events, selection) {
  const inputs = currentInputs(events), completed = new Map();
  for (const event of events) if (event.type === 'card_preparation' && event.phase === 'prepared') completed.set(event.call, event);
  const results = [];
  for (const selected of selection) {
    assert.equal(inputs.get(selected.call)?.update, selected.update, 'Card input changed during capture');
    const result = completed.get(selected.call);
    if (!result || result.update !== selected.update) return;
    assert.equal(result.refused, 0, 'Card source admission refused');
    const failed = result.outcomes.find(outcome => ['failed', 'refused', 'stale'].includes(outcome));
    assert.equal(failed, undefined, `Card preparation ${failed}`);
    if (!result.outcomes.every(outcome => outcome === 'pi')) return;
    assert.equal(result.applied, true, 'Card paint application failed');
    assert.ok(result.publication, 'Card paint publication is missing');
    results.push(result);
  }
  return results;
}
