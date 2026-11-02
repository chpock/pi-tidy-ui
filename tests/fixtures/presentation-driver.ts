// Generic UI controls exercise safe fallback without external services or downloads.
// Native integration and clean installed-package controls use their own providers.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../src/index.ts';
import { DeferredRenderer } from '../../src/syntax/lazy-native-renderers.ts';
import { createSyntaxOptions } from '../../src/occipital/bootstrap.ts';
import { ExpectedOwnedUnavailable } from '../../src/occipital/owned-startup.ts';
import { createWriteCaptureGate, observeSyntaxCards } from './syntax-local-work.ts';
import { createEventRecorder } from './terminal-output.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const nativePreparationObserver = Symbol.for('tidy-ui-test:deferred-native-original');

export default function presentationDriver(pi: ExtensionAPI) {
  if (process.env.TIDY_UI_TEST_WRITE_CAPTURE === '1') {
    const record = createEventRecorder(process.env.TIDY_UI_TEST_OUTPUT!);
    const gate = createWriteCaptureGate(event => record({ type: 'write_source_state', ...event }));
    const observer = observeSyntaxCards(() => {}, { writeCapture: {
      activate: (call, owner) => gate.activate(call, owner),
      observe: (event, owner) => gate.observe(event, owner),
      retire: (call, owner) => gate.retire(call, owner),
    } });
    pi.on('session_shutdown', () => { observer.restore(); gate.close(); });
    pi.registerCommand('tidy-ui-write-ready', {
      description: 'Await observed current write source publication without requesting work',
      handler: async name => { const calls = await gate.wait(); record({ type: 'write_capture_ready', name, calls }); },
    });
  }
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  const record = process.env.TIDY_UI_TEST_EDIT_CARDS === '1' ? createEventRecorder(output) : undefined, epoch = record ? randomUUID() : undefined;
  if (process.env.TIDY_UI_TEST_NATIVE_PREPARATION === '1') {
    const recordPreparation = createEventRecorder(output), probeEpoch = randomUUID();
    const prototype = DeferredRenderer.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'materialize');
    if (!descriptor || typeof descriptor.value !== 'function') throw new Error('DeferredRenderer.materialize is not an own method');
    const current = prototype.materialize as typeof prototype.materialize & { [nativePreparationObserver]?: typeof prototype.materialize };
    const original = current[nativePreparationObserver] ?? current;
    function observed(this: DeferredRenderer): void {
      const component = Reflect.get(this, 'component');
      const invoke = Reflect.get(this, 'invoke');
      if (Reflect.get(this, 'disposed') !== true && component === undefined && typeof invoke === 'function') {
        if (Object.getPrototypeOf(this) !== prototype) throw new TypeError('Native renderer probe observed a different DeferredRenderer prototype');
        const owner = Reflect.get(this, 'owner'), tool = Reflect.get(owner, 'tool'), slot = Reflect.get(this, 'slot');
        if ((tool !== 'write' && tool !== 'edit') || (slot !== 'call' && slot !== 'result')) throw new TypeError('Deferred native renderer has an unknown owner or slot');
        recordPreparation({ type: 'deferred_native_materialize', epoch: probeEpoch, tool, slot, prototypeMatches: true });
      }
      return original.call(this);
    }
    Object.defineProperty(observed, nativePreparationObserver, { value: original });
    Object.defineProperty(prototype, 'materialize', { ...descriptor, value: observed });
    recordPreparation({ type: 'deferred_native_probe', epoch: probeEpoch, prototype: DeferredRenderer.name });
    pi.on('session_shutdown', () => {
      if (prototype.materialize === observed) Object.defineProperty(prototype, 'materialize', descriptor);
    });
  }
  return tidyUi(pi, { logging: record ? { root: join(output, 'logs') } : undefined,
    cardPreparation: record ? event => record({ type: 'card_preparation', ...event, update: `${epoch}:${event.update}` }) : undefined, syntax(ctx) {
    const options = createSyntaxOptions(ctx);
    return { ...options, provider: {
      async tryShared() { return undefined; },
      async acquireOwned() { throw new ExpectedOwnedUnavailable(); },
    } };
  } });
}
