// Generic UI controls exercise safe fallback without external services or downloads.
// Native integration and clean installed-package controls use their own providers.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../src/index.ts';
import { createSyntaxOptions } from '../../src/occipital/bootstrap.ts';
import { ExpectedOwnedUnavailable } from '../../src/occipital/owned-startup.ts';
import { createWriteCaptureGate, observeSyntaxCards } from './syntax-local-work.ts';
import { createEventRecorder } from './terminal-output.ts';

export default function presentationDriver(pi: ExtensionAPI) {
  if (process.env.TIDY_UI_TEST_WRITE_CAPTURE === '1') {
    const record = createEventRecorder(process.env.TIDY_UI_TEST_OUTPUT!);
    const gate = createWriteCaptureGate(event => record({ type: 'write_source_state', ...event }));
    const observer = observeSyntaxCards(() => {}, { writeCapture: event => gate.observe(event) });
    pi.on('session_shutdown', () => { observer.restore(); gate.close(); });
    pi.registerCommand('tidy-ui-write-ready', {
      description: 'Await observed current write source publication without requesting work',
      handler: async name => { const calls = await gate.wait(); record({ type: 'write_capture_ready', name, calls }); },
    });
  }
  return tidyUi(pi, { syntax(ctx) {
    const options = createSyntaxOptions(ctx);
    return { ...options, provider: {
      async tryShared() { return undefined; },
      async acquireOwned() { throw new ExpectedOwnedUnavailable(); },
    } };
  } });
}
