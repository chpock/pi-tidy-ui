// Use Pi's ordinary TS extension-loader graph, just like syntax-driver.ts.
// Native ESM imports from an .mjs entry can otherwise observe another class copy.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../src/index.ts';
import { SyntaxRuntime } from '../../src/syntax/runtime.ts';
import { CardSources } from '../../src/syntax/cards.ts';
import { preparedHistoryReady, preparedHistoryPaintOriginCount, explainPreparedHistory } from './performance-readiness.mjs';
import { createSyntaxOptions } from '../../src/occipital/bootstrap.ts';
import { createLocalOwnedFactory } from '../../src/occipital/factories.ts';
import { registerPerformanceDriver } from './performance-driver.mjs';

export default function performanceTidy(pi: ExtensionAPI) {
  return registerPerformanceDriver(pi, (_api: ExtensionAPI, scenario: { variant: 'on' | 'off' }) => {
    let runtime: WeakRef<SyntaxRuntime> | undefined, controller: WeakRef<Parameters<SyntaxRuntime['attach']>[0]> | undefined, consumer: WeakRef<object> | undefined;
    const attached = SyntaxRuntime.prototype.attach, prepare = CardSources.prototype.prepare;
    CardSources.prototype.prepare = function (...values) {
      if (consumer?.deref() !== this) consumer = new WeakRef(this);
      return Reflect.apply(prepare, this, values);
    };
    SyntaxRuntime.prototype.attach = function (...values) {
      runtime = new WeakRef(this); controller = new WeakRef(values[0]);
      return Reflect.apply(attached, this, values);
    };
    tidyUi(pi, { logging: false, localPreferences: { appearanceEnabled: scenario.variant === 'on', loggingEnabled: false }, syntax(ctx) {
      const options = createSyntaxOptions(ctx);
      return { ...options, provider: { tryShared: async () => undefined,
        acquireOwned: signal => createLocalOwnedFactory({ command: process.env.OCCIPITAL_TEST_BIN!, requestDeadlineMs: 300000, terminateGraceMs: 1000, cwd: ctx.cwd })(signal) } };
    } });
    return { runtime: () => runtime?.deref(), controller: () => controller?.deref(),
      ready(ids: Set<string>, palettePrefix: string | undefined) { const current = consumer?.deref(); return !!current && preparedHistoryReady(current, ids, palettePrefix); },
      paintOriginCount(ids: Set<string>, origin: string) { const current = consumer?.deref(); return current ? preparedHistoryPaintOriginCount(current, ids, origin) : 0; },
      diagnostics(ids: Set<string>) { const current = consumer?.deref(); return current ? explainPreparedHistory(current, ids) : null; },
      restore() { SyntaxRuntime.prototype.attach = attached; CardSources.prototype.prepare = prepare; } };
  });
}
