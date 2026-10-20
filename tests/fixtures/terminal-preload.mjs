import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const plan = JSON.parse(readFileSync(process.env.TIDY_UI_TEST_OBSERVER_PLAN, 'utf8'));
if (plan.schema !== 1 || !/^[$A-Z_a-z][$\w]*$/.test(plan.binding) ||
  !Number.isSafeInteger(plan.interruptWindow) || plan.interruptWindow < 0) throw new Error('Invalid terminal observer plan');
const measuring = process.env.TIDY_UI_TEST_PERFORMANCE === '1';
const installer = new URL(measuring ? './performance-observer.mjs' : './terminal-observer.mjs', import.meta.url).href;
const install = measuring ? 'installPerformanceObserver' : 'installTerminalObserver';
const layoutInstrument = measuring ? (await import('./performance-layout-plan.mjs')).instrumentPerformanceLayout : undefined;
if (measuring && !plan.layout?.module) throw new Error('Missing performance layout plan');
if (measuring) {
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
    if (url !== plan.module) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    if (createHash('sha256').update(source).digest('hex') !== plan.sha256) throw new Error('Selected Pi changed after terminal observer planning');
    const observed = measuring && url === plan.layout.module ? layoutInstrument(source, plan.layout) : source;
    return { ...result, source: `${observed}\nimport { ${install} as __tidyInstallTerminalObserver } from ${JSON.stringify(installer)};\n__tidyInstallTerminalObserver(${plan.binding}, { interruptWindow: ${plan.interruptWindow} });\n` };
  },
});
