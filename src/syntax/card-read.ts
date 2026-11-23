import type { CardRole } from '../appearance/card-roles.ts';
import type { AnsiStyle } from '../appearance/style-ansi.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { FlatRangeReader, PreparedCard, ReadyCardPaint } from '../rendering/card-values.ts';
import type { LiteralPaint } from '../rendering/card-styles.ts';

type ReadPin = { retain(): void; release(): void };
type ReadCoverage = { readonly version: number; readonly text?: string;
  readonly runs: Uint32Array; readonly literals: readonly ConcreteStyle[] };
type ReadPaint = Pick<ReadyCardPaint, 'publication' | 'paintStamp' | 'origin' | 'mode'> & {
  readonly charge: ReadPin;
  readonly holds: readonly ReadPin[];
  readonly table: ReadonlyMap<ConcreteStyle, LiteralPaint>;
  readonly roles: Readonly<Record<CardRole, AnsiStyle>>;
  readonly native: ReadonlyMap<string, ReadCoverage>;
  readonly pi: ReadonlyMap<string, ReadCoverage>;
};
type ReadableCard = {
  readonly version: number;
  readonly bashPrefix?: number;
  readonly ticket?: { readonly descriptorCharge?: ReadPin };
  readonly display?: PreparedCard;
  readonly paint?: ReadPaint;
};
type Surface = Parameters<ReadyCardPaint['ranges']>[1];

/** A paid synchronous borrow; starting new card work is not a read capability. */
export function visitPreparedCard(card: ReadableCard, current: () => boolean,
  consume: (display: PreparedCard, paint: ReadyCardPaint) => void): boolean {
  const { display, paint } = card, charge = card.ticket?.descriptorCharge;
  if (!display || !paint || !charge || !current()) return false;
  const scoped = cardReader(display, paint, card.version, card.bashPrefix, current);
  charge.retain(); paint.charge.retain();
  for (const hold of paint.holds) hold.retain();
  try { consume(scoped.display, scoped.paint); return current(); }
  finally {
    scoped.clear(); charge.release(); paint.charge.release();
    for (const hold of paint.holds) hold.release();
  }
}

function surfaceStyle(literal: LiteralPaint, surface: Surface): AnsiStyle {
  switch (surface) {
    case 'added': return literal.added;
    case 'removed': return literal.removed;
    case 'context': return literal.context;
    default: return literal.normal;
  }
}

// Escaped accessors share only these clearable holders, not the outer call's owner or arguments.
function cardReader(display: PreparedCard | undefined, paint: ReadPaint | undefined, version: number,
  bashPrefixBytes: number | undefined, current: (() => boolean) | undefined) {
  const valid = () => !!current?.();
  const stale = () => { if (!valid()) throw new Error('stale card visit'); };

  function coverage(key: string) {
    const native = paint!.native.get(key);
    if (display!.kind === 'bash') return native;
    const member = native ?? paint!.pi.get(key);
    return member?.version === version ? member : undefined;
  }

  function reader(key: string, surface: Surface, end: number): FlatRangeReader {
    return consume => {
      if (!valid()) return false;
      const member = coverage(key);
      if (!member) return false;
      const { runs, literals } = member;
      for (let index = 0; valid() && index < runs.length && runs[index]! < end; index += 3) {
        const compiled = paint!.table.get(literals[runs[index + 2]!]!);
        if (!compiled) return false;
        consume(runs[index]!, Math.min(runs[index + 1]!, end), surfaceStyle(compiled, surface));
      }
      return valid();
    };
  }

  function ranges(key: string, surface?: Surface): FlatRangeReader | undefined {
    if (!valid() || !coverage(key) || bashPrefixBytes === 0) return;
    return reader(key, surface, bashPrefixBytes ?? Infinity);
  }

  function basis(key: string, consume: Parameters<ReadyCardPaint['basis']>[1]): boolean {
    if (!valid()) return false;
    const member = coverage(key);
    if (member?.text === undefined) return false;
    consume(member.text, reader(key, undefined, Infinity));
    return valid();
  }

  const readDisplay = new Proxy({} as PreparedCard, { get: (_target, key) => { stale(); return Reflect.get(display!, key); },
    set: () => false, defineProperty: () => false, deleteProperty: () => false });
  const readPaint = Object.freeze<ReadyCardPaint>({ publication: paint!.publication, paintStamp: paint!.paintStamp, origin: paint!.origin, mode: paint!.mode,
    bashPrefixBytes, get roles() { stale(); return paint!.roles; }, ranges, basis });
  return { display: readDisplay, paint: readPaint, clear() { display = paint = current = undefined; } };
}
