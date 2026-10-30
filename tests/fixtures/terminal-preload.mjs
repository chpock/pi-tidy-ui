import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const plan = JSON.parse(readFileSync(process.env.TIDY_UI_TEST_OBSERVER_PLAN, 'utf8'));
if (plan.schema !== 1 || !/^[$A-Z_a-z][$\w]*$/.test(plan.binding) ||
  !Number.isSafeInteger(plan.interruptWindow) || plan.interruptWindow < 0) throw new Error('Invalid terminal observer plan');
const measuring = process.env.TIDY_UI_TEST_PERFORMANCE === '1';
const preconditionOnly = process.env.TIDY_UI_TEST_PERFORMANCE_PRECONDITION === '1';
if (process.env.TIDY_UI_TEST_PERFORMANCE_PRECONDITION !== undefined && !preconditionOnly) throw new Error('Invalid performance precondition mode');
if (preconditionOnly && !measuring) throw new Error('Performance precondition requires the real-Pi observer');
if (!measuring && (!plan.editor || !/^[$A-Z_a-z][$\w]*$/.test(plan.editor.binding) ||
  plan.editor.module !== plan.module && !/^[$A-Z_a-z][$\w]*$/.test(plan.editor.exportName))) throw new Error('Invalid native autocomplete observer plan');
const installer = new URL(measuring ? './performance-observer.mjs' : './terminal-observer.mjs', import.meta.url).href;
const install = measuring ? 'installPerformanceObserver' : 'installTerminalObserver';
const layoutInstrument = measuring ? (await import('./performance-layout-plan.mjs')).instrumentPerformanceLayout : undefined;
if (measuring && !plan.layout?.module) throw new Error('Missing performance layout plan');
if (measuring && !preconditionOnly) {
  const { beginPhase } = await import('../../scripts/test/performance/metrics.mjs');
  globalThis[Symbol.for('pi-tidy-ui.performance.startup')] = beginPhase();
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (measuring && url === plan.layout.module && url !== plan.module) {
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
      return { ...result, source: layoutInstrument(source, plan.layout) };
    }
    if (!measuring && url === plan.editor.module) {
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
      if (createHash('sha256').update(source).digest('hex') !== plan.editor.sha256) throw new Error('Selected Pi autocomplete changed after terminal observer planning');
    }
    if (url !== plan.module) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    if (createHash('sha256').update(source).digest('hex') !== plan.sha256) throw new Error('Selected Pi changed after terminal observer planning');
    const observed = measuring && url === plan.layout.module ? layoutInstrument(source, plan.layout) : source;
    const editor = !measuring && plan.editor.module !== plan.module
      ? `import { ${plan.editor.exportName} as __tidyNativeEditor } from ${JSON.stringify(plan.editor.module)};\n` : '';
    const options = measuring ? '' : `, Editor: ${plan.editor.module === plan.module ? plan.editor.binding : '__tidyNativeEditor'}`;
    return { ...result, source: `${observed}\nimport { ${install} as __tidyInstallTerminalObserver } from ${JSON.stringify(installer)};\n${editor}__tidyInstallTerminalObserver(${plan.binding}, { interruptWindow: ${plan.interruptWindow}${options} });\n` };
  },
});
