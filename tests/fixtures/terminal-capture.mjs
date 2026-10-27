const key = Symbol.for('pi-tidy-ui.test.terminal-capture');

export function terminalCaptureBridge() {
  return globalThis[key] ??= { producer: undefined, changed: undefined };
}

export function registerCaptureProducer(owner, sample) {
  const bridge = terminalCaptureBridge();
  const producer = { owner: new WeakRef(owner), sample };
  bridge.producer = producer;
  bridge.changed?.();
  return () => {
    if (bridge.producer !== producer) return;
    bridge.producer = undefined;
    bridge.changed?.();
  };
}

export function captureChanged(owner, schedule) {
  return () => { const value = owner.deref(); if (value) schedule(value); };
}

export function producerCompletion(owner, slot, rejected = false) {
  return result => {
    const value = owner.deref();
    if (value?.sourceSlot !== slot) return;
    slot.done = true; slot.result = rejected ? false : result;
    if (rejected) slot.error = String(result);
    value.capture.changed?.();
  };
}
