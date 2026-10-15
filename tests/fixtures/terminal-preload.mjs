import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const plan = JSON.parse(readFileSync(process.env.TIDY_UI_TEST_OBSERVER_PLAN, 'utf8'));
if (plan.schema !== 1 || !/^[$A-Z_a-z][$\w]*$/.test(plan.binding) ||
  !Number.isSafeInteger(plan.interruptWindow) || plan.interruptWindow < 0) throw new Error('Invalid terminal observer plan');
const installer = new URL('./terminal-observer.mjs', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== plan.module) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    if (createHash('sha256').update(source).digest('hex') !== plan.sha256) throw new Error('Selected Pi changed after terminal observer planning');
    return { ...result, source: `${source}\nimport { installTerminalObserver as __tidyInstallTerminalObserver } from ${JSON.stringify(installer)};\n__tidyInstallTerminalObserver(${plan.binding}, { interruptWindow: ${plan.interruptWindow} });\n` };
  },
});
