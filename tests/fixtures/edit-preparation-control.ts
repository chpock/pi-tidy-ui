import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SourceController } from '../../src/occipital/controller.ts';
import presentationDriver from './presentation-driver.ts';
import { createEventRecorder } from './terminal-output.ts';

export default function editPreparationControl(pi: ExtensionAPI) {
  const record = createEventRecorder(process.env.TIDY_UI_TEST_OUTPUT!);
  const original = { continueWork: SourceController.prototype.continueWork, resumePreparation: SourceController.prototype.resumePreparation };
  const deferred: { owner: WeakRef<SourceController>; method: keyof typeof original }[] = [];
  let holding = false;
  for (const method of ['continueWork', 'resumePreparation'] as const) {
    SourceController.prototype[method] = function () {
      if (!holding) return original[method].call(this);
      if (deferred.length >= 16) throw new Error('Unexpected continuation count');
      deferred.push({ owner: new WeakRef(this), method });
      record({ type: 'preparation_control', phase: 'held', count: deferred.length });
    };
  }
  const release = () => {
    holding = false;
    const pending = deferred.splice(0);
    record({ type: 'preparation_control', phase: 'released', count: pending.length });
    for (const entry of pending) { const owner = entry.owner.deref(); if (owner) original[entry.method].call(owner); }
  };
  pi.registerCommand('hold-preparation', { description: 'Retain real scheduled continuations without completing their work', handler: async () => {
    if (holding || deferred.length) throw new Error('Preparation hold is already active');
    holding = true;
    record({ type: 'preparation_control', phase: 'armed' });
  } });
  pi.registerCommand('release-preparation', { description: 'Deliver each retained real continuation once', handler: async () => release() });
  pi.on('session_shutdown', () => {
    release();
    for (const method of ['continueWork', 'resumePreparation'] as const) SourceController.prototype[method] = original[method];
  });
  return presentationDriver(pi);
}
