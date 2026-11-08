# Color model and derived surfaces

This is the numerical reference for local Follow Pi derivation and authored TUI palette surfaces. Both use the extension's output color conversion; **only Follow Pi** uses `diffPalette`. Owned themes retain their explicit TUI surfaces without contrast correction. [Follow Pi](syntax/follow-pi.md), [palette ownership](syntax/palettes.md) and [TUI correspondence](syntax/opencode-tui-mapping.md) define their inputs and role mappings.

## Derived diff backgrounds

Follow Pi prepares four derived added/removed code/gutter backgrounds through `src/diff-palette.ts`, independently of width and visible tokens. Its unchanged diff code/numbers retain their ordinary styles. Owned themes instead prepare explicit context/added/removed code/gutter backgrounds from TUI data. Occipital resolves semantic rules/styles, never palette surfaces. Token backgrounds cannot replace structural rows; signs use their side's gutter, while empty counterparts and alignment blanks remain neutral. Plain source views use ordinary code/number styles, not diff-context roles.

### Follow Pi numerical policy

Contrast uses sRGB relative luminance. Normalize an 8-bit channel to `x = channel / 255`, then:

```text
linear(x) = x / 12.92                    if x ≤ 0.04045
            ((x + 0.055) / 1.055)^2.4   otherwise
Y = 0.2126 × linear(r) + 0.7152 × linear(g) + 0.0722 × linear(b)
contrast(a,b) = (max(Ya,Yb) + 0.05) / (min(Ya,Yb) + 0.05)
floor = min(requested minimum, contrast(foreground, original anchor))
```

A candidate passes when every constraint's `candidateContrast / floor ≥ 1`. This can reduce previously high contrast while retaining the requested floor; it does not promise to improve every authored contrast.

Convert the base and semantic hint to Cartesian Oklab `(L,a,b)` and `(Lh,ah,bh)`. The restrained target is:

```text
d = hypot(ah-a, bh-b)
t = min(1, 0.018 / (d == 0 ? 1 : d))
target = (L + clamp(Lh-L, -0.025, +0.025), a + (ah-a) × t, b + (bh-b) × t)
```

This bounds chromatic displacement, not absolute saturation; neutral hints are valid, and there is no mandatory red/green hue or minimum tint strength. After conversion, actual displacement from the operation's anchor must satisfy `|ΔL| ≤ 0.027` and `hypot(Δa,Δb) ≤ 0.021`. The extra 0.002/0.003 allow gamut/rounding/quantization effects; they are not extra requested movement.

Test the initial target. If it fails, try lightness endpoints `clamp(anchor L − 0.025)` and `clamp(anchor L + 0.025)`, nearest to target first; ties retain the lower endpoint first. For the first passing endpoint, perform exactly 12 bisection steps between failed target lightness and accepted endpoint, retaining only passing results. Chromatic coordinates stay fixed. If neither endpoint passes, return the operation's original fallback. This bounded search is not exhaustive and never forces an unchecked distinction.

### Follow Pi diff composition

1. `toolPendingBg` is the panel; `toolSuccessBg`/`toolErrorBg` supply added/removed hints. If the panel is not numerically known, retain its sampled literal ink. If a side's hint is unusable or missing, return the panel for both code and gutter immediately; known number/sign inks do not independently create that gutter.
2. Derive code from the panel, constrained by neutral file `toolOutput` and every numerically evaluable direct Follow Pi semantic foreground, not just `syntax*`, at requested minimum4.5. Unknown foregrounds contribute no guessed RGB constraint but do not globally veto tinting; the [provenance rules](syntax/follow-pi.md#card-surfaces-and-why-they-precede-markers) also exclude faint indexed donors.
3. Build gutter constraints from known `dim` numbers (minimum3) and the side's `toolDiffAdded`/`toolDiffRemoved` sign (minimum4.5). Their original contrast floors use the ordinary panel, not derived code.
4. Start gutter geometry from the derived code surface. Consider clamped lightness shifts −0.025/+0.025 with its chromatic coordinates unchanged. Rank directions by worst normalized number/sign contrast; ties retain the negative direction. Ranking uses converted RGB before terminal quantization; final admission uses emitted output.
5. Run the bounded readable search with code as displacement anchor but the original panel as fallback. Consequently gutter displacement is relative to code, not a second bound against the panel. Code inks constrain code; gutter search independently constrains numbers/signs.
6. If neither number nor sign is numerically known, reuse derived code unchanged instead of seeking gutter separation.

Every candidate is passed through the selected terminal encoder before final displacement/contrast validation, including actual 256-color quantization. Numeric interpretation of emitted indices uses Pi's conventional indexed-palette model, not terminal queries or proof about custom terminal palette entries. Returning the panel object preserves its exact sampled literal ink rather than reconstructing it from RGB.

Role foregrounds and enabled fonts come from their mapped public foreground roles; background prefixes provide surface colors, not typography. Generated surfaces change neither. The finished panel/added-code/removed-code surfaces are frozen before optional marker derivation; markers must fit those surfaces, never refit them. No per-row color math or visible-token-based constraint selection occurs.

### Owned palette diff composition

Owned revision-2 assets contain all 28 opaque role styles. Ordinary code/panel use TUI `backgroundPanel`; diff context uses `diffContextBg`; added/removed content and gutters use their respective authored diff fields. Ordinary numbers use `textMuted`, diff numbers use `diffLineNumber`, and signs use `diffHighlightAdded`/`diffHighlightRemoved`. The separate context roles prevent those values from recoloring plain file views.

Authoring resolves source references/variants and composites nonzero alpha once over the declared opaque surface, with nearest-integer channel rounding. The [mapping table](syntax/opencode-tui-mapping.md) records each backdrop and the limits of this normalization; fully transparent `lucent-orng` is excluded. Runtime loading performs only validation, terminal output conversion and one compilation per role. It does not derive tint, search contrast, adjust foregrounds or invent a missing variant. Truecolor retains the authored literal RGB; 256-color uses the common encoder without a contrast-repair pass. Low authored contrast is preserved, not certified as readable.

Follow Pi's derivation uses Pi TUI's sRGB/Oklab routines, not OKHSL. Its displacement/contrast checks describe the application encoder, not a terminal's customized indexed palette. Owned palettes share output conversion but none of that numerical admission policy.

### Rationale and limits

Semantic background hints preserve authored intent, including neutral additions that bright sign foregrounds do not encode. Cartesian Oklab bounds lightness/chromatic movement independently and avoids inventing hue through neutral colors. Sign-based Multiply would always darken, leave black unchanged and disproportionately affect light panels; it couples tint lightness to panel channels instead of preserving a restrained displacement.

Follow Pi's goal is subdued code surfaces with readable numbers/signs, not reconstruction of another application's authored theme. Owned palettes instead preserve the selected TUI inputs, even when they have lower contrast. Matching a sign color cannot recreate a different neutral panel. Generated foreground safeguards, tint bounds, error-frame bold and numerical fallbacks are explicit card policy, distinct from authored syntax colors/fonts. An authored low-contrast theme, symbolic colors, faint/font rendering, customized indexed palettes and output quantization do not acquire universal accessibility guarantees. Neutral fallback is valid but does not claim a visually distinct tint.
