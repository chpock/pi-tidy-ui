import assert from 'node:assert/strict';

function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

export function createSyntaxStockReferences(executeStock) {
  const references = new Map();
  return mode => {
    if (!references.has(mode)) {
      references.set(mode, Promise.resolve().then(() => executeStock(mode)).then(({ traffic, persisted, output }) =>
        freezeEvidence(structuredClone({ traffic, persisted, output }))));
    }
    return references.get(mode);
  };
}

export function assertSyntaxStockReference(reference, actual) {
  assert.deepEqual(actual.traffic, reference.traffic, `exact stock traffic: ${reference.output}`);
  assert.deepEqual(actual.persisted, reference.persisted, `exact stock persisted data: ${reference.output}`);
}
