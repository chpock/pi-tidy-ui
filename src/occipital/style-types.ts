export type LiteralInk = Readonly<{ kind: 'rgb'; r: number; g: number; b: number }>
  | Readonly<{ kind: 'indexed'; index: number }> | Readonly<{ kind: 'terminal-default' }>;
export type Ink = LiteralInk | Readonly<{ kind: 'binding'; slot: number }> | Readonly<{ kind: 'inherit' }>;
export interface StyleExpression {
  readonly foreground: Ink;
  readonly background: Ink;
  readonly attributes: number;
  readonly attribute_mask: number;
}
export interface StyleIdentity {
  readonly vocabulary: string;
  readonly rules: string;
  readonly bindingSlots: number;
}
