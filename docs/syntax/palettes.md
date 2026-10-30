# Palette and semantic rule ownership

The Occipital daemon owns one theme-independent SOURCE parser and one generic STYLE resolver. It accepts validated caller definitions and portable syntax contexts; it does not load, enumerate or select themes. Pi role names, owned-palette IDs, settings and card roles never cross the Occipital wire. The exact v4 contract is [the protocol reference](../occipital/protocol.md); parser and provider lifetimes are described by [source work](work.md) and [provider selection](providers.md).

## One classifier, local color adapters

`src/syntax/semantic-rules.ts` defines the common 44 semantic regions and generic scope rules. Each caller supplies a complete caller-owned definition and its current context/style demand to Occipital. Context-qualified rules use the nearest matching owner/boundary while the same Rust scorer retains absolute stack-depth specificity and full-stack exclusions. An inactive qualified rule contributes no winner. TypeScript object-key qualification and its boundaries are defined in the shared rule contract, not in Rust language-specific code.

The common region slots stay distinct through classification and resolver output even where multiple slots map to the same public Pi color. The Pi adapter in `src/syntax/pi-adapter.ts` performs that final role mapping and keeps Pi-specific marker selection, typography and derived colors outside the classifier. A selected owned palette instead supplies its own 44 foreground bindings and does not sample Pi colors or theme metadata. Neither adapter changes source identity, grammar parsing or geometry.

## Bundled owned palette data

The extension package contains 72 manifest-owned JSON palette files under `src/themes/palettes/`. `src/themes/catalogue.ts` is the authoritative ID/label manifest. A selected ID is looked up there before forming the fixed package-relative asset path; settings values are never concatenated into arbitrary filesystem paths.

Each file has revision 1, its manifest-matching ID and label, provenance (`repository`, pinned commit, source path and light/dark variant), exactly the 44 semantic regions, and exactly these card fields: `background`, `foreground`, `muted`, `dim`, `title`, `border`, `error`, `warning`, `added`, `removed`, `addedBackground` and `removedBackground`. A region is either a six-digit `#rrggbb` string with normal typography or an exact `{foreground,attributes}` object. Attributes are unique names from bold, italic, underline, faint and strike. Card colors are opaque six-digit RGB. Unknown/missing keys, malformed colors, unsupported attributes and invalid provenance reject the whole file. There is no CSS evaluation, alpha, inheritance, palette reference, per-token background, custom scope selector or user-authored theme directory.

Reads are bounded to 32 KiB before parsing. The loader checks the manifest entry, regular-file status, size and exact bytes read, then validates the complete schema before constructing funded input tables. Opening the theme page restores only the saved selection; previewing an owned palette updates local theme state and does not read its JSON asset, prepare card input, or start a provider. The first live card that requests the selected input performs the bounded read. A matching warm owner lookup shares the retained store and funds only a new lease header; it does not reopen, reread, or recompile the asset. A warm owner lookup may still occur when a card asks for its cached input, but repeated paint visits do not perform such lookups. These boundaries are covered by the menu-only, cold-load, second-owner warm-cache, and repeated accepted-visit plus `useful(owner, revision)` render I/O counters in `tests/product/settings/tidy-menu.test.ts` and `tests/product/syntax/syntax-cards.test.ts`. The warm interval settles queued owner work before asserting unchanged file-I/O, lease, preparation-receipt and SOURCE/STYLE counters.

A missing, corrupt or incomplete bundled asset records a bounded failure and status issue. When runtime health is configured, that channel owns the user notification; the palette owner uses a direct notice only when no health notification route is present. A replacement failure retains any prior complete card paint. If there is no prior paint, it can prepare one complete Follow Pi input; partial owned colors are never published. The known-failed asset is not reread on warm visits. A later selected-palette or terminal-mode revision may retry it; while Follow Pi fallback is active, a changed public Pi color object refreshes the fallback input without rereading the failed asset. Diagnostics do not include paths or file contents.

## Palette input ownership and card roles

`PaletteInputOwner` owns weak-cache identity for both Follow Pi and owned palettes. A `PaletteInputLease` is the only guarded read capability for bindings, complete card roles and compiled ANSI forms. Its caller funds the physical input and handle, adopts the cleanup receipt into the existing owner lifetime, and releases it through ordinary card/controller cleanup. Reuse requires the same palette ID, palette revision and terminal color mode. A matching cache entry is reusable only while an owner still holds the store; historical selections alone do not keep input tables alive. Repeated palette changes therefore retain the current card's input, not one store per earlier choice. A lease for one palette is never an input for another; if acquisition of a replacement fails, retain the last coherent paint rather than build a projection from stale bindings. A failed owned asset is visible through extension runtime health/status and is not merely journaled; exactly one notification route is used, preferring runtime health over the direct fallback.

The local adapter expands a selected palette to the complete 26-role card table: panel/plain/code/output/empty/padding; service/muted/footer/reminder/overflow; diagnostic/title/prompt/frame/error/errorFrame/warning; gutter/numbers; and added/removed code, gutter and signs. The owned-palette parser compiles each role once for the current output mode and returns that immutable table with the sampled roles; `PaletteInputOwner` reuses it instead of compiling a second copy when it publishes a funded lease. A warm owner shares the compiled table. The Follow Pi adapter keeps its separate public-role compilation path. Syntax token backgrounds do not replace the structural surfaces owned by the renderer. Cards without a compatible semantic group still use the selected palette's neutral roles, including with Occipital highlighting Off or unavailable.

Owned diff surfaces use the existing `diffPalette` with final output-quantized semantic inks and the authored code foreground as constraints. It preserves already adequate author contrast; it is not a general contrast repair. Pi has its own existing public-role and diff adapter, which remains visually unchanged. Both palettes keep the same geometry and common flat painter.

Palette choice is local UI state, independent of native SOURCE/STYLE availability. Native-highlight Off stops new source work but does not turn an owned palette into Pi or remove its neutral card colors. Follow Pi changes with the public Pi theme through sampled public roles; owned palettes do not change when Pi's theme changes. Neither choice changes Pi's global theme, editor, terminal-default application or terminal color preference. See [settings and menu](../settings-menu-spec.md) and the [Follow Pi adapter](follow-pi.md).

## Semantic region reference

The common classifier keeps these 44 regions distinct even when an adapter maps several of them to the same color. A palette supplies a concrete foreground and optional intrinsic attributes for every row. The Pi column describes the final Follow Pi adapter; marker entries name the existing local marker policy rather than adding slots to the daemon protocol. An initial donor is an authoring input, not a runtime parent or fallback.

### Programming-language and source-diff regions

| Region | Meaning | Final Pi binding | Initial OpenCode donor |
|---|---|---|---|
| `syntax-comment` | Comments, including comment markers | `syntaxComment` | `syntax-comment` |
| `syntax-regexp` | Recognized regular-expression string family | `syntaxString` | `syntax-regexp` |
| `syntax-string` | String contents, including link titles | `syntaxString` | `syntax-string` |
| `syntax-keyword` | Keywords and declaration/storage words. Dedicated primitive-type scopes may specialize to `syntax-type`; Rust's shared `storage.type.rust` remains broad keyword. | `syntaxKeyword` | `syntax-keyword` |
| `syntax-primitive` | Function/callable names and support functions, except specialized builtins and commands | `syntaxFunction` | `syntax-primitive` |
| `syntax-operator` | Operators, specialized before broad keywords | `syntaxOperator` | `syntax-operator` |
| `syntax-variable` | Ordinary variables, shell options/special variables and their delimiters; not declaration parameters | `syntaxVariable` | `syntax-variable` |
| `syntax-property` | Grammar-recognized object/property keys; key text, quotes and escapes stay together | `syntaxVariable` | `syntax-property` |
| `syntax-type` | Classes, types, support types/classes and dedicated primitive-type scopes; fence language labels | `syntaxType` | `syntax-type` |
| `syntax-constant` | Character and other constants after narrower numeric/language/escape rules | `syntaxNumber` | `syntax-constant` |
| `syntax-punctuation` | Generic punctuation except separately classified formatting delimiters | `syntaxPunctuation` | `syntax-punctuation` |
| `syntax-warning` | Lexical deprecated classification, not a tool warning notification | `warning` | `syntax-warning` |
| `syntax-critical` | Lexical illegal classification, not compiler validation | `error` | `syntax-critical` |
| `syntax-diff-add` | Inserted source-diff syntax, including punctuation | `toolDiffAdded` | `syntax-diff-add` |
| `syntax-diff-delete` | Deleted source-diff syntax, including punctuation | `toolDiffRemoved` | `syntax-diff-delete` |
| `syntax-diff-unknown` | Changed source-diff syntax; not an unknown/error bucket | `warning` | `syntax-diff-unknown` |

### Markdown regions

| Region | Meaning | Final Pi binding | Initial OpenCode donor |
|---|---|---|---|
| `markdown-heading` | Recognized heading content | `mdHeading` | `markdown-heading` |
| `markdown-link` | Link destinations and URLs, including shared reference-definition destinations | `mdLinkUrl` | `markdown-link` |
| `markdown-link-text` | Link labels and reference identifiers, including image-reference identifiers | `mdLink` | `markdown-link-text` |
| `markdown-code` | Inline raw/code content | `mdCode` | `markdown-code` |
| `markdown-block-quote` | Quote content | `mdQuote` | `markdown-block-quote` |
| `markdown-strong` | Recognized strong-text color, independent of the bold bit | `accent` | `markdown-strong` |
| `markdown-horizontal-rule` | Horizontal/thematic break | `mdHr` | `markdown-horizontal-rule` |
| `markdown-list-item` | Unordered list marker | `mdListBullet` | `markdown-list-item` |
| `markdown-list-enumeration` | Ordered list marker | `mdListBullet` | `markdown-list-enumeration` |
| `markdown-image` | Inline image destination, not its description or punctuation | `mdLinkUrl` | `markdown-image` |
| `markdown-image-text` | Image description | `mdLink` | `markdown-image-text` |
| `markdown-code-block` | Raw/fenced block fallback; embedded language syntax may override it | `mdCodeBlock` | `markdown-code-block` |

### Project-specific regions

| Region | Meaning | Final Pi binding | Initial authoring donor |
|---|---|---|---|
| `syntax-number` | Numeric literal | `syntaxNumber` | `syntax-constant` |
| `syntax-language-constant` | Grammar-classified language constants such as true/false/null | `syntaxKeyword` | `syntax-constant` |
| `syntax-parameter` | Declaration parameter only when the pinned grammar exposes declaration context. Vocabulary-disjoint nearest-context boundaries prevent named-call/annotation arguments from becoming parameters; a nearer inline-lambda owner may classify its own parameter. | `syntaxVariable` | `syntax-variable` |
| `syntax-function-builtin` | Explicit builtin function | `syntaxType` | `syntax-type` |
| `syntax-command` | Shell command name (`variable.function.shell`) | `syntaxFunction` | `syntax-primitive` |
| `syntax-escape` | Recognized escape except a key-owned JSON escape | `syntaxString` | `syntax-constant` |
| `syntax-string-delimiter` | String delimiters except key-owned quotes | exact `syntaxString` | `syntax-string` |
| `syntax-tag` | Tag names | `syntaxKeyword` | `syntax-keyword` |
| `syntax-attribute` | Explicit attribute names | `syntaxVariable` | `syntax-property` |
| `syntax-preprocessor` | Preprocessor/annotation contexts, subject to nested specific syntax | `syntaxKeyword` | `syntax-keyword` |
| `syntax-diff-header` | Source-diff header/range, including punctuation | `mdHeading` | `markdown-heading` |
| `markdown-heading-marker` | ATX/setext markers | `headingMarker` policy, derived from `mdHeading` when safe | `markdown-heading`, then reviewed marker shade |
| `markdown-code-delimiter` | Inline backticks | `inlineCodeDelimiter` policy, derived from `mdCode` when safe | `markdown-code`, then reviewed marker shade |
| `markdown-link-delimiter` | Link/image brackets and contextual metadata punctuation | `linkDelimiter` policy, derived from `mdLink` when safe | `markdown-link-text`, then reviewed marker shade |
| `markdown-code-fence` | Block-code fence markers | exact `mdCodeBlockBorder` | `syntax-punctuation` |
| `markdown-quote-border` | Quote-prefix marker | exact `mdQuoteBorder` | `markdown-block-quote` |

These assignments define this project's source-highlighting contract; they do not claim that the upstream renderer classifies every construct identically. In particular, shared reference-definition URLs stay links because the pinned grammar does not encode which construct uses the URL. Parameter ownership is determined by the nearest grammar context, not token spelling. See the [Follow Pi rule table](follow-pi.md#semantic-rule-table) for the concrete grammar paths and precedence.

## Typography and intentionally inactive categories

Each palette's region style owns its foreground and optional font attributes. On a token, typography declared by the winning foreground region applies; attributes are not accumulated from every enclosing color category. Intrinsic selector typography composes independently: recognized bold, italic and strike content sets only its own bit, and recognized link labels set underline. Strike and link delimiters clear only their corresponding bit. Bold/italic delimiter scopes inherit the semantic foreground instead of acquiring generic punctuation color. Consequently a region authored italic does not promise italic on a deeper token that selects another foreground.

| Category | Treatment |
|---|---|
| `syntax-object` | No established useful classification; no speculative object rule |
| `syntax-success`, `syntax-info` | May be authoring/card donors, not invented syntax regions |
| `markdown-text` | Neutral card-text donor, not a blanket foreground rule |
| `markdown-emph` | Italic is font-only; no independent emphasis color |
| Strike-color region | Strike is font-only; no independent strike color |

These omissions preserve semantic colors under italic/strike and avoid a blanket source rule replacing the caller's neutral style. Unmatched source inherits its card's neutral code role; unclassified grammar structures are not guessed from their text.

## Card inputs and complete role mapping

Every selected palette is expanded to the full 26-role table. Card roles and syntax-region bindings have separate owners: syntax never paints over renderer-owned surfaces.

| Palette inputs | Card roles |
|---|---|
| `foreground` + `background` | `panel`, `plain`, `code`, `output`, `padding` |
| `muted` | `service`, `muted`, `footer`, `reminder`, `overflow` |
| `dim` | `empty`, `prompt`, `gutter`, `numbers` |
| `title` | `title` and Bash command-neutral |
| `border` | `frame` |
| `error` | `diagnostic`, `error`; `errorFrame` is additionally bold |
| `warning` | `warning` |
| `foreground` + computed added/removed surfaces | `addedCode`, `removedCode` |
| `dim` + computed added/removed gutters | `addedGutter`, `removedGutter` |
| `added` / `removed` + corresponding gutter | `addedSign`, `removedSign` |

The four diff backgrounds use the existing `diffPalette` calculation over final output-quantized semantic inks and neutral code. It preserves already adequate authored contrast; it is not a general contrast repair. `addedBackground` and `removedBackground` are hints, while signs and gutters remain independent roles. See [color mathematics](../color-model.md#owned-palette-diff-composition) for the exact constraints and output-mode checks.

## Authoring provenance and maintenance

The initial literal palette set was authored from `anomalyco/opencode` commit `76e1f5b0cc4e529c732eebb0bade0893a3db8bee`, under `packages/ui/src/theme` (not its TUI themes). Each asset records its exact repository, commit, source path and light/dark variant. This provenance identifies an authoring input; it does not imply runtime fetching, inheritance or continued parity with upstream. For the initial full palettes, a donor copies the complete normalized style, including intrinsic attributes. Later edits remain explicit independent RGB/style entries.

Initial card-input donors are an explicit project mapping:

| Owned card input | Initial donor |
|---|---|
| `background` | Resolved `background-stronger` |
| `foreground` | `text-base` |
| `muted` / `dim` / `title` | `text-weak` / `text-weaker` / `text-strong` |
| `border` | `border-base` |
| `error` / `warning` | `syntax-critical` / `syntax-warning` |
| `added` / `removed` signs | `text-diff-add-base` / `text-diff-delete-base` |
| `addedBackground` / `removedBackground` hints | `surface-diff-add-base` / `surface-diff-delete-base` |

When adding or updating an asset:

1. Pin the upstream repository commit, exact file path and variant; resolve references with that source's actual resolver and dependency closure. Record the provenance in the JSON. Do not infer values from screenshots or silently substitute a missing donor.
2. Resolve expressions before authoring. Preserve alpha during resolution, composite foregrounds onto the chosen opaque code-card background and transparent surfaces onto their declared base, then store only literal opaque RGB. Keep all 44 region entries explicit and retain only the intended per-region font attributes.
3. For a new ID, add a stable manifest-owned entry in `src/themes/catalogue.ts` and its complete `src/themes/palettes/<id>.json` file. Update an existing file as a complete palette; do not add runtime parent palettes, CSS evaluation, scope selectors or an arbitrary user-theme directory. The package has no runtime importer or upstream lookup.
4. Preserve the shared RGB marker policy: any authored marker shade must be safe across truecolor and 256-color output; if no one shared shade passes the required surfaces and neighbors, retain its parent color. Runtime owned palettes do not search for marker shades.
5. Run the affected prepared `test:group` contracts and the syntax `test:feature` baseline from [the testing guide](../testing.md), including complete manifest/data and packaged-file checks. Retain the asset provenance and validation evidence with the change.

The 72 bundled variants are reviewed data, not a promise of exact rendering parity with the donor application. The full style input is package-local and bounded at load time; it is validated before its funded tables are retained. User settings select only a manifest-owned ID.