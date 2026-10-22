import { colorToOklch, oklchColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import type { LiteralInk } from '../occipital/semantic-codec.ts';
import { contrast, inkColor, luminance, outputInk } from './pi-color.ts';
import { PI_RULE_BINDINGS } from './pi-rules.ts';
import type { StyleBinding } from './style-materialization.ts';

export type PiDerivedMarker = 'headingMarker' | 'inlineCodeDelimiter' | 'linkDelimiter';
const candidateStep = 0.005;

interface NeighborRequirement {
  readonly role: ThemeColor;
  readonly minimumDistance: number;
}
interface MarkerPolicy {
  readonly binding: PiDerivedMarker;
  readonly neighbors: readonly NeighborRequirement[];
  readonly targetDistance: number;
  readonly minimumDistance: number;
  readonly maximumDistance: number;
  readonly candidateSteps: number;
}

const policies = [
  // Hash marks are tiny beside a full title, so they need a deliberately strong cue.
  Object.freeze({ binding: 'headingMarker', neighbors: Object.freeze([
    Object.freeze({ role: 'mdHeading', minimumDistance: 0.12 }),
  ]), minimumDistance: 0.12, targetDistance: 0.22, maximumDistance: 0.30, candidateSteps: 60 }),
  // Backticks and link punctuation stay subordinate to the text they delimit.
  Object.freeze({ binding: 'inlineCodeDelimiter', neighbors: Object.freeze([
    Object.freeze({ role: 'mdCode', minimumDistance: 0.07 }),
  ]), minimumDistance: 0.07, targetDistance: 0.09, maximumDistance: 0.12, candidateSteps: 24 }),
  Object.freeze({ binding: 'linkDelimiter', neighbors: Object.freeze([
    Object.freeze({ role: 'mdLink', minimumDistance: 0.07 }),
    Object.freeze({ role: 'mdLinkUrl', minimumDistance: 0.055 }),
    Object.freeze({ role: 'toolOutput', minimumDistance: 0.055 }),
  ]), minimumDistance: 0.07, targetDistance: 0.10, maximumDistance: 0.14, candidateSteps: 28 }),
] as const satisfies readonly MarkerPolicy[];

export const PI_MARKER_VARIANT_CANDIDATE_COUNT = policies.reduce((total, policy) => total + policy.candidateSteps * 2, 0);
export const PI_MARKER_VARIANT_SCRATCH_BYTES = 1024 + PI_MARKER_VARIANT_CANDIDATE_COUNT * 256;

export interface PiMarkerVariantContext {
  readonly parent?: Color;
  readonly neighbors: Readonly<Partial<Record<ThemeColor, Color>>>;
  readonly surfaces?: readonly Color[];
}
export interface PiMarkerVariantDecision {
  readonly binding: PiDerivedMarker;
  readonly status: 'derived' | 'parent';
  readonly reason: 'selected' | 'unknown-parent' | 'unknown-neighbor' | 'unknown-surface' | 'no-safe-visible-candidate';
  readonly separation?: number;
  readonly emittedInk?: LiteralInk;
}
export interface PiMarkerVariants {
  readonly bindings: readonly StyleBinding[];
  readonly decisions: readonly PiMarkerVariantDecision[];
}

function lab(color: Color) {
  const { l, c, h } = colorToOklch(color), angle = h * Math.PI / 180;
  return { l, a: c * Math.cos(angle), b: c * Math.sin(angle), c };
}
function distance(first: Color, second: Color): number {
  const a = lab(first), b = lab(second);
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}
function asEmitted(color: Color, mode: TerminalColorMode): { readonly ink: LiteralInk; readonly color: Color } | undefined {
  const ink = outputInk(color, mode), emitted = inkColor(ink);
  return emitted ? { ink, color: emitted } : undefined;
}
function fallback(binding: PiDerivedMarker, reason: PiMarkerVariantDecision['reason']): PiMarkerVariantDecision {
  return Object.freeze({ binding, status: 'parent', reason });
}

/**
 * Derive only foreground inks for explicit structural roles. The parent binding
 * remains authoritative for typography; all comparisons use final emitted inks
 * and already-frozen surfaces. Candidate search is finite and never runs in render.
 */
export function derivePiMarkerVariants(
  bindings: readonly StyleBinding[],
  contexts: Readonly<Record<PiDerivedMarker, PiMarkerVariantContext>>,
  mode: TerminalColorMode,
): PiMarkerVariants {
  const output = [...bindings], decisions: PiMarkerVariantDecision[] = [];
  for (const policy of policies) {
    const index = PI_RULE_BINDINGS.indexOf(policy.binding), parentBinding = bindings[index]!;
    const context = contexts[policy.binding];
    if (!context.parent) { decisions.push(fallback(policy.binding, 'unknown-parent')); continue; }
    const neighbors = policy.neighbors.map(item => context.neighbors[item.role]);
    if (neighbors.some(color => !color)) { decisions.push(fallback(policy.binding, 'unknown-neighbor')); continue; }
    if (!context.surfaces?.length) { decisions.push(fallback(policy.binding, 'unknown-surface')); continue; }

    const parent = asEmitted(context.parent, mode);
    if (!parent) { decisions.push(fallback(policy.binding, 'unknown-parent')); continue; }
    const origin = lab(parent.color), hue = colorToOklch(parent.color).h;
    const neighborsEmitted = neighbors.map(color => asEmitted(color!, mode)?.color);
    if (neighborsEmitted.some(color => !color)) { decisions.push(fallback(policy.binding, 'unknown-neighbor')); continue; }
    const surfaces = context.surfaces.map(color => asEmitted(color, mode)?.color);
    if (surfaces.some(color => !color)) { decisions.push(fallback(policy.binding, 'unknown-surface')); continue; }
    const requiredContrast = surfaces.map(() => 4.5);
    let best: { ink: LiteralInk; color: Color; distance: number; targetError: number; contrastIncrease: number; chromaLoss: number } | undefined;

    for (let step = 1; step <= policy.candidateSteps; step++) for (const direction of [-1, 1] as const) {
      const lightness = origin.l + direction * candidateStep * step;
      if (lightness <= 0 || lightness >= 1) continue;
      const emitted = asEmitted(oklchColor(lightness, origin.c, hue), mode);
      if (!emitted) continue;
      const separation = distance(parent.color, emitted.color);
      if (separation < policy.minimumDistance || separation > policy.maximumDistance) continue;
      if (neighborsEmitted.some((neighbor, index) => distance(neighbor!, emitted.color) < policy.neighbors[index]!.minimumDistance)) continue;
      if (surfaces.some((surface, index) => contrast(luminance(emitted.color), luminance(surface!)) + 1e-9 < requiredContrast[index]!)) continue;
      const contrastIncrease = surfaces.reduce((maximum, surface, index) => Math.max(maximum,
        contrast(luminance(emitted.color), luminance(surface!)) / requiredContrast[index]! - 1), 0);
      const candidate = { ...emitted, distance: separation, targetError: Math.abs(separation - policy.targetDistance), contrastIncrease,
        chromaLoss: Math.max(0, origin.c - lab(emitted.color).c) };
      if (!best || candidate.targetError < best.targetError
        || candidate.targetError === best.targetError && candidate.contrastIncrease < best.contrastIncrease
        || candidate.targetError === best.targetError && candidate.contrastIncrease === best.contrastIncrease && candidate.chromaLoss < best.chromaLoss)
        best = candidate;
    }
    if (!best) { decisions.push(fallback(policy.binding, 'no-safe-visible-candidate')); continue; }
    output[index] = Object.freeze({ ...parentBinding, ink: Object.freeze(best.ink) });
    decisions.push(Object.freeze({ binding: policy.binding, status: 'derived', reason: 'selected', separation: best.distance,
      emittedInk: Object.freeze(best.ink) }));
  }
  return Object.freeze({ bindings: Object.freeze(output), decisions: Object.freeze(decisions) });
}
