import type { TerminalColorMode } from '@earendil-works/pi-tui';
import { CARD_ROLES, type CardRole } from '../appearance/card-roles.ts';
import { compileStyleAnsi, type AnsiStyle } from '../appearance/style-ansi.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { DataCharge } from '../resources/data-budget.ts';

export type LiteralPaint = { normal: AnsiStyle; added: AnsiStyle; removed: AnsiStyle; context: AnsiStyle };

/** The reserve callback records caller-owned credit before any table allocation.
 * Rejection or an exception leaves its release to that same caller's finally. */
export function compileCardStyles(roles: Readonly<Record<CardRole, ConcreteStyle>>,
  enumerate: (consume: (style: ConcreteStyle) => void) => boolean, mode: TerminalColorMode,
  reserve: (styleCount: number) => DataCharge | undefined, preparedRoles?: Readonly<Record<CardRole, AnsiStyle>>) {
  let count = 0; if (!enumerate(() => count++)) return;
  const charge = reserve(count); if (!charge) return;
  const table = new Map<ConcreteStyle, LiteralPaint>(), compiled = {} as Record<CardRole, AnsiStyle>;
  const known = new Map<ConcreteStyle, AnsiStyle>();
  if (preparedRoles) for (const role of CARD_ROLES) known.set(roles[role], preparedRoles[role]);
  const add = (style: ConcreteStyle) => { if (!table.has(style)) table.set(style, {
    normal: known.get(style) ?? compileStyleAnsi(style, mode), added: compileStyleAnsi({ ...style, background: roles.addedCode.background }, mode),
    removed: compileStyleAnsi({ ...style, background: roles.removedCode.background }, mode),
    context: compileStyleAnsi({ ...style, background: roles.contextCode.background }, mode) }); };
  if (!enumerate(add)) return;
  for (const role of CARD_ROLES) { const style = roles[role]; add(style); compiled[role] = table.get(style)!.normal; }
  return { charge, table, roles: compiled, add };
}
