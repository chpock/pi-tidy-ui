import { CARD_ROLES, type CardRole, type LiteralInk } from './semantic-codec.ts';
import type { DataCharge, DataGrant } from './data-budget.ts';
import type { ContextRef } from './context-arena.ts';
import type { ConcreteStyle } from '../syntax/style-materialization.ts';

/** Already materialized, complete internal data. The caller establishes coverage
 * from its context demands before publication; no source or UI owner is allowed. */
export interface ReadyPresentation {
  readonly vocabulary: string;
  readonly rules: string;
  readonly palette: string;
  readonly bindingRevision: number;
  readonly roles: Readonly<Record<CardRole, ConcreteStyle>>;
  readonly contexts: readonly Readonly<{ context: ContextRef; style: ConcreteStyle }>[];
}
export interface OwnedPresentation {
  readonly roles: Readonly<Record<CardRole, ConcreteStyle>>;
  readonly contexts: ReadonlyMap<ContextRef, ConcreteStyle>;
  readonly contextKeys: readonly ContextRef[];
  readonly bytes: number;
  readonly charge: DataCharge;
}
const tableBytes = 256, styleBytes = 256, referenceBytes = 96, keyListHeaderBytes = 32, keyBytes = 8;

export function completeRoles(input: ReadyPresentation): boolean {
  return CARD_ROLES.every(role => !!input.roles[role]);
}
/** Additional cold adoption/validation peak; original input remains caller-funded. */
export function presentationPeak(input: ReadyPresentation, reuse: boolean): number {
  const validation = input.contexts.length * referenceBytes;
  return validation + (reuse ? 0 : tableBytes + keyListHeaderBytes + input.contexts.length * keyBytes + CARD_ROLES.length * 8
    + input.contexts.length * referenceBytes + (CARD_ROLES.length + input.contexts.length) * styleBytes * 2);
}
export function equalPresentation(owned: OwnedPresentation, input: ReadyPresentation): boolean {
  if (owned.contexts.size !== input.contexts.length) return false;
  for (const role of CARD_ROLES) if (!sameStyle(owned.roles[role], input.roles[role])) return false;
  for (const pair of input.contexts) {
    const style = owned.contexts.get(pair.context);
    if (!style || !sameStyle(style, pair.style)) return false;
  }
  return true;
}
/** Called only after the peak grant. Literal interning is local to this table. */
export function copyPresentation(input: ReadyPresentation, grant: DataGrant): OwnedPresentation {
  const literals = new Map<string, ConcreteStyle>();
  function copy(style: ConcreteStyle): ConcreteStyle {
    const key = `${inkKey(style.foreground)}/${inkKey(style.background)}/${style.attributes}`;
    let literal = literals.get(key);
    if (!literal) {
      literal = Object.freeze({ foreground: copyInk(style.foreground),
        background: copyInk(style.background), attributes: style.attributes });
      literals.set(key, literal);
    }
    return literal;
  }
  const roles = {} as Record<CardRole, ConcreteStyle>;
  for (const role of CARD_ROLES) roles[role] = copy(input.roles[role]);
  const contexts = new Map<ContextRef, ConcreteStyle>(), contextKeys: ContextRef[] = [];
  for (const pair of input.contexts) { contexts.set(pair.context, copy(pair.style)); contextKeys.push(pair.context); }
  const bytes = tableBytes + keyListHeaderBytes + contexts.size * keyBytes + CARD_ROLES.length * 8 + contexts.size * referenceBytes + literals.size * styleBytes;
  return { roles: Object.freeze(roles), contexts, contextKeys: Object.freeze(contextKeys), bytes, charge: grant.consume(bytes) };
}
function copyInk(ink: LiteralInk): LiteralInk {
  return Object.freeze(ink.kind === 'rgb' ? { kind: 'rgb', r: ink.r, g: ink.g, b: ink.b }
    : ink.kind === 'indexed' ? { kind: 'indexed', index: ink.index } : { kind: 'terminal-default' });
}
function inkKey(ink: LiteralInk): string {
  return ink.kind === 'rgb' ? `r${ink.r},${ink.g},${ink.b}` : ink.kind === 'indexed' ? `i${ink.index}` : 'd';
}
function sameInk(a: LiteralInk, b: LiteralInk): boolean {
  if (a.kind === 'rgb') return b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b;
  if (a.kind === 'indexed') return b.kind === 'indexed' && a.index === b.index;
  return b.kind === 'terminal-default';
}
function sameStyle(a: ConcreteStyle, b: ConcreteStyle): boolean {
  return a.attributes === b.attributes && sameInk(a.foreground, b.foreground) && sameInk(a.background, b.background);
}
