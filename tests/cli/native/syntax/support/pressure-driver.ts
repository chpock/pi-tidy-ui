import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceExecution } from '../../../../../src/highlighting/source-execution.ts';
import { SemanticRetentionPool } from '../../../../../src/highlighting/storage/semantic-retention.ts';
import syntaxDriver from '../../../../fixtures/syntax-driver.ts';

/** Physical scroll must not be disturbed by typing a command into the input editor. */
export default function pressureDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  const observe = SourceExecution.prototype.observe;
  let target: { execution: WeakRef<SourceExecution>; key: string; version: number; generation: number } | undefined;
  SourceExecution.prototype.observe = function (demand) {
    const accepted = observe.call(this, demand);
    if (accepted && demand.text.includes('RETURN_EVICTION_TARGET')) {
      const generation = this.status(demand.key)?.generation;
      if (generation !== undefined) target = { execution: new WeakRef(this), key: demand.key, version: demand.version, generation };
    }
    return accepted;
  };
  let attempted = false;
  const watcher = watch(output, { persistent: false }, (_event, file) => {
    if (file !== 'pressure-go' || attempted) return;
    attempted = true;
    try {
      const current = target, execution = current?.execution.deref(), funding = execution?.geometryFunding();
      if (!current || !execution || !funding || !execution.status(current.key)?.exact) throw Error('No exact native target before pressure');
      const releases: Array<{ generation: number; reason: string; retainedBytes: number }> = [];
      const reserve = SemanticRetentionPool.prototype.reserve;
      SemanticRetentionPool.prototype.reserve = function (...args) {
        const result = reserve.apply(this, args);
        if (this.budget === funding.budget) for (const { generation, reason, retainedBytes } of result.released) releases.push({ generation, reason, retainedBytes });
        return result;
      };
      try {
        const limit = execution.stats().retention.entries;
        for (let i = 0; i < limit && !releases.some(r => r.generation === current.generation); i++) {
          const stats = funding.budget.stats();
          // One byte beyond available credit forces ordinary eviction. A grant reserves numbers, not a backing byte buffer.
          const grant = funding.grant(stats.limit - stats.retainedBytes - stats.outstandingPeakBytes + 1);
          if (!grant) throw Error('No reclaimable entry could fund the pressure request');
          grant.close();
        }
      } finally { SemanticRetentionPool.prototype.reserve = reserve; }
      const status = execution.status(current.key);
      writeFileSync(join(output, 'pressure-result.json'), JSON.stringify({ key: current.key, generation: current.generation,
        version: current.version, releases, after: status, budget: funding.budget.stats() }));
    } catch (error) { writeFileSync(join(output, 'pressure-result.json'), JSON.stringify({ error: String(error) })); }
  });
  pi.on('session_shutdown', () => { watcher.close(); SourceExecution.prototype.observe = observe; });
  return syntaxDriver(pi);
}
