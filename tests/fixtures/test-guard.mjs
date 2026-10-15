if (process.env.TIDY_TEST_CONTEXT_READY !== '1' || !process.env.TIDY_TEST_INPUTS) {
  throw new Error('Tests require a fresh isolated process: use npm test -- --inputs /absolute/path/inputs.json (prepare with npm run test:prepare first)');
}

if (typeof global.gc !== 'function') {
  throw new Error('GC ownership checks require --expose-gc; launch repository tests through scripts/test/run.mjs');
}
