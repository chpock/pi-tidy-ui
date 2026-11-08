# OpenCode TUI palette authoring

The bundled owned palettes are derived from the built-in themes in `anomalyco/opencode` tag `v1.19.5`, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`, under `packages/tui/src/theme`. The corresponding theme index, all 33 raw built-in JSON assets, source metadata and MIT notice are retained in `tests/fixtures/opencode-tui/`. The index is byte-for-byte source data named `theme-index.ts.txt`; tests read it as text rather than compiling or executing upstream code and its OpenTUI imports. Git's path-specific `-text` attribute preserves these source bytes in CRLF checkouts too. `scripts/themes/opencode-tui.mjs` is an offline deterministic authoring tool; it has no runtime, network or dependency role. Its `--write` mode replaces only the uniquely delimited concrete catalogue entries and generates 64 palette assets; existing runtime lookup/family helpers remain hand-maintained. `--check` checks those expected entries/assets and rejects extra JSON palette files. Run `node scripts/themes/opencode-tui.mjs --write` after a reviewed source/mapping update, then `node scripts/themes/opencode-tui.mjs --check` and the prepared tests described in [testing](../testing.md). The tool never fetches source inputs.

The product catalogue includes 32 built-in families as distinct dark/light variants. It removes the former `amoled`, `oc-2`, `onedarkpro`, `shadesofpurple` and `lucent-orng` families, and adds native `opencode`; it does not alias old IDs or rewrite settings. `lucent-orng` remains only as an upstream reference fixture. Both its variants use transparent values for selected required card surfaces, so they cannot be represented by the opaque local card contract without inventing a backdrop. No substitute is selected.

## TUI color resolution and alpha

Each source color is selected from the requested `dark` or `light` variant, then references resolve through `defs` first and `theme` second, matching the pinned TUI resolver. Hex input accepts `#RGB`, `#RGBA`, `#RRGGBB` and `#RRGGBBAA`; the short forms duplicate each nibble and alpha is the final nibble/byte. Named `transparent`/`none` resolve to zero alpha. Missing references, cycles, absent selected modes, and transparent selected inputs fail generation. The source's numeric ANSI color form is also resolved using the pinned standard ANSI palette.

Colors stored in the local palette are opaque lowercase `#rrggbb`. A nonzero-alpha foreground is composited once over its final card-role background; a syntax-region foreground is composited over `backgroundPanel`, since a semantic binding contains no card-surface identity. This is a deliberate single-binding approximation: it does not reproduce a native foreground painted repeatedly over multiple backgrounds. Opaque authored diff backgrounds are copied unchanged. Nonopaque added/removed code backgrounds are composited once over `backgroundPanel`; nonopaque added/removed line-number backgrounds are composited once over opaque `diffContextBg`. These are the OpenTUI integer channel equations (`floor((source * alpha + base * (255 - alpha) + 127) / 255)`). The accepted formula is independently verified against [OpenTUI 0.4.5 `RGBA.fromHex`/`hexToRgb`](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/lib/RGBA.ts#L114-L116) and [hex decoding](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/lib/RGBA.ts#L222-L242), plus [buffer channel blending](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/zig/buffer.zig#L113-L142). Its cell renderer also composites foreground over blended background; this local conversion deliberately stores one composite and does not claim repeated-gutter pixel parity. No contrast correction, luminance test or derived replacement shade is applied.

## Card role donors

The 28 local roles preserve OpenCode's ordinary panel and separate diff surfaces. Every role records an explicit foreground, opaque background and attribute list. `errorFrame` alone has the local role-level `bold` attribute.

| Local role(s) | TUI foreground | TUI background |
|---|---|---|
| `panel`, `plain`, `code`, `output`, `padding` | `text` | `backgroundPanel` |
| `empty`, `prompt`, `gutter`, `service`, `muted`, `footer`, `reminder`, `overflow`, `numbers` | `textMuted` | `backgroundPanel` |
| `title` | `text` | `backgroundPanel` |
| `diagnostic`, `error`, `errorFrame` | `error` | `backgroundPanel` |
| `warning` | `warning` | `backgroundPanel` |
| `frame` | `background` | `backgroundPanel` |
| `contextCode` | `text` | `diffContextBg` |
| `contextGutter` | `diffLineNumber` | `diffContextBg` |
| `addedCode`, `removedCode` | `text` | `diffAddedBg`, `diffRemovedBg` |
| `addedGutter`, `removedGutter` | `diffLineNumber` | `diffAddedLineNumberBg`, `diffRemovedLineNumberBg` |
| `addedSign`, `removedSign` | `diffHighlightAdded`, `diffHighlightRemoved` | `diffAddedLineNumberBg`, `diffRemovedLineNumberBg` |

The role map intentionally keeps ordinary numbers (`textMuted`) distinct from diff line numbers (`diffLineNumber`), and context code/gutter distinct from the panel. No `card` object or GUI palette donor is retained in generated assets.

## Existing 44-region approximation

The common classifier and its 44 categories are unchanged. The mapping is an explicit color/typography approximation of TUI `getSyntaxRules`, not a claim of parser or renderer parity. Color names below are fields in the resolved TUI theme. Any region not listed in a special row uses an empty attribute list.

| Common region(s) | TUI color | Attributes |
|---|---|---|
| `syntax-comment` | `syntaxComment` | italic |
| `syntax-regexp`, `syntax-keyword`, `syntax-escape`, `syntax-preprocessor` | `syntaxKeyword` | keyword/preprocessor italic; regexp/escape plain |
| `syntax-string`, `syntax-string-delimiter` | `syntaxString` | none |
| `syntax-primitive`, `syntax-command` | `syntaxFunction` | none |
| `syntax-operator` | `syntaxOperator` | none |
| `syntax-variable`, `syntax-property`, `syntax-parameter` | `syntaxVariable` | none |
| `syntax-type` | `syntaxType` | none |
| `syntax-constant`, `syntax-number`, `syntax-language-constant` | `syntaxNumber` | none |
| `syntax-punctuation` | `syntaxPunctuation` | none |
| `syntax-warning`, `syntax-critical` | `warning`, `error` | bold |
| `syntax-diff-add`, `syntax-diff-delete`, `syntax-diff-unknown` | `diffAdded`, `diffRemoved`, `diffContext` | none |
| `syntax-function-builtin`, `syntax-tag` | `error` | none |
| `syntax-attribute` | `warning` | none |
| `syntax-diff-header` | `diffHunkHeader` | none |
| `markdown-heading`, `markdown-heading-marker` | `markdownHeading` | bold |
| `markdown-link`, `markdown-image` | `markdownLink` | underline |
| `markdown-link-text`, `markdown-image-text`, `markdown-link-delimiter` | `markdownLinkText` | underline |
| `markdown-code`, `markdown-code-block`, `markdown-code-delimiter`, `markdown-code-fence` | `markdownCode` | none |
| `markdown-block-quote`, `markdown-quote-border` | `markdownBlockQuote` | italic |
| `markdown-strong` | `markdownStrong` | bold |
| `markdown-horizontal-rule` | `markdownHorizontalRule` | none |
| `markdown-list-item`, `markdown-list-enumeration` | `markdownListItem` | none |

The collapsed local taxonomy cannot express every TUI scope difference. For example, TUI's `tag.attribute` uses `syntaxKeyword`, while the common `syntax-attribute` category also contains general `attribute`/`annotation`, which use `warning`; the shared 44-region contract has no narrower tag-attribute slot. Built-in markdown list markers use `markup.list`, so both local list categories use `markdownListItem` rather than treating TUI's separately exposed but unused `markdownListEnumeration` theme color as a donor. Likewise the common categories share TUI colors where their original grammar distinctions are unavailable; link delimiter underline is later cleared by the existing classifier's delimiter rule. This mapping does not add GUI-derived marker shades.

Other deliberate collapses include TUI function declarations versus `function.call`/`method.call` (the latter use `syntaxVariable`, but the local function category uses `syntaxFunction`), specialized import/function/type keywords versus the generic italic keyword category, and builtin versus ordinary type/variable/constant owners. One heading category cannot express the TUI level-one-only underline. Existing emphasis and strikethrough are independent font modifiers, not additional foreground categories, so the palette cannot supply their separate TUI foregrounds. Per-token backgrounds such as inline-code backgrounds are likewise outside the semantic binding contract. These distinctions cannot be reconstructed by replacing palette data alone.

The exact data format, validation and runtime loading contract remains owned by the [palette reference](palettes.md); this chapter documents only the pinned TUI authoring inputs and their mapping.