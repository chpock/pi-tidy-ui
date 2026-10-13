# Rust library selection for a shared highlighting module

**Research date:** 2026-10-07. **Revision status:** expanded source analysis independently audited; two factual wording findings checked against primary sources and corrected. This is research, not production acceptance. No new performance tests or POC were run. Source/query inspection is not a claim that a terminal-quality corpus has passed.

**Companion:** [daemon communication and Subconscious recommendation](daemon-communication.md). [The earlier shared-service experiment](shared-service.md) measured a small raw Tree-sitter prototype, Giallo and Syntect/bat. It did **not** benchmark Arborium, Lumis, Syntastica or Syntaxmate, and its figures must not be transferred to them.

## Revision: what the initial explanation failed to establish

The previous recommendation over-weighted one concrete Rust-query difference and did not explain the trade-offs across all remaining ready collections adequately. Its API statement about Lumis was narrower than its README claim, but the distinction was not made explicit enough. Its blanket Giallo exclusion because of newline normalization was also too strong for a read-only classification service. These are corrections to the decision argument, not evidence that every former source observation was wrong.

The active shortlist is **Lumis, Arborium, Syntect with a ready bat-derived syntax pack, Giallo and Syntaxmate**. The operator excludes a self-assembled official Tree-sitter highlighter and Syntastica. Their engines may be inspected to understand a dependency, but they are not alternative selections.

### Lumis: what “Streaming-friendly — Handles incomplete code” actually means

The [README][L11] says exactly **“Streaming-friendly — Handles incomplete code.”** It does not promise a retained-document append API. There are four different properties:

| Property | Meaning | Evidence needed |
|---|---|---|
| Incomplete-code tolerance | Highlight the buffer available now even if a string, expression or block is unfinished | Error recovery, partial-source examples/tests |
| Streaming formatted output | Send an already supplied source's formatted output to a writer instead of returning one final string | Writer/iterator API |
| Reusing language preparation | Keep compiled grammars/queries and mutable parser allocation between calls | Store/highlighter ownership API |
| Incremental source highlighting | Apply an append/edit using retained document state, without processing the whole previous prefix again | Public document/tree/line-state API and implementation actually consuming that state |

Lumis supports incomplete source and public writer/formatter output; reusable preparation is real too. The inspected native highlighting path still takes **a complete source snapshot**, and parsing receives no previous document tree. No public `append`, `edit`, previous-tree or saved-line-state highlighting API is established. The README and that API finding therefore do **not** contradict one another. A sequence of incomplete snapshots is usable, but this is not a promise to process only newly arrived source. Streaming a formatter's output is not streaming its input. Section 5 and the source ledger give pinned paths/version limits.

This does **not** make Lumis unsuitable for a streaming UI: incremental CPU-work reuse is not provided by its ready library boundary. Whether snapshots meet the eventual latency target is unmeasured here. No debounce interval, timer or application workaround is selected.

### What following Zola issue 1787 changes

The complete [93-comment discussion][Z1] and [60-comment successor, issue 2758][Z2] provide engineering evidence, not a present-day five-library benchmark:

| Date / source | Observation | Correct interpretation for pi-tidy-ui |
|---|---|---|
| 2022, original issue | Zola could not update some Sublime grammars because Syntect lacked newer syntax-format features | Engine compatibility can freeze assets even while the asset repository is active |
| 2022, early Giallo | The first Giallo was a Tree-sitter experiment; mapping generic captures to VS Code's language-specific themes was difficult | Current Giallo is a different implementation; repository creation is not its TextMate engine's age |
| 2023, maintainer/contributor discussion | Expensive query initialization and startup were poor fits for a short-lived site builder | Historical initialization timings are not current Lumis/Arborium RSS or daemon per-client cost |
| 2024, HTML grammar report | Legal HTML with implicit element closing, including `<!doctype html><html><head>`, could generate broad error nodes | Not merely malformed-input evidence; current downstream fix status unverified. Recovery does not certify each grammar |
| 2025-12, successor | Arborium was proposed; participants disputed transferring older raw-Tree-sitter conclusions to the new collection | Do not dismiss Arborium from older experience or accept “real parser therefore faster/better” as proof |
| 2025-12 to 2026-01 | TextMate Giallo was integrated; Zola 0.22 shipped it | Concrete adoption and completed migration, not proof it fits our palette/state contract best |

Direct sources: [2023 startup explanation][Z3], [Arborium proposal/follow-up][Z4], [2025 final comparison][Z5], [HTML grammar issue 75][Z7]. The maintainer's 2025 comparison prioritizes binary size, startup, languages and easy custom JSON grammars: legitimate **Zola** priorities, not automatically ours. A long-lived module amortizes startup/loading; download size still matters, but is not multiplied by Node clients.

The successor explains difficult TextMate porting details: dynamic end patterns, captures, injection precedence, line anchors and Oniguruma dialect. The [regex maintainer's explanation][Z6] warns against substituting arbitrary regex engines. This makes Syntaxmate's compatibility contracts and Giallo's regex fork important; shared grammar names alone do not establish Shiki equivalence.

### Existing comparisons found, and their limits

- **Zola's two issues:** firsthand experience, bugs and decisions; no controlled five-library comparison. Generated-C source size, compiled binaries, compressed assets and resident memory must not be merged into one memory table.
- **Syntaxmate's [competitive packet][M5]:** equivalent-grammar engine track against `vscode-textmate`, and end-to-end HTML track against Shiki/Syntect. It separates cached replay from matching and rejects token counts as quality scores. Publisher-authored, revision/machine-specific, without Lumis/Arborium/Giallo. No numbers become our service measurements.
- **Existing [shared-service study](shared-service.md):** process-sharing evidence and a limited raw Tree-sitter/Giallo/Syntect setup; not a five-collection benchmark.
- **Sourcegraph's server-loop experience:** a contributor [reported in 2023][Z8] migrating major languages from Syntect to Tree-sitter for performance/large files, retaining Syntect for the long tail without caring about cold startup. Relevant attributed history, not a present-library benchmark. Its linked December-2021 Google Doc could not be read with the authorized fetch infrastructure; no figures are adopted.
- Targeted searches did **not establish an independent current equal-input comparison of all five**. Generated search-provider answers are source leads, not comparative studies.

## Recommendation and its basis

**Conditional primary: Lumis 0.17.0 for the Rust highlighting module.** It combines a ready native Tree-sitter language/query collection with source-preserving events/segments and, importantly for the original complaint, explicit ordinary-variable, member, function and type captures in the inspected priority-language queries. It avoids making pi-tidy-ui maintain a bespoke language registry and highlighting-query pack. **Use the correct public boundary:** ordinary `highlight_events` can conceal timeout/match-limit degradation, but the published `write_highlight_with_options` + custom `Formatter::render_budgeted` path reports both through `BudgetExhausted::{Time, Matches}`. A service formatter can serialize category events and this status, without HTML, hidden APIs or a library patch. Processed JavaScript locals definitions still do not match the runtime's exact special-capture lookup; no working local-binding propagation is credited. These qualifications must not be hidden by the recommendation.

**Arborium is the closest ready native Tree-sitter alternative.** Explicit shared `GrammarStore`, worker-local parsers and raw UTF-8 captures are excellent service features. Lumis's broader implemented locals/injection semantics and public work controls favor it here; one Rust catch-all alone does not prove a visible/global quality advantage. Arborium's raw captures are richer than its built-in flattened slots, so compare equivalent API layers.

**Syntect 5.3.0 + two-face 0.5.2+bat-0.26.1 is the conservative ready alternative:** mature terminal/diff adoption, delivered wide grammar pack and public saved line state. It is not obsolete or a self-assembly project. **Syntaxmate 0.2.1 is the other real line-state contender:** broad assets, raw scopes, reusable sessions and explicit work-limit status, but much less independent history. Neither is credited with universal identifier-coloring or current five-way benchmark superiority.

**The boundary is explicit:** Lumis is a preference for whole-source snapshots, not proof of the best append-processing choice. If avoiding repeated prefix processing is mandatory, this report instead favors Syntect + two-face as the mature line-state option and keeps Syntaxmate as its functionally strong but young challenger. Giallo's broad assets/actual Zola adoption remain credible for server-styled output; internal newline normalization is not a blanket exclusion.

No option is declared fastest, lowest-memory or visually correct for all its languages. The choice is an architectural/maintenance/quality-evidence recommendation, not a benchmark result or an excuse to weaken later source-preservation and UI acceptance criteria.

## 1. What is being selected

The library classifies **the supplied source** and returns syntax ranges/categories or styled source slices. The Rust process and Subconscious SDK handle requests separately. pi-tidy-ui keeps diff reconstruction/projection, old/new independence, line numbers, backgrounds, wrapping, layout and mouse behavior.

Priority evidence: TypeScript/TSX/JavaScript, Python, Rust and Bash command source; embedded HTML/CSS/JS and common configuration formats also matter. A language called `diff` usually classifies patch headers/signs; it does **not** imply language-aware coloring of changed TypeScript or Python lines.

Future growing Bash is a source-stream case. Arbitrary command stdout is not necessarily shell code, and none of these libraries can safely determine its language solely because it came from Bash.

Selection criteria: exact source/ranges, useful ordinary-name roles, maintained ready assets, embedded-language semantics, public structured output/host palette ownership, mature adoption, ready growing-text state, and manageable packaging/licensing/worker ownership.

**No operator-approved weighting is presumed.** Snapshot category classification and retained-prefix append processing have different leaders. Recommendation boundaries below say which requirement changes the result; maturity is not silently ranked below streaming, and parser popularity is not used as a total score.

## 2. Candidate overview

| Candidate | Parsing/highlighting model | Principal benefit | Principal reason not to select unchanged |
|---|---|---|---|
| **Lumis** | Native Tree-sitter plus curated Neovim-derived/overridden queries | Ready collection, detailed priority-language captures, original-source events and formatter APIs | Ordinary event API conceals degradation unless using public budget-aware formatter; JS locals issue; recent API and snapshot-only highlighter |
| **Arborium** | Native Tree-sitter collection and highlighter | Shareable grammar/configuration store, raw UTF-8 byte captures, injection handling | Ordinary Rust names lack a general variable rule; locals unused; reduced injection semantics and overlapping raw spans |
| **Syntect + two-face** | Sublime/TextMate-family scopes; ready bat-derived pack, Oniguruma or fancy-regex | Most established terminal ecosystem; public saved line state; real diff use | Plain-name quality depends on the pack; latest Sublime-format features on master are not necessarily in 5.3.0 |
| **Giallo** | TextMate grammars from Shiki's collection, native Oniguruma | Broad ready catalog, VS Code-family appearance, actual Zola use | Public theme-resolved text/styles rather than raw scopes; no public line-state continuation; normalized coordinates need original-source projection; EUPL-1.2 |
| **Syntaxmate** | TextMate, own Rust regex compatibility engine | Broad catalog, raw scopes, saved state/checkpoints, shared preparation and explicit degradation status, MIT | Young library history; EOF/line-API distinction and regex maintenance; publisher ledger is not universal source-quality proof |

### 2.1 Delivered language coverage

Counts below exclude additional alias strings, file-extension lists and theme counts. They count the specified package/catalog entries, **not independent language families**, and are not quality scores.

| Candidate / set | Count and method | Important boundary |
|---|---:|---|
| Arborium 2.18.2 | **112** `lang-*` members of published `all-languages` | Published `default = []`; README's “~70 by default” is stale. Includes helpers/variants such as jsdoc, regex, TSX and assembly flavors |
| Lumis 0.17.0 | **114** `lang-*` members of published `all-languages`; **115** rows in the inspected language catalog | Default enables all; feature and parser-identity counts differ. Includes embedded helpers, inline grammars and dialects, not 114 families |
| Giallo inspected source | **243** grammar bullets between README markers, excluding aliases after arrows | This is an enumerated source inventory, not a new inspection of the generated release dump; stale prose says “220+” |
| Syntaxmate inspected source | **264** public IDs in generated validation ledger | Includes Angular/embedded fragments. Publisher reports basic/stress oracle validation for all 264; tests were not rerun here |
| Syntect + bat 0.26.1 / ready two-face | **220** entries in the earlier native-Oniguruma [inventory](probes/shared-service/inventory.json) | Reused bat inventory, not new two-face dump enumeration. Fancy-regex omits unsupported syntaxes and is not credited with equal count; helpers are not independent families |

Both leading collections include the priority language families and ready injection infrastructure. Neither catalog alone proves that every embedding works. Lumis aliases `console`/`terminal`/`shell-session` to Bash; those aliases do **not** make arbitrary output valid shell-command source. Sources: [P1], [P2], [G1], [M1], [L5], [two-face backend boundaries][F1].

### 2.2 Maturity, update activity and popularity

Dated observations from GitHub/crates.io on 2026-10-07. Downloads are the registry's cumulative field, **not unique users**; publication/push cadence does not prove response times, reliability or ongoing grammar freshness.

| Project | GitHub repository created | Stars / forks | Published versions; current release/date | Registry downloads |
|---|---|---:|---|---:|
| Arborium | 2025-11 | 502 / 41 | 45; **2.18.2**, 2026-08-28 | 204,244 |
| Lumis | 2025-02; repository includes renamed Autumnus work | 230 / 18 | 24 under Lumis name; **0.17.0**, 2026-10-06 | 23,509 under new name |
| Syntect | 2016-05 | 2,442 / 181 | 49; **5.3.0**, 2025-09-27 | 31,045,572 |
| Giallo | 2022-08; creation alone is not continuous implementation history | 132 / 11 | 12; **0.5.2**, 2026-08-06 | 22,699 |
| Syntaxmate | 2026-08 | 3 / 0 | 6; **0.2.1**, 2026-09-30 | 806 |

Observed repository pushes: Lumis 2026-10-07, Arborium 2026-08-28, Syntect 2026-04-28, Giallo 2026-09-26, Syntaxmate 2026-09-30. A GitHub push timestamp can refer to any branch; no “dead project” conclusion is drawn from it. Syntect master visibly contains unreleased functionality, so a slower published release cadence is not zero maintenance. See the package/repository metadata ledger in section 9 and [Syntect's changelog][Y2].

**Maintenance concentration:** Arborium's observed first five contributor totals are 410 versus 4/3/1/1, a strong single-maintainer concentration signal. Lumis's larger contributor history includes imported/vendored work and bots; it does not establish five active maintainers of the native engine. No comparable active-core-maintainer count or maintenance SLA was verified. Treat both leading collections as smaller-project dependencies, not institutional-support guarantees. [R7]

**Lineage:** Autumnus 0.9 is deprecated and re-exports Lumis. Lumis's changelog records the rename/restructure, while its README credits Inkjet in early implementation. Inkjet's maintained successor chain is not three independent current candidates. Do not sum their download counts or histories as independent adoption. See [Lumis's changelog][L6] and the [earlier lineage study](shared-service.md#4-ready-native-tree-sitter-collections-source-verified-but-not-benchmarked).

### 2.3 Actual use and verification artifacts

| Candidate | Evidence of use | Evidence strength / test artifacts |
|---|---|---|
| Syntect | Bat manifest directly depends on 5.3.0; delta uses Syntect for terminal diff syntax | Strongest relevant terminal/diff adoption. Public line-state API and long-established compatibility work; pi-tidy-ui acceptance was not run |
| Arborium | Registry lists 26 reverse dependencies, including `miette-arborium` and related ecosystem wrappers | Real downstream availability, not 26 independent production teams. Source samples and wrapper tests exist; sponsors are not counted as adopters |
| Lumis | Registry lists Autumnus, `see-cat`, `tuicore`, `rs-rich-lumis`; native, CLI, Elixir and JS surfaces | Exclude deprecated Autumnus from independent adopters. Reconstruction/Unicode tests and multi-runtime conformance workflow exist; not proof of our terminal quality |
| Giallo | Zola's config manifest directly declares Giallo | Real consumer, not just author's intended migration. Shiki playground is upstream illustration, not Giallo execution |
| Syntaxmate | Registry includes `inkcairn`; extensive self-authored oracle/edge/concurrency tests | Not “no users.” Current ledger records all 264 IDs with basic/stress scope/class fixtures and no fixture allowlist; compatibility docs still explicitly deny universal Oniguruma equivalence |

Syntaxmate deserves **positive credit** for exposing degradation status, line state and reference-engine fixture contracts. Its very small/young independent adoption is the reason it stays a challenger, not a claim that its catalog is unsupported. No publisher speed/binary-size table is used as a native-daemon measurement. Sources: [bat][U1], [delta][U2], [Zola][U3], [Arborium dependents][U4], [Lumis dependents][U5], [Lumis workflow][L7], [Syntaxmate ledger][M1], [compatibility][M2] and [tokenizer tests][M3].

## 3. Quality: inspect the queries, not just the parser brand

A Tree-sitter grammar produces a syntax tree. A highlight query selects nodes and assigns roles. The palette turns those roles into colors. A parser recognizing an identifier is not proof that the query captures it or that the theme distinguishes it.

TextMate/Sublime grammars combine matching and scope assignment; they likewise can leave ordinary names unscoped. None of these is an LSP semantic-token service that resolves project-wide symbols/types.

### Priority-language source findings

| Source inspected | What is directly supported | What is not established |
|---|---|---|
| **Lumis Python** | General `(identifier) @variable`; definitions/calls/methods, attributes as properties, type positions and builtin-name rules | Cross-file type resolution; every partial-expression outcome; physical Pi colors |
| **Arborium Python** | General variable rule and corresponding function/property/type conventions | No broad Python-quality disadvantage versus Lumis is claimed from these rules |
| **Lumis Rust** | General variable rule, type and builtin-type nodes, members/shorthand members, parameters/closures, definition and `function.call` rules | Universal correctness of uppercase-name heuristics; every grammar/node case |
| **Arborium Rust** | Type, property, function/method/macro and parameter captures | No general ordinary-identifier variable rule in the inspected bundle; parser recognition alone does not fill that gap |
| **Lumis Bash** | Neovim-derived detailed keyword/operator/variable/function/parameter and heredoc rules | Correct visual continuation of every unfinished command without executing a corpus |
| **Arborium Bash** | Command names as functions, variable names as properties, strings/heredocs, operators and shell keywords | Neither exact role equivalence with Lumis nor all incomplete shell/embedding results were validated |
| **Lumis/Arborium TypeScript** | General identifiers plus function/type/member/parameter rules in their bundled query sources | TS type-checker semantics; every TSX/injection edge case |
| **Giallo/Syntaxmate TextMate family** | Broad ready scopes and embedded grammar references where supported | “Same as VS Code” including its semantic-token providers; fixing the previously observed Shiki Python grammar gap merely by changing language/runtime |
| **Syntect/bat** | Proven terminal scope/theme pipeline with a curated wide syntax pack | That ordinary locals/arguments in every language receive distinct syntax scopes |

These are useful category-coverage findings, not a measured color-density ranking. They do not by themselves establish global Lumis superiority: some Arborium roles already cover the motivating constructs, and palette choices can hide/expose differences. The broader recommendation rests on execution semantics, public controls and maintained collection boundaries too.

### Partial source and embedded languages

- Tree-sitter's error recovery is a good fit for unfinished source, but error nodes and missing context can still change captures. “Handles incomplete syntax” is not “colors it identically to the final complete program.”
- Tree-sitter injections require matching rules, a language resolver and a loaded injected grammar. Language count does not imply every embedded combination works.
- TextMate/Sublime engines keep multiline lexical state, but state from a missing opener cannot be reconstructed from a later fragment.
- Lumis's highlighter fork adds language-qualified events and adaptations for its query/runtime ecosystem. Arborium supplies its own highlighter/span and injection handling. Neither should be described as a zero-maintenance transparent alias of the official crate.

### Verified runtime limitations, not parser-family assumptions

Here **local tracking** means linking a reference to its declaration within the same parsed source—for example, not treating a user-declared variable with a built-in name as that built-in. It is not project-wide type checking or cross-file symbol resolution.

- **Arborium locals:** `GrammarConfig.locals_query` is explicitly unused; the executor compiles highlight/injection queries, not local binding rules. Do not credit shadowed-builtin/local-reference propagation merely because a locals file is shipped. [A2]
- **Arborium injections/spans:** raw captures may overlap; the injection executor does not apply all standard `include_children`/combined-content semantics. Our adapter would need correct composition, not just sorting by offset or assuming an already-disjoint token partition. Failed parsing can produce an empty default result, and no public cancellation/deadline/match-exhaustion control was found in this path. [executor][A2], [wrapper][A3], [types][A4]
- **Lumis JS locals:** processed definitions use names such as `local.definition.var`/`.parameter`/`.function`, while runtime special-capture lookup recognizes exact `local.definition`. The build path reads those processed queries unchanged. Unless another release transformation intervenes, definition tracking does not engage as expected. This is a source-supported compatibility concern, not a runtime reproduction or proof that all ordinary-name captures fail. [query generation][L2], [runtime lookup][L8], [processed definitions][L9]
- **No semantic promise:** dense syntactic variable/member/call captures remain useful even without local-reference propagation; neither collection resolves the project's types/symbols like a language server.

### Collection quality beyond one Rust identifier rule

The Tree-sitter bundles have different **parser provenance and execution semantics**, not merely counts:

| Priority source | Lumis at the inspected snapshot | Arborium at the inspected snapshot | Consequence, without a corpus claim |
|---|---|---|---|
| JS / JSX | Official JavaScript grammar 0.25.0 metadata and processed editor queries | Official JavaScript parser at another pin | Same upstream is not an identical selected revision/query |
| TS / TSX | Separate parsers from TypeScript 0.23.2; private/shorthand/member properties, constructors, generator/function/call roles | Separate TS/TSX definitions; ordinary variables, properties, definitions/calls, constants and built-ins | Both have useful categories; no blanket “Arborium is sparse” finding for TS |
| Python | `ericmj/tree-sitter-python` fork | Official `tree-sitter/tree-sitter-python` | Both capture ordinary variables; no general Python win inferred from Rust |
| Rust | Official Rust 0.24.2; ordinary variables and specific-role patterns | `tree-sitter-rust-orchard` fork; specific identifiers without general variable catch-all | Coverage difference, not tested modern-Rust correctness ranking |
| Bash | Pinned `ericmj/tree-sitter-bash` fork, 0.25.1 metadata | Official Bash at a separate pin, shell captures/injections | Aliases do not certify every dialect, heredoc or embedded command |

**Local-name handling:** Lumis implements local-definition/reference/scope machinery. Its known JS capture-name mismatch remains a limit; name heuristics are not compiler/type resolution. Arborium's `GrammarConfig.locals_query` is explicitly **“currently unused”** and not compiled by `CompiledGrammar::new`. Its TS rules nevertheless use `#is-not? local` for some built-ins. Shipping locals queries is not proof of native local-shadowing behavior. [Lumis engine][L12], [Arborium engine][A2]

**Embedded languages:** Lumis implements injection/local/highlight sections, combined injections and included ranges. Arborium recursively parses contiguous child slices; it records `injection.include-children` but recursion does not consume it, and combined disjoint regions are not grouped. Both contain HTML/CSS, Markdown, Vue/Svelte and config assets. Simple fences/script bodies are credible cases; universal complex-interpolation equivalence is unestablished. [Lumis engine][L12], [Arborium recursion][A3]

**Raw categories are not final color:** Arborium raw spans preserve nested/overlapping captures. Its built-in slot mapping collapses function/call/method distinctions, parameter/member/ordinary variables and string variants. Raw spans avoid that collapse, but overlap/category policy then belongs to the consumer. Its Dracula `variable` equals foreground: a missing variable capture can be visually invisible, whereas a pi-tidy-ui mapping could expose it. Palettes cannot invent missing categories. Flat tokens omit metadata entries for untagged gaps; ANSI output retains that plain text. Both convenience paths trim trailing LF characters. Raw spans plus retained original remain the category-service/source-preserving boundary. [Rendering implementation][A8] Lumis canonical events also filter/map captures; they are not compiler semantic tokens. [Arborium mapping][A6], [Lumis events][L13]

**Concrete source concern, not a failure count:** Arborium's Rust constant regex contains `^[A-Z][A-Z\\d_]+$'`, with a quote after the end anchor. This appears incapable of the intended all-caps match under ordinary regex semantics. A constructor rule also exists, so it is not proof every uppercase name is plain. It merits upstream checking, not a percentage-quality claim. [Rust query][A1]

All five need deliberate color mapping. Rich categories permit denser useful coloring, but editor themes may intentionally render ordinary identifiers as foreground. More ranges or every word colored is not itself correctness.

**Evidence asymmetry remains explicit:** priority-language Tree-sitter queries were inspected more deeply than every corresponding TextMate/Sublime scope rule. This report does not establish equal-input visual/category superiority for Lumis over the three TextMate-family candidates. Its snapshot preference is architectural/operational, not proof that it best colors all five priority languages. A definitive choice depends on the accepted snapshot/retained-state and maturity/palette priorities, not an invented total-quality score.

## 4. Source preservation, rendering and sharing

| Library | Structured output relevant to us | Sharing/ownership implication |
|---|---|---|
| **Lumis** | Original UTF-8 source events, highlight-start/end categories; styled `&str` segments and custom formatters | Static lazy configurations; mutable parser/highlighter belongs to a bounded worker. `Highlighter` uses `RefCell`, not one globally concurrent instance |
| **Arborium** | Raw `Span { start, end, capture }` byte captures, possibly overlapping including injections; not a disjoint full-source partition | `Arc<GrammarStore>` can share grammar/query configuration across highlighters; parser state remains worker-local |
| **Syntect** | `HighlightLines::highlight_line` yields `(Style, &str)` source slices; lower-level scopes/state are public | Share immutable syntax/theme sets; keep parse/highlight state per document/worker rather than locking all CPU work behind one highlighter |
| **Giallo** | `HighlightedCode.tokens: Vec<Vec<HighlightedText>>`, each token has `text` and resolved `style`; HTML optional, raw tokenizer `pub(crate)` | Initialized registry retains shared patterns. Output has no raw scope stack/original-byte range. Derive normalized logical-line positions from text lengths, then validate/project onto original; returned text is not authoritative source |
| **Syntaxmate** | Tokens/scopes, saved TextMate state and into-buffer APIs; ANSI/HTML optional | Document state is separate from reusable grammar assets. Own regex implementation/compatibility policy must be part of version acceptance |

**For Lumis, use category/source events rather than `Highlighter::new(language, None)` expecting role-colored segments.** With `None`, the high-level styled API returns empty/default styles: it does not magically apply Pi's palette. Consume category events and map them deliberately, or supply an explicit custom theme. Preserve fine categories until this mapping so methods, members and ordinary variables are not collapsed accidentally.

UTF-8 byte offsets are not JS UTF-16 indices, grapheme indices or terminal columns. Range conversion and ANSI foreground/background composition remain explicit client-boundary responsibilities. Preserve CRLF/CR, tabs, trailing newlines and Unicode in the original source; do not accept a normalization merely because it looks identical in HTML.

**Correction: Giallo's newline normalization is not by itself a sufficient exclusion.** The service classifies a retained original; it need not replace that original with Giallo's normalized text. Logical-line token lengths can be projected onto original line bodies while leaving their exact separators untouched, with strict partition/boundary validation. This is an offset/presentation adapter, not a claim that Giallo already returns original global byte spans; no adapter was implemented or tested. The old blanket rejection confused normalized analysis coordinates with an obligation to mutate model/session source.

The stronger architectural distinction is **theme-independent output**: current Giallo's public result exposes styles, not original scope categories. Its tokenizer and token types are private. It can serve styled fragments with server-selected themes, but cannot be credited with an unchanged public raw-category service API. Changing that boundary or the service's proposed theme ownership is a separate decision, not an invisible workaround. Sources: [published HighlightedText][G3], [exports][G4], [registry][G2].

### Use the public budget-aware path for Lumis

`highlight_events_with_options` converts a time-limit stop to `Ok([Source { 0..len }])` and ordinary wrappers discard the match-exhaustion flag. That means an event-only caller cannot distinguish budget-degraded source from genuinely plain source just by checking `Result::Ok`. [L1]

There is, however, a **documented published alternative**, not an implementation blocker or justification for private imports:

- `lumis::write_highlight_with_options` computes source/category events.
- The public `Formatter` trait receives original source/events in `render`; it receives the same plus `BudgetExhausted::Time` or `Matches` in `render_budgeted`.
- A service-oriented custom formatter can serialize these events and explicit status into the agreed RPC reply. It need not emit HTML/ANSI, alter text, install a theme or call the hidden `highlight_events_for_render` function itself.
- The trait's default `render_budgeted` discards the status, so override it deliberately. Existing convenience/string formatters are not authority for the service's status contract.
- Cancellation propagates as an error on this path. Lazy query compilation is excluded from the engine time budget, so it is not a complete cold-start or end-to-end request deadline. [L10]

This is the recommended API boundary for Lumis. It resolves the **budget-reporting** issue at the library's intended public extension point; it does not resolve the separate JS-locals concern or certify every capture as correct. Verified in source and in version-pinned `lumis 0.17.0` / `lumis-core 4.0.1` documentation. No formatter code/POC was written.

## 5. Growing source: parsing incrementality is not highlighting incrementality

| Library/API | Public continuation actually available | Required qualification |
|---|---|---|
| **Syntect** | `HighlightLines::state()` + `from_state()`, plus lower-level parse/highlight states | Reuse state at completed-line boundaries; roll back/reprocess an unfinished last line when it grows; middle edits require forward propagation |
| **Syntaxmate** | Saved line/grammar state and tokenization into reusable output | Public state is real; regex/grammar compatibility is a separate risk. Reprocess changed unfinished line and affected suffix |
| **Lumis** | Reusable highlighter/configurations; public functions consume a source snapshot | Inspected highlighter parses without a supplied previous edit tree; no public `edit/append + retained tree` document API is established |
| **Arborium** | Reusable store/highlighter; source snapshot to spans | Main native API parses with old tree `None`. Plugin sessions do call `tree.edit` and retain a tree, but that `publish = false` runtime is not the documented umbrella API or dirty-highlight-delta contract |
| **Giallo** | Internal multiline grammar state during one highlight | Not an equivalent public append-state API for independent growing requests |

Consequently, **Lumis is provisionally preferred for snapshot categories, work controls and maintained editor-derived queries, not because it exposes incremental document highlighting or an established overall quality lead.** If ready line-state continuation becomes a mandatory primary acceptance criterion, **Syntect is the stronger established candidate**, subject to its language-quality decision. Syntaxmate is a technically interesting challenger, not a maturity-equivalent replacement.

Incremental text handling also does not imply incremental UI rendering or native CPU cancellation. RPC streaming, request cancellation and cached complete replies each solve different problems. See the communication report for these boundaries.

### What retained line state does and does not buy

Syntect and Syntaxmate can keep a document's continuation state and process newly completed lines without tokenizing the stable prefix again. This is ready **line-granular** incremental support, not arbitrary-byte append magic:

- If the last line grows, restore the state **before that line**, reprocess it, then update downstream state. Otherwise an earlier partial identifier/string can keep stale classifications.
- An edit in the middle needs replay from a prior checkpoint until continuation converges; unchanged later output must not be reused before that convergence.
- Every independent document/version needs independent state; immutable grammar preparation is shareable, one mutable continuation is not.
- Language injections and incomplete strings can carry state across lines. A removed newline or artificial hunk join changes context even if the text looks locally similar.

**Syntaxmate has a specifically documented EOF boundary.** Its complete-source path and `tokenize_line` intentionally differ for some grammars when the final source line lacks a trailing newline: line tokenization appends a synthetic newline. The [explicit regression][M7] uses a lookahead for whitespace and asserts different scopes. This is a custom-grammar boundary, not proof that bundled ordinary Bash input is broken. It means source conservation alone is not a complete full-versus-incremental correctness check. Select one coherent line/finality convention rather than mixing the two APIs and declaring universal equivalence.

Published Syntect `ParseState` is cloneable and exposes byte-positioned `ScopeStackOp` events before theme rendering. Published rustdoc reports it as `!Send`/`!Sync` under that build; worker-local document state avoids assuming it can migrate freely between threads. Grammar sharing and document-state ownership are distinct. [Published 5.3.0 API][Y3]

## 6. Diff suitability

All five can classify a language source segment independently of HTML. None needs to own our diff renderer. Syntect's adoption in delta is concrete evidence of suitability for syntax inside terminal diffs, not just a theoretical API fit.

Correct use for pi-tidy-ui:

1. Reconstruct the available old and new source streams independently from saved metadata.
2. Highlight supplied contiguous context before projecting visible rows.
3. Do not join unrelated hunks across missing source and carry string/comment state across that artificial join.
4. Keep `+`/`-`, line numbers, borders and backgrounds out of language parsing.
5. Reuse syntax classification on width-only layout changes.
6. Do not reread the current file to invent historical content or alter model/session text.

A snapshot-based library remains suitable for finished diffs. Growing Bash benefits from a different state policy, but does not justify weakening diff context or original-source correctness.

### Syntaxmate deserves a full contender assessment, not “maybe later” by default

Its ready API matches the proposed service unusually well: theme-free scope stacks, UTF-8 character-boundary ranges, reusable prepared grammars, document sessions, saved/equatable continuation states, bounded matching and explicit `Degraded` completion status. The [0.2.0 changelog][M9] specifically records cheap `Send + Sync` highlighters, shared preparation, custom/subset catalogs and state convergence support. These are implemented API features, not an inference from the README.

The [264-ID ledger][M1] is also substantially stronger evidence than a language list: each ID has basic and stress source/golden pairs against pinned `vscode-textmate`/Oniguruma; scope stacks and coarse classes are checked. The ledger explicitly says its A/B/C groups are historical promotion groups, **not** quality grades. The compatibility document records an audited regex-difference ledger and expressly excludes universal Oniguruma/semantic-token equivalence. None of these upstream tests was run here, and two fixtures per language do not establish behavior on all user code.

Reasons for caution are concrete, not just a low star count:

1. The standalone API has had recent breaking 0.2 changes; its extracted engine predates the crate but that does not give it Syntect's independent integration history. [Extraction provenance][M10]
2. Recent 0.2.1 fixes affect dynamic delimiters, extended-mode whitespace, injection selectors and embedded-grammar closures — precisely the subtle cases a TextMate-compatible engine must get right. They demonstrate active maintenance and ongoing compatibility risk simultaneously. [Changelog][M9]
3. The final-line API boundary above needs an explicit client contract.
4. The strong compatibility/competitive corpus is publisher-authored; independently verified broad use and a neutral current comparison remain limited.

Thus Syntaxmate is a **serious functional candidate**, particularly when append processing and broad language coverage are both important. Its integration surface is not worse than Lumis's; its distinguishing risk is independent maturity and the regex-compatibility maintenance burden.

## 7. Integration and update ownership

- **Lumis:** select native language Cargo features; its default is the broad `all-languages` group. It packages vendored parser sources and processed queries, so consuming a release need not fetch mutable grammar repositories at runtime. A C/C++ toolchain is a build/deployment concern for the module, not a compiler needed by each Node agent. The inspected workspace requests Rust **1.95**. The dependency named `lumis-wasm-runtime` also contains the shared highlighter. Native `lumis` explicitly sets `default-features = false` for it; its standalone Wasmtime default is therefore **not inherited** by the selected native crate. [L4]
- **Arborium:** published **2.18.2 defaults to no languages** (`default = []`), despite its README claiming about 70 permissive defaults. Select native features, share the grammar store and keep parsers worker-local. Generated crates/parser forks are maintained by the project; missing generated files in a checkout do not prove a broken release. Relevant support templates request Rust **1.85**; no full MSRV build was performed. `all-languages` is a distribution/license choice, not universal quality.
- **Syntect + two-face:** a genuinely ready alternative, not a requirement to extract bat's private dump ourselves. Published **two-face 0.5.2+bat-0.26.1** bundles bat-derived syntaxes/themes and exposes `syntax::extra_newlines()` / `extra_no_newlines()` plus acknowledgement assets. It depends on **Syntect 5.3.0**, with selectable Oniguruma or `fancy-regex` assets; its declared MSRV is **1.79**. Use a matched newline convention and backend. Published crate metadata and the [official package/API][F1] establish this integration route. Neither backend is credited with equal speed or universal compatibility. Do not substitute arbitrary latest Sublime syntax packs into 5.3.0: newer engine inheritance/branch/replay/embedding work in master is unreleased. Updating the supported ready pack is simpler than becoming a grammar-collection maintainer, but its update cadence still depends on engine format compatibility.
- **Giallo:** load shipped `builtin.zst` with the `dump` feature, choose themes and consume text/styles (terminal renderer available, HTML optional). Retain that registry: `builtin()` comments claim repeat calls are no-ops, but implementation decodes/deserializes each time; pattern caching is not singleton loading. Oniguruma `onig-regset` supplies regex matching; prepared pattern sets are cached at registry level. No runtime grammar downloads or Node process are required by native consumers. Newline-coordinate projection, no public continuation/raw-scope API, theme ownership and EUPL licensing are separate concerns; normalization is not a blanket source-mutation disqualification.
- **Syntaxmate:** published **0.2.1** includes a compressed grammar bundle and license/provenance records; default features add themes, HTML and ANSI, which are not all required by a category service. MSRV **1.88**. Subset-bundle tooling follows embedded-grammar dependency closures. Public highlighters share prepared languages; document sessions retain tokenizers and explicit completion status. Avoiding native Oniguruma is a packaging property, not a demonstrated quality/speed win: its own TextMate-compatible regex VM needs continued compatibility maintenance.

### Licensing is a bundle decision, not just the wrapper's SPDX label

Core licenses: Lumis **MIT**; Arborium **MIT OR Apache-2.0**; Syntect **MIT**; Giallo **EUPL-1.2**; Syntaxmate **MIT**. The **two-face crate** is **MIT OR Apache-2.0**; its embedded assets have their own licenses and programmatic acknowledgement records. [Versioned legal section][F1] Grammar/query/theme licenses remain separate. These identifiers are not an automatic legal compatibility verdict.

**Concrete leading-collection difference:** Arborium 2.18.2's published `all-languages` includes `lang-nginx`, whose published `arborium-nginx 2.18.2` declares **GPL-3.0**. The pinned language definition agrees. Arborium's older `LICENSES.md` describes a separate `gpl-grammars` opt-in; that description does not match current published `all-languages` wiring. Lumis instead selects `tree-sitter-nginx 1.0.1`, whose published license is **MIT**. Do not transfer the Arborium parser's license to Lumis. [Published Arborium features](https://crates.io/api/v1/crates/arborium/2.18.2), [Arborium nginx package](https://crates.io/api/v1/crates/arborium-nginx/2.18.2), [Arborium definition](https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/langs/group-maple/nginx/def/arborium.yaml#L1-L3), [legacy license note](https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/LICENSES.md#L42-L48), [Lumis dependency](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/Cargo.toml#L338), [MIT package](https://crates.io/api/v1/crates/tree-sitter-nginx/1.0.1).

This is a real packaging/distribution consideration, not a blanket ban on GPL or an exhaustive declaration that Lumis's whole bundle is permissive. Choose the distribution policy and intended language feature set explicitly; communication over a socket is not a license exemption.

For any selection, pin a known engine/asset release and provenance, update as a tested unit and ship offline assets/notices. A package's MIT label does not automatically relicense all included third-party grammars, queries or themes. Subconscious packages the process; it does not certify the syntax bundle's licenses or compatibility.

### Updating and maintenance: mechanisms, not badges

| Candidate | Verified maintenance mechanism / evidence | Risk not settled by popularity |
|---|---|---|
| Lumis | Weekly grammar/default-query updates; pinned metadata, processed queries, compilation and Rust/JS predicate-portability CI | Workflow presence does not prove every update passes/merges; native-core continuity remains concentrated |
| Arborium | Pinned definitions/generated crates; outside grammar/portability contributions. Haskell fork PR 215 created 2026-08-27, merged 2026-08-28 | Open maintainer-tool drift and WASM symbol report do not prove native published use broken; no response SLA/succession guarantee |
| Syntect + two-face | Long-lived engine and separately maintained bat-derived pack; real terminal users | Asset freshness is constrained by supported Sublime format, not just release frequency |
| Giallo | Actual Zola use, cross-platform CI, Shiki-family assets and reference fixtures | Exact asset revision/compatibility needs pinning; current engine younger than repository |
| Syntaxmate | Source manifest, oracle ledger, bounded-output status, extraction provenance and concrete compatibility fixes | Independent adoption/long-term regex maintenance less established; publisher fixtures are not neutral acceptance |

Sources: [Lumis updates][L14], [query validation][L15], [Arborium PR 215](https://github.com/bearcove/arborium/pull/215), [PR 218](https://github.com/bearcove/arborium/pull/218), [PR 219](https://github.com/bearcove/arborium/pull/219), [Syntect changelog][Y2], [two-face][F3], [Giallo CI][G5], [Syntaxmate changelog][M9]. Bounded examples, not comparable issue-response statistics.

**Adoption beyond badges:** Hex.pm invokes Lumis with a 300 ms/4096-match budget and plaintext fallback. MDEx's Comrak adapter calls the native formatter over a complete fence source; it shares Lumis's author, so this is related adoption, not independent maintainer diversity. Rust terminal consumers termframe/reactive-tui call Lumis; reactive-tui owns the text/theme cache. Markdown streaming or a test named incremental does not establish an incremental syntax API. Dioxus code declares Arborium 2.16 with explicit features and supplied the portability report: stronger than parsing-only grammar downloads, not terminal scale proof. [Hex.pm][U6], [MDEx][U7], [termframe][U8], [reactive-tui][U9], [Dioxus][U10]

Zola's migration is Giallo's clearest real adoption; bat/delta are Syntect's direct terminal/diff consumers. Syntaxmate's Mark extraction is real continuity, not broad independent use. These examples establish source integrations, not installed versions, traffic or our output quality.

## 8. Decision boundaries

### Where each candidate genuinely leads

| Requirement | Evidence-based leader / shortlist | Trade-off that remains |
|---|---|---|
| Ready native snapshots with detailed categories, editor queries, combined embeddings and cooperative cancellation | **Lumis** | Snapshot reprocessing; young API/core maintenance; JS locals issue; use budget-reporting formatter |
| Most established terminal/diff ecosystem with delivered broad assets and public line continuation | **Syntect + two-face** | Released Sublime-format compatibility, selected-pack scopes and backend-specific language omissions |
| Broad TextMate catalog, raw scopes, shared preparation, sessions/checkpoints and explicit bounded-output status together | **Syntaxmate** | Very small independent use; young standalone API/regex VM; EOF convention boundary |
| Broad ready TextMate/VS Code-style output and proven site-generator migration | **Giallo** | Public styles not scopes; snapshot-only; normal source-coordinate conversion; distribution license |
| Explicit shared grammar store, custom grammar registration and raw native captures | **Arborium** | Native locals/injection limits, overlap resolution, snapshot API and selected-license closure |

There is no defensible universal winner without silently imposing weights. This table is the recommendation's basis, not an implementation split, dual-engine proposal or a roadmap to patch a library.

- **Provisional preference for a complete-snapshot native service: Lumis**, through the public budget-aware formatter. Reasons are ready source/category output, implemented locals/combined-injection machinery, cooperative work controls, editor-derived detailed queries, automated collection updates and verified publishing/terminal consumers — not one Rust capture. Its recent API/toolchain requirements and concentrated maintenance must be accepted before integration; no such acceptance is presumed.
- **Arborium instead:** if explicit shareable grammar storage/raw capture APIs dominate. Account for native locals/injection limits, flattening policy and bundle licenses; the Rust gap is not a visible defect under every theme. Unpublished plugin sessions are real prior art, not ready umbrella support.
- **Syntect + two-face:** strongest mature ready alternative when line-state continuation is mandatory. No need to assemble our own bat pack; Sublime format compatibility and chosen-language classification remain trade-offs.
- **Syntaxmate is a current functional contender**, not dismissed by stars or deferred by default: broad assets, raw scopes, public sessions and explicit work limits. Prefer it if these capabilities outweigh young independent API/compatibility history; its fixtures do not prove universal VS Code equivalence.
- **Giallo remains a serious styled-output candidate:** broad assets and real Zola use. Internal normalization alone does not exclude it. Its stronger mismatch is theme-resolved public output and no public continuation, when the module is to return theme-independent categories.
- **No ready incremental Tree-sitter winner is established** for ordinary native Lumis/Arborium. If retained append/edit processing is a hard gate, compare Syntect + two-face with Syntaxmate, not an invented retained-tree API.
- Raw official collection-building and Syntastica remain operator-excluded; no fallback to them is proposed.

Remaining implementation questions are separately authorized work: supported language/palette contract, source/range validation, bounded worker/doc state, interruption, actual packaging and real CLI/replay correctness. No performance testing or prototype is requested by this report.

## 9. Evidence provenance and sources

### Source snapshots and release boundaries

| Library repository | Freshly inspected commit | Published version observed |
|---|---|---|
| `bearcove/arborium` | `45fae8adc0d4e62a42d68eda0454f606b3fff6aa` | 2.18.2 |
| `leandrocp/lumis` | `d5f7620a50942e1b71d09a3e7f0890783ab3e56d` | 0.17.0; public formatter documentation also checked at lumis-core 4.0.1 |
| `trishume/syntect` | `4aa78031e93ebd3e0be7278120d0bd9d2508b1a3` | 5.3.0; master contains unreleased API changes |
| `getzola/giallo` | `148fec043603627a226115880efd79a73bb454cd` | 0.5.2 |
| `phongndo/syntaxmate` | `2e9d4959556c55b17c918edcc2d9a9eb91d16f02` | 0.2.1 |

A source manifest displaying the current release number does not prove that every HEAD line is in that release tarball. Arborium's trusted-publishing metadata identifies its inspected release commit; equivalent complete publication attestation was not established for every other source file. Public **Lumis budget hooks** were additionally checked in exact published-version documentation. Source findings are scoped to the named snapshots, not to every historical release.

### Grammar/query provenance and update assessment

Lumis's catalog separately records grammar and query sources: Rust grammar 0.24.2, TypeScript 0.23.2, a pinned Bash fork, and predominantly pinned Neovim query sources plus local/Helix overrides. Arborium's per-language definitions likewise pin parser repositories/revisions, including a Rust orchard fork; its generator copies the inspected query files into published generated crates. Thus the ordinary-Rust-variable difference is on a documented runtime-generation path, not a comparison of abandoned example files. [Lumis generation][L2], [Lumis catalog][L5], [Arborium Rust query][A1], [Arborium generator][A5]

Syntaxmate's source manifest pins Shiki `@shikijs/langs@4.4.3` and commit `48cd2cc695ed2e3357c3f9c370578ea843d6d9a3`, plus named supplemental sources/transformations. Giallo also derives from the Shiki grammar collection, but the exact built-dump revision was not reconstructed here. Syntect and bat maintain a different Sublime syntax ecosystem, delivered ready through two-face. [Syntaxmate source manifest][M4], [Giallo inventory][G1], [two-face][F1]

**A newer wrapper version or different grammar hash does not prove a fresher grammar.** No ancestry-based audit of every parser or exhaustive asset-license audit was performed. Prefer maintained pin/provenance machinery over render-time downloads, and assess updates at the chosen engine/asset release boundary.

### Primary implementation/API references

- **L1 — Lumis source/event and budget behavior:** [highlight.rs][L1], especially event wrappers, reporting helper and tests.
- **L2 — Lumis runtime query generation:** [build.rs][L2]; [language configurations](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/src/languages.rs).
- **L3 — Priority query sources:** [Rust](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/queries/processed/rust/highlights.scm), [Python](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/queries/processed/python/highlights.scm), [Bash](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/queries/processed/bash/highlights.scm), [TypeScript](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/queries/processed/typescript/highlights.scm).
- **L4 — Native packaging/defaults/toolchain:** [native manifest][L4], [workspace MSRV](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/Cargo.toml#L13-L19).
- **L5 — Language/provenance catalog:** [language reference][L5].
- **L6 — Rename/continuity:** [changelog][L6].
- **L7 — Verification artifacts:** [conformance workflow][L7]; reconstruction/Unicode tests in L1. Presence is not a claimed passing pi-tidy-ui run.
- **L8–L9 — JS locals mismatch:** [runtime capture lookup][L8] versus [processed locals query][L9].
- **L10 — Public budget-aware formatter:** [native call path][L10], [public trait source](https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis-core/src/formatter/mod.rs#L128-L204), [published Formatter 4.0.1](https://docs.rs/lumis-core/4.0.1/lumis_core/formatter/trait.Formatter.html), [published write_highlight_with_options 0.17.0](https://docs.rs/lumis/0.17.0/lumis/fn.write_highlight_with_options.html), [published BudgetExhausted](https://docs.rs/lumis-core/4.0.1/lumis_core/formatter/enum.BudgetExhausted.html).
- **A1 — Arborium priority query/provenance:** [Rust][A1], [Python](https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/langs/group-hazel/python/def/queries/highlights.scm), [Bash](https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/langs/group-hazel/bash/def/queries/highlights.scm), [Rust definition](https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/langs/group-birch/rust/def/arborium.yaml).
- **A2–A4 — Arborium store, executor and span contracts:** [executor][A2], [wrapper][A3], [span/injection types][A4].
- **A5 — Generated query path:** [generator][A5], especially copied query files for generated packages.
- **Y1–Y2 — Syntect public continuation/release limits:** [published HighlightLines 5.3.0][Y1], [source changelog][Y2].
- **M1–M4 — Syntaxmate scope/state/compatibility:** [catalog ledger][M1], [compatibility][M2], [tokenizer and tests][M3], [source/asset pins][M4].
- **G1–G2 — Giallo inventory and normalization:** [README][G1], [registry API source][G2]; [exports](https://github.com/getzola/giallo/blob/148fec043603627a226115880efd79a73bb454cd/src/lib.rs).

### Dated metadata/adoption references

P1–P7 below are official registry records, R1–R7 GitHub metadata and U1–U5 concrete manifests/dependency inventories. Dependency endpoints/push timestamps are moving observations, not reproducibility pins. Neither search summaries nor an automated source-check result marked `unclear` are used as semantic validation.

[P1]: https://crates.io/api/v1/crates/arborium
[P2]: https://crates.io/api/v1/crates/lumis
[P3]: https://crates.io/api/v1/crates/syntastica-parsers/0.6.1
[P4]: https://crates.io/api/v1/crates/syntect
[P5]: https://crates.io/api/v1/crates/giallo
[P6]: https://crates.io/api/v1/crates/syntaxmate
[P7]: https://crates.io/api/v1/crates/tree-sitter-highlight
[R1]: https://api.github.com/repos/bearcove/arborium
[R2]: https://api.github.com/repos/leandrocp/lumis
[R3]: https://api.github.com/repos/RubixDev/syntastica
[R4]: https://api.github.com/repos/trishume/syntect
[R5]: https://api.github.com/repos/getzola/giallo
[R6]: https://api.github.com/repos/phongndo/syntaxmate
[R7]: https://api.github.com/repos/bearcove/arborium/contributors?per_page=5
[U1]: https://raw.githubusercontent.com/sharkdp/bat/master/Cargo.toml
[U2]: https://raw.githubusercontent.com/dandavison/delta/main/Cargo.toml
[U3]: https://raw.githubusercontent.com/getzola/zola/master/components/config/Cargo.toml
[U4]: https://crates.io/api/v1/crates/arborium/reverse_dependencies?page=1&per_page=100
[U5]: https://crates.io/api/v1/crates/lumis/reverse_dependencies?page=1&per_page=100
[L1]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/src/highlight.rs
[L2]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/build.rs
[L4]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/Cargo.toml#L286-L298
[L5]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/docs/content/reference/languages.md
[L6]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/CHANGELOG.md#L443-L471
[L7]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/.github/workflows/conformance.yml
[L8]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis-wasm-runtime/src/tree_sitter_highlight.rs#L1238-L1268
[L9]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/queries/processed/javascript/locals.scm
[L10]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis/src/lib.rs#L488-L537
[A1]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/langs/group-birch/rust/def/queries/highlights.scm
[A2]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium-highlight/src/tree_sitter.rs
[A3]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium/src/highlighter.rs
[A4]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium-highlight/src/types.rs
[A5]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/xtask/src/generate.rs
[Y1]: https://docs.rs/syntect/5.3.0/syntect/easy/struct.HighlightLines.html
[Y2]: https://github.com/trishume/syntect/blob/4aa78031e93ebd3e0be7278120d0bd9d2508b1a3/CHANGELOG.md
[M1]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/docs/language-status.md
[M2]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/docs/compatibility.md
[M3]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/src/tokenizer.rs
[M4]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/assets/grammars/SOURCE.toml
[G1]: https://github.com/getzola/giallo/blob/148fec043603627a226115880efd79a73bb454cd/README.md
[G2]: https://github.com/getzola/giallo/blob/148fec043603627a226115880efd79a73bb454cd/src/registry.rs
[S1]: https://github.com/RubixDev/syntastica/blob/d9ac0663b4b8f102c3938deff787aa45e0583db1/README.md
[S2]: https://github.com/RubixDev/syntastica/blob/d9ac0663b4b8f102c3938deff787aa45e0583db1/src/processor.rs

Metadata ledger: [Arborium package][P1], [Lumis package][P2], [Syntastica package](https://crates.io/api/v1/crates/syntastica), [Syntect package][P4], [Giallo package][P5], [Syntaxmate package][P6], [official highlight package][P7]; repositories [Arborium][R1], [Lumis][R2], [Syntastica][R3], [Syntect][R4], [Giallo][R5], [Syntaxmate][R6]; consumer manifests [bat][U1], [delta][U2], [Zola][U3]; downstream inventories [Arborium][U4], [Lumis][U5], [Syntastica](https://crates.io/api/v1/crates/syntastica/reverse_dependencies?page=1&per_page=100), [Syntaxmate](https://crates.io/api/v1/crates/syntaxmate/reverse_dependencies?page=1&per_page=100).

## 10. Original-selection audit (before the expanded revision)

A fresh-context auditor read the completed report and authoritative sources on 2026-10-07. It supported the conditional Lumis recommendation, ordinary-Rust-query distinction, published public budget-reporting formatter, locals qualifications, state/source boundaries, native dependency defaults and the audited coverage/adoption subset. It explicitly did **not** recount every secondary catalog/popularity value or execute a pi-tidy-ui corpus.

| Written finding | Parent verification and disposition |
|---|---|
| “Repository history begins” was not established by GitHub creation metadata | Renamed the column to **GitHub repository created**; no implementation-history age is inferred from it |
| Generic asset-license warning omitted current Arborium nginx GPL exposure | Independently re-read pinned definition and legacy license note, current feature metadata and both published nginx packages; added the specific GPL-3.0 versus MIT distinction in section 7 |
| Communication report contained literal escaped newlines | Fixed there and checked Markdown links/anchors/prose; does not change library selection |
| Public Lumis budget reporting might be confused with hidden event helper | Auditor independently confirmed exact published `Formatter` and `write_highlight_with_options`; retained the public formatter boundary, not a private API workaround |

Original audit verdict: **corrections required**, with both recommendations supported and no decision-critical positive contradiction. The bounded corrections above were source-verified and applied by the parent. No second independent runtime or post-correction review is claimed. Unexecuted visual/incremental/deployment/performance/license-exhaustiveness gates remain unexecuted, not “passed.”


### Expanded-revision source references

[L11]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/README.md#features
[Z1]: https://github.com/getzola/zola/issues/1787
[Z2]: https://github.com/getzola/zola/issues/2758
[Z3]: https://github.com/getzola/zola/issues/1787#issuecomment-1756215887
[Z4]: https://github.com/getzola/zola/issues/2758#issuecomment-3650687613
[Z5]: https://github.com/getzola/zola/issues/2758#issuecomment-3650910074
[Z6]: https://github.com/getzola/zola/issues/2758#issuecomment-2838877583
[M5]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/benchmarks/competitors/README.md
[M6]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/src/highlighter.rs#L135-L418
[M7]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/tests/tokenize_eol_parity.rs#L103-L126
[M8]: https://docs.rs/syntaxmate/0.2.1/syntaxmate/struct.Tokenizer.html
[M9]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/CHANGELOG.md
[M10]: https://github.com/phongndo/syntaxmate/blob/2e9d4959556c55b17c918edcc2d9a9eb91d16f02/EXTRACTION.md
[G3]: https://docs.rs/giallo/0.5.2/giallo/struct.HighlightedText.html
[G4]: https://github.com/getzola/giallo/blob/148fec043603627a226115880efd79a73bb454cd/src/lib.rs#L23-L44
[F1]: https://docs.rs/two-face/0.5.2+bat-0.26.1/two_face/
[F2]: https://crates.io/api/v1/crates/two-face/0.5.2+bat-0.26.1
[F3]: https://codeberg.org/CosmicHarper/two-face
[Y3]: https://docs.rs/syntect/5.3.0/syntect/parsing/struct.ParseState.html

[L12]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis-wasm-runtime/src/tree_sitter_highlight.rs
[L13]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/crates/lumis-core/src/events.rs
[L14]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/.github/workflows/upgrade-langs.yml
[L15]: https://github.com/leandrocp/lumis/blob/d5f7620a50942e1b71d09a3e7f0890783ab3e56d/.github/workflows/queries.yml
[A6]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium-theme/src/highlights.rs
[A7]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium-plugin-runtime/src/lib.rs#L188-L304
[G5]: https://github.com/getzola/giallo/blob/148fec043603627a226115880efd79a73bb454cd/.github/workflows/ci.yml
[U6]: https://github.com/hexpm/hexpm/blob/main/lib/hexpm_web/syntax_highlight.ex
[U7]: https://github.com/leandrocp/mdex_native/blob/main/native/mdex_native_nif/src/lumis_adapter.rs
[U8]: https://github.com/pamburus/termframe/blob/HEAD/src/syntax.rs
[U9]: https://github.com/eas4ai/reactive-tui/blob/main/src/syntax/highlighter.rs
[U10]: https://github.com/DioxusLabs/dioxus-code/blob/main/Cargo.toml

[Z7]: https://github.com/tree-sitter/tree-sitter-html/issues/75
[Z8]: https://github.com/getzola/zola/issues/1787#issuecomment-1752101147

## 11. Expanded revision and audit boundary

This revision independently re-examined all five remaining candidates, followed the full 93-comment Zola issue and 60-comment successor, and inspected native/publication boundaries. It corrects the incomplete-code/incrementality conflation, Giallo's overbroad CRLF exclusion, Arborium's stale default-feature claim, source-versus-paint inference, a weak one-capture recommendation, and treating Syntaxmate as a token future option. Historical comparisons and inaccessible-source limits remain attributed explicitly.

Fresh-context auditor `b4877d5a-4db2-4993-bb46-c0250fc11969` read the complete 484-line revision after READY and checked central claims against actual source/publication records. Its verdict was **corrections required**, limited to C1/C2 below; it found no other decision-critical contradiction and supported the conditional boundaries, not a universal quality winner. The parent freshly checked the cited implementation/legal passages and incorporated both corrections. This is source-backed closure of the findings, not a claim that the auditor performed a second pass or runtime acceptance.

| Finding in reviewed revision | Primary verification | Closure |
|---|---|---|
| C1, line 185: conflated flat-token gaps with ANSI text loss | `arborium-highlight/src/render.rs` 236–288 omits untagged token entries; 982–1017 explicitly emits plain ANSI text; both paths trim LF | Separate those output contracts. No untagged-text-loss allegation remains. [A8] |
| C2, line 290: called the two-face package label an asset-wide license | Versioned two-face legal documentation states independent embedded-asset licenses/acknowledgements | Label MIT/Apache as the crate license, not every embedded asset. [F1] |
| Bounded evidence gap: no equal-input five-way priority-language color comparison or approved total weighting | Auditor independently confirmed this limitation | Explicitly retain architectural preference and requirement-dependent alternatives; no blanket quality/performance claim |

The earlier audit in section 10 is not substituted for this fresh revision review. No production changes, benchmarks, POC, service launches, dependency changes, staging or commit were made.

[A8]: https://github.com/bearcove/arborium/blob/45fae8adc0d4e62a42d68eda0454f606b3fff6aa/crates/arborium-highlight/src/render.rs
