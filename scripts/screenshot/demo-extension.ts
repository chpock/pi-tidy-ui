import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createEventRecorder } from '../../tests/fixtures/terminal-output.ts';
import tidyUi from '../../src/index.ts';
import { demo as example } from './demo.mjs';

export default function demo(pi: ExtensionAPI) {
  const record = createEventRecorder(process.env.TIDY_UI_TEST_OUTPUT!);
  pi.registerProvider(example.model.provider, {
    api: example.model.api, baseUrl: 'http://127.0.0.1/unused', apiKey: 'offline-demo',
    models: [{ id: example.model.id, name: example.model.name, reasoning: true, thinkingLevelMap: { max: 'max' }, input: ['text'], contextWindow: example.context.window,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      if (!example.working) throw new Error('An idle screenshot must not request a model');
      const signal = options?.signal;
      if (!signal) throw new Error('The offline screenshot response requires an abort signal');
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const abort = () => {
        message.stopReason = 'aborted';
        message.errorMessage = 'Offline screenshot response cancelled';
        stream.push({ type: 'error', reason: 'aborted', error: message });
        stream.end();
        record({ type: 'demo_aborted' });
      };
      stream.push({ type: 'start', partial: message });
      record({ type: 'demo_working' });
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return stream;
    },
  });
  pi.registerCommand('tidy-ui-demo-working', {
    description: 'Hold an offline turn for the native Working screenshot',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) throw new Error('Start the screenshot turn from an idle session');
      ctx.ui.setWorkingMessage('Working');
      pi.sendMessage({ customType: 'tidy-ui-demo-working', content: 'Continue the offline demonstration.', display: false }, { triggerTurn: true });
      ctx.ui.setEditorText(example.editorText);
    },
  });
  return tidyUi(pi);
}
