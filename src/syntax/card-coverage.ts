import { materializeStyle, type ConcreteStyle } from '../appearance/style-materialization.ts';
import type { PiProjectionReader, SourceDisplayBasis } from '../highlighting/source-ports.ts';
import type { StyleExpression } from '../occipital/style-types.ts';
import type { DataCharge, GeometryFunding } from '../resources/data-budget.ts';
import type { PiInputRead } from './pi-input.ts';

export type Coverage = { readonly charge: DataCharge; readonly runs: Uint32Array; readonly version: number;
  readonly text?: string; readonly literals: readonly ConcreteStyle[]; readonly effect: string };
export type NativeCoverage = Coverage & { readonly text: string; readonly expressions: readonly (StyleExpression | undefined)[]; readonly bindingCharge?: DataCharge };

export function fund(funding: GeometryFunding, bytes: number): DataCharge | undefined {
  const grant = funding.grant(bytes); if (!grant) return undefined;
  try { if (grant.budget !== funding.budget) throw new Error('foreign card funding'); return grant.consume(bytes); }
  finally { grant.close(); }
}

function copyExpression(expression: StyleExpression): StyleExpression {
  return { foreground: { ...expression.foreground }, background: { ...expression.background },
    attributes: expression.attributes, attribute_mask: expression.attribute_mask };
}

export function bindCoverage(expressions: NativeCoverage['expressions'], read: PiInputRead, bash: boolean): readonly ConcreteStyle[] {
  const neutral = read.roles[bash ? 'title' : 'code'];
  return expressions.map(expression => expression ? materializeStyle(expression, read.bindings, neutral, read.roles.code.background) : read.roles.code);
}

export function captureNative(basis: SourceDisplayBasis, read: PiInputRead, bash: boolean, version: number,
  funding: GeometryFunding): NativeCoverage | undefined {
  let charge: DataCharge | undefined, result: NativeCoverage | undefined;
  try {
    const accepted = basis.visitExpressions((text, runs, contexts, visit) => {
      // Charge one expression and literal per distinct context, not per span.
      charge = fund(funding, 512 + 2 * text.length + runs * 12 + (contexts + 1) * 640);
      if (!charge || !read.isValid) return;
      const coordinates = new Uint32Array(runs * 3), indices = new Map<number, number>();
      const expressions: (StyleExpression | undefined)[] = [undefined];
      let offset = 0;
      if (!visit((from, to, context, expression) => {
        let index = indices.get(context) ?? (context ? undefined : 0);
        if (index === undefined) {
          index = expressions.length;
          if (!expression || index > contexts) throw new Error('invalid accepted style table');
          indices.set(context, index); expressions.push(copyExpression(expression));
        }
        coordinates[offset++] = from; coordinates[offset++] = to; coordinates[offset++] = index;
      }) || offset !== coordinates.length || !read.isValid) return;
      result = { charge, text, version, runs: coordinates, expressions,
        literals: bindCoverage(expressions, read, bash), effect: `${basis.generation}:${basis.paintStamp}` };
    });
    if (!accepted || !result) return;
    charge = undefined; return result;
  } finally { charge?.release(); }
}

export function capturePi(projection: PiProjectionReader, funding: GeometryFunding): Coverage | undefined {
  const { rangeCount, styleCount, version } = projection;
  const charge = fund(funding, 512 + 12 * rangeCount + 320 * styleCount);
  if (!charge) return;
  let accepted = false;
  try {
    const runs = new Uint32Array(rangeCount * 3), literals: ConcreteStyle[] = [];
    let offset = 0;
    if (!projection.visitStyles((index, style) => { literals[index] = style; }) || !projection.visitRanges((from, to, index) => {
      runs[offset++] = from; runs[offset++] = to; runs[offset++] = index;
    }) || offset !== runs.length) return;
    accepted = true;
    return { charge, version, runs, literals, effect: `${projection.generation}/${projection.revision}/${projection.palette}` };
  } finally { if (!accepted) charge.release(); }
}

export function matchingPrefixBytes(basis: string, current: string): number {
  let bytes = 0;
  for (let i = 0; i < basis.length && i < current.length;) {
    const cp = basis.codePointAt(i)!;
    if (cp !== current.codePointAt(i)) break;
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    i += cp > 65535 ? 2 : 1;
  }
  return bytes;
}
