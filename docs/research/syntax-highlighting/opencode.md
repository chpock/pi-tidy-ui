# OpenCode and OpenTUI

Research snapshot: 2026-10-06. Source inspection, not a rendered OpenCode screenshot or a full grammar test.

## Versions actually inspected

- OpenCode dev: [`772392050500e0ddcd2ad2193411a22a3824372f`](https://github.com/anomalyco/opencode/commit/772392050500e0ddcd2ad2193411a22a3824372f). Its [catalog](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/package.json) still selects **OpenTUI 0.4.5**.
- Selected OpenTUI 0.4.5: [`0c8c4f7cff2927e3df63a9757a45eff9a343611c`](https://github.com/anomalyco/opentui/commit/0c8c4f7cff2927e3df63a9757a45eff9a343611c).
- OpenTUI main, separately: [`de8dc97080e4c404d9018d9e6a485036aeaef7d2`](https://github.com/anomalyco/opentui/commit/de8dc97080e4c404d9018d9e6a485036aeaef7d2), package **0.5.14**.

Do not describe latest OpenTUI behavior as the version currently selected by OpenCode. The older local reference in pi-tidy-ui's specification was not treated as current evidence.

## Why its diff can have richer syntax coloring

OpenCode's [Edit presenter](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/packages/tui/src/routes/session/index.tsx#L2390-L2441) supplies a saved patch, filename-derived `filetype` and `syntaxStyle` to `<diff>`.

OpenTUI then:

1. Parses patch structure with the `diff` package.
2. Builds source streams in `DiffRenderable` and feeds `CodeRenderable`.
3. Uses **web-tree-sitter**, WASM grammars and `highlights.scm` queries to obtain named source ranges. The inspected OpenTUI manifest pins web-tree-sitter **0.25.10**.
4. Applies injection queries for configured embedded languages.
5. Maps captures such as `variable`, `function.method`, `type`, `property`, `keyword`, `string` to theme styles.
6. Independently paints change backgrounds/gutters/signs.

A syntax-tree query can explicitly capture every identifier as a variable and override call/type/property positions. Pi's current highlight.js grammar frequently emits no such spans. The Python [local control](experiments.md#portable-tree-sitter-python-control) demonstrates this distinction without adopting OpenTUI itself.

This is **syntactic** classification, not an LSP semantic-token service. OpenCode shows LSP diagnostics separately. The worker compiles highlights/injections; `locals` URLs present in some configuration descriptors are not themselves proof of a locals-resolution pass.

Primary implementation references:

- [Selected-version unified source construction](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L483-L585)
- [Selected-version split construction](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderables/Diff.ts#L587-L922)
- [Current worker query creation](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter/parser.worker.ts#L164-L202)
- [Current one-shot parse/capture/tree disposal](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter/parser.worker.ts#L820-L879)

## Theme and overlapping captures

OpenCode's [syntax rules](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/packages/tui/src/theme/index.ts#L623-L791) classify comments, strings, keywords, variables, functions, constructors and types separately. `function.call` may use variable color; some builtin categories use the theme's error color as a palette choice, not a diagnostic.

OpenTUI's [chunk converter](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter-styled-text.ts#L141-L203) merges overlapping styles by dotted-scope specificity, then capture order; a missing dotted style falls back to its base scope. This rule was independently reread in the actual pinned source. Captures are not automatically disjoint tokens: flattening raw query output without precedence rules can miscolor method names or embedded source.

The API returns native styled chunks, not portable terminal ANSI strings. Keep token foreground mapping separate from diff backgrounds. A pi-tidy-ui adaptation should use Pi's active theme without mutating the host/global theme or importing OpenTUI's native style object.

## Language breadth: configured assets, not an all-language runtime bundle

Current OpenTUI's [defaults](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter/default-parsers.ts#L19-L65) contain JavaScript, TypeScript, Markdown, Markdown-inline and Zig. OpenCode adds descriptors for dozens of other languages in [parsers-config.ts](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/packages/tui/src/parsers-config.ts): Python, Rust, Go, C/C++/C#, Bash, Java, Kotlin, Ruby, PHP, Scala, HTML, Vue, HCL, JSON, YAML, Haskell, CSS, Julia, Lua, OCaml, Clojure, Swift, TOML, Nix, diff, Elixir, F#, R, Make, Vim, XML and Agda.

That inventory is **configuration presence**, not a successful compilation/quality guarantee. Comments document query incompatibilities, inheritance needs and disabled HTML injections. A maintained grammar/query distribution matters as much as parser choice.

### Bash qualification

OpenCode has a `bash` descriptor with tree-sitter-bash v0.25.0 and a nvim-treesitter highlights query ([configuration](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/packages/tui/src/parsers-config.ts#L71-L79)). However its [filename helper](https://github.com/anomalyco/opencode/blob/772392050500e0ddcd2ad2193411a22a3824372f/packages/tui/src/util/filetype.ts#L92-L130) emits `shellscript` for common shell extensions, while that descriptor has no alias. Worker canonicalization uses registered names/aliases. This is a source-level mismatch requiring runtime confirmation, **not** a proven statement that every OpenCode shell diff fails. The full registration/override path and actual Bash rendering were not executed here.

Do not copy the mismatch: a shared pi-tidy-ui service should explicitly normalize `bash`/`sh`/`shellscript` where supported and use an explicit shell language for Bash command arguments. Also test the selected query's predicates; nvim queries can contain `#lua-match?`, which not every generic web-tree-sitter query consumer implements.

## Incomplete source is still incomplete

The inspected selected and current Diff implementations build synthetic streams from supplied hunks:

- Unified can concatenate context, removed and added lines into **one** parser input.
- Split separates sides, with alignment blanks.
- Both concatenate disjoint hunks and lack complete historical before/after source.

Tree-sitter tolerates incomplete syntax, but cannot recover a missing opening/closing comment, template or heredoc. Copying OpenCode blindly would inherit this limitation and can even mix old/new lexical state in unified mode. pi-tidy-ui should retain its stronger old/new separation and distinguish noncontiguous source segments before context projection.

## Runtime, ownership and performance

OpenTUI's [client](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter/client.ts#L261-L422) initializes asynchronously, starts a parser worker and deduplicates initialization. Grammar/query assets have a disk cache; loaded parsers/languages/queries are cached in memory. Its one-shot highlight path parses complete supplied streams and deletes trees; incremental buffer APIs elsewhere are not evidence of incremental diff highlighting.

Remote query URLs can be mutable, and [disk cache keys](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/src/lib/tree-sitter/download-utils.ts#L24-L85) need not pin fetched content. Pinning the application commit is insufficient for reproducible coloring if runtime assets float.

Current Code has stale-result snapshots and a serialized rerun loop; selected 0.4.5 differs. No measured OpenCode throughput/startup/memory advantage is claimed. Worker execution improves main-thread isolation, not necessarily total CPU time.

## Why not import OpenTUI as the solution

Current `@opentui/core@0.5.14` declares **Node >=26.4.0** and Bun >=1.3.0; npm registry verification agrees with its [manifest](https://github.com/anomalyco/opentui/blob/de8dc97080e4c404d9018d9e6a485036aeaef7d2/packages/core/package.json). pi-tidy-ui supports Node >=22.19.0. The selected older version's Node native adapter also attempts `node:ffi`; absence of an npm engines declaration is not compatibility proof.

`SyntaxStyle.create()` crosses native FFI. Taking the whole Diff/Solid/native rendering stack adds another terminal renderer and unrelated ownership/layout machinery. It is not an appropriate dependency solely for syntax tokenization.

**Useful transfer:** parser + pinned grammar/query + capture/theme model. **Not useful transfer:** native renderer, FFI style objects, mutable asset downloads or their synthetic unified source construction.

## Licensing

OpenCode/OpenTUI/Tree-sitter root licenses are MIT. Individual grammars and independently sourced queries need separate notices: the inspected [nvim-treesitter license](https://github.com/nvim-treesitter/nvim-treesitter/blob/cf12346a3414fa1b06af75c79faebe7f76df080a/LICENSE) is Apache-2.0. A grammar's MIT license does not make every alternative query MIT. No exhaustive transitive asset-license audit was performed.

## Decision relevance

Tree-sitter is the closest architectural match to the desired OpenCode-style **syntax coverage**, with stronger direct evidence for ordinary Python names than the Shiki generic theme control. Use a standalone portable runtime and curated pinned assets, not OpenTUI itself. A complete capture-to-span adapter, grammar/injection matrix, minimum-Node compatibility and real UI performance remain implementation gates.
