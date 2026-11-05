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

function nativeMaterialization(renderer: DeferredRenderer, prototype: object): { tool: string; slot: string } | undefined {
  const component = Reflect.get(renderer, 'component'), invoke = Reflect.get(renderer, 'invoke');
  if (Reflect.get(renderer, 'disposed') === true || component !== undefined || typeof invoke !== 'function') return;
  if (Object.getPrototypeOf(renderer) !== prototype) throw new TypeError('Native renderer probe observed a different DeferredRenderer prototype');
  const owner = Reflect.get(renderer, 'owner'), tool = Reflect.get(owner, 'tool'), slot = Reflect.get(renderer, 'slot');
  if (!['read', 'write', 'edit'].includes(tool) || !['call', 'result'].includes(slot)) throw new TypeError('Deferred native renderer has an unknown owner or slot');
  return { tool, slot };
}

export function observeDeferredNativePreparation(record: (event: unknown) => void): () => void {
  const probeEpoch = randomUUID(), prototype = DeferredRenderer.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'materialize');
  if (!descriptor || typeof descriptor.value !== 'function') throw new Error('DeferredRenderer.materialize is not an own method');
  const current = prototype.materialize as typeof prototype.materialize & { [nativePreparationObserver]?: typeof prototype.materialize };
  const original = current[nativePreparationObserver] ?? current;
  function observed(this: DeferredRenderer): void {
    const preparation = nativeMaterialization(this, prototype);
    if (preparation) record({ type: 'deferred_native_materialize', epoch: probeEpoch, ...preparation, prototypeMatches: true });
    return original.call(this);
  }
  Object.defineProperty(observed, nativePreparationObserver, { value: original });
  Object.defineProperty(prototype, 'materialize', { ...descriptor, value: observed });
  record({ type: 'deferred_native_probe', epoch: probeEpoch, prototype: DeferredRenderer.name });
  return () => {
    if (prototype.materialize === observed) Object.defineProperty(prototype, 'materialize', descriptor);
  };
}

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
    pi.on('session_shutdown', observeDeferredNativePreparation(createEventRecorder(output)));
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
