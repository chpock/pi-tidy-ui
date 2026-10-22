# Follow Pi semantic palette — implementation plan

Status: **A7 role-derived palette implementation and affected documentation are complete. The common feature baseline and real native/shared CLI matrix pass; source and visual reviews found no implementation defects.** The visual review confirms a clear marker/title difference in the normal-size candidate versus weak T2 and same-parent output, but does not establish greater prominence than the prior cream marker or identical rasterization in the operator's Foot terminal. A1 and A3–A5 remain authoritative; A7 corrects the role-color boundary from A2 and supersedes A6's no-generation interpretation. Current behavior is described by the maintained syntax spec. Prior T1/T2/T3 acceptance is historical and does not establish acceptance of this correction. Evidence and limitations are in `.test-artifacts/follow-pi-role-derived/verification.md`. Commits, pushes and publication remain unauthorized.

Planning baseline: `cefc6867c7f7897ce89a19640b482e2675795992`. This plan covers Follow Pi source highlighting in Bash/edit/write cards, not Pi's rendered conversational Markdown, editor/footer colors, or native Syntect themes. Code references below describe the baseline, not implemented changes.

## 1. Goal and decision surface

Use the scope distinctions already retained by Occipital to make Follow Pi source easier to read while preserving the selected Pi theme's visual identity. Where Pi has no suitable dedicated color for a meaningful structural role, derive a related color from that element's own semantically associated Pi theme color. Preserve primary authored colors. The goal is useful structural distinction, not the number of colors.

Recommended architectural shape:

- Keep Syntect parsing and full-stack rule matching in Occipital. Keep local public Pi sampling and explicit semantic ink bindings in the existing UI input adapter. Keep the one flat painter.
- Treat the richer behavior as a revision of Follow Pi, not a second parser, a new native profile, or a new settings subsystem. The operator approved this architecture in A4; no legacy/extra user-selectable mode is added.
- Use static semantic binding declarations independent of light/dark appearance. Only binding values change when the Pi palette changes.
- Choose a color source and transformation policy by semantic role. A generated marker color must derive from its own related Pi role; do not substitute an unrelated existing role such as generic punctuation merely because it differs. Heading and list markers have independent sources and rules.
- Generate a bounded set of related foreground candidates when a role lacks a suitable dedicated Pi color. Tune separation to the role and its neighboring content: small structural marks need stronger distinction than delimiters that should read as part of a literal. Preserve exact direct Pi bindings; do not impose one universal shade or distance rule.
- Derive/freeze diff surfaces from exact direct theme inks first; then prepare bounded role-derived foregrounds and check them against the frozen emitted surfaces. Check final colors and font attributes after output quantization; no color math or source-dependent work in render.
- Colors/new generic bindings alone do not require a wire extension. Actual Markdown strikethrough is now included by explicit operator decision and requires an explicitly versioned font-contract extension, coordinated producer/consumer validation and reset behavior (section 4.5). Do not silently widen the old advertised interpretation.

No Pi-core changes, new dependencies, new terminal queries or terminal-default color changes, new configuration fields, grammar upgrades, publications, tags, commits or pushes are part of this plan's authorization.

## 2. Evidence and terminology

### Checked planning baseline

- `src/syntax/pi-rules.ts`: 42 rules, 17 direct public-role bindings; broad `variable`, `string`, `punctuation`, `comment`, `keyword` mappings.
- `src/syntax/pi-bindings.ts`: public ANSI sampling preserves default/indexed colors and faint; `theme.colors` alone cannot distinguish terminal guesses or faithful faint rendering.
- `src/syntax/pi-input.ts`, `pi-input-owner.ts`: one funded immutable input table per palette revision/output mode; weak reuse, no owner retention.
- `src/syntax/pi-palette.ts`, `src/diff-palette.ts`: Pi card surfaces are prepared locally; diff currently constrains `toolOutput` and public `syntax*` colors, not all Markdown/new bindings.
- `src/syntax/style-materialization.ts`, `style-ansi.ts`: binding typography precedes explicit selector masks; token backgrounds do not own structural row backgrounds; truecolor/256 output compilation is outside render.
- `crates/occipital/src/resolver.rs`: full ordered context, depth-sensitive native specificity, first declaration wins ties, per-property inheritance.
- `crates/occipital/vocabulary_build.rs`: only trusted shipped scope names/prefixes may appear in client selectors.
- `crates/occipital/tests/theme_resolver.rs`: actual parser examples distinguish parameters, variables, attributes, strings, escapes and delimiters; Markdown tests exercise nested styles.
- `protocol/syntax-v3/README.md`: generic client slots already support this palette change; font mask/value are currently limited to four bits (0..15).
- Public Pi 1.0 theme/TUI source and types: `mdQuoteBorder`, `mdCodeBlockBorder`, OKLCH conversions, gamut mapping and output quantization already exist.
- Pinned upstream grammar source: [Sublime Packages revision used by bat 0.26.1](https://github.com/sublimehq/Packages/tree/759d6eed9b4beed87e602a23303a121c3a6c2fb3), checked together with bat's Markdown patches. This is representative evidence, not a claim of all-language coverage.
- Color mechanisms: [CSS Color 4 / Oklab and OKLCH](https://www.w3.org/TR/css-color-4/#ok-lab), [interpolation](https://www.w3.org/TR/css-color-4/#interpolation-space), [chroma reduction](https://www.w3.org/TR/css-color-4/#GM-chroma), [WCAG contrast explanation](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum), [xterm palette/default semantics](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html).

### Terms

- **Scope/context:** parser classification and full ancestor stack, independent of palette.
- **Semantic binding:** an extension-internal slot selected by a static rule; not a new public Pi theme token or daemon-owned role enum.
- **Direct binding:** exact sampled Pi role, including symbolic ink and typography.
- **Derived binding:** a foreground computed from one explicitly chosen Pi theme role for a structural semantic role, with typography still owned by the original semantic parent. The derivative does not mutate that primary theme color or copy donor font attributes.
- **Surface:** actual structural panel/added/removed background; not terminal appearance, HTML export background or token background.
- **Readable:** passes the declared numeric screen plus visual review; not a universal accessibility claim.

No new glossary/ADR file is needed: these terms fit the existing syntax contract. The operator-approved architecture is reversible; approval does not claim implemented or shipped behavior.

## 3. Coverage contract

For every row, implementation first records actual contexts from the pinned parser and verifies trusted selector membership. A conventional TextMate name or an upstream grammar match by itself is not a passing runtime test. New broad rules must not erase embedded-language or nested-link/code semantics.

| Family | Planned result | Color/attribute policy |
| --- | --- | --- |
| ATX/setext heading markers vs title | Target actual heading marker scopes separately, preserving heading levels/context | Title keeps its exact `mdHeading` color. If Pi has no suitable dedicated marker color, derive the marker shade from `mdHeading`, retaining heading typography; calibrate for a small glyph against its title. Independent of list rules. Never substitute `syntaxPunctuation` or a list color for the derivative. |
| Quote marker | Map the parser-emitted blockquote marker | Keep the dedicated `mdQuoteBorder` if it works. Otherwise derive from this blockquote-specific Pi color using its own visual threshold; do not substitute heading/list colors. |
| Fenced code delimiters and language label | Target actual fence scopes and language label where emitted | Keep `mdCodeBlockBorder` if it works. Otherwise derive from this code-block-specific Pi color using its own threshold, separate from inline-code and heading policy. `syntaxType` remains the language label; embedded code keeps its language styles. |
| Inline code delimiter | Target actual inline `punctuation.definition.raw` without overriding code-fence specialization | If no suitable dedicated delimiter color exists, derive from `mdCode`; preserve delimiter typography. Calibrate separately from large code text so the ticks remain visible but do not make code content appear fragmented. |
| Bold/italic source delimiters | Exclude actual emphasis delimiter scopes from generic punctuation rules so enclosing semantic foreground can win; preserve existing emphasis masks | Keep inherited semantic color unless whole-source tests demonstrate a useful separate derivative. Any derivative uses the enclosing semantic color as its source and cannot require a per-nesting rule product. Test opening/closing and nested contexts. |
| Links and images | Cover inline/reference labels, image descriptions, destinations, reference identifiers, titles and their delimiters where grammar distinguishes them | Labels/alt text use exact `mdLink`; URLs use `mdLinkUrl`; identifiers use the link family; titles use the string family. If punctuation lacks a suitable dedicated color, derive its shade from the associated link color, preserving existing underline boundaries and clearing only underline on punctuation, not enclosing bold/italic. |
| Strings, delimiters, escapes | Keep content, quote and escape identities distinct where the parser does | Content uses exact `syntaxString`; test quote/escape derivatives from that string color only when actual small-size examples become clearer without breaking the literal into noisy fragments. Context-specific JSON key overrides stay `syntaxVariable`. |
| Function parameters | Keep an explicit `variable.parameter` policy with shell option/switch specialization as needed | Intentionally share authored `syntaxVariable` with ordinary variables; being a parameter is not a reason to reduce prominence |
| Bash command names | Specialize actual `variable.function.shell` | `syntaxFunction`, separate from shell variables; actual `support.function.builtin` retains the current `syntaxType` family, deliberately |
| Bash options/special variables | Cover actual `variable.parameter.option`, `variable.parameter.switch`, `variable.language` and delimiter contexts | Options/special variables intentionally share authored `syntaxVariable`; distinguish them from command names without demoting them or implying special variables are keywords. No token-spelling inference |
| JSON keys vs values | Match key context plus nested string context so general `string` cannot win by deeper stack position | Keys use property/attribute family based on `syntaxVariable`; string values keep `syntaxString`; quoted key delimiters follow key policy |
| HTML tag names vs delimiters/attributes | Give `entity.name.tag` a meaningful binding distinct from generic punctuation | Tag name uses `syntaxKeyword`; attributes use `syntaxVariable`; `<`, `>` remain syntax punctuation |
| Language constants vs numbers | Specialize `constant.language` | Booleans/null use existing `syntaxKeyword`; numeric constants keep `syntaxNumber`. No attenuation of literal values |
| Lexically invalid/deprecated regions | Add explicit `invalid.illegal` / `invalid.deprecated` mapping with nested-context controls | Existing `error` / `warning`; foreground-only, no notification, no tool-error state/stripe and no claim of compiler validation |
| Diff file contents | Cover `markup.inserted`, `markup.deleted`, `markup.changed`, headers/ranges and their source punctuation | Existing `toolDiffAdded`, `toolDiffRemoved`, `warning` and suitable neutral/heading roles; no token backgrounds and no change to edit diff computation |
| Keyword subclasses, documentation comments, builtin/type subclasses | Preserve demonstrated semantic identities but avoid a separate shade for every subclass | Keep current primary keyword/comment/type families unless corpus evidence identifies a concrete readability failure; this is an intentional equivalence, not forgotten coverage |
| Explicit Markdown bold | Match trusted `markup.bold.markdown` for both `**…**` and `__…__`; retain the independent bold font rule | Use exact public Pi `accent`, including inherited emphasis-delimiter ink. Ordinary heading text stays `mdHeading`; deeper semantic scopes follow the existing resolver. Native themes and public-Pi fallback are unchanged. |
| Strikethrough | Implement actual `markup.strikethrough` typography through the common resolver and painter, using pinned-parser context evidence | Real SGR 9/29, independent font bit and explicit reset; nested bold/italic/link colors remain valid; delimiters inherit foreground and clear only strike where separately scoped. No dim-color imitation or text rewriting; section 4.5 |

The table is the delivery inventory. Each row must end as implemented, intentionally equivalent with rationale, or explicitly excluded by the operator. No silent narrowing from the previous analysis.

## 4. Proposed color mechanism

### 4.1 Direct sampling, semantic sources and derived slots

Keep the 23 exact direct Pi bindings. Keep the four existing delimiter slots and add a finite binding slot only when a parser-backed structural role needs its own generated foreground. Each direct public theme color remains untouched. Every derived slot explicitly records:

- the one semantically related Pi theme role from which its color is derived;
- the neighboring content color against which the marker must read as a separate structure;
- the original typography owner and existing selector font masks;
- the role's visual-size class and its own accepted separation/contrast policy;
- an explicit exact-parent fallback and a recorded reason when no usable variant exists.

Initial source/neighbor decisions, to verify against actual pinned parser output and theme samples:

| Structural role | Pi color source | Compare against | Policy |
| --- | --- | --- | --- |
| Heading `#`/setext marker | `mdHeading` | Heading text | Strong separation: tiny marker, especially the reported `##` case. Never use generic punctuation or a list color as its source. |
| List marker | `mdListBullet` | List body text | Independent list policy and binding. Keep the direct role if it already reads well; if derivation is needed, derive from this list-specific role, never `mdHeading`. |
| Blockquote marker | `mdQuoteBorder` | Quoted text | Keep the dedicated border role if it works. Otherwise derive from this blockquote-specific Pi color using its own visual threshold; do not substitute heading/list roles. |
| Fenced-code marker | `mdCodeBlockBorder` | Code content | Keep the dedicated border role if it works. Otherwise derive from this code-block-specific Pi color using its own threshold, separate from inline-code and heading policies. |
| Inline-code delimiter | `mdCode` | Inline code text | Make tiny ticks legible; do not make the code body look fragmented. |
| String quote/escape | `syntaxString` | Literal content | Derive only if full-literal examples become clearer without noisy fragmentation. |
| Link/image/reference punctuation | The semantically related link color (normally `mdLink`) | Label, destination and surrounding text as emitted | Distinct from label/URL colors, without visually dominating dense link syntax; preserve underline boundaries. |

This is a semantic source table, not a promise that every row receives a unique RGB value. First verify whether a dedicated Pi role already works for that element. Derive only a real gap; preserve useful dedicated roles and intentional equivalences. Heading/list roles remain independently declared even when a particular theme happens to author their source colors identically. Do not repurpose one marker's color as another marker's semantic role.

A shared low-level OKLCH candidate generator is allowed; a shared one-size-fits-all visual policy is not. The per-role table controls candidate direction/strength, comparison target and acceptance. Palette derivation changes only the marker foreground ink; typography remains owned by its original binding, with the link rule independently clearing only delimiter underline. Do not copy font attributes from a separate color-source role. The current derived marker slots use the same Pi role for ink and typography; any future split must define and test that interaction explicitly.

### 4.2 Trustworthy color input

Use public Pi prefixes for literal inks and typography. Preserve terminal-default and authored-indexed inputs exactly; do not guess or regenerate them from RGB. A derived color requires a trustworthy concrete parent color. If the selected Pi role is symbolic or its authored/indexed provenance is unknown, do not invent an RGB base or borrow another semantic role merely to force distinction; retain its exact role color and document that this theme cannot support numeric derivation.

Public `theme.colors` provides concrete-versus-authored-indexed provenance, not an authoritative default or faint RGB. A `faint` SGR is a typography/display attribute, not a separate foreground ink; do not treat Pi's `Theme.colors` faint approximation as the color source or copy faint from an unrelated role. The current derived marker slots use the same semantic role for ink and original typography (`mdHeading`, `mdCode`, or `mdLink`), so a faint source is also a faint parent. Numeric derivation rejects it and retains the exact original binding, including faint. A role whose public ink is terminal-default or authored-indexed likewise stays exact-parent rather than becoming a guessed RGB. In 256 mode, proven concrete colors use the emitted index and Pi encoder's conventional palette model; this is not a query or claim about arbitrary terminal palette rewrites.

Panel/hint eligibility comes from actual public background output/provenance, not theme name, appearance, export metadata or guessed terminal colors. No new terminal queries or private Theme reads.

### 4.3 Role-specific derivation and visibility

The operator's Gruvbox screenshots rejected T1/T2's weak heading shades, not palette derivation itself. The T3 response then removed generation and substituted an existing punctuation ink; that no longer meets the goal and is superseded by A7. Derive new structural colors from the selected Pi theme, while keeping decisions local to each semantic role:

1. Start from that role's own trusted, emitted parent color. Generate a finite family of bounded candidates by moving OKLCH lightness; preserve the parent's hue and chroma as far as gamut allows. Reduce chroma only as needed for gamut/output validity. Do not introduce an unrelated hue or use a neighboring role as a substitute.
2. Choose direction from actual emitted parent, adjacent-content ink and card surface—not just the labels “dark” and “light”. The marker should separate from its sibling content while preserving its existing font attributes and the authored text color.
3. Give each role its own minimum useful separation. Small structural marks such as `#` need a materially stronger separation than punctuation intended to remain visually integrated with a string/code span. Do not reuse the rejected weak universal floor or let “any RGB change” pass.
4. Quantize every candidate through the real output encoder first. Test separation on final emitted foregrounds and contrast on every applicable final background. If a candidate collapses in 256 colors, continue to a stronger safe candidate rather than accepting the collapsed one.
5. Among candidates that meet that role's visual floor and surface-readability constraints, prefer the one that meets the role's calibrated target with the smallest unnecessary departure from its Pi source. Contrast against the background and separation from adjacent content are separate requirements; optimizing one cannot waive the other.
6. Calibrate each floor/target using whole source at the user's normal terminal font size, then retain numeric regression guards on final emitted values. Numeric distance is a guard, not proof of visibility. If no candidate survives, keep the exact parent and explicitly report that the selected palette has no safe distinct variant; never silently substitute punctuation, another marker color or a guessed default.

The shared candidate math may use the installed Pi TUI OKLCH/gamut/output routines; no dependency, setting, browser palette, terminal query or per-token/render-time math is needed. Normal-size visual comparison and actual terminal-cell checks are mandatory. Authored equality, monochrome, low contrast and quantization collapse are limitations to expose, not permission to recolor primary Pi text.

### 4.4 Final ink constraints and materialization

Prepare in an acyclic pass that cannot change primary theme colors to rescue optional variants:

1. Sample exact public colors/typography and select the structural panel.
2. Derive added/removed surfaces from the exact direct file-syntax inks and neutral `toolOutput`; freeze these surfaces before optional marker generation. Keep gutter/sign constraints. Do not include Bash neutral `toolTitle`: it does not paint file diff surfaces. Do not depend on visible contexts.
3. Generate bounded per-role candidates from trusted related Pi colors, quantize them to final output, and select only candidates that pass both their role-specific sibling-separation threshold and contrast checks on every frozen applicable surface. If none pass, retain the exact parent color and record fallback; do not refit a surface or change a direct ink to make a candidate pass.
4. Publish one immutable table of exact direct bindings, accepted derived bindings, typography and frozen card roles; compile styles outside render. No source-dependent transformation occurs later in the painter.

Known code inks require 4.5:1 or their authored lower emitted-panel contrast without regression; numbers retain 3:1 and signs 4.5:1 with the same non-regression policy. If no bounded emitted tint fits, retain the exact panel. Do not recolor foregrounds to rescue tints.

A default/authored-indexed/otherwise nonconcrete panel is preserved without invented tint. Each side hint also requires concrete public provenance; an unusable hint leaves only that side on the panel. Unknown/default/faint/authored-indexed final foregrounds preserve their literal binding and contribute no guessed numeric constraint; they do not globally erase otherwise eligible surfaces. Unknown appearance is unverified, not passed, and needs the corresponding physical/default/faint/indexed cases. No new palette framework or configuration is introduced.


### 4.5 Actual Markdown strikethrough — included scope

Operator decision (2026-10-21): include actual Markdown strikethrough in these changes. This supersedes the earlier recommendation to defer it. Inclusion originally changed planning scope; subsequent A5 authorizes implementation. Publication remains unauthorized.

- Extend the generic attribute model with `STRIKETHROUGH = 16`, making the complete mask 31 while preserving existing bit assignments and subset validation. Extend Rust's scorer to five attribute winners/seven property scores and TS/native boundary checks; avoid a paint-time scope matcher. Verify the existing `size_of::<Scored>()` workspace calculation covers the enlarged state; do not add an unrelated allowance.
- Add a declarative Follow Pi `markup.strikethrough` font override with value/mask `16/16`, without changing foreground/background. Separately scoped marker strike-clear is `0/16`. If the pinned grammar does not separate delimiters, follow its actual region coverage and record that limitation rather than inventing heuristics. Verify actual pinned grammar contexts, nested emphasis/links and separately scoped delimiters. Where the grammar exposes delimiters, clear only the strike bit on them; do not clear enclosing bold/italic/underline or invent token-text parsing.
- Emit real SGR 9 and reset with SGR 29 in the common ANSI compiler; full font reset becomes SGR `22;23;24;29` on span opening normalization and closing cleanup. SGR22 still clears only bold/faint, not strike. Cover explicit reset, adjacent ordinary text, line/wrap boundaries, clipped/reflowed rows and transition to native styles. Default/public-role/native full masks clear the new bit unless explicitly set. Native Syntect `FontStyle` does not support strike: keep its original styling, explicitly clear inherited strike and do not inject Follow Pi rules into native themes. Actual SGR9 appearance remains a terminal/font capability limitation, not permission to imitate strike with another color.
- Preserve incoming SGR 9/29 in the existing Pi ANSI-to-flat converter (`src/syntax/pi-flat.ts`), including SGR 0 and selective reset semantics. This preserves typography Pi actually returns; it does not add scope recovery/classification to fallback or promise Pi highlights Markdown strike on its own. Extend the bounded public-prefix sampler consistently.
- Keep envelope version 3/capability `syntax-highlight/v3`; advertise and require exactly `resolver_revision:2` in the existing strict descriptor gate on stdio/shared. Do not accept both resolver revisions or infer compatibility from unused bit16. Old/new helper-client mixtures fail candidate admission with zero STYLE dispatches. This explicitly revises the old advertised interpretation; it is not a silent mask widening.
- Keep `contexts_revision:1`, `palette_revision:1`, palette payload `revision:1` and client definition `revision:1`: source contexts, palette layout and rule framing remain unchanged. Document that resolver revision governs the shared expression attribute vocabulary, including palette-referenced styles. Change effective fingerprint domains to `occipital-client-rules/2`, `occipital-native-rules/2` and `occipital-native-palette/2` (each still NUL-terminated). Unchanged native theme-definition bytes keep their original definition fingerprints. No v4, dual-version runtime, grammar/source revision or dependency upgrade.
- Update protocol docs, cross-language vectors, raw numeric bounds/masks, native full-clear expectations, style/arena fingerprints and all affected fixture descriptors as one coherent implementation step. Published v2 artifacts remain immutable. A same-source helper rebuild is required locally; publication is a separate authorization.

## 5. Rule resolution and lifecycle

- Narrow declarations use trusted vocabulary names. Check every new selector against the generated vocabulary and pinned parse output before admitting the table; a single unknown name can reject the entire style definition.
- Full-context selectors handle cases such as `meta.mapping.key.json` plus `string`; mere earlier array order cannot override a deeper generic match. Test effective foreground and each font bit separately.
- No JavaScript scope matcher, per-source palette, or foreground manipulation in the painter. Bounded role-derived color math runs only during palette preparation, using the public theme and static semantic-role table.
- Changes to declarations/slot count change the existing rules fingerprint. First use can require missing STYLE work; palette-only dark/light/RGB changes keep declarations/fingerprint fixed and rebind locally.
- Preserve existing source/lease authority, 64 KiB classification, historical-prefix rules and no Pi classifier for Bash. Pi fallback remains its existing already-colored presentation with explicitly lower semantic granularity.
- Palette revision/output mode invalidate only materialization/paint as required. Retained sources and glyph geometry remain reusable. Publish bindings, all code regions and card/diff surfaces atomically.
- Keep weak ownership and existing DataBudget funding. Derive fixed input/scratch accounting from the finite role table, bounded candidate set and actual sampler temporaries; do not allocate an unbounded per-context color cache. An allocation failure follows current explicit preparation authority, not a hidden incomplete palette.
- Native profiles must not read Pi-specific bindings, change authored colors/enabled native typography, or pay Pi preparation costs. Their complete mask/reset representation explicitly clears the newly supported strike bit under the revised contract; this is not native strike emulation. Pi theme changes while a native theme is selected remain native-no-work controls.

## 6. Source seams and implementation steps

These are acceptance-gated steps within one final design, not temporary shipping fixes.

### P0 — Approve the complete architecture — completed

Operator approval A4 covers the complete plan after A1–A3 and Oracle review, including the explicit font-contract compatibility mechanism, coverage table, color/attribute policies and visual rubric. Separate implementation authorization was subsequently granted in A5. Execute P1 onward within this approved plan; update maintained runtime syntax/protocol specs to describe actual completed behavior, not future acceptance claims.

### P1 — Build independent parser/mapping regression fixtures

Add small source fixtures for Markdown, Bash, JSON, HTML and a representative language with parameters/constants/escapes. Record actual full contexts through pinned native parsing and verify source bytes/positions. Use real resolver output to prove both missing distinctions and preserved intentional equivalences. Include nested markup, embedded code, opening/closing markers and invalid/deprecated examples supported by those grammars.

Expected semantic roles come from the approved coverage table, not a snapshot of production declarations. Add negative controls that deliberately choose a broad/wrong binding or omit/clear strike incorrectly and must fail semantic assertions without serializing live objects.

### P1a — Extend the explicit five-bit font contract

Before consuming new typography, revise descriptor admission/interpretation, Rust/TS attributes and fingerprints/vectors, then common ANSI reset/emission, public-role masks and Pi flat conversion as specified in section 4.5. Native explicit style/palette masks must clear the new bit. Prove mismatched-peer rejection, fifth-bit precedence and set/clear inheritance on both transports. Rebuild the same-source helper and refresh fixture descriptors before dependent acceptance. This is a coherent contract change, not a compatibility shim or a release operation.

### P2 — Implement binding preparation and color policy

Primary seams: `src/syntax/pi-rules.ts`, `pi-bindings.ts`, `pi-input.ts`, `pi-variants.ts` (or its final bounded equivalent). Preserve exact direct-role colors and typography; prepare derived slots keyed by semantic role and account for bounded candidates/results. Add behavioral tests of per-role source/neighbor/strength policy, heading/list independence, identity spans, donor/parent faint, symbolic/indexed provenance and final surface constraints.

### P3 — Prepare fixed surfaces and run an early visual gate

Primary seams: `src/syntax/pi-palette.ts`, a bounded derived-color helper, `src/diff-palette.ts` and input preparation. Build and freeze surfaces from direct authored inks as in section 4.4; then check each emitted role-derived candidate against those surfaces. Before broad integration, compare unchanged baseline, the formerly weak T2 shades, same-parent colors and per-role candidates on dark/light/Gruvbox/tinted/neutral themes and diff backgrounds. Include the exact tiny heading example, independently colored headings/lists, quote/fence markers, repeated backticks and dense link/image/reference syntax. This is test-only, not a shipped mode. Stop on noise, insufficient marker separation, fragmented literals, harder-to-read glyphs or demoted semantic peers; tune each role's policy rather than recalibrating one universal generator.

### P4 — Implement the complete mapping inventory and integrate publications

Use the static declaration table and common Rust resolver. Complete the precise family/context rules from section 3; preserve deliberate equivalences/generic fallback. Verify full publication consistency and no invalidation cycle. No parser/grammar changes. New Rust integration tests may be needed even when shipping Rust code is unchanged.

### P5 — Perform final actual-CLI/replay visual acceptance

Execute the full section 7 matrix using actual CLI cells and saved-session replay after integration. Early pure-fixture beauty is not physical acceptance. Adjust only role-specific ink assignment inside the approved design; rerun invalidated checks. Failure to achieve harmony/readability is a failed gate, not permission to force hue shifts, drop scope or add settings. Report material contradictions and return for a decision.

### P6 — Run affected regression/integration acceptance and independent review

Execute section 8, fix verified defects inside scope and rerun invalidated checks. Independent review must freshly read current files, approved requirements and physical output/evidence. Record findings/disposition and required gaps. Document the final behavior and limits in `docs/syntax-highlighting-spec.md`; link this plan as design/history where appropriate, not as evidence of shipped behavior.

## 7. Visual acceptance gate

Use identical representative source and real Bash/edit/write cards. The operator-supplied Gruvbox screenshots from 2026-10-21 21:36 and 23:24 are required counterexamples: reproduce that same heading/source/theme and compare the rejected weak T2, same-parent and per-role-derived candidates. Inspect all at the user's normal terminal font size, not only enlarged swatches. Do not add a production mode or test flag.

Matrix: builtin dark/light, saturated/tinted custom palette, neutral/monochrome palette, low-contrast parent case, terminal-default/ANSI-only case; truecolor and 256-color. Cover regular/fullscreen, unified/split diff, ordinary panel, added/removed surfaces, narrow/wide source layout, retained live and saved-session replay. Reuse existing fixtures/emulator rather than introducing a browser/terminal automation framework.

Capture whole source excerpts, not isolated rainbow swatches only. Small swatches and numeric tables supplement actual text. Store final emitted foreground/background/font cells, semantic source role, derivation parameters, adjacent-text comparison, per-role separation/readability result, fallback reason and numeric limitations in local evidence. Source text, tools/results/model contexts and persisted session bytes remain exact; replay executes zero tools.

Visual rubric:

- Theme identity and primary accents remain recognizable; neutral themes gain no hue.
- Small heading markers have a useful visible separation from title text at normal size on reference themes. List markers use their own source and rules; never conflate headings and lists. Each derived marker comes from a semantically related Pi color, with stronger separation for tiny structural marks and restrained treatment for delimiters intended to remain integrated. Strings/code stay coherent; link/image/reference punctuation does not dominate.
- New distinctions help scan source; they do not create alternating color noise.
- Links/code nested in headings/quotes/stricken spans keep their own semantic colors and independent font attributes; actual strike is visible on intended source text and does not leak to delimiters, following text, gutters/service rows or native styles. No cumulative darkening or unwanted underline/bold/faint/strike leakage.
- Direct authored inks constrain diff backgrounds. Role-derived candidates must pass against frozen surfaces but may not force those surfaces to be refit. Reject policies that obscure tiny characters, fragment literals, demote semantic peers or add noise without improving scanning.
- Authored equality or quantization collapse is a limitation, not permission to invent unrelated colors or repair primary inks.

The operator's preferred strength of distinction is an **unknown known** to expose with these concrete comparisons, not a premature question about numeric coefficients. Human visual acceptance remains necessary after the implementation's numeric checks pass.

## 8. Validation scope and commands

Follow [testing.md](testing.md). Planning performs source/doc checks only; no product acceptance is claimed now.

Prepare Linux Node 22.19.0 / Pi 1.0.0 with a same-source v3 helper; use explicit Rust 1.99 inputs when compiling parser-test additions. A published v2 helper is not suitable. Supply the explicit prepared shared host if selecting the existing real shared suite. Keep installed-profile/archive/release checks out unless actual changed contracts require them.

Tight loop: refresh prepared sources, run affected `syntax`/`edit` node checks and focused native parser/resolver tests. Broader final local acceptance:

```sh
node scripts/test/prepare.mjs --refresh-inputs "$INPUTS"
npm run test:group -- --inputs "$INPUTS" --groups syntax,edit --layer node
npm run test:feature -- --inputs "$INPUTS" --features syntax,bash,edit,write --refresh --output "$RECEIPTS"
```

Use discovered file filters for focused new tests rather than registering an explicit file list. The feature command derives exact node/CLI membership and prerequisites from the catalogue; provision every selected requirement, including shared/profile inputs if those discovered tests require them. A focused new test does not authorize silently excluding existing affected feature tests. If Rust test/source inputs changed, refresh alone does not rebuild/requalify the helper: prepare the matching native tree first. Use the prepared Rust runner and `test:rust-check` for the now-required native attribute-contract changes. Add minimum/latest public-Pi compatibility checks for role sampling and flat ANSI typography. The included font-contract change additionally requires the complete affected codec/rules/resolver/native-palette vectors plus actual stdio/shared peer combinations, not only palette tests. Use discovered `tests/product/syntax/occipital-{semantic-codec,semantic-protocol,style-rules}.test.ts`, current native controller-style integrations and `tests/cli/shared/syntax/{node-v3-wire,semantic-rpc,pi-binding-isolation}.cli.test.mjs` as existing coverage seams; provision real shared inputs. No published-v2 consumer, registry/platform-release matrix or unrelated full CLI union can establish this new source contract and none is implicitly required.

Required observations:

1. Actual parser contexts and resolved roles for every inventory row; the complete selector table is validated against the pinned trusted vocabulary in tests. Unknown selectors reject before scope interning/style compilation, and that STYLE rejection causes no new SOURCE work; do not claim it prevents an earlier independent SOURCE job.
2. Exact direct Pi inks/fonts; no guesses for defaults, no double faint and no injected chroma for neutral parents. Explicit panel/hint provenance cases: default/authored-indexed panel means no derived tint; an unusable side hint leaves only that side on the panel. Faint/default/indexed foreground cases preserve exact ink and do not globally erase otherwise eligible tints.
3. For each derived role, assert its intended source binding, independent policy/threshold, exact-parent fallback reason and final emitted color. After gamut mapping and truecolor/256 encoding, verify both role-specific separation from its adjacent text and contrast on every frozen applicable surface. A distinct RGB value alone is never a pass; a quantized candidate that collapses must be rejected. Separate fully evaluated known pairs, partially evaluated surfaces with terminal-dependent foregrounds, and ineligible derivation. Unknown constraints are never counted as passes; their required physical visual cases are not optional skips.
4. Pi dark→light→dark and same-appearance palette changes with unchanged SOURCE and STYLE dispatch counts after retained contexts are ready. Positive cold controls prove counters are connected.
5. Warm frames: zero new sampling, SOURCE/STYLE, glyph measurement or body rebuild; width-only reflow preserves colors and adds no parse/style/measurement.
6. Native selected: no Follow Pi preparation, no native recoloring from Pi palette changes, no cross-card/cross-client binding contamination.
7. Theme preview/cancel, native↔Pi, provider unavailable/recovery, frozen Bash, actual equal-text completion, off/on/reload/replay and owner cleanup retain existing resource/publication behavior. Choose affected existing tests, not a new lifecycle harness.
8. Actual physical source colors/attributes across Bash/edit/write and saved-session replay, including long neutral/unclassified tails and Unicode/grapheme boundaries; strict tool/model/session comparisons.
9. Budget charge/release and active-owner GC remain correct with expanded finite inputs and five per-attribute winners. Update native resolver workspace accounting for the added winner/score; unchanged wire field widths do not justify ignoring actual workspace growth. No retained Theme/UI owner or per-context palette history.
10. Actual `~~text~~` source: fifth-bit set/clear, nested bold/italic/link/code contexts as emitted by the pinned grammar, ordinary text after the span, separately scoped delimiters, wraps/clips and native transitions. Assert actual terminal-cell strike state, not merely SGR byte presence; preserve full source/session/tool content. Flat fallback accepts SGR9/29/0 and selective resets correctly without parsing scopes. Matching new peers pass both transports; old/new revision mixtures fail admission; malformed/out-of-mask values and native full-clear violations reject consistently across Rust/TS. Native colors and their supported enabled font bits remain unchanged.

Local fallible/negative/CLI runs must use the verified systemd containment from testing.md: separate from compositor, aggregate 2 GiB RAM, swap0, memory.oom.group1; fail closed if unavailable. Assertions use primitive colors/counts/identity, never live terminal/process graphs. Preparation plus focused loop targets 2–3 minutes; required native/physical overruns are reported rather than covered by skips. No unrelated complete unit/CLI/release union is required by default.

## 9. Grill-for-unknowns ledger

| Kind | Finding | Resolution/owner |
| --- | --- | --- |
| Known known | Full scope contexts and generic binding slots already exist; theme-only rebinding need not parse | Reuse architecture; no protocol change for palette |
| Known known | Primary authored colors/default/indexed/faint behavior carry user intent | Preserve direct bindings; derive only with sufficient provenance |
| Known unknown (empirical, not architectural) | Which roles benefit from derivation and how strong each role must be | Compare complete source at normal size and physical cells; calibrate a role table, not a formula questionnaire or universal beauty claim |
| Unknown known | Operator may recognize an attractive/non-noisy result without specifying it numerically | Whole-source dark/light/neutral/diff comparisons, rubric in section 7 |
| Hidden issue found | `theme.colors` can contain guessed defaults and approximate faint | Public prefix/concrete-kind guards; no derivation from unknown backgrounds, partial numeric coverage for unknown foregrounds, exact ink preservation and required visual cases |
| Historical T1/T2 issue | Raw authored out-of-gamut OKLCH is not the displayed parent; 256 conversion can collapse candidates | Derive from canonical emitted Pi-role colors; compare after actual output quantization and reject collapsed candidates |
| Hidden issue found | Existing diff constraints omit Markdown semantic source inks | Actual evaluable direct semantic inks → frozen emitted surfaces; then role-derived variants are checked against them. No Bash-title constraint or cyclic foreground recoloring |
| Hidden issue found | Deeper generic scopes can defeat a more specific-looking ancestor rule | Actual full-stack resolver tests, not declaration-order assumptions |
| Hidden issue found | Unknown trusted names reject the entire client definition | Preflight complete selector table against actual generated vocabulary |
| Hidden issue found | A fixed binding cannot transform an arbitrary enclosing winner; typography can leak | Emphasis delimiters inherit through generic-punctuation exclusions; link punctuation clears only underline; actual-context/physical tests |
| Hidden issue found | Grammar invalid scopes are not compiler/tool failures | Foreground-only semantics; no status/diagnostic side effects |
| Hidden issue found → scope resolved | Current v3 interpretation has four bits; public Pi alone supporting strike is insufficient | Operator included actual strike. Explicit coordinated font-contract revision, SGR9/29/reset/fallback and cross-peer rejection; section 4.5 |
| Hidden issue found | Pi ANSI fallback cannot reproduce richer Occipital scopes | Retain documented fallback; no second parser/reverse color inference |
| Hidden issue found | Role-derived candidate search adds bounded temporary work and binding storage | Fund a finite per-role candidate set in existing preparation/DataBudget; retain GC/failure and no-warm-work tests |

The design does not promise that all Syntect grammars expose equivalent semantic detail. Missing evidence is handled by a named corpus gap or deliberate generic fallback, never token-text heuristics added to the UI. The T3 combined fixture records an existing gap: an indented ATX heading inside a list is not classified as a heading by the pinned parser. It remains neutral; recognized top-level headings and adjacent list markers are checked independently. T3 does not change that parser behavior.

## 10. Oracle review and disposition

Historical initial consultation (original foreground-generation mechanisms later calibrated by T1/T2 and misinterpreted as prohibited by T3; A7 now supersedes that interpretation): Oracle supported the original architecture but required F1–F6 below. Parent freshly verified the cited seams at the planning baseline; source inspection is not visual/product acceptance. The review also inspected installed Pi 1.3 while parent verified the project-installed 1.0 public implementation.

| Finding | Verified disposition |
| --- | --- |
| F1: optional shades displace structural diff cues; Bash title is not a file-diff ink | Accepted. Reverse dependency to direct inks → emitted fixed surfaces → optional variants; remove `toolTitle` from file-diff constraints. `diff-palette.ts:26–84`, `card-layout.ts:156–160,194–202`, `pi-palette.ts:8–14` confirm the mechanism/role mismatch. |
| F2: public provenance is sufficient, but raw out-of-gamut OKLCH is not the displayed origin | Accepted. Prefix-authoritative direct ink, public concrete-kind guard, canonical emitted origin. `pi-bindings.ts:17–49`; public `Theme.colors`; TUI `colorToOklch`, `colorToRgb` and output encoder verify the distinction. |
| F3: universal attenuation demotes semantic peers | Accepted. A single attenuation/distance policy must not demote distinct semantic peers. Original directional and T1 candidate grids are historical starting mechanisms, not current role policy. A7 requires separate source/neighbor/strength/fallback decisions for each structural role and retains exact primary colors. |
| F4: emphasis-family/special-variable rows hide unresolved behavior | Accepted. No dynamic enclosing-color transform or Cartesian rule product. Emphasis punctuation inherits via generic-rule exclusions; exact shell/underline policies are in the table. `resolver.rs:81–107,324–369` and `style-materialization.ts:20–28` verify fixed per-property winners. |
| F5: background quantization must also be checked | Accepted. Validate emitted direct foreground/background pairs before variants. No claim of 256 acceptance from RGB-only baseline checks. |
| F6: visual calibration is too late; STYLE rejection does not precede independent SOURCE | Accepted. Add early test-only whole-source visual gate, retain final physical/replay gate, correct rejection assertions. |

The historical Oracle review established provenance, fixed-surface ordering and bounded candidate-search constraints for the then-current proposal. Its approval did not validate T3's later removal of derivation or the current role table. A7 uses those mechanisms only where consistent with role-specific policies: derive from canonical emitted Pi colors, keep fixed surfaces based on direct inks, and reject unsafe/unknown candidates rather than inventing origins.

Written findings and consultation identities: [follow-pi-palette-review.md](follow-pi-palette-review.md). The six original findings and later font-contract review remain historical evidence for their respective constraints. They do not certify the current role-specific color policy; current implementation checks and evidence are recorded in `.test-artifacts/follow-pi-role-derived/verification.md`.

## 11. Operator decisions and approval state

**A1 resolved — actual strikethrough included.** On 2026-10-21 the operator explicitly included actual Markdown strikethrough in these changes. The earlier exclusion recommendation is superseded, not an optional follow-up. Section 4.5/P1a includes the required producer/consumer attribute contract, resets, fallback conversion and compatibility tests. Color-only imitation and a silent widened mask remain unacceptable.

**A2 historical boundary — selective palette expansion.** The operator originally chose related shades for heading, string, inline-code and link delimiters, with unrelated semantic peers intentionally sharing existing Pi roles. A7 below clarifies that the controlling goal is to derive missing structural-role colors from related Pi palette colors; it supersedes the assistant's later interpretation that broader role-derived color generation was prohibited. A distinct Syntect scope alone still does not require a new color.

**A3 approved — preserve original Pi colors.** The operator chose exact preservation of primary authored Pi colors inside Follow Pi cards, including low-contrast cases. Do not repair them locally to improve contrast or make a new shade fit. If a subordinate variant cannot pass its checks, retain the exact parent. Contrast checks constrain optional variants and derived backgrounds, not the author's direct foregrounds. This settles that design boundary, not implementation or blanket numeric readability.

**A4 approved — complete architecture, no implementation yet.** The operator explicitly approved the final plan as a whole after A1–A3: update existing Follow Pi without an extra mode/switch; retain Occipital scope matching, local color preparation and the common painter; include actual strike with the explicit resolver-revision2/matching-helper contract; use the recorded visual/physical/replay and independent-review gates. This is actual overall design approval, not an inference from approving scope or individual boundaries. The operator explicitly chose approval **without starting implementation**.

**A5 approved — implement the then-approved plan.** The operator explicitly requested implementation after A4. Runtime code, tests, same-source native builds, local acceptance and documentation updates were authorized within that design. Commits, pushes, tags, publication, Pi-core changes and unrelated research remain excluded.

**A6 superseded — assistant's T3 interpretation.** A6 correctly recorded the operator's demand for role-specific choices and independent heading/list policies, but incorrectly concluded that this required removing generated colors and borrowing punctuation ink for headings/links. The operator later rejected that result. A6's “no generated foreground shades” and borrowed-ink rules are not current policy.

**A7 clarified — source-derived colors for missing structural roles.** The operator restated the controlling goal: use only colors from the selected Pi theme as source colors, and derive related colors for structural elements that have no suitable dedicated theme color. Make the policy specific to each role. A tiny heading marker may require a strong derivative of its own heading text color; a list marker remains a separate list role and must never be replaced with a heading role; delimiters that should read as part of one string/code span may use a restrained derivative or intentionally remain identical. Never solve a visibility problem by substituting an unrelated existing role, changing the authored primary text color, or introducing colors from outside the selected Pi theme. The A7 planning turn corrected the contract but did not itself change runtime code. The operator later authorized implementation of this corrected plan under A8; current behavior and evidence are recorded in the maintained syntax contract and `.test-artifacts/follow-pi-role-derived/verification.md`.

**A8 implemented and reviewed — corrected plan and all affected documentation.** On 2026-10-21 the operator requested implementation after A7. Role-derived bindings, role-specific guards, regressions and the maintained contract are implemented. The Pi 1.0/Node 22 feature run passed types, 1,929 product tests and 59 CLI tests with no skips; a refreshed current-source native-integration run passed 2/2. Independent source review found no issues; visual review accepted the candidate with the recorded caveat that prominence over the previous cream markers and exact Foot rasterization are not established. Evidence and limits are in `.test-artifacts/follow-pi-role-derived/verification.md`. This does not authorize commits, pushes or publication.

No unresolved architecture question remained for implementation. Exact per-role mappings and numeric strengths were implementation/calibration details settled with source and visual evidence, not questions returned to the operator. The five-bit native contract in section 4.5 remains independently approved and unchanged.

## 12. Deviation and completion policy

Continue independently on local implementation details within an approved mechanism. Return to the operator if actual evidence requires a public/protocol change beyond section 4.5, adding dependencies/settings/terminal queries, modifying native authored styles or Pi core, dropping inventory rows, or changing the agreed fallback/primary-color policy. Do not conceal failed visual gates by lowering numeric coverage, adding arbitrary hues, or declaring a snapshot pretty.

Approval boundary: operator decisions A1–A8 and Oracle findings are recorded. A4 approves the then-current architecture, A5 authorizes that implementation, and A7 corrects the role-derived palette goal. A8 authorizes implementation and documentation of that corrected plan. Current local checks, review and any limits are itemized in `.test-artifacts/follow-pi-role-derived/verification.md`. Commits, pushes and publication remain unauthorized; no commit/push/release follows implicitly.
