if (process.env.TIDY_NATIVE_TEST_CONTEXT_READY !== '1' || !process.env.TIDY_NATIVE_TEST_INPUTS ||
    globalThis[Symbol.for('pi-tidy-ui.native-test-context')] !== true) {
  throw new Error('Native-build tests require a fresh isolated Node context: use scripts/test/native-harness.mjs --inputs /absolute/path/native-inputs.json');
}
