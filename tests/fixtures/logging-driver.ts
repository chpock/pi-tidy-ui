import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { debugLoggingDiagnostics } from '../../src/index.ts';
import presentationDriver from './presentation-driver.ts';
import syntaxDriver from './syntax-driver.ts';

/** The shortcut changes neither draft nor transcript. It requests a real frame
 * and samples primitive logger counters, without flushing the journal. */
export default function loggingDriver(pi: ExtensionAPI) {
  if (process.env.TIDY_UI_TEST_LOGGING_NATIVE === '1') syntaxDriver(pi);
  else presentationDriver(pi);
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let tui: TUI | undefined, sequence = 0, pending = 0;
  const record = (event: unknown) => appendFileSync(join(output, 'events.jsonl'), JSON.stringify(event) + '\n');
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setWidget('logging-test-probe', live => {
      tui = live;
      return { render() {
        if (pending) {
          const id = pending; pending = 0;
          queueMicrotask(() => record({ type: 'logging_frame', id, logging: debugLoggingDiagnostics() }));
        }
        return [];
      }, invalidate() {} };
    });
  });
  pi.registerShortcut('ctrl+alt+l', { description: 'Request a real frame and sample isolated logger counters', handler: async () => {
    pending = ++sequence; tui?.requestRender();
  } });
  if (process.env.TIDY_UI_TEST_LOGGING_CANCEL === '1') pi.on('session_before_switch', () => {
    record({ type: 'logging_cancelled_switch' }); return { cancel: true };
  });
  pi.on('session_shutdown', () => {
    record({ type: 'logging_shutdown', logging: debugLoggingDiagnostics() });
    tui = undefined;
  });
}
