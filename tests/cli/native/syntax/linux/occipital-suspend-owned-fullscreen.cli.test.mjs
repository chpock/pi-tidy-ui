import '../../../../fixtures/test-guard.mjs';
import test from 'node:test';
import { prepareSyntaxNative, runSuspendCase, suspendOperations } from '../../../../fixtures/occipital-suspend.mjs';

const prepared = await prepareSyntaxNative();
test('Occipital deliberate suspend recovery: owned, fullscreen (Linux stopped-helper evidence)', { timeout: 180000 }, async suite => {
  for (const operation of suspendOperations) {
    await suite.test(`Occipital pending ${operation}: owned, fullscreen past deadline during Ctrl+Z`, { timeout: 45000 },
      () => runSuspendCase({ kind: 'owned', mode: 'fullscreen', operation }, prepared));
  }
});
