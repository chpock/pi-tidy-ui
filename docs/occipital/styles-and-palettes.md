# Rules, style resolution and native palettes

Occipital resolves complete ordered scope contexts against either a native theme or caller-supplied declarations. Both use one property resolver. Binding indices are generic caller inputs; Pi role selection belongs to the [Follow Pi client](../syntax/follow-pi.md), not the daemon. Exact declarations and expression encoding are in the [protocol](protocol.md#rule-input-and-style-resolution).

## Compiling both rule sources into one resolver

`style_request.rs` selects either an immutable native definition or caller-supplied declarations. Native selection checks the advertised ID and definition fingerprint. Caller rules pass through `style_rules.rs::ClientRulePlan`, which inspects the complete definition before constructing selectors.

Caller paths contain trusted scope names, not arbitrary text to pass to Syntect’s global interner. Inspection validates every name by lookup in the generated vocabulary and measures paths, exclusions and allocation cost. Only after the worker reserves the plan does compilation convert those names into native scope handles and `ScopeSelector` objects.

Both inputs become `resolver.rs::Rule` values: a selector and optional foreground, background and font changes, together with a base expression. Caller bindings remain numeric expression slots. The daemon neither selects their current RGB values nor translates them into Pi roles.

Native compilation converts the theme’s terminal-color convention into the same ink representation. A native font declaration becomes a complete replacement of supported font state, including explicit clears for attributes that the native theme format does not enable. A missing font declaration remains different from an explicit normal-font declaration.

## Property winners, masks and ties

Matching is per property rather than “choose one winning rule for the whole style.” The scorer has seven scores: foreground, background and five independent font attributes.

A declaration changes a property only when it supplies that property and its match score is strictly greater than the current score. For fonts, its mask first determines which bits it owns; its value determines whether each owned bit is enabled or cleared. An explicit clear can therefore defeat an inherited enabled bit without changing unrelated font attributes.

Each winning property records its declaration index and whether the selector has a nonempty path. Native palette derivation uses that provenance to distinguish an authored semantic hint from a default or global-selector result. Merely finding a matching rule is not enough: the property must actually win.

The resolver partitions rules into:

- Single-scope selectors that can be matched by scope-prefix comparison.
- General selectors requiring the native full-path matcher, including exclusions.

Single-scope rules are ordered by descending scope specificity with stable declaration order for equal specificity. General selectors retain their declaration order. Strict-greater replacement preserves a previous winner on an equal score. This ordering is part of compatibility with native matching, not an opportunity to sort rules arbitrarily for convenience.

For a single-scope selector, a match means its dot-separated atoms are a prefix of the scope at that stack position. Its score is `selector_atom_count × 2^(ATOM_LEN_BITS × depth)`, where the outermost scope has depth zero and Syntect 5.3.0 uses `ATOM_LEN_BITS = 3`. Specificity therefore includes **where** a scope matches, not only how many atoms its selector names. For `[source.rust, meta.function.rust, entity.name.function.rust]`, `source.rust` scores `2` at depth zero, while `entity` scores `64` at depth two. For a property supplied by both, the latter wins despite having fewer atoms.

Single-scope scoring runs first, accumulating inherited property winners from the outermost scope inward. General selectors then use Syntect's full-path matcher and apply their returned scores to a copy of that accumulated state. An equal-score general selector does not replace an already selected single-scope property: the same strict-greater comparison applies across partitions. Among equally specific single rules, or equal-score general rules, the earlier applicable declaration retains its property. Fonts still compete independently under their masks; winning foreground does not imply winning all font bits.

A parsed-empty context is a deliberate special case. It returns the base expression rather than evaluating global selectors against an empty stack. Unclassified context zero never enters this resolver.

## Reusing adjacent context prefixes

A resolver **cursor** is request-local working storage for a sequence of contexts. It holds the preceding scope path and the scored state at each of its ancestor prefixes.

For the next context, `Cursor::resolve` finds the common prefix with the previous path and truncates the retained ancestor states to that prefix. Only the changed suffix needs new single-scope scoring. For example, moving from `[A, B, C]` to `[A, B, D]` reuses the scored states for `[A]` and `[A, B]`, then scores `D`.

General selectors still run against the complete current path. Their results are applied to a copy of the last ancestor state, not stored as reusable prefix state: an exclusion or multi-scope match may depend on later parts of the path.

The cursor’s maximum depth and workspace are calculated and funded before allocation. Depth is also checked before external selector calls. The optimization is a bounded local stack, not a process-wide context cache or a second selector implementation.

## STYLE progress and expression interning

`style_work.rs::StyleWork` owns expanded context IDs, a cursor, reusable native-path scratch, the growing result and its DATA credit. Its cursor shares immutable compiled rules without borrowing from a movable job structure.

Each scheduler turn converts one admitted context to native handles, resolves it, and appends the resulting style ID to the output indices. It does not touch parser leases or source text. A STYLE failure consequently does not erase the SOURCE parse that supplied those contexts.

The result has one table of unique complete expressions. **Interning** here means reusing a reply-local table entry after exact expression equality; it does not mean adding caller text to Syntect’s global scope repository. Equality includes both inks and font value/mask. Visually similar expressions with different bindings or explicit-clear authority are not interchangeable.

A new unique expression is charged before the result vector and deduplication map grow. Repeated expressions reuse the existing ID. The decoded-result charge and controlled allocation credit remain distinct checks.

Native palette expressions are installed through that same interning path before requested contexts are processed. Palette slots and syntax-context indices therefore refer to one expression table, and equal expressions can be shared between them. The palette is not another painter or a second wire-style representation.

On successful completion, `StyleWork::finish` returns the result together with the original physical credit for bounded encoding and delivery. On failure, partial payloads are destroyed while that credit returns to the scheduler’s error path. Finishing or abandoning a result body alone must not release the physical request slot early.

## Prepared native definitions and their owners

There are three different forms of native-theme ownership:

1. `profile.rs` provides immutable native themes. Bundled profiles are loaded lazily and retained in a process-wide cache.
2. `catalogue.rs` publishes a snapshot of available IDs, fingerprints and admitted custom profiles.
3. `native_definitions.rs` prepares a worker-local resolver and native palette for a selected advertised identity.

A worker does not eagerly compile the complete catalogue. `NativeDefinitions::prepare` first verifies that the requested ID and fingerprint are still advertised. A cache hit clones the existing prepared owner; it does not rerun palette derivation.

A miss measures retained definition storage, preparation scratch and any cache-vector replacement. The requesting DATA job prepays these costs. Retained definition bytes move into a separate credit owned by the prepared definition; cache metadata receives its own transferred allowance. Scratch allowance is released after preparation. Old and new vector capacity remain funded while a replacement buffer is being installed.

A `PreparedDefinition` is a shared owning handle, not a detachable uncredited resolver. Running `StyleWork` retains one until its cursor and payloads are destroyed. Catalogue publication removes cached entries whose ID/fingerprint is no longer advertised, but existing borrowers can finish against their immutable old definition. Removing an entry is therefore not necessarily the moment its memory is released.

Publication does not clear SOURCE state. Parser continuations depend on source and grammar identity, not on a theme.

## How native palette construction is composed

`native_palette.rs::NativeTheme::compile` builds the common resolver and resolves the fixed hint paths listed below. It retains each winning property’s explicit-path provenance, then derives the complete role palette from the theme’s defaults, settings and those hints.

The derivation prepares a candidate foreground inventory and the theme’s complete default/declared syntax-ink inventory once. Secondary/service foreground selection uses the former. Native diff-surface constraints use the latter; they are not reduced to the consumer’s semantic roles or to colors observed in one source file.

The selected code surfaces and gutter surfaces are separate compositions. Gutter constraints additionally include the prepared number and sign inks. The [color model](../color-model.md) defines the numerical search, contrast and output limitations; the role mapping below defines how its results are assigned. These are complementary parts of one palette construction, not two competing algorithms.

The derived palette contains expressions and per-role provenance. It has no source context, viewport width, Pi theme color or terminal RGB query as an input. Symbolic native colors remain symbolic where the construction cannot make a numerical claim. Derived provenance is not a certificate that every native syntax foreground meets a contrast target.

The worker stores this complete palette beside the compiled resolver. Later STYLE requests copy its expressions into their own indexed results; they do not derive the palette again for each context.

## Native card palette

An independent native theme supplies the entire Bash/edit/write card interior. Occipital derives its palette once from the selected immutable definition, without source text, Pi colors, terminal RGB queries or scanning other themes. Missing secondary settings are resolved from that definition; they do not permit Pi-colored service text inside a native card. Missing syntax uses the ready native neutral code role.

### Defaults and authored hints

The native base follows Syntect's default style: foreground `F` is `ThemeSettings.foreground` or opaque black; panel `P` is `ThemeSettings.background` or opaque white; the base font is normal. Gutter `G` is `ThemeSettings.gutter` or `P`. These are fixed native defaults, not guesses from the terminal or light/dark mode.

Native color alpha follows the terminal encoding convention: alpha `0` means indexed color with the index in the red channel; `1` means terminal default; `2…255` means opaque RGB. There is no alpha blending, including for values 2…254. Indexed/default colors remain symbolic; palette derivation does not turn them into guessed RGB to manufacture a contrast proof.

The same property resolver used for syntax evaluates five fixed ordered scope stacks:

| Hint | Scope stack |
|---|---|
| Comment | `[comment]` |
| Invalid/error | `[invalid]` |
| Changed/warning | `[source.diff, markup.changed.diff]` |
| Inserted | `[source.diff, markup.inserted.diff]` |
| Deleted | `[source.diff, markup.deleted.diff]` |

A property qualifies as an authored hint only when its winning declaration has a nonempty selector path. Inherited defaults and winning global/empty selectors do not qualify. A broader matching nonempty selector does qualify; it need not spell the most specific probe name. Foreground, background and each font bit have independent winners. Font hints retain only enabled bits whose winners are explicit. Presence takes precedence over numerical usability: an explicit indexed inserted background still precedes an RGB inserted foreground.

### Secondary foreground selection

Write `R(preferred, surface, minimum)` for the native foreground safeguard. If either color is non-RGB, or preferred contrast already meets the minimum, preserve the preferred color. Otherwise select the greatest-contrast candidate against that surface, replacing the preferred color only for a strict improvement. The preferred wins equal scores; otherwise the first best candidate wins. A replacement is marked derived even if its bytes came from another authored field.

The fixed candidate order is:

1. Base foreground, then panel background.
2. Present color settings in this order: `accent`, `active_guide`, `background`, `bracket_contents_foreground`, `brackets_background`, `brackets_foreground`, `caret`, `find_highlight`, `find_highlight_foreground`, `foreground`, `guide`, `gutter`, `gutter_foreground`, `highlight`, `inactive_selection`, `inactive_selection_foreground`, `line_highlight`, `minimap_border`, `misspelling`, `selection`, `selection_border`, `selection_foreground`, `shadow`, `stack_guide`, `tags_foreground`.
3. Explicit hint foreground followed by background, in changed, comment, deleted, inserted, invalid order.
4. Default foreground and distinct declared scope foregrounds in theme order.

Non-RGB candidates have no numerical score. Selection does not interpolate a new foreground or stop at the first candidate meeting the floor. If none meets it, return the best available improvement or the original preferred color. This safeguards secondary/service/sign choices; it does not repair native syntax or the base foreground. Guide/selection settings are possible readability candidates, not unconditional card-role assignments.

### Complete native role mapping

In the following table, `first(...)` means the first present value, without skipping symbolic colors. `commentFG`, `invalidFG`, `changedFG`, `insertedFG` and `deletedFG` are qualified hints from the preceding section.

| Prepared foreground | Anchor and safeguard |
|---|---|
| Secondary | `R(first(commentFG, F), P, 3.0)` |
| Title | `R(first(accent, F), P, 3.0)` |
| Frame | `R(first(accent, commentFG, F), P, 3.0)` |
| Error | `R(first(invalidFG, changedFG, F), P, 4.5)` |
| Warning | `R(first(changedFG, prepared Error), P, 4.5)` |
| Numbers | `R(first(gutter_foreground, commentFG, F), G, 3.0)` |
| Prompt | `R(F, P, 3.0)` |
| Added sign | `R(first(insertedFG, F), G, 4.5)` |
| Removed sign | `R(first(deletedFG, F), G, 4.5)` |

All 26 card roles are assigned as follows. Added/removed surfaces use the [separate native diff construction](../color-model.md#native-diff-composition).

| Roles | Foreground | Background | Enabled fonts |
|---|---|---|---|
| `panel`, `plain`, `code`, `output`, `empty`, `padding` | `F` | `P` | None |
| `service`, `muted`, `footer`, `reminder`, `overflow`, `diagnostic` | Secondary | `P` | None |
| `title` | Title | `P` | None |
| `prompt` | Prompt | `P` | None |
| `frame` | Frame | `P` | None |
| `error` | Error | `P` | Explicit invalid-hint fonts |
| `errorFrame` | Error | `P` | Explicit invalid-hint fonts plus bold |
| `warning` | Warning | `P` | Explicit changed-hint fonts |
| `gutter`, `numbers` | Numbers | `G` | None |
| `addedCode` | `F` | Added-code surface | None |
| `addedGutter` | Numbers | Added-gutter surface | None |
| `addedSign` | Added sign | Added-gutter surface | Explicit inserted-hint fonts |
| `removedCode` | `F` | Removed-code surface | None |
| `removedGutter` | Numbers | Removed-gutter surface | None |
| `removedSign` | Removed sign | Removed-gutter surface | Explicit deleted-hint fonts |

Font selection is independent of foreground fallback: an error foreground may come from the changed hint while its font still comes only from the invalid hint. Secondary text does not inherit comment italics. Native declarations enable bold, italic and underline; all palette roles have full mask31, explicitly clearing unsupported faint/strike and inherited fonts. Only `errorFrame` adds generated bold; native frame/title roles are not automatically bold.

Role names are presentation slots, not Pi role aliases. Native `diagnostic` is secondary text; Follow Pi binds it to Pi `error`. Bash neutral command text uses `title`, but its description uses `service`; successful file headings use `muted`.

### Provenance and definition reuse

Foreground/background origins are separate: **0** means authored/default/unchanged fallback, **1** means numerical tint or foreground readability replacement, and **2** means terminal-dependent. Origin2 also covers an RGB base retained because a required tint input was nonnumerical. Derived does not imply novel RGB bytes; provenance is not a contrast-pass certificate.

The origin byte stores foreground in bits0–1, background in bits2–3 and generated-font status in bit4. All non-RGB colors encode origin2. Only `errorFrame` sets generated-font status. Wire encoding and masks are defined in the [v3 reference](protocol.md).

Only selected native definitions are compiled. Cache identity is theme ID plus definition fingerprint; unchanged entries are reused, and catalogue publication removes entries no longer advertised with that identity. Existing borrowers can finish against their obsolete immutable definition. The palette identity hashes the `occipital-native-palette/2` domain, NUL and the definition fingerprint string; source text, current contexts, Pi colors and width are not inputs. Compilation, palette derivation and retained owners use the same prepaid native budget rather than an unaccounted secondary cache.

Implementation: `crates/occipital/src/{resolver,native_palette,native_definitions,style_rules}.rs`. Numerical safeguards and their output-mode limits are specified under [derived diff backgrounds](../color-model.md#derived-diff-backgrounds).
