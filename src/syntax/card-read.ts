import type { CardRole } from '../appearance/card-roles.ts';
import type { AnsiStyle } from '../appearance/style-ansi.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { DisplayRangeReader, GroupDisplayBasis, GroupDisplayMember, PiProjectionReader, SourceDisplayBasis } from '../highlighting/source-ports.ts';
import type { FlatRangeReader, PreparedCard, ReadyCardPaint } from '../rendering/card-values.ts';
import type { LiteralPaint } from '../rendering/card-styles.ts';

type ReadPin = { retain(): void; release(): void };

type ReadPaint = Pick<ReadyCardPaint, 'publication' | 'paintStamp' | 'origin' | 'mode'> & {
  readonly charge: ReadPin;
  readonly table: ReadonlyMap<ConcreteStyle, LiteralPaint>;
  readonly roles: Readonly<Record<CardRole, AnsiStyle>>;
  readonly group?: GroupDisplayBasis;
  readonly piTokens: ReadonlyMap<string, ReadonlyMap<number, ConcreteStyle>>;
};
type Slot = { readonly version: number; readonly language?: string; readonly palette: number };
type Slots = { readonly slots: ReadonlyMap<string, Slot>; readonly version: number };
type ReadableCard = Slots & {
  readonly ticket?: { readonly descriptorCharge?: ReadPin };
  readonly display?: PreparedCard;
  readonly paint?: ReadPaint;
  readonly paletteInput?: { visit(consume: () => void): boolean };
};
type Lookups = {
  readonly cardSource: { displayBasis(key: string): SourceDisplayBasis | undefined };
  readonly pi: { piProjection(key: string, version: number, palette: number): PiProjectionReader | undefined };
};
type Surface = Parameters<ReadyCardPaint['ranges']>[1];

/** A paid synchronous borrow; starting new card work is not a read capability. */
export function visitPreparedCard(card: ReadableCard, lookups: Lookups, current: () => boolean,
  consume: (display: PreparedCard, paint: ReadyCardPaint) => void): boolean {
  const { display, paint } = card, charge = card.ticket?.descriptorCharge;
  if (!display || !paint || !charge) return false;
  const scoped = cardReader(display, paint, card, lookups, current);
  charge.retain(); paint.charge.retain();
  try {
    let invoked = false;
    const invoke = () => { if (scoped.valid()) { invoked = true; consume(scoped.display, scoped.paint); } };
    const accepted = paint.group ? paint.group.visit(invoke) : card.paletteInput?.visit(invoke) ?? false;
    return accepted && invoked && scoped.valid();
  } finally { scoped.clear(); charge.release(); paint.charge.release(); }
}

function matchesFileBasis(basis: SourceDisplayBasis | undefined, slot: Slot): basis is SourceDisplayBasis {
  return !!basis && basis.complete && basis.language === slot.language && (basis.version === slot.version || basis.exactVersion === slot.version);
}

function matchesMember(basis: SourceDisplayBasis | undefined, slot: Slot, member: GroupDisplayMember): boolean {
  return matchesFileBasis(basis, slot) && basis.generation === member.generation && basis.version === member.version && basis.stamp === member.stamp;
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
function cardReader(display: PreparedCard | undefined, paint: ReadPaint | undefined, slots: Slots | undefined,
  lookups: Lookups | undefined, current: (() => boolean) | undefined) {
  const valid = () => !!current?.();
  const stale = () => { if (!valid()) throw new Error('stale card visit'); };

  function mapRanges(read: DisplayRangeReader, surface: Surface): FlatRangeReader {
    return consume => {
      if (!valid()) return false;
      let complete = true;
      const accepted = read((a, b, literal) => {
        if (!valid()) return;
        const compiled = paint!.table.get(literal);
        if (!compiled) { complete = false; return; }
        consume(a, b, surfaceStyle(compiled, surface));
      });
      return accepted && complete && valid();
    };
  }

  function groupRanges(group: GroupDisplayBasis, key: string, slot: Slot, surface: Surface): FlatRangeReader | undefined {
    let result: FlatRangeReader | undefined;
    group.visit(member => {
      const entry = member(key);
      if (!entry) return;
      // Cold FILE display can precede useful admission; historical Bash is different.
      if (display!.kind === 'file' && !matchesMember(lookups!.cardSource.displayBasis(key), slot, entry)) return;
      result = mapRanges(entry.read, surface);
    });
    return result;
  }

  function piRanges(key: string, slot: Slot, surface: Surface): FlatRangeReader | undefined {
    if (!paint!.piTokens.has(key)) return;
    const projection = lookups!.pi.piProjection(key, slot.version, slot.palette);
    if (!projection) return;
    return mapRanges(consume => projection.visitRanges((a, b, i) => {
      if (!valid()) return;
      const style = paint!.piTokens.get(key)?.get(i);
      if (style) consume(a, b, style);
    }), surface);
  }

  function ranges(key: string, surface?: Surface): FlatRangeReader | undefined {
    if (!valid()) return;
    const slot = slots!.slots.get(key);
    if (!slot || display!.kind === 'file' && slot.version !== slots!.version) return;
    const group = paint!.group;
    const result = group ? groupRanges(group, key, slot, surface) : undefined;
    if (result || paint!.origin === 'owned') return result;
    return piRanges(key, slot, surface);
  }

  function basis(key: string, consume: Parameters<ReadyCardPaint['basis']>[1]): boolean {
    if (!valid()) return false;
    const source = lookups!.cardSource.displayBasis(key), slot = slots!.slots.get(key);
    if (display!.kind === 'file' && (!slot || !matchesFileBasis(source, slot))) return false;
    const read = ranges(key);
    return !!source && !!read && source.visit(text => { if (valid()) consume(text, read); }) && valid();
  }

  const readDisplay = new Proxy({} as PreparedCard, { get: (_target, key) => { stale(); return Reflect.get(display!, key); },
    set: () => false, defineProperty: () => false, deleteProperty: () => false });
  const readPaint = Object.freeze<ReadyCardPaint>({ publication: paint!.publication, paintStamp: paint!.paintStamp, origin: paint!.origin, mode: paint!.mode,
    get roles() { stale(); return paint!.roles; }, ranges, basis });
  return { display: readDisplay, paint: readPaint, valid, clear() { display = paint = slots = lookups = current = undefined; } };
}
