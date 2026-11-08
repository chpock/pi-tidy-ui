# Palette and semantic rule ownership

The Occipital daemon owns one theme-independent SOURCE parser and one generic STYLE resolver. It accepts validated caller definitions and portable syntax contexts; it does not load, enumerate or select themes. Pi role names, owned-palette IDs, settings and card roles never cross the Occipital wire. See [the protocol reference](../occipital/protocol.md), [source work](work.md) and [provider selection](providers.md).

## One classifier, local color adapters

`src/syntax/semantic-rules.ts` defines the common 44 semantic regions and generic scope rules. Context-qualified rules use the nearest matching owner/boundary while the same Rust scorer retains absolute stack-depth specificity and full-stack exclusions. An inactive qualified rule contributes no winner. TypeScript object-key qualification belongs to this shared rule contract, not Rust language-specific code.

The region slots stay distinct through classification even where an adapter maps several to the same color. `src/syntax/pi-adapter.ts` maps them to public Pi roles and owns Pi-specific marker selection, typography and derived colors. An owned palette instead supplies all 44 foreground bindings from bundled OpenCode **TUI** inputs, without sampling Pi. Neither adapter changes source identity, parsing or geometry. The [TUI correspondence table](opencode-tui-mapping.md) specifies the owned donors, fonts, alpha backdrops and intentional category collapses; it does not claim identical parsers or capture taxonomies.

## Bundled owned palette data

The package contains **64** manifest-owned JSON assets under `src/themes/palettes/`: **32** families with Dark/Light variants. They come from OpenCode `v1.19.5`, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`, `packages/tui/src/theme/assets/`, together with its TUI `getSyntaxRules`. No GUI `packages/ui` donor remains. The built-in TUI catalogue has 33 families; transparent `lucent-orng` is deliberately excluded because a terminal-default card backdrop is not represented by this opaque format. `aura` and `ayu` legitimately resolve to identical Dark/Light colors where upstream supplies no variant distinction; do not invent a Light palette.

The GUI-only families `amoled`, `oc-2`, `onedarkpro` and `shadesofpurple` are absent. Native `opencode` is a distinct family, **not** an alias for `oc-2`. An old removed selection remains saved and follows the ordinary missing-theme notice and whole-card Follow Pi fallback until the user chooses another family; reading never rewrites configuration.

`src/themes/catalogue.ts` owns concrete IDs/labels and the derived family catalogue. Settings carry a family plus a separate remembered variant; `resolveTheme` resolves that pair to a concrete entry such as `github-light`, with identity `owned-palette-v2:<id>`. Follow Pi remembers the variant only for a future owned selection. Loading checks the exact manifest entry before forming a fixed package-relative filename; settings are never arbitrary paths.

Each asset has **revision 2**, its manifest-matching ID/label, provenance (`repository`, pinned commit, exact TUI source path and variant), exactly 44 `regions` and exactly 28 `roles`. A region is a six-digit RGB string or `{foreground,attributes}`. Attributes are unique names from bold, italic, underline, faint and strike. Each card role is exactly `{foreground,background,attributes}`, with opaque six-digit RGB; only `errorFrame` has `['bold']`, all other card attributes are empty. Unknown/missing keys, malformed colors/fonts, old revisions and non-TUI provenance reject the whole file. Runtime data has no alpha, inheritance, palette references, CSS evaluation, custom scope selectors or user-theme directory.

Reads are bounded to **32 KiB** before parsing. The loader checks regular-file status, size and exact bytes read, then validates the full schema before constructing funded tables. Merely opening the theme page or previewing a choice changes local state without reading its asset, preparing card input or starting a provider. The first live card requesting it performs the bounded read. A matching warm owner shares its retained store and funds only a lease header: no reopening, rereading or recompilation. Repeated paint visits perform no input lookup. The menu-only, cold-load, second-owner and settled warm-render I/O/counter controls cover these boundaries.

A missing, corrupt or incomplete asset records a bounded failure/status issue. Runtime health owns notification when configured; the direct notice is used only without that route. Failed replacement retains prior coherent paint; without prior paint it may prepare one complete Follow Pi input, never partial owned colors. Warm visits do not reread a known failure. A new selection/output-mode revision may retry; while whole-card Pi fallback is active, public Pi changes refresh that fallback without rereading the asset. Diagnostics expose neither paths nor contents.

## Palette input ownership and card roles

`PaletteInputOwner` owns weak-cache identity for both adapters. A `PaletteInputLease` is the guarded read capability for bindings, complete roles and compiled ANSI forms. Its caller funds the physical store/handle and adopts cleanup into the ordinary owner lifetime. Reuse requires the same palette ID, revision and terminal mode and an existing live store owner. Historical selections alone retain no tables. A lease for one palette cannot fund another; failed replacement retains the last coherent paint.

The complete local table has **28 roles**: panel/plain/code/output/empty/padding; service/muted/footer/reminder/overflow; diagnostic/title/prompt/frame/error/errorFrame/warning; gutter/numbers; added/removed code, gutter and signs; plus `contextCode` and `contextGutter` for unchanged **diff** rows. Ordinary file rows continue using `code`/`numbers`. The context roles prevent authored diff backgrounds or diff-number inks from leaking into plain source views. Follow Pi assigns them its exact existing code/number styles, preserving its appearance.

The owned parser compiles each role once per cold store/output mode; publication and warm leases reuse that table. Syntax never replaces renderer-owned backgrounds. Ready token paint has normal, context, added and removed surface variants. A token foreground/font remains semantic, while its row selects the prepared structural background. Empty split counterparts and exterior padding remain neutral rather than inheriting a neighboring diff surface.

Owned roles use the authored TUI colors **without `diffPalette`, contrast repair or marker-shade search**. Follow Pi retains its separate existing derivation. Both use the same geometry and flat painter. Cards lacking compatible semantic data still use owned neutral roles, including with Occipital Off/unavailable. Palette choice neither changes Pi's global theme/editor/terminal defaults nor starts native parsing by itself. See [settings](../settings-menu-spec.md), [Follow Pi](follow-pi.md) and [the color model](../color-model.md).

## Semantic region reference

The meanings and final Follow Pi bindings below are independent of TUI authoring. Owned bindings are specified separately in [the correspondence table](opencode-tui-mapping.md). A donor is an offline input, never a runtime parent or fallback.

### Programming-language and source-diff regions

| Region | Meaning | Final Pi binding |
|---|---|---|
| `syntax-comment` | Comments and their markers | `syntaxComment` |
| `syntax-regexp` | Regular-expression string family | `syntaxString` |
| `syntax-string` | String contents, including link titles | `syntaxString` |
| `syntax-keyword` | Keywords/declaration/storage words; dedicated primitive scopes may specialize to type | `syntaxKeyword` |
| `syntax-primitive` | Function/callable names except specialized builtins/commands | `syntaxFunction` |
| `syntax-operator` | Operators, before broad keywords | `syntaxOperator` |
| `syntax-variable` | Variables and shell options/special variables, excluding declaration parameters | `syntaxVariable` |
| `syntax-property` | Grammar-recognized keys, including their quotes/escapes | `syntaxVariable` |
| `syntax-type` | Classes/types and fence language labels | `syntaxType` |
| `syntax-constant` | Other constants after narrower numeric/language/escape rules | `syntaxNumber` |
| `syntax-punctuation` | Generic punctuation except formatting delimiters | `syntaxPunctuation` |
| `syntax-warning` | Lexical deprecated classification | `warning` |
| `syntax-critical` | Lexical illegal classification | `error` |
| `syntax-diff-add` | Inserted source-diff syntax | `toolDiffAdded` |
| `syntax-diff-delete` | Deleted source-diff syntax | `toolDiffRemoved` |
| `syntax-diff-unknown` | Changed source-diff syntax, not an error bucket | `warning` |

### Markdown regions

| Region | Meaning | Final Pi binding |
|---|---|---|
| `markdown-heading` | Recognized heading content | `mdHeading` |
| `markdown-link` | Destinations/URLs, including reference definitions | `mdLinkUrl` |
| `markdown-link-text` | Link labels/reference identifiers | `mdLink` |
| `markdown-code` | Inline raw/code content | `mdCode` |
| `markdown-block-quote` | Quote content | `mdQuote` |
| `markdown-strong` | Strong-text color, independent of bold | `accent` |
| `markdown-horizontal-rule` | Horizontal/thematic break | `mdHr` |
| `markdown-list-item` | Unordered list marker | `mdListBullet` |
| `markdown-list-enumeration` | Ordered list marker | `mdListBullet` |
| `markdown-image` | Inline image destination | `mdLinkUrl` |
| `markdown-image-text` | Image description | `mdLink` |
| `markdown-code-block` | Raw/fenced fallback; embedded syntax may override | `mdCodeBlock` |

### Project-specific regions

| Region | Meaning | Final Pi binding |
|---|---|---|
| `syntax-number` | Numeric literal | `syntaxNumber` |
| `syntax-language-constant` | Grammar-classified true/false/null-like constants | `syntaxKeyword` |
| `syntax-parameter` | Nearest-owner declaration parameter, not named-call/annotation arguments | `syntaxVariable` |
| `syntax-function-builtin` | Explicit builtin function | `syntaxType` |
| `syntax-command` | Shell command name | `syntaxFunction` |
| `syntax-escape` | Escape except key-owned JSON escapes | `syntaxString` |
| `syntax-string-delimiter` | String delimiters except key-owned quotes | exact `syntaxString` |
| `syntax-tag` | Tag names | `syntaxKeyword` |
| `syntax-attribute` | Explicit attributes | `syntaxVariable` |
| `syntax-preprocessor` | Preprocessor/annotation contexts | `syntaxKeyword` |
| `syntax-diff-header` | Diff header/range syntax | `mdHeading` |
| `markdown-heading-marker` | ATX/setext markers | `headingMarker` policy |
| `markdown-code-delimiter` | Inline backticks | `inlineCodeDelimiter` policy |
| `markdown-link-delimiter` | Link/image punctuation | `linkDelimiter` policy |
| `markdown-code-fence` | Block-code fence markers | exact `mdCodeBlockBorder` |
| `markdown-quote-border` | Quote-prefix marker | exact `mdQuoteBorder` |

Reference-definition URLs remain links because the grammar does not encode their consumers. Parameter ownership comes from grammar context, not spelling. See [the rule table](follow-pi.md#semantic-rule-table) for paths/precedence.

## Typography and inactive categories

The winning foreground region owns its foreground and intrinsic fonts; fonts do not accumulate from every enclosing color category. Independent selector typography composes bold/italic/strike and link-label underline. Strike/link delimiters clear only their corresponding bit; bold/italic delimiters inherit semantic foreground rather than generic punctuation. Thus an italic region does not force italic on a deeper token selecting another foreground.

There is no speculative `syntax-object`, success/info syntax category, blanket Markdown-text color, emphasis color or strike color. Neutral text uses its card role; emphasis/strike remain font-only. Unclassified structures are not guessed from text. TUI marker colors copy their mapped parent where TUI defines no separate shade; Follow Pi's marker policy remains separate.

## Authoring provenance and maintenance

The pinned raw TUI inputs, deterministic offline generator, complete donor/alpha tables and regeneration instructions are maintained in [OpenCode TUI mapping](opencode-tui-mapping.md). Update the pin, original inputs, reviewed mapping and generated assets together; never substitute a GUI palette, infer `opencode` from `oc-2`, fabricate a missing variant, or edit the output without updating its correspondence evidence. Preserve the MIT attribution in `src/themes/NOTICE`. The npm package includes that notice and the correspondence chapter alongside all64 runtime assets; the raw source fixtures and offline generator are repository-only authoring inputs.

Regressions must check the built-in catalogue minus the explicit transparency exclusion; all 64 assets and source paths; independently transcribed upstream vectors; every role/region in both output modes; missing-selection behavior; bounded/funded cold loading and warm reuse; actual CLI/replay paint and unchanged source-work counters. Run the affected prepared groups and feature baseline described in [testing](../testing.md). These assets reproduce agreed TUI style inputs on this classifier, not OpenTUI's parser, layout or repeated-alpha painting behavior. The [settings contract](../settings-menu-spec.md#persistence) defines remembered variants and recognized legacy aliases.
