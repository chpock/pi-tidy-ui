import assert from 'node:assert/strict';
import { preparePiFlat } from '../../src/syntax/pi-flat.ts';
import type { ConcreteStyle } from '../../src/syntax/style-materialization.ts';
import type { SemanticRetentionPool } from '../../src/occipital/semantic-retention.ts';
import type { SourceController } from '../../src/occipital/controller.ts';
export const piNeutral: ConcreteStyle = { foreground: { kind: 'terminal-default' }, background: { kind: 'terminal-default' }, attributes: 0 };
export function installProjection(pool: SemanticRetentionPool, generation: number, version: number, text: string, rows = text.split('\n')) {
  const preparation = pool.piPreparation(generation, version, 0), ticket = preparation.ticket;
  const released = [...preparation.released];
  if (!ticket) return { accepted: false, released };
  try {
    const result = preparePiFlat(text, consume => { rows.forEach((line, index) => consume(index, line)); return true; }, piNeutral, pool.budget, bytes => {
      const reservation = pool.reserve(generation, bytes); released.push(...reservation.released);
      return reservation.accepted ? pool.budget.reserve(bytes) : undefined;
    });
    assert.equal(result.outcome, 'ready', 'fixture must be a valid admitted projection');
    if (result.outcome !== 'ready') return { accepted: false, released };
    const staged = result.projection.stage(); assert.ok(staged);
    const adopted = pool.adoptPiFlat(ticket, text, staged); released.push(...adopted.released);
    return { accepted: adopted.accepted, released };
  } finally { ticket.release(); }
}
export function visitProjection(pool: SemanticRetentionPool, generation: number, consume: (start: number, end: number, style: number) => void) {
  const status = pool.piProjectionStatus(generation); return status ? pool.visitPiRanges(generation, status.revision, consume) : false;
}
export function projectionRanges(pool: SemanticRetentionPool, generation: number) {
  const ranges: number[][] = []; assert.equal(visitProjection(pool, generation, (...range) => ranges.push(range)), true); return ranges;
}
export function installControllerProjection(source: SourceController, key: string, generation: number, version: number, text: string, palette: number, rows: readonly string[]) {
  const ticket = source.piPreparation(key, generation, version, palette); if (!ticket) return false;
  try {
    const result = preparePiFlat(text, consume => { rows.forEach((line, index) => consume(index, line)); return true; }, piNeutral, ticket.budget, bytes => source.reservePiData(ticket, bytes));
    if (result.outcome !== 'ready') return false;
    const staged = result.projection.stage(); assert.ok(staged);
    return source.adoptPiFlat(ticket, text, staged);
  } finally { ticket.release(); }
}
