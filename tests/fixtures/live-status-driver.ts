import { watch } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RuntimeHealth } from '../../src/runtime-health.ts';
import { debugLoggingDiagnostics } from '../../src/application/diagnostic-session.ts';
import { createEventRecorder } from './terminal-output.ts';
import presentationDriver from './presentation-driver.ts';

// Drive a real health transition or journal record without asking Pi for a frame.
export default function liveStatusDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!, record = createEventRecorder(output);
  const scope = {}, operation = 'test_status', sink = RuntimeHealth.prototype.sink;
  const logs = process.env.TIDY_UI_TEST_LIVE_LOGS === '1';
  let watcher: ReturnType<typeof watch> | undefined;
  function capture(this: RuntimeHealth, ...args: Parameters<RuntimeHealth['sink']>) {
    RuntimeHealth.prototype.sink = sink;
    const result = sink.apply(this, args);
    if (!logs) this.event({ kind: 'failure', area: 'settings', code: 'settings_read', scope, operation });
    watcher = watch(output, (_event, name) => {
      if (name !== (logs ? 'logs-record' : 'status-recover')) return;
      watcher?.close(); watcher = undefined;
      if (logs) {
        const before = debugLoggingDiagnostics();
        result('INFO', 'test', 'Controlled live journal record');
        record({ type: 'logs_recorded', before });
      } else {
        this.event({ kind: 'recovered', scope, operation });
        record({ type: 'status_recovered' });
      }
    });
    record({ type: logs ? 'logs_watching' : 'status_failed' });
    return result;
  }
  RuntimeHealth.prototype.sink = capture;
  pi.on('session_shutdown', () => {
    watcher?.close();
    if (RuntimeHealth.prototype.sink === capture) RuntimeHealth.prototype.sink = sink;
  });
  return presentationDriver(pi);
}
