import { createEventRecorder } from './terminal-output.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { debugLoggingDiagnostics } from '../../src/index.ts';
import presentationDriver from './presentation-driver.ts';
import syntaxDriver from './syntax-driver.ts';
import { SyntaxRuntime } from '../../src/syntax/runtime.ts';
import { SyntaxClient } from '../../src/occipital/client.ts';
import { registerCaptureProducer } from './terminal-capture.mjs';

/** The shortcut changes neither draft nor transcript. It requests a real frame
 * and samples primitive logger counters, without flushing the journal. */
export default function loggingDriver(pi: ExtensionAPI) {
  if (process.env.TIDY_UI_TEST_LOGGING_NATIVE === '1') syntaxDriver(pi);
  else {
    let runtime: WeakRef<SyntaxRuntime> | undefined, client: WeakRef<SyntaxClient> | undefined, stopCapture: (() => void) | undefined;
    const attach = SyntaxRuntime.prototype.attach, start = SyntaxClient.prototype.start;
    const sample = () => {
      const current = runtime?.deref();
      return { node: process.version, client: current?.snapshot(), source: current?.sources.stats(), logging: debugLoggingDiagnostics() };
    };
    function attachWithCapture(this: SyntaxRuntime, ...args: Parameters<SyntaxRuntime['attach']>) {
      if (runtime?.deref() !== this) {
        stopCapture?.(); stopCapture = undefined; client = undefined; runtime = new WeakRef(this);
      }
      return attach.apply(this, args);
    }
    function startWithCapture(this: SyntaxClient, ...args: Parameters<SyntaxClient['start']>) {
      const result = start.apply(this, args);
      if (runtime?.deref()?.sources === this.sources && client?.deref() !== this) {
        stopCapture?.(); client = new WeakRef(this); stopCapture = registerCaptureProducer(this, sample);
      }
      return result;
    }
    SyntaxRuntime.prototype.attach = attachWithCapture; SyntaxClient.prototype.start = startWithCapture;
    pi.on('session_shutdown', () => {
      stopCapture?.(); stopCapture = undefined; runtime = undefined; client = undefined;
      if (SyntaxRuntime.prototype.attach === attachWithCapture) SyntaxRuntime.prototype.attach = attach;
      if (SyntaxClient.prototype.start === startWithCapture) SyntaxClient.prototype.start = start;
    });
    presentationDriver(pi);
  }
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let tui: TUI | undefined, sequence = 0, pending = 0;
  const record = createEventRecorder(output);
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
