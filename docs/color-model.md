# Color model and derived surfaces

This is the shared numerical reference for local Follow Pi and native Occipital card colors. The two implementations share numerical building blocks but deliberately have different evidence and fallback rules. [Follow Pi](syntax/follow-pi.md) and [native styles](occipital/styles-and-palettes.md) own their semantic inputs and complete role mappings.

## Derived diff backgrounds

The ready palette contains four prepared diff backgrounds, independent of width and visible source tokens. Follow Pi builds them in `src/diff-palette.ts`; native mode uses `crates/occipital/src/native_palette.rs`. Both preserve syntax foregrounds instead of recoloring tokens to make a tint fit. Their inputs, gutter construction and output-mode guarantees differ as specified below. Per-token backgrounds never replace these structural surfaces; numbers/signs share their prepared gutter, while empty counterparts and alignment blanks use neutral roles. Plain `Created`/`Wrote` source does not paint diff surfaces even though its shared palette prepares those roles.

### Shared numerical policy

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

### Native diff composition

Native mode uses its [own palette and authored hint rules](occipital/styles-and-palettes.md#native-card-palette), not the Pi adapter:

1. For each side, use qualified inserted/deleted background first, otherwise foreground. Presence wins even for a symbolic hint. Without a hint, keep panel for code and native gutter for numbers/signs; their foregrounds remain independently prepared.
2. Derive code from the native panel. Constraints contain base/default foreground plus every distinct declared scope foreground, each requesting4.5. This is a source-independent inventory, not only currently visible/used tokens or five probe colors. Deduplication uses original native `Color` values before normalization.
3. Derive gutter independently from the native gutter, using that full foreground inventory plus prepared numbers at3 and side sign at4.5. Original contrast floors use panel for code, native gutter for gutter.
4. Apply the shared target and bounded search to each base. Failure returns that operation's unchanged base. A non-RGB base, selected hint or any required native foreground vetoes numerical tinting and records terminal-dependent provenance; unlike Follow Pi, unknown constraints are not simply omitted.

Code and gutter do not form a panel → code → shifted-gutter chain. A theme without an independent gutter can therefore produce identical code/gutter surfaces; no artificial separation is imposed. The authored hint background guides restrained derivation rather than becoming the row background verbatim.

The Rust conversion is the Pi TUI/Björn Ottosson sRGB/Oklab matrix port, not OKHSL; it preserves the Oklch hue-normalization round trip. Lightness is clamped to `[0,1]`. Linear RGB within `[-10⁻⁷, 1+10⁻⁷]` counts as in gamut; otherwise 20 bisection steps reduce chroma at fixed lightness/hue, starting from zero. Channels are sRGB-encoded at breakpoint0.0031308, clamped, multiplied by255 and rounded. Native guards inspect those rounded RGB channels. Native derivation has no terminal-mode parameter; later common ANSI compilation can quantize to256 colors, so these guards are **not** a post-256-output contrast guarantee.

### Rationale and limits

Semantic background hints preserve authored intent, including neutral additions that bright sign foregrounds do not encode. Cartesian Oklab bounds lightness/chromatic movement independently and avoids inventing hue through neutral colors. Sign-based Multiply would always darken, leave black unchanged and disproportionately affect light panels; it couples tint lightness to panel channels instead of preserving a restrained displacement.

The goal is subdued code surfaces with readable numbers/signs, not byte-for-byte reconstruction of another application's authored theme. Matching a sign color cannot recreate a different neutral panel. Generated foreground safeguards, tint bounds, error-frame bold and numerical fallbacks are explicit card policy, distinct from authored syntax colors/fonts. An authored low-contrast theme, symbolic colors, faint/font rendering, customized indexed palettes and output quantization do not acquire universal accessibility guarantees. Neutral fallback is valid but does not claim a visually distinct tint.
