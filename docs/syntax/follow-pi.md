# Follow Pi palette

Follow Pi highlights **source inside Bash/edit/write cards** using the selected Pi theme. It does not style Pi's rendered conversational Markdown, change editor/footer colors, or inject rules into native Syntect themes. It is one theme choice, not a collection of legacy/palette-expansion modes.

The purpose is to expose useful structure already present in the parser's contexts without replacing the theme's identity. A distinct parser scope does not automatically deserve a new color. Primary Pi colors remain exact, including deliberately equal or low-contrast colors; only three explicitly selected structural roles derive additional foregrounds. Parameters are not less important than variables, and literal values are not made faint merely to increase the number of distinguishable classes.

## Data flow and ownership

1. Occipital parses source into **contexts**: complete ordered scope stacks, independent of theme or terminal width.
2. `createPiRuleDefinition` in `src/syntax/pi-rules.ts` supplies a static client rule definition. Occipital validates its names against the generated trusted vocabulary and resolves it with the same Rust resolver used by native themes. TypeScript never matches scopes during painting. An unknown trusted name rejects the entire client definition before selector construction/interning; this STYLE rejection does not itself trigger SOURCE work and does not imply that independent SOURCE work has never run.
3. The resolver returns expressions referring to generic numbered **binding slots**, not RGB values or daemon-owned Pi color names. A binding is an internal mapping to a public Pi role; it is not a new theme token users must configure.
4. `samplePiPalette` samples public Pi colors and typography, fixes the card/diff **surfaces** (actual row backgrounds), and then chooses optional structural foregrounds. The result is detached immutable data.
5. `materializeStyle` combines expressions, bindings and the caller's neutral style. `compileStyleAnsi` prepares truecolor/256-color output. The existing common flat painter consumes those prepared styles and stored geometry.

This separation makes local Pi palette changes reuse parsed contexts and resolved binding expressions. Changing declarations or slot layout changes the rules fingerprint and can require missing STYLE work; changing only sampled colors does not. No source text, visible-token scan, per-source palette, second parser, terminal-color query or paint-time color calculation is involved.

## Direct bindings and trustworthy inputs

There are **24 direct public bindings**: `syntaxComment`, `syntaxKeyword`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxFunction`, `syntaxVariable`, `syntaxOperator`, `syntaxPunctuation`, `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdQuote`, `mdListBullet`, `mdHr`, `mdQuoteBorder`, `mdCodeBlockBorder`, `error`, `warning`, `toolDiffAdded`, `toolDiffRemoved`, and `accent`. Four additional local slots describe `headingMarker`, `stringDelimiter`, `inlineCodeDelimiter`, and `linkDelimiter`: 28 slots total. `stringDelimiter` is intentionally not a generated color.

`samplePiPrefix` reads the public `getFgAnsi`/`getBgAnsi` result, preserving literal RGB, authored ANSI indices, terminal-default and font attributes. Empty/reset prefixes preserve their real meaning; unsupported or malformed prefixes fail instead of becoming guessed colors. `theme.colors` is used only to establish public concrete-versus-indexed provenance. It is not authoritative for the apparent color of terminal-default or faint text: Pi may expose a guessed default or an approximation of faint there.

Numeric color work requires a known concrete authored color, a non-default sampled ink, and no faint attribute. In particular:

- A user-authored indexed role stays indexed, even if the conventional xterm palette would give it an RGB value.
- An authored concrete color quantized to an index in 256-color mode remains eligible; comparisons use that emitted index interpreted through Pi's conventional palette model. This does not query or guarantee the terminal's possibly customized palette.
- Faint is typography, not a darker RGB ink to transform again. A faint marker parent is preserved exactly, including faint, rather than deriving from Pi's approximation.
- A faint indexed donor is never promoted to a known RGB constraint after composition removes faint: public color conversion may already have lost its provenance.
- A known color is canonicalized through actual emission before it becomes a derivation origin. Raw out-of-gamut OKLCH coordinates are not necessarily the displayed parent.

Direct bindings are never regenerated from those numeric comparisons. Failure to derive a marker retains its exact sampled parent representation, not a reconstructed approximation.

## Semantic rule table

The following tables describe the current declarations, not proposed distinctions. Names match trusted scope prefixes; `[A, B]` denotes an ordered path in the full context, not two independent tests. More deeply nested classifications and more specific selectors compete through native specificity. An earlier ancestor rule alone cannot defeat a deeper generic string rule, which is why JSON keys use explicit contextual paths.

Every foreground rule except the invalid/deprecated rules excludes `invalid.illegal` and `invalid.deprecated`. This keeps nested ordinary classifications from painting over lexical invalidity. Null foreground/font properties mean inheritance, not reset. Equal matching scores retain the first applicable declaration; foreground, background and each font bit have independent winners.

### Programming languages and source diff syntax

| Parser classification | Foreground binding | Meaning and exceptions |
| --- | --- | --- |
| `comment`, `punctuation.definition.comment` | `syntaxComment` | Comment markers remain in the comment family; documentation-comment subclasses need no extra attenuation. |
| `string`, `constant.character.escape` | `syntaxString` | String contents and escapes remain one readable literal family. |
| `punctuation.definition.string` | `stringDelimiter` = exact `syntaxString` | Quotes stay part of the literal; no generated quote shade. |
| `[meta.mapping.key.json, string]`, `[meta.mapping.key.json, punctuation.definition.string]`, `[meta.mapping.key.json, constant.character.escape]` | `syntaxVariable` | JSON property text, quotes and escapes stay in the key family; string values remain strings. |
| `variable.function.shell` | `syntaxFunction` | Shell command names are not ordinary variables. |
| `punctuation.definition.variable.shell`, `punctuation.definition.parameter.shell`, `punctuation.section.expansion.parameter` | `syntaxVariable` | Shell variable/parameter delimiters stay with their variable. |
| `variable`, `entity.other.attribute-name` | `syntaxVariable` | Includes function parameters, shell options/switches and special shell variables through their emitted variable scopes. These deliberately share variable prominence, not a weaker derivative or keyword color. |
| `keyword.operator` | `syntaxOperator` | Narrow operator specialization rather than broad keyword paint. |
| `keyword`, `storage.modifier`, `storage.type`, `storage.type.function` | `syntaxKeyword` | Declaration/storage/keyword families. More specific primitive-type rules below retain type color. |
| `entity.name.tag` | `syntaxKeyword` | HTML tag names differ from punctuation; attributes use the variable family. |
| `constant.language` | `syntaxKeyword` | Language constants such as booleans/null differ from numeric literals. |
| `constant.numeric`, `constant.character` | `syntaxNumber` | Numeric/character constants retain the number family; the escape specialization above stays string-colored. |
| `entity.name.function`, `support.function` | `syntaxFunction` | Function names/support functions, except the more specific builtin rule. |
| `support.function.builtin` | `syntaxType` | Builtins deliberately retain the existing type family; not every function subclass gets a new color. |
| `entity.name.type`, `entity.name.class`, `support.type`, `support.class`, `storage.type.primitive` | `syntaxType` | Type/class/primitive family. |
| `meta.preprocessor`, `meta.annotation` | `syntaxKeyword` | Preprocessor/annotation regions retain keyword semantics, subject to nested scope resolution. |
| `punctuation` | `syntaxPunctuation` | Generic fallback, excluding bold/italic/strikethrough delimiters so their enclosing semantic foreground can survive. |
| `invalid.illegal`, `invalid.deprecated` | `error`, `warning` respectively | Foreground only: not compiler validation, a notification, a failed tool result or an error stripe. |
| `markup.inserted`, `[markup.inserted, punctuation]` | `toolDiffAdded` | Syntax of a diff file, not an edit-card background operation. |
| `markup.deleted`, `[markup.deleted, punctuation]` | `toolDiffRemoved` | Deleted source-diff text and its punctuation. |
| `markup.changed`, `[markup.changed, punctuation]` | `warning` | Changed source-diff text and its punctuation. |
| `meta.diff.header`, `[meta.diff.header, punctuation]`, `meta.diff.range`, `[meta.diff.range, punctuation]` | `mdHeading` | Diff headers/ranges retain the heading family. |

Unmatched parsed source inherits the caller's neutral code role: `toolTitle` for Bash, `toolOutput` for ordinary files. The table does not inspect token spellings to manufacture missing grammar distinctions.

### Markdown content and structural markers

| Parser classification | Foreground / typography | Reason or boundary |
| --- | --- | --- |
| `markup.heading` | Exact `mdHeading`; set bold | Applies to recognized heading content, independently of marker generation. |
| `punctuation.definition.heading` | `headingMarker`, derived from `mdHeading` when eligible | Recognized ATX/setext marker scopes get a stronger small-glyph distinction; no dependency on list colors or generic punctuation. |
| `markup.bold.markdown` | Exact `accent` | Both `**…**` and `__…__` use the same trusted classification. Enclosing-marker foreground is inherited; there is no spelling-based split. |
| `markup.bold`, `markup.italic` | Inherit foreground; set only bold or italic respectively | Font composition remains independent of semantic color, including more specific nested links/code. |
| `markup.strikethrough` | Inherit foreground; set only strike | Actual terminal strikethrough, not a dim-color imitation. |
| `punctuation.definition.strikethrough` | Inherit foreground; clear only strike | Separately scoped opening/closing `~~` stay unstruck without clearing surrounding bold/italic/underline. |
| `markup.underline.link` | `mdLinkUrl`; set underline | Link destinations whose grammar emits the underline-link scope. |
| `string.other.link` | `mdLinkUrl` | URL/string destinations; no extra font patch is invented when that is the only emitted classification. |
| `string.other.link.description.title` | `syntaxString` | Optional link title is a string, not a destination or label. |
| `meta.link.inline.description.markdown`, `meta.link.reference.description.markdown`, `meta.link.reference.literal.description.markdown` | `mdLink`; set underline | Inline, reference and literal-reference link labels. |
| `meta.image.inline.description.markdown`, `meta.image.reference.description.markdown` | `mdLink` | Image descriptions use link ink without the link-label underline patch. |
| `constant.other.reference.link` | `mdLink` | Reference identifiers remain in the link family. |
| `punctuation.definition.link`, `punctuation.definition.image` | `linkDelimiter`; clear only underline | Brackets/markers remain subordinate to content and preserve other enclosing font bits. |
| `[meta.link.inline.markdown, punctuation.definition.metadata]`, `[meta.image.inline.markdown, punctuation.definition.metadata]`, `[meta.link.reference, punctuation.definition.constant]` | `linkDelimiter`; clear only underline | Contextual closing/metadata/reference punctuation follows the same policy. |
| `markup.raw` | Exact `mdCode` | Inline-code contents retain their authored code color. |
| `markup.raw.block`, `markup.raw.code-fence` | Exact `mdCodeBlock` | Block-code fallback; embedded language scopes can supply their own more specific syntax. |
| `punctuation.definition.raw` | `inlineCodeDelimiter`, derived from `mdCode` when eligible | Backticks use a restrained policy, including repeated delimiters where the grammar emits them. |
| `punctuation.definition.raw.code-fence` | Exact `mdCodeBlockBorder` | Fence specialization wins over the inline delimiter rule; it already has a dedicated Pi role. |
| `constant.other.language-name.markdown` | `syntaxType` | The fence's language label is a type-like identifier, not fence punctuation. |
| `markup.quote`, `punctuation.definition.blockquote` | `mdQuote`, `mdQuoteBorder` respectively | Quote content/border use their own authored roles. |
| `markup.list.numbered.bullet`, `markup.list.unnumbered.bullet`, `punctuation.definition.list_item` | Exact `mdListBullet` | Lists remain independent from headings even when a theme gives their source roles equal colors. |
| `meta.separator`, `punctuation.definition.thematic-break` | Exact `mdHr` | Horizontal/thematic breaks retain their dedicated role. |

Bold/italic delimiter scopes are excluded from generic punctuation coloring; there is no attempt to transform an arbitrary enclosing winning foreground through a fixed binding. Such a transform would require a separate scope matcher or a product of rules for every nesting combination. Inheritance and independent font masks provide the intended behavior instead. Ordinary headings remain `mdHeading`; explicit Markdown bold inside a heading can select `accent`, and still-deeper semantic contexts resolve normally.

## Structural foreground policy and algorithm

The four internal marker slots are intentionally not four unique colors. String quotes use exact `syntaxString`: a separate shade fragments literals without providing a useful structural cue. Dedicated list, quote and fence roles remain exact. Only headings, inline code and links need generated foregrounds, each from its own semantic parent; borrowing an unrelated punctuation/list/accent role would lose that relationship to the selected theme.

Distances below are Euclidean distances in **OKLab** over the final emitted colors, not RGB distances. Candidates change **OKLCH lightness** while retaining parent hue/chroma as far as gamut mapping permits. There is no injected hue for neutral parents.

| Local slot | Parent ink and typography | Required adjacent colors | Minimum / target / maximum distance from parent | Candidate offsets |
| --- | --- | --- | --- | --- |
| `headingMarker` | `mdHeading` | `mdHeading`: at least 0.12 | 0.12 / 0.22 / 0.30 | ±0.005 through ±0.300 (120 attempts) |
| `inlineCodeDelimiter` | `mdCode` | `mdCode`: at least 0.07 | 0.07 / 0.09 / 0.12 | ±0.005 through ±0.120 (48 attempts) |
| `linkDelimiter` | `mdLink` | `mdLink`: at least 0.07; `mdLinkUrl` and `toolOutput`: at least 0.055 each | 0.07 / 0.10 / 0.14 | ±0.005 through ±0.140 (56 attempts) |
| `stringDelimiter` | `syntaxString` | No numeric derivation | Exact parent | None |

Small heading marks need substantially stronger separation than inline punctuation. One universal weak distance floor can change RGB numerically without producing a useful visible distinction. Conversely, applying heading strength to every quote/backtick would create alternating color noise. The role table encodes these different purposes rather than inferring policy from a theme's name or dark/light label.

Subordination does not require moving ink toward the background. A primary color may already have little contrast headroom, so compulsory attenuation can leave every candidate unusable. Bidirectional search allows a delimiter to gain contrast without changing its parent. A low-contrast parent is not an automatic veto: the optional candidate must independently meet 4.5:1, while the primary color remains untouched.

For each generated slot, `derivePiMarkerVariants`:

1. Requires a trustworthy emitted parent, every listed neighbor, and all three frozen code surfaces: ordinary panel, added-code background and removed-code background. A missing input makes only that role fall back; it does not recolor primary content or borrow a different role.
2. Starts with the emitted parent converted to OKLab/OKLCH. Tries the fixed lightness grid in ascending step order, negative then positive. Candidates outside `0 < L < 1` are skipped; the grid is not expanded until something fits.
3. Gamut-maps and encodes each candidate through the installed Pi TUI output routines **before** measuring it. Both parent-distance bounds and neighbor-distance floors apply to these final emitted colors. A 256-color candidate that collapses onto its parent/neighbor is rejected, not counted as a distinct RGB success.
4. Requires at least **4.5:1** contrast against every frozen surface, using sRGB relative luminance and `(lighter + 0.05) / (darker + 0.05)`. Optional markers do not inherit the lower readability floor of an already-low-contrast primary color.
5. Ranks surviving candidates by smallest absolute error from the role's target distance, then lowest maximum relative contrast surplus over 4.5 across the surfaces, then smallest loss of chroma. Exact remaining ties keep the first candidate. The result is deterministic; high contrast alone cannot waive sibling separation.
6. Replaces only the binding's foreground ink. Its parent typography and explicit attribute mask stay unchanged. If no candidate survives, the whole original parent binding is retained exactly.

The configured grid contains **224** candidate offsets across the three policies. Actual evaluation may be smaller: unavailable inputs skip a role, and out-of-range lightness values skip an offset. Scratch funding covers the complete grid; rejected candidates never create additional searches. Preparation records one decision per generated role: `selected`, `unknown-parent`, `unknown-neighbor`, `unknown-surface`, or `no-safe-visible-candidate`. Selected decisions also carry final ink and separation; fallback is an explicit outcome, not hidden success.

## Card surfaces and why they precede markers

`samplePiPalette` first samples exact direct roles. The ordinary card background is the public `toolPendingBg`. For a concrete panel it derives added/removed code and gutter surfaces using `toolSuccessBg`/`toolErrorBg` hints and the [bounded diff algorithm](../color-model.md#derived-diff-backgrounds). A terminal-default, authored-indexed or otherwise unprovable panel stays literal with no invented tint. An unusable side hint leaves only that side on the ordinary panel.

The background constraints include every numerically evaluable direct semantic binding and neutral file `toolOutput`, regardless of the visible source. This includes Markdown, invalid/deprecated and source-diff inks, not only `syntax*`. Bash neutral `toolTitle` does not constrain file diff surfaces because it never paints their code. Known code/sign colors require 4.5:1, numbers 3:1, each capped at its existing emitted-panel contrast so an authored low-contrast foreground is not repaired or made worse by a tint. Unknown/default/indexed/faint foregrounds supply no guessed numeric constraint; their literal output remains intact and they do not globally veto otherwise valid surfaces. That is partial numeric coverage, not evidence that unknown contrasts passed.

Only after those direct constraints produce final emitted backgrounds are marker candidates evaluated. Otherwise an optional foreground near the contrast floor could force a useful added/removed tint back to the panel, sacrificing structural diff cues to decorate punctuation. Markers therefore adapt to surfaces, never the reverse: no iterative refitting, primary-ink correction or source-dependent invalidation cycle.

All 26 Pi card roles are materialized together. Their foreground sources are:

| Card roles | Public Pi foreground |
| --- | --- |
| `panel`, `plain`, `code`, `output`, `padding`, `addedCode`, `removedCode` | `toolOutput` |
| `empty`, `overflow`, `prompt`, `gutter`, `numbers`, `addedGutter`, `removedGutter` | `dim` |
| `service`, `muted`, `footer`, `reminder` | `muted` |
| `diagnostic`, `error`, `errorFrame` | `error` |
| `title` | `toolTitle` |
| `frame` | `borderMuted` |
| `warning` | `warning` |
| `addedSign`, `removedSign` | `toolDiffAdded`, `toolDiffRemoved` respectively |

Roles use the ordinary panel except the added/removed code, gutter and sign roles, which use their corresponding prepared diff surfaces. Signs share the gutter background. Bash's source caller separately chooses the title role for neutral code. Token background declarations never override these structural backgrounds. Plain file cards do not paint diff surfaces, although the common palette prepares all roles independently of card type.

## Typography, strikethrough and compatibility

The common expression model has five independent bits: bold **1**, italic **2**, underline **4**, faint **8**, strike **16**. `attributes` is a subset of `attribute_mask`, both bounded by **31**. Null font means no declaration; mask zero inherits; a set mask bit with zero value explicitly clears that property. Rust maintains five separate font winners alongside foreground/background scores so one emphasis property does not erase the others. Resolver workspace accounting uses the actual `size_of::<Scored>()`; unchanged wire field widths do not hide the larger in-memory winner state.

Materialization starts from the caller's attributes, applies the selected foreground binding's explicit typography, then applies selector masks last. The patch is `(inherited & ~mask) | attributes`. A background binding supplies color only. Direct public bindings have a full mask: selecting a normally styled role must clear inherited faint/bold rather than accidentally carrying it forward. Marker derivation preserves this parent mask, and explicit link-delimiter underline clearing applies afterward.

`markup.strikethrough` sets only `16/16`; separately scoped strike delimiters clear only `0/16`. The common ANSI compiler normalizes every span with `22;23;24;29`, then emits enabled fonts, including SGR9. Closing restores that full font reset and default background/foreground. SGR22 clears bold/faint only, not strike. The Pi ANSI-to-flat converter and public-prefix sampler preserve SGR9/29, full SGR0 and selective resets; this preserves typography actually returned by fallback, not scope information it never supplied.

This vocabulary is the **exact resolver revision2** interpretation of protocol3 / `syntax-highlight/v3`. Context, palette and client-definition structural revisions remain1. Effective client-rules/native-rules/native-palette hash domains are NUL-terminated `/2` domains; immutable native theme-definition fingerprints are unchanged. Both transports reject mismatched resolver revisions before STYLE admission, rather than silently widening an older four-bit interpretation. Source contexts and geometry did not require a new format. See the [wire contract](../occipital/protocol.md).

Native themes use full mask31 and explicitly clear unsupported strike, without changing their authored colors or enabled native font bits. They do not sample Pi-specific bindings or receive Follow Pi rules. A native-theme Pi palette change therefore performs no Follow Pi preparation. Actual SGR9 appearance still depends on the terminal and font; color-only imitation is not a fallback.

## Reuse, funding and limits

`PiInputOwner` observes the public `theme.colors` object through a weak reference and advances a local palette revision when that identity changes. The immutable input store is keyed by that revision and terminal output mode. A weak cache alone cannot keep it alive: an eligible cache hit requires existing live owners and funds only a new handle, without resampling, generating candidates or recompiling card roles.

`preparePiInput` reserves the complete fixed input, handle and operation scratch through the existing `DataBudget` before sampling. Its current accounting is:

| Allocation | Policy bytes |
| --- | --- |
| Each input handle | 256 |
| Shared immutable store | `512 + bindingCount × 256 + cardRoleCount × 1024` = **34,304** for 28 bindings and 26 roles |
| Variant scratch | `1024 + 224 × 256` = **58,368** |
| Complete cold-operation scratch | `8192 + directBindingCount × 256 + variantScratch` = **72,704** for 24 direct bindings |
| Each scoped read | 256 temporary bytes in addition to its pinned store/handle |

Cold preparation therefore funds **107,264** policy bytes before sampling; its operation scratch is released afterward. A cache hit funds only the new 256-byte handle. These are allocation-policy units, not measured process RSS. Allocation denial returns no prepared input; it never publishes a partially generated palette or starts an unbounded retry/cache. A scoped visit whose temporary charge is denied returns `false`. Scoped reads pin their data while visited and invalidate escaped readers afterward; cleanup receipts release the numeric charges without retaining the Theme, UI owner or source text.

Palette publication includes bindings, complete card roles and all affected code segments atomically. Theme changes reuse source/scopes and glyph geometry; width changes reuse stored glyph widths. Warm frames do no Pi sampling, candidate search, SOURCE/STYLE dispatch or measurement. Returning to a still-owned cached style/palette can reuse it; eviction or loss of ownership can require preparation again. The [storage and charge-lifetime rules](storage.md) and [per-card publication rules](work.md#sealing-and-publishing-one-card) apply equally to Follow Pi and native presentations.

Numeric guards do not guarantee universal visual quality. Low-contrast primary colors remain low contrast; authored equality, terminal defaults, faint, custom indexed palettes, gamut mapping and quantization may prevent a safe distinct marker. Unrecognized grammar structures stay neutral rather than being guessed from text. In particular, the pinned grammar leaves an indented ATX heading inside a list unclassified as a heading; adjacent recognized headings and list markers still follow independent rules. Public-Pi ANSI fallback has lower semantic granularity and cannot recreate these native contexts from already-colored text. These are behavior boundaries, not claims that arbitrary terminals or grammars have been visually certified.

## Related implementation

[Client work and publication](work.md), [prepared cards and the common painter](prepared-cards.md), [shared color mathematics](../color-model.md), and the [native resolver](../occipital/styles-and-palettes.md) explain the surrounding mechanisms. Return to the [internal manual](../README.md).
