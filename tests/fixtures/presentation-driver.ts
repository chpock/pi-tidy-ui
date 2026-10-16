// Generic UI controls exercise safe fallback without external services or downloads.
// Native integration and clean installed-package controls use their own providers.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../src/index.ts';
import { createSyntaxOptions } from '../../src/occipital/bootstrap.ts';

export default function presentationDriver(pi: ExtensionAPI) {
  return tidyUi(pi, { syntax(ctx) {
    const options = createSyntaxOptions(ctx);
    return { ...options, provider: {
      async tryShared() { return undefined; },
      async acquireOwned() { throw Error('Native transport is unavailable in this offline presentation control.'); },
    } };
  } });
}
