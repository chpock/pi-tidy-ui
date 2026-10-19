import type { Ink, LiteralInk, StyleExpression } from '../occipital/semantic-codec.ts';

type BindingInk = LiteralInk | Readonly<{ kind: 'inherit' }>;
export interface StyleBinding {
  readonly ink: BindingInk;
  readonly attributes: number;
  readonly attribute_mask: number;
}
export interface ConcreteStyle {
  readonly foreground: LiteralInk;
  readonly background: LiteralInk;
  readonly attributes: number;
}

/** Materialize validated styles and sampled bindings once outside render. A
 * foreground role carries its own explicit typography; a background is color
 * only. Selector masks apply last, including zero-valued resets. Structural
 * syntax surfaces may override token backgrounds, never palette role backgrounds.
 * The caller funds and owns the returned detached, immutable style. */
export function materializeStyle(expression: StyleExpression, bindings: readonly StyleBinding[],
  caller: ConcreteStyle, surface?: LiteralInk): ConcreteStyle {
  const foregroundBinding = expression.foreground.kind === 'binding' ? binding(bindings, expression.foreground.slot) : undefined;
  let attributes = caller.attributes;
  if (foregroundBinding) attributes = patch(attributes, foregroundBinding.attributes, foregroundBinding.attribute_mask);
  attributes = patch(attributes, expression.attributes, expression.attribute_mask);
  const foreground = resolve(expression.foreground, bindings, caller.foreground);
  const background = surface ?? resolve(expression.background, bindings, caller.background);
  return Object.freeze({ foreground: copy(foreground), background: copy(background), attributes });
}

function patch(inherited: number, attributes: number, mask: number): number {
  return (inherited & ~mask) | attributes;
}
function binding(bindings: readonly StyleBinding[], slot: number): StyleBinding {
  const value = bindings[slot];
  if (!value) throw new Error(`missing style binding ${slot}`);
  return value;
}
function resolve(ink: Ink, bindings: readonly StyleBinding[], caller: LiteralInk): LiteralInk {
  if (ink.kind === 'binding') {
    const color = binding(bindings, ink.slot).ink;
    return color.kind === 'inherit' ? caller : color;
  }
  return ink.kind === 'inherit' ? caller : ink;
}
function copy(ink: LiteralInk): LiteralInk { return Object.freeze({ ...ink }); }
