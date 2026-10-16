import { colorToOklch, colorToRgb, oklchColor, rgbColor, type Color } from "@earendil-works/pi-tui";
import type { CardTheme } from "./card-theme.ts";

type Lab = { l: number; a: number; b: number };
type Ink = { luminance: number; minimum: number };
export type DiffPalette = Partial<Record<"toolDiffAdded" | "toolDiffRemoved", { code: Color; gutter: Color }>>;
const lightnessStep = 0.025, colorStep = 0.018;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function lab(color: Color): Lab {
  const { l, c, h } = colorToOklch(color), angle = h * Math.PI / 180;
  return { l, a: c * Math.cos(angle), b: c * Math.sin(angle) };
}
function concrete(color: Color): Color {
  const { r, g, b } = colorToRgb(color);
  return rgbColor(r, g, b);
}
function paint({ l, a, b }: Lab): Color {
  return concrete(oklchColor(clamp(l), Math.hypot(a, b), Math.atan2(b, a) * 180 / Math.PI));
}
function luminance(color: Color): number {
  const { r, g, b } = colorToRgb(color);
  const channel = (value: number) => value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: number, b: number): number { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
function ink(color: Color, base: number, minimum: number): Ink {
  const value = luminance(color);
  return { luminance: value, minimum: Math.min(minimum, contrast(value, base)) };
}
function readability(color: Color, inks: readonly Ink[]): number {
  const value = luminance(color);
  return inks.reduce((score, item) => Math.min(score, contrast(value, item.luminance) / item.minimum), Infinity);
}
/** Keep chromatic intent while correcting lightness; only checked, quantized RGB is returned. */
function readable(target: Lab, origin: Lab, fallback: Color, inks: readonly Ink[]): Color {
  const valid = (color: Color) => {
    const actual = lab(color);
    // Gamut mapping can move chroma much farther than the intended small step.
    return Math.abs(actual.l - origin.l) <= lightnessStep + 0.002
      && Math.hypot(actual.a - origin.a, actual.b - origin.b) <= colorStep + 0.003
      && readability(color, inks) >= 1;
  };
  const initial = paint(target);
  if (valid(initial)) return initial;
  const ends = [clamp(origin.l - lightnessStep), clamp(origin.l + lightnessStep)]
    .sort((a, b) => Math.abs(a - target.l) - Math.abs(b - target.l));
  for (const end of ends) {
    let result = paint({ ...target, l: end });
    if (!valid(result)) continue;
    let failed = target.l, accepted = end;
    for (let i = 0; i < 12; i++) {
      const middle = (failed + accepted) / 2, candidate = paint({ ...target, l: middle });
      if (valid(candidate)) { accepted = middle; result = candidate; }
      else failed = middle;
    }
    return result;
  }
  // Conflicting/low-contrast inks need not admit a tinted background.
  return fallback;
}

/** Four small, theme-derived surfaces per diff build; no per-row math or retained owners. */
export function diffPalette(colors: NonNullable<CardTheme["colors"]>): DiffPalette {
  if (!colors.toolPendingBg) return {};
  const baseColor = concrete(colors.toolPendingBg), base = lab(baseColor), baseLight = luminance(baseColor);
  const codeInks = Object.entries(colors).filter(([role]) => role === "toolOutput" || role.startsWith("syntax"))
    .flatMap(([, color]) => color ? [ink(color, baseLight, 4.5)] : []);
  const result: DiffPalette = {};
  for (const [role, hint] of [["toolDiffAdded", colors.toolSuccessBg], ["toolDiffRemoved", colors.toolErrorBg]] as const) {
    if (!hint) { result[role] = { code: baseColor, gutter: baseColor }; continue; }
    const semantic = lab(concrete(hint));
    const da = semantic.a - base.a, db = semantic.b - base.b;
    const amount = Math.min(1, colorStep / (Math.hypot(da, db) || 1));
    const target = { l: base.l + Math.max(-lightnessStep, Math.min(lightnessStep, semantic.l - base.l)),
      a: base.a + da * amount, b: base.b + db * amount };
    const code = readable(target, base, baseColor, codeInks), body = lab(code);
    const gutterInks: Ink[] = [];
    if (colors.dim) gutterInks.push(ink(colors.dim, baseLight, 3));
    const sign = colors[role];
    if (sign) gutterInks.push(ink(sign, baseLight, 4.5));
    const candidates = [-lightnessStep, lightnessStep].map(offset => ({ ...body, l: clamp(body.l + offset) }))
      .sort((a, b) => readability(paint(b), gutterInks) - readability(paint(a), gutterInks));
    const gutter = gutterInks.length ? readable(candidates[0]!, body, baseColor, gutterInks) : code;
    result[role] = { code, gutter };
  }
  return result;
}
