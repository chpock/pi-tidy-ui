import { watch } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RuntimeHealth } from '../../src/runtime-health.ts';
import { createEventRecorder } from './terminal-output.ts';
import presentationDriver from './presentation-driver.ts';

// Drive a real health transition without sending terminal input or asking Pi for a frame.
export default function liveStatusDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!, record = createEventRecorder(output);
  const scope = {}, operation = 'test_status', sink = RuntimeHealth.prototype.sink;
  let watcher: ReturnType<typeof watch> | undefined;
  function capture(this: RuntimeHealth, ...args: Parameters<RuntimeHealth['sink']>) {
    RuntimeHealth.prototype.sink = sink;
    const result = sink.apply(this, args);
    this.event({ kind: 'failure', area: 'settings', code: 'settings_read', scope, operation });
    watcher = watch(output, (_event, name) => {
      if (name !== 'status-recover') return;
      watcher?.close(); watcher = undefined;
      this.event({ kind: 'recovered', scope, operation });
      record({ type: 'status_recovered' });
    });
    record({ type: 'status_failed' });
    return result;
  }
  RuntimeHealth.prototype.sink = capture;
  pi.on('session_shutdown', () => {
    watcher?.close();
    if (RuntimeHealth.prototype.sink === capture) RuntimeHealth.prototype.sink = sink;
  });
  return presentationDriver(pi);
}
